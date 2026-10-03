/**
 * World map overview image (docs/FIELDS.md §5.3): the client minimap tiles of an export stitched north-up at
 * WORLD_MAP_PX pixels per region, described by manifest.stream.worldMap (./manifest.ts WorldStream).
 *
 * Tiles are Media minimap/<x>x<z>.ddj (256 x 256, north-up: row 0 = the region's north edge), decoded by the caller.
 * Each is box-filtered down to WORLD_MAP_PX (a 4 x 4 box for 256 -> 64) and pasted with pixel (0, 0) = the north-west
 * corner of region (x0, z1). Regions without a tile (inactive in mapinfo.mfo, or no minimap file) are WORLD_MAP_FILL,
 * or the caller's fill: an export with a coast passes manifest.coast.mapColor, so the open sea beyond the emitted
 * regions reads as sea (docs/COAST.md §11; ./coast/minimap.ts). The alpha channel is opaque everywhere.
 * Pure (no node:*): the caller reads the archive and writes the PNG.
 */

export const WORLD_MAP_FILE = 'worldmap.png'
export const WORLD_MAP_PX = 64
/** #202225, the fill of regions without a tile. */
export const WORLD_MAP_FILL = [0x20, 0x22, 0x25] as const

/** An RGB fill (0..255 per channel). */
export type MapFill = readonly [number, number, number]

/** '#rrggbb' (e.g. manifest.coast.mapColor) as an RGB fill; throws on anything else. */
export function hexFill(hex: string): MapFill {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`expected '#rrggbb', got '${hex}'`)
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

export interface RgbaImage {
  width: number
  height: number
  rgba: Uint8Array
}

export interface WorldMapRect {
  x0: number
  x1: number
  z0: number
  z1: number
}

/**
 * Box filter of an RGBA image down to `size` x `size`. The source must be square with a side that is a whole
 * multiple of `size` (256 -> 64 averages 4 x 4 blocks); other sides fall back to nearest-sample boxes.
 */
export function boxDownsample(img: RgbaImage, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  for (let oy = 0; oy < size; oy++) {
    const sy0 = Math.floor((oy * img.height) / size)
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * img.height) / size))
    for (let ox = 0; ox < size; ox++) {
      const sx0 = Math.floor((ox * img.width) / size)
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * img.width) / size))
      let r = 0, g = 0, b = 0, n = 0
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * img.width + x) * 4
          r += img.rgba[i]!
          g += img.rgba[i + 1]!
          b += img.rgba[i + 2]!
          n++
        }
      }
      const o = (oy * size + ox) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = 255
    }
  }
  return out
}

/**
 * The stitched map of `rect` (inclusive region range). `tile(x, z)` returns the decoded minimap tile of a region or
 * null; regions without one are `fill` (default WORLD_MAP_FILL). Returns the image and how many regions had a tile.
 */
export function stitchWorldMap(rect: WorldMapRect, tile: (x: number, z: number) => RgbaImage | null, px = WORLD_MAP_PX,
  fill: MapFill = WORLD_MAP_FILL): RgbaImage & { tiles: number } {
  const cols = rect.x1 - rect.x0 + 1
  const rows = rect.z1 - rect.z0 + 1
  const width = cols * px
  const height = rows * px
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = fill[0]
    rgba[i + 1] = fill[1]
    rgba[i + 2] = fill[2]
    rgba[i + 3] = 255
  }
  let tiles = 0
  for (let z = rect.z0; z <= rect.z1; z++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const img = tile(x, z)
      if (!img) continue
      tiles++
      const small = boxDownsample(img, px)
      const left = (x - rect.x0) * px
      const top = (rect.z1 - z) * px
      for (let y = 0; y < px; y++) rgba.set(small.subarray(y * px * 4, (y + 1) * px * 4), ((top + y) * width + left) * 4)
    }
  }
  return { width, height, rgba, tiles }
}
