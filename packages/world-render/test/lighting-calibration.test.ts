/**
 * RND-L's calibration (docs/RENDER.md §4.1, docs/WAVE_PLAN3.md §2.5, §6.12): at a clear noon in Jangan the direct : sky
 * ratio on a horizontal surface is 5 : 1, and a plaza texel lands near its Classic brightness after Neutral tone
 * mapping. Checked on a fixed retail noon (the classic sky), on the live classic SkySystem, and on SKY-B's modern
 * SkySystem when it is present (its units differ: the second calibration regime). The modern check prints the
 * numbers the gate compares after the merge.
 */
import { NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvValues, RGB } from '../src/environment.ts'
import {
  CALIBRATION_TARGET,
  LIGHT_CALIBRATIONS,
  calibrateLight,
  lightBalance,
} from '../src/render/lighting.ts'
import { weatherParams } from '../../shared/src/weather.ts'
import { SkySystem } from '../src/sky/sky-system.ts'
import { CLEAR_SKY_WEATHER, SKY_PRESETS, type SkyState, type SkyWeather } from '../src/sky/types.ts'
import { toSkyWeather } from '../src/weather/adapters.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** Jangan profile 0 at t = 0.5 (work/out/world/jangan/environment.json, evaluateProfile). */
const NOON: EnvValues = {
  sun: [1, 1, 1], skyTop: [0.169, 0.572, 0.943], skyBottom: [0.768, 0.969, 0.993], diffuse: [0.776, 0.772, 0.767],
  objectAmbient: [0.792, 0.791, 0.783], scatter: [1, 1, 1], terrainShadow: [0.07, 0.07, 0.071], fogColor: [0.357, 0.58, 0.677],
  water: [0.36, 0.69, 0.62], g7: -0.76, g8: -1, g10: 0.76, g11: 1,
}
/** The sun at Jangan's noon (latitude 34.3° N, declination +12°: elevation 67.7°, due south = glTF +z). */
const NOON_SUN = new Vector3(0, Math.sin((67.7 * Math.PI) / 180), Math.cos((67.7 * Math.PI) / 180))

/** The classic sky's noon state (the retail palette: key = Diffuse × 0.6, ambient = ObjectAmbient, exposure 1). */
function retailNoon(): SkyState {
  const e = NOON
  return {
    keyLight: { dir: NOON_SUN.clone(), color: [e.diffuse[0] * 0.6, e.diffuse[1] * 0.6, e.diffuse[2] * 0.6], intensity: 1 },
    ambient: { sky: [...e.objectAmbient] as RGB, horizon: [...e.skyBottom] as RGB, ground: e.objectAmbient.map(v => v * 0.25) as RGB },
    sh: null,
    exposure: 1,
    night: 0,
    env: e,
  } as unknown as SkyState
}

// KHR PBR Neutral (Babylon's TONEMAPPING_KHR_PBR_NEUTRAL) and the sRGB curves.
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
const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const srgbEncode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)

/** A grey albedo texel t on screen: PBR (white-surface outgoing × exposure, Neutral) and Classic (2 t L × lightmap). */
function pbrDisplay(t: number, whiteTimesExposure: number): number {
  return srgbEncode(neutral([srgbDecode(t) * whiteTimesExposure, srgbDecode(t) * whiteTimesExposure, srgbDecode(t) * whiteTimesExposure])[0])
}
function classicDisplay(t: number, env: EnvValues): number {
  // TERRAIN.md §3.2: L = saturate(0.588 · Diffuse · 0.6 · N·L + 0.588 · ObjectAmbient), N·L = 0.707 for a floor under
  // the retail (1, 1, 0) light; MODULATE2X; a sunlit object lightmap texel ~0.95 (TERRAIN.md §3.3 p95 0.9–1.0).
  const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  const L = Math.min(1, 0.588 * lum(env.diffuse) * 0.6 * Math.SQRT1_2 + 0.588 * lum(env.objectAmbient))
  return Math.min(1, 2 * t * L) * 0.95
}

function liveSky(style: 'classic' | 'modern', weather: SkyWeather = CLEAR_SKY_WEATHER): SkySystem {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const sky = new SkySystem(scene, NOON, { style, quality: SKY_PRESETS.high })
  cleanups.push(() => {
    sky.dispose()
    scene.dispose()
    engine.dispose()
  })
  sky.setWeather(weather)
  sky.setRetail({ env: NOON, t: 0.5, days: 14.77, declination: 12, profile: null })
  for (let i = 0; i < 240; i++) sky.update(0.016, null)
  return sky
}

describe('the classic regime (retail palette; the classic sky, and the sky skeleton)', () => {
  it('gives 5 : 1 direct : sky on a horizontal surface at a clear noon, and the target white level', () => {
    const b = lightBalance(retailNoon(), LIGHT_CALIBRATIONS.classic)
    expect(b.ratio).toBeGreaterThan(5 * 0.98)
    expect(b.ratio).toBeLessThan(5 * 1.02)
    expect(b.white).toBeGreaterThan(CALIBRATION_TARGET.white * 0.98)
    expect(b.white).toBeLessThan(CALIBRATION_TARGET.white * 1.02)
  })

  it('LIGHT_CALIBRATIONS.classic is calibrateLight of that noon (within 1 %)', () => {
    const c = calibrateLight(retailNoon(), 1)
    const k = LIGHT_CALIBRATIONS.classic
    for (const key of ['sun', 'env', 'cube', 'flashAmbient', 'flashSun'] as const) expect(Math.abs(c[key] - k[key]) / k[key], key).toBeLessThan(0.01)
  })

  it('puts a plaza texel near its Classic brightness after Neutral tone mapping', () => {
    // The white level was set in the engine (the RND-L harness: Classic plaza 0.544, PBR 0.54 at white 2.15), where
    // the PBR surface plugin keeps part of the light back (lightmap AO share, Fresnel). This bare-albedo model with no
    // such losses therefore sits a little above Classic: it must stay within +15 %, and the darks within the toe.
    const w = lightBalance(retailNoon(), LIGHT_CALIBRATIONS.classic).white * 1 // exposure 1
    const mid = pbrDisplay(0.45, w) / classicDisplay(0.45, NOON)
    expect(mid).toBeGreaterThan(1)
    expect(mid).toBeLessThan(1.15)
    expect(pbrDisplay(0.3, w) / classicDisplay(0.3, NOON)).toBeGreaterThan(0.9)
    expect(pbrDisplay(0.6, w) / classicDisplay(0.6, NOON)).toBeLessThan(1.15)
  })

  it('the live classic SkySystem states the same noon (5 : 1 within 5 %)', () => {
    const s = liveSky('classic').state
    const b = lightBalance(s, LIGHT_CALIBRATIONS.classic)
    expect(b.ratio).toBeGreaterThan(4.75)
    expect(b.ratio).toBeLessThan(5.25)
  })
})

describe('the modern regime (SKY-B: physical light in keyLight units)', () => {
  // SKY-B's SkySystem has `radiance()`; the step-0 skeleton does not (then the gate re-checks this after the merge).
  const hasModern = typeof (SkySystem.prototype as unknown as { radiance?: unknown }).radiance === 'function'

  // Gate 1 re-check against the merged SKY-B state (key 0.4315, ambient.sky 0.0517 0.0803 0.1554, exposure 7.734):
  // ratio 5.00 and white × exposure 2.150, so LIGHT_CALIBRATIONS.modern stands. The band is now ± 5 %: a sky change
  // that moves the clear noon further fails here, and the printed `calibrateLight` is the new constant set.
  it.skipIf(!hasModern)('LIGHT_CALIBRATIONS.modern gives the clear noon 5 : 1 and the target white level (± 5 %) and prints the re-derivation', async () => {
    const mod = (await import('../src/sky/sky-system.ts')) as Record<string, unknown>
    const ldrPerLut = typeof mod.SKY_LDR_PER_LUT === 'number' ? mod.SKY_LDR_PER_LUT : 0.492
    const s = liveSky('modern').state
    const b = lightBalance(s, LIGHT_CALIBRATIONS.modern)
    const boost = typeof mod.AMBIENT_BOOST === 'number' ? mod.AMBIENT_BOOST : 2.5
    const c = calibrateLight(s, 1 / (ldrPerLut * boost))
    // The cube in the dome's units (D1): radiance() carries AMBIENT_BOOST, the dome does not.
    expect(LIGHT_CALIBRATIONS.modern.cube).toBeCloseTo(c.cube, 1)
    console.info(`[RND-L calibration] modern clear noon: key ${(s.keyLight.intensity).toFixed(4)} ambient.sky ${s.ambient.sky.map(v => v.toFixed(4)).join(' ')} exposure ${s.exposure.toFixed(3)} → ratio ${b.ratio.toFixed(2)} (target 5) white×exp ${(b.white * s.exposure).toFixed(3)} (target ${CALIBRATION_TARGET.white}); calibrateLight ${JSON.stringify(c)}`)
    expect(b.ratio).toBeGreaterThan(5 * 0.95)
    expect(b.ratio).toBeLessThan(5 * 1.05)
    expect(b.white * s.exposure).toBeGreaterThan(CALIBRATION_TARGET.white * 0.95)
    expect(b.white * s.exposure).toBeLessThan(CALIBRATION_TARGET.white * 1.05)
  })

  it.skipIf(!hasModern)('overcast and rain flatten the light (RENDER §4.1: toward 1.5 and 1)', () => {
    const at = (kind: 'overcast' | 'rain' | 'storm') => {
      const p = weatherParams(kind)
      return toSkyWeather({
        cloud: p.cloud, cloudDark: p.cloudDark, cirrus: p.cirrus, rain: p.rain, fog: p.fog, sun: p.sun, desat: p.desat,
        windX: 1, windZ: 0, windMs: p.windMs, gustMs: p.windMs, wet: p.rain, puddle: p.rain, flash: 0, flashX: 0, flashZ: 1, time: 0,
      })
    }
    const clear = lightBalance(liveSky('modern').state, LIGHT_CALIBRATIONS.modern).ratio
    const overcast = lightBalance(liveSky('modern', at('overcast')).state, LIGHT_CALIBRATIONS.modern).ratio
    const rain = lightBalance(liveSky('modern', at('rain')).state, LIGHT_CALIBRATIONS.modern).ratio
    console.info(`[RND-L calibration] modern noon ratio: clear ${clear.toFixed(2)}, overcast ${overcast.toFixed(2)}, rain ${rain.toFixed(2)} (RENDER §4.1 targets 5, 1.5, 1)`)
    expect(overcast).toBeLessThan(clear * 0.6)
    expect(rain).toBeLessThan(clear * 0.6)
  })
})
