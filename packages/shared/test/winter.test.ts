/**
 * The snow season (docs/WINTER.md): the season's dates (inclusive, the new-year wrap, the time zone), the snow cover's
 * build-up and melt, the frost, the winter forms of the weather states, the storm table's winter rules and the
 * additive protocol (`winter`, WorldInfo.winter, StormStatus.winter, the snowfall in a start vector).
 */
import { describe, expect, it } from 'vitest'
import {
  BARE,
  CALM_ENV,
  FROST_ICE,
  STORM_TABLE,
  WEATHER_PARAMS,
  WINTER_DEFAULTS,
  WINTER_RATES,
  blendWeather,
  blizzard,
  elementMul,
  fogScale,
  inSeason,
  localMonthDay,
  mudSlowPct,
  nestCountMul,
  nextSeasonChange,
  parseMonthDay,
  parseServerMessage,
  shockMul,
  sightMul,
  snowing,
  stepWinter,
  stormEffects,
  stormLevel,
  stormPhase,
  takesIntensity,
  weatherParams,
  winterKind,
  type StormEnv,
  type WinterState,
  type WinterSync,
} from '../src/index.ts'

const SEASON = { start: '12-01', end: '01-15', timeZone: 'UTC' }
const H = 3_600_000

describe('the season dates (docs/WINTER.md §2)', () => {
  it('parses MM-DD days of the year only', () => {
    expect(parseMonthDay('12-01')).toBe(1201)
    expect(parseMonthDay('01-15')).toBe(115)
    expect(parseMonthDay('02-29')).toBe(229)
    for (const bad of ['2-1', '13-01', '00-10', '04-31', '02-30', '12-1', '1201', '', 'ab-cd']) expect(parseMonthDay(bad), bad).toBeNull()
  })

  it('Dec 1 to Jan 15 inclusive, across the new year', () => {
    expect(inSeason(Date.UTC(2026, 10, 30, 23, 59), SEASON)).toBe(false)
    expect(inSeason(Date.UTC(2026, 11, 1, 0, 0), SEASON)).toBe(true)
    expect(inSeason(Date.UTC(2026, 11, 31, 23, 59), SEASON)).toBe(true)
    expect(inSeason(Date.UTC(2027, 0, 1, 0, 0), SEASON)).toBe(true)
    expect(inSeason(Date.UTC(2027, 0, 15, 23, 59), SEASON)).toBe(true)
    expect(inSeason(Date.UTC(2027, 0, 16, 0, 0), SEASON)).toBe(false)
    expect(inSeason(Date.UTC(2026, 6, 1), SEASON)).toBe(false)
    // a range inside one year
    const feb = { start: '02-01', end: '02-28', timeZone: 'UTC' }
    expect(inSeason(Date.UTC(2027, 1, 14), feb)).toBe(true)
    expect(inSeason(Date.UTC(2027, 2, 1), feb)).toBe(false)
    expect(inSeason(Date.UTC(2026, 11, 14), feb)).toBe(false)
    // a one-day season, and bad dates never
    expect(inSeason(Date.UTC(2026, 11, 24, 12), { ...SEASON, start: '12-24', end: '12-24' })).toBe(true)
    expect(inSeason(Date.UTC(2026, 11, 24, 12), { ...SEASON, start: '13-24' })).toBe(false)
  })

  it('counts days in the given time zone (the server calendar), not UTC', () => {
    // 2026-11-30 23:30 UTC is already Dec 1 in Berlin (UTC+1) and still Nov 30 in New York
    const t = Date.UTC(2026, 10, 30, 23, 30)
    expect(localMonthDay(t, 'Europe/Berlin')).toBe(1201)
    expect(localMonthDay(t, 'America/New_York')).toBe(1130)
    expect(inSeason(t, { ...SEASON, timeZone: 'Europe/Berlin' })).toBe(true)
    expect(inSeason(t, { ...SEASON, timeZone: 'America/New_York' })).toBe(false)
    // the end: Jan 16 05:00 UTC is still Jan 15 in Los Angeles
    const e = Date.UTC(2027, 0, 16, 5, 0)
    expect(inSeason(e, { ...SEASON, timeZone: 'America/Los_Angeles' })).toBe(true)
    expect(inSeason(e, { ...SEASON, timeZone: 'Asia/Tokyo' })).toBe(false)
    // an unknown zone falls back to UTC
    expect(inSeason(Date.UTC(2026, 11, 1, 0, 30), { ...SEASON, timeZone: 'Mars/Olympus' })).toBe(true)
  })

  it('finds the next start or end (to the hour)', () => {
    const c = nextSeasonChange(Date.UTC(2026, 9, 5, 12), SEASON)
    expect(c).toEqual({ at: Date.UTC(2026, 11, 1), begins: true })
    const e = nextSeasonChange(Date.UTC(2026, 11, 20, 7, 30), SEASON)
    expect(e).toEqual({ at: Date.UTC(2027, 0, 16), begins: false })
    expect(nextSeasonChange(0, { ...SEASON, start: 'x' })).toBeNull()
  })

  it('defaults to Dec 1 – Jan 15', () => {
    expect([WINTER_DEFAULTS.start, WINTER_DEFAULTS.end]).toEqual(['12-01', '01-15'])
  })
})

describe('the snow cover and the frost (docs/WINTER.md §2)', () => {
  const day = { season: true, daylight: 1 }
  const night = { season: true, daylight: 0 }
  const snowP = weatherParams('snow')
  const bliz = weatherParams('blizzard')
  const clear = weatherParams('clear')
  const run = (s: WinterState, p: Parameters<typeof stepWinter>[1], c: Parameters<typeof stepWinter>[2], hours: number) => stepWinter(s, p, c, hours * 3600)

  it('the first snowfall eases in over hours: nothing without snow, a dusting after 30 min, full after ~5 h', () => {
    expect(run(BARE, weatherParams('overcast'), day, 12).cover).toBe(0)
    const half = run(BARE, snowP, night, 0.5)
    expect(half.cover).toBeGreaterThan(0.08)
    expect(half.cover).toBeLessThan(0.15)
    expect(run(BARE, snowP, night, 2.5).cover).toBeCloseTo(0.5, 1)
    expect(run(BARE, snowP, night, 5.1).cover).toBe(1)
    // a blizzard is faster (full in 3 h)
    expect(run(BARE, bliz, night, 3.05).cover).toBe(1)
    // light snow is slower
    expect(run(BARE, weatherParams('snow', 0.5), night, 2.5).cover).toBeCloseTo(0.25, 1)
  })

  it('melts slowly on sunny days, not at night, not while it snows; rain washes it away', () => {
    const full: WinterState = { cover: 1, frost: 1 }
    expect(run(full, clear, night, 10).cover).toBe(1)
    const sunny = run(full, clear, day, 8)
    expect(sunny.cover).toBeCloseTo(1 - 8 / 20, 2)
    expect(run(full, weatherParams('overcast'), day, 8).cover).toBeGreaterThan(sunny.cover)
    expect(run(full, snowP, day, 8).cover).toBe(1)
    expect(run(full, weatherParams('rain'), night, 2).cover).toBeCloseTo(1 - 0.55, 2)
    expect(WINTER_RATES.meltSunS).toBe(20 * 3600)
  })

  it('outside the season the cover melts within hours and a GM snow settles at half the rate', () => {
    const warm = { season: false, daylight: 0 }
    expect(run({ cover: 1, frost: 0 }, clear, warm, 1.5).cover).toBeCloseTo(0.5, 2)
    expect(run({ cover: 1, frost: 0 }, clear, warm, 3).cover).toBe(0)
    // a GM blizzard in October whitens at half the rate, and is gone within hours of stopping
    const oct = run(BARE, bliz, warm, 1)
    expect(oct.cover).toBeCloseTo(1 / 6, 3)
    expect(run(oct, clear, warm, 0.6).cover).toBe(0)
    // in the season a blizzard leaves a third of a full cover per hour
    expect(run(BARE, bliz, night, 1).cover).toBeCloseTo(1 / 3, 2)
  })

  it('the frost rises over 4 h in the season (the ponds freeze past FROST_ICE) and falls over 6 h after it', () => {
    expect(run(BARE, clear, day, 1).frost).toBeCloseTo(0.25, 5)
    expect(run(BARE, clear, day, 2.1).frost).toBeGreaterThanOrEqual(FROST_ICE)
    expect(run(BARE, clear, day, 5).frost).toBe(1)
    expect(run({ cover: 0, frost: 1 }, clear, { season: false, daylight: 1 }, 3).frost).toBeCloseTo(0.5, 5)
    expect(run({ cover: 0, frost: 1 }, clear, { season: false, daylight: 1 }, 7).frost).toBe(0)
  })

  it('caps a catch-up at 72 h and is robust to bad input', () => {
    const s = stepWinter(BARE, snowP, night, 1e9)
    expect(s.cover).toBe(1)
    expect(stepWinter({ cover: Number.NaN, frost: 2 }, clear, night, Number.NaN)).toEqual({ cover: 0, frost: 1 })
  })
})

describe('the winter weather states (docs/WINTER.md §3)', () => {
  it('rain falls as snow, a storm is a blizzard; the rest stays', () => {
    expect(winterKind('rain')).toBe('snow')
    expect(winterKind('storm')).toBe('blizzard')
    for (const k of ['clear', 'cloudy', 'overcast', 'fog', 'snow', 'blizzard'] as const) expect(winterKind(k)).toBe(k)
    expect(takesIntensity('snow')).toBe(true)
    expect(takesIntensity('blizzard')).toBe(false)
  })

  it('snow does not wet anything; a blizzard is a whiteout with rare thunder-snow', () => {
    expect(WEATHER_PARAMS.snow.rain).toBe(0)
    expect(WEATHER_PARAMS.blizzard.rain).toBe(0)
    expect(WEATHER_PARAMS.blizzard.snow).toBe(1)
    expect(WEATHER_PARAMS.blizzard.lightning).toBeLessThan(WEATHER_PARAMS.storm.lightning / 10)
    expect(WEATHER_PARAMS.blizzard.lightning).toBeGreaterThan(0)
    for (const k of ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog'] as const) expect(WEATHER_PARAMS[k].snow).toBe(0)
    expect(fogScale(WEATHER_PARAMS.blizzard)).toBeLessThan(0.4)
    expect(fogScale(WEATHER_PARAMS.rain)).toBe(fogScale({ fog: WEATHER_PARAMS.rain.fog, rain: WEATHER_PARAMS.rain.rain }))
    expect(weatherParams('snow', 0.5).snow).toBeCloseTo(0.3, 9)
  })

  it('snowfall lags the clouds like rain, and an older start vector without snow blends from none', () => {
    const t = { start: 0, dur: 100_000, from: 'overcast' as const, to: 'snow' as const, intensity: 1 }
    expect(blendWeather(t, 50_000).snow).toBe(0)
    expect(blendWeather(t, 100_000).snow).toBeCloseTo(0.6, 9)
    const { snow: _s, ...old } = WEATHER_PARAMS.overcast
    expect(blendWeather(t, 80_000, old as typeof WEATHER_PARAMS.overcast).snow).toBeGreaterThan(0)
    expect(Number.isFinite(blendWeather(t, 80_000, old as typeof WEATHER_PARAMS.overcast).snow)).toBe(true)
  })
})

describe('storms in winter (docs/WINTER.md §4)', () => {
  const env = (over: Partial<StormEnv> = {}): StormEnv => ({ ...CALM_ENV, ...over })
  const SNOW = env({ snow: 0.6, storm: stormLevel(WEATHER_PARAMS.snow) })
  const BLIZZARD = env({ snow: 1, storm: stormLevel(WEATHER_PARAMS.blizzard), windMs: 14, frozen: true, night: 0 })

  it('a blizzard is a full storm; snow is not', () => {
    expect(stormLevel(WEATHER_PARAMS.blizzard)).toBe(1)
    expect(stormLevel(WEATHER_PARAMS.snow)).toBe(0)
    expect(stormPhase(BLIZZARD, false)).toBe('storm')
    expect(stormPhase(SNOW, false)).toBe('rain')
    expect(blizzard(BLIZZARD)).toBe(true)
    expect(blizzard(SNOW)).toBe(false)
    expect(snowing(SNOW)).toBe(true)
  })

  it('snow: sight drops, fire weaker and cold stronger, lightning unchanged; nobody gets wet', () => {
    expect(sightMul(SNOW)).toBeLessThan(1)
    expect(elementMul(SNOW, 'fire')).toBeLessThan(1)
    expect(elementMul(SNOW, 'cold')).toBeGreaterThan(1)
    expect(elementMul(SNOW, 'lightning')).toBe(1)
    expect(shockMul(SNOW)).toBe(1)
    expect(mudSlowPct(SNOW)).toBe(0)
    expect(stormEffects(SNOW).map((e) => e.id)).toEqual(['sight', 'fire', 'cold', 'snow'])
  })

  it('a blizzard: the storm effects, drifts instead of mud, no water spirits under the ice', () => {
    expect(mudSlowPct(BLIZZARD)).toBe(STORM_TABLE.driftSlowPct)
    expect(nestCountMul(BLIZZARD, 'water')).toBe(1)
    expect(nestCountMul({ ...BLIZZARD, frozen: false }, 'water')).toBeGreaterThan(1)
    const ids = stormEffects(BLIZZARD).map((e) => e.id)
    expect(ids).toContain('drifts')
    expect(ids).toContain('undead')
    expect(ids).toContain('snow')
    expect(ids).not.toContain('wet')
    expect(ids).not.toContain('mud')
    expect(ids).not.toContain('water')
  })
})

describe('the winter wire (docs/WINTER.md §5)', () => {
  const winter: WinterSync = { season: true, cover: 0.42, frost: 1, at: 1_790_000_000_000, strength: 1, start: '12-01', end: '01-15', timeZone: 'Europe/Berlin' }
  const parse = (m: unknown) => parseServerMessage(JSON.stringify(m))
  const enter = (world: Record<string, unknown>) =>
    JSON.stringify({ t: 'worldEnter', self: { id: 1, kind: 'mob', name: 'M', model: 'MOB_CH_MANGNYANG', level: 1, pos: [0, 0, 0], yaw: 0 }, world: { name: 'jangan', serverTime: 1, tickRate: 10, ...world }, entities: [] })

  it('round-trips `winter`, its preview flag and WorldInfo.winter', () => {
    expect(parse({ t: 'winter', winter })).toEqual({ ok: true, msg: { t: 'winter', winter } })
    const p = { ...winter, preview: true as const }
    expect(parse({ t: 'winter', winter: p })).toEqual({ ok: true, msg: { t: 'winter', winter: p } })
    const r = parseServerMessage(enter({ winter }))
    expect(r.ok && r.msg.t === 'worldEnter' && r.msg.world.winter).toEqual(winter)
    // unknown keys dropped
    const x = parse({ t: 'winter', winter: { ...winter, extra: 1 } })
    expect(x.ok && x.msg.t === 'winter' && 'extra' in x.msg.winter).toBe(false)
  })

  it('rejects a malformed `winter`; a malformed WorldInfo.winter drops only that field', () => {
    for (const bad of [{ cover: 1.2 }, { frost: -0.1 }, { start: '12-1' }, { end: '1-15' }, { strength: 2 }, { season: 'yes' }, { timeZone: '' }, { at: 'now' }]) {
      expect(parse({ t: 'winter', winter: { ...winter, ...bad } }).ok, JSON.stringify(bad)).toBe(false)
    }
    const r = parseServerMessage(enter({ winter: { ...winter, cover: 3 } }))
    expect(r.ok && r.msg.t === 'worldEnter' && 'winter' in r.msg.world).toBe(false)
    expect(r.ok).toBe(true)
  })

  it('weather snow / blizzard, the snowfall in a start vector (absent from an older server = 0), StormStatus.winter', () => {
    const w = { start: 1, dur: 60_000, from: 'overcast', to: 'blizzard', intensity: 1, until: 2, windDir: 1, windMs: 14, wet: 0, puddle: 0, at: 1, seed: 7 }
    expect(parse({ t: 'weather', weather: w }).ok).toBe(true)
    expect(parse({ t: 'weather', weather: { ...w, to: 'snow', intensity: 0.5 } }).ok).toBe(true)
    const { snow: _s, ...old } = WEATHER_PARAMS.overcast
    const o = parse({ t: 'weather', weather: { ...w, fromVec: old } })
    expect(o.ok && o.msg.t === 'weather' && o.msg.weather.fromVec?.snow).toBe(0)
    const n = parse({ t: 'weather', weather: { ...w, fromVec: WEATHER_PARAMS.snow } })
    expect(n.ok && n.msg.t === 'weather' && n.msg.weather.fromVec?.snow).toBe(0.6)
    const s = parse({ t: 'storm', storm: { phase: 'storm', effects: [{ id: 'drifts', pct: -10 }, { id: 'snow' }], winter: true } })
    expect(s.ok && s.msg.t === 'storm' && s.msg.storm.winter).toBe(true)
  })
})
