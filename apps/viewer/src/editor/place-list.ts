/**
 * What the Place tool (O) offers (docs/WORLD_EDITOR.md §4.5). Step 1 lists every model the export already places
 * (each has a placement to copy: models, object id, flags), grouped by its source path, with a search box. Lane WE-L
 * (`src/editor/library/**`) supplies the full library behind the same interface: the thumbnails, the retail census
 * models and the Trees tab of the new species placed as their carriers (WAVE_PLAN8 D16, D25).
 */
import { isFoliageModel } from '@sro/world-render'
import { shortName } from './history.ts'

export const LIBRARY_TABS = ['Trees', 'Plants', 'Rocks', 'Props', 'Lanterns', 'Buildings', 'Walls and gates'] as const
export type LibraryTab = (typeof LIBRARY_TABS)[number]

export interface LibraryItem {
  /** The model source a placement names (object.ifo path). */
  source: string
  name: string
  tab: LibraryTab
  /** A thumbnail URL (WE-L), or none. */
  thumb?: string
  /** How many times the export places it (a hint of what is common). */
  uses: number
}

export interface LibraryProvider {
  items(): readonly LibraryItem[]
}

/** A source path's library tab (the census' classes; WE-L refines them). */
export function tabOf(source: string): LibraryTab {
  const s = source.toLowerCase().replace(/\//g, '\\')
  if (/\\tree\d*\\/.test(s) || /tre_|_tree/.test(s)) return 'Trees'
  if (isFoliageModel(source) || /\\(grass|flower|reed|bush|plant)/.test(s)) return 'Plants'
  if (/stone|rock/.test(s) && /nature/.test(s)) return 'Rocks'
  if (/lamp|lantern|light|torch|brazier|burner|lion_dan/.test(s)) return 'Lanterns'
  if (/wall|gate|fence|castle|tower/.test(s)) return 'Walls and gates'
  if (/\\bldg\\|house|temple|palace|pavilion|building/.test(s)) return 'Buildings'
  return 'Props'
}

/** Every placed model of the export, most used first within its tab. */
export function placedModels(placements: ReadonlyArray<{ source: string; inConvertedRegion: boolean }>): LibraryProvider {
  const uses = new Map<string, { source: string; n: number }>()
  for (const p of placements) {
    if (!p.inConvertedRegion) continue
    const k = p.source.toLowerCase()
    const e = uses.get(k)
    if (e) e.n++
    else uses.set(k, { source: p.source, n: 1 })
  }
  const items: LibraryItem[] = [...uses.values()].map(e => ({ source: e.source, name: shortName(e.source), tab: tabOf(e.source), uses: e.n }))
  items.sort((a, b) => LIBRARY_TABS.indexOf(a.tab) - LIBRARY_TABS.indexOf(b.tab) || b.uses - a.uses || a.name.localeCompare(b.name))
  return { items: () => items }
}

/** Items of a tab matching a search text (name or path, case-insensitive). */
export function filterItems(items: readonly LibraryItem[], tab: LibraryTab | 'All', text: string): LibraryItem[] {
  const q = text.trim().toLowerCase()
  return items.filter(i => (tab === 'All' || i.tab === tab) && (!q || i.name.toLowerCase().includes(q) || i.source.toLowerCase().includes(q)))
}
