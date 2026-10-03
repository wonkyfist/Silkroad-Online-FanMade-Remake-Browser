/**
 * JMXVDDJ texture container and a DDS -> RGBA8 decoder.
 *
 * DDJ (openroad docs/formats/ddj-jmxvddj.md, SilkroadDoc wiki JMXVDDJ, cross-checked with the
 * Lafa2K importer's extract_ddj and the vSRO 1.188 corpus):
 *   0   char[12] signature "JMXVDDJ 1000"
 *   12  u32      declaredSize: byte count from offset 12 to EOF, i.e. dds.byteLength + 8 (it counts
 *                itself and textureType). Exact in all 32,663 vSRO 1.188 files, but openroad reports
 *                corpora where it is oversized, so it is never used to slice the payload.
 *   16  u32      textureType: D3DRESOURCETYPE (3 texture, 4 volume, 5 cube). Only 3 occurs.
 *   20  ...      a complete DDS file ("DDS " + 124-byte DDS_HEADER + surfaces) up to EOF.
 *
 * DDS: Microsoft "DDS file layout" (DDS_HEADER, DDS_PIXELFORMAT) and the Direct3D 9 "Compressed
 * Texture Resources" block definitions. Notes on choices the specs leave open:
 * - Surfaces are stored top-down, rows packed to whole bytes (no DWORD padding): verified exact
 *   for every file in the corpus. Cube maps store each present face's full mip chain in turn;
 *   volume textures store all depth slices of a level before the next level.
 * - DXT1 blocks with color0 <= color1 use 3 colors + transparent black. DXT2..5 color blocks are
 *   always 4-color. Endpoints expand by bit replication; interpolants round to nearest.
 * - DXT2/DXT4 hold premultiplied color. By default it is un-premultiplied (rgb * 255 / a, clamped),
 *   so the output is straight alpha like every other format. D3D9 samples DXT2 exactly like DXT3,
 *   so pass { unpremultiply: false } to get the stored values.
 * - A8 decodes to black (0,0,0,a), matching D3D9 sampling.
 * - P8 has no palette in the DDS header; like DirectXTex's legacy reader we expect 256 PALETTEENTRY
 *   records (R, G, B, flags) right after the header, and use flags as alpha only when DDPF_ALPHAPIXELS
 *   is set. None occur in vSRO 1.188; a P8 file too short to hold the palette throws.
 */
import { BinaryReader, latin1 } from './binary.ts'

export const DDJ_SIGNATURE = 'JMXVDDJ 1000'
export const DDJ_HEADER_SIZE = 20

/** D3DRESOURCETYPE values seen in DDJ headers. */
export const D3DRTYPE_TEXTURE = 3
export const D3DRTYPE_VOLUMETEXTURE = 4
export const D3DRTYPE_CUBETEXTURE = 5

export interface DdjFile {
  signature: string
  /** Raw u32 at offset 12; dds.byteLength + 8 when correct. Untrusted. */
  declaredSize: number
  /** Raw D3DRESOURCETYPE (3 texture, 4 volume, 5 cube). */
  textureType: number
  /** View (not a copy) of bytes 20..EOF: a complete DDS file. */
  dds: Uint8Array
}

export function parseDdj(bytes: Uint8Array): DdjFile {
  if (bytes.byteLength < DDJ_HEADER_SIZE) {
    throw new Error(`DDJ: file is ${bytes.byteLength} bytes, shorter than the ${DDJ_HEADER_SIZE}-byte header`)
  }
  const r = new BinaryReader(bytes)
  const signature = r.fixedString(12)
  if (signature !== DDJ_SIGNATURE) {
    throw new Error(`DDJ: bad signature ${JSON.stringify(signature)} at offset 0 (expected "${DDJ_SIGNATURE}")`)
  }
  const declaredSize = r.u32()
  const textureType = r.u32()
  return { signature, declaredSize, textureType, dds: bytes.subarray(DDJ_HEADER_SIZE) }
}

// DDS_HEADER.dwFlags
export const DDSD_CAPS = 0x1
export const DDSD_HEIGHT = 0x2
export const DDSD_WIDTH = 0x4
export const DDSD_PITCH = 0x8
export const DDSD_PIXELFORMAT = 0x1000
export const DDSD_MIPMAPCOUNT = 0x20000
export const DDSD_LINEARSIZE = 0x80000
export const DDSD_DEPTH = 0x800000
// DDS_PIXELFORMAT.dwFlags
export const DDPF_ALPHAPIXELS = 0x1
export const DDPF_ALPHA = 0x2
export const DDPF_FOURCC = 0x4
export const DDPF_PALETTEINDEXED8 = 0x20
export const DDPF_RGB = 0x40
export const DDPF_YUV = 0x200
export const DDPF_LUMINANCE = 0x20000
export const DDPF_BUMPDUDV = 0x80000
// DDS_HEADER.dwCaps2
export const DDSCAPS2_CUBEMAP = 0x200
export const DDSCAPS2_CUBEMAP_ALLFACES = 0xfc00
export const DDSCAPS2_VOLUME = 0x200000

const DDS_MAGIC = 0x20534444 // "DDS "
const DDS_HEADER_SIZE = 124
const DDS_PIXELFORMAT_SIZE = 32
const DDS_DATA_OFFSET = 4 + DDS_HEADER_SIZE
const P8_PALETTE_SIZE = 256 * 4
const MAX_PIXELS = 1 << 28

export interface DdsPixelFormat {
  flags: number
  /** FourCC as a little-endian u32 (a D3DFMT number when it is not printable). */
  fourCC: number
  fourCCString: string
  rgbBitCount: number
  rMask: number
  gMask: number
  bMask: number
  aMask: number
}

export interface DdsHeader {
  flags: number
  height: number
  width: number
  pitchOrLinearSize: number
  /** Raw dwDepth (only meaningful for volume textures). */
  depth: number
  /** Raw dwMipMapCount (0 when the file has no mip chain). */
  mipMapCount: number
  /** dwReserved1[11], kept raw. */
  reserved1: Uint8Array
  pixelFormat: DdsPixelFormat
  caps: number
  caps2: number
  caps3: number
  caps4: number
  reserved2: number
  /** Decoded format name: 'DXT1', 'A8R8G8B8', 'L8', ... (D3DFMT naming, most significant channel first). */
  format: string
  /** Mip levels stored (mipMapCount, or 1 when it is 0). */
  mipCount: number
  isCube: boolean
  isVolume: boolean
  /** Cube faces present (1 for non-cube textures). */
  faceCount: number
  /** Depth slices at level 0 (1 for non-volume textures). */
  volumeDepth: number
  /** Source color is premultiplied by alpha (DXT2, DXT4). */
  premultiplied: boolean
  /** Byte offset of the first surface (after the header and any P8 palette). */
  dataOffset: number
  /** Bytes the full mip chain of every face/slice needs, starting at dataOffset. */
  dataSize: number
}

type BlockKind = 'bc1' | 'bc2' | 'bc3'

type FormatInfo =
  | { kind: 'block'; name: string; block: BlockKind; blockBytes: 8 | 16; premultiplied: boolean }
  | { kind: 'mask'; name: string; bits: number; r: number; g: number; b: number; a: number; luminance: boolean }
  | { kind: 'p8'; name: string; alpha: boolean }

const FOURCC_FORMATS: Record<string, FormatInfo> = {
  DXT1: { kind: 'block', name: 'DXT1', block: 'bc1', blockBytes: 8, premultiplied: false },
  DXT2: { kind: 'block', name: 'DXT2', block: 'bc2', blockBytes: 16, premultiplied: true },
  DXT3: { kind: 'block', name: 'DXT3', block: 'bc2', blockBytes: 16, premultiplied: false },
  DXT4: { kind: 'block', name: 'DXT4', block: 'bc3', blockBytes: 16, premultiplied: true },
  DXT5: { kind: 'block', name: 'DXT5', block: 'bc3', blockBytes: 16, premultiplied: false },
}

/** [bits, r, g, b, a, name] for DDPF_RGB layouts with D3D9 names. */
const RGB_NAMES: Array<[number, number, number, number, number, string]> = [
  [32, 0xff0000, 0xff00, 0xff, 0xff000000, 'A8R8G8B8'],
  [32, 0xff0000, 0xff00, 0xff, 0, 'X8R8G8B8'],
  [32, 0xff, 0xff00, 0xff0000, 0xff000000, 'A8B8G8R8'],
  [32, 0xff, 0xff00, 0xff0000, 0, 'X8B8G8R8'],
  [32, 0x3ff00000, 0xffc00, 0x3ff, 0xc0000000, 'A2R10G10B10'],
  [32, 0x3ff, 0xffc00, 0x3ff00000, 0xc0000000, 'A2B10G10R10'],
  [32, 0xffff, 0xffff0000, 0, 0, 'G16R16'],
  [24, 0xff0000, 0xff00, 0xff, 0, 'R8G8B8'],
  [16, 0xf800, 0x7e0, 0x1f, 0, 'R5G6B5'],
  [16, 0x7c00, 0x3e0, 0x1f, 0x8000, 'A1R5G5B5'],
  [16, 0x7c00, 0x3e0, 0x1f, 0, 'X1R5G5B5'],
  [16, 0xf00, 0xf0, 0xf, 0xf000, 'A4R4G4B4'],
  [16, 0xf00, 0xf0, 0xf, 0, 'X4R4G4B4'],
  [16, 0xe0, 0x1c, 0x3, 0xff00, 'A8R3G3B2'],
  [8, 0xe0, 0x1c, 0x3, 0, 'R3G3B2'],
]

/** [bits, luminance, alpha, name] for DDPF_LUMINANCE layouts. */
const LUMINANCE_NAMES: Array<[number, number, number, string]> = [
  [8, 0xff, 0, 'L8'],
  [16, 0xff, 0xff00, 'A8L8'],
  [16, 0xffff, 0, 'L16'],
  [8, 0xf, 0xf0, 'A4L4'],
]

function hex(v: number): string {
  return '0x' + (v >>> 0).toString(16)
}

function resolveFormat(pf: DdsPixelFormat): FormatInfo {
  const f = pf.flags
  if (f & DDPF_FOURCC) {
    const info = FOURCC_FORMATS[pf.fourCCString]
    if (info) return info
    throw new Error(`DDS: unsupported FourCC ${JSON.stringify(pf.fourCCString)} (${hex(pf.fourCC)}) at offset 84`)
  }
  const bits = pf.rgbBitCount
  if (f & DDPF_PALETTEINDEXED8) {
    if (bits !== 8) throw new Error(`DDS: palettized format with ${bits} bits per pixel at offset 88`)
    return { kind: 'p8', name: 'P8', alpha: (f & DDPF_ALPHAPIXELS) !== 0 }
  }
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) {
    throw new Error(`DDS: unsupported bit count ${bits} at offset 88 (pixel format flags ${hex(f)})`)
  }
  const hasAlpha = (f & (DDPF_ALPHAPIXELS | DDPF_ALPHA)) !== 0
  const a = hasAlpha ? pf.aMask >>> 0 : 0
  if (f & DDPF_RGB) {
    const r = pf.rMask >>> 0
    const g = pf.gMask >>> 0
    const b = pf.bMask >>> 0
    if ((r | g | b) === 0) throw new Error(`DDS: RGB pixel format without color masks at offset 92`)
    const known = RGB_NAMES.find(([nb, nr, ng, nbm, na]) => nb === bits && nr === r && ng === g && nbm === b && na === a)
    const name = known?.[5] ?? `RGB${bits}(${hex(r)},${hex(g)},${hex(b)},${hex(a)})`
    return { kind: 'mask', name, bits, r, g, b, a, luminance: false }
  }
  if (f & DDPF_LUMINANCE) {
    const l = pf.rMask >>> 0
    if (l === 0) throw new Error(`DDS: luminance pixel format without a luminance mask at offset 92`)
    const known = LUMINANCE_NAMES.find(([nb, nl, na]) => nb === bits && nl === l && na === a)
    const name = known?.[3] ?? `L${bits}(${hex(l)},${hex(a)})`
    return { kind: 'mask', name, bits, r: l, g: l, b: l, a, luminance: true }
  }
  if (f & DDPF_ALPHA) {
    if (a === 0) throw new Error(`DDS: alpha-only pixel format without an alpha mask at offset 104`)
    const name = bits === 8 && a === 0xff ? 'A8' : `A${bits}(${hex(a)})`
    return { kind: 'mask', name, bits, r: 0, g: 0, b: 0, a, luminance: false }
  }
  throw new Error(`DDS: unsupported pixel format flags ${hex(f)} at offset 80`)
}

function surfaceSize(info: FormatInfo, width: number, height: number): number {
  if (info.kind === 'block') return Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * info.blockBytes
  const bits = info.kind === 'p8' ? 8 : info.bits
  return ((width * bits + 7) >> 3) * height
}

interface ParsedHeader {
  header: DdsHeader
  info: FormatInfo
}

function parseHeader(dds: Uint8Array): ParsedHeader {
  if (dds.byteLength < DDS_DATA_OFFSET) {
    throw new Error(`DDS: ${dds.byteLength} bytes, shorter than the ${DDS_DATA_OFFSET}-byte header`)
  }
  const r = new BinaryReader(dds)
  const magic = r.u32()
  if (magic !== DDS_MAGIC) throw new Error(`DDS: bad magic ${hex(magic)} at offset 0`)
  const size = r.u32()
  if (size !== DDS_HEADER_SIZE) throw new Error(`DDS: header size ${size} at offset 4 (expected ${DDS_HEADER_SIZE})`)
  const flags = r.u32()
  const height = r.u32()
  const width = r.u32()
  const pitchOrLinearSize = r.u32()
  const depth = r.u32()
  const mipMapCount = r.u32()
  const reserved1 = r.bytesView(44)
  const pfSize = r.u32()
  if (pfSize !== DDS_PIXELFORMAT_SIZE) {
    throw new Error(`DDS: pixel format size ${pfSize} at offset 76 (expected ${DDS_PIXELFORMAT_SIZE})`)
  }
  const pfFlags = r.u32()
  const fourCCBytes = dds.subarray(r.offset, r.offset + 4)
  const fourCC = r.u32()
  const pixelFormat: DdsPixelFormat = {
    flags: pfFlags,
    fourCC,
    fourCCString: latin1.decode(fourCCBytes),
    rgbBitCount: r.u32(),
    rMask: r.u32(),
    gMask: r.u32(),
    bMask: r.u32(),
    aMask: r.u32(),
  }
  const caps = r.u32()
  const caps2 = r.u32()
  const caps3 = r.u32()
  const caps4 = r.u32()
  const reserved2 = r.u32()

  if (width === 0 || height === 0 || width * height > MAX_PIXELS) {
    throw new Error(`DDS: unusable dimensions ${width}x${height} at offset 12`)
  }
  const info = resolveFormat(pixelFormat)
  const isCube = (caps2 & DDSCAPS2_CUBEMAP) !== 0
  const isVolume = (caps2 & DDSCAPS2_VOLUME) !== 0 && depth > 0
  if (isCube && isVolume) throw new Error(`DDS: caps2 ${hex(caps2)} at offset 112 marks both cube map and volume`)
  let faceCount = 1
  if (isCube) {
    faceCount = 0
    for (let bit = 0x400; bit <= 0x8000; bit <<= 1) if (caps2 & bit) faceCount++
    if (faceCount === 0) throw new Error(`DDS: cube map with no faces in caps2 ${hex(caps2)} at offset 112`)
  }
  const volumeDepth = isVolume ? depth : 1
  const mipCount = mipMapCount === 0 ? 1 : mipMapCount
  const maxLevels = 32 - Math.clz32(Math.max(width, height, volumeDepth))
  if (mipCount > maxLevels) {
    throw new Error(`DDS: mipMapCount ${mipMapCount} at offset 28 exceeds ${maxLevels} levels for ${width}x${height}`)
  }

  let chain = 0
  for (let level = 0; level < mipCount; level++) {
    const w = Math.max(1, width >>> level)
    const h = Math.max(1, height >>> level)
    const d = Math.max(1, volumeDepth >>> level)
    chain += surfaceSize(info, w, h) * d
  }
  const dataOffset = DDS_DATA_OFFSET + (info.kind === 'p8' ? P8_PALETTE_SIZE : 0)
  const header: DdsHeader = {
    flags,
    height,
    width,
    pitchOrLinearSize,
    depth,
    mipMapCount,
    reserved1,
    pixelFormat,
    caps,
    caps2,
    caps3,
    caps4,
    reserved2,
    format: info.name,
    mipCount,
    isCube,
    isVolume,
    faceCount,
    volumeDepth,
    premultiplied: info.kind === 'block' && info.premultiplied,
    dataOffset,
    dataSize: chain * faceCount,
  }
  return { header, info }
}

/** Parse and validate the DDS header without decoding any pixels. */
export function readDdsHeader(dds: Uint8Array): DdsHeader {
  return parseHeader(dds).header
}

export interface DdsDecodeOptions {
  /** Mip level to decode (default 0). */
  mip?: number
  /** Cube face index among the faces present, or depth slice for volume textures (default 0). */
  face?: number
  /** Convert DXT2/DXT4 premultiplied color to straight alpha (default true). */
  unpremultiply?: boolean
}

export interface DecodedDds {
  /** Dimensions of the decoded surface (level 0 unless options.mip is set). */
  width: number
  height: number
  format: string
  mipCount: number
  isCube: boolean
  isVolume: boolean
  /** The source format stores premultiplied color (DXT2, DXT4). */
  premultiplied: boolean
  /** RGBA8, straight alpha (unless unpremultiply was disabled), rows top-down. */
  rgba: Uint8Array
}

export function decodeDds(dds: Uint8Array, options: DdsDecodeOptions = {}): DecodedDds {
  const { header, info } = parseHeader(dds)
  const mip = options.mip ?? 0
  const face = options.face ?? 0
  if (!Number.isInteger(mip) || mip < 0 || mip >= header.mipCount) {
    throw new Error(`DDS: mip ${mip} out of range (file has ${header.mipCount})`)
  }
  const width = Math.max(1, header.width >>> mip)
  const height = Math.max(1, header.height >>> mip)
  const sliceCount = header.isVolume ? Math.max(1, header.volumeDepth >>> mip) : header.faceCount
  if (!Number.isInteger(face) || face < 0 || face >= sliceCount) {
    throw new Error(`DDS: face/slice ${face} out of range (level ${mip} has ${sliceCount})`)
  }

  // Locate the surface: cube faces each hold a full chain; volume levels hold all their slices.
  let offset = header.dataOffset
  if (header.isVolume) {
    for (let level = 0; level < mip; level++) {
      const d = Math.max(1, header.volumeDepth >>> level)
      offset += surfaceSize(info, Math.max(1, header.width >>> level), Math.max(1, header.height >>> level)) * d
    }
    offset += surfaceSize(info, width, height) * face
  } else {
    offset += (header.dataSize / header.faceCount) * face
    for (let level = 0; level < mip; level++) {
      offset += surfaceSize(info, Math.max(1, header.width >>> level), Math.max(1, header.height >>> level))
    }
  }
  const size = surfaceSize(info, width, height)
  if (offset + size > dds.byteLength) {
    throw new Error(
      `DDS: ${header.format} ${width}x${height} surface needs ${size} bytes at offset ${offset}, file has ${dds.byteLength}`,
    )
  }

  const rgba = new Uint8Array(width * height * 4)
  if (info.kind === 'block') {
    decodeBlocks(dds, offset, width, height, info.block, rgba)
    if (info.premultiplied && options.unpremultiply !== false) unpremultiply(rgba)
  } else if (info.kind === 'mask') {
    decodeMasked(dds, offset, width, height, info, rgba)
  } else {
    decodePalettized(dds, offset, width, height, info.alpha, rgba)
  }
  return {
    width,
    height,
    format: header.format,
    mipCount: header.mipCount,
    isCube: header.isCube,
    isVolume: header.isVolume,
    premultiplied: header.premultiplied,
    rgba,
  }
}

const expand5 = (v: number) => (v << 3) | (v >> 2)
const expand6 = (v: number) => (v << 2) | (v >> 4)

/** Fills pal (4 RGBA entries) from the 8-byte color block at o. */
function colorPalette(src: Uint8Array, o: number, pal: Uint8Array, fourColorOnly: boolean): void {
  const c0 = src[o]! | (src[o + 1]! << 8)
  const c1 = src[o + 2]! | (src[o + 3]! << 8)
  const r0 = expand5(c0 >> 11)
  const g0 = expand6((c0 >> 5) & 0x3f)
  const b0 = expand5(c0 & 0x1f)
  const r1 = expand5(c1 >> 11)
  const g1 = expand6((c1 >> 5) & 0x3f)
  const b1 = expand5(c1 & 0x1f)
  pal[0] = r0
  pal[1] = g0
  pal[2] = b0
  pal[3] = 255
  pal[4] = r1
  pal[5] = g1
  pal[6] = b1
  pal[7] = 255
  if (fourColorOnly || c0 > c1) {
    pal[8] = ((2 * r0 + r1 + 1) / 3) | 0
    pal[9] = ((2 * g0 + g1 + 1) / 3) | 0
    pal[10] = ((2 * b0 + b1 + 1) / 3) | 0
    pal[11] = 255
    pal[12] = ((r0 + 2 * r1 + 1) / 3) | 0
    pal[13] = ((g0 + 2 * g1 + 1) / 3) | 0
    pal[14] = ((b0 + 2 * b1 + 1) / 3) | 0
    pal[15] = 255
  } else {
    pal[8] = (r0 + r1 + 1) >> 1
    pal[9] = (g0 + g1 + 1) >> 1
    pal[10] = (b0 + b1 + 1) >> 1
    pal[11] = 255
    pal[12] = 0
    pal[13] = 0
    pal[14] = 0
    pal[15] = 0
  }
}

/** DXT1 (bc1), DXT2/3 (bc2: explicit 4-bit alpha), DXT4/5 (bc3: interpolated alpha). Edge blocks are clipped. */
function decodeBlocks(src: Uint8Array, offset: number, width: number, height: number, kind: BlockKind, out: Uint8Array): void {
  const blocksX = Math.max(1, (width + 3) >> 2)
  const blocksY = Math.max(1, (height + 3) >> 2)
  const blockBytes = kind === 'bc1' ? 8 : 16
  const pal = new Uint8Array(16)
  const alpha = new Uint8Array(16)
  const alphaTable = new Uint8Array(8)
  let o = offset
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++, o += blockBytes) {
      let co = o
      if (kind === 'bc2') {
        for (let i = 0; i < 16; i++) {
          const byte = src[o + (i >> 1)]!
          alpha[i] = ((i & 1 ? byte >> 4 : byte) & 0xf) * 17
        }
        co = o + 8
      } else if (kind === 'bc3') {
        const a0 = src[o]!
        const a1 = src[o + 1]!
        alphaTable[0] = a0
        alphaTable[1] = a1
        if (a0 > a1) {
          for (let k = 1; k < 7; k++) alphaTable[k + 1] = Math.round(((7 - k) * a0 + k * a1) / 7)
        } else {
          for (let k = 1; k < 5; k++) alphaTable[k + 1] = Math.round(((5 - k) * a0 + k * a1) / 5)
          alphaTable[6] = 0
          alphaTable[7] = 255
        }
        const lo = src[o + 2]! | (src[o + 3]! << 8) | (src[o + 4]! << 16)
        const hi = src[o + 5]! | (src[o + 6]! << 8) | (src[o + 7]! << 16)
        for (let i = 0; i < 8; i++) alpha[i] = alphaTable[(lo >> (3 * i)) & 7]!
        for (let i = 0; i < 8; i++) alpha[i + 8] = alphaTable[(hi >> (3 * i)) & 7]!
        co = o + 8
      }
      colorPalette(src, co, pal, kind !== 'bc1')
      const indices = (src[co + 4]! | (src[co + 5]! << 8) | (src[co + 6]! << 16) | (src[co + 7]! << 24)) >>> 0
      const x0 = bx << 2
      const y0 = by << 2
      const rows = Math.min(4, height - y0)
      const cols = Math.min(4, width - x0)
      for (let py = 0; py < rows; py++) {
        let d = ((y0 + py) * width + x0) * 4
        for (let px = 0; px < cols; px++, d += 4) {
          const i = py * 4 + px
          const p = ((indices >>> (2 * i)) & 3) * 4
          out[d] = pal[p]!
          out[d + 1] = pal[p + 1]!
          out[d + 2] = pal[p + 2]!
          out[d + 3] = kind === 'bc1' ? pal[p + 3]! : alpha[i]!
        }
      }
    }
  }
}

function unpremultiply(rgba: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!
    if (a === 0 || a === 255) continue
    rgba[i] = Math.min(255, Math.round((rgba[i]! * 255) / a))
    rgba[i + 1] = Math.min(255, Math.round((rgba[i + 1]! * 255) / a))
    rgba[i + 2] = Math.min(255, Math.round((rgba[i + 2]! * 255) / a))
  }
}

interface Channel {
  mask: number
  shift: number
  max: number
}

function channel(mask: number): Channel {
  if (mask === 0) return { mask: 0, shift: 0, max: 0 }
  const shift = 31 - Math.clz32(mask & -mask)
  return { mask, shift, max: mask >>> shift }
}

function scale(v: number, c: Channel): number {
  return c.max === 255 ? v : Math.round((v * 255) / c.max)
}

/** Bit-mask formats: DDPF_RGB, DDPF_LUMINANCE, DDPF_ALPHA. Missing color channels read 0, missing alpha 255. */
function decodeMasked(
  src: Uint8Array,
  offset: number,
  width: number,
  height: number,
  info: Extract<FormatInfo, { kind: 'mask' }>,
  out: Uint8Array,
): void {
  const bytesPerPixel = info.bits >> 3
  const rowBytes = width * bytesPerPixel
  const r = channel(info.r)
  const g = channel(info.g)
  const b = channel(info.b)
  const a = channel(info.a)
  let d = 0
  for (let y = 0; y < height; y++) {
    let s = offset + y * rowBytes
    for (let x = 0; x < width; x++, s += bytesPerPixel, d += 4) {
      let v: number
      switch (bytesPerPixel) {
        case 1:
          v = src[s]!
          break
        case 2:
          v = src[s]! | (src[s + 1]! << 8)
          break
        case 3:
          v = src[s]! | (src[s + 1]! << 8) | (src[s + 2]! << 16)
          break
        default:
          v = (src[s]! | (src[s + 1]! << 8) | (src[s + 2]! << 16) | (src[s + 3]! << 24)) >>> 0
      }
      out[d] = r.max ? scale((v & r.mask) >>> r.shift, r) : 0
      out[d + 1] = g.max ? scale((v & g.mask) >>> g.shift, g) : 0
      out[d + 2] = b.max ? scale((v & b.mask) >>> b.shift, b) : 0
      out[d + 3] = a.max ? scale((v & a.mask) >>> a.shift, a) : 255
    }
  }
}

function decodePalettized(src: Uint8Array, offset: number, width: number, height: number, alpha: boolean, out: Uint8Array): void {
  const palette = offset - P8_PALETTE_SIZE
  const count = width * height
  for (let i = 0, d = 0; i < count; i++, d += 4) {
    const p = palette + src[offset + i]! * 4
    out[d] = src[p]!
    out[d + 1] = src[p + 1]!
    out[d + 2] = src[p + 2]!
    out[d + 3] = alpha ? src[p + 3]! : 255
  }
}
