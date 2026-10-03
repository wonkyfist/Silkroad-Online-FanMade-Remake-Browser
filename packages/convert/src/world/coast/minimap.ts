/**
 * Minimap tiles of the coast (docs/COAST.md §11; WAVE_PLAN6 lane CST-M, converter part). The client draws
 * `minimap/<x>x<z>.png` (256 x 256, north-up, 0.75 m per pixel, TERRAIN.md §7) and the world map stitches the same
 * tiles (../worldmap.ts); after the coast pass both must show the sand band and the sea all round the map.
 *
 * - An **unchanged** region keeps its retail tile (kind 'retail': the caller keeps the retail file).
 * - A **changed** region (heights moved, sand painted, or open sea where the ring was dry or retail water) keeps the
 *   retail pixels outside a change mask and gets our top-down render inside it (kind 'composite'). The mask is the
 *   changed lattice vertices at pixel resolution, dilated by CHANGE_DILATE_PX; across the dilation band our render
 *   fades into the retail pixels, so there is no hard edge, and outside it every pixel is the retail one, bit for bit.
 * - A **synthetic** region (emitted by the coast, no retail tile) is our render only (kind 'synthetic').
 *
 * Our render, per pixel, from the coast lattice (bilinear between the 2 m vertices):
 * - sea: the retail minimap's water colour in the shallows, manifest.coast.mapColor from ~10 m, darker beyond
 *   (shaded by the bed depth B), starting in the retail teal on the bounds line (SEA_LINE_BLEND_M: the bay and the
 *   river inside it stay retail) and with a white foam line along the open shore;
 * - sand and wet sand: the coast palette's swatches (content/coast/coast.json paint.palette 'sand' / 'wet-sand'),
 *   toned to the retail minimap's brightness, as work/tmp/coast-beach/preview.png draws them;
 * - land: `ground` when the caller gives it (the painted tile composite at the native periods, e.g.
 *   ../verify-scene.ts terrainColour over the region's new TerrainBin); otherwise the retail pixel where the ground
 *   moved less than RETAIL_FADE_M, else the flank paint rule (grass up to paint.grassMaxDeg, a blend to rock by
 *   paint.rockFromDeg) in colours measured on the retail Jangan minimaps;
 * - a gentle hill shade from the north-west on everything we draw (1 on flat ground, so flat sand meets flat retail
 *   ground without a step), and the footprints of added props (docs/COAST.md §10.3) as small discs;
 * - inside the footprint of a placement C9 dropped (./placements.ts dropFootprints), never the retail pixel: it has the
 *   object baked in, which is gone in 3D (W10R DD-1); the footprint joins the change mask.
 *
 * The world map (../worldmap.ts stitchWorldMap) covers `coastWorldMapRect` (the export grown to the coast domain) and
 * takes `coastWorldMapFill(manifest.coast)` as its fill. Its tile for a domain region that is neither exported nor
 * emitted is `coastMinimapTile` too, with the client's retail tile when the region is active (a land edge: unchanged,
 * so the retail tile itself) and null otherwise (deep sea: our render, depth-shaded like the emitted sea around it).
 *
 * Wiring (CST-C, which owns ./hook.ts, ./source.ts and ../convert-world.ts): the region source's `minimap(x, z)`
 * returns `coastMinimapTile(result, retailHeights, x, z, retailTile, opts)` for every changed or emitted region, the
 * terrain step writes it as `minimap/<x>x<z>.png` (encodePng) in place of the retail .ddj, and the world-map step
 * stitches the same images with the coast fill.
 *
 * Pure and deterministic (no node:*, no clock, no random).
 */
import type { CoastConfig } from './config.ts'
import { CELL_M, CELLS_PER_REGION, REGION_M, type LatticeShape, type RegionRect } from './lattice.ts'
import { COAST_CLASS } from './pass.ts'
import { fbm } from './noise.ts'
import type { DropFootprint } from './placements.ts'
import { clamp, flankRockWeight, smoothstep } from './profile.ts'
import { hexFill, WORLD_MAP_FILL, type MapFill, type RgbaImage, type WorldMapRect } from '../worldmap.ts'

/** The client minimap tile: 256 x 256 pixels per region, north-up (TERRAIN.md §7). */
export const MINIMAP_SIZE = 256
/** A region's side in file units (the GroundColour frame). */
const FILE_UNITS = 1920
/** Metres per minimap pixel (192 m / 256). */
export const MINIMAP_M_PER_PX = REGION_M / MINIMAP_SIZE
/** The change mask is dilated by this many pixels (docs/COAST.md §11), and our render fades out across them. */
export const CHANGE_DILATE_PX = 4
/** A lattice vertex whose height moved more than this counts as changed (m). */
export const CHANGE_TOL_M = 0.1
/** Without a ground composite, land that moved less than RETAIL_FADE_M[0] keeps the retail pixel (the paint did not
 *  change), and the flank paint rule takes over by RETAIL_FADE_M[1] (m). */
export const RETAIL_FADE_M: readonly [number, number] = [0.5, 2.5]
/** Grain on our flat colours (a value-noise brightness wobble), so they read like the textured retail pixels: land,
 *  sand; wavelength (m), octaves, seed. */
const GRAIN = { land: 0.3, sand: 0.06, wavelengthM: 6, octaves: 4, seed: 7331 } as const
/** The coast palette's swatches are ~1.4x brighter than the tile textures the minimap is drawn from; this tone brings
 *  them to the retail minimap's level (rock swatch #6d6a64 x 0.72 = the retail cliffs' (74, 70, 60) within 6). */
export const SWATCH_TONE = 0.72
/** The retail minimap's water (the teal of the rivers and the bay on the Jangan tiles). */
export const RETAIL_WATER_RGB: MapFill = [84, 141, 137]
/** Median grass and rock of the retail Jangan minimap tiles (measured on work/out/world/jangan-fields/minimap). */
export const RETAIL_GRASS_RGB: MapFill = [39, 58, 6]
export const RETAIL_ROCK_RGB: MapFill = [74, 70, 60]
/** The foam line along the shore. */
export const FOAM_RGB: MapFill = [236, 244, 246]
/** Added props' footprints. */
export const PROP_RGB: MapFill = [92, 78, 60]

/** Past the bounds line the sea's colour goes from the retail water's teal (on the line, where the retail tiles of
 *  the bay and the river end) to its depth colour over this distance (m). */
export const SEA_LINE_BLEND_M = 160
/** The pass's class rules (./pass.ts step 9), mirrored for the smooth class edges: the sea is ground more than
 *  SEA_BELOW_M under the sea level, wet sand lies within WET_BAND_M of the waterline (test: coast-minimap.test.ts). */
export const SEA_BELOW_M = 0.02
export const WET_BAND_M = 9
/** Sea colour stops by bed depth (m below sea level): 0 = the retail water, 10 = mapColor, 40 = mapColor x OPEN_SEA_TONE. */
const SEA_STOPS_M = [0, 4, 10, 40] as const
/**
 * The open (deep) sea's tone against mapColor: tiles reach mapColor x OPEN_SEA_TONE from 40 m, and the world map (and
 * the client's minimap and world map, world-render minimap.ts `minimapFill`) fill the sea beyond the tiles with the
 * same colour, so the tiles' outer edge meets the fill without a step.
 */
export const OPEN_SEA_TONE = 0.75
/** Foam weight at a Chebyshev distance of 1 and 2 pixels from dry ground. */
const FOAM_WEIGHT = [0.65, 0.3] as const
/** Hill shade: light from the north-west (azimuth 315°, altitude 42°), vertical exaggeration 1.6 (preview.png). */
const LIGHT = (() => {
  const az = (315 * Math.PI) / 180
  const alt = (42 * Math.PI) / 180
  return { east: Math.sin(az) * Math.cos(alt), north: Math.cos(az) * Math.cos(alt), up: Math.sin(alt) }
})()
const RELIEF = 1.6

export type Rgb = [number, number, number]

/** The colours our render uses. */
export interface CoastMapColours {
  /** Open sea (manifest.coast.mapColor). */
  sea: MapFill
  /** The shallows (RETAIL_WATER_RGB, so rivers and the sea meet without a seam). */
  shallow: MapFill
  sand: MapFill
  wetSand: MapFill
  grass: MapFill
  rock: MapFill
  foam: MapFill
  prop: MapFill
}

/** The part of a coast pass result (./pass.ts CoastResult) the minimap reads. */
export interface CoastMinimapField {
  shape: LatticeShape
  /** Final heights (m). */
  h: Float64Array
  /** COAST_CLASS per vertex. */
  cls: Uint8Array
  masks: { inPlay: Uint8Array }
  /** Distance past the bounds or corridor line (m; < 0 inside): the sea blends from the retail teal on the line. */
  s?: Float32Array
  /** Signed distance to the waterline (m; > 0 seaward): the sand's and the wet band's edges follow it smoothly. */
  u?: Float32Array
}

/** An added prop's footprint (docs/COAST.md §10.3): centre in region units (x east, z north), radius in metres. */
export interface PropFootprint {
  x: number
  z: number
  radiusM: number
}

/**
 * The painted ground colour at a region-local point in FILE units (lx east from the west edge, lz north from the south
 * edge, 0..1920: the TerrainBin frame of ../verify-scene.ts terrainColour), written to `out` (0..255 RGB). Returns
 * false where it has nothing (the fallback rule is used).
 */
export type GroundColour = (lx: number, lz: number, out: number[]) => boolean

export interface CoastMinimapOptions {
  seaLevelM: number
  colours: CoastMapColours
  /** Flank paint rule (coast.json paint): grass up to grassMaxDeg, rock from rockFromDeg. */
  grassMaxDeg: number
  rockFromDeg: number
  ground?: GroundColour
  footprints?: readonly PropFootprint[]
  /** Footprints of the placements C9 dropped (./placements.ts C9Result.dropFootprints). */
  dropped?: readonly DropFootprint[]
}

export interface CoastMinimapTile extends RgbaImage {
  kind: 'retail' | 'composite' | 'synthetic'
  /** Pixels inside the change mask before dilation (every pixel of a synthetic tile). */
  changedPx: number
}

const toned = (hex: string | undefined, fallback: MapFill): MapFill => {
  if (!hex) return fallback
  const [r, g, b] = hexFill(hex)
  return [Math.round(r * SWATCH_TONE), Math.round(g * SWATCH_TONE), Math.round(b * SWATCH_TONE)]
}

/** The render's colours from coast.json (palette entries by name: 'sand', 'wet-sand', 'rock'). */
export function coastMapColours(cfg: Pick<CoastConfig, 'paint' | 'ocean'>): CoastMapColours {
  const swatch = (name: string) => cfg.paint.palette.find(p => p.name === name)?.rgb
  return {
    sea: hexFill(cfg.ocean.mapColor),
    shallow: RETAIL_WATER_RGB,
    sand: toned(swatch('sand'), [154, 145, 115]),
    wetSand: toned(swatch('wet-sand'), [112, 101, 76]),
    grass: RETAIL_GRASS_RGB,
    rock: RETAIL_ROCK_RGB,
    foam: FOAM_RGB,
    prop: PROP_RGB,
  }
}

/** Options from coast.json; `extra` adds the ground composite and the props' footprints. */
export function coastMinimapOptions(cfg: Pick<CoastConfig, 'paint' | 'ocean' | 'seaLevelM'>,
  extra: Pick<CoastMinimapOptions, 'ground' | 'footprints' | 'dropped'> = {}): CoastMinimapOptions {
  return { seaLevelM: cfg.seaLevelM, colours: coastMapColours(cfg), grassMaxDeg: cfg.paint.grassMaxDeg, rockFromDeg: cfg.paint.rockFromDeg, ...extra }
}

/**
 * The world map's fill for regions without a tile: the open sea (mapColor x OPEN_SEA_TONE, the deep stop the tiles
 * reach) when the export has a coast, else WORLD_MAP_FILL.
 */
export function coastWorldMapFill(coast: { mapColor: string } | undefined): MapFill {
  if (!coast) return WORLD_MAP_FILL
  const [r, g, b] = hexFill(coast.mapColor)
  return [Math.round(r * OPEN_SEA_TONE), Math.round(g * OPEN_SEA_TONE), Math.round(b * OPEN_SEA_TONE)]
}

/**
 * The world map's rectangle with a coast (docs/COAST.md §11: "the stitch rectangle grows to the domain"): the export's
 * rectangle united with the coast lattice's domain (coast.json domain), so the sea all round is on the map.
 */
export function coastWorldMapRect(exportRect: RegionRect, domain: RegionRect): WorldMapRect {
  return {
    x0: Math.min(exportRect.x0, domain.x0),
    x1: Math.max(exportRect.x1, domain.x1),
    z0: Math.min(exportRect.z0, domain.z0),
    z1: Math.max(exportRect.z1, domain.z1),
  }
}

/** Sea colour at a bed depth (m below sea level). */
export function seaColour(c: CoastMapColours, depthM: number, out: number[]): void {
  const [d0, d1, d2, d3] = SEA_STOPS_M
  const deep: Rgb = [c.sea[0] * OPEN_SEA_TONE, c.sea[1] * OPEN_SEA_TONE, c.sea[2] * OPEN_SEA_TONE]
  const mid: Rgb = [0, 1, 2].map(k => c.shallow[k]! * 0.4 + c.sea[k]! * 0.6) as Rgb
  let a: readonly number[]
  let b: readonly number[]
  let t: number
  if (depthM <= d1) [a, b, t] = [c.shallow, mid, clamp((depthM - d0) / (d1 - d0), 0, 1)]
  else if (depthM <= d2) [a, b, t] = [mid, c.sea, (depthM - d1) / (d2 - d1)]
  else [a, b, t] = [c.sea, deep, clamp((depthM - d2) / (d3 - d2), 0, 1)]
  for (let k = 0; k < 3; k++) out[k] = a[k]! + (b[k]! - a[k]!) * t
}

/**
 * Which lattice vertices of region (x, z) changed, row by row from the north edge (97 x 97): no retail height, a
 * height moved by more than CHANGE_TOL_M, sand or wet sand, or open sea outside the frozen playable set. The water
 * inside it (the bay, the river, the marsh, the town's pools: retail water blocks in the game, not the ocean) keeps
 * the retail tile; the sea outside starts in the retail water's teal on the bounds line (SEA_LINE_BLEND_M). Null
 * outside the lattice domain.
 */
export function changedVertices(field: CoastMinimapField, retailHeights: Float64Array, x: number, z: number): Uint8Array | null {
  const l = field.shape
  if (x < l.x0 || x > l.x1 || z < l.z0 || z > l.z1) return null
  const n = CELLS_PER_REGION + 1
  const row0 = (l.z1 - z) * CELLS_PER_REGION
  const col0 = (x - l.x0) * CELLS_PER_REGION
  const out = new Uint8Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = (row0 + i) * l.cols + col0 + j
      const c = field.cls[k]!
      const r = retailHeights[k]!
      out[i * n + j] = Number.isNaN(r) || Math.abs(field.h[k]! - r) > CHANGE_TOL_M || c === COAST_CLASS.sand || c === COAST_CLASS.wetSand ||
        (c === COAST_CLASS.sea && !field.masks.inPlay[k]) ? 1 : 0
    }
  }
  return out
}

/**
 * The minimap tile of region (x, z) after the coast (see the file header). `retail` is the region's decoded retail
 * tile (null for a synthetic region, or when the client has none); `retailHeights` the pass input's retail heights on
 * the lattice (NaN = none). Returns null outside the lattice domain; for an unchanged region, the retail image itself
 * with kind 'retail'.
 */
export function coastMinimapTile(field: CoastMinimapField, retailHeights: Float64Array, x: number, z: number, retail: RgbaImage | null,
  opts: CoastMinimapOptions): CoastMinimapTile | null {
  const changed = changedVertices(field, retailHeights, x, z)
  if (!changed) return null
  const S = MINIMAP_SIZE
  const l = field.shape
  const n = CELLS_PER_REGION + 1
  const step = CELLS_PER_REGION / S
  const retailPx = retail ? toTileSize(retail) : null

  // --- the change mask at pixel resolution (+ the props' footprints), then its dilation distance
  const core = new Uint8Array(S * S)
  let changedPx = 0
  for (let r = 0; r < S; r++) {
    const fi = (r + 0.5) * step
    const i0 = Math.floor(fi)
    for (let c = 0; c < S; c++) {
      const fj = (c + 0.5) * step
      const j0 = Math.floor(fj)
      // conservative: a pixel changes when any of its four surrounding vertices does
      if (changed[i0 * n + j0] || changed[i0 * n + j0 + 1] || changed[(i0 + 1) * n + j0] || changed[(i0 + 1) * n + j0 + 1]) core[r * S + c] = 1
    }
  }
  const props = footprintMask(opts.footprints ?? [], x, z)
  if (props) for (let p = 0; p < S * S; p++) core[p] = core[p]! | props[p]!
  const gone = droppedMask(opts.dropped ?? [], x, z)
  if (gone) for (let p = 0; p < S * S; p++) core[p] = core[p]! | gone[p]!
  for (let p = 0; p < S * S; p++) changedPx += core[p]!
  if (retailPx && !changedPx) return { ...retailPx, kind: 'retail', changedPx: 0 }
  const weight = retailPx ? fadeWeights(core, S) : null

  // --- our render over the tile plus a 2 px apron (the foam needs the neighbours' classes)
  const A = 2
  const W = S + 2 * A
  const row0 = (l.z1 - z) * CELLS_PER_REGION
  const col0 = (x - l.x0) * CELLS_PER_REGION
  const sample = sampler(field, retailHeights, opts.seaLevelM)
  const kind = new Uint8Array(W * W) // 0 land, 1 sea, 2 inland water
  for (let r = 0; r < W; r++) {
    for (let c = 0; c < W; c++) {
      const s = sample.at(row0 + (r - A + 0.5) * step, col0 + (c - A + 0.5) * step)
      kind[r * W + c] = s.sea ? 1 : s.inland ? 2 : 0
    }
  }

  const col = opts.colours
  const flat = LIGHT.up
  const rgba = new Uint8Array(S * S * 4)
  const px = [0, 0, 0]
  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) {
      const p = r * S + c
      const o = p * 4
      const w = weight ? weight[p]! : 1
      rgba[o + 3] = 255
      if (w <= 0) {
        rgba[o] = retailPx!.rgba[o]!
        rgba[o + 1] = retailPx!.rgba[o + 1]!
        rgba[o + 2] = retailPx!.rgba[o + 2]!
        continue
      }
      const fr = row0 + (r + 0.5) * step
      const fc = col0 + (c + 0.5) * step
      const s = sample.at(fr, fc)
      const shade = sample.shade(fr, fc)
      const k = kind[(r + A) * W + c + A]!
      const grain = () => fbm((x + (c + 0.5) / S) * REGION_M, (z + 1 - (r + 0.5) / S) * REGION_M, GRAIN.wavelengthM, GRAIN.octaves, GRAIN.seed)
      if (k === 1) {
        seaColour(col, opts.seaLevelM - s.h, px)
        if (s.line < SEA_LINE_BLEND_M) mix(px, col.shallow, 1 - smoothstep(0, SEA_LINE_BLEND_M, s.line))
        mul(px, clamp(1 + 0.25 * (shade - flat), 0.8, 1.1))
        // the foam line of the open sea (the in-game shore foam is the ocean's, outside the frozen playable set)
        const d = s.inPlay >= 0.5 ? Infinity : dryDistance(kind, W, r + A, c + A)
        if (d <= FOAM_WEIGHT.length) mix(px, col.foam, FOAM_WEIGHT[d - 1]!)
      } else if (k === 2) {
        if (retailPx) copy(px, retailPx.rgba, o)
        else set(px, col.shallow)
      } else {
        if (s.sand) {
          set(px, s.wet ? col.wetSand : col.sand)
          mul(px, clamp(1 + 0.3 * (shade - flat), 0.8, 1.05) * (1 + GRAIN.sand * grain()))
        } else if (opts.ground?.(((c + 0.5) / S) * FILE_UNITS, FILE_UNITS - ((r + 0.5) / S) * FILE_UNITS, px)) {
          // the painted composite (textured already)
          mul(px, clamp(1 + 0.3 * (shade - flat), 0.8, 1.05))
        } else {
          // the flank paint rule, faded into the retail pixel where the ground barely moved (the paint is unchanged)
          const t = flankRockWeight(sample.slopeDeg(fr, fc), opts.grassMaxDeg, opts.rockFromDeg)
          for (let q = 0; q < 3; q++) px[q] = col.grass[q]! + (col.rock[q]! - col.grass[q]!) * t
          mul(px, clamp(1 + 0.3 * (shade - flat), 0.8, 1.05) * (1 + GRAIN.land * grain()))
          const keep = retailPx && !gone?.[p] && !Number.isNaN(s.retailH) ? 1 - smoothstep(RETAIL_FADE_M[0], RETAIL_FADE_M[1], Math.abs(s.h - s.retailH)) : 0
          if (keep > 0) for (let q = 0; q < 3; q++) px[q] = px[q]! + (retailPx!.rgba[o + q]! - px[q]!) * keep
        }
      }
      if (props?.[p]) mix(px, col.prop, 0.85)
      if (retailPx) mixInto(rgba, o, px, w, retailPx.rgba)
      else mixInto(rgba, o, px, 1)
    }
  }
  return { width: S, height: S, rgba, kind: retailPx ? 'composite' : 'synthetic', changedPx: retailPx ? changedPx : S * S }
}

// --- helpers ----------------------------------------------------------------------------------------------------------

const set = (px: number[], c: MapFill) => {
  px[0] = c[0]
  px[1] = c[1]
  px[2] = c[2]
}
const copy = (px: number[], rgba: Uint8Array, o: number) => {
  px[0] = rgba[o]!
  px[1] = rgba[o + 1]!
  px[2] = rgba[o + 2]!
}
const mul = (px: number[], k: number) => {
  px[0] = px[0]! * k
  px[1] = px[1]! * k
  px[2] = px[2]! * k
}
const mix = (px: number[], c: MapFill, t: number) => {
  for (let k = 0; k < 3; k++) px[k] = px[k]! + (c[k]! - px[k]!) * t
}
/** out[o..] = round(base * (1 - w) + px * w) (base = the retail pixels, or none when w = 1). */
const mixInto = (out: Uint8Array, o: number, px: number[], w: number, base?: Uint8Array) => {
  for (let k = 0; k < 3; k++) {
    const b = base ? base[o + k]! : 0
    out[o + k] = clamp(Math.round(b + (px[k]! - b) * w), 0, 255)
  }
}

/** The retail tile at 256 x 256 (nearest sample if the client's tile has another size). */
function toTileSize(img: RgbaImage): RgbaImage {
  const S = MINIMAP_SIZE
  if (img.width === S && img.height === S) return img
  const rgba = new Uint8Array(S * S * 4)
  for (let r = 0; r < S; r++) {
    const sr = Math.min(img.height - 1, Math.floor(((r + 0.5) * img.height) / S))
    for (let c = 0; c < S; c++) {
      const sc = Math.min(img.width - 1, Math.floor(((c + 0.5) * img.width) / S))
      rgba.set(img.rgba.subarray((sr * img.width + sc) * 4, (sr * img.width + sc) * 4 + 4), (r * S + c) * 4)
    }
  }
  return { width: S, height: S, rgba }
}

/**
 * Our render's weight per pixel: 1 inside the change mask, 1 - d / (CHANGE_DILATE_PX + 1) at a Chebyshev distance d
 * of 1 .. CHANGE_DILATE_PX from it, 0 beyond (the retail pixel exactly).
 */
function fadeWeights(core: Uint8Array, S: number): Float32Array {
  const D = CHANGE_DILATE_PX
  const dist = new Uint8Array(S * S).fill(255)
  for (let p = 0; p < S * S; p++) if (core[p]) dist[p] = 0
  for (let d = 1; d <= D; d++) {
    const prev = dist.slice()
    for (let r = 0; r < S; r++) {
      for (let c = 0; c < S; c++) {
        const p = r * S + c
        if (prev[p]! <= d) continue
        let hit = false
        for (let dr = -1; dr <= 1 && !hit; dr++) {
          const rr = r + dr
          if (rr < 0 || rr >= S) continue
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc
            if (cc >= 0 && cc < S && prev[rr * S + cc] === d - 1) {
              hit = true
              break
            }
          }
        }
        if (hit) dist[p] = d
      }
    }
  }
  const w = new Float32Array(S * S)
  for (let p = 0; p < S * S; p++) w[p] = dist[p]! > D ? 0 : 1 - dist[p]! / (D + 1)
  return w
}

/** Chebyshev distance (1 or 2) from a sea pixel to the nearest dry pixel (land), or 3 when none is that close. */
function dryDistance(kind: Uint8Array, W: number, r: number, c: number): number {
  for (let d = 1; d <= FOAM_WEIGHT.length; d++) {
    for (let dr = -d; dr <= d; dr++) {
      for (let dc = -d; dc <= d; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== d) continue
        const rr = r + dr
        const cc = c + dc
        if (rr >= 0 && rr < W && cc >= 0 && cc < W && kind[rr * W + cc] === 0) return d
      }
    }
  }
  return FOAM_WEIGHT.length + 1
}

/** Pixels of region (x, z) covered by a prop footprint, or null when none touches the region. */
function footprintMask(fps: readonly PropFootprint[], x: number, z: number): Uint8Array | null {
  const S = MINIMAP_SIZE
  let out: Uint8Array | null = null
  for (const f of fps) {
    // pixel coordinates of the centre: column from the west edge, row from the north edge
    const cc = (f.x - x) * S
    const cr = (z + 1 - f.z) * S
    const rp = f.radiusM / MINIMAP_M_PER_PX
    if (cc + rp < 0 || cc - rp > S || cr + rp < 0 || cr - rp > S) continue
    out ??= new Uint8Array(S * S)
    for (let r = Math.max(0, Math.floor(cr - rp)); r < Math.min(S, Math.ceil(cr + rp)); r++) {
      for (let c = Math.max(0, Math.floor(cc - rp)); c < Math.min(S, Math.ceil(cc + rp)); c++) {
        if ((c + 0.5 - cc) ** 2 + (r + 0.5 - cr) ** 2 <= rp * rp) out[r * S + c] = 1
      }
    }
  }
  return out
}

/** Whether a dropped placement's footprint reaches into region (x, z). */
export function droppedTouches(fps: readonly DropFootprint[], x: number, z: number): boolean {
  return fps.some(f => f.corners.some(([cx]) => cx > x) && f.corners.some(([cx]) => cx < x + 1) &&
    f.corners.some(([, cz]) => cz > z) && f.corners.some(([, cz]) => cz < z + 1))
}

/** Pixels of region (x, z) inside a dropped placement's footprint (a convex quad), or null when none touches it. */
function droppedMask(fps: readonly DropFootprint[], x: number, z: number): Uint8Array | null {
  const S = MINIMAP_SIZE
  let out: Uint8Array | null = null
  for (const f of fps) {
    // pixel coordinates: column from the west edge, row from the north edge
    const pts = f.corners.map(([cx, cz]) => [(cx - x) * S, (z + 1 - cz) * S] as const)
    const c0 = Math.max(0, Math.floor(Math.min(...pts.map(q => q[0]))))
    const c1 = Math.min(S, Math.ceil(Math.max(...pts.map(q => q[0]))))
    const r0 = Math.max(0, Math.floor(Math.min(...pts.map(q => q[1]))))
    const r1 = Math.min(S, Math.ceil(Math.max(...pts.map(q => q[1]))))
    if (c0 >= c1 || r0 >= r1) continue
    // inside a convex polygon: on the same side of every edge (either winding)
    const inside = (px: number, py: number) => {
      let pos = false
      let neg = false
      for (let k = 0; k < pts.length; k++) {
        const [ax, ay] = pts[k]!
        const [bx, by] = pts[(k + 1) % pts.length]!
        const cr = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
        if (cr > 0) pos = true
        else if (cr < 0) neg = true
        if (pos && neg) return false
      }
      return true
    }
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (!inside(c + 0.5, r + 0.5)) continue
        out ??= new Uint8Array(S * S)
        out[r * S + c] = 1
      }
    }
  }
  return out
}

/**
 * Whether a point of a lattice cell belongs to a class, from the cell's four corners (weights `w`, classes `cls`) and a
 * continuous value `v` that grows toward the class (`at` = its bilinear value at the point). All corners in (or out)
 * decide alone. On a mixed cell the edge is the contour `v = threshold` (the pass's own rule) when it separates the
 * corners, else the contour halfway between the highest non-member and the lowest member corner, so it runs smoothly
 * across the 2 m lattice instead of in steps; when no contour separates them (or `smooth` is false), the corners'
 * weights vote. `among` limits the corners that take part (e.g. the wet band among
 * the sand corners).
 */
function edge(w: readonly number[], cls: readonly number[], v: readonly number[], at: number, member: (k: number) => boolean,
  smooth: boolean, among?: (k: number) => boolean, threshold?: number): boolean {
  let inW = 0
  let allW = 0
  let lo = Infinity
  let hi = -Infinity
  for (let q = 0; q < 4; q++) {
    const k = cls[q]!
    if (among && !among(k)) continue
    allW += w[q]!
    if (member(k)) {
      inW += w[q]!
      lo = Math.min(lo, v[q]!)
    } else hi = Math.max(hi, v[q]!)
  }
  if (inW <= 0) return false
  if (inW >= allW) return true
  if (smooth && threshold !== undefined && hi <= threshold && threshold < lo) return at > threshold
  if (smooth && hi < lo) return at > (hi + lo) / 2
  return inW >= allW / 2
}

/** Bilinear reads of the lattice at fractional (row, column), clamped to the domain. */
function sampler(field: CoastMinimapField, retailHeights: Float64Array, seaLevelM: number) {
  const { rows, cols } = field.shape
  const { h, cls } = field
  const inPlay = field.masks.inPlay
  const lineDist = field.s
  const u = field.u
  const out = { h: 0, retailH: 0, sea: false, inland: false, sand: false, wet: false, inPlay: 0, line: 0 }
  const hAt = (fr: number, fc: number) => {
    const r = clamp(fr, 0, rows - 1)
    const c = clamp(fc, 0, cols - 1)
    const r0 = Math.min(Math.floor(r), rows - 2)
    const c0 = Math.min(Math.floor(c), cols - 2)
    const tr = r - r0
    const tc = c - c0
    const k = r0 * cols + c0
    return (h[k]! * (1 - tc) + h[k + 1]! * tc) * (1 - tr) + (h[k + cols]! * (1 - tc) + h[k + cols + 1]! * tc) * tr
  }
  const grad = (fr: number, fc: number) => {
    const east = (hAt(fr, fc + 0.5) - hAt(fr, fc - 0.5)) / CELL_M
    const north = (hAt(fr - 0.5, fc) - hAt(fr + 0.5, fc)) / CELL_M
    return [east, north] as const
  }
  // the four corners of the current cell: weight, class, and the continuous values the class edges follow (depth -h, u)
  const qw = [0, 0, 0, 0]
  const qc = [0, 0, 0, 0]
  const qd = [0, 0, 0, 0]
  const qu = [0, 0, 0, 0]
  return {
    at(fr: number, fc: number) {
      const r = clamp(fr, 0, rows - 1)
      const c = clamp(fc, 0, cols - 1)
      const r0 = Math.min(Math.floor(r), rows - 2)
      const c0 = Math.min(Math.floor(c), cols - 2)
      const tr = r - r0
      const tc = c - c0
      out.h = out.retailH = out.inPlay = 0
      out.line = lineDist ? 0 : Infinity
      let rw = 0
      let uBil = 0
      for (let q = 0; q < 4; q++) {
        const k = (r0 + (q >> 1)) * cols + c0 + (q & 1)
        const w = ((q & 1) ? tc : 1 - tc) * ((q >> 1) ? tr : 1 - tr)
        qw[q] = w
        qc[q] = cls[k]!
        qd[q] = -h[k]!
        qu[q] = u ? u[k]! : 0
        out.h += h[k]! * w
        uBil += qu[q]! * w
        out.inPlay += inPlay[k]! * w
        if (lineDist) out.line += lineDist[k]! * w
        const rh = retailHeights[k]!
        if (!Number.isNaN(rh)) {
          out.retailH += rh * w
          rw += w
        }
      }
      // where retail is missing at a corner, the known corners stand in (and none known = not retail at all)
      out.retailH = rw > 0 ? out.retailH / rw : NaN
      // the class edges: the sea's by depth (-h), the sand's and the wet band's by the distance to the waterline (u)
      const isSea = (k: number) => k === COAST_CLASS.sea
      const isSand = (k: number) => k === COAST_CLASS.sand || k === COAST_CLASS.wetSand
      out.sea = edge(qw, qc, qd, -out.h, isSea, true, undefined, -(seaLevelM - SEA_BELOW_M))
      // a point that is not sea takes its class from the other corners only (a sea corner is neither sand nor land)
      const dry = (k: number) => !isSea(k)
      out.inland = !out.sea && edge(qw, qc, qd, 0, k => k === COAST_CLASS.retailWater, false, dry)
      out.sand = !out.sea && !out.inland && edge(qw, qc, qu, uBil, isSand, !!u, k => dry(k) && k !== COAST_CLASS.retailWater)
      out.wet = out.sand && edge(qw, qc, qu, uBil, k => k === COAST_CLASS.wetSand, !!u, isSand, -WET_BAND_M)
      return out
    },
    /** Lambert shade of the surface (n . light), relief exaggerated. */
    shade(fr: number, fc: number) {
      const [e, n] = grad(fr, fc)
      const nx = -e * RELIEF
      const nz = -n * RELIEF
      return Math.max(0, (nx * LIGHT.east + nz * LIGHT.north + LIGHT.up) / Math.hypot(nx, nz, 1))
    },
    slopeDeg(fr: number, fc: number) {
      const [e, n] = grad(fr, fc)
      return (Math.atan(Math.hypot(e, n)) * 180) / Math.PI
    },
  }
}
