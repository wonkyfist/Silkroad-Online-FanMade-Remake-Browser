import {
  HUNTER_CODES,
  PILE_REACH_M,
  STOCKADE,
  STOCKADE_INSET_M,
  WARDEN_SERVICE,
  choresLeft,
  clampToStockade,
  inStockade,
  jailLeftMs,
  type GameplayRequest,
  type JailView,
  type SiegeEventSettings,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { NavPoint } from '../nav.ts'
import type { GmResult } from '../gm.ts'
import { fail, type Fail } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from '../modules.ts'
import type { Player } from '../world.ts'
import { HunterStore, type JailRow } from './hunter-store.ts'

/**
 * Siege of Jangan, layer 6: the Garrison Stockade (docs/SIEGE.md §8.5). A GameplayModule named `jail`, after the
 * hunters. The terms are `jail_terms` rows (migration 19): one per prisoner while the sentence runs, so a relog or a
 * restart keeps it; the row goes at the release.
 *
 * - **Where**: STOCKADE (x −165…−135, z −318…−296, north of the west camp, inside the safe area). A prisoner enters the
 *   world in the cell (connection.ts asks `entryPoint`), every moveTo is clamped inside (connection.ts `clampMove`), and
 *   a prisoner found outside (a knock, a GM, a bug) is put back in the cell at once.
 * - **Can**: walk, sit, emote, chat, party, look at the bag and the gear (move, split, equip), food and potions, talk to
 *   Warden Bae, chores. **Cannot** (`jailed`): everything else (attack, skills, other items, return scrolls, mounts,
 *   trade, stalls, storage, shops, quests, kegs, Hunter duty, jumps).
 * - **Clock**: `law.sentenceClock` 'real' (the default: offline counts, `ends_at` is the release time) or 'online'
 *   (`served_ms` grows while in the world). Chores (`jailChore`, a `law.choreSec` channel at the rock pile, broken by
 *   moving) take `law.choreMin` each off, at most `law.choresCapPct` of the sentence.
 * - **Release** (served, a GM or the admin): the prisoner stands outside the gate with `law.pardonMin` of pardon (no
 *   Hunter target, no accomplice of older kegs); "You have served your sentence."
 */

/** Requests a prisoner may make (everything else answers `jailed`; itemUse: food and potions only). */
export const JAIL_ALLOWED: ReadonlySet<GameplayRequest> = new Set<GameplayRequest>([
  'stopAction', 'respawn', 'itemMove', 'itemSplit', 'itemEquip', 'itemUnequip', 'itemUse', 'hotbarSet', 'buffCancel',
  'npcTalk', 'npcClose', 'sit', 'emote',
  'partyInvite', 'partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings',
  'jailChore', 'winterBoard',
])
/** Online terms are written this often (ms). */
const SAVE_MS = 30_000
/** Moving this far breaks a chore (m). */
const CHORE_MOVE_M = 0.5

interface Term {
  row: JailRow
  /** The online clock's last reading (ms). */
  at: number
  savedAt: number
  chore: { endsAt: number; x: number; z: number } | null
}

export class JailService implements GameplayModule {
  readonly name = 'jail'
  readonly handles: readonly GameplayRequest[] = ['jailChore']
  /** Online prisoners (characterId). */
  private readonly live = new Map<number, Term>()
  /** characterId -> pardon end (ms): just released. */
  private readonly pardons = new Map<number, number>()
  private storeCache: HunterStore | null = null

  constructor(private readonly g: Gameplay) {
    g.world.decorators.push((e, s) => {
      if (e.kind === 'player' && this.live.has(e.characterId)) s.jailed = true
    })
    g.itemUses.hooks.push((p, def, _bag, _group, answer) => {
      if (!this.live.has(p.characterId)) return false
      const u = def.use
      const food = !!u && !!(u.hp || u.mp || u.hpPct || u.mpPct || def.category === 'pill' || def.cureLevel !== undefined) && !u.returnToTown && !u.summon && u.target !== 'mount' && !u.castMs
      if (food) return false
      answer(fail('jailed', 'Not in the Stockade: only food and potions.'))
      return true
    })
  }

  get store(): HunterStore {
    return (this.storeCache ??= new HunterStore(this.g.store.db))
  }

  get settings(): SiegeEventSettings['law'] {
    return this.g.siege.settings.law
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  /** Whether a character is serving a sentence (online: memory; offline: the table). */
  isJailed(characterId: number): boolean {
    if (this.live.has(characterId)) return true
    try {
      return this.store.term(characterId) !== null
    } catch {
      return false
    }
  }

  /** Online prisoner? (cheap; the PvP rule and the gates). */
  jailedNow(p: Player): boolean {
    return this.live.has(p.characterId)
  }

  pardoned(characterId: number, now: number): boolean {
    const until = this.pardons.get(characterId)
    if (until === undefined) return false
    if (now < until) return true
    this.pardons.delete(characterId)
    return false
  }

  private served(t: Term, now: number): number {
    return t.row.served_ms + Math.max(0, now - t.at)
  }

  /** The time left of a term (ms). */
  leftMs(row: JailRow, now: number, liveFrom?: number): number {
    const served = row.served_ms + (liveFrom !== undefined ? Math.max(0, now - liveFrom) : 0)
    return jailLeftMs({ startsAt: row.starts_at, endsAt: row.ends_at, servedMs: served, chores: row.chores }, now, this.settings.sentenceClock, this.settings)
  }

  /** The prisoner's own view (lawState.jail); null when free. */
  viewOf(p: Player, now: number): JailView | null {
    const t = this.live.get(p.characterId)
    if (!t) return null
    const r = t.row
    const v: JailView = {
      leftMs: Math.round(this.leftMs(r, now, t.at)),
      sentenceMs: Math.max(0, r.ends_at - r.starts_at),
      // the offence of the warrant that sent them here (a GM jail: the account's level now)
      offence: (r.warrant_id !== null ? this.g.law.store.warrant(r.warrant_id)?.offence : undefined) ?? this.g.law.offences(r.account_id, now),
      chores: r.chores,
      choresLeft: choresLeft({ startsAt: r.starts_at, endsAt: r.ends_at, servedMs: r.served_ms, chores: r.chores }, this.settings),
      clock: this.settings.sentenceClock,
    }
    if (t.chore) v.choreEndsAt = t.chore.endsAt
    return v
  }

  // ---- the stockade's ground -------------------------------------------------------------------------------------------

  private point(x: number, z: number, hintY: number): NavPoint {
    return this.g.world.placeFor(x, z, hintY) ?? { x, y: hintY, z, surface: null }
  }

  /** Warps `p` to (x, z) on the ground and tells the modules (a GM-style warp: casts and dialogs end). */
  private warpTo(p: Player, x: number, z: number, now: number): void {
    const [, y] = this.g.world.positionAt(p, now)
    const at = this.g.world.placeFor(x, z, y)
    p.action = null
    this.g.world.warp(p, at?.x ?? x, at?.y ?? y, at?.z ?? z, now, at)
    this.g.warped(p, 'gm', now)
  }

  /** connection.ts: where a prisoner enters the world (the cell; a served term: the gate); null = not a prisoner. */
  entryPoint(characterId: number, hintY = 0): NavPoint | null {
    let row: JailRow | null = null
    try {
      row = this.store.term(characterId)
    } catch {
      row = null
    }
    if (!row) return null
    const at = this.leftMs(row, this.g.now) > 0 ? STOCKADE.cell : STOCKADE.release
    return this.point(at.x, at.z, hintY)
  }

  /** connection.ts: a prisoner's moveTo target, clamped inside the fence (others unchanged). */
  clampMove(p: Player, x: number, z: number): [number, number] {
    return this.live.has(p.characterId) ? clampToStockade(x, z, STOCKADE_INSET_M) : [x, z]
  }

  private toCell(p: Player, now: number): void {
    this.g.mounts.stepDownFor(p, now)
    this.warpTo(p, STOCKADE.cell.x, STOCKADE.cell.z, now)
  }

  // ---- imprison / release ------------------------------------------------------------------------------------------

  /**
   * Jails `characterId` for `sentenceMs` (a capture, a GM or the admin). Online: into the cell now, the label, lawState.
   * A term already running is replaced by the longer of the two.
   */
  imprison(characterId: number, sentenceMs: number, warrantId: number | null, now: number, why: string): JailRow {
    const acc = this.g.law.accountOf(characterId) ?? 0
    const old = this.live.get(characterId)?.row ?? this.store.term(characterId)
    const ms = Math.max(60_000, Math.round(sentenceMs))
    const row: JailRow =
      old && this.leftMs(old, now) >= ms
        ? old
        : { character_id: characterId, account_id: acc, warrant_id: warrantId, starts_at: now, ends_at: now + ms, served_ms: 0, chores: 0 }
    this.store.putTerm(row)
    this.pardons.delete(characterId)
    const p = this.playerOf(characterId)
    if (p) {
      const t: Term = { row, at: now, savedAt: now, chore: null }
      this.live.set(characterId, t)
      this.g.hunters.dutyOff(p, now, true)
      this.toCell(p, now)
      this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, jailed: true })
      this.g.law.sendState(p, now)
      p.send({ t: 'chat', channel: 'system', text: `You are locked in the Garrison Stockade for ${fmtTime(ms)}${why ? ` (${why})` : ''}. Warden Bae has the details; breaking rocks at the pile shortens it.` })
    }
    this.g.config.log(`jail: ${this.nameOf(characterId)} jailed for ${fmtTime(ms)}${why ? ` (${why})` : ''}`)
    return row
  }

  /** Ends a term (served, a GM, the admin). Online: out of the gate with a pardon. false: not jailed. */
  release(characterId: number, now: number, why: 'served' | 'gm' | 'admin'): boolean {
    const t = this.live.get(characterId)
    const had = this.store.dropTerm(characterId) || t !== undefined
    if (!had) return false
    this.live.delete(characterId)
    this.pardons.set(characterId, now + this.settings.pardonMin * 60_000)
    const p = this.playerOf(characterId)
    if (p) {
      this.warpTo(p, STOCKADE.release.x, STOCKADE.release.z, now)
      this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, jailed: false })
      this.g.law.sendState(p, now)
      p.send({ t: 'chat', channel: 'system', text: why === 'served' ? 'You have served your sentence. Warden Bae opens the gate: you are free to go.' : 'Warden Bae opens the gate: you are released.' })
    }
    this.g.config.log(`jail: ${this.nameOf(characterId)} released (${why})`)
    return true
  }

  private playerOf(characterId: number): Player | null {
    for (const p of this.g.world.players.values()) if (p.characterId === characterId) return p
    return null
  }

  private nameOf(characterId: number): string {
    return this.g.store.characterById(characterId)?.name ?? `#${characterId}`
  }

  // ---- the gate (what a prisoner may do) -------------------------------------------------------------------------------

  gate(p: Player, t: GameplayRequest | 'moveTo'): Fail | null {
    if (!this.live.has(p.characterId) || t === 'moveTo' || JAIL_ALLOWED.has(t)) return null
    return fail('jailed', 'Not while you are locked in the Garrison Stockade.')
  }

  /** Warden Bae's dialog service is his alone, while the walls are on. */
  offers(code: string): boolean {
    return this.g.kegs.on && code === HUNTER_CODES.warden
  }

  // ---- chores ------------------------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t !== 'jailChore') return answer(fail('not_found'))
    const t = this.live.get(p.characterId)
    if (!t) return answer(fail('not_usable', 'Only prisoners break rocks in the Stockade.'))
    if (t.chore) return answer(fail('busy'))
    const [x, , z] = this.g.world.positionAt(p, now)
    if (Math.hypot(x - STOCKADE.pile.x, z - STOCKADE.pile.z) > PILE_REACH_M) return answer(fail('too_far', 'Go to the rock pile in the corner of the Stockade.'))
    const r = t.row
    if (choresLeft({ startsAt: r.starts_at, endsAt: r.ends_at, servedMs: r.served_ms, chores: r.chores }, this.settings) <= 0) {
      return answer(fail('not_usable', 'Warden Bae: "That is enough rocks for one sentence. Sit and wait."'))
    }
    answer(true)
    this.g.world.halt(p, now)
    t.chore = { endsAt: now + this.settings.choreSec * 1000, x, z }
    this.g.law.sendState(p, now)
  }

  private choreStep(p: Player, t: Term, now: number): void {
    const c = t.chore
    if (!c) return
    const [x, , z] = this.g.world.positionAt(p, now)
    if (p.move || Math.hypot(x - c.x, z - c.z) > CHORE_MOVE_M || p.dead) {
      t.chore = null
      this.g.law.sendState(p, now)
      return
    }
    if (now < c.endsAt) return
    t.chore = null
    t.row.chores++
    this.save(t, now)
    this.g.law.sendState(p, now)
    p.send({ t: 'chat', channel: 'system', text: `You break a rock: ${this.settings.choreMin} min off your sentence.` })
  }

  // ---- hooks ---------------------------------------------------------------------------------------------------------------

  private save(t: Term, now: number): void {
    t.row.served_ms = this.served(t, now)
    t.at = now
    t.savedAt = now
    this.store.saveTerm(t.row.character_id, t.row.served_ms, t.row.chores, t.row.ends_at)
  }

  enter(p: Player, now: number): void {
    let row: JailRow | null = null
    try {
      row = this.store.term(p.characterId)
    } catch {
      row = null
    }
    if (!row) {
      this.live.delete(p.characterId)
      return
    }
    this.live.set(p.characterId, { row, at: now, savedAt: now, chore: null })
    if (this.leftMs(row, now) <= 0) {
      this.release(p.characterId, now, 'served')
      return
    }
    const [x, , z] = this.g.world.positionAt(p, now)
    if (!inStockade(x, z)) this.toCell(p, now)
    // the enter-world snapshot was built before this hook: the label to the player and whoever sees them already
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, jailed: true })
    this.g.law.sendState(p, now)
  }

  forget(p: Player): void {
    const t = this.live.get(p.characterId)
    if (!t) return
    this.save(t, this.g.now)
    this.live.delete(p.characterId)
  }

  moved(p: Player, now: number): void {
    const t = this.live.get(p.characterId)
    if (t?.chore) {
      t.chore = null
      this.g.law.sendState(p, now)
    }
  }

  warped(_p: Player, _reason: WarpReason): void {}

  tick(now: number): void {
    for (const t of [...this.live.values()]) {
      const p = this.playerOf(t.row.character_id)
      if (!p) {
        this.live.delete(t.row.character_id)
        continue
      }
      if (this.leftMs(t.row, now, t.at) <= 0) {
        this.release(t.row.character_id, now, 'served')
        continue
      }
      this.choreStep(p, t, now)
      // escape: anywhere outside the fence goes back to the cell
      const [x, , z] = this.g.world.positionAt(p, now)
      if (!inStockade(x, z, -0.5) && !p.dead) {
        this.g.config.log(`jail: ${p.name} was outside the Stockade at ${x.toFixed(1)},${z.toFixed(1)}: back to the cell`)
        this.toCell(p, now)
      }
      if (now - t.savedAt >= SAVE_MS) this.save(t, now)
    }
  }

  // ---- GM and admin --------------------------------------------------------------------------------------------------------

  /** Every term (online ones with their live clock), for GM status and the admin. */
  list(now: number): { characterId: number; name: string; accountId: number; startsAt: number; endsAt: number; leftMs: number; chores: number; online: boolean; warrant: number | null }[] {
    return this.store.terms().map((r) => {
      const t = this.live.get(r.character_id)
      const row = t?.row ?? r
      return {
        characterId: r.character_id,
        name: this.nameOf(r.character_id),
        accountId: r.account_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        leftMs: Math.round(this.leftMs(row, now, t?.at)),
        chores: row.chores,
        online: !!t,
        warrant: r.warrant_id,
      }
    })
  }

  /** Adds (or with a negative value takes) time to a running term. */
  addTime(characterId: number, ms: number, now: number): boolean {
    const t = this.live.get(characterId)
    const row = t?.row ?? this.store.term(characterId)
    if (!row) return false
    row.ends_at = Math.max(row.starts_at + 60_000, row.ends_at + Math.round(ms))
    if (t) this.save(t, now)
    else this.store.saveTerm(characterId, row.served_ms, row.chores, row.ends_at)
    const p = this.playerOf(characterId)
    if (p) this.g.law.sendState(p, now)
    return true
  }

  gmJail(name: string, minutes: number, reason: string, now: number, who: string): GmResult {
    const row = this.g.store.characterByName(name.replace(/^@/, ''))
    if (!row) return { ok: false, message: `No character named ${name}.` }
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60 * 7) return { ok: false, message: 'Usage: law jail <name> <minutes 1-10080> [reason]' }
    this.imprison(row.id, minutes * 60_000, null, now, reason || `by ${who}`)
    return { ok: true, message: `${row.name} is jailed for ${fmtTime(minutes * 60_000)}${reason ? ` (${reason})` : ''}.` }
  }

  gmRelease(name: string, now: number): GmResult {
    const row = this.g.store.characterByName(name.replace(/^@/, ''))
    if (!row) return { ok: false, message: `No character named ${name}.` }
    return this.release(row.id, now, 'gm') ? { ok: true, message: `${row.name} is released.` } : { ok: false, message: `${row.name} is not jailed.` }
  }
}

export function fmtTime(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`
}
