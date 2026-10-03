/**
 * The nav rule (docs/WORLD_EDITOR.md §6.3, D40; docs/WAVE_PLAN8.md §2.5): which 2 m tiles an edit closes or opens.
 * One pure function, used by the editor's walking overlay, the converter's nav step (WE-N applies the result to the
 * region's NvmFile: the closed cell and the blocked tile flag, as coast/navgen.ts `close` does) and the tests.
 *
 * Per tile (tz * 96 + tx, corners gz * 97 + gx):
 * 1. A tile touching a vertex the edit moved by more than 5 cm: an **open** tile whose slope after the edit is over
 *    0.7 (35 deg) and steeper than before by more than 0.05 closes; retail's own steep open tiles stay as they are.
 * 2. Under **new** water (water.json) deeper than 1.2 m at the tile's centre (its mean corner height), an open tile
 *    closes (until swimming exists, D30).
 * 3. A closed tile never opens by itself.
 * 4. The Walkable overrides apply last: force open opens a closed tile, force closed closes an open one.
 * Slope = rise over run across the tile's corners: max(|h0 - h1|, |h2 - h3|, |h0 - h2|, |h1 - h3|) / 2 m (the coast's
 * NAV_MAX_SLOPE rule). Heights in metres; the nav's file units are metres x 10 (`navHeightsAfter`).
 */
import { WE_BLOCKS, WE_GRID, WE_TILES, WE_TILE_M, WE_WALK, type HeightLayer } from './types.ts'
import { tileBlock } from './apply.ts'

/** A vertex counts as moved past this (m). */
export const NAV_RULE_MOVED_M = 0.05
/** Steepest open tile after an edit (rise over run, 35 deg). */
export const NAV_RULE_MAX_SLOPE = 0.7
/** ... and only when the edit made it steeper by more than this. */
export const NAV_RULE_STEEPER_BY = 0.05
/** New water deeper than this closes the tile (m). */
export const NAV_RULE_WATER_DEPTH_M = 1.2

/** Per-tile result: keep the tile as it is, close it, or open it. */
export const NAV_TILE_ACTION = { keep: 0, close: 1, open: 2 } as const

export interface NavRuleInput {
  /** 97 x 97 heights before the edit (m). */
  before: ArrayLike<number>
  /** 97 x 97 heights after the edit (m). */
  after: ArrayLike<number>
  /** 96 x 96: 1 where the tile is open before the edit (its cell index < openCellCount). */
  open: ArrayLike<number>
  /** 6 x 6 (bz * 6 + bx): the water level the edits set (m), NaN where they set none (waterLevelsForRegion). */
  water?: ArrayLike<number> | null
  /** 96 x 96 WE_WALK codes (the walk layer), or none. */
  walk?: ArrayLike<number> | null
}

export interface NavRuleResult {
  /** 96 x 96 NAV_TILE_ACTION per tile. */
  actions: Uint8Array
  /** Tiles touching a vertex moved by more than 5 cm. */
  touched: number
  closedSlope: number
  closedWater: number
  forcedOpen: number
  forcedClosed: number
  /** Total closes / opens in `actions`. */
  closed: number
  opened: number
}

/**
 * THE deep-water rule, in one function (D30; the hook for wave 13's swimming, docs/SWIMMING.md §2.5 SW-D6): what new
 * editor water `depthM` deep over a tile does to walking. Wave 12: deeper than 1.2 m is 'deep' (closed for walking).
 * Wave 13 keeps the walking answer and makes a 'deep' tile "swimmable, not walkable" (the swim layer), so every
 * caller asks here: navRuleRegion, and WE-N's nav edit, which lists the deep tiles (`deepWater`, the future swim
 * layer's editor input). NaN (no edited water) is 'walk'.
 */
export function navRuleWaterTile(depthM: number): 'walk' | 'deep' {
  return depthM > NAV_RULE_WATER_DEPTH_M ? 'deep' : 'walk'
}

/** Depth of the edits' water over a tile: level minus the mean of its four corner heights (m); NaN without water. */
export function tileWaterDepth(after: ArrayLike<number>, water: ArrayLike<number>, tx: number, tz: number): number {
  const level = water[tileBlock(tx, tz)]!
  if (Number.isNaN(level)) return NaN
  const k = tz * WE_GRID + tx
  return level - (after[k]! + after[k + 1]! + after[k + WE_GRID]! + after[k + WE_GRID + 1]!) / 4
}

/** Rise over run across one tile's four corners. */
export function tileSlope(h: ArrayLike<number>, tx: number, tz: number): number {
  const k = tz * WE_GRID + tx
  const h0 = h[k]!, h1 = h[k + 1]!, h2 = h[k + WE_GRID]!, h3 = h[k + WE_GRID + 1]!
  return Math.max(Math.abs(h0 - h1), Math.abs(h2 - h3), Math.abs(h0 - h2), Math.abs(h1 - h3)) / WE_TILE_M
}

/** The nav rule for one region. Pure and deterministic; the inputs are not mutated. */
export function navRuleRegion(input: NavRuleInput): NavRuleResult {
  const { before, after, open, water, walk } = input
  if (before.length !== WE_GRID * WE_GRID || after.length !== WE_GRID * WE_GRID) throw new Error('nav rule: heights must be 97 x 97')
  if (open.length !== WE_TILES * WE_TILES) throw new Error('nav rule: open must be 96 x 96')
  if (walk && walk.length !== WE_TILES * WE_TILES) throw new Error('nav rule: walk must be 96 x 96')
  if (water && water.length !== WE_BLOCKS * WE_BLOCKS) throw new Error('nav rule: water must be 6 x 6')
  const moved = new Uint8Array(WE_GRID * WE_GRID)
  for (let i = 0; i < moved.length; i++) if (Math.abs(after[i]! - before[i]!) > NAV_RULE_MOVED_M) moved[i] = 1

  const r: NavRuleResult = { actions: new Uint8Array(WE_TILES * WE_TILES), touched: 0, closedSlope: 0, closedWater: 0, forcedOpen: 0, forcedClosed: 0, closed: 0, opened: 0 }
  for (let tz = 0; tz < WE_TILES; tz++) {
    for (let tx = 0; tx < WE_TILES; tx++) {
      const t = tz * WE_TILES + tx
      const k = tz * WE_GRID + tx
      const wasOpen = open[t] !== 0
      let isOpen = wasOpen
      if (moved[k] || moved[k + 1] || moved[k + WE_GRID] || moved[k + WE_GRID + 1]) {
        r.touched++
        if (isOpen) {
          const s1 = tileSlope(after, tx, tz)
          if (s1 > NAV_RULE_MAX_SLOPE && s1 - tileSlope(before, tx, tz) > NAV_RULE_STEEPER_BY) {
            isOpen = false
            r.closedSlope++
          }
        }
      }
      if (isOpen && water && navRuleWaterTile(tileWaterDepth(after, water, tx, tz)) === 'deep') {
        isOpen = false
        r.closedWater++
      }
      const code = walk ? walk[t]! : WE_WALK.auto
      if (code === WE_WALK.open && !isOpen) {
        isOpen = true
        r.forcedOpen++
      } else if (code === WE_WALK.closed && isOpen) {
        isOpen = false
        r.forcedClosed++
      }
      if (isOpen !== wasOpen) {
        r.actions[t] = isOpen ? NAV_TILE_ACTION.open : NAV_TILE_ACTION.close
        if (isOpen) r.opened++
        else r.closed++
      }
    }
  }
  return r
}

/**
 * A region's nav heights (file units = m x 10, 97 x 97) after a height layer: the layer's delta x 10 added where
 * touched, float32; untouched vertices keep their exact retail values.
 */
export function navHeightsAfter(navBefore: ArrayLike<number>, layer: HeightLayer | null | undefined): Float32Array {
  const out = Float32Array.from(navBefore)
  if (!layer) return out
  for (let i = 0; i < out.length; i++) if (layer.mask[i]) out[i] = Math.fround(out[i]! + layer.delta[i]! * 10)
  return out
}
