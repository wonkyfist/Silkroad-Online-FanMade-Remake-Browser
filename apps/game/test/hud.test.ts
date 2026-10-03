import { describe, expect, it } from 'vitest'
import {
  ACTION_FAIL_REASONS,
  EQUIP_SLOTS,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type Inventory,
  type ItemDef,
} from '@sro/shared'
import { gm, contentCode, parseCount as gmCount, prettyMob, GM_QUICK_ITEMS, GM_QUICK_MOBS, type GmBuild } from '../src/gm/commands.ts'
import { floaterText } from '../src/hud/effects.ts'
import { actionFailText } from '../src/hud/index.ts'
import { dragIntent, intent, parseCount, useIntent } from '../src/hud/intents.ts'
import { InventoryState, readInventoryUpdate } from '../src/hud/inventory-state.ts'
import { formatNumber, guessSlotKind, ItemCatalog, prettyCode, readIconIndex } from '../src/hud/items.ts'
import { expPercent, portraitKey } from '../src/hud/player.ts'
import { t } from '../src/i18n/index.ts'
import { mergeManifests } from '../src/ui/art.ts'

/** The message must survive the server's strict frame parser unchanged. */
function valid<T extends ClientMessage>(msg: T | null | string): T {
  if (msg === null || typeof msg === 'string') throw new Error(`expected a message, got ${String(msg)}`)
  const parsed = parseClientMessage(JSON.stringify(msg))
  if (!parsed.ok) throw new Error(`${JSON.stringify(msg)} rejected: ${parsed.error}`)
  expect(parsed.msg).toEqual(msg)
  return msg
}

function validGm(build: GmBuild): Extract<ClientMessage, { t: 'gm' }> {
  if (!build.ok) throw new Error(`expected a message, got error: ${build.error}`)
  return valid(build.msg)
}

function invalidGm(build: GmBuild): string {
  if (build.ok) throw new Error(`expected an error, got ${JSON.stringify(build.msg)}`)
  expect(build.error.trim()).not.toBe('')
  return build.error
}

const SWORD: ItemDef = {
  code: 'ITEM_CH_SWORD_01_A',
  id: 1,
  name: 'Iron Sword',
  typeId: [3, 1, 6, 2],
  category: 'weapon',
  slot: 'weapon',
  weaponType: 'sword',
  degree: 1,
  reqLevel: 5,
  reqGender: 'any',
  race: 'china',
  twoHanded: false,
  range: 0.6,
  stats: { physAttack: [12, 16], durability: [20, 30], hitRate: [10, 14] },
  maxStack: 1,
  price: 100,
  sellPrice: 20,
  model: null,
  icon: '/out/icon/item/china/weapon/sword_01.png',
}

const POTION: ItemDef = {
  code: 'ITEM_ETC_HP_POTION_01',
  id: 2,
  name: 'HP Recovery Herb',
  typeId: [3, 3, 1, 1],
  category: 'potion',
  degree: 0,
  reqLevel: 0,
  reqGender: 'any',
  race: 'any',
  use: { hp: 70, cooldownGroup: 'hp', cooldownMs: 1000 },
  maxStack: 50,
  price: 4,
  sellPrice: 1,
  model: null,
  icon: null,
}

const RING: ItemDef = { ...SWORD, code: 'ITEM_CH_RING_01_A', name: 'Ring', category: 'accessory', slot: 'ring', weaponType: undefined, stats: {}, icon: null }

function snapshot(): Inventory {
  const bag: Inventory['bag'] = Array.from({ length: 48 }, () => null)
  bag[0] = { code: 'ITEM_CH_SWORD_01_A', count: 1, plus: 2 }
  bag[1] = { code: 'ITEM_ETC_HP_POTION_01', count: 20 }
  bag[5] = { code: 'ITEM_CH_RING_01_A', count: 1 }
  return { bagSize: 48, bag, equip: { weapon: { code: 'ITEM_CH_BLADE_01_A', count: 1 } }, gold: 150 }
}

const catalog = new ItemCatalog([SWORD, POTION, RING], { ITEM_ETC_HP_POTION_01: 'icons/item/etc/hp_potion_01.png' })

describe('HUD intents (every message passes parseClientMessage)', () => {
  it('builds the inventory, stat and respawn requests', () => {
    expect(valid(intent.itemMove(0, 47))).toEqual({ t: 'itemMove', from: 0, to: 47 })
    expect(valid(intent.itemSplit(1, 2, 5))).toEqual({ t: 'itemSplit', from: 1, to: 2, count: 5 })
    expect(valid(intent.itemEquip(3))).toEqual({ t: 'itemEquip', bag: 3 })
    expect(valid(intent.itemEquip(3, 'ring2'))).toEqual({ t: 'itemEquip', bag: 3, slot: 'ring2' })
    for (const slot of EQUIP_SLOTS) {
      valid(intent.itemEquip(0, slot))
      valid(intent.itemUnequip(slot))
      valid(intent.itemUnequip(slot, 95))
    }
    expect(valid(intent.itemUse(10))).toEqual({ t: 'itemUse', bag: 10 })
    expect(valid(intent.itemDrop(4))).toEqual({ t: 'itemDrop', bag: 4 })
    expect(valid(intent.itemDrop(4, 3))).toEqual({ t: 'itemDrop', bag: 4, count: 3 })
    expect(valid(intent.statUp('str', 1))).toEqual({ t: 'statUp', stat: 'str', points: 1 })
    expect(valid(intent.statUp('int', 1000))).toEqual({ t: 'statUp', stat: 'int', points: 1000 })
    expect(valid(intent.respawn())).toEqual({ t: 'respawn' })
  })

  it('refuses out-of-range values instead of sending frames the server rejects', () => {
    expect(intent.itemMove(0, 0)).toBeNull()
    expect(intent.itemMove(-1, 2)).toBeNull()
    expect(intent.itemMove(0, 96)).toBeNull()
    expect(intent.itemSplit(0, 1, 0)).toBeNull()
    expect(intent.itemSplit(0, 1, 10_001)).toBeNull()
    expect(intent.itemEquip(1.5)).toBeNull()
    expect(intent.itemUnequip('head', 200)).toBeNull()
    expect(intent.itemDrop(0, 0)).toBeNull()
    expect(intent.statUp('str', 0)).toBeNull()
    expect(intent.statUp('str', 1001)).toBeNull()
  })

  it('maps drags and right clicks to intents', () => {
    const inv = new InventoryState()
    inv.setSnapshot(snapshot())
    const bag = (slot: number) => ({ kind: 'bag' as const, slot })
    const eq = (slot: (typeof EQUIP_SLOTS)[number]) => ({ kind: 'equip' as const, slot })
    expect(valid(dragIntent(inv, catalog, bag(0), bag(9)) as ClientMessage)).toEqual({ t: 'itemMove', from: 0, to: 9 })
    expect(valid(dragIntent(inv, catalog, bag(0), bag(1)) as ClientMessage)).toEqual({ t: 'itemMove', from: 0, to: 1 })
    expect(dragIntent(inv, catalog, bag(1), bag(9), { split: true })).toBe('split')
    // Split onto an occupied slot is an ordinary move (merge/swap on the server).
    expect(valid(dragIntent(inv, catalog, bag(1), bag(0), { split: true }) as ClientMessage)).toEqual({ t: 'itemMove', from: 1, to: 0 })
    expect(dragIntent(inv, catalog, bag(3), bag(4))).toBeNull()
    expect(valid(dragIntent(inv, catalog, bag(0), eq('weapon')) as ClientMessage)).toEqual({ t: 'itemEquip', bag: 0, slot: 'weapon' })
    expect(dragIntent(inv, catalog, bag(0), eq('head'))).toBe('nofit')
    expect(dragIntent(inv, catalog, bag(1), eq('weapon'))).toBe('nofit')
    expect(valid(dragIntent(inv, catalog, bag(5), eq('ring2')) as ClientMessage)).toEqual({ t: 'itemEquip', bag: 5, slot: 'ring2' })
    expect(valid(dragIntent(inv, catalog, eq('weapon'), bag(7)) as ClientMessage)).toEqual({ t: 'itemUnequip', slot: 'weapon', bag: 7 })
    expect(valid(dragIntent(inv, catalog, eq('weapon'), bag(0)) as ClientMessage)).toEqual({ t: 'itemUnequip', slot: 'weapon' })
    expect(dragIntent(inv, catalog, eq('head'), bag(7))).toBeNull()
    expect(dragIntent(inv, catalog, eq('weapon'), eq('shield'))).toBeNull()
    expect(valid(useIntent(inv, catalog, 0))).toEqual({ t: 'itemEquip', bag: 0 })
    expect(valid(useIntent(inv, catalog, 1))).toEqual({ t: 'itemUse', bag: 1 })
    expect(useIntent(inv, catalog, 2)).toBeNull()
  })

  it('parses typed amounts', () => {
    expect(parseCount(' 5 ', 20)).toBe(5)
    expect(parseCount('20', 20)).toBe(20)
    expect(parseCount('21', 20)).toBeNull()
    expect(parseCount('0', 20)).toBeNull()
    expect(parseCount('2.5', 20)).toBeNull()
    expect(parseCount('abc', 20)).toBeNull()
  })
})

describe('inventory state (server-driven)', () => {
  it('applies a snapshot and slot updates, idempotently', () => {
    const inv = new InventoryState()
    expect(inv.known).toBe(false)
    const first = inv.setSnapshot(snapshot())
    expect(first.gained).toEqual([])
    expect(inv.known).toBe(true)
    expect(inv.bagSize).toBe(48)
    expect(inv.used).toBe(3)
    expect(inv.item(0)).toEqual({ code: 'ITEM_CH_SWORD_01_A', count: 1, plus: 2 })
    expect(inv.equipped('weapon')?.code).toBe('ITEM_CH_BLADE_01_A')
    expect(inv.freeSlot()).toBe(2)

    // Equip the sword: the server swaps the blade into bag slot 0.
    const raw = JSON.stringify({ t: 'inventoryUpdate', bag: [{ slot: 0, item: { code: 'ITEM_CH_BLADE_01_A', count: 1 } }], equip: [{ slot: 'weapon', item: { code: 'ITEM_CH_SWORD_01_A', count: 1, plus: 2 } }] })
    const parsed = parseServerMessage(raw)
    if (!parsed.ok) throw new Error(parsed.error)
    const change = inv.apply(parsed.msg)
    expect(change.bag).toEqual([0])
    expect(change.equip).toEqual(['weapon'])
    expect(change.gained).toEqual([])
    expect(inv.item(0)?.code).toBe('ITEM_CH_BLADE_01_A')
    expect(inv.equipped('weapon')).toEqual({ code: 'ITEM_CH_SWORD_01_A', count: 1, plus: 2 })
    // The same update again changes nothing.
    const again = inv.apply(parsed.msg)
    expect(again.bag).toEqual([])
    expect(again.equip).toEqual([])

    // Pickup: a new stack and gold.
    const pick = inv.apply({ t: 'inventoryUpdate', bag: [{ slot: 2, item: { code: 'ITEM_ETC_MP_POTION_01', count: 3 } }], gold: 400 })
    expect(pick.gold).toBe(250)
    expect(pick.gained).toEqual([{ code: 'ITEM_ETC_MP_POTION_01', count: 3 }])
    expect(inv.gold).toBe(400)
    // Using a potion lowers a stack: no gain.
    const use = inv.apply({ bag: [{ slot: 1, item: { code: 'ITEM_ETC_HP_POTION_01', count: 19 } }] })
    expect(use.gained).toEqual([])
    // Merging into an existing stack counts only the difference.
    expect(inv.apply({ bag: [{ slot: 1, item: { code: 'ITEM_ETC_HP_POTION_01', count: 25 } }] }).gained).toEqual([{ code: 'ITEM_ETC_HP_POTION_01', count: 6 }])
    // Clear a slot and an equipment slot.
    inv.apply({ bag: [{ slot: 5, item: null }], equip: [{ slot: 'weapon', item: null }] })
    expect(inv.item(5)).toBeNull()
    expect(inv.equipped('weapon')).toBeNull()
    // A resync snapshot reports what it added.
    const resync = inv.setSnapshot({ ...snapshot(), gold: 500 })
    expect(resync.snapshot).toBe(true)
    expect(resync.gold).toBe(100)
  })

  it('ignores malformed update entries', () => {
    const u = readInventoryUpdate({
      bag: [{ slot: -1, item: null }, { slot: 3, item: { code: 'X', count: 0 } }, { slot: 4, item: null }, 'junk', { slot: 1.5, item: null }],
      equip: [{ slot: 'tail', item: null }, { slot: 'head', item: { code: 'ITEM_CH_M_LIGHT_01_HA_A', count: 1 } }],
      gold: -5,
    })
    expect(u.bag).toEqual([{ slot: 4, item: null }])
    expect(u.equip).toEqual([{ slot: 'head', item: { code: 'ITEM_CH_M_LIGHT_01_HA_A', count: 1 } }])
    expect(u.gold).toBeUndefined()
    expect(readInventoryUpdate(null)).toEqual({ bag: [], equip: [] })
    const inv = new InventoryState()
    inv.apply({ bag: [{ slot: 3, item: { code: 'ITEM_ETC_HP_POTION_01', count: 2 } }] })
    expect(inv.bagSize).toBe(4)
  })
})

describe('item catalog', () => {
  it('names, icons, slots and tooltips', () => {
    expect(catalog.name('ITEM_CH_SWORD_01_A')).toBe('Iron Sword')
    expect(catalog.name('ITEM_ETC_MP_POTION_01')).toBe('Mp Potion 01')
    expect(catalog.stackName({ code: 'ITEM_CH_SWORD_01_A', count: 1, plus: 3 })).toBe('Iron Sword (+3)')
    expect(catalog.icon('ITEM_ETC_HP_POTION_01')).toBe('/out/icons/item/etc/hp_potion_01.png')
    expect(catalog.icon('ITEM_CH_SWORD_01_A')).toBe('/out/icon/item/china/weapon/sword_01.png')
    expect(catalog.icon('ITEM_UNKNOWN')).toBeNull()
    expect(catalog.fits('ITEM_CH_RING_01_A', 'ring1')).toBe(true)
    expect(catalog.fits('ITEM_CH_RING_01_A', 'ring2')).toBe(true)
    expect(catalog.fits('ITEM_CH_RING_01_A', 'necklace')).toBe(false)
    expect(catalog.fits('ITEM_ETC_HP_POTION_01', 'weapon')).toBe(false)
    // Unknown equipment is left to the server.
    expect(catalog.fits('ITEM_CH_M_HEAVY_01_SA_A', 'shoulders')).toBe(true)
    expect(catalog.maxStack('ITEM_ETC_HP_POTION_01')).toBe(50)

    const tip = catalog.tooltip({ code: 'ITEM_CH_SWORD_01_A', count: 1, plus: 2, durability: 25 }, { player: { level: 3 } })
    expect(tip[0]).toEqual({ text: 'Iron Sword (+2)', cls: 'title-plus' })
    expect(tip.map(l => l.text)).toContain('Phy. atk. pwr. 12 ~ 16')
    expect(tip.map(l => l.text)).toContain('Durability 25 / 30')
    expect(tip.find(l => l.text === 'Required level: 5')?.cls).toBe('bad')
    expect(tip[tip.length - 1]).toEqual({ text: t('item.hintEquip'), cls: 'hint' })
    const potion = catalog.tooltip({ code: 'ITEM_ETC_HP_POTION_01', count: 20 })
    expect(potion.map(l => l.text)).toEqual(expect.arrayContaining(['Quantity: 20', 'Recovers 70 HP', t('item.hintUse')]))
    const unknown = catalog.tooltip({ code: 'ITEM_CH_M_LIGHT_01_HA_A', count: 1 }, { equipped: true })
    expect(unknown.map(l => l.text)).toEqual(expect.arrayContaining(['Head', t('item.hintUnequip')]))
    for (const lines of [tip, potion, unknown]) for (const l of lines) expect(l.text).not.toMatch(/\{\w+\}/)
    // Per-enhancement increments (items.json perPlus) add to the +N item's ranges.
    const plussed = new ItemCatalog([{ ...SWORD, perPlus: { physAttack: 1.5 } } as ItemDef])
    expect(plussed.tooltip({ code: SWORD.code, count: 1, plus: 2 }).map(l => l.text)).toContain('Phy. atk. pwr. 15 ~ 19')
  })

  it('guesses slots from codes and reads the icon index', () => {
    expect(guessSlotKind('ITEM_CH_SWORD_01_A_DEF')).toBe('weapon')
    expect(guessSlotKind('ITEM_CH_TBLADE_02_B')).toBe('weapon')
    expect(guessSlotKind('ITEM_CH_SHIELD_01_A')).toBe('shield')
    expect(guessSlotKind('ITEM_CH_M_HEAVY_01_HA_A')).toBe('head')
    expect(guessSlotKind('ITEM_CH_W_CLOTHES_03_FA_B')).toBe('feet')
    expect(guessSlotKind('ITEM_CH_M_LIGHT_01_AA_A')).toBe('hands')
    expect(guessSlotKind('ITEM_CH_NECKLACE_01_A')).toBe('necklace')
    expect(guessSlotKind('ITEM_CH_EARRING_01_A')).toBe('earring')
    expect(guessSlotKind('ITEM_CH_RING_01_A')).toBe('ring')
    expect(guessSlotKind('ITEM_ETC_HP_POTION_01')).toBeUndefined()
    expect(prettyCode('ITEM_ETC_SCROLL_RETURN_01')).toBe('Scroll Return 01')
    expect(readIconIndex({ items: { A: 'icons/a.png', B: 3 } })).toEqual({ A: 'icons/a.png' })
    expect(readIconIndex(null)).toEqual({})
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatNumber(999)).toBe('999')
  })
})

describe('HUD text and helpers', () => {
  it('has a line for every refusal reason', () => {
    for (const r of ACTION_FAIL_REASONS) {
      const text = actionFailText(r)
      expect(text).not.toBe(`action.fail.${r}`)
      expect(text).not.toBe(t('action.fail.generic'))
    }
    expect(actionFailText(undefined, 'server says no')).toBe('server says no')
    expect(actionFailText(undefined)).toBe(t('action.fail.generic'))
    expect(actionFailText('too_far')).toBe('Too far away.')
  })

  it('formats floating numbers, EXP and portraits', () => {
    expect(floaterText(1234, 'hit')).toBe('1,234')
    expect(floaterText(0, 'miss')).toBe('MISS')
    expect(floaterText(50, 'heal')).toBe('+50')
    expect(expPercent(1, 3)).toBe(33.33)
    expect(expPercent(0, 100)).toBe(0)
    expect(expPercent(150, 100)).toBe(100)
    expect(expPercent(5, 0)).toBeNull()
    expect(portraitKey('CHAR_CH_MAN_ADVENTURER')).toBe('character/char_ch_man1')
    expect(portraitKey('CHAR_CH_MAN_MONKEY')).toBe('character/char_ch_man6')
    expect(portraitKey('CHAR_CH_WOMAN_WARRIOR')).toBe('character/char_ch_woman13')
    expect(portraitKey('MOB_CH_TIGER')).toBeNull()
  })

  it('merges the HUD texture manifest into the UI manifest', () => {
    const img = { file: 'ui/x.png', width: 4, height: 4, content: [0, 0, 4, 4] as [number, number, number, number] }
    const merged = mergeManifests({ version: 1, images: { a: img }, music: { m: 'music/m.ogg' }, bakedText: { a: 'x' } }, { images: { a: { ...img, file: 'other' }, b: img }, bakedText: { b: 'y' } })
    expect(merged?.images.a?.file).toBe('ui/x.png')
    expect(merged?.images.b).toEqual(img)
    expect(merged?.bakedText).toEqual({ a: 'x', b: 'y' })
    expect(merged?.music).toEqual({ m: 'music/m.ogg' })
    expect(mergeManifests(null, null)).toBeNull()
    expect(mergeManifests(null, { images: { b: img } })?.images.b).toEqual(img)
  })
})

describe('GM gameplay commands (every message passes parseClientMessage)', () => {
  it('builds spawn, item, kill and heal', () => {
    expect(validGm(gm.spawn('mob_ch_mangnyang'))).toEqual({ t: 'gm', cmd: 'spawn', args: ['MOB_CH_MANGNYANG'] })
    expect(validGm(gm.spawn(' MOB_CH_TIGER ', '5')).args).toEqual(['MOB_CH_TIGER', '5'])
    expect(validGm(gm.spawn('MOB_CH_TIGER', 50)).args).toEqual(['MOB_CH_TIGER', '50'])
    expect(validGm(gm.spawn('MOB_CH_TIGER', '')).args).toEqual(['MOB_CH_TIGER'])
    invalidGm(gm.spawn('MOB_CH_TIGER', 51))
    invalidGm(gm.spawn('MOB_CH_TIGER', '0'))
    invalidGm(gm.spawn('mob ch tiger'))
    invalidGm(gm.spawn(''))
    expect(validGm(gm.item('item_etc_hp_potion_01', 20)).args).toEqual(['ITEM_ETC_HP_POTION_01', '20'])
    expect(validGm(gm.item('ITEM_ETC_GOLD_01', '10000')).args).toEqual(['ITEM_ETC_GOLD_01', '10000'])
    invalidGm(gm.item('ITEM_ETC_GOLD_01', '10001'))
    invalidGm(gm.item('ITEM-1'))
    expect(validGm(gm.kill())).toEqual({ t: 'gm', cmd: 'kill', args: [] })
    expect(validGm(gm.kill(' 42 '))).toEqual({ t: 'gm', cmd: 'kill', args: ['42'] })
    expect(validGm(gm.kill(7)).args).toEqual(['7'])
    invalidGm(gm.kill('-1'))
    invalidGm(gm.kill('abc'))
    expect(validGm(gm.heal())).toEqual({ t: 'gm', cmd: 'heal', args: [] })
    expect(validGm(gm.heal('@Xiao_Lin'))).toEqual({ t: 'gm', cmd: 'heal', args: ['Xiao_Lin'] })
    invalidGm(gm.heal('no'))
    for (const code of GM_QUICK_MOBS) validGm(gm.spawn(code))
    for (const q of GM_QUICK_ITEMS) validGm(gm.item(q.code, q.count))
    expect(contentCode('item_ch_sword_01_a')).toBe('ITEM_CH_SWORD_01_A')
    expect(contentCode('a b')).toBeNull()
    expect(gmCount('', 5)).toBeUndefined()
    expect(gmCount('6', 5)).toBeNull()
    expect(prettyMob('MOB_CH_TIGERWOMAN')).toBe('Tigerwoman')
  })
})
