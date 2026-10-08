/**
 * Weapon rarity (docs/RARITY.md §2, §4): the seal codes and their tiers, the family and model rules, and the one-roll
 * tier draw (the rarest first, the tiers never overlap).
 */
import { describe, expect, it } from 'vitest'
import { RARITY, RARITY_DEFAULTS, RARITY_TIERS, modelCodeOf, parseServerMessage, rareCodeOf, rarityFamily, rarityOf, rarityRank, rollRarity } from '../src/index.ts'

describe('tiers from codes', () => {
  it('A/B/C _RARE are Star/Moon/Sun; the ordinary grades and _DEF rows are regular', () => {
    expect(rarityOf('ITEM_CH_SWORD_03_A_RARE')).toBe('star')
    expect(rarityOf('ITEM_CH_BLADE_01_B_RARE')).toBe('moon')
    expect(rarityOf('ITEM_CH_TBLADE_02_C_RARE')).toBe('sun')
    expect(rarityOf('ITEM_CH_M_HEAVY_03_BA_B_RARE')).toBe('moon')
    for (const c of ['ITEM_CH_SWORD_03_A', 'ITEM_CH_SWORD_03_C', 'ITEM_CH_SWORD_01_A_DEF', 'ITEM_ETC_HP_POTION_01', 'ITEM_CH_SWORD_03_D_RARE', '', null, undefined]) {
      expect(rarityOf(c), String(c)).toBeNull()
    }
    expect(['ITEM_CH_SWORD_03_A', 'ITEM_CH_SWORD_03_A_RARE', 'ITEM_CH_SWORD_03_B_RARE', 'ITEM_CH_SWORD_03_C_RARE'].map(rarityRank)).toEqual([0, 1, 2, 3])
  })

  it('the order, names and colours are fixed (Star < Moon < Sun)', () => {
    expect(RARITY_TIERS).toEqual(['star', 'moon', 'sun'])
    expect(RARITY_TIERS.map(t => RARITY[t].name)).toEqual(['Seal of Star', 'Seal of Moon', 'Seal of Sun'])
    expect(RARITY_TIERS.map(t => RARITY[t].rank)).toEqual([1, 2, 3])
    const colours = RARITY_TIERS.map(t => RARITY[t].color)
    expect(new Set(colours).size).toBe(3)
    for (const c of colours) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('family, seal code and model code', () => {
    expect(rarityFamily('ITEM_CH_SWORD_03_B')).toBe('ITEM_CH_SWORD_03')
    expect(rarityFamily('ITEM_CH_SWORD_03_C_RARE')).toBe('ITEM_CH_SWORD_03')
    expect(rarityFamily('ITEM_CH_M_HEAVY_03_BA_A')).toBe('ITEM_CH_M_HEAVY_03_BA')
    expect(rarityFamily('ITEM_CH_SWORD_01_A_DEF')).toBeNull()
    expect(rarityFamily('ITEM_ETC_GOLD_01')).toBeNull()
    expect(rareCodeOf('ITEM_CH_SWORD_03_A', 'sun')).toBe('ITEM_CH_SWORD_03_C_RARE')
    expect(rareCodeOf('ITEM_CH_BOW_01_C', 'star')).toBe('ITEM_CH_BOW_01_A_RARE')
    expect(rareCodeOf('ITEM_CH_SPEAR_02_B_RARE', 'moon')).toBe('ITEM_CH_SPEAR_02_B_RARE')
    expect(rareCodeOf('ITEM_ETC_HP_POTION_01', 'sun')).toBeNull()
    // seals share the regular model: the equipment manifest knows the _A row
    expect(modelCodeOf('ITEM_CH_SWORD_03_C_RARE')).toBe('ITEM_CH_SWORD_03_A')
    expect(modelCodeOf('ITEM_CH_SWORD_03_B')).toBe('ITEM_CH_SWORD_03_B')
  })
})

describe('rollRarity', () => {
  it('one roll, the rarest first: r < sun is Sun, then Moon, then Star', () => {
    const rates = { starPct: 10, moonPct: 5, sunPct: 1 }
    expect(rollRarity(() => 0, rates)).toBe('sun')
    expect(rollRarity(() => 0.0099, rates)).toBe('sun')
    expect(rollRarity(() => 0.01, rates)).toBe('moon')
    expect(rollRarity(() => 0.0599, rates)).toBe('moon')
    expect(rollRarity(() => 0.06, rates)).toBe('star')
    expect(rollRarity(() => 0.1599, rates)).toBe('star')
    expect(rollRarity(() => 0.16, rates)).toBeNull()
    expect(rollRarity(() => 0, { starPct: 0, moonPct: 0, sunPct: 0 })).toBeNull()
    expect(rollRarity(() => 0, { starPct: -5, moonPct: 0, sunPct: 0 })).toBeNull()
  })

  it('the defaults (D54): about 1.5 / 0.4 / 0.1 % over 200,000 rolls, 2 % in all', () => {
    let s = 12345
    const rng = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
    const n = 200_000
    const count = { star: 0, moon: 0, sun: 0 }
    for (let i = 0; i < n; i++) {
      const t = rollRarity(rng, RARITY_DEFAULTS)
      if (t) count[t]++
    }
    expect(count.star / n).toBeCloseTo(0.015, 2)
    expect(count.moon / n).toBeGreaterThan(0.003)
    expect(count.moon / n).toBeLessThan(0.005)
    expect(count.sun / n).toBeGreaterThan(0.0005)
    expect(count.sun / n).toBeLessThan(0.0015)
    expect(RARITY_DEFAULTS.starPct + RARITY_DEFAULTS.moonPct + RARITY_DEFAULTS.sunPct).toBeCloseTo(2, 6)
  })
})

describe('rareNotice on the wire', () => {
  it('parses, and refuses an unknown tier', () => {
    const m = { t: 'rareNotice', by: 'Mei', item: 'ITEM_CH_SWORD_03_C_RARE', name: 'Sharp Sword', tier: 'sun' }
    expect(parseServerMessage(JSON.stringify(m))).toEqual({ ok: true, msg: m })
    expect(parseServerMessage(JSON.stringify({ ...m, tier: 'comet' })).ok).toBe(false)
  })
})
