/**
 * The grass patch meshes (docs/GRASS_LIFE.md §3.3, §4.1; lane GL-F): one shared mesh per LOD tier holds every blade of
 * one 8 m cell; the cell's thin instance is only its corner (grass/shaders.ts). Ported from the prototype
 * (work/tmp/grass-life/lab/grass-lab.ts `buildPatch`): the same random sequence, so the counts are §3.3's.
 *
 * Clumps sit on a jittered grid; blades within 16 cm of the clump centre; blade 0 of a clump is tier 0, blades 1–2 tier
 * 1, the rest tier 2. LOD 0 (near) = every tier, 4 rows (7 vertices, 5 triangles); LOD 1 (mid) = tiers 0–1, 3 rows (5
 * vertices, 3 triangles); LOD 2 (far) = tier 0, one triangle. About 12 % of the clumps also carry a flower in LODs 0–1:
 * a stem (1 triangle) and a 10-point star head (10 triangles).
 */
import { GRASS_CELL_M } from './shaders.ts'

/** The blade density of a grass level (GRASS_LIFE §3.3). */
export interface GrassDensity {
  /** Clumps per cell side. */
  clumpGrid: number
  /** Blades per clump (tier 0: 1, tier 1: 2, tier 2: the rest). */
  blades: number
}

export type GrassLod = 0 | 1 | 2
export const GRASS_LODS: readonly GrassLod[] = [0, 1, 2]

export interface GrassPatch {
  lod: GrassLod
  /** (side −1 | 0 | 1, t 0..1, kind 0 blade / 1 flower head / 2 stem). */
  positions: Float32Array
  /** (x, z in the cell 0..8 m, the clump's random value, tier). */
  bladeA: Float32Array
  /** (height, yaw, curve, colour randoms). */
  bladeB: Float32Array
  indices: Uint32Array
  vertices: number
  triangles: number
  /** Blades and flowers in the patch. */
  blades: number
  flowers: number
}

/** Share of the clumps that carry a flower. */
export const FLOWER_SHARE = 0.12

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

/** The patch of one LOD tier at `density` (deterministic in both). */
export function buildPatch(lod: GrassLod, density: GrassDensity, cellM = GRASS_CELL_M): GrassPatch {
  const { clumpGrid: grid, blades: perClump } = density
  const rnd = mulberry32(0x9e11 + grid)
  const pos: number[] = [], a: number[] = [], b: number[] = [], idx: number[] = []
  const rows = lod === 0 ? [0, 0.3, 0.62, 1] : lod === 1 ? [0, 0.55, 1] : [0, 1]
  const sp = cellM / grid
  let blades = 0
  let flowers = 0
  for (let gz = 0; gz < grid; gz++) {
    for (let gx = 0; gx < grid; gx++) {
      const cxp = (gx + 0.1 + 0.8 * rnd()) * sp
      const czp = (gz + 0.1 + 0.8 * rnd()) * sp
      const crand = rnd()
      const hasFlower = rnd() < FLOWER_SHARE
      for (let bl = 0; bl < perClump; bl++) {
        const tier = bl === 0 ? 0 : bl < 3 ? 1 : 2
        // Always six draws per blade: a blade left out of a tier never shifts another's numbers.
        const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd()
        const rr = Math.sqrt(rnd()) * 0.16, th = rnd() * Math.PI * 2
        if (tier > 0 && lod === 2) continue
        if (tier > 1 && lod === 1) continue
        const lx = cxp + Math.cos(th) * rr, lz = czp + Math.sin(th) * rr
        const base = pos.length / 3
        for (let ri = 0; ri < rows.length; ri++) {
          const t = rows[ri]!
          if (ri === rows.length - 1) {
            pos.push(0, t, 0)
            a.push(lx, lz, crand, tier)
            b.push(r1, r2, r3, r4)
          } else {
            for (const s of [-1, 1]) {
              pos.push(s, t, 0)
              a.push(lx, lz, crand, tier)
              b.push(r1, r2, r3, r4)
            }
          }
        }
        const nr = rows.length
        for (let ri = 0; ri < nr - 2; ri++) {
          const v = base + ri * 2
          idx.push(v, v + 1, v + 3, v, v + 3, v + 2)
        }
        const v = base + (nr - 2) * 2
        idx.push(v, v + 1, v + 2)
        blades++
      }
      if (hasFlower && lod < 2) {
        const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd()
        const fr = rnd()
        const s0 = pos.length / 3
        pos.push(-1, 0, 2, 1, 0, 2, 0, 1, 2)
        for (let k = 0; k < 3; k++) {
          a.push(cxp, czp, fr, 0)
          b.push(r1, r2, r3, r4)
        }
        idx.push(s0, s0 + 1, s0 + 2)
        const h0 = pos.length / 3
        pos.push(0, 0, 1)
        for (let k = 0; k < 10; k++) {
          const ang = (k / 10) * Math.PI * 2
          const rad = k % 2 ? 0.45 : 1
          pos.push(Math.cos(ang) * rad, Math.sin(ang) * rad, 1)
        }
        for (let k = 0; k < 11; k++) {
          a.push(cxp, czp, fr, 0)
          b.push(r1, r2, r3, r4)
        }
        for (let k = 0; k < 10; k++) idx.push(h0, h0 + 1 + k, h0 + 1 + ((k + 1) % 10))
        flowers++
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
    blades,
    flowers,
  }
}

/** Blades per m² of a density (every tier). */
export function bladesPerM2(density: GrassDensity, cellM = GRASS_CELL_M): number {
  return (density.clumpGrid * density.clumpGrid * density.blades) / (cellM * cellM)
}
