/**
 * Region object placements: Map.pk2 <Z>/<X>.o and <Z>/<X>.o2 (JMXVMAPO1001; 7 empty placeholder .o
 * files carry JMXVMAPO1000).
 *
 * Specs: openroad docs/formats/mapo-jmxvmapo.md and SilkroadDoc wiki JMXVMAPO (both read as
 * documentation only); Lafa2K Silkroad-Import-Terrain-Models-blender read_objects/place_object (MIT,
 * (c) 2026 Lafa2K). Where they disagree the vSRO 1.188 bytes decide
 * (packages/convert/test/objects.corpus.test.ts):
 *
 *   signature  "JMXVMAPO1001" (12 bytes)
 *   36 blocks  6 x 6, z outer, x inner (block (x, z) covers region-local [320x, 320x + 320) x [320z, ...))
 *     G groups u16 count, count x record. G = 4 in every file with objects (SilkroadDoc's one group
 *              per .o block is wrong for this client); 18 all-empty placeholder .o files have G = 3.
 *              G is chosen from the body length.
 *       record u32 objId, f32[3] position, u16 static flag, f32 yaw, u16 uid, u16 unknown0,
 *              u8 isBig, u8 isStruct, and in .o2 only u16 regionId  (28 / 30 bytes)
 *
 * Measured facts:
 * - Position is region-local, not block-local: x, z relative to the origin (min x, min z corner) of the
 *   OWNER region (the record's regionId in .o2, the file's own region in .o); every .o record lies in
 *   the block that lists it (4 of 50,156 sit on a block edge). y is an absolute height on the terrain's
 *   datum. Checked against the .m terrain heights: 64% of .o objects stand within 5 units of the ground
 *   under them (22-24% with x and z swapped or an axis mirrored, 16% if read block-local), and the
 *   neighbour-owned .o2 records land on the ground 4x as often in the owner's frame as in the file's.
 * - Yaw is in radians (21k records are exact multiples of pi/2, 25k whole degrees), not normalized
 *   (range -200..45). It turns +X toward +Z: a model point (x, y, z) is placed at
 *   position + (x cos(yaw) - z sin(yaw), y, x sin(yaw) + z cos(yaw)), i.e. the file-space quaternion
 *   `mapoYawQuat(yaw)` (also Lafa2K's default). Evidence: the navmesh outlines of the Jangan
 *   buildings drawn over the client's own minimap tiles (north up) line up only this way (checked by
 *   eye, twice, with independently written overlay code);
 *   all 266 object-edge links of the .nvm files meet (within 3.3 units) with it, while 152 are 10+ units
 *   apart with the opposite sign; and every rotated object's navmesh lies inside the .nvm terrain
 *   cells that list it (668 objects do not with the opposite sign).
 * - uid = (blockZ << 13) | (blockX << 10) | serial, blockX/Z being the block the object was created in
 *   (= the .o block listing it). Unique per owner region; the world-unique key is (regionId, uid).
 * - Groups 0 and 1 are always empty. Group 2 holds large objects (bounding size median 336 units),
 *   group 3 small ones (median 38): distance-culling classes, not alternative models.
 * - .o lists every object once, in the block holding its origin, and only objects the region owns.
 * - .o2 lists, per block, every object whose extent overlaps that block, including objects owned by
 *   neighbouring regions (up to 4 regions away), each carrying its owner's regionId and a position
 *   relative to the owner. Repeats of one (regionId, uid) are byte-identical. Deduplicated on
 *   (regionId, uid), the records a region's .o2 owns are exactly its .o. isBig does NOT mark the
 *   repeated objects (7,135 non-big objects appear in several regions' .o2, 122 big ones in only one).
 * - The .nvm object list of a region is exactly its .o2 records, deduplicated on (regionId, uid) in
 *   first-appearance order, keeping the objects whose resource has a collision navmesh.
 *
 * Which one to render: .o2 (openroad: the current format, .o its predecessor; it is also the view the
 * .nvm object lists were built from). A renderer that loads whole regions can take the .o2 records
 * whose regionId is the file's region (identical to .o), or everything with a (regionId, uid) dedupe
 * to also draw neighbour-owned objects that overhang the loaded area. 142 regions have a .o and no
 * .o2; they hold 106 objects in total.
 */
import { BinaryReader, latin1 } from './binary.ts'
import type { Quat, Vec3 } from './math.ts'

export const MAPO_SIGNATURE_PREFIX = 'JMXVMAPO'
export const MAPO_SUPPORTED_VERSIONS: readonly number[] = [1000, 1001]
/** Region edge length in file units (1 unit = 1 dm). */
export const MAPO_REGION_SIZE = 1920
export const MAPO_BLOCKS_PER_SIDE = 6
export const MAPO_BLOCK_SIZE = MAPO_REGION_SIZE / MAPO_BLOCKS_PER_SIDE
export const MAPO_BLOCK_COUNT = MAPO_BLOCKS_PER_SIDE * MAPO_BLOCKS_PER_SIDE
/** Culling groups used by the client files (0 and 1 are always empty). */
export const MAPO_GROUP_LARGE = 2
export const MAPO_GROUP_SMALL = 3
/** Value of the static flag for static objects; 0 is dynamic, anything else is uninitialized memory. */
export const MAPO_STATIC = 0xffff

export type MapOKind = 'o' | 'o2'

export const MAPO_RECORD_SIZE: Readonly<Record<MapOKind, number>> = { o: 28, o2: 30 }

export interface MapObjectPlacement {
  /** Index into Map/object.ifo. */
  objId: number
  /** Raw file space, relative to the owner region's origin (see the header). */
  position: Vec3
  /** Raw u16 (IsStatic in the specs): 0xFFFF static, 0 dynamic; 375 of 50,156 .o records hold other values. */
  staticFlag: number
  /** Radians, as stored (not normalized); turns +X toward +Z, see mapoYawQuat. */
  yaw: number
  /** (blockZ << 13) | (blockX << 10) | serial; unique within the owner region. */
  uid: number
  /** Raw u16 of unknown meaning (0 in 92%; 0x8000, 0xCCCC and colour-like values otherwise). */
  unknown0: number
  isBig: number
  /** 1 when objectstring.ifo names this placement (key (regionId << 16) | uid). */
  isStruct: number
  /** .o2 only: owner region, bits 0-7 x, 8-14 z, 15 dungeon (never set). null for .o. */
  regionId: number | null
}

export interface MapOBlock {
  /** Block column and row, 0..5. */
  x: number
  z: number
  /** groups[g] = the records of culling group g. */
  groups: MapObjectPlacement[][]
}

export interface MapO {
  /** 'JMXVMAPO1001' */
  signature: string
  /** 1001 or 1000 */
  version: number
  kind: MapOKind
  /** Groups per block: 4, or 3 in the empty placeholder files. */
  groupsPerBlock: number
  /** 36 blocks, index z * 6 + x. */
  blocks: MapOBlock[]
}

function fail(message: string, offset: number): never {
  throw new Error(`MAPO: ${message} at offset ${offset}`)
}

function bodyFits(bytes: Uint8Array, groups: number, recordSize: number): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 12
  for (let i = 0; i < MAPO_BLOCK_COUNT * groups; i++) {
    if (o + 2 > bytes.length) return false
    o += 2 + view.getUint16(o, true) * recordSize
    if (o > bytes.length) return false
  }
  return o === bytes.length
}

/** Group counts (4..1) whose 36-block layout consumes the file exactly. */
export function mapoLayouts(bytes: Uint8Array, kind: MapOKind): number[] {
  return [4, 3, 2, 1].filter(g => bodyFits(bytes, g, MAPO_RECORD_SIZE[kind]))
}

/** Parse a .o (kind 'o') or .o2 (kind 'o2') file. Throws an Error naming the offset on malformed input. */
export function parseMapO(bytes: Uint8Array, kind: MapOKind): MapO {
  if (kind !== 'o' && kind !== 'o2') throw new Error(`MAPO: unknown kind ${JSON.stringify(kind)}`)
  if (bytes.length < 12) fail(`file of ${bytes.length} bytes is too short for a signature`, 0)
  const r = new BinaryReader(bytes)
  const signature = r.fixedString(12, latin1)
  const version = Number(signature.slice(8))
  if (!signature.startsWith(MAPO_SIGNATURE_PREFIX) || !MAPO_SUPPORTED_VERSIONS.includes(version)) {
    fail(`unsupported signature ${JSON.stringify(signature)}`, 0)
  }
  const groupsPerBlock = mapoLayouts(bytes, kind)[0]
  if (groupsPerBlock === undefined) {
    fail(`body of ${bytes.length - 12} bytes fits no layout of 36 blocks x 1..4 groups of ${MAPO_RECORD_SIZE[kind]}-byte .${kind} records`, 12)
  }
  const blocks: MapOBlock[] = []
  for (let z = 0; z < MAPO_BLOCKS_PER_SIDE; z++) {
    for (let x = 0; x < MAPO_BLOCKS_PER_SIDE; x++) {
      const groups: MapObjectPlacement[][] = []
      for (let g = 0; g < groupsPerBlock; g++) {
        const n = r.u16()
        const list: MapObjectPlacement[] = []
        for (let i = 0; i < n; i++) {
          list.push({
            objId: r.u32(),
            position: [r.f32(), r.f32(), r.f32()],
            staticFlag: r.u16(),
            yaw: r.f32(),
            uid: r.u16(),
            unknown0: r.u16(),
            isBig: r.u8(),
            isStruct: r.u8(),
            regionId: kind === 'o2' ? r.u16() : null,
          })
        }
        groups.push(list)
      }
      blocks.push({ x, z, groups })
    }
  }
  return { signature, version, kind, groupsPerBlock, blocks }
}

export interface MapObjectInstance extends MapObjectPlacement {
  /** The first block (z * 6 + x) and group that list it. */
  block: number
  group: number
}

/**
 * Every object once, in first-appearance order (blocks z-major, then groups), deduplicated on
 * (regionId, uid). With `ownerRegionId`, only the records owned by that region are kept (for a .o
 * every record is owned by the file's region; for a .o2 pass the file's region to get the .o set).
 */
export function mapoInstances(mapo: MapO, ownerRegionId?: number): MapObjectInstance[] {
  const seen = new Set<number>()
  const out: MapObjectInstance[] = []
  mapo.blocks.forEach((b, block) => {
    b.groups.forEach((list, group) => {
      for (const p of list) {
        if (ownerRegionId !== undefined && p.regionId !== null && p.regionId !== ownerRegionId) continue
        const key = (p.regionId ?? 0) * 0x10000 + p.uid
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ ...p, block, group })
      }
    })
  })
  return out
}

/** Region id <-> coordinates: bits 0-7 x, 8-14 z, bit 15 dungeon. */
export function mapoRegionId(x: number, z: number): number {
  return ((z & 0x7f) << 8) | (x & 0xff)
}

export function mapoRegionCoords(regionId: number): { x: number; z: number; dungeon: boolean } {
  return { x: regionId & 0xff, z: (regionId >> 8) & 0x7f, dungeon: (regionId & 0x8000) !== 0 }
}

/**
 * The placement's position re-expressed relative to region `regionId` (the frame .nvm files use for
 * neighbour-owned objects). For .o records, `ownerRegionId` must be the file's region.
 */
export function mapoPositionInRegion(p: MapObjectPlacement, regionId: number, ownerRegionId = p.regionId): Vec3 {
  if (ownerRegionId === null) throw new Error('MAPO: .o placements need the owner region id')
  const owner = mapoRegionCoords(ownerRegionId)
  const target = mapoRegionCoords(regionId)
  return [
    p.position[0] + (owner.x - target.x) * MAPO_REGION_SIZE,
    p.position[1],
    p.position[2] + (owner.z - target.z) * MAPO_REGION_SIZE,
  ]
}

/**
 * File-space rotation of a placement as an [x, y, z, w] quaternion for bskMath.quatRotate (convert it
 * with space.ts toGltfQuat like any other file-space quaternion): the Hamilton rotation by -yaw about
 * +Y, which maps +X to (cos yaw, 0, sin yaw).
 */
export function mapoYawQuat(yaw: number): Quat {
  return [0, -Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
}

/** Decoded uid: the block the object was created in and its serial there. */
export function mapoUidParts(uid: number): { blockX: number; blockZ: number; serial: number } {
  return { blockX: (uid >> 10) & 7, blockZ: uid >> 13, serial: uid & 0x3ff }
}
