/**
 * Account storage (docs/SHOPS.md §5, §6, §9 lane B; docs/WAVE_PLAN.md §4.7): the pure rules in storage.ts, the
 * database side and requests in storage-db.ts (one transaction over both tables, the keeper and range checks, the
 * abuse rules), the v5 -> v6 migration, and end to end over real WebSockets: a second character of the same account
 * withdraws what the first deposited, and a relog on another socket cannot duplicate anything.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MAX_GOLD, STORAGE_SIZE_DEFAULT, parseServerMessage, type GameplayRequest, type ItemDef, type NpcDef, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import type { WorldSetup } from '../src/content.ts'
import { migrate, openStore } from '../src/db.ts'
import type { GameplayMessage } from '../src/gameplay.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { InvDraft, newItem, type InvItem, type InvState } from '../src/inventory.ts'
import { FlatNav } from '../src/nav.ts'
import { StorageDraft, deposit, goldIn, goldOut, moveStored, storageFee, toAccountStorage, withdraw } from '../src/storage.ts'
import { openStorageStore } from '../src/storage-db.ts'
import { World } from '../src/world.ts'
import { Client, newAccount, sleep, startTestServer, testConfig, type TestServer } from './helpers.ts'
import { ITEMS, LEVELS, NPCS, SHOPS, contentFiles, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const SWORD = 'ITEM_CH_SWORD_01_A_DEF'
const BLADE = 'ITEM_CH_BLADE_02_A'
const POTION = 'ITEM_ETC_HP_POTION_01'
const QUEST = 'ITEM_ETC_QUEST_01'
const GOLD = 'ITEM_ETC_GOLD_01'

/** The fixture items with retail-like storage fees (KeepingFee: sword 21, HP herb 1, blade 30). */
const FEES: Record<string, number> = { [SWORD]: 21, [POTION]: 1, [BLADE]: 30 }
const S_ITEMS: ItemDef[] = ITEMS.map((i) => (FEES[i.code] !== undefined ? { ...i, keepFee: FEES[i.code] } : i))
const DEFS = new Map(S_ITEMS.map((i) => [i.code, i]))
const defs = (code: string) => DEFS.get(code)

/** Storage-keeper Sansan beside the spawn, the Smith (a shop, no storage) 6 m away, a keeper in another world. */
const KEEPER: NpcDef = { code: 'NPC_CH_WAREHOUSE_W', name: 'Storage-keeper Sansan', x: 52, z: -50, yaw: 0, world: 'jangan', roles: ['storage'], model: null, provenance: 'client' }
const SMITH: NpcDef = { code: 'NPC_CH_SMITH', name: 'Blacksmith Chulsan', x: 52, z: -56, yaw: 0, world: 'jangan', model: null, provenance: 'client' }
const S_NPCS: NpcDef[] = [...NPCS, KEEPER, SMITH]

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

// ---- pure rules --------------------------------------------------------------------------------------------------

function bag(items: Record<number, InvItem>, gold = 0, bagSize = 8): InvDraft {
  const state: InvState = { bagSize, bag: Array.from({ length: bagSize }, (_, i) => items[i] ?? null), equip: {}, gold }
  return new InvDraft(state)
}

function chest(items: Record<number, InvItem>, gold = 0, size = 4): StorageDraft {
  return new StorageDraft({ size, slots: Array.from({ length: size }, (_, i) => items[i] ?? null), gold })
}

describe('storage rules (storage.ts)', () => {
  it('deposit: the whole stack into the first empty slot, with the fee keepFee x count', () => {
    const inv = bag({ 2: newItem(SWORD, 1) }, 100)
    const st = chest({ 0: newItem(BLADE, 1) })
    const r = deposit(inv, st, 2, undefined, undefined, defs, 1)
    expect(r).toEqual({ ok: true, value: { moved: 1, fee: 21 } })
    expect(inv.bag[2]).toBeNull()
    expect(inv.gold).toBe(79)
    expect(st.slots[1]).toMatchObject({ code: SWORD, count: 1 })
    expect(st.updates()).toEqual({ slots: [{ slot: 1, item: { code: SWORD, count: 1 } }] })
    expect(inv.updates()).toEqual({ bag: [{ slot: 2, item: null }], gold: 79 })
  })

  it('deposit: merges into a stack first, then an empty slot (maxStack 50), and splits a partial count', () => {
    const inv = bag({ 0: newItem(POTION, 40) }, 1000)
    const st = chest({ 1: newItem(POTION, 45) })
    expect(deposit(inv, st, 0, 30, undefined, defs, 1)).toEqual({ ok: true, value: { moved: 30, fee: 30 } })
    expect(inv.bag[0]).toMatchObject({ code: POTION, count: 10 })
    expect(st.slots[1]).toMatchObject({ count: 50 })
    expect(st.slots[0]).toMatchObject({ code: POTION, count: 25 })
    expect(inv.gold).toBe(970)
  })

  it('deposit into a chosen slot: empty takes it, a stack takes what fits, anything else is refused', () => {
    const inv = bag({ 0: newItem(POTION, 20), 1: newItem(SWORD, 1) }, 1000)
    const st = chest({ 2: newItem(POTION, 45), 3: newItem(BLADE, 1) })
    // 5 fit onto the 45-stack; 15 stay in the bag; the fee is only for what moved
    expect(deposit(inv, st, 0, undefined, 2, defs, 1)).toEqual({ ok: true, value: { moved: 5, fee: 5 } })
    expect(inv.bag[0]).toMatchObject({ count: 15 })
    expect(st.slots[2]).toMatchObject({ count: 50 })
    expect(deposit(inv, st, 0, undefined, 2, defs, 1)).toMatchObject({ ok: false, reason: 'invalid_slot', message: 'that stack is full' })
    expect(deposit(inv, st, 1, undefined, 3, defs, 1)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(deposit(inv, st, 1, undefined, 0, defs, 1)).toMatchObject({ ok: true })
    expect(st.slots[0]).toMatchObject({ code: SWORD })
    // beyond the chest's size
    expect(deposit(inv, st, 0, undefined, 4, defs, 1)).toMatchObject({ ok: false, reason: 'invalid_slot' })
  })

  it('fee arithmetic: rate 0 is free, rounding, and items without keepFee cost nothing', () => {
    expect(storageFee(DEFS.get(POTION)!, 37, 1)).toBe(37)
    expect(storageFee(DEFS.get(SWORD)!, 1, 0)).toBe(0)
    expect(storageFee(DEFS.get(SWORD)!, 1, 1.5)).toBe(32)
    expect(storageFee(DEFS.get('ITEM_CH_SHIELD_01_A')!, 1, 1)).toBe(0)
    const inv = bag({ 0: newItem(SWORD, 1) }, 0)
    expect(deposit(inv, chest({}), 0, undefined, undefined, defs, 0)).toEqual({ ok: true, value: { moved: 1, fee: 0 } })
  })

  it('deposit refusals: empty slot, bad count, quest item, not enough gold for the fee, storage full', () => {
    const inv = bag({ 0: newItem(POTION, 5), 1: newItem(QUEST, 1), 2: newItem(SWORD, 1) }, 20)
    expect(deposit(inv, chest({}), 3, undefined, undefined, defs, 1)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(deposit(inv, chest({}), 99, undefined, undefined, defs, 1)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(deposit(inv, chest({}), 0, 6, undefined, defs, 1)).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(deposit(inv, chest({}), 0, 0, undefined, defs, 1)).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(deposit(inv, chest({}), 1, undefined, undefined, defs, 1)).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(deposit(inv, chest({}), 2, undefined, undefined, defs, 1)).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    const full = chest({ 0: newItem(SWORD, 1), 1: newItem(SWORD, 1), 2: newItem(BLADE, 1), 3: newItem(POTION, 50) })
    expect(deposit(inv, full, 0, undefined, undefined, defs, 1)).toMatchObject({ ok: false, reason: 'storage_full' })
    // nothing changed on any refusal
    expect(inv.changed).toBe(false)
    expect(full.changed).toBe(false)
  })

  it('an authored canStore: false item cannot be stored', () => {
    const nostore = new Map([...DEFS, ['ITEM_X', { ...DEFS.get(SWORD)!, code: 'ITEM_X', canStore: false }]])
    const inv = bag({ 0: newItem('ITEM_X', 1) }, 100)
    expect(deposit(inv, chest({}), 0, undefined, undefined, (c) => nostore.get(c), 1)).toMatchObject({ ok: false, reason: 'not_usable' })
  })

  it('withdraw: into a chosen bag slot, merging, splitting, and inventory_full', () => {
    const inv = bag({ 0: newItem(POTION, 48), 1: newItem(SWORD, 1) }, 0, 3)
    const st = chest({ 0: newItem(POTION, 30), 1: newItem(BLADE, 1), 2: newItem(SWORD, 1) })
    // chosen empty slot, partial count
    expect(withdraw(inv, st, 0, 10, 2, defs)).toEqual({ ok: true, value: 10 })
    expect(inv.bag[2]).toMatchObject({ code: POTION, count: 10 })
    expect(st.slots[0]).toMatchObject({ count: 20 })
    // chosen stack: only 2 fit onto the 48-stack
    expect(withdraw(inv, st, 0, undefined, 0, defs)).toEqual({ ok: true, value: 2 })
    expect(inv.bag[0]).toMatchObject({ count: 50 })
    expect(st.slots[0]).toMatchObject({ count: 18 })
    // chosen occupied, not mergeable
    expect(withdraw(inv, st, 1, undefined, 1, defs)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    // default: merge into the 10-stack
    expect(withdraw(inv, st, 0, undefined, undefined, defs)).toEqual({ ok: true, value: 18 })
    expect(inv.bag[2]).toMatchObject({ count: 28 })
    expect(st.slots[0]).toBeNull()
    // the bag is full for a sword
    expect(withdraw(inv, st, 2, undefined, undefined, defs)).toMatchObject({ ok: false, reason: 'inventory_full' })
    // empty or out-of-range storage slots
    expect(withdraw(inv, st, 0, undefined, undefined, defs)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(withdraw(inv, st, 4, undefined, undefined, defs)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(withdraw(inv, st, 2, 2, undefined, defs)).toMatchObject({ ok: false, reason: 'invalid_count' })
  })

  it('moveStored: move, merge (with remainder) and swap, like itemMove', () => {
    const st = chest({ 0: newItem(POTION, 30), 1: newItem(POTION, 40), 2: newItem(SWORD, 1) })
    expect(moveStored(st, 0, 1, defs)).toMatchObject({ ok: true })
    expect(st.slots[1]).toMatchObject({ count: 50 })
    expect(st.slots[0]).toMatchObject({ count: 20 })
    expect(moveStored(st, 2, 3, defs)).toMatchObject({ ok: true })
    expect(st.slots[2]).toBeNull()
    expect(moveStored(st, 3, 0, defs)).toMatchObject({ ok: true })
    expect(st.slots[0]).toMatchObject({ code: SWORD })
    expect(st.slots[3]).toMatchObject({ code: POTION, count: 20 })
    expect(moveStored(st, 2, 0, defs)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(moveStored(st, 0, 0, defs)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(moveStored(st, 0, 4, defs)).toMatchObject({ ok: false, reason: 'invalid_slot' })
  })

  it('gold in and out: exact amounts, not_enough_gold both ways, and the MAX_GOLD cap on both sides', () => {
    const inv = bag({}, 1000)
    const st = chest({}, 0)
    expect(goldIn(inv, st, 1001)).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(goldIn(inv, st, 1000)).toMatchObject({ ok: true })
    expect([inv.gold, st.gold]).toEqual([0, 1000])
    expect(goldOut(inv, st, 1001)).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(goldOut(inv, st, 400)).toMatchObject({ ok: true })
    expect([inv.gold, st.gold]).toEqual([400, 600])
    expect(goldIn(inv, st, 0)).toMatchObject({ ok: false, reason: 'invalid_count' })
    // withdrawing past MAX_GOLD fails and changes nothing
    const rich = bag({}, MAX_GOLD - 10)
    const full = chest({}, 100)
    expect(goldOut(rich, full, 11)).toMatchObject({ ok: false, reason: 'gold_limit' })
    expect([rich.gold, full.gold, rich.changed, full.changed]).toEqual([MAX_GOLD - 10, 100, false, false])
    expect(goldOut(rich, full, 10)).toMatchObject({ ok: true })
    expect(rich.gold).toBe(MAX_GOLD)
    // and depositing past it too
    const vault = chest({}, MAX_GOLD - 5)
    expect(goldIn(bag({}, 100), vault, 6)).toMatchObject({ ok: false, reason: 'gold_limit' })
  })

  it('toAccountStorage pads to the size and drops default fields', () => {
    const s = toAccountStorage({ size: 3, slots: [null, { code: SWORD, count: 1, plus: 2, durability: 40 }], gold: 5 })
    expect(s).toEqual({ size: 3, slots: [null, { code: SWORD, count: 1, plus: 2, durability: 40 }, null], gold: 5 })
  })
})

// ---- database and requests (Gameplay with a real SQLite store) ----------------------------------------------------

function harness(opts: { storageFee?: number; data?: GameData } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-storage-'))
  const logs: string[] = []
  const config = { ...testConfig(root, logs), rng: seeded(7), storageFee: opts.storageFee ?? 1, spawnMobs: false }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = opts.data ?? new GameData({ items: S_ITEMS, levels: LEVELS, npcs: S_NPCS, shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 50, y: 0, z: -50 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(7) })
  gameplay.start()
  const keeper = [...world.npcs.values()].find((n) => n.code === KEEPER.code)!
  const smith = [...world.npcs.values()].find((n) => n.code === SMITH.code)!
  let n = 0
  const account = () => store.createAccount(`stor${++n}`, 'x')!
  const character = (acc: number) => {
    const row = store.createCharacter(acc, `Keeper${++n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    return row
  }
  const enter = (characterId: number, pos: Vec3 = [keeper.pos[0] + 2, 0, keeper.pos[2]]) => {
    const row = store.characterById(characterId)!
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    return { p, inbox }
  }
  const leave = (p: ReturnType<typeof enter>['p']) => {
    gameplay.forget(p)
    world.remove(p.id)
  }
  type P = ReturnType<typeof enter>
  const req = (who: P, msg: GameplayMessage) => {
    const at = who.inbox.length
    gameplay.request(who.p, msg, Date.now())
    const out = who.inbox.slice(at)
    // every frame the server sends must pass the shared strict validator
    for (const m of out) expect(parseServerMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(true)
    return { result: out.find((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === msg.t)!, out }
  }
  const give = (who: P, code: string, count: number) => {
    const r = gameplay.gmItem(who.p, data.item(code) ?? null, code, count)
    if (!r.ok) throw new Error(r.reason)
  }
  const rows = () => ({
    items: store.db.prepare('SELECT character_id, bag_slot, code, count FROM items WHERE bag_slot IS NOT NULL ORDER BY id').all() as { character_id: number; bag_slot: number; code: string; count: number }[],
    stored: store.db.prepare('SELECT account_id, slot, code, count FROM storage_items ORDER BY slot').all() as { account_id: number; slot: number; code: string; count: number }[],
  })
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, world, gameplay, data, keeper, smith, account, character, enter, leave, req, give, rows, logs }
}

const bagSlotOf = (store: ReturnType<typeof openStore>, characterId: number, code: string) => store.loadInventory(characterId).bag.findIndex((i) => i?.code === code)

describe('storage requests (storage-db.ts)', () => {
  it('the module is enabled and routes the five requests', () => {
    const h = harness()
    expect(h.gameplay.storage.enabled).toBe(true)
    for (const t of ['storageOpen', 'storageDeposit', 'storageWithdraw', 'storageMove', 'storageGold'] as GameplayRequest[]) {
      expect(h.gameplay.routes.get(t)).toBe(h.gameplay.storage)
    }
  })

  it('open -> deposit -> gold -> withdraw, with the message order of SHOPS §7.3', () => {
    const h = harness()
    const acc = h.account()
    const ch = h.character(acc)
    const a = h.enter(ch.id)
    h.give(a, SWORD, 1)
    h.give(a, GOLD, 2000)
    const open = h.req(a, { t: 'storageOpen', npc: h.keeper.id })
    expect(open.out.map((m) => m.t)).toEqual(['actionResult', 'storage'])
    const snap = (open.out[1] as Msg<'storage'>).storage
    expect(snap).toMatchObject({ size: STORAGE_SIZE_DEFAULT, gold: 0 })
    expect(snap.slots).toHaveLength(STORAGE_SIZE_DEFAULT)
    expect(snap.slots.every((s) => s === null)).toBe(true)

    const swordAt = bagSlotOf(h.store, ch.id, SWORD)
    const dep = h.req(a, { t: 'storageDeposit', npc: h.keeper.id, bag: swordAt })
    expect(dep.result).toMatchObject({ ok: true })
    expect(dep.out.map((m) => m.t)).toEqual(['actionResult', 'inventoryUpdate', 'statsDelta', 'storageUpdate'])
    expect(dep.out[1]).toEqual({ t: 'inventoryUpdate', bag: [{ slot: swordAt, item: null }], gold: 2000 - 21 })
    expect(dep.out[2]).toEqual({ t: 'statsDelta', stats: { gold: 2000 - 21 } })
    expect(dep.out[3]).toEqual({ t: 'storageUpdate', slots: [{ slot: 0, item: { code: SWORD, count: 1 } }] })
    expect(a.p.gold).toBe(1979)

    const gold = h.req(a, { t: 'storageGold', npc: h.keeper.id, dir: 'deposit', amount: 1000 })
    expect(gold.out.map((m) => m.t)).toEqual(['actionResult', 'inventoryUpdate', 'statsDelta', 'storageUpdate'])
    expect(gold.out[3]).toEqual({ t: 'storageUpdate', gold: 1000 })
    expect(a.p.gold).toBe(979)

    const mv = h.req(a, { t: 'storageMove', npc: h.keeper.id, from: 0, to: 149 })
    expect(mv.out.map((m) => m.t)).toEqual(['actionResult', 'storageUpdate'])

    const wd = h.req(a, { t: 'storageWithdraw', npc: h.keeper.id, slot: 149, bag: 7 })
    expect(wd.result).toMatchObject({ ok: true })
    expect(wd.out.map((m) => m.t)).toEqual(['actionResult', 'inventoryUpdate', 'storageUpdate'])
    expect(h.store.loadInventory(ch.id).bag[7]).toMatchObject({ code: SWORD })
    expect(h.req(a, { t: 'storageGold', npc: h.keeper.id, dir: 'withdraw', amount: 1000 }).result).toMatchObject({ ok: true })
    expect(a.p.gold).toBe(1979)
    expect(h.rows().stored).toEqual([])
  })

  it('two characters of one account share the chest; it survives deleting the depositor; other accounts see nothing', () => {
    const h = harness()
    const acc = h.account()
    const first = h.character(acc)
    const second = h.character(acc)
    const a = h.enter(first.id)
    h.give(a, SWORD, 1)
    h.give(a, POTION, 30)
    h.give(a, GOLD, 5000)
    expect(h.req(a, { t: 'storageDeposit', npc: h.keeper.id, bag: bagSlotOf(h.store, first.id, SWORD) }).result).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'storageDeposit', npc: h.keeper.id, bag: bagSlotOf(h.store, first.id, POTION), count: 20 }).result).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'storageGold', npc: h.keeper.id, dir: 'deposit', amount: 1000 }).result).toMatchObject({ ok: true })
    h.leave(a.p)
    expect(h.store.softDeleteCharacter(first.id, acc)).toBe(true)

    const b = h.enter(second.id)
    const open = h.req(b, { t: 'storageOpen', npc: h.keeper.id })
    const snap = (open.out.find((m) => m.t === 'storage') as Msg<'storage'>).storage
    expect(snap.gold).toBe(1000)
    expect(snap.slots.slice(0, 3)).toEqual([{ code: SWORD, count: 1 }, { code: POTION, count: 20 }, null])
    expect(h.req(b, { t: 'storageWithdraw', npc: h.keeper.id, slot: 0 }).result).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'storageWithdraw', npc: h.keeper.id, slot: 1, count: 5 }).result).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'storageGold', npc: h.keeper.id, dir: 'withdraw', amount: 1000 }).result).toMatchObject({ ok: true })
    expect(b.p.gold).toBe(1000)
    const inv = h.store.loadInventory(second.id)
    expect(inv.bag.filter(Boolean).map((i) => `${i!.code}x${i!.count}`).sort()).toEqual([`${SWORD}x1`, `${POTION}x5`].sort())

    // another account's character sees an empty chest
    const c = h.enter(h.character(h.account()).id)
    const other = (h.req(c, { t: 'storageOpen', npc: h.keeper.id }).out.find((m) => m.t === 'storage') as Msg<'storage'>).storage
    expect(other.gold).toBe(0)
    expect(other.slots.every((s) => s === null)).toBe(true)
  })

  it('an item is never in both tables, whatever the sequence', () => {
    const h = harness()
    const acc = h.account()
    const ch = h.character(acc)
    const a = h.enter(ch.id)
    h.give(a, POTION, 120)
    h.give(a, SWORD, 1)
    h.give(a, BLADE, 1)
    h.give(a, GOLD, 100_000)
    const total = () => {
      const r = h.rows()
      const count = (code: string) => r.items.filter((i) => i.code === code).reduce((s, i) => s + i.count, 0) + r.stored.filter((i) => i.code === code).reduce((s, i) => s + i.count, 0)
      return { potions: count(POTION), swords: count(SWORD), blades: count(BLADE) }
    }
    const rng = seeded(99)
    const k = h.keeper.id
    for (let i = 0; i < 300; i++) {
      const roll = Math.floor(rng() * 5)
      const slot = Math.floor(rng() * 6)
      const n = rng() < 0.5 ? undefined : 1 + Math.floor(rng() * 30)
      const msg: GameplayMessage =
        roll === 0 ? { t: 'storageDeposit', npc: k, bag: slot, ...(n ? { count: n } : {}) }
        : roll === 1 ? { t: 'storageWithdraw', npc: k, slot, ...(n ? { count: n } : {}) }
        : roll === 2 ? { t: 'storageMove', npc: k, from: slot, to: Math.floor(rng() * 6) }
        : roll === 3 ? { t: 'storageDeposit', npc: k, bag: slot, to: Math.floor(rng() * 6) }
        : { t: 'storageWithdraw', npc: k, slot, bag: Math.floor(rng() * 6) }
      h.req(a, msg)
      expect(total()).toEqual({ potions: 120, swords: 1, blades: 1 })
    }
    // no slot is used twice in either table
    const r = h.rows()
    expect(new Set(r.items.map((i) => i.bag_slot)).size).toBe(r.items.length)
    expect(new Set(r.stored.map((i) => i.slot)).size).toBe(r.stored.length)
  })

  it('a throw inside the transaction rolls back both tables', () => {
    const h = harness()
    const acc = h.account()
    const ch = h.character(acc)
    const a = h.enter(ch.id)
    h.give(a, SWORD, 1)
    h.give(a, GOLD, 100)
    const before = h.rows()
    const tables = openStorageStore(h.store)
    expect(() =>
      tables.storageTx(ch.id, acc, (inv, st) => {
        const r = deposit(inv, st, bagSlotOf(h.store, ch.id, SWORD), undefined, undefined, defs, 1)
        // write both sides by hand, then blow up: nothing may stay
        h.store.writeDraft(ch.id, inv)
        tables.write(acc, st)
        if (r.ok) throw new Error('boom')
        return r
      }),
    ).toThrow('boom')
    expect(h.rows()).toEqual(before)
    expect(h.store.loadInventory(ch.id).gold).toBe(100)
    expect(tables.load(acc).gold).toBe(0)
  })

  it('abuse: double deposit of one slot, slot 179 of 150, gold overdrafts, MAX_GOLD, quest items', () => {
    const h = harness()
    const acc = h.account()
    const ch = h.character(acc)
    const a = h.enter(ch.id)
    h.give(a, SWORD, 1)
    h.give(a, QUEST, 1)
    h.give(a, GOLD, 500)
    const k = h.keeper.id
    const sword = bagSlotOf(h.store, ch.id, SWORD)
    expect(h.req(a, { t: 'storageDeposit', npc: k, bag: sword }).result).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'storageDeposit', npc: k, bag: sword }).result).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(a, { t: 'storageWithdraw', npc: k, slot: 179 }).result).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(a, { t: 'storageWithdraw', npc: k, slot: 150 }).result).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(a, { t: 'storageDeposit', npc: k, bag: bagSlotOf(h.store, ch.id, QUEST), to: 179 }).result).toMatchObject({ ok: false })
    expect(h.req(a, { t: 'storageDeposit', npc: k, bag: bagSlotOf(h.store, ch.id, QUEST) }).result).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(h.req(a, { t: 'storageMove', npc: k, from: 0, to: 170 }).result).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(a, { t: 'storageGold', npc: k, dir: 'withdraw', amount: 1 }).result).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(h.req(a, { t: 'storageGold', npc: k, dir: 'deposit', amount: 480 }).result).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(h.req(a, { t: 'storageGold', npc: k, dir: 'deposit', amount: 479 }).result).toMatchObject({ ok: true })
    // a bag near MAX_GOLD cannot take the stored gold
    h.store.db.prepare('UPDATE characters SET gold = ? WHERE id = ?').run(MAX_GOLD - 100, ch.id)
    const over = h.req(a, { t: 'storageGold', npc: k, dir: 'withdraw', amount: 479 })
    expect(over.result).toMatchObject({ ok: false, reason: 'gold_limit' })
    expect(over.out).toHaveLength(1)
    expect(openStorageStore(h.store).load(acc).gold).toBe(479)
    expect(h.store.loadInventory(ch.id).gold).toBe(MAX_GOLD - 100)
  })

  it('range and keeper: the Smith and a missing NPC -> not_found, 9 m away -> too_far, dead -> dead', () => {
    const h = harness()
    const acc = h.account()
    const ch = h.character(acc)
    const near = h.enter(ch.id, [h.smith.pos[0] + 1, 0, h.smith.pos[2]])
    h.give(near, SWORD, 1)
    h.give(near, GOLD, 100)
    const sword = bagSlotOf(h.store, ch.id, SWORD)
    expect(h.req(near, { t: 'storageDeposit', npc: h.smith.id, bag: sword }).result).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(near, { t: 'storageOpen', npc: h.smith.id }).result).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(near, { t: 'storageOpen', npc: 999_999 }).result).toMatchObject({ ok: false, reason: 'not_found' })
    // a mob or player id is not a keeper either
    expect(h.req(near, { t: 'storageOpen', npc: near.p.id }).result).toMatchObject({ ok: false, reason: 'not_found' })
    h.leave(near.p)

    const far = h.enter(ch.id, [h.keeper.pos[0] + 9, 0, h.keeper.pos[2]])
    expect(h.req(far, { t: 'storageOpen', npc: h.keeper.id }).result).toMatchObject({ ok: false, reason: 'too_far' })
    expect(h.req(far, { t: 'storageDeposit', npc: h.keeper.id, bag: sword }).result).toMatchObject({ ok: false, reason: 'too_far' })
    h.leave(far.p)

    const edge = h.enter(ch.id, [h.keeper.pos[0] + 7.9, 0, h.keeper.pos[2]])
    expect(h.req(edge, { t: 'storageOpen', npc: h.keeper.id }).result).toMatchObject({ ok: true })
    h.gameplay.gmKill(edge.p)
    expect(h.req(edge, { t: 'storageDeposit', npc: h.keeper.id, bag: sword }).result).toMatchObject({ ok: false, reason: 'dead' })
    expect(h.req(edge, { t: 'storageOpen', npc: h.keeper.id }).result).toMatchObject({ ok: false, reason: 'dead' })
    expect(h.rows().stored).toEqual([])
  })

  it('STORAGE_FEE=0 makes deposits free; unknown item codes cannot be deposited', () => {
    const h = harness({ storageFee: 0 })
    const ch = h.character(h.account())
    const a = h.enter(ch.id)
    h.give(a, SWORD, 1)
    expect(h.req(a, { t: 'storageDeposit', npc: h.keeper.id, bag: bagSlotOf(h.store, ch.id, SWORD) }).result).toMatchObject({ ok: true })
    expect(a.p.gold).toBe(0)
    h.store.db.prepare("INSERT INTO items (character_id, bag_slot, code, count) VALUES (?, 5, 'ITEM_GONE', 1)").run(ch.id)
    expect(h.req(a, { t: 'storageDeposit', npc: h.keeper.id, bag: 5 }).result).toMatchObject({ ok: false, reason: 'not_usable' })
  })
})

// ---- real Jangan content (work/out/data) --------------------------------------------------------------------------

const OUT = join(REPO_ROOT, 'work/out')
const HAVE_REAL = ['items.json', 'npcs.json'].every((f) => existsSync(join(OUT, 'data', f)))

describe.skipIf(!HAVE_REAL)('storage on the real Jangan content', () => {
  it('Sansan keeps storage, the Smith does not, and the starter sword costs its KeepingFee of 21', () => {
    const h = harness({ data: GameData.load(OUT) })
    expect(h.keeper).toBeDefined()
    expect(h.smith).toBeDefined()
    const ch = h.character(h.account())
    const a = h.enter(ch.id)
    const sword = h.data.item(SWORD)!
    expect(sword.keepFee).toBe(21)
    h.give(a, SWORD, 1)
    h.give(a, POTION, 10)
    h.give(a, GOLD, 100)
    const swordAt = bagSlotOf(h.store, ch.id, SWORD)
    expect(h.req(a, { t: 'storageDeposit', npc: h.smith.id, bag: swordAt }).result).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(a, { t: 'storageDeposit', npc: h.keeper.id, bag: swordAt }).result).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'storageDeposit', npc: h.keeper.id, bag: bagSlotOf(h.store, ch.id, POTION) }).result).toMatchObject({ ok: true })
    expect(a.p.gold).toBe(100 - 21 - 10 * (h.data.item(POTION)!.keepFee ?? 0))
    expect(openStorageStore(h.store).load(h.store.characterById(ch.id)!.account_id).slots.slice(0, 2)).toMatchObject([{ code: SWORD }, { code: POTION, count: 10 }])
  })
})

// ---- migration ---------------------------------------------------------------------------------------------------

describe('migration v5 -> v6', () => {
  it('adds the storage tables to a v5 database, keeping its data; the chest starts empty with 150 slots', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-storage-mig-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const v5 = new Database(join(root, 'game.db'))
    expect(migrate(v5, 5)).toBe(5)
    v5.exec(`INSERT INTO accounts (id, username, password_hash, created_at) VALUES (1, 'old', 'x', 1);
      INSERT INTO characters (id, account_id, name, model, weapon, level, world, created_at, gold) VALUES (1, 1, 'Mu', 'CHAR_CH_MAN_ADVENTURER', 'blade', 3, 'jangan', 1, 777);
      INSERT INTO items (character_id, bag_slot, code, count) VALUES (1, 0, '${SWORD}', 1);
      INSERT INTO char_hotbar (character_id, slot, kind, code) VALUES (1, 0, 'item', '${POTION}');`)
    expect(() => v5.prepare('SELECT * FROM storage_items').all()).toThrow()
    v5.close()

    const store = openStore(root)
    try {
      expect(store.db.pragma('user_version', { simple: true })).toBe(24)
      expect(store.characterById(1)).toMatchObject({ name: 'Mu', gold: 777 })
      expect(store.db.prepare('SELECT code FROM char_hotbar WHERE character_id = 1').get()).toEqual({ code: POTION })
      const tables = openStorageStore(store)
      expect(tables.load(1)).toMatchObject({ size: STORAGE_SIZE_DEFAULT, gold: 0 })
      // a deposit works on the migrated database
      const r = tables.storageTx(1, 1, (inv, st) => deposit(inv, st, 0, undefined, undefined, defs, 1))
      expect(r.result).toEqual({ ok: true, value: { moved: 1, fee: 21 } })
      expect(store.loadInventory(1)).toMatchObject({ gold: 756, bag: expect.arrayContaining([null]) })
      expect(tables.load(1).slots[0]).toMatchObject({ code: SWORD, count: 1 })
      // the schema's own guards
      expect(() => store.db.prepare("INSERT INTO storage_items (account_id, slot, code, count) VALUES (1, 0, 'X', 1)").run()).toThrow(/UNIQUE/)
      expect(() => store.db.prepare('UPDATE accounts SET storage_gold = -1 WHERE id = 1').run()).toThrow(/CHECK/)
    } finally {
      store.close()
    }
  })
})

// ---- end to end over WebSockets ---------------------------------------------------------------------------------

describe('storage end to end', () => {
  const SPAWN: [number, number, number] = [50, 0, -50]
  let s: TestServer

  beforeAll(async () => {
    s = await startTestServer({
      config: { moveSpeed: 30, viewRange: 60, rng: seeded(3), spawnMobs: false },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({ items: S_ITEMS, levels: LEVELS, npcs: S_NPCS, shops: SHOPS }),
      },
    })
  })

  afterAll(async () => {
    await s.stopAndClean()
  })

  let names = 0
  async function enterAs(token: string, create?: boolean, id?: number) {
    const c = await Client.login(s.url, token)
    let charId = id
    if (create) {
      c.send({ t: 'charCreate', name: `Vault${++names}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'blade' })
      charId = (await c.next('charCreated')).character.id
    }
    c.send({ t: 'enterWorld', id: charId! })
    const enter = await c.next('worldEnter')
    await c.next('inventory')
    const keeper = enter.entities.find((e) => e.kind === 'npc' && e.name === KEEPER.name)!
    const smith = enter.entities.find((e) => e.kind === 'npc' && e.name === SMITH.name)!
    return { c, charId: charId!, self: enter.self.id, keeper: keeper.id, smith: smith.id }
  }

  async function act(c: Client, msg: Record<string, unknown> & { t: string }) {
    c.send(msg)
    return c.next('actionResult', (m) => m.re === msg.t)
  }

  it('Sansan: deposit a sword and 1000 gold; the account\'s second character withdraws both; the Smith says not_found', async () => {
    const acc = await newAccount(s.url, 'vault')
    // make the second character first, so both exist on the account
    const pre = await Client.login(s.url, acc.token)
    pre.send({ t: 'charCreate', name: `Vault${++names}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const secondId = (await pre.next('charCreated')).character.id
    pre.close()
    await pre.closed

    const a = await enterAs(acc.token, true)
    const player = s.ctx.world.players.get(a.self)!
    s.ctx.gameplay.gmItem(player, s.ctx.data.item(SWORD)!, SWORD, 1)
    s.ctx.gameplay.gmItem(player, null, GOLD, 1500)
    await a.c.next('inventoryUpdate', (m) => m.gold === 1500)
    // walk into range of the keeper (the spawn is ~2 m away already)
    expect(await act(a.c, { t: 'storageOpen', npc: a.keeper })).toMatchObject({ ok: true })
    expect((await a.c.next('storage')).storage).toMatchObject({ size: 150, gold: 0 })
    const inv = s.ctx.store.loadInventory(a.charId)
    const swordAt = inv.bag.findIndex((i) => i?.code === SWORD)
    expect(await act(a.c, { t: 'storageDeposit', npc: a.smith, bag: swordAt })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await act(a.c, { t: 'storageDeposit', npc: a.keeper, bag: swordAt })).toMatchObject({ ok: true })
    expect(await a.c.next('inventoryUpdate', (m) => m.bag?.[0]?.item === null)).toMatchObject({ bag: [{ slot: swordAt, item: null }], gold: 1479 })
    expect(await a.c.next('storageUpdate')).toEqual({ t: 'storageUpdate', slots: [{ slot: 0, item: { code: SWORD, count: 1 } }] })
    expect(await act(a.c, { t: 'storageGold', npc: a.keeper, dir: 'deposit', amount: 1000 })).toMatchObject({ ok: true })
    expect(await a.c.next('storageUpdate', (m) => m.gold !== undefined)).toEqual({ t: 'storageUpdate', gold: 1000 })
    // abuse over the wire: amount 0 is rejected by the validator (bad_request)
    a.c.send({ t: 'storageGold', npc: a.keeper, dir: 'deposit', amount: 0 })
    expect(await a.c.next('error')).toMatchObject({ code: 'bad_request' })
    a.c.close()
    await a.c.closed
    await sleep(30)

    const b = await enterAs(acc.token, false, secondId)
    expect(await act(b.c, { t: 'storageOpen', npc: b.keeper })).toMatchObject({ ok: true })
    const snap = (await b.c.next('storage')).storage
    expect(snap.gold).toBe(1000)
    expect(snap.slots[0]).toEqual({ code: SWORD, count: 1 })
    expect(await act(b.c, { t: 'storageWithdraw', npc: b.keeper, slot: 0 })).toMatchObject({ ok: true })
    expect(await act(b.c, { t: 'storageGold', npc: b.keeper, dir: 'withdraw', amount: 1000 })).toMatchObject({ ok: true })
    expect(await b.c.next('statsDelta', (m) => m.stats.gold === 1000)).toBeTruthy()
    const after = s.ctx.store.loadInventory(b.charId)
    expect(after.bag.some((i) => i?.code === SWORD)).toBe(true)
    expect(after.gold).toBe(1000)
    b.c.close()
    await b.c.closed
  })

  it('a relog on another socket mid-sequence cannot duplicate: one row per item at the end', async () => {
    const acc = await newAccount(s.url, 'dupe')
    const a = await enterAs(acc.token, true)
    const player = s.ctx.world.players.get(a.self)!
    s.ctx.gameplay.gmItem(player, s.ctx.data.item(SWORD)!, SWORD, 1)
    s.ctx.gameplay.gmItem(player, s.ctx.data.item(POTION)!, POTION, 50)
    s.ctx.gameplay.gmItem(player, null, GOLD, 500)
    const inv = s.ctx.store.loadInventory(a.charId)
    const swordAt = inv.bag.findIndex((i) => i?.code === SWORD)
    const potAt = inv.bag.findIndex((i) => i?.code === POTION)
    // fire a burst without waiting, then take the account over from a second socket that withdraws at once
    for (let i = 0; i < 3; i++) {
      a.c.send({ t: 'storageDeposit', npc: a.keeper, bag: swordAt })
      a.c.send({ t: 'storageDeposit', npc: a.keeper, bag: potAt, count: 10 })
      a.c.send({ t: 'storageWithdraw', npc: a.keeper, slot: 0 })
    }
    const b = await enterAs(acc.token, false, a.charId)
    await a.c.closed
    b.c.send({ t: 'storageWithdraw', npc: b.keeper, slot: 0 })
    b.c.send({ t: 'storageWithdraw', npc: b.keeper, slot: 1 })
    b.c.send({ t: 'storageDeposit', npc: b.keeper, bag: swordAt })
    await b.c.next('actionResult', (m) => m.re === 'storageDeposit')
    const accountId = s.ctx.store.characterById(a.charId)!.account_id
    const items = s.ctx.store.db.prepare('SELECT code, count FROM items WHERE character_id = ? AND bag_slot IS NOT NULL').all(a.charId) as { code: string; count: number }[]
    const stored = s.ctx.store.db.prepare('SELECT code, count FROM storage_items WHERE account_id = ?').all(accountId) as { code: string; count: number }[]
    const all = [...items, ...stored]
    expect(all.filter((i) => i.code === SWORD).reduce((n, i) => n + i.count, 0)).toBe(1)
    expect(all.filter((i) => i.code === POTION).reduce((n, i) => n + i.count, 0)).toBe(50)
    b.c.close()
    await b.c.closed
  })
})
