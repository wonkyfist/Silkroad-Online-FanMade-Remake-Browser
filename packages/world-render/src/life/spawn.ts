/**
 * Where the wildlife lives (docs/GRASS_LIFE.md §5.1–§5.5, §8.3; lane GL-L): the CPU queries the life part spawns from,
 * with no dependency on the grass field (GL-F) being up.
 *
 * - **The ground** (`LifeGround`): the terrain height, the grass density of the terrain tiles (the tile's
 *   `tiles[].grass.weight` from GL-C when the export has it, else the retail scatter's density table, with the scatter's
 *   bare-corner, fringe and slope rules), a meadow mask (two octaves of value noise, 22 m and 6 m, through a smoothstep,
 *   times the density: flowers and butterflies come in drifts), the inland water surface (the retail water planes, never
 *   the coast's open sea) and the object-floor test (a nav object surface over the ground: plazas, bridges, houses).
 *   A field that answers `densityAt` / `meadowAt` itself (GL-F's, duck-typed) is asked first.
 * - **The placements** (`LifePlaces`, built once from the manifest): the placed flower models (`flw_*`, `grs_flower*`:
 *   the butterflies' second anchor source, GRASS_LIFE §5.2 fact-check; the stage's flower beds stand on paving), the
 *   trees (fireflies gather near them) and the roof perches (GRASS_LIFE §5.3 fact-check: the top face of each building
 *   model's bounds along its long axis, transformed by the placement; no converter change, no new file).
 * - **Cells** (`LifeCells`): the world in 16 m cells, each seeded by (cell, game hour), holding its butterfly,
 *   dragonfly and firefly candidates. A spot keeps "its" animals while the player stays (GRASS_LIFE Q11); cells are
 *   filled a few per frame (never a spike), cached, and dropped oldest first.
 */
import type { WorldManifest, WorldModel, WorldPlacement } from '../../../convert/src/world/manifest.ts'
import { GRID } from '../../../convert/src/world/format.ts'
import { modelStem } from '../grass/types.ts'
import { placementScale } from '../placement-scale.ts'
import { mulberry32 } from '../scatter-assets.ts'
import { tileScatterDensity } from '../scatter.ts'
import type { World } from '../world.ts'

export { mulberry32 }

/** The cell of the spawn cache (m). */
export const LIFE_CELL_M = 16

/** A stable 32-bit hash of three integers (cells, hours, seeds). */
export function lifeHash(a: number, b: number, c: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x632be5ab, 0x85ebca77) ^ Math.imul((c | 0) + 0x1b873593, 0xc2b2ae35)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

const fract = (v: number) => v - Math.floor(v)
function hash2(x: number, z: number): number {
  const rx = fract(x * 0.1031), rz = fract(z * 0.103)
  const d = rx * (rz + 33.33) + rz * (rx + 33.33)
  return fract((rx + d + rz + d) * (rx + d))
}
function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1)
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz
}
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The meadow mask's noise at glTF (x, z), 0..1 (before the density): two octaves, 22 m and 6 m. */
export function meadowNoise(x: number, z: number): number {
  return smoothstep(0.42, 0.72, 0.65 * valueNoise(x / 22 + 17.3, z / 22 - 5.1) + 0.35 * valueNoise(x / 6 - 3.7, z / 6 + 11.9))
}

// ---- the ground ----------------------------------------------------------------------------------------------------

/** What the wildlife asks of the ground (glTF metres). */
export interface LifeGround {
  /** The terrain height, or null outside the loaded regions. */
  heightAt(x: number, z: number): number | null
  /** The highest of the terrain and any water surface there (the sea included): what a flying bird stays above. */
  surfaceAt(x: number, z: number): number | null
  /** The grass density 0..1 (0: paving, roads, rock, water, steep or bare ground). */
  densityAt(x: number, z: number): number
  /** The meadow mask 0..1 (flower drifts; 0 where no grass). */
  meadowAt(x: number, z: number): number
  /** The inland water surface at (x, z) (a retail water plane above the ground, not the open sea), or null. */
  waterAt(x: number, z: number): number | null
  /** An object floor (plaza, bridge, house) covers the ground point (x, groundY, z). */
  floorAt(x: number, z: number, groundY: number): boolean
}

/** A field that answers density and meadow queries itself (GL-F's, optional, duck-typed). */
interface FieldQueries {
  densityAt(x: number, z: number): number
  meadowAt(x: number, z: number): number
}
function fieldQueries(v: unknown): FieldQueries | null {
  const f = v as Partial<FieldQueries> | null | undefined
  return f && typeof f.densityAt === 'function' && typeof f.meadowAt === 'function' ? (f as FieldQueries) : null
}

/** The scatter's rules (scatter.ts scatterChunk): a cell with a bare corner, only fringe types, or steep is bare. */
const FRINGE_MIN = 0.2
const SLOPE_MIN_Y = 0.72

/** tile2d id → the life's grass density: GL-C's `grass.weight` when the export has it, else the scatter's table. */
export function lifeDensityTable(tiles: WorldManifest['tiles']): Map<number, number> {
  const m = new Map<number, number>()
  for (const t of tiles) m.set(t.id, t.grass ? Math.max(0, Math.min(1, t.grass.weight)) : tileScatterDensity(t))
  return m
}

/** The world's ground for the wildlife (regions, nav, water blocks, the coast's sea mask; GL-F's field when it answers). */
export function worldGround(world: World): LifeGround {
  const table = lifeDensityTable(world.manifest.tiles)
  const regions = world.regions
  const terrainDensity = (x: number, z: number): number => {
    const hit = regions.locate(x, z)
    if (!hit) return 0
    const t = hit.data.terrain
    const gx = Math.min(GRID - 2, Math.max(0, Math.floor(hit.lx / 20)))
    const gz = Math.min(GRID - 2, Math.max(0, Math.floor(hit.lz / 20)))
    const tex = t.textures
    const at = (i: number, j: number) => table.get(tex[j * GRID + i]! & 0x3ff) ?? 0
    const a = at(gx, gz), b = at(gx + 1, gz), c = at(gx, gz + 1), d = at(gx + 1, gz + 1)
    if (!(a > 0 && b > 0 && c > 0 && d > 0) || Math.max(a, b, c, d) < FRINGE_MIN) return 0
    const n = t.normals
    if (n && n.length) {
      const o = (gz * GRID + gx) * 4
      const l = Math.hypot(n[o]!, n[o + 1]!, n[o + 2]!)
      if (l > 0 && n[o + 1]! / l < SLOPE_MIN_Y) return 0
    }
    const bx = Math.min(5, Math.floor(hit.lx / 320)), bz = Math.min(5, Math.floor(hit.lz / 320))
    const w = hit.data.region.blocks[bz * 6 + bx]?.water
    if (w) {
      const y = regions.heightAt(x, z)
      if (y !== null && y < hit.data.region.origin[1] + w.heightM + 0.05) return 0
    }
    return (a + b + c + d) / 4
  }
  const field = () => fieldQueries(world.scatter.groundCover)
  return {
    heightAt: (x, z) => regions.heightAt(x, z),
    surfaceAt: (x, z) => {
      const g = regions.heightAt(x, z)
      const w = world.waterLevelAt(x, z)
      return g === null ? w : w === null ? g : Math.max(g, w)
    },
    densityAt: (x, z) => field()?.densityAt(x, z) ?? terrainDensity(x, z),
    meadowAt: (x, z) => {
      const f = field()
      if (f) return f.meadowAt(x, z)
      const d = terrainDensity(x, z)
      return d > 0 ? d * meadowNoise(x, z) : 0
    },
    waterAt: (x, z) => {
      const hit = regions.blockAt(x, z)
      const w = hit?.block.water
      if (!hit || !w || w.kind !== 'water') return null
      if (world.coast?.seaAt(x, z)) return null
      const level = hit.region.origin[1] + w.heightM
      const g = regions.heightAt(x, z)
      return g !== null && g < level - 0.1 ? level : null
    },
    floorAt: (x, z, groundY) => {
      try {
        const p = world.locate(x, z, Infinity)
        return !!p && p.surface.kind === 'object' && p.y > groundY - 0.3
      } catch {
        return false
      }
    },
  }
}

// ---- the placements -------------------------------------------------------------------------------------------------

/** Points in 32 m buckets (x, y, z per point), queried without allocation. */
export class LifePoints {
  private readonly buckets = new Map<number, number[]>()
  count = 0
  static readonly BUCKET_M = 32

  private static key(bx: number, bz: number): number {
    return (bx + 32768) * 65536 + (bz + 32768)
  }

  add(x: number, y: number, z: number): void {
    const k = LifePoints.key(Math.floor(x / LifePoints.BUCKET_M), Math.floor(z / LifePoints.BUCKET_M))
    let b = this.buckets.get(k)
    if (!b) this.buckets.set(k, (b = []))
    b.push(x, y, z)
    this.count++
  }

  /** Calls `fn(x, y, z)` for every point within `r` (2D) of (x, z). */
  near(x: number, z: number, r: number, fn: (px: number, py: number, pz: number) => void): void {
    const B = LifePoints.BUCKET_M
    const bx0 = Math.floor((x - r) / B), bx1 = Math.floor((x + r) / B)
    const bz0 = Math.floor((z - r) / B), bz1 = Math.floor((z + r) / B)
    const r2 = r * r
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const b = this.buckets.get(LifePoints.key(bx, bz))
        if (!b) continue
        for (let i = 0; i < b.length; i += 3) {
          const dx = b[i]! - x, dz = b[i + 2]! - z
          if (dx * dx + dz * dz <= r2) fn(b[i]!, b[i + 1]!, b[i + 2]!)
        }
      }
    }
  }

  /** Whether any point lies within `r` (2D) of (x, z). */
  any(x: number, z: number, r: number): boolean {
    let hit = false
    this.near(x, z, r, () => {
      hit = true
    })
    return hit
  }
}

const pathOf = (source: string) => source.replace(/\\/g, '/').toLowerCase()

/** A placed flower model (GRASS_LIFE §5.2: `flw_*`, `grs_flower*`). */
export function isFlowerModel(model: Pick<WorldModel, 'source'>): boolean {
  const s = modelStem(model.source)
  return s.startsWith('flw_') || s.startsWith('grs_flower')
}

/** A tree model (the nature tree folders, `tre_*`). */
export function isTreeModel(model: Pick<WorldModel, 'source'>): boolean {
  return pathOf(model.source).includes('/nature/common/tree/') || modelStem(model.source).startsWith('tre_')
}

/** A building model (`res/bldg/...`): its roof carries perches. */
export function isBuildingModel(model: Pick<WorldModel, 'source'>): boolean {
  return pathOf(model.source).includes('res/bldg/')
}

/** Rotates model-space (x, y, z) by the glTF quaternion q = (x, y, z, w). */
function rotate(q: readonly number[], x: number, y: number, z: number): [number, number, number] {
  const qx = q[0] ?? 0, qy = q[1] ?? 0, qz = q[2] ?? 0, qw = q[3] ?? 1
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x)
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)]
}

/** Perch heights and sizes a building model must have (m): sheds and huge walls carry none. */
const PERCH_MIN_HEIGHT_M = 2.5
const PERCH_MIN_LENGTH_M = 3
const PERCH_MAX_LENGTH_M = 90

/**
 * A building model's perches (GRASS_LIFE §5.3 fact-check): two points on the top face of its bounds, on the long axis
 * at ±25 % of its length, at the top, transformed by the placement. Empty for models too low, too short or too long.
 */
export function perchPointsOf(model: Pick<WorldModel, 'boundsMin' | 'boundsMax'>, placement: Pick<WorldPlacement, 'position' | 'rotation' | 'scale'>): Array<[number, number, number]> {
  // W12-SA (S-SCALE): the placement's uniform scale applies to the model's bounds (absent: 1).
  const k = placementScale(placement)
  const [x0, y0, z0] = k === 1 ? model.boundsMin : model.boundsMin.map(v => v * k)
  const [x1, y1, z1] = k === 1 ? model.boundsMax : model.boundsMax.map(v => v * k)
  const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0
  const long = Math.max(sx, sz)
  if (!(sy >= PERCH_MIN_HEIGHT_M) || !(long >= PERCH_MIN_LENGTH_M) || long > PERCH_MAX_LENGTH_M) return []
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
  const out: Array<[number, number, number]> = []
  for (const s of [-0.25, 0.25]) {
    const lx = sx >= sz ? cx + s * sx : cx
    const lz = sx >= sz ? cz : cz + s * sz
    const [rx, ry, rz] = rotate(placement.rotation, lx, y1, lz)
    const p = placement.position
    out.push([p[0] + rx, p[1] + ry, p[2] + rz])
  }
  return out
}

/** The placements the wildlife uses, from the manifest (built once per life part). */
export class LifePlaces {
  readonly flowers = new LifePoints()
  readonly trees = new LifePoints()
  readonly perches = new LifePoints()

  constructor(manifest: Pick<WorldManifest, 'models' | 'placements'>) {
    const kinds = manifest.models.map(m => (m.kind === 'failed' ? 0 : isFlowerModel(m) ? 1 : isTreeModel(m) ? 2 : isBuildingModel(m) ? 3 : 0))
    for (const pl of manifest.placements) {
      const [x, y, z] = pl.position
      let flower = false, tree = false
      for (const i of pl.models) {
        const k = kinds[i] ?? 0
        if (k === 1) flower = true
        else if (k === 2) tree = true
        else if (k === 3) for (const p of perchPointsOf(manifest.models[i]!, pl)) this.perches.add(p[0], p[1], p[2])
      }
      if (flower) this.flowers.add(x, y, z)
      if (tree) this.trees.add(x, y, z)
    }
  }
}

const PLACES = new WeakMap<object, LifePlaces>()

/** The manifest's LifePlaces, built once per manifest (a render-path switch makes a new life part, not new places). */
export function lifePlacesOf(manifest: Pick<WorldManifest, 'models' | 'placements'>): LifePlaces {
  let p = PLACES.get(manifest)
  if (!p) PLACES.set(manifest, (p = new LifePlaces(manifest)))
  return p
}

// ---- cells: seeded candidates per 16 m cell and game hour -------------------------------------------------------------

/** Floats per candidate: x, y (the anchor's ground, or the water surface), z, seed 0..1, radius (m), species. */
export const CANDIDATE_STRIDE = 6

/** The candidates of one cell for one game hour. */
export interface CellLife {
  /** The cell's cache key (cellKey). */
  key: number
  cx: number
  cz: number
  /** Butterfly anchors (meadow and placed flowers), CANDIDATE_STRIDE floats each. */
  butterflies: Float32Array
  /** Dragonfly anchors over inland water (y = the water surface). */
  dragonflies: Float32Array
  /** Firefly anchors on grass near trees and water (y = the ground). */
  fireflies: Float32Array
  /** Some inland water in the cell. */
  water: boolean
}

/** Butterfly species weights (GRASS_LIFE §5.2: monarch, cabbage white, brimstone, blue; critter ids 0..3). */
const BUTTERFLY_ROLL = [0.3, 0.6, 0.8, 1]

/**
 * The butterflies' anchor height over a wander disc of radius `r`: the highest ground on the rim and at the centre
 * (so the flight, which knows only the anchor's height without the grass field, never dips into a slope), and the
 * ground's relief there (a disc on a slope steeper than `maxRelief` is refused by the caller).
 */
export function discHeight(ground: Pick<LifeGround, 'heightAt'>, x: number, z: number, r: number): { top: number; relief: number } | null {
  let top = -Infinity, low = Infinity
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI * 2
    const h = k === 8 ? ground.heightAt(x, z) : ground.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r)
    if (h === null) return null
    if (h > top) top = h
    if (h < low) low = h
  }
  return { top, relief: top - low }
}

/** The steepest relief (m) a meadow butterfly's wander disc may have. */
export const BUTTERFLY_MAX_RELIEF_M = 0.8

/**
 * Candidates tried per 16 m cell: enough for High's 40 butterflies within 30 m on a lush meadow (≈ 11 cells) and 120
 * fireflies within 40 m near trees (≈ 20 cells); thin grass and bare ground keep fewer.
 */
const BUTTERFLY_TRIES = 10
const FIREFLY_TRIES = 8

/** Builds one cell's candidates (deterministic in the cell, the hour and the world). */
export function buildCell(ground: LifeGround, places: LifePlaces, cx: number, cz: number, hour: number): CellLife {
  const S = LIFE_CELL_M
  const x0 = cx * S, z0 = cz * S
  const rnd = mulberry32(lifeHash(cx, cz, hour))
  const bf: number[] = []
  const df: number[] = []
  const ff: number[] = []
  // Butterflies on the meadow (GRASS_LIFE §5.2, the lab's rule: density ≥ 0.3, more where the meadow mask is high).
  for (let k = 0; k < BUTTERFLY_TRIES; k++) {
    const x = x0 + rnd() * S, z = z0 + rnd() * S
    const accept = rnd(), seed = rnd(), species = rnd(), rad = 2 + rnd() * 4
    const d = ground.densityAt(x, z)
    if (d < 0.3 || accept > 0.25 + ground.meadowAt(x, z)) continue
    const disc = discHeight(ground, x, z, rad)
    if (!disc || disc.relief > BUTTERFLY_MAX_RELIEF_M) continue
    if (ground.floorAt(x, z, disc.top)) continue
    bf.push(x, disc.top, z, seed, rad, BUTTERFLY_ROLL.findIndex(v => species < v))
  }
  // And over the placed flowers (the stage's beds, town gardens: often on paving), at most two per cell, close by.
  let flowers = 0
  places.flowers.near(x0 + S / 2, z0 + S / 2, S * 0.7072, (x, y, z) => {
    if (x < x0 || x >= x0 + S || z < z0 || z >= z0 + S || flowers >= 2) return
    const seed = rnd(), species = rnd()
    if (rnd() > 0.7) return
    flowers++
    bf.push(x, y, z, seed, 1.5 + seed, BUTTERFLY_ROLL.findIndex(v => species < v))
  })
  // Water: dragonflies over it (0.3–1.2 m above the surface), and the cell remembers it for the fireflies.
  let water = false
  for (let k = 0; k < 6; k++) {
    const x = x0 + rnd() * S, z = z0 + rnd() * S
    const seed = rnd(), species = rnd()
    const w = ground.waterAt(x, z)
    if (w === null) continue
    water = true
    df.push(x, w, z, seed, 2 + seed, species < 0.5 ? 4 : 5)
  }
  // Fireflies on grass, gathering near trees (and near water: the caller adds the neighbours' water).
  for (let k = 0; k < FIREFLY_TRIES; k++) {
    const x = x0 + rnd() * S, z = z0 + rnd() * S
    const seed = rnd(), accept = rnd()
    const d = ground.densityAt(x, z)
    if (d < 0.3) continue
    const nearTree = places.trees.any(x, z, 14)
    if (!nearTree && !water && accept > 0.35) continue
    const y = ground.heightAt(x, z)
    if (y === null || ground.floorAt(x, z, y)) continue
    ff.push(x, y, z, seed, nearTree || water ? 1 : 0, 0)
  }
  return {
    key: cellKey(cx, cz, hour), cx, cz,
    butterflies: new Float32Array(bf), dragonflies: new Float32Array(df), fireflies: new Float32Array(ff), water,
  }
}

/** A cell's cache key: (cell x, cell z, game hour mod 4096) packed in one exact double. */
export function cellKey(cx: number, cz: number, hour: number): number {
  return ((cx + 32768) * 65536 + (cz + 32768)) * 4096 + (((hour % 4096) + 4096) % 4096)
}

/**
 * The cell cache around the focus: `fill` builds at most `budget` missing cells per call (nearest first), `gather`
 * collects the candidates of one kind within a radius, nearest first.
 */
export class LifeCells {
  private readonly cells = new Map<number, CellLife>()
  private readonly order: number[] = []
  /** The last complete fill (x, z, r, hour): a focus that has not moved needs no scan. */
  private readonly done = new Float64Array([NaN, NaN, NaN, NaN])
  /** Cells built so far (tests, the probe); a gather after a new cell may find more. */
  built = 0

  constructor(private readonly ground: LifeGround, private readonly places: LifePlaces, private readonly maxCells = 240) {}

  private static key(cx: number, cz: number, hour: number): number {
    return cellKey(cx, cz, hour)
  }

  get(cx: number, cz: number, hour: number): CellLife | undefined {
    return this.cells.get(LifeCells.key(cx, cz, hour))
  }

  /** Builds up to `budget` missing cells within `r` of (x, z) for `hour`, nearest first; true when all are there. */
  fill(x: number, z: number, r: number, hour: number, budget: number): boolean {
    const d = this.done
    if (hour === d[3] && r === d[2] && Math.abs(x - d[0]!) < 1 && Math.abs(z - d[1]!) < 1) return true
    const S = LIFE_CELL_M
    const c0x = Math.floor((x - r) / S), c1x = Math.floor((x + r) / S)
    const c0z = Math.floor((z - r) / S), c1z = Math.floor((z + r) / S)
    let missing: Array<{ cx: number; cz: number; d: number }> | null = null
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (this.cells.has(LifeCells.key(cx, cz, hour))) continue
        const d = Math.hypot((cx + 0.5) * S - x, (cz + 0.5) * S - z)
        if (d > r + S * 0.7072) continue
        ;(missing ??= []).push({ cx, cz, d })
      }
    }
    if (!missing) {
      d[0] = x
      d[1] = z
      d[2] = r
      d[3] = hour
      return true
    }
    missing.sort((a, b) => a.d - b.d)
    for (let i = 0; i < missing.length && i < budget; i++) {
      const m = missing[i]!
      const cell = buildCell(this.ground, this.places, m.cx, m.cz, hour)
      this.cells.set(cell.key, cell)
      this.order.push(cell.key)
      this.built++
    }
    while (this.order.length > this.maxCells) this.cells.delete(this.order.shift()!)
    return missing.length <= budget
  }

  /**
   * The candidates of `kind` within `r` of (x, z) for `hour`, nearest first, at most `max`: written to `out`
   * (CANDIDATE_STRIDE floats each); returns the count.
   */
  gather(kind: 'butterflies' | 'dragonflies' | 'fireflies', x: number, z: number, r: number, hour: number, max: number, out: Float32Array): number {
    const S = LIFE_CELL_M
    const c0x = Math.floor((x - r) / S), c1x = Math.floor((x + r) / S)
    const c0z = Math.floor((z - r) / S), c1z = Math.floor((z + r) / S)
    const found: Array<{ d: number; src: Float32Array; o: number }> = []
    const r2 = r * r
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const cell = this.cells.get(LifeCells.key(cx, cz, hour))
        if (!cell) continue
        const src = cell[kind]
        let waterNear = cell.water
        if (kind === 'fireflies' && !waterNear) {
          for (let dz = -1; dz <= 1 && !waterNear; dz++) for (let dx = -1; dx <= 1 && !waterNear; dx++) waterNear = !!this.cells.get(LifeCells.key(cx + dx, cz + dz, hour))?.water
        }
        for (let o = 0; o < src.length; o += CANDIDATE_STRIDE) {
          const dx = src[o]! - x, dz = src[o + 2]! - z
          const d2 = dx * dx + dz * dz
          if (d2 > r2) continue
          // Fireflies away from trees and water thin out (GRASS_LIFE §5.4: near trees and water).
          if (kind === 'fireflies' && src[o + 4]! < 0.5 && !waterNear && src[o + 3]! > 0.35) continue
          found.push({ d: d2, src, o })
        }
      }
    }
    found.sort((a, b) => a.d - b.d)
    const n = Math.min(max, found.length, Math.floor(out.length / CANDIDATE_STRIDE))
    for (let i = 0; i < n; i++) {
      const f = found[i]!
      for (let k = 0; k < CANDIDATE_STRIDE; k++) out[i * CANDIDATE_STRIDE + k] = f.src[f.o + k]!
    }
    return n
  }

  clear(): void {
    this.cells.clear()
    this.order.length = 0
    this.done.fill(NaN)
  }
}

// ---- landing spots ----------------------------------------------------------------------------------------------------

/** The minimum grass density of a ground flock's landing spot (GRASS_LIFE §5.3: open grass). */
export const LANDING_DENSITY = 0.5
/** A landing spot keeps this far from every threat (m): beyond the 9 m flush distance, with a margin. */
export const LANDING_CLEAR_M = 13

/**
 * A ground flock's landing spot (GRASS_LIFE §5.3): open grass (density ≥ 0.5, no object floor, no water) 14–24 m from
 * the focus and at least LANDING_CLEAR_M from every threat; null when `tries` samples find none.
 */
export function findLanding(
  ground: LifeGround, rnd: () => number, focusX: number, focusZ: number, threats: readonly { x: number; y: number; z: number }[], tries = 24,
): { x: number; y: number; z: number } | null {
  for (let k = 0; k < tries; k++) {
    const a = rnd() * Math.PI * 2, d = 14 + rnd() * 10
    const x = focusX + Math.cos(a) * d, z = focusZ + Math.sin(a) * d
    let clear = true
    for (const t of threats) {
      if ((t.x - x) ** 2 + (t.z - z) ** 2 < LANDING_CLEAR_M * LANDING_CLEAR_M) {
        clear = false
        break
      }
    }
    if (!clear || ground.densityAt(x, z) < LANDING_DENSITY) continue
    const y = ground.heightAt(x, z)
    if (y === null || ground.waterAt(x, z) !== null || ground.floorAt(x, z, y)) continue
    return { x, y, z }
  }
  return null
}
