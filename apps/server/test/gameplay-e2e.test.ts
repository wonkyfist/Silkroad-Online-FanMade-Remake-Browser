/**
 * Gameplay end to end over real WebSockets (docs/PROTOCOL.md): a real server with synthetic content fixtures
 * (test/fixtures.ts) and a seeded RNG. Every frame the clients receive passes the shared strict validator
 * (helpers.ts Client throws on an invalid frame).
 */
import { MAX_BAG_SIZE, type EntityState, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { DROPS, HIGH, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, TIGER, contentFiles, nest, seeded } from './fixtures.ts'
import { NPC_DEFS, NPC_ITEMS, RETURN_03, SHOP_DEFS } from './npc-harness.ts'

const SPAWN: [number, number, number] = [50, 0, -50]
const BOUNDS = { min: [0, 0, -400], max: [400, 0, 0] }
const VIEW = 60
const MANG_NEST = nest(1, MANGNYANG.code, 58, -50, { count: 2, radius: 1, spawnRadius: 1 })
const TIGER_NEST = nest(2, TIGER.code, 50, -150, { radius: 1, spawnRadius: 0, tactics: { id: 2, aggressive: true, sightRange: 20, leashRange: 40 } })
const FAR_NEST = nest(3, MANGNYANG.code, 330, -330)
const HIGH_NEST = nest(4, HIGH.code, 52, -52)

let s: TestServer
const logs: string[] = []

beforeAll(async () => {
  s = await startTestServer({
    logs,
    config: { moveSpeed: 30, tickHz: 20, viewRange: VIEW, rng: seeded(42), mobLevelMax: 25 },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: BOUNDS }),
      ...contentFiles({
        mobs: [MANGNYANG, TIGER, HIGH],
        nests: [MANG_NEST, TIGER_NEST, FAR_NEST, HIGH_NEST],
        items: ITEMS,
        levels: LEVELS,
        drops: DROPS,
        npcs: NPCS,
        shops: SHOPS,
      }),
    },
  })
})

afterAll(async () => {
  await s.stopAndClean()
})

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>
let nameCounter = 0

async function player(opts: { gm?: boolean; weapon?: 'blade' | 'spear'; model?: string } = {}) {
  const acc = await newAccount(s.url, opts.gm ? 'gmg' : 'gp')
  if (opts.gm) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
  const c = await Client.login(s.url, acc.token)
  const name = `Fighter${++nameCounter}`
  c.send({ t: 'charCreate', name, model: opts.model ?? 'CHAR_CH_MAN_ADVENTURER', weapon: opts.weapon ?? 'blade' })
  const ch = (await c.next('charCreated')).character
  c.send({ t: 'enterWorld', id: ch.id })
  const enter = await c.next('worldEnter')
  const stats = (await c.next('stats')).stats
  const inventory = (await c.next('inventory')).inventory
  return { c, ch, acc, enter, stats, inventory, id: enter.self.id, name }
}

async function leaveAll(...cs: Client[]) {
  for (const c of cs) {
    c.close()
    await c.closed
  }
  await sleep(30)
}

/** Sends a gameplay request and returns its actionResult. */
async function act(c: Client, msg: Record<string, unknown> & { t: string }, timeoutMs = 3000): Promise<Msg<'actionResult'>> {
  c.send(msg)
  return c.next('actionResult', (m) => m.re === msg.t, timeoutMs)
}

async function gm(c: Client, cmd: string, ...args: string[]) {
  c.send({ t: 'gm', cmd, args })
  return c.next('gmResult')
}

const mobsIn = (list: EntityState[], code = MANGNYANG.code) => list.filter((e) => e.kind === 'mob' && e.model === code)

/** Attacks `target` until a combat message says it died; returns every combat message seen. */
async function killIt(c: Client, target: number, timeoutMs = 15_000): Promise<Msg<'combat'>[]> {
  expect(await act(c, { t: 'attack', target })).toMatchObject({ ok: true })
  const seen: Msg<'combat'>[] = []
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const m = await c.next('combat', (x) => x.target === target, Math.max(1, deadline - Date.now()))
    seen.push(m)
    if (m.killed) return seen
  }
}

describe('world content', () => {
  it('loads the fixtures, logs them, spawns nests in this world and within the level limit', () => {
    expect(logs.some((l) => /content mobs\.json: 3 loaded/.test(l))).toBe(true)
    expect(logs.some((l) => /content skills|content drops\.json: 1 loaded/.test(l))).toBe(true)
    expect(logs.some((l) => /1 NPCs, 3 nests \(1 skipped\), 4 monsters spawned/.test(l))).toBe(true)
    expect(s.ctx.world.mobs.size).toBe(4)
    expect([...s.ctx.world.mobs.values()].map((m) => m.def.code)).not.toContain(HIGH.code)
  })
})

describe('the Mangnyang loop', () => {
  it('kill, EXP and level-up, loot pickup, equip, death to a tiger, respawn in town', async () => {
    const p = await player()
    // enter sequence: worldEnter -> stats -> inventory, starter kit worn
    expect(p.stats).toMatchObject({ level: 1, hp: 200, maxHp: 200, str: 20, int: 20, statPoints: 0, gold: 0, expToNext: 30 })
    expect(p.inventory.bagSize).toBe(48)
    expect(p.inventory.equip).toMatchObject({
      weapon: { code: 'ITEM_CH_BLADE_01_A_DEF', count: 1 },
      chest: { code: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF' },
      legs: { code: 'ITEM_CH_M_CLOTHES_01_LA_A_DEF' },
      feet: { code: 'ITEM_CH_M_CLOTHES_01_FA_A_DEF' },
    })
    expect(p.enter.self).toMatchObject({ kind: 'player', hp: 200, maxHp: 200, equip: { weapon: 'ITEM_CH_BLADE_01_A_DEF' } })
    // interest: the two Mangnyangs and the NPC are in view; the tiger (100 m) and the far nest are not
    const kinds = p.enter.entities.map((e) => `${e.kind}:${e.model}`)
    expect(mobsIn(p.enter.entities)).toHaveLength(2)
    expect(kinds).toContain('npc:NPC_CH_POTION')
    expect(kinds).not.toContain(`mob:${TIGER.code}`)

    const target = mobsIn(p.enter.entities)[0]
    expect(target).toMatchObject({ hp: 20, maxHp: 20, level: 1, name: 'Mangnyang' })
    const hits = await killIt(p.c, target.id)
    expect(hits.at(-1)!.hits.at(-1)!.hp).toBe(0)
    for (const h of hits) expect(h.attacker).toBe(p.id)
    expect(await p.c.next('entityUpdate', (m) => m.id === target.id)).toMatchObject({ hp: 0, state: 'dead' })

    // EXP: 40 (fixture) > 30 needed for level 2
    const delta = await p.c.next('statsDelta', (m) => m.gain !== undefined)
    expect(delta.gain).toEqual({ exp: 40, spExp: 30, from: target.id })
    expect(await p.c.next('levelUp')).toEqual({ t: 'levelUp', id: p.id, level: 2 })
    const lv2 = (await p.c.next('stats')).stats
    expect(lv2).toMatchObject({ level: 2, exp: 10, expToNext: 100, str: 21, int: 21, statPoints: 3, spExp: 30 })
    expect(lv2.hp).toBe(lv2.maxHp)
    expect(s.ctx.store.characterById(p.ch.id)).toMatchObject({ level: 2, exp: 10, stat_points: 3 })

    // loot: a gold pile and the blade, owned by the killer
    const drops = [await p.c.next('spawn', (m) => m.entity.kind === 'item'), await p.c.next('spawn', (m) => m.entity.kind === 'item')].map((m) => m.entity)
    const gold = drops.find((d) => d.model === 'ITEM_ETC_GOLD_01')!
    const blade = drops.find((d) => d.model === 'ITEM_CH_BLADE_02_A')!
    expect(gold.count).toBeGreaterThanOrEqual(10)
    expect(blade).toMatchObject({ owner: p.id, count: 1 })
    expect(blade.ownerUntil! - Date.now()).toBeGreaterThan(20_000)
    expect(blade.expiresAt! - Date.now()).toBeGreaterThan(100_000)

    expect(await act(p.c, { t: 'pickup', id: gold.id })).toMatchObject({ ok: true })
    expect((await p.c.next('inventoryUpdate', (m) => m.gold !== undefined)).gold).toBe(gold.count)
    await p.c.next('despawn', (m) => m.id === gold.id)
    expect(await act(p.c, { t: 'pickup', id: blade.id })).toMatchObject({ ok: true })
    const got = await p.c.next('inventoryUpdate', (m) => (m.bag ?? []).some((b) => b.item?.code === 'ITEM_CH_BLADE_02_A'))
    const slot = got.bag!.find((b) => b.item?.code === 'ITEM_CH_BLADE_02_A')!.slot
    expect(await act(p.c, { t: 'pickup', id: blade.id })).toMatchObject({ ok: false, reason: 'not_found' })

    // equip: the looted blade swaps with the starter blade; stats and appearance follow
    expect(await act(p.c, { t: 'itemEquip', bag: slot })).toMatchObject({ ok: true })
    const eq = await p.c.next('inventoryUpdate', (m) => m.equip !== undefined)
    expect(eq.equip).toEqual([{ slot: 'weapon', item: { code: 'ITEM_CH_BLADE_02_A', count: 1 } }])
    expect(eq.bag).toEqual([{ slot, item: { code: 'ITEM_CH_BLADE_01_A_DEF', count: 1 } }])
    expect((await p.c.next('appearance', (m) => m.id === p.id)).equip.weapon).toBe('ITEM_CH_BLADE_02_A')
    const armed = (await p.c.next('stats')).stats
    expect(armed.physAttack[0]).toBeGreaterThan(lv2.physAttack[0] + 20)
    expect(s.ctx.store.loadInventory(p.ch.id).equip.weapon?.code).toBe('ITEM_CH_BLADE_02_A')

    // walk into the aggressive tiger's sight: it chases and kills us
    p.c.send({ t: 'moveTo', x: 50, z: -140 })
    const tiger = (await p.c.next('spawn', (m) => m.entity.model === TIGER.code, 5000)).entity
    const blow = await p.c.next('combat', (m) => m.attacker === tiger.id && m.killed === true, 10_000)
    expect(blow.target).toBe(p.id)
    expect(await p.c.next('entityUpdate', (m) => m.id === p.id && m.state === 'dead')).toMatchObject({ hp: 0 })
    // dead: everything but respawn is refused, moves are ignored
    expect(await act(p.c, { t: 'attack', target: tiger.id })).toMatchObject({ ok: false, reason: 'dead' })
    expect(await act(p.c, { t: 'itemMove', from: 0, to: 1 })).toMatchObject({ ok: false, reason: 'dead' })
    p.c.queue.length = 0
    p.c.send({ t: 'moveTo', x: 60, z: -60 })
    await sleep(150)
    expect(p.c.queue.some((m) => m.t === 'move' && m.id === p.id)).toBe(false)

    // respawn in town: warp to the spawn, alive, full HP; the tiger goes home
    expect(await act(p.c, { t: 'respawn' })).toMatchObject({ ok: true })
    const warp = await p.c.next('warp', (m) => m.id === p.id)
    expect([warp.pos[0], warp.pos[2]]).toEqual([SPAWN[0], SPAWN[2]])
    expect(await p.c.next('entityUpdate', (m) => m.id === p.id && m.state === 'alive')).toMatchObject({ hp: armed.maxHp })
    expect((await p.c.next('stats')).stats).toMatchObject({ hp: armed.maxHp, level: 2 })
    expect(await act(p.c, { t: 'respawn' })).toMatchObject({ ok: false, reason: 'not_dead' })

    // the nest replaced the dead Mangnyang (1 s respawn)
    await sleep(1600)
    const nestMobs = [...s.ctx.world.mobs.values()].filter((m) => m.nest?.id === MANG_NEST.id && m.ai !== 'dead')
    expect(nestMobs).toHaveLength(2)

    // saved on leave: position in town, alive, the new blade worn
    await leaveAll(p.c)
    expect(s.ctx.store.characterById(p.ch.id)).toMatchObject({ dead: 0, level: 2 })
  }, 40_000)
})

describe('shared world', () => {
  it('two players see the same mob HP; a late joiner sees the damaged HP', async () => {
    const a = await player()
    const b = await player()
    const target = mobsIn(a.enter.entities).find((m) => m.hp === m.maxHp) ?? mobsIn(a.enter.entities)[0]
    expect(await act(a.c, { t: 'attack', target: target.id })).toMatchObject({ ok: true })
    const ca = await a.c.next('combat', (m) => m.target === target.id && m.hits.some((h) => h.damage > 0), 8000)
    const cb = await b.c.next('combat', (m) => m.target === target.id && m.attacker === ca.attacker && m.hits[0].hp === ca.hits[0].hp, 2000)
    expect(cb).toEqual(ca)
    if (!ca.killed) {
      expect(await act(a.c, { t: 'stopAction' })).toMatchObject({ ok: true })
      const hp = ca.hits.at(-1)!.hp
      const late = await player()
      const seen = late.enter.entities.find((e) => e.id === target.id)
      expect(seen?.hp).toBeLessThanOrEqual(hp)
      await leaveAll(late.c)
    }
    await leaveAll(a.c, b.c)
  }, 20_000)
})

describe('interest management', () => {
  it('spawns and despawns entities as they enter and leave the view range', async () => {
    const a = await player()
    const b = await player()
    expect(b.enter.entities.map((e) => e.id)).toContain(a.id)
    const nearIds = new Set(a.enter.entities.map((e) => e.id))
    // walk 90 m east: the Mangnyangs and B fall out of view (> 60 + 10 m), for both sides
    a.c.send({ t: 'moveTo', x: 145, z: -50 })
    const bLost = await b.c.next('despawn', (m) => m.id === a.id, 6000)
    expect(bLost.id).toBe(a.id)
    await a.c.next('despawn', (m) => m.id === b.id, 6000)
    await sleep(300)
    const gone = a.c.queue.filter((m): m is Msg<'despawn'> => m.t === 'despawn').map((m) => m.id)
    expect(gone.filter((id) => nearIds.has(id)).length).toBeGreaterThanOrEqual(2)
    // B's moves no longer reach A
    b.c.send({ t: 'moveTo', x: 52, z: -48 })
    await b.c.next('move', (m) => m.id === b.id)
    await sleep(150)
    expect(a.c.queue.some((m) => m.t === 'move' && m.id === b.id)).toBe(false)
    // walking back brings them back
    a.c.send({ t: 'moveTo', x: 50, z: -50 })
    expect((await a.c.next('spawn', (m) => m.entity.id === b.id, 6000)).entity.name).toBe(b.name)
    await b.c.next('spawn', (m) => m.entity.id === a.id, 2000)
    await leaveAll(a.c, b.c)
  }, 20_000)

  it('a GM teleport swaps the whole view at once', async () => {
    const g = await player({ gm: true })
    expect(mobsIn(g.enter.entities).length).toBeGreaterThan(0)
    const r = await gm(g.c, 'tp', '328', '-328')
    expect(r.ok).toBe(true)
    const far = await g.c.next('spawn', (m) => m.entity.kind === 'mob', 2000)
    expect(far.entity.pos[0]).toBeGreaterThan(300)
    for (const m of mobsIn(g.enter.entities)) await g.c.next('despawn', (x) => x.id === m.id, 2000)
    await leaveAll(g.c)
  })
})

describe('inventory, shop and GM gameplay', () => {
  it('GM item/spawn/kill/heal, shop buy/sell, potion use and cooldown', async () => {
    const g = await player({ gm: true, weapon: 'spear', model: 'CHAR_CH_WOMAN_ADVENTURER' })
    expect(g.inventory.equip).toMatchObject({ weapon: { code: 'ITEM_CH_SPEAR_01_A_DEF' }, chest: { code: 'ITEM_CH_W_CLOTHES_01_BA_A_DEF' } })
    // item: gold and potions
    expect(await gm(g.c, 'item', 'item_etc_gold_01', '500')).toMatchObject({ ok: true, data: { gold: 500 } })
    expect((await g.c.next('inventoryUpdate', (m) => m.gold !== undefined)).gold).toBe(500)
    const added = await gm(g.c, 'item', 'ITEM_ETC_HP_POTION_01', '60')
    expect(added).toMatchObject({ ok: true })
    expect((added.data as { bag: { slot: number; item: { count: number } }[] }).bag.map((b) => b.item.count)).toEqual([50, 10])
    expect((await gm(g.c, 'item', 'ITEM_NOPE')).message).toBe('No item ITEM_NOPE.')

    // shop: the potion merchant is 7 m from the spawn
    const npc = g.enter.entities.find((e) => e.kind === 'npc')!
    expect(await act(g.c, { t: 'shopBuy', npc: npc.id, item: 'ITEM_CH_BLADE_02_A', count: 1 })).toMatchObject({ ok: true })
    expect((await g.c.next('inventoryUpdate', (m) => m.gold !== undefined)).gold).toBe(0)
    expect(await act(g.c, { t: 'shopBuy', npc: npc.id, item: 'ITEM_ETC_HP_POTION_01', count: 1 })).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    expect(await act(g.c, { t: 'shopBuy', npc: npc.id, item: 'ITEM_CH_SHIELD_01_A', count: 1 })).toMatchObject({ ok: false, reason: 'not_found' })
    const inv = s.ctx.store.loadInventory(g.ch.id)
    const bladeSlot = inv.bag.findIndex((i) => i?.code === 'ITEM_CH_BLADE_02_A')
    expect(await act(g.c, { t: 'shopSell', npc: npc.id, bag: bladeSlot })).toMatchObject({ ok: true })
    expect((await g.c.next('inventoryUpdate', (m) => m.gold !== undefined)).gold).toBe(100)
    // a female character cannot wear male clothes; the spear cannot go with a shield
    await gm(g.c, 'item', 'ITEM_CH_M_CLOTHES_01_BA_A_DEF')
    const maleSlot = s.ctx.store.loadInventory(g.ch.id).bag.findIndex((i) => i?.code === 'ITEM_CH_M_CLOTHES_01_BA_A_DEF')
    expect(await act(g.c, { t: 'itemEquip', bag: maleSlot })).toMatchObject({ ok: false, reason: 'requirements' })
    await gm(g.c, 'item', 'ITEM_CH_SHIELD_01_A')
    const shieldSlot = s.ctx.store.loadInventory(g.ch.id).bag.findIndex((i) => i?.code === 'ITEM_CH_SHIELD_01_A')
    expect(await act(g.c, { t: 'itemEquip', bag: shieldSlot })).toMatchObject({ ok: false, reason: 'requirements' })
    const quest = await gm(g.c, 'item', 'ITEM_ETC_QUEST_01')
    const questSlot = (quest.data as { bag: { slot: number }[] }).bag[0].slot
    expect(await act(g.c, { t: 'itemDrop', bag: questSlot })).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(await act(g.c, { t: 'shopSell', npc: npc.id, bag: questSlot })).toMatchObject({ ok: false, reason: 'not_usable' })

    // spawn + kill: the GM kill gives no EXP and no loot
    const spawned = await gm(g.c, 'spawn', 'mob_ch_mangnyang', '3')
    const ids = (spawned.data as { ids: number[] }).ids
    expect(ids).toHaveLength(3)
    for (const id of ids) await g.c.next('spawn', (m) => m.entity.id === id)
    expect(await gm(g.c, 'kill', String(ids[0]))).toMatchObject({ ok: true, data: { id: ids[0] } })
    expect(await g.c.next('entityUpdate', (m) => m.id === ids[0])).toMatchObject({ state: 'dead', hp: 0 })
    await sleep(200)
    expect(g.c.queue.some((m) => m.t === 'statsDelta' && m.gain !== undefined)).toBe(false)
    expect(g.c.queue.some((m) => m.t === 'spawn' && m.entity.kind === 'item')).toBe(false)
    expect((await gm(g.c, 'kill', String(ids[0]))).ok).toBe(false)
    expect((await gm(g.c, 'spawn', 'MOB_CH_NOBODY')).message).toBe('No monster MOB_CH_NOBODY.')

    // the GM kills itself, heals (revives in place), then uses a potion (cooldown on the second)
    expect(await gm(g.c, 'kill', g.name)).toMatchObject({ ok: true })
    await g.c.next('entityUpdate', (m) => m.id === g.id && m.state === 'dead')
    expect(await gm(g.c, 'heal')).toMatchObject({ ok: true, message: `${g.name} is fully healed and alive again.` })
    expect(await g.c.next('entityUpdate', (m) => m.id === g.id && m.state === 'alive')).toMatchObject({ hp: 200 })
    const potSlot = s.ctx.store.loadInventory(g.ch.id).bag.findIndex((i) => i?.code === 'ITEM_ETC_HP_POTION_01')
    expect(await act(g.c, { t: 'itemUse', bag: potSlot })).toMatchObject({ ok: true })
    expect(await act(g.c, { t: 'itemUse', bag: potSlot })).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(s.ctx.store.loadInventory(g.ch.id).bag[potSlot]?.count).toBe(49)
    expect(await act(g.c, { t: 'itemUse', bag: maleSlot })).toMatchObject({ ok: false, reason: 'not_usable' })

    // statUp spends free points (none yet at level 1)
    expect(await act(g.c, { t: 'statUp', stat: 'str', points: 1 })).toMatchObject({ ok: false, reason: 'no_points' })
    await gm(g.c, 'setlevel', g.name, '3')
    await g.c.next('stats', (m) => m.stats.level === 3)
    expect(await act(g.c, { t: 'statUp', stat: 'str', points: 6 })).toMatchObject({ ok: true })
    expect((await g.c.next('stats', (m) => m.stats.level === 3 && m.stats.statPoints === 0)).stats).toMatchObject({ str: 28, statPoints: 0, maxHp: Math.floor(Math.pow(1.02, 2) * 280) })
    for (const id of ids.slice(1)) await gm(g.c, 'kill', String(id))
    await leaveAll(g.c)
  }, 20_000)

  it('dropped items: no owner, exactly one of two simultaneous pickups wins', async () => {
    const g = await player({ gm: true })
    const b = await player()
    await gm(g.c, 'item', 'ITEM_ETC_HP_POTION_01', '5')
    const slot = s.ctx.store.loadInventory(g.ch.id).bag.findIndex((i) => i?.code === 'ITEM_ETC_HP_POTION_01')
    expect(await act(g.c, { t: 'itemDrop', bag: slot, count: 6 })).toMatchObject({ ok: false, reason: 'invalid_count' })
    expect(await act(g.c, { t: 'itemDrop', bag: slot })).toMatchObject({ ok: true })
    const dropped = (await b.c.next('spawn', (m) => m.entity.kind === 'item')).entity
    expect(dropped).toMatchObject({ model: 'ITEM_ETC_HP_POTION_01', count: 5 })
    expect(dropped.owner).toBeUndefined()
    g.c.send({ t: 'pickup', id: dropped.id })
    b.c.send({ t: 'pickup', id: dropped.id })
    const results = [await g.c.next('actionResult', (m) => m.re === 'pickup'), await b.c.next('actionResult', (m) => m.re === 'pickup')]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    await sleep(800) // a walking pickup completes
    const count = (id: number) => s.ctx.store.loadInventory(id).bag.reduce((n, i) => n + (i?.code === 'ITEM_ETC_HP_POTION_01' ? i.count : 0), 0)
    expect(count(g.ch.id) + count(b.ch.id)).toBe(5)
    expect(s.ctx.world.items.has(dropped.id)).toBe(false)
    await leaveAll(g.c, b.c)
  })
})

describe('abuse', () => {
  it('refuses malformed, out-of-range and impossible requests', async () => {
    const p = await player()
    const q = await player()
    // strict validation: bad_request, never reaches gameplay
    for (const bad of [
      { t: 'attack', target: -1 },
      { t: 'attack', target: '5' },
      { t: 'itemMove', from: 0, to: MAX_BAG_SIZE },
      { t: 'itemSplit', from: 0, to: 1, count: 0 },
      { t: 'statUp', stat: 'dex', points: 1 },
      { t: 'itemEquip', bag: 0, slot: 'tail' },
      { t: 'pickup', id: 1, extra: true },
      { t: 'shopBuy', npc: 1, item: 'lower_case', count: 1 },
    ]) {
      p.c.send(bad)
      expect((await p.c.next('error')).code, JSON.stringify(bad)).toBe('bad_request')
    }
    // valid frames the rules refuse
    expect(await act(p.c, { t: 'itemMove', from: 47, to: 60 })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(await act(p.c, { t: 'itemMove', from: 5, to: 6 })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(await act(p.c, { t: 'itemUnequip', slot: 'ring1' })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(await act(p.c, { t: 'statUp', stat: 'int', points: 1000 })).toMatchObject({ ok: false, reason: 'no_points' })
    expect(await act(p.c, { t: 'attack', target: q.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    const npc = p.enter.entities.find((e) => e.kind === 'npc')!
    expect(await act(p.c, { t: 'attack', target: npc.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(await act(p.c, { t: 'attack', target: 999_999 })).toMatchObject({ ok: false, reason: 'not_found' })
    const farMob = [...s.ctx.world.mobs.values()].find((m) => m.nest?.id === FAR_NEST.id)!
    expect(await act(p.c, { t: 'attack', target: farMob.id })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await act(p.c, { t: 'useSkill', skill: 'SKILL_CH_BLADE_01' })).toMatchObject({ ok: false, reason: 'not_found' }) // SK-S: no such skill
    expect(await act(p.c, { t: 'respawn' })).toMatchObject({ ok: false, reason: 'not_dead' })
    expect(await act(p.c, { t: 'shopBuy', npc: q.id, item: 'ITEM_ETC_HP_POTION_01', count: 1 })).toMatchObject({ ok: false, reason: 'not_found' })
    // unequip the weapon, then equip it back; unequip into an occupied slot fails
    expect(await act(p.c, { t: 'itemUnequip', slot: 'weapon', bag: 3 })).toMatchObject({ ok: true })
    expect(await act(p.c, { t: 'itemUnequip', slot: 'chest', bag: 3 })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(await act(p.c, { t: 'itemEquip', bag: 3, slot: 'ring1' })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(await act(p.c, { t: 'itemEquip', bag: 3 })).toMatchObject({ ok: true })
    // someone else's loot is refused during the owner window
    const target = mobsIn(p.enter.entities)[0]
    await killIt(p.c, target.id)
    const loot = (await q.c.next('spawn', (m) => m.entity.kind === 'item' && m.entity.owner === p.id, 5000)).entity
    expect(await act(q.c, { t: 'pickup', id: loot.id })).toMatchObject({ ok: false, reason: 'not_owner' })
    // per-type budget: stopAction is 5/s with a burst of 10
    for (let i = 0; i < 14; i++) p.c.send({ t: 'stopAction' })
    await sleep(200)
    const answers = p.c.queue.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === 'stopAction')
    expect(answers).toHaveLength(14)
    expect(answers.filter((a) => a.reason === 'rate_limited').length).toBeGreaterThanOrEqual(3)
    // in the lobby, gameplay requests are refused
    p.c.send({ t: 'leaveWorld' })
    await p.c.next('worldLeft')
    p.c.send({ t: 'attack', target: 1 })
    expect(await p.c.next('error')).toMatchObject({ code: 'not_in_world', re: 'attack' })
    await leaveAll(p.c, q.c)
  }, 25_000)
})

describe('towns', () => {
  let t: TestServer
  const tlogs: string[] = []
  beforeAll(async () => {
    t = await startTestServer({
      logs: tlogs,
      config: { moveSpeed: 30, tickHz: 20, rng: seeded(5) },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', bounds: BOUNDS }),
        'out/data/towns.json': JSON.stringify({
          schema: 1,
          kind: 'towns',
          entries: [{ code: 'JANGAN', name: 'Jangan', world: 'jangan', spawn: { x: 100, y: 1, z: -100 }, safeArea: { x: 100, z: -100, halfX: 20, halfZ: 20 } }],
        }),
        ...contentFiles({
          mobs: [TIGER],
          nests: [nest(9, TIGER.code, 100, -126, { radius: 1, spawnRadius: 0, tactics: { id: 2, aggressive: true, sightRange: 12, leashRange: 40 } })],
          items: ITEMS,
          levels: LEVELS,
        }),
      },
    })
  })
  afterAll(async () => {
    await t.stopAndClean()
  })

  it('new characters start at the town return point; no fighting inside the safe area', async () => {
    expect(tlogs.some((l) => /spawn 100\.0,-100\.0 from town Jangan \(towns\.json\)/.test(l))).toBe(true)
    const acc = await newAccount(t.url, 'town')
    const c = await Client.login(t.url, acc.token)
    c.send({ t: 'charCreate', name: 'Townie', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    expect(ch.pos).toEqual([100, 1, -100])
    c.send({ t: 'enterWorld', id: ch.id })
    const enter = await c.next('worldEnter')
    const tiger = enter.entities.find((e) => e.model === TIGER.code)!
    // inside the safe area, 8 m from an aggressive tiger with a 12 m sight: it leaves us alone
    c.send({ t: 'moveTo', x: 100, z: -118 })
    await c.next('stop', (m) => m.id === enter.self.id)
    await sleep(800)
    expect(c.queue.some((m) => m.t === 'combat')).toBe(false)
    expect(await act(c, { t: 'attack', target: tiger.id })).toMatchObject({ ok: false, reason: 'safe_zone' })
    // one step outside: it attacks
    c.send({ t: 'moveTo', x: 100, z: -121.5 })
    const blow = await c.next('combat', (m) => m.attacker === tiger.id, 5000)
    expect(blow.target).toBe(enter.self.id)
    await leaveAll(c)
  }, 15_000)
})

describe('NPC dialog, shop, buyback and the return scroll (wave 3, NPC-S)', () => {
  let t: TestServer
  beforeAll(async () => {
    t = await startTestServer({
      config: { moveSpeed: 30, tickHz: 20, rng: seeded(9) },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [-10, 0, 0], bounds: { min: [-200, 0, -200], max: [200, 0, 200] } }),
        ...contentFiles({ mobs: [MANGNYANG], items: NPC_ITEMS, levels: LEVELS, npcs: NPC_DEFS, shops: SHOP_DEFS }),
      },
    })
  })
  afterAll(async () => {
    await t.stopAndClean()
  })

  it('talk (walks 30 m) -> dialog -> buy -> sell -> buyback -> walk away closes; a 5 s return scroll; 11 shopBuy -> rate_limited', async () => {
    const acc = await newAccount(t.url, 'npcs')
    t.ctx.store.setRole(t.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(t.url, acc.token)
    c.send({ t: 'charCreate', name: 'Shopper', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const enter = await c.next('worldEnter')
    const me = enter.self.id
    const potion = enter.entities.find((e) => e.kind === 'npc' && e.model === 'NPC_CH_POTION')!
    expect(enter.entities.some((e) => e.model === 'NPC_CH_WAREHOUSE_M')).toBe(true)
    c.send({ t: 'gm', cmd: 'item', args: ['ITEM_ETC_GOLD_01', '5000'] })
    await c.next('gmResult')

    // talk from 30 m: ok, the walk, the stop, then the dialog and the (empty) buyback list
    expect(await act(c, { t: 'npcTalk', npc: potion.id })).toMatchObject({ ok: true })
    const dialog = await c.next('npcDialog', () => true, 5000)
    expect(dialog).toEqual({ t: 'npcDialog', npc: potion.id, code: 'NPC_CH_POTION', services: ['shop'] })
    expect(await c.next('buyback')).toEqual({ t: 'buyback', entries: [] })
    const log = c.log.map((m) => m.t)
    expect(log.indexOf('move')).toBeLessThan(log.lastIndexOf('stop'))
    expect(log.lastIndexOf('stop')).toBeLessThan(log.indexOf('npcDialog'))

    // buy 10 herbs (200), sell 5 (+25), buy them back (-25)
    expect(await act(c, { t: 'shopBuy', npc: potion.id, item: 'ITEM_ETC_HP_POTION_01', count: 10 })).toMatchObject({ ok: true })
    expect((await c.next('inventoryUpdate', (m) => m.gold === 4800)).gold).toBe(4800)
    const slot = t.ctx.store.loadInventory(ch.id).bag.findIndex((i) => i?.code === 'ITEM_ETC_HP_POTION_01')
    expect(await act(c, { t: 'shopSell', npc: potion.id, bag: slot, count: 5 })).toMatchObject({ ok: true })
    expect((await c.next('inventoryUpdate', (m) => m.gold === 4825)).gold).toBe(4825)
    expect((await c.next('buyback')).entries).toEqual([{ item: { code: 'ITEM_ETC_HP_POTION_01', count: 5 }, price: 25 }])
    expect(await act(c, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: true })
    expect((await c.next('inventoryUpdate', (m) => m.gold === 4800)).gold).toBe(4800)
    expect((await c.next('buyback')).entries).toEqual([])
    expect(await act(c, { t: 'shopBuyback', npc: potion.id, index: 0 })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(t.ctx.store.loadInventory(ch.id).bag[slot]).toMatchObject({ code: 'ITEM_ETC_HP_POTION_01', count: 10 })

    // 11 purchases back to back: the burst is 10, so the 11th is refused (rate_limited, not a strike)
    await sleep(2100) // let the bucket refill after the purchase above
    for (let i = 0; i < 11; i++) c.send({ t: 'shopBuy', npc: potion.id, item: 'ITEM_ETC_HP_POTION_01', count: 1 })
    const answers: Msg<'actionResult'>[] = []
    for (let i = 0; i < 11; i++) answers.push(await c.next('actionResult', (m) => m.re === 'shopBuy'))
    expect(answers.filter((a) => a.ok)).toHaveLength(10)
    expect(answers.at(-1)).toMatchObject({ ok: false, reason: 'rate_limited' })

    // walking away closes the dialog by itself
    c.send({ t: 'moveTo', x: -40, z: 0 })
    expect(await c.next('npcDialogClose', () => true, 5000)).toEqual({ t: 'npcDialogClose', npc: potion.id, reason: 'too_far' })
    await sleep(1500) // arrived and standing

    // the 5 s return scroll: itemCast, then itemCastEnd done before the warp to town
    c.send({ t: 'gm', cmd: 'item', args: [RETURN_03.code] })
    await c.next('gmResult')
    const scroll = t.ctx.store.loadInventory(ch.id).bag.findIndex((i) => i?.code === RETURN_03.code)
    const t0 = Date.now()
    expect(await act(c, { t: 'itemUse', bag: scroll })).toMatchObject({ ok: true })
    expect(await c.next('itemCast')).toEqual({ t: 'itemCast', id: me, item: RETURN_03.code, castMs: 5000 })
    expect(await c.next('itemCastEnd', () => true, 8000)).toMatchObject({ id: me, reason: 'done' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900)
    const warp = await c.next('warp', (m) => m.id === me)
    expect(warp.pos[0]).toBeCloseTo(-10)
    expect(c.log.findIndex((m) => m.t === 'itemCastEnd')).toBeLessThan(c.log.indexOf(warp))
    expect(t.ctx.store.loadInventory(ch.id).bag[scroll]).toBeNull()
    await leaveAll(c)
  }, 30_000)
})
