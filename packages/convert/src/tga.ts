/**
 * TGA decoder (Truevision TGA 2.0 spec): uncompressed (type 2) and run-length (type 10) true-colour images,
 * 24 or 32 bits per pixel, and 8-bit greyscale (types 3 / 11). The image origin comes from the image
 * descriptor: bit 5 set = top-down rows, clear = bottom-up (the TGA default); bit 4 set = right-to-left.
 * The client's one cursor, Media/cursor/cursor_normal1.tga, is type 2, 32-bit, descriptor 0x08
 * (8 alpha bits, bottom-up), so its rows must be flipped (docs/UI.md §2.8).
 */
export interface TgaImage {
  width: number
  height: number
  /** Top-down RGBA8. */
  rgba: Uint8Array
}

export function decodeTga(bytes: Uint8Array): TgaImage {
  if (bytes.length < 18) throw new Error('tga: truncated header')
  const idLength = bytes[0]!
  const colorMapType = bytes[1]!
  const type = bytes[2]!
  const mapLength = bytes[5]! | (bytes[6]! << 8)
  const mapEntryBits = bytes[7]!
  const width = bytes[12]! | (bytes[13]! << 8)
  const height = bytes[14]! | (bytes[15]! << 8)
  const bpp = bytes[16]!
  const desc = bytes[17]!
  const grey = type === 3 || type === 11
  const rle = type === 10 || type === 11
  if (type !== 2 && type !== 3 && type !== 10 && type !== 11) throw new Error(`tga: unsupported image type ${type}`)
  if (grey ? bpp !== 8 : bpp !== 24 && bpp !== 32) throw new Error(`tga: unsupported ${bpp} bits per pixel for type ${type}`)
  if (width === 0 || height === 0) throw new Error('tga: empty image')
  const alphaBits = desc & 0x0f
  const topDown = (desc & 0x20) !== 0
  const rightToLeft = (desc & 0x10) !== 0
  const size = bpp / 8
  let p = 18 + idLength + (colorMapType ? Math.ceil((mapLength * mapEntryBits) / 8) : 0)

  // Pixels in file order, as RGBA.
  const n = width * height
  const src = new Uint8Array(n * 4)
  const put = (i: number, at: number): void => {
    if (at + size > bytes.length) throw new Error('tga: truncated pixel data')
    const o = i * 4
    if (grey) {
      src[o] = src[o + 1] = src[o + 2] = bytes[at]!
      src[o + 3] = 255
    } else {
      src[o] = bytes[at + 2]!
      src[o + 1] = bytes[at + 1]!
      src[o + 2] = bytes[at]!
      src[o + 3] = size === 4 && alphaBits > 0 ? bytes[at + 3]! : 255
    }
  }
  if (!rle) {
    for (let i = 0; i < n; i++, p += size) put(i, p)
  } else {
    let i = 0
    while (i < n) {
      if (p >= bytes.length) throw new Error('tga: truncated RLE data')
      const h = bytes[p++]!
      const count = (h & 0x7f) + 1
      if (h & 0x80) {
        for (let k = 0; k < count && i < n; k++) put(i++, p)
        p += size
      } else {
        for (let k = 0; k < count && i < n; k++, p += size) put(i++, p)
      }
    }
  }

  const rgba = new Uint8Array(n * 4)
  for (let y = 0; y < height; y++) {
    const sy = topDown ? y : height - 1 - y
    for (let x = 0; x < width; x++) {
      const sx = rightToLeft ? width - 1 - x : x
      const s = (sy * width + sx) * 4
      rgba.set(src.subarray(s, s + 4), (y * width + x) * 4)
    }
  }
  return { width, height, rgba }
}
