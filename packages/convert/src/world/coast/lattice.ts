/**
 * The coast lattice (docs/COAST.md §5.3): one global 2 m lattice over the coast domain, the retail vertex grid itself,
 * so a vertex on a region edge is computed once and region seams match by construction.
 *
 * Layout (the prototype's, kept for parity): row-major, row 0 = the north edge of region row z1 (z = z1 + 1), column 0
 * = the west edge of region column x0. A region is 96 cells; the lattice has (z1 - z0 + 1) * 96 + 1 rows and
 * (x1 - x0 + 1) * 96 + 1 columns. In the converter's global lattice coordinates (gx = 96 rx + i, gz = 96 rz + j):
 * column = gx - 96 x0, row = 96 (z1 + 1) - gz.
 */
import type { Rect } from './config.ts'

export const CELLS_PER_REGION = 96
export const REGION_M = 192
export const CELL_M = REGION_M / CELLS_PER_REGION

/** Region rectangle, inclusive (x1 and z1 are the last regions). */
export interface RegionRect {
  x0: number
  x1: number
  z0: number
  z1: number
}

export interface LatticeShape {
  /** Domain in regions, inclusive. */
  x0: number
  x1: number
  z0: number
  z1: number
  rows: number
  cols: number
}

export function latticeShape(domain: Rect): LatticeShape {
  const [x0, x1] = domain.x
  const [z0, z1] = domain.z
  return { x0, x1, z0, z1, rows: (z1 - z0 + 1) * CELLS_PER_REGION + 1, cols: (x1 - x0 + 1) * CELLS_PER_REGION + 1 }
}

/** Region-unit x of a column and z of a row. */
export const colX = (l: LatticeShape, col: number) => l.x0 + col / CELLS_PER_REGION
export const rowZ = (l: LatticeShape, row: number) => l.z1 + 1 - row / CELLS_PER_REGION

/** Lattice index of a global lattice vertex (gx = 96 rx + i, gz = 96 rz + j), or -1 outside the domain. */
export function latticeIndex(l: LatticeShape, gx: number, gz: number): number {
  const col = gx - CELLS_PER_REGION * l.x0
  const row = CELLS_PER_REGION * (l.z1 + 1) - gz
  if (col < 0 || col >= l.cols || row < 0 || row >= l.rows) return -1
  return row * l.cols + col
}

/**
 * Signed distance (m) from (x, z) (region units) to a rectangle [x0, x1] x [z0, z1] (continuous region
 * coordinates): positive outside, negative inside (the distance to the nearest edge).
 */
export function sdfRect(x: number, z: number, x0: number, x1: number, z0: number, z1: number): number {
  const dx = Math.max(x0 - x, x - x1)
  const dz = Math.max(z0 - z, z - z1)
  const out = Math.hypot(Math.max(dx, 0), Math.max(dz, 0))
  const ins = Math.min(Math.max(dx, dz), 0)
  return (out + ins) * REGION_M
}

/** Nearest point on the rectangle's boundary (region units): clamped outside, projected to the nearest edge inside. */
export function nearestOnRect(x: number, z: number, x0: number, x1: number, z0: number, z1: number): [number, number] {
  let nx = Math.min(Math.max(x, x0), x1)
  let nz = Math.min(Math.max(z, z0), z1)
  if (x > x0 && x < x1 && z > z0 && z < z1) {
    const d = [x - x0, x1 - x, z - z0, z1 - z]
    let k = 0
    for (let i = 1; i < 4; i++) if (d[i]! < d[k]!) k = i
    if (k === 0) nx = x0
    else if (k === 1) nx = x1
    else if (k === 2) nz = z0
    else nz = z1
  }
  return [nx, nz]
}

/** The line rectangle of a playable region rectangle: its outer edges (x1 + 1, z1 + 1). */
export const playLine = (p: RegionRect): [number, number, number, number] => [p.x0, p.x1 + 1, p.z0, p.z1 + 1]
