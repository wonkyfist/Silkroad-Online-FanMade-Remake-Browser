/**
 * Grass and plant scatter (docs/WAVE_PLAN.md §6 W5-G): visual-only ground cover on the terrain, placed from the terrain
 * tiles, drawn as thin instances with a wind-swaying, distance-fading shader (scatter-assets.ts).
 *
 * Placement (pure, deterministic: scatterChunk):
 *   - a region is split into 3 x 3 chunks of 64 m; each chunk is seeded from (region id, chunk index), so the same
 *     chunk always grows the same plants, whichever order regions stream in;
 *   - candidates on a jittered 1 m grid; a candidate survives with probability density(cell) x fraction(level);
 *   - density(cell) comes from the terrain texture words at the cell's four corners (tile2d id = word & 0x3ff) through
 *     the density table by tile type (TILE_TYPE_DENSITY: Grass, LongGrass, Forest dense; Dirt, Sand, Mud sparse;
 *     Stone, Water, roads none), with pavement/rock/water tile names forced to none (the Jangan town marble is typed
 *     Dirt); a cell with ANY bare corner is bare, which keeps a clear margin along plazas, walls and shores, and a
 *     cell of only plain dirt / sand / mud (roads, farm plots) is bare too, so the sparse types only fringe the grass;
 *   - steep cells (terrain normal y < 0.72), points under a water/ice plane and points covered by an object floor
 *     (a nav object surface at or above the ground: the town plaza, bridges, houses) get nothing.
 * Rendering (WorldScatter): regions register as they commit (RegionStreamer, from the commit job that makes a region
 * ready; or every region after the whole-world load) and unregister in the region's unload job; chunks are
 * generated lazily in World.update, nearest first, at most one per frame, once they come within the
 * level's view distance, and dropped again beyond it (plus hysteresis); a region's chunks and materials go with the
 * region. One mesh per (chunk, kind) with its own geometry (thin-instance buffers live on the geometry) and a
 * hand-set bounding box so Babylon frustum-culls it. Levels (QualitySettings.scatter): off / low / medium / high set
 * the density fraction and view distance; a level change drops every chunk and they regrow around the camera.
 *
 * N100 budget (≤ 1.5 ms/frame at medium): 64 m chunks, so about 6-9 chunks within the 60 m view and half of them in
 * the frustum, x up to 5 kinds (low: 2) = 15-25 draw calls; ~2-4 k plants of 12-200 vertices (flowers are the heavy
 * ones and are rare), alpha-tested, shrunk to nothing past the fade so far plants cost no pixels; generating a chunk
 * takes ~0.3-0.5 ms (1 m grid, the nav object test per surviving candidate) and happens at most once per frame.
 *
 * W10-S (docs/GRASS_LIFE.md §8.1, GL-0): WorldScatter stays the facade of two ground-cover styles. 'retail' is all of
 * the above (Low, and the viewer A/B), exactly as before; 'field' hands the regions, the level and the frame to
 * GRASS_LIFE's own grass (a GroundCover, GL-F) while the shared uniforms, defines and depth textures stay here and
 * reach its materials through `adopt`. GL-F owns this file afterwards.
 *
 * GL-F (docs/GRASS_LIFE.md §3): the default 'field' is grass/field.ts GrassField (grass/index.ts createGrassField).
 */
import {
  BoundingInfo,
  Mesh,
  ShaderLanguage,
  ShaderMaterial,
  ShaderStore,
  Vector3,
  Vector4,
  VertexData,
  type BaseTexture,
  type RenderTargetTexture,
  type Scene,
} from '@babylonjs/core'
import { GRID } from '../../convert/src/world/format.ts'
import type { TileTexture, WorldModel, WorldRegion } from '../../convert/src/world/manifest.ts'
import type { Assets } from './assets.ts'
import { createGrassField } from './grass/index.ts'
import type { RegionData } from './regions.ts'
import { GRASS_SHADOW_SAMPLER, RenderGrass, type GrassRenderSource } from './render/grass-chunks.ts'
import {
  SCATTER_CHUNK_SAMPLERS,
  SCATTER_KINDS,
  SCATTER_SAMPLERS,
  SCATTER_UNIFORMS,
  loadScatterKinds,
  mulberry32,
  scatterFragmentGLSL,
  scatterFragmentWGSL,
  scatterVertexGLSL,
  scatterVertexWGSL,
  type ScatterKindAsset,
} from './scatter-assets.ts'
import { DefineSet, SharedUniforms, bindAllShared, bindShared } from './shader-chunks.ts'
import { solidTexture } from './textures.ts'

export type ScatterLevel = 'off' | 'low' | 'medium' | 'high'
export const SCATTER_LEVELS: readonly ScatterLevel[] = ['off', 'low', 'medium', 'high']

export interface ScatterPreset {
  /** Share of the full density kept (0..1). */
  fraction: number
  /** Plants are fully gone at this 2D distance from the camera (m); chunks generate within it. */
  viewM: number
  /** Fade band before viewM (m). */
  fadeM: number
}

export const SCATTER_PRESETS: Record<ScatterLevel, ScatterPreset> = {
  off: { fraction: 0, viewM: 0, fadeM: 0 },
  low: { fraction: 0.35, viewM: 40, fadeM: 10 },
  medium: { fraction: 0.6, viewM: 60, fadeM: 14 },
  high: { fraction: 1, viewM: 90, fadeM: 20 },
}

/** Plant density (0..1 of the full 1 per m² grid) by tile2d type name (formats/tile2d.ts TILE2D_TYPES). */
export const TILE_TYPE_DENSITY: Readonly<Record<string, number>> = {
  Grass: 0.85,
  LongGrass: 1,
  Forest: 0.95,
  Dirt: 0.07,
  Sand: 0.03,
  Mud: 0.1,
  Ashfield: 0.03,
  Stone: 0,
  Metal: 0,
  Wood: 0,
  Water: 0,
  DeepWater: 0,
  Snow: 0,
  Cloud: 0,
}

/** Tile file names drawn as pavement, rock or water whatever their type (c_marble_jang_08_1 is typed Dirt). */
const BARE_NAME = /marble|stone|rock|road|brick|pave|salt|water|ruin|dest/i
/** Grassy dirt (wc_grass02_01, oaho_grass_05...): between Dirt and Grass. */
const GRASSY_DIRT = 0.35

/** Density of one terrain tile (its type, overridden by its file name). */
export function tileScatterDensity(tile: Pick<TileTexture, 'typeName' | 'source'> & { file?: string }): number {
  const name = `${tile.source ?? ''} ${tile.file ?? ''}`
  if (BARE_NAME.test(name)) return 0
  const base = tile.typeName ? TILE_TYPE_DENSITY[tile.typeName] ?? 0 : 0
  if (base > 0 && base < GRASSY_DIRT && /grass|weed/i.test(name)) return GRASSY_DIRT
  return base
}

/** tile2d id -> density for a manifest's tiles (ids not listed are bare). */
export function tileDensityTable(tiles: readonly TileTexture[]): Map<number, number> {
  const map = new Map<number, number>()
  for (const t of tiles) map.set(t.id, tileScatterDensity(t))
  return map
}

// ---- placement ------------------------------------------------------------------------------------------------

/** Chunks per region side; chunk size 192 / 3 = 64 m (big chunks: few draw calls). */
export const CHUNKS_PER_SIDE = 3
export const CHUNKS_PER_REGION = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE
export const CHUNK_M = 192 / CHUNKS_PER_SIDE
/** Candidate grid spacing (m). */
export const SPACING_M = 1
const CELLS_PER_CHUNK = CHUNK_M / 2
/** Minimum terrain normal y for plants (about 44°). */
const SLOPE_MIN_Y = 0.72
/** Cells whose density is at least this are "lush" (flowers and bushes grow there). */
const LUSH = 0.5
/** A cell whose corners are all below this (plain Dirt / Sand / Mud) stays bare: sparse types only fringe grass. */
const FRINGE_MIN = 0.2
/** Levels with at least this fraction grow bushes and flowers too. */
const RICH_FRACTION = 0.5
/** Floats per placed plant: x, y, z (glTF m), yaw (rad), height (m; the renderer scales each model to it). */
export const PLANT_STRIDE = 5

/** The terrain of one region as the placement reads it (RegionData or a test fixture). */
export interface ScatterSource {
  id: number
  /** WorldRegion.origin: glTF (x, y, z) of the south-west corner. */
  origin: readonly [number, number, number]
  /** 97 x 97 terrain heights (m), index gz * 97 + gx. */
  heights: ArrayLike<number>
  /** 97 x 97 x 4 normals x 127 (x, y, z, 0), or null / all zero for none. */
  normals: ArrayLike<number> | null
  /** 97 x 97 raw texture words. */
  textures: ArrayLike<number>
  /** 36 blocks (bz * 6 + bx) with their water planes. */
  blocks: WorldRegion['blocks']
}

export function scatterSource(data: RegionData): ScatterSource {
  const t = data.terrain
  return { id: data.region.id, origin: data.region.origin, heights: t.heights, normals: t.normals, textures: t.textures, blocks: data.region.blocks }
}

export interface ScatterChunkData {
  region: number
  chunk: number
  /** Plants per kind (SCATTER_KINDS order), PLANT_STRIDE floats each. */
  plants: Float32Array[]
  count: number
  /** glTF rectangle of the chunk and the height range of its plants' roots. */
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  minY: number
  maxY: number
}

/** Stable 32-bit seed of (region id, chunk). */
export function chunkSeed(region: number, chunk: number): number {
  let h = (Math.imul(region | 0, 0x9e3779b1) ^ Math.imul(chunk + 1, 0x85ebca77)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * Kind index for a roll in [0, 1): grass and weeds everywhere; bushes and flowers too on lush cells when `rich` (from
 * the medium level up, so the low level draws two kinds, i.e. half the draw calls).
 */
export function pickKind(roll: number, lush: boolean, rich = true): number {
  if (!lush || !rich) return roll < 0.8 ? 0 : 1
  if (roll < 0.78) return 0
  if (roll < 0.86) return 1
  if (roll < 0.91) return 2
  if (roll < 0.96) return 3
  return 4
}

/**
 * Plants of one chunk (0..8, index cz * 3 + cx, cx east, cz north) of a region. Deterministic in (source, chunk,
 * densityOf, fraction, occupied). `occupied(x, z, y)` tells whether an object floor covers the ground point. Bushes and
 * flowers grow from fraction RICH_FRACTION up.
 */
export function scatterChunk(
  src: ScatterSource,
  chunk: number,
  densityOf: (tileId: number) => number,
  fraction: number,
  occupied?: (x: number, z: number, groundY: number) => boolean,
): ScatterChunkData {
  const kinds = SCATTER_KINDS.length
  const lists: number[][] = Array.from({ length: kinds }, () => [])
  const rich = fraction >= RICH_FRACTION
  const cx = chunk % CHUNKS_PER_SIDE
  const cz = Math.floor(chunk / CHUNKS_PER_SIDE)
  const [ox, , oz] = src.origin
  const out: ScatterChunkData = {
    region: src.id, chunk, plants: [], count: 0,
    minX: ox + cx * CHUNK_M, maxX: ox + (cx + 1) * CHUNK_M, minZ: oz - (cz + 1) * CHUNK_M, maxZ: oz - cz * CHUNK_M,
    minY: Infinity, maxY: -Infinity,
  }
  if (fraction > 0) {
    // Per cell (2 m) of this chunk: density (0 = bare) after the bare-corner, slope rules.
    const cell = new Float32Array(CELLS_PER_CHUNK * CELLS_PER_CHUNK)
    const gx0 = cx * CELLS_PER_CHUNK
    const gz0 = cz * CELLS_PER_CHUNK
    const tex = src.textures
    const nrm = src.normals
    const vertexDensity = (gx: number, gz: number) => densityOf(tex[gz * GRID + gx]! & 0x3ff)
    const normalY = (gx: number, gz: number): number => {
      if (!nrm) return 1
      const o = (gz * GRID + gx) * 4
      const x = nrm[o]!, y = nrm[o + 1]!, z = nrm[o + 2]!
      const l = Math.hypot(x, y, z)
      return l > 0 ? y / l : 1
    }
    for (let j = 0; j < CELLS_PER_CHUNK; j++) {
      for (let i = 0; i < CELLS_PER_CHUNK; i++) {
        const gx = gx0 + i
        const gz = gz0 + j
        const a = vertexDensity(gx, gz), b = vertexDensity(gx + 1, gz), c = vertexDensity(gx, gz + 1), d = vertexDensity(gx + 1, gz + 1)
        if (!(a > 0 && b > 0 && c > 0 && d > 0)) continue
        // Plain dirt, sand and mud (roads, farm plots) only grow plants as a fringe next to grass.
        if (Math.max(a, b, c, d) < FRINGE_MIN) continue
        if (Math.min(normalY(gx, gz), normalY(gx + 1, gz), normalY(gx, gz + 1), normalY(gx + 1, gz + 1)) < SLOPE_MIN_Y) continue
        cell[j * CELLS_PER_CHUNK + i] = (a + b + c + d) / 4
      }
    }
    const rnd = mulberry32(chunkSeed(src.id, chunk))
    const n = CHUNK_M / SPACING_M
    const h = src.heights
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        // Always six draws per candidate: one candidate's rejection never shifts another's numbers.
        const jx = rnd(), jz = rnd(), keep = rnd(), kindRoll = rnd(), yawRoll = rnd(), scaleRoll = rnd()
        const lxM = cx * CHUNK_M + (i + jx) * SPACING_M // region-local metres, east
        const lzM = cz * CHUNK_M + (j + jz) * SPACING_M // north
        const ci = Math.min(CELLS_PER_CHUNK - 1, Math.floor((lxM - cx * CHUNK_M) / 2))
        const cj = Math.min(CELLS_PER_CHUNK - 1, Math.floor((lzM - cz * CHUNK_M) / 2))
        const dens = cell[cj * CELLS_PER_CHUNK + ci]!
        if (dens <= 0 || keep >= dens * fraction) continue
        const y = heightAt(h, lxM * 10, lzM * 10)
        const block = src.blocks[Math.min(5, Math.floor(lzM / 32)) * 6 + Math.min(5, Math.floor(lxM / 32))]
        if (block?.water && y < block.water.heightM + 0.05) continue
        const x = ox + lxM
        const z = oz - lzM
        if (occupied?.(x, z, y)) continue
        const k = pickKind(kindRoll, dens >= LUSH, rich)
        const def = SCATTER_KINDS[k]!
        const s = def.heightM[0] + (def.heightM[1] - def.heightM[0]) * scaleRoll
        lists[k]!.push(x, y, z, yawRoll * Math.PI * 2, s)
        out.count++
        if (y < out.minY) out.minY = y
        if (y > out.maxY) out.maxY = y
      }
    }
  }
  out.plants = lists.map(l => new Float32Array(l))
  if (!out.count) out.minY = out.maxY = 0
  return out
}

/** Terrain height at region-local file units (the rendered triangulation, format.ts terrainHeightAt). */
function heightAt(heights: ArrayLike<number>, lx: number, lz: number): number {
  const last = GRID - 1
  const gx = Math.min(Math.max(lx / 20, 0), last)
  const gz = Math.min(Math.max(lz / 20, 0), last)
  const ix = Math.min(Math.floor(gx), last - 1)
  const iz = Math.min(Math.floor(gz), last - 1)
  const fx = gx - ix
  const fz = gz - iz
  const h00 = heights[iz * GRID + ix]!
  const h11 = heights[(iz + 1) * GRID + ix + 1]!
  if (fx >= fz) {
    const h10 = heights[iz * GRID + ix + 1]!
    return h00 + (h10 - h00) * fx + (h11 - h10) * fz
  }
  const h01 = heights[(iz + 1) * GRID + ix]!
  return h00 + (h01 - h00) * fz + (h11 - h01) * fx
}

/**
 * Thin-instance matrices (Babylon row-major: R_y(yaw) x uniform scale, then the root) of PLANT_STRIDE plants, for a
 * model `modelHeightM` tall (each plant is scaled to its own height).
 */
export function plantMatrices(plants: Float32Array, modelHeightM = 1): Float32Array {
  const n = plants.length / PLANT_STRIDE
  const m = new Float32Array(n * 16)
  const inv = 1 / Math.max(0.05, modelHeightM)
  for (let i = 0; i < n; i++) {
    const p = i * PLANT_STRIDE
    const o = i * 16
    const s = plants[p + 4]! * inv
    const c = Math.cos(plants[p + 3]!) * s
    const sn = Math.sin(plants[p + 3]!) * s
    m[o] = c
    m[o + 2] = -sn
    m[o + 5] = s
    m[o + 8] = sn
    m[o + 10] = c
    m[o + 12] = plants[p]!
    m[o + 13] = plants[p + 1]!
    m[o + 14] = plants[p + 2]!
    m[o + 15] = 1
  }
  return m
}

// ---- rendering ----------------------------------------------------------------------------------------------------

/** What the scatter needs from its world (World implements it in world.ts; tests pass their own). */
export interface ScatterHost {
  readonly scene: Scene
  readonly assets: Assets
  readonly manifest: { readonly tiles: readonly TileTexture[]; readonly models: readonly WorldModel[] }
  /** True when an object floor (nav object surface) covers the ground at (x, z). */
  occupied?(x: number, z: number, groundY: number): boolean
  /** The terrain lightmap of a region (null: none, drawn white). */
  lightmapOf?(regionId: number): BaseTexture | null
  /** Terrain fog and shadow parameters (World.terrainParams). */
  terrainParams?(): { lightmap: boolean; fog: boolean; fogStartM: number; fogEndM: number; fogColor: readonly number[]; shadowColor: readonly number[] }
  /** LOOK-GRASS: the coast's sea (World.coast; null until its field loads, or none): the new grass never grows under it. */
  coast?(): { readonly seaLevelM: number; seaAt(x: number, z: number): boolean; sample?(x: number, z: number): { sea: number; distanceM: number } } | null
}

export interface ScatterOptions {
  level?: ScatterLevel
  /** Use the export's retail plant glbs (default true); false: procedural cards only. */
  retail?: boolean
  /** Clock in ms (default performance.now). */
  now?: () => number
  /**
   * W10-S (GRASS_LIFE §8.1): the ground-cover style asked for (default 'retail', HEAD). 'field' is GRASS_LIFE's own
   * grass when a field is available (`field`, or GL-F's default), else it stays 'retail'.
   */
  style?: ScatterStyle
  /** W10-S: makes the 'field' ground cover (default GL-F's DEFAULT_GROUND_COVER; null: none, 'field' stays retail). */
  field?: GroundCoverFactory | null
}

/**
 * W10-S (GRASS_LIFE §8.1, GL-0): the ground cover's style. 'retail' = today's chunks of retail plants (Low, and the
 * "Retail" side of the viewer A/B); 'field' = GRASS_LIFE's lush painterly grass (GL-F's `grass/**`), Medium+.
 */
export type ScatterStyle = 'retail' | 'field'
export const SCATTER_STYLES: readonly ScatterStyle[] = ['retail', 'field']

/**
 * What a ground-cover style does for WorldScatter, which stays the facade (GRASS_LIFE §8.1): every chunk lane keeps
 * binding its uniforms, defines and depth textures on `world.scatter`, and the field takes them through `adopt`.
 * Its meshes carry `metadata.sroWorld = 'scatter'` (never batched), are hidden with `isVisible` at count 0 (never
 * `setEnabled`) and cast no shadow.
 */
export interface GroundCover {
  readonly style: ScatterStyle
  /** A region committed / went (the same calls WorldScatter gets). */
  addRegion(data: RegionData): void
  removeRegion(id: number): boolean
  /** Per frame (World.update through WorldScatter.update): `camera` is the camera position (glTF m), or null. */
  update(camera: { x: number; y: number; z: number } | null): void
  /** The Options "Grass" level (off / low / medium / high). */
  setLevel(level: ScatterLevel): void
  /** Resolves once its art and materials are ready. */
  ready(): Promise<void>
  /** Every mesh it draws. */
  meshes(): Mesh[]
  dispose(): void
}

/** Makes a 'field' ground cover for a WorldScatter (GL-F); null when it cannot (the scatter stays retail). */
export type GroundCoverFactory = (scatter: WorldScatter, host: ScatterHost) => GroundCover | null

/** GL-F's field (grass/field.ts GrassField): what 'field' makes unless ScatterOptions.field says otherwise. */
export const DEFAULT_GROUND_COVER: GroundCoverFactory | null = createGrassField

export interface ScatterStats {
  level: ScatterLevel
  regions: number
  /** Chunks generated (in range). */
  chunks: number
  meshes: number
  plants: number
  /** Generation cost of the last chunk and the worst so far (ms). */
  lastGenMs: number
  worstGenMs: number
  /** 'loading' until the kinds are ready, then the retail or procedural source per kind. */
  art: string
}

/** Generate chunks up to this far beyond the view distance (m); drop them beyond DROP_MARGIN. */
const GEN_MARGIN_M = 12
const DROP_MARGIN_M = 48
/** Wind sway strength (m of bend per m of height). */
const WIND = 0.12
/** Near fade: plants within this 3D distance of the camera shrink away (m). */
const NEAR_FADE_M = 2.5
/** Alpha-test threshold. */
const ALPHA_CUT = 0.5

interface ChunkEntry {
  data: ScatterChunkData
  meshes: Mesh[]
  visible: boolean
}

interface RegionEntry {
  id: number
  src: ScatterSource
  chunks: (ChunkEntry | null)[]
  /** Per kind, created on first use. */
  materials: (ShaderMaterial | null)[]
  region: Vector4
  lightmap: BaseTexture | null
}

let shadersRegistered = false
function registerShaders(): void {
  if (shadersRegistered) return
  shadersRegistered = true
  ShaderStore.ShadersStoreWGSL['sroScatterVertexShader'] = scatterVertexWGSL
  ShaderStore.ShadersStoreWGSL['sroScatterFragmentShader'] = scatterFragmentWGSL
  ShaderStore.ShadersStore['sroScatterVertexShader'] = scatterVertexGLSL
  ShaderStore.ShadersStore['sroScatterFragmentShader'] = scatterFragmentGLSL
}

export class WorldScatter {
  readonly stats: ScatterStats = { level: 'off', regions: 0, chunks: 0, meshes: 0, plants: 0, lastGenMs: 0, worstGenMs: 0, art: 'loading' }
  private levelValue: ScatterLevel
  private readonly regions = new Map<number, RegionEntry>()
  private readonly density: Map<number, number>
  private readonly retail: boolean
  private readonly now: () => number
  private kinds: ScatterKindAsset[] | null = null
  private loading: Promise<void> | null = null
  private white: BaseTexture | null = null
  private disposed = false
  // Shared uniform values: every material holds these objects, so one write per frame reaches them all.
  private readonly uCamera = new Vector4(0, 1e6, 0, 0)
  private readonly uFade = new Vector4(0, 0, WIND, NEAR_FADE_M)
  private readonly uShadow = new Vector4(0, 0, 0, 0)
  private readonly uFog = new Vector4(0, 1, 0, 0)
  private readonly uFogColor = new Vector4(0, 0, 0, 1)
  private lightmapOn = true
  private black: BaseTexture | null = null
  private readonly defines = new DefineSet()
  /**
   * Values every grass material shares with the chunks (weather `wxA`/`wxB`, the SH, the TAA jitter, cloud noise...),
   * bound by reference like uCamera/uFade (shader-chunks.ts SharedUniforms). Wave 9 seam (docs/WAVE_PLAN3.md §4.1).
   */
  readonly sharedUniforms = new SharedUniforms()
  /** RND-W: the renderer's grass feed (follow; null on a world without a renderer, e.g. tests). */
  private grass: RenderGrass | null = null
  /** RND-W: HEAD's linear fog is off (the HDR chunk fogs the grass itself). */
  private ownFog = false
  /** Depth textures bound at bind time by name (the CSM tap's shadow map; never a colour fallback). */
  private readonly depthTextures = new Map<string, () => RenderTargetTexture | null>()
  private readonly depthBound = new WeakSet<ShaderMaterial>()
  /** W10-S: the style asked for, the 'field' ground cover while it draws, and what makes it. */
  private styleWanted: ScatterStyle = 'retail'
  private field: GroundCover | null = null
  private readonly fieldFactory: GroundCoverFactory | null
  /** W10-S: every registered region's data (a field made later takes them all). */
  private readonly regionData = new Map<number, RegionData>()
  /** W10-S: foreign materials that follow the shared uniforms, defines and depth textures (adopt). */
  private readonly adopted = new Set<ShaderMaterial>()

  constructor(private readonly host: ScatterHost, opts: ScatterOptions = {}) {
    this.sharedUniforms.bindTo((name, value) => {
      for (const m of this.allMaterials()) bindShared(m, name, value, this.fallbackFor(name))
    })
    this.levelValue = opts.level ?? 'medium'
    this.stats.level = this.levelValue
    this.retail = opts.retail ?? true
    this.now = opts.now ?? (() => performance.now())
    this.density = tileDensityTable(host.manifest.tiles)
    this.fieldFactory = opts.field === undefined ? DEFAULT_GROUND_COVER : opts.field
    this.applyFade()
    if (opts.style) this.setStyle(opts.style)
  }

  get level(): ScatterLevel {
    return this.levelValue
  }

  /**
   * W10-S: the style that draws: 'field' while GRASS_LIFE's field is up, else 'retail' (HEAD's chunks). A 'field' asked
   * for with no field available stays 'retail'.
   */
  get style(): ScatterStyle {
    return this.field ? 'field' : 'retail'
  }

  /** W10-S: the style asked for (setStyle / ScatterOptions.style). */
  get requestedStyle(): ScatterStyle {
    return this.styleWanted
  }

  /** W10-S: the field while it draws (GL-F's stats, the viewer's panel). */
  get groundCover(): GroundCover | null {
    return this.field
  }

  /**
   * W10-S (GRASS_LIFE §8.1): switches the ground-cover style. 'field' makes the field (when one is available), hands
   * it every registered region and drops the retail chunks; 'retail' disposes the field and the retail chunks regrow
   * around the camera. The shared uniforms, defines and depth textures stay on this facade.
   */
  setStyle(style: ScatterStyle): void {
    if (!SCATTER_STYLES.includes(style)) return
    this.styleWanted = style
    const want = style === 'field' && !this.disposed
    if (want === !!this.field) return
    if (!want) {
      this.field?.dispose()
      this.field = null
      return
    }
    let f: GroundCover | null = null
    try {
      f = this.fieldFactory?.(this, this.host) ?? null
    } catch (err) {
      console.warn('[world] grass field failed', err)
    }
    if (!f) return
    for (const r of this.regions.values()) this.dropChunks(r)
    this.field = f
    f.setLevel(this.levelValue)
    for (const d of this.regionData.values()) f.addRegion(d)
  }

  /**
   * W10-S (GRASS_LIFE §8.1): a foreign ShaderMaterial (the field's, the wildlife's) follows this facade: the shared
   * uniforms (`sharedUniforms`), the defines (`setDefine`) and the depth textures (`setDepthTexture`), now and on every
   * later change, plus the retail grass's by-reference values it declares (`scCamera`, `scFade`, `scShadow`, the fog)
   * and the black fallback of every chunk sampler it declares. Returns a remover; a disposed material leaves by itself.
   */
  adopt(mat: ShaderMaterial): () => void {
    if (this.disposed) return () => {}
    if (!this.adopted.has(mat)) {
      this.adopted.add(mat)
      const opts = mat.options as { uniforms?: string[]; samplers?: string[] }
      const uniforms = opts.uniforms ?? []
      const samplers = opts.samplers ?? []
      const own: Array<[string, Vector4]> = [['scCamera', this.uCamera], ['scFade', this.uFade], ['scShadow', this.uShadow], ['fogParams', this.uFog], ['fogColor', this.uFogColor]]
      for (const [name, v] of own) if (uniforms.includes(name)) mat.setVector4(name, v)
      for (const name of SCATTER_CHUNK_SAMPLERS) {
        const fallback = samplers.includes(name) ? this.fallbackFor(name) : null
        if (fallback) mat.setTexture(name, fallback)
      }
      bindAllShared(mat, this.sharedUniforms)
      this.defines.apply(mat)
      this.bindDepth(mat)
      mat.onDisposeObservable.addOnce(() => this.adopted.delete(mat))
    }
    return () => {
      this.adopted.delete(mat)
    }
  }

  /** W10-S: whether `mat` is adopted. */
  adopts(mat: ShaderMaterial): boolean {
    return this.adopted.has(mat)
  }

  /**
   * RND-W (docs/WAVE_PLAN3.md §6.14): the renderer and sky the grass lights itself from on the PBR path
   * (render/grass-chunks.ts RenderGrass: the SRO_HDR and SRO_GRASS_CSM defines and their uniforms). World calls it
   * once; on the Classic path it sets nothing, so Low draws HEAD's grass.
   */
  follow(source: GrassRenderSource | null): void {
    this.grass?.dispose()
    this.grass = source && !this.disposed ? new RenderGrass(this, source) : null
  }

  /** The grass feed (tests, the lab). */
  get renderGrass(): RenderGrass | null {
    return this.grass
  }

  /**
   * Binds a depth texture (a shadow map) to `name` on every grass material at bind time (Babylon's
   * setDepthStencilTexture: the depth attachment with its comparison sampler). null stops it.
   */
  setDepthTexture(name: string, get: (() => RenderTargetTexture | null) | null): void {
    if (get) this.depthTextures.set(name, get)
    else this.depthTextures.delete(name)
    for (const m of this.allMaterials()) this.bindDepth(m)
  }

  /** Switches HEAD's linear fog off (true) while a chunk fogs the grass itself. */
  setOwnFog(off: boolean): void {
    this.ownFog = off
    this.applyTerrainParams()
  }

  private bindDepth(mat: ShaderMaterial): void {
    if (!this.depthTextures.size || this.depthBound.has(mat)) return
    this.depthBound.add(mat)
    mat.onBindObservable.add(() => {
      const effect = mat.getEffect()
      if (!effect) return
      for (const [name, get] of this.depthTextures) {
        const t = get()
        if (t) effect.setDepthStencilTexture(name, t)
      }
    })
  }

  /** Changes the level: every chunk is dropped and regrows around the camera at the new density and distance. */
  setLevel(level: ScatterLevel): void {
    if (!SCATTER_LEVELS.includes(level) || level === this.levelValue) return
    this.levelValue = level
    this.stats.level = level
    for (const r of this.regions.values()) this.dropChunks(r)
    this.applyFade()
    this.field?.setLevel(level)
  }

  /** Registers a committed region (streaming: its 'scatter' job; whole world: every region). Replaces an older entry. */
  addRegion(data: RegionData): void {
    if (this.disposed) return
    this.removeRegion(data.region.id)
    this.regionData.set(data.region.id, data)
    this.field?.addRegion(data)
    this.regions.set(data.region.id, {
      id: data.region.id,
      src: scatterSource(data),
      chunks: new Array<ChunkEntry | null>(CHUNKS_PER_REGION).fill(null),
      materials: new Array<ShaderMaterial | null>(SCATTER_KINDS.length).fill(null),
      region: new Vector4(data.region.origin[0], 1, data.region.origin[2], 0),
      lightmap: null,
    })
    this.stats.regions = this.regions.size
  }

  /** Disposes a region's chunks and materials (with the region: streaming unload). */
  removeRegion(id: number): boolean {
    if (this.regionData.delete(id)) this.field?.removeRegion(id)
    const r = this.regions.get(id)
    if (!r) return false
    this.dropChunks(r)
    for (const m of r.materials) m?.dispose(false, false)
    r.materials.fill(null)
    this.regions.delete(id)
    this.stats.regions = this.regions.size
    return true
  }

  hasRegion(id: number): boolean {
    return this.regions.has(id)
  }

  /** Generated chunks of a region (tests, debugging). */
  chunksOf(id: number): ScatterChunkData[] {
    const r = this.regions.get(id)
    return r ? r.chunks.filter((c): c is ChunkEntry => !!c).map(c => c.data) : []
  }

  /** Every scatter mesh (tests, debugging; W10-S: the field's while it draws). */
  meshes(): Mesh[] {
    if (this.field) return this.field.meshes()
    const out: Mesh[] = []
    for (const r of this.regions.values()) for (const c of r.chunks) if (c) out.push(...c.meshes)
    return out
  }

  /** Resolves once the plant kinds are loaded (starts the load; resolves at once when already loaded). */
  ready(): Promise<void> {
    if (this.field) return this.field.ready()
    this.loading ??= loadScatterKinds(this.host.scene, this.host.assets, this.host.manifest.models, this.retail).then(kinds => {
      if (this.disposed) {
        for (const k of kinds) k.texture.dispose()
        return
      }
      this.kinds = kinds
      this.stats.art = kinds.map(k => `${k.def.id}: ${k.source}`).join(', ')
    }, err => {
      console.warn('[world] scatter kinds failed:', err)
      this.stats.art = 'failed'
    })
    return this.loading
  }

  /**
   * Per frame (World.update): shared uniforms, then chunk visibility, drops, and at most one new chunk (the nearest
   * missing one within range). `camera`: the camera position (glTF m), or null.
   */
  update(camera: { x: number; y: number; z: number } | null): void {
    if (this.disposed || this.levelValue === 'off' || !camera) return
    if (this.field) {
      // W10-S: the field draws; the facade keeps the shared values current for it (and for adopted materials).
      this.uCamera.set(camera.x, camera.y, camera.z, (this.now() / 1000) % 3600)
      this.applyTerrainParams()
      this.grass?.update()
      this.field.update(camera)
      return
    }
    if (!this.kinds) {
      void this.ready()
      return
    }
    this.uCamera.set(camera.x, camera.y, camera.z, (this.now() / 1000) % 3600)
    this.applyTerrainParams()
    this.grass?.update()
    const preset = SCATTER_PRESETS[this.levelValue]
    const genR = preset.viewM + GEN_MARGIN_M
    const dropR = preset.viewM + DROP_MARGIN_M
    let best: { r: RegionEntry; c: number; d: number } | null = null
    for (const r of this.regions.values()) {
      const [ox, , oz] = r.src.origin
      for (let c = 0; c < CHUNKS_PER_REGION; c++) {
        const cx = c % CHUNKS_PER_SIDE
        const cz = Math.floor(c / CHUNKS_PER_SIDE)
        const minX = ox + cx * CHUNK_M, maxX = minX + CHUNK_M
        const maxZ = oz - cz * CHUNK_M, minZ = maxZ - CHUNK_M
        const dx = camera.x < minX ? minX - camera.x : camera.x > maxX ? camera.x - maxX : 0
        const dz = camera.z < minZ ? minZ - camera.z : camera.z > maxZ ? camera.z - maxZ : 0
        const d = Math.hypot(dx, dz)
        const entry = r.chunks[c]
        if (entry) {
          if (d > dropR) this.dropChunk(r, c)
          else {
            const vis = d <= preset.viewM
            if (vis !== entry.visible) {
              entry.visible = vis
              for (const m of entry.meshes) m.setEnabled(vis)
            }
          }
        } else if (d <= genR && (!best || d < best.d)) best = { r, c, d }
      }
    }
    if (best) this.generate(best.r, best.c)
  }

  /** Builds one chunk now (placement + meshes). */
  generate(r: RegionEntry | number, chunk: number): ScatterChunkData | null {
    const entry = typeof r === 'number' ? this.regions.get(r) : r
    if (!entry || !this.kinds || this.levelValue === 'off' || entry.chunks[chunk]) return entry?.chunks[chunk]?.data ?? null
    const t0 = this.now()
    const occupied = this.host.occupied?.bind(this.host)
    const data = scatterChunk(entry.src, chunk, id => this.density.get(id) ?? 0, SCATTER_PRESETS[this.levelValue].fraction, occupied)
    const meshes: Mesh[] = []
    data.plants.forEach((plants, k) => {
      if (!plants.length) return
      const kind = this.kinds![k]!
      const mesh = new Mesh(`scatter_${kind.def.id}_${entry.id}_${chunk}`, this.host.scene)
      const vd = new VertexData()
      vd.positions = kind.positions
      vd.uvs = kind.uvs
      vd.indices = kind.indices
      vd.applyToMesh(mesh, false)
      mesh.material = this.material(entry, k)
      mesh.isPickable = false
      mesh.doNotSyncBoundingInfo = true
      mesh.thinInstanceSetBuffer('matrix', plantMatrices(plants, kind.heightM), 16, true)
      mesh.setBoundingInfo(new BoundingInfo(
        new Vector3(data.minX - 2, data.minY - 1, data.minZ - 2),
        new Vector3(data.maxX + 2, data.maxY + kind.def.heightM[1] + 1, data.maxZ + 2),
      ))
      mesh.freezeWorldMatrix()
      mesh.metadata = { sroWorld: 'scatter' }
      meshes.push(mesh)
      this.stats.meshes++
    })
    entry.chunks[chunk] = { data, meshes, visible: true }
    this.stats.chunks++
    this.stats.plants += data.count
    const ms = this.now() - t0
    this.stats.lastGenMs = ms
    if (ms > this.stats.worstGenMs) this.stats.worstGenMs = ms
    return data
  }

  private material(r: RegionEntry, k: number): ShaderMaterial {
    const have = r.materials[k]
    if (have) return have
    registerShaders()
    const scene = this.host.scene
    const kind = this.kinds![k]!
    const mat = new ShaderMaterial(`scatter_${kind.def.id}_${r.id}`, scene, 'sroScatter', {
      attributes: ['position', 'uv'],
      uniforms: [...SCATTER_UNIFORMS],
      samplers: [...SCATTER_SAMPLERS],
      shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    mat.backFaceCulling = false
    r.lightmap ??= this.host.lightmapOf?.(r.id) ?? null
    this.white ??= solidTexture(scene, [255, 255, 255, 255], 'scatterWhite')
    mat.setTexture('scDiffuse', kind.texture)
    mat.setTexture('scLightmap', r.lightmap ?? this.white)
    const tint = kind.source === 'procedural' ? 1 : kind.def.tint
    mat.setVector4('scTint', new Vector4(tint, tint, tint, ALPHA_CUT))
    r.region.y = r.lightmap && this.lightmapOn ? 1 : 0
    mat.setVector4('scRegion', r.region)
    mat.setVector4('scCamera', this.uCamera)
    mat.setVector4('scFade', this.uFade)
    mat.setVector4('scShadow', this.uShadow)
    mat.setVector4('fogParams', this.uFog)
    mat.setVector4('fogColor', this.uFogColor)
    for (const name of SCATTER_CHUNK_SAMPLERS) {
      const fallback = this.fallbackFor(name)
      if (fallback) mat.setTexture(name, fallback)
    }
    bindAllShared(mat, this.sharedUniforms)
    this.defines.apply(mat)
    this.bindDepth(mat)
    r.materials[k] = mat
    return mat
  }

  private *allMaterials(): Iterable<ShaderMaterial> {
    for (const r of this.regions.values()) for (const m of r.materials) if (m) yield m
    yield* this.adopted
  }

  private fallbackFor(name: string): BaseTexture | null {
    // A depth slot never takes a colour texture (setDepthTexture binds it).
    if (!SCATTER_CHUNK_SAMPLERS.includes(name) || name === GRASS_SHADOW_SAMPLER) return null
    return (this.black ??= solidTexture(this.host.scene, [0, 0, 0, 255], 'scatterChunkBlack'))
  }

  /** Turns a shader define on or off on every grass material, now and later (chunk `#ifdef`s, e.g. SRO_HDR). */
  setDefine(name: string, on: boolean): void {
    if (!this.defines.set(name, on)) return
    for (const m of this.allMaterials()) m.setDefine(name, on)
  }

  private applyFade(): void {
    const p = SCATTER_PRESETS[this.levelValue]
    this.uFade.x = Math.max(0, p.viewM - p.fadeM)
    this.uFade.y = Math.max(0.01, p.viewM)
  }

  private applyTerrainParams(): void {
    const p = this.host.terrainParams?.()
    if (!p) return
    this.uShadow.set(p.shadowColor[0] ?? 0, p.shadowColor[1] ?? 0, p.shadowColor[2] ?? 0, 0)
    this.uFog.set(p.fogStartM, p.fogEndM, p.fog && !this.ownFog ? 1 : 0, 0)
    this.uFogColor.set(p.fogColor[0] ?? 0, p.fogColor[1] ?? 0, p.fogColor[2] ?? 0, 1)
    if (p.lightmap !== this.lightmapOn) {
      this.lightmapOn = p.lightmap
      for (const r of this.regions.values()) r.region.y = r.lightmap && p.lightmap ? 1 : 0
    }
  }

  private dropChunk(r: RegionEntry, c: number): void {
    const e = r.chunks[c]
    if (!e) return
    for (const m of e.meshes) m.dispose(false, false)
    this.stats.meshes -= e.meshes.length
    this.stats.chunks--
    this.stats.plants -= e.data.count
    r.chunks[c] = null
  }

  private dropChunks(r: RegionEntry): void {
    for (let c = 0; c < CHUNKS_PER_REGION; c++) this.dropChunk(r, c)
  }

  dispose(): void {
    if (this.disposed) return
    this.field?.dispose()
    this.field = null
    this.adopted.clear()
    for (const id of [...this.regions.keys()]) this.removeRegion(id)
    this.grass?.dispose()
    this.grass = null
    this.disposed = true
    for (const k of this.kinds ?? []) k.texture.dispose()
    this.kinds = null
    this.white?.dispose()
    this.white = null
    this.black?.dispose()
    this.black = null
  }
}
