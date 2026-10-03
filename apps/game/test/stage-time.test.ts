/**
 * The stage's time and weather (docs/SCREENS.md §0B.3, §0B.10 `stage-time.test.ts`; lane SCR-R): the sunset hold at
 * night, the live clock by day, a hold that began at night stays through sunrise until the next `enter()` (no tween),
 * the fallback without a clock, the server-time offset, the frozen noon without the new look; the server weather at
 * half intensity with no lightning.
 */
import { DEFAULT_CLOCK, clockAt, phaseForSolarTime, sunriseSunset, type WorldClockState } from '@sro/shared'
import { CLEAR_FRAME, type WeatherFrame } from '@sro/world-render'
import { describe, expect, it } from 'vitest'
import { FROZEN_NOON, StageTime, isDaytime, stageTimeAt, stageWeather, type StageTimeWorld } from '../src/stage/stage-time.ts'
import { STAGE_SUNSET_FALLBACK, STAGES } from '../src/stage/stages.ts'

const SERVER_TIME = { kind: 'server' as const, fallback: STAGE_SUNSET_FALLBACK }

/** A running clock whose solar time is `t` at server ms `atMs`. */
function clockAtT(t: number, atMs: number, over: Partial<WorldClockState> = {}): WorldClockState {
  const k = over.nightSpeedup ?? DEFAULT_CLOCK.nightSpeedup
  return { ...DEFAULT_CLOCK, anchorMs: atMs, anchorDays: 12 + phaseForSolarTime(t, k), ...over }
}

/** A World that records what the stage time sets. */
function fakeWorld(): StageTimeWorld & { calls: Array<['time', number] | ['clock', WorldClockState | null]> } {
  const calls: Array<['time', number] | ['clock', WorldClockState | null]> = []
  return {
    calls,
    setTimeOfDay: t => calls.push(['time', t]),
    setClock: c => calls.push(['clock', c]),
  }
}

describe('the stage time (SCREENS §0B.3)', () => {
  const set12 = sunriseSunset(12).set

  it('the fallback is sunset at the default season (0.773)', () => {
    expect(set12).toBeCloseTo(STAGE_SUNSET_FALLBACK, 3)
    expect(STAGES.select.time).toEqual(SERVER_TIME)
  })

  it('night → the sunset of the clock\'s declination; day → the live t; no clock → the fallback; a fixed time as is', () => {
    const now = 5_000_000
    expect(stageTimeAt(SERVER_TIME, clockAtT(0.1, now), now)).toEqual({ mode: 'hold', t: set12 })
    expect(stageTimeAt(SERVER_TIME, clockAtT(0.95, now), now)).toEqual({ mode: 'hold', t: set12 })
    const winter = clockAtT(0.1, now, { declination: -23.44 })
    expect(stageTimeAt(SERVER_TIME, winter, now)).toEqual({ mode: 'hold', t: sunriseSunset(-23.44).set })
    const day = stageTimeAt(SERVER_TIME, clockAtT(0.625, now), now)
    expect(day.mode).toBe('live')
    expect(day.t).toBeCloseTo(0.625, 6)
    expect(stageTimeAt(SERVER_TIME, null, now)).toEqual({ mode: 'fixed', t: STAGE_SUNSET_FALLBACK })
    expect(stageTimeAt(SERVER_TIME, undefined, now)).toEqual({ mode: 'fixed', t: STAGE_SUNSET_FALLBACK })
    expect(stageTimeAt(0.4, clockAtT(0.1, now), now)).toEqual({ mode: 'fixed', t: 0.4 })
    // Without the new look (the Low guard's combination): the world's frozen noon, whatever the server says.
    expect(stageTimeAt(SERVER_TIME, clockAtT(0.1, now), now, false)).toEqual({ mode: 'fixed', t: FROZEN_NOON })
    expect(isDaytime(0.5, 12)).toBe(true)
    expect(isDaytime(0.2, 12)).toBe(false)
  })

  it('reads the clock at the SERVER time (the lobby socket\'s offset), not the page clock', () => {
    // The page's clock says noon; the server is 40 real minutes later: 20 game hours at the default 2 h day → night.
    const page = 1_000_000
    const offset = 40 * 60_000
    const clock = clockAtT(0.5, page)
    const serverNow = () => page + offset
    expect(clockAt(clock, page).t).toBeCloseTo(0.5, 6)
    expect(isDaytime(clockAt(clock, serverNow()).t, 12)).toBe(false)
    const w = fakeWorld()
    const time = new StageTime()
    expect(time.enter(w, SERVER_TIME, clock, serverNow).mode).toBe('hold')
    expect(w.calls).toEqual([['time', set12]])
  })

  it('a live day runs the clock like the world, and holds at sunset when it gets there (no jump)', () => {
    let now = 0
    const clock = clockAtT(0.7, 0)
    const w = fakeWorld()
    const time = new StageTime()
    expect(time.enter(w, SERVER_TIME, clock, () => now).mode).toBe('live')
    expect(w.calls).toEqual([['clock', clock]])
    expect(time.update(w)).toBe(false)
    // 0.7 → sunset: a few real minutes at the default 2 h day.
    now = 8 * 60_000
    expect(time.update(w)).toBe(true)
    expect(time.mode).toBe('hold')
    expect(time.t).toBe(set12)
    expect(w.calls.at(-1)).toEqual(['time', set12])
  })

  it('a hold that began at night stays through sunrise until the next enter(), then the live clock runs', () => {
    let now = 0
    const clock = clockAtT(0.02, 0)
    const w = fakeWorld()
    const time = new StageTime()
    time.enter(w, SERVER_TIME, clock, () => now)
    expect(time.mode).toBe('hold')
    // Through the rest of the night and into the morning: the sunset frame simply stays.
    for (const minutes of [5, 10, 20, 40]) {
      now = minutes * 60_000
      expect(time.update(w)).toBe(false)
      expect(time.t).toBe(set12)
    }
    expect(isDaytime(clockAt(clock, now).t, 12)).toBe(true)
    expect(w.calls).toEqual([['time', set12]])
    // The next enter (select → create) takes the live clock: a snap, no tween.
    expect(time.enter(w, SERVER_TIME, clock, () => now).mode).toBe('live')
    expect(w.calls.at(-1)).toEqual(['clock', clock])
  })
})

describe('the stage weather (SCREENS §0B.3, §4.4)', () => {
  const storm: WeatherFrame = {
    cloud: 1, cloudDark: 0.9, cirrus: 0.4, rain: 1, fog: 0.6, sun: 0.2, desat: 0.5, windX: 0, windZ: 1, windMs: 14, gustMs: 20,
    wet: 1, puddle: 0.8, flash: 2.5, flashX: 1, flashZ: 0, time: 12,
  }

  it('the server weather at half intensity (halfway from clear), never lightning', () => {
    const out = stageWeather(storm, {} as WeatherFrame)
    expect(out.rain).toBeCloseTo(CLEAR_FRAME.rain + (1 - CLEAR_FRAME.rain) / 2, 9)
    expect(out.sun).toBeCloseTo(CLEAR_FRAME.sun + (0.2 - CLEAR_FRAME.sun) / 2, 9)
    expect(out.wet).toBeCloseTo(0.5, 9)
    expect(out.flash).toBe(0)
    expect(out.flashX).toBe(0)
    // Direction and shader time pass through.
    expect(out.windZ).toBe(1)
    expect(out.time).toBe(12)
    // The input is not touched.
    expect(storm.rain).toBe(1)
  })

  it('a clear sky stays exactly clear', () => {
    expect(stageWeather(CLEAR_FRAME, {} as WeatherFrame)).toEqual({ ...CLEAR_FRAME })
  })
})
