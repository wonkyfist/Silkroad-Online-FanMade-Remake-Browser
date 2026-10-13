import type { ItemDef, Role } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pickGearSet } from '../src/gm-tools.ts'
import { ITEMS, LEVELS, contentFiles, item } from './fixtures.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'

const piece = (code: string, slot: ItemDef['slot'], over: Partial<ItemDef> = {}) =>
  item(code, { category: 'armor', slot, armorType: 'protector', degree: 2, reqLevel: 12, reqGender: 'male', race: 'china', ...over })
const SET: ItemDef[] = [
  ...(['head', 'shoulders', 'chest', 'legs', 'hands', 'feet'] as const).map((slot, i) => piece(`ITEM_CH_M_LIGHT_03_${['HA', 'SA', 'BA', 'LA', 'AA', 'FA'][i]}_A`, slot)),
  piece('ITEM_CH_W_LIGHT_03_BA_A', 'chest', { reqGender: 'female' }),
  piece('ITEM_CH_M_HEAVY_03_BA_A', 'chest', { armorType: 'armor' }),
  item('ITEM_CH_EARRING_03_A', { category: 'accessory', slot: 'earring', degree: 2, reqLevel: 12, race: 'china' }),
  item('ITEM_CH_NECKLACE_03_A', { category: 'accessory', slot: 'necklace', degree: 2, reqLevel: 12, race: 'china' }),
  item('ITEM_CH_RING_03_A', { category: 'accessory', slot: 'ring', degree: 2, reqLevel: 12, race: 'china' }),
  item('ITEM_CH_BLADE_03_A', { category: 'weapon', slot: 'weapon', weaponType: 'blade', degree: 2, reqLevel: 16, race: 'china', range: 1.5 }),
  item('ITEM_CH_BLADE_03_C_RARE', { category: 'weapon', slot: 'weapon', weaponType: 'blade', degree: 2, reqLevel: 16, race: 'china', range: 1.5 }),
  item('ITEM_CH_SHIELD_03_A', { category: 'shield', slot: 'shield', degree: 2, reqLevel: 12, race: 'china' }),
  item('ITEM_ETC_MP_POTION_01', { category: 'potion', maxStack: 50, use: { mp: 100 } }),
]
const ALL = [...ITEMS, ...SET]

let s: TestServer
let n = 0

beforeAll(async () => {
  s = await startTestServer({ config: { tickHz: 20, levelCap: 20 }, files: contentFiles({ items: ALL, levels: LEVELS }) })
})
afterAll(async () => {
  await s.stopAndClean()
})

async function player(role: Role = 'player') {
  const acc = await newAccount(s.url, role === 'player' ? 'pl' : role)
  if (role !== 'player') s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role)
  const c = await Client.login(s.url, acc.token)
  const name = `Tool${role[0]}${++n}`
  c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ch = (await c.next('charCreated')).character
  c.send({ t: 'enterWorld', id: ch.id })
  await c.next('worldEnter')
  return { c, ch, name, accountId: s.ctx.store.accountByName(acc.username)!.id }
}
async function gm(c: Client, cmd: string, ...args: string[]) {
  c.send({ t: 'gm', cmd, args })
  return c.next('gmResult')
}
const inv = (characterId: number) => s.ctx.store.loadInventory(characterId)
const bagCodes = (characterId: number) => inv(characterId).bag.filter(Boolean).map((i) => i!.code)

describe('pickGearSet', () => {
  it('picks one piece per slot of the type, degree and gender, accessories, weapon + shield, and the seal rows', () => {
    const byCode = new Map(ALL.map((i) => [i.code, i]))
    const r = pickGearSet(ALL, (c) => byCode.get(c), { degree: 2, armor: 'protector', weapon: 'blade', gender: 'male', tier: 'sun', accessories: true })
    expect(r.missing).toEqual([])
    expect(r.pieces.map((p) => p.code)).toEqual([
      'ITEM_CH_M_LIGHT_03_HA_A', 'ITEM_CH_M_LIGHT_03_SA_A', 'ITEM_CH_M_LIGHT_03_BA_A', 'ITEM_CH_M_LIGHT_03_LA_A', 'ITEM_CH_M_LIGHT_03_AA_A', 'ITEM_CH_M_LIGHT_03_FA_A',
      'ITEM_CH_EARRING_03_A', 'ITEM_CH_NECKLACE_03_A', 'ITEM_CH_RING_03_A', 'ITEM_CH_RING_03_A',
      'ITEM_CH_BLADE_03_C_RARE', 'ITEM_CH_SHIELD_03_A',
    ])
    expect(r.sealed).toBe(1)
    const armour = pickGearSet(ALL, (c) => byCode.get(c), { degree: 2, armor: 'armor', weapon: 'none', gender: 'male', tier: null, accessories: false })
    expect(armour.pieces.map((p) => p.code)).toEqual(['ITEM_CH_M_HEAVY_03_BA_A'])
    expect(armour.missing).toEqual(['head', 'shoulders', 'legs', 'hands', 'feet'])
  })
})

describe('GM toolbox commands', () => {
  it('are refused to players and audited', async () => {
    const p = await player()
    p.c.send({ t: 'gm', cmd: 'gearset', args: ['2', 'protector', 'blade'] })
    expect(await p.c.next('error')).toMatchObject({ code: 'forbidden', re: 'gm' })
    expect(s.ctx.store.recentAudit(1)[0]).toMatchObject({ command: 'gearset', ok: 0 })
    expect(bagCodes(p.ch.id)).not.toContain('ITEM_CH_BLADE_03_A')
    p.c.close()
  })

  it('gearset gives a whole sealed +N set in one command (to a named player), and is audited with its target', async () => {
    const g = await player('gm')
    const p = await player()
    const before = bagCodes(p.ch.id).length
    const r = await gm(g.c, 'gearset', '2', 'protector', 'blade', 'sun', '+3', p.name)
    expect(r.ok).toBe(true)
    const bag = inv(p.ch.id).bag.filter(Boolean)
    expect(bag.length - before).toBe(12)
    expect(bag.find((i) => i!.code === 'ITEM_CH_BLADE_03_C_RARE')?.plus).toBe(3)
    const audit = s.ctx.store.recentAudit(1)[0]
    expect(audit).toMatchObject({ command: 'gearset', ok: 1 })
    expect(JSON.parse(audit.args)).toContain(p.name)
    expect((await gm(g.c, 'gearset', '9', 'protector', 'blade')).ok).toBe(false)
    g.c.close()
    p.c.close()
  })

  it('gearset wear dresses the GM at once; invclear empties the bag, all also the worn items', async () => {
    const g = await player('gm')
    expect((await gm(g.c, 'gearset', '2', 'protector', 'blade', 'wear')).ok).toBe(true)
    const worn = inv(g.ch.id).equip
    expect(worn.chest?.code).toBe('ITEM_CH_M_LIGHT_03_BA_A')
    expect(worn.weapon?.code).toBe('ITEM_CH_BLADE_03_A')
    expect(worn.ring1?.code).toBe('ITEM_CH_RING_03_A')
    expect(worn.ring2?.code).toBe('ITEM_CH_RING_03_A')
    expect((await gm(g.c, 'potions', '.', '20')).message).toMatch(/^Gave/)
    expect(bagCodes(g.ch.id).length).toBeGreaterThan(0)
    const clear = await gm(g.c, 'invclear')
    expect(clear.ok).toBe(true)
    expect(bagCodes(g.ch.id)).toEqual([])
    expect(inv(g.ch.id).equip.chest).toBeDefined()
    expect((await gm(g.c, 'invclear', '.', 'all')).ok).toBe(true)
    expect(Object.values(inv(g.ch.id).equip).filter(Boolean)).toEqual([])
    expect(s.ctx.store.recentAudit(1)[0]).toMatchObject({ command: 'invclear', ok: 1 })
    g.c.close()
  })

  it('give, gold, sort and the rank checks', async () => {
    const g = await player('gm')
    const a = await player('admin')
    expect((await gm(g.c, 'give', a.name, 'ITEM_ETC_HP_POTION_01', '5')).message).toMatch(/outranks you/)
    expect((await gm(g.c, 'give', '.', 'ITEM_ETC_HP_POTION_01', '5')).ok).toBe(true)
    expect((await gm(g.c, 'give', '.', 'ITEM_ETC_HP_POTION_01', '7')).ok).toBe(true)
    expect((await gm(g.c, 'sort')).ok).toBe(true)
    const pots = inv(g.ch.id).bag.filter((i) => i?.code === 'ITEM_ETC_HP_POTION_01')
    expect(pots.map((i) => i!.count)).toEqual([12])
    expect((await gm(g.c, 'gold', '.', '1000')).data).toMatchObject({ gold: 1000 })
    expect((await gm(g.c, 'gold', '.', '-300')).data).toMatchObject({ gold: 700 })
    expect((await gm(g.c, 'gold', '.', '+50')).data).toMatchObject({ gold: 750 })
    g.c.close()
    a.c.close()
  })

  it('mute silences a player until unmute; chatlog shows the recent lines; help gm lists the toolbox', async () => {
    const g = await player('gm')
    const p = await player()
    p.c.send({ t: 'chat', channel: 'local', text: 'hello there' })
    await new Promise((r) => setTimeout(r, 50))
    expect((await gm(g.c, 'chatlog', p.name)).message).toMatch(/hello there/)
    expect((await gm(g.c, 'mute', p.name, '5', 'spam')).ok).toBe(true)
    p.c.send({ t: 'chat', channel: 'local', text: 'still here' })
    expect((await p.c.next('error')).code).toBe('forbidden')
    expect((await gm(g.c, 'unmute', p.name)).ok).toBe(true)
    const help = await gm(g.c, 'help', 'gm')
    const names = (help.data as { commands: { name: string }[] }).commands.map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['gearset', 'invclear', 'mute', 'boost', 'announce', 'killall']))
    g.c.close()
    p.c.close()
  })

  it('boost raises the rates and boost off restores them', async () => {
    const g = await player('gm')
    const base = s.ctx.config.expRate ?? 1
    expect((await gm(g.c, 'boost', 'exp', '2', '10')).ok).toBe(true)
    expect(s.ctx.config.expRate).toBe(base * 2)
    expect((await gm(g.c, 'boost', 'off')).ok).toBe(true)
    expect(s.ctx.config.expRate).toBe(base)
    g.c.close()
  })
})
