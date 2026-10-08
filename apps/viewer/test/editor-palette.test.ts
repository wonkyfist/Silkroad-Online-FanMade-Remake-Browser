// WE-U: the paint palette (docs/WORLD_EDITOR.md §4.3, D20; WAVE_PLAN8 D19) and the editor's small pure helpers: the
// curated content/world-edits/jangan-fields/palette.json (65 rows by surface, every export tile once; 108 before Jangan
// became an island, docs/COAST.md §4.1), the fallback groups, the swatch choice (the remastered 512 albedo first), the budget line against the §7.2 guardrails, the
// render-on-demand gate, the library list.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WE_GUARDRAILS } from '../../../packages/shared/src/world-edits/index.ts'
import { budgetText, regionBudget } from '../src/editor/budget.ts'
import { SURFACES, fallbackSurface, paletteEntries, validatePalette, type PaletteFile } from '../src/editor/palette.ts'
import { filterItems, placedModels, tabOf } from '../src/editor/place-list.ts'
import { RenderGate, ViewWatch } from '../src/editor/render-gate.ts'

const PALETTE = new URL('../../../content/world-edits/jangan-fields/palette.json', import.meta.url)
const MANIFEST = new URL('../../../work/out/world/jangan-fields/manifest.json', import.meta.url)
const palette = JSON.parse(readFileSync(PALETTE, 'utf8')) as PaletteFile

describe('palette.json', () => {
  it('is valid: 65 rows, each tile once, on a known surface; every surface used', () => {
    expect(validatePalette(palette)).toEqual([])
    expect(palette.tiles.length).toBe(65)
    expect(new Set(palette.tiles.map(r => r.tile)).size).toBe(65)
    for (const s of SURFACES) expect(palette.tiles.some(r => r.surface === s)).toBe(true)
    expect(palette.surfaces.map(s => s.id)).toEqual([...SURFACES])
  })

  it.skipIf(!existsSync(MANIFEST))('covers every tile of the jangan-fields export by name', () => {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { tiles: Array<{ id: number; source: string; file: string; typeName: string | null; category: string; width: number; height: number }> }
    expect(validatePalette(palette, m.tiles)).toEqual([])
  })

  it('reports a missing row, a duplicate, an unknown surface and a wrong name', () => {
    const tiles = [{ id: 1, source: 'a.ddj' }, { id: 2, source: 'b.ddj' }]
    const bad = {
      format: 'sro-world-edits-palette', version: 1, world: 'w', surfaces: [{ id: 'grass', label: 'Grass' }],
      tiles: [{ tile: 1, name: 'a', surface: 'grass' }, { tile: 1, name: 'a', surface: 'lava' }, { tile: 3, name: 'x', surface: 'dirt' }],
    }
    const p = validatePalette(bad, tiles)
    expect(p.some(s => s.includes('listed twice'))).toBe(true)
    expect(p.some(s => s.includes("'lava'"))).toBe(true)
    expect(p.some(s => s.includes('not in the export'))).toBe(true)
    expect(p.some(s => s.includes('tile 2 (b) has no row'))).toBe(true)
  })

  it('groups an unlisted tile by its typeName and grass weight, and prefers the upscaled swatch', () => {
    expect(fallbackSurface({ typeName: 'Grass', grass: { weight: 1 } })).toBe('grass')
    expect(fallbackSurface({ typeName: 'Dirt', grass: { weight: 0.45 } })).toBe('longgrass')
    expect(fallbackSurface({ typeName: 'Stone' })).toBe('rock')
    expect(fallbackSurface({ typeName: null })).toBe('other')
    const tiles = [
      { id: 2, source: 'c_grass_fld_03.ddj', file: 'tiles/c_grass_fld_03.png', width: 512, height: 512, typeName: 'Grass', category: 'x', grass: { weight: 1, base: [0, 0, 0] as [number, number, number], tip: [0, 0, 0] as [number, number, number] } },
      { id: 999, source: 'odd_stone.ddj', file: 'tiles/odd_stone.png', width: 512, height: 512, typeName: 'Stone', category: 'x' },
    ]
    const e = paletteEntries(tiles, palette, { sets: { 'tile2d:c_grass_fld_03': { tiers: { 512: { albedo: 'tile2d/c_grass_fld_03/albedo@512.webp' } } } } }, { tileBase: '/out/world/w/', pbrBase: '/out/pbr/' })
    expect(e[0]).toMatchObject({ tile: 2, surface: 'grass', remastered: true, swatch: '/out/pbr/tile2d/c_grass_fld_03/albedo@512.webp' })
    expect(e[1]).toMatchObject({ tile: 999, surface: 'rock', remastered: false, swatch: '/out/world/w/tiles/odd_stone.png' })
    // plain names: the surface and a number within it (the file stem stays in the tooltip)
    expect(e.map(x => x.title)).toEqual(['Grass 1', 'Rock and stone 1'])
  })
})

describe('the budget line', () => {
  it('warns over the warning lines and refuses past the refusal lines (§7.2)', () => {
    const tris = new Map([[0, 1000], [1, 70_000]])
    const ok = regionBudget((97 << 8) | 171, [{ models: [0] }, { models: [0] }], m => tris.get(m))
    expect(ok).toMatchObject({ placements: 2, models: 1, triangles: 2000, level: 'ok', notes: [] })
    expect(budgetText(ok, { draws: 30, preset: 'medium' })).toBe('Region 171,97: 2,000 / 60,000 object triangles, 2 objects · view 30 draws (the plaza measures 152 on Medium) · within budget')
    const warn = regionBudget(1, [{ models: [1] }], m => tris.get(m))
    expect(warn.level).toBe('warn')
    const refuse = regionBudget(1, [{ models: [1] }, { models: [1] }], m => tris.get(m))
    expect(refuse.level).toBe('refuse')
    expect(refuse.notes[0]).toContain('Publish refuses at 90,000')
    const many = regionBudget(1, Array.from({ length: WE_GUARDRAILS.placements.refuse }, () => ({ models: [0] })), m => tris.get(m))
    expect(many.level).toBe('refuse')
    const unknown = regionBudget(1, [{ models: [5] }], () => undefined)
    expect(unknown.triangles).toBeNull()
  })
})

describe('rendering on demand', () => {
  it('draws only while something changes, keeps the animation preview off while another job holds the GPU', () => {
    const g = new RenderGate()
    expect(g.tick(false)).toBe(false)
    g.invalidate(2)
    expect([g.tick(false), g.tick(false), g.tick(false)]).toEqual([true, true, false])
    expect(g.tick(true)).toBe(true)
    g.animate = true
    expect(g.tick(false)).toBe(true)
    g.lockedByOther = true
    expect(g.tick(false)).toBe(false)
    expect(g.drawn).toBe(4)
    const w = new ViewWatch()
    const m = new Float32Array(16).fill(1)
    expect(w.changed(m)).toBe(true)
    expect(w.changed(m)).toBe(false)
    m[12] = 2
    expect(w.changed(m)).toBe(true)
  })
})

describe('the place list', () => {
  it('lists every placed model once, by tab, most used first; search finds by name', () => {
    const lib = placedModels([
      { source: 'res\\nature\\common\\tree\\tre_tree01.bsr', inConvertedRegion: true },
      { source: 'res\\nature\\common\\tree\\tre_tree01.bsr', inConvertedRegion: true },
      { source: 'res\\nature\\common\\stone_field03.bsr', inConvertedRegion: true },
      { source: 'res\\bldg\\china\\jangan\\cj_stone_lamp01.bsr', inConvertedRegion: true },
      { source: 'res\\bldg\\china\\jangan\\cj_house01.bsr', inConvertedRegion: false },
    ])
    const items = lib.items()
    expect(items.map(i => [i.name, i.tab, i.uses])).toEqual([['tre_tree01', 'Trees', 2], ['stone_field03', 'Rocks', 1], ['cj_stone_lamp01', 'Lanterns', 1]])
    expect(filterItems(items, 'All', 'stone').map(i => i.name)).toEqual(['stone_field03', 'cj_stone_lamp01'])
    expect(tabOf('res\\bldg\\china\\jangan\\cj_wall01.bsr')).toBe('Walls and gates')
  })
})
