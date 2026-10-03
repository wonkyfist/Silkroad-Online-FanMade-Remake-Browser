/**
 * loadWorld(): the whole converted world (terrain splatting, water, sky, environment/fog, objects with lightmaps and
 * draw distance, the client's minimap tiles, @sro/nav) in one Babylon scene, behind a small API. Shared by the game
 * client and the world viewer. The asset base can be the converter output (/out/) or the slimmed tree (/out-opt/,
 * docs/ASSETS.md: WebP images, meshopt/quantized glbs; the local meshopt decoder is installed by loadGlb).
 *
 * Frame: the manifest's glTF metres (manifest.ts WorldSpace), the same frame the server uses for positions.
 *
 * Two load paths (docs/FIELDS.md §3): the whole world at once (every region, tile and model; an export without a
 * `stream` block, or `stream: false`), or region streaming (an export with a `stream` block, or `stream: true`):
 * world.stream (stream.ts RegionStreamer) then loads and releases regions around the focus as it moves.
 *
 * Wave 9 seams (docs/WAVE_PLAN3.md §4.1, D2): `sky` (SkySystem: the dome and SkyState), `weather` (WorldWeather) and
 * `render` (WorldRender) are subsystems other lanes own; World only orders them. Per frame: clock → sky.update →
 * applyEnv (sky.envFor → Classic weather multipliers on the classic sky → fog distances × the weather's fog scale) →
 * weather.update → render.update. Low + classic sky + weather off + a frozen time renders exactly as before.
 *
 * Wave 12 seams (docs/WAVE_PLAN8.md §4.2, D2; W12-SA): `trees` (the trees part, TREES Part W: made only where the swap
 * applies, the PBR path of a streamed, batched world with trees 'new'; null on Classic), the tree mode
 * (`LoadWorldOptions.trees`, `setTreeMode`: the batch's swap source) and the region filter (`regionFilter`, WORLD_EDITOR
 * S-FILTER: the editor's layers applied to each region's decoded data before its mesh is built, streamed or not).
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  Ray,
  Scene,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type Camera,
  type Light,
  type Observable,
  type Observer,
} from '@babylonjs/core'
import type { NavGltf, NavPosition, NavSurface, NavWorld } from '@sro/nav'
import { validateWorldManifest, type WorldManifest } from '../../convert/src/world/manifest.ts'
import { DEFAULT_CLOCK, clockAt, type WorldClockState } from '../../shared/src/world-clock.ts'
import { Assets, browserIO, errorText, type WorldIO } from './assets.ts'
import {
  FOG_RANGE_M,
  approachEnv,
  evaluateProfile,
  saturate,
  type EnvProfile,
  type EnvValues,
  type EnvironmentFile,
  type RGB,
} from './environment.ts'
import { createBatchPart } from './batch/index.ts'
import { treeSwapSourceOf, type BatchFactory, type BatchPart } from './batch/types.ts'
import type { CoastAccess, OceanFactory, OceanPart } from './coast/types.ts'
import { worldGrassTint, type GrassTerrainTint } from './grass/tint.ts'
import { isRetailTuftModel } from './grass/types.ts'
import { createLifePart } from './life/index.ts'
import type { LifeFactory, LifePart } from './life/types.ts'
import { ObjectMaterials, type LightmapMode } from './materials.ts'
import { createOceanPart } from './ocean/index.ts'
import { PbrFoliage } from './pbr/foliage-plugin.ts'
import { Minimap } from './minimap.ts'
import { loadNav, loadNavStreamed, manifestSpawn, pickNav, spawnAt, type NavPick, type NavSource } from './nav.ts'
import { WORLD_OBJECT_LAYER, WorldObjects } from './objects.ts'
import type { RegionData } from './regions.ts'
import { WorldRegions } from './regions.ts'
import { EnabledMeshCandidates } from './render/active-meshes.ts'
import type { GpuInfo } from './render/gpu.ts'
import { WorldRender } from './render/index.ts'
import { RENDER_PRESETS, type RenderPath, type RenderQuality } from './render/quality.ts'
import { WorldScatter, type GroundCoverFactory, type ScatterLevel, type ScatterStyle } from './scatter.ts'
import { SkySystem, type SkyRetailInput } from './sky/sky-system.ts'
import { SKY_PRESETS, type SkyQuality, type SkyState, type SkyStyle } from './sky/types.ts'
import { RegionStreamer, STREAM_DEFAULTS, type CommitStepAfter, type StreamSettings } from './stream.ts'
import { TerrainRenderer } from './terrain.ts'
import { createTownPart } from './town/index.ts'
import { townCountScale, type TownFactory, type TownLifeLevel, type TownPart } from './town/types.ts'
import { createTreesPart } from './trees/index.ts'
import type { TreesFactory, TreesMode, TreesPart } from './trees/types.ts'
import { WaterRenderer } from './water.ts'
import { toRenderWeather, toSkyWeather } from './weather/adapters.ts'
import { applyWeatherToEnv, weatherFogScale } from './weather/env.ts'
import { CLEAR_FRAME, type WeatherFrame } from './weather/frame.ts'
import { WorldWeather } from './weather/index.ts'
import type { WeatherLevel } from './weather/presets.ts'

/** Graphics presets; Low is the Classic material path (docs/WAVE_PLAN3.md D4), 'ultra' is wave 9's (D5). */
export type WorldQuality = 'low' | 'medium' | 'high' | 'ultra'

export interface QualitySettings {
  /** Multiplier of the native object draw ranges (TERRAIN.md 6.3: 202 m / 48 m). */
  drawDistance: number
  /** Animated objects (trees, flowers, lanterns): drawn or hidden (they must have been loaded). */
  animated: boolean
  water: boolean
  /** Grass and plant scatter (scatter.ts, W5-G); absent: unchanged. */
  scatter?: ScatterLevel
  /** Wave 9 render block (render/quality.ts); absent: RENDER_PRESETS of the world's preset. */
  render?: RenderQuality
  /** Wave 9 sky block (sky/types.ts); absent: SKY_PRESETS of the world's preset. */
  sky?: SkyQuality
  /**
   * Wave 10 (W10-S, GRASS_LIFE §8.1): the ground-cover style ('retail' on Low; 'field' = GRASS_LIFE's grass on the PBR
   * path, where a field is available); absent: unchanged.
   */
  grassStyle?: ScatterStyle
  /** Wave 10 (W10-S, GRASS_LIFE §5): the wildlife on or off (World.life.setEnabled); absent: unchanged. */
  wildlife?: boolean
}

export const QUALITY_PRESETS: Record<WorldQuality, QualitySettings> = {
  // Wave 10 (D33): Low keeps the retail scatter and tufts (no grassStyle = 'retail'; Classic never draws the field).
  low: { drawDistance: 0.6, animated: false, water: true, scatter: 'low' },
  medium: { drawDistance: 1, animated: true, water: true, scatter: 'medium', grassStyle: 'field' },
  high: { drawDistance: 1.4, animated: true, water: true, scatter: 'high', grassStyle: 'field' },
  // Wave 9 (D5): Ultra keeps High's world settings; its extras are the render and sky blocks.
  ultra: { drawDistance: 1.4, animated: true, water: true, scatter: 'high', grassStyle: 'field' },
}

/**
 * Wave 10 (W10-S): the parts other lanes build, as factories (tests and the lab pass their own; default: each lane's
 * `index.ts`). null: none.
 */
export interface WorldParts {
  /** Region batching (BT-M, batch/index.ts createBatchPart): made on the PBR path of a streamed world. */
  batch?: BatchFactory | null
  /** GRASS_LIFE's field (GL-F): the scatter's 'field' style (default scatter.ts DEFAULT_GROUND_COVER). */
  grass?: GroundCoverFactory | null
  /** The wildlife (GL-L, life/index.ts createLifePart): made on the PBR path. */
  life?: LifeFactory | null
  /** The coast's ocean (CST-O, ocean/index.ts createOceanPart): made on every path. */
  ocean?: OceanFactory | null
  /** Wave 11 (W11-S, TOWN_LIFE §2.3): the town life (TL-C, town/index.ts createTownPart): made on the PBR path. */
  town?: TownFactory | null
  /**
   * Wave 12 (W12-SA, TREES Part W): the trees part (T12-N, trees/index.ts createTreesPart): made where the swap applies
   * (the PBR path of a streamed, batched world with trees 'new').
   */
  trees?: TreesFactory | null
}

/**
 * Wave 12 (W12-SA, WORLD_EDITOR S-FILTER, §2.3 "streaming keeps edits"): called with each region's decoded data (the
 * terrain bin, before its mesh, its water and its nav terrain are built; streamed or whole-world), so the World Editor's
 * layers (heights, texture words) apply before the first build instead of rebuilding it. It changes `decoded` in place
 * (the same arrays the build reads); a throw is logged and the region builds as decoded.
 */
export type RegionFilter = (rx: number, rz: number, decoded: RegionData) => void

export type WorldLoadStage = 'manifest' | 'regions' | 'navigation' | 'tiles' | 'terrain' | 'water' | 'objects' | 'done'

export interface WorldLoadProgress {
  stage: WorldLoadStage
  /** Overall 0..1 (weighted by typical download size). */
  fraction: number
  done: number
  total: number
}

export interface LoadWorldOptions {
  /** Asset root: '/out/' or '/out-opt/' (absolute URL or relative to the document). */
  baseUrl: string | URL
  /** Folder under <baseUrl>/world/ (default 'jangan'). */
  world?: string
  onProgress?: (p: WorldLoadProgress) => void
  /** 0..1, 0 = midnight, 0.5 = noon (default 0.5). */
  timeOfDay?: number
  quality?: WorldQuality
  /** Load placed objects (default true); animated = also the skinned ones (default true). */
  objects?: boolean
  animated?: boolean
  /** Object lightmaps off / 1x / 2x (default 1). */
  lightmapMode?: LightmapMode
  /** Terrain debug view 0..4 (default 0, textured). */
  terrainView?: number
  fog?: boolean
  terrainLightmap?: boolean
  /** Force one environment profile id (default: the block under the focus point). */
  envProfile?: number | null
  /** Load the minimap tiles (default: when the browser canvas API exists). */
  minimap?: boolean
  /** Resolve only after every object model is placed (default true); else `world.objectsReady` settles later. */
  waitForObjects?: boolean
  io?: WorldIO
  /**
   * Region streaming (docs/FIELDS.md §3.10). 'auto' (default): stream when the manifest has a `stream` block; true:
   * stream (an export without one is streamed from its nav.bin split in memory, with a warning); false: load the
   * whole world (the old path).
   */
  stream?: boolean | 'auto'
  /** Initial focus (glTF metres) for streaming; default the spawn. The game passes the character's saved position. */
  focus?: { x: number; z: number }
  /** Grass and plant scatter level (default QUALITY_PRESETS[quality].scatter); World.setQuality changes it. */
  scatter?: ScatterLevel
  /** Overrides of STREAM_DEFAULTS[quality] (radii, budget, cache sizes). */
  streamSettings?: Partial<StreamSettings>
  /** Streaming: the load resolves once every region within this radius (m) of the focus is ready (default 200). */
  readyRadiusM?: number
  /** Wave 9: the material path, 'classic' (default; Low) or 'pbr' (docs/WAVE_PLAN3.md D4). */
  render?: RenderPath
  /** Wave 9: the sky style, 'classic' (default here: the retail dome and palette) or 'modern' (SKY-B). */
  sky?: SkyStyle
  /** Wave 9: the weather level (default 'off'; the game resolves 'auto'). */
  weatherLevel?: WeatherLevel
  /** Wave 9: the GPU's limits and features (apps' EngineResult.gpu); default read back from the engine. */
  gpu?: GpuInfo
  /**
   * W9A perf: hand Babylon only the enabled meshes as active-mesh candidates (render/active-meshes.ts; default true).
   * World.setActiveMeshFilter switches it at run time (the LAB A/B).
   */
  enabledCandidates?: boolean
  /**
   * Wave 10 (W10-S, BATCHING BT-0): region batching on the PBR path of a streamed world (default true; the Classic path
   * never batches). World.setBatching switches it at run time (a rebuild).
   */
  batching?: boolean
  /** Wave 10 (W10-S): the ground-cover style (default QUALITY_PRESETS[quality].grassStyle); World.setGrassStyle. */
  grassStyle?: ScatterStyle
  /** Wave 10 (W10-S): the wildlife starts on (default true; World.life.setEnabled). */
  wildlife?: boolean
  /**
   * Wave 10 (W10-S, GRASS_LIFE §1.3, D3, D24): hide the placed retail tufts where the new grass draws (default true;
   * only ever on the PBR path with the 'field' style). The character stage passes false (its flower beds).
   */
  hideRetailTufts?: boolean
  /** Wave 10 (W10-S): the parts' factories (tests, the lab). */
  parts?: WorldParts
  /**
   * Wave 11 (W11-S, TOWN_LIFE §8.2, WAVE_PLAN7 D10): Town life (default 'full'): 'low' halves the crowd's counts, 'off'
   * hides it (the part stays). Only ever drawn on the PBR path (World.town is null on Classic: the Low guard).
   * World.setTownLife changes it.
   */
  townLife?: TownLifeLevel
  /**
   * Wave 12 (W12-SA, TREES §W3.2, WAVE_PLAN8 D9): Options → Trees (default 'new'): 'new' draws the species that replace
   * the retail trees wherever the manifest carries `treeSwap` (the batch's swap source), 'retail' the retail models.
   * Only ever applies on the PBR path with batching (Classic never swaps: the Low guard). World.setTreeMode changes it.
   */
  trees?: TreesMode
  /** Wave 12 (W12-SA, WORLD_EDITOR S-FILTER): see RegionFilter; World.setRegionFilter changes it. */
  regionFilter?: RegionFilter | null
}

export interface WorldPick extends NavPick {
  point: Vector3
}

const PROGRESS_WEIGHTS: Record<Exclude<WorldLoadStage, 'done'>, number> = {
  manifest: 0.02, regions: 0.06, navigation: 0.04, tiles: 0.18, terrain: 0.06, water: 0.04, objects: 0.6,
}
const STAGE_ORDER: WorldLoadStage[] = ['manifest', 'regions', 'navigation', 'tiles', 'terrain', 'water', 'objects', 'done']
/** Streaming: the nav objects, then the regions around the focus (terrain, tiles), then their objects. */
const STREAM_WEIGHTS: Partial<Record<WorldLoadStage, number>> = { manifest: 0.02, navigation: 0.04, regions: 0.34, objects: 0.6 }
const STREAM_ORDER: WorldLoadStage[] = ['manifest', 'navigation', 'regions', 'objects', 'done']

const FALLBACK_ENV: EnvValues = {
  sun: [1, 1, 1], skyTop: [0.17, 0.57, 0.94], skyBottom: [0.76, 0.97, 1], diffuse: [0.78, 0.77, 0.77], objectAmbient: [0.79, 0.79, 0.78],
  scatter: [1, 1, 1], terrainShadow: [0, 0, 0], fogColor: [0.36, 0.58, 0.68], water: [0.36, 0.69, 0.62], g7: -0.76, g8: -1, g10: 0.76, g11: 1,
}

/**
 * Probes asset roots in order and returns the first one that serves `<root>world/<world>/manifest.json` as JSON
 * (a dev server's SPA fallback answers missing paths with index.html, which is rejected). null if none does.
 */
export async function resolveAssetBase(candidates: readonly string[], world = 'jangan', io: WorldIO = browserIO): Promise<string | null> {
  for (const base of candidates) {
    try {
      const assets = new Assets(base, io)
      const m = await assets.json<{ format?: string }>(`world/${world}/manifest.json`)
      if (m && m.format === 'sro-world') return base
    } catch {
      // try the next one
    }
  }
  return null
}

export async function loadWorld(scene: Scene, opts: LoadWorldOptions): Promise<World> {
  const io = opts.io ?? browserIO
  const worldName = opts.world ?? 'jangan'
  const root = new Assets(opts.baseUrl, io)
  const assets = root.sub(`world/${encodeURIComponent(worldName)}`)
  let streaming = false
  const report = (stage: WorldLoadStage, done: number, total: number): void => {
    if (!opts.onProgress) return
    const order = streaming ? STREAM_ORDER : STAGE_ORDER
    const weight = (s: WorldLoadStage): number => (streaming ? STREAM_WEIGHTS[s] : PROGRESS_WEIGHTS[s as Exclude<WorldLoadStage, 'done'>]) ?? 0
    let fraction = 0
    for (const s of order) {
      if (s === stage || s === 'done') break
      fraction += weight(s)
    }
    if (stage !== 'done') fraction += weight(stage) * (total > 0 ? Math.min(1, done / total) : 0)
    else fraction = 1
    opts.onProgress({ stage, fraction: Math.min(1, fraction), done, total })
  }

  report('manifest', 0, 1)
  const manifest = await assets.json<WorldManifest>('manifest.json').catch(err => {
    throw new Error(`${errorText(err)}\nRun \`pnpm sro convert-region --preset ${worldName}\` first.`)
  })
  const problems = validateWorldManifest(manifest)
  if (problems.length) console.warn('[world] manifest problems:', problems)
  const envFile = await assets.json<EnvironmentFile>(manifest.environment.file).catch(err => {
    console.warn('[world] environment:', err)
    return { source: '', profiles: [] } as EnvironmentFile
  })
  report('manifest', 1, 1)

  const hasStream = !!(manifest as { stream?: unknown }).stream
  if (opts.stream === true || (opts.stream !== false && hasStream)) {
    streaming = true
    return loadStreamed(scene, opts, manifest, envFile, problems, assets, report)
  }

  const regions = new WorldRegions(manifest)
  await regions.load(assets, n => report('regions', n, manifest.regions.length))

  report('navigation', 0, 1)
  const navLoad = await loadNav(manifest, assets, regions)
  for (const w of navLoad.warnings) console.warn('[world] nav:', w)
  report('navigation', 1, 1)

  const world = new World(scene, manifest, envFile, regions, navLoad.nav, navLoad.source, assets, opts)
  world.warnings.push(...problems.map(p => `manifest: ${p}`), ...navLoad.warnings.map(w => `nav: ${w}`))
  // W12-SA (S-FILTER): the editor's layers before the terrain and the water are built.
  for (const data of regions.regions) world.filterRegion(data)

  const tileLayer = await world.terrain.loadTiles(assets, (d, n) => report('tiles', d, n))
  report('terrain', 0, 1)
  await world.terrain.build(assets, tileLayer, world.terrainParams())
  report('terrain', 1, 1)
  report('water', 0, 1)
  await world.water.build(assets).catch(err => {
    console.warn('[world] water:', err)
    world.warnings.push(`water: ${errorText(err)}`)
  })
  report('water', 1, 1)
  world.applyEnv()
  for (const data of regions.regions) world.scatter.addRegion(data)
  if (world.scatter.level !== 'off') void world.scatter.ready()

  const wantMinimap = opts.minimap ?? (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined')
  const minimapLoad = wantMinimap
    ? (world.minimap = new Minimap(null, manifest)).load(assets).catch(err => console.warn('[world] minimap:', err))
    : Promise.resolve()

  report('objects', 0, 1)
  const objectsLoad = opts.objects === false
    ? Promise.resolve()
    : world.objects.load(manifest.models, manifest.placements, { animated: opts.animated ?? true, lightmaps: true },
      (d, n) => report('objects', d, n))
  world.objectsReady = Promise.all([objectsLoad, minimapLoad]).then(() => {
    world.objectsLoaded = true
    world.setQuality(world.quality)
  })
  if (opts.waitForObjects ?? true) await world.objectsReady
  report('done', 1, 1)
  return world
}

/** The streaming load (docs/FIELDS.md §3.10, the streaming loadWorld sequence). */
async function loadStreamed(
  scene: Scene,
  opts: LoadWorldOptions,
  manifest: WorldManifest,
  envFile: EnvironmentFile,
  problems: string[],
  assets: Assets,
  report: (stage: WorldLoadStage, done: number, total: number) => void,
): Promise<World> {
  report('navigation', 0, 1)
  const navLoad = await loadNavStreamed(manifest, assets)
  for (const w of navLoad.warnings) console.warn('[world] nav:', w)
  report('navigation', 1, 1)

  const world = new World(scene, manifest, envFile, new WorldRegions(manifest), navLoad.nav, navLoad.source, assets, opts)
  world.warnings.push(...problems.map(p => `manifest: ${p}`), ...navLoad.warnings.map(w => `nav: ${w}`))
  if (world.scatter.level !== 'off') void world.scatter.ready() // the plant art loads beside the regions
  await world.water.init(assets).catch(err => {
    console.warn('[world] water:', err)
    world.warnings.push(`water: ${errorText(err)}`)
  })
  world.applyEnv()
  const wantMinimap = opts.minimap ?? (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined')
  if (wantMinimap) world.minimap = new Minimap(null, manifest, { tiles: true })

  const settings: StreamSettings = { ...STREAM_DEFAULTS[world.quality] }
  const suggested = (manifest as { stream?: { loadRadiusM?: unknown; unloadRadiusM?: unknown } }).stream
  if (world.quality === 'medium' && typeof suggested?.loadRadiusM === 'number' && typeof suggested.unloadRadiusM === 'number' &&
    suggested.loadRadiusM > 0 && suggested.unloadRadiusM >= suggested.loadRadiusM) {
    settings.loadRadiusM = suggested.loadRadiusM
    settings.unloadRadiusM = suggested.unloadRadiusM
  }
  Object.assign(settings, opts.streamSettings)
  const stream = new RegionStreamer(world, settings, {
    nav: navLoad.chunks,
    objects: opts.objects !== false,
    animated: opts.animated ?? true,
  })
  world.stream = stream

  const focus = opts.focus ?? { x: world.spawn.x, z: world.spawn.z }
  const radius = Math.min(opts.readyRadiusM ?? 200, settings.loadRadiusM)
  world.setFocus(focus.x, focus.z)
  const progress = (): void => {
    const terrain = stream.progress(focus.x, focus.z, radius, false)
    if (terrain.done < terrain.total) report('regions', terrain.done, terrain.total)
    else {
      const all = stream.progress(focus.x, focus.z, radius, true)
      report('objects', all.done, all.total)
    }
  }
  const onRegion = (): void => progress()
  stream.onRegion = onRegion
  progress()
  await stream.whenReady(focus.x, focus.z, radius, false)
  world.relocateSpawn()
  world.resetEnv()
  world.objectsReady = stream.whenReady(focus.x, focus.z, radius, true).then(() => {
    world.objectsLoaded = true
    world.setQuality(world.quality)
    world.terrain.warnUnknownTiles()
  })
  if (opts.waitForObjects ?? true) await world.objectsReady
  if (stream.onRegion === onRegion) stream.onRegion = null
  stream.booting = false
  report('done', 1, 1)
  return world
}

export class World {
  readonly terrain: TerrainRenderer
  readonly water: WaterRenderer
  /** The sky (wave 9: SkySystem; `sky.mesh` is still the dome). */
  readonly sky: SkySystem
  /** Wave 9: the modern renderer's hub (render/index.ts). */
  readonly render: WorldRender
  /** Wave 9: the weather (weather/index.ts): the shared `wx*` vectors, shelter map, ripples, rain. */
  readonly weather: WorldWeather
  readonly materials: ObjectMaterials
  readonly objects: WorldObjects
  /** Grass and plants on the terrain (scatter.ts): regions register as they commit, chunks grow around the camera. */
  readonly scatter: WorldScatter
  /** Wave 9 (RND-W): wind and translucency on the foliage models' PBR materials (pbr/foliage-plugin.ts). */
  readonly foliage: PbrFoliage
  readonly sun: DirectionalLight
  /** The client's minimap tiles (null headless or with minimap: false). */
  minimap: Minimap | null = null
  /**
   * Where new characters appear (manifest.spawn located on the nav surface), glTF metres. Streaming: located again
   * once the spawn's region is ready (relocateSpawn).
   */
  spawn: NavPosition
  readonly spawnYaw: number
  /**
   * Wave 10 (W10-S, BATCHING BT-0, WAVE_PLAN6 D2): the region batching part (BT-M), made on the PBR path of a
   * streamed world while batching is on; null on the Classic path, with batching off, or before BT-M lands.
   */
  batch: BatchPart | null = null
  /** Wave 10 (W10-S, GRASS_LIFE GL-0): the wildlife part (GL-L), made on the PBR path; null on the Classic path. */
  life: LifePart | null = null
  /** Wave 10 (W10-S, COAST): the ocean part (CST-O), made on every path; null until the coast has one. */
  ocean: OceanPart | null = null
  /**
   * Wave 11 (W11-S, TOWN_LIFE §2.3, WAVE_PLAN7 D2): the town life (TL-C), made on the PBR path, updated after the life
   * part, disposed with the world and made again by setRenderMode; null on the Classic path (the Low guard).
   */
  town: TownPart | null = null
  /**
   * Wave 12 (W12-SA, TREES Part W, WAVE_PLAN8 D2): the trees part (T12-N), made only where the swap applies: the PBR
   * path of a streamed world with batching on and the tree mode 'new' (made before the batching part, disposed after it;
   * made again by setRenderMode, setBatching and setTreeMode). null on the Classic path (the Low guard), with 'retail'
   * and with batching off.
   */
  trees: TreesPart | null = null
  /** Wave 10 (GL-T, grass/tint.ts): the terrain's grass tint beyond the carpet (on while the field draws). */
  readonly grassTint: GrassTerrainTint
  private streamValue: RegionStreamer | null = null
  private batchingWanted: boolean
  private grassStyleWanted: ScatterStyle
  private readonly hideTuftsWanted: boolean
  private tuftsHidden = false
  private wildlifeOn: boolean
  private townLifeWanted: TownLifeLevel
  /** H11-DET-1: the last appear alarm (server seconds, its length), replayed into a town part made later. */
  private townAlarmAt: { from: number; sec: number } | null = null
  private readonly parts: { batch: BatchFactory | null; life: LifeFactory | null; ocean: OceanFactory | null; town: TownFactory | null; trees: TreesFactory | null }
  /** W12-SA: the tree mode asked for (LoadWorldOptions.trees, setTreeMode). */
  private treeModeWanted: TreesMode
  /** W12-SA (S-FILTER): the editor's region filter (null: none). */
  private regionFilterValue: RegionFilter | null
  /** W9A perf: the scene's enabled-only active-mesh candidates (null while switched off). */
  activeMeshes: EnabledMeshCandidates | null = null
  private readonly spawnHint: { x: number; y: number; z: number }
  readonly warnings: string[] = []
  objectsReady: Promise<void> = Promise.resolve()
  objectsLoaded = false
  quality: WorldQuality
  private _timeOfDay: number
  private forcedProfile: EnvProfile | null = null
  private profile: EnvProfile | null = null
  private env: EnvValues
  private flags: { fog: boolean; lightmap: boolean; view: number }
  /** The server clock (null: a local, frozen time of day). */
  private clock: WorldClockState | null = null
  private serverNow: () => number = () => Date.now()
  private clockDays: number | null = null
  private skyStyleValue: SkyStyle
  private weatherFrame: Readonly<WeatherFrame> = CLEAR_FRAME
  private readonly skyInput: SkyRetailInput = { env: FALLBACK_ENV, t: 0.5, days: null, declination: DEFAULT_CLOCK.declination, profile: null }
  private disposed = false
  /** engine.onContextRestoredObservable (W9F X1). */
  private contextRestored: Observer<AbstractEngine> | null = null
  private readonly focus = new Vector3()
  private readonly tmpColor = new Color3()
  private readonly tmpForward = new Vector3()
  private readonly forwardAxis: Vector3
  private readonly streamForward = { x: 0, z: 0 }

  constructor(
    readonly scene: Scene,
    readonly manifest: WorldManifest,
    readonly envFile: EnvironmentFile,
    readonly regions: WorldRegions,
    /** @sro/nav in this world's glTF metres; `nav.world` is the file-space NavWorld. */
    readonly nav: NavGltf,
    readonly navSource: NavSource,
    readonly assets: Assets,
    opts: LoadWorldOptions,
  ) {
    this._timeOfDay = Math.min(0.999, Math.max(0, opts.timeOfDay ?? 0.5))
    this.quality = opts.quality ?? 'medium'
    const parts = opts.parts ?? {}
    this.parts = {
      batch: parts.batch === undefined ? createBatchPart : parts.batch,
      life: parts.life === undefined ? createLifePart : parts.life,
      ocean: parts.ocean === undefined ? createOceanPart : parts.ocean,
      town: parts.town === undefined ? createTownPart : parts.town,
      trees: parts.trees === undefined ? createTreesPart : parts.trees,
    }
    this.treeModeWanted = opts.trees === 'retail' ? 'retail' : 'new'
    this.regionFilterValue = opts.regionFilter ?? null
    this.batchingWanted = opts.batching ?? true
    this.grassStyleWanted = opts.grassStyle ?? QUALITY_PRESETS[this.quality].grassStyle ?? 'retail'
    this.hideTuftsWanted = opts.hideRetailTufts ?? true
    this.wildlifeOn = opts.wildlife ?? true
    this.townLifeWanted = opts.townLife ?? 'full'
    if (opts.enabledCandidates ?? true) this.activeMeshes = new EnabledMeshCandidates(scene)
    this.flags = { fog: opts.fog ?? true, lightmap: opts.terrainLightmap ?? true, view: Math.max(0, Math.min(4, opts.terrainView ?? 0)) }
    // Lights (TERRAIN.md 3.2): fixed direction, light travelling from +X and up; diffuse = Diffuse(t) x 0.6.
    this.sun = new DirectionalLight('worldSun', new Vector3(-1, -1, 0).normalize(), scene)
    this.sun.specular = Color3.Black()
    this.terrain = new TerrainRenderer(scene, regions)
    this.water = new WaterRenderer(scene, regions)
    this.skyStyleValue = opts.sky ?? 'classic'
    this.sky = new SkySystem(scene, FALLBACK_ENV, { style: this.skyStyleValue, quality: SKY_PRESETS[this.quality], radiusM: 1400 })
    this.contextRestored = scene.getEngine().onContextRestoredObservable.add(() => this.onContextRestored())
    this.weather = new WorldWeather(scene)
    this.weather.setLevel(opts.weatherLevel ?? 'off')
    this.render = new WorldRender(scene, {
      mode: opts.render ?? 'classic',
      quality: RENDER_PRESETS[this.quality],
      gpu: opts.gpu,
      shelter: () => this.weather.shelter,
    })
    this.terrain.follow({ render: this.render, sky: this.sky, weather: this.weather })
    // RND-W: the PBR water follows the renderer too (water.ts; its Classic branch is unchanged).
    this.water.follow({ render: this.render, weather: this.weather })
    this.materials = new ObjectMaterials(scene, assets)
    // UV scroll (uv-scroll.ts): the retail scrolling textures run on the world clock (the server's once setClock ran).
    this.materials.uvScroll.clock = () => this.serverNow()
    this.materials.mode = this.render.mode
    this.materials.setLightmapMode(opts.lightmapMode ?? 1)
    // RND-M's part (pbr/surface-plugin.ts PbrSurfaces): it joins render.materials on the PBR path only.
    this.materials.pbr.attach(this.render, this.weather)
    this.objects = new WorldObjects(scene, assets, this.materials)
    this.scatter = new WorldScatter({
      scene,
      assets,
      manifest,
      // An object floor (plaza, bridge, house) at or above the ground covers it.
      occupied: (x, z, y) => {
        try {
          const p = this.nav.locate(x, z, Infinity)
          return !!p && p.surface.kind === 'object' && p.y > y - 0.3
        } catch {
          return false
        }
      },
      lightmapOf: id => this.terrain['gpu'].get(id)?.lightmap ?? null,
      terrainParams: () => this.terrainParams(),
      // LOOK-GRASS: no new grass under the coast's sea (read lazily: the ocean and its field come later)
      coast: () => this.coast,
    }, {
      level: opts.scatter ?? QUALITY_PRESETS[this.quality].scatter ?? 'medium',
      // W10-S: the new grass on the PBR path only (the Low guard); no field available yet = 'retail'.
      style: this.render.mode === 'pbr' ? this.grassStyleWanted : 'retail',
      ...(opts.parts?.grass !== undefined ? { field: opts.parts.grass } : {}),
    })
    // RND-W: the grass lights itself in HDR on the PBR path (render/grass-chunks.ts); the foliage plugin decorates the
    // foliage models' PBR materials (both do nothing on the Classic path).
    this.scatter.follow({ render: this.render, sky: this.sky })
    this.grassTint = worldGrassTint(this)
    this.foliage = new PbrFoliage(scene, this.materials, this.render, this.weather)
    // SKY-B: the sky's assets (<out>/sky/) and its chunk uniforms and defines on the Classic ground.
    // The classic dome takes the Classic weather multipliers too (identity when clear, so the Low guard holds).
    this.sky.attach({
      assets,
      ground: [this.terrain, this.scatter],
      renderMode: () => this.render.mode,
      classicEnv: env => applyWeatherToEnv(env, this.weatherFrame),
    })
    if (opts.envProfile !== undefined && opts.envProfile !== null) this.setEnvProfile(opts.envProfile)

    this.forwardAxis = new Vector3(0, 0, scene.useRightHandedSystem ? -1 : 1)
    const origin = manifest.regions.find(r => r.id === manifest.space.originRegion.id)?.origin ?? [0, 0, 0]
    const s = manifestSpawn(manifest)
    const sx = s?.x ?? origin[0] + manifest.space.regionSizeM / 2
    const sz = s?.z ?? origin[2] - manifest.space.regionSizeM / 2
    this.spawnHint = { x: sx, y: s?.y ?? Infinity, z: sz }
    this.spawn = spawnAt(nav, sx, sz, s?.y ?? Infinity)
    this.spawnYaw = typeof manifest.spawn?.yaw === 'number' ? manifest.spawn.yaw : 0
    this.focus.set(this.spawn.x, this.spawn.y, this.spawn.z)
    this.profile = this.profileAt(this.spawn.x, this.spawn.z)
    this.env = this.targetEnv()
    this.syncSky()
    // WX-R: the weather's shared vectors, object decorator, wet-map commit step and shelter listeners (weather/index.ts).
    this.weather.attach(this)
    // RND-L: the PBR path's celestial light and sky cube now, its shadows at the first update (render/index.ts).
    this.render.bindWorld(this)
    // Wave 10 (W10-S): the retail-tuft filter before any region places, the wildlife (PBR), the ocean (every path).
    this.syncTufts()
    this.syncLife()
    this.makeOcean()
    // Wave 11 (W11-S): the town after the wildlife (its pigeons and ducks are life species).
    this.syncTown()
  }

  /** Region streaming (null: the whole world was loaded). W10-S: setting it makes the batching part (PBR, BT-0). */
  get stream(): RegionStreamer | null {
    return this.streamValue
  }

  set stream(stream: RegionStreamer | null) {
    this.streamValue = stream
    this.syncBatch()
  }

  /** The file-space navigation world (NAVIGATION.md §9.2). */
  get navWorld(): NavWorld {
    return this.nav.world
  }

  // ---- wave 10 parts (W10-S; docs/WAVE_PLAN6.md §4.1, D2) ------------------------------------------------------

  /** Whether region batching is wanted (LoadWorldOptions.batching, setBatching); it runs on the PBR path only. */
  get batching(): boolean {
    return this.batchingWanted
  }

  /**
   * Options → Advanced → World batching (W10-G; BATCHING F12): releases every region batch and rebuilds the streamed
   * regions with or without the batcher. Nothing happens on the Classic path (Low never batches) but the flag.
   */
  setBatching(on: boolean): void {
    if (on === this.batchingWanted) return
    this.batchingWanted = on
    const before = this.objects.batcher
    this.releaseBatch()
    if (!on) this.objects.setBatcher(null)
    this.syncBatch()
    if (this.objects.batcher !== before) this.stream?.rebuild()
  }

  /** Makes or drops the batching part to match the path, the flag and the streamer (no rebuild: the callers do it). */
  private syncBatch(): void {
    const want = this.batchingWanted && !!this.streamValue && this.render.mode === 'pbr' && !this.disposed
    if (want === !!this.batch) return
    if (!want) {
      this.releaseBatch()
      return
    }
    // W12-SA (D2): the trees part first (the batch reads its slots through world.trees), then the batch with the swap.
    const swapping = this.treeModeWanted === 'new'
    if (swapping) this.makeTrees()
    let part: BatchPart | null = null
    try {
      part = this.parts.batch?.({
        world: this, scene: this.scene, objects: this.objects, materials: this.materials, path: 'pbr', models: this.manifest.models,
        worker: this.streamValue?.batchWorker ?? null,
        treeSwap: swapping ? treeSwapSourceOf(this.manifest.models) : null,
      }) ?? null
    } catch (err) {
      console.warn('[world] region batching failed to start:', err)
    }
    if (!part) {
      this.dropTrees()
      return
    }
    this.batch = part
    this.objects.setBatcher(part)
  }

  /**
   * Releases every region batch (meshes, slots, cells) and drops the part (F12: before a path switch's rebuild); W12-SA:
   * then the trees part, which lives only beside a batch.
   */
  private releaseBatch(): void {
    const b = this.batch
    if (b) {
      this.batch = null
      if (this.objects.batcher === b) this.objects.setBatcher(null)
      try {
        b.release()
        b.dispose()
      } catch (err) {
        console.warn('[world] region batching release failed:', err)
      }
    }
    this.dropTrees()
  }

  // ---- wave 12 parts (W12-SA; docs/WAVE_PLAN8.md §4.2, D2) -------------------------------------------------------

  /** The tree mode asked for (LoadWorldOptions.trees, setTreeMode); the swap applies on the PBR path with batching only. */
  get treeMode(): TreesMode {
    return this.treeModeWanted
  }

  /**
   * Options → Graphics → Trees (TREES §W3.2, WAVE_PLAN8 D9): 'new' or 'retail'. Where the swap can apply (a batch exists:
   * the PBR path of a streamed world with batching on) the batch and the trees part are made again with the new swap
   * source and the streamed regions rebuilt; elsewhere (Classic, batching off) only the flag changes, for later.
   */
  setTreeMode(mode: TreesMode): void {
    const next: TreesMode = mode === 'retail' ? 'retail' : 'new'
    if (next === this.treeModeWanted) return
    this.treeModeWanted = next
    if (!this.batch || this.disposed) return
    this.releaseBatch()
    this.syncBatch()
    this.stream?.rebuild()
  }

  /** Makes the trees part (where the swap applies: syncBatch calls it before the batching part). */
  private makeTrees(): void {
    if (this.trees || this.disposed) return
    try {
      this.trees = this.parts.trees?.({ scene: this.scene, world: this }) ?? null
    } catch (err) {
      console.warn('[world] trees failed to start:', err)
    }
  }

  /** Drops the trees part (after its batch went). */
  private dropTrees(): void {
    const t = this.trees
    if (!t) return
    this.trees = null
    try {
      t.dispose()
    } catch (err) {
      console.warn('[world] trees dispose failed:', err)
    }
  }

  /** W12-SA (S-FILTER): the editor's region filter (LoadWorldOptions.regionFilter; null: none). */
  get regionFilter(): RegionFilter | null {
    return this.regionFilterValue
  }

  /**
   * Sets the region filter (WORLD_EDITOR S-FILTER). It applies to regions decoded afterwards (a streamed region that
   * comes in again); the editor updates resident regions itself (S-TERR).
   */
  setRegionFilter(filter: RegionFilter | null): void {
    this.regionFilterValue = filter
  }

  /** Runs the region filter on one decoded region (region-chunk.ts after the decode; loadWorld before the build). */
  filterRegion(data: RegionData): void {
    const f = this.regionFilterValue
    if (!f) return
    try {
      f(data.region.x, data.region.z, data)
    } catch (err) {
      console.warn(`[world] region filter failed on ${data.region.x},${data.region.z}:`, err)
    }
  }

  /** The ground-cover style asked for (the scatter's `style` says what draws). */
  get grassStyle(): ScatterStyle {
    return this.grassStyleWanted
  }

  /**
   * Wave 10 (GRASS_LIFE §8.1): the ground-cover style. 'field' draws GRASS_LIFE's grass on the PBR path (where a field
   * exists) and hides the placed retail tufts (unless `hideRetailTufts: false`), which rebuilds the streamed regions.
   */
  setGrassStyle(style: ScatterStyle): void {
    this.grassStyleWanted = style
    this.syncGrassStyle()
    if (this.syncTufts()) this.stream?.rebuild()
  }

  private syncGrassStyle(): void {
    this.scatter.setStyle(this.render.mode === 'pbr' ? this.grassStyleWanted : 'retail')
  }

  /** Whether the placed retail tufts are hidden now (D24: the new grass draws, on the PBR path). */
  get retailTuftsHidden(): boolean {
    return this.tuftsHidden
  }

  /** Applies the retail-tuft filter (D3); true when it changed (the regions must be placed again). */
  private syncTufts(): boolean {
    const hide = this.hideTuftsWanted && this.render.mode === 'pbr' && this.scatter.style === 'field'
    if (hide === this.tuftsHidden) return false
    this.tuftsHidden = hide
    this.objects.setHiddenModels(hide ? isRetailTuftModel : null)
    return true
  }

  /** Makes the wildlife on the PBR path, drops it on the Classic path. */
  private syncLife(): void {
    const want = this.render.mode === 'pbr' && !this.disposed
    if (want === !!this.life) return
    if (!want) {
      this.life?.dispose()
      this.life = null
      return
    }
    let part: LifePart | null = null
    try {
      part = this.parts.life?.({ scene: this.scene, world: this }) ?? null
    } catch (err) {
      console.warn('[world] wildlife failed to start:', err)
    }
    if (!part) return
    this.life = part
    part.setEnabled(this.wildlifeOn)
  }

  /** Wave 11: the Town life level asked for (LoadWorldOptions.townLife, setTownLife); it draws on the PBR path only. */
  get townLife(): TownLifeLevel {
    return this.townLifeWanted
  }

  /** Wave 11 (TOWN_LIFE §8.2): Town life Off / Low / Full on the town part (now, and on every part made later). */
  setTownLife(level: TownLifeLevel): void {
    this.townLifeWanted = level
    if (this.town) this.applyTownLife(this.town)
  }

  /**
   * H11-DET-1 (WAVE_PLAN7 D19): the unique's appear alarm, from server second `fromS` (the notice's server stamp, else
   * its receipt) for `sec` seconds. Forwarded to the town part, and kept: a part made later (a Low → Medium switch
   * during the alarm, a render-mode rebuild) gets the same window, so it shows the alarm as friends' clients do.
   */
  townAlarm(fromS: number, sec: number): void {
    if (!Number.isFinite(fromS) || !(sec > 0)) return
    const a = this.townAlarmAt
    // a notice while one runs extends it (the part does the same)
    if (a && fromS >= a.from && fromS < a.from + a.sec) a.sec = Math.max(a.sec, fromS + sec - a.from)
    else this.townAlarmAt = { from: fromS, sec }
    this.town?.alarm(fromS, sec)
  }

  private applyTownLife(part: TownPart): void {
    const level = this.townLifeWanted
    if (level !== 'off') part.configure({ counts: townCountScale(level) })
    part.setEnabled(level !== 'off')
  }

  /** Wave 11 (W11-S, D2): makes the town on the PBR path, drops it on the Classic path (the Low guard). */
  private syncTown(): void {
    const want = this.render.mode === 'pbr' && !this.disposed
    if (want === !!this.town) return
    if (!want) {
      const t = this.town
      this.town = null
      try {
        t?.dispose()
      } catch (err) {
        console.warn('[world] town life dispose failed:', err)
      }
      return
    }
    let part: TownPart | null = null
    try {
      part = this.parts.town?.({ scene: this.scene, world: this }) ?? null
    } catch (err) {
      console.warn('[world] town life failed to start:', err)
    }
    if (!part) return
    this.town = part
    this.applyTownLife(part)
    const a = this.townAlarmAt
    if (a) part.alarm(a.from, a.sec)
  }

  private makeOcean(): void {
    if (this.ocean || this.disposed) return
    try {
      this.ocean = this.parts.ocean?.({ scene: this.scene, world: this }) ?? null
    } catch (err) {
      console.warn('[world] ocean failed to start:', err)
    }
    this.ocean?.setQuality?.(RENDER_PRESETS[this.quality].ocean)
  }

  /** Wave 10 (COAST S-BOUNCE, S-LIFE): the coast field (the ocean's; null until CST-O builds one). */
  get coast(): CoastAccess | null {
    return this.ocean?.coast ?? null
  }

  /**
   * Wave 10 (COAST S-MOVE, WAVE_PLAN6 D22): the water surface at glTF (x, z): the sea level where the coast field says
   * sea, else the retail water plane of the block, else null (dry ground; ice is ground).
   */
  waterLevelAt(x: number, z: number): number | null {
    const coast = this.coast
    if (coast?.seaAt(x, z)) return coast.seaLevelM
    const hit = this.regions.blockAt(x, z)
    const w = hit?.block.water
    if (hit && w && w.kind === 'water') return (hit.region.origin[1] ?? 0) + w.heightM
    return null
  }

  get timeOfDay(): number {
    return this._timeOfDay
  }

  /** Locates the spawn on the nav again (streaming: once its region's terrain is in). */
  relocateSpawn(): void {
    const h = this.spawnHint
    this.spawn = spawnAt(this.nav, h.x, h.z, h.y)
  }

  /**
   * Re-centres the world on glTF (x, z) at once (teleport, respawn, worldEnter): the environment focus and, when
   * streaming, the region set (RegionStreamer.setFocus).
   */
  setFocus(x: number, z: number): void {
    this.focus.set(x, this.focus.y, z)
    this.stream?.setFocus(x, z)
  }

  // ---- queries ------------------------------------------------------------------------------------------------

  /**
   * Ground height (m) at glTF (x, z): the nav surface nearest to `yHint` (NAVIGATION.md §5.2; +Infinity = the
   * highest, e.g. a plaza above the terrain), else the terrain (closed cells too), else null outside the world.
   */
  heightAt(x: number, z: number, yHint = Infinity): number | null {
    const p = this.nav.locate(x, z, yHint)
    if (p) return p.y
    const t = this.nav.world.terrainHeight(this.nav.fileX(x), this.nav.fileZ(z)) * 0.1
    if (Number.isFinite(t)) return t
    return this.regions.heightAt(x, z)
  }

  /** The surface nearest to yHint at (x, z) with its owner (for keeping a NavPosition), or null. */
  locate(x: number, z: number, yHint = Infinity): NavPosition | null {
    return this.nav.locate(x, z, yHint)
  }

  /** Height of a retained surface at (x, z) (NaN when unknown), for walking along NavLegs. */
  heightOn(surface: NavSurface, x: number, z: number): number {
    return this.nav.heightOn(surface, x, z)
  }

  /**
   * First walkable surface under a view ray (plaza, stairs, bridges, terrain; closed terrain is reported with
   * walkable false). Falls back to the rendered terrain meshes outside the nav data. null when nothing is hit.
   */
  pick(ray: Ray | { origin: Vector3; direction: Vector3 }, maxDist = 600): WorldPick | null {
    const o = ray.origin
    const d = ray.direction
    const hit = pickNav(this.nav, o.x, o.y, o.z, d.x, d.y, d.z, maxDist)
    if (hit) return { ...hit, point: new Vector3(hit.x, hit.y, hit.z) }
    const meshes = new Set<AbstractMesh>(this.terrain.meshes)
    const r = ray instanceof Ray ? ray : new Ray(o, d, maxDist)
    const p = this.scene.pickWithRay(r, m => meshes.has(m))
    if (!p?.hit || !p.pickedPoint) return null
    const q = p.pickedPoint
    return { x: q.x, y: q.y, z: q.z, surface: { kind: 'terrain' }, walkable: false, distance: p.distance, point: q.clone() }
  }

  /** Environment block under glTF (x, z). */
  blockAt(x: number, z: number) {
    return this.regions.blockAt(x, z)
  }

  /** Every mesh the world draws (terrain, water, sky, objects; W10-S: the region batches' and the ocean's; W12: the trees'). */
  meshes(): AbstractMesh[] {
    return [...this.terrain.meshes, ...this.water.meshes, this.sky.mesh, ...this.objects.meshes(), ...(this.ocean?.meshes() ?? []), ...(this.trees?.meshes() ?? [])]
  }

  /**
   * Keeps the world's fixed-function lighting to itself: the world sun lights only the objects, and `others` (the
   * caller's lights for characters) skip them. Layer masks (docs/FIELDS.md §3.5): every object mesh carries
   * WORLD_OBJECT_LAYER, so objects placed later (streaming, objectsReady) are covered too.
   */
  /** W9A perf: the enabled-only active-mesh candidates on or off (render/active-meshes.ts; the LAB A/B). */
  setActiveMeshFilter(on: boolean): void {
    if (on === !!this.activeMeshes || this.disposed) return
    if (on) this.activeMeshes = new EnabledMeshCandidates(this.scene)
    else {
      this.activeMeshes?.dispose()
      this.activeMeshes = null
    }
  }

  isolateLights(others: readonly Light[]): void {
    // PBR path: the renderer's celestial light lights everything (RND-L); nothing to isolate.
    if (this.render.mode === 'pbr') return
    this.sun.includedOnlyMeshes = []
    this.sun.includeOnlyWithLayerMask = WORLD_OBJECT_LAYER
    for (const l of others) l.excludeWithLayerMask |= WORLD_OBJECT_LAYER
  }

  // ---- settings -----------------------------------------------------------------------------------------------

  /**
   * Takes the environment of the block under the focus at once, without the usual transition (streaming: once the
   * focus region is in; before that the profile falls back to the first one).
   */
  resetEnv(): void {
    this.profile = this.profileAt(this.focus.x, this.focus.z)
    this.env = this.targetEnv()
    this.sky.markDirty()
    this.applyEnv()
  }

  /** Sets the local time of day (0..1, 0 = midnight) and freezes it: a running server clock is dropped (setClock). */
  setTimeOfDay(t: number): void {
    this.clock = null
    this.clockDays = null
    this._timeOfDay = ((t % 1) + 1) % 1
    this.env = this.targetEnv() // time changes snap; only profile changes are smoothed
    this.sky.markDirty()
    this.applyEnv()
  }

  /**
   * Wave 9: runs the time of day from the server clock (docs/SKY.md §2.2): every update derives the solar time from
   * `clock` at `serverNow()` (the session's ServerClock). null returns to a local, frozen time (the current one).
   */
  setClock(clock: WorldClockState | null, serverNow: () => number = this.serverNow): void {
    this.clock = clock
    this.serverNow = serverNow
    if (!clock) {
      this.clockDays = null
      return
    }
    this.stepClock()
    this.env = this.targetEnv() // a clock (re)start is a jump: snap like setTimeOfDay
    this.sky.markDirty()
    this.applyEnv()
  }

  /** The server clock (null: local time). */
  get worldClock(): WorldClockState | null {
    return this.clock
  }

  /**
   * Wave 9: the weather of this frame (docs/WAVE_PLAN3.md D13), the one public entry: the sky and the renderer get
   * their own inputs through the pure adapters, the weather subsystem the frame itself. Applied at the next update.
   */
  setWeather(frame: Readonly<WeatherFrame>): void {
    this.weatherFrame = frame
    this.sky.setWeather(toSkyWeather(frame))
    this.render.setWeather(toRenderWeather(frame))
    this.weather.setFrame(frame)
  }

  /** The last weather frame (CLEAR_FRAME until the weather feature sends one). */
  get weatherState(): Readonly<WeatherFrame> {
    return this.weatherFrame
  }

  /** Wave 9: the weather level ('auto' is resolved by the caller). */
  setWeatherLevel(level: WeatherLevel): void {
    this.weather.setLevel(level)
  }

  /** Wave 9: the sky style ('classic' = the retail dome and palette with the Classic weather multipliers). */
  setSkyStyle(style: SkyStyle): void {
    if (style === this.skyStyleValue) return
    this.skyStyleValue = style
    this.sky.setStyle(style)
    this.applyEnv()
  }

  get skyStyle(): SkyStyle {
    return this.skyStyleValue
  }

  /**
   * Wave 9: switches the material path (docs/RENDER.md §3.1: a scene-wide rebuild, like a resolution change). Streamed
   * worlds drop and reload every region and model at once on the new path; a whole-world load keeps its converted
   * materials (reload the world to switch it). No-op when unchanged.
   */
  setRenderMode(mode: RenderPath): void {
    if (mode === this.render.mode) return
    // W10-S (BATCHING F12): every region batch is released before the rebuild and claimed again on the PBR path; the
    // grass field, the tuft filter and the wildlife follow the path (never on Classic: the Low guard).
    this.releaseBatch()
    if (mode !== 'pbr') this.objects.setBatcher(null)
    this.render.setMode(mode)
    this.materials.mode = mode
    this.syncBatch()
    this.syncGrassStyle()
    this.syncTufts()
    // W11-S: the town goes before the wildlife it registers species with, and comes back after it.
    if (mode !== 'pbr') this.syncTown()
    this.syncLife()
    if (mode === 'pbr') this.syncTown()
    // W10 (LG-1): the ocean's shore removes or installs the terrain's wet band before the regions rebuild.
    this.ocean?.setMode?.(mode === 'pbr' ? 'pbr' : 'classic')
    if (this.stream) this.stream.rebuild()
    else console.warn('[world] render path changed: a whole-world load keeps its materials until it is loaded again')
  }

  /** Wave 9: the sky's state of this frame (read-only). */
  get skyState(): Readonly<SkyState> {
    return this.sky.state
  }

  /** Wave 9: fired after every notable sky change (time, night factor), for consumers that are not per-frame. */
  get onSky(): Observable<SkyState> {
    return this.sky.onSky
  }

  /**
   * Wave 9: a per-region commit step (stream.ts addCommitStep). Streaming: its own job after the region's terrain or
   * objects. Whole-world load: run now for every region ('terrain'), or once the objects are placed ('objects').
   * Returns a remover.
   */
  addCommitStep(name: string, run: (region: RegionData) => void, after: CommitStepAfter, debounceMs = 0): () => void {
    if (this.stream) return this.stream.addCommitStep(name, run, after, debounceMs)
    let live = true
    const runAll = () => {
      if (!live || this.disposed) return
      for (const data of this.regions.regions) {
        if (!this.terrain.region(data.region.id)) continue
        try {
          run(data)
        } catch (err) {
          console.warn(`[world] commit step ${name} failed:`, err)
        }
      }
    }
    if (after === 'terrain') runAll()
    else void this.objectsReady.then(runAll)
    return () => {
      live = false
    }
  }

  setQuality(q: WorldQuality | QualitySettings): void {
    const s = typeof q === 'string' ? QUALITY_PRESETS[q] : q
    if (typeof q === 'string') this.quality = q
    this.objects.setRangeScale(s.drawDistance)
    this.objects.setAnimatedVisible(s.animated)
    this.water.setVisible(s.water)
    if (s.scatter) this.scatter.setLevel(s.scatter)
    const render = s.render ?? RENDER_PRESETS[this.quality]
    this.render.setQuality(render)
    this.sky.setQuality(s.sky ?? SKY_PRESETS[this.quality])
    // Wave 10 (W10-S): the grass style (a tuft change rebuilds the streamed regions), the wildlife, the ocean's row.
    if (s.grassStyle && s.grassStyle !== this.grassStyleWanted) this.setGrassStyle(s.grassStyle)
    if (s.wildlife !== undefined) {
      this.wildlifeOn = s.wildlife
      this.life?.setEnabled(s.wildlife)
    }
    this.ocean?.setQuality?.(render.ocean ?? null)
  }

  setFog(on: boolean): void {
    this.flags.fog = on
    this.applyEnv()
  }

  setTerrainLightmap(on: boolean): void {
    this.flags.lightmap = on
    this.applyEnv()
  }

  setTerrainView(view: number): void {
    this.flags.view = view
    this.applyEnv()
  }

  get fog(): boolean {
    return this.flags.fog
  }

  /** Force one environment profile (null: the block under the focus point). */
  setEnvProfile(id: number | null): void {
    this.forcedProfile = id === null ? null : this.envFile.profiles.find(p => p.id === id) ?? null
    this.sky.markDirty()
  }

  get envProfile(): EnvProfile | null {
    return this.profile
  }

  get envForced(): boolean {
    return this.forcedProfile !== null
  }

  /** Current fog range in metres (TERRAIN.md 5.2; wave 9: × the weather's fog scale). */
  get fogRange(): { start: number; end: number } {
    const o = this.envOut()
    return { start: o.fogStartM, end: o.fogEndM }
  }

  // ---- per frame ----------------------------------------------------------------------------------------------

  /**
   * Per frame: environment transitions for the block under `focus` (default the camera target or position), sky,
   * water animation, object draw distance from the camera.
   */
  update(camera: Camera | null = this.scene.activeCamera, focus?: { x: number; z: number }): void {
    if (this.disposed) return
    const dt = Math.min(0.1, this.scene.getEngine().getDeltaTime() / 1000)
    if (focus) this.focus.set(focus.x, 0, focus.z)
    else if (camera) {
      const target = (camera as Camera & { target?: Vector3 }).target
      this.focus.copyFrom(target instanceof Vector3 ? target : camera.globalPosition)
    }
    // 1. clock (a running server clock moves the time of day)
    if (this.clock) this.stepClock()
    const profile = this.profileAt(this.focus.x, this.focus.z)
    if (profile !== this.profile) {
      this.profile = profile
      this.sky.markDirty()
    }
    this.env = approachEnv(this.env, this.targetEnv(), Math.min(1, dt * 0.5)) // TERRAIN.md 5.1 transitions
    // 2. sky → 3. environment → 4. weather → 5. renderer
    this.syncSky()
    this.sky.update(dt, camera)
    this.applyEnv()
    this.weather.update(dt, camera)
    this.render.update(camera, this.sky.state)
    this.objects.tickAnimationSpeed()
    if (camera) this.objects.update(camera.globalPosition)
    // Wave 12 (W12-SA, D2): the trees after the objects (the band refill reads the range scale and the resident slots).
    this.trees?.update(camera, dt)
    // Wave 10 (W10-S, D2): the ocean after the objects, the wildlife after the scatter.
    this.ocean?.update(camera, dt)
    this.scatter.update(camera ? camera.globalPosition : null)
    this.grassTint.update()
    this.life?.update(camera, dt)
    // Wave 11 (W11-S, D2): the town after the wildlife.
    this.town?.update(camera, dt)
    if (this.stream) {
      let forward: { x: number; z: number } | null = null
      if (camera) {
        camera.getDirectionToRef(this.forwardAxis, this.tmpForward)
        this.streamForward.x = this.tmpForward.x
        this.streamForward.z = this.tmpForward.z
        forward = this.streamForward
      }
      this.stream.update(this.focus, forward)
    }
  }

  /**
   * Pushes the current environment values to the scene, terrain and water. Wave 9: the values are the sky's
   * (`sky.envFor()`), with the Classic weather multipliers on the classic sky style, and fog distances × the weather's
   * fog scale on every path.
   */
  applyEnv(): void {
    const { env, fogStartM, fogEndM } = this.envOut()
    const scene = this.scene
    const fogObj = saturate(env.fogColor)
    // The retail terrain fog tint (sqrt) is the classic sky's; the modern sky's far terrain meets its horizon (SKY §6.3).
    const fogTerrain = this.skyStyleValue === 'modern' ? fogObj : fogObj.map(Math.sqrt) as RGB
    const fog = this.flags.fog
    if (!scene.clearColor) scene.clearColor = new Color4()
    scene.clearColor.set(fogObj[0], fogObj[1], fogObj[2], 1)
    scene.fogMode = fog ? Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE
    scene.fogStart = fogStartM
    scene.fogEnd = fogEndM
    scene.fogColor.set(fogObj[0], fogObj[1], fogObj[2])
    scene.ambientColor.set(env.objectAmbient[0], env.objectAmbient[1], env.objectAmbient[2])
    this.tmpColor.set(env.diffuse[0] * 0.6, env.diffuse[1] * 0.6, env.diffuse[2] * 0.6)
    this.sun.diffuse.copyFrom(this.tmpColor)
    this.terrain.setParams(this.terrainParams(fogStartM, fogEndM, fogTerrain, env))
    this.water.update(performance.now(), { color: env.water, fog, fogStartM, fogEndM, fogColor: fogObj })
  }

  /** The environment this frame applies and its fog distances (see applyEnv). */
  private envOut(): { env: EnvValues; fogStartM: number; fogEndM: number } {
    this.syncSky()
    let env = this.sky.envFor()
    if (this.skyStyleValue === 'classic') env = applyWeatherToEnv(env, this.weatherFrame)
    const scale = weatherFogScale(this.weatherFrame)
    let fogStartM = env.g10 * FOG_RANGE_M
    let fogEndM = env.g11 * FOG_RANGE_M
    if (scale.start !== 1) fogStartM *= scale.start
    if (scale.end !== 1) fogEndM *= scale.end
    return { env, fogStartM, fogEndM }
  }

  terrainParams(fogStartM?: number, fogEndM?: number, fogColor?: RGB, env?: EnvValues) {
    if (fogStartM === undefined || fogEndM === undefined || fogColor === undefined || env === undefined) {
      const o = this.envOut()
      env ??= o.env
      fogStartM ??= o.fogStartM
      fogEndM ??= o.fogEndM
      fogColor ??= this.skyStyleValue === 'modern' ? saturate(env.fogColor) : saturate(env.fogColor).map(Math.sqrt) as RGB
    }
    return { lightmap: this.flags.lightmap, fog: this.flags.fog, fogStartM, fogEndM, fogColor, shadowColor: env.terrainShadow, view: this.flags.view }
  }

  /** Hands the sky the current retail palette and time (one reused object: this runs several times a frame). */
  private syncSky(): void {
    const i = this.skyInput
    i.env = this.env
    i.t = this._timeOfDay
    i.days = this.clockDays
    i.declination = this.clock?.declination ?? DEFAULT_CLOCK.declination
    i.profile = this.profile
    this.sky.setRetail(i)
  }

  /** The time of day from the server clock (at most one step per call). */
  private stepClock(): void {
    const c = this.clock
    if (!c) return
    let now: number
    try {
      now = this.serverNow()
    } catch {
      return
    }
    if (!Number.isFinite(now)) return
    const at = clockAt(c, now)
    this.clockDays = at.days
    this._timeOfDay = Math.min(0.999999, Math.max(0, at.t))
  }

  private profileAt(x: number, z: number): EnvProfile | null {
    if (this.forcedProfile) return this.forcedProfile
    const b = this.regions.blockAt(x, z)
    return this.envFile.profiles.find(p => p.id === b?.block.environmentId) ?? this.envFile.profiles[0] ?? null
  }

  private targetEnv(): EnvValues {
    return this.profile ? evaluateProfile(this.profile, this._timeOfDay) : FALLBACK_ENV
  }

  /**
   * A WebGL2 context came back (a driver reset or TDR, a dual-GPU laptop switching GPUs, sleep/resume, Chrome's GPU
   * process restart; W9F X1). Babylon re-creates a texture from its URL or from the CPU copy a raw texture kept; the
   * PBR path streams what it can without keeping either (the terrain tile, map and tier arrays filled layer by layer,
   * the map sets uploaded level by level), so those came back black. A streamed world re-streams every region on a
   * fresh atlas (the region and model reloads re-fetch and re-decode the maps; the map cache empties as the models
   * go), and the sky and the IBL cube refresh. The Classic path keeps its CPU copies and recovers by itself.
   */
  private onContextRestored(): void {
    if (this.disposed || this.render.mode !== 'pbr') return
    if (this.stream) {
      console.info('[world] graphics context restored: re-streaming the regions on the PBR path')
      this.stream.rebuild({ atlas: true })
    } else console.warn('[world] graphics context restored: a whole-world load keeps black map sets until it is loaded again')
    this.sky.restoreGpu()
    const lighting = this.render.lighting as { refreshNow?: () => void } | null
    lighting?.refreshNow?.()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.contextRestored) {
      this.scene.getEngine().onContextRestoredObservable.remove(this.contextRestored)
      this.contextRestored = null
    }
    this.stream?.dispose()
    // Wave 10 (W10-S): the parts go before what they use (the batcher's objects, the life's scatter, the ocean's water).
    this.releaseBatch()
    // Wave 11 (W11-S): the town before the wildlife (its species' removers run against a live life part).
    this.syncTown()
    this.life?.dispose()
    this.life = null
    this.ocean?.dispose()
    this.ocean = null
    this.grassTint.dispose()
    this.scatter.dispose()
    this.foliage.dispose()
    this.objects.dispose()
    this.materials.dispose()
    this.terrain.dispose()
    this.water.dispose()
    this.render.dispose()
    this.weather.dispose()
    this.sky.dispose()
    this.sun.dispose()
    this.activeMeshes?.dispose()
    this.activeMeshes = null
  }
}
