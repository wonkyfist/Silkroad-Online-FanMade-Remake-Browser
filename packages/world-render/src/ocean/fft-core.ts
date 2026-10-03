/**
 * Portions ported from Tidewater (github.com/dgreenheck/tidewater, `OceanFFT.js` at `4811ba4`), MIT licence, Copyright (c)
 * 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.
 *
 * The FFT ocean tile in TypeScript (docs/COAST.md §8.3, §8.4): h0 evolved to h̃(k, t), eight real fields packed two per
 * complex grid (four 2D inverse FFTs per cascade), the centred-spectrum sign fix, the Jacobian and the persistent foam.
 * The worker tile (Medium, and every preset without compute) runs it 20 times a second; it is also the reference the
 * WGSL kernels (fft-wgsl.ts) are checked against, and the CPU wave query's source.
 *
 * Outputs per cascade, RGBA float, texel (i, j) = world (i, j) × L / N (x along i, z along j):
 * - displacement: (Dx, Dy, Dz, foam), Dx and Dz already × the choppiness λ;
 * - derivatives: (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z), the last two × λ (the normal's slopes are
 *   ∂Dy/∂x / (1 + ∂Dx/∂x) and ∂Dy/∂z / (1 + ∂Dz/∂z), COAST §8.6).
 * The packing: P1 = Dx + i Dz, P2 = Dy + i ∂Dx/∂z, P3 = ∂Dy/∂x + i ∂Dy/∂z, P4 = ∂Dx/∂x + i ∂Dz/∂z.
 */
import type { Cascade, CascadeH0 } from './spectrum.ts'

/**
 * Foam: made where the Jacobian drops under the bias, fading at `decay` per second (COAST §8.3). Tidewater's bias is
 * 0.58; our per-cascade Jacobian (2 × 64² or 4 × 128²) measured p1 ≈ 0.76–0.80 in a storm and ≥ 0.82 in clear weather
 * (work/tmp/ocean/jacobian.ts), so 0.58 never foamed: the bias is 0.80 calm → 0.87 in a storm (+ 0.03 in gusts,
 * weather.ts), with a steeper gain so a storm's crests go white.
 */
export const FOAM_BIAS = 0.8
export const FOAM_DECAY = 0.35
export const FOAM_GAIN = 6
export const FOAM_MAX = 1.5
/** Tidewater's choppiness λ (0.9 → 1.1 in storms, COAST §8.7). */
export const CHOPPINESS = 0.9

/** In-place radix-2 inverse DFT (positive exponent, no 1/N) of a complex sequence of length n (a power of 2). */
export function ifft(re: Float64Array, im: Float64Array, n: number, tw: Twiddles): void {
  const rev = tw.rev
  for (let i = 0; i < n; i++) {
    const r = rev[i]!
    if (r > i) {
      const tr = re[i]!, ti = im[i]!
      re[i] = re[r]!
      im[i] = im[r]!
      re[r] = tr
      im[r] = ti
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = tw.cos[k * step]!, wi = tw.sin[k * step]!
        const a = start + k, b = a + half
        const xr = re[b]! * wr - im[b]! * wi
        const xi = re[b]! * wi + im[b]! * wr
        re[b] = re[a]! - xr
        im[b] = im[a]! - xi
        re[a] = re[a]! + xr
        im[a] = im[a]! + xi
      }
    }
  }
}

/** Twiddles e^{+2πik/n} and the bit-reversal table for one size. */
export interface Twiddles {
  n: number
  cos: Float64Array
  sin: Float64Array
  rev: Uint32Array
}

export function twiddles(n: number): Twiddles {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`fft size ${n} is not a power of 2`)
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n)
    sin[k] = Math.sin((2 * Math.PI * k) / n)
  }
  const bits = Math.log2(n)
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b)
    rev[i] = r
  }
  return { n, cos, sin, rev }
}

/** 2D inverse DFT in place (rows, then columns) of an n × n complex grid, row-major (index j·n + i). */
export function ifft2d(re: Float64Array, im: Float64Array, n: number, tw: Twiddles, rowRe: Float64Array, rowIm: Float64Array): void {
  for (let j = 0; j < n; j++) {
    const o = j * n
    for (let i = 0; i < n; i++) {
      rowRe[i] = re[o + i]!
      rowIm[i] = im[o + i]!
    }
    ifft(rowRe, rowIm, n, tw)
    for (let i = 0; i < n; i++) {
      re[o + i] = rowRe[i]!
      im[o + i] = rowIm[i]!
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      rowRe[j] = re[j * n + i]!
      rowIm[j] = im[j * n + i]!
    }
    ifft(rowRe, rowIm, n, tw)
    for (let j = 0; j < n; j++) {
      re[j * n + i] = rowRe[j]!
      im[j * n + i] = rowIm[j]!
    }
  }
}

/** Per-tick knobs (the weather's, COAST §8.7). */
export interface TileParams {
  /** λ (0.9 calm … 1.1 storm). */
  choppiness: number
  /** Whitecap threshold on J (FOAM_BIAS: 0.80 calm … 0.90 in a gusty storm). */
  foamBias: number
  /** Amplitude gain per cascade (rain damps the finest to 0.7). */
  gains: readonly number[]
}

export const DEFAULT_TILE_PARAMS: TileParams = { choppiness: CHOPPINESS, foamBias: FOAM_BIAS, gains: [] }

/** One evaluated tile: per cascade, displacement and derivatives (RGBA float, n × n). */
export interface TileFrame {
  /** The time it was evaluated at (s). */
  t: number
  disp: Float32Array[]
  deriv: Float32Array[]
}

interface CascadeState {
  cascade: Cascade
  n: number
  h0: Float32Array
  omega: Float32Array
  /** kx / k, kz / k, kx, kz, k per texel (0 at k = 0). */
  kx: Float32Array
  kz: Float32Array
  k: Float32Array
  /** Index of −k (0 where it has no partner: the Nyquist row and column). */
  neg: Uint32Array
  foam: Float32Array
  grids: Float64Array[]
}

/** The FFT ocean tile: cascades of one size, evaluated at any time t (deterministic in t; the foam carries over). */
export class WaveTile {
  private readonly states: CascadeState[]
  private readonly tw: Twiddles
  private readonly rowRe: Float64Array
  private readonly rowIm: Float64Array
  private lastT: number | null = null
  params: TileParams = DEFAULT_TILE_PARAMS

  constructor(readonly cascades: readonly Cascade[]) {
    const n = cascades[0]?.size ?? 0
    if (!cascades.length || cascades.some(c => c.size !== n)) throw new Error('every cascade needs the same size')
    this.tw = twiddles(n)
    this.rowRe = new Float64Array(n)
    this.rowIm = new Float64Array(n)
    this.states = cascades.map(c => {
      const count = n * n
      const kx = new Float32Array(count), kz = new Float32Array(count), k = new Float32Array(count), neg = new Uint32Array(count)
      const dk = (2 * Math.PI) / c.tileM
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const idx = j * n + i
          kx[idx] = (i - n / 2) * dk
          kz[idx] = (j - n / 2) * dk
          k[idx] = Math.hypot(kx[idx]!, kz[idx]!)
          neg[idx] = i === 0 || j === 0 ? idx : (n - j) * n + (n - i)
        }
      }
      return {
        cascade: c, n, h0: new Float32Array(count * 2), omega: new Float32Array(count), kx, kz, k, neg,
        foam: new Float32Array(count), grids: Array.from({ length: 8 }, () => new Float64Array(count)),
      }
    })
  }

  get size(): number {
    return this.tw.n
  }

  /** New amplitudes (a spectrum rebuild): the foam and the phases carry on. */
  setH0(h0: readonly CascadeH0[]): void {
    this.states.forEach((s, c) => {
      const src = h0[c]
      if (!src || src.h0.length !== s.h0.length) throw new Error(`h0 for cascade ${c} does not match the tile`)
      s.h0.set(src.h0)
      s.omega.set(src.omega)
    })
  }

  /** Evaluates the tile at time t (s); `out` is reused when given (its arrays must match). */
  evaluate(t: number, out?: TileFrame): TileFrame {
    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(1, t - this.lastT))
    this.lastT = t
    const frame = out ?? { t, disp: this.states.map(s => new Float32Array(s.n * s.n * 4)), deriv: this.states.map(s => new Float32Array(s.n * s.n * 4)) }
    frame.t = t
    const lambda = this.params.choppiness
    const bias = this.params.foamBias
    this.states.forEach((s, c) => {
      const gain = this.params.gains[c] ?? 1
      this.spectra(s, t, lambda, gain)
      const [p1r, p1i, p2r, p2i, p3r, p3i, p4r, p4i] = s.grids as [Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array]
      ifft2d(p1r, p1i, s.n, this.tw, this.rowRe, this.rowIm)
      ifft2d(p2r, p2i, s.n, this.tw, this.rowRe, this.rowIm)
      ifft2d(p3r, p3i, s.n, this.tw, this.rowRe, this.rowIm)
      ifft2d(p4r, p4i, s.n, this.tw, this.rowRe, this.rowIm)
      const disp = frame.disp[c]!, deriv = frame.deriv[c]!
      const n = s.n
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const idx = j * n + i
          const sg = ((i + j) & 1) === 0 ? 1 : -1
          const jxx = sg * p4r[idx]!, jzz = sg * p4i[idx]!, jxz = sg * p2i[idx]!
          const jac = (1 + jxx) * (1 + jzz) - jxz * jxz
          const inject = Math.min(FOAM_MAX, Math.max(0, (bias - jac) * FOAM_GAIN))
          const f = Math.max(s.foam[idx]! - FOAM_DECAY * dt, inject)
          s.foam[idx] = f
          const o = idx * 4
          disp[o] = sg * p1r[idx]!
          disp[o + 1] = sg * p2r[idx]!
          disp[o + 2] = sg * p1i[idx]!
          disp[o + 3] = f
          deriv[o] = sg * p3r[idx]!
          deriv[o + 1] = sg * p3i[idx]!
          deriv[o + 2] = jxx
          deriv[o + 3] = jzz
        }
      }
    })
    return frame
  }

  /** h̃(k, t) and the four packed spectra of one cascade. */
  private spectra(s: CascadeState, t: number, lambda: number, gain: number): void {
    const [p1r, p1i, p2r, p2i, p3r, p3i, p4r, p4i] = s.grids as [Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array]
    const h0 = s.h0
    const count = s.n * s.n
    for (let idx = 0; idx < count; idx++) {
      const k = s.k[idx]!
      const m = s.neg[idx]!
      if (k < 1e-9 || m === idx) {
        p1r[idx] = p1i[idx] = p2r[idx] = p2i[idx] = p3r[idx] = p3i[idx] = p4r[idx] = p4i[idx] = 0
        continue
      }
      const w = s.omega[idx]! * t
      const cw = Math.cos(w), sw = Math.sin(w)
      const a = h0[idx * 2]! * gain, b = h0[idx * 2 + 1]! * gain
      const c = h0[m * 2]! * gain, d = h0[m * 2 + 1]! * gain
      // h̃ = h0(k) e^{−iωt} + conj(h0(−k)) e^{iωt}
      const hr = a * cw + b * sw + c * cw + d * sw
      const hi = b * cw - a * sw + c * sw - d * cw
      const kx = s.kx[idx]!, kz = s.kz[idx]!
      // P1 = λ h̃ (kz − i kx) / k
      const l = lambda / k
      p1r[idx] = l * (kz * hr + kx * hi)
      p1i[idx] = l * (kz * hi - kx * hr)
      // P2 = h̃ (1 + i λ kx kz / k)
      const cxz = l * kx * kz
      p2r[idx] = hr - cxz * hi
      p2i[idx] = hi + cxz * hr
      // P3 = h̃ (−kz + i kx)
      p3r[idx] = -kz * hr - kx * hi
      p3i[idx] = kx * hr - kz * hi
      // P4 = h̃ (λ kx² / k + i λ kz² / k)
      const ax = l * kx * kx, az = l * kz * kz
      p4r[idx] = hr * ax - hi * az
      p4i[idx] = hi * ax + hr * az
    }
  }
}

// ---- packing for upload -----------------------------------------------------------------------------------------------

/** IEEE half bits from a float (rounded; overflow → ±Inf, underflow → ±0). */
export function toHalf(v: number): number {
  F32[0] = v
  const x = U32[0]!
  let bits = (x >>> 16) & 0x8000
  let m = (x >>> 12) & 0x07ff
  const e = (x >>> 23) & 0xff
  if (e < 103) return bits
  if (e > 142) {
    bits |= 0x7c00
    if (e === 255 && (x & 0x007fffff)) bits |= 0x200
    return bits
  }
  if (e < 113) {
    m |= 0x0800
    return bits | ((m >>> (114 - e)) + ((m >>> (113 - e)) & 1))
  }
  bits |= ((e - 112) << 10) | (m >>> 1)
  return bits + (m & 1)
}

/** A float from IEEE half bits. */
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >>> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 0x1f) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)

/** Mip levels of an n × n RGBA layer: n, n/2, …, 1 (count log2 n + 1). */
export function mipCount(n: number): number {
  return Math.log2(n) + 1
}

/**
 * Packs a tile frame as RGBA16F layers for one texture array, in the ocean's layer order [disp c0 … disp cC−1,
 * deriv c0 … deriv cC−1], every mip level (2 × 2 box), into `levels[m]` at layer offset `layer0` (half-float bits).
 * `levels[m]` holds the whole array's level m (n_m² × 4 × layers).
 */
export function packFrame(frame: TileFrame, n: number, levels: Uint16Array[], layer0: number): void {
  let size = n
  let src: Float32Array[] = [...frame.disp, ...frame.deriv]
  for (let m = 0; m < levels.length; m++) {
    const dst = levels[m]!
    const per = size * size * 4
    for (let l = 0; l < src.length; l++) {
      const from = src[l]!
      const o = (layer0 + l) * per
      for (let i = 0; i < per; i++) dst[o + i] = toHalf(from[i]!)
    }
    if (m + 1 >= levels.length) break
    const s = size
    src = src.map(from => downsample(from, s))
    size >>= 1
  }
}

/** 2 × 2 box downsample of an RGBA float layer. */
export function downsample(src: Float32Array, n: number): Float32Array {
  const h = n >> 1
  const out = new Float32Array(h * h * 4)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < h; i++) {
      const a = ((2 * j) * n + 2 * i) * 4, b = a + 4, c = a + n * 4, d = c + 4
      const o = (j * h + i) * 4
      for (let ch = 0; ch < 4; ch++) out[o + ch] = (src[a + ch]! + src[b + ch]! + src[c + ch]! + src[d + ch]!) * 0.25
    }
  }
  return out
}
