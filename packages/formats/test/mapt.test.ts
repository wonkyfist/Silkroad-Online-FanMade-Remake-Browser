import { describe, expect, it } from 'vitest'
import { decodeMapTLightmap, MAPT_DDS_OFFSET, parseMapT } from '../src/mapt.ts'

/** 8x4 DXT1 DDS: two blocks, the left one solid red, the right one solid blue. */
function makeDds(): Uint8Array {
  const out = new Uint8Array(128 + 16)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x20534444, true)
  v.setUint32(4, 124, true)
  v.setUint32(8, 0x81007, true)
  v.setUint32(12, 4, true) // height
  v.setUint32(16, 8, true) // width
  v.setUint32(20, 16, true)
  v.setUint32(76, 32, true)
  v.setUint32(80, 0x4, true)
  for (let i = 0; i < 4; i++) out[84 + i] = 'DXT1'.charCodeAt(i)
  v.setUint32(108, 0x1000, true)
  // block colors: c0 = c1 = color, indices 0 -> solid
  v.setUint16(128, 0xf800, true)
  v.setUint16(130, 0xf800, true)
  v.setUint16(136, 0x001f, true)
  v.setUint16(138, 0x001f, true)
  return out
}

function makeMapT(dds: Uint8Array = makeDds(), signature = 'JMXVMAPT1001'): Uint8Array {
  const out = new Uint8Array(MAPT_DDS_OFFSET + dds.length)
  for (let i = 0; i < 12; i++) out[i] = signature.charCodeAt(i)
  for (let i = 0; i < 96 * 96; i++) out[12 + i] = i % 96 === 0 ? 153 : 255
  const v = new DataView(out.buffer)
  v.setUint32(9228, dds.length + 8, true)
  v.setUint32(9232, 3, true)
  out.set(dds, MAPT_DDS_OFFSET)
  return out
}

describe('parseMapT', () => {
  it('reads the light grid, the size/type words and the DDS tail', () => {
    const t = parseMapT(makeMapT())
    expect(MAPT_DDS_OFFSET).toBe(9236)
    expect(t.signature).toBe('JMXVMAPT1001')
    expect(t.lightGrid.length).toBe(9216)
    expect(t.lightGrid[0]).toBe(153)
    expect(t.lightGrid[1]).toBe(255)
    expect(t.lightGrid[96]).toBe(153)
    expect(t.declaredSize).toBe(t.dds.length + 8)
    expect(t.textureType).toBe(3)
    expect(t.dds.length).toBe(144)
    const img = decodeMapTLightmap(t)
    expect([img.width, img.height, img.format]).toEqual([8, 4, 'DXT1'])
    expect(Array.from(img.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(img.rgba.subarray(4 * 4, 4 * 4 + 4))).toEqual([0, 0, 255, 255])
  })

  it('does not trust the declared size', () => {
    const bytes = makeMapT()
    new DataView(bytes.buffer).setUint32(9228, 1, true)
    const t = parseMapT(bytes)
    expect(t.declaredSize).toBe(1)
    expect(t.dds.length).toBe(144)
  })

  it('rejects malformed files', () => {
    expect(() => parseMapT(makeMapT(makeDds(), 'JMXVMAPM1000'))).toThrow(/bad signature/)
    expect(() => parseMapT(makeMapT().subarray(0, 9000))).toThrow(/shorter than the 9236-byte header/)
    const noMagic = makeMapT()
    noMagic[MAPT_DDS_OFFSET] = 0
    expect(() => parseMapT(noMagic)).toThrow(/no "DDS " magic at offset 9236/)
  })
})
