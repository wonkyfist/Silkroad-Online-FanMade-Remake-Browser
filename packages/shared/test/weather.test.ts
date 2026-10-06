import { describe, expect, it, vi } from 'vitest'
import {
  CLOCK_EPOCH_DAYS,
  CLOCK_EPOCH_MS,
  DEFAULT_CLOCK,
  PUDDLE_FILL_S,
  PUDDLE_RAIN_MIN,
  WEATHER_EPOCH,
  WEATHER_KINDS,
  WEATHER_PARAMS,
  WeatherSchedule,
  blendWeather,
  flashAt,
  fogScale,
  mulberry32,
  nearestWeather,
  parseServerMessage,
  scheduleAt,
  stepSurface,
  transitionMs,
  weatherParams,
  zoneClimate,
  type ServerMessage,
  type WeatherKind,
  type WeatherSync,
  type WorldClockState,
} from '../src/index.ts'

const DAY = 86_400_000

describe('the seeded schedule (docs/WEATHER.md §2.3)', () => {
  it('is deterministic: the same seed gives the same segments, a restart at any time the same answer', () => {
    const a = new WeatherSchedule(1)
    const b = new WeatherSchedule(1)
    const times = Array.from({ length: 50 }, (_, i) => WEATHER_EPOCH + i * 3.7 * 3_600_000)
    for (const t of times) expect(a.at(t)).toEqual(b.at(t))
    // a "restarted" server: a fresh walk, and a cache asked backwards, land on the same segment
    for (const t of [times[40], times[3], times[25]]) {
      expect(scheduleAt(1, t)).toEqual(a.at(t))
      expect(a.at(t).start).toBeLessThanOrEqual(t)
      expect(a.at(t).end).toBeGreaterThan(t)
    }
    expect(scheduleAt(2, times[30])).not.toEqual(scheduleAt(1, times[30]))
  })

  it('segments chain: each starts where the last ended, names its predecessor, stays in its dwell range', () => {
    const s = new WeatherSchedule(7)
    let seg = s.at(WEATHER_EPOCH)
    expect(seg.index).toBe(0)
    expect(seg.kind).toBe('clear')
    for (let i = 0; i < 500; i++) {
      const n = s.next(seg)
      expect(n.start).toBe(seg.end)
      expect(n.prev).toBe(seg.kind)
      expect(n.index).toBe(seg.index + 1)
      const minutes = (n.end - n.start) / 60_000
      expect(minutes).toBeGreaterThanOrEqual({ clear: 20, cloudy: 15, overcast: 12, rain: 8, storm: 5, fog: 10, snow: 8, blizzard: 5 }[n.kind] - 0.001)
      expect(minutes).toBeLessThanOrEqual({ clear: 45, cloudy: 35, overcast: 30, rain: 20, storm: 12, fog: 25, snow: 20, blizzard: 12 }[n.kind] + 0.001)
      expect(n.intensity).toBe(n.kind === 'rain' ? n.intensity : 1)
      if (n.kind === 'rain') expect(n.intensity).toBeGreaterThanOrEqual(0.4)
      expect(n.seed).toBe(n.seed >>> 0)
      expect(n.windDir).toBeGreaterThanOrEqual(0)
      expect(n.windDir).toBeLessThan(Math.PI * 2)
      seg = n
    }
  })

  it('60-day shares are within ±3 points of the measured table', () => {
    const target: Record<WeatherKind, number> = { clear: 33.1, cloudy: 30.5, overcast: 22.4, rain: 9.9, storm: 0.9, fog: 3.1, snow: 0, blizzard: 0 }
    for (const seed of [1, 2, 3]) {
      const s = new WeatherSchedule(seed)
      const end = WEATHER_EPOCH + 60 * DAY
      const share = Object.fromEntries(WEATHER_KINDS.map((k) => [k, 0])) as Record<WeatherKind, number>
      for (let seg = s.at(WEATHER_EPOCH); seg.start < end; seg = s.next(seg)) share[seg.kind] += Math.min(seg.end, end) - seg.start
      for (const k of WEATHER_KINDS) expect(Math.abs((100 * share[k]) / (60 * DAY) - target[k])).toBeLessThanOrEqual(3)
    }
  })

  it('WEATHER_RAIN_SCALE raises the rain share; 0 removes rain and storms', () => {
    const rainShare = (rainScale: number) => {
      const s = new WeatherSchedule(1, { rainScale })
      const end = WEATHER_EPOCH + 60 * DAY
      let wet = 0
      for (let seg = s.at(WEATHER_EPOCH); seg.start < end; seg = s.next(seg)) if (seg.kind === 'rain' || seg.kind === 'storm') wet += seg.end - seg.start
      return wet / (60 * DAY)
    }
    expect(rainShare(2)).toBeGreaterThan(rainShare(1) + 0.04)
    expect(rainShare(0)).toBe(0)
  })
})

describe('blending (docs/WEATHER.md §2.2)', () => {
  const sync = (from: WeatherKind, to: WeatherKind, intensity = 1): WeatherSync => ({
    start: 1000, dur: 100_000, from, to, intensity, until: 0, windDir: 0, windMs: 2, wet: 0, puddle: 0, at: 1000, seed: 1,
  })

  it('hits the endpoints: P[from] before the start, P[to] after the end', () => {
    const s = sync('clear', 'storm')
    expect(blendWeather(s, 0)).toEqual(WEATHER_PARAMS.clear)
    expect(blendWeather(s, 101_000)).toEqual(WEATHER_PARAMS.storm)
    expect(blendWeather({ ...s, dur: 0 }, 1000)).toEqual(WEATHER_PARAMS.storm)
  })

  it('rain lags the clouds: none before k = 0.55 when it starts, gone by k = 0.45 when it stops', () => {
    const starting = sync('overcast', 'rain')
    const k = (x: number) => {
      // invert smoothstep(0, 1, x) by bisection: the time at which the blend factor is x
      let lo = 0
      let hi = 1
      for (let i = 0; i < 40; i++) {
        const m = (lo + hi) / 2
        if (m * m * (3 - 2 * m) < x) lo = m
        else hi = m
      }
      return 1000 + lo * 100_000
    }
    expect(blendWeather(starting, k(0.5)).rain).toBe(0)
    expect(blendWeather(starting, k(0.5)).cloud).toBeGreaterThan(WEATHER_PARAMS.overcast.cloud)
    expect(blendWeather(starting, k(0.8)).rain).toBeGreaterThan(0)
    const stopping = sync('rain', 'cloudy')
    expect(blendWeather(stopping, k(0.2)).rain).toBeGreaterThan(0)
    expect(blendWeather(stopping, k(0.5)).rain).toBe(0)
    expect(blendWeather(stopping, k(0.5)).cloud).toBeGreaterThan(WEATHER_PARAMS.cloudy.cloud)
    // fog creeps in
    expect(blendWeather(sync('clear', 'fog'), k(0.15)).fog).toBe(0)
  })

  it('starts from the current vector when one is given, and light rain scales rain, darkness and lightning', () => {
    const cur = { ...WEATHER_PARAMS.cloudy, cloud: 0.7 }
    expect(blendWeather(sync('clear', 'overcast'), 0, cur).cloud).toBe(0.7)
    const light = weatherParams('rain', 0.5)
    expect(light.rain).toBeCloseTo(0.275, 12)
    expect(light.cloudDark).toBeCloseTo(0.275, 12)
    expect(light.lightning).toBe(0)
    expect(weatherParams('rain', 0.9).lightning).toBeCloseTo(0.27, 12)
    expect(blendWeather(sync('clear', 'rain', 0.5), 200_000).rain).toBeCloseTo(0.275, 12)
    expect(nearestWeather(WEATHER_PARAMS.fog)).toBe('fog')
    expect(nearestWeather({ ...WEATHER_PARAMS.storm, windMs: 12 })).toBe('storm')
  })

  it('transition lengths: 120 s, 60 s into storm, 180 s into or out of fog', () => {
    expect(transitionMs('clear', 'cloudy')).toBe(120_000)
    expect(transitionMs('rain', 'storm')).toBe(60_000)
    expect(transitionMs('fog', 'clear')).toBe(180_000)
    expect(transitionMs('cloudy', 'fog')).toBe(180_000)
    expect(transitionMs('rain', 'rain')).toBe(0)
  })
})

describe('stepSurface (docs/WEATHER.md §6.1, corrected)', () => {
  const run = (s: { wet: number; puddle: number }, p: Parameters<typeof stepSurface>[1], until: (s: { wet: number; puddle: number }) => boolean) => {
    let n = 0
    while (!until(s) && n < 7200) {
      s = stepSurface(s, p, 1)
      n++
    }
    return { s, n }
  }

  it('soaks to 0.9 in 80–100 s at rain 1', () => {
    const { n } = run({ wet: 0, puddle: 0 }, { rain: 1, sun: 0.15, windMs: 13 }, (s) => s.wet >= 0.9)
    expect(n).toBeGreaterThanOrEqual(80)
    expect(n).toBeLessThanOrEqual(100)
  })

  it('dries from 1 to 0 in 8.5–10 min at sun 1 and wind 2 m/s', () => {
    const { n } = run({ wet: 1, puddle: 0 }, { rain: 0, sun: 1, windMs: 2 }, (s) => s.wet <= 0)
    expect(n / 60).toBeGreaterThanOrEqual(8.5)
    expect(n / 60).toBeLessThanOrEqual(10)
  })

  it('keeps puddles at most wet + 0.1 on every step, growing or draining', () => {
    let s = { wet: 0, puddle: 0 }
    const phases: [Parameters<typeof stepSurface>[1], number][] = [
      [WEATHER_PARAMS.storm, 400], [WEATHER_PARAMS.rain, 300], [WEATHER_PARAMS.clear, 1500], [WEATHER_PARAMS.overcast, 600],
    ]
    let maxPuddle = 0
    for (const [p, secs] of phases) {
      for (let i = 0; i < secs; i++) {
        s = stepSurface(s, p, 1)
        expect(s.puddle).toBeLessThanOrEqual(s.wet + 0.1 + 1e-12)
        expect(s.wet).toBeGreaterThanOrEqual(0)
        expect(s.wet).toBeLessThanOrEqual(1)
        maxPuddle = Math.max(maxPuddle, s.puddle)
      }
    }
    expect(maxPuddle).toBeGreaterThan(0.9) // a storm fills them
    expect(stepSurface({ wet: 0.2, puddle: 0.9 }, WEATHER_PARAMS.clear, 0)).toEqual({ wet: 0.2, puddle: 0.30000000000000004 })
  })

  it('RAIN-P: puddles show within about a minute of rain and fill within a few minutes; a drizzle barely fills them', () => {
    // The terrain's deepest basins show at a puddle level of ≈ 0.1–0.17 (terrain-plugin.ts PUDDLE_THRESHOLD).
    const first = (rain: number) => run({ wet: 0, puddle: 0 }, { rain, sun: 0.2, windMs: 6 }, (s) => s.puddle >= 0.17).n
    const full = (rain: number) => run({ wet: 0, puddle: 0 }, { rain, sun: 0.2, windMs: 6 }, (s) => s.puddle >= 0.95).n
    expect(first(WEATHER_PARAMS.storm.rain)).toBeLessThanOrEqual(30)
    expect(first(WEATHER_PARAMS.rain.rain)).toBeLessThanOrEqual(60)
    expect(full(WEATHER_PARAMS.storm.rain) / 60).toBeLessThanOrEqual(3)
    expect(full(WEATHER_PARAMS.rain.rain) / 60).toBeGreaterThanOrEqual(4)
    expect(full(WEATHER_PARAMS.rain.rain) / 60).toBeLessThanOrEqual(6)
    // after 3 min of the `rain` state the puddles are half full; a drizzle (light rain at 0.4) is still below the first basins
    let s = { wet: 0, puddle: 0 }
    s = stepSurface(s, WEATHER_PARAMS.rain, 180)
    expect(s.puddle).toBeGreaterThan(0.45)
    expect(s.puddle).toBeLessThan(0.7)
    const drizzle = stepSurface({ wet: 0, puddle: 0 }, weatherParams('rain', 0.4), 180)
    expect(drizzle.puddle).toBeLessThan(0.12)
    expect(PUDDLE_RAIN_MIN).toBeLessThan(weatherParams('rain', 0.4).rain)
    expect(PUDDLE_FILL_S).toBe(150)
  })

  it('RAIN-P: the puddles dry after the rain (gone within 20 min of sun, never above wet + 0.1)', () => {
    let s = stepSurface({ wet: 0, puddle: 0 }, WEATHER_PARAMS.storm, 300)
    expect(s.puddle).toBeGreaterThan(0.95)
    const { n } = run(s, WEATHER_PARAMS.clear, (x) => x.puddle <= 0)
    expect(n / 60).toBeGreaterThan(8)
    expect(n / 60).toBeLessThan(20)
    s = stepSurface(s, WEATHER_PARAMS.cloudy, 240)
    expect(s.puddle).toBeLessThanOrEqual(s.wet + 0.1 + 1e-12)
  })

  it('one long step equals many 1 s steps, and a dry world stays dry', () => {
    let a = { wet: 1, puddle: 0.8 }
    for (let i = 0; i < 300; i++) a = stepSurface(a, WEATHER_PARAMS.cloudy, 1)
    expect(stepSurface({ wet: 1, puddle: 0.8 }, WEATHER_PARAMS.cloudy, 300)).toEqual(a)
    expect(stepSurface({ wet: 0, puddle: 0 }, WEATHER_PARAMS.clear, 1e9)).toEqual({ wet: 0, puddle: 0 })
  })
})

describe('fog, flash, zones, PRNG', () => {
  it('fogScale: clear 1, storm ≈ 0.53, fog ≈ 0.45 (Jangan noon 250 m → ≈130 m / ≈110 m)', () => {
    expect(fogScale(WEATHER_PARAMS.clear)).toBe(1)
    expect(fogScale(WEATHER_PARAMS.storm) * 250).toBeCloseTo(132.7, 1)
    expect(fogScale(WEATHER_PARAMS.fog) * 250).toBeCloseTo(111.9, 1)
    expect(fogScale({ fog: 1, rain: 1 })).toBeCloseTo(0.35 * 0.75, 12)
    // swamp fog: the zone adds 0.25 fog
    expect(fogScale({ fog: WEATHER_PARAMS.fog.fog + zoneClimate('Swamp area').fogAdd, rain: 0 }) * 250).toBeCloseTo(87.5, 1)
  })

  it('flashAt: 0 before the strike, 3 at it, three pulses, gone after a second', () => {
    const strike = { at: 1_000_000 }
    expect(flashAt(strike, 999_999)).toBe(0)
    expect(flashAt(strike, 1_000_000)).toBe(3)
    expect(flashAt(strike, 1_000_080)).toBeLessThan(1)
    const peaks = [100, 110, 120, 130, 140].map((d) => flashAt(strike, 1_000_000 + d))
    expect(Math.max(...peaks)).toBeGreaterThan(1.2) // the second pulse
    expect(flashAt(strike, 1_002_000)).toBe(0)
    for (let d = 0; d < 1000; d += 7) expect(flashAt(strike, 1_000_000 + d)).toBeLessThanOrEqual(3)
  })

  it('zone climate: named zones, neutral otherwise', () => {
    expect(zoneClimate('Swamp area').wetFloor).toBe(0.35)
    expect(zoneClimate('North-Tiger Mt.').windMul).toBe(1.4)
    expect(zoneClimate('')).toEqual({ rainMul: 1, fogAdd: 0, windMul: 1, wetFloor: 0 })
    expect(zoneClimate(null).rainMul).toBe(1)
    expect(zoneClimate('toString').rainMul).toBe(1)
  })

  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 1000; i++) {
      const x = a()
      expect(x).toBe(b())
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })
})

describe('validators (docs/WAVE_PLAN3.md §3.4)', () => {
  const clock: WorldClockState = { anchorMs: CLOCK_EPOCH_MS, anchorDays: CLOCK_EPOCH_DAYS, ...DEFAULT_CLOCK }
  const weather: WeatherSync = {
    start: 1_790_000_000_000, dur: 60_000, from: 'overcast', to: 'rain', intensity: 0.7, until: 1_790_000_900_000,
    windDir: 1.2, windMs: 6, wet: 0.4, puddle: 0.1, at: 1_790_000_000_500, seed: 4_000_000_000, gm: true,
  }
  const enter = (world: Record<string, unknown>) =>
    JSON.stringify({
      t: 'worldEnter',
      self: { id: 1, kind: 'mob', name: 'Mangnyang', model: 'MOB_CH_MANGNYANG', level: 1, pos: [0, 0, 0], yaw: 0 },
      world: { name: 'jangan', serverTime: 1, tickRate: 10, ...world },
      entities: [],
    })
  const parse = (m: unknown) => parseServerMessage(JSON.stringify(m))

  it('round-trips worldClock, weather, lightning and the worldEnter fields', () => {
    const msgs: ServerMessage[] = [
      { t: 'worldClock', clock },
      { t: 'weather', weather },
      { t: 'lightning', at: 1_790_000_000_000, distM: 600, bearing: 3.1 },
    ]
    for (const m of msgs) expect(parse(m)).toEqual({ ok: true, msg: m })
    const { gm: _gm, ...plain } = weather
    expect(parse({ t: 'weather', weather: plain })).toEqual({ ok: true, msg: { t: 'weather', weather: plain } })
    const r = parseServerMessage(enter({ clock, weather }))
    expect(r.ok && r.msg.t === 'worldEnter' && r.msg.world.clock).toEqual(clock)
    expect(r.ok && r.msg.t === 'worldEnter' && r.msg.world.weather).toEqual(weather)
    // an older server: neither field
    const old = parseServerMessage(enter({}))
    expect(old.ok && old.msg.t === 'worldEnter' && 'clock' in old.msg.world).toBe(false)
  })

  it('rejects malformed clock, weather and lightning frames', () => {
    const bad: unknown[] = [
      { t: 'worldClock', clock: { ...clock, dayMs: 59_999 } },
      { t: 'worldClock', clock: { ...clock, dayMs: 1.5e6 + 0.5 } },
      { t: 'worldClock', clock: { ...clock, nightSpeedup: 0.61 } },
      { t: 'worldClock', clock: { ...clock, declination: 24 } },
      { t: 'worldClock', clock: { ...clock, anchorDays: -1 } },
      { t: 'worldClock', clock: { ...clock, running: 1 } },
      { t: 'worldClock', clock: { ...clock, anchorMs: undefined } },
      { t: 'worldClock' },
      { t: 'weather', weather: { ...weather, to: 'hail' } },
      { t: 'weather', weather: { ...weather, from: 'Clear' } },
      { t: 'weather', weather: { ...weather, dur: 600_001 } },
      { t: 'weather', weather: { ...weather, intensity: 0.3 } },
      { t: 'weather', weather: { ...weather, windMs: 31 } },
      { t: 'weather', weather: { ...weather, windDir: -0.1 } },
      { t: 'weather', weather: { ...weather, wet: 1.01 } },
      { t: 'weather', weather: { ...weather, puddle: Number.NaN } },
      { t: 'weather', weather: { ...weather, seed: 2 ** 32 } },
      { t: 'weather', weather: { ...weather, seed: 1.5 } },
      { t: 'weather', weather: { ...weather, gm: 'yes' } },
      { t: 'lightning', at: 1, distM: 99, bearing: 0 },
      { t: 'lightning', at: 1, distM: 3001, bearing: 0 },
      { t: 'lightning', at: 1, distM: 500, bearing: 7 },
      { t: 'lightning', at: 'now', distM: 500, bearing: 1 },
    ]
    for (const m of bad) expect(parse(m).ok, JSON.stringify(m)).toBe(false)
  })

  it('a bad clock or weather inside worldInfo drops only that field (with a warning), not the worldEnter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = parseServerMessage(enter({ clock: { ...clock, dayMs: 5 }, weather, levelCap: 20 }))
      expect(r.ok).toBe(true)
      if (!r.ok || r.msg.t !== 'worldEnter') throw new Error('expected worldEnter')
      expect(r.msg.world.clock).toBeUndefined()
      expect(r.msg.world.weather).toEqual(weather)
      expect(r.msg.world.levelCap).toBe(20)
      const r2 = parseServerMessage(enter({ clock, weather: { ...weather, to: 'hail' } }))
      expect(r2.ok && r2.msg.t === 'worldEnter' && r2.msg.world.clock).toEqual(clock)
      expect(r2.ok && r2.msg.t === 'worldEnter' && r2.msg.world.weather).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(2)
      // other optional fields keep the house rule: a bad one still rejects the message
      expect(parseServerMessage(enter({ clock, levelCap: 0 })).ok).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
