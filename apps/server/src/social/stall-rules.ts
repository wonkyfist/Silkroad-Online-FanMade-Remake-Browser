import { STALL_PRICE_MAX, STALL_SLOTS, type ItemDef, type StallListing, type StallView } from '@sro/shared'
import { addGold, done, fail, putBack, takeFromBag, toStack, type InvDraft, type InvItem, type InvState, type Result } from '../inventory.ts'

/**
 * Stall rules, pure (docs/SYSTEMS_SOCIAL.md §4.1, §4.4, §4.5; lane ST-S): the runtime state of one stall, listing a
 * bag slot, the purchase inside `pairTx`, and the views the owner and the visitors get.
 *
 * A listing is a snapshot of the owner's bag slot (code, count, plus, durability; D47). Nothing moves when a stall
 * opens: the owner's bag is locked by the stall gate (stall.ts), and the purchase re-checks the snapshot against the
 * bag inside the transaction (defence in depth for changes that do not come from requests, e.g. a GM `item`).
 */

/** One listing: a snapshot of the bag slot when listed (the purchase re-checks it; D47). */
export interface Listing {
  bag: number
  code: string
  count: number
  plus: number
  durability: number | null
  price: number
}

export interface Stall {
  /** Owner entity id and character id. */
  owner: number
  characterId: number
  title: string
  greeting: string
  state: 'modify' | 'open'
  /** length STALL_SLOTS */
  items: (Listing | null)[]
  /** Visitor entity ids. */
  visitors: Set<number>
  openedAt: number
}

/** Retail default title "[%s]'s stall." (`UIIT_STT_STALL_DEFAULT_TITLE`). */
export const defaultTitle = (name: string): string => `${name}'s stall.`
/** Retail default greeting "Welcome to [%s]'s stall.". */
export const defaultGreeting = (name: string): string => `Welcome to ${name}'s stall.`

/** A new stall in 'modify' state with no listings. */
export function newStall(owner: number, characterId: number, name: string, title: string, now: number): Stall {
  return {
    owner,
    characterId,
    title: title || defaultTitle(name),
    greeting: defaultGreeting(name),
    state: 'modify',
    items: Array.from({ length: STALL_SLOTS }, () => null),
    visitors: new Set(),
    openedAt: now,
  }
}

const validSlot = (slot: number) => Number.isInteger(slot) && slot >= 0 && slot < STALL_SLOTS

/** Whether any listing of `s` exists. */
export function hasListings(s: Stall): boolean {
  return s.items.some((l) => l !== null)
}

/**
 * Lists `count` of bag slot `bag` in stall slot `slot` for `price` (replacing what the slot held). Only in 'modify'
 * (`stalling`); `invalid_slot` for a bad stall slot, an empty or out-of-range bag slot, or a bag slot already listed in
 * another stall slot; `invalid_count` for a count above the stack or a price outside 1..STALL_PRICE_MAX; `not_usable`
 * for an item that cannot be traded (or has no definition; D50).
 */
export function list(s: Stall, inv: InvState, slot: number, bag: number, count: number, price: number, def: ItemDef | undefined): Result<undefined> {
  if (s.state !== 'modify') return fail('stalling', 'Switch to Modify first.')
  if (!validSlot(slot)) return fail('invalid_slot')
  if (!Number.isInteger(bag) || bag < 0 || bag >= inv.bagSize) return fail('invalid_slot')
  const it = inv.bag[bag]
  if (!it) return fail('invalid_slot', 'That slot is empty.')
  if (s.items.some((l, i) => l !== null && i !== slot && l.bag === bag)) return fail('invalid_slot', 'That item is already listed.')
  if (!Number.isInteger(count) || count < 1 || count > it.count) return fail('invalid_count')
  if (!def || def.code !== it.code || def.canTrade === false) return fail('not_usable', 'The selected item cannot be traded.')
  if (!Number.isInteger(price) || price < 1 || price > STALL_PRICE_MAX) return fail('invalid_count', 'Can set the value only from 1 to 1 billion gold.')
  s.items[slot] = { bag, code: it.code, count, plus: it.plus, durability: it.durability, price }
  return done(undefined)
}

/** Removes listing `slot` (only in 'modify'; an empty slot is `invalid_slot`). */
export function unlist(s: Stall, slot: number): Result<undefined> {
  if (s.state !== 'modify') return fail('stalling', 'Switch to Modify first.')
  if (!validSlot(slot) || !s.items[slot]) return fail('invalid_slot')
  s.items[slot] = null
  return done(undefined)
}

/**
 * The purchase inside pairTx (never name a draft `do`, a reserved word): the item the buyer received.
 * 1. the owner's bag slot must still hold the snapshot (code, plus, durability) with at least `count`, else
 *    `stall_changed`; 2. the buyer pays (`not_enough_gold`); 3. the owner is paid, strictly (`gold_limit`);
 * 4. the item moves (`inventory_full` on the buyer's side). A failure leaves the caller's transaction unwritten.
 */
export function buyDrafts(l: Listing, buyer: InvDraft, owner: InvDraft, def: ItemDef): Result<InvItem> {
  const it = owner.inBag(l.bag) ? owner.bag[l.bag] : null
  if (!it || it.code !== l.code || it.plus !== l.plus || it.durability !== l.durability || it.count < l.count || def.code !== l.code) {
    return fail('stall_changed', 'The item in the stall changed.')
  }
  const paid = addGold(buyer, -l.price)
  if (!paid.ok) return fail('not_enough_gold', 'Cannot buy due to insufficient gold.')
  const earned = addGold(owner, l.price, { strict: true })
  if (!earned.ok) return fail('gold_limit', 'The seller cannot hold more gold.')
  const taken = takeFromBag(owner, l.bag, l.count)
  if (!taken.ok) return fail('stall_changed', 'The item in the stall changed.')
  const put = putBack(buyer, def, taken.value)
  if (!put.ok) return fail('inventory_full', 'Cannot buy due to insufficient space in your inventory.')
  return done(taken.value)
}

/** The listing as the wire shows it; `bag` only in the owner's own view. */
export function listingView(l: Listing, owner: boolean): StallListing {
  const out: StallListing = { stack: toStack(l), price: l.price }
  if (owner) out.bag = l.bag
  return out
}

/** The full StallView for the owner (`owner` true: listings carry `bag`) or a visitor. */
export function stallView(s: Stall, name: string, owner: boolean): StallView {
  return {
    owner: s.owner,
    name,
    title: s.title,
    greeting: s.greeting,
    state: s.state,
    items: s.items.map((l) => (l ? listingView(l, owner) : null)),
    visitors: s.visitors.size,
  }
}
