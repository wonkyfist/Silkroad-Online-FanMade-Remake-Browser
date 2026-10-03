/**
 * The World Editor's library (docs/WORLD_EDITOR.md §4.5, D24, D25, D26; docs/WAVE_PLAN8.md §6.2 WE-L, D16, D17):
 * what the Place tool (O) offers, behind place-list.ts's `LibraryProvider`.
 *
 * - **Trees and Plants first: the new species** (TREES Part W) from `content/trees/library.json`, read through T12-E's
 *   seam (`packages/world-render/src/trees/editor.ts`: `setTreeLibrary`, `treeLibraryOf`, the list
 *   `World.trees.library()` returns). Each is placed **as its retail carrier** (an add of the carrier's source), so the
 *   swap draws the species on Medium and up, Low the retail tree, and the carrier's footprint goes into the walking
 *   rebuild. Its thumbnail is the tree tool's (`work/out/trees/<id>/thumb.png`). The retail models the swap draws as a
 *   species are not listed on their own (the species stands for them; the editor never inverts swap.json).
 * - **Then every other converted model** the export places, classified by source path (classify.ts), with a
 *   thumbnail rendered by the editor itself (thumbs.ts, cached in the browser, outside git).
 * A species whose carrier is missing (a batch not converted yet) is listed greyed with the reason, never placeable.
 */
import type { WorldManifest } from '../../../../../packages/convert/src/world/manifest.ts'
import { setTreeLibrary, treeLibraryOf, type TreeLibrarySpecies } from '../../../../../packages/world-render/src/trees/editor.ts'
import { shortName } from '../history.ts'
import { LIBRARY_TABS, type LibraryItem, type LibraryProvider, type LibraryTab } from '../place-list.ts'
import { classifyModels, placementSources, type ModelClass } from './classify.ts'

/** One library row: place-list's item plus what the Trees tab and the thumbnails need. */
export interface EditorLibraryItem extends LibraryItem {
  /** 'species': a new tree or plant placed as its carrier; 'model': a converted model placed as itself. */
  kind: 'species' | 'model'
  /** The manifest models a thumbnail draws (a skinned model's static twin for a still picture). */
  models: readonly number[]
  /** The species entry (kind 'species'). */
  species?: TreeLibrarySpecies
  /** False: listed for information only (a species not in this export yet). */
  placeable: boolean
  /** Why not placeable, or a note (a species' retail look on Low). */
  note?: string
  /** Search text beyond the name and source (the family, the retail names a species replaces). */
  keywords: string
}

export interface EditorLibrary extends LibraryProvider {
  items(): readonly EditorLibraryItem[]
  /** Every model of the export, classified (tab and why it is not listed on its own). */
  readonly classes: readonly ModelClass[]
  /** The species list (T12-E's resolution against this export). */
  readonly species: readonly TreeLibrarySpecies[]
  /** Problems in library.json (shown in the console; the derived entries still list every species). */
  readonly problems: readonly string[]
}

export interface LibraryOptions {
  manifest: Pick<WorldManifest, 'models' | 'placements'>
  /** `content/trees/library.json` (parsed), or null: the species come from the manifest alone. */
  treeLibrary: unknown | null
  /** The URL base of work/out (the tree thumbnails are relative to it). */
  outBase: string
}

/** A skinned model's still twin (the batch draws the static variant; a thumbnail renders it, not a pose). */
function stillModels(manifest: Pick<WorldManifest, 'models'>, models: readonly number[]): number[] {
  const out: number[] = []
  for (const mi of models) {
    const m = manifest.models[mi]
    if (!m) continue
    const v = m.kind === 'skinned' && m.staticVariant !== undefined && m.staticVariant !== null ? m.staticVariant : mi
    const vm = manifest.models[v]
    if (vm && vm.glb && vm.kind !== 'failed') out.push(v)
  }
  return out
}

/** Builds the library (see the file comment). */
export function buildLibrary(o: LibraryOptions): EditorLibrary {
  const { manifest } = o
  const problems = o.treeLibrary === null ? [] : setTreeLibrary(manifest, o.treeLibrary)
  const species = treeLibraryOf(manifest)
  const placeableIds = new Set(species.filter(s => s.placeable).map(s => s.id))
  const classes = classifyModels(manifest, placeableIds)
  const sources = placementSources(manifest.placements)
  const items: EditorLibraryItem[] = []

  // the species, placed as their carriers
  for (const sp of species) {
    const carrier = sp.carrierModel !== null ? manifest.models[sp.carrierModel] : undefined
    const placed = carrier ? sources.get(carrier.source.toLowerCase()) : undefined
    const uses = sp.sources.reduce((a, mi) => a + (sources.get((manifest.models[mi]?.source ?? '').toLowerCase())?.uses ?? 0), 0)
    const placeable = sp.placeable && !!placed
    const retail = sp.sources.map(mi => shortName(manifest.models[mi]?.source ?? '')).filter(Boolean)
    items.push({
      kind: 'species',
      source: placed?.source ?? sp.carrier,
      name: sp.name,
      tab: sp.kind === 'plant' ? 'Plants' : 'Trees',
      ...(sp.thumbnail ? { thumb: `${o.outBase}${sp.thumbnail}` } : {}),
      uses,
      models: sp.speciesModel !== null ? [sp.speciesModel] : [],
      species: sp,
      placeable,
      note: placeable ? `new ${sp.kind}; Low shows the retail ${shortName(sp.carrier)}` : sp.problem ?? 'its carrier is never placed in this export',
      keywords: [sp.id, sp.family, ...retail].join(' ').toLowerCase(),
    })
  }

  // every other converted model the export places (an add copies one of its placements)
  const byIndex = new Map(classes.map(c => [c.index, c]))
  for (const s of sources.values()) {
    const cls = s.models.map(mi => byIndex.get(mi)).filter((c): c is ModelClass => !!c)
    if (!cls.length) continue
    // a placement the swap draws as a listed species: the species stands for it
    if (cls.some(c => c.why === 'swapped')) continue
    if (cls.every(c => c.why === 'failed')) continue
    const tab: LibraryTab = cls[0]!.tab
    const models = stillModels(manifest, s.models)
    if (!models.length) continue
    items.push({
      kind: 'model', source: s.source, name: shortName(s.source), tab, uses: s.uses, models, placeable: true,
      ...(cls.some(c => c.species) ? { note: 'retail (no new species yet)' } : {}),
      keywords: '',
    })
  }
  const order = (t: LibraryTab) => LIBRARY_TABS.indexOf(t)
  items.sort((a, b) =>
    order(a.tab) - order(b.tab) ||
    Number(b.placeable) - Number(a.placeable) ||
    (a.kind === b.kind ? 0 : a.kind === 'species' ? -1 : 1) ||
    b.uses - a.uses ||
    a.name.localeCompare(b.name))
  return { items: () => items, classes, species, problems }
}

/** Items of a tab matching a search text (name, source, or the species' family and retail names). */
export function filterLibrary(items: readonly EditorLibraryItem[], tab: LibraryTab | 'All', text: string): EditorLibraryItem[] {
  const q = text.trim().toLowerCase()
  return items.filter(i => (tab === 'All' || i.tab === tab) &&
    (!q || i.name.toLowerCase().includes(q) || i.source.toLowerCase().includes(q) || i.keywords.includes(q)))
}

/** Fetches `content/trees/library.json` (null when absent or unreadable: the species then come from the manifest). */
export async function fetchTreeLibrary(url: string | URL): Promise<unknown | null> {
  try {
    const r = await fetch(url)
    return r.ok ? await r.json() as unknown : null
  } catch {
    return null
  }
}
