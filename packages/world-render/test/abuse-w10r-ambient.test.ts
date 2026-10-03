/**
 * H-10R hunt, lens "ambient" (BATCHING F14/Q13, §3.2, §3.13): lightmaps on merged objects and atlas mip bleed.
 *
 * Each case fails on e192530 and names the problem; nothing here changes product code.
 *
 * 1. Atlas mip bleed: an albedo cell's wrap gutter is `max(2, side / 64)` texels, and the table shader samples the
 *    albedo array with `textureSampleGrad` and no LOD clamp (unlike the lightmap, clamped to LOD ≤ 1). From mip 3 on,
 *    the bilinear tap at the inner edge of a 128² cell (the cell of every 64² and 128² retail texture: 229 of the 822
 *    unique embedded images) reads the neighbouring cell's texels: 25 % at mip 3, 37.5 % at mip 4, at every tile
 *    repeat. For a 1 m tile that is from about 60 m at 1080p (earlier on oblique walls, where anisotropic taps spread
 *    along the long axis). §3.13 calls this "the very edge" of "distant mips"; a 256² cell starts at mip 4.
 * 2. More than one lightmap is box-reduced: §3.13 and lightmaps.ts allow exactly one 512² lightmap (the dragon
 *    fountain) to be halved into a 256² layer. The current export (work/out, after the coast's west-coast pass) has
 *    nine: the dragon and eight of the Dunhuang temple (w_cd_tem_*: floor, walls, roof, stairs), whose baked shadows
 *    are drawn at half resolution per axis when batched and at full resolution unbatched.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATLAS_LEVELS, ATLAS_PAGE, cellShape, cellTexel } from '../src/batch/atlas.ts'
import { LIGHTMAP_LEVELS, LIGHTMAP_PAGE } from '../src/batch/lightmaps.ts'
import { atlasMaxLod, lightmapShape } from '../src/pbr/decode-core.ts'

/** The texel indices (of mip `level`) a bilinear tap at page coordinate `p` reads along one axis. */
function taps(p: number, level: number, page: number): [number, number] {
  const size = Math.max(1, page >> level)
  const i = Math.floor(p * size - 0.5)
  return [i, i + 1]
}

/** The first mip level at which a tap inside a cell's inner area reads a texel outside the cell's block (or null). */
function firstBleedLevel(side: number): number | null {
  const shape = cellShape(side, side, ATLAS_PAGE, ATLAS_LEVELS)
  // A block in the middle of a page (its neighbours are other cells).
  const x = ATLAS_PAGE / 2
  const t = cellTexel({ layer: 0, x, y: x, shape }, ATLAS_PAGE)
  // The table shader clamps the level to atlasMaxLod (surface-plugin.ts sroGradK; RA-1 fix).
  for (let level = 0; level < ATLAS_LEVELS && level <= atlasMaxLod(shape); level++) {
    const lo = x >> level
    const hi = ((x + shape.width) >> level) - 1
    // fract(uv) in [0, 1): the inner area's first and last texel centres of this level.
    for (const f of [0, 1 - 1e-6]) {
      const [a, b] = taps(t.u0 + f * t.uScale, level, ATLAS_PAGE)
      if (a < lo || b > hi) return level
    }
  }
  return null
}

describe('H-10R ambient: albedo atlas mip bleed (BATCHING §3.13, F15)', () => {
  it('a 128² cell keeps its bilinear taps inside its own block at every mip level the table shader can pick', () => {
    // The shader picks the level from the cell-scaled gradients, clamped to atlasMaxLod (fixed: no clamp on e192530).
    const bleed = { 128: firstBleedLevel(128), 256: firstBleedLevel(256), 512: firstBleedLevel(512), 1024: firstBleedLevel(1024) }
    // e192530: { 128: 3, 256: 4, 512: 5, 1024: null }. A 128² cell reads 25 % of its neighbour at mip 3.
    expect(bleed, `cells bleed: ${JSON.stringify(bleed)}`).toEqual({ 128: null, 256: null, 512: null, 1024: null })
  })
})

const LIGHTMAPS = resolve(__dirname, '../../../work/out/world/jangan-fields/lightmaps')

function pngFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...pngFiles(p))
    else if (name.toLowerCase().endsWith('.png')) out.push(p)
  }
  return out
}

function pngSide(p: string): number {
  const b = readFileSync(p)
  return Math.max(b.readUInt32BE(16), b.readUInt32BE(20))
}

describe('H-10R ambient: lightmaps larger than a layer (BATCHING §3.2 F7, §3.13)', () => {
  // RA-2 resolved by accepting the reduction (docs/BATCHING.md §3.2, §3.13 and the lightmaps.ts header now list the
  // nine): a new lightmap above a layer must be a deliberate, documented addition.
  it.skipIf(!existsSync(LIGHTMAPS))('only the documented lightmaps are reduced to a 256² layer (the dragon fountain, the Dunhuang temple)', () => {
    // What the batch does with a lightmap above a layer: one 256² layer, box-reduced.
    expect(lightmapShape(512, 512, LIGHTMAP_PAGE, LIGHTMAP_LEVELS).width).toBe(LIGHTMAP_PAGE)
    const reduced = pngFiles(LIGHTMAPS)
      .filter(p => pngSide(p) > LIGHTMAP_PAGE)
      .map(p => p.slice(LIGHTMAPS.length + 1).replace(/\\/g, '/'))
    // e192530 export: 9 (cj_jang_dragon + 8 × bldg/china/dunhuang/buildings/w_cd_tem_*).
    const documented = /cj_jang_dragon|bldg\/china\/dunhuang\/buildings\/w_cd_tem_/i
    expect(reduced.filter(p => !documented.test(p)), reduced.join('\n')).toEqual([])
    expect(reduced.length).toBeLessThanOrEqual(9)
  })
})
