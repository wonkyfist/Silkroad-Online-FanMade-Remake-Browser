/**
 * TP-0 inventory (docs/TEXPIPE.md §1, §10 TP-0; docs/WAVE_PLAN3.md §6.5): the pure rules always, the real inventory
 * of work/out/world/jangan-fields and the actor exports when present (skipped without them).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { keyOf, keyPath } from '../src/format.ts'
import {
  alphaKind, applyOverrides, buildInventory, crossDepth, defaultOutDir, emptyOverrides, isSpecmaskCandidate, loadOverrides,
  selectSet, summarize, TEST_SET, wrapAxes, type Inventory, type InventoryEntry,
} from '../src/inventory.ts'

describe('rules', () => {
  it('alpha kinds (TEXPIPE §3.2 with the corrected specmask rule)', () => {
    const generic = 'OPAQUE: texture alpha, if any, is a specular/env mask'
    const equip = 'equipment: BMT alpha flag but 79% of the surface samples alpha < 128 (0% zero): the alpha is a mask'
    expect(alphaKind({ alphaModes: ['MASK'], alphaReasons: [], format: 'DXT3' })).toBe('cutout')
    expect(alphaKind({ alphaModes: ['BLEND', 'MASK'], alphaReasons: [], format: 'DXT3' })).toBe('blend')
    expect(alphaKind({ alphaModes: ['OPAQUE'], alphaReasons: [generic], format: 'DXT1', alphaMin: 0 })).toBe('none')
    expect(alphaKind({ alphaModes: ['OPAQUE'], alphaReasons: [generic], format: 'DXT3', alphaMin: 255 })).toBe('none')
    expect(alphaKind({ alphaModes: ['OPAQUE'], alphaReasons: [generic], format: 'DXT3', alphaMin: 12 })).toBe('specmask')
    expect(alphaKind({ alphaModes: ['OPAQUE'], alphaReasons: [generic], format: 'A8R8G8B8', alphaMin: 0 })).toBe('specmask')
    expect(alphaKind({ alphaModes: ['OPAQUE'], alphaReasons: [generic], format: 'DXT3' })).toBe('none')
    // The Copper Sword: OPAQUE with the equipment verdict, BLEND with the generic rule in its drop-item copy.
    expect(alphaKind({ alphaModes: ['OPAQUE', 'BLEND'], alphaReasons: [equip, 'BMT alpha flag; texture alpha mostly partial'], format: 'DXT3', alphaMin: 0 })).toBe('specmask')
    expect(isSpecmaskCandidate({ alphaModes: ['OPAQUE', 'MASK'], alphaReasons: [generic], format: 'DXT3' })).toBe(false)
  })

  it('wrap axes from per-triangle integer crossings', () => {
    expect(crossDepth(0, 1)).toBe(0)
    expect(crossDepth(-0.988, 0.012)).toBeCloseTo(0.012, 12)
    expect(crossDepth(0.2, 0.9)).toBe(0)
    expect(crossDepth(-7.5, 11.9)).toBeGreaterThan(9)
    expect(crossDepth(0.9, 1.3)).toBeCloseTo(0.1, 12)
    expect(crossDepth(-Infinity, 1)).toBe(0)
    expect(wrapAxes([23, 0.02])).toEqual([true, false])
    expect(wrapAxes(undefined)).toEqual([false, false])
  })

  it('overrides replace class, hero, alpha and wrap', () => {
    const e = { key: 'tile2d:a', class: 'default', hero: false, alpha: 'none', wrap: [true, true] } as InventoryEntry
    const o = emptyOverrides()
    o.sets['tile2d:a'] = { class: 'stone', hero: true, wrap: [true, false] }
    o.sets['tile2d:missing'] = { hero: true }
    const warnings: string[] = []
    applyOverrides([e], o, warnings)
    expect(e).toMatchObject({ class: 'stone', hero: true, alpha: 'none', wrap: [true, false] })
    expect(warnings).toEqual(['overrides: tile2d:missing is not in the inventory'])
  })
})

const OUT = defaultOutDir()
const HAS_OUT = existsSync(join(OUT, 'world', 'jangan-fields', 'manifest.json')) && existsSync(join(OUT, 'equipment'))

/** TEXPIPE §1.3: the 16 terrain hero tiles. */
const HERO_TILES = [
  'c_grass_hmfld_01', 'c_grass_fld_03', 'c_grass_hmfld_03', 'c_marble_jang_09', 'c_marble_jang_04', 'c_dust_swmp_06',
  'c_dust_fld_08', 'c_dust_fld_01', 'c_stone_jinfild_01', 'c_dust_fld_06', 'c_marble_jang_02', 'c_grass_fld_08',
  'c_grass_fld_04', 'c_stone_hmfld_01', 'wc_dust_don_07', 'c_dust_hmfld_03',
]

/** The coast's palette tiles (COAST §7, CST-T): 4 new to the export at X1 (407, 412, 70, 534) plus 226 and 154. */
const COAST_TILES = ['asiaminor_sand_01', 'asiaminor_sand_02', 'oaho_dust_earth01', 'alex_dust_05', 'c_stone_hmfld_02', 'oaho_dust_earth06'].map(s => `tile2d:${s}`)
/** 104 retail tiles (D36) + the coast's 4 new ones. */
const TILE_COUNT = 108
/** TT-B (TERRAIN_TEX D6): the B3a and B3b tiles are heroes too (content/texpipe/b3-terrain.json). */
const B3 = JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/texpipe/b3-terrain.json'), 'utf8')) as { groups: Record<string, string[]> }
const B3_HERO = [...B3.groups.B3a!, ...B3.groups.B3b!]

describe.skipIf(!HAS_OUT)('inventory of work/out', () => {
  let inv: Inventory
  const get = (suffix: string) => {
    const found = inv.entries.filter(e => e.key.endsWith(suffix))
    expect(found, suffix).toHaveLength(1)
    return found[0]!
  }

  beforeAll(async () => {
    inv = await buildInventory({ outDir: OUT, overrides: null })
  }, 120_000) // ~2.5 s alone; reads ~1,000 glbs, so slow when the suite runs in parallel

  it('has the §1.1 totals: 104 tiles + 4 coast tiles, ≥ 780 world textures, 1,213 textures / 91.4 Mpx', () => {
    const s = summarize(inv)
    expect(s.groups.tile.textures).toBe(TILE_COUNT)
    expect(s.groups.world.textures).toBeGreaterThanOrEqual(780)
    expect(s.total.textures).toBeGreaterThanOrEqual(1200)
    expect(s.total.mpx).toBeGreaterThan(85)
    // X2: coast phase 2 emits 39 more regions (look-only corridor lightmaps, more placed models): 98.4 Mpx
    // wave 12 X2: the 35 tree species' own textures (models/trees, ~2.4 Mpx): 101.4 Mpx
    expect(s.total.mpx).toBeLessThan(105)
  })

  it('has unique keys, unique key paths and 108 unique tile stems (D36 + 4 coast tiles)', () => {
    const keys = inv.entries.map(e => e.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(keys.map(keyPath)).size).toBe(keys.length)
    const tiles = inv.entries.filter(e => e.group === 'tile')
    expect(tiles).toHaveLength(TILE_COUNT)
    expect(new Set(tiles.map(t => t.key)).size).toBe(TILE_COUNT)
    for (const t of tiles) expect(t.key).toMatch(/^tile2d:[a-z0-9_-]+$/)
  })

  it('normalises the Copper Sword path and marks it specmask', () => {
    expect(keyOf('prim\\mtrl\\item\\china\\weapon\\sword1_2_3.ddj')).toBe('prim/mtrl/item/china/weapon/sword1_2_3.ddj')
    const sword = get('prim/mtrl/item/china/weapon/sword1_2_3.ddj')
    expect(sword.alpha).toBe('specmask')
    expect(sword.class).toBe('metal')
    expect(sword.hero).toBe(true)
  })

  it('finds the wrap axes: the city wall repeats in U, not V; tiles in both', () => {
    expect(get('/jangan_enter/cj_wall01.ddj').wrap).toEqual([true, false])
    expect(get('/cj_pal_roof.ddj').wrap).toEqual([true, false])
    expect(get('tile2d:c_grass_fld_03').wrap).toEqual([true, true])
    expect(get('/man/chinaman_adventurer_body.ddj').wrap).toEqual([false, false])
  })

  it('marks the leaf card cutout and classes the test set', () => {
    const leaf = get('/tre_tree02_01.ddj')
    expect(leaf.alpha).toBe('cutout')
    expect(leaf.class).toBe('foliage')
    expect(get('tile2d:c_marble_jang_09').class).toBe('stone')
    expect(get('tile2d:c_grass_hmfld_01').class).toBe('ground_grass')
    expect(get('tile2d:c_dust_fld_01').class).toBe('ground_soil')
    expect(get('/jangan_enter/cj_wall01.ddj').class).toBe('stone')
    expect(get('/cj_pal_roof.ddj').class).toBe('roof_tile')
  })

  it('puts the 16 terrain tiles of §1.3 in the hero set (with the reviewed overrides), plus only coast and B3a/B3b tiles: 63', () => {
    // The coast's repaint of the ring moved two §1.3 tiles out of the computed top 16; the overrides pin them (X1).
    // Wave 12's TT-B makes every B3a and B3b tile and the three used B-coast sets heroes (TERRAIN_TEX D6): 63.
    const tiles = inv.entries.filter(e => e.group === 'tile').map(e => ({ ...e }))
    expect(tiles.filter(e => e.hero).length).toBe(16)
    applyOverrides(tiles, loadOverrides())
    const heroTiles = tiles.filter(e => e.hero).map(e => e.key)
    expect(heroTiles).toHaveLength(63)
    expect(heroTiles.filter(k => !COAST_TILES.includes(k) && !B3_HERO.includes(k)).sort()).toEqual(HERO_TILES.map(s => `tile2d:${s}`).sort())
    const share = tiles.filter(e => e.hero && HERO_TILES.some(h => e.key === `tile2d:${h}`)).reduce((s, e) => s + e.cover!.town, 0)
    expect(share).toBeGreaterThan(0.75)
  })

  it('resolves the 14 test textures and a source for each', () => {
    const set = selectSet(inv, 'test')
    expect(set).toHaveLength(TEST_SET.length)
    for (const e of set) {
      expect(e.source.file, e.key).not.toBe('')
      if (e.group !== 'tile') expect(e.source.image, e.key).toBeTypeOf('number')
    }
  })

  it('measures texel density near TEXPIPE §1.4 (median ≈ 22 px/m by covered surface)', () => {
    const { bySurface } = summarize(inv).worldPxPerM
    expect(bySurface[1]).toBeGreaterThan(15)
    expect(bySurface[1]).toBeLessThan(30)
  })
})
