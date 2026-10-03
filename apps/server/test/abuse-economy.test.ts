/**
 * Adversarial exploit hunt, lens = ECONOMY (wave 3): gold and item creation, quantities, MAX_GOLD, shops and buyback,
 * account storage, consumables and the return-scroll cast, loot ownership and full bags. Each test is one attack; a
 * passing test is an attack the code refused. The last block is a client drag rule (storage-state.ts) that the
 * server refuses, so a plain drop fails instead of landing.
 *
 * Runs on the synthetic NPC world (npc-harness.ts) and, where it matters, on the real Jangan content (work/out).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ITEM_OWNER_MS, MAX_GOLD, NPC_INTERACT_RANGE, parseClientMessage, type ItemDef, type ShopDef } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import { storageDropIntent, StorageState } from '../../game/src/hud/storage-state.ts'
import { RETURN_03, npcHarness, type NpcHarness } from './npc-harness.ts'

const HERB = 'ITEM_ETC_HP_POTION_01'
const OUT = join(REPO_ROOT, 'work/out')
const HAVE_REAL = ['items.json', 'npcs.json', 'shops.json'].every((f) => existsSync(join(OUT, 'data', f)))

const open: NpcHarness[] = []
afterEach(() => {
  while (open.length) open.pop()!.close()
})
function harness(opts: Parameters<typeof npcHarness>[0] = {}): NpcHarness {
  const h = npcHarness(opts)
  open.push(h)
  return h
}

/** Leaves the world the way connection.ts leaveWorld does, then enters the same character again. */
function relog(h: NpcHarness, who: ReturnType<NpcHarness['enter']>) {
  const row = h.store.characterById(who.p.characterId)!
  h.gameplay.forget(who.p)
  h.world.remove(who.p.id)
  const inbox = who.inbox
  inbox.length = 0
  const p = h.world.add({ ...h.gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos: [...who.p.pos], yaw: 0, send: (m) => inbox.push(m) })
  h.world.snapshotFor(p, h.now())
  return { p, inbox }
}

describe('economy: wire quantities never reach the rules', () => {
  it('zero, negative, fractional, huge, NaN-like and string counts/amounts/slots are bad frames', () => {
    const bad = [
      { t: 'shopBuy', npc: 1, item: HERB, count: 0 },
      { t: 'shopBuy', npc: 1, item: HERB, count: -5 },
      { t: 'shopBuy', npc: 1, item: HERB, count: 1.5 },
      { t: 'shopBuy', npc: 1, item: HERB, count: 1e9 },
      { t: 'shopBuy', npc: 1, item: HERB, count: '10' },
      { t: 'shopSell', npc: 1, bag: 0, count: 0 },
      { t: 'shopSell', npc: 1, bag: -1 },
      { t: 'shopSell', npc: 1, bag: 0.5 },
      { t: 'shopBuyback', npc: 1, index: -1 },
      { t: 'shopBuyback', npc: 1, index: 5 },
      { t: 'storageGold', npc: 1, dir: 'deposit', amount: 0 },
      { t: 'storageGold', npc: 1, dir: 'deposit', amount: -1000 },
      { t: 'storageGold', npc: 1, dir: 'withdraw', amount: MAX_GOLD + 1 },
      { t: 'storageGold', npc: 1, dir: 'withdraw', amount: 10.5 },
      { t: 'storageGold', npc: 1, dir: 'steal', amount: 10 },
      { t: 'storageDeposit', npc: 1, bag: 0, count: -1 },
      { t: 'storageDeposit', npc: 1, bag: 0, to: 180 },
      { t: 'storageWithdraw', npc: 1, slot: 0, count: 1.25 },
      { t: 'itemDrop', bag: 0, count: 0 },
      { t: 'itemSplit', from: 0, to: 1, count: -1 },
      { t: 'itemUse', bag: -1 },
      { t: 'statUp', stat: 'str', points: -3 },
    ]
    for (const m of bad) expect(parseClientMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(false)
  })
})

describe('economy: shops and buyback', () => {
  it('a sale -> buyback -> sale loop is gold-neutral and never creates items', () => {
    const h = harness()
    const potion = h.npcByCode('NPC_CH_POTION')
    const me = h.enter([potion.pos[0] + 2, 0, potion.pos[2]], 1000)
    h.give(me.p, HERB, 50)
    const gold0 = me.p.gold
    for (let i = 0; i < 10; i++) {
      expect(h.req(me.p, me.inbox, { t: 'shopSell', npc: potion.id, bag: 0 }).ok).toBe(true)
      expect(h.req(me.p, me.inbox, { t: 'shopBuyback', npc: potion.id, index: 0 }).ok).toBe(true)
    }
    expect(me.p.gold).toBe(gold0)
    expect(h.countOf(me.p, HERB)).toBe(50)
  })

  it('buyback does not survive leaving the world: after a relog the old sale cannot be bought back', () => {
    const h = harness()
    const potion = h.npcByCode('NPC_CH_POTION')
    const me = h.enter([potion.pos[0] + 2, 0, potion.pos[2]], 1000)
    h.give(me.p, HERB, 10)
    expect(h.req(me.p, me.inbox, { t: 'shopSell', npc: potion.id, bag: 0 }).ok).toBe(true)
    const again = relog(h, me)
    expect(h.req(again.p, again.inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.countOf(again.p, HERB)).toBe(0)
  })

  it('ECO-3: a buyback that names another item than the entry at its index buys nothing (a stale double press)', () => {
    const h = harness()
    const potion = h.npcByCode('NPC_CH_POTION')
    const me = h.enter([potion.pos[0] + 2, 0, potion.pos[2]], 1000)
    h.give(me.p, HERB, 10)
    h.give(me.p, 'ITEM_ETC_MP_POTION_01', 10)
    const bag = h.bag(me.p)
    const herb = bag.findIndex((i) => i?.code === HERB)
    const mp = bag.findIndex((i) => i?.code === 'ITEM_ETC_MP_POTION_01')
    expect(h.req(me.p, me.inbox, { t: 'shopSell', npc: potion.id, bag: herb }).ok).toBe(true)
    expect(h.req(me.p, me.inbox, { t: 'shopSell', npc: potion.id, bag: mp }).ok).toBe(true)
    // The list is [herbs, mp potions]. Two presses on the herbs, both sent before the new list arrived.
    expect(h.req(me.p, me.inbox, { t: 'shopBuyback', npc: potion.id, index: 0, code: HERB }).ok).toBe(true)
    const gold = me.p.gold
    expect(h.req(me.p, me.inbox, { t: 'shopBuyback', npc: potion.id, index: 0, code: HERB })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(me.p.gold).toBe(gold)
    expect(h.countOf(me.p, 'ITEM_ETC_MP_POTION_01')).toBe(0)
    // Named correctly, the mp potions come back.
    expect(h.req(me.p, me.inbox, { t: 'shopBuyback', npc: potion.id, index: 0, code: 'ITEM_ETC_MP_POTION_01' }).ok).toBe(true)
    expect(h.countOf(me.p, 'ITEM_ETC_MP_POTION_01')).toBe(10)
    expect(parseClientMessage(JSON.stringify({ t: 'shopBuyback', npc: 1, index: 0, code: 'bad code!' })).ok).toBe(false)
  })

  it("another character cannot buy back someone else's sale", () => {
    const h = harness()
    const potion = h.npcByCode('NPC_CH_POTION')
    const a = h.enter([potion.pos[0] + 2, 0, potion.pos[2]], 1000)
    const b = h.enter([potion.pos[0] - 2, 0, potion.pos[2]], 100_000)
    h.give(a.p, HERB, 10)
    expect(h.req(a.p, a.inbox, { t: 'shopSell', npc: potion.id, bag: 0 }).ok).toBe(true)
    expect(h.req(b.p, b.inbox, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('selling at MAX_GOLD fails gold_limit and keeps the item; buying one past the gold fails and keeps the gold', () => {
    const h = harness()
    const potion = h.npcByCode('NPC_CH_POTION')
    const me = h.enter([potion.pos[0] + 2, 0, potion.pos[2]], MAX_GOLD)
    h.give(me.p, HERB, 1)
    expect(h.req(me.p, me.inbox, { t: 'shopSell', npc: potion.id, bag: 0 })).toMatchObject({ ok: false, reason: 'gold_limit' })
    expect(h.countOf(me.p, HERB)).toBe(1)
    h.setGold(me.p, 19)
    expect(h.req(me.p, me.inbox, { t: 'shopBuy', npc: potion.id, item: HERB, count: 1 })).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(h.store.loadInventory(me.p.characterId).gold).toBe(19)
  })

  it('shops cannot be used from past 8 m, even while the dialog is still open', () => {
    const h = harness()
    const potion = h.npcByCode('NPC_CH_POTION')
    const me = h.enter([potion.pos[0] + NPC_INTERACT_RANGE + 0.05, 0, potion.pos[2]], 1000)
    expect(h.req(me.p, me.inbox, { t: 'shopBuy', npc: potion.id, item: HERB, count: 1 })).toMatchObject({ ok: false, reason: 'too_far' })
  })
})

describe.skipIf(!HAVE_REAL)('economy: the real Jangan price and shop data', () => {
  const items = new Map((JSON.parse(readFileSync(join(OUT, 'data/items.json'), 'utf8')) as { entries: ItemDef[] }).entries.map((i) => [i.code, i]))
  const shops = (JSON.parse(readFileSync(join(OUT, 'data/shops.json'), 'utf8')) as { entries: ShopDef[] }).entries

  it('no shop good sells back for more than it costs (no buy/sell arbitrage), and none is free', () => {
    const arbitrage: string[] = []
    for (const s of shops) for (const t of s.tabs) for (const c of t.items) {
      const d = items.get(c)
      if (d && (d.price <= 0 || d.sellPrice > d.price)) arbitrage.push(`${s.id} ${c} buy ${d.price} sell ${d.sellPrice}`)
    }
    expect(arbitrage).toEqual([])
  })

  it('the level-21 goods stay unbuyable at cap 20 on the real shops', () => {
    const h = harness({ data: GameData.load(OUT) })
    const over = [...new Set(shops.flatMap((s) => s.tabs.flatMap((t) => t.items)))].filter((c) => (items.get(c)?.reqLevel ?? 0) > 20)
    expect(over.length).toBeGreaterThan(0)
    for (const code of over) {
      const npcCode = shops.find((s) => s.tabs.some((t) => t.items.includes(code)))!.npcs[0]!
      const npc = h.npcByCode(npcCode)
      const me = h.enter([npc.pos[0] + 2, 0, npc.pos[2]], 10_000_000)
      expect(h.req(me.p, me.inbox, { t: 'shopBuy', npc: npc.id, item: code, count: 1 }), code).toMatchObject({ ok: false, reason: 'not_found' })
    }
  })
})

describe('economy: storage', () => {
  it('deposit -> withdraw ping-pong between two characters of one account never creates items or gold', () => {
    const h = harness()
    const keeper = h.npcByCode('NPC_CH_WAREHOUSE_W')
    const a = h.enter([keeper.pos[0] + 2, 0, keeper.pos[2]], 5000)
    h.give(a.p, HERB, 50)
    const accountId = h.store.characterById(a.p.characterId)!.account_id
    const row = h.store.createCharacter(accountId, 'AltOfA', 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    for (let i = 0; i < 5; i++) {
      expect(h.req(a.p, a.inbox, { t: 'storageDeposit', npc: keeper.id, bag: h.bag(a.p).findIndex((x) => x?.code === HERB) }).ok).toBe(true)
      expect(h.req(a.p, a.inbox, { t: 'storageGold', npc: keeper.id, dir: 'deposit', amount: 100 }).ok).toBe(true)
      expect(h.req(a.p, a.inbox, { t: 'storageWithdraw', npc: keeper.id, slot: 0 }).ok).toBe(true)
      expect(h.req(a.p, a.inbox, { t: 'storageGold', npc: keeper.id, dir: 'withdraw', amount: 100 }).ok).toBe(true)
      // A second request on the now-empty slot and the drained gold is refused.
      expect(h.req(a.p, a.inbox, { t: 'storageWithdraw', npc: keeper.id, slot: 0 })).toMatchObject({ ok: false, reason: 'invalid_slot' })
      expect(h.req(a.p, a.inbox, { t: 'storageGold', npc: keeper.id, dir: 'withdraw', amount: 1 })).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    }
    expect(h.countOf(a.p, HERB)).toBe(50)
    // Only the deposit fees left the account (the harness herb has no keepFee: 0).
    expect(h.store.loadInventory(a.p.characterId).gold).toBe(5000)
  })

  it('storage cannot be used while dead or past 8 m', () => {
    const h = harness()
    const keeper = h.npcByCode('NPC_CH_WAREHOUSE_W')
    const far = h.enter([keeper.pos[0] + NPC_INTERACT_RANGE + 0.05, 0, keeper.pos[2]], 5000)
    expect(h.req(far.p, far.inbox, { t: 'storageGold', npc: keeper.id, dir: 'deposit', amount: 1 })).toMatchObject({ ok: false, reason: 'too_far' })
    const dead = h.enter([keeper.pos[0] + 1, 0, keeper.pos[2]], 5000)
    dead.p.dead = true
    expect(h.req(dead.p, dead.inbox, { t: 'storageGold', npc: keeper.id, dir: 'deposit', amount: 1 })).toMatchObject({ ok: false, reason: 'dead' })
  })
})

describe('economy: return scrolls and potions', () => {
  it('a dead player cannot start a return cast; a second use during a cast is busy', () => {
    const h = harness()
    const me = h.enter([200, 0, 200])
    h.give(me.p, RETURN_03.code, 2)
    me.p.dead = true
    expect(h.req(me.p, me.inbox, { t: 'itemUse', bag: h.bag(me.p).findIndex((x) => x?.code === RETURN_03.code) })).toMatchObject({ ok: false, reason: 'dead' })
    me.p.dead = false
    const at = h.bag(me.p).findIndex((x) => x?.code === RETURN_03.code)
    expect(h.req(me.p, me.inbox, { t: 'itemUse', bag: at }).ok).toBe(true)
    expect(h.req(me.p, me.inbox, { t: 'itemUse', bag: at })).toMatchObject({ ok: false, reason: 'busy' })
  })

  it('storing the last scroll mid-cast cancels the cast: no warp and the scroll is not also consumed', () => {
    const h = harness()
    const keeper = h.npcByCode('NPC_CH_WAREHOUSE_W')
    const me = h.enter([keeper.pos[0] + 2, 0, keeper.pos[2]], 1000)
    h.give(me.p, RETURN_03.code, 1)
    const at = h.bag(me.p).findIndex((x) => x?.code === RETURN_03.code)
    expect(h.req(me.p, me.inbox, { t: 'itemUse', bag: at }).ok).toBe(true)
    h.advance(1000)
    expect(h.req(me.p, me.inbox, { t: 'storageDeposit', npc: keeper.id, bag: at }).ok).toBe(true)
    const before = [...me.p.pos]
    h.advance(6000)
    expect(h.of(me.inbox, 'itemCastEnd').map((m) => m.reason)).toEqual(['cancelled'])
    expect(me.p.pos).toEqual(before)
    const stored = h.store.db.prepare('SELECT count FROM storage_items WHERE code = ?').get(RETURN_03.code) as { count: number } | undefined
    expect(stored?.count).toBe(1)
  })

  it('death mid-cast interrupts it: the corpse is not warped to town and the scroll is kept', () => {
    const h = harness()
    const me = h.enter([200, 0, 200])
    h.give(me.p, RETURN_03.code, 1)
    expect(h.req(me.p, me.inbox, { t: 'itemUse', bag: h.bag(me.p).findIndex((x) => x?.code === RETURN_03.code) }).ok).toBe(true)
    h.advance(1000)
    h.gameplay.gmKill(me.p, h.now())
    h.advance(6000)
    expect(me.p.dead).toBe(true)
    expect(Math.hypot(me.p.pos[0] - 200, me.p.pos[2] - 200)).toBeLessThan(1)
    expect(h.countOf(me.p, RETURN_03.code)).toBe(1)
  })

  it('a potion used at the cooldown edge is refused and not consumed', () => {
    const h = harness()
    const me = h.enter([200, 0, 200])
    h.give(me.p, HERB, 2)
    me.p.hp = 1
    expect(h.req(me.p, me.inbox, { t: 'itemUse', bag: 0 }).ok).toBe(true)
    h.advance(900)
    expect(h.req(me.p, me.inbox, { t: 'itemUse', bag: 0 })).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(h.countOf(me.p, HERB)).toBe(1)
  })

  it('equipment and gear have no use: itemUse is not_usable and nothing is consumed', () => {
    const h = harness()
    const me = h.enter([200, 0, 200])
    const at = h.give(me.p, 'ITEM_CH_BLADE_02_A')
    const before = h.bag(me.p)[at]
    expect(h.req(me.p, me.inbox, { t: 'itemUse', bag: at })).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(h.bag(me.p)[at]).toEqual(before)
  })
})

describe('economy: loot and full bags', () => {
  it("another character's loot is refused until ITEM_OWNER_MS, then anyone may take it", () => {
    const h = harness()
    const owner = h.enter([100, 0, 100])
    const thief = h.enter([101, 0, 100])
    const item = h.gameplay.spawnGroundItem(HERB, 5, 0, [100.5, 0, 100], owner.p, h.now())
    h.world.snapshotFor(thief.p, h.now())
    expect(h.req(thief.p, thief.inbox, { t: 'pickup', id: item.id })).toMatchObject({ ok: false, reason: 'not_owner' })
    h.advance(ITEM_OWNER_MS + 100)
    h.world.snapshotFor(thief.p, h.now())
    expect(h.req(thief.p, thief.inbox, { t: 'pickup', id: item.id }).ok).toBe(true)
    expect(h.countOf(thief.p, HERB)).toBe(5)
    expect(h.world.items.has(item.id)).toBe(false)
  })

  it('a pickup into a full bag is refused and the item stays on the ground', () => {
    const h = harness()
    const me = h.enter([100, 0, 100])
    h.edit(me.p, (d) => {
      for (let i = 0; i < d.bagSize; i++) if (!d.bag[i]) d.setBag(i, { code: 'ITEM_CH_BLADE_02_A', count: 1, plus: 0, durability: null })
    })
    const item = h.gameplay.spawnGroundItem(HERB, 5, 0, [100.5, 0, 100], me.p, h.now())
    h.world.snapshotFor(me.p, h.now())
    expect(h.req(me.p, me.inbox, { t: 'pickup', id: item.id })).toMatchObject({ ok: false, reason: 'inventory_full' })
    expect(h.world.items.has(item.id)).toBe(true)
  })

  it("a drop -> pickup round trip keeps a worn item's durability (it must not work as a free repair)", () => {
    const h = harness()
    const me = h.enter([100, 0, 100])
    const at = h.give(me.p, 'ITEM_CH_BLADE_02_A', 1, { durability: 5, plus: 3 })
    expect(h.req(me.p, me.inbox, { t: 'itemDrop', bag: at }).ok).toBe(true)
    const item = [...h.world.items.values()].find((i) => i.code === 'ITEM_CH_BLADE_02_A')!
    h.world.snapshotFor(me.p, h.now())
    expect(h.req(me.p, me.inbox, { t: 'pickup', id: item.id }).ok).toBe(true)
    // Today the ground item carries no durability, so the pickup comes back at full durability (null).
    expect(h.bag(me.p).find((i) => i?.code === 'ITEM_CH_BLADE_02_A')).toMatchObject({ plus: 3, durability: 5 })
  })
})

describe('economy: client drag onto a full stack (storage-state.ts)', () => {
  const def = (code: string) => (code === HERB ? { maxStack: 50 } : { maxStack: 1 })
  const bagOf = (items: Record<number, { code: string; count: number }>, size = 8) => ({ bagSize: size, item: (i: number) => items[i] ?? null })

  it('dropping bag herbs onto a FULL storage stack of herbs lets the server pick (no `to`), instead of a drop the server always refuses', () => {
    const st = new StorageState()
    st.setSnapshot({ size: 150, slots: Array.from({ length: 150 }, (_, i) => (i === 0 ? { code: HERB, count: 50 } : null)), gold: 0 })
    const msg = storageDropIntent(7, st, bagOf({ 0: { code: HERB, count: 10 } }), { kind: 'bag', slot: 0 }, { kind: 'storage', slot: 0 }, def)
    // Today: { t: 'storageDeposit', npc: 7, bag: 0, to: 0 } -> the server answers invalid_slot 'that stack is full'.
    expect(msg).toEqual({ t: 'storageDeposit', npc: 7, bag: 0 })
  })

  it('withdrawing onto a FULL bag stack of the same item lets the server pick (no `bag`), instead of a refused drop', () => {
    const st = new StorageState()
    st.setSnapshot({ size: 150, slots: Array.from({ length: 150 }, (_, i) => (i === 3 ? { code: HERB, count: 20 } : null)), gold: 0 })
    const msg = storageDropIntent(7, st, bagOf({ 2: { code: HERB, count: 50 } }), { kind: 'storage', slot: 3 }, { kind: 'bag', slot: 2 }, def)
    expect(msg).toEqual({ t: 'storageWithdraw', npc: 7, slot: 3 })
  })
})
