/**
 * Daytime atmosphere (docs/LIGHTING.md §3, lighting pass 2): how much denser and nearer the height fog is than the
 * retail fog range at each time of day, so the air reads all day: aerial haze on the mid-distance hills by day, a
 * morning mist that pools in hollows and fields (a short height falloff), a golden haze in the evening, a light night
 * haze. The sun shafts take part of the fog's density as their in-scatter (volumetrics/shafts.ts fogShare), so the
 * beams strengthen with it. Pure: RenderPost applies it to the HeightFog every frame (PBR presets only; the Low guard
 * never builds it). Weather fog (mist, rain) still comes from the scene fog range on top.
 */

export interface AtmosphereLook {
  /** × the retail fog density. */
  density: number
  /** × the retail fog start distance (smaller: haze nearer). */
  start: number
  /** The height falloff (m): short in the morning mist, so it pools low. */
  falloffM: number
}

export interface AtmosphereTuning {
  day: AtmosphereLook
  morning: AtmosphereLook
  evening: AtmosphereLook
  night: AtmosphereLook
}

export const ATMOSPHERE: Readonly<AtmosphereTuning> = {
  day: { density: 1.25, start: 0.6, falloffM: 80 },
  morning: { density: 1.5, start: 0.45, falloffM: 35 },
  evening: { density: 1.7, start: 0.4, falloffM: 60 },
  night: { density: 1.15, start: 0.8, falloffM: 80 },
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** The weights of the four looks (sum 1): night below −6°, morning / evening mist with a low sun, day above ~25°. */
export function atmosphereWeights(sunElevationDeg: number, t: number): [number, number, number, number] {
  const night = smoothstep(0, -8, sunElevationDeg)
  const low = (1 - night) * (1 - smoothstep(8, 25, sunElevationDeg))
  const morning = (t - Math.floor(t)) < 0.5
  return [Math.max(0, 1 - night - low), morning ? low : 0, morning ? 0 : low, night]
}

/** The blended look for a sun elevation, a solar time (0 = midnight) and a strength (0 = the retail fog, 1 = full). */
export function atmosphereLook(sunElevationDeg: number, t: number, strength = 1, a: Readonly<AtmosphereTuning> = ATMOSPHERE): AtmosphereLook {
  const [wd, wm, we, wn] = atmosphereWeights(sunElevationDeg, t)
  const mix = (k: keyof AtmosphereLook) => wd * a.day[k] + wm * a.morning[k] + we * a.evening[k] + wn * a.night[k]
  const s = clamp01(strength)
  return {
    density: 1 + (mix('density') - 1) * s,
    start: 1 + (mix('start') - 1) * s,
    falloffM: 80 + (mix('falloffM') - 80) * s,
  }
}
