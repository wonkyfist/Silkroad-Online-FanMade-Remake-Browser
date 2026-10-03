/**
 * Region streaming (docs/FIELDS.md §3): the regions within `loadRadiusM` of the focus (the local player, or the
 * camera target in the viewer) are loaded, those beyond `unloadRadiusM` are released, nearest first with a bias
 * toward the camera's view direction, with main-thread work capped per frame.
 *
 * - `d(region)` is the 2D distance from the focus to the region's rectangle (0 inside it). Wanted: d ≤ loadRadiusM;
 *   unloaded once d > unloadRadiusM (the gap is the hysteresis: walking across a border never reloads anything).
 * - Priority key d × (1 − viewBias · max(0, cos θ)), θ between the camera's forward direction and the direction to the
 *   region's centre; lowest first. The wanted set and the order are recomputed when the focus moved more than 8 m or
 *   the camera turned more than 15°.
 * - Fetch/decode is async and shares one limiter of `maxFetches` requests; commit jobs (one region's nav, terrain,
 *   water; one model × region; one skinned clone; one tile upload) run from a priority queue until `frameBudgetMs`
 *   is used, at least one per frame.
 * - Models are shared and reference-counted (model-cache.ts), terrain tiles live in one atlas (tile-atlas.ts).
 * - The client nav gets each region's terrain as it commits (NavWorld.addRegion) and loses it on unload.
 *
 * World.update() calls update() every frame. While the app does not (a loading screen, a stalled tab), a timer pumps
 * the queue so loading continues.
 *
 * Wave 12 (W12-SA, WORLD_EDITOR S-OBJ): `reloadObjects(rx, rz)` places one resident region's objects again (the
 * editor-owned filter, an edited placement list) without touching the others.
 */
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { abortError, errorText } from './assets.ts'
import type { BatchWorkerFactory, RegionBatcher } from './batch/types.ts'
import { ModelCache } from './model-cache.ts'
import type { NavChunkSource } from './nav.ts'
import { loadGlb, prepareStatic } from './objects.ts'
import type { SidecarLite } from './materials.ts'
import { JOB_CORE, JOB_OBJECTS, RegionChunk, type CachedModel, type ChunkHost, type RegionEvent, type RegionInfo, type RegionState } from './region-chunk.ts'
import type { RegionData } from './regions.ts'
import { tileImageOf, type MapScheduler, type TileMaps } from './pbr/maps.ts'
import { planSetRange, TileAtlas, type TileAtlasSetup, type TilePlane, type TileSetInfo } from './tile-atlas.ts'
import type { World, WorldQuality } from './world.ts'

export type { CachedModel, RegionEvent, RegionInfo, RegionState } from './region-chunk.ts'

export interface StreamSettings {
  /** A region is wanted while the focus is at most this far from its rectangle (m). */
  loadRadiusM: number
  /** A resident region is released once the focus is further than this from its rectangle (m). */
  unloadRadiusM: number
  /** Main-thread commit work per frame (ms); at least one job always runs. */
  frameBudgetMs: number
  /** Requests in flight at most (region files, model glbs, tiles). */
  maxFetches: number
  /** Priority bias toward the view direction (0 = distance only). */
  viewBias: number
  /** Initial tile atlas capacity in layers (it grows by 16 when full). Applies when the world loads. */
  tileLayers: number
  /** Tile atlas layer size. Applies when the world loads. */
  tileSize: 256 | 512
  /** Seconds an unused model stays cached. */
  modelGraceS: number
  /** Unused models kept cached at most. */
  modelCacheMax: number
}

const HIGH_STREAM: StreamSettings = { loadRadiusM: 480, unloadRadiusM: 660, frameBudgetMs: 5, maxFetches: 8, viewBias: 0.35, tileLayers: 96, tileSize: 512, modelGraceS: 60, modelCacheMax: 160 }

export const STREAM_DEFAULTS: Record<WorldQuality, StreamSettings> = {
  low: { loadRadiusM: 320, unloadRadiusM: 460, frameBudgetMs: 3, maxFetches: 4, viewBias: 0.35, tileLayers: 72, tileSize: 256, modelGraceS: 20, modelCacheMax: 40 },
  medium: { loadRadiusM: 400, unloadRadiusM: 560, frameBudgetMs: 4, maxFetches: 6, viewBias: 0.35, tileLayers: 80, tileSize: 512, modelGraceS: 30, modelCacheMax: 80 },
  high: HIGH_STREAM,
  // Wave 9 (docs/WAVE_PLAN3.md D5): Ultra streams like High.
  ultra: { ...HIGH_STREAM },
}

/** What a commit step runs after (docs/WAVE_PLAN3.md §4.1): the region's terrain commit, or all of its objects. */
export type CommitStepAfter = 'terrain' | 'objects'

/**
 * A per-region job other lanes add (WX-R 'wetMap' after the terrain, NL 'nightSplat' and RND-L 'shadowProxy' after the
 * objects). Each step of each region is its own job in the per-frame budget (FIELDS.md §3.6: a job is never split),
 * queued behind its dependency at the region's priority.
 */
export interface CommitStep {
  readonly name: string
  readonly run: (region: RegionData) => void
  readonly after: CommitStepAfter
  /** Wait this long (ms) after the trigger before queueing (a re-trigger restarts the wait). */
  readonly debounceMs: number
}

export interface StreamStats {
  /** Regions within the load radius. */
  wanted: number
  /** Resident regions whose terrain is in (state 'ready'). */
  ready: number
  /** Ready regions whose objects are all placed. */
  objectsReady: number
  /** Regions held (any state but absent): wanted plus those not yet past the unload radius. */
  resident: number
  fetching: number
  /** Regions decoded or committing (terrain not in yet). */
  committing: number
  failed: number
  /** Commit jobs waiting. */
  jobs: number
  /** Bytes downloaded by the streamer so far. */
  bytes: number
  /** Models loaded (in use or cached) and unused ones waiting in the cache. */
  modelsLoaded: number
  modelsCached: number
  modelsFailed: number
  /** Tile atlas layers holding a referenced tile, and its capacity. */
  tileLayersUsed: number
  tileLayers: number
  /** Regions unloaded so far. */
  unloads: number
  /** Streaming work of the last update() and the worst so far (ms). */
  lastFrameMs: number
  worstFrameMs: number
}

/** Test and wiring seams. */
export interface StreamHooks {
  /** Clock in ms (frame budget, model grace). Default performance.now. */
  now?: () => number
  /** Pump the queue from a timer while update() is not called (default true). */
  autoPump?: boolean
  /** Per-region nav terrain (default: none, the nav stays objects-only). */
  nav?: NavChunkSource
  /** Place objects (default true); animated: also the skinned ones (default true). */
  objects?: boolean
  animated?: boolean
  /** Object lightmaps (default true). */
  lightmaps?: boolean
  /** Decode minimap tiles for world.minimap (default: when it exists in tile mode). */
  minimap?: boolean
  /** Loads one model for the cache (default: glb + sidecar + ObjectMaterials + static preparation). */
  loadModel?: (model: WorldModel) => Promise<CachedModel>
  /** Frees a cached model (default: its materials, then its container). */
  disposeModel?: (entry: CachedModel) => void
  /** Tile atlas seams (tests). */
  atlas?: Partial<Pick<ConstructorParameters<typeof TileAtlas>[0], 'create' | 'upload' | 'rebuild' | 'decode'>>
  /**
   * W10-S (docs/BATCHING.md BT-0): a region batcher set on `world.objects` when the streamer is made (tests, the lab);
   * default: the world's own (World.batch, set by World on the PBR path).
   */
  batcher?: RegionBatcher | null
  /** W10-S: makes the batch part's merge worker (tests pass an in-process stand-in; default: the part's own). */
  batchWorker?: BatchWorkerFactory | null
}

/** Recompute the wanted set after the focus moved this far (m) or the camera turned this much (rad). */
const REFOCUS_M = 8
const RETURN_RAD = (15 * Math.PI) / 180
/** Budget while nothing has been handed to the app yet (ms). */
const BOOT_BUDGET_MS = 12
/** whenReady default radius (m). */
const READY_RADIUS_M = 200
/** A failed region is fetched again after this long (ms) while it is still wanted. */
const RETRY_MS = 5000
/** Unload jobs run before any commit (a region loaded again must never meet its old chunk's disposal). */
const UNLOAD_PRIORITY = -1e12
/** Chunks and clones removed per unload job. */
const REMOVE_PER_JOB = 32
/** Model containers disposed per frame at most. */
const EVICT_PER_FRAME = 1
/**
 * TX-R (TEXPIPE §6.4 "progressive swap"): map-set decodes and uploads run after every region, model and tile request
 * and job (priorities are metres plus small offsets), at most MAP_REQUESTS of them in flight so region fetches keep
 * their slots.
 */
const MAP_PRIORITY = 1e9
const MAP_REQUESTS = 2
/** TX-R: the terrain's tier plane edge on High and Ultra (D39: terrain albedo 1024, 48-layer cap). */
const TIER_SIZE = 1024

interface Job {
  pri: number
  seq: number
  chunk: RegionChunk | null
  run: () => void
}

/** Binary min-heap of jobs by (pri, seq). */
class JobQueue {
  private readonly heap: Job[] = []

  get size(): number {
    return this.heap.length
  }

  push(job: Job): void {
    const h = this.heap
    h.push(job)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!less(h[i]!, h[p]!)) break
      ;[h[i], h[p]] = [h[p]!, h[i]!]
      i = p
    }
  }

  pop(): Job | undefined {
    const h = this.heap
    const top = h[0]
    const last = h.pop()
    if (!h.length || !last || !top) return top
    h[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < h.length && less(h[l]!, h[m]!)) m = l
      if (r < h.length && less(h[r]!, h[m]!)) m = r
      if (m === i) break
      ;[h[i], h[m]] = [h[m]!, h[i]!]
      i = m
    }
    return top
  }

  clear(): void {
    this.heap.length = 0
  }
}

function less(a: Job, b: Job): boolean {
  return a.pri < b.pri || (a.pri === b.pri && a.seq < b.seq)
}

/** At most `max` requests in flight; waiting ones start lowest priority first (evaluated when a slot frees). */
export class Limiter {
  active = 0
  private readonly waiting: Array<{ pri: () => number; start: () => void; drop: () => void }> = []

  constructor(public max: number) {}

  get queued(): number {
    return this.waiting.length
  }

  run<T>(pri: () => number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const item = {
        pri,
        start: () => {
          this.active++
          Promise.resolve().then(fn).then(resolve, reject).finally(() => {
            this.active--
            this.next()
          })
        },
        drop: () => reject(abortError()),
      }
      signal?.addEventListener('abort', () => {
        const i = this.waiting.indexOf(item)
        if (i >= 0) {
          this.waiting.splice(i, 1)
          item.drop()
        }
      }, { once: true })
      this.waiting.push(item)
      this.next()
    })
  }

  next(): void {
    while (this.active < this.max && this.waiting.length) {
      let best = 0
      let bestPri = Infinity
      for (let i = 0; i < this.waiting.length; i++) {
        const p = this.waiting[i]!.pri()
        if (p < bestPri) {
          bestPri = p
          best = i
        }
      }
      this.waiting.splice(best, 1)[0]!.start()
    }
  }

  /** Rejects every waiting request (dispose). */
  clear(): void {
    for (const w of this.waiting.splice(0)) w.drop()
  }
}

/** 2D distance from (x, z) to a region's rectangle (0 inside). */
export function rectDistance(x: number, z: number, r: { minX: number; maxX: number; minZ: number; maxZ: number }): number {
  const dx = x < r.minX ? r.minX - x : x > r.maxX ? x - r.maxX : 0
  const dz = z < r.minZ ? r.minZ - z : z > r.maxZ ? z - r.maxZ : 0
  return Math.hypot(dx, dz)
}

/**
 * Per-region placement lists (§3.4): a placement belongs to its `region` field (its .o2 region, equal to the position
 * rule rx = ox + floor(x / 192), rz = oz + floor(−z / 192) for the whole area). One owned by a region outside the export
 * (a big object overhanging from a neighbour) goes to the export region nearest its position.
 */
export function regionInfos(world: { manifest: World['manifest'] }): RegionInfo[] {
  const m = world.manifest
  const size = m.space.regionSizeM || 192
  const ox = m.space.originRegion.x
  const oz = m.space.originRegion.z
  const infos = new Map<number, RegionInfo>()
  for (const region of m.regions) {
    const [x0, , z0] = region.origin
    infos.set(region.id, {
      region, id: region.id, x: region.x, z: region.z,
      minX: x0, maxX: x0 + size, minZ: z0 - size, maxZ: z0, cx: x0 + size / 2, cz: z0 - size / 2,
      models: new Map(), placements: 0,
    })
  }
  const all = [...infos.values()]
  const home = (p: WorldPlacement): RegionInfo | undefined => {
    const own = infos.get(p.region)
    if (own) return own
    const rx = ox + Math.floor(p.position[0] / size)
    const rz = oz + Math.floor(-p.position[2] / size)
    const byPos = infos.get((rz << 8) | rx)
    if (byPos) return byPos
    let best: RegionInfo | undefined
    let bestD = Infinity
    for (const i of all) {
      const d = rectDistance(p.position[0], p.position[2], i)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }
  for (const p of m.placements) {
    const info = home(p)
    if (!info) continue
    info.placements++
    for (const mi of p.models) {
      const list = info.models.get(mi)
      if (list) list.push(p)
      else info.models.set(mi, [p])
    }
  }
  return all
}

interface Waiter {
  x: number
  z: number
  radius: number
  objects: boolean
  resolve: () => void
}

export class RegionStreamer implements ChunkHost {
  readonly stats: StreamStats = {
    wanted: 0, ready: 0, objectsReady: 0, resident: 0, fetching: 0, committing: 0, failed: 0, jobs: 0, bytes: 0,
    modelsLoaded: 0, modelsCached: 0, modelsFailed: 0, tileLayersUsed: 0, tileLayers: 0, unloads: 0, lastFrameMs: 0, worstFrameMs: 0,
  }
  onRegion: ((rx: number, rz: number, event: RegionEvent) => void) | null = null
  readonly settings: StreamSettings
  /** The terrain tile arrays (replaced when the render path changes: rebuild()). */
  atlas: TileAtlas
  /** Whether the atlas was built with the PBR texture sets (`prepare`). */
  private atlasPbr: boolean
  private readonly tiles: Map<number, { id: number; file: string }>
  private readonly customAtlas: boolean
  readonly models: ModelCache<CachedModel>
  readonly nav: NavChunkSource
  readonly objects: boolean
  readonly animated: boolean
  readonly minimap: boolean
  /** Every region of the export (the streaming candidates). */
  readonly regions: readonly RegionInfo[]
  private readonly chunks = new Map<number, RegionChunk>()
  /** Cancelled chunks whose disposal jobs have not finished yet. */
  private readonly releasing = new Set<RegionChunk>()
  private readonly jobs = new JobQueue()
  private readonly limiter: Limiter
  private readonly now: () => number
  private readonly failedModels = new Set<number>()
  /** Failed regions and when they failed (ms). */
  private readonly failedAt = new Map<number, number>()
  private readonly waiters: Waiter[] = []
  private readonly steps: CommitStep[] = []
  /** Commit steps waiting for their debounce (due = clock ms). */
  private readonly pendingSteps: { chunk: RegionChunk; step: CommitStep; due: number }[] = []
  private readonly focus = { x: 0, z: 0 }
  private readonly lastFocus = { x: NaN, z: NaN }
  private forward: { x: number; z: number } | null = null
  private lastForwardAngle = NaN
  private dirty = true
  private seq = 0
  private lastUpdate = -Infinity
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private readonly bytesAtStart: number
  private disposed = false
  /** Larger budget until the app takes over (loadWorld resolves). */
  booting = true
  /** W10-S: the merge worker factory the batch part uses (StreamHooks.batchWorker; null: the part's own). */
  readonly batchWorker: BatchWorkerFactory | null

  constructor(readonly world: World, settings: StreamSettings, hooks: StreamHooks = {}) {
    this.settings = { ...settings }
    this.now = hooks.now ?? (() => performance.now())
    this.batchWorker = hooks.batchWorker ?? null
    if (hooks.batcher !== undefined) world.objects.setBatcher(hooks.batcher)
    this.limiter = new Limiter(Math.max(1, settings.maxFetches))
    this.nav = hooks.nav ?? { kind: 'memory', load: async () => null }
    this.objects = hooks.objects ?? true
    this.animated = hooks.animated ?? true
    this.minimap = hooks.minimap ?? !!world.minimap?.tileMode
    this.bytesAtStart = world.assets.bytes
    this.regions = regionInfos(world)
    const lightmaps = hooks.lightmaps ?? true
    const loadModel = hooks.loadModel ?? (async (model: WorldModel): Promise<CachedModel> => {
      const assets = world.assets
      const [container, sidecar] = await Promise.all([
        loadGlb(world.scene, assets, model.glb!),
        model.sidecar ? assets.json<SidecarLite>(model.sidecar).catch(() => null) : Promise.resolve(null),
      ])
      if (this.disposed) {
        container.dispose()
        throw new Error('streamer disposed')
      }
      const converted = await world.materials.convert(container, sidecar, lightmaps, {
        model: model.glb!, source: model.source, kind: model.kind === 'skinned' ? 'clone' : 'static', ...(model.cloth ? { cloth: model.cloth } : {}),
      })
      return { model, container, converted, prep: model.kind === 'static' ? prepareStatic(container) : null }
    })
    const disposeModel = hooks.disposeModel ?? ((e: CachedModel) => {
      if (e.converted) world.materials.release(e.converted)
      e.container.dispose()
    })
    this.models = new ModelCache<CachedModel>({
      load: index => this.limiter.run(() => this.modelPriority(index), () => loadModel(world.manifest.models[index]!)),
      dispose: disposeModel,
      graceS: settings.modelGraceS,
      max: settings.modelCacheMax,
      now: this.now,
    })
    const tiles = new Map(world.manifest.tiles.map(t => [t.id, t]))
    this.tiles = tiles
    this.customAtlas = !!hooks.atlas
    this.atlasPbr = !this.customAtlas && world.render?.mode === 'pbr'
    // TX-R: map sets load after everything the regions need (materials.ts objects, the terrain upgrade below).
    const mapLimiter = new Limiter(MAP_REQUESTS)
    this.mapScheduler = {
      request: fn => mapLimiter.run(() => 0, () => this.limiter.run(() => MAP_PRIORITY, fn)),
      job: run => this.push(null, MAP_PRIORITY, run),
    }
    world.materials?.pbr?.cache.setScheduler(this.mapScheduler)
    this.atlas = new TileAtlas({
      scene: world.scene,
      size: settings.tileSize,
      layers: settings.tileLayers,
      decode: hooks.atlas?.decode ?? ((id, size, pri) => this.limiter.run(pri, async () => {
        const tile = tiles.get(id)
        if (!tile) throw new Error(`tile ${id} is not in manifest.tiles`)
        return (await world.assets.image(tile.file, size)).data
      })),
      schedule: (run, pri) => this.push(null, pri, run),
      onTexture: tex => world.terrain.setTileArray(tex),
      onMapTexture: (plane, tex) => world.terrain.setMapArrays({ [plane]: tex }),
      onTierTexture: (tex, layers) => world.terrain.setTierArray(tex, layers),
      // The texture sets of the PBR terrain (TX-R): only when the world starts on the PBR path (Low stays HEAD's).
      prepare: this.atlasPbr ? () => this.tileSetup(tiles) : undefined,
      create: hooks.atlas?.create,
      upload: hooks.atlas?.upload,
      rebuild: hooks.atlas?.rebuild,
    })
    if (hooks.autoPump ?? true) this.schedulePump()
  }

  /** TX-R: where map-set work runs (after every region job and request). */
  readonly mapScheduler: MapScheduler

  /**
   * TX-R: the terrain's texture-set planes (TileAtlas `prepare`): the map sets of the tiles (pbr/maps.ts, `tile2d:<stem>`
   * keys, D36) under the preset's tier. Medium: the retail-size remaster in the base array plus ORMH at half size;
   * High/Ultra: plus the tier plane (1024², 48 layers) and normal maps at the base size (the preset's layer normals).
   * Tiles commit with their retail layers; the set layers swap in afterwards at the lowest priority (TileUpgrade).
   * TT-R (TERRAIN_TEX §5.2, D7): the set range admits only the tiles whose set has maps under the policy (the hero
   * sets), min(48, hero) deep, its last 8 layers kept for above-median cover (planSetRange); every other set tile
   * still swaps in its remastered albedo, in a layer above the range.
   */
  private async tileSetup(tiles: Map<number, { id: number; file: string }>): Promise<TileAtlasSetup | null> {
    const pbr = this.world.materials?.pbr
    if (!pbr) return null
    const index = await pbr.maps()
    const policy = pbr.policy()
    const sets = new Map<number, TileMaps>()
    for (const t of tiles.values()) {
      const stem = (t.file.replace(/\\/g, '/').split('/').pop() ?? '').replace(/\.[^.]*$/, '').toLowerCase()
      const set = index.tile(stem, policy)
      if (set) sets.set(t.id, set)
    }
    if (!sets.size) return null
    const source = pbr.cache.source
    const decode = source.decode?.bind(source)
    if (!decode) return null
    const base = this.settings.tileSize
    const info = new Map<number, TileSetInfo>()
    for (const [id, s] of sets) info.set(id, { maps: !!(s.normal || s.ormh), cover: s.cover })
    const range = planSetRange(info)
    const withMaps = [...sets.values()].filter(s => s.normal || s.ormh)
    const normals = this.world.render.quality.terrain.layerNormals && withMaps.some(s => s.normal)
    const ormh = withMaps.some(s => s.ormh)
    // The tier plane costs the terrain one more texture unit: High's full define set already uses all 16 of WebGL2 (the
    // splat, maps, detail, wet map, ripples, shelter, cloud noise, the fog ring, CSM, IBL, the cluster; D32), so the
    // tier needs a device with more units (WebGPU with setMaximumLimits) and the night splat off (High, Ultra; D29).
    // Elsewhere the High terrain takes the retail-size remaster from the base array.
    const quality = this.world.render.quality
    const units = (this.world.scene.getEngine().getCaps() as { maxTexturesImageUnits?: number }).maxTexturesImageUnits ?? 16
    const tier = (policy.tier === '2x' || policy.tier === 2048) && !quality.nightLights.terrainSplat && units > 16
    const ormhSize = tier ? base : Math.max(1, base >> 1)
    // The set range: the hero tiles' layers (the map and tier planes are this deep, not the atlas' capacity).
    const depth = range.layers
    const run = (job: Parameters<typeof decode>[0]) => decode(job).then(tileImageOf)
    const upgradeJob = (set: TileMaps, plane: TilePlane, size: number) => {
      if (plane === 'albedo' || plane === 'tier') return set.albedo(size)
      if (plane === 'normal') return set.normal?.(size) ?? null
      return set.ormh?.(size) ?? null
    }
    console.info(`[world] terrain texture sets: ${sets.size} tiles (${policy.tier}${tier && depth ? `, tier ${TIER_SIZE}²` : ''}, ${depth} set layers${range.reserved ? `, ${range.reserved} reserved` : ''})`)
    return {
      maps: {
        ...(normals ? { normal: { size: base, decode: () => Promise.resolve(null) } } : {}),
        ...(ormh ? { ormh: { size: ormhSize, decode: () => Promise.resolve(null) } } : {}),
      },
      tier: tier && depth
        ? {
          size: TIER_SIZE,
          layers: depth,
          has: range.has,
          // First content of a tier layer: the retail tile at the tier size (the set swaps in after).
          decode: (id, size, pri) => this.limiter.run(pri, () => {
            const t = tiles.get(id)
            if (!t) return Promise.reject(new Error(`tile ${id} is not in manifest.tiles`))
            return run({ kind: 'image', url: this.world.assets.url(t.file), size, levels: true })
          }),
        }
        : null,
      sets: depth ? range : null,
      upgrade: {
        has: id => sets.has(id),
        decode: (id, plane, size) => {
          const set = sets.get(id)
          const job = set ? upgradeJob(set, plane, size) : null
          return job ? run(job) : Promise.resolve(null)
        },
        request: fn => this.mapScheduler.request(fn),
        job: run => this.mapScheduler.job(run),
      },
    }
  }

  // ---- ChunkHost ------------------------------------------------------------------------------------------------

  request<T>(chunk: RegionChunk, fn: () => Promise<T>, offset = 0): Promise<T> {
    return this.limiter.run(() => (chunk.alive ? chunk.priority + offset : Infinity), fn)
  }

  schedule(chunk: RegionChunk, offset: number, run: () => void): void {
    this.push(chunk, chunk.priority + offset, run)
  }

  acquireModel(chunk: RegionChunk, index: number): Promise<CachedModel> {
    return this.models.acquire(index, chunk.owner)
  }

  committed(chunk: RegionChunk, stage: CommitStepAfter): void {
    for (const step of this.steps) if (step.after === stage) this.queueStep(chunk, step)
  }

  changed(chunk: RegionChunk, event: RegionEvent): void {
    if (event === 'objects') this.committed(chunk, 'objects')
    if (event === 'failed') this.failedAt.set(chunk.id, this.now())
    if (event === 'ready' && rectDistance(this.world.spawn.x, this.world.spawn.z, chunk.info) === 0) this.world.relocateSpawn()
    if (event === 'ready') {
      // Scatter (W5-G): registered from the region's last commit job; cheap, its chunks grow lazily in World.update.
      const data = this.world.regions.get(chunk.id)
      if (data) this.world.scatter?.addRegion(data)
    }
    this.onRegion?.(chunk.info.x, chunk.info.z, event)
    this.checkWaiters()
  }

  modelFailed(index: number, err: unknown): void {
    if (this.failedModels.has(index) || this.disposed) return
    this.failedModels.add(index)
    const model = this.world.manifest.models[index]
    this.world.objects.errors.push(`${model?.glb ?? `model ${index}`}: ${errorText(err)}`)
    console.warn('[world] model', model?.glb, err)
  }

  /** A model load's priority: the nearest region still wanting it, behind terrain (JOB_OBJECTS). */
  private modelPriority(index: number): number {
    if (this.models.refs(index) === 0) return Infinity
    let best = Infinity
    for (const c of this.chunks.values()) if (c.alive && c.priority < best && c.info.models.has(index)) best = c.priority
    return best + JOB_OBJECTS
  }

  private push(chunk: RegionChunk | null, pri: number, run: () => void): void {
    this.jobs.push({ pri, seq: this.seq++, chunk, run })
  }

  // ---- commit steps (wave 9 seam) -------------------------------------------------------------------------------

  /**
   * Adds a per-region commit step (docs/WAVE_PLAN3.md §4.1). It runs once per region, as its own job, after that
   * region's terrain commit ('terrain') or once all of its objects are placed ('objects'); regions already past that
   * point get it queued now. Unloaded regions skip it (their jobs die with the chunk). Returns a remover.
   */
  addCommitStep(name: string, run: (region: RegionData) => void, after: CommitStepAfter, debounceMs = 0): () => void {
    const step: CommitStep = { name, run, after, debounceMs: Math.max(0, debounceMs) }
    this.steps.push(step)
    for (const c of this.chunks.values()) if (after === 'terrain' ? c.terrainCommitted : c.objectsReady) this.queueStep(c, step)
    return () => {
      const i = this.steps.indexOf(step)
      if (i >= 0) this.steps.splice(i, 1)
      for (let j = this.pendingSteps.length - 1; j >= 0; j--) if (this.pendingSteps[j]!.step === step) this.pendingSteps.splice(j, 1)
    }
  }

  /**
   * Work is queued or in flight: budgeted jobs, debounced commit steps, fetches. The game's frame-time watchdog does
   * not judge while it is (W9A perf pass: a path or preset switch streams and compiles for 5–26 s).
   */
  get busy(): boolean {
    return this.jobs.size > 0 || this.pendingSteps.length > 0 || this.limiter.active > 0 || this.limiter.queued > 0
  }

  /** Commit steps registered (names, in order). */
  get commitSteps(): string[] {
    return this.steps.map(s => s.name)
  }

  private queueStep(chunk: RegionChunk, step: CommitStep): void {
    if (step.debounceMs > 0) {
      const due = this.now() + step.debounceMs
      const have = this.pendingSteps.find(p => p.chunk === chunk && p.step === step)
      if (have) have.due = due
      else this.pendingSteps.push({ chunk, step, due })
      return
    }
    this.pushStep(chunk, step)
  }

  private pushStep(chunk: RegionChunk, step: CommitStep): void {
    const offset = step.after === 'terrain' ? JOB_CORE : JOB_OBJECTS
    this.push(chunk, chunk.priority + offset, () => {
      if (!this.steps.includes(step)) return
      const data = this.world.regions.get(chunk.id)
      if (data) step.run(data)
    })
  }

  private releaseDueSteps(now: number): void {
    for (let i = this.pendingSteps.length - 1; i >= 0; i--) {
      const p = this.pendingSteps[i]!
      if (!p.chunk.alive) this.pendingSteps.splice(i, 1)
      else if (now >= p.due) {
        this.pendingSteps.splice(i, 1)
        this.pushStep(p.chunk, p.step)
      }
    }
  }

  /**
   * Drops every resident region and every unused cached model at once, then loads the wanted set again (the render
   * path switch, World.setRenderMode: every material is rebuilt on the new path). Models still loading when this runs
   * keep the path they were converted with until evicted.
   */
  rebuild(opts: { atlas?: boolean } = {}): void {
    if (this.disposed) return
    for (const c of [...this.chunks.values(), ...this.releasing]) {
      const wasReady = c.state === 'ready' || c.objectsReady
      c.unload()
      this.world.scatter?.removeRegion(c.id)
      if (wasReady) this.onRegion?.(c.info.x, c.info.z, 'unloaded')
    }
    this.chunks.clear()
    this.releasing.clear()
    this.pendingSteps.length = 0
    // The tile arrays follow the path: every region let go of its tiles above, so a fresh atlas costs only the retail
    // re-decodes of the tiles the regions ask for again.
    const pbr = !this.customAtlas && this.world.render?.mode === 'pbr'
    // `atlas`: the arrays lost their content (a WebGL context restore; World.onContextRestored).
    if (pbr !== this.atlasPbr || opts.atlas) {
      this.atlasPbr = pbr
      if (!pbr) {
        this.world.terrain.setMapArrays({ normal: null, ormh: null })
        this.world.terrain.setTierArray(null, 0)
      }
      this.atlas = this.atlas.respawn(pbr ? () => this.tileSetup(this.tiles) : undefined)
    }
    const { graceS, max } = this.models
    this.models.setLimits(0, 0)
    this.models.update(this.now(), Infinity)
    this.models.setLimits(graceS, max)
    this.dirty = true
    if (this.lastFocus.x === this.lastFocus.x) this.recompute()
  }

  /**
   * W12-SA (S-OBJ; docs/WORLD_EDITOR.md §2.3, §9.3 item 1; docs/WAVE_PLAN8.md §4.2 step 4): places region (rx, rz)'s
   * objects again, alone: its models from the cache (a model new to it is loaded first), the world's editor-owned
   * filter (WorldObjects.setEditorOwned) applied, one region re-batched through the merge worker inside the frame
   * budget, swapped in for the old set in one turn; the other regions are untouched. `placements`: the region's new
   * placement list (the editor's moves, adds and deletes, homed to this region), kept for its later stream-ins too;
   * absent: its current list. Resolves true once swapped; false when the region is not resident (a new list still
   * applies when it streams in) or went first, or objects are off.
   */
  reloadObjects(rx: number, rz: number, opts: { placements?: readonly WorldPlacement[] } = {}): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const id = (rz << 8) | rx
    const info = this.regions.find(r => r.id === id)
    if (!info) return Promise.resolve(false)
    if (opts.placements) {
      info.models.clear()
      for (const p of opts.placements) {
        for (const mi of p.models) {
          const list = info.models.get(mi)
          if (list) list.push(p)
          else info.models.set(mi, [p])
        }
      }
      info.placements = opts.placements.length
    }
    const chunk = this.chunks.get(id)
    if (!chunk || !chunk.alive) return Promise.resolve(false)
    return chunk.reloadObjects()
  }

  // ---- per frame --------------------------------------------------------------------------------------------------

  /** Per frame (World.update): refresh the wanted set if the focus/camera moved enough, fetch, commit within budget. */
  update(focus: { x: number; z: number }, forward: { x: number; z: number } | null): void {
    if (this.disposed) return
    const t0 = this.now()
    this.lastUpdate = t0
    this.focus.x = focus.x
    this.focus.z = focus.z
    if (forward && (forward.x !== 0 || forward.z !== 0)) {
      const a = Math.atan2(forward.x, forward.z)
      let turn = Math.abs(a - this.lastForwardAngle)
      if (turn > Math.PI) turn = 2 * Math.PI - turn
      if (!(turn <= RETURN_RAD)) this.dirty = true
      this.forward ??= { x: 0, z: 0 }
      this.forward.x = forward.x
      this.forward.z = forward.z
    }
    if (!(Math.hypot(this.focus.x - this.lastFocus.x, this.focus.z - this.lastFocus.z) <= REFOCUS_M)) this.dirty = true
    if (this.dirty) this.recompute()
    this.step(t0)
  }

  /** Re-centre at once (teleport, respawn, worldEnter) and drop the queue order. */
  setFocus(x: number, z: number): void {
    if (this.disposed) return
    this.focus.x = x
    this.focus.z = z
    this.recompute()
  }

  /** The current focus (glTF metres). */
  get focusPoint(): { x: number; z: number } {
    return { x: this.focus.x, z: this.focus.z }
  }

  /** Applies new settings (decision 50: the graphics preset; radii, budget, fetches and cache limits apply at once). */
  setSettings(partial: Partial<StreamSettings>): void {
    const s = this.settings
    Object.assign(s, partial)
    if (s.unloadRadiusM < s.loadRadiusM) s.unloadRadiusM = s.loadRadiusM
    this.limiter.max = Math.max(1, s.maxFetches)
    this.limiter.next()
    this.models.setLimits(s.modelGraceS, s.modelCacheMax)
    this.dirty = true
    if (!this.disposed && this.lastFocus.x === this.lastFocus.x) this.recompute()
  }

  /** Runs one budgeted pass without moving the focus (the idle pump; tests). */
  pump(): void {
    if (!this.disposed) this.step(this.now())
  }

  private step(t0: number): void {
    const budget = this.booting ? Math.max(BOOT_BUDGET_MS, this.settings.frameBudgetMs) : this.settings.frameBudgetMs
    if (this.pendingSteps.length) this.releaseDueSteps(t0)
    let ran = 0
    for (;;) {
      const job = this.jobs.pop()
      if (!job) break
      if (job.chunk && !job.chunk.alive) continue
      try {
        job.run()
      } catch (err) {
        console.warn('[world] stream job failed:', err)
      }
      ran++
      if (this.now() - t0 >= budget) break
    }
    this.models.update(this.now(), EVICT_PER_FRAME)
    if (this.failedAt.size) this.retryFailed()
    if (ran) this.checkWaiters()
    const ms = this.now() - t0
    this.stats.lastFrameMs = ms
    if (!this.booting && ms > this.stats.worstFrameMs) this.stats.worstFrameMs = ms
    this.refreshStats()
  }

  /** Wanted set, unloads, priorities and new fetches for the current focus and view direction. */
  private recompute(): void {
    this.dirty = false
    this.lastFocus.x = this.focus.x
    this.lastFocus.z = this.focus.z
    const fwd = this.forward
    const fl = fwd ? Math.hypot(fwd.x, fwd.z) : 0
    if (fwd && fl > 0) this.lastForwardAngle = Math.atan2(fwd.x, fwd.z)
    const { loadRadiusM, unloadRadiusM, viewBias } = this.settings
    const fx = this.focus.x
    const fz = this.focus.z
    let wanted = 0
    const start: RegionChunk[] = []
    for (const info of this.regions) {
      const d = rectDistance(fx, fz, info)
      let key = d
      if (fwd && fl > 0 && d > 0) {
        const dx = info.cx - fx
        const dz = info.cz - fz
        const dl = Math.hypot(dx, dz)
        const cos = dl > 0 ? (dx * fwd.x + dz * fwd.z) / (dl * fl) : 0
        key = d * (1 - viewBias * Math.max(0, cos))
      }
      let chunk = this.chunks.get(info.id)
      if (chunk && d > unloadRadiusM) {
        this.unload(chunk)
        chunk = undefined
      }
      if (d <= loadRadiusM) {
        wanted++
        if (!chunk) {
          chunk = new RegionChunk(info, this)
          this.chunks.set(info.id, chunk)
          start.push(chunk)
        }
      }
      if (chunk) {
        chunk.distance = d
        chunk.priority = key
      }
    }
    this.stats.wanted = wanted
    start.sort((a, b) => a.priority - b.priority)
    for (const c of start) c.start()
    this.limiter.next()
    this.checkWaiters()
  }

  /** Drops failed regions after RETRY_MS so the next recompute fetches them again (a network hiccup is not final). */
  private retryFailed(): void {
    const now = this.now()
    for (const [id, t] of this.failedAt) {
      if (now - t < RETRY_MS) continue
      this.failedAt.delete(id)
      const chunk = this.chunks.get(id)
      if (!chunk || chunk.state !== 'failed') continue
      this.release(chunk)
      this.dirty = true
    }
    if (this.dirty && this.lastFocus.x === this.lastFocus.x) this.recompute()
  }

  private unload(chunk: RegionChunk): void {
    const wasReady = chunk.state === 'ready'
    this.release(chunk)
    this.stats.unloads++
    if (wasReady || chunk.objectsReady) this.onRegion?.(chunk.info.x, chunk.info.z, 'unloaded')
  }

  /** Stops a chunk now and disposes it through budgeted jobs: its core first, then its objects, then its models. */
  private release(chunk: RegionChunk): void {
    chunk.cancel()
    this.chunks.delete(chunk.id)
    this.releasing.add(chunk)
    const removeObjects = (): void => {
      // W12-SA: every object owner of the chunk (a reload's new set too).
      if (chunk.removeObjects(REMOVE_PER_JOB) > 0) this.push(null, UNLOAD_PRIORITY, removeObjects)
      else {
        chunk.releaseModels()
        this.releasing.delete(chunk)
      }
    }
    this.push(null, UNLOAD_PRIORITY, () => {
      this.world.scatter?.removeRegion(chunk.id)
      chunk.disposeCore()
      removeObjects()
    })
  }

  private refreshStats(): void {
    const s = this.stats
    let ready = 0, objects = 0, fetching = 0, committing = 0, failed = 0
    for (const c of this.chunks.values()) {
      if (c.state === 'ready') {
        ready++
        if (c.objectsReady) objects++
      } else if (c.state === 'fetching' || c.state === 'queued') fetching++
      else if (c.state === 'decoded' || c.state === 'committing') committing++
      else if (c.state === 'failed') failed++
    }
    s.ready = ready
    s.objectsReady = objects
    s.resident = this.chunks.size
    s.fetching = fetching
    s.committing = committing
    s.failed = failed
    s.jobs = this.jobs.size
    s.bytes = this.world.assets.bytes - this.bytesAtStart
    const ms = this.models.stats
    s.modelsLoaded = ms.loaded
    s.modelsCached = ms.cached
    s.modelsFailed = ms.failed
    s.tileLayersUsed = this.atlas.used
    s.tileLayers = this.atlas.capacity
    const os = this.world.objects.stats
    os.models = ms.loaded
    os.failed = ms.failed
  }

  // ---- queries --------------------------------------------------------------------------------------------------

  /** The streaming state of region (rx, rz); 'absent' for regions outside the export too. */
  state(rx: number, rz: number): RegionState {
    return this.chunks.get((rz << 8) | rx)?.state ?? 'absent'
  }

  /** Resident chunk of region (rx, rz), if any. */
  chunk(rx: number, rz: number): RegionChunk | null {
    return this.chunks.get((rz << 8) | rx) ?? null
  }

  /** Region (rx, rz) of glTF (x, z) by the origin rule. */
  regionOf(x: number, z: number): { rx: number; rz: number } {
    const sp = this.world.manifest.space
    const size = sp.regionSizeM || 192
    return { rx: sp.originRegion.x + Math.floor(x / size), rz: sp.originRegion.z + Math.floor(-z / size) }
  }

  /** True when every region under the segment's bounding box is ready (nav prediction guard, §3.8). */
  navCovers(x0: number, z0: number, x1: number, z1: number): boolean {
    const a = this.regionOf(Math.min(x0, x1), Math.max(z0, z1))
    const b = this.regionOf(Math.max(x0, x1), Math.min(z0, z1))
    for (let rz = a.rz; rz <= b.rz; rz++) {
      for (let rx = a.rx; rx <= b.rx; rx++) if (this.chunks.get((rz << 8) | rx)?.state !== 'ready') return false
    }
    return true
  }

  /**
   * Resolves when every export region within radiusM (default 200, at most the load radius) of (x, z) is ready, its
   * objects included unless `objects` is false. Failed regions count as done. Meant for the focus (after setFocus);
   * a point far from the focus resolves only once the focus comes near it. Resolves at once after dispose.
   */
  whenReady(x: number, z: number, radiusM = READY_RADIUS_M, objects = true): Promise<void> {
    return new Promise<void>(resolve => {
      this.waiters.push({ x, z, radius: radiusM, objects, resolve })
      this.checkWaiters()
    })
  }

  /** Ready / wanted counts around (x, z) for a loading bar (the same test as whenReady). */
  progress(x: number, z: number, radiusM = READY_RADIUS_M, objects = true): { done: number; total: number } {
    const r = Math.min(radiusM, this.settings.loadRadiusM)
    let done = 0, total = 0
    for (const info of this.regions) {
      if (rectDistance(x, z, info) > r) continue
      total++
      if (this.isDone(info.id, objects)) done++
    }
    return { done, total }
  }

  private isDone(id: number, objects: boolean): boolean {
    const c = this.chunks.get(id)
    if (!c) return false
    if (c.state === 'failed') return true
    return c.state === 'ready' && (!objects || c.objectsReady)
  }

  private checkWaiters(): void {
    if (!this.waiters.length) return
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!
      const p = this.progress(w.x, w.z, w.radius, w.objects)
      if (p.done === p.total || this.disposed) {
        this.waiters.splice(i, 1)
        w.resolve()
      }
    }
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------

  private schedulePump(): void {
    const tick = (): void => {
      this.pumpTimer = null
      if (this.disposed) return
      if (this.now() - this.lastUpdate > 100) {
        if (this.dirty && this.lastFocus.x === this.lastFocus.x) this.recompute()
        this.step(this.now())
      }
      this.pumpTimer = setTimeout(tick, this.booting ? 1 : 50)
      // Node (tests, scripts): once loaded, an idle world does not keep the process alive.
      if (!this.booting) (this.pumpTimer as { unref?: () => void }).unref?.()
    }
    this.pumpTimer = setTimeout(tick, 1)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.pumpTimer !== null) clearTimeout(this.pumpTimer)
    this.pumpTimer = null
    for (const c of [...this.chunks.values(), ...this.releasing]) c.unload()
    this.chunks.clear()
    this.releasing.clear()
    this.jobs.clear()
    this.limiter.clear()
    this.models.dispose()
    this.atlas.dispose()
    const cache = this.world.materials?.pbr?.cache
    if (cache?.scheduler === this.mapScheduler) cache.setScheduler(null)
    for (const w of this.waiters.splice(0)) w.resolve()
  }
}
