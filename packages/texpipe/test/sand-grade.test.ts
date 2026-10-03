/**
 * P-LOOK (wave 10 polish): the dry beach sand read almost white at noon. The sand sets (tiles 407 and 412) are graded
 * in TP-P with two new override knobs (pbr/grain.ts): `albedoTint` (per channel, linear light) and `grain` (a tileable
 * sand grain), on the albedo only. When the sets are encoded in work/out/pbr their tiers are checked too.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateOverrides, type TexpipeOverrides } from '../src/format.ts'
import { derive } from '../src/pbr/derive.ts'
import { gradeAlbedo, grainField } from '../src/pbr/grain.ts'
import { img, srgbToLin, type Img } from '../src/pbr/image.ts'
import { resolveParams, type DeriveMeta } from '../src/pbr/params.ts'

const ROOT = join(import.meta.dirname, '../../..')
const overrides = JSON.parse(readFileSync(join(ROOT, 'content/texpipe/overrides.json'), 'utf8')) as TexpipeOverrides
const SANDS = ['tile2d:asiaminor_sand_01', 'tile2d:asiaminor_sand_02']

/** A pale, almost flat sand like the de-lit retail tile (sRGB 0..1). */
function paleSand(w: number, h: number): Img {
  const o = img(w, h, 4)
  for (let p = 0; p < w * h; p++) {
    const g = 0.01 * Math.sin(p * 1.7) * Math.cos(p * 0.37)
    o.d.set([168 / 255 + g, 159 / 255 + g, 139 / 255 + g, 1], p * 4)
  }
  return o
}

const meta = (over: Partial<DeriveMeta> = {}): DeriveMeta => ({
  key: 'tile2d:asiaminor_sand_01', group: 'tile', class: 'ground_soil', alpha: 'none', wrap: [true, true], sourceSize: [16, 16], ...over,
})

function channelMean(im: Img, c: number): number {
  let s = 0
  for (let p = 0; p < im.w * im.h; p++) s += im.d[p * im.c + c]!
  return s / (im.w * im.h)
}

function lumaStd(im: Img): number {
  const n = im.w * im.h
  const l = new Float64Array(n)
  let m = 0
  for (let p = 0; p < n; p++) {
    l[p] = 0.2126 * im.d[p * im.c]! + 0.7152 * im.d[p * im.c + 1]! + 0.0722 * im.d[p * im.c + 2]!
    m += l[p]!
  }
  m /= n
  let v = 0
  for (let p = 0; p < n; p++) v += (l[p]! - m) ** 2
  return Math.sqrt(v / n)
}

describe('the albedo grade knobs (overrides.json pbr.albedoTint, pbr.grain)', () => {
  it('validate: a tint is three numbers in 0..2, the grain a number in 0..2', () => {
    const bad = (pbr: object) => validateOverrides({ ...overrides, sets: { 'tile2d:x': { pbr } } })
    expect(bad({ albedoTint: [0.9, 0.8, 0.6], grain: 1 })).toEqual([])
    expect(bad({ albedoTint: [0.9, 0.8] })).not.toEqual([])
    expect(bad({ albedoTint: [0.9, 0.8, 2.5] })).not.toEqual([])
    expect(bad({ albedoTint: 'warm' })).not.toEqual([])
    expect(bad({ grain: -0.1 })).not.toEqual([])
    expect(bad({ grain: 3 })).not.toEqual([])
  })

  it('resolveParams: defaults leave every other set unchanged', () => {
    const p = resolveParams(meta(), [64, 64])
    expect(p.albedoTint).toEqual([1, 1, 1])
    expect(p.grain).toBe(0)
    const q = resolveParams(meta(), [64, 64], { albedoTint: [0.9, 0.8, 0.6], grain: 1.2 })
    expect(q.albedoTint).toEqual([0.9, 0.8, 0.6])
    expect(q.grain).toBe(1.2)
  })

  it('the grain field: mean ≈ 1, deterministic, seeded, and it wraps on both axes', () => {
    const w = 256, h = 256
    const a = grainField(w, h, 1, 7), b = grainField(w, h, 1, 7), c = grainField(w, h, 1, 8)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    const mean = a.reduce((s, v) => s + v, 0) / a.length
    expect(Math.abs(mean - 1)).toBeLessThan(0.02)
    expect(grainField(8, 8, 0, 1).every(v => v === 1)).toBe(true)
    // The wrap edge is like any other boundary of the 2-texel grains: |row h−1 − row 0| lies within the spread of
    // |row 2k−1 − row 2k| (and the same for the columns).
    const step = (i0: number, i1: number, alongRows: boolean) => {
      let d = 0
      for (let t = 0; t < w; t++) d += Math.abs(alongRows ? a[i0 * w + t]! - a[i1 * w + t]! : a[t * w + i0]! - a[t * w + i1]!)
      return d / w
    }
    for (const rows of [true, false]) {
      const inner: number[] = []
      for (let k = 1; k < h / 2; k++) inner.push(step(2 * k - 1, 2 * k, rows))
      const edge = step(h - 1, 0, rows)
      expect(edge).toBeLessThan(Math.max(...inner))
      expect(edge).toBeGreaterThan(Math.min(...inner))
    }
  })

  it('gradeAlbedo: the tint scales each channel in linear light; the grain adds texture, not a colour shift', () => {
    const src = paleSand(128, 128)
    const tinted = gradeAlbedo(src, [0.9, 0.8, 0.6], 0, 1)
    for (const [c, t] of [[0, 0.9], [1, 0.8], [2, 0.6]] as const) {
      expect(srgbToLin(channelMean(tinted, c)) / srgbToLin(channelMean(src, c))).toBeCloseTo(t, 1)
    }
    const grained = gradeAlbedo(src, [1, 1, 1], 1, 1)
    expect(lumaStd(grained)).toBeGreaterThan(3 * lumaStd(src))
    expect(Math.abs(channelMean(grained, 1) - channelMean(src, 1))).toBeLessThan(0.01)
    // alpha untouched
    expect(grained.d[3]).toBe(1)
  })

  it('derive: the grade changes the albedo only (normal and ORMH stay byte for byte)', () => {
    const src = paleSand(64, 64)
    const m = meta()
    const plain = derive({ meta: m, albedo: src, previewEdge: 0, override: { delight: 1 } })
    const graded = derive({ meta: m, albedo: src, previewEdge: 0, override: { delight: 1, albedoTint: [0.92, 0.79, 0.58], grain: 1.2 } })
    expect(graded.normal.d).toEqual(plain.normal.d)
    expect(graded.ormh.d).toEqual(plain.ormh.d)
    expect(channelMean(graded.albedo, 2)).toBeLessThan(channelMean(plain.albedo, 2) - 0.08)
  })
})

describe('the beach sand sets (COAST §7: tiles 407 and 412)', () => {
  it('both dry sands carry the same golden grade and grain, so they match where they meet', () => {
    const a = overrides.sets[SANDS[0]!]!.pbr!, b = overrides.sets[SANDS[1]!]!.pbr!
    expect(a.albedoTint).toEqual(b.albedoTint)
    expect(a.grain).toBe(b.grain)
    const [r, g, bl] = a.albedoTint!
    // warmer: blue cut most, then green; never brightened
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(bl)
    expect(r).toBeLessThanOrEqual(1)
    expect(a.grain).toBeGreaterThan(0)
    // the wet-sand remaster keeps its own darker grade
    expect(overrides.sets['tile2d:oaho_dust_earth01']!.pbr!.albedoGain).toBeLessThan(1)
  })

  const tier = join(ROOT, 'work/out/pbr/tile2d/asiaminor_sand_01/albedo@512.webp')
  it.skipIf(!existsSync(tier))('the encoded dry sand is golden, not grey-white (after the batch ran)', async () => {
    const sharp = (await import('sharp')).default
    const { data, info } = await sharp(tier).raw().toBuffer({ resolveWithObject: true })
    let r = 0, g = 0, b = 0
    const n = info.width * info.height
    for (let p = 0; p < n; p++) {
      r += data[p * info.channels]!
      g += data[p * info.channels + 1]!
      b += data[p * info.channels + 2]!
    }
    r /= n
    g /= n
    b /= n
    // retail: 168 / 159 / 139 (R − B 29); graded: about 160 / 141 / 106
    expect(r - b).toBeGreaterThan(45)
    expect(g).toBeLessThan(150)
    expect(r).toBeGreaterThan(145)
  })
})
