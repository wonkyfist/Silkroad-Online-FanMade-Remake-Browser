/**
 * Weather on the environment (docs/WEATHER.md §7.1, docs/WAVE_PLAN3.md §2.2 "fog distance"): the Classic multipliers
 * on the retail palette (applied only with the classic sky style; the modern sky takes toSkyWeather) and the fog
 * distances, which apply on every path. Owned by WX-R.
 *
 * The multipliers are relative to the clear state: `clear` (cloud 0.1, no dark cloud, full sun, no flash) is the
 * retail palette exactly, so the cloud term uses `c = (cloud − 0.1) / 0.9` where WEATHER §7.1 writes `cloud`.
 */
import { WEATHER_PARAMS, fogScale } from '../../../shared/src/weather.ts'
import type { EnvValues, RGB } from '../environment.ts'
import type { WeatherFrame } from './frame.ts'

const CLEAR_CLOUD = WEATHER_PARAMS.clear.cloud
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const grey = (c: Readonly<RGB>) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

/** The weather terms of §7.1 for one frame: c (cloud above clear), d (dark cloud), sun, flash (0..3). */
export interface EnvWeatherTerms {
  c: number
  d: number
  sun: number
  flash: number
}

const terms: EnvWeatherTerms = { c: 0, d: 0, sun: 1, flash: 0 }

/**
 * The terms of a frame; null when the frame changes nothing (clear, dry, no flash). A reused object (this runs several
 * times a frame): valid until the next call.
 */
export function envWeatherTerms(f: Readonly<Pick<WeatherFrame, 'cloud' | 'cloudDark' | 'sun' | 'flash'>>): Readonly<EnvWeatherTerms> | null {
  const c = clamp01((f.cloud - CLEAR_CLOUD) / (1 - CLEAR_CLOUD))
  const d = clamp01(f.cloudDark)
  const sun = clamp01(f.sun)
  const flash = Math.max(0, Math.min(3, f.flash || 0))
  if (!(c > 0) && !(d > 0) && !(sun < 1) && !(flash > 0)) return null
  terms.c = c
  terms.d = d
  terms.sun = sun
  terms.flash = flash
  return terms
}

/** Reused output (applyEnv runs several times a frame): valid until the next call. */
const out: EnvValues = {
  sun: [0, 0, 0], skyTop: [0, 0, 0], skyBottom: [0, 0, 0], diffuse: [0, 0, 0], objectAmbient: [0, 0, 0], scatter: [0, 0, 0],
  terrainShadow: [0, 0, 0], fogColor: [0, 0, 0], water: [0, 0, 0], g7: 0, g8: 0, g10: 0, g11: 0,
}

function copy(dst: RGB, src: Readonly<RGB>): void {
  dst[0] = src[0]
  dst[1] = src[1]
  dst[2] = src[2]
}

/** dst = mix(src, g, k) × m (+ add), per channel. */
function mixTo(dst: RGB, src: Readonly<RGB>, g: number, k: number, m: number, add: Readonly<RGB> | null = null, addK = 0): void {
  for (let i = 0; i < 3; i++) {
    const v = src[i]! + (g - src[i]!) * k
    dst[i] = v * m + (add ? add[i]! * addK : 0)
  }
}

const FLASH_SKY: RGB = [0.55, 0.6, 0.8]
const FLASH_AMBIENT: RGB = [0.35, 0.35, 0.35]

/**
 * The Classic weather multipliers on the retail EnvValues (WEATHER §7.1): fog colour greys and darkens with dark cloud,
 * the sky greys with cloud and darkens with dark cloud (lightning lifts it), the object sun scales by `sun`, the object
 * ambient greys and darkens (lightning lifts it), the water darkens and greys. Returns `env` itself for a frame that
 * changes nothing (the Low guard), else a reused object valid until the next call. Fog distances: weatherFogScale.
 */
export function applyWeatherToEnv(env: EnvValues, frame: Readonly<WeatherFrame>): EnvValues {
  const t = envWeatherTerms(frame)
  if (!t) return env
  const { c, d, sun, flash } = t
  copy(out.sun, env.sun)
  copy(out.scatter, env.scatter)
  copy(out.terrainShadow, env.terrainShadow)
  out.g7 = env.g7
  out.g8 = env.g8
  out.g10 = env.g10
  out.g11 = env.g11
  mixTo(out.fogColor, env.fogColor, grey(env.fogColor) * 0.85, 0.8 * d, 1 - 0.3 * d)
  const skyGrey = grey(env.skyBottom) * 0.9
  mixTo(out.skyTop, env.skyTop, skyGrey, 0.9 * c, 1 - 0.45 * d, FLASH_SKY, flash)
  mixTo(out.skyBottom, env.skyBottom, skyGrey, 0.9 * c, 1 - 0.45 * d, FLASH_SKY, flash)
  mixTo(out.diffuse, env.diffuse, 0, 0, sun)
  mixTo(out.objectAmbient, env.objectAmbient, grey(env.objectAmbient), 0.5 * c, 1 - 0.2 * d, FLASH_AMBIENT, flash)
  mixTo(out.water, env.water, grey(env.water), 0.2 * c, 1 - 0.28 * d)
  return out
}

/**
 * The Classic terrain light under the weather (WEATHER §7.1 "terrain light"): overall brightness `mix(1, 0.72, d)` and
 * the lightmap contrast `lm' = mix(0.85, lm, sun)` (baked shadows fade under overcast). Identity for a clear frame.
 */
export function terrainWeatherLight(
  f: Readonly<Pick<WeatherFrame, 'cloud' | 'cloudDark' | 'sun' | 'flash'>>,
  out: { brightness: number; contrast: number } = { brightness: 1, contrast: 1 },
): { brightness: number; contrast: number } {
  const t = envWeatherTerms(f)
  out.brightness = t ? 1 - 0.28 * t.d : 1
  out.contrast = t ? t.sun : 1
  return out
}

/**
 * Fog start and end multipliers (every path): end × fogScale (`mix(1, 0.35, fog) × mix(1, 0.75, rain)`), start ×
 * `mix(1, 0.05, fog) × mix(1, 0.5, rain)`. Both are exactly 1 for a clear frame.
 */
export function weatherFogScale(f: Pick<WeatherFrame, 'fog' | 'rain'>): { start: number; end: number } {
  const fog = Math.min(1, Math.max(0, f.fog))
  const rain = Math.min(1, Math.max(0, f.rain))
  return { start: (1 - 0.95 * fog) * (1 - 0.5 * rain), end: fogScale(f) }
}
