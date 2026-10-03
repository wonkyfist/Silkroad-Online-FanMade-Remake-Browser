/**
 * CST-O, the spectrum (docs/COAST.md §8.3, §8.7, §12.4): JONSWAP, TMA and the cos-2s spread against analytic values;
 * the cascade bands; the Hs clamp; a wind change grows the same sea (fixed Gaussians, same phases); the rounded
 * frequencies make t = 0 and t = 3,600 s the same surface.
 */
import { describe, expect, it } from 'vitest'
import { WaveTile } from '../src/ocean/fft-core.ts'
import {
  GRAVITY,
  GPU_TILES_M,
  HS_MAX_M,
  OMEGA_QUANTUM,
  WORKER_TILES_M,
  buildH0,
  cascadesFor,
  dispersion,
  dispersionDerivative,
  gaussianPair,
  jonswap,
  jonswapPeak,
  lnGamma,
  roundOmega,
  significantHeight,
  spread,
  spreadExponent,
  tma,
  type SpectrumParams,
} from '../src/ocean/spectrum.ts'
import { seaParams } from '../src/ocean/weather.ts'

/** A breezy clear day (7 m/s, no storm): the swell and a small wind sea. */
const calm: SpectrumParams = seaParams({ windMs: 7, windDirRad: 0, storm: 0, swellFromDeg: 150 })

function integrate(f: (x: number) => number, a: number, b: number, n = 20000): number {
  const h = (b - a) / n
  let s = 0.5 * (f(a) + f(b))
  for (let i = 1; i < n; i++) s += f(a + i * h)
  return s * h
}

describe('the spectrum (COAST §8.3)', () => {
  it('JONSWAP: α and ωp follow the fetch laws, and with γ = 1 the variance is α g² / (5 ωp⁴) (Pierson–Moskowitz form)', () => {
    const { alpha, omegaP } = jonswapPeak(10, 100_000)
    expect(alpha).toBeCloseTo(0.076 * Math.pow(100 / (100_000 * GRAVITY), 0.22), 10)
    expect(omegaP).toBeCloseTo(22 * Math.pow((GRAVITY * GRAVITY) / (10 * 100_000), 1 / 3), 10)
    expect(alpha).toBeCloseTo(0.01006, 4)
    expect(omegaP).toBeCloseTo(1.008, 2)
    const m0 = integrate(w => jonswap(w, alpha, omegaP, 1), 0.05, 40)
    expect(m0 / ((alpha * GRAVITY * GRAVITY) / (5 * omegaP ** 4))).toBeCloseTo(1, 3)
    // γ = 3.3 lifts the peak by γ exactly at ωp.
    expect(jonswap(omegaP, alpha, omegaP, 3.3) / jonswap(omegaP, alpha, omegaP, 1)).toBeCloseTo(3.3, 6)
  })

  it('TMA: Φ = ½ωh² below 1, 1 − ½(2 − ωh)² up to 2, 1 beyond (deep water leaves the spectrum alone)', () => {
    const h = 10
    const at = (wh: number) => wh / Math.sqrt(h / GRAVITY)
    expect(tma(at(0.5), h)).toBeCloseTo(0.125, 10)
    expect(tma(at(1.5), h)).toBeCloseTo(0.875, 10)
    expect(tma(at(3), h)).toBe(1)
  })

  it('dispersion: deep water ω = √(gk); dω/dk matches a finite difference; ω rounds to the 2π/3600 quantum', () => {
    expect(dispersion(0.1, 1000)).toBeCloseTo(Math.sqrt(GRAVITY * 0.1), 8)
    for (const [k, h] of [[0.05, 4], [0.5, 30], [2, 100]] as const) {
      const fd = (dispersion(k + 1e-6, h) - dispersion(k - 1e-6, h)) / 2e-6
      expect(dispersionDerivative(k, h)).toBeCloseTo(fd, 5)
    }
    const w = roundOmega(1.2345)
    expect(Math.abs(w - 1.2345)).toBeLessThanOrEqual(OMEGA_QUANTUM / 2 + 1e-12)
    expect(Math.abs(w / OMEGA_QUANTUM - Math.round(w / OMEGA_QUANTUM))).toBeLessThan(1e-9)
  })

  it('the cos-2s spread is normalised for every exponent, peaks along the wind, and 1/π at 0 for s = 1', () => {
    expect(Math.exp(lnGamma(5))).toBeCloseTo(24, 8)
    expect(Math.exp(lnGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 8)
    for (const s of [0.5, 1, 4, 20, 120]) expect(integrate(t => spread(t, s), -Math.PI, Math.PI)).toBeCloseTo(1, 4)
    expect(spread(0, 1)).toBeCloseTo(1 / Math.PI, 8)
    expect(spread(0, 10)).toBeGreaterThan(spread(0.5, 10))
    // A swell narrows the spread (a 10 m/s wind sea: Mitsuyasu's s ≈ 7 at the peak, + 16 tanh(1) for ξ = 1).
    const { omegaP } = jonswapPeak(10, 60_000)
    expect(spreadExponent(omegaP, omegaP, 10, 0)).toBeGreaterThan(3)
    expect(spreadExponent(omegaP, omegaP, 10, 1)).toBeGreaterThan(spreadExponent(omegaP, omegaP, 10, 0) + 10)
  })

  it('cascade bands do not overlap and tile the spectrum: the first keeps its fundamental, the last its Nyquist', () => {
    const cs = cascadesFor(GPU_TILES_M, 128)
    expect(cs[0]!.kMin).toBe(0)
    expect(cs.at(-1)!.kMax).toBe(Infinity)
    for (let c = 1; c < cs.length; c++) expect(cs[c]!.kMin).toBeCloseTo(cs[c - 1]!.kMax, 12)
    // ≈ 28 cycles per tile for the ratio 4.7 (COAST §8.3), within the 64 a 128² grid holds.
    expect((cs[0]!.kMax * GPU_TILES_M[0]) / (2 * Math.PI)).toBeGreaterThan(25)
    expect((cs[0]!.kMax * GPU_TILES_M[0]) / (2 * Math.PI)).toBeLessThan(64)
    expect(WORKER_TILES_M[0] / WORKER_TILES_M[1]).toBeCloseTo(400 / 110, 6)
  })

  it('the Hs clamp: a storm is scaled to 2.5 m, and the evaluated surface has that variance', () => {
    const storm = seaParams({ windMs: 13, windDirRad: 0.3, storm: 1, swellFromDeg: 150 }, 1188)
    const cs = cascadesFor(WORKER_TILES_M, 64)
    const raw = significantHeight(cs, storm)
    expect(raw).toBeGreaterThan(HS_MAX_M)
    const b = buildH0(cs, storm)
    expect(b.hsRaw).toBeCloseTo(raw, 6)
    expect(b.hs).toBeCloseTo(HS_MAX_M, 6)
    const tile = new WaveTile(cs)
    tile.setH0(b.cascades)
    // The surface variance over a few times ≈ m0 (the sum of both cascades' heights).
    let acc = 0, count = 0
    for (const t of [0, 7.3, 19.1, 40.7]) {
      const f = tile.evaluate(t)
      const sum = new Float64Array(64 * 64)
      for (const d of f.disp) for (let i = 0; i < 64 * 64; i++) sum[i]! += d[i * 4 + 1]!
      for (const v of sum) {
        acc += v * v
        count++
      }
    }
    const hs = 4 * Math.sqrt(acc / count)
    expect(hs / HS_MAX_M).toBeGreaterThan(0.6)
    expect(hs / HS_MAX_M).toBeLessThan(1.4)
  })

  it('the sea state by weather: a gentle swell when clear, ~1 m in rain, the clamp in a storm', () => {
    const cs = cascadesFor(WORKER_TILES_M, 64)
    const hs = (windMs: number, storm: number) => buildH0(cs, seaParams({ windMs, windDirRad: 0, storm, swellFromDeg: 150 }))
    const clear = hs(2, 0), rain = hs(6, 0.36), storm = hs(13, 1)
    expect(clear.scale).toBe(1)
    // P-LOOK: the clear day's wind sea is a gentle breeze's (CALM_SEA_WIND_MS 5 m/s): Hs ≈ 0.9 m with the calm swell.
    expect(clear.hs).toBeGreaterThan(0.6)
    expect(clear.hs).toBeLessThan(1.1)
    expect(rain.hs).toBeGreaterThan(clear.hs)
    expect(rain.hs).toBeGreaterThan(0.6)
    expect(rain.hs).toBeLessThan(1.8)
    expect(storm.hs).toBeCloseTo(HS_MAX_M, 6)
  })

  it('a wind change grows the same sea: every amplitude keeps its phase and moves by a few percent', () => {
    const cs = cascadesFor(WORKER_TILES_M, 64)
    const a = buildH0(cs, calm)
    const b = buildH0(cs, seaParams({ windMs: 7.25, windDirRad: 0, storm: 0, swellFromDeg: 150 }))
    let compared = 0
    const ratios: number[] = []
    for (let c = 0; c < cs.length; c++) {
      const x = a.cascades[c]!.h0, y = b.cascades[c]!.h0
      let top = 0
      for (let i = 0; i < x.length; i += 2) top = Math.max(top, Math.hypot(x[i]!, x[i + 1]!))
      for (let i = 0; i < x.length; i += 2) {
        const ma = Math.hypot(x[i]!, x[i + 1]!), mb = Math.hypot(y[i]!, y[i + 1]!)
        if (ma < 1e-7 || mb < 1e-7) continue
        compared++
        expect(Math.atan2(x[i + 1]!, x[i]!)).toBeCloseTo(Math.atan2(y[i + 1]!, y[i]!), 5)
        // The waves that carry the energy (≥ 10 % of the cascade's largest amplitude) move by a few percent; only the
        // far low-frequency tail of the wind sea (JONSWAP's exp(−1.25 (ωp/ω)⁴)) moves more, at a tiny amplitude.
        if (ma < 0.1 * top) continue
        expect(mb / ma).toBeGreaterThan(0.85)
        expect(mb / ma).toBeLessThan(1.3)
        ratios.push(mb / ma)
      }
    }
    expect(compared).toBeGreaterThan(100)
    ratios.sort((p, q) => p - q)
    const median = ratios[ratios.length >> 1]!
    expect(median).toBeGreaterThan(0.98)
    expect(median).toBeLessThan(1.15)
    // The Gaussians are fixed by the seed, and different per texel.
    expect(gaussianPair(1188, 0, 5, 9)).toEqual(gaussianPair(1188, 0, 5, 9))
    expect(gaussianPair(1188, 0, 5, 9)).not.toEqual(gaussianPair(1188, 0, 6, 9))
  })

  it('with the rounded frequencies, t = 0 and t = 3,600 s give the same surface', () => {
    const cs = cascadesFor(WORKER_TILES_M, 64)
    const tile = new WaveTile(cs)
    tile.setH0(buildH0(cs, calm).cascades)
    const a = tile.evaluate(0)
    const dispA = a.disp.map(d => d.slice())
    const b = tile.evaluate(3600)
    let worst = 0
    for (let c = 0; c < cs.length; c++) for (let i = 0; i < dispA[c]!.length; i += 4) worst = Math.max(worst, Math.abs(dispA[c]![i + 1]! - b.disp[c]![i + 1]!))
    expect(worst).toBeLessThan(2e-3)
  })
})
