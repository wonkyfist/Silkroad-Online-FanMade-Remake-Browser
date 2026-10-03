import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOCK_EPOCH_DAYS,
  CLOCK_EPOCH_MS,
  CLOCK_LIMITS,
  SYNODIC_MONTH,
  clockAt,
  formatClock,
  phaseForSolarTime,
  validateServerMessage,
  type WorldClockState,
} from '@sro/shared'
import { W9_DEFAULTS, type ServerConfig } from './config.ts'
import type { GmResult } from './gm.ts'

/**
 * The world clock (docs/SKY.md §2.2, docs/WAVE_PLAN3.md §3, §6.1; lane W9A-P).
 *
 * - With no saved state the clock is anchored at a fixed epoch (2026-01-01T00:00Z = day 0.3) with the config's day
 *   length, night speed-up and season, so it is the same after every restart and needs no database.
 * - GM changes persist to `<DATA_DIR>/world-clock.json` (written atomically: tmp + rename); `time reset` deletes it.
 * - Every change re-anchors at "now", so only `time <hh:mm>` and `time day <n>` move the solar time; a new length, a
 *   freeze/resume or a new night speed-up keep it. gm.ts sends `worldClock` to the players in the world after a
 *   change (never to lobby sockets); clients extrapolate between changes, so nothing is sent periodically.
 */

export const WORLD_CLOCK_FILE = 'world-clock.json'
export const TIME_USAGE = 'time [hh:mm | day <n> | length <minutes> | freeze | resume | night <0-0.6> | season <degrees> | reset]'

/** What a clock command did: the GM reply, plus whether the state changed (gm.ts then sends `worldClock`). */
export interface ClockCommandResult extends GmResult {
  changed: boolean
}

type ClockConfig = Pick<ServerConfig, 'dataDir' | 'log' | 'dayLengthMin' | 'dayNightSpeedup' | 'daySeasonDeg'>

const MAX_DAY = CLOCK_LIMITS.anchorDays[1] - 1
/**
 * A re-anchor outside CLOCK_LIMITS.anchorDays moves the day count by whole multiples of this many days (100 synodic
 * months, 2953 days): the time of day and the moon phase stay, only the day number drops (W9F F4, P3). Clamping it
 * instead threw the time of day away (a long-running clock at 1 min a day passes day 1e6 in under two years).
 */
export const DAY_WRAP = Math.round(SYNODIC_MONTH * 100)

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

/** A saved or wire clock checked with the client's own validator (the same ranges); null when invalid. */
function checked(raw: unknown): WorldClockState | null {
  const r = validateServerMessage({ t: 'worldClock', clock: raw })
  return r.ok && r.msg.t === 'worldClock' ? r.msg.clock : null
}

export class WorldClock {
  private constructor(
    private readonly config: ClockConfig,
    private current: WorldClockState,
  ) {}

  /** The saved clock (`<DATA_DIR>/world-clock.json`) or, without one (or a bad one, logged), the config defaults. */
  static load(config: ClockConfig): WorldClock {
    const clock = new WorldClock(config, WorldClock.defaults(config))
    let text: string | null = null
    try {
      text = readFileSync(clock.file, 'utf8')
    } catch {
      // no saved clock: the defaults
    }
    if (text !== null) {
      let saved: WorldClockState | null = null
      try {
        saved = checked(JSON.parse(text))
      } catch {
        // reported below
      }
      if (saved) clock.current = saved
      else config.log(`world clock: ignoring ${clock.file} (not a valid clock); using the defaults`)
    }
    return clock
  }

  /** The config clock at the fixed epoch (DAY_LENGTH_MIN, DAY_NIGHT_SPEEDUP, DAY_SEASON_DEG). */
  static defaults(config: Pick<ServerConfig, 'dayLengthMin' | 'dayNightSpeedup' | 'daySeasonDeg'>): WorldClockState {
    const minutes = clamp(config.dayLengthMin ?? W9_DEFAULTS.dayLengthMin, 1, 1440)
    return {
      anchorMs: CLOCK_EPOCH_MS,
      anchorDays: CLOCK_EPOCH_DAYS,
      dayMs: Math.round(minutes * 60_000),
      running: true,
      nightSpeedup: clamp(config.dayNightSpeedup ?? W9_DEFAULTS.dayNightSpeedup, ...CLOCK_LIMITS.nightSpeedup),
      declination: clamp(config.daySeasonDeg ?? W9_DEFAULTS.daySeasonDeg, ...CLOCK_LIMITS.declination),
    }
  }

  get file(): string {
    return join(this.config.dataDir, WORLD_CLOCK_FILE)
  }

  /** A copy of the state (what worldEnter and `worldClock` carry). */
  get state(): WorldClockState {
    return { ...this.current }
  }

  /** Days, solar time t and the day index at `nowMs` (for night-only server content later). */
  now(nowMs = Date.now()): { days: number; t: number; day: number } {
    const { days, t, day } = clockAt(this.current, nowMs)
    return { days, t, day }
  }

  /** "Day 12, 14:32, 1 day = 120 min, running, night ×0.4, season +12°". */
  describe(nowMs = Date.now()): string {
    const c = this.current
    const { t, day } = clockAt(c, nowMs)
    const minutes = Math.round((c.dayMs / 60_000) * 10) / 10
    const season = `${c.declination >= 0 ? '+' : ''}${Math.round(c.declination * 100) / 100}°`
    return `${formatClock(t, day)}, 1 day = ${minutes} min, ${c.running ? 'running' : 'frozen'}, night ×${Math.round(c.nightSpeedup * 100) / 100}, season ${season}`
  }

  /** The GM `time` command (docs/WAVE_PLAN3.md §3.5). */
  gm(args: string[], nowMs = Date.now()): ClockCommandResult {
    const usage = (): ClockCommandResult => ({ ok: false, message: `Usage: ${TIME_USAGE}`, changed: false })
    const a = (args[0] ?? '').toLowerCase()
    const c = this.current
    const { days, t, day } = clockAt(c, nowMs)
    let next: WorldClockState | null = null
    if (args.length === 0) return { ...this.reply(nowMs, this.describe(nowMs)), changed: false }
    const hm = /^(\d{1,2}):(\d{2})$/.exec(a)
    if (hm && args.length === 1) {
      const h = Number(hm[1])
      const m = Number(hm[2])
      if (h > 23 || m > 59) return { ok: false, message: 'The time must be 00:00 to 23:59.', changed: false }
      next = this.anchored(nowMs, day + phaseForSolarTime((h * 60 + m) / 1440, c.nightSpeedup))
    } else if (a === 'day' && args.length === 2) {
      const n = num(args[1])
      if (n === null || !Number.isInteger(n) || n < 0 || n > MAX_DAY) return { ok: false, message: `The day must be a whole number from 0 to ${MAX_DAY}.`, changed: false }
      next = this.anchored(nowMs, n + (days - day))
    } else if (a === 'length' && args.length === 2) {
      const n = num(args[1])
      if (n === null || n < 1 || n > 1440) return { ok: false, message: 'The day length is 1 to 1440 minutes.', changed: false }
      next = { ...this.anchored(nowMs, days), dayMs: Math.round(n * 60_000) }
    } else if ((a === 'freeze' || a === 'resume') && args.length === 1) {
      next = { ...this.anchored(nowMs, days), running: a === 'resume' }
    } else if (a === 'night' && args.length === 2) {
      const k = num(args[1])
      if (k === null || k < CLOCK_LIMITS.nightSpeedup[0] || k > CLOCK_LIMITS.nightSpeedup[1]) return { ok: false, message: 'The night speed-up is 0 to 0.6.', changed: false }
      // keep the solar time: the same t lies at another phase under the new k
      next = { ...this.anchored(nowMs, day + phaseForSolarTime(t, k)), nightSpeedup: k }
    } else if (a === 'season' && args.length === 2) {
      const d = num(args[1])
      if (d === null || d < CLOCK_LIMITS.declination[0] || d > CLOCK_LIMITS.declination[1]) return { ok: false, message: 'The season (sun declination) is -23.44 to 23.44 degrees.', changed: false }
      next = { ...c, declination: d }
    } else if (a === 'reset' && args.length === 1) {
      this.current = WorldClock.defaults(this.config)
      try {
        rmSync(this.file, { force: true })
      } catch (e) {
        this.config.log(`world clock: could not delete ${this.file}: ${(e as Error).message}`)
      }
      return { ...this.reply(nowMs, `Clock reset to the defaults: ${this.describe(nowMs)}.`), changed: true }
    } else return usage()
    const valid = checked(next)
    if (!valid) return { ok: false, message: 'That would put the clock out of range.', changed: false }
    this.current = valid
    const saved = this.save()
    return { ...this.reply(nowMs, `Clock set: ${this.describe(nowMs)}.${saved ? '' : ' (Not saved: see the server log.)'}`), changed: true }
  }

  private reply(nowMs: number, message: string): GmResult {
    const { t, day } = clockAt(this.current, nowMs)
    return { ok: true, message, data: { clock: this.state, t, day } }
  }

  /** The current settings re-anchored at `nowMs` on `days` (brought into range by DAY_WRAP, never clamped). */
  private anchored(nowMs: number, days: number): WorldClockState {
    const [lo, hi] = CLOCK_LIMITS.anchorDays
    let d = days
    if (d > hi) d -= Math.ceil((d - hi) / DAY_WRAP) * DAY_WRAP
    else if (d < lo) d += Math.ceil((lo - d) / DAY_WRAP) * DAY_WRAP
    return { ...this.current, anchorMs: Math.max(0, Math.round(nowMs)), anchorDays: d }
  }

  /** Atomic write of the state; false (logged) when it failed. The clock still changes for this run. */
  private save(): boolean {
    const tmp = `${this.file}.tmp`
    try {
      mkdirSync(this.config.dataDir, { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(this.current, null, 2)}\n`)
      renameSync(tmp, this.file)
      return true
    } catch (e) {
      this.config.log(`world clock: could not save ${this.file}: ${(e as Error).message}`)
      return false
    }
  }
}
