/**
 * The swap as the trees part reads it (docs/TREES.md Part W §W3.1, §W3.2, WF11, WF20; docs/WAVE_PLAN8.md §6.2 T12-N).
 * Owner: T12-N. Draws nothing: it maps a retail model to its species (the manifest model the converter appended, its
 * `far.glb`; `near.glb` beside it for the LOD0 overlay), the fit, the trunk offset and the tint, and composes a
 * placement's species matrix exactly as the region batch does (T12-M's `foldSwap`), so the overlay's LOD0 stands where
 * the merged LOD1 / LOD2 of the same tree stand.
 *
 * The batch decides what is swapped: the trees part asks the batch's own swap (`World.batch.trees.swapOf`, T12-M), so a
 * placement gets a band slot exactly when its region merges it as a species (merge mode with a swap source; never in
 * the instancing fallback, never on 'retail' or Classic).
 */
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core'
import type { WorldModel, WorldPlacement } from '../../../convert/src/world/manifest.ts'
import type { TreeSwap } from '../batch/types.ts'
import { foldSwap, type TreeMaterials } from '../batch/trees.ts'
import type { BatchTables } from '../batch/region-batch.ts'
import type { MaterialBatchRecord } from '../materials.ts'
import { placementScale } from '../placement-scale.ts'

/** The species folder in an export (the converter's `world/trees-manifest.ts` speciesFolder). */
const SPECIES_GLB = /^(.*\/)?models\/trees\/([^/]+)\/far\.glb$/i
/** The species source (`res\nature\common\tree\w12\<id>.bsr#species`). */
const SPECIES_SOURCE = /[\\/]w12[\\/]([^\\/]+)\.bsr#species$/i

/** A species' id from its manifest model (`models/trees/<id>/far.glb`, else its `#species` source); null: not one. */
export function speciesIdOf(model: Pick<WorldModel, 'glb' | 'source'>): string | null {
  const g = model.glb ? SPECIES_GLB.exec(model.glb.replace(/\\/g, '/')) : null
  if (g) return g[2]!
  const s = SPECIES_SOURCE.exec(model.source)
  return s ? s[1]! : null
}

/** The LOD0 files of a species model (its `far.glb`'s folder: `near.glb`, `near.json`); null when it has none. */
export function nearFilesOf(model: Pick<WorldModel, 'glb'>): { glb: string; sidecar: string } | null {
  const g = model.glb?.replace(/\\/g, '/')
  if (!g || !/\/far\.glb$/i.test(g)) return null
  const dir = g.slice(0, g.length - 'far.glb'.length)
  return { glb: `${dir}near.glb`, sidecar: `${dir}near.json` }
}

/**
 * A placement's species matrix at `out[o]` (16 floats, Babylon's layout): the placement's T · R · S (S-SCALE, as
 * region-batch.ts `placementMatrixTo`) with the swap folded in (`foldSwap`: v ⊙ fit + offset, then the placement). Its
 * translation is the tree's root, the merged vertices' pivot (T12-M).
 */
export function swapMatrixTo(
  p: Pick<WorldPlacement, 'position' | 'rotation' | 'scale'>,
  fit: readonly number[],
  offset: readonly number[] | null | undefined,
  out: Float32Array,
  o: number,
  tmp: Matrix,
): void {
  const s = placementScale(p)
  Matrix.ComposeToRef(s === 1 ? Vector3.OneReadOnly : new Vector3(s, s, s), Quaternion.FromArray(p.rotation), Vector3.FromArray(p.position), tmp)
  tmp.copyToArray(out, o)
  foldSwap(out, o, fit, offset)
}

/**
 * The bounding sphere of a species drawn with matrix `m` (its manifest bounds through the matrix; radius = the half
 * diagonal × the largest axis scale), written to `out` as (x, y, z, r). The bands measure distance − radius (§W3.3).
 */
export function swapSphere(species: Pick<WorldModel, 'boundsMin' | 'boundsMax'>, m: ArrayLike<number>, out: Float32Array | number[]): void {
  const a = species.boundsMin, b = species.boundsMax
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, cz = (a[2] + b[2]) / 2
  out[0] = cx * m[0]! + cy * m[4]! + cz * m[8]! + m[12]!
  out[1] = cx * m[1]! + cy * m[5]! + cz * m[9]! + m[13]!
  out[2] = cx * m[2]! + cy * m[6]! + cz * m[10]! + m[14]!
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!), sy = Math.hypot(m[4]!, m[5]!, m[6]!), sz = Math.hypot(m[8]!, m[9]!, m[10]!)
  const half = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2
  out[3] = half * Math.max(sx, sy, sz)
}

// ---- the batch's tree side, duck-typed (T12-M's TreeBatch; BatchPart's interface does not name it) -----------------

/** The crown tints (T12-M's `TreeTints`): per species and base record, the tinted record (a table slot of its own). */
export interface TreeTintsLike {
  load(species: WorldModel): Promise<void>
  recordFor(species: WorldModel, record: MaterialBatchRecord, tint: number): MaterialBatchRecord
}

/** What the trees part uses of the batch's tree side (`World.batch.trees`, T12-M's TreeBatch). */
export interface TreeBatchLike {
  /** The swap of a retail model, or null (drawn as itself). The batch merges exactly these as species. */
  swapOf(model: WorldModel): TreeSwap | null
  /** The tree groups' materials (merge mode): their table, recipe and breeze. */
  readonly materials?: TreeMaterials | null
  /** The crown tints (with a swap only). */
  readonly tints?: TreeTintsLike | null
  /** H-12 TD-1: the placement's merged copy is unbanded (a material group): it never takes the LOD0 overlay. */
  unbanded?(key: number): boolean
}

/** The world's batch tree side (`world.batch.trees` with `swapOf`), or null (no batch, or a batch without the swap). */
export function treeBatchOf(world: unknown): TreeBatchLike | null {
  const t = (world as { batch?: { trees?: unknown } | null } | null | undefined)?.batch?.trees
  return t && typeof (t as TreeBatchLike).swapOf === 'function' ? (t as TreeBatchLike) : null
}

/** The material table of the batch's tree groups (merge mode), or null. */
export function treeTablesOf(batch: TreeBatchLike | null): BatchTables | null {
  return (batch?.materials as { tables?: BatchTables } | null | undefined)?.tables ?? null
}
