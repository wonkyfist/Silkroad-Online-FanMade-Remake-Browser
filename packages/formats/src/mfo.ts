/**
 * Map/mapinfo.mfo (JMXVMFO 1000): which world regions exist, plus region id helpers.
 *
 * Specs: SilkroadDoc wiki JMXVMFO, openroad docs/formats/mfo-jmxvmfo.md (read as documentation),
 * checked against the vSRO 1.188 bytes (packages/convert/test/terrain.corpus.test.ts).
 *
 *   0   char[12]  "JMXVMFO 1000"
 *   12  i16       mapWidth  (256: the 8 x bits of a region id)
 *   14  i16       mapHeight (128: the 7 z bits; the id's top bit is the dungeon flag)
 *   16  i16[4]    unknown (all 0 in 1.188)
 *   24  u8[8192]  one bit per region id 0..65535, MSB first: byte id >> 3, mask 0x80 >> (id & 7)
 *
 * Region id = z << 8 | x, with bit 15 marking a dungeon (whose low bits are then a dungeon index, not x/z).
 * Evidence for MSB-first: all 3,300 set bits of 1.188 name a region that has Map/<z>/<x>.m; reading the
 * bits LSB-first would name 651 regions without terrain. The dungeon half (ids >= 0x8000) is all zero.
 */
import { BinaryReader, latin1 } from './binary.ts'

export const MFO_SIGNATURE = 'JMXVMFO 1000'
export const MFO_HEADER_SIZE = 24
export const MFO_REGION_BYTES = 8192
export const MFO_FILE_SIZE = MFO_HEADER_SIZE + MFO_REGION_BYTES

/** Bit 15 of a region id: the region is a dungeon (instanced interior), not a world tile. */
export const REGION_DUNGEON_BIT = 0x8000

export interface RegionCoord {
  x: number
  z: number
}

export interface MfoFile {
  signature: string
  mapWidth: number
  mapHeight: number
  /** The four i16 after mapHeight (all 0 in 1.188). */
  unknown: [number, number, number, number]
  /** View of the 8,192-byte region bit array (65,536 bits, MSB first). */
  regionData: Uint8Array
}

export function parseMfo(bytes: Uint8Array): MfoFile {
  if (bytes.byteLength < MFO_FILE_SIZE) {
    throw new Error(`MFO: file is ${bytes.byteLength} bytes, expected ${MFO_FILE_SIZE}`)
  }
  const r = new BinaryReader(bytes)
  const signature = r.fixedString(12, latin1)
  if (signature !== MFO_SIGNATURE) {
    throw new Error(`MFO: bad signature ${JSON.stringify(signature)} at offset 0 (expected "${MFO_SIGNATURE}")`)
  }
  const mapWidth = r.i16()
  const mapHeight = r.i16()
  const unknown: [number, number, number, number] = [r.i16(), r.i16(), r.i16(), r.i16()]
  const regionData = r.bytesView(MFO_REGION_BYTES)
  if (r.remaining !== 0) throw new Error(`MFO: ${r.remaining} trailing bytes at offset ${r.offset}`)
  return { signature, mapWidth, mapHeight, unknown, regionData }
}

/** z << 8 | x, plus bit 15 for dungeons. x in 0..255, z in 0..127. */
export function regionId(x: number, z: number, dungeon = false): number {
  if (!Number.isInteger(x) || x < 0 || x > 255 || !Number.isInteger(z) || z < 0 || z > 127) {
    throw new RangeError(`region (${x}, ${z}) outside x 0..255, z 0..127`)
  }
  return ((z << 8) | x | (dungeon ? REGION_DUNGEON_BIT : 0)) >>> 0
}

export function isDungeonRegion(id: number): boolean {
  return (id & REGION_DUNGEON_BIT) !== 0
}

/** Splits a region id into x (low byte), z (bits 8..14) and the dungeon flag (bit 15). */
export function regionCoords(id: number): RegionCoord & { dungeon: boolean } {
  return { x: id & 0xff, z: (id >> 8) & 0x7f, dungeon: isDungeonRegion(id) }
}

/** Tests the bit of a raw region id (0..65535). */
export function isRegionIdActive(mfo: MfoFile, id: number): boolean {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) return false
  return (mfo.regionData[id >> 3]! & (0x80 >> (id & 7))) !== 0
}

/** Whether world region (x, z) exists (has terrain the client loads). Out-of-range coordinates are inactive. */
export function isRegionActive(mfo: MfoFile, x: number, z: number): boolean {
  if (!Number.isInteger(x) || x < 0 || x > 255 || !Number.isInteger(z) || z < 0 || z > 127) return false
  return isRegionIdActive(mfo, (z << 8) | x)
}

/** Every active world region, ordered by id (z, then x). Dungeon bits are ignored (never set in 1.188). */
export function listActiveRegions(mfo: MfoFile): RegionCoord[] {
  const out: RegionCoord[] = []
  for (let id = 0; id < REGION_DUNGEON_BIT; id++) {
    if (isRegionIdActive(mfo, id)) out.push({ x: id & 0xff, z: id >> 8 })
  }
  return out
}
