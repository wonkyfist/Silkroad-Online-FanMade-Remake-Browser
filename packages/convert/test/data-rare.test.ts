/**
 * W11-CV (docs/WAVE_PLAN7.md §4.5 optional, docs/UNIQUES.md §3.4): the degree-3 Seal of Star rows (`_RARE`) join
 * items.json for the unique's drop, and stay out of every normal mob's drop table.
 * - degree-3 and degree-4 seals of every kind are exported (degree 4: the Climb's cap tier, docs/CLIMB.md §4.1.2); weapon
 *   seals of every exported degree too (docs/RARITY.md §2), other degree-1/2 seals and degree 5+ rows are not;
 * - buildDrops skips `_RARE` codes (counted as `rare`) unless asked for them, then divides by the rare rate;
 * - the real client (skips without sro.config.json and the port data): items.json has degree-3 seals for every weapon
 *   kind, and no drop table names one.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { itemDataRow, type TextdataRow } from '@sro/formats'
import { CONTENT_FILES, contentEntries, type DropTable, type ItemDef } from '../../shared/src/index.ts'
import { loadClientSources } from '../src/data/client-source.ts'
import { buildContent } from '../src/data/content.ts'
import { buildDrops } from '../src/data/drops.ts'
import { isExportedItem, MAX_ITEM_DEGREE, RARE_ITEM_DEGREES } from '../src/data/items.ts'
import { defaultPortDataDir, loadPortData } from '../src/data/port-source.ts'
import { textdataReader } from '../src/data/textdata-source.ts'
import { loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'

const row = (cells: string[]): TextdataRow => ({ file: 't.txt', line: 1, cells })

function itemCells(code: string, typeId: [number, number, number, number], extra: Record<number, string> = {}): string[] {
  const c = Array.from({ length: 160 }, () => '0')
  Object.assign(c, { 0: '1', 1: '100', 2: code, 3: 'xxx', 4: 'xxx', 5: 'SN_' + code, 6: 'xxx', 9: String(typeId[0]), 10: String(typeId[1]), 11: String(typeId[2]), 12: String(typeId[3]) })
  Object.assign(c, { 17: '1', 20: '3', 32: '1', 33: '1', 34: '-1', 36: '-1', 38: '-1', 52: 'xxx', 53: 'xxx', 54: 'xxx', 57: '1', 58: '2', 61: '1' })
  for (let i = 118; i < 158; i += 2) Object.assign(c, { [i]: '-1', [i + 1]: 'xxx' })
  return Object.assign(c, extra)
}

describe('Seal of Star rows', () => {
  it('exports the degree-3 and degree-4 seals and the weapon seals of every degree', () => {
    expect(RARE_ITEM_DEGREES).toEqual([3, 4])
    expect(MAX_ITEM_DEGREE).toBe(4)
    // col 61 is ItemClass: 3 classes per degree
    const item = (code: string, degree: number) => itemDataRow(row(itemCells(code, [3, 1, 6, 2], { 61: String(degree * 3) })))
    expect(isExportedItem(item('ITEM_CH_SWORD_03_A_RARE', 3))).toBe(true)
    expect(isExportedItem(item('ITEM_CH_SWORD_01_A_RARE', 1))).toBe(true)
    expect(isExportedItem(item('ITEM_CH_SWORD_02_C_RARE', 2))).toBe(true)
    const ring = (degree: number) => itemDataRow(row(itemCells('ITEM_CH_RING_01_A_RARE', [3, 1, 7, 3], { 61: String(degree * 3) })))
    expect(isExportedItem(ring(1))).toBe(false)
    expect(isExportedItem(item('ITEM_CH_SWORD_04_A_RARE', 4))).toBe(true)
    expect(isExportedItem(item('ITEM_CH_SWORD_05_A_RARE', 5))).toBe(false)
    const armour = itemDataRow(row(itemCells('ITEM_CH_M_HEAVY_03_BA_B_RARE', [3, 1, 3, 3], { 61: '8' })))
    expect(isExportedItem(armour)).toBe(true)
    const armour4 = itemDataRow(row(itemCells('ITEM_CH_M_HEAVY_04_BA_C_RARE', [3, 1, 3, 3], { 61: '12' })))
    expect(isExportedItem(armour4)).toBe(true)
    expect(isExportedItem(armour4, 3)).toBe(false)
    // the ordinary rows are unchanged
    expect(isExportedItem(item('ITEM_CH_SWORD_03_A', 3))).toBe(true)
  })

  it('normal drop tables skip seals unless asked for them', () => {
    const port = {
      rates: { goldRate: 1, itemDropRate: 2, rareDropRate: 4 },
      tables: [{
        mobId: 'm', vsroCode: 'MOB_CH_TIGER', level: 20, gold: null,
        items: [{ itemId: 'sword', qty: 1, chance: 0.02 }, { itemId: 'sword_rare', qty: 1, chance: 0.004 }],
      }],
    }
    const itemMap = { sword: { code: 'ITEM_CH_SWORD_03_A' }, sword_rare: { code: 'ITEM_CH_SWORD_03_A_RARE' } }
    const items = new Set(['ITEM_CH_SWORD_03_A', 'ITEM_CH_SWORD_03_A_RARE'])
    const r = buildDrops([{ code: 'MOB_CH_TIGER', level: 20 }], port as never, itemMap, items, [])
    expect(r.drops[0]!.groups).toEqual([{ chance: 0.01, entries: [{ item: 'ITEM_CH_SWORD_03_A', weight: 1 }] }])
    expect(r.skipped).toEqual({ unmapped: 0, notExported: 0, rare: 1 })
    const all = buildDrops([{ code: 'MOB_CH_TIGER', level: 20 }], port as never, itemMap, items, [], { rare: true })
    expect(all.drops[0]!.groups[1]).toEqual({ chance: 0.001, entries: [{ item: 'ITEM_CH_SWORD_03_A_RARE', weight: 1 }] })
    expect(all.skipped).toEqual({ unmapped: 0, notExported: 0 })
  })
})

const codes0 = (items: readonly ItemDef[]): Set<string> => new Set(items.map(i => i.code))

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const portDir = hasConfig ? (process.env.SRO_PORT_DATA ?? defaultPortDataDir(loadConfig().clientDir)) : ''
const hasPort = hasConfig && existsSync(join(portDir, 'spawns.json'))

describe.skipIf(!hasPort)('the real export (vSRO 1.188 + port data)', () => {
  it('has degree-3 seals of every weapon kind, and no drop table names a seal', () => {
    const cfg = loadConfig()
    const out = buildContent({
      client: loadClientSources(textdataReader(openArchive('Media', cfg))),
      port: loadPortData(portDir),
      world: { name: 'jangan', originRegion: { x: 168, z: 97 }, regions: new Set([24743, 24744, 24745, 24999, 25000, 25001, 25255, 25256, 25257]) },
      exists: () => true,
      hasData: () => false,
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    const items = contentEntries<ItemDef>(out.files[CONTENT_FILES.items])
    const seals = items.filter(i => /_RARE$/.test(i.code))
    expect(seals.length).toBeGreaterThan(100)
    for (const kind of ['SWORD', 'BLADE', 'SPEAR', 'TBLADE', 'BOW', 'SHIELD']) {
      for (const d of ['03', '04']) expect(seals.some(i => i.code.startsWith(`ITEM_CH_${kind}_${d}_`)), `${kind} ${d}`).toBe(true)
    }
    // docs/RARITY.md §2: the weapon seals of degrees 1-4 (Star, Moon, Sun of each family); other seals degrees 3-4 only
    expect(seals.every(i => /_0[34]_/.test(i.code) || i.category === 'weapon')).toBe(true)
    for (const kind of ['SWORD', 'BLADE', 'SPEAR', 'TBLADE', 'BOW']) {
      for (const d of ['01', '02', '03', '04']) for (const seal of 'ABC') expect(codes0(items).has(`ITEM_CH_${kind}_${d}_${seal}_RARE`), `${kind} ${d} ${seal}`).toBe(true)
    }
    // each seal has its ordinary row
    const codes = new Set(items.map(i => i.code))
    for (const s of seals) expect(codes.has(s.code.replace(/_RARE$/, '')), s.code).toBe(true)
    const drops = contentEntries<DropTable>(out.files[CONTENT_FILES.drops])
    expect(drops.flatMap(d => d.groups.flatMap(g => (g.entries ?? []).map(e => e.item))).filter(c => /_RARE$/.test(c))).toEqual([])
    expect(out.report.drops.skipped.rare).toBeGreaterThan(0)
  })
})
