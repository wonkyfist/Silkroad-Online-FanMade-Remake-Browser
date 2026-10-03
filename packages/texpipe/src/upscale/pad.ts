/**
 * TP-U per-axis wrap padding (docs/TEXPIPE.md §3.4 rules 2 and 4; docs/WAVE_PLAN3.md §7.1).
 *
 * An upscaler (Real-ESRGAN or a resampling kernel) only sees the pixels it is given: at the image edge it pads on its
 * own (zero, reflect or clamp), so a tileable texture comes out with a seam. We pad the source first, P px per side,
 * then upscale and crop the centre (P × scale per side):
 *
 *   - `repeat` (the opposite edge) along the axes the mesh UVs repeat (inventory `wrap`), so the result tiles;
 *   - `copy` (edge clamp) along the others, so a clamped edge is not blended with the opposite side. The prototype
 *     padded every side with `repeat`, which raised the V seam ratio of the U-only wall from 5.1 (source) to 11, the
 *     roof 2.2 → 7.8 and the trunk 2.3 → 2.5 [TEXPIPE §7.2]: the clamped edges were altered;
 *   - atlases (neither axis wraps) are not padded at all (rule 4); UV-island dilation happens later (TP-P).
 *
 * P = min(32, w/4, h/4). Pure: plain byte images, no sharp, no node:*.
 */

/** An interleaved 8-bit image (1–4 channels). sharp's `raw()` output fits as it is. */
export interface RawImage {
  data: Uint8Array
  width: number
  height: number
  channels: number
}

export type EdgeMode = 'repeat' | 'copy'

/** How one texture is padded: `pad` px on every side, `u` for left/right, `v` for top/bottom. */
export interface PadPlan {
  pad: number
  u: EdgeMode
  v: EdgeMode
}

/** The pad cap in source pixels (TEXPIPE §3.4 rule 2). */
export const MAX_PAD = 32

export function rawImage(width: number, height: number, channels: number, data?: Uint8Array): RawImage {
  const n = width * height * channels
  if (data && data.length !== n) throw new Error(`raw image ${width}x${height}x${channels}: expected ${n} bytes, got ${data.length}`)
  return { data: data ?? new Uint8Array(n), width, height, channels }
}

/** The per-axis pad plan of a texture of this size with these wrap axes [U, V]. */
export function padPlan(width: number, height: number, wrap: readonly [boolean, boolean], max = MAX_PAD): PadPlan {
  if (!wrap[0] && !wrap[1]) return { pad: 0, u: 'copy', v: 'copy' }
  const pad = Math.max(0, Math.min(max, Math.floor(width / 4), Math.floor(height / 4)))
  return { pad, u: wrap[0] ? 'repeat' : 'copy', v: wrap[1] ? 'repeat' : 'copy' }
}

/** A source coordinate for an out-of-range index: wrap around (`repeat`) or clamp to the edge (`copy`). */
export function edgeIndex(i: number, n: number, mode: EdgeMode): number {
  if (mode === 'repeat') return ((i % n) + n) % n
  return i < 0 ? 0 : i >= n ? n - 1 : i
}

/** Pads `img` by `plan.pad` px on every side, `plan.u` on the left and right, `plan.v` on the top and bottom. */
export function padImage(img: RawImage, plan: PadPlan): RawImage {
  const { width: w, height: h, channels: c } = img
  const P = plan.pad
  if (P === 0) return img
  if (plan.u === 'repeat' && P > w) throw new Error(`pad ${P} wider than the image (${w})`)
  if (plan.v === 'repeat' && P > h) throw new Error(`pad ${P} taller than the image (${h})`)
  const W = w + 2 * P
  const H = h + 2 * P
  const out = rawImage(W, H, c)
  const xs = new Int32Array(W)
  for (let x = 0; x < W; x++) xs[x] = edgeIndex(x - P, w, plan.u)
  for (let y = 0; y < H; y++) {
    const sy = edgeIndex(y - P, h, plan.v)
    const srow = sy * w * c
    const drow = y * W * c
    for (let x = 0; x < W; x++) {
      const s = srow + xs[x]! * c
      const d = drow + x * c
      for (let k = 0; k < c; k++) out.data[d + k] = img.data[s + k]!
    }
  }
  return out
}

/** A copy of the rectangle (left, top, width, height) of `img`. */
export function cropImage(img: RawImage, left: number, top: number, width: number, height: number): RawImage {
  if (left < 0 || top < 0 || left + width > img.width || top + height > img.height) {
    throw new Error(`crop ${left},${top} ${width}x${height} outside ${img.width}x${img.height}`)
  }
  if (left === 0 && top === 0 && width === img.width && height === img.height) return img
  const c = img.channels
  const out = rawImage(width, height, c)
  for (let y = 0; y < height; y++) {
    const s = ((top + y) * img.width + left) * c
    out.data.set(img.data.subarray(s, s + width * c), y * width * c)
  }
  return out
}

/**
 * The centre of an upscaled padded image: the source's `width × height` at `scale`. Throws when the upscaled image
 * is not exactly `(size + 2P) × scale` (a model that changed the size would shift every UV).
 */
export function cropUpscaled(img: RawImage, plan: PadPlan, scale: number, width: number, height: number): RawImage {
  const P = plan.pad
  const W = (width + 2 * P) * scale
  const H = (height + 2 * P) * scale
  if (img.width !== W || img.height !== H) throw new Error(`upscaled ${img.width}x${img.height}, expected ${W}x${H}`)
  return cropImage(img, P * scale, P * scale, width * scale, height * scale)
}

/** Keeps channels [0, n) (RGBA → RGB with n = 3). */
export function takeChannels(img: RawImage, n: number, from = 0): RawImage {
  if (from === 0 && n === img.channels) return img
  if (from + n > img.channels) throw new Error(`channels ${from}..${from + n} of a ${img.channels}-channel image`)
  const px = img.width * img.height
  const out = rawImage(img.width, img.height, n)
  for (let p = 0; p < px; p++) for (let k = 0; k < n; k++) out.data[p * n + k] = img.data[p * img.channels + from + k]!
  return out
}

/** RGB (3 channels) + alpha (1 channel) → RGBA. */
export function joinAlpha(rgb: RawImage, alpha: RawImage): RawImage {
  if (rgb.channels !== 3 || alpha.channels !== 1 || rgb.width !== alpha.width || rgb.height !== alpha.height) {
    throw new Error(`joinAlpha: ${rgb.width}x${rgb.height}x${rgb.channels} + ${alpha.width}x${alpha.height}x${alpha.channels}`)
  }
  const px = rgb.width * rgb.height
  const out = rawImage(rgb.width, rgb.height, 4)
  for (let p = 0; p < px; p++) {
    out.data[p * 4] = rgb.data[p * 3]!
    out.data[p * 4 + 1] = rgb.data[p * 3 + 1]!
    out.data[p * 4 + 2] = rgb.data[p * 3 + 2]!
    out.data[p * 4 + 3] = alpha.data[p]!
  }
  return out
}

/**
 * Seam ratio of one axis (TEXPIPE §7.2): the mean difference across the wrap (last column → first column for `u`,
 * last row → first row for `v`) over the mean difference between adjacent interior columns (rows). 1 ≈ seamless; a
 * hard seam is several times the interior. Measured over the first `min(3, channels)` channels. On an axis that does
 * not wrap the ratio is not a quality measure: it only shows whether the edges were altered.
 *
 * `period` phase-matches the comparison: only interior pairs that straddle the same lattice as the wrap pair
 * (columns p−1 | p for p = period, 2·period, …) count. Use the upscale factor on an upscaled image: its wrap pair
 * always straddles a source-pixel boundary, where an upscaler (even bilinear) leaves larger steps than inside a
 * pixel, so comparing it with every pair overstates the seam by ~10–40%. The size along the axis must be a multiple
 * of `period`.
 */
export function seamRatio(img: RawImage, axis: 'u' | 'v', period = 1): number {
  const { width: w, height: h, channels: c } = img
  const k3 = Math.min(3, c)
  const len = axis === 'u' ? w : h
  const across = axis === 'u' ? h : w
  const step = Math.max(1, Math.floor(period))
  if (len % step) throw new Error(`seamRatio: ${len} px is not a multiple of the period ${step}`)
  if (len < 3 || len <= step) return 1
  // Offset of texel (i along the axis, j across it), channel k.
  const at = axis === 'u' ? (i: number, j: number) => (j * w + i) * c : (i: number, j: number) => (i * w + j) * c
  let edge = 0
  let inner = 0
  let pairs = 0
  for (let j = 0; j < across; j++) {
    for (let k = 0; k < k3; k++) {
      edge += Math.abs(img.data[at(0, j) + k]! - img.data[at(len - 1, j) + k]!)
      for (let i = step; i < len; i += step) inner += Math.abs(img.data[at(i, j) + k]! - img.data[at(i - 1, j) + k]!)
    }
  }
  for (let i = step; i < len; i += step) pairs++
  const meanInner = inner / pairs
  if (meanInner < 1e-9) return edge < 1e-9 ? 1 : Infinity
  return edge / meanInner
}
