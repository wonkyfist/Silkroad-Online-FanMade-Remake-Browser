/**
 * The terrain review's spot finder (docs/TERRAIN_TEX.md §2.4; a port of the prototype's
 * `work/tmp/terrain-tex/spots.ts`): for a tile, the 40 m patches where the game camera sees mostly that tile, so the
 * in-game before/after pair and the in-game luminance gate (review.ts `inGameGate`) have a place to stand.
 *
 * A patch is 20 × 20 terrain vertices (2 m apart, 40 m) on a 5-vertex stride. It qualifies when the tile is the
 * vertex texture (word & 0x3ff) on at least `minShare` of its vertices, the ground is dry (its lowest vertex is at
 * least `dryMargin` above the water plane of the blocks under its corners and centre; the coast's +5 m sea turned
 * several soil patches into lake bed), and its relief is under `maxRelief`. Candidates are ranked by share, then by
 * distance from town. Coordinates are glTF metres from the town region's origin (168, 97), the frame `/tp x z` takes.
 *
 * Reads (never writes) a world export: the manifest and the terrain bins. Node only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeTerrainBin } from '../../convert/src/world/format.ts'
import type { TerrainBlock, WorldManifest } from '../../convert/src/world/manifest.ts'
import { tileKey } from './format.ts'

/** Vertices per region side (96 cells of 2 m). */
export const REGION_GRID = 97
export const VERTEX_M = 2
export const REGION_M = 192
/** The town region: the origin of glTF metres. */
export const TOWN_REGION = { x: 168, z: 97 } as const

export interface SpotOptions {
  /** Patch side in vertices (default 20: 40 m). */
  patch?: number
  /** Patch stride in vertices (default 5). */
  step?: number
  /** Least share of the patch's vertices the tile must cover (default 0.5). */
  minShare?: number
  /** Most relief inside a patch, metres (default 12). */
  maxRelief?: number
  /** Least height of the patch's lowest vertex over the blocks' water plane, metres (default 0.7). */
  dryMargin?: number
  /** Only regions within this Chebyshev distance of town, in regions (default 9). */
  maxRegions?: number
  /** Also search the coast's synthetic filler regions (default false: the coast-filler spot opts in). */
  synthetic?: boolean
  /** Candidates kept per tile (default 4). */
  keep?: number
}

export interface TerrainSpot {
  tile: number
  key: string
  region: string
  /** glTF metres, the patch centre (`/tp x z`). */
  x: number
  z: number
  /** The tile's share of the patch's vertices. */
  share: number
  /** Metres from the town origin. */
  dist: number
  /** Metres between the patch's lowest and highest vertex. */
  relief: number
  /** Metres of the lowest vertex over the water plane (null: no water under the patch). */
  dry: number | null
  synthetic: boolean
}

const DEFAULTS: Required<SpotOptions> = { patch: 20, step: 5, minShare: 0.5, maxRelief: 12, dryMargin: 0.7, maxRegions: 9, synthetic: false, keep: 4 }

/** The options over the defaults (an option given as undefined keeps its default). */
function withDefaults(options: SpotOptions): Required<SpotOptions> {
  const o = { ...DEFAULTS }
  for (const [k, v] of Object.entries(options)) if (v !== undefined) (o as Record<string, unknown>)[k] = v
  return o
}

/** The region's water planes by block index (bz * 6 + bx); null where a block has none. */
function waterOf(blocks: readonly TerrainBlock[]): Array<number | null> {
  const out: Array<number | null> = new Array(36).fill(null)
  for (const b of blocks) if (b.water) out[b.bz * 6 + b.bx] = b.water.heightM
  return out
}

/**
 * The qualifying patches of one region for a tile (pure: the region's grid and blocks in, candidates out, unsorted).
 * `textures` and `heights` are the region's 97 × 97 vertex arrays (row gz, column gx).
 */
export function spotsInRegion(
  region: { x: number; z: number; blocks: readonly TerrainBlock[]; synthetic?: boolean },
  textures: ArrayLike<number>, heights: ArrayLike<number>, tile: number, options: SpotOptions = {},
): TerrainSpot[] {
  const o = withDefaults(options)
  const G = REGION_GRID, P = o.patch
  const water = waterOf(region.blocks)
  const ox = REGION_M * (region.x - TOWN_REGION.x), oz = -REGION_M * (region.z - TOWN_REGION.z)
  const out: TerrainSpot[] = []
  for (let gz = 0; gz + P < G; gz += o.step) {
    for (let gx = 0; gx + P < G; gx += o.step) {
      let n = 0, hmin = Infinity, hmax = -Infinity
      for (let j = 0; j < P; j++) {
        for (let i = 0; i < P; i++) {
          const v = (gz + j) * G + gx + i
          if ((textures[v]! & 0x3ff) === tile) n++
          const h = heights[v]!
          if (h < hmin) hmin = h
          if (h > hmax) hmax = h
        }
      }
      const share = n / (P * P)
      if (share < o.minShare || hmax - hmin >= o.maxRelief) continue
      let dry: number | null = null
      for (const [ci, cj] of [[0, 0], [P - 1, 0], [0, P - 1], [P - 1, P - 1], [P >> 1, P >> 1]] as const) {
        const bx = Math.min(5, Math.floor((gx + ci) / 16)), bz = Math.min(5, Math.floor((gz + cj) / 16))
        const w = water[bz * 6 + bx]
        if (w !== null && w !== undefined) dry = Math.min(dry ?? Infinity, hmin - w)
      }
      if (dry !== null && dry < o.dryMargin) continue
      const x = ox + VERTEX_M * (gx + P / 2), z = oz - VERTEX_M * (gz + P / 2)
      out.push({
        tile, key: '', region: `${region.x}_${region.z}`, x: Math.round(x), z: Math.round(z), share: Math.round(share * 100) / 100,
        dist: Math.round(Math.hypot(x, z)), relief: Math.round((hmax - hmin) * 10) / 10, dry: dry === null ? null : Math.round(dry * 10) / 10,
        synthetic: !!region.synthetic,
      })
    }
  }
  return out
}

/** Ranks candidates: highest share first, then nearest town; keeps `keep`. */
export function rankSpots(spots: readonly TerrainSpot[], keep = DEFAULTS.keep): TerrainSpot[] {
  return [...spots].sort((a, b) => b.share - a.share || a.dist - b.dist).slice(0, keep)
}

/**
 * The best spots per tile of an export (tiles by their manifest stem or `tile2d:` key). Unknown tiles throw. Reads
 * each region's bin once for every tile.
 */
export function findTerrainSpots(worldDir: string, tiles: readonly string[], options: SpotOptions = {}): Map<string, TerrainSpot[]> {
  const o = withDefaults(options)
  const manifestPath = join(worldDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`no world export at ${manifestPath}`)
  const man = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorldManifest
  const byKey = new Map(man.tiles.map(t => [tileKey(t.source), t.id]))
  const want = tiles.map(t => {
    const key = tileKey(t)
    const id = byKey.get(key)
    if (id === undefined) throw new Error(`terrain spots: ${key} is not a tile of ${worldDir}`)
    return { key, id }
  })
  const found = new Map<string, TerrainSpot[]>(want.map(w => [w.key, []]))
  for (const r of man.regions) {
    if (r.synthetic && !o.synthetic) continue
    if (Math.max(Math.abs(r.x - TOWN_REGION.x), Math.abs(r.z - TOWN_REGION.z)) > o.maxRegions) continue
    const bin = decodeTerrainBin(readFileSync(join(worldDir, r.terrain.file)))
    for (const w of want) {
      for (const s of spotsInRegion(r, bin.textures, bin.heights, w.id, o)) found.get(w.key)!.push({ ...s, key: w.key })
    }
  }
  return new Map([...found].map(([k, v]) => [k, rankSpots(v, o.keep)]))
}
