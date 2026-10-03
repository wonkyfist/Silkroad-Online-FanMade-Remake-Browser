import { describe, expect, it } from 'vitest'
import {
  assembleRegionGrid,
  MAPM_BLOCK_BYTES,
  MAPM_FILE_SIZE,
  parseMapM,
  REGION_GRID_SIZE,
  REGION_SIZE,
  vertexCopies,
} from '../src/mapm.ts'

// Synthetic region: every vertex value is a function of its region grid position, so a correct
// stitch reproduces it exactly and shared edges agree by construction.
const heightAt = (gx: number, gz: number) => gx * 1000 + gz + 0.25
const textureAt = (gx: number, gz: number) => ((gx + 3 * gz) % 1024) | ((gx % 5) << 13)
const brightAt = (gx: number, gz: number) => (gx * 7 + gz) & 0xff
const tileFlagAt = (tx: number, tz: number) => (tx === tz ? 1 : 0) | ((tx % 3) << 9)

interface BlockOverride {
  heights?: Map<number, number>
}

function makeMapM(overrides: Map<number, BlockOverride> = new Map()): Uint8Array {
  const out = new Uint8Array(MAPM_FILE_SIZE)
  const v = new DataView(out.buffer)
  const sig = 'JMXVMAPM1000'
  for (let i = 0; i < 12; i++) out[i] = sig.charCodeAt(i)
  let o = 12
  for (let bz = 0; bz < 6; bz++) {
    for (let bx = 0; bx < 6; bx++) {
      const index = bz * 6 + bx
      const ov = overrides.get(index)
      v.setUint32(o, index === 14 ? 1 : 0, true)
      v.setUint16(o + 4, 100 + index, true)
      o += 6
      for (let vz = 0; vz < 17; vz++) {
        for (let vx = 0; vx < 17; vx++) {
          const gx = bx * 16 + vx
          const gz = bz * 16 + vz
          v.setFloat32(o, ov?.heights?.get(vz * 17 + vx) ?? heightAt(gx, gz), true)
          v.setUint16(o + 4, textureAt(gx, gz), true)
          out[o + 6] = brightAt(gx, gz)
          o += 7
        }
      }
      v.setInt8(o, index % 3 === 0 ? -1 : index % 3 === 1 ? 0 : 1)
      out[o + 1] = index % 4
      v.setFloat32(o + 2, -index * 1.5, true)
      o += 6
      for (let tz = 0; tz < 16; tz++) {
        for (let tx = 0; tx < 16; tx++) {
          v.setUint16(o, tileFlagAt(bx * 16 + tx, bz * 16 + tz), true)
          o += 2
        }
      }
      v.setFloat32(o, 9000 + index, true)
      v.setFloat32(o + 4, -9000 - index, true)
      out[o + 8] = index & 1
      out[o + 27] = 0xee
      o += 28
    }
  }
  expect(o).toBe(MAPM_FILE_SIZE)
  return out
}

describe('parseMapM', () => {
  it('has the documented sizes', () => {
    expect(MAPM_BLOCK_BYTES).toBe(2575)
    expect(MAPM_FILE_SIZE).toBe(92712)
    expect(REGION_GRID_SIZE).toBe(97)
    expect(REGION_SIZE).toBe(1920)
  })

  it('reads every block field in file order (bz outer, bx inner; vz outer, vx inner)', () => {
    const m = parseMapM(makeMapM())
    expect(m.signature).toBe('JMXVMAPM1000')
    expect(m.blocks.length).toBe(36)
    const b = m.blocks[8]! // bz 1, bx 2
    expect([b.index, b.bx, b.bz]).toEqual([8, 2, 1])
    expect(b.flag).toBe(0)
    expect(m.blocks[14]!.flag).toBe(1)
    expect(b.environmentId).toBe(108)
    // vertex (vx 3, vz 5) -> region (35, 21)
    expect(b.heights[5 * 17 + 3]).toBe(heightAt(35, 21))
    const raw = textureAt(35, 21)
    expect(b.textures[5 * 17 + 3]).toBe(raw)
    expect(b.textureIds[5 * 17 + 3]).toBe(raw & 0x3ff)
    expect(b.textureHighBits[5 * 17 + 3]).toBe(raw >> 10)
    expect(b.brightness[5 * 17 + 3]).toBe(brightAt(35, 21))
    expect([b.waterType, b.waterWaveType, b.waterHeight]).toEqual([1, 0, -12])
    expect(m.blocks[0]!.waterType).toBe(-1)
    expect(m.blocks[1]!.waterType).toBe(0)
    // tile (tx 4, tz 4) of block (2, 1) -> region tile (36, 20)
    expect(b.tileFlags[4 * 16 + 4]).toBe(tileFlagAt(36, 20))
    expect([b.heightMax, b.heightMin]).toEqual([9008, -9008])
    expect(b.unknown.length).toBe(20)
    expect(b.unknown[0]).toBe(0)
    expect(m.blocks[9]!.unknown[0]).toBe(1)
    expect(b.unknown[19]).toBe(0xee)
  })

  it('rejects bad signatures and sizes with offsets', () => {
    const bytes = makeMapM()
    const bad = bytes.slice()
    bad[11] = 0x31
    expect(() => parseMapM(bad)).toThrow(/bad signature .* at offset 0/)
    expect(() => parseMapM(bytes.subarray(0, 92711))).toThrow(/92711 bytes, expected 92712/)
    const long = new Uint8Array(92712 + 1000)
    long.set(bytes)
    expect(() => parseMapM(long)).toThrow(/at offset 12/)
    expect(() => parseMapM(bytes.subarray(0, 5))).toThrow(/shorter than the signature/)
  })
})

describe('assembleRegionGrid', () => {
  it('stitches blocks to (16 bx + vx, 16 bz + vz), index gz * 97 + gx', () => {
    const grid = assembleRegionGrid(parseMapM(makeMapM()))
    expect(grid.size).toBe(97)
    expect(grid.heights.length).toBe(97 * 97)
    for (let gz = 0; gz < 97; gz++) {
      for (let gx = 0; gx < 97; gx++) {
        const g = gz * 97 + gx
        expect(grid.heights[g]).toBe(heightAt(gx, gz))
        expect(grid.textures[g]).toBe(textureAt(gx, gz))
        expect(grid.textureIds[g]).toBe(textureAt(gx, gz) & 0x3ff)
        expect(grid.brightness[g]).toBe(brightAt(gx, gz))
      }
    }
    for (let tz = 0; tz < 96; tz++) {
      for (let tx = 0; tx < 96; tx++) expect(grid.tileFlags[tz * 96 + tx]).toBe(tileFlagAt(tx, tz))
    }
    expect(Array.from(grid.environmentIds)).toEqual(Array.from({ length: 36 }, (_, i) => 100 + i))
    expect(grid.edgeConflicts).toEqual([])
  })

  it('lets the later block win on disagreeing shared vertices and reports every copy', () => {
    // block (1, 0) is index 1; its vertex (vx 0, vz 5) duplicates block 0's (vx 16, vz 5) = region (16, 5)
    // block (1, 1) is index 7; its vertex (0, 0) is the corner (16, 16) shared by blocks 0, 1, 6, 7
    const m = parseMapM(
      makeMapM(
        new Map([
          [1, { heights: new Map([[5 * 17 + 0, 777]]) }],
          [7, { heights: new Map([[0, -5]]) }],
        ]),
      ),
    )
    const grid = assembleRegionGrid(m)
    expect(grid.heights[5 * 97 + 16]).toBe(777)
    expect(grid.heights[16 * 97 + 16]).toBe(-5)
    expect(grid.edgeConflicts).toEqual([
      { gx: 16, gz: 5, heights: [heightAt(16, 5), 777] },
      { gx: 16, gz: 16, heights: [heightAt(16, 16), heightAt(16, 16), heightAt(16, 16), -5] },
    ])
    expect(vertexCopies(m, 0, 0)).toEqual([heightAt(0, 0)])
    // +0 and -0 copies are the same height, not a seam
    const zeros = parseMapM(
      makeMapM(
        new Map([
          [0, { heights: new Map([[16, 0]]) }],
          [1, { heights: new Map([[0, -0]]) }],
        ]),
      ),
    )
    expect(assembleRegionGrid(zeros).edgeConflicts).toEqual([])
    expect(vertexCopies(m, 96, 50)).toEqual([heightAt(96, 50)])
  })
})
