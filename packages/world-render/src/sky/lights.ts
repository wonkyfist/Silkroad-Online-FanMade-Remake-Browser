/**
 * `applySkyToLights` (docs/SKY.md §6.3, §8 L2; docs/WAVE_PLAN3.md §6.15): the per-frame adapter GAME runs on Low to
 * drive the characters' own HemisphericLight and DirectionalLight (screens/world.ts) from SkyState. At a clear noon
 * it gives the lights' base values back (today's hemi 0.7 and sun 1.2), so characters look as before; toward dusk
 * and night both follow the sky's key light and ambient, never below the readability floor (SKY §7.3: at least 12 %
 * of noon). On the PBR presets GAME disables these lights instead (the celestial light and IBL light characters).
 */
import { Color3, type DirectionalLight, type HemisphericLight } from '@babylonjs/core'
import type { RGB } from '../environment.ts'
import type { SkyState } from './types.ts'

/** SkyState.keyLight luminance at a clear noon (SKY §6.2: the retail Diffuse(0.5) × 0.6). */
export const NOON_KEY_LUMINANCE = 0.43
/**
 * SkyState.ambient.sky luminance at a clear Jangan noon (cover 0.1) on the modern sky (irradiance × 2.5, keyLight units;
 * test/sky-state.test.ts checks it against the atmosphere). The classic sky's ambient is the retail ObjectAmbient, so
 * on it the ratio uses the retail noon (0.67).
 */
export const NOON_AMBIENT_LUMINANCE = 0.073
const RETAIL_NOON_AMBIENT = 0.67

export interface SkyLightTargets {
  hemi?: HemisphericLight | null
  sun?: DirectionalLight | null
}

export interface SkyLightOptions {
  /** The lights' noon values (default: today's game lights, hemi 0.7 and sun 1.2). */
  hemiIntensity?: number
  sunIntensity?: number
  /** The hemisphere's noon ground colour (default the game's (0.3, 0.28, 0.24)). */
  groundColor?: RGB
  /** Turn the sun with the key light (default true); false keeps the caller's direction. */
  followDirection?: boolean
  /** Lowest share of the noon light the pair keeps (default 0.14, over SKY §7.3's 12 %). */
  floor?: number
}

const lum = (c: Readonly<RGB>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/** Normalised chroma (max channel 1) of a colour, grey when it is black. */
function chroma(c: Readonly<RGB>, out: Color3): Color3 {
  const m = Math.max(c[0], c[1], c[2])
  if (!(m > 1e-6)) return out.set(1, 1, 1)
  return out.set(c[0] / m, c[1] / m, c[2] / m)
}

/**
 * Drives `hemi` and `sun` from the sky state. Allocation-free after the first call; safe to run every frame.
 * Returns the share of the noon light the pair now gives (1 at a clear noon).
 */
export function applySkyToLights(state: Readonly<SkyState>, lights: SkyLightTargets, opts: SkyLightOptions = {}): number {
  const hemiBase = opts.hemiIntensity ?? 0.7
  const sunBase = opts.sunIntensity ?? 1.2
  const floor = opts.floor ?? 0.14
  const key = state.keyLight
  const keyK = (lum(key.color) * key.intensity) / NOON_KEY_LUMINANCE
  const modern = state.sh !== null
  const ambK = lum(state.ambient.sky) / (modern ? NOON_AMBIENT_LUMINANCE : RETAIL_NOON_AMBIENT)
  let hemiK = Math.max(0, ambK)
  let sunK = Math.max(0, keyK)
  // The readability floor: scale the hemisphere up until the pair gives `floor` of its noon light.
  const total = (hemiBase * hemiK + sunBase * sunK) / (hemiBase + sunBase)
  if (total < floor) hemiK += ((floor - total) * (hemiBase + sunBase)) / hemiBase
  hemiK = Math.min(hemiK, 1.5)
  sunK = Math.min(sunK, 1.5)
  const sun = lights.sun
  if (sun) {
    if (opts.followDirection ?? true) sun.direction.set(-key.dir.x, -key.dir.y, -key.dir.z)
    chroma(key.color, sun.diffuse)
    sun.intensity = sunBase * sunK
  }
  const hemi = lights.hemi
  if (hemi) {
    // Half the sky's hue (the noon hemi was white), the ground bounce's hue on the ground colour.
    chroma(state.ambient.sky, hemi.diffuse)
    hemi.diffuse.set(0.5 + 0.5 * hemi.diffuse.r, 0.5 + 0.5 * hemi.diffuse.g, 0.5 + 0.5 * hemi.diffuse.b)
    const g = opts.groundColor ?? [0.3, 0.28, 0.24]
    const gc = chroma(state.ambient.ground, hemi.groundColor)
    hemi.groundColor.set(g[0] * (0.5 + 0.5 * gc.r), g[1] * (0.5 + 0.5 * gc.g), g[2] * (0.5 + 0.5 * gc.b))
    hemi.intensity = hemiBase * hemiK
  }
  return (hemiBase * hemiK + sunBase * sunK) / (hemiBase + sunBase)
}
