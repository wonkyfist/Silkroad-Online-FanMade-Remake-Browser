import {
  addOffence,
  offenceLevel,
  robberySentenceMs,
  sentenceMs,
  wallName,
  wantedBounty,
  wantedOnlineMs,
  type CaptureRule,
  type ServerMessage,
  type SiegeEventSettings,
  type WantedView,
  type WarrantReason,
  type WarrantRole,
  type WarrantStatus,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, fail, type Fail } from '../inventory.ts'
import type { GameplayModule } from '../modules.ts'
import type { Player } from '../world.ts'
import type { Planter } from './keg.ts'
import { LawStore, type WarrantRow } from './law-store.ts'

/**
 * Siege of Jangan, layer 5: Wanted (docs/SIEGE.md §8.1, §8.5, §8.6). A GameplayModule named `law`, after the siege and
 * the kegs. The server alone issues warrants, from blasts it computed (no false reports).
 *
 * - **A keg blast** (keg.ts → `kegBlast`): every hit is remembered for `accompliceWindowMin` (10 min; after a restart
 *   read back from wall_log). A blast that opens the segment makes its planter the **wall-breaker**; every other
 *   character whose keg hit that segment within the window is an **accomplice**. Each account involved gets one offence
 *   (law_records, per ACCOUNT so alts share it; one level forgiven per `forgiveDays` clean days); each character a
 *   warrant (warrants, migration 19): bounty = bountyBase × min(offence, bountyCapMul), half for an accomplice, ×
 *   treasonMul when a siege runs (treason).
 * - **Everyone is told**: `lawNotice wanted` (the breaker named, the bounty, the accomplices) and a chat line; the Wanted
 *   carry `EntityState.wanted` (the bounty: the red WANTED label everyone sees) and get `lawState` (bounty, the online
 *   time left).
 * - **The warrant lapses** after `wantedOnlineHours` (2 h) of the Wanted's ONLINE time (the clock runs only while they
 *   are in the world, saved every 30 s and at logout, so a restart or logging off cannot outwait it): no jail, no
 *   bounty, but the offence still counts (`lawNotice lapsed`).
 * - **Siege rewards**: the breakers and accomplices of a siege's treason, and their associates (party, guild, the same
 *   account, the same IP), get nothing from that siege (`barredFromSiege`).
 * - **Layer 6 hooks**: `wantedOf` / `isWanted` (the wanted state, readable), `capture` (closes the warrants, pays the
 *   bounty from the server to the captors, returns the sentence for the jail), `kegRefusal` (the jail and Hunter duty
 *   will refuse kegs there), `onWanted` (listeners for pings and the minimap).
 * - GM `law` (LAW_USAGE).
 */

const DAY_MS = 86_400_000

export const LAW_USAGE =
  'law [status] | law record <name> | law wanted <name> [off] | law lapse <name> [minutes] | law pardon <name> | law forgive <name> [all] | law capture <name> [captor] | law cooldown <name> | law kegs | law jail <name> <minutes> [reason] | law release <name> | law hunter <name> [licence|revoke|duty on|off]'
/** Open warrants' online time is written this often (ms). */
export const LAW_SAVE_MS = 30_000

/** The associates of a character (docs/PLAY_THE_BOSS.md §3.9's rule): its party, guild, account; its IP live. */
export interface Associates {
  chars: Set<number>
  accounts: Set<number>
  ip: string | null
}

interface OpenWarrant {
  id: number
  /** docs/JOBS.md §6.4: 'robbery' warrants (stolen goods) beside the wall's. */
  reason: WarrantReason
  accountId: number
  characterId: number
  role: WarrantRole
  wall: string | null
  offence: number
  bounty: number
  treason: boolean
  issuedAt: number
  leftMs: number
  /** The online clock's last reading (ms). */
  at: number
  savedAt: number
}

interface KegHit {
  seg: string
  at: number
  characterId: number
}

export interface CaptureResult {
  warrants: number[]
  bounty: number
  /** characterId -> gold paid. */
  paid: Map<number, number>
  /** Layer 6: every captor judged: the gold paid, whether the capture counts for them, the rule that withheld a reward. */
  captors: { characterId: number; name: string; gold: number; credit: boolean; rule?: CaptureRule }[]
  /** The sentence the jail serves (ms; layer 6). */
  sentenceMs: number
  offence: number
  /** docs/JOBS.md §6.4: which kinds of warrant the capture closed (the Hunters' job EXP), the Thief's job level. */
  wall: boolean
  robbery: boolean
  thiefLevel: number
}

const fromRow = (r: WarrantRow, now: number): OpenWarrant => ({
  id: r.id, reason: r.reason === 'robbery' ? 'robbery' : 'wall', accountId: r.account_id, characterId: r.character_id, role: r.role, wall: r.wall, offence: r.offence, bounty: r.bounty,
  treason: r.treason === 1, issuedAt: r.issued_at, leftMs: r.online_ms_left, at: now, savedAt: now,
})

export class LawService implements GameplayModule {
  readonly name = 'law'
  /** Online characters' open warrants (characterId). */
  private readonly open = new Map<number, OpenWarrant[]>()
  private hits: KegHit[] = []
  private booted = false
  private nextPrune = 0
  private storeCache: LawStore | null = null
  private ipLookup: ((p: Player) => string | null) | null = null
  private readonly accounts = new Map<number, number | null>()
  /** Siege event id -> the associates of its traitors (no rewards for them). */
  private readonly barred = new Map<number, Associates[]>()
  private readonly listeners: ((characterId: number, bounty: number) => void)[] = []

  constructor(readonly g: Gameplay) {
    g.world.decorators.push((e, s) => {
      if (e.kind !== 'player') return
      const b = this.bountyOf(e.characterId)
      if (b > 0) s.wanted = b
      if (this.robber(e.characterId)) s.robber = true
    })
  }

  /** The game sockets' IPs (the same-IP associates); game.ts connects it. */
  connect(c: { ipOf(p: Player): string | null }): void {
    this.ipLookup = c.ipOf
  }

  get store(): LawStore {
    return (this.storeCache ??= new LawStore(this.g.store.db))
  }

  get settings(): SiegeEventSettings['law'] {
    return this.g.siege.settings.law
  }

  // ---- who is who ---------------------------------------------------------------------------------------------------

  accountOf(characterId: number): number | null {
    let a = this.accounts.get(characterId)
    if (a === undefined) {
      a = this.g.store.characterById(characterId)?.account_id ?? null
      this.accounts.set(characterId, a)
    }
    return a
  }

  /** A player's game-socket IP; a loopback address (a dev server's own PC, tests) never counts. */
  ipOf(p: Player): string | null {
    const ip = this.ipLookup?.(p) ?? null
    if (!ip || /^(127\.|::1$|::ffff:127\.)/.test(ip)) return null
    return ip
  }

  private playerOf(characterId: number): Player | null {
    for (const p of this.g.world.players.values()) if (p.characterId === characterId) return p
    return null
  }

  /** The associates of `p` now: its party, guild, every character of its account, its IP. */
  associates(p: Player | number): Associates {
    const cid = typeof p === 'number' ? p : p.characterId
    const player = typeof p === 'number' ? this.playerOf(cid) : p
    const chars = new Set<number>([cid])
    const accounts = new Set<number>()
    const acc = this.accountOf(cid)
    if (acc !== null) {
      accounts.add(acc)
      for (const r of this.g.store.characters(acc)) chars.add(r.id)
    }
    for (const m of this.g.party.partyOf(cid)?.members ?? []) chars.add(m.characterId)
    for (const id of this.g.guilds.guildOf(cid)?.members.keys() ?? []) chars.add(id)
    return { chars, accounts, ip: player ? this.ipOf(player) : null }
  }

  isAssociate(a: Associates, q: Player): boolean {
    if (a.chars.has(q.characterId)) return true
    const acc = this.accountOf(q.characterId)
    if (acc !== null && a.accounts.has(acc)) return true
    return a.ip !== null && this.ipOf(q) === a.ip
  }

  /** Layer 6: the jail and Hunter duty refuse kegs (null: allowed). */
  kegRefusal(p: Player): Fail | null {
    if (this.g.jail.jailedNow(p)) return fail('jailed', 'Not from the Garrison Stockade.')
    if (this.g.hunters.onDuty(p)) return fail('not_usable', 'A Bounty Hunter on duty does not blow up walls (and one who does loses the licence).')
    return null
  }

  // ---- reads (layer 6: pings, the minimap, PvP) ------------------------------------------------------------------------

  private warrantsOf(characterId: number): OpenWarrant[] {
    const live = this.open.get(characterId)
    if (live) return live
    try {
      return this.store.openOf(characterId).map((r) => fromRow(r, 0))
    } catch {
      return []
    }
  }

  /** The bounty on a character's wall warrants (the WANTED label; 0 = none). Online characters from memory. */
  bountyOf(characterId: number): number {
    const list = this.open.get(characterId)
    return list ? list.reduce((s, w) => s + (w.reason === 'wall' ? w.bounty : 0), 0) : 0
  }

  /** docs/JOBS.md §6.4: an online character with an open robbery warrant (the ROBBER label). */
  robber(characterId: number): boolean {
    return this.open.get(characterId)?.some((w) => w.reason === 'robbery') === true
  }

  /** Online and huntable by Bounty Hunters: a wall warrant with a bounty, or a robbery warrant. */
  huntable(characterId: number): boolean {
    return this.open.get(characterId)?.some((w) => w.reason === 'robbery' || w.bounty > 0) === true
  }

  /** Only robbery warrants open (the den's ring shelters a robber, not a wall-breaker). */
  robberOnly(characterId: number): boolean {
    const list = this.open.get(characterId)
    return !!list?.length && list.every((w) => w.reason === 'robbery')
  }

  isWanted(characterId: number): boolean {
    return this.warrantsOf(characterId).length > 0
  }

  /** The Wanted state of a character (null = not Wanted). */
  wantedOf(characterId: number): WantedView | null {
    const list = this.warrantsOf(characterId)
    if (!list.length) return null
    const v: WantedView = {
      bounty: list.reduce((s, w) => s + w.bounty, 0),
      lapseMs: Math.max(0, Math.round(Math.max(...list.map((w) => w.leftMs)))),
      offence: Math.max(...list.map((w) => w.offence)),
      role: list.some((w) => w.role === 'breaker') ? 'breaker' : 'accomplice',
    }
    if (list.some((w) => w.treason)) v.treason = true
    if (list.some((w) => w.reason === 'robbery')) v.robbery = true
    return v
  }

  /** Every open warrant with its online time left (live for the online; the admin's Law tab). */
  openList(): { row: WarrantRow; leftMs: number; online: boolean }[] {
    return this.store.allOpen().map((row) => {
      const live = this.open.get(row.character_id)?.find((w) => w.id === row.id)
      return { row, leftMs: Math.max(0, Math.round(live ? live.leftMs : row.online_ms_left)), online: !!live }
    })
  }

  /** Listeners on a character's Wanted state (bounty 0 = no longer Wanted). */
  onWanted(fn: (characterId: number, bounty: number) => void): () => void {
    this.listeners.push(fn)
    return () => {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  /** The most a bounty may be (gold): law.bountyKegPct % of the Thunder Keg's price. */
  bountyCap(): number {
    return Math.floor((this.g.siege.settings.keg.gold * this.settings.bountyKegPct) / 100)
  }

  /** The account's offence level now (forgiveness applied). */
  offences(accountId: number, now: number): number {
    return offenceLevel(this.store.record(accountId), now, this.settings.forgiveDays)
  }

  /** The siege's rewards skip the traitors of that siege and their associates. */
  barredFromSiege(eventId: number, characterId: number, p: Player | null): boolean {
    const list = this.barred.get(eventId)
    if (!list?.length) return false
    const acc = this.accountOf(characterId)
    const ip = p ? this.ipOf(p) : null
    return list.some((a) => a.chars.has(characterId) || (acc !== null && a.accounts.has(acc)) || (a.ip !== null && ip === a.ip))
  }

  // ---- blasts and warrants -----------------------------------------------------------------------------------------------

  /** After a restart: the keg hits of the window, from wall_log. */
  private boot(now: number): void {
    if (this.booted) return
    this.booted = true
    const since = now - this.settings.accompliceWindowMin * 60_000
    this.hits = this.store.kegHits(this.g.config.world, since).filter((h) => !this.hits.some((x) => x.at === h.at && x.characterId === h.characterId))
  }

  /** A player keg blew at `seg`; `opened`: it took the segment through 0 (the planter breached it). */
  kegBlast(planter: Planter, seg: string, now: number, opened: boolean): void {
    this.boot(now)
    const win = this.settings.accompliceWindowMin * 60_000
    this.hits = this.hits.filter((h) => now - h.at <= win)
    // layer 6: a released prisoner's pardon covers older kegs (no accomplice from them)
    const prior = [...new Set(this.hits.filter((h) => h.seg === seg && h.characterId !== planter.characterId && !this.g.jail.pardoned(h.characterId, now)).map((h) => h.characterId))]
    this.hits.push({ seg, at: now, characterId: planter.characterId })
    if (!opened) return
    // everyone on this breach is charged now: their hits on the segment are spent
    this.hits = this.hits.filter((h) => h.seg !== seg)
    const treason = this.g.siege.running()
    const people: { characterId: number; role: WarrantRole }[] = [{ characterId: planter.characterId, role: 'breaker' }, ...prior.map((c) => ({ characterId: c, role: 'accomplice' as const }))]
    const issued = this.issue(people, seg, treason, now)
    const breaker = issued[0]!
    const accomplices = issued.slice(1).map((x) => x.name)
    const msg: Extract<ServerMessage, { t: 'lawNotice' }> = { t: 'lawNotice', event: 'wanted', wall: seg, name: breaker.name, bounty: breaker.bounty }
    if (treason) msg.treason = true
    if (accomplices.length) msg.accomplices = accomplices.slice(0, 20)
    this.broadcast(msg)
    this.chat(`[Law] ${breaker.name} has breached ${wallName(seg)}! ${treason ? 'Treason during the siege: ' : ''}A bounty of ${breaker.bounty.toLocaleString('en-US')} gold is posted.`)
    if (accomplices.length) this.chat(`[Law] Wanted as accomplices: ${issued.slice(1).map((x) => `${x.name} (${x.bounty.toLocaleString('en-US')} gold)`).join(', ')}.`)
    if (treason) {
      const ev = this.g.siege.ev
      if (ev) {
        const list = this.barred.get(ev.id) ?? []
        for (const x of issued) list.push(this.associates(x.characterId))
        this.barred.set(ev.id, list)
      }
    }
    // layer 6: a Hunter who breaks a wall loses the licence (docs/SIEGE.md §8.2)
    for (const x of issued) this.g.hunters.revokeFor(x.characterId, now, 'you broke the wall of Jangan')
    this.g.config.log(`law: ${breaker.name} breached ${seg}${treason ? ' (treason)' : ''}: ${issued.map((x) => `${x.name} ${x.role} offence ${x.offence} bounty ${x.bounty}`).join(', ')}`)
  }

  /**
   * Issues warrants for `people` (one offence per ACCOUNT, at its forgiven level + 1; one warrant per character). Returns
   * them in order.
   */
  issue(people: { characterId: number; role: WarrantRole }[], wall: string | null, treason: boolean, now: number, record = true): { characterId: number; name: string; role: WarrantRole; offence: number; bounty: number; id: number }[] {
    const s = this.settings
    const levels = new Map<number, number>()
    const out: { characterId: number; name: string; role: WarrantRole; offence: number; bounty: number; id: number }[] = []
    for (const x of people) {
      const acc = this.accountOf(x.characterId) ?? 0
      if (!levels.has(acc)) {
        const rec = addOffence(this.store.record(acc), now, s.forgiveDays)
        if (record) this.store.saveRecord(acc, rec)
        levels.set(acc, rec.offences)
      }
      const offence = levels.get(acc)!
      // anti-collusion: a bounty never pays more than the keg cost (law.bountyKegPct of keg.gold)
      const bounty = Math.min(wantedBounty(offence, x.role, treason, s), this.bountyCap())
      const leftMs = wantedOnlineMs(s)
      const id = this.store.issue({ account: acc, character: x.characterId, reason: 'wall', role: x.role, wall, offence, bounty, treason, issuedAt: now, onlineMsLeft: leftMs })
      const name = this.g.store.characterById(x.characterId)?.name ?? `#${x.characterId}`
      out.push({ characterId: x.characterId, name, role: x.role, offence, bounty, id })
      const p = this.playerOf(x.characterId)
      if (p) {
        const list = this.open.get(x.characterId) ?? []
        list.push({ id, reason: 'wall', accountId: acc, characterId: x.characterId, role: x.role, wall, offence, bounty, treason, issuedAt: now, leftMs, at: now, savedAt: now })
        this.open.set(x.characterId, list)
        this.changed(p, now)
        p.send({
          t: 'chat',
          channel: 'system',
          text: `You are WANTED${x.role === 'accomplice' ? ' as an accomplice' : ''} for breaking the wall of Jangan (offence ${offence}${treason ? ', treason' : ''}): a bounty of ${bounty.toLocaleString('en-US')} gold is on your head. The warrant lapses after ${fmtHours(leftMs)} of your time online.`,
        })
      }
    }
    return out
  }

  // ---- robbery warrants (docs/JOBS.md §6.4; jobs/robbery.ts) ----------------------------------------------------------------

  /** The open robbery warrant of a character (live, else the table), or null. */
  robberyOf(characterId: number): { id: number; bounty: number } | null {
    const w = this.warrantsOf(characterId).find((x) => x.reason === 'robbery')
    return w ? { id: w.id, bounty: w.bounty } : null
  }

  /**
   * A Thief picked up stolen goods: an open robbery warrant (one at a time) with `bounty` (the recovery reward), or the
   * open one's bounty updated. It lapses after `robbery.warrantOnlineMin` of online time; no server-wide notice. The
   * offence shown is the robbery level a capture would make (recorded at the capture: the robbery ladder).
   */
  robbery(characterId: number, bounty: number, now: number): number {
    const b = Math.max(0, Math.floor(bounty))
    const open = this.warrantsOf(characterId).find((x) => x.reason === 'robbery')
    const p = this.playerOf(characterId)
    if (open) {
      if (open.bounty !== b) {
        open.bounty = b
        this.store.setBounty(open.id, b)
        if (p) this.sendState(p, now)
      }
      return open.id
    }
    const acc = this.accountOf(characterId) ?? 0
    const js = this.g.jobs.settings.robbery
    const offence = offenceLevel(this.store.robberyRecord(acc), now, js.forgiveDays) + 1
    const leftMs = Math.round(js.warrantOnlineMin * 60_000)
    const id = this.store.issue({ account: acc, character: characterId, reason: 'robbery', role: 'breaker', wall: null, offence, bounty: b, treason: false, issuedAt: now, onlineMsLeft: leftMs })
    if (p) {
      const list = this.open.get(characterId) ?? []
      list.push({ id, reason: 'robbery', accountId: acc, characterId, role: 'breaker', wall: null, offence, bounty: b, treason: false, issuedAt: now, leftMs, at: now, savedAt: now })
      this.open.set(characterId, list)
      this.changed(p, now)
      p.send({ t: 'chat', channel: 'system', text: `You carry stolen goods: a ROBBERY warrant is out and the Bounty Hunters can track you. Sell the goods at the Bandit Den, or stay hidden for ${fmtHours(leftMs)} of your time online.` })
    }
    this.g.config.log(`law: robbery warrant #${id} for ${this.g.store.characterById(characterId)?.name ?? characterId} (bounty ${b})`)
    return id
  }

  /** Closes a character's robbery warrants only (`sold` at the den, `dropped` by a death). */
  closeRobbery(characterId: number, status: 'sold' | 'dropped' | 'pardoned', now: number): number {
    return this.close(characterId, status, now, [], 'robbery').length
  }

  /** A character's Wanted state changed: the label for everyone in view, lawState to them, the listeners. */
  private changed(p: Player, now: number): void {
    const bounty = this.bountyOf(p.characterId)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, wanted: bounty, robber: this.robber(p.characterId) })
    this.sendState(p, now)
    for (const fn of this.listeners) {
      try {
        fn(p.characterId, bounty)
      } catch (e) {
        this.g.config.log(`law: a listener failed: ${(e as Error)?.stack ?? e}`)
      }
    }
  }

  /** The own law state: the warrant, the offence level, and (layer 6) the Hunter's and the prisoner's state. */
  sendState(p: Player, now: number): void {
    const msg: Extract<ServerMessage, { t: 'lawState' }> = { t: 'lawState', offences: this.offences(this.accountOf(p.characterId) ?? 0, now) }
    const w = this.open.get(p.characterId)?.length ? this.wantedOf(p.characterId) : null
    if (w) msg.wanted = w
    const h = this.g.hunters.viewOf(p, now)
    if (h) msg.hunter = h
    const j = this.g.jail.viewOf(p, now)
    if (j) msg.jail = j
    p.send(msg)
  }

  /**
   * Closes every open warrant of a character (`lapsed`, `pardoned`, `captured`); online: the label goes, lawState. Returns
   * the closed warrants.
   */
  close(characterId: number, status: Exclude<WarrantStatus, 'open'>, now: number, captors: unknown[] = [], only?: WarrantReason): OpenWarrant[] {
    const live = this.open.get(characterId)
    const list = (live ?? this.store.openOf(characterId).map((r) => fromRow(r, now))).filter((w) => !only || w.reason === only)
    const closed: OpenWarrant[] = []
    for (const w of list) if (this.store.close(w.id, status, now, w.leftMs, captors)) closed.push(w)
    if (live) this.open.set(characterId, live.filter((w) => !list.includes(w)))
    const p = this.playerOf(characterId)
    if (p && closed.length) this.changed(p, now)
    return closed
  }

  /**
   * Layer 6's capture: the Wanted `characterId` is caught. Every open warrant closes `captured` (the jail follows);
   * the bounty is paid by the server to `captors` by `share`, under the anti-collusion rules (docs/SIEGE.md §8.6):
   * - `associate` (party, guild, the same account, the same IP) and `contact` / `lookout` (the accounts traded, used a
   *   stall, partied within `law.contactDays`, or the Hunter watched the keg) claim nothing and get no capture credit
   *   (their share goes to the others);
   * - `pair`: the same Hunter account caught the same Wanted account within `law.pairCooldownDays`: no gold, no credit
   *   (the share stays with the server);
   * - `repeat`: each earlier capture of the Wanted account in that window takes `law.repeatPct` % off; from
   *   `law.repeatMax` captures on nothing is paid and nobody gets credit;
   * - `daily_cap`: a Hunter account earns at most `hunter.dailyBountyCap` gold of bounties per 24 h.
   * Every withheld reward is a law_flags row (the admin Law tab). Returns the sentence (the longest of the warrants)
   * for the jail; null: not Wanted.
   */
  capture(characterId: number, captors: { player: Player; share: number }[], now: number): CaptureResult | null {
    const list = this.warrantsOf(characterId)
    if (!list.length) return null
    const s = this.settings
    const bounty = list.reduce((sum, w) => sum + w.bounty, 0)
    const wantedAcc = this.accountOf(characterId)
    const assoc = this.associates(characterId)
    const hunters = this.g.hunters.store
    const earlier = wantedAcc === null ? [] : hunters.capturesOf(wantedAcc, now - s.pairCooldownDays * DAY_MS)
    const repeatMul = earlier.length >= s.repeatMax ? 0 : (1 - s.repeatPct / 100) ** earlier.length
    const judged = captors
      .filter((c) => c.share > 0)
      .map((c) => {
        const acc = this.accountOf(c.player.characterId)
        let rule: CaptureRule | null = null
        if (this.isAssociate(assoc, c.player)) rule = 'associate'
        else {
          const met = acc !== null && wantedAcc !== null ? this.store.contactSince(acc, wantedAcc, now - s.contactDays * DAY_MS) : null
          if (met) rule = met === 'lookout' ? 'lookout' : 'contact'
          else if (acc !== null && earlier.some((e) => e.captors.some((x) => (x.account ?? this.accountOf(x.character)) === acc))) rule = 'pair'
        }
        return { ...c, acc, rule }
      })
    // associates and contacts leave the split; a pair-rule captor's share stays with the server
    const counted = judged.filter((c) => c.rule === null || c.rule === 'pair')
    const total = counted.reduce((sum, c) => sum + c.share, 0)
    const allShares = judged.reduce((sum, c) => sum + c.share, 0)
    const dayCap = this.g.siege.settings.hunter.dailyBountyCap
    const paid = new Map<number, number>()
    const out: CaptureResult['captors'] = []
    const records: { character: number; account: number | null; gold: number; credit: boolean; rule?: CaptureRule }[] = []
    const name = this.g.store.characterById(characterId)?.name ?? `#${characterId}`
    const flag = (c: { player: Player; acc: number | null }, rule: CaptureRule, withheld: number) => {
      this.store.flag({ at: now, wanted_character: characterId, wanted_account: wantedAcc ?? 0, hunter_character: c.player.characterId, hunter_account: c.acc, rule, withheld }, { wanted: name, hunter: c.player.name })
      this.g.config.log(`law: ${c.player.name}'s reward for ${name} withheld (${rule}, ${withheld} gold)`)
    }
    for (const c of judged) {
      const full = total > 0 && (c.rule === null || c.rule === 'pair') ? Math.floor((bounty * c.share) / total) : Math.floor((bounty * c.share) / Math.max(1, allShares))
      let gold = 0
      let rule: CaptureRule | undefined = c.rule ?? undefined
      let credit = c.rule === null
      if (c.rule !== null) flag(c, c.rule, Math.floor(full * repeatMul))
      else {
        gold = Math.floor(full * repeatMul)
        if (gold < full) {
          rule = 'repeat'
          if (repeatMul === 0) credit = false
          flag(c, 'repeat', full - gold)
        }
        if (gold > 0 && c.acc !== null) {
          const since = now - DAY_MS
          const earned = hunters.capturesSince(since).reduce((sum, e) => sum + e.captors.filter((x) => (x.account ?? this.accountOf(x.character)) === c.acc).reduce((t, x) => t + (x.gold ?? 0), 0), 0)
          const room = Math.max(0, dayCap - earned)
          if (gold > room) {
            flag(c, 'daily_cap', gold - room)
            rule = 'daily_cap'
            gold = room
          }
        }
      }
      if (gold > 0) {
        const g = gold
        const { result, draft } = this.g.store.inventoryTx(c.player.characterId, (d) => addGold(d, g))
        if (result.ok) {
          this.g.afterInventory(c.player, draft)
          paid.set(c.player.characterId, gold)
          c.player.send({ t: 'chat', channel: 'system', text: `The garrison pays you ${gold.toLocaleString('en-US')} gold of the bounty.` })
        } else gold = 0
      }
      records.push(rule ? { character: c.player.characterId, account: c.acc, gold, credit, rule } : { character: c.player.characterId, account: c.acc, gold, credit })
      out.push(rule ? { characterId: c.player.characterId, name: c.player.name, gold, credit, rule } : { characterId: c.player.characterId, name: c.player.name, gold, credit })
    }
    const wall = list.some((w) => w.reason === 'wall')
    const robbery = list.some((w) => w.reason === 'robbery')
    // docs/JOBS.md §6.4: a robber's goods are confiscated; the robbery ladder (per account) is the sentence
    let robberyMs = 0
    let robberyLevel = 0
    const thiefLevel = this.g.jobs.jobOf(characterId) === 'thief' ? this.g.jobs.levelOf(characterId) : 0
    if (robbery) {
      const js = this.g.jobs.settings.robbery
      const acc = wantedAcc ?? 0
      const rec = addOffence(this.store.robberyRecord(acc), now, js.forgiveDays)
      try {
        this.store.saveRobbery(acc, rec)
      } catch (e) {
        this.g.config.log(`law: the robbery record could not be saved: ${(e as Error).message}`)
      }
      robberyLevel = rec.offences
      robberyMs = robberySentenceMs(rec.offences, js.sentencesMin)
      this.g.robbery.confiscate(characterId, now)
    }
    const closed = this.close(characterId, 'captured', now, records)
    if (wall) this.broadcast({ t: 'lawNotice', event: 'captured', name, bounty })
    const walls = list.filter((w) => w.reason === 'wall')
    return {
      warrants: closed.map((w) => w.id),
      bounty,
      paid,
      captors: out,
      sentenceMs: Math.max(robberyMs, ...walls.map((w) => sentenceMs(w.offence, w.role, w.treason, s))),
      offence: Math.max(robberyLevel, ...walls.map((w) => w.offence)),
      wall,
      robbery,
      thiefLevel,
    }
  }

  /** Two characters' accounts met (a party; a lookout at a keg): the anti-collusion record (law_contacts). */
  contact(a: number, b: number, kind: 'party' | 'lookout', now: number): void {
    const x = this.accountOf(a)
    const y = this.accountOf(b)
    if (x === null || y === null || x === y) return
    try {
      this.store.touchContact(x, y, kind, now)
    } catch (e) {
      this.g.config.log(`law: a contact could not be saved: ${(e as Error)?.message ?? e}`)
    }
  }

  // ---- the online clock -----------------------------------------------------------------------------------------------

  enter(p: Player, now: number): void {
    this.boot(now)
    let rows: WarrantRow[] = []
    try {
      rows = this.store.openOf(p.characterId)
    } catch {
      rows = []
    }
    if (rows.length) {
      this.open.set(p.characterId, rows.map((r) => fromRow(r, now)))
      // the enter-world snapshot was built before this hook: the label to the player and whoever sees them already
      this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, wanted: this.bountyOf(p.characterId), robber: this.robber(p.characterId) })
    } else this.open.delete(p.characterId)
    // a clean record says nothing (the client starts clean)
    if (rows.length || this.offences(this.accountOf(p.characterId) ?? 0, now) > 0) this.sendState(p, now)
  }

  forget(p: Player): void {
    const list = this.open.get(p.characterId)
    if (!list) return
    const now = this.g.now
    for (const w of list) {
      w.leftMs -= Math.max(0, now - w.at)
      w.at = now
      this.store.saveLeft(w.id, w.leftMs)
    }
    this.open.delete(p.characterId)
  }

  tick(now: number): void {
    this.boot(now)
    if (now >= this.nextPrune) {
      this.nextPrune = now + 3_600_000
      try {
        this.store.pruneContacts(now - this.settings.contactDays * DAY_MS)
      } catch {
        // an old schema (tests that build one): nothing to prune
      }
    }
    for (const p of this.g.world.players.values()) {
      const list = this.open.get(p.characterId)
      if (!list?.length) continue
      const lapsed: OpenWarrant[] = []
      for (const w of list) {
        w.leftMs -= Math.max(0, now - w.at)
        w.at = now
        if (w.leftMs <= 0) lapsed.push(w)
        else if (now - w.savedAt >= LAW_SAVE_MS) {
          w.savedAt = now
          this.store.saveLeft(w.id, w.leftMs)
        }
      }
      if (lapsed.length) this.lapse(p, lapsed, now)
    }
  }

  private lapse(p: Player, lapsed: OpenWarrant[], now: number): void {
    for (const w of lapsed) this.store.close(w.id, 'lapsed', now, 0)
    const left = (this.open.get(p.characterId) ?? []).filter((w) => !lapsed.includes(w))
    this.open.set(p.characterId, left)
    this.changed(p, now)
    if (left.length) return
    if (lapsed.every((w) => w.reason === 'robbery')) {
      // docs/JOBS.md §6.4: no server-wide notice for robbers; the goods stay sellable
      p.send({ t: 'chat', channel: 'system', text: 'Your robbery warrant has lapsed: the Bounty Hunters lost your trail. The goods are still yours to sell at the Bandit Den.' })
      return
    }
    this.broadcast({ t: 'lawNotice', event: 'lapsed', name: p.name })
    p.send({ t: 'chat', channel: 'system', text: 'Your warrant has lapsed: the garrison has stopped looking for you. The offence stays on your record.' })
    this.g.config.log(`law: ${p.name}'s warrant lapsed`)
  }

  private broadcast(msg: ServerMessage): void {
    for (const p of this.g.world.players.values()) p.send(msg)
  }

  private chat(text: string): void {
    this.broadcast({ t: 'chat', channel: 'system', text })
  }

  // ---- GM `law` -----------------------------------------------------------------------------------------------------------

  gm(self: Player | null, args: string[], now: number): GmResult {
    this.boot(now)
    const a = args.map((x) => x.trim()).filter(Boolean)
    const verb = (a[0] ?? 'status').toLowerCase()
    const who = self?.name ?? 'a GM'
    const s = this.settings
    if (verb === 'status') {
      const rows = this.store.allOpen()
      const lines = rows.map((r) => {
        const live = this.open.get(r.character_id)?.find((w) => w.id === r.id)
        const left = live ? live.leftMs : r.online_ms_left
        return `#${r.id} ${this.g.store.characterById(r.character_id)?.name ?? r.character_id} ${r.role}${r.wall ? ` ${r.wall}` : ''} offence ${r.offence}${r.treason ? ' treason' : ''}, ${r.bounty.toLocaleString('en-US')} gold, ${fmtHours(left)} online left${live ? ' (online)' : ''}`
      })
      const win = s.accompliceWindowMin * 60_000
      const hits = this.hits.filter((h) => now - h.at <= win).map((h) => `${h.seg} by ${this.g.store.characterById(h.characterId)?.name ?? h.characterId} ${Math.round((now - h.at) / 1000)} s ago`)
      return { ok: true, message: `Open warrants (${rows.length}):\n${lines.join('\n') || 'none'}\nKeg hits in the last ${s.accompliceWindowMin} min: ${hits.join(', ') || 'none'}\n${this.g.kegs.describe(now)}`, data: { warrants: rows.length } }
    }
    if (verb === 'kegs') return { ok: true, message: this.g.kegs.describe(now) }
    const name = a[1]
    if (!name) {
      if (verb === 'jail') {
        const terms = this.g.jail.list(now)
        return { ok: true, message: `In the Garrison Stockade (${terms.length}):\n${terms.map((t) => `${t.name}: ${fmtHours(t.leftMs)} left, ${t.chores} chores${t.online ? ' (online)' : ''}`).join('\n') || 'nobody'}` }
      }
      return { ok: false, message: `Usage: ${LAW_USAGE}` }
    }
    // layer 6: the jail and the Hunters
    if (verb === 'jail') return this.g.jail.gmJail(name, Number(a[2]), a.slice(3).join(' '), now, who)
    if (verb === 'release') return this.g.jail.gmRelease(name, now)
    if (verb === 'hunter') return this.g.hunters.gm(name, a[2] ?? 'status', a[3], now)
    const row = this.g.store.characterByName(name.replace(/^@/, ''))
    if (!row) return { ok: false, message: `No character named ${name}.` }
    const acc = row.account_id
    if (verb === 'record') {
      const rec = this.store.record(acc)
      const ws = this.store.ofCharacter(row.id, 5).map((r) => `  #${r.id} ${new Date(r.issued_at).toISOString().slice(0, 16).replace('T', ' ')} ${r.role} ${r.wall ?? '-'} offence ${r.offence} ${r.bounty.toLocaleString('en-US')} gold: ${r.status}`)
      const cd = rec?.lastPlantAt ? Math.max(0, rec.lastPlantAt + this.g.siege.settings.keg.cooldownMin * 60_000 - now) : 0
      return {
        ok: true,
        message: `${row.name} (account ${acc}): offence level ${this.offences(acc, now)} now (${rec?.offences ?? 0} recorded${rec?.lastAt ? `, last ${new Date(rec.lastAt).toISOString().slice(0, 10)}` : ''}); keg cooldown ${cd ? `${Math.ceil(cd / 60_000)} min` : 'free'}\n${ws.join('\n') || '  no warrants'}`,
        data: { offences: this.offences(acc, now), recorded: rec?.offences ?? 0 },
      }
    }
    if (verb === 'wanted') {
      if (a[2]?.toLowerCase() === 'off') {
        const n = this.close(row.id, 'pardoned', now).length
        if (n) this.broadcast({ t: 'lawNotice', event: 'pardoned', name: row.name })
        return { ok: n > 0, message: n ? `${row.name}'s ${n} warrant${n === 1 ? '' : 's'} closed (pardoned) by ${who}.` : `${row.name} is not Wanted.` }
      }
      // a GM warrant: the account's next level, without recording an offence
      const w = this.issue([{ characterId: row.id, role: 'breaker' }], null, false, now, false)[0]!
      return { ok: true, message: `${row.name} is Wanted (GM warrant #${w.id}, offence ${w.offence}, ${w.bounty.toLocaleString('en-US')} gold; no offence recorded).` }
    }
    if (verb === 'pardon') {
      const n = this.close(row.id, 'pardoned', now).length
      if (n) this.broadcast({ t: 'lawNotice', event: 'pardoned', name: row.name })
      return { ok: n > 0, message: n ? `${row.name} is pardoned (${n} warrant${n === 1 ? '' : 's'} closed).` : `${row.name} is not Wanted.` }
    }
    if (verb === 'forgive') {
      const rec = this.store.record(acc)
      const level = this.offences(acc, now)
      const next = a[2]?.toLowerCase() === 'all' ? 0 : Math.max(0, level - 1)
      this.store.saveRecord(acc, { offences: next, lastAt: rec?.lastAt ?? null })
      return { ok: true, message: `${row.name}'s account: offence level ${level} -> ${next}.` }
    }
    if (verb === 'lapse') {
      const min = a[2] === undefined ? 0 : Number(a[2])
      if (!Number.isFinite(min) || min < 0 || min > 48 * 60) return { ok: false, message: 'Usage: law lapse <name> [minutes of online time left, 0-2880]' }
      const live = this.open.get(row.id)
      const rows = this.store.openOf(row.id)
      if (!rows.length) return { ok: false, message: `${row.name} is not Wanted.` }
      for (const r of rows) this.store.saveLeft(r.id, min * 60_000)
      for (const w of live ?? []) {
        w.leftMs = min * 60_000
        w.at = now
      }
      const p = this.playerOf(row.id)
      if (p && min > 0) this.sendState(p, now)
      return { ok: true, message: min ? `${row.name}'s warrant lapses after ${min} more min online.` : `${row.name}'s warrant lapses ${p ? 'now' : 'at the next login'}.` }
    }
    if (verb === 'capture') {
      const captor = a[2] ? [...this.g.world.players.values()].find((p) => p.name.toLowerCase() === a[2]!.toLowerCase()) : self
      const r = this.capture(row.id, captor ? [{ player: captor, share: 1 }] : [], now)
      if (!r) return { ok: false, message: `${row.name} is not Wanted.` }
      this.g.hunters.credit(r, row.name, now)
      this.g.jail.imprison(row.id, r.sentenceMs, r.warrants[0] ?? null, now, `offence ${r.offence}, by ${who}`)
      return { ok: true, message: `${row.name} is captured: ${r.warrants.length} warrant(s) closed, bounty ${r.bounty.toLocaleString('en-US')} gold (${[...r.paid].map(([c, g]) => `${this.g.store.characterById(c)?.name}: ${g}`).join(', ') || 'nobody paid'}); jailed for ${fmtHours(r.sentenceMs)}.`, data: { bounty: r.bounty, sentenceMs: r.sentenceMs } }
    }
    if (verb === 'cooldown') {
      this.store.setPlant(acc, null)
      return { ok: true, message: `${row.name}'s account may plant a Thunder Keg again.` }
    }
    return { ok: false, message: `Usage: ${LAW_USAGE}` }
  }
}

function fmtHours(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`
}
