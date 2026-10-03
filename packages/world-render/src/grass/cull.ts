/**
 * The grass levels and the CPU cell cull (docs/GRASS_LIFE.md §2.3, §3.3; lane GL-F).
 *
 * Per frame the cull walks the window's 32 × 32 cells of 8 m: a cell with no grass (its maximum density 0) is skipped,
 * a cell farther than the far tier (2D distance from the camera to the cell's square) is skipped, a cell outside the
 * frustum (its box: the square × its ground height range, lifted by the tallest blade and flower) is skipped, and the
 * rest go to the near, mid or far tier by distance. Each tier is one thin-instance mesh (one draw); a cell's instance
 * is a matrix whose translation is the cell's corner (the shader reads only that). No allocation per frame.
 */
import type { Plane } from '@babylonjs/core'
import type { ScatterLevel } from '../scatter.ts'
import type { GrassDensity, GrassLod } from './patch.ts'
import { GRASS_CELL_M } from './shaders.ts'
import { GRASS_WINDOW_CELLS } from './window.ts'

/** A grass level's numbers (GRASS_LIFE §3.3). Distances are metres from the camera, 2D. */
export interface GrassLevel {
  density: GrassDensity
  /** Cells nearer than these go to the near / mid / far tier; beyond `far`, none. */
  near: number
  mid: number
  far: number
  /** Tier-2 blades fade out between these (before the near edge). */
  fade2: readonly [number, number]
  /** Tier-1 blades fade out between these (before the mid edge). */
  fade1: readonly [number, number]
  /** Tier-0 blades thin out one by one past a random cut-off in this range. */
  cut0: readonly [number, number]
  /** The near blade width (m, grStyle.x). */
  width: number
  /** Flowers fade out by this distance. */
  flowers: number
  /**
   * GRASS_FAR (docs/GRASS_FAR.md §2): how far (m) world-space value noise pulls the near ring's tier-0 cut-off, the
   * meadow ring's fade-in and the terrain tint's ramp inward, so the hand-over is never a circle. 0: today's (Low).
   */
  band: number
  /** GRASS_FAR's meadow ring (ring B, grass/ring.ts) out to the far distance, or null (Low: today's field only). */
  ring: GrassRingLevel | null
  /** GRASS_FAR's far carpet on the terrain (ring C, grass/chunks.ts): the tuft pattern's and the wind sheen's share. */
  carpet: { pattern: number; sheen: number }
}

/**
 * The meadow ring of a level (docs/GRASS_FAR.md §2, ring B): sparse three-blade tufts on 16 m cells, from where the
 * near ring's last blades drop out to `out`. Three sub-rings share one random sequence (grass/ring.ts buildRingPatch):
 * B1 every tuft, B2 the `keep2` share of them, B3 the `keep3` share; the tufts that a sub-ring drops shrink away one by
 * one over `thin1` / `thin2` and the ones left grow to keep the coverage. Distances are metres from the camera, 2D.
 */
export interface GrassRingLevel {
  /** Tufts per 16 m cell side in B1. */
  grid: number
  /** Tufts appear one by one between these (the near ring's tier-0 cut-off range, `cut0`). */
  in: readonly [number, number]
  /** B1 → B2: the tufts beyond the `keep2` share drop out between these. */
  thin1: readonly [number, number]
  /** B2 → B3: the tufts beyond the `keep3` share drop out between these. */
  thin2: readonly [number, number]
  /** Every tuft is gone past a random cut-off in this range, ± RING_OUT_NOISE_M of world noise. */
  out: readonly [number, number]
  /** The flower dots fade in over [0, 1] (the near flowers' fade-out) and out over [2, 3]. */
  dots: readonly [number, number, number, number]
  keep2: number
  keep3: number
  /** A tuft blade's base half width (m). */
  width: number
}

/** The outer cut-off's world noise (± m): the ring's far edge meanders by this much on a ≈ 90 m scale. */
export const RING_OUT_NOISE_M = 20

/** The band noise of Medium and High (m). */
export const GRASS_BAND_NOISE_M = 10

const MEDIUM: GrassLevel = {
  density: { clumpGrid: 22, blades: 6 }, near: 14, mid: 32, far: 58, fade2: [9, 13], fade1: [24, 31], cut0: [40, 57], width: 0.032, flowers: 26,
  band: GRASS_BAND_NOISE_M,
  ring: {
    grid: 24, in: [40, 57], thin1: [80, 112], thin2: [140, 180], out: [205, 255], dots: [18.2, 26, 105, 140], keep2: 0.3, keep3: 0.12,
    width: 0.085,
  },
  carpet: { pattern: 1, sheen: 1 },
}
const HIGH: GrassLevel = {
  density: { clumpGrid: 26, blades: 7 }, near: 20, mid: 46, far: 82, fade2: [13, 19], fade1: [36, 45], cut0: [56, 81], width: 0.028, flowers: 36,
  band: GRASS_BAND_NOISE_M,
  ring: {
    grid: 26, in: [56, 81], thin1: [110, 150], thin2: [190, 240], out: [265, 310], dots: [25.2, 36, 150, 200], keep2: 0.3, keep3: 0.12,
    width: 0.08,
  },
  carpet: { pattern: 1, sheen: 1 },
}

/**
 * Scales a level's distances (Grass: Low keeps the full density and cuts the reach, GRASS_LIFE X3). The scaled level is
 * today's field (GRASS_FAR: Low keeps its behaviour): no meadow ring, no band noise, the plain tint.
 */
export function scaleGrassLevel(l: GrassLevel, k: number): GrassLevel {
  const s = (v: readonly [number, number]) => [v[0] * k, v[1] * k] as const
  return {
    ...l, near: l.near * k, mid: l.mid * k, far: l.far * k, fade2: s(l.fade2), fade1: s(l.fade1), cut0: s(l.cut0), flowers: l.flowers * k,
    band: 0, ring: null, carpet: { pattern: 0, sheen: 0 },
  }
}

/**
 * Where the meadow ring draws (m, 2D from the camera): its first flower dot or tuft (`inner`), the B1 / B2 and B2 / B3
 * cell boundaries, and its last tuft (`outer`).
 */
export function ringReach(level: Pick<GrassLevel, 'band' | 'ring'>): { inner: number; b1: number; b2: number; outer: number } | null {
  const r = level.ring
  if (!r) return null
  return {
    inner: Math.max(0, Math.min(r.in[0] - level.band - 6, r.dots[0] - 3)),
    b1: r.thin1[1],
    b2: r.thin2[1],
    outer: r.out[1] + RING_OUT_NOISE_M,
  }
}

/**
 * Grass: Low's meadow ring (wave 11 GF-R, WAVE_PLAN7 Q16 / cut 18): B1 only, out to ≤ 150 m (`out[1]` + the outer
 * noise), so it is one draw. Its thinning bands lie past the last tuft (every cell is a B1 cell, the share stays 1).
 * A sparser grid than Medium's (16: 1 tuft per m², ≈ 0.44 of Medium's B1) with wider blades keeps the vertices of
 * the Mac / iGPU default low. It fades in where Low's near blades drop out (its `cut0`) and its dots where Low's
 * flowers fade (the scaled level's `flowers`); no band noise, no carpet pattern or sheen (Low's near field and tint
 * colour stay today's; the ground under the tufts gets the ring's root shade).
 */
const LOW_BASE = scaleGrassLevel(MEDIUM, 0.6)
const LOW: GrassLevel = {
  ...LOW_BASE,
  ring: {
    grid: 16, in: LOW_BASE.cut0, thin1: [300, 310], thin2: [320, 330], out: [110, 130],
    dots: [LOW_BASE.flowers * 0.7, LOW_BASE.flowers, 63, 84], keep2: 0.3, keep3: 0.12, width: 0.1,
  },
}

/**
 * The Options "Grass" level → the field's numbers: Medium 45 blades/m² (14 / 32 / 58 m) and the meadow ring to
 * ≈ 255 m (± 20), High 74 blades/m² (20 / 46 / 82 m) and the ring to ≈ 310 m, Low = Medium's density over 0.6 of its
 * reach (8 / 19 / 35 m; the Mac and iGPU default) and the B1 ring to ≤ 150 m (GF-R), Off = none.
 */
export const GRASS_LEVELS: Readonly<Record<ScatterLevel, GrassLevel | null>> = {
  off: null,
  low: LOW,
  medium: MEDIUM,
  high: HIGH,
}

/** The tier of a cell at 2D distance `d` (−1: beyond the far tier). */
export function cellTier(d: number, level: Pick<GrassLevel, 'near' | 'mid' | 'far'>): GrassLod | -1 {
  return d < level.near ? 0 : d < level.mid ? 1 : d < level.far ? 2 : -1
}

/** The window as the cull reads it (grass/window.ts GrassWindow). */
export interface GrassCullWindow {
  readonly x0: number
  readonly z0: number
  readonly cellMax: Float32Array
  readonly cellY: Float32Array
}

/** Room above a cell's ground for the tallest blade, flower and lean (m), and below it. */
export const CELL_TOP_M = 1.2
export const CELL_BOTTOM_M = 0.2
/** Blades lean and are pushed up to this far out of their cell (m). */
export const CELL_MARGIN_M = 0.6

/** The cull's output: per tier, the instance matrices (capacity: every cell) and the count. */
export interface GrassCullOut {
  readonly buffers: readonly [Float32Array, Float32Array, Float32Array]
  readonly counts: [number, number, number]
}

/** Buffers for every cell of the window, per tier (matrices are identity but for the translation). */
export function grassCullOut(): GrassCullOut {
  const cap = GRASS_WINDOW_CELLS * GRASS_WINDOW_CELLS
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

/** Whether the box is at least partly inside every plane (Babylon's frustum planes: inside when n·p + d ≥ 0). */
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
 * Culls the window's cells for a camera at (cx, cz) (glTF m) with `planes` (null: no frustum test) into `out`. Returns
 * the number of cells drawn.
 */
export function cullGrass(win: GrassCullWindow, cx: number, cz: number, level: GrassLevel, planes: readonly Plane[] | null, out: GrassCullOut): number {
  const C = GRASS_WINDOW_CELLS, cm = GRASS_CELL_M
  const counts = out.counts
  counts[0] = counts[1] = counts[2] = 0
  const far = level.far
  for (let j = 0; j < C; j++) {
    const minZ = win.z0 + j * cm
    const dz = cz < minZ ? minZ - cz : cz > minZ + cm ? cz - minZ - cm : 0
    if (dz >= far) continue
    for (let i = 0; i < C; i++) {
      const k = j * C + i
      if (win.cellMax[k]! <= 0) continue
      const minX = win.x0 + i * cm
      const dx = cx < minX ? minX - cx : cx > minX + cm ? cx - minX - cm : 0
      const d = Math.sqrt(dx * dx + dz * dz)
      const tier = cellTier(d, level)
      if (tier === -1) continue
      if (planes && !boxInFrustum(planes, minX - CELL_MARGIN_M, win.cellY[k * 2]! - CELL_BOTTOM_M, minZ - CELL_MARGIN_M,
        minX + cm + CELL_MARGIN_M, win.cellY[k * 2 + 1]! + CELL_TOP_M, minZ + cm + CELL_MARGIN_M)) continue
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
