/**
 * TT-B: the B3 terrain batch (docs/TERRAIN_TEX.md D1–D6, docs/WAVE_PLAN8.md TT-B, D7). The batch is data: its groups
 * in content/texpipe/b3-terrain.json and its rows in content/texpipe/overrides.json (heroes, the GAN route, the
 * painterly ground rule, the paving maps, the per-family prompts, the retunes); plus the two index-side tools it adds:
 * `texpipe hero` (flipHero, no re-encode) and the fragment merge (mergeRows), and the sets' optional `cover`. With the
 * export and the index present, the counts and the encoded sets are checked there too (skipped otherwise).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateOverrides, validatePbrIndex, type PbrIndex, type PbrSet, type TexpipeOverrides } from '../src/format.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { applyCover, flipHero, mergeRows, setFiles } from '../src/index-writer.ts'
import { HERO_COVER_MIN, heroCandidates, setHero } from '../src/hero.ts'
import { applyOverrides, buildInventory, defaultOutDir, loadOverrides } from '../src/inventory.ts'
import { formatOverrides } from '../src/review.ts'
import { isPavingKey } from '../src/paving.ts'

const ROOT = join(import.meta.dirname, '../../..')
const overrides = JSON.parse(readFileSync(join(ROOT, 'content/texpipe/overrides.json'), 'utf8')) as TexpipeOverrides
interface BatchFile { format: string; version: number; batch: string; run: string; groups: Record<'B3a' | 'B3b' | 'B3c' | 'retune', string[]>; keys: string[] }
const b3 = JSON.parse(readFileSync(join(ROOT, 'content/texpipe/b3-terrain.json'), 'utf8')) as BatchFile
const PAINTERLY = { aiMix: 0.5, delight: 0.5, normalScale: 0.6, aoScale: 0.25 }
// the texpipe's one paving list (paving.ts; F-12 TEL-3: the palette's road slabs too, not only c_marble_jang_*)
const isPaving = (k: string) => isPavingKey(k)

describe('B3 batch config', () => {
  it('b3-terrain.json: 22 + 21 + 45 tiles (88), disjoint; the retunes are the gate-failing B1 / B-coast sets', () => {
    expect(b3.format).toBe('sro-texpipe-batch')
    expect(b3.batch).toBe('B3')
    expect(b3.groups.B3a).toHaveLength(22)
    expect(b3.groups.B3b).toHaveLength(21)
    expect(b3.groups.B3c).toHaveLength(45)
    expect(b3.keys).toEqual([...b3.groups.B3a, ...b3.groups.B3b, ...b3.groups.B3c])
    expect(new Set(b3.keys).size).toBe(88)
    expect(b3.groups.retune.sort()).toEqual(['tile2d:c_dust_fld_01', 'tile2d:c_dust_hmfld_03', 'tile2d:c_stone_hmfld_01', 'tile2d:oaho_dust_earth06'])
    for (const k of b3.groups.retune) expect(b3.keys, k).not.toContain(k)
    expect(b3.run).toMatch(/gpu\.lock/)
    expect(b3.run).toMatch(/No DT-2/)
  })

  it('overrides.json validates; every B3 row is a GAN-route row, a hero in B3a/B3b and not in B3c', () => {
    expect(validateOverrides(overrides)).toEqual([])
    for (const [g, keys] of Object.entries(b3.groups)) {
      if (g === 'retune') continue
      for (const k of keys) {
        const e = overrides.sets[k]
        expect(e, k).toBeDefined()
        expect(e!.hero, k).toBe(g !== 'B3c')
        // GAN, or the grain gate's last fallback step (the retail route), never SDXL (TT-B0 Q0).
        expect(['gan', 'retail'], k).toContain(e!.detail)
        if (e!.detail === 'retail') expect(e!.note, k).toMatch(/Fallback ladder/)
        expect(e!.status, k).toBeUndefined()
        expect(e!.note, k).toMatch(new RegExp(`^${g} \\(`))
      }
    }
  })

  it('the painterly ground rule on soil and rock, soft maps on paving, defaults on grass and water-typed tiles; the aiMix ladder', () => {
    const inv = JSON.parse(readFileSync(join(ROOT, 'work/texpipe/inventory.json'), 'utf8')) as { entries: Array<{ key: string; class: string }> } | null
    const cls = new Map(inv?.entries.map(e => [e.key, e.class]) ?? [])
    const LADDER = [0.5, 0.3]
    let painterly = 0
    for (const k of b3.keys) {
      const e = overrides.sets[k]!
      // TP-U's mix: absent (the class default), a step of the ladder, or no upscale at all on the retail route.
      if (e.upscale) expect(LADDER, k).toContain(e.upscale.aiMix)
      if (e.detail === 'retail') expect(e.upscale, k).toBeUndefined()
      if (e.upscale && e.upscale.aiMix !== 0.5) expect(e.note, k).toMatch(/Fallback ladder/)
      if (isPaving(k)) {
        expect(e.pbr, k).toEqual({ normalScale: 0.35, aoScale: 0.4 })
      } else if (e.pbr?.delight !== undefined) {
        painterly++
        expect({ delight: e.pbr.delight, normalScale: e.pbr.normalScale, aoScale: e.pbr.aoScale }, k).toEqual({ delight: 0.5, normalScale: 0.6, aoScale: 0.25 })
        if (e.detail !== 'retail') expect(e.upscale, k).toBeDefined()
        if (cls.size) expect(['ground_soil', 'stone'], k).toContain(cls.get(k))
      } else {
        // Grass and water-typed tiles keep the class maps (a grass row may only carry the in-game gate's roughness base).
        expect(Object.keys(e.pbr ?? {}).filter(f => f !== 'roughness'), k).toEqual([])
        if (cls.size) expect(['ground_grass', 'water'], k).toContain(cls.get(k))
      }
      // The in-game gate (TT-B Q2b): every newly-hero ground and grass tile's roughness plane is based to a mean of
      // ~0.85, the neutral a non-hero tile renders with on Medium (TT-B's measured cause of the darkening).
      if (!isPaving(k) && b3.groups.B3c.indexOf(k) < 0 && cls.get(k) !== 'water' && cls.size) {
        expect(e.pbr?.roughness, k).toBeGreaterThanOrEqual(0.7)
        expect(e.pbr?.roughness, k).toBeLessThanOrEqual(0.85)
      }
    }
    // F-12 (TEL-3): the four road slabs moved to the paving rule (61 -> 60 incl. this run)
    expect(painterly).toBeGreaterThanOrEqual(60)
  })

  it('the retunes: GAN with the painterly rule, heroes; the three used B-coast sets are heroes (63 in all)', () => {
    for (const k of b3.groups.retune) {
      const e = overrides.sets[k]!
      expect(e.hero, k).toBe(true)
      expect({ delight: e.pbr?.delight, normalScale: e.pbr?.normalScale, aoScale: e.pbr?.aoScale }, k).toEqual({ delight: 0.5, normalScale: 0.6, aoScale: 0.25 })
      // GAN at the rule's 0.5, or a step of the grain gate's ladder (aiMix 0.3, then the retail route), noted.
      if (e.detail === 'retail') expect(e.upscale, k).toBeUndefined()
      else {
        expect(e.detail, k).toBe('gan')
        expect([PAINTERLY.aiMix, 0.3], k).toContain(e.upscale?.aiMix)
      }
      if (e.detail === 'retail' || e.upscale?.aiMix !== PAINTERLY.aiMix) expect(e.note, k).toMatch(/Fallback ladder|retail route/)
      expect(e.note, k).toMatch(/^B3 retune/)
      // Heroes on Medium: the roughness plane based to the ~0.85 neutral (the in-game gate's measured cause).
      expect(e.pbr?.roughness, k).toBeGreaterThanOrEqual(0.7)
      expect(e.pbr?.roughness, k).toBeLessThanOrEqual(0.85)
    }
    for (const s of ['oaho_dust_earth06', 'c_stone_hmfld_02', 'asiaminor_sand_02']) expect(overrides.sets[`tile2d:${s}`]!.hero, s).toBe(true)
  })

  it('the per-family SDXL prompts stay for later (field soil, moss, rock), on GAN rows (TT-B0 kept SDXL on none)', () => {
    const fam: Array<[RegExp, RegExp]> = [[/^tile2d:(c_stone_jinfild_|c_dust_hmfld_)/, /tilled brown field soil/], [/^tile2d:c_dust_swmp_/, /forest floor/], [/^tile2d:wc_stone_don_/, /sandstone rock/]]
    for (const k of b3.keys) {
      const f = fam.find(([rx]) => rx.test(k))
      if (f) expect(overrides.sets[k]!.sdxl?.prompt, k).toMatch(f[1])
      else expect(overrides.sets[k]!.sdxl, k).toBeUndefined()
    }
  })
})

/** A two-set index fixture: an encoded tile with maps, and an actor set. */
function fixtureIndex(): PbrIndex {
  const tier = (maps: boolean) => ({ size: [512, 512] as [number, number], albedo: 'a.webp', bytes: 1, ...(maps ? { ao: 'ao.webp', rough: 'r.webp', nx: 'nx.webp', ny: 'ny.webp' } : {}) })
  const set = (key: string, maps: boolean): PbrSet => ({ key, size: [512, 512], class: 'ground_soil', tiers: { 512: tier(maps) }, alpha: 'none', wrap: [true, true], status: 'auto', hero: false })
  return { format: 'sro-pbr', version: 1, pipeline: { rev: 'x', upscaler: 'x', createdAt: 'x' }, sets: { 'tile2d:a': set('tile2d:a', true), 'tile2d:b': set('tile2d:b', false) } }
}
const ov = (): TexpipeOverrides => ({ format: 'sro-texpipe-overrides', version: 1, sets: { 'tile2d:a': { note: 'keep me' } } })

describe('texpipe hero (flipHero: overrides + index, no re-encode)', () => {
  it('flips both files; the files the set names are untouched; both validate', () => {
    const idx = fixtureIndex()
    const r = flipHero(ov(), idx, 'tile2d:a', true)
    expect(r.changed).toEqual({ overrides: true, index: true })
    expect(r.overrides.sets['tile2d:a']).toEqual({ note: 'keep me', hero: true })
    expect(r.index!.sets['tile2d:a']!.hero).toBe(true)
    expect(setFiles(r.index!.sets['tile2d:a']!)).toEqual(setFiles(idx.sets['tile2d:a']!))
    expect(idx.sets['tile2d:a']!.hero).toBe(false) // pure
    expect(validatePbrIndex(r.index)).toEqual([])
    expect(r.warnings).toEqual([])
    const back = flipHero(r.overrides, r.index, 'tile2d:a', true)
    expect(back.changed).toEqual({ overrides: false, index: false })
  })
  it('warns for a set without maps and for a tile not encoded yet; refuses a non-tile key', () => {
    expect(flipHero(ov(), fixtureIndex(), 'tile2d:b', true).warnings[0]).toMatch(/no maps/)
    const r = flipHero(ov(), fixtureIndex(), 'tile2d:c', true)
    expect(r.changed.index).toBe(false)
    expect(r.warnings[0]).toMatch(/not encoded yet/)
    expect(() => flipHero(ov(), fixtureIndex(), 'prim/mtrl/x.ddj', true)).toThrow(/not a terrain tile/)
  })
})

describe("texpipe hero for the editor's Publish (setHero: many tiles, one write per file; heroCandidates)", () => {
  function fixtureDir() {
    const dir = mkdtempSync(join(tmpdir(), 'texpipe-hero-'))
    writeFileSync(join(dir, 'overrides.json'), formatOverrides(ov()))
    writeFileSync(join(dir, 'index.json'), JSON.stringify(fixtureIndex(), null, 1))
    return dir
  }
  it('flips every tile (stems or keys) in one validated write of each file and returns the written files', () => {
    const dir = fixtureDir()
    try {
      const r = setHero({ tiles: ['a', 'tile2d:c', 'tile2d:a'], on: true, overridesFile: join(dir, 'overrides.json'), pbrDir: dir })
      expect(r.tiles).toEqual([{ key: 'tile2d:a', overrides: true, index: true }, { key: 'tile2d:c', overrides: true, index: false }])
      expect(r.warnings.join()).toMatch(/tile2d:c: not encoded yet/)
      expect(r.files).toHaveLength(2)
      expect(r.files.every(f => !f.includes(String.fromCharCode(92)))).toBe(true)
      const o = JSON.parse(readFileSync(join(dir, 'overrides.json'), 'utf8')) as TexpipeOverrides
      expect(o.sets['tile2d:a']).toEqual({ note: 'keep me', hero: true })
      expect(o.sets['tile2d:c']).toEqual({ hero: true })
      expect(validateOverrides(o)).toEqual([])
      const i = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as PbrIndex
      expect(i.sets['tile2d:a']!.hero).toBe(true)
      expect(validatePbrIndex(i)).toEqual([])
      // Again: nothing changes, nothing is written.
      expect(setHero({ tiles: ['a'], on: true, overridesFile: join(dir, 'overrides.json'), pbrDir: dir }).files).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('a dry run reports and writes nothing; no tile is an error', () => {
    const dir = fixtureDir()
    try {
      const before = readFileSync(join(dir, 'index.json'), 'utf8')
      const r = setHero({ tiles: ['a'], on: true, overridesFile: join(dir, 'overrides.json'), pbrDir: dir, dryRun: true })
      expect(r.tiles[0]).toEqual({ key: 'tile2d:a', overrides: true, index: true })
      expect(r.files).toEqual([])
      expect(readFileSync(join(dir, 'index.json'), 'utf8')).toBe(before)
      expect(() => setHero({ tiles: [], on: true, pbrDir: dir })).toThrow(/at least one tile/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('heroCandidates: encoded non-hero tiles at or past 0.1 % cover, sorted; heroes and unencoded tiles left out', () => {
    const idx = fixtureIndex()
    expect(HERO_COVER_MIN).toBe(0.001)
    expect(heroCandidates({ b: 0.001, a: 0.5, zz: 0.9, 'tile2d:a': 0.002 }, idx)).toEqual(['tile2d:a', 'tile2d:b'])
    expect(heroCandidates({ a: 0.000999 }, idx)).toEqual([])
    idx.sets['tile2d:a']!.hero = true
    expect(heroCandidates({ a: 0.5 }, idx)).toEqual([])
    expect(heroCandidates({ a: 0.5 }, null)).toEqual([])
  })
})

describe('the fragment merge (mergeRows), the house style and the optional cover', () => {
  it('formatOverrides reproduces content/texpipe/overrides.json byte for byte (every writer keeps the house style)', () => {
    const text = readFileSync(join(ROOT, 'content/texpipe/overrides.json'), 'utf8')
    expect(formatOverrides(JSON.parse(text) as TexpipeOverrides)).toBe(text)
  })
  it("T12-B's fragment (content/trees/texpipe-rows.json) is merged: every row in the overrides, as written", () => {
    const file = join(ROOT, 'content/trees/texpipe-rows.json')
    if (!existsSync(file)) return
    const frag = JSON.parse(readFileSync(file, 'utf8')) as TexpipeOverrides
    for (const [k, row] of Object.entries(frag.sets)) expect(overrides.sets[k], k).toEqual(row)
  })

  it('adds new keys, keeps identical rows, refuses a different row unless replace, never takes a terrain key', () => {
    const base = ov()
    base.sets['prim/mtrl/x.ddj'] = { note: 'old' }
    const r = mergeRows(base, { format: 'sro-texpipe-overrides', version: 1, sets: { 'prim/mtrl/y.ddj': { hero: true } } })
    expect(r.added).toEqual(['prim/mtrl/y.ddj'])
    expect(() => mergeRows(base, { sets: { 'prim/mtrl/x.ddj': { note: 'new' } } })).toThrow(/--replace/)
    expect(mergeRows(base, { sets: { 'prim/mtrl/x.ddj': { note: 'new' } } }, { replace: true }).replaced).toEqual(['prim/mtrl/x.ddj'])
    expect(mergeRows(base, { sets: { 'prim/mtrl/x.ddj': { note: 'old' } } }).same).toEqual(['prim/mtrl/x.ddj'])
    expect(() => mergeRows(base, { sets: { 'tile2d:z': { hero: true } } })).toThrow(/terrain key/)
    expect(() => mergeRows(base, { sets: { 'prim/mtrl/q.ddj': { hero: 'yes' } } })).toThrow(/does not validate/)
  })
  it('cover: written on tile sets only, 0..1, validated', () => {
    const idx = fixtureIndex()
    expect(applyCover(idx, [{ key: 'tile2d:a', cover: { all: 0.0123456789 } }, { key: 'tile2d:zz', cover: { all: 0.5 } }])).toBe(1)
    expect(idx.sets['tile2d:a']!.cover).toBe(0.012346)
    expect(validatePbrIndex(idx)).toEqual([])
    idx.sets['tile2d:b']!.cover = 1.5
    expect(validatePbrIndex(idx).join()).toMatch(/cover: expected a number in 0\.\.1/)
  })
})

const OUT = defaultOutDir()
const W = join(OUT, 'world', 'jangan-fields', 'manifest.json')
describe.skipIf(!existsSync(W))('B3 on the export', () => {
  it('108 tiles: the 20 used B1 / B-coast sets + the 88 of B3; 63 heroes with the overrides', async () => {
    const inv = await buildInventory({ outDir: OUT, decodeAlpha: false })
    const tiles = inv.entries.filter(e => e.group === 'tile')
    expect(tiles).toHaveLength(108)
    for (const k of b3.keys) expect(tiles.some(t => t.key === k), k).toBe(true)
    applyOverrides(tiles, loadOverrides())
    expect(tiles.filter(t => t.hero)).toHaveLength(63)
  })

  const INDEX = join(OUT, 'pbr', 'index.json')
  const idx = existsSync(INDEX) ? (JSON.parse(readFileSync(INDEX, 'utf8')) as PbrIndex) : null
  const encoded = !!idx && b3.groups.B3a.some(k => k in idx.sets)
  it.skipIf(!encoded)('in work/out/pbr/index.json (after Q1b): every B3a and B3b set, with its maps, hero flag, cover and files', () => {
    expect(validatePbrIndex(idx)).toEqual([])
    for (const k of [...b3.groups.B3a, ...b3.groups.B3b]) {
      const s = idx!.sets[k]
      expect(s, k).toBeDefined()
      expect(s!.hero, k).toBe(true)
      expect(s!.cover, k).toBeGreaterThan(0)
      expect(Object.keys(s!.tiers).sort(), k).toEqual(['1024', '2048', '512'])
      expect(Object.values(s!.tiers).every(t => t.ao && t.rough && t.nx && t.ny), k).toBe(true)
      for (const f of setFiles(s!)) expect(existsSync(join(OUT, 'pbr', f)), `${k} ${f}`).toBe(true)
    }
    for (const s of ['oaho_dust_earth06', 'c_stone_hmfld_02', 'asiaminor_sand_02']) expect(idx!.sets[`tile2d:${s}`]!.hero, s).toBe(true)
  })

  const b3cEncoded = !!idx && b3.groups.B3c.some(k => k in idx.sets)
  it.skipIf(!b3cEncoded)('(step 2) every B3c set: not a hero, but encoded with all its maps (a hero flip is index-only); the retunes re-encoded as heroes', () => {
    for (const k of b3.groups.B3c) {
      const s = idx!.sets[k]
      expect(s, k).toBeDefined()
      expect(s!.hero, k).toBe(false)
      // The long tail: a cover can round to 0 at 6 decimals (pha_grass_01 lives on the synthetic coast regions).
      expect(s!.cover, k).toBeGreaterThanOrEqual(0)
      expect(Object.keys(s!.tiers).sort(), k).toEqual(['1024', '2048', '512'])
      expect(Object.values(s!.tiers).every(t => t.ao && t.rough && t.nx && t.ny), k).toBe(true)
      for (const f of setFiles(s!)) expect(existsSync(join(OUT, 'pbr', f)), `${k} ${f}`).toBe(true)
    }
    for (const k of b3.groups.retune) {
      const s = idx!.sets[k]!
      expect(s.hero, k).toBe(true)
      expect(Object.values(s.tiers).every(t => t.ao && t.rough && t.nx && t.ny), k).toBe(true)
    }
    // All 88 B3 sets and the retunes are in; 63 + 0 heroes among them (B3c flips only through Publish).
    expect([...b3.keys, ...b3.groups.retune].filter(k => idx!.sets[k]?.hero)).toHaveLength(43 + 4)
  })

  const GATES = join(OUT, '..', 'texpipe', 'review', 'terrain', 'gates.json')
  it.skipIf(!b3cEncoded || !existsSync(GATES))('(step 2) the grain and colour gates pass for every B3 tile and retune (TERRAIN_TEX §3.2)', () => {
    const g = JSON.parse(readFileSync(GATES, 'utf8')) as Record<string, { grainPass: boolean; colourPass: boolean; pass: boolean }>
    for (const k of [...b3.keys, ...b3.groups.retune]) {
      expect(g[k], k).toBeDefined()
      expect([g[k]!.grainPass, g[k]!.colourPass], k).toEqual([true, true])
    }
  })
})
