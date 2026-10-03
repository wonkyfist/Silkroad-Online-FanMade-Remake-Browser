/**
 * NPC dialogs, shops and consumables on the REAL export (work/out/data; docs/SHOPS.md §1-§4 numbers): the rules in a
 * flat world with a controlled clock, then the talk walks on the real navmesh over sockets. Skipped without the export.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NPC_INTERACT_RANGE } from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'
import { seeded } from './fixtures.ts'
import { npcHarness, type NpcHarness } from './npc-harness.ts'

const OUT = join(REPO_ROOT, 'work/out')
const HAVE = ['items.json', 'npcs.json', 'shops.json'].every((f) => existsSync(join(OUT, 'data', f)))

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})

describe.skipIf(!HAVE)('real Jangan NPCs and shops', () => {
  const data = HAVE ? GameData.load(OUT) : new GameData()
  function setup() {
    const h = npcHarness({ data })
    harnesses.push(h)
    return h
  }
  const near = (h: NpcHarness, code: string): [number, number, number] => {
    const n = h.npcByCode(code)
    return [n.pos[0] + 2, n.pos[1], n.pos[2]]
  }

  it('Wangu (NPC_CH_WAREHOUSE_M: the storage chest) and Sansan (sitting on it) are both placed and both keep storage', () => {
    const h = setup()
    const codes = new Set([...h.world.npcs.values()].map((n) => n.code))
    expect(codes.has('NPC_CH_WAREHOUSE_M')).toBe(true)
    expect(codes.has('NPC_CH_WAREHOUSE_W')).toBe(true)
    const wangu = h.npcByCode('NPC_CH_WAREHOUSE_M')
    const sansan = h.npcByCode('NPC_CH_WAREHOUSE_W')
    expect(Math.hypot(wangu.pos[0] - sansan.pos[0], wangu.pos[2] - sansan.pos[2])).toBeLessThan(0.1)
    for (const n of [wangu, sansan]) expect(h.gameplay.npcs.servicesOf(null, n)).toEqual(h.gameplay.storage.enabled ? ['storage'] : [])
  })

  it('the four Jangan shops offer a shop; the talkers offer nothing; the level-21 chests are hidden at cap 20', () => {
    const h = setup()
    // Wave 8 (docs/WAVE_PLAN2.md §6.3): Stable-keeper Machun sells the Red Horse; the Blacksmith and the Protector
    // trader also repair (NpcDef.roles 'repair').
    for (const code of ['NPC_CH_POTION', 'NPC_CH_ACCESSORY', 'NPC_CH_HORSE']) {
      expect(h.gameplay.npcs.servicesOf(null, h.npcByCode(code)), code).toEqual(['shop'])
    }
    for (const code of ['NPC_CH_SMITH', 'NPC_CH_ARMOR']) {
      expect(h.gameplay.npcs.servicesOf(null, h.npcByCode(code)), code).toEqual(['shop', 'repair'])
    }
    for (const code of ['NPC_CH_CHEF', 'NPC_CH_SOLDIER_EM1']) {
      expect(h.gameplay.npcs.servicesOf(null, h.npcByCode(code)), code).toEqual([])
    }
    const keeper = h.gameplay.npcs.servicesOf(null, h.npcByCode('NPC_CH_WAREHOUSE_W'))
    expect(keeper).toEqual(h.gameplay.storage.enabled ? ['storage'] : [])
    const armor = h.gameplay.shops.goods('NPC_CH_ARMOR')
    const all = data.shopOf('NPC_CH_ARMOR')!.tabs.flatMap((t) => t.items)
    const hidden = all.filter((c) => !armor.has(c))
    expect(hidden.sort()).toEqual(['ITEM_CH_M_CLOTHES_03_BA_A', 'ITEM_CH_M_HEAVY_03_BA_A', 'ITEM_CH_M_LIGHT_03_BA_A', 'ITEM_CH_W_CLOTHES_03_BA_A', 'ITEM_CH_W_HEAVY_03_BA_A', 'ITEM_CH_W_LIGHT_03_BA_A'])
    for (const def of armor.values()) expect(def.reqLevel).toBeLessThanOrEqual(20)
  })

  it('SHOPS lane A user check: 10 HP herbs cost 600, 5 sell for 105, and buy back for 105', () => {
    const h = setup()
    const herbalist = h.npcByCode('NPC_CH_POTION')
    const { p, inbox } = h.enter(near(h, 'NPC_CH_POTION'), 5000)
    h.req(p, inbox, { t: 'npcTalk', npc: herbalist.id })
    expect(h.of(inbox, 'npcDialog').at(-1)).toMatchObject({ code: 'NPC_CH_POTION', services: ['shop'] })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: herbalist.id, item: 'ITEM_ETC_HP_POTION_01', count: 10 })).toMatchObject({ ok: true })
    expect(p.gold).toBe(4400)
    const slot = h.bag(p).findIndex((i) => i?.code === 'ITEM_ETC_HP_POTION_01')
    expect(h.req(p, inbox, { t: 'shopSell', npc: herbalist.id, bag: slot, count: 5 })).toMatchObject({ ok: true })
    expect(p.gold).toBe(4505)
    expect(h.of(inbox, 'buyback').at(-1)!.entries).toEqual([{ item: { code: 'ITEM_ETC_HP_POTION_01', count: 5 }, price: 105 }])
    expect(h.req(p, inbox, { t: 'shopBuyback', npc: herbalist.id, index: 0 })).toMatchObject({ ok: true })
    expect(p.gold).toBe(4400)
    expect(h.countOf(p, 'ITEM_ETC_HP_POTION_01')).toBe(10)
  })

  it('the real potions and scrolls: herb +120 HP on the hp group; Return Scroll 30 s, Special 15 s', () => {
    const h = setup()
    const grocer = h.npcByCode('NPC_CH_ACCESSORY')
    const { p, inbox } = h.enter(near(h, 'NPC_CH_ACCESSORY'), 20_000)
    expect(h.req(p, inbox, { t: 'shopBuy', npc: grocer.id, item: 'ITEM_ETC_SCROLL_RETURN_01', count: 1 })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'shopBuy', npc: grocer.id, item: 'ITEM_ETC_SCROLL_RETURN_02', count: 1 })).toMatchObject({ ok: true })
    expect(p.gold).toBe(5000)
    const herbs = h.give(p, 'ITEM_ETC_HP_POTION_01', 2)
    p.hp = 1
    h.req(p, inbox, { t: 'itemUse', bag: herbs })
    expect(p.hp).toBe(121)
    expect(h.of(inbox, 'itemCooldown').at(-1)).toEqual({ t: 'itemCooldown', group: 'hp', readyInMs: 1000, totalMs: 1000 })
    h.req(p, inbox, { t: 'itemUse', bag: h.bag(p).findIndex((i) => i?.code === 'ITEM_ETC_SCROLL_RETURN_01') })
    expect(h.of(inbox, 'itemCast').at(-1)).toMatchObject({ item: 'ITEM_ETC_SCROLL_RETURN_01', castMs: 30_000 })
    h.req(p, inbox, { t: 'stopAction' })
    h.req(p, inbox, { t: 'itemUse', bag: h.bag(p).findIndex((i) => i?.code === 'ITEM_ETC_SCROLL_RETURN_02') })
    expect(h.of(inbox, 'itemCast').at(-1)).toMatchObject({ item: 'ITEM_ETC_SCROLL_RETURN_02', castMs: 15_000 })
    h.advance(15_000)
    expect(h.of(inbox, 'itemCastEnd').map((m) => m.reason)).toEqual(['cancelled', 'done'])
    expect(h.countOf(p, 'ITEM_ETC_SCROLL_RETURN_01')).toBe(1)
    expect(h.countOf(p, 'ITEM_ETC_SCROLL_RETURN_02')).toBe(0)
    // a Universal Pill is refused and kept while there is nothing to cure
    const pill = h.give(p, 'ITEM_ETC_CURE_ALL_01', 1)
    const r = h.req(p, inbox, { t: 'itemUse', bag: pill })
    expect(r).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(h.countOf(p, 'ITEM_ETC_CURE_ALL_01')).toBe(1)
  })
})

const HAVE_WORLD = HAVE && existsSync(join(OUT, 'world/jangan/manifest.json'))

describe.skipIf(!HAVE_WORLD)('real Jangan navmesh: talking from the town return point', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await startTestServer({ config: { outDir: OUT, serveStatic: false, moveSpeed: 30, tickHz: 20, rng: seeded(3) } })
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  it('a click on each shop NPC and the storage keeper walks there (around stalls and walls) and opens the dialog', async () => {
    const codes = ['NPC_CH_POTION', 'NPC_CH_SMITH', 'NPC_CH_ARMOR', 'NPC_CH_ACCESSORY', 'NPC_CH_WAREHOUSE_W']
    await Promise.all(
      codes.map(async (code, i) => {
        const acc = await newAccount(s.url, 'talk')
        const c = await Client.login(s.url, acc.token)
        c.send({ t: 'charCreate', name: `Walker${i}${Date.now() % 10_000}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
        const ch = (await c.next('charCreated')).character
        c.send({ t: 'enterWorld', id: ch.id })
        const enter = await c.next('worldEnter')
        const npc = enter.entities.find((e) => e.kind === 'npc' && e.model === code)!
        expect(npc, code).toBeDefined()
        c.send({ t: 'npcTalk', npc: npc.id })
        expect((await c.next('actionResult', (m) => m.re === 'npcTalk')).ok).toBe(true)
        const dialog = await c.next('npcDialog', () => true, 10_000)
        expect(dialog.code).toBe(code)
        const p = s.ctx.world.players.get(enter.self.id)!
        expect(s.ctx.world.distance(p, s.ctx.world.npcs.get(npc.id)!, Date.now()), code).toBeLessThanOrEqual(NPC_INTERACT_RANGE)
        c.close()
        await c.closed
      }),
    )
  }, 60_000)
})
