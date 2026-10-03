/**
 * The world export's placement passes (docs/WAVE_PLAN6.md D6, D19; docs/WAVE_PLAN7.md D13): what runs between the
 * object conversion and the manifest, in this fixed order (the environment overrides run before, on the profiles):
 *
 *   1. coast (C9, docs/COAST.md §5.4 step 4): placement edits BY UID: drop, re-snap, add (./coast/, CST-C);
 *   2. town dressing (docs/TOWN_LIFE.md §7.2, wave 11): new props and their models, and edits by uid, the same shape
 *      as C9 (./town/dressing.ts, TL-B);
 *   3. cloth reclass (docs/TOWN_LIFE.md §5.1, wave 11): per model, the materials that sway as cloth and how
 *      (./town/cloth.ts, TL-M);
 *   4. static variants (docs/BATCHING.md §3.5): a static glb per skinned foliage model (./static-variants.ts, BT-C);
 *   5. grass palettes (docs/GRASS_LIFE.md §3.5): per-tile grass weight and palette (./grass.ts, GL-C);
 *   6. world edits (wave 12, docs/WAVE_PLAN8.md D6, docs/WORLD_EDITOR.md §3.6): the user's map edits from
 *      content/world-edits/<world>/ (./edits/index.ts, WE-D): the C9 shape (a move = a drop + an add of the same key)
 *      plus models; a skinned foliage model that only an edit's add uses gets its static variant here (step 4's pass
 *      on just those placements), so the edited set is what the batcher draws;
 *   7. tree swap (wave 12, docs/TREES.md WF11, WF12): the new species appended as models and `treeSwap` written on
 *      the retail models they replace (./trees-manifest.ts, T12-A); last, so a species never meets an earlier pass and
 *      an edit's planted carrier is swapped like a retail one (docs/WAVE_PLAN8.md D16).
 *
 * The coast's edits are applied here, before every later pass, so a dropped uid is never seen by the dressing, cloth,
 * static-variant or grass pass (nor by perches), and a re-snapped one carries its new y (the S-DRAW seam); the
 * dressing's props exist before the cloth pass, the static variants and the grass masks read the placements. Later
 * passes get the edited placements only; they return their results and this module applies them, so the invariants
 * live in one place:
 * - a static variant is accepted only for a skinned model that a remaining placement uses, and becomes a new 'static'
 *   model at the end of `models` (models[i].staticVariant = its index);
 * - a grass entry is accepted only for a tile in `tiles`;
 * - a dressing model is appended to `models` (its index = the count before it); a dressing placement must index an
 *   existing or appended model;
 * - a cloth entry is accepted only for a converted model a remaining placement uses, with known kinds;
 * - an edits model is appended like a dressing model; an edits placement must index an existing or appended model;
 * - a tree swap names a converted retail model (not a species, not swapped twice) and one of the appended species; a
 *   skinned model's static variant carries the same swap (Medium+ draw the variant).
 * Problems are warnings (the converter never aborts on content, ./convert-world.ts), except the S-UID rule (./uids.ts):
 * an edits add outside the editor's uid range (a move keeps its key) or on a (region, uid) another source holds, or a
 * coast or dressing add inside the editor's range, throws.
 *
 * Pure: no node:* import, no archive access; the passes themselves may read and write files under ctx.outDir.
 */
import type { NavData } from '@sro/nav'
import {
  WORLD_CLOTH_KINDS,
  type TileGrass, type TileTexture, type Vec3, type WorldCoast, type WorldCoastReport, type WorldEditsReport, type WorldModel, type WorldModelCloth,
  type WorldModelTreeSwap, type WorldPlacement, type WorldRegion, type WorldTownReport, type WorldTreesReport,
} from './manifest.ts'
import { UidRegistry, type UidSource } from './uids.ts'

/** What every pass may read. Arrays are the pipeline's current state; passes must not mutate them. */
export interface WorldPassContext {
  /** The export folder (absolute). */
  outDir: string
  /** The floating origin region. */
  origin: { x: number; z: number }
  regions: readonly WorldRegion[]
  tiles: readonly TileTexture[]
  models: readonly WorldModel[]
  placements: readonly WorldPlacement[]
  warnings: string[]
  log: (line: string) => void
}

/** A placement by its owner region (z << 8 | x) and owner-region-unique uid. */
export interface PlacementRef {
  region: number
  uid: number
}

/** C9 (docs/COAST.md §5.4 step 4): edits by uid. `y`: the new glTF y (m) of the placement's origin. */
export interface PlacementEdits {
  drop: PlacementRef[]
  resnap: Array<PlacementRef & { y: number }>
  /** Coast props (docs/COAST.md §10.3): complete placements whose `models` index the export's models. */
  add: WorldPlacement[]
}

/** The coast pass's part in this pipeline (the terrain overlay is wired separately in ./convert-world.ts). */
export interface CoastPass {
  /** C9: the placement edits for the converted placements. Runs first. */
  placementEdits(ctx: WorldPassContext): PlacementEdits | Promise<PlacementEdits>
  /** manifest.coast, when the pass wrote the coast field. */
  manifestCoast?(): WorldCoast | undefined
  /** Extra report.coast keys (the census). `placements` is filled by the pipeline and wins over a returned one. */
  report?(): Record<string, unknown>
}

/** One static variant: `of` = the skinned model's index; `model` = the written static model (its index is assigned). */
export interface StaticVariant {
  of: number
  model: Omit<WorldModel, 'index' | 'staticVariant'>
}

export type StaticVariantPass = (ctx: WorldPassContext) => StaticVariant[] | Promise<StaticVariant[]>

export type GrassPalettePass = (ctx: WorldPassContext) => Array<{ id: number; grass: TileGrass }> | Promise<Array<{ id: number; grass: TileGrass }>>

/**
 * The town dressing (wave 11, TL-B): C9's edit shape plus new models. `models[k]` gets index `ctx.models.length + k`,
 * and `add` placements may index them.
 */
export interface TownDressingEdits extends PlacementEdits {
  models?: Array<Omit<WorldModel, 'index' | 'staticVariant'>>
}

export type TownDressingPass = (ctx: WorldPassContext) => TownDressingEdits | Promise<TownDressingEdits>

/** One model's cloth reclass (wave 11, TL-M): its materials that sway, by material name. */
export interface ClothReclass {
  model: number
  cloth: WorldModelCloth[]
}

export type ClothPass = (ctx: WorldPassContext) => ClothReclass[] | Promise<ClothReclass[]>

/**
 * The world edits (wave 12, WE-D): the C9 edit shape plus new models (`models[k]` gets index `ctx.models.length + k`).
 * A move is a drop + an add of the same (region, uid); a new object takes an editor uid (./uids.ts, 0xE000-0xEFFF).
 */
export interface WorldEditsEdits extends TownDressingEdits {}

export type WorldEditsPass = (ctx: WorldPassContext) => WorldEditsEdits | Promise<WorldEditsEdits>

/** One retail model's swap: `species` indexes TreeSwapStep.species; `fit`, `tint` and `offset` as WorldModelTreeSwap. */
export interface TreeSwapEntry {
  model: number
  species: number
  fit: Vec3
  tint: number
  offset?: Vec3
}

/** The tree-swap manifest step (wave 12, T12-A): the species (appended as models, in order) and the swaps. */
export interface TreeSwapStep {
  species: Array<Omit<WorldModel, 'index' | 'staticVariant' | 'treeSwap'>>
  swaps: TreeSwapEntry[]
}

export type TreeSwapPass = (ctx: WorldPassContext) => TreeSwapStep | Promise<TreeSwapStep>

export interface WorldPasses {
  coast?: CoastPass | null
  townDressing?: TownDressingPass | null
  cloth?: ClothPass | null
  staticVariants?: StaticVariantPass | null
  grass?: GrassPalettePass | null
  /** Wave 12: the world edits (step 6). */
  worldEdits?: WorldEditsPass | null
  /** Wave 12: the tree-swap manifest step (step 7). */
  treeSwap?: TreeSwapPass | null
}

export interface WorldPassInput {
  outDir: string
  origin: { x: number; z: number }
  regions: WorldRegion[]
  tiles: TileTexture[]
  models: WorldModel[]
  placements: WorldPlacement[]
  warnings: string[]
  log?: (line: string) => void
}

export interface WorldPassResult {
  /** The placements after C9 (a new array; the input's placements are not mutated, nor are its placement objects). */
  placements: WorldPlacement[]
  /** `models` with the static variants appended and `staticVariant` set (new objects where changed). */
  models: WorldModel[]
  /** `tiles` with `grass` set where the grass pass gave one (new objects where changed). */
  tiles: TileTexture[]
  /** manifest.coast, when the coast pass gave one. */
  coast?: WorldCoast
  /** report.coast, when a coast pass ran. */
  coastReport?: WorldCoastReport
  /** report.town, when a dressing or cloth pass ran. */
  townReport?: WorldTownReport
  /** report.edits, when the world-edits pass ran. */
  editsReport?: WorldEditsReport
  /** report.trees, when the tree-swap step ran. */
  treesReport?: WorldTreesReport
}

const key = (region: number, uid: number) => `${region}:${uid}`
const roundCopy = (t: WorldModelTreeSwap): WorldModelTreeSwap =>
  ({ ...t, fit: [...t.fit], ...(t.offset ? { offset: [...t.offset] as Vec3 } : {}) })

/**
 * Applies C9 edits (or the town dressing's, with `label` 'town') by (region, uid). Unknown refs and conflicting adds
 * are warnings and are skipped.
 */
export function applyPlacementEdits(
  placements: readonly WorldPlacement[], edits: PlacementEdits, modelCount: number, warnings: string[], label = 'coast',
): { placements: WorldPlacement[]; report: WorldCoastReport['placements'] } {
  const report: WorldCoastReport['placements'] = { dropped: [], resnapped: [], added: [] }
  const byKey = new Map<string, number>()
  placements.forEach((p, i) => byKey.set(key(p.region, p.uid), i))
  const dropped = new Set<number>()
  for (const d of edits.drop) {
    const i = byKey.get(key(d.region, d.uid))
    if (i === undefined) warnings.push(`${label}: drop of unknown placement ${d.region}:${d.uid}`)
    else if (!dropped.has(i)) {
      dropped.add(i)
      report.dropped.push({ region: d.region, uid: d.uid })
    }
  }
  const resnapY = new Map<number, number>()
  for (const r of edits.resnap) {
    const i = byKey.get(key(r.region, r.uid))
    if (i === undefined) warnings.push(`${label}: re-snap of unknown placement ${r.region}:${r.uid}`)
    else if (dropped.has(i)) warnings.push(`${label}: re-snap of dropped placement ${r.region}:${r.uid} ignored`)
    else if (!Number.isFinite(r.y)) warnings.push(`${label}: re-snap of ${r.region}:${r.uid} to a non-finite y ignored`)
    else resnapY.set(i, r.y)
  }
  const out: WorldPlacement[] = []
  placements.forEach((p, i) => {
    if (dropped.has(i)) return
    const y = resnapY.get(i)
    if (y === undefined) return out.push(p)
    report.resnapped.push({ region: p.region, uid: p.uid, fromY: p.position[1], toY: y })
    out.push({ ...p, position: [p.position[0], y, p.position[2]] })
  })
  const taken = new Set(out.map(p => key(p.region, p.uid)))
  for (const a of edits.add) {
    const k = key(a.region, a.uid)
    if (taken.has(k)) warnings.push(`${label}: added placement ${k} collides with an existing (region, uid)`)
    else if (!a.models.length || !a.models.every(m => Number.isInteger(m) && m >= 0 && m < modelCount)) {
      warnings.push(`${label}: added placement ${k} has a model index out of range`)
    } else {
      taken.add(k)
      out.push(a)
      report.added.push({ region: a.region, uid: a.uid })
    }
  }
  // Keep the manifest's order: owner region, then uid (stable for the retail ones, which are already in that order).
  if (report.added.length) out.sort((a, b) => a.region - b.region || a.uid - b.uid)
  return { placements: out, report }
}

/**
 * Applies one authored source's edits under the S-UID registry (./uids.ts). The editor's: the drops release their keys,
 * then the adds are claimed (throws on a range or collision error) before applyPlacementEdits places them. The coast's
 * and the dressing's keep their wave-10/11 contract (collisions are warnings): applied, then their adds recorded.
 */
function applyAuthored(
  uids: UidRegistry, source: Exclude<UidSource, 'retail'>, placements: readonly WorldPlacement[], edits: PlacementEdits, modelCount: number,
  warnings: string[], label: string,
): ReturnType<typeof applyPlacementEdits> {
  if (source === 'editor') {
    const present = new Set(placements.map(p => key(p.region, p.uid)))
    const drops = edits.drop.filter(d => present.has(key(d.region, d.uid)))
    uids.release(drops)
    uids.claim(source, edits.add, drops)
    return applyPlacementEdits(placements, edits, modelCount, warnings, label)
  }
  const applied = applyPlacementEdits(placements, edits, modelCount, warnings, label)
  uids.release(applied.report.dropped)
  uids.note(source, applied.report.added)
  return applied
}

/**
 * Runs the passes in the fixed order coast → town dressing → cloth → static variants → grass palettes → world edits →
 * tree swap (the header).
 */
export async function runWorldPasses(input: WorldPassInput, passes: WorldPasses): Promise<WorldPassResult> {
  const log = input.log ?? (() => {})
  const { warnings } = input
  const ctx = (placements: readonly WorldPlacement[], models: readonly WorldModel[], tiles: readonly TileTexture[]): WorldPassContext =>
    ({ outDir: input.outDir, origin: input.origin, regions: input.regions, tiles, models, placements, warnings, log })
  const uids = new UidRegistry()
  uids.input(input.placements)

  // 1. coast (C9), before anything else reads the placements
  let placements: WorldPlacement[] = input.placements.slice()
  let coast: WorldCoast | undefined
  let coastReport: WorldCoastReport | undefined
  if (passes.coast) {
    const edits = await passes.coast.placementEdits(ctx(placements, input.models, input.tiles))
    const applied = applyAuthored(uids, 'coast', placements, edits, input.models.length, warnings, 'coast')
    placements = applied.placements
    coast = passes.coast.manifestCoast?.()
    coastReport = { ...(passes.coast.report?.() ?? {}), placements: applied.report }
    log(`coast: placements ${applied.report.dropped.length} dropped, ${applied.report.resnapped.length} re-snapped, ` +
      `${applied.report.added.length} added`)
  }

  // 2. town dressing (TL-B): its models first, then its placement edits, on the coast's placements
  const models: WorldModel[] = input.models.slice()
  let town: WorldTownReport | undefined
  if (passes.townDressing) {
    const edits = await passes.townDressing(ctx(placements, models, input.tiles))
    for (const m of edits.models ?? []) {
      const { staticVariant: _sv, ...rest } = m as WorldModel
      models.push({ ...rest, index: models.length })
    }
    const applied = applyAuthored(uids, 'dressing', placements, edits, models.length, warnings, 'town')
    placements = applied.placements
    town = { placements: applied.report, models: edits.models?.length ?? 0, clothModels: 0 }
    log(`town dressing: ${town.models} model(s); placements ${applied.report.dropped.length} dropped, ` +
      `${applied.report.resnapped.length} re-snapped, ${applied.report.added.length} added`)
  }

  // 3. cloth reclass (TL-M), on the dressed placements
  if (passes.cloth) {
    const used = new Set<number>()
    for (const p of placements) for (const m of p.models) used.add(m)
    const entries = await passes.cloth(ctx(placements, models, input.tiles))
    const done = new Set<number>()
    for (const e of entries) {
      const src = models[e.model]
      const bad = e.cloth.find(c => !c || typeof c.material !== 'string' || !c.material || !WORLD_CLOTH_KINDS.includes(c.kind))
      if (!src) warnings.push(`cloth: unknown model ${e.model}`)
      else if (src.kind === 'failed') warnings.push(`cloth: ${src.source} failed to convert`)
      else if (!used.has(e.model)) warnings.push(`cloth: ${src.source}: no placement uses the model`)
      else if (done.has(e.model)) warnings.push(`cloth: ${src.source}: duplicate`)
      else if (!e.cloth.length || bad) warnings.push(`cloth: ${src.source}: expected {material, kind: ${WORLD_CLOTH_KINDS.join(' | ')}} entries`)
      else {
        done.add(e.model)
        models[e.model] = { ...src, cloth: e.cloth.map(c => ({ ...c })) }
      }
    }
    town = { placements: town?.placements ?? { dropped: [], resnapped: [], added: [] }, models: town?.models ?? 0, clothModels: done.size }
    if (done.size) log(`cloth: ${done.size} model(s) reclassed`)
  }

  // 4. static variants, on the edited placements
  /** Runs the static-variant pass on `on` and accepts its variants of models below `below` (returns how many). */
  const variantsFor = async (on: readonly WorldPlacement[], below: number): Promise<number> => {
    if (!passes.staticVariants) return 0
    const used = new Set<number>()
    for (const p of on) for (const m of p.models) used.add(m)
    const variants = await passes.staticVariants(ctx(on, models, input.tiles))
    const done = new Set<number>()
    for (const v of variants) {
      const src = models[v.of]
      if (!src || v.of >= below) warnings.push(`static variant of unknown model ${v.of}`)
      else if (src.staticVariant !== undefined) continue // step 6's late run: a compound's other model already has one
      else if (src.kind !== 'skinned') warnings.push(`static variant of ${src.source}: not a skinned model`)
      else if (!used.has(v.of)) warnings.push(`static variant of ${src.source}: no placement uses the model`)
      else if (done.has(v.of)) warnings.push(`static variant of ${src.source}: duplicate`)
      else if (v.model.kind !== 'static') warnings.push(`static variant of ${src.source}: the variant is not a static model`)
      else {
        done.add(v.of)
        const index = models.length
        models.push({ ...v.model, index })
        models[v.of] = { ...src, staticVariant: index }
      }
    }
    return done.size
  }
  const variantCount = await variantsFor(placements, models.length)
  if (variantCount) log(`static variants: ${variantCount}`)

  // 5. grass palettes, on the edited placements (perches) and the tiles
  const tiles: TileTexture[] = input.tiles.slice()
  if (passes.grass) {
    const entries = await passes.grass(ctx(placements, models, tiles))
    const at = new Map(tiles.map((t, i) => [t.id, i]))
    let n = 0
    for (const e of entries) {
      const i = at.get(e.id)
      if (i === undefined) warnings.push(`grass palette for unknown tile ${e.id}`)
      else {
        tiles[i] = { ...tiles[i]!, grass: e.grass }
        n++
      }
    }
    if (n) log(`grass palettes: ${n} tile(s)`)
  }

  // 6. world edits (WE-D), last of the placement passes: the user's hand wins over everything procedural
  let editsReport: WorldEditsReport | undefined
  if (passes.worldEdits) {
    const edits = await passes.worldEdits(ctx(placements, models, tiles))
    const firstNew = models.length
    for (const m of edits.models ?? []) {
      const { staticVariant: _sv, treeSwap: _ts, ...rest } = m as WorldModel
      models.push({ ...rest, index: models.length })
    }
    const applied = applyAuthored(uids, 'editor', placements, edits, models.length, warnings, 'edits')
    placements = applied.placements
    // a skinned foliage model only the edits' adds use gets its variant now (step 4 never saw it)
    const addedKeys = new Set(applied.report.added.map(a => key(a.region, a.uid)))
    const lacking = placements.filter(p => addedKeys.has(key(p.region, p.uid)) &&
      p.models.some(m => models[m]?.kind === 'skinned' && models[m]!.staticVariant === undefined))
    const lateVariants = lacking.length ? await variantsFor(lacking, models.length) : 0
    editsReport = { placements: applied.report, models: models.length - firstNew - lateVariants, staticVariants: lateVariants }
    log(`world edits: ${editsReport.models} model(s); placements ${applied.report.dropped.length} dropped, ` +
      `${applied.report.resnapped.length} re-snapped, ${applied.report.added.length} added` +
      `${lateVariants ? `; ${lateVariants} static variant(s)` : ''}`)
  }

  // 7. tree swap (T12-A): the species appended as models, `treeSwap` on the retail models they replace
  let treesReport: WorldTreesReport | undefined
  if (passes.treeSwap) {
    const step = await passes.treeSwap(ctx(placements, models, tiles))
    const base = models.length
    for (const sp of step.species) {
      const { staticVariant: _sv, treeSwap: _ts, ...rest } = sp as WorldModel
      models.push({ ...rest, index: models.length })
    }
    let swapped = 0
    const done = new Set<number>()
    for (const e of step.swaps) {
      const src = models[e.model]
      const species = Number.isInteger(e.species) && e.species >= 0 ? models[base + e.species] : undefined
      const fitOk = Array.isArray(e.fit) && e.fit.length === 3 && e.fit.every(v => Number.isFinite(v) && v > 0)
      const offsetOk = e.offset === undefined || (Array.isArray(e.offset) && e.offset.length === 3 && e.offset.every(Number.isFinite))
      if (!src || e.model >= base) warnings.push(`tree swap: unknown retail model ${e.model}`)
      else if (src.kind === 'failed') warnings.push(`tree swap: ${src.source} failed to convert`)
      else if (done.has(e.model) || src.treeSwap) warnings.push(`tree swap: ${src.source}: duplicate`)
      else if (!species) warnings.push(`tree swap: ${src.source}: unknown species ${e.species}`)
      else if (species.kind !== 'static' || !species.glb) warnings.push(`tree swap: ${src.source}: species ${species.source} is not a converted static model`)
      else if (!fitOk || !offsetOk || !Number.isFinite(e.tint)) {
        warnings.push(`tree swap: ${src.source}: expected fit [3 numbers > 0], a finite tint and offset [3 numbers] or none`)
      } else {
        done.add(e.model)
        const treeSwap: WorldModelTreeSwap = {
          model: species.index, fit: [e.fit[0], e.fit[1], e.fit[2]], tint: e.tint,
          ...(e.offset ? { offset: [e.offset[0], e.offset[1], e.offset[2]] as Vec3 } : {}),
        }
        models[e.model] = { ...src, treeSwap }
        // Medium+ draw a skinned model's static variant: it is the same retail tree
        const v = src.staticVariant !== undefined ? models[src.staticVariant] : undefined
        if (v && !v.treeSwap) models[v.index] = { ...v, treeSwap: roundCopy(treeSwap) }
        swapped++
      }
    }
    treesReport = { species: step.species.length, swapped }
    log(`tree swap: ${treesReport.species} species, ${swapped} retail model(s) swapped`)
  }

  return {
    placements, models, tiles, ...(coast ? { coast } : {}), ...(coastReport ? { coastReport } : {}), ...(town ? { townReport: town } : {}),
    ...(editsReport ? { editsReport } : {}), ...(treesReport ? { treesReport } : {}),
  }
}

/**
 * The nav step and the edits pass agree on every edited footprint (docs/WORLD_EDITOR.md §3.6): the nav is built
 * before the placement passes, from the same layer by WE-N's nav edit, so the spine checks the result. For every
 * (region, uid) the edits dropped and did not re-add: no nav instance; for every one they added (a move's new
 * transform included) whose object has a collision navmesh anywhere in the nav (`objId` among the instances): exactly
 * one instance, at the placement's position (file space, within `tolUnits`) and yaw (within 1e-3 rad). Returns the
 * problems (empty = they agree).
 */
export function editedFootprintProblems(
  nav: Pick<NavData, 'instances'>, report: WorldEditsReport['placements'], placements: readonly WorldPlacement[],
  origin: { x: number; z: number }, tolUnits = 0.5,
): string[] {
  const out: string[] = []
  const byId = new Map<number, Array<NavData['instances'][number]>>()
  for (const i of nav.instances) {
    const list = byId.get(i.id >>> 0)
    if (list) list.push(i)
    else byId.set(i.id >>> 0, [i])
  }
  const footprinted = new Set(nav.instances.map(i => i.objId))
  const navId = (region: number, uid: number) => ((region << 16) | uid) >>> 0
  const added = new Set(report.added.map(a => key(a.region, a.uid)))
  for (const d of report.dropped) {
    if (added.has(key(d.region, d.uid))) continue
    const n = byId.get(navId(d.region, d.uid))?.length ?? 0
    if (n) out.push(`edits: dropped ${d.region}:${d.uid} still has ${n} nav instance(s)`)
  }
  const byKey = new Map(placements.map(p => [key(p.region, p.uid), p]))
  for (const a of report.added) {
    const p = byKey.get(key(a.region, a.uid))
    if (!p || !footprinted.has(p.objId)) continue
    const list = byId.get(navId(a.region, a.uid)) ?? []
    if (list.length !== 1) {
      out.push(`edits: ${a.region}:${a.uid} (${p.source}) has ${list.length} nav instances, expected 1`)
      continue
    }
    const inst = list[0]!
    // glTF metres relative to the origin -> world file space (./convert-world.ts's spawn rule; space.ts 0.1 (x, y, -z))
    const x = origin.x * 1920 + p.position[0] * 10
    const z = origin.z * 1920 - p.position[2] * 10
    const dyaw = Math.abs(Math.atan2(Math.sin(inst.yaw - p.yaw), Math.cos(inst.yaw - p.yaw)))
    if (Math.abs(inst.x - x) > tolUnits || Math.abs(inst.z - z) > tolUnits || dyaw > 1e-3) {
      out.push(`edits: ${a.region}:${a.uid} (${p.source}) nav instance at (${inst.x.toFixed(1)}, ${inst.z.toFixed(1)}) yaw ${inst.yaw.toFixed(4)}, ` +
        `placement at (${x.toFixed(1)}, ${z.toFixed(1)}) yaw ${p.yaw.toFixed(4)}`)
    }
  }
  return out
}
