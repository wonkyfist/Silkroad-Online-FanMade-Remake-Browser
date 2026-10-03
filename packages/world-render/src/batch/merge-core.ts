/**
 * The region merge, pure (docs/BATCHING.md §3.1, §3.3, §4.5; docs/WAVE_PLAN6.md §6.1 BT-M): a region's static pieces
 * (one model primitive at a list of placements) become world-space groups, one set of typed arrays per group key,
 * plus the region's opaque shadow proxy (positions only). No Babylon import: the merge worker (merge-worker.ts) runs it
 * off the main thread, and the region batch runs it in-process where no worker can start.
 *
 * What a merged vertex carries (§3.3): the world position, the unit normal (the instance's inverse transpose, computed
 * into its own matrix: Babylon's `transposeToRef` on the matrix it reads aliases, BATCHING §4.5 finding 1, and rotated
 * instances got wrong normals), TEXCOORD_0 as is, and TEXCOORD_1. In the table mode UV2 is remapped into the piece's
 * lightmap quadrant and packs its (lightmap layer, material slot) into the integer part, `uv2.x += 2 × layer`,
 * `uv2.y += 2 × slot` (decoded with `floor(uv / 2)`), so the table costs no varying. In the material mode (a group per
 * converted material) UV2 is the retail lightmap UV unchanged.
 *
 * Winding (§3.1): a piece whose effective side orientation differs from its group's (`flip`), a mirrored instance
 * (determinant < 0) and a mirroring node transform (`MergePrimitive.mirrored`) each reverse the triangles, so every
 * triangle stays front-facing in the group's orientation. A two-sided piece on a single-sided group (`twoSided`) is
 * emitted twice, the back copy with reversed winding and negated normals (§3.1: sidedness left the group key).
 *
 * Matrices are Babylon's layout (row vectors, v' = v × M, translation in m[12..14]); the model-space positions already
 * carry the glTF node transform (model-cache.ts `extractModelGeometry`), so an instance's matrix is its placement's.
 *
 * **Wave 12, the new trees (T12-M; docs/TREES.md §W3.3, §W3.4, §W3.6, WF5, WF10, WF15):**
 * - **Tiers.** A piece carries its tier (`MergePiece.tier`: 1 = LOD1 / a plant's P-LOD0, 2 = LOD2 / P-LOD1, 0 = not
 *   banded: a retail tree, drawn at every distance). A group emits its tier 0–1 pieces first and its tier-2 pieces
 *   last, so its first `casterVertices` vertices and `casterIndices` indices are exactly the LOD1 silhouette.
 * - **`sroTreeW`.** A group with `treeW` writes 4 bytes per vertex (unorm8x4: flex, phase, flutter, crown AO; the
 *   foliage plugin's SRO_FOL_VDATA reads them as a vec4). A `wind` piece (a swapped species) takes them from its glb's
 *   TEXCOORD_1 (flex, 1 − phase) and TEXCOORD_2 (flutter, 1 − AO): the glb holds Blender's V-flipped values (TREES
 *   §3.4), decoded here; its UV2 is then the white lightmap quadrant's centre (the wind data is not a lightmap UV). A
 *   piece without the wind data (a retail tree sharing the group) gets the h² bend's shape: flex = height above its
 *   root / TREE_W_FLEX_M (capped at 1), phase from its root, flutter = flex on a leaf group, AO 1.
 * - **The cut-out caster (WF15).** The groups flagged `caster` (the table cut-out groups and every table tree group)
 *   are also copied, tiers 0–1 only, into one caster vertex set (`MergeResult.caster`: positions, normals, uv, uv2, and
 *   the per-vertex `sroCull` sphere: the group's own for LOD group 3, radius −1 for group 2), which the main thread only
 *   uploads (render/shadows.ts). Without a flag nothing is copied.
 */

/** Slots and lightmap layers packed into UV2 stay below this (float32 keeps 2⁻¹⁰ of lightmap UV below 2 × 4096). */
export const UV2_ID_LIMIT = 4096

/** T12-M: a retail tree's synthesized flex reaches 1 this high above its root (m): flex² × 1.2 m ≈ the h² bend. */
export const TREE_W_FLEX_M = 10

/** One primitive of a model in model space (the geometry export, model-cache.ts PrimitiveGeometry). */
export interface MergePrimitive {
  positions: Float32Array
  normals: Float32Array | null
  uvs: Float32Array | null
  uvs2: Float32Array | null
  /** T12-M: TEXCOORD_2 (a species' flutter, 1 − crown AO); absent or null: none. */
  uvs3?: Float32Array | null
  indices: Uint32Array
  /** The baked node transform mirrors (determinant < 0). */
  mirrored: boolean
}

/** A model's primitives as the merge reads them (by the id the region batch gave the geometry). */
export interface MergeModelData {
  primitives: readonly MergePrimitive[]
}

/**
 * The table mode's UV2 for one piece (BT-A's slot and lightmap placement): uv2 × scale + offset lands the retail
 * lightmap UV in its quadrant of the layer (scale 1, offset 0 for a whole 256² layer; a piece without a lightmap uses
 * the white quadrant, from the UV (0.5, 0.5)); then `2 × layer` and `2 × slot` are added.
 */
export interface Uv2Pack {
  slot: number
  layer: number
  scale: number
  offsetU: number
  offsetV: number
}

/** One primitive of one model at a list of placements, inside one group. */
export interface MergePiece {
  /** The model's id (MergeModels key). */
  model: number
  /** Its index in the model's primitives. */
  primitive: number
  /** The instances' matrices, 16 floats each (Babylon's layout). */
  matrices: Float32Array
  /** Per instance `pivotSize` floats written to every vertex of that instance (the group's `pivotSize`; else unused). */
  pivots?: Float32Array | null
  /** Emit a back copy (reversed winding, negated normals): a two-sided material on a single-sided group. */
  twoSided: boolean
  /** Reverse the winding: the piece's effective side orientation differs from the group's. */
  flip: boolean
  /** The table mode's UV2 packing; null: UV2 as is. */
  uv2: Uv2Pack | null
  /** T12-M: the tier (1, 2; 0 or absent: not banded). Tier-2 pieces are emitted after every other piece of the group. */
  tier?: number
  /**
   * T12-M: TEXCOORD_1 and TEXCOORD_2 are the tree wind contract (a swapped species), not a lightmap UV: `sroTreeW` is
   * decoded from them and UV2 is the white quadrant's centre (0.5, 0.5) through the pack.
   */
  wind?: boolean
}

/** One group of a region: its key and pieces. */
export interface MergeGroupJob {
  key: string
  pieces: MergePiece[]
  /** Floats per vertex of the pivot attribute (0: none; 3: the tree's origin, BT-T; 4: a prop's centre and radius). */
  pivotSize: 0 | 3 | 4
  /** The group's pieces also go into the region's shadow proxy (opaque, LOD group 2; BATCHING §3.9). */
  proxy: boolean
  /** T12-M: write `sroTreeW` (4 bytes per vertex); `leaf`: a leaf group (a retail piece's synthesized flutter). */
  treeW?: boolean
  leaf?: boolean
  /** T12-M (WF15): copy the group's tiers 0–1 into the region's cut-out caster (`lod` picks its `sroCull` sphere). */
  caster?: { lod: 2 | 3 } | null
}

export type Vec3 = [number, number, number]

/** A merged group: vertex arrays ready for `setVerticesData`, and its world bounds. */
export interface MergedGroup {
  key: string
  positions: Float32Array
  normals: Float32Array
  /** null when no piece of the group has TEXCOORD_0. */
  uvs: Float32Array | null
  /** null when no piece has TEXCOORD_1 and none packs a table slot. */
  uvs2: Float32Array | null
  pivots: Float32Array | null
  pivotSize: number
  /** T12-M: `sroTreeW`, 4 bytes per vertex (unorm8x4), or null (the group has no `treeW`). */
  treeW?: Uint8Array | null
  /** 16-bit while the group has at most 65 536 vertices. */
  indices: Uint16Array | Uint32Array
  vertices: number
  triangles: number
  /** T12-M: the prefix holding the tier 0–1 pieces (the LOD1 silhouette): vertices and indices (absent: all). */
  casterVertices?: number
  casterIndices?: number
  min: Vec3
  max: Vec3
}

/**
 * T12-M (WF15): a region's cut-out caster vertex data (render/shadows.ts `mergeCutoutCasters`' layout): world-space
 * positions, normals, uv, the packed uv2, the per-vertex `sroCull` sphere (radius −1: never collapses), 32-bit indices.
 */
export interface MergedCaster {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  uvs2: Float32Array
  cull: Float32Array
  indices: Uint32Array
  /** The groups copied in (job order): the main thread checks it against its caster sources. */
  groups: number
}

/** The region's opaque shadow proxy (positions only; front faces once, no back copies). */
export interface MergedProxy {
  positions: Float32Array
  indices: Uint32Array
  triangles: number
  min: Vec3
  max: Vec3
}

export interface MergeResult {
  groups: MergedGroup[]
  proxy: MergedProxy | null
  /** T12-M (WF15): the cut-out caster of the groups flagged `caster`, or null / absent (none flagged, nothing to copy). */
  caster?: MergedCaster | null
  vertices: number
  triangles: number
  /** Time spent merging (ms). */
  ms: number
}

/** Finds a model's data by id (a map lookup in the worker). */
export type MergeModels = (id: number) => MergeModelData | undefined

// ---- matrices ---------------------------------------------------------------------------------------------------

/** The determinant of the upper 3 × 3 of a Babylon matrix at `o`. */
export function det3(m: ArrayLike<number>, o = 0): number {
  const a = m[o]!, b = m[o + 1]!, c = m[o + 2]!
  const d = m[o + 4]!, e = m[o + 5]!, f = m[o + 6]!
  const g = m[o + 8]!, h = m[o + 9]!, i = m[o + 10]!
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
}

/**
 * The normal matrix of the upper 3 × 3 at `m[o]`: transpose(inverse(A)) = cofactor(A) / det(A), written to `out` (9
 * floats, row-major like Babylon's: n'_c = Σ_r n_r × out[r × 3 + c]). `out` is never the source (§4.5 finding 1).
 * Returns the determinant (0: degenerate, `out` = identity).
 */
export function normalMatrix3(m: ArrayLike<number>, o: number, out: Float64Array | Float32Array): number {
  const a = m[o]!, b = m[o + 1]!, c = m[o + 2]!
  const d = m[o + 4]!, e = m[o + 5]!, f = m[o + 6]!
  const g = m[o + 8]!, h = m[o + 9]!, i = m[o + 10]!
  const c00 = e * i - f * h, c01 = -(d * i - f * g), c02 = d * h - e * g
  const det = a * c00 + b * c01 + c * c02
  if (!det || !Number.isFinite(det)) {
    out.fill(0)
    out[0] = out[4] = out[8] = 1
    return 0
  }
  const k = 1 / det
  out[0] = c00 * k
  out[1] = c01 * k
  out[2] = c02 * k
  out[3] = -(b * i - c * h) * k
  out[4] = (a * i - c * g) * k
  out[5] = -(a * h - b * g) * k
  out[6] = (b * f - c * e) * k
  out[7] = -(a * f - c * d) * k
  out[8] = (a * e - b * d) * k
  return det
}

// ---- UV2 packing ------------------------------------------------------------------------------------------------

/** The packed UV2 of a lightmap UV (u, v) for a piece (the shader decodes it with `floor(uv / 2)`). */
export function packUv2(u: number, v: number, p: Uv2Pack): [number, number] {
  return [u * p.scale + p.offsetU + 2 * p.layer, v * p.scale + p.offsetV + 2 * p.slot]
}

/** The inverse of packUv2: (layer, slot, the quadrant UV). */
export function unpackUv2(pu: number, pv: number): { layer: number; slot: number; u: number; v: number } {
  const layer = Math.floor(pu / 2)
  const slot = Math.floor(pv / 2)
  return { layer, slot, u: pu - 2 * layer, v: pv - 2 * slot }
}

/** Throws when a pack cannot round-trip (ids at or above UV2_ID_LIMIT, or a quadrant outside [0, 1]). */
export function checkUv2Pack(p: Uv2Pack): void {
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n < UV2_ID_LIMIT
  if (!ok(p.slot) || !ok(p.layer)) throw new Error(`UV2 pack out of range: slot ${p.slot}, layer ${p.layer} (limit ${UV2_ID_LIMIT})`)
  if (!(p.scale > 0) || p.offsetU < 0 || p.offsetV < 0 || p.offsetU + p.scale > 1 || p.offsetV + p.scale > 1) {
    throw new Error(`UV2 quadrant outside the layer: scale ${p.scale}, offset ${p.offsetU}, ${p.offsetV}`)
  }
}

// ---- the merge ----------------------------------------------------------------------------------------------------

interface Sized {
  piece: MergePiece
  prim: MergePrimitive
  instances: number
  copies: number
}

function sizeGroup(job: MergeGroupJob, models: MergeModels): { list: Sized[]; vertices: number; indices: number; uv: boolean; uv2: boolean } {
  const list: Sized[] = []
  let vertices = 0
  let indices = 0
  let uv = false
  let uv2 = false
  for (const piece of job.pieces) {
    const prim = models(piece.model)?.primitives[piece.primitive]
    if (!prim) throw new Error(`merge: model ${piece.model} primitive ${piece.primitive} is not loaded`)
    const instances = Math.floor(piece.matrices.length / 16)
    const n = Math.floor(prim.positions.length / 3)
    if (!instances || !n || prim.indices.length < 3) continue
    if (piece.uv2) checkUv2Pack(piece.uv2)
    const copies = piece.twoSided ? 2 : 1
    list.push({ piece, prim, instances, copies })
    vertices += n * instances * copies
    indices += (prim.indices.length - (prim.indices.length % 3)) * instances * copies
    if (prim.uvs) uv = true
    if (prim.uvs2 || piece.uv2) uv2 = true
  }
  // T12-M: tier-2 pieces last (a stable order otherwise: a group without tier 2 merges exactly as before).
  if (list.some(s => s.piece.tier === 2)) {
    const first = list.filter(s => s.piece.tier !== 2)
    list.splice(0, list.length, ...first, ...list.filter(s => s.piece.tier === 2))
  }
  return { list, vertices, indices, uv, uv2 }
}

/** A value in [0, 1] as an unorm8 byte (clamped). */
export function unorm8(v: number): number {
  return v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0
}

/** Merges one group (null when it has no triangles). */
export function mergeGroup(job: MergeGroupJob, models: MergeModels): MergedGroup | null {
  const { list, vertices, indices: indexCount, uv, uv2 } = sizeGroup(job, models)
  if (!vertices || !indexCount) return null
  const P = new Float32Array(vertices * 3)
  const N = new Float32Array(vertices * 3)
  const U = uv ? new Float32Array(vertices * 2) : null
  const U2 = uv2 ? new Float32Array(vertices * 2) : null
  const ps = job.pivotSize
  const PV = ps ? new Float32Array(vertices * ps) : null
  const W = job.treeW ? new Uint8Array(vertices * 4) : null
  const leafW = job.leaf ? 1 : 0
  const I = vertices <= 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount)
  let casterVertices = vertices
  let casterIndices = indexCount
  const nm = new Float64Array(9)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let vo = 0
  let io = 0
  for (const { piece, prim, instances, copies } of list) {
    // T12-M: the caster prefix ends where the tier-2 pieces start.
    if (piece.tier === 2 && casterVertices === vertices) {
      casterVertices = vo
      casterIndices = io
    }
    const n = Math.floor(prim.positions.length / 3)
    const pos = prim.positions
    const nrm = prim.normals && prim.normals.length >= n * 3 ? prim.normals : null
    const tex = prim.uvs && prim.uvs.length >= n * 2 ? prim.uvs : null
    // T12-M: a `wind` piece's TEXCOORD_1 is the wind data, never a lightmap UV (the white quadrant through the pack).
    const wind = !!piece.wind
    const raw2 = prim.uvs2 && prim.uvs2.length >= n * 2 ? prim.uvs2 : null
    const tex2 = wind ? null : raw2
    const w1 = wind ? raw2 : null
    const w2 = wind && prim.uvs3 && prim.uvs3.length >= n * 2 ? prim.uvs3 : null
    const idx = prim.indices
    const triIdx = idx.length - (idx.length % 3)
    const pack = piece.uv2
    const mats = piece.matrices
    const pivots = ps && piece.pivots && piece.pivots.length >= instances * ps ? piece.pivots : null
    for (let k = 0; k < instances; k++) {
      const o = k * 16
      const m0 = mats[o]!, m1 = mats[o + 1]!, m2 = mats[o + 2]!, m3 = mats[o + 3]!
      const m4 = mats[o + 4]!, m5 = mats[o + 5]!, m6 = mats[o + 6]!, m7 = mats[o + 7]!
      const m8 = mats[o + 8]!, m9 = mats[o + 9]!, m10 = mats[o + 10]!, m11 = mats[o + 11]!
      const m12 = mats[o + 12]!, m13 = mats[o + 13]!, m14 = mats[o + 14]!, m15 = mats[o + 15]!
      const det = normalMatrix3(mats, o, nm)
      const q0 = nm[0]!, q1 = nm[1]!, q2 = nm[2]!, q3 = nm[3]!, q4 = nm[4]!, q5 = nm[5]!, q6 = nm[6]!, q7 = nm[7]!, q8 = nm[8]!
      const projective = m3 !== 0 || m7 !== 0 || m11 !== 0 || m15 !== 1
      // Front faces stay front-facing in the group's orientation (see the file comment).
      const reverse = piece.flip !== (det < 0) !== prim.mirrored
      for (let copy = 0; copy < copies; copy++) {
        const back = copy === 1
        const base = vo
        for (let v = 0; v < n; v++) {
          const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!
          let wx = x * m0 + y * m4 + z * m8 + m12
          let wy = x * m1 + y * m5 + z * m9 + m13
          let wz = x * m2 + y * m6 + z * m10 + m14
          if (projective) {
            const w = x * m3 + y * m7 + z * m11 + m15
            if (w !== 0) {
              wx /= w
              wy /= w
              wz /= w
            }
          }
          P[vo * 3] = wx
          P[vo * 3 + 1] = wy
          P[vo * 3 + 2] = wz
          if (wx < minX) minX = wx
          if (wy < minY) minY = wy
          if (wz < minZ) minZ = wz
          if (wx > maxX) maxX = wx
          if (wy > maxY) maxY = wy
          if (wz > maxZ) maxZ = wz
          let nx = 0, ny = 1, nz = 0
          if (nrm) {
            const a = nrm[v * 3]!, b = nrm[v * 3 + 1]!, c = nrm[v * 3 + 2]!
            nx = a * q0 + b * q3 + c * q6
            ny = a * q1 + b * q4 + c * q7
            nz = a * q2 + b * q5 + c * q8
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
            if (len > 0) {
              nx /= len
              ny /= len
              nz /= len
            } else {
              nx = 0
              ny = 1
              nz = 0
            }
          }
          if (back) {
            nx = -nx
            ny = -ny
            nz = -nz
          }
          N[vo * 3] = nx
          N[vo * 3 + 1] = ny
          N[vo * 3 + 2] = nz
          if (U && tex) {
            U[vo * 2] = tex[v * 2]!
            U[vo * 2 + 1] = tex[v * 2 + 1]!
          }
          if (U2) {
            let lu = tex2 ? tex2[v * 2]! : 0.5
            let lv = tex2 ? tex2[v * 2 + 1]! : 0.5
            if (pack) {
              lu = lu * pack.scale + pack.offsetU + 2 * pack.layer
              lv = lv * pack.scale + pack.offsetV + 2 * pack.slot
            } else if (!tex2) {
              lu = 0
              lv = 0
            }
            U2[vo * 2] = lu
            U2[vo * 2 + 1] = lv
          }
          if (PV && pivots) for (let j = 0; j < ps; j++) PV[vo * ps + j] = pivots[k * ps + j]!
          if (W) {
            const o4 = vo * 4
            if (wind) {
              // The glb's values: (flex, 1 − phase), (flutter, 1 − AO) (TREES §3.4: Blender flips V).
              W[o4] = w1 ? unorm8(w1[v * 2]!) : 0
              W[o4 + 1] = w1 ? unorm8(1 - w1[v * 2 + 1]!) : 0
              W[o4 + 2] = w2 ? unorm8(w2[v * 2]!) : 0
              W[o4 + 3] = w2 ? unorm8(1 - w2[v * 2 + 1]!) : 255
            } else {
              // A retail tree: the h² bend's shape around its root (flex² × 1.2 m = 0.012 h² below TREE_W_FLEX_M).
              const root = pivots && ps >= 3
              const rx = root ? pivots[k * ps]! : m12
              const ry = root ? pivots[k * ps + 1]! : m13
              const rz = root ? pivots[k * ps + 2]! : m14
              const flex = unorm8((wy - ry) / TREE_W_FLEX_M)
              const ph = (rx * 12.9898 + rz * 78.233) % 1
              W[o4] = flex
              W[o4 + 1] = unorm8(ph < 0 ? ph + 1 : ph)
              W[o4 + 2] = flex * leafW
              W[o4 + 3] = 255
            }
          }
          vo++
        }
        if (reverse !== back) {
          for (let t = 0; t < triIdx; t += 3) {
            I[io++] = base + idx[t]!
            I[io++] = base + idx[t + 2]!
            I[io++] = base + idx[t + 1]!
          }
        } else {
          for (let t = 0; t < triIdx; t++) I[io++] = base + idx[t]!
        }
      }
    }
  }
  return {
    key: job.key,
    positions: P,
    normals: N,
    uvs: U,
    uvs2: U2,
    pivots: PV,
    pivotSize: ps,
    ...(W ? { treeW: W } : {}),
    indices: I,
    vertices,
    triangles: indexCount / 3,
    ...(casterVertices < vertices ? { casterVertices, casterIndices } : {}),
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  }
}

/** The shadow proxy of the groups flagged `proxy`: world positions of their pieces, front faces only. */
export function mergeProxy(jobs: readonly MergeGroupJob[], models: MergeModels): MergedProxy | null {
  const list: Sized[] = []
  let vertices = 0
  let indexCount = 0
  for (const job of jobs) {
    if (!job.proxy) continue
    for (const piece of job.pieces) {
      const prim = models(piece.model)?.primitives[piece.primitive]
      if (!prim) continue
      const instances = Math.floor(piece.matrices.length / 16)
      const n = Math.floor(prim.positions.length / 3)
      if (!instances || !n || prim.indices.length < 3) continue
      list.push({ piece, prim, instances, copies: 1 })
      vertices += n * instances
      indexCount += (prim.indices.length - (prim.indices.length % 3)) * instances
    }
  }
  if (!vertices || !indexCount) return null
  const P = new Float32Array(vertices * 3)
  const I = new Uint32Array(indexCount)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let vo = 0
  let io = 0
  for (const { piece, prim, instances } of list) {
    const n = Math.floor(prim.positions.length / 3)
    const pos = prim.positions
    const idx = prim.indices
    const triIdx = idx.length - (idx.length % 3)
    const mats = piece.matrices
    for (let k = 0; k < instances; k++) {
      const o = k * 16
      const m0 = mats[o]!, m1 = mats[o + 1]!, m2 = mats[o + 2]!
      const m4 = mats[o + 4]!, m5 = mats[o + 5]!, m6 = mats[o + 6]!
      const m8 = mats[o + 8]!, m9 = mats[o + 9]!, m10 = mats[o + 10]!
      const m12 = mats[o + 12]!, m13 = mats[o + 13]!, m14 = mats[o + 14]!
      const base = vo
      for (let v = 0; v < n; v++) {
        const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!
        const wx = x * m0 + y * m4 + z * m8 + m12
        const wy = x * m1 + y * m5 + z * m9 + m13
        const wz = x * m2 + y * m6 + z * m10 + m14
        P[vo * 3] = wx
        P[vo * 3 + 1] = wy
        P[vo * 3 + 2] = wz
        if (wx < minX) minX = wx
        if (wy < minY) minY = wy
        if (wz < minZ) minZ = wz
        if (wx > maxX) maxX = wx
        if (wy > maxY) maxY = wy
        if (wz > maxZ) maxZ = wz
        vo++
      }
      // The proxy material draws both faces (render/shadows.ts): the winding does not matter here.
      for (let t = 0; t < triIdx; t++) I[io++] = base + idx[t]!
    }
  }
  return { positions: P, indices: I, triangles: indexCount / 3, min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
}

/** T12-M: a mesh's LOD1 prefix (its first vertices and indices: the tiers a cut-out caster copies), when it has tier 2. */
export interface CasterPrefix {
  vertices: number
  indices: number
}

/**
 * The LOD1 prefix of a tree group mesh (`metadata.sroCasterPrefix`: region-batch.ts sets it, render/shadows.ts reads
 * it), or null (the whole mesh casts).
 */
export function casterPrefixOf(mesh: { metadata?: unknown } | null | undefined): CasterPrefix | null {
  const p = (mesh?.metadata as { sroCasterPrefix?: CasterPrefix } | null | undefined)?.sroCasterPrefix
  return p && Number.isInteger(p.vertices) && Number.isInteger(p.indices) ? p : null
}

/** T12-M: a merged group's tier 0–1 prefix (its LOD1 silhouette): vertices and indices (the whole group without tier 2). */
export function casterPrefix(g: Pick<MergedGroup, 'vertices' | 'indices' | 'casterVertices' | 'casterIndices'>): { vertices: number; indices: number } {
  return { vertices: g.casterVertices ?? g.vertices, indices: g.casterIndices ?? g.indices.length }
}

/**
 * T12-M (WF15): the region's cut-out caster from its merged groups flagged `caster` (pairs of job and group, in job
 * order): each group's tier 0–1 prefix (`casterPrefix`), its `sroCull` sphere (LOD group 3: the group's bounding
 * sphere, as the group mesh's; group 2: radius −1). A group without uv or uv2 is skipped, as render/shadows.ts
 * `mergeCutoutCasters` skips such a mesh. null when nothing is copied.
 */
export function mergeCaster(pairs: ReadonlyArray<{ job: MergeGroupJob; group: MergedGroup }>): MergedCaster | null {
  const use = pairs.filter(p => p.job.caster && p.group.uvs && p.group.uvs2 && casterPrefix(p.group).vertices >= 3)
  let nv = 0
  let ni = 0
  for (const { group } of use) {
    const c = casterPrefix(group)
    nv += c.vertices
    ni += c.indices
  }
  if (!nv) return null
  const positions = new Float32Array(nv * 3)
  const normals = new Float32Array(nv * 3)
  const uvs = new Float32Array(nv * 2)
  const uvs2 = new Float32Array(nv * 2)
  const cull = new Float32Array(nv * 4)
  const indices = new Uint32Array(ni)
  let v = 0
  let i = 0
  for (const { job, group: g } of use) {
    const { vertices: n, indices: ki } = casterPrefix(g)
    positions.set(g.positions.subarray(0, n * 3), v * 3)
    normals.set(g.normals.subarray(0, n * 3), v * 3)
    uvs.set(g.uvs!.subarray(0, n * 2), v * 2)
    uvs2.set(g.uvs2!.subarray(0, n * 2), v * 2)
    let cx = 0, cy = 0, cz = 0, r = -1
    if (job.caster!.lod === 3) {
      cx = (g.min[0] + g.max[0]) / 2
      cy = (g.min[1] + g.max[1]) / 2
      cz = (g.min[2] + g.max[2]) / 2
      r = Math.hypot(g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]) / 2
    }
    for (let k = v; k < v + n; k++) {
      cull[k * 4] = cx
      cull[k * 4 + 1] = cy
      cull[k * 4 + 2] = cz
      cull[k * 4 + 3] = r
    }
    const idx = g.indices
    for (let k = 0; k < ki; k++) indices[i++] = idx[k]! + v
    v += n
  }
  return { positions, normals, uvs, uvs2, cull, indices, groups: use.length }
}

/** Merges a region: every group (in job order, empty ones left out), the shadow proxy and (T12-M) the cut-out caster. */
export function mergeRegion(jobs: readonly MergeGroupJob[], models: MergeModels, now: () => number = () => performance.now()): MergeResult {
  const t0 = now()
  const groups: MergedGroup[] = []
  const casters: Array<{ job: MergeGroupJob; group: MergedGroup }> = []
  let vertices = 0
  let triangles = 0
  for (const job of jobs) {
    const g = mergeGroup(job, models)
    if (!g) continue
    groups.push(g)
    if (job.caster) casters.push({ job, group: g })
    vertices += g.vertices
    triangles += g.triangles
  }
  const proxy = mergeProxy(jobs, models)
  // T12-M: the caster only when a group asked for it (a wave-10 merge's result is unchanged).
  const caster = casters.length ? mergeCaster(casters) : null
  return { groups, proxy, ...(caster ? { caster } : {}), vertices, triangles, ms: now() - t0 }
}

/** The buffers of a result, for a transfer out of the worker. */
export function mergeTransferables(r: MergeResult): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>()
  const add = (a: ArrayBufferView | null) => {
    if (a && a.buffer instanceof ArrayBuffer) out.add(a.buffer)
  }
  for (const g of r.groups) {
    add(g.positions)
    add(g.normals)
    add(g.uvs)
    add(g.uvs2)
    add(g.pivots)
    add(g.treeW ?? null)
    add(g.indices)
  }
  if (r.proxy) {
    add(r.proxy.positions)
    add(r.proxy.indices)
  }
  const c = r.caster
  if (c) for (const a of [c.positions, c.normals, c.uvs, c.uvs2, c.cull, c.indices]) add(a)
  return [...out]
}

// ---- the worker protocol (merge-worker.ts; region-batch.ts runs the same handler in-process) ----------------------

/** Messages to the merge worker. */
export type MergeRequest =
  /** Model geometry the worker keeps until dropped (copied: the main thread keeps its export). */
  | { t: 'models'; models: Array<{ id: number; primitives: MergePrimitive[] }> }
  | { t: 'drop'; ids: number[] }
  | { t: 'merge'; id: number; groups: MergeGroupJob[] }

/** Messages from the merge worker. */
export type MergeResponse =
  | { ready: true }
  | { t: 'merged'; id: number; result: MergeResult }
  | { t: 'error'; id: number; error: string }

/** The worker's state: the model geometry it was sent, and the handler of every message. */
export class MergeHost {
  readonly models = new Map<number, MergeModelData>()

  /** Handles one request; a merge returns its answer (the caller posts it with `mergeTransferables`). */
  handle(msg: MergeRequest): MergeResponse | null {
    if (msg.t === 'models') {
      for (const m of msg.models) this.models.set(m.id, { primitives: m.primitives })
      return null
    }
    if (msg.t === 'drop') {
      for (const id of msg.ids) this.models.delete(id)
      return null
    }
    try {
      return { t: 'merged', id: msg.id, result: mergeRegion(msg.groups, id => this.models.get(id)) }
    } catch (err) {
      return { t: 'error', id: msg.id, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
