/**
 * Wave 12 GODRAYS: the sun shafts (render/volumetrics/shafts.ts, shaft-shaders.ts; render/post.ts stage 'shafts';
 * render/quality.ts `lightShafts`).
 *
 * - The quality flag: Low off (the Low guard), Medium 'low', High/Ultra 'high'; the wave-9 boolean row reads as
 *   'high' / 'off'; `withLightShafts` replaces only that key and never touches a Classic block.
 * - The plan: the march where the CSM holds the trees, the hybrid (march + radial walk) where it has none (Medium),
 *   the screen walk without shadows; quarter resolution on 'low', half on 'high'; the stage sits between TAA and the
 *   default pipeline in every combination.
 * - The look (pure): low sun strong, noon gentle, the moon at half, mist and the humid air after rain stronger (and a
 *   lower baseline, so they glow as a whole), overcast and rain weaker, the key light's colour leaning towards the
 *   haze, nothing without light.
 * - The shaders: WGSL and GLSL declare the same uniforms, samplers and varyings per pass (only Babylon's vUV); every
 *   uniform and sampler is in the pass's list; no implicit-derivative taps in WGSL, no WGSL in GLSL and the reverse;
 *   loop counts clamped; the near-field weight and the baseline in both languages.
 * - The history ping-pongs (a regression: the draft never accumulated).
 * - On a scene (NullEngine): the three passes attach in order before the default pipeline, the march takes the scene's
 *   MSAA samples when it is the first stage, a weather / time frame moves uniforms only (no rebuild), the warm-up
 *   waits for them, Low builds nothing, and nothing in the materials changes (a post stage: no plugin, define or
 *   varying).
 */
import { ArcRotateCamera, InternalTexture, InternalTextureSource, NullEngine, PBRMaterial, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LIGHT_SHAFT_LEVELS,
  RENDER_PRESETS,
  WorldRender,
  lightShaftLevel,
  withLightShafts,
  type GpuInfo,
  type RenderPreset,
  type RenderQuality,
} from '../src/index.ts'
import { POST_STAGE_ORDER, installRenderPost, planPost } from '../src/render/post.ts'
import { CLEAR_RENDER_WEATHER, type RenderWeather } from '../src/render/weather.ts'
import {
  SHAFT_MARCH_DEFINE,
  SHAFT_MAX_STEPS,
  SHAFT_RADIAL_DEFINE,
  SHAFT_REACH,
  SHAFT_SHADERS,
  type ShaftShaderSource,
} from '../src/render/volumetrics/shaft-shaders.ts'
import { SHAFT_SETTINGS, SHAFT_TUNING, hazeTint, planShafts, shaftLook, shaftMarches, shaftRadial, type ShaftLookInput } from '../src/render/volumetrics/shafts.ts'
import type { SkyState } from '../src/sky/types.ts'
import { warmupHooksState } from '../src/warmup-hooks.ts'

const GPU: GpuInfo = { maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16, features: [], vendor: 'nvidia', architecture: 'ada', isFallbackAdapter: false }
const PRESETS: readonly RenderPreset[] = ['low', 'medium', 'high', 'ultra']

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function with3dTextures(engine: NullEngine): void {
  const e = engine as unknown as Record<string, unknown>
  e['createRawTexture3D'] = (_d: unknown, w: number, h: number, d: number, format: number, _m: boolean, invertY: boolean, _s: number, _c: unknown, type: number) => {
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

function setup(preset: RenderPreset, q: Readonly<RenderQuality> = RENDER_PRESETS[preset]) {
  const engine = new NullEngine()
  with3dTextures(engine)
  engine.getCaps().textureHalfFloatRender = true
  engine.getCaps().maxMSAASamples = 4
  const scene = new Scene(engine)
  const camera = new ArcRotateCamera('cam', 0, 1, 14, Vector3.Zero(), scene)
  scene.activeCamera = camera
  const render = new WorldRender(scene, { mode: q.path, quality: q, gpu: GPU })
  cleanups.push(() => {
    render.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { engine, scene, camera, render }
}

function sky(o: Partial<SkyState> = {}): SkyState {
  const dir = new Vector3(0.9, 0.35, 0.1).normalize()
  return {
    t: 0.3, day: 0, phase: 0.3, sunDir: dir, moonDir: new Vector3(0, -1, 0), sunElevationDeg: 20,
    moon: { age: 0, illum: 0, texture: 1 }, keyLight: { dir, color: [1, 0.85, 0.7], intensity: 0.4 },
    ambient: { sky: [0.4, 0.5, 0.7], horizon: [0.5, 0.5, 0.5], ground: [0.2, 0.2, 0.2] }, sh: null, fogColor: [0.6, 0.7, 0.8],
    horizonRing: null, exposure: 8, night: 0, twilight: 0, cloudCover: 0.1, cloudShadow: null, cloudNoise: null, env: {} as never, ...o,
  } as unknown as SkyState
}

const names = (cam: { _postProcesses: Array<{ name: string } | null> }) => cam._postProcesses.filter(p => p !== null).map(p => p!.name)

// ---- the quality flag ---------------------------------------------------------------------------------------------

describe('graphics.lightShafts: the quality flag', () => {
  it('Low is off (the Low guard), Medium light, High and Ultra full', () => {
    expect(PRESETS.map(p => lightShaftLevel(RENDER_PRESETS[p]))).toEqual(['off', 'low', 'high', 'high'])
    expect(LIGHT_SHAFT_LEVELS).toEqual(['off', 'low', 'high'])
  })

  it('reads the wave-9 Advanced boolean as full / off, and nothing on a Classic or LDR block', () => {
    expect(lightShaftLevel({ ...RENDER_PRESETS.medium, lightShafts: true })).toBe('high')
    expect(lightShaftLevel({ ...RENDER_PRESETS.ultra, lightShafts: false })).toBe('off')
    expect(lightShaftLevel({ ...RENDER_PRESETS.low, lightShafts: 'high' })).toBe('off')
    expect(lightShaftLevel({ ...RENDER_PRESETS.high, hdr: false })).toBe('off')
  })

  it('withLightShafts: auto is the preset as it is; a level replaces only that key; Low never changes', () => {
    for (const p of PRESETS) expect(withLightShafts(RENDER_PRESETS[p], 'auto'), p).toBe(RENDER_PRESETS[p])
    for (const l of LIGHT_SHAFT_LEVELS) expect(withLightShafts(RENDER_PRESETS.low, l), l).toBe(RENDER_PRESETS.low)
    const high = withLightShafts(RENDER_PRESETS.medium, 'high')
    expect(high).toEqual({ ...RENDER_PRESETS.medium, lightShafts: 'high' })
    expect(withLightShafts(high, 'high')).toBe(high)
    expect(lightShaftLevel(withLightShafts(RENDER_PRESETS.ultra, 'off'))).toBe('off')
  })
})

// ---- the plan -----------------------------------------------------------------------------------------------------

describe('planShafts / planPost', () => {
  it('Medium is the hybrid at quarter resolution, High and Ultra the march at half; Low nothing', () => {
    expect(planShafts(RENDER_PRESETS.low)).toBeNull()
    expect(planShafts(RENDER_PRESETS.medium)).toEqual({ level: 'low', mode: 'hybrid', ...SHAFT_SETTINGS.low })
    expect(planShafts(RENDER_PRESETS.high)).toEqual({ level: 'high', mode: 'march', ...SHAFT_SETTINGS.high })
    expect(planShafts(RENDER_PRESETS.ultra)).toEqual({ level: 'high', mode: 'march', ...SHAFT_SETTINGS.high })
    expect([SHAFT_SETTINGS.low.ratio, SHAFT_SETTINGS.high.ratio]).toEqual([0.25, 0.5])
  })

  it('the mode follows what the shadow map holds: trees → march, none → hybrid, no shadows → screen', () => {
    const noTrees = { ...RENDER_PRESETS.high, shadows: { ...RENDER_PRESETS.high.shadows!, foliageM: 0 } }
    expect(planShafts(noTrees)!.mode).toBe('hybrid')
    expect(planShafts({ ...RENDER_PRESETS.high, shadows: null })!.mode).toBe('screen')
    expect(planShafts({ ...RENDER_PRESETS.medium, shadows: null })!.mode).toBe('screen')
    // A forced mode (the lab) that needs a shadow map falls back to the screen walk without one.
    expect(planShafts(RENDER_PRESETS.medium, { mode: 'march' })!.mode).toBe('march')
    expect(planShafts({ ...RENDER_PRESETS.medium, shadows: null }, { mode: 'march' })!.mode).toBe('screen')
    expect([shaftMarches('march'), shaftMarches('hybrid'), shaftMarches('screen')]).toEqual([true, true, false])
    expect([shaftRadial('march'), shaftRadial('hybrid'), shaftRadial('screen')]).toEqual([false, true, true])
  })

  it("'shafts' sits after TAA and before the default pipeline in every combination; Classic plans none", () => {
    expect(POST_STAGE_ORDER.indexOf('shafts')).toBe(POST_STAGE_ORDER.indexOf('default') - 1)
    expect(POST_STAGE_ORDER.indexOf('shafts')).toBeGreaterThan(POST_STAGE_ORDER.indexOf('taa'))
    const bools = [false, true]
    for (const level of LIGHT_SHAFT_LEVELS) for (const taa of bools) for (const ssao of bools) for (const small of bools) {
      const q: RenderQuality = { ...RENDER_PRESETS.high, lightShafts: level, aa: taa ? 'taa' : 'fxaa', ssao: ssao ? { halfRes: true, samples: 8 } : null, renderScale: small ? 0.75 : 1 }
      const s = planPost('pbr', q, GPU).stages
      expect(s).toEqual(POST_STAGE_ORDER.filter(x => s.includes(x)))
      expect(s.includes('shafts')).toBe(level !== 'off')
      expect(planPost('classic', q, GPU).stages).toEqual([])
    }
  })
})

// ---- the look -----------------------------------------------------------------------------------------------------

const base: ShaftLookInput = {
  sunElevationDeg: 8, keyColor: [1, 0.85, 0.7], keyIntensity: 0.4, sunScale: 1.7, fogColor: [0.6, 0.7, 0.8],
  weather: CLEAR_RENDER_WEATHER, fogDensity: 0, fogStartM: 180,
}
const lum = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
const weather = (w: Partial<RenderWeather>): RenderWeather => ({ ...CLEAR_RENDER_WEATHER, ...w })

describe('shaftLook: strength follows the world', () => {
  it('strongest with a low sun, gentle at noon; the moon at half; nothing without light', () => {
    const low = shaftLook(base)
    const noon = shaftLook({ ...base, sunElevationDeg: 70 })
    expect(low.on).toBe(true)
    expect(noon.factors.sun).toBeCloseTo(SHAFT_TUNING.noon, 6)
    expect(low.factors.sun).toBeCloseTo(1, 6)
    expect(lum(noon.color) / lum(low.color)).toBeCloseTo(SHAFT_TUNING.noon, 6)
    const night = shaftLook({ ...base, sunElevationDeg: -20, keyIntensity: 0.02 })
    expect(night.factors.sun).toBeCloseTo(SHAFT_TUNING.moon, 6)
    expect(shaftLook({ ...base, keyIntensity: 0 }).on).toBe(false)
  })

  it('mist and the humid air after rain thicken them; overcast and rain thin them', () => {
    const clear = shaftLook(base)
    const fog = shaftLook({ ...base, weather: weather({ fogMul: 2.2 }) })
    expect(fog.factors.mist).toBeCloseTo(0.96, 6)
    expect(fog.sigma).toBeCloseTo(clear.sigma * (1 + SHAFT_TUNING.mistSigma * fog.factors.mist), 9)
    expect(lum(fog.color) / lum(clear.color)).toBeCloseTo(1 + SHAFT_TUNING.mistGain * fog.factors.mist, 6)
    const after = shaftLook({ ...base, weather: weather({ wetness: 0.9, rain: 0 }) })
    expect(after.factors.humidity).toBeCloseTo(0.9, 6)
    expect(after.sigma).toBeGreaterThan(clear.sigma)
    expect(lum(after.color)).toBeGreaterThan(lum(clear.color))
    // While it rains the ground is wet too, but the air carries the rain, not the after-rain haze.
    const raining = shaftLook({ ...base, weather: weather({ wetness: 0.9, rain: 0.9, cloud: 0.9 }) })
    expect(raining.factors.humidity).toBe(0)
    expect(lum(raining.color)).toBeLessThan(lum(clear.color) * 0.1)
    const overcast = shaftLook({ ...base, weather: weather({ cloud: 0.95 }) })
    expect(lum(overcast.color)).toBeCloseTo(lum(clear.color) * 0.25, 6)
  })

  it('the baseline (what the march keeps above the region): full in clear air, lower in mist and after rain', () => {
    const t = SHAFT_TUNING
    expect(shaftLook(base).open).toBeCloseTo(t.open, 9)
    const fog = shaftLook({ ...base, weather: weather({ fogMul: 2.25 }) })
    expect(fog.open).toBeCloseTo(t.open * (1 - t.mistOpen), 9)
    const after = shaftLook({ ...base, weather: weather({ wetness: 1, rain: 0 }) })
    expect(after.open).toBeCloseTo(t.open * (1 - t.humidOpen), 9)
    expect(shaftLook({ ...base, weather: weather({ fogMul: 2.25, wetness: 1 }) }).open).toBeGreaterThanOrEqual(0)
  })

  it('the key light colour leans towards the sky haze; only fog within reach adds to σ', () => {
    const warm = shaftLook({ ...base, keyColor: [1, 0.6, 0.3], fogColor: [0.5, 0.5, 0.5] })
    expect(warm.color[0] / warm.color[2]).toBeCloseTo(1 / 0.3, 6) // grey haze: the key's own colour
    const blue = shaftLook({ ...base, keyColor: [1, 1, 1], fogColor: [0.4, 0.6, 0.9] })
    expect(blue.color[2]).toBeGreaterThan(blue.color[0])
    expect(hazeTint([0.5, 0.5, 0.5]).map(v => +v.toFixed(6))).toEqual([1, 1, 1])
    expect(hazeTint([0, 0, 0])).toEqual([1, 1, 1])
    expect(shaftLook({ ...base, fogDensity: 0.05, fogStartM: 180 }).sigma).toBe(shaftLook(base).sigma)
    expect(shaftLook({ ...base, fogDensity: 0.05, fogStartM: 40 }).sigma).toBeGreaterThan(shaftLook(base).sigma)
  })
})

// ---- the shaders --------------------------------------------------------------------------------------------------

const uniformsOf = (src: string, lang: 'wgsl' | 'glsl') =>
  lang === 'wgsl'
    ? [...src.matchAll(/^\s*uniform\s+(\w+)\s*:/gm)].map(m => m[1]!).sort()
    : [...src.matchAll(/^\s*uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+(\w+)\s*;/gm)].filter(m => !m[1]!.startsWith('sampler')).map(m => m[2]!).sort()
const texturesOf = (src: string, lang: 'wgsl' | 'glsl') =>
  (lang === 'wgsl'
    ? [...src.matchAll(/var\s+(\w+)\s*:\s*texture_/g)].map(m => m[1]!)
    : [...src.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?sampler\w*\s+(\w+)\s*;/g)].map(m => m[1]!)).sort()
const varyingsOf = (src: string, lang: 'wgsl' | 'glsl') =>
  [...src.matchAll(lang === 'wgsl' ? /varying\s+(\w+)\s*:/g : /varying\s+\w+\s+(\w+)\s*;/g)].map(m => m[1]!)

describe('the shaders: WGSL / GLSL parity and the WGSL rules', () => {
  it.each(Object.entries(SHAFT_SHADERS))('%s: the same uniforms, textures and varyings; all of them in its lists', (_k, s: ShaftShaderSource) => {
    expect(uniformsOf(s.wgsl, 'wgsl')).toEqual(uniformsOf(s.glsl, 'glsl'))
    expect(texturesOf(s.wgsl, 'wgsl')).toEqual(texturesOf(s.glsl, 'glsl'))
    expect(varyingsOf(s.wgsl, 'wgsl')).toEqual(['vUV'])
    expect(varyingsOf(s.glsl, 'glsl')).toEqual(['vUV'])
    expect(uniformsOf(s.wgsl, 'wgsl')).toEqual([...s.uniforms].sort())
    for (const t of texturesOf(s.wgsl, 'wgsl')) expect(['textureSampler', ...s.samplers], t).toContain(t)
    for (const n of [...s.wgsl.matchAll(/uniforms\.(\w+)/g)].map(m => m[1]!)) expect(s.uniforms, n).toContain(n)
  })

  it('WGSL has no implicit-derivative taps and no GLSL; GLSL has no WGSL; loop counts are clamped', () => {
    for (const s of Object.values(SHAFT_SHADERS)) {
      expect(s.wgsl).not.toMatch(/textureSample\s*\(|textureSampleCompare\s*\(|texture2D|gl_Frag|\bvec[234]\s*\(/)
      expect(s.glsl).not.toMatch(/\bfn\s|\blet\s|vec[234]f|textureLoad|@fragment|uniforms\./)
    }
    const m = SHAFT_SHADERS.march
    expect(m.wgsl).toContain(`clamp(i32(uniforms.sroFwd.w), 1, ${SHAFT_MAX_STEPS})`)
    expect(m.glsl).toContain(`clamp(int(sroFwd.w), 1, ${SHAFT_MAX_STEPS})`)
    const r = SHAFT_SHADERS.resolve
    expect(r.wgsl).toContain(`clamp(i32(uniforms.sroRadial.w), 1, ${SHAFT_MAX_STEPS})`)
    expect(r.glsl).toContain(`clamp(int(sroRadial.w), 1, ${SHAFT_MAX_STEPS})`)
    // The near-field weight (exp(−REACH · t / the longest ray)) in both languages.
    expect(m.wgsl).toContain(`exp(-(sigma + ${SHAFT_REACH.toFixed(1)} / uniforms.sroEye.w) * t)`)
    expect(m.glsl).toContain(`exp(-(sigma + ${SHAFT_REACH.toFixed(1)} / sroEye.w) * t)`)
    // The march keeps what it has above the region's lit share (the baseline), clamp bounds included.
    for (const src of [r.wgsl, r.glsl]) {
      expect(src).toMatch(/base = (uniforms\.)?sroShape\.x \* cur\.y \* litReg;/)
      for (const v of ['cur', 'mn', 'mx']) expect(src).toContain(`${v}.x = max(${v}.x - base, 0.0) * boost;`)
      // The radial walk's history has no neighbourhood to clamp to: unclamped, at half the blend.
      expect(src).toContain('mx.z = 60000.0;')
    }
    // The shadow map is only declared where the march runs (the screen walk binds no CSM).
    for (const lang of ['wgsl', 'glsl'] as const) {
      const src = m[lang]
      const at = src.indexOf('sroShadowMap')
      expect(src.lastIndexOf(`#ifdef ${SHAFT_MARCH_DEFINE}`, at)).toBeGreaterThan(-1)
      expect(src).toContain(`#ifdef ${SHAFT_RADIAL_DEFINE}`)
    }
  })
})

// ---- on a scene -------------------------------------------------------------------------------------------------

describe('RenderPost with the shafts (NullEngine)', () => {
  it('Medium: march, resolve, composite attach before the default pipeline; Low builds nothing', () => {
    const { camera, render } = setup('medium')
    const post = installRenderPost(render)
    render.attachCamera(camera)
    expect(post.stages).toEqual(['shafts', 'default'])
    const n = names(camera as never)
    expect(n.slice(0, 3)).toEqual(['sroShaftsMarch', 'sroShaftsResolve', 'sroShaftsComposite'])
    expect(n.length).toBeGreaterThan(3)
    expect(post.shafts!.plan).toMatchObject({ level: 'low', mode: 'hybrid' })
    expect(post.shafts!.march.samples).toBe(1)

    render.setMode('classic')
    render.setQuality(RENDER_PRESETS.low)
    expect(post.shafts).toBeNull()
    expect(names(camera as never)).toEqual([])
  })

  it('as the first stage the march takes the scene MSAA samples; behind TAA it does not', () => {
    const msaa = setup('medium', { ...RENDER_PRESETS.medium, aa: 'msaa' })
    const post = installRenderPost(msaa.render)
    msaa.render.attachCamera(msaa.camera)
    expect(post.plan.msaa).toBe(4)
    expect(post.shafts!.march.samples).toBe(4)
    expect(post.pipeline!.samples).toBe(1)
    const taa = setup('high', { ...RENDER_PRESETS.high, ssao: null })
    const p2 = installRenderPost(taa.render)
    taa.render.attachCamera(taa.camera)
    expect(p2.plan.stages[0]).toBe('taa')
    expect(p2.shafts!.march.samples).toBe(1)
  })

  it('a time and weather frame moves uniforms only: the same passes, no rebuild', () => {
    const { camera, render } = setup('high')
    const post = installRenderPost(render)
    render.attachCamera(camera)
    const shafts = post.shafts!
    const passes = [...shafts.postProcesses]
    render.update(camera, sky())
    expect(shafts.look!.on).toBe(true)
    render.setWeather({ ...CLEAR_RENDER_WEATHER, rain: 1, cloud: 1, wetness: 1, puddles: 1, fogMul: 2 })
    render.update(camera, sky({ sunElevationDeg: -30, keyLight: { dir: new Vector3(0, 1, 0), color: [0.6, 0.7, 1], intensity: 0.01 } }))
    expect(post.shafts).toBe(shafts)
    expect([...shafts.postProcesses]).toEqual(passes)
    expect(shafts.look!.factors.weather).toBeLessThan(0.5)
  })

  it('the history ping-pongs: each frame reads the target the last frame wrote and writes the other', () => {
    const { camera, render } = setup('medium')
    const post = installRenderPost(render)
    render.attachCamera(camera)
    const shafts = post.shafts!
    const h = shafts as unknown as { read: unknown; write: unknown }
    const frame = () => {
      shafts.resolve.onActivateObservable.notifyObservers(camera)
      // The setter forces the composite's input (the getter reads Babylon's own targets).
      return { read: h.read, write: h.write, input: (shafts.composite as unknown as { _forcedOutputTexture: unknown })._forcedOutputTexture }
    }
    const a = frame()
    const b = frame()
    const c = frame()
    expect(a.write).not.toBe(a.read)
    expect(a.input).toBe(a.write)
    // Regression: the wave-12 draft wrote the same target every frame and read one never written (no accumulation).
    expect(b.read).toBe(a.write)
    expect(b.write).toBe(a.read)
    expect(c.read).toBe(b.write)
    expect(c.write).toBe(a.write)
  })

  it('the warm-up waits for the passes; disposing takes the hook and the passes away', () => {
    const { scene, camera, render } = setup('medium')
    const post = installRenderPost(render)
    render.attachCamera(camera)
    const shafts = post.shafts!
    expect(warmupHooksState(scene)).toBe(shafts.isReady() ? 'ready' : 'compiling')
    render.setQuality(withLightShafts(RENDER_PRESETS.medium, 'off'))
    expect(post.shafts).toBeNull()
    expect(names(camera as never).some(n => n.startsWith('sroShafts'))).toBe(false)
    expect(warmupHooksState(scene)).toBe('ready')
  })

  it('touches no material: no plugin, define or varying (a post stage)', () => {
    const on = setup('medium')
    const off = setup('medium', withLightShafts(RENDER_PRESETS.medium, 'off'))
    for (const s of [on, off]) {
      installRenderPost(s.render)
      s.render.attachCamera(s.camera)
    }
    const a = new PBRMaterial('a', on.scene)
    const b = new PBRMaterial('b', off.scene)
    const plugins = (m: PBRMaterial) => (m.pluginManager as unknown as { _plugins?: Array<{ name: string }> } | undefined)?._plugins?.map(p => p.name).sort() ?? []
    expect(plugins(a)).toEqual(plugins(b))
  })
})
