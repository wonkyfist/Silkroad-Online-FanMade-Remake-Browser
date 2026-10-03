/**
 * W9 LOOK: the calibration of the modern look and its visual fixes (work/tmp/w9-finish/look, the before/after sheet).
 * The headless modern SkySystem at the shot list's conditions (Jangan profile 0, the clear/overcast/storm vectors of
 * @sro/shared) through the lighting calibration, the render-side exposure trim, KHR PBR Neutral and the grade LUT:
 * what a plaza texel (sRGB 0.45), a character's lit and shadowed sides (sRGB 0.6) and the fog show. The engine numbers
 * the targets were checked against are in the comments (WebGPU High and WebGL2 Medium, 2026-09-29).
 *
 *   (a) dusk (18:00–18:45) golden-warm, not pink-red, not black;
 *   (b) night navy and moody, with readable shadowed sides, also in a night storm;
 *   (e) storms moody, not washed out: the exposure cap, a darker fog;
 *   (f) full cloud cover hides the whole sky (IBL and ambient; the dome's overcast deck);
 *   (g) noon: the trim that put the plaza back within ±10 % of Classic;
 *   plus the highlight overlay, the self-lit retail emissive, the rain streaks and splashes, the puddle hash.
 */
import { AssetContainer, Color3, CreateBox, NullEngine, PBRMaterial, RawTexture, Scene, type BaseTexture } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { weatherParams, type WeatherKind } from '../../shared/src/weather.ts'
import { evaluateProfile, type EnvProfile, type RGB } from '../src/environment.ts'
import { Assets, ObjectMaterials, type SidecarLite, type WorldIO } from '../src/index.ts'
import { EMISSIVE_AMBIENT, PbrSurfaces, SroSurfacePlugin, WET_REFLECT_MAX, surfaceFragmentCode, surfacePluginOf } from '../src/pbr/surface-plugin.ts'
import { terrainPluginCode } from '../src/pbr/terrain-plugin.ts'
import { blendStrips, builtinLutStrip, gradeWeights, LUT_KEYS, LUT_SIZE } from '../src/render/grade.ts'
import { CALIBRATION_TARGET, LIGHT_CALIBRATIONS, lightBalance, shIrradiance, skyStateSH } from '../src/render/lighting.ts'
import {
  EXPOSURE_TRIM,
  HIGHLIGHT_ALPHA,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_LINEAR_K,
  highlightOverlayColor,
  highlightOverlayCount,
  sceneExposure,
  setHighlightOverlay,
} from '../src/render/post.ts'
import {
  GOLDEN_KEY,
  SkySystem,
  WEATHER_EXPOSURE_GAIN,
  cloudSkyWeight,
  goldenFloor,
  twilightExposure,
} from '../src/sky/sky-system.ts'
import { skyFragmentGLSL, skyFragmentWGSL } from '../src/sky/sky-shaders.ts'
import { SKY_PRESETS, type SkyState } from '../src/sky/types.ts'
import { toRenderWeather, toSkyWeather } from '../src/weather/adapters.ts'
import { RAIN_FLOOR, RAIN_GREY, RAIN_LIFT } from '../src/weather/index.ts'
import {
  CURTAIN_COLUMNS,
  CURTAIN_RADIUS_M,
  RAIN_ALPHA,
  RAIN_NEAR_M,
  RAIN_SHADERS,
  SPLASH_ALPHA,
  SPLASH_BRIGHT,
  SPLASH_CROWN_M,
  SPLASH_HALF_M,
} from '../src/weather/rain.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

// ---- the headless look model -------------------------------------------------------------------------------------

/** Jangan's Env7 keyframes (docs/SKY.md §1 table; the same profile sky-state.test.ts uses). */
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
const STRIPS = LUT_KEYS.map(k => builtinLutStrip(k))

interface Look {
  state: SkyState
  exposure: number
  /** A plaza texel (sRGB 0.45), a character's side facing the key and the side away from it (sRGB 0.6), the fog. */
  plaza: RGB
  lit: RGB
  dark: RGB
  fog: RGB
}

type Kind = WeatherKind | 'clear'

/** The modern sky at solar time `t` (hours / 24) in `kind` weather, shown like the engine shows it. */
function look(hours: number, kind: Kind = 'clear'): Look {
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
  const wet = p.rain
  const frame = { cloud: p.cloud, cloudDark: p.cloudDark, cirrus: p.cirrus, rain: p.rain, fog: p.fog, sun: p.sun, desat: p.desat, windX: 1, windZ: 0, windMs: p.windMs, gustMs: p.windMs, wet, puddle: wet, flash: 0, flashX: 0, flashZ: 1, time: 0 }
  sky.setWeather(toSkyWeather(frame))
  sky.setRetail({ env, t, days: 14.77, declination: 12, profile })
  for (let i = 0; i < 300; i++) sky.update(0.016, null)
  const s = sky.state
  const cal = LIGHT_CALIBRATIONS.modern
  const k = s.keyLight
  const kd = k.dir.clone().normalize()
  const sh = skyStateSH(s)
  const exposure = s.exposure * EXPOSURE_TRIM
  const surf = (nx: number, ny: number, nz: number, albedo: number): RGB => {
    const e = shIrradiance(sh, nx, ny, nz)
    const ndl = Math.max(0, nx * kd.x + ny * kd.y + nz * kd.z)
    return [0, 1, 2].map(c => (albedo * (cal.sun * k.intensity * k.color[c]! * ndl + e[c]! * cal.env) / Math.PI) * exposure) as RGB
  }
  const rw = toRenderWeather(frame)
  const lut = blendStrips(STRIPS, gradeWeights(s.sunElevationDeg, s.t, rw.cloud, rw.rain), new Uint8Array(STRIPS[0]!.length))
  const show = (c: RGB): RGB => {
    const n = LUT_SIZE
    const i = neutral(c).map(v => Math.min(n - 1, Math.max(0, Math.round(enc(v) * (n - 1)))))
    const o = ((i[2]! * n + i[1]!) * n + i[0]!) * 4
    return [lut[o]! / 255, lut[o + 1]! / 255, lut[o + 2]! / 255]
  }
  const h = Math.hypot(kd.x, kd.z) || 1
  return {
    state: s,
    exposure: s.exposure,
    plaza: show(surf(0, 1, 0, dec(0.45))),
    lit: show(surf(kd.x / h, 0, kd.z / h, dec(0.6))),
    dark: show(surf(-kd.x / h, 0, -kd.z / h, dec(0.6))),
    fog: show(s.fogColor.map(dec) as RGB),
  }
}

// ---- (a) dusk --------------------------------------------------------------------------------------------------------

describe('(a) dusk: golden-warm, not pink-red, not black', () => {
  // Engine (WebGPU High, the dragon gate at 18:30): before, the key was (1, 0.18, 0.005) and the plaza (0.178, 0.064,
  // 0.083) = 0.09 sRGB, magenta; after, (0.421, 0.284, 0.190) = 0.31, golden.
  it('keeps the low sun golden: never redder than GOLDEN_KEY, in the key light and the clouds', () => {
    for (const h of [18, 18.5, 18.75]) {
      const c = look(h).state.keyLight.color
      expect(c[1] / c[0], `${h}h G/R`).toBeGreaterThanOrEqual(GOLDEN_KEY[1] - 1e-6)
      expect(c[2] / c[0], `${h}h B/R`).toBeGreaterThanOrEqual(GOLDEN_KEY[2] - 1e-6)
    }
    expect(goldenFloor([1, 0.18, 0.005], GOLDEN_KEY)).toEqual([1, GOLDEN_KEY[1], GOLDEN_KEY[2]])
    expect(goldenFloor([1, 0.9, 0.8], GOLDEN_KEY)).toEqual([1, 0.9, 0.8])
  })

  it('the plaza reads warm (R > G > B) and at least 45 % of noon from 18:00 to 18:30; 18:45 is no darker than a third', () => {
    const noon = lum(look(12).plaza)
    for (const h of [18, 18.5]) {
      const p = look(h).plaza
      expect(p[0], `${h}h`).toBeGreaterThan(p[1])
      expect(p[1], `${h}h`).toBeGreaterThan(p[2])
      expect(lum(p) / noon, `${h}h`).toBeGreaterThan(0.45)
    }
    expect(lum(look(18.75).plaza) / noon).toBeGreaterThan(1 / 3)
  })

  it('the eye adapts around sunset: the twilight exposure peaks near the horizon and is 1 at noon and at night', () => {
    expect(twilightExposure(60)).toBe(1)
    expect(twilightExposure(-20)).toBe(1)
    expect(twilightExposure(0.5)).toBeGreaterThan(1.5)
  })
})

// ---- (b) night -------------------------------------------------------------------------------------------------------

describe('(b) night: moody navy, readable', () => {
  // Engine: the clear night's plaza 0.204 (0.178, 0.205, 0.265) against noon 0.520; a character's back no longer black.
  it('the plaza is navy and well below noon; a character\'s shadowed side stays readable', () => {
    const noon = lum(look(12).plaza)
    const n = look(22)
    expect(n.plaza[2]).toBeGreaterThan(n.plaza[0] * 1.3)
    expect(lum(n.plaza) / noon).toBeLessThan(0.55)
    expect(lum(n.dark)).toBeGreaterThan(0.12)
    expect(lum(n.lit)).toBeGreaterThan(lum(n.dark))
  })

  it('a night storm is darker than a clear night, but characters are not near-black (NIGHT_AMBIENT, STORM_GLOW)', () => {
    // Before: the storm's dark side was 0.059, 13 % of the clear night's light at 1.4× its exposure.
    const clear = look(22)
    const storm = look(22, 'storm')
    expect(lum(storm.plaza)).toBeLessThan(lum(clear.plaza))
    expect(lum(storm.dark)).toBeGreaterThan(0.15)
    expect(lum(storm.lit)).toBeGreaterThan(0.2)
  })
})

// ---- (e) storms ------------------------------------------------------------------------------------------------------

describe('(e) storms: moody, not washed out', () => {
  // Engine: the day storm's far fog wall was 0.29 sRGB (mid band) at exposure 11.1, now 0.22 at 8.8 (× the trim).
  it('by day the exposure rises at most WEATHER_EXPOSURE_GAIN over the clear sky, and the fog is much darker than noon', () => {
    const noon = look(14)
    const storm = look(14, 'storm')
    expect(storm.exposure).toBeLessThanOrEqual(noon.exposure * WEATHER_EXPOSURE_GAIN * 1.05)
    expect(lum(storm.fog)).toBeLessThan(lum(noon.fog) * 0.7)
    expect(lum(storm.plaza)).toBeLessThan(lum(noon.plaza) * 0.6)
  })
})

// ---- (f) full cloud cover ------------------------------------------------------------------------------------------

describe('(f) full cloud cover closes the sky', () => {
  it('the clouds hide the whole sky at full cover (radiance, ambient) and only their share below 0.7', () => {
    expect(cloudSkyWeight(1)).toBeCloseTo(1, 9)
    expect(cloudSkyWeight(0.5)).toBeCloseTo(0.5 * 0.85, 9)
    expect(cloudSkyWeight(0)).toBe(0)
    for (let c = 0; c < 1; c += 0.05) expect(cloudSkyWeight(c + 0.05)).toBeGreaterThanOrEqual(cloudSkyWeight(c))
  })

  it('the dome has the overcast deck in both languages, from cover 0.7 to 0.98, down to the horizon', () => {
    expect(skyFragmentWGSL).toContain('let deck = smoothstep(0.7, 0.98, uniforms.skyCloud0.z) * smoothstep(-0.02, 0.02, dir.y);')
    expect(skyFragmentGLSL).toContain('float deck = smoothstep(0.7, 0.98, skyCloud0.z) * smoothstep(-0.02, 0.02, dir.y);')
    expect(skyFragmentWGSL).not.toMatch(/\bfloat deck\b/)
    expect(skyFragmentGLSL).not.toMatch(/\blet deck\b/)
  })

  it('an overcast sky\'s radiance straight up is the clouds\' grey, not the clear sky\'s blue', () => {
    // L1 radiance up (the SH the IBL and the ambient take their shape from).
    const up = (s: SkyState) => [0, 1, 2].map(c => s.sh![c]! * 0.2820948 + s.sh![3 + c]! * 0.4886025) as RGB
    const clear = up(look(14).state)
    const storm = up(look(14, 'storm').state)
    expect(storm[2] / storm[0]).toBeLessThan((clear[2] / clear[0]) * 0.6)
  })
})

// ---- (g) noon --------------------------------------------------------------------------------------------------------

describe('(g) noon stays within ±10 % of Classic at the plaza', () => {
  // Measured in the engine (WebGPU High, the dragon-gate plaza, sRGB means): Classic 0.544; PBR 0.427 at trim 1
  // (−21 %: the derived terrain relief and AO darkened it since the RND-L calibration), 0.488 at 1.25, 0.521 at 1.4
  // (−4 %); the frame 0.463 against 0.454 and the sky 0.371 against 0.383 at 1.4.
  it('EXPOSURE_TRIM multiplies the calibrated noon white level on screen', () => {
    const s = look(12).state
    const b = lightBalance(s, LIGHT_CALIBRATIONS.modern)
    expect(EXPOSURE_TRIM).toBe(1.4)
    expect(b.white * s.exposure * EXPOSURE_TRIM).toBeGreaterThan(CALIBRATION_TARGET.white * EXPOSURE_TRIM * 0.95)
    expect(b.white * s.exposure * EXPOSURE_TRIM).toBeLessThan(CALIBRATION_TARGET.white * EXPOSURE_TRIM * 1.05)
  })
})

// ---- the highlight overlay -------------------------------------------------------------------------------------------

describe('the highlight overlay (hover / target) on the HDR path', () => {
  it('is the Classic colour at exposure 1 and a linear tint ÷ exposure on the PBR presets (no white silhouette)', () => {
    expect(highlightOverlayColor(HIGHLIGHT_COLOR, 1).asArray()).toEqual(HIGHLIGHT_COLOR.asArray())
    const c = highlightOverlayColor(HIGHLIGHT_COLOR, 8)
    expect(c.r).toBeCloseTo(HIGHLIGHT_LINEAR_K / 8, 9)
    expect(c.g).toBeCloseTo((Math.pow(0.92, 2.2) * HIGHLIGHT_LINEAR_K) / 8, 9)
    // On a black surface, after the post stack's × 8: well under white (was 0.28 × 8 = 2.2 → white).
    expect(c.r * 8 * HIGHLIGHT_ALPHA).toBeLessThan(0.2)
  })

  it('follows the scene\'s exposure while on, and turns off and forgets the mesh', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const box = CreateBox('b', {}, scene)
    const shared = new Color3(1, 1, 1)
    box.overlayColor = shared
    expect(sceneExposure(scene)).toBe(1)
    setHighlightOverlay(box, HIGHLIGHT_COLOR)
    expect(box.renderOverlay).toBe(true)
    expect(box.overlayAlpha).toBe(HIGHLIGHT_ALPHA)
    expect(box.overlayColor).not.toBe(shared) // its own colour: re-scaled in place later
    expect(box.overlayColor.asArray()).toEqual(HIGHLIGHT_COLOR.asArray())
    expect(highlightOverlayCount(scene)).toBe(1)
    setHighlightOverlay(box, null)
    expect(box.renderOverlay).toBe(false)
    expect(highlightOverlayCount(scene)).toBe(0)
    setHighlightOverlay(box, HIGHLIGHT_COLOR)
    box.dispose()
    expect(highlightOverlayCount(scene)).toBe(0)
  })
})

// ---- self-lit retail emissive ----------------------------------------------------------------------------------------

describe('retail emissive on the PBR path (the Event So-Ok NPC, the luxury-house tiger)', () => {
  function sceneWith(): Scene {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    return scene
  }

  it('a character material with emissive 0.59 becomes self-lit, tied to the ambient, and comes back on Classic', () => {
    const scene = sceneWith()
    const part = new PbrSurfaces(scene)
    part.setMode('pbr')
    const mat = new PBRMaterial('chinaetc_kisaeng1', scene)
    mat.emissiveColor.set(0.588, 0.588, 0.588)
    part.decorateCharacterMaterial(mat)
    const plugin = surfacePluginOf(mat)!
    expect(plugin.selfLit).toBe(true)
    expect(part.emissiveCount).toBe(1)
    const s = look(12).state
    scene.environmentIntensity = 0.58
    part.update(null, s)
    const k = 0.588 * EMISSIVE_AMBIENT * 0.58
    expect(mat.emissiveColor.r).toBeCloseTo(k * s.ambient.sky[0], 9)
    expect(mat.emissiveColor.b).toBeCloseTo(k * s.ambient.sky[2], 9)
    // Before: 0.59 scene-linear × the exposure (7.7 × 1.4 by day) = a white figure; now under the ambient term's scale.
    expect(mat.emissiveColor.r * s.exposure * EXPOSURE_TRIM).toBeLessThan(1)
    part.setMode('classic')
    expect(mat.emissiveColor.asArray()).toEqual([0.588, 0.588, 0.588])
    expect(part.emissiveCount).toBe(0)
  })

  it('the surface plugin samples the albedo for the emissive (SRO_SELFLIT) in both languages; black emissive is ignored', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      expect(surfaceFragmentCode(lang).CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toContain('#ifdef SRO_SELFLIT\nfinalEmissive = finalEmissive * surfaceAlbedo;\n#endif')
    }
    const scene = sceneWith()
    const part = new PbrSurfaces(scene)
    part.setMode('pbr')
    const mat = new PBRMaterial('plain', scene)
    const plugin = new SroSurfacePlugin(mat, part.shared, { cls: 'stone' })
    part.addEmissive(mat, plugin, Color3.Black())
    expect(plugin.selfLit).toBe(false)
    expect(part.emissiveCount).toBe(0)
  })

  it('ObjectMaterials registers a world object\'s retail emissive; lamp models keep NL\'s glow, sampled from the albedo', async () => {
    const scene = sceneWith()
    const io: WorldIO = {
      async bytes(url) {
        throw new Error(`404 ${url}`)
      },
      decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) as Uint8Array<ArrayBuffer> }),
    }
    const mats = new ObjectMaterials(scene, new Assets('http://mem.test/out/world/w/', io))
    mats.mode = 'pbr'
    const src = (name: string): PBRMaterial => {
      const m = new PBRMaterial(name, scene)
      const tex: BaseTexture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
      m.albedoTexture = tex
      m.emissiveColor.set(0.588, 0.588, 0.588)
      return m
    }
    const side: SidecarLite = { materials: [{ name: 'tiger', flags: 0, diffuse: [0.6, 0.6, 0.6, 1], ambient: [0.6, 0.6, 0.6, 1] }] }
    const c1 = new AssetContainer(scene)
    c1.materials.push(src('tiger'))
    const o1 = await mats.convert(c1, side, false, { model: 'm/cj_luxury.glb', source: 'res\\bldg\\china\\cj_luxury.bsr', kind: 'static' })
    const tiger = o1.materials[0] as PBRMaterial
    expect(surfacePluginOf(tiger)!.selfLit).toBe(true)
    expect(tiger.emissiveColor.asArray()).toEqual([0, 0, 0]) // until the first update sets it from the ambient
    expect(mats.pbr.emissiveCount).toBe(1)
    const c2 = new AssetContainer(scene)
    c2.materials.push(src('stone'))
    const o2 = await mats.convert(c2, { materials: [{ name: 'stone', flags: 0, diffuse: [0.6, 0.6, 0.6, 1], ambient: [0.6, 0.6, 0.6, 1] }] }, false, {
      model: 'm/cj_stone_light01.glb', source: 'res\\bldg\\china\\cj_stone_light01.bsr', kind: 'static',
    })
    const lamp = o2.materials[0] as PBRMaterial
    expect(surfacePluginOf(lamp)!.selfLit).toBe(true)
    expect(mats.pbr.emissiveCount).toBe(1) // NL drives the lamp's emissive colour, not the ambient
    mats.release(o1)
    expect(mats.pbr.emissiveCount).toBe(0)
  })
})

// ---- rain ------------------------------------------------------------------------------------------------------------

describe('rain: slanted streaks, no white blocks, small splash crowns', () => {
  it('the curtain draws thin columns (≤ 0.25 m at its radius) that lean with the wind, with a sine-free hash', () => {
    expect((2 * Math.PI * CURTAIN_RADIUS_M) / CURTAIN_COLUMNS[0]).toBeLessThan(0.25)
    const s = RAIN_SHADERS.sroCurtain
    expect(s.fragmentWGSL).toContain('let lean = (uniforms.curP0.z * cos(ang) - uniforms.curP0.y * sin(ang)) / max(uniforms.curP0.x, 1.0);')
    expect(s.fragmentGLSL).toContain('float lean = (curP0.z * cos(ang) - curP0.y * sin(ang)) / max(curP0.x, 1.0);')
    for (const src of [s.fragmentWGSL, s.fragmentGLSL]) {
      expect(src).toContain('pow(w, 6.0)')
      expect(src).not.toContain('sin(n * 12.9898)')
    }
  })

  it('streaks next to the camera fade out, and splashes are small crowns of droplets, never discs', () => {
    expect(RAIN_NEAR_M[0]).toBeGreaterThanOrEqual(1.5)
    for (const src of [RAIN_SHADERS.sroRain.vertexWGSL, RAIN_SHADERS.sroRain.vertexGLSL]) expect(src).toContain('smoothstep(1.5, 4.0, d)')
    // RAIN-P (wave 12): the W9 LOOK rings (4–10 cm at 0.15) could not be seen from the game camera. A crown's rim stays
    // under 12 cm (the largest drop: radius × 1.25), its droplets under 3 cm, the sprite at most 0.6 m, and only the
    // droplets draw (the white discs of W9 never come back): opacity ≤ 0.75, colour ≤ 1.5 × the streaks'.
    expect(SPLASH_CROWN_M[1] * 1.25).toBeLessThan(0.12)
    expect(SPLASH_CROWN_M[1] * 1.25 * 0.25).toBeLessThan(0.03)
    expect(SPLASH_HALF_M * 2).toBeLessThanOrEqual(0.6)
    expect(SPLASH_ALPHA).toBeLessThanOrEqual(0.75)
    expect(SPLASH_BRIGHT).toBeLessThanOrEqual(1.5)
    expect(RAIN_ALPHA).toBeLessThan(0.3)
    expect(RAIN_SHADERS.sroSplash.fragmentWGSL).toContain('let rd0 = r0 * 0.25 * (1.0 - 0.5 * pc);')
    expect(RAIN_SHADERS.sroSplash.fragmentGLSL).toContain('float rd0 = r0 * 0.25 * (1.0 - 0.5 * pc);')
  })

  it('the modern sky\'s streaks take the fog\'s brightness: a night storm\'s rain is not 5× the ground', () => {
    const fog = look(22, 'storm').state.fogColor
    const g = lum(fog)
    const c = fog.map(v => Math.min(1, (v + (g - v) * RAIN_GREY) * RAIN_LIFT + RAIN_FLOOR))
    expect(lum(c as RGB)).toBeLessThan(0.45)
    expect(lum(c as RGB)).toBeGreaterThan(lum(fog))
  })
})

// ---- (c) the wet reflection ------------------------------------------------------------------------------------------

describe('(c) a soaked surface\'s sky reflection is tied to its own light', () => {
  it('caps the IBL radiance of wet and puddled surfaces at WET_REFLECT_MAX × the light they receive, in both languages', () => {
    expect(WET_REFLECT_MAX).toBeGreaterThan(0)
    expect(WET_REFLECT_MAX).toBeLessThanOrEqual(1)
    const k = WET_REFLECT_MAX.toFixed(2)
    const wgsl = surfaceFragmentCode('wgsl').CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION!
    const glsl = surfaceFragmentCode('glsl').CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION!
    for (const src of [wgsl, glsl]) {
      expect(src).toContain('#if defined(SRO_WET) && defined(REFLECTION) && !defined(UNLIT)')
      expect(src).toContain(`* ${k} / max(sroRefl, 1e-6)`)
      expect(src).toContain('finalRadianceScaled = finalRadianceScaled * mix(1.0, sroK, clamp(max(sroWetW, sroPuddle), 0.0, 1.0));')
    }
    expect(wgsl).toContain('(finalIrradiance + finalDiffuse) / max(surfaceAlbedo, vec3f(0.02))')
    expect(glsl).toContain('(finalIrradiance + finalDiffuse) / max(surfaceAlbedo, vec3(0.02))')
  })
})

// ---- puddles ---------------------------------------------------------------------------------------------------------

describe('puddle noise', () => {
  it('the surface plugin\'s hash is sine-free in both languages (WebGPU drew striped puddle patches)', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const defs = surfaceFragmentCode(lang).CUSTOM_FRAGMENT_DEFINITIONS!
      const hash = defs.slice(defs.indexOf('sroHash('), defs.indexOf('sroNoise('))
      expect(hash).toContain('0.1031')
      expect(hash).not.toContain('sin(')
    }
  })

  it('the terrain plugin\'s puddle hash is sine-free too (I9A, the LOOK hand-off)', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const all = Object.values(terrainPluginCode(lang)).join('\n')
      const hash = all.slice(all.indexOf(lang === 'wgsl' ? 'fn sroHash(' : 'float sroHash('), all.indexOf(lang === 'wgsl' ? 'fn sroNoise(' : 'float sroNoise('))
      expect(hash).toContain('0.1031')
      expect(hash).not.toContain('sin(')
    }
  })
})
