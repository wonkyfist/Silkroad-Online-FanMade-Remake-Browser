/**
 * TP-P de-lighting (docs/TEXPIPE.md §3.5): remove the painted low-frequency light (highlights on roof-tile tops, shaded
 * folds, darkened corners) that would double-shade under PBR lighting.
 *
 *   L = linear luminance, low = blur(L, σ), mean = the mean of L
 *   f = clamp((mean / low)^k, 1/2, 2)
 *   albedo_lin ×= f · g          g = mean(L) / mean(L · f) per region (clamped ×1..×1.5): the mean is kept
 *
 * - σ = √(w·h) / 16 (TEXPIPE's w/16 on a square; the geometric mean keeps a 1:4 roof or wall from getting a σ of a
 *   few source texels, which would flatten its tile shading rather than its lighting gradient);
 * - wrap-aware along the repeating axes (a tileable input stays tileable), and **per region**: an atlas is de-lit per
 *   UV island against the island's own mean (a global mean would pull every island to the same brightness and wash
 *   the painting out); a cutout only over its opaque texels;
 * - one factor for R, G and B, so hue and saturation are kept; the factor is clamped to ×½..×2 so a deep painted
 *   shadow or a hot highlight is only reduced, never inverted;
 * - k = 0 returns the input unchanged (the review's "keep the painted light");
 * - **mean-preserving** (B0 tuning): mean(L · (mean/low)^k) < mean(L) for any k in (0, 1) (Jensen: it is
 *   m^k · E[low^(1−k)] ≤ m), so without `g` de-lighting darkened every set, most where the painted light varies most
 *   (B0 tuning, measured: the lit preview of a Jin wall lost 18 % of its mean linear luminance to de-light alone). `g`
 *   restores the region's mean luminance; texels that clip at 1 are the only loss.
 *
 * It flattens gradients and keeps detail; small painted shadows stay (they become height, §3.6). Pure.
 */
import { clone, linToSrgb, luminance, regionBlur, regionMeans, srgbToLin, type Img, type Regions, type Wrap } from './image.ts'

export const DELIGHT_FACTOR_MIN = 0.5
export const DELIGHT_FACTOR_MAX = 2
/** The largest brightening the mean-preserving gain may apply (a region that was nearly all clipped stays as is). */
export const DELIGHT_GAIN_MAX = 1.5

/** The de-light blur σ in texels for a w×h master. */
export function delightSigma(w: number, h: number): number {
  return Math.sqrt(w * h) / 16
}

/**
 * De-lit copy of an sRGB RGBA image (alpha kept). `regions` limits the statistics and the blur (null = the whole
 * image as one region); texels outside every region are returned unchanged.
 */
export function delight(albedo: Img, k: number, wrap: Wrap, regions: Regions | null): Img {
  if (!(k > 0)) return clone(albedo)
  const { w, h, c } = albedo
  const L = luminance(albedo)
  const low = regionBlur(L, delightSigma(w, h), wrap, regions)
  const means = regionMeans(L.d, regions)
  const f = new Float32Array(w * h)
  for (let p = 0; p < w * h; p++) {
    const r = regions ? regions.ids[p]! : 0
    if (r < 0) continue
    let v = Math.pow(means[r]! / Math.max(1e-4, low.d[p]!), k)
    if (!Number.isFinite(v)) v = 1
    f[p] = Math.min(DELIGHT_FACTOR_MAX, Math.max(DELIGHT_FACTOR_MIN, v))
  }
  // Mean-preserving gain per region: mean(L) / mean(L · f), in linear luminance.
  const lf = new Float32Array(w * h)
  for (let p = 0; p < w * h; p++) lf[p] = L.d[p]! * f[p]!
  const after = regionMeans(lf, regions)
  const gain = Array.from(means, (m, r) => {
    const a = after[r]!
    return a > 1e-6 && Number.isFinite(m) ? Math.min(DELIGHT_GAIN_MAX, Math.max(1, m / a)) : 1
  })
  const out = clone(albedo)
  for (let p = 0; p < w * h; p++) {
    const r = regions ? regions.ids[p]! : 0
    if (r < 0) continue
    const g = f[p]! * gain[r]!
    for (let ch = 0; ch < 3; ch++) out.d[p * c + ch] = linToSrgb(Math.min(1, srgbToLin(albedo.d[p * c + ch]!) * g))
  }
  return out
}
