/**
 * ItemDef.canTrade (docs/SYSTEMS_SOCIAL.md §8, docs/WAVE_PLAN2.md D23, D50): itemdata CanTrade (col 16) 0 exports
 * `canTrade: false`; anything else leaves the key out (allowed). On the real client that is exactly the 25 creation
 * defaults (*_DEF) in items.json. Synthetic rows first; the real data part skips without sro.config.json.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { itemDataRow, type TextdataRow } from '@sro/formats'
import { checkItemDef } from '../../shared/src/index.ts'
import { loadClientSources } from '../src/data/client-source.ts'
import { buildItemDef, buildItems } from '../src/data/items.ts'
import { textdataReader } from '../src/data/textdata-source.ts'
import { loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'

const row = (cells: string[]): TextdataRow => ({ file: 't.txt', line: 1, cells })

function swordCells(code: string, canTrade: string): string[] {
  const c = Array.from({ length: 160 }, () => '0')
  Object.assign(c, { 0: '1', 1: '100', 2: code, 3: 'xxx', 4: 'xxx', 5: 'SN_' + code, 6: 'xxx', 9: '3', 10: '1', 11: '6', 12: '2', 14: '0' })
  Object.assign(c, { 16: canTrade, 17: '1', 20: '3', 32: '1', 33: '1', 34: '-1', 36: '-1', 38: '-1', 52: 'xxx', 53: 'xxx', 54: 'xxx', 57: '1', 58: '2', 61: '1' })
  for (let i = 118; i < 158; i += 2) Object.assign(c, { [i]: '-1', [i + 1]: 'xxx' })
  return c
}

const ctx = { strings: new Map<string, string>(), exists: () => true, basicAttacks: new Map<number, string>() }

describe('canTrade (synthetic)', () => {
  it('is false only when CanTrade (col 16) is 0', () => {
    const def = buildItemDef(itemDataRow(row(swordCells('ITEM_CH_SWORD_01_A_DEF', '0'))), ctx)
    expect(def.canTrade).toBe(false)
    expect(checkItemDef(def)).toEqual([])
    expect('canTrade' in buildItemDef(itemDataRow(row(swordCells('ITEM_CH_SWORD_01_A', '1'))), ctx)).toBe(false)
    expect('canTrade' in buildItemDef(itemDataRow(row(swordCells('ITEM_CH_SWORD_01_A', ' 1 '))), ctx)).toBe(false)
    expect(buildItemDef(itemDataRow(row(swordCells('ITEM_CH_SWORD_01_A', ' 0'))), ctx).canTrade).toBe(false)
  })
})

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

describe.skipIf(!hasConfig)('canTrade on the real itemdata', () => {
  it('marks exactly the 25 *_DEF items of items.json, and never ITEM_CH_SWORD_01_A', () => {
    const client = loadClientSources(textdataReader(openArchive('Media', loadConfig())))
    const items = buildItems(client.items, ctx)
    const def = items.filter(i => /_DEF$/.test(i.code))
    expect(def).toHaveLength(25)
    expect(items.filter(i => i.canTrade === false).map(i => i.code).sort()).toEqual(def.map(i => i.code).sort())
    expect(items.find(i => i.code === 'ITEM_CH_SWORD_01_A')!.canTrade).toBeUndefined()
    // D49: the horse and its kits are ordinary tradable bag items.
    for (const code of ['ITEM_COS_C_HORSE1', 'ITEM_ETC_COS_HP_POTION_01', 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A']) {
      expect(items.find(i => i.code === code)?.canTrade, code).toBeUndefined()
    }
  })

  it('reaches the exported items.json after the data export', () => {
    const file = join(loadConfig().workDir, 'out', 'data', 'items.json')
    if (!existsSync(file)) return
    const items = (JSON.parse(readFileSync(file, 'utf8')) as { entries: Array<{ code: string; canTrade?: boolean }> }).entries
    if (!items.some(i => 'canTrade' in i)) return // an export from before wave 8
    expect(items.filter(i => i.canTrade === false).every(i => /_DEF$/.test(i.code))).toBe(true)
    expect(items.filter(i => i.canTrade === false)).toHaveLength(25)
  })
})
