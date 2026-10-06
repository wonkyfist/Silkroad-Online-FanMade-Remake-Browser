/**
 * The client's mirror of the snow season (docs/WINTER.md §5, §8; pure: no Babylon, no DOM). The server's `winter` state
 * (WorldInfo.winter at enter, then the `winter` message) is carried forward between messages with the server's own
 * integrator (shared stepWinter) under the weather the player sees, so the snow builds up and melts at the same pace
 * everywhere; what is drawn eases toward it (a new message, a GM preview or its end never pops).
 *
 * - `frame(now, dt, weather, daylight)` → the cover (× the admin strength) and the frost to draw, eased with EASE_TAU_S.
 * - A GM preview (`winter preview`) draws the full look (cover 1, frost 1) without touching the state.
 * - `?winter=<0..1>` (debug, offline) holds a look until the first `winter` message.
 */
import { BARE, stepWinter, type WinterState, type WinterSync, type WinterWeather } from '@sro/shared'

/** The drawn look follows its target with this time constant (s): ~95 % in 3 × that. */
export const EASE_TAU_S = 2.5
/** A gap between frames longer than this (s) re-derives the state from the sync. */
export const REBASE_S = 2

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0)

export interface WinterLook {
  /** Snow cover to draw 0..1 (after the admin strength). */
  cover: number
  /** Frost to draw 0..1. */
  frost: number
  /** The season is on (or a preview shows it). */
  season: boolean
}

/** `?winter=<0..1>` → a held look (null: none or malformed). */
export function parseWinterOverride(search: string): number | null {
  const raw = new URLSearchParams(search).get('winter')
  if (raw === null || raw === '') return null
  const v = Number(raw)
  return Number.isFinite(v) ? clamp01(v) : null
}

export class WinterClient {
  private sync: WinterSync | null = null
  private state: WinterState = { ...BARE }
  private stateAt = 0
  private readonly drawn = { cover: 0, frost: 0 }
  private primed = false
  private override: number | null

  constructor(override: number | null = null) {
    this.override = override
  }

  /** The last sync (null: none yet). */
  get current(): Readonly<WinterSync> | null {
    return this.sync
  }

  /** The integrated state (before the preview, the strength and the easing). */
  get raw(): Readonly<WinterState> {
    return this.state
  }

  /** WorldInfo.winter (absent: an older server, no snow). Snaps the drawn look (a fresh world has no "before"). */
  enter(s: WinterSync | undefined, now: number): void {
    this.sync = s ?? null
    this.state = s ? { cover: s.cover, frost: s.frost } : { ...BARE }
    this.stateAt = s ? s.at : now
    this.primed = false
  }

  /** A `winter` message: the server's state from its `at` on; the drawn look eases toward it. */
  message(s: WinterSync): void {
    this.override = null
    this.sync = s
    this.state = { cover: s.cover, frost: s.frost }
    this.stateAt = s.at
  }

  /** This frame's look at server ms `now`, `dtS` after the last one, under `weather` and `daylight` (0..1). */
  frame(now: number, dtS: number, weather: WinterWeather, daylight: number): WinterLook {
    const s = this.sync
    if (s && this.override === null) {
      const since = (now - this.stateAt) / 1000
      if (since > 0) {
        // a long gap (a hidden tab) integrates in one call: stepWinter sub-steps it and caps it at 72 h
        // a GM time-lapse (WinterSync.speed) runs the snow as many times faster, as on the server
        this.state = stepWinter(this.state, weather, { season: s.season, daylight: clamp01(daylight) }, since * (s.speed ?? 1))
        this.stateAt = now
      } else if (since < -REBASE_S) this.stateAt = now
    }
    const preview = !!s?.preview
    const strength = s ? clamp01(s.strength) : 1
    const want = this.override !== null
      ? { cover: this.override, frost: this.override }
      : preview
        ? { cover: strength, frost: 1 }
        : { cover: this.state.cover * strength, frost: this.state.frost }
    const dt = Number.isFinite(dtS) && dtS > 0 ? Math.min(dtS, 1) : 0
    const k = this.primed ? 1 - Math.exp(-dt / EASE_TAU_S) : 1
    this.drawn.cover += (want.cover - this.drawn.cover) * k
    this.drawn.frost += (want.frost - this.drawn.frost) * k
    if (Math.abs(this.drawn.cover - want.cover) < 1e-4) this.drawn.cover = want.cover
    if (Math.abs(this.drawn.frost - want.frost) < 1e-4) this.drawn.frost = want.frost
    this.primed = true
    return { cover: clamp01(this.drawn.cover), frost: clamp01(this.drawn.frost), season: preview || !!s?.season || this.override !== null }
  }
}
