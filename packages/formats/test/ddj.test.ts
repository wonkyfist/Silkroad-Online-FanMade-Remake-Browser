import { describe, expect, it } from 'vitest'
import {
  DDPF_ALPHA,
  DDPF_ALPHAPIXELS,
  DDPF_FOURCC,
  DDPF_LUMINANCE,
  DDPF_PALETTEINDEXED8,
  DDPF_RGB,
  DDSCAPS2_CUBEMAP,
  DDSCAPS2_CUBEMAP_ALLFACES,
  DDSCAPS2_VOLUME,
  DDSD_MIPMAPCOUNT,
  decodeDds,
  parseDdj,
  readDdsHeader,
} from '../src/ddj.ts'

interface PixelFormatSpec {
  flags: number
  fourCC?: string
  bits?: number
  r?: number
  g?: number
  b?: number
  a?: number
}

interface DdsSpec {
  width: number
  height: number
  pf: PixelFormatSpec
  mipMapCount?: number
  depth?: number
  caps2?: number
}

/** Synthetic DDS: 128-byte header followed by the payload bytes. */
function makeDds(spec: DdsSpec, ...payload: ArrayLike<number>[]): Uint8Array {
  const size = payload.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(128 + size)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x20534444, true)
  v.setUint32(4, 124, true)
  v.setUint32(8, 0x1007 | (spec.mipMapCount ? DDSD_MIPMAPCOUNT : 0), true)
  v.setUint32(12, spec.height, true)
  v.setUint32(16, spec.width, true)
  v.setUint32(24, spec.depth ?? 0, true)
  v.setUint32(28, spec.mipMapCount ?? 0, true)
  v.setUint32(76, 32, true)
  v.setUint32(80, spec.pf.flags, true)
  const cc = spec.pf.fourCC ?? '\0\0\0\0'
  for (let i = 0; i < 4; i++) out[84 + i] = cc.charCodeAt(i)
  v.setUint32(88, spec.pf.bits ?? 0, true)
  v.setUint32(92, spec.pf.r ?? 0, true)
  v.setUint32(96, spec.pf.g ?? 0, true)
  v.setUint32(100, spec.pf.b ?? 0, true)
  v.setUint32(104, spec.pf.a ?? 0, true)
  v.setUint32(108, 0x1000, true)
  v.setUint32(112, spec.caps2 ?? 0, true)
  let o = 128
  for (const p of payload) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const u16 = (...values: number[]) => values.flatMap(x => [x & 0xff, (x >> 8) & 0xff])
const u32 = (...values: number[]) => values.flatMap(x => [x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, x >>> 24])
const px = (img: { width: number; rgba: Uint8Array }, x: number, y: number) =>
  Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))

/** 2-bit indices for 16 texels (row-major) packed into the color block's u32. */
const indexBits = (idx: number[]) => idx.reduce((acc, v, i) => acc + v * 2 ** (2 * i), 0)
const colorBlock = (c0: number, c1: number, idx: number[]) => [...u16(c0, c1), ...u32(indexBits(idx))]
const ramp = Array.from({ length: 16 }, (_, i) => i & 3)

const DXT = (fourCC: string): PixelFormatSpec => ({ flags: DDPF_FOURCC, fourCC })

describe('parseDdj', () => {
  const ddj = (sig: string, declared: number, type: number, body: number[]) => {
    const out = new Uint8Array(20 + body.length)
    for (let i = 0; i < 12; i++) out[i] = sig.charCodeAt(i)
    const v = new DataView(out.buffer)
    v.setUint32(12, declared, true)
    v.setUint32(16, type, true)
    out.set(body, 20)
    return out
  }

  it('strips the 20-byte header and keeps raw fields', () => {
    const f = parseDdj(ddj('JMXVDDJ 1000', 13, 3, [0x44, 0x44, 0x53, 0x20, 9]))
    expect(f.signature).toBe('JMXVDDJ 1000')
    expect(f.declaredSize).toBe(13)
    expect(f.textureType).toBe(3)
    expect(Array.from(f.dds)).toEqual([0x44, 0x44, 0x53, 0x20, 9])
  })

  it('ignores an untrusted size field and returns the payload up to EOF', () => {
    const f = parseDdj(ddj('JMXVDDJ 1000', 0x10108, 3, [1, 2, 3]))
    expect(f.declaredSize).toBe(0x10108)
    expect(f.dds.length).toBe(3)
  })

  it('decodes the DDS view from a DDJ that itself sits at a nonzero byteOffset', () => {
    const dds = makeDds({ width: 4, height: 4, pf: DXT('DXT1') }, colorBlock(0xf800, 0x001f, ramp))
    const file = ddj('JMXVDDJ 1000', dds.length + 8, 3, Array.from(dds))
    const pool = new Uint8Array(file.length + 7)
    pool.set(file, 7)
    const f = parseDdj(pool.subarray(7))
    expect(f.dds.byteOffset).toBe(27)
    expect(f.declaredSize).toBe(f.dds.length + 8)
    const img = decodeDds(f.dds)
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255])
    expect(px(img, 3, 3)).toEqual([85, 0, 170, 255])
  })

  it('rejects bad signatures and short files', () => {
    expect(() => parseDdj(ddj('JMXVBMS 0110', 8, 3, []))).toThrow(/signature/)
    expect(() => parseDdj(new Uint8Array(19))).toThrow(/shorter/)
  })
})

describe('decodeDds block formats', () => {
  it('DXT1 four-color mode (color0 > color1)', () => {
    const img = decodeDds(makeDds({ width: 4, height: 4, pf: DXT('DXT1') }, colorBlock(0xf800, 0x001f, ramp)))
    expect(img.format).toBe('DXT1')
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255])
    expect(px(img, 1, 0)).toEqual([0, 0, 255, 255])
    expect(px(img, 2, 0)).toEqual([170, 0, 85, 255])
    expect(px(img, 3, 0)).toEqual([85, 0, 170, 255])
  })

  it('DXT1 three-color mode with 1-bit alpha (color0 <= color1)', () => {
    const img = decodeDds(makeDds({ width: 4, height: 4, pf: DXT('DXT1') }, colorBlock(0x001f, 0xf800, ramp)))
    expect(px(img, 0, 0)).toEqual([0, 0, 255, 255])
    expect(px(img, 1, 0)).toEqual([255, 0, 0, 255])
    expect(px(img, 2, 0)).toEqual([128, 0, 128, 255])
    expect(px(img, 3, 0)).toEqual([0, 0, 0, 0])
    // equal endpoints are also 3-color mode
    const eq = decodeDds(makeDds({ width: 4, height: 4, pf: DXT('DXT1') }, colorBlock(0x07e0, 0x07e0, ramp)))
    expect(px(eq, 3, 1)).toEqual([0, 0, 0, 0])
  })

  it('texel order: row-major, first texel in the low bits', () => {
    const idx = Array.from({ length: 16 }, (_, i) => (i === 6 ? 1 : 0))
    const img = decodeDds(makeDds({ width: 4, height: 4, pf: DXT('DXT1') }, colorBlock(0xffff, 0x0000, idx)))
    expect(px(img, 2, 1)).toEqual([0, 0, 0, 255])
    expect(px(img, 1, 2)).toEqual([255, 255, 255, 255])
  })

  it('clips blocks overhanging odd and non-power-of-two edges', () => {
    // 5x3 = 2x1 blocks; block 0 is white, block 1 black
    const white = colorBlock(0xffff, 0, new Array(16).fill(0))
    const black = colorBlock(0xffff, 0, new Array(16).fill(1))
    const img = decodeDds(makeDds({ width: 5, height: 3, pf: DXT('DXT1') }, white, black))
    expect(img.rgba.length).toBe(5 * 3 * 4)
    expect(px(img, 3, 2)).toEqual([255, 255, 255, 255])
    expect(px(img, 4, 0)).toEqual([0, 0, 0, 255])
    expect(px(img, 4, 2)).toEqual([0, 0, 0, 255])
    const tiny = decodeDds(makeDds({ width: 1, height: 1, pf: DXT('DXT1') }, white))
    expect(Array.from(tiny.rgba)).toEqual([255, 255, 255, 255])
  })

  it('DXT3 explicit 4-bit alpha; color is always four-color', () => {
    const alpha = [0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe] // texel i has alpha nibble i
    const img = decodeDds(makeDds({ width: 4, height: 4, pf: DXT('DXT3') }, alpha, colorBlock(0x001f, 0xf800, ramp)))
    expect(img.format).toBe('DXT3')
    expect(img.premultiplied).toBe(false)
    for (let i = 0; i < 16; i++) expect(px(img, i & 3, i >> 2)[3]).toBe(i * 17)
    expect(px(img, 2, 0).slice(0, 3)).toEqual([85, 0, 170]) // 4-color even though c0 < c1
    expect(px(img, 3, 3).slice(0, 3)).toEqual([170, 0, 85])
  })

  it('DXT2 is un-premultiplied by default', () => {
    const alpha = new Array(8).fill(0x88) // alpha 136 everywhere
    const color = colorBlock(16 << 11, 16 << 11, new Array(16).fill(0)) // red 132
    const file = makeDds({ width: 4, height: 4, pf: DXT('DXT2') }, alpha, color)
    const img = decodeDds(file)
    expect(img.premultiplied).toBe(true)
    expect(px(img, 0, 0)).toEqual([248, 0, 0, 136])
    expect(px(decodeDds(file, { unpremultiply: false }), 0, 0)).toEqual([132, 0, 0, 136])
  })

  it('DXT5 interpolated alpha, 8-value and 6-value modes', () => {
    const alphaIdx = (idx: number[]) => {
      const bits = idx.reduce((acc, v, i) => acc + BigInt(v) * (1n << BigInt(3 * i)), 0n)
      return Array.from({ length: 6 }, (_, i) => Number((bits >> BigInt(8 * i)) & 0xffn))
    }
    const idx = Array.from({ length: 16 }, (_, i) => i & 7)
    const color = colorBlock(0xffff, 0xffff, new Array(16).fill(0))
    const eight = decodeDds(makeDds({ width: 4, height: 4, pf: DXT('DXT5') }, [255, 0, ...alphaIdx(idx)], color))
    expect(Array.from({ length: 16 }, (_, i) => px(eight, i & 3, i >> 2)[3])).toEqual([
      255, 0, 219, 182, 146, 109, 73, 36, 255, 0, 219, 182, 146, 109, 73, 36,
    ])
    const six = decodeDds(makeDds({ width: 4, height: 4, pf: DXT('DXT5') }, [0, 255, ...alphaIdx(idx)], color))
    expect(Array.from({ length: 8 }, (_, i) => px(six, i & 3, i >> 2)[3])).toEqual([0, 255, 51, 102, 153, 204, 0, 255])
  })

  it('DXT4 is flagged premultiplied and un-premultiplied', () => {
    const color = colorBlock(0xffff, 0xffff, new Array(16).fill(0))
    const img = decodeDds(makeDds({ width: 4, height: 4, pf: DXT('DXT4') }, [64, 64, 0, 0, 0, 0, 0, 0], color))
    expect(img.format).toBe('DXT4')
    expect(img.premultiplied).toBe(true)
    expect(px(img, 0, 0)).toEqual([255, 255, 255, 64])
  })
})

describe('decodeDds bit-mask formats', () => {
  const rgb = (bits: number, r: number, g: number, b: number, a = 0): PixelFormatSpec => ({
    flags: DDPF_RGB | (a ? DDPF_ALPHAPIXELS : 0),
    bits,
    r,
    g,
    b,
    a,
  })

  it('A8R8G8B8 and X8R8G8B8 (BGRA in memory)', () => {
    const argb = decodeDds(makeDds({ width: 2, height: 1, pf: rgb(32, 0xff0000, 0xff00, 0xff, 0xff000000) }, u32(0x80102030, 0xff000000)))
    expect(argb.format).toBe('A8R8G8B8')
    expect(Array.from(argb.rgba)).toEqual([0x10, 0x20, 0x30, 0x80, 0, 0, 0, 255])
    const xrgb = decodeDds(makeDds({ width: 1, height: 1, pf: rgb(32, 0xff0000, 0xff00, 0xff) }, u32(0x00102030)))
    expect(xrgb.format).toBe('X8R8G8B8')
    expect(Array.from(xrgb.rgba)).toEqual([0x10, 0x20, 0x30, 255])
  })

  it('R8G8B8 and A8B8G8R8', () => {
    const img = decodeDds(makeDds({ width: 1, height: 1, pf: rgb(24, 0xff0000, 0xff00, 0xff) }, [0x30, 0x20, 0x10]))
    expect(img.format).toBe('R8G8B8')
    expect(Array.from(img.rgba)).toEqual([0x10, 0x20, 0x30, 255])
    const abgr = decodeDds(makeDds({ width: 1, height: 1, pf: rgb(32, 0xff, 0xff00, 0xff0000, 0xff000000) }, [1, 2, 3, 4]))
    expect(abgr.format).toBe('A8B8G8R8')
    expect(Array.from(abgr.rgba)).toEqual([1, 2, 3, 4])
  })

  it('R5G6B5', () => {
    const img = decodeDds(makeDds({ width: 4, height: 1, pf: rgb(16, 0xf800, 0x7e0, 0x1f) }, u16(0xf800, 0x07e0, 0x001f, 0x8410)))
    expect(img.format).toBe('R5G6B5')
    expect(Array.from(img.rgba)).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 132, 130, 132, 255])
  })

  it('A1R5G5B5 and X1R5G5B5', () => {
    const a1 = decodeDds(makeDds({ width: 2, height: 1, pf: rgb(16, 0x7c00, 0x3e0, 0x1f, 0x8000) }, u16(0x8000, 0x7c00)))
    expect(a1.format).toBe('A1R5G5B5')
    expect(Array.from(a1.rgba)).toEqual([0, 0, 0, 255, 255, 0, 0, 0])
    const x1 = decodeDds(makeDds({ width: 1, height: 1, pf: rgb(16, 0x7c00, 0x3e0, 0x1f) }, u16(0x03ff)))
    expect(x1.format).toBe('X1R5G5B5')
    expect(Array.from(x1.rgba)).toEqual([0, 255, 255, 255])
  })

  it('A4R4G4B4', () => {
    const img = decodeDds(makeDds({ width: 2, height: 1, pf: rgb(16, 0xf00, 0xf0, 0xf, 0xf000) }, u16(0xf0f0, 0x1234)))
    expect(img.format).toBe('A4R4G4B4')
    expect(Array.from(img.rgba)).toEqual([0, 255, 0, 255, 34, 51, 68, 17])
  })

  it('A8, L8 and A8L8', () => {
    const a8 = decodeDds(makeDds({ width: 1, height: 1, pf: { flags: DDPF_ALPHA, bits: 8, a: 0xff } }, [0x80]))
    expect(a8.format).toBe('A8')
    expect(Array.from(a8.rgba)).toEqual([0, 0, 0, 0x80])
    const l8 = decodeDds(makeDds({ width: 1, height: 1, pf: { flags: DDPF_LUMINANCE, bits: 8, r: 0xff } }, [0x40]))
    expect(l8.format).toBe('L8')
    expect(Array.from(l8.rgba)).toEqual([0x40, 0x40, 0x40, 255])
    const a8l8 = decodeDds(
      makeDds({ width: 1, height: 1, pf: { flags: DDPF_LUMINANCE | DDPF_ALPHAPIXELS, bits: 16, r: 0xff, a: 0xff00 } }, [0x40, 0x7f]),
    )
    expect(a8l8.format).toBe('A8L8')
    expect(Array.from(a8l8.rgba)).toEqual([0x40, 0x40, 0x40, 0x7f])
  })

  it('odd-sized uncompressed rows are packed without padding', () => {
    const pixels = Array.from({ length: 3 * 5 }, (_, i) => i * 16)
    const img = decodeDds(makeDds({ width: 3, height: 5, pf: { flags: DDPF_LUMINANCE, bits: 8, r: 0xff } }, pixels))
    expect(px(img, 2, 4)).toEqual([224, 224, 224, 255])
    expect(px(img, 0, 1)).toEqual([48, 48, 48, 255])
  })

  it('P8 with a trailing palette, and P8 without one', () => {
    const palette = new Array(1024).fill(0)
    palette.splice(5 * 4, 4, 10, 20, 30, 40)
    const pf = { flags: DDPF_PALETTEINDEXED8, bits: 8 }
    const img = decodeDds(makeDds({ width: 2, height: 1, pf }, palette, [5, 0]))
    expect(img.format).toBe('P8')
    expect(Array.from(img.rgba)).toEqual([10, 20, 30, 255, 0, 0, 0, 255])
    const withAlpha = decodeDds(makeDds({ width: 1, height: 1, pf: { ...pf, flags: pf.flags | DDPF_ALPHAPIXELS } }, palette, [5]))
    expect(Array.from(withAlpha.rgba)).toEqual([10, 20, 30, 40])
    expect(() => decodeDds(makeDds({ width: 2, height: 1, pf }, [5, 0]))).toThrow(/needs/)
  })
})

describe('decodeDds layout', () => {
  const solid = (c: number) => colorBlock(c, c, new Array(16).fill(0))

  it('mip chains: counts, sizes and level selection', () => {
    // 8x4 DXT1: 8x4 (2 blocks), 4x2, 2x1, 1x1 (1 block each)
    const file = makeDds({ width: 8, height: 4, mipMapCount: 4, pf: DXT('DXT1') }, solid(0xffff), solid(0xffff), solid(0xf800), solid(0x07e0), solid(0x001f))
    const h = readDdsHeader(file)
    expect(h.mipCount).toBe(4)
    expect(h.dataOffset).toBe(128)
    expect(h.dataSize).toBe(5 * 8)
    expect(decodeDds(file).width).toBe(8)
    const m1 = decodeDds(file, { mip: 1 })
    expect([m1.width, m1.height]).toEqual([4, 2])
    expect(px(m1, 3, 1)).toEqual([255, 0, 0, 255])
    const m3 = decodeDds(file, { mip: 3 })
    expect([m3.width, m3.height]).toEqual([1, 1])
    expect(Array.from(m3.rgba)).toEqual([0, 0, 255, 255])
    expect(() => decodeDds(file, { mip: 4 })).toThrow(/mip/)
  })

  it('mipMapCount 0 means one level', () => {
    const h = readDdsHeader(makeDds({ width: 4, height: 4, pf: DXT('DXT1') }, solid(0)))
    expect(h.mipMapCount).toBe(0)
    expect(h.mipCount).toBe(1)
  })

  it('cube maps store each face with its full mip chain', () => {
    const faces = [0xf800, 0x07e0, 0x001f, 0xffff, 0x0000, 0xffe0]
    const payload = faces.flatMap(c => [...solid(c), ...solid(0x1234)]) // 4x4 + 2x2 per face
    const file = makeDds(
      { width: 4, height: 4, mipMapCount: 2, caps2: DDSCAPS2_CUBEMAP | DDSCAPS2_CUBEMAP_ALLFACES, pf: DXT('DXT1') },
      payload,
    )
    const h = readDdsHeader(file)
    expect(h.isCube).toBe(true)
    expect(h.faceCount).toBe(6)
    expect(h.dataSize).toBe(6 * 2 * 8)
    const img = decodeDds(file, { face: 2 })
    expect(img.isCube).toBe(true)
    expect(px(img, 0, 0)).toEqual([0, 0, 255, 255])
    expect(px(decodeDds(file, { face: 5 }), 3, 3)).toEqual([255, 255, 0, 255])
  })

  it('volume textures store all slices of a level together', () => {
    const slice = (v: number) => new Array(4).fill(v) // 2x2 L8
    const file = makeDds(
      { width: 2, height: 2, depth: 3, mipMapCount: 2, caps2: DDSCAPS2_VOLUME, pf: { flags: DDPF_LUMINANCE, bits: 8, r: 0xff } },
      slice(10), slice(20), slice(30), [40], // level 1 is 1x1x1
    )
    const h = readDdsHeader(file)
    expect(h.isVolume).toBe(true)
    expect(h.volumeDepth).toBe(3)
    expect(h.dataSize).toBe(13)
    expect(decodeDds(file).rgba[0]).toBe(10)
    expect(decodeDds(file, { face: 2 }).rgba[0]).toBe(30)
    expect(decodeDds(file, { mip: 1 }).rgba[0]).toBe(40)
  })
})

describe('decodeDds errors', () => {
  const ok = makeDds({ width: 4, height: 4, pf: DXT('DXT1') }, new Array(8).fill(0))

  it('rejects bad magic, header size and truncated data', () => {
    const badMagic = ok.slice()
    badMagic[0] = 0
    expect(() => decodeDds(badMagic)).toThrow(/magic/)
    const badSize = ok.slice()
    badSize[4] = 100
    expect(() => decodeDds(badSize)).toThrow(/header size/)
    expect(() => decodeDds(ok.subarray(0, 130))).toThrow(/needs 8 bytes at offset 128/)
    expect(() => decodeDds(ok.subarray(0, 100))).toThrow(/shorter/)
  })

  it('rejects unsupported formats and zero dimensions', () => {
    expect(() => decodeDds(makeDds({ width: 4, height: 4, pf: DXT('ATI2') }, new Array(16).fill(0)))).toThrow(/FourCC "ATI2"/)
    expect(() => decodeDds(makeDds({ width: 0, height: 4, pf: DXT('DXT1') }, []))).toThrow(/dimensions/)
    expect(() => decodeDds(makeDds({ width: 4, height: 4, pf: { flags: 0x80000, bits: 16 } }, []))).toThrow(/pixel format/)
  })
})
