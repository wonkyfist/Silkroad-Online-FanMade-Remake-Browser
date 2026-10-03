/**
 * Terrain tile atlas for region streaming (docs/FIELDS.md §3.5): one fixed-capacity RGBA texture array of `size`²
 * layers shared by every streamed terrain material, a map from tile id to layer and a reference count per tile.
 *
 * - A region acquires its tiles before its terrain commits and releases them when it unloads, so a region's layer map
 *   (written with the layers valid at commit time) never changes meaning: a layer is reused only once its tile has no
 *   reference left (the least recently used such tile goes first).
 * - Tiles are decoded off the frame budget; each upload (one layer and its mips) is one main-thread job.
 * - When every layer is taken the array grows by `growBy` layers: a new array is filled with every resident tile at
 *   its same layer (from the CPU cache, else decoded again) and swapped in (onTexture), so no layer map changes.
 * - If the engine cannot upload a single layer, every upload rebuilds the whole array from CPU copies (fallback mode,
 *   logged once).
 *
 * Wave 9 (docs/WAVE_PLAN3.md §6.11, D39; RENDER §6.1): optional **map planes**, a `normal` and an `ormh` array
 * parallel to the albedo array with the same layer index per tile. They exist only when the caller passes a map
 * source (a texture set provides them, 9B); without one nothing below changes and no extra VRAM is taken. A tile whose
 * set has no such map gets a neutral layer. Every plane is uploaded in the same job as the albedo, grows and falls back
 * with it, and a tile's layer is freed in all planes at once.
 *
 * Wave 9B (TX-R, D39, D42; TEXPIPE §6.5): `prepare` configures the planes once the texture sets are known (tiles wait
 * for it), and a tile may come with its mip levels from the decode worker (uploaded as given). The optional tier plane
 * is a higher-resolution albedo (High: 1024²) for the first 48 layers only: set tiles take those layers first, other
 * tiles the rest, and a set tile beyond the cap overflows to a base (512) layer. The tier plane never grows, is not
 * kept on the CPU and is dropped in fallback mode (its layers then read the base array).
 *
 * Wave 12 (TT-R, TERRAIN_TEX §5.2, WAVE_PLAN8 D7): the set range admits only the tiles whose set has maps under the
 * policy (the hero sets; planSetRange), so its planes stay min(48, hero) deep and a non-hero set keeps its remastered
 * albedo above the range. A layer never moves while a region references it, so importance acts at placement only: the
 * last `reserved` range layers (8) take only tiles at or above the median cover; a below-median tile never takes one
 * (it overflows above the range: the 512 base, neutral maps).
 */
import type { BaseTexture, Scene } from '@babylonjs/core'
import { createEmptyTextureArray, createTextureArray, uploadTextureLayer } from './textures.ts'

/**
 * The atlas planes: the albedo (always), the optional per-layer maps, and the optional tier plane (TX-R: a
 * higher-resolution albedo for the first `layers` layers).
 */
export type TilePlane = 'albedo' | 'normal' | 'ormh' | 'tier'
export type TileMapPlane = 'normal' | 'ormh'
export const TILE_MAP_PLANES: readonly TileMapPlane[] = ['normal', 'ormh']

/**
 * The tier plane's layer cap (TEXPIPE §6.5, D39: at most 48 layers at 1024², the rest overflow to the 512 base array).
 * The terrain shader samples the tier plane for layers below it (pbr/terrain-plugin.ts SRO_T_TIER).
 */
export const TILE_TIER_LAYERS = 48

/** TT-R (TERRAIN_TEX §5.2 item 4): the last range layers kept for tiles at or above the median cover. */
export const TILE_RESERVED_LAYERS = 8

/**
 * A decoded layer: level 0 (size × size RGBA8) and, when the decode worker made them (TX-R, D42), the mip levels
 * 1..n, uploaded as given (no main-thread mip work on WebGPU, no generateMipmap over the whole array on WebGL2).
 */
export interface TileImage {
  data: Uint8Array
  levels?: Uint8Array[]
}

/** What a decode resolves with: level 0 alone (retail tiles, as before wave 9B) or a TileImage. */
export type TileData = Uint8Array | TileImage

const imageOf = (d: TileData): TileImage => (d instanceof Uint8Array ? { data: d } : d)

/** Neutral map layers: a flat normal (RG = 0.5), and ORMH = AO 1, roughness 0.85, metal 0, height 0.5. */
export const NEUTRAL_MAP: Readonly<Record<TileMapPlane, readonly [number, number, number, number]>> = {
  normal: [128, 128, 255, 255],
  ormh: [255, 217, 0, 128],
}

/** One map plane's source (TileAtlasOptions.maps). */
export interface TileMapSource {
  /** Layer edge in pixels (default: the albedo size; D39 caps maps below the albedo on High). */
  size?: number
  /**
   * Fetches and decodes one tile's map (RGBA at `size` x `size`, optionally with its levels), or resolves null when the
   * tile's set has no such map (the neutral layer is used). `priority` as for the albedo.
   */
  decode: (tileId: number, size: number, priority: () => number) => Promise<TileData | null>
  /** The layer for a tile without this map (default NEUTRAL_MAP). */
  neutral?: readonly [number, number, number, number]
}

/**
 * TX-R (docs/WAVE_PLAN3.md D39, TEXPIPE §6.5): the tier plane, a second albedo array at `size` (High: 1024²) holding
 * only the first `layers` layers (the 48-layer cap). Tiles with a remastered set take a layer in that range when one is
 * free; the rest, and every set tile beyond the cap, sit in the base array only (the 512 overflow). The terrain shader
 * samples the tier plane for a layer below the cap and the base array otherwise, so the layer map needs no new bits
 * and the Classic path (base array only) never changes.
 */
export interface TileTierSource {
  /** Layer edge of the tier plane (larger than the base size). */
  size: number
  /** Layers of the tier plane (the cap). */
  layers: number
  /** The tile has a remastered set and asks for a tier layer. */
  has: (tileId: number) => boolean
  /** The tile at the tier size with its levels (a tile without a set that lands in the range: its retail tile resized). */
  decode: (tileId: number, size: number, priority: () => number) => Promise<TileData>
}

/**
 * TX-R: the progressive swap of the terrain (TEXPIPE §6.4): a tile commits with its first layers (the retail tile,
 * neutral maps), so a region never waits for a texture set; then, for a tile with a set, every plane's layer is
 * decoded again from the set and replaced in place (same layer: no layer map changes), at the lowest priority, one
 * upload job per plane.
 */
export interface TileUpgrade {
  /** The tile has a set to swap in. */
  has: (tileId: number) => boolean
  /** One plane's set layer at `size` (null: that plane keeps its first layer). */
  decode: (tileId: number, plane: TilePlane, size: number) => Promise<TileData | null>
  /** Runs the decodes at the lowest request priority (default: at once). */
  request?: <T>(fn: () => Promise<T>) => Promise<T>
  /** Runs one upload job after every other job (default: the atlas' `schedule` at the lowest priority). */
  job?: (run: () => void) => void
}

/**
 * TX-R: the set range. Tiles with a set take layers below `layers` first (the rest take the layers above); the map
 * planes and the tier plane are only that deep, and the terrain shader gives the layers above it neutral maps and the
 * base albedo. Most of a High terrain's VRAM is in these planes, so they are sized to the sets, not the atlas.
 */
export interface TileSetRange {
  layers: number
  has: (tileId: number) => boolean
  /** TT-R: the last `reserved` layers of the range take only `important` tiles (default 0: no reserve). */
  reserved?: number
  /** TT-R: a range tile at or above the median cover (may take a reserved layer). */
  important?: (tileId: number) => boolean
}

/** TT-R: one tile's set as the range sees it (pbr/maps.ts TileMaps): has maps under the policy, and its cover. */
export interface TileSetInfo {
  maps: boolean
  cover: number | null
}

/**
 * TT-R (TERRAIN_TEX §5.2, D7): the set range of a world's tile sets. Only tiles with maps under the policy (the hero
 * sets) are in it, and it is min(`cap`, their count) deep. The last `reserve` layers are kept for the tiles at or above
 * the median cover (of the range tiles that carry one), never more than leave room below them for every below-median
 * tile; without any cover there is no reserve.
 */
export function planSetRange(sets: ReadonlyMap<number, TileSetInfo>, cap = TILE_TIER_LAYERS, reserve = TILE_RESERVED_LAYERS): TileSetRange {
  const ids = new Set<number>()
  for (const [id, s] of sets) if (s.maps) ids.add(id)
  const layers = Math.min(cap, ids.size)
  const covers = [...ids].map(id => sets.get(id)!.cover).filter((c): c is number => c !== null).sort((a, b) => a - b)
  const has = (id: number) => ids.has(id)
  if (!layers || !covers.length) return { layers, has }
  const mid = covers.length >> 1
  const median = covers.length % 2 ? covers[mid]! : (covers[mid - 1]! + covers[mid]!) / 2
  const top = new Set([...ids].filter(id => (sets.get(id)!.cover ?? -1) >= median))
  const reserved = Math.max(0, Math.min(reserve, top.size, layers - (ids.size - top.size)))
  return reserved ? { layers, has, reserved, important: id => top.has(id) } : { layers, has }
}

/** TX-R: what `prepare` returns (the planes the texture sets need; nothing = the 9A atlas). */
export interface TileAtlasSetup {
  maps?: Partial<Record<TileMapPlane, TileMapSource>>
  tier?: TileTierSource | null
  upgrade?: TileUpgrade | null
  /** The set range (default: the tier's `layers` and `has` when there is a tier, else none: planes span every layer). */
  sets?: TileSetRange | null
}

export interface TileAtlasOptions {
  scene: Scene
  /** Layer edge in pixels (tiles are decoded at this size). */
  size: number
  /** Initial capacity in layers. */
  layers: number
  /** Layers added when the array is full (default 16). */
  growBy?: number
  /**
   * Fetches and decodes one tile's RGBA at `size` x `size` (rows as stored), optionally with its levels (a remastered
   * set's tile from the decode worker); `priority` orders the request (lower first).
   */
  decode: (tileId: number, size: number, priority: () => number) => Promise<TileData>
  /** Runs a main-thread job (an upload) within the frame budget; default: at once. */
  schedule?: (run: () => void, priority: number) => void
  /** Called with the texture array whenever it is created or replaced (bind it to the terrain materials). */
  onTexture?: (tex: BaseTexture) => void
  /** Wave 9: the optional map planes (absent: none, and no arrays are allocated). */
  maps?: Partial<Record<TileMapPlane, TileMapSource>>
  /** Called with a map plane's array whenever it is created or replaced (TerrainRenderer.setMapArrays). */
  onMapTexture?: (plane: TileMapPlane, tex: BaseTexture) => void
  /**
   * TX-R: runs once before the first tile loads (tiles wait for it) and returns the planes the texture sets need: map
   * planes and the tier plane, allocated then (D39: only when a set provides them).
   */
  prepare?: () => Promise<TileAtlasSetup | null>
  /**
   * TX-R: called with the tier plane's array (null: none, or it was dropped) and the set range's depth (0: none; the
   * map planes are that deep) (TerrainRenderer.setTierArray).
   */
  onTierTexture?: (tex: BaseTexture | null, layers: number) => void
  /** CPU copies of decoded tiles kept for growth and re-use, in bytes (default 32 MiB). */
  cacheBytes?: number
  /** Test seams: the array factory and the one-layer upload (defaults: textures.ts); `plane` is 'albedo' unless a map. */
  create?: (size: number, layers: number, plane?: TilePlane) => BaseTexture
  upload?: (tex: BaseTexture, layer: number, rgba: Uint8Array, size: number, plane?: TilePlane, levels?: readonly Uint8Array[]) => boolean
  rebuild?: (layers: readonly Uint8Array[], size: number, plane?: TilePlane) => BaseTexture
}

interface TileEntry {
  id: number
  refs: number
  layer: number
  state: 'waiting' | 'loading' | 'ready'
  promise: Promise<void>
  resolve: () => void
  lastUsed: number
  priority: () => number
}

/** One texture array of the atlas (the albedo, a map plane, the tier plane) and its pending successor while growing. */
interface Plane {
  kind: TilePlane
  size: number
  texture: BaseTexture
  pending: BaseTexture | null
  source: TileMapSource | null
  /** The tier plane's source. */
  tier?: TileTierSource
  /** A capped plane's layer count (the tier plane, and the map planes beside it): it holds layers below it, never grows. */
  layers?: number
}

export class TileAtlas {
  texture: BaseTexture
  capacity: number
  /** Whole-array rebuilds so far (growth, or every upload in fallback mode). */
  rebuilds = 0
  /** Single-layer uploads so far (albedo layers). */
  uploads = 0
  /** True once the engine refused a single-layer upload (every upload then rebuilds the array). */
  fallback = false
  private readonly size: number
  private readonly growBy: number
  private readonly entries = new Map<number, TileEntry>()
  private readonly byLayer: (TileEntry | null)[] = []
  private readonly free: number[] = []
  private readonly waiting: TileEntry[] = []
  /** The albedo plane first, then the map planes in TILE_MAP_PLANES order. */
  private readonly planes: Plane[] = []
  /** CPU RGBA copies per plane and tile (LRU by insertion order), bounded by cacheBytes unless in fallback mode. */
  private readonly cpu = new Map<string, Uint8Array>()
  private cpuBytes = 0
  private readonly cacheBytes: number
  private growing: Promise<void> | null = null
  private rebuildQueued = false
  private clock = 0
  private disposed = false
  /** `prepare` still running: tiles wait for it (TX-R). */
  private preparing: Promise<void> | null = null
  /** TX-R: the set range (TileSetRange), null: the planes span every layer. */
  private setRange: TileSetRange | null = null
  /** TT-R: the range's last layers kept for important tiles (0: none). */
  private reserved = 0
  /** TX-R: the set layers swapped in after a tile's first commit. */
  private upgrader: TileUpgrade | null = null
  /** Set layers swapped in so far (tests; the console). */
  upgrades = 0

  constructor(private readonly opts: TileAtlasOptions) {
    this.size = opts.size
    this.growBy = Math.max(1, opts.growBy ?? 16)
    this.capacity = Math.max(1, opts.layers)
    this.cacheBytes = opts.cacheBytes ?? 32 * 1048576
    this.texture = this.create('albedo', this.size, this.capacity)
    this.planes.push({ kind: 'albedo', size: this.size, texture: this.texture, pending: null, source: null })
    for (const kind of TILE_MAP_PLANES) {
      const source = opts.maps?.[kind]
      if (!source) continue
      const size = source.size ?? this.size
      this.planes.push({ kind, size, texture: this.create(kind, size, this.capacity), pending: null, source })
    }
    for (let i = 0; i < this.capacity; i++) this.byLayer.push(null)
    for (let i = this.capacity - 1; i >= 0; i--) this.free.push(i)
    opts.onTexture?.(this.texture)
    for (const p of this.planes) if (p.kind === 'normal' || p.kind === 'ormh') opts.onMapTexture?.(p.kind, p.texture)
    if (opts.prepare) {
      this.preparing = opts.prepare().then(setup => this.configure(setup), err => {
        console.warn('[world] tile atlas: texture sets unavailable; retail tiles only:', err)
      }).finally(() => {
        this.preparing = null
      })
    }
  }

  /** Allocates the planes `prepare` asked for (before any tile loaded). */
  private configure(setup: TileAtlasSetup | null): void {
    if (this.disposed || !setup) return
    // The set range (the terrain shader reads the tier plane and the maps for every layer below it, so the planes hold
    // all of them) and the planes: map planes as deep as the range, the tier plane only when larger than the base.
    const range = setup.sets ?? (setup.tier ? { layers: setup.tier.layers, has: setup.tier.has } : null)
    this.setRange = range && range.layers > 0 && range.layers <= this.capacity ? range : null
    this.reserved = this.setRange?.important ? Math.max(0, Math.min(this.setRange.reserved ?? 0, this.setRange.layers)) : 0
    const depth = this.setRange?.layers
    const tier = setup.tier && depth && setup.tier.size > this.size && !this.fallback ? setup.tier : null
    for (const kind of TILE_MAP_PLANES) {
      const source = setup.maps?.[kind]
      if (!source || this.planes.some(p => p.kind === kind)) continue
      const size = source.size ?? this.size
      const plane: Plane = { kind, size, texture: this.create(kind, size, depth ?? this.capacity), pending: null, source }
      if (depth) plane.layers = depth
      this.planes.push(plane)
      this.opts.onMapTexture?.(kind, plane.texture)
    }
    let tierTex: BaseTexture | null = null
    if (tier && depth) {
      const plane: Plane = { kind: 'tier', size: tier.size, texture: this.create('tier', tier.size, depth), pending: null, source: null, tier, layers: depth }
      this.planes.push(plane)
      tierTex = plane.texture
    }
    if (depth) this.opts.onTierTexture?.(tierTex, depth)
    this.upgrader = setup.upgrade ?? null
  }

  /** The set range's depth (0: none): set tiles sit below it, and the map and tier planes are that deep. */
  get setLayers(): number {
    return this.setRange?.layers ?? 0
  }

  /** TT-R: the reserved range layers (the last ones below setLayers; 0: none). */
  get reservedLayers(): number {
    return this.reserved
  }

  /**
   * The progressive swap of one committed tile (TileUpgrade): every plane's set layer, decoded at the lowest priority
   * and uploaded in place, one job per plane, while the tile still holds the same layer.
   */
  private upgradeTile(e: TileEntry): void {
    const u = this.upgrader
    if (!u || this.disposed || !u.has(e.id)) return
    const layer = e.layer
    const planes = this.planes.filter(p => this.inPlane(p, layer))
    const still = () => !this.disposed && this.entries.get(e.id) === e && e.layer === layer && e.state === 'ready'
    const request = u.request ?? (<T>(fn: () => Promise<T>) => fn())
    const job = u.job ?? ((run: () => void) => this.schedule(run, Number.MAX_SAFE_INTEGER))
    void request(() => (still()
      ? Promise.all(planes.map(p => u.decode(e.id, p.kind, p.size).then(d => (d ? imageOf(d) : null), err => {
        console.warn(`[world] tile ${e.id} ${p.kind} set:`, err)
        return null
      })))
      : Promise.resolve(planes.map(() => null)))).then(data => {
      planes.forEach((p, i) => {
        const d = data[i]
        if (!d) return
        job(() => {
          if (!still() || !this.planes.includes(p) || this.fallback) return
          if (this.upload(p, p.texture, layer, d.data, d.levels)) {
            if (p.pending) this.upload(p, p.pending, layer, d.data, d.levels)
            if (p.kind !== 'tier') this.remember(p.kind, e.id, d.data)
            this.upgrades++
          } else if (p.kind === 'tier') this.dropTier()
        })
      })
    })
  }

  /** The tier plane's array (null: none). */
  get tierTexture(): BaseTexture | null {
    return this.tierPlane()?.texture ?? null
  }

  /** Layers of the tier plane (0: none): the terrain samples it for layers below this. */
  get tierLayers(): number {
    return this.tierPlane()?.layers ?? 0
  }

  private tierPlane(): Plane | undefined {
    return this.planes.find(p => p.kind === 'tier')
  }

  /** A map plane's array (null: that plane was not requested). */
  mapTexture(plane: TileMapPlane): BaseTexture | null {
    return this.planes.find(p => p.kind === plane)?.texture ?? null
  }

  /** The planes this atlas keeps ('albedo' first). */
  get planeKinds(): TilePlane[] {
    return this.planes.map(p => p.kind)
  }

  /**
   * Takes a reference on every tile id (from now on, even while loading) and resolves when all of them sit in a layer
   * of `texture`. `priority` (lower first) orders their decode requests.
   */
  acquire(ids: readonly number[], priority: () => number): Promise<void> {
    const waits: Promise<void>[] = []
    for (const id of new Set(ids)) {
      let e = this.entries.get(id)
      if (!e) {
        let resolve!: () => void
        const promise = new Promise<void>(r => { resolve = r })
        e = { id, refs: 0, layer: -1, state: 'waiting', promise, resolve, lastUsed: 0, priority }
        this.entries.set(id, e)
        this.place(e)
      }
      e.refs++
      e.lastUsed = ++this.clock
      if (e.state !== 'ready') waits.push(e.promise)
    }
    return Promise.all(waits).then(() => {})
  }

  /** Drops one reference on every tile id (the tiles stay resident until their layer is needed). */
  release(ids: readonly number[]): void {
    for (const id of new Set(ids)) {
      const e = this.entries.get(id)
      if (!e || e.refs <= 0) continue
      e.refs--
      e.lastUsed = ++this.clock
    }
  }

  /** Layer of a resident tile, or undefined (the same layer in every plane). */
  layerOf(id: number): number | undefined {
    const e = this.entries.get(id)
    return e && e.state === 'ready' ? e.layer : undefined
  }

  /** References on a tile. */
  refs(id: number): number {
    return this.entries.get(id)?.refs ?? 0
  }

  /** Layers holding a tile with at least one reference. */
  get used(): number {
    let n = 0
    for (const e of this.byLayer) if (e && e.refs > 0) n++
    return n
  }

  /** Layers holding a tile (referenced or not). */
  get resident(): number {
    let n = 0
    for (const e of this.byLayer) if (e) n++
    return n
  }

  // ---- layers ---------------------------------------------------------------------------------------------------

  private place(e: TileEntry): void {
    if (this.preparing) {
      void this.preparing.then(() => {
        if (!this.disposed && this.entries.get(e.id) === e && e.state === 'waiting' && e.layer < 0) this.place(e)
      })
      return
    }
    const layer = this.takeLayer(e.id)
    if (layer < 0) {
      this.waiting.push(e)
      void this.grow()
      return
    }
    this.load(e, layer)
  }

  /**
   * A free layer, else the layer of the least recently used unreferenced tile (evicted), else -1. With a set range a
   * set tile prefers a layer below the cap and every other tile one above it (either takes the other range when its
   * own is full: a set tile beyond the cap is the 512 overflow). TT-R: the reserved range layers go only to important
   * tiles (an important tile takes the unreserved ones first); any other tile overflows, or the array grows.
   */
  private takeLayer(id: number): number {
    const cap = this.setLayers
    const set = !!this.setRange?.has(id)
    const open = cap - this.reserved
    const important = this.reserved > 0 && !!this.setRange?.important?.(id)
    const allowed = (layer: number) => important || layer < open || layer >= cap
    const inRange = (layer: number) => (cap <= 0 ? true : set ? layer < cap : layer >= cap)
    let at = -1
    if (this.free.length) {
      for (let i = this.free.length - 1; i >= 0; i--) {
        const layer = this.free[i]!
        if (!allowed(layer)) continue
        if (at < 0) at = i
        if (inRange(layer)) {
          at = i
          break
        }
      }
      if (at >= 0 && (inRange(this.free[at]!) || !set || cap <= 0)) return this.free.splice(at, 1)[0]!
    }
    // H-12 SR-1: a set tile takes a range layer from an unreferenced tile before a free layer above the range (a layer
    // never moves while a region references it, so a set tile above the cap keeps no maps and no tier until it unloads)
    if (set && cap > 0) {
      let lru: TileEntry | null = null
      for (const e of this.byLayer) {
        if (!e || e.refs !== 0 || e.state !== 'ready' || e.layer >= cap || !allowed(e.layer)) continue
        if (!lru || e.lastUsed < lru.lastUsed) lru = e
      }
      if (lru) {
        this.entries.delete(lru.id)
        this.byLayer[lru.layer] = null
        return lru.layer
      }
      if (at >= 0) return this.free.splice(at, 1)[0]!
    }
    let victim: TileEntry | null = null
    for (const e of this.byLayer) {
      if (!e || e.refs !== 0 || e.state !== 'ready' || !allowed(e.layer)) continue
      if (!victim) victim = e
      else if (inRange(e.layer) !== inRange(victim.layer)) {
        if (inRange(e.layer)) victim = e
      } else if (e.lastUsed < victim.lastUsed) victim = e
    }
    if (!victim) return -1
    this.entries.delete(victim.id)
    this.byLayer[victim.layer] = null
    return victim.layer
  }

  private load(e: TileEntry, layer: number): void {
    e.layer = layer
    e.state = 'loading'
    this.byLayer[layer] = e
    // Every plane of the tile, decoded side by side; one job uploads them all (a map that fails is neutral; the tier
    // plane only for a layer below its cap).
    const planes = this.planes.slice()
    Promise.all(planes.map(p => (this.inPlane(p, layer) ? this.decodePlane(p, e) : Promise.resolve(null)))).then(data => {
      if (this.disposed || this.entries.get(e.id) !== e) return
      planes.forEach((p, i) => {
        if (data[i] && p.kind !== 'tier') this.remember(p.kind, e.id, data[i]!.data)
      })
      this.schedule(() => this.commit(e, planes, data), e.priority())
    }, err => {
      console.warn(`[world] tile ${e.id}:`, err)
      if (this.disposed || this.entries.get(e.id) !== e) return
      const data = planes.map(p => (!this.inPlane(p, layer) ? null : p.kind === 'albedo' || p.kind === 'tier' ? { data: magenta(p.size) } : this.neutral(p)))
      this.schedule(() => this.commit(e, planes, data), e.priority())
    })
  }

  /** A layer exists in a plane (the tier plane holds only the layers below its cap). */
  private inPlane(p: Plane, layer: number): boolean {
    return p.layers === undefined || layer < p.layers
  }

  /** One plane's layer for a tile: the CPU copy, else a decode (maps: the neutral layer when absent or failed). */
  private decodePlane(p: Plane, e: TileEntry): Promise<TileImage> {
    const cached = p.kind === 'tier' ? undefined : this.cpu.get(key(p.kind, e.id))
    if (cached) return Promise.resolve({ data: cached })
    if (p.tier) return p.tier.decode(e.id, p.size, e.priority).then(imageOf)
    if (!p.source) return this.opts.decode(e.id, p.size, e.priority).then(imageOf)
    return p.source.decode(e.id, p.size, e.priority).then(d => (d ? imageOf(d) : this.neutral(p)), err => {
      console.warn(`[world] tile ${e.id} ${p.kind} map:`, err)
      return this.neutral(p)
    })
  }

  /** A neutral map layer with its levels (a constant colour, the same on every level). */
  private neutral(p: Plane): TileImage {
    const px = p.source?.neutral ?? NEUTRAL_MAP[p.kind as TileMapPlane]
    const fill = (s: number) => {
      const data = new Uint8Array(s * s * 4)
      for (let i = 0; i < data.length; i += 4) data.set(px, i)
      return data
    }
    const levels: Uint8Array[] = []
    for (let s = p.size >> 1; s >= 1; s >>= 1) levels.push(fill(s))
    return { data: fill(p.size), levels }
  }

  /** Uploads a decoded tile into its layer of every plane (one job). */
  private commit(e: TileEntry, planes: readonly Plane[], data: readonly (TileImage | null)[]): void {
    if (this.disposed || this.entries.get(e.id) !== e) return
    if (!this.fallback) {
      let ok = true
      planes.forEach((p, i) => {
        const d = data[i]
        if (!ok || !d || !this.planes.includes(p)) return
        if (this.upload(p, p.texture, e.layer, d.data, d.levels)) {
          if (p.pending) this.upload(p, p.pending, e.layer, d.data, d.levels)
        } else if (p.kind === 'tier') this.dropTier()
        else ok = false
      })
      if (ok) this.uploads++
      else {
        this.fallback = true
        console.warn('[world] tile atlas: single-layer uploads unavailable; rebuilding the whole array per change')
      }
    }
    e.state = 'ready'
    if (this.fallback) this.queueRebuild()
    e.resolve()
    if (this.upgrader && !this.fallback) this.upgradeTile(e)
  }

  private upload(p: Plane, tex: BaseTexture, layer: number, data: Uint8Array, levels?: readonly Uint8Array[]): boolean {
    if (this.opts.upload) {
      if (p.kind === 'albedo' && !levels) return this.opts.upload(tex, layer, data, p.size)
      return this.opts.upload(tex, layer, data, p.size, p.kind, levels)
    }
    return uploadTextureLayer(this.opts.scene, tex, layer, data, p.size, levels)
  }

  /** The tier plane cannot be filled (a failed upload, or fallback mode): drop it; its layers read the base array. */
  private dropTier(): void {
    const t = this.tierPlane()
    if (!t) return
    this.planes.splice(this.planes.indexOf(t), 1)
    t.texture.dispose()
    this.opts.onTierTexture?.(null, this.setLayers)
  }

  private create(kind: TilePlane, size: number, layers: number): BaseTexture {
    if (this.opts.create) return kind === 'albedo' ? this.opts.create(size, layers) : this.opts.create(size, layers, kind)
    return createEmptyTextureArray(this.opts.scene, size, layers, kind === 'albedo' ? 'terrainTiles' : `terrainTiles_${kind}`)
  }

  private schedule(run: () => void, priority: number): void {
    if (this.opts.schedule) this.opts.schedule(run, priority)
    else run()
  }

  private remember(kind: TilePlane, id: number, data: Uint8Array): void {
    const k = key(kind, id)
    if (this.cpu.has(k)) {
      this.cpu.delete(k)
      this.cpu.set(k, data)
      return
    }
    this.cpu.set(k, data)
    this.cpuBytes += data.byteLength
    if (this.fallback) return
    for (const [ck, v] of this.cpu) {
      if (this.cpuBytes <= this.cacheBytes) break
      this.cpu.delete(ck)
      this.cpuBytes -= v.byteLength
    }
  }

  // ---- whole-array rebuilds -------------------------------------------------------------------------------------

  /** Fallback mode: one rebuild per job pass, from the CPU copies of every resident tile. */
  private queueRebuild(): void {
    if (this.rebuildQueued) return
    this.rebuildQueued = true
    // Fallback mode keeps full-array rebuilds from CPU copies: the tier plane (48 large layers) is not kept then.
    this.dropTier()
    this.schedule(() => {
      this.rebuildQueued = false
      if (this.disposed) return
      for (const p of this.planes) {
        const blank = p.kind === 'albedo' ? new Uint8Array(p.size * p.size * 4) : this.neutral(p).data
        const layers = this.byLayer.slice(0, p.layers ?? this.byLayer.length).map(e => (e && e.state === 'ready' ? this.cpu.get(key(p.kind, e.id)) : undefined) ?? blank)
        const tex = this.opts.rebuild
          ? (p.kind === 'albedo' ? this.opts.rebuild(layers, p.size) : this.opts.rebuild(layers, p.size, p.kind))
          : createTextureArray(this.opts.scene, layers, p.size, p.kind === 'albedo' ? 'terrainTiles' : `terrainTiles_${p.kind}`)
        this.swap(p, tex)
      }
    }, -1)
  }

  private swap(p: Plane, tex: BaseTexture): void {
    const old = p.texture
    p.texture = tex
    if (p.kind === 'albedo') {
      this.texture = tex
      this.rebuilds++
      this.opts.onTexture?.(tex)
    } else if (p.kind !== 'tier') this.opts.onMapTexture?.(p.kind, tex)
    if (old !== tex) old.dispose()
  }

  /** Adds growBy layers: a new array per plane with every resident tile at its same layer, then the waiting tiles. */
  private grow(): Promise<void> {
    if (this.growing) return this.growing
    const run = async (): Promise<void> => {
      const capacity = this.capacity + this.growBy
      console.info(`[world] tile atlas full (${this.capacity} layers): growing to ${capacity}`)
      // The tier plane keeps its size (the cap): only the full-capacity planes grow.
      const growing = this.planes.filter(p => p.layers === undefined)
      if (!this.fallback) for (const p of growing) p.pending = this.create(p.kind, p.size, capacity)
      if (!this.fallback) {
        const resident = this.byLayer.filter((e): e is TileEntry => !!e && e.state === 'ready')
        await Promise.all(resident.map(async e => {
          const data = await Promise.all(growing.map(p => this.decodePlane(p, e).catch(() => null)))
          if (this.disposed) return
          await new Promise<void>(done => this.schedule(() => {
            if (!this.disposed && this.byLayer[e.layer] === e) {
              growing.forEach((p, i) => {
                const d = data[i]
                if (p.pending && d) this.upload(p, p.pending, e.layer, d.data, d.levels)
              })
            }
            done()
          }, e.priority()))
        }))
      }
      if (this.disposed) {
        for (const p of this.planes) p.pending?.dispose()
        return
      }
      for (let i = this.capacity; i < capacity; i++) this.byLayer.push(null)
      for (let i = capacity - 1; i >= this.capacity; i--) this.free.push(i)
      this.capacity = capacity
      if (this.planes[0]!.pending) {
        for (const p of this.planes) {
          const next = p.pending
          if (!next) continue
          p.pending = null
          this.swap(p, next)
        }
        // A set layer whose CPU copy was dropped went back to its first content in the new arrays: swap it in again.
        if (this.upgrader) for (const e of this.byLayer) if (e && e.state === 'ready') this.upgradeTile(e)
      } else this.queueRebuild()
      const waiting = this.waiting.splice(0)
      for (const e of waiting) if (this.entries.get(e.id) === e) this.place(e)
    }
    this.growing = run().finally(() => {
      this.growing = null
    })
    return this.growing
  }

  /**
   * The render path changed (World.setRenderMode, after every region let go of its tiles): disposes this atlas and
   * returns a fresh one with the same options and `prepare` for the new path, so the Classic terrain samples the retail
   * tiles again (no set albedo left in the base array, no upgrader, no set CPU copies; W9F S1/LG-3) and a world that
   * started on Classic gets the PBR texture sets after a live switch (S2).
   */
  respawn(prepare: TileAtlasOptions['prepare']): TileAtlas {
    this.dispose()
    return new TileAtlas({ ...this.opts, prepare })
  }

  dispose(): void {
    this.disposed = true
    for (const p of this.planes) {
      p.texture.dispose()
      p.pending?.dispose()
    }
    this.entries.clear()
    this.cpu.clear()
    this.waiting.length = 0
  }
}

function key(kind: TilePlane, id: number): string {
  return `${kind}:${id}`
}

function magenta(size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 255, 255], i)
  return data
}
