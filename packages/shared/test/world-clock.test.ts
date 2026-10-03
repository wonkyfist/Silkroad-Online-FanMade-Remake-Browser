import { describe, expect, it } from 'vitest'
import {
  CLOCK_EPOCH_DAYS,
  CLOCK_EPOCH_MS,
  DEFAULT_CLOCK,
  clockAt,
  clockDays,
  formatClock,
  moonState,
  moonVisible,
  phaseForSolarTime,
  solarTime,
  sunDirection,
  sunriseSunset,
  type WorldClockState,
} from '../src/index.ts'

/** Minutes of a 120-minute day with the sun below the geometric horizon. */
function nightMinutes(decl: number, k: number): number {
  const { rise, set } = sunriseSunset(decl)
  return (1 - (phaseForSolarTime(set, k) - phaseForSolarTime(rise, k))) * 120
}

describe('solar time (docs/SKY.md §2.1)', () => {
  it('is monotonic for k up to 0.6 and fixes 0, 0.5 and 1', () => {
    for (const k of [0, 0.3, 0.4, 0.6]) {
      expect(solarTime(0, k)).toBeCloseTo(0, 12)
      expect(solarTime(0.5, k)).toBeCloseTo(0.5, 12)
      expect(solarTime(1, k)).toBeCloseTo(1, 12)
      let prev = -Infinity
      for (let i = 0; i <= 2000; i++) {
        const t = solarTime(i / 2000, k)
        expect(t).toBeGreaterThan(prev)
        prev = t
      }
    }
  })

  it('runs faster at night with k > 0 (midnight to 01:00 takes less phase than noon to 13:00)', () => {
    const k = 0.4
    expect(phaseForSolarTime(1 / 24, k) - phaseForSolarTime(0, k)).toBeLessThan(phaseForSolarTime(13 / 24, k) - phaseForSolarTime(12 / 24, k))
  })

  it('phaseForSolarTime inverts solarTime', () => {
    for (const k of [0, 0.25, 0.4, 0.6]) {
      for (const t of [0, 0.01, 0.25, 0.3, 0.5, 0.77, 0.999]) expect(solarTime(phaseForSolarTime(t, k), k)).toBeCloseTo(t, 9)
    }
    expect(phaseForSolarTime(1.25, 0)).toBeCloseTo(0.25, 9) // wrapped
  })

  it('matches the night-length table of §2.3 within ±0.3 min', () => {
    const table: [number, number, number][] = [
      [0, 0, 60.0], [0, 0.3, 49.0], [0, 0.4, 45.8], [0, 0.5, 42.8],
      [12, 0, 54.4], [12, 0.3, 44.0], [12, 0.4, 41.0], [12, 0.5, 38.3],
      [23.4, 0, 48.6], [23.4, 0.3, 38.8], [23.4, 0.4, 36.2], [23.4, 0.5, 33.8],
    ]
    for (const [decl, k, minutes] of table) expect(Math.abs(nightMinutes(decl, k) - minutes)).toBeLessThanOrEqual(0.3)
  })
})

describe('sun and moon', () => {
  it('sunDirection: rises in the east (+X) at t = 0.25, stands south (+Z) and up at noon, is a unit vector', () => {
    const [e, u] = sunDirection(0.25, 12)
    expect(e).toBeGreaterThan(0.9)
    expect(u).toBeGreaterThan(0) // summer declination: already up at 06:00
    const noon = sunDirection(0.5, 12)
    expect(noon[2]).toBeGreaterThan(0)
    expect(noon[1]).toBeGreaterThan(0.9)
    expect(Math.abs(noon[0])).toBeLessThan(1e-12)
    // noon elevation = 90° − φ + δ
    expect((Math.asin(noon[1]) * 180) / Math.PI).toBeCloseTo(90 - 34.3 + 12, 6)
    expect(sunDirection(0, 12)[1]).toBeLessThan(0) // midnight: below the horizon
    for (const t of [0, 0.1, 0.33, 0.9]) expect(Math.hypot(...sunDirection(t, -7))).toBeCloseTo(1, 12)
  })

  it('sunriseSunset is symmetric about noon and has the sun on the horizon', () => {
    const { rise, set } = sunriseSunset(12)
    expect(rise + set).toBeCloseTo(1, 12)
    expect(sunDirection(rise, 12)[1]).toBeCloseTo(0, 9)
    expect(sunDirection(set, 12)[1]).toBeCloseTo(0, 9)
    expect(sunriseSunset(23, 89)).toEqual({ rise: 0, set: 1 })
    expect(sunriseSunset(-23, 89)).toEqual({ rise: 0.5, set: 0.5 })
  })

  it('moonState: full moon = texture 16 at age 14.77, age 0.9 → 1, 29.4 → 30 (SKY verify)', () => {
    const full = moonState(14.77)
    expect(full.texture).toBe(16)
    expect(full.illum).toBeGreaterThan(0.999)
    expect(full.hourOffset).toBeCloseTo(0.5, 3) // opposite the sun: rises at sunset
    expect(moonState(0.9).texture).toBe(1)
    expect(moonState(29.4).texture).toBe(30)
    expect(moonState(0).illum).toBe(0)
    expect(moonState(29.53 + 14.77).texture).toBe(16) // wraps
    expect(moonState(-0.1).age).toBeCloseTo(29.43, 9)
    for (let a = 0; a < 29.53; a += 0.05) {
      const s = moonState(a)
      expect(s.texture).toBeGreaterThanOrEqual(1)
      expect(s.texture).toBeLessThanOrEqual(30)
    }
    expect(moonVisible(0.5)).toBe(false)
    expect(moonVisible(29)).toBe(false)
    expect(moonVisible(14.77)).toBe(true)
  })
})

describe('the clock state', () => {
  const base: WorldClockState = { anchorMs: CLOCK_EPOCH_MS, anchorDays: CLOCK_EPOCH_DAYS, ...DEFAULT_CLOCK }

  it('advances one game day per dayMs from the anchor and stops when frozen', () => {
    expect(clockDays(base, CLOCK_EPOCH_MS)).toBe(0.3)
    expect(clockDays(base, CLOCK_EPOCH_MS + base.dayMs)).toBeCloseTo(1.3, 12)
    expect(clockDays({ ...base, running: false }, CLOCK_EPOCH_MS + 5 * base.dayMs)).toBe(0.3)
    const at = clockAt(base, CLOCK_EPOCH_MS + 2.5 * base.dayMs)
    expect(at.day).toBe(2)
    expect(at.phase).toBeCloseTo(0.8, 9)
    expect(at.t).toBeCloseTo(solarTime(0.8, 0.4), 9)
  })

  it('formatClock prints "Day n, hh:mm"', () => {
    expect(formatClock(0.5, 12)).toBe('Day 12, 12:00')
    expect(formatClock((5 * 60 + 27) / 1440 + 1e-9, 3)).toBe('Day 3, 05:27')
    expect(formatClock(0.99999, 0)).toBe('Day 0, 23:59')
    expect(formatClock(1, 1)).toBe('Day 1, 00:00')
  })
})
