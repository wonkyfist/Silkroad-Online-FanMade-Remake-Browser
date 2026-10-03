/**
 * One streamed region (docs/FIELDS.md §3.4): its fetch/decode (async, off the frame budget), its commit jobs (main
 * thread, run by the streamer within the frame budget) and its unload.
 *
 * States: absent → queued → fetching → decoded → committing → ready, or failed. The chunk is `ready` once its nav,
 * terrain and water are in (and its minimap tile), and `objectsReady` once every object model it draws is placed.
 * Unloading disposes everything the region committed, releases its tiles and models, removes its nav terrain and
 * drops its minimap tile; a fetch still in flight is aborted, and whatever it still delivers is discarded.
 *
 * Wave 12 (W12-SA; docs/WORLD_EDITOR.md S-FILTER, S-OBJ; docs/WAVE_PLAN8.md §4.2 steps 1, 4): the world's region filter
 * runs on the decoded data before any commit job (the editor's layers apply before the first build), and
 * `reloadObjects` places the region's objects again under a new owner key (the editor-owned filter, an edited placement
 * list), hidden until its batch is built, then swaps it in for the old set in one turn: the other regions are untouched.
 */
import type { AssetContainer, BaseTexture } from '@babylonjs/core'
import type { NavRegion } from '@sro/nav'
import { decodeTerrainBin } from '../../convert/src/world/format.ts'
import type { WorldModel, WorldPlacement, WorldRegion } from '../../convert/src/world/manifest.ts'
import { errorText, isAbort, mimeOf } from './assets.ts'
import type { ConvertedMaterials } from './materials.ts'
import type { MinimapTile } from './minimap.ts'
import type { ModelCache, ModelGeometry } from './model-cache.ts'
import type { NavChunkSource } from './nav.ts'
import type { StaticPrep } from './objects.ts'
import type { RegionData } from './regions.ts'
import { loadTerrainLightmap } from './terrain.ts'
import type { TileAtlas } from './tile-atlas.ts'
import type { World } from './world.ts'

export type RegionState = 'absent' | 'queued' | 'fetching' | 'decoded' | 'committing' | 'ready' | 'failed'

export type RegionEvent = 'ready' | 'objects' | 'unloaded' | 'failed'

/** A manifest region with what the streamer needs to know about it (computed once per world). */
export interface RegionInfo {
  region: WorldRegion
  id: number
  x: number
  z: number
  /** glTF rectangle (x east, z south). */
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  cx: number
  cz: number
  /** Model index -> this region's placements drawing it (placements bucketed by their region, §3.4). */
  models: Map<number, WorldPlacement[]>
  placements: number
}

/** A model in the shared cache: its container, converted materials and (static models) chunk preparation. */
export interface CachedModel {
  model: WorldModel
  container: AssetContainer
  converted: ConvertedMaterials | null
  prep: StaticPrep | null
  /**
   * W10-S (docs/BATCHING.md §3.1, F13): the static geometry export for the region batcher, made on first use by
   * model-cache.ts `geometryOf` (undefined until then; never made while batching is off).
   */
  geometry?: ModelGeometry | null
}

/** Job order inside one region: nav, terrain, water first, then its objects (same priority key otherwise). */
export const JOB_CORE = 0
/** Objects queue behind the terrain of regions up to this much further away (metres of priority key). */
export const JOB_OBJECTS = 150

/** What a chunk needs from its streamer. */
export interface ChunkHost {
  readonly world: World
  readonly atlas: TileAtlas
  readonly models: ModelCache<CachedModel>
  readonly nav: NavChunkSource
  readonly objects: boolean
  readonly animated: boolean
  readonly minimap: boolean
  /** Runs a request through the shared fetch limiter at this chunk's priority (+ offset), aborted with the chunk. */
  request<T>(chunk: RegionChunk, fn: () => Promise<T>, offset?: number): Promise<T>
  /** Queues a main-thread job; it is skipped when the chunk has been unloaded by then. */
  schedule(chunk: RegionChunk, offset: number, run: () => void): void
  /** Takes the chunk's reference on a model. */
  acquireModel(chunk: RegionChunk, index: number): Promise<CachedModel>
  /** State change notification ('ready', 'objects', 'failed'). */
  changed(chunk: RegionChunk, event: RegionEvent): void
  /**
   * Wave 9 seam: the region's terrain is committed (stream.ts queues the 'terrain' commit steps). W12-SA: 'objects' after
   * a reload swapped the region's objects (its 'objects' commit steps run again: the night splat, the shadow proxy).
   */
  committed?(chunk: RegionChunk, stage: 'terrain' | 'objects'): void
  /** A model failed to load (reported once per model by the host). */
  modelFailed(index: number, err: unknown): void
}

let serials = 0

export class RegionChunk {
  /**
   * Owner key of this chunk's objects (WorldObjects) and model references (ModelCache), unique per chunk rather than
   * per region: a region loaded again while its previous chunk is still being disposed never loses what the new
   * chunk placed or acquired.
   */
  readonly owner = ++serials
  state: RegionState = 'queued'
  /** Priority key (lower loads first): distance × (1 − viewBias · max(0, cos θ)). */
  priority = 0
  /** Distance from the focus to the region's rectangle (m). */
  distance = 0
  alive = true
  objectsReady = false
  error: string | null = null
  private readonly abort = new AbortController()
  private data: RegionData | null = null
  private nav: NavRegion | null = null
  private lightmap: BaseTexture | null = null
  private minimapTile: MinimapTile | null = null
  private tiles: number[] = []
  private readonly held = new Set<number>()
  private pendingObjects = 0
  /** W10-S: the region's batch is building (its 'objects' waits for it). */
  private batching = false
  private readonly deferred: Array<() => void> = []
  /**
   * W12-SA (S-OBJ): the owner key of the objects this chunk shows (WorldObjects, the batch, the listeners): `owner` until
   * a reload places them again under a fresh key. Model references stay on `owner`.
   */
  objectsOwner: number
  /** W12-SA: object owners placed and not removed yet (the shown one, and a reload's new one while it builds). */
  private readonly liveOwners = new Set<number>()
  /** W12-SA: the cache entry loaded for each held model index (a reload places from it). */
  private readonly entries = new Map<number, CachedModel>()
  /** W12-SA: a reload runs; the reloads asked since it started (they run once more after it); its abort (an unload). */
  private reloading = false
  private readonly reloadQueue: Array<(done: boolean) => void> = []
  private abortReload: (() => void) | null = null
  private navAdded = false
  private regionAdded = false
  private terrainBuilt = false
  /** The terrain commit ran (stays true after an unload; the commit-step seam reads it with `alive`). */
  terrainCommitted = false
  private waterAdded = false
  private minimapSet = false

  constructor(readonly info: RegionInfo, private readonly host: ChunkHost) {
    this.objectsOwner = this.owner
    this.liveOwners.add(this.owner)
  }

  get id(): number {
    return this.info.id
  }

  /** Starts the fetch/decode and the model requests. */
  start(): void {
    if (this.state !== 'queued') return
    this.state = 'fetching'
    this.requestModels()
    void this.fetch()
  }

  private async fetch(): Promise<void> {
    const { host, info } = this
    const r = info.region
    const signal = this.abort.signal
    const world = host.world
    const assets = world.assets
    this.tiles = [...new Set(r.terrain.tileIds)]
    const tilesReady = host.atlas.acquire(this.tiles, () => (this.alive ? this.priority : Infinity))
    const quiet = <T>(what: string, p: Promise<T>): Promise<T | null> => p.catch(err => {
      if (!isAbort(err) && this.alive) console.warn(`[world] region ${r.x},${r.z} ${what}:`, err)
      return null
    })
    try {
      const [terrain, nav, lightmap, minimap] = await Promise.allSettled([
        host.request(this, () => assets.bytesOf(r.terrain.file, signal)),
        quiet('nav', host.request(this, () => host.nav.load({ id: r.id, x: r.x, z: r.z }, signal))),
        r.lightmap ? quiet('lightmap', host.request(this, () => loadTerrainLightmap(world.scene, assets, r.lightmap!.file, signal))) : null,
        host.minimap && r.minimap && typeof createImageBitmap !== 'undefined'
          ? quiet('minimap', host.request(this, async () => {
            const bytes = await assets.bytesOf(r.minimap!, signal)
            return await createImageBitmap(new Blob([bytes], { type: mimeOf(r.minimap!) })) as MinimapTile
          }))
          : null,
      ])
      const lm = lightmap.status === 'fulfilled' ? lightmap.value : null
      const mm = minimap.status === 'fulfilled' ? minimap.value : null
      if (!this.alive) {
        lm?.dispose()
        mm?.close?.()
        return
      }
      this.lightmap = lm
      this.minimapTile = mm
      if (terrain.status === 'rejected') throw terrain.reason
      this.data = { region: r, terrain: decodeTerrainBin(terrain.value), navmesh: null }
      // W12-SA (S-FILTER): the editor's layers on the decoded data, before the terrain, water and nav commits.
      world.filterRegion(this.data)
      this.nav = nav.status === 'fulfilled' ? nav.value : null
      await tilesReady
      if (!this.alive) return
      this.state = 'decoded'
      host.schedule(this, JOB_CORE, () => this.commitNav())
      host.schedule(this, JOB_CORE, () => this.commitTerrain())
      host.schedule(this, JOB_CORE, () => this.commitWater())
    } catch (err) {
      if (!this.alive || isAbort(err)) return
      this.fail(err)
    }
  }

  // ---- commit jobs (in this order) ------------------------------------------------------------------------------

  private commitNav(): void {
    const w = this.host.world
    this.state = 'committing'
    if (this.nav) {
      w.navWorld.addRegion(this.nav)
      this.navAdded = true
    }
    w.regions.add(this.data!)
    this.regionAdded = true
  }

  private commitTerrain(): void {
    const atlas = this.host.atlas
    this.host.world.terrain.buildRegion(this.data!, id => atlas.layerOf(id), this.lightmap)
    this.lightmap = null // owned by the terrain region now
    this.terrainBuilt = true
    this.terrainCommitted = true
    this.host.committed?.(this, 'terrain')
  }

  private commitWater(): void {
    const w = this.host.world
    const r = this.info.region
    w.water.addRegion(this.data!)
    this.waterAdded = true
    if (this.minimapTile) {
      if (w.minimap?.tileMode) {
        w.minimap.setTile(r.x, r.z, this.minimapTile)
        this.minimapSet = true
      } else this.minimapTile.close?.()
      this.minimapTile = null
    }
    this.state = 'ready'
    this.host.changed(this, 'ready')
    for (const run of this.deferred.splice(0)) run()
    if (this.pendingObjects === 0) this.setObjectsReady()
  }

  // ---- objects ----------------------------------------------------------------------------------------------------

  private requestModels(): void {
    const { host, info } = this
    if (!host.objects) return
    const objects = host.world.objects
    const models = host.world.manifest.models
    for (const [index, placements] of info.models) {
      const model = models[index]
      if (!model || !model.glb || model.kind === 'failed') continue
      // W10-S (GRASS_LIFE §1.3, D3): a hidden model (the retail tufts under the new grass) is not even loaded.
      if (objects.isHidden(model)) continue
      // W10-S (BATCHING §3.5): the batcher may load another model in its place (BT-T's static tree variant).
      const use = objects.modelToLoad(model)
      if (!use.glb || use.kind === 'failed') continue
      if (use.kind === 'skinned' && !host.animated) continue
      this.pendingObjects++
      this.held.add(use.index)
      host.acquireModel(this, use.index).then(entry => {
        if (!this.alive) return
        this.entries.set(use.index, entry)
        const run = () => {
          // One pending object was counted for the model: its jobs replace it (none: it is done now).
          const jobs = this.placeModel(model, entry, placements, this.objectsOwner, () => this.objectDone())
          if (jobs === 0) this.objectDone()
          else this.pendingObjects += jobs - 1
        }
        if (this.state === 'ready') run()
        else this.deferred.push(run)
      }, err => {
        if (!this.alive) return
        host.modelFailed(use.index, err)
        this.objectDone()
      })
    }
  }

  /**
   * Places `model`'s placements with the cache entry loaded for it (the model itself, or the batcher's stand-in) under
   * `owner` (W12-SA: the shown owner, or a reload's new one): one job for a static model, one per clone, each calling
   * `done` once. Returns how many jobs it queued.
   */
  private placeModel(model: WorldModel, entry: CachedModel, placements: readonly WorldPlacement[], owner: number, done: () => void): number {
    const { host, info } = this
    const objects = host.world.objects
    const r = info.region
    if (entry.prep) {
      const prep = entry.prep
      host.schedule(this, JOB_OBJECTS, () => {
        objects.addStatic(owner, [r.origin[0], r.origin[2]], model, prep, placements, entry)
        done()
      })
      return 1
    }
    for (const p of placements) {
      host.schedule(this, JOB_OBJECTS, () => {
        objects.addClone(owner, model, entry.container, p)
        done()
      })
    }
    return placements.length
  }

  private objectDone(): void {
    this.pendingObjects--
    if (this.pendingObjects <= 0 && this.state === 'ready') this.setObjectsReady()
  }

  /**
   * Every model is placed. W10-S (BATCHING §3.1): when the batcher claimed any of them, the region's batch is built
   * first and 'objects' (with every 'objects' commit step) fires once it is ready; otherwise at once, as before.
   */
  private setObjectsReady(): void {
    if (this.objectsReady || this.batching || !this.alive) return
    const r = this.info.region
    const wait = this.host.world.objects.commitRegion(
      { owner: this.objectsOwner, id: this.info.id, x: this.info.x, z: this.info.z, origin: [r.origin[0], r.origin[1], r.origin[2]] },
      { schedule: run => this.host.schedule(this, JOB_OBJECTS, run), alive: () => this.alive },
    )
    if (!wait) {
      this.finishObjects()
      return
    }
    this.batching = true
    void wait.then(() => {
      this.batching = false
      this.finishObjects()
    })
  }

  private finishObjects(): void {
    if (this.objectsReady || !this.alive) return
    this.objectsReady = true
    this.host.changed(this, 'objects')
    // W12-SA: a reload asked while the region was still placing runs now.
    this.pumpReload()
  }

  // ---- W12-SA: S-OBJ, the region's objects placed again (docs/WORLD_EDITOR.md §2.3, §9.3 item 1) -------------------

  /**
   * Places the region's objects again from its current placement lists (RegionInfo.models, which
   * RegionStreamer.reloadObjects may have replaced) through the world's filters (the editor-owned placements, the hidden
   * models): under a fresh owner key, its chunks and clones hidden while its batch builds in the merge worker, then the
   * old set goes and the new one shows in the same turn (no frame draws both or neither) and the region's 'objects'
   * commit steps run again. The other regions are untouched. Resolves true once swapped, false when the region went
   * first (or places no objects at all). A region still placing reloads once its objects are ready; reloads asked while
   * one runs are folded into one more run after it.
   */
  reloadObjects(): Promise<boolean> {
    if (!this.alive || !this.host.objects) return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      this.reloadQueue.push(resolve)
      this.pumpReload()
    })
  }

  private pumpReload(): void {
    if (this.reloading || !this.reloadQueue.length) return
    if (!this.alive) {
      for (const r of this.reloadQueue.splice(0)) r(false)
      return
    }
    if (!this.objectsReady) return
    const waiters = this.reloadQueue.splice(0)
    this.reloading = true
    void this.runReload().then(ok => {
      this.reloading = false
      for (const r of waiters) r(ok)
      this.pumpReload()
    })
  }

  private runReload(): Promise<boolean> {
    const { host, info } = this
    const objects = host.world.objects
    const models = host.world.manifest.models
    const old = this.objectsOwner
    const owner = ++serials
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        this.abortReload = null
        resolve(ok)
      }
      // The region went meanwhile: the unload removes every live owner (the new one too).
      this.abortReload = () => finish(false)
      this.liveOwners.add(owner)
      objects.stageRegion(owner)
      const used = new Set<number>()
      // The old set's animated clones whose placement stays (not edited, not editor-owned) move to the new owner at the
      // swap instead of being instantiated again (each costs 1–3 ms of main thread, and its clip would restart).
      const cloned = objects.clonePlacements(old)
      const adopt = new Set<WorldPlacement>()
      const swap = (): void => {
        if (!this.alive || settled) return
        if (adopt.size) objects.adoptClones(old, owner, p => adopt.has(p))
        objects.removeRegion(old)
        this.liveOwners.delete(old)
        this.objectsOwner = owner
        objects.showRegion(owner)
        // Models the region no longer draws (an edited list) let go once the old set is gone.
        for (const index of [...this.held]) {
          if (used.has(index)) continue
          this.held.delete(index)
          this.entries.delete(index)
          host.models.release(index, this.owner)
        }
        host.committed?.(this, 'objects')
        finish(true)
      }
      const commit = (): void => {
        if (!this.alive || settled) return
        const r = info.region
        const wait = objects.commitRegion(
          { owner, id: info.id, x: info.x, z: info.z, origin: [r.origin[0], r.origin[1], r.origin[2]] },
          { schedule: run => host.schedule(this, JOB_OBJECTS, run), alive: () => this.alive },
        )
        if (wait) void wait.then(swap)
        else swap()
      }
      // One pending count for the queueing itself; each placement job and each model load holds one more.
      let pending = 1
      const done = (): void => {
        if (--pending === 0) commit()
      }
      for (const [index, placements] of info.models) {
        const model = models[index]
        if (!model || !model.glb || model.kind === 'failed' || objects.isHidden(model)) continue
        const use = objects.modelToLoad(model)
        if (!use.glb || use.kind === 'failed' || (use.kind === 'skinned' && !host.animated)) continue
        used.add(use.index)
        let list: readonly WorldPlacement[] = placements
        if (cloned.size && use.kind === 'skinned') {
          list = placements.filter(p => {
            if (!cloned.has(p) || objects.isEditorOwned(p, model)) return true
            adopt.add(p)
            return false
          })
        }
        if (!list.length) continue
        const entry = this.entries.get(use.index)
        if (entry) {
          pending += this.placeModel(model, entry, list, owner, done)
          continue
        }
        // A model new to the region (an editor add), or one whose load failed before: take a reference first.
        pending++
        this.held.add(use.index)
        host.acquireModel(this, use.index).then(e => {
          if (!this.alive || settled) return
          this.entries.set(use.index, e)
          pending += this.placeModel(model, e, list, owner, done)
          done()
        }, err => {
          if (!this.alive || settled) return
          host.modelFailed(use.index, err)
          done()
        })
      }
      done()
    })
  }

  /**
   * W12-SA: removes up to `max` chunks and clones of each object owner the chunk placed (the shown one and a reload's
   * new one); returns how many remain (stream.ts' budgeted unload calls it until 0).
   */
  removeObjects(max = Infinity): number {
    const objects = this.host.world.objects
    let left = 0
    for (const o of [...this.liveOwners]) {
      const n = objects.removeRegion(o, max)
      if (n === 0) this.liveOwners.delete(o)
      left += n
    }
    return left
  }

  private fail(err: unknown): void {
    this.state = 'failed'
    this.error = errorText(err)
    console.warn(`[world] region ${this.info.x},${this.info.z} failed:`, err)
    this.host.changed(this, 'failed')
  }

  // ---- unload -----------------------------------------------------------------------------------------------------

  /** Disposes everything this region committed and releases what it holds, at once. */
  unload(): void {
    this.cancel()
    this.disposeCore()
    this.removeObjects()
    this.releaseModels()
  }

  /**
   * Step 1 of an unload: stops the chunk (fetches aborted, pending jobs skipped, late results discarded). Nothing
   * is disposed yet; the streamer queues disposeCore and the object removal as budgeted jobs.
   */
  cancel(): void {
    if (!this.alive) return
    this.alive = false
    this.abort.abort()
    this.deferred.length = 0
    this.state = 'absent'
    // W12-SA: a reload running or asked for ends here (its new owner goes with the region's objects).
    this.abortReload?.()
    for (const r of this.reloadQueue.splice(0)) r(false)
  }

  /**
   * Step 2: the region's nav terrain, terrain, water, minimap tile and tile references (one job; it runs before any
   * commit of a newer chunk of the same region, see stream.ts UNLOAD_PRIORITY).
   */
  disposeCore(): void {
    const { host, info } = this
    const w = host.world
    if (this.navAdded) w.navWorld.removeRegion(info.id)
    if (this.regionAdded) w.regions.remove(info.id)
    if (this.terrainBuilt) w.terrain.disposeRegion(info.id)
    if (this.waterAdded) w.water.removeRegion(info.id)
    if (this.minimapSet) w.minimap?.removeTile(info.x, info.z)
    this.navAdded = this.regionAdded = this.terrainBuilt = this.waterAdded = this.minimapSet = false
    this.lightmap?.dispose()
    this.lightmap = null
    this.minimapTile?.close?.()
    this.minimapTile = null
    host.atlas.release(this.tiles)
    this.tiles = []
    this.data = null
    this.nav = null
  }

  /** Step 3, once the objects are gone: the model references. */
  releaseModels(): void {
    for (const index of this.held) this.host.models.release(index, this.owner)
    this.held.clear()
    this.entries.clear()
  }
}
