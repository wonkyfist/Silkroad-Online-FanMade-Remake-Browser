/**
 * The character bench's crowd (apps/server/src/cli/charbench-bots.ts, docs/CHARACTERS.md §1.1): seeded and
 * reproducible, the behaviour split, the plaza placement, and the dressing (one degree and armour class per bot, the
 * family's weapon, +N and seals within their rates, gear the bot's gender may wear).
 */
import type { ItemDef } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { PLAZA, SPLIT, behaviourOf, dressFor, gearIndex, plazaPoint, seeded } from '../src/cli/charbench-bots.ts'

const item = (o: Partial<ItemDef> & { code: string }): ItemDef =>
  ({ id: 0, name: null, typeId: [0, 0, 0, 0], category: 'equipment', degree: 1, reqLevel: 1, reqGender: 'any', race: 'china', maxStack: 1, price: 0, sellPrice: 0, model: { glb: 'x.glb' }, icon: null, ...o }) as unknown as ItemDef

const ITEMS: ItemDef[] = [
  ...[1, 2].flatMap(degree => [
    item({ code: `ITEM_CH_SWORD_0${degree}_A`, slot: 'weapon', weaponType: 'sword', degree }),
    ...['A', 'B', 'C'].map(t => item({ code: `ITEM_CH_SWORD_0${degree}_${t}_RARE`, slot: 'weapon', weaponType: 'sword', degree })),
    item({ code: `ITEM_CH_SHIELD_0${degree}_A`, slot: 'shield', degree }),
    ...(['head', 'shoulders', 'chest', 'legs', 'hands', 'feet'] as const).flatMap(slot => [
      item({ code: `ITEM_CH_W_LIGHT_0${degree}_${slot}`, slot, armorType: 'protector', reqGender: 'female', degree }),
      item({ code: `ITEM_CH_M_LIGHT_0${degree}_${slot}`, slot, armorType: 'protector', reqGender: 'male', degree }),
      item({ code: `ITEM_CH_W_CLOTHES_0${degree}_${slot}`, slot, armorType: 'garment', reqGender: 'female', degree }),
      item({ code: `ITEM_CH_W_HEAVY_0${degree}_${slot}`, slot, armorType: 'armor', reqGender: 'female', degree }),
    ]),
  ]),
  item({ code: 'ITEM_EU_SWORD_01_A', slot: 'weapon', weaponType: 'sword', race: 'europe' }),
]

describe('the bench crowd', () => {
  it('seeded: the same seed gives the same sequence', () => {
    const a = seeded(7)
    const b = seeded(7)
    const xs = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs)
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true)
    expect(seeded(8)()).not.toBe(xs[0])
  })

  it('splits 100 bots into 30 walkers, 30 fighters and 40 standing (8 sitting, 8 waving)', () => {
    const kinds = Array.from({ length: 100 }, (_, k) => behaviourOf(k, 100))
    const count = (k: string) => kinds.filter(x => x === k).length
    expect(count('walk')).toBe(100 * SPLIT.walk)
    expect(count('fight')).toBe(100 * SPLIT.fight)
    expect(count('sit')).toBe(8)
    expect(count('wave')).toBe(8)
    expect(count('stand')).toBe(24)
  })

  it('places every bot in the plaza disc, no two on one spot', () => {
    const pts = Array.from({ length: 100 }, (_, k) => plazaPoint(k, 100))
    for (const [x, z] of pts) expect(Math.hypot(x - PLAZA.x, z - PLAZA.z)).toBeLessThanOrEqual(PLAZA.r + 1e-9)
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i]![0] - pts[j]![0], pts[i]![1] - pts[j]![1])).toBeGreaterThan(0.5)
  })

  it('dresses a bot in one degree and class its gender wears, its family weapon, +0..12, seals within their rates', () => {
    const gear = gearIndex(ITEMS)
    expect(gear.degrees).toEqual([1, 2])
    const data = { item: (c: string) => ITEMS.find(i => i.code === c) }
    const rand = seeded(3)
    let sealed = 0
    let plain = 0
    for (let k = 0; k < 400; k++) {
      const d = dressFor(rand, 'female', 'sword', gear, data)
      expect([1, 2]).toContain(d.degree)
      expect(d.plus).toBeGreaterThanOrEqual(0)
      expect(d.plus).toBeLessThanOrEqual(12)
      if (d.plus === 0) plain++
      for (const [slot, code] of Object.entries(d.equip)) {
        const it = data.item(code)!
        expect(it.race).not.toBe('europe')
        expect(it.degree).toBe(d.degree)
        if (it.armorType) {
          expect(it.reqGender === 'any' || it.reqGender === 'female').toBe(true)
          expect(it.slot).toBe(slot)
        }
      }
      expect(d.equip.weapon).toMatch(/^ITEM_CH_SWORD_0\d_(A|[ABC]_RARE)$/)
      if (d.seal) {
        sealed++
        expect(d.equip.weapon).toMatch(/_RARE$/)
      }
    }
    expect(sealed / 400).toBeGreaterThan(0.1)
    expect(sealed / 400).toBeLessThan(0.26)
    expect(plain / 400).toBeGreaterThan(0.25)
    expect(plain / 400).toBeLessThan(0.42)
  })
})
