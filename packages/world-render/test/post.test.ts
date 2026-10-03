/**
 * The post stack (docs/WAVE_PLAN3.md §6.13, D17, D18, D30, D31; docs/RENDER.md §5): preset → pipeline list and order,
 * Low builds nothing and leaves the scene untouched, the prepass is dropped below 17 inter-stage variables (TAA →
 * MSAA ×4), FSR1 only where the scene can render small, every PBR preset applies image processing in post (D18), the
 * tone map switches live, the exposure never touches the scene's image-processing configuration (that would dirty
 * every material), and weather never changes what is attached (SSR is gated by uniforms).
 */
import { ArcRotateCamera, Color4, ImageProcessingConfiguration, InternalTexture, InternalTextureSource, NullEngine, PBRMaterial, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BLOOM_LOOKS, RENDER_PRESETS, WorldRender, withBloom, type GpuInfo, type RenderPreset, type RenderQuality } from '../src/index.ts'
import { FOG_PLUGIN_NAME } from '../src/pbr/fog-plugin.ts'
import {
  EXPOSURE_TRIM,
  PREPASS_CLEAR_NORMAL_Z,
  PREPASS_FAR_DEPTH,
  clearPrepassForSsao,
  seedSsaoCamera,
  MIN_PREPASS_VARYINGS,
  POST_STAGE_ORDER,
  RenderPost,
  SSR_GATED_THRESHOLD,
  SSR_SETTINGS,
  LEGACY_BLOOM_THRESHOLD,
  bloomCutoff,
  installRenderPost,
  planPost,
  toneMappingType,
} from '../src/render/post.ts'
import { CLEAR_RENDER_WEATHER } from '../src/render/weather.ts'
import type { SkyState } from '../src/sky/types.ts'

const GPU: GpuInfo = { maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16, features: [], vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false }
const GPU16: GpuInfo = { ...GPU, maxInterStageShaderVariables: 16 }
const PRESETS: readonly RenderPreset[] = ['low', 'medium', 'high', 'ultra']

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

/** NullEngine has no 3D textures (the LUT): a CPU-side stand-in. */
function with3dTextures(engine: NullEngine): void {
  const e = engine as unknown as Record<string, unknown>
  e['createRawTexture3D'] = (_data: unknown, w: number, h: number, d: number, format: number, _mips: boolean, invertY: boolean, _s: number, _c: unknown, type: number) => {
    const t = new InternalTexture(engine, InternalTextureSource.Raw3D)
    t.baseWidth = t.width = w
    t.baseHeight = t.height = h
    t.baseDepth = t.depth = d
    t.format = format
    t.type = type
    t.invertY = invertY
    t.is3D = true
    t.isReady = true
    return t
  }
  e['updateRawTexture3D'] = () => {}
}

function setup(mode: 'classic' | 'pbr', preset: RenderPreset, gpu = GPU) {
  const engine = new NullEngine()
  with3dTextures(engine)
  // A real WebGPU / WebGL2 device renders to half float: the HDR pipeline (NullEngine reports no support).
  engine.getCaps().textureHalfFloatRender = true
  const scene = new Scene(engine)
  const camera = new ArcRotateCamera('cam', 0, 1, 14, Vector3.Zero(), scene)
  scene.activeCamera = camera
  const render = new WorldRender(scene, { mode, quality: RENDER_PRESETS[preset], gpu })
  cleanups.push(() => {
    render.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { engine, scene, camera, render }
}

function sky(o: Partial<SkyState> = {}): SkyState {
  return {
    t: 0.5, day: 0, phase: 0.5, sunDir: new Vector3(0.3, 0.8, 0.2).normalize(), moonDir: new Vector3(0, -1, 0), sunElevationDeg: 55,
    moon: { age: 0, illum: 0, texture: 1 }, keyLight: { dir: new Vector3(0.3, 0.8, 0.2).normalize(), color: [1, 0.95, 0.9], intensity: 1 },
    ambient: { sky: [0.4, 0.5, 0.7], horizon: [0.5, 0.5, 0.5], ground: [0.2, 0.2, 0.2] }, sh: null, fogColor: [0.6, 0.7, 0.8],
    horizonRing: null, exposure: 8, night: 0, twilight: 0, cloudCover: 0.1, cloudShadow: null, cloudNoise: null, env: {} as never, ...o,
  } as unknown as SkyState
}

const names = (cam: { _postProcesses: Array<{ name: string } | null> }) => cam._postProcesses.filter(p => p !== null).map(p => p!.name)

describe('planPost: preset → pipeline list, in order', () => {
  it('Low (the Classic path) builds nothing; a Classic world on any preset builds nothing', () => {
    expect(planPost('classic', RENDER_PRESETS.low, GPU).stages).toEqual([])
    expect(planPost('pbr', RENDER_PRESETS.low, GPU).stages).toEqual([])
    for (const p of PRESETS) expect(planPost('classic', RENDER_PRESETS[p], GPU).stages).toEqual([])
  })

  it('matches the §5.1 rows per preset', () => {
    const med = planPost('pbr', RENDER_PRESETS.medium, GPU)
    expect(med.stages).toEqual(['shafts', 'default'])
    expect(med.shafts).toMatchObject({ level: 'low', mode: 'hybrid', ratio: 0.25 })
    expect([med.fxaa, med.msaa, med.sharpen, med.bloom, med.toneMap, med.lutGrade, med.prepass]).toEqual([true, 1, false, 0, 'neutral', true, false])
    const high = planPost('pbr', RENDER_PRESETS.high, GPU)
    expect(high.stages).toEqual(['ssao', 'taa', 'shafts', 'default']) // §6.20 cut 4: no SSR on High
    expect(high.shafts).toMatchObject({ level: 'high', mode: 'march', ratio: 0.5 })
    expect(high.ssao).toEqual({ ratio: 0.5, samples: 8 })
    expect([high.ssr, high.aa, high.sharpen, high.fxaa, high.msaa]).toEqual(['off', 'taa', true, false, 1])
    const ultra = planPost('pbr', RENDER_PRESETS.ultra, GPU)
    expect(ultra.stages).toEqual(['ssao', 'ssr', 'taa', 'shafts', 'default'])
    expect(ultra.ssao).toEqual({ ratio: 1, samples: 16 })
    expect(ultra.ssr).toBe('always')
  })

  it('keeps the fixed order for every combination of features', () => {
    const bools = [false, true]
    for (const ssao of bools) for (const ssr of bools) for (const taa of bools) for (const vls of bools) for (const small of bools) {
      const q: RenderQuality = {
        ...RENDER_PRESETS.ultra, ssao: ssao ? { halfRes: true, samples: 8 } : null, ssr: ssr ? 'always' : 'off',
        aa: taa ? 'taa' : 'fxaa', lightShafts: vls ? 'high' : 'off', renderScale: small ? 0.75 : 1,
      }
      const s = planPost('pbr', q, GPU).stages
      expect(s).toEqual(POST_STAGE_ORDER.filter(x => s.includes(x)))
      expect(s).toContain('default')
    }
  })

  it(`drops the prepass below ${MIN_PREPASS_VARYINGS} inter-stage variables: no SSAO/SSR, reprojected TAA → MSAA ×4`, () => {
    for (const p of ['high', 'ultra'] as const) {
      const plan = planPost('pbr', RENDER_PRESETS[p], GPU16, { taaReprojection: true })
      expect(plan.stages).toEqual(['shafts', 'default'])
      expect([plan.prepass, plan.aa, plan.msaa, plan.sharpen, plan.taaReprojection]).toEqual([false, 'msaa', 4, false, false])
      expect(plan.dropped.length).toBe(p === 'ultra' ? 3 : 2) // High has no SSR to drop (§6.20 cut 4)
      // Projection-jitter TAA (the default) needs no prepass and stays.
      const plain = planPost('pbr', RENDER_PRESETS[p], GPU16)
      expect(plain.stages).toEqual(['taa', 'shafts', 'default'])
      expect([plain.prepass, plain.aa, plain.taaReprojection]).toEqual([false, 'taa', false])
    }
    expect(planPost('pbr', RENDER_PRESETS.medium, GPU16).stages).toEqual(['shafts', 'default'])
  })

  it('TAA reprojection (D30) is opt-in and then counts as a prepass stage', () => {
    expect(planPost('pbr', RENDER_PRESETS.high, GPU).taaReprojection).toBe(false)
    const r = planPost('pbr', { ...RENDER_PRESETS.high, ssao: null, ssr: 'off' }, GPU, { taaReprojection: true })
    expect([r.taaReprojection, r.prepass]).toEqual([true, true])
    expect(planPost('pbr', { ...RENDER_PRESETS.high, ssao: null, ssr: 'off' }, GPU).prepass).toBe(false)
  })

  it('uses FSR1 first for render scale < 1, only without prepass stages', () => {
    const med = planPost('pbr', RENDER_PRESETS.medium, GPU, { renderScale: 0.75 })
    expect(med.stages).toEqual(['fsr', 'shafts', 'default'])
    expect(med.fsrScale).toBeCloseTo(1 / 0.75, 9)
    const high = planPost('pbr', RENDER_PRESETS.high, GPU, { renderScale: 0.75 })
    expect(high.stages).not.toContain('fsr')
    expect(planPost('pbr', { ...RENDER_PRESETS.high, ssao: null, ssr: 'off' }, GPU, { renderScale: 0.75 }).stages).toEqual(['fsr', 'taa', 'shafts', 'default'])
    expect(high.dropped.some(d => d.startsWith('fsr'))).toBe(true)
    expect(planPost('pbr', RENDER_PRESETS.medium, GPU, { renderScale: 1 }).stages).toEqual(['shafts', 'default'])
  })

  it('tone map: KHR PBR Neutral by default, ACES as "filmic"', () => {
    expect(planPost('pbr', RENDER_PRESETS.high, GPU, { toneMap: 'filmic' }).toneMap).toBe('filmic')
    expect(toneMappingType('neutral')).toBe(ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL)
    expect(toneMappingType('filmic')).toBe(ImageProcessingConfiguration.TONEMAPPING_ACES)
  })
})

describe('RenderPost on a scene (NullEngine)', () => {
  it('Low builds nothing and leaves the scene image processing, the camera and the materials untouched', () => {
    const { scene, camera, render } = setup('classic', 'low')
    const ip = scene.imageProcessingConfiguration
    const before = { apply: ip.applyByPostProcess, tm: ip.toneMappingEnabled, exp: ip.exposure, con: ip.contrast, lut: ip.colorGradingEnabled }
    const post = installRenderPost(render)
    render.attachCamera(camera)
    render.update(camera, sky())
    expect(render.post).toBe(post)
    expect(post.stages).toEqual([])
    expect(post.pipeline).toBeNull()
    expect(post.grade).toBeNull()
    expect(names(camera as never)).toEqual([])
    expect(post.fog.active).toBe(false)
    expect({ apply: ip.applyByPostProcess, tm: ip.toneMappingEnabled, exp: ip.exposure, con: ip.contrast, lut: ip.colorGradingEnabled }).toEqual(before)
    const m = new PBRMaterial('character', scene)
    expect(m.pluginManager?.getPlugin(FOG_PLUGIN_NAME) ?? null).toBeNull()
    expect(m.fogEnabled).toBe(true)
  })

  it('every PBR preset applies image processing in post (D18) and turns the height fog on', () => {
    for (const p of ['medium', 'high', 'ultra'] as const) {
      const { scene, camera, render } = setup('pbr', p)
      const post = installRenderPost(render)
      render.attachCamera(camera)
      expect(scene.imageProcessingConfiguration.applyByPostProcess, p).toBe(true)
      expect(post.fog.active, p).toBe(true)
      expect(post.stages, p).toContain('default')
      const m = new PBRMaterial('m', scene)
      expect(m.pluginManager?.getPlugin(FOG_PLUGIN_NAME), p).toBeTruthy()
      expect(m.fogEnabled, p).toBe(false)
    }
  })

  it('builds the Medium stack on the camera and tears it down when the preset drops to Low', () => {
    const { scene, camera, render } = setup('pbr', 'medium')
    const post = installRenderPost(render)
    render.attachCamera(camera)
    expect(post.stages).toEqual(['shafts', 'default'])
    const dp = post.pipeline!
    expect(dp.fxaaEnabled).toBe(true)
    expect(dp.bloomEnabled).toBe(false)
    expect(dp.imageProcessing.imageProcessingConfiguration).toBe(post.imageProcessing)
    expect(post.imageProcessing.toneMappingEnabled).toBe(true)
    expect(post.imageProcessing.toneMappingType).toBe(ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL)
    expect(post.imageProcessing.colorGradingTexture).toBe(post.grade!.texture)
    expect(names(camera as never).length).toBeGreaterThan(0)

    render.setMode('classic')
    render.setQuality(RENDER_PRESETS.low)
    expect(post.stages).toEqual([])
    expect(names(camera as never)).toEqual([])
    expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(false)
    expect(post.fog.active).toBe(false)
  })

  it('switches the tone map live (no rebuild) and drives exposure without touching the scene configuration', () => {
    const { scene, camera, render } = setup('pbr', 'medium')
    render.setQuality(withBloom(RENDER_PRESETS.medium, 'strong'))
    const post = installRenderPost(render)
    render.attachCamera(camera)
    const dp = post.pipeline
    const sceneIp = scene.imageProcessingConfiguration
    const sceneUpdates = vi.fn()
    sceneIp.onUpdateParameters.add(sceneUpdates)
    post.setToneMap('filmic')
    expect(post.pipeline).toBe(dp)
    expect(post.imageProcessing.toneMappingType).toBe(ImageProcessingConfiguration.TONEMAPPING_ACES)
    post.setToneMap(null)
    expect(post.imageProcessing.toneMappingType).toBe(ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL)
    // W9 LOOK: the default render-side trim (EXPOSURE_TRIM 1.4, noon within ±10 % of Classic at the plaza).
    expect(post.exposureTrim).toBe(EXPOSURE_TRIM)
    post.exposureTrim = 1
    render.update(camera, sky({ exposure: 8 }))
    expect(post.imageProcessing.exposure).toBe(8)
    expect(dp!.bloomThreshold).toBeCloseTo(0.9 / 8, 9)
    post.exposureTrim = 0.5
    render.update(camera, sky({ exposure: 8 }))
    expect(post.imageProcessing.exposure).toBe(4)
    expect(sceneUpdates).not.toHaveBeenCalled()
    expect(sceneIp.exposure).toBe(1)
  })

  it('blends the grade from the sky and the weather, and re-uploads only on a real change', () => {
    const { camera, render } = setup('pbr', 'medium')
    const post = installRenderPost(render)
    render.attachCamera(camera)
    render.update(camera, sky())
    const g = post.grade!
    const n = g.uploads
    render.update(camera, sky())
    expect(g.uploads).toBe(n)
    render.setWeather({ ...CLEAR_RENDER_WEATHER, cloud: 1, rain: 1 })
    render.update(camera, sky())
    expect(g.uploads).toBe(n + 1)
  })

  it('weather gates SSR on High through uniforms only (nothing is attached or detached)', () => {
    const { camera, render } = setup('pbr', 'high')
    const post = installRenderPost(render)
    render.attachCamera(camera)
    const ssr = (post as unknown as { built: { ssr: { reflectivityThreshold: number; strength: number } | null } }).built.ssr
    if (!ssr) return // SSR unsupported on this engine: planPost covers the list.
    const attached = names(camera as never)
    expect(post.ssrActive).toBe(false)
    expect(ssr.reflectivityThreshold).toBe(SSR_GATED_THRESHOLD)
    render.setWeather({ ...CLEAR_RENDER_WEATHER, puddles: 0.2 })
    render.update(camera, sky())
    expect(post.ssrActive).toBe(true)
    expect(ssr.reflectivityThreshold).toBe(SSR_SETTINGS.reflectivityThreshold)
    render.setWeather({ ...CLEAR_RENDER_WEATHER, puddles: 0.09 })
    render.update(camera, sky())
    expect(post.ssrActive).toBe(true)
    render.setWeather({ ...CLEAR_RENDER_WEATHER, puddles: 0.05 })
    render.update(camera, sky())
    expect(post.ssrActive).toBe(false)
    expect(names(camera as never)).toEqual(attached)
  })

  it('rebuilds on a new camera and cleans up on dispose', () => {
    const { scene, camera, render } = setup('pbr', 'medium')
    const post = installRenderPost(render)
    render.attachCamera(camera)
    const other = new ArcRotateCamera('cam2', 0, 1, 10, Vector3.Zero(), scene)
    render.attachCamera(other)
    expect(names(camera as never)).toEqual([])
    expect(names(other as never).length).toBeGreaterThan(0)
    post.dispose()
    expect(render.post).toBeNull()
    expect(names(other as never)).toEqual([])
    expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(false)
    expect(post).toBeInstanceOf(RenderPost)
  })
})

describe('SSAO (off from gate 1, back on since W9 LOOK)', () => {
  it('is on where the preset asks (High half res, 8 samples), off when asked, and says why', () => {
    const { render } = setup('pbr', 'high')
    const post = installRenderPost(render)
    expect(post.plan.ssao).toEqual({ ratio: 0.5, samples: 8 })
    expect(post.plan.stages).toContain('ssao')
    const off = installRenderPost(render, { ssao: false })
    expect(off.plan.ssao).toBeNull()
    expect(off.plan.dropped.some(d => d.startsWith('ssao'))).toBe(true)
  })

  it('clears the prepass so pixels no prepass material wrote (sky, grass, Classic water) read far, with a valid normal', () => {
    // Before: depth 0 and normal (0, 0, 0): SSAO2 drew the sky, the grass and the water black (WebGPU, High).
    // The NullEngine has no prepass: Babylon 9.28's PrePassRenderer fields, as the fix sets them.
    const p = { useSpecificClearForDepthTexture: false, _clearDepthColor: new Color4(0, 0, 0, 1), _clearColor: new Color4(0, 0, 0, 0) }
    clearPrepassForSsao({ prePassRenderer: p } as unknown as Scene)
    expect(p.useSpecificClearForDepthTexture).toBe(true)
    expect(p._clearDepthColor.r).toBe(PREPASS_FAR_DEPTH)
    expect([p._clearColor.r, p._clearColor.g, p._clearColor.b, p._clearColor.a]).toEqual([0, 0, PREPASS_CLEAR_NORMAL_Z, 0])
    // Under SSR's reflectivity threshold even before the RGBA8 target rounds it to 0.
    expect(PREPASS_CLEAR_NORMAL_Z).toBeLessThan(SSR_SETTINGS.reflectivityThreshold)
  })

  it('I-10R: the SSAO pass has its camera from the build, not only from the original-colour pass (WebGPU frozen frame)', () => {
    // Before: a fresh page on Low switched to High drew the SSAO pass while the original-colour pass was still compiling:
    // no camera, so the bind returned before `randomSampler` and WebGPU's createBindGroup threw in the render loop.
    const camera = { name: 'cam' } as never
    const fake = (cam: unknown) => ({ _thinSSAORenderingPipeline: { _ssaoPostProcess: { camera: cam } } })
    const fresh = fake(null)
    seedSsaoCamera(fresh as never, camera)
    expect(fresh._thinSSAORenderingPipeline._ssaoPostProcess.camera).toBe(camera)
    const other = { name: 'other' }
    const set = fake(other)
    seedSsaoCamera(set as never, camera)
    expect(set._thinSSAORenderingPipeline._ssaoPostProcess.camera).toBe(other) // Babylon's own camera is kept
    expect(() => seedSsaoCamera({} as never, camera)).not.toThrow() // a Babylon without the field: nothing to do
    // The real High build on the NullEngine: the thin pass has the world camera at once.
    const { render, camera: cam } = setup('pbr', 'high')
    const post = installRenderPost(render)
    const ssao = (post as unknown as { built: { ssao: unknown } | null }).built?.ssao as { _thinSSAORenderingPipeline?: { _ssaoPostProcess?: { camera: unknown } } } | null
    if (ssao?._thinSSAORenderingPipeline) expect(ssao._thinSSAORenderingPipeline._ssaoPostProcess?.camera).toBe(cam)
  })
})

describe('wave 12 defaults: the sun shafts replace the gate-2 VLS', () => {
  it('are on where the preset asks for them; RenderPostOptions.lightShafts false drops them and says why', () => {
    const { render } = setup('pbr', 'ultra')
    const post = installRenderPost(render)
    expect(post.plan.shafts).toMatchObject({ level: 'high', mode: 'march' })
    expect(post.plan.stages).toContain('shafts')
    const off = installRenderPost(render, { lightShafts: false })
    expect(off.plan.shafts).toBeNull()
    expect(off.plan.stages).not.toContain('shafts')
    expect(off.plan.dropped.some(d => d.startsWith('shafts'))).toBe(true)
    expect(planPost('pbr', RENDER_PRESETS.ultra, GPU, { lightShafts: false }).stages).not.toContain('shafts')
    expect(planPost('pbr', RENDER_PRESETS.ultra, GPU, { lightShafts: true }).stages).toContain('shafts')
  })
})

describe('bloom (Options → Bloom: off by default, subtle, strong)', () => {
  it('withBloom: off is every preset as the table has it; subtle and strong replace only the bloom keys; Low never changes', () => {
    for (const p of PRESETS) expect(withBloom(RENDER_PRESETS[p], 'off'), p).toBe(RENDER_PRESETS[p])
    for (const level of ['off', 'subtle', 'strong'] as const) expect(withBloom(RENDER_PRESETS.low, level), level).toBe(RENDER_PRESETS.low)
    // A PBR block without the HDR target has no post stack to bloom in.
    const noHdr = { ...RENDER_PRESETS.medium, hdr: false }
    expect(withBloom(noHdr, 'strong')).toBe(noHdr)
    const subtle = withBloom(RENDER_PRESETS.high, 'subtle')
    expect(subtle).toEqual({ ...RENDER_PRESETS.high, ...BLOOM_LOOKS.subtle })
    expect(withBloom(subtle, 'subtle')).toBe(subtle)
    // Back to strong drops the subtle threshold and weight (the shipped rule and weight again).
    const strong = withBloom(subtle, 'strong')
    expect(strong).toEqual({ ...RENDER_PRESETS.high, bloom: 1 })
    expect('bloomThreshold' in strong || 'bloomWeight' in strong).toBe(false)
  })

  it('bloomCutoff: the shipped rule for strong, an exposure-independent tone-map-input cutoff for subtle', () => {
    expect(bloomCutoff(null, 8)).toBeCloseTo(LEGACY_BLOOM_THRESHOLD / 8, 12)
    expect(bloomCutoff(null, 0)).toBeCloseTo(LEGACY_BLOOM_THRESHOLD / 1e-3, 6)
    // Babylon compares the scene-linear luminance with pow(bloomThreshold, 1 / 2.2): after our exposure that is T.
    const T = BLOOM_LOOKS.subtle.bloomThreshold!
    for (const e of [2, 11.2, 40, 220]) expect(Math.pow(bloomCutoff(T, e), 1 / 2.2) * e, `exposure ${e}`).toBeCloseTo(T, 9)
    // The shipped rule's cutoff after the exposure grows with it (≈ 3.5 at noon, ≈ 12 at night).
    const legacy = (e: number) => Math.pow(bloomCutoff(null, e), 1 / 2.2) * e
    expect(legacy(11.2)).toBeGreaterThan(3)
    expect(legacy(11.2)).toBeLessThan(4)
    expect(legacy(100)).toBeGreaterThan(legacy(11.2))
  })

  it('plans bloom from the block: off by default, subtle at half resolution with its threshold, strong as the release shipped High', () => {
    const off = planPost('pbr', RENDER_PRESETS.high, GPU)
    expect([off.bloom, off.bloomThreshold, off.bloomWeight]).toEqual([0, null, 0.15])
    const subtle = planPost('pbr', withBloom(RENDER_PRESETS.medium, 'subtle'), GPU)
    expect([subtle.bloom, subtle.bloomThreshold, subtle.bloomWeight]).toEqual([0.5, BLOOM_LOOKS.subtle.bloomThreshold, BLOOM_LOOKS.subtle.bloomWeight])
    const strong = planPost('pbr', withBloom(RENDER_PRESETS.medium, 'strong'), GPU)
    expect([strong.bloom, strong.bloomThreshold, strong.bloomWeight]).toEqual([1, null, 0.15])
    // Bloom never adds or removes a stage (it lives in the default pipeline).
    expect(subtle.stages).toEqual(planPost('pbr', RENDER_PRESETS.medium, GPU).stages)
    expect(planPost('pbr', withBloom(RENDER_PRESETS.high, 'strong'), GPU).stages).toEqual(off.stages)
    expect(planPost('classic', withBloom(RENDER_PRESETS.medium, 'strong'), GPU).stages).toEqual([])
  })

  it('switches live on the scene: off → subtle → strong → off rebuilds the default pipeline with the right bloom', () => {
    const { camera, render } = setup('pbr', 'medium')
    const post = installRenderPost(render)
    render.attachCamera(camera)
    post.exposureTrim = 1
    render.update(camera, sky({ exposure: 10 }))
    expect(post.pipeline!.bloomEnabled).toBe(false)

    render.setQuality(withBloom(RENDER_PRESETS.medium, 'subtle'))
    const dp = post.pipeline!
    expect(post.stages).toEqual(['shafts', 'default'])
    expect([dp.bloomEnabled, dp.bloomScale, dp.bloomWeight]).toEqual([true, 0.5, BLOOM_LOOKS.subtle.bloomWeight])
    expect(dp.bloomThreshold).toBeCloseTo(bloomCutoff(BLOOM_LOOKS.subtle.bloomThreshold!, 10), 12)
    // The exposure moves (dusk): the threshold follows, same pipeline.
    render.update(camera, sky({ exposure: 40 }))
    expect(post.pipeline).toBe(dp)
    expect(dp.bloomThreshold).toBeCloseTo(bloomCutoff(BLOOM_LOOKS.subtle.bloomThreshold!, 40), 12)

    render.setQuality(withBloom(RENDER_PRESETS.medium, 'strong'))
    const strong = post.pipeline!
    expect([strong.bloomEnabled, strong.bloomScale, strong.bloomWeight]).toEqual([true, 1, 0.15])
    expect(strong.bloomThreshold).toBeCloseTo(0.9 / 40, 12)

    render.setQuality(RENDER_PRESETS.medium)
    expect(post.pipeline!.bloomEnabled).toBe(false)
    expect(post.stages).toEqual(['shafts', 'default'])
  })
})
