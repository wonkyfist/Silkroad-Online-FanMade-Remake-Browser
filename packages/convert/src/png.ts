/**
 * Minimal PNG writer (W3C PNG spec / RFC 2083): 8-bit RGBA, non-interlaced, IHDR + one IDAT + IEND.
 * Each row is filtered with None or Up, whichever has the smaller sum of absolute (signed) bytes,
 * the spec's recommended heuristic restricted to two filters.
 */
import { deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return ~c >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`PNG: invalid size ${width}x${height}`)
  }
  const stride = width * 4
  if (rgba.length !== stride * height) {
    throw new RangeError(`PNG: expected ${stride * height} RGBA bytes for ${width}x${height}, got ${rgba.length}`)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // compression 0, filter method 0, interlace 0

  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride)
    const dst = y * (stride + 1)
    let none = 0
    let up = 0
    if (y > 0) {
      const prev = rgba.subarray((y - 1) * stride, y * stride)
      for (let i = 0; i < stride; i++) {
        const v = row[i]!
        none += v < 128 ? v : 256 - v
        const d = (v - prev[i]!) & 0xff
        up += d < 128 ? d : 256 - d
      }
    }
    if (y > 0 && up < none) {
      const prev = rgba.subarray((y - 1) * stride, y * stride)
      raw[dst] = 2
      for (let i = 0; i < stride; i++) raw[dst + 1 + i] = (row[i]! - prev[i]!) & 0xff
    } else {
      raw[dst] = 0
      raw.set(row, dst + 1)
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ])
}
