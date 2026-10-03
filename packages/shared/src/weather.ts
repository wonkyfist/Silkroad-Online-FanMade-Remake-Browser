/**
 * Server weather (docs/WEATHER.md §2, §6.1, §7; docs/WAVE_PLAN3.md §3.1): the states and their parameter vectors,
 * transitions, the seeded schedule, the wet/dry integrator, the lightning flash curve and the fog-distance factor.
 * Pure and environment-neutral: the server (apps/server/src/weather.ts) and the client feature run the same code.
 */

import type { WeatherSync } from './protocol.ts'

export const WEATHER_KINDS = ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog'] as const
export type WeatherKind = (typeof WEATHER_KINDS)[number]

/** One state's parameters; the client blends vectors, the server only names states (WEATHER §2.1). */
export interface WeatherParams {
  /** Cloud cover 0..1. */
  cloud: number
  /** How dark the clouds are 0..1. */
  cloudDark: number
  /** High thin cloud 0..1 (sky only). */
  cirrus: number
  /** Rain rate 0..1 (1 = heavy downpour). */
  rain: number
  /** Mean wind, m/s. */
  windMs: number
  /** Gust amplitude 0..1. */
  gust: number
  /** Extra fog 0..1. */
  fog: number
  /** Direct light scale 0..1. */
  sun: number
  /** Colour-grading desaturation 0..1. */
  desat: number
  /** Lightning strikes per minute (server). */
  lightning: number
}

const P = (cloud: number, cloudDark: number, rain: number, windMs: number, gust: number, fog: number, sun: number, desat: number, lightning: number, cirrus: number): WeatherParams =>
  ({ cloud, cloudDark, cirrus, rain, windMs, gust, fog, sun, desat, lightning })

/** WEATHER §2.1. */
export const WEATHER_PARAMS: Readonly<Record<WeatherKind, Readonly<WeatherParams>>> = {
  clear: P(0.1, 0, 0, 2, 0.2, 0, 1, 0, 0, 0.3),
  cloudy: P(0.45, 0.1, 0, 4, 0.3, 0.05, 0.85, 0.05, 0, 0.5),
  overcast: P(0.9, 0.35, 0, 5, 0.3, 0.2, 0.35, 0.25, 0, 0.2),
  rain: P(0.95, 0.55, 0.55, 6, 0.4, 0.35, 0.25, 0.35, 0.3, 0),
  storm: P(1, 0.85, 1, 13, 0.9, 0.45, 0.15, 0.45, 5, 0),
  fog: P(0.6, 0.2, 0, 1, 0.1, 0.85, 0.4, 0.3, 0, 0),
}

const PARAM_KEYS = Object.keys(WEATHER_PARAMS.clear) as (keyof WeatherParams)[]

/** Light rain: `rain` may carry an intensity 0.4..1 (1 for every other state). */
export const RAIN_INTENSITY_MIN = 0.4
/** Rain below this intensity has no lightning (WEATHER §2.4). */
export const LIGHTNING_MIN_INTENSITY = 0.8

/** The parameter vector of `kind` at `intensity` (rain scales rain, cloudDark and lightning; lightning 0 below 0.8). */
export function weatherParams(kind: WeatherKind, intensity = 1): WeatherParams {
  const p = { ...WEATHER_PARAMS[kind] }
  if (kind === 'rain' && intensity < 1) {
    const i = Math.max(RAIN_INTENSITY_MIN, intensity)
    p.rain *= i
    p.cloudDark *= i
    p.lightning = i >= LIGHTNING_MIN_INTENSITY ? p.lightning * i : 0
  }
  return p
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** Linear blend, exact at both ends. */
function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** Transition lengths (WEATHER §2.2): 120 s by default, 60 s into storm, 180 s into or out of fog. */
export function transitionMs(from: WeatherKind, to: WeatherKind): number {
  if (from === to) return 0
  if (to === 'fog' || from === 'fog') return 180_000
  if (to === 'storm') return 60_000
  return 120_000
}

/** The blend factor of `sync` at `nowMs` (0 = `from`, 1 = `to`). */
export function blendFactor(sync: Pick<WeatherSync, 'start' | 'dur'>, nowMs: number): number {
  return sync.dur <= 0 ? 1 : smoothstep(0, 1, (nowMs - sync.start) / sync.dur)
}

/**
 * The blended parameters of `sync` at `nowMs` (WEATHER §2.2). `current` is the vector the transition started from
 * (a change that arrives mid-transition starts from the current blend, not from P[from]); absent = P[from] at
 * intensity 1. Rain (and with it lightning) lags the clouds: it starts at k = 0.55 and stops by k = 0.45; fog creeps
 * in over smoothstep(0.2, 1, k). Every other parameter blends linearly in k.
 */
export function blendWeather(sync: Pick<WeatherSync, 'start' | 'dur' | 'from' | 'to' | 'intensity'>, nowMs: number, current?: WeatherParams): WeatherParams {
  const a = current ?? WEATHER_PARAMS[sync.from]
  const b = weatherParams(sync.to, sync.intensity)
  const k = blendFactor(sync, nowMs)
  const out = {} as WeatherParams
  for (const key of PARAM_KEYS) out[key] = mix(a[key], b[key], k)
  const lag = (x: number, y: number) => mix(x, y, y > x ? smoothstep(0.55, 1, k) : smoothstep(0, 0.45, k))
  out.rain = lag(a.rain, b.rain)
  out.lightning = lag(a.lightning, b.lightning)
  out.fog = mix(a.fog, b.fog, smoothstep(0.2, 1, k))
  return out
}

/** The state whose vector is nearest `p` (the `from` a server names for a change that starts mid-transition). */
export function nearestWeather(p: WeatherParams): WeatherKind {
  let best: WeatherKind = 'clear'
  let bestD = Infinity
  for (const kind of WEATHER_KINDS) {
    const q = WEATHER_PARAMS[kind]
    // wind and lightning in their own units would dominate; scale them to about 0..1
    let d = 0
    for (const key of PARAM_KEYS) {
      const s = key === 'windMs' ? 1 / 13 : key === 'lightning' ? 1 / 5 : 1
      d += ((p[key] - q[key]) * s) ** 2
    }
    if (d < bestD) {
      bestD = d
      best = kind
    }
  }
  return best
}

// ---- the seeded schedule (WEATHER §2.3) ----

/** The schedule starts here (2026-01-01T00:00Z) and walks forward. */
export const WEATHER_EPOCH = Date.UTC(2026, 0, 1)

/** Next-state weights (percent) after a dwell. */
export const WEATHER_NEXT: Readonly<Record<WeatherKind, readonly (readonly [WeatherKind, number])[]>> = {
  clear: [['clear', 45], ['cloudy', 45], ['fog', 10]],
  cloudy: [['clear', 40], ['cloudy', 20], ['overcast', 40]],
  overcast: [['cloudy', 35], ['overcast', 15], ['rain', 42], ['fog', 8]],
  rain: [['overcast', 55], ['rain', 25], ['storm', 20]],
  storm: [['rain', 70], ['overcast', 30]],
  fog: [['clear', 50], ['cloudy', 50]],
}

/** Dwell range of each state, minutes. */
export const WEATHER_DWELL_MIN: Readonly<Record<WeatherKind, readonly [number, number]>> = {
  clear: [20, 45],
  cloudy: [15, 35],
  overcast: [12, 30],
  rain: [8, 20],
  storm: [5, 12],
  fog: [10, 25],
}

/** One scheduled segment: `kind` holds from `start` to `end` (server ms), after `prev`. */
export interface WeatherSegment {
  index: number
  kind: WeatherKind
  /** The previous segment's state (the first segment's is its own). */
  prev: WeatherKind
  /** The previous segment's rain intensity (the vector its transition starts from: weatherParams(prev, prevIntensity)). */
  prevIntensity: number
  /** 0.4..1 for rain, 1 otherwise. */
  intensity: number
  start: number
  end: number
  /** u32 seed of this segment (client gust noise, server lightning rolls, wind direction). */
  seed: number
  /** Direction the wind blows toward, radians in the glTF XZ plane (0 = +X east, π/2 = −Z north), 0..2π. */
  windDir: number
}

export interface ScheduleOptions {
  /** 0..3: multiplies the `→ rain` and `→ storm` weights (WEATHER_RAIN_SCALE). Default 1. */
  rainScale?: number
}

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The u32 seed of segment `index` of schedule `seed`. */
export function segmentSeed(seed: number, index: number): number {
  return (Math.imul(index + 1, 0x9e3779b9) ^ (seed >>> 0)) >>> 0
}

/** Prevailing wind: toward the east-north-east, ±0.6 rad per segment. */
const WIND_PREVAILING = 0.35

/**
 * The seeded weather schedule. A Markov chain walked forward from WEATHER_EPOCH; each segment draws its dwell, its
 * successor, its rain intensity and its wind direction from its own seed, so a restart lands on the same segment.
 * `at` caches the walk (the server asks once a second; about 21,000 segments a year).
 */
export class WeatherSchedule {
  private cache: WeatherSegment
  private readonly rainScale: number

  constructor(
    readonly seed: number,
    opts: ScheduleOptions = {},
  ) {
    this.rainScale = Math.max(0, Math.min(3, opts.rainScale ?? 1))
    this.cache = this.first()
  }

  private first(): WeatherSegment {
    return this.make(0, 'clear', 'clear', WEATHER_EPOCH, 1)
  }

  private make(index: number, kind: WeatherKind, prev: WeatherKind, start: number, prevIntensity: number): WeatherSegment {
    const s = segmentSeed(this.seed, index)
    const r = mulberry32(s)
    const [lo, hi] = WEATHER_DWELL_MIN[kind]
    const dwell = lo + (hi - lo) * r()
    r() // the successor draw (next())
    const intensity = kind === 'rain' ? Math.round((RAIN_INTENSITY_MIN + (1 - RAIN_INTENSITY_MIN) * r()) * 100) / 100 : 1
    const windDir = (WIND_PREVAILING + (r() - 0.5) * 1.2 + Math.PI * 2) % (Math.PI * 2)
    return { index, kind, prev, prevIntensity, intensity, start, end: start + Math.round(dwell * 60_000), seed: s, windDir }
  }

  /** The segment after `seg`. */
  next(seg: WeatherSegment): WeatherSegment {
    const r = mulberry32(seg.seed)
    r() // the dwell draw
    const weights = WEATHER_NEXT[seg.kind].map(([k, w]) => [k, k === 'rain' || k === 'storm' ? w * this.rainScale : w] as const)
    const total = weights.reduce((s, [, w]) => s + w, 0)
    let x = r() * total
    let kind: WeatherKind = seg.kind
    for (const [k, w] of weights) {
      if (w <= 0) continue
      kind = k
      if ((x -= w) < 0) break
    }
    return this.make(seg.index + 1, kind, seg.kind, seg.end, seg.intensity)
  }

  /** The segment that holds at server ms `tMs` (times before the epoch get the first segment). */
  at(tMs: number): WeatherSegment {
    if (tMs < this.cache.start) this.cache = this.first()
    while (tMs >= this.cache.end) this.cache = this.next(this.cache)
    return this.cache
  }
}

/** The segment that holds at `tMs` for `seed` (a fresh walk from the epoch; the server keeps a WeatherSchedule). */
export function scheduleAt(seed: number, tMs: number, opts?: ScheduleOptions): WeatherSegment {
  return new WeatherSchedule(seed, opts).at(tMs)
}

// ---- zones (WEATHER §2.5): client-side modulation by the zone under the camera ----

export interface ZoneClimate {
  rainMul: number
  fogAdd: number
  windMul: number
  /** Minimum surface wetness in the zone. */
  wetFloor: number
}

export const NEUTRAL_CLIMATE: Readonly<ZoneClimate> = { rainMul: 1, fogAdd: 0, windMul: 1, wetFloor: 0 }

const RIDGE: ZoneClimate = { rainMul: 1, fogAdd: 0.1, windMul: 1.4, wetFloor: 0 }
const WEST: ZoneClimate = { rainMul: 0.5, fogAdd: 0, windMul: 1.3, wetFloor: 0 }

/** By zones.json `name`; any other zone (and '') is NEUTRAL_CLIMATE. */
export const ZONE_CLIMATE: Readonly<Record<string, Readonly<ZoneClimate>>> = {
  'Swamp area': { rainMul: 1.2, fogAdd: 0.25, windMul: 0.8, wetFloor: 0.35 },
  'Lake Forest': { rainMul: 1.1, fogAdd: 0.15, windMul: 0.9, wetFloor: 0.15 },
  'North-Tiger Mt.': RIDGE,
  'South-Tiger Mt.': RIDGE,
  'Hill of Ye Mt.': RIDGE,
  'Western China Ruins': WEST,
  'Earth Ghost Canyon': WEST,
  'Entrance-Western China Donwhang': WEST,
  'Western China Northern Road': WEST,
}

/** The climate of a zone name (null / unknown = neutral). */
export function zoneClimate(name: string | null | undefined): Readonly<ZoneClimate> {
  return (name && Object.prototype.hasOwnProperty.call(ZONE_CLIMATE, name) ? ZONE_CLIMATE[name] : null) ?? NEUTRAL_CLIMATE
}

// ---- wet surfaces (WEATHER §6.1, corrected) ----

export interface SurfaceState {
  wet: number
  puddle: number
}

/** stepSurface stops integrating after this much time (a client catching up from an old `at`). */
const SURFACE_MAX_STEP_S = 6 * 3600

/**
 * Puddles fill above this rain rate (wave 12 RAIN-P: 0.3 → 0.15, so the `rain` state at any intensity ≥ ~0.3 fills
 * them, a drizzle barely).
 */
export const PUDDLE_RAIN_MIN = 0.15
/**
 * Seconds a full downpour (rain 1) takes to fill the puddles from empty (wave 12 RAIN-P: 240 → 150). With the rain
 * rate's share above PUDDLE_RAIN_MIN: the `rain` state (0.55) reaches 0.17 (the deepest basins show) in ~54 s, 0.56 at
 * 3 min and full in ~5.3 min; a storm (1.0) shows its first puddles in ~25 s and fills them in 2.5 min.
 */
export const PUDDLE_FILL_S = 150

/**
 * Integrates surface wetness and puddles over `dtS` seconds under `p` (sub-steps of 1 s; returns a new state).
 * - Wetting: `wet += (1 − wet) × rain × dt / 40` (storm soaks to 0.9 in ~92 s).
 * - Drying (no rain): `wet −= dt × (0.15 + 0.35 sun + 0.02 windMs) / 300` (~9 min in clear or cloudy, ~13.5 min overcast).
 * - Puddles grow above rain PUDDLE_RAIN_MIN: `puddle += (rain − 0.15) / 0.85 × dt / PUDDLE_FILL_S`, else drain at
 *   `dt × (0.1 + 0.25 sun) / 600`; on every step they are capped at `wet + 0.1`, so in practice they shrink with the
 *   drying surface.
 */
export function stepSurface(s: SurfaceState, p: Pick<WeatherParams, 'rain' | 'sun' | 'windMs'>, dtS: number): SurfaceState {
  let wet = clamp01(s.wet)
  let puddle = Math.max(0, Math.min(s.puddle, wet + 0.1, 1))
  let left = Math.min(Math.max(0, dtS), SURFACE_MAX_STEP_S)
  const dry = (0.15 + 0.35 * p.sun + 0.02 * p.windMs) / 300
  const drain = (0.1 + 0.25 * p.sun) / 600
  while (left > 0) {
    if (p.rain <= 0 && wet === 0 && puddle === 0) break
    const dt = Math.min(1, left)
    left -= dt
    if (p.rain > 0) wet += (1 - wet) * p.rain * dt / 40
    else wet -= dt * dry
    wet = clamp01(wet)
    if (p.rain > PUDDLE_RAIN_MIN) puddle += ((p.rain - PUDDLE_RAIN_MIN) / (1 - PUDDLE_RAIN_MIN)) * dt / PUDDLE_FILL_S
    else puddle -= dt * drain
    puddle = Math.max(0, Math.min(puddle, wet + 0.1, 1))
  }
  return { wet, puddle }
}

// ---- lightning (WEATHER §2.4, §7.3) ----

/** Strikes are at least this far apart, ms. */
export const LIGHTNING_MIN_GAP_MS = 4000
/** Scheduled strikes land this far away, metres (a GM may force 100..3000). */
export const LIGHTNING_DIST_M = [300, 3000] as const
export const LIGHTNING_GM_DIST_M = [100, 3000] as const
/** Speed of sound for the thunder delay (distM / 343 s). */
export const SPEED_OF_SOUND = 343

/**
 * Flash brightness of a strike at `nowMs` (0 = none, up to 3): three decaying pulses at 0, ~0.12 s and ~0.31 s
 * (`3.0`, `1.8`, `1.0` × e^(−dt / 0.05 s)), clamped to 3. The pulse timing varies by the strike's `at`, the same on
 * every client.
 */
export function flashAt(strike: { at: number }, nowMs: number): number {
  const dt = (nowMs - strike.at) / 1000
  if (!(dt >= 0) || dt > 1.5) return 0
  const r = mulberry32(Math.floor(strike.at) >>> 0)
  const t1 = 0.12 * (0.8 + 0.4 * r())
  const t2 = 0.31 * (0.8 + 0.4 * r())
  let f = 3 * Math.exp(-dt / 0.05)
  if (dt >= t1) f += 1.8 * Math.exp(-(dt - t1) / 0.05)
  if (dt >= t2) f += 1 * Math.exp(-(dt - t2) / 0.05)
  return Math.min(3, f)
}

// ---- fog distance (WEATHER §7.1): the one formula both render paths use ----

/** Visibility factor on the fog end: `mix(1, 0.35, fog) × mix(1, 0.75, rain)` (clear 1, storm ≈ 0.53, fog ≈ 0.45). */
export function fogScale(p: Pick<WeatherParams, 'fog' | 'rain'>): number {
  return (1 - 0.65 * clamp01(p.fog)) * (1 - 0.25 * clamp01(p.rain))
}

// ---- the wire (docs/WAVE_PLAN3.md §3.2) ----

/** Wire ranges of WeatherSync (validate.ts and the server use the same numbers). */
export const WEATHER_LIMITS = {
  durMs: 600_000,
  windMs: 30,
} as const

/** A `weather` resync is broadcast this often even when nothing changed. */
export const WEATHER_RESYNC_MS = 600_000
