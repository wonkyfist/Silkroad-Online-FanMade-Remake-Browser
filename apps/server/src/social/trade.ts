import {
  TRADE_BREAK_RANGE,
  TRADE_RANGE,
  TRADE_REQUESTS,
  TRADE_REQUEST_MS,
  type GameplayRequest,
  type TradeEndReason,
  type TradeSide,
  type TradeState,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import { fail, toStack, type Fail, type InvDraft, type InvItem } from '../inventory.ts'
import { askGates, type Answer, type GameplayMessage, type GameplayModule, type WarpReason } from '../modules.ts'
import type { Player } from '../world.ts'
import { logSocial, pairTx } from './pair-tx.ts'
import * as rules from './trade-rules.ts'
import type { TradeSession, TradeSideKey, TradeSideState, TradeStep } from './trade-rules.ts'

/**
 * Player trade (exchange; docs/SYSTEMS_SOCIAL.md §3; lane TR-S).
 *
 * - Requests (§3.1): tradeRequest → `tradeRequested` to the invitee (one pending request per invitee, and a new
 *   request replaces the requester's older one); tradeRespond opens the session after re-checking both players.
 *   Every change sends the full `trade` state to both; the final accept commits (§3.5) through pairTx and ends with
 *   `tradeEnd done`. The pure rules are trade-rules.ts.
 * - The inventory lock (§2.3): while a session is open, `gate` lets through only ALLOWED (plus the trade requests,
 *   which it is never asked about) and refuses everything else with `trading`; `attack`, `useSkill` and `npcTalk`
 *   end the trade (`moved`) and go through; a client moveTo ends it through the `moved` hook.
 * - Ends (§3.3): moved / warped → 'moved', `playerDied` → 'dead', `forget` → 'left', the 1 Hz tick → 'too_far' (beyond
 *   TRADE_BREAK_RANGE, or a partner that can no longer be seen), cancel → 'cancelled', a failed commit → 'failed'.
 *   Requests end with 'declined' / 'expired' (30 s, or either side leaving / starting another trade). A request's
 *   `tradeEnd` never goes to a player whose trade window is open (it would close that window).
 */

/** Requests a trading player may still send (docs/SYSTEMS_SOCIAL.md §2.3 "Allowed"); everything else is `trading`. */
export const TRADE_ALLOWED: ReadonlySet<GameplayRequest> = new Set<GameplayRequest>([
  'stopAction', 'hotbarSet', 'statUp', 'skillLearn', 'masteryUp', 'buffCancel',
  'partyInvite', 'partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings',
  'guildDisband', 'guildInvite', 'guildRespond', 'guildLeave', 'guildKick', 'guildPerms', 'guildTitle', 'guildNotice', 'guildMaster',
  'storageOpen', 'npcClose',
  // docs/WAVE_PLAN2.md §6.5 (I8): an emote is harmless, and dismissing a horse touches no bag.
  'emote', 'mountDismiss',
  // docs/MOVEMENT.md §4.3 (wave 10): the jump is cosmetic like an emote; it moves nothing, so the trade stays open.
  'jump',
  // Leaving a stall you visit touches nothing, and a visitor who accepted a trade must be able to close that window.
  'stallLeave',
])

/** Requests that end an open trade and then go through (§2.3 "Ends the state instead"). */
export const TRADE_BREAKERS: ReadonlySet<GameplayRequest | 'moveTo'> = new Set<GameplayRequest | 'moveTo'>(['attack', 'useSkill', 'npcTalk'])

/** How often the distance break is checked (§10.5: 1 Hz). */
export const TRADE_CHECK_MS = 1000

interface TradeRequest {
  from: number
  fromName: string
  to: number
  toName: string
  expiresAt: number
}

/** An open session with its two players (both online; `forget` ends it). */
interface Live {
  s: TradeSession
  a: Player
  b: Player
}

export class TradeService implements GameplayModule {
  readonly name = 'trade'
  readonly handles: readonly GameplayRequest[] = TRADE_REQUESTS
  /** A decline answers while dead; an accept answers `dead` (docs/WAVE_PLAN2.md §3.2.6). */
  readonly whileDead: readonly GameplayRequest[] = ['tradeCancel', 'tradeRespond']

  /** characterId -> its open session. */
  private readonly live = new Map<number, Live>()
  /** Invitee characterId -> the pending request (one per invitee). */
  private readonly requests = new Map<number, TradeRequest>()
  private nextId = 1
  private nextCheckAt = 0

  constructor(readonly g: Gameplay) {}

  // ---- queries -------------------------------------------------------------------------------------------

  /** The open session of a player (or character id), if any. */
  sessionOf(p: Player | number): TradeSession | undefined {
    return this.live.get(typeof p === 'number' ? p : p.characterId)?.s
  }

  /** Whether the player has a trade window open. */
  isTrading(p: Player | number): boolean {
    return this.live.has(typeof p === 'number' ? p : p.characterId)
  }

  /** The pending request to a character, if any (tests, GM tools). */
  pendingFor(characterId: number): Readonly<TradeRequest> | undefined {
    return this.requests.get(characterId)
  }

  private online(characterId: number): Player | undefined {
    for (const p of this.g.world.players.values()) if (p.characterId === characterId) return p
    return undefined
  }

  // ---- gate and hooks ------------------------------------------------------------------------------------

  gate(p: Player, t: GameplayRequest | 'moveTo', _now: number): Fail | null {
    const l = this.live.get(p.characterId)
    if (!l) return null
    // A client moveTo ends the trade in the `moved` hook (only when it is accepted).
    if (t === 'moveTo') return null
    if (TRADE_BREAKERS.has(t)) {
      this.end(l, 'moved', p)
      return null
    }
    if (TRADE_ALLOWED.has(t)) return null
    return fail('trading', 'You are trading.')
  }

  moved(p: Player, _now: number): void {
    const l = this.live.get(p.characterId)
    if (l) this.end(l, 'moved', p)
  }

  playerDied(p: Player, _now: number): void {
    const l = this.live.get(p.characterId)
    if (l) this.end(l, 'dead', p)
  }

  warped(p: Player, _reason: WarpReason, _now: number): void {
    const l = this.live.get(p.characterId)
    if (l) this.end(l, 'moved', p)
  }

  forget(p: Player): void {
    const l = this.live.get(p.characterId)
    if (l) this.end(l, 'left', p)
    for (const [to, r] of this.requests) {
      if (r.to === p.characterId || r.from === p.characterId) this.endRequest(to, 'expired')
    }
  }

  tick(now: number): void {
    for (const [to, r] of this.requests) if (r.expiresAt <= now) this.endRequest(to, 'expired')
    if (now < this.nextCheckAt) return
    this.nextCheckAt = now + TRADE_CHECK_MS
    for (const l of new Set(this.live.values())) {
      const world = this.g.world
      if (world.players.get(l.a.id) !== l.a || world.players.get(l.b.id) !== l.b) {
        this.end(l, 'left', world.players.get(l.a.id) === l.a ? l.b : l.a)
        continue
      }
      // Too far, or a partner that turned invisible (GM): the window closes for both.
      if (world.distance(l.a, l.b, now) > TRADE_BREAK_RANGE || !world.canSee(l.a, l.b) || !world.canSee(l.b, l.a)) this.end(l, 'too_far')
    }
  }

  // ---- requests ------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'tradeRequest':
        return this.ask(p, msg.target, answer, now)
      case 'tradeRespond':
        return this.respond(p, msg.from, msg.accept, answer, now)
      case 'tradeCancel':
        return this.cancel(p, answer)
      case 'tradeOffer':
        return this.step(p, answer, now, (l, side) => {
          const inv = this.g.store.loadInventory(p.characterId)
          const it = Number.isInteger(msg.bag) && msg.bag >= 0 && msg.bag < inv.bagSize ? inv.bag[msg.bag] : null
          const partner = this.g.store.loadInventory(l.s[rules.otherSide(side)].characterId)
          return rules.offer(l.s, side, inv, msg.bag, msg.count, it ? this.g.data.item(it.code) : undefined, rules.freeSlots(partner))
        })
      case 'tradeTake':
        return this.step(p, answer, now, (l, side) => rules.take(l.s, side, msg.slot))
      case 'tradeGold':
        return this.step(p, answer, now, (l, side) => rules.setGold(l.s, side, this.g.store.loadInventory(p.characterId), msg.amount))
      case 'tradeLock':
        return this.step(p, answer, now, (l, side) => this.inRange(l, now) ?? rules.lock(l.s, side))
      case 'tradeAccept':
        return this.step(p, answer, now, (l, side) => this.inRange(l, now) ?? rules.accept(l.s, side))
    }
    answer(fail('not_found'))
  }

  /** Why `a` and `b` cannot trade right now (§3.1 checks, from `a`'s point of view), or null. */
  private problem(a: Player, b: Player, now: number): Fail | null {
    const world = this.g.world
    if (!a.known.has(b.id) || !world.canSee(a, b) || world.players.get(b.id) !== b) return fail('not_found')
    if (a.dead) return fail('dead')
    if (b.dead) return fail('invalid_target', `${b.name} is dead.`)
    if (this.live.has(a.characterId)) return fail('trading', 'You are already trading.')
    if (this.live.has(b.characterId)) return fail('trading', `${b.name} is trading with someone else.`)
    const busy = this.busy(b, now)
    if (busy) return busy.reason === 'stalling' ? fail('stalling', `${b.name} is running a stall.`) : fail(busy.reason, `${b.name} cannot trade right now.`)
    if (world.distance(a, b, now) > TRADE_RANGE) return fail('too_far')
    return null
  }

  /**
   * Whether the other modules would refuse `b` an exchange right now (a stall, an alchemy fuse, ...): their gates
   * asked about `b` answering a trade. The asking player's own gates already ran for its request.
   */
  private busy(b: Player, now: number): Fail | null {
    return askGates(this.g.modules, this, b, 'tradeRespond', now, (e, where) => this.g.config.log(`gameplay module ${where} failed: ${(e as Error)?.stack ?? e}`))
  }

  private ask(p: Player, targetId: number, answer: Answer, now: number): void {
    if (targetId === p.id) return answer(fail('invalid_target', 'You cannot trade with yourself.'))
    const e = this.g.world.entity(targetId)
    if (!e || !p.known.has(targetId)) return answer(fail('not_found'))
    if (e.kind !== 'player') return answer(fail('invalid_target', 'You can only trade with players.'))
    if (!this.g.world.canSee(p, e)) return answer(fail('not_found'))
    const pending = this.requests.get(e.characterId)
    const problem = this.problem(p, e, now)
    if (problem) return answer(problem)
    if (pending) return answer(fail('cooldown', `${e.name} already has a trade request.`))
    // One outgoing request per requester: a new one replaces the older one.
    for (const [to, r] of this.requests) if (r.from === p.characterId) this.endRequest(to, 'expired', { toRequester: false })
    this.requests.set(e.characterId, { from: p.characterId, fromName: p.name, to: e.characterId, toName: e.name, expiresAt: now + TRADE_REQUEST_MS })
    answer(true)
    e.send({ t: 'tradeRequested', from: p.id, name: p.name, level: p.level, expiresInMs: TRADE_REQUEST_MS })
  }

  private respond(p: Player, fromId: number, accept: boolean, answer: Answer, now: number): void {
    const r = this.requests.get(p.characterId)
    if (!r) return answer(fail('no_invite'))
    const from = this.online(r.from)
    if (!from) {
      this.requests.delete(p.characterId)
      return answer(fail('no_invite', `${r.fromName} is no longer online.`))
    }
    if (from.id !== fromId) return answer(fail('no_invite'))
    if (accept && p.dead) return answer(fail('dead'))
    this.requests.delete(p.characterId)
    if (!accept) {
      answer(true)
      if (!this.live.has(from.characterId)) from.send({ t: 'tradeEnd', reason: 'declined', name: p.name })
      return
    }
    // Every §3.1 check again, for both sides (each told from its own point of view).
    const mine = this.problem(p, from, now)
    const theirs = this.problem(from, p, now)
    if (mine || theirs) {
      answer((mine ?? theirs)!)
      if (!this.live.has(from.characterId)) from.send({ t: 'tradeEnd', reason: 'failed', name: p.name, message: (theirs ?? mine)!.message ?? 'The exchange could not start.' })
      return
    }
    const l: Live = { s: rules.newSession(this.nextId++, from.characterId, p.characterId, now), a: from, b: p }
    this.live.set(from.characterId, l)
    this.live.set(p.characterId, l)
    // Anyone else waiting on these two gives up (their accept would only answer `trading`).
    for (const [to, q] of this.requests) {
      if (to === from.characterId || to === p.characterId || q.from === from.characterId || q.from === p.characterId) this.endRequest(to, 'expired')
    }
    answer(true)
    this.sendState(l)
    this.g.config.log(`trade ${l.s.id}: ${from.name} and ${p.name} opened an exchange`)
  }

  private cancel(p: Player, answer: Answer): void {
    const l = this.live.get(p.characterId)
    if (l) {
      answer(true)
      return this.end(l, 'cancelled', p)
    }
    // Before the partner answered: withdraw the own request.
    for (const [to, r] of this.requests) {
      if (r.from === p.characterId) {
        answer(true)
        return this.endRequest(to, 'cancelled', { toRequester: false })
      }
    }
    answer(fail('not_found', 'You are not trading.'))
  }

  private inRange(l: Live, now: number): Fail | null {
    return this.g.world.distance(l.a, l.b, now) > TRADE_RANGE ? fail('too_far') : null
  }

  /** One edit/lock/accept step on the player's open session: answers, then sends the state or commits. */
  private step(p: Player, answer: Answer, now: number, fn: (l: Live, side: TradeSideKey) => TradeStep | Fail): void {
    const l = this.live.get(p.characterId)
    const side = l ? rules.sideOf(l.s, p.characterId) : null
    if (!l || !side) return answer(fail('not_found', 'You are not trading.'))
    const r = fn(l, side)
    if (!r.ok) return answer(r)
    answer(true)
    if (r.value === 'commit') return this.commit(l, now)
    if (r.value === 'changed') this.sendState(l)
  }

  // ---- commit --------------------------------------------------------------------------------------------

  /** Both sides accepted: one SQLite transaction over both inventories (§3.5), then the effects and `tradeEnd`. */
  private commit(l: Live, now: number): void {
    const { s, a, b } = l
    let out: ReturnType<typeof pairTx<{ aGot: InvItem[]; bGot: InvItem[] }>>
    try {
      out = pairTx(
        this.g.store,
        s.a.characterId,
        s.b.characterId,
        (da, db) => rules.commitDrafts(s, da, db, (code) => this.g.data.item(code), { a: a.name, b: b.name }),
        (v) => logSocial(this.g.store, { kind: 'trade', aChar: s.a.characterId, bChar: s.b.characterId, aGold: s.a.gold, bGold: s.b.gold, aItems: v.bGot, bItems: v.aGot }, now),
      )
    } catch (e) {
      this.g.config.log(`trade ${s.id}: commit failed: ${(e as Error)?.stack ?? e}`)
      return this.end(l, 'failed', undefined, 'The exchange failed.')
    }
    if (!out.result.ok) {
      this.g.config.log(`trade ${s.id}: ${a.name} / ${b.name} not committed (${out.result.reason})`)
      return this.end(l, 'failed', undefined, out.result.message ?? 'The exchange failed.')
    }
    this.close(l)
    this.effects(a, out.da)
    this.effects(b, out.db)
    a.send({ t: 'tradeEnd', reason: 'done', name: b.name })
    b.send({ t: 'tradeEnd', reason: 'done', name: a.name })
    const v = out.result.value
    this.g.config.log(`trade ${s.id}: ${a.name} gave ${s.a.gold} gold + ${v.bGot.length} stack(s), ${b.name} gave ${s.b.gold} gold + ${v.aGot.length} stack(s)`)
  }

  private effects(p: Player, d: InvDraft): void {
    try {
      this.g.afterInventory(p, d)
    } catch (e) {
      this.g.config.log(`trade: afterInventory for ${p.name} failed: ${(e as Error)?.stack ?? e}`)
    }
  }

  // ---- messages ------------------------------------------------------------------------------------------

  private side(own: TradeSideState, mine: boolean): TradeSide {
    return {
      items: own.items.map((o) => (o ? (mine ? { stack: toStack(o), bag: o.bag } : { stack: toStack(o) }) : null)),
      gold: own.gold,
      locked: own.locked,
      accepted: own.accepted,
    }
  }

  /** The full state for one side of a session. */
  stateFor(l: { s: TradeSession; a: Player; b: Player }, who: 'a' | 'b'): TradeState {
    const partner = who === 'a' ? l.b : l.a
    return { partner: partner.id, name: partner.name, level: partner.level, mine: this.side(l.s[who], true), theirs: this.side(l.s[rules.otherSide(who)], false) }
  }

  private sendState(l: Live): void {
    l.a.send({ t: 'trade', trade: this.stateFor(l, 'a') })
    l.b.send({ t: 'trade', trade: this.stateFor(l, 'b') })
  }

  private close(l: Live): void {
    if (this.live.get(l.s.a.characterId) === l) this.live.delete(l.s.a.characterId)
    if (this.live.get(l.s.b.characterId) === l) this.live.delete(l.s.b.characterId)
  }

  /**
   * Ends a session: `tradeEnd` to both (not to a player who left the world). `by` is who caused it (its name goes
   * out); without one, each side gets its partner's name.
   */
  private end(l: Live, reason: TradeEndReason, by?: Player, message?: string): void {
    if (this.live.get(l.s.a.characterId) !== l && this.live.get(l.s.b.characterId) !== l) return
    this.close(l)
    for (const [p, partner] of [[l.a, l.b], [l.b, l.a]] as const) {
      if (reason === 'left' && by === p) continue
      if (this.g.world.players.get(p.id) !== p) continue
      const name = (by ?? partner).name
      p.send(message ? { t: 'tradeEnd', reason, name, message } : { t: 'tradeEnd', reason, name })
    }
    this.g.config.log(`trade ${l.s.id}: ${l.a.name} / ${l.b.name} ended (${reason}${by ? ` by ${by.name}` : ''})`)
  }

  /**
   * Ends the pending request to `to`: the requester and the invitee each get `tradeEnd {reason, name: the other}`,
   * unless their trade window is open (or `toRequester` / `toInvitee` is false).
   */
  private endRequest(to: number, reason: TradeEndReason, opts: { toRequester?: boolean; toInvitee?: boolean } = {}): void {
    const r = this.requests.get(to)
    if (!r) return
    this.requests.delete(to)
    const from = opts.toRequester === false ? undefined : this.online(r.from)
    const invitee = opts.toInvitee === false ? undefined : this.online(r.to)
    if (from && !this.live.has(from.characterId)) from.send({ t: 'tradeEnd', reason, name: r.toName })
    if (invitee && !this.live.has(invitee.characterId)) invitee.send({ t: 'tradeEnd', reason, name: r.fromName })
  }
}
