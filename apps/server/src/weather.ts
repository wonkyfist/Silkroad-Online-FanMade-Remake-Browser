import {
  LIGHTNING_DIST_M,
  LIGHTNING_GM_DIST_M,
  LIGHTNING_MIN_GAP_MS,
  RAIN_INTENSITY_MIN,
  WEATHER_KINDS,
  WEATHER_LIMITS,
  WEATHER_RESYNC_MS,
  WeatherSchedule,
  blendFactor,
  blendWeather,
  mulberry32,
  nearestWeather,
  segmentSeed,
  stepSurface,
  transitionMs,
  weatherParams,
  type ServerMessage,
  type SurfaceState,
  type WeatherKind,
  type WeatherParams,
  type WeatherSegment,
  type WeatherSync,
} from '@sro/shared'
import { W9_DEFAULTS, type ServerConfig, type WeatherMode } from './config.ts'
import type { GmResult } from './gm.ts'
import type { GameplayModule } from './modules.ts'

/**
 * Server weather (docs/WEATHER.md §2–§4, docs/WAVE_PLAN3.md §3, §6.1; lane W9A-P). A GameplayModule named `weather`:
 *
 * - `tick` (at most once a second): picks the target state (a GM hold, else the seeded schedule, else the fixed
 *   WEATHER state), starts a transition when it changes, integrates the surface wetness (shared `stepSurface`), rolls
 *   lightning (Poisson at the blended rate, ≥ 4 s apart) and resends the state every 10 minutes.
 * - Every change goes to every player in the world as `weather`, each strike as `lightning`; `sync(now)` is the
 *   late-joiner state in `worldEnter.world.weather`.
 * - WEATHER=off: always clear, nothing after the enter sync, and the GM commands only report.
 * - Holds and overrides live in memory and end on restart; the schedule is deterministic, so a restart lands on the
 *   same state. The surface wetness at startup is warmed up over the last 90 minutes of the schedule.
 * - Strikes are cosmetic: no damage, no gameplay.
 * - While a transition runs, the sync carries the vector it started from (`fromVec`): a late joiner blends from the
 *   same point as everyone else, whatever `from` names (W9F P1).
 * - The wall clock stepping back (an NTP step at boot, a manual change) re-bases the module's times on the new clock
 *   and resyncs, instead of every tick waiting for the old time to come round again (W9F F3).
 */

export const WEATHER_USAGE =
  'weather [<state>[:intensity] [minutes] [transitionS] | auto | wind <m/s> [degrees] | wet <0-1> [puddle 0-1] | strike [distM]]'

/** GM hold defaults (WEATHER §3): 30 minutes, reached in 60 s; `weather auto` blends back over 60 s. */
export const HOLD_DEFAULT_MIN = 30
export const HOLD_TRANSITION_S = 60
/** A scheduled change whose `from` equals `to` (a new rain intensity, a change mid-transition) still blends this long. */
const SAME_KIND_MS = 120_000
/** Integration and lightning roll interval. */
const TICK_MS = 1000
/** Startup warm-up of the surface wetness. */
const WARMUP_MS = 90 * 60_000
const WARMUP_STEP_S = 10
/** A fixed or held state holds "indefinitely" (the `until` hint). */
const FOREVER = Number.MAX_SAFE_INTEGER
/** The direction the wind blows toward when nothing sets one (east-north-east). */
const PREVAILING_WIND = 0.35
const TAU = Math.PI * 2
const KINDS_LIST = WEATHER_KINDS.join(', ')

/** What the module needs of Gameplay (tests pass a stand-in). */
export interface WeatherHost {
  config: Pick<ServerConfig, 'weather' | 'weatherSeed' | 'weatherRainScale' | 'log'>
  world: { broadcast(msg: ServerMessage): void }
}

/** The state `tick` steers toward. */
interface Target {
  kind: WeatherKind
  intensity: number
  until: number
  seed: number
  windDir: number
  gm: boolean
}

const ok = (message: string, data?: unknown): GmResult => ({ ok: true, message, data })
const fail = (message: string): GmResult => ({ ok: false, message })

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

function round(x: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

/** A parameter vector for the wire (4 decimals, as the surface state). */
function roundParams(p: WeatherParams): WeatherParams {
  const out = { ...p }
  for (const k of Object.keys(out) as (keyof WeatherParams)[]) out[k] = round(out[k], 4)
  return out
}

function label(kind: WeatherKind, intensity: number): string {
  return kind === 'rain' && intensity < 1 ? `rain:${round(intensity)}` : kind
}

export class WeatherService implements GameplayModule {
  readonly name = 'weather'
  readonly mode: WeatherMode
  readonly schedule: WeatherSchedule
  private readonly seed: number
  private readonly rng: () => number
  private state: WeatherSync
  /** The vector the current transition began from (the blend at the moment of the change). */
  private startVec: WeatherParams
  private hold: { kind: WeatherKind; intensity: number; until: number; seed: number } | null = null
  /** GM wind override, until the next state change. */
  private wind: { windMs: number; windDir: number } | null = null
  private surface: SurfaceState = { wet: 0, puddle: 0 }
  /** Server ms of the last surface integration (`at` of the state). */
  private stepAt: number
  private lastTick = -Infinity
  private lastSent: number
  private lastStrike = -Infinity

  constructor(
    private readonly host: WeatherHost,
    now = Date.now(),
  ) {
    const c = host.config
    this.mode = c.weather ?? W9_DEFAULTS.weather
    this.seed = (c.weatherSeed ?? W9_DEFAULTS.weatherSeed) >>> 0
    this.schedule = new WeatherSchedule(this.seed, { rainScale: c.weatherRainScale ?? W9_DEFAULTS.weatherRainScale })
    this.rng = mulberry32(segmentSeed(this.seed, 0x5eed))
    this.stepAt = now
    this.lastSent = now
    if (this.mode === 'auto') {
      // join the schedule where it is: the current segment's transition may still be running, from the previous
      // segment's own vector (its rain intensity included, as the running server blended it; W9F P1)
      const seg = this.schedule.at(now)
      const t = this.target(now)
      this.state = this.syncOf(t, seg.prev, seg.start, transitionMs(seg.prev, seg.kind), now)
      this.startVec = this.segmentStart(seg)
    } else {
      const kind = this.mode === 'off' ? 'clear' : this.mode
      this.state = this.syncOf(this.target(now), kind, now, 0, now)
      this.startVec = weatherParams(kind)
    }
    if (this.mode !== 'off') this.warmUp(now)
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------

  tick(now: number): void {
    if (this.mode === 'off') return
    if (now < this.lastTick) this.clockStepped(now)
    if (now - this.lastTick < TICK_MS) return
    const dtS = Number.isFinite(this.lastTick) ? Math.min(60, (now - this.lastTick) / 1000) : TICK_MS / 1000
    this.lastTick = now
    this.integrate(now)
    if (this.hold && now >= this.hold.until) this.hold = null
    const t = this.target(now)
    const s = this.state
    if (t.kind !== s.to || t.intensity !== s.intensity || t.gm !== (s.gm === true)) {
      this.change(now, t)
      this.send(now)
    } else if (now - this.lastSent >= WEATHER_RESYNC_MS) this.send(now)
    this.rollLightning(now, dtS)
  }

  /** The late-joiner state (worldEnter.world.weather); `fromVec` while the transition runs. */
  sync(now = Date.now()): WeatherSync {
    if (this.mode !== 'off') this.integrate(now)
    const s: WeatherSync = { ...this.state, wet: round(this.surface.wet, 4), puddle: round(this.surface.puddle, 4), at: this.stepAt }
    if (now < s.start + s.dur) s.fromVec = roundParams(this.startVec)
    return s
  }

  /** The blended parameters right now (after a GM wind override). */
  params(now: number): WeatherParams {
    const p = blendWeather(this.state, now, this.startVec)
    if (this.wind) p.windMs = this.wind.windMs
    return p
  }

  // ---- GM (docs/WEATHER.md §3) ------------------------------------------------------------------------------

  gm(args: string[], now = Date.now()): GmResult {
    const a = (args[0] ?? '').toLowerCase()
    if (args.length === 0) return ok(this.describe(now), this.sync(now))
    if (this.mode === 'off') return fail('Weather is off on this server (WEATHER=off).')
    if (a === 'auto') {
      if (args.length !== 1) return fail(`Usage: ${WEATHER_USAGE}`)
      this.hold = null
      this.change(now, this.target(now), HOLD_TRANSITION_S * 1000)
      this.send(now)
      const back = this.mode === 'auto' ? 'the schedule' : `WEATHER=${this.mode}`
      return ok(`Weather: back to ${back}, ${label(this.state.to, this.state.intensity)} in ${HOLD_TRANSITION_S} s.`, this.sync(now))
    }
    if (a === 'wind') {
      const ms = num(args[1])
      const deg = args.length > 2 ? num(args[2]) : null
      if (ms === null || ms < 0 || ms > WEATHER_LIMITS.windMs || args.length > 3 || (args.length > 2 && (deg === null || deg < 0 || deg >= 360))) {
        return fail(`Usage: weather wind <0-${WEATHER_LIMITS.windMs} m/s> [0-359 degrees, 0 = east, 90 = north]`)
      }
      this.integrate(now)
      const windDir = deg === null ? this.state.windDir : (deg * Math.PI) / 180
      this.wind = { windMs: ms, windDir }
      this.state = { ...this.state, windMs: ms, windDir }
      this.send(now)
      return ok(`Weather: wind ${round(ms, 1)} m/s toward ${Math.round((windDir * 180) / Math.PI)}° until the next change.`, this.sync(now))
    }
    if (a === 'wet') {
      const wet = num(args[1])
      const puddle = args.length > 2 ? num(args[2]) : null
      if (wet === null || wet < 0 || wet > 1 || args.length > 3 || (args.length > 2 && (puddle === null || puddle < 0 || puddle > 1))) {
        return fail('Usage: weather wet <0-1> [puddle 0-1]')
      }
      this.integrate(now)
      const p = puddle ?? this.surface.puddle
      this.surface = { wet, puddle: Math.min(p, wet + 0.1) }
      this.send(now)
      return ok(`Weather: surfaces wet ${round(wet)}, puddles ${round(this.surface.puddle)}.`, this.sync(now))
    }
    if (a === 'strike') {
      const d = args.length > 1 ? num(args[1]) : 600
      if (d === null || d < LIGHTNING_GM_DIST_M[0] || d > LIGHTNING_GM_DIST_M[1] || args.length > 2) return fail(`Usage: weather strike [${LIGHTNING_GM_DIST_M[0]}-${LIGHTNING_GM_DIST_M[1]} metres]`)
      const wait = this.lastStrike + LIGHTNING_MIN_GAP_MS - now
      if (wait > 0) return fail(`Strikes are at least ${LIGHTNING_MIN_GAP_MS / 1000} s apart; wait ${Math.ceil(wait / 1000)} s.`)
      this.strike(now, d)
      return ok(`Weather: lightning ${Math.round(d)} m away (thunder after ${round(d / 343, 1)} s).`, this.sync(now))
    }
    // <state[:intensity]> [minutes] [transitionS]
    const [name, inten] = a.split(':')
    if (!(WEATHER_KINDS as readonly string[]).includes(name) || args.length > 3) return fail(`Usage: ${WEATHER_USAGE} (states: ${KINDS_LIST})`)
    const kind = name as WeatherKind
    let intensity = 1
    if (inten !== undefined) {
      const i = num(inten)
      if (kind !== 'rain' || i === null || i < RAIN_INTENSITY_MIN || i > 1) return fail(`Only rain takes an intensity (rain:${RAIN_INTENSITY_MIN} to rain:1).`)
      intensity = round(i)
    }
    const minutes = args.length > 1 ? num(args[1]) : HOLD_DEFAULT_MIN
    if (minutes === null || minutes < 1 || minutes > 1440) return fail('The hold lasts 1 to 1440 minutes.')
    const secs = args.length > 2 ? num(args[2]) : HOLD_TRANSITION_S
    if (secs === null || secs < 0 || secs * 1000 > WEATHER_LIMITS.durMs) return fail(`The transition takes 0 to ${WEATHER_LIMITS.durMs / 1000} s.`)
    this.hold = { kind, intensity, until: Math.round(now + minutes * 60_000), seed: segmentSeed(this.seed, Math.floor(now / 1000)) }
    this.change(now, this.target(now), Math.round(secs * 1000))
    this.send(now)
    return ok(`Weather: ${label(kind, intensity)} in ${round(secs, 1)} s, held for ${round(minutes, 1)} min.`, this.sync(now))
  }

  /** The status line of `weather`. */
  describe(now: number): string {
    const s = this.state
    const k = blendFactor(s, now)
    const blend = k >= 1 ? label(s.to, s.intensity) : `${label(s.from, 1)} -> ${label(s.to, s.intensity)} (${Math.round(k * 100)}%)`
    const next =
      this.mode === 'off' ? 'off (WEATHER=off)' : s.until >= FOREVER ? (s.gm ? 'held' : `fixed (WEATHER=${this.mode})`) : `next change in ${Math.max(0, Math.round((s.until - now) / 60_000))} min`
    const wind = `wind ${round(this.state.windMs, 1)} m/s toward ${Math.round((s.windDir * 180) / Math.PI)}°${this.wind ? ' (GM)' : ''}`
    const surf = this.sync(now)
    return `Weather: ${blend}${s.gm ? ' [GM hold]' : ''}; ${next}; wet ${round(surf.wet)}, puddles ${round(surf.puddle)}; ${wind}.`
  }

  // ---- internals -------------------------------------------------------------------------------------------

  /** Where the weather should be now: a GM hold, else the schedule, else the fixed state (or clear when off). */
  private target(now: number): Target {
    if (this.hold && now < this.hold.until) {
      const h = this.hold
      return { kind: h.kind, intensity: h.intensity, until: h.until, seed: h.seed, windDir: this.state?.windDir ?? PREVAILING_WIND, gm: true }
    }
    if (this.mode === 'auto') {
      const seg = this.schedule.at(now)
      // the `until` hint skips segments that repeat the same state
      let end = seg
      for (let i = 0; i < 16; i++) {
        const n = this.schedule.next(end)
        if (n.kind !== seg.kind || n.intensity !== seg.intensity) break
        end = n
      }
      return { kind: seg.kind, intensity: seg.intensity, until: end.end, seed: seg.seed, windDir: seg.windDir, gm: false }
    }
    const kind = this.mode === 'off' ? 'clear' : this.mode
    return { kind, intensity: 1, until: FOREVER, seed: segmentSeed(this.seed, 0), windDir: PREVAILING_WIND, gm: false }
  }

  private syncOf(t: Target, from: WeatherKind, start: number, dur: number, now: number): WeatherSync {
    const s: WeatherSync = {
      start,
      dur: Math.min(WEATHER_LIMITS.durMs, Math.max(0, dur)),
      from,
      to: t.kind,
      intensity: t.intensity,
      until: t.until,
      windDir: ((t.windDir % TAU) + TAU) % TAU,
      windMs: this.wind?.windMs ?? weatherParams(t.kind, t.intensity).windMs,
      wet: this.surface.wet,
      puddle: this.surface.puddle,
      at: now,
      seed: t.seed >>> 0,
    }
    if (t.gm) s.gm = true
    return s
  }

  /** Starts a transition to `t` from the current blend (`dur` = the default for the pair when absent). */
  private change(now: number, t: Target, dur?: number): void {
    this.integrate(now)
    const cur = this.params(now)
    const s = this.state
    const from = now >= s.start + s.dur ? s.to : nearestWeather(cur)
    this.wind = null
    this.startVec = cur
    this.state = this.syncOf(t, from, now, dur ?? (from === t.kind ? SAME_KIND_MS : transitionMs(from, t.kind)), now)
  }

  private integrate(now: number): void {
    const dtS = (now - this.stepAt) / 1000
    if (dtS < 0) this.stepAt = now // the clock went back: go on from here
    if (dtS <= 0) return
    this.surface = stepSurface(this.surface, this.params(now), dtS)
    this.stepAt = now
  }

  /** The vector a schedule segment's transition starts from: the previous segment's state at its own intensity. */
  private segmentStart(seg: WeatherSegment): WeatherParams {
    return weatherParams(seg.prev, seg.prevIntensity)
  }

  /**
   * The wall clock stepped back (W9F F3): every time the module keeps moves by the same step, so a transition keeps its
   * progress, a hold its remaining time and lightning its gap; then a resync tells the clients the new times.
   */
  private clockStepped(now: number): void {
    const back = now - this.lastTick
    const s = this.state
    this.state = { ...s, start: Math.max(0, s.start + back), until: s.until >= FOREVER ? s.until : Math.max(0, s.until + back), at: now }
    if (this.hold) this.hold = { ...this.hold, until: this.hold.until + back }
    this.lastStrike = Math.min(this.lastStrike + back, now)
    this.stepAt = now
    this.lastTick = now - TICK_MS
    this.send(now)
  }

  /** The surface state after the last 90 minutes of this weather (so a restart does not dry the world at once). */
  private warmUp(now: number): void {
    let s: SurfaceState = { wet: 0, puddle: 0 }
    for (let t = now - WARMUP_MS; t < now; t += WARMUP_STEP_S * 1000) {
      let p: WeatherParams
      if (this.mode === 'auto') {
        const seg = this.schedule.at(t)
        p = blendWeather({ start: seg.start, dur: transitionMs(seg.prev, seg.kind), from: seg.prev, to: seg.kind, intensity: seg.intensity }, t, this.segmentStart(seg))
      } else p = this.params(t)
      s = stepSurface(s, p, WARMUP_STEP_S)
    }
    this.schedule.at(now)
    this.surface = s
    this.stepAt = now
  }

  private rollLightning(now: number, dtS: number): void {
    const rate = this.params(now).lightning
    if (rate <= 0 || now - this.lastStrike < LIGHTNING_MIN_GAP_MS) return
    if (this.rng() >= 1 - Math.exp((-rate * dtS) / 60)) return
    this.strike(now, LIGHTNING_DIST_M[0] + (LIGHTNING_DIST_M[1] - LIGHTNING_DIST_M[0]) * this.rng())
  }

  private strike(now: number, distM: number): void {
    this.lastStrike = now
    this.host.world.broadcast({ t: 'lightning', at: now, distM: Math.round(distM), bearing: round(this.rng() * TAU, 4) % TAU })
  }

  private send(now: number): void {
    this.lastSent = now
    this.host.world.broadcast({ t: 'weather', weather: this.sync(now) })
  }
}
