/**
 * The Classic weather multipliers on the retail palette (docs/WEATHER.md §7.1): identity at clear (the same object,
 * the Low guard), the table values at storm and fog, the lightning lift, and the terrain light (overcast brightness and
 * baked-shadow contrast).
 */
import { describe, expect, it } from 'vitest'
import { weatherParams, type WeatherKind } from '../../shared/src/weather.ts'
import { CLEAR_FRAME, applyWeatherToEnv, envWeatherTerms, terrainWeatherLight, weatherFogScale, type EnvValues, type WeatherFrame } from '../src/index.ts'

const ENV: EnvValues = {
  sun: [1, 0.95, 0.9], skyTop: [0.3, 0.5, 0.9], skyBottom: [0.7, 0.8, 0.95], diffuse: [1, 0.96, 0.9],
  objectAmbient: [0.5, 0.45, 0.4], scatter: [0.2, 0.2, 0.2], terrainShadow: [0.3, 0.3, 0.35], fogColor: [0.8, 0.85, 0.9],
  water: [0.2, 0.4, 0.5], g7: 0.3, g8: 0.6, g10: 0.76, g11: 1,
}
const grey = (c: readonly number[]) => 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!

function frame(kind: WeatherKind, flash = 0): WeatherFrame {
  const p = weatherParams(kind)
  return {
    cloud: p.cloud, cloudDark: p.cloudDark, cirrus: p.cirrus, rain: p.rain, fog: p.fog, sun: p.sun, desat: p.desat,
    windX: 1, windZ: 0, windMs: p.windMs, gustMs: p.windMs, wet: 0, puddle: 0, flash, flashX: 0, flashZ: 1, time: 0,
  }
}

describe('applyWeatherToEnv (WEATHER §7.1)', () => {
  it('is the identity at clear: the same object, no terms', () => {
    expect(applyWeatherToEnv(ENV, CLEAR_FRAME)).toBe(ENV)
    expect(applyWeatherToEnv(ENV, frame('clear'))).toBe(ENV)
    expect(envWeatherTerms(CLEAR_FRAME)).toBeNull()
    expect(terrainWeatherLight(CLEAR_FRAME)).toEqual({ brightness: 1, contrast: 1 })
  })

  it('storm: the table values', () => {
    const f = frame('storm')
    const e = applyWeatherToEnv(ENV, f)
    expect(e).not.toBe(ENV)
    const c = (f.cloud - 0.1) / 0.9, d = f.cloudDark
    // Fog colour: mix(fog, grey × 0.85, 0.8 d) × mix(1, 0.7, d).
    for (let i = 0; i < 3; i++) {
      const fog = ENV.fogColor[i]! + (grey(ENV.fogColor) * 0.85 - ENV.fogColor[i]!) * 0.8 * d
      expect(e.fogColor[i]).toBeCloseTo(fog * (1 - 0.3 * d), 9)
      const sky = ENV.skyTop[i]! + (grey(ENV.skyBottom) * 0.9 - ENV.skyTop[i]!) * 0.9 * c
      expect(e.skyTop[i]).toBeCloseTo(sky * (1 - 0.45 * d), 9)
      expect(e.diffuse[i]).toBeCloseTo(ENV.diffuse[i]! * f.sun, 9)
      const amb = ENV.objectAmbient[i]! + (grey(ENV.objectAmbient) - ENV.objectAmbient[i]!) * 0.5 * c
      expect(e.objectAmbient[i]).toBeCloseTo(amb * (1 - 0.2 * d), 9)
      const w = ENV.water[i]! + (grey(ENV.water) - ENV.water[i]!) * 0.2 * c
      expect(e.water[i]).toBeCloseTo(w * (1 - 0.28 * d), 9)
    }
    // Untouched fields are copied.
    expect([e.g10, e.g11, e.terrainShadow]).toEqual([ENV.g10, ENV.g11, ENV.terrainShadow])
    // The sky is darker and greyer, the object sun much weaker.
    expect(grey(e.skyTop)).toBeLessThan(grey(ENV.skyTop))
    expect(e.diffuse[0]).toBeLessThan(0.2)
    // Storm visibility at Jangan noon: 250 m → ≈ 130 m.
    expect(250 * weatherFogScale(f).end).toBeGreaterThan(115)
    expect(250 * weatherFogScale(f).end).toBeLessThan(145)
    expect(terrainWeatherLight(f)).toEqual({ brightness: 1 - 0.28 * d, contrast: f.sun })
  })

  it('fog: grey, the fog closes in to about 110 m', () => {
    const f = frame('fog')
    const e = applyWeatherToEnv(ENV, f)
    const c = (f.cloud - 0.1) / 0.9
    expect(e.skyBottom[2]).toBeCloseTo((ENV.skyBottom[2]! + (grey(ENV.skyBottom) * 0.9 - ENV.skyBottom[2]!) * 0.9 * c) * (1 - 0.45 * f.cloudDark), 9)
    expect(250 * weatherFogScale(f).end).toBeGreaterThan(95)
    expect(250 * weatherFogScale(f).end).toBeLessThan(125)
    expect(weatherFogScale(f).start).toBeLessThan(weatherFogScale(f).end)
  })

  it('lightning lifts the sky and the object ambient, even in a clear sky', () => {
    const f = { ...CLEAR_FRAME, flash: 3 }
    const e = applyWeatherToEnv(ENV, f)
    expect(e.skyTop[2]).toBeCloseTo(ENV.skyTop[2]! + 0.8 * 3, 9)
    expect(e.objectAmbient[0]).toBeCloseTo(ENV.objectAmbient[0]! + 0.35 * 3, 9)
    expect(e.fogColor).toEqual(ENV.fogColor)
  })

  it('reuses one output object (no per-frame allocation) and never touches the input', () => {
    const before = JSON.stringify(ENV)
    const a = applyWeatherToEnv(ENV, frame('rain'))
    const b = applyWeatherToEnv(ENV, frame('overcast'))
    expect(a).toBe(b)
    expect(JSON.stringify(ENV)).toBe(before)
  })
})
