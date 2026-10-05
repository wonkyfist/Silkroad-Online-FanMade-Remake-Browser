/**
 * The Alchemy window's logic (hud/alchemy.ts AlchemyModel; docs/SYSTEMS_COMBAT.md §4.3–4.7, docs/WAVE_PLAN2.md D40,
 * D44, D48) and the feature's bag right-click routing (world/features/alchemy.ts). No DOM: the model and the pure
 * helpers only. The rules mirror apps/server/src/alchemy.ts (the server stays authoritative).
 */
import { parseClientMessage, type ItemDef, type ItemStack } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import {
  ALCHEMY_H,
  ALCHEMY_SLOTS,
  ALCHEMY_W,
  AlchemyModel,
  CLOSED_AT,
  DEFAULT_ALCHEMY_MAX_PLUS,
  DEFAULT_ALCHEMY_RATE,
  PANEL_H,
  PANEL_W,
  SLOT_AT,
  formatChance,
  slotFor,
  successChance,
  type AlchemyProblem,
} from '../src/hud/alchemy.ts'
import { en, type StringKey } from '../src/i18n/en.ts'
import { bagRoute, besideInventory } from '../src/world/features/alchemy.ts'

const ELIXIR_RATES = [25, 20, 15, 10, 10, 10, 10, 10, 10, 5, 5, 5]
const POWDER_RATES = [50, 30, 20, 8, 8, 8, 8, 8, 8, 8, 8, 8]

const def = (code: string, over: Partial<ItemDef>): ItemDef => ({
  code, id: 1, name: code, typeId: [3, 3, 1, 1], category: 'etc', degree: 0, reqLevel: 0, reqGender: 'any', race: 'any', maxStack: 1, price: 1, sellPrice: 1, model: null, icon: null, ...over,
})
const SWORD = def('ITEM_CH_SWORD_01_A', { name: 'Copper Sword', category: 'weapon', slot: 'weapon', typeId: [3, 1, 6, 2], degree: 1 })
const SWORD_D2 = def('ITEM_CH_SWORD_03_A', { name: 'Iron Sword', category: 'weapon', slot: 'weapon', typeId: [3, 1, 6, 2], degree: 2 })
const ARMOR = def('ITEM_CH_M_HEAVY_01_BA_A', { category: 'armor', slot: 'chest', typeId: [3, 1, 3, 3], degree: 1 })
const RING = def('ITEM_CH_RING_01_A', { category: 'accessory', slot: 'ring', typeId: [3, 1, 5, 3], degree: 1 })
const E_WEAPON = def('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', { category: 'alchemy', typeId: [3, 3, 10, 1], degree: 1, reinforce: { kind: 'elixir', targets: [6], rates: ELIXIR_RATES } })
const E_ARMOR = def('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ARMOR_A', { category: 'alchemy', typeId: [3, 3, 10, 1], degree: 1, reinforce: { kind: 'elixir', targets: [1, 2, 3], rates: ELIXIR_RATES } })
const E_ACC = def('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ACCESSARY_A', { category: 'alchemy', typeId: [3, 3, 10, 1], degree: 1, reinforce: { kind: 'elixir', targets: [5], rates: ELIXIR_RATES } })
const P1 = def('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01', { category: 'alchemy', typeId: [3, 3, 10, 2], degree: 1, maxStack: 50, reinforce: { kind: 'powder', degree: 1, rates: POWDER_RATES } })
const P2 = def('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_02', { category: 'alchemy', typeId: [3, 3, 10, 2], degree: 1, maxStack: 50, reinforce: { kind: 'powder', degree: 2, rates: POWDER_RATES } })
const POTION = def('ITEM_ETC_HP_POTION_01', { category: 'potion', maxStack: 50, use: { hp: 100 } })
const DEFS = new Map([SWORD, SWORD_D2, ARMOR, RING, E_WEAPON, E_ARMOR, E_ACC, P1, P2, POTION].map(d => [d.code, d]))

/** A bag the test edits directly. */
function bagOf(...stacks: (ItemStack | null)[]) {
  const bag: (ItemStack | null)[] = [...stacks, ...Array<ItemStack | null>(32 - stacks.length).fill(null)]
  const model = new AlchemyModel({ def: c => DEFS.get(c), item: i => bag[i] ?? null })
  return { bag, model }
}
const s = (code: string, extra: Partial<ItemStack> = {}): ItemStack => ({ code, count: 1, ...extra })

describe('rules (the server formula, §4.3)', () => {
  it('success table at rate 1: 75 / 50 / 35 / 18 with a matching powder, 25 / 20 without; clamped to 100', () => {
    expect([0, 1, 2, 3].map(p => successChance(SWORD, p, E_WEAPON, P1, 1))).toEqual([75, 50, 35, 18])
    expect([0, 1].map(p => successChance(SWORD, p, E_WEAPON, null, 1))).toEqual([25, 20])
    expect(successChance(SWORD, 0, E_WEAPON, P2, 1)).toBe(25)
    expect(successChance(SWORD_D2, 0, E_WEAPON, P2, 1)).toBe(75)
    expect(successChance(SWORD, 3, E_WEAPON, P1, 1.5)).toBe(27)
    expect(successChance(SWORD, 0, E_WEAPON, P1, 1.5)).toBe(100)
    expect(formatChance(27)).toBe('27')
    expect(formatChance(52.5)).toBe('52.5')
    expect(formatChance(100 / 3)).toBe('33.3')
  })

  it('slotFor: equipment → item, elixirs → elixir, powders → powder, anything else → null', () => {
    expect(slotFor(SWORD)).toBe('item')
    expect(slotFor(ARMOR)).toBe('item')
    expect(slotFor(RING)).toBe('item')
    expect(slotFor(E_WEAPON)).toBe('elixir')
    expect(slotFor(P1)).toBe('powder')
    expect(slotFor(POTION)).toBeNull()
    expect(slotFor(undefined)).toBeNull()
  })
})

describe('AlchemyModel', () => {
  it('places each bag item in its slot, replaces, and never holds one bag slot twice', () => {
    const { model } = bagOf(s(SWORD.code), s(E_WEAPON.code), s(P1.code, { count: 5 }), s(POTION.code, { count: 3 }), s(ARMOR.code))
    expect(model.place(0)).toBe('item')
    expect(model.place(1)).toBe('elixir')
    expect(model.place(2)).toBe('powder')
    expect(model.place(3)).toBe('notMaterial')
    expect(model.place(9)).toBeNull()
    expect(ALCHEMY_SLOTS.map(k => model.bagOf(k))).toEqual([0, 1, 2])
    expect(model.place(4)).toBe('item')
    expect(model.bagOf('item')).toBe(4)
    expect(model.lockedBags()).toEqual(new Set([4, 1, 2]))
    expect(model.remove('powder')).toBe(true)
    expect(model.lockedBags()).toEqual(new Set([4, 1]))
  })

  it('the preview chance uses the world rate; the request carries bag indexes and the powder only when placed', () => {
    const { model } = bagOf(s(SWORD.code, { plus: 2 }), s(E_WEAPON.code), s(P1.code, { count: 5 }))
    expect(model.rate).toBe(DEFAULT_ALCHEMY_RATE)
    expect(model.maxPlus).toBe(DEFAULT_ALCHEMY_MAX_PLUS)
    model.place(0)
    model.place(1)
    model.rate = 1
    expect(model.chance()).toBe(15)
    model.place(2)
    expect(model.chance()).toBe(35)
    model.rate = 1.5
    expect(model.chance()).toBe(52.5)
    const msg = model.fuse()
    expect(msg).toEqual({ t: 'alchemyReinforce', item: 0, elixir: 1, powder: 2 })
    expect(parseClientMessage(JSON.stringify(msg))).toEqual({ ok: true, msg })
    expect(model.phase).toBe('sent')
    expect(model.fuse()).toBeNull()
    const b = bagOf(s(SWORD.code), s(E_WEAPON.code))
    b.model.place(0)
    b.model.place(1)
    expect(b.model.fuse()).toEqual({ t: 'alchemyReinforce', item: 0, elixir: 1 })
  })

  it('problems in the server order: equipment, broken (D48), elixir, fit, powder degree, max plus', () => {
    const cases: [ItemStack[], number[], AlchemyProblem | null, number?][] = [
      [[], [], 'noItem'],
      [[s(E_WEAPON.code)], [0], 'noItem'],
      [[s(SWORD.code, { durability: 0 }), s(E_WEAPON.code)], [0, 1], 'broken'],
      [[s(SWORD.code)], [0], 'noElixir'],
      [[s(ARMOR.code), s(E_WEAPON.code)], [0, 1], 'elixirMismatch'],
      [[s(RING.code), s(E_ACC.code)], [0, 1], null],
      [[s(ARMOR.code), s(E_ARMOR.code)], [0, 1], null],
      [[s(SWORD.code), s(E_WEAPON.code), s(P2.code)], [0, 1, 2], 'powderMismatch'],
      [[s(SWORD_D2.code), s(E_WEAPON.code), s(P2.code)], [0, 1, 2], null],
      [[s(SWORD.code, { plus: 10 }), s(E_WEAPON.code)], [0, 1], 'maxPlus'],
      [[s(SWORD.code, { plus: 9 }), s(E_WEAPON.code)], [0, 1], null],
    ]
    for (const [stacks, put, want, max] of cases) {
      const { model } = bagOf(...stacks)
      if (max) model.maxPlus = max
      for (const i of put) model.place(i)
      expect(model.problem(), JSON.stringify(stacks)).toBe(want)
      expect(model.canFuse()).toBe(want === null)
      expect(model.chance() === null).toBe(want !== null)
    }
    const low = bagOf(s(SWORD.code, { plus: 3 }), s(E_WEAPON.code))
    low.model.maxPlus = 3
    low.model.place(0)
    low.model.place(1)
    expect(low.model.problem()).toBe('maxPlus')
  })

  it('an inventory change empties the slots whose items left or changed (sync)', () => {
    const { bag, model } = bagOf(s(SWORD.code), s(E_WEAPON.code), s(P1.code, { count: 5 }))
    for (const i of [0, 1, 2]) model.place(i)
    bag[2] = s(P1.code, { count: 4 })
    expect(model.sync()).toBe(false)
    bag[1] = null
    expect(model.sync()).toBe(true)
    expect(model.bagOf('elixir')).toBeNull()
    bag[0] = s(POTION.code)
    model.sync()
    expect(model.bagOf('item')).toBeNull()
    expect(model.problem()).toBe('noItem')
  })

  it('fuse lifecycle: sent → fusing → result; nothing can be placed or removed meanwhile; a refusal goes back to idle', () => {
    const { bag, model } = bagOf(s(SWORD.code, { plus: 1 }), s(E_WEAPON.code), s(P1.code, { count: 5 }), s(ARMOR.code))
    for (const i of [0, 1, 2]) model.place(i)
    model.fuse()
    model.refused()
    expect(model.phase).toBe('idle')
    model.fuse()
    model.started()
    expect(model.phase).toBe('fusing')
    expect(model.place(3)).toBeNull()
    expect(model.remove('item')).toBe(false)
    // The server's inventoryUpdate comes first: the sword is +2, the elixir gone, one powder used.
    bag[0] = s(SWORD.code, { plus: 2 })
    bag[1] = null
    bag[2] = s(P1.code, { count: 4 })
    model.sync()
    expect(model.result('success')).toBe('success')
    expect(model.phase).toBe('idle')
    // Retail: the equipment stays, the elixir and powder slots are emptied.
    expect(model.bagOf('item')).toBe(0)
    expect(model.stack('item')).toMatchObject({ plus: 2 })
    expect(model.bagOf('elixir')).toBeNull()
    expect(model.bagOf('powder')).toBeNull()
  })

  it('a cancelled fuse keeps every slot; a failure that emptied the item slot reads as destroyed', () => {
    const { bag, model } = bagOf(s(SWORD.code, { plus: 6 }), s(E_WEAPON.code), s(P1.code, { count: 5 }))
    for (const i of [0, 1, 2]) model.place(i)
    model.fuse()
    model.started()
    expect(model.result('cancelled')).toBe('cancelled')
    expect(ALCHEMY_SLOTS.map(k => model.bagOf(k))).toEqual([0, 1, 2])
    model.fuse()
    model.started()
    bag[0] = null
    bag[1] = null
    model.sync()
    expect(model.result('fail')).toBe('destroyed')
    const b = bagOf(s(SWORD.code, { plus: 4 }), s(E_WEAPON.code))
    b.model.place(0)
    b.model.place(1)
    b.model.fuse()
    b.model.started()
    b.bag[0] = s(SWORD.code)
    b.bag[1] = null
    b.model.sync()
    expect(b.model.result('fail')).toBe('fail')
    expect(b.model.stack('item')).toEqual(s(SWORD.code))
  })
})

describe('Cancel sends one alchemyCancel per fuse (playtest fix)', () => {
  it('fusing → cancel once: more presses send nothing until the result; the window shows Cancel greyed meanwhile', () => {
    const { model } = bagOf(s(SWORD.code), s(E_WEAPON.code), s(P1.code, { count: 5 }))
    for (const i of [0, 1, 2]) model.place(i)
    expect(model.cancel()).toBe(false) // idle: nothing to cancel
    model.fuse()
    model.started()
    expect(model.cancel()).toBe(true)
    expect(model.phase).toBe('cancelling')
    expect(model.cancel()).toBe(false)
    expect(model.cancel()).toBe(false)
    expect(model.canFuse()).toBe(false)
    expect(model.place(0)).toBeNull()
    expect(model.result('cancelled')).toBe('cancelled')
    expect(model.phase).toBe('idle')
    expect(model.canFuse()).toBe(true)
  })

  it('a cancel while the Fuse is still on the wire: alchemyStart keeps it pending, a refusal ends it', () => {
    const { model } = bagOf(s(SWORD.code), s(E_WEAPON.code))
    model.place(0)
    model.place(1)
    model.fuse()
    expect(model.cancel()).toBe(true) // the window closed before alchemyStart
    model.started()
    expect(model.phase).toBe('cancelling')
    expect(model.result('cancelled')).toBe('cancelled')
    model.fuse()
    expect(model.cancel()).toBe(true)
    model.refused() // the Fuse was refused: no fuse, no result will come
    expect(model.phase).toBe('idle')
  })

  it('the fuse finished before the cancel arrived: the success still lands', () => {
    const { bag, model } = bagOf(s(SWORD.code), s(E_WEAPON.code))
    model.place(0)
    model.place(1)
    model.fuse()
    model.started()
    model.cancel()
    bag[0] = s(SWORD.code, { plus: 1 })
    bag[1] = null
    model.sync()
    expect(model.result('success')).toBe('success')
    expect(model.phase).toBe('idle')
  })
})

describe('the window opens beside the inventory (playtest fix: it opened under it)', () => {
  // Alchemy 408 x 336; the Main window 388 x 408 with its 42-px side strip.
  it('overlapping: left of the Main window and its strip when it fits, else right of it, else the left edge', () => {
    expect(besideInventory([440, 120, 408, 336], [500, 100, 388, 408], 1600)).toEqual([500 - 42 - 8 - 408, 100])
    expect(besideInventory([440, 120, 408, 336], [440, 100, 388, 408], 1280)).toEqual([440 + 388 + 8, 100])
    expect(besideInventory([300, 120, 408, 336], [300, 100, 388, 408], 900)).toEqual([0, 100])
  })

  it('apart already (or only touching): stays where it is', () => {
    expect(besideInventory([0, 100, 408, 336], [500, 100, 388, 408], 1600)).toBeNull()
    expect(besideInventory([900, 100, 408, 336], [500, 100, 388, 408], 1600)).toBeNull()
    expect(besideInventory([500, 520, 408, 336], [500, 100, 388, 408], 1600)).toBeNull()
  })
})

describe('bag right-click routing (world/features/alchemy.ts)', () => {
  it('opens on a material, fills the open window, and leaves the click to an open shop / storage on top', () => {
    expect(bagRoute(false, 0, [], 'elixir')).toBe('open')
    expect(bagRoute(false, 0, [], 'powder')).toBe('open')
    expect(bagRoute(false, 0, [], 'item')).toBe('pass') // equipment still equips
    expect(bagRoute(false, 0, [], null)).toBe('pass')
    expect(bagRoute(false, 0, [120], 'elixir')).toBe('pass') // selling it at the shop
    expect(bagRoute(true, 130, [], 'item')).toBe('put')
    expect(bagRoute(true, 130, [120], 'item')).toBe('put') // the alchemy window is on top
    expect(bagRoute(true, 110, [120], 'powder')).toBe('pass') // the shop is on top
    expect(bagRoute(true, 130, [], null)).toBe('pass') // a potion is still drunk
  })
})

describe('layout (docs/UI.md §4.6, D40) and strings', () => {
  it('the reinforce panel keeps the retail size; the three slots and the closed frames sit inside it', () => {
    expect([PANEL_W, PANEL_H]).toEqual([376, 192])
    expect(ALCHEMY_W).toBe(408)
    expect(ALCHEMY_H).toBeLessThanOrEqual(360)
    const rects = [...ALCHEMY_SLOTS.map(k => [...SLOT_AT[k], 36] as const), ...CLOSED_AT.map(([x, y]) => [x, y, 32] as const)]
    for (const [x, y, w] of rects) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(PANEL_W)
      expect(y + w).toBeLessThanOrEqual(PANEL_H)
    }
    // Elixir → the first material frame (x 164), powder → the second (212): icons at +2 in the 36-px slot.
    expect(SLOT_AT.elixir[0] + 2).toBe(164)
    expect(SLOT_AT.powder[0] + 2).toBe(212)
  })

  it('every string the window uses exists in en', () => {
    const keys: string[] = ['alchemy.title', 'alchemy.menu', 'alchemy.heading', 'alchemy.hint', 'alchemy.target', 'alchemy.chance', 'alchemy.warning', 'alchemy.fuse', 'alchemy.cancel', 'alchemy.fusing', 'alchemy.slot.empty', 'alchemy.slot.remove', 'alchemy.problem.notMaterial']
    for (const k of ALCHEMY_SLOTS) keys.push(`alchemy.slot.${k}`)
    for (const p of ['noItem', 'notEquipment', 'broken', 'noElixir', 'elixirMismatch', 'powderMismatch', 'maxPlus'] satisfies AlchemyProblem[]) keys.push(`alchemy.problem.${p}`)
    for (const o of ['success', 'fail', 'destroyed', 'cancelled']) keys.push(`alchemy.result.${o}`)
    for (const k of keys) expect(en[k as StringKey], k).toBeTruthy()
    for (const r of ['alchemy_mismatch', 'max_plus', 'broken', 'busy']) expect(en[`action.fail.${r}` as StringKey], r).toBeTruthy()
  })
})
