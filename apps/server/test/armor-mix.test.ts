/**
 * Armour classes (docs/PROTOCOL.md §7 itemEquip; retail client textdata UIIT_MSG_STRGERR_CANT_MIX_EXCLUSIVE_ARMOR_TYPE):
 * a garment piece is never worn with protector or armour pieces, protector and armour mix. The rule lives in
 * `equipItem`, the one path that puts a bag item on (drag-drop and right-click both send itemEquip); GM give, trade,
 * storage, shops and quest rewards only fill the bag. A set mixed before the rule stays on (only the pieces left on count).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ARMOR_MIX_MESSAGE, armorClassesClash, type ItemDef, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import { InvDraft, armorClash, equipItem, newItem, unequipItem, type InvState } from '../src/inventory.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'
import { ITEMS, LEVELS, contentFiles, item, seeded } from './fixtures.ts'

const piece = (code: string, slot: ItemDef['slot'], armorType: ItemDef['armorType'], over: Partial<ItemDef> = {}) =>
  item(code, { category: 'armor', slot, armorType, degree: 1, reqLevel: 1, reqGender: 'male', race: 'china', stats: { physDefence: [2, 2] }, ...over })

const EXTRA: ItemDef[] = [
  piece('ITEM_CH_M_CLOTHES_01_HA_A', 'head', 'garment'),
  piece('ITEM_CH_M_LIGHT_01_HA_A', 'head', 'protector'),
  piece('ITEM_CH_M_LIGHT_01_BA_A', 'chest', 'protector'),
  piece('ITEM_CH_M_LIGHT_01_LA_A', 'legs', 'protector'),
  piece('ITEM_CH_M_HEAVY_01_HA_A', 'head', 'armor'),
  piece('ITEM_CH_M_HEAVY_01_LA_A', 'legs', 'armor'),
  piece('ITEM_CH_W_LIGHT_01_HA_A', 'head', 'protector', { reqGender: 'female' }),
  piece('ITEM_CH_M_LIGHT_05_HA_A', 'head', 'protector', { reqLevel: 15 }),
]
const defs = new Map([...ITEMS, ...EXTRA].map((i) => [i.code, i]))
const lookup = (c: string) => defs.get(c)
const man = { level: 1, gender: 'male' as const }

/** An inventory wearing `worn` (slot -> code) with `bag` codes from slot 0. */
function draft(worn: Partial<Record<'head' | 'chest' | 'legs' | 'feet' | 'weapon' | 'shield', string>>, bag: string[] = []): InvDraft {
  const st: InvState = { bagSize: 6, bag: Array(6).fill(null), equip: {}, gold: 0 }
  for (const [slot, code] of Object.entries(worn)) st.equip[slot as keyof typeof worn] = newItem(code, 1)
  bag.forEach((code, i) => (st.bag[i] = newItem(code, 1)))
  return new InvDraft(st)
}

describe('armorClassesClash', () => {
  it('garment clashes with protector and armour; protector and armour mix; a class never clashes with itself', () => {
    expect(armorClassesClash('garment', 'protector')).toBe(true)
    expect(armorClassesClash('garment', 'armor')).toBe(true)
    expect(armorClassesClash('protector', 'garment')).toBe(true)
    expect(armorClassesClash('armor', 'garment')).toBe(true)
    expect(armorClassesClash('protector', 'armor')).toBe(false)
    expect(armorClassesClash('armor', 'protector')).toBe(false)
    for (const t of ['garment', 'protector', 'armor'] as const) expect(armorClassesClash(t, t)).toBe(false)
  })
})

describe('equipItem: armour classes', () => {
  it('refuses a protector or armour piece while a garment is worn, with the retail line, and changes nothing', () => {
    for (const code of ['ITEM_CH_M_LIGHT_01_LA_A', 'ITEM_CH_M_HEAVY_01_LA_A']) {
      const d = draft({ chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF' }, [code])
      expect(equipItem(d, 0, undefined, man, lookup)).toEqual({ ok: false, reason: 'armor_mix', message: ARMOR_MIX_MESSAGE })
      expect(d.changed).toBe(false)
      expect(d.equip.legs).toBeUndefined()
      expect(d.bag[0]?.code).toBe(code)
    }
  })

  it('refuses a garment piece while a protector or armour piece is worn', () => {
    for (const worn of ['ITEM_CH_M_LIGHT_01_BA_A', 'ITEM_CH_M_HEAVY_01_LA_A']) {
      const slot = worn.includes('_BA_') ? 'chest' : 'legs'
      const d = draft({ [slot]: worn }, ['ITEM_CH_M_CLOTHES_01_HA_A'])
      expect(equipItem(d, 0, undefined, man, lookup)).toMatchObject({ ok: false, reason: 'armor_mix' })
      expect(d.changed).toBe(false)
    }
  })

  it('lets protector and armour pieces mix, and a garment join a garment set', () => {
    const d = draft({ chest: 'ITEM_CH_M_LIGHT_01_BA_A' }, ['ITEM_CH_M_HEAVY_01_LA_A', 'ITEM_CH_M_HEAVY_01_HA_A'])
    expect(equipItem(d, 0, undefined, man, lookup)).toEqual({ ok: true, value: 'legs' })
    expect(equipItem(d, 1, undefined, man, lookup)).toEqual({ ok: true, value: 'head' })
    const g = draft({ chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF', legs: 'ITEM_CH_M_CLOTHES_01_LA_A_DEF' }, ['ITEM_CH_M_CLOTHES_01_HA_A'])
    expect(equipItem(g, 0, undefined, man, lookup)).toEqual({ ok: true, value: 'head' })
  })

  it('a swap counts only the pieces that stay on: the last garment piece may be replaced by a protector piece', () => {
    const d = draft({ chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF' }, ['ITEM_CH_M_LIGHT_01_BA_A'])
    expect(equipItem(d, 0, undefined, man, lookup)).toEqual({ ok: true, value: 'chest' })
    expect(d.equip.chest?.code).toBe('ITEM_CH_M_LIGHT_01_BA_A')
    expect(d.bag[0]?.code).toBe('ITEM_CH_M_CLOTHES_01_BA_A_DEF')
    // drag onto the slot explicitly: the same rule
    const e = draft({ chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF', head: 'ITEM_CH_M_CLOTHES_01_HA_A' }, ['ITEM_CH_M_LIGHT_01_BA_A'])
    expect(equipItem(e, 0, 'chest', man, lookup)).toMatchObject({ ok: false, reason: 'armor_mix' })
  })

  it('a set mixed before the rule stays on: unequip and non-armour items work, a piece may be swapped toward one class, never added to the mix', () => {
    const d = draft({ chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF', legs: 'ITEM_CH_M_LIGHT_01_LA_A' }, [
      'ITEM_CH_M_LIGHT_01_HA_A',
      'ITEM_CH_M_CLOTHES_01_HA_A',
      'ITEM_CH_BLADE_02_A',
      'ITEM_CH_SHIELD_01_A',
      'ITEM_CH_RING_01_A',
      'ITEM_CH_M_LIGHT_01_BA_A',
    ])
    expect(equipItem(d, 0, undefined, man, lookup)).toMatchObject({ reason: 'armor_mix' })
    expect(equipItem(d, 1, undefined, man, lookup)).toMatchObject({ reason: 'armor_mix' })
    expect(d.equip.chest?.code).toBe('ITEM_CH_M_CLOTHES_01_BA_A_DEF')
    expect(d.equip.legs?.code).toBe('ITEM_CH_M_LIGHT_01_LA_A')
    expect(equipItem(d, 2, undefined, man, lookup)).toEqual({ ok: true, value: 'weapon' })
    expect(equipItem(d, 3, undefined, man, lookup)).toEqual({ ok: true, value: 'shield' })
    expect(equipItem(d, 4, undefined, man, lookup)).toEqual({ ok: true, value: 'ring1' })
    // the protector chest replaces the garment chest: everything left on is protector now
    expect(equipItem(d, 5, undefined, man, lookup)).toEqual({ ok: true, value: 'chest' })
    expect(d.bag[5]?.code).toBe('ITEM_CH_M_CLOTHES_01_BA_A_DEF')
    expect(equipItem(d, 0, undefined, man, lookup)).toEqual({ ok: true, value: 'head' })
    expect(unequipItem(d, 'legs').ok).toBe(true)
  })

  it('the level and gender rules answer first, as before', () => {
    const d = draft({ chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF' }, ['ITEM_CH_W_LIGHT_01_HA_A', 'ITEM_CH_M_LIGHT_05_HA_A'])
    expect(equipItem(d, 0, undefined, man, lookup)).toMatchObject({ reason: 'requirements' })
    expect(equipItem(d, 1, undefined, man, lookup)).toMatchObject({ reason: 'requirements' })
  })

  it('armorClash names the clashing slot and ignores unknown codes and non-armour', () => {
    const d = draft({ chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF', head: 'ITEM_GONE', weapon: 'ITEM_CH_BLADE_02_A' })
    expect(armorClash(d, defs.get('ITEM_CH_M_LIGHT_01_LA_A')!, 'legs', lookup)).toBe('chest')
    expect(armorClash(d, defs.get('ITEM_CH_M_LIGHT_01_BA_A')!, 'chest', lookup)).toBeNull()
    expect(armorClash(d, defs.get('ITEM_CH_RING_01_A')!, 'ring1', lookup)).toBeNull()
  })
})

// ---- over the wire --------------------------------------------------------------------------------

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

describe('itemEquip over the wire', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await startTestServer({
      config: { moveSpeed: 30, tickHz: 20, rng: seeded(81) },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [50, 0, -50], bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({ items: [...ITEMS, ...EXTRA], levels: LEVELS }),
      },
    })
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  it('a GM-given protector piece lands in the bag; equipping it over the garment starter kit is refused armor_mix with the retail line', async () => {
    const acc = await newAccount(s.url, 'armix')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: 'Mixer', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    const inv = (await c.next('inventory')).inventory
    expect(inv.equip.chest?.code).toBe('ITEM_CH_M_CLOTHES_01_BA_A_DEF')
    c.send({ t: 'gm', cmd: 'item', args: ['ITEM_CH_M_LIGHT_01_HA_A'] })
    expect((await c.next('gmResult')).ok).toBe(true)
    const given = await c.next('inventoryUpdate', (m) => !!m.bag?.some((b) => b.item?.code === 'ITEM_CH_M_LIGHT_01_HA_A'))
    expect(given.equip).toBeUndefined()
    const bag = given.bag!.find((b) => b.item?.code === 'ITEM_CH_M_LIGHT_01_HA_A')!.slot
    for (const slot of [undefined, 'head'] as const) {
      c.send(slot ? { t: 'itemEquip', bag, slot } : { t: 'itemEquip', bag })
      const r: Msg<'actionResult'> = await c.next('actionResult', (m) => m.re === 'itemEquip')
      expect(r).toMatchObject({ ok: false, reason: 'armor_mix', message: 'Armor and garment cannot be worn at the same time.' })
    }
    // the server state is untouched: the piece is still in the bag, nothing is worn on the head
    const p = [...s.ctx.world.players.values()].find((x) => x.characterId === ch.id)!
    expect(p.equip.head).toBeUndefined()
    // a garment head piece goes on
    c.send({ t: 'gm', cmd: 'item', args: ['ITEM_CH_M_CLOTHES_01_HA_A'] })
    await c.next('gmResult')
    const g = await c.next('inventoryUpdate', (m) => !!m.bag?.some((b) => b.item?.code === 'ITEM_CH_M_CLOTHES_01_HA_A'))
    c.send({ t: 'itemEquip', bag: g.bag!.find((b) => b.item?.code === 'ITEM_CH_M_CLOTHES_01_HA_A')!.slot })
    expect(await c.next('actionResult', (m) => m.re === 'itemEquip')).toMatchObject({ ok: true })
    expect(p.equip.head?.code).toBe('ITEM_CH_M_CLOTHES_01_HA_A')
    c.close()
    await c.closed
  })
})

// ---- the real export ---------------------------------------------------------------------------------

const OUT = join(REPO_ROOT, 'work/out')

describe.skipIf(!existsSync(join(OUT, 'data/items.json')))('armour classes in the real export', () => {
  let d: GameData
  beforeAll(() => {
    d = GameData.load(OUT)
  })

  it('every Chinese armour piece has the class of its TypeID3 (1 garment, 2 protector, 3 armour)', () => {
    const armour = [...d.items.values()].filter((i) => i.category === 'armor')
    expect(armour.length).toBeGreaterThan(400)
    const byType: Record<number, ItemDef['armorType']> = { 1: 'garment', 2: 'protector', 3: 'armor' }
    for (const i of armour) expect(i.armorType, i.code).toBe(byType[i.typeId[2]])
    for (const t of ['garment', 'protector', 'armor'] as const) expect(armour.filter((i) => i.armorType === t).length, t).toBeGreaterThan(100)
  })

  it('every starter outfit is one class, so the starter kit never mixes', () => {
    for (const gender of ['male', 'female'] as const) {
      for (const outfit of ['clothes', 'light', 'heavy'] as const) {
        const kit = d.starterOutfit(gender, outfit)
        expect(kit.length, `${gender} ${outfit}`).toBeGreaterThan(0)
        expect(new Set(kit.map((i) => i.armorType)).size, `${gender} ${outfit}`).toBe(1)
      }
    }
  })
})
