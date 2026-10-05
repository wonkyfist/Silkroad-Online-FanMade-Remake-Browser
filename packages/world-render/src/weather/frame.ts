/**
 * The per-frame weather the renderer takes (docs/WEATHER.md §5.1, docs/WAVE_PLAN3.md D13): plain data, produced by the
 * game's weather feature (WX-C) or a viewer debug panel and handed to `World.setWeather(frame)`, the one public entry.
 * The renderer never sees WeatherSync, the protocol or zones. Written by W9A-S; changes only via I9A.
 */
import { WEATHER_PARAMS } from '../../../shared/src/weather.ts'

export interface WeatherFrame {
  /** Blended parameters (WEATHER §2.1) after the zone climate. */
  cloud: number
  cloudDark: number
  cirrus: number
  rain: number
  fog: number
  sun: number
  desat: number
  /** Unit wind direction in the glTF XZ plane, speed (m/s) and the gusting speed right now (m/s). */
  windX: number
  windZ: number
  windMs: number
  gustMs: number
  /** Surface wetness and puddle level 0..1 (after the zone wetFloor). */
  wet: number
  puddle: number
  /** Lightning flash brightness now (0 = none, ~3 at the peak) and the flash direction (unit, toward the bolt). */
  flash: number
  flashX: number
  flashZ: number
  /**
   * Additive (docs/WEATHER.md §7.3b): true while the brightest flash belongs to a placed strike whose bolt the game
   * draws itself at its world position; the camera-relative High bolt (rain.ts) then stays off. Absent = false.
   */
  boltOwned?: boolean
  /** Seconds, wrapping at 3600 (shader time). */
  time: number
}

const C = WEATHER_PARAMS.clear

/** Clear, dry, calm (the world's weather until a frame arrives, and with weather off). */
export const CLEAR_FRAME: Readonly<WeatherFrame> = Object.freeze({
  cloud: C.cloud, cloudDark: C.cloudDark, cirrus: C.cirrus, rain: C.rain, fog: C.fog, sun: C.sun, desat: C.desat,
  windX: 1, windZ: 0, windMs: C.windMs, gustMs: C.windMs,
  wet: 0, puddle: 0,
  flash: 0, flashX: 0, flashZ: 0,
  time: 0,
})
