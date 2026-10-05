import {
  LoadAssetContainerAsync,
  Matrix,
  Quaternion,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type AnimationGroup,
  type AssetContainer,
  type InstantiatedEntries,
  type Mesh,
  type Scene,
} from '@babylonjs/core'
import { GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader.js'
import '@babylonjs/loaders/glTF/2.0/index.js'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { errorText, mapLimit, type Assets } from './assets.ts'
import { AmbientFx, type AmbientOptions, type AmbientPlay } from './ambient-fx.ts'
import { isBatchableMesh, type BatchCommitContext, type BatchRegion, type RegionBatch, type RegionBatcher } from './batch/types.ts'
import type { ObjectMaterials, SidecarLite } from './materials.ts'
import type { CachedModel } from './region-chunk.ts'
import { installMeshoptDecoder } from './meshopt.ts'
import { isFoliageModel } from './pbr/classes.ts'
import { placementScale } from './placement-scale.ts'

/** TERRAIN.md 6.3 draw ranges in metres (2020 / 480 units), tested as distance - radius < range. */
export const GROUP_RANGE_M: Record<number, number> = { 2: 202, 3: 48 }
/** Static placements are batched into thin-instance chunks per LOD group of this size (m) for draw-distance culling. */
const CHUNK_M: Record<number, number> = { 2: 192, 3: 96 }
/** Animated objects further than this (m, x the range scale) keep their pose but stop animating. */
export const ANIMATE_RANGE_M = 80
/**
 * Layer-mask bit of every world object mesh (docs/FIELDS.md §3.5): the world sun lights only meshes carrying it and
 * the caller's character lights skip them (World.isolateLights). It lies outside Babylon's default mesh and camera
 * mask 0x0FFFFFFF, so no other mesh carries it, while the object meshes keep the default bits and stay drawn.
 */
export const WORLD_OBJECT_LAYER = 0x10000000

/** Owner of the chunks and clones of the whole-world load (not a region id: those are 0..0x7FFF). */
const NO_REGION = -1

/**
 * The manifest models that block movement: every model drawn by a placement whose object (object.ifo id) has a nav
 * footprint, i.e. some nav object instance carries that id (docs/NAVIGATION.md §4.1). By object rather than by
 * instance: retail bakes some placements' footprints into the terrain's closed cells instead of an instance (21 Jangan
 * trees whose models have instances elsewhere).
 */
export function blockingModelsOf(placements: readonly Pick<WorldPlacement, 'objId' | 'models'>[], instances: Iterable<{ objId: number }>): Set<number> {
  const ids = new Set<number>()
  for (const i of instances) ids.add(i.objId)
  const out = new Set<number>()
  for (const p of placements) if (ids.has(p.objId)) for (const m of p.models) out.add(m)
  return out
}

/**
 * What a model draws while animated objects are hidden (Low: QUALITY_PRESETS.low.animated is false) and no batcher
 * stands in for it: a static model itself; a skinned model that blocks movement (`blockingModelsOf`) its static
 * variant (`WorldModel.staticVariant`: the retail mesh at frame 0 of its default clip, skin removed; BATCHING §3.5) or,
 * without one, itself (its clone stays drawn, still); any other skinned model nothing (hidden, as before). null: not
 * drawn. A blocking object is never invisible on Low: 17 skinned retail tree models and the old ferry boat were.
 */
export function lowModelOf(model: WorldModel, models: readonly WorldModel[], blocks: boolean): WorldModel | null {
  if (!model.glb || model.kind === 'failed') return null
  if (model.kind !== 'skinned') return model
  if (!blocks) return null
  const i = model.staticVariant
  const v = i === undefined || i === null || i === model.index ? undefined : models[i]
  return v && v.index === i && v.kind === 'static' && v.glb ? v : model
}

interface Chunk {
  group: number
  meshes: Mesh[]
  center: Vector3
  radius: number
  instances: number
  region: number
}

interface Clone {
  group: number
  root: TransformNode
  entries: InstantiatedEntries
  anim: AnimationGroup | null
  center: Vector3
  radius: number
  enabled: boolean
  animating: boolean
  region: number
  meshes: number
  /** W12-SA: the placement and the manifest model it draws (a region reload keeps an unchanged clone: adoptClones). */
  placement: WorldPlacement
  model: WorldModel
  /** Its model blocks movement (`WorldObjects.setBlocking`): drawn (still) even while animated objects are hidden. */
  blocks: boolean
}

export interface ObjectStats {
  models: number
  failed: number
  chunks: number
  thinInstances: number
  instanceMeshes: number
  clones: number
  cloneMeshes: number
}

/** What a region listener is told about each placed model (docs/WAVE_PLAN3.md §4.1). */
export interface PlacedModelInfo {
  /** Manifest model index. */
  index: number
  /** Retail source path (WorldModel.source, backslashes). */
  source: string
  /** The model's bounding-box height (m, WorldModel boundsMax − boundsMin). */
  heightM: number
  /** A tree, grass, flower or reed model (pbr/classes.ts isFoliageModel). */
  isFoliage: boolean
  kind: 'static' | 'clone'
}

/**
 * Told about every placement batch and every region removal (the generalised `setAmbient`; NL's light list, RND-L's
 * shadow casters, WX-R's shelter refresh). `region` is the owner key (a streamed chunk's `owner`, or -1 for the
 * whole-world load); `meshes` are the meshes this batch added (thin-instance chunk meshes or a clone's meshes).
 *
 * W10-S, the region-batching contract (docs/BATCHING.md §3.1, F10): placements the region batcher took are still told
 * through `placed`, with **`meshes = []`** (a batch mesh never comes through `placed`); once the region's batch is
 * built, `batched` carries its meshes, its shadow proxy and its material slots. Both are replayed to a late listener.
 */
export interface RegionListener {
  placed(region: number, model: WorldModel, info: PlacedModelInfo, meshes: readonly AbstractMesh[], placements: readonly WorldPlacement[]): void
  removed(region: number): void
  /** The region's batch is ready (W10-S; never on the Classic path, never with batching off). */
  batched?(region: number, batch: RegionBatch): void
}

/** Skinned-clone animation speed ramps to a new target over this long (ms): loops never jump. */
const SPEED_RAMP_MS = 2000

interface PlacedEntry {
  region: number
  model: WorldModel
  kind: 'static' | 'clone'
  meshes: AbstractMesh[]
  placements: readonly WorldPlacement[]
}

/** A static model container ready for thin-instance chunks: its geometry meshes and their model-space matrices. */
export interface StaticPrep {
  geometry: Mesh[]
  locals: Matrix[]
}

const prepared = new WeakMap<AssetContainer, StaticPrep>()

/**
 * Prepares a static model container for thin-instance chunks (once per container): adds it to the scene, computes
 * each geometry mesh's model-space matrix and hides the source meshes (chunks draw clones of them).
 */
export function prepareStatic(container: AssetContainer): StaticPrep {
  let prep = prepared.get(container)
  if (prep) return prep
  container.addAllToScene()
  const geometry = container.meshes.filter((m): m is Mesh => m.getTotalVertices() > 0 && 'thinInstanceSetBuffer' in m)
  for (const root of container.rootNodes) {
    if (root instanceof TransformNode) root.computeWorldMatrix(true)
    for (const n of root.getDescendants(false)) if (n instanceof TransformNode) n.computeWorldMatrix(true)
  }
  const locals = geometry.map(m => m.computeWorldMatrix(true).clone())
  for (const src of geometry) src.setEnabled(false)
  prep = { geometry, locals }
  prepared.set(container, prep)
  return prep
}

/**
 * Loads a glb container with the options every world/actor load uses (animations stopped, raw texture values).
 * Works for both asset layouts: the slimmed tree's meshopt/quantized/WebP glbs decode with the local decoder.
 */
export async function loadGlb(scene: Scene, assets: Assets, rel: string, opts?: { srgb?: boolean }): Promise<AssetContainer> {
  installMeshoptDecoder()
  const bytes = await assets.bytesOf(rel)
  return LoadAssetContainerAsync(bytes, scene, {
    pluginExtension: '.glb',
    name: rel,
    pluginOptions: {
      gltf: {
        animationStartMode: GLTFLoaderAnimationStartMode.NONE,
        // Raw texture values: the fixed-function StandardMaterial setup does no linear/sRGB round trip. Wave 9: the
        // PBR path may pass srgb: true (sRGB albedo decoded by the GPU).
        useSRGBBuffers: opts?.srgb ?? false,
      },
    },
  })
}

/** A placement's world matrix: T(position) R(rotation) S(scale) (W12-SA S-SCALE: the uniform scale, 1 when absent). */
function placementMatrix(p: WorldPlacement): Matrix {
  const s = placementScale(p)
  return Matrix.Compose(s === 1 ? Vector3.One() : new Vector3(s, s, s), Quaternion.FromArray(p.rotation), Vector3.FromArray(p.position))
}

/**
 * W12-SA (S-OBJ, docs/WORLD_EDITOR.md §2.3): the placements the World Editor draws itself while they are edited
 * (`WorldObjects.setEditorOwned`): left out of their region's chunks, clones and batch.
 */
export type EditorOwned = (placement: WorldPlacement, model: WorldModel) => boolean

/** One skinned clone's disposal against removeRegion's per-job budget (a chunk counts 1; REMOVE_PER_JOB 32: 2 clones). */
export const CLONE_REMOVE_WEIGHT = 16

/**
 * World objects (docs/TERRAIN.md 6, 8.4). Each model glb is loaded once. Static models become thin instances
 * (one matrix per placement: mesh-in-model matrix x placement T(position) R(+yaw about +Y)), batched per LOD group and
 * 192 m (group 2) / 96 m (group 3) chunk. Skinned models get one instantiateModelsToScene clone per placement with
 * the default clip looping from a random phase.
 *
 * Two ways in: load() places the whole manifest at once (containers owned here); region streaming adds and removes
 * one region at a time (addStatic / addClone / removeRegion) with containers owned by the model cache. Region chunks
 * are keyed region | group | sub: group 2 is one chunk per region and model, group 3 four 96 m sub-chunks.
 *
 * Wave 12 (W12-SA; docs/WORLD_EDITOR.md F6, §2.3; docs/WAVE_PLAN8.md §4.2 steps 3, 4): a placement's optional uniform
 * `scale` enters every matrix (S-SCALE; absent = 1: byte for byte), the World Editor's placements stay out of their
 * region while it edits them (`setEditorOwned`, S-OBJ), and a region reload's new set stays hidden until it swaps in
 * (`stageRegion` / `showRegion`, region-chunk.ts).
 */
export class WorldObjects {
  private readonly chunks: Chunk[] = []
  private readonly clones: Clone[] = []
  private readonly containers: AssetContainer[] = []
  readonly errors: string[] = []
  stats: ObjectStats = { models: 0, failed: 0, chunks: 0, thinInstances: 0, instanceMeshes: 0, clones: 0, cloneMeshes: 0 }
  private showStatic = true
  private showAnimated = true
  private lod = true
  private rangeScale = 1
  private disposed = false
  /** Bumped by every enableAmbient call: a load that finishes after a newer call is dropped. */
  private ambientGen = 0
  /** World ambient effects (ambient-fx.ts, EFFECTS §3.15): told about every placement; null = none. */
  private ambient: AmbientFx | null = null
  /** Placements by owner, replayed to an ambient pool or a region listener attached later. */
  private readonly placed: PlacedEntry[] = []
  private readonly listeners: RegionListener[] = []
  /** Skinned-clone animation speed (setAnimationSpeed): ramp from `from` to `to` starting at `t0` (ms). */
  private speed = { from: 1, to: 1, t0: 0, now: 1 }
  /** W10-S: the region batcher (null: none, today's chunks; BATCHING BT-0). */
  private batcherValue: RegionBatcher | null = null
  /** W10-S: owners with at least one claimed placement, and their built batches. */
  private readonly claimed = new Set<number>()
  private readonly batches = new Map<number, RegionBatch>()
  /** W10-S: models that are never placed (GRASS_LIFE §1.3: the retail tufts under the new grass, D3). */
  private hiddenModel: ((model: WorldModel) => boolean) | null = null
  /** W12-SA (S-OBJ): the placements the World Editor draws itself (null: none). */
  private editorOwnedValue: EditorOwned | null = null
  /** W12-SA (S-OBJ): owners whose chunks and clones stay hidden until `showRegion` (a region reload's new set). */
  private readonly staged = new Set<number>()
  /** The models that block movement and the manifest's model list (setBlocking; null: none block). */
  private blocking: ((model: WorldModel) => boolean) | null = null
  private blockingModels: readonly WorldModel[] = []

  constructor(readonly scene: Scene, readonly assets: Assets, readonly materials: ObjectMaterials) {}

  /** Attaches the ambient-effect pool (the placements made so far join it at once). */
  setAmbient(ambient: AmbientFx | null): void {
    this.ambient = ambient
    if (ambient) for (const e of this.placed) ambient.add(e.region, e.model.index, e.placements)
  }

  /**
   * Adds a region listener (docs/WAVE_PLAN3.md §4.1): it is told about the placements made so far at once, then about
   * every later one and every region removal. Returns a remover. A listener that throws is logged.
   */
  addRegionListener(listener: RegionListener): () => void {
    this.listeners.push(listener)
    for (const e of this.placed) this.tell(listener, e)
    for (const [owner, batch] of this.batches) this.tellBatched(listener, owner, batch)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  private tell(l: RegionListener, e: PlacedEntry): void {
    const m = e.model
    const info: PlacedModelInfo = {
      index: m.index,
      source: m.source,
      heightM: (m.boundsMax[1] ?? 0) - (m.boundsMin[1] ?? 0),
      isFoliage: isFoliageModel(m.source),
      kind: e.kind,
    }
    try {
      l.placed(e.region, m, info, e.meshes, e.placements)
    } catch (err) {
      console.warn('[world] region listener failed', err)
    }
  }

  private tellBatched(l: RegionListener, owner: number, batch: RegionBatch): void {
    if (!l.batched) return
    try {
      l.batched(owner, batch)
    } catch (err) {
      console.warn('[world] region listener failed', err)
    }
  }

  // ---- W10-S: the region claim (docs/BATCHING.md §3.1, BT-0; docs/WAVE_PLAN6.md D3) -------------------------------

  /**
   * Sets the region batcher (World on the PBR path when batching is on; null = today's chunks). Only regions placed
   * afterwards are claimed: World releases the old one's batches and rebuilds the streamer around a change (F12).
   */
  setBatcher(batcher: RegionBatcher | null): void {
    if (batcher === this.batcherValue) return
    this.batcherValue = batcher
    this.claimed.clear()
    this.batches.clear()
    if (batcher) {
      batcher.setRangeScale(this.rangeScale)
      batcher.setVisible?.(this.showStatic)
      batcher.setLod?.(this.lod)
    }
  }

  get batcher(): RegionBatcher | null {
    return this.batcherValue
  }

  /** The built region batches by owner (read-only). */
  get regionBatches(): ReadonlyMap<number, RegionBatch> {
    return this.batches
  }

  /**
   * Models that must not be placed (null: none): the retail-tuft filter (grass/types.ts RETAIL_TUFT_MODELS), applied
   * before the batcher sees a region; streamed regions do not even load them. A change applies to regions placed
   * afterwards (World rebuilds the streamer).
   */
  setHiddenModels(hidden: ((model: WorldModel) => boolean) | null): void {
    this.hiddenModel = hidden
  }

  /** Whether `model` is filtered out (setHiddenModels). */
  isHidden(model: WorldModel): boolean {
    return !!this.hiddenModel?.(model)
  }

  /**
   * The models that block movement (World: `blockingModelsOf` over its nav) and the manifest's models (their static
   * variants): while animated objects are hidden, a blocking skinned model still draws (`lowModelOf`). Like
   * setHiddenModels it applies to placements placed afterwards; set it before any region places (World does).
   */
  setBlocking(blocks: ((model: WorldModel) => boolean) | null, models: readonly WorldModel[] = []): void {
    this.blocking = blocks
    this.blockingModels = models
  }

  /** Whether `model` blocks movement (setBlocking). */
  blocks(model: WorldModel): boolean {
    return !!this.blocking?.(model)
  }

  // ---- W12-SA: S-OBJ (docs/WORLD_EDITOR.md §2.3, §9.3 item 1; docs/WAVE_PLAN8.md §4.2 step 4) -----------------------

  /**
   * The placements the World Editor draws itself while they are edited (`pred` true: an "editor-owned" placement), or
   * null: none. A streamed region places them nowhere (no chunk, no clone, no batch claim, no listener event); the
   * editor draws its own copy (a clone of the cached model, or `World.trees.preview` for a swapped tree). Like
   * setHiddenModels it applies to placements placed afterwards: `RegionStreamer.reloadObjects(rx, rz)` re-places a
   * resident region (one region re-batched, swapped in at once). The whole-world load is not filtered.
   */
  setEditorOwned(pred: EditorOwned | null): void {
    this.editorOwnedValue = pred
  }

  get editorOwned(): EditorOwned | null {
    return this.editorOwnedValue
  }

  /** Whether the editor owns a placement now (setEditorOwned; a predicate that throws owns nothing). */
  isEditorOwned(p: WorldPlacement, model: WorldModel): boolean {
    const f = this.editorOwnedValue
    if (!f) return false
    try {
      return f(p, model)
    } catch (err) {
      console.warn('[world] editor-owned predicate failed', err)
      return false
    }
  }

  /**
   * A region reload's new owner (region-chunk.ts): its chunks and clones stay hidden from now on until showRegion, so
   * the old set and the new one never draw together. (Its batch shows when built; the reload removes the old owner in
   * the same turn.) The listeners hear its placements as usual.
   */
  stageRegion(owner: number): void {
    this.staged.add(owner)
  }

  /** W12-SA: the placements `owner` draws as animated clones (a region reload keeps the unchanged ones: adoptClones). */
  clonePlacements(owner: number): Set<WorldPlacement> {
    const out = new Set<WorldPlacement>()
    for (const c of this.clones) if (c.region === owner) out.add(c.placement)
    return out
  }

  /**
   * W12-SA (S-OBJ): a region reload keeps its unchanged animated clones (no new instance, no clip restarting): every
   * clone of `from` whose placement `keep` accepts moves to `to` as it is (drawn, animating, its phase kept), and the
   * listeners hear it placed under `to`. The reload's swap calls it just before `from` is removed. Returns how many moved.
   */
  adoptClones(from: number, to: number, keep: (p: WorldPlacement, model: WorldModel) => boolean): number {
    let n = 0
    for (const c of this.clones) {
      if (c.region !== from || !keep(c.placement, c.model)) continue
      c.region = to
      n++
      this.notePlaced(to, c.model, [c.placement], 'clone', c.root.getChildMeshes(false))
    }
    return n
  }

  /** Shows a staged owner's chunks and clones (within their ranges, as always). */
  showRegion(owner: number): void {
    if (!this.staged.delete(owner)) return
    const cam = this.camOrZero()
    for (const c of this.chunks) if (c.region === owner) this.applyChunk(c, cam)
    for (const c of this.clones) if (c.region === owner) this.applyClone(c, cam)
  }

  /**
   * The model a region loads for `model`: the batcher's stand-in (a static tree variant) when it names a loadable one;
   * else, while animated objects are hidden (Low), a blocking skinned model's static variant (`lowModelOf`), so the
   * tree is drawn as cheap thin instances instead of a hidden clone. Decided when the region places: a later
   * setAnimatedVisible keeps it until the regions are placed again (both ways stay drawn).
   */
  modelToLoad(model: WorldModel): WorldModel {
    const use = this.batcherValue?.modelFor?.(model)
    if (use && use.glb && use.kind !== 'failed') return use
    if (!this.showAnimated && model.kind === 'skinned') return lowModelOf(model, this.blockingModels, this.blocks(model)) ?? model
    return model
  }

  /**
   * Offers a region's static placements of a model to the batcher (before any chunk): the placements it takes are
   * told to the listeners with no meshes, the rest come back to be placed as chunks. A model whose meshes are tagged
   * 'scatter', 'life' or 'ocean' is never offered.
   */
  private claim(region: number, model: WorldModel, prep: StaticPrep, placements: readonly WorldPlacement[], entry: CachedModel | null): readonly WorldPlacement[] {
    const b = this.batcherValue
    if (!b || region === NO_REGION || !prep.geometry.length || !prep.geometry.every(isBatchableMesh)) return placements
    let taken: readonly WorldPlacement[]
    try {
      taken = b.claim(region, { model, entry, prep }, placements)
    } catch (err) {
      console.warn('[world] batch claim failed', err)
      return placements
    }
    if (!taken.length) return placements
    this.claimed.add(region)
    this.notePlaced(region, model, taken, 'static', [])
    if (taken.length >= placements.length) return []
    const took = new Set(taken)
    return placements.filter(p => !took.has(p))
  }

  /**
   * Every model of a streamed region is placed (region-chunk.ts): when the batcher claimed any of it, it builds the
   * region's batch and the listeners hear `batched` once it is ready. null when nothing was claimed (the region is
   * ready at once, as before); the promise never rejects.
   */
  commitRegion(region: BatchRegion, ctx: BatchCommitContext): Promise<void> | null {
    const b = this.batcherValue
    const owner = region.owner
    if (!b || !this.claimed.has(owner) || this.disposed) return null
    let built: Promise<RegionBatch | null>
    try {
      built = Promise.resolve(b.commit(region, ctx))
    } catch (err) {
      built = Promise.reject(err)
    }
    return built.then(batch => {
      if (!batch) return
      if (this.disposed || this.batcherValue !== b || !this.claimed.has(owner) || !ctx.alive()) {
        // The region (or the batcher) went while the batch built: it must not stay drawn.
        try {
          b.removeRegion(owner)
        } catch (err) {
          console.warn('[world] batch removal failed', err)
        }
        return
      }
      this.batches.set(owner, batch)
      for (const l of this.listeners) this.tellBatched(l, owner, batch)
    }, err => {
      console.warn('[world] region batch failed', err)
    })
  }

  /**
   * Skinned-clone animation speed (WX-R: `0.8 + 1.4 × wind`, docs/WEATHER.md §6.7): every clone's AnimationGroup
   * speedRatio ramps to `ratio` over 2 s (World.update calls tickAnimationSpeed every frame). Clones placed later start
   * at the current speed.
   */
  setAnimationSpeed(ratio: number, nowMs = performance.now()): void {
    const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
    if (r === this.speed.to) return
    this.speed = { from: this.speed.now, to: r, t0: nowMs, now: this.speed.now }
  }

  /** Advances the animation-speed ramp (nothing to do at a steady speed). */
  tickAnimationSpeed(nowMs = performance.now()): void {
    const s = this.speed
    if (s.now === s.to) return
    const k = Math.min(1, Math.max(0, (nowMs - s.t0) / SPEED_RAMP_MS))
    s.now = k >= 1 ? s.to : s.from + (s.to - s.from) * k
    for (const c of this.clones) if (c.anim) c.anim.speedRatio = s.now
  }

  /** The current skinned-clone animation speed ratio. */
  get animationSpeed(): number {
    return this.speed.now
  }

  /**
   * Turns the world ambient effects on (EFFECTS §3.15): reads the world's ambient.json and plays through `play`
   * (the app's effect engine); the app calls `ambientFx.update(focus)` each frame. null turns them off.
   */
  async enableAmbient(play: AmbientPlay | null, opts?: AmbientOptions): Promise<AmbientFx | null> {
    // Last call wins: a disable (or another enable) made while ambient.json loads supersedes this one.
    const gen = ++this.ambientGen
    if (!play) {
      this.ambient?.dispose()
      this.ambient = null
      return null
    }
    const fx = new AmbientFx(opts)
    await fx.load(this.assets)
    if (this.disposed || gen !== this.ambientGen) {
      fx.dispose()
      return null
    }
    fx.setPlayer(play)
    this.ambient?.dispose()
    this.setAmbient(fx)
    return fx
  }

  /** The ambient pool (null while off). */
  get ambientFx(): AmbientFx | null {
    return this.ambient
  }

  private notePlaced(region: number, model: WorldModel, placements: readonly WorldPlacement[], kind: 'static' | 'clone', meshes: AbstractMesh[]): void {
    const e: PlacedEntry = { region, model, kind, meshes, placements }
    this.placed.push(e)
    this.ambient?.add(region, model.index, placements)
    for (const l of this.listeners) this.tell(l, e)
  }

  async load(models: WorldModel[], placements: WorldPlacement[], opts: { animated: boolean; lightmaps: boolean }, onProgress: (done: number, total: number) => void): Promise<void> {
    const byModel = new Map<number, WorldPlacement[]>()
    for (const p of placements) {
      for (const mi of p.models) {
        const list = byModel.get(mi)
        if (list) list.push(p)
        else byModel.set(mi, [p])
      }
    }
    const used = [...byModel.keys()].map(i => models[i]!).filter(m => m.glb && m.kind !== 'failed')
    // Each model loads what modelToLoad names (Low: a blocking skinned model's static variant).
    const todo = used.filter(m => (opts.animated || this.modelToLoad(m).kind === 'static') && !this.isHidden(m))
    let done = 0
    await mapLimit(todo, 6, async model => {
      if (this.disposed) return
      const use = this.modelToLoad(model)
      try {
        const [container, sidecar] = await Promise.all([
          loadGlb(this.scene, this.assets, use.glb!),
          use.sidecar ? this.assets.json<SidecarLite>(use.sidecar).catch(() => null) : Promise.resolve(null),
        ])
        if (this.disposed) {
          container.dispose()
          return
        }
        const kind = use.kind === 'skinned' ? 'clone' : 'static'
        await this.materials.convert(container, sidecar, opts.lightmaps, { model: use.glb!, source: use.source, kind, ...(use.cloth ? { cloth: use.cloth } : {}) })
        this.containers.push(container)
        const list = byModel.get(model.index)!
        const meshes: AbstractMesh[] = []
        if (use.kind === 'skinned') for (const p of list) meshes.push(...this.placeClone(model, container, p, NO_REGION).root.getChildMeshes(false))
        else {
          const chunks = this.placeStatic(prepareStatic(container), list, NO_REGION, p => {
            const size = CHUNK_M[p.group] ?? 192
            return `${p.group}|${Math.floor(p.position[0] / size)}|${Math.floor(p.position[2] / size)}`
          }, `m${model.index}`)
          for (const c of chunks) meshes.push(...c.meshes)
        }
        this.notePlaced(NO_REGION, model, list, kind, meshes)
        this.stats.models++
      } catch (err) {
        this.stats.failed++
        this.errors.push(`${model.glb}: ${errorText(err)}`)
        console.warn('[world] model', model.glb, err)
      }
      onProgress(++done, todo.length)
    })
    this.stats.chunks = this.chunks.length
    this.update(this.scene.activeCamera?.globalPosition ?? Vector3.Zero(), true)
  }

  /**
   * Region streaming: a static model's thin-instance chunks for one region's placements of it. `origin` is the
   * region's south-west corner (glTF x, z), for the 96 m sub-chunks of group 3.
   */
  addStatic(region: number, origin: readonly [number, number], model: WorldModel, prep: StaticPrep, placements: readonly WorldPlacement[], entry: CachedModel | null = null): void {
    if (this.disposed || !placements.length || this.isHidden(model)) return
    // W12-SA (S-OBJ): the editor's placements stay out of the region (its chunks and its batch).
    if (this.editorOwnedValue && region !== NO_REGION) {
      placements = placements.filter(p => !this.isEditorOwned(p, model))
      if (!placements.length) return
    }
    // W10-S: the batcher claims first (none set: every placement is placed as today).
    placements = this.claim(region, model, prep, placements, entry)
    if (!placements.length) return
    const added = this.placeStatic(prep, placements, region, p => {
      if (p.group !== 3) return `${region}|${p.group}|0`
      const sx = Math.min(1, Math.max(0, Math.floor((p.position[0] - origin[0]) / 96)))
      const sz = Math.min(1, Math.max(0, Math.floor((origin[1] - p.position[2]) / 96)))
      return `${region}|${p.group}|${sz * 2 + sx}`
    }, `m${model.index}`)
    this.stats.chunks = this.chunks.length
    for (const c of added) this.applyChunk(c)
    this.notePlaced(region, model, placements, 'static', added.flatMap(c => c.meshes))
  }

  /** Region streaming: one animated clone of a skinned model (one streaming job each). */
  addClone(region: number, model: WorldModel, container: AssetContainer, p: WorldPlacement): void {
    if (this.disposed || this.isHidden(model)) return
    if (region !== NO_REGION && this.isEditorOwned(p, model)) return
    const clone = this.placeClone(model, container, p, region)
    this.applyClone(clone)
    this.notePlaced(region, model, [p], 'clone', clone.root.getChildMeshes(false))
  }

  /**
   * Region streaming: disposes the chunks and clones a region owns, at most `max` of them per call (the streamer
   * spreads a big region over several frames). Returns how many it still owns. The model containers stay (see
   * model-cache.ts). `region` is the owner key given to addStatic/addClone.
   */
  removeRegion(region: number, max = Infinity): number {
    this.staged.delete(region)
    this.ambient?.removeRegion(region)
    let had = false
    for (let i = this.placed.length - 1; i >= 0; i--) {
      if (this.placed[i]!.region !== region) continue
      this.placed.splice(i, 1)
      had = true
    }
    if (had) {
      for (const l of this.listeners) {
        try {
          l.removed(region)
        } catch (err) {
          console.warn('[world] region listener failed', err)
        }
      }
    }
    // W10-S: the region's batch goes with it (a build still running is dropped by the batcher).
    const claimed = this.claimed.delete(region)
    if (this.batches.delete(region) || claimed) {
      try {
        this.batcherValue?.removeRegion(region)
      } catch (err) {
        console.warn('[world] batch removal failed', err)
      }
    }
    let removed = 0
    let left = 0
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i]!
      if (c.region !== region) continue
      if (removed >= max) {
        left++
        continue
      }
      this.chunks.splice(i, 1)
      for (const m of c.meshes) m.dispose(false, false)
      this.stats.thinInstances -= c.instances * c.meshes.length
      this.stats.instanceMeshes -= c.meshes.length
      removed++
    }
    // H-12 HI-2: a skinned clone costs ~1-2 ms to dispose (its skeleton, animation groups, meshes), so it counts
    // CLONE_REMOVE_WEIGHT against the job's budget; the ones left wait for the next job, stopped and hidden now
    for (let i = this.clones.length - 1; i >= 0; i--) {
      const c = this.clones[i]!
      if (c.region !== region) continue
      if (removed > 0 && removed + CLONE_REMOVE_WEIGHT > max) {
        left++
        c.anim?.stop()
        if (c.root.isEnabled()) c.root.setEnabled(false)
        continue
      }
      this.clones.splice(i, 1)
      c.anim?.stop()
      c.entries.dispose()
      c.root.dispose(false, false)
      this.stats.clones--
      this.stats.cloneMeshes -= c.meshes
      removed += CLONE_REMOVE_WEIGHT
    }
    this.stats.chunks = this.chunks.length
    return left
  }

  /** Owners (streamed regions) holding at least one chunk or clone. */
  regionCount(): number {
    const set = new Set<number>()
    for (const c of this.chunks) if (c.region !== NO_REGION) set.add(c.region)
    for (const c of this.clones) if (c.region !== NO_REGION) set.add(c.region)
    for (const owner of this.batches.keys()) set.add(owner)
    return set.size
  }

  private placeStatic(prep: StaticPrep, list: readonly WorldPlacement[], region: number, keyOf: (p: WorldPlacement) => string, tag: string): Chunk[] {
    const { geometry, locals } = prep
    const groups = new Map<string, WorldPlacement[]>()
    for (const p of list) {
      const key = keyOf(p)
      const g = groups.get(key)
      if (g) g.push(p)
      else groups.set(key, [p])
    }
    const added: Chunk[] = []
    for (const [key, ps] of groups) {
      const mats = ps.map(placementMatrix)
      const chunk: Chunk = { group: ps[0]!.group, meshes: [], center: Vector3.Zero(), radius: 0, instances: ps.length, region }
      const min = new Vector3(Infinity, Infinity, Infinity)
      const max = new Vector3(-Infinity, -Infinity, -Infinity)
      geometry.forEach((src, gi) => {
        const mesh = src.clone(`${src.name}@${tag}|${key}`, null, true)
        // Clones share one Geometry, and thin-instance matrix buffers live on the geometry: without
        // this every chunk of a model drew with the LAST chunk's buffer (WebGPU rejected the frame:
        // "instance range requires a larger buffer"; WebGL silently drew wrong/missing instances).
        mesh.makeGeometryUnique()
        mesh.position.setAll(0)
        mesh.rotationQuaternion = Quaternion.Identity()
        mesh.scaling.setAll(1)
        mesh.sideOrientation = src.sideOrientation
        mesh.isPickable = false
        mesh.metadata = { sroWorld: 'object' }
        mesh.layerMask |= WORLD_OBJECT_LAYER
        const buf = new Float32Array(16 * mats.length)
        mats.forEach((pm, i) => locals[gi]!.multiplyToArray(pm, buf, 16 * i))
        mesh.thinInstanceSetBuffer('matrix', buf, 16, true)
        mesh.thinInstanceRefreshBoundingInfo(false)
        mesh.freezeWorldMatrix()
        mesh.doNotSyncBoundingInfo = true
        const bb = mesh.getBoundingInfo().boundingBox
        min.minimizeInPlace(bb.minimumWorld)
        max.maximizeInPlace(bb.maximumWorld)
        chunk.meshes.push(mesh)
        this.stats.thinInstances += mats.length
        this.stats.instanceMeshes++
      })
      if (chunk.meshes.length) {
        chunk.center = min.add(max).scale(0.5)
        chunk.radius = max.subtract(min).length() / 2
        this.chunks.push(chunk)
        added.push(chunk)
      }
    }
    return added
  }

  private placeClone(model: WorldModel, container: AssetContainer, p: WorldPlacement, region: number): Clone {
    const bmin = Vector3.FromArray(model.boundsMin)
    const bmax = Vector3.FromArray(model.boundsMax)
    const localCenter = bmin.add(bmax).scale(0.5)
    // W12-SA (S-SCALE): the placement's uniform scale on the holder (absent: 1, today's clone).
    const s = placementScale(p)
    const radius = (bmax.subtract(bmin).length() / 2) * s
    const entries = container.instantiateModelsToScene(name => name, false, { doNotInstantiate: true })
    const holder = new TransformNode(`${model.glb}#${p.uid}`, this.scene)
    holder.position = Vector3.FromArray(p.position)
    holder.rotationQuaternion = Quaternion.FromArray(p.rotation)
    if (s !== 1) holder.scaling.setAll(s)
    for (const n of entries.rootNodes) n.parent = holder
    let meshes = 0
    for (const m of holder.getChildMeshes(false) as AbstractMesh[]) {
      m.isPickable = false
      m.metadata = { sroWorld: 'object' }
      m.layerMask |= WORLD_OBJECT_LAYER
      if (m.getTotalVertices() > 0) meshes++
    }
    this.stats.cloneMeshes += meshes
    let anim: AnimationGroup | null = null
    for (const g of entries.animationGroups) {
      if (!anim && (g.name === model.defaultClip || !model.defaultClip)) anim = g
      else g.stop()
    }
    anim ??= entries.animationGroups[0] ?? null
    if (anim) {
      anim.start(true, this.speed.now, anim.from, anim.to)
      // Desynchronise identical objects (the client runs each instance's clock independently).
      anim.goToFrame(anim.from + Math.random() * (anim.to - anim.from))
    }
    const center = Vector3.TransformCoordinates(localCenter, holder.computeWorldMatrix(true))
    const clone: Clone = { group: p.group, root: holder, entries, anim, center, radius, enabled: true, animating: true, region, meshes, placement: p, model, blocks: this.blocks(model) }
    this.clones.push(clone)
    this.stats.clones++
    return clone
  }

  /**
   * Every mesh the objects draw (thin-instance chunks and animated clones; W10-S: and the region batches' meshes),
   * e.g. for light include lists and the weather's shelter map.
   */
  meshes(): AbstractMesh[] {
    const out: AbstractMesh[] = []
    for (const c of this.chunks) out.push(...c.meshes)
    for (const c of this.clones) out.push(...c.root.getChildMeshes(false))
    if (this.batcherValue) out.push(...this.batcherValue.meshes())
    return out
  }

  setStaticVisible(on: boolean): void {
    this.showStatic = on
    this.batcherValue?.setVisible?.(on)
    this.refresh()
  }

  /**
   * Animated objects drawn and animating (Medium+), or hidden (Low). Hidden, a clone that blocks movement still draws,
   * still, and regions placed from then on load a blocking skinned model's static variant instead (modelToLoad).
   */
  setAnimatedVisible(on: boolean): void {
    this.showAnimated = on
    this.refresh()
  }

  get animatedVisible(): boolean {
    return this.showAnimated
  }

  setLod(on: boolean): void {
    this.lod = on
    this.batcherValue?.setLod?.(on)
    this.refresh()
  }

  /** Multiplies the native draw ranges (quality setting; 1 = TERRAIN.md 6.3). */
  setRangeScale(scale: number): void {
    this.rangeScale = Math.max(0.1, scale)
    // W10-S (F11): the batch follows the live scale (Options' sight, the create screen's 0.6).
    this.batcherValue?.setRangeScale(this.rangeScale)
    this.refresh()
  }

  /** The current range scale (setRangeScale). */
  get drawRangeScale(): number {
    return this.rangeScale
  }

  private lastCam = new Vector3(NaN, NaN, NaN)
  /** The camera's focus (the player): draw distance counts from the nearer of it and the camera. NaN = camera only. */
  private lastFocus = new Vector3(NaN, NaN, NaN)

  private refresh(): void {
    this.update(this.lastCam.x === this.lastCam.x ? this.lastCam : Vector3.Zero(), true)
  }

  private inRange(cam: Vector3, group: number, center: Vector3, radius: number): boolean {
    if (!this.lod) return true
    const range = (GROUP_RANGE_M[group] ?? GROUP_RANGE_M[2]!) * this.rangeScale
    // From the nearer of the camera and its focus (horizontally): zoomed far out, a small object the player stands at
    // stays drawn (Low's 28.8 m small range is shorter than the 40 m zoom), and it still blocks there.
    const f = this.lastFocus
    const d = f.x === f.x ? Math.min(Vector3.Distance(cam, center), Math.hypot(center.x - f.x, center.z - f.z)) : Vector3.Distance(cam, center)
    return d - radius < range
  }

  private camOrZero(): Vector3 {
    return this.lastCam.x === this.lastCam.x ? this.lastCam : Vector3.Zero()
  }

  /** W12-SA: the owner is a reload's staged set (hidden until it swaps in). */
  private isStaged(owner: number): boolean {
    return this.staged.size > 0 && this.staged.has(owner)
  }

  private applyChunk(c: Chunk, cam = this.camOrZero()): void {
    const on = this.showStatic && !this.isStaged(c.region) && this.inRange(cam, c.group, c.center, c.radius)
    for (const m of c.meshes) if (m.isEnabled(false) !== on) m.setEnabled(on)
  }

  private applyClone(c: Clone, cam = this.camOrZero()): void {
    // While animated objects are hidden (Low) a clone that blocks movement stays drawn, still (lowModelOf).
    const on = (this.showAnimated || c.blocks) && !this.isStaged(c.region) && this.inRange(cam, c.group, c.center, c.radius)
    // Beyond ANIMATE_RANGE_M a clone stays drawn but its clip pauses (no bone updates): far swaying trees and
    // flowers are not noticeable, and the skinned-clone CPU cost is what grows with the view.
    const animate = on && this.showAnimated && (!this.lod || Vector3.Distance(cam, c.center) - c.radius < ANIMATE_RANGE_M * this.rangeScale)
    if (on !== c.enabled) {
      c.enabled = on
      c.root.setEnabled(on)
    }
    if (animate !== c.animating) {
      c.animating = animate
      if (animate) c.anim?.play(true)
      else c.anim?.pause()
    }
  }

  /** Draw distance per TERRAIN.md 6.3 (no fades): visible while distance - radius < range of the group. */
  update(cam: Vector3, force = false, focus?: { x: number; z: number }): void {
    const focusMoved = !!focus && (this.lastFocus.x !== this.lastFocus.x || (focus.x - this.lastFocus.x) ** 2 + (focus.z - this.lastFocus.z) ** 2 >= 1)
    if (!force && !focusMoved && Vector3.DistanceSquared(cam, this.lastCam) < 1) return
    this.lastCam.copyFrom(cam)
    if (focus) this.lastFocus.set(focus.x, 0, focus.z)
    for (const c of this.chunks) this.applyChunk(c, cam)
    for (const c of this.clones) this.applyClone(c, cam)
    this.batcherValue?.update(cam, force)
  }

  /** Animated clones whose clip is currently running. */
  get animatingCount(): number {
    let n = 0
    for (const c of this.clones) if (c.animating) n++
    return n
  }

  /** Chunks and clones currently inside their draw distance. */
  get visibleCounts(): { chunks: number; clones: number } {
    let chunks = 0
    let clones = 0
    for (const c of this.chunks) if (c.meshes[0]?.isEnabled(false)) chunks++
    for (const c of this.clones) if (c.enabled) clones++
    return { chunks, clones }
  }

  dispose(): void {
    this.disposed = true
    for (const c of this.chunks) for (const m of c.meshes) m.dispose(false, false)
    for (const c of this.clones) {
      c.entries.dispose()
      c.root.dispose(false, false)
    }
    // The containers still own the source meshes, skeletons, animation groups and glTF textures; their materials
    // were replaced (ObjectMaterials disposes those). Streamed containers belong to the model cache.
    for (const c of this.containers) c.dispose()
    this.chunks.length = 0
    this.clones.length = 0
    this.containers.length = 0
    this.placed.length = 0
    this.listeners.length = 0
    this.claimed.clear()
    this.batches.clear()
    this.staged.clear()
    this.batcherValue = null
    this.ambient?.dispose()
    this.ambient = null
  }
}
