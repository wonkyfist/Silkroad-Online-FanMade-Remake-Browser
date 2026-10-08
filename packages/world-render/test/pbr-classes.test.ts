/**
 * Material classes (pbr/classes.ts; docs/RENDER.md §3.3, docs/WAVE_PLAN3.md D27, §6.10): the 40 most-used Jangan
 * town textures (by placements × area, work/texpipe/inventory.json at the wave-9A step 0) map to reviewed classes;
 * the two TP-0 questions (c_dust_swmp_06, tre_bank_pilla); terrain tiles; the override file; actor classes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MATERIAL_CLASS_PARAMS,
  TERRAIN_SURFACE,
  classify,
  classifyActor,
  isMaterialClass,
  overrideKey,
  parseClassOverrides,
  resolveClass,
  terrainSurfaceClass,
  type MaterialClass,
} from '../src/index.ts'
import { NO_ANTI_TILE, NO_ANTI_TILE_STEMS, noAntiTileFromAlpha, surfaceAlpha, surfaceFromAlpha, terrainNoAntiTile, terrainSurfaceAlpha } from '../src/pbr/classes.ts'

type Alpha = 'OPAQUE' | 'MASK' | 'BLEND'
const M = 'prim/mtrl/'

/** [retail key, glTF alpha mode the converter chose, reviewed class] — the town's top 40 in inventory order. */
const TOWN_TOP_40: ReadonlyArray<[string, Alpha, MaterialClass]> = [
  [`${M}bldg/china/jangan03/cj_pal_roof.ddj`, 'OPAQUE', 'roof_tile'],
  [`${M}bldg/china/jangan_enter/cj_wall01.ddj`, 'OPAQUE', 'stone'],
  [`${M}nature/common/tre_tree01.ddj`, 'MASK', 'foliage'],
  [`${M}bldg/china/jangan03/cj_pal_dan.ddj`, 'MASK', 'default'],
  [`${M}nature/common/tree/tre_tree02_01.ddj`, 'MASK', 'foliage'],
  [`${M}bldg/china/jangan03/cj_pal_dam.ddj`, 'OPAQUE', 'stone'], // 담: the palace wall
  [`${M}bldg/china/jangan03/cj_pal_floor.ddj`, 'OPAQUE', 'stone'],
  [`${M}bldg/china/jangan_enter/cj_wall02.ddj`, 'OPAQUE', 'stone'],
  [`${M}bldg/china/jangan04/cj_mili_roof.ddj`, 'OPAQUE', 'roof_tile'],
  [`${M}nature/common/tree/leaf04.ddj`, 'MASK', 'foliage'],
  [`${M}bldg/china/jangan04/cj_mili_fence_al.ddj`, 'MASK', 'wood'],
  [`${M}nature/common/tree/tre_bank_pilla.ddj`, 'OPAQUE', 'wood'], // TP-0 question 2
  [`${M}particle/pokpo2-2.ddj`, 'MASK', 'water'], // 폭포: the waterfall
  [`${M}nature/common/tre_maple01_leaf_green.ddj`, 'MASK', 'foliage'],
  [`${M}nature/common/tree/tre_dry02.ddj`, 'MASK', 'foliage'],
  [`${M}bldg/china/jangan01/monsterstadium/cj_monstad_door01_01.ddj`, 'OPAQUE', 'wood'],
  [`${M}bldg/china/jangan03/cj_pal_wall.ddj`, 'MASK', 'stone'],
  [`${M}bldg/china/jangan01/monsterstadium/cj_monstad_door01_03.ddj`, 'OPAQUE', 'wood'],
  [`${M}nature/common/tree/tre_willow02_leaf01.ddj`, 'MASK', 'foliage'],
  [`${M}bldg/china/jangan04/cj_mili_flooste.ddj`, 'OPAQUE', 'stone'], // floor stone
  [`${M}nature/common/tree/new-maple/tre_tree09_01.ddj`, 'MASK', 'foliage'],
  [`${M}nature/common/tre_maple_pin.ddj`, 'OPAQUE', 'wood'], // the maple's opaque trunk
  [`${M}bldg/china/jangan01/cj_jang_gate06.ddj`, 'OPAQUE', 'default'],
  [`${M}nature/common/grass/grs_g03.ddj`, 'MASK', 'foliage'],
  [`${M}nature/common/tree/tre_bank_leaf02.ddj`, 'MASK', 'foliage'],
  [`${M}nature/common/tree/tre_willow02_leaf02.ddj`, 'MASK', 'foliage'],
  [`${M}bldg/china/jangan06/rich02/cj_rich_roof.ddj`, 'OPAQUE', 'roof_tile'],
  [`${M}bldg/china/jangan_enter/cj_roof.ddj`, 'OPAQUE', 'roof_tile'],
  [`${M}bldg/china/jangan06/rich04/cj_rich_roof.ddj`, 'OPAQUE', 'roof_tile'],
  [`${M}particle/pokpo1test.ddj`, 'BLEND', 'water'],
  [`${M}bldg/china/jangan03/cj_pal_ndoor.ddj`, 'MASK', 'wood'],
  [`${M}nature/common/tre_maple01_leaf_green2.ddj`, 'MASK', 'foliage'],
  [`${M}bldg/china/jangan04/cj_mili_main_gidund.ddj`, 'OPAQUE', 'wood'], // 기둥: the pillars
  [`${M}bldg/china/jangan_enter/cj_door.ddj`, 'OPAQUE', 'wood'],
  [`${M}particle/pokpo1.ddj`, 'BLEND', 'water'],
  [`${M}bldg/china/jangan03/cj_pal_wall02.ddj`, 'OPAQUE', 'stone'],
  [`${M}nature/common/tree/tre_frie_leaf.ddj`, 'MASK', 'foliage'],
  [`${M}nature/common/tre_maple01_leaf_middle.ddj`, 'MASK', 'foliage'],
  [`${M}nature/common/grass/cj_barley_01.ddj`, 'MASK', 'foliage'],
  [`${M}nature/common/tree/tre_bank_leaf.ddj`, 'MASK', 'foliage'],
]

describe('classify: the 40 most-used Jangan town textures', () => {
  it('maps each to its reviewed class', () => {
    expect(TOWN_TOP_40).toHaveLength(40)
    const got = TOWN_TOP_40.map(([key, alphaMode]) => [key, classify(key, { alphaMode })])
    expect(got).toEqual(TOWN_TOP_40.map(([key, , cls]) => [key, cls]))
  })

  it('takes retail paths in any case and slash', () => {
    expect(classify('PRIM\\MTRL\\BLDG\\CHINA\\JANGAN03\\CJ_PAL_ROOF.DDJ')).toBe('roof_tile')
    expect(classify('prim\\mtrl\\nature\\common\\tree\\tre_bank_pilla.ddj')).toBe('wood')
  })
})

describe('the two TP-0 classification questions', () => {
  it('c_dust_swmp_06 (typed Water) is swamp mud: ground_soil, surface class dirt', () => {
    expect(classify('tile2d:c_dust_swmp_06', { tileType: 'Water' })).toBe('ground_soil')
    expect(classify('tile2d:c_dust_swmp_06')).toBe('ground_soil')
    expect(terrainSurfaceClass({ typeName: 'Water', file: 'tiles/c_dust_swmp_06.png' })).toBe(TERRAIN_SURFACE.dirt)
    expect(terrainSurfaceClass({ typeName: 'Water', file: 'tiles/c_dust_swmp_05.png' })).toBe(TERRAIN_SURFACE.dirt)
    // It darkens and pools in rain; the water class would never get wet.
    expect(MATERIAL_CLASS_PARAMS.ground_soil.porosity).toBeGreaterThan(0.5)
    expect(MATERIAL_CLASS_PARAMS.ground_soil.puddle).toBe(1)
  })

  it('tiles named water, and Water/DeepWater tiles with no ground name, stay water', () => {
    expect(classify('tile2d:oaho_water_01', { tileType: 'Water' })).toBe('water')
    expect(terrainSurfaceClass({ typeName: 'Water', file: 'tiles/oaho_water_02.png' })).toBe(TERRAIN_SURFACE.water)
    expect(terrainSurfaceClass({ typeName: 'DeepWater' })).toBe(TERRAIN_SURFACE.water)
    expect(terrainSurfaceClass({ typeName: 'Mud', file: 'tiles/c_dust_swmp_01.png' })).toBe(TERRAIN_SURFACE.dirt)
  })

  it('tre_bank_pilla (the ginkgo trunk) is wood; opaque tre_* textures are bark, alpha-tested ones foliage', () => {
    const key = `${M}nature/common/tree/tre_bank_pilla.ddj`
    expect(classify(key, { alphaMode: 'OPAQUE' })).toBe('wood')
    expect(classify(key)).toBe('wood')
    expect(classify(`${M}nature/common/tree/new-maple/tre_pine08_03.ddj`, { alphaMode: 'OPAQUE' })).toBe('wood')
    expect(classify(`${M}nature/common/tree/new-maple/tre_pine08_03.ddj`, { alphaMode: 'MASK' })).toBe('foliage')
    expect(MATERIAL_CLASS_PARAMS.wood.translucency).toBe(0)
  })
})

describe('terrain tiles', () => {
  it('take the surface class first (names win over the tile2d type)', () => {
    expect(classify('tile2d:c_marble_jang_09', { tileType: 'Stone' })).toBe('stone')
    expect(classify('tile2d:c_marble_jang_08_1', { tileType: 'Dirt' })).toBe('stone')
    expect(classify('tile2d:c_grass_fld_03', { tileType: 'Grass' })).toBe('ground_grass')
    expect(classify('tile2d:c_dust_fld_01', { tileType: 'Dirt' })).toBe('ground_soil')
    expect(classify('tile2d:ruin_takl_dest_05', { tileType: 'Sand' })).toBe('ground_soil')
  })
})

describe('the override file (content/render/material-overrides.json)', () => {
  it('parses, normalises keys and wins over classify and a set class', () => {
    const r = parseClassOverrides({
      format: 'sro-material-overrides',
      version: 1,
      classes: {
        $comment: 'ignored',
        'PRIM\\MTRL\\BLDG\\CHINA\\JANGAN03\\CJ_PAL_DAN.DDJ': 'wood',
        'prim/mtrl/x.ddj': 'glass',
      },
    })!
    expect(r.warnings).toEqual(['prim/mtrl/x.ddj: unknown class "glass"'])
    expect([...r.overrides]).toEqual([['prim/mtrl/bldg/china/jangan03/cj_pal_dan.ddj', 'wood']])
    const key = 'prim\\mtrl\\bldg\\china\\jangan03\\cj_pal_dan.ddj'
    expect(resolveClass(key, { alphaMode: 'MASK' }, r.overrides, 'stone')).toBe('wood')
    expect(resolveClass(key, {}, null, 'stone')).toBe('stone')
    expect(resolveClass(key, {}, null, null)).toBe('default')
    expect(overrideKey('./Prim//mtrl\\A.ddj')).toBe('prim/mtrl/a.ddj')
  })

  it('is null for anything else', () => {
    expect(parseClassOverrides(null)).toBeNull()
    expect(parseClassOverrides({ format: 'sro-material-overrides', version: 2 })).toBeNull()
    expect(parseClassOverrides({ format: 'other', version: 1, classes: {} })).toBeNull()
    expect(isMaterialClass('stone')).toBe(true)
    expect(isMaterialClass('glass')).toBe(false)
  })
})

describe('classifyActor (character and equipment materials by glTF image name)', () => {
  it('bodies, faces and hands are skin; clothes cloth; the starter sword metal; hair default', () => {
    expect(classifyActor('chinaman_adventurer_body')).toBe('skin')
    expect(classifyActor('x', 'chinawoman_face_01')).toBe('skin')
    expect(classifyActor('clothes_01_ba')).toBe('cloth')
    expect(classifyActor('sword1_2_3')).toBe('metal')
    expect(classifyActor('chinaman_adventurer_hair')).toBe('default')
  })
})

/**
 * TT-Q (TERRAIN_TEX §4.3, F5): the no-anti-tile bit (64) of the layer-map alpha. Paving opts out of anti-tiling by its
 * tile name; the class every reader gets back (`& 63`) is unchanged for every tile, and the byte stays in 128..255.
 */
describe('the no-anti-tile bit (TT-Q)', () => {
  it('round-trips with every surface class, with and without the bit', () => {
    for (let c = 0; c < 6; c++) {
      for (const bit of [false, true]) {
        const a = surfaceAlpha(c, bit)
        expect(a).toBeGreaterThanOrEqual(128)
        expect(a).toBeLessThanOrEqual(255)
        expect(surfaceFromAlpha(a / 255)).toBe(c)
        expect(noAntiTileFromAlpha(a / 255)).toBe(bit)
      }
      expect(surfaceAlpha(c)).toBe(128 + c) // no bit: the byte every reader had before TT-Q
    }
    expect(NO_ANTI_TILE).toBe(64)
    expect(surfaceFromAlpha(0)).toBe(0) // "no layer" (alpha 0) stays out of range of the bit
  })

  it('the paving opts out; rock, the stone-named soils and the ground do not', () => {
    for (const file of ['tiles/c_marble_jang_01.png', 'tiles/c_marble_jang_07_1.png', 'x_pave_01.png', 'x_brick_02.png']) expect(terrainNoAntiTile({ file }), file).toBe(true)
    for (const file of ['tiles/wc_stone_don_04.png', 'tiles/c_stone_jinfild_01.png', 'tiles/c_stone_hmfld_02.png', 'tiles/c_dust_fld_01.png', 'tiles/c_grass_fld_11.png']) {
      expect(terrainNoAntiTile({ file }), file).toBe(false)
    }
    const paving = terrainSurfaceAlpha({ typeName: 'Dirt', file: 'tiles/c_marble_jang_08_1.png', source: 'c_marble_jang_08_1.ddj' })
    expect(paving).toBe(128 + TERRAIN_SURFACE.stone + 64)
    expect(terrainSurfaceAlpha({ typeName: 'Stone', file: 'tiles/wc_stone_don_04.png' })).toBe(128 + TERRAIN_SURFACE.stone)
  })

  const MANIFEST = join(fileURLToPath(new URL('../../..', import.meta.url)), 'work', 'out', 'world', 'jangan-fields', 'manifest.json')
  it.skipIf(!existsSync(MANIFEST))('the class is unchanged for every tile of jangan-fields; only the 12 c_marble_jang tiles and alex_stone02 carry the bit', () => {
    const tiles = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { tiles: Array<{ typeName: string | null; file: string; source: string }> }).tiles
    expect(tiles.length).toBeGreaterThan(0)
    const flagged: string[] = []
    for (const t of tiles) {
      const tile = { typeName: t.typeName ?? undefined, file: t.file, source: t.source }
      const a = terrainSurfaceAlpha(tile)
      expect(surfaceFromAlpha(a / 255), t.file).toBe(terrainSurfaceClass(tile))
      if (noAntiTileFromAlpha(a / 255)) flagged.push(t.source)
    }
    // + alex_stone02, the one of the four named paving tiles (H-12 TEL-2, NO_ANTI_TILE_STEMS) still exported: ruin_takl_dest_05
    // and wc_dust_don_14 / _15 only painted the drowned Western China side (docs/COAST.md §4.1): 16 -> 13
    expect(flagged.length).toBe(13)
    expect(flagged.every(s => /^c_marble_jang_/.test(s) || NO_ANTI_TILE_STEMS.has(s.replace(/\.[a-z0-9]+$/i, '').toLowerCase()))).toBe(true)
  })
})
