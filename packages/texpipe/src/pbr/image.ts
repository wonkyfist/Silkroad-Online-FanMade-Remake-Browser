/**
 * TP-P float images (docs/TEXPIPE.md §3.5–3.7): the Float32 image every PBR stage works on, colour conversions, and
 * the blurs, with the three things the stages need from them:
 *
 *   - **per-axis wrap**: a tileable texture is blurred around its edges only along the axes its UVs repeat, so a
 *     tileable input gives a tileable output (the translation-equivariance test);
 *   - **regions**: an atlas is processed per UV island (islands.ts) and a cutout only inside its opaque texels. A
 *     region blur is a normalised convolution, `blur(x·m) / blur(m)` with `m` = the texel's own region, so one
 *     island never averages in the gutter, the transparent matte or a neighbouring island;
 *   - **speed**: a Gaussian of σ ≥ 2.5 is three box passes per axis (O(1) per texel whatever σ), a small σ is an exact
 *     separable kernel. 2048² at any σ is ~40 ms.
 *
 * Pure: no node:*, no sharp (io.ts reads and writes files). Images are interleaved, `c` channels, row-major, y down
 * (texel (x, y) is v = (y + 0.5) / h in glTF UV space).
 */

export interface Img {
  w: number
  h: number
  c: number
  d: Float32Array
}

/** The axes a texture repeats along [U, V] (inventory `wrap`). */
export type Wrap = readonly [boolean, boolean]
export const NO_WRAP: Wrap = [false, false]

/**
 * The regions of an image: `ids[p]` = the region of texel p (≥ 0), or −1 for a texel no stage reads (the gutter of an
 * atlas, the transparent part of a cutout). `boxes[i]` = [x0, y0, x1, y1) of region i. One region covering every
 * texel is the same as no regions.
 */
export interface Regions {
  w: number
  h: number
  ids: Int32Array
  count: number
  boxes: [number, number, number, number][]
}

export function img(w: number, h: number, c = 1, fill = 0): Img {
  const d = new Float32Array(w * h * c)
  if (fill !== 0) d.fill(fill)
  return { w, h, c, d }
}

export function clone(im: Img): Img {
  return { w: im.w, h: im.h, c: im.c, d: im.d.slice() }
}

/** Channel k as a one-channel image. */
export function channel(im: Img, k: number): Img {
  const o = img(im.w, im.h, 1)
  const n = im.w * im.h
  for (let p = 0; p < n; p++) o.d[p] = im.d[p * im.c + k]!
  return o
}

/** Interleaves one-channel images of equal size into one image. */
export function merge(planes: readonly Img[]): Img {
  const { w, h } = planes[0]!
  const c = planes.length
  const o = img(w, h, c)
  const n = w * h
  for (let k = 0; k < c; k++) {
    const src = planes[k]!.d
    for (let p = 0; p < n; p++) o.d[p * c + k] = src[p]!
  }
  return o
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

export function srgbToLin(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

export function linToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
}

/** Linear luminance (Rec. 709) of an sRGB RGB(A) image. */
export function luminance(rgb: Img): Img {
  const o = img(rgb.w, rgb.h, 1)
  const n = rgb.w * rgb.h, c = rgb.c
  for (let p = 0; p < n; p++) {
    o.d[p] = 0.2126 * srgbToLin(rgb.d[p * c]!) + 0.7152 * srgbToLin(rgb.d[p * c + 1]!) + 0.0722 * srgbToLin(rgb.d[p * c + 2]!)
  }
  return o
}

// ---- 1-D passes ------------------------------------------------------------------------------------------------------

/** How a pass reads past the end of a line: around (`wrap`), the edge texel (`clamp`) or nothing (`zero`). */
export type Edge = 'wrap' | 'clamp' | 'zero'

/**
 * One box pass of radius r along x (horiz) or y over a w×h one-channel buffer, sum / (2r + 1). A texel past the end
 * is read per `edge` (`zero` adds nothing, so a normalised convolution stays exact at the border).
 */
function boxPass(src: Float32Array, w: number, h: number, r: number, horiz: boolean, edge: Edge, out: Float32Array): void {
  const n = horiz ? w : h, lines = horiz ? h : w
  const step = horiz ? 1 : w
  const inv = 1 / (2 * r + 1)
  for (let l = 0; l < lines; l++) {
    const base = horiz ? l * w : l
    const at = (i: number): number => {
      if (i >= 0 && i < n) return src[base + i * step]!
      if (edge === 'zero') return 0
      if (edge === 'wrap') return src[base + (((i % n) + n) % n) * step]!
      return src[base + (i < 0 ? 0 : n - 1) * step]!
    }
    let acc = 0
    for (let i = -r; i <= r; i++) acc += at(i)
    for (let i = 0; i < n; i++) {
      out[base + i * step] = acc * inv
      acc += at(i + r + 1) - at(i - r)
    }
  }
}

/** One exact Gaussian pass (kernel radius ⌈3σ⌉) along one axis. */
function gaussPass(src: Float32Array, w: number, h: number, sigma: number, horiz: boolean, edge: Edge, out: Float32Array): void {
  const r = Math.max(1, Math.ceil(3 * sigma))
  const k = new Float32Array(2 * r + 1)
  let s = 0
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i] /= s
  const n = horiz ? w : h, lines = horiz ? h : w
  const step = horiz ? 1 : w
  for (let l = 0; l < lines; l++) {
    const base = horiz ? l * w : l
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let j = -r; j <= r; j++) {
        let q = i + j
        if (q < 0 || q >= n) {
          if (edge === 'zero') continue
          q = edge === 'wrap' ? ((q % n) + n) % n : q < 0 ? 0 : n - 1
        }
        acc += k[j + r]! * src[base + q * step]!
      }
      out[base + i * step] = acc
    }
  }
}

/** Box radius whose three passes have variance σ² (three boxes of radius r: σ² = r(r + 1)). */
export function boxRadius(sigma: number): number {
  return Math.max(1, Math.round(Math.sqrt(0.25 + sigma * sigma) - 0.5))
}

/** Gaussian blur of a one-channel buffer, edges per axis [x, y]. σ < 0.3 copies. */
export function blurBuffer(src: Float32Array, w: number, h: number, sigma: number, edges: readonly [Edge, Edge]): Float32Array {
  if (!(sigma >= 0.3)) return src.slice()
  const a = new Float32Array(src.length)
  const b = new Float32Array(src.length)
  if (sigma < 2.5) {
    gaussPass(src, w, h, sigma, true, edges[0], a)
    gaussPass(a, w, h, sigma, false, edges[1], b)
    return b
  }
  const r = boxRadius(sigma)
  boxPass(src, w, h, r, true, edges[0], a)
  boxPass(a, w, h, r, true, edges[0], b)
  boxPass(b, w, h, r, true, edges[0], a)
  boxPass(a, w, h, r, false, edges[1], b)
  boxPass(b, w, h, r, false, edges[1], a)
  boxPass(a, w, h, r, false, edges[1], b)
  return b
}

/** Gaussian blur of a one-channel image: wrap along the repeating axes, clamp along the others. */
export function blur(im: Img, sigma: number, wrap: Wrap = NO_WRAP): Img {
  if (im.c !== 1) throw new Error('blur: one channel only')
  const edges: [Edge, Edge] = [wrap[0] ? 'wrap' : 'clamp', wrap[1] ? 'wrap' : 'clamp']
  return { w: im.w, h: im.h, c: 1, d: blurBuffer(im.d, im.w, im.h, sigma, edges) }
}

/**
 * Region-aware Gaussian blur of a one-channel image (normalised convolution per region). Without regions it is
 * `blur`. With regions every texel of region i is the weighted mean of region i's texels only; texels outside every
 * region (id −1) keep their input value. A region is blurred over its own box with `zero` edges (islands of an atlas
 * never wrap), or over the whole image with the wrap axes when the image has a single region.
 */
export function regionBlur(im: Img, sigma: number, wrap: Wrap, regions: Regions | null): Img {
  if (!regions) return blur(im, sigma, wrap)
  const { w, h } = im
  const out = im.d.slice()
  const ids = regions.ids
  if (regions.count === 1) {
    const edges: [Edge, Edge] = [wrap[0] ? 'wrap' : 'zero', wrap[1] ? 'wrap' : 'zero']
    const m = new Float32Array(w * h)
    const xm = new Float32Array(w * h)
    for (let p = 0; p < w * h; p++) {
      if (ids[p] === 0) {
        m[p] = 1
        xm[p] = im.d[p]!
      }
    }
    const bm = blurBuffer(m, w, h, sigma, edges)
    const bx = blurBuffer(xm, w, h, sigma, edges)
    for (let p = 0; p < w * h; p++) if (ids[p] === 0) out[p] = bm[p]! > 1e-8 ? bx[p]! / bm[p]! : im.d[p]!
    return { w, h, c: 1, d: out }
  }
  for (let r = 0; r < regions.count; r++) {
    const box: readonly number[] = regions.boxes[r]!
    const x0 = box[0]!, y0 = box[1]!, x1 = box[2]!, y1 = box[3]!
    const bw = x1 - x0, bh = y1 - y0
    if (bw <= 0 || bh <= 0) continue
    const m = new Float32Array(bw * bh)
    const xm = new Float32Array(bw * bh)
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const p = (y + y0) * w + x + x0
        if (ids[p] === r) {
          m[y * bw + x] = 1
          xm[y * bw + x] = im.d[p]!
        }
      }
    }
    const bm = blurBuffer(m, bw, bh, sigma, ['zero', 'zero'])
    const bx = blurBuffer(xm, bw, bh, sigma, ['zero', 'zero'])
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const p = (y + y0) * w + x + x0
        const q = y * bw + x
        if (ids[p] === r) out[p] = bm[q]! > 1e-8 ? bx[q]! / bm[q]! : im.d[p]!
      }
    }
  }
  return { w, h, c: 1, d: out }
}

/** Regions of a whole image: one region, minus the texels `keep(p)` rejects (a cutout's transparent matte). */
export function wholeRegion(w: number, h: number, keep?: (p: number) => boolean): Regions {
  const ids = new Int32Array(w * h)
  if (keep) for (let p = 0; p < w * h; p++) ids[p] = keep(p) ? 0 : -1
  return { w, h, ids, count: 1, boxes: [[0, 0, w, h]] }
}

/** Restricts regions to the texels `keep(p)` accepts (a cutout inside an atlas). */
export function restrictRegions(r: Regions, keep: (p: number) => boolean): Regions {
  const ids = r.ids.slice()
  for (let p = 0; p < ids.length; p++) if (ids[p]! >= 0 && !keep(p)) ids[p] = -1
  return { ...r, ids }
}

// ---- statistics -------------------------------------------------------------------------------------------------------

/** The q-quantile (0..1) of the values, over the texels with `ids[p] ≥ 0` when ids are given. */
export function quantile(values: Float32Array, q: number, ids?: Int32Array | null): number {
  return regionQuantiles(values, ids ? ids.map(i => (i >= 0 ? 0 : -1)) : null, 1, [q])[0]![0]!
}

const QBINS = 4096

/**
 * Quantiles per region from a histogram (4096 bins between each region's min and max, linear inside a bin): within
 * 1/4096 of the range of the exact value, and O(n) instead of a sort. `ids` null = every texel is region 0.
 * Returns [region][quantile]; an empty region gives zeros.
 */
export function regionQuantiles(values: Float32Array, ids: Int32Array | null, count: number, qs: readonly number[]): number[][] {
  const lo = new Float64Array(count).fill(Infinity), hi = new Float64Array(count).fill(-Infinity)
  const n = new Float64Array(count)
  for (let p = 0; p < values.length; p++) {
    const r = ids ? ids[p]! : 0
    if (r < 0) continue
    const v = values[p]!
    if (v < lo[r]!) lo[r] = v
    if (v > hi[r]!) hi[r] = v
    n[r]++
  }
  const hist = new Float64Array(count * QBINS)
  for (let p = 0; p < values.length; p++) {
    const r = ids ? ids[p]! : 0
    if (r < 0) continue
    const span = hi[r]! - lo[r]!
    const b = span > 0 ? Math.min(QBINS - 1, Math.floor(((values[p]! - lo[r]!) / span) * QBINS)) : 0
    hist[r * QBINS + b]++
  }
  const out: number[][] = []
  for (let r = 0; r < count; r++) {
    if (!n[r]) {
      out.push(qs.map(() => 0))
      continue
    }
    const span = hi[r]! - lo[r]!
    out.push(qs.map(q => {
      const target = Math.max(0, Math.min(1, q)) * n[r]!
      let acc = 0
      for (let b = 0; b < QBINS; b++) {
        const c = hist[r * QBINS + b]!
        if (acc + c >= target && c > 0) return lo[r]! + ((b + (target - acc) / c) / QBINS) * span
        acc += c
      }
      return hi[r]!
    }))
  }
  return out
}

/** Mean per region (index = region id; NaN for an empty region). */
export function regionMeans(values: Float32Array, regions: Regions | null): Float64Array {
  if (!regions) {
    let s = 0
    for (let p = 0; p < values.length; p++) s += values[p]!
    return Float64Array.of(values.length ? s / values.length : NaN)
  }
  const sum = new Float64Array(regions.count)
  const cnt = new Float64Array(regions.count)
  for (let p = 0; p < values.length; p++) {
    const r = regions.ids[p]!
    if (r < 0) continue
    sum[r] += values[p]!
    cnt[r]++
  }
  for (let r = 0; r < regions.count; r++) sum[r] = cnt[r]! > 0 ? sum[r]! / cnt[r]! : NaN
  return sum
}

// ---- resampling -----------------------------------------------------------------------------------------------------

/** Box downsample by an integer factor f (the mean of each f×f block); w and h must divide by f. */
export function downsample(im: Img, f: number): Img {
  if (f <= 1) return clone(im)
  const w = Math.floor(im.w / f), h = Math.floor(im.h / f), c = im.c
  const o = img(w, h, c)
  const inv = 1 / (f * f)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < c; k++) {
        let s = 0
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += im.d[((y * f + j) * im.w + x * f + i) * c + k]!
        o.d[(y * w + x) * c + k] = s * inv
      }
    }
  }
  return o
}

/** Bilinear resample to w×h (texel centres aligned; clamp or wrap per axis). */
export function resize(im: Img, w: number, h: number, wrap: Wrap = NO_WRAP): Img {
  const o = img(w, h, im.c)
  const sx = im.w / w, sy = im.h / h
  const ix = (i: number, n: number, wr: boolean) => (wr ? ((i % n) + n) % n : i < 0 ? 0 : i >= n ? n - 1 : i)
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * sy - 0.5
    const y0 = Math.floor(fy), ty = fy - y0
    const ya = ix(y0, im.h, wrap[1]), yb = ix(y0 + 1, im.h, wrap[1])
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) * sx - 0.5
      const x0 = Math.floor(fx), tx = fx - x0
      const xa = ix(x0, im.w, wrap[0]), xb = ix(x0 + 1, im.w, wrap[0])
      for (let k = 0; k < im.c; k++) {
        const a = im.d[(ya * im.w + xa) * im.c + k]!, b = im.d[(ya * im.w + xb) * im.c + k]!
        const c = im.d[(yb * im.w + xa) * im.c + k]!, d = im.d[(yb * im.w + xb) * im.c + k]!
        o.d[(y * w + x) * im.c + k] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
      }
    }
  }
  return o
}

/** Circular shift by (dx, dy) texels (the tileability test's translation). */
export function roll(im: Img, dx: number, dy: number): Img {
  const o = img(im.w, im.h, im.c)
  for (let y = 0; y < im.h; y++) {
    const ty = (((y + dy) % im.h) + im.h) % im.h
    for (let x = 0; x < im.w; x++) {
      const tx = (((x + dx) % im.w) + im.w) % im.w
      for (let k = 0; k < im.c; k++) o.d[(ty * im.w + tx) * im.c + k] = im.d[(y * im.w + x) * im.c + k]!
    }
  }
  return o
}

/**
 * Seam ratio of an image along one axis (TEXPIPE §7.2): the mean |difference| across the wrap edge (last column/row
 * vs the first) over the mean |difference| between adjacent columns/rows inside the image. 1 ≈ seamless. (TEXPIPE's
 * prototype divided by one middle pair only; the mean over all pairs is the same measure with far less noise.)
 */
export function seamRatio(im: Img, axis: 'u' | 'v', channels?: readonly number[]): number {
  const ks = channels ?? Array.from({ length: Math.min(3, im.c) }, (_, i) => i)
  const { w, h, c } = im
  const n = axis === 'u' ? w : h, lines = axis === 'u' ? h : w
  const at = (i: number, l: number, k: number) => im.d[(axis === 'u' ? l * w + i : i * w + l) * c + k]!
  let edge = 0, inner = 0
  for (let l = 0; l < lines; l++) {
    for (const k of ks) {
      edge += Math.abs(at(0, l, k) - at(n - 1, l, k))
      for (let i = 1; i < n; i++) inner += Math.abs(at(i, l, k) - at(i - 1, l, k))
    }
  }
  return edge / Math.max(1e-12, inner / (n - 1))
}

// ---- deterministic randomness (masks, detail tiles) ------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal samples from a uniform generator (Box–Muller). */
export function gauss(rand: () => number): () => number {
  let spare: number | null = null
  return () => {
    if (spare !== null) {
      const s = spare
      spare = null
      return s
    }
    const u = Math.max(1e-12, rand()), v = rand()
    const r = Math.sqrt(-2 * Math.log(u))
    spare = r * Math.sin(2 * Math.PI * v)
    return r * Math.cos(2 * Math.PI * v)
  }
}
