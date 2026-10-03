/**
 * W9F adversarial hunt, lens "readability" (docs/WAVE_PLAN3.md §6.19 item 14: a mob at 30 m at midnight in a storm,
 * UI legibility unchanged, `reduceFlashing` covers sky, env and PBR flash). Each `it` states a problem found in the
 * engine and fails until it is fixed; the numbers in the comments were measured on WebGPU High at the Jangan plaza
 * (2026-09-29, a private tab with `?weather=storm`, the flash injected through World.setWeather).
 *
 * 1. The lightning flash on the PBR presets is scene-linear light that the night exposure (×40–80) multiplies: at night
 *    the REDUCED flash is a bigger relative jump than the full flash by day, so "Reduce flashing" does not tone night
 *    flashes down to a day flash (engine: night storm 0.010 → 0.045 mean Y with reduceFlashing, ×4.5; day storm full
 *    flash 0.036 → 0.133, ×3.7; night full flash 0.010 → 0.208, ×21 and Δ 0.2, a WCAG-size general flash).
 * 2. The target circle (TargetDecal: an unlit StandardMaterial with the retail select_0N art) draws display colours
 *    straight into the HDR target, so the post stack's exposure blows it out: the orange hostile, green neutral and blue
 *    friendly circles all read as near-white discs with a bloom halo at night (the tone that says "hostile" is lost),
 *    the problem W9 LOOK fixed for the hover overlay (setHighlightOverlay) but not for the decal.
 */
import { ArcRotateCamera, Color3, InternalTexture, InternalTextureSource, NullEngine, Scene, StandardMaterial, Texture, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { NEUTRAL_CLIMATE, weatherParams, type WeatherKind } from '@sro/shared'
import { evaluateProfile, type EnvProfile, type RGB } from '../../../packages/world-render/src/environment.ts'
import { RENDER_PRESETS } from '../../../packages/world-render/src/render/quality.ts'
import { WorldRender } from '../../../packages/world-render/src/render/index.ts'
import { blendStrips, builtinLutStrip, gradeWeights, LUT_KEYS, LUT_SIZE } from '../../../packages/world-render/src/render/grade.ts'
import { addConstantSH, flashExposureScale, LIGHT_CALIBRATIONS, shIrradiance, skyStateSH } from '../../../packages/world-render/src/render/lighting.ts'
import { EXPOSURE_TRIM, installRenderPost, sceneExposure } from '../../../packages/world-render/src/render/post.ts'
import { SkySystem } from '../../../packages/world-render/src/sky/sky-system.ts'
import { SKY_PRESETS, type SkyState } from '../../../packages/world-render/src/sky/types.ts'
import { toRenderWeather, toSkyWeather } from '../../../packages/world-render/src/weather/adapters.ts'
import type { GpuInfo } from '../../../packages/world-render/src/render/index.ts'
import { TargetDecal, type DecalTextureSource } from '../src/world/effects.ts'
import { WeatherClient } from '../src/world/features/weather.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

// ---- the headless look model (the same one packages/world-render/test/look-calibration.test.ts uses) -------------

function janganProfile(): EnvProfile {
  const keys = (rows: Array<[number, number, number, number]>) => rows.map(([time, r, g, b]) => ({ time, r, g, b }))
  const floats = (rows: Array<[number, number]>) => rows.map(([time, value]) => ({ time, value }))
  return {
    id: 15, name: 'Env7',
    sunColor: keys([[0, 1, 1, 1]]),
    skyTopColor: keys([[0, 0.05, 0.07, 0.19], [0.25, 0.31, 0.5, 0.49], [0.5, 0.17, 0.57, 0.95], [0.75, 0.35, 0.47, 0.82], [0.88, 0.36, 0.33, 0.49], [1, 0.05, 0.07, 0.19]]),
    diffuseColor: keys([[0, 0.44, 0.52, 0.57], [0.25, 0.72, 0.7, 0.6], [0.5, 0.73, 0.72, 0.72], [0.75, 0.78, 0.69, 0.54], [0.88, 0.41, 0.42, 0.42], [1, 0.44, 0.52, 0.57]]),
    objectAmbientColor: keys([[0, 0.32, 0.36, 0.39], [0.25, 0.59, 0.62, 0.54], [0.5, 0.68, 0.67, 0.66], [0.75, 0.73, 0.62, 0.46], [0.88, 0.51, 0.49, 0.6], [1, 0.32, 0.36, 0.39]]),
    graph4: keys([[0, 1, 1, 1]]),
    terrainAmbientColor: keys([[0, 1, 1, 1]]),
    terrainShadowColor: keys([[0, 0.02, 0, 0.16], [0.5, 0, 0, 0], [1, 0.02, 0, 0.16]]),
    fogNearPlane: floats([[0, -0.76]]),
    fogFarPlane: floats([[0, -1]]),
    fogColor: keys([[0, 0.15, 0.19, 0.28], [0.25, 0.44, 0.54, 0.42], [0.5, 0.36, 0.58, 0.68], [0.75, 0.31, 0.39, 0.33], [0.88, 0.21, 0.23, 0.34], [1, 0.15, 0.19, 0.28]]),
    graph10: floats([[0, 0.76]]),
    graph11: floats([[0, 1]]),
    graph12: floats([[0, 0.25], [0.25, -0.04], [0.5, 0.52], [0.75, -0.23], [1, 0.25]]),
    skyBottomColor: keys([[0, 0.53, 0.66, 0.75], [0.25, 1, 1, 0.49], [0.5, 0.76, 0.97, 1], [0.75, 1, 0.66, 0.3], [0.88, 0.87, 0.81, 0.89], [1, 0.53, 0.66, 0.75]]),
    waterColor: keys([[0, 0.36, 0.69, 0.62]]),
    graph15: floats([[0, 1], [0.18, -0.71], [0.5, -1], [0.78, -0.82], [0.88, 0.01], [1, 1]]),
  }
}

/** KHR PBR Neutral (Babylon's TONEMAPPING_KHR_PBR_NEUTRAL). */
function neutral(c: RGB): RGB {
  const start = 0.8 - 0.04
  const x = Math.min(...c)
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04
  let o = c.map(v => v - offset) as RGB
  const peak = Math.max(...o)
  if (peak < start) return o
  const d = 1 - start
  const newPeak = 1 - (d * d) / (peak + d - start)
  o = o.map(v => (v * newPeak) / peak) as RGB
  const g = 1 - 1 / (0.15 * (peak - newPeak) + 1)
  return o.map(v => v + (newPeak - v) * g) as RGB
}
const enc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055)
const dec = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const lum = (c: Readonly<RGB>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
/** Relative luminance (WCAG) of a display (sRGB) colour. */
const relY = (c: Readonly<RGB>) => lum(c.map(dec) as RGB)
const sat = (c: Readonly<RGB>) => {
  const mx = Math.max(...c)
  return mx > 0 ? (mx - Math.min(...c)) / mx : 0
}
const STRIPS = LUT_KEYS.map(k => builtinLutStrip(k))
/** render/lighting.ts FLASH_RGB (module-private there; grass-chunks.ts repeats it). */
const FLASH_RGB: RGB = [0.82, 0.88, 1]

/**
 * What the plaza (a level sRGB 0.45 texel) shows at `hours` in `kind` weather with the WeatherFrame flash `flash`
 * (0..3, what WeatherClient.frame hands the world): the modern sky's state, the lighting's key light + flash fill and
 * SH + flash ambient (render/lighting.ts WorldLighting.update), the exposure × EXPOSURE_TRIM, PBR Neutral and the LUT.
 */
function plaza(hours: number, kind: WeatherKind, flash: number, days = 14.77): RGB {
  const t = hours / 24
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const profile = janganProfile()
  const env = evaluateProfile(profile, t)
  const sky = new SkySystem(scene, env, { style: 'modern', quality: SKY_PRESETS.high })
  cleanups.push(() => {
    sky.dispose()
    scene.dispose()
    engine.dispose()
  })
  const p = weatherParams(kind)
  const frame = { cloud: p.cloud, cloudDark: p.cloudDark, cirrus: p.cirrus, rain: p.rain, fog: p.fog, sun: p.sun, desat: p.desat, windX: 1, windZ: 0, windMs: p.windMs, gustMs: p.windMs, wet: p.rain, puddle: p.rain, flash, flashX: 1, flashZ: 0, time: 0 }
  sky.setWeather(toSkyWeather(frame))
  sky.setRetail({ env, t, days, declination: 12, profile })
  for (let i = 0; i < 300; i++) sky.update(0.016, null)
  const s: SkyState = sky.state
  const cal = LIGHT_CALIBRATIONS.modern
  const rw = toRenderWeather(frame)
  // WorldLighting scales the flash light by the exposure above the day range (flashExposureScale).
  rw.flash *= flashExposureScale(sky.state.exposure)
  const k = s.keyLight
  const kd = k.dir.clone().normalize()
  const sh = skyStateSH(s)
  if (rw.flash > 0) addConstantSH(sh, FLASH_RGB, rw.flash * cal.flashAmbient)
  const exposure = s.exposure * EXPOSURE_TRIM
  const e = shIrradiance(sh, 0, 1, 0)
  const ndl = Math.max(0, kd.y)
  const albedo = dec(0.45)
  const hdr = [0, 1, 2].map(c => (albedo * ((cal.sun * k.intensity * k.color[c]! + FLASH_RGB[c]! * rw.flash * cal.flashSun) * ndl + e[c]! * cal.env) / Math.PI) * exposure) as RGB
  const lut = blendStrips(STRIPS, gradeWeights(s.sunElevationDeg, s.t, rw.cloud, rw.rain), new Uint8Array(STRIPS[0]!.length))
  const n = LUT_SIZE
  const i = neutral(hdr).map(v => Math.min(n - 1, Math.max(0, Math.round(enc(v) * (n - 1)))))
  const o = ((i[2]! * n + i[1]!) * n + i[0]!) * 4
  return [lut[o]! / 255, lut[o + 1]! / 255, lut[o + 2]! / 255]
}

/** The flash WeatherClient hands the world at a strike's first peak (reduceFlashing on or off). */
function peakFlash(reduceFlashing: boolean): number {
  const c = new WeatherClient(null, 0)
  c.enter(undefined, 0)
  const at = 10_000
  c.strike(at, 1500, 0)
  return c.frame(at, 0.016, NEUTRAL_CLIMATE, reduceFlashing).flash
}

describe('W9F readability: reduceFlashing at night', () => {
  it('a reduced night flash is not a bigger jump than an unreduced day flash (the flash is ×exposure on PBR)', () => {
    const full = peakFlash(false)
    const reduced = peakFlash(true)
    expect(full).toBeCloseTo(3, 6)
    expect(reduced).toBeCloseTo(0.75, 6)
    // Midnight storm under a full moon, Reduce flashing ON: the plaza jumps 0.030 → 0.154 relative luminance (×5.1).
    const nightRatio = relY(plaza(0, 'storm', reduced)) / relY(plaza(0, 'storm', 0))
    // A 14:00 storm, Reduce flashing OFF: 0.115 → 0.292 (×2.5). Engine: ×4.5 reduced at night against ×3.7 full by day.
    const dayRatio = relY(plaza(14, 'storm', full)) / relY(plaza(14, 'storm', 0))
    expect(nightRatio).toBeLessThanOrEqual(dayRatio)
  })
})

// ---- the target circle on the PBR presets -------------------------------------------------------------------------

const GPU: GpuInfo = { maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16, features: [], vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false }

/** NullEngine has no 3D textures (the LUT): a CPU-side stand-in (as in world-render's post.test.ts). */
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

function nightSky(exposure: number): SkyState {
  return {
    t: 0.02, day: 0, phase: 0.02, sunDir: new Vector3(0, -1, 0), moonDir: new Vector3(0.2, 0.9, 0.1).normalize(), sunElevationDeg: -60,
    moon: { age: 14, illum: 1, texture: 16 }, keyLight: { dir: new Vector3(0.2, 0.9, 0.1).normalize(), color: [0.77, 0.91, 1], intensity: 0.02 },
    ambient: { sky: [0.02, 0.025, 0.04], horizon: [0.02, 0.02, 0.03], ground: [0.005, 0.005, 0.01] }, sh: null, fogColor: [0.1, 0.12, 0.18],
    horizonRing: null, exposure, night: 1, twilight: 0, cloudCover: 1, cloudShadow: null, cloudNoise: null, env: {} as never,
  } as unknown as SkyState
}

describe('W9F readability: the target circle keeps its tone on the PBR presets', () => {
  it('the hostile circle is not blown to white by the night exposure (display colours need ÷ exposure, like the hover overlay)', () => {
    const engine = new NullEngine()
    with3dTextures(engine)
    engine.getCaps().textureHalfFloatRender = true
    const scene = new Scene(engine)
    const camera = new ArcRotateCamera('cam', 0, 1, 14, Vector3.Zero(), scene)
    scene.activeCamera = camera
    const render = new WorldRender(scene, { mode: 'pbr', quality: RENDER_PRESETS.medium, gpu: GPU })
    cleanups.push(() => {
      render.dispose()
      scene.dispose()
      engine.dispose()
    })
    installRenderPost(render)
    render.attachCamera(camera)
    // Engine: 01:00 in a storm the stack multiplies the scene by 41.4 (SkyState.exposure 29.6 × EXPOSURE_TRIM).
    render.update(camera, nightSky(29.6))
    const exposure = sceneExposure(scene)
    expect(exposure).toBeGreaterThan(30)

    const source: DecalTextureSource = (_key, s) => new Texture(null, s)
    const ring = new TargetDecal(scene, undefined, source)
    ring.show('hostile', 1)
    const mat = ring.mesh.material as StandardMaterial
    expect(mat.disableLighting).toBe(true)
    // select_04.png's mean opaque texel (work/out/fx/tex/ui/select_04.png): orange.
    const texel: RGB = [0.864, 0.499, 0.294]
    const level = mat.emissiveTexture?.level ?? 1
    const add = mat.emissiveColor ?? new Color3(0, 0, 0)
    // What the HDR target holds for that texel, then the post stack: × exposure, PBR Neutral. W9F fix-game: on the PBR
    // presets image processing runs as a post process, so Babylon's standard shader linearises its output
    // (IMAGEPROCESSINGPOSTPROCESS: toLinearSpace, pow 2.2) before it reaches the HDR target; the original model left
    // that out (it only mattered once the colour was scaled, which is the fix).
    expect(scene.imageProcessingConfiguration.applyByPostProcess && scene.imageProcessingConfiguration.isEnabled).toBe(true)
    const hdr = texel.map((v, c) => Math.pow(v * level + add.asArray()[c]!, 2.2) * exposure) as RGB
    const shown = neutral(hdr).map(enc) as RGB
    // The art's hue must survive (engine: the hostile ring shows as a near-white peach disc with a bloom halo).
    expect(sat(shown)).toBeGreaterThan(0.5 * sat(texel))
  })
})
