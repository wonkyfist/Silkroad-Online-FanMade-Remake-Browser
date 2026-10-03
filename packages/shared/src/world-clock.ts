/**
 * The world clock (docs/SKY.md §2, docs/WAVE_PLAN3.md §3.1): game days, the night warp, the sun and the moon.
 * Pure and environment-neutral; the server owns the state (apps/server/src/world-clock.ts), clients extrapolate it
 * from the anchor with their server-time offset.
 *
 * - `days`: a float count of game days, never wrapped. Phase `p = frac(days)`, day index `d = floor(days)`.
 * - `t`: solar time in [0, 1), 0 = midnight: `t = p − k/2π · sin(2π(p − 0.5))` with `k = nightSpeedup`. The warp is
 *   monotonic for k < 1, so the displayed clock (t) never runs backwards; it only runs faster at night.
 * - Directions are glTF (+X east, +Y up, north = −Z; docs/TERRAIN.md §8) and point *to* the body.
 */

export interface WorldClockState {
  /** Server epoch ms (Date.now() frame) at which days == anchorDays; int >= 0. */
  anchorMs: number
  /** Game days at anchorMs, 0 .. 1e6. */
  anchorDays: number
  /** Real ms per game day, int, 60_000 .. 86_400_000 (1 min .. 24 h). */
  dayMs: number
  /** false = frozen at anchorDays. */
  running: boolean
  /** Night speed-up k, 0 .. 0.6. */
  nightSpeedup: number
  /** Sun declination in degrees (the season), -23.44 .. 23.44. */
  declination: number
}

/** Jangan (Xi'an), degrees north. */
export const JANGAN_LATITUDE = 34.3

/** Config defaults: 120 real minutes per game day, running, night ×0.4 faster, season +12° (SKY §2.3). */
export const DEFAULT_CLOCK: Readonly<Omit<WorldClockState, 'anchorMs' | 'anchorDays'>> = {
  dayMs: 120 * 60_000,
  running: true,
  nightSpeedup: 0.4,
  declination: 12,
}

/** With no saved state the clock is anchored here, so it is deterministic across restarts (SKY §2.2). */
export const CLOCK_EPOCH_MS = Date.UTC(2026, 0, 1)
export const CLOCK_EPOCH_DAYS = 0.3

/** Wire ranges of WorldClockState (validate.ts and the server use the same numbers). */
export const CLOCK_LIMITS = {
  anchorDays: [0, 1e6],
  dayMs: [60_000, 86_400_000],
  nightSpeedup: [0, 0.6],
  declination: [-23.44, 23.44],
} as const

/** Synodic month in game days (29.53 game days = 59 real hours at the default length). */
export const SYNODIC_MONTH = 29.53
/** Moon age at days = 0 (so the phase is a pure function of the day count). */
export const MOON_OFFSET_DAYS = 0
/** The moon is not drawn within this many days of new moon (SKY §2.1). */
export const MOON_HIDDEN_DAYS = 0.75
/** Retail moon textures moon01..moon30.ddj; moon16 is the full moon (SKY §2.1, verified on the files). */
export const MOON_TEXTURES = 30

const TAU = Math.PI * 2
const DEG = Math.PI / 180

function frac(x: number): number {
  return x - Math.floor(x)
}

/** Game days at server time `serverNowMs` (a frozen clock stays at anchorDays). */
export function clockDays(c: WorldClockState, serverNowMs: number): number {
  return c.running ? c.anchorDays + (serverNowMs - c.anchorMs) / c.dayMs : c.anchorDays
}

/** Solar time t in [0, 1] of day phase `phase` (0..1) under night speed-up k: fixes 0, 0.5 and 1. */
export function solarTime(phase: number, k: number): number {
  return phase - (k / TAU) * Math.sin(TAU * (phase - 0.5))
}

/** The phase whose solar time is `t` (the inverse of solarTime, by bisection; `t` is wrapped into [0, 1)). */
export function phaseForSolarTime(t: number, k: number): number {
  const target = frac(t)
  let lo = 0
  let hi = 1
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (solarTime(mid, k) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Where the clock is at `serverNowMs`: days, phase, solar time t and the day index. */
export function clockAt(c: WorldClockState, serverNowMs: number): { days: number; phase: number; t: number; day: number } {
  const days = clockDays(c, serverNowMs)
  const phase = frac(days)
  return { days, phase, t: frac(solarTime(phase, c.nightSpeedup)), day: Math.floor(days) }
}

/**
 * Unit direction to the sun at solar time `t` (glTF). Hour angle H = (t − 0.5)·2π; in ENU
 * E = −cos δ sin H, N = cos φ sin δ − sin φ cos δ cos H, U = sin φ sin δ + cos φ cos δ cos H; glTF = (E, U, −N).
 * t = 0.25 rises in the east (+X); at noon the sun stands in the south (+Z).
 */
export function sunDirection(t: number, declDeg: number, latDeg = JANGAN_LATITUDE): [number, number, number] {
  const h = (t - 0.5) * TAU
  const d = declDeg * DEG
  const p = latDeg * DEG
  const e = -Math.cos(d) * Math.sin(h)
  const n = Math.cos(p) * Math.sin(d) - Math.sin(p) * Math.cos(d) * Math.cos(h)
  const u = Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(h)
  return [e, u, -n]
}

/**
 * The moon on game day `days`: `age` in days since new moon (0..29.53), `illum` the lit fraction (0..1), `texture`
 * the retail moon texture 1..30 (16 = full), and `hourOffset`, the fraction of a day the moon trails the sun
 * (age / 29.53): its direction is `sunDirection(t − hourOffset, declination)`, so the full moon rises at sunset.
 */
export function moonState(days: number): { age: number; illum: number; texture: number; hourOffset: number } {
  const age = ((((days + MOON_OFFSET_DAYS) % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH)
  const f = age / SYNODIC_MONTH
  return {
    age,
    illum: (1 - Math.cos(TAU * f)) / 2,
    texture: Math.min(MOON_TEXTURES, Math.floor(f * MOON_TEXTURES) + 1),
    hourOffset: f,
  }
}

/** Whether the moon is drawn at `age` (hidden within MOON_HIDDEN_DAYS of new moon). */
export function moonVisible(age: number): boolean {
  return age >= MOON_HIDDEN_DAYS && age <= SYNODIC_MONTH - MOON_HIDDEN_DAYS
}

/**
 * Sunrise and sunset in solar time t (geometric horizon, no refraction). Polar day gives {rise: 0, set: 1}, polar
 * night {rise: 0.5, set: 0.5}.
 */
export function sunriseSunset(declDeg: number, latDeg = JANGAN_LATITUDE): { rise: number; set: number } {
  const cosH = -Math.tan(latDeg * DEG) * Math.tan(declDeg * DEG)
  if (cosH <= -1) return { rise: 0, set: 1 }
  if (cosH >= 1) return { rise: 0.5, set: 0.5 }
  const h = Math.acos(cosH) / TAU
  return { rise: 0.5 - h, set: 0.5 + h }
}

/** "Day 12, 05:27" for solar time `t` on day index `day`. */
export function formatClock(t: number, day: number): string {
  // + 1e-6 min: a time set by phaseForSolarTime may come back a hair early (05:59:59.99999 for 06:00)
  const minutes = Math.min(1439, Math.floor(frac(t) * 1440 + 1e-6))
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `Day ${day}, ${hh}:${mm}`
}
