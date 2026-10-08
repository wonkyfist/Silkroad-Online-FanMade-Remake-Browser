/**
 * Degree 4, the Climb's cap tier (docs/CLIMB.md §4.1.2, D53) on the real export (skips without work/out/data):
 * alchemy +1..+7 on degree-4 gear (elixirs by kind, the 4th Lucky Powder by degree), the GM `climb gear` view, and
 * (§4.1.3, D54) every degree-3 seal weaker than every degree-4 seal of its family, for every kind.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyClimbItemLevels, contentEntries, type ItemDef } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { elixirFits, isReinforceable, powderFits, successChance } from '../src/alchemy.ts'
import { climbGm } from '../src/climb.ts'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'

const FILE = join(REPO_ROOT, 'work/out/data/items.json')
const HAVE = existsSync(FILE)

describe.skipIf(!HAVE)('degree 4 on the real export (CLIMB §4.1.2, D53)', () => {
  const all = HAVE ? contentEntries<ItemDef>(JSON.parse(readFileSync(FILE, 'utf8')), 'items') : []
  const items = new Map(all.map((i) => [i.code, i]))
  applyClimbItemLevels(items)
  const get = (c: string) => items.get(c)!

  it('alchemy: the weapon and armour elixirs fit degree-4 rows, the 4th powder matches them and only them; +1..+7 have a chance', () => {
    const sword = get('ITEM_CH_SWORD_04_C')
    const sun = get('ITEM_CH_SWORD_04_C_RARE')
    const chest = get('ITEM_CH_W_CLOTHES_04_BA_B')
    const powder4 = get('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_04')
    const powder3 = get('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03')
    for (const it of [sword, sun, chest]) expect(isReinforceable(it), it.code).toBe(true)
    expect(elixirFits(get('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A'), sword)).toBe(true)
    expect(elixirFits(get('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ARMOR_A'), chest)).toBe(true)
    expect(elixirFits(get('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ARMOR_A'), sword)).toBe(false)
    expect(powderFits(powder4, sword)).toBe(true)
    expect(powderFits(powder3, sword)).toBe(false)
    expect(powderFits(powder4, get('ITEM_CH_SWORD_03_C'))).toBe(false)
    const elixir = get('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A')
    for (let plus = 0; plus < 7; plus++) {
      const bare = successChance(sword, plus, elixir, null, 1)
      expect(bare, `+${plus + 1}`).toBeGreaterThan(0)
      expect(successChance(sword, plus, elixir, powder4, 1)).toBeGreaterThanOrEqual(bare)
    }
  })

  it('power order (D54): every degree-3 seal is weaker than every degree-4 seal of its family, on every kind and stat', () => {
    const STATS = ['physAttack', 'magAttack', 'physDefence', 'magDefence', 'parryRate', 'blockRate', 'physAbsorb', 'magAbsorb', 'hitRate', 'critRate'] as const
    const kinds = new Set<string>()
    let families = 0
    for (const star3 of items.values()) {
      const m = /^(ITEM_CH_.+)_03((?:_[A-Z]{2})?)_A_RARE$/.exec(star3.code)
      if (!m) continue
      const seals = (d: number) => ['A', 'B', 'C'].map((l) => items.get(`${m[1]}_0${d}${m[2]}_${l}_RARE`)!)
      const [d3, d4] = [seals(3), seals(4)]
      expect(d4.every(Boolean), m[1]).toBe(true)
      families++
      kinds.add(star3.category)
      for (const a of d3) {
        for (const b of d4) {
          for (const k of STATS) for (const i of [0, 1]) if (a.stats?.[k]) expect(a.stats[k]![i], `${a.code} ${k}[${i}] vs ${b.code}`).toBeLessThanOrEqual(b.stats?.[k]?.[i] ?? Infinity)
          for (const [k, v] of Object.entries(a.perPlus ?? {})) expect(v, `${a.code} perPlus.${k}`).toBeLessThanOrEqual((b.perPlus as Record<string, number>)[k] ?? Infinity)
          const main = (['physAttack', 'physDefence', 'physAbsorb'] as const).find((k) => a.stats?.[k])!
          expect(a.stats![main]![1], `${a.code} ${main} max < ${b.code}`).toBeLessThan(b.stats![main]![1])
        }
      }
      // the degree-3 seals keep their own order, Star <= Moon <= Sun
      for (const k of STATS) for (const i of [0, 1]) if (d3[0]!.stats?.[k]) expect(d3[0]!.stats[k]![i]).toBeLessThanOrEqual(d3[1]!.stats![k]![i]), expect(d3[1]!.stats![k]![i]).toBeLessThanOrEqual(d3[2]!.stats![k]![i])
    }
    expect(families).toBe(51)
    expect([...kinds].sort()).toEqual(['accessory', 'armor', 'shield', 'weapon'])
    // a degree-3 Sun may still beat a degree-4 regular grade (the user: "stronger than regular weapons yes")
    expect(get('ITEM_CH_BLADE_03_C_RARE').stats!.physAttack![1]).toBeGreaterThan(get('ITEM_CH_BLADE_04_A').stats!.physAttack![1])
  })

  it('GM `climb gear`: the four spans and tiers; one item with its retail level', () => {
    const data = new GameData({ items: [...items.values()] })
    const ctx = { data, config: { levelCap: 25 }, nests: () => 0 }
    const r = climbGm(ctx, ['gear'])
    expect(r.ok).toBe(true)
    expect(r.message).toContain('D4 21-25 (retail 24-34, 306 rows)')
    expect(r.message).toContain('T10 D4 C 23-25')
    const one = climbGm(ctx, ['gear', 'item_ch_m_heavy_04_ba_c'])
    expect(one).toMatchObject({ ok: true, data: { degree: 4, reqLevel: 25, retailReqLevel: 34 } })
    expect(climbGm(ctx, ['gear', 'ITEM_NOPE']).ok).toBe(false)
  })
})
