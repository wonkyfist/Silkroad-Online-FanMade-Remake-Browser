/**
 * The layer PNGs (docs/WORLD_EDITOR.md §3.1): a small codec on node:zlib, so the editor API needs no image library.
 * Writes grey 8 (walk), grey + alpha 16 (height, LA16) and RGBA 8 (paint, grass), non-interlaced, one IDAT, each row
 * filtered with the cheapest of None / Sub / Up / Paeth (the spec's sum-of-absolute-bytes heuristic). Reads any
 * non-interlaced grey, grey + alpha, RGB or RGBA PNG at 8 or 16 bits (what sharp, the converter's reader and writer,
 * produces); 16-bit samples are big-endian in the file and native numbers in the arrays.
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const COLOUR_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }
const CHANNEL_COLOUR: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

export interface PngImage {
  width: number
  height: number
  channels: 1 | 2 | 3 | 4
  depth: 8 | 16
  /** Row-major, channel-interleaved samples (Uint16Array at depth 16). */
  data: Uint8Array | Uint16Array
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function encodePng(img: PngImage): Buffer {
  const { width, height, channels, depth, data } = img
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new RangeError(`PNG: invalid size ${width}x${height}`)
  if (data.length !== width * height * channels) throw new RangeError(`PNG: expected ${width * height * channels} samples, got ${data.length}`)
  const bpp = channels * (depth / 8)
  const stride = width * bpp
  // Raw big-endian scanlines.
  const raw = new Uint8Array(stride * height)
  if (depth === 16) {
    for (let i = 0; i < data.length; i++) {
      raw[i * 2] = data[i]! >> 8
      raw[i * 2 + 1] = data[i]! & 0xff
    }
  } else raw.set(data as Uint8Array)
  const out = new Uint8Array((stride + 1) * height)
  const cand = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null
    let best = -1
    let bestSum = Infinity
    for (const f of [0, 1, 2, 4]) {
      let sum = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0
        const b = up ? up[i]! : 0
        const c = up && i >= bpp ? up[i - bpp]! : 0
        const v = (row[i]! - (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : paeth(a, b, c))) & 0xff
        sum += v < 128 ? v : 256 - v
      }
      if (sum < bestSum) {
        bestSum = sum
        best = f
      }
    }
    const o = y * (stride + 1)
    out[o] = best
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0
      const b = up ? up[i]! : 0
      const c = up && i >= bpp ? up[i - bpp]! : 0
      cand[i] = (row[i]! - (best === 0 ? 0 : best === 1 ? a : best === 2 ? b : paeth(a, b, c))) & 0xff
    }
    out.set(cand, o + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = depth
  ihdr[9] = CHANNEL_COLOUR[channels]!
  // compression 0, filter 0, interlace 0
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', new Uint8Array(0))])
}

export function decodePng(buf: Uint8Array): PngImage {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.length < 8 || !b.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG: not a PNG file')
  let p = 8
  let width = 0
  let height = 0
  let depth = 0
  let colour = -1
  const idat: Buffer[] = []
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p)
    const type = b.toString('latin1', p + 4, p + 8)
    if (p + 12 + len > b.length) throw new Error('PNG: truncated chunk')
    const data = b.subarray(p + 8, p + 8 + len)
    if (b.readUInt32BE(p + 8 + len) !== crc32(b.subarray(p + 4, p + 8 + len))) throw new Error(`PNG: bad CRC in ${type}`)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]!
      colour = data[9]!
      if (data[12] !== 0) throw new Error('PNG: interlaced files are not supported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const channels = COLOUR_CHANNELS[colour]
  if (!channels) throw new Error(`PNG: colour type ${colour} is not supported (grey, grey + alpha, RGB, RGBA only)`)
  if (depth !== 8 && depth !== 16) throw new Error(`PNG: bit depth ${depth} is not supported (8 or 16 only)`)
  if (!width || !height || !idat.length) throw new Error('PNG: missing header or image data')
  const bpp = channels * (depth / 8)
  const stride = width * bpp
  const inflated = inflateSync(Buffer.concat(idat))
  if (inflated.length < (stride + 1) * height) throw new Error('PNG: image data too short')
  const raw = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = inflated[y * (stride + 1)]!
    const src = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = raw.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0
      const bb = up ? up[i]! : 0
      const c = up && i >= bpp ? up[i - bpp]! : 0
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? bb : f === 3 ? (a + bb) >> 1 : f === 4 ? paeth(a, bb, c) : -1
      if (pred < 0) throw new Error(`PNG: bad filter ${f}`)
      row[i] = (src[i]! + pred) & 0xff
    }
  }
  const n = width * height * channels
  if (depth === 8) return { width, height, channels: channels as PngImage['channels'], depth: 8, data: raw }
  const data = new Uint16Array(n)
  for (let i = 0; i < n; i++) data[i] = (raw[i * 2]! << 8) | raw[i * 2 + 1]!
  return { width, height, channels: channels as PngImage['channels'], depth: 16, data }
}
