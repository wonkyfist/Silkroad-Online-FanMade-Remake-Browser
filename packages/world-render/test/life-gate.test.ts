/**
 * GL-L, the wildlife's gating (docs/GRASS_LIFE.md §5.1's table; docs/WAVE_PLAN6.md §6.1 GL-L): the counts by time of
 * day, rain and wind, with the weather audio's bird-song hysteresis (apps/game/src/audio/weather.ts: under cover above
 * rain 0.25 or wind 10 m/s, out again below 0.2 / 9); the fireflies keep going in a drizzle below 0.1.
 */
import { describe, expect, it } from 'vitest'
import { LIFE_COUNTS, LIFE_WEATHER, LifeGate, lifePeriod, lifeTargets, noLife, type LifeInputs } from '../src/life/life.ts'

const NOON = 0
const NIGHT = 1
const q = (o: Partial<LifeInputs> = {}): LifeInputs => ({ night: NOON, t: 0.5, quality: 'medium', covered: false, firefliesCovered: false, groundFlocks: true, ...o })

describe('the period of the day (SkyState.night)', () => {
  it('day below 0.2, dawn and dusk to 0.6, night above', () => {
    expect(lifePeriod(0)).toBe('day')
    expect(lifePeriod(0.19)).toBe('day')
    expect(lifePeriod(0.2)).toBe('twilight')
    expect(lifePeriod(0.6)).toBe('twilight')
    expect(lifePeriod(0.61)).toBe('night')
    expect(lifePeriod(1)).toBe('night')
  })
})

describe('the weather gate: the bird-song thresholds with their hysteresis', () => {
  it('the thresholds are the weather audio\'s', () => {
    expect(LIFE_WEATHER).toMatchObject({ rainOn: 0.25, windOn: 10, rainOff: 0.2, windOff: 9 })
  })

  it('rain: under cover above 0.25, still under cover at 0.22, out again below 0.2', () => {
    const g = new LifeGate()
    g.update(0.24, 3)
    expect(g.covered).toBe(false)
    g.update(0.26, 3)
    expect(g.covered).toBe(true)
    g.update(0.22, 3)
    expect(g.covered).toBe(true)
    g.update(0.19, 3)
    expect(g.covered).toBe(false)
  })

  it('wind: under cover above 10 m/s, still at 9.5, out again below 9', () => {
    const g = new LifeGate()
    g.update(0, 9.9)
    expect(g.covered).toBe(false)
    g.update(0, 10.5)
    expect(g.covered).toBe(true)
    g.update(0, 9.5)
    expect(g.covered).toBe(true)
    g.update(0, 8.9)
    expect(g.covered).toBe(false)
  })

  it('fireflies: a drizzle below 0.1 keeps them; above 0.1 they go until below 0.08', () => {
    const g = new LifeGate()
    g.update(0.09, 2)
    expect(g.firefliesCovered).toBe(false)
    expect(g.covered).toBe(false)
    g.update(0.11, 2)
    expect(g.firefliesCovered).toBe(true)
    g.update(0.09, 2)
    expect(g.firefliesCovered).toBe(true)
    g.update(0.07, 2)
    expect(g.firefliesCovered).toBe(false)
  })
})

describe('§5.1\'s table (lifeTargets)', () => {
  it('a clear day: butterflies (Medium 20, High 40), two ground flocks, perchers, fly-overs, dragonflies; no fireflies', () => {
    const m = lifeTargets(q())
    expect(m).toMatchObject({ butterflies: 20, dragonflies: 6, groundFlocks: 2, perchers: 6, flyOvers: 'any', fireflies: 0, fireflyLight: 0, habitatFlocks: true })
    const h = lifeTargets(q({ quality: 'high' }))
    expect(h).toMatchObject({ butterflies: 40, dragonflies: 12, groundFlocks: 2, perchers: 10 })
    expect(lifeTargets(q({ quality: 'ultra' })).butterflies).toBe(40)
    // §5.1's ranges.
    expect(LIFE_COUNTS.flockSize).toEqual([8, 16])
    expect(m.perchers).toBeGreaterThanOrEqual(4)
    expect(h.perchers).toBeLessThanOrEqual(10)
    expect(LIFE_COUNTS.flyOverS).toEqual([30, 90])
  })

  it('dawn and dusk: a few butterflies and dragonflies, one ground flock, perchers; swallows at dusk only', () => {
    const dusk = lifeTargets(q({ night: 0.4, t: 0.76 }))
    expect(dusk.butterflies).toBe(5)
    expect(dusk.dragonflies).toBe(2)
    expect(dusk.groundFlocks).toBe(1)
    expect(dusk.perchers).toBe(6)
    expect(dusk.flyOvers).toBe('fields')
    const dawn = lifeTargets(q({ night: 0.4, t: 0.24 }))
    expect(dawn.flyOvers).toBe('none')
    expect(dawn.butterflies).toBe(5)
  })

  it('night: no butterflies, birds or dragonflies; fireflies from night 0.3, fading in, full above 0.6', () => {
    const n = lifeTargets(q({ night: NIGHT, t: 0 }))
    expect(n).toMatchObject({ butterflies: 0, dragonflies: 0, groundFlocks: 0, perchers: 0, flyOvers: 'none', habitatFlocks: false })
    expect(n.fireflies).toBe(60)
    expect(n.fireflyLight).toBe(1)
    expect(lifeTargets(q({ night: NIGHT, t: 0, quality: 'high' })).fireflies).toBe(120)
    expect(lifeTargets(q({ night: 0.29 })).fireflies).toBe(0)
    const mid = lifeTargets(q({ night: 0.45, t: 0.8 }))
    expect(mid.fireflyLight).toBeCloseTo(0.5, 5)
    expect(mid.fireflies).toBe(60)
  })

  it('rain or wind: nothing but a drizzle\'s fireflies', () => {
    const wet = lifeTargets(q({ covered: true }))
    expect(wet).toMatchObject({ butterflies: 0, dragonflies: 0, groundFlocks: 0, perchers: 0, flyOvers: 'none', habitatFlocks: false })
    const drizzleNight = lifeTargets(q({ night: NIGHT, covered: true, firefliesCovered: false }))
    expect(drizzleNight.fireflies).toBe(60)
    const rainNight = lifeTargets(q({ night: NIGHT, covered: true, firefliesCovered: true }))
    expect(rainNight.fireflies).toBe(0)
    expect(rainNight.fireflyLight).toBe(0)
  })

  it('the stage (groundFlocks: false) keeps everything but the ground flocks', () => {
    const s = lifeTargets(q({ groundFlocks: false }))
    expect(s.groundFlocks).toBe(0)
    expect(s.butterflies).toBe(20)
    expect(s.perchers).toBe(6)
  })

  it('Low draws no life (the Classic path)', () => {
    expect(lifeTargets(q({ quality: 'low' }))).toEqual(noLife())
    expect(lifeTargets(q({ quality: 'low', night: NIGHT }))).toEqual(noLife())
  })

  it('writes into the object it is given (no allocation per frame)', () => {
    const out = noLife()
    expect(lifeTargets(q(), out)).toBe(out)
    expect(out.butterflies).toBe(20)
    lifeTargets(q({ covered: true }), out)
    expect(out.butterflies).toBe(0)
  })

  it('the gate drives the table through a storm and back, with no flicker at the thresholds', () => {
    const g = new LifeGate()
    const out = noLife()
    const seen: number[] = []
    for (const rain of [0, 0.1, 0.24, 0.26, 0.3, 0.24, 0.21, 0.26, 0.19, 0]) {
      g.update(rain, 4)
      seen.push(lifeTargets(q({ covered: g.covered, firefliesCovered: g.firefliesCovered }), out).butterflies)
    }
    expect(seen).toEqual([20, 20, 20, 0, 0, 0, 0, 0, 20, 20])
  })
})
