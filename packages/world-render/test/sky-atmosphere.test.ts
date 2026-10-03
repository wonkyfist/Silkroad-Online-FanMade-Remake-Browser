/**
 * SKY-B's atmosphere (docs/SKY.md §3, docs/WAVE_PLAN3.md §6.6): the transmittance LUT against a direct integration,
 * the sun colour table and its monotonic fall below 1° (the Bruneton mapping fix), the sky-view and irradiance
 * reference points of the prototype, sliced builds equal whole ones, the half-float packing, and the calibration
 * constants the sky system and its consumers use.
 */
import { FromHalfFloat, ToHalfFloat } from '@babylonjs/core/Misc/halfFloat.js'
import { NullEngine, Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Atmosphere,
  CAMERA_KM,
  R_GROUND,
  TRANS_H,
  TRANS_W,
  elevationToV,
  luminance,
  opticalDepth,
  sampleSkyView,
  sampleTransmittance,
  skyIrradianceUp,
  vToElevation,
} from '../src/sky/atmosphere.ts'
import { SkyViewLut, fromHalf, packRowsHalf, toHalf } from '../src/sky/sky-luts.ts'
import { SKY_EXPOSURE_REF, SKY_LDR_PER_LUT, SKY_PRESETS, lutRowsPerFrame } from '../src/index.ts'

const DEG = Math.PI / 180
const atm = Atmosphere.build(1)
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9)

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

describe('transmittance (Bruneton mapping)', () => {
  it('matches a direct optical-depth integration within 2% at the reference points', () => {
    const points: Array<[number, number]> = [[0.5, Math.sin(66 * DEG)], [0.5, Math.sin(30 * DEG)], [0.5, Math.sin(10 * DEG)], [0.5, Math.sin(5 * DEG)],
      [0.5, Math.sin(2 * DEG)], [0.5, Math.sin(0.5 * DEG)], [1.8, 0.02], [16, -0.05], [40, -0.1], [5, 0.3]]
    for (const [h, mu] of points) {
      const r = R_GROUND + h
      const ref = opticalDepth(r, mu, 1, 800).map(v => Math.exp(-v))
      const lut = sampleTransmittance(atm.transmittance, r, mu, [0, 0, 0])
      // The green channel carries the luminance; blue near the horizon is ~0 and compared absolutely.
      expect(rel(lut[1], ref[1]!), `h ${h} mu ${mu} green`).toBeLessThan(0.02)
      expect(rel(lut[0], ref[0]!), `h ${h} mu ${mu} red`).toBeLessThan(0.02)
      expect(Math.abs(lut[2] - ref[2]!), `h ${h} mu ${mu} blue`).toBeLessThan(Math.max(0.02 * ref[2]!, 5e-4))
    }
    expect(atm.transmittance.length).toBe(TRANS_W * TRANS_H * 3)
  })

  it('reproduces the sun colour table of SKY §3.3 and falls monotonically to the horizon', () => {
    const chroma = (deg: number) => {
      const t = atm.sunTransmittance(deg * DEG)
      const m = Math.max(...t)
      return t.map(v => v / m)
    }
    const table: Array<[number, number[]]> = [[66, [1, 0.92, 0.81]], [45, [1, 0.9, 0.76]], [30, [1, 0.86, 0.68]], [20, [1, 0.8, 0.57]], [10, [1, 0.66, 0.34]], [5, [1, 0.48, 0.14]], [2, [1, 0.29, 0.03]]]
    for (const [deg, want] of table) {
      const got = chroma(deg)
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - want[c]!), `${deg}° channel ${c}`).toBeLessThan(0.02)
    }
    // Luminance vs noon: 1, 0.60 at 10°, 0.17 at 2°.
    const noon = luminance(atm.sunTransmittance(66 * DEG))
    expect(luminance(atm.sunTransmittance(10 * DEG)) / noon).toBeCloseTo(0.6, 1)
    expect(luminance(atm.sunTransmittance(2 * DEG)) / noon).toBeCloseTo(0.17, 1)
    // The prototype's linear-μ LUT turned bluer again at 0.5° (1 .43 .18); now green and blue only fall.
    let g = Infinity, b = Infinity
    for (let d = 6; d >= 0; d -= 0.125) {
      const c = chroma(d)
      expect(c[1]!, `${d}°`).toBeLessThanOrEqual(g + 1e-6)
      expect(c[2]!, `${d}°`).toBeLessThanOrEqual(b + 1e-6)
      g = c[1]!
      b = c[2]!
    }
    // Below the horizon the planet's shadow: no direct sun.
    expect(luminance(atm.sunTransmittance(-2 * DEG))).toBe(0)
  })
})

describe('sky-view LUT', () => {
  const W = 96, H = 48
  it('the elevation packing round-trips and puts the horizon at v = 0.5', () => {
    for (const el of [-1.2, -0.3, -0.01, 0, 0.01, 0.2, 1.5]) expect(vToElevation(elevationToV(el))).toBeCloseTo(el, 9)
    expect(elevationToV(0)).toBe(0.5)
  })

  it('matches the prototype reference points (SKY §3.3, 2-decimal table) and the noon irradiance within 2%', () => {
    const noon = atm.skyView(W, H, 66 * DEG, 24)
    const at = (lut: Float32Array, az: number, el: number, e: number) => sampleSkyView(lut, W, H, az, el, [0, 0, 0]).map(v => v * e)
    const close = (got: number[], want: number[]) => {
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - want[c]!), `${got} vs ${want}`).toBeLessThan(Math.max(0.006, 0.03 * want[c]!))
    }
    close(at(noon, 0, 0.003, 8), [0.41, 0.55, 0.66])
    close(at(noon, Math.PI, 0.003, 8), [0.39, 0.53, 0.66])
    close(at(noon, 0, Math.PI / 2 - 0.01, 8), [0.05, 0.09, 0.21])
    const irr = skyIrradianceUp(noon, W, H)
    const want = [0.021, 0.044, 0.104]
    for (let c = 0; c < 3; c++) expect(rel(irr[c], want[c]!)).toBeLessThan(0.02)
    // Sunrise: orange toward the sun, the pink anti-sun belt.
    const rise = atm.skyView(W, H, 2 * DEG, 24)
    const toward = at(rise, 0, 0.003, 14)
    const anti = at(rise, Math.PI, 0.003, 14)
    expect(toward[0]!).toBeGreaterThan(3 * toward[2]!)
    expect(anti[0]!).toBeGreaterThan(anti[1]!)
    expect(anti[0]!).toBeGreaterThan(anti[2]!)
  })

  it('a sliced build equals the whole one, and the sliced atmosphere equals the whole one', () => {
    const lut = new SkyViewLut(W, H, 'test')
    lut.start(atm, 12 * DEG, 16)
    let frames = 0
    while (!lut.step(lutRowsPerFrame(SKY_PRESETS.medium))) frames++
    expect(frames + 1).toBe(Math.ceil(H / 4))
    const whole = atm.skyView(W, H, 12 * DEG, 16)
    expect(Array.from(lut.rgb)).toEqual(Array.from(whole))
    const other = new SkyViewLut(W, H, 'test2')
    other.buildNow(atm, 12 * DEG, 16)
    expect(Array.from(other.rgb)).toEqual(Array.from(whole))

    const job = Atmosphere.sliced(1)
    let steps = 0
    let r = job.next()
    while (!r.done) {
      steps++
      r = job.next()
    }
    expect(steps).toBe(40)
    expect(Array.from(r.value.transmittance)).toEqual(Array.from(atm.transmittance))
    expect(Array.from(r.value.multiScatter)).toEqual(Array.from(atm.multiScatter))
  })

  it('uploads once per finished build (RGBA16F), never a half-built LUT', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const lut = new SkyViewLut(8, 6, 'up')
    const tex = lut.ensureTexture(scene)
    expect(tex.textureType).toBe(2) // TEXTURETYPE_HALF_FLOAT
    const updates: Uint16Array[] = []
    tex.update = (data: ArrayBufferView) => void updates.push(new Uint16Array((data as Uint16Array).slice()))
    lut.start(atm, 30 * DEG, 12)
    expect(lut.step(2)).toBe(false)
    expect(lut.step(2)).toBe(false)
    expect(updates.length).toBe(0)
    expect(lut.step(2)).toBe(true)
    expect(updates.length).toBe(1)
    const want = new Uint16Array(8 * 6 * 4)
    packRowsHalf(atm.skyView(8, 6, 30 * DEG, 12), want, 8, 0, 6)
    expect(Array.from(updates[0]!)).toEqual(Array.from(want))
    lut.dispose()
  })
})

describe('half floats', () => {
  it('toHalf matches Babylon ToHalfFloat and round-trips within half precision', () => {
    const values = [0, 1, -1, 0.5, 1e-3, 3.1e-5, 6e-8, 1e-9, 0.1, 0.333, 2.5, 100, 1234.5, 65504, 70000, -0.02, 0.00610351, 5.96e-8]
    for (let i = 0; i < 400; i++) values.push(Math.pow(10, -6 + (i / 400) * 10) * (i % 3 === 0 ? -1 : 1))
    for (const v of values) {
      const h = toHalf(v)
      const babylon = ToHalfFloat(v)
      // Babylon truncates some mantissas where we round to nearest: at most one unit apart.
      expect(Math.abs(h - babylon), `${v}`).toBeLessThanOrEqual(1)
      expect(fromHalf(h)).toBe(FromHalfFloat(h))
      const back = fromHalf(h)
      if (Math.abs(v) >= 6.2e-5 && Math.abs(v) <= 65504) expect(rel(back, v), `${v}`).toBeLessThanOrEqual(2 ** -11)
    }
    expect(fromHalf(toHalf(70000))).toBe(Infinity)
    expect(Number.isNaN(fromHalf(toHalf(NaN)))).toBe(true)
  })
})

describe('calibration constants', () => {
  it('SKY_LDR_PER_LUT = 0.43 / lum(T(66°)); SKY_EXPOSURE_REF = lum(noon irradiance + key × 0.3)', () => {
    const t66 = luminance(atm.sunTransmittance(66 * DEG, CAMERA_KM))
    expect(rel(SKY_LDR_PER_LUT, 0.43 / t66)).toBeLessThan(0.01)
    const irr = skyIrradianceUp(atm.skyView(96, 48, 66 * DEG, 24), 96, 48)
    expect(rel(SKY_EXPOSURE_REF, luminance(irr) + t66 * 0.3)).toBeLessThan(0.02)
  })

  it('rows per frame per preset: Low 2, Medium 4, High 6, Ultra 12', () => {
    expect((['low', 'medium', 'high', 'ultra'] as const).map(p => lutRowsPerFrame(SKY_PRESETS[p]))).toEqual([2, 4, 6, 12])
  })
})
