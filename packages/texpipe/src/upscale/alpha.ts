/**
 * TP-U alpha handling (docs/TEXPIPE.md §3.4 rule 3).
 *
 * - The model gets RGB only. Before it runs, **alpha bleed**: transparent texels take the colour of the nearest
 *   opaque ones (a premultiplied blur at 3 scales, the prototype's `bleed`), so the model does not sharpen the matte
 *   colour into the edges (the red leaf fringe in `compare_actor.png`). Opaque texels are never changed.
 * - Alpha itself is upscaled with Lanczos3 (the runner, through sharp).
 * - `cutout`: re-threshold with a ~2 px ramp around the cutoff, and **coverage-preserving mips**: each mip's alpha is
 *   scaled so the fraction of texels at or above the cutoff equals the top level's (Castaño's method), so foliage and
 *   hair do not thin out at distance. KTX2 (v2) ships those mips; v1 WebP records the per-mip scales in the upscale
 *   index for the runtime (TX-R) to apply.
 * - `specmask` alpha stays a mask (Lanczos3, no bleed, no threshold); it feeds metallic in TP-P.
 *
 * Pure: plain byte images, no sharp, no node:*.
 */
import type { AlphaKind } from '../format.ts'
import { rawImage, type RawImage } from './pad.ts'

/** The alpha-test cutoff (glTF MASK default). */
export const ALPHA_CUTOFF = 0.5
/** The re-threshold ramp width in output pixels. */
export const CUTOUT_RAMP_PX = 2
/** Blur scales (px, source size) of the bleed; a texel takes the first scale that reaches any opaque texel. */
export const BLEED_SIGMAS = [2, 8, 32] as const

/** The alpha at or above which a texel counts as opaque for the bleed: cutout 0.5 (the test), blend any alpha. */
export function bleedThreshold(kind: AlphaKind): number {
  return kind === 'cutout' ? 128 : 1
}

/** Only transparency is bled; `specmask` and `none` keep their colours. */
export function needsBleed(kind: AlphaKind): boolean {
  return kind === 'cutout' || kind === 'blend'
}

/**
 * Box blur of a single-channel float plane along one axis, window 2r+1, with zero outside the image on a clamped
 * axis (the caller normalises by a blurred weight plane, so zero padding cancels out) and wrap-around on a repeating
 * axis.
 */
function boxAxis(src: Float32Array, w: number, h: number, r: number, horizontal: boolean, wrap: boolean): Float32Array {
  const out = new Float32Array(src.length)
  const n = horizontal ? w : h
  const lines = horizontal ? h : w
  const stride = horizontal ? 1 : w
  const lineStep = horizontal ? w : 1
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep
    const get = (i: number): number => {
      if (i < 0 || i >= n) {
        if (!wrap) return 0
        i = ((i % n) + n) % n
      }
      return src[base + i * stride]!
    }
    let sum = 0
    for (let i = -r; i <= r; i++) sum += get(i)
    for (let i = 0; i < n; i++) {
      out[base + i * stride] = sum
      sum += get(i + r + 1) - get(i - r)
    }
  }
  return out
}

/** ~Gaussian blur (three box passes per axis) of a float plane, wrap per axis. */
function blurPlane(src: Float32Array, w: number, h: number, sigma: number, wrap: readonly [boolean, boolean]): Float32Array {
  const r = Math.max(1, Math.round(sigma))
  let p = src
  for (let pass = 0; pass < 3; pass++) {
    p = boxAxis(p, w, h, Math.min(r, Math.max(1, (w >> 1) - 1)), true, wrap[0])
    p = boxAxis(p, w, h, Math.min(r, Math.max(1, (h >> 1) - 1)), false, wrap[1])
  }
  return p
}

/**
 * Alpha bleed of an RGBA image: every texel with alpha below `threshold` takes the premultiplied, blurred colour of
 * the opaque texels around it (the smallest of `BLEED_SIGMAS` that reaches one), and any texel still unreached takes
 * the mean opaque colour. Alpha and every opaque texel are unchanged. Returns a new image.
 */
export function bleedAlpha(img: RawImage, opts: { threshold?: number; wrap?: readonly [boolean, boolean] } = {}): RawImage {
  if (img.channels !== 4) throw new Error(`bleedAlpha: expected RGBA, got ${img.channels} channels`)
  const threshold = opts.threshold ?? 128
  const wrap = opts.wrap ?? [false, false]
  const { width: w, height: h } = img
  const N = w * h
  const out = rawImage(w, h, 4, Uint8Array.from(img.data))
  const opaque = new Float32Array(N)
  let nOpaque = 0
  const mean = [0, 0, 0]
  for (let p = 0; p < N; p++) {
    if (img.data[p * 4 + 3]! >= threshold) {
      opaque[p] = 1
      nOpaque++
      for (let k = 0; k < 3; k++) mean[k]! += img.data[p * 4 + k]!
    }
  }
  if (nOpaque === 0 || nOpaque === N) return out
  const filled = new Uint8Array(N)
  for (let p = 0; p < N; p++) filled[p] = opaque[p]!
  let left = N - nOpaque
  for (const sigma of BLEED_SIGMAS) {
    if (!left) break
    const wgt = blurPlane(opaque, w, h, sigma, wrap)
    const acc = [0, 1, 2].map(k => {
      const plane = new Float32Array(N)
      for (let p = 0; p < N; p++) plane[p] = opaque[p]! * img.data[p * 4 + k]!
      return blurPlane(plane, w, h, sigma, wrap)
    })
    for (let p = 0; p < N; p++) {
      if (filled[p] || wgt[p]! < 1e-4) continue
      for (let k = 0; k < 3; k++) out.data[p * 4 + k] = Math.min(255, Math.max(0, Math.round(acc[k]![p]! / wgt[p]!)))
      filled[p] = 1
      left--
    }
  }
  if (left) {
    const m = mean.map(v => Math.round(v / nOpaque))
    for (let p = 0; p < N; p++) {
      if (filled[p]) continue
      for (let k = 0; k < 3; k++) out.data[p * 4 + k] = m[k]!
    }
  }
  return out
}

/**
 * Cutout re-threshold after a Lanczos upscale by `scale`: a source edge spreads over about `scale` output pixels, so
 * the ramp is steepened by `scale / rampPx` around the cutoff (`a' = 0.5 + (a − 0.5) × scale / rampPx`). Texels on
 * the cutoff stay on it, so the alpha-tested silhouette does not move. In place; returns `alpha`.
 */
export function rethreshold(alpha: Uint8Array, scale: number, rampPx = CUTOUT_RAMP_PX, cutoff = ALPHA_CUTOFF): Uint8Array {
  const k = Math.max(1, scale / rampPx)
  for (let i = 0; i < alpha.length; i++) {
    const a = cutoff + (alpha[i]! / 255 - cutoff) * k
    alpha[i] = Math.round(Math.min(1, Math.max(0, a)) * 255)
  }
  return alpha
}

/** The cutoff as a byte: a texel passes the alpha test when `alpha ≥ cutoffByte`. */
export function cutoffByte(cutoff = ALPHA_CUTOFF): number {
  return Math.round(cutoff * 255)
}

/** The fraction of texels that pass the alpha test. */
export function coverage(alpha: Uint8Array, cutoff = ALPHA_CUTOFF, scale = 1): number {
  if (!alpha.length) return 0
  const c = cutoffByte(cutoff)
  let n = 0
  if (scale === 1) {
    for (let i = 0; i < alpha.length; i++) if (alpha[i]! >= c) n++
  } else {
    for (let i = 0; i < alpha.length; i++) if (Math.min(255, Math.round(alpha[i]! * scale)) >= c) n++
  }
  return n / alpha.length
}

/**
 * One box-filtered mip of a single-channel plane: max(1, ⌊w/2⌋) × max(1, ⌊h/2⌋), each texel the mean of the source
 * texels it covers (odd sizes fold the last row or column in). Wrap does not matter for a 2:1 box.
 */
export function downsampleAlpha(src: Uint8Array, w: number, h: number): { data: Uint8Array; width: number; height: number } {
  const W = Math.max(1, w >> 1)
  const H = Math.max(1, h >> 1)
  const out = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * h) / H)
    const y1 = Math.floor(((y + 1) * h) / H)
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * w) / W)
      const x1 = Math.floor(((x + 1) * w) / W)
      let s = 0
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += src[yy * w + xx]!
      out[y * W + x] = Math.round(s / ((y1 - y0) * (x1 - x0)))
    }
  }
  return { data: out, width: W, height: H }
}

export interface AlphaMip {
  width: number
  height: number
  /** The scaled alpha of this level (level 0 is the input, unscaled). */
  data: Uint8Array
  /** The factor this level's box-filtered alpha was multiplied by (1 for level 0). */
  scale: number
  /** Its coverage after scaling. */
  coverage: number
}

/**
 * Coverage-preserving mips (Castaño 2010): box mips of the *unscaled* alpha, each multiplied by the factor (found by
 * bisection) that brings its coverage closest to level 0's. Down to 1×1.
 */
export function coverageMips(alpha: Uint8Array, width: number, height: number, cutoff = ALPHA_CUTOFF): AlphaMip[] {
  const target = coverage(alpha, cutoff)
  const mips: AlphaMip[] = [{ width, height, data: alpha, scale: 1, coverage: target }]
  let cur = { data: alpha, width, height }
  while (cur.width > 1 || cur.height > 1) {
    cur = downsampleAlpha(cur.data, cur.width, cur.height)
    const s = coverageScale(cur.data, target, cutoff)
    const data = new Uint8Array(cur.data.length)
    for (let i = 0; i < data.length; i++) data[i] = Math.min(255, Math.round(cur.data[i]! * s))
    mips.push({ width: cur.width, height: cur.height, data, scale: s, coverage: coverage(data, cutoff) })
  }
  return mips
}

/** The alpha multiplier in [0, 16] whose coverage is closest to `target` (coverage grows with the multiplier). */
export function coverageScale(alpha: Uint8Array, target: number, cutoff = ALPHA_CUTOFF): number {
  let lo = 0
  let hi = 16
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (coverage(alpha, cutoff, mid) < target) lo = mid
    else hi = mid
  }
  // hi reaches the target (or 16 if nothing does); lo is just below it: keep whichever lands closer.
  const dHi = Math.abs(coverage(alpha, cutoff, hi) - target)
  const dLo = Math.abs(coverage(alpha, cutoff, lo) - target)
  return dLo < dHi ? lo : hi
}

/** The alpha channel of an RGBA image as a single-channel image. */
export function alphaPlane(img: RawImage): RawImage {
  if (img.channels !== 4) throw new Error(`alphaPlane: expected RGBA, got ${img.channels} channels`)
  const px = img.width * img.height
  const out = rawImage(img.width, img.height, 1)
  for (let p = 0; p < px; p++) out.data[p] = img.data[p * 4 + 3]!
  return out
}

