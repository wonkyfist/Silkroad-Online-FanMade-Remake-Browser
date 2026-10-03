/**
 * BMS mesh parser (JMXVBMS 0110 and 0109).
 *
 * Specs: SilkroadDoc wiki JMXVBMS, openroad docs/formats/bms-jmxvbms.md (read as documentation),
 * cross-checked against the Lafa2K importer (MIT) and the vSRO 1.188 bytes.
 *
 *   signature  "JMXVBMS 0110" or "JMXVBMS 0109" (12 bytes)
 *   header     u32 x 10 section offsets (absolute, 0 = absent): vertex, skin, face, clothVertex, clothEdge,
 *              boundingBox, occlusionPortal, navMesh, skinnedNavMesh, unknown9;
 *              u32 unknownUInt0, navFlags, subPrimCount, vertexFlags, unknownUInt2;
 *              lpString name, lpString materialName, u32 unknownUInt3
 *   vertices   u32 n; per vertex: position f32[3], normal f32[3], uv0 f32[2], [uv1 f32[2] if flags & 0x400],
 *              [36 raw bytes if flags & 0x800], f32 unknown, u32 unknown, u32 unknown;
 *              then [lpString lightmap path if 0x400], [u32 m, m x f32[6] if 0x1000]
 *   skin       u32 boneCount, boneCount x lpString; if boneCount > 0, per vertex K x (u8 bone, u16 weight):
 *              K = 2 in 0110, 4 in 0109 (slots 3-4 are always unused in this client). Bone 0xFF = no influence,
 *              with weight 0. Weight scale is 1/65535: a lone influence stores 0xFFFF. The exporter kept the two
 *              largest influences without renormalizing, so sums can fall short of 1 (e.g. 2 x 21838 when three
 *              equal influences were cut) and a few vertices have none; weights are returned unnormalized.
 *   faces      u32 t, t x u16[3], as stored (Direct3D winding)
 *   cloth      u32 n (0 or vertexCount), n x (f32 maxDistance, u32 pinned);
 *              u32 e, e x (u32 a, u32 b, f32 maxDistance), e x u32 order, and if e > 0: u32 deformationMode,
 *              f32 x 7, u32 movementFactor
 *   bbox       f32[3] min, f32[3] max
 *   occlusion  u32 n (0 or 1 here; read as a count), n x (lpString name, u32 v, v x f32[3], u32 t, t x u16[3])
 *   unknown9   u32 count (0 in every file)
 *   navmesh    see readNavMesh; skinned navmesh (never present here) is three counted arrays
 *
 * In every file of this client the sections lie in the order above and tile the file exactly, so the parser
 * reads each section at its header offset and then requires the sections to be contiguous up to EOF.
 * All values are raw file space (left-handed, Y-up).
 */
import { BinaryReader, eucKr, latin1 } from './binary.ts'

export const BMS_VERTEX_LIGHTMAP = 0x400
export const BMS_VERTEX_MORPH = 0x800
export const BMS_VERTEX_EXTRA = 0x1000
export const BMS_NAV_EDGE_EVENTS = 1
export const BMS_NAV_CELL_EVENTS = 2
export const BMS_NAV_EVENT_NAMES = 4
/** Bone index meaning "no influence". */
export const BMS_NO_BONE = 0xff
/** Bytes of morph data per vertex when vertexFlags & BMS_VERTEX_MORPH. */
export const BMS_MORPH_BYTES = 36

export interface BmsHeader {
  vertexOffset: number
  skinOffset: number
  faceOffset: number
  clothVertexOffset: number
  clothEdgeOffset: number
  boundingBoxOffset: number
  occlusionPortalOffset: number
  navMeshOffset: number
  skinnedNavMeshOffset: number
  unknown9Offset: number
  unknownUInt0: number
  /** 1 = edge event bytes, 2 = cell event bytes, 4 = event names; 8 also occurs and is layout-neutral. */
  navFlags: number
  /** 1 in every file. */
  subPrimCount: number
  vertexFlags: number
  unknownUInt2: number
  /** u32 after the material name; often the number of vertices whose unknownVertexInt0 is not 0xFFFFFFFF. */
  unknownUInt3: number
  /** Header length in bytes, i.e. where the first section starts. */
  size: number
}

export interface BmsBounds {
  min: [number, number, number]
  max: [number, number, number]
}

/** Cloth simulation parameters; field names follow SilkroadDoc, semantics unverified. */
export interface BmsClothParams {
  deformationMode: number
  animationOffsetX: number
  animationOffsetZ: number
  animationOffsetY: number
  fallingSpeed: number
  unknownFloat6: number
  unknownFloat7: number
  elasticity: number
  movementFactor: number
}

export interface BmsCloth {
  /** Per cloth vertex (the count is 0 or vertexCount). */
  vertexMaxDistance: Float32Array
  vertexPinned: Uint32Array
  /** Vertex index pairs, 2 per edge. */
  edges: Uint32Array
  edgeMaxDistance: Float32Array
  /** One u32 per edge after the edge list, as stored. */
  edgeOrder: Uint32Array
  /** Present when there is at least one edge. */
  params?: BmsClothParams
}

export interface BmsOcclusionPortal {
  name: string
  vertices: Float32Array
  indices: Uint16Array
}

export interface BmsNavEdges {
  /** Source and destination vertex per edge. */
  vertices: Uint16Array
  /** Source and destination cell per edge; 0xFFFF = none. */
  cells: Uint16Array
  flags: Uint8Array
  /** Present when navFlags & BMS_NAV_EDGE_EVENTS: low 6 bits event index, high 2 bits trigger flags. */
  eventZones?: Uint8Array
}

export interface BmsNavGrid {
  /** Grid minimum corner (x, z) as stored. */
  origin: [number, number]
  width: number
  height: number
  /** Outline edges of grid cell i are cellOutlines[cellStart[i] .. cellStart[i + 1]). */
  cellStart: Uint32Array
  cellOutlines: Uint16Array
}

export interface BmsNavMesh {
  /** The whole section as stored. */
  raw: Uint8Array
  /** 3 floats per nav vertex. */
  vertices: Float32Array
  vertexBisectors: Uint8Array
  /** 3 nav vertex indices per cell. */
  cells: Uint16Array
  cellFlags: Uint16Array
  /** Present when navFlags & BMS_NAV_CELL_EVENTS. */
  cellEventZones?: Uint8Array
  outlineEdges: BmsNavEdges
  inlineEdges: BmsNavEdges
  /** Event names, present when navFlags & BMS_NAV_EVENT_NAMES. */
  events: string[]
  grid: BmsNavGrid
}

/** Three counted arrays of unknown meaning (SilkroadDoc); no file of this client has one. */
export interface BmsSkinnedNavMesh {
  raw: Uint8Array
  /** 3 floats per entry. */
  structure0: Float32Array
  /** 2 bytes per entry. */
  structure1: Uint8Array
  /** 3 u16 per entry. */
  structure2: Uint16Array
}

export interface BmsMesh {
  /** 'JMXVBMS 0110' or 'JMXVBMS 0109'. */
  signature: string
  /** 110 or 109. */
  version: number
  header: BmsHeader
  name: string
  /** Material name inside the BSR's material set (.bmt). */
  materialName: string
  vertexFlags: number
  vertexCount: number
  /** 3 per vertex. */
  positions: Float32Array
  /** 3 per vertex. */
  normals: Float32Array
  /** 2 per vertex, as stored (V down, Direct3D). */
  uv0: Float32Array
  /** Lightmap UVs, 2 per vertex, when vertexFlags & BMS_VERTEX_LIGHTMAP. */
  uv1?: Float32Array
  lightmapPath?: string
  /** BMS_MORPH_BYTES raw bytes per vertex, when vertexFlags & BMS_VERTEX_MORPH. */
  morph?: Uint8Array
  /** 6 floats per record, when vertexFlags & BMS_VERTEX_EXTRA. */
  extraVertexData?: Float32Array
  /** Trailing per-vertex f32 / u32 / u32 of unknown meaning (typically 0, 0xFFFFFFFF, 0). */
  unknownVertexFloat: Float32Array
  unknownVertexInt0: Uint32Array
  unknownVertexInt1: Uint32Array
  /** Mesh-local bone palette; joint indices point into it. Empty for static meshes. */
  boneNames: string[]
  /** Stored influences per vertex: 0 (static), 2 (0110) or 4 (0109). */
  influencesPerVertex: number
  /** Raw bone bytes, influencesPerVertex per vertex (0xFF = none). */
  skinBones?: Uint8Array
  /** Raw u16 weights, influencesPerVertex per vertex. */
  skinWeights?: Uint16Array
  /** 4 per vertex; unused slots and 0xFF bones are 0 with weight 0. Present when boneNames is non-empty. */
  joints?: Uint16Array
  /** 4 per vertex, raw weight / 65535 (not renormalized). */
  weights?: Float32Array
  /** Triangle list, 3 per face, as stored. */
  indices: Uint16Array
  cloth?: BmsCloth
  bounds: BmsBounds
  occlusionPortals: BmsOcclusionPortal[]
  unknown9Count: number
  navMesh?: BmsNavMesh
  skinnedNavMesh?: BmsSkinnedNavMesh
}

const SIGNATURE_PREFIX = 'JMXVBMS '
const SUPPORTED_VERSIONS = [109, 110]
const KNOWN_VERTEX_FLAGS = BMS_VERTEX_LIGHTMAP | BMS_VERTEX_MORPH | BMS_VERTEX_EXTRA
const WEIGHT_SCALE = 1 / 65535

function fail(at: number, what: string): never {
  throw new Error(`BMS: ${what} at offset ${at}`)
}

function need(r: BinaryReader, count: number, what: string): void {
  if (count > r.remaining) fail(r.offset, `truncated ${what} (need ${count} bytes, ${r.remaining} left)`)
}

function readCount(r: BinaryReader, recordSize: number, what: string): number {
  need(r, 4, `${what} count`)
  const at = r.offset
  const count = r.u32()
  if (count * recordSize > r.remaining) fail(at, `${what} count ${count} overruns file`)
  return count
}

function readString(r: BinaryReader, what: string): string {
  need(r, 4, `${what} length`)
  const len = r.view.getUint32(r.offset, true)
  if (len > r.remaining - 4) fail(r.offset, `${what} length ${len} overruns file`)
  return r.lpString(eucKr)
}

function readF32s(r: BinaryReader, count: number): Float32Array {
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = r.f32()
  return out
}

function readU16s(r: BinaryReader, count: number): Uint16Array {
  const out = new Uint16Array(count)
  for (let i = 0; i < count; i++) out[i] = r.u16()
  return out
}

function readU32s(r: BinaryReader, count: number): Uint32Array {
  const out = new Uint32Array(count)
  for (let i = 0; i < count; i++) out[i] = r.u32()
  return out
}

function readHeader(r: BinaryReader): { signature: string; version: number; header: BmsHeader; name: string; materialName: string } {
  need(r, 12 + 15 * 4, 'header')
  const signature = latin1.decode(r.bytesView(12))
  if (!signature.startsWith(SIGNATURE_PREFIX)) fail(0, `bad signature ${JSON.stringify(signature)}`)
  const version = Number(signature.slice(SIGNATURE_PREFIX.length))
  if (!SUPPORTED_VERSIONS.includes(version)) fail(0, `unsupported version ${JSON.stringify(signature)}`)
  const vertexOffset = r.u32()
  const skinOffset = r.u32()
  const faceOffset = r.u32()
  const clothVertexOffset = r.u32()
  const clothEdgeOffset = r.u32()
  const boundingBoxOffset = r.u32()
  const occlusionPortalOffset = r.u32()
  const navMeshOffset = r.u32()
  const skinnedNavMeshOffset = r.u32()
  const unknown9Offset = r.u32()
  const unknownUInt0 = r.u32()
  const navFlags = r.u32()
  const subPrimCount = r.u32()
  const vertexFlags = r.u32()
  const unknownUInt2 = r.u32()
  const name = readString(r, 'mesh name')
  const materialName = readString(r, 'material name')
  need(r, 4, 'header tail')
  const unknownUInt3 = r.u32()
  const header: BmsHeader = {
    vertexOffset, skinOffset, faceOffset, clothVertexOffset, clothEdgeOffset, boundingBoxOffset,
    occlusionPortalOffset, navMeshOffset, skinnedNavMeshOffset, unknown9Offset,
    unknownUInt0, navFlags, subPrimCount, vertexFlags, unknownUInt2, unknownUInt3, size: r.offset,
  }
  return { signature, version, header, name, materialName }
}

interface Section {
  name: string
  start: number
  end: number
}

/** Seek to a section's header offset; returns false (and records nothing) when the offset is 0. */
function enter(r: BinaryReader, offset: number, name: string): boolean {
  if (offset === 0) return false
  if (offset > r.length) fail(offset, `${name} offset past end of file (${r.length})`)
  r.seek(offset)
  return true
}

function readNavEdges(r: BinaryReader, withEvents: boolean, what: string): BmsNavEdges {
  const recordSize = 9 + (withEvents ? 1 : 0)
  const count = readCount(r, recordSize, what)
  const vertices = new Uint16Array(count * 2)
  const cells = new Uint16Array(count * 2)
  const flags = new Uint8Array(count)
  const eventZones = withEvents ? new Uint8Array(count) : undefined
  for (let i = 0; i < count; i++) {
    vertices[i * 2] = r.u16()
    vertices[i * 2 + 1] = r.u16()
    cells[i * 2] = r.u16()
    cells[i * 2 + 1] = r.u16()
    flags[i] = r.u8()
    if (eventZones) eventZones[i] = r.u8()
  }
  return eventZones ? { vertices, cells, flags, eventZones } : { vertices, cells, flags }
}

/**
 * Object navmesh (SilkroadDoc NavMeshObj):
 *   u32 n, n x (f32[3] position, u8 bisector)
 *   u32 c, c x (u16[3] vertices, u16 flag, [u8 eventZone if navFlags & 2])
 *   outline edges, inline edges: u32 e, e x (u16 srcVertex, u16 dstVertex, u16 srcCell, u16 dstCell, u8 flag,
 *     [u8 eventZone if navFlags & 1])
 *   [u32 k, k x lpString event name if navFlags & 4]
 *   grid: f32[2] origin, u32 width, u32 height, u32 cellCount, cellCount x (u32 m, m x u16 outline edge)
 */
function readNavMesh(r: BinaryReader, navFlags: number): BmsNavMesh {
  const start = r.offset
  const vertexCount = readCount(r, 13, 'nav vertex')
  const vertices = new Float32Array(vertexCount * 3)
  const vertexBisectors = new Uint8Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 3] = r.f32()
    vertices[i * 3 + 1] = r.f32()
    vertices[i * 3 + 2] = r.f32()
    vertexBisectors[i] = r.u8()
  }
  const cellEvents = (navFlags & BMS_NAV_CELL_EVENTS) !== 0
  const cellCount = readCount(r, 8 + (cellEvents ? 1 : 0), 'nav cell')
  const cells = new Uint16Array(cellCount * 3)
  const cellFlags = new Uint16Array(cellCount)
  const cellEventZones = cellEvents ? new Uint8Array(cellCount) : undefined
  for (let i = 0; i < cellCount; i++) {
    cells[i * 3] = r.u16()
    cells[i * 3 + 1] = r.u16()
    cells[i * 3 + 2] = r.u16()
    cellFlags[i] = r.u16()
    if (cellEventZones) cellEventZones[i] = r.u8()
  }
  const edgeEvents = (navFlags & BMS_NAV_EDGE_EVENTS) !== 0
  const outlineEdges = readNavEdges(r, edgeEvents, 'nav outline edge')
  const inlineEdges = readNavEdges(r, edgeEvents, 'nav inline edge')
  const events: string[] = []
  if (navFlags & BMS_NAV_EVENT_NAMES) {
    const eventCount = readCount(r, 4, 'nav event')
    for (let i = 0; i < eventCount; i++) events.push(readString(r, `nav event ${i} name`))
  }
  need(r, 20, 'nav grid header')
  const origin: [number, number] = [r.f32(), r.f32()]
  const width = r.u32()
  const height = r.u32()
  const gridCellCount = readCount(r, 4, 'nav grid cell')
  const cellStart = new Uint32Array(gridCellCount + 1)
  const lists: Uint16Array[] = []
  let total = 0
  for (let i = 0; i < gridCellCount; i++) {
    const n = readCount(r, 2, `nav grid cell ${i} outline`)
    lists.push(readU16s(r, n))
    total += n
    cellStart[i + 1] = total
  }
  const cellOutlines = new Uint16Array(total)
  lists.forEach((list, i) => cellOutlines.set(list, cellStart[i]!))
  const raw = r.bytes.subarray(start, r.offset)
  const grid: BmsNavGrid = { origin, width, height, cellStart, cellOutlines }
  const mesh: BmsNavMesh = { raw, vertices, vertexBisectors, cells, cellFlags, outlineEdges, inlineEdges, events, grid }
  if (cellEventZones) mesh.cellEventZones = cellEventZones
  return mesh
}

function readSkinnedNavMesh(r: BinaryReader): BmsSkinnedNavMesh {
  const start = r.offset
  const structure0 = readF32s(r, readCount(r, 12, 'skinned nav structure0') * 3)
  const count1 = readCount(r, 2, 'skinned nav structure1')
  const structure1 = r.bytesView(count1 * 2).slice()
  const structure2 = readU16s(r, readCount(r, 6, 'skinned nav structure2') * 3)
  return { raw: r.bytes.subarray(start, r.offset), structure0, structure1, structure2 }
}

function readCloth(r: BinaryReader, header: BmsHeader, sections: Section[]): BmsCloth | undefined {
  let vertexMaxDistance = new Float32Array(0)
  let vertexPinned = new Uint32Array(0)
  if (enter(r, header.clothVertexOffset, 'cloth vertex')) {
    const start = r.offset
    const count = readCount(r, 8, 'cloth vertex')
    vertexMaxDistance = new Float32Array(count)
    vertexPinned = new Uint32Array(count)
    for (let i = 0; i < count; i++) {
      vertexMaxDistance[i] = r.f32()
      vertexPinned[i] = r.u32()
    }
    sections.push({ name: 'cloth vertex', start, end: r.offset })
  }
  let edges = new Uint32Array(0)
  let edgeMaxDistance = new Float32Array(0)
  let edgeOrder: Uint32Array = new Uint32Array(0)
  let params: BmsClothParams | undefined
  if (enter(r, header.clothEdgeOffset, 'cloth edge')) {
    const start = r.offset
    const count = readCount(r, 16, 'cloth edge')
    edges = new Uint32Array(count * 2)
    edgeMaxDistance = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      edges[i * 2] = r.u32()
      edges[i * 2 + 1] = r.u32()
      edgeMaxDistance[i] = r.f32()
    }
    edgeOrder = readU32s(r, count)
    if (count > 0) {
      need(r, 36, 'cloth parameters')
      params = {
        deformationMode: r.u32(),
        animationOffsetX: r.f32(),
        animationOffsetZ: r.f32(),
        animationOffsetY: r.f32(),
        fallingSpeed: r.f32(),
        unknownFloat6: r.f32(),
        unknownFloat7: r.f32(),
        elasticity: r.f32(),
        movementFactor: r.u32(),
      }
    }
    sections.push({ name: 'cloth edge', start, end: r.offset })
  }
  if (vertexMaxDistance.length === 0 && edgeMaxDistance.length === 0) return undefined
  const cloth: BmsCloth = { vertexMaxDistance, vertexPinned, edges, edgeMaxDistance, edgeOrder }
  if (params) cloth.params = params
  return cloth
}

export function parseBms(bytes: Uint8Array): BmsMesh {
  const r = new BinaryReader(bytes)
  const { signature, version, header, name, materialName } = readHeader(r)
  const { vertexFlags } = header
  if (vertexFlags & ~KNOWN_VERTEX_FLAGS) fail(12 + 13 * 4, `unknown vertex flags 0x${vertexFlags.toString(16)}`)
  const hasUv1 = (vertexFlags & BMS_VERTEX_LIGHTMAP) !== 0
  const hasMorph = (vertexFlags & BMS_VERTEX_MORPH) !== 0
  const hasExtra = (vertexFlags & BMS_VERTEX_EXTRA) !== 0
  const sections: Section[] = []

  // Vertex buffer
  let vertexCount = 0
  let positions = new Float32Array(0)
  let normals = new Float32Array(0)
  let uv0 = new Float32Array(0)
  let uv1: Float32Array | undefined
  let morph: Uint8Array | undefined
  let unknownVertexFloat = new Float32Array(0)
  let unknownVertexInt0 = new Uint32Array(0)
  let unknownVertexInt1 = new Uint32Array(0)
  let lightmapPath: string | undefined
  let extraVertexData: Float32Array | undefined
  if (enter(r, header.vertexOffset, 'vertex')) {
    const start = r.offset
    const stride = 44 + (hasUv1 ? 8 : 0) + (hasMorph ? BMS_MORPH_BYTES : 0)
    vertexCount = readCount(r, stride, 'vertex')
    positions = new Float32Array(vertexCount * 3)
    normals = new Float32Array(vertexCount * 3)
    uv0 = new Float32Array(vertexCount * 2)
    if (hasUv1) uv1 = new Float32Array(vertexCount * 2)
    if (hasMorph) morph = new Uint8Array(vertexCount * BMS_MORPH_BYTES)
    unknownVertexFloat = new Float32Array(vertexCount)
    unknownVertexInt0 = new Uint32Array(vertexCount)
    unknownVertexInt1 = new Uint32Array(vertexCount)
    for (let i = 0; i < vertexCount; i++) {
      positions[i * 3] = r.f32()
      positions[i * 3 + 1] = r.f32()
      positions[i * 3 + 2] = r.f32()
      normals[i * 3] = r.f32()
      normals[i * 3 + 1] = r.f32()
      normals[i * 3 + 2] = r.f32()
      uv0[i * 2] = r.f32()
      uv0[i * 2 + 1] = r.f32()
      if (uv1) {
        uv1[i * 2] = r.f32()
        uv1[i * 2 + 1] = r.f32()
      }
      if (morph) morph.set(r.bytesView(BMS_MORPH_BYTES), i * BMS_MORPH_BYTES)
      unknownVertexFloat[i] = r.f32()
      unknownVertexInt0[i] = r.u32()
      unknownVertexInt1[i] = r.u32()
    }
    if (hasUv1) lightmapPath = readString(r, 'lightmap path')
    if (hasExtra) extraVertexData = readF32s(r, readCount(r, 24, 'extra vertex data') * 6)
    sections.push({ name: 'vertex', start, end: r.offset })
  }

  // Skinning
  const boneNames: string[] = []
  const influencesPerVertex = version === 109 ? 4 : 2
  let skinBones: Uint8Array | undefined
  let skinWeights: Uint16Array | undefined
  let joints: Uint16Array | undefined
  let weights: Float32Array | undefined
  if (enter(r, header.skinOffset, 'skin')) {
    const start = r.offset
    const boneCount = readCount(r, 4, 'bone')
    for (let i = 0; i < boneCount; i++) boneNames.push(readString(r, `bone ${i} name`))
    if (boneCount > 0) {
      const k = influencesPerVertex
      need(r, vertexCount * k * 3, 'skin weights')
      skinBones = new Uint8Array(vertexCount * k)
      skinWeights = new Uint16Array(vertexCount * k)
      joints = new Uint16Array(vertexCount * 4)
      weights = new Float32Array(vertexCount * 4)
      for (let v = 0; v < vertexCount; v++) {
        for (let j = 0; j < k; j++) {
          const bone = r.u8()
          const weight = r.u16()
          skinBones[v * k + j] = bone
          skinWeights[v * k + j] = weight
          if (bone !== BMS_NO_BONE) {
            joints[v * 4 + j] = bone
            weights[v * 4 + j] = weight * WEIGHT_SCALE
          }
        }
      }
    }
    sections.push({ name: 'skin', start, end: r.offset })
  }

  // Faces
  let indices: Uint16Array = new Uint16Array(0)
  if (enter(r, header.faceOffset, 'face')) {
    const start = r.offset
    indices = readU16s(r, readCount(r, 6, 'face') * 3)
    sections.push({ name: 'face', start, end: r.offset })
  }

  const cloth = readCloth(r, header, sections)

  // Bounding box
  let bounds: BmsBounds = { min: [0, 0, 0], max: [0, 0, 0] }
  if (enter(r, header.boundingBoxOffset, 'bounding box')) {
    const start = r.offset
    need(r, 24, 'bounding box')
    bounds = { min: [r.f32(), r.f32(), r.f32()], max: [r.f32(), r.f32(), r.f32()] }
    sections.push({ name: 'bounding box', start, end: r.offset })
  }

  // Occlusion portals
  const occlusionPortals: BmsOcclusionPortal[] = []
  if (enter(r, header.occlusionPortalOffset, 'occlusion portal')) {
    const start = r.offset
    const count = readCount(r, 12, 'occlusion portal')
    for (let i = 0; i < count; i++) {
      const portalName = readString(r, `occlusion portal ${i} name`)
      const vertices = readF32s(r, readCount(r, 12, `occlusion portal ${i} vertex`) * 3)
      const portalIndices = readU16s(r, readCount(r, 6, `occlusion portal ${i} face`) * 3)
      occlusionPortals.push({ name: portalName, vertices, indices: portalIndices })
    }
    sections.push({ name: 'occlusion portal', start, end: r.offset })
  }

  let unknown9Count = 0
  if (enter(r, header.unknown9Offset, 'unknown9')) {
    const start = r.offset
    need(r, 4, 'unknown9 count')
    unknown9Count = r.u32()
    if (unknown9Count !== 0) fail(start, `unsupported unknown9 count ${unknown9Count}`)
    sections.push({ name: 'unknown9', start, end: r.offset })
  }

  let navMesh: BmsNavMesh | undefined
  if (enter(r, header.navMeshOffset, 'navmesh')) {
    const start = r.offset
    navMesh = readNavMesh(r, header.navFlags)
    sections.push({ name: 'navmesh', start, end: r.offset })
  }

  let skinnedNavMesh: BmsSkinnedNavMesh | undefined
  if (enter(r, header.skinnedNavMeshOffset, 'skinned navmesh')) {
    const start = r.offset
    skinnedNavMesh = readSkinnedNavMesh(r)
    sections.push({ name: 'skinned navmesh', start, end: r.offset })
  }

  // The sections must tile the file from the end of the header to EOF.
  sections.sort((a, b) => a.start - b.start)
  let expected = header.size
  let previous = 'header'
  for (const s of sections) {
    if (s.start !== expected) fail(s.start, `${s.name} section does not follow ${previous} (which ends at ${expected})`)
    expected = s.end
    previous = s.name
  }
  if (expected !== bytes.byteLength) fail(expected, `${bytes.byteLength - expected} unexpected bytes after ${previous}`)

  const mesh: BmsMesh = {
    signature, version, header, name, materialName, vertexFlags, vertexCount,
    positions, normals, uv0,
    unknownVertexFloat, unknownVertexInt0, unknownVertexInt1,
    boneNames, influencesPerVertex: boneNames.length > 0 ? influencesPerVertex : 0,
    indices, bounds, occlusionPortals, unknown9Count,
  }
  if (uv1) mesh.uv1 = uv1
  if (lightmapPath !== undefined) mesh.lightmapPath = lightmapPath
  if (morph) mesh.morph = morph
  if (extraVertexData) mesh.extraVertexData = extraVertexData
  if (skinBones && skinWeights && joints && weights) {
    mesh.skinBones = skinBones
    mesh.skinWeights = skinWeights
    mesh.joints = joints
    mesh.weights = weights
  }
  if (cloth) mesh.cloth = cloth
  if (navMesh) mesh.navMesh = navMesh
  if (skinnedNavMesh) mesh.skinnedNavMesh = skinnedNavMesh
  return mesh
}
