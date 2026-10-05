/**
 * Wave-3 server seams (docs/WAVE_PLAN.md §3.1, §4.2): request routing to the gameplay modules, the dead allowlist,
 * the hook fan-out (moved, stopped, playerDied, warped including GM tp/summon, ...), World.decorators, chat routing,
 * the strict gold cap, and the v4 -> v6 migration of an existing database.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { GAMEPLAY_REQUESTS, MAX_GOLD, type ClientMessage, type GameplayRequest, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { routeChat } from '../src/chat.ts'
import type { Connection } from '../src/connection.ts'
import type { WorldSetup } from '../src/content.ts'
import { SCHEMA_VERSION, migrate, openStore } from '../src/db.ts'
import type { GameContext } from '../src/game.ts'
import { CORE_REQUESTS, Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { COMMANDS } from '../src/gm.ts'
import { InvDraft, MAX_GOLD as INV_MAX_GOLD, addGold, stackable } from '../src/inventory.ts'
import { buildRoutes, fanOut, type GameplayModule, type WarpReason } from '../src/modules.ts'
import { FlatNav } from '../src/nav.ts'
import { HIDDEN_NPCS } from '../src/npc.ts'
import { World, type Player } from '../src/world.ts'
import { testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'sro-modules-'))
  const logs: string[] = []
  const config = { ...testConfig(root, logs), rng: seeded(5) }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: NPCS, shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(5) })
  let n = 0
  const enter = (pos: Vec3) => {
    const acc = store.createAccount(`acc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Hero${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    return { p, inbox }
  }
  const result = (inbox: ServerMessage[], re: GameplayRequest) => inbox.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === re).at(-1)
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, world, gameplay, data, setup, config, logs, enter, result }
}

/** A module that records every hook call (name + player/mob id + extra). */
function spyModule(name = 'spy') {
  const calls: string[] = []
  const m: GameplayModule = {
    name,
    enter: (p) => calls.push(`enter:${p.id}`),
    moved: (p) => calls.push(`moved:${p.id}`),
    stopped: (p) => calls.push(`stopped:${p.id}`),
    tickPlayer: (p) => calls.push(`tickPlayer:${p.id}`),
    tick: () => calls.push('tick'),
    playerDied: (p) => calls.push(`playerDied:${p.id}`),
    warped: (p, reason: WarpReason) => calls.push(`warped:${p.id}:${reason}`),
    inventoryChanged: (p) => calls.push(`inventoryChanged:${p.id}`),
    mobDied: (mob, _now, credit) => calls.push(`mobDied:${mob.id}:${[...credit].join(',')}`),
    forget: (p) => calls.push(`forget:${p.id}`),
  }
  return { m, calls }
}

function addModule(gameplay: Gameplay, m: GameplayModule): void {
  ;(gameplay.modules as GameplayModule[]).push(m)
}

describe('routing', () => {
  it('every GameplayRequest is answered by the core or by exactly one module', () => {
    const h = harness()
    const owners = new Map<GameplayRequest, string[]>()
    for (const t of CORE_REQUESTS) owners.set(t, ['core'])
    for (const m of h.gameplay.modules) for (const t of m.handles ?? []) owners.set(t, [...(owners.get(t) ?? []), m.name])
    for (const t of GAMEPLAY_REQUESTS) expect(owners.get(t), t).toHaveLength(1)
    expect([...owners.keys()].sort()).toEqual([...GAMEPLAY_REQUESTS].sort())
    expect(h.gameplay.routes.get('useSkill')).toBe(h.gameplay.skills)
    expect(h.gameplay.routes.get('hotbarSet')).toBe(h.gameplay.skills)
    expect(h.gameplay.routes.get('npcTalk')).toBe(h.gameplay.npcs)
    expect(h.gameplay.routes.get('shopBuyback')).toBe(h.gameplay.shops)
    expect(h.gameplay.routes.get('storageGold')).toBe(h.gameplay.storage)
    expect(h.gameplay.routes.get('itemUse')).toBe(h.gameplay.itemUses)
    expect(h.gameplay.modules.map((m) => m.name)).toEqual([
      'skills', 'npc', 'shops', 'storage', 'itemUse', 'quests', 'party', 'posture',
      // wave 8 (docs/WAVE_PLAN2.md §2.5)
      'mobSkills', 'mounts', 'durability', 'repairs', 'alchemy', 'berserk', 'trade', 'stalls', 'guilds',
      // wave 9 (docs/WAVE_PLAN3.md §6.1)
      'weather',
      // storm series step 1 (docs/WEATHER.md §2.7): lightning that strikes
      'lightning',
      // storm series step 2 (docs/WEATHER.md §12): storms change everything
      'storm',
      // storm series step 3 (docs/WEATHER.md §13): the lightning tornado
      'tornado',
      // wave 10 (docs/WAVE_PLAN6.md §3): the jump (movement.ts, lane MV-P)
      'movement',
      // wave 11 (docs/WAVE_PLAN7.md §4.2): unique world bosses (uniques.ts, UNIQUES=on by default)
      'uniques',
      // Play the Boss (docs/PLAY_THE_BOSS.md §3.1): after uniques
      'pilot',
    ])
    expect(HIDDEN_NPCS).not.toContain('NPC_CH_WAREHOUSE_M') // Wangu + the storage chest (docs/SHOPS.md §1.3)
    expect(h.gameplay.storage.enabled).toBe(true) // ST-S landed (storage.test.ts)
  })

  it('buildRoutes refuses a request claimed twice, a core request, and whileDead outside handles', () => {
    const request = () => {}
    const a: GameplayModule = { name: 'a', handles: ['npcTalk'], request }
    expect(() => buildRoutes([a, { name: 'b', handles: ['npcTalk'], request }])).toThrow(/a and b both handle npcTalk/)
    expect(() => buildRoutes([{ name: 'c', handles: ['attack'], request }], CORE_REQUESTS)).toThrow(/claims attack/)
    expect(() => buildRoutes([{ name: 'd', handles: ['npcTalk'], whileDead: ['npcClose'], request }])).toThrow(/whileDead npcClose/)
    expect(() => buildRoutes([{ name: 'e', handles: ['npcTalk'] }])).toThrow(/no request/)
    expect(buildRoutes([a]).get('npcTalk')).toBe(a)
  })

  it('each wave-3 request gets exactly one actionResult; the stubs answer not_implemented', () => {
    const h = harness()
    const { p, inbox } = h.enter([0, 0, 0])
    const frames: ClientMessage[] = [
      { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01' },
      { t: 'skillLearn', skill: 'SKILL_CH_SWORD_SMASH_A_01' },
      { t: 'masteryUp', mastery: 'BICHEON' },
      { t: 'buffCancel', skill: 'SKILL_CH_COLD_GANGGI_A_01' },
      { t: 'hotbarSet', slot: 0, entry: null },
      { t: 'npcTalk', npc: 1 },
      { t: 'npcClose' },
      { t: 'storageOpen', npc: 1 },
      { t: 'storageDeposit', npc: 1, bag: 0 },
      { t: 'storageWithdraw', npc: 1, slot: 0 },
      { t: 'storageMove', npc: 1, from: 0, to: 1 },
      { t: 'storageGold', npc: 1, dir: 'deposit', amount: 1 },
      { t: 'shopBuyback', npc: 1, index: 0 },
    ]
    for (const f of frames) h.gameplay.request(p, f as Extract<ClientMessage, { t: GameplayRequest }>, Date.now())
    const results = inbox.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult')
    expect(results.map((r) => r.re)).toEqual(frames.map((f) => f.t))
    for (const r of results) {
      if (r.re.startsWith('storage')) expect(r).toMatchObject({ ok: false, reason: 'not_found' }) // ST-S landed: entity 1 keeps no storage
      else if (r.re === 'npcClose') expect(r).toMatchObject({ ok: true }) // NPC-S landed: closing is always ok
      else if (r.re === 'npcTalk' || r.re === 'shopBuyback') expect(r).toMatchObject({ ok: false, reason: 'not_found' }) // NPC-S: entity 1 is no NPC
      // SK-S landed: no skills.json in this harness (unknown skills), a level-1 character without SP, an empty slot
      else if (r.re === 'masteryUp') expect(r).toMatchObject({ ok: false, reason: 'no_sp' })
      else if (r.re === 'hotbarSet') expect(r).toMatchObject({ ok: true })
      else if (r.re === 'useSkill' || r.re === 'skillLearn' || r.re === 'buffCancel') expect(r).toMatchObject({ ok: false, reason: 'not_found' })
      else expect(r).toMatchObject({ ok: false, reason: 'not_implemented' })
    }
  })

  it("a dead player's npcClose and hotbarSet pass the dead check; shopBuy, useSkill and itemUse get dead", () => {
    const h = harness()
    const { p, inbox } = h.enter([0, 0, 0])
    h.gameplay.gmKill(p)
    expect(p.dead).toBe(true)
    const now = Date.now()
    h.gameplay.request(p, { t: 'npcClose' }, now)
    expect(h.result(inbox, 'npcClose')).toMatchObject({ ok: true })
    h.gameplay.request(p, { t: 'hotbarSet', slot: 3, entry: { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' } }, now)
    expect(h.result(inbox, 'hotbarSet')).toMatchObject({ ok: false, reason: 'not_found' }) // past the dead check (no skills.json here)
    h.gameplay.request(p, { t: 'shopBuy', npc: 1, item: 'ITEM_ETC_HP_POTION_01', count: 1 }, now)
    expect(h.result(inbox, 'shopBuy')).toMatchObject({ ok: false, reason: 'dead' })
    h.gameplay.request(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01' }, now)
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'dead' })
    h.gameplay.request(p, { t: 'itemUse', bag: 0 }, now)
    expect(h.result(inbox, 'itemUse')).toMatchObject({ ok: false, reason: 'dead' })
    h.gameplay.request(p, { t: 'respawn' }, now)
    expect(h.result(inbox, 'respawn')).toMatchObject({ ok: true })
  })

  it('moved shop and item-use code answers as before (buy, sell, potion)', () => {
    const h = harness()
    h.gameplay.start()
    const npc = [...h.world.npcs.values()].find((n) => n.code === 'NPC_CH_POTION')!
    const { p, inbox } = h.enter([npc.pos[0] + 2, 0, npc.pos[2]])
    const now = Date.now()
    h.gameplay.request(p, { t: 'shopBuy', npc: npc.id, item: 'ITEM_ETC_HP_POTION_01', count: 1 }, now)
    expect(h.result(inbox, 'shopBuy')).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    h.gameplay.gmItem(p, null, 'ITEM_ETC_GOLD_01', 100)
    h.gameplay.request(p, { t: 'shopBuy', npc: npc.id, item: 'ITEM_ETC_HP_POTION_01', count: 2 }, now)
    expect(h.result(inbox, 'shopBuy')).toMatchObject({ ok: true })
    expect(p.gold).toBe(60)
    const bag = h.store.loadInventory(p.characterId).bag.findIndex((i) => i?.code === 'ITEM_ETC_HP_POTION_01')
    h.gameplay.request(p, { t: 'shopSell', npc: npc.id, bag, count: 1 }, now)
    expect(h.result(inbox, 'shopSell')).toMatchObject({ ok: true })
    expect(p.gold).toBe(65)
    p.hp = 1
    h.gameplay.request(p, { t: 'itemUse', bag }, now)
    expect(h.result(inbox, 'itemUse')).toMatchObject({ ok: true })
    expect(p.hp).toBe(Math.min(p.maxHp, 101))
    h.gameplay.request(p, { t: 'itemUse', bag }, now + 10)
    expect(h.result(inbox, 'itemUse')).toMatchObject({ ok: false })
  })
})

describe('hook fan-out', () => {
  it('moved, stopped, tickPlayer, tick, inventoryChanged, playerDied, warped(town), enter and forget reach every module', () => {
    const h = harness()
    const a = spyModule('a')
    const b = spyModule('b')
    addModule(h.gameplay, a.m)
    addModule(h.gameplay, b.m)
    const { p, inbox } = h.enter([0, 0, 0])
    const now = Date.now()
    h.gameplay.sendEnter(p, now)
    expect(inbox.map((m) => m.t)).toEqual(['stats', 'inventory', 'skills', 'quests'])
    expect(h.gameplay.onMoveTo(p, now)).toBe(true)
    h.world.moveTo(p, 5, 0, now)
    h.gameplay.request(p, { t: 'stopAction' }, now)
    // the actionResult comes before the modules' stopped effects
    expect(inbox.at(-1)).toMatchObject({ t: 'actionResult', re: 'stopAction', ok: true })
    h.gameplay.tick(now + 50)
    h.gameplay.gmItem(p, null, 'ITEM_ETC_GOLD_01', 10)
    h.gameplay.gmKill(p)
    h.gameplay.tick(now + 100) // dead: no tickPlayer
    expect(h.gameplay.onMoveTo(p, now)).toBe(false) // dead: no moved
    h.gameplay.request(p, { t: 'respawn' }, now + 200)
    h.gameplay.forget(p)
    const id = p.id
    const expected = [
      `enter:${id}`,
      `moved:${id}`,
      `stopped:${id}`,
      `tickPlayer:${id}`,
      'tick',
      `inventoryChanged:${id}`,
      `playerDied:${id}`,
      'tick',
      `warped:${id}:town`,
      `forget:${id}`,
    ]
    expect(a.calls).toEqual(expected)
    expect(b.calls).toEqual(expected)
  })

  it('mobDied gets the players that shared the kill (not for a GM kill)', () => {
    const h = harness()
    const spy = spyModule()
    addModule(h.gameplay, spy.m)
    const { p } = h.enter([0, 0, 0])
    const now = Date.now()
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 1, 0, 0, null, now)
    m.damage.set(p.id, 20)
    h.gameplay.mobDied(m, now, true)
    const m2 = h.gameplay.createMob(MANGNYANG, 'normal', 1, 0, 0, null, now)
    h.gameplay.gmKill(m2, now)
    expect(spy.calls.filter((c) => c.startsWith('mobDied'))).toEqual([`mobDied:${m.id}:${p.id}`])
  })

  it("GM tp and summon fan out warped(p, 'gm')", () => {
    const h = harness()
    const spy = spyModule()
    addModule(h.gameplay, spy.m)
    const gm = h.enter([0, 0, 0])
    const other = h.enter([30, 0, 30])
    const sockets = new Map<number, Connection>([
      [1, { player: gm.p, role: 'gm', account: 'gm', send: () => {} } as unknown as Connection],
      [2, { player: other.p, role: 'player', account: 'other', send: () => {} } as unknown as Connection],
    ])
    const ctx = { world: h.world, gameplay: h.gameplay, setup: h.setup, config: h.config, sockets } as unknown as GameContext
    const conn = sockets.get(1)!
    expect(COMMANDS.tp.run({ ctx, conn, role: 'gm', args: ['10', '12'], self: gm.p }).ok).toBe(true)
    expect(COMMANDS.tp.run({ ctx, conn, role: 'gm', args: [other.p.name], self: gm.p }).ok).toBe(true)
    expect(COMMANDS.summon.run({ ctx, conn, role: 'gm', args: [other.p.name], self: gm.p }).ok).toBe(true)
    expect(spy.calls).toEqual([`warped:${gm.p.id}:gm`, `warped:${gm.p.id}:gm`, `warped:${other.p.id}:gm`])
  })

  it('a throwing module is logged and skipped; the others and the tick still run', () => {
    const h = harness()
    const bad: GameplayModule = {
      name: 'bad',
      tickPlayer: () => {
        throw new Error('boom')
      },
    }
    const good = spyModule('good')
    addModule(h.gameplay, bad)
    addModule(h.gameplay, good.m)
    const { p } = h.enter([0, 0, 0])
    expect(() => h.gameplay.tick(Date.now())).not.toThrow()
    expect(good.calls).toEqual([`tickPlayer:${p.id}`, 'tick'])
    expect(h.logs.some((l) => l.includes('bad.tickPlayer') && l.includes('boom'))).toBe(true)
    const calls: string[] = []
    fanOut([{ name: 'x', forget: () => calls.push('x') }, { name: 'y' }], 'forget', [p], () => {})
    expect(calls).toEqual(['x'])
  })
})

describe('World.decorators', () => {
  it("a decorator's field appears in state(), spawns and worldEnter snapshots; a throwing one is reported", () => {
    const h = harness()
    const errors: unknown[] = []
    h.world.onError = (e) => errors.push(e)
    h.world.decorators.push((e, s) => {
      if (e.kind === 'player') s.gm = true
    })
    h.world.decorators.push(() => {
      throw new Error('bad decorator')
    })
    const a = h.enter([0, 0, 0])
    expect(h.world.state(a.p).gm).toBe(true)
    const b = h.enter([3, 0, 0])
    // b's arrival is spawned for a with the decoration
    const spawn = a.inbox.find((m): m is Msg<'spawn'> => m.t === 'spawn' && m.entity.id === b.p.id)
    expect(spawn?.entity.gm).toBe(true)
    expect(h.world.snapshotFor(b.p).find((s) => s.id === a.p.id)?.gm).toBe(true)
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 1, 0, 0, null, Date.now())
    expect(h.world.state(m).gm).toBeUndefined()
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('chat routing, gold cap', () => {
  it('routeChat takes party and whisper lines and leaves local chat alone (whisper delivery: whisper.test.ts)', () => {
    const errors: string[] = []
    const conn = { error: (code: string, message: string) => errors.push(`${code}:${message}`) } as unknown as Connection
    expect(routeChat(conn, { t: 'chat', text: 'hi' }, 'hi')).toBe(false)
    expect(routeChat(conn, { t: 'chat', text: '/help', channel: 'local' }, '/help')).toBe(false)
    expect(routeChat(conn, { t: 'chat', text: 'hi', channel: 'party' }, 'hi')).toBe(true)
    expect(routeChat(conn, { t: 'chat', text: 'hi', to: 'Friend' }, 'hi')).toBe(true)
    // Wave 4 (PT-S): the party branch needs a player first (party.test.ts / party-e2e.test.ts cover the routing).
    expect(errors).toEqual(['not_in_world:not in the world', 'not_in_world:not in the world'])
  })

  it('MAX_GOLD comes from @sro/shared; addGold clamps by default and fails gold_limit when strict', () => {
    expect(INV_MAX_GOLD).toBe(MAX_GOLD)
    const d = new InvDraft({ bagSize: 4, bag: [null, null, null, null], equip: {}, gold: MAX_GOLD - 1 })
    expect(addGold(d, 5, { strict: true })).toMatchObject({ ok: false, reason: 'gold_limit' })
    expect(d.gold).toBe(MAX_GOLD - 1)
    expect(d.goldChanged).toBe(false)
    expect(addGold(d, 1, { strict: true }).ok).toBe(true)
    expect(addGold(d, 5).ok).toBe(true)
    expect(d.gold).toBe(MAX_GOLD)
    expect(addGold(d, -MAX_GOLD - 1)).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    const potion = ITEMS.find((i) => i.code === 'ITEM_ETC_HP_POTION_01')!
    const it = { code: potion.code, count: 1, plus: 0, durability: null }
    expect(stackable(it, { ...it, count: 3 }, potion)).toBe(true)
    expect(stackable(it, { ...it, plus: 1 }, potion)).toBe(false)
  })
})

describe('config (wave 3)', () => {
  it('reads the wave-3 settings with their defaults and bounds', async () => {
    const { loadConfig } = await import('../src/config.ts')
    // WORLD_EXPORT's default depends on the exports on disk (fields.test.ts); pin it here
    expect(loadConfig({ WORLD_EXPORT: 'jangan' })).toMatchObject({ worldExport: 'jangan', nestCountScale: 1, storageFee: 1, skillAmmo: 0, goldRate: 1 })
    expect(loadConfig({ WORLD_EXPORT: 'jangan-fields', NEST_COUNT_SCALE: '0.01', STORAGE_FEE: '0', SKILL_AMMO: '1', GOLD_RATE: '2' })).toMatchObject({
      world: 'jangan',
      worldExport: 'jangan-fields',
      nestCountScale: 0.1,
      storageFee: 0,
      skillAmmo: 1,
      goldRate: 2,
    })
    expect(() => loadConfig({ WORLD_EXPORT: 'Jangan_Fields' })).toThrow(/WORLD_EXPORT/)
    expect(() => loadConfig({ SKILL_AMMO: '2' })).toThrow(/SKILL_AMMO/)
  })
})

describe('migrations v5 (skills) and v6 (storage)', () => {
  it('upgrades a copy of a v4 database, keeping its data', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-migrate-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const v4Dir = join(root, 'v4')
    const copyDir = join(root, 'copy')
    mkdirSync(v4Dir)
    mkdirSync(copyDir)
    const v4 = new Database(join(v4Dir, 'game.db'))
    expect(migrate(v4, 4)).toBe(4)
    v4.exec(`INSERT INTO accounts (id, username, password_hash, created_at, role) VALUES (1, 'veteran', 'x', 1, 'gm');
      INSERT INTO characters (id, account_id, name, model, weapon, level, world, created_at, gold, height, nav_surface) VALUES (1, 1, 'Ryu', 'CHAR_CH_MAN_ADVENTURER', 'spear', 7, 'jangan', 1, 1234, 3, 't');
      INSERT INTO items (character_id, bag_slot, code, count) VALUES (1, 0, 'ITEM_ETC_HP_POTION_01', 7);`)
    expect(v4.pragma('user_version', { simple: true })).toBe(4)
    v4.close()
    copyFileSync(join(v4Dir, 'game.db'), join(copyDir, 'game.db'))

    const store = openStore(copyDir)
    try {
      expect(SCHEMA_VERSION).toBe(14)
      expect(store.schemaVersion).toBe(14)
      expect(store.db.pragma('user_version', { simple: true })).toBe(14)
      // old data intact
      expect(store.characterById(1)).toMatchObject({ name: 'Ryu', level: 7, gold: 1234, height: 3, nav_surface: 't' })
      expect(store.loadInventory(1).bag[0]).toMatchObject({ code: 'ITEM_ETC_HP_POTION_01', count: 7 })
      expect(store.accountRole(1)).toBe('gm')
      // v5 tables
      const cols = (t: string) => (store.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
      expect(cols('char_masteries')).toEqual(['character_id', 'code', 'level'])
      expect(cols('char_skills')).toEqual(['character_id', 'grp', 'level'])
      expect(cols('char_hotbar')).toEqual(['character_id', 'slot', 'kind', 'code'])
      store.db.prepare("INSERT INTO char_masteries VALUES (1, 'BICHEON', 20)").run()
      store.db.prepare("INSERT INTO char_skills VALUES (1, 'SKILL_CH_SWORD_SMASH_A', 1)").run()
      store.db.prepare("INSERT INTO char_hotbar VALUES (1, 39, 'item', 'ITEM_ETC_HP_POTION_01')").run()
      expect(() => store.db.prepare("INSERT INTO char_masteries VALUES (1, 'HEUKSAL', 301)").run()).toThrow(/CHECK/)
      expect(() => store.db.prepare("INSERT INTO char_skills VALUES (1, 'SKILL_CH_SWORD_CHAIN_A', 0)").run()).toThrow(/CHECK/)
      expect(() => store.db.prepare("INSERT INTO char_hotbar VALUES (1, 40, 'skill', 'X')").run()).toThrow(/CHECK/)
      expect(() => store.db.prepare("INSERT INTO char_hotbar VALUES (1, 1, 'macro', 'X')").run()).toThrow(/CHECK/)
      expect(() => store.db.prepare("INSERT INTO char_hotbar VALUES (99, 1, 'skill', 'X')").run()).toThrow(/FOREIGN KEY/)
      // v6: storage
      expect(cols('storage_items')).toEqual(['id', 'account_id', 'slot', 'code', 'count', 'plus', 'durability'])
      expect(store.db.prepare('SELECT storage_gold, storage_size FROM accounts WHERE id = 1').get()).toEqual({ storage_gold: 0, storage_size: 150 })
      store.db.prepare("INSERT INTO storage_items (account_id, slot, code, count) VALUES (1, 0, 'ITEM_ETC_HP_POTION_01', 3)").run()
      expect(() => store.db.prepare("INSERT INTO storage_items (account_id, slot, code, count) VALUES (1, 0, 'X', 1)").run()).toThrow(/UNIQUE/)
      expect(() => store.db.prepare("INSERT INTO storage_items (account_id, slot, code, count) VALUES (1, 1, 'X', 0)").run()).toThrow(/CHECK/)
      expect(() => store.db.prepare('UPDATE accounts SET storage_size = 181').run()).toThrow(/CHECK/)
      expect(() => store.db.prepare('UPDATE accounts SET storage_gold = -1').run()).toThrow(/CHECK/)
      expect((store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'storage_items_account'").get() as { name: string }).name).toBe('storage_items_account')
      // writeDraft is exposed (storage-db.ts calls it inside its own transaction)
      const d = new InvDraft(store.loadInventory(1))
      d.setGold(99)
      store.db.transaction(() => store.writeDraft(1, d))()
      expect(store.characterById(1)!.gold).toBe(99)
    } finally {
      store.close()
    }
    // the original v4 file is untouched
    const orig = new Database(join(v4Dir, 'game.db'), { readonly: true })
    expect(orig.pragma('user_version', { simple: true })).toBe(4)
    orig.close()
  })
})
