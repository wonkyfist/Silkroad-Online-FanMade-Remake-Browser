import {
  CALM_ENV,
  STORM_TABLE,
  clockAt,
  elementMul as elementMulOf,
  elementOf,
  mobDamageMul,
  mobRangeMul,
  mobSpeedMul,
  mudSlowPct,
  nestCountMul,
  nightness,
  panics,
  shockMul,
  sightMul,
  storming,
  stormEffects,
  stormLevel,
  stormMobKind,
  stormPhase,
  strong,
  sunDirection,
  windMiss,
  type CombatHit,
  type HazardCause,
  type SkillDef,
  type StormEnv,
  type StormMobKind,
  type StormStatus,
  type Vec3,
} from '@sro/shared'
import type { AiStorm } from '../ai.ts'
import type { Gameplay, HitExtra, RolledDrop } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import type { StrikeEvent } from '../lightning/service.ts'
import type { GameplayModule } from '../modules.ts'
import type { NestRuntime } from '../spawner.ts'
import type { Cos, Mob, Player } from '../world.ts'
import { StormPlan, stormFrequency, type StormEvent } from './schedule.ts'

/**
 * Storms change everything (docs/WEATHER.md §12). A GameplayModule named `storm` that reads the weather once a second
 * into a StormEnv (rain, storm level, wind, surface wetness, night, strength) and answers the hooks the rest of the
 * server asks, so no rule is scattered over the AI, combat and spawn code:
 *
 * - **AI** (ai.ts AiStorm, through Gameplay): sight (rain, night), leash and roam (bandits pull back), chase speed
 *   (undead). A panicking beast skips its AI (Gameplay.tick asks `panicking`).
 * - **Combat** (Gameplay.dealHits, hazardHit; skills/engine.ts): `elementMul` (fire / lightning / cold force in the
 *   rain), `shapeHits` (wind spreads ranged player attacks; undead and charged monsters hit harder), `afterHits` (a
 *   charged monster's hit arcs to a player nearby), `hazardMul` (a wet player takes more from lightning).
 * - **Spawns** (Spawner countMul): water spirits, small animals, the big cats; `reconcile` fills or thins the nests.
 * - **Players**: mud slows running on a soaked ground outside towns (a stat mod; refresh on change).
 * - **Lightning** (`onStrike`): a strike landing near a beast panics it (aggro dropped, it scatters for a few seconds);
 *   a monster that survives a strike during a storm is charged until the storm ends or it dies (EntityState.charged):
 *   more damage, its hits arc, better loot (`lootBonus`, `plusLoot`).
 * - **Forecast** (schedule.ts StormPlan, handed to WeatherService): uncommon storm events, announced; the status (phase,
 *   times, effects) goes to every player as `storm` when it changes.
 * - Uniques and the Play the Boss body are never affected; nor are GM previews of the weather beyond what it does.
 *
 * The lightning tornado (storm/tornado.ts, its own module) reads `event`; `storm tornado ...` routes to it. A later step
 * (destructible Jangan walls with a siege) hooks `onStrike`, `env` and TornadoService.onTornado the same way.
 */

export const STORM_USAGE = 'storm [start [minutes] [forecastMinutes] | forecast [minutes] | stop | preview | charge [mob id] | tornado [here | <player> | stop]]'

/** The status and env refresh interval (ms). */
const ENV_MS = 1000

const ok = (message: string, data?: unknown): GmResult => ({ ok: true, message, data })
const fail = (message: string): GmResult => ({ ok: false, message })

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

export class StormService implements GameplayModule, AiStorm {
  readonly name = 'storm'
  readonly plan: StormPlan
  readonly table = STORM_TABLE
  /** The weather as storm gameplay reads it (refreshed once a second; tests may set it). */
  env: StormEnv = { ...CALM_ENV }
  /** Tests: true keeps `env` as set (no refresh from the weather). */
  pinned = false
  private status: StormStatus = { phase: 'calm', effects: [] }
  private statusKey = ''
  private lastEnvAt = -Infinity
  private nextReconcile = 0
  private readonly kinds = new Map<string, StormMobKind>()
  /** Charged monsters: entity id -> the next time its hit may arc. */
  private readonly chargedArc = new Map<number, number>()
  /** Panicking monsters: entity id -> until. */
  private readonly panic = new Map<number, number>()
  /** Players slowed by mud. */
  private readonly muddy = new Set<number>()

  constructor(private readonly g: Gameplay) {
    this.plan = new StormPlan(g.config, () => g.weather.mode === 'auto')
    g.weather.storms = this.plan
    g.lightning.onStrike((e) => this.onStrike(e))
    g.skills.addModProvider((p) => (this.muddy.has(p.id) ? [{ stat: 'speedPct', value: -mudSlowPct(this.env, this.table) }] : []))
    g.world.decorators.push((e, s) => {
      if (e.kind === 'mob' && this.chargedArc.has(e.id)) s.charged = true
    })
  }

  // ---- queries -----------------------------------------------------------------------------------------------

  /** The status the players were last sent. */
  get current(): Readonly<StormStatus> {
    return this.status
  }

  /** The storm kind of a monster (uniques and the Play the Boss body: 'other'). */
  kindOf(m: Mob): StormMobKind {
    return m.variant === 'unique' || m.pilot ? 'other' : this.codeKind(m.def.code)
  }

  /** The storm kind of a monster code (cached: the spawner and the hooks ask often). */
  private codeKind(code: string): StormMobKind {
    let k = this.kinds.get(code)
    if (k === undefined) this.kinds.set(code, (k = stormMobKind(code)))
    return k
  }

  /** Untouched by storms: uniques and the Play the Boss body. */
  exempt(m: Mob): boolean {
    return m.variant === 'unique' || !!m.pilot
  }

  isCharged(m: Mob): boolean {
    return this.chargedArc.has(m.id)
  }

  panicking(m: Mob, now: number): boolean {
    const until = this.panic.get(m.id)
    if (until === undefined) return false
    if (now < until && m.ai !== 'dead') return true
    this.panic.delete(m.id)
    return false
  }

  /** The storm event in force (scheduled storms only with WEATHER=auto; nothing with WEATHER=off). */
  event(now: number): StormEvent | null {
    const mode = this.g.weather.mode
    if (mode === 'off') return null
    const e = this.plan.event(now)
    return e && (mode === 'auto' || e.gm) ? e : null
  }

  // ---- AiStorm (ai.ts) ---------------------------------------------------------------------------------------

  sight(m: Mob): number {
    if (this.exempt(m)) return m.sightRange
    if (this.panic.has(m.id)) return 0
    return m.sightRange * sightMul(this.env, this.table)
  }

  leash(m: Mob): number {
    if (this.exempt(m)) return m.leashRange
    const mul = mobRangeMul(this.env, this.kindOf(m), this.table).leash
    return mul === 1 ? m.leashRange : Math.max(10, m.leashRange * mul)
  }

  roam(m: Mob): number {
    if (this.exempt(m)) return m.roamRadius
    return m.roamRadius * mobRangeMul(this.env, this.kindOf(m), this.table).roam
  }

  speed(m: Mob, base: number): number {
    if (this.exempt(m)) return base
    return base * mobSpeedMul(this.env, this.kindOf(m), this.table)
  }

  // ---- combat hooks ------------------------------------------------------------------------------------------

  /** Fire / lightning / cold force damage in the rain (skills/engine.ts: a skill's hits, an imbue's component). */
  elementMul(row: Pick<SkillDef, 'mastery'> | null | undefined): number {
    return elementMulOf(this.env, elementOf(row?.mastery), this.table)
  }

  /** Whether a player's attack is ranged (the wind spreads it): a bow, or a physical skill reaching 10 m or more. */
  ranged(p: Player, skill?: string): boolean {
    if (p.combat.weapon === 'bow') return true
    const row = skill === undefined ? undefined : this.g.skills.book.skill(skill)
    return !!row?.damage && row.damage.physPct > 0 && row.range >= 10
  }

  /**
   * The rolled hits of `a` on `t` before they land (Gameplay.dealHits): strong wind makes a ranged player attack miss
   * now and then; undead in a storm and charged monsters hit harder. Returns the hits to apply.
   */
  shapeHits(a: Player | Mob, t: Player | Mob | Cos, hits: CombatHit[], extra: HitExtra): CombatHit[] {
    if (a.kind === 'player') {
      if (extra.dot || t.kind !== 'mob' || !this.ranged(a, extra.skill)) return hits
      const miss = windMiss(this.env, this.table)
      if (miss <= 0) return hits
      return hits.map((h) => ((h.outcome === 'hit' || h.outcome === 'crit') && this.g.rng() < miss ? { outcome: 'miss', damage: 0, hp: h.hp } : h))
    }
    if (this.exempt(a)) return hits
    let mul = mobDamageMul(this.env, this.kindOf(a), this.table)
    if (this.chargedArc.has(a.id)) mul *= strong(this.table.chargedDamageMul, this.env.strength)
    if (mul === 1) return hits
    return hits.map((h) => (h.damage > 0 ? { ...h, damage: Math.max(1, Math.round(h.damage * mul)) } : h))
  }

  /** After `a`'s hits landed on `t` (Gameplay.dealHits): a charged monster's hit arcs to the nearest other player. */
  afterHits(a: Player | Mob, t: Player | Mob | Cos, dealt: number, now: number): void {
    if (a.kind !== 'mob' || t.kind !== 'player' || dealt <= 0) return
    const ready = this.chargedArc.get(a.id)
    if (ready === undefined || now < ready) return
    const at = this.g.world.positionAt(t, now)
    let best: Player | null = null
    let bestD = this.table.chargedArcM
    for (const p of this.g.world.playersNear(at[0], at[2], this.table.chargedArcM, now)) {
      if (p.id === t.id || p.dead || p.trance || p.invisible) continue
      const q = this.g.world.positionAt(p, now)
      if (this.g.data.inSafeArea(this.g.config.world, q[0], q[2])) continue
      const d = Math.hypot(q[0] - at[0], q[2] - at[2])
      if (d <= bestD) {
        best = p
        bestD = d
      }
    }
    if (!best) return
    this.chargedArc.set(a.id, now + this.table.chargedArcCooldownMs)
    this.g.world.broadcastAboutEither(t, best, { t: 'stormArc', from: t.id, to: best.id, at: Math.round(now), mob: a.id })
    this.g.hazardHit(best, Math.max(1, Math.round(dealt * this.table.chargedArcPct)), 'arc', now)
  }

  /** Damage without an attacker on `t` (Gameplay.hazardHit): a wet player takes more from lightning and arcs. */
  hazardMul(t: Player | Mob, cause: HazardCause): number {
    return t.kind === 'player' && (cause === 'lightning' || cause === 'arc') ? shockMul(this.env, this.table) : 1
  }

  // ---- loot ----------------------------------------------------------------------------------------------------

  /** The drop-rate and gold multipliers of a kill (a charged monster's are better). */
  lootBonus(m: Mob): { drop: number; gold: number } {
    if (!this.chargedArc.has(m.id)) return { drop: 1, gold: 1 }
    return { drop: strong(this.table.chargedDropMul, this.env.strength), gold: strong(this.table.chargedGoldMul, this.env.strength) }
  }

  /** A charged monster's gear drops: a chance of +1 each. */
  plusLoot(m: Mob, drops: RolledDrop[]): RolledDrop[] {
    if (!this.chargedArc.has(m.id)) return drops
    const chance = Math.min(1, this.table.chargedPlusChance * this.env.strength)
    return drops.map((d) => {
      if (d.gold || !this.g.data.item(d.code)?.slot || this.g.rng() >= chance) return d
      return { ...d, plus: (d.plus ?? 0) + 1 }
    })
  }

  // ---- spawns ------------------------------------------------------------------------------------------------

  /** The live count multiplier of a plain nest (Spawner countMul). */
  countMul(nest: NestRuntime): number {
    if (nest.mob.rarity === 'unique') return 1
    return nestCountMul(this.env, this.codeKind(nest.mob.code), this.table)
  }

  /**
   * Brings the storm-touched nests to their live count: fills the ones short of it (water spirits rising, the animals
   * coming back after the storm) and thins the ones above it, a few idle untouched monsters per pass (they hide).
   */
  reconcile(now: number): void {
    const sp = this.g.spawner
    for (const nest of sp.nests) {
      if (nest.group) continue
      const kind = this.codeKind(nest.mob.code)
      if (kind !== 'water' && kind !== 'critter' && kind !== 'predator') continue
      const want = sp.wanted(nest)
      const have = nest.alive.size + nest.pending.length
      if (have < want) this.g.fillNest(nest, now)
      else if (nest.alive.size > want) {
        const spare: number[] = []
        for (const id of nest.alive) {
          if (spare.length >= Math.min(this.table.despawnPerPass, nest.alive.size - want)) break
          const m = this.g.world.mobs.get(id)
          if (m && m.ai === 'idle' && m.damage.size === 0 && m.hp >= m.maxHp && !this.chargedArc.has(id)) spare.push(id)
        }
        if (spare.length) this.g.despawnNestMobs(spare)
      }
    }
  }

  // ---- lightning (lightning/service.ts onStrike) ---------------------------------------------------------------

  private onStrike(e: StrikeEvent): void {
    if (e.phase !== 'land' || this.env.strength <= 0) return
    const now = this.g.now
    const s = e.strike
    // charged: a monster that took the bolt and lived, while a storm rages
    if (storming(this.env, this.table)) {
      for (const h of e.hits) {
        if (h.kind !== 'mob' || h.killed) continue
        const m = this.g.world.mobs.get(h.id)
        if (m && m.ai !== 'dead' && !this.exempt(m)) this.charge(m, now)
      }
    }
    if (s.kind === 'sky') return
    // thunder panic: the beasts around the impact scatter
    const r = this.table.panicRadiusM
    const gx = s.pos[0]
    const gz = s.pos[2]
    for (const m of this.g.world.mobs.values()) {
      if (m.ai === 'dead' || this.exempt(m) || !panics(this.kindOf(m))) continue
      const p = this.g.world.positionAt(m, now)
      const d = Math.hypot(p[0] - gx, p[2] - gz)
      if (d > r) continue
      this.scare(m, p, gx, gz, now)
    }
  }

  /** Makes `m` storm-charged (until the storm ends or it dies). */
  charge(m: Mob, now: number): boolean {
    if (this.exempt(m) || m.ai === 'dead') return false
    if (!this.chargedArc.has(m.id)) {
      this.chargedArc.set(m.id, now)
      this.g.world.broadcastAbout(m, { t: 'entityUpdate', id: m.id, charged: true })
    }
    return true
  }

  private uncharge(id: number, tell: boolean): void {
    if (!this.chargedArc.delete(id)) return
    const m = this.g.world.mobs.get(id)
    if (m && tell) this.g.world.broadcastAbout(m, { t: 'entityUpdate', id, charged: false })
  }

  /** Panic: drop the target, run away from (gx, gz) for a few seconds. */
  private scare(m: Mob, p: Vec3, gx: number, gz: number, now: number): void {
    const [lo, hi] = this.table.panicMs
    this.panic.set(m.id, now + lo + (hi - lo) * this.g.rng())
    m.target = null
    if (m.ai === 'chase') m.ai = 'idle'
    const speed = m.def.runSpeed > 0 ? m.def.runSpeed : m.def.walkSpeed
    if (speed <= 0) return
    const away = Math.atan2(p[2] - gz, p[0] - gx)
    const [fl, fh] = this.table.panicFleeM
    const dist = fl + (fh - fl) * this.g.rng()
    for (let i = 0; i < 5; i++) {
      // straight away first, then fanning out to either side
      const a = away + (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.6) + (this.g.rng() - 0.5) * 0.3
      const [x, z] = this.g.world.clamp(p[0] + Math.cos(a) * dist, p[2] + Math.sin(a) * dist)
      if (this.g.canWalk(x, z) && this.g.clear(m, x, z) && this.g.world.moveEntity(m, x, z, speed, now)) return
    }
  }

  // ---- module hooks --------------------------------------------------------------------------------------------

  /** A player entering hears the storm status unless all is calm (the client starts calm). */
  enter(p: Player): void {
    if (this.status.phase !== 'calm' || this.status.effects.length > 0) p.send({ t: 'storm', storm: this.status })
  }

  forget(p: Player): void {
    this.muddy.delete(p.id)
  }

  mobDied(m: Mob): void {
    this.panic.delete(m.id)
    this.uncharge(m.id, true)
  }

  tick(now: number): void {
    if (now - this.lastEnvAt >= ENV_MS || now < this.lastEnvAt) {
      this.lastEnvAt = now
      if (!this.pinned) this.env = this.readEnv(now)
      this.updateStatus(now)
      this.sweep(now)
      this.updateMud(now)
      this.packs(now)
    }
    if (now >= this.nextReconcile) {
      this.nextReconcile = now + this.table.reconcileMs
      if (this.g.config.spawnMobs) this.reconcile(now)
    }
  }

  /** The weather now, as storm gameplay reads it. */
  readEnv(now: number): StormEnv {
    const w = this.g.weather
    const strength = Math.max(0, Math.min(2, this.g.config.stormStrength ?? this.table.strength))
    if (w.mode === 'off') return { ...CALM_ENV, strength }
    const p = w.params(now)
    const clock = this.g.clock.state
    const c = clockAt(clock, now)
    const sun = sunDirection(c.t, clock.declination)
    return { rain: p.rain, storm: stormLevel(p), windMs: p.windMs, wet: w.sync(now).wet, night: nightness(sun[1]), strength }
  }

  private updateStatus(now: number): void {
    const ev = this.event(now)
    const forecast = !!ev && now < ev.start
    const s: StormStatus = { phase: stormPhase(this.env, forecast, this.table), effects: this.env.strength > 0 ? stormEffects(this.env, this.table) : [] }
    if (ev && forecast) s.startsAt = ev.start
    if (ev) s.endsAt = ev.end
    const key = JSON.stringify(s)
    if (key === this.statusKey) return
    this.statusKey = key
    this.status = s
    this.g.world.broadcast({ t: 'storm', storm: s })
  }

  /** Charges end with the storm (or a monster that left); panics with their time. */
  private sweep(now: number): void {
    const storm = storming(this.env, this.table) && this.env.strength > 0
    for (const id of [...this.chargedArc.keys()]) {
      const m = this.g.world.mobs.get(id)
      if (!m || m.ai === 'dead') this.chargedArc.delete(id)
      else if (!storm) this.uncharge(id, true)
    }
    for (const [id, until] of this.panic) if (until <= now || !this.g.world.mobs.has(id)) this.panic.delete(id)
  }

  /** Mud: players running on a soaked ground outside towns are slowed (a stat mod; refresh when it changes). */
  private updateMud(now: number): void {
    const slow = mudSlowPct(this.env, this.table) > 0
    for (const p of this.g.world.players.values()) {
      let want = false
      if (slow && !p.dead) {
        const at = this.g.world.positionAt(p, now)
        want = !this.g.data.inSafeArea(this.g.config.world, at[0], at[2])
      }
      if (want === this.muddy.has(p.id)) continue
      if (want) this.muddy.add(p.id)
      else this.muddy.delete(p.id)
      this.g.refresh(p)
      p.send({ t: 'stats', stats: this.g.stats(p) })
    }
  }

  /** Pack hunting in a storm: a tiger or wolf on the chase calls the idle pack-mates of its nest nearby. */
  private packs(now: number): void {
    if (!storming(this.env, this.table) || this.env.strength <= 0) return
    const r2 = this.table.packCallM ** 2
    for (const m of this.g.world.mobs.values()) {
      if (m.ai !== 'chase' || m.target === null || this.exempt(m) || this.kindOf(m) !== 'predator' || !m.nest) continue
      const nest = this.g.spawner.nest(m.nest.id)
      if (!nest) continue
      const at = this.g.world.positionAt(m, now)
      for (const id of nest.alive) {
        if (id === m.id) continue
        const o = this.g.world.mobs.get(id)
        if (!o || o.ai !== 'idle' || this.panic.has(id)) continue
        const q = this.g.world.positionAt(o, now)
        if ((q[0] - at[0]) ** 2 + (q[2] - at[2]) ** 2 > r2) continue
        o.ai = 'chase'
        o.target = m.target
        o.nextThinkAt = 0
      }
    }
  }

  // ---- GM -------------------------------------------------------------------------------------------------------

  gm(args: string[], now = Date.now(), self: Player | null = null): GmResult {
    const a = (args[0] ?? '').toLowerCase()
    const f = stormFrequency(this.g.config)
    if (args.length === 0) return ok(this.describe(now), { status: this.status, env: this.env })
    if (a === 'preview') {
      const env: StormEnv = { rain: 1, storm: 1, windMs: 13, wet: 1, night: this.env.night, strength: this.env.strength }
      const list = stormEffects(env, this.table)
      const lines = list.map((e) => `${e.id}${e.pct !== undefined ? ` ${e.pct > 0 ? '+' : ''}${e.pct}%` : ''}`)
      return ok(`Storm preview (a full storm now, strength ${env.strength}): ${lines.join(', ') || 'no effects (strength 0)'}.`, { effects: list })
    }
    // docs/WEATHER.md §13: the lightning tornado (storm/tornado.ts)
    if (a === 'tornado') return this.g.tornado.gm(args.slice(1), now, self)
    if (this.g.weather.mode === 'off') return fail('Weather is off on this server (WEATHER=off): no storms.')
    if (a === 'start' || a === 'forecast') {
      const lenMin = args.length > 1 ? num(args[1]) : (f.minMin + f.maxMin) / 2
      const fcMin = a === 'forecast' ? (args.length > 2 ? num(args[2]) : f.forecastMin) : args.length > 2 ? num(args[2]) : 0
      if (lenMin === null || lenMin < 1 || lenMin > 240 || fcMin === null || fcMin < 0 || fcMin > 10 || args.length > 3) return fail(`Usage: ${STORM_USAGE}`)
      if (a === 'forecast' && args.length > 2) return fail(`Usage: ${STORM_USAGE}`)
      const e = this.plan.startGm(now, lenMin * 60_000, fcMin * 60_000, Math.floor(this.g.rng() * 0x100000000))
      this.lastEnvAt = -Infinity
      return ok(fcMin > 0 ? `Storm: forecast now, the storm breaks in ${fcMin} min and lasts ${lenMin} min.` : `Storm: breaking now (about a minute to full strength), lasts ${lenMin} min.`, e)
    }
    if (a === 'stop') {
      if (args.length !== 1) return fail(`Usage: ${STORM_USAGE}`)
      if (!this.plan.stop(now)) return fail('No storm or forecast is in progress (a `weather storm` hold ends with `weather auto`).')
      this.lastEnvAt = -Infinity
      const lifted = this.g.tornado.lift(now)
      return ok(`Storm: stopped; the weather goes back to its schedule${lifted ? '; the tornado lifts' : ''}.`)
    }
    if (a === 'charge') {
      const usage = fail('Usage: storm charge [mob entity id] (during a storm; alone: the monster nearest you within 30 m).')
      if (args.length > 2) return usage
      let m: Mob | undefined
      if (args.length === 2) {
        const id = num(args[1])
        m = id === null ? undefined : this.g.world.mobs.get(id)
      } else if (self) m = this.nearestMob(self, now, 30)
      if (!m || m.ai === 'dead') return usage
      if (!storming(this.env, this.table)) return fail('Only during a storm (a charge ends with the storm).')
      if (!this.charge(m, now)) return fail(`${m.name} cannot be charged (a unique or a steered boss).`)
      return ok(`Storm: ${m.name} (${m.id}) is charged.`)
    }
    return fail(`Usage: ${STORM_USAGE}`)
  }

  /** The living monster nearest `p` within `range` metres. */
  private nearestMob(p: Player, now: number, range: number): Mob | undefined {
    const at = this.g.world.positionAt(p, now)
    let best: Mob | undefined
    let bestD = range
    for (const m of this.g.world.mobs.values()) {
      if (m.ai === 'dead') continue
      const q = this.g.world.positionAt(m, now)
      const d = Math.hypot(q[0] - at[0], q[2] - at[2])
      if (d <= bestD) {
        best = m
        bestD = d
      }
    }
    return best
  }

  describe(now: number): string {
    const ev = this.event(now)
    const s = this.status
    const at = (t: number) => `${Math.max(0, Math.round((t - now) / 60_000))} min`
    const when = ev ? (now < ev.start ? `forecast, breaks in ${at(ev.start)}` : `storm, ends in ${at(ev.end)}`) : null
    const next = this.plan.next(now)
    const nextText = next ? `next storm in ${at(next.start)} (${Math.round((next.end - next.start) / 60_000)} min)` : this.g.weather.mode === 'auto' ? 'no storm scheduled soon' : `no scheduled storms (WEATHER=${this.g.weather.mode})`
    const e = this.env
    const effects = s.effects.map((x) => `${x.id}${x.pct !== undefined ? ` ${x.pct > 0 ? '+' : ''}${x.pct}%` : ''}`).join(', ') || 'none'
    return `Storm: ${s.phase}${when ? ` (${when})` : ''}; ${nextText}; rain ${e.rain.toFixed(2)}, storm ${e.storm.toFixed(2)}, wind ${e.windMs.toFixed(1)} m/s, wet ${e.wet.toFixed(2)}, night ${e.night.toFixed(2)}, strength ${e.strength}; effects: ${effects}; charged monsters ${this.chargedArc.size}; ${this.g.tornado.describe(now)}.`
  }
}
