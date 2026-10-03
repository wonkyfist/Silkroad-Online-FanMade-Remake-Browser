/**
 * The converter's world-edits hooks (wave 12, W12-CV; docs/WAVE_PLAN8.md §4.4, D6; docs/WORLD_EDITOR.md §3.6, §6.2):
 * the contract between ./convert-world.ts (the spine, which calls the hooks) and ./edits/index.ts (WE-D, which builds a
 * `WorldEditsRun` from content/world-edits/<world>/). Every hook is optional except the placement pass; a missing or
 * empty layer gives no run at all, so the export is byte-identical (docs/WAVE_PLAN8.md G7).
 *
 * Where each hook runs in convertWorld:
 *   terrain step   `terrain` / `height`: the region source overlay editsSource(coastSource(retailSource(...))): heights,
 *                  paint and water; `height` feeds the normals across region borders
 *   navmesh step   `navEdit`: the .nvm after the coast's edit (the nav rule's closed tiles; footprints moved, dropped,
 *                  added: WE-N's ./edits/nav-edit.ts); nav.bin, nav-objects.bin and the chunks follow
 *   passes         `pass`: step 6 of ./passes.ts
 *   after passes   `lightmap` / `minimap` on the touched regions (object shadows re-baked, dropped footprints redrawn),
 *                  `regionExtras` on every region (grass masks, light points), `ambientPoints` into ambient.json
 *   check          ./passes.ts editedFootprintProblems: the nav and the pass agree on every edited footprint
 *
 * Also here: the pre-pass placement cache (docs/WORLD_EDITOR.md F17, D53): the objects step's placements and models
 * before any pass, written by a full convert, so the incremental convert (WE-I) re-runs the passes on them instead of
 * on the manifest's post-pass list (which would apply the coast's and the dressing's edits twice).
 *
 * Pure: no node:* import.
 */
import type { MapMFile, NvmFile, RegionGrid } from '@sro/formats'
import type { TileTexture, WorldModel, WorldPlacement, WorldRegion } from './manifest.ts'
import type { WorldEditsPass } from './passes.ts'

/** 8-bit RGBA, rows as the file stores them (./worldmap.ts RgbaImage's shape). */
export interface EditsImage {
  width: number
  height: number
  rgba: Uint8Array
}

/** A region's terrain as the region source gives it (retail, the coast's, or edited). */
export interface RegionTerrain {
  mapm: MapMFile
  grid: RegionGrid
  /** The coast emitted the region (docs/COAST.md §5.4). */
  synthetic?: boolean
}

/** What the after-pass hooks see: the final placements and models. */
export interface WorldEditsScene {
  outDir: string
  origin: { x: number; z: number }
  placements: readonly WorldPlacement[]
  models: readonly WorldModel[]
}

export interface WorldEditsRun {
  /**
   * Region ids (z << 8 | x) whose terrain, lightmap or minimap the layers may change (edited ground, painted tiles,
   * water, and the old and new shadow areas of every moved, dropped or added object). The terrain, lightmap and minimap
   * hooks run only there; every other region's files stay byte-identical.
   */
  readonly touched: ReadonlySet<number>
  /** The region's terrain after the edits, given the coast's or retail's (null: not exported). */
  terrain?(x: number, z: number, base: RegionTerrain | null): RegionTerrain | null
  /** A global terrain vertex's height after the edits (grid.heights units), or undefined where not edited. */
  height?(ggx: number, ggz: number): number | undefined
  /** The navmesh-step hook: the region's .nvm after the edits (null or undefined: unchanged). */
  navEdit?(regionId: number, nvm: NvmFile): NvmFile | null | undefined
  /** Step 6 of the placement passes (./passes.ts). */
  pass: WorldEditsPass
  /** After the passes, for a touched region: its lightmap with the object shadows re-baked (null: keep `current`). */
  lightmap?(region: WorldRegion, current: EditsImage, scene: WorldEditsScene): EditsImage | null
  /** After the passes, for a touched region: its minimap tile redrawn (null: keep `current`). */
  minimap?(region: WorldRegion, current: EditsImage | null, scene: WorldEditsScene): EditsImage | null
  /** The region's additive manifest fields (files already written under outDir), or null. */
  regionExtras?(region: WorldRegion, scene: WorldEditsScene): Pick<WorldRegion, 'grassMask' | 'lightPoints'> | null
  /** ambient.json's free light `points` (docs/WORLD_EDITOR.md §3.3, S-NL). Empty: ambient.json as before. */
  ambientPoints?(scene: WorldEditsScene): readonly object[]
  /** Extra report.edits keys (the pipeline's `placements`, `models`, `staticVariants`, `footprintProblems` win). */
  report?(): Record<string, unknown>
}

// --- the pre-pass placement cache ------------------------------------------------------------------------------------

export const PRE_PASS_CACHE_FORMAT = 'sro-world-prepass'
export const PRE_PASS_CACHE_VERSION = 1

/** The objects step's output before any placement pass (tiles as the passes received them). */
export interface PrePassCache {
  format: typeof PRE_PASS_CACHE_FORMAT
  version: typeof PRE_PASS_CACHE_VERSION
  /** The export's name (manifest.name). */
  name: string
  origin: { x: number; z: number }
  tiles: TileTexture[]
  models: WorldModel[]
  placements: WorldPlacement[]
}

export function encodePrePassCache(c: Omit<PrePassCache, 'format' | 'version'>): string {
  const out: PrePassCache = {
    format: PRE_PASS_CACHE_FORMAT, version: PRE_PASS_CACHE_VERSION, name: c.name, origin: c.origin, tiles: c.tiles, models: c.models,
    placements: c.placements,
  }
  return JSON.stringify(out) + '\n'
}

/** Parses a cache file's text; throws with the reason when it is not one (or another export's). */
export function parsePrePassCache(text: string, expectName?: string): PrePassCache {
  const c = JSON.parse(text) as Partial<PrePassCache>
  if (c.format !== PRE_PASS_CACHE_FORMAT || c.version !== PRE_PASS_CACHE_VERSION) {
    throw new Error(`pre-pass cache: expected ${PRE_PASS_CACHE_FORMAT} v${PRE_PASS_CACHE_VERSION}`)
  }
  if (typeof c.name !== 'string' || !c.origin || !Array.isArray(c.tiles) || !Array.isArray(c.models) || !Array.isArray(c.placements)) {
    throw new Error('pre-pass cache: expected {name, origin, tiles, models, placements}')
  }
  if (expectName !== undefined && c.name !== expectName) throw new Error(`pre-pass cache: for '${c.name}', expected '${expectName}'`)
  c.models.forEach((m, i) => {
    if (m.index !== i) throw new Error(`pre-pass cache: models[${i}].index is ${m.index}`)
  })
  return c as PrePassCache
}
