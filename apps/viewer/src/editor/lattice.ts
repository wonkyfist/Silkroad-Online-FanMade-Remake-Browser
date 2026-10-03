/**
 * The World Editor's global 2 m lattice (docs/WORLD_EDITOR.md §4.1, "brush math"): every terrain vertex of the export
 * has one global index (GX = 96 rx + gx, GZ = 96 rz + gz). A vertex on a region seam belongs to two (or, on a corner,
 * four) regions; a brush writes it once into every region holding it, so seams stay bit-identical.
 *
 * Frame: the manifest's glTF metres (x east, z = -north); region (rx, rz)'s south-west corner sits at
 * [192 (rx - ox), 0, -192 (rz - oz)] and its vertex (gx, gz) at [origin.x + 2 gx, h, origin.z - 2 gz]. Region ids are
 * z << 8 | x. Allocation-free: the holder lists go into a caller's buffer.
 */
export const CELLS = 96
export const GRID = 97
export const CELL_M = 2
export const REGION_M = 192

export const regionIdOf = (rx: number, rz: number) => ((rz & 0xff) << 8) | (rx & 0xff)
export const regionX = (id: number) => id & 0xff
export const regionZ = (id: number) => (id >> 8) & 0xff

/** A global lattice vertex as one number (GX, GZ < 65536). */
export const latticeKey = (GX: number, GZ: number) => GX * 65536 + GZ
export const keyGX = (k: number) => Math.floor(k / 65536)
export const keyGZ = (k: number) => k % 65536

export class Lattice {
  /** Up to 4 holders: [regionId, vertexIndex] pairs. */
  readonly holders = new Int32Array(8)

  constructor(
    /** The manifest's space.originRegion. */
    readonly ox: number,
    readonly oz: number,
    /** Whether a region exists in the export (no layer exists outside it, §7.3). */
    readonly exists: (id: number) => boolean,
  ) {}

  /** glTF x / z (m) to fractional lattice coordinates, and back. */
  toGX(x: number): number {
    return x / CELL_M + this.ox * CELLS
  }
  toGZ(z: number): number {
    return -z / CELL_M + this.oz * CELLS
  }
  x(GX: number): number {
    return CELL_M * (GX - this.ox * CELLS)
  }
  z(GZ: number): number {
    return -CELL_M * (GZ - this.oz * CELLS)
  }

  /**
   * Writes the existing regions holding lattice vertex (GX, GZ) into `holders` as (id, index) pairs and returns how
   * many: 1 inside a region, 2 on a seam, 4 on a corner (fewer where a neighbour is missing).
   */
  holdersOf(GX: number, GZ: number): number {
    const rx0 = Math.floor(GX / CELLS), rz0 = Math.floor(GZ / CELLS)
    const onX = GX - rx0 * CELLS === 0, onZ = GZ - rz0 * CELLS === 0
    let n = 0
    for (let a = 0; a < (onZ ? 2 : 1); a++) {
      const rz = rz0 - a
      for (let b = 0; b < (onX ? 2 : 1); b++) {
        const rx = rx0 - b
        const id = regionIdOf(rx, rz)
        if (!this.exists(id)) continue
        const gx = GX - rx * CELLS, gz = GZ - rz * CELLS
        this.holders[n * 2] = id
        this.holders[n * 2 + 1] = gz * GRID + gx
        n++
      }
    }
    return n
  }

  /**
   * The export-edge fade (§7.3): 1 inside, falling linearly to 0 over the last `fadeM` metres before a region the
   * export does not have (the 8 neighbours of the vertex's region are checked).
   */
  edgeFade(GX: number, GZ: number, fadeM: number): number {
    const rx = Math.floor(GX / CELLS), rz = Math.floor(GZ / CELLS)
    let best = Infinity
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const id = regionIdOf(rx + dx, rz + dz)
        if (this.exists(id) && (dx || dz)) continue
        if (!dx && !dz) {
          if (!this.exists(id)) return 0
          continue
        }
        // distance (lattice steps) from the vertex to region (rx + dx, rz + dz)'s square
        const x0 = (rx + dx) * CELLS, z0 = (rz + dz) * CELLS
        const ex = GX < x0 ? x0 - GX : GX > x0 + CELLS ? GX - x0 - CELLS : 0
        const ez = GZ < z0 ? z0 - GZ : GZ > z0 + CELLS ? GZ - z0 - CELLS : 0
        best = Math.min(best, Math.hypot(ex, ez) * CELL_M)
      }
    }
    return best >= fadeM ? 1 : best / fadeM
  }
}

/** A deterministic hash of a lattice vertex and a seed to [0, 1) (paint dithering, noise lattice). */
export function hash01(GX: number, GZ: number, seed = 0): number {
  let h = (Math.imul(GX | 0, 0x27d4eb2d) ^ Math.imul(GZ | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Seeded value noise in [-1, 1] at lattice (GX, GZ) with `wavelength` lattice steps (smooth bilinear, smoothstep). */
export function valueNoise(GX: number, GZ: number, wavelength: number, seed: number): number {
  const w = Math.max(1, wavelength)
  const fx = GX / w, fz = GZ / w
  const ix = Math.floor(fx), iz = Math.floor(fz)
  const tx = fx - ix, tz = fz - iz
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz)
  const v = (a: number, b: number) => hash01(a, b, seed) * 2 - 1
  const a = v(ix, iz) + (v(ix + 1, iz) - v(ix, iz)) * sx
  const b = v(ix, iz + 1) + (v(ix + 1, iz + 1) - v(ix, iz + 1)) * sx
  return a + (b - a) * sz
}

/** The brush falloff: 1 in the hard core, smoothstep over the outer `softness` of the radius, 0 outside. */
export function falloff(d: number, radius: number, softness: number): number {
  if (radius <= 0) return 0
  const t = d / radius
  if (t >= 1) return 0
  const s = Math.max(0.05, Math.min(1, softness))
  const u = Math.min(1, (1 - t) / s)
  return u * u * (3 - 2 * u)
}
