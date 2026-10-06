import { describe, expect, it } from 'vitest'
import {
  CALM_ENV,
  STORM_EFFECT_IDS,
  STORM_TABLE,
  WEATHER_PARAMS,
  elementMul,
  elementOf,
  mobDamageMul,
  mobRangeMul,
  mobSpeedMul,
  mudSlowPct,
  nestCountMul,
  nightFogAdd,
  nightness,
  panics,
  parseServerMessage,
  shockMul,
  sightMul,
  stormEffects,
  stormLevel,
  stormMobKind,
  stormPhase,
  strong,
  weatherParams,
  windMiss,
  type StormEnv,
} from '../src/index.ts'

const env = (over: Partial<StormEnv> = {}): StormEnv => ({ ...CALM_ENV, ...over })
const RAIN = env({ rain: 1, wet: 1 })
const STORM = env({ rain: 1, storm: 1, windMs: 13, wet: 1 })
const NIGHT_STORM = env({ rain: 1, storm: 1, windMs: 13, wet: 1, night: 1 })

describe('storm effects table (docs/WEATHER.md §12.6)', () => {
  it('reads the storm level off the blended lightning rate: storm 1, heavy rain far below, clear 0', () => {
    expect(stormLevel(WEATHER_PARAMS.storm)).toBe(1)
    expect(stormLevel(weatherParams('rain', 1))).toBeLessThan(STORM_TABLE.stormLevelMin)
    expect(stormLevel(WEATHER_PARAMS.clear)).toBe(0)
    expect(nightness(0.5)).toBe(0)
    expect(nightness(-0.5)).toBe(1)
  })

  it('classifies the monsters (uniques and unknown ones are other)', () => {
    expect(stormMobKind('MOB_CH_STONEGHOST')).toBe('undead')
    expect(stormMobKind('MOB_CH_YEOHA_CLON')).toBe('undead')
    expect(stormMobKind('MOB_CH_BIGEYEGHOST')).toBe('undead')
    expect(stormMobKind('MOB_WC_HYUNGNO')).toBe('undead')
    expect(stormMobKind('MOB_CH_WATERGHOST_CLON')).toBe('water')
    expect(stormMobKind('MOB_CH_MANGNYANG')).toBe('critter')
    expect(stormMobKind('MOB_WC_GHOSTBUG')).toBe('critter')
    expect(stormMobKind('MOB_CH_TIGER')).toBe('predator')
    expect(stormMobKind('MOB_CH_WHITETIGER_CLON')).toBe('predator')
    expect(stormMobKind('MOB_CH_BANDITARCHER_CLON')).toBe('bandit')
    expect(stormMobKind('MOB_CH_TIGERWOMAN')).toBe('other')
    expect(stormMobKind('MOB_CH_STONEGHOST', true)).toBe('other')
    expect(stormMobKind('MOB_CH_CHAKJI')).toBe('other')
    expect(panics('critter') && panics('predator')).toBe(true)
    expect(panics('undead') || panics('bandit') || panics('water') || panics('other')).toBe(false)
  })

  it('rain: sight ×0.6 in a downpour (scaled by the rain), fire weaker, lightning and cold stronger, wet players; nothing when calm', () => {
    expect(sightMul(CALM_ENV)).toBe(1)
    expect(sightMul(RAIN)).toBeCloseTo(0.6, 9)
    expect(sightMul(env({ rain: 0.55 }))).toBeCloseTo(1 - 0.4 * 0.55, 9)
    expect(sightMul(env({ rain: 0.1 }))).toBe(1) // below rainMin
    expect(elementMul(RAIN, 'fire')).toBeCloseTo(0.75, 9)
    expect(elementMul(RAIN, 'lightning')).toBeCloseTo(1.25, 9)
    expect(elementMul(RAIN, 'cold')).toBeCloseTo(1.15, 9)
    expect(elementMul(RAIN, null)).toBe(1)
    for (const e of ['fire', 'lightning', 'cold'] as const) expect(elementMul(CALM_ENV, e)).toBe(1)
    expect(elementOf('FIRE')).toBe('fire')
    expect(elementOf('BICHEON')).toBeNull()
    expect(shockMul(RAIN)).toBeCloseTo(1.2, 9)
    expect(shockMul(CALM_ENV)).toBe(1)
  })

  it('mud on a soaked ground, wind spread for ranged attacks', () => {
    expect(mudSlowPct(env({ wet: 0.59 }))).toBe(0)
    expect(mudSlowPct(env({ wet: 0.6 }))).toBe(10)
    expect(windMiss(env({ windMs: 5 }))).toBe(0)
    expect(windMiss(env({ windMs: 13 }))).toBeCloseTo(0.2, 9)
    expect(windMiss(env({ windMs: 10.5 }))).toBeCloseTo(0.1, 9)
  })

  it('storm: undead faster and harder, bandits pull back, nests change; not in plain rain', () => {
    expect(mobSpeedMul(STORM, 'undead')).toBeCloseTo(1.25, 9)
    expect(mobDamageMul(STORM, 'undead')).toBeCloseTo(1.25, 9)
    expect(mobSpeedMul(RAIN, 'undead')).toBe(1)
    expect(mobDamageMul(STORM, 'predator')).toBe(1)
    expect(mobRangeMul(STORM, 'bandit')).toEqual({ leash: 0.5, roam: 0.4 })
    expect(mobRangeMul(RAIN, 'bandit')).toEqual({ leash: 1, roam: 1 })
    expect(nestCountMul(STORM, 'water')).toBeCloseTo(1.6, 9)
    expect(nestCountMul(STORM, 'critter')).toBeCloseTo(0.4, 9)
    expect(nestCountMul(STORM, 'predator')).toBeCloseTo(1.5, 9)
    expect(nestCountMul(STORM, 'undead')).toBe(1)
    expect(nestCountMul(RAIN, 'water')).toBe(1)
  })

  it('a night storm blinds: less sight, extra fog; by day none', () => {
    expect(sightMul(NIGHT_STORM)).toBeCloseTo(0.6 * 0.75, 9)
    expect(nightFogAdd(NIGHT_STORM)).toBeCloseTo(0.3, 9)
    expect(nightFogAdd(STORM)).toBe(0)
    expect(nightFogAdd(env({ night: 1 }))).toBe(0)
  })

  it('strength scales every multiplier away from 1 (0 = nothing, 2 = twice)', () => {
    expect(strong(1.25, 0)).toBe(1)
    expect(strong(1.25, 2)).toBeCloseTo(1.5, 9)
    expect(strong(0.4, 2)).toBe(0) // 1 - 1.2, clamped at 0
    const off = { ...NIGHT_STORM, strength: 0 }
    expect(sightMul(off)).toBe(1)
    expect(mobDamageMul(off, 'undead')).toBe(1)
    expect(elementMul(off, 'fire')).toBe(1)
    expect(mudSlowPct(off)).toBe(0)
    expect(windMiss(off)).toBe(0)
    expect(stormEffects(off)).toEqual([])
    expect(sightMul({ ...RAIN, strength: 2 })).toBeCloseTo(0.2, 9)
  })

  it('lists the effects the icon shows, in order, with signed percents', () => {
    expect(stormEffects(CALM_ENV)).toEqual([])
    const rain = stormEffects(RAIN).map((e) => e.id)
    expect(rain).toEqual(['wet', 'sight', 'fire', 'lightning', 'cold', 'mud'])
    const storm = stormEffects(NIGHT_STORM)
    expect(storm.map((e) => e.id)).toEqual(STORM_EFFECT_IDS.filter((id) => id !== 'snow' && id !== 'drifts'))
    const pct = Object.fromEntries(storm.map((e) => [e.id, e.pct]))
    expect(pct).toMatchObject({ wet: 20, sight: -55, fire: -25, lightning: 25, cold: 15, mud: -10, wind: 20, night: -25, undead: 25, water: 60, critters: -60, packs: 50, bandits: -50, charged: 30 })
    expect(pct.panic).toBeUndefined()
    expect(stormPhase(CALM_ENV, false)).toBe('calm')
    expect(stormPhase(CALM_ENV, true)).toBe('forecast')
    expect(stormPhase(RAIN, false)).toBe('rain')
    expect(stormPhase(STORM, true)).toBe('storm')
  })
})

describe('storm protocol (docs/PROTOCOL.md "Weather")', () => {
  const parse = (m: unknown) => parseServerMessage(JSON.stringify(m))

  it('takes `storm`, `stormArc`, the charged flag and the arc cause', () => {
    const storm = { phase: 'storm', startsAt: 5, endsAt: 1000, effects: stormEffects(NIGHT_STORM) }
    expect(parse({ t: 'storm', storm })).toEqual({ ok: true, msg: { t: 'storm', storm } })
    expect(parse({ t: 'storm', storm: { phase: 'calm', effects: [] } }).ok).toBe(true)
    expect(parse({ t: 'stormArc', from: 3, to: 4, at: 100, mob: 9 })).toEqual({ ok: true, msg: { t: 'stormArc', from: 3, to: 4, at: 100, mob: 9 } })
    expect(parse({ t: 'entityUpdate', id: 5, charged: true })).toEqual({ ok: true, msg: { t: 'entityUpdate', id: 5, charged: true } })
    expect(parse({ t: 'entityUpdate', id: 5, charged: false })).toEqual({ ok: true, msg: { t: 'entityUpdate', id: 5, charged: false } })
    const combat = { t: 'combat', attacker: 0, target: 5, hits: [{ outcome: 'hit', damage: 3, hp: 7 }], cause: 'arc' }
    expect(parse(combat)).toEqual({ ok: true, msg: combat })
  })

  it('refuses a bad phase, an unknown effect, a percent out of range, a bad arc', () => {
    expect(parse({ t: 'storm', storm: { phase: 'hail', effects: [] } }).ok).toBe(false)
    expect(parse({ t: 'storm', storm: { phase: 'storm', effects: [{ id: 'frogs' }] } }).ok).toBe(false)
    expect(parse({ t: 'storm', storm: { phase: 'storm', effects: [{ id: 'wet', pct: 5000 }] } }).ok).toBe(false)
    expect(parse({ t: 'storm', storm: { phase: 'storm', effects: [{ id: 'wet', pct: 2.5 }] } }).ok).toBe(false)
    expect(parse({ t: 'stormArc', from: 0, to: 4, at: 1 }).ok).toBe(false)
    expect(parse({ t: 'stormArc', from: 3, to: 4 }).ok).toBe(false)
    expect(parse({ t: 'combat', attacker: 0, target: 5, hits: [{ outcome: 'hit', damage: 3, hp: 7 }], cause: 'flood' }).ok).toBe(false)
  })
})
