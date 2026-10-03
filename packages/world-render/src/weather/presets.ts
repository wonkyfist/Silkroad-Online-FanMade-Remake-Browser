/**
 * Weather levels (docs/WEATHER.md §9.1 table, docs/WAVE_PLAN3.md §5.1): what the Classic-path weather draws per level.
 * `auto` is resolved by the game (graphics preset → level, iGPU → low) before World.setWeatherLevel. On the PBR path the
 * plugins draw wetness, puddles and ripples themselves; the level still sizes rain, splashes, drips, shelter and bolt.
 * Written by W9A-S from the plan; owned by WX-R (numbers change only via I9A).
 */

export const WEATHER_LEVELS = ['off', 'low', 'medium', 'high', 'ultra'] as const
export type WeatherLevel = (typeof WEATHER_LEVELS)[number]

export interface WeatherPreset {
  /** Wet darkening + sheen on terrain, objects, characters, grass. */
  wet: boolean
  /** Sky reflection on wet surfaces (low: glint only). */
  reflection: boolean
  /** Puddles (wet map, dark bottom, sky reflection). */
  puddles: boolean
  /** Ripple texture size (0 = none) and samples per pixel in puddles and water. */
  rippleSize: 0 | 128 | 256
  rippleSamples: 0 | 1 | 2
  /** Rain streaks and the box they fill (m, x y z). */
  streaks: number
  box: readonly [number, number, number]
  curtainLayers: number
  splashes: number
  drips: number
  /** Shelter map (512², 128 m; D20). Off: rain passes roofs, as in retail. */
  shelter: boolean
  /** Wind on grass and on skinned trees. */
  windGrass: boolean
  windSkinned: boolean
  /** Wind sway on static trees (vertex plugin). */
  staticSway: boolean
  /** Lightning bolt mesh. */
  bolt: boolean
  /** Lens drops (needs the post stack). */
  lensDrops: boolean
}

export const WEATHER_PRESETS: Readonly<Record<WeatherLevel, Readonly<WeatherPreset>>> = {
  off: {
    wet: false, reflection: false, puddles: false, rippleSize: 0, rippleSamples: 0,
    streaks: 0, box: [0, 0, 0], curtainLayers: 0, splashes: 0, drips: 0,
    shelter: false, windGrass: true, windSkinned: true, staticSway: false, bolt: false, lensDrops: false,
  },
  low: {
    wet: true, reflection: false, puddles: false, rippleSize: 0, rippleSamples: 0,
    streaks: 3000, box: [30, 20, 30], curtainLayers: 1, splashes: 0, drips: 0,
    shelter: false, windGrass: true, windSkinned: true, staticSway: false, bolt: false, lensDrops: false,
  },
  medium: {
    wet: true, reflection: true, puddles: true, rippleSize: 128, rippleSamples: 1,
    streaks: 10000, box: [36, 22, 36], curtainLayers: 2, splashes: 256, drips: 64,
    shelter: true, windGrass: true, windSkinned: true, staticSway: false, bolt: false, lensDrops: false,
  },
  high: {
    wet: true, reflection: true, puddles: true, rippleSize: 256, rippleSamples: 2,
    streaks: 20000, box: [40, 24, 40], curtainLayers: 2, splashes: 512, drips: 128,
    shelter: true, windGrass: true, windSkinned: true, staticSway: true, bolt: true, lensDrops: false,
  },
  ultra: {
    wet: true, reflection: true, puddles: true, rippleSize: 256, rippleSamples: 2,
    streaks: 40000, box: [44, 26, 44], curtainLayers: 2, splashes: 1024, drips: 256,
    shelter: true, windGrass: true, windSkinned: true, staticSway: true, bolt: true, lensDrops: true,
  },
}
