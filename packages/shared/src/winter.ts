/**
 * The snow season (docs/WINTER.md §2): the season's dates in the server's time zone, the snow cover that builds up
 * under snowfall and melts on sunny days, and the frost that freezes the ponds. Pure and environment-neutral: the server
 * (apps/server/src/winter.ts) integrates the state, the client carries it forward between `winter` messages with the
 * same `stepWinter`, exactly as the surface wetness (weather.ts stepSurface).
 *
 * - The season runs from `start` to `end` (month-day, both days inclusive) in `timeZone`; a range whose start is after
 *   its end wraps the new year (12-01 .. 01-15).
 * - Cover (0..1) only grows while snow falls: the first snowfall of the season eases in over hours, nothing appears at
 *   midnight on the first day. In season it melts slowly, by daylight under a clear sky; rain melts it fast; outside
 *   the season it melts within a few hours whatever the sky.
 * - Frost (0..1) rises over hours once the season begins (ponds freeze past FROST_ICE) and falls over hours after it.
 */
import { validTimeZone } from './pilot.ts'
import type { WeatherParams } from './weather.ts'

/** The panel's and the environment's defaults (WINTER, WINTER_START, WINTER_END, WINTER_STRENGTH, WINTER_TORNADO). */
export const WINTER_DEFAULTS = {
  enabled: true,
  start: '12-01',
  end: '01-15',
  /** How white the world gets at full cover (0 = no snow on the ground, 1 = the full look). */
  strength: 1,
  /** Tornadoes during blizzards (default off: a winter storm is a blizzard). */
  tornado: false,
} as const

/** `MM-DD`, a real day of the year (02-29 allowed). */
export const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** `MM-DD` → month × 100 + day (1201), or null when it is not a day of the year. */
export function parseMonthDay(s: string): number | null {
  if (typeof s !== 'string' || !MONTH_DAY_RE.test(s)) return null
  const m = Number(s.slice(0, 2))
  const d = Number(s.slice(3, 5))
  return d <= DAYS_IN_MONTH[m - 1]! ? m * 100 + d : null
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric' })
    formatters.set(timeZone, f)
  }
  return f
}


/** The time zone the process runs in (the server's: the season's dates are its calendar days). */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The calendar day of `ms` in `timeZone` as month × 100 + day. */
export function localMonthDay(ms: number, timeZone: string): number {
  let month = 1
  let day = 1
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type === 'month') month = Number(p.value)
    else if (p.type === 'day') day = Number(p.value)
  }
  return month * 100 + day
}

export interface SeasonDates {
  /** `MM-DD`, the first day of the season. */
  start: string
  /** `MM-DD`, the last day of the season (inclusive). */
  end: string
  /** IANA time zone of those days. */
  timeZone: string
}

/** Whether server ms `ms` falls in the season (both days inclusive; start > end wraps the new year). Bad dates: never. */
export function inSeason(ms: number, d: SeasonDates): boolean {
  const s = parseMonthDay(d.start)
  const e = parseMonthDay(d.end)
  if (s === null || e === null || !Number.isFinite(ms)) return false
  const tz = validTimeZone(d.timeZone) ? d.timeZone : 'UTC'
  const md = localMonthDay(ms, tz)
  return s <= e ? md >= s && md <= e : md >= s || md <= e
}

/**
 * The next time the season begins or ends after `ms` (to the hour; null when it never changes, e.g. a range covering
 * the whole year, or bad dates). For the GM status line and the admin panel.
 */
export function nextSeasonChange(ms: number, d: SeasonDates): { at: number; begins: boolean } | null {
  if (parseMonthDay(d.start) === null || parseMonthDay(d.end) === null) return null
  const now = inSeason(ms, d)
  const H = 3_600_000
  let t = Math.ceil(ms / H) * H
  for (let i = 0; i < 24 * 370; i++, t += H) if (inSeason(t, d) !== now) return { at: t, begins: !now }
  return null
}

// ---- the cover and the frost ----------------------------------------------------------------------------------

export interface WinterState {
  /** Snow cover 0..1 on the ground, roofs and trees. */
  cover: number
  /** How cold the world is 0..1 (frozen ponds past FROST_ICE, frosted grass, the cold grade). */
  frost: number
}

export const BARE: Readonly<WinterState> = Object.freeze({ cover: 0, frost: 0 })

/** The ponds read as frozen from this frost on (client: ice instead of water). */
export const FROST_ICE = 0.5

/** The rates of the cover and the frost (seconds for a full 0 → 1 or 1 → 0 at rate 1). */
export const WINTER_RATES = {
  /** Snowfall at rate 1 (a blizzard) covers bare ground fully in this long; the `snow` state (0.6) takes 5 h. */
  coverS: 3 * 3600,
  /** Outside the season snow settles at this share (warm ground): a GM snow in October still whitens, slowly. */
  warmSettle: 0.5,
  /** In season: full cover melts in this many seconds of full sun by day (clear sky ~20 h, overcast ~57 h). */
  meltSunS: 20 * 3600,
  /** Rain at rate 1 washes a full cover away in this long. */
  meltRainS: 2 * 3600,
  /** Outside the season a full cover melts in this long whatever the sky. */
  meltWarmS: 3 * 3600,
  /** Frost: rises to 1 over this long once the season begins, and falls to 0 over `thawS` after it ends. */
  freezeS: 4 * 3600,
  thawS: 6 * 3600,
} as const

/** What stepWinter reads of the weather (a blended WeatherParams fits). */
export type WinterWeather = Pick<WeatherParams, 'rain' | 'sun'> & { snow?: number }

export interface WinterClimate {
  /** The season is on (the dates and WINTER on). */
  season: boolean
  /** Daylight 0..1 (1 by day, 0 at night): the sun melts the snow only by day. */
  daylight: number
}

/** A catch-up integrates at most this much time (a client back from an old `at`, a server after a long downtime). */
export const WINTER_MAX_STEP_S = 72 * 3600

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0)

/**
 * Integrates the cover and the frost over `dtS` seconds under the weather `w` (sub-steps of at most 60 s; returns a new
 * state). Snow settles at `snow / coverS` per second (× warmSettle outside the season); the cover melts at
 * `(1 − snow) × sun × daylight / meltSunS` in season, `(1 − snow) / meltWarmS` outside it, plus `rain / meltRainS` always.
 */
export function stepWinter(s: Readonly<WinterState>, w: WinterWeather, c: WinterClimate, dtS: number): WinterState {
  let cover = clamp01(s.cover)
  let frost = clamp01(s.frost)
  let left = Math.min(Math.max(0, Number.isFinite(dtS) ? dtS : 0), WINTER_MAX_STEP_S)
  const R = WINTER_RATES
  const snow = clamp01(w.snow ?? 0)
  const rain = clamp01(w.rain)
  const settle = (snow * (c.season ? 1 : R.warmSettle)) / R.coverS
  const melt = (1 - snow) * (c.season ? (clamp01(w.sun) * clamp01(c.daylight)) / R.meltSunS : 1 / R.meltWarmS) + rain / R.meltRainS
  const freeze = c.season ? 1 / R.freezeS : -1 / R.thawS
  while (left > 0) {
    if (cover === 0 && snow === 0 && (c.season ? frost === 1 : frost === 0)) break
    const dt = Math.min(60, left)
    left -= dt
    cover = clamp01(cover + (settle - melt) * dt)
    if (cover < 1e-6) cover = 0
    frost = clamp01(frost + freeze * dt)
  }
  return { cover, frost }
}

// ---- the wire -----------------------------------------------------------------------------------------------

/** Wire ranges (validate.ts and the server use the same). */
export const WINTER_LIMITS = {
  /** The admin strength knob. */
  strength: [0, 1] as const,
  /** GM `winter speed`: the time-lapse factor of the cover and frost (1 = real time). */
  speed: [1, 120] as const,
} as const

/** A `winter` resync goes out this often even when nothing changed (the client integrates in between). */
export const WINTER_RESYNC_MS = 600_000
