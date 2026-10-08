/**
 * A degree-4 item's tooltip (docs/CLIMB.md §4.1.2, D53) on the real export (skips without work/out/data): the 4th
 * degree, the re-spaced required level (red below it), and a Seal of Sun's banner and title colour.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyClimbItemLevels, contentEntries, type ItemDef } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { ItemCatalog } from '../src/hud/items.ts'

const FILE = join(import.meta.dirname, '../../../work/out/data/items.json')

describe.skipIf(!existsSync(FILE))('degree-4 tooltips', () => {
  const items = new Map(contentEntries<ItemDef>(JSON.parse(readFileSync(FILE, 'utf8')), 'items').map((i) => [i.code, i]))
  applyClimbItemLevels(items)
  const catalog = new ItemCatalog([...items.values()])
  it('Gold General Blade: 4th degree, level 23 (retail 29)', () => {
    const tip = catalog.tooltip({ code: 'ITEM_CH_BLADE_04_C', count: 1 }, { player: { level: 22 } }).map((l) => l.text)
    expect(tip[0]).toBe('Gold General Blade')
    expect(tip.some((t) => /4th degree/.test(t))).toBe(true)
    expect(tip).toContain('Required level: 23')
    const ok = catalog.tooltip({ code: 'ITEM_CH_BLADE_04_C', count: 1 }, { player: { level: 25 } })
    expect(ok.find((l) => l.text === 'Required level: 23')?.cls).not.toBe('bad')
  })
  it('a Seal of Sun of degree 4 wears its tier colour and needs the grade-C level', () => {
    const tip = catalog.tooltip({ code: 'ITEM_CH_BLADE_04_C_RARE', count: 1 }, { player: { level: 25 } })
    expect(tip[0]!.cls).toBe('title-sun')
    expect(tip.map((l) => l.text)).toContain('Required level: 23')
  })
})
