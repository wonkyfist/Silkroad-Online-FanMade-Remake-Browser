import { MAX_COMBAT_HITS, yawTowards, type CombatHit, type GameplayRequest, type MobDef, type MobVariant, type SkillDef } from '@sro/shared'
import { CHASE_REPLAN_MS } from './ai.ts'
import { knob } from './config.ts'
import { VARIANT_RULES, reductionMul, rollSkillHit, type CombatStats, type Rng } from './formulas.ts'
import type { Gameplay } from './gameplay.ts'
import type { GmResult } from './gm.ts'
import type { GameplayModule } from './modules.ts'
import type { StatusRoll } from './skills/engine.ts'
import { selectTargets, type Candidate } from './skills/targeting.ts'
import { arrivalAt, projectileOf, timeline } from './skills/timing.ts'
import type { Mob, Player } from './world.ts'

/**
 * Monster skills (docs/SYSTEMS_COMBAT.md §2.2-§2.3, §2.6; lane MS-S). A mob's swing runs one of its MSKILL rows
 * (skills.json, `SkillDef.mob`) instead of today's single 100 % hit:
 *
 * - Pick: the attack rows (never SUMMON rows) off their own cooldown and within reach (row range + both radii), by
 *   `aiChance` weight (Tiger Girl 100 : 30 : 10 = 71 / 21 / 7 %); none ready: the primary (first) row, even on
 *   cooldown, so a mob never stands idle in reach. A GM `/mobskill` forces the next one.
 * - Timing: `cast` goes out at once (every use: the client plays the row's clip); castMs 0 rolls and applies at once,
 *   otherwise the release waits castMs. The mob is busy (Gameplay.tick skips its AI: it stands still) until
 *   cast + action, and swings again after max(cast + action, the row's cooldown, the mob's attack interval).
 * - Release: the target must still be attackable and within reach plus MOB_RELEASE_SLACK_M (1 m melee: stepping away
 *   dodges; 3 m ranged), else `castEnd target_lost`; a mob stunned, frozen or knocked down before it sends
 *   `castEnd interrupted`. Area rows (`efr` circles) hit the players around the caster, the primary target first.
 *   Projectile rows hold the rolled hits until `arrivalAt(release, distance, projectile)` (the arrow at 40 m/s, the
 *   force bolts at 20 m/s) and send `combat.at`. Statuses go through the skill engine (rollStatuses / applyStatus).
 * - Damage (MOB_SKILL_DAMAGE): the row's flat range replaces the mob's attack power (x variant x tuning); `relative`
 *   (default) scales each row's percent so the primary row's whole swing equals today's one 100 % hit, `retail` uses
 *   the raw percents, `flat` 100 % per hit; MOB_DAMAGE_RATE multiplies after. A row with no damage (Water Ghost gas)
 *   is one empty hit carrying its status.
 * - Ranged specials (AiHost.ranged, the chase branch): a non-primary row whose reach covers the distance, ready, wins
 *   its own `aiChance` % roll at most once per CHASE_REPLAN_MS (the Tiger Girl curses a kiting player).
 * - Summons (MOB_SUMMONS=1, off by default): each SUMMON row's HP band (80/60/40 %; 0 = off) fires once when the mob's
 *   HP first falls to it, spawning its `ssou` groups around the caster (GM-style mobs attacking its target), at most
 *   MOB_SUMMON_CAP alive per summoner. The bands re-arm when the mob is back at full HP. Summons belong to their
 *   summoner: when she dies (either path) or leaves the world, her live summons leave with her (no corpse, no loot),
 *   so a respawned summoner can never stack a second capful at one spot.
 * - Wave 11 (docs/UNIQUES.md §3.6; WAVE_PLAN7 §4.2): a per-mob `summonPolicy` (a unique's own switch) may turn a mob's
 *   SUMMON rows on whatever MOB_SUMMONS says, clip each wave to `perWave` mobs of the allowed `variants` and cap its
 *   live summons at `maxAlive` (instead of MOB_SUMMON_CAP). `Mob.damageMul` multiplies every hit's percent.
 *
 * Every hit goes through Gameplay.dealHits (horse redirect, durability, retaliation, deaths). Per-mob state lives in
 * this module's own map (never on Mob) and is dropped when the mob dies or leaves the world.
 */

export const MOBSKILL_USAGE = 'mobskill <mob id> [MSKILL code | row number]'

/** Rule (docs/SYSTEMS_COMBAT.md §2.3): release slack of a melee row (range < 3 m), metres. */
export const MOB_RELEASE_SLACK_M = 1
/** Rule: release slack of a ranged row (range >= 3 m), metres. */
export const MOB_RELEASE_SLACK_RANGED_M = 3
/** Rows reaching this far (metres) count as ranged (the exporter's rule for `category`). */
const RANGED_ROW_M = 3
/** Rule: a projectile is dropped when its target moved this far past the release reach during the flight (a warp). */
const FLIGHT_SLACK_M = 10
/** Rule: summons appear this far from the summoner (metres). */
const SUMMON_RING_M: [number, number] = [1.5, 3.5]
/** Mob skill cast instances: their own range, far above the skill engine's counter (the client keys casts by instance). */
const INSTANCE_BASE = 1_500_000_000
const INSTANCE_MAX = 2_000_000_000
/** skilldata `ssou` rarity byte -> variant (packages/convert/src/data/mobs.ts MOB_RARITY). */
const SUMMON_VARIANT: Record<number, MobVariant> = { 0: 'normal', 1: 'champion', 4: 'giant', 6: 'elite' }

/**
 * A per-mob summon policy (wave 11; the uniques module's `summons` config, docs/UNIQUES.md §3.6). `on` false keeps the
 * mob's SUMMON rows silent even when MOB_SUMMONS is on; true fires them even when it is off. Absent fields keep the
 * global rules (every summoned mob of the row; MOB_SUMMON_CAP; every variant).
 */
export interface SummonPolicy {
  on: boolean
  /** Most mobs one SUMMON row (one wave) spawns. */
  perWave?: number
  /** Most live summons of this caster (replaces MOB_SUMMON_CAP). */
  maxAlive?: number
  /** Summon groups of other variants are skipped (e.g. ['normal']: no champion, giant or elite adds). */
  variants?: readonly MobVariant[]
}

/** A mob's rows, from its MobDef.skills (MobDef.attacks as a fallback) through the skill book. */
export interface MobRows {
  /** Attack / debuff rows in data order; [0] is the primary. */
  attacks: SkillDef[]
  /** SUMMON rows (`summon` lists), by band. */
  summons: SkillDef[]
}

interface PendingCast {
  row: SkillDef
  target: number
  instance: number
  releaseAt: number
}

interface Flight {
  at: number
  mob: number
  target: number
  row: SkillDef
  instance: number
  aoe: boolean
  hits: CombatHit[]
  statuses: (StatusRoll | null)[]
  /** Beyond this distance from the mob at arrival the target is gone (warped). */
  maxDist: number
}

interface MobState {
  /** Row code -> server ms it is ready again. */
  ready: Map<string, number>
  busyUntil: number
  cast: PendingCast | null
  /** GM `/mobskill`: the row the next swing uses. */
  forced: string | null
  /** Next time the chase branch may try a ranged special. */
  rangedAt: number
  /** SUMMON bands already fired (codes), and the summoned mob ids. */
  fired: Set<string>
  summoned: Set<number>
}

/** A row's damage percent ('att' arg 2: physical, else magical). */
function pctOf(row: SkillDef): number {
  const d = row.damage
  if (!d) return 0
  return d.physPct > 0 ? d.physPct : d.magPct
}

/** No damage at all (the exporter drops `damage` on 0 % / 0-0 rows; older data keeps the zeros): a pure debuff. */
export function hasDamage(row: SkillDef): boolean {
  const d = row.damage
  return !!d && (pctOf(row) > 0 || d.flat[1] > 0)
}

export function isMagicRow(row: SkillDef): boolean {
  const d = row.damage
  return !!d && d.physPct <= 0 && d.magPct > 0
}

/**
 * Percent of one hit of `row` under MOB_SKILL_DAMAGE `mode` (docs/SYSTEMS_COMBAT.md §2.6), before MOB_DAMAGE_RATE.
 * relative: 100 x pct / (primary pct x primary hits), so the primary swing totals today's 100 % x 1.
 */
export function mobHitPct(row: SkillDef, primary: SkillDef, mode: 'relative' | 'retail' | 'flat'): number {
  if (mode === 'flat') return 100
  const pct = pctOf(row)
  if (mode === 'retail') return pct
  const total = pctOf(primary) * Math.max(1, primary.damage?.hits ?? 1)
  return total > 0 ? (100 * pct) / total : pct
}

/** Weighted pick by `aiChance` (absent = 100); weight-0 rows never. null when nothing has weight. */
export function pickRow(rows: readonly SkillDef[], rng: Rng): SkillDef | null {
  const w = (r: SkillDef) => Math.max(0, r.aiChance ?? 100)
  const total = rows.reduce((s, r) => s + w(r), 0)
  if (total <= 0) return null
  let x = rng() * total
  let last: SkillDef | null = null
  for (const r of rows) {
    if (w(r) <= 0) continue
    last = r
    if ((x -= w(r)) < 0) return r
  }
  return last
}

/**
 * The mob's CombatStats for `row` (§2.3): the row's flat range x variant attack x tuning replaces the physical or
 * magical attack power; every other stat (hit rate, crit, debuffs on the mob) stays the mob's own.
 */
export function rowStats(m: Mob, row: SkillDef): CombatStats {
  const d = row.damage
  if (!d || d.flat[1] <= 0) return m.combat
  const mul = VARIANT_RULES[m.variant].attack * (m.tuning?.attackMul ?? 1)
  const range: [number, number] = [Math.round(d.flat[0] * mul), Math.round(d.flat[1] * mul)]
  return isMagicRow(row) ? { ...m.combat, magAttack: range } : { ...m.combat, physAttack: range }
}

export class MobSkills implements GameplayModule {
  readonly name = 'mobSkills'
  readonly handles: readonly GameplayRequest[] = []

  private readonly states = new Map<number, MobState>()
  private flights: Flight[] = []
  /** MobDef code -> its rows (rebuilt when the skill book is replaced). */
  private rowCache = new Map<string, MobRows>()
  private cacheBook: unknown = null
  private nextInstance = INSTANCE_BASE
  /** Wave 11: the per-mob summon policy (Gameplay wires it to the uniques module); null = the global rules. */
  summonPolicy: (m: Mob) => SummonPolicy | null = () => null

  constructor(readonly g: Gameplay) {}

  // ---- data ------------------------------------------------------------------------------------------------

  /** The attack and SUMMON rows of a mob kind (empty when its skills have no data: today's basic attack). */
  rowsOf(def: MobDef): MobRows {
    const book = this.g.skills.book
    if (book !== this.cacheBook) {
      this.cacheBook = book
      this.rowCache = new Map()
    }
    let r = this.rowCache.get(def.code)
    if (!r) {
      const codes = def.skills?.length ? def.skills : (def.attacks ?? []).map((a) => a.code)
      r = { attacks: [], summons: [] }
      for (const code of codes) {
        const row = book.skill(code)
        if (!row?.mob) continue
        if (row.summon?.length) r.summons.push(row)
        else if (row.kind === 'attack' || row.kind === 'debuff') {
          if (hasDamage(row) || row.statuses?.length) r.attacks.push(row)
        }
      }
      this.rowCache.set(def.code, r)
    }
    return r
  }

  private state(m: Mob): MobState {
    let s = this.states.get(m.id)
    if (!s) this.states.set(m.id, (s = { ready: new Map(), busyUntil: 0, cast: null, forced: null, rangedAt: 0, fired: new Set(), summoned: new Set() }))
    return s
  }

  private instanceId(): number {
    const id = this.nextInstance
    this.nextInstance = id >= INSTANCE_MAX ? INSTANCE_BASE : id + 1
    return id
  }

  /**
   * Reach of `row` from `m` to `t`, centre to centre (metres). The primary row reaches at least the mob's attack range
   * (the AI's swing reach, ai.ts mobReach), so a swing it starts can always land.
   */
  reach(m: Mob, row: SkillDef, t: { radius: number }): number {
    const primary = this.rowsOf(m.def).attacks[0] === row
    return Math.max(0, row.range, primary ? m.def.attackRange : 0) + m.radius + t.radius
  }

  // ---- the AI's calls ----------------------------------------------------------------------------------------

  /** The AI's swing of `m` at `target` (in reach, `m.nextSwingAt` reached): picks and runs one attack row. */
  swing(m: Mob, target: Player, now: number): void {
    const rows = this.rowsOf(m.def).attacks
    if (rows.length === 0) return this.g.attack(m, target, now)
    const s = this.state(m)
    if (s.cast) return
    const d = this.g.world.distance(m, target, now)
    const forced = s.forced ? rows.find((r) => r.code === s.forced) : undefined
    s.forced = null
    const ready = rows.filter((r) => (s.ready.get(r.code) ?? 0) <= now && this.reach(m, r, target) >= d)
    const row = forced ?? pickRow(ready, this.g.rng) ?? rows[0]
    this.use(m, row, target, now)
  }

  /** Whether `m` is inside a skill's cast or action window (its AI waits: it stands still). */
  busy(m: Mob, now: number): boolean {
    const s = this.states.get(m.id)
    return !!s && (s.cast !== null || now < s.busyUntil)
  }

  /**
   * Chase branch (target out of the primary reach, `dist` metres away): true when `m` cast a ranged special at
   * `target` instead of chasing. A non-primary row (or the GM-forced one) whose reach covers `dist`, off cooldown, that
   * wins its own `aiChance` % roll; asked at most once per CHASE_REPLAN_MS.
   */
  ranged(m: Mob, target: Player, dist: number, now: number): boolean {
    const rows = this.rowsOf(m.def).attacks
    if (rows.length < 2 && !this.states.get(m.id)?.forced) return false
    const s = this.state(m)
    if (s.cast || now < s.busyUntil) return false
    if (s.forced) {
      const f = rows.find((r) => r.code === s.forced)
      if (f && this.reach(m, f, target) >= dist) {
        s.forced = null
        this.use(m, f, target, now)
        return true
      }
    }
    if (now < s.rangedAt) return false
    s.rangedAt = now + CHASE_REPLAN_MS
    for (const row of rows.slice(1)) {
      const chance = row.aiChance ?? 100
      if (chance <= 0 || (s.ready.get(row.code) ?? 0) > now || this.reach(m, row, target) < dist) continue
      if (this.g.rng() * 100 >= chance) continue
      this.use(m, row, target, now)
      return true
    }
    return false
  }

  // ---- one use -----------------------------------------------------------------------------------------------

  /** Starts `row` of `m` at `target`: cooldown, busy window, `cast`; the release now (castMs 0) or on the tick. */
  use(m: Mob, row: SkillDef, target: Player, now: number): void {
    const s = this.state(m)
    const tl = timeline(row, now)
    const instance = this.instanceId()
    s.ready.set(row.code, now + Math.max(0, row.cooldownMs))
    s.busyUntil = tl.endAt
    m.nextSwingAt = now + Math.max(200, tl.endAt - now, row.cooldownMs, m.def.attackIntervalMs)
    const w = this.g.world
    const mp = w.positionAt(m, now)
    const tp = w.positionAt(target, now)
    w.halt(m, now, yawTowards(tp[0] - mp[0], tp[2] - mp[2]))
    w.broadcastAbout(m, { t: 'cast', id: m.id, skill: row.code, instance, target: target.id, prepareMs: tl.prepareMs, castMs: tl.castMs, actionMs: tl.actionMs })
    const cast: PendingCast = { row, target: target.id, instance, releaseAt: tl.releaseAt }
    if (tl.releaseAt <= now) this.release(m, s, cast, now)
    else s.cast = cast
  }

  /** The release (§2.3): the target check with slack, then the hits on every target of the row. */
  private release(m: Mob, s: MobState, c: PendingCast, now: number): void {
    s.cast = null
    const w = this.g.world
    const t = this.g.target(c.target)
    const slack = c.row.range >= RANGED_ROW_M ? MOB_RELEASE_SLACK_RANGED_M : MOB_RELEASE_SLACK_M
    const reach = t ? this.reach(m, c.row, t) + slack : 0
    if (!t || w.distance(m, t, now) > reach) {
      w.broadcastAbout(m, { t: 'castEnd', id: m.id, instance: c.instance, reason: 'target_lost' })
      // The swing was lost: the mob may move again (its swing time stays).
      s.busyUntil = Math.min(s.busyUntil, now)
      return
    }
    this.strike(m, c.row, t, c.instance, reach, now)
  }

  private cand(e: Mob | Player, now: number): Candidate {
    const p = this.g.world.positionAt(e, now)
    return { id: e.id, x: p[0], z: p[2], radius: e.radius }
  }

  /** Hits of `row` on the primary and (area rows) the attackable players around; projectiles fly. */
  private strike(m: Mob, row: SkillDef, primary: Player, instance: number, reach: number, now: number): void {
    const w = this.g.world
    let targets: Player[] = [primary]
    if (row.area) {
      const centre = row.area.shape === 'caster' ? m : primary
      const c = this.cand(centre, now)
      const range = Math.max(row.area.distance, w.distance(m, primary, now)) + 3
      const others = this.g.playersNear(c.x, c.z, range).filter((p) => p.id !== primary.id).map((p) => this.cand(p, now))
      const picked = selectTargets(row.area, this.cand(m, now), this.cand(primary, now), others)
      targets = picked.map((x) => (x.id === primary.id ? primary : w.players.get(x.id))).filter((p): p is Player => !!p)
    }
    const proj = projectileOf(row)
    targets.forEach((t, i) => {
      const aoe = i > 0
      const { hits, statuses } = this.rollHits(m, row, t, aoe && row.area ? reductionMul(row.area.reductionPct) : 1)
      if (proj) {
        const at = arrivalAt(now, w.distance(m, t, now), proj)
        this.flights.push({ at, mob: m.id, target: t.id, row, instance, aoe, hits, statuses, maxDist: reach + FLIGHT_SLACK_M })
      } else this.land(m, t, row, hits, statuses, aoe ? { instance, aoe } : { instance }, now)
    })
  }

  /** `mc` hits of the row with the §2.6 percent; a row without damage is one empty hit carrying its status. */
  rollHits(m: Mob, row: SkillDef, t: Player, mul: number): { hits: CombatHit[]; statuses: (StatusRoll | null)[] } {
    const skills = this.g.skills
    if (!hasDamage(row)) {
      const hit: CombatHit = { outcome: 'hit', damage: 0, hp: 0 }
      return { hits: [hit], statuses: [skills.rollStatuses(row, t, hit)] }
    }
    const primary = this.rowsOf(m.def).attacks[0] ?? row
    const mode = knob(this.g.config, 'mobSkillDamage')
    const pct = mobHitPct(row, primary, mode) * knob(this.g.config, 'mobDamageRate') * (m.damageMul ?? 1)
    const att = rowStats(m, row)
    const spec = { pct, magic: isMagicRow(row), mul }
    const hits: CombatHit[] = []
    const statuses: (StatusRoll | null)[] = []
    for (let i = 0; i < Math.min(MAX_COMBAT_HITS, Math.max(1, row.damage?.hits ?? 1)); i++) {
      const h = rollSkillHit(att, t.combat, spec, this.g.rng)
      const hit: CombatHit = { outcome: h.outcome, damage: h.damage, hp: 0 }
      hits.push(hit)
      statuses.push(h.outcome === 'hit' || h.outcome === 'crit' ? skills.rollStatuses(row, t, hit) : null)
    }
    return { hits, statuses }
  }

  /** Applies the hits through Gameplay.dealHits, then the statuses of the hits that landed. */
  private land(m: Mob, t: Player, row: SkillDef, hits: CombatHit[], statuses: (StatusRoll | null)[], extra: { instance: number; at?: number; aoe?: boolean }, now: number): void {
    const r = this.g.dealHits(m, t, hits, { ...extra, skill: row.code }, now)
    if (r.killed) return
    for (let i = 0; i < r.hits.length; i++) {
      const st = statuses[i]
      if (st && r.hits[i].outcome !== 'miss' && r.hits[i].outcome !== 'block') this.g.skills.applyStatus(m, t, st, now)
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------

  /** Once per server tick, after the mobs: releases, interrupts, projectiles, summons, cleanup. */
  tick(now: number): void {
    const w = this.g.world
    for (const [id, s] of this.states) {
      const m = w.mobs.get(id)
      // A summoner that died without the hook (GM kill) or left the world takes its summons along.
      if (!m || m.ai === 'dead') this.despawnSummons(s)
      if (!m) {
        this.states.delete(id)
        continue
      }
      const c = s.cast
      if (!c) continue
      if (m.ai === 'dead' || this.g.skills.held(m, now)) {
        s.cast = null
        s.busyUntil = Math.min(s.busyUntil, now)
        w.broadcastAbout(m, { t: 'castEnd', id: m.id, instance: c.instance, reason: 'interrupted' })
        continue
      }
      if (now >= c.releaseAt) this.release(m, s, c, now)
    }
    if (this.flights.length) {
      const due = this.flights.filter((f) => f.at <= now)
      if (due.length) {
        this.flights = this.flights.filter((f) => f.at > now)
        for (const f of due) this.arrive(f, now)
      }
    }
    this.summons(now, knob(this.g.config, 'mobSummons') > 0)
  }

  /** A projectile lands: its target still attackable and not warped away (the mob may have died meanwhile). */
  private arrive(f: Flight, now: number): void {
    const m = this.g.world.mobs.get(f.mob)
    const t = this.g.target(f.target)
    if (!m || !t || this.g.world.distance(m, t, now) > f.maxDist) return
    this.land(m, t, f.row, f.hits, f.statuses, f.aoe ? { instance: f.instance, at: f.at, aoe: true } : { instance: f.instance, at: f.at }, now)
  }

  /** A mob died: a cast not yet released ends (`castEnd`); its projectiles in flight still land. */
  mobDied(m: Mob): void {
    const s = this.states.get(m.id)
    if (!s) return
    if (s.cast) this.g.world.broadcastAbout(m, { t: 'castEnd', id: m.id, instance: s.cast.instance, reason: 'interrupted' })
    this.despawnSummons(s)
    this.states.delete(m.id)
  }

  /**
   * Wave 11 (docs/UNIQUES.md §3.6, lane U-S): a unique's leash reset sends its live summons away now (no corpse, no
   * loot), the way they leave when she dies. Returns how many left.
   */
  dismissSummons(m: Mob): number {
    const s = this.states.get(m.id)
    if (!s) return 0
    let n = 0
    for (const id of s.summoned) if (this.g.world.mobs.get(id)?.ai !== 'dead' && this.g.world.mobs.has(id)) n++
    this.despawnSummons(s)
    return n
  }

  /** The summoner is gone: its live summons (nest-less mobs) leave the world with it; corpses decay as usual. */
  private despawnSummons(s: MobState): void {
    const w = this.g.world
    for (const id of s.summoned) {
      const m = w.mobs.get(id)
      if (m && m.ai !== 'dead') w.removeEntity(id)
    }
    s.summoned.clear()
  }

  // ---- summons (phase 2, MOB_SUMMONS) --------------------------------------------------------------------------

  /** `global`: MOB_SUMMONS is on. A mob's summonPolicy overrides it either way. */
  private summons(now: number, global: boolean): void {
    for (const m of this.g.world.mobs.values()) {
      if (m.ai === 'dead') continue
      const rows = this.rowsOf(m.def).summons
      if (rows.length === 0) continue
      const policy = this.summonPolicy(m)
      if (!(policy ? policy.on : global)) continue
      const s = this.state(m)
      if (m.hp >= m.maxHp) {
        if (m.ai === 'idle') s.fired.clear()
        continue
      }
      const hpPct = (m.hp / Math.max(1, m.maxHp)) * 100
      for (const row of rows) {
        const band = row.aiChance ?? 0
        if (band <= 0 || s.fired.has(row.code) || hpPct > band) continue
        s.fired.add(row.code)
        this.summon(m, s, row, now, policy)
      }
    }
  }

  /**
   * Spawns the row's `ssou` groups around `m` (at most MOB_SUMMON_CAP of its summons alive), attacking its target. A
   * `policy` (wave 11) clips the wave to `perWave`, skips groups of other `variants` and caps at `maxAlive`.
   */
  summon(m: Mob, s: MobState, row: SkillDef, now: number, policy: SummonPolicy | null = null): number[] {
    const w = this.g.world
    for (const id of s.summoned) if (w.mobs.get(id)?.ai === 'dead' || !w.mobs.has(id)) s.summoned.delete(id)
    const cap = policy?.maxAlive ?? knob(this.g.config, 'mobSummonCap')
    const perWave = policy?.perWave ?? Infinity
    const at = w.livePoint(m, now)
    const target = m.target === null ? undefined : this.g.target(m.target)
    const out: number[] = []
    for (const grp of row.summon ?? []) {
      const def = this.g.data.mob(grp.mob)
      if (!def) continue
      const variant: MobVariant = def.rarity === 'unique' ? 'unique' : (SUMMON_VARIANT[grp.rarity] ?? 'normal')
      if (policy?.variants && !policy.variants.includes(variant)) continue
      const n = grp.min + Math.floor(this.g.rng() * (Math.max(grp.min, grp.max) - grp.min + 1))
      for (let i = 0; i < n && s.summoned.size < cap && out.length < perWave; i++) {
        const a = this.g.rng() * Math.PI * 2
        const r = SUMMON_RING_M[0] + this.g.rng() * (SUMMON_RING_M[1] - SUMMON_RING_M[0])
        const [x, z] = w.clamp(at.x + Math.sin(a) * r, at.z + Math.cos(a) * r)
        // On the summoner's own level (a straight walk from it, never through a wall); flat worlds: as is.
        const wk = this.g.nav.kind === 'mesh' ? this.g.nav.walk(at, x, z) : null
        const p = wk && Number.isFinite(wk.end.y) ? wk.end : { x, y: at.y, z, surface: at.surface }
        const mob = this.g.createMob(def, variant, p.x, p.z, p.y, null, now, p.surface)
        if (target) {
          mob.ai = 'chase'
          mob.target = target.id
          mob.nextThinkAt = 0
        }
        s.summoned.add(mob.id)
        out.push(mob.id)
      }
    }
    return out
  }

  // ---- GM ------------------------------------------------------------------------------------------------------

  /**
   * GM `mobskill <mob id>`: lists the mob's rows; `mobskill <mob id> <code | row number>`: the mob uses that row now on
   * its target (or on the GM, whom it turns on) when it is in reach, else on its next swing.
   */
  gm(self: Player, args: string[]): GmResult {
    const id = Number(args[0])
    if (args.length < 1 || args.length > 2 || !Number.isInteger(id)) return { ok: false, message: `Usage: ${MOBSKILL_USAGE}` }
    const m = this.g.world.mobs.get(id)
    if (!m) return { ok: false, message: `No monster with id ${id}.` }
    if (m.ai === 'dead') return { ok: false, message: `${m.name} is dead.` }
    const rows = this.rowsOf(m.def).attacks
    if (rows.length === 0) return { ok: false, message: `${m.name} has no skill data (it uses its basic attack).` }
    const now = this.g.now
    const s = this.state(m)
    if (args.length === 1) {
      const list = rows.map((r, i) => {
        const cd = Math.max(0, (s.ready.get(r.code) ?? 0) - now)
        return `${i + 1}. ${r.code} (weight ${r.aiChance ?? 100}, range ${r.range} m${cd > 0 ? `, ready in ${(cd / 1000).toFixed(1)} s` : ''})`
      })
      return { ok: true, message: `${m.name} (id ${m.id}): ${list.join('; ')}`, data: { id: m.id, rows: rows.map((r) => r.code) } }
    }
    const key = args[1].toUpperCase()
    const n = Number(key)
    const row = Number.isInteger(n) && n >= 1 && n <= rows.length ? rows[n - 1] : rows.find((r) => r.code === key) ?? (rows.filter((r) => r.code.endsWith(key)).length === 1 ? rows.find((r) => r.code.endsWith(key)) : undefined)
    if (!row) return { ok: false, message: `${m.name} has no row ${args[1]}. Rows: ${rows.map((r, i) => `${i + 1} ${r.code}`).join(', ')}` }
    if (this.busy(m, now)) {
      s.forced = row.code
      return { ok: true, message: `${m.name} is busy; it uses ${row.code} next.`, data: { id: m.id, skill: row.code, now: false } }
    }
    let target = m.target === null ? undefined : this.g.target(m.target)
    if (!target && this.g.target(self.id)) {
      target = self
      m.ai = 'chase'
      m.target = self.id
      m.nextThinkAt = 0
    }
    if (target && this.g.world.distance(m, target, now) <= this.reach(m, row, target)) {
      this.use(m, row, target, now)
      return { ok: true, message: `${m.name} uses ${row.code} on ${target.name}.`, data: { id: m.id, skill: row.code, now: true } }
    }
    s.forced = row.code
    m.nextSwingAt = Math.min(m.nextSwingAt, now)
    return { ok: true, message: `${m.name} uses ${row.code} on its next swing.`, data: { id: m.id, skill: row.code, now: false } }
  }
}
