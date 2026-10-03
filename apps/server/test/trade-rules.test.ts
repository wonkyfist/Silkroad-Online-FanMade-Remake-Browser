/**
 * Exchange rules, pure (docs/SYSTEMS_SOCIAL.md §3.3, §3.5, §10.5; lane TR-S): every §3.3 row (offer bounds, one offer
 * per bag slot, the lock freezes, a partner change clears the lock, accept only when both are locked, the empty
 * trade), D50 (`canTrade`) and the commit over two drafts: plain swap, stack merge, +N and durability kept (D47), slots
 * freed by the own offer, `inventory_full` naming the side, strict `gold_limit` on the net amount, and a snapshot
 * mismatch failing with both drafts untouched.
 */
import { MAX_GOLD, TRADE_SLOTS, type ItemDef } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { InvDraft, type InvItem, type InvState } from '../src/inventory.ts'
import {
  ITEM_CHANGED,
  accept,
  commitDrafts,
  freeSlots,
  isEmpty,
  lock,
  newSession,
  offer,
  offerIntact,
  otherSide,
  setGold,
  sideOf,
  take,
  type TradeSession,
} from '../src/social/trade-rules.ts'
import { item } from './fixtures.ts'

const POTION = item('ITEM_ETC_HP_POTION_01', { category: 'potion', maxStack: 50 })
const BLADE = item('ITEM_CH_BLADE_02_A', { category: 'weapon', slot: 'weapon', weaponType: 'blade' })
const STARTER = item('ITEM_CH_SWORD_01_A_DEF', { category: 'weapon', slot: 'weapon', weaponType: 'sword', canTrade: false })
const DEFS = new Map<string, ItemDef>([POTION, BLADE, STARTER].map((d) => [d.code, d]))
const defs = (code: string) => DEFS.get(code)

const it_ = (code: string, count = 1, plus = 0, durability: number | null = null): InvItem => ({ code, count, plus, durability })

function inv(bagSize: number, items: Record<number, InvItem>, gold = 0): InvState {
  const bag: (InvItem | null)[] = Array.from({ length: bagSize }, (_, i) => items[i] ?? null)
  return { bagSize, bag, equip: {}, gold }
}

const A = 11
const B = 22
const session = (): TradeSession => newSession(1, A, B, 0)

describe('session basics', () => {
  it('a fresh session: 12 empty slots per side, nothing locked', () => {
    const s = session()
    expect(s.a).toEqual({ characterId: A, items: Array(TRADE_SLOTS).fill(null), gold: 0, locked: false, accepted: false })
    expect(s.b.characterId).toBe(B)
    expect(sideOf(s, A)).toBe('a')
    expect(sideOf(s, B)).toBe('b')
    expect(sideOf(s, 99)).toBeNull()
    expect(otherSide('a')).toBe('b')
    expect(isEmpty(s)).toBe(true)
    expect(freeSlots(inv(4, { 1: it_('X') }))).toBe(3)
  })
})

describe('offer', () => {
  const bag = inv(8, { 0: it_(POTION.code, 30), 1: it_(BLADE.code, 1, 5, 40), 2: it_(STARTER.code) }, 1000)

  it('snapshots the bag slot (code, count, plus, durability) into the first empty trade slot', () => {
    const s = session()
    expect(offer(s, 'a', bag, 1, undefined, BLADE, 10)).toEqual({ ok: true, value: 'changed' })
    expect(offer(s, 'a', bag, 0, 12, POTION, 10)).toEqual({ ok: true, value: 'changed' })
    expect(s.a.items[0]).toEqual({ bag: 1, code: BLADE.code, count: 1, plus: 5, durability: 40 })
    expect(s.a.items[1]).toEqual({ bag: 0, code: POTION.code, count: 12, plus: 0, durability: null })
    // The whole stack by default.
    const t = session()
    offer(t, 'b', bag, 0, undefined, POTION, 10)
    expect(t.b.items[0]!.count).toBe(30)
  })

  it('invalid_slot: empty, out of range, or already offered (one offer per bag slot, T3)', () => {
    const s = session()
    expect(offer(s, 'a', bag, 5, undefined, POTION, 10)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(offer(s, 'a', bag, 8, undefined, POTION, 10)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(offer(s, 'a', bag, -1, undefined, POTION, 10)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(offer(s, 'a', bag, 0, 10, POTION, 10).ok).toBe(true)
    expect(offer(s, 'a', bag, 0, 10, POTION, 10)).toMatchObject({ ok: false, reason: 'invalid_slot' })
  })

  it('invalid_count: 1 <= count <= the stack', () => {
    const s = session()
    for (const n of [0, 31, 1.5, -2]) expect(offer(s, 'a', bag, 0, n, POTION, 10), String(n)).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(offer(s, 'a', bag, 0, 30, POTION, 10).ok).toBe(true)
  })

  it('D50: canTrade false and a missing def answer not_usable', () => {
    const s = session()
    expect(offer(s, 'a', bag, 2, undefined, STARTER, 10)).toEqual({ ok: false, reason: 'not_usable', message: 'The selected item cannot be traded.' })
    expect(offer(s, 'a', bag, 0, undefined, undefined, 10)).toMatchObject({ ok: false, reason: 'not_usable' })
    // A def that is not the slot's item is refused too (a caller bug must not offer the wrong thing).
    expect(offer(s, 'a', bag, 0, undefined, BLADE, 10)).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(isEmpty(s)).toBe(true)
  })

  it('inventory_full: all 12 trade slots taken', () => {
    const many = inv(20, Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i, it_(POTION.code, 1)])))
    const s = session()
    for (let i = 0; i < TRADE_SLOTS; i++) expect(offer(s, 'a', many, i, undefined, POTION, 99).ok).toBe(true)
    expect(offer(s, 'a', many, 12, undefined, POTION, 99)).toEqual({ ok: false, reason: 'inventory_full', message: 'Cannot add the selected item because the exchange window is full.' })
  })

  it("inventory_full: the partner's soft check (free + partner's offered stacks, one stack of lead)", () => {
    const s = session()
    expect(offer(s, 'a', bag, 0, 1, POTION, 0).ok).toBe(true)
    expect(offer(s, 'a', bag, 1, undefined, BLADE, 0)).toMatchObject({ ok: false, reason: 'inventory_full', message: expect.stringContaining("other player's inventory is full") })
    // The partner's own offer frees a slot for what it receives.
    const partner = inv(4, { 0: it_(POTION.code, 5) })
    expect(offer(s, 'b', partner, 0, undefined, POTION, 10).ok).toBe(true)
    expect(offer(s, 'a', bag, 1, undefined, BLADE, 0).ok).toBe(true)
  })

  it('trading: a locked side cannot change its offer', () => {
    const s = session()
    lock(s, 'a')
    expect(offer(s, 'a', bag, 0, 1, POTION, 10)).toEqual({ ok: false, reason: 'trading', message: 'Your offer is locked.' })
    expect(take(s, 'a', 0)).toMatchObject({ ok: false, reason: 'trading' })
    expect(setGold(s, 'a', bag, 5)).toMatchObject({ ok: false, reason: 'trading' })
  })
})

describe('take and gold', () => {
  const bag = inv(8, { 0: it_(POTION.code, 30) }, 500)

  it('take: invalid_slot when empty or out of range; frees the slot', () => {
    const s = session()
    expect(take(s, 'a', 0)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(take(s, 'a', TRADE_SLOTS)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    offer(s, 'a', bag, 0, 3, POTION, 10)
    expect(take(s, 'a', 0)).toEqual({ ok: true, value: 'changed' })
    expect(s.a.items[0]).toBeNull()
    // The slot can be offered again.
    expect(offer(s, 'a', bag, 0, 3, POTION, 10).ok).toBe(true)
  })

  it('gold sets (not adds); more than held -> not_enough_gold; the same amount is a no-op; 0 clears', () => {
    const s = session()
    expect(setGold(s, 'a', bag, 501)).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(setGold(s, 'a', bag, -1)).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(setGold(s, 'a', bag, 200)).toEqual({ ok: true, value: 'changed' })
    expect(setGold(s, 'a', bag, 300)).toEqual({ ok: true, value: 'changed' })
    expect(s.a.gold).toBe(300)
    lock(s, 'b')
    expect(setGold(s, 'a', bag, 300)).toEqual({ ok: true, value: 'noop' })
    expect(s.b.locked).toBe(true)
    expect(setGold(s, 'a', bag, 0)).toEqual({ ok: true, value: 'changed' })
    expect(s.a.gold).toBe(0)
  })
})

describe('lock, accept and the anti-bait rule', () => {
  const bagA = inv(8, { 0: it_(BLADE.code, 1, 5), 1: it_(BLADE.code, 1, 0) }, 500)

  it('any change by one side clears the other side lock and accept (T1)', () => {
    const s = session()
    offer(s, 'b', bagA, 0, undefined, BLADE, 10)
    lock(s, 'a')
    lock(s, 'b')
    expect(accept(s, 'a')).toEqual({ ok: true, value: 'changed' })
    expect(s.a).toMatchObject({ locked: true, accepted: true })
    // b cannot change while locked; unlocked, b swaps the +5 blade for the +0 one.
    const t = session()
    offer(t, 'b', bagA, 0, undefined, BLADE, 10)
    lock(t, 'a')
    expect(offer(t, 'b', bagA, 1, undefined, BLADE, 10).ok).toBe(true)
    expect(t.a.locked).toBe(false)
    expect(take(t, 'b', 0).ok).toBe(true)
    lock(t, 'a')
    expect(setGold(t, 'b', bagA, 10).ok).toBe(true)
    expect(t.a).toMatchObject({ locked: false, accepted: false })
  })

  it('lock twice -> trading; accept before both locks -> not_complete; an empty trade -> not_usable (T9, T14)', () => {
    const s = session()
    expect(accept(s, 'a')).toMatchObject({ ok: false, reason: 'not_complete' })
    expect(lock(s, 'a')).toEqual({ ok: true, value: 'changed' })
    expect(lock(s, 'a')).toEqual({ ok: false, reason: 'trading', message: 'Already locked.' })
    expect(accept(s, 'a')).toMatchObject({ ok: false, reason: 'not_complete' })
    lock(s, 'b')
    expect(accept(s, 'a')).toEqual({ ok: false, reason: 'not_usable', message: 'There is nothing to trade.' })
  })

  it("'commit' only when both accepted; a repeated accept is a no-op", () => {
    const s = session()
    setGold(s, 'a', bagA, 100)
    lock(s, 'a')
    lock(s, 'b')
    expect(accept(s, 'b')).toEqual({ ok: true, value: 'changed' })
    expect(accept(s, 'b')).toEqual({ ok: true, value: 'noop' })
    expect(accept(s, 'a')).toEqual({ ok: true, value: 'commit' })
  })
})

/** Two drafts and a session with both offers locked. */
function deal(a: InvState, b: InvState, fill: (s: TradeSession) => void) {
  const s = session()
  fill(s)
  return { s, da: new InvDraft(a), db: new InvDraft(b) }
}

describe('commitDrafts', () => {
  it('plain swap: items and gold change hands; each side gets the other side’s offer', () => {
    const a = inv(4, { 0: it_(BLADE.code, 1, 3, 20) }, 1000)
    const b = inv(4, { 2: it_(POTION.code, 30) }, 50)
    const { s, da, db } = deal(a, b, (s) => {
      offer(s, 'a', a, 0, undefined, BLADE, 3)
      setGold(s, 'a', a, 400)
      offer(s, 'b', b, 2, 10, POTION, 3)
    })
    const r = commitDrafts(s, da, db, defs, { a: 'Ann', b: 'Bob' })
    expect(r).toEqual({ ok: true, value: { aGot: [it_(POTION.code, 10)], bGot: [it_(BLADE.code, 1, 3, 20)] } })
    expect(da.bag).toEqual([it_(POTION.code, 10), null, null, null])
    expect(da.gold).toBe(600)
    // The +3 blade keeps its plus and its durability (D47); the rest of b's potions stay.
    expect(db.bag).toEqual([it_(BLADE.code, 1, 3, 20), null, it_(POTION.code, 20), null])
    expect(db.gold).toBe(450)
  })

  it('stackables merge into the receiver’s stacks', () => {
    const a = inv(4, { 0: it_(POTION.code, 30) })
    const b = inv(4, { 1: it_(POTION.code, 45) })
    const { s, da, db } = deal(a, b, (s) => offer(s, 'a', a, 0, 20, POTION, 3))
    expect(commitDrafts(s, da, db, defs).ok).toBe(true)
    expect(db.bag).toEqual([it_(POTION.code, 15), it_(POTION.code, 50), null, null])
    expect(da.bag[0]).toEqual(it_(POTION.code, 10))
  })

  it('slots freed by the own offer count for what comes in (both bags full)', () => {
    const a = inv(2, { 0: it_(BLADE.code, 1, 1), 1: it_(BLADE.code, 1, 2) })
    const b = inv(2, { 0: it_(POTION.code, 5), 1: it_(POTION.code, 6) })
    const { s, da, db } = deal(a, b, (s) => {
      // Both bags are full: a side may lead by one stack, so either can offer first.
      expect(offer(s, 'a', a, 1, undefined, BLADE, 0).ok).toBe(true)
      expect(offer(s, 'a', a, 0, undefined, BLADE, 0)).toMatchObject({ ok: false, reason: 'inventory_full' })
      expect(offer(s, 'b', b, 0, undefined, POTION, 0).ok).toBe(true)
    })
    expect(commitDrafts(s, da, db, defs).ok).toBe(true)
    expect(da.bag).toEqual([it_(BLADE.code, 1, 1), it_(POTION.code, 5)])
    expect(db.bag).toEqual([it_(BLADE.code, 1, 2), it_(POTION.code, 6)])
  })

  it('inventory_full names the receiving side', () => {
    const a = inv(2, { 0: it_(BLADE.code, 1, 1), 1: it_(BLADE.code, 1, 2) })
    const b = inv(1, { 0: it_(POTION.code, 5) })
    const { s, da, db } = deal(a, b, (s) => {
      // Offered with a stale partner count (the soft check is only a warning).
      offer(s, 'a', a, 0, undefined, BLADE, 5)
      offer(s, 'a', a, 1, undefined, BLADE, 5)
    })
    expect(commitDrafts(s, da, db, defs, { a: 'Ann', b: 'Bob' })).toEqual({ ok: false, reason: 'inventory_full', message: "Cannot exchange because [Bob]'s inventory is full." })
  })

  it('gold_limit: strict on the net amount, naming the side (T6); only the net counts', () => {
    const a = inv(2, {}, 100)
    const b = inv(2, {}, MAX_GOLD - 50)
    const over = deal(a, b, (s) => setGold(s, 'a', a, 51))
    expect(commitDrafts(over.s, over.da, over.db, defs, { a: 'Ann', b: 'Bob' })).toEqual({ ok: false, reason: 'gold_limit', message: 'Bob cannot hold more gold.' })
    // b gives 1,000 back: the net is -949 for b, which fits.
    const net = deal(a, inv(2, {}, MAX_GOLD - 50), (s) => {
      setGold(s, 'a', a, 51)
      setGold(s, 'b', inv(2, {}, MAX_GOLD - 50), 100)
    })
    expect(commitDrafts(net.s, net.da, net.db, defs).ok).toBe(true)
    expect(net.db.gold).toBe(MAX_GOLD - 50 - 49)
    expect(net.da.gold).toBe(149)
  })

  it('a snapshot mismatch (code, plus, durability, fewer items) fails with both drafts untouched (T2, T8)', () => {
    const a = inv(4, { 0: it_(BLADE.code, 1, 5, 40), 1: it_(POTION.code, 30) }, 10)
    const b = inv(4, { 0: it_(POTION.code, 3) }, 10)
    const changes: [string, InvState][] = [
      ['plus', inv(4, { 0: it_(BLADE.code, 1, 0, 40), 1: it_(POTION.code, 30) }, 10)],
      ['durability', inv(4, { 0: it_(BLADE.code, 1, 5, 39), 1: it_(POTION.code, 30) }, 10)],
      ['code', inv(4, { 0: it_(POTION.code, 1), 1: it_(POTION.code, 30) }, 10)],
      ['gone', inv(4, { 1: it_(POTION.code, 30) }, 10)],
      ['fewer', inv(4, { 0: it_(BLADE.code, 1, 5, 40), 1: it_(POTION.code, 9) }, 10)],
    ]
    for (const [what, now] of changes) {
      const s = session()
      offer(s, 'a', a, 0, undefined, BLADE, 5)
      offer(s, 'a', a, 1, 10, POTION, 5)
      offer(s, 'b', b, 0, undefined, POTION, 5)
      const da = new InvDraft(now)
      const db = new InvDraft(b)
      expect(commitDrafts(s, da, db, defs), what).toEqual({ ok: false, reason: 'not_found', message: ITEM_CHANGED })
      expect(da.changed, what).toBe(false)
      expect(db.changed, what).toBe(false)
    }
  })

  it('a stack that grew since the offer still trades exactly the offered count', () => {
    const a = inv(4, { 0: it_(POTION.code, 10) })
    const s = session()
    offer(s, 'a', a, 0, 10, POTION, 5)
    const grown = inv(4, { 0: it_(POTION.code, 25) })
    expect(offerIntact(new InvDraft(grown), s.a.items[0]!)).toBe(true)
    const da = new InvDraft(grown)
    const db = new InvDraft(inv(4, {}))
    expect(commitDrafts(s, da, db, defs).ok).toBe(true)
    expect(da.bag[0]).toEqual(it_(POTION.code, 15))
    expect(db.bag[0]).toEqual(it_(POTION.code, 10))
  })

  it('offered gold spent elsewhere -> not_enough_gold (T7)', () => {
    const a = inv(2, {}, 500)
    const { s, db } = deal(a, inv(2, {}), (s) => setGold(s, 'a', a, 400))
    const da = new InvDraft(inv(2, {}, 300))
    expect(commitDrafts(s, da, db, defs, { a: 'Ann', b: 'Bob' })).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(da.changed).toBe(false)
  })
})
