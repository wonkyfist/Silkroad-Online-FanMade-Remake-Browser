import {
  addOffence,
  offenceLevel,
  sentenceMs,
  wallName,
  wantedBounty,
  wantedOnlineMs,
  type ServerMessage,
  type SiegeEventSettings,
  type WantedView,
  type WarrantRole,
  type WarrantStatus,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, type Fail } from '../inventory.ts'
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

export const LAW_USAGE = 'law [status] | law record <name> | law wanted <name> [off] | law lapse <name> [minutes] | law pardon <name> | law forgive <name> [all] | law capture <name> [captor] | law cooldown <name> | law kegs'
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
  /** The sentence the jail serves (ms; layer 6). */
  sentenceMs: number
  offence: number
}

const fromRow = (r: WarrantRow, now: number): OpenWarrant => ({
  id: r.id, accountId: r.account_id, characterId: r.character_id, role: r.role, wall: r.wall, offence: r.offence, bounty: r.bounty,
  treason: r.treason === 1, issuedAt: r.issued_at, leftMs: r.online_ms_left, at: now, savedAt: now,
})

export class LawService implements GameplayModule {
  readonly name = 'law'
  /** Online characters' open warrants (characterId). */
  private readonly open = new Map<number, OpenWarrant[]>()
  private hits: KegHit[] = []
  private booted = false
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

  /** Layer 6 hook: the jail and Hunter duty refuse kegs (null: allowed). */
  kegRefusal(_p: Player): Fail | null {
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

  /** The bounty on a character (all open warrants; 0 = not Wanted). Online characters from memory. */
  bountyOf(characterId: number): number {
    const list = this.open.get(characterId)
    return list ? list.reduce((s, w) => s + w.bounty, 0) : 0
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
    return v
  }

  /** Listeners on a character's Wanted state (bounty 0 = no longer Wanted). */
  onWanted(fn: (characterId: number, bounty: number) => void): () => void {
    this.listeners.push(fn)
    return () => {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    }
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
    const prior = [...new Set(this.hits.filter((h) => h.seg === seg && h.characterId !== planter.characterId).map((h) => h.characterId))]
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
      const bounty = wantedBounty(offence, x.role, treason, s)
      const leftMs = wantedOnlineMs(s)
      const id = this.store.issue({ account: acc, character: x.characterId, reason: 'wall', role: x.role, wall, offence, bounty, treason, issuedAt: now, onlineMsLeft: leftMs })
      const name = this.g.store.characterById(x.characterId)?.name ?? `#${x.characterId}`
      out.push({ characterId: x.characterId, name, role: x.role, offence, bounty, id })
      const p = this.playerOf(x.characterId)
      if (p) {
        const list = this.open.get(x.characterId) ?? []
        list.push({ id, accountId: acc, characterId: x.characterId, role: x.role, wall, offence, bounty, treason, issuedAt: now, leftMs, at: now, savedAt: now })
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

  /** A character's Wanted state changed: the label for everyone in view, lawState to them, the listeners. */
  private changed(p: Player, now: number): void {
    const bounty = this.bountyOf(p.characterId)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, wanted: bounty })
    this.sendState(p, now)
    for (const fn of this.listeners) {
      try {
        fn(p.characterId, bounty)
      } catch (e) {
        this.g.config.log(`law: a listener failed: ${(e as Error)?.stack ?? e}`)
      }
    }
  }

  private sendState(p: Player, now: number): void {
    const msg: Extract<ServerMessage, { t: 'lawState' }> = { t: 'lawState', offences: this.offences(this.accountOf(p.characterId) ?? 0, now) }
    const w = this.open.get(p.characterId)?.length ? this.wantedOf(p.characterId) : null
    if (w) msg.wanted = w
    p.send(msg)
  }

  /**
   * Closes every open warrant of a character (`lapsed`, `pardoned`, `captured`); online: the label goes, lawState. Returns
   * the closed warrants.
   */
  close(characterId: number, status: Exclude<WarrantStatus, 'open'>, now: number, captors: unknown[] = []): OpenWarrant[] {
    const live = this.open.get(characterId)
    const list = live ?? this.store.openOf(characterId).map((r) => fromRow(r, now))
    const closed: OpenWarrant[] = []
    for (const w of list) if (this.store.close(w.id, status, now, w.leftMs, captors)) closed.push(w)
    if (live) this.open.set(characterId, [])
    const p = this.playerOf(characterId)
    if (p && closed.length) this.changed(p, now)
    return closed
  }

  /**
   * Layer 6's capture hook: the Wanted `characterId` is caught. Every open warrant closes `captured`; the bounty is paid
   * by the server to `captors` by `share` (associates of the Wanted get nothing); returns the sentence (the longest of
   * its warrants) for the jail. null: not Wanted.
   */
  capture(characterId: number, captors: { player: Player; share: number }[], now: number): CaptureResult | null {
    const list = this.warrantsOf(characterId)
    if (!list.length) return null
    const bounty = list.reduce((s, w) => s + w.bounty, 0)
    const assoc = this.associates(characterId)
    const fair = captors.filter((c) => c.share > 0 && !this.isAssociate(assoc, c.player))
    const total = fair.reduce((s, c) => s + c.share, 0)
    const paid = new Map<number, number>()
    for (const c of fair) {
      const gold = Math.floor((bounty * c.share) / total)
      if (gold <= 0) continue
      const { result, draft } = this.g.store.inventoryTx(c.player.characterId, (d) => addGold(d, gold))
      if (!result.ok) continue
      this.g.afterInventory(c.player, draft)
      paid.set(c.player.characterId, gold)
      c.player.send({ t: 'chat', channel: 'system', text: `The garrison pays you ${gold.toLocaleString('en-US')} gold of the bounty.` })
    }
    const closed = this.close(characterId, 'captured', now, [...paid].map(([c, gold]) => ({ character: c, gold })))
    const name = this.g.store.characterById(characterId)?.name ?? `#${characterId}`
    this.broadcast({ t: 'lawNotice', event: 'captured', name, bounty })
    const s = this.settings
    return {
      warrants: closed.map((w) => w.id),
      bounty,
      paid,
      sentenceMs: Math.max(0, ...list.map((w) => sentenceMs(w.offence, w.role, w.treason, s))),
      offence: Math.max(...list.map((w) => w.offence)),
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
      this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, wanted: this.bountyOf(p.characterId) })
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
    if (!name) return { ok: false, message: `Usage: ${LAW_USAGE}` }
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
      return { ok: true, message: `${row.name} is captured: ${r.warrants.length} warrant(s) closed, bounty ${r.bounty.toLocaleString('en-US')} gold (${[...r.paid].map(([c, g]) => `${this.g.store.characterById(c)?.name}: ${g}`).join(', ') || 'nobody paid'}); sentence ${fmtHours(r.sentenceMs)} (the jail comes with layer 6).`, data: { bounty: r.bounty, sentenceMs: r.sentenceMs } }
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
