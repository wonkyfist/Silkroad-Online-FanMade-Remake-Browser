/**
 * The sro-pbr index format (docs/TEXPIPE.md §6.2, docs/WAVE_PLAN3.md D35–D37): keys, key paths, file names, the
 * ORMH packing constants, normal-plane encoding and validation of a synthetic index.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MATERIAL_CLASSES } from '../../world-render/src/pbr/classes.ts'
import {
  checkKey, decodeNormalComponent, encodeNormalComponent, fileStem, keyOf, keyPath, normalZ, ORMH, ORMH_BABYLON_FLAGS,
  ORMH_ORDER, pbrFile, PBR_INDEX_FORMAT, PBR_INDEX_VERSION, tileKey, validateOverrides, validatePbrIndex,
  type PbrIndex,
} from '../src/format.ts'
import { OVERRIDES_FILE } from '../src/inventory.ts'

describe('keys', () => {
  it('normalises retail paths (lower case, forward slashes)', () => {
    expect(keyOf('prim\\mtrl\\item\\china\\weapon\\sword1_2_3.ddj')).toBe('prim/mtrl/item/china/weapon/sword1_2_3.ddj')
    expect(keyOf('PRIM\\MTRL\\Bldg\\\\china\\CJ_Wall01.DDJ')).toBe('prim/mtrl/bldg/china/cj_wall01.ddj')
    expect(keyOf('/prim/mtrl/x.ddj')).toBe('prim/mtrl/x.ddj')
    expect(keyOf('./prim/mtrl/x.ddj')).toBe('prim/mtrl/x.ddj')
    expect(keyOf(keyOf('prim\\a\\b.ddj'))).toBe('prim/a/b.ddj')
  })

  it('keys terrain tiles by the lower-case retail stem (D36)', () => {
    expect(tileKey('c_grass_fld_03.ddj')).toBe('tile2d:c_grass_fld_03')
    expect(tileKey('tiles/C_Marble_Jang_09.png')).toBe('tile2d:c_marble_jang_09')
    expect(tileKey('c_dust_fld_01')).toBe('tile2d:c_dust_fld_01')
    expect(keyOf('TILE2D:C_Grass_Fld_03')).toBe('tile2d:c_grass_fld_03')
    expect(fileStem('a\\b\\x.y.ddj')).toBe('x.y')
  })

  it('maps keys to folders and files under pbr/', () => {
    expect(keyPath('prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj')).toBe('prim/mtrl/bldg/china/jangan_enter/cj_wall01')
    expect(keyPath('tile2d:c_grass_fld_03')).toBe('tile2d/c_grass_fld_03')
    expect(keyPath('gen:plaza_marble')).toBe('gen/plaza_marble')
    expect(pbrFile('tile2d:c_grass_fld_03', 'albedo', 1024)).toBe('tile2d/c_grass_fld_03/albedo@1024.webp')
    expect(pbrFile('prim/mtrl/x.ddj', 'ormh', 2048, 'ktx2')).toBe('prim/mtrl/x/ormh@2048.ktx2')
  })

  it('escapes spaces and Hangul in key paths, one folder per key', () => {
    expect(keyPath('prim/mtrl/nature/common/tree/tre_bam04_01 .ddj')).toBe('prim/mtrl/nature/common/tree/tre_bam04_01~20~')
    expect(keyPath('prim/mtrl/nature/china/dunhuang/tree/나무01.ddj')).toMatch(/^prim\/mtrl\/nature\/china\/dunhuang\/tree\/(~[0-9a-f]+~)+01$/)
    expect(keyPath('prim/a/x_.ddj')).not.toBe(keyPath('prim/a/x .ddj'))
    expect(keyPath('prim/a/x~20~.ddj')).not.toBe(keyPath('prim/a/x .ddj'))
  })

  it('checks keys', () => {
    expect(checkKey('prim/mtrl/item/china/weapon/sword1_2_3.ddj')).toBeNull()
    expect(checkKey('prim/mtrl/nature/common/tree/tre_bam04_01 .ddj')).toBeNull()
    expect(checkKey('tile2d:c_grass_fld_03')).toBeNull()
    expect(checkKey('gen:plaza_marble')).toBeNull()
    expect(checkKey('Prim/X.ddj')).toMatch(/normalised/)
    expect(checkKey('prim/../x.ddj')).toMatch(/segment/)
    expect(checkKey('tile2d:a/b')).toMatch(/bare stem/)
    expect(checkKey('http:/x/y.ddj')).toMatch(/segment/)
    expect(checkKey('')).toMatch(/empty/)
  })
})

describe('map packing (D37)', () => {
  it('packs ORMH as R = AO, G = roughness, B = metallic, A = height', () => {
    expect(ORMH).toEqual({ ao: 0, rough: 1, metal: 2, height: 3 })
    ORMH_ORDER.forEach((term, i) => expect(ORMH[term]).toBe(i))
    // Babylon reads AO from R, roughness from G, metallic from B of the metallic texture.
    expect(ORMH_BABYLON_FLAGS).toEqual([
      'useAmbientOcclusionFromMetallicTextureRed',
      'useRoughnessFromMetallicTextureGreen',
      'useMetallnessFromMetallicTextureBlue',
    ])
    expect(ORMH_BABYLON_FLAGS[ORMH.ao]).toMatch(/Red$/)
    expect(ORMH_BABYLON_FLAGS[ORMH.rough]).toMatch(/Green$/)
    expect(ORMH_BABYLON_FLAGS[ORMH.metal]).toMatch(/Blue$/)
  })

  it('encodes normal planes with 128 = 0 and rebuilds a unit z', () => {
    expect(encodeNormalComponent(0)).toBe(128)
    expect(encodeNormalComponent(1)).toBe(255)
    expect(encodeNormalComponent(-1)).toBe(1)
    expect(encodeNormalComponent(-2)).toBe(1)
    for (const v of [-0.9, -0.3, 0, 0.25, 0.8]) expect(Math.abs(decodeNormalComponent(encodeNormalComponent(v)) - v)).toBeLessThan(0.5 / 127 + 1e-9)
    expect(normalZ(0, 0)).toBe(1)
    expect(normalZ(0.6, 0)).toBeCloseTo(0.8, 12)
    expect(normalZ(1, 1)).toBe(0)
  })
})

function synthetic(): PbrIndex {
  return {
    format: PBR_INDEX_FORMAT,
    version: PBR_INDEX_VERSION,
    pipeline: { rev: 'test', upscaler: 'realesrgan-x4plus', createdAt: '2026-09-28T00:00:00Z' },
    sets: {
      'tile2d:c_grass_fld_03': {
        key: 'tile2d:c_grass_fld_03', size: [1024, 1024], class: 'ground_grass', alpha: 'none', wrap: [true, true],
        status: 'ok', hero: true, delit: true, uvScale: 1, source: 'local',
        tiers: {
          512: { size: [512, 512], albedo: 'tile2d/c_grass_fld_03/albedo@512.webp', bytes: 1000 },
          1024: {
            size: [1024, 1024], albedo: 'tile2d/c_grass_fld_03/albedo@1024.webp', nx: 'tile2d/c_grass_fld_03/nx@1024.webp',
            ny: 'tile2d/c_grass_fld_03/ny@1024.webp', ao: 'tile2d/c_grass_fld_03/ao@1024.webp',
            rough: 'tile2d/c_grass_fld_03/rough@1024.webp', height: 'tile2d/c_grass_fld_03/height@1024.webp', bytes: 90000,
          },
        },
      },
      'prim/mtrl/item/china/weapon/sword1_2_3.ddj': {
        key: 'prim/mtrl/item/china/weapon/sword1_2_3.ddj', size: [512, 512], class: 'metal', alpha: 'specmask',
        wrap: [false, false], status: 'auto', hero: true, params: { metallic: 1 },
        tiers: { 512: { size: [512, 512], albedo: 'prim/mtrl/item/china/weapon/sword1_2_3/albedo@512.webp', bytes: 5 } },
      },
      'prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj': {
        key: 'prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj', size: [256, 512], class: 'stone', alpha: 'none',
        wrap: [true, false], status: 'replaced', hero: true, tiers: {},
      },
      'gen:cj_wall01_v2': {
        key: 'gen:cj_wall01_v2', size: [1024, 2048], class: 'stone', alpha: 'none', wrap: [true, false], status: 'ok',
        hero: true, replaces: 'prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj', source: 'generated',
        albedo: 'gen/cj_wall01_v2/albedo@2048.ktx2', ormh: 'gen/cj_wall01_v2/ormh@2048.ktx2',
        tiers: { 2048: { size: [1024, 2048], albedo: 'gen/cj_wall01_v2/albedo@2048.webp', bytes: 7 } },
      },
    },
  }
}

describe('validatePbrIndex', () => {
  it('accepts a well-formed index', () => {
    expect(validatePbrIndex(synthetic())).toEqual([])
    expect(validatePbrIndex(JSON.parse(JSON.stringify(synthetic())))).toEqual([])
  })

  it('reports each kind of error', () => {
    const cases: Array<[(i: PbrIndex) => void, RegExp]> = [
      [i => { (i as { format: string }).format = 'sro-remaster' }, /^format:/],
      [i => { i.pipeline = {} as PbrIndex['pipeline'] }, /^pipeline:/],
      [i => { i.sets['tile2d:c_grass_fld_03']!.key = 'tile2d:other' }, /\.key: must equal/],
      [i => { (i.sets['tile2d:c_grass_fld_03'] as { class: string }).class = 'plastic' }, /\.class:/],
      [i => { (i.sets['tile2d:c_grass_fld_03'] as { alpha: string }).alpha = 'mask' }, /\.alpha:/],
      [i => { (i.sets['tile2d:c_grass_fld_03'] as { status: string }).status = 'done' }, /\.status:/],
      [i => { i.sets['tile2d:c_grass_fld_03']!.size = [1024, 0] }, /\.size:/],
      [i => { i.sets['tile2d:c_grass_fld_03']!.size = [2048, 2048] }, /must equal the largest tier/],
      [i => { i.sets['tile2d:c_grass_fld_03']!.tiers['1024']!.size = [512, 512] }, /tier name must be its long edge/],
      [i => { i.sets['tile2d:c_grass_fld_03']!.tiers['1024']!.albedo = '../../etc/passwd' }, /albedo: expected a relative file path/],
      [i => { i.sets['tile2d:c_grass_fld_03']!.tiers['1024']!.albedo = 'https://example.com/a.webp' }, /albedo: expected a relative file path/],
      [i => { delete i.sets['tile2d:c_grass_fld_03']!.tiers['1024']!.ny }, /nx and ny come together/],
      [i => { i.sets['tile2d:c_grass_fld_03']!.tiers['1024']!.bytes = -1 }, /bytes:/],
      [i => { i.sets['prim/mtrl/item/china/weapon/sword1_2_3.ddj']!.params = { metallic: 9 } }, /params\.metallic/],
      [i => { delete i.sets['gen:cj_wall01_v2']!.replaces }, /gen: sets must name/],
      [i => { i.sets['tile2d:c_grass_fld_03']!.replaces = 'tile2d:x' }, /only gen: sets replace/],
      [i => { i.sets['gen:cj_wall01_v2']!.replaces = 'prim/other.ddj' }, /'replaced' but no gen: set replaces it/],
      [i => { i.sets['Prim/X.ddj'] = { ...i.sets['prim/mtrl/item/china/weapon/sword1_2_3.ddj']!, key: 'Prim/X.ddj' } }, /bad key/],
    ]
    for (const [mutate, re] of cases) {
      const index = synthetic()
      mutate(index)
      const errors = validatePbrIndex(index)
      expect(errors.some(e => re.test(e)), `${re} in ${JSON.stringify(errors)}`).toBe(true)
    }
    expect(validatePbrIndex(null)).toEqual(['index: not an object'])
  })

  it('knows every material class of pbr/classes.ts', () => {
    for (const cls of MATERIAL_CLASSES) {
      const index = synthetic()
      index.sets['tile2d:c_grass_fld_03']!.class = cls
      expect(validatePbrIndex(index)).toEqual([])
    }
  })
})

describe('overrides', () => {
  it('the committed content/texpipe/overrides.json is valid', () => {
    expect(validateOverrides(JSON.parse(readFileSync(OVERRIDES_FILE, 'utf8')))).toEqual([])
    expect(OVERRIDES_FILE.replace(/\\/g, '/')).toMatch(/content\/texpipe\/overrides\.json$/)
  })

  it('rejects unknown fields and values', () => {
    const base = { format: 'sro-texpipe-overrides', version: 1 }
    expect(validateOverrides({ ...base, sets: { 'tile2d:c_grass_fld_03': { class: 'stone', hero: true, params: { roughness: 0.7 } } } })).toEqual([])
    expect(validateOverrides({ ...base, sets: { 'tile2d:x': { colour: 'red' } } })[0]).toMatch(/unknown field/)
    expect(validateOverrides({ ...base, sets: { 'tile2d:x': { class: 'plastic' } } })[0]).toMatch(/unknown class/)
    expect(validateOverrides({ ...base, sets: { 'Tile2d:X': {} } })[0]).toMatch(/bad key/)
  })
})
