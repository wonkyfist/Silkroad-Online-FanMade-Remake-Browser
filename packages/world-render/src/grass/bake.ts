/**
 * The grass bake of one region (docs/GRASS_LIFE.md §3.1, §3.2, §3.5, §4.1; lane GL-F): 192 × 192 RGBA8 texels at 1 m
 * (R density 0..1, G meadow mask, B palette slot, A baked light; A is 255 until the region's lightmap arrives,
 * grass/field.ts). The window (grass/window.ts) copies these rows around the camera.
 *
 * Where grass grows: the splat, not the per-vertex word (§3.2). Each terrain tile has a grass weight (1 for tiles
 * typed Grass, LongGrass or Forest; 0.45 for grassy dirt; 0 for any pavement, rock or water name; the converter's
 * `tiles[].grass.weight` when present, GL-C). The native layers are composited in draw order (TERRAIN §2.3: layer 0 is
 * opaque, each later layer replaces the cell corners its mask covers), then interpolated bilinearly across the 2 m cell,
 * so the grass follows the painted edge of the terrain and a road edge becomes a ramp across one cell (the shader turns
 * it into thinning, shortening blades: soft road edges). Near any painted change the edge feather (LOOK, after X1:
 * `GRASS_EDGE_WARP_M`) warps, thins and interleaves it, so no edge or palette border runs as a straight line. Then ×
 * the slope fade `smoothstep(0.70, 0.80, normal.y)` (per vertex, bilinear), 0 under water (+ 0.1 m), 0 under the
 * coast's sea with a ragged ramp above it (`grassSeaFade`), and 0 on an object floor (today's rule: a nav object surface at or above the ground − 0.3 m, the host's
 * `occupied`). The meadow mask (flowers, §4.1) is two octaves of value noise (22 m and 6 m) through a smoothstep, × the
 * density. The palette slot is the last grass layer's tile's (grass/palette in `grassTileTable`), blended near a change.
 *
 * The bake runs in row slices (`RegionGrassBake.step`), never inside one streamer job: a region is ≈ 15–25 ms of work
 * in all (§3.1 fact-check), done in ≤ 1 ms slices by GrassField.update.
 *
 * W12-SB (WORLD_EDITOR §4.4, seam S-GRASS, D22, D55): a region may carry the editor's grass / flower mask
 * (`GrassBakeSource.mask`, the manifest-listed `grass/<x>_<z>.png`): 192 × 192 RGBA8 in the bake's own texel order,
 * R = density × (R / 128) (×0 … ×2), G = flowers 0..1, B = flower kind (0: the flowers stay the meadow noise's), A =
 * touched (0: the texel is the plain bake). The density factor applies after the edge feather and the slope fade and
 * before the water, sea and object-floor cuts; a painted kind sets the meadow to G × the density. A mask of R = 128
 * and B = 0 everywhere, or none, is today's bake byte for byte. Low never bakes (retail scatter): it ignores masks.
 */
import { GRID, terrainHeightAt } from '../../../convert/src/world/format.ts'
import type { TileTexture, WorldRegion } from '../../../convert/src/world/manifest.ts'
import type { RegionData } from '../regions.ts'
import { GRASS_PALETTE_SLOTS } from './shaders.ts'

/** A region's side (m) and its bake's texels per side (1 m). */
export const GRASS_REGION_M = 192
/** 2 m terrain cells per region side. */
const CELLS = 96
/** Grass weight of a grassy-dirt tile (`grass` or `weed` in a Dirt tile's name). */
export const GRASSY_DIRT_WEIGHT = 0.45
/** Tile names drawn as pavement, rock or water whatever their type (scatter.ts BARE_NAME). */
const BARE_NAME = /marble|stone|rock|road|brick|pave|salt|water|ruin|dest/i
/** Of those, the hard ground the edge feather never spills grass onto (sand, salt and dune sand are soft). */
const HARD_NAME = /marble|stone|rock|road|brick|pave|water/i
/** Tile types that are hard whatever the name (GL-1: the swamp's c_dust_swmp_05 / _06 are typed Water). */
const HARD_TYPE = /^(water|stone)$/i
/** Slope fade: full grass at normal y ≥ 0.80 (36.9°), none below 0.70 (45.6°). */
export const GRASS_SLOPE = [0.7, 0.8] as const
/** No grass within this height above a water plane (m). */
export const GRASS_WATER_MARGIN_M = 0.1

type Rgb = readonly [number, number, number]

/** The grass weight of a terrain tile (GL-C's `grass.weight` when the export has it, else the built-in rule). */
export function tileGrassWeight(tile: Pick<TileTexture, 'typeName' | 'source' | 'grass'> & { file?: string }): number {
  const name = `${tile.source ?? ''} ${tile.file ?? ''}`
  if (tile.grass && Number.isFinite(tile.grass.weight)) return Math.min(1, Math.max(0, tile.grass.weight))
  if (BARE_NAME.test(name)) return 0
  if (tile.typeName === 'Grass' || tile.typeName === 'LongGrass' || tile.typeName === 'Forest') return 1
  return /grass|weed/i.test(name) ? GRASSY_DIRT_WEIGHT : 0
}

// ---- palettes --------------------------------------------------------------------------------------------------------

/**
 * The prototype's hand-tuned palettes (display sRGB 0..1, base and tip; `work/tmp/grass-life/lab/grass-lab.ts`), matched
 * by tile file name: the fallback for an export without GL-C's per-tile palettes.
 */
export const BUILTIN_GRASS_PALETTES: ReadonlyArray<{ match: RegExp; base: Rgb; tip: Rgb }> = [
  { match: /c_grass_hmfld_0[1245]/i, base: [0.13, 0.22, 0.05], tip: [0.42, 0.52, 0.17] },
  { match: /c_grass_fld_0[358]|c_grass_fld_11/i, base: [0.16, 0.25, 0.05], tip: [0.50, 0.57, 0.19] },
  { match: /c_grass_fld_04|c_grass_hmfld_03/i, base: [0.20, 0.21, 0.07], tip: [0.50, 0.52, 0.22] },
  { match: /c_grass_fld_(09|10)/i, base: [0.26, 0.19, 0.08], tip: [0.62, 0.54, 0.32] },
  { match: /grass|weed/i, base: [0.18, 0.22, 0.07], tip: [0.46, 0.48, 0.20] },
  { match: /.*/, base: [0.15, 0.23, 0.05], tip: [0.46, 0.54, 0.18] },
]

/**
 * GL-C's palettes are the tile image's dark and light luma deciles; the prototype's approved look was tuned by hand
 * from them (c_grass_hmfld_01: deciles (20, 35, 8) / (87, 111, 39) → the table's (0.13, 0.22, 0.05) / (0.42, 0.52,
 * 0.17)). These gains carry a converter decile onto the prototype's scale before the painterly adjustment.
 */
export const GRASS_DECILE_GAIN = { base: 1.62, tip: 1.2 } as const
/** The prototype's painterly adjustment: brightness 0.76 of the palette, saturation 0.95, base 30 % toward the tip. */
export const GRASS_PALETTE_BRIGHTNESS = 0.76
export const GRASS_PALETTE_SATURATION = 0.95

function adjust(c: Rgb, k: number): [number, number, number] {
  const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
  return [0, 1, 2].map(i => Math.min(1, Math.max(0, (l + (c[i]! - l) * GRASS_PALETTE_SATURATION) * k))) as [number, number, number]
}

/** The shader's (base, tip) of a palette (display sRGB 0..1). */
export function shaderPalette(base: Rgb, tip: Rgb): { base: [number, number, number]; tip: [number, number, number] } {
  const mixed: Rgb = [base[0] * 0.7 + tip[0] * 0.3, base[1] * 0.7 + tip[1] * 0.3, base[2] * 0.7 + tip[2] * 0.3]
  return { base: adjust(mixed, GRASS_PALETTE_BRIGHTNESS), tip: adjust(tip, GRASS_PALETTE_BRIGHTNESS) }
}

/** What the bake and the material need from the manifest's tiles. */
export interface GrassTileTable {
  /** tile id → grass weight (absent: 0). */
  readonly weight: ReadonlyMap<number, number>
  /** tile id → palette slot (grass tiles only). */
  readonly slot: ReadonlyMap<number, number>
  /** grPal: GRASS_PALETTE_SLOTS × (base, tip) as vec4 (rgb, 1). */
  readonly palette: number[]
  /** Slots in use. */
  readonly slots: number
  /** Tile ids of hard bare ground (paving, stone, rock, roads, water: `HARD_NAME`, or typed Water / Stone): the edge feather never spills onto them. */
  readonly hard: ReadonlySet<number>
}

/**
 * The tile table: weights, and one palette slot per distinct grass palette (GL-C's per-tile palette through
 * GRASS_DECILE_GAIN, else the built-in table's by name), at most GRASS_PALETTE_SLOTS; beyond that a tile takes the slot
 * with the nearest tip colour.
 */
export function grassTileTable(tiles: readonly (Pick<TileTexture, 'id' | 'typeName' | 'source' | 'grass'> & { file?: string })[]): GrassTileTable {
  const weight = new Map<number, number>()
  const slot = new Map<number, number>()
  const hard = new Set<number>()
  const pals: Array<{ base: [number, number, number]; tip: [number, number, number] }> = []
  for (const t of [...tiles].sort((a, b) => a.id - b.id)) {
    const w = tileGrassWeight(t)
    weight.set(t.id, w)
    if ((w <= 0 && HARD_NAME.test(`${t.source ?? ''} ${t.file ?? ''}`)) || HARD_TYPE.test(t.typeName ?? '')) hard.add(t.id)
    if (w <= 0) continue
    let pal
    if (t.grass) {
      const g = GRASS_DECILE_GAIN
      pal = shaderPalette(t.grass.base.map(v => v * g.base) as unknown as Rgb, t.grass.tip.map(v => v * g.tip) as unknown as Rgb)
    } else {
      const b = BUILTIN_GRASS_PALETTES.find(p => p.match.test(t.source))!
      pal = shaderPalette(b.base, b.tip)
    }
    const same = pals.findIndex(p => p.base.every((v, i) => Math.abs(v - pal.base[i]!) < 1e-4) && p.tip.every((v, i) => Math.abs(v - pal.tip[i]!) < 1e-4))
    if (same >= 0) slot.set(t.id, same)
    else if (pals.length < GRASS_PALETTE_SLOTS) {
      slot.set(t.id, pals.length)
      pals.push(pal)
    } else {
      let best = 0, bestD = Infinity
      pals.forEach((p, i) => {
        const d = (p.tip[0] - pal.tip[0]) ** 2 + (p.tip[1] - pal.tip[1]) ** 2 + (p.tip[2] - pal.tip[2]) ** 2
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      slot.set(t.id, best)
    }
  }
  if (!pals.length) pals.push(shaderPalette(BUILTIN_GRASS_PALETTES.at(-1)!.base, BUILTIN_GRASS_PALETTES.at(-1)!.tip))
  const palette: number[] = []
  for (let i = 0; i < GRASS_PALETTE_SLOTS; i++) {
    const p = pals[i] ?? pals[0]!
    palette.push(...p.base, 1, ...p.tip, 1)
  }
  return { weight, slot, palette, slots: pals.length, hard }
}

// ---- the region bake ---------------------------------------------------------------------------------------------------

/** The terrain of one region as the bake reads it (RegionData or a test fixture). */
export interface GrassBakeSource {
  id: number
  /** The region's south-west corner (glTF m; multiples of 192, y 0). */
  origin: readonly [number, number, number]
  /** 97 × 97 heights (m), index gz * 97 + gx. */
  heights: ArrayLike<number>
  /** 97 × 97 × 4 normals × 127 (x, y, z, 0), or null. */
  normals: ArrayLike<number> | null
  /** layerCount × 96 × 96 × 4 layer bytes (format.ts). */
  layers: ArrayLike<number>
  layerCount: number
  /** 36 blocks (bz * 6 + bx) with their water planes. */
  blocks: WorldRegion['blocks']
  /** W12-SB: the editor's grass / flower mask (192 × 192 × 4, the bake's texel order; see the header), or none. */
  mask?: ArrayLike<number> | null
}

/** The mask's R that leaves the density as it is (R / 128 = 1). */
export const GRASS_MASK_ONE = 128

export function grassBakeSource(data: RegionData, mask: ArrayLike<number> | null = null): GrassBakeSource {
  const t = data.terrain
  const src: GrassBakeSource = { id: data.region.id, origin: data.region.origin, heights: t.heights, normals: t.normals, layers: t.layers, layerCount: t.layerCount, blocks: data.region.blocks }
  if (mask) src.mask = mask
  return src
}

/** True when an object floor covers the ground at glTF (x, z) with ground height y (ScatterHost.occupied). */
export type GrassOccupied = (x: number, z: number, groundY: number) => boolean

/**
 * The coast's sea as the bake reads it (World.coast, COAST S-LIFE): no grass under the sea, and a ragged shore ramp
 * above it (`grassSeaFade`). Retail grass words survive under the new sea wherever the coast paint leaves the ground
 * alone (the S1 strip at X1: grass down to 0.3 m under the sea level). The field loads after the first regions may have
 * baked, so GrassField clears the sea out of those afterwards (`clearSea`).
 */
export interface GrassSea {
  readonly seaLevelM: number
  seaAt(x: number, z: number): boolean
  /**
   * The field's bilinear sample (ocean/field.ts CoastField): `sea` 0..1 and `distanceM`, the distance to the shoreline
   * (the field's is signed, − on land; the ramp reads its magnitude on land, clamped at ±63.75 m by the field). Without
   * it the shore ramp tests `seaAt` at the texel and SEA_NEAR_M around it.
   */
  sample?(x: number, z: number, out?: { sea: number; distanceM: number; elevationM: number; join: number }): { sea: number; distanceM: number }
}

/** The shore ramp's height (m): the grass thins from its start to full over this much ground above the sea. */
export const GRASS_SEA_RAMP_M = 0.45
/** The ramp's start lies GRASS_WATER_MARGIN_M above the sea level plus up to this much of value noise (30 m and 7 m). */
export const GRASS_SEA_JITTER_M = 0.35
/** The shore ramp applies in full within half this distance of the sea and fades out by 1.5 × it (m; ± a third). */
const SEA_NEAR_M = 16
const seaSample = { sea: 0, distanceM: 0, elevationM: 0, join: 0 }

/** Options of a region bake. */
export interface GrassBakeOptions {
  occupied?: GrassOccupied | null
  /** The coast's sea as it is now (null: none, or not loaded yet); asked once per row. */
  sea?: (() => GrassSea | null) | null
  /** The loaded neighbour (dx east, dz north, each −1..1) whose cells the edge feather reads past the border, or null. */
  neighbours?: ((dx: number, dz: number) => GrassBakeSource | null) | null
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77) >>> 0
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}

function vnoise(x: number, y: number): number {
  const i = Math.floor(x), j = Math.floor(y)
  const fx = x - i, fy = y - j
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy)
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/** The meadow mask at glTF (x, z) for grass density `w` (§4.1: drifts of 22 m and 6 m). */
export function meadowAt(x: number, z: number, w: number): number {
  return smoothstep(0.5, 0.64, vnoise(x * 0.045, z * 0.045) * 0.7 + vnoise(x * 0.17 + 9, z * 0.17 + 4) * 0.3) * w
}

/**
 * The edge feather (look items 1 and 7 of the X1 review, `work/tmp/w10r/look-notes.md`): a painted grass edge (sand,
 * road, rock, the coast paint's cut) never ends as a straight wall of blades, and two grass palettes never meet in a
 * line along the tile border. Near any change of the grass weight or the palette slot (the region's "busy" cells):
 * - **Warp:** the texel samples the painted weight at a point moved by world-space value noise (three octaves, 33 m,
 *   11 m and 3.7 m, up to `GRASS_EDGE_WARP_M` per axis; typically half that), so the edge meanders around the painted
 *   line, both ways, in bays and tongues of a few metres to a few tens of metres.
 * - **Thinning:** `EDGE_TAPS` taps at random points (the texel's own hash) of a square of half-width
 *   `GRASS_EDGE_FEATHER_M` around the warped point; their mean drop below the point's own weight, relative to the
 *   lowest tap and × 2, thins the density toward that lowest tap. Along a straight edge the density rises from 0 at the
 *   (warped) edge to full one feather width inside, broken into tufts by the per-texel taps; a lower but grassy
 *   neighbour (grassy dirt next to grass) is a ramp down to its own density, never a bald strip.
 * - **Hard ground:** next to paving, stone roads, rock and water (`GrassTileTable.hard`) the warp and the taps reach only
 *   `GRASS_HARD_SHARE` as far (a crisp, slightly ragged verge, not a wide bald margin), and the density on a hard cell
 *   stays at or below the painted ramp (no grass spills onto a road). Onto soft bare ground (sand, dust, earth) the warp
 *   carries thin tongues and tufts past the painted line.
 * - **Palette** (item 7): the slot is the one of the grass cell at a random point within `GRASS_PALETTE_BLEND_M` of the
 *   warped point, so two palettes interleave over ≈ twice that width, in drifts that follow the warp.
 * Cells with no change within the reach (`GRASS_BUSY_REACH`) keep the plain bake: the bilinear weight and the cell's
 * slot. The noise is world-space and the cells past the region's edge come from the loaded
 * neighbours (RegionGrassBake), so the feather runs on across region borders without a seam.
 */
export const GRASS_EDGE_WARP_M = 14
export const GRASS_EDGE_FEATHER_M = 7
export const GRASS_PALETTE_BLEND_M = 6
const EDGE_TAPS = 6
/** Relative-drop gain: half the taps fully below the point (a straight edge) = no grass. */
const EDGE_GAIN = 2
/** The warp's octaves: frequency (1/m) and share of GRASS_EDGE_WARP_M (the shares sum to 1). */
const WARP_OCTAVES = [[0.03, 0.6], [0.09, 0.3], [0.27, 0.1]] as const
/** Cells (2 m) a change reaches: the warp + the farther of the feather and the blend, + one cell of bilinear. */
export const GRASS_BUSY_REACH = Math.ceil((GRASS_EDGE_WARP_M + Math.max(GRASS_EDGE_FEATHER_M, GRASS_PALETTE_BLEND_M)) / 2) + 1
/** No grass layer in the cell. */
const NO_SLOT = 255
/** How far a warp or a feather tap reaches onto hard ground (roads, paving, rock), as a share: crisp verges there. */
export const GRASS_HARD_SHARE = 0.3
/** The extended cell grid's side: the region's 96 cells inside a margin of GRASS_BUSY_REACH on every side. */
const EXT = CELLS + 2 * GRASS_BUSY_REACH

/** The warp at glTF (x, z), written into `out` (m, east and glTF +z). */
function edgeWarp(x: number, z: number, out: Float64Array): void {
  let wx = 0, wz = 0
  for (let k = 0; k < WARP_OCTAVES.length; k++) {
    const [f, share] = WARP_OCTAVES[k]!
    const a = share * 2 * GRASS_EDGE_WARP_M
    wx += (vnoise(x * f + 3.1 + k * 41.3, z * f + 7.7 - k * 13.9) - 0.5) * a
    wz += (vnoise(x * f + 17.9 - k * 29.1, z * f + 23.3 + k * 37.7) - 0.5) * a
  }
  out[0] = wx
  out[1] = wz
}

const clampCell = (v: number) => (v < 0 ? 0 : v > CELLS - 1 ? CELLS - 1 : v)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** The bit of a neighbour (dx east, dz north, each −1..1) in `RegionGrassBake.neighbourMask`. */
export const grassNeighbourBit = (dx: number, dz: number): number => 1 << ((dz + 1) * 3 + (dx + 1))

/**
 * One region's bake, in row slices. `data` (192 × 192 RGBA8, row j = the metre j north of the south edge, column i =
 * the metre i east) is filled row by row; A starts at 255 and is left to the lightmap (setLight).
 *
 * The edge feather reads the painted cells up to GRASS_BUSY_REACH cells past the region's edge: from the neighbours
 * (`GrassBakeOptions.neighbours`) where they are loaded, else the region's own edge cells extended. Both sides of a
 * border then compute the same texels from the same cells and the same world-space noise, so no feather line follows
 * a region border; GrassField bakes a region again when a neighbour it lacked arrives (`neighbourMask`).
 */
export class RegionGrassBake {
  readonly data = new Uint8Array(GRASS_REGION_M * GRASS_REGION_M * 4)
  /** Rows done (0..192). */
  row = 0
  /** Texels with grass (density > 0). */
  grassy = 0
  /** The lowest ground (m) the bake put grass on (Infinity: none): GrassField's test for a sea that arrives late. */
  minGrassY = Infinity
  /** The neighbours the bake read (grassNeighbourBit), set when its first slice runs; −1 before. */
  neighbourMask = -1
  private readonly occupied: GrassOccupied | null
  private readonly sea: (() => GrassSea | null) | null
  private readonly neighbours: ((dx: number, dz: number) => GrassBakeSource | null) | null
  /**
   * Per 2 m cell of the extended grid (EXT × EXT, the region's 96 × 96 inside a margin of GRASS_BUSY_REACH): the four
   * composited corner weights (format.ts corner order). Dropped when done.
   */
  private corner: Float32Array | null = null
  /** Per extended cell: the palette slot of its last grass layer (NO_SLOT: none). */
  private slotOf: Uint8Array | null = null
  /** Per extended cell: 1 when a corner shows a hard bare tile (`GrassTileTable.hard`). */
  private hard: Uint8Array | null = null
  /** Per own cell (cz × 96 + cx): 1 when a change of weight or slot lies within GRASS_BUSY_REACH cells. */
  private busy: Uint8Array | null = null
  /** Per vertex (97 × 97): the slope fade. */
  private slope: Float32Array | null = null
  private readonly warp = new Float64Array(2)
  /** The sea this region was tested against, and whether any of it lies near (null: not tested yet). */
  private seaTested: GrassSea | null = null
  private seaNear = false

  constructor(readonly src: GrassBakeSource, private readonly table: GrassTileTable, opts: GrassOccupied | GrassBakeOptions | null = null) {
    const o: GrassBakeOptions = typeof opts === 'function' ? { occupied: opts } : (opts ?? {})
    this.occupied = o.occupied ?? null
    this.sea = o.sea ?? null
    this.neighbours = o.neighbours ?? null
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255
  }

  get done(): boolean {
    return this.row >= GRASS_REGION_M
  }

  /** Bakes rows until `stop()` says so (asked after each row) or the region is done; true when done. */
  step(stop: () => boolean = () => false): boolean {
    if (!this.done && !this.corner) this.prepare()
    while (this.row < GRASS_REGION_M) {
      this.bakeRow(this.row++)
      if (stop()) break
    }
    if (this.done) this.corner = this.slotOf = this.busy = this.hard = this.slope = null
    return this.done
  }

  /** The baked light (the region's lightmap luminance, 192 × 192 × 4 RGBA, row 0 = south) into A. */
  setLight(rgba: ArrayLike<number>, width: number, height: number): void {
    const n = GRASS_REGION_M
    for (let j = 0; j < n; j++) {
      const sj = Math.min(height - 1, Math.floor(((j + 0.5) / n) * height))
      for (let i = 0; i < n; i++) {
        const si = Math.min(width - 1, Math.floor(((i + 0.5) / n) * width))
        const s = (sj * width + si) * 4
        this.data[(j * n + i) * 4 + 3] = Math.round(0.3 * rgba[s]! + 0.59 * rgba[s + 1]! + 0.11 * rgba[s + 2]!)
      }
    }
  }

  /** The baked light (A) of an earlier bake of the same region (a bake again keeps its light). */
  copyLight(from: Uint8Array): void {
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = from[i]!
  }

  /**
   * Applies the coast's sea to the rows baked so far (the coast field arrived after them): density and meadow × the
   * shore ramp (`grassSeaFade`), the slot cleared where nothing is left. True when a texel changed.
   */
  clearSea(sea: GrassSea): boolean {
    if (this.minGrassY >= sea.seaLevelM + GRASS_WATER_MARGIN_M + GRASS_SEA_JITTER_M + GRASS_SEA_RAMP_M) return false
    if (!this.nearSea(sea)) return false
    const n = GRASS_REGION_M
    const [ox, , oz] = this.src.origin
    let changed = false
    for (let j = 0; j < this.row; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 4
        if (!this.data[o]) continue
        const y = terrainHeightAt(this.src.heights, (i + 0.5) * 10, (j + 0.5) * 10)
        const f = grassSeaFade(sea, ox + i + 0.5, oz - (j + 0.5), y)
        if (f >= 1) continue
        changed = true
        const r = Math.round(this.data[o]! * f)
        if (!r) {
          this.data[o] = this.data[o + 1] = this.data[o + 2] = 0
          this.grassy--
          continue
        }
        this.data[o] = r
        this.data[o + 1] = Math.round(this.data[o + 1]! * f)
      }
    }
    return changed
  }

  /** One cell's composite (TERRAIN §2.3 order) of `src` into extended cell `e`. */
  private composite(src: GrassBakeSource, cx: number, cz: number, e: number): void {
    const { layers, layerCount } = src
    const { weight, slot, hard: hardTiles } = this.table
    const corner = this.corner!
    let w0 = 0, w1 = 0, w2 = 0, w3 = 0
    let h0 = false, h1 = false, h2 = false, h3 = false
    let s = NO_SLOT
    for (let k = 0; k < layerCount; k++) {
      const o = ((k * CELLS + cz) * CELLS + cx) * 4
      if (!layers[o + 3]) break
      const id = layers[o]! | ((layers[o + 1]! & 3) << 8)
      const g = weight.get(id) ?? 0
      const h = hardTiles.has(id)
      const mask = layers[o + 2]!
      if (mask & 1) {
        w0 = g
        h0 = h
      }
      if (mask & 2) {
        w1 = g
        h1 = h
      }
      if (mask & 4) {
        w2 = g
        h2 = h
      }
      if (mask & 8) {
        w3 = g
        h3 = h
      }
      if (g > 0) s = slot.get(id) ?? 0
    }
    const q = e * 4
    corner[q] = w0
    corner[q + 1] = w1
    corner[q + 2] = w2
    corner[q + 3] = w3
    this.slotOf![e] = s
    this.hard![e] = h0 || h1 || h2 || h3 ? 1 : 0
  }

  /**
   * Whether any of the coast's sea lies within the shore ramp's reach of this region (once per sea): the field on a
   * 16 m grid over the region and a margin. A region far inland (Jangan's grassland lies below the sea level) then
   * skips the per-texel shore test.
   */
  private nearSea(sea: GrassSea): boolean {
    if (this.seaTested === sea) return this.seaNear
    const [ox, , oz] = this.src.origin
    const step = 16, margin = SEA_NEAR_M * 2 + step
    let near = false
    for (let j = -margin; j <= GRASS_REGION_M + margin && !near; j += step) {
      for (let i = -margin; i <= GRASS_REGION_M + margin && !near; i += step) {
        const x = ox + i, z = oz - j
        if (sea.seaAt(x, z)) near = true
        else if (sea.sample && Math.abs(sea.sample(x, z, seaSample).distanceM) < margin) near = true
      }
    }
    this.seaTested = sea
    this.seaNear = near
    return near
  }

  /** The extended composite, the busy map and the per-vertex slope fade (once, before the first row). */
  private prepare(): void {
    const M = GRASS_BUSY_REACH
    const corner = (this.corner = new Float32Array(EXT * EXT * 4))
    const slotOf = (this.slotOf = new Uint8Array(EXT * EXT))
    this.hard = new Uint8Array(EXT * EXT)
    for (let cz = 0; cz < CELLS; cz++) for (let cx = 0; cx < CELLS; cx++) this.composite(this.src, cx, cz, (cz + M) * EXT + cx + M)
    // the margin: the neighbour's cells, else the region's own edge cell extended
    const near: Array<GrassBakeSource | null> = []
    let mask = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = dx || dz ? (this.neighbours?.(dx, dz) ?? null) : this.src
        near.push(n)
        if (n && (dx || dz)) mask |= grassNeighbourBit(dx, dz)
      }
    }
    this.neighbourMask = mask
    for (let ez = 0; ez < EXT; ez++) {
      const cz = ez - M
      const dz = cz < 0 ? -1 : cz >= CELLS ? 1 : 0
      for (let ex = 0; ex < EXT; ex++) {
        const cx = ex - M
        const dx = cx < 0 ? -1 : cx >= CELLS ? 1 : 0
        if (!dx && !dz) continue
        const e = ez * EXT + ex
        const n = near[(dz + 1) * 3 + dx + 1]
        if (n) this.composite(n, cx - dx * CELLS, cz - dz * CELLS, e)
        else {
          const own = (clampCell(cz) + M) * EXT + clampCell(cx) + M
          corner.copyWithin(e * 4, own * 4, own * 4 + 4)
          slotOf[e] = slotOf[own]!
          this.hard[e] = this.hard[own]!
        }
      }
    }
    // a change: a cell whose corners differ, or whose weight or slot differs from its east or north neighbour
    const change = new Uint8Array(EXT * EXT)
    const differs = (a: number, b: number) =>
      corner[a * 4] !== corner[b * 4] || (slotOf[a] !== slotOf[b] && slotOf[a] !== NO_SLOT && slotOf[b] !== NO_SLOT)
    for (let ez = 0; ez < EXT; ez++) {
      for (let ex = 0; ex < EXT; ex++) {
        const e = ez * EXT + ex
        const q = e * 4
        if (corner[q] !== corner[q + 1] || corner[q] !== corner[q + 2] || corner[q] !== corner[q + 3]) change[e] = 1
        if (ex + 1 < EXT && differs(e, e + 1)) change[e] = change[e + 1] = 1
        if (ez + 1 < EXT && differs(e, e + EXT)) change[e] = change[e + EXT] = 1
      }
    }
    // the own cells within M cells of a change (separable: along x over the extended rows, then along z)
    const across = new Uint8Array(EXT * CELLS)
    for (let ez = 0; ez < EXT; ez++) {
      for (let cx = 0; cx < CELLS; cx++) {
        let v = 0
        for (let ex = cx, end = cx + 2 * M; ex <= end && !v; ex++) v = change[ez * EXT + ex]!
        across[ez * CELLS + cx] = v
      }
    }
    const busy = (this.busy = new Uint8Array(CELLS * CELLS))
    for (let cz = 0; cz < CELLS; cz++) {
      for (let cx = 0; cx < CELLS; cx++) {
        let v = 0
        for (let ez = cz, end = cz + 2 * M; ez <= end && !v; ez++) v = across[ez * CELLS + cx]!
        busy[cz * CELLS + cx] = v
      }
    }
    const { normals } = this.src
    const slope = (this.slope = new Float32Array(GRID * GRID))
    for (let v = 0; v < GRID * GRID; v++) {
      let ny = 1
      if (normals) {
        const a = normals[v * 4]!, b = normals[v * 4 + 1]!, c = normals[v * 4 + 2]!
        const l = Math.hypot(a, b, c)
        ny = l > 0 ? b / l : 1
      }
      slope[v] = smoothstep(GRASS_SLOPE[0], GRASS_SLOPE[1], ny)
    }
  }

  /** The extended cell at region-local metres (lx east, lz north), clamped to the extended grid. */
  private extAt(lx: number, lz: number): number {
    const ex = Math.floor(lx / 2) + GRASS_BUSY_REACH, ez = Math.floor(lz / 2) + GRASS_BUSY_REACH
    return (ez < 0 ? 0 : ez > EXT - 1 ? EXT - 1 : ez) * EXT + (ex < 0 ? 0 : ex > EXT - 1 ? EXT - 1 : ex)
  }

  /** The painted weight at region-local metres, bilinear in its cell (the extended grid's edge cells extend). */
  private weightAt(lx: number, lz: number): number {
    const gx = lx / 2 + GRASS_BUSY_REACH, gz = lz / 2 + GRASS_BUSY_REACH
    let ex = Math.floor(gx), ez = Math.floor(gz)
    let fx = gx - ex, fz = gz - ez
    if (ex < 0) {
      ex = 0
      fx = 0
    } else if (ex > EXT - 1) {
      ex = EXT - 1
      fx = 1
    }
    if (ez < 0) {
      ez = 0
      fz = 0
    } else if (ez > EXT - 1) {
      ez = EXT - 1
      fz = 1
    }
    const k = this.corner!
    const q = (ez * EXT + ex) * 4
    return (k[q]! * (1 - fx) + k[q + 1]! * fx) * (1 - fz) + (k[q + 2]! * (1 - fx) + k[q + 3]! * fx) * fz
  }

  private bakeRow(j: number): void {
    const n = GRASS_REGION_M
    const cz = j >> 1
    const lz = j + 0.5
    const [ox, , oz] = this.src.origin
    const z = oz - lz
    const out = this.data
    const blocks = this.src.blocks
    const bz = Math.min(5, Math.floor(lz / 32))
    const busy = this.busy!, slotOf = this.slotOf!, hard = this.hard!, slope = this.slope!
    const mask = this.src.mask && this.src.mask.length >= n * n * 4 ? this.src.mask : null
    const seaNow = this.sea?.() ?? null
    const sea = seaNow && this.nearSea(seaNow) ? seaNow : null
    const gz = lz / 2
    const vz = Math.min(GRID - 2, Math.floor(gz)), tz = gz - vz
    const zi = Math.floor(z)
    const warp = this.warp
    const F = GRASS_EDGE_FEATHER_M
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 4
      const lx = i + 0.5
      const x = ox + lx
      // the slope fade, bilinear between the vertices
      const gx = lx / 2
      const vx = Math.min(GRID - 2, Math.floor(gx)), tx = gx - vx
      const s0 = vz * GRID + vx
      const sf = (slope[s0]! * (1 - tx) + slope[s0 + 1]! * tx) * (1 - tz) + (slope[s0 + GRID]! * (1 - tx) + slope[s0 + GRID + 1]! * tx) * tz
      const own = this.extAt(lx, lz)
      let w = 0
      let slot = slotOf[own]!
      if (sf <= 0) w = 0
      else if (!busy[cz * CELLS + (i >> 1)]) w = this.weightAt(lx, lz)
      else {
        // the feathered path (GRASS_EDGE_WARP_M): a warp landing on hard ground shrinks to GRASS_HARD_SHARE
        edgeWarp(x, z, warp)
        let px = lx + warp[0]!, pz = lz - warp[1]!
        if (hard[this.extAt(px, pz)]) {
          px = lx + warp[0]! * GRASS_HARD_SHARE
          pz = lz - warp[1]! * GRASS_HARD_SHARE
        }
        const w0 = this.weightAt(px, pz)
        if (w0 > 0) {
          const xi = Math.floor(x)
          let drop = 0
          let low = w0
          for (let k = 0; k < EDGE_TAPS; k++) {
            const tx = (hash2(xi * 7 + k, zi * 13 - k) - 0.5) * 2 * F
            const tz = (hash2(zi * 11 + k * 31, xi * 5 + k * 17) - 0.5) * 2 * F
            let wk = this.weightAt(px + tx, pz + tz)
            // a tap on hard ground (a road, paving, rock) reaches only GRASS_HARD_SHARE as far
            if (wk < w0 && hard[this.extAt(px + tx, pz + tz)]) wk = this.weightAt(px + tx * GRASS_HARD_SHARE, pz + tz * GRASS_HARD_SHARE)
            if (wk < w0) {
              drop += w0 - wk
              if (wk < low) low = wk
            }
          }
          // thin from w0 toward the lowest tap, never below it (grassy dirt next to grass: a ramp, no bald strip)
          const t = low < w0 ? clamp01(1 - (EDGE_GAIN * drop) / (EDGE_TAPS * (w0 - low))) : 1
          w = low + (w0 - low) * t * t * (3 - 2 * t)
          if (hard[own]) w = Math.min(w, this.weightAt(lx, lz))
          if (w > 0) {
            const jx = (hash2(xi * 3 + 101, zi * 3 - 7) - 0.5) * 2 * GRASS_PALETTE_BLEND_M
            const jz = (hash2(zi * 3 + 211, xi * 3 + 5) - 0.5) * 2 * GRASS_PALETTE_BLEND_M
            const s1 = slotOf[this.extAt(px + jx, pz + jz)]!
            const s2 = slotOf[this.extAt(px, pz)]!
            slot = s1 !== NO_SLOT ? s1 : s2 !== NO_SLOT ? s2 : slot
          }
        }
      }
      w *= sf
      // W12-SB: the editor's density paint (A = touched; R / 128)
      const painted = mask !== null && mask[o + 3]! > 0
      if (painted && w > 0) w *= mask[o]! / GRASS_MASK_ONE
      if (w > 0) {
        const y = terrainHeightAt(this.src.heights, lx * 10, lz * 10)
        const water = blocks[bz * 6 + Math.min(5, Math.floor(lx / 32))]?.water
        if (water && y < water.heightM + GRASS_WATER_MARGIN_M) w = 0
        else {
          if (sea) w *= grassSeaFade(sea, x, z, y)
          if (w > 0 && this.occupied?.(x, z, y)) w = 0
        }
        if (w > 0 && y < this.minGrassY) this.minGrassY = y
      }
      const r = w > 0 && slot !== NO_SLOT ? Math.round(Math.min(1, w) * 255) : 0
      if (!r) {
        out[o] = out[o + 1] = out[o + 2] = 0
        continue
      }
      out[o] = r
      // a painted flower kind sets the meadow amount (G); otherwise the meadow noise's drifts
      out[o + 1] = painted && mask[o + 2]! > 0 ? Math.round((mask[o + 1]! / 255) * Math.min(1, w) * 255) : Math.round(meadowAt(x, z, Math.min(1, w)) * 255)
      out[o + 2] = slot
      this.grassy++
    }
  }
}

/**
 * The grass factor (0..1) at glTF (x, z) with ground height y next to the coast's sea: 0 below the ramp's start
 * (the sea level + GRASS_WATER_MARGIN_M + up to GRASS_SEA_JITTER_M of noise), rising over GRASS_SEA_RAMP_M of height;
 * the ramp fades out 8 to 24 m (± a third, noise) from the sea (the field's shoreline distance), so an inland basin
 * below the sea level keeps its grass (Jangan lies below it). On a flat beach the ramp is metres wide and meanders
 * with the noise, on a steep bank it is a clean cut.
 */
export function grassSeaFade(sea: GrassSea, x: number, z: number, y: number): number {
  const lo = sea.seaLevelM + GRASS_WATER_MARGIN_M
  if (y >= lo + GRASS_SEA_JITTER_M + GRASS_SEA_RAMP_M) return 1
  let near: number
  if (sea.sample) {
    const s = sea.sample(x, z, seaSample)
    // the reach meanders too (± a third, 14 m noise), so the fringe never runs parallel to the shoreline
    const k = 0.67 + 0.67 * vnoise(x * 0.04 + 2.1, z * 0.04 + 8.3)
    near = s.sea >= 0.5 ? 1 : 1 - smoothstep(SEA_NEAR_M * 0.5 * k, SEA_NEAR_M * 1.5 * k, Math.abs(s.distanceM))
  } else {
    const d = SEA_NEAR_M
    near = sea.seaAt(x, z) || sea.seaAt(x + d, z) || sea.seaAt(x - d, z) || sea.seaAt(x, z + d) || sea.seaAt(x, z - d) ? 1 : 0
  }
  if (near <= 0) return 1
  const a = lo + GRASS_SEA_JITTER_M * (0.7 * vnoise(x * 0.033 + 5.3, z * 0.033 + 1.7) + 0.3 * vnoise(x * 0.14 + 9.1, z * 0.14 + 4.4))
  // per-metre white noise breaks the ramp into tufts and gaps (the texel hash, as the edge feather's taps)
  const h = y <= a ? 0 : clamp01(smoothstep(a, a + GRASS_SEA_RAMP_M, y) + (hash2(Math.floor(x) * 3 + 17, Math.floor(z) * 5 - 3) - 0.5) * 0.6)
  return 1 - near * (1 - h)
}

/** A whole region's bake at once (tests, tools). */
export function bakeRegionGrass(src: GrassBakeSource, table: GrassTileTable, opts: GrassOccupied | GrassBakeOptions | null = null): Uint8Array {
  const b = new RegionGrassBake(src, table, opts)
  b.step()
  return b.data
}
