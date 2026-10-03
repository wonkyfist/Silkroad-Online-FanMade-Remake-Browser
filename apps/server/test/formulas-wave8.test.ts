/**
 * Wave 8 worn stats (docs/WAVE_PLAN2.md §4.2 "Worn stats", docs/SYSTEMS_COMBAT.md §3.2, §4.2): a worn item at +N adds
 * perPlus x N to its stats (attacks: both ends of the range); a broken worn item (durability 0) gives no stats and no
 * perPlus; a broken item cannot be equipped (inventory.ts equipItem, D48). Plus 0 and full items keep today's numbers.
 */
import type { ItemDef, ItemStack } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { isBroken, playerCombatStats, plusBonus } from '../src/formulas.ts'
import { InvDraft, equipItem, type InvState } from '../src/inventory.ts'
import { item } from './fixtures.ts'

const sword = item('ITEM_CH_SWORD_01_A', {
  category: 'weapon', slot: 'weapon', weaponType: 'sword', degree: 1, reqLevel: 1, race: 'china', typeId: [3, 1, 6, 2], range: 1.5,
  stats: { physAttack: [20, 30], magAttack: [10, 14], durability: [62, 76] },
  perPlus: { physAttack: 2.4, magAttack: 4.1 },
})
const armor = item('ITEM_CH_M_HEAVY_01_BA_A', {
  category: 'armor', slot: 'chest', armorType: 'armor', degree: 1, reqLevel: 1, race: 'china',
  stats: { physDefence: [10, 10], magDefence: [6, 6], parryRate: [4, 4], durability: [48, 59] },
  perPlus: { physDefence: 0.4, magDefence: 0.5, parryRate: 1 },
})
const ring = item('ITEM_CH_RING_01_A', { category: 'accessory', slot: 'ring', reqLevel: 1, race: 'china', stats: { physAbsorb: [2, 2], magAbsorb: [2, 2] }, perPlus: { physAbsorb: 0.23, magAbsorb: 0.23 } })

const worn = (...pairs: [ItemDef, Partial<ItemStack>][]) => pairs.map(([def, s]) => ({ def, stack: { code: def.code, count: 1, ...s } }))
const stats = (...pairs: [ItemDef, Partial<ItemStack>][]) => playerCombatStats(10, 30, 30, worn(...pairs))

describe('perPlus x plus', () => {
  it('plus 0 (or absent) keeps the plain numbers', () => {
    const plain = stats([sword, {}], [armor, {}], [ring, {}])
    expect(stats([sword, { plus: 0 }], [armor, { plus: 0 }], [ring, { plus: 0 }])).toEqual(plain)
    expect(plusBonus(sword, { code: sword.code, count: 1 }, 'physAttack')).toBe(0)
  })

  it('a +3 weapon adds 3 x perPlus to both ends of its attack ranges', () => {
    const plain = stats([sword, {}])
    const plus3 = stats([sword, { plus: 3 }])
    // Base [20, 30] + 3 x 2.4 = 7.2 on each end, rounded, plus the STR part.
    const sa = plain.physAttack[0] - 20
    expect(plus3.physAttack).toEqual([Math.round(27.2) + sa, Math.round(37.2) + sa])
    const ia = plain.magAttack[0] - 10
    expect(plus3.magAttack).toEqual([Math.round(10 + 12.3) + ia, Math.round(14 + 12.3) + ia])
  })

  it('armour and accessories add their defences, parry and absorbs', () => {
    const plus5 = stats([armor, { plus: 5 }], [ring, { plus: 5 }])
    // The same as wearing items whose rolls are already raised by 5 x perPlus.
    const raisedArmor = { ...armor, perPlus: undefined, stats: { ...armor.stats, physDefence: [12, 12], magDefence: [8.5, 8.5], parryRate: [9, 9] } } as ItemDef
    const raisedRing = { ...ring, perPlus: undefined, stats: { physAbsorb: [3.15, 3.15], magAbsorb: [3.15, 3.15] } } as ItemDef
    expect(plus5).toEqual(stats([raisedArmor, {}], [raisedRing, {}]))
    expect(plus5.physDefence).toBeGreaterThan(stats([armor, {}]).physDefence)
    expect(plus5.physAbsorb).toBe(3)
  })

  it('an item without perPlus ignores its plus', () => {
    const bare = item('ITEM_CH_SHIELD_01_A', { category: 'shield', slot: 'shield', stats: { physDefence: [3, 3] } })
    expect(stats([bare, { plus: 7 }])).toEqual(stats([bare, {}]))
  })
})

describe('broken worn items (durability 0)', () => {
  it('isBroken: only durability 0; absent or null = full', () => {
    expect(isBroken({ durability: 0 })).toBe(true)
    expect(isBroken({ durability: 1 })).toBe(false)
    expect(isBroken({})).toBe(false)
    expect(isBroken({ durability: null })).toBe(false)
  })

  it('a broken weapon gives no attack and no perPlus, but keeps its reach and family', () => {
    const fist = playerCombatStats(10, 30, 30, [])
    const broken = stats([sword, { plus: 4, durability: 0 }])
    expect(broken.physAttack).toEqual(fist.physAttack)
    expect(broken.magAttack).toEqual(fist.magAttack)
    expect(broken.range).toBe(1.5)
    expect(broken.weapon).toBe('sword')
    // One point of durability left is a whole weapon.
    expect(stats([sword, { plus: 4, durability: 1 }]).physAttack).toEqual(stats([sword, { plus: 4 }]).physAttack)
  })

  it('broken armour and accessories are skipped entirely', () => {
    const none = playerCombatStats(10, 30, 30, [])
    const broken = stats([armor, { plus: 3, durability: 0 }], [ring, { durability: 0 }])
    expect(broken).toEqual(none)
    const one = stats([armor, { durability: 0 }], [ring, {}])
    expect(one.physDefence).toBe(none.physDefence)
    expect(one.physAbsorb).toBe(2)
  })
})

describe('equipItem refuses a broken item (D48)', () => {
  const defs = (code: string) => [sword, armor, ring].find((d) => d.code === code)
  const inv = (dur: number | null): InvState => ({
    bagSize: 4,
    bag: [{ code: sword.code, count: 1, plus: 2, durability: dur }, null, null, null],
    equip: {},
    gold: 0,
  })
  const who = { level: 10, gender: 'male' as const }

  it("durability 0 -> 'broken'; nothing moves", () => {
    const d = new InvDraft(inv(0))
    expect(equipItem(d, 0, undefined, who, defs)).toMatchObject({ ok: false, reason: 'broken' })
    expect(d.changed).toBe(false)
  })

  it('any other durability (or full) equips as before', () => {
    for (const dur of [1, 76, null]) {
      const d = new InvDraft(inv(dur))
      expect(equipItem(d, 0, undefined, who, defs)).toEqual({ ok: true, value: 'weapon' })
    }
  })
})
