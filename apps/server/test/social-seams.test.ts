/**
 * Wave-8 server seams (docs/WAVE_PLAN2.md §4.2, §6.1 W8-F; docs/SYSTEMS_SOCIAL.md §2.3, §10.2): the module `gate` (order,
 * own-handles exemption, an allowlist gate refuses a request type it does not know, a throwing gate allows, a gated
 * moveTo is dropped and the position stays), the §2.5 module list, the 34 new requests answering `not_implemented`
 * through their stub modules (whileDead lists included), `stats.hwan` from the saved points (D33, D34), the NPC
 * services 'repair' / 'guild', the guild and stall chat branches, and the world info fields.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMBAT_W8_REQUESTS,
  GAMEPLAY_REQUESTS,
  GUILD_REQUESTS,
  STALL_REQUESTS,
  TRADE_REQUESTS,
  type ClientMessage,
  type GameplayRequest,
  type NpcDef,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { routeChat } from '../src/chat.ts'
import { W8_DEFAULTS, knob, loadConfig } from '../src/config.ts'
import type { Connection } from '../src/connection.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay, type GameplayMessage } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { COMMANDS } from '../src/gm.ts'
import { addGold, fail, type Fail } from '../src/inventory.ts'
import { askGates, type GameplayModule } from '../src/modules.ts'
import { FlatNav } from '../src/nav.ts'
import { World, type Player } from '../src/world.ts'
import { bitsToPerms, permsToBits } from '../src/social/guild-rules.ts'
import { pairTx } from '../src/social/pair-tx.ts'
import { testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const EXTRA_NPCS: NpcDef[] = [
  { code: 'NPC_CH_GENARAL_SP', name: 'Leebaek', x: 10, z: 0, yaw: 0, world: 'jangan', model: null, provenance: 'client' },
  { code: 'NPC_CH_SMITH', name: 'Chulsan', x: 12, z: 0, yaw: 0, world: 'jangan', model: null, provenance: 'client', roles: ['repair'] },
]

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'sro-social-seams-'))
  const logs: string[] = []
  const config = { ...testConfig(root, logs), rng: seeded(3) }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: [...NPCS, ...EXTRA_NPCS], shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(3) })
  gameplay.start()
  let n = 0
  const enter = (pos: Vec3 = [0, 0, 0]) => {
    const acc = store.createAccount(`acc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Hero${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    return { p, inbox }
  }
  const req = (p: Player, inbox: ServerMessage[], msg: ClientMessage) => {
    gameplay.request(p, msg as GameplayMessage)
    return inbox.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === msg.t).at(-1)
  }
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, world, gameplay, data, config, logs, enter, req }
}

/** Adds a module after the registered ones (gate asked last). */
function addModule(gameplay: Gameplay, m: GameplayModule): void {
  ;(gameplay.modules as GameplayModule[]).push(m)
}

/** One minimal valid frame per wave-8 request type. */
const FRAMES: Record<string, ClientMessage> = {
  mountRide: { t: 'mountRide', cos: 1 },
  mountDismount: { t: 'mountDismount' },
  mountDismiss: { t: 'mountDismiss' },
  repair: { t: 'repair', npc: 1 },
  alchemyReinforce: { t: 'alchemyReinforce', item: 0, elixir: 1 },
  alchemyCancel: { t: 'alchemyCancel' },
  berserk: { t: 'berserk' },
  tradeRequest: { t: 'tradeRequest', target: 1 },
  tradeRespond: { t: 'tradeRespond', from: 1, accept: false },
  tradeOffer: { t: 'tradeOffer', bag: 0 },
  tradeTake: { t: 'tradeTake', slot: 0 },
  tradeGold: { t: 'tradeGold', amount: 0 },
  tradeLock: { t: 'tradeLock' },
  tradeAccept: { t: 'tradeAccept' },
  tradeCancel: { t: 'tradeCancel' },
  stallCreate: { t: 'stallCreate', title: '' },
  stallItem: { t: 'stallItem', slot: 0, bag: 0, count: 1, price: 1 },
  stallItemRemove: { t: 'stallItemRemove', slot: 0 },
  stallText: { t: 'stallText', title: 'x' },
  stallOpen: { t: 'stallOpen', open: true },
  stallClose: { t: 'stallClose' },
  stallVisit: { t: 'stallVisit', owner: 1 },
  stallLeave: { t: 'stallLeave' },
  stallBuy: { t: 'stallBuy', owner: 1, slot: 0, code: 'ITEM_X', count: 1, price: 1 },
  guildCreate: { t: 'guildCreate', npc: 1, name: 'Tigers' },
  guildDisband: { t: 'guildDisband', npc: 1 },
  guildInvite: { t: 'guildInvite', name: 'Hero2' },
  guildRespond: { t: 'guildRespond', guild: 1, accept: false },
  guildLeave: { t: 'guildLeave' },
  guildKick: { t: 'guildKick', member: 1 },
  guildPerms: { t: 'guildPerms', member: 1, perms: [] },
  guildTitle: { t: 'guildTitle', member: 1, title: '' },
  guildNotice: { t: 'guildNotice', title: '', text: '' },
  guildMaster: { t: 'guildMaster', member: 1 },
}
const W8 = [...COMBAT_W8_REQUESTS, ...TRADE_REQUESTS, ...STALL_REQUESTS, ...GUILD_REQUESTS]

describe('the gate seam', () => {
  it('is asked in registration order; the first Fail wins', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    const asked: string[] = []
    const gate = (name: string, veto: Fail | null): GameplayModule => ({ name, gate: (_p, t) => (asked.push(`${name}:${t}`), veto) })
    addModule(h.gameplay, gate('first', null))
    addModule(h.gameplay, gate('second', fail('trading')))
    addModule(h.gameplay, gate('third', fail('stalling')))
    expect(h.req(p, inbox, { t: 'itemMove', from: 0, to: 1 })).toMatchObject({ ok: false, reason: 'trading' })
    expect(asked).toEqual(['first:itemMove', 'second:itemMove'])
    // A module's request is refused before it runs: no effect, one actionResult.
    expect(inbox.filter((m) => m.t === 'actionResult')).toHaveLength(1)
  })

  it("never asks a module about its own handles; core requests ask every module", () => {
    const h = harness()
    const { p, inbox } = h.enter()
    const asked: string[] = []
    // The trade stub's gate refuses everything except its own requests, which it is never asked about.
    Object.assign(h.gameplay.trade, { gate: (_p: Player, t: GameplayRequest | 'moveTo') => (asked.push(t), fail('trading')) })
    cleanups.push(() => delete (h.gameplay.trade as Partial<GameplayModule>).gate)
    // I8: the trade module is real now; a cancel with nothing open answers not_found (it still ran: no gate asked).
    expect(h.req(p, inbox, { t: 'tradeCancel' })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(asked).toEqual([])
    expect(h.req(p, inbox, { t: 'stopAction' })).toMatchObject({ ok: false, reason: 'trading' })
    expect(h.req(p, inbox, { t: 'stallClose' })).toMatchObject({ ok: false, reason: 'trading' })
    expect(asked).toEqual(['stopAction', 'stallClose'])
  })

  it('an allowlist gate refuses a request type it does not know (a future type is locked by default)', () => {
    const h = harness()
    const { p } = h.enter()
    const ALLOWED = new Set<string>(['stopAction', 'hotbarSet', 'statUp', 'skillLearn', 'masteryUp', 'buffCancel'])
    const locked = new Set<number>([p.id])
    const lock: GameplayModule = { name: 'lock', gate: (q, t) => (locked.has(q.id) && !ALLOWED.has(t) ? fail('trading') : null) }
    const report = () => {}
    expect(askGates([lock], null, p, 'stopAction', 0, report)).toBeNull()
    expect(askGates([lock], null, p, 'itemMove', 0, report)).toMatchObject({ reason: 'trading' })
    expect(askGates([lock], null, p, 'someFutureRequest' as GameplayRequest, 0, report)).toMatchObject({ reason: 'trading' })
    expect(askGates([lock], null, p, 'moveTo', 0, report)).toMatchObject({ reason: 'trading' })
    // The module itself is exempt.
    expect(askGates([lock], lock, p, 'itemMove', 0, report)).toBeNull()
  })

  it('a throwing gate is logged and allows', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    addModule(h.gameplay, { name: 'broken', gate: () => { throw new Error('boom') } })
    expect(h.req(p, inbox, { t: 'stopAction' })).toMatchObject({ ok: true })
    expect(h.logs.some((l) => l.includes('broken.gate') && l.includes('boom'))).toBe(true)
    // ... and a later module's veto still counts.
    addModule(h.gameplay, { name: 'later', gate: () => fail('stalling') })
    expect(h.req(p, inbox, { t: 'stopAction' })).toMatchObject({ ok: false, reason: 'stalling' })
  })

  it('a gated moveTo is dropped: no move, no moved hook, the position and the action stay', () => {
    const h = harness()
    const { p, inbox } = h.enter([5, 0, 5])
    const moved: number[] = []
    addModule(h.gameplay, { name: 'watch', moved: (q) => moved.push(q.id) })
    p.action = { kind: 'talk', npc: 1, chaseAt: 0, chaseTo: null }
    expect(h.gameplay.onMoveTo(p)).toBe(true)
    expect(p.action).toBeNull()
    expect(moved).toEqual([p.id])
    addModule(h.gameplay, { name: 'stall', gate: (_q, t) => (t === 'moveTo' ? fail('stalling') : null) })
    p.action = { kind: 'talk', npc: 1, chaseAt: 0, chaseTo: null }
    const before = inbox.length
    expect(h.gameplay.onMoveTo(p)).toBe(false)
    expect(p.action).toMatchObject({ kind: 'talk' })
    expect(moved).toEqual([p.id])
    expect(p.pos).toEqual([5, 0, 5])
    expect(p.move).toBeNull()
    expect(inbox.length).toBe(before)
  })

  it('the dead check comes first; respawn is never gated', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    const asked: string[] = []
    addModule(h.gameplay, { name: 'lock', gate: (_q, t) => (asked.push(t), fail('stalling')) })
    p.dead = true
    expect(h.req(p, inbox, { t: 'itemMove', from: 0, to: 1 })).toMatchObject({ ok: false, reason: 'dead' })
    expect(h.req(p, inbox, { t: 'respawn' })).toMatchObject({ ok: true })
    expect(asked).toEqual([])
  })
})

describe('the wave-8 modules', () => {
  it('register in the §2.5 order and route every new request type', () => {
    const h = harness()
    expect(h.gameplay.modules.map((m) => m.name).slice(8)).toEqual(['mobSkills', 'mounts', 'durability', 'repairs', 'alchemy', 'berserk', 'trade', 'stalls', 'guilds', 'weather', 'movement', 'uniques', 'pilot'])
    expect(W8).toHaveLength(34)
    expect(new Set(Object.keys(FRAMES))).toEqual(new Set(W8))
    for (const t of W8) expect(GAMEPLAY_REQUESTS).toContain(t)
    const route = (t: GameplayRequest) => h.gameplay.routes.get(t)?.name
    for (const t of ['mountRide', 'mountDismount', 'mountDismiss'] as const) expect(route(t)).toBe('mounts')
    expect(route('repair')).toBe('repairs')
    expect(route('alchemyReinforce')).toBe('alchemy')
    expect(route('berserk')).toBe('berserk')
    for (const t of TRADE_REQUESTS) expect(route(t)).toBe('trade')
    for (const t of STALL_REQUESTS) expect(route(t)).toBe('stalls')
    for (const t of GUILD_REQUESTS) expect(route(t)).toBe('guilds')
  })

  // I8: the lanes filled every stub, so "answers not_implemented" became "reaches its module": exactly one
  // actionResult per request and never not_implemented (the answers themselves are the lanes' tests).
  it('every new request reaches its module and answers exactly once', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    for (const t of W8) {
      const before = inbox.length
      const r = h.req(p, inbox, FRAMES[t]!)
      expect(r, t).toBeDefined()
      expect(r!.reason, t).not.toBe('not_implemented')
      expect(inbox.slice(before).filter((m) => m.t === 'actionResult'), t).toHaveLength(1)
    }
  })

  it('whileDead: the §3.2.6 list reaches its module, everything else answers dead', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    p.dead = true
    const whileDead = new Set(['mountDismiss', 'alchemyCancel', 'tradeCancel', 'tradeRespond', 'stallClose', 'stallLeave', 'guildRespond', 'guildLeave', 'guildKick', 'guildPerms', 'guildTitle', 'guildNotice', 'guildMaster'])
    for (const t of W8) {
      const reason = h.req(p, inbox, FRAMES[t]!)?.reason
      if (whileDead.has(t)) expect(reason, t).not.toBe('dead')
      else expect(reason, t).toBe('dead')
    }
  })

  it('stats carry hwan from the saved points (D33, D34): the first stats after a relog is right', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.gameplay.sendEnter(p)
    expect(inbox.find((m): m is Msg<'stats'> => m.t === 'stats')!.stats.hwan).toBe(0)
    h.gameplay.forget(p)
    h.world.remove(p.id)
    h.store.setHwanPoints(p.characterId, 4)
    const again: ServerMessage[] = []
    const q = h.world.add({ ...h.gameplay.playerInit(h.store.characterById(p.characterId)!), characterId: p.characterId, name: p.name, model: p.model, level: 1, weapon: p.weapon, pos: [0, 0, 0], yaw: 0, send: (m) => again.push(m) })
    h.gameplay.sendEnter(q)
    expect(again[0]).toMatchObject({ t: 'stats', stats: { hwan: 4 } })
  })

  it("mob swings, busy and ranged keep today's behaviour; dealHits accepts extra.dot", () => {
    const h = harness()
    const { p, inbox } = h.enter([50, 0, 50])
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 51, 51, 0, null, Date.now())
    expect(h.gameplay.ranged(m, p, 5)).toBe(false)
    expect(h.gameplay.mobSkills.busy(m, Date.now())).toBe(false)
    h.gameplay.swing(m, p)
    expect(inbox.some((x) => x.t === 'combat' && x.attacker === m.id && x.target === p.id)).toBe(true)
    const r = h.gameplay.dealHits(m, p, [{ outcome: 'hit', damage: 1, hp: 0 }], { skill: 'X', dot: true }, Date.now())
    expect(r.hits).toHaveLength(1)
    const last = inbox.filter((x): x is Msg<'combat'> => x.t === 'combat').at(-1)!
    expect(last).toMatchObject({ skill: 'X' })
    expect('dot' in last).toBe(false)
  })

  it("NPC services: 'repair' from NpcDef.roles, 'guild' at the Guild Manager", () => {
    const h = harness()
    const npc = (code: string) => [...h.world.npcs.values()].find((x) => x.code === code)!
    expect(h.gameplay.npcs.servicesOf(null, npc('NPC_CH_SMITH'))).toEqual(['repair'])
    expect(h.gameplay.npcs.servicesOf(null, npc('NPC_CH_GENARAL_SP'))).toEqual(['guild'])
    expect(h.gameplay.npcs.servicesOf(null, npc('NPC_CH_POTION'))).toEqual(['shop'])
  })

  it('the six GM commands exist and answer through the modules', () => {
    for (const cmd of ['horse', 'hwan', 'dur', 'plus', 'mobskill', 'guilds']) expect(COMMANDS[cmd], cmd).toBeDefined()
    // None collides with a client chat prefix (docs/WAVE_PLAN2.md D9, D42).
    for (const prefix of ['sitdown', 'dismount', 'unsummon', 'trade', 'exchange', 'stall', 'guild', 'g', 'join']) expect(COMMANDS[prefix], prefix).toBeUndefined()
  })
})

describe('chat branches (guild, stall)', () => {
  function conn(h: ReturnType<typeof harness>, player: Player | null) {
    const errors: { code: string; message: string }[] = []
    const c = { player, game: { gameplay: h.gameplay, world: h.world }, takeChat: () => true, error: (code: string, message: string) => errors.push({ code, message }) }
    return { c: c as unknown as Connection, errors }
  }
  it("route 'guild' and 'stall' lines to their modules; none yet -> bad_request", () => {
    const h = harness()
    const { p } = h.enter()
    for (const channel of ['guild', 'stall'] as const) {
      const { c, errors } = conn(h, p)
      expect(routeChat(c, { t: 'chat', text: 'hi', channel }, 'hi')).toBe(true)
      expect(errors).toMatchObject([{ code: 'bad_request' }])
      const out = conn(h, null)
      expect(routeChat(out.c, { t: 'chat', text: 'hi', channel }, 'hi')).toBe(true)
      expect(out.errors).toMatchObject([{ code: 'not_in_world' }])
    }
  })
})

describe('config and helpers', () => {
  it('the §2.4 knobs: defaults, env names and ranges', () => {
    const c = loadConfig({ WORLD_EXPORT: 'jangan' })
    for (const [k, v] of Object.entries(W8_DEFAULTS)) expect(c[k as keyof typeof W8_DEFAULTS], k).toBe(v)
    expect(loadConfig({ WORLD_EXPORT: 'jangan', ALCHEMY_RATE: '2', GUILD_CREATE_GOLD: '500', MOB_SKILL_DAMAGE: 'retail', STALL_TOWN_ONLY: '0' })).toMatchObject({
      alchemyRate: 2, guildCreateGold: 500, mobSkillDamage: 'retail', stallTownOnly: 0,
    })
    for (const [key, bad] of [['ALCHEMY_MAX_PLUS', '13'], ['HWAN_DURATION_MS', '999'], ['GUILD_MAX_MEMBERS', '1'], ['MOB_SKILL_DAMAGE', 'huge'], ['COS_PARK_RANGE_M', '4']]) {
      expect(() => loadConfig({ WORLD_EXPORT: 'jangan', [key]: bad }), key).toThrow(key)
    }
    // Test configs leave the knobs out: knob() falls back to the default.
    expect(knob(testConfig('/tmp/x'), 'alchemyMaxPlus')).toBe(10)
  })

  it('guild rights bitmask (bit i = GUILD_PERMS[i])', () => {
    expect(permsToBits([])).toBe(0)
    expect(permsToBits(['invite', 'title'])).toBe(0b1001)
    expect(bitsToPerms(15)).toEqual(['invite', 'kick', 'notice', 'title'])
    expect(bitsToPerms(permsToBits(['kick', 'notice']))).toEqual(['kick', 'notice'])
  })

  it('pairTx: both drafts in one transaction; a failure writes nothing; the same character throws', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    h.store.inventoryTx(a.p.characterId, (d) => addGold(d, 100))
    const logged: number[] = []
    const r = pairTx(h.store, a.p.characterId, b.p.characterId, (da, db) => {
      addGold(da, -40)
      addGold(db, 40)
      return { ok: true, value: 40 }
    }, (v) => logged.push(v))
    expect(r.result).toEqual({ ok: true, value: 40 })
    expect(logged).toEqual([40])
    expect(h.store.loadInventory(a.p.characterId).gold).toBe(60)
    expect(h.store.loadInventory(b.p.characterId).gold).toBe(40)
    const no = pairTx(h.store, a.p.characterId, b.p.characterId, (da) => {
      da.setGold(0)
      return fail('not_enough_gold')
    }, () => logged.push(-1))
    expect(no.result.ok).toBe(false)
    expect(h.store.loadInventory(a.p.characterId).gold).toBe(60)
    expect(logged).toEqual([40])
    expect(() => pairTx(h.store, a.p.characterId, a.p.characterId, () => ({ ok: true, value: 0 }))).toThrow()
  })
})
