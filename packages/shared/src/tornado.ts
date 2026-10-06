/**
 * The lightning tornado (docs/WEATHER.md §13, storm series step 3): the numbers and the pure maths the server and the
 * client share. A rare storm event: a rotating funnel wanders a server-chosen path across the fields for a few minutes,
 * pulls the players and monsters near it in, throws the ones it catches back out (server-authoritative, along the
 * navmesh), hurts them (a share of max HP per throw, capped per tornado: it kills only the already hurt, and only with
 * STORM_TABLE.tornadoLethal), and throws lightning at what stands around it (placed strikes, so every bolt is
 * telegraphed). It never enters a town.
 *
 * - **Timeline** (`TornadoState`, the `tornado` message): `warnAt` the warning (a wall cloud lowers, the announcement),
 *   `touchAt` touchdown (it starts walking its `path` at `speedMs`), `endAt` the end of its walk, or `liftAt` when it
 *   lifts early (the storm passed, a GM); it then rises over LIFT_MS and is gone (`tornadoEnd`).
 * - **Where it is**: `tornadoAt` walks the path by the time since touchdown, the same on the server and every client.
 * - **Pull**: inside `pullM` a body drifts toward the funnel at `pullSpeed` (slow at the edge, faster than a run at the
 *   core) with a swirl around it; its own walk carries on, so a player can run out from the edge.
 * - **Throw**: a body inside `coreM` is caught, spun up and thrown THROW_M out (clamped to the navmesh: never into a
 *   wall, water, a town or out of the world), with `throwDamage` (a share of max HP, capped per throw and per
 *   tornado), a short loss of control, then `immuneMs` before it can be caught again.
 * - `strength` (TORNADO_STRENGTH, 0..2) scales the pull, the throw, the damage and the bolts; 0 = it only looks.
 */
import type { TornadoState, Vec3 } from './protocol.ts'
import { mulberry32 } from './weather.ts'

/** Every tornado number (docs/WEATHER.md §13.6 has the table). Chance and strength defaults live in STORM_TABLE. */
export const TORNADO_TABLE = {
  // ---- timeline
  /** The warning before touchdown (ms): the wall cloud lowers, everyone is told. */
  warnMs: 20_000,
  /** Its life on the ground (ms), uniform in [min, max]. */
  lifeMs: [180_000, 300_000] as readonly [number, number],
  /** The shortest life worth spawning (ms): a storm with less time left gets none. */
  minLifeMs: 60_000,
  /** Where in the storm a natural tornado comes (share of the storm's length, uniform). */
  stormFrac: [0.15, 0.55] as readonly [number, number],
  // ---- the path
  /** Walking speed (m/s), uniform in [min, max]. */
  speedMs: [2.4, 3.6] as readonly [number, number],
  /** Touchdown this far from the player it is drawn to (m). */
  spawnM: [110, 220] as readonly [number, number],
  /** The path keeps this far from every town's safe area (m). */
  townMarginM: 90,
  /** ... and this far inside the world bounds (m). */
  edgeMarginM: 30,
  /** One straight leg of the path (m). */
  legM: [28, 48] as readonly [number, number],
  /** Every leg is checked every this many metres (open ground, no water, no town). */
  sampleM: 6,
  // ---- pull
  /** Bodies inside this radius are pulled (m). */
  pullM: 45,
  /** Pull speed toward the funnel (m/s) at the edge and at the core (strength 1). */
  pullEdgeMs: 0.9,
  pullCoreMs: 10,
  /** How sharply the pull grows toward the core: speed = edge + (core - edge) × (1 - d / pullM) ^ pullCurve. */
  pullCurve: 2,
  /** The swirl: the pull is turned this far around the funnel (radians; counter-clockwise from above). */
  swirlRad: 0.55,
  /** How often the server re-plans the pulled bodies' moves (ms). */
  pullTickMs: 500,
  // ---- throw
  /** Caught inside this radius (m). */
  coreM: 7,
  /** Thrown this far out (m, strength 1), uniform; never under throwMinM after the navmesh clamp. */
  throwM: [35, 60] as readonly [number, number],
  throwMinM: 6,
  /** The flight (ms) and its apex above the ground (m). */
  throwMs: [1700, 2600] as readonly [number, number],
  throwPeakM: [11, 20] as readonly [number, number],
  /** Loss of control after landing (ms; the knockdown covers the flight and this). */
  lockMs: 1600,
  /** Not caught (nor pulled) again this long after a throw (ms). */
  immuneMs: 9000,
  /** Throw damage: this share of max HP (strength 1) ... */
  damagePct: 0.22,
  /** ... at most this share of max HP per throw whatever the strength (it kills only a body already low on HP, and only
   *  with STORM_TABLE.tornadoLethal; otherwise never below 1 HP) ... */
  damageCapPct: 0.35,
  /** ... and one tornado takes at most this share of a body's max HP in all (its throws; a healthy body survives it). */
  damageTotalPct: 0.55,
  // ---- its lightning (placed strikes, telegraphed like any other)
  /** One bolt every this many ms (strength 1), uniform. */
  boltMs: [1100, 2800] as readonly [number, number],
  /** Bolts land this far from the funnel (m). */
  boltRingM: [6, 50] as readonly [number, number],
  /** Share of the bolts aimed at a body (player or monster) in the ring; the rest a tree or the ground. */
  boltBodyShare: 0.5,
  // ---- the client
  /** The funnel's height (m) and its top radius (the wall cloud), at strength 1. */
  heightM: 92,
  topM: 30,
  /** Felt (camera shake, the roar at full) inside this distance (m). */
  shakeM: 80,
  /** Heard out to this distance (m). */
  hearM: 900,
} as const

type Widen<T> = T extends number ? number : T extends readonly [number, number] ? readonly [number, number] : T
export type TornadoTable = { readonly [K in keyof typeof TORNADO_TABLE]: Widen<(typeof TORNADO_TABLE)[K]> }

/** The funnel rises (fades) this long after it lifts (ms). */
export const LIFT_MS = 6000

/** Wire ranges (validate.ts). */
export const TORNADO_LIMITS = { path: 96, coord: 1_000_000, speedMs: 20, radiusM: 100, strength: 2, displaceMs: 10_000, peakM: 40 } as const

export type TornadoPhase = 'warning' | 'active' | 'lifting' | 'gone'

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** The XZ length of a path (m). */
export function pathLength(path: readonly Vec3[]): number {
  let n = 0
  for (let i = 1; i < path.length; i++) n += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![2] - path[i - 1]![2])
  return n
}

/** The point `d` metres along a path (clamped to its ends), with the heading (radians, atan2(dx, dz)) of its leg. */
export function pointAlong(path: readonly Vec3[], d: number): { pos: Vec3; heading: number } {
  if (path.length === 0) return { pos: [0, 0, 0], heading: 0 }
  let left = Math.max(0, d)
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const len = Math.hypot(b[0] - a[0], b[2] - a[2])
    const heading = Math.atan2(b[0] - a[0], b[2] - a[2])
    if (left <= len || i === path.length - 1) {
      const f = len > 0 ? Math.min(1, left / len) : 1
      return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], heading }
    }
    left -= len
  }
  return { pos: [...path[0]!], heading: 0 }
}

/** When it stops walking: the lift (early) or the end of its walk. */
export function tornadoStopAt(s: Pick<TornadoState, 'endAt' | 'liftAt'>): number {
  return s.liftAt !== undefined ? Math.min(s.liftAt, s.endAt) : s.endAt
}

export function tornadoPhase(s: Pick<TornadoState, 'warnAt' | 'touchAt' | 'endAt' | 'liftAt'>, now: number): TornadoPhase {
  const stop = tornadoStopAt(s)
  if (now >= stop + LIFT_MS) return 'gone'
  if (now >= stop) return 'lifting'
  return now < s.touchAt ? 'warning' : 'active'
}

/**
 * Where the funnel stands at server ms `now` (on the ground, glTF metres), its heading, and how much of it there is
 * (0..1: it lowers during the warning, full on the ground, rising away after the lift).
 */
export function tornadoAt(s: TornadoState, now: number): { pos: Vec3; heading: number; phase: TornadoPhase; presence: number } {
  const stop = tornadoStopAt(s)
  const walked = (Math.max(0, Math.min(now, stop) - s.touchAt) / 1000) * s.speedMs
  const { pos, heading } = pointAlong(s.path, walked)
  const phase = tornadoPhase(s, now)
  let presence = 1
  if (phase === 'warning') presence = clamp01((now - s.warnAt) / Math.max(1, s.touchAt - s.warnAt))
  else if (phase === 'lifting') presence = 1 - clamp01((now - stop) / LIFT_MS)
  else if (phase === 'gone') presence = 0
  return { pos, heading, phase, presence }
}

/**
 * The pull on a body at (dx, dz) from the funnel (m): its drift velocity (m/s) toward the funnel, turned by the swirl.
 * [0, 0] outside `pullM` or at the very centre.
 */
export function pullVelocity(dx: number, dz: number, strength: number, t: TornadoTable = TORNADO_TABLE): [number, number] {
  const d = Math.hypot(dx, dz)
  if (!(d < t.pullM) || d < 1e-6 || strength <= 0) return [0, 0]
  const k = 1 - d / t.pullM
  const speed = (t.pullEdgeMs + (t.pullCoreMs - t.pullEdgeMs) * k ** t.pullCurve) * strength
  // inward unit, turned counter-clockwise (seen from above: +X east, -Z north) by the swirl
  const ix = -dx / d
  const iz = -dz / d
  const c = Math.cos(t.swirlRad)
  const s = Math.sin(t.swirlRad)
  return [(ix * c - iz * s) * speed, (ix * s + iz * c) * speed]
}

/**
 * Throw damage on a body (HP): damagePct × strength of max HP, at most damageCapPct of it per throw and what is left of
 * damageTotalPct after `taken` (what this tornado already took from it). `lethal` (STORM_TABLE.tornadoLethal) lets it
 * take the last HP of a body already low; otherwise it never goes below 1 HP.
 */
export function throwDamage(hp: number, maxHp: number, strength: number, t: TornadoTable = TORNADO_TABLE, opts: { taken?: number; lethal?: boolean } = {}): number {
  if (!(hp > 0) || !(maxHp > 0) || strength <= 0) return 0
  const want = Math.max(1, Math.round(maxHp * t.damagePct * strength))
  const cap = Math.max(1, Math.round(maxHp * t.damageCapPct))
  const left = Math.round(maxHp * t.damageTotalPct) - Math.max(0, opts.taken ?? 0)
  const floor = opts.lethal ? Math.ceil(hp) : Math.ceil(hp) - 1
  return Math.max(0, Math.min(want, cap, left, floor))
}

/** Height above the straight line of a throw at flight share `f` (0..1): a parabola with its apex `peakM` at 0.5. */
export function throwArc(f: number, peakM: number): number {
  const x = clamp01(f)
  return 4 * peakM * x * (1 - x)
}

/** Whether a storm event brings a tornado (seeded per storm), and when (share of its length). */
export function tornadoRoll(seed: number, chance: number, t: TornadoTable = TORNADO_TABLE): { spawn: boolean; frac: number } {
  const r = mulberry32((seed ^ 0x70e4ad0) >>> 0)
  const spawn = r() < Math.max(0, Math.min(1, chance))
  const frac = t.stormFrac[0] + (t.stormFrac[1] - t.stormFrac[0]) * r()
  return { spawn, frac }
}
