/**
 * The World Editor's tree seam (docs/TREES.md Part W §W3.9, WF14, WF20; docs/WORLD_EDITOR.md §4.5, F7, D25;
 * docs/WAVE_PLAN8.md §6.2 T12-E, D16, D17). Owner: T12-E. Draws nothing itself: the band byte, the slots and the LOD0
 * overlay are T12-N's (`trees/index.ts`), the re-batch is S-OBJ's (`WorldObjects.setEditorOwned`,
 * `RegionStreamer.reloadObjects`).
 *
 * - **library()**: the species the editor's Trees tab lists, one entry per species (`content/trees/library.json`,
 *   written by the tree tool), resolved against the world's manifest: the carrier's model index, the species' model
 *   index and whether it is placeable here (the carrier is in the export and its `treeSwap` draws this species). A
 *   species the manifest has but the file lacks still gets an entry (its id as the name, the swap source with the
 *   closest envelope as its carrier), so every species of the export is placeable (D16, D25). `World.trees.library()`
 *   reads `treeLibraryOf(world.manifest)`; the editor hands in the file once (`setTreeLibrary`).
 * - **preview()**: `TreePreview`, the editor's drag of one swapped tree: the species' LOD0 drawn as one overlay
 *   instance at the dragged placement's matrix (the fit and the trunk offset folded in, as the merge does), the
 *   placement's merged copy hidden at once (band 3) meanwhile. It follows a matrix source every frame it is asked, so
 *   a gizmo drag needs no extra calls. On drop the editor re-batches the region (S-OBJ) and ends the preview when the
 *   re-batch has landed: no frame shows both copies or neither.
 * - **setHidden()**: `TreePreview.hold(key)` / `release(key)` (a delete hides the merged copy until the re-merge
 *   without it lands).
 *
 * A placement is drawn as a species only on the swap's path (PBR, batched, trees 'new'); elsewhere `World.trees` is
 * null and every call here is a no-op that answers false (the editor keeps its retail proxy: Low stays retail).
 */
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core'
import type { WorldManifest, WorldModel, WorldPlacement } from '../../../convert/src/world/manifest.ts'
import { foldSwap } from '../batch/trees.ts'
import { speciesIdOf } from './swap.ts'
import type { TreeLibraryEntry, TreesPart } from './types.ts'

/** The format tag of `content/trees/library.json` (the tree tool's LIBRARY_FORMAT). */
export const TREE_LIBRARY_FORMAT = 'sro-trees-library'
/** The editor's scale range for trees (WAVE_PLAN8 D17; TREES Q-W7). */
export const TREE_EDITOR_SCALE: readonly [number, number] = [0.85, 1.15]

/** One row of `content/trees/library.json` (the tree tool's `LibraryEntry`). */
export interface TreeLibraryRow {
  id: string
  name: string
  family: string
  kind: 'tree' | 'plant'
  carrier: string
  heightM: number
  widthM: number
  scaleRange: [number, number]
  tint: string
  tints: string[]
  thumbnail: string
}

/** A species as the editor lists it (TreeLibraryEntry plus what the Trees tab shows and places). */
export interface TreeLibrarySpecies extends TreeLibraryEntry {
  readonly family: string
  readonly kind: 'tree' | 'plant'
  /** The carrier's envelope (m), from the file (0 when unknown). */
  readonly heightM: number
  readonly widthM: number
  /** The species' tint names ('default' first). */
  readonly tints: readonly string[]
  /** The carrier's manifest model index, or null (not in this export). */
  readonly carrierModel: number | null
  /** The species' manifest model index, or null (not in this export). */
  readonly speciesModel: number | null
  /** Every retail model of the export drawn as this species (its swap sources). */
  readonly sources: readonly number[]
  /** Placeable here: the carrier is in the export and its `treeSwap` draws this species. */
  readonly placeable: boolean
  /** Why not (null when placeable). */
  readonly problem: string | null
  /** True when the entry came from the manifest alone (no row in library.json). */
  readonly derived: boolean
}

/** A manifest source compared case- and slash-insensitively (the `#static` suffix dropped; the tool's sourceKey). */
export function treeSourceKey(source: string): string {
  return source.replace(/#static$/i, '').replace(/\//g, '\\').toLowerCase()
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Reads `content/trees/library.json`; rows with a problem are left out and named. */
export function parseTreeLibrary(json: unknown): { rows: TreeLibraryRow[]; problems: string[] } {
  const problems: string[] = []
  const rows: TreeLibraryRow[] = []
  const f = json as { format?: unknown; version?: unknown; species?: unknown } | null
  if (!f || typeof f !== 'object') return { rows, problems: ['library.json: not an object'] }
  if (f.format !== TREE_LIBRARY_FORMAT) problems.push(`library.json: format ${String(f.format)}, expected ${TREE_LIBRARY_FORMAT}`)
  if (f.version !== 1) problems.push(`library.json: version ${String(f.version)}, expected 1`)
  if (!Array.isArray(f.species)) return { rows, problems: [...problems, 'library.json: species is not an array'] }
  const seen = new Set<string>()
  f.species.forEach((s: unknown, i: number) => {
    const r = s as Partial<TreeLibraryRow> | null
    const at = `species[${i}]`
    if (!r || typeof r !== 'object' || !isStr(r.id) || !isStr(r.carrier)) return problems.push(`${at}: needs an id and a carrier`)
    if (seen.has(r.id)) return problems.push(`${at}: ${r.id} listed twice`)
    seen.add(r.id)
    const range = Array.isArray(r.scaleRange) && r.scaleRange.length === 2 && r.scaleRange.every(isNum) && r.scaleRange[0]! > 0 && r.scaleRange[0]! <= r.scaleRange[1]!
      ? [r.scaleRange[0]!, r.scaleRange[1]!] as [number, number]
      : [...TREE_EDITOR_SCALE] as [number, number]
    rows.push({
      id: r.id,
      name: isStr(r.name) ? r.name : r.id,
      family: isStr(r.family) ? r.family : 'other',
      kind: r.kind === 'plant' ? 'plant' : 'tree',
      carrier: r.carrier,
      heightM: isNum(r.heightM) ? r.heightM : 0,
      widthM: isNum(r.widthM) ? r.widthM : 0,
      scaleRange: range,
      tint: isStr(r.tint) ? r.tint : 'default',
      tints: Array.isArray(r.tints) ? r.tints.filter(isStr) : ['default'],
      thumbnail: isStr(r.thumbnail) ? r.thumbnail : '',
    })
  })
  return { rows, problems }
}

/** The species models of a manifest by id (the tree-swap step's appended models), and each one's swap sources. */
export function speciesOfManifest(manifest: Pick<WorldManifest, 'models'>): Map<string, { model: WorldModel; sources: WorldModel[] }> {
  const out = new Map<string, { model: WorldModel; sources: WorldModel[] }>()
  const byIndex = new Map<number, { model: WorldModel; sources: WorldModel[] }>()
  for (const m of manifest.models) {
    const id = m.kind === 'static' ? speciesIdOf(m) : null
    if (!id || out.has(id)) continue
    const e = { model: m, sources: [] as WorldModel[] }
    out.set(id, e)
    byIndex.set(m.index, e)
  }
  // a skinned model's `#static` twin carries the swap; the skinned model is the source (what the export places)
  const owner = new Map<number, WorldModel>()
  for (const m of manifest.models) if (m.kind === 'skinned' && m.staticVariant !== undefined && m.staticVariant !== null) owner.set(m.staticVariant, m)
  for (const m of manifest.models) {
    const ts = m.treeSwap
    if (!ts || m.kind === 'failed') continue
    const e = byIndex.get(ts.model)
    if (!e) continue
    const src = owner.get(m.index) ?? m
    if (!e.sources.includes(src)) e.sources.push(src)
  }
  return out
}

/** The swap source whose envelope is closest to the species' own (fit nearest 1 on every axis): the default carrier. */
export function closestCarrier(sources: readonly WorldModel[], models: readonly WorldModel[] = []): WorldModel | null {
  let best: WorldModel | null = null
  let bestD = Infinity
  for (const m of sources) {
    // a skinned retail model is placed as itself (its static variant draws it); a `#static` variant is never placed
    if (/#static$/i.test(m.source)) continue
    const v = m.kind === 'skinned' && m.staticVariant !== undefined && m.staticVariant !== null ? models[m.staticVariant] : undefined
    const fit = (m.treeSwap ?? v?.treeSwap)?.fit ?? [1, 1, 1]
    const d = fit.reduce((a, f) => a + Math.abs(Math.log(f > 0 ? f : 1)), 0)
    if (d < bestD || (d === bestD && best && m.source < best.source)) {
      best = m
      bestD = d
    }
  }
  return best
}

/** A model's swap target index, following a skinned model's static variant (the batch draws the variant). */
function swapTarget(manifest: Pick<WorldManifest, 'models'>, m: WorldModel): number | null {
  if (m.treeSwap) return m.treeSwap.model
  if (m.kind === 'skinned' && m.staticVariant !== undefined && m.staticVariant !== null) {
    return manifest.models[m.staticVariant]?.treeSwap?.model ?? null
  }
  return null
}

/**
 * The editor's species list for a manifest: the file's rows in their order (each resolved: carrier and species model,
 * placeable or why not), then every species the manifest has but the file lacks (derived: the closest-envelope swap
 * source as its carrier).
 */
export function resolveTreeLibrary(rows: readonly TreeLibraryRow[], manifest: Pick<WorldManifest, 'models'>): TreeLibrarySpecies[] {
  const bySource = new Map<string, WorldModel>()
  for (const m of manifest.models) {
    const k = treeSourceKey(m.source)
    if (!/#static$/i.test(m.source) || !bySource.has(k)) bySource.set(k, m)
  }
  const species = speciesOfManifest(manifest)
  const out: TreeLibrarySpecies[] = []
  const listed = new Set<string>()
  const entry = (r: TreeLibraryRow, carrier: WorldModel | null, derived: boolean): TreeLibrarySpecies => {
    const sp = species.get(r.id) ?? null
    let problem: string | null = null
    if (!sp) problem = `${r.id} is not in this export yet (pnpm trees build, then a re-convert)`
    else if (!carrier) problem = `its carrier ${r.carrier} is not in this export`
    else if (carrier.kind === 'failed' || !carrier.glb) problem = `its carrier ${r.carrier} failed to convert`
    else if (swapTarget(manifest, carrier) !== sp.model.index) problem = `its carrier ${r.carrier} is not drawn as ${r.id} (swap.json)`
    return {
      id: r.id,
      name: r.name,
      carrier: carrier?.source ?? r.carrier,
      thumbnail: r.thumbnail || null,
      size: r.scaleRange,
      tint: r.tint === 'default' ? null : r.tint,
      family: r.family,
      kind: r.kind,
      heightM: r.heightM,
      widthM: r.widthM,
      tints: r.tints.length ? r.tints : ['default'],
      carrierModel: carrier?.index ?? null,
      speciesModel: sp?.model.index ?? null,
      sources: sp ? sp.sources.map(m => m.index) : [],
      placeable: problem === null,
      problem,
      derived,
    }
  }
  for (const r of rows) {
    listed.add(r.id)
    out.push(entry(r, bySource.get(treeSourceKey(r.carrier)) ?? null, false))
  }
  for (const [id, sp] of species) {
    if (listed.has(id)) continue
    const carrier = closestCarrier(sp.sources, manifest.models)
    const b = sp.model
    out.push(entry({
      id, name: id, family: 'other', kind: 'tree', carrier: carrier?.source ?? '',
      heightM: +(b.boundsMax[1] - b.boundsMin[1]).toFixed(2), widthM: +(b.boundsMax[0] - b.boundsMin[0]).toFixed(2),
      scaleRange: [...TREE_EDITOR_SCALE] as [number, number], tint: 'default', tints: ['default'], thumbnail: `trees/${id}/thumb.png`,
    }, carrier, true))
  }
  return out
}

/** The library file per manifest (the editor hands it in once; World.trees.library() reads it). */
const libraries = new WeakMap<object, { rows: readonly TreeLibraryRow[]; resolved: TreeLibrarySpecies[] | null }>()
const derivedOnly = new WeakMap<object, TreeLibrarySpecies[]>()

/** Hands `content/trees/library.json` (parsed or raw) to the trees seam for this manifest; returns the file's problems. */
export function setTreeLibrary(manifest: Pick<WorldManifest, 'models'>, json: unknown): string[] {
  const { rows, problems } = parseTreeLibrary(json)
  libraries.set(manifest, { rows, resolved: null })
  return problems
}

/**
 * The species list of a manifest (`World.trees.library()`): the file's rows when the editor handed it in, else the
 * manifest's species alone (derived entries). Cached per manifest.
 */
export function treeLibraryOf(manifest: Pick<WorldManifest, 'models'>): readonly TreeLibrarySpecies[] {
  const lib = libraries.get(manifest)
  if (lib) return (lib.resolved ??= resolveTreeLibrary(lib.rows, manifest))
  let d = derivedOnly.get(manifest)
  if (!d) derivedOnly.set(manifest, (d = resolveTreeLibrary([], manifest)))
  return d
}

// ---- the preview (the drag) --------------------------------------------------------------------------------------------

/** What a preview needs of the world (World, or a test's stand-in). */
export interface TreePreviewHost {
  readonly manifest: Pick<WorldManifest, 'models'>
  /** World.trees (null: no swap on this path; the preview answers false). */
  readonly trees: TreesPart | null
}

/** A placement-like state: position, yaw (rad, about +Y) or a quaternion, uniform scale. */
export interface TreeState {
  position: ArrayLike<number>
  yaw?: number
  rotation?: ArrayLike<number>
  scale?: number
}

/**
 * The species matrix of a placement-like state of a swapped carrier (16 floats, world space): T · R · S with the swap's
 * fit and trunk offset folded in (T12-M's `foldSwap`, so the preview stands where the merged tree will). null: the
 * model is not swapped.
 */
export function treePreviewMatrix(carrier: Pick<WorldModel, 'treeSwap'>, state: TreeState, out = new Float32Array(16)): Float32Array | null {
  const ts = carrier.treeSwap
  if (!ts) return null
  const s = state.scale ?? 1
  const q = state.rotation ? Quaternion.FromArray(state.rotation) : Quaternion.RotationYawPitchRoll(state.yaw ?? 0, 0, 0)
  const m = Matrix.Compose(new Vector3(s, s, s), q, Vector3.FromArray(state.position))
  m.copyToArray(out, 0)
  foldSwap(out, 0, ts.fit, ts.offset)
  return out
}

/** The species matrix from a node's world matrix (16 floats, T · R · S) of a swapped carrier; null: not swapped. */
export function treePreviewFromWorld(carrier: Pick<WorldModel, 'treeSwap'>, world: ArrayLike<number>, out = new Float32Array(16)): Float32Array | null {
  const ts = carrier.treeSwap
  if (!ts) return null
  for (let i = 0; i < 16; i++) out[i] = world[i]!
  foldSwap(out, 0, ts.fit, ts.offset)
  return out
}

/** The swapped carrier a placement draws (its first model with a swap, a skinned model's static variant followed). */
export function swappedCarrierOf(manifest: Pick<WorldManifest, 'models'>, p: Pick<WorldPlacement, 'models'> | { models: readonly number[] }): WorldModel | null {
  for (const mi of p.models) {
    const m = manifest.models[mi]
    if (!m) continue
    if (m.treeSwap) return m
    if (m.kind === 'skinned' && m.staticVariant !== undefined && m.staticVariant !== null) {
      const v = manifest.models[m.staticVariant]
      if (v?.treeSwap) return v
    }
  }
  return null
}

/** The species id a swapped carrier is drawn as, or null. */
export function speciesIdOfCarrier(manifest: Pick<WorldManifest, 'models'>, carrier: Pick<WorldModel, 'treeSwap'>): string | null {
  const ts = carrier.treeSwap
  const sp = ts ? manifest.models[ts.model] : undefined
  return sp ? speciesIdOf(sp) : null
}

/**
 * The editor's live preview of one swapped tree (TREES §W3.9). One preview at a time (the overlay draws one preview
 * instance): `begin` while another runs answers false, and the caller keeps its retail proxy for that one.
 *
 * - `begin(key, carrier, source)`: `key` (placementKey; null for a new placement) hidden at once (band 3), one LOD0
 *   instance of the carrier's species at `source()` (a world T · R · S matrix, read on every `update`).
 * - `update()`: re-reads the source; sends a new matrix to the trees part only when it changed (a refill is cheap but
 *   not free).
 * - `end()`: the preview instance goes and `key` comes back (unless held). Call it once the re-batch has landed.
 * - `hold(key)` / `release(key)`: a placement's merged copy hidden while its delete re-merges (setHidden).
 */
export class TreePreview {
  private active: { key: number | null; species: string; carrier: Pick<WorldModel, 'treeSwap'>; source: () => ArrayLike<number> | null } | null = null
  private readonly last = new Float32Array(16)
  private readonly cur = new Float32Array(16)
  private sent = false
  private readonly held = new Set<number>()

  constructor(readonly host: TreePreviewHost) {}

  /** A preview is running. */
  get busy(): boolean {
    return this.active !== null
  }

  /** The key the running preview hides (null: a new placement, or none). */
  get key(): number | null {
    return this.active?.key ?? null
  }

  /** The species the running preview draws, or null. */
  get species(): string | null {
    return this.active?.species ?? null
  }

  /** Whether `carrier` would preview as a species here (a swapped model on the swap's path). */
  claims(carrier: Pick<WorldModel, 'treeSwap'> | null | undefined): boolean {
    return !!carrier?.treeSwap && !!this.host.trees && speciesIdOfCarrier(this.host.manifest, carrier) !== null
  }

  /** Starts the preview; false when it can't (not swapped, no trees part, another preview runs). */
  begin(key: number | null, carrier: Pick<WorldModel, 'treeSwap'>, source: () => ArrayLike<number> | null): boolean {
    const trees = this.host.trees
    if (this.active || !trees || !carrier.treeSwap) return false
    const species = speciesIdOfCarrier(this.host.manifest, carrier)
    if (!species) return false
    this.active = { key, species, carrier, source }
    this.sent = false
    this.update(true)
    return true
  }

  /** Follows the source (every frame while dragging; cheap when nothing moved). */
  update(force = false): void {
    const a = this.active
    const trees = this.host.trees
    if (!a || !trees) return
    const w = a.source()
    const m = w ? treePreviewFromWorld(a.carrier, w, this.cur) : null
    if (!m) {
      if (!this.sent || force) trees.preview(a.key, a.species, null)
      this.sent = true
      return
    }
    if (this.sent && !force) {
      let same = true
      for (let i = 0; i < 16; i++) if (this.last[i] !== m[i]) { same = false; break }
      if (same) return
    }
    this.last.set(m)
    this.sent = true
    trees.preview(a.key, a.species, m)
  }

  /** Ends the preview (the placement's merged copy comes back unless held). */
  end(): void {
    if (!this.active) return
    this.active = null
    this.sent = false
    this.host.trees?.preview(null, null)
  }

  /** Hides a placement's merged copy (band 3) until `release` (a delete, before its re-merge lands). */
  hold(key: number): void {
    this.held.add(key)
    this.host.trees?.setHidden(key, true)
  }

  /** Shows a held placement again (its re-merge landed, or the change was undone). */
  release(key: number): void {
    if (!this.held.delete(key)) return
    this.host.trees?.setHidden(key, false)
  }

  /** Releases every held key and ends the preview. */
  dispose(): void {
    this.end()
    for (const k of [...this.held]) this.release(k)
  }
}
