/**
 * Lane NPC-C (docs/SHOPS.md §9 lane E): the client's storage copy, the bag <-> storage drag rules and gold amounts,
 * the cast bar's progress, the item cooldown keys, and the ?mock=1 storage, return-scroll cast and potion cooldown
 * round trips with every client frame checked by the shared validator.
 */
import { describe, expect, it } from 'vitest'
import { MAX_GOLD, parseClientMessage, type ClientMessage, type ItemStack } from '@sro/shared'
import { CooldownClock, itemCooldownKey } from '../src/hud/cooldowns.ts'
import { intent } from '../src/hud/intents.ts'
import { castProgress, formatSecondsLeft } from '../src/hud/item-cast.ts'
import { parseGold, StorageState, storageDropIntent, storageFee } from '../src/hud/storage-state.ts'
import { intents } from '../src/world/intents.ts'
import { mockWorld, of } from './npc-fixtures.ts'

const valid = (m: ClientMessage | null): ClientMessage => {
  expect(m).not.toBeNull()
  const r = parseClientMessage(JSON.stringify(m))
  expect(r.ok, r.ok ? '' : r.error).toBe(true)
  return m!
}

function snapshot(size: number, filled: Record<number, ItemStack>, gold = 0) {
  return { size, slots: Array.from({ length: size }, (_, i) => filled[i] ?? null), gold }
}

describe('StorageState', () => {
  it('applies a snapshot and updates idempotently', () => {
    const st = new StorageState()
    expect(st.known).toBe(false)
    const c = st.setSnapshot(snapshot(150, { 0: { code: 'HERB', count: 5 }, 7: { code: 'SWORD', count: 1, plus: 2 } }, 1000))
    expect(c.snapshot).toBe(true)
    expect(st.known).toBe(true)
    expect(st.size).toBe(150)
    expect(st.used).toBe(2)
    expect(st.gold).toBe(1000)
    expect(st.item(7)).toEqual({ code: 'SWORD', count: 1, plus: 2 })
    const u = { slots: [{ slot: 0, item: { code: 'HERB', count: 9 } }, { slot: 3, item: { code: 'ARROW', count: 250 } }], gold: 400 }
    expect(st.apply(u)).toEqual({ slots: [0, 3], gold: true, snapshot: false })
    expect(st.apply(u)).toEqual({ slots: [], gold: false, snapshot: false })
    expect(st.apply({ slots: [{ slot: 0, item: null }] }).slots).toEqual([0])
    expect(st.item(0)).toBeNull()
    expect(st.used).toBe(2)
  })

  it('ignores slots outside the size and malformed stacks; clamps the size to 180', () => {
    const st = new StorageState()
    st.setSnapshot(snapshot(3, {}))
    expect(st.apply({ slots: [{ slot: 3, item: { code: 'X', count: 1 } }, { slot: 1, item: { code: 'X', count: 0 } as ItemStack }] }).slots).toEqual([])
    st.setSnapshot({ size: 999, slots: [], gold: 0 })
    expect(st.size).toBe(180)
    st.clear()
    expect(st.known).toBe(false)
    expect(st.size).toBe(0)
  })
})

describe('bag <-> storage drag rules (storageDropIntent)', () => {
  const st = new StorageState()
  st.setSnapshot(snapshot(150, { 0: { code: 'HERB', count: 10 }, 1: { code: 'SWORD', count: 1 } }))
  const bagSlots: (ItemStack | null)[] = [{ code: 'HERB', count: 5 }, { code: 'RING', count: 1 }, null, { code: 'HERB', count: 3, plus: 1 }]
  const bag = { bagSize: 4, item: (i: number) => bagSlots[i] ?? null }
  const defs: Record<string, { maxStack: number }> = { HERB: { maxStack: 50 }, SWORD: { maxStack: 1 }, RING: { maxStack: 1 } }
  const def = (c: string) => defs[c]
  const npc = 42

  it('bag -> storage deposits, into the dropped slot only when it is empty or merges', () => {
    expect(valid(storageDropIntent(npc, st, bag, { kind: 'bag', slot: 0 }, { kind: 'storage', slot: 0 }, def))).toEqual({ t: 'storageDeposit', npc, bag: 0, to: 0 })
    expect(valid(storageDropIntent(npc, st, bag, { kind: 'bag', slot: 1 }, { kind: 'storage', slot: 5 }, def))).toEqual({ t: 'storageDeposit', npc, bag: 1, to: 5 })
    // A different item there: the server picks the slot.
    expect(valid(storageDropIntent(npc, st, bag, { kind: 'bag', slot: 1 }, { kind: 'storage', slot: 1 }, def))).toEqual({ t: 'storageDeposit', npc, bag: 1 })
    // Dropped on the window, with a count.
    expect(valid(storageDropIntent(npc, st, bag, { kind: 'bag', slot: 0 }, { kind: 'storage', slot: -1 }, def, 2))).toEqual({ t: 'storageDeposit', npc, bag: 0, count: 2 })
    expect(storageDropIntent(npc, st, bag, { kind: 'bag', slot: 2 }, { kind: 'storage', slot: 3 }, def)).toBeNull()
    expect(storageDropIntent(npc, st, bag, { kind: 'bag', slot: 0 }, { kind: 'bag', slot: 2 }, def)).toBeNull()
  })

  it('storage -> bag withdraws; storage -> storage moves', () => {
    expect(valid(storageDropIntent(npc, st, bag, { kind: 'storage', slot: 0 }, { kind: 'bag', slot: 2 }, def))).toEqual({ t: 'storageWithdraw', npc, slot: 0, bag: 2 })
    expect(valid(storageDropIntent(npc, st, bag, { kind: 'storage', slot: 0 }, { kind: 'bag', slot: 0 }, def))).toEqual({ t: 'storageWithdraw', npc, slot: 0, bag: 0 })
    // A +1 stack does not merge; a ring is not the sword.
    expect(valid(storageDropIntent(npc, st, bag, { kind: 'storage', slot: 0 }, { kind: 'bag', slot: 3 }, def))).toEqual({ t: 'storageWithdraw', npc, slot: 0 })
    expect(valid(storageDropIntent(npc, st, bag, { kind: 'storage', slot: 1 }, { kind: 'bag', slot: -1 }, def, 1))).toEqual({ t: 'storageWithdraw', npc, slot: 1, count: 1 })
    expect(valid(storageDropIntent(npc, st, bag, { kind: 'storage', slot: 1 }, { kind: 'storage', slot: 149 }, def))).toEqual({ t: 'storageMove', npc, from: 1, to: 149 })
    expect(storageDropIntent(npc, st, bag, { kind: 'storage', slot: 1 }, { kind: 'storage', slot: 1 }, def)).toBeNull()
    expect(storageDropIntent(npc, st, bag, { kind: 'storage', slot: 9 }, { kind: 'bag', slot: 2 }, def)).toBeNull()
  })

  it('bounds gold amounts and computes the fee', () => {
    expect(parseGold('1,500', 2000)).toBe(1500)
    expect(parseGold(' 2000 ', 2000)).toBe(2000)
    expect(parseGold('2001', 2000)).toBeNull()
    expect(parseGold('0', 2000)).toBeNull()
    expect(parseGold('-5', 2000)).toBeNull()
    expect(parseGold('1.5', 2000)).toBeNull()
    expect(parseGold('abc', 2000)).toBeNull()
    expect(parseGold(String(MAX_GOLD), Number.MAX_SAFE_INTEGER)).toBe(MAX_GOLD)
    expect(parseGold(String(MAX_GOLD + 1), Number.MAX_SAFE_INTEGER)).toBeNull()
    valid(intent.storageGold(1, 'deposit', parseGold('1,000', 5000)!))
    expect(storageFee({ keepFee: 21 }, 3)).toBe(63)
    expect(storageFee(undefined, 3)).toBe(0)
  })
})

describe('cast bar and item cooldowns', () => {
  it('reports progress and the seconds left', () => {
    expect(castProgress(1000, 30_000, 1000)).toEqual({ fraction: 0, secondsLeft: 30 })
    expect(castProgress(1000, 30_000, 16_000)).toEqual({ fraction: 0.5, secondsLeft: 15 })
    expect(castProgress(1000, 30_000, 99_000)).toEqual({ fraction: 1, secondsLeft: 0 })
    expect(castProgress(0, 0, 5)).toEqual({ fraction: 1, secondsLeft: 0 })
    expect(formatSecondsLeft(29.2)).toBe('30 s')
    expect(formatSecondsLeft(4.21)).toBe('4.3 s')
  })

  it('arms item:<group> on the shared clock from itemCooldown', () => {
    let now = 100
    const clock = new CooldownClock(() => now)
    const seen: string[] = []
    clock.onChange(k => void seen.push(k))
    clock.setIn(itemCooldownKey('hp'), 1000, 1000)
    expect(seen).toEqual(['item:hp'])
    expect(clock.remaining('item:hp')).toBe(1000)
    now = 1100
    expect(clock.remaining('item:hp')).toBe(0)
  })
})

describe('?mock=1 storage, return scroll and potion cooldown (net/mock/npc.ts)', () => {
  it('opens the storage, deposits and withdraws items and gold', async () => {
    const w = await mockWorld('Keeper')
    await w.send(intents.npcTalk(w.npc.id))
    const open = await w.send(intent.storageOpen(w.npc.id))
    expect(of(open, 'actionResult')[0]?.ok).toBe(true)
    const snap = of(open, 'storage')[0]!.storage
    expect(snap.size).toBe(150)
    expect(snap.slots).toHaveLength(150)
    const st = new StorageState()
    st.setSnapshot(snap)

    // Buy two herbs, deposit one of them into slot 4.
    const buy = await w.send(intent.shopBuy(w.npc.id, 'ITEM_ETC_HP_POTION_01', 2))
    const bought = of(buy, 'inventoryUpdate')[0]!.bag![0]!
    const bagSlot = bought.slot
    const dep = await w.send(intent.storageDeposit(w.npc.id, bagSlot, 1, 4))
    expect(of(dep, 'actionResult')[0]?.ok).toBe(true)
    expect(of(dep, 'inventoryUpdate')[0]!.bag).toEqual([{ slot: bagSlot, item: { code: 'ITEM_ETC_HP_POTION_01', count: bought.item!.count - 1 } }])
    expect(st.apply(of(dep, 'storageUpdate')[0]!).slots).toEqual([4])
    expect(st.item(4)).toEqual({ code: 'ITEM_ETC_HP_POTION_01', count: 1 })

    const mv = await w.send(intent.storageMove(w.npc.id, 4, 10))
    st.apply(of(mv, 'storageUpdate')[0]!)
    expect(st.item(10)?.code).toBe('ITEM_ETC_HP_POTION_01')
    const wd = await w.send(intent.storageWithdraw(w.npc.id, 10))
    expect(of(wd, 'actionResult')[0]?.ok).toBe(true)
    st.apply(of(wd, 'storageUpdate')[0]!)
    expect(st.used).toBe(0)

    const gold = await w.send(intent.storageGold(w.npc.id, 'deposit', 50))
    expect(of(gold, 'actionResult')[0]?.ok).toBe(true)
    expect(st.apply(of(gold, 'storageUpdate')[0]!).gold).toBe(true)
    expect(st.gold).toBe(50)
    const tooMuch = await w.send(intent.storageGold(w.npc.id, 'withdraw', 51))
    expect(of(tooMuch, 'actionResult')[0]).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    const empty = await w.send(intent.storageWithdraw(w.npc.id, 149))
    expect(of(empty, 'actionResult')[0]).toMatchObject({ ok: false, reason: 'invalid_slot' })
    w.close()
  })

  it('casts a return scroll: itemCast, consumed only at the end, itemCastEnd done; moving interrupts', async () => {
    const w = await mockWorld('Returner')
    const me = w.enter.self.id
    await w.send(intents.npcTalk(w.npc.id))
    const buy = await w.send(intent.shopBuy(w.npc.id, 'ITEM_ETC_SCROLL_RETURN_01', 2))
    expect(of(buy, 'actionResult')[0]?.ok).toBe(true)
    const scrolls = of(buy, 'inventoryUpdate')[0]!.bag![0]!
    const slot = scrolls.slot

    // Interrupted by a move: nothing consumed.
    const use1 = await w.send(intent.itemUse(slot))
    const cast = of(use1, 'itemCast')[0]!
    expect(cast).toMatchObject({ id: me, item: 'ITEM_ETC_SCROLL_RETURN_01' })
    expect(of(use1, 'inventoryUpdate')).toEqual([])
    const busy = await w.send(intent.itemUse(slot))
    expect(of(busy, 'actionResult')[0]).toMatchObject({ ok: false, reason: 'busy' })
    const moved = await w.send(intents.moveTo(w.enter.self.pos[0] + 5, w.enter.self.pos[2]))
    expect(of(moved, 'itemCastEnd')[0]).toMatchObject({ id: me, reason: 'interrupted' })

    // Completed: one scroll consumed, done, then the dialog closes for the warp.
    await w.step(3000)
    await w.send(intents.stopAction())
    const use2 = await w.send(intent.itemUse(slot))
    expect(of(use2, 'actionResult')[0]?.ok).toBe(true)
    const from = w.log.length
    await w.step(cast.castMs + 300)
    const after = w.log.slice(from)
    expect(of(after, 'inventoryUpdate')[0]!.bag).toEqual([{ slot, item: { code: 'ITEM_ETC_SCROLL_RETURN_01', count: scrolls.item!.count - 1 } }])
    expect(of(after, 'itemCastEnd')[0]).toMatchObject({ id: me, reason: 'done' })
    w.close()
  })

  it('reports a potion cooldown with itemCooldown', async () => {
    const w = await mockWorld('Drinker')
    await w.send(intents.npcTalk(w.npc.id))
    const buy = await w.send(intent.shopBuy(w.npc.id, 'ITEM_ETC_HP_POTION_01', 2))
    const slot = of(buy, 'inventoryUpdate')[0]!.bag![0]!.slot
    const use = await w.send(intent.itemUse(slot))
    expect(of(use, 'actionResult')[0]?.ok).toBe(true)
    const cd = of(use, 'itemCooldown')[0]!
    expect(cd.readyInMs).toBeGreaterThan(0)
    expect(cd.totalMs).toBe(cd.readyInMs)
    expect(use.findIndex(m => m.t === 'actionResult')).toBeLessThan(use.findIndex(m => m.t === 'itemCooldown'))
    w.close()
  })
})
