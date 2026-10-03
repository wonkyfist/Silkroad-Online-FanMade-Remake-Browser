/**
 * Layer codecs (docs/WORLD_EDITOR.md §3.1, §F1): grids <-> the raw PNG pixels of the layer files, environment-neutral.
 * The PNG container itself is the caller's (sharp in the editor API and the converter: `.raw({ depth: 'ushort' })` for
 * LA16, which round-trips exactly [confirmed: work/tmp/world-editor/sharp16.mts]). Pixel rows run north first
 * (row 0 = north), the grids south first (index z * n + x): every codec flips the rows.
 */
import {
  WE_GRASS, WE_GRASS_DENSITY_ONE, WE_GRID, WE_HEIGHT_STEPS_PER_M, WE_HEIGHT_ZERO, WE_TILE_ID_MASK, WE_TILES,
  WE_TILING_MAX, WE_TILING_SHIFT, type GrassLayer, type HeightLayer, type PaintLayer, type WalkLayer,
} from './types.ts'

/** The delta's code: 32768 + round(dh * 256), clamped to 0..65535. */
export function heightDeltaCode(dh: number): number {
  const c = WE_HEIGHT_ZERO + Math.round(dh * WE_HEIGHT_STEPS_PER_M)
  return c < 0 ? 0 : c > 0xffff ? 0xffff : c
}

/** The code's delta (m): (L - 32768) / 256. Exact in float32. */
export const heightCodeDelta = (code: number) => (code - WE_HEIGHT_ZERO) / WE_HEIGHT_STEPS_PER_M

/** A delta snapped to the 1/256 m grid and the code's range (what the export will hold, bit for bit). */
export const snapHeightDelta = (dh: number) => heightCodeDelta(heightDeltaCode(dh))

/** An empty height layer (no vertex touched). */
export const emptyHeightLayer = (): HeightLayer => ({ delta: new Float32Array(WE_GRID * WE_GRID), mask: new Uint8Array(WE_GRID * WE_GRID) })

/** Snaps every delta in place (the editor does it at the end of each stroke); untouched vertices get 0. */
export function snapHeightLayer(layer: HeightLayer): HeightLayer {
  for (let i = 0; i < layer.delta.length; i++) layer.delta[i] = layer.mask[i] ? snapHeightDelta(layer.delta[i]!) : 0
  return layer
}

/** Height layer -> LA16 pixels (97 x 97 x 2, row 0 = north): L = the delta code, A = 65535 where touched. */
export function encodeHeightLayer(layer: HeightLayer): Uint16Array {
  checkLen('height layer', layer.delta.length, WE_GRID * WE_GRID)
  checkLen('height layer mask', layer.mask.length, WE_GRID * WE_GRID)
  const px = new Uint16Array(WE_GRID * WE_GRID * 2)
  for (let row = 0; row < WE_GRID; row++) {
    for (let x = 0; x < WE_GRID; x++) {
      const g = (WE_GRID - 1 - row) * WE_GRID + x
      const k = (row * WE_GRID + x) * 2
      const on = layer.mask[g] !== 0
      px[k] = on ? heightDeltaCode(layer.delta[g]!) : WE_HEIGHT_ZERO
      px[k + 1] = on ? 0xffff : 0
    }
  }
  return px
}

/** LA16 pixels -> height layer. Any non-zero alpha marks the vertex touched; an untouched vertex decodes to 0. */
export function decodeHeightLayer(px: ArrayLike<number>): HeightLayer {
  checkLen('height pixels', px.length, WE_GRID * WE_GRID * 2)
  const layer = emptyHeightLayer()
  for (let row = 0; row < WE_GRID; row++) {
    for (let x = 0; x < WE_GRID; x++) {
      const k = (row * WE_GRID + x) * 2
      if (!px[k + 1]) continue
      const g = (WE_GRID - 1 - row) * WE_GRID + x
      layer.mask[g] = 1
      layer.delta[g] = heightCodeDelta(px[k]!)
    }
  }
  return layer
}

/** The texture word of a tile id and a tiling code (bits 10-12 zero). */
export const paintWord = (tile: number, tiling: number) => ((tile & WE_TILE_ID_MASK) | ((tiling & WE_TILING_MAX) << WE_TILING_SHIFT)) & 0xffff
export const paintWordTile = (word: number) => word & WE_TILE_ID_MASK
export const paintWordTiling = (word: number) => (word >> WE_TILING_SHIFT) & WE_TILING_MAX

export const emptyPaintLayer = (): PaintLayer => ({ words: new Uint16Array(WE_GRID * WE_GRID), mask: new Uint8Array(WE_GRID * WE_GRID) })

/** Paint layer -> RGBA8 pixels (97 x 97 x 4): R = id & 0xff, G = (id >> 8) | tiling << 2, B = 0, A = 255 where painted. */
export function encodePaintLayer(layer: PaintLayer): Uint8Array {
  checkLen('paint layer', layer.words.length, WE_GRID * WE_GRID)
  checkLen('paint layer mask', layer.mask.length, WE_GRID * WE_GRID)
  const px = new Uint8Array(WE_GRID * WE_GRID * 4)
  for (let row = 0; row < WE_GRID; row++) {
    for (let x = 0; x < WE_GRID; x++) {
      const g = (WE_GRID - 1 - row) * WE_GRID + x
      if (!layer.mask[g]) continue
      const k = (row * WE_GRID + x) * 4
      const w = layer.words[g]!
      const id = paintWordTile(w)
      px[k] = id & 0xff
      px[k + 1] = (id >> 8) | (paintWordTiling(w) << 2)
      px[k + 3] = 255
    }
  }
  return px
}

/** RGBA8 pixels -> paint layer. G's bits 5-7 must be zero (the validator reports them; the decoder drops them). */
export function decodePaintLayer(px: ArrayLike<number>): PaintLayer {
  checkLen('paint pixels', px.length, WE_GRID * WE_GRID * 4)
  const layer = emptyPaintLayer()
  for (let row = 0; row < WE_GRID; row++) {
    for (let x = 0; x < WE_GRID; x++) {
      const k = (row * WE_GRID + x) * 4
      if (!px[k + 3]) continue
      const g = (WE_GRID - 1 - row) * WE_GRID + x
      layer.mask[g] = 1
      layer.words[g] = paintWord(px[k]! | ((px[k + 1]! & 3) << 8), (px[k + 1]! >> 2) & WE_TILING_MAX)
    }
  }
  return layer
}

export function emptyGrassLayer(): GrassLayer {
  const n = WE_GRASS * WE_GRASS
  return { density: new Uint8Array(n).fill(WE_GRASS_DENSITY_ONE), flowers: new Uint8Array(n), kind: new Uint8Array(n), mask: new Uint8Array(n) }
}

/** Grass layer -> RGBA8 pixels (192 x 192 x 4). Untouched texels encode as (128, 0, 0, 0). */
export function encodeGrassLayer(layer: GrassLayer): Uint8Array {
  const n = WE_GRASS * WE_GRASS
  for (const [name, a] of [['density', layer.density], ['flowers', layer.flowers], ['kind', layer.kind], ['mask', layer.mask]] as const) {
    checkLen(`grass layer ${name}`, a.length, n)
  }
  const px = new Uint8Array(n * 4)
  for (let row = 0; row < WE_GRASS; row++) {
    for (let x = 0; x < WE_GRASS; x++) {
      const g = (WE_GRASS - 1 - row) * WE_GRASS + x
      const k = (row * WE_GRASS + x) * 4
      if (!layer.mask[g]) {
        px[k] = WE_GRASS_DENSITY_ONE
        continue
      }
      px[k] = layer.density[g]!
      px[k + 1] = layer.flowers[g]!
      px[k + 2] = layer.kind[g]!
      px[k + 3] = 255
    }
  }
  return px
}

/** RGBA8 pixels -> grass layer; untouched texels read as density 128, no flowers. */
export function decodeGrassLayer(px: ArrayLike<number>): GrassLayer {
  checkLen('grass pixels', px.length, WE_GRASS * WE_GRASS * 4)
  const layer = emptyGrassLayer()
  for (let row = 0; row < WE_GRASS; row++) {
    for (let x = 0; x < WE_GRASS; x++) {
      const k = (row * WE_GRASS + x) * 4
      if (!px[k + 3]) continue
      const g = (WE_GRASS - 1 - row) * WE_GRASS + x
      layer.mask[g] = 1
      layer.density[g] = px[k]!
      layer.flowers[g] = px[k + 1]!
      layer.kind[g] = px[k + 2]!
    }
  }
  return layer
}

export const emptyWalkLayer = (): WalkLayer => ({ codes: new Uint8Array(WE_TILES * WE_TILES) })

/** Walk layer -> R8 pixels (96 x 96). */
export function encodeWalkLayer(layer: WalkLayer): Uint8Array {
  checkLen('walk layer', layer.codes.length, WE_TILES * WE_TILES)
  const px = new Uint8Array(WE_TILES * WE_TILES)
  for (let row = 0; row < WE_TILES; row++) {
    px.set(layer.codes.subarray((WE_TILES - 1 - row) * WE_TILES, (WE_TILES - row) * WE_TILES), row * WE_TILES)
  }
  return px
}

/** R8 pixels -> walk layer (codes as stored; the validator rejects codes above 2). */
export function decodeWalkLayer(px: ArrayLike<number>): WalkLayer {
  checkLen('walk pixels', px.length, WE_TILES * WE_TILES)
  const layer = emptyWalkLayer()
  for (let row = 0; row < WE_TILES; row++) {
    for (let x = 0; x < WE_TILES; x++) layer.codes[(WE_TILES - 1 - row) * WE_TILES + x] = px[row * WE_TILES + x]!
  }
  return layer
}

function checkLen(what: string, got: number, want: number): void {
  if (got !== want) throw new Error(`${what}: expected ${want} values, got ${got}`)
}
