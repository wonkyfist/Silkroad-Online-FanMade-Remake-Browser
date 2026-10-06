/**
 * WeatherFrame → the sky's and the renderer's own weather inputs (docs/WEATHER.md §5.3, docs/WAVE_PLAN3.md D13, D25).
 * Pure; `World.setWeather(frame)` calls both. Written by W9A-S (tested in test/weather-adapters.test.ts); changes only
 * via I9A.
 */
import { fogScale } from '../../../shared/src/weather.ts'
import type { RenderWeather } from '../render/weather.ts'
import type { SkyWeather } from '../sky/types.ts'
import type { WeatherFrame } from './frame.ts'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** SKY.md §5.5 inputs (the sky skips its own smoothing for these: the frame is already blended). */
export function toSkyWeather(f: WeatherFrame): SkyWeather {
  return {
    cloudCover: f.cloud,
    cloudDarkness: f.cloudDark,
    cirrus: f.cirrus,
    haze: Math.min(1, f.fog + 0.3 * f.rain + 0.2 * (f.snow ?? 0)),
    wind: { x: f.windX * f.windMs, z: f.windZ * f.windMs },
    precipitation: Math.min(1, f.rain + 0.7 * (f.snow ?? 0)),
    flash: Math.min(1, f.flash / 3),
  }
}

/** RENDER.md §9.1 inputs, plus the flash 0..1 (D25). */
export function toRenderWeather(f: WeatherFrame): RenderWeather {
  return {
    rain: f.rain,
    wetness: f.wet,
    puddles: f.puddle,
    cloud: f.cloud,
    // WEATHER §7.1 fog-end factor, so both paths agree on visibility.
    fogMul: 1 / fogScale(f),
    // 0.2 calm .. 1.6 storm (RENDER.md §8.1 scale).
    wind: Math.min(2, f.gustMs / 8),
    flash: clamp01(f.flash / 3),
    // docs/WINTER.md §7.6: the winter grade follows the frost and the snow on the ground
    ...(f.frost || f.cover ? { winter: clamp01(Math.max(0.6 * (f.frost ?? 0), f.cover ?? 0)) } : {}),
  }
}
