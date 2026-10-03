/**
 * TP-P height (docs/TEXPIPE.md §3.6, with DETAIL L3's mask terms on actor atlases):
 *
 *   Ld = sqrt(luminance(de-lit albedo))                                           perceptual
 *   bk = blur(Ld, {1, 4, 12, 48} · s)                                             s = master texels per source texel
 *   H  = 0.25 (b1 − b4) + 0.35 (b2 − b4) + 0.4 (b3 − b4)                         the lowest band removed: leftover
 *                                                                                  light gradients stay out
 *   H  = clamp(0.5 + (H − m) / max(p98 − p2, R), 0, 1)    m = (p2 + p98) / 2      per UV island on atlases
 *
 * R = HEIGHT_MIN_RANGE is the contrast floor (9B check): without it a nearly flat albedo was stretched to the same
 * full-range relief as cobbles, so faint stains became deep dents with AO (the B1 palace floor slab, plaster and
 * field dirt came out as dark clouds, 10–15 % darker than retail lit). Measured on the B1 hero set (sqrt(Y) units):
 * flat slab 0.029, field dirt 0.032–0.046, field grass 0.037–0.051, city wall cj_wall01 0.082, cobbles 0.087,
 * ginkgo bark 0.100. At 0.08 every set with real relief (the B0-approved wall and bark included) is unchanged, and a
 * flat one keeps relief in proportion to its contrast (the slab 0.36×, dirt and grass about half). For p98 − p2 ≥ R
 * the formula is exactly TEXPIPE's (H − p2) / (p98 − p2).
 *
 * `s` is the upscale factor (4 for a 4× master) instead of TEXPIPE's `w/512`: the two agree on the 512 → 2048 terrain
 * tiles the formula was tuned on, and for the 256-px actor and bark sources the bands now sit at the same size in
 * source texels (DETAIL's scales are in source texels too) rather than half of it.
 *
 * With material masks (actors), two DETAIL L3 terms that made "rivets and the iron band catch the light":
 *   - relief per class: H = 0.5 + (H − 0.5) · Σ w_c macro_c (skin keeps 45% of the albedo relief, gold 120%);
 *   - bevels: + 0.5 · Σ bevel_c · blur(w_c, 0.375 s + 1): metal plates, gold trims and leather straps stand out of the
 *     cloth with soft raised edges, and a rivet (a small metal blob) becomes a dome;
 *   then renormalised (0.5 % / 99.5 %).
 * `invertHeight` (review) flips light-is-high for recessed pale features (white mortar, pale cracks). A cutout's
 * height is set to 0 outside its mask by derive.ts after dilation. Pure.
 */
import { MASK_CLASSES } from '../format.ts'
import { blurBuffer, clamp01, img, luminance, regionBlur, regionQuantiles, type Img, type Regions, type Wrap } from './image.ts'
import { MASK_PARAMS } from './params.ts'

export const HEIGHT_BANDS = [1, 4, 12, 48] as const
export const HEIGHT_WEIGHTS = [0.25, 0.35, 0.4] as const
/** Height of a full bevel in normalised height units (DETAIL's 1.2 against a 0.55-std macro relief). */
export const BEVEL_AMP = 0.5
/** The contrast floor of the albedo relief (see the header), in sqrt(Y) band units. */
export const HEIGHT_MIN_RANGE = 0.08

export interface HeightInput {
  /** De-lit albedo (sRGB RGBA). */
  albedo: Img
  scale: number
  wrap: Wrap
  regions: Regions | null
  invert?: boolean
  /** Material-mask weights at the master size (MASK_CLASSES order). */
  maskWeights?: Float32Array[] | null
}

/** Perceptual luminance sqrt(Y) of an sRGB image. */
export function perceptualLuma(albedo: Img): Img {
  const L = luminance(albedo)
  for (let p = 0; p < L.d.length; p++) L.d[p] = Math.sqrt(L.d[p]!)
  return L
}

/**
 * Normalises values to 0..1 between the lo/hi quantiles, per region when there are several (islands ≥ 64 texels).
 * A region whose quantile range is below `minRange` is centred on 0.5 with that range instead (less relief, not
 * stretched).
 */
export function normaliseRange(v: Float32Array, regions: Regions | null, lo: number, hi: number, minRange = 0): void {
  const n = v.length
  const whole = regionQuantiles(v, regions?.ids ?? null, 1, [lo, hi])[0]!
  const a0 = whole[0]!, b0 = whole[1]!
  let ranges: (readonly [number, number])[] = [[a0, b0]]
  if (regions && regions.count > 1) {
    const counts = new Int32Array(regions.count)
    for (let p = 0; p < n; p++) if (regions.ids[p]! >= 0) counts[regions.ids[p]!]++
    ranges = regionQuantiles(v, regions.ids, regions.count, [lo, hi]).map(([a, b], r): readonly [number, number] => (counts[r]! < 64 ? [a0, b0] : [a!, b!]))
  }
  for (let p = 0; p < n; p++) {
    const r = regions && regions.count > 1 ? regions.ids[p]! : 0
    const [a, b] = r >= 0 ? ranges[r]! : [a0, b0]
    v[p] = b - a >= minRange ? clamp01((v[p]! - a) / Math.max(1e-6, b - a)) : clamp01(0.5 + (v[p]! - (a + b) / 2) / minRange)
  }
}

export function heightMap(inp: HeightInput): Img {
  const { w, h } = inp.albedo
  const Ld = perceptualLuma(inp.albedo)
  const s = inp.scale
  const b = HEIGHT_BANDS.map(k => regionBlur(Ld, k * s, inp.wrap, inp.regions))
  const H = img(w, h, 1)
  const [w1, w2, w3] = HEIGHT_WEIGHTS
  for (let p = 0; p < w * h; p++) {
    const b4 = b[3]!.d[p]!
    H.d[p] = w1 * (b[0]!.d[p]! - b4) + w2 * (b[1]!.d[p]! - b4) + w3 * (b[2]!.d[p]! - b4)
  }
  normaliseRange(H.d, inp.regions, 0.02, 0.98, HEIGHT_MIN_RANGE)
  if (inp.invert) for (let p = 0; p < w * h; p++) H.d[p] = 1 - H.d[p]!
  const mw = inp.maskWeights
  if (mw) {
    const bevel = new Float32Array(w * h)
    const sigma = 0.375 * s + 1
    MASK_CLASSES.forEach((c, ci) => {
      const amp = MASK_PARAMS[c].bevel
      if (!amp) return
      let any = false
      for (let p = 0; p < w * h && !any; p++) if (mw[ci]![p]! > 0.02) any = true
      if (!any) return
      const bl = blurBuffer(mw[ci]!, w, h, sigma, [inp.wrap[0] ? 'wrap' : 'clamp', inp.wrap[1] ? 'wrap' : 'clamp'])
      for (let p = 0; p < w * h; p++) bevel[p] += amp * bl[p]!
    })
    for (let p = 0; p < w * h; p++) {
      let macro = 0
      for (let ci = 0; ci < MASK_CLASSES.length; ci++) macro += mw[ci]![p]! * MASK_PARAMS[MASK_CLASSES[ci]!].macro
      H.d[p] = 0.5 + (H.d[p]! - 0.5) * macro + BEVEL_AMP * bevel[p]!
    }
    normaliseRange(H.d, inp.regions, 0.005, 0.995)
  }
  return H
}
