import { STRIKE_RADIUS_M, type StrikeKind } from '@sro/shared'
import type { Rod } from './rods.ts'

/**
 * Where a strike lands (docs/WEATHER.md §2.7). Pure: the service hands in what lies around one player (the anchor) and
 * a random source; tests drive it with fixed inputs.
 *
 * - **Classes per roll**: SKY_SHARE a flash inside the cloud (harmless), NEAR_SHARE near the anchor, the rest far
 *   (FAR_M from it): thunder from a distance, still a real strike on the spot it lands.
 * - **Near**: a weighted draw among the rods (trees, wall walks, towers), the bodies (players and monsters) and
 *   GROUND_SAMPLES random ground points within NEAR_M of the anchor; CLOSE_SHARE of the near strikes look only within
 *   CLOSE_M (close calls, so players see strikes happen around them). Weight = base(kind) × heightWeight(height above
 *   the local ground): tall things are hit more often, a body on high ground more than one in a valley.
 * - **Safe areas** (town interiors): nothing inside one is a target except a wall walk, so bolts still hit the outer
 *   walls (and the sky) but never the plaza.
 */

export const SKY_SHARE = 0.3
export const NEAR_SHARE = 0.5
export const NEAR_M = 80
export const CLOSE_M = 25
export const CLOSE_SHARE = 0.25
export const FAR_M = [300, 1800] as const
export const GROUND_SAMPLES = 12
/** A random ground point is never closer than this to the anchor (m): a plain ground strike is not aimed at a player. */
export const GROUND_MIN_M = 6
/** Sky flashes: this far from the anchor horizontally (m) and this high above it. */
export const SKY_M = [200, 1500] as const
export const SKY_HIGH_M = [300, 600] as const

/** The base weight of each kind, before the height factor. */
export const KIND_WEIGHT: Readonly<Record<'ground' | 'tree' | 'wall' | 'tower' | 'entity', number>> = { ground: 1, tree: 1, wall: 0.6, tower: 1, entity: 1.2 }

/** How much a height above the local ground (m) draws the bolt: (1 + h / 10)², capped at 30 m (16×). */
export function heightWeight(h: number): number {
  const c = Math.min(30, Math.max(0, h))
  return (1 + c / 10) ** 2
}

/** A body that may be struck: its feet, and how far it stands above the ground around it (m). */
export interface Body {
  id: number
  x: number
  y: number
  z: number
  /** Body height (m): ~1.8 for a player. */
  height: number
  /** Feet above the mean ground PROMINENCE_M around (0 in a valley or on flat ground). */
  prominence: number
}

/** A placed target: the strike's point, the ground under it and the entity it was aimed at. */
export interface StrikeTarget {
  kind: StrikeKind
  x: number
  y: number
  z: number
  ground: number
  radiusM: number
  target?: number
}

export interface NearInput {
  anchor: { x: number; z: number }
  rods: readonly Rod[]
  bodies: readonly Body[]
  /** Ground height at x/z (null: no ground there, e.g. outside the world). */
  ground(x: number, z: number): number | null
  /** Inside a safe area (a town interior). */
  safe(x: number, z: number): boolean
  rng: () => number
  /** Only within this radius of the anchor (default NEAR_M). */
  within?: number
}

interface Weighted extends StrikeTarget {
  w: number
}

/** A near strike around the anchor, or null when nothing there may be struck. */
export function pickNear(i: NearInput): StrikeTarget | null {
  const r = i.within ?? NEAR_M
  const out: Weighted[] = []
  const inside = (x: number, z: number) => (x - i.anchor.x) ** 2 + (z - i.anchor.z) ** 2 <= r * r
  for (const rod of i.rods) {
    if (!inside(rod.x, rod.z)) continue
    if (rod.kind !== 'wall' && i.safe(rod.x, rod.z)) continue
    out.push({ kind: rod.kind, x: rod.x, y: rod.y, z: rod.z, ground: rod.ground, radiusM: STRIKE_RADIUS_M[rod.kind], w: KIND_WEIGHT[rod.kind] * heightWeight(rod.y - rod.ground) })
  }
  for (const b of i.bodies) {
    if (!inside(b.x, b.z) || i.safe(b.x, b.z)) continue
    out.push({ kind: 'entity', x: b.x, y: b.y, z: b.z, ground: b.y, radiusM: STRIKE_RADIUS_M.entity, target: b.id, w: KIND_WEIGHT.entity * heightWeight(b.height + b.prominence) })
  }
  for (let k = 0; k < GROUND_SAMPLES; k++) {
    const a = i.rng() * Math.PI * 2
    const d = Math.min(r, GROUND_MIN_M) + Math.sqrt(i.rng()) * Math.max(0, r - GROUND_MIN_M)
    const x = i.anchor.x + Math.cos(a) * d
    const z = i.anchor.z + Math.sin(a) * d
    if (i.safe(x, z)) continue
    const y = i.ground(x, z)
    if (y === null || !Number.isFinite(y)) continue
    out.push({ kind: 'ground', x, y, z, ground: y, radiusM: STRIKE_RADIUS_M.ground, w: KIND_WEIGHT.ground })
  }
  const total = out.reduce((s, c) => s + c.w, 0)
  if (!(total > 0)) return null
  let pick = i.rng() * total
  for (const c of out) {
    pick -= c.w
    if (pick < 0) return strip(c)
  }
  return strip(out[out.length - 1]!)
}

function strip(c: Weighted): StrikeTarget {
  const { w: _w, ...t } = c
  return t
}

/** A far ground strike FAR_M from the anchor (null: no open, unsafe ground there after a few tries). */
export function pickFar(i: Pick<NearInput, 'anchor' | 'ground' | 'safe' | 'rng'> & { clamp(x: number, z: number): [number, number] }, dist?: number): StrikeTarget | null {
  for (let k = 0; k < 6; k++) {
    const a = i.rng() * Math.PI * 2
    const d = dist ?? FAR_M[0] + (FAR_M[1] - FAR_M[0]) * i.rng()
    const [x, z] = i.clamp(i.anchor.x + Math.cos(a) * d, i.anchor.z + Math.sin(a) * d)
    // a point the world bounds pulled back is no longer `d` away: try another direction
    if (dist !== undefined && Math.abs(Math.hypot(x - i.anchor.x, z - i.anchor.z) - dist) > 1) continue
    if (i.safe(x, z)) continue
    const y = i.ground(x, z)
    if (y === null || !Number.isFinite(y)) continue
    return { kind: 'ground', x, y, z, ground: y, radiusM: STRIKE_RADIUS_M.ground }
  }
  return null
}

/** A flash inside the cloud, SKY_M from the anchor and SKY_HIGH_M above it. */
export function pickSky(anchor: { x: number; y: number; z: number }, rng: () => number): StrikeTarget {
  const a = rng() * Math.PI * 2
  const d = SKY_M[0] + (SKY_M[1] - SKY_M[0]) * rng()
  const y = anchor.y + SKY_HIGH_M[0] + (SKY_HIGH_M[1] - SKY_HIGH_M[0]) * rng()
  return { kind: 'sky', x: anchor.x + Math.cos(a) * d, y, z: anchor.z + Math.sin(a) * d, ground: anchor.y, radiusM: 0 }
}

/** Which class a roll is: 'sky', 'near' or 'far'. */
export function strikeClass(u: number): 'sky' | 'near' | 'far' {
  return u < SKY_SHARE ? 'sky' : u < SKY_SHARE + NEAR_SHARE ? 'near' : 'far'
}
