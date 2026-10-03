/**
 * Region converter: a rectangle of outdoor regions -> work/out/world/<name>/ (manifest.json + binaries + PNGs + glbs).
 *
 *   manifest.json                 WorldManifest (./manifest.ts)
 *   terrain/<x>_<z>.bin           TerrainBin (./format.ts)
 *   terrain/<x>_<z>_lightmap.png  .t lightmap (row 0 = south; see WorldRegion.lightmap)
 *   navmesh/<x>_<z>.bin           NavmeshBin (./format.ts)
 *   minimap/<x>x<z>.png           client minimap tile (north-up), for verification
 *   tiles/<tile>.png              tile2d textures used, decoded once
 *   water/*.png                   water101..130, water201, wave1..3
 *   environment.json              the environment.ifo profiles the blocks reference
 *   models/<path>.glb + .json     one per unique .bsr (gltf/convert.ts), with object lightmaps as TEXCOORD_1
 *   lightmaps/<path>.png          object lightmaps, decoded once, referenced from material extras.sroLightmap.uri
 *   nav.bin                       @sro/nav NavData ('SRNV', ./nav.ts): terrain + object navmeshes; manifest.nav
 *
 * Streamed exports (WorldPreset.stream, docs/FIELDS.md §3.9) also write, described by manifest.stream:
 *   nav/<x>_<z>.bin               one SRNV per region: exactly that NavRegion of nav.bin (no models/instances)
 *   nav-objects.bin               SRNV with regions: [] and every model/instance/link of nav.bin, in its order
 *   worldmap.png                  the minimap tiles stitched north-up at 64 px per region (./worldmap.ts)
 * and manifest.bounds (the playable rectangle in glTF metres). manifest.places (GM tp points per client zone name,
 * ./places.ts) is written when WorldPreset.places is set.
 *
 * manifest.spawn is the client's town return point (teleportdata.txt) snapped onto that navigation (./nav.ts).
 *
 * With objects, `ambient.json` (./ambient.ts) indexes the models' BSR ambient particles by the final model indices,
 * plus the town dressing's lamp rows. With WorldPreset.town (wave 11, docs/TOWN_LIFE.md §2.4) the town content files
 * are validated and copied in as `town.json` and `town-dressing.json` (manifest.town), and the placement passes gain
 * the town dressing and the cloth reclass (./passes.ts, docs/WAVE_PLAN7.md D13).
 *
 * Wave 12 (docs/WAVE_PLAN8.md §4.4, D6): with WorldPreset.edits the World Editor's layers (./edits/index.ts, WE-D)
 * hook in through ./edits-hook.ts: the region source overlay editsSource(coastSource(retailSource(...))) in the terrain
 * step, the navmesh-step hook for footprint edits, the "world edits" pass (step 6), the touched regions' lightmaps and
 * minimaps after the passes, the per-region grass masks and light points, ambient.json's free points; the spine checks
 * that the nav and the pass agree on every edited footprint. With WorldPreset.trees the tree-swap step (step 7,
 * ./trees-manifest.ts, T12-A) appends the species and writes `treeSwap`. With no layer and no species the export is
 * byte-identical. `prePassCache` writes the objects step's placements and models before any pass (WE-I's incremental
 * convert re-runs the passes on them). The CLI takes the convert lock (./convert-lock.ts) around a convert.
 *
 * Failures (a model, a missing file) are logged into manifest.warnings / report.failedModels; they never abort.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  assembleRegionGrid,
  decodeDds,
  parseBsr,
  decodeMapTLightmap,
  isRegionActive,
  loadTextdataTable,
  parseDdj,
  parseEnvironment,
  parseMapM,
  parseMapT,
  parseMfo,
  parseNvm,
  parseObjectIfo,
  parseTile2d,
  type MapMFile,
  type NvmFile,
  type RegionGrid,
} from '@sro/formats'
import { NavWorld, type NavData } from '@sro/nav'
import { validateTownFile, type TownDressingFile, type TownFile } from '../../../shared/src/town.ts'
import { zoneNameIndex } from '../data/zones.ts'
import { modelParticles, type ModelParticle } from '../fx/model-fx.ts'
import { toGltfDirection, toGltfPosition, UNIT_SCALE } from '../gltf/space.ts'
import { openArchive, REPO_ROOT, type SroConfig } from '../node-io.ts'
import { encodePng } from '../png.ts'
import { CELLS, encodeNavmeshBin, encodeTerrainBin, roundM } from './format.ts'
import {
  WORLD_MANIFEST_FORMAT,
  WORLD_MANIFEST_VERSION,
  type RegionNavmesh,
  type TileTexture,
  type WorldManifest,
  type WorldModel,
  type WorldNav,
  type WorldPlace,
  type WorldPlacement,
  type WorldRegion,
  type WorldRemasterModelsReport,
  type WorldSpawn,
  type WorldStream,
} from './manifest.ts'
import {
  collectPlacements,
  convertModel,
  ddjToPng,
  normKey,
  outputStem,
  REGION_UNITS,
  resolveObject,
  toPlacement,
  type ModelJob,
} from './objects.ts'
import {
  buildWorldNav, NAV_FILE, NAV_OBJECTS_FILE, NAV_REGION_DIR, parseTeleportData, pickSpawnTeleport, spawnFromTeleport, splitWorldNav,
  TELEPORTDATA_PATH,
} from './nav.ts'
import { createCoastPass, type CoastRun } from './coast/hook.ts'
import { coastMinimapOptions, coastMinimapTile, coastWorldMapFill, coastWorldMapRect, droppedTouches, type CoastMinimapTile } from './coast/minimap.ts'
import { bakeRegionLightmap } from './coast/lightmap.ts'
import { editRegionNav } from './coast/navgen.ts'
import { grassPalettePass } from './grass.ts'
import { editedFootprintProblems, runWorldPasses, type CoastPass, type WorldPasses } from './passes.ts'
import { AMBIENT_FILE, buildAmbientIndex } from './ambient.ts'
import { createClothPass } from './town/cloth.ts'
import { createTownDressingPass } from './town/dressing.ts'
import { applyEnvironmentOverrides, parseEnvironmentOverrides } from './environment-overrides.ts'
import { createWorldEdits, JANGAN_EDITS } from './edits/index.ts'
import { encodePrePassCache, type EditsImage, type WorldEditsRun, type WorldEditsScene } from './edits-hook.ts'
import { buildPlaces } from './places.ts'
import { createTreeSwapPass, TREES_SWAP_FILE } from './trees-manifest.ts'
import { applyRemasterModels, JANGAN_REMASTER_MODELS, parseRemasterModels } from './remaster-models.ts'
import { staticVariantPass } from './static-variants.ts'
import { blockEntry, buildLayers, buildNormals, heightsToMetres } from './terrain.ts'
import { decodePng } from './verify.ts'
import { stitchWorldMap, WORLD_MAP_FILE, WORLD_MAP_PX, type RgbaImage } from './worldmap.ts'

const GENERATOR = 'silkroad-web convert-region (packages/convert/src/world)'

export interface RegionCoord {
  x: number
  z: number
}

export interface WorldPreset {
  x0: number
  x1: number
  z0: number
  z1: number
  /** Region whose south-west corner is the floating origin. */
  centre: RegionCoord
  /** teleportdata.txt CodeName of the spawn point (default: the first return point in the regions). */
  spawnTeleport?: string
  /**
   * Region rectangle the server simulates (inclusive, inside x0..x1 × z0..z1): written as manifest.bounds (glTF
   * metres) and stream.playable. The regions outside it are scenery. Default: none (bounds = the union of the regions).
   */
  playable?: RegionRect
  /** Write the streaming files and manifest.stream (docs/FIELDS.md §3.9). */
  stream?: boolean
  /** Write manifest.places (GM tp points per client zone name, ./places.ts). */
  places?: boolean
  /** manifest.displayName (the server's world display name). */
  displayName?: string
  /**
   * The coast config (docs/COAST.md §5.1, e.g. 'content/coast/coast.json'; relative to the repo root): run the coast
   * pass (./coast/hook.ts). Default: none (no coast; the export is retail).
   */
  coast?: string
  /**
   * Environment profile overrides (e.g. 'content/environment/overrides.json'; relative to the repo root): float graphs
   * that replace retail ones in environment.json (./environment-overrides.ts). Default: none (retail profiles).
   */
  environmentOverrides?: string
  /**
   * The town content (wave 11, docs/TOWN_LIFE.md §2.4; relative to the repo root): validated, copied into the export,
   * and the dressing applied by the placement passes. Default: none (no town files; no dressing or cloth pass).
   */
  town?: WorldTownConfig
  /**
   * Wave 12: the World Editor's layer folder (e.g. 'content/world-edits/jangan-fields'; relative to the repo root):
   * applied through ./edits/index.ts. A missing or empty folder changes nothing. Default: none.
   */
  edits?: string
  /** Wave 12: the tree swap table (e.g. 'content/trees/swap.json'): the tree-swap step (./trees-manifest.ts). Default: none. */
  trees?: string
  /**
   * DRAGON-INT: the remastered models table (e.g. 'content/remaster/models.json'; relative to the repo root): each listed
   * retail model gets its staged replacement as a `remasterVariant` (./remaster-models.ts). Default: none.
   */
  remasterModels?: string
}

/** WorldPreset.town: the content files (either may be missing on disk; a missing file is skipped with a log line). */
export interface WorldTownConfig {
  /** The town file (kind 'town', TL-R), copied as `town.json`. */
  file?: string
  /** The dressing file (kind 'townDressing', TL-B), copied as `town-dressing.json`; its lamps feed ambient.json. */
  dressing?: string
}

/** The town content of the jangan-fields export (docs/WAVE_PLAN7.md D18: two files, two owners). */
export const JANGAN_TOWN: WorldTownConfig = { file: 'content/town/jangan.json', dressing: 'content/town/jangan-dressing.json' }
/** Names of the copied town files in the export folder (the client loads /out/world/<world>/town.json). */
export const TOWN_FILE = 'town.json'
export const TOWN_DRESSING_FILE = 'town-dressing.json'

/** The coast config of the jangan-fields export (docs/COAST.md §5.1). */
export const JANGAN_COAST_CONFIG = 'content/coast/coast.json'
/** The environment profile overrides of the jangan-fields export (./environment-overrides.ts). */
export const JANGAN_ENV_OVERRIDES = 'content/environment/overrides.json'

export interface RegionRect {
  x0: number
  x1: number
  z0: number
  z1: number
}

export const WORLD_PRESETS: Readonly<Record<string, WorldPreset>> = {
  /**
   * Jangan town: regions X 167..169, Z 96..98, centre 168,97 (0x61A8). Spawn: GATE_CH, Jangan's teleport arrival
   * and return (resurrect) point.
   */
  jangan: { x0: 167, x1: 169, z0: 96, z1: 98, centre: { x: 168, z: 97 }, spawnTeleport: 'GATE_CH' },
  /**
   * The level 1-20 fields around Jangan (docs/FIELDS.md §1.4), streamed: export X 155..175 × Z 89..103 (307 active
   * regions), playable X 156..174 × Z 90..102 (247 regions; the outer ring is scenery). Same frame as `jangan`. With
   * the coast (docs/COAST.md, content/coast/coast.json): beaches all round, the sea's synthetic regions beyond the
   * export, and S1's in-bounds link.
   */
  'jangan-fields': {
    x0: 155, x1: 175, z0: 89, z1: 103, centre: { x: 168, z: 97 }, spawnTeleport: 'GATE_CH',
    playable: { x0: 156, x1: 174, z0: 90, z1: 102 }, stream: true, places: true, displayName: 'Jangan', coast: JANGAN_COAST_CONFIG,
    environmentOverrides: JANGAN_ENV_OVERRIDES, town: JANGAN_TOWN, edits: JANGAN_EDITS, trees: TREES_SWAP_FILE,
    remasterModels: JANGAN_REMASTER_MODELS,
  },
  /**
   * The cut-plan fallback (docs/WAVE_PLAN.md §7): Jangan and the ring of fields around it, X 166..170 × Z 95..99
   * (25 regions), not streamed, loadable by today's single-world client and server. Same frame as `jangan`.
   */
  'jangan-near': {
    x0: 166, x1: 170, z0: 95, z1: 99, centre: { x: 168, z: 97 }, spawnTeleport: 'GATE_CH', places: true, displayName: 'Jangan',
  },
}

/** Streaming radii for the medium preset (docs/FIELDS.md §3.2). */
export const STREAM_LOAD_RADIUS_M = 400
export const STREAM_UNLOAD_RADIUS_M = 560

/** Regions of a rectangle, ordered by z then x. */
export function regionRange(x0: number, x1: number, z0: number, z1: number): RegionCoord[] {
  const out: RegionCoord[] = []
  for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.push({ x, z })
  }
  return out
}

/** '167-169,96-98' (or '168,97') -> the rectangle and its centre region (the middle one, rounded down). */
export function parseRegionSpec(spec: string): WorldPreset {
  const m = /^(\d+)(?:-(\d+))?,(\d+)(?:-(\d+))?$/.exec(spec.trim())
  if (!m) throw new Error(`bad --regions ${JSON.stringify(spec)}; expected <x0>-<x1>,<z0>-<z1>`)
  const x0 = Number(m[1])
  const x1 = Number(m[2] ?? m[1])
  const z0 = Number(m[3])
  const z1 = Number(m[4] ?? m[3])
  const lo = (a: number, b: number) => Math.min(a, b)
  return {
    x0: lo(x0, x1), x1: Math.max(x0, x1), z0: lo(z0, z1), z1: Math.max(z0, z1),
    centre: { x: Math.floor((x0 + x1) / 2), z: Math.floor((z0 + z1) / 2) },
  }
}

/** glTF position (m) of region (x, z)'s south-west corner relative to the floating origin (via space.ts). */
export function regionOrigin(region: RegionCoord, origin: RegionCoord): [number, number, number] {
  const p = toGltfPosition([REGION_UNITS * (region.x - origin.x), 0, REGION_UNITS * (region.z - origin.z)])
  return [p[0] + 0, p[1] + 0, p[2] + 0] // + 0 turns -0 into 0
}

export interface ConvertWorldOptions {
  name: string
  regions: RegionCoord[]
  /** Floating origin: south-west corner of this region. */
  origin: RegionCoord
  /** Output directory (normally work/out/world/<name>). */
  outDir: string
  objects?: boolean
  /** Per-region navmesh bins, nav.bin and the spawn (default true). */
  navmesh?: boolean
  /** teleportdata.txt CodeName of the spawn point (WorldPreset.spawnTeleport). */
  spawnTeleport?: string
  /** Run the Khronos validator on every model glb (default true). */
  validate?: boolean
  /** Convert at most this many unique models (testing); the rest are listed as failed with reason 'skipped'. */
  maxModels?: number
  /** WorldPreset.playable: manifest.bounds and stream.playable (region units, inclusive). */
  playable?: RegionRect
  /** WorldPreset.stream: nav/<x>_<z>.bin, nav-objects.bin, worldmap.png and manifest.stream. */
  stream?: boolean
  /** WorldPreset.places: manifest.places (needs nav.bin and a spawn). */
  places?: boolean
  /** WorldPreset.displayName: manifest.displayName. */
  displayName?: string
  /** WorldPreset.coast: the coast config (relative to the repo root, or absolute). */
  coast?: string
  /** WorldPreset.environmentOverrides (relative to the repo root, or absolute). */
  environmentOverrides?: string
  /** WorldPreset.town (paths relative to the repo root, or absolute). */
  town?: WorldTownConfig
  /** WorldPreset.edits (relative to the repo root, or absolute). */
  edits?: string
  /** The edits run itself, replacing the one `edits` would build (null: none). For tests and tools (WE-I). */
  editsRun?: WorldEditsRun | null
  /** WorldPreset.trees (relative to the repo root, or absolute). */
  trees?: string
  /** WorldPreset.remasterModels (relative to the repo root, or absolute). Only with objects. */
  remasterModels?: string
  /**
   * Write the pre-pass placement cache (./edits-hook.ts PrePassCache) to this file (absolute; outside the export, it is
   * never deployed). Only with objects. Default: none.
   */
  prePassCache?: string
  /**
   * Replaces the default placement passes (./passes.ts: coast when `coast` is set, the town dressing when `town` has a
   * dressing file and objects are converted, the cloth reclass when `town` is set and objects are converted, static
   * variants when objects are converted, grass palettes, the world edits from `edits` / `editsRun`, the tree swap when
   * `trees` is set and objects are converted); a key set to null turns that pass off. For tests and tools.
   */
  passes?: WorldPasses
  cfg?: SroConfig
  log?: (line: string) => void
}

export interface ConvertWorldResult {
  manifest: WorldManifest
  manifestFile: string
}

const mb = (n: number) => (n / 2 ** 20).toFixed(2)

export async function convertWorld(opts: ConvertWorldOptions): Promise<ConvertWorldResult> {
  const t0 = performance.now()
  const log = opts.log ?? (() => {})
  const { outDir, origin } = opts
  const data = openArchive('Data', opts.cfg)
  const map = openArchive('Map', opts.cfg)
  const media = openArchive('Media', opts.cfg)
  const warnings: string[] = []
  const sizes: Record<string, number> = {}
  const timeMs = { total: 0, terrain: 0, navmesh: 0, objects: 0, textures: 0, nav: 0, stream: 0 }
  mkdirSync(outDir, { recursive: true })

  const write = (rel: string, bytes: Uint8Array | string, category: string) => {
    const file = join(outDir, ...rel.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
    const n = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength
    sizes[category] = (sizes[category] ?? 0) + n
    return n
  }
  const pngOut = (rel: string, width: number, height: number, rgba: Uint8Array, category: string) =>
    write(rel, encodePng(width, height, rgba), category)

  const mfo = parseMfo(map.read('mapinfo.mfo'))
  const tile2d = parseTile2d(map.read('tile2d.ifo'))

  // The coast pass (docs/COAST.md §5.4) runs before the terrain, which it overlays (./coast/source.ts: loadRegion, the
  // normals' globalHeight and the .nvm read go through it, and it adds the synthetic regions); its C9 placement edits
  // run first among the placement passes below.
  const playableRect = opts.playable ?? (opts.stream ? rectOf(opts.regions) : undefined)
  let coastPass: CoastPass | null = null
  let coast: CoastRun | null = null
  if (opts.passes?.coast !== undefined) coastPass = opts.passes.coast
  else if (opts.coast) {
    const configFile = isAbsolute(opts.coast) ? opts.coast : resolve(REPO_ROOT, opts.coast)
    const retailRegion = (x: number, z: number) => {
      const path = `${z}/${x}.m`
      if (x < 0 || x > 255 || z < 0 || z > 127 || !map.has(path)) return null
      const mapm = parseMapM(map.read(path))
      return { mapm, grid: assembleRegionGrid(mapm) }
    }
    coast = await createCoastPass({
      configFile, outDir, origin, regions: opts.regions, playable: playableRect, cfg: opts.cfg, warnings, log,
      readRegion: retailRegion, active: (x, z) => isRegionActive(mfo, x, z), tileType: id => tile2d.byId.get(id)?.typeName ?? null,
    })
    coastPass = coast
  }
  // The world edits (wave 12): none without a layer (the export stays byte-identical)
  const editsRun: WorldEditsRun | null = opts.editsRun !== undefined
    ? opts.editsRun
    : opts.edits
      ? await createWorldEdits({
        dir: isAbsolute(opts.edits) ? opts.edits : resolve(REPO_ROOT, opts.edits), world: opts.name, outDir, origin, regions: opts.regions, warnings, log,
        ...(playableRect ? { playable: playableRect } : {}),
        coastField: () => {
          const c = coastPass?.manifestCoast?.()
          return c ? { file: join(outDir, ...c.field.file.split('/')), field: c.field } : null
        },
      })
      : null
  const touched = editsRun?.touched ?? new Set<number>()

  // --- terrain ------------------------------------------------------------------------------------------------------
  let t = performance.now()
  const mapmCache = new Map<number, { mapm: MapMFile; grid: RegionGrid } | null>()
  const retailCache = new Map<number, { mapm: MapMFile; grid: RegionGrid } | null>()
  /** The retail terrain of an active region (mapinfo.mfo), or null. */
  const loadRetail = (x: number, z: number) => {
    const id = (z << 8) | x
    if (!retailCache.has(id)) {
      let entry: { mapm: MapMFile; grid: RegionGrid } | null = null
      const path = `${z}/${x}.m`
      if (x >= 0 && x <= 255 && z >= 0 && z <= 127 && isRegionActive(mfo, x, z) && map.has(path)) {
        try {
          const mapm = parseMapM(map.read(path))
          entry = { mapm, grid: assembleRegionGrid(mapm) }
        } catch (e) {
          warnings.push(`${path}: ${(e as Error).message}`)
        }
      }
      retailCache.set(id, entry)
    }
    return retailCache.get(id)!
  }
  /**
   * The region's terrain as exported: editsSource(coastSource(retailSource(...))): the coast's (changed or synthetic)
   * when a coast pass ran, else retail; then the world edits' where they touch the region.
   */
  const loadRegion = (x: number, z: number): { mapm: MapMFile; grid: RegionGrid; synthetic?: boolean } | null => {
    const id = (z << 8) | x
    if (!mapmCache.has(id)) {
      const base = coast ? coast.source.terrain(x, z, loadRetail(x, z)) : loadRetail(x, z)
      mapmCache.set(id, editsRun?.terrain && touched.has(id) ? editsRun.terrain(x, z, base) : base)
    }
    return mapmCache.get(id)!
  }
  const globalHeight = (ggx: number, ggz: number): number | undefined => {
    if (ggx < 0 || ggz < 0) return undefined
    const edited = editsRun?.height?.(ggx, ggz)
    if (edited !== undefined) return edited
    const own = coast?.source.height(ggx, ggz)
    if (own !== undefined) return own
    const rx = Math.floor(ggx / CELLS)
    const rz = Math.floor(ggz / CELLS)
    const r = loadRetail(rx, rz)
    return r ? r.grid.heights[(ggz - rz * CELLS) * 97 + (ggx - rx * CELLS)] : undefined
  }

  const regions: WorldRegion[] = []
  const regionsSkipped: string[] = []
  const usedTiles = new Set<number>()
  const usedProfiles = new Set<number>()
  const layerHistogram: number[] = []
  // the export's regions, then the coast's synthetic regions (docs/COAST.md §5.4), in z then x order
  const exportKeys = new Set(opts.regions.map(r => (r.z << 8) | r.x))
  const regionList = coast
    ? [...opts.regions, ...coast.source.synthetic.filter(r => !exportKeys.has((r.z << 8) | r.x))].sort((a, b) => a.z - b.z || a.x - b.x)
    : opts.regions
  let minimapOpts = coast ? coastMinimapOptions(coast.config) : null
  /** The client's minimap tile of a region, decoded, or null. */
  const retailMinimap = (x: number, z: number): RgbaImage | null => {
    const path = `minimap/${x}x${z}.ddj`
    if (!media.has(path)) return null
    try {
      return decodeDds(parseDdj(media.read(path)).dds)
    } catch (e) {
      warnings.push(`${path}: ${(e as Error).message}`)
      return null
    }
  }
  const coastTiles = new Map<number, CoastMinimapTile>()
  /** The written lightmaps of the regions the edits touch (their after-pass hook re-bakes from them). */
  const editLightmaps = new Map<number, EditsImage>()
  // the edited regions load first, so a neighbour built earlier reads every edited vertex on its border (normals)
  for (const rc of regionList) if (touched.has((rc.z << 8) | rc.x)) loadRegion(rc.x, rc.z)
  for (const rc of regionList) {
    const { x, z } = rc
    const loaded = loadRegion(x, z)
    if (!loaded) {
      const why = !isRegionActive(mfo, x, z) ? 'inactive in mapinfo.mfo' : 'no parseable .m'
      regionsSkipped.push(`${x},${z}: ${why}`)
      warnings.push(`region ${x},${z} skipped: ${why}`)
      continue
    }
    const { mapm, grid } = loaded
    const layers = buildLayers(mapm)
    layers.layersPerCell.forEach((n, k) => (layerHistogram[k] = (layerHistogram[k] ?? 0) + n))
    if (layers.overflowCells) warnings.push(`region ${x},${z}: ${layers.overflowCells} cell(s) exceed ${8} layers`)
    if (grid.edgeConflicts.length) warnings.push(`region ${x},${z}: ${grid.edgeConflicts.length} block-edge height conflict(s) (later block wins)`)
    const heights = heightsToMetres(grid.heights)
    const bin = encodeTerrainBin({
      layerCount: layers.layerCount,
      heights,
      normals: buildNormals(x, z, globalHeight),
      textures: grid.textures,
      layers: layers.layers,
    })
    const terrainFile = `terrain/${x}_${z}.bin`
    write(terrainFile, bin, 'terrain')
    let hMin = Infinity
    let hMax = -Infinity
    for (const h of heights) {
      hMin = Math.min(hMin, h)
      hMax = Math.max(hMax, h)
    }
    hMin = roundM(hMin)
    hMax = roundM(hMax)
    const tileIds = [...new Set(grid.textureIds)].sort((a, b) => a - b)
    for (const id of tileIds) usedTiles.add(id)
    const blocks = mapm.blocks.map(blockEntry)
    for (const b of blocks) usedProfiles.add(b.environmentId)

    const synthetic = loaded.synthetic === true
    // a look-only synthetic region (Option A's corridor, ./coast/source.ts) keeps its retail lightmap and minimap
    const madeUp = synthetic && !coast?.source.isLookOnly(x, z)
    let lightmap: WorldRegion['lightmap'] = null
    const tPath = `${z}/${x}.t`
    if (madeUp) {
      // no retail lightmap: the coast bakes the sun's shadows on a white base (./coast/lightmap.ts)
      const img = coast ? bakeRegionLightmap(coast.result, coast.retail.heights, x, z, null) : null
      if (img) {
        const file = `terrain/${x}_${z}_lightmap.png`
        pngOut(file, img.width, img.height, img.rgba, 'lightmaps.terrain')
        lightmap = { file, width: img.width, height: img.height }
        if (touched.has((z << 8) | x)) editLightmaps.set((z << 8) | x, img)
      }
    } else if (map.has(tPath)) {
      try {
        const retailImg = decodeMapTLightmap(parseMapT(map.read(tPath)))
        // where the coast moved the ground, the retail shadows of the old terrain are re-baked (docs/COAST.md §5.4)
        const img = (coast && coast.source.changed(x, z, loadRetail(x, z)) ? bakeRegionLightmap(coast.result, coast.retail.heights, x, z, retailImg) : null) ?? retailImg
        const file = `terrain/${x}_${z}_lightmap.png`
        pngOut(file, img.width, img.height, img.rgba, 'lightmaps.terrain')
        lightmap = { file, width: img.width, height: img.height }
        if (touched.has((z << 8) | x) && img.rgba) editLightmaps.set((z << 8) | x, { width: img.width, height: img.height, rgba: img.rgba })
      } catch (e) {
        warnings.push(`${tPath}: ${(e as Error).message}`)
      }
    } else warnings.push(`${tPath}: missing (render the region unlit / white lightmap)`)

    let minimap: string | null = null
    const mmPath = `minimap/${x}x${z}.ddj`
    // the coast's tile (docs/COAST.md §11, CST-M's ./coast/minimap.ts) for a changed or synthetic region
    const coastTile = coast && minimapOpts && (madeUp || coast.source.changed(x, z, loadRetail(x, z)))
      ? coastMinimapTile(coast.result, coast.retail.heights, x, z, madeUp ? null : retailMinimap(x, z), minimapOpts)
      : null
    if (coastTile && coastTile.kind !== 'retail') {
      const rel = `minimap/${x}x${z}.png`
      pngOut(rel, coastTile.width, coastTile.height, coastTile.rgba, 'minimap')
      coastTiles.set((z << 8) | x, coastTile)
      minimap = rel
    } else if (!madeUp && media.has(mmPath)) {
      try {
        const rel = `minimap/${x}x${z}.png`
        const r = ddjToPng(media.read(mmPath), outDir, rel)
        sizes.minimap = (sizes.minimap ?? 0) + r.bytes
        minimap = rel
      } catch (e) {
        warnings.push(`${mmPath}: ${(e as Error).message}`)
      }
    }

    const o = regionOrigin(rc, origin)
    const far = toGltfPosition([REGION_UNITS, 0, REGION_UNITS])
    regions.push({
      x,
      z,
      id: (z << 8) | x,
      origin: o,
      bounds: {
        min: [Math.min(o[0], o[0] + far[0]), hMin, Math.min(o[2], o[2] + far[2])],
        max: [Math.max(o[0], o[0] + far[0]), hMax, Math.max(o[2], o[2] + far[2])],
      },
      terrain: { file: terrainFile, bytes: bin.byteLength, heightMinM: hMin, heightMaxM: hMax, layerCount: layers.layerCount, tileIds },
      lightmap,
      minimap,
      blocks,
      navmesh: null,
      ...(synthetic ? { synthetic: true as const } : {}),
    })
  }
  timeMs.terrain = performance.now() - t
  log(`terrain: ${regions.length} region(s) in ${(timeMs.terrain / 1000).toFixed(1)} s; layers per cell ${layerHistogram.map((n, k) => `${k}:${n}`).join(' ')}`)

  // --- navmesh ------------------------------------------------------------------------------------------------------
  t = performance.now()
  const navInputs: Array<{ id: number; nvm: NvmFile }> = []
  if (opts.navmesh !== false) {
    for (const region of regions) {
      // a synthetic region has no navigation (docs/COAST.md §9.1): the server's clamp keeps everyone inside the bounds
      if (region.synthetic) continue
      const path = `navmesh/nv_${region.id.toString(16).padStart(4, '0')}.nvm`
      if (!data.has(path)) {
        warnings.push(`${path}: missing`)
        continue
      }
      try {
        let nvm = parseNvm(data.read(path))
        const edit = coast?.source.navEdit(region.x, region.z, loadRetail(region.x, region.z))
        if (coast && edit) {
          const edited = editRegionNav(nvm, edit)
          nvm = edited.nvm
          coast.noteNav(edited.stats)
        }
        // the world edits' nav (closed tiles, moved / dropped / added footprints; docs/WORLD_EDITOR.md §6.3)
        const editedNvm = editsRun?.navEdit?.(region.id, nvm)
        if (editedNvm) nvm = editedNvm
        navInputs.push({ id: region.id, nvm })
        const cells = new Float32Array(nvm.cells.length * 4)
        nvm.cells.forEach((c, i) => cells.set([c.minX, c.minZ, c.maxX, c.maxZ], i * 4))
        const edgesAll = [...nvm.globalEdges, ...nvm.internalEdges]
        const edges = new Float32Array(edgesAll.length * 4)
        const edgeFlags = new Uint8Array(edgesAll.length)
        edgesAll.forEach((e, i) => {
          edges.set([e.ax, e.az, e.bx, e.bz], i * 4)
          edgeFlags[i] = e.flag
        })
        const bin = encodeNavmeshBin({
          openCellCount: nvm.openCellCount,
          globalEdgeCount: nvm.globalEdges.length,
          heights: heightsToMetres(nvm.heights),
          tileCells: nvm.tileCells,
          cells,
          edges,
          tileFlags: nvm.tileFlags,
          edgeFlags,
        })
        const file = `navmesh/${region.x}_${region.z}.bin`
        write(file, bin, 'navmesh')
        const nav: RegionNavmesh = {
          file,
          bytes: bin.byteLength,
          cells: nvm.cells.length,
          openCells: nvm.openCellCount,
          globalEdges: nvm.globalEdges.length,
          internalEdges: nvm.internalEdges.length,
          objects: nvm.objects.length,
          planes: nvm.planeTypes && nvm.planeHeights
            ? [...nvm.planeTypes].map((type, i) => ({ type, heightM: roundM(nvm.planeHeights![i]! * UNIT_SCALE) }))
            : null,
        }
        region.navmesh = nav
      } catch (e) {
        warnings.push(`${path}: ${(e as Error).message}`)
      }
    }
  }
  timeMs.navmesh = performance.now() - t

  // --- navigation (nav.bin) and spawn ---------------------------------------------------------------------------------
  t = performance.now()
  let nav: WorldNav | undefined
  let spawn: WorldSpawn | undefined
  let navData: NavData | undefined
  let navWorld: NavWorld | undefined
  if (navInputs.length) {
    try {
      const built = buildWorldNav(navInputs, p => (data.has(p) ? data.read(p) : undefined), warnings)
      navData = built.data
      const bytes = write(NAV_FILE, built.bytes, 'nav')
      nav = { file: NAV_FILE, bytes, ...built.info }
      log(`nav: ${nav.instances} object navmesh instances (${nav.neighbourInstances} owned by neighbours, ${nav.compoundInstances} compounds), ` +
        `${nav.models} models, ${nav.links} links, ${mb(bytes)} MiB`)
      if (!media.has(TELEPORTDATA_PATH)) warnings.push(`${TELEPORTDATA_PATH}: missing (no spawn)`)
      else {
        const teleport = pickSpawnTeleport(parseTeleportData(media.read(TELEPORTDATA_PATH)), new Set(nav.regions), opts.spawnTeleport)
        if (!teleport) warnings.push(`spawn: no ${opts.spawnTeleport ?? 'return point'} in teleportdata.txt within the converted regions`)
        else {
          navWorld = new NavWorld(built.data)
          const r = spawnFromTeleport(navWorld, teleport, origin)
          if ('error' in r) warnings.push(`spawn: ${r.error}`)
          else {
            spawn = r.spawn
            log(`spawn: (${spawn.x}, ${spawn.y}, ${spawn.z}) from ${teleport.code}`)
            // S1's in-bounds link (docs/COAST.md §3.5, G1): the walkable beach reaches the town with the ring closed
            if (coast) {
              const ok = coast.checkLink(built.data, { x: origin.x * 1920 + spawn.x * 10, y: spawn.y * 10, z: origin.z * 1920 - spawn.z * 10 })
              log(`coast: S1 ${ok ? 'reaches' : 'does NOT reach'} the town inside the bounds`)
            }
          }
        }
      }
    } catch (e) {
      warnings.push(`nav: ${(e as Error).message}`)
    }
  }
  timeMs.nav = performance.now() - t

  // --- streaming files, bounds and places (docs/FIELDS.md §3.9, §4.6) ----------------------------------------------
  t = performance.now()
  const playable = playableRect
  const bounds = playable && rectBounds(playable, origin)
  let stream: WorldStream | undefined
  /** Stitches the world map and returns manifest.stream; called after the placement passes (C9's drops, ./coast). */
  let finishStream: (() => WorldStream) | null = null
  /** Minimap tiles the world edits redrew (after the passes); the world map stitches them first. */
  const editTiles = new Map<number, RgbaImage>()
  if (opts.stream) {
    let navRegionBytes = 0
    let navObjectBytes = 0
    if (navData) {
      const split = splitWorldNav(navData)
      for (const r of split.regions) navRegionBytes += write(r.file, r.bytes, 'nav.regions')
      navObjectBytes = write(NAV_OBJECTS_FILE, split.objects, 'nav.objects')
    } else warnings.push('stream: no nav.bin, so no nav chunks')
    const exportRect = rectOf(opts.regions)
    const active = new Set(regions.filter(r => !r.synthetic).map(r => r.id))
    const retailTile = (x: number, z: number): RgbaImage | null => {
      const path = `minimap/${x}x${z}.ddj`
      if (!active.has((z << 8) | x) || !media.has(path)) return null
      try {
        return decodeDds(parseDdj(media.read(path)).dds)
      } catch (e) {
        warnings.push(`worldmap ${path}: ${(e as Error).message}`)
        return null
      }
    }
    // with a coast the map grows to the coast domain and the sea fills it (docs/COAST.md §11, CST-M)
    const domain = coast ? { x0: coast.config.domain.x[0], x1: coast.config.domain.x[1], z0: coast.config.domain.z[0], z1: coast.config.domain.z[1] } : null
    const rect = domain ? coastWorldMapRect(exportRect, domain) : exportRect
    const tile = (x: number, z: number): RgbaImage | null => {
      const key = (z << 8) | x
      const edited = editTiles.get(key)
      if (edited) return edited
      const own = coastTiles.get(key)
      if (own) return own
      if (active.has(key) || !coast || !minimapOpts) return retailTile(x, z)
      return coastMinimapTile(coast.result, coast.retail.heights, x, z, isRegionActive(mfo, x, z) ? retailMinimap(x, z) : null, minimapOpts)
    }
    finishStream = () => {
      const img = coast ? stitchWorldMap(rect, tile, WORLD_MAP_PX, coastWorldMapFill(coast.manifestCoast?.())) : stitchWorldMap(rect, tile)
      pngOut(WORLD_MAP_FILE, img.width, img.height, img.rgba, 'worldmap')
      log(`stream: playable ${playable!.x0}-${playable!.x1} x ${playable!.z0}-${playable!.z1}; ${navData?.regions.length ?? 0} nav chunks ` +
        `${mb(navRegionBytes)} MiB, ${NAV_OBJECTS_FILE} ${mb(navObjectBytes)} MiB; ${WORLD_MAP_FILE} ${img.width} x ${img.height} (${img.tiles} tiles)`)
      return {
        playable: playable!,
        navRegions: { dir: NAV_REGION_DIR, bytes: navRegionBytes },
        navObjects: { file: NAV_OBJECTS_FILE, bytes: navObjectBytes },
        worldMap: { file: WORLD_MAP_FILE, pxPerRegion: WORLD_MAP_PX, ...rect, width: img.width, height: img.height },
        loadRadiusM: STREAM_LOAD_RADIUS_M,
        unloadRadiusM: STREAM_UNLOAD_RADIUS_M,
      }
    }
  }
  let places: WorldPlace[] | undefined
  if (opts.places) {
    const dir = 'server_dep/silkroad/textdata'
    if (!navWorld || !spawn) warnings.push('places: need nav.bin and a spawn; none written')
    else {
      try {
        const table = loadTextdataTable('textzonename.txt', name => (media.has(`${dir}/${name}`) ? media.read(`${dir}/${name}`) : undefined))
        places = buildPlaces({
          world: navWorld, origin, spawn, zoneNames: zoneNameIndex(table.rows.map(r => r.cells), table.header),
          regions, playable, warnings,
        })
        if (coast) {
          const own = coast.places(navWorld, origin)
          places = [...places.filter(p => !own.some(q => q.name === p.name)), ...own]
        }
        log(`places: ${places.length} (${places.map(p => p.name).join(', ')})`)
      } catch (e) {
        warnings.push(`places: ${(e as Error).message}`)
      }
    }
  }
  timeMs.stream = performance.now() - t

  // --- shared textures ----------------------------------------------------------------------------------------------
  t = performance.now()
  let tiles: TileTexture[] = []
  for (const id of [...usedTiles].sort((a, b) => a - b)) {
    const entry = tile2d.byId.get(id)
    if (!entry) {
      warnings.push(`tile2d.ifo has no id ${id}`)
      continue
    }
    const rel = `tiles/${entry.file.toLowerCase().replace(/\.ddj$/, '')}.png`
    try {
      const r = ddjToPng(map.read(entry.path), outDir, rel)
      sizes.tiles = (sizes.tiles ?? 0) + r.bytes
      tiles.push({ id, source: entry.file, file: rel, width: r.width, height: r.height, typeName: entry.typeName ?? null, category: entry.category })
    } catch (e) {
      warnings.push(`tile ${id} ${entry.path}: ${(e as Error).message}`)
    }
  }
  const waterPng = (name: string): string | null => {
    const path = `water/${name}.ddj`
    if (!map.has(path)) return null
    try {
      const rel = `water/${name}.png`
      sizes.water = (sizes.water ?? 0) + ddjToPng(map.read(path), outDir, rel).bytes
      return rel
    } catch (e) {
      warnings.push(`${path}: ${(e as Error).message}`)
      return null
    }
  }
  const frames: string[] = []
  for (let i = 101; i <= 130; i++) {
    const f = waterPng(`water${i}`)
    if (f) frames.push(f)
  }
  if (coast) {
    // the palette's surface types (sand sounds and wets like sand, docs/COAST.md §5.4 step 6)
    const names = coast.typeNames()
    tiles = tiles.map(tl => (names.has(tl.id) ? { ...tl, typeName: names.get(tl.id)! } : tl))
  }
  const ice = waterPng('water201')
  const waves = ['wave1', 'wave2', 'wave3'].map(waterPng).filter((f): f is string => f !== null)

  const env = parseEnvironment(map.read('environment.ifo'))
  let profiles = [...usedProfiles].sort((a, b) => a - b).map(id => {
    const p = env.byId.get(id)
    if (!p) warnings.push(`environment.ifo has no profile ${id}`)
    return p
  }).filter(p => p !== undefined)
  let envOverrides: string[] = []
  if (opts.environmentOverrides) {
    const file = isAbsolute(opts.environmentOverrides) ? opts.environmentOverrides : resolve(REPO_ROOT, opts.environmentOverrides)
    const res = applyEnvironmentOverrides(profiles, parseEnvironmentOverrides(readFileSync(file, 'utf8')))
    profiles = res.profiles
    envOverrides = res.applied
    for (const line of envOverrides) log(`environment override: ${line}`)
  }
  write('environment.json', JSON.stringify({
    source: 'Map/environment.ifo',
    note: 'time 0 = midnight, 0.5 = noon; fog start/end fractions are graph10/graph11 (TERRAIN.md 5)',
    ...(opts.environmentOverrides ? { overrides: { file: opts.environmentOverrides, applied: envOverrides } } : {}),
    profiles,
  }, null, 1) + '\n', 'environment')
  timeMs.textures = performance.now() - t

  // --- objects ------------------------------------------------------------------------------------------------------
  t = performance.now()
  let models: WorldModel[] = []
  let placements: WorldPlacement[] = []
  const failedModels: Array<{ source: string; error: string }> = []
  let placementRecords = 0
  let dedupeConflicts = 0
  let uniqueObjectIds = 0
  let compoundPlacements = 0
  let validatorErrors = 0
  const objectLightmaps = new Map<string, string>()
  let remasterReport: WorldRemasterModelsReport | undefined
  if (opts.objects !== false) {
    const ifo = parseObjectIfo(map.read('object.ifo'))
    const collected = collectPlacements(map, regions)
    for (const f of collected.missingFiles) warnings.push(`${f}: missing (no objects)`)
    placementRecords = collected.records
    dedupeConflicts = collected.conflicts
    if (dedupeConflicts) warnings.push(`${dedupeConflicts} .o2 repeat(s) of a (regionId, uid) differ in objId/position; first kept`)
    const objIds = [...new Set(collected.unique.map(r => r.objId))].sort((a, b) => a - b)
    uniqueObjectIds = objIds.length
    const resolved = new Map<number, ReturnType<typeof resolveObject>>()
    const jobs = new Map<string, ModelJob & { index: number }>()
    for (const id of objIds) {
      const r = resolveObject(id, ifo, data, warnings)
      resolved.set(id, r)
      for (const res of r?.resources ?? []) {
        const key = normKey(res)
        if (!jobs.has(key)) jobs.set(key, { source: res, stem: outputStem(res), index: jobs.size })
      }
    }
    log(`objects: ${collected.records} records -> ${collected.unique.length} placements, ${objIds.length} object ids, ${jobs.size} unique models`)
    let done = 0
    for (const job of jobs.values()) {
      if (opts.maxModels !== undefined && done >= opts.maxModels) {
        const error = 'skipped (maxModels)'
        models.push({ index: job.index, source: job.source, glb: null, sidecar: null, kind: 'failed', animations: [], defaultClip: null,
          lightmappedMeshes: 0, boundsMin: [0, 0, 0], boundsMax: [0, 0, 0], bytes: 0, validatorErrors: null, error })
        continue
      }
      const conv = await convertModel(job.index, job, data, outDir, objectLightmaps, opts.validate !== false)
      done++
      models.push(conv.model)
      if (conv.model.kind === 'failed') {
        failedModels.push({ source: job.source, error: conv.model.error! })
        warnings.push(`model ${job.source}: ${conv.model.error}`)
        log(`  FAILED ${job.source}: ${conv.model.error}`)
      } else {
        sizes.models = (sizes.models ?? 0) + conv.model.bytes
        sizes.sidecars = (sizes.sidecars ?? 0) + statSync(join(outDir, ...conv.model.sidecar!.split('/'))).size
        validatorErrors += conv.model.validatorErrors ?? 0
        if (conv.model.validatorErrors) warnings.push(`model ${job.source}: ${conv.model.validatorErrors} glTF validator error(s)`)
      }
      if (done % 25 === 0) log(`  models ${done}/${jobs.size}`)
    }
    models.sort((a, b) => a.index - b.index)
    for (const [key, uri] of objectLightmaps) {
      try {
        const r = ddjToPng(data.read(key), outDir, uri)
        sizes['lightmaps.objects'] = (sizes['lightmaps.objects'] ?? 0) + r.bytes
      } catch (e) {
        warnings.push(`object lightmap ${key}: ${(e as Error).message}`)
      }
    }
    // DRAGON-INT: the remastered models, appended as variants of their retail models (before the pre-pass cache)
    if (opts.remasterModels) {
      const file = isAbsolute(opts.remasterModels) ? opts.remasterModels : resolve(REPO_ROOT, opts.remasterModels)
      const r = await applyRemasterModels(models, parseRemasterModels(readFileSync(file, 'utf8')), {
        outDir, root: REPO_ROOT, lightmapUris: new Set(objectLightmaps.values()), validate: opts.validate !== false, warnings, log,
      })
      models = r.models
      remasterReport = r.report
      sizes.models = (sizes.models ?? 0) + r.bytes.models
      sizes.sidecars = (sizes.sidecars ?? 0) + r.bytes.sidecars
      if (r.bytes.lightmaps) sizes['lightmaps.objects'] = (sizes['lightmaps.objects'] ?? 0) + r.bytes.lightmaps
      validatorErrors += r.validatorErrors
    }
    const converted = new Set(regions.map(r => r.id))
    for (const rec of collected.unique) {
      const r = resolved.get(rec.objId)
      if (!r) continue
      const indices = r.resources.map(res => jobs.get(normKey(res))!.index)
      if (r.compound) compoundPlacements++
      placements.push(toPlacement(rec, origin, r.source, r.compound, indices, converted))
    }
  }
  timeMs.objects = performance.now() - t

  // --- town content (wave 11): validated, copied in; the dressing feeds the passes and ambient.json -------------------
  const townContent = opts.town ? loadTownContent(opts.town, opts.name, warnings, log) : null
  let town: WorldManifest['town']
  if (townContent) {
    // the client loads the files by name: a file left from an earlier run must not outlive its source
    if (!townContent.town) rmSync(join(outDir, TOWN_FILE), { force: true })
    if (!townContent.dressing) rmSync(join(outDir, TOWN_DRESSING_FILE), { force: true })
  }
  if (townContent && (townContent.town || townContent.dressing)) {
    if (townContent.town) write(TOWN_FILE, townContent.town.text, 'town')
    if (townContent.dressing) write(TOWN_DRESSING_FILE, townContent.dressing.text, 'town')
    town = { file: townContent.town ? TOWN_FILE : null, dressing: townContent.dressing ? TOWN_DRESSING_FILE : null }
  }
  const dressingFile = townContent?.dressing?.file ?? null

  // --- the pre-pass placement cache (./edits-hook.ts; WE-I's incremental convert re-runs the passes on it) -----------
  const withObjects = opts.objects !== false
  if (opts.prePassCache && withObjects) {
    mkdirSync(dirname(opts.prePassCache), { recursive: true })
    writeFileSync(opts.prePassCache, encodePrePassCache({ name: opts.name, origin, tiles, models, placements }))
    // a full convert ends the incremental record ("the regions touched since the last full convert", beside the cache;
    // ../tools/convert-region.ts): the same pre-pass bytes must not carry the earlier Publishes' regions on (H12-INC-3)
    rmSync(join(dirname(opts.prePassCache), 'incremental.json'), { force: true })
    log(`pre-pass cache: ${placements.length} placement(s), ${models.length} model(s) -> ${opts.prePassCache}`)
  }

  // --- placement passes (./passes.ts): coast C9 -> town dressing -> cloth -> static variants -> grass palettes ---------
  // -> world edits -> tree swap
  const treesFile = opts.trees ? (isAbsolute(opts.trees) ? opts.trees : resolve(REPO_ROOT, opts.trees)) : null
  const passed = await runWorldPasses({ outDir, origin, regions, tiles, models, placements, warnings, log }, {
    coast: coastPass,
    townDressing: opts.passes?.townDressing !== undefined ? opts.passes.townDressing : dressingFile && withObjects ? createTownDressingPass(dressingFile) : null,
    cloth: opts.passes?.cloth !== undefined ? opts.passes.cloth : opts.town && withObjects ? createClothPass() : null,
    staticVariants: opts.passes?.staticVariants !== undefined ? opts.passes.staticVariants : withObjects ? staticVariantPass : null,
    grass: opts.passes?.grass !== undefined ? opts.passes.grass : grassPalettePass,
    worldEdits: opts.passes?.worldEdits !== undefined ? opts.passes.worldEdits : editsRun?.pass ?? null,
    treeSwap: opts.passes?.treeSwap !== undefined
      ? opts.passes.treeSwap
      : treesFile && withObjects ? createTreeSwapPass({ swapFile: treesFile, world: opts.name, outDir, warnings, log }) : null,
  })
  placements = passed.placements
  models = passed.models
  tiles = passed.tiles
  if (coastPass) compoundPlacements = placements.filter(p => p.compound).length
  const scene: WorldEditsScene = { outDir, origin, placements, models }

  // the nav step (before the passes) and the edits pass agree on every edited footprint (docs/WORLD_EDITOR.md §3.6)
  let footprintProblems: number | undefined
  if (passed.editsReport && navData) {
    const problems = editedFootprintProblems(navData, passed.editsReport.placements, placements, origin)
    footprintProblems = problems.length
    for (const line of problems) warnings.push(line)
    if (problems.length) log(`world edits: ${problems.length} edited footprint(s) disagree with the nav`)
  }

  // --- ambient.json (./ambient.ts): the models' BSR ambient particles by final index + the dressing's lamps -----------
  let townReport = passed.townReport
  if (withObjects) {
    const particleArchive = (() => {
      try {
        return openArchive('Particles', opts.cfg)
      } catch (e) {
        warnings.push(`ambient: Particles.pk2 unavailable (${(e as Error).message}); effects are not checked`)
        return null
      }
    })()
    const particlesOf = (m: WorldModel): ModelParticle[] | null => {
      if (!/\.bsr$/i.test(m.source)) return null
      const path = m.source.replace(/\\/g, '/')
      if (!data.has(path)) return null
      try {
        const r = modelParticles(parseBsr(data.read(path)), particleArchive ? k => !!particleArchive.get(k) : undefined)
        return r.particles
      } catch (e) {
        warnings.push(`ambient: ${m.source}: ${(e as Error).message}`)
        return null
      }
    }
    const amb = buildAmbientIndex(models, particlesOf, dressingFile?.lamps ?? [], warnings)
    // the world edits' free light points (docs/WORLD_EDITOR.md §3.3, S-NL): only when there are some
    const points = editsRun?.ambientPoints?.(scene) ?? []
    write(AMBIENT_FILE, JSON.stringify(points.length ? { ...amb.index, points } : amb.index, null, 1) + '\n', 'ambient')
    if (points.length) log(`ambient: ${points.length} light point(s) from the world edits`)
    log(`ambient: ${amb.retailRows} retail row(s) on ${Object.keys(amb.index.models).length} model(s); ${amb.lampRows} town lamp row(s) on ${amb.lampModels} model(s)`)
    if (dressingFile) townReport = { ...(townReport ?? { placements: { dropped: [], resnapped: [], added: [] }, models: 0, clothModels: 0 }), lampRows: amb.lampRows }
  }

  // --- minimap over C9's drops, then the world map (W10R DD-1) --------------------------------------------------------
  // The retail minimap pixels have every object baked in: where C9 dropped one, the tile draws our render instead
  // (./coast/minimap.ts `dropped`), and the world map stitches the redrawn tiles.
  const dropped = coast?.dropFootprints() ?? []
  if (coast && minimapOpts && dropped.length) {
    minimapOpts = coastMinimapOptions(coast.config, { dropped })
    let redrawn = 0
    for (const r of regions) {
      const key = (r.z << 8) | r.x
      if (!r.minimap || coastTiles.get(key)?.kind === 'synthetic' || !droppedTouches(dropped, r.x, r.z)) continue
      const retailImg = retailMinimap(r.x, r.z)
      const tileImg = retailImg && coastMinimapTile(coast.result, coast.retail.heights, r.x, r.z, retailImg, minimapOpts)
      if (!tileImg || tileImg.kind === 'retail') continue
      const file = join(outDir, ...r.minimap.split('/'))
      sizes.minimap = (sizes.minimap ?? 0) - statSync(file).size
      pngOut(r.minimap, tileImg.width, tileImg.height, tileImg.rgba, 'minimap')
      coastTiles.set(key, tileImg)
      redrawn++
    }
    log(`coast: minimap redrawn over ${dropped.length} dropped placement(s) in ${redrawn} region(s)`)
  }
  // --- the world edits after the passes: touched lightmaps (object shadows) and minimaps, per-region extras -----------
  if (editsRun) {
    let lightmaps = 0
    let minimaps = 0
    for (const r of regions) {
      if (!touched.has(r.id)) continue
      // a region the pass added to `touched` (a placement edit's reach from its models, H12-GH-1) was not kept at the
      // terrain step: its written lightmap is read back
      const lm = editLightmaps.get(r.id) ?? (r.lightmap ? readWrittenLightmap(join(outDir, ...r.lightmap.file.split('/')), warnings) : null)
      const baked = lm && r.lightmap ? editsRun.lightmap?.(r, lm, scene) : null
      if (baked && r.lightmap) {
        const file = join(outDir, ...r.lightmap.file.split('/'))
        sizes['lightmaps.terrain'] = (sizes['lightmaps.terrain'] ?? 0) - statSync(file).size
        pngOut(r.lightmap.file, baked.width, baked.height, baked.rgba, 'lightmaps.terrain')
        r.lightmap = { file: r.lightmap.file, width: baked.width, height: baked.height }
        lightmaps++
      }
      if (editsRun.minimap) {
        const current = coastTiles.get(r.id) ?? (r.synthetic ? null : retailMinimap(r.x, r.z))
        const drawn = editsRun.minimap(r, current, scene)
        if (drawn) {
          const rel = r.minimap ?? `minimap/${r.x}x${r.z}.png`
          if (r.minimap) sizes.minimap = (sizes.minimap ?? 0) - statSync(join(outDir, ...rel.split('/'))).size
          pngOut(rel, drawn.width, drawn.height, drawn.rgba, 'minimap')
          r.minimap = rel
          editTiles.set(r.id, drawn)
          minimaps++
        }
      }
    }
    let extras = 0
    if (editsRun.regionExtras) {
      for (const r of regions) {
        const e = editsRun.regionExtras(r, scene)
        if (!e) continue
        if (e.grassMask !== undefined) r.grassMask = e.grassMask
        if (e.lightPoints !== undefined) r.lightPoints = e.lightPoints
        extras++
      }
    }
    log(`world edits: ${touched.size} touched region(s); ${lightmaps} lightmap(s) re-baked, ${minimaps} minimap tile(s) redrawn, ${extras} region(s) with extras`)
  }
  if (finishStream) {
    t = performance.now()
    stream = finishStream()
    timeMs.stream += performance.now() - t
  }

  // --- manifest -----------------------------------------------------------------------------------------------------
  timeMs.total = performance.now() - t0
  const manifest: WorldManifest = {
    format: WORLD_MANIFEST_FORMAT,
    version: WORLD_MANIFEST_VERSION,
    name: opts.name,
    generator: GENERATOR,
    createdAt: new Date().toISOString(),
    space: {
      units: 'metre',
      metresPerUnit: UNIT_SCALE,
      handedness: 'right-handed, +Y up (glTF)',
      axes: { east: toGltfDirection([1, 0, 0]), north: toGltfDirection([0, 0, 1]), up: toGltfDirection([0, 1, 0]) },
      originRegion: { x: origin.x, z: origin.z, id: (origin.z << 8) | origin.x },
      originCorner: 'south-west',
      regionSizeM: REGION_UNITS * UNIT_SCALE,
      cellSizeM: 20 * UNIT_SCALE,
      regionOffsetRule:
        'region (x, z) origin = space.ts toGltfPosition([1920 (x - originRegion.x), 0, 1920 (z - originRegion.z)]) ' +
        '= [192 (x - ox), 0, -192 (z - oz)] m; this is the glTF position of the region\'s south-west corner ' +
        '(file-space region-local (0, 0, 0)); the region covers glTF x in [origin.x, origin.x + 192] and z in [origin.z - 192, origin.z]',
      localToWorldRule:
        'region-local file units (lx, h, lz) -> glTF [origin.x + 0.1 lx, 0.1 h, origin.z - 0.1 lz] (space.ts: 0.1 (x, y, -z)); ' +
        'terrain vertex (gx, gz) -> [origin.x + 2 gx, heightM, origin.z - 2 gz]; object placements are already in this frame',
    },
    regions,
    tiles,
    water: { frames, frameMs: 100, ice, waves },
    environment: { file: 'environment.json', profileIds: profiles.map(p => p.id) },
    models,
    placements,
    ...(nav ? { nav } : {}),
    ...(spawn ? { spawn } : {}),
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    ...(bounds ? { bounds } : {}),
    ...(stream ? { stream } : {}),
    ...(places ? { places } : {}),
    ...(passed.coast ? { coast: passed.coast } : {}),
    ...(town ? { town } : {}),
    warnings,
    report: {
      regions: regions.length,
      regionsSkipped,
      placementRecords,
      placements: placements.length,
      dedupeConflicts,
      uniqueObjectIds,
      compoundPlacements,
      uniqueModels: models.length,
      modelsConverted: models.filter(m => m.kind !== 'failed').length,
      failedModels,
      lightmapTextures: objectLightmaps.size,
      tileTextures: tiles.length,
      validatorErrors,
      sizes: { totalBytes: 0, byCategory: sizes },
      timeMs,
      ...(passed.coastReport ? { coast: passed.coastReport } : {}),
      ...(townReport ? { town: townReport } : {}),
      ...(passed.editsReport
        ? { edits: { ...(editsRun?.report?.() ?? {}), ...passed.editsReport, ...(footprintProblems !== undefined ? { footprintProblems } : {}) } }
        : {}),
      ...(passed.treesReport ? { trees: passed.treesReport } : {}),
      ...(remasterReport ? { remasterModels: remasterReport } : {}),
    },
  }
  const manifestFile = join(outDir, 'manifest.json')
  // The manifest's own size is part of the total: write once to measure, then with the final numbers.
  const measure = () => {
    manifest.report.sizes.totalBytes = Object.values(sizes).reduce((s, n) => s + n, 0)
    return JSON.stringify(manifest, null, 1) + '\n'
  }
  for (const k of Object.keys(timeMs) as Array<keyof typeof timeMs>) timeMs[k] = Math.round(timeMs[k])
  sizes.manifest = Buffer.byteLength(measure())
  sizes.manifest = Buffer.byteLength(measure())
  writeFileSync(manifestFile, measure())
  log(formatReport(manifest))
  return { manifest, manifestFile }
}

export function formatReport(m: WorldManifest): string {
  const r = m.report
  const lines = [
    `world "${m.name}": ${r.regions} region(s)${r.regionsSkipped.length ? ` (skipped: ${r.regionsSkipped.join('; ')})` : ''}, origin = SW corner of ${m.space.originRegion.x},${m.space.originRegion.z}`,
    `  placements: ${r.placementRecords} .o2 records -> ${r.placements} after (regionId, uid) dedupe (${r.dedupeConflicts} conflicts), ${r.uniqueObjectIds} object ids, ${r.compoundPlacements} compound placements`,
    `  models: ${r.uniqueModels} unique, ${r.modelsConverted} converted, ${r.failedModels.length} failed, validator errors ${r.validatorErrors}; ` +
      `${m.models.filter(x => x.kind === 'skinned').length} skinned, ${m.models.filter(x => x.lightmappedMeshes > 0).length} lightmapped (${r.lightmapTextures} lightmap textures)`,
    ...r.failedModels.map(f => `    FAILED ${f.source}: ${f.error}`),
    m.nav
      ? `  nav: ${m.nav.file} ${mb(m.nav.bytes)} MiB, ${m.nav.regions.length} region(s), ${m.nav.instances} object navmesh instances ` +
        `(${m.nav.neighbourInstances} neighbour-owned, ${m.nav.compoundInstances} compounds), ${m.nav.models} models, ${m.nav.links} links`
      : '  nav: none',
    m.spawn ? `  spawn: (${m.spawn.x}, ${m.spawn.y}, ${m.spawn.z}) yaw ${m.spawn.yaw}: ${m.spawn.source}` : '  spawn: none',
    ...(m.bounds ? [`  bounds: x ${m.bounds.minX}..${m.bounds.maxX}, z ${m.bounds.minZ}..${m.bounds.maxZ} m`] : []),
    ...(m.stream
      ? [`  stream: playable ${m.stream.playable.x0}-${m.stream.playable.x1} x ${m.stream.playable.z0}-${m.stream.playable.z1}; ` +
        `${m.stream.navRegions.dir}/ ${mb(m.stream.navRegions.bytes)} MiB, ${m.stream.navObjects.file} ${mb(m.stream.navObjects.bytes)} MiB; ` +
        `${m.stream.worldMap ? `${m.stream.worldMap.file} ${m.stream.worldMap.width} x ${m.stream.worldMap.height}` : 'no world map'}; ` +
        `radii ${m.stream.loadRadiusM}/${m.stream.unloadRadiusM} m`]
      : []),
    ...(m.places ? [`  places: ${m.places.length}`] : []),
    `  tiles: ${r.tileTextures}; water frames: ${m.water.frames.length}; environment profiles: ${m.environment.profileIds.join(', ')}`,
    `  size: ${mb(r.sizes.totalBytes)} MiB (${Object.entries(r.sizes.byCategory).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${mb(n)}`).join(', ')})`,
    `  time: ${(r.timeMs.total / 1000).toFixed(1)} s (terrain ${(r.timeMs.terrain / 1000).toFixed(1)}, navmesh ${(r.timeMs.navmesh / 1000).toFixed(1)}, nav ${((r.timeMs.nav ?? 0) / 1000).toFixed(1)}, textures ${(r.timeMs.textures / 1000).toFixed(1)}, objects ${(r.timeMs.objects / 1000).toFixed(1)}` +
      `${r.timeMs.stream !== undefined ? `, stream ${(r.timeMs.stream / 1000).toFixed(1)}` : ''})`,
    `  warnings: ${m.warnings.length}`,
  ]
  return lines.join('\n')
}

interface LoadedTownFile<T> {
  file: T
  text: string
}

/**
 * Reads and validates the town content files (WorldPreset.town). A missing file is a log line (the town lanes write
 * them during the wave); an unreadable or invalid one, or one for another world, is a warning and is not copied.
 */
export function loadTownContent(
  cfg: WorldTownConfig, worldName: string, warnings: string[], log: (line: string) => void,
): { town: LoadedTownFile<TownFile> | null; dressing: LoadedTownFile<TownDressingFile> | null } {
  const load = <K extends 'town' | 'townDressing'>(rel: string | undefined, kind: K) => {
    if (!rel) return null
    const file = isAbsolute(rel) ? rel : resolve(REPO_ROOT, rel)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      log(`town: ${rel} not found; not part of the export`)
      return null
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (e) {
      warnings.push(`town: ${rel}: ${(e as Error).message}; not copied`)
      return null
    }
    const res = validateTownFile(json)
    if (!res.ok) {
      warnings.push(`town: ${rel}: ${res.problems.length} problem(s), e.g. ${res.problems.slice(0, 3).join('; ')}; not copied`)
      return null
    }
    if (res.file.kind !== kind) {
      warnings.push(`town: ${rel}: kind '${res.file.kind}', expected '${kind}'; not copied`)
      return null
    }
    if (res.file.world !== worldName) warnings.push(`town: ${rel} is for world '${res.file.world}', copied into '${worldName}'`)
    log(`town: ${rel} (${kind}) valid`)
    return { file: res.file, text }
  }
  return {
    town: load(cfg.file, 'town') as LoadedTownFile<TownFile> | null,
    dressing: load(cfg.dressing, 'townDressing') as LoadedTownFile<TownDressingFile> | null,
  }
}

/** Bounding rectangle (region units) of a region list. */
export function rectOf(list: ReadonlyArray<RegionCoord>): RegionRect {
  return {
    x0: Math.min(...list.map(r => r.x)), x1: Math.max(...list.map(r => r.x)),
    z0: Math.min(...list.map(r => r.z)), z1: Math.max(...list.map(r => r.z)),
  }
}

/** glTF metres of a region rectangle (inclusive) relative to the origin region's south-west corner. */
export function rectBounds(rect: RegionRect, origin: RegionCoord): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const size = REGION_UNITS * UNIT_SCALE
  const z = (v: number) => -size * (v - origin.z) + 0
  return { minX: size * (rect.x0 - origin.x) + 0, maxX: size * (rect.x1 + 1 - origin.x) + 0, minZ: z(rect.z1 + 1), maxZ: z(rect.z0) }
}

/** A lightmap PNG the terrain step wrote (the edits' after-pass hook re-bakes from it), or null. */
function readWrittenLightmap(file: string, warnings: string[]): EditsImage | null {
  try {
    const img = decodePng(new Uint8Array(readFileSync(file)))
    return { width: img.width, height: img.height, rgba: img.rgba }
  } catch (e) {
    warnings.push(`world edits: ${file}: ${(e as Error).message}`)
    return null
  }
}
