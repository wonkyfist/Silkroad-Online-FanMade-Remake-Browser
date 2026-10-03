/**
 * TP-P material masks for actor atlases (docs/DETAIL.md L3, a port of `work/tmp/detail/detailmaps/scripts/build.py`
 * `material_masks` / `classify_centroid`). One armour or weapon atlas mixes cloth, leather, iron and brass; a single
 * class per texture cannot give them different roughness, metalness, relief and detail. The masks can:
 *
 *   1. features per source texel: CIE Lab of the lightly blurred colour, the retail specular/env-mask alpha (specmask
 *      sets only) and the local luminance contrast (flat cloth vs textured leather);
 *   2. k-means (k = 10, seeded, so a rerun gives the same masks) over the island texels;
 *   3. each cluster's centroid is named by colour rules (hue, chroma, lightness, spec): gold, metal, skin, hair,
 *      leather, olive trim, cloth; near-black clusters are painted shadow, not a material, and take the class of the
 *      texels around them (grown outward over widening blurs; hair never grows over trims);
 *   4. the review fixes a wrong cluster with `pbr.maskRelabel` (cluster index → class) or narrows `pbr.maskAllowed`
 *      (content/texpipe/overrides.json); `pbr.maskPaint` sets a class inside a UV rectangle (optionally only on some
 *      clusters) where one cluster spans two materials, after the painted-shadow fill. DETAIL measured ~85–90% right automatically; the Copper Sword's grip (painted
 *      wood, clustered as leather) is the known case, hence the `wood` class, assigned only by relabel.
 *
 * Clustering runs at the retail size (the master downsampled by the upscale factor): the source carries all the colour
 * information and the AI's invented texture only adds noise to the features. The class weights are then blurred
 * (σ 0.8 source texels), resized to the master and normalised, so class borders are soft.
 *
 * Pure (no node:*).
 */
import { MASK_CLASSES, MASK_NONE, type MaskClass, type MaskPaint } from '../format.ts'
import { blurBuffer, img, resize, rng, srgbToLin, type Img, type Regions } from './image.ts'

export interface MaskCluster {
  index: number
  /** The class after rules and relabels; 'fill' = painted shadow, filled from around. */
  class: MaskClass | 'fill'
  L: number
  a: number
  b: number
  spec: number
  /** Share of the clustered texels. */
  share: number
}

export interface MaterialMasks {
  /** Soft weights per class at the master size (MASK_CLASSES order; each sums to 1 over the classes inside regions). */
  weights: Float32Array[]
  /** The strongest class id per master texel (MASK_NONE outside every region): the class mask DT-4 samples. */
  index: Uint8Array
  /** Cluster id per source texel (−1 outside), for the review's relabel view. */
  clusters: Int32Array
  clusterSize: [number, number]
  names: MaskCluster[]
  hasSpec: boolean
}

export const MASK_K = 10
const SAMPLE_MAX = 30000

/** sRGB (0..1) → CIE Lab (D65). */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b)
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x), fy = f(y), fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/**
 * The class of a cluster centroid (DETAIL `classify_centroid`): Lab, mean spec (0..1) and whether the atlas has a
 * spec mask. Returns null for painted shadow (filled from the neighbours). The caller maps a class the atlas does not
 * allow to an allowed one.
 */
export function classifyCentroid(
  L: number, a: number, b: number, spec: number, hasSpec: boolean, allowed: readonly MaskClass[], olive: MaskClass,
  greyMetal = false,
): MaskClass | null {
  const C = Math.hypot(a, b)
  // Weapons (new): a light grey cluster is steel, not cloth, whatever its spec (the Copper Sword's blade).
  if (greyMetal && allowed.includes('metal') && C < 14 && L > 35) return 'metal'
  // ... and a dark neutral one is the black background between the parts: painted shadow, filled from around.
  if (greyMetal && L < 26 && C < 8) return null
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
  if (hasSpec && spec > 0.15 && hue >= 55 && hue <= 105 && C > 30 && L > 35) return 'gold'
  if (hasSpec && spec > 0.3) return hue >= 55 && hue <= 105 && C > 22 && L > 40 ? 'gold' : 'metal'
  if (hasSpec && spec > 0.18 && C < 12 && L > 25) return 'metal'
  if (allowed.includes('skin') && hue >= 35 && hue <= 80 && C >= 8 && C <= 42 && L >= 42 && L <= 88) return 'skin'
  if (allowed.includes('hair') && L >= 12 && L < 34 && hue >= 25 && hue <= 85 && C >= 8) return 'hair'
  if (L < 16) return null
  if (allowed.includes('gold') && hue >= 60 && hue <= 100 && C > 38 && L > 45) return 'gold'
  if (hue >= 30 && hue <= 80 && C > 16 && L >= 18 && L <= 62) return 'leather'
  if (hue >= 90 && hue <= 140 && C >= 10 && L < 62) return olive
  if (L < 45 && C >= 6) return 'leather'
  return 'cloth'
}

/** A class the atlas does not allow → the nearest allowed one (metal ↔ gold, leather ↔ cloth, else the first). */
function allowedClass(c: MaskClass, allowed: readonly MaskClass[]): MaskClass {
  if (allowed.includes(c)) return c
  const alt: Record<MaskClass, MaskClass[]> = {
    metal: ['gold', 'leather', 'cloth'], gold: ['metal', 'leather', 'cloth'], leather: ['cloth', 'wood', 'skin'],
    cloth: ['leather', 'skin', 'hair'], skin: ['cloth', 'leather'], hair: ['leather', 'cloth'], wood: ['leather', 'cloth'],
    jade: ['metal', 'skin', 'cloth'],
  }
  return alt[c].find(x => allowed.includes(x)) ?? allowed[0]!
}

export interface MaskInput {
  /** The master albedo (sRGB RGBA 0..1); alpha is the spec mask when `spec` is set. */
  albedo: Img
  /** Master texels per source texel (the clustering runs at the source size). */
  scale: number
  /** Master regions (islands, cutout); null = every texel. */
  regions: Regions | null
  spec: boolean
  allowed: readonly MaskClass[]
  olive: MaskClass
  relabel?: Record<string, MaskClass | 'fill'>
  /** Review paint (format.ts MaskPaint), applied after the relabels and the painted-shadow fill. */
  paint?: readonly MaskPaint[]
  /** Light grey clusters are metal (weapon atlases). */
  greyMetal?: boolean
  k?: number
  seed?: number
}

/** Soft material masks of an actor atlas (see the header). */
export function materialMasks(inp: MaskInput): MaterialMasks {
  const M = inp.albedo
  const sw = Math.max(1, Math.round(M.w / inp.scale)), sh = Math.max(1, Math.round(M.h / inp.scale))
  const src = sw === M.w && sh === M.h ? M : resize(M, sw, sh)
  const n = sw * sh
  // Which source texels are inside a region: the master texel at the source texel's centre.
  const inside = new Uint8Array(n)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const mx = Math.min(M.w - 1, Math.floor(((x + 0.5) * M.w) / sw)), my = Math.min(M.h - 1, Math.floor(((y + 0.5) * M.h) / sh))
      inside[y * sw + x] = !inp.regions || inp.regions.ids[my * M.w + mx]! >= 0 ? 1 : 0
    }
  }
  const nClass = MASK_CLASSES.length
  const onehot = Array.from({ length: nClass }, () => new Float32Array(n))
  const clusters = new Int32Array(n).fill(-1)
  const names: MaskCluster[] = []
  const hasSpec = inp.spec

  if (inp.allowed.length === 1) {
    const ci = MASK_CLASSES.indexOf(inp.allowed[0]!)
    for (let p = 0; p < n; p++) if (inside[p]) onehot[ci]![p] = 1
  } else {
    // 1. Features.
    const ch = [0, 1, 2].map(k => {
      const b = new Float32Array(n)
      for (let p = 0; p < n; p++) b[p] = src.d[p * src.c + k]!
      return blurBuffer(b, sw, sh, 0.7, ['clamp', 'clamp'])
    })
    const Lab = new Float32Array(n * 3)
    const lum = new Float32Array(n)
    const lum2 = new Float32Array(n)
    for (let p = 0; p < n; p++) {
      const [L, a, b] = rgbToLab(ch[0]![p]!, ch[1]![p]!, ch[2]![p]!)
      Lab[p * 3] = L
      Lab[p * 3 + 1] = a
      Lab[p * 3 + 2] = b
      lum[p] = L
      lum2[p] = L * L
    }
    const m1 = blurBuffer(lum, sw, sh, 2, ['clamp', 'clamp']), m2 = blurBuffer(lum2, sw, sh, 2, ['clamp', 'clamp'])
    const specRaw = new Float32Array(n)
    if (hasSpec) for (let p = 0; p < n; p++) specRaw[p] = src.d[p * src.c + 3]!
    const specB = hasSpec ? blurBuffer(specRaw, sw, sh, 1, ['clamp', 'clamp']) : specRaw
    const D = 5
    const F = new Float32Array(n * D)
    for (let p = 0; p < n; p++) {
      F[p * D] = Lab[p * 3]! / 100
      F[p * D + 1] = Lab[p * 3 + 1]! / 60
      F[p * D + 2] = Lab[p * 3 + 2]! / 60
      F[p * D + 3] = hasSpec ? specB[p]! * 1.4 : 0
      F[p * D + 4] = Math.sqrt(Math.max(0, m2[p]! - m1[p]! * m1[p]!)) / 40
    }
    const members: number[] = []
    for (let p = 0; p < n; p++) if (inside[p]) members.push(p)
    // 2. k-means on a seeded sample, then every member to its nearest centroid.
    const rand = rng(inp.seed ?? 1)
    const sample = members.length <= SAMPLE_MAX ? members.slice() : Array.from({ length: SAMPLE_MAX }, () => members[Math.floor(rand() * members.length)]!)
    const k = Math.max(1, Math.min(inp.k ?? MASK_K, sample.length))
    const C = kmeans(F, D, sample, k, 30, rand)
    for (const p of members) clusters[p] = nearest(F, D, p, C, k)
    // 3. Name each cluster.
    for (let j = 0; j < k; j++) {
      let cnt = 0, L = 0, a = 0, b = 0, s = 0
      for (const p of members) {
        if (clusters[p] !== j) continue
        cnt++
        L += Lab[p * 3]!
        a += Lab[p * 3 + 1]!
        b += Lab[p * 3 + 2]!
        s += specRaw[p]!
      }
      if (!cnt) {
        names.push({ index: j, class: 'cloth', L: 0, a: 0, b: 0, spec: 0, share: 0 })
        continue
      }
      L /= cnt; a /= cnt; b /= cnt; s /= cnt
      const fixed = inp.relabel?.[String(j)]
      const auto = classifyCentroid(L, a, b, s, hasSpec, inp.allowed, inp.olive, inp.greyMetal)
      const cls: MaskClass | 'fill' = fixed ?? (auto === null ? 'fill' : allowedClass(auto, inp.allowed))
      names.push({ index: j, class: cls, L, a, b, spec: s, share: cnt / members.length })
    }
    const unknown = new Uint8Array(n)
    for (const p of members) {
      const cls = names[clusters[p]!]!.class
      if (cls === 'fill') unknown[p] = 1
      else onehot[MASK_CLASSES.indexOf(cls)]![p] = 1
    }
    // 4. Painted shadow takes the class around it (widening blurs; hair never grows over trims).
    const hairI = MASK_CLASSES.indexOf('hair')
    for (const s of [2, 4, 8, 16, 32, 64]) {
      let left = 0
      for (const p of members) if (unknown[p]) left++
      if (!left) break
      const g = onehot.map((o, ci) => (ci === hairI ? null : blurBuffer(o, sw, sh, s, ['clamp', 'clamp'])))
      for (const p of members) {
        if (!unknown[p]) continue
        let best = -1, bv = 1e-3
        for (let ci = 0; ci < nClass; ci++) {
          const v = g[ci]?.[p] ?? 0
          if (v > bv) {
            bv = v
            best = ci
          }
        }
        if (best >= 0) {
          onehot[best]![p] = 1
          unknown[p] = 0
        }
      }
    }
    const fallback = MASK_CLASSES.indexOf(allowedClass('cloth', inp.allowed))
    for (const p of members) if (unknown[p]) onehot[fallback]![p] = 1
  }
  if (inp.paint?.length) paintMasks(onehot, clusters, inside, sw, sh, inp.paint)

  // Soft weights at the master size, normalised inside the regions.
  const weights = onehot.map(o => {
    const b = blurBuffer(o, sw, sh, 0.8, ['clamp', 'clamp'])
    const up = sw === M.w && sh === M.h ? b : resize({ w: sw, h: sh, c: 1, d: b }, M.w, M.h).d
    return up
  })
  const N = M.w * M.h
  // Small metal (rivets, studs, buckles) is a few source texels: below the clustering's reach. Found at full size.
  if (inp.allowed.includes('metal')) {
    const soft = new Float32Array(N)
    const iC = MASK_CLASSES.indexOf('cloth'), iS = MASK_CLASSES.indexOf('skin')
    for (let p = 0; p < N; p++) soft[p] = weights[iC]![p]! + weights[iS]![p]!
    const fm = smallMetal(M, inp.scale, soft)
    const iM = MASK_CLASSES.indexOf('metal')
    for (let p = 0; p < N; p++) {
      const f = fm[p]!, cur = weights[iM]![p]!
      if (!(f > cur)) continue
      let rest = 0
      for (let ci = 0; ci < nClass; ci++) if (ci !== iM) rest += weights[ci]![p]!
      const k = rest > 1e-6 ? (1 - f) / rest : 0
      for (let ci = 0; ci < nClass; ci++) weights[ci]![p] = ci === iM ? f : weights[ci]![p]! * k
    }
  }
  const index = new Uint8Array(N).fill(MASK_NONE)
  for (let p = 0; p < N; p++) {
    if (inp.regions && inp.regions.ids[p]! < 0) {
      for (const wgt of weights) wgt[p] = 0
      continue
    }
    let sum = 0, best = 0, bv = -1
    for (let ci = 0; ci < nClass; ci++) {
      const v = weights[ci]![p]!
      sum += v
      if (v > bv) {
        bv = v
        best = ci
      }
    }
    if (sum > 1e-6) for (const wgt of weights) wgt[p] = wgt[p]! / sum
    index[p] = sum > 1e-6 ? best : MASK_NONE
  }
  return { weights, index, clusters, clusterSize: [sw, sh], names, hasSpec }
}

/** Review paint at the source size: island texels inside each UV rectangle (of the listed clusters) take its class. */
export function paintMasks(
  onehot: Float32Array[], clusters: Int32Array, inside: Uint8Array, sw: number, sh: number, paint: readonly MaskPaint[],
): void {
  for (const pt of paint) {
    const ci = MASK_CLASSES.indexOf(pt.class)
    if (ci < 0) continue
    const only = pt.clusters ? new Set(pt.clusters) : null
    const [u0, v0, u1, v1] = pt.uv
    const x0 = Math.max(0, Math.floor(u0 * sw)), x1 = Math.min(sw, Math.ceil(u1 * sw))
    const y0 = Math.max(0, Math.floor(v0 * sh)), y1 = Math.min(sh, Math.ceil(v1 * sh))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * sw + x
        if (!inside[p] || (only && !only.has(clusters[p]!))) continue
        for (const o of onehot) o[p] = 0
        onehot[ci]![p] = 1
      }
    }
  }
}

/**
 * Small bright metal at the master size (new, not in DETAIL: its heavy-chest rivets stayed "leather"). A rivet or stud
 * head is a small bright blob: grey (Lab chroma < ~12), light (L > ~50), brighter than its surroundings
 * (D = blur(L, 0.6 s) − blur(L, 2.5 s) > ~8) and darker in at least 6 of 8 directions at ~1 source texel (the bright
 * side of an edge has D > 0 too, but is darker on about 3 sides only). Texels whose surroundings are cloth or
 * skin (`context`, the weight of those classes) are skipped: a white shirt's highlights are not studs. The response is
 * widened by half a source texel so the whole head (and its bevel dome) is covered.
 */
export function smallMetal(albedo: Img, scale: number, context?: Float32Array): Float32Array {
  const { w, h, c } = albedo
  const N = w * h
  const L = new Float32Array(N), C = new Float32Array(N)
  for (let p = 0; p < N; p++) {
    const [l, a, b] = rgbToLab(albedo.d[p * c]!, albedo.d[p * c + 1]!, albedo.d[p * c + 2]!)
    L[p] = l
    C[p] = Math.hypot(a, b)
  }
  const fine = blurBuffer(L, w, h, 0.6 * scale, ['clamp', 'clamp'])
  const broad = blurBuffer(L, w, h, 2.5 * scale, ['clamp', 'clamp'])
  const ctx = context ? blurBuffer(context, w, h, 2 * scale, ['clamp', 'clamp']) : null
  const s = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }
  const f = new Float32Array(N)
  const r = Math.max(2, Math.round(1.2 * scale))
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]].map(([dx, dy]) => Math.round(dy! * r) * w + Math.round(dx! * r))
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const p = y * w + x
      const D = fine[p]! - broad[p]!
      if (D < 4 || C[p]! > 18 || L[p]! < 40) continue
      let darker = 0
      for (const o of dirs) if (fine[p + o]! < fine[p]! - 4) darker++
      f[p] = s(4, 12, D) * s(18, 10, C[p]!) * s(40, 55, L[p]!) * s(5, 7, darker) * (ctx ? 1 - s(0.3, 0.7, ctx[p]!) : 1)
    }
  }
  const wide = blurBuffer(f, w, h, 0.5 * scale, ['clamp', 'clamp'])
  for (let p = 0; p < N; p++) wide[p] = Math.min(1, 1.6 * wide[p]!)
  return wide
}

/** The weight image of one class (for tests and the review view). */
export function maskWeight(m: MaterialMasks, cls: MaskClass, w: number, h: number): Img {
  const o = img(w, h, 1)
  o.d.set(m.weights[MASK_CLASSES.indexOf(cls)]!)
  return o
}

function nearest(F: Float32Array, D: number, p: number, C: Float64Array, k: number): number {
  let best = 0, bd = Infinity
  for (let j = 0; j < k; j++) {
    let d = 0
    for (let i = 0; i < D; i++) {
      const t = F[p * D + i]! - C[j * D + i]!
      d += t * t
    }
    if (d < bd) {
      bd = d
      best = j
    }
  }
  return best
}

/** Lloyd's k-means over the sampled texels (centroids start at k distinct random samples). */
function kmeans(F: Float32Array, D: number, sample: number[], k: number, iters: number, rand: () => number): Float64Array {
  const C = new Float64Array(k * D)
  const picked = new Set<number>()
  for (let j = 0; j < k; j++) {
    let p = sample[Math.floor(rand() * sample.length)]!
    for (let tries = 0; picked.has(p) && tries < 20; tries++) p = sample[Math.floor(rand() * sample.length)]!
    picked.add(p)
    for (let i = 0; i < D; i++) C[j * D + i] = F[p * D + i]!
  }
  const lab = new Int32Array(sample.length)
  for (let it = 0; it < iters; it++) {
    let moved = 0
    for (let s = 0; s < sample.length; s++) {
      const j = nearest(F, D, sample[s]!, C, k)
      if (j !== lab[s]) moved++
      lab[s] = j
    }
    const sum = new Float64Array(k * D)
    const cnt = new Float64Array(k)
    for (let s = 0; s < sample.length; s++) {
      const j = lab[s]!
      cnt[j]++
      for (let i = 0; i < D; i++) sum[j * D + i] += F[sample[s]! * D + i]!
    }
    for (let j = 0; j < k; j++) if (cnt[j]! > 0) for (let i = 0; i < D; i++) C[j * D + i] = sum[j * D + i]! / cnt[j]!
    if (it > 0 && moved === 0) break
  }
  return C
}
