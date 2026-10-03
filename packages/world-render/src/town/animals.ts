/**
 * The town's animals (docs/TOWN_LIFE.md §4; docs/WAVE_PLAN7.md §6.1 TL-C):
 *
 * - **VAT animals** (chickens in their yard, a cat that moves between walls and steps, a dog that follows its owner
 *   and one that lies at a door) are a second `TownCrowd` on their own schedule: pure functions of the server clock,
 *   so friends see the same chicken peck at the same moment. Their cap halves beyond 10 players (crowd.ts animalCap).
 * - **Pigeons** are the life part's (wave 10's procedural bird as a `townPigeon` species on a `townPlaza` habitat):
 *   the flock circles, lands on the paving and flushes from players and mobs. Townsfolk are not in the life part's
 *   threat feed, so the habitat's landing refuses every spot within LANDING_CLEAR_ROUTE_M of a route edge or a dwell
 *   spot (TOWN_LIFE §4, fact-check): walkers never stroll through landed pigeons.
 * - **Ducks** (High and up): a `townDuck` species on the pond's `townPond` habitat with the `float` landing (W11-S: they
 *   bob on the water, no peck-hops); no water there (the pond reads dry: D21), no ducks.
 *
 * The retail chickens, goldfish and tied horses stay as placed on every preset (the Low guard).
 */
import type { LifeHabitat, LifePart, LifeSpecies } from '../life/types.ts'
import { hash01, newPose, type CrowdAgent, type CrowdPose, type CrowdQuery, type CrowdSchedule } from './crowd.ts'

/** Pigeons never land within this of a route edge or a dwell spot (m). */
export const LANDING_CLEAR_ROUTE_M = 6

/** Where the crowd walks and dwells (glTF metres): segments as (x0, z0, x1, z1) quads, spots as (x, z) pairs. */
export interface TownRoutes {
  readonly segments: Float32Array
  readonly spots: Float32Array
}

/** Squared distance from (x, z) to the segment (ax, az)–(bx, bz). */
export function segmentDist2(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax
  const vz = bz - az
  const l2 = vx * vx + vz * vz
  let t = l2 > 1e-9 ? ((x - ax) * vx + (z - az) * vz) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = ax + vx * t - x
  const dz = az + vz * t - z
  return dx * dx + dz * dz
}

/** Whether (x, z) is within `clear` metres of a route segment or a dwell spot. */
export function nearRoute(routes: TownRoutes, x: number, z: number, clear = LANDING_CLEAR_ROUTE_M): boolean {
  const c2 = clear * clear
  const s = routes.segments
  for (let k = 0; k + 3 < s.length; k += 4) if (segmentDist2(x, z, s[k]!, s[k + 1]!, s[k + 2]!, s[k + 3]!) < c2) return true
  const p = routes.spots
  for (let k = 0; k + 1 < p.length; k += 2) {
    const dx = p[k]! - x
    const dz = p[k + 1]! - z
    if (dx * dx + dz * dz < c2) return true
  }
  return false
}

/** An area the pigeons like: a box (glTF metres) minus circles (a fountain), and the ground height test. */
export interface PlazaArea {
  x0: number
  x1: number
  z0: number
  z1: number
  /** Circles (x, z, r) inside the box that are not paving (the fountain basin). */
  holes: ReadonlyArray<readonly [number, number, number]>
}

const linear = (r: number, g: number, b: number): [number, number, number] => [(r / 255) ** 2.2, (g / 255) ** 2.2, (b / 255) ** 2.2]

export const PIGEON: Readonly<LifeSpecies> = {
  id: 'townPigeon', kind: 'bird', habitat: 'townPlaza', colors: [linear(112, 116, 126), linear(168, 170, 178)], scale: 1.5,
  flap: { hz: 3, amplitude: 1 }, max: 10,
}

export const DUCK: Readonly<LifeSpecies> = {
  id: 'townDuck', kind: 'bird', habitat: 'townPond', colors: [linear(236, 232, 220), linear(196, 186, 160)], scale: 1.8,
  flap: { hz: 2.4, amplitude: 0.9 }, max: 6,
}

/** The pigeons' habitat: the plaza's paving, landing anywhere clear of the crowd's routes (TOWN_LIFE §4). */
export function plazaHabitat(area: PlazaArea, routes: TownRoutes, groundAt: (x: number, z: number) => number | null): LifeHabitat {
  const inside = (x: number, z: number) => {
    if (x < area.x0 || x > area.x1 || z < area.z0 || z > area.z1) return false
    for (const [hx, hz, r] of area.holes) if ((x - hx) ** 2 + (z - hz) ** 2 < r * r) return false
    return true
  }
  return {
    id: 'townPlaza',
    weight: (x, z) => (inside(x, z) ? 1 : 0),
    landing: (x, z) => {
      if (!inside(x, z) || nearRoute(routes, x, z)) return null
      const y = groundAt(x, z)
      return y === null || !Number.isFinite(y) ? null : y
    },
  }
}

/** The ducks' habitat: the pond's water within `r` of its centre (the water level is the landing; `float`). */
export function pondHabitat(cx: number, cz: number, r: number, waterAt: (x: number, z: number) => number | null): LifeHabitat {
  const near = (x: number, z: number) => (x - cx) ** 2 + (z - cz) ** 2 < r * r
  return {
    id: 'townPond',
    float: true,
    weight: (x, z) => (near(x, z) && waterAt(x, z) !== null ? 1 : 0),
    landing: (x, z) => (near(x, z) ? waterAt(x, z) : null),
  }
}

/** Registers the pigeons (and, with `pond`, the ducks) on the life part; returns the remover. */
export function registerTownBirds(life: LifePart | null, plaza: LifeHabitat, pond: LifeHabitat | null): () => void {
  if (!life) return () => {}
  const off: Array<() => void> = []
  try {
    off.push(life.addHabitat(plaza), life.addSpecies(PIGEON))
    if (pond) off.push(life.addHabitat(pond), life.addSpecies(DUCK))
  } catch (err) {
    console.warn('[town] the birds could not be registered:', err)
  }
  return () => {
    for (const fn of off.splice(0).reverse()) {
      try {
        fn()
      } catch {
        // the life part is gone already
      }
    }
  }
}

// ---- the VAT animals' schedule -----------------------------------------------------------------------------------

/** A chicken yard: the hens wander inside it (TOWN_LIFE §4: 6 / 8). */
export interface AnimalYard {
  x: number
  z: number
  r: number
  y?: number
}

export interface AnimalPlan {
  /** The yard and how many hens (Medium 6, High 8: the cap decides). */
  yard: AnimalYard | null
  hens: number
  /** Where the cat sits in turn (walls, steps), glTF metres. */
  catSpots: ReadonlyArray<readonly [number, number]>
  /** The folk agent a dog follows (index into `folk.agents`), or −1. */
  dogOwner: number
  /** Where a second dog lies (a door), or null. */
  dogRest: readonly [number, number, number] | null
}

/** A hen moves 2 s of every HEN_PERIOD_S and pecks the rest. */
export const HEN_PERIOD_S = 6
export const HEN_MOVE_S = 2
/** The cat sits CAT_SIT_S at a spot, then walks to the next at CAT_SPEED. */
export const CAT_SIT_S = 40
export const CAT_SPEED = 0.8
/** A dog trails its owner by DOG_LAG_S. */
export const DOG_LAG_S = 1.1

/**
 * The animals as a pure schedule. Agents: the hens, the cat, the following dog, the resting dog (ids from 100,000 so
 * they never share a folk id's hash).
 */
export class AnimalSchedule implements CrowdSchedule {
  readonly agents: CrowdAgent[] = []
  private readonly kind: Array<'hen' | 'cat' | 'dogFollow' | 'dogRest'> = []
  private readonly ownerPose: CrowdPose = newPose()
  private readonly lagged: CrowdQuery = { nowS: 0, solarT: 0, alarmFromS: 0, alarmUntilS: 0, rain: 0 }
  private readonly catLegs: Float64Array
  private readonly catPeriod: number

  constructor(readonly plan: AnimalPlan, readonly folk: CrowdSchedule | null) {
    let id = 100_000
    const add = (role: CrowdAgent['role'], k: 'hen' | 'cat' | 'dogFollow' | 'dogRest') => {
      const a: CrowdAgent = { id, role, female: false, rank: hash01(id, 31) }
      id++
      this.agents.push(a)
      this.kind.push(k)
    }
    if (plan.yard) for (let i = 0; i < plan.hens; i++) add('chicken', 'hen')
    if (plan.catSpots.length >= 2) add('cat', 'cat')
    if (plan.dogOwner >= 0 && folk && plan.dogOwner < folk.agents.length) add('dog', 'dogFollow')
    if (plan.dogRest) add('dog', 'dogRest')
    // The cat's cycle: sit, then walk to the next spot; cumulative leg ends.
    const spots = plan.catSpots
    const legs: number[] = []
    let t = 0
    for (let k = 0; k < spots.length; k++) {
      const a = spots[k]!
      const b = spots[(k + 1) % spots.length]!
      t += CAT_SIT_S
      legs.push(t)
      t += Math.hypot(b[0] - a[0], b[1] - a[1]) / CAT_SPEED
      legs.push(t)
    }
    this.catLegs = Float64Array.from(legs)
    this.catPeriod = t
  }

  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    const a = this.agents[i]
    if (!a) return false
    out.alpha = 1
    out.rate = 1
    out.y = Number.NaN
    out.distM = Number.NaN
    out.speed = 0
    switch (this.kind[i]) {
      case 'hen':
        return this.hen(a.id, q.nowS, out)
      case 'cat':
        return this.cat(a.id, q.nowS, out)
      case 'dogFollow':
        return this.dogFollow(q, out)
      case 'dogRest': {
        const r = this.plan.dogRest!
        out.x = r[0]
        out.z = r[1]
        out.yaw = r[2]
        out.clip = 'SIT'
        out.clipT = q.nowS + a.id
        return true
      }
      default:
        return false
    }
  }

  /** A hen: a slow Lissajous walk inside the yard, 2 s moving of every 6 s, pecking in between. */
  private hen(id: number, nowS: number, out: CrowdPose): boolean {
    const yard = this.plan.yard!
    const ph = hash01(id, 3) * 1000
    const t = nowS + ph
    const k = Math.floor(t / HEN_PERIOD_S)
    const into = t - k * HEN_PERIOD_S
    const moving = into < HEN_MOVE_S
    const tau = k * HEN_MOVE_S + Math.min(into, HEN_MOVE_S)
    const w1 = 0.11 + hash01(id, 5) * 0.05
    const w2 = 0.07 + hash01(id, 6) * 0.05
    const p1 = hash01(id, 7) * 6.283
    const p2 = hash01(id, 8) * 6.283
    // two sines: the corner of their square reaches r × 0.68 × √2 ≈ 0.96 r (inside the yard)
    const r = yard.r * 0.68
    out.x = yard.x + Math.sin(tau * w1 + p1) * r
    out.z = yard.z + Math.sin(tau * w2 + p2) * r
    if (yard.y !== undefined) out.y = yard.y
    const dx = Math.cos(tau * w1 + p1) * w1
    const dz = Math.cos(tau * w2 + p2) * w2
    out.yaw = Math.atan2(dx, dz)
    out.clip = moving ? 'WALK' : 'PICK'
    out.clipT = moving ? into : into - HEN_MOVE_S
    return true
  }

  /** The cat: sits at a spot, then walks to the next. */
  private cat(id: number, nowS: number, out: CrowdPose): boolean {
    const spots = this.plan.catSpots
    const P = this.catPeriod
    if (!(P > 0)) return false
    const u = (((nowS + hash01(id, 9) * P) % P) + P) % P
    let leg = 0
    while (leg < this.catLegs.length - 1 && u >= this.catLegs[leg]!) leg++
    const k = leg >> 1
    const a = spots[k % spots.length]!
    const b = spots[(k + 1) % spots.length]!
    const yaw = Math.atan2(b[0] - a[0], b[1] - a[1])
    if ((leg & 1) === 0) {
      out.x = a[0]
      out.z = a[1]
      out.yaw = yaw + 2.2
      out.clip = 'SIT'
      out.clipT = u
      return true
    }
    const t0 = this.catLegs[leg - 1]!
    const t1 = this.catLegs[leg]!
    const f = t1 > t0 ? (u - t0) / (t1 - t0) : 1
    out.x = a[0] + (b[0] - a[0]) * f
    out.z = a[1] + (b[1] - a[1]) * f
    out.yaw = yaw
    out.clip = 'WALK'
    out.clipT = u - t0
    out.distM = (u - t0) * CAT_SPEED
    out.speed = CAT_SPEED
    return true
  }

  /** The dog: where its owner was DOG_LAG_S ago, half a metre to the side. */
  private dogFollow(q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    const folk = this.folk
    if (!folk) return false
    const lagged = this.lagged
    lagged.nowS = q.nowS - DOG_LAG_S
    lagged.solarT = q.solarT
    lagged.alarmFromS = q.alarmFromS
    lagged.alarmUntilS = q.alarmUntilS
    lagged.rain = q.rain
    const o = this.ownerPose
    if (!folk.pose(this.plan.dogOwner, lagged, o)) return false
    const s = Math.sin(o.yaw)
    const c = Math.cos(o.yaw)
    out.x = o.x + c * 0.5
    out.z = o.z - s * 0.5
    out.y = o.y
    out.yaw = o.yaw
    const walking = o.clip === 'WALK' || o.clip === 'RUN' || o.clip === 'CARRY'
    out.clip = walking ? 'WALK' : 'STAND1'
    // the dog's gait follows the owner's distance and speed (the crowd turns them into its own clip's phase)
    out.clipT = q.nowS
    out.rate = o.rate
    out.distM = walking ? o.distM : Number.NaN
    out.speed = walking ? o.speed : 0
    out.alpha = o.alpha
    return true
  }
}
