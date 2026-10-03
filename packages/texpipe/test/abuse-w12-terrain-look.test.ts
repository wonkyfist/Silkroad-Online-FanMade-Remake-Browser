// H-12 hunt, lens "terrain look" (WAVE_PLAN8 §6.7 item 8): paving given the soil rule. The test fails on 95d49e2 and
// passes once the fix lands (F-12).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TexpipeOverrides } from '../src/format.ts'

const ROOT = join(import.meta.dirname, '../../..')
const overrides = JSON.parse(readFileSync(join(ROOT, 'content/texpipe/overrides.json'), 'utf8')) as TexpipeOverrides
const palette = JSON.parse(readFileSync(join(ROOT, 'content/world-edits/jangan-fields/palette.json'), 'utf8')) as { tiles: Array<{ name: string; surface: string }> }

describe('H-12 terrain look: a tile darker than -3 levels in game', () => {
  // TERRAIN_TEX D6 made three used B-coast sets hero this wave, so Medium samples their AO and normals for the first
  // time; §3.2's in-game gate (at most 3 levels darker than today, `nextAoStep` on a fail) and the painterly AO were
  // applied to oaho_dust_earth06 only. c_stone_hmfld_02 (Jangan rock on the coast flank, tile 226) kept the default
  // AO: its ao@512 plane averages 0.83, the darkest of all 63 hero tiles, and it has no in-game spot. Measured
  // (H-12 look lab, Medium WebGPU, noon, the game camera at its spot /tp -1476 738, the same frame with the set
  // hero:false as before the wave): the ground crop goes 105.6 -> 92.3, **-13.3 levels** (the gate is -3; the B3 tiles
  // measured -2.4 at worst).
  it('every tile made hero by D6 carries the painterly AO (aoScale <= 0.25) or another AO-softening rule', () => {
    const d6 = ['tile2d:oaho_dust_earth06', 'tile2d:c_stone_hmfld_02']
    const hard = d6.filter(k => !(overrides.sets[k]?.pbr?.aoScale !== undefined && overrides.sets[k]!.pbr!.aoScale! <= 0.25))
    expect(hard).toEqual([])
  })
})

describe('H-12 terrain look: the paving keeps its soft maps', () => {
  // TERRAIN_TEX §3.2 / D3: "Paving keeps B1's normalScale 0.35, aoScale 0.4"; the painterly ground rule (normal 0.6,
  // AO 0.25, delight 0.5, aiMix 0.5) is for soil and rock. TT-B's rows decide "paving" as c_marble_jang_* only
  // (b3-terrain.test.ts isPaving), so the other tiles the editor's palette files under "Road and paving"
  // (alex_stone02's flagstones, ruin_takl_dest_05's crazy paving, wc_dust_don_14 / _15's slabs) got the soil rule:
  // deeper joints from normal 0.6 and an AI half-mix of the joint lines, the opposite of what the paving rule keeps.
  // (The runtime has the same blind spot: classes.ts's no-anti-tile names, world-render abuse-w12-terrain-look.)
  it('every palette tile under "Road and paving" carries the paving maps rule, not the soil rule', () => {
    const roads = palette.tiles.filter(t => t.surface === 'road').map(t => `tile2d:${t.name}`)
    expect(roads.length).toBeGreaterThan(10)
    const soilRule = roads.filter(k => overrides.sets[k]?.pbr?.delight !== undefined || overrides.sets[k]?.pbr?.normalScale !== 0.35)
    expect(soilRule).toEqual([])
  })
})
