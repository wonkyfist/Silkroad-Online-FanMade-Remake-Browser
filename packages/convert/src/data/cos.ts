/**
 * cos.json: CosDef records (docs/SYSTEMS_COMBAT.md §1.1, §6.3) from characterdata TypeID 1/2/3/1 rows (vehicles),
 * one per COS a summon item in items.json names (ItemDef.use.summon). In scope: COS_C_HORSE1, the Red Horse.
 */
import { characterStats, type CharacterDataRow } from '@sro/formats'
import type { CosDef, ItemDef } from '../../../shared/src/content.ts'
import { textOf } from './client-source.ts'
import { iconUrl, modelRef, modelSource, type OutExists } from './models.ts'

export interface CosContext {
  byCode: ReadonlyMap<string, CharacterDataRow>
  strings: ReadonlyMap<string, string>
  exists: OutExists
  /** Does Media.pk2 have the icon (AssocFileIcon128)? Absent = assume yes. */
  hasIcon?: (assocFileIcon: string) => boolean
}

export interface CosResult {
  cos: Array<CosDef & Record<string, unknown>>
  /** res/... models the records reference. */
  models: string[]
  /** AssocFileIcon128 paths (relative to Media icon/) for the icon export. */
  icons: string[]
  warnings: string[]
}

const r2 = (v: number) => Math.round(v * 100) / 100 + 0

/** One CosDef from its characterdata row. Speeds (cols 46/47) and BCRadius (col 50) are in dm. */
export function buildCosDef(row: CharacterDataRow, ctx: Omit<CosContext, 'byCode'>): CosDef & Record<string, unknown> {
  const s = characterStats(row)
  const icon = row.assocFileIcon && (!ctx.hasIcon || ctx.hasIcon(row.assocFileIcon)) ? iconUrl(row.assocFileIcon) : null
  const def: CosDef & Record<string, unknown> = {
    code: row.codeName,
    id: row.id,
    name: textOf(ctx.strings, row.nameStrId),
    level: row.level,
    hp: row.maxHp,
    walkSpeed: r2(row.walkSpeed * 0.1),
    runSpeed: r2(row.runSpeed * 0.1),
    radius: r2(s.bcRadius * 0.1),
    physAbsorb: s.physAbsorb,
    magAbsorb: s.magAbsorb,
    parryRate: s.parryRate,
    hitRate: s.hitRate,
    model: modelRef(row.assocFileObj, ctx.exists),
    icon,
  }
  const fieldSources: Record<string, string> = {
    walkSpeed: 'client characterdata Speed1 (col 46) x 0.1',
    runSpeed: 'client characterdata Speed2 (col 47) x 0.1',
    radius: 'client characterdata BCRadius (col 50) x 0.1',
  }
  const src = modelSource(row.assocFileObj)
  if (src && !def.model) fieldSources.model = `not converted: ${src}`
  def.fieldSources = fieldSources
  return def
}

/** CosDefs for every summon item (use.summon) in `items`, in item order; unknown or non-vehicle codes warn. */
export function buildCos(items: readonly ItemDef[], ctx: CosContext): CosResult {
  const out: CosResult = { cos: [], models: [], icons: [], warnings: [] }
  const seen = new Set<string>()
  for (const item of items) {
    const code = item.use?.summon
    if (!code || seen.has(code)) continue
    seen.add(code)
    const row = ctx.byCode.get(code)
    if (!row) {
      out.warnings.push(`cos: ${item.code} summons ${code}, which has no characterdata row`)
      continue
    }
    if (row.typeId[0] !== 1 || row.typeId[1] !== 2 || row.typeId[2] !== 3) {
      out.warnings.push(`cos: ${code} TypeID ${row.typeId.join('/')} is not a COS (1/2/3/x)`)
      continue
    }
    out.cos.push(buildCosDef(row, ctx))
    const src = modelSource(row.assocFileObj)
    if (src) out.models.push(src)
    if (row.assocFileIcon) out.icons.push(row.assocFileIcon)
  }
  out.models.sort()
  out.icons.sort()
  return out
}
