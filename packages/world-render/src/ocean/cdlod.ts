/**
 * Portions ported from Tidewater (github.com/dgreenheck/tidewater, `CDLOD.js` at `4811ba4`), MIT licence, Copyright (c)
 * 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.
 *
 * The ocean's CDLOD grid (docs/COAST.md §8.2; Strugar 2010): one G × G grid drawn once per selected quadtree node as
 * thin instances. LOD l nodes are `leaf · 2^l` wide and cover the distances up to `range_l = leaf · 2^l · 2.5`; over
 * the last 34 % of each range the vertices morph toward the next coarser lattice, so levels neither crack nor pop.
 * Nodes are culled against the frustum, the coast field's "water here" pyramid (a node wholly over land selects
 * nothing) and the full-fog distance (D27: nothing is drawn, and no FFT runs, for sea nobody can see).
 *
 * A node record is (x, z, size, lod) in glTF metres: a whole node has size = leaf · 2^lod; where a parent keeps a
 * quadrant its selected children do not cover, the quadrant is drawn at the parent's lod with size = leaf · 2^(lod−1),
 * and the vertex stage snaps its extra vertices onto the parent's lattice (`floor(p / spacing + 0.25)`), so the
 * quadrant has the parent's spacing and joins its neighbours without a T-junction.
 *
 * The vertex morph (both shader languages; `cdlodMorph` below is the same in TS):
 *   spacing = leaf · 2^lod / G;   p = origin-relative lattice position, snapped;
 *   d = |camera − (p, sea level)|;   k = saturate((d − start_l) / (range_l − start_l)),  start_l = range_l (0.5 + 0.5 · 0.66);
 *   p −= fract(p / (2 spacing)) · 2 spacing · k.
 */

/** Tidewater's defaults, ours per COAST §8.2. */
export const CDLOD_LEAF_M = 8
export const CDLOD_RANGE_FACTOR = 2.5
export const CDLOD_MORPH_START = 0.66
/** The node cap (the thin-instance buffers are allocated once at this size, F1). */
export const CDLOD_MAX_NODES = 256
/** Vertical extent of a node's box around the sea level (m): the waves, the swash sheet. */
export const CDLOD_BOX_BELOW_M = 4
export const CDLOD_BOX_ABOVE_M = 5

export interface CdlodSettings {
  /** The lattice origin (the coast field's corner): every node is aligned to it. */
  originX: number
  originZ: number
  levels: number
  seaLevelM: number
}

/** A frustum as four or six planes (a·x + b·y + c·z + d ≥ 0 inside), e.g. Babylon's Frustum.GetPlanes. */
export type PlaneList = ReadonlyArray<{ normal: { x: number; y: number; z: number }; d: number }>

export interface CdlodView {
  x: number
  y: number
  z: number
  /** Culling planes (null: none). */
  planes: PlaneList | null
  /** Nothing beyond this distance is selected (the fog cut, D27; Infinity: none). */
  cutM: number
}

/** Range of lod l (m). */
export function cdlodRange(lod: number): number {
  return CDLOD_LEAF_M * 2 ** lod * CDLOD_RANGE_FACTOR
}

/** Morph start of lod l (m): the last 34 % of [range_(l−1), range_l]. */
export function cdlodMorphStart(lod: number): number {
  const r = cdlodRange(lod)
  const prev = lod > 0 ? r / 2 : 0
  return prev + (r - prev) * CDLOD_MORPH_START
}

/** The vertex morph in TS (the shaders' formula): the world xz of a grid vertex. */
export function cdlodMorph(
  node: { x: number; z: number; size: number; lod: number },
  g: { u: number; v: number },
  grid: number,
  s: Pick<CdlodSettings, 'originX' | 'originZ' | 'seaLevelM'>,
  cam: { x: number; y: number; z: number },
): { x: number; z: number; k: number } {
  const spacing = (CDLOD_LEAF_M * 2 ** node.lod) / grid
  let px = node.x + g.u * node.size - s.originX
  let pz = node.z + g.v * node.size - s.originZ
  px = Math.floor(px / spacing + 0.25) * spacing
  pz = Math.floor(pz / spacing + 0.25) * spacing
  const d = Math.hypot(cam.x - (px + s.originX), cam.y - s.seaLevelM, cam.z - (pz + s.originZ))
  const r = cdlodRange(node.lod), st = cdlodMorphStart(node.lod)
  const k = Math.min(1, Math.max(0, (d - st) / (r - st)))
  const fract = (v: number) => v - Math.floor(v)
  px -= fract(px / (2 * spacing)) * 2 * spacing * k
  pz -= fract(pz / (2 * spacing)) * 2 * spacing * k
  return { x: px + s.originX, z: pz + s.originZ, k }
}

/** The selection's water test: does the node [x, x + size) × [z, z + size) draw any water? */
export type WaterTest = (x: number, z: number, size: number) => boolean

/** Selects the nodes into `out` (4 floats each: x, z, size, lod); returns the count (≤ out.length / 4). */
export function selectNodes(view: Readonly<CdlodView>, s: Readonly<CdlodSettings>, water: WaterTest, out: Float32Array): number {
  const cap = Math.floor(out.length / 4)
  const top = s.levels - 1
  const topSize = CDLOD_LEAF_M * 2 ** top
  const reach = Math.min(view.cutM, cdlodRange(top))
  if (!(reach > 0)) return 0
  let count = 0
  const y0 = s.seaLevelM - CDLOD_BOX_BELOW_M, y1 = s.seaLevelM + CDLOD_BOX_ABOVE_M

  const boxDist = (x: number, z: number, size: number): number => {
    const dx = Math.max(x - view.x, 0, view.x - (x + size))
    const dz = Math.max(z - view.z, 0, view.z - (z + size))
    const dy = Math.max(y0 - view.y, 0, view.y - y1)
    return Math.hypot(dx, dy, dz)
  }
  const inFrustum = (x: number, z: number, size: number): boolean => {
    const planes = view.planes
    if (!planes) return true
    for (const p of planes) {
      const n = p.normal
      // The box corner furthest along the plane normal.
      const px = n.x >= 0 ? x + size : x
      const py = n.y >= 0 ? y1 : y0
      const pz = n.z >= 0 ? z + size : z
      if (n.x * px + n.y * py + n.z * pz + p.d < 0) return false
    }
    return true
  }
  const emit = (x: number, z: number, size: number, lod: number): void => {
    if (count >= cap) return
    const o = count * 4
    out[o] = x
    out[o + 1] = z
    out[o + 2] = size
    out[o + 3] = lod
    count++
  }
  /** Strugar's selection: false = out of this lod's range (the parent draws the area). */
  const select = (x: number, z: number, lod: number): boolean => {
    const size = CDLOD_LEAF_M * 2 ** lod
    const d = boxDist(x, z, size)
    if (d > cdlodRange(lod)) return false
    if (d > view.cutM || !water(x, z, size) || !inFrustum(x, z, size)) return true
    if (lod === 0 || d > cdlodRange(lod - 1)) {
      emit(x, z, size, lod)
      return true
    }
    const h = size / 2
    for (const [cx, cz] of [[x, z], [x + h, z], [x, z + h], [x + h, z + h]] as const) {
      if (!select(cx, cz, lod - 1)) {
        // The quadrant stays at this lod (drawn with this lod's spacing, see the file comment).
        if (boxDist(cx, cz, h) <= view.cutM && water(cx, cz, h) && inFrustum(cx, cz, h)) emit(cx, cz, h, lod)
      }
    }
    return true
  }

  // The top-level nodes around the camera, aligned to the lattice.
  const ix0 = Math.floor((view.x - reach - s.originX) / topSize), ix1 = Math.floor((view.x + reach - s.originX) / topSize)
  const iz0 = Math.floor((view.z - reach - s.originZ) / topSize), iz1 = Math.floor((view.z + reach - s.originZ) / topSize)
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = s.originX + ix * topSize, z = s.originZ + iz * topSize
      if (boxDist(x, z, topSize) > reach) continue
      if (!select(x, z, top)) {
        if (water(x, z, topSize) && inFrustum(x, z, topSize)) emit(x, z, topSize, top)
      }
    }
  }
  return count
}

/** The grid mesh data: (G + 1)² vertices in [0, 1]² (x, 0, z), up normals, 2 G² triangles (counter-clockwise from +y). */
export function gridData(grid: number): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const n = grid + 1
  const positions = new Float32Array(n * n * 3)
  const normals = new Float32Array(n * n * 3)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3
      positions[o] = i / grid
      positions[o + 2] = j / grid
      normals[o + 1] = 1
    }
  }
  const indices = new Uint32Array(grid * grid * 6)
  let k = 0
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1
      // Alternate the diagonal so the morph's collapsed rows stay symmetric.
      if ((i + j) & 1) indices.set([a, c, b, b, c, d], k)
      else indices.set([a, c, d, a, d, b], k)
      k += 6
    }
  }
  return { positions, normals, indices }
}
