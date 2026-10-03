/**
 * Stall server (docs/SYSTEMS_SOCIAL.md §4 and §10.6; docs/WAVE_PLAN2.md §6.5 ST-S): the pure rules (list, unlist,
 * buyDrafts, views), the module (create/list/open/visit/buy/close, the §4.1 refusals, D29 `in_combat`, the decorator
 * and `entityUpdate stall`, the visitor cap and break range, stall chat), the gate allowlist (the owner's moveTo is
 * dropped, every other locked request answers `stalling`, visitors are free), and the abuse cases S1-S13 of §4.6
 * (S13, a purchase during a trade, is the trade gate's; see the note at the end).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_GOLD,
  STALL_BREAK_RANGE,
  STALL_PRICE_MAX,
  STALL_RANGE,
  STALL_SLOTS,
  STALL_VISITORS_MAX,
  parseServerMessage,
  type ClientMessage,
  type GameplayRequest,
  type ItemDef,
  type NpcDef,
  type ServerMessage,
  type TownDef,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { routeChat } from '../src/chat.ts'
import type { Connection } from '../src/connection.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { InvDraft, addGold, addItem, type InvState } from '../src/inventory.ts'
import { FlatNav } from '../src/nav.ts'
import { buyDrafts, list, newStall, stallView, unlist, type Listing } from '../src/social/stall-rules.ts'
import { World, type Player } from '../src/world.ts'
import { testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, SHOPS, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const POTION = 'ITEM_ETC_HP_POTION_01'
const BLADE = 'ITEM_CH_BLADE_02_A'
const STARTER = 'ITEM_CH_BLADE_01_A_DEF'
/** The starter kit cannot be traded (SOCIAL §1, D50). */
const TEST_ITEMS: ItemDef[] = ITEMS.map((d) => (d.code.endsWith('_DEF') ? { ...d, canTrade: false } : d))
const def = (code: string) => TEST_ITEMS.find((d) => d.code === code)!
/** The town safe area covers |x|, |z| <= 60. */
const TOWN: TownDef = { code: 'T', name: 'Town', world: 'jangan', spawn: { x: 0, y: 0, z: 0 }, safeArea: { x: 0, z: 0, halfX: 60, halfZ: 60 } }
const NPCS: NpcDef[] = [{ code: 'NPC_CH_POTION', name: 'Potion Merchant', x: 20, z: 20, yaw: 0, world: 'jangan', shop: 'STORE_CH_POTION', model: null, provenance: 'client' }]

interface P {
  p: Player
  inbox: ServerMessage[]
}

function harness(over: { stallTownOnly?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-stall-'))
  const config = { ...testConfig(root), rng: seeded(3), ...over }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG], items: TEST_ITEMS, levels: LEVELS, drops: DROPS, npcs: NPCS, shops: SHOPS, towns: [TOWN] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(3) })
  gameplay.start()
  const stalls = gameplay.stalls
  let n = 0
  /** A new character in the world; every player knows every other (interest is not under test). */
  const enter = (pos: Vec3 = [0, 0, 0], gold = 0): P => {
    const acc = store.createAccount(`stacc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Seller${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    if (gold) store.inventoryTx(row.id, (d) => addGold(d, gold))
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    for (const q of world.players.values()) {
      q.known.add(p.id)
      p.known.add(q.id)
    }
    return { p, inbox }
  }
  const leave = (x: P) => {
    world.remove(x.p.id)
    gameplay.forget(x.p)
  }
  /** Sends one request; exactly one actionResult comes back. */
  const req = (x: P, msg: ClientMessage, now = Date.now()) => {
    const before = x.inbox.length
    gameplay.request(x.p, msg as Extract<ClientMessage, { t: GameplayRequest }>, now)
    const res = x.inbox.slice(before).filter((m): m is Msg<'actionResult'> => m.t === 'actionResult')
    expect(res.length, msg.t).toBe(1)
    return res[0]
  }
  /** Puts items in the character's bag (each [code, count, plus?, durability?] in its own new slot or stack). */
  const give = (x: P, code: string, count: number, extra: { plus?: number; durability?: number | null; slot?: number } = {}) => {
    const { result } = store.inventoryTx(x.p.characterId, (d) => {
      if (extra.slot !== undefined || extra.plus !== undefined || extra.durability !== undefined) {
        const slot = extra.slot ?? d.firstFree()
        d.setBag(slot, { code, count, plus: extra.plus ?? 0, durability: extra.durability ?? null })
        return { ok: true, value: [slot] }
      }
      return addItem(d, def(code), count)
    })
    if (!result.ok) throw new Error(result.reason)
    return result.value[0]
  }
  const inv = (x: P) => store.loadInventory(x.p.characterId)
  const last = <T extends ServerMessage['t']>(x: P, t: T) => x.inbox.filter((m): m is Msg<T> => m.t === t).at(-1)
  const all = <T extends ServerMessage['t']>(x: P, t: T) => x.inbox.filter((m): m is Msg<T> => m.t === t)
  /** A stall of `x` with the given listings, opened. */
  const openStall = (x: P, items: { slot: number; bag: number; count: number; price: number }[], now = Date.now()) => {
    expect(req(x, { t: 'stallCreate', title: 'Cheap stuff' }, now)).toMatchObject({ ok: true })
    for (const it of items) expect(req(x, { t: 'stallItem', ...it }, now), `list ${it.slot}`).toMatchObject({ ok: true })
    expect(req(x, { t: 'stallOpen', open: true }, now)).toMatchObject({ ok: true })
  }
  const logRows = () => store.db.prepare('SELECT * FROM social_log ORDER BY id').all() as Record<string, unknown>[]
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { world, store, gameplay, stalls, enter, leave, req, give, inv, last, all, openStall, logRows }
}

const bag = (items: [number, string, number, number?, (number | null)?][], size = 8, gold = 0): InvState => {
  const b: InvState['bag'] = Array.from({ length: size }, () => null)
  for (const [i, code, count, plus, durability] of items) b[i] = { code, count, plus: plus ?? 0, durability: durability ?? null }
  return { bagSize: size, bag: b, equip: {}, gold }
}

// ---- pure rules --------------------------------------------------------------------------------------------

describe('stall rules (stall-rules.ts)', () => {
  it('a new stall is in modify with STALL_SLOTS empty slots and the retail default texts', () => {
    const s = newStall(7, 70, 'Bob', '', 1000)
    expect(s).toMatchObject({ owner: 7, characterId: 70, title: "Bob's stall.", greeting: "Welcome to Bob's stall.", state: 'modify', openedAt: 1000 })
    expect(s.items).toHaveLength(STALL_SLOTS)
    expect(newStall(7, 70, 'Bob', 'Bargains', 0).title).toBe('Bargains')
  })

  it('list stores a snapshot {bag, code, count, plus, durability, price} and replaces the slot', () => {
    const s = newStall(1, 1, 'A', '', 0)
    const inv = bag([[0, BLADE, 1, 3, 12], [1, POTION, 20]])
    expect(list(s, inv, 4, 0, 1, 500, def(BLADE))).toEqual({ ok: true, value: undefined })
    expect(s.items[4]).toEqual({ bag: 0, code: BLADE, count: 1, plus: 3, durability: 12, price: 500 })
    // the same bag slot again in the same stall slot replaces it
    expect(list(s, inv, 4, 0, 1, 700, def(BLADE)).ok).toBe(true)
    expect(s.items[4]!.price).toBe(700)
    expect(list(s, inv, 4, 1, 5, 10, def(POTION)).ok).toBe(true)
    expect(s.items[4]).toEqual({ bag: 1, code: POTION, count: 5, plus: 0, durability: null, price: 10 })
  })

  it('list refusals: state, slots, count, canTrade, price bounds (§4.1, D50)', () => {
    const s = newStall(1, 1, 'A', '', 0)
    const inv = bag([[0, BLADE, 1], [1, POTION, 20], [2, STARTER, 1]])
    expect(list(s, inv, 0, 7, 1, 10, undefined)).toMatchObject({ ok: false, reason: 'invalid_slot' }) // empty bag slot
    expect(list(s, inv, 0, 8, 1, 10, def(BLADE))).toMatchObject({ ok: false, reason: 'invalid_slot' }) // past the bag
    expect(list(s, inv, STALL_SLOTS, 0, 1, 10, def(BLADE))).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(list(s, inv, -1, 0, 1, 10, def(BLADE))).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(list(s, inv, 0, 1, 21, 10, def(POTION))).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(list(s, inv, 0, 1, 0, 10, def(POTION))).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(list(s, inv, 0, 2, 1, 10, def(STARTER))).toMatchObject({ ok: false, reason: 'not_usable', message: 'The selected item cannot be traded.' })
    expect(list(s, inv, 0, 0, 1, 10, undefined)).toMatchObject({ ok: false, reason: 'not_usable' }) // no definition
    expect(list(s, inv, 0, 0, 1, 0, def(BLADE))).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(list(s, inv, 0, 0, 1, STALL_PRICE_MAX + 1, def(BLADE))).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(list(s, inv, 0, 0, 1, 1.5, def(BLADE))).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(list(s, inv, 0, 0, 1, STALL_PRICE_MAX, def(BLADE)).ok).toBe(true)
    // S4: one listing per bag slot
    expect(list(s, inv, 1, 0, 1, 10, def(BLADE))).toMatchObject({ ok: false, reason: 'invalid_slot' })
    s.state = 'open'
    expect(list(s, inv, 2, 1, 1, 10, def(POTION))).toMatchObject({ ok: false, reason: 'stalling' })
    expect(unlist(s, 0)).toMatchObject({ ok: false, reason: 'stalling' })
    s.state = 'modify'
    expect(unlist(s, 5)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(unlist(s, 0).ok).toBe(true)
    expect(s.items[0]).toBeNull()
  })

  it('buyDrafts moves the gold and the listed count; +N and durability travel (D47)', () => {
    const l: Listing = { bag: 1, code: BLADE, count: 1, plus: 4, durability: 0, price: 300 }
    const buyer = new InvDraft(bag([[0, POTION, 5]], 4, 1000))
    const owner = new InvDraft(bag([[1, BLADE, 1, 4, 0]], 4, 50))
    const r = buyDrafts(l, buyer, owner, def(BLADE))
    expect(r).toEqual({ ok: true, value: { code: BLADE, count: 1, plus: 4, durability: 0 } })
    expect(buyer.gold).toBe(700)
    expect(owner.gold).toBe(350)
    expect(owner.bag[1]).toBeNull()
    expect(buyer.bag[1]).toEqual({ code: BLADE, count: 1, plus: 4, durability: 0 })
  })

  it('buyDrafts of part of a stack leaves the rest; a stackable merges into the buyer stack', () => {
    const l: Listing = { bag: 0, code: POTION, count: 5, plus: 0, durability: null, price: 40 }
    const buyer = new InvDraft(bag([[2, POTION, 10]], 4, 40))
    const owner = new InvDraft(bag([[0, POTION, 20]], 4, 0))
    expect(buyDrafts(l, buyer, owner, def(POTION)).ok).toBe(true)
    expect(owner.bag[0]!.count).toBe(15)
    expect(buyer.bag[2]!.count).toBe(15)
    expect(buyer.gold).toBe(0)
  })

  it('buyDrafts refusals: a changed slot is stall_changed; gold, gold limit and space', () => {
    const l: Listing = { bag: 0, code: BLADE, count: 1, plus: 2, durability: 10, price: 100 }
    const buyerOf = (gold = 1000, full = false) => new InvDraft(bag(full ? [[0, POTION, 1], [1, POTION, 1]] : [], 2, gold))
    for (const [what, slot] of [
      ['code', [0, POTION, 1]],
      ['plus', [0, BLADE, 1, 3, 10]],
      ['durability', [0, BLADE, 1, 2, 9]],
      ['empty', null],
    ] as const) {
      const owner = new InvDraft(bag(slot ? [slot as [number, string, number, number?, number?]] : [], 2))
      expect(buyDrafts(l, buyerOf(), owner, def(BLADE)), what).toMatchObject({ ok: false, reason: 'stall_changed' })
    }
    const fine = () => new InvDraft(bag([[0, BLADE, 1, 2, 10]], 2, 0))
    expect(buyDrafts(l, buyerOf(99), fine(), def(BLADE))).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(buyDrafts(l, buyerOf(), new InvDraft(bag([[0, BLADE, 1, 2, 10]], 2, MAX_GOLD - 50)), def(BLADE))).toMatchObject({ ok: false, reason: 'gold_limit' })
    expect(buyDrafts(l, buyerOf(1000, true), fine(), def(BLADE))).toMatchObject({ ok: false, reason: 'inventory_full' })
    // a listing larger than what the slot holds now
    expect(buyDrafts({ ...l, count: 2 }, buyerOf(), fine(), def(BLADE))).toMatchObject({ ok: false, reason: 'stall_changed' })
  })

  it('the owner view carries the bag slot, the visitor view does not; both parse', () => {
    const s = newStall(3, 30, 'Ann', 'T', 0)
    s.items[2] = { bag: 5, code: BLADE, count: 1, plus: 1, durability: null, price: 9 }
    s.visitors.add(11)
    const mine = stallView(s, 'Ann', true)
    const theirs = stallView(s, 'Ann', false)
    expect(mine.items[2]).toEqual({ stack: { code: BLADE, count: 1, plus: 1 }, price: 9, bag: 5 })
    expect(theirs.items[2]).toEqual({ stack: { code: BLADE, count: 1, plus: 1 }, price: 9 })
    expect(theirs).toMatchObject({ owner: 3, name: 'Ann', title: 'T', state: 'modify', visitors: 1 })
    for (const v of [mine, theirs]) expect(parseServerMessage(JSON.stringify({ t: 'stall', stall: v }))).not.toBeNull()
  })
})

// ---- module ------------------------------------------------------------------------------------------------

describe('stall module: create, texts, open (§4.1)', () => {
  it('creates in modify: halts the owner, clears its action, sends the owner view and entityUpdate stall to viewers; the decorator carries the title', () => {
    const h = harness()
    const a = h.enter([0, 0, 0])
    const b = h.enter([3, 0, 0])
    const now = Date.now()
    h.world.moveTo(a.p, 10, 0, now)
    a.p.action = { kind: 'pickup', item: 999, chaseAt: 0, chaseTo: null }
    expect(h.req(a, { t: 'stallCreate', title: '  Bargains\u0007 ' }, now)).toMatchObject({ ok: true })
    expect(a.p.move).toBeNull()
    expect(a.p.action).toBeNull()
    expect(h.last(a, 'stall')!.stall).toMatchObject({ owner: a.p.id, name: a.p.name, title: 'Bargains', greeting: `Welcome to ${a.p.name}'s stall.`, state: 'modify', visitors: 0 })
    expect(h.last(b, 'entityUpdate')).toEqual({ t: 'entityUpdate', id: a.p.id, stall: 'Bargains' })
    expect(h.world.state(a.p).stall).toBe('Bargains')
    expect(h.world.state(b.p).stall).toBeUndefined()
    // an empty title is the retail default
    const c = h.enter([-10, 0, -10])
    expect(h.req(c, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(h.world.state(c.p).stall).toBe(`${c.p.name}'s stall.`)
  })

  it('refusals: a second stall, outside town, next to an NPC or another stall, dead', () => {
    const h = harness()
    const a = h.enter([0, 0, 0])
    expect(h.req(a, { t: 'stallCreate', title: 'x' })).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'stallCreate', title: 'y' })).toMatchObject({ ok: false, reason: 'stalling' })
    const out = h.enter([100, 0, 0])
    expect(h.req(out, { t: 'stallCreate', title: 'x' })).toMatchObject({ ok: false, reason: 'wrong_place', message: 'Stalls can only be opened in town.' })
    const npc = h.enter([21, 0, 21])
    expect(h.req(npc, { t: 'stallCreate', title: 'x' })).toMatchObject({ ok: false, reason: 'wrong_place', message: 'Too close to Potion Merchant.' })
    const close = h.enter([1, 0, 0])
    expect(h.req(close, { t: 'stallCreate', title: 'x' })).toMatchObject({ ok: false, reason: 'wrong_place' })
    close.p.pos = [1.6, 0, 0]
    expect(h.req(close, { t: 'stallCreate', title: 'x' })).toMatchObject({ ok: true })
    const dead = h.enter([-20, 0, 0])
    h.gameplay.playerDied(dead.p, Date.now())
    expect(h.req(dead, { t: 'stallCreate', title: 'x' })).toMatchObject({ ok: false, reason: 'dead' })
  })

  it('STALL_TOWN_ONLY 0 allows a stall outside the safe area', () => {
    const h = harness({ stallTownOnly: 0 })
    const out = h.enter([100, 0, 0])
    expect(h.req(out, { t: 'stallCreate', title: 'x' })).toMatchObject({ ok: true })
  })

  it('D29: within 5 s of combat -> in_combat "You cannot use the stall during the battle."; after 5 s it opens', () => {
    const h = harness()
    const a = h.enter()
    const now = Date.now()
    a.p.lastCombatAt = now - 4999
    expect(h.req(a, { t: 'stallCreate', title: 'x' }, now)).toMatchObject({ ok: false, reason: 'in_combat', message: 'You cannot use the stall during the battle.' })
    a.p.lastCombatAt = now - 5000
    expect(h.req(a, { t: 'stallCreate', title: 'x' }, now)).toMatchObject({ ok: true })
  })

  it('stallText changes title and greeting in either state; the sign follows the title; empty = default', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, BLADE, 1)
    h.openStall(a, [{ slot: 0, bag: 0, count: 1, price: 10 }])
    expect(h.req(a, { t: 'stallText', greeting: 'Hello there' })).toMatchObject({ ok: true })
    expect(h.last(a, 'stall')!.stall).toMatchObject({ greeting: 'Hello there', state: 'open' })
    expect(h.req(a, { t: 'stallText', title: 'New' })).toMatchObject({ ok: true })
    expect(h.last(b, 'entityUpdate')).toEqual({ t: 'entityUpdate', id: a.p.id, stall: 'New' })
    expect(h.req(a, { t: 'stallText', title: ' ', greeting: '' })).toMatchObject({ ok: true })
    expect(h.last(a, 'stall')!.stall).toMatchObject({ title: `${a.p.name}'s stall.`, greeting: `Welcome to ${a.p.name}'s stall.` })
    expect(h.req(b, { t: 'stallText', title: 'x' })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('stallOpen needs a listing (not_complete); stallItem / stallItemRemove only in modify', () => {
    const h = harness()
    const a = h.enter()
    h.give(a, POTION, 20)
    expect(h.req(a, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'stallOpen', open: true })).toMatchObject({ ok: false, reason: 'not_complete' })
    expect(h.req(a, { t: 'stallItem', slot: 3, bag: 0, count: 5, price: 12 })).toMatchObject({ ok: true })
    expect(h.last(a, 'stall')!.stall!.items[3]).toEqual({ stack: { code: POTION, count: 5 }, price: 12, bag: 0 })
    expect(h.req(a, { t: 'stallOpen', open: true })).toMatchObject({ ok: true })
    expect(h.last(a, 'stall')!.stall!.state).toBe('open')
    expect(h.req(a, { t: 'stallItem', slot: 4, bag: 0, count: 5, price: 12 })).toMatchObject({ ok: false, reason: 'stalling' })
    expect(h.req(a, { t: 'stallItemRemove', slot: 3 })).toMatchObject({ ok: false, reason: 'stalling' })
    expect(h.req(a, { t: 'stallOpen', open: false })).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'stallItemRemove', slot: 3 })).toMatchObject({ ok: true })
    expect(h.last(a, 'stall')!.stall!.items[3]).toBeNull()
    // S10: the starter kit
    h.give(a, STARTER, 1)
    expect(h.req(a, { t: 'stallItem', slot: 0, bag: 1, count: 1, price: 5 })).toMatchObject({ ok: false, reason: 'not_usable', message: 'The selected item cannot be traded.' })
  })
})

describe('stall gate (§2.3 stall row, WAVE_PLAN2 §6.5)', () => {
  const REFUSED: ClientMessage[] = [
    { t: 'itemMove', from: 0, to: 1 },
    { t: 'itemSplit', from: 0, to: 1, count: 1 },
    { t: 'itemEquip', bag: 0 },
    { t: 'itemUnequip', slot: 'weapon' },
    { t: 'itemUse', bag: 0 },
    { t: 'itemDrop', bag: 0 },
    { t: 'pickup', id: 1 },
    { t: 'attack', target: 1 },
    { t: 'useSkill', skill: 'SKILL_X' },
    { t: 'npcTalk', npc: 1 },
    { t: 'npcClose' },
    { t: 'shopBuy', npc: 1, tab: 0, slot: 0, count: 1 },
    { t: 'shopSell', npc: 1, bag: 0 },
    { t: 'storageDeposit', npc: 1, bag: 0 },
    { t: 'questAccept', npc: 1, quest: 'Q' },
    { t: 'tradeRequest', target: 1 },
    { t: 'tradeRespond', from: 1, accept: true },
    { t: 'guildCreate', npc: 1, name: 'Abc' },
    { t: 'sit', on: true },
    { t: 'emote', emote: 'hi' },
    { t: 'repair', npc: 1, items: [{ bag: 0 }] },
    { t: 'alchemyReinforce', item: 0, elixir: 1 },
    { t: 'mountRide', cos: 1 },
    { t: 'mountDismount' },
    { t: 'berserk' },
  ] as unknown as ClientMessage[]

  it('every request outside the allowlist answers stalling; the owner moveTo is dropped and the position stays', () => {
    const h = harness()
    const a = h.enter([5, 0, 5])
    h.give(a, POTION, 3)
    expect(h.req(a, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    for (const m of REFUSED) expect(h.req(a, m), m.t).toMatchObject({ ok: false, reason: 'stalling' })
    expect(h.gameplay.onMoveTo(a.p)).toBe(false)
    expect(a.p.move).toBeNull()
    expect(a.p.pos).toEqual([5, 0, 5])
    expect(h.inv(a).bag[0]).toMatchObject({ code: POTION, count: 3 })
  })

  it('the allowlist passes (stopAction, statUp, party, guild but create, mountDismiss); after close nothing is locked', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    expect(h.req(a, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    for (const m of [
      { t: 'stopAction' },
      { t: 'statUp', stat: 'str', points: 1 },
      { t: 'partyInvite', target: b.p.id },
      { t: 'partyLeave' },
      { t: 'guildLeave' },
      { t: 'mountDismiss' },
      { t: 'hotbarSet', slot: 0, entry: null },
    ] as unknown as ClientMessage[]) {
      expect(h.req(a, m), m.t).not.toMatchObject({ reason: 'stalling' })
    }
    expect(h.req(a, { t: 'stallClose' })).toMatchObject({ ok: true })
    expect(h.gameplay.onMoveTo(a.p)).toBe(true)
    expect(h.req(a, { t: 'itemMove', from: 0, to: 1 })).not.toMatchObject({ reason: 'stalling' })
  })

  it('a visitor is not locked', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, BLADE, 1)
    h.give(b, POTION, 2)
    h.openStall(a, [{ slot: 0, bag: 0, count: 1, price: 5 }])
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'itemMove', from: 0, to: 3 })).toMatchObject({ ok: true })
    expect(h.gameplay.onMoveTo(b.p)).toBe(true)
  })
})

describe('stall module: visit, buy (§4.1, §4.5)', () => {
  it('visit: not_found / invalid_target / too_far; the visitor view has no bag slots; the owner sees the count', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, BLADE, 1)
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: false, reason: 'not_found' }) // no stall yet
    h.openStall(a, [{ slot: 1, bag: 0, count: 1, price: 250 }])
    expect(h.req(a, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(b, { t: 'stallVisit', owner: 424242 })).toMatchObject({ ok: false, reason: 'not_found' })
    b.p.known.delete(a.p.id)
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: false, reason: 'not_found' })
    b.p.known.add(a.p.id)
    b.p.pos = [STALL_RANGE + 0.5, 0, 0]
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: false, reason: 'too_far' })
    b.p.pos = [STALL_RANGE - 0.5, 0, 0]
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    const view = h.last(b, 'stall')!.stall!
    expect(view).toMatchObject({ owner: a.p.id, state: 'open', visitors: 1 })
    expect(view.items[1]).toEqual({ stack: { code: BLADE, count: 1 }, price: 250 })
    expect(h.last(a, 'stall')!.stall!.visitors).toBe(1)
    expect(h.last(a, 'stall')!.stall!.items[1]!.bag).toBe(0)
  })

  it('S9: the 9th visitor gets stall_full; a visitor who leaves frees a place', () => {
    const h = harness()
    const a = h.enter()
    expect(h.req(a, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    const vs = Array.from({ length: STALL_VISITORS_MAX }, (_, i) => h.enter([Math.cos(i) * 4, 0, Math.sin(i) * 4]))
    for (const v of vs) expect(h.req(v, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    const ninth = h.enter([0, 0, 5])
    expect(h.req(ninth, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: false, reason: 'stall_full' })
    // re-visiting while already inside is not a new place
    expect(h.req(vs[0], { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    expect(h.req(vs[0], { t: 'stallLeave' })).toMatchObject({ ok: true })
    expect(h.last(vs[0], 'stall')).toEqual({ t: 'stall', stall: null, reason: 'left' })
    expect(h.req(ninth, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    expect(h.last(a, 'stall')!.stall!.visitors).toBe(STALL_VISITORS_MAX)
  })

  it('a new visit leaves the old stall', () => {
    const h = harness()
    const a = h.enter([0, 0, 0])
    const c = h.enter([4, 0, 0])
    const b = h.enter([2, 0, 2])
    expect(h.req(a, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(h.req(c, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'stallVisit', owner: c.p.id })).toMatchObject({ ok: true })
    expect(h.last(a, 'stall')!.stall!.visitors).toBe(0)
    expect(h.last(c, 'stall')!.stall!.visitors).toBe(1)
    expect(h.stalls.visitOf(b.p)).toBe(c.p.id)
    // an owner cannot visit or buy elsewhere (its bag is locked)
    expect(h.req(a, { t: 'stallVisit', owner: c.p.id })).toMatchObject({ ok: false, reason: 'stalling' })
  })

  it('a purchase: gold and item move in one transaction, message order, stallSold, the system line and a social_log row', () => {
    const h = harness()
    const a = h.enter([0, 0, 0], 100)
    const b = h.enter([3, 0, 0], 1000)
    const c = h.enter([-3, 0, 0])
    h.give(a, BLADE, 1, { plus: 3, durability: 7 })
    h.give(a, POTION, 20)
    h.openStall(a, [{ slot: 0, bag: 0, count: 1, price: 600 }, { slot: 1, bag: 1, count: 5, price: 50 }])
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    expect(h.req(c, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    const bFrom = b.inbox.length
    const aFrom = a.inbox.length
    const cFrom = c.inbox.length
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 0, code: BLADE, count: 1, plus: 3, durability: 7, price: 600 })).toMatchObject({ ok: true })
    expect(b.inbox.slice(bFrom).map((m) => m.t)).toEqual(['actionResult', 'inventoryUpdate', 'statsDelta', 'stall'])
    expect(a.inbox.slice(aFrom).map((m) => m.t)).toEqual(['inventoryUpdate', 'statsDelta', 'stallSold', 'chat', 'stall'])
    expect(c.inbox.slice(cFrom).map((m) => m.t)).toEqual(['stall'])
    expect(h.last(a, 'stallSold')).toEqual({ t: 'stallSold', slot: 0, buyer: b.p.name, code: BLADE, count: 1, price: 600 })
    expect(h.last(a, 'chat')).toMatchObject({ channel: 'system', text: `${b.p.name} bought item ${def(BLADE).name} (+3).` })
    expect(h.last(b, 'statsDelta')!.stats.gold).toBe(400)
    expect(h.last(a, 'statsDelta')!.stats.gold).toBe(700)
    expect(b.p.gold).toBe(400)
    expect(a.p.gold).toBe(700)
    expect(h.inv(a).bag[0]).toBeNull()
    expect(h.inv(b).bag.find((i) => i?.code === BLADE)).toEqual({ code: BLADE, count: 1, plus: 3, durability: 7 })
    expect(h.last(c, 'stall')!.stall!.items[0]).toBeNull()
    expect(h.last(a, 'stall')!.stall!.items[1]).toMatchObject({ price: 50 })
    const rows = h.logRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'stall', a_char: b.p.characterId, b_char: a.p.characterId, a_gold: 600, b_gold: 0, a_items: '[]' })
    expect(JSON.parse(rows[0].b_items as string)).toEqual([{ code: BLADE, count: 1, plus: 3, durability: 7 }])
    // part of a stack: the rest stays listed-free in the owner's bag
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 1, code: POTION, count: 5, price: 50 })).toMatchObject({ ok: true })
    expect(h.inv(a).bag[1]).toMatchObject({ code: POTION, count: 15 })
    expect(h.last(a, 'chat')!.text).toBe(`${b.p.name} bought item ${def(POTION).name} x5.`)
    // every stall message the clients got parses
    for (const x of [a, b, c]) for (const m of x.inbox.filter((m) => m.t === 'stall' || m.t === 'stallSold')) expect(parseServerMessage(JSON.stringify(m)), m.t).not.toBeNull()
  })

  it('a broken item can be listed and bought; the buyer gets durability 0 (D47)', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0], 10)
    h.give(a, BLADE, 1, { durability: 0 })
    h.openStall(a, [{ slot: 0, bag: 0, count: 1, price: 10 }])
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 0, code: BLADE, count: 1, durability: 0, price: 10 })).toMatchObject({ ok: true })
    expect(h.inv(b).bag.find((i) => i?.code === BLADE)).toEqual({ code: BLADE, count: 1, plus: 0, durability: 0 })
  })

  it('S1: buying in modify is stall_closed; a price changed in modify then reopened is stall_changed for the stale request', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0], 1000)
    h.give(a, BLADE, 1)
    h.openStall(a, [{ slot: 0, bag: 0, count: 1, price: 100 }])
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'stallOpen', open: false })).toMatchObject({ ok: true })
    expect(h.last(b, 'stall')!.stall!.state).toBe('modify')
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 0, code: BLADE, count: 1, price: 100 })).toMatchObject({ ok: false, reason: 'stall_closed' })
    expect(h.req(a, { t: 'stallItem', slot: 0, bag: 0, count: 1, price: 900 })).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'stallOpen', open: true })).toMatchObject({ ok: true })
    expect(h.last(b, 'stall')!.stall!.items[0]!.price).toBe(900)
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 0, code: BLADE, count: 1, price: 100 })).toMatchObject({ ok: false, reason: 'stall_changed' })
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 0, code: POTION, count: 1, price: 900 })).toMatchObject({ ok: false, reason: 'stall_changed' })
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 0, code: BLADE, count: 2, price: 900 })).toMatchObject({ ok: false, reason: 'stall_changed' })
    expect(h.inv(b).gold).toBe(1000)
    expect(h.inv(a).bag[0]).toMatchObject({ code: BLADE })
    expect(h.logRows()).toHaveLength(0)
  })

  it('S2: a listed slot changed outside the requests (GM item, party share) fails the purchase and nothing moves', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0], 1000)
    h.give(a, BLADE, 1, { plus: 2 })
    h.openStall(a, [{ slot: 0, bag: 0, count: 1, price: 100 }])
    h.store.inventoryTx(a.p.characterId, (d) => {
      d.setBag(0, { code: BLADE, count: 1, plus: 0, durability: null })
      return { ok: true, value: undefined }
    })
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 0, code: BLADE, count: 1, plus: 2, price: 100 })).toMatchObject({ ok: false, reason: 'stall_changed' })
    expect(h.inv(b).gold).toBe(1000)
    expect(h.inv(b).bag.every((i) => i === null)).toBe(true)
    expect(h.inv(a).gold).toBe(0)
    expect(h.logRows()).toHaveLength(0)
    // the stale listing is withdrawn, so nobody else trips on it
    expect(h.last(a, 'stall')!.stall!.items[0]).toBeNull()
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 0, code: BLADE, count: 1, plus: 2, price: 100 })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('S3: two buyers, one listing: the second gets not_found and pays nothing', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0], 500)
    const c = h.enter([-3, 0, 0], 500)
    h.give(a, BLADE, 1)
    h.openStall(a, [{ slot: 0, bag: 0, count: 1, price: 100 }])
    const buy = { t: 'stallBuy', owner: a.p.id, slot: 0, code: BLADE, count: 1, price: 100 } as const
    expect(h.req(b, buy)).toMatchObject({ ok: true })
    expect(h.req(c, buy)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.inv(c).gold).toBe(500)
    expect(h.inv(a).gold).toBe(100)
  })

  it('S5, S6, S12: own stall, not enough gold, the seller at the gold limit, a full bag, too far — nothing moves', () => {
    const h = harness()
    const a = h.enter([0, 0, 0], MAX_GOLD - 50)
    const b = h.enter([3, 0, 0], 99)
    h.give(a, BLADE, 1)
    h.give(a, POTION, 10)
    h.openStall(a, [{ slot: 0, bag: 0, count: 1, price: 100 }, { slot: 1, bag: 1, count: 1, price: 40 }])
    const blade = { t: 'stallBuy', owner: a.p.id, slot: 0, code: BLADE, count: 1, price: 100 } as const
    expect(h.req(a, blade)).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(b, blade)).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    h.store.inventoryTx(b.p.characterId, (d) => addGold(d, 1000))
    expect(h.req(b, blade)).toMatchObject({ ok: false, reason: 'gold_limit' })
    // a full bag: fill every slot of b
    h.store.inventoryTx(b.p.characterId, (d) => {
      for (let i = 0; i < d.bagSize; i++) d.setBag(i, { code: BLADE, count: 1, plus: 0, durability: null })
      return { ok: true, value: undefined }
    })
    expect(h.req(b, { t: 'stallBuy', owner: a.p.id, slot: 1, code: POTION, count: 1, price: 40 })).toMatchObject({ ok: false, reason: 'inventory_full' })
    b.p.pos = [STALL_RANGE + 1, 0, 0]
    expect(h.req(b, blade)).toMatchObject({ ok: false, reason: 'too_far' })
    expect(h.inv(a).gold).toBe(MAX_GOLD - 50)
    expect(h.inv(b).gold).toBe(1099)
    expect(h.inv(a).bag[0]).toMatchObject({ code: BLADE })
    expect(h.inv(a).bag[1]).toMatchObject({ code: POTION, count: 10 })
    expect(h.logRows()).toHaveLength(0)
  })
})

describe('stall module: closing, visits ending, chat', () => {
  it('stallClose: visitors get stall null closed, viewers entityUpdate stall "", the decorator drops the sign', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    const far = h.enter([6, 0, 6])
    expect(h.req(a, { t: 'stallCreate', title: 'X' })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    expect(h.req(a, { t: 'stallClose' })).toMatchObject({ ok: true })
    expect(h.last(b, 'stall')).toEqual({ t: 'stall', stall: null, reason: 'closed' })
    expect(h.last(a, 'stall')).toMatchObject({ stall: null })
    expect(h.last(far, 'entityUpdate')).toEqual({ t: 'entityUpdate', id: a.p.id, stall: '' })
    expect(h.world.state(a.p).stall).toBeUndefined()
    expect(h.stalls.visitOf(b.p)).toBeNull()
    expect(h.req(a, { t: 'stallClose' })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(b, { t: 'stallLeave' })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('the owner logging out closes the stall with reason left (S11: nothing moved, nothing stored)', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, BLADE, 1)
    h.openStall(a, [{ slot: 0, bag: 0, count: 1, price: 10 }])
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    h.leave(a)
    expect(h.last(b, 'stall')).toEqual({ t: 'stall', stall: null, reason: 'left' })
    expect(h.stalls.stalls.size).toBe(0)
    expect(h.store.loadInventory(a.p.characterId).bag[0]).toMatchObject({ code: BLADE })
  })

  it('the owner dying or warping closes the stall; a closed stall can be opened again', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    expect(h.req(a, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    h.gameplay.playerDied(a.p, Date.now())
    expect(h.last(b, 'stall')).toEqual({ t: 'stall', stall: null, reason: 'closed' })
    expect(h.stalls.stallOf(a.p)).toBeUndefined()
    // stallClose is allowed while dead (and says there is none)
    expect(h.req(a, { t: 'stallClose' })).toMatchObject({ ok: false, reason: 'not_found' })
    h.req(a, { t: 'respawn' })
    expect(h.req(a, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    // GM tp of a stall owner (the gameplay warped hook)
    h.world.warp(a.p, 30, 0, 0)
    h.gameplay.warped(a.p, 'gm')
    expect(h.last(b, 'stall')).toEqual({ t: 'stall', stall: null, reason: 'closed' })
    expect(h.last(b, 'entityUpdate')).toMatchObject({ id: a.p.id, stall: '' })
  })

  it('a visit ends when the visitor walks beyond STALL_BREAK_RANGE (too_far), dies or warps (left), or logs out', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    const c = h.enter([-3, 0, 0])
    const d = h.enter([0, 0, 3])
    expect(h.req(a, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    for (const x of [b, c, d]) expect(h.req(x, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    let now = Date.now() + 1000
    b.p.pos = [STALL_BREAK_RANGE - 0.1, 0, 0]
    h.gameplay.tick(now)
    expect(h.stalls.visitOf(b.p)).toBe(a.p.id)
    b.p.pos = [STALL_BREAK_RANGE + 0.1, 0, 0]
    now += 1000
    h.gameplay.tick(now)
    expect(h.last(b, 'stall')).toEqual({ t: 'stall', stall: null, reason: 'too_far' })
    h.gameplay.playerDied(c.p, now)
    expect(h.last(c, 'stall')).toEqual({ t: 'stall', stall: null, reason: 'left' })
    expect(h.last(a, 'stall')!.stall!.visitors).toBe(1)
    h.leave(d)
    expect(h.last(a, 'stall')!.stall!.visitors).toBe(0)
    // the stall itself stays
    expect(h.stalls.stallOf(a.p)).toBeDefined()
  })

  it('stall chat reaches the owner and the visitors only; without a stall chat.ts answers bad_request', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    const out = h.enter([4, 0, 4])
    expect(h.req(a, { t: 'stallCreate', title: '' })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'stallVisit', owner: a.p.id })).toMatchObject({ ok: true })
    expect(h.stalls.chat(b.p, 'how much?')).toBe(true)
    expect(h.stalls.chat(a.p, 'cheap')).toBe(true)
    const line = { t: 'chat', channel: 'stall', fromId: b.p.id, from: b.p.name, text: 'how much?' }
    expect(a.inbox).toContainEqual(line)
    expect(b.inbox).toContainEqual(line)
    expect(b.inbox).toContainEqual({ t: 'chat', channel: 'stall', fromId: a.p.id, from: a.p.name, text: 'cheap' })
    expect(out.inbox.some((m) => m.t === 'chat')).toBe(false)
    // chat.ts: a sender with no stall gets error bad_request
    const errors: unknown[] = []
    const conn = { player: out.p, takeChat: () => true, error: (...e: unknown[]) => errors.push(e), game: { gameplay: h.gameplay } } as unknown as Connection
    expect(routeChat(conn, { t: 'chat', text: 'hi', channel: 'stall' }, 'hi')).toBe(true)
    expect(errors).toEqual([['bad_request', 'You have no stall open.', 'chat']])
  })
})

// S13 (a purchase during a trade) is refused by the trade module's gate (`stallBuy` is outside the trade allowlist,
// docs/SYSTEMS_SOCIAL.md §2.3; lane TR-S), not by this module; I8/H8 cover it with both modules live.
