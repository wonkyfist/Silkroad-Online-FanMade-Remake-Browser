/**
 * One texture atlas per townsfolk variant (docs/TOWN_LIFE.md §3.2, §9.1; WAVE_PLAN7 §6.1 lane TL-V): every texture a
 * dressed variant uses (the body's, the hair's, each garment's) packed into one image, so the variant is one material
 * and one draw. 1024 × 512 is tried before 1024 × 1024 (the retail body texture is 512 × 256), and the budget is one
 * atlas ≤ 1024² per variant (WAVE_PLAN7 §5.3).
 *
 * Each source becomes a rectangle cropped to the UV box its primitives use, plus a gutter of GUTTER texels on every
 * side, filled with the source repeated (glTF's default REPEAT wrap): bilinear sampling at the rectangle's border
 * reads what REPEAT would have read, a primitive whose UVs run past 1 (the women's `clothes_03_la` reaches u 1.086)
 * maps onto the repeated texels instead of a neighbour, and the first mips stay clean. A source drawn OPAQUE gets
 * alpha 255 in its rectangle, so the merged material can alpha-test (MASK) the hair without cutting the clothes.
 *
 * The packer and the rasteriser are pure (tests); `decodeImage` / `encodePng` are the sharp I/O.
 */
import sharp from 'sharp'

/** Texels of repeated source around each rectangle (clean bilinear to mip 2). */
export const GUTTER = 4

/** Atlas sizes tried smallest first (width ≥ height); the budget is 1024² (WAVE_PLAN7 §5.3 TL-V). */
export const ATLAS_SIZES: ReadonlyArray<readonly [number, number]> = [
  [128, 128], [256, 128], [256, 256], [512, 256], [512, 512], [1024, 512], [1024, 1024],
]

/** A decoded RGBA image. */
export interface RgbaImage {
  width: number
  height: number
  /** width × height × 4 bytes, rows top to bottom (glTF UV v = 0 is the top row). */
  data: Uint8Array
}

/** One texture of a variant, with the UV box (union over the primitives that sample it) it must cover. */
export interface AtlasSource {
  key: string
  image: RgbaImage
  /** The material draws it OPAQUE: alpha becomes 255 in the atlas. */
  opaque: boolean
  /** [uMin, vMin, uMax, vMax] in the source's UV space (may leave 0..1: the source repeats). */
  uv: readonly [number, number, number, number]
}

/** Where a source landed: its rectangle in atlas texels and the source texel at the rectangle's corner. */
export interface AtlasPlacement {
  key: string
  /** Rectangle in the atlas (texels). */
  x: number
  y: number
  w: number
  h: number
  /** The source texel (unwrapped, may be negative or past the size) drawn at the rectangle's top-left texel. */
  sx: number
  sy: number
  /** Source size. */
  sw: number
  sh: number
}

export interface Atlas {
  width: number
  height: number
  placements: Map<string, AtlasPlacement>
  image: RgbaImage
}

/**
 * A source's rectangle on one axis: its UV range in texels, rounded out, plus the gutter; a range inside 0..1 whose
 * gutter would make it longer than the source is the source itself (one exact tile: a 512-texel body stays 512, and
 * its UVs keep half a texel or more from the edges).
 */
function axisRange(a0: number, a1: number, size: number): [number, number] {
  const s = Math.floor(a0 * size + 1e-6) - GUTTER
  const e = Math.ceil(a1 * size - 1e-6) + GUTTER
  if (e - s > size && a0 >= -1e-4 && a1 <= 1 + 1e-4) return [0, size]
  return [s, Math.max(s + 1, e)]
}

/** A source's rectangle: its UV box in texels plus the gutter (axisRange), and the source texel at its corner. */
export function sourceRect(s: AtlasSource): { sx: number, sy: number, w: number, h: number } {
  const { width: sw, height: sh } = s.image
  const [u0, v0, u1, v1] = s.uv
  const [sx, ex] = axisRange(u0, u1, sw)
  const [sy, ey] = axisRange(v0, v1, sh)
  return { sx, sy, w: ex - sx, h: ey - sy }
}

/**
 * Shelf packing (tallest first) of `rects` into a width × height atlas; null when they do not fit. Deterministic: ties
 * keep the input order.
 */
export function packShelves(rects: ReadonlyArray<{ key: string, w: number, h: number }>, width: number, height: number): Map<string, { x: number, y: number }> | null {
  const order = rects.map((r, i) => ({ r, i })).sort((a, b) => b.r.h - a.r.h || b.r.w - a.r.w || a.i - b.i)
  const out = new Map<string, { x: number, y: number }>()
  let shelfY = 0
  let shelfH = 0
  let x = 0
  for (const { r } of order) {
    if (r.w > width || r.h > height) return null
    if (x + r.w > width) {
      shelfY += shelfH
      shelfH = 0
      x = 0
    }
    if (shelfY + r.h > height) return null
    out.set(r.key, { x, y: shelfY })
    x += r.w
    shelfH = Math.max(shelfH, r.h)
  }
  return out
}

const mod = (a: number, n: number) => ((a % n) + n) % n

/**
 * Packs `sources` into the smallest atlas of ATLAS_SIZES that holds them (null: none does, the variant is over the
 * budget) and rasterises it: each rectangle is its source repeated from (sx, sy), alpha 255 for opaque sources; the
 * unused texels are transparent black.
 */
export function buildAtlas(sources: readonly AtlasSource[], sizes: ReadonlyArray<readonly [number, number]> = ATLAS_SIZES): Atlas | null {
  const rects = sources.map(s => ({ key: s.key, ...sourceRect(s) }))
  for (const [width, height] of sizes) {
    const at = packShelves(rects, width, height)
    if (!at) continue
    const data = new Uint8Array(width * height * 4)
    const placements = new Map<string, AtlasPlacement>()
    sources.forEach((s, i) => {
      const r = rects[i]!
      const p = at.get(s.key)!
      const { width: sw, height: sh, data: src } = s.image
      for (let y = 0; y < r.h; y++) {
        const syy = mod(r.sy + y, sh)
        let o = ((p.y + y) * width + p.x) * 4
        for (let x = 0; x < r.w; x++, o += 4) {
          const i4 = (syy * sw + mod(r.sx + x, sw)) * 4
          data[o] = src[i4]!
          data[o + 1] = src[i4 + 1]!
          data[o + 2] = src[i4 + 2]!
          data[o + 3] = s.opaque ? 255 : src[i4 + 3]!
        }
      }
      placements.set(s.key, { key: s.key, x: p.x, y: p.y, w: r.w, h: r.h, sx: r.sx, sy: r.sy, sw, sh })
    })
    return { width, height, placements, image: { width, height, data } }
  }
  return null
}

/** A source UV → the atlas UV (the same texel, read through the rectangle). */
export function atlasUv(p: AtlasPlacement, atlasW: number, atlasH: number, u: number, v: number): [number, number] {
  return [(p.x + u * p.sw - p.sx) / atlasW, (p.y + v * p.sh - p.sy) / atlasH]
}

/** Decodes a PNG / JPEG / WebP to RGBA. */
export async function decodeImage(bytes: Uint8Array): Promise<RgbaImage> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}

/** Encodes RGBA as PNG (lossless; optimize-out re-encodes the shipped copy). */
export async function encodePng(img: RgbaImage): Promise<Uint8Array> {
  const buf = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer()
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}
