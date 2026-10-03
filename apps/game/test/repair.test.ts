/**
 * Lane DR, client (docs/SYSTEMS_COMBAT.md §3.4; docs/WAVE_PLAN2.md §6.4): the DOM-free parts of durability and repair:
 * the durability states and the repair price (the server's numbers: a broken Copper Sword 198, 70/76 costs 16), the
 * repair targets and total of the Repair all preview, the hammer's slot refs and checks, the intents (valid for the
 * shared validator), the footer `when` (M6), the slot decorator (M9), the warning list and the wear cues (M2), and the
 * durability hunk of the item tooltip (D11).
 */
import { parseClientMessage, type ItemDef, type ItemStack } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { ItemCatalog } from '../src/hud/items.ts'
import {
  DUR_WARN_PCT,
  durabilityState,
  hammerCheck,
  isRepairable,
  maxDurability,
  repairIntent,
  repairPrice,
  repairRefOf,
  repairTargets,
  repairTotal,
  repairWhen,
  type InvView,
} from '../src/hud/repair.ts'
import { footerButtonShown } from '../src/hud/shop.ts'
import { dialogOptions } from '../src/hud/shop-logic.ts'
import { registerSlotDecorator, slotSigns } from '../src/hud/slots.ts'
import { t } from '../src/i18n/index.ts'
import { durabilityDecorator, FIGURE_PART, wearCue, wornWarnings } from '../src/world/features/durability.ts'

const base = { id: 1, typeId: [3, 1, 6, 2] as [number, number, number, number], degree: 1, reqLevel: 1, reqGender: 'any' as const, race: 'china' as const, maxStack: 1, price: 890, sellPrice: 100, model: null, icon: null }
const SWORD: ItemDef = { ...base, code: 'ITEM_CH_SWORD_01_A', name: 'Copper Sword', category: 'weapon', slot: 'weapon', weaponType: 'sword', canRepair: true, repairCost: 198, stats: { physAttack: [30, 36], durability: [62, 76] } }
const SHIELD: ItemDef = { ...base, code: 'ITEM_CH_SHIELD_01_A', name: 'Copper Shield', category: 'shield', slot: 'shield', canRepair: true, repairCost: 110, stats: { physDefence: [3, 3], durability: [46, 56] } }
const CHEST: ItemDef = { ...base, code: 'ITEM_CH_M_HEAVY_01_BA_A', name: 'Copper Armor', category: 'armor', slot: 'chest', canRepair: true, repairCost: 116, stats: { physDefence: [8, 8], durability: [48, 59] } }
const RING: ItemDef = { ...base, code: 'ITEM_CH_RING_01_A', name: 'Ring', category: 'accessory', slot: 'ring', canRepair: false }
const POTION: ItemDef = { ...base, code: 'ITEM_ETC_HP_POTION_01', name: 'HP Potion', category: 'potion', maxStack: 50 }
const DEFS = new Map([SWORD, SHIELD, CHEST, RING, POTION].map(d => [d.code, d]))
const def = (code: string) => DEFS.get(code)
const s = (code: string, durability?: number): ItemStack => (durability === undefined ? { code, count: 1 } : { code, count: 1, durability })

const offs: (() => void)[] = []
afterEach(() => {
  for (const off of offs.splice(0)) off()
})

describe('durability states and prices (the server formula)', () => {
  it('max is the roll top; absent = full; low at <= 10 %, broken at 0; items without a roll have none', () => {
    expect(DUR_WARN_PCT).toBe(10)
    expect(maxDurability(SWORD)).toBe(76)
    expect(durabilityState(s(SWORD.code), SWORD)).toBe('ok')
    expect(durabilityState(s(SWORD.code, 8), SWORD)).toBe('ok')
    expect(durabilityState(s(SWORD.code, 7), SWORD)).toBe('low')
    expect(durabilityState(s(SWORD.code, 1), SWORD)).toBe('low')
    expect(durabilityState(s(SWORD.code, 0), SWORD)).toBe('broken')
    expect(durabilityState(s(RING.code), RING)).toBeNull()
    expect(durabilityState(s('ITEM_UNKNOWN'), undefined)).toBeNull()
  })

  it('ceil(repairCost × missing / max): broken 198, 70/76 → 16; full, rings and potions cost nothing', () => {
    expect(repairPrice(SWORD, s(SWORD.code, 0))).toBe(198)
    expect(repairPrice(SWORD, s(SWORD.code, 70))).toBe(16)
    expect(repairPrice(SHIELD, s(SHIELD.code, 28))).toBe(55)
    expect(repairPrice(SWORD, s(SWORD.code))).toBe(0)
    expect(repairPrice(RING, s(RING.code))).toBe(0)
    expect(isRepairable(RING)).toBe(false)
    expect(isRepairable(POTION)).toBe(false)
  })

  it('Repair all preview: worn items first, then the bag; the total is their sum', () => {
    const inv: InvView = {
      equip: { weapon: s(SWORD.code, 70), shield: s(SHIELD.code, 28), chest: s(CHEST.code), ring1: s(RING.code) },
      bag: [s(POTION.code), null, s(SWORD.code, 0), s(RING.code)],
    }
    const targets = repairTargets(inv, def)
    expect(targets).toEqual([
      { ref: { equip: 'weapon' }, code: SWORD.code, price: 16 },
      { ref: { equip: 'shield' }, code: SHIELD.code, price: 55 },
      { ref: { bag: 2 }, code: SWORD.code, price: 198 },
    ])
    expect(repairTotal(targets)).toBe(269)
    expect(repairTargets({ equip: { ring1: s(RING.code) }, bag: [] }, def)).toEqual([])
  })
})

describe('Repair buttons and the hammer (hud/repair.ts)', () => {
  it('the footer buttons show only for an NPC offering repair; the dialog lists no separate Repair option', () => {
    expect(repairWhen(['shop', 'repair'])).toBe(true)
    expect(repairWhen(['shop'])).toBe(false)
    expect(footerButtonShown({ when: repairWhen }, ['shop', 'repair'])).toBe(true)
    expect(footerButtonShown({ when: repairWhen }, ['shop', 'storage'])).toBe(false)
    expect(dialogOptions(['shop', 'repair'])).toEqual(['shop'])
  })

  it('the hammer reads bag and equipment slot refs only (shop and storage slots are not items of yours)', () => {
    const ds = (d: Record<string, string>) => ({ dataset: d as DOMStringMap })
    expect(repairRefOf(ds({ bag: '7' }))).toEqual({ bag: 7 })
    expect(repairRefOf(ds({ equip: 'weapon' }))).toEqual({ equip: 'weapon' })
    expect(repairRefOf(ds({ equip: '100' }))).toBeNull() // a shop slot (SlotView writes its number into data-equip)
    expect(repairRefOf(ds({ bag: '-1' }))).toBeNull()
    expect(repairRefOf(ds({}))).toBeNull()
    expect(repairRefOf(null)).toBeNull()
  })

  it('a hammer click is sent only when it can work: empty, unrepairable, full and too poor are answered locally', () => {
    const inv: InvView = { equip: { weapon: s(SWORD.code, 0) }, bag: [s(RING.code), s(SWORD.code), null] }
    expect(hammerCheck(inv, def, { equip: 'weapon' }, 1000)).toEqual({ ok: true, price: 198 })
    expect(hammerCheck(inv, def, { equip: 'weapon' }, 197)).toEqual({ ok: false, why: 'gold' })
    expect(hammerCheck(inv, def, { bag: 0 }, 1000)).toEqual({ ok: false, why: 'unrepairable' })
    expect(hammerCheck(inv, def, { bag: 1 }, 1000)).toEqual({ ok: false, why: 'full' })
    expect(hammerCheck(inv, def, { bag: 2 }, 1000)).toEqual({ ok: false, why: 'empty' })
    expect(hammerCheck(inv, def, { equip: 'shield' }, 1000)).toEqual({ ok: false, why: 'empty' })
  })

  it('the intents pass the shared validator: one item, or none for Repair all', () => {
    const one = repairIntent(12, [{ bag: 3 }])
    expect(one).toEqual({ t: 'repair', npc: 12, items: [{ bag: 3 }] })
    expect(parseClientMessage(JSON.stringify(one)).ok).toBe(true)
    const all = repairIntent(12)
    expect(all).toEqual({ t: 'repair', npc: 12 })
    expect(parseClientMessage(JSON.stringify(all)).ok).toBe(true)
  })
})

describe('slot signs, warnings and cues (world/features/durability.ts)', () => {
  it('M9: broken and low items get their overlay on every slot; full items and rings get none', () => {
    offs.push(registerSlotDecorator(durabilityDecorator))
    expect(slotSigns(s(SWORD.code, 0), SWORD).durability).toBe('broken')
    expect(slotSigns({ ...s(SWORD.code, 5), plus: 3 }, SWORD)).toMatchObject({ durability: 'low', plus: 3 })
    expect(slotSigns(s(SWORD.code), SWORD).durability).toBe('ok')
    expect(slotSigns(s(RING.code), RING).durability).toBeUndefined()
  })

  it('M2: the warning strip lists the low and broken worn items in equipment order; the figure has a part for each', () => {
    const list = wornWarnings({ chest: s(CHEST.code, 3), weapon: s(SWORD.code, 0), shield: s(SHIELD.code), ring1: s(RING.code) }, def)
    expect(list.map(w => [w.slot, w.state])).toEqual([['weapon', 'broken'], ['chest', 'low']])
    for (const slot of ['weapon', 'shield', 'head', 'shoulders', 'chest', 'hands', 'legs', 'feet'] as const) expect(FIGURE_PART[slot]).toMatch(/^ifcommon\/com_re_/)
  })

  it('cues: danger when an item turns low, break when it breaks; swaps, repairs and no change are silent', () => {
    const w = (code: string, state: 'ok' | 'low' | 'broken' | null) => ({ code, state })
    expect(wearCue(w(SWORD.code, 'ok'), w(SWORD.code, 'low'))).toBe('ui.eqdanger')
    expect(wearCue(w(SWORD.code, 'low'), w(SWORD.code, 'broken'))).toBe('ui.eqbreak')
    expect(wearCue(w(SWORD.code, 'ok'), w(SWORD.code, 'broken'))).toBe('ui.eqbreak')
    expect(wearCue(w(SWORD.code, 'low'), w(SWORD.code, 'low'))).toBeNull()
    expect(wearCue(w(SWORD.code, 'broken'), w(SWORD.code, 'ok'))).toBeNull()
    expect(wearCue(w(SWORD.code, 'ok'), w(SHIELD.code, 'broken'))).toBeNull()
    expect(wearCue(undefined, w(SWORD.code, 'broken'))).toBeNull()
  })
})

describe('the durability line of the item tooltip (D11)', () => {
  const catalog = new ItemCatalog([SWORD, RING])
  const line = (stack: ItemStack) => catalog.tooltip(stack).find(l => l.text.startsWith('Durability'))

  it('a full item shows "max / max"; a worn one "cur / max"', () => {
    expect(line(s(SWORD.code))).toEqual({ text: 'Durability 76 / 76', cls: 'stat' })
    expect(line(s(SWORD.code, 40))).toEqual({ text: 'Durability 40 / 76', cls: 'stat' })
    expect(catalog.tooltip(s(RING.code)).some(l => l.text.startsWith('Durability'))).toBe(false)
  })

  it('<= 10 % is a warning; 0 is red with "(broken)" and the stats are dimmed', () => {
    expect(line(s(SWORD.code, 7))).toEqual({ text: 'Durability 7 / 76', cls: 'warn' })
    expect(line(s(SWORD.code, 0))).toEqual({ text: `Durability 0 / 76 ${t('dur.broken')}`, cls: 'bad' })
    const broken = catalog.tooltip(s(SWORD.code, 0)).find(l => l.text.startsWith('Phy. atk.'))
    expect(broken?.cls).toBe('struck')
    const fine = catalog.tooltip(s(SWORD.code, 40)).find(l => l.text.startsWith('Phy. atk.'))
    expect(fine?.cls).toBe('stat')
  })
})
