import { TRADE_SLOTS, type ItemDef } from '@sro/shared'
import { addGold, done, fail, putBack, takeFromBag, type Defs, type InvDraft, type InvItem, type InvState, type Result } from '../inventory.ts'

/**
 * Exchange rules, pure (docs/SYSTEMS_SOCIAL.md §3.2, §3.3, §3.5; lane TR-S). The module (trade.ts) owns the players,
 * the range checks and the messages; these functions own the two offers and the commit over two inventory drafts.
 *
 * - One offer per bag slot (T3); a locked side cannot change its own offer; any accepted change by one side clears the
 *   other side's lock and accept (the anti-bait rule, T1), so once both are locked neither offer can change.
 * - `accept` answers 'commit' when both sides accepted; `commitDrafts` runs inside pairTx and re-checks every offer
 *   against its snapshot (code, plus, durability, and at least the offered count; D47) before anything moves.
 */

/** One offered stack: a snapshot of the bag slot when offered (the commit re-checks code, count, plus, durability; D47). */
export interface TradeOffer {
  bag: number
  code: string
  count: number
  plus: number
  durability: number | null
}

export interface TradeSideState {
  characterId: number
  /** length TRADE_SLOTS */
  items: (TradeOffer | null)[]
  gold: number
  locked: boolean
  accepted: boolean
}

export interface TradeSession {
  id: number
  /** a = the requester, b = the accepter. */
  a: TradeSideState
  b: TradeSideState
  openedAt: number
}

export type TradeStep = Result<'changed' | 'commit' | 'noop'>

export type TradeSideKey = 'a' | 'b'

export const otherSide = (side: TradeSideKey): TradeSideKey => (side === 'a' ? 'b' : 'a')

function newSide(characterId: number): TradeSideState {
  return { characterId, items: Array.from({ length: TRADE_SLOTS }, () => null), gold: 0, locked: false, accepted: false }
}

/** A fresh session: `a` requested, `b` accepted. */
export function newSession(id: number, a: number, b: number, now: number): TradeSession {
  return { id, a: newSide(a), b: newSide(b), openedAt: now }
}

/** Which side a character is on, or null. */
export function sideOf(s: TradeSession, characterId: number): TradeSideKey | null {
  return s.a.characterId === characterId ? 'a' : s.b.characterId === characterId ? 'b' : null
}

/** Offered stacks of one side. */
export function offered(side: TradeSideState): TradeOffer[] {
  return side.items.filter((o): o is TradeOffer => o !== null)
}

/** Whether both sides offer nothing (no items and no gold). */
export function isEmpty(s: TradeSession): boolean {
  return s.a.gold === 0 && s.b.gold === 0 && offered(s.a).length === 0 && offered(s.b).length === 0
}

/** An accepted change by `side`: the other side must lock (and accept) again (anti-bait, T1). */
function changedBy(s: TradeSession, side: TradeSideKey): TradeStep {
  const o = s[otherSide(side)]
  o.locked = false
  o.accepted = false
  s[side].accepted = false
  return done('changed')
}

const LOCKED = 'Your offer is locked.'

/** Free bag slots of an inventory. */
export function freeSlots(inv: InvState): number {
  let n = 0
  for (let i = 0; i < inv.bagSize; i++) if (!inv.bag[i]) n++
  return n
}

/**
 * `tradeOffer {bag, count?}`: puts `count` (default: the whole stack) of bag slot `bag` into the first empty trade
 * slot. `def` is the item's definition (undefined when unknown: refused); `partnerFree` the partner's free bag slots
 * (the early warning; the commit decides).
 */
export function offer(s: TradeSession, side: TradeSideKey, inv: InvState, bag: number, count: number | undefined, def: ItemDef | undefined, partnerFree: number): TradeStep {
  const me = s[side]
  if (me.locked) return fail('trading', LOCKED)
  if (!Number.isInteger(bag) || bag < 0 || bag >= inv.bagSize) return fail('invalid_slot')
  const it = inv.bag[bag]
  if (!it) return fail('invalid_slot', 'That slot is empty.')
  if (me.items.some((o) => o?.bag === bag)) return fail('invalid_slot', 'That item is already in the exchange.')
  const n = count ?? it.count
  if (!Number.isInteger(n) || n < 1 || n > it.count) return fail('invalid_count')
  // D50: a missing def refuses too.
  if (!def || def.code !== it.code || def.canTrade === false) return fail('not_usable', 'The selected item cannot be traded.')
  const slot = me.items.indexOf(null)
  if (slot < 0) return fail('inventory_full', 'Cannot add the selected item because the exchange window is full.')
  // The early warning (§3.3): the partner's free slots plus the slots its own offer frees must hold this side's
  // stacks. One stack of lead is allowed, or two full bags could never start a one-for-one swap (neither side could
  // offer first); the commit decides with the exact bags.
  const partnerStacks = offered(s[otherSide(side)]).length
  if (offered(me).length + 1 > partnerFree + partnerStacks + 1) {
    return fail('inventory_full', "Cannot add the selected item to the exchange window because the other player's inventory is full.")
  }
  me.items[slot] = { bag, code: it.code, count: n, plus: it.plus, durability: it.durability }
  return changedBy(s, side)
}

/** `tradeTake {slot}`: takes one of your own trade slots back. */
export function take(s: TradeSession, side: TradeSideKey, slot: number): TradeStep {
  const me = s[side]
  if (me.locked) return fail('trading', LOCKED)
  if (!Number.isInteger(slot) || slot < 0 || slot >= TRADE_SLOTS || !me.items[slot]) return fail('invalid_slot')
  me.items[slot] = null
  return changedBy(s, side)
}

/** `tradeGold {amount}`: sets (not adds) the offered gold; 0 clears it. The same amount again is a no-op. */
export function setGold(s: TradeSession, side: TradeSideKey, inv: InvState, amount: number): TradeStep {
  const me = s[side]
  if (me.locked) return fail('trading', LOCKED)
  if (!Number.isInteger(amount) || amount < 0) return fail('invalid_count')
  if (amount > inv.gold) return fail('not_enough_gold')
  if (amount === me.gold) return done('noop')
  me.gold = amount
  return changedBy(s, side)
}

/** `tradeLock`: freezes your own offer (the module checks the range first). */
export function lock(s: TradeSession, side: TradeSideKey): TradeStep {
  const me = s[side]
  if (me.locked) return fail('trading', 'Already locked.')
  me.locked = true
  return done('changed')
}

/** `tradeAccept`: needs both sides locked and something to trade; 'commit' when both sides accepted. */
export function accept(s: TradeSession, side: TradeSideKey): TradeStep {
  if (!s.a.locked || !s.b.locked) return fail('not_complete', 'Both sides must confirm first.')
  if (isEmpty(s)) return fail('not_usable', 'There is nothing to trade.')
  const me = s[side]
  if (me.accepted) return done('noop')
  me.accepted = true
  return done(s.a.accepted && s.b.accepted ? 'commit' : 'changed')
}

/** Display names for the commit's failure messages (defaults: 'the other player'). */
export interface TradeNames {
  a: string
  b: string
}

export const ITEM_CHANGED = 'An item in the exchange changed.'

/** The snapshot check of one offer against the draft (D47): same code, plus, durability and at least the offered count. */
export function offerIntact(d: InvDraft, o: TradeOffer): boolean {
  const it = d.inBag(o.bag) ? d.bag[o.bag] : null
  return !!it && it.code === o.code && it.plus === o.plus && it.durability === o.durability && it.count >= o.count
}

/**
 * Moves both offers between the two drafts (inside pairTx); what each side received (`aGot` = what b gave).
 *
 * 1. Every offer of both sides is checked against its snapshot before anything changes (a mismatch leaves both drafts
 *    untouched), then taken out of its bag.
 * 2. Gold: each side must still hold its offered gold; each side's net change is added strictly (`gold_limit`, T6).
 * 3. The items go into the other bag (putBack: stackables merge, anything else keeps its plus and durability). Slots
 *    freed by a side's own offer count for what it receives.
 */
export function commitDrafts(s: TradeSession, da: InvDraft, db: InvDraft, defs: Defs, names: TradeNames = { a: 'the other player', b: 'the other player' }): Result<{ aGot: InvItem[]; bGot: InvItem[] }> {
  const offersA = offered(s.a)
  const offersB = offered(s.b)
  for (const o of offersA) if (!offerIntact(da, o)) return fail('not_found', ITEM_CHANGED)
  for (const o of offersB) if (!offerIntact(db, o)) return fail('not_found', ITEM_CHANGED)
  if (da.gold < s.a.gold) return fail('not_enough_gold', `${names.a} no longer has the offered gold.`)
  if (db.gold < s.b.gold) return fail('not_enough_gold', `${names.b} no longer has the offered gold.`)
  const fromA: InvItem[] = []
  const fromB: InvItem[] = []
  for (const o of offersA) {
    const r = takeFromBag(da, o.bag, o.count)
    if (!r.ok) return fail('not_found', ITEM_CHANGED)
    fromA.push(r.value)
  }
  for (const o of offersB) {
    const r = takeFromBag(db, o.bag, o.count)
    if (!r.ok) return fail('not_found', ITEM_CHANGED)
    fromB.push(r.value)
  }
  const netA = s.b.gold - s.a.gold
  if (netA !== 0) {
    const ga = addGold(da, netA, { strict: true })
    if (!ga.ok) return ga.reason === 'gold_limit' ? fail('gold_limit', `${names.a} cannot hold more gold.`) : ga
    const gb = addGold(db, -netA, { strict: true })
    if (!gb.ok) return gb.reason === 'gold_limit' ? fail('gold_limit', `${names.b} cannot hold more gold.`) : gb
  }
  const give = (d: InvDraft, items: InvItem[], receiver: string): Result<undefined> => {
    for (const it of items) {
      const def = defs(it.code)
      if (!def) return fail('not_found', ITEM_CHANGED)
      const r = putBack(d, def, it)
      if (!r.ok) return r.reason === 'inventory_full' ? fail('inventory_full', `Cannot exchange because [${receiver}]'s inventory is full.`) : r
    }
    return done(undefined)
  }
  const gaveB = give(db, fromA, names.b)
  if (!gaveB.ok) return gaveB
  const gaveA = give(da, fromB, names.a)
  if (!gaveA.ok) return gaveA
  return done({ aGot: fromB, bGot: fromA })
}
