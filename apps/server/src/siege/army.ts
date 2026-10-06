import { yawTowards, type SiegeApproach, type SiegeRole, type Vec3, type XZ } from '@sro/shared'
import { mobReach } from '../ai.ts'
import type { Mob, Player } from '../world.ts'
import { FOOT_M, alongWall, type Lane } from './lanes.ts'

/**
 * Siege of Jangan, layer 4: how the army moves and fights (docs/SIEGE.md §6.3). The siege module drives every siege
 * monster through `Army.tick`; Gameplay.tick runs a monster's own AI only while it is `engage`d.
 *
 * - **muster**: standing at the muster until its wave marches (wave 1 waits through the warning).
 * - **march**: along its lane, one straight leg at a time (World.walkEntity), 3 abreast 2.5 m apart outside the walls,
 *   in single file inside; rows set off 1.2 s apart. A leg that ends blocked is tried once more without the formation
 *   offset, then skipped; a monster stuck on three legs in a row is put on its next waypoint.
 * - **assault**: at the foot of its segment. Raiders and the Warlord swing at the wall when no defender is within
 *   `engageM`, a ram every `ramEverySec`; a sapper plants its keg (`plantSec`, killable) and runs off; archers stand 25 m
 *   out and shoot defenders within their sight.
 * - **inside**: its segment is open: through the gap (the rally point), the inner lane, to a ring around the Town Bell.
 * - **bell**: swings at the Bell while no defender is near.
 * - **engage**: a defender within `engageM` (or one that hit it): the monster's own chase AI with home = where it broke
 *   off and leash `leashM`; back to what it was doing once it lost the target (no heal, no regen).
 * - **flee**: the siege ended: back toward the muster, gone after 60 s.
 */

export type SiegeMode = 'muster' | 'march' | 'assault' | 'inside' | 'bell' | 'engage' | 'flee' | 'still'

export interface SiegeMob {
  event: number
  role: SiegeRole
  approach: SiegeApproach
  seg: string
  wave: number
  mode: SiegeMode
  /** What an engage returns to. */
  resume: SiegeMode
  /** Waypoints left (the next leg goes to path[0]) and the last one reached (null: none yet). */
  path: XZ[]
  last?: XZ
  /** Formation: lateral offset (m) on outer legs, and the server ms this one sets off. */
  offset: number
  startAt: number
  /** The leg in progress was tried without its offset already / legs stuck in a row. */
  retried: boolean
  stuck: number
  nextActAt: number
  nextLookAt: number
  /** Sapper: planting until (server ms); planted. */
  plantUntil?: number
  planted?: boolean
  /** Its place around the Bell. */
  ring?: XZ
  fleeUntil?: number
}

/** A leg counts as done within this distance of its waypoint (m). */
export const ARRIVE_M = 2.5
/** Formation spacing (m) and the delay between rows (ms). */
export const ROW_SPACING_M = 2.5
export const ROW_DELAY_MS = 1200
/** Archers stop this far out from the foot of the wall (m) and see defenders this far (m). */
export const ARCHER_STANDOFF_M = 25
export const ARCHER_SIGHT_M = 35
/** Monsters look for defenders this often (ms). */
export const LOOK_MS = 500
/** Fleeing monsters leave the world after this (ms). */
export const FLEE_MS = 60_000
/** A wall swing's own animation (ms): the cast's action window. */
export const SWING_MS = 1200

export interface ArmyHost {
  now: number
  speed(m: Mob): number
  settings(): { engageM: number; leashM: number; ramEverySec: number; plantSec: number }
  lane(m: Mob): Lane | null
  bell(): Mob | null
  bellAt(): XZ
  wallOpen(seg: string): boolean
  /** A wall swing landed (raider, ram, Warlord). */
  wallHit(m: Mob, lane: Lane, at: Vec3): void
  /** A sapper's keg is planted at `at`. */
  planted(m: Mob, lane: Lane, at: Vec3): void
  position(m: Mob | Player): Vec3
  walk(m: Mob, x: number, z: number, speed: number): { blocked: boolean } | null
  halt(m: Mob, yaw?: number): void
  warpTo(m: Mob, x: number, z: number): void
  /** Attackable defenders within r of x/z (not in a safe area, alive, visible). */
  defendersNear(x: number, z: number, r: number): Player[]
  /** One swing of `m` at the Bell (damage, combat message). */
  hitBell(m: Mob, bell: Mob): void
  /** The swing's animation toward a point (no target): a cast with clip ATTACK1. */
  swingAnim(m: Mob, yaw: number): void
  remove(m: Mob): void
  report(e: unknown): void
}

const d2 = (a: XZ | Vec3, b: XZ | Vec3): number => {
  const ax = a[0]
  const az = a.length === 3 ? a[2] : a[1]
  const bx = b[0]
  const bz = b.length === 3 ? b[2] : b[1]
  return Math.hypot(ax - bx, az - bz)
}

/** The point of the leg a→b nearest to p. */
export function closestOnLeg(p: XZ, a: XZ, b: XZ): XZ {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0
  return [a[0] + dx * t, a[1] + dz * t]
}

/** The lateral offset (m) of formation slot `i` (3 abreast: 0, -2.5, +2.5). */
export function slotOffset(i: number): number {
  const col = i % 3
  return col === 0 ? 0 : col === 1 ? -ROW_SPACING_M : ROW_SPACING_M
}

/** When slot `i` of a wave that marches at `at` sets off. */
export function slotStart(i: number, at: number): number {
  return at + Math.floor(i / 3) * ROW_DELAY_MS
}

/** The way from the muster to the foot of the wall: the outer waypoints after the muster, then the foot (spread along the wall). */
export function outerPath(lane: Lane, spread: number, role: SiegeRole): XZ[] {
  const path = lane.outer.slice(1)
  if (role === 'archer') {
    path.push(alongWall(lane, [lane.assault[0], lane.assault[2]], spread, ARCHER_STANDOFF_M))
    return path
  }
  path.push(alongWall(lane, [lane.assault[0], lane.assault[2]], spread))
  return path
}

/** The way in: the rally point, the inner waypoints, then its place around the Bell. */
export function innerPath(lane: Lane, ring: XZ): XZ[] {
  return [lane.rally, ...lane.inner, ring]
}

/** A place on a ring around the Bell for monster number `i` (r: the Bell's radius plus the monster's reach). */
export function ringPoint(bell: XZ, i: number, r: number): XZ {
  const a = (i * 2.399963) % (Math.PI * 2)
  return [bell[0] + Math.sin(a) * r, bell[1] + Math.cos(a) * r]
}

export class Army {
  constructor(private readonly h: ArmyHost) {}

  /** One step of every siege monster in `mobs`. */
  tick(mobs: Iterable<Mob>): void {
    for (const m of mobs) {
      const s = m.siege
      if (!s || m.ai === 'dead') continue
      try {
        this.step(m, s)
      } catch (e) {
        // one monster's trouble never stops the army
        s.mode = 'still'
        this.h.report(e)
      }
    }
  }

  private step(m: Mob, s: SiegeMob): void {
    const now = this.h.now
    switch (s.mode) {
      case 'still':
      case 'muster':
        return
      case 'flee':
        if (s.fleeUntil !== undefined && now >= s.fleeUntil) return this.h.remove(m)
        if (!m.move && s.path.length) this.walkLeg(m, s, false)
        return
      case 'engage':
        return this.engaged(m, s)
    }
    // Hit while marching or at the wall: the monster turns on the attacker (ai.ts retaliate set the chase).
    if (m.ai === 'chase' && m.target !== null) return this.engage(m, s, null)
    if (now >= s.nextLookAt) {
      s.nextLookAt = now + LOOK_MS
      const p = this.h.position(m)
      const r = s.role === 'archer' && s.mode === 'assault' ? ARCHER_SIGHT_M : this.h.settings().engageM
      const near = this.h.defendersNear(p[0], p[2], r)
      if (near.length) return this.engage(m, s, nearest(near, p, this.h))
    }
    if (s.mode === 'march' || s.mode === 'inside') return this.march(m, s)
    if (s.mode === 'assault') return this.assault(m, s)
    if (s.mode === 'bell') return this.atBell(m, s)
  }

  /** Starts its march (the wave set off). */
  march(m: Mob, s: SiegeMob): void {
    const now = this.h.now
    if (now < s.startAt) return
    if (m.move) return
    const lane = this.h.lane(m)
    const next = s.path[0]
    if (!next) return this.arrived(m, s, lane)
    const p = this.h.position(m)
    const target = this.offsetTarget(s, p, next)
    if (d2(p, target) <= ARRIVE_M || d2(p, next) <= ARRIVE_M) {
      s.last = s.path.shift()!
      s.retried = false
      s.stuck = 0
      if (!s.path.length) return this.arrived(m, s, lane)
      return this.walkLeg(m, s, true)
    }
    // standing short of the waypoint: the last leg stopped (blocked) or never started
    if (s.path.length === 1 && s.mode === 'march' && lane && this.atFoot(p, lane)) {
      s.path.shift()
      return this.arrived(m, s, lane)
    }
    if (!s.retried) {
      // straight at the waypoint, out of formation for good (the lanes were walked on their centre line)
      s.retried = true
      s.offset = 0
      return this.walkLeg(m, s, false)
    }
    // blocked even so: it strayed off the lane (a chase, the formation). Back onto the lane line, then back to the last
    // waypoint; only then is it put on its waypoint.
    s.stuck++
    s.retried = false
    const last = s.last
    if (s.stuck === 1 && last) {
      s.path.unshift(closestOnLeg([p[0], p[2]], last, next))
      return this.walkLeg(m, s, false)
    }
    if (s.stuck === 2 && last) {
      s.path.unshift(last)
      return this.walkLeg(m, s, false)
    }
    this.h.warpTo(m, next[0], next[1])
    s.stuck = 0
    s.last = s.path.shift()!
  }

  private offsetTarget(s: SiegeMob, from: Vec3, to: XZ): XZ {
    if (!s.offset || s.mode !== 'march') return to
    const dx = to[0] - from[0]
    const dz = to[1] - from[2]
    const len = Math.hypot(dx, dz)
    if (len < 0.01) return to
    return [to[0] - (dz / len) * s.offset, to[1] + (dx / len) * s.offset]
  }

  /** Walks toward path[0] (with the formation offset when `formation`). */
  walkLeg(m: Mob, s: SiegeMob, formation: boolean): void {
    const next = s.path[0]
    if (!next) return
    const p = this.h.position(m)
    const t = formation ? this.offsetTarget(s, p, next) : next
    this.h.walk(m, t[0], t[1], this.h.speed(m))
  }

  private atFoot(p: Vec3, lane: Lane): boolean {
    const across = lane.axis === 'x' ? p[2] : p[0]
    const face = lane.axis === 'x' ? lane.assault[2] : lane.assault[0]
    return Math.abs(across - face) <= FOOT_M + 2
  }

  /** The end of its path: at the wall (assault), or at its place around the Bell. */
  private arrived(m: Mob, s: SiegeMob, lane: Lane | null): void {
    if (s.mode === 'inside') {
      s.mode = 'bell'
      s.nextActAt = 0
      return
    }
    s.mode = 'assault'
    s.nextActAt = this.h.now + 500
    if (lane) this.h.halt(m, this.wallYaw(lane))
  }

  /** Facing the wall (inward across it). */
  private wallYaw(lane: Lane): number {
    return lane.axis === 'x' ? yawTowards(0, -lane.out) : yawTowards(-lane.out, 0)
  }

  private assault(m: Mob, s: SiegeMob): void {
    const now = this.h.now
    const lane = this.h.lane(m)
    if (!lane) return
    if (this.h.wallOpen(s.seg)) return this.goInside(m, s, lane)
    if (s.role === 'archer') return
    if (s.role === 'sapper') {
      if (s.planted) return
      if (s.plantUntil === undefined) {
        s.plantUntil = now + this.h.settings().plantSec * 1000
        this.h.halt(m, this.wallYaw(lane))
        this.h.swingAnim(m, this.wallYaw(lane))
        return
      }
      if (now < s.plantUntil) return
      s.planted = true
      const p = this.h.position(m)
      this.h.planted(m, lane, [p[0], p[1], p[2]])
      return
    }
    if (now < s.nextActAt) return
    const every = s.role === 'ram' ? this.h.settings().ramEverySec * 1000 : Math.max(1500, m.def.attackIntervalMs)
    s.nextActAt = now + every
    const yaw = this.wallYaw(lane)
    this.h.halt(m, yaw)
    this.h.swingAnim(m, yaw)
    const p = this.h.position(m)
    const face = lane.axis === 'x' ? lane.assault[2] - lane.out * 2 : lane.assault[0] - lane.out * 2
    const at: Vec3 = lane.axis === 'x' ? [p[0], lane.assault[1] + 3, face] : [face, lane.assault[1] + 3, p[2]]
    this.h.wallHit(m, lane, at)
  }

  /** Its segment fell: through the gap to the Bell. */
  goInside(m: Mob, s: SiegeMob, lane: Lane): void {
    // archers hold the field
    if (s.role === 'archer') return
    const bell = this.h.bell()
    const reach = mobReach(m, { radius: bell?.radius ?? 1.6 })
    s.ring = ringPoint(this.h.bellAt(), m.id, Math.max(1.5, reach * 0.85))
    s.mode = 'inside'
    s.resume = 'inside'
    s.offset = 0
    s.retried = false
    s.stuck = 0
    s.path = innerPath(lane, s.ring)
    s.last = [lane.foot[0], lane.foot[1]]
    this.walkLeg(m, s, false)
  }

  private atBell(m: Mob, s: SiegeMob): void {
    const now = this.h.now
    const bell = this.h.bell()
    if (!bell || bell.ai === 'dead') return
    const p = this.h.position(m)
    const b = this.h.position(bell)
    const reach = mobReach(m, bell)
    const d = d2(p, b)
    if (d > reach) {
      if (!m.move && now >= s.nextActAt) {
        s.nextActAt = now + 800
        const t: XZ = [b[0] + ((p[0] - b[0]) / Math.max(d, 0.01)) * reach * 0.8, b[2] + ((p[2] - b[2]) / Math.max(d, 0.01)) * reach * 0.8]
        this.h.walk(m, t[0], t[1], this.h.speed(m))
      }
      return
    }
    if (now < m.nextSwingAt) return
    m.nextSwingAt = now + Math.max(1000, m.def.attackIntervalMs)
    this.h.halt(m, yawTowards(b[0] - p[0], b[2] - p[2]))
    this.h.hitBell(m, bell)
  }

  /** Into a fight: the monster's own chase AI, home where it broke off, leash leashM. */
  engage(m: Mob, s: SiegeMob, target: Player | null): void {
    const p = this.h.position(m)
    const st = this.h.settings()
    s.resume = s.mode === 'engage' ? s.resume : s.mode
    s.mode = 'engage'
    m.home = [p[0], p[2]]
    m.leashRange = st.leashM
    m.sightRange = s.role === 'archer' ? ARCHER_SIGHT_M : st.engageM
    m.aggressive = true
    if (target) {
      m.ai = 'chase'
      m.target = target.id
      m.nextThinkAt = 0
    } else if (m.ai !== 'chase') m.ai = 'idle'
  }

  /** Back from a fight once the AI has given up and walked home. */
  private engaged(m: Mob, s: SiegeMob): void {
    if (m.ai !== 'idle') return
    s.mode = s.resume === 'engage' ? 'march' : s.resume
    s.retried = false
    s.nextLookAt = this.h.now + LOOK_MS
    if ((s.mode === 'march' || s.mode === 'inside') && s.path.length) this.walkLeg(m, s, s.mode === 'march')
    else if (s.mode === 'assault') {
      // back to the foot of its wall (it may have chased a defender off)
      const lane = this.h.lane(m)
      if (lane && !this.atFoot(this.h.position(m), lane)) {
        s.mode = 'march'
        s.path = [alongWall(lane, [lane.assault[0], lane.assault[2]], 0)]
        this.walkLeg(m, s, false)
      }
    } else if (s.mode === 'bell' && s.ring) {
      s.mode = 'inside'
      s.path = [s.ring]
      this.walkLeg(m, s, false)
    }
  }

  /** The siege is over: every monster runs back toward its muster and is gone after FLEE_MS. */
  flee(m: Mob, s: SiegeMob, muster: XZ | null): void {
    s.mode = 'flee'
    s.fleeUntil = this.h.now + FLEE_MS
    m.ai = 'idle'
    m.target = null
    s.path = muster ? [muster] : []
    if (s.path.length) this.walkLeg(m, s, false)
  }
}

function nearest(list: readonly Player[], p: Vec3, h: Pick<ArmyHost, 'position'>): Player {
  let best = list[0]!
  let bd = Infinity
  for (const q of list) {
    const d = d2(h.position(q), p)
    if (d < bd) {
      bd = d
      best = q
    }
  }
  return best
}
