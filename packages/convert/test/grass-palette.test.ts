/**
 * GL-C (docs/GRASS_LIFE.md §3.2, §3.5, docs/WAVE_PLAN6.md §6.1): the converter's grass palettes, manifest
 * `tiles[].grass`.
 * - the deciles on fixture tiles worked out by hand: the mean of the 10 % darkest / lightest pixels by Rec. 601 luma,
 *   ties at the cut taken in scan order (equal to a stable sort on random images), alpha ignored;
 * - the weights: Grass / LongGrass / Forest 1, grassy dirt 0.45, bare names 0 whatever the type, everything else 0;
 *   equal to the renderer's built-in rule (world-render grass/bake.ts) on every name in the export and the fixtures;
 * - the pass: one entry per readable tile image under outDir, applied by runWorldPasses into a valid manifest; an
 *   unreadable image is one warning and no entry;
 * - on the jangan-fields export (skipped without it): c_grass_hmfld_01 gives the spec's (20, 35, 8) / (87, 111, 39);
 *   every tile gets an entry, grass tiles have a darker base than tip, and the sand, marble, stone and water tiles
 *   carry weight 0.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import { tileGrassWeight as rendererWeight } from '../../world-render/src/grass/bake.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { BARE_NAME, GRASSY_DIRT_WEIGHT, grassPalettePass, lumaDeciles, tileGrass, tileGrassWeight } from '../src/world/grass.ts'
import { validateWorldManifest, type TileTexture, type WorldManifest } from '../src/world/manifest.ts'
import { runWorldPasses, type WorldPassContext } from '../src/world/passes.ts'

const tile = (id: number, name: string, typeName: string | null): TileTexture =>
  ({ id, source: `${name}.ddj`, file: `tiles/${name}.png`, width: 4, height: 4, typeName, category: 'field' })

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

/** The reference: a stable sort by luma, then the means of the first and last k. */
function naive(px: Uint8Array, ch: number, share = 0.1) {
  const n = px.length / ch
  const idx = Array.from({ length: n }, (_, i) => i)
  const key = (i: number) => 299 * px[i * ch]! + 587 * px[i * ch + 1]! + 114 * px[i * ch + 2]!
  idx.sort((a, b) => key(a) - key(b))
  const k = Math.max(1, Math.floor(n * share))
  const mean = (s: number[]) => [0, 1, 2].map(c => s.reduce((a, i) => a + px[i * ch + c]!, 0) / k / 255)
  return { dark: mean(idx.slice(0, k)), light: mean(idx.slice(n - k)) }
}

const tmp: string[] = []
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

describe('lumaDeciles', () => {
  it('a 10 x 10 fixture: the darkest and lightest ten pixels, worked out by hand', () => {
    // 100 pixels: 10 black-ish greens (the dark decile), 80 mid greys, 10 bright yellows (the light decile)
    const px = new Uint8Array(100 * 3)
    for (let i = 0; i < 100; i++) {
      const c = i < 10 ? [10 + i, 30, 0] : i < 90 ? [120, 120, 120] : [200, 220, 40 + (i - 90)]
      px.set(c, i * 3)
    }
    const { dark, light } = lumaDeciles(px, 3)
    // dark: r = mean(10..19) = 14.5, g = 30, b = 0; light: r 200, g 220, b = mean(40..49) = 44.5
    expect(dark).toEqual([14.5 / 255, 30 / 255, 0].map(v => Math.round(v * 1e4) / 1e4))
    expect(light).toEqual([200 / 255, 220 / 255, 44.5 / 255].map(v => Math.round(v * 1e4) / 1e4))
  })

  it('ties at the cut take the pixels in scan order (a stable sort), and alpha is ignored', () => {
    // (0, 10, 0) and (4, 0, 41) have the same integer luma (5870); 10 pixels, so k = 1
    const A = [0, 10, 0], B = [4, 0, 41], W = [200, 200, 200], K = [0, 0, 0]
    const img = (...c: number[][]) => {
      const px = new Uint8Array(c.length * 4)
      c.forEach((v, i) => px.set([...v, (i * 37) & 0xff], i * 4))
      return px
    }
    const u = (c: number[]) => c.map(v => Math.round((v / 255) * 1e4) / 1e4)
    // the dark decile: the first of the tie
    expect(lumaDeciles(img(A, B, W, W, W, W, W, W, W, W), 4).dark).toEqual(u(A))
    expect(lumaDeciles(img(B, A, W, W, W, W, W, W, W, W), 4).dark).toEqual(u(B))
    // the light decile: the last of the tie (the tail of the ascending stable sort)
    expect(lumaDeciles(img(K, K, K, K, K, K, K, K, A, B), 4).light).toEqual(u(B))
    expect(lumaDeciles(img(K, K, K, K, K, K, K, K, B, A), 4).light).toEqual(u(A))
  })

  it('equals a stable sort on random images (3 and 4 channels, several sizes and shares)', () => {
    let seed = 12345
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) & 0xff
    for (const [n, ch, share] of [[37, 3, 0.1], [256, 4, 0.1], [1000, 4, 0.1], [999, 3, 0.25], [64 * 64, 4, 0.1]] as const) {
      const px = new Uint8Array(n * ch)
      // coarse values so luma ties are common
      for (let i = 0; i < px.length; i++) px[i] = (rnd() >> 5) * 32
      const got = lumaDeciles(px, ch, share)
      const want = naive(px, ch, share)
      for (const k of ['dark', 'light'] as const) {
        got[k].forEach((v, c) => expect(Math.abs(v - want[k][c]!)).toBeLessThan(6e-5))
      }
    }
  })

  it('refuses an empty or single-channel image', () => {
    expect(() => lumaDeciles(new Uint8Array(0), 4)).toThrow(/empty/)
    expect(() => lumaDeciles(new Uint8Array(4), 1)).toThrow(/channels/)
  })
})

// ---- weights ---------------------------------------------------------------------------------------------------------

const NAMES: Array<[string, string | null, number]> = [
  ['c_grass_fld_03', 'Grass', 1],
  ['c_grass_hmfld_01', 'Grass', 1],
  ['x_longgrass_01', 'LongGrass', 1],
  ['x_forest_floor', 'Forest', 1],
  ['wc_grass02_01', 'Dirt', GRASSY_DIRT_WEIGHT],
  ['oaho_grass_05', 'Dirt', GRASSY_DIRT_WEIGHT],
  ['x_weed_patch', 'Mud', GRASSY_DIRT_WEIGHT],
  ['pha_grass_01', null, GRASSY_DIRT_WEIGHT],
  ['c_dust_fld_01', 'Dirt', 0],
  ['asiaminor_sand_01', 'Sand', 0],
  ['c_dust_swmp_01', 'Mud', 0],
  // bare names win over the type
  ['alex_stone02', 'Grass', 0],
  ['c_marble_jang_08_1', 'Dirt', 0],
  ['oaho_water_01', 'Water', 0],
  ['x_grass_road_01', 'Grass', 0],
  ['ruin_takl_dest_05', 'Grass', 0],
  ['stormdesert_salt_01', 'Sand', 0],
  ['x_brick_grass', 'Grass', 0],
  ['x_rock_weed', 'Dirt', 0],
  ['x_pave_01', 'Stone', 0],
  ['x_untyped', null, 0],
]

describe('tileGrassWeight', () => {
  it('Grass / LongGrass / Forest 1, grassy dirt 0.45, bare names 0 whatever the type, the rest 0', () => {
    for (const [name, type, w] of NAMES) expect([name, tileGrassWeight(tile(1, name, type))]).toEqual([name, w])
    expect(GRASSY_DIRT_WEIGHT).toBe(0.45)
    expect(BARE_NAME.source).toBe('marble|stone|rock|road|brick|pave|salt|water|ruin|dest')
  })

  it('equals the renderer\'s built-in rule on every fixture name and every tile of the export', () => {
    const tiles = NAMES.map(([n, t], i) => tile(i, n, t))
    const exp = join(REPO_ROOT, 'work/out/world/jangan-fields/manifest.json')
    if (existsSync(exp)) tiles.push(...(JSON.parse(readFileSync(exp, 'utf8')) as WorldManifest).tiles.map(t => ({ ...t, grass: undefined })))
    for (const t of tiles) expect([t.source, tileGrassWeight(t)]).toEqual([t.source, rendererWeight(t)])
    // and the renderer honours the converter's field when present
    expect(rendererWeight({ ...tile(1, 'c_dust_fld_01', 'Dirt'), grass: { weight: 0.7, base: [0, 0, 0], tip: [0, 0, 0] } })).toBe(0.7)
  })
})

// ---- the pass --------------------------------------------------------------------------------------------------------

async function writePng(file: string, w: number, h: number, fill: (i: number) => [number, number, number, number]) {
  const data = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(fill(i), i * 4)
  mkdirSync(join(file, '..'), { recursive: true })
  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file)
}

describe('grassPalettePass', () => {
  it('one entry per readable tile, applied by runWorldPasses; an unreadable image is one warning and no entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sro-grass-'))
    tmp.push(dir)
    // a 10 x 10 grass tile: rows of increasing brightness (dark row 0, light row 9), and a sand tile of one colour
    await writePng(join(dir, 'tiles/c_grass_fld_03.png'), 10, 10, i => {
      const row = Math.floor(i / 10)
      return [10 + row * 10, 30 + row * 15, 5 + row * 3, 255]
    })
    await writePng(join(dir, 'tiles/asiaminor_sand_01.png'), 10, 10, () => [200, 180, 140, 255])
    const tiles = [tile(1, 'c_grass_fld_03', 'Grass'), tile(2, 'asiaminor_sand_01', 'Sand'), tile(3, 'c_grass_missing', 'Grass')]
    const warnings: string[] = []
    const lines: string[] = []
    const ctx: WorldPassContext = { outDir: dir, origin: { x: 168, z: 97 }, regions: [], tiles, models: [], placements: [], warnings, log: l => lines.push(l) }
    const entries = await grassPalettePass(ctx)
    expect(entries.map(e => e.id)).toEqual([1, 2])
    const u = (v: number) => Math.round((v / 255) * 1e4) / 1e4
    expect(entries[0]!.grass).toEqual({ weight: 1, base: [u(10), u(30), u(5)], tip: [u(100), u(165), u(32)] })
    expect(entries[1]!.grass).toEqual({ weight: 0, base: [u(200), u(180), u(140)], tip: [u(200), u(180), u(140)] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^grass palettes: 1 tile image\(s\) unreadable.*tiles\/c_grass_missing\.png/)
    expect(lines).toEqual(['grass palettes: 2 tile(s), 1 with grass'])

    // through the pipeline: tiles[].grass set on the known tiles, the manifest validates
    const result = await runWorldPasses({ outDir: dir, origin: { x: 168, z: 97 }, regions: [], tiles, models: [], placements: [], warnings: [] },
      { coast: null, staticVariants: null, grass: grassPalettePass })
    expect(result.tiles.map(t => t.grass?.weight)).toEqual([1, 0, undefined])
    const m = { format: 'sro-world', tiles: result.tiles } as unknown as WorldManifest
    expect(validateWorldManifest(m).filter(e => e.includes('grass'))).toEqual([])
  })

  it('tileGrass: the weight from the name, the palette from the pixels', () => {
    const px = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255])
    expect(tileGrass(tile(1, 'c_grass_fld_03', 'Grass'), px, 4)).toEqual({ weight: 1, base: [0, 0, 0], tip: [1, 1, 1] })
  })
})

// ---- the jangan-fields export ----------------------------------------------------------------------------------------

const EXPORT = join(REPO_ROOT, 'work/out/world/jangan-fields')
const hasExport = existsSync(join(EXPORT, 'manifest.json')) && existsSync(join(EXPORT, 'tiles/c_grass_hmfld_01.png'))

describe.skipIf(!hasExport)('the jangan-fields export', () => {
  it('every tile gets an entry; c_grass_hmfld_01 = the spec\'s deciles; bare tiles 0; grass bases darker than tips', async () => {
    const m = JSON.parse(readFileSync(join(EXPORT, 'manifest.json'), 'utf8')) as WorldManifest
    const warnings: string[] = []
    const ctx: WorldPassContext = { outDir: EXPORT, origin: { x: 168, z: 97 }, regions: [], tiles: m.tiles, models: [], placements: [], warnings, log: () => {} }
    const entries = await grassPalettePass(ctx)
    expect(warnings).toEqual([])
    expect(entries.map(e => e.id)).toEqual(m.tiles.map(t => t.id))
    const by = new Map(entries.map(e => [e.id, e.grass]))
    const named = (n: string) => by.get(m.tiles.find(t => t.source.toLowerCase() === `${n}.ddj`)!.id)!
    // GRASS_LIFE §3.5's re-run: (20, 35, 8) / (87, 111, 39) in sRGB
    const hm = named('c_grass_hmfld_01')
    expect(hm.weight).toBe(1)
    hm.base.forEach((v, i) => expect(Math.abs(v * 255 - [19.6, 35.5, 8.0][i]!)).toBeLessThan(0.1))
    hm.tip.forEach((v, i) => expect(Math.abs(v * 255 - [87.4, 110.7, 39.0][i]!)).toBeLessThan(0.1))
    for (const t of m.tiles) {
      const g = by.get(t.id)!
      if (/sand|marble|stone|water|salt|dest/i.test(t.source) || t.typeName === 'Sand' || t.typeName === 'Water') expect([t.source, g.weight]).toEqual([t.source, 0])
      if (g.weight > 0) expect([t.source, luma(...g.base) < luma(...g.tip)]).toEqual([t.source, true])
    }
    expect(entries.filter(e => e.grass.weight === 1).length).toBeGreaterThanOrEqual(10)
    // the grassy dirt (wc_grass02_01 and kin) painted only the drowned Western China side (docs/COAST.md §4.1): 3 -> 1
    expect(entries.filter(e => e.grass.weight === GRASSY_DIRT_WEIGHT).length).toBeGreaterThanOrEqual(1)
    // the pass's output makes a valid manifest
    const out: WorldManifest = { ...m, tiles: m.tiles.map(t => ({ ...t, grass: by.get(t.id)! })) }
    expect(validateWorldManifest(out)).toEqual([])
  })
})
