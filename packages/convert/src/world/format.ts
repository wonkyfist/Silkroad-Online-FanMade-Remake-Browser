/**
 * Binary per-region files of the world output (work/out/world/<name>/terrain/*.bin, navmesh/*.bin).
 *
 * Environment-neutral (no node:* imports): the viewer can import decodeTerrainBin / decodeNavmeshBin /
 * terrainHeightAt through a relative path. All numbers are little-endian; every section starts 4-byte aligned.
 *
 * Grid convention (both files): vertex (gx, gz), gx, gz in 0..96, sits at region-local file-space (20 gx, 20 gz),
 * i.e. glTF (origin[0] + 2 gx, heightM, origin[2] - 2 gz) with origin = WorldRegion.origin. gx runs east, gz north.
 * Arrays are gz-major: index gz * 97 + gx (cells: cz * 96 + cx). Heights are metres (glTF y, space.ts scale);
 * horizontal coordinates stored in the navmesh are region-local FILE UNITS (0..1920), mapped the same way.
 *
 * TerrainBin ('SROT', version 1):
 *   0   char[4] 'SROT', u32 version, u32 grid (97), u32 cells (96), u32 layerCount L,
 *   20  u32 offHeights, offNormals, offTextures, offLayers, totalBytes
 *   heights   f32[97 * 97]      metres
 *   normals   i8[97 * 97 * 4]   glTF-space unit normal * 127 (x, y, z, 0); central differences across region seams
 *                               (the terrain itself is unlit per TERRAIN.md; these are for picking/debug/v1 lighting)
 *   textures  u16[97 * 97]      raw .m texture word: tile2d id = w & 0x3ff, tiling code = w >> 13
 *                               (period 80, 160, 80, 40, 20 units for code 0..4; u = worldX / period, v = worldZ /
 *                               period in FILE space, e.g. region-local lx/lz: every period divides 320)
 *   layers    u8[L * 96 * 96 * 4]  native per-cell layering (TERRAIN.md 2.3): texel of layer k, cell (cx, cz) at
 *                               ((k * 96 + cz) * 96 + cx) * 4 = [id & 0xff, (id >> 8) | (code << 2), mask4, 255]
 *                               (all 0 when the cell has fewer layers). Upload as a 96 x (96 L) RGBA8 texture.
 *                               Layer 0 is opaque (mask 15); later layers blend with alpha = bilinear of mask4 bits
 *                               (bit 0 = corner (cx, cz), 1 = (cx+1, cz), 2 = (cx, cz+1), 3 = (cx+1, cz+1)).
 *   Triangulation: split every cell along (gx, gz)-(gx+1, gz+1) (TERRAIN.md 1.3; objects sit on this surface).
 *   terrainIndices() builds the glTF index buffer: the file-space order (cross(b - a, c - a) pointing up, as BMS
 *   stores triangles) passed through space.ts toGltfIndices, i.e. [(i,j), (i+1,j), (i+1,j+1)] and
 *   [(i,j), (i+1,j+1), (i,j+1)] counter-clockwise seen from +Y.
 *
 * NavmeshBin ('SRON', version 1): from Data/navmesh/nv_<id>.nvm
 *   0   char[4] 'SRON', u32 version, u32 grid (97), u32 tiles (96), u32 cellCount, u32 openCellCount,
 *   24  u32 edgeCount E, u32 globalEdgeCount G (edges [0, G) are global, the rest internal),
 *   32  u32 offHeights, offTileCells, offCells, offEdges, offTileFlags, offEdgeFlags, totalBytes, u32 0
 *   heights    f32[97 * 97]      metres (the .nvm terrain height map; equals the .m grid)
 *   tileCells  i32[96 * 96]      cell index of each 20-unit tile (index tz * 96 + tx)
 *   cells      f32[cellCount * 4] minX, minZ, maxX, maxZ (region-local file units); walkable iff index < openCellCount
 *   edges      f32[E * 4]         ax, az, bx, bz (region-local file units)
 *   tileFlags  u16[96 * 96]      bit 0 blocked (its cell is closed); higher bits = .m tile flags
 *   edgeFlags  u8[E]             NVM_EDGE_FLAG bits (2 blocked src->dst, 4 internal, 8 global, ...)
 */
import { toGltfIndices } from '../gltf/space.ts'

export const TERRAIN_MAGIC = 'SROT'
export const NAVMESH_MAGIC = 'SRON'
export const WORLD_BIN_VERSION = 1
export const GRID = 97
export const CELLS = 96
/** Region-local file units per cell. */
export const CELL_UNITS = 20
export const TERRAIN_HEADER_BYTES = 40
export const NAVMESH_HEADER_BYTES = 64
/** Native layering needs up to 7 layers per cell in 1.188 (TERRAIN.md 2.3); budget 8. */
export const MAX_TERRAIN_LAYERS = 8
/** Rounds a metre value for JSON (1 micrometre; float32 noise such as -3.3000000000000003 removed). */
export const roundM = (v: number) => Math.round(v * 1e6) / 1e6 + 0

/** World units per texture repeat by tiling code (TERRAIN.md 2.2). */
export const TILING_PERIODS: readonly number[] = [80, 160, 80, 40, 20]

export interface TerrainBin {
  version: number
  layerCount: number
  /** 97 x 97 metres. */
  heights: Float32Array
  /** 97 x 97 x 4 (x, y, z, 0) * 127, glTF space. */
  normals: Int8Array
  /** 97 x 97 raw texture words. */
  textures: Uint16Array
  /** layerCount x 96 x 96 x 4 bytes. */
  layers: Uint8Array
}

export interface NavmeshBin {
  version: number
  openCellCount: number
  globalEdgeCount: number
  heights: Float32Array
  tileCells: Int32Array
  /** cellCount x 4 (minX, minZ, maxX, maxZ), file units. */
  cells: Float32Array
  /** E x 4 (ax, az, bx, bz), file units. */
  edges: Float32Array
  tileFlags: Uint16Array
  edgeFlags: Uint8Array
}

const align4 = (n: number) => (n + 3) & ~3

function writeMagic(view: DataView, magic: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(i, magic.charCodeAt(i))
}

function readMagic(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
}

/** Copies typed-array elements into `out` at `offset` in little-endian order. */
function put(out: Uint8Array, offset: number, src: ArrayBufferView): void {
  // Every host we run on (x86, ARM, browsers) is little-endian; assert instead of byte-swapping.
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('big-endian hosts are not supported')
  out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), offset)
}

function view<T>(bytes: Uint8Array, offset: number, count: number, Ctor: { new(b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number }): T {
  const byteLength = count * Ctor.BYTES_PER_ELEMENT
  if (offset + byteLength > bytes.byteLength) throw new Error(`world bin: section at ${offset} (+${byteLength}) exceeds ${bytes.byteLength} bytes`)
  // Copy into a fresh buffer so the view is aligned whatever the source's offset. (Not bytes.slice: on a Node Buffer
  // that returns a view into the shared pool, not a copy.)
  const copy = new Uint8Array(byteLength)
  copy.set(bytes.subarray(offset, offset + byteLength))
  return new Ctor(copy.buffer, 0, count)
}

export function encodeTerrainBin(t: Omit<TerrainBin, 'version'>): Uint8Array {
  const n = GRID * GRID
  if (t.heights.length !== n || t.normals.length !== n * 4 || t.textures.length !== n) throw new Error('terrain bin: bad grid arrays')
  if (t.layers.length !== t.layerCount * CELLS * CELLS * 4) throw new Error('terrain bin: bad layer array')
  const offHeights = TERRAIN_HEADER_BYTES
  const offNormals = offHeights + n * 4
  const offTextures = offNormals + n * 4
  const offLayers = align4(offTextures + n * 2)
  const total = offLayers + t.layers.length
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  writeMagic(dv, TERRAIN_MAGIC)
  const header = [WORLD_BIN_VERSION, GRID, CELLS, t.layerCount, offHeights, offNormals, offTextures, offLayers, total]
  header.forEach((v, i) => dv.setUint32(4 + i * 4, v, true))
  put(out, offHeights, t.heights)
  put(out, offNormals, t.normals)
  put(out, offTextures, t.textures)
  put(out, offLayers, t.layers)
  return out
}

export function decodeTerrainBin(bytes: Uint8Array): TerrainBin {
  if (bytes.byteLength < TERRAIN_HEADER_BYTES || readMagic(bytes) !== TERRAIN_MAGIC) throw new Error('terrain bin: bad magic at offset 0')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u = (o: number) => dv.getUint32(o, true)
  const version = u(4)
  if (version !== WORLD_BIN_VERSION) throw new Error(`terrain bin: unsupported version ${version} at offset 4`)
  if (u(8) !== GRID || u(12) !== CELLS) throw new Error('terrain bin: unexpected grid size at offset 8')
  if (u(36) !== bytes.byteLength) throw new Error(`terrain bin: header says ${u(36)} bytes, file has ${bytes.byteLength}`)
  const layerCount = u(16)
  const n = GRID * GRID
  return {
    version,
    layerCount,
    heights: view(bytes, u(20), n, Float32Array),
    normals: view(bytes, u(24), n * 4, Int8Array),
    textures: view(bytes, u(28), n, Uint16Array),
    layers: view(bytes, u(32), layerCount * CELLS * CELLS * 4, Uint8Array),
  }
}

export function encodeNavmeshBin(nv: Omit<NavmeshBin, 'version'>): Uint8Array {
  const n = GRID * GRID
  const tiles = CELLS * CELLS
  const cellCount = nv.cells.length / 4
  const edgeCount = nv.edges.length / 4
  if (nv.heights.length !== n || nv.tileCells.length !== tiles || nv.tileFlags.length !== tiles || nv.edgeFlags.length !== edgeCount) {
    throw new Error('navmesh bin: bad array sizes')
  }
  const offHeights = NAVMESH_HEADER_BYTES
  const offTileCells = offHeights + n * 4
  const offCells = offTileCells + tiles * 4
  const offEdges = offCells + nv.cells.byteLength
  const offTileFlags = offEdges + nv.edges.byteLength
  const offEdgeFlags = offTileFlags + tiles * 2
  const total = offEdgeFlags + edgeCount
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  writeMagic(dv, NAVMESH_MAGIC)
  const header = [WORLD_BIN_VERSION, GRID, CELLS, cellCount, nv.openCellCount, edgeCount, nv.globalEdgeCount,
    offHeights, offTileCells, offCells, offEdges, offTileFlags, offEdgeFlags, total, 0]
  header.forEach((v, i) => dv.setUint32(4 + i * 4, v, true))
  put(out, offHeights, nv.heights)
  put(out, offTileCells, nv.tileCells)
  put(out, offCells, nv.cells)
  put(out, offEdges, nv.edges)
  put(out, offTileFlags, nv.tileFlags)
  put(out, offEdgeFlags, nv.edgeFlags)
  return out
}

export function decodeNavmeshBin(bytes: Uint8Array): NavmeshBin {
  if (bytes.byteLength < NAVMESH_HEADER_BYTES || readMagic(bytes) !== NAVMESH_MAGIC) throw new Error('navmesh bin: bad magic at offset 0')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u = (o: number) => dv.getUint32(o, true)
  const version = u(4)
  if (version !== WORLD_BIN_VERSION) throw new Error(`navmesh bin: unsupported version ${version} at offset 4`)
  if (u(56) !== bytes.byteLength) throw new Error(`navmesh bin: header says ${u(56)} bytes, file has ${bytes.byteLength}`)
  const cellCount = u(16)
  const edgeCount = u(24)
  return {
    version,
    openCellCount: u(20),
    globalEdgeCount: u(28),
    heights: view(bytes, u(32), GRID * GRID, Float32Array),
    tileCells: view(bytes, u(36), CELLS * CELLS, Int32Array),
    cells: view(bytes, u(40), cellCount * 4, Float32Array),
    edges: view(bytes, u(44), edgeCount * 4, Float32Array),
    tileFlags: view(bytes, u(48), CELLS * CELLS, Uint16Array),
    edgeFlags: view(bytes, u(52), edgeCount, Uint8Array),
  }
}

/**
 * Height (same unit as `heights`) at region-local file-space (lx, lz), clamped to the region, on the render surface:
 * each cell split along (gx, gz)-(gx+1, gz+1) (TERRAIN.md 1.3, nvm.ts nvmTerrainHeightAt).
 */
export function terrainHeightAt(heights: ArrayLike<number>, lx: number, lz: number): number {
  const last = GRID - 1
  const gx = Math.min(Math.max(lx / CELL_UNITS, 0), last)
  const gz = Math.min(Math.max(lz / CELL_UNITS, 0), last)
  const ix = Math.min(Math.floor(gx), last - 1)
  const iz = Math.min(Math.floor(gz), last - 1)
  const fx = gx - ix
  const fz = gz - iz
  const h00 = heights[iz * GRID + ix]!
  const h11 = heights[(iz + 1) * GRID + ix + 1]!
  if (fx >= fz) {
    const h10 = heights[iz * GRID + ix + 1]!
    return h00 + (h10 - h00) * fx + (h11 - h10) * fz
  }
  const h01 = heights[(iz + 1) * GRID + ix]!
  return h00 + (h01 - h00) * fz + (h11 - h01) * fx
}

/**
 * glTF triangle list over the 97 x 97 vertex grid (vertex index gz * 97 + gx), two triangles per cell split along
 * (gx, gz)-(gx+1, gz+1). Built in file space and mirrored by space.ts, like every other mesh.
 */
export function terrainIndices(): Uint32Array {
  const file = new Uint32Array(CELLS * CELLS * 6)
  let o = 0
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const v00 = j * GRID + i
      const v10 = v00 + 1
      const v01 = v00 + GRID
      const v11 = v01 + 1
      file.set([v00, v11, v10, v00, v01, v11], o)
      o += 6
    }
  }
  return toGltfIndices(file)
}
