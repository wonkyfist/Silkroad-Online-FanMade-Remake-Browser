/**
 * Gameplay content tables (docs/PROTOCOL.md section 12): mobs, items, drops, NPCs, shops and levels by
 * CodeName128. The data export under /out/data/ wins; the authored stand-ins of builtin.ts fill in
 * whatever it does not have yet, so ?mock=1 always has monsters and items. Environment-neutral apart from
 * fetchContentTables (which takes the fetch function).
 */
import { CONTENT_FILES, contentEntries, type ContentKind, type DropTable, type ItemDef, type LevelDef, type MasteryDef, type MobDef, type NpcDef, type ShopDef, type SkillDef } from '@sro/shared'
import { BUILTIN_DROPS, BUILTIN_ITEMS, BUILTIN_MOBS, BUILTIN_NPCS, BUILTIN_SHOPS, builtinLevels } from './builtin.ts'

export interface ContentTables {
  mobs: Map<string, MobDef>
  items: Map<string, ItemDef>
  drops: Map<string, DropTable>
  npcs: Map<string, NpcDef>
  shops: Map<string, ShopDef>
  /** skills.json / masteries.json rows by code (export only; empty without it). */
  skills: Map<string, SkillDef>
  masteries: Map<string, MasteryDef>
  /** Index = level - 1. */
  levels: LevelDef[]
  /** Which files came from the export (the rest is builtin). */
  exported: ContentKind[]
}

function byKey<T>(rows: T[], key: (r: T) => string): Map<string, T> {
  const m = new Map<string, T>()
  for (const r of rows) m.set(key(r), r)
  return m
}

export function builtinTables(): ContentTables {
  return {
    mobs: byKey(BUILTIN_MOBS, m => m.code),
    items: byKey(BUILTIN_ITEMS, i => i.code),
    drops: byKey(BUILTIN_DROPS, d => d.mob),
    npcs: byKey(BUILTIN_NPCS, n => n.code),
    shops: byKey(BUILTIN_SHOPS, s => s.id),
    skills: new Map(),
    masteries: new Map(),
    levels: builtinLevels(),
    exported: [],
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Merges exported files (raw JSON per kind) over `base`. Malformed files are skipped with a warning. */
export function mergeTables(base: ContentTables, files: Partial<Record<ContentKind, unknown>>): ContentTables {
  const out: ContentTables = {
    mobs: new Map(base.mobs),
    items: new Map(base.items),
    drops: new Map(base.drops),
    npcs: new Map(base.npcs),
    shops: new Map(base.shops),
    skills: new Map(base.skills),
    masteries: new Map(base.masteries),
    levels: base.levels,
    exported: [...base.exported],
  }
  const read = <T>(kind: ContentKind, ok: (r: T) => boolean, put: (r: T) => void) => {
    const json = files[kind]
    if (json === undefined) return
    try {
      const rows = contentEntries<T>(json, kind === 'levels' ? undefined : kind)
      let n = 0
      for (const r of rows) {
        if (isRecord(r) && ok(r)) {
          put(r)
          n++
        }
      }
      if (n) out.exported.push(kind)
    } catch (err) {
      console.warn(`[content] ${CONTENT_FILES[kind]} ignored:`, err)
    }
  }
  read<MobDef>('mobs', r => typeof r.code === 'string' && typeof r.hp === 'number', r => out.mobs.set(r.code, r))
  read<ItemDef>('items', r => typeof r.code === 'string' && typeof r.category === 'string', r => out.items.set(r.code, r))
  read<DropTable>('drops', r => typeof r.mob === 'string' && Array.isArray(r.groups), r => out.drops.set(r.mob, r))
  read<NpcDef>('npcs', r => typeof r.code === 'string', r => out.npcs.set(r.code, r))
  read<ShopDef>('shops', r => typeof r.id === 'string' && Array.isArray(r.tabs), r => out.shops.set(r.id, r))
  read<SkillDef>('skills', r => typeof r.code === 'string' && typeof r.skillLevel === 'number', r => out.skills.set(r.code, r))
  read<MasteryDef>('masteries', r => typeof r.code === 'string', r => out.masteries.set(r.code, r))
  const levels: LevelDef[] = []
  read<LevelDef>('levels', r => typeof r.level === 'number' && typeof r.exp === 'number', r => void (levels[r.level - 1] = r))
  if (levels.length && levels.every(Boolean)) out.levels = levels
  return out
}

/** EXP needed from `level` to `level + 1` (0 at `cap` or past the table). */
export function expToNext(tables: ContentTables, level: number, cap: number): number {
  if (level >= cap) return 0
  return tables.levels[level - 1]?.exp ?? 0
}

/** Loads every content file that exists under `base` (e.g. '/out/data/') over the builtin tables. */
export async function fetchContentTables(base: string, fetchFn: typeof fetch = fetch): Promise<ContentTables> {
  const kinds: ContentKind[] = ['mobs', 'items', 'drops', 'npcs', 'shops', 'skills', 'masteries', 'levels']
  const files: Partial<Record<ContentKind, unknown>> = {}
  await Promise.all(
    kinds.map(async kind => {
      try {
        const res = await fetchFn(base + CONTENT_FILES[kind], { cache: 'no-cache' })
        if (!res.ok) return
        const type = res.headers.get('content-type') ?? ''
        if (type && !type.includes('json')) return
        files[kind] = await res.json()
      } catch {
        // Not exported yet.
      }
    }),
  )
  return mergeTables(builtinTables(), files)
}
