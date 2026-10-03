/**
 * Region batching seams (docs/BATCHING.md §3.1, §3.14, BT-0; docs/WAVE_PLAN6.md §4.1 step 1, D2–D9). Written by
 * W10-S; the batcher itself is BT-M's (`batch/index.ts`, `region-batch.ts`, the merge worker), the atlas and material
 * table BT-A's, the trees BT-T's. Nothing here draws: these are the contracts between them and the wave-9 code.
 *
 * - **The claim** (objects.ts `WorldObjects.setBatcher`): once a batcher is set, every static model a streamed region
 *   places is first offered to it (`claim`), after the retail-tuft filter (grass/types.ts RETAIL_TUFT_MODELS, D3); the
 *   placements it takes are never placed as thin-instance chunks. The region's listeners still hear `placed` for them,
 *   with **no meshes** (NL's light list and the ambient emitters come from placements), and then one `batched` event
 *   carrying the region's batch meshes, its shadow proxy and its material slots (the listener contract, F10).
 * - **The region's readiness** (region-chunk.ts): once every model of a region is placed, `commit` builds the batch;
 *   the region's `'objects'` event (and every `'objects'` commit step) waits for it.
 * - **Off = HEAD**: no batcher, no claim; chunks, clones and draws are exactly today's.
 * - **Wave 12 (W12-SA):** the tree swap source on `BatchHost` (TREES §W3.2, WF11): which retail models draw as a
 *   species; null = wave 10 byte for byte.
 */
import type { AbstractMesh, Scene, Vector3 } from '@babylonjs/core'
import type { WorldModel, WorldPlacement } from '../../../convert/src/world/manifest.ts'
import type { MaterialBatchRecord, ObjectMaterial, ObjectMaterials } from '../materials.ts'
import type { StaticPrep, WorldObjects } from '../objects.ts'
import type { CachedModel } from '../region-chunk.ts'
import type { RenderPath } from '../render/quality.ts'
import type { World } from '../world.ts'

/**
 * How the batcher treats one converted material (materials.ts `batchClass`, BATCHING §3.7): merged into the region's
 * groups, merged into the region's lamp group (NL's night emissive per slot, table texel 5), or left as its own draw.
 */
export type BatchClass = 'merge' | 'lamp' | 'separate'

/**
 * Mesh tags (`mesh.metadata.sroWorld`) the batcher never takes (BATCHING §3.6, WAVE_PLAN6 D7): GRASS_LIFE's ground
 * cover and wildlife, the coast's ocean, and (wave 11, W11-S, TOWN_LIFE §8.3) the town life's crowd, animals, puffs,
 * leaves and lantern strings.
 */
export const UNBATCHED_TAGS: readonly string[] = ['scatter', 'life', 'ocean', 'town']

/** The world tag of a mesh (`metadata.sroWorld`), or null. */
export function worldTagOf(mesh: { metadata?: unknown } | null | undefined): string | null {
  const tag = (mesh?.metadata as { sroWorld?: unknown } | null | undefined)?.sroWorld
  return typeof tag === 'string' ? tag : null
}

/** False for a mesh tagged 'scatter', 'life', 'ocean' or 'town' (UNBATCHED_TAGS): the batcher must refuse it. */
export function isBatchableMesh(mesh: { metadata?: unknown } | null | undefined): boolean {
  const tag = worldTagOf(mesh)
  return tag === null || !UNBATCHED_TAGS.includes(tag)
}

/** A streamed region as the batcher sees it (its owner key is the RegionChunk's, unique per load of the region). */
export interface BatchRegion {
  /** Owner key of the region's objects (RegionChunk.owner): what `removeRegion` names. */
  owner: number
  /** Region id ((z << 8) | x). */
  id: number
  x: number
  z: number
  /** The region's origin (glTF x, y, z of its south-west corner; WorldRegion.origin). */
  origin: readonly [number, number, number]
}

/** One model of a region as the claim offers it (WorldObjects.addStatic, before any chunk is placed). */
export interface BatchModelSource {
  /** The manifest model the placements name (listeners hear this one). */
  model: WorldModel
  /**
   * The model cache entry actually loaded for it: the same model, or the one `RegionBatcher.modelFor` asked for in its
   * place (BT-T's static tree variant). Holds the container, the converted materials with their batch records
   * (`converted.records`) and the geometry export (model-cache.ts `geometryOf`). null on the whole-world load.
   */
  entry: CachedModel | null
  /** The static preparation (source meshes with their converted materials, model-space matrices). */
  prep: StaticPrep
}

/** One material slot of a region batch (NL maps its lamp rows onto them, §3.10). */
export interface BatchSlot {
  /** The slot index in the material table (BT-A). */
  slot: number
  /** The placed model (manifest index and source: NL's lamp rule reads them). */
  model: WorldModel
  /** The converted material the slot was made from (its name and base emissive colour). */
  material: ObjectMaterial
  record: MaterialBatchRecord | null
  cls: BatchClass
}

/** A built region batch (BT-M), handed to the region listeners through `batched`. */
export interface RegionBatch {
  readonly owner: number
  /** Region id. */
  readonly region: number
  /** Every mesh the batch draws (merged groups, the lamp group): World.meshes(), the shelter map, the receivers. */
  readonly meshes: readonly AbstractMesh[]
  /** The region's opaque shadow proxy from the merge worker (positions only, SHADOW_PROXY_LAYER), or null. */
  readonly shadowProxy: AbstractMesh | null
  /** Shadow-only cut-out casters (BT-S), within the foliage range. */
  readonly cutoutCasters: readonly AbstractMesh[]
  readonly slots: readonly BatchSlot[]
  /** World bounds of everything the batch merged. */
  readonly min: Readonly<Vector3>
  readonly max: Readonly<Vector3>
  /**
   * Writes a slot's emissive (table texel 5, BATCHING §3.2): NL's night lamp colour × level, display-referred like
   * `emissiveColor` on a separate lamp material. A no-op once the batch is released.
   */
  setEmissive(slot: number, r: number, g: number, b: number): void
}

/** What a batch build may use of its region while it runs (region-chunk.ts binds it to the chunk). */
export interface BatchCommitContext {
  /** Queues a main-thread job at the region's priority inside the streamer's frame budget; skipped once unloaded. */
  schedule(run: () => void): void
  /** False once the region was unloaded (the build is dropped; `removeRegion` follows or came already). */
  alive(): boolean
}

/**
 * The batcher WorldObjects talks to (BT-M implements it; tests pass fakes). Every call happens on the main thread.
 * The PBR path only: World never sets one on the Classic path (the Low guard).
 */
export interface RegionBatcher {
  /**
   * The model to load in `model`'s place on this path (BT-T: a skinned foliage model's static variant,
   * `models[i].staticVariant`; DRAGON-INT: a remastered model's `models[i].remasterVariant`, remaster.ts); absent or the
   * same model: load it as today.
   */
  modelFor?(model: WorldModel): WorldModel
  /**
   * Offers one model's placements in a region (before `placeStatic`). Returns the placements it takes (all, some or
   * none); the rest are placed as today's chunks. Called at most once per (owner, model).
   */
  claim(owner: number, source: BatchModelSource, placements: readonly WorldPlacement[]): readonly WorldPlacement[]
  /**
   * Every model of the region has been offered: build its batch (a worker merge, then main-thread jobs through
   * `ctx.schedule`). Resolves with the batch once its meshes exist (the region's `'objects'` fires then), or null when
   * nothing was taken or the region went meanwhile. Called only for an owner with at least one claim.
   */
  commit(region: BatchRegion, ctx: BatchCommitContext): Promise<RegionBatch | null> | RegionBatch | null
  /**
   * The region is unloaded: its batch (meshes, slots, cells) goes, and a build still running is dropped (its `commit`
   * then resolves null). Idempotent: WorldObjects calls it again for a batch that lands after its region went.
   */
  removeRegion(owner: number): void
  /** WorldObjects.setRangeScale, forwarded live (Options' sight, the create screen's 0.6; F11). */
  setRangeScale(scale: number): void
  /** WorldObjects.setStaticVisible (the viewer's toggle). */
  setVisible?(on: boolean): void
  /** WorldObjects.setLod: false draws every batch mesh whatever its distance (the viewer's LOD toggle). */
  setLod?(on: boolean): void
  /** WorldObjects.update: the range tests, when the camera moved (or `force`). */
  update(cam: Vector3, force?: boolean): void
  /** Every mesh the batches draw. */
  meshes(): AbstractMesh[]
}

/** A worker as the batch part uses it (a Worker, or a test's in-process stand-in). */
export interface BatchWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((ev: { data: unknown }) => void) | null
  terminate(): void
}

/** Makes the merge worker (StreamHooks.batchWorker; default: the batch part makes its own). */
export type BatchWorkerFactory = () => BatchWorkerLike | null

/** BT-M's per-world batching part (World.batch): the region batcher plus its lifetime. */
export interface BatchPart extends RegionBatcher {
  /** Counters for the lab panel and the bench (regions, meshes, groups, slots, pages, triangles, …). */
  readonly stats: Readonly<Record<string, number>>
  /** Releases every region's batch (meshes, slots, cells): the path switch and the Advanced toggle (F12). */
  release(): void
  dispose(): void
}

// ---- wave 12: the tree swap (W12-SA; docs/TREES.md §W3.2, WF11, WF12; docs/WAVE_PLAN8.md §4.2 step 2, D3) ----------

/**
 * One retail model's swap to a species (the manifest's `WorldModel.treeSwap`, resolved): the species is a manifest model
 * the converter appended (its `far.glb`: LOD1 + LOD2), so the model cache, the material conversion and the atlas key on
 * it as on any model. T12-M's `modelFor` loads it in the retail model's place and folds `fit` into the placement matrix.
 */
export interface TreeSwap {
  /** The species' manifest model. */
  readonly species: WorldModel
  /** The retail envelope over the species' (x, y, z), folded into the placement matrix. */
  readonly fit: readonly [number, number, number]
  /** The crown tint slot (TREES §W3.4: an offset on the table decode's `uv2.y`). */
  readonly tint: number
}

/**
 * Where the batch learns which retail models draw as a species (`BatchHost.treeSwap`). null (or absent) = wave-10
 * behaviour byte for byte: no model is redirected. World hands one over on the PBR path with trees 'new' when the
 * manifest carries at least one valid `treeSwap` (treeSwapSourceOf); 'retail' and Classic never do.
 */
export interface TreeSwapSource {
  /** The swap of a retail model, or null (drawn as itself). */
  swapOf(model: WorldModel): TreeSwap | null
  /** Retail models swapped. */
  readonly count: number
}

/** True for a finite number > 0. */
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * The swap source of a manifest's models (`WorldModel.treeSwap`, written by the converter's tree-swap step), or null
 * when no model carries a usable one. A swap is used only when its species is another, loadable static model, its fit
 * three positive numbers and its tint a non-negative integer (else that retail model draws as itself).
 */
export function treeSwapSourceOf(models: readonly WorldModel[]): TreeSwapSource | null {
  const swaps = new Map<number, TreeSwap>()
  for (const m of models) {
    const t = m.treeSwap
    if (!t) continue
    const species = models[t.model]
    if (!species || species.index !== t.model || t.model === m.index || species.kind !== 'static' || !species.glb) continue
    const fit = t.fit
    if (!Array.isArray(fit) || fit.length !== 3 || !fit.every(positive)) continue
    const tint = t.tint ?? 0
    if (!Number.isInteger(tint) || tint < 0) continue
    swaps.set(m.index, { species, fit: [fit[0]!, fit[1]!, fit[2]!], tint })
  }
  if (!swaps.size) return null
  return {
    count: swaps.size,
    swapOf: model => swaps.get(model.index) ?? null,
  }
}

/** What the batching part is built from (World passes itself; the streamer's worker handle when a test gives one). */
export interface BatchHost {
  /** The world (its render quality, the streamer, the manifest; the fields below are the parts it uses most). */
  readonly world: World
  readonly scene: Scene
  readonly objects: WorldObjects
  readonly materials: ObjectMaterials
  /** The material path (the part is made on 'pbr' only). */
  readonly path: RenderPath
  /** The world's manifest models (static variants, bounds). */
  readonly models: readonly WorldModel[]
  /** The merge worker (null: the part makes its own). */
  readonly worker: BatchWorkerFactory | null
  /**
   * W12-SA (TREES §W3.2): the tree swap (null or absent: none, wave 10 byte for byte). Set by World on the PBR path with
   * trees 'new' (World.setTreeMode rebuilds the part around a change); T12-M's `modelFor` reads it.
   */
  readonly treeSwap?: TreeSwapSource | null
}

/** Makes the batching part (batch/index.ts `createBatchPart`; LoadWorldOptions.parts.batch in tests). null: none. */
export type BatchFactory = (host: BatchHost) => BatchPart | null
