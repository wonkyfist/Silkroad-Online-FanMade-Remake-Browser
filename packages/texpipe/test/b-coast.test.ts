/**
 * CST-T: the B-coast batch (docs/COAST.md §7, §12.7; docs/WAVE_PLAN6.md CST-T). The batch is data: its entries in
 * content/texpipe/overrides.json, keyed `tile2d:<stem>` for every tile of CST-C's paint palette
 * (content/coast/coast.json), plus the three TP-P knobs the wet-sand remaster needs (albedoGain, roughness, ripples).
 * When the batch has been encoded into work/out/pbr/index.json, its sets are checked there too (skipped otherwise).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classParams } from '../../world-render/src/pbr/classes.ts'
import { validateOverrides, validatePbrIndex, type PbrIndex, type TexpipeOverrides } from '../src/format.ts'
import { derive } from '../src/pbr/derive.ts'
import { img, luminance, seamRatio, type Img } from '../src/pbr/image.ts'
import { resolveParams, type DeriveMeta } from '../src/pbr/params.ts'
import { addRipples, rippleField } from '../src/pbr/ripples.ts'

const ROOT = join(import.meta.dirname, '../../..')
const overrides = JSON.parse(readFileSync(join(ROOT, 'content/texpipe/overrides.json'), 'utf8')) as TexpipeOverrides
const coast = JSON.parse(readFileSync(join(ROOT, 'content/coast/coast.json'), 'utf8')) as { paint: { palette: { tile: number; name: string }[] } }

/** tile2d.ifo ids → stems of the B-coast batch (Map/tile2d.ifo, re-read 2026-09-30; COAST §7.1, §12.7). */
const COAST_TILES: Record<number, string> = {
  407: 'asiaminor_sand_01', 412: 'asiaminor_sand_02', 70: 'oaho_dust_earth01', 534: 'alex_dust_05', 226: 'c_stone_hmfld_02',
  154: 'oaho_dust_earth06',
}
/** Palette tiles whose sets an earlier batch made (B1 hero tiles): the flank grass, Jangan's first rock. */
const EARLIER: Record<number, string> = { 7: 'c_grass_hmfld_01', 177: 'c_stone_hmfld_01' }
/** COAST §7.3: sand and wet sand are hero sets, so Medium gets their maps. */
const HERO = ['asiaminor_sand_01', 'oaho_dust_earth01']

function flat(w: number, h: number, v: number): Img {
  const o = img(w, h, 4)
  for (let p = 0; p < w * h; p++) {
    // A little grain so the height has a range to normalise.
    const g = v + 0.04 * Math.sin(p * 1.7) * Math.cos(p * 0.37)
    o.d.set([g, g * 0.95, g * 0.85, 1], p * 4)
  }
  return o
}

const meta = (over: Partial<DeriveMeta> = {}): DeriveMeta => ({
  key: 'tile2d:oaho_dust_earth01', group: 'tile', class: 'ground_soil', alpha: 'none', wrap: [true, true], sourceSize: [16, 16], ...over,
})

describe('B-coast batch config', () => {
  it('overrides.json validates and has a set for every tile of the coast paint palette', () => {
    expect(validateOverrides(overrides)).toEqual([])
    for (const { tile, name } of coast.paint.palette) {
      const stem = COAST_TILES[tile] ?? EARLIER[tile]
      expect(stem, `palette ${name}: tile ${tile} has no set (add it to the B-coast batch)`).toBeDefined()
      expect(overrides.sets[`tile2d:${stem}`], `tile2d:${stem} (${name})`).toBeDefined()
    }
  })

  it('sand and wet sand are hero sets; tile 70 is remastered as wet sand (COAST §7.2)', () => {
    for (const stem of HERO) expect(overrides.sets[`tile2d:${stem}`]!.hero).toBe(true)
    const wet = overrides.sets['tile2d:oaho_dust_earth01']!.pbr!
    expect(wet.albedoGain).toBeGreaterThanOrEqual(0.55)
    expect(wet.albedoGain).toBeLessThanOrEqual(0.65)
    expect(wet.roughness).toBeGreaterThanOrEqual(0.25)
    expect(wet.roughness).toBeLessThanOrEqual(0.35)
    expect(wet.ripples).toBeGreaterThan(0)
    // rok_stone_01 (278) left the palette with the beaches revision (COAST §12.13).
    expect(overrides.sets['tile2d:rok_stone_01']).toBeUndefined()
  })

  it('the new knobs are range-checked', () => {
    const bad = (pbr: object) => validateOverrides({ ...overrides, sets: { 'tile2d:x': { pbr } } })
    expect(bad({ albedoGain: 2.5 })).not.toEqual([])
    expect(bad({ roughness: -0.1 })).not.toEqual([])
    expect(bad({ ripples: 1.5 })).not.toEqual([])
    expect(bad({ albedoGain: 0.6, roughness: 0.3, ripples: 0.4 })).toEqual([])
  })
})

describe('TP-P wet-sand knobs', () => {
  it('the ripple field is deterministic, 0..1 and wraps on both axes', () => {
    const w = 256, h = 256
    const a = rippleField(w, h, 7), b = rippleField(w, h, 7), c = rippleField(w, h, 8)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    let lo = 1, hi = 0
    for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThanOrEqual(1)
    const im: Img = { w, h, c: 1, d: a }
    expect(seamRatio(im, 'u')).toBeLessThan(1.3)
    expect(seamRatio(im, 'v')).toBeLessThan(1.3)
  })

  it('addRipples with amount 0 leaves the height unchanged', () => {
    const H = Float32Array.from({ length: 64 }, (_, i) => (i % 7) / 7)
    const before = H.slice()
    addRipples(H, 8, 8, 0)
    expect(H).toEqual(before)
  })

  it('resolveParams: defaults are unchanged, the knobs apply', () => {
    const base = resolveParams(meta(), [64, 64])
    expect(base.albedoGain).toBe(1)
    expect(base.ripples).toBe(0)
    expect(base.cls).toEqual(classParams('ground_soil'))
    const wet = resolveParams(meta(), [64, 64], { albedoGain: 0.6, roughness: 0.3, ripples: 0.4 })
    expect(wet.cls.roughness).toBe(0.3)
    expect(wet.cls.porosity).toBe(classParams('ground_soil').porosity)
    expect(wet.albedoGain).toBe(0.6)
    expect(wet.ripples).toBe(0.4)
  })

  it('derive: the gain darkens the linear albedo, the roughness base moves the rough plane, ripples add relief', () => {
    const src = flat(64, 64, 0.7)
    const m = meta()
    const dry = derive({ meta: m, albedo: src, previewEdge: 0, override: { delight: 1 } })
    const wet = derive({ meta: m, albedo: src, previewEdge: 0, override: { delight: 1, albedoGain: 0.6, roughness: 0.3, ripples: 0.5 } })
    const mean = (v: Float32Array) => v.reduce((s, x) => s + x, 0) / v.length
    const ratio = mean(luminance(wet.albedo).d) / mean(luminance(dry.albedo).d)
    expect(ratio).toBeGreaterThan(0.58)
    expect(ratio).toBeLessThan(0.62)
    expect(mean(wet.planes.rough)).toBeLessThan(mean(dry.planes.rough) - 0.4)
    expect(wet.planes.height).not.toEqual(dry.planes.height)
    // Still tileable after the ripples.
    const n: Img = { w: 64, h: 64, c: 3, d: wet.normal.d }
    expect(seamRatio(n, 'u')).toBeLessThan(2)
    expect(seamRatio(n, 'v')).toBeLessThan(2)
  })
})

const INDEX = join(ROOT, 'work/out/pbr/index.json')
describe.skipIf(!existsSync(INDEX))('B-coast in work/out/pbr/index.json (after the batch ran)', () => {
  // Read inside the tests: describe.skipIf still runs this body when the index is absent.
  const index = () => JSON.parse(readFileSync(INDEX, 'utf8')) as PbrIndex

  it('the index validates', () => {
    expect(validatePbrIndex(index())).toEqual([])
  })

  it('every encoded coast set has its status, hero flag, tiers and files', () => {
    const idx = index()
    for (const key of Object.values(COAST_TILES).map(s => `tile2d:${s}`).filter(k => overrides.sets[k] && k in idx.sets)) {
      const set = idx.sets[key]!
      const ov = overrides.sets[key]!
      if (ov.hero !== undefined) expect(set.hero, key).toBe(ov.hero)
      if (ov.status !== undefined) expect(set.status, key).toBe(ov.status)
      expect(set.wrap, key).toEqual([true, true])
      expect(Object.keys(set.tiers).length, key).toBeGreaterThan(0)
      for (const t of Object.values(set.tiers)) expect(existsSync(join(ROOT, 'work/out/pbr', t.albedo)), `${key} ${t.albedo}`).toBe(true)
    }
  })
})
