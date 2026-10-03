/**
 * The grass field window (docs/GRASS_LIFE.md §3.1; lane GL-F): the camera-centred 256 m square the grass shader reads,
 * like the night-light grass window (night-lights.ts NIGHT_GRASS_WINDOW), re-centred when the focus leaves the inner
 * 32 m. Pure data (CPU arrays); GrassField uploads them.
 *
 * - `field`: 256 × 256 RGBA8 at 1 m, texel (i, j) = the metre square at x0 + i, z0 + j (glTF): the region bakes' R
 *   density, G meadow, B palette slot, A baked light, copied row by row (a region's bake row r is the metre r north of
 *   its south edge z = oz, i.e. window row oz − z0 − 1 − r). Outside every baked region: 0 (no grass) and A 255.
 * - `heightBytes`: 129 × 129 RGBA8, texel (i, j) = the terrain vertex at (x0 + 2 i, z0 + 2 j): 16 bits over
 *   [hMin, hMin + hRange] in R and G (grass/shaders.ts `encodeGrassHeight`), from every registered region's heights.
 * - the cell table (32 × 32 cells of 8 m): each cell's maximum density and its ground height range, for the CPU cull.
 *
 * x0 and z0 are multiples of the 8 m cell, so the cells and their patch variants stay put while the window moves.
 */
import { GRID } from '../../../convert/src/world/format.ts'
import { GRASS_REGION_M } from './bake.ts'
import { GRASS_CELL_M, GRASS_HEIGHT_GRID, GRASS_WINDOW_M, grassHeightAt } from './shaders.ts'

/** The window re-centres when the focus is this far (m) from its centre. */
export const GRASS_RECENTER_M = 32
/** Cells per window side. */
export const GRASS_WINDOW_CELLS = GRASS_WINDOW_M / GRASS_CELL_M

/** A region as the window reads it. */
export interface GrassWindowRegion {
  /** The south-west corner (glTF m). */
  readonly ox: number
  readonly oz: number
  /** 97 × 97 terrain heights. */
  readonly heights: ArrayLike<number>
  /** The bake (192 × 192 RGBA8), or null while it is not done. */
  readonly grass: Uint8Array | null
}

export class GrassWindow {
  x0 = 0
  z0 = 0
  /** The focus the window was centred on (NaN: never). */
  cx = Number.NaN
  cz = Number.NaN
  readonly field = new Uint8Array(GRASS_WINDOW_M * GRASS_WINDOW_M * 4)
  private readonly field32 = new Uint32Array(this.field.buffer)
  readonly heightBytes = new Uint8Array(GRASS_HEIGHT_GRID * GRASS_HEIGHT_GRID * 4)
  hMin = 0
  hRange = 1
  /** Per cell: the maximum density 0..1. */
  readonly cellMax = new Float32Array(GRASS_WINDOW_CELLS * GRASS_WINDOW_CELLS)
  /** Per cell: the ground's min and max height. */
  readonly cellY = new Float32Array(GRASS_WINDOW_CELLS * GRASS_WINDOW_CELLS * 2)
  /** Bumped by every fill (the cull's and the upload's key). */
  version = 0
  /** Cells with grass after the last fill. */
  grassCells = 0
  private readonly heights = new Float32Array(GRASS_HEIGHT_GRID * GRASS_HEIGHT_GRID)
  private readonly have = new Uint8Array(GRASS_HEIGHT_GRID * GRASS_HEIGHT_GRID)

  /** Whether the focus left the inner square (or the window was never centred). */
  needsCentre(x: number, z: number): boolean {
    return !(Math.hypot(x - this.cx, z - this.cz) < GRASS_RECENTER_M)
  }

  /** Moves the window onto the focus (cell-aligned corner); the caller fills it. */
  centre(x: number, z: number): void {
    this.cx = x
    this.cz = z
    this.x0 = Math.round((x - GRASS_WINDOW_M / 2) / GRASS_CELL_M) * GRASS_CELL_M
    this.z0 = Math.round((z - GRASS_WINDOW_M / 2) / GRASS_CELL_M) * GRASS_CELL_M
  }

  /** Rebuilds the field, the heights and the cell table from `regions` (every registered region). */
  fill(regions: Iterable<GrassWindowRegion>): void {
    const S = GRASS_WINDOW_M
    const f = this.field
    // No grass, A (the baked light) 255: one 32-bit fill (little-endian RGBA, as every WebGPU / WebGL2 platform).
    this.field32.fill(0xff000000)
    this.have.fill(0)
    const list = [...regions]
    for (const r of list) {
      this.copyHeights(r)
      if (!r.grass) continue
      // Columns: window i = x − x0 ↔ region column x − ox; rows: window j ↔ region row oz − z0 − 1 − j.
      const i0 = Math.max(0, r.ox - this.x0), i1 = Math.min(S, r.ox + GRASS_REGION_M - this.x0)
      if (i1 <= i0) continue
      const j0 = Math.max(0, r.oz - GRASS_REGION_M - this.z0), j1 = Math.min(S, r.oz - this.z0)
      const ri0 = i0 - (r.ox - this.x0)
      for (let j = j0; j < j1; j++) {
        const row = r.oz - this.z0 - 1 - j
        const src = (row * GRASS_REGION_M + ri0) * 4
        f.set(r.grass.subarray(src, src + (i1 - i0) * 4), (j * S + i0) * 4)
      }
    }
    this.encodeHeights()
    this.cellTable()
    this.version++
  }

  private copyHeights(r: GrassWindowRegion): void {
    const N = GRASS_HEIGHT_GRID
    // Window vertex (i, j) at (x0 + 2 i, z0 + 2 j) ↔ region vertex gx = (x − ox) / 2, gz = (oz − z) / 2.
    const i0 = Math.max(0, Math.ceil((r.ox - this.x0) / 2)), i1 = Math.min(N - 1, Math.floor((r.ox + GRASS_REGION_M - this.x0) / 2))
    const j0 = Math.max(0, Math.ceil((r.oz - GRASS_REGION_M - this.z0) / 2)), j1 = Math.min(N - 1, Math.floor((r.oz - this.z0) / 2))
    for (let j = j0; j <= j1; j++) {
      const gz = (r.oz - this.z0) / 2 - j
      for (let i = i0; i <= i1; i++) {
        const gx = (this.x0 - r.ox) / 2 + i
        const k = j * N + i
        this.heights[k] = r.heights[gz * GRID + gx]!
        this.have[k] = 1
      }
    }
  }

  private encodeHeights(): void {
    const n = this.heights.length
    let lo = Infinity, hi = -Infinity
    for (let k = 0; k < n; k++) {
      if (!this.have[k]) continue
      const h = this.heights[k]!
      if (h < lo) lo = h
      if (h > hi) hi = h
    }
    if (!(lo <= hi)) lo = hi = 0
    this.hMin = lo
    this.hRange = Math.max(1, hi - lo)
    const b = this.heightBytes
    const scale = 65535 / this.hRange
    for (let k = 0; k < n; k++) {
      // grass/shaders.ts encodeGrassHeight, inlined (no tuple per vertex).
      const v = this.have[k] ? Math.max(0, Math.min(65535, Math.round((this.heights[k]! - lo) * scale))) : 0
      b[k * 4] = v >> 8
      b[k * 4 + 1] = v & 255
      b[k * 4 + 2] = 0
      b[k * 4 + 3] = 255
    }
  }

  private cellTable(): void {
    const C = GRASS_WINDOW_CELLS, S = GRASS_WINDOW_M, N = GRASS_HEIGHT_GRID
    const cm = GRASS_CELL_M
    const f = this.field
    let grassy = 0
    for (let cz = 0; cz < C; cz++) {
      for (let cx = 0; cx < C; cx++) {
        let max = 0
        for (let j = cz * cm; j < (cz + 1) * cm; j++) {
          let o = (j * S + cx * cm) * 4
          for (let i = 0; i < cm; i++, o += 4) if (f[o]! > max) max = f[o]!
        }
        const k = cz * C + cx
        this.cellMax[k] = max / 255
        let lo = Infinity, hi = -Infinity
        const step = cm / 2
        for (let j = cz * step; j <= (cz + 1) * step; j++) {
          for (let i = cx * step; i <= (cx + 1) * step; i++) {
            const h = this.heights[j * N + i]!
            if (!this.have[j * N + i]) continue
            if (h < lo) lo = h
            if (h > hi) hi = h
          }
        }
        if (!(lo <= hi)) lo = hi = this.hMin
        this.cellY[k * 2] = lo
        this.cellY[k * 2 + 1] = hi
        if (max > 0) grassy++
      }
    }
    this.grassCells = grassy
  }

  private texel(x: number, z: number, channel: number, outside: number): number {
    const i = Math.floor(x - this.x0), j = Math.floor(z - this.z0)
    if (i < 0 || j < 0 || i >= GRASS_WINDOW_M || j >= GRASS_WINDOW_M) return outside
    return this.field[(j * GRASS_WINDOW_M + i) * 4 + channel]! / 255
  }

  /** The grass density 0..1 at glTF (x, z) (0 outside the window). */
  densityAt(x: number, z: number): number {
    return this.texel(x, z, 0, 0)
  }

  /** The meadow (flower) mask 0..1. */
  meadowAt(x: number, z: number): number {
    return this.texel(x, z, 1, 0)
  }

  /** The baked light 0..1 (1: no lightmap). */
  lightAt(x: number, z: number): number {
    return this.texel(x, z, 3, 1)
  }

  /** The ground height as the grass shader reads it (null outside the window or where no region is registered). */
  heightAt(x: number, z: number): number | null {
    const gi = Math.floor((x - this.x0) / 2), gj = Math.floor((z - this.z0) / 2)
    const N = GRASS_HEIGHT_GRID
    if (gi < 0 || gj < 0 || gi >= N - 1 || gj >= N - 1) return null
    if (!this.have[gj * N + gi]) return null
    return grassHeightAt(this.heightBytes, this.x0, this.z0, this.hMin, this.hRange, x, z)
  }
}
