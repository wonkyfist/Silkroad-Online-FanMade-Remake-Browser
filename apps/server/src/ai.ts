import { yawTowards, type MobDef, type MobVariant, type TacticsDef, type Vec3 } from '@sro/shared'
import type { Mob, Player } from './world.ts'

/**
 * Monster AI: a small state machine per mob, independent of networking. It sees the world only through
 * `AiHost` (so it can move to a worker thread later, or be unit-tested with a fake host) and acts through it:
 * move, stop, swing. States:
 *
 *   idle   -> wanders inside its roam radius every few seconds; aggressive mobs acquire the nearest attackable
 *             player within sight range; any mob that is hit retaliates (see `retaliate`).
 *   chase  -> runs at the target and attacks at its attack interval once in reach
 *             (reach = attack range + both body radii). A target that dies or leaves makes it switch to the
 *             next player that damaged it, or go home. Past its leash range from home it gives up.
 *   return -> runs home ignoring everyone, then regenerates to full and goes idle.
 *   dead   -> nothing (the corpse is removed by gameplay).
 *
 * Semantics follow research report §4.5 "Tab_RefTactics" where known (sight range, leash/trace boundary, roam
 * radius); the rest (re-plan cadence, wander pauses) are server rules below.
 */

export interface AiHost {
  now: number
  rng(): number
  positionOf(e: Mob | Player): Vec3
  /** An attackable player by id (in the world, alive, not an invisible GM), else undefined. */
  target(id: number): Player | undefined
  /** Attackable players within `range` metres of x/z. */
  playersNear(x: number, z: number, range: number): Player[]
  canWalk(x: number, z: number): boolean
  /**
   * Optional (navmesh worlds): whether the straight walk from the mob to x/z is clear of blocking edges. Idle mobs
   * pick another wander point when it is not. Absent = always clear.
   */
  clear?(m: Mob, x: number, z: number): boolean
  /** Starts a move; false when the mob ends up standing (refused move). */
  move(m: Mob, x: number, z: number, speed: number): boolean
  /**
   * Optional: a mob that cannot walk home (a wall between it and its nest) is put back home at once (the
   * protocol's leash reset: a `warp`).
   */
  warpHome?(m: Mob): void
  /** Stops the mob, optionally facing `yaw`. */
  halt(m: Mob, yaw?: number): void
  /** One basic attack of `m` on `target` (damage, messages, death). */
  swing(m: Mob, target: Player): void
  /** The mob reached home: full HP, broadcast. */
  restored(m: Mob): void
  /**
   * Optional (wave 8, monster skills; docs/SYSTEMS_COMBAT.md §2.2): asked in the chase branch before re-planning a
   * chase, with the target out of reach at dist metres. True = the mob cast a ranged special instead (no chase now).
   */
  ranged?(m: Mob, target: Player, dist: number): boolean
  /**
   * Optional (storms, docs/WEATHER.md §12.2): the weather's say on a mob's sight, leash, roam radius and chase speed.
   * Absent = the mob's own.
   */
  storm?: AiStorm
  /** Optional (the Climb's monster roles, docs/CLIMB.md §2.3; climb/roles.ts): an idle mob acquired `target` on sight. */
  aggro?(m: Mob, target: Player): void
}

/** The storm module's view of one mob (storm/service.ts): each returns the value the AI uses now. */
export interface AiStorm {
  sight(m: Mob): number
  leash(m: Mob): number
  roam(m: Mob): number
  speed(m: Mob, base: number): number
}

const sightOf = (m: Mob, host: AiHost): number => host.storm?.sight(m) ?? m.sightRange
const leashOf = (m: Mob, host: AiHost): number => host.storm?.leash(m) ?? m.leashRange
const roamOf = (m: Mob, host: AiHost): number => host.storm?.roam(m) ?? m.roamRadius

/** Rule: wander pause range (ms) of an idle mob. */
export const WANDER_PAUSE_MS: [number, number] = [4000, 12000]
/** Rule: how often a chasing mob re-plans its path to a moving target. */
export const CHASE_REPLAN_MS = 300
/** Rule: re-plan only when the target moved this far from the last chase goal (metres). */
const CHASE_SLACK_M = 1
/** Rule: a mob counts as home within this distance (metres). */
const HOME_EPS_M = 1
/** Rule: wander points tried per think (open ground, clear straight walk). */
export const WANDER_TRIES = 6

function dist2(a: Vec3 | [number, number], b: Vec3 | [number, number]): number {
  const ax = a[0]
  const az = a.length === 3 ? a[2] : a[1]
  const bx = b[0]
  const bz = b.length === 3 ? b[2] : b[1]
  return (ax - bx) ** 2 + (az - bz) ** 2
}

/**
 * Whether a mob attacks players in sight unprovoked: its nest's tactics, else (no nest) the MobDef default. A champion
 * spawns with its champion tactics instead, and vSRO's are all aggressive (Tab_RefTactics: btAggressType 0 on every
 * dwChampionTacticsID row), so a champion Mangyang attacks on sight; MobDef.championAggressive false (no champion
 * tactics linked) keeps the base tactics. Giants and uniques keep their tactics. Sight and leash stay the nest's.
 */
export function mobAggressive(def: Pick<MobDef, 'aggressive' | 'championAggressive'>, variant: MobVariant, tactics?: Pick<TacticsDef, 'aggressive'> | null): boolean {
  const base = tactics?.aggressive ?? def.aggressive
  return base || (variant === 'champion' && def.championAggressive !== false)
}

/** Reach of a mob's basic attack against a player, metres centre to centre. */
export function mobReach(m: Mob, target: { radius: number }): number {
  return m.def.attackRange + m.radius + target.radius
}

function chaseSpeed(m: Mob, host?: AiHost): number {
  const base = m.def.runSpeed > 0 ? m.def.runSpeed : m.def.walkSpeed
  return host?.storm ? host.storm.speed(m, base) : base
}

/**
 * A player damaged the mob: remember it and turn on it if the mob was idle. `notice` false (an invisible GM) only
 * records the damage: a mob that turned on someone it may not target would give up at once, run home and heal to
 * full, so an invisible GM could never kill anything it does not one-shot.
 */
export function retaliate(m: Mob, attacker: number, damage: number, notice = true): void {
  if (m.ai === 'dead') return
  m.damage.set(attacker, (m.damage.get(attacker) ?? 0) + damage)
  if (!notice) return
  if (m.ai === 'idle') {
    m.ai = 'chase'
    m.target = attacker
    m.nextThinkAt = 0
  } else if (m.ai === 'chase' && m.target === null) m.target = attacker
}

/** Sends the mob home, forgetting every grudge. */
export function goHome(m: Mob, host: AiHost): void {
  m.ai = 'return'
  m.target = null
  m.damage.clear()
  if (!host.move(m, m.home[0], m.home[1], chaseSpeed(m, host))) {
    if (dist2(host.positionOf(m), m.home) > HOME_EPS_M ** 2) host.warpHome?.(m)
    arriveHome(m, host)
  }
}

function arriveHome(m: Mob, host: AiHost): void {
  m.ai = 'idle'
  m.nextThinkAt = host.now + WANDER_PAUSE_MS[0] + host.rng() * (WANDER_PAUSE_MS[1] - WANDER_PAUSE_MS[0])
  host.restored(m)
}

/** Next player to fight: the one that did the most damage and is still attackable within the leash. */
function nextTarget(m: Mob, host: AiHost): Player | undefined {
  let best: Player | undefined
  let bestDamage = -1
  for (const [id, dmg] of m.damage) {
    const p = host.target(id)
    if (!p) {
      m.damage.delete(id)
      continue
    }
    if (dist2(host.positionOf(p), m.home) > leashOf(m, host) ** 2) continue
    if (dmg > bestDamage) {
      best = p
      bestDamage = dmg
    }
  }
  return best
}

/** One AI step at host.now. */
export function thinkMob(m: Mob, host: AiHost): void {
  const now = host.now
  if (m.ai === 'dead') return
  const pos = host.positionOf(m)

  if (m.ai === 'return') {
    if (dist2(pos, m.home) <= HOME_EPS_M ** 2) {
      if (m.move) host.halt(m)
      arriveHome(m, host)
    } else if (!m.move && !host.move(m, m.home[0], m.home[1], chaseSpeed(m, host))) {
      // Stuck short of home (the straight run home hit a wall): leash reset.
      host.warpHome?.(m)
      arriveHome(m, host)
    }
    return
  }

  if (m.ai === 'idle') {
    const sight = sightOf(m, host)
    if (m.aggressive && sight > 0) {
      const leash = leashOf(m, host)
      let best: Player | undefined
      let bestD = Infinity
      for (const p of host.playersNear(pos[0], pos[2], sight)) {
        const d = dist2(host.positionOf(p), pos)
        if (d < bestD && dist2(host.positionOf(p), m.home) <= leash ** 2) {
          best = p
          bestD = d
        }
      }
      if (best) {
        m.ai = 'chase'
        m.target = best.id
        m.nextThinkAt = 0
        host.aggro?.(m, best)
      }
    }
    if (m.ai === 'idle') {
      const roam = roamOf(m, host)
      if (!m.move && now >= m.nextThinkAt && m.def.walkSpeed > 0 && roam > 0) {
        // A few candidate points in the roam circle; the first one on open ground with a clear straight walk wins
        // (a blocked one is dropped for another: mobs do not walk into walls on purpose). None: stay this time.
        for (let i = 0; i < WANDER_TRIES; i++) {
          const a = host.rng() * Math.PI * 2
          const r = Math.sqrt(host.rng()) * roam
          const x = m.home[0] + Math.sin(a) * r
          const z = m.home[1] + Math.cos(a) * r
          if (host.canWalk(x, z) && (!host.clear || host.clear(m, x, z))) {
            host.move(m, x, z, m.def.walkSpeed)
            break
          }
        }
        m.nextThinkAt = now + WANDER_PAUSE_MS[0] + host.rng() * (WANDER_PAUSE_MS[1] - WANDER_PAUSE_MS[0])
      }
      return
    }
  }

  // chase
  const leash = leashOf(m, host)
  if (dist2(pos, m.home) > leash ** 2) return goHome(m, host)
  let target = m.target === null ? undefined : host.target(m.target)
  if (!target) {
    if (m.target !== null) m.damage.delete(m.target)
    target = nextTarget(m, host)
    if (!target) return goHome(m, host)
    m.target = target.id
    m.nextThinkAt = 0
  }
  const tp = host.positionOf(target)
  if (dist2(tp, m.home) > leash ** 2) {
    m.damage.delete(target.id)
    m.target = null
    const next = nextTarget(m, host)
    if (!next) return goHome(m, host)
    m.target = next.id
    return
  }
  const reach = mobReach(m, target)
  const d = Math.sqrt(dist2(tp, pos))
  if (d <= reach) {
    host.halt(m, yawTowards(tp[0] - pos[0], tp[2] - pos[2]))
    if (now >= m.nextSwingAt) {
      m.nextSwingAt = now + Math.max(200, m.def.attackIntervalMs)
      host.swing(m, target)
    }
    return
  }
  // Wave 8: a ranged special (Tiger Girl curse, Yeoha force) instead of the chase (mob-skills.ts via the host), on the
  // mob's own attack rhythm: never before its next swing time (a swing just made does not get a free bolt after it).
  if (now >= m.nextSwingAt && host.ranged?.(m, target, d)) return
  // Out of reach: (re)plan a straight run to a point just inside reach, towards us from the target.
  const goalMoved = !m.move || dist2(m.move.to, tp) > (reach + CHASE_SLACK_M) ** 2
  if (goalMoved && now >= m.nextThinkAt) {
    m.nextThinkAt = now + CHASE_REPLAN_MS
    const stand = Math.max(0, reach * 0.8)
    const x = tp[0] + ((pos[0] - tp[0]) / d) * stand
    const z = tp[2] + ((pos[2] - tp[2]) / d) * stand
    if (!host.move(m, x, z, chaseSpeed(m, host))) {
      m.damage.delete(target.id)
      m.target = null
    }
  }
}
