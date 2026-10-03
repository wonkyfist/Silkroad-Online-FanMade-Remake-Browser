/**
 * The stage's time and weather (docs/SCREENS.md §0B.3, §9; lane SCR-R).
 *
 * - Time: the server's live clock (`app.session.server.clock`, the validated `welcome` copy; never the unvalidated
 *   server list), read at the server time (`session.clock.serverNow()`: the lobby socket's ping/pong offset). While the
 *   live solar time is inside [sunrise, sunset] for the clock's declination the stage runs the clock like the world
 *   (`World.setClock`), so the sky there is the sky the player walks into. **At night it holds at sunset**
 *   (`sunriseSunset(declination).set`: 0.773 = 18:33 at the default +12°), the best look on the steps.
 * - The hold does not blend at sunrise (`World.setTimeOfDay` and `setClock` snap, and a tween from 18:33 to 05:27 would
 *   sweep the sun through the whole day or night): it lasts until the next `enter()` (select ↔ create, a new visit),
 *   and from then the live clock runs. A live day that reaches sunset while a stage is up holds there (no jump: the
 *   clock is at sunset when it happens).
 * - No clock (the mock, an older server): the stage's fixed fallback. Without the new look (the Low guard's combination:
 *   `EffectiveGraphics.clock` false) the frozen noon of the world screen (sky-clock.ts).
 * - Weather: the server's (`app.session.server.weather`) through the world screen's `WeatherClient`, at **half
 *   intensity and never lightning** (§4.4: rain on the stage is a nice touch, a bolt behind the menu is not). Absent, a
 *   'clear' stage, or without the new look (`weatherShown` false): the clear frame.
 */
import { clockAt, sunriseSunset, type WorldClockState } from '@sro/shared'
import { CLEAR_FRAME, type WeatherFrame } from '@sro/world-render'
import type { StageDef } from './types.ts'

/** What the stage's sky shows: a fixed time, the live clock, or the sunset hold. */
export type StageTimeMode = 'fixed' | 'live' | 'hold'

export interface StageTimeChoice {
  mode: StageTimeMode
  /** The solar time shown now (0..1, 0 = midnight). */
  t: number
}

/** The frozen noon of the world without the new look (sky-clock.ts). */
export const FROZEN_NOON = 0.5

/** Whether solar time `t` is daytime for a declination (inside [sunrise, sunset]). */
export function isDaytime(t: number, declination: number): boolean {
  const { rise, set } = sunriseSunset(declination)
  return t >= rise && t <= set
}

/**
 * The time policy at `enter()` (SCREENS §0B.3): a fixed stage time; the live clock by day; the sunset hold at night;
 * the fallback without a clock. `clockOn` false (no new look): the frozen noon.
 */
export function stageTimeAt(time: StageDef['time'], clock: WorldClockState | null | undefined, serverNowMs: number, clockOn = true): StageTimeChoice {
  if (!clockOn) return { mode: 'fixed', t: FROZEN_NOON }
  if (typeof time === 'number') return { mode: 'fixed', t: time }
  if (!clock) return { mode: 'fixed', t: time.fallback }
  const t = clockAt(clock, serverNowMs).t
  if (isDaytime(t, clock.declination)) return { mode: 'live', t }
  return { mode: 'hold', t: sunriseSunset(clock.declination).set }
}

/** The part of World the stage time drives. */
export interface StageTimeWorld {
  setTimeOfDay(t: number): void
  setClock(clock: WorldClockState | null, serverNow?: () => number): void
}

/**
 * The stage's clock: `enter` picks the policy and applies it, `update` (per frame) turns a live day that reached
 * sunset into the hold. The hold never ends by itself (only the next `enter`).
 */
export class StageTime {
  private choice: StageTimeChoice = { mode: 'fixed', t: FROZEN_NOON }
  private clock: WorldClockState | null = null
  private serverNow: () => number = () => Date.now()

  get mode(): StageTimeMode {
    return this.choice.mode
  }

  /** The time the stage shows now (live: the clock's). */
  get t(): number {
    return this.choice.mode === 'live' && this.clock ? clockAt(this.clock, this.serverNow()).t : this.choice.t
  }

  enter(world: StageTimeWorld, time: StageDef['time'], clock: WorldClockState | null | undefined, serverNow: () => number, clockOn = true): StageTimeChoice {
    this.clock = clock ?? null
    this.serverNow = serverNow
    this.choice = stageTimeAt(time, clock, serverNow(), clockOn)
    if (this.choice.mode === 'live') world.setClock(this.clock, serverNow)
    else world.setTimeOfDay(this.choice.t)
    return this.choice
  }

  /** Per frame: a live day that passed sunset holds there. true when it switched. */
  update(world: StageTimeWorld): boolean {
    if (this.choice.mode !== 'live' || !this.clock) return false
    const t = clockAt(this.clock, this.serverNow()).t
    if (isDaytime(t, this.clock.declination)) return false
    const { set } = sunriseSunset(this.clock.declination)
    this.choice = { mode: 'hold', t: set }
    world.setTimeOfDay(set)
    return true
  }
}

/** The stage's share of the server weather (§0B.3). */
export const STAGE_WEATHER_SCALE = 0.5

/** The frame fields the stage halves (toward the clear frame); the rest (wind direction, time) pass through. */
const SCALED = ['cloud', 'cloudDark', 'cirrus', 'rain', 'fog', 'sun', 'desat', 'windMs', 'gustMs', 'wet', 'puddle'] as const

/**
 * A weather frame at half intensity with no lightning (SCREENS §4.4): every weather parameter halfway from the clear
 * frame to the server's (a clear sky stays exactly clear), the flash always 0. Written into `out` (per frame).
 */
export function stageWeather(f: Readonly<WeatherFrame>, out: WeatherFrame, scale = STAGE_WEATHER_SCALE): WeatherFrame {
  Object.assign(out, f)
  for (const k of SCALED) out[k] = CLEAR_FRAME[k] + (f[k] - CLEAR_FRAME[k]) * scale
  out.flash = 0
  out.flashX = 0
  out.flashZ = 0
  return out
}
