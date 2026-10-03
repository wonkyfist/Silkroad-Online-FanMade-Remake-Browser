// H-12 hunt, lens "terrain look" (WAVE_PLAN8 §6.7 item 8): paving with anti-tiling smear, and the High tier diluted
// by a 512 tap. Each test is a finding: it fails on 95d49e2 and passes once the fix lands (F-12).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { terrainNoAntiTile } from '../src/pbr/classes.ts'
import { TERRAIN_FEATURE_DEFINES, terrainPluginCode } from '../src/pbr/terrain-plugin.ts'

const ROOT = join(import.meta.dirname, '../../..')
const PALETTE = join(ROOT, 'content/world-edits/jangan-fields/palette.json')
const MANIFEST = join(ROOT, 'work/out/world/jangan-fields/manifest.json')

interface PaletteFile { tiles: Array<{ tile: number; name: string; surface: string }> }
interface ManifestTiles { tiles: Array<{ id: number; source?: string; file?: string; typeName?: string }> }

describe('H-12 terrain look: paving and anti-tiling', () => {
  // TERRAIN_TEX §4.3: "Paving opts out of anti-tiling. A rotated blend smears a regular joint grid." The opt-out is a
  // name rule (classes.ts NO_ANTI_TILE_NAME = /marble|pave|brick/), but the editor's own palette files four more
  // tiles under "Road and paving": alex_stone02 (a flagstone paving with a joint grid), ruin_takl_dest_05 (crazy
  // paving), wc_dust_don_14 / _15 (stone slabs set in dirt). They keep the rotated second tap on Medium and High, so
  // a road the user paints with them in the World Editor smears its joints; texpipe's paving rule (params.ts
  // /marble|pave|plaza/, the B3 rows' isPaving = c_marble_jang_*) misses them too (they got the painterly soil rule).
  it.skipIf(!existsSync(MANIFEST))('every palette tile filed under "Road and paving" carries the no-anti-tile bit', () => {
    const palette = JSON.parse(readFileSync(PALETTE, 'utf8')) as PaletteFile
    const man = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestTiles
    const byId = new Map(man.tiles.map(t => [t.id, t]))
    const roads = palette.tiles.filter(t => t.surface === 'road')
    expect(roads.length).toBeGreaterThan(10)
    const smeared = roads.filter(t => !terrainNoAntiTile(byId.get(t.tile)!)).map(t => t.name)
    expect(smeared).toEqual([])
  })
})

describe('H-12 terrain look: what anti-tiling changes', () => {
  // D9 / TERRAIN_TEX §4.3 turns anti-tiling on for Medium and High to break "the 8 m period" (the paving medallion,
  // the dirt pattern seen from 15 m out). The blend is `c = mix(c, c2 * (luma(c) + 0.02) / (luma(c2) + 0.02), wa * 0.6)`:
  // the second tap is rescaled to the FIRST tap's luminance before the mix, so the output's luminance is the first
  // tap's, pixel for pixel, whatever the noise weight. Only chroma moves. The repeat a player sees on soil and rock is
  // luminance (clods, pebbles, cracks, the darker patches), so the second tap cannot break it: the "anti-tiling" costs
  // two samples per pixel and leaves the 8 m pattern in place.
  const luma = (c: readonly number[]) => 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]! // the shader's sroLuma
  // F-12 (TEL-6): the second tap is now matched to the first tap's luminance only by 40 % (k = mix(1, ratio, 0.4)),
  // so its own luminance pattern shows through; this port follows the shader's new line
  const MATCH = 0.4
  it('the shader blends with the partly luminance-matched second tap (the line this test ports)', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      expect(terrainPluginCode(lang).CUSTOM_FRAGMENT_DEFINITIONS!).toContain(`c = mix(c, c2 * mix(1.0, (sroLuma(c) + 0.02) / (sroLuma(c2) + 0.02), ${MATCH}), wa * 0.6);`)
    }
  })
  it('in a full-weight blob the output luminance follows the second tap at least half as much as the first', () => {
    // a soil tile's texels: a pebble, crumbs, a dark crack, a bright clod (linear RGB)
    const texels = [[0.42, 0.33, 0.22], [0.2, 0.15, 0.1], [0.06, 0.05, 0.04], [0.55, 0.46, 0.33], [0.3, 0.24, 0.16]]
    const pairs: Array<{ l1: number; l2: number; out: number }> = []
    for (const c of texels) {
      for (const c2 of texels) {
        const k = 1 + ((luma(c) + 0.02) / (luma(c2) + 0.02) - 1) * MATCH
        const o = c.map((v, i) => v + (c2[i]! * k - v) * 0.6)
        pairs.push({ l1: luma(c), l2: luma(c2), out: luma(o) })
      }
    }
    // least squares out = a l1 + b l2 over the pairs: an anti-tiling blend at weight 0.6 should give b >= 0.3
    let s11 = 0, s22 = 0, s12 = 0, s1o = 0, s2o = 0
    for (const p of pairs) {
      s11 += p.l1 * p.l1; s22 += p.l2 * p.l2; s12 += p.l1 * p.l2; s1o += p.l1 * p.out; s2o += p.l2 * p.out
    }
    const det = s11 * s22 - s12 * s12
    const b = (s11 * s2o - s12 * s1o) / det
    expect(b).toBeGreaterThanOrEqual(0.3)
  })
})

describe('H-12 terrain look: the High tier and the 512 taps', () => {
  // TERRAIN_TEX §4.3 fixed the anti-tiling second tap to read sroTilesHi under SRO_T_TIER, but the triplanar taps on
  // steep cells (High and Ultra: render/quality.ts triplanar true) still read the 512 base array `sroTiles` while the
  // first tap comes from the 1024 tier. On a slope past ~41 degrees (|N.y| < 0.75) the side projections take over
  // (tw.x + tw.z -> 1), so High's cliffs and rock flanks (c_stone_hmfld_02's coast flank, wc_stone_don_*) show the
  // 512 texels: the tier is diluted exactly where the camera sees the most ground per pixel row.
  const layerTriplanar = (src: string) => {
    const loop = src.indexOf('if (k == 0) {')
    expect(loop).toBeGreaterThan(0)
    const start = src.indexOf(`#ifdef ${TERRAIN_FEATURE_DEFINES.triplanar}`, loop)
    const end = src.indexOf(`#ifdef ${TERRAIN_FEATURE_DEFINES.antiTiling}`, start)
    expect(start).toBeGreaterThan(loop)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }
  it('WGSL: the first layer triplanar taps read sroTilesHi for layers below the tier cap, like the first tap', () => {
    const block = layerTriplanar(terrainPluginCode('wgsl').CUSTOM_FRAGMENT_DEFINITIONS!)
    expect(block).toContain('textureSampleGrad(sroTiles, sroTilesSampler, vec2f(-wp.z, -wp.y)')
    expect(block).toContain(`#ifdef ${TERRAIN_FEATURE_DEFINES.tier}`)
    expect(block).toMatch(/textureSampleGrad\(sroTilesHi, sroTilesSampler, vec2f\(-wp\.z, -wp\.y\)/)
  })
  it('GLSL: the same', () => {
    const block = layerTriplanar(terrainPluginCode('glsl').CUSTOM_FRAGMENT_DEFINITIONS!)
    expect(block).toContain(`#ifdef ${TERRAIN_FEATURE_DEFINES.tier}`)
    expect(block).toMatch(/textureGrad\(sroTilesHi, vec3\(vec2\(-wp\.z, -wp\.y\)/)
  })
})
