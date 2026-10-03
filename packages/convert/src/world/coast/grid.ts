/**
 * Whole-lattice array operations of the coast pass (the numpy helpers of work/tmp/coast-beach/coast_beach.py):
 * separable box and Gaussian blurs with edge padding, the nearest-value extrapolation beyond the kept set, the slope
 * and percentiles. Row-major Float64Arrays of rows x cols; row 0 is the north edge, column 0 the west edge.
 *
 * The blurs use the prototype's prefix-sum formulation in float64 so the port reproduces its arrays to rounding.
 */
import { roundHalfEven } from './profile.ts'

/** One separable box blur of radius r (window 2r + 1) with edge padding, in place of `a` (returns `a`). */
export function boxBlur(a: Float64Array, rows: number, cols: number, r: number): Float64Array {
  if (r <= 0) return a
  const k = 2 * r + 1
  // axis 0 (down the columns)
  const pre = new Float64Array(rows + 2 * r + 1)
  for (let c = 0; c < cols; c++) {
    let acc = 0
    pre[0] = 0
    for (let p = 0; p < rows + 2 * r; p++) {
      const src = p - r < 0 ? 0 : p - r >= rows ? rows - 1 : p - r
      acc += a[src * cols + c]!
      pre[p + 1] = acc
    }
    for (let i = 0; i < rows; i++) a[i * cols + c] = (pre[i + k]! - pre[i]!) / k
  }
  // axis 1 (along the rows)
  const pre1 = new Float64Array(cols + 2 * r + 1)
  for (let i = 0; i < rows; i++) {
    const base = i * cols
    let acc = 0
    pre1[0] = 0
    for (let p = 0; p < cols + 2 * r; p++) {
      const src = p - r < 0 ? 0 : p - r >= cols ? cols - 1 : p - r
      acc += a[base + src]!
      pre1[p + 1] = acc
    }
    for (let j = 0; j < cols; j++) a[base + j] = (pre1[j + k]! - pre1[j]!) / k
  }
  return a
}

/** Box radius the prototype uses for a Gaussian of sigma lattice cells (three box passes). */
export const gaussRadius = (sigmaCells: number) => Math.max(1, roundHalfEven(sigmaCells * 0.87))

/** Approximate Gaussian blur (three box passes), sigma in lattice cells. Returns a new array. */
export function gblur(src: ArrayLike<number>, rows: number, cols: number, sigmaCells: number): Float64Array {
  const a = Float64Array.from(src as ArrayLike<number>)
  const r = gaussRadius(sigmaCells)
  for (let n = 0; n < 3; n++) boxBlur(a, rows, cols, r)
  return a
}

/** A mask as 0/1 floats. */
export function maskToFloat(m: Uint8Array): Float64Array {
  const out = new Float64Array(m.length)
  for (let i = 0; i < m.length; i++) out[i] = m[i] ? 1 : 0
  return out
}

/** Moore neighbours in the prototype's order (numpy roll shifts: dy rows, dx columns). */
const DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

export interface Extrapolated {
  /** Full-resolution values: the nearest kept value minus drop x distance. */
  value: Float64Array
  /** Full-resolution distance (m) to the nearest kept sample (on the coarse grid). */
  dist: Float64Array
}

/**
 * Extends `val` beyond `mask` (the prototype's `extrapolate`): on a grid subsampled every `step` vertices, each unmasked
 * sample takes the value of the nearest masked one by an 8-neighbour propagation (diagonal steps cost sqrt 2), with
 * np.roll's wrap-around at the lattice border kept for parity; the value then drops by `drop` m per metre of distance,
 * and both are repeated back up to full resolution. Stops once every coarse sample is reached, or after `iters`.
 */
export function extrapolate(
  val: ArrayLike<number>, mask: Uint8Array, rows: number, cols: number,
  opts: { drop?: number; step?: number; iters?: number; cellM?: number } = {},
): Extrapolated {
  const drop = opts.drop ?? 0.55
  const step = opts.step ?? 4
  const iters = opts.iters ?? 300
  const cellM = opts.cellM ?? 2
  const cr = Math.ceil(rows / step)
  const cc = Math.ceil(cols / step)
  const n = cr * cc
  let v = new Float64Array(n)
  let d = new Float64Array(n)
  for (let i = 0; i < cr; i++) {
    for (let j = 0; j < cc; j++) {
      const f = i * step * cols + j * step
      const c = i * cc + j
      if (mask[f]) {
        v[c] = val[f]!
        d[c] = 0
      } else {
        v[c] = NaN
        d[c] = Infinity
      }
    }
  }
  let bv = new Float64Array(n)
  let bd = new Float64Array(n)
  for (let it = 0; it < iters; it++) {
    let open = false
    for (let c = 0; c < n; c++) {
      if (d[c] === Infinity) {
        open = true
        break
      }
    }
    if (!open) break
    bv.set(v)
    bd.set(d)
    for (const [dy, dx] of DIRS) {
      const cost = dx && dy ? 1.4142 : 1
      for (let i = 0; i < cr; i++) {
        let si = i - dy
        if (si < 0) si += cr
        else if (si >= cr) si -= cr
        for (let j = 0; j < cc; j++) {
          let sj = j - dx
          if (sj < 0) sj += cc
          else if (sj >= cc) sj -= cc
          const s = si * cc + sj
          const sd = d[s]! + cost
          const c = i * cc + j
          if (sd < bd[c]!) {
            bd[c] = sd
            bv[c] = v[s]!
          }
        }
      }
    }
    const tv = v
    v = bv
    bv = tv
    const td = d
    d = bd
    bd = td
  }
  const value = new Float64Array(rows * cols)
  const dist = new Float64Array(rows * cols)
  for (let i = 0; i < rows; i++) {
    const ci = Math.floor(i / step) * cc
    for (let j = 0; j < cols; j++) {
      const c = ci + Math.floor(j / step)
      const dm = d[c]! * step * cellM
      value[i * cols + j] = v[c]! - drop * dm
      dist[i * cols + j] = dm
    }
  }
  return { value, dist }
}

/** Slope angle (degrees) by numpy.gradient: central differences inside, one-sided at the border; cell in metres. */
export function slopeDeg(h: ArrayLike<number>, rows: number, cols: number, cellM: number): Float64Array {
  const out = new Float64Array(rows * cols)
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const k = i * cols + j
      const gy = i === 0 ? (h[k + cols]! - h[k]!) / cellM : i === rows - 1 ? (h[k]! - h[k - cols]!) / cellM
        : (h[k + cols]! - h[k - cols]!) / (2 * cellM)
      const gx = j === 0 ? (h[k + 1]! - h[k]!) / cellM : j === cols - 1 ? (h[k]! - h[k - 1]!) / cellM
        : (h[k + 1]! - h[k - 1]!) / (2 * cellM)
      out[k] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI
    }
  }
  return out
}

/** numpy.percentile (linear interpolation) of the values where `mask` is set; NaN when none. */
export function percentile(values: ArrayLike<number>, mask: ArrayLike<number> | null, q: number): number {
  const sel: number[] = []
  for (let i = 0; i < values.length; i++) if (!mask || mask[i]) sel.push(values[i]!)
  if (!sel.length) return NaN
  sel.sort((a, b) => a - b)
  const pos = (q / 100) * (sel.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(lo + 1, sel.length - 1)
  return sel[lo]! + (sel[hi]! - sel[lo]!) * (pos - lo)
}

/** Population standard deviation (numpy's default ddof 0). */
export function stdDev(a: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]!
  const m = s / a.length
  let q = 0
  for (let i = 0; i < a.length; i++) q += (a[i]! - m) ** 2
  return Math.sqrt(q / a.length)
}
