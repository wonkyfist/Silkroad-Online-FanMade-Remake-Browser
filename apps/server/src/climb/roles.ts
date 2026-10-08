/**
 * The Climb's monster roles (docs/CLIMB.md §2.3, layer L3 of §20; D3). The roles come from the roster
 * (packages/shared/src/climb.ts CLIMB_ROSTER `roles`, `callN`), the numbers from CLIMB_ROLE_RULES:
 *
 * - **pack**: when an idle member is hit or aggroes, up to 2 idle nest-mates within 12 m join 0.5–2 s later. A joiner
 *   never links on (a bad pull is 3) and never flees.
 * - **ranged** (archers, bowmen, tombstones, casters) and **healer** ("flee melee"): once per 6 s, when its target is a
 *   melee fighter (weapon reach ≤ 4 m) within 4 m, the monster steps 6 m back (kiting) and then fights on.
 * - **healer**: every 7 s, if an ally within 15 m is under 70 % HP, a 1.4 s cast (its ATTACK1 clip) heals the most hurt
 *   one for 12 % of the ally's max HP; a stun, knockdown or freeze during the cast cancels it (`castEnd interrupted`).
 * - **coward** (runners): once per fight, under 25 % HP, 60 % run from the attacker for 5 s (no attacks); alive at the
 *   end, it shouts (a local line to players within 30 m, HELP clip) and `callN` (1, Chakji Worker 1–2) idle nest-mates
 *   within 30 m join 3 s later.
 *
 * Cost (the 100-player bar): nothing runs for idle monsters. The module keeps only the monsters in a fight (`active`,
 * entered on aggro or a player's hit, left when they stop chasing) and the pending joins; nest-mates come from the
 * spawner's nest (its living ids), never a scan of the world. The AI hook is one call on idle -> chase (ai.ts `aggro`).
 * Siege, Play the Boss and quest-encounter monsters keep their own AI.
 */
import { CLIMB_ROLE_RULES, climbRowOf, yawTowards, type ClimbRole } from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GameplayModule } from '../modules.ts'
import type { Mob, Player } from '../world.ts'

const R = CLIMB_ROLE_RULES
/** Cast instances of the roles' casts (apart from the skill engine's, mob-skills' and the pilot kit's ranges). */
const INSTANCE_BASE = 1_800_000_000
const INSTANCE_MAX = 1_850_000_000
export const ROLE_HEAL_SKILL = 'CLIMB_ROLE_HEAL'
export const ROLE_CALL_SKILL = 'CLIMB_ROLE_CALL'

interface RoleState {
  roles: ReadonlySet<ClimbRole>
  callN: readonly [number, number]
  /** Joined through a pack link or a call: never links on, never flees. */
  helper: boolean
  /** The coward's roll was made this fight. */
  rolled: boolean
  nextHealAt: number
  nextStepAt: number
  /** A heal cast in progress. */
  cast: { ally: number; endAt: number; instance: number } | null
  /** A coward's flight: ends at, and who it runs from. */
  flee: { until: number; from: number } | null
}

interface Join {
  mob: Mob
  target: number
  at: number
}

export class MonsterRoles implements GameplayModule {
  readonly name = 'roles'
  private readonly states = new Map<number, RoleState | null>()
  /** Monsters in a fight that a role may act on or a healer may heal (id -> mob). */
  readonly active = new Map<number, Mob>()
  private readonly joins: Join[] = []
  private nextInstance = INSTANCE_BASE
  /** Counters for the GM and the tests. */
  readonly stats = { links: 0, heals: 0, healsInterrupted: 0, steps: 0, flights: 0, calls: 0 }

  constructor(readonly g: Gameplay) {}

  get on(): boolean {
    return this.g.config.climb === true && this.g.config.climbRoles !== false
  }

  /** The role state of a roster monster (null: no roles, or a monster that keeps its own AI). */
  private state(m: Mob): RoleState | null {
    let s = this.states.get(m.id)
    if (s !== undefined) return s
    const row = climbRowOf(m.def.code)
    s = !row?.roles?.length || m.siege || m.pilot || m.encounter || m.variant === 'unique'
      ? null
      : { roles: new Set(row.roles), callN: row.callN ?? [1, 1], helper: false, rolled: false, nextHealAt: 0, nextStepAt: 0, cast: null, flee: null }
    this.states.set(m.id, s)
    return s
  }

  // ---- events ------------------------------------------------------------------------------------------------

  /** ai.ts: an idle monster acquired `target` on sight. */
  aggro(m: Mob, target: Player, now: number): void {
    if (!this.on) return
    this.fresh(m, target.id, now)
  }

  /**
   * Gameplay.dealHits, before `retaliate`: a player hit `m` for `dealt` (m.hp is already after the hit). An idle monster
   * starts a fight (pack link); a coward may run.
   */
  hit(m: Mob, a: Player, dealt: number, now: number): void {
    if (!this.on || m.ai === 'dead' || m.hp <= 0) return
    if (m.ai === 'idle') this.fresh(m, a.id, now)
    else if (dealt > 0) this.active.set(m.id, m)
    const s = this.state(m)
    if (!s || dealt <= 0) return
    if (s.roles.has('coward') && !s.helper && !s.rolled && !s.flee && m.hp < (m.maxHp * R.coward.belowPct) / 100) {
      s.rolled = true
      if (this.g.rng() * 100 < R.coward.chancePct) this.startFlight(m, s, a, now)
    }
  }

  /** A fight starts (idle -> chase): a fresh state, and a pack member calls its mates. */
  private fresh(m: Mob, target: number, now: number): void {
    this.active.set(m.id, m)
    const s = this.state(m)
    if (!s) return
    s.helper = false
    s.rolled = false
    s.flee = null
    if (s.roles.has('pack')) {
      const mates = this.mates(m, R.pack.radiusM, R.pack.max, now)
      for (const h of mates) {
        this.joins.push({ mob: h, target, at: now + R.pack.delayMs[0] + this.g.rng() * (R.pack.delayMs[1] - R.pack.delayMs[0]) })
        this.stats.links++
      }
    }
  }

  /** Up to `max` idle, living nest-mates of `m` within `radius` m, nearest first (not already joining). */
  private mates(m: Mob, radius: number, max: number, now: number): Mob[] {
    if (!m.nest || max <= 0) return []
    const ids = this.g.spawner.nestOfMob(m.id)?.alive
    const pool: Iterable<Mob> = ids ? [...ids].map((id) => this.g.world.mobs.get(id)).filter((x): x is Mob => !!x) : [...this.g.world.mobs.values()].filter((x) => x.nest === m.nest)
    const at = this.g.world.positionAt(m, now)
    const out: [number, Mob][] = []
    for (const x of pool) {
      if (x === m || x.ai !== 'idle' || x.hp <= 0 || x.siege || x.pilot || this.joins.some((j) => j.mob === x)) continue
      const p = this.g.world.positionAt(x, now)
      const d = (p[0] - at[0]) ** 2 + (p[2] - at[2]) ** 2
      if (d <= radius * radius) out.push([d, x])
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, max).map(([, x]) => x)
  }

  // ---- the tick ----------------------------------------------------------------------------------------------

  tick(now: number): void {
    if (this.joins.length) this.runJoins(now)
    if (this.active.size === 0) return
    const on = this.on
    for (const [id, m] of this.active) {
      const s = this.state(m)
      if (m.ai === 'dead' || (m.ai !== 'chase' && !s?.flee && !s?.cast) || !on) {
        if (s?.cast) this.cancelCast(m, s, now)
        this.active.delete(id)
        if (m.ai === 'dead') this.states.delete(id)
        continue
      }
      if (!s) continue
      if (s.flee) {
        if (now >= s.flee.until) this.endFlight(m, s, now)
        continue
      }
      if (s.cast) {
        this.runCast(m, s, now)
        continue
      }
      if (this.g.skills.held(m, now) || this.g.mobSkills.busy(m, now)) continue
      if (s.roles.has('healer') && now >= s.nextHealAt && this.startCast(m, s, now)) continue
      if ((s.roles.has('ranged') || s.roles.has('healer')) && now >= s.nextStepAt) this.stepBack(m, s, now)
    }
  }

  private runJoins(now: number): void {
    for (let i = this.joins.length - 1; i >= 0; i--) {
      const j = this.joins[i]
      if (now < j.at) continue
      this.joins.splice(i, 1)
      const h = j.mob
      if (h.ai !== 'idle' || h.hp <= 0 || !this.g.world.mobs.has(h.id) || !this.g.target(j.target)) continue
      h.ai = 'chase'
      h.target = j.target
      h.nextThinkAt = 0
      this.active.set(h.id, h)
      const s = this.state(h)
      if (s) {
        s.helper = true
        s.rolled = true
        s.flee = null
      }
    }
  }

  // ---- healer ------------------------------------------------------------------------------------------------

  private startCast(m: Mob, s: RoleState, now: number): boolean {
    s.nextHealAt = now + R.healer.everyMs
    const at = this.g.world.positionAt(m, now)
    let best: Mob | null = null
    let bestFrac = R.healer.belowPct / 100
    for (const x of this.active.values()) {
      if (x.ai === 'dead' || x.hp <= 0 || x.siege || x.pilot || x.variant === 'unique') continue
      const frac = x.hp / x.maxHp
      if (frac >= bestFrac) continue
      const p = this.g.world.positionAt(x, now)
      if ((p[0] - at[0]) ** 2 + (p[2] - at[2]) ** 2 > R.healer.radiusM ** 2) continue
      best = x
      bestFrac = frac
    }
    if (!best) return false
    const instance = this.instanceId()
    s.cast = { ally: best.id, endAt: now + R.healer.castMs, instance }
    m.holdUntil = s.cast.endAt
    const p = this.g.world.positionAt(best, now)
    this.g.world.halt(m, now, best === m ? undefined : yawTowards(p[0] - at[0], p[2] - at[2]))
    this.g.world.broadcastAbout(m, { t: 'cast', id: m.id, skill: ROLE_HEAL_SKILL, instance, target: best.id, prepareMs: 0, castMs: R.healer.castMs, actionMs: 0, clip: 'ATTACK1' })
    return true
  }

  private runCast(m: Mob, s: RoleState, now: number): void {
    const c = s.cast!
    if (this.g.skills.held(m, now)) return this.cancelCast(m, s, now)
    if (now < c.endAt) return
    s.cast = null
    m.holdUntil = undefined
    const ally = this.g.world.mobs.get(c.ally)
    if (!ally || ally.ai === 'dead' || ally.hp <= 0) return
    const hp = Math.min(ally.maxHp, ally.hp + Math.max(1, Math.round((ally.maxHp * R.healer.pct) / 100)))
    if (hp <= ally.hp) return
    ally.hp = hp
    this.stats.heals++
    this.g.world.broadcastAbout(ally, { t: 'entityUpdate', id: ally.id, hp: Math.round(ally.hp) })
  }

  /** A stun / knockdown (or the end of the fight) cancels a heal: castEnd 'interrupted' (§20 `healInterrupted`). */
  private cancelCast(m: Mob, s: RoleState, now: number): void {
    const c = s.cast
    if (!c) return
    s.cast = null
    if (m.holdUntil !== undefined && m.holdUntil <= c.endAt) m.holdUntil = undefined
    s.nextHealAt = now + R.healer.everyMs
    this.stats.healsInterrupted++
    this.g.world.broadcastAbout(m, { t: 'castEnd', id: m.id, instance: c.instance, reason: 'interrupted' })
  }

  // ---- ranged / healer spacing --------------------------------------------------------------------------------

  private stepBack(m: Mob, s: RoleState, now: number): void {
    const p = m.target === null ? undefined : this.g.target(m.target)
    if (!p || p.combat.range > R.ranged.meleeRangeM) return
    const at = this.g.world.positionAt(m, now)
    const tp = this.g.world.positionAt(p, now)
    const dx = at[0] - tp[0]
    const dz = at[2] - tp[2]
    const d = Math.hypot(dx, dz)
    if (d > R.ranged.nearM) return
    s.nextStepAt = now + R.ranged.everyMs
    const speed = m.def.runSpeed > 0 ? m.def.runSpeed : m.def.walkSpeed
    if (!(speed > 0)) return
    const base = d > 0.01 ? Math.atan2(dx, dz) : this.g.rng() * Math.PI * 2
    for (const off of [0, 0.6, -0.6, 1.2, -1.2]) {
      const x = at[0] + Math.sin(base + off) * R.ranged.stepM
      const z = at[2] + Math.cos(base + off) * R.ranged.stepM
      if (!this.g.canWalk(x, z) || !this.g.clear(m, x, z)) continue
      if (!this.g.move(m, x, z, speed)) continue
      m.holdUntil = now + Math.ceil((R.ranged.stepM / speed) * 1000)
      this.stats.steps++
      return
    }
  }

  // ---- coward ------------------------------------------------------------------------------------------------

  private startFlight(m: Mob, s: RoleState, from: Player, now: number): void {
    const speed = m.def.runSpeed > 0 ? m.def.runSpeed : m.def.walkSpeed
    if (!(speed > 0)) return
    const at = this.g.world.positionAt(m, now)
    const fp = this.g.world.positionAt(from, now)
    const dist = Math.min(30, (speed * R.coward.fleeMs) / 1000)
    const base = Math.atan2(at[0] - fp[0], at[2] - fp[2])
    for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6]) {
      const x = at[0] + Math.sin(base + off) * dist
      const z = at[2] + Math.cos(base + off) * dist
      if (!this.g.canWalk(x, z) || !this.g.clear(m, x, z)) continue
      if (!this.g.move(m, x, z, speed)) continue
      s.flee = { until: now + R.coward.fleeMs, from: from.id }
      m.holdUntil = s.flee.until
      this.active.set(m.id, m)
      this.stats.flights++
      return
    }
  }

  private endFlight(m: Mob, s: RoleState, now: number): void {
    const from = s.flee!.from
    s.flee = null
    if (m.holdUntil !== undefined && m.holdUntil <= now) m.holdUntil = undefined
    if (m.ai === 'dead' || m.hp <= 0) return
    const [lo, hi] = s.callN
    const n = lo + Math.floor(this.g.rng() * (hi - lo + 1))
    const helpers = this.mates(m, R.coward.callRadiusM, n, now)
    const at = this.g.world.positionAt(m, now)
    const line = `${m.name} calls for help!`
    const hear = new Set(this.g.world.playersNear(at[0], at[2], R.coward.callRadiusM, now))
    const chaser = this.g.target(from)
    if (chaser) hear.add(chaser)
    for (const p of hear) p.send({ t: 'chat', channel: 'local', fromId: m.id, from: m.name, text: line })
    this.g.world.broadcastAbout(m, { t: 'cast', id: m.id, skill: ROLE_CALL_SKILL, instance: this.instanceId(), prepareMs: 0, castMs: 0, actionMs: 1200, clip: 'HELP' })
    const target = this.g.target(from) ? from : m.target
    if (target === null) return
    for (const h of helpers) {
      this.joins.push({ mob: h, target, at: now + R.coward.joinMs })
      this.stats.calls++
    }
    if (m.ai === 'chase' && m.target === null) m.target = target
  }

  forgetMob(id: number): void {
    this.states.delete(id)
    this.active.delete(id)
  }

  private instanceId(): number {
    const id = this.nextInstance
    this.nextInstance = id >= INSTANCE_MAX ? INSTANCE_BASE : id + 1
    return id
  }
}
