/**
 * The tree-swap manifest step (wave 12, docs/TREES.md WF11, WF12, §W3.2; W12-CV's slot, owned by T12-A from step 1).
 *
 * The spine (./convert-world.ts) asks `createTreeSwapPass` for step 7 of the placement passes (./passes.ts
 * `TreeSwapPass`, which applies the result and checks every row). This step:
 *
 * - reads `content/trees/swap.json` (retail source → species, fit, offset, tint; written by `pnpm trees build`) and
 *   the species files beside it (`content/trees/species/<id>.json`, for the tint names);
 * - for every species that a converted retail model swaps to **and** that the tree tool has built
 *   (`work/out/trees/<id>/far.glb` + `far.json`), copies its files into the export as
 *   `models/trees/<id>/{far.glb, far.json, near.glb, near.json, tints/*.png}` (so `optimize-out` gives them the
 *   same pass as every model, and the runtime finds them relative to the manifest);
 * - returns each species as a static manifest model (`source` = `res\nature\common\tree\w12\<id>.bsr#species`: a
 *   foliage path for `isFoliageModel`, never a retail file name the scatter's by-name lookup could pick up) and one
 *   swap per retail model: `fit` = [horizontal, vertical, horizontal], `tint` = the tint index (0 = the species' own
 *   sprites, k ≥ 1 = `far.json` `trees.tints[k − 1]`).
 *
 * The swap's trunk `offset` (validate.ts SwapEntry.offset, WF20: retail trunks stand up to 2 m off their model origin)
 * becomes `treeSwap.offset` = [x, 0, z] (model space, m; the runtime applies it after the fit).
 *
 * A species that is not built is a warning and its rows are skipped; with no swap table, no rows or nothing built the
 * step returns null and the export is byte-identical. Pure apart from reading the table and copying files.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Vec3 } from '../gltf/space.ts'
import { validateGlb } from '../gltf/validate.ts'
import type { WorldModel } from './manifest.ts'
import type { TreeSwapEntry, TreeSwapPass, TreeSwapStep, WorldPassContext } from './passes.ts'

/** The swap table (docs/WAVE_PLAN8.md §3.3; relative to the repo root). */
export const TREES_SWAP_FILE = 'content/trees/swap.json'

export interface TreeSwapOptions {
  /** The swap table (absolute). */
  swapFile: string
  /** The export's name and folder (absolute). */
  world: string
  outDir: string
  warnings: string[]
  log: (line: string) => void
  /** The tree tool's output folder (default: `<outDir>/../../trees`, i.e. work/out/trees). */
  treesDir?: string
  /** The species files (default: `species/` beside the swap table). */
  speciesDir?: string
}

/** The swap table's rows (the tree tool's validate.ts SwapEntry, repeated here: the converter's world side does not
 *  import the tool). */
interface SwapRow {
  species: string
  fit: [number, number]
  offset?: [number, number]
  tint?: string
}

interface SpeciesTints {
  id: string
  tints: Array<{ name: string }>
}


/** The folder of a species inside the export, relative to the manifest. */
export function speciesFolder(id: string): string {
  return `models/trees/${id}`
}

/** The manifest `source` of a species model. */
export function speciesSource(id: string): string {
  return `res\\nature\\common\\tree\\w12\\${id}.bsr#species`
}

const sourceKey = (s: string) => s.replace(/#static$/i, '').replace(/\//g, '\\').toLowerCase()

/** The tint index of a row (0 = default; -1 = unknown). */
export function swapTintIndex(species: SpeciesTints | undefined, tint: string | undefined): number {
  if (!tint || tint === 'default') return 0
  const i = species?.tints.findIndex(t => t.name === tint) ?? -1
  return i < 0 ? -1 : i + 1
}

/**
 * The pure part: which rows apply to which converted models, given the species that are available (built). Returns
 * the species ids in the order they will be appended and the swap entries (`species` indexes that list).
 */
export function planTreeSwap(
  models: readonly Pick<WorldModel, 'index' | 'source' | 'kind'>[],
  swaps: Readonly<Record<string, SwapRow>>,
  species: ReadonlyMap<string, SpeciesTints>,
  built: ReadonlySet<string>,
  warn: (s: string) => void,
): { species: string[]; swaps: TreeSwapEntry[] } {
  const bySource = new Map<string, number>()
  for (const m of models) if (!m.source.includes('#') && m.kind !== 'failed') bySource.set(sourceKey(m.source), m.index)
  const order: string[] = []
  const out: TreeSwapEntry[] = []
  const missing = new Set<string>()
  for (const [source, row] of Object.entries(swaps).sort(([a], [b]) => a.localeCompare(b))) {
    const model = bySource.get(sourceKey(source))
    if (model === undefined) continue // the retail model is not in this export (another world, or dropped by C9)
    if (!built.has(row.species)) {
      if (!missing.has(row.species)) warn(`tree swap: species ${row.species} is not built (pnpm trees build --species ${row.species}); its rows stay retail`)
      missing.add(row.species)
      continue
    }
    const tint = swapTintIndex(species.get(row.species), row.tint)
    if (tint < 0) {
      warn(`tree swap: ${source}: species ${row.species} has no tint ${row.tint}; default tint used`)
    }
    let k = order.indexOf(row.species)
    if (k < 0) k = order.push(row.species) - 1
    out.push({
      model,
      species: k,
      fit: [row.fit[0], row.fit[1], row.fit[0]],
      tint: Math.max(0, tint),
      ...(row.offset ? { offset: [row.offset[0], 0, row.offset[1]] as Vec3 } : {}),
    })
  }
  return { species: order, swaps: out.sort((a, b) => a.model - b.model) }
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Copies a species' built files into the export; returns its manifest model. */
async function exportSpecies(id: string, from: string, outDir: string): Promise<Omit<WorldModel, 'index' | 'staticVariant' | 'treeSwap'>> {
  const rel = speciesFolder(id)
  const to = join(outDir, ...rel.split('/'))
  mkdirSync(to, { recursive: true })
  for (const f of ['far.glb', 'far.json', 'near.glb', 'near.json']) if (existsSync(join(from, f))) copyFileSync(join(from, f), join(to, f))
  if (existsSync(join(from, 'tints'))) {
    mkdirSync(join(to, 'tints'), { recursive: true })
    for (const f of readdirSync(join(from, 'tints'))) if (f.endsWith('.png')) copyFileSync(join(from, 'tints', f), join(to, 'tints', f))
  }
  const sidecar = JSON.parse(readFileSync(join(to, 'far.json'), 'utf8')) as { stats: { boundsMin: Vec3; boundsMax: Vec3 } }
  const glb = new Uint8Array(readFileSync(join(to, 'far.glb')))
  const v = await validateGlb(glb, `${rel}/far.glb`)
  return {
    source: speciesSource(id),
    glb: `${rel}/far.glb`,
    sidecar: `${rel}/far.json`,
    kind: 'static',
    animations: [],
    defaultClip: null,
    lightmappedMeshes: 0,
    boundsMin: sidecar.stats.boundsMin,
    boundsMax: sidecar.stats.boundsMax,
    bytes: statSync(join(to, 'far.glb')).size,
    validatorErrors: v.errors,
  }
}

/** Step 7's pass, or null (no swap table, no rows, or no species built). */
export function createTreeSwapPass(opts: TreeSwapOptions): TreeSwapPass | null {
  const table = readJson<{ swaps?: Record<string, SwapRow> }>(opts.swapFile)
  const swaps = table?.swaps ?? {}
  if (!Object.keys(swaps).length) return null
  const treesDir = opts.treesDir ?? join(dirname(dirname(opts.outDir)), 'trees')
  const speciesDir = opts.speciesDir ?? join(dirname(opts.swapFile), 'species')
  const species = new Map<string, SpeciesTints>()
  const built = new Set<string>()
  for (const id of new Set(Object.values(swaps).map(r => r.species))) {
    const sp = readJson<SpeciesTints>(join(speciesDir, `${id}.json`))
    if (sp) species.set(id, sp)
    if (existsSync(join(treesDir, id, 'far.glb')) && existsSync(join(treesDir, id, 'far.json'))) built.add(id)
  }
  if (!built.size) {
    opts.log(`tree swap: no species built in ${treesDir}; the export stays retail`)
    return null
  }
  return async (ctx: WorldPassContext): Promise<TreeSwapStep> => {
    const plan = planTreeSwap(ctx.models, swaps, species, built, s => ctx.warnings.push(s))
    const models: TreeSwapStep['species'] = []
    for (const id of plan.species) models.push(await exportSpecies(id, join(treesDir, id), ctx.outDir))
    if (plan.species.length) ctx.log(`tree swap: ${plan.species.join(', ')} from ${treesDir}`)
    return { species: models, swaps: plan.swaps }
  }
}
