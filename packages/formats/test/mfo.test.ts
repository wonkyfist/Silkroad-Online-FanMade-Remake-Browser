import { describe, expect, it } from 'vitest'
import {
  isDungeonRegion,
  isRegionActive,
  isRegionIdActive,
  listActiveRegions,
  MFO_FILE_SIZE,
  parseMfo,
  regionCoords,
  regionId,
} from '../src/mfo.ts'

function makeMfo(active: Array<[number, number]>, opts: { signature?: string; extra?: number } = {}): Uint8Array {
  const out = new Uint8Array(MFO_FILE_SIZE + (opts.extra ?? 0))
  const sig = opts.signature ?? 'JMXVMFO 1000'
  for (let i = 0; i < 12; i++) out[i] = sig.charCodeAt(i)
  const v = new DataView(out.buffer)
  v.setInt16(12, 256, true)
  v.setInt16(14, 128, true)
  v.setInt16(16, 1, true)
  v.setInt16(22, -2, true)
  for (const [x, z] of active) {
    const id = (z << 8) | x
    out[24 + (id >> 3)]! |= 0x80 >> (id & 7)
  }
  return out
}

describe('region ids', () => {
  it('packs z << 8 | x with bit 15 for dungeons', () => {
    expect(regionId(168, 97)).toBe(0x61a8)
    expect(regionId(0, 0)).toBe(0)
    expect(regionId(255, 127)).toBe(0x7fff)
    expect(regionId(1, 2, true)).toBe(0x8201)
    expect(regionCoords(0x61a8)).toEqual({ x: 168, z: 97, dungeon: false })
    expect(regionCoords(0x8201)).toEqual({ x: 1, z: 2, dungeon: true })
    expect(isDungeonRegion(0x8000)).toBe(true)
    expect(isDungeonRegion(0x7fff)).toBe(false)
  })

  it('rejects coordinates outside the id space', () => {
    expect(() => regionId(256, 0)).toThrow(RangeError)
    expect(() => regionId(0, 128)).toThrow(RangeError)
    expect(() => regionId(-1, 0)).toThrow(RangeError)
    expect(() => regionId(1.5, 0)).toThrow(RangeError)
  })
})

describe('parseMfo', () => {
  it('reads the header and addresses bits MSB first', () => {
    const bytes = makeMfo([[168, 97], [0, 0], [7, 0], [255, 127]])
    const mfo = parseMfo(bytes)
    expect(mfo.signature).toBe('JMXVMFO 1000')
    expect([mfo.mapWidth, mfo.mapHeight]).toEqual([256, 128])
    expect(mfo.unknown).toEqual([1, 0, 0, -2])
    expect(mfo.regionData.length).toBe(8192)
    // (0,0) is the top bit of byte 0, (7,0) the bottom bit
    expect(bytes[24]).toBe(0x81)
    // 0x61a8 >> 3 = 0xc35, 0x61a8 & 7 = 0 -> mask 0x80
    expect(bytes[24 + 0xc35]).toBe(0x80)
    expect(isRegionActive(mfo, 168, 97)).toBe(true)
    expect(isRegionActive(mfo, 169, 97)).toBe(false)
    expect(isRegionActive(mfo, 168, 98)).toBe(false)
    expect(isRegionActive(mfo, 7, 0)).toBe(true)
    expect(isRegionActive(mfo, 6, 0)).toBe(false)
    expect(isRegionActive(mfo, 256, 0)).toBe(false)
    expect(isRegionActive(mfo, -1, 0)).toBe(false)
    expect(isRegionIdActive(mfo, 0x61a8)).toBe(true)
    expect(isRegionIdActive(mfo, 0x10000)).toBe(false)
    expect(listActiveRegions(mfo)).toEqual([
      { x: 0, z: 0 },
      { x: 7, z: 0 },
      { x: 168, z: 97 },
      { x: 255, z: 127 },
    ])
  })

  it('ignores dungeon-half bits in listActiveRegions but reports them by id', () => {
    const bytes = makeMfo([])
    bytes[24 + (0x8001 >> 3)] = 0x40
    const mfo = parseMfo(bytes)
    expect(isRegionIdActive(mfo, 0x8001)).toBe(true)
    expect(listActiveRegions(mfo)).toEqual([])
  })

  it('rejects malformed files', () => {
    expect(() => parseMfo(makeMfo([], { signature: 'JMXVMFO 1001' }))).toThrow(/bad signature/)
    expect(() => parseMfo(makeMfo([]).subarray(0, 8000))).toThrow(/8000 bytes/)
    expect(() => parseMfo(makeMfo([], { extra: 3 }))).toThrow(/3 trailing bytes at offset 8216/)
  })
})
