/**
 * CST-S, shore v1's numbers (docs/COAST.md §8.8, §12.5; shore/swash.ts, the CPU twin of shore/chunks.ts and
 * coast/chunks.ts): the run-up rises over 40 % of the period and falls over 55 %, never uncovering the minimum film;
 * the front lies where the sand height equals the run-up on a synthetic 1:13 beach; the shore swell shoals by Green's
 * law and turns to foam at H = 0.78 d; no sheet on slopes steeper than the rock threshold; the wet band is 0 above
 * SL + R_max and follows the swash (covered, then a receding sheen); the analytic bead is 0 wherever the film is 3 cm or
 * thicker.
 */
import { describe, expect, it } from 'vitest'
import {
  BACKWASH_SHARE,
  BEAD_FILM_M,
  BREAK_GAMMA,
  CUSP_M,
  CUSP_SHARE,
  GREEN_REF_DEPTH_M,
  MIN_FILM_M,
  NOMINAL_SLOPE,
  ROCK_SLOPE,
  UPRUSH_SHARE,
  WET_EDGE_JITTER_M,
  WET_FEATHER_M,
  bead,
  breakDepth,
  brokenAt,
  coastWetness,
  cusp,
  frontDistance,
  greenHeight,
  lobe,
  maxRunup,
  phaseOffset,
  sheetWeight,
  shoreHeight,
  swashCycle,
  swashHeight,
  travelTime,
  wetEdgeJitter,
} from '../src/shore/swash.ts'

describe('the swash cycle (ShoreWaves.js shoreSwashRunup)', () => {
  it('rises over 40 % of the period, decelerating, then falls over 55 %, speeding up, then rests', () => {
    expect(UPRUSH_SHARE).toBe(0.4)
    expect(BACKWASH_SHARE).toBe(0.55)
    expect(swashCycle(0)).toBe(0)
    expect(swashCycle(UPRUSH_SHARE)).toBeCloseTo(1, 9)
    let prev = -1
    const steps = 400
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * UPRUSH_SHARE
      const c = swashCycle(s)
      expect(c).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = c
    }
    // Decelerating: the first fifth of the uprush covers more than the last fifth.
    expect(swashCycle(0.08) - swashCycle(0)).toBeGreaterThan(swashCycle(0.4) - swashCycle(0.32))
    prev = 2
    for (let i = 0; i <= steps; i++) {
      const s = UPRUSH_SHARE + (i / steps) * BACKWASH_SHARE
      const c = swashCycle(s)
      expect(c).toBeLessThanOrEqual(prev + 1e-12)
      prev = c
    }
    // The backwash starts slowly and speeds up.
    expect(swashCycle(0.4) - swashCycle(0.51)).toBeLessThan(swashCycle(0.84) - swashCycle(0.95))
    expect(swashCycle(UPRUSH_SHARE + BACKWASH_SHARE)).toBeCloseTo(0, 9)
    expect(swashCycle(0.97)).toBe(0)
    // Periodic.
    expect(swashCycle(1.25)).toBeCloseTo(swashCycle(0.25), 12)
  })

  it('never uncovers the waterline: the sheet stays at or above the minimum film', () => {
    for (let i = 0; i < 1000; i++) {
      const s = i / 1000
      expect(swashHeight(s, 0.4)).toBeGreaterThanOrEqual(MIN_FILM_M)
      expect(swashHeight(s, 0.4)).toBeLessThanOrEqual(0.4 + 1e-12)
    }
    expect(swashHeight(0.4, 0.4)).toBeCloseTo(0.4, 9)
    expect(swashHeight(0.99, 0.4)).toBe(MIN_FILM_M)
  })

  it('the run-up is COAST\'s 0.15 + 0.25 Hs, growing with Hs, capped at 0.8 m', () => {
    expect(maxRunup(0)).toBeCloseTo(0.15, 9)
    expect(maxRunup(0.5)).toBeCloseTo(0.15 + 0.25 * 0.5, 9)
    expect(maxRunup(2.5)).toBeCloseTo(0.775, 9)
    expect(maxRunup(4)).toBe(0.8)
    expect(maxRunup(1)).toBeGreaterThan(maxRunup(0.5))
  })

  it('the front lies where the sand height equals the run-up on a synthetic 1:13 beach', () => {
    const slope = 13
    for (const s of [0.1, 0.3, 0.4, 0.6, 0.9]) {
      const R = swashHeight(s, 0.5)
      const x = frontDistance(s, 0.5, slope)
      // Walk up the beach in 1 cm steps: the first point where the sand is above the sheet.
      let walked = 0
      while (walked / slope < R) walked += 0.01
      expect(Math.abs(walked - x)).toBeLessThan(0.02)
    }
    expect(NOMINAL_SLOPE).toBe(13)
  })

  it('crests arrive later nearer the shore, bunching up in shallow water (travel time 2G / √(g d))', () => {
    // A planar 1:30 beach: depth = G / 30.
    const t = (G: number) => travelTime(G, G / 30)
    expect(t(0)).toBe(0)
    expect(t(60)).toBeGreaterThan(t(30))
    expect(t(30)).toBeGreaterThan(t(10))
    // The local wavelength c · T shortens toward the shore.
    const L = (G: number) => Math.sqrt(9.81 * (G / 30)) * 9
    expect(L(10)).toBeLessThan(L(50))
    // Exact on a planar slope: 2G/c equals ∫ dG / √(g G / 30).
    const n = 20000
    let integral = 0
    for (let i = 0; i < n; i++) {
      const g = ((i + 0.5) / n) * 40
      integral += (40 / n) / Math.sqrt(9.81 * (g / 30))
    }
    // (The midpoint sum under-counts the 1/√G singularity at the shoreline slightly.)
    expect(Math.abs(t(40) - integral) / t(40)).toBeLessThan(0.005)
  })

  it('the along-shore offset and the lobes vary smoothly along the shore and from wave to wave', () => {
    const a = phaseOffset(480, 1290), b = phaseOffset(481, 1290), c = phaseOffset(560, 1290)
    expect(Math.abs(a - b)).toBeLessThan(0.02)
    expect(Math.abs(a - c)).toBeGreaterThan(0)
    expect(Math.abs(a)).toBeLessThan(0.43)
    const l = [0, 1, 2, 3, 4, 5].map(w => lobe(480, 1290, w))
    for (const v of l) {
      expect(v).toBeGreaterThanOrEqual(0.6)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(new Set(l.map(v => v.toFixed(3))).size).toBeGreaterThan(3)
  })
})

describe('the shore swell (Gerstner train, Green\'s law, breaking)', () => {
  it('shoals by Green\'s law H ∝ d^−¼ until H = 0.78 d, where it breaks and becomes the bore', () => {
    const h0 = 0.5
    expect(greenHeight(h0, GREEN_REF_DEPTH_M)).toBeCloseTo(h0, 12)
    expect(greenHeight(h0, 1) / greenHeight(h0, 16)).toBeCloseTo(2, 9)
    const db = breakDepth(h0)
    expect(greenHeight(h0, db)).toBeCloseTo(BREAK_GAMMA * db, 9)
    // Deeper than the break depth: Green's law; shallower: the bore's γ d.
    expect(shoreHeight(h0, db * 1.5)).toBeCloseTo(greenHeight(h0, db * 1.5), 12)
    expect(shoreHeight(h0, db * 0.5)).toBeCloseTo(BREAK_GAMMA * db * 0.5, 12)
    expect(shoreHeight(h0, 0)).toBe(0)
    // Foam (broken) only past the breaking point.
    expect(brokenAt(h0, db * 1.3)).toBe(0)
    expect(brokenAt(h0, db * 0.8)).toBe(1)
    // A bigger swell breaks in deeper water (further out).
    expect(breakDepth(1.2)).toBeGreaterThan(breakDepth(0.5))
  })
})

describe('the sheet on steep land', () => {
  it('runs on gentle sand, and not on slopes steeper than the rock threshold (only the film there)', () => {
    expect(sheetWeight(1 / 13)).toBe(1)
    expect(sheetWeight(1 / 20)).toBe(1)
    expect(sheetWeight(ROCK_SLOPE[1])).toBe(0)
    expect(sheetWeight(1)).toBe(0)
    expect(sheetWeight(0.27)).toBeGreaterThan(0)
    expect(sheetWeight(0.27)).toBeLessThan(1)
  })
})

describe('the terrain wet band (sroCoastWet\'s CPU twin)', () => {
  const Rmax = 0.4, T = 9
  it('is 0 at and above SL + R_max, whatever the phase', () => {
    for (let i = 0; i < 100; i++) {
      const s = i / 100
      expect(coastWetness(Rmax, s, Rmax, Rmax, T)).toBe(0)
      expect(coastWetness(Rmax + 0.2, s, Rmax * 0.8, Rmax, T)).toBe(0)
    }
  })

  it('is 1 under the sheet, then a receding sheen that fades within seconds, over the damp band', () => {
    const h = 0.2
    // Covered at the top of the uprush.
    expect(coastWetness(h, 0.4, Rmax, Rmax, T)).toBe(1)
    // Just uncovered by the backwash: almost soaked; later: drier; the damp band is the floor.
    const sU = 0.4 + 0.55 * (1 - (h - MIN_FILM_M) / (Rmax - MIN_FILM_M)) ** (1 / 1.6)
    const just = coastWetness(h, sU + 0.01, Rmax, Rmax, T)
    const later = coastWetness(h, Math.min(0.94, sU + 0.3), Rmax, Rmax, T)
    expect(just).toBeGreaterThan(0.9)
    expect(later).toBeLessThan(just)
    const damp = coastWetness(h, 0.97, Rmax * 0.3, Rmax, T)
    expect(damp).toBeGreaterThan(0)
    expect(damp).toBeLessThanOrEqual(0.4)
  })
})

describe('P-LOOK: the wet band edges are scalloped, ragged and feathered (no straight contour)', () => {
  const Rmax = 0.4, T = 9

  it('beach cusps: the run-up varies along the shore at the cusp scale, within (1 − share … 1), differently per wave', () => {
    const along = Array.from({ length: 200 }, (_, i) => cusp(480 + i * 0.25, 1290, 3))
    for (const c of along) {
      expect(c).toBeGreaterThanOrEqual(1 - CUSP_SHARE - 1e-9)
      expect(c).toBeLessThanOrEqual(1)
    }
    // It varies within a few cusp lengths (not a straight front) and smoothly from step to step.
    expect(Math.max(...along) - Math.min(...along)).toBeGreaterThan(CUSP_SHARE * 0.4)
    for (let i = 1; i < along.length; i++) expect(Math.abs(along[i]! - along[i - 1]!)).toBeLessThan(CUSP_SHARE * (0.25 / CUSP_M) * 2)
    expect(cusp(480, 1290, 3)).not.toBeCloseTo(cusp(480, 1290, 4), 3)
  })

  it('the ragged-edge jitter stays within ± WET_EDGE_JITTER_M and changes within a metre', () => {
    const j = Array.from({ length: 400 }, (_, i) => wetEdgeJitter(470 + i * 0.05, 1288))
    for (const v of j) expect(Math.abs(v)).toBeLessThanOrEqual(WET_EDGE_JITTER_M + 1e-9)
    expect(Math.max(...j) - Math.min(...j)).toBeGreaterThan(WET_EDGE_JITTER_M * 0.6)
  })

  it('the film edge is feathered: no step from damp to soaked at the front', () => {
    // Uprush (s = 0.2): the front is at swashHeight; across it the wetness changes over ~WET_FEATHER_M, in small steps.
    const s = 0.2
    const front = swashHeight(s, Rmax)
    let prev = coastWetness(front + 0.05, s, Rmax, Rmax, T)
    for (let k = 1; k <= 100; k++) {
      const w = coastWetness(front + 0.05 - k * 0.001, s, Rmax, Rmax, T)
      expect(w).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(w - prev).toBeLessThan(0.15)
      prev = w
    }
    expect(coastWetness(front - WET_FEATHER_M - 0.001, s, Rmax, Rmax, T)).toBe(1)
  })

  it('the reach line is feathered too, and the jitter moves the edge (a ragged line, not a contour)', () => {
    // Late backwash: the sheen below this wave's reach fades out to the damp band over WET_FEATHER_M.
    const s = 0.5, rw = 0.3
    const inside = coastWetness(rw - WET_FEATHER_M - 0.002, s, rw, Rmax, T)
    const edge = coastWetness(rw - WET_FEATHER_M / 2, s, rw, Rmax, T)
    const outside = coastWetness(rw + 0.002, s, rw, Rmax, T)
    expect(inside).toBeGreaterThan(edge)
    expect(edge).toBeGreaterThan(outside)
    // The same height reads differently a few decimetres along the shore once jittered.
    const h = rw - WET_FEATHER_M / 2
    const a = coastWetness(h, s, rw, Rmax, T, WET_EDGE_JITTER_M)
    const b = coastWetness(h, s, rw, Rmax, T, -WET_EDGE_JITTER_M)
    expect(Math.abs(a - b)).toBeGreaterThan(0.1)
  })
})

describe('the analytic bead (COAST §8.8, refresh R4: no depth buffer)', () => {
  it('lights the film\'s front and is 0 wherever the film is 3 cm or thicker', () => {
    expect(BEAD_FILM_M).toBe(0.03)
    expect(bead(0)).toBe(1)
    expect(bead(0.01)).toBeGreaterThan(0.5)
    for (const film of [0.03, 0.05, 0.2, 1]) expect(bead(film)).toBe(0)
    expect(bead(-0.1)).toBe(0)
  })
})
