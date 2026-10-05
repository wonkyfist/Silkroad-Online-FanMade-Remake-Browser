import { TORNADO_TABLE, type TornadoTable, type Vec3 } from '@sro/shared'

/**
 * The tornado's path (docs/WEATHER.md §13.2), pure: the service hands in what the world says about a point, tests drive
 * it with fixed worlds.
 *
 * - **Ground**: a point is good when it is open outdoor ground (`ground` gives its height: placeable on the navmesh,
 *   not inside a solid, not on a closed cell), not water, at least `townMarginM` from every town's safe area and
 *   `edgeMarginM` inside the world bounds.
 * - **Touchdown** (`pickStart`): `spawnM` from the anchor (the player it is drawn to; a GM's `here` asks for 0), at a
 *   random bearing, heading roughly back toward the anchor so it crosses the ground the players stand on.
 * - **Legs** (`planPath`): straight legs of `legM`, each checked every `sampleM` along its whole length. The heading
 *   wanders a little per leg; when a leg is blocked it turns (wider and wider, at last back the way it came). The path
 *   ends early when every turn is blocked (a dead end): the tornado then lifts when it gets there.
 */

export interface PathWorld {
  /** Height of open outdoor ground at x/z (null: not walkable, a closed cell, inside a solid, or water). */
  ground(x: number, z: number): number | null
  /** Distance (m) from x/z to the nearest town safe area (0 inside one, Infinity without towns). */
  townDist(x: number, z: number): number
  /** The world bounds (null: unbounded). */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number } | null
}

/** The turns tried when a leg is blocked (radians from the wandering heading), in order. */
const TURNS = [0, 0.45, -0.45, 0.9, -0.9, 1.5, -1.5, 2.2, -2.2, Math.PI]

/** A point the tornado may stand on (its ground height), or null. */
export function goodPoint(w: PathWorld, x: number, z: number, t: TornadoTable = TORNADO_TABLE): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null
  const b = w.bounds
  const m = t.edgeMarginM
  if (b && (x < b.minX + m || x > b.maxX - m || z < b.minZ + m || z > b.maxZ - m)) return null
  if (w.townDist(x, z) < t.townMarginM) return null
  const y = w.ground(x, z)
  return y === null || !Number.isFinite(y) ? null : y
}

/** The ground heights along a leg from (x0, z0) to (x1, z1), every `sampleM` (null when any sample is bad). */
export function goodLeg(w: PathWorld, x0: number, z0: number, x1: number, z1: number, t: TornadoTable = TORNADO_TABLE): number | null {
  const len = Math.hypot(x1 - x0, z1 - z0)
  const n = Math.max(1, Math.ceil(len / t.sampleM))
  let y: number | null = null
  for (let i = 1; i <= n; i++) {
    const f = i / n
    y = goodPoint(w, x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, t)
    if (y === null) return null
  }
  return y
}

/**
 * A touchdown point `dist` (default: uniform in spawnM) from the anchor, and the heading (atan2(dx, dz)) it sets off
 * on, roughly back toward the anchor. null when no good point was found in a dozen tries.
 */
export function pickStart(w: PathWorld, anchor: { x: number; z: number }, rng: () => number, t: TornadoTable = TORNADO_TABLE, dist?: number): { pos: Vec3; heading: number } | null {
  for (let k = 0; k < 16; k++) {
    const a = rng() * Math.PI * 2
    const d = dist ?? t.spawnM[0] + (t.spawnM[1] - t.spawnM[0]) * rng()
    // a GM's `here` (dist 0) widens to a few metres when the very spot is no good
    const r = dist === 0 ? k * 4 : d
    const x = anchor.x + Math.sin(a) * r
    const z = anchor.z + Math.cos(a) * r
    const y = goodPoint(w, x, z, t)
    if (y === null) continue
    const back = r > 1 ? Math.atan2(anchor.x - x, anchor.z - z) : a
    return { pos: [x, y, z], heading: back + (rng() - 0.5) * 1.2 }
  }
  return null
}

/** The path from `start` (its first point) for at least `lengthM` metres where the ground allows (see the header). */
export function planPath(w: PathWorld, start: { pos: Vec3; heading: number }, lengthM: number, rng: () => number, t: TornadoTable = TORNADO_TABLE, maxPoints = 96): Vec3[] {
  const path: Vec3[] = [[...start.pos]]
  let heading = start.heading
  let walked = 0
  while (walked < lengthM && path.length < maxPoints) {
    const at = path[path.length - 1]!
    heading += (rng() - 0.5) * 0.7
    const len = t.legM[0] + (t.legM[1] - t.legM[0]) * rng()
    let next: Vec3 | null = null
    for (const turn of TURNS) {
      const h = heading + turn
      const x = at[0] + Math.sin(h) * len
      const z = at[2] + Math.cos(h) * len
      const y = goodLeg(w, at[0], at[2], x, z, t)
      if (y === null) continue
      next = [x, y, z]
      heading = h
      break
    }
    if (!next) break
    path.push(next)
    walked += len
  }
  return path
}

/** Distance (m) from (x, z) to an axis-aligned rectangle (0 inside it). */
export function rectDist(x: number, z: number, r: { x: number; z: number; halfX: number; halfZ: number }): number {
  const dx = Math.max(0, Math.abs(x - r.x) - r.halfX)
  const dz = Math.max(0, Math.abs(z - r.z) - r.halfZ)
  return Math.hypot(dx, dz)
}
