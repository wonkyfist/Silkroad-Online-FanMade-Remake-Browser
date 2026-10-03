/**
 * The meadow ring's window (docs/GRASS_FAR.md §3; lane P-GRASS-FAR): the camera-centred 832 m square the ring's tufts
 * read (grass/ring.ts), at 2 m per texel, re-centred when the focus leaves the inner 48 m. Pure data (CPU arrays);
 * GrassField uploads them.
 *
 * - `field`: 416 × 416 RGBA8, texel (i, j) = the 2 m square at x0 + 2 i, z0 + 2 j (glTF): each region bake's 2 × 2
 *   box (`coarseGrass`: mean density, meadow and baked light, the densest texel's palette slot), copied row by row.
 *   Outside every baked region: 0 (no grass) and A 255.
 * - `heightBytes`: 417 × 417 RGBA8, texel (i, j) = the terrain vertex at (x0 + 2 i, z0 + 2 j): exactly the vertices the
 *   terrain draws (no terrain LOD), 16 bits over [hMin, hMin + hRange] in R and G as the near window stores them.
 * - the cell table (52 × 52 cells of 16 m): each cell's maximum density and its ground height range, for the cull.
 *
 * Unlike the near window (a 0.4 ms fill), a fill here is ≈ 3 ms of work, so it runs in row slices into a back buffer
 * (`step`) while the front buffer keeps drawing; the buffers swap when the fill is done. The front's reach (416 m less
 * the 48 m re-centre and a 16 m cell) covers High's farthest tuft (330 m) while the next fill runs.
 */
import { GRID } from '../../../convert/src/world/format.ts'
import { GRASS_REGION_M } from './bake.ts'
import { grassHeightAt } from './shaders.ts'

/** Metres per texel, the window's side (m and texels), the height grid, the cell and the re-centre distance. */
export const GRASS_RING_TEXEL_M = 2
export const GRASS_RING_WINDOW_M = 832
export const GRASS_RING_TEXELS = GRASS_RING_WINDOW_M / GRASS_RING_TEXEL_M
export const GRASS_RING_HEIGHT_GRID = GRASS_RING_TEXELS + 1
export const GRASS_RING_CELL_M = 16
export const GRASS_RING_CELLS = GRASS_RING_WINDOW_M / GRASS_RING_CELL_M
export const GRASS_RING_RECENTER_M = 48
/** Texels per cell side. */
const CELL_TEXELS = GRASS_RING_CELL_M / GRASS_RING_TEXEL_M
/** A region's coarse grid (2 m texels per side). */
export const GRASS_COARSE = GRASS_REGION_M / GRASS_RING_TEXEL_M

/** A region as the ring window reads it. */
export interface GrassRingRegion {
  /** The south-west corner (glTF m). */
  readonly ox: number
  readonly oz: number
  /** 97 × 97 terrain heights. */
  readonly heights: ArrayLike<number>
  /** Its height range (the fill's 16-bit span). */
  readonly hMin: number
  readonly hMax: number
  /** `coarseGrass` of its bake (96 × 96 RGBA8, row q = the 2 m strip q north of the south edge), or null: not baked. */
  readonly coarse: Uint8Array | null
}

/**
 * A region bake (192 × 192 RGBA8, grass/bake.ts) boxed down to 2 m (96 × 96 RGBA8): R density, G meadow and A baked
 * light are the 2 × 2 means, B the palette slot of the densest of the four (a slot is an index, never averaged).
 */
export function coarseGrass(bake: Uint8Array, out: Uint8Array = new Uint8Array(GRASS_COARSE * GRASS_COARSE * 4)): Uint8Array {
  const n = GRASS_REGION_M, c = GRASS_COARSE
  for (let q = 0; q < c; q++) {
    for (let p = 0; p < c; p++) {
      const a = ((2 * q) * n + 2 * p) * 4, b = a + 4, d = a + n * 4, e = d + 4
      const ra = bake[a]!, rb = bake[b]!, rd = bake[d]!, re = bake[e]!
      const o = (q * c + p) * 4
      out[o] = (ra + rb + rd + re + 2) >> 2
      out[o + 1] = (bake[a + 1]! + bake[b + 1]! + bake[d + 1]! + bake[e + 1]! + 2) >> 2
      let s = a
      let best = ra
      if (rb > best) {
        best = rb
        s = b
      }
      if (rd > best) {
        best = rd
        s = d
      }
      if (re > best) s = e
      out[o + 2] = bake[s + 2]!
      out[o + 3] = (bake[a + 3]! + bake[b + 3]! + bake[d + 3]! + bake[e + 3]! + 2) >> 2
    }
  }
  return out
}

/** One buffer of the window (the drawn front, or the back being filled). */
export class GrassRingBuffers {
  x0 = 0
  z0 = 0
  hMin = 0
  hRange = 1
  readonly field = new Uint8Array(GRASS_RING_TEXELS * GRASS_RING_TEXELS * 4)
  readonly heightBytes = new Uint8Array(GRASS_RING_HEIGHT_GRID * GRASS_RING_HEIGHT_GRID * 4)
  /** Per cell: the maximum density 0..1. */
  readonly cellMax = new Float32Array(GRASS_RING_CELLS * GRASS_RING_CELLS)
  /** Per cell: the ground's min and max height. */
  readonly cellY = new Float32Array(GRASS_RING_CELLS * GRASS_RING_CELLS * 2)
  /** Per height texel: 1 where a region gave the vertex. */
  readonly have = new Uint8Array(GRASS_RING_HEIGHT_GRID * GRASS_RING_HEIGHT_GRID)
  /** Cells with grass after the fill. */
  grassCells = 0
  readonly field32 = new Uint32Array(this.field.buffer)
}

/** Work units of a fill: height rows, field rows, cell rows. */
const HEIGHT_ROWS = GRASS_RING_HEIGHT_GRID
const FIELD_ROWS = GRASS_RING_TEXELS
const CELL_ROWS = GRASS_RING_CELLS
const FILL_UNITS = HEIGHT_ROWS + FIELD_ROWS + CELL_ROWS

export class GrassRingWindow {
  /** What is drawn (the textures hold it once GrassField uploaded it). */
  front = new GrassRingBuffers()
  private back = new GrassRingBuffers()
  /** Bumped by every swap. */
  version = 0
  /** The centre of the latest fill started (NaN: never). */
  cx = Number.NaN
  cz = Number.NaN
  /** Fills completed and started. */
  fills = 0
  starts = 0
  private regions: GrassRingRegion[] = []
  /** The next work unit of the running fill (−1: none). */
  private unit = -1

  /** Whether a fill is running. */
  get busy(): boolean {
    return this.unit >= 0
  }

  /** Whether the focus left the inner square of the latest fill (or none was ever started). */
  needsCentre(x: number, z: number): boolean {
    return !(Math.hypot(x - this.cx, z - this.cz) < GRASS_RING_RECENTER_M)
  }

  /** Starts a fill centred on (x, z) from `regions` (a running fill starts over). */
  start(x: number, z: number, regions: Iterable<GrassRingRegion>): void {
    this.cx = x
    this.cz = z
    const b = this.back
    b.x0 = Math.round((x - GRASS_RING_WINDOW_M / 2) / GRASS_RING_CELL_M) * GRASS_RING_CELL_M
    b.z0 = Math.round((z - GRASS_RING_WINDOW_M / 2) / GRASS_RING_CELL_M) * GRASS_RING_CELL_M
    // the regions that touch the window, and their height span
    const list: GrassRingRegion[] = []
    let lo = Infinity, hi = -Infinity
    for (const r of regions) {
      if (r.ox > b.x0 + GRASS_RING_WINDOW_M || r.ox + GRASS_REGION_M < b.x0) continue
      if (r.oz - GRASS_REGION_M > b.z0 + GRASS_RING_WINDOW_M || r.oz < b.z0) continue
      list.push(r)
      if (r.hMin < lo) lo = r.hMin
      if (r.hMax > hi) hi = r.hMax
    }
    if (!(lo <= hi)) lo = hi = 0
    b.hMin = lo
    b.hRange = Math.max(1, hi - lo)
    this.regions = list
    b.field32.fill(0xff000000)
    b.have.fill(0)
    b.grassCells = 0
    this.unit = 0
    this.starts++
  }

  /** Abandons a running fill (the front stays). */
  cancel(): void {
    this.unit = -1
    this.regions = []
  }

  /**
   * Runs the fill until `stop()` says so (asked after each row) or it is done; true when this call finished it and the
   * buffers swapped (the caller uploads the new front).
   */
  step(stop: () => boolean = () => false): boolean {
    if (this.unit < 0) return false
    while (this.unit < FILL_UNITS) {
      const u = this.unit++
      if (u < HEIGHT_ROWS) this.heightRow(u)
      else if (u < HEIGHT_ROWS + FIELD_ROWS) this.fieldRow(u - HEIGHT_ROWS)
      else this.cellRow(u - HEIGHT_ROWS - FIELD_ROWS)
      if (this.unit < FILL_UNITS && stop()) return false
    }
    const t = this.front
    this.front = this.back
    this.back = t
    this.unit = -1
    this.regions = []
    this.version++
    this.fills++
    return true
  }

  /** Height texel row j: the vertices at z = z0 + 2 j. */
  private heightRow(j: number): void {
    const b = this.back
    const N = GRASS_RING_HEIGHT_GRID
    const z = b.z0 + 2 * j
    const bytes = b.heightBytes
    const scale = 65535 / b.hRange
    const lo = b.hMin
    for (const r of this.regions) {
      // region vertex row gz = (oz − z) / 2, 0..96
      if (z < r.oz - GRASS_REGION_M || z > r.oz) continue
      const gz = (r.oz - z) / 2
      const i0 = Math.max(0, Math.ceil((r.ox - b.x0) / 2)), i1 = Math.min(N - 1, Math.floor((r.ox + GRASS_REGION_M - b.x0) / 2))
      const g0 = (b.x0 - r.ox) / 2
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i
        const v = Math.max(0, Math.min(65535, Math.round((r.heights[gz * GRID + g0 + i]! - lo) * scale)))
        bytes[k * 4] = v >> 8
        bytes[k * 4 + 1] = v & 255
        bytes[k * 4 + 2] = 0
        bytes[k * 4 + 3] = 255
        b.have[k] = 1
      }
    }
    // vertices no region gave: the low end (they carry no grass; the cull's height range skips them)
    for (let i = 0; i < N; i++) {
      const k = j * N + i
      if (b.have[k]) continue
      bytes[k * 4] = bytes[k * 4 + 1] = bytes[k * 4 + 2] = 0
      bytes[k * 4 + 3] = 255
    }
  }

  /** Field row j: the 2 m strip z0 + 2 j .. z0 + 2 j + 2. */
  private fieldRow(j: number): void {
    const b = this.back
    const S = GRASS_RING_TEXELS, C = GRASS_COARSE
    const z = b.z0 + 2 * j
    for (const r of this.regions) {
      if (!r.coarse) continue
      // coarse row q covers z ∈ [oz − 2 q − 2, oz − 2 q]
      const q = (r.oz - z) / 2 - 1
      if (q < 0 || q >= C) continue
      const i0 = Math.max(0, (r.ox - b.x0) / 2), i1 = Math.min(S, (r.ox + GRASS_REGION_M - b.x0) / 2)
      if (i1 <= i0) continue
      const p0 = i0 - (r.ox - b.x0) / 2
      const src = (q * C + p0) * 4
      b.field.set(r.coarse.subarray(src, src + (i1 - i0) * 4), (j * S + i0) * 4)
    }
  }

  /** Cell row cz: each cell's maximum density and ground height range. */
  private cellRow(cz: number): void {
    const b = this.back
    const S = GRASS_RING_TEXELS, N = GRASS_RING_HEIGHT_GRID, C = GRASS_RING_CELLS, ct = CELL_TEXELS
    const f = b.field, hb = b.heightBytes
    for (let cx = 0; cx < C; cx++) {
      let max = 0
      for (let j = cz * ct; j < (cz + 1) * ct; j++) {
        let o = (j * S + cx * ct) * 4
        for (let i = 0; i < ct; i++, o += 4) if (f[o]! > max) max = f[o]!
      }
      const k = cz * C + cx
      b.cellMax[k] = max / 255
      let lo = Infinity, hi = -Infinity
      if (max > 0) {
        for (let j = cz * ct; j <= (cz + 1) * ct; j++) {
          for (let i = cx * ct; i <= (cx + 1) * ct; i++) {
            const t = j * N + i
            if (!b.have[t]) continue
            const v = hb[t * 4]! * 256 + hb[t * 4 + 1]!
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
        }
      }
      if (!(lo <= hi)) lo = hi = 0
      b.cellY[k * 2] = b.hMin + (lo / 65535) * b.hRange
      b.cellY[k * 2 + 1] = b.hMin + (hi / 65535) * b.hRange
      if (max > 0) b.grassCells++
    }
  }

  /** The front's density 0..1 at glTF (x, z) (0 outside it). */
  densityAt(x: number, z: number): number {
    const b = this.front
    const i = Math.floor((x - b.x0) / GRASS_RING_TEXEL_M), j = Math.floor((z - b.z0) / GRASS_RING_TEXEL_M)
    if (i < 0 || j < 0 || i >= GRASS_RING_TEXELS || j >= GRASS_RING_TEXELS) return 0
    return b.field[(j * GRASS_RING_TEXELS + i) * 4]! / 255
  }

  /** The front's ground height as the ring's shader decodes it (null outside it or where no region gave it). */
  heightAt(x: number, z: number): number | null {
    const b = this.front
    const N = GRASS_RING_HEIGHT_GRID
    const gi = Math.floor((x - b.x0) / 2), gj = Math.floor((z - b.z0) / 2)
    if (gi < 0 || gj < 0 || gi >= N - 1 || gj >= N - 1) return null
    if (!b.have[gj * N + gi]) return null
    return grassHeightAt(b.heightBytes, b.x0, b.z0, b.hMin, b.hRange, x, z, N)
  }
}
