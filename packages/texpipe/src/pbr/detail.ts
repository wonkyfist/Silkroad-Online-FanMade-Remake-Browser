/**
 * TP-P detail layer (docs/DETAIL.md L3/L4, a port of `work/tmp/detail/detailmaps/scripts/detailgen.py` and the
 * `tile_to` / `prefilter` sampling of `dlib.py`): one procedural, seamlessly tileable 512² tile per material-mask class
 * (cloth weave, pebbled leather, brushed and scratched iron, hammered brass, skin pores, hair strands, wood grain,
 * polished jade),
 * each a height, an albedo multiplier (mean 1), a roughness offset (mean ≈ 0) and a tangent-space normal.
 *
 * On a master the tile is sampled with **the same UVs × a tiling factor** (repeats per atlas width, params.ts
 * DETAIL_TILING), so no UV is added or moved, and prefiltered (a wrap blur) wherever one master texel covers several
 * tile texels, as the GPU's mips would. derive.ts blends the tiles by the soft class masks and UDN-blends the detail
 * normal over the macro normal. DETAIL measured this as the biggest visible jump on actors (leather grain, rivets and
 * iron catching the light). The same tiles are what the runtime detail plugin (DT-4, not approved yet) would sample;
 * until then they are baked.
 *
 * Everything is deterministic (seeded mulberry32), tileable by construction (periodic FFT filtering, wrapped Worley
 * cells, scratches drawn modulo the tile) and pure (no node:*). All seven tiles take ~1–2 s once per process.
 */
import { MASK_CLASSES, type MaskClass } from '../format.ts'
import { blurBuffer, gauss, rng } from './image.ts'

export const DETAIL_N = 512

export interface DetailTile {
  n: number
  /** Height 0..1. */
  h: Float32Array
  /** Albedo multiplier, mean 1. */
  alb: Float32Array
  /** Roughness offset. */
  rough: Float32Array
  /** Tangent-space normal (x, y, z interleaved), +Y up (glTF). */
  nrm: Float32Array
  /** The generator's relief strength (height units per texel × 6 in the normal). */
  strength: number
}

// ---- FFT (radix 2, in place) ----------------------------------------------------------------------------------------

function fft1(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]!; re[i] = re[j]!; re[j] = t
      t = im[i]!; im[i] = im[j]!; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2
        const xr = re[b]! * cr - im[b]! * ci, xi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - xr; im[b] = im[a]! - xi
        re[a] = re[a]! + xr; im[a] = im[a]! + xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = im[i]! / n }
}

/** 2-D FFT of an n×n complex field (row-major), in place. */
export function fft2(re: Float64Array, im: Float64Array, n: number, inverse = false): void {
  const r = new Float64Array(n), i = new Float64Array(n)
  for (let y = 0; y < n; y++) {
    r.set(re.subarray(y * n, y * n + n)); i.set(im.subarray(y * n, y * n + n))
    fft1(r, i, inverse)
    re.set(r, y * n); im.set(i, y * n)
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { r[y] = re[y * n + x]!; i[y] = im[y * n + x]! }
    fft1(r, i, inverse)
    for (let y = 0; y < n; y++) { re[y * n + x] = r[y]!; im[y * n + x] = i[y]! }
  }
}

const freq = (k: number, n: number) => (k < n / 2 ? k : k - n) / n

/**
 * Tileable band-limited noise: white noise filtered by a sum of octave bands (a radial Gaussian ring around f0 per
 * octave, each normalised to unit variance), divided by the sum of the octave weights (dlib `fbm`, detailgen
 * `rot_fbm`). `band(fy, fx, f0)` returns the filter value.
 */
function bandNoise(n: number, octaves: number, base: number, gain: number, seed: number, band: (fy: number, fx: number, f0: number) => number): Float32Array {
  const g = gauss(rng(seed))
  const re = new Float64Array(n * n), im = new Float64Array(n * n)
  for (let p = 0; p < n * n; p++) re[p] = g()
  fft2(re, im, n)
  const filt = new Float64Array(n * n)
  const one = new Float64Array(n * n)
  let amp = 1, tot = 0
  for (let o = 0; o < octaves; o++) {
    const f0 = (base * 2 ** o) / n
    let e = 0
    for (let y = 0; y < n; y++) {
      const fy = freq(y, n)
      for (let x = 0; x < n; x++) {
        const v = band(fy, freq(x, n), f0)
        one[y * n + x] = v
        e += v * v
      }
    }
    const std = Math.sqrt(e / (n * n)) || 1
    for (let p = 0; p < n * n; p++) filt[p] += (amp * one[p]!) / std
    tot += amp
    amp *= gain
  }
  for (let p = 0; p < n * n; p++) { re[p] = re[p]! * filt[p]!; im[p] = im[p]! * filt[p]! }
  fft2(re, im, n, true)
  const out = new Float32Array(n * n)
  for (let p = 0; p < n * n; p++) out[p] = re[p]! / tot
  return out
}

/** Isotropic tileable fBm (dlib `fbm`, aniso = [sy, sx]). */
export function fbm(n: number, octaves: number, base: number, seed: number, gain = 0.5, aniso: [number, number] = [1, 1]): Float32Array {
  return bandNoise(n, octaves, base, gain, seed, (fy, fx, f0) => {
    const rad = Math.hypot(fy * aniso[0], fx * aniso[1])
    return Math.exp(-((rad - f0) ** 2) / (2 * (f0 * 0.5) ** 2))
  })
}

/** Anisotropic tileable noise, features elongated along `angle` by `stretch` (detailgen `rot_fbm`). */
export function rotFbm(n: number, angleDeg: number, stretch: number, base: number, octaves: number, seed: number): Float32Array {
  const t = (angleDeg * Math.PI) / 180
  const c = Math.cos(t), s = Math.sin(t)
  return bandNoise(n, octaves, base, 0.55, seed, (fy, fx, f0) => {
    const fa = fx * c + fy * s, fb = -fx * s + fy * c
    const rad = Math.hypot(fa * stretch, fb)
    return Math.exp(-((rad - f0) ** 2) / (2 * (f0 * 0.6) ** 2))
  })
}

/** Tileable Worley noise on a jittered cells×cells grid: nearest (F1) and second (F2) distance in cells, cell id. */
export function worley(n: number, cells: number, seed: number, jitter = 0.9): { F1: Float32Array; F2: Float32Array; ID: Int32Array } {
  const rand = rng(seed)
  const pts = new Float64Array(cells * cells * 2)
  for (let i = 0; i < pts.length; i++) pts[i] = 0.5 + (rand() - 0.5) * jitter
  const F1 = new Float32Array(n * n), F2 = new Float32Array(n * n), ID = new Int32Array(n * n)
  for (let y = 0; y < n; y++) {
    const ys = (y / n) * cells
    const cy = Math.floor(ys)
    for (let x = 0; x < n; x++) {
      const xs = (x / n) * cells
      const cx = Math.floor(xs)
      let f1 = 9e9, f2 = 9e9, id = 0
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy, my = ((ny % cells) + cells) % cells
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, mx = ((nx % cells) + cells) % cells
          const q = (my * cells + mx) * 2
          const d = Math.hypot(ys - (pts[q]! + ny), xs - (pts[q + 1]! + nx))
          if (d < f1) {
            f2 = f1
            f1 = d
            id = my * cells + mx
          } else if (d < f2) f2 = d
        }
      }
      F1[y * n + x] = f1
      F2[y * n + x] = f2
      ID[y * n + x] = id
    }
  }
  return { F1, F2, ID }
}

/**
 * Wrap-safe anti-aliased scratch lines (detailgen `scratches`): `count` segments of random start, a length up to
 * `maxLen` × n (squared-uniform, so most are short), a width in texels from `width`, an angle of `angle` ± jitter/2,
 * each of intensity 0.4..1; overlapping scratches add, then clamp to 1.
 */
export function scratches(n: number, count: number, seed: number, maxLen: number, width: [number, number], angle: number, jitter: number): Float32Array {
  const rand = rng(seed)
  const out = new Float32Array(n * n)
  for (let s = 0; s < count; s++) {
    const x0 = rand() * n, y0 = rand() * n
    const a = ((angle + (rand() - 0.5) * jitter) * Math.PI) / 180
    const len = rand() ** 2 * maxLen * n + 4 / 3
    const wd = width[0] + rand() * (width[1] - width[0])
    const inten = 0.4 + 0.6 * rand()
    const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len
    const r = wd / 2 + 1
    const bx0 = Math.floor(Math.min(x0, x1) - r), bx1 = Math.ceil(Math.max(x0, x1) + r)
    const by0 = Math.floor(Math.min(y0, y1) - r), by1 = Math.ceil(Math.max(y0, y1) + r)
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5, py = y + 0.5
        const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2))
        const d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))
        const cov = Math.max(0, Math.min(1, wd / 2 + 0.5 - d))
        if (cov <= 0) continue
        const q = (((y % n) + n) % n) * n + (((x % n) + n) % n)
        out[q] += cov * inten
      }
    }
  }
  for (let p = 0; p < out.length; p++) if (out[p]! > 1) out[p] = 1
  return out
}

/** Percentile normalisation to 0..1 (0.5 % → 0, 99.5 % → 1, clamped), as dlib `norm01`. */
export function norm01(a: Float32Array): Float32Array {
  const s = a.slice().sort()
  const lo = s[Math.floor(0.005 * (s.length - 1))]!, hi = s[Math.floor(0.995 * (s.length - 1))]!
  const out = new Float32Array(a.length)
  for (let p = 0; p < a.length; p++) out[p] = Math.max(0, Math.min(1, (a[p]! - lo) / (hi - lo + 1e-9)))
  return out
}

/** Tangent-space normal (+Y up) of a wrapped height field, central differences × `strength`. */
export function tileNormal(h: Float32Array, n: number, strength: number): Float32Array {
  const out = new Float32Array(n * n * 3)
  for (let y = 0; y < n; y++) {
    const yu = ((y - 1 + n) % n) * n, yd = ((y + 1) % n) * n
    for (let x = 0; x < n; x++) {
      const xl = (x - 1 + n) % n, xr = (x + 1) % n
      const dx = (h[y * n + xr]! - h[y * n + xl]!) * 0.5
      const dy = (h[yd + x]! - h[yu + x]!) * 0.5
      const nx = -dx * strength, ny = dy * strength
      const l = Math.hypot(nx, ny, 1)
      const p = (y * n + x) * 3
      out[p] = nx / l
      out[p + 1] = ny / l
      out[p + 2] = 1 / l
    }
  }
  return out
}

const map = (n: number, f: (p: number) => number) => {
  const o = new Float32Array(n * n)
  for (let p = 0; p < n * n; p++) o[p] = f(p)
  return o
}

// ---- the seven classes (detailgen.py, same constants and seeds; `wood` is new) -----------------------------------------

type Raw = { h: Float32Array; alb: Float32Array; rough: Float32Array; strength: number }

function cloth(n: number): Raw {
  const k = 32
  const rand = rng(3), g = gauss(rng(3))
  const thickW = Array.from({ length: k }, () => 0.85 + 0.25 * rand()), thickF = Array.from({ length: k }, () => 0.85 + 0.25 * rand())
  const toneW = Array.from({ length: k }, () => 1 + 0.06 * g()), toneF = Array.from({ length: k }, () => 1 + 0.06 * g())
  const fibW = rotFbm(n, 90, 12, 60, 3, 4), fibF = rotFbm(n, 0, 12, 60, 3, 5)
  const fuzz = fbm(n, 3, 40, 6), low = fbm(n, 3, 4, 7)
  const h0 = new Float32Array(n * n), top = new Uint8Array(n * n)
  for (let y = 0; y < n; y++) {
    const ys = (y / n) * k, iv = Math.floor(ys), fv = ys - iv
    for (let x = 0; x < n; x++) {
      const xs = (x / n) * k, iu = Math.floor(xs), fu = xs - iu
      const iuI = iu % k, ivI = iv % k
      const pw = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (fu - 0.5) / thickW[iuI]! + 0.5)))) ** 0.6
      const pf = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (fv - 0.5) / thickF[ivI]! + 0.5)))) ** 0.6
      const undW = 0.5 + 0.5 * Math.cos(Math.PI * (ys - (iuI % 2)))
      const undF = 0.5 + 0.5 * Math.cos(Math.PI * (xs - (ivI % 2)) + Math.PI)
      const hw = pw * (0.35 + 0.65 * undW), hf = pf * (0.35 + 0.65 * undF)
      const p = y * n + x
      top[p] = hw >= hf ? 1 : 0
      h0[p] = (top[p] ? hw + 0.06 * fibW[p]! : hf + 0.06 * fibF[p]!) + 0.03 * fuzz[p]! + 0.08 * low[p]!
    }
  }
  const h = norm01(h0)
  const alb = map(n, p => {
    const y = Math.floor(p / n), x = p - y * n
    const tone = top[p] ? toneW[Math.floor((x / n) * k) % k]! : toneF[Math.floor((y / n) * k) % k]!
    return tone * (0.82 + 0.18 * h[p]!) * (1 + 0.04 * fuzz[p]!)
  })
  return { h, alb, rough: map(n, p => 0.08 * (1 - h[p]!) + 0.03 * fuzz[p]!), strength: 3 }
}

function leather(n: number): Raw {
  const w1 = worley(n, 28, 11), w2 = worley(n, 90, 12), w3 = worley(n, 140, 14)
  const wr = rotFbm(n, 20, 6, 10, 3, 13), lf = fbm(n, 3, 3, 15)
  const h = norm01(map(n, p => {
    const crease = Math.min(1, Math.max(0, (w1.F2[p]! - w1.F1[p]!) / 0.18)) ** 0.7
    const pebble = 1 - Math.min(1, Math.max(0, w1.F1[p]! / 0.75)) ** 2
    const micro = Math.min(1, Math.max(0, (w2.F2[p]! - w2.F1[p]!) / 0.25))
    const pores = w3.F1[p]! < 0.12 ? 1 : 0
    return 0.45 * crease * (0.6 + 0.4 * pebble) + 0.2 * micro - 0.25 * Math.max(0, 0.25 - Math.abs(wr[p]!)) * 4 * 0.3 - 0.08 * pores + 0.1 * lf[p]!
  }))
  const g = gauss(rng(16))
  const tone = Float32Array.from({ length: 28 * 28 }, () => 1 + 0.05 * g())
  const mod = fbm(n, 4, 6, 17), rn = fbm(n, 3, 8, 18)
  return {
    h,
    alb: map(n, p => tone[w1.ID[p]!]! * (0.78 + 0.22 * h[p]!) * (1 + 0.05 * mod[p]!)),
    rough: map(n, p => -0.12 * h[p]! + 0.06 * rn[p]!),
    strength: 2.5,
  }
}

function metal(n: number): Raw {
  const brushed = rotFbm(n, 0, 25, 30, 4, 21)
  const fine = scratches(n, 420, 22, 0.25, [0.5, 1], 0, 12)
  const rnd = scratches(n, 35, 23, 0.3, [0.6, 1.4], 0, 360)
  const w = worley(n, 40, 24)
  const pitMask = fbm(n, 2, 3, 26), dents = fbm(n, 3, 3, 27)
  const pits = map(n, p => Math.max(0, Math.min(1, 1 - w.F1[p]! / 0.12)) * (pitMask[p]! > 0.6 ? 1 : 0))
  const h = norm01(map(n, p => 0.5 + 0.05 * brushed[p]! - 0.35 * fine[p]! * 0.5 - 0.5 * rnd[p]! * 0.6 - 0.4 * pits[p]! + 0.08 * dents[p]!))
  const grime = norm01(fbm(n, 4, 4, 28))
  return {
    h,
    alb: map(n, p => (1 + 0.05 * brushed[p]!) * (1 - 0.18 * rnd[p]!) * (1 + 0.15 * fine[p]!) * (0.92 + 0.08 * grime[p]!)),
    rough: map(n, p => 0.05 * brushed[p]! + 0.25 * rnd[p]! + 0.12 * fine[p]! + 0.15 * (grime[p]! - 0.5) + 0.3 * pits[p]!),
    strength: 2,
  }
}

function gold(n: number): Raw {
  const w = worley(n, 14, 31)
  const ham = map(n, p => Math.min(1, Math.max(0, w.F1[p]! / 0.7)) ** 2)
  const sc = scratches(n, 120, 32, 0.2, [0.5, 1], 0, 360)
  const fine = fbm(n, 3, 20, 33)
  const h = norm01(map(n, p => 0.7 * ham[p]! - 0.3 * sc[p]! + 0.05 * fine[p]!))
  const tarn = norm01(fbm(n, 4, 5, 34))
  return {
    h,
    alb: map(n, p => (0.93 + 0.1 * ham[p]!) * (1 - 0.1 * tarn[p]! * (1 - ham[p]!))),
    rough: map(n, p => 0.2 * sc[p]! + 0.12 * (tarn[p]! - 0.5) - 0.05 * ham[p]!),
    strength: 2,
  }
}

function skin(n: number): Raw {
  const w = worley(n, 48, 41)
  const pores = map(n, p => Math.max(0, Math.min(1, 1 - w.F1[p]! / 0.22)) ** 1.5)
  const x1 = rotFbm(n, 35, 5, 18, 2, 42), x2 = rotFbm(n, -40, 5, 18, 2, 43)
  const cross = map(n, p => Math.max(0, Math.min(1, 0.35 - Math.min(Math.abs(x1[p]!), Math.abs(x2[p]!)))) / 0.35)
  const bumps = fbm(n, 3, 10, 44), blot = fbm(n, 3, 3, 45)
  const h = norm01(map(n, p => 0.5 - 0.6 * pores[p]! - 0.12 * cross[p]! + 0.1 * bumps[p]!))
  return {
    h,
    alb: map(n, p => (1 - 0.1 * pores[p]!) * (1 + 0.035 * blot[p]!) * (1 - 0.03 * cross[p]!)),
    rough: map(n, p => 0.1 * pores[p]! + 0.06 * cross[p]! - 0.04 * bumps[p]!),
    strength: 1.5,
  }
}

function hair(n: number): Raw {
  const strands = rotFbm(n, 90, 40, 70, 3, 51), clump = rotFbm(n, 90, 10, 12, 2, 52)
  const h = norm01(map(n, p => 0.7 * strands[p]! + 0.4 * clump[p]!))
  return { h, alb: map(n, p => 0.85 + 0.3 * h[p]!), rough: map(n, p => -0.12 * h[p]!), strength: 2 }
}

/** Wood grain (new; for the review's relabel of painted wood, which leather's pebbles turned into "reptile skin"). */
function wood(n: number): Raw {
  const grain = rotFbm(n, 90, 20, 24, 3, 61), fibre = rotFbm(n, 90, 8, 6, 2, 62), pores = fbm(n, 2, 40, 63), rn = fbm(n, 3, 6, 64)
  const h = norm01(map(n, p => 0.6 * grain[p]! + 0.25 * fibre[p]! + 0.1 * pores[p]!))
  return { h, alb: map(n, p => 0.9 + 0.2 * h[p]!), rough: map(n, p => -0.06 * h[p]! + 0.04 * rn[p]!), strength: 2 }
}

/**
 * Polished jade (new; the review's relabel of sword_02's blade, which cloth's weave turned into fabric): a soft cloudy
 * body with a few faint veins, almost no relief, glossier in the clear parts.
 */
function jade(n: number): Raw {
  const cloud = fbm(n, 4, 3, 71), fine = fbm(n, 3, 12, 72), vein = rotFbm(n, 30, 6, 4, 3, 73)
  const v = map(n, p => Math.max(0, 1 - Math.abs(vein[p]!) * 6))
  const h = norm01(map(n, p => 0.3 * cloud[p]! + 0.08 * fine[p]! - 0.25 * v[p]!))
  return {
    h,
    alb: map(n, p => (1 + 0.06 * cloud[p]!) * (1 - 0.12 * v[p]!)),
    rough: map(n, p => -0.04 * cloud[p]! + 0.08 * v[p]!),
    strength: 0.6,
  }
}

const GENERATORS: Record<MaskClass, (n: number) => Raw> = { cloth, leather, metal, gold, skin, hair, wood, jade }

const cache = new Map<string, DetailTile>()

/** The detail tile of a class (memoised per process). The albedo multiplier is renormalised to mean 1. */
export function detailTile(cls: MaskClass, n = DETAIL_N): DetailTile {
  const id = `${cls}@${n}`
  let t = cache.get(id)
  if (!t) {
    const r = GENERATORS[cls](n)
    let mean = 0
    for (let p = 0; p < n * n; p++) mean += r.alb[p]!
    mean /= n * n
    for (let p = 0; p < n * n; p++) r.alb[p] = r.alb[p]! / mean
    t = { n, h: r.h, alb: r.alb, rough: r.rough, strength: r.strength, nrm: tileNormal(r.h, n, r.strength * 6) }
    cache.set(id, t)
  }
  return t
}

export function allDetailTiles(n = DETAIL_N): Record<MaskClass, DetailTile> {
  return Object.fromEntries(MASK_CLASSES.map(c => [c, detailTile(c, n)])) as Record<MaskClass, DetailTile>
}

// ---- sampling onto a master (dlib `tile_to` + `prefilter`) --------------------------------------------------------------

/** Wrap-blurs a tile field of `c` channels so one output texel does not alias `ratio` tile texels (a mip's job). */
function prefilter(field: Float32Array, n: number, c: number, ratio: number): Float32Array {
  if (ratio <= 1) return field
  const sigma = 0.5 * Math.sqrt(ratio * ratio - 1)
  if (c === 1) return blurBuffer(field, n, n, sigma, ['wrap', 'wrap'])
  const out = new Float32Array(field.length)
  for (let k = 0; k < c; k++) {
    const ch = new Float32Array(n * n)
    for (let p = 0; p < n * n; p++) ch[p] = field[p * c + k]!
    const b = blurBuffer(ch, n, n, sigma, ['wrap', 'wrap'])
    for (let p = 0; p < n * n; p++) out[p * c + k] = b[p]!
  }
  if (c === 3) {
    for (let p = 0; p < n * n; p++) {
      const l = Math.hypot(out[p * 3]!, out[p * 3 + 1]!, out[p * 3 + 2]!) || 1
      out[p * 3] /= l
      out[p * 3 + 1] /= l
      out[p * 3 + 2] /= l
    }
  }
  return out
}

/**
 * Samples a tile field (c channels) over a W×H master with `repeats` tiles per master width, bilinear and wrapped.
 * Texels are square, so V advances by the same tile texels per master texel as U. `only(p)` skips texels (masks).
 */
export function sampleTile(field: Float32Array, n: number, c: number, W: number, H: number, repeats: number, only?: (p: number) => boolean): Float32Array {
  const perTexel = (repeats * n) / W
  const f = prefilter(field, n, c, perTexel)
  const out = new Float32Array(W * H * c)
  for (let y = 0; y < H; y++) {
    const v = y * perTexel
    const y0 = Math.floor(v), ty = v - y0
    const ya = ((y0 % n) + n) % n, yb = (ya + 1) % n
    for (let x = 0; x < W; x++) {
      const p = y * W + x
      if (only && !only(p)) continue
      const u = x * perTexel
      const x0 = Math.floor(u), tx = u - x0
      const xa = ((x0 % n) + n) % n, xb = (xa + 1) % n
      for (let k = 0; k < c; k++) {
        const a = f[(ya * n + xa) * c + k]!, b = f[(ya * n + xb) * c + k]!
        const cc = f[(yb * n + xa) * c + k]!, d = f[(yb * n + xb) * c + k]!
        out[p * c + k] = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty
      }
    }
  }
  return out
}
