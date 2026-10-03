/**
 * TP-P albedo grade for terrain sets (P-LOOK, wave 10 polish): a per-channel tint in linear light and a tileable sand
 * grain, both from `content/texpipe/overrides.json` (`pbr.albedoTint`, `pbr.grain`).
 *
 * - **Tint:** × [r, g, b] in linear light (alpha kept), like `albedoGain` per channel. The dry beach sand (tile 407 and
 *   412) is a pale grey-beige in retail; under the PBR noon sun it read almost white, so its sets are warmed to a golden
 *   sand (less blue and green, a little less red) instead of changing the exposure for everything.
 * - **Grain:** the de-lit remaster of a fine sand is nearly flat (σ ≈ 3 levels at 1024²), so Medium (no layer normals)
 *   showed no grain at all. The grain is a multiplicative luminance field in master texels: fine value noise (2 texels)
 *   and white noise (per texel and per 4 × 4 texels, the texel of the 512 tier Medium draws), a soft mottling (32 and
 *   128 texels), sparse dark mineral grains and a few bright shell or quartz bits (2 × 2 texels). Every lattice period divides the image, so the grain wraps on both axes; it is deterministic
 *   from the texture key's seed. `amount` scales the whole field (1 = the tuned sand).
 *
 * Pure: the albedo is sRGB 0..1 (derive.ts `Img`), RGBA or RGB.
 */
import { linToSrgb, srgbToLin, type Img } from './image.ts'

/** Per-texel hash in 0..1 (integer lattice point and seed). */
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return ((h ^ (h >>> 16)) & 0xffffff) / 0xffffff
}

/** Tileable value noise: `cells` lattice cells across each axis (periodic on the image), 0..1. */
function latticeNoise(w: number, h: number, cellsX: number, cellsY: number, seed: number, out: Float32Array, weight: number): void {
  const sm = (t: number) => t * t * (3 - 2 * t)
  for (let y = 0; y < h; y++) {
    const fy = (y * cellsY) / h
    const iy = Math.floor(fy)
    const ty = sm(fy - iy)
    const y0 = iy % cellsY, y1 = (iy + 1) % cellsY
    for (let x = 0; x < w; x++) {
      const fx = (x * cellsX) / w
      const ix = Math.floor(fx)
      const tx = sm(fx - ix)
      const x0 = ix % cellsX, x1 = (ix + 1) % cellsX
      const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed)
      out[y * w + x] += weight * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty - 0.5)
    }
  }
}

/** The lattice cells across an axis of `n` texels for features about `texels` texels wide (a whole number: periodic). */
function cellsFor(n: number, texels: number): number {
  return Math.max(1, Math.round(n / texels))
}

/**
 * The grain multiplier per texel (mean ≈ 1): `1 + amount × (fine ± 3 % + white ± 2.5 % + 4-texel white ± 4 % + mottling
 * ± 5 %)`, with 1.5 % dark grains (× 0.62) and 1 % bright bits (× 1.12) at full amount.
 */
export function grainField(w: number, h: number, amount: number, seed: number): Float32Array {
  const n = new Float32Array(w * h)
  if (!(amount > 0)) return n.fill(1)
  latticeNoise(w, h, cellsFor(w, 2), cellsFor(h, 2), seed + 1, n, 0.06)
  latticeNoise(w, h, cellsFor(w, 32), cellsFor(h, 32), seed + 3, n, 0.06)
  latticeNoise(w, h, cellsFor(w, 128), cellsFor(h, 128), seed + 4, n, 0.04)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      // White noise per texel and per 4 × 4 texels (one texel of the retail-size tier Medium draws at, 1.6 cm).
      let g = 1 + n[p]! + 0.05 * (hash(x, y, seed) - 0.5) + 0.08 * (hash(x >> 2, y >> 2, seed + 5) - 0.5)
      // 2 × 2-texel grains (whole cells on even sizes, so they repeat with the tile).
      const s = hash(x >> 1, y >> 1, seed + 2)
      if (s > 0.985) g *= 0.62
      else if (s < 0.01) g *= 1.12
      n[p] = 1 + (g - 1) * amount
    }
  }
  return n
}

/** The albedo graded: × tint per channel and × the grain, in linear light, clamped at 1 (alpha kept). */
export function gradeAlbedo(im: Img, tint: readonly [number, number, number], grain: number, seed: number): Img {
  const o: Img = { w: im.w, h: im.h, c: im.c, d: new Float32Array(im.d) }
  const g = grain > 0 ? grainField(im.w, im.h, grain, seed) : null
  const N = im.w * im.h
  for (let p = 0; p < N; p++) {
    const k = g ? g[p]! : 1
    for (let c = 0; c < 3; c++) {
      const i = p * im.c + c
      o.d[i] = linToSrgb(Math.min(1, srgbToLin(im.d[i]!) * tint[c]! * k))
    }
  }
  return o
}
