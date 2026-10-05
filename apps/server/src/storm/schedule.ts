import { STORM_TABLE, WEATHER_EPOCH, mulberry32, segmentSeed } from '@sro/shared'
import type { ServerConfig } from '../config.ts'

/**
 * Storm events (docs/WEATHER.md §12.1): uncommon, announced storms laid over the weather schedule. Each real day
 * (UTC, counted from WEATHER_EPOCH) holds `perDay` storms, one per equal slot of the day at a seeded time inside it,
 * each `minMin`..`maxMin` long, its forecast `forecastMin` before it inside the same slot. Deterministic from the
 * weather seed and the knobs, so a restart lands on the same storms; the knobs are read live (the admin panel), and a
 * storm whose forecast has begun keeps its times until it ends.
 *
 * WeatherService asks `event(now)` every tick: during the forecast it steers toward a darkening overcast with a rising
 * wind, during the storm toward `storm`. A GM storm (`storm start`) replaces the scheduled ones while it lasts; `storm
 * stop` ends either.
 */

export const DAY_MS = 86_400_000

export interface StormEvent {
  /** Server ms the forecast begins. */
  forecastAt: number
  /** Server ms the storm breaks. */
  start: number
  /** Server ms it ends. */
  end: number
  seed: number
  /** Started by a GM (`storm start`). */
  gm?: true
}

export interface StormFrequency {
  perDay: number
  minMin: number
  maxMin: number
  forecastMin: number
}

export type StormConfig = Pick<ServerConfig, 'weatherSeed' | 'stormsPerDay' | 'stormMinMin' | 'stormMaxMin' | 'stormForecastMin'>

/** The knobs with their defaults, the range made sane (min ≤ max). */
export function stormFrequency(c: Partial<StormConfig>): StormFrequency {
  const lo = Math.max(1, c.stormMinMin ?? STORM_TABLE.minMin)
  const hi = Math.max(lo, c.stormMaxMin ?? STORM_TABLE.maxMin)
  return { perDay: Math.max(0, c.stormsPerDay ?? STORM_TABLE.perDay), minMin: lo, maxMin: hi, forecastMin: Math.max(0, c.stormForecastMin ?? STORM_TABLE.forecastMin) }
}

/** The day index of server ms `t` (whole UTC days since WEATHER_EPOCH). */
export function stormDay(t: number): number {
  return Math.floor((t - WEATHER_EPOCH) / DAY_MS)
}

/** The scheduled storms of day `day` (oldest first). */
export function stormsOfDay(seed: number, day: number, f: StormFrequency): StormEvent[] {
  const rng = mulberry32(segmentSeed((seed ^ 0x5707a) >>> 0, day + 0x10000))
  const whole = Math.floor(f.perDay)
  const n = Math.min(48, whole + (rng() < f.perDay - whole ? 1 : 0))
  const out: StormEvent[] = []
  if (n <= 0) return out
  const dayStart = WEATHER_EPOCH + day * DAY_MS
  const slot = DAY_MS / n
  const fc = f.forecastMin * 60_000
  for (let i = 0; i < n; i++) {
    let len = (f.minMin + (f.maxMin - f.minMin) * rng()) * 60_000
    len = Math.max(60_000, Math.min(len, slot - fc))
    const room = Math.max(0, slot - fc - len)
    const start = Math.round((dayStart + i * slot + fc + room * rng()) / 1000) * 1000
    out.push({ forecastAt: start - fc, start, end: start + Math.round(len / 1000) * 1000, seed: Math.floor(rng() * 0x100000000) >>> 0 })
  }
  return out
}

export class StormPlan {
  private gmEvent: StormEvent | null = null
  /** The event in progress (its forecast began): kept as it was, whatever the knobs do meanwhile. */
  private current: StormEvent | null = null
  /** A scheduled event a GM stopped (its start), so it does not come back. */
  private stopped = new Set<number>()
  private cache: { key: string; events: StormEvent[] } | null = null

  constructor(
    private readonly config: Partial<StormConfig>,
    /** Whether scheduled storms happen (WEATHER=auto); GM storms always do. */
    private readonly scheduled: () => boolean = () => true,
  ) {}

  private get seed(): number {
    return (this.config.weatherSeed ?? 1) >>> 0
  }

  /** Scheduled events of `day` and the day after (cached per knob set). */
  private around(day: number): StormEvent[] {
    const f = stormFrequency(this.config)
    const key = `${day}:${this.seed}:${f.perDay}:${f.minMin}:${f.maxMin}:${f.forecastMin}`
    if (this.cache?.key !== key) this.cache = { key, events: [...stormsOfDay(this.seed, day - 1, f), ...stormsOfDay(this.seed, day, f), ...stormsOfDay(this.seed, day + 1, f)] }
    return this.cache.events
  }

  /** The storm event whose forecast has begun and which has not ended at `now`, or null. */
  event(now: number): StormEvent | null {
    if (this.gmEvent) {
      if (now < this.gmEvent.end) return now >= this.gmEvent.forecastAt ? this.gmEvent : null
      this.gmEvent = null
    }
    if (this.current && now >= this.current.forecastAt && now < this.current.end && !this.stopped.has(this.current.start)) return this.current
    this.current = null
    if (!this.scheduled()) return null
    for (const e of this.around(stormDay(now))) {
      if (now >= e.forecastAt && now < e.end && !this.stopped.has(e.start)) return (this.current = e)
    }
    return null
  }

  /** The next scheduled storm whose forecast begins after `now` (null: none in the next two days, or not scheduled). */
  next(now: number): StormEvent | null {
    if (!this.scheduled()) return null
    for (const e of this.around(stormDay(now))) if (e.forecastAt > now && !this.stopped.has(e.start)) return e
    for (const e of this.around(stormDay(now) + 1)) if (e.forecastAt > now && !this.stopped.has(e.start)) return e
    return null
  }

  /** A GM storm: its forecast now, the storm `forecastMs` later for `lengthMs`. */
  startGm(now: number, lengthMs: number, forecastMs: number, seed: number): StormEvent {
    const start = Math.round(now + forecastMs)
    this.gmEvent = { forecastAt: Math.round(now), start, end: start + Math.round(lengthMs), seed: seed >>> 0, gm: true }
    return this.gmEvent
  }

  /** Ends the storm (or forecast) in progress; false when there is none. */
  stop(now: number): boolean {
    let e = this.event(now)
    if (!e) return false
    // a GM storm over a scheduled one: both end
    for (let i = 0; e && i < 2; i++, e = this.event(now)) {
      if (e.gm) this.gmEvent = null
      else this.stopped.add(e.start)
      this.current = null
    }
    // forget stops of days long gone
    if (this.stopped.size > 64) this.stopped = new Set([...this.stopped].filter((s) => s > now - 2 * DAY_MS))
    return true
  }
}
