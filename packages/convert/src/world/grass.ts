/**
 * The grass-palette pass (docs/GRASS_LIFE.md §3.2, §3.5; lane GL-C owns this file): per terrain tile, the new grass's
 * weight (0 on bare tiles: sand, road, rock) and the base / tip palette from the tile image's dark and light deciles
 * -> manifest `tiles[].grass`. ./passes.ts applies the returned entries.
 *
 * - **Weight** (§3.2): 1 for tiles typed Grass, LongGrass or Forest; `GRASSY_DIRT_WEIGHT` (0.45) for any other tile
 *   with `grass` or `weed` in its name (the grassy dirt, e.g. `wc_grass02_01`); 0 for everything else and for any
 *   pavement, rock or water name whatever its type (`BARE_NAME`, the retail scatter's list; `alex_stone02` is typed
 *   Grass). This is the renderer's built-in rule (world-render `grass/bake.ts` `tileGrassWeight`, which prefers this
 *   field when present); the converter does not import the renderer, so grass-palette.test.ts keeps the two equal.
 *   Every tile gets an entry, bare ones with weight 0, so the runtime (the field and the wildlife's landing spots)
 *   reads one rule from the manifest.
 * - **Palette** (§3.5): `base` = the mean colour of the darkest 10 % of the tile image's pixels by Rec. 601 luma,
 *   `tip` = the mean of the lightest 10 %, display sRGB 0..1 [confirmed: `c_grass_hmfld_01` gives (20, 35, 8) /
 *   (87, 111, 39), the spec's re-run]. Ties at the cut take the pixels in scan order (a stable sort). The raw deciles
 *   go into the manifest; the renderer carries them onto the prototype's painterly scale (`GRASS_DECILE_GAIN`,
 *   `shaderPalette`), so a remastered tile re-derives its palette from the image the client actually loads
 *   (`tiles[].file`, written before this pass runs).
 *
 * A tile whose image cannot be read is a warning and gets no entry (the runtime then falls back to its built-in rule
 * and palettes). Runs after the coast's C9 edits and the static variants (./passes.ts).
 *
 * Perch points (§5.3, `perches.ts`) are not built: the default is the run-time rule from the models' bounds (GL-L);
 * the converter's ridge points are the fallback only if those put birds in the air.
 */
import { join } from 'node:path'
import sharp from 'sharp'
import type { TileGrass, TileTexture } from './manifest.ts'
import type { GrassPalettePass, WorldPassContext } from './passes.ts'

/** Grass weight of a grassy-dirt tile (`grass` or `weed` in the name of a tile not typed as grass). */
export const GRASSY_DIRT_WEIGHT = 0.45
/** Tile types that grow full grass. */
export const GRASS_TILE_TYPES: ReadonlySet<string> = new Set(['Grass', 'LongGrass', 'Forest'])
/** Tile names drawn as pavement, rock or water whatever their type (world-render scatter.ts / grass/bake.ts). */
export const BARE_NAME = /marble|stone|rock|road|brick|pave|salt|water|ruin|dest/i
/** The share of pixels in each decile. */
export const DECILE = 0.1
/** Rec. 601 luma weights ×1000 (integer keys: 0..255000). */
const LUMA = [299, 587, 114] as const
/** Decimal places kept in the manifest (1e-4 ≪ one 8-bit step). */
const PLACES = 1e4

/** The grass weight of a terrain tile (0 bare .. 1 full grass), from its type and name. */
export function tileGrassWeight(tile: Pick<TileTexture, 'typeName' | 'source'> & { file?: string }): number {
  const name = `${tile.source ?? ''} ${tile.file ?? ''}`
  if (BARE_NAME.test(name)) return 0
  if (tile.typeName && GRASS_TILE_TYPES.has(tile.typeName)) return 1
  return /grass|weed/i.test(name) ? GRASSY_DIRT_WEIGHT : 0
}

type Rgb = [number, number, number]

/**
 * The dark and light luma deciles of an image: the mean colour (sRGB 0..1) of the `share` darkest and lightest pixels.
 * `pixels`: 8-bit interleaved samples with `channels` per pixel (3 or 4; alpha is ignored). O(n): a histogram over the
 * integer luma, then the pixels below the cut plus the first ones at the cut in scan order.
 */
export function lumaDeciles(pixels: Uint8Array, channels: number, share = DECILE): { dark: Rgb; light: Rgb } {
  if (channels < 3) throw new Error(`lumaDeciles: expected 3 or 4 channels, got ${channels}`)
  const n = Math.floor(pixels.length / channels)
  if (n === 0) throw new Error('lumaDeciles: empty image')
  const k = Math.max(1, Math.floor(n * share))
  const key = new Uint32Array(n)
  const hist = new Uint32Array(255001)
  for (let i = 0, o = 0; i < n; i++, o += channels) {
    const l = LUMA[0] * pixels[o]! + LUMA[1] * pixels[o + 1]! + LUMA[2] * pixels[o + 2]!
    key[i] = l
    hist[l]!++
  }
  // dark: every pixel with luma < lo, plus the first (k - below) at lo in scan order
  let lo = 0
  let below = 0
  while (below + hist[lo]! < k) below += hist[lo++]!
  // light: every pixel with luma > hi, plus the LAST (k - above) at hi in scan order (a stable descending sort's
  // tail is the ascending sort's tail: the last pixels of the tie)
  let hi = 255000
  let above = 0
  while (above + hist[hi]! < k) above += hist[hi--]!
  const dark = [0, 0, 0]
  const light = [0, 0, 0]
  let takeLo = k - below
  for (let i = 0, o = 0; i < n; i++, o += channels) {
    const l = key[i]!
    if (l < lo || (l === lo && takeLo > 0)) {
      if (l === lo) takeLo--
      dark[0]! += pixels[o]!
      dark[1]! += pixels[o + 1]!
      dark[2]! += pixels[o + 2]!
    }
  }
  let skipHi = hist[hi]! - (k - above)
  for (let i = 0, o = 0; i < n; i++, o += channels) {
    const l = key[i]!
    if (l > hi || (l === hi && skipHi-- <= 0)) {
      light[0]! += pixels[o]!
      light[1]! += pixels[o + 1]!
      light[2]! += pixels[o + 2]!
    }
  }
  const unit = (s: number[]): Rgb => s.map(v => Math.round((v / k / 255) * PLACES) / PLACES) as Rgb
  return { dark: unit(dark), light: unit(light) }
}

/** A tile's manifest `grass` entry from its decoded image. */
export function tileGrass(tile: Pick<TileTexture, 'typeName' | 'source'> & { file?: string }, pixels: Uint8Array, channels: number): TileGrass {
  const { dark, light } = lumaDeciles(pixels, channels)
  return { weight: tileGrassWeight(tile), base: dark, tip: light }
}

/** Decodes a tile image to 8-bit RGBA. */
async function readTile(file: string): Promise<{ pixels: Uint8Array; channels: number }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), channels: info.channels }
}

/** The pass: one entry per tile whose image (under ctx.outDir) decodes; the others are warnings. */
export const grassPalettePass: GrassPalettePass = async (ctx: WorldPassContext): Promise<Array<{ id: number; grass: TileGrass }>> => {
  const out: Array<{ id: number; grass: TileGrass }> = []
  const failed: string[] = []
  for (const t of ctx.tiles) {
    try {
      const { pixels, channels } = await readTile(join(ctx.outDir, t.file))
      out.push({ id: t.id, grass: tileGrass(t, pixels, channels) })
    } catch (e) {
      failed.push(`${t.file} (${(e as Error).message.split('\n')[0]})`)
    }
  }
  if (failed.length) {
    ctx.warnings.push(`grass palettes: ${failed.length} tile image(s) unreadable, left to the runtime's built-in rule: ` +
      `${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', ...' : ''}`)
  }
  const grassy = out.filter(e => e.grass.weight > 0).length
  ctx.log(`grass palettes: ${out.length} tile(s), ${grassy} with grass`)
  return out
}
