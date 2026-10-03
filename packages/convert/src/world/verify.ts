/**
 * Verification helpers for the world output (packages/convert/test/verify-world.test.ts): a PNG reader for our own
 * output, grey images with the 8 dihedral transforms and normalized cross-correlation, and a top-down software
 * rasterizer that draws glTF-space triangles into a north-up image (row 0 = north = glTF -Z, column 0 = west).
 *
 * Nothing here knows the Silkroad file layout. The renderer only reads the converted output (manifest transforms,
 * terrain bins, glbs), so a render that matches the client's own minimap tiles is independent evidence that the
 * output is oriented, placed and scaled like the client.
 */
import { inflateSync } from 'node:zlib'

export interface Rgba {
  width: number
  height: number
  rgba: Uint8Array
}

/** Minimal PNG reader: 8-bit RGBA or RGB, non-interlaced, all five filters. */
export function decodePng(buf: Uint8Array): Rgba {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat: Uint8Array[] = []
  while (o < buf.length) {
    const len = dv.getUint32(o)
    const type = String.fromCharCode(...buf.subarray(o + 4, o + 8))
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8)
      height = dv.getUint32(o + 12)
      const colourType = buf[o + 17]
      if (buf[o + 16] !== 8 || (colourType !== 6 && colourType !== 2) || buf[o + 20] !== 0) {
        throw new Error(`decodePng: unsupported format (depth ${buf[o + 16]}, colour ${colourType}, interlace ${buf[o + 20]}) at offset ${o + 16}`)
      }
      channels = colourType === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0))
  let p = 0
  for (const c of idat) {
    joined.set(c, p)
    p += c.length
  }
  const raw = inflateSync(joined)
  const s = width * channels
  const px = new Uint8Array(s * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (s + 1)]!
    for (let i = 0; i < s; i++) {
      const x = raw[y * (s + 1) + 1 + i]!
      const a = i >= channels ? px[y * s + i - channels]! : 0
      const b = y ? px[(y - 1) * s + i]! : 0
      const c = i >= channels && y ? px[(y - 1) * s + i - channels]! : 0
      let pred = 0
      if (f === 1) pred = a
      else if (f === 2) pred = b
      else if (f === 3) pred = (a + b) >> 1
      else if (f === 4) {
        const q = a + b - c
        const pa = Math.abs(q - a)
        const pb = Math.abs(q - b)
        const pc = Math.abs(q - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * s + i] = (x + pred) & 0xff
    }
  }
  if (channels === 4) return { width, height, rgba: px }
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = px[i * 3]!
    rgba[i * 4 + 1] = px[i * 3 + 1]!
    rgba[i * 4 + 2] = px[i * 3 + 2]!
    rgba[i * 4 + 3] = 255
  }
  return { width, height, rgba }
}

// --- grey images ----------------------------------------------------------------------------------------------------

export interface Gray {
  width: number
  height: number
  data: Float32Array
}

export const gray = (width: number, height: number): Gray => ({ width, height, data: new Float32Array(width * height) })

/** Rec. 601 luma of an RGBA image (0..255). */
export function luminance(img: Rgba): Gray {
  const out = gray(img.width, img.height)
  for (let i = 0; i < img.width * img.height; i++) {
    out.data[i] = 0.299 * img.rgba[i * 4]! + 0.587 * img.rgba[i * 4 + 1]! + 0.114 * img.rgba[i * 4 + 2]!
  }
  return out
}

/**
 * The 8 symmetries of the square. dihedral(img, k) returns the image seen through transform k: out(c, r) = img(src),
 * with (sc, sr) as listed (n = size - 1). k = 0 is the identity.
 */
export const DIHEDRAL: ReadonlyArray<{ name: string; src: (c: number, r: number, n: number) => [number, number] }> = [
  { name: 'identity', src: (c, r) => [c, r] },
  { name: 'rot90', src: (c, r, n) => [r, n - c] },
  { name: 'rot180', src: (c, r, n) => [n - c, n - r] },
  { name: 'rot270', src: (c, r, n) => [n - r, c] },
  { name: 'flipEW', src: (c, r, n) => [n - c, r] },
  { name: 'flipNS', src: (c, r, n) => [c, n - r] },
  { name: 'transpose', src: (c, r) => [r, c] },
  { name: 'antiTranspose', src: (c, r, n) => [n - r, n - c] },
]

export function dihedral(img: Gray, k: number): Gray {
  if (img.width !== img.height) throw new Error('dihedral: square images only')
  const n = img.width - 1
  const out = gray(img.width, img.height)
  const f = DIHEDRAL[k]!.src
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c <= n; c++) {
      const [sc, sr] = f(c, r, n)
      out.data[r * img.width + c] = img.data[sr * img.width + sc]!
    }
  }
  return out
}

/** Pearson correlation of two equally sized images, optionally only where mask != 0. NaN when either is flat. */
export function ncc(a: Gray, b: Gray, mask?: Uint8Array): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('ncc: size mismatch')
  let n = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < a.data.length; i++) {
    if (mask && !mask[i]) continue
    n++
    sa += a.data[i]!
    sb += b.data[i]!
  }
  const ma = sa / n
  const mb = sb / n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < a.data.length; i++) {
    if (mask && !mask[i]) continue
    const da = a.data[i]! - ma
    const db = b.data[i]! - mb
    sab += da * db
    saa += da * da
    sbb += db * db
  }
  return sab / Math.sqrt(saa * sbb)
}

/** Separable box blur of radius r (window 2r + 1), clamped at the borders. */
export function boxBlur(img: Gray, r: number): Gray {
  const { width: w, height: h } = img
  const tmp = new Float32Array(w * h)
  const out = gray(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let d = -r; d <= r; d++) s += img.data[y * w + Math.min(w - 1, Math.max(0, x + d))]!
      tmp[y * w + x] = s / (2 * r + 1)
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let d = -r; d <= r; d++) s += tmp[Math.min(h - 1, Math.max(0, y + d)) * w + x]!
      out.data[y * w + x] = s / (2 * r + 1)
    }
  }
  return out
}

/** Gradient magnitude (central differences), i.e. an edge image. */
export function gradient(img: Gray): Gray {
  const { width: w, height: h } = img
  const out = gray(w, h)
  const at = (x: number, y: number) => img.data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out.data[y * w + x] = Math.hypot(at(x + 1, y) - at(x - 1, y), at(x, y + 1) - at(x, y - 1))
  }
  return out
}

export function crop(img: Gray, x0: number, y0: number, w: number, h: number): Gray {
  const out = gray(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out.data[y * w + x] = img.data[(y0 + y) * img.width + x0 + x]!
  }
  return out
}

/** Correlations of `render` with the 8 dihedral transforms of `reference` (index = DIHEDRAL index). */
export function dihedralScores(render: Gray, reference: Gray, prep: (g: Gray) => Gray = g => g): number[] {
  const a = prep(render)
  return DIHEDRAL.map((_, k) => ncc(a, prep(dihedral(reference, k))))
}

// --- top-down rasterizer --------------------------------------------------------------------------------------------

export type Vec3 = [number, number, number]

/**
 * A north-up top-down image of glTF space: pixel (c, r) has its centre at glTF x = x0 + (c + 0.5) px and
 * z = z0 + (r + 0.5) px, so row 0 is the northern edge (most negative z) and column 0 the western edge. Each pixel
 * keeps the colour of the highest surface drawn into it.
 */
export class TopDown {
  readonly rgb: Float32Array
  readonly depth: Float32Array
  /** Id of the object that wrote the pixel, -1 for none. */
  readonly owner: Int32Array

  constructor(readonly width: number, readonly height: number, readonly x0: number, readonly z0: number, readonly px: number) {
    this.rgb = new Float32Array(width * height * 3)
    this.depth = new Float32Array(width * height).fill(-Infinity)
    this.owner = new Int32Array(width * height).fill(-1)
  }

  clone(): TopDown {
    const v = new TopDown(this.width, this.height, this.x0, this.z0, this.px)
    v.rgb.set(this.rgb)
    v.depth.set(this.depth)
    v.owner.set(this.owner)
    return v
  }

  /** Pixel centre in glTF metres. */
  centre(c: number, r: number): [x: number, z: number] {
    return [this.x0 + (c + 0.5) * this.px, this.z0 + (r + 0.5) * this.px]
  }

  set(i: number, rgb: readonly number[], y: number, owner = -1): void {
    this.rgb[i * 3] = rgb[0]!
    this.rgb[i * 3 + 1] = rgb[1]!
    this.rgb[i * 3 + 2] = rgb[2]!
    this.depth[i] = y
    this.owner[i] = owner
  }

  /**
   * Draws one triangle (glTF positions). `shade(w0, w1, w2)` returns the RGB at those barycentrics, or null for a
   * transparent texel. Pixels whose centre is inside the triangle and whose interpolated y is above the stored depth
   * are written.
   */
  triangle(a: Vec3, b: Vec3, c: Vec3, shade: (w0: number, w1: number, w2: number) => readonly number[] | null, owner = -1): void {
    const ax = (a[0] - this.x0) / this.px - 0.5
    const ar = (a[2] - this.z0) / this.px - 0.5
    const bx = (b[0] - this.x0) / this.px - 0.5
    const br = (b[2] - this.z0) / this.px - 0.5
    const cx = (c[0] - this.x0) / this.px - 0.5
    const cr = (c[2] - this.z0) / this.px - 0.5
    const area = (bx - ax) * (cr - ar) - (br - ar) * (cx - ax)
    if (Math.abs(area) < 1e-12) return
    const c0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)))
    const c1 = Math.min(this.width - 1, Math.floor(Math.max(ax, bx, cx)))
    const r0 = Math.max(0, Math.ceil(Math.min(ar, br, cr)))
    const r1 = Math.min(this.height - 1, Math.floor(Math.max(ar, br, cr)))
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const w0 = ((bx - col) * (cr - r) - (br - r) * (cx - col)) / area
        const w1 = ((cx - col) * (ar - r) - (cr - r) * (ax - col)) / area
        const w2 = 1 - w0 - w1
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue
        const y = w0 * a[1] + w1 * b[1] + w2 * c[1]
        const i = r * this.width + col
        if (y <= this.depth[i]!) continue
        const rgb = shade(w0, w1, w2)
        if (rgb) this.set(i, rgb, y, owner)
      }
    }
  }

  luminance(): Gray {
    const out = gray(this.width, this.height)
    for (let i = 0; i < out.data.length; i++) {
      out.data[i] = 0.299 * this.rgb[i * 3]! + 0.587 * this.rgb[i * 3 + 1]! + 0.114 * this.rgb[i * 3 + 2]!
    }
    return out
  }

  toRgba(): Uint8Array {
    const out = new Uint8Array(this.width * this.height * 4)
    for (let i = 0; i < this.width * this.height; i++) {
      for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.max(0, Math.min(255, Math.round(this.rgb[i * 3 + k]!)))
      out[i * 4 + 3] = 255
    }
    return out
  }
}

// --- small mat4 helpers (column-major, glTF) -----------------------------------------------------------------------

/** Column-major 4x4 from translation, rotation quaternion [x, y, z, w] and uniform scale 1. */
export function composeTR(t: readonly number[], q: readonly number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number]
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t[0]!, t[1]!, t[2]!, 1,
  ]
}

export function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number): Vec3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ]
}

/** Quantile of a numeric array (sorted copy), q in 0..1. */
export function quantile(values: readonly number[], q: number): number {
  if (!values.length) return NaN
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!
}
