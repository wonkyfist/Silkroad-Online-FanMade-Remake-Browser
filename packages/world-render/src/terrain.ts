import {
  Material,
  Mesh,
  Observable,
  RawTexture,
  ShaderLanguage,
  ShaderMaterial,
  ShaderStore,
  Texture,
  Vector4,
  VertexBuffer,
  VertexData,
  type BaseTexture,
  type PBRMaterial,
  type Scene,
} from '@babylonjs/core'
import { CELLS, GRID, terrainIndices, type TerrainBin } from '../../convert/src/world/format.ts'
import { mapLimit, mimeOf, type Assets } from './assets.ts'
import { WORLD_GROUND_LAYER } from './layers.ts'
import { surfaceAlpha, terrainSurfaceAlpha } from './pbr/classes.ts'
import {
  TERRAIN_FEATURE_DEFINES,
  TerrainPbr,
  featureKey,
  resolveTerrainFeatures,
  type SroTerrainPlugin,
  type TerrainExterns,
} from './pbr/terrain-plugin.ts'
import type { RegionData, WorldRegions } from './regions.ts'
import type { RenderPath, RenderQuality } from './render/quality.ts'
import type { RenderWeather } from './render/weather.ts'
import { DefineSet, SharedUniforms, bindShared } from './shader-chunks.ts'
import {
  TERRAIN_CHUNK_SAMPLERS,
  TERRAIN_SAMPLERS,
  TERRAIN_UNIFORMS,
  terrainFragmentGLSL,
  terrainFragmentWGSL,
  terrainVertexGLSL,
  terrainVertexWGSL,
} from './shaders.ts'
import type { SkyQuality, SkyState } from './sky/types.ts'
import { bakeNormalAt, clampGridRect, editHeights, relayer, renormalRing, type GridRect } from './terrain-edit.ts'
import { createTextureArray, solidTexture } from './textures.ts'
import { TILE_TIER_LAYERS } from './tile-atlas.ts'
import type { WeatherPreset } from './weather/presets.ts'

const TILE_SIZE = 512

export interface TerrainParams {
  lightmap: boolean
  fog: boolean
  fogStartM: number
  fogEndM: number
  /** sqrt(saturate(FogColor)) (TERRAIN.md 5.2). */
  fogColor: [number, number, number]
  shadowColor: [number, number, number]
  view: number
}

/**
 * Per-region texture slots other lanes bind (docs/WAVE_PLAN3.md §4.1): `wetMap` (WX-R, D22), `nightSplat` (NL, D29),
 * `lightmapExtra` (spare; D32's fallback for the wet map's R channel). The texture stays owned by the lane that set it:
 * dispose it on `onRegionDisposed` (the terrain only unbinds it).
 */
export type TerrainRegionSlot = 'wetMap' | 'nightSplat' | 'lightmapExtra'
export const TERRAIN_REGION_SLOTS: readonly TerrainRegionSlot[] = ['wetMap', 'nightSplat', 'lightmapExtra']

/** One region's terrain on the GPU (buildRegion); disposeRegion frees it. */
export interface TerrainRegionGpu {
  id: number
  mesh: Mesh
  /** The material path this region was built on (wave 9: 'pbr' = a PBRMaterial with SroTerrainPlugin, RND-T). */
  path: RenderPath
  /** Classic: the splat ShaderMaterial; PBR: the region's PBRMaterial (its `pbr` plugin holds the splat). */
  material: ShaderMaterial | PBRMaterial
  /** The PBR path's plugin (null on the Classic path). */
  pbr: SroTerrainPlugin | null
  layerMap: RawTexture
  /** The region's lightmap, owned by the region (null: the shared white texture). */
  lightmap: BaseTexture | null
  /** Textures other lanes set with setRegionTexture (both terrain paths read them from here; not owned). */
  textures: Partial<Record<TerrainRegionSlot, BaseTexture>>
}

/**
 * What the PBR terrain follows (World wires its WorldRender, SkySystem and WorldWeather through `follow`; tests pass
 * plain objects): the material path, the render preset, this frame's RenderWeather, the sky preset (cloud shadows) and
 * state (exposure), and the weather level's preset (wet, puddles, ripples, shelter).
 */
export interface TerrainRenderSource {
  readonly render: { readonly mode: RenderPath; readonly quality: Readonly<RenderQuality>; readonly weather: Readonly<RenderWeather> }
  readonly sky?: { readonly quality: Readonly<SkyQuality>; readonly state?: Readonly<SkyState> } | null
  readonly weather?: { readonly preset: Readonly<WeatherPreset> } | null
}

/**
 * One region's edit (WORLD_EDITOR seam S-TERR, WAVE_PLAN8 D5; TerrainRenderer.updateRegion). Absent fields keep what
 * the region has.
 */
export interface TerrainRegionUpdate {
  /**
   * 97 × 97 heights (m). A new array is compared with the region's vertex by vertex (only `rect` of it when given) and
   * only the changed vertices count; the region's own array (written in place by the caller) counts every vertex of
   * `rect` as changed.
   */
  heights?: ArrayLike<number> | null
  /** 97 × 97 raw texture words (bits 0–9 tile id, 13–15 tiling code); compared like `heights`. */
  words?: ArrayLike<number> | null
  /** A new lightmap (owned by the region from now on; the old one is disposed). null: none (the white texture). */
  lightmap?: BaseTexture | null
}

/** What an updateRegion did (also the onRegionUpdated event). */
export interface TerrainRegionUpdated {
  id: number
  /** Vertices whose height changed. */
  heights: number
  /** Texture words that changed, and the 32 m blocks whose layers were rebuilt. */
  words: number
  blocks: number
  /** The layer count changed (a new layer map texture). */
  resized: boolean
  /** Loaded neighbours whose normals were recomputed (their seam ring touched the edit). */
  neighbours: number[]
  /** The lightmap was replaced. */
  lightmap: boolean
  /** The upload's time (ms). */
  ms: number
}

/** Region id of region (x, z) (the manifest / WorldRegions key). */
const regionId = (x: number, z: number) => (z << 8) | x

/**
 * Unit vertex normals of one region in glTF space (the PBR path; the Classic splat needs none). The converter already
 * baked neighbour-aware normals into the bin (`TerrainBin.normals`: central differences across region seams over the
 * whole export, packages/convert/src/world/terrain.ts buildNormals), so two regions agree on their shared edge whatever
 * order they stream in. A vertex whose baked normal is zero (the export's outer edge; a bin without normals) gets
 * central differences of the heights instead, across a seam when `neighbour(dx, dz)` returns that region's bin
 * (heights are bit-identical at seams, TERRAIN.md §1.2), one-sided otherwise. `edgeFallback` is true when such a
 * vertex lies on the region's border (a neighbour committing later re-normals it, TerrainRenderer.buildRegion).
 */
export function terrainNormals(
  terrain: Pick<TerrainBin, 'heights' | 'normals'>,
  neighbour: (dx: number, dz: number) => Pick<TerrainBin, 'heights'> | null = () => null,
): { normals: Float32Array; computed: number; edgeFallback: boolean } {
  const out = new Float32Array(GRID * GRID * 3)
  const baked = terrain.normals
  let computed = 0
  let edgeFallback = false
  // Height at grid (gx, gz), stepping into a neighbour region one cell past the border; undefined when not loaded.
  const h = (gx: number, gz: number): number | undefined => {
    if (gx >= 0 && gx < GRID && gz >= 0 && gz < GRID) return terrain.heights[gz * GRID + gx]
    const dx = gx < 0 ? -1 : gx >= GRID ? 1 : 0
    const dz = gz < 0 ? -1 : gz >= GRID ? 1 : 0
    const n = neighbour(dx, dz)
    return n ? n.heights[(gz - dz * CELLS) * GRID + (gx - dx * CELLS)] : undefined
  }
  for (let gz = 0; gz < GRID; gz++) {
    for (let gx = 0; gx < GRID; gx++) {
      const i = gz * GRID + gx
      let x = 0, y = 0, z = 0
      if (baked && baked.length >= (i + 1) * 4) {
        x = baked[i * 4]!
        y = baked[i * 4 + 1]!
        z = baked[i * 4 + 2]!
      }
      if (x === 0 && y === 0 && z === 0) {
        computed++
        if (gx === 0 || gz === 0 || gx === CELLS || gz === CELLS) edgeFallback = true
        const c = terrain.heights[i]!
        const hl = h(gx - 1, gz), hr = h(gx + 1, gz), hd = h(gx, gz - 1), hu = h(gx, gz + 1)
        // Grid step 2 m; glTF x = 2 gx, z = −2 gz, so dh/dz(glTF) = −dh/dgz / 2.
        const dx = hl !== undefined && hr !== undefined ? (hr - hl) / 4 : hr !== undefined ? (hr - c) / 2 : hl !== undefined ? (c - hl) / 2 : 0
        const dz = hd !== undefined && hu !== undefined ? (hu - hd) / 4 : hu !== undefined ? (hu - c) / 2 : hd !== undefined ? (c - hd) / 2 : 0
        x = -dx
        y = 1
        z = dz
      }
      const len = Math.hypot(x, y, z) || 1
      out[i * 3] = x / len
      out[i * 3 + 1] = y / len
      out[i * 3 + 2] = z / len
    }
  }
  return { normals: out, computed, edgeFallback }
}

/** `mesh.metadata.sroWorld` of every terrain mesh, e.g. for a live isGround check (streamed regions come and go). */
export const TERRAIN_MESH_TAG = 'terrain'

/** True for a terrain mesh built by TerrainRenderer (streamed ones included). */
export function isTerrainMesh(mesh: { metadata?: unknown } | null | undefined): boolean {
  return (mesh?.metadata as { sroWorld?: unknown } | null | undefined)?.sroWorld === TERRAIN_MESH_TAG
}

let shadersRegistered = false
/** The terrain index list is the same for every region (read-only, shared by every terrain mesh). */
let sharedIndices: Uint32Array | null = null

function registerShaders(): void {
  if (shadersRegistered) return
  shadersRegistered = true
  ShaderStore.ShadersStoreWGSL['sroTerrainVertexShader'] = terrainVertexWGSL
  ShaderStore.ShadersStoreWGSL['sroTerrainFragmentShader'] = terrainFragmentWGSL
  ShaderStore.ShadersStore['sroTerrainVertexShader'] = terrainVertexGLSL
  ShaderStore.ShadersStore['sroTerrainFragmentShader'] = terrainFragmentGLSL
}

/** A Texture from already-fetched image bytes (PNG or WebP, by the path's extension). */
export function textureFromBytes(scene: Scene, assets: Assets, rel: string, bytes: Uint8Array<ArrayBuffer>, invertY: boolean): Promise<Texture> {
  return new Promise<Texture>((resolve, reject) => {
    const t: Texture = new Texture(assets.url(rel), scene, {
      noMipmap: false,
      invertY,
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
      buffer: bytes,
      mimeType: mimeOf(rel),
      onLoad: () => resolve(t),
      onError: msg => reject(new Error(msg ?? `${rel}: decode failed`)),
    })
  })
}

/** A region's terrain lightmap texture (image row 0 = south = v 0, manifest.ts WorldRegion.lightmap). */
export async function loadTerrainLightmap(scene: Scene, assets: Assets, file: string, signal?: AbortSignal): Promise<Texture> {
  const tex = await textureFromBytes(scene, assets, file, await assets.bytesOf(file, signal), false)
  tex.wrapU = Texture.CLAMP_ADDRESSMODE
  tex.wrapV = Texture.CLAMP_ADDRESSMODE
  return tex
}

/** Magenta RGBA tile for a tile image that failed to load. */
export function missingTile(size: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 255, 255], i)
  return data
}

/**
 * Terrain meshes (one per region, 97 x 97 shared vertices, triangles from format.ts terrainIndices(), i.e. space.ts)
 * with the texture-splatting ShaderMaterial of TERRAIN.md 8.1. The whole-world load builds every region at once
 * (loadTiles + build); region streaming builds and disposes regions one by one (buildRegion / disposeRegion) against
 * a shared tile array (tile-atlas.ts, setTileArray).
 *
 * Wave 9 (RND-T, docs/WAVE_PLAN3.md §6.11): with a render source in 'pbr' mode (`follow`, wired by World) a region is
 * built on the PBR path instead: per-vertex normals (terrainNormals), no uv, one PBRMaterial + SroTerrainPlugin
 * (pbr/terrain-plugin.ts) over the same layer map, tile array and lightmap. The Classic branch is unchanged.
 */
export class TerrainRenderer {
  readonly meshes: Mesh[] = []
  readonly materials: ShaderMaterial[] = []
  tileArray: BaseTexture | null = null
  tileLayers = 0
  private readonly textures: BaseTexture[] = []
  private readonly gpu = new Map<number, TerrainRegionGpu>()
  private white: BaseTexture | null = null
  private params: TerrainParams | null = null
  private lastParams = ''
  private visible = true
  private readonly unknownTiles = new Set<number>()
  private black: BaseTexture | null = null
  private surfaceOf: Map<number, number> | null = null
  private readonly defines = new DefineSet()
  /**
   * Values every region material shares, bound by reference (shader-chunks.ts SharedUniforms): chunk uniforms such as
   * the weather `wx*` vectors, and shared chunk textures (ripples, shelter, cloud noise). Wave 9 seam.
   */
  readonly sharedUniforms = new SharedUniforms()
  /** A region's mesh and material were built (streaming commit or whole-world build). Wave 9 seam. */
  readonly onRegionBuilt = new Observable<TerrainRegionGpu>()
  /** A region was disposed (its id; the lanes dispose the textures they set on it). Wave 9 seam. */
  readonly onRegionDisposed = new Observable<number>()
  /** Wave 9 (RND-T): the PBR regions' materials (`materials` stays the Classic list). */
  readonly pbrMaterials: PBRMaterial[] = []
  private source: TerrainRenderSource | null = null
  private pbrState: TerrainPbr | null = null
  private pbrKey = ''
  /** The inputs syncPbr last resolved (reference compares, so the per-frame check allocates nothing). */
  private readonly pbrSeen: Record<'pbr' | 'quality' | 'sky' | 'weather' | 'normal' | 'ormh' | 'night' | 'tier' | 'coast' | 'tint', unknown> = {
    pbr: null, quality: null, sky: null, weather: null, normal: null, ormh: null, night: false, tier: null, coast: false, tint: false,
  }
  private readonly pbrExterns: TerrainExterns | undefined
  /** PBR regions whose border normals came from the height fallback (a neighbour committing re-normals them). */
  private readonly edgeFallback = new Set<number>()
  private normalArray: BaseTexture | null = null
  private ormhArray: BaseTexture | null = null
  /** TX-R: the atlas tier plane (tile-atlas.ts) and its layer count (the shader's tier cap), null / 0 without one. */
  private tierArray: BaseTexture | null = null
  private tierLayers = 0
  private mapLayers = 0
  /** Each built region's tile → layer lookup (updateRegion re-runs the region build's own layerData with it). */
  private readonly layerOfRegion = new Map<number, (tileId: number) => number | undefined>()
  /** W12-SB (S-TERR): a region's heights, words or lightmap were updated in place (the editor's live edits). */
  readonly onRegionUpdated = new Observable<TerrainRegionUpdated>()

  constructor(readonly scene: Scene, readonly world: WorldRegions, opts: { externs?: TerrainExterns } = {}) {
    this.pbrExterns = opts.externs
    this.sharedUniforms.bindTo((name, value) => {
      // LG-2: a Classic material only takes what its shader declares (a PBR-only value, e.g. the coast wet band, would
      // otherwise join its sampler or uniform list and change Low's compile).
      if (!classicDeclares(name)) return
      for (const m of this.materials) bindShared(m, name, value, this.fallbackFor(name))
    })
  }

  // ---- wave 9: the PBR path (RND-T) -------------------------------------------------------------------------------

  /**
   * The renderer, sky and weather the terrain follows (World calls it once). Without a source the terrain stays on the
   * Classic path; with one, regions built while `render.mode` is 'pbr' take the PBR branch (World.setRenderMode
   * rebuilds the regions of a streamed world).
   */
  follow(source: TerrainRenderSource | null): void {
    this.source = source
    this.syncPbr()
  }

  /** The material path new regions are built on. */
  get mode(): RenderPath {
    return this.source?.render.mode ?? 'classic'
  }

  /** The PBR path's shared state (made on first use). */
  get pbr(): TerrainPbr {
    return (this.pbrState ??= new TerrainPbr(this.scene, this.sharedUniforms, this.pbrExterns, this.defines))
  }

  /**
   * TX-R (tile-atlas.ts set range and tier plane, D39): `layers` is the depth of the set range (the map arrays are that
   * deep; layers above it get neutral maps, 0: the arrays span every layer) and `tex` the higher-resolution albedo array
   * the PBR terrain samples for layers below it (null: none, the base array only; at most TILE_TIER_LAYERS). An
   * Options-time event (it changes the define set).
   */
  setTierArray(tex: BaseTexture | null, layers: number): void {
    this.mapLayers = layers > 0 ? layers : 0
    this.tierArray = tex && layers > 0 && layers <= TILE_TIER_LAYERS ? tex : null
    this.tierLayers = this.tierArray ? layers : 0
    if (this.pbrState) {
      this.pbrState.tilesHi = this.tierArray
      this.pbrState.tierLayers = this.tierLayers
      this.pbrState.mapLayers = this.mapLayers
    }
    this.syncPbr()
  }

  /**
   * The per-layer map arrays parallel to the tile array (tile-atlas.ts, D39): allocated only when a texture set
   * provides them (9B), null otherwise. Switching them on or off changes the PBR define set (an Options-time event).
   */
  setMapArrays(maps: { normal?: BaseTexture | null; ormh?: BaseTexture | null }): void {
    if (maps.normal !== undefined) this.normalArray = maps.normal
    if (maps.ormh !== undefined) this.ormhArray = maps.ormh
    if (this.pbrState) {
      this.pbrState.normals = this.normalArray
      this.pbrState.ormh = this.ormhArray
    }
    this.syncPbr()
  }

  /**
   * Re-resolves the PBR define set when an input changed (preset, sky preset, weather level, map arrays, a lane's
   * define). Reference and key compares only: it runs every frame from setParams.
   */
  private syncPbr(): void {
    const src = this.source
    if (!src || (src.render.mode !== 'pbr' && !this.pbrMaterials.length)) return
    const pbr = this.pbr
    const seen = this.pbrSeen
    const quality = src.render.quality
    const sky = src.sky?.quality ?? null
    const weather = src.weather?.preset ?? null
    const night = this.defines.has(TERRAIN_FEATURE_DEFINES.nightSplat)
    // W10-S: the coast's and GL-T's terrain defines switch their externs like NL's (terrain-plugin.ts).
    const coast = this.defines.has(TERRAIN_FEATURE_DEFINES.coastWet)
    const tint = this.defines.has(TERRAIN_FEATURE_DEFINES.grassTint)
    if (seen.pbr === pbr && seen.quality === quality && seen.sky === sky && seen.weather === weather && seen.night === night &&
      seen.normal === this.normalArray && seen.ormh === this.ormhArray && seen.tier === this.tierArray && seen.coast === coast && seen.tint === tint) return
    Object.assign(seen, { pbr, quality, sky, weather, night, normal: this.normalArray, ormh: this.ormhArray, tier: this.tierArray, coast, tint })
    const feats = resolveTerrainFeatures({
      quality,
      sky,
      weather,
      arrays: { normal: !!this.normalArray, ormh: !!this.ormhArray, tier: !!this.tierArray },
      externs: pbr.externsAvailable,
      defines: this.defines,
      maxUnits: (this.scene.getEngine().getCaps() as { maxTexturesImageUnits?: number }).maxTexturesImageUnits ?? 16,
    })
    const key = featureKey(feats)
    if (key === this.pbrKey) return
    this.pbrKey = key
    pbr.setFeatures(feats)
  }

  /** Per frame (setParams): the PBR path's shared vectors from the environment, the weather and the sky. */
  private framePbr(p: TerrainParams): void {
    const src = this.source
    const s = this.pbrState
    if (!src || !s || !this.pbrMaterials.length) return
    this.syncPbr()
    s.params.set(p.lightmap ? 1 : 0, p.view, 0, (performance.now() / 1000) % 3600)
    const w = src.render.weather
    s.weather.set(w.rain, w.wetness, w.puddles, w.wind)
    const exposure = src.sky?.state?.exposure
    s.sun.w = typeof exposure === 'number' && exposure > 0 ? 1 / exposure : 1
    s.tiles = this.tileArray
    s.tilesHi = this.tierArray
    s.tierLayers = this.tierLayers
    s.mapLayers = this.mapLayers
  }

  /** Builds one region on the PBR path (buildRegion's PBR branch). */
  private buildPbrRegion(data: RegionData, layerOf: (tileId: number) => number | undefined, lightmap: BaseTexture | null): TerrainRegionGpu {
    const scene = this.scene
    const { region, terrain } = data
    const positions = new Float32Array(GRID * GRID * 3)
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        const i = gz * GRID + gx
        positions[i * 3] = 2 * gx
        positions[i * 3 + 1] = terrain.heights[i]!
        positions[i * 3 + 2] = -2 * gz
      }
    }
    const nb = this.neighbourBins(region.x, region.z)
    const { normals, edgeFallback } = terrainNormals(terrain, nb)
    const vd = new VertexData()
    vd.positions = positions
    vd.indices = sharedIndices ??= terrainIndices()
    vd.normals = normals
    const mesh = new Mesh(`terrain_${region.x}_${region.z}`, scene)
    mesh.layerMask |= WORLD_GROUND_LAYER
    vd.applyToMesh(mesh, false)
    mesh.position.set(region.origin[0], region.origin[1], region.origin[2])
    mesh.sideOrientation = Material.CounterClockWiseSideOrientation
    mesh.freezeWorldMatrix()
    // Babylon's scene fog until RND-P's height fog replaces it on PBR materials (D18); the CSM when RND-L casts one.
    mesh.applyFog = true
    mesh.receiveShadows = true
    mesh.metadata = { sroRegion: region.id, sroWorld: TERRAIN_MESH_TAG }
    if (!this.visible) mesh.setEnabled(false)

    const layerMap = this.buildLayerMap(data, layerOf)
    const pbr = this.pbr
    this.syncPbr()
    pbr.tiles = this.tileArray
    pbr.normals = this.normalArray
    pbr.ormh = this.ormhArray
    const textures: TerrainRegionGpu['textures'] = {}
    const { material, plugin } = pbr.createMaterial(`terrain_${region.x}_${region.z}`, {
      originX: region.origin[0],
      originZ: region.origin[2],
      layerCount: terrain.layerCount,
      layerMap,
      lightmap,
      textures,
    })
    mesh.material = material
    this.meshes.push(mesh)
    this.pbrMaterials.push(material)
    const gpu: TerrainRegionGpu = { id: region.id, mesh, path: 'pbr', material, pbr: plugin, layerMap, lightmap, textures }
    this.gpu.set(region.id, gpu)
    this.layerOfRegion.set(region.id, layerOf)
    if (edgeFallback) this.edgeFallback.add(region.id)
    this.renormalNeighbours(region.x, region.z)
    this.onRegionBuilt.notifyObservers(gpu)
    return gpu
  }

  /** The loaded neighbour bins of region (x, z) by offset (WorldRegions: streaming adds a region before its terrain). */
  private neighbourBins(x: number, z: number): (dx: number, dz: number) => TerrainBin | null {
    return (dx, dz) => this.world.get(regionId(x + dx, z + dz))?.terrain ?? null
  }

  /**
   * A region just committed: PBR neighbours whose border normals came from the height fallback (their side of this
   * seam was not loaded) get their normals again, now across the seam (97 × 97 vertices, well under a millisecond).
   */
  private renormalNeighbours(x: number, z: number): void {
    if (!this.edgeFallback.size) return
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const id = regionId(x + dx, z + dz)
        if (!this.edgeFallback.has(id)) continue
        const g = this.gpu.get(id)
        const data = this.world.get(id)
        if (!g || g.path !== 'pbr' || !data) continue
        const r = terrainNormals(data.terrain, this.neighbourBins(x + dx, z + dz))
        g.mesh.setVerticesData(VertexBuffer.NormalKind, r.normals, false)
        if (!r.edgeFallback) this.edgeFallback.delete(id)
      }
    }
  }

  /** Tile id -> layer of the 2D texture array (only the tiles the regions use). */
  async loadTiles(assets: Assets, onProgress: (done: number, total: number) => void): Promise<Map<number, number>> {
    const tiles = this.world.manifest.tiles
    let done = 0
    const images = await mapLimit(tiles, 8, async tile => {
      let data: Uint8Array
      try {
        // 256-pixel tiles are upscaled so every layer is 512 x 512 (TERRAIN.md 8.1).
        data = (await assets.image(tile.file, TILE_SIZE)).data
      } catch (err) {
        console.warn(`[world] tile ${tile.file}:`, err)
        data = missingTile(TILE_SIZE)
      }
      onProgress(++done, tiles.length)
      return data
    })
    this.tileArray = createTextureArray(this.scene, images, TILE_SIZE, 'terrainTiles')
    this.tileLayers = images.length
    this.textures.push(this.tileArray)
    return new Map(tiles.map((t, i) => [t.id, i]))
  }

  /** Builds every loaded region (whole-world load, after loadTiles). */
  async build(assets: Assets, tileLayer: Map<number, number>, params: TerrainParams): Promise<void> {
    this.params = params
    await mapLimit(this.world.regions, 4, async data => {
      const { region } = data
      let lightmap: BaseTexture | null = null
      if (region.lightmap) {
        try {
          lightmap = await loadTerrainLightmap(this.scene, assets, region.lightmap.file)
        } catch (err) {
          console.warn(`[world] lightmap ${region.lightmap.file}:`, err)
        }
      }
      this.buildRegion(data, id => tileLayer.get(id), lightmap)
    })
    this.warnUnknownTiles()
    this.setParams(params)
  }

  /** The texture array every terrain material samples (region streaming: the tile atlas, which can be rebuilt). */
  setTileArray(tex: BaseTexture | null): void {
    this.tileArray = tex
    if (tex) for (const m of this.materials) m.setTexture('tiles', tex)
    if (this.pbrState) this.pbrState.tiles = tex
  }

  /**
   * Builds one region's mesh and material (synchronous: one streaming job). `layerOf` maps a tile id to its layer in
   * tileArray; `lightmap` (owned by the region from now on, disposed with it) may be null.
   */
  buildRegion(data: RegionData, layerOf: (tileId: number) => number | undefined, lightmap: BaseTexture | null): TerrainRegionGpu {
    registerShaders()
    const scene = this.scene
    const { region, terrain } = data
    this.disposeRegion(region.id)
    if (this.mode === 'pbr') return this.buildPbrRegion(data, layerOf, lightmap)
    const positions = new Float32Array(GRID * GRID * 3)
    const uvs = new Float32Array(GRID * GRID * 2)
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        const i = gz * GRID + gx
        // Region-local glTF metres (origin added as the mesh position): (2 gx, h, -2 gz).
        positions[i * 3] = 2 * gx
        positions[i * 3 + 1] = terrain.heights[i]!
        positions[i * 3 + 2] = -2 * gz
        uvs[i * 2] = 20 * gx
        uvs[i * 2 + 1] = 20 * gz
      }
    }
    const vd = new VertexData()
    vd.positions = positions
    vd.indices = sharedIndices ??= terrainIndices()
    vd.uvs = uvs
    const mesh = new Mesh(`terrain_${region.x}_${region.z}`, scene)
    mesh.layerMask |= WORLD_GROUND_LAYER
    vd.applyToMesh(mesh, false)
    mesh.position.set(region.origin[0], region.origin[1], region.origin[2])
    // terrainIndices() are glTF counter-clockwise (seen from +Y), like the glTF loader's meshes in this RH scene.
    mesh.sideOrientation = Material.CounterClockWiseSideOrientation
    mesh.freezeWorldMatrix()
    mesh.applyFog = false // the shader applies the terrain fog itself (no Babylon FOG define/uniforms)
    mesh.metadata = { sroRegion: region.id, sroWorld: TERRAIN_MESH_TAG }
    if (!this.visible) mesh.setEnabled(false)

    const layerMap = this.buildLayerMap(data, layerOf)

    this.white ??= solidTexture(scene, [255, 255, 255, 255], 'white')
    const mat = new ShaderMaterial(`terrain_${region.x}_${region.z}`, scene, 'sroTerrain', {
      attributes: ['position', 'uv'],
      uniforms: [...TERRAIN_UNIFORMS],
      samplers: [...TERRAIN_SAMPLERS],
      shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    if (this.tileArray) mat.setTexture('tiles', this.tileArray)
    mat.setTexture('layerMap', layerMap)
    mat.setTexture('lightmap', lightmap ?? this.white)
    mat.setFloat('layerCount', terrain.layerCount)
    mat.backFaceCulling = true
    if (this.params) applyParams(mat, this.params)
    this.bindChunkState(mat)
    mesh.material = mat
    this.meshes.push(mesh)
    this.materials.push(mat)
    const gpu: TerrainRegionGpu = { id: region.id, mesh, path: 'classic', material: mat, pbr: null, layerMap, lightmap, textures: {} }
    this.gpu.set(region.id, gpu)
    this.layerOfRegion.set(region.id, layerOf)
    this.onRegionBuilt.notifyObservers(gpu)
    return gpu
  }

  /** Layer map: the TerrainBin planes with the tile id replaced by its layer in the tile array (both paths). */
  private buildLayerMap(data: RegionData, layerOf: (tileId: number) => number | undefined): RawTexture {
    const { region, terrain } = data
    const L = Math.max(1, terrain.layerCount)
    const layerMap = RawTexture.CreateRGBATexture(this.layerData(data, layerOf), CELLS, CELLS * L, this.scene, false, false, Texture.NEAREST_SAMPLINGMODE)
    layerMap.name = `layers_${region.x}_${region.z}`
    layerMap.wrapU = Texture.CLAMP_ADDRESSMODE
    layerMap.wrapV = Texture.CLAMP_ADDRESSMODE
    return layerMap
  }

  /** The layer map's texels (buildLayerMap, and updateRegion's re-upload: one function, D5). */
  private layerData(data: RegionData, layerOf: (tileId: number) => number | undefined): Uint8Array {
    const { terrain } = data
    const L = Math.max(1, terrain.layerCount)
    const layerData = new Uint8Array(CELLS * CELLS * L * 4)
    for (let k = 0; k < terrain.layerCount; k++) {
      for (let c = 0; c < CELLS * CELLS; c++) {
        const o = (k * CELLS * CELLS + c) * 4
        if (!terrain.layers[o + 3]) continue
        const id = terrain.layers[o]! | ((terrain.layers[o + 1]! & 3) << 8)
        const code = terrain.layers[o + 1]! >> 2
        let layer = layerOf(id)
        if (layer === undefined) {
          this.unknownTiles.add(id)
          layer = 0
        }
        layerData[o] = layer
        layerData[o + 1] = code
        layerData[o + 2] = terrain.layers[o + 2]!
        // 128 + the surface class (WEATHER §6.2) + 64 for a paving tile (TT-Q's no-anti-tile bit): still >= 0.5.
        layerData[o + 3] = this.surfaceAlphaOf(id)
      }
    }
    return layerData
  }

  /** Chunk samplers, shared values and defines on a new region material (nothing at all with empty chunks). */
  private bindChunkState(mat: ShaderMaterial): void {
    for (const name of TERRAIN_CHUNK_SAMPLERS) mat.setTexture(name, this.fallbackFor(name)!)
    for (const [name, value] of this.sharedUniforms) if (classicDeclares(name)) bindShared(mat, name, value)
    this.defines.apply(mat)
  }

  /** 1 x 1 black for a chunk sampler nobody bound yet; null for names that are not chunk samplers. */
  private fallbackFor(name: string): BaseTexture | null {
    if (!TERRAIN_CHUNK_SAMPLERS.includes(name)) return null
    return (this.black ??= solidTexture(this.scene, [0, 0, 0, 255], 'terrainChunkBlack'))
  }

  /** Layer-map alpha of a tile id (pbr/classes.ts terrainSurfaceAlpha of the manifest tile; unknown: generic). */
  private surfaceAlphaOf(id: number): number {
    if (!this.surfaceOf) {
      this.surfaceOf = new Map()
      for (const t of this.world.manifest.tiles) this.surfaceOf.set(t.id, terrainSurfaceAlpha({ typeName: t.typeName ?? undefined, file: t.file, source: t.source }))
    }
    return this.surfaceOf.get(id) ?? surfaceAlpha(0)
  }

  /**
   * Binds a per-region texture (docs/WAVE_PLAN3.md §4.1) onto the region's Classic material (when a chunk declares that
   * sampler) and records it in TerrainRegionGpu.textures for the PBR path; null unbinds (the black fallback). False when
   * the region is not built. The caller keeps ownership of the texture.
   */
  setRegionTexture(region: number, slot: TerrainRegionSlot, tex: BaseTexture | null): boolean {
    const g = this.gpu.get(region)
    if (!g) return false
    if (tex) g.textures[slot] = tex
    else delete g.textures[slot]
    // PBR: the plugin reads g.textures by reference at each draw.
    if (g.path === 'classic' && TERRAIN_CHUNK_SAMPLERS.includes(slot)) (g.material as ShaderMaterial).setTexture(slot, tex ?? this.fallbackFor(slot)!)
    return true
  }

  /** The region's GPU record (null when not built). */
  region(id: number): TerrainRegionGpu | null {
    return this.gpu.get(id) ?? null
  }

  /**
   * W12-SB, seam S-TERR (docs/WORLD_EDITOR.md §5.2, docs/WAVE_PLAN8.md §4.3, D5): a region's live edit, with no
   * rebuild. `rect` (region grid vertices, inclusive; default the whole grid) bounds what is compared and written.
   *
   * - Heights: written into the region's TerrainBin (the grass window and the ground queries read it by reference), the
   *   baked normals of the one-vertex ring around each changed vertex baked again the converter's way (here and, for a
   *   ring on a seam, in the loaded neighbour: a seam vertex is shared; terrain-edit.ts `renormalRing`), the positions
   *   re-uploaded and, on the PBR path, the normals of this region and of each touched neighbour re-uploaded (the same
   *   bytes on both sides of a seam). The caller writes a shared seam vertex into every region holding it and updates
   *   each of them; the order does not matter.
   * - Words: written into the TerrainBin, the blocks whose words changed re-layered (terrain-edit.ts `relayer`, the
   *   converter's native layering) and the layer map re-uploaded through the region build's own `layerData` with the
   *   lookup the region was built with (a new texture when the layer count changes). A painted tile must be in the tile
   *   array already (the streamer's atlas: acquire it first), else it draws as layer 0 and is logged as unknown.
   * - Lightmap: replaces the region's (the old one is disposed).
   *
   * Values equal to the region's change nothing (no upload). Returns what changed (also sent on onRegionUpdated when
   * anything did); null when the region is not loaded.
   */
  updateRegion(id: number, update: TerrainRegionUpdate, rect?: GridRect | null): TerrainRegionUpdated | null {
    const data = this.world.get(id)
    if (!data) return null
    const t0 = performance.now()
    const g = this.gpu.get(id) ?? null
    const out: TerrainRegionUpdated = { id, heights: 0, words: 0, blocks: 0, resized: false, neighbours: [], lightmap: false, ms: 0 }
    const r = clampGridRect(rect)
    const { x, z } = data.region
    if (update.heights && r) {
      const changed = editHeights(data.terrain, update.heights, r)
      out.heights = changed.length
      if (changed.length) {
        const touched = new Set<number>()
        for (const [dx, dz, i] of renormalRing(data.terrain, changed, this.neighbourBins(x, z))) {
          const nid = regionId(x + dx, z + dz)
          const nd = this.world.get(nid)
          if (!nd) continue
          bakeNormalAt(nd.terrain, i % GRID, (i / GRID) | 0, this.neighbourBins(x + dx, z + dz))
          touched.add(nid)
        }
        if (g) this.uploadHeights(g, data)
        for (const nid of touched) {
          const ng = this.gpu.get(nid)
          const nd = this.world.get(nid)
          if (!ng || !nd) continue
          out.neighbours.push(nid)
          if (ng.path === 'pbr') this.uploadNormals(ng, nd)
        }
      }
    }
    if (update.words && r) {
      const before = Math.max(1, data.terrain.layerCount)
      const res = relayer(data.terrain, update.words, r)
      out.words = res.changedWords
      out.blocks = res.blocks
      out.resized = res.resized
      if (res.blocks && g) this.uploadLayers(g, data, Math.max(1, data.terrain.layerCount) !== before)
    }
    if (update.lightmap !== undefined && g && update.lightmap !== g.lightmap) {
      g.lightmap?.dispose()
      g.lightmap = update.lightmap
      if (g.pbr) g.pbr.region.lightmap = update.lightmap
      else {
        this.white ??= solidTexture(this.scene, [255, 255, 255, 255], 'white')
        ;(g.material as ShaderMaterial).setTexture('lightmap', update.lightmap ?? this.white)
      }
      out.lightmap = true
    }
    out.ms = performance.now() - t0
    if (out.heights || out.words || out.lightmap) this.onRegionUpdated.notifyObservers(out)
    return out
  }

  /** Re-uploads a built region's positions (and its normals on the PBR path) from its TerrainBin. */
  private uploadHeights(g: TerrainRegionGpu, data: RegionData): void {
    const mesh = g.mesh
    const pos = (mesh.getVerticesData(VertexBuffer.PositionKind, false, false) as Float32Array | null) ?? new Float32Array(GRID * GRID * 3)
    const h = data.terrain.heights
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        const i = gz * GRID + gx
        pos[i * 3] = 2 * gx
        pos[i * 3 + 1] = h[i]!
        pos[i * 3 + 2] = -2 * gz
      }
    }
    setVertices(mesh, VertexBuffer.PositionKind, pos)
    // the world matrix is frozen: rebuild the culling box against it, or the region is culled away from the origin
    mesh.refreshBoundingInfo()
    if (g.path === 'pbr') this.uploadNormals(g, data)
  }

  /** Recomputes a PBR region's normals across its loaded seams and re-uploads them. */
  private uploadNormals(g: TerrainRegionGpu, data: RegionData): void {
    const r = terrainNormals(data.terrain, this.neighbourBins(data.region.x, data.region.z))
    setVertices(g.mesh, VertexBuffer.NormalKind, r.normals)
    if (r.edgeFallback) this.edgeFallback.add(g.id)
    else this.edgeFallback.delete(g.id)
  }

  /** Re-uploads a region's layer map (a new texture when its layer count changed). */
  private uploadLayers(g: TerrainRegionGpu, data: RegionData, resized: boolean): void {
    const layerOf = this.layerOfRegion.get(g.id) ?? (() => undefined)
    if (!resized) {
      g.layerMap.update(this.layerData(data, layerOf))
    } else {
      const old = g.layerMap
      g.layerMap = this.buildLayerMap(data, layerOf)
      if (g.pbr) {
        g.pbr.region.layerMap = g.layerMap
        g.pbr.region.layerCount = data.terrain.layerCount
      } else {
        const mat = g.material as ShaderMaterial
        mat.setTexture('layerMap', g.layerMap)
        mat.setFloat('layerCount', data.terrain.layerCount)
      }
      old.dispose()
    }
    if (g.pbr) g.pbr.region.layerCount = data.terrain.layerCount
    this.warnUnknownTiles()
  }

  /** Turns a shader define on or off on every region material, now and for regions built later (chunk `#ifdef`s). */
  setDefine(name: string, on: boolean): void {
    if (!this.defines.set(name, on)) return
    for (const m of this.materials) m.setDefine(name, on)
    // The PBR plugin follows the lanes' defines: NL's SRO_NIGHT_SPLAT (D29) and those its externs test (WX_OCC8).
    this.syncPbr()
    this.pbrState?.laneDefinesChanged()
  }

  /** Disposes one region's mesh, material, layer map and lightmap; false when it was not built. */
  disposeRegion(id: number): boolean {
    const g = this.gpu.get(id)
    if (!g) return false
    this.gpu.delete(id)
    this.edgeFallback.delete(id)
    this.layerOfRegion.delete(id)
    removeItem(this.meshes, g.mesh)
    if (g.path === 'pbr') removeItem(this.pbrMaterials, g.material as PBRMaterial)
    else removeItem(this.materials, g.material as ShaderMaterial)
    g.mesh.dispose(false, false)
    g.material.dispose(false, false)
    g.layerMap.dispose()
    g.lightmap?.dispose()
    this.onRegionDisposed.notifyObservers(id)
    return true
  }

  /** Regions with a built mesh. */
  get regionCount(): number {
    return this.gpu.size
  }

  /** Logs the tile ids that were missing from the tile lookup since the last call. */
  warnUnknownTiles(): void {
    if (!this.unknownTiles.size) return
    console.warn('[world] terrain tile ids missing from the tile lookup:', [...this.unknownTiles])
    this.unknownTiles.clear()
  }

  setParams(p: TerrainParams): void {
    this.framePbr(p)
    // Called every frame by the environment update: skip the uniform writes when nothing changed.
    const key = [p.lightmap, p.fog, p.fogStartM.toFixed(3), p.fogEndM.toFixed(3), ...p.fogColor.map(v => v.toFixed(4)),
      ...p.shadowColor.map(v => v.toFixed(4)), p.view].join('|')
    this.params = p
    if (key === this.lastParams) return
    this.lastParams = key
    for (const m of this.materials) applyParams(m, p)
  }

  setVisible(on: boolean): void {
    this.visible = on
    for (const m of this.meshes) m.setEnabled(on)
  }

  dispose(): void {
    for (const id of [...this.gpu.keys()]) this.disposeRegion(id)
    for (const m of this.meshes) m.dispose(false, false)
    for (const m of this.materials) m.dispose(true, false)
    for (const t of this.textures) t.dispose()
    this.white?.dispose()
    this.white = null
    this.black?.dispose()
    this.black = null
    this.pbrState?.dispose()
    this.pbrState = null
    this.pbrKey = ''
    this.onRegionBuilt.clear()
    this.onRegionDisposed.clear()
    this.onRegionUpdated.clear()
    this.meshes.length = 0
    this.materials.length = 0
    this.pbrMaterials.length = 0
    this.textures.length = 0
    this.tileArray = null
  }
}

function applyParams(m: ShaderMaterial, p: TerrainParams): void {
  m.setVector4('fogParams', new Vector4(p.fogStartM, p.fogEndM, p.fog ? 1 : 0, 0))
  m.setVector4('fogColor', new Vector4(p.fogColor[0], p.fogColor[1], p.fogColor[2], 1))
  m.setVector4('shadowColor', new Vector4(p.shadowColor[0], p.shadowColor[1], p.shadowColor[2], 0))
  m.setVector4('viewParams', new Vector4(p.lightmap ? 1 : 0, 0, p.view, 0))
}

/** The names the Classic terrain shader declares (every chunk's uniforms and samplers; read once, after assembly). */
let classicNames: Set<string> | null = null
function classicDeclares(name: string): boolean {
  classicNames ??= new Set([...TERRAIN_UNIFORMS, ...TERRAIN_SAMPLERS])
  return classicNames.has(name)
}

/**
 * Writes a vertex buffer of a terrain mesh in place: the first write makes it updatable (a region is built with static
 * buffers), later ones update it; positions refresh the bounding box.
 */
function setVertices(mesh: Mesh, kind: string, data: Float32Array): void {
  if (mesh.isVertexBufferUpdatable(kind)) mesh.updateVerticesData(kind, data, kind === VertexBuffer.PositionKind)
  else mesh.setVerticesData(kind, data, true)
}

function removeItem<T>(list: T[], item: T): void {
  const i = list.indexOf(item)
  if (i >= 0) list.splice(i, 1)
}
