/**
 * Region terrain mesh Map/<z>/<x>.m (JMXVMAPM1000).
 *
 * Specs: SilkroadDoc wiki JMXVMAPM, openroad docs/formats/mapm-jmxvmapm.md (read as documentation) and the
 * Lafa2K terrain importer (MIT, read_terrain), checked against the vSRO 1.188 bytes
 * (packages/convert/test/terrain.corpus.test.ts). A region is 1920 x 1920 file units: 6 x 6 blocks of
 * 16 x 16 tiles of 20 units.
 *
 *   char[12] "JMXVMAPM1000"
 *   36 blocks, bz outer (0..5), bx inner (0..5); 2,575 bytes each:
 *     u32   flag (0; 1 "culled" per the wiki: only Jangan (168, 97) blocks 14 and 15, a pond at the town
 *           centre: water at -33 with grs_water_big / c_pondflower plants and a cj_wf_dr particle in the .o2)
 *     u16   environmentId (profile id in Map/environment.ifo)
 *     17 x 17 vertices, vz outer, vx inner; 7 bytes each:
 *       f32 height
 *       u16 texture: low 10 bits = tile2d.ifo id; bits 10..15 kept raw (openroad: "scale", only the
 *           values 0, 8, 16, 24, 32 occur in 1.188, i.e. bits 13..15)
 *       u8  brightness
 *     i8    waterType (-1 none, 0 water, 1 ice)   (one per block, not per vertex)
 *     u8    waterWaveType (0..3)
 *     f32   waterHeight
 *     16 x 16 u16 tile flags, tz outer, tx inner (bit 0 = blocked; other bits kept raw)
 *     f32   heightMax, f32 heightMin (block bounds including objects; not strict: in 51 / 200 of 123,732
 *           blocks they lie inside the vertex range)
 *     u8[20] unknown (byte 0 is 0 or 1, and 1 only on water blocks; the rest are always 0)
 *
 * Grid (see assembleRegionGrid): vertex (vx, vz) of block (bx, bz) is region vertex
 * (gx, gz) = (16 bx + vx, 16 bz + vz), at region-local file-space position (20 gx, height, 20 gz). Region
 * (x, z) starts at world (1920 x, 1920 z); gx grows with +X (east) and gz with +Z (north). Evidence on 1.188
 * (terrain.corpus.test.ts):
 * - duplicated block-edge vertices are bit-identical, except 6 in three active regions (and 175 in two
 *   inactive ones); a vx-outer vertex order would break hundreds per region;
 * - region (x, z)'s gx = 96 column equals (x + 1, z)'s gx = 0 column, and its gz = 96 row equals (x, z + 1)'s
 *   gz = 0 row, both in the same order, for 96.7% of the adjacent active pairs with relief (every other
 *   pairing of edges matches < 1%); the rest are 66 genuine cliffs;
 * - the server navmesh (Data/navmesh/nv_<id>.nvm) height map equals the stitched grid in all 3,300 active
 *   regions, its tile flags are these flags plus some extra blocked bits, and its tile texture is always one
 *   of the tile's corner ids;
 * - the tile2d texture colours correlate with the minimap (north up) only as gx -> right, gz -> up;
 * - .o2 object placements (region-local x, y, z) stand on the terrain (|y - h| < 1 unit) 41% of the time with
 *   gx = x / 20, gz = z / 20, but only ~10% with x or z mirrored or the axes swapped;
 * - the navmesh's own cell rectangles contain the centre (20 tx + 10, 20 tz + 10) of every tile tz * 96 + tx.
 *
 * Water vs the navmesh plane map (same block index): water <-> plane 1 and ice <-> plane 2 or 3, at the same
 * height. .m water the navmesh has no plane for (4% of blocks) always lies wholly below the block's terrain;
 * navmesh water where the .m has none (2.4%) is unexplained.
 */
import { BinaryReader, latin1 } from './binary.ts'

export const MAPM_SIGNATURE = 'JMXVMAPM1000'
/** Blocks per region side. */
export const MAPM_BLOCKS = 6
/** Vertices per block side (the edge vertices are shared with the neighbouring blocks). */
export const MAPM_BLOCK_VERTICES = 17
/** Tiles per block side. */
export const MAPM_BLOCK_TILES = 16
/** Vertices per region side: 6 * 16 + 1. */
export const REGION_GRID_SIZE = MAPM_BLOCKS * MAPM_BLOCK_TILES + 1
/** Tiles per region side. */
export const REGION_TILES = MAPM_BLOCKS * MAPM_BLOCK_TILES
/** Tile edge in file units (1 unit = 0.1 m). */
export const TERRAIN_TILE_SIZE = 20
export const TERRAIN_BLOCK_SIZE = MAPM_BLOCK_TILES * TERRAIN_TILE_SIZE
/** Region edge in file units. */
export const REGION_SIZE = REGION_TILES * TERRAIN_TILE_SIZE

const VERTEX_COUNT = MAPM_BLOCK_VERTICES * MAPM_BLOCK_VERTICES
const TILE_COUNT = MAPM_BLOCK_TILES * MAPM_BLOCK_TILES
export const MAPM_BLOCK_BYTES = 6 + VERTEX_COUNT * 7 + 6 + TILE_COUNT * 2 + 8 + 20
export const MAPM_FILE_SIZE = 12 + MAPM_BLOCKS * MAPM_BLOCKS * MAPM_BLOCK_BYTES

/** Mask of the tile2d.ifo id in a raw vertex texture word. */
export const MAPM_TEXTURE_ID_MASK = 0x3ff

export const MAPM_WATER_NONE = -1
export const MAPM_WATER = 0
export const MAPM_WATER_ICE = 1

/** Tile flag bit 0. The navmesh (.nvm) tile map repeats these flags and may add this bit, never remove it. */
export const MAPM_TILE_BLOCKED = 0x1

export interface MapMBlock {
  /** Index in the file: bz * 6 + bx. */
  index: number
  bx: number
  bz: number
  /** Raw u32: 0 none, 1 culled. */
  flag: number
  environmentId: number
  /** 17 x 17, index vz * 17 + vx. */
  heights: Float32Array
  /** Raw u16 texture words, index vz * 17 + vx. */
  textures: Uint16Array
  /** textures & 0x3ff: the tile2d.ifo id. */
  textureIds: Uint16Array
  /** textures >> 10, kept raw (openroad's unexplained "scale"). */
  textureHighBits: Uint8Array
  brightness: Uint8Array
  /** -1 none, 0 water, 1 ice. */
  waterType: number
  waterWaveType: number
  waterHeight: number
  /** 16 x 16 raw tile flags, index tz * 16 + tx. */
  tileFlags: Uint16Array
  heightMax: number
  heightMin: number
  /** The 20 trailing bytes (view). */
  unknown: Uint8Array
}

export interface MapMFile {
  signature: string
  /** 36 blocks in file order (bz outer, bx inner). */
  blocks: MapMBlock[]
}

export function parseMapM(bytes: Uint8Array): MapMFile {
  const r = new BinaryReader(bytes)
  if (bytes.byteLength < 12) throw new Error(`MAPM: file is ${bytes.byteLength} bytes, shorter than the signature`)
  const signature = r.fixedString(12, latin1)
  if (signature !== MAPM_SIGNATURE) {
    throw new Error(`MAPM: bad signature ${JSON.stringify(signature)} at offset 0 (expected "${MAPM_SIGNATURE}")`)
  }
  if (bytes.byteLength !== MAPM_FILE_SIZE) {
    throw new Error(
      `MAPM: file is ${bytes.byteLength} bytes, expected ${MAPM_FILE_SIZE} (36 blocks of ${MAPM_BLOCK_BYTES}) after the signature at offset 12`,
    )
  }
  const blocks: MapMBlock[] = []
  for (let bz = 0; bz < MAPM_BLOCKS; bz++) {
    for (let bx = 0; bx < MAPM_BLOCKS; bx++) {
      const flag = r.u32()
      const environmentId = r.u16()
      const heights = new Float32Array(VERTEX_COUNT)
      const textures = new Uint16Array(VERTEX_COUNT)
      const textureIds = new Uint16Array(VERTEX_COUNT)
      const textureHighBits = new Uint8Array(VERTEX_COUNT)
      const brightness = new Uint8Array(VERTEX_COUNT)
      for (let i = 0; i < VERTEX_COUNT; i++) {
        heights[i] = r.f32()
        const t = r.u16()
        textures[i] = t
        textureIds[i] = t & MAPM_TEXTURE_ID_MASK
        textureHighBits[i] = t >>> 10
        brightness[i] = r.u8()
      }
      const waterType = r.view.getInt8(r.offset)
      r.skip(1)
      const waterWaveType = r.u8()
      const waterHeight = r.f32()
      const tileFlags = new Uint16Array(TILE_COUNT)
      for (let i = 0; i < TILE_COUNT; i++) tileFlags[i] = r.u16()
      const heightMax = r.f32()
      const heightMin = r.f32()
      const unknown = r.bytesView(20)
      blocks.push({
        index: blocks.length,
        bx,
        bz,
        flag,
        environmentId,
        heights,
        textures,
        textureIds,
        textureHighBits,
        brightness,
        waterType,
        waterWaveType,
        waterHeight,
        tileFlags,
        heightMax,
        heightMin,
        unknown,
      })
    }
  }
  return { signature, blocks }
}

export interface RegionGrid {
  /** 97: vertices per side. */
  size: number
  /** 97 x 97, index gz * 97 + gx. */
  heights: Float32Array
  /** Raw texture words. */
  textures: Uint16Array
  /** tile2d.ifo ids (textures & 0x3ff). */
  textureIds: Uint16Array
  brightness: Uint8Array
  /** 96 x 96 tile flags, index tz * 96 + tx (tile (tx, tz) spans vertices tx..tx+1, tz..tz+1). */
  tileFlags: Uint16Array
  /** 6 x 6 per-block environment ids, index bz * 6 + bx. */
  environmentIds: Uint16Array
  /**
   * Shared edge vertices whose copies disagree in height (6 in all of 1.188's active regions), with every copy's
   * height in file order. The block later in the file wins, which is what the navmesh height map contains.
   */
  edgeConflicts: Array<{ gx: number; gz: number; heights: number[] }>
}

/**
 * Stitches the 36 blocks into one 97 x 97 vertex grid: block (bx, bz) vertex (vx, vz) -> (16 bx + vx, 16 bz + vz).
 * Each interior edge vertex is stored twice (four times at block corners); blocks are applied in file order,
 * so the last copy wins.
 */
export function assembleRegionGrid(mapm: MapMFile): RegionGrid {
  const size = REGION_GRID_SIZE
  const n = size * size
  const heights = new Float32Array(n)
  const textures = new Uint16Array(n)
  const textureIds = new Uint16Array(n)
  const brightness = new Uint8Array(n)
  const tileFlags = new Uint16Array(REGION_TILES * REGION_TILES)
  const environmentIds = new Uint16Array(MAPM_BLOCKS * MAPM_BLOCKS)
  const written = new Uint8Array(n)
  const conflicts = new Set<number>()
  if (mapm.blocks.length !== MAPM_BLOCKS * MAPM_BLOCKS) {
    throw new Error(`MAPM: ${mapm.blocks.length} blocks, expected ${MAPM_BLOCKS * MAPM_BLOCKS}`)
  }
  for (const block of mapm.blocks) {
    const { bx, bz } = block
    environmentIds[bz * MAPM_BLOCKS + bx] = block.environmentId
    for (let vz = 0; vz < MAPM_BLOCK_VERTICES; vz++) {
      for (let vx = 0; vx < MAPM_BLOCK_VERTICES; vx++) {
        const s = vz * MAPM_BLOCK_VERTICES + vx
        const g = (bz * MAPM_BLOCK_TILES + vz) * size + bx * MAPM_BLOCK_TILES + vx
        const h = block.heights[s]!
        // +0 / -0 are the same height; NaN copies count as agreeing with each other
        if (written[g] && heights[g] !== h && !(h !== h && heights[g] !== heights[g])) conflicts.add(g)
        written[g] = 1
        heights[g] = h
        textures[g] = block.textures[s]!
        textureIds[g] = block.textureIds[s]!
        brightness[g] = block.brightness[s]!
      }
    }
    for (let tz = 0; tz < MAPM_BLOCK_TILES; tz++) {
      for (let tx = 0; tx < MAPM_BLOCK_TILES; tx++) {
        tileFlags[(bz * MAPM_BLOCK_TILES + tz) * REGION_TILES + bx * MAPM_BLOCK_TILES + tx] =
          block.tileFlags[tz * MAPM_BLOCK_TILES + tx]!
      }
    }
  }
  const edgeConflicts = [...conflicts].map(g => {
    const gx = g % size
    const gz = Math.floor(g / size)
    return { gx, gz, heights: vertexCopies(mapm, gx, gz) }
  })
  return { size, heights, textures, textureIds, brightness, tileFlags, environmentIds, edgeConflicts }
}

/** Heights of every stored copy of region vertex (gx, gz), in file order (1, 2 or 4 copies). */
export function vertexCopies(mapm: MapMFile, gx: number, gz: number): number[] {
  const out: number[] = []
  for (const block of mapm.blocks) {
    const vx = gx - block.bx * MAPM_BLOCK_TILES
    const vz = gz - block.bz * MAPM_BLOCK_TILES
    if (vx < 0 || vx > MAPM_BLOCK_TILES || vz < 0 || vz > MAPM_BLOCK_TILES) continue
    out.push(block.heights[vz * MAPM_BLOCK_VERTICES + vx]!)
  }
  return out
}
