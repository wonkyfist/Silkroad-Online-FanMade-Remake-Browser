/**
 * Player trade, server module (docs/SYSTEMS_SOCIAL.md §3, §2.3, §10.5; lane TR-S) on a Gameplay harness over FlatNav:
 * request / decline / expire / withdraw, the accept re-check, the full exchange with its message order, the swap in
 * the database and the `social_log` row, the anti-bait rule over the wire, each end reason (move, distance, death,
 * warp, forget, cancel, attack / npcTalk), the inventory lock (every locked request type answers `trading`), a failed
 * commit moving nothing, and pairTx rolling back on a throw.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GAMEPLAY_REQUESTS,
  TRADE_REQUESTS,
  TRADE_REQUEST_MS,
  TRADE_SLOTS,
  type ClientMessage,
  type GameplayRequest,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { addGold, done, fail, type InvItem } from '../src/inventory.ts'
import type { GameplayModule } from '../src/modules.ts'
import { FlatNav } from '../src/nav.ts'
import { logSocial, pairTx } from '../src/social/pair-tx.ts'
import { TRADE_ALLOWED, TRADE_BREAKERS } from '../src/social/trade.ts'
import { World, type Player } from '../src/world.ts'
import { testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const POTION = 'ITEM_ETC_HP_POTION_01'
const BLADE = 'ITEM_CH_BLADE_02_A'
const STARTER = 'ITEM_CH_SWORD_01_A_DEF'
/** The fixture items, with the starter kit untradable as in the export (D50). */
const TRADE_ITEMS = ITEMS.map((d) => (d.code.endsWith('_DEF') ? { ...d, canTrade: false } : d))

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

interface P {
  p: Player
  inbox: ServerMessage[]
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'sro-trade-'))
  const logs: string[] = []
  const config = { ...testConfig(root, logs), rng: seeded(3) }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG], items: TRADE_ITEMS, levels: LEVELS, drops: DROPS, npcs: NPCS, shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(3) })
  gameplay.start()
  let n = 0
  /** A new character in the world (every player knows every other: interest is not under test). */
  const enter = (pos: Vec3 = [0, 0, 0]): P => {
    const acc = store.createAccount(`tracc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Trader${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    return rejoin(row.id, pos)
  }
  const rejoin = (characterId: number, pos: Vec3 = [0, 0, 0]): P => {
    const row = store.characterById(characterId)!
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
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
  const req = (x: P, msg: ClientMessage, now = Date.now()) => {
    const before = x.inbox.length
    gameplay.request(x.p, msg as Extract<ClientMessage, { t: GameplayRequest }>, now)
    const res = x.inbox.slice(before).filter((m): m is Msg<'actionResult'> => m.t === 'actionResult')
    expect(res.length, msg.t).toBe(1)
    return res[0]!
  }
  /** Puts items in bag slots and sets the gold (one transaction). */
  const give = (x: P, items: Record<number, InvItem>, gold = 0) => {
    const { draft } = store.inventoryTx(x.p.characterId, (d) => {
      for (const [slot, it] of Object.entries(items)) d.setBag(Number(slot), it)
      if (gold) addGold(d, gold)
      return done(0)
    })
    x.p.gold = draft.gold
  }
  const bag = (x: P) => store.loadInventory(x.p.characterId)
  const logRows = () => store.db.prepare('SELECT kind, a_char, b_char, a_gold, b_gold, a_items, b_items FROM social_log ORDER BY id').all() as Record<string, unknown>[]
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, world, gameplay, data, config, logs, enter, rejoin, leave, req, give, bag, logRows }
}

type H = ReturnType<typeof harness>

const last = <T extends ServerMessage['t']>(x: P, t: T) => x.inbox.filter((m): m is Msg<T> => m.t === t).at(-1)
const all = <T extends ServerMessage['t']>(x: P, t: T) => x.inbox.filter((m): m is Msg<T> => m.t === t)
const item = (code: string, count = 1, plus = 0, durability: number | null = null): InvItem => ({ code, count, plus, durability })

/** a asks b, b accepts: an open exchange. */
function open(h: H, a: P, b: P, now = Date.now()) {
  expect(h.req(a, { t: 'tradeRequest', target: b.p.id }, now)).toMatchObject({ ok: true })
  expect(h.req(b, { t: 'tradeRespond', from: a.p.id, accept: true }, now)).toMatchObject({ ok: true })
  expect(h.gameplay.trade.isTrading(a.p) && h.gameplay.trade.isTrading(b.p)).toBe(true)
}

describe('requests', () => {
  it('tradeRequested reaches the invitee; a decline tells the requester', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    expect(h.req(a, { t: 'tradeRequest', target: b.p.id })).toEqual({ t: 'actionResult', re: 'tradeRequest', ok: true })
    expect(last(b, 'tradeRequested')).toEqual({ t: 'tradeRequested', from: a.p.id, name: a.p.name, level: 1, expiresInMs: TRADE_REQUEST_MS })
    expect(h.req(b, { t: 'tradeRespond', from: a.p.id, accept: false })).toMatchObject({ ok: true })
    expect(last(a, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'declined', name: b.p.name })
    expect(h.gameplay.trade.isTrading(a.p)).toBe(false)
    expect(h.req(b, { t: 'tradeRespond', from: a.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
  })

  it('refusals: yourself, unknown, not a player, dead, too far, a second request (T12)', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    const c = h.enter([4, 0, 0])
    const far = h.enter([30, 0, 0])
    const npc = [...h.world.npcs.values()][0]!
    a.p.known.add(npc.id)
    expect(h.req(a, { t: 'tradeRequest', target: a.p.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(a, { t: 'tradeRequest', target: 99999 })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(a, { t: 'tradeRequest', target: npc.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(a, { t: 'tradeRequest', target: far.p.id })).toMatchObject({ ok: false, reason: 'too_far' })
    b.p.dead = true
    expect(h.req(a, { t: 'tradeRequest', target: b.p.id })).toMatchObject({ ok: false, reason: 'invalid_target', message: `${b.p.name} is dead.` })
    b.p.dead = false
    expect(h.req(a, { t: 'tradeRequest', target: b.p.id })).toMatchObject({ ok: true })
    expect(h.req(c, { t: 'tradeRequest', target: b.p.id })).toMatchObject({ ok: false, reason: 'cooldown' })
    // An invisible GM cannot be asked (T10).
    far.p.pos = [2, 0, 0]
    far.p.invisible = true
    expect(h.req(a, { t: 'tradeRequest', target: far.p.id })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('a request expires after 30 s on the tick: both sides hear it', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    const t0 = 1_000_000
    h.req(a, { t: 'tradeRequest', target: b.p.id }, t0)
    h.gameplay.tick(t0 + TRADE_REQUEST_MS - 1)
    expect(last(a, 'tradeEnd')).toBeUndefined()
    h.gameplay.tick(t0 + TRADE_REQUEST_MS)
    expect(last(a, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'expired', name: b.p.name })
    expect(last(b, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'expired', name: a.p.name })
    expect(h.req(b, { t: 'tradeRespond', from: a.p.id, accept: true }, t0 + TRADE_REQUEST_MS)).toMatchObject({ ok: false, reason: 'no_invite' })
  })

  it('tradeCancel withdraws a pending request; a new request replaces the older one', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    const c = h.enter([-3, 0, 0])
    h.req(a, { t: 'tradeRequest', target: b.p.id })
    h.req(a, { t: 'tradeRequest', target: c.p.id })
    expect(last(b, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'expired', name: a.p.name })
    expect(h.gameplay.trade.pendingFor(b.p.characterId)).toBeUndefined()
    expect(h.req(a, { t: 'tradeCancel' })).toMatchObject({ ok: true })
    expect(last(c, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'cancelled', name: a.p.name })
    expect(h.req(c, { t: 'tradeRespond', from: a.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
    expect(h.req(a, { t: 'tradeCancel' })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('a stale `from` after a relog -> no_invite (T15); leaving ends the request for the other side', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.req(a, { t: 'tradeRequest', target: b.p.id })
    expect(h.req(b, { t: 'tradeRespond', from: a.p.id + 1000, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
    h.leave(a)
    expect(last(b, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'expired', name: a.p.name })
    const again = h.rejoin(a.p.characterId, [2, 0, 0])
    expect(h.req(b, { t: 'tradeRespond', from: again.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
  })

  it('dead: a decline still answers, an accept answers dead (the request stays)', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.req(a, { t: 'tradeRequest', target: b.p.id })
    b.p.dead = true
    expect(h.req(b, { t: 'tradeRespond', from: a.p.id, accept: true })).toMatchObject({ ok: false, reason: 'dead' })
    expect(h.req(b, { t: 'tradeRespond', from: a.p.id, accept: false })).toMatchObject({ ok: true })
    expect(last(a, 'tradeEnd')).toMatchObject({ reason: 'declined' })
  })
})

describe('opening an exchange', () => {
  it('both get the full state: partner on top, own bag slots only on the own side', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, { 0: item(POTION, 20) }, 500)
    open(h, a, b)
    const empty = { items: Array(TRADE_SLOTS).fill(null), gold: 0, locked: false, accepted: false }
    expect(last(a, 'trade')).toEqual({ t: 'trade', trade: { partner: b.p.id, name: b.p.name, level: 1, mine: empty, theirs: empty } })
    expect(last(b, 'trade')!.trade.partner).toBe(a.p.id)
    expect(h.req(a, { t: 'tradeOffer', bag: 0, count: 5 })).toMatchObject({ ok: true })
    expect(last(a, 'trade')!.trade.mine.items[0]).toEqual({ stack: { code: POTION, count: 5 }, bag: 0 })
    expect(last(b, 'trade')!.trade.theirs.items[0]).toEqual({ stack: { code: POTION, count: 5 } })
  })

  it('the accept re-checks both sides: a requester who walked off -> too_far, and the requester hears failed', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.req(a, { t: 'tradeRequest', target: b.p.id })
    a.p.pos = [20, 0, 0]
    expect(h.req(b, { t: 'tradeRespond', from: a.p.id, accept: true })).toMatchObject({ ok: false, reason: 'too_far' })
    expect(last(a, 'tradeEnd')).toMatchObject({ reason: 'failed', name: b.p.name })
    expect(h.gameplay.trade.isTrading(a.p)).toBe(false)
  })

  it('one trade per player (T4): a trading player cannot be asked, and cannot ask', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    const c = h.enter([-3, 0, 0])
    open(h, a, b)
    expect(h.req(c, { t: 'tradeRequest', target: a.p.id })).toMatchObject({ ok: false, reason: 'trading' })
    // The trade's own requests are not gated; the module refuses a second exchange.
    expect(h.req(a, { t: 'tradeRequest', target: c.p.id })).toMatchObject({ ok: false, reason: 'trading' })
  })

  it("another module's lock on the partner (a stall) refuses the request with its reason", () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    const stall: GameplayModule = { name: 'fake-stall', gate: (q) => (q.id === b.p.id ? fail('stalling') : null) }
    ;(h.gameplay.modules as GameplayModule[]).push(stall)
    expect(h.req(a, { t: 'tradeRequest', target: b.p.id })).toMatchObject({ ok: false, reason: 'stalling', message: `${b.p.name} is running a stall.` })
  })

  it('opening drops the other requests waiting on either trader', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    const c = h.enter([-3, 0, 0])
    h.req(c, { t: 'tradeRequest', target: a.p.id })
    h.req(a, { t: 'tradeRequest', target: b.p.id })
    h.req(b, { t: 'tradeRespond', from: a.p.id, accept: true })
    expect(last(c, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'expired', name: a.p.name })
    // ... without closing a's fresh window.
    expect(all(a, 'tradeEnd')).toEqual([])
    expect(h.req(a, { t: 'tradeRespond', from: c.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
  })
})

describe('the exchange', () => {
  it('offer, gold, lock, accept: the swap commits in one transaction, in the §3.4 message order, and is logged', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, { 0: item(POTION, 30), 1: item(BLADE, 1, 5, 17) }, 1000)
    h.give(b, { 2: item(POTION, 10) }, 200)
    open(h, a, b)
    h.req(a, { t: 'tradeOffer', bag: 0, count: 20 })
    h.req(a, { t: 'tradeOffer', bag: 1 })
    h.req(a, { t: 'tradeGold', amount: 500 })
    h.req(b, { t: 'tradeGold', amount: 50 })
    // Accepting before both locks.
    expect(h.req(a, { t: 'tradeAccept' })).toMatchObject({ ok: false, reason: 'not_complete' })
    h.req(a, { t: 'tradeLock' })
    expect(last(b, 'trade')!.trade.theirs.locked).toBe(true)
    h.req(b, { t: 'tradeLock' })
    h.req(b, { t: 'tradeAccept' })
    expect(last(a, 'trade')!.trade.theirs.accepted).toBe(true)
    // An offer cannot change once locked.
    expect(h.req(a, { t: 'tradeTake', slot: 0 })).toMatchObject({ ok: false, reason: 'trading' })
    const fromA = a.inbox.length
    const fromB = b.inbox.length
    expect(h.req(a, { t: 'tradeAccept' })).toMatchObject({ ok: true })
    expect(a.inbox.slice(fromA).map((m) => m.t)).toEqual(['actionResult', 'inventoryUpdate', 'statsDelta', 'tradeEnd'])
    expect(b.inbox.slice(fromB).map((m) => m.t)).toEqual(['inventoryUpdate', 'statsDelta', 'tradeEnd'])
    expect(last(a, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'done', name: b.p.name })
    expect(last(b, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'done', name: a.p.name })
    expect(last(a, 'statsDelta')).toEqual({ t: 'statsDelta', stats: { gold: 550 } })
    expect(last(b, 'statsDelta')).toEqual({ t: 'statsDelta', stats: { gold: 650 } })
    // The database: a kept 10 potions and got nothing else; b's potions merged, the +5 blade kept its durability (D47).
    expect(h.bag(a).bag.slice(0, 3)).toEqual([item(POTION, 10), null, null])
    expect(h.bag(a).gold).toBe(550)
    expect(h.bag(b).bag.slice(0, 3)).toEqual([item(BLADE, 1, 5, 17), null, item(POTION, 30)])
    expect(h.bag(b).gold).toBe(650)
    expect(a.p.gold).toBe(550)
    expect(h.gameplay.trade.isTrading(a.p) || h.gameplay.trade.isTrading(b.p)).toBe(false)
    expect(h.logRows()).toEqual([{
      kind: 'trade', a_char: a.p.characterId, b_char: b.p.characterId, a_gold: 500, b_gold: 50,
      a_items: JSON.stringify([{ code: POTION, count: 20 }, { code: BLADE, count: 1, plus: 5, durability: 17 }]), b_items: '[]',
    }])
  })

  it("the anti-bait rule over the wire (T1): b's change drops a's lock, and a must lock again", () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(b, { 0: item(BLADE, 1, 5), 1: item(BLADE, 1, 0) })
    h.give(a, {}, 100)
    open(h, a, b)
    h.req(b, { t: 'tradeOffer', bag: 0 })
    h.req(a, { t: 'tradeGold', amount: 100 })
    h.req(a, { t: 'tradeLock' })
    expect(last(a, 'trade')!.trade.mine.locked).toBe(true)
    h.req(b, { t: 'tradeTake', slot: 0 })
    h.req(b, { t: 'tradeOffer', bag: 1 })
    expect(last(a, 'trade')!.trade.mine).toMatchObject({ locked: false, accepted: false })
    expect(last(a, 'trade')!.trade.theirs.items[0]).toEqual({ stack: { code: BLADE, count: 1 } })
    h.req(b, { t: 'tradeLock' })
    expect(h.req(b, { t: 'tradeAccept' })).toMatchObject({ ok: false, reason: 'not_complete' })
  })

  it('refusals: a non-tradable item (T11), an empty trade (T14), gold not held, lock twice, not trading', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, { 0: item(STARTER) }, 10)
    expect(h.req(a, { t: 'tradeOffer', bag: 0 })).toMatchObject({ ok: false, reason: 'not_found' })
    open(h, a, b)
    expect(h.req(a, { t: 'tradeOffer', bag: 0 })).toEqual({ t: 'actionResult', re: 'tradeOffer', ok: false, reason: 'not_usable', message: 'The selected item cannot be traded.' })
    expect(h.req(a, { t: 'tradeOffer', bag: 5 })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(a, { t: 'tradeGold', amount: 11 })).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    h.req(a, { t: 'tradeLock' })
    expect(h.req(a, { t: 'tradeLock' })).toMatchObject({ ok: false, reason: 'trading' })
    h.req(b, { t: 'tradeLock' })
    expect(h.req(a, { t: 'tradeAccept' })).toMatchObject({ ok: false, reason: 'not_usable', message: 'There is nothing to trade.' })
  })

  it('lock and accept need the partner within 10 m', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, {}, 10)
    open(h, a, b)
    h.req(a, { t: 'tradeGold', amount: 10 })
    b.p.pos = [12, 0, 0]
    expect(h.req(a, { t: 'tradeLock' })).toMatchObject({ ok: false, reason: 'too_far' })
    b.p.pos = [3, 0, 0]
    h.req(a, { t: 'tradeLock' })
    h.req(b, { t: 'tradeLock' })
    b.p.pos = [12, 0, 0]
    expect(h.req(b, { t: 'tradeAccept' })).toMatchObject({ ok: false, reason: 'too_far' })
  })

  it('a changed item fails the commit (T2, T8): both hear why, nothing moves, nothing is logged', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, { 0: item(BLADE, 1, 5) })
    h.give(b, {}, 300)
    open(h, a, b)
    h.req(a, { t: 'tradeOffer', bag: 0 })
    h.req(b, { t: 'tradeGold', amount: 300 })
    for (const x of [a, b]) h.req(x, { t: 'tradeLock' })
    h.req(a, { t: 'tradeAccept' })
    // A path that is not a request (a GM, a party share) changes the offered slot.
    h.give(a, { 0: item(BLADE, 1, 0) })
    expect(h.req(b, { t: 'tradeAccept' })).toMatchObject({ ok: true })
    for (const x of [a, b]) expect(last(x, 'tradeEnd')).toMatchObject({ reason: 'failed', message: 'An item in the exchange changed.' })
    expect(h.bag(a).bag[0]).toEqual(item(BLADE, 1, 0))
    expect(h.bag(a).gold).toBe(0)
    expect(h.bag(b).gold).toBe(300)
    expect(h.bag(b).bag.every((s) => s === null)).toBe(true)
    expect(h.logRows()).toEqual([])
    expect(h.gameplay.trade.isTrading(a.p)).toBe(false)
  })

  it("a receiver's full bag fails the commit, naming them", () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, { 0: item(BLADE, 1, 1), 1: item(BLADE, 1, 2) })
    const size = h.bag(b).bagSize
    // b's bag has room for one stack when the offers are made...
    h.give(b, Object.fromEntries(Array.from({ length: size - 2 }, (_, i) => [i, item(POTION, 1)])))
    open(h, a, b)
    h.req(a, { t: 'tradeOffer', bag: 0 })
    h.req(a, { t: 'tradeOffer', bag: 1 })
    for (const x of [a, b]) h.req(x, { t: 'tradeLock' })
    // ... and none at the commit (a potion arrived).
    h.give(b, { [size - 2]: item(POTION, 1) })
    h.req(a, { t: 'tradeAccept' })
    h.req(b, { t: 'tradeAccept' })
    expect(last(a, 'tradeEnd')).toMatchObject({ reason: 'failed', message: `Cannot exchange because [${b.p.name}]'s inventory is full.` })
    expect(h.bag(a).bag.slice(0, 2)).toEqual([item(BLADE, 1, 1), item(BLADE, 1, 2)])
  })
})

describe('ends', () => {
  const setup = () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    open(h, a, b)
    return { h, a, b }
  }

  it('a client moveTo of either side -> moved', () => {
    const { h, a, b } = setup()
    expect(h.gameplay.onMoveTo(b.p)).toBe(true)
    for (const x of [a, b]) expect(last(x, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'moved', name: b.p.name })
    expect(h.gameplay.trade.isTrading(a.p)).toBe(false)
  })

  it('attack, useSkill and npcTalk end the trade and go through (the gate returns null)', () => {
    for (const msg of [{ t: 'attack', target: 99999 }, { t: 'useSkill', skill: 'SKILL_X' }, { t: 'npcTalk', npc: 99999 }] as ClientMessage[]) {
      const { h, a, b } = setup()
      const r = h.req(a, msg)
      expect(r.reason, msg.t).not.toBe('trading')
      expect(last(b, 'tradeEnd'), msg.t).toMatchObject({ reason: 'moved', name: a.p.name })
    }
  })

  it('the 1 Hz tick: beyond 15 m, or a partner turning invisible -> too_far (T10)', () => {
    const { h, a, b } = setup()
    const t0 = 5_000_000
    b.p.pos = [14, 0, 0]
    h.gameplay.tick(t0)
    expect(h.gameplay.trade.isTrading(a.p)).toBe(true)
    b.p.pos = [19, 0, 0]
    h.gameplay.tick(t0 + 500)
    expect(h.gameplay.trade.isTrading(a.p)).toBe(true)
    h.gameplay.tick(t0 + 1000)
    expect(last(a, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'too_far', name: b.p.name })
    expect(last(b, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'too_far', name: a.p.name })
    const again = setup()
    again.b.p.invisible = true
    again.h.gameplay.tick(t0)
    expect(last(again.a, 'tradeEnd')).toMatchObject({ reason: 'too_far' })
  })

  it('death -> dead (T13), warp -> moved, cancel -> cancelled', () => {
    const one = setup()
    one.h.gameplay.playerDied(one.a.p, Date.now())
    expect(last(one.b, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'dead', name: one.a.p.name })
    const two = setup()
    two.h.gameplay.toTown(two.b.p)
    expect(last(two.a, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'moved', name: two.b.p.name })
    const three = setup()
    expect(three.h.req(three.b, { t: 'tradeCancel' })).toMatchObject({ ok: true })
    for (const x of [three.a, three.b]) expect(last(x, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'cancelled', name: three.b.p.name })
    // Cancelling works while dead.
    const four = setup()
    four.a.p.dead = true
    expect(four.h.req(four.a, { t: 'tradeCancel' })).toMatchObject({ ok: true })
  })

  it('leaving the world -> left for the partner (T5); the leaver gets nothing', () => {
    const { h, a, b } = setup()
    const before = a.inbox.length
    h.leave(a)
    expect(last(b, 'tradeEnd')).toEqual({ t: 'tradeEnd', reason: 'left', name: a.p.name })
    expect(a.inbox.slice(before).some((m) => m.t === 'tradeEnd')).toBe(false)
    expect(h.gameplay.trade.isTrading(b.p)).toBe(false)
  })
})

describe('the inventory lock (§2.3)', () => {
  it('every request outside the allowlist answers trading while a window is open (T2, T7)', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    open(h, a, b)
    const locked = GAMEPLAY_REQUESTS.filter((t) => !TRADE_REQUESTS.includes(t) && !TRADE_ALLOWED.has(t) && !TRADE_BREAKERS.has(t) && t !== 'respawn')
    for (const t of ['itemMove', 'itemSplit', 'itemEquip', 'itemUnequip', 'itemUse', 'itemDrop', 'pickup', 'shopBuy', 'shopSell', 'shopBuyback',
      'storageDeposit', 'storageWithdraw', 'storageMove', 'storageGold', 'questAccept', 'questTurnIn', 'questTalk', 'questUseItem',
      'stallCreate', 'stallBuy', 'stallVisit', 'guildCreate', 'repair', 'alchemyReinforce', 'alchemyCancel', 'mountRide', 'berserk', 'sit'] as GameplayRequest[]) {
      expect(locked, t).toContain(t)
    }
    for (const t of locked) {
      // The gate answers before the handler reads any field.
      expect(h.req(a, { t } as ClientMessage).reason, t).toBe('trading')
    }
    expect(h.gameplay.trade.isTrading(a.p)).toBe(true)
    // The allowlist passes (checked at the gate, without running the handlers).
    for (const t of TRADE_ALLOWED) expect(h.gameplay.trade.gate(a.p, t, Date.now()), t).toBeNull()
    expect(h.gameplay.trade.gate(a.p, 'moveTo', Date.now())).toBeNull()
    expect(h.gameplay.trade.isTrading(a.p)).toBe(true)
    // A future request type is locked by default.
    expect(h.gameplay.trade.gate(a.p, 'someFutureRequest' as GameplayRequest, Date.now())).toMatchObject({ reason: 'trading' })
    // Nobody else is locked.
    const c = h.enter([6, 0, 0])
    expect(h.gameplay.trade.gate(c.p, 'itemMove', Date.now())).toBeNull()
  })
})

describe('pairTx', () => {
  it('rolls back on a throw: both inventories and the log untouched', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.give(a, { 0: item(POTION, 5) }, 100)
    // A throw inside fn.
    expect(() => pairTx(h.store, a.p.characterId, b.p.characterId, (da, db) => {
      da.setBag(0, null)
      db.setBag(0, item(POTION, 5))
      throw new Error('boom')
    })).toThrow('boom')
    // A throw in extra (the log row breaks the kind CHECK) after both drafts were written.
    expect(() => pairTx(h.store, a.p.characterId, b.p.characterId, (da, db) => {
      da.setBag(0, null)
      addGold(da, -100)
      db.setBag(0, item(POTION, 5))
      addGold(db, 100)
      return done(1)
    }, () => logSocial(h.store, { kind: 'bogus' as 'trade', aChar: a.p.characterId, bChar: b.p.characterId, aGold: 100, bGold: 0, aItems: [], bItems: [] }))).toThrow()
    expect(h.bag(a).bag[0]).toEqual(item(POTION, 5))
    expect(h.bag(a).gold).toBe(100)
    expect(h.bag(b).bag[0]).toBeNull()
    expect(h.bag(b).gold).toBe(0)
    expect(h.logRows()).toEqual([])
  })
})
