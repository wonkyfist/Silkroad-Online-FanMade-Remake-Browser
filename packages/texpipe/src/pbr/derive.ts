/**
 * TP-P: one texture from its upscaled albedo to the PBR master maps (docs/TEXPIPE.md §3.5–3.7, docs/DETAIL.md L3,
 * docs/WAVE_PLAN3.md §7.1 TP-P). Pure: the caller reads the input and the UV islands and writes the results (job.ts).
 *
 *   regions   UV islands (atlases), minus a cutout's transparent texels; the gutter owner map for dilation
 *   de-light  delight.ts, k per profile (actors ≤ 0.3), per island
 *   masks     masks.ts, actor atlases only (DETAIL L3: cloth, leather, metal, gold, skin, hair; wood, jade by review)
 *   height    height.ts, TEXPIPE bands + the masks' per-class relief and bevels
 *   normal    normal.ts, two-scale Sobel, strength per profile
 *   detail    detail.ts tiles blended by the masks, sampled at UV × tiling: UDN over the normal, albedo × tile tone,
 *             roughness offset, a quarter of the tile height (DETAIL: "leather grain, rivets and iron catching the
 *             light"); the amplitude varies slowly over the atlas so the grain is not uniform (sheet 1's complaint)
 *   ORMH      ormh.ts: AO, roughness, metallic (the specmask rule), height; D37 order
 *   dilate    every map into the gutter band and under a cutout's matte, from the nearest island texel
 *   cutout    height 0 outside the mask (after dilation)
 *   previews  preview.ts lit and wet (the game's rain rule for the surface's orientation, params.ts surfaceUp), ≤ 1024 px
 *
 * What DETAIL's research method (work/tmp/detail/detailmaps/scripts/build.py, detailgen.py) replaces in TEXPIPE's
 * plain formulas, on actor atlases only: the material masks (per-class base roughness, metallic gated by the metal and
 * gold masks instead of "metallic = spec alpha" everywhere, per-class relief), the bevels at mask borders, the baked
 * detail layer with edge damping, and the AO floor. Kept from TEXPIPE everywhere: de-light (DETAIL had none), the
 * height bands with a percentile range, the two-scale normal, and the whole world/terrain path.
 */
import { MASK_CLASSES, MASK_NONE, type PbrDeriveOverride } from '../format.ts'
import { delight } from './delight.ts'
import { DETAIL_N, detailTile, sampleTile } from './detail.ts'
import { gradeAlbedo } from './grain.ts'
import { heightMap, perceptualLuma } from './height.ts'
import {
  blur, clamp01, downsample, img, linToSrgb, luminance, resize, restrictRegions, rng, srgbToLin, wholeRegion, type Img, type Regions,
} from './image.ts'
import { atlasOwner, dilatedIds, fillFrom, gutterBand, nearestOwner, withUnclaimed } from './islands.ts'
import { materialMasks, type MaskCluster } from './masks.ts'
import { normalFromHeight, udn } from './normal.ts'
import { ormhPlanes, packOrmh, type OrmhPlanes } from './ormh.ts'
import { DETAIL_AMP, DETAIL_TILING, resolveParams, surfaceUp, type DeriveMeta, type DeriveOptions, type ResolvedParams } from './params.ts'
import { shade } from './preview.ts'
import { addRipples } from './ripples.ts'

export const PREVIEW_MAX_EDGE = 1024
/** Share of the detail tile's height added to the master height (DETAIL: `Ht = Hmacro + 0.25 · det_h`). */
export const DETAIL_HEIGHT = 0.25

export interface DeriveInput {
  meta: DeriveMeta
  /** The upscaled master albedo: sRGB RGBA 0..1 (alpha = coverage for cutout/blend, the spec mask for specmask). */
  albedo: Img
  /** UV islands at the master size (atlases); null or absent = the whole image is one region. */
  islands?: Regions | null
  override?: PbrDeriveOverride
  options?: DeriveOptions
  /** Long edge of the previews (0 = no previews). */
  previewEdge?: number
}

export interface DeriveInfo {
  key: string
  size: [number, number]
  profile: string
  class: string
  alpha: string
  wrap: [boolean, boolean]
  scale: number
  delight: number
  delit: boolean
  normalStrength: number
  aoStrength: number
  islands: number
  /** Unclaimed-art regions of an atlas (art no converted glb samples; derived, not painted over). */
  unclaimed: number
  masks: MaskCluster[] | null
  maskShare: Record<string, number> | null
  detail: number
  tiny: boolean
  albedoOnly: boolean
  ms: Record<string, number>
}

export interface DeriveResult {
  /** De-lit (and detail-toned) albedo, sRGB RGBA; alpha kept for cutout/blend, 1 otherwise (a spec mask is not alpha). */
  albedo: Img
  /** Unit tangent-space normals (3 channels, −1..1, +Y up). */
  normal: Img
  /** ORMH (4 channels 0..1, D37 order). */
  ormh: Img
  planes: OrmhPlanes
  /** The class mask (MASK_CLASSES index, MASK_NONE = none) at the master size, dilated into the gutter. */
  classMask: Uint8Array | null
  /** Cluster id per source texel, for the review's relabel view. */
  clusters: { ids: Int32Array; size: [number, number] } | null
  lit: Img | null
  wet: Img | null
  info: DeriveInfo
}

export function derive(inp: DeriveInput): DeriveResult {
  const T: Record<string, number> = {}
  let t0 = performance.now()
  const lap = (name: string) => {
    const t = performance.now()
    T[name] = Math.round(t - t0)
    t0 = t
  }
  const { meta } = inp
  const src = inp.albedo.c === 4 ? inp.albedo : toRgba(inp.albedo)
  const { w, h } = src
  const N = w * h
  const P = resolveParams(meta, [w, h], inp.override, inp.options)
  const wrap = meta.wrap
  const alpha = new Float32Array(N)
  for (let p = 0; p < N; p++) alpha[p] = src.d[p * 4 + 3]!
  const cutout = meta.alpha === 'cutout'
  const keep = cutout ? (p: number) => alpha[p]! >= 0.5 : null

  // Regions: the UV islands plus the unclaimed art beyond the gutter band (atlases), a cutout's opaque texels. The owner
  // map dilates every map into the band (from the nearest island) and under a cutout's matte.
  let regions: Regions | null = null
  let owner: Int32Array | null = null
  let islandCount = 0
  if (inp.islands) {
    const u = withUnclaimed(inp.islands, gutterBand(w, h))
    islandCount = u.islandCount
    regions = keep ? restrictRegions(u.regions, keep) : u.regions
    owner = atlasOwner(regions, islandCount)
  } else if (keep) {
    regions = wholeRegion(w, h, keep)
    owner = nearestOwner(regions.ids, w, h, wrap)
  }
  const dilate = (im: Img) => (owner ? fillFrom(im, owner) : im)
  lap('regions')

  // De-light.
  let albedo = delight(src, P.delight, wrap, regions)
  if (P.albedoGain !== 1) albedo = gainAlbedo(albedo, P.albedoGain)
  lap('delight')

  // Material masks (actor atlases).
  const masks = P.masks && !P.albedoOnly
    ? materialMasks({
      albedo: src, scale: P.scale, regions, spec: meta.alpha === 'specmask', allowed: P.masks.allowed, olive: P.masks.olive,
      relabel: P.masks.relabel, paint: P.masks.paint, greyMetal: P.masks.kind === 'weapon',
    })
    : null
  const mw = masks?.weights ?? null
  lap('masks')

  let normal: Img
  let planes: OrmhPlanes
  if (P.albedoOnly) {
    normal = img(w, h, 3)
    for (let p = 0; p < N; p++) normal.d[p * 3 + 2] = 1
    planes = { ao: new Float32Array(N).fill(1), rough: new Float32Array(N).fill(P.cls.roughness), metal: new Float32Array(N).fill(P.cls.metallic), height: new Float32Array(N).fill(0.5) }
  } else {
    // Height and the macro normal.
    let H = heightMap({ albedo, scale: P.scale, wrap, regions, invert: P.invertHeight, maskWeights: mw })
    if (P.ripples > 0) addRipples(H.d, w, h, P.ripples, hashSeed(meta.key))
    lap('height')
    normal = normalFromHeight(H, P.normal, P.scale, wrap, regions)
    lap('normal')

    // Baked detail (actors with masks).
    let detailRough: Float32Array | null = null
    if (mw && P.detail > 0 && P.masks) {
      const d = bakeDetail(albedo, mw, P, regions, meta.key)
      normal = udn(normal, d.normal, d.inside)
      albedo = d.albedo
      detailRough = d.rough
      const Ht = img(w, h, 1)
      for (let p = 0; p < N; p++) Ht.d[p] = clamp01(H.d[p]! + DETAIL_HEIGHT * d.height[p]!)
      H = Ht
      lap('detail')
    }

    // AO, roughness, metallic, height.
    planes = ormhPlanes({
      height: H, luma: perceptualLuma(albedo), alpha, specmask: meta.alpha === 'specmask', cls: P.cls, aoStrength: P.ao,
      roughVar: P.roughVar, scale: P.scale, wrap, regions, maskWeights: mw, detailRough,
    })
    lap('ormh')
  }

  // P-LOOK: the colour grade and the sand grain (grain.ts), on the albedo only, so the derived maps are unchanged.
  const tinted = P.albedoTint.some(t => t !== 1)
  if (tinted || P.grain > 0) {
    albedo = gradeAlbedo(albedo, P.albedoTint, P.grain, hashSeed(meta.key))
    lap('grade')
  }

  // Dilate into the gutter / under the matte, then zero a cutout's height outside its mask.
  albedo = owner ? fillFrom(albedo, owner, [0, 1, 2]) : albedo
  normal = dilate(normal)
  let ormh = dilate(packOrmh(planes, w, h))
  if (keep) for (let p = 0; p < N; p++) if (!keep(p)) ormh.d[p * 4 + 3] = 0
  planes = { ao: plane(ormh, 0), rough: plane(ormh, 1), metal: plane(ormh, 2), height: plane(ormh, 3) }
  let classMask: Uint8Array | null = null
  if (masks) {
    classMask = masks.index
    if (owner && regions) {
      const ids = new Int32Array(N)
      for (let p = 0; p < N; p++) ids[p] = masks.index[p] === MASK_NONE ? -1 : masks.index[p]!
      const filled = dilatedIds(ids, owner)
      classMask = new Uint8Array(N)
      for (let p = 0; p < N; p++) classMask[p] = filled[p]! < 0 ? MASK_NONE : filled[p]!
    }
  }
  // The shipped albedo carries alpha only for cutout/blend: a spec mask feeds metallic and is not alpha.
  if (meta.alpha !== 'cutout' && meta.alpha !== 'blend') for (let p = 0; p < N; p++) albedo.d[p * 4 + 3] = 1
  else for (let p = 0; p < N; p++) albedo.d[p * 4 + 3] = alpha[p]!
  lap('dilate')

  // Previews.
  let lit: Img | null = null, wet: Img | null = null
  const edge = inp.previewEdge ?? PREVIEW_MAX_EDGE
  if (edge > 0) {
    const pv = previewMaps(albedo, normal, ormh, edge)
    lit = shade(pv, { wet: 0, cls: P.cls, cutout })
    // The game's rain response for this surface's orientation (preview.ts): puddles only where it faces up; actors
    // soak fully (WEATHER §6.4 characters: exposure 1).
    wet = shade(pv, { wet: 1, cls: P.cls, cutout, up: surfaceUp(meta.key, meta.group, meta.class), exposure: P.actor ? 1 : undefined })
    lap('preview')
  }

  let maskShare: Record<string, number> | null = null
  if (classMask && regions) {
    const cnt = new Array(MASK_CLASSES.length).fill(0)
    let tot = 0
    for (let p = 0; p < N; p++) if (regions.ids[p]! >= 0 && classMask[p]! < MASK_CLASSES.length) { cnt[classMask[p]!]++; tot++ }
    maskShare = Object.fromEntries(MASK_CLASSES.map((c, i) => [c, Math.round((cnt[i] / Math.max(1, tot)) * 1000) / 1000]).filter(([, v]) => (v as number) > 0))
  } else if (classMask) {
    const cnt = new Array(MASK_CLASSES.length).fill(0)
    for (let p = 0; p < N; p++) if (classMask[p]! < MASK_CLASSES.length) cnt[classMask[p]!]++
    maskShare = Object.fromEntries(MASK_CLASSES.map((c, i) => [c, Math.round((cnt[i] / N) * 1000) / 1000]).filter(([, v]) => (v as number) > 0))
  }

  return {
    albedo, normal, ormh, planes, classMask,
    clusters: masks ? { ids: masks.clusters, size: masks.clusterSize } : null,
    lit, wet,
    info: {
      key: meta.key, size: [w, h], profile: P.profile, class: meta.class, alpha: meta.alpha, wrap: [...wrap],
      scale: Math.round(P.scale * 1000) / 1000, delight: P.delight, delit: P.delit, normalStrength: P.normal, aoStrength: P.ao,
      islands: islandCount, unclaimed: regions && inp.islands ? regions.count - islandCount : 0, masks: masks?.names ?? null,
      maskShare, detail: mw ? P.detail : 0, tiny: P.tiny,
      albedoOnly: P.albedoOnly, ms: T,
    },
  }
}

/** × `gain` in linear light on RGB (alpha kept), clamped at 1. */
function gainAlbedo(im: Img, gain: number): Img {
  const o = img(im.w, im.h, im.c)
  o.d.set(im.d)
  for (let p = 0; p < im.w * im.h; p++) {
    for (let k = 0; k < 3; k++) o.d[p * im.c + k] = linToSrgb(Math.min(1, srgbToLin(im.d[p * im.c + k]!) * gain))
  }
  return o
}

function plane(im: Img, k: number): Float32Array {
  const o = new Float32Array(im.w * im.h)
  for (let p = 0; p < o.length; p++) o[p] = im.d[p * im.c + k]!
  return o
}

function toRgba(im: Img): Img {
  const o = img(im.w, im.h, 4)
  for (let p = 0; p < im.w * im.h; p++) {
    for (let k = 0; k < 3; k++) o.d[p * 4 + k] = im.d[p * im.c + Math.min(k, im.c - 1)]!
    o.d[p * 4 + 3] = im.c === 4 ? im.d[p * 4 + 3]! : 1
  }
  return o
}

/** 32-bit FNV-1a of a string (a stable per-texture seed). */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** Smooth value noise over a w×h image, `cells` cells across the long edge, 0..1 (not tileable: atlases only). */
export function valueNoise(w: number, h: number, cells: number, seed: number): Float32Array {
  const long = Math.max(w, h)
  const cw = Math.max(2, Math.ceil((cells * w) / long) + 1), ch = Math.max(2, Math.ceil((cells * h) / long) + 1)
  const rand = rng(seed)
  const grid = Float32Array.from({ length: cw * ch }, () => rand())
  const out = new Float32Array(w * h)
  const sm = (t: number) => t * t * (3 - 2 * t)
  for (let y = 0; y < h; y++) {
    const gy = (y / h) * (ch - 1), y0 = Math.min(ch - 2, Math.floor(gy)), ty = sm(gy - y0)
    for (let x = 0; x < w; x++) {
      const gx = (x / w) * (cw - 1), x0 = Math.min(cw - 2, Math.floor(gx)), tx = sm(gx - x0)
      const a = grid[y0 * cw + x0]!, b = grid[y0 * cw + x0 + 1]!, c = grid[(y0 + 1) * cw + x0]!, d = grid[(y0 + 1) * cw + x0 + 1]!
      out[y * w + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    }
  }
  return out
}

interface BakedDetail {
  normal: Float32Array
  albedo: Img
  rough: Float32Array
  height: Float32Array
  inside: (p: number) => boolean
}

/** DETAIL L3/L4's detail layer, baked: per class the tile at UV × tiling, blended by the soft masks (see header). */
function bakeDetail(albedo: Img, mw: Float32Array[], P: ResolvedParams, regions: Regions | null, key: string): BakedDetail {
  const { w, h } = albedo
  const N = w * h
  const kind = P.masks!.kind
  const inside = (p: number) => !regions || regions.ids[p]! >= 0
  // Edges of the painting (three scales): the detail normal is damped by up to half on them (DETAIL `edge_damp`).
  const L = luminance(albedo)
  const edges = new Float32Array(N)
  for (const s of [1, 2.5, 6]) {
    const b = blur(L, (s * P.scale) / 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        const gx = (b.d[y * w + Math.min(w - 1, x + 1)]! - b.d[y * w + Math.max(0, x - 1)]!) * 0.5
        const gy = (b.d[Math.min(h - 1, y + 1) * w + x]! - b.d[Math.max(0, y - 1) * w + x]!) * 0.5
        edges[p] += Math.hypot(gx, gy)
      }
    }
  }
  const sorted = edges.slice().sort()
  const e0 = sorted[Math.floor(0.005 * (N - 1))]!, e1 = sorted[Math.floor(0.995 * (N - 1))]!
  // Slow amplitude variation over the atlas (0.6..1): the grain is not the same everywhere.
  const vary = valueNoise(w, h, 6, hashSeed(key))
  const normal = new Float32Array(N * 3)
  const alb = new Float32Array(N)
  const rough = new Float32Array(N)
  const height = new Float32Array(N)
  MASK_CLASSES.forEach((c, ci) => {
    const wc = mw[ci]!
    let any = false
    for (let p = 0; p < N && !any; p++) if (wc[p]! > 0.02) any = true
    if (!any) return
    const tile = detailTile(c)
    const reps = DETAIL_TILING[kind][c]
    const only = (p: number) => wc[p]! > 1e-3 && inside(p)
    const sn = sampleTile(tile.nrm, DETAIL_N, 3, w, h, reps, only)
    const sa = sampleTile(tile.alb, DETAIL_N, 1, w, h, reps, only)
    const sr = sampleTile(tile.rough, DETAIL_N, 1, w, h, reps, only)
    const sh = sampleTile(tile.h, DETAIL_N, 1, w, h, reps, only)
    const { amp, albedo: ampAlb } = DETAIL_AMP[c]
    for (let p = 0; p < N; p++) {
      const wt = wc[p]!
      if (!(wt > 1e-3) || !inside(p)) continue
      const a = amp * P.detail * (0.6 + 0.4 * vary[p]!)
      normal[p * 3] += wt * sn[p * 3]! * a
      normal[p * 3 + 1] += wt * sn[p * 3 + 1]! * a
      normal[p * 3 + 2] += wt * sn[p * 3 + 2]!
      alb[p] += wt * (1 + (sa[p]! - 1) * ampAlb * P.detail * (0.6 + 0.4 * vary[p]!))
      rough[p] += wt * sr[p]! * a
      height[p] += wt * (sh[p]! - 0.5) * a
    }
  })
  const out = img(w, h, 4)
  out.d.set(albedo.d)
  for (let p = 0; p < N; p++) {
    if (!inside(p)) {
      normal[p * 3 + 2] = 1
      continue
    }
    const damp = 1 - 0.5 * clamp01((edges[p]! - e0) / Math.max(1e-9, e1 - e0))
    normal[p * 3] *= damp
    normal[p * 3 + 1] *= damp
    if (normal[p * 3 + 2]! <= 0) normal[p * 3 + 2] = 1
    const l = Math.hypot(normal[p * 3]!, normal[p * 3 + 1]!, normal[p * 3 + 2]!) || 1
    normal[p * 3] /= l
    normal[p * 3 + 1] /= l
    normal[p * 3 + 2] /= l
    const f = alb[p]! > 0 ? alb[p]! : 1
    for (let k = 0; k < 3; k++) out.d[p * 4 + k] = clamp01(albedo.d[p * 4 + k]! * f)
  }
  return { normal, albedo: out, rough, height, inside }
}

/** The maps at ≤ `edge` px on the long side (box when the factor is an integer), normals renormalised. */
function previewMaps(albedo: Img, normal: Img, ormh: Img, edge: number) {
  const long = Math.max(albedo.w, albedo.h)
  const f = long / edge
  const shrink = (im: Img): Img => {
    if (f <= 1) return im
    if (Number.isInteger(f) && albedo.w % f === 0 && albedo.h % f === 0) return downsample(im, f)
    return resize(im, Math.max(1, Math.round(im.w / f)), Math.max(1, Math.round(im.h / f)))
  }
  const a = shrink(albedo), n = shrink(normal), o = shrink(ormh)
  for (let p = 0; p < n.w * n.h; p++) {
    const l = Math.hypot(n.d[p * 3]!, n.d[p * 3 + 1]!, n.d[p * 3 + 2]!) || 1
    n.d[p * 3] /= l
    n.d[p * 3 + 1] /= l
    n.d[p * 3 + 2] /= l
  }
  return { albedo: a, normal: n, ao: plane(o, 0), rough: plane(o, 1), metal: plane(o, 2), height: plane(o, 3) }
}

/** The normal as an RGB image in 0..1 (n · 0.5 + 0.5), for writing. */
export function normalToRgb(n: Img): Img {
  const o = img(n.w, n.h, 3)
  for (let p = 0; p < n.w * n.h * 3; p++) o.d[p] = n.d[p]! * 0.5 + 0.5
  return o
}


