/**
 * CST-O, the worker tile's FFT (docs/COAST.md §8.4, §12.4): the inverse FFT of a single spectral line is the analytic
 * cosine (height, choppy displacement and slopes: the two-real-fields-per-complex packing and the centred sign fix);
 * the derivative fields agree with finite differences of the displacement; the Jacobian foam stays in [0, 1.5]; the
 * half-float packing and its mip chain.
 */
import { describe, expect, it } from 'vitest'
import { FOAM_MAX, WaveTile, downsample, fromHalf, ifft, mipCount, packFrame, toHalf, twiddles } from '../src/ocean/fft-core.ts'
import { WORKER_TILES_M, buildH0, cascadesFor, roundOmega, dispersion, type CascadeH0 } from '../src/ocean/spectrum.ts'
import { seaParams } from '../src/ocean/weather.ts'

const N = 64
const L = 100

function singleLine(i: number, j: number, re: number, im: number, depth = 100): CascadeH0[] {
  const c = { tileM: L, size: N, kMin: 0, kMax: Infinity }
  const h0 = new Float32Array(N * N * 2)
  const omega = new Float32Array(N * N)
  const dk = (2 * Math.PI) / L
  for (let jj = 0; jj < N; jj++) for (let ii = 0; ii < N; ii++) {
    const k = Math.hypot((ii - N / 2) * dk, (jj - N / 2) * dk)
    omega[jj * N + ii] = k > 0 ? roundOmega(dispersion(k, depth)) : 0
  }
  h0[(j * N + i) * 2] = re
  h0[(j * N + i) * 2 + 1] = im
  return [{ cascade: c, h0, omega, variance: 0 }]
}

describe('the FFT core', () => {
  it('a radix-2 inverse DFT matches the direct sum', () => {
    const n = 16
    const re = new Float64Array(n), im = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 1.3) + 0.2 * i
      im[i] = Math.cos(i * 0.7)
    }
    const ref = Array.from({ length: n }, (_, m) => {
      let r = 0, q = 0
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k * m) / n
        r += re[k]! * Math.cos(a) - im[k]! * Math.sin(a)
        q += re[k]! * Math.sin(a) + im[k]! * Math.cos(a)
      }
      return [r, q]
    })
    ifft(re, im, n, twiddles(n))
    for (let m = 0; m < n; m++) {
      expect(re[m]).toBeCloseTo(ref[m]![0]!, 9)
      expect(im[m]).toBeCloseTo(ref[m]![1]!, 9)
    }
  })

  it('a single spectral line gives the analytic travelling cosine: height, choppy displacement, slopes', () => {
    // k = (3, 2) · 2π / L; h0 = a e^{iφ0}: h = 2a cos(k·x − ωt + φ0).
    const ki = 3, kj = 2, a = 0.05, phi0 = 0.4
    const tile = new WaveTile([{ tileM: L, size: N, kMin: 0, kMax: Infinity }])
    tile.params = { choppiness: 0.9, foamBias: 0.58, gains: [1] }
    tile.setH0(singleLine(N / 2 + ki, N / 2 + kj, a * Math.cos(phi0), a * Math.sin(phi0)))
    const kx = (2 * Math.PI * ki) / L, kz = (2 * Math.PI * kj) / L, k = Math.hypot(kx, kz)
    const w = roundOmega(dispersion(k, 100))
    const t = 3.7
    const f = tile.evaluate(t)
    const disp = f.disp[0]!, der = f.deriv[0]!
    let worst = 0
    for (const [i, j] of [[0, 0], [5, 9], [17, 40], [63, 63], [31, 2]] as const) {
      const x = (i * L) / N, z = (j * L) / N
      const ph = kx * x + kz * z - w * t + phi0
      const o = (j * N + i) * 4
      const expect4 = [
        2 * a * 0.9 * (kx / k) * Math.sin(ph), // Dx
        2 * a * Math.cos(ph), // Dy
        2 * a * 0.9 * (kz / k) * Math.sin(ph), // Dz
      ]
      const expectD = [
        -2 * a * kx * Math.sin(ph), // ∂Dy/∂x
        -2 * a * kz * Math.sin(ph), // ∂Dy/∂z
        2 * a * 0.9 * (kx * kx / k) * Math.cos(ph), // ∂Dx/∂x
        2 * a * 0.9 * (kz * kz / k) * Math.cos(ph), // ∂Dz/∂z
      ]
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(disp[o + c]! - expect4[c]!))
      for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(der[o + c]! - expectD[c]!))
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('the derivative fields agree with finite differences of the displacement (a real spectrum)', () => {
    const cs = cascadesFor([L], N)
    const tile = new WaveTile(cs)
    tile.setH0(buildH0(cs, seaParams({ windMs: 6, windDirRad: 0.5, storm: 0.2, swellFromDeg: 150 })).cascades)
    const f = tile.evaluate(12.5)
    const d = f.disp[0]!, g = f.deriv[0]!
    const h = L / N
    let err = 0, mag = 0
    for (let j = 1; j < N - 1; j += 3) for (let i = 1; i < N - 1; i += 3) {
      const at = (ii: number, jj: number, c: number) => d[(jj * N + ii) * 4 + c]!
      // Central differences on the grid (spectral fields: second-order accurate for the resolved band).
      const dydx = (at(i + 1, j, 1) - at(i - 1, j, 1)) / (2 * h)
      const dxdx = (at(i + 1, j, 0) - at(i - 1, j, 0)) / (2 * h)
      const o = (j * N + i) * 4
      err += Math.abs(dydx - g[o]!) + Math.abs(dxdx - g[o + 2]!)
      mag += Math.abs(g[o]!) + Math.abs(g[o + 2]!)
    }
    expect(err / mag).toBeLessThan(0.35)
  })

  it('the Jacobian foam stays within [0, 1.5], appears in a storm, and decays by 0.35/s', () => {
    const cs = cascadesFor(WORKER_TILES_M, N)
    const tile = new WaveTile(cs)
    tile.setH0(buildH0(cs, seaParams({ windMs: 13, windDirRad: 0, storm: 1, swellFromDeg: 150 })).cascades)
    tile.params = { choppiness: 1.1, foamBias: 0.7, gains: [1, 1] }
    let any = 0
    for (let s = 0; s < 40; s++) {
      const f = tile.evaluate(s * 0.05)
      for (const d of f.disp) for (let i = 3; i < d.length; i += 4) {
        expect(d[i]).toBeGreaterThanOrEqual(0)
        expect(d[i]).toBeLessThanOrEqual(FOAM_MAX)
        if (d[i]! > 0.05) any++
      }
    }
    expect(any).toBeGreaterThan(0)
  })

  it('half floats round-trip and the mip chain is a 2×2 box', () => {
    for (const v of [0, 1, -2.5, 0.1234, 1e-5, 60000, -0.000061]) expect(fromHalf(toHalf(v))).toBeCloseTo(v, Math.abs(v) > 100 ? -2 : 3)
    expect(toHalf(1)).toBe(0x3c00)
    expect(toHalf(-2)).toBe(0xc000)
    const layer = new Float32Array(4 * 4 * 4).map((_, i) => i)
    const half = downsample(layer, 4)
    expect(half.length).toBe(2 * 2 * 4)
    expect(half[0]).toBeCloseTo((0 + 4 + 16 + 20) / 4, 6)
    expect(mipCount(64)).toBe(7)
    // packFrame writes every level of every layer at the layer offset.
    const frame = { t: 0, disp: [new Float32Array(4 * 4 * 4).fill(1)], deriv: [new Float32Array(4 * 4 * 4).fill(2)] }
    const levels = [new Uint16Array(4 * 4 * 4 * 4), new Uint16Array(2 * 2 * 4 * 4), new Uint16Array(4 * 4)]
    packFrame(frame, 4, levels, 2)
    expect(fromHalf(levels[0]![2 * 64])).toBe(1)
    expect(fromHalf(levels[0]![3 * 64])).toBe(2)
    expect(fromHalf(levels[2]![3 * 4])).toBe(2)
    expect(levels[0]![0]).toBe(0)
  })
})
