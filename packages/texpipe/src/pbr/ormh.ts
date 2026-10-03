/**
 * TP-P AO, roughness, metallic and the ORMH pack (docs/TEXPIPE.md §3.7, WAVE_PLAN3 D37: R = AO, G = roughness,
 * B = metallic, A = height, the order of format.ts `ORMH`).
 *
 *   cav   = max(0, blur(H, 6s) − H) + 0.5 · max(0, blur(H, 24s) − H)
 *   ao    = clamp(1 − 2.2 · aoStrength · cav, 0.25, 1)            DETAIL's floor: a painted dark mark is not a hole
 *   rough = base + roughVar · (6 · cav − (luma − 0.5)) + detail    clamped to [0.05, 1]
 *           base = the RENDER class roughness (classes.ts), or on actors Σ w_c · MASK_PARAMS[c].rough (DETAIL L3)
 *
 * Metallic:
 *   - `specmask` sets (inventory `alphaKind` with the corrected rule: an OPAQUE alpha-capable texture whose alpha
 *     varies and whose reason is the generic "specular/env mask" or the equipment verdict "the alpha is a mask", which
 *     is how the Copper Sword `sword1_2_3` qualifies): spec = clamp(1.6 · alpha), the retail env-map mask;
 *       metallic = spec · gate, rough −= 0.3 · spec · gate + 0.15 · spec · (1 − gate)
 *     gate = the metal + gold mask weight on actors with masks (DETAIL: the spec alpha also marks shiny lacquer and
 *     leather, which must stay dielectric and only get glossier), else 1 (TEXPIPE: metallic = the mask);
 *   - no mask alpha: actors with masks get 0.9 · (metal + gold weight); everything else the class metallic (0.9 for
 *     `metal`, 0 otherwise).
 * Pure.
 */
import type { MaterialClassParams } from '../../../world-render/src/pbr/classes.ts'
import { MASK_CLASSES, ORMH } from '../format.ts'
import { clamp01, img, regionBlur, type Img, type Regions, type Wrap } from './image.ts'
import { MASK_PARAMS } from './params.ts'

export const AO_FLOOR = 0.25
export const ROUGH_MIN = 0.05
export const SPEC_GAIN = 1.6
export const METAL_FROM_MASK = 0.9

export interface OrmhInput {
  /** Height 0..1 (with any baked detail). */
  height: Img
  /** Perceptual luma sqrt(Y) of the de-lit albedo. */
  luma: Img
  /** The master albedo's alpha (the retail spec mask on specmask sets). */
  alpha: Float32Array | null
  specmask: boolean
  cls: Readonly<MaterialClassParams>
  aoStrength: number
  roughVar: number
  scale: number
  wrap: Wrap
  regions: Regions | null
  maskWeights?: Float32Array[] | null
  /** Detail roughness offset per texel (baked detail), or null. */
  detailRough?: Float32Array | null
}

export interface OrmhPlanes {
  ao: Float32Array
  rough: Float32Array
  metal: Float32Array
  height: Float32Array
}

export function ormhPlanes(inp: OrmhInput): OrmhPlanes {
  const H = inp.height
  const n = H.w * H.h
  const a1 = regionBlur(H, 6 * inp.scale, inp.wrap, inp.regions)
  const a2 = regionBlur(H, 24 * inp.scale, inp.wrap, inp.regions)
  const mw = inp.maskWeights ?? null
  const iMetal = MASK_CLASSES.indexOf('metal'), iGold = MASK_CLASSES.indexOf('gold')
  const ao = new Float32Array(n), rough = new Float32Array(n), metal = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    const h = H.d[p]!
    const cav = Math.max(0, a1.d[p]! - h) + 0.5 * Math.max(0, a2.d[p]! - h)
    ao[p] = Math.max(AO_FLOOR, Math.min(1, 1 - 2.2 * inp.aoStrength * cav))
    let base = inp.cls.roughness
    let gate = 1
    if (mw) {
      base = 0
      for (let ci = 0; ci < MASK_CLASSES.length; ci++) base += mw[ci]![p]! * MASK_PARAMS[MASK_CLASSES[ci]!].rough
      gate = clamp01(mw[iMetal]![p]! + mw[iGold]![p]!)
    }
    let r = base + inp.roughVar * (6 * cav - (inp.luma.d[p]! - 0.5)) + (inp.detailRough ? inp.detailRough[p]! : 0)
    let m: number
    if (inp.specmask && inp.alpha) {
      const spec = clamp01(SPEC_GAIN * inp.alpha[p]!)
      m = spec * gate
      r -= 0.3 * spec * gate + 0.15 * spec * (1 - gate)
    } else m = mw ? METAL_FROM_MASK * gate : inp.cls.metallic
    rough[p] = Math.max(ROUGH_MIN, Math.min(1, r))
    metal[p] = clamp01(m)
  }
  return { ao, rough, metal, height: H.d }
}

/** Packs the planes into one RGBA image in the D37 order (format.ts `ORMH`). */
export function packOrmh(planes: OrmhPlanes, w: number, h: number): Img {
  const o = img(w, h, 4)
  for (let p = 0; p < w * h; p++) {
    o.d[p * 4 + ORMH.ao] = planes.ao[p]!
    o.d[p * 4 + ORMH.rough] = planes.rough[p]!
    o.d[p * 4 + ORMH.metal] = planes.metal[p]!
    o.d[p * 4 + ORMH.height] = planes.height[p]!
  }
  return o
}
