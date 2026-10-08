/**
 * The Climb's death penalty (docs/CLIMB.md §6, layer L4 of §20; D46, D51; fact-check F5 and F6). Rule #13.
 *
 * - **Who and what** (§6.1): a player from `penaltyFromLevel` (15) below the level cap killed by a monster or boss loses a
 *   random whole `penaltyMinPct..penaltyMaxPct` % (1–20) of the level's bar, never more than the bar holds (never a
 *   de-level; an empty bar loses nothing). Never: PvP (a player killer: the Hunters and the Wanted), the siege army
 *   (`Mob.siege`) and Play the Boss (the piloted boss, `Mob.pilot`, and her summons), damage without an attacker
 *   (lightning, the tornado) and GM kills (`gmKill` passes no killer). `penaltyEligible` is that one predicate (§6.5).
 * - **Grace** (§6.1, D51): a death within `penaltyGraceMin` (10) minutes of a death that took EXP costs nothing; from
 *   `penaltyGraceHighFrom` (21) the window is `penaltyGraceHighMin` (30). A free death never restarts the window; an empty
 *   bar does not start one. Runtime only, per character id (a relog keeps it; a restart clears it: §10.1 "the penalty
 *   state is runtime only", so no migration).
 * - **Refunds** (§6.3, F5): a resurrection on the corpse (Soul Rebirth, skills/engine.ts) pays back `rezRefund` (50 %) of
 *   the loss; every refund of one death (`refund`, for NEMESIS later) is capped at what is left of the loss, and emits
 *   `onRefunded`. Returning to town or leaving the world forfeits the resurrection refund.
 * - **Combat linger** (F6): connection.ts asks `linger` when a player leaves the world; at penalty levels, alive and hit by
 *   a monster within `penaltyLingerS` (10) s, the body stays that long (no socket: messages are dropped), still a
 *   target; dying then is a death like any other and the body leaves right after. A relog meanwhile is refused.
 * - **Messages**: a system chat line and `deathPenalty` (the death box shows the loss and the grace left).
 *
 * The Incense (§6.2), the Rebirth Art's 100 % (§5.1) and the party line are not built (L7 / L8).
 */
import { CLIMB_PENALTY, climbGraceMs, climbPenaltyLoss, climbPenaltyPct, climbRefundCap, type DeathPenaltyOutcome } from '@sro/shared'
import type { ServerConfig } from '../config.ts'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import type { GameplayModule, WarpReason } from '../modules.ts'
import type { Mob, Player } from '../world.ts'

export const PENALTY_USAGE = 'penalty [player] | penalty test <pct> | penalty grace <minutes> [player] | penalty clear [player]'

/** The live rule (config over CLIMB_PENALTY). */
export interface PenaltyRule {
  on: boolean
  fromLevel: number
  minPct: number
  maxPct: number
  graceMin: number
  graceHighFrom: number
  graceHighMin: number
  lingerMs: number
}

export function penaltyRule(c: ServerConfig): PenaltyRule {
  return {
    on: c.climb === true && c.deathPenalty !== false,
    fromLevel: c.penaltyFromLevel ?? CLIMB_PENALTY.fromLevel,
    minPct: c.penaltyMinPct ?? CLIMB_PENALTY.minPct,
    maxPct: c.penaltyMaxPct ?? CLIMB_PENALTY.maxPct,
    graceMin: c.penaltyGraceMin ?? CLIMB_PENALTY.graceMin,
    graceHighFrom: c.penaltyGraceHighFrom ?? CLIMB_PENALTY.graceHighFrom,
    graceHighMin: c.penaltyGraceHighMin ?? CLIMB_PENALTY.graceHighMin,
    lingerMs: Math.max(0, (c.penaltyLingerS ?? CLIMB_PENALTY.lingerS) * 1000),
  }
}

/** §6.5 `penaltyEligible`: a monster or boss killed the player (not a player, a hazard, a GM, the siege or Play the Boss). */
export function penaltyEligible(killer: Player | Mob | undefined, summonerOf: (id: number) => Mob | undefined): killer is Mob {
  if (!killer || killer.kind !== 'mob') return false
  if (killer.siege || killer.pilot) return false
  const boss = summonerOf(killer.id)
  return !(boss && (boss.siege || boss.pilot))
}

export interface PenaltyResult {
  outcome: DeathPenaltyOutcome
  pct: number
  loss: number
}

interface CharState {
  /** Grace ends (server ms); 0 = none. */
  graceUntil: number
  /** The last penalised death: what it took and what was paid back (F5). */
  loss: number
  refunded: number
  /** A resurrection may still refund (dead since that death). */
  rezOpen: boolean
}

interface Linger {
  p: Player
  until: number
  finish: () => void
}

export class DeathPenalty implements GameplayModule {
  readonly name = 'penalty'
  private readonly chars = new Map<number, CharState>()
  /** Lingering bodies by character id. */
  private readonly lingering = new Map<number, Linger>()
  /** §6.5 hooks for the siblings (NEMESIS, TOMB_DUNGEON). */
  readonly onTaken: ((p: Player, loss: number, killer: Mob) => void)[] = []
  readonly onRefunded: ((p: Player, amount: number) => void)[] = []

  constructor(readonly g: Gameplay) {}

  get rule(): PenaltyRule {
    return penaltyRule(this.g.config)
  }

  private state(characterId: number): CharState {
    let s = this.chars.get(characterId)
    if (!s) this.chars.set(characterId, (s = { graceUntil: 0, loss: 0, refunded: 0, rezOpen: false }))
    return s
  }

  /** Whether `p`'s level is one the penalty applies to (from fromLevel, below the cap). */
  applies(p: Player): boolean {
    const r = this.rule
    return r.on && p.progress.level >= r.fromLevel && p.progress.level < this.g.config.levelCap
  }

  /** Grace left of a character (ms, 0 = none). */
  graceLeft(characterId: number, now: number): number {
    return Math.max(0, (this.chars.get(characterId)?.graceUntil ?? 0) - now)
  }

  // ---- the death ---------------------------------------------------------------------------------------------

  playerDied(p: Player, now: number, killer?: Player | Mob): void {
    const lin = this.lingering.get(p.characterId)
    if (lin && lin.p === p) lin.until = now
    if (!this.applies(p) || !penaltyEligible(killer, (id) => this.summonerOf(id))) return
    this.apply(p, now, killer)
  }

  /** The penalty of one death of `p` (§6.5 `penalty.apply`); `forcePct` = the GM test roll. */
  apply(p: Player, now: number, killer?: Mob, forcePct?: number): PenaltyResult {
    const r = this.rule
    const s = this.state(p.characterId)
    if (forcePct === undefined && now < s.graceUntil) {
      s.rezOpen = false
      this.tell(p, { outcome: 'grace', pct: 0, loss: 0 }, s.graceUntil - now)
      return { outcome: 'grace', pct: 0, loss: 0 }
    }
    const need = this.g.data.expToNext(p.progress.level, this.g.config.levelCap)
    const pct = forcePct ?? climbPenaltyPct(this.g.rng(), r.minPct, r.maxPct)
    const loss = climbPenaltyLoss(p.progress.exp, need, pct)
    if (loss <= 0) {
      s.rezOpen = false
      this.tell(p, { outcome: 'empty', pct, loss: 0 }, Math.max(0, s.graceUntil - now))
      return { outcome: 'empty', pct, loss: 0 }
    }
    this.setExp(p, p.progress.exp - loss)
    s.loss = loss
    s.refunded = 0
    s.rezOpen = p.dead
    s.graceUntil = now + climbGraceMs(p.progress.level, r)
    const res: PenaltyResult = { outcome: 'lost', pct, loss }
    this.tell(p, res, s.graceUntil - now)
    this.g.config.log(`${p.name} lost ${loss} EXP (${pct} %) to ${killer ? (killer.def.code) : 'a GM test'}`)
    if (killer) for (const fn of this.onTaken) fn(p, loss, killer)
    return res
  }

  /**
   * F5: pays back up to `want` EXP of `p`'s last loss, never past it in total. Returns what was paid. Never levels up
   * (the EXP returns to the bar it was taken from; a level gained since leaves nothing to refund).
   */
  refund(p: Player, want: number): number {
    const s = this.chars.get(p.characterId)
    if (!s) return 0
    const need = this.g.data.expToNext(p.progress.level, this.g.config.levelCap)
    const pay = Math.min(climbRefundCap(s.loss, s.refunded, want), Math.max(0, need - 1 - p.progress.exp))
    if (pay <= 0) return 0
    s.refunded += pay
    this.setExp(p, p.progress.exp + pay)
    p.send({ t: 'deathPenalty', outcome: 'refund', exp: pay, pct: 0, graceMs: this.graceLeft(p.characterId, this.g.now) })
    p.send({ t: 'chat', channel: 'system', text: `${fmt(pay)} of your lost experience was restored.` })
    for (const fn of this.onRefunded) fn(p, pay)
    return pay
  }

  /** §6.3: a resurrection on the corpse (skills/engine.ts) refunds `rezRefund` of the death's loss; `all` (the Rebirth Art, §5.1) all of it. */
  resurrected(p: Player, all = false): void {
    const s = this.chars.get(p.characterId)
    if (!s?.rezOpen) return
    s.rezOpen = false
    this.refund(p, all ? s.loss : s.loss * CLIMB_PENALTY.rezRefund)
  }

  warped(p: Player, reason: WarpReason): void {
    if (reason === 'town') {
      const s = this.chars.get(p.characterId)
      if (s) s.rezOpen = false
    }
  }

  // ---- the combat linger (F6) --------------------------------------------------------------------------------

  /**
   * connection.ts, on leaving the world: true = `p` stays `lingerMs` (alive, at penalty levels, hit by a monster within
   * lingerMs) and `finish` runs when it ends (at once after a death); false = the caller removes it now.
   */
  linger(p: Player, now: number, finish: () => void): boolean {
    const ms = this.rule.lingerMs
    if (ms <= 0 || p.dead || !this.applies(p) || p.lastMobHitAt === undefined || now - p.lastMobHitAt > ms) return false
    if (this.lingering.has(p.characterId)) return false
    p.send = () => {}
    p.action = null
    this.lingering.set(p.characterId, { p, until: now + ms, finish })
    this.g.config.log(`${p.name} left in combat: stays ${Math.round(ms / 1000)} s`)
    return true
  }

  /** Seconds a character still lingers (enterWorld refuses meanwhile), 0 = not lingering. */
  lingerLeft(characterId: number, now: number): number {
    const l = this.lingering.get(characterId)
    return l ? Math.max(1, Math.ceil((l.until - now) / 1000)) : 0
  }

  tick(now: number): void {
    if (this.lingering.size === 0) return
    for (const [id, l] of [...this.lingering]) {
      if (now < l.until) continue
      this.lingering.delete(id)
      try {
        l.finish()
      } catch (e) {
        this.g.config.log(`penalty: linger finish of ${l.p.name} failed: ${(e as Error)?.stack ?? e}`)
      }
    }
  }

  /** Server shutdown: every lingering body leaves now (saved like any other). */
  flush(): void {
    this.tick(Number.POSITIVE_INFINITY)
  }

  forget(p: Player): void {
    const s = this.chars.get(p.characterId)
    if (s) s.rezOpen = false
  }

  // ---- GM ----------------------------------------------------------------------------------------------------

  gm(self: Player, args: string[], find: (name: string) => Player | undefined): GmResult {
    const now = this.g.now
    const [verb, a, b] = args
    const who = (name: string | undefined): Player | undefined => (name === undefined ? self : find(name))
    const line = (p: Player): string => {
      const r = this.rule
      const s = this.chars.get(p.characterId)
      const g = this.graceLeft(p.characterId, now)
      const need = this.g.data.expToNext(p.progress.level, this.g.config.levelCap)
      return `${p.name}: level ${p.progress.level}, ${fmt(p.progress.exp)} / ${fmt(need)} EXP; penalty ${this.applies(p) ? 'applies' : 'does not apply'} (${r.on ? `on, from ${r.fromLevel}, ${r.minPct}-${r.maxPct} %, grace ${r.graceMin} min / ${r.graceHighMin} min from ${r.graceHighFrom}, linger ${r.lingerMs / 1000} s` : 'off'}); grace ${g ? mmss(g) : 'none'}; last loss ${fmt(s?.loss ?? 0)} (refunded ${fmt(s?.refunded ?? 0)}).`
    }
    if (verb === undefined || (args.length === 1 && !['test', 'grace', 'clear'].includes(verb))) {
      const p = who(verb)
      if (!p) return { ok: false, message: `No player ${verb} in the world.` }
      return { ok: true, message: line(p), data: { grace: this.graceLeft(p.characterId, now), loss: this.chars.get(p.characterId)?.loss ?? 0 } }
    }
    if (verb === 'test' && args.length === 2) {
      const pct = Number(a)
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) return { ok: false, message: `Usage: ${PENALTY_USAGE}` }
      const r = this.apply(self, now, undefined, pct)
      return { ok: true, message: `Penalty test ${pct} %: ${r.outcome}, ${fmt(r.loss)} EXP taken. ${line(self)}`, data: r }
    }
    if (verb === 'grace' && (args.length === 2 || args.length === 3)) {
      const min = Number(a)
      const p = who(b)
      if (!Number.isFinite(min) || min < 0 || min > 1440) return { ok: false, message: `Usage: ${PENALTY_USAGE}` }
      if (!p) return { ok: false, message: `No player ${b} in the world.` }
      this.state(p.characterId).graceUntil = min > 0 ? now + min * 60_000 : 0
      return { ok: true, message: line(p) }
    }
    if (verb === 'clear' && args.length <= 2) {
      const p = who(a)
      if (!p) return { ok: false, message: `No player ${a} in the world.` }
      this.chars.delete(p.characterId)
      return { ok: true, message: line(p) }
    }
    return { ok: false, message: `Usage: ${PENALTY_USAGE}` }
  }

  // ---- helpers -----------------------------------------------------------------------------------------------

  private summonerOf(id: number): Mob | undefined {
    const s = this.g.mobSkills.summonerOf(id)
    return s === null ? undefined : this.g.world.mobs.get(s)
  }

  private setExp(p: Player, exp: number): void {
    const next = { ...p.progress, exp: Math.max(0, Math.floor(exp)) }
    this.g.store.saveProgress(p.characterId, next)
    p.progress = next
    p.send({ t: 'statsDelta', stats: { exp: next.exp } })
  }

  private tell(p: Player, r: PenaltyResult, graceMs: number): void {
    p.send({ t: 'deathPenalty', outcome: r.outcome, exp: r.loss, pct: r.pct, graceMs: Math.max(0, Math.round(graceMs)) })
    const text =
      r.outcome === 'lost'
        ? `You have died. You lost ${r.pct} % of your experience (${fmt(r.loss)} EXP).`
        : r.outcome === 'grace'
          ? `Your ancestors spare you this time (no experience lost; ${mmss(graceMs)} of grace left).`
          : 'You have died. Your experience bar was empty: nothing was lost.'
    p.send({ t: 'chat', channel: 'system', text })
  }
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
