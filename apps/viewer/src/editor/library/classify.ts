/**
 * The library's classification (docs/WORLD_EDITOR.md §4.5, D24; docs/WAVE_PLAN8.md §6.2 WE-L): every model of the
 * export gets a tab (Trees, Plants, Rocks, Props, Lanterns and lamps, Buildings, Walls and gates) from its source path,
 * and a reason when the library does not list it on its own:
 * - `species`: a new tree or plant (TREES Part W); the Trees / Plants tabs list it through its carrier (D16, D25);
 * - `swapped`: a retail tree or plant the swap draws as a species; its species' entry stands for it;
 * - `variant`: a skinned model's `#static` twin (the batch's copy; the skinned source is the one placed);
 * - `failed`: the converter could not make it;
 * - `unplaced`: the export never places it, so there is no placement to copy (objId, flags) for an add.
 * Pure: no Babylon, no DOM (tests run it on the real manifest).
 */
import type { WorldManifest, WorldModel, WorldPlacement } from '../../../../../packages/convert/src/world/manifest.ts'
import type { LibraryTab } from '../place-list.ts'

export type HiddenWhy = 'species' | 'swapped' | 'variant' | 'failed' | 'unplaced'

export interface ModelClass {
  readonly index: number
  readonly source: string
  readonly tab: LibraryTab
  /** Why the library does not list the model on its own (null: listed). */
  readonly why: HiddenWhy | null
  /** The species id it is drawn as (swapped models and species). */
  readonly species: string | null
}

const SPECIES_SOURCE = /[\\/]w12[\\/]([^\\/]+)\.bsr#species$/i
const SPECIES_GLB = /models\/trees\/([^/]+)\/far\.glb$/i

/** A species model's id (`pine07`), or null (the trees part's speciesIdOf, kept DOM-free here). */
export function speciesIdOfModel(m: Pick<WorldModel, 'glb' | 'source'>): string | null {
  const g = m.glb ? SPECIES_GLB.exec(m.glb.replace(/\\/g, '/')) : null
  if (g) return g[1]!
  const s = SPECIES_SOURCE.exec(m.source)
  return s ? s[1]! : null
}

/** The file name of a source path without its extension and suffix (`cj_pal_lamp`). */
export function stemOf(source: string): string {
  const s = source.replace(/#\w+$/, '').replace(/\//g, '\\')
  const f = s.slice(s.lastIndexOf('\\') + 1)
  return f.replace(/\.[a-z0-9]+$/i, '').toLowerCase()
}

/** The library tab of a source path (and its model, when known). */
export function tabOfSource(source: string): LibraryTab {
  const s = source.replace(/\//g, '\\').toLowerCase()
  const n = stemOf(source)
  const nature = s.includes('\\nature\\')
  // plants first: grass, flowers, reeds, weeds, bushes, the rice straw and the barley, the town's tufts
  if (/\\(grass|flower|reed)\\/.test(s) || /^(grs_|flw_|group_grs|grass_|tuft_)|weed|reeds?\b|pondflower|ricestraw|barley|trebush|_bush|bush\d|^bush/.test(n)) return 'Plants'
  // trees: the nature tree folders, the retail tree prefix, the unique town trees
  if ((nature && /\\tree\d*(\\|$)|\\new-maple\\/.test(s)) || /^tre_|oldtree|bridgetree|deadtree|^tree/.test(n)) return 'Trees'
  // rocks and cliffs: nature stones, cliffs, the ravine's gorge walls, the graveyard's rocks
  if ((nature && /stone|rock|cliff/.test(s)) || /cliff|gorge|_rock|^rock|stone_field|stonewall/.test(n)) return 'Rocks'
  // lanterns and lamps (models that carry a night emitter, §4.9) and the buildings' lit parts
  if (/lamp|lantern|_light|light\d|torch|brazier|burner|_fire\b|enter_fire/.test(n)) return 'Lanterns'
  // walls, gates, doors, fences, towers (dam = a wall in the retail names)
  if (/wall|gate|door|fence|_dam\b|_dam_|dam\d|leftdam|rightdam|centerdam|rounddam|longdam|castle|tower|eastwa|^cj_[nsew]$|_ent(door|\d)|enter\d|^c_jin_enter/.test(n)) return 'Walls and gates'
  // props: small things people carry, sit at, sell from (stalls, carts, barrels, crates, benches...)
  if (/\\(artifact|npc)\\|^town\\props\\|\\particle\\|\\etc\\|\\deco\\/.test(s) || s.startsWith('town\\') ||
    /wagon|cart|bottle|boat|coffin|tomb|basket|sack|handcart|fushop|weap0|cata|bari|ration|sign|^table|_table|table\d|chair|streetstall|stall\d|barrel|crate|bench|planter|pot\b|banner|statue|status_|skull|bone|well|_tent|^tent|tent\d|horse|lion|turtle|tortoise|budaa|buda_|stn|grave|portal_stone|fish|goldfish|chicken|hawk|xbone|potato|farmingtool/.test(n)) {
    // the artifact folder also holds a few big pieces
    if (/tower|gate|wall/.test(n)) return 'Walls and gates'
    if (/bridge|brg|brid/.test(n)) return 'Buildings'
    if (/tent/.test(n) && s.includes('\\ruins\\')) return 'Buildings'
    return 'Props'
  }
  return 'Buildings'
}

/** The species a model is drawn as (its own id for a species model; its swap target's for a swapped retail model). */
function drawnAs(manifest: Pick<WorldManifest, 'models'>, m: WorldModel): string | null {
  const own = m.kind === 'static' ? speciesIdOfModel(m) : null
  if (own) return own
  let ts = m.treeSwap
  if (!ts && m.kind === 'skinned' && m.staticVariant !== undefined && m.staticVariant !== null) ts = manifest.models[m.staticVariant]?.treeSwap
  const sp = ts ? manifest.models[ts.model] : undefined
  return sp ? speciesIdOfModel(sp) : null
}

/**
 * Every model of the export with its tab and (when not listed on its own) why. `placed`: the model indices some
 * placement of the export uses (an add copies such a placement).
 */
export function classifyModels(
  manifest: Pick<WorldManifest, 'models' | 'placements'>,
  placeableSpecies: ReadonlySet<string> = new Set(),
): ModelClass[] {
  const placed = new Set<number>()
  for (const p of manifest.placements) for (const mi of p.models) placed.add(mi)
  const variants = new Set<number>()
  for (const m of manifest.models) if (m.kind === 'skinned' && m.staticVariant !== undefined && m.staticVariant !== null) variants.add(m.staticVariant)
  return manifest.models.map(m => {
    const species = drawnAs(manifest, m)
    const own = m.kind === 'static' && speciesIdOfModel(m) !== null
    let why: HiddenWhy | null = null
    if (own) why = 'species'
    else if (variants.has(m.index) || /#static$/i.test(m.source)) why = 'variant'
    else if (m.kind === 'failed' || !m.glb) why = 'failed'
    else if (species && placeableSpecies.has(species)) why = 'swapped'
    else if (!placed.has(m.index)) why = 'unplaced'
    return { index: m.index, source: m.source, tab: tabOfSource(m.source), why, species }
  })
}

/** The placements of the export grouped by their source (what an add names), most used first. */
export function placementSources(placements: readonly WorldPlacement[]): Map<string, { source: string; models: readonly number[]; uses: number }> {
  const out = new Map<string, { source: string; models: readonly number[]; uses: number }>()
  for (const p of placements) {
    const k = p.source.toLowerCase()
    const e = out.get(k)
    if (e) e.uses++
    else out.set(k, { source: p.source, models: p.models, uses: 1 })
  }
  return out
}
