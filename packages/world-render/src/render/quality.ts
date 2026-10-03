/**
 * Render quality per preset (docs/WAVE_PLAN3.md §5.1, the render rows as data; docs/RENDER.md §10). The one preset
 * table of the renderer: World.setQuality hands `QualitySettings.render` (default RENDER_PRESETS[quality]) to
 * WorldRender.setQuality, and each lane reads its own block. Every feature of Low is off: Low is the Classic material
 * path, which the Low guard keeps identical to HEAD (test/seams-classic.test.ts). The Options "Advanced" rows (GAME)
 * override single keys. Written by W9A-S; owned by I9A afterwards.
 */

import type { TextureSetting } from '../pbr/maps.ts'

export type RenderPath = 'classic' | 'pbr'
export type ToneMap = 'none' | 'neutral' | 'filmic'
export type AntiAliasing = 'msaa' | 'fxaa' | 'taa'

export interface ShadowQuality {
  /** CSM cascades and map size (px). */
  cascades: number
  mapSize: number
  /** Shadow distance (m). */
  distanceM: number
  /** Trees and bushes cast within this distance (m; 0 = none). */
  foliageM: number
  /** The terrain casts (hills). */
  terrain: boolean
  /** Small props (LOD group 3) cast. */
  props: boolean
}

export interface IblQuality {
  /** Sky reflection cube face size (px). */
  cubeSize: number
  /** Minimum seconds between cube refreshes (D14). */
  refreshS: number
}

export interface NightLightQuality {
  /** Clustered point lights at most (0: none). */
  cluster: number
  /** Point lights in the pool when clusters are unsupported (0: none). */
  poolFallback: number
  /** The baked light splat on the terrain / on the grass (D29). */
  terrainSplat: boolean
  grassSplat: boolean
}

/**
 * The coast's ocean per preset (docs/COAST.md §8.10, the rows as data; WAVE_PLAN6 §4.1 step 3). Written by W10-S;
 * CST-O reads it (World.setQuality → OceanPart.setQuality). Low's Classic ocean is content every player gets.
 */
export interface OceanQuality {
  /**
   * How the waves are made: 3 Gerstner waves drawn from the spectrum (Low), the worker FFT tile (Medium; High/Ultra
   * on WebGL2), or the GPU FFT (High/Ultra on WebGPU).
   */
  waves: 'gerstner' | 'worker-fft' | 'gpu-fft'
  /** FFT cascades (Gerstner: the wave count). */
  cascades: number
  /** FFT tile size in texels (0: Gerstner). */
  fftSize: number
  /** Worker FFT ticks per second (0: not a worker tile). */
  tickHz: number
  /** CDLOD grid resolution G and levels. */
  grid: number
  levels: number
  /** The sky reflection cube (face px, seconds between refreshes); null: none (the Classic ocean). */
  reflection: IblQuality | null
  /** Receives the sun's CSM (never on a 16-varying adapter). */
  shadows: boolean
  /** Cloud shadows on the sea: none, as ground, or everywhere (SKY's `cloudShadows`). */
  cloudShadows: 'off' | 'ground' | 'all'
  /** Foam: Low's scrolling band; v1 (band, breaking line, tile Jacobian, lace, analytic bead); + whitecaps and spray. */
  foam: 'band' | 'v1' | 'whitecaps'
  /** Shore v1: the vertex swash (Low) or the per-pixel front from field B with the analytic bead. */
  shore: 'vertex' | 'pixel'
  /** The CDLOD selection stops at the height fog's full-fog distance, and the FFT idles with no node selected (D27). */
  fogCut: boolean
}

export interface RenderQuality {
  /**
   * The material path this preset asks for: 'classic' (Low: retail fixed-function) or 'pbr'. The world's actual path is
   * WorldRender.mode (LoadWorldOptions.render / World.setRenderMode); the game loads with this value.
   */
  path: RenderPath
  /** PBR terrain extras (RND-T): per-layer normals and ORMH only when a texture set provides them. */
  terrain: { layerNormals: boolean; heightBlend: boolean; triplanar: boolean; detailLayer: boolean; antiTiling: boolean; parallax: boolean }
  /** HDR target, tone mapping, LUT grade, bloom (RND-P). */
  hdr: boolean
  toneMap: ToneMap
  lutGrade: boolean
  /** Bloom scale (0 = off): the blur's resolution as a fraction of the screen (Babylon's bloomScale). */
  bloom: number
  /**
   * Where bloom starts, as the luminance the tone map receives (scene-linear × exposure; ~1 is a sunlit white wall, ~3
   * the top of KHR PBR Neutral's shoulder). Absent: the rule the presets shipped with (render/post.ts bloomCutoff).
   */
  bloomThreshold?: number
  /** How strongly the blurred highlights are added (absent: BLOOM_WEIGHT). */
  bloomWeight?: number
  /** Sun shadows (RND-L); null = none (the retail lightmaps only). */
  shadows: ShadowQuality | null
  /** SH + sky cube (RND-L); null = none (hemi colours from SkyState on characters). */
  ibl: IblQuality | null
  nightLights: NightLightQuality
  /** SSAO (RND-P); null = off. */
  ssao: { halfRes: boolean; samples: number } | null
  /** SSR: off, only while puddles > 0.1, or always (D31). */
  ssr: 'off' | 'puddles' | 'always'
  aa: AntiAliasing
  /**
   * Sun shafts (wave 12 godrays, render/volumetrics/shafts.ts): 'off', 'low' (Medium: quarter resolution, 16 steps)
   * or 'high' (High/Ultra: half resolution, 24 steps). A boolean is the wave-9 Advanced row (`true` = 'high'): read it
   * through `lightShaftLevel`.
   */
  lightShafts: LightShaftLevel | boolean
  /** Linear (retail) or exponential height fog (RND-P, D18); the fog colour from the horizon ring on High+. */
  fog: 'linear' | 'height'
  horizonRingFog: boolean
  /** Classic water or PBR water (RND-W), its depth shore and the optional mirror. */
  water: RenderPath
  waterDepthShore: boolean
  waterMirror: boolean
  /** Foliage (RND-W): wind + translucency, CSM caster, the grass root CSM tap. */
  foliage: { wind: boolean; translucency: boolean; csmCaster: boolean; grassRootShadow: boolean }
  /** Default render scale (the first-run logic lowers it on an iGPU, GAME). */
  renderScale: number
  /** W10-S: the coast's ocean (COAST §8.10). */
  ocean: OceanQuality
  /**
   * Wave 9B (TX-R): the texture tier (pbr/maps.ts TextureSetting; absent = 'auto', the preset's tier: Low retail,
   * Medium the retail-size remaster, High the '2x' tier, Ultra ≤ 2048 / KTX2). Read when a material or tile loads, so
   * a change applies fully after a reload.
   */
  textures?: TextureSetting
}

export type RenderPreset = 'low' | 'medium' | 'high' | 'ultra'

const NO_TERRAIN_EXTRAS = { layerNormals: false, heightBlend: false, triplanar: false, detailLayer: false, antiTiling: false, parallax: false }

export const RENDER_PRESETS: Readonly<Record<RenderPreset, Readonly<RenderQuality>>> = {
  low: {
    path: 'classic',
    terrain: NO_TERRAIN_EXTRAS,
    hdr: false,
    toneMap: 'none',
    lutGrade: false,
    bloom: 0,
    shadows: null,
    ibl: null,
    // The splat is part of the Classic night look (NL): no point lights, so light counts stay as today (D12).
    nightLights: { cluster: 0, poolFallback: 0, terrainSplat: true, grassSplat: true },
    ssao: null,
    ssr: 'off',
    aa: 'msaa',
    lightShafts: 'off',
    fog: 'linear',
    horizonRingFog: false,
    water: 'classic',
    waterDepthShore: false,
    waterMirror: false,
    foliage: { wind: false, translucency: false, csmCaster: false, grassRootShadow: false },
    renderScale: 1,
    ocean: {
      waves: 'gerstner', cascades: 3, fftSize: 0, tickHz: 0, grid: 16, levels: 6, reflection: null, shadows: false,
      cloudShadows: 'off', foam: 'band', shore: 'vertex', fogCut: true,
    },
  },
  medium: {
    path: 'pbr',
    // TT-Q (TERRAIN_TEX D9): the detail layer (one unit) and anti-tiling (none, the paving opts out) on Medium.
    terrain: { ...NO_TERRAIN_EXTRAS, detailLayer: true, antiTiling: true },
    hdr: true,
    toneMap: 'neutral',
    lutGrade: true,
    bloom: 0, // Options → Bloom (BLOOM_LOOKS; the release shipped 0.5)
    shadows: { cascades: 2, mapSize: 1024, distanceM: 60, foliageM: 0, terrain: false, props: false },
    ibl: { cubeSize: 32, refreshS: 10 },
    // D29 (W9F D3): Medium is a PBR preset now; its cluster/pool lights the PBR terrain, so no terrain splat on top.
    nightLights: { cluster: 8, poolFallback: 2, terrainSplat: false, grassSplat: true },
    ssao: null,
    ssr: 'off',
    aa: 'fxaa',
    lightShafts: 'low',
    fog: 'height',
    horizonRingFog: false,
    water: 'pbr',
    waterDepthShore: false,
    waterMirror: false,
    foliage: { wind: true, translucency: true, csmCaster: false, grassRootShadow: false },
    renderScale: 1,
    ocean: {
      waves: 'worker-fft', cascades: 2, fftSize: 64, tickHz: 20, grid: 16, levels: 8, reflection: { cubeSize: 32, refreshS: 10 }, shadows: false,
      cloudShadows: 'off', foam: 'v1', shore: 'pixel', fogCut: true,
    },
  },
  high: {
    path: 'pbr',
    // TT-Q (TERRAIN_TEX D9): + anti-tiling, its second tap on the tier plane (sroTilesHi).
    terrain: { layerNormals: true, heightBlend: true, triplanar: true, detailLayer: true, antiTiling: true, parallax: false },
    hdr: true,
    toneMap: 'neutral',
    lutGrade: true,
    bloom: 0, // Options → Bloom (BLOOM_LOOKS; the release shipped 1)
    shadows: { cascades: 3, mapSize: 2048, distanceM: 150, foliageM: 60, terrain: true, props: false },
    ibl: { cubeSize: 64, refreshS: 5 },
    nightLights: { cluster: 32, poolFallback: 2, terrainSplat: false, grassSplat: true },
    ssao: { halfRes: true, samples: 8 },
    // WAVE_PLAN3 §6.20 cut 4 (the wave-9 final gate, work/tmp/w9-finish/budgets.md): High missed its 16.7 ms p95 at the
    // plaza and in the crowd; SSR off took 2.3 ms of GPU and ~3 ms of p95 there. Ultra keeps it; puddles still reflect
    // the sky cube; Options → Advanced → Reflections brings it back.
    ssr: 'off',
    aa: 'taa',
    lightShafts: 'high',
    fog: 'height',
    horizonRingFog: true,
    water: 'pbr',
    waterDepthShore: true,
    waterMirror: false,
    foliage: { wind: true, translucency: true, csmCaster: true, grassRootShadow: true },
    renderScale: 1,
    ocean: {
      waves: 'gpu-fft', cascades: 4, fftSize: 128, tickHz: 0, grid: 32, levels: 8, reflection: { cubeSize: 64, refreshS: 5 }, shadows: true,
      cloudShadows: 'ground', foam: 'whitecaps', shore: 'pixel', fogCut: true,
    },
  },
  ultra: {
    path: 'pbr',
    terrain: { layerNormals: true, heightBlend: true, triplanar: true, detailLayer: true, antiTiling: true, parallax: true },
    hdr: true,
    toneMap: 'neutral',
    lutGrade: true,
    bloom: 0, // Options → Bloom (BLOOM_LOOKS; the release shipped 1)
    shadows: { cascades: 4, mapSize: 2048, distanceM: 250, foliageM: 60, terrain: true, props: true },
    ibl: { cubeSize: 64, refreshS: 2 },
    nightLights: { cluster: 64, poolFallback: 2, terrainSplat: false, grassSplat: true },
    ssao: { halfRes: false, samples: 16 },
    ssr: 'always',
    aa: 'taa',
    lightShafts: 'high',
    fog: 'height',
    horizonRingFog: true,
    water: 'pbr',
    waterDepthShore: true,
    waterMirror: true,
    foliage: { wind: true, translucency: true, csmCaster: true, grassRootShadow: true },
    renderScale: 1,
    ocean: {
      waves: 'gpu-fft', cascades: 4, fftSize: 256, tickHz: 0, grid: 64, levels: 8, reflection: { cubeSize: 64, refreshS: 2 }, shadows: true,
      cloudShadows: 'all', foam: 'whitecaps', shore: 'pixel', fogCut: true,
    },
  },
}

// ---- bloom (Options → Graphics → Bloom, GAME) ------------------------------------------------------------------------

/** The Options bloom choice: none, only the brightest lights (lamps, the sun, lightning, spells), or the shipped look. */
export type BloomLevel = 'off' | 'subtle' | 'strong'
export const BLOOM_LEVELS: readonly BloomLevel[] = ['off', 'subtle', 'strong']

/** Babylon's default bloom weight, the one every preset shipped with. */
export const BLOOM_WEIGHT = 0.15

/** What each bloom choice sets on a PBR preset's block (it replaces the preset's own bloom). */
export const BLOOM_LOOKS: Readonly<Record<BloomLevel, Readonly<Pick<RenderQuality, 'bloom' | 'bloomThreshold' | 'bloomWeight'>>>> = {
  off: { bloom: 0 },
  // Only what the tone map clips anyway: a cutoff of 4 after the exposure (display ≈ 0.985 on KHR PBR Neutral), the
  // same by day and by night, at two thirds of the shipped weight. Measured at the Jangan plaza (WebGPU and WebGL2,
  // Medium and High): the brightest sunlit surface at noon (white clothes, pale stone) reaches 2.7, so no surface
  // blooms; the paper lanterns, lit windows and pillar lamps (4–18 at night) and the cloud rims beside the sun do.
  subtle: { bloom: 0.5, bloomThreshold: 4, bloomWeight: 0.1 },
  // High and Ultra as the wave-9 release shipped them (render/post.ts bloomCutoff: ≈ 3.5 after the exposure at noon,
  // ≈ 6.5 at night, ≈ 7 at dusk, so at night it glows less on the lamps than Subtle does).
  strong: { bloom: 1 },
}

/**
 * A preset's render block with the Options bloom choice in place of its own (the same object when nothing changes).
 * Blocks without the HDR post stack (Low / Classic) have no bloom and are returned as they are.
 */
export function withBloom(q: Readonly<RenderQuality>, level: BloomLevel): Readonly<RenderQuality> {
  if (q.path !== 'pbr' || !q.hdr) return q
  const look = BLOOM_LOOKS[level]
  if (q.bloom === look.bloom && q.bloomThreshold === look.bloomThreshold && q.bloomWeight === look.bloomWeight) return q
  const out: RenderQuality = { ...q, bloom: look.bloom }
  delete out.bloomThreshold
  delete out.bloomWeight
  if (look.bloomThreshold !== undefined) out.bloomThreshold = look.bloomThreshold
  if (look.bloomWeight !== undefined) out.bloomWeight = look.bloomWeight
  return out
}

// ---- light shafts (Options → Graphics → Light shafts, GAME) ---------------------------------------------------------

/** The light-shaft choice: none, the light shafts (Medium's: quarter resolution), or the full shafts (High's). */
export type LightShaftLevel = 'off' | 'low' | 'high'
export const LIGHT_SHAFT_LEVELS: readonly LightShaftLevel[] = ['off', 'low', 'high']

/**
 * The shaft level a render block asks for. A boolean is the wave-9 Advanced row ('on' / 'off', apps/game settings.ts
 * foldAdvanced): `true` is the full shafts. Blocks without the HDR post stack (Low / Classic) have none.
 */
export function lightShaftLevel(q: Readonly<Pick<RenderQuality, 'path' | 'hdr' | 'lightShafts'>>): LightShaftLevel {
  if (q.path !== 'pbr' || !q.hdr) return 'off'
  const v = q.lightShafts
  return v === true ? 'high' : v === false ? 'off' : v
}

/**
 * A preset's render block with the Options light-shaft choice in place of its own (`'auto'`: the preset's; the same
 * object when nothing changes). Blocks without the HDR post stack (Low / Classic) are returned as they are: the Low
 * guard never gets shafts.
 */
export function withLightShafts(q: Readonly<RenderQuality>, level: LightShaftLevel | 'auto'): Readonly<RenderQuality> {
  if (level === 'auto' || q.path !== 'pbr' || !q.hdr || q.lightShafts === level) return q
  return { ...q, lightShafts: level }
}
