import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BARE,
  FROST_ICE,
  WINTER_DEFAULTS,
  WINTER_MAX_STEP_S,
  WINTER_LIMITS,
  WINTER_RESYNC_MS,
  blendWeather,
  hostTimeZone,
  inSeason,
  nextSeasonChange,
  parseMonthDay,
  stepWinter,
  transitionMs,
  validTimeZone,
  weatherParams,
  winterKind,
  type SeasonDates,
  type ServerMessage,
  type WeatherParams,
  type WeatherSchedule,
  type WinterState,
  type WinterSync,
} from '@sro/shared'
import type { ServerConfig, WeatherMode } from './config.ts'
import type { GmResult } from './gm.ts'
import type { GameplayModule } from './modules.ts'
import type { WinterSeason } from './weather.ts'

/**
 * The snow season (docs/WINTER.md §2, §5, §6). A GameplayModule named `winter`:
 *
 * - The season: WINTER on and today within WINTER_START..WINTER_END (both inclusive, the new year wraps) in WINTER_TZ
 *   (default the server's time zone). The weather asks `active(now)` (WinterSeason): rain falls as snow and storms are
 *   blizzards while it is on. The admin panel changes the dates, the switch, the strength and the tornado knob live.
 * - The snow on the ground: `cover` and `frost`, integrated once a second from the blended weather and the daylight
 *   (shared stepWinter): snow builds up over hours of snowfall (the first snowfall of the season eases in), melts
 *   slowly by day under a clear sky and within hours once the season is over; the frost rises over hours after the
 *   season begins (the ponds freeze) and falls after it ends.
 * - Persisted to `<DATA_DIR>/winter.json` (atomically, every two minutes while it changes and after a GM change), so a
 *   restart keeps the snow; a gap since the save (or no save) is caught up along the weather schedule, at most 72 h.
 * - The wire: `winter` to every player in the world when the season begins or ends, a GM or the admin changes it, and
 *   every 10 minutes; `sync(now)` is the late joiner's (worldEnter.world.winter).
 * - GM `winter`: the status; `winter preview [on|off]` shows the full season look to everyone without touching the
 *   season, the dates or the integrated snow; `winter cover <0-1>` / `winter frost <0-1>` set the snow now;
 *   `winter speed <1-120>` is a test time-lapse (the cover and frost settle and melt that many times faster; `speed 1` or
 *   `off` ends it; in the sync so clients follow; never persisted). Forcing a
 *   snowfall is the weather's (`weather snow`, `weather blizzard`), which does not touch the season either.
 * - Other modules read `state(now)` (season, cover, frost, snowing): the hook a later gameplay layer (cold, snowballs)
 *   builds on.
 */

export const WINTER_FILE = 'winter.json'
export const WINTER_USAGE = 'winter [preview [on | off] | cover <0-1> | frost <0-1> | speed <1-120 | off>]'

/** Integration interval (ms) and the save interval while the snow changes. */
const TICK_MS = 1000
const SAVE_MS = 120_000
/** Without a save, the snow is warmed up over this much of the weather schedule (s), in steps of WARMUP_STEP_S. */
const WARMUP_S = 72 * 3600
const WARMUP_STEP_S = 60

export interface WinterHost {
  config: Pick<ServerConfig, 'dataDir' | 'log' | 'winterEnabled' | 'winterStart' | 'winterEnd' | 'winterTz' | 'winterStrength' | 'winterTornado'>
  world: { broadcast(msg: ServerMessage): void }
}

/** What the module reads of the weather (WeatherService). */
export interface WinterWeatherSource {
  readonly mode: WeatherMode
  readonly schedule: WeatherSchedule
  params(now: number): WeatherParams
}

/** What other modules may read (docs/WINTER.md §8: the hook for a gameplay layer). */
export interface WinterNow {
  /** The season is on (the dates and the switch). */
  season: boolean
  /** Snow cover 0..1 (before the admin strength) and frost 0..1. */
  cover: number
  frost: number
  /** The ponds are frozen. */
  frozen: boolean
  /** Snowfall rate now (0..1). */
  snowing: number
}

const ok = (message: string, data?: unknown): GmResult => ({ ok: true, message, data })
const fail = (message: string): GmResult => ({ ok: false, message })

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

export class WinterService implements GameplayModule, WinterSeason {
  readonly name = 'winter'
  private snow: WinterState = { ...BARE }
  /** Server ms the snow was integrated to. */
  private stepAt: number
  private weather: WinterWeatherSource | null = null
  private daylightAt: (now: number) => number = () => 1
  private preview = false
  /** GM `winter speed`: the snow's time-lapse factor (1 = real time; runtime only). */
  private speed = 1
  private lastTick = -Infinity
  private lastSent = -Infinity
  private lastSeason: boolean | null = null
  private lastSaved = -Infinity
  private saved: WinterState = { ...BARE }

  constructor(
    private readonly host: WinterHost,
    now = Date.now(),
  ) {
    this.stepAt = now
  }

  // ---- the season ------------------------------------------------------------------------------------------

  get enabled(): boolean {
    return this.host.config.winterEnabled ?? WINTER_DEFAULTS.enabled
  }

  /** The season's days and time zone (bad values fall back to the defaults; the panel never stores bad ones). */
  dates(): SeasonDates {
    const c = this.host.config
    const start = c.winterStart && parseMonthDay(c.winterStart) !== null ? c.winterStart : WINTER_DEFAULTS.start
    const end = c.winterEnd && parseMonthDay(c.winterEnd) !== null ? c.winterEnd : WINTER_DEFAULTS.end
    const timeZone = c.winterTz && validTimeZone(c.winterTz) ? c.winterTz : hostTimeZone()
    return { start, end, timeZone }
  }

  /** WinterSeason: the season is on at `now`. */
  active(now: number): boolean {
    if (!this.enabled) return false
    // the season changes on the minute at most: one calendar lookup a minute per date set
    const d = this.dates()
    const key = `${d.start}|${d.end}|${d.timeZone}`
    const minute = Math.floor(now / 60_000)
    if (this.seasonCache.minute !== minute || this.seasonCache.key !== key) this.seasonCache = { minute, key, on: inSeason(now, d) }
    return this.seasonCache.on
  }

  private seasonCache = { minute: Number.NaN, key: '', on: false }

  /** The admin strength knob, 0..1. */
  strength(): number {
    return clamp01(this.host.config.winterStrength ?? WINTER_DEFAULTS.strength)
  }

  /** Tornadoes are allowed now (outside the season always; in it only with WINTER_TORNADO). */
  tornadoes(now: number): boolean {
    return !this.active(now) || (this.host.config.winterTornado ?? WINTER_DEFAULTS.tornado)
  }

  /** Whether a GM preview is on. */
  get previewing(): boolean {
    return this.preview
  }

  /** The snow now, for other modules (docs/WINTER.md §8). */
  state(now: number): WinterNow {
    this.integrate(now)
    const snowing = this.weather ? clamp01(this.weather.params(now).snow ?? 0) : 0
    return { season: this.active(now), cover: this.snow.cover, frost: this.snow.frost, frozen: this.snow.frost >= FROST_ICE, snowing }
  }

  /** The late joiner's state (worldEnter.world.winter). */
  sync(now = Date.now()): WinterSync {
    this.integrate(now)
    const d = this.dates()
    const s: WinterSync = {
      season: this.active(now),
      cover: round4(this.snow.cover),
      frost: round4(this.snow.frost),
      at: this.stepAt,
      strength: round4(this.strength()),
      start: d.start,
      end: d.end,
      timeZone: d.timeZone,
    }
    if (this.preview) s.preview = true
    if (this.speed !== 1) s.speed = this.speed
    return s
  }

  /** The GM time-lapse factor (1 = real time). */
  get timeLapse(): number {
    return this.speed
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------

  /**
   * Connects the weather and the daylight (Gameplay, once both exist) and restores the snow: the save, carried forward
   * to `now` along the weather, or (no usable save) the last 72 h of the weather from bare ground.
   */
  attach(weather: WinterWeatherSource, daylight: (now: number) => number, now = Date.now()): void {
    this.weather = weather
    this.daylightAt = daylight
    const saved = this.load()
    if (saved && now - saved.at <= WINTER_MAX_STEP_S * 1000 && saved.at <= now) {
      this.snow = this.replay({ cover: saved.cover, frost: saved.frost }, saved.at, now)
    } else this.snow = this.replay({ ...BARE }, now - WARMUP_S * 1000, now)
    this.stepAt = now
    this.saved = { ...this.snow }
    this.lastSeason = this.active(now)
    this.lastSent = now
  }

  tick(now: number): void {
    if (now < this.lastTick) this.stepAt = Math.min(this.stepAt, now)
    if (now - this.lastTick < TICK_MS && now >= this.lastTick) return
    this.lastTick = now
    this.integrate(now)
    const season = this.active(now)
    if (season !== this.lastSeason) {
      this.lastSeason = season
      this.host.config.log(`winter: the snow season ${season ? 'begins' : 'ends'} (${this.dates().start}..${this.dates().end}, ${this.dates().timeZone})`)
      this.send(now)
    } else if (now - this.lastSent >= WINTER_RESYNC_MS) this.send(now)
    const moved = Math.abs(this.snow.cover - this.saved.cover) + Math.abs(this.snow.frost - this.saved.frost)
    if (moved > 0.001 && now - this.lastSaved >= SAVE_MS) this.save(now)
  }

  /** The admin changed a winter setting: re-evaluate the season and tell everyone. */
  refresh(now = Date.now()): void {
    this.integrate(now)
    this.lastSeason = this.active(now)
    this.send(now)
  }

  // ---- GM (docs/WINTER.md §6) ------------------------------------------------------------------------------

  gm(args: string[], now = Date.now()): GmResult {
    const a = (args[0] ?? '').toLowerCase()
    if (args.length === 0) return ok(this.describe(now), this.sync(now))
    if (a === 'preview') {
      const v = (args[1] ?? 'on').toLowerCase()
      if (args.length > 2 || (v !== 'on' && v !== 'off')) return fail(`Usage: ${WINTER_USAGE}`)
      this.preview = v === 'on'
      this.send(now)
      return ok(this.preview ? 'Winter: preview on: everyone sees the full season look (the season, its dates and the snow are unchanged; `winter preview off` ends it).' : 'Winter: preview off.', this.sync(now))
    }
    if (a === 'speed') {
      const raw = (args[1] ?? '').toLowerCase()
      const v = raw === 'off' ? 1 : num(args[1])
      if (args.length !== 2 || v === null || v < WINTER_LIMITS.speed[0] || v > WINTER_LIMITS.speed[1]) return fail(`Usage: ${WINTER_USAGE}`)
      this.integrate(now)
      this.speed = v
      this.send(now)
      return ok(v === 1 ? 'Winter: speed back to real time.' : `Winter: time-lapse x${v}: the snow settles and melts ${v} times faster (\`winter speed off\` ends it; not kept across a restart).`, this.sync(now))
    }
    if (a === 'cover' || a === 'frost') {
      const v = num(args[1])
      if (v === null || v < 0 || v > 1 || args.length !== 2) return fail(`Usage: ${WINTER_USAGE}`)
      this.integrate(now)
      this.snow = { ...this.snow, [a]: v }
      this.send(now)
      this.save(now)
      return ok(`Winter: ${a} ${v} (it goes on building up or melting with the weather).`, this.sync(now))
    }
    return fail(`Usage: ${WINTER_USAGE}`)
  }

  describe(now: number): string {
    const d = this.dates()
    const s = this.state(now)
    const change = this.enabled ? nextSeasonChange(now, d) : null
    const when = change ? `; it ${change.begins ? 'begins' : 'ends'} in about ${Math.max(0, Math.round((change.at - now) / 86_400_000))} day(s)` : ''
    const season = !this.enabled ? 'off (WINTER=off)' : s.season ? 'on' : 'not now'
    return `Winter: season ${season} (${d.start} to ${d.end}, ${d.timeZone})${when}; snow cover ${s.cover.toFixed(2)}, frost ${s.frost.toFixed(2)}${s.frozen ? ' (ponds frozen)' : ''}, snowfall ${s.snowing.toFixed(2)}; strength ${this.strength()}${this.preview ? '; GM preview on' : ''}${this.speed !== 1 ? `; time-lapse x${this.speed}` : ''}; tornadoes in blizzards ${this.host.config.winterTornado ? 'on' : 'off'}.`
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private integrate(now: number): void {
    const dtS = (now - this.stepAt) / 1000
    if (dtS <= 0) {
      if (dtS < 0) this.stepAt = now
      return
    }
    if (!this.weather) {
      this.stepAt = now
      return
    }
    this.snow = stepWinter(this.snow, this.weather.params(now), { season: this.active(now), daylight: this.daylightAt(now) }, dtS * this.speed)
    this.stepAt = now
  }

  /** `from` carried from `t0` to `t1` along the weather (the schedule with its seasonal forms, or the fixed state). */
  private replay(from: WinterState, t0: number, t1: number): WinterState {
    let s = from
    const w = this.weather
    if (!w) return s
    // the season changes on the hour at most: ask it once an hour (Intl calendars are not free)
    let hour = Number.NaN
    let season = false
    for (let t = t0; t < t1; t += WARMUP_STEP_S * 1000) {
      const dt = Math.min(WARMUP_STEP_S, (t1 - t) / 1000)
      const h = Math.floor(t / 3_600_000)
      if (h !== hour) {
        hour = h
        season = this.active(t)
      }
      s = stepWinter(s, this.pastParams(t, season), { season, daylight: this.daylightAt(t) }, dt)
    }
    return s
  }

  /** The weather at a past time (its schedule; storm events and GM holds are not replayed). */
  private pastParams(t: number, season: boolean): WeatherParams {
    const w = this.weather!
    if (w.mode === 'off') return weatherParams('clear')
    if (w.mode !== 'auto') return weatherParams(w.mode)
    const seg = w.schedule.at(t)
    const form = (k: typeof seg.kind) => (season ? winterKind(k) : k)
    const from = form(seg.prev)
    return blendWeather({ start: seg.start, dur: transitionMs(seg.prev, seg.kind), from, to: form(seg.kind), intensity: seg.intensity }, t, weatherParams(from, seg.prevIntensity))
  }

  private get file(): string {
    return join(this.host.config.dataDir, WINTER_FILE)
  }

  private load(): { cover: number; frost: number; at: number } | null {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return null
    }
    try {
      const o = JSON.parse(text) as Record<string, unknown>
      const ok01 = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1
      if (ok01(o.cover) && ok01(o.frost) && typeof o.at === 'number' && Number.isFinite(o.at)) return { cover: o.cover as number, frost: o.frost as number, at: o.at }
    } catch {
      // reported below
    }
    this.host.config.log(`winter: ignoring ${this.file} (not a valid save)`)
    return null
  }

  private save(now: number): void {
    this.lastSaved = now
    this.saved = { ...this.snow }
    try {
      mkdirSync(this.host.config.dataDir, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ cover: round4(this.snow.cover), frost: round4(this.snow.frost), at: this.stepAt }))
      renameSync(tmp, this.file)
    } catch (e) {
      this.host.config.log(`winter: could not save ${this.file}: ${String(e)}`)
    }
  }

  private send(now: number): void {
    this.lastSent = now
    this.host.world.broadcast({ t: 'winter', winter: this.sync(now) })
  }
}
