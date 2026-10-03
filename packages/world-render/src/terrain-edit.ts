/**
 * The terrain's edit maths (docs/WORLD_EDITOR.md seam S-TERR; docs/WAVE_PLAN8.md §4.3, D5): pure functions the
 * TerrainRenderer's `updateRegion` runs on a region's TerrainBin before it re-uploads the mesh and the layer map.
 *
 * - **Layers from words.** The native per-cell layering (TERRAIN.md §2.3) of a 17 × 17 block of raw texture words,
 *   ported from the converter's `blockLayers` (packages/convert/src/world/terrain.ts) so the client bundle never pulls
 *   the converter's MAPM reader. The block is read straight out of the region's 97 × 97 word grid (block (bx, bz) =
 *   vertices 16 bx … 16 bx + 16): rebuilding every block of the export this way gives its layer planes byte for byte
 *   (416 of 416 regions of jangan-fields, `terrain-edit.test.ts`). Only the blocks whose words changed are rebuilt;
 *   every other cell keeps its layers as they are.
 * - **The normal ring.** A moved vertex makes the baked normals of its one-vertex ring stale; they are baked again the
 *   converter's way from the heights (across a seam when the neighbour is loaded: the same bytes on both sides), so the
 *   mesh, the grass bake's slope fade and the other readers of the baked normals follow the edit.
 */
import { CELLS, GRID, MAX_TERRAIN_LAYERS } from '../../convert/src/world/format.ts'

/** Vertices per MAPM block side (formats/mapm.ts MAPM_BLOCK_VERTICES) and cells per block side. */
const BLOCK_V = 17
const BLOCK_T = 16
/** Blocks per region side. */
const BLOCKS = 6
/** Bits 0..9 of a texture word: the tile id (formats/mapm.ts MAPM_TEXTURE_ID_MASK); bits 13..15 the tiling code. */
const TILE_ID_MASK = 0x3ff

/** A rectangle of region grid vertices, inclusive (0..96 on both axes; gz north). */
export interface GridRect {
  x0: number
  z0: number
  x1: number
  z1: number
}

/** The whole region grid. */
export const FULL_GRID_RECT: Readonly<GridRect> = { x0: 0, z0: 0, x1: GRID - 1, z1: GRID - 1 }

/** `rect` clamped to the grid (null when empty); undefined: the whole grid. */
export function clampGridRect(rect: GridRect | null | undefined): GridRect | null {
  if (!rect) return { ...FULL_GRID_RECT }
  const x0 = Math.max(0, Math.floor(rect.x0)), z0 = Math.max(0, Math.floor(rect.z0))
  const x1 = Math.min(GRID - 1, Math.ceil(rect.x1)), z1 = Math.min(GRID - 1, Math.ceil(rect.z1))
  return x0 > x1 || z0 > z1 ? null : { x0, z0, x1, z1 }
}

/**
 * The converter's `blockLayers` on block (bx, bz) of a 97 × 97 word grid: per cell of the block (index cz × 16 + cx)
 * the layers to draw in order as [key, mask4], key = (tile id << 3) | tiling code; the first layer has mask 15.
 */
export function blockLayersOf(words: ArrayLike<number>, bx: number, bz: number): Array<Array<[key: number, mask: number]>> {
  const V = BLOCK_V
  const T = BLOCK_T
  const keys = new Int32Array(V * V)
  for (let z = 0; z < V; z++) {
    for (let x = 0; x < V; x++) {
      const w = words[(bz * T + z) * GRID + bx * T + x]!
      keys[z * V + x] = ((w & TILE_ID_MASK) << 3) | (w >>> 13)
    }
  }
  const distinct = [...new Set(keys)].sort((a, b) => a - b)
  const claimed = new Uint8Array(T * T)
  const out: Array<Array<[number, number]>> = Array.from({ length: T * T }, () => [])
  const corners = (cx: number, cz: number) => [cz * V + cx, cz * V + cx + 1, (cz + 1) * V + cx, (cz + 1) * V + cx + 1]
  for (const key of distinct) {
    const mask = new Uint8Array(V * V)
    for (let i = 0; i < V * V; i++) if (keys[i] === key) mask[i] = 1
    const touched = new Uint8Array(T * T)
    for (let cz = 0; cz < T; cz++) {
      for (let cx = 0; cx < T; cx++) if (corners(cx, cz).some(v => keys[v] === key)) touched[cz * T + cx] = 1
    }
    const near = new Uint8Array(T * T)
    for (let cz = 0; cz < T; cz++) {
      for (let cx = 0; cx < T; cx++) {
        const c = cz * T + cx
        if (!touched[c] || claimed[c]) continue
        claimed[c] = 1
        for (const v of corners(cx, cz)) mask[v] = 1
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            const nz = cz + dz
            if ((dx || dz) && nx >= 0 && nx < T && nz >= 0 && nz < T) near[nz * T + nx] = 1
          }
        }
      }
    }
    for (let cz = 0; cz < T; cz++) {
      for (let cx = 0; cx < T; cx++) {
        const c = cz * T + cx
        if (!touched[c] && !near[c]) continue
        const m = corners(cx, cz).reduce((bits, v, bit) => bits | (mask[v]! << bit), 0)
        if (m) out[c]!.push([key, m])
      }
    }
  }
  for (let c = 0; c < T * T; c++) {
    const list = out[c]!
    let last = -1
    for (let k = 0; k < list.length; k++) if (list[k]![1] === 15) last = k
    if (last > 0) out[c] = list.slice(last)
  }
  return out
}

/** What `relayer` reads and writes of a region's TerrainBin. */
export interface LayerPlanes {
  layerCount: number
  /** 97 × 97 raw texture words. */
  textures: Uint16Array
  /** layerCount × 96 × 96 × 4 bytes (format.ts). */
  layers: Uint8Array
}

export interface RelayerResult {
  /** Words that differed from the region's. */
  changedWords: number
  /** Blocks rebuilt (0: nothing changed, the planes are untouched). */
  blocks: number
  /** The layer count grew or shrank (the layer map texture is made again). */
  resized: boolean
}

/**
 * Writes `words` (97 × 97, or only `rect` of it) into `t.textures` and rebuilds the layer planes of the blocks whose
 * words changed (a word on a block edge belongs to both blocks). The other cells keep their bytes; `t.layers` and
 * `t.layerCount` are replaced when anything changed. Words equal to the region's change nothing at all.
 */
export function relayer(t: LayerPlanes, words: ArrayLike<number>, rect?: GridRect | null): RelayerResult {
  const r = clampGridRect(rect)
  const none: RelayerResult = { changedWords: 0, blocks: 0, resized: false }
  if (!r) return none
  const dirty = new Uint8Array(BLOCKS * BLOCKS)
  let changedWords = 0
  for (let gz: number = r.z0; gz <= r.z1; gz++) {
    for (let gx: number = r.x0; gx <= r.x1; gx++) {
      const i = gz * GRID + gx
      const w = words[i]! & 0xffff
      if (w === t.textures[i]) continue
      t.textures[i] = w
      changedWords++
      // the blocks holding this vertex (two on a block edge, four at a block corner)
      const bx1 = Math.min(BLOCKS - 1, gx >> 4), bz1 = Math.min(BLOCKS - 1, gz >> 4)
      const bx0 = gx % BLOCK_T === 0 && gx > 0 ? bx1 - 1 : bx1
      const bz0 = gz % BLOCK_T === 0 && gz > 0 ? bz1 - 1 : bz1
      for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) dirty[bz * BLOCKS + bx] = 1
    }
  }
  if (!changedWords) return none
  const plane = CELLS * CELLS * 4
  // the per-cell lists: the rebuilt blocks' from the words, every other cell's as its bytes stand
  const rebuilt = new Map<number, Array<[number, number]>>()
  let blocks = 0
  for (let b = 0; b < BLOCKS * BLOCKS; b++) {
    if (!dirty[b]) continue
    blocks++
    const bx = b % BLOCKS, bz = (b / BLOCKS) | 0
    const cells = blockLayersOf(t.textures, bx, bz)
    for (let z = 0; z < BLOCK_T; z++) {
      for (let x = 0; x < BLOCK_T; x++) {
        const list = cells[z * BLOCK_T + x]!
        rebuilt.set((bz * BLOCK_T + z) * CELLS + bx * BLOCK_T + x, list.length > MAX_TERRAIN_LAYERS ? list.slice(list.length - MAX_TERRAIN_LAYERS) : list)
      }
    }
  }
  const kept = (c: number): number => {
    let n = 0
    for (let k = 0; k < t.layerCount; k++) if (t.layers[k * plane + c * 4 + 3]) n = k + 1
    return n
  }
  let layerCount = 1
  for (let c = 0; c < CELLS * CELLS; c++) {
    const n = rebuilt.get(c)?.length ?? kept(c)
    if (n > layerCount) layerCount = n
  }
  const layers = new Uint8Array(layerCount * plane)
  for (let c = 0; c < CELLS * CELLS; c++) {
    const list = rebuilt.get(c)
    if (!list) {
      for (let k = 0; k < Math.min(t.layerCount, layerCount); k++) {
        const o = k * plane + c * 4
        layers[o] = t.layers[o]!
        layers[o + 1] = t.layers[o + 1]!
        layers[o + 2] = t.layers[o + 2]!
        layers[o + 3] = t.layers[o + 3]!
      }
      continue
    }
    list.forEach(([key, mask], k) => {
      const id = key >>> 3
      const o = k * plane + c * 4
      layers[o] = id & 0xff
      layers[o + 1] = (id >>> 8) | ((key & 7) << 2)
      layers[o + 2] = k === 0 ? 15 : mask
      layers[o + 3] = 255
    })
  }
  const resized = layerCount !== t.layerCount
  t.layers = layers
  t.layerCount = layerCount
  return { changedWords, blocks, resized }
}

/** What `editHeights` reads and writes of a region's TerrainBin. */
export interface HeightPlanes {
  /** 97 × 97 metres. */
  heights: Float32Array
  /** 97 × 97 × 4 baked normals (× 127), or empty. */
  normals: Int8Array
}

/**
 * Writes `heights` (97 × 97, or only `rect` of it) into `t.heights` and returns the changed vertices (grid indices).
 * When `heights` is `t.heights` itself (the caller wrote it in place), every vertex of `rect` counts as changed.
 */
export function editHeights(t: HeightPlanes, heights: ArrayLike<number>, rect?: GridRect | null): number[] {
  const r = clampGridRect(rect)
  const changed: number[] = []
  if (!r) return changed
  const inPlace = heights === t.heights
  for (let gz = r.z0; gz <= r.z1; gz++) {
    for (let gx = r.x0; gx <= r.x1; gx++) {
      const i = gz * GRID + gx
      if (inPlace) {
        changed.push(i)
        continue
      }
      const h = heights[i]!
      // bit compare (Float32): a write of the same value is no change; NaN never is one
      if (Object.is(Math.fround(h), t.heights[i])) continue
      t.heights[i] = h
      changed.push(i)
    }
  }
  return changed
}

/** A loaded neighbour's heights by offset (dx east, dz north, each −1..1), or null. */
export type NeighbourHeights = (dx: number, dz: number) => { readonly heights: ArrayLike<number> } | null

/**
 * Bakes the normal of grid vertex (gx, gz) into `t.normals` the converter's way (packages/convert/src/world/terrain.ts
 * buildNormals: central differences, across a seam when `neighbour` has that region, one-sided otherwise; the unit
 * normal in glTF space × 127, rounded), from the metre heights. Both regions of a seam vertex bake the same bytes when
 * both are loaded.
 */
export function bakeNormalAt(t: HeightPlanes, gx: number, gz: number, neighbour: NeighbourHeights): void {
  const o = (gz * GRID + gx) * 4
  if (t.normals.length < o + 4) return
  const h = (x: number, z: number): number | undefined => {
    if (x >= 0 && x < GRID && z >= 0 && z < GRID) return t.heights[z * GRID + x]
    const dx = x < 0 ? -1 : x >= GRID ? 1 : 0
    const dz = z < 0 ? -1 : z >= GRID ? 1 : 0
    const n = neighbour(dx, dz)
    return n ? n.heights[(z - dz * CELLS) * GRID + (x - dx * CELLS)] : undefined
  }
  const c = t.heights[gz * GRID + gx]!
  const hl = h(gx - 1, gz), hr = h(gx + 1, gz), hd = h(gx, gz - 1), hu = h(gx, gz + 1)
  // metres: the converter's (hr − hl) / 40 in decimetres
  const dx = hl !== undefined && hr !== undefined ? (hr - hl) / 4 : hr !== undefined ? (hr - c) / 2 : hl !== undefined ? (c - hl) / 2 : 0
  const dz = hd !== undefined && hu !== undefined ? (hu - hd) / 4 : hu !== undefined ? (hu - c) / 2 : hd !== undefined ? (c - hd) / 2 : 0
  const len = Math.hypot(dx, 1, dz)
  // file (−dx, 1, −dz) / len, mirrored to glTF (x, y, −z)
  t.normals[o] = Math.round((-dx / len) * 127)
  t.normals[o + 1] = Math.round((1 / len) * 127)
  t.normals[o + 2] = Math.round((dz / len) * 127)
  t.normals[o + 3] = 0
}

/**
 * Re-bakes the normals of the one-vertex ring around `changed` (grid indices of this region; bakeNormalAt), so the
 * mesh, the grass bake's slope fade and every other reader of the baked normals follow the edit. Ring vertices that
 * also lie in a neighbour (the seam lines and one past them) are returned as (dx, dz, index in that neighbour) for the
 * caller to re-bake there: a seam vertex belongs to both regions and both must agree.
 */
export function renormalRing(t: HeightPlanes, changed: readonly number[], neighbour: NeighbourHeights): Array<[dx: number, dz: number, index: number]> {
  const outside: Array<[number, number, number]> = []
  const seen = new Set<number>()
  for (const i of changed) {
    const gx = i % GRID, gz = (i / GRID) | 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx, z = gz + dz
        const key = (z + 1) * (GRID + 2) + x + 1
        if (seen.has(key)) continue
        seen.add(key)
        if (x >= 0 && x < GRID && z >= 0 && z < GRID) bakeNormalAt(t, x, z, neighbour)
        // the same vertex as a neighbour sees it: on the seam lines (x 0 / 96, z 0 / 96) and one past them
        const ox = x <= 0 ? -1 : x >= CELLS ? 1 : 0
        const oz = z <= 0 ? -1 : z >= CELLS ? 1 : 0
        for (const ddz of oz ? [0, oz] : [0]) {
          for (const ddx of ox ? [0, ox] : [0]) {
            if (!ddx && !ddz) continue
            const nx = x - ddx * CELLS, nz = z - ddz * CELLS
            if (nx >= 0 && nx < GRID && nz >= 0 && nz < GRID) outside.push([ddx, ddz, nz * GRID + nx])
          }
        }
      }
    }
  }
  return outside
}
