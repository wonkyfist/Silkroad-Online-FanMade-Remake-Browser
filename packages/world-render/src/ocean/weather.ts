/**
 * The sea state from the weather (docs/COAST.md §8.7, §8.9; S-CLOCK in §8.13). Tidewater sets its sea by hand; ours
 * follows `WeatherFrame`:
 *
 * - the **wind sea** is JONSWAP at the low-passed wind (τ ≈ 30 s, speed and direction as one vector) over the map's
 *   fetch (60 km, capped at full development, 2.2·10⁴ U² / g), travelling downwind;
 * - the **swell** comes from the open sea (`swellFromDeg`, fixed per map) with Tidewater's shape (6 → 14 m/s over
 *   1,200 km) and a height that grows with the storminess `s` (0.45 → 2 m); `s = saturate((windMs − 2) / 11)` raised by
 *   the cloud darkness (`max(s, 0.8 · cloudDark)`) and low-passed over τ ≈ 120 s, so a storm builds over minutes;
 * - the spectrum is rebuilt (new h0, the same hashed Gaussians) when the filtered wind moves by > 0.25 m/s or > 3°, or
 *   the storminess by > 0.02, at most once a second;
 * - per frame, uniforms only: the gusts roughen the glint (Cox–Munk), the storm and the gusts raise the whitecap
 *   threshold (the Jacobian bias 0.80 → 0.87, + 0.03 in gusts: fft-core.ts FOAM_BIAS), the storm raises the choppiness
 *   (0.9 → 1.1), the rain damps each consumer's finest cascade (× 0.7);
 * - Hs is clamped at 2.5 m for gameplay (spectrum.ts `buildH0`).
 *
 * The clouds drift with the unfiltered frame wind; the sea follows the same `windX/Z` through its own filter, so after
 * a wind shift the cloud shadows turn first and the sea follows within about a minute (F12, accepted).
 */
import type { WeatherFrame } from '../weather/frame.ts'
import { CHOPPINESS, FOAM_BIAS, type TileParams } from './fft-core.ts'
import { GRAVITY, HS_MAX_M, jonswap, jonswapPeak, peakPeriod, tma, type SpectrumParams } from './spectrum.ts'

/** The map's sea constants (content/coast/coast.json `ocean` when CST-C writes one; these defaults otherwise). */
export interface SeaConfig {
  /** The wind sea's fetch (m). */
  fetchM: number
  /** Where the swell comes from (compass degrees: 0 north, 90 east). The open sea lies south and east of Jangan. */
  swellFromDeg: number
  /** The TMA depth of the open-sea tile (m). */
  depthM: number
  /** The hashed Gaussians' seed (COAST §0.1: 1188). */
  seed: number
}

export const DEFAULT_SEA: Readonly<SeaConfig> = { fetchM: 60_000, swellFromDeg: 150, depthM: 100, seed: 1188 }

/** The swell's height (m) calm and at a full storm (before the Hs clamp). */
export const SWELL_HS_M: readonly [number, number] = [0.45, 2]
/** The low-pass time constants (s). */
export const WIND_TAU_S = 30
export const STORM_TAU_S = 120

/** The filtered weather the spectrum is built from. */
export interface SeaState {
  windMs: number
  /** Where the wind blows toward: atan2(z, x) in glTF xz. */
  windDirRad: number
  /** 0 calm … 1 storm. */
  storm: number
  swellFromDeg: number
}

/** The direction (radians, atan2(z, x), glTF: north = −z) a swell from compass bearing `deg` travels toward. */
export function swellTravelRad(fromDeg: number): number {
  const b = (fromDeg * Math.PI) / 180
  // From-vector (sin b, −cos b); the waves travel the other way.
  return Math.atan2(Math.cos(b), -Math.sin(b))
}

/** Storminess from a frame (before the low-pass). */
export function storminess(windMs: number, cloudDark: number): number {
  const s = Math.min(1, Math.max(0, (windMs - 2) / 11))
  return Math.max(s, 0.8 * Math.min(1, Math.max(0, cloudDark)))
}

/** ∫ S(ω) Φ(ω) dω of one JONSWAP system at scale 1 (m²): the spread integrates to 1. */
export function systemVariance(windMs: number, fetchM: number, depthM: number, gamma = 3.3): number {
  const { alpha, omegaP } = jonswapPeak(windMs, fetchM)
  const a = omegaP * 0.35, b = omegaP * 12
  const n = 2000
  const h = (b - a) / n
  let s = 0
  for (let i = 0; i <= n; i++) {
    const w = a + i * h
    const f = jonswap(w, alpha, omegaP, gamma) * tma(w, depthM)
    s += i === 0 || i === n ? f / 2 : f
  }
  return s * h
}

/**
 * The wind sea never builds from less than this (m/s): a gentle breeze's chop on a clear day, so the sea reads at the
 * gameplay distances (5–60 m) instead of the 2 m/s weather wind's glassy surface (CST-S, the X1 look notes item 4).
 * The storminess, the roughness and the whitecaps still follow the weather's own wind. P-LOOK (wave 10 polish): 4 → 5
 * m/s (Beaufort 3, large wavelets): Hs ≈ 0.9 m with the calm swell, a 26 m peak that reads from the beach to 150 m.
 */
export const CALM_SEA_WIND_MS = 5

const swellUnit = new Map<string, number>()

/** The spectrum parameters of a sea state (both systems; the Hs clamp at 2.5 m). */
export function seaParams(s: SeaState, seed: number = DEFAULT_SEA.seed, cfg: Partial<SeaConfig> = {}): SpectrumParams {
  const c = { ...DEFAULT_SEA, ...cfg }
  const u = Math.max(CALM_SEA_WIND_MS, s.windMs)
  const fetch = Math.min(c.fetchM, (2.2e4 * u * u) / GRAVITY)
  const swellWind = 6 + 8 * s.storm
  const key = `${swellWind.toFixed(3)}/${c.depthM}`
  let unit = swellUnit.get(key)
  if (unit === undefined) {
    unit = systemVariance(swellWind, 1_200_000, c.depthM)
    if (swellUnit.size > 256) swellUnit.clear()
    swellUnit.set(key, unit)
  }
  const target = SWELL_HS_M[0] + (SWELL_HS_M[1] - SWELL_HS_M[0]) * s.storm
  // Hs = 4 √(scale · m0): the scale that gives the target height.
  const scale = unit > 0 ? (target * target) / (16 * unit) : 0
  return {
    systems: [
      { windMs: u, fetchM: fetch, dirRad: s.windDirRad, scale: 1, swell: 0, gamma: 3.3 },
      { windMs: swellWind, fetchM: 1_200_000, dirRad: swellTravelRad(s.swellFromDeg), scale, swell: 1, gamma: 3.3 },
    ],
    depthM: c.depthM,
    shortWaveM: 0.02,
    hsMaxM: HS_MAX_M,
    seed,
  }
}

/** The per-frame knobs (uniforms and tile params). */
export interface SeaKnobs {
  /** Cox–Munk wind for the roughness (m/s: the gusting speed). */
  roughWindMs: number
  rain: number
  storm: number
  /** The tile's choppiness, whitecap bias and per-cascade gains (for `cascades` cascades; see SeaWeather.tileFor). */
  tile: TileParams
  /** The finest cascade's amplitude in rain (1 → 0.7). */
  rainGain: number
}

/**
 * The sea's weather filter: fed every frame, it says when the spectrum must be rebuilt (`params` then changes) and
 * gives the per-frame knobs. The first frame snaps (no ramp from zero at load).
 */
export class SeaWeather {
  /** Filtered wind vector (m/s) and storminess. */
  private wx = 0
  private wz = 0
  private stormValue = 0
  private started = false
  private built: SeaState | null = null
  private sinceBuild = Infinity
  private paramsValue: SpectrumParams
  private revisionValue = 0
  private rain = 0
  private gust = 0
  private readonly knobs: SeaKnobs
  private readonly gains: number[]

  constructor(readonly cfg: Readonly<SeaConfig> = DEFAULT_SEA, readonly cascades = 2) {
    this.paramsValue = seaParams({ windMs: 2, windDirRad: 0, storm: 0, swellFromDeg: cfg.swellFromDeg }, cfg.seed, cfg)
    this.gains = Array.from({ length: cascades }, () => 1)
    this.knobs = { roughWindMs: 2, rain: 0, storm: 0, tile: { choppiness: CHOPPINESS, foamBias: FOAM_BIAS, gains: this.gains }, rainGain: 1 }
  }

  /** The spectrum's parameters now (a new object after each rebuild). */
  get params(): SpectrumParams {
    return this.paramsValue
  }

  /** Bumped at every rebuild. */
  get revision(): number {
    return this.revisionValue
  }

  /** The filtered state the spectrum was last built from. */
  get state(): Readonly<SeaState> {
    return this.built ?? { windMs: 2, windDirRad: 0, storm: 0, swellFromDeg: this.cfg.swellFromDeg }
  }

  /** Hs of the current parameters, after the clamp, is the tile's; this is the swell period for the shore (s). */
  get periodS(): number {
    return peakPeriod(this.paramsValue)
  }

  /** The swell's travel direction (unit glTF xz). */
  get swellDir(): [number, number] {
    // Cached (RP-6: read every frame by the shore and both binds); the config's swell is fixed.
    if (!this.swellValue) {
      const a = swellTravelRad(this.cfg.swellFromDeg)
      this.swellValue = [Math.cos(a), Math.sin(a)]
    }
    return this.swellValue
  }

  private swellValue: [number, number] | null = null
  /** This frame's sea state (reused; copied when it becomes the built one). */
  private readonly current: SeaState = { windMs: 0, windDirRad: 0, storm: 0, swellFromDeg: 0 }

  /** Feeds one frame; returns true when the spectrum was rebuilt. */
  update(frame: Readonly<WeatherFrame>, dt: number): boolean {
    const speed = Math.max(0, frame.windMs)
    const tx = frame.windX * speed, tz = frame.windZ * speed
    const target = storminess(speed, frame.cloudDark)
    if (!this.started) {
      this.started = true
      this.wx = tx
      this.wz = tz
      this.stormValue = target
    } else {
      const a = 1 - Math.exp(-Math.max(0, dt) / WIND_TAU_S)
      const b = 1 - Math.exp(-Math.max(0, dt) / STORM_TAU_S)
      this.wx += (tx - this.wx) * a
      this.wz += (tz - this.wz) * a
      this.stormValue += (target - this.stormValue) * b
    }
    this.rain = Math.min(1, Math.max(0, frame.rain))
    this.gust = Math.max(0, frame.gustMs - frame.windMs)
    this.sinceBuild += Math.max(0, dt)
    const now = this.current
    now.windMs = Math.hypot(this.wx, this.wz)
    now.windDirRad = Math.atan2(this.wz, this.wx)
    now.storm = this.stormValue
    now.swellFromDeg = this.cfg.swellFromDeg
    const k = this.knobs
    k.roughWindMs = Math.max(0, frame.gustMs)
    k.rain = this.rain
    k.storm = this.stormValue
    k.tile.choppiness = CHOPPINESS + 0.2 * this.stormValue
    k.tile.foamBias = FOAM_BIAS + 0.07 * this.stormValue + 0.03 * Math.min(1, this.gust / 5)
    k.rainGain = 1 - 0.3 * this.rain
    for (let c = 0; c < this.gains.length; c++) this.gains[c] = c === this.gains.length - 1 ? k.rainGain : 1
    if (!this.needsBuild(now) || (this.built && this.sinceBuild < 1)) return false
    this.built = { ...now }
    this.sinceBuild = 0
    this.paramsValue = seaParams(this.built, this.cfg.seed, this.cfg)
    this.revisionValue++
    return true
  }

  /** This frame's knobs. */
  get frameKnobs(): Readonly<SeaKnobs> {
    return this.knobs
  }

  /** This frame's tile knobs for a consumer with `cascades` cascades (the rain damps its own finest one). */
  tileFor(cascades: number): TileParams {
    let t = this.tiles.get(cascades)
    if (!t) this.tiles.set(cascades, (t = { choppiness: CHOPPINESS, foamBias: FOAM_BIAS, gains: [] }))
    const k = this.knobs
    t.choppiness = k.tile.choppiness
    t.foamBias = k.tile.foamBias
    const g = t.gains as number[]
    g.length = cascades
    for (let c = 0; c < cascades; c++) g[c] = c === cascades - 1 ? k.rainGain : 1
    return t
  }

  private readonly tiles = new Map<number, TileParams>()

  private needsBuild(now: SeaState): boolean {
    const b = this.built
    if (!b) return true
    let dAng = Math.abs(now.windDirRad - b.windDirRad) % (2 * Math.PI)
    if (dAng > Math.PI) dAng = 2 * Math.PI - dAng
    // The direction only matters once the wind is strong enough to raise a sea.
    const dirMoved = dAng > (3 * Math.PI) / 180 && Math.max(now.windMs, b.windMs) > 1.5
    return Math.abs(now.windMs - b.windMs) > 0.25 || dirMoved || Math.abs(now.storm - b.storm) > 0.02
  }
}
