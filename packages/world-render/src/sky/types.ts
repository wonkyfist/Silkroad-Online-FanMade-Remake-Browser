/**
 * The sky's seams (docs/SKY.md §5.5, §6.1, §9.1; docs/WAVE_PLAN3.md §2.2, §5.1): `SkyState`, the one description of
 * the sky every lighting consumer reads (RND-L, RND-P, RND-T, RND-M, NL, WX-R, GAME), the sky's weather input and its
 * quality knobs per preset. Written by W9A-S; owned by SKY-B.
 */
import { Vector3, type BaseTexture, type Vector4 } from '@babylonjs/core'
import type { EnvValues, RGB } from '../environment.ts'

export type SkyStyle = 'modern' | 'classic'

/**
 * The retail bake direction of the terrain and object lightmaps, pointing TO the light (glTF), measured by RND-L (D16):
 * azimuth −14° (14° north of east), elevation 38°. The fields export's hills were ray-marched against candidate
 * directions and the predicted shadows correlated with lightmap darkness away from objects (r 0.690, against 0.557 for
 * the old (1, 1, 0) guess; the west and east halves agree). Scripts: work/tmp/w9a-rnd-l/bake-terrain.ts.
 */
export const BAKED_LIGHT_DIR: Readonly<Vector3> = new Vector3(0.7646, 0.6157, -0.1906).normalize()

export interface SkyState {
  /** Solar time 0..1 (0 = midnight), day index, raw clock phase. */
  t: number
  day: number
  phase: number
  /** glTF, pointing TO the body. */
  sunDir: Vector3
  moonDir: Vector3
  sunElevationDeg: number
  moon: { age: number; illum: number; texture: number }
  /**
   * The one shadow-casting light: sun, or moon when the sun is below −4° (crossfade −4..−1°). Light travels along −dir.
   * Modern sky: `color` is the white-balanced transmittance (white at a clear noon), `intensity` the LDR calibration of
   * SKY §6.2 (0.43 at a clear noon = the retail Diffuse(0.5) × 0.6; the moon 0.43 × 0.12 × its illuminated fraction,
   * never below 0.43 × 0.03 of starlight), dimmed by a cloud over the sun and by rain.
   */
  keyLight: { dir: Vector3; color: RGB; intensity: number }
  /**
   * Hemisphere ambient: sky (up), horizon (average ring), ground bounce (sky × albedo 0.25). Modern sky: the sky's
   * irradiance × ambientBoost 2.5 in keyLight units (ambient : key is the sky's own ratio, ~13 % at a clear noon).
   */
  ambient: { sky: RGB; horizon: RGB; ground: RGB }
  /**
   * L1 SH of the sky's radiance (sky/ibl.ts skySH), 4 × RGB: [L00, L1−1 (y), L10 (z), L11 (x)] in glTF world axes and
   * keyLight units (radiance coefficients; shIrradiance applies the cosine lobe). null on the classic sky.
   */
  sh: Float32Array | null
  /** LDR fog colour (the horizon at the camera's forward azimuth; retail FogColor on the classic sky). */
  fogColor: RGB
  /** 64 × 1 RGBA16F fog colour by azimuth (High+); null before SKY-B. */
  horizonRing: BaseTexture | null
  /**
   * Exposure for the sky's radiance units (SKY §6.5: noon ≈ 8, clamped [2, 160], eased 1/1.5 s). The dome applies it
   * itself on outputMode 0; on the PBR presets the post stack applies it (× its trim). keyLight units are
   * SKY_LDR_PER_LUT × the sky's (sky-system.ts).
   */
  exposure: number
  /** 0 day .. 1 night: smoothstep(+2°, −6°, sunElevationDeg). */
  night: number
  /** 1 when the sun is within −6..+6°. */
  twilight: number
  cloudCover: number
  /**
   * Cloud shadow on the ground (SKY §5.5; modern sky, cloud shadows on): x, y = the cloud-noise uv offset (wind),
   * z = 1 / the cloud scale (per metre), w = strength (0 at night and under a uniform overcast). Bound as the
   * `skyCloudShadow` uniform next to `skyCloudProj` and the `cloudNoise` texture (sky/chunks.ts `sroCloudShadow`).
   */
  cloudShadow: Vector4 | null
  /** x, z = the key light's xz / y (projection onto the cloud shell), z = shell height (m), w = cover. */
  cloudShadowProj: Vector4 | null
  cloudNoise: BaseTexture | null
  /**
   * The Classic ground (terrain and grass, modern sky, SRO_SKY_LIGHT): the lightmap's ambient part (up to 0.61) is
   * scaled by `ambient`, its baked-sun part by `sun` (1 at a clear noon, so noon renders as the retail ground).
   */
  ground: { ambient: RGB; sun: RGB }
  /** The retail palette the state was derived from (SKY §6.4). */
  env: EnvValues
}

/** The sky's weather input (weather/adapters.ts toSkyWeather). */
export interface SkyWeather {
  /** 0..1 cumulus coverage (clear ~0.15, fair 0.35, overcast 0.95). */
  cloudCover: number
  /** 0..1 rain-cloud grey bases, thicker layer. */
  cloudDarkness: number
  cirrus: number
  /** 0..1 → mieScale 1..8 (LUT rebuild). */
  haze: number
  /** m/s at cloud height. */
  wind: { x: number; z: number }
  /** 0..1 hides sun/moon/stars progressively, desaturates the sky. */
  precipitation: number
  /** 0..1 lightning this frame. */
  flash: number
}

export const CLEAR_SKY_WEATHER: Readonly<SkyWeather> = Object.freeze({
  cloudCover: 0.1, cloudDarkness: 0, cirrus: 0.3, haze: 0, wind: Object.freeze({ x: 2, z: 0 }), precipitation: 0, flash: 0,
})

/** Sky knobs per preset (SKY §9.1 as merged in docs/WAVE_PLAN3.md §5.1). */
export interface SkyQuality {
  /** Sky-view LUT size, march steps, refresh (s), built in a worker (Ultra). */
  lut: { width: number; height: number; steps: number; refreshS: number; worker: boolean }
  /** 'retail' = the retail cloud1 plane; 'cumulus' = the lit 2.5D clouds with `taps` + `lightTaps`. */
  clouds: { kind: 'retail' | 'cumulus'; taps: number; lightTaps: number; cirrus: boolean; detailOctave: boolean }
  /** Cloud shadows: none, on terrain and grass, or on objects too. */
  cloudShadows: 'off' | 'ground' | 'all'
  stars: { perFace: number; twinkle: boolean; milkyWay: boolean }
  /** Lens-flare sprites (0 = off). */
  flares: number
  /** 'baked': the key light stays at BAKED_LIGHT_DIR (Low); 'dynamic': it follows the sun (elevation ≥ 6°). */
  sunPath: 'baked' | 'dynamic'
  /** Fog colour by azimuth from the horizon ring (High+). */
  horizonRing: boolean
}

export type SkyPreset = 'low' | 'medium' | 'high' | 'ultra'

/**
 * Sky-view LUT rows built per frame (SKY §3.5: Low 2, Medium 4, High 6, Ultra 12), from the preset's march steps.
 * Ultra's worker is not built (SKY §3.2: v1 does not need it); it slices on the main thread like the others.
 */
export function lutRowsPerFrame(q: Readonly<SkyQuality>): number {
  const s = q.lut.steps
  return s <= 12 ? 2 : s <= 16 ? 4 : s <= 24 ? 6 : 12
}

export const SKY_PRESETS: Readonly<Record<SkyPreset, Readonly<SkyQuality>>> = {
  low: {
    lut: { width: 48, height: 24, steps: 12, refreshS: 4, worker: false },
    clouds: { kind: 'retail', taps: 1, lightTaps: 0, cirrus: false, detailOctave: false },
    cloudShadows: 'off',
    stars: { perFace: 128, twinkle: false, milkyWay: false },
    flares: 0,
    sunPath: 'baked',
    horizonRing: false,
  },
  medium: {
    lut: { width: 96, height: 48, steps: 16, refreshS: 2, worker: false },
    clouds: { kind: 'cumulus', taps: 3, lightTaps: 1, cirrus: false, detailOctave: false },
    cloudShadows: 'off',
    stars: { perFace: 256, twinkle: false, milkyWay: false },
    flares: 0,
    sunPath: 'dynamic',
    horizonRing: false,
  },
  high: {
    lut: { width: 96, height: 48, steps: 24, refreshS: 1, worker: false },
    clouds: { kind: 'cumulus', taps: 3, lightTaps: 2, cirrus: true, detailOctave: false },
    cloudShadows: 'ground',
    stars: { perFace: 256, twinkle: true, milkyWay: false },
    flares: 4,
    sunPath: 'dynamic',
    horizonRing: true,
  },
  ultra: {
    lut: { width: 128, height: 64, steps: 32, refreshS: 0.5, worker: true },
    clouds: { kind: 'cumulus', taps: 4, lightTaps: 3, cirrus: true, detailOctave: true },
    cloudShadows: 'all',
    stars: { perFace: 256, twinkle: true, milkyWay: true },
    flares: 8,
    sunPath: 'dynamic',
    horizonRing: true,
  },
}
