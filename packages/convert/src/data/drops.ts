/**
 * drops.json: one DropTable per exported mob, from the port's drops.json (the vSRO _RefDropGold / assigned-drop /
 * _RefDropClassSel chain, which the client lacks). Rates the port multiplied in are divided back out.
 *  - gold chance: port `gold.chance` (DropProb). Gold amount: the client's levelgold.txt row for the mob level
 *    (the client copy of _RefDropGold); the port's amounts are those x goldRate (checked, see `goldCheck`).
 *  - items: every port entry is an independent roll with p = chance / rate; each becomes one DropGroup. Gendered
 *    armour maps to both the male and the female code (one pick, equal weight). Entries whose item is not in
 *    items.json (European, seal/_RARE, magic stones, degree > 3) are left out and counted. Seal items (_RARE) are
 *    also left out when items.json has them (wave 11: the degree-3 seals are the unique's drop, docs/UNIQUES.md §3.4)
 *    unless `opts.rare` is set; counted as `rare`.
 */
import type { LevelGoldRow } from '@sro/formats'
import { PROVENANCE_PORT, type DropGroup, type DropTable } from '../../../shared/src/content.ts'
import type { PortDrops, PortItemMap } from './port-source.ts'

export interface DropsResult {
  drops: Array<DropTable & Record<string, unknown>>
  /** Port entries left out, by reason. */
  skipped: { unmapped: number; notExported: number; rare?: number }
  /** Port gold / goldRate vs client levelgold, per mob: equal or not. */
  goldCheck: { equal: number; differ: string[] }
  /** Mobs without a port drop table. */
  missing: string[]
}

export function buildDrops(
  mobs: ReadonlyArray<{ code: string; level: number }>,
  port: PortDrops,
  itemMap: PortItemMap,
  itemCodes: ReadonlySet<string>,
  levelGold: readonly LevelGoldRow[],
  opts: { rare?: boolean } = {},
): DropsResult {
  const goldRate = port.rates.goldRate || 1
  const itemRate = port.rates.itemDropRate || 1
  const rareRate = port.rates.rareDropRate || 1
  const goldByLevel = new Map(levelGold.map(g => [g.level, g]))
  const tableByCode = new Map(port.tables.map(t => [t.vsroCode, t]))
  const drops: DropsResult['drops'] = []
  const skipped: DropsResult['skipped'] = { unmapped: 0, notExported: 0 }
  const goldCheck: DropsResult['goldCheck'] = { equal: 0, differ: [] }
  const missing: string[] = []
  for (const mob of mobs) {
    const t = tableByCode.get(mob.code)
    if (!t) {
      missing.push(mob.code)
      continue
    }
    const table: DropTable & Record<string, unknown> = { mob: mob.code, groups: [], provenance: PROVENANCE_PORT }
    const fieldSources: Record<string, string> = {}
    const g = goldByLevel.get(mob.level)
    if (t.gold && g) {
      table.gold = { chance: Math.round(t.gold.chance * 1e6) / 1e6, amount: [g.min, g.max] }
      fieldSources['gold.amount'] = `client: levelgold.txt level ${mob.level}`
      fieldSources['gold.chance'] = `${PROVENANCE_PORT}: drops.json gold.chance`
      if (Math.round(t.gold.min / goldRate) === g.min && Math.round(t.gold.max / goldRate) === g.max) goldCheck.equal++
      else goldCheck.differ.push(`${mob.code}: port ${t.gold.min}-${t.gold.max} / ${goldRate} vs client ${g.min}-${g.max}`)
    }
    const groups: DropGroup[] = []
    for (const e of t.items) {
      const m = itemMap[e.itemId]
      if (!m) {
        skipped.unmapped++
        continue
      }
      const codes = [m.code, m.codeW].filter((c): c is string => !!c && itemCodes.has(c))
      if (!codes.length) {
        skipped.notExported++
        continue
      }
      const rare = /_RARE$/.test(m.code)
      if (rare && !opts.rare) {
        skipped.rare = (skipped.rare ?? 0) + 1
        continue
      }
      const chance = e.chance / (rare ? rareRate : itemRate)
      const entry = (item: string) => (e.qty > 1 ? { item, weight: 1, count: [e.qty, e.qty] as [number, number] } : { item, weight: 1 })
      groups.push({ chance: Math.round(chance * 1e9) / 1e9, entries: codes.map(entry) })
    }
    table.groups = groups
    table.fieldSources = fieldSources
    drops.push(table)
  }
  return { drops, skipped, goldCheck, missing }
}
