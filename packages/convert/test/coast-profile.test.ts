/**
 * The coast's pure geography (docs/COAST.md §3B; WAVE_PLAN6 CST-C port): the noise (bit-for-bit the prototype's,
 * reference values from work/tmp/coast-beach/coast_beach.py), the beach profile, the shelf, the flank envelope and its
 * toe, the waterline rule, the flank fill and paint, the lattice geometry, the array helpers and the section points.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { parseCoastConfig } from '../src/world/coast/config.ts'
import { boxBlur, extrapolate, gaussRadius, gblur, percentile, slopeDeg } from '../src/world/coast/grid.ts'
import { CELLS_PER_REGION, latticeIndex, latticeShape, nearestOnRect, rowZ, colX, sdfRect } from '../src/world/coast/lattice.ts'
import { fbm, hash2, valueNoise } from '../src/world/coast/noise.ts'
import {
  beachHeight, envelope, flankFill, flankRockWeight, hinterlandRise, ramp, roundHalfEven, shelfDepth, smax, smoothstep,
  SWASH_HEIGHT_M, SWASH_WIDTH_M, toeDistance, WATERLINE_RULE, waterlineOffset,
} from '../src/world/coast/profile.ts'
import { controlPoints, sideLine } from '../src/world/coast/sections.ts'

const SL = 5
const PLAY = { x0: 156, x1: 174, z0: 90, z1: 102 }
const coast = () => parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))

describe('noise (the prototype, bit for bit)', () => {
  it('hash2 matches coast_beach.py', () => {
    expect(hash2(0, 0, 1188)).toBe(-0.3918287391560519)
    expect(hash2(-3, 7, 1188)).toBe(-0.9111938423629905)
    expect(hash2(12, -5, 1259)).toBe(0.3763513193339896)
    expect(hash2(1000, -2000, 1289)).toBe(-0.5164967487154453)
  })
  it('value noise and fbm match coast_beach.py', () => {
    const xm = [0, 123.4, -987.6, 3000.5]
    const zm = [0, -55.5, 432.1, -1500.25]
    const n1 = [0.017568245135229622, -0.10813810359650602, 0.0694492586732532, 0.5043899059448399]
    const ridge = [0.42095482303997256, 0.5162605166823191, 0.25744732388779984, -0.02903236117773806]
    const vn = [-0.7033027233661844, 0.0587380172344486, -0.636961103992943, 0.4952255140696751]
    xm.forEach((x, i) => {
      expect(fbm(x, zm[i]!, 1100, 5, 1188)).toBeCloseTo(n1[i]!, 14)
      expect(fbm(x, zm[i]!, 170, 3, 1188 + 71)).toBeCloseTo(ridge[i]!, 14)
      expect(valueNoise(x, zm[i]!, 90, 1289)).toBeCloseTo(vn[i]!, 14)
    })
  })
  it('stays in [-1, 1] and is continuous across lattice cells', () => {
    let prev = valueNoise(0, 33.3, 90, 7)
    for (let x = 0.5; x < 2000; x += 0.5) {
      const v = valueNoise(x, 33.3, 90, 7)
      expect(Math.abs(v)).toBeLessThanOrEqual(1)
      expect(Math.abs(v - prev)).toBeLessThan(0.1)
      prev = v
    }
  })
})

describe('scalar helpers', () => {
  it('ramp, smoothstep, smax', () => {
    expect(ramp(-1, 0, 10, 2, 4)).toBe(2)
    expect(ramp(5, 0, 10, 2, 4)).toBe(3)
    expect(ramp(99, 0, 10, 2, 4)).toBe(4)
    expect(smoothstep(0, 1, 0.5)).toBe(0.5)
    expect(smoothstep(0, 1, -1)).toBe(0)
    expect(smax(3, 1, 1)).toBe(3)
    expect(smax(1, 1, 4)).toBe(2)
    for (let a = -10; a <= 10; a++) expect(smax(a, 0, 10)).toBeGreaterThanOrEqual(Math.max(a, 0))
  })
  it('roundHalfEven is numpy rounding', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, -0, -2, -2, 2, 3])
  })
})

describe('the beach profile (§3B.2)', () => {
  const kinds = coast().beachKinds
  it('runs wet sand -> dry sand -> dune crest and is monotonic inland', () => {
    for (const [name, k] of Object.entries(kinds)) {
      expect(beachHeight(0, SL, k), name).toBe(SL)
      expect(beachHeight(SWASH_WIDTH_M, SL, k)).toBeCloseTo(SL + SWASH_HEIGHT_M, 12)
      expect(beachHeight(k.width / 2, SL, k)).toBeCloseTo(SL + k.dry, 12)
      expect(beachHeight(k.width, SL, k)).toBeCloseTo(SL + k.dune, 12)
      expect(beachHeight(k.width + 500, SL, k)).toBeCloseTo(SL + k.dune, 12)
      let prev = -Infinity
      for (let v = 0; v <= k.width + 20; v += 0.5) {
        const h = beachHeight(v, SL, k)
        expect(h).toBeGreaterThanOrEqual(prev)
        prev = h
      }
    }
  })
  it('keeps every beach band walkable (< 15 degrees) and the swash at about 1:13', () => {
    for (const k of Object.values(kinds)) {
      for (let v = 0; v < k.width; v += 1) {
        const g = beachHeight(v + 1, SL, k) - beachHeight(v, SL, k)
        expect(Math.atan(g) * 180 / Math.PI).toBeLessThan(15)
      }
    }
    expect(SWASH_WIDTH_M / SWASH_HEIGHT_M).toBeCloseTo(13.3, 1)
  })
  it('the hinterland rises gently only well behind the crest', () => {
    const k = kinds.wide!
    const p = beachHeight(k.width, SL, k)
    expect(hinterlandRise(p, k.width + 40, k.width, 0.36, 40)).toBe(p)
    expect(hinterlandRise(p, k.width + 140, k.width, 0.36, 40)).toBeCloseTo(p + 36, 12)
  })
  it('the shelf deepens through its three breaks', () => {
    const d: [number, number, number] = [4, 18, 35]
    expect(shelfDepth(0, d)).toBe(0)
    expect(shelfDepth(120, d)).toBeCloseTo(4, 12)
    expect(shelfDepth(300, d)).toBeCloseTo(18, 12)
    expect(shelfDepth(700, d)).toBeCloseTo(35, 12)
    expect(shelfDepth(5000, d)).toBeCloseTo(35, 12)
    expect(shelfDepth(60, d)).toBeCloseTo(2, 12)
  })
})

describe('the flank envelope (§3B.3)', () => {
  const LS = 80
  const slope = (f: (d: number) => number, d: number) => (f(d + 1e-4) - f(d - 1e-4)) / 2e-4
  it('starts at the line height with the incoming slope and ends on the grade, with no crease at the shoulder', () => {
    for (const sIn of [0.9, 0.3, 0, -0.4, -0.9]) {
      for (const g of [0.45, 0.5, 0.6]) {
        const E = (d: number) => envelope(d, 150, sIn, g, LS)
        expect(E(0)).toBe(150)
        expect(slope(E, 1e-3)).toBeCloseTo(sIn, 3)
        expect(slope(E, 200)).toBeCloseTo(-g, 6)
        expect(E(LS - 1e-9)).toBeCloseTo(E(LS), 6)
        expect(slope(E, LS - 1e-3)).toBeCloseTo(slope(E, LS + 1e-3), 3)
      }
    }
  })
  it('a rising line rounds over a crest outside the bounds (the shoulder), a falling one keeps falling (G11)', () => {
    const up = (d: number) => envelope(d, 100, 0.8, 0.6, LS)
    const crest = (0.8 * LS) / (0.8 + 0.6)
    expect(up(crest)).toBeGreaterThan(up(0))
    expect(up(crest)).toBeGreaterThan(up(crest + 10))
    const down = (d: number) => envelope(d, 100, -0.8, 0.6, LS)
    for (let d = 1; d < 400; d += 5) expect(slope(down, d)).toBeLessThan(-0.55)
  })
  it('the toe is where the envelope reaches the dune crest', () => {
    for (const [hb, sIn, g, dune] of [[200, 0.5, 0.6, 4], [120, 0, 0.45, 5], [60, -0.5, 0.5, 4]] as const) {
      const toe = toeDistance(hb, sIn, g, LS, SL, dune)
      expect(toe).toBeGreaterThan(LS)
      expect(envelope(toe, hb, sIn, g, LS)).toBeCloseTo(SL + dune, 9)
    }
    expect(toeDistance(-30, 0, 0.5, LS, SL, 4)).toBe(0)
  })
  it('the flank fill keeps retail relief only as gullies of at most reliefM', () => {
    for (const r of [-100, 0, 50, 99.9, 100, 140]) {
      const f = flankFill(100, r, 6)
      expect(f).toBeLessThanOrEqual(100)
      expect(f).toBeGreaterThanOrEqual(100 - 6)
    }
    expect(flankFill(100, 120, 6)).toBe(100)
  })
})

describe('the waterline (§3B.1)', () => {
  const base = { amp: 0, n1: 0, n2: 0, keep: 0 }
  it('pushes the waterline out to the toe plus the beach width under a mountain', () => {
    expect(waterlineOffset({ ...base, c0: 150, toe: 300, width: 48 }, WATERLINE_RULE)).toBe(348)
    expect(waterlineOffset({ ...base, c0: 150, toe: 0, width: 48 }, WATERLINE_RULE)).toBe(150)
    expect(waterlineOffset({ ...base, c0: 150, toe: 300, width: 48, keep: 60 }, WATERLINE_RULE)).toBe(408)
  })
  it('never closer than 18 m on sea sections, clamps the in-bounds S1/S2 offsets, leaves the bay mouth alone', () => {
    expect(waterlineOffset({ ...base, c0: 25, amp: 50, n1: -3, toe: 0, width: 0 }, WATERLINE_RULE)).toBe(18)
    expect(waterlineOffset({ ...base, c0: -62, amp: 22, n1: 3, toe: 0, width: 60 }, WATERLINE_RULE)).toBe(-12)
    expect(waterlineOffset({ ...base, c0: -62, amp: 22, n1: -3, toe: 0, width: 60 }, WATERLINE_RULE)).toBe(-105)
    expect(waterlineOffset({ ...base, c0: -300, toe: 0, width: 60 }, WATERLINE_RULE)).toBe(-300)
  })
})

describe('flank paint (G7, WAVE_PLAN6 D28)', () => {
  it('grass to 38 degrees, rock from 45', () => {
    expect(flankRockWeight(31.9, 38, 45)).toBe(0)
    expect(flankRockWeight(38, 38, 45)).toBe(0)
    expect(flankRockWeight(41.5, 38, 45)).toBeCloseTo(0.5, 12)
    expect(flankRockWeight(45, 38, 45)).toBe(1)
  })
})

describe('lattice geometry', () => {
  const l = latticeShape({ x: [150, 177], z: [86, 105] })
  it('is the retail vertex grid of the domain (the prototype: 1,921 x 2,689)', () => {
    expect([l.rows, l.cols]).toEqual([1921, 2689])
    expect(colX(l, 0)).toBe(150)
    expect(rowZ(l, 0)).toBe(106)
    expect(rowZ(l, l.rows - 1)).toBe(86)
    // a shared region-edge vertex has one index from both regions' global coordinates
    expect(latticeIndex(l, 96 * 160 + 96, 96 * 95)).toBe(latticeIndex(l, 96 * 161, 96 * 95))
    expect(latticeIndex(l, 96 * 160, 96 * 95)).toBe((96 * 106 - 96 * 95) * l.cols + 96 * 10)
    expect(latticeIndex(l, 96 * 149, 96 * 95)).toBe(-1)
    expect(CELLS_PER_REGION).toBe(96)
  })
  it('signed distance and nearest line point of a rectangle', () => {
    expect(sdfRect(155, 95, 156, 175, 90, 103)).toBeCloseTo(192, 9)
    expect(sdfRect(160, 95, 156, 175, 90, 103)).toBeCloseTo(-4 * 192, 9)
    expect(sdfRect(155, 89, 156, 175, 90, 103)).toBeCloseTo(Math.SQRT2 * 192, 9)
    expect(nearestOnRect(155, 89, 156, 175, 90, 103)).toEqual([156, 90])
    expect(nearestOnRect(160, 91, 156, 175, 90, 103)).toEqual([160, 90])
    expect(nearestOnRect(174.5, 95, 156, 175, 90, 103)).toEqual([175, 95])
  })
})

describe('array helpers', () => {
  it('blurs keep a constant field and a sum (away from the border)', () => {
    const rows = 40
    const cols = 50
    const a = new Float64Array(rows * cols).fill(3.25)
    boxBlur(a, rows, cols, 4)
    for (const v of a) expect(v).toBeCloseTo(3.25, 12)
    const spike = new Float64Array(rows * cols)
    spike[20 * cols + 25] = 1
    const g = gblur(spike, rows, cols, 2)
    expect(g.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9)
    expect(g[20 * cols + 25]).toBeGreaterThan(g[20 * cols + 28]!)
    expect(gaussRadius(20)).toBe(17)
    expect(gaussRadius(75)).toBe(65)
  })
  it('extrapolates the nearest kept value, dropping with distance', () => {
    const rows = 33
    const cols = 33
    const val = new Float64Array(rows * cols)
    const mask = new Uint8Array(rows * cols)
    for (let i = 0; i < rows; i++) for (let j = 0; j < 8; j++) { mask[i * cols + j] = 1; val[i * cols + j] = 100 }
    const { value, dist } = extrapolate(val, mask, rows, cols, { drop: 0.5 })
    expect(value[16 * cols + 2]).toBe(100)
    // fine column 12 = coarse column 3, two coarse steps (4 cells of 2 m) from the kept coarse column 1
    expect(dist[16 * cols + 12]).toBe(16)
    expect(value[16 * cols + 12]).toBe(92)
  })
  it('slope of a plane and percentiles', () => {
    const rows = 10
    const cols = 10
    const h = new Float64Array(rows * cols)
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) h[i * cols + j] = 2 * j
    const s = slopeDeg(h, rows, cols, 2)
    for (const v of s) expect(v).toBeCloseTo(45, 9)
    expect(percentile([1, 2, 3, 4, 5], null, 50)).toBe(3)
    expect(percentile([1, 2, 3, 4], [1, 1, 0, 1], 100)).toBe(4)
  })
})

describe('section control points (coast.json)', () => {
  const cfg = coast()
  const pts = controlPoints(cfg, PLAY)
  const of = (code: string) => pts.filter(p => p.code === code)
  it('put half-region points on each side\'s line, plus the corners', () => {
    expect(sideLine('north', PLAY, cfg)).toBe(103)
    expect(sideLine('south', PLAY, cfg)).toBe(90)
    expect(sideLine('east', PLAY, cfg)).toBe(175)
    expect(sideLine('west', PLAY, cfg)).toBe(156)
    expect(sideLine('corridor-south', PLAY, cfg)).toBe(96.55)
    expect(of('N1').map(p => [p.x, p.z])).toEqual([[156.5, 103], [157.5, 103], [158.5, 103], [159.5, 103], [160.5, 103], [161.5, 103], [156, 103]])
    expect(of('E3').map(p => [p.x, p.z])).toEqual([[175, 90.5], [175, 90]])
    expect(of('W2').map(p => p.z)).toEqual([91.5, 92.5, 93.5, 94.5, 95.5, 96.5])
    expect(of('A-N').every(p => p.z === 103.85 && p.x >= 146.5 && p.x <= 155.5)).toBe(true)
  })
  it('carry the kind parameters and mark the sections above the phase as land edges', () => {
    const s4 = of('S4')[0]!
    expect(s4.values).toEqual([150, 60, 48, 4, 2, 0.6, 9, 24, 40, 0])
    // CST-C phase 2: coast.json builds every section, so none is a land edge
    expect(cfg.phase).toBe(2)
    expect(pts.every(p => p.values[9] === 0)).toBe(true)
    // phase 1 (the supported fallback, WAVE_PLAN6 §7 item 18): the west and north-west are land edges
    const p1 = controlPoints({ ...cfg, phase: 1 }, PLAY)
    const of1 = (code: string) => p1.filter(p => p.code === code)
    for (const code of ['N1', 'N2', 'W1', 'W2', 'A-S', 'A-N']) expect(of1(code)[0]!.values[9], code).toBe(1)
    for (const code of ['N3', 'N4', 'N5', 'E1', 'E2', 'E3', 'S1', 'S2', 'S3', 'S4']) expect(of1(code)[0]!.values[9], code).toBe(0)
  })
})
