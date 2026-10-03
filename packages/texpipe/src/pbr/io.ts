/**
 * TP-P file I/O (Node only): images in and out of the float `Img`, and the master layout.
 *
 * Masters are 16-bit PNG where precision matters (TEXPIPE §2): the normal (RGB) and ORMH (RGBA, A = height). The
 * albedo stays 8-bit (its source is 8-bit DXT; de-lighting only rescales it), previews and masks are 8-bit. sharp
 * 0.35 ignores a 16-bit *raw input* (it reads the bytes as 8-bit), so 16-bit PNGs are written by `encodePng` here
 * (zlib from node:zlib, per-row adaptive filters) and read back through sharp, which decodes them fine.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import sharp from 'sharp'
import { img, type Img } from './image.ts'

/** Reads any image sharp can read into an RGBA float image (0..1, sRGB as stored). */
export async function readImage(input: string | Uint8Array): Promise<Img> {
  const s = typeof input === 'string' ? sharp(input) : sharp(Buffer.from(input.buffer, input.byteOffset, input.byteLength))
  const meta = await s.metadata()
  const sixteen = meta.depth === 'ushort' || meta.depth === 'short'
  // A 16-bit PNG must be asked for as rgb16: `raw({ depth: 'ushort' })` alone returns 8-bit values in 16-bit words.
  const s16 = sixteen ? s.toColourspace('rgb16') : s
  const { data, info } = await s16.ensureAlpha().raw(sixteen ? { depth: 'ushort' } : undefined).toBuffer({ resolveWithObject: true })
  const o = img(info.width, info.height, 4)
  const n = info.width * info.height * 4
  if (sixteen) for (let i = 0; i < n; i++) o.d[i] = data.readUInt16LE(i * 2) / 65535
  else for (let i = 0; i < n; i++) o.d[i] = data[i]! / 255
  return o
}

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const COLOR_TYPE: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 }

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * Encodes channels `ks` of a float image (0..1, clamped) as a PNG of `bits` 8 or 16 per sample, greyscale (1 channel),
 * grey+alpha (2), RGB (3) or RGBA (4). Each row takes the filter (None, Sub, Up, Average, Paeth) with the smallest
 * sum of absolute byte differences, the usual heuristic.
 */
export function encodePng(im: Img, bits: 8 | 16 = 16, ks?: readonly number[]): Uint8Array {
  const chans = ks ?? Array.from({ length: im.c }, (_, i) => i)
  const c = chans.length
  if (COLOR_TYPE[c] === undefined) throw new Error(`encodePng: ${c} channels`)
  const bpp = c * (bits / 8)
  const stride = im.w * bpp
  const raw = new Uint8Array(im.h * stride)
  const max = bits === 16 ? 65535 : 255
  for (let y = 0; y < im.h; y++) {
    for (let x = 0; x < im.w; x++) {
      for (let j = 0; j < c; j++) {
        const v = Math.round(Math.max(0, Math.min(1, im.d[(y * im.w + x) * im.c + chans[j]!]!)) * max)
        const o = y * stride + x * bpp + j * (bits / 8)
        if (bits === 16) {
          raw[o] = v >> 8
          raw[o + 1] = v & 255
        } else raw[o] = v
      }
    }
  }
  const filtered = new Uint8Array(im.h * (stride + 1))
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride))
  for (let y = 0; y < im.h; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null
    let best = 0, bestSum = Infinity
    for (let f = 0; f < 5; f++) {
      const out = cand[f]!
      let sum = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0, b = up ? up[i]! : 0, cc = up && i >= bpp ? up[i - bpp]! : 0
        let pred = 0
        if (f === 1) pred = a
        else if (f === 2) pred = b
        else if (f === 3) pred = (a + b) >> 1
        else if (f === 4) {
          const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc)
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc
        }
        const v = (row[i]! - pred) & 255
        out[i] = v
        sum += v < 128 ? v : 256 - v
      }
      if (sum < bestSum) {
        bestSum = sum
        best = f
      }
    }
    filtered[y * (stride + 1)] = best
    filtered.set(cand[best]!, y * (stride + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, im.w)
  dv.setUint32(4, im.h)
  ihdr[8] = bits
  ihdr[9] = COLOR_TYPE[c]!
  const parts = [PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(filtered, { level: 6 })), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Writes a PNG (creating the folder); returns its size in bytes. */
export function writePng(path: string, im: Img, bits: 8 | 16 = 16, ks?: readonly number[]): number {
  const png = encodePng(im, bits, ks)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, png)
  return png.length
}

/** A one-channel byte image (a class mask, a cluster map) as an 8-bit grey PNG. */
export function writeBytesPng(path: string, bytes: Uint8Array, w: number, h: number): number {
  const im = img(w, h, 1)
  for (let p = 0; p < w * h; p++) im.d[p] = bytes[p]! / 255
  return writePng(path, im, 8)
}
