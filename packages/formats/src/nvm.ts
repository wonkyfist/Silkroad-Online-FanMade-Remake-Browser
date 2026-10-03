/**
 * Region navmesh parser (JMXVNVM 1000, "RTNavMeshTerrain"): Data.pk2 navmesh/nv_XXYY.nvm, one per outdoor
 * region, XXYY = hex region id (Z << 8 | X). All coordinates are region-local file space: x and z in 0..1920
 * (1 unit = 1 dm), y up.
 *
 * Specs: SilkroadDoc wiki JMXVNVM, EdgeFlag, EdgeDirection; openroad docs/formats/nvm-jmxvnvm.md (read as
 * documentation only). Checked against every .nvm of vSRO 1.188 (packages/convert/test/nvm.corpus.test.ts).
 *
 *   header        "JMXVNVM 1000"
 *   objects       u16 n; per object: u32 objId, f32[3] position, i16 type, f32 yaw, u16 localUid,
 *                 u16 unknownShort0, u8 isBig, u8 isStruct, u16 regionId,
 *                 u16 m, m x (i16 linkedObject, i16 linkedObjectEdge, i16 edge)
 *   cells         u32 total, u32 open; per cell: f32 minX, minZ, maxX, maxZ, u8 k, k x u16 object index
 *   global edges  u32 n; per edge: f32 ax, az, bx, bz, u8 flag, i8[2] direction, i16[2] cell, u16[2] region
 *   inner edges   u32 n; per edge: f32 ax, az, bx, bz, u8 flag, i8[2] direction, i16[2] cell
 *   tile map      96 x 96 (z outer, x inner, 20 units): i32 cell, u16 flag, u16 textureId
 *   height map    97 x 97 f32 (z outer, x inner, 20 units)
 *   plane map     6 x 6 u8 type, then 6 x 6 f32 height (z outer, x inner, 320 units)
 *
 * Findings on the 5,040 files of this client (evidence in the corpus test):
 * - Grids are z-major (index = z * width + x). Cell rectangles contain their tiles only that way (5,040/5,040
 *   files); the height map equals the Map .m terrain grid (bz, bx, vz, vx order) exactly in 3,300 of the 3,310
 *   regions that have one (the other 10 .m files hold unrelated, mostly flat terrain), and continues exactly
 *   across the borders named by the global edges. The surface between samples is two triangles per tile,
 *   split along the (minX, minZ)-(maxX, maxZ) diagonal (placed objects sit exactly on it; see
 *   nvmTerrainHeightAt), not a bilinear patch.
 * - Cells tile the region exactly and are stored open first: cells[0 .. openCellCount) are walkable, the
 *   rest solid. A tile's blocked bit (flag & 1) is set exactly when its cell is closed.
 * - Tile flags: the bits above bit 0 are the .m tile flags verbatim; bit 0 is the .m manual block plus
 *   the generator's own blocking. The texture id is the .m vertex texture id of one of the tile's four
 *   corners in every tile, of its (minX, minZ) corner in 94.6%.
 * - Edge endpoints are stored min then max. Directions: 0 = north (the cell's maxZ side), 1 = east (maxX),
 *   2 = south (minZ), 3 = west (minX), -1 = none. Internal edges have flag 2 (blocked, cells[1] = -1) or 4;
 *   global edges have flag 8, and outside the legacy files each has its mirror image in the neighbour's file.
 * - Object positions are relative to this file's region, so objects owned by a neighbour (regionId differs)
 *   lie outside 0..1920. The .o2 files store the same records relative to the owning region.
 * - Plane types mostly follow the .m block water type (none/water/ice; 2 and 3 are both .m ice); type 0
 *   also where the .m water lies below the whole block. Plane heights equal the .m water heights in every
 *   compared block. Orientation: where a block and its transpose differ in .m water type, the plane type
 *   follows the block (3,043 of 3,764), not the transpose (716).
 * - Legacy variant (101 files, ids 0x11a5..0x1fae, none with a Map .m): 4-byte tile records, u16 cell +
 *   u16 flag, no texture id; 60 of them also lack the plane map. Same signature, so the trailer length tells
 *   them apart. openroad describes these records as all zero; they hold the cell index and the blocked flag.
 */
import { BinaryReader, latin1 } from './binary.ts'
import type { Vec3 } from './math.ts'

export const NVM_SIGNATURE = 'JMXVNVM 1000'
/** Region edge length in file units. */
export const NVM_REGION_SIZE = 1920
/** Tiles per region side; a tile is 20 x 20 units. */
export const NVM_TILES = 96
export const NVM_TILE_SIZE = NVM_REGION_SIZE / NVM_TILES
/** Height samples per region side (one per tile corner). */
export const NVM_HEIGHTS = NVM_TILES + 1
/** Planes per region side; a plane is 320 x 320 units. */
export const NVM_PLANES = 6
export const NVM_PLANE_SIZE = NVM_REGION_SIZE / NVM_PLANES

/** Edge flag bits (SilkroadDoc EdgeFlag). */
export const NVM_EDGE_FLAG = {
  none: 0,
  blockDst2Src: 1,
  blockSrc2Dst: 2,
  /** blockDst2Src | blockSrc2Dst. */
  blocked: 3,
  internal: 4,
  global: 8,
  /** Fall-off boundary of an elevated surface: passable from outside, blocked from inside. */
  underpass: 16,
  /** Dungeon entrance (obsolete). */
  entrance: 32,
  bit6: 64,
  /** Fortress-war passthrough. */
  siege: 128,
} as const

/** Which side of its cell an edge lies on (SilkroadDoc EdgeDirection). */
export const NVM_EDGE_DIRECTION = { none: -1, north: 0, east: 1, south: 2, west: 3 } as const

/** Plane types; ice (2) and water+ice (3) are standable, plain water is not. */
export const NVM_PLANE_TYPE = { none: 0, water: 1, ice: 2, waterIce: 3 } as const

/** Tile flag bit: the tile is solid (its cell is closed). The other bits are the .m tile flags, copied. */
export const NVM_TILE_BLOCKED = 1

export interface NvmObjectLink {
  /** Index into `objects` of the linked instance; -1 = not loaded with this region. */
  linkedObject: number
  /** Global edge of the linked object's navmesh. */
  linkedObjectEdge: number
  /** Global edge of this object's navmesh. */
  edge: number
}

export interface NvmObject {
  /** Index into object.ifo. */
  objId: number
  /** Relative to this file's region (not to `regionId`), file space. */
  position: Vec3
  /** Wiki: -1 static, 0 skinned navmesh. Equals the .o2 record's; -1 or 0 on 99.5%, 35 other values. */
  type: number
  /** Radians about +Y, as stored (not normalized); same record and convention as MapObjectPlacement.yaw (mapo.ts). */
  yaw: number
  /** Unique within `regionId`; the world id is (regionId << 16) | localUid. */
  localUid: number
  unknownShort0: number
  /** Stored as a u8 (0 or 1 in every file). */
  isBig: boolean
  /** Stored as a u8 (0 or 1 in every file). */
  isStruct: boolean
  /** Owning region; objects of neighbouring regions that reach into this one are listed as well. */
  regionId: number
  links: NvmObjectLink[]
}

export interface NvmCell {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
  /** Indices into `objects` of the instances inside this cell. */
  objects: number[]
}

export interface NvmEdge {
  /** Endpoints (x, z) as stored: axis-aligned, a <= b. */
  ax: number
  az: number
  bx: number
  bz: number
  /** NVM_EDGE_FLAG bits. */
  flag: number
  /** Side of cells[0] and cells[1] the edge lies on (NVM_EDGE_DIRECTION), -1 = none. */
  directions: [number, number]
  /** cells[0] is in this region; cells[1] too for internal edges, in regions[1] for global ones; -1 = none. */
  cells: [number, number]
}

export interface NvmGlobalEdge extends NvmEdge {
  /**
   * Region ids of cells[0] (this region) and cells[1] (the neighbour across side directions[0]). Take the
   * neighbour from here: in the band z 17..47 (1,586 regions) the north neighbour is id + 0x80, not id + 0x100.
   */
  regions: [number, number]
}

export interface NvmFile {
  signature: string
  objects: NvmObject[]
  /** Open (walkable) cells first, then the closed ones. */
  cells: NvmCell[]
  openCellCount: number
  globalEdges: NvmGlobalEdge[]
  internalEdges: NvmEdge[]
  /** 8 (i32 cell, u16 flag, u16 texture) or 4 (legacy: u16 cell, u16 flag). */
  tileRecordSize: 8 | 4
  /** 96 x 96, index z * 96 + x: cell index per tile. */
  tileCells: Int32Array
  /** 96 x 96: raw tile flags (NVM_TILE_BLOCKED = 1). */
  tileFlags: Uint16Array
  /** 96 x 96: tile2d.ifo texture id; undefined for legacy records. */
  tileTextures?: Uint16Array
  /** 97 x 97, index z * 97 + x: terrain height at (x * 20, z * 20). */
  heights: Float32Array
  /** 6 x 6, index z * 6 + x (NVM_PLANE_TYPE); undefined when the file has no plane map. */
  planeTypes?: Uint8Array
  /** 6 x 6 plane heights; undefined when the file has no plane map. */
  planeHeights?: Float32Array
}

const TILE_COUNT = NVM_TILES * NVM_TILES
const HEIGHT_COUNT = NVM_HEIGHTS * NVM_HEIGHTS
const PLANE_COUNT = NVM_PLANES * NVM_PLANES
const PLANE_BYTES = PLANE_COUNT * 5
const TRAILER = TILE_COUNT * 8 + HEIGHT_COUNT * 4 + PLANE_BYTES
const LEGACY_TRAILER = TILE_COUNT * 4 + HEIGHT_COUNT * 4 + PLANE_BYTES
const LEGACY_TRAILER_NO_PLANES = LEGACY_TRAILER - PLANE_BYTES

function fail(at: number, what: string): never {
  throw new Error(`NVM: ${what} at offset ${at}`)
}

function need(r: BinaryReader, count: number, what: string): void {
  if (count > r.remaining) fail(r.offset, `truncated ${what} (need ${count} bytes, ${r.remaining} left)`)
}

function readCount(r: BinaryReader, bytes: 2 | 4, minRecord: number, what: string): number {
  need(r, bytes, `${what} count`)
  const at = r.offset
  const count = bytes === 2 ? r.u16() : r.u32()
  if (count * minRecord > r.remaining) fail(at, `${what} count ${count} overruns file`)
  return count
}

function readEdge(r: BinaryReader): NvmEdge {
  const ax = r.f32()
  const az = r.f32()
  const bx = r.f32()
  const bz = r.f32()
  const flag = r.u8()
  const d0 = (r.u8() << 24) >> 24
  const d1 = (r.u8() << 24) >> 24
  const c0 = r.i16()
  const c1 = r.i16()
  return { ax, az, bx, bz, flag, directions: [d0, d1], cells: [c0, c1] }
}

export function parseNvm(bytes: Uint8Array): NvmFile {
  const r = new BinaryReader(bytes)
  need(r, 12, 'signature')
  const signature = r.fixedString(12, latin1)
  if (signature !== NVM_SIGNATURE) fail(0, `bad signature ${JSON.stringify(signature)}`)

  const objectCount = readCount(r, 2, 32, 'object')
  const objects: NvmObject[] = []
  for (let i = 0; i < objectCount; i++) {
    need(r, 32, `object ${i}`)
    const objId = r.u32()
    const position: Vec3 = [r.f32(), r.f32(), r.f32()]
    const type = r.i16()
    const yaw = r.f32()
    const localUid = r.u16()
    const unknownShort0 = r.u16()
    const isBig = r.u8() !== 0
    const isStruct = r.u8() !== 0
    const regionId = r.u16()
    const linkCount = readCount(r, 2, 6, `object ${i} link`)
    const links: NvmObjectLink[] = []
    for (let k = 0; k < linkCount; k++) links.push({ linkedObject: r.i16(), linkedObjectEdge: r.i16(), edge: r.i16() })
    objects.push({ objId, position, type, yaw, localUid, unknownShort0, isBig, isStruct, regionId, links })
  }

  need(r, 8, 'cell counts')
  const cellCountAt = r.offset
  const cellCount = readCount(r, 4, 17, 'cell')
  const openCellCount = r.u32()
  if (openCellCount > cellCount) fail(cellCountAt + 4, `open cell count ${openCellCount} > ${cellCount}`)
  const cells: NvmCell[] = []
  for (let i = 0; i < cellCount; i++) {
    need(r, 17, `cell ${i}`)
    const minX = r.f32()
    const minZ = r.f32()
    const maxX = r.f32()
    const maxZ = r.f32()
    const n = r.u8()
    need(r, n * 2, `cell ${i} objects`)
    const cellObjects: number[] = []
    for (let k = 0; k < n; k++) {
      const at = r.offset
      const index = r.u16()
      if (index >= objectCount) fail(at, `cell ${i} object index ${index} >= ${objectCount}`)
      cellObjects.push(index)
    }
    cells.push({ minX, minZ, maxX, maxZ, objects: cellObjects })
  }

  const globalCount = readCount(r, 4, 27, 'global edge')
  const globalEdges: NvmGlobalEdge[] = []
  for (let i = 0; i < globalCount; i++) {
    const edge = readEdge(r)
    globalEdges.push({ ...edge, regions: [r.u16(), r.u16()] })
  }
  const internalCount = readCount(r, 4, 23, 'internal edge')
  const internalEdges: NvmEdge[] = []
  for (let i = 0; i < internalCount; i++) internalEdges.push(readEdge(r))

  const trailerAt = r.offset
  const trailer = r.remaining
  let tileRecordSize: 8 | 4
  if (trailer === TRAILER) tileRecordSize = 8
  else if (trailer === LEGACY_TRAILER || trailer === LEGACY_TRAILER_NO_PLANES) tileRecordSize = 4
  else fail(trailerAt, `tile/height/plane maps need ${TRAILER} (or legacy ${LEGACY_TRAILER}/${LEGACY_TRAILER_NO_PLANES}) bytes, ${trailer} left`)

  const tileCells = new Int32Array(TILE_COUNT)
  const tileFlags = new Uint16Array(TILE_COUNT)
  let tileTextures: Uint16Array | undefined
  if (tileRecordSize === 8) {
    tileTextures = new Uint16Array(TILE_COUNT)
    for (let i = 0; i < TILE_COUNT; i++) {
      tileCells[i] = r.i32()
      tileFlags[i] = r.u16()
      tileTextures[i] = r.u16()
    }
  } else {
    for (let i = 0; i < TILE_COUNT; i++) {
      tileCells[i] = r.u16()
      tileFlags[i] = r.u16()
    }
  }
  const heights = new Float32Array(HEIGHT_COUNT)
  for (let i = 0; i < HEIGHT_COUNT; i++) heights[i] = r.f32()
  let planeTypes: Uint8Array | undefined
  let planeHeights: Float32Array | undefined
  if (r.remaining) {
    planeTypes = r.bytesView(PLANE_COUNT).slice()
    planeHeights = new Float32Array(PLANE_COUNT)
    for (let i = 0; i < PLANE_COUNT; i++) planeHeights[i] = r.f32()
  }

  const file: NvmFile = {
    signature, objects, cells, openCellCount, globalEdges, internalEdges,
    tileRecordSize, tileCells, tileFlags, heights,
  }
  if (tileTextures) file.tileTextures = tileTextures
  if (planeTypes && planeHeights) {
    file.planeTypes = planeTypes
    file.planeHeights = planeHeights
  }
  return file
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Terrain height at a region-local point, clamped to the region. Each 20 x 20 tile is two triangles split
 * along its (minX, minZ)-(maxX, maxZ) diagonal: of the .o placements the world editor snapped onto the
 * ground (where the two possible splits differ by 0.5+ units), 649 sit exactly (|dy| < 0.02) on this
 * surface, 5 on the other split and 3 on a bilinear patch (nvm.corpus.test.ts).
 */
export function nvmTerrainHeightAt(nvm: Pick<NvmFile, 'heights'>, localX: number, localZ: number): number {
  const last = NVM_HEIGHTS - 1
  const gx = clamp(localX / NVM_TILE_SIZE, 0, last)
  const gz = clamp(localZ / NVM_TILE_SIZE, 0, last)
  const ix = Math.min(Math.floor(gx), last - 1)
  const iz = Math.min(Math.floor(gz), last - 1)
  const fx = gx - ix
  const fz = gz - iz
  const h = nvm.heights
  const h00 = h[iz * NVM_HEIGHTS + ix]!
  const h11 = h[(iz + 1) * NVM_HEIGHTS + ix + 1]!
  if (fx >= fz) {
    const h10 = h[iz * NVM_HEIGHTS + ix + 1]!
    return h00 + (h10 - h00) * fx + (h11 - h10) * fz
  }
  const h01 = h[(iz + 1) * NVM_HEIGHTS + ix]!
  return h00 + (h01 - h00) * fz + (h11 - h01) * fx
}

/** Index into planeTypes/planeHeights of the plane under a region-local point. */
export function nvmPlaneIndexAt(localX: number, localZ: number): number {
  const px = clamp(Math.floor(localX / NVM_PLANE_SIZE), 0, NVM_PLANES - 1)
  const pz = clamp(Math.floor(localZ / NVM_PLANE_SIZE), 0, NVM_PLANES - 1)
  return pz * NVM_PLANES + px
}

/** Standable height: terrain, lifted to the plane height over ice (plain water is not standable). */
export function nvmHeightAt(nvm: Pick<NvmFile, 'heights' | 'planeTypes' | 'planeHeights'>, localX: number, localZ: number): number {
  const terrain = nvmTerrainHeightAt(nvm, localX, localZ)
  if (!nvm.planeTypes || !nvm.planeHeights) return terrain
  const p = nvmPlaneIndexAt(localX, localZ)
  const type = nvm.planeTypes[p]!
  if (type !== NVM_PLANE_TYPE.ice && type !== NVM_PLANE_TYPE.waterIce) return terrain
  return Math.max(terrain, nvm.planeHeights[p]!)
}

function cellContains(c: NvmCell, x: number, z: number): boolean {
  return x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ
}

/**
 * Index of the cell containing a region-local point, or -1 outside the region. Uses the tile map, then falls
 * back to a scan. Points on a shared border resolve to the tile's cell; check `index < openCellCount` for
 * walkability.
 */
export function nvmCellAt(nvm: Pick<NvmFile, 'cells' | 'tileCells'>, localX: number, localZ: number): number {
  if (!(localX >= 0 && localX <= NVM_REGION_SIZE && localZ >= 0 && localZ <= NVM_REGION_SIZE)) return -1
  const tx = Math.min(Math.floor(localX / NVM_TILE_SIZE), NVM_TILES - 1)
  const tz = Math.min(Math.floor(localZ / NVM_TILE_SIZE), NVM_TILES - 1)
  const tileCell = nvm.tileCells[tz * NVM_TILES + tx]!
  const cell = nvm.cells[tileCell]
  if (cell && cellContains(cell, localX, localZ)) return tileCell
  return nvm.cells.findIndex(c => cellContains(c, localX, localZ))
}
