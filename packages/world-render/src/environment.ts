// environment.json (environment.ifo profiles, 16 graphs) sampling, per docs/TERRAIN.md 5.1-5.2 and 3.2.
// Time t in [0, 1): 0 = midnight, 0.5 = noon. Fog start/end are graph10/graph11 x R, R = 2500 units = 250 m.

export interface ColorKey { r: number; g: number; b: number; time: number }
export interface FloatKey { value: number; time: number }

export interface EnvProfile {
  id: number
  name: string
  sunColor: ColorKey[]
  skyTopColor: ColorKey[]
  diffuseColor: ColorKey[]
  objectAmbientColor: ColorKey[]
  graph4: ColorKey[]
  terrainAmbientColor: ColorKey[]
  terrainShadowColor: ColorKey[]
  fogNearPlane: FloatKey[]
  fogFarPlane: FloatKey[]
  fogColor: ColorKey[]
  graph10: FloatKey[]
  graph11: FloatKey[]
  graph12: FloatKey[]
  skyBottomColor: ColorKey[]
  waterColor: ColorKey[]
  graph15: FloatKey[]
}

export interface EnvironmentFile {
  source: string
  profiles: EnvProfile[]
}

export type RGB = [number, number, number]

/** Every value the renderer reads, at one time of day. */
export interface EnvValues {
  sun: RGB
  skyTop: RGB
  skyBottom: RGB
  diffuse: RGB
  objectAmbient: RGB
  scatter: RGB
  terrainShadow: RGB
  fogColor: RGB
  water: RGB
  /** Graph 7 (sky glow radius) and graph 8 (sky gradient falloff). */
  g7: number
  g8: number
  /** Fog start / end fractions of R. */
  g10: number
  g11: number
}

/** TERRAIN.md 5.2: R = min(2500, 0.8 * scenery range 3500) units = 250 m. */
export const FOG_RANGE_M = 250

function bracket<T extends { time: number }>(keys: readonly T[], t: number): [T, T, number] | null {
  if (!keys.length) return null
  const first = keys[0]!
  const last = keys[keys.length - 1]!
  if (t <= first.time) return [first, first, 0]
  if (t >= last.time) return [last, last, 0]
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]!
    const b = keys[i + 1]!
    if (t >= a.time && t < b.time) {
      const span = b.time - a.time
      return span < 1e-4 ? [a, a, 0] : [a, b, (t - a.time) / span]
    }
  }
  return [last, last, 0]
}

export function sampleColor(keys: readonly ColorKey[] | undefined, t: number, fallback: RGB = [1, 1, 1]): RGB {
  const br = keys && bracket(keys, t)
  if (!br) return [...fallback]
  const [a, b, f] = br
  return [a.r + (b.r - a.r) * f, a.g + (b.g - a.g) * f, a.b + (b.b - a.b) * f]
}

export function sampleFloat(keys: readonly FloatKey[] | undefined, t: number, fallback = 0): number {
  const br = keys && bracket(keys, t)
  if (!br) return fallback
  const [a, b, f] = br
  return a.value + (b.value - a.value) * f
}

export function evaluateProfile(p: EnvProfile, t: number): EnvValues {
  return {
    sun: sampleColor(p.sunColor, t),
    skyTop: sampleColor(p.skyTopColor, t, [0.2, 0.5, 0.9]),
    skyBottom: sampleColor(p.skyBottomColor, t, [0.7, 0.85, 1]),
    diffuse: sampleColor(p.diffuseColor, t, [0.78, 0.78, 0.78]),
    objectAmbient: sampleColor(p.objectAmbientColor, t, [0.6, 0.6, 0.6]),
    scatter: sampleColor(p.graph4, t),
    terrainShadow: sampleColor(p.terrainShadowColor, t, [0, 0, 0]),
    fogColor: sampleColor(p.fogColor, t, [0.6, 0.7, 0.8]),
    water: sampleColor(p.waterColor, t, [0.36, 0.69, 0.62]),
    g7: sampleFloat(p.fogNearPlane, t, -0.76),
    g8: sampleFloat(p.fogFarPlane, t, -1),
    g10: sampleFloat(p.graph10, t, 0.76),
    g11: sampleFloat(p.graph11, t, 1),
  }
}

/** Moves every value `k` of the way toward `target` (TERRAIN.md 5.1 transitions: k = min(1, dt * 0.5)). */
export function approachEnv(cur: EnvValues, target: EnvValues, k: number): EnvValues {
  const out = { ...cur }
  for (const key of Object.keys(target) as (keyof EnvValues)[]) {
    const a = cur[key]
    const b = target[key]
    if (Array.isArray(a) && Array.isArray(b)) {
      ;(out[key] as RGB) = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
    } else {
      ;(out[key] as number) = (a as number) + ((b as number) - (a as number)) * k
    }
  }
  return out
}

export const saturate = (c: RGB): RGB => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])]
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function formatTime(t: number): string {
  const minutes = Math.round((((t % 1) + 1) % 1) * 24 * 60)
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
