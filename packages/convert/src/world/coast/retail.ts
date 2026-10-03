/**
 * The retail input of the coast pass (docs/COAST.md §5.3 step 4): the .m heights, texture words and water of every
 * region in the coast domain, on the coast lattice (./lattice.ts). Node-free: the caller reads the regions.
 *
 * Read as the prototype's mosaic read them (work/tmp/coast/sromap.py), so the port's parity holds: every region that
 * has a .m file (active or not), regions in z then x order, heights f32(file units / 10); water only from water blocks
 * (not ice), and at a vertex shared by several blocks or regions the first one read wins.
 */
import { MAPM_BLOCK_TILES, MAPM_BLOCK_VERTICES, MAPM_WATER, type MapMFile, type RegionGrid } from '@sro/formats'
import type { Rect } from './config.ts'
import { CELLS_PER_REGION, latticeShape, type LatticeShape } from './lattice.ts'

export interface RetailRegion {
  mapm: MapMFile
  grid: RegionGrid
}

/** A region's retail terrain (any .m file, active or not), or null when there is none. */
export type ReadRetailRegion = (x: number, z: number) => RetailRegion | null

export interface RetailLattice {
  shape: LatticeShape
  /** Heights (m): f32(file units / 10); NaN where no region file covers the vertex. */
  heights: Float64Array
  /** Water surface (m) of water blocks; NaN where none. */
  water: Float64Array
  /** Heights as stored (file units), NaN where none: what a vertex the coast leaves alone writes back. */
  fileUnits: Float32Array
  /** Raw texture words (0 where none). */
  words: Uint16Array
  /** The regions read, by z << 8 | x. */
  regions: Map<number, RetailRegion>
}

export const regionKey = (x: number, z: number) => (z << 8) | x

export function readRetailLattice(domain: Rect, read: ReadRetailRegion): RetailLattice {
  const shape = latticeShape(domain)
  const { rows, cols, x0, x1, z0, z1 } = shape
  const N = rows * cols
  const heights = new Float64Array(N).fill(NaN)
  const water = new Float64Array(N).fill(NaN)
  const fileUnits = new Float32Array(N).fill(NaN)
  const words = new Uint16Array(N)
  const regions = new Map<number, RetailRegion>()
  const G = CELLS_PER_REGION + 1
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const reg = read(x, z)
      if (!reg) continue
      regions.set(regionKey(x, z), reg)
      const row0 = (z1 - z) * CELLS_PER_REGION
      const col0 = (x - x0) * CELLS_PER_REGION
      const g = reg.grid
      for (let gz = 0; gz < G; gz++) {
        const row = row0 + CELLS_PER_REGION - gz
        for (let gx = 0; gx < G; gx++) {
          const k = row * cols + col0 + gx
          const fu = g.heights[gz * G + gx]!
          fileUnits[k] = fu
          heights[k] = Math.fround(fu / 10)
          words[k] = g.textures[gz * G + gx]!
        }
      }
      for (const b of reg.mapm.blocks) {
        if (b.waterType !== MAPM_WATER) continue
        const wm = Math.fround(b.waterHeight / 10)
        for (let vz = 0; vz < MAPM_BLOCK_VERTICES; vz++) {
          const row = row0 + CELLS_PER_REGION - (b.bz * MAPM_BLOCK_TILES + vz)
          for (let vx = 0; vx < MAPM_BLOCK_VERTICES; vx++) {
            const k = row * cols + col0 + b.bx * MAPM_BLOCK_TILES + vx
            if (Number.isNaN(water[k]!)) water[k] = wm
          }
        }
      }
    }
  }
  return { shape, heights, water, fileUnits, words, regions }
}
