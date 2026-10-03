/**
 * The lightmap re-bake with object shadows (WE-D; docs/WORLD_EDITOR.md §4.6, §6.2 step 2, F8, D51; docs/WAVE_PLAN8.md
 * D18). Node-free and deterministic: the converter runs it at Publish and on every convert with edits, and the editor's
 * worker can run the same code on its own model cache.
 *
 * Retail terrain lightmaps carry the sun's baked shadows of the ground **and of the objects** (255 lit, about 156 in
 * shadow; the PBR terrain reads them beyond the shadow-map range, and Low reads nothing else). The coast's baker
 * (../coast/lightmap.ts) knows the ground only; an object edit therefore re-bakes here, so a moved or deleted object
 * leaves no ghost shadow and a planted tree shades the grass on a Mac's Medium as a retail tree does.
 *
 * Per touched region, on its lightmap's own texels (512 x 512 retail, texel centres on the region border, row 0 =
 * south, ~0.375 m):
 * 1. **The change mask**: texels where the ground moved more than LIGHTMAP_MOVED_M (the coast's rule), where the
 *    ground's own sun visibility changed (a raised hill's new shadow, also on unmoved ground beside it), or where a
 *    changed object's shadow lies, before (a dropped placement, the old end of a move, a re-snapped one's old height)
 *    or after (an add, the new end of a move, the new height). Grown by MASK_GROW_TEXELS and feathered over
 *    MASK_FEATHER_TEXELS (the retail baked shadow is a little wider than any re-projection of it).
 * 2. **Inside the mask, the scene after the edits is baked**: the ground's visibility by a heightfield march toward
 *    BAKED_LIGHT_DIR (the coast's method on the global lattice, per 2 m vertex, bilinear to the texels) times the
 *    objects' visibility from a shadow map in light space (0.1875 m samples, a 3 x 3 percentage-closer filter), where
 *    every placement whose shadow can reach the mask draws its triangles: a retail model's own (LOD0) geometry, a
 *    swapped tree's species LOD1 (the tier that casts its real-time shadow, D18) with the swap's fit and offset, leaf
 *    cards and other alpha-tested parts cut at alpha 0.5, the placement's uniform scale applied. Written as
 *    LIGHTMAP_SHADOW + (LIGHTMAP_LIT - LIGHTMAP_SHADOW) x visibility, blended into the current texels by the feather.
 * 3. Outside the mask every texel stays bit for bit; a region with an empty mask gives null (its file is kept).
 * The town dressing's props (uid 1,000,000+) and the ground cover (grass, flowers, reeds) cast no baked shadow anywhere in
 * the retail lightmaps and are left out here too.
 */
import { BAKED_LIGHT_DIR_GLTF, LIGHTMAP_LIT, LIGHTMAP_MOVED_M, LIGHTMAP_SHADOW } from '../coast/lightmap.ts'
import type { WorldModel, WorldPlacement } from '../manifest.ts'
import type { EditsImage } from '../edits-hook.ts'
import type { ShadowCaster } from './glb.ts'

type V3 = [number, number, number]

const CELLS = 96
const G = CELLS + 1
const REGION_M = 192
/** The ray is blocked when the ground stands this far above it (m; ../coast/lightmap.ts). */
const BLOCK_M = 0.3
/** Shadow-map sample spacing (m): half a lightmap texel. */
export const SHADOW_SAMPLE_M = 0.1875
/** A caster sample occludes a ground point only when it is this much nearer the light (m). */
export const SHADOW_BIAS_M = 0.2
/** Sun visibility changes smaller than this do not enter the mask. */
const VIS_EPS = 0.02
/** The mask grows by this many texels at full weight, then fades out over the next MASK_FEATHER_TEXELS. */
export const MASK_GROW_TEXELS = 3
export const MASK_FEATHER_TEXELS = 5
/** The town dressing's first uid (../uids.ts DRESSING_UID_BASE): its props have no baked shadow. */
const DRESSING_UID_BASE = 1_000_000
/**
 * Ground cover (grass groups, flowers, reeds): the retail lightmaps carry no shadow of it (measured on 168-169,97:
 * 93 % of the tree crowns' projected points land on retail shadow texels, 43 % of the grass groups', the meadow's
 * background rate), so it casts none here either.
 */
export const GROUND_COVER = /[\\/](grass|flower|reed)[\\/]/i
/** Largest shadow map side (samples): a mask wider than this is baked at a coarser step. */
const MAX_MAP_SIDE = 4096

// --- the light's frame ------------------------------------------------------------------------------------------------

/** Toward the light (unit), and two axes across it: u horizontal, v = d x u. */
const D = norm(BAKED_LIGHT_DIR_GLTF as V3)
const U = norm([D[2], 0, -D[0]])
const VV: V3 = [D[1] * U[2] - D[2] * U[1], D[2] * U[0] - D[0] * U[2], D[0] * U[1] - D[1] * U[0]]

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

// --- casters ----------------------------------------------------------------------------------------------------------

/** One drawn model of a caster: its geometry key, what to read of it, and its model-space bounds. */
export interface CasterPart {
  /** The manifest model whose glb is read. */
  model: number
  /** Read only this `extras.sroTier` of the glb (a species' LOD1: 1); undefined: the whole glb. */
  tier?: number
  /** A swapped tree's per-axis fit and trunk offset (WorldModelTreeSwap), applied before the placement's transform. */
  fit?: V3
  offset?: V3
  /** Model-space bounds of the drawn geometry (before fit and offset). */
  min: V3
  max: V3
}

/** A placement as a shadow caster. */
export interface CasterInstance {
  key: string
  parts: CasterPart[]
  position: V3
  yaw: number
  scale: number
}

/**
 * The caster of a placement in the final scene (swapped trees as their species' LOD1, D18; a skinned model as its
 * static variant when it has one), or null when nothing of it can be drawn or it is a dressing prop.
 */
export function casterOf(p: WorldPlacement, models: readonly WorldModel[]): CasterInstance | null {
  if (p.uid >= DRESSING_UID_BASE || GROUND_COVER.test(p.source)) return null
  const parts: CasterPart[] = []
  for (const index of p.models) {
    let m = models[index]
    if (!m || m.kind === 'failed' || !m.glb) continue
    const swap = m.treeSwap
    const species = swap ? models[swap.model] : undefined
    if (swap && species && species.glb && species.kind !== 'failed') {
      parts.push({
        model: species.index, tier: 1, fit: [swap.fit[0], swap.fit[1], swap.fit[2]],
        ...(swap.offset ? { offset: [swap.offset[0], swap.offset[1], swap.offset[2]] as V3 } : {}),
        min: [...species.boundsMin] as V3, max: [...species.boundsMax] as V3,
      })
      continue
    }
    if (m.kind === 'skinned' && m.staticVariant !== undefined && models[m.staticVariant]?.glb) m = models[m.staticVariant]!
    parts.push({ model: m.index, min: [...m.boundsMin] as V3, max: [...m.boundsMax] as V3 })
  }
  if (!parts.length) return null
  return { key: `${p.region}:${p.uid}`, parts, position: [p.position[0], p.position[1], p.position[2]], yaw: p.yaw, scale: p.scale ?? 1 }
}

/** A part's model-space point in glTF world space. */
function placePoint(c: CasterInstance, part: CasterPart, x: number, y: number, z: number, out: V3): V3 {
  let px = x
  let py = y
  let pz = z
  if (part.fit) {
    px *= part.fit[0]
    py *= part.fit[1]
    pz *= part.fit[2]
  }
  if (part.offset) {
    px += part.offset[0]
    py += part.offset[1]
    pz += part.offset[2]
  }
  px *= c.scale
  py *= c.scale
  pz *= c.scale
  const cs = Math.cos(c.yaw)
  const sn = Math.sin(c.yaw)
  out[0] = c.position[0] + px * cs + pz * sn
  out[1] = c.position[1] + py
  out[2] = c.position[2] - px * sn + pz * cs
  return out
}

/** The caster's light-space rectangle (u0, v0, u1, v1) from its parts' bounds. */
function casterRect(c: CasterInstance): [number, number, number, number] {
  const r: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  const p: V3 = [0, 0, 0]
  for (const part of c.parts) {
    for (let k = 0; k < 8; k++) {
      placePoint(c, part, k & 1 ? part.max[0] : part.min[0], k & 2 ? part.max[1] : part.min[1], k & 4 ? part.max[2] : part.min[2], p)
      const u = p[0] * U[0] + p[1] * U[1] + p[2] * U[2]
      const v = p[0] * VV[0] + p[1] * VV[1] + p[2] * VV[2]
      r[0] = Math.min(r[0], u)
      r[1] = Math.min(r[1], v)
      r[2] = Math.max(r[2], u)
      r[3] = Math.max(r[3], v)
    }
  }
  return r
}

// --- the shadow map ---------------------------------------------------------------------------------------------------

/** Nearest-to-the-light depth per light-space sample (-Infinity: nothing). */
export class ShadowMap {
  readonly depth: Float32Array
  readonly nu: number
  readonly nv: number
  triangles = 0

  constructor(readonly u0: number, readonly v0: number, u1: number, v1: number, readonly step: number) {
    this.nu = Math.max(1, Math.ceil((u1 - u0) / step) + 1)
    this.nv = Math.max(1, Math.ceil((v1 - v0) / step) + 1)
    this.depth = new Float32Array(this.nu * this.nv).fill(-Infinity)
  }

  overlaps(r: readonly [number, number, number, number]): boolean {
    return r[2] >= this.u0 - this.step && r[0] <= this.u0 + this.nu * this.step && r[3] >= this.v0 - this.step && r[1] <= this.v0 + this.nv * this.step
  }

  /** Draws every part of a caster whose geometry `load` gives. */
  draw(c: CasterInstance, load: (part: CasterPart) => ShadowCaster | null): void {
    if (!this.overlaps(casterRect(c))) return
    const p: V3 = [0, 0, 0]
    for (const part of c.parts) {
      const geo = load(part)
      if (!geo) continue
      for (const mesh of geo.meshes) {
        const n = mesh.positions.length / 3
        const lu = new Float64Array(n)
        const lv = new Float64Array(n)
        const ld = new Float64Array(n)
        for (let i = 0; i < n; i++) {
          placePoint(c, part, mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!, p)
          lu[i] = (p[0] * U[0] + p[1] * U[1] + p[2] * U[2] - this.u0) / this.step
          lv[i] = (p[0] * VV[0] + p[1] * VV[1] + p[2] * VV[2] - this.v0) / this.step
          ld[i] = p[0] * D[0] + p[1] * D[1] + p[2] * D[2]
        }
        const idx = mesh.indices
        for (let t = 0; t + 2 < idx.length; t += 3) this.triangle(idx[t]!, idx[t + 1]!, idx[t + 2]!, lu, lv, ld, mesh.uvs, mesh.alpha)
      }
    }
  }

  private triangle(a: number, b: number, c: number, lu: Float64Array, lv: Float64Array, ld: Float64Array,
    uvs: Float32Array | undefined, alpha: ShadowCaster['meshes'][number]['alpha']): void {
    const ax = lu[a]!, ay = lv[a]!, bx = lu[b]!, by = lv[b]!, cx = lu[c]!, cy = lv[c]!
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (!(Math.abs(area) > 1e-12)) return
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)))
    const x1 = Math.min(this.nu - 1, Math.floor(Math.max(ax, bx, cx)))
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy)))
    const y1 = Math.min(this.nv - 1, Math.floor(Math.max(ay, by, cy)))
    if (x0 > x1 || y0 > y1) return
    this.triangles++
    const inv = 1 / area
    const da = ld[a]!, db = ld[b]!, dc = ld[c]!
    const cut = alpha && uvs ? alpha.cutoff * 255 : -1
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // barycentrics (either winding: the casters are double-sided)
        const wa = ((bx - x) * (cy - y) - (by - y) * (cx - x)) * inv
        const wb = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) * inv
        const wc = 1 - wa - wb
        if (wa < 0 || wb < 0 || wc < 0) continue
        if (cut >= 0) {
          const u = uvs![a * 2]! * wa + uvs![b * 2]! * wb + uvs![c * 2]! * wc
          const v = uvs![a * 2 + 1]! * wa + uvs![b * 2 + 1]! * wb + uvs![c * 2 + 1]! * wc
          const tx = ((Math.floor(u * alpha!.width) % alpha!.width) + alpha!.width) % alpha!.width
          const ty = ((Math.floor(v * alpha!.height) % alpha!.height) + alpha!.height) % alpha!.height
          if (alpha!.alpha[ty * alpha!.width + tx]! < cut) continue
        }
        const d = da * wa + db * wb + dc * wc
        const k = y * this.nu + x
        if (d > this.depth[k]!) this.depth[k] = d
      }
    }
  }

  /** Visibility (0..1) of a glTF point: the share of the 3 x 3 samples around it with nothing nearer the light. */
  visibility(x: number, y: number, z: number): number {
    const fu = (x * U[0] + y * U[1] + z * U[2] - this.u0) / this.step
    const fv = (x * VV[0] + y * VV[1] + z * VV[2] - this.v0) / this.step
    const d = x * D[0] + y * D[1] + z * D[2] + SHADOW_BIAS_M
    const cu = Math.round(fu)
    const cv = Math.round(fv)
    let blocked = 0
    for (let j = -1; j <= 1; j++) {
      const sv = cv + j
      if (sv < 0 || sv >= this.nv) continue
      for (let i = -1; i <= 1; i++) {
        const su = cu + i
        if (su < 0 || su >= this.nu) continue
        if (this.depth[sv * this.nu + su]! > d) blocked++
      }
    }
    return 1 - blocked / 9
  }
}

/** The light-space rectangle of glTF points (x, y, z triples). */
function pointsRect(pts: Float64Array): [number, number, number, number] {
  const r: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i]!, y = pts[i + 1]!, z = pts[i + 2]!
    if (!Number.isFinite(y)) continue
    const u = x * U[0] + y * U[1] + z * U[2]
    const v = x * VV[0] + y * VV[1] + z * VV[2]
    r[0] = Math.min(r[0], u)
    r[1] = Math.min(r[1], v)
    r[2] = Math.max(r[2], u)
    r[3] = Math.max(r[3], v)
  }
  return r
}

function mapFor(rect: [number, number, number, number]): ShadowMap | null {
  if (!(rect[2] >= rect[0]) || !(rect[3] >= rect[1])) return null
  const m = 2 * SHADOW_SAMPLE_M
  const side = Math.max(rect[2] - rect[0], rect[3] - rect[1]) + 2 * m
  const step = Math.max(SHADOW_SAMPLE_M, side / MAX_MAP_SIDE)
  return new ShadowMap(rect[0] - m, rect[1] - m, rect[2] + m, rect[3] + m, step)
}

// --- the ground's sun visibility ----------------------------------------------------------------------------------------

/** A height accessor on the global 2 m lattice (m; undefined outside the export). */
export type LatticeHeight = (ggx: number, ggz: number) => number | undefined

/**
 * Sun visibility (0..1) at every vertex of region (rx, rz) (97 x 97, gz-major), marched toward BAKED_LIGHT_DIR on the
 * global lattice until the ray is above `maxHeightM` or leaves the export (../coast/lightmap.ts's method; the lowest
 * visibility along the ray wins).
 */
export function terrainVisibility(height: LatticeHeight, rx: number, rz: number, maxHeightM: number): Float32Array {
  const horiz = Math.hypot(D[0], D[2])
  // lattice steps per metre toward the light: +gx = east = glTF +x; +gz = north = glTF -z
  const dgx = D[0] / horiz / 2
  const dgz = -D[2] / horiz / 2
  const rise = D[1] / horiz
  const out = new Float32Array(G * G)
  const at = (fx: number, fz: number): number | undefined => {
    const x0 = Math.floor(fx)
    const z0 = Math.floor(fz)
    const h00 = height(x0, z0), h10 = height(x0 + 1, z0), h01 = height(x0, z0 + 1), h11 = height(x0 + 1, z0 + 1)
    if (h00 === undefined || h10 === undefined || h01 === undefined || h11 === undefined) return undefined
    const tx = fx - x0
    const tz = fz - z0
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }
  for (let gz = 0; gz < G; gz++) {
    for (let gx = 0; gx < G; gx++) {
      const ggx = rx * CELLS + gx
      const ggz = rz * CELLS + gz
      const h0 = height(ggx, ggz)
      if (h0 === undefined) {
        out[gz * G + gx] = 1
        continue
      }
      let vis = 1
      for (let t = 2; ; t += 2) {
        const y = h0 + t * rise
        if (y > maxHeightM) break
        const h = at(ggx + dgx * t, ggz + dgz * t)
        if (h === undefined) break
        if (h > y + BLOCK_M) {
          vis = Math.min(vis, Math.max(0, 1 - (h - y - BLOCK_M) / 2))
          if (vis <= 0) break
        }
      }
      out[gz * G + gx] = vis
    }
  }
  return out
}

// --- the bake ---------------------------------------------------------------------------------------------------------

export interface LightmapBakeInput {
  rx: number
  rz: number
  /** glTF position of the region's south-west corner (manifest region.origin). */
  origin: readonly [number, number, number]
  /** The region's current lightmap (retail, the coast's, ...), RGBA, row 0 = south. */
  image: EditsImage
  /** Ground heights (m) on the global lattice before and after the edits. */
  heightBefore: LatticeHeight
  heightAfter: LatticeHeight
  /** Whether any height changed anywhere (false: the ground's visibility is computed once). */
  terrainChanged: boolean
  /** The highest ground in the export, before or after (m): rays above it are free. */
  maxHeightM: number
  /** The changed casters: shadows that are gone (before state) and shadows that come (after state). */
  gone: readonly CasterInstance[]
  come: readonly CasterInstance[]
  /** Every caster of the scene after the edits (the bake draws the ones that reach the mask). */
  scene: readonly CasterInstance[]
  /** A part's geometry (cached by the caller), or null when it cannot be read. */
  load(part: CasterPart): ShadowCaster | null
}

export interface LightmapBakeResult {
  image: EditsImage
  /** Texels inside the mask (weight > 0) and in its core. */
  texels: number
  core: number
  /** Casters drawn in the full bake; triangles rasterized. */
  casters: number
  triangles: number
}

/** The region's lightmap with the edited ground and objects re-baked (see the header), or null when nothing changed. */
export function bakeEditedLightmap(input: LightmapBakeInput): LightmapBakeResult | null {
  const { rx, rz, image } = input
  const w = image.width
  const h = image.height
  if (w < 2 || h < 2 || image.rgba.length !== w * h * 4) return null
  const [ox, , oz] = input.origin

  // the region's vertex heights, before and after
  const hb = new Float64Array(G * G)
  const ha = new Float64Array(G * G)
  for (let gz = 0; gz < G; gz++) {
    for (let gx = 0; gx < G; gx++) {
      const b = input.heightBefore(rx * CELLS + gx, rz * CELLS + gz)
      const a = input.heightAfter(rx * CELLS + gx, rz * CELLS + gz)
      hb[gz * G + gx] = b ?? NaN
      ha[gz * G + gx] = a ?? NaN
    }
  }
  const visA = terrainVisibility(input.heightAfter, rx, rz, input.maxHeightM)
  const visB = input.terrainChanged ? terrainVisibility(input.heightBefore, rx, rz, input.maxHeightM) : visA
  const moved = new Uint8Array(G * G)
  const visDiff = new Uint8Array(G * G)
  for (let i = 0; i < G * G; i++) {
    if (Math.abs(ha[i]! - hb[i]!) > LIGHTMAP_MOVED_M) moved[i] = 1
    if (Math.abs(visA[i]! - visB[i]!) > VIS_EPS) visDiff[i] = 1
  }

  // texel ground points (glTF), before and after; texel (i, j) <-> vertex (i / (w - 1) x 96, j / (h - 1) x 96)
  const n = w * h
  const ptsB = new Float64Array(n * 3)
  const ptsA = new Float64Array(n * 3)
  const bil = (a: ArrayLike<number>, fx: number, fz: number) => {
    const ix = Math.min(Math.floor(fx), G - 2)
    const iz = Math.min(Math.floor(fz), G - 2)
    const tx = fx - ix
    const tz = fz - iz
    return (a[iz * G + ix]! * (1 - tx) + a[iz * G + ix + 1]! * tx) * (1 - tz) + (a[(iz + 1) * G + ix]! * (1 - tx) + a[(iz + 1) * G + ix + 1]! * tx) * tz
  }
  const any4 = (a: Uint8Array, fx: number, fz: number) => {
    const ix = Math.min(Math.floor(fx), G - 2)
    const iz = Math.min(Math.floor(fz), G - 2)
    return a[iz * G + ix]! | a[iz * G + ix + 1]! | a[(iz + 1) * G + ix]! | a[(iz + 1) * G + ix + 1]!
  }
  const core = new Uint8Array(n)
  for (let j = 0; j < h; j++) {
    const fz = (j / (h - 1)) * CELLS
    for (let i = 0; i < w; i++) {
      const fx = (i / (w - 1)) * CELLS
      const k = j * w + i
      const x = ox + (i / (w - 1)) * REGION_M
      const z = oz - (j / (h - 1)) * REGION_M
      ptsB[k * 3] = x
      ptsB[k * 3 + 1] = bil(hb, fx, fz)
      ptsB[k * 3 + 2] = z
      ptsA[k * 3] = x
      ptsA[k * 3 + 1] = bil(ha, fx, fz)
      ptsA[k * 3 + 2] = z
      if (any4(moved, fx, fz) || any4(visDiff, fx, fz)) core[k] = 1
    }
  }

  // the changed casters' shadows, before (on the old ground) and after (on the new)
  const changed = (casters: readonly CasterInstance[], pts: Float64Array) => {
    if (!casters.length) return
    const sm = mapFor(pointsRect(pts))
    if (!sm) return
    for (const c of casters) sm.draw(c, input.load)
    if (!sm.triangles) return
    for (let k = 0; k < n; k++) {
      if (core[k]) continue
      const y = pts[k * 3 + 1]!
      if (Number.isFinite(y) && sm.visibility(pts[k * 3]!, y, pts[k * 3 + 2]!) < 1) core[k] = 1
    }
  }
  changed(input.gone, ptsB)
  changed(input.come, ptsA)

  let coreCount = 0
  for (let k = 0; k < n; k++) coreCount += core[k]!
  if (!coreCount) return null

  // grow and feather (Chebyshev distance in texels, capped)
  const weight = maskWeights(core, w, h)
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
  let texels = 0
  for (let k = 0; k < n; k++) {
    if (!(weight[k]! > 0)) continue
    texels++
    const x = ptsA[k * 3]!, y = ptsA[k * 3 + 1]!, z = ptsA[k * 3 + 2]!
    if (!Number.isFinite(y)) continue
    const u = x * U[0] + y * U[1] + z * U[2]
    const v = x * VV[0] + y * VV[1] + z * VV[2]
    u0 = Math.min(u0, u)
    v0 = Math.min(v0, v)
    u1 = Math.max(u1, u)
    v1 = Math.max(v1, v)
  }

  // the scene after the edits, over the mask
  const sm = mapFor([u0, v0, u1, v1])
  let casters = 0
  if (sm) {
    for (const c of input.scene) {
      const before = sm.triangles
      sm.draw(c, input.load)
      if (sm.triangles > before) casters++
    }
  }
  const rgba = Uint8Array.from(image.rgba)
  for (let j = 0; j < h; j++) {
    const fz = (j / (h - 1)) * CELLS
    for (let i = 0; i < w; i++) {
      const k = j * w + i
      const m = weight[k]!
      if (!(m > 0)) continue
      const y = ptsA[k * 3 + 1]!
      if (!Number.isFinite(y)) continue
      const fx = (i / (w - 1)) * CELLS
      let vis = bil(visA, fx, fz)
      if (sm && sm.triangles) vis *= sm.visibility(ptsA[k * 3]!, y, ptsA[k * 3 + 2]!)
      const baked = LIGHTMAP_SHADOW + (LIGHTMAP_LIT - LIGHTMAP_SHADOW) * vis
      const o = k * 4
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(rgba[o + c]! * (1 - m) + baked * m)
      rgba[o + 3] = 255
    }
  }
  return { image: { width: w, height: h, rgba }, texels, core: coreCount, casters, triangles: sm?.triangles ?? 0 }
}

/** Mask weights: 1 within MASK_GROW_TEXELS of the core (Chebyshev), fading to 0 over MASK_FEATHER_TEXELS after it. */
export function maskWeights(core: Uint8Array, w: number, h: number): Float32Array {
  const cap = MASK_GROW_TEXELS + MASK_FEATHER_TEXELS + 1
  // two-pass Chebyshev distance transform, capped
  const dist = new Uint16Array(w * h).fill(cap)
  for (let k = 0; k < w * h; k++) if (core[k]) dist[k] = 0
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i
      let d = dist[k]!
      if (i > 0) d = Math.min(d, dist[k - 1]! + 1)
      if (j > 0) {
        d = Math.min(d, dist[k - w]! + 1)
        if (i > 0) d = Math.min(d, dist[k - w - 1]! + 1)
        if (i < w - 1) d = Math.min(d, dist[k - w + 1]! + 1)
      }
      dist[k] = d
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i
      let d = dist[k]!
      if (i < w - 1) d = Math.min(d, dist[k + 1]! + 1)
      if (j < h - 1) {
        d = Math.min(d, dist[k + w]! + 1)
        if (i < w - 1) d = Math.min(d, dist[k + w + 1]! + 1)
        if (i > 0) d = Math.min(d, dist[k + w - 1]! + 1)
      }
      dist[k] = d
    }
  }
  const out = new Float32Array(w * h)
  for (let k = 0; k < w * h; k++) {
    const d = dist[k]!
    out[k] = d <= MASK_GROW_TEXELS ? 1 : Math.max(0, 1 - (d - MASK_GROW_TEXELS) / (MASK_FEATHER_TEXELS + 1))
  }
  return out
}
