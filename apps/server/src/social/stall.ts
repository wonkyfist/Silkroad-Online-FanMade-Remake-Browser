import {
  GUILD_REQUESTS,
  STALL_BREAK_RANGE,
  STALL_GREETING_MAX,
  STALL_NPC_CLEARANCE,
  STALL_RANGE,
  STALL_REQUESTS,
  STALL_SPACING,
  STALL_TITLE_MAX,
  STALL_VISITORS_MAX,
  type GameplayRequest,
  type StallEndReason,
} from '@sro/shared'
import { knob } from '../config.ts'
import { cleanChat } from '../connection.ts'
import { REGEN } from '../formulas.ts'
import type { Gameplay } from '../gameplay.ts'
import { fail, type Fail } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from '../modules.ts'
import type { Player } from '../world.ts'
import { logSocial, pairTx } from './pair-tx.ts'
import { buyDrafts, defaultGreeting, defaultTitle, hasListings, list, newStall, stallView, unlist, type Stall } from './stall-rules.ts'

/**
 * Stalls (docs/SYSTEMS_SOCIAL.md §4; docs/WAVE_PLAN2.md §6.5 ST-S). Runtime only: a stall closes on logout, death,
 * warp or restart, and nothing about it is stored but the `social_log` row of each sale.
 *
 * - Create (§4.1): town safe area (`STALL_TOWN_ONLY`), clear of NPCs (3 m) and other stalls (1.5 m), alive, not
 *   casting, no stall already, and no combat within the last 5 s (D29 `in_combat`). The owner is halted, its action,
 *   item cast and NPC dialog end, and its viewers get `entityUpdate {stall: title}` (the decorator carries the title to
 *   late joiners).
 * - The owner edits listings in 'modify' only and sells in 'open' only; the texts change in either state.
 * - Visitors (at most 8, within 10 m; a visit ends beyond 15 m, on the visitor's death or warp, or when the stall
 *   closes) get the full `stall` view after every change; the owner's view carries each listing's bag slot.
 * - A purchase buys the whole listing in one `pairTx` over both characters, with the code, count and price the buyer
 *   saw (`stall_changed` otherwise), then logs to `social_log`.
 * - The gate (§2.3, the stall row of WAVE_PLAN2 §6.5) is an allowlist: while a stall exists, every other request of
 *   the owner, and its moveTo, is refused `stalling`. Visitors are not locked.
 */

/** Requests a stall owner may still send (besides the stall requests, which the gate never sees). */
const STALL_ALLOWED: ReadonlySet<GameplayRequest | 'moveTo'> = new Set<GameplayRequest | 'moveTo'>([
  'stopAction', 'hotbarSet', 'statUp', 'skillLearn', 'masteryUp', 'buffCancel',
  'partyInvite', 'partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings',
  ...GUILD_REQUESTS.filter((t) => t !== 'guildCreate'),
  'mountDismiss',
])

/** How often visitor distances are checked. */
const VISIT_CHECK_MS = 500

const codePoints = (s: string) => [...s].length

export class StallService implements GameplayModule {
  readonly name = 'stalls'
  readonly handles: readonly GameplayRequest[] = STALL_REQUESTS
  readonly whileDead: readonly GameplayRequest[] = ['stallClose', 'stallLeave']

  /** Owner entity id -> its stall. */
  readonly stalls = new Map<number, Stall>()
  /** Visitor entity id -> the owner entity id of the stall it visits. */
  readonly visiting = new Map<number, number>()
  private lastVisitCheck = -Infinity

  constructor(readonly g: Gameplay) {
    // EntityState.stall (§4.2): late joiners and worldEnter see the sign.
    g.world.decorators.push((e, s) => {
      if (e.kind !== 'player') return
      const st = this.stalls.get(e.id)
      if (st) s.stall = st.title
    })
  }

  // ---- queries -------------------------------------------------------------------------------------------

  /** The stall `p` owns, if any. */
  stallOf(p: Player): Stall | undefined {
    return this.stalls.get(p.id)
  }

  /** The owner entity id of the stall `p` visits, or null. */
  visitOf(p: Player): number | null {
    return this.visiting.get(p.id) ?? null
  }

  // ---- gate ----------------------------------------------------------------------------------------------

  gate(p: Player, t: GameplayRequest | 'moveTo', _now: number): Fail | null {
    if (!this.stalls.has(p.id) || STALL_ALLOWED.has(t)) return null
    return fail('stalling', 'Close your stall first.')
  }

  // ---- requests ------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'stallCreate':
        return this.create(p, msg.title, answer, now)
      case 'stallItem':
        return this.item(p, msg.slot, msg.bag, msg.count, msg.price, answer)
      case 'stallItemRemove':
        return this.edit(p, answer, (s) => unlist(s, msg.slot))
      case 'stallText':
        return this.text(p, msg.title, msg.greeting, answer)
      case 'stallOpen':
        return this.setOpen(p, msg.open, answer)
      case 'stallClose': {
        const s = this.stalls.get(p.id)
        if (!s) return answer(fail('not_found', 'You have no stall.'))
        answer(true)
        return this.close(s, 'closed')
      }
      case 'stallVisit':
        return this.visit(p, msg.owner, answer, now)
      case 'stallLeave': {
        if (!this.visiting.has(p.id)) return answer(fail('not_found'))
        answer(true)
        return this.leave(p, 'left')
      }
      case 'stallBuy':
        return this.buy(p, msg, answer, now)
    }
    answer(fail('not_found'))
  }

  private create(p: Player, rawTitle: string, answer: Answer, now: number): void {
    if (this.stalls.has(p.id)) return answer(fail('stalling', 'You already have a stall.'))
    if (now - p.lastCombatAt < REGEN.outOfCombatMs) return answer(fail('in_combat', 'You cannot use the stall during the battle.'))
    if (this.g.itemUses.skillBusy(p, now) || this.g.skills.held(p, now)) return answer(fail('busy', 'casting'))
    const title = cleanChat(rawTitle)
    if (codePoints(title) > STALL_TITLE_MAX) return answer(fail('invalid_count', 'That title is too long.'))
    const [x, , z] = this.g.world.positionAt(p, now)
    const where = this.placeProblem(p, x, z, now)
    if (where) return answer(fail('wrong_place', where))
    answer(true)
    // The owner stops where it is: no walk, no auto-attack, no cast, no NPC dialog (npcClose is locked by the gate).
    p.action = null
    this.g.world.halt(p, now)
    this.g.itemUses.cancel(p, 'interrupted')
    this.g.npcs.closeFor(p, 'closed')
    this.g.posture.standUp(p)
    if (this.visiting.has(p.id)) this.leave(p, 'left')
    const s = newStall(p.id, p.characterId, p.name, title, now)
    this.stalls.set(p.id, s)
    p.send({ t: 'stall', stall: stallView(s, p.name, true) })
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, stall: s.title })
  }

  /** Why a stall cannot open at x/z (a `wrong_place` message), or null. */
  private placeProblem(p: Player, x: number, z: number, now: number): string | null {
    if (knob(this.g.config, 'stallTownOnly') === 1 && !this.g.data.inSafeArea(this.g.config.world, x, z)) return 'Stalls can only be opened in town.'
    for (const npc of this.g.world.npcs.values()) {
      if (Math.hypot(npc.pos[0] - x, npc.pos[2] - z) <= STALL_NPC_CLEARANCE) return `Too close to ${npc.name}.`
    }
    for (const owner of this.stalls.keys()) {
      const q = this.g.world.players.get(owner)
      if (!q || q.id === p.id) continue
      const [qx, , qz] = this.g.world.positionAt(q, now)
      if (Math.hypot(qx - x, qz - z) <= STALL_SPACING) return 'Too close to another stall.'
    }
    return null
  }

  private item(p: Player, slot: number, bag: number, count: number, price: number, answer: Answer): void {
    const s = this.stalls.get(p.id)
    if (!s) return answer(fail('not_found', 'You have no stall.'))
    const inv = this.g.store.loadInventory(p.characterId)
    const code = bag >= 0 && bag < inv.bagSize ? inv.bag[bag]?.code : undefined
    const r = list(s, inv, slot, bag, count, price, code ? this.g.data.item(code) : undefined)
    if (!r.ok) return answer(r)
    answer(true)
    this.push(s)
  }

  /** Runs a listing change on the own stall and sends the new view. */
  private edit(p: Player, answer: Answer, fn: (s: Stall) => ReturnType<typeof unlist>): void {
    const s = this.stalls.get(p.id)
    if (!s) return answer(fail('not_found', 'You have no stall.'))
    const r = fn(s)
    if (!r.ok) return answer(r)
    answer(true)
    this.push(s)
  }

  private text(p: Player, rawTitle: string | undefined, rawGreeting: string | undefined, answer: Answer): void {
    const s = this.stalls.get(p.id)
    if (!s) return answer(fail('not_found', 'You have no stall.'))
    const title = rawTitle === undefined ? undefined : cleanChat(rawTitle) || defaultTitle(p.name)
    const greeting = rawGreeting === undefined ? undefined : cleanChat(rawGreeting) || defaultGreeting(p.name)
    if ((title !== undefined && codePoints(title) > STALL_TITLE_MAX) || (greeting !== undefined && codePoints(greeting) > STALL_GREETING_MAX)) {
      return answer(fail('invalid_count', 'That text is too long.'))
    }
    answer(true)
    const titleChanged = title !== undefined && title !== s.title
    if (title !== undefined) s.title = title
    if (greeting !== undefined) s.greeting = greeting
    this.push(s)
    if (titleChanged) this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, stall: s.title })
  }

  private setOpen(p: Player, open: boolean, answer: Answer): void {
    const s = this.stalls.get(p.id)
    if (!s) return answer(fail('not_found', 'You have no stall.'))
    if (open && !hasListings(s)) return answer(fail('not_complete', 'Cannot open a new shop without the registered goods.'))
    answer(true)
    const next = open ? 'open' : 'modify'
    if (s.state === next) return
    s.state = next
    this.push(s)
  }

  private visit(p: Player, ownerId: number, answer: Answer, now: number): void {
    if (ownerId === p.id) return answer(fail('invalid_target', 'That is your own stall.'))
    const owner = this.g.world.players.get(ownerId)
    const s = owner ? this.stalls.get(owner.id) : undefined
    if (!owner || !s || !p.known.has(owner.id) || !this.g.world.canSee(p, owner)) return answer(fail('not_found'))
    if (this.stalls.has(p.id)) return answer(fail('stalling', 'Close your stall first.'))
    if (this.g.world.distance(p, owner, now) > STALL_RANGE) return answer(fail('too_far'))
    const already = this.visiting.get(p.id) === owner.id
    if (!already && s.visitors.size >= STALL_VISITORS_MAX) return answer(fail('stall_full', 'The member limit(8) has been reached.'))
    answer(true)
    if (already) return p.send({ t: 'stall', stall: stallView(s, owner.name, false) })
    // One stall at a time: a new visit leaves the old one (its owner and visitors see the count drop).
    if (this.visiting.has(p.id)) this.drop(p)
    s.visitors.add(p.id)
    this.visiting.set(p.id, owner.id)
    this.push(s)
  }

  private buy(p: Player, msg: Extract<GameplayMessage, { t: 'stallBuy' }>, answer: Answer, now: number): void {
    const { owner: ownerId, slot } = msg
    if (ownerId === p.id) return answer(fail('invalid_target', 'That is your own stall.'))
    const owner = this.g.world.players.get(ownerId)
    const s = owner ? this.stalls.get(owner.id) : undefined
    if (!owner || !s || !p.known.has(owner.id) || !this.g.world.canSee(p, owner)) return answer(fail('not_found'))
    if (this.stalls.has(p.id)) return answer(fail('stalling', 'Close your stall first.'))
    if (s.state !== 'open') return answer(fail('stall_closed', 'The shop is under construction.'))
    const l = Number.isInteger(slot) && slot >= 0 && slot < s.items.length ? s.items[slot] : null
    if (!l) return answer(fail('not_found', 'That item was already sold.'))
    // S1 / D47: the exact item the buyer saw (a Modify can swap a +5 for a +0 or a broken copy at the same code, count
    // and price). ItemStack convention: an absent plus is 0, an absent durability is full (null).
    const same = l.code === msg.code && l.count === msg.count && l.plus === (msg.plus ?? 0) && l.durability === (msg.durability ?? null)
    if (!same || l.price !== msg.price) return answer(fail('stall_changed', 'The listing changed. Check the price again.'))
    if (this.g.world.distance(p, owner, now) > STALL_RANGE) return answer(fail('too_far'))
    const def = this.g.data.item(l.code)
    if (!def) return answer(fail('not_usable', 'The selected item cannot be traded.'))
    // social_log (§7): a = the buyer, who gave the gold; b = the owner, who gave the item. Same transaction as the sale.
    const { result, da, db } = pairTx(this.g.store, p.characterId, owner.characterId, (dBuyer, dOwner) => buyDrafts(l, dBuyer, dOwner, def), (got) =>
      logSocial(this.g.store, { kind: 'stall', aChar: p.characterId, bChar: owner.characterId, aGold: l.price, bGold: 0, aItems: [], bItems: [got] }, Math.round(now)),
    )
    if (!result.ok) {
      answer(result)
      // The owner's bag no longer holds the snapshot (a change outside the requests): the listing is gone for good.
      if (result.reason === 'stall_changed' && s.items[slot] === l) {
        s.items[slot] = null
        this.push(s)
      }
      return
    }
    s.items[slot] = null
    answer(true)
    this.g.afterInventory(p, da)
    this.g.afterInventory(owner, db)
    const got = result.value
    owner.send({ t: 'stallSold', slot, buyer: p.name, code: got.code, count: got.count, price: l.price })
    owner.send({ t: 'chat', channel: 'system', text: `${p.name} bought item ${itemLabel(def.name ?? def.code, got.plus, got.count)}.` })
    this.push(s)
  }

  // ---- state changes -------------------------------------------------------------------------------------

  /** Sends the current view to the owner (with bag slots) and to every visitor. */
  private push(s: Stall): void {
    const owner = this.g.world.players.get(s.owner)
    const name = owner?.name ?? ''
    owner?.send({ t: 'stall', stall: stallView(s, name, true) })
    const view = stallView(s, name, false)
    for (const id of s.visitors) this.g.world.players.get(id)?.send({ t: 'stall', stall: view })
  }

  /** Closes stall `s`: visitors get `stall null` with `reason`, the owner `stall null`, viewers `entityUpdate stall ''`. */
  close(s: Stall, reason: StallEndReason): void {
    if (this.stalls.get(s.owner) !== s) return
    this.stalls.delete(s.owner)
    for (const id of s.visitors) {
      this.visiting.delete(id)
      this.g.world.players.get(id)?.send({ t: 'stall', stall: null, reason })
    }
    s.visitors.clear()
    const owner = this.g.world.players.get(s.owner)
    if (!owner) return
    owner.send({ t: 'stall', stall: null, reason: 'closed' })
    this.g.world.broadcastAbout(owner, { t: 'entityUpdate', id: owner.id, stall: '' })
  }

  /** Ends `p`'s visit: it gets `stall null` with `reason`. */
  private leave(p: Player, reason: StallEndReason): void {
    if (this.drop(p)) p.send({ t: 'stall', stall: null, reason })
  }

  /** Removes `p` from the stall it visits (the owner and the other visitors see the count drop). */
  private drop(p: Player | { id: number }): boolean {
    const ownerId = this.visiting.get(p.id)
    if (ownerId === undefined) return false
    this.visiting.delete(p.id)
    const s = this.stalls.get(ownerId)
    if (s && s.visitors.delete(p.id)) this.push(s)
    return true
  }

  // ---- hooks ---------------------------------------------------------------------------------------------

  /** Visitors farther than STALL_BREAK_RANGE (or no longer allowed to see the owner) leave. */
  tick(now: number): void {
    if (now >= this.lastVisitCheck && now - this.lastVisitCheck < VISIT_CHECK_MS) return
    this.lastVisitCheck = now
    for (const [visitorId, ownerId] of [...this.visiting]) {
      const v = this.g.world.players.get(visitorId)
      const owner = this.g.world.players.get(ownerId)
      if (!v) {
        this.drop({ id: visitorId })
        continue
      }
      if (!owner || !this.stalls.has(ownerId)) {
        this.visiting.delete(visitorId)
        v.send({ t: 'stall', stall: null, reason: 'closed' })
        continue
      }
      if (!this.g.world.canSee(v, owner)) this.leave(v, 'closed')
      else if (this.g.world.distance(v, owner, now) > STALL_BREAK_RANGE) this.leave(v, 'too_far')
    }
  }

  playerDied(p: Player): void {
    this.endFor(p, 'closed')
  }

  warped(p: Player, _reason: WarpReason): void {
    this.endFor(p, 'closed')
  }

  forget(p: Player): void {
    const s = this.stalls.get(p.id)
    if (s) this.close(s, 'left')
    this.drop(p)
  }

  /** `p` died or warped: its stall closes, and its visit ends ('left'). */
  private endFor(p: Player, reason: StallEndReason): void {
    const s = this.stalls.get(p.id)
    if (s) this.close(s, reason)
    this.leave(p, 'left')
  }

  // ---- chat ----------------------------------------------------------------------------------------------

  /**
   * Stall chat (P2): `text` (cleaned) from `p` to the stall it owns or visits: the owner and every visitor. False when
   * it has none (chat.ts then answers `error bad_request`).
   */
  chat(p: Player, text: string): boolean {
    const s = this.stalls.get(p.id) ?? this.stalls.get(this.visiting.get(p.id) ?? -1)
    if (!s) return false
    const line = { t: 'chat', channel: 'stall', fromId: p.id, from: p.name, text } as const
    this.g.world.players.get(s.owner)?.send(line)
    for (const id of s.visitors) this.g.world.players.get(id)?.send(line)
    return true
  }
}

/** "Blade (+3)" or "HP Potion x5" for the owner's sale line. */
function itemLabel(name: string, plus: number, count: number): string {
  return `${name}${plus > 0 ? ` (+${plus})` : ''}${count > 1 ? ` x${count}` : ''}`
}
