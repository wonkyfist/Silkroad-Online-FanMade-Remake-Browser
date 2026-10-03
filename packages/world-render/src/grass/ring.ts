/**
 * The meadow ring (docs/GRASS_FAR.md §2, ring B; lane P-GRASS-FAR): sparse three-blade tufts and flower dots from where
 * the near ring's last blades drop out (the level's `cut0`) to ≈ 255 m on Medium and ≈ 310 m on High, so a field reads
 * as grass to the horizon. The same GPU-procedural scheme as the near ring (grass/patch.ts, cull.ts): one shared patch
 * mesh per sub-ring holds every tuft of one 16 m cell, the cell's thin instance is only its corner, the vertex shader
 * (grass/ring-shaders.ts) reads the ring window (grass/ring-window.ts: density, meadow, palette, light, heights at 2 m).
 *
 * - **Patches:** tufts on a jittered `grid` × `grid` grid (Medium 24: 2.25 per m²); each tuft is 3 blades (one triangle
 *   each: 9 vertices) fanned in the plane facing the camera; 16 % of the tufts also carry a flower dot (a 4-vertex
 *   diamond). B1 holds every tuft, B2 the tufts whose keep value is under `keep2`, B3 under `keep3`: one random
 *   sequence, so a B2 cell draws exactly B1's survivors and the cell boundary between sub-rings never shows.
 * - **Cull** (per frame, no allocation): the window's 52 × 52 cells; no grass, wholly nearer than the ring's first tuft
 *   or dot, beyond its last tuft, or outside the frustum: skipped; else B1 / B2 / B3 by the cell's nearest distance.
 */
import type { Plane } from '@babylonjs/core'
import { ringReach, type GrassLevel } from './cull.ts'
import { GRASS_RING_CELLS, GRASS_RING_CELL_M } from './ring-window.ts'

export type GrassRingLod = 0 | 1 | 2
export const GRASS_RING_LODS: readonly GrassRingLod[] = [0, 1, 2]
/** Share of the tufts that carry a flower dot. */
export const RING_DOT_SHARE = 0.16
/** The sub-rings that carry dots (the dots are gone before B3). */
const DOT_LODS = 2

export interface GrassRingPatch {
  lod: GrassRingLod
  /** (side −1 | 0 | 1, t 0..1, kind: 0..2 blade k of the tuft / 3 dot); a dot's (x, y) is its diamond corner. */
  positions: Float32Array
  /** (x, z in the cell 0..16 m, the tuft's density random (a dot's: its flower random), keep value). */
  bladeA: Float32Array
  /** (height, yaw, blade random, colour random). */
  bladeB: Float32Array
  indices: Uint32Array
  vertices: number
  triangles: number
  tufts: number
  dots: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The patch of one sub-ring (deterministic in `grid`, `keep2` and `keep3`). */
export function buildRingPatch(lod: GrassRingLod, ring: { grid: number; keep2: number; keep3: number }, cellM = GRASS_RING_CELL_M): GrassRingPatch {
  const { grid, keep2, keep3 } = ring
  const rnd = mulberry32(0x5eed + grid)
  const pos: number[] = [], a: number[] = [], b: number[] = [], idx: number[] = []
  const sp = cellM / grid
  const keepMax = lod === 0 ? 1.01 : lod === 1 ? keep2 : keep3
  let tufts = 0, dots = 0
  for (let gz = 0; gz < grid; gz++) {
    for (let gx = 0; gx < grid; gx++) {
      // always the same draws per tuft: a tuft left out of a sub-ring never shifts another's numbers
      const cx = (gx + 0.1 + 0.8 * rnd()) * sp
      const cz = (gz + 0.1 + 0.8 * rnd()) * sp
      const crand = rnd(), keep = rnd()
      const hasDot = rnd() < RING_DOT_SHARE
      const fr = rnd()
      const r1 = rnd(), r2 = rnd(), r4 = rnd()
      const rb = [rnd(), rnd(), rnd()]
      if (keep >= keepMax) continue
      for (let k = 0; k < 3; k++) {
        const v = pos.length / 3
        pos.push(-1, 0, k, 1, 0, k, 0, 1, k)
        for (let n = 0; n < 3; n++) {
          a.push(cx, cz, crand, keep)
          b.push(r1, r2, rb[k]!, r4)
        }
        idx.push(v, v + 1, v + 2)
      }
      tufts++
      if (hasDot && lod < DOT_LODS) {
        const v = pos.length / 3
        pos.push(0, -1, 3, 1, 0, 3, 0, 1, 3, -1, 0, 3)
        for (let n = 0; n < 4; n++) {
          a.push(cx, cz, fr, keep)
          b.push(r1, r2, rb[1]!, r4)
        }
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3)
        dots++
      }
    }
  }
  return {
    lod,
    positions: new Float32Array(pos),
    bladeA: new Float32Array(a),
    bladeB: new Float32Array(b),
    indices: new Uint32Array(idx),
    vertices: pos.length / 3,
    triangles: idx.length / 3,
    tufts,
    dots,
  }
}

/** The ring window as the cull reads it (grass/ring-window.ts GrassRingBuffers). */
export interface GrassRingCullWindow {
  readonly x0: number
  readonly z0: number
  readonly cellMax: Float32Array
  readonly cellY: Float32Array
}

/** Room above a cell's ground for the tallest tuft (grown) and its dot, below it, and the tufts' reach past the cell (m). */
export const RING_CELL_TOP_M = 1.4
export const RING_CELL_BOTTOM_M = 0.2
export const RING_CELL_MARGIN_M = 1

export interface GrassRingCullOut {
  readonly buffers: readonly [Float32Array, Float32Array, Float32Array]
  readonly counts: [number, number, number]
}

/** Buffers for every cell of the window, per sub-ring (identity matrices but for the translation). */
export function grassRingCullOut(): GrassRingCullOut {
  const cap = GRASS_RING_CELLS * GRASS_RING_CELLS
  const make = () => {
    const b = new Float32Array(cap * 16)
    for (let i = 0; i < cap; i++) {
      const o = i * 16
      b[o] = b[o + 5] = b[o + 10] = b[o + 15] = 1
    }
    return b
  }
  return { buffers: [make(), make(), make()], counts: [0, 0, 0] }
}

function boxInFrustum(planes: readonly Plane[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  for (let k = 0; k < planes.length; k++) {
    const p = planes[k]!
    const n = p.normal
    const x = n.x >= 0 ? x1 : x0, y = n.y >= 0 ? y1 : y0, z = n.z >= 0 ? z1 : z0
    if (n.x * x + n.y * y + n.z * z + p.d < 0) return false
  }
  return true
}

/**
 * Culls the ring window's cells for a camera at (cx, cz) (glTF m) with `planes` (null: no frustum test) into `out`.
 * Returns the number of cells drawn (0 when the level has no ring).
 */
export function cullGrassRing(win: GrassRingCullWindow, cx: number, cz: number, level: Pick<GrassLevel, 'band' | 'ring'>, planes: readonly Plane[] | null, out: GrassRingCullOut): number {
  const counts = out.counts
  counts[0] = counts[1] = counts[2] = 0
  const reach = ringReach(level)
  if (!reach) return 0
  const C = GRASS_RING_CELLS, cm = GRASS_RING_CELL_M
  const { inner, b1, b2, outer } = reach
  for (let j = 0; j < C; j++) {
    const minZ = win.z0 + j * cm
    const dz = cz < minZ ? minZ - cz : cz > minZ + cm ? cz - minZ - cm : 0
    if (dz >= outer) continue
    const fz = Math.max(Math.abs(cz - minZ), Math.abs(cz - minZ - cm))
    for (let i = 0; i < C; i++) {
      const k = j * C + i
      if (win.cellMax[k]! <= 0) continue
      const minX = win.x0 + i * cm
      const dx = cx < minX ? minX - cx : cx > minX + cm ? cx - minX - cm : 0
      const d = Math.sqrt(dx * dx + dz * dz)
      if (d >= outer) continue
      const fx = Math.max(Math.abs(cx - minX), Math.abs(cx - minX - cm))
      if (fx * fx + fz * fz < inner * inner) continue
      if (planes && !boxInFrustum(planes, minX - RING_CELL_MARGIN_M, win.cellY[k * 2]! - RING_CELL_BOTTOM_M, minZ - RING_CELL_MARGIN_M,
        minX + cm + RING_CELL_MARGIN_M, win.cellY[k * 2 + 1]! + RING_CELL_TOP_M, minZ + cm + RING_CELL_MARGIN_M)) continue
      const tier = d < b1 ? 0 : d < b2 ? 1 : 2
      const buf = out.buffers[tier]
      const o = counts[tier]! * 16
      buf[o + 12] = minX
      buf[o + 13] = 0
      buf[o + 14] = minZ
      counts[tier]!++
    }
  }
  return counts[0] + counts[1] + counts[2]
}

/**
 * The expected share of B1's tufts still standing at distance `d` (the shader's size compensation, linear ramps over
 * the thinning bands): 1 before `thin1`, `keep2` after it, `keep3` after `thin2`.
 */
export function ringShare(ring: Pick<NonNullable<GrassLevel['ring']>, 'thin1' | 'thin2' | 'keep2' | 'keep3'>, d: number): number {
  const ramp = (v: readonly [number, number], half: number) => Math.min(1, Math.max(0, (d - v[0] + half) / Math.max(1, v[1] - v[0])))
  return 1 - (1 - ring.keep2) * ramp(ring.thin1, 3) - (ring.keep2 - ring.keep3) * ramp(ring.thin2, 4)
}
