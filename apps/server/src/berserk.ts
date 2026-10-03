import { BERSERK_MAX_MS, HWAN_MAX, type GameplayRequest, type MobVariant } from '@sro/shared'
import { knob } from './config.ts'
import type { Gameplay } from './gameplay.ts'
import type { GmResult } from './gm.ts'
import { fail } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from './modules.ts'
import type { StatMod } from './skills/mods.ts'
import type { Mob, Player } from './world.ts'

/**
 * Berserk (Hwan; docs/SYSTEMS_COMBAT.md §5.2, docs/WAVE_PLAN2.md D26/D33/D34/D49; lane BZ).
 *
 * - Points 0..HWAN_MAX, saved in `characters.hwan_points` (migration 8). Gained on kills (`mobDied` credit): a normal
 *   mob gives 1 with HWAN_KILL_PCT (12 %), a champion 1, a giant/titan/elite/party mob 2, a unique fills the gauge.
 *   Nothing is gained while dead or berserk. The owner gets `statsDelta {hwan}`.
 * - `berserk {}` at a full gauge: `actionResult ok` → `entityUpdate {id, berserkMs}` to the viewers (self included) →
 *   `statsDelta {hwan: 0}` → `stats`. Refused `berserk_not_ready` below HWAN_MAX, `berserk_active` while on; `dead`
 *   comes from Gameplay.request and `mounted` from the mounts gate (D43). A running skill action is not interrupted.
 * - While berserk (HWAN_DURATION_MS, 60 s): physical and magical damage +100 % and move speed +100 %, through the
 *   SkillEngine mod-provider seam. EntityState.berserkMs carries the time left to late viewers (a world decorator).
 * - The end, at the timer, on death, on a warp to town or on logout: mods off, `refresh` → `stats`, then
 *   `entityUpdate {berserkMs: 0}`. The runtime state is never saved (a relog is not berserk; the points were already
 *   spent at activation).
 *
 * D34: Gameplay.sendEnter sends `stats` before the modules' `enter`, so `points` reads through a per-character cache
 * filled from the store (Store.hwanPoints) on first use, never from `enter`; the first `stats` after a relog is right.
 */

export const HWAN_USAGE = 'hwan <0..5> | hwan stop'

/** Berserk mods (docs/SYSTEMS_COMBAT.md §5.2): damage ×2 (`× (1 + pct/100)` in the damage roll) and speed ×2. */
export const BERSERK_MODS: readonly StatMod[] = [
  { stat: 'physDamagePct', value: 100 },
  { stat: 'magDamagePct', value: 100 },
  { stat: 'speedPct', value: 100 },
]

/**
 * Points a kill is worth per mob variant (docs/SYSTEMS_COMBAT.md §5.2 [decision; retail unknown]). `normal` is the
 * one point that HWAN_KILL_PCT rolls for; a titan counts like a giant.
 */
export const HWAN_KILL_POINTS: Readonly<Record<MobVariant, number>> = {
  normal: 1,
  champion: 1,
  giant: 2,
  titan: 2,
  elite: 2,
  party: 2,
  unique: HWAN_MAX,
}

export class Berserk implements GameplayModule {
  readonly name = 'berserk'
  readonly handles: readonly GameplayRequest[] = ['berserk']
  /** characterId -> saved Berserk points (D34). */
  private readonly cache = new Map<number, number>()
  /** Berserk players: entity id -> server ms the Berserk ends. */
  private readonly until = new Map<number, number>()

  constructor(readonly g: Gameplay) {
    g.skills.addModProvider((p) => (this.until.has(p.id) ? [...BERSERK_MODS] : []))
    // Late viewers (enter-view, worldEnter) read the time left (docs/WAVE_PLAN.md decision 37 decorators).
    g.world.decorators.push((e, s) => {
      if (e.kind !== 'player') return
      const end = this.until.get(e.id)
      if (end !== undefined) s.berserkMs = clampMs(end - this.g.now)
    })
  }

  // ---- queries -----------------------------------------------------------------------------------------

  /** Berserk points 0..HWAN_MAX of `p` (PlayerStats.hwan). */
  points(p: Player): number {
    let n = this.cache.get(p.characterId)
    if (n === undefined) this.cache.set(p.characterId, (n = clampPoints(this.g.store.hwanPoints(p.characterId))))
    return n
  }

  /** Whether `p` is berserk now (D49: summoning or riding is refused `berserk_active`). */
  active(p: Player): boolean {
    return this.until.has(p.id)
  }

  /** Berserk time left of `p` in ms (0 = not berserk). */
  remainingMs(p: Player, now: number): number {
    const end = this.until.get(p.id)
    return end === undefined ? 0 : Math.max(0, end - now)
  }

  // ---- request -----------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t !== 'berserk') return answer(fail('not_found'))
    if (p.dead) return answer(fail('dead'))
    if (this.until.has(p.id)) return answer(fail('berserk_active', 'Berserk is already active.'))
    if (this.points(p) < HWAN_MAX) return answer(fail('berserk_not_ready', 'Your Berserk gauge is not full.'))
    if (!this.setPoints(p, 0)) return answer(fail('not_found', 'Could not save the Berserk points.'))
    answer(true)
    const ms = clampMs(knob(this.g.config, 'hwanDurationMs'))
    this.until.set(p.id, now + ms)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, berserkMs: ms })
    p.send({ t: 'statsDelta', stats: { hwan: 0 } })
    this.restat(p)
  }

  // ---- hooks -------------------------------------------------------------------------------------------

  /** Points for every credited player that is alive, not berserk and below a full gauge (party members roll each). */
  mobDied(m: Mob, _now: number, credit: ReadonlySet<number>): void {
    // H11-NL-2: a quest encounter (the Binding Bell's private Tiger Girl, re-summonable every cooldown) is worth an elite's
    // points, not a unique's full gauge: the full gauge stays the field unique's (docs/UNIQUES.md §3.2).
    const worth = m.encounter && m.variant === 'unique' ? HWAN_KILL_POINTS.elite : (HWAN_KILL_POINTS[m.variant] ?? 0)
    if (worth <= 0) return
    for (const id of credit) {
      const p = this.g.world.players.get(id)
      if (!p || p.dead || this.until.has(p.id)) continue
      const had = this.points(p)
      if (had >= HWAN_MAX) continue
      if (m.variant === 'normal' && this.g.rng() * 100 >= knob(this.g.config, 'hwanKillPct')) continue
      const next = Math.min(HWAN_MAX, had + worth)
      if (this.setPoints(p, next)) p.send({ t: 'statsDelta', stats: { hwan: next } })
    }
  }

  tick(now: number): void {
    for (const [id, end] of [...this.until]) {
      if (end > now) continue
      const p = this.g.world.players.get(id)
      if (p) this.end(p)
      else this.until.delete(id)
    }
  }

  playerDied(p: Player): void {
    this.end(p)
  }

  warped(p: Player, reason: WarpReason): void {
    if (reason === 'town') this.end(p)
  }

  forget(p: Player): void {
    this.until.delete(p.id)
    this.cache.delete(p.characterId)
  }

  // ---- GM ----------------------------------------------------------------------------------------------

  /** GM `hwan <0..5>` sets the own points (saved); `hwan stop` ends an active Berserk. */
  gm(self: Player, args: string[]): GmResult {
    const a = (args[0] ?? '').toLowerCase()
    if (a === 'stop' || a === 'off' || a === 'end') {
      if (!this.until.has(self.id)) return { ok: false, message: 'You are not berserk.' }
      this.end(self)
      return { ok: true, message: 'Berserk ended.' }
    }
    if (!/^\d$/.test(a) || Number(a) > HWAN_MAX) return { ok: false, message: `Usage: /${HWAN_USAGE}` }
    const n = Number(a)
    if (!this.setPoints(self, n)) return { ok: false, message: 'Could not save the Berserk points.' }
    self.send({ t: 'statsDelta', stats: { hwan: n } })
    return { ok: true, message: `Berserk points: ${n} / ${HWAN_MAX}.`, data: { hwan: n } }
  }

  // ---- internals ---------------------------------------------------------------------------------------

  /** Ends the Berserk of `p` if it is on: mods off, `refresh` → `stats`, then `entityUpdate {berserkMs: 0}`. */
  end(p: Player): void {
    if (!this.until.delete(p.id)) return
    this.restat(p)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, berserkMs: 0 })
  }

  /** Saves and caches the points of `p`; false when the store refused (the cache keeps the old value). */
  private setPoints(p: Player, n: number): boolean {
    const v = clampPoints(n)
    if (!this.g.store.setHwanPoints(p.characterId, v)) return false
    this.cache.set(p.characterId, v)
    return true
  }

  /** The Berserk mods changed: recompute the derived stats (speed included) and send the full `stats`. */
  private restat(p: Player): void {
    const changed = this.g.refresh(p)
    p.send({ t: 'stats', stats: this.g.stats(p) })
    if (changed) this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, hp: Math.round(p.hp), maxHp: p.maxHp })
  }
}

function clampPoints(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(HWAN_MAX, Math.floor(n))) : 0
}

/** A wire-valid berserkMs (1..BERSERK_MAX_MS). */
function clampMs(ms: number): number {
  return Math.max(1, Math.min(BERSERK_MAX_MS, Math.ceil(ms)))
}
