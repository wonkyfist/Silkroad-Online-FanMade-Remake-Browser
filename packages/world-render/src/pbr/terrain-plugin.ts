/**
 * PBR terrain (docs/RENDER.md §3.4, §3.5, §6, §9; docs/WAVE_PLAN3.md §6.11 and D16, D19–D22, D28, D29, D31, D32, D39).
 * `SroTerrainPlugin` turns one region's `PBRMaterial` into the retail splat terrain of TERRAIN.md §2.3 (the same layer
 * map, tile array, periods and corner-bit blend as the Classic shader in shaders.ts), lit by Babylon's PBR:
 *
 * - **Splat** in `CUSTOM_FRAGMENT_MAIN_BEGIN` (one helper function, `sroTerrainEval`): the region-local file position
 *   comes from `vPositionW` (`(x − originX, originZ − z) × 10`), so the PBR mesh needs no uv attribute and the plugin
 *   adds no varying (the 16 inter-stage variables of a default WebGPU adapter stay free, H9A lens 1). Every derivative
 *   and implicit-LOD tap sits before the layer loop; the loop and everything after it use `textureSampleGrad` /
 *   `textureSampleLevel` only (WGSL uniformity), and the function returns before the PBR blocks run.
 * - **Roughness** per layer from the surface class in the layer-map alpha (pbr/classes.ts: `128 + class`, `& 63`), ±0.1 by the
 *   texel's luminance (RENDER §3.3), or the ORMH G channel when a texture set provides the arrays (9B).
 * - **Baked sun visibility** (RENDER §3.4, D16): `bakedVis = saturate((lm − 0.61) / 0.39)` scales light 0 only
 *   (`CUSTOM_LIGHT0_COLOR`: diffuse and specular, never the IBL); beyond the CSM range
 *   `mix(1, bakedVis, max(0.35, bakedWeight))` with `bakedWeight = saturate(dot(sunDir, BAKED_LIGHT_DIR) × 2 − 0.6)`;
 *   inside it the real-time shadow takes over (`mix(…, 1, csmFade)`), so the two never double-darken. The CSM range is
 *   read from light 0's shadow generator each draw (0 = none: baked everywhere).
 * - **Per preset** (defines, changed only by Options): height blend, triplanar on steep cells, a procedural detail
 *   layer, anti-tiling, parallax; per-layer normals and ORMH only when their arrays exist (D39). Anti-tiling (TT-Q,
 *   TERRAIN_TEX §4.3) skips a layer whose alpha has the no-anti-tile bit (64: the paving, read `& 63` for the class),
 *   and under the tier its second tap reads `sroTilesHi` for layers below the tier cap, like the first.
 * - **Wetness** (RENDER §9.2–9.3, D19–D22): darkening by porosity, wet roughness, puddles from WX-R's per-region wet
 *   map (the base, D22) modulated by the ORMH height or noise, ripples from WX-R's ripple texture (D21), the shelter
 *   function (D20). The weather level (`WEATHER_PRESETS`) switches wet / puddles / ripples / shelter; the weather
 *   values themselves are uniforms, so rain never recompiles anything.
 * - **Externs** from other lanes, each behind its own define: `sroCloudShadow` (SKY-B, D28, `SRO_CLOUDSHADOW` when the
 *   sky preset has ground cloud shadows), `sroNightSplat` (NL, D29, `SRO_NIGHT_SPLAT` when NL sets that define on the
 *   terrain, i.e. Low/Medium), `sroShelter` (WX-R, D20, `SRO_SHELTER` when the weather level has a shelter map). A
 *   function whose source is still empty is simply off. Wave 10 (W10-S, docs/WAVE_PLAN6.md D11): `sroCoastWet`
 *   (CST-S, coast/chunks.ts, `SRO_COAST_WET`: the shore's wet band as `max(weather, coast)` wetness) and `sroGrassTint`
 *   (GL-T, grass/chunks.ts, `SRO_GRASS_TINT`: the grass palette on the splat's albedo, no sampler); both empty today.
 * - **SSR mask** (D31): puddles and wet flat ground raise the prepass reflectivity.
 *
 * Every piece ships in WGSL and GLSL with the same injection points (test/terrain-plugin.test.ts); the WebGL2 texture
 * units of every final define set stay ≤ 16 (D32, same test). Lane RND-T.
 */
import {
  MaterialPluginBase,
  PBRMaterial,
  RawTexture,
  ShaderLanguage,
  Texture,
  Vector4,
  type AbstractEngine,
  type BaseTexture,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import { COAST_WET_DEFINE, COAST_WET_GLSL, COAST_WET_WGSL } from '../coast/chunks.ts'
import { GRASS_TINT_GLSL, GRASS_TINT_WGSL } from '../grass/chunks.ts'
import { GRASS_TINT_DEFINE } from '../grass/types.ts'
import { NIGHT_SPLAT_GLSL, NIGHT_SPLAT_WGSL } from '../night-chunks.ts'
import { useWindowedLightFalloff } from '../render/babylon-fixes.ts'
import type { RenderQuality } from '../render/quality.ts'
import type { SharedValue } from '../shader-chunks.ts'
import { SKY_CLOUD_SHADOW_GLSL, SKY_CLOUD_SHADOW_WGSL } from '../sky/chunks.ts'
import { BAKED_LIGHT_DIR, type SkyQuality } from '../sky/types.ts'
import { createTextureArray } from '../textures.ts'
import { NEUTRAL_MAP } from '../tile-atlas.ts'
import { WX_SHELTER_GLSL, WX_SHELTER_WGSL } from '../weather/chunks.ts'
import type { WeatherPreset } from '../weather/presets.ts'
import { rainRingCode, ringTaps } from '../weather/ripples.ts'
import { MATERIAL_CLASS_PARAMS, SURFACE_CLASS_MATERIAL, TERRAIN_SURFACE, TERRAIN_SURFACE_COUNT, TERRAIN_SURFACE_PARAMS } from './classes.ts'

/** TX-R: the neutral ORMH layer (tile-atlas.ts NEUTRAL_MAP) as shader floats, for layers above the tier cap. */
const NEUTRAL_ORMH = NEUTRAL_MAP.ormh.map(v => (v / 255).toFixed(6)).join(', ')

/** The plugin's name and class name (WX-R's `attachWetness` skips materials carrying it, D19). */
export const SRO_TERRAIN_PLUGIN = 'SroTerrainPlugin'

/**
 * Tangent-space green of the terrain normal arrays: −1 = OpenGL convention (+G points to the image top, which is −v
 * here: tile rows are uploaded as stored, v = 0 samples row 0). TEXPIPE writes `normalGreen: 'gl'`; LAB's normal
 * convention check (DETAIL H8) confirms it on a lit test mesh.
 */
export const TERRAIN_NORMAL_GREEN = -1

/** Lightmap floor of the terrain `.t` lightmaps (TERRAIN.md §3.1; §2.5 of the plan): (lm − floor) / (1 − floor). */
export const TERRAIN_LIGHTMAP_FLOOR = 0.61
/** Detail layer period (m) and fade (m from the camera, full → none), RENDER §6.2 item 5. */
export const DETAIL_PERIOD_M = 1.5
export const DETAIL_FADE_M: readonly [number, number] = [5, 25]
/** Parallax range (m) and height (m) of the first layer's ORMH height (Ultra). */
export const PARALLAX_RANGE_M = 20
export const PARALLAX_HEIGHT_M = 0.06

// ---- rain on the ground (wave 12 RAIN-P) ------------------------------------------------------------------------

/**
 * The puddle threshold on the wet map's potential: `pth = [0] − puddle × [1]`, so the deepest basins (potential
 * ≈ 0.9+) show at a puddle level of ≈ 0.1 (the first minute of a downpour, shared stepSurface) and every basin above
 * ≈ 0.42 at a full level. Before wave 12: 1 − 0.6 × puddle (nothing below a level of 0.2).
 */
export const PUDDLE_THRESHOLD: readonly [number, number] = [0.94, 0.52]
/**
 * The rain film: a thin sheet of water on every wet, flat-enough terrain surface while it rains, independent of the
 * puddle basins. Strength = smoothstep(FILM_RAIN, rain) × smoothstep(FILM_WET, wetness) × smoothstep(FILM_FLAT,
 * normal.y) × the class's puddle weight × FILM_CLASS_GAIN (soil 1, stone 1, generic 0.58, grass 0.4, sand 0.17, water
 * 0). It glosses the ground (roughness toward FILM_ROUGHNESS) and carries the rain rings. The film is full from a light
 * rain up; the rings' own density and size carry the rain rate.
 */
export const FILM_RAIN: readonly [number, number] = [0.02, 0.3]
export const FILM_WET: readonly [number, number] = [0.05, 0.35]
export const FILM_FLAT: readonly [number, number] = [0.86, 0.96]
export const FILM_CLASS_GAIN = 1.15
export const FILM_ROUGHNESS = 0.08
/** The rain rings on the ground: ripple-texture repeats per metre (a 2.2 m tile: rings up to 20 cm), normal gain. */
export const TERRAIN_RING_SCALE = 0.45
export const TERRAIN_RING_GAIN = 2
/** The rings fade out where a pixel covers this many metres (geometric mean of the footprint): unresolved beyond. */
export const RING_FADE_M: readonly [number, number] = [0.035, 0.09]
/**
 * A drop's impact crown lifts the albedo toward this linear grey (a white splash, lit by the scene), and a ring's
 * crests and troughs scale it by 1 ± RING_CONTRAST × the ring height: the ring lines read from the game camera on
 * light paving and dark soil alike, in any light, not only where the tilted normal happens to catch a brighter part of
 * the sky. The taps use the gradients × RING_LOD_GRAD (a sharper mip: the rings would blur away within 10 m).
 */
export const RING_CROWN_ALBEDO = 0.45
export const RING_CONTRAST = 0.85
export const RING_LOD_GRAD = 0.3

// ---- features ---------------------------------------------------------------------------------------------------

/** What one terrain define set does (one define each; a change recompiles, so only Options may change them). */
export interface TerrainFeatures {
  /** Per-layer normal maps (the normals array exists and the preset has layer normals). */
  normals: boolean
  /** Per-layer ORMH (AO, roughness, height) from the ORMH array. */
  ormh: boolean
  heightBlend: boolean
  triplanar: boolean
  detail: boolean
  antiTiling: boolean
  /** Parallax occlusion on the first layer's height (needs ORMH). */
  parallax: boolean
  /**
   * TX-R: the tier plane (tile-atlas.ts, D39): layers below the tier cap (`sroTier.x`, at most TILE_TIER_LAYERS) take
   * their albedo from the higher-resolution array `sroTilesHi` (High: 1024²), the rest from the base array. Only where
   * the terrain night splat is off (High, Ultra), which keeps WebGL2 at ≤ 16 texture units (D32), and only while the
   * set stays within them with the height fog's horizon ring (U-1: `terrainUnits`). The map arrays are
   * then as deep as the cap and layers above it get neutral maps (`sroTier.y`, every define set).
   */
  tier: boolean
  wet: boolean
  puddles: boolean
  ripples: boolean
  shelter: boolean
  cloudShadow: boolean
  nightSplat: boolean
  /**
   * W10-S (COAST §8.6, WAVE_PLAN6 D11): CST-S's `sroCoastWet` wet band, when its source is non-empty and the coast set
   * `SRO_COAST_WET` on the terrain; it feeds the wetness as `max(weather, coast)`.
   */
  coastWet: boolean
  /** W10-S (GRASS_LIFE GL-T): GL-T's `sroGrassTint` on the splat's albedo, likewise behind `SRO_GRASS_TINT`. */
  grassTint: boolean
}

export type TerrainFeature = keyof TerrainFeatures

export const TERRAIN_FEATURE_DEFINES: Readonly<Record<TerrainFeature, string>> = {
  normals: 'SRO_T_NORMALS',
  ormh: 'SRO_T_ORMH',
  heightBlend: 'SRO_T_HEIGHTBLEND',
  triplanar: 'SRO_T_TRIPLANAR',
  detail: 'SRO_T_DETAIL',
  antiTiling: 'SRO_T_ANTITILE',
  parallax: 'SRO_T_PARALLAX',
  tier: 'SRO_T_TIER',
  wet: 'SRO_T_WET',
  puddles: 'SRO_T_PUDDLES',
  ripples: 'SRO_T_RIPPLES',
  shelter: 'SRO_SHELTER',
  cloudShadow: 'SRO_CLOUDSHADOW',
  nightSplat: 'SRO_NIGHT_SPLAT',
  coastWet: COAST_WET_DEFINE,
  grassTint: GRASS_TINT_DEFINE,
}

export const TERRAIN_FEATURES = Object.keys(TERRAIN_FEATURE_DEFINES) as TerrainFeature[]

export const NO_TERRAIN_FEATURES: Readonly<TerrainFeatures> = Object.freeze(
  Object.fromEntries(TERRAIN_FEATURES.map(f => [f, false])) as unknown as TerrainFeatures,
)

/** What the features follow (all but `quality` optional: an absent input switches its features off). */
export interface TerrainFeatureInput {
  quality: Readonly<RenderQuality>
  sky?: Readonly<SkyQuality> | null
  weather?: Readonly<WeatherPreset> | null
  /** Which map arrays exist (D39: allocated only when a texture set provides them). */
  arrays?: { normal: boolean; ormh: boolean; tier?: boolean }
  /** Which externs have a non-empty source. */
  externs?: { shelter: boolean; cloudShadow: boolean; nightSplat: boolean; coastWet?: boolean; grassTint?: boolean }
  /**
   * Defines set on the terrain by other lanes (TerrainRenderer.setDefine): NL's `SRO_NIGHT_SPLAT`; wave 10: the coast's
   * `SRO_COAST_WET`, GL-T's `SRO_GRASS_TINT`.
   */
  defines?: { has(name: string): boolean }
  /**
   * The device's fragment texture units (engine caps; default TERRAIN_MAX_UNITS, WebGL2's floor). The stream allocates
   * the tier plane only above 16 (stream.ts); this keeps any set the scene could still assemble within the device.
   */
  maxUnits?: number
}

/** WebGL2's fragment texture units on every adapter (D32, material-budgets.test.ts). */
export const TERRAIN_MAX_UNITS = 16

/**
 * The units a PBR terrain set takes on the worst scene of its preset (U-1): the plugin's textures per feature, the
 * three it always declares (tiles, layer map, lightmap), Babylon's environment BRDF and reflection, one CSM, the night
 * cluster's two, and the height fog's horizon ring where the preset has one (it attaches to every PBR material).
 */
export function terrainUnits(f: Readonly<TerrainFeatures>, fogRing: boolean): number {
  // coast/chunks.ts FULL_SET: the wet band reads its field only outside the full sets.
  const coastField = f.coastWet && !(f.shelter && f.normals)
  const own = [f.normals, f.ormh, f.detail, f.tier, f.wet, f.ripples, f.shelter, f.cloudShadow, f.nightSplat, coastField]
  return 3 + 2 + 1 + 2 + (fogRing ? 1 : 0) + own.filter(Boolean).length
}

/** The define set of a preset, weather level, map arrays and available externs (pure). */
export function resolveTerrainFeatures(i: TerrainFeatureInput): TerrainFeatures {
  const f = resolveWanted(i)
  // U-1: the tier plane is the first to go when a set would pass the device's units (16 on WebGL2; D32).
  const ring = i.quality.fog === 'height' && i.quality.horizonRingFog
  const max = i.maxUnits ?? TERRAIN_MAX_UNITS
  if (f.tier && terrainUnits(f, ring) > max) f.tier = false
  // Then NL's splat, which no ring preset asks for (terrainSplat is Low's): only a define left over for a moment by a
  // live switch from Low can bring it here, and it must never cost the link.
  if (f.nightSplat && terrainUnits(f, ring) > max) f.nightSplat = false
  return f
}

function resolveWanted(i: TerrainFeatureInput): TerrainFeatures {
  const t = i.quality.terrain
  const w = i.weather ?? null
  const ormh = !!i.arrays?.ormh
  const wet = !!w?.wet
  return {
    normals: !!i.arrays?.normal && t.layerNormals,
    ormh,
    heightBlend: t.heightBlend,
    triplanar: t.triplanar,
    detail: t.detailLayer,
    antiTiling: t.antiTiling,
    parallax: t.parallax && ormh,
    tier: !!i.arrays?.tier && !(!!i.externs?.nightSplat && !!i.defines?.has(TERRAIN_FEATURE_DEFINES.nightSplat)),
    wet,
    puddles: wet && !!w?.puddles,
    ripples: wet && !!w?.puddles && (w?.rippleSize ?? 0) > 0,
    shelter: wet && !!w?.shelter && !!i.externs?.shelter,
    cloudShadow: !!i.externs?.cloudShadow && (i.sky?.cloudShadows ?? 'off') !== 'off',
    nightSplat: !!i.externs?.nightSplat && !!i.defines?.has(TERRAIN_FEATURE_DEFINES.nightSplat),
    coastWet: !!i.externs?.coastWet && !!i.defines?.has(TERRAIN_FEATURE_DEFINES.coastWet),
    grassTint: !!i.externs?.grassTint && !!i.defines?.has(TERRAIN_FEATURE_DEFINES.grassTint),
  }
}

/** A stable key of a feature set (cache and change detection). */
export function featureKey(f: Readonly<TerrainFeatures>): string {
  return TERRAIN_FEATURES.map(k => (f[k] ? 1 : 0)).join('')
}

// ---- externs (other lanes' helper functions) --------------------------------------------------------------------

/** A uniform of an extern (a plugin UBO member). */
export interface ExternUniform {
  name: string
  type: 'float' | 'vec2' | 'vec3' | 'vec4' | 'mat4'
}

/**
 * One lane's helper function as the plugin uses it. Written like a chunk: WGSL/GLSL source that declares its own
 * textures (`var x: texture_2d<f32>; var xSampler: sampler;` / `uniform sampler2D x;`) and its uniforms as `uniform`
 * lines (`uniform wxOcc: vec4f;` / `uniform vec4 wxOcc;`); `parseExtern` moves the uniform lines into the plugin's UBO.
 * Values are bound by name from the terrain's `sharedUniforms` (the same map the Classic chunks use) and, for a
 * region slot name (`wetMap`, `nightSplat`, `lightmapExtra`), from the region's textures.
 */
export interface TerrainExtern {
  /** The function's name; the extern is off unless its source defines it. */
  fn: string
  wgsl: string
  glsl: string
  uniforms: ExternUniform[]
  samplers: string[]
  /** The position argument the function takes: world xz (vec2) or the world position (vec3). */
  arg: 'vec2' | 'vec3'
  /**
   * Defines the source tests (`#ifdef WX_OCC8`): the plugin mirrors them from the terrain's define set (the lane sets
   * them with TerrainRenderer.setDefine for its Classic chunk; the PBR material follows).
   */
  defines: string[]
}

const WGSL_TYPES: Record<string, ExternUniform['type']> = { f32: 'float', vec2f: 'vec2', vec3f: 'vec3', vec4f: 'vec4', mat4x4f: 'mat4', 'vec2<f32>': 'vec2', 'vec3<f32>': 'vec3', 'vec4<f32>': 'vec4', 'mat4x4<f32>': 'mat4' }

/**
 * Splits a helper's source into code, uniforms and samplers (see TerrainExtern). Uniforms declared in only one
 * language, or referenced as `uniforms.x` in WGSL without a declaration, are vec4.
 */
export function parseExtern(fn: string, wgsl: string, glsl: string): TerrainExtern {
  const uniforms = new Map<string, ExternUniform['type']>()
  const samplers: string[] = []
  const w = wgsl.replace(/^[ \t]*uniform[ \t]+(\w+)[ \t]*:[ \t]*([\w<>]+)[ \t]*;[ \t]*\r?\n?/gm, (_m, name: string, type: string) => {
    uniforms.set(name, WGSL_TYPES[type] ?? 'vec4')
    return ''
  })
  const g = glsl.replace(/^[ \t]*uniform[ \t]+(?:(?:highp|mediump|lowp)[ \t]+)?(float|vec2|vec3|vec4|mat4)[ \t]+(\w+)[ \t]*;[ \t]*\r?\n?/gm,
    (_m, type: ExternUniform['type'], name: string) => {
      if (!uniforms.has(name)) uniforms.set(name, type)
      return ''
    })
  for (const m of w.matchAll(/\buniforms\.(\w+)/g)) if (!uniforms.has(m[1]!)) uniforms.set(m[1]!, 'vec4')
  for (const m of w.matchAll(/\bvar[ \t]+(\w+)[ \t]*:[ \t]*texture_\w+/g)) if (!samplers.includes(m[1]!)) samplers.push(m[1]!)
  for (const m of g.matchAll(/\buniform[ \t]+(?:(?:highp|mediump|lowp)[ \t]+)?sampler\w*[ \t]+(\w+)[ \t]*;/g)) if (!samplers.includes(m[1]!)) samplers.push(m[1]!)
  const sig = new RegExp(`\\bfn[ \\t]+${fn}[ \\t]*\\([ \\t]*\\w+[ \\t]*:[ \\t]*(vec2f|vec3f|vec2<f32>|vec3<f32>)`).exec(w)
  const arg = sig && sig[1]!.startsWith('vec2') ? 'vec2' : 'vec3'
  const defines: string[] = []
  for (const m of `${w}\n${g}`.matchAll(/#ifn?def[ \t]+(\w+)|\bdefined[ \t]*\([ \t]*(\w+)[ \t]*\)/g)) {
    const d = (m[1] ?? m[2])!
    if (!defines.includes(d)) defines.push(d)
  }
  return { fn, wgsl: w, glsl: g, uniforms: [...uniforms].map(([name, type]) => ({ name, type })), samplers, arg, defines }
}

/** The position argument of an extern call (world xz or position; `wp` in both languages). */
function argOf(e: TerrainExtern | null): string {
  return e?.arg === 'vec2' ? 'wp.xz' : 'wp'
}

/** The three externs the terrain calls (null: that lane's source is empty or lacks the function). */
export interface TerrainExterns {
  shelter: TerrainExtern | null
  cloudShadow: TerrainExtern | null
  /** NL's `sroNightSplat(tex, smp, lp, night)`: the plugin declares `nightSplat` and passes `nlNight.x` itself. */
  nightSplat: TerrainExtern | null
  /** W10-S: CST-S's `sroCoastWet(wp) -> f32` (coast/chunks.ts; absent or null: off). */
  coastWet?: TerrainExtern | null
  /** W10-S: GL-T's `sroGrassTint(alb, lp, wp) -> vec3` (grass/chunks.ts; absent or null: off). */
  grassTint?: TerrainExtern | null
}

function extern(fn: string, wgsl: string, glsl: string): TerrainExtern | null {
  const re = new RegExp(`\\b${fn}\\s*\\(`)
  if (!wgsl.trim() || !glsl.trim() || !re.test(wgsl) || !re.test(glsl)) return null
  return parseExtern(fn, wgsl, glsl)
}

/**
 * The externs from the lanes' chunk files (sky/chunks.ts, weather/chunks.ts, night-chunks.ts; wave 10: coast/chunks.ts
 * and grass/chunks.ts, empty until CST-S and GL-T fill them).
 */
export function defaultTerrainExterns(): TerrainExterns {
  const night = extern('sroNightSplat', NIGHT_SPLAT_WGSL, NIGHT_SPLAT_GLSL)
  return {
    shelter: extern('sroShelter', WX_SHELTER_WGSL, WX_SHELTER_GLSL),
    cloudShadow: extern('sroCloudShadow', SKY_CLOUD_SHADOW_WGSL, SKY_CLOUD_SHADOW_GLSL),
    // The plugin declares the splat texture and nlNight itself (NL's function takes them as arguments).
    nightSplat: night && { ...night, uniforms: [{ name: 'nlNight', type: 'vec4' }], samplers: ['nightSplat'] },
    coastWet: extern('sroCoastWet', COAST_WET_WGSL, COAST_WET_GLSL),
    grassTint: extern('sroGrassTint', GRASS_TINT_WGSL, GRASS_TINT_GLSL),
  }
}

// ---- shader code ------------------------------------------------------------------------------------------------

/** Per surface class (0..5, pbr/classes.ts TERRAIN_SURFACE): roughness, porosity, wet roughness, puddle weight. */
export function terrainClassTable(): [number, number, number, number][] {
  const out: [number, number, number, number][] = []
  for (let c = 0; c < TERRAIN_SURFACE_COUNT; c++) {
    const m = MATERIAL_CLASS_PARAMS[SURFACE_CLASS_MATERIAL[c]!]
    // Sand keeps WEATHER's porosity 0.9 (D27); every other class takes RENDER §3.3's.
    const porosity = c === TERRAIN_SURFACE.sand ? TERRAIN_SURFACE_PARAMS[c]!.porosity : m.porosity
    out.push([m.roughness, porosity, m.wetRoughness, TERRAIN_SURFACE_PARAMS[c]!.puddle])
  }
  return out
}

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v))

function classFns(lang: 'wgsl' | 'glsl'): string {
  const rows = terrainClassTable()
  const grass = TERRAIN_SURFACE.grass
  const grassN = MATERIAL_CLASS_PARAMS[SURFACE_CLASS_MATERIAL[grass]!].normalStrength
  if (lang === 'wgsl') {
    const cases = rows.slice(1).map((r, i) => `  if (c == ${i + 1}) { return vec4f(${r.map(f).join(', ')}); }\n`).join('')
    return `fn sroClass(c: i32) -> vec4f {\n${cases}  return vec4f(${rows[0]!.map(f).join(', ')});\n}\n` +
      `fn sroClassN(c: i32) -> f32 {\n  return select(1.0, ${f(grassN)}, c == ${grass});\n}\n`
  }
  const cases = rows.slice(1).map((r, i) => `  if (c == ${i + 1}) return vec4(${r.map(f).join(', ')});\n`).join('')
  return `vec4 sroClass(int c) {\n${cases}  return vec4(${rows[0]!.map(f).join(', ')});\n}\n` +
    `float sroClassN(int c) {\n  return c == ${grass} ? ${f(grassN)} : 1.0;\n}\n`
}

function externDecl(e: TerrainExtern | null, define: string, lang: 'wgsl' | 'glsl'): string {
  if (!e) return ''
  const src = lang === 'wgsl' ? e.wgsl : e.glsl
  return `#ifdef ${define}\n${src.endsWith('\n') ? src : `${src}\n`}#endif\n`
}

/**
 * W10-S (COAST §8.6, GRASS_LIFE GL-T): the wave-10 extern calls. Each is '' while its lane's source is empty, so the
 * plugin's code stays today's byte for byte (terrain-plugin.test.ts, material-budgets.test.ts).
 */
function tintCall(x: TerrainExterns): string {
  if (!x.grassTint) return ''
  return `#ifdef ${TERRAIN_FEATURE_DEFINES.grassTint}\n  alb = sroGrassTint(alb, lp, wp);\n#endif\n`
}

/** The coast wetness of this pixel (`sroCw`, 0 without the define). */
function coastPre(x: TerrainExterns, lang: 'wgsl' | 'glsl'): string {
  if (!x.coastWet) return ''
  const decl = lang === 'wgsl' ? '  var sroCw = 0.0;\n' : '  float sroCw = 0.0;\n'
  return `${decl}#ifdef ${TERRAIN_FEATURE_DEFINES.coastWet}\n  sroCw = clamp(sroCoastWet(wp), 0.0, 1.0);\n#endif\n`
}

/** The weather wetness term, raised to the coast's (`max(weather, coast)`) when the coast extern exists. */
function coastW(x: TerrainExterns, weather: string): string {
  return x.coastWet ? `max(${weather}, sroCw)` : weather
}

/** Without the weather's wet block, the coast alone darkens, smooths and flattens the wet band (the same terms). */
function coastOnly(x: TerrainExterns, lang: 'wgsl' | 'glsl'): string {
  if (!x.coastWet) return ''
  const D = TERRAIN_FEATURE_DEFINES
  const alb = lang === 'wgsl' ? 'alb = alb * ' : 'alb *= '
  const body = `  ${alb}mix(1.0, 1.0 - 0.5 * cls.y, sroCw);\n` +
    '  rough = mix(rough, min(rough, cls.z), sroCw);\n' +
    '  nW = normalize(mix(nW, vN, 0.5 * sroCw));\n' +
    '  sroR0 = 0.04 + 0.03 * sroCw * smoothstep(0.93, 0.98, vN.y);\n'
  return `#ifndef ${D.wet}\n#ifdef ${D.coastWet}\n${body}#endif\n#endif\n`
}

/** The injection points of one language (both languages return the same keys). */
export type TerrainPluginCode = Record<string, string>

/** The regex point on the AO call (same text in both languages; RENDER §3.5: re-emits the match, then scales it). */
export const AO_POINT = '!(aoOut=ambientOcclusionBlock\\([^;]*\\);)'

function wgslCode(x: TerrainExterns): TerrainPluginCode {
  const D = TERRAIN_FEATURE_DEFINES
  const definitions = `
var sroTiles: texture_2d_array<f32>;
var sroTilesSampler: sampler;
#ifdef ${D.tier}
var sroTilesHi: texture_2d_array<f32>;
#endif
const SRO_NEUTRAL_ORMH = vec4f(${NEUTRAL_ORMH});
var sroLayerMap: texture_2d<f32>;
var sroLightmap: texture_2d<f32>;
var sroLightmapSampler: sampler;
#ifdef ${D.normals}
var sroNormals: texture_2d_array<f32>;
#endif
#ifdef ${D.ormh}
var sroOrmh: texture_2d_array<f32>;
#endif
#ifdef ${D.detail}
var sroDetail: texture_2d_array<f32>;
var sroDetailSampler: sampler;
#endif
#ifdef ${D.wet}
var sroWetMap: texture_2d<f32>;
var sroWetMapSampler: sampler;
#endif
#ifdef ${D.ripples}
var sroRipple: texture_2d<f32>;
var sroRippleSampler: sampler;
${rainRingCode('wgsl', 'sroTRing')}#endif
#ifdef ${D.nightSplat}
var nightSplat: texture_2d<f32>;
var nightSplatSampler: sampler;
#endif
var<private> sroAlbedo: vec3f;
var<private> sroRough: f32;
var<private> sroAO: f32;
var<private> sroBaked: f32;
var<private> sroCsm: f32;
var<private> sroCloud: f32;
var<private> sroNormal: vec3f;
var<private> sroR0: f32;
var<private> sroEmit: vec3f;
${externDecl(x.shelter, D.shelter, 'wgsl')}${externDecl(x.cloudShadow, D.cloudShadow, 'wgsl')}${externDecl(x.nightSplat, D.nightSplat, 'wgsl')}${externDecl(x.coastWet ?? null, D.coastWet, 'wgsl')}${externDecl(x.grassTint ?? null, D.grassTint, 'wgsl')}fn sroPeriod(code: i32) -> f32 {
  if (code == 1) { return 160.0; }
  if (code == 3) { return 40.0; }
  if (code == 4) { return 20.0; }
  return 80.0;
}
${classFns('wgsl')}fn sroLuma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}
fn sroHash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + vec3f(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
fn sroNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let u = fract(p);
  let s = u * u * (vec2f(3.0) - 2.0 * u);
  return mix(mix(sroHash(i), sroHash(i + vec2f(1.0, 0.0)), s.x), mix(sroHash(i + vec2f(0.0, 1.0)), sroHash(i + vec2f(1.0, 1.0)), s.x), s.y);
}
fn sroIdColor(id: f32) -> vec3f {
  return fract(sin(vec3f(id + 1.0) * vec3f(12.9898, 78.233, 37.719)) * 43758.5453);
}
fn sroTerrainEval() {
  let wp = fragmentInputs.vPositionW;
  let vN = normalize(fragmentInputs.vNormalW);
  var lp = vec2f(wp.x - uniforms.sroRegion.x, uniforms.sroRegion.y - wp.z) * 10.0;
  let gx = dpdx(lp);
  let gy = dpdy(lp);
  let lmUv = (vec2f(0.5) + lp * (511.0 / 1920.0)) / 512.0;
  let lm = textureSampleBias(sroLightmap, sroLightmapSampler, lmUv, -0.5).rgb;
  let camD = distance(scene.vEyePosition.xyz, wp);
#ifdef ${D.triplanar}
  let wgx = dpdx(wp) * 10.0;
  let wgy = dpdy(wp) * 10.0;
#endif
#ifdef ${D.detail}
  let duv = wp.xz / ${f(DETAIL_PERIOD_M)};
  let dgx = dpdx(duv);
  let dgy = dpdy(duv);
#endif
  var shelter = 1.0;
#ifdef ${D.shelter}
  shelter = sroShelter(${argOf(x.shelter)});
#endif
  sroCloud = 1.0;
#ifdef ${D.cloudShadow}
  sroCloud = sroCloudShadow(${argOf(x.cloudShadow)});
#endif
#ifdef ${D.parallax}
  if (camD < ${f(PARALLAX_RANGE_M)}) {
    let pc = vec2i(clamp(floor(lp / 20.0), vec2f(0.0), vec2f(95.0)));
    let t0 = textureLoad(sroLayerMap, pc, 0);
    let p0 = sroPeriod(i32(t0.g * 255.0 + 0.5));
    let i0 = i32(t0.r * 255.0 + 0.5);
    let V = normalize(scene.vEyePosition.xyz - wp);
    let Tx = normalize(vec3f(1.0, 0.0, 0.0) - vN * vN.x);
    let Bv = cross(vN, Tx);
    let vt = vec3f(dot(V, Tx), dot(V, Bv), max(dot(V, vN), 0.25));
    let fade = 1.0 - smoothstep(${f(PARALLAX_RANGE_M * 0.6)}, ${f(PARALLAX_RANGE_M)}, camD);
    let pstep = -vt.xy / vt.z * (${f(PARALLAX_HEIGHT_M * 10)} * fade / 12.0);
    var depth = 0.0;
    var cur = lp;
    for (var i = 0; i < 12; i++) {
      var h = 1.0;
      if (i0 < i32(uniforms.sroTier.y + 0.5)) { h = textureSampleGrad(sroOrmh, sroTilesSampler, cur / p0, i0, gx / p0, gy / p0).a; }
      if (depth >= 1.0 - h) { break; }
      cur = cur + pstep;
      depth = depth + 1.0 / 12.0;
    }
    lp = cur;
  }
#endif
  let cf = lp / 20.0;
  let cellF = clamp(floor(cf), vec2f(0.0), vec2f(95.0));
  let fr = clamp(cf - cellF, vec2f(0.0), vec2f(1.0));
  let cell = vec2i(cellF);
  let n = i32(uniforms.sroRegion.z + 0.5);
  let dmode = i32(uniforms.sroParams.y + 0.5);
  var color = vec3f(0.0);
  var cls = vec4f(0.0);
  var hAcc = 0.5;
  var rough = 0.8;
  var ao = 1.0;
  var nT = vec3f(0.0, 0.0, 1.0);
  var drawn = 0;
  var firstIdx = 0.0;
  var topCls = 0;
  for (var k = 0; k < 8; k++) {
    if (k >= n) { break; }
    let t = textureLoad(sroLayerMap, vec2i(cell.x, k * 96 + cell.y), 0);
    if (t.a < 0.5) { break; }
    let idx = i32(t.r * 255.0 + 0.5);
    let code = i32(t.g * 255.0 + 0.5);
    let m = u32(t.b * 255.0 + 0.5);
    let ab = i32(t.a * 255.0 + 0.5);
    let sc = ab & 63;
    let p = sroPeriod(code);
    let uv = lp / p;
#ifdef ${D.tier}
    var c: vec3f;
    if (idx < i32(uniforms.sroTier.x + 0.5)) {
      c = textureSampleGrad(sroTilesHi, sroTilesSampler, uv, idx, gx / p, gy / p).rgb;
    } else {
      c = textureSampleGrad(sroTiles, sroTilesSampler, uv, idx, gx / p, gy / p).rgb;
    }
#else
    var c = textureSampleGrad(sroTiles, sroTilesSampler, uv, idx, gx / p, gy / p).rgb;
#endif
    if (k == 0) {
#ifdef ${D.triplanar}
      let steep = 1.0 - smoothstep(0.55, 0.75, abs(vN.y));
      if (steep > 0.0) {
        var tw = pow(abs(vN), vec3f(4.0));
        tw = tw / (tw.x + tw.y + tw.z);
#ifdef ${D.tier}
        var cx: vec3f;
        var cz: vec3f;
        if (idx < i32(uniforms.sroTier.x + 0.5)) {
          cx = textureSampleGrad(sroTilesHi, sroTilesSampler, vec2f(-wp.z, -wp.y) * 10.0 / p, idx, vec2f(-wgx.z, -wgx.y) / p, vec2f(-wgy.z, -wgy.y) / p).rgb;
          cz = textureSampleGrad(sroTilesHi, sroTilesSampler, vec2f(wp.x, -wp.y) * 10.0 / p, idx, vec2f(wgx.x, -wgx.y) / p, vec2f(wgy.x, -wgy.y) / p).rgb;
        } else {
          cx = textureSampleGrad(sroTiles, sroTilesSampler, vec2f(-wp.z, -wp.y) * 10.0 / p, idx, vec2f(-wgx.z, -wgx.y) / p, vec2f(-wgy.z, -wgy.y) / p).rgb;
          cz = textureSampleGrad(sroTiles, sroTilesSampler, vec2f(wp.x, -wp.y) * 10.0 / p, idx, vec2f(wgx.x, -wgx.y) / p, vec2f(wgy.x, -wgy.y) / p).rgb;
        }
#else
        let cx = textureSampleGrad(sroTiles, sroTilesSampler, vec2f(-wp.z, -wp.y) * 10.0 / p, idx, vec2f(-wgx.z, -wgx.y) / p, vec2f(-wgy.z, -wgy.y) / p).rgb;
        let cz = textureSampleGrad(sroTiles, sroTilesSampler, vec2f(wp.x, -wp.y) * 10.0 / p, idx, vec2f(wgx.x, -wgx.y) / p, vec2f(wgy.x, -wgy.y) / p).rgb;
#endif
        c = mix(c, c * tw.y + cx * tw.x + cz * tw.z, steep);
      }
#endif
#ifdef ${D.antiTiling}
      if ((ab & 64) == 0) {
        let ruv = vec2f(uv.x * 0.8 - uv.y * 0.6, uv.x * 0.6 + uv.y * 0.8) * 0.73 + vec2f(0.37, 0.61);
        let rgx = vec2f(gx.x * 0.8 - gx.y * 0.6, gx.x * 0.6 + gx.y * 0.8) * (0.73 / p);
        let rgy = vec2f(gy.x * 0.8 - gy.y * 0.6, gy.x * 0.6 + gy.y * 0.8) * (0.73 / p);
#ifdef ${D.tier}
        var c2: vec3f;
        if (idx < i32(uniforms.sroTier.x + 0.5)) {
          c2 = textureSampleGrad(sroTilesHi, sroTilesSampler, ruv, idx, rgx, rgy).rgb;
        } else {
          c2 = textureSampleGrad(sroTiles, sroTilesSampler, ruv, idx, rgx, rgy).rgb;
        }
#else
        let c2 = textureSampleGrad(sroTiles, sroTilesSampler, ruv, idx, rgx, rgy).rgb;
#endif
        let wa = smoothstep(0.35, 0.75, sroNoise(lp / (p * 2.3)));
        c = mix(c, c2 * mix(1.0, (sroLuma(c) + 0.02) / (sroLuma(c2) + 0.02), 0.4), wa * 0.6);
      }
#endif
    }
    let b0 = f32(m & 1u);
    let b1 = f32((m >> 1u) & 1u);
    let b2 = f32((m >> 2u) & 1u);
    let b3 = f32((m >> 3u) & 1u);
    let a = mix(mix(b0, b1, fr.x), mix(b2, b3, fr.x), fr.y);
    let cp = sroClass(sc);
#ifdef ${D.ormh}
    var o = SRO_NEUTRAL_ORMH;
    if (idx < i32(uniforms.sroTier.y + 0.5)) { o = textureSampleGrad(sroOrmh, sroTilesSampler, uv, idx, gx / p, gy / p); }
    let h = o.a;
    let r = max(o.g, 0.03);
    let aoK = o.r;
#else
    let h = sroLuma(c);
    let r = clamp(cp.x + 0.1 * (0.5 - sroLuma(c)), 0.03, 1.0);
    let aoK = 1.0;
#endif
#ifdef ${D.normals}
    var nm = vec2f(0.0);
    if (idx < i32(uniforms.sroTier.y + 0.5)) { nm = textureSampleGrad(sroNormals, sroTilesSampler, uv, idx, gx / p, gy / p).rg * 2.0 - vec2f(1.0); }
    let nk = vec3f(nm * sroClassN(sc), 1.0);
#else
    let nk = vec3f(0.0, 0.0, 1.0);
#endif
    if (k == 0) {
      color = c;
      cls = cp;
      hAcc = h;
      rough = r;
      ao = aoK;
      nT = nk;
      firstIdx = f32(idx);
      topCls = sc;
    } else if (dmode != 3) {
      var wk = a;
#ifdef ${D.heightBlend}
      let hx = a * 1.6 - 0.3 + (h - hAcc) * 0.5;
      wk = clamp((hx - 0.5) / 0.25 + 0.5, 0.0, 1.0);
#endif
      color = mix(color, c, wk);
      cls = mix(cls, cp, wk);
      hAcc = mix(hAcc, h, wk);
      rough = mix(rough, r, wk);
      ao = mix(ao, aoK, wk);
      nT = mix(nT, nk, wk);
      if (wk > 0.5) { topCls = sc; }
    }
    drawn = k + 1;
  }
  if (dmode == 1) {
    let hh = f32(drawn) / 7.0;
    color = clamp(vec3f(2.0 * hh - 0.5, 1.5 - abs(4.0 * hh - 2.0), 1.0 - 2.0 * hh), vec3f(0.0), vec3f(1.0));
  } else if (dmode == 2) {
    color = vec3f(1.0);
  } else if (dmode == 4) {
    color = sroIdColor(firstIdx);
  }
#ifdef ${D.detail}
  let dfade = 1.0 - smoothstep(${f(DETAIL_FADE_M[0])}, ${f(DETAIL_FADE_M[1])}, camD);
  let dl = select(select(0, 2, topCls == ${TERRAIN_SURFACE.stone}), 1, topCls == ${TERRAIN_SURFACE.grass});
  let dd = textureSampleGrad(sroDetail, sroDetailSampler, duv, dl, dgx, dgy);
  color = color * mix(1.0, dd.b * 2.0, 0.5 * dfade);
  nT = vec3f(nT.xy + (dd.rg * 2.0 - vec2f(1.0)) * (0.6 * dfade), nT.z);
#endif
  var alb = toLinearSpaceVec3(color);
${tintCall(x)}  let Tw = normalize(vec3f(1.0, 0.0, 0.0) - vN * vN.x);
  let Bw = cross(vN, Tw);
  var nW = normalize(Tw * nT.x + Bw * (nT.y * ${f(TERRAIN_NORMAL_GREEN)}) + vN * nT.z);
  sroR0 = 0.0;
${coastPre(x, 'wgsl')}#ifdef ${D.wet}
  let wW = ${coastW(x, 'clamp(uniforms.sroWeather.y, 0.0, 1.0) * shelter')};
  let flatK = smoothstep(0.93, 0.98, vN.y);
  alb = alb * mix(1.0, 1.0 - 0.5 * cls.y, wW);
  rough = mix(rough, min(rough, cls.z), wW);
  nW = normalize(mix(nW, vN, 0.5 * wW));
  sroR0 = 0.04 + 0.03 * wW * flatK;
#ifdef ${D.puddles}
  let wet4 = textureSampleLevel(sroWetMap, sroWetMapSampler, (lp / 20.0 + vec2f(0.5)) / 97.0, 0.0);
  var hMod = sroNoise(lp * 0.015);
#ifdef ${D.ormh}
  hMod = 1.0 - hAcc;
#endif
  var pot = flatK * cls.w * (0.15 + 0.4 * hMod);
  if (uniforms.sroRegion.w > 0.5) { pot = wet4.r * (0.75 + 0.25 * hMod); }
  let pth = ${f(PUDDLE_THRESHOLD[0])} - clamp(uniforms.sroWeather.z, 0.0, 1.0) * ${f(PUDDLE_THRESHOLD[1])};
  let pm = smoothstep(pth - 0.05, pth + 0.05, pot) * shelter;
  var rip = vec2f(0.0);
  var film = 0.0;
#ifdef ${D.ripples}
  let rr = clamp(uniforms.sroWeather.x, 0.0, 1.0);
  if (rr > 0.001) {
    film = smoothstep(${f(FILM_RAIN[0])}, ${f(FILM_RAIN[1])}, rr) * smoothstep(${f(FILM_WET[0])}, ${f(FILM_WET[1])}, wW) * smoothstep(${f(FILM_FLAT[0])}, ${f(FILM_FLAT[1])}, vN.y) * clamp(cls.w * ${f(FILM_CLASS_GAIN)}, 0.0, 1.0);
    let ru = wp.xz * ${f(TERRAIN_RING_SCALE)};
    let rdx = vec2f(gx.x, -gx.y) * ${f(TERRAIN_RING_SCALE / 10)};
    let rdy = vec2f(gy.x, -gy.y) * ${f(TERRAIN_RING_SCALE / 10)};
    let tm = uniforms.sroParams.w;
${ringTaps('wgsl', 'sroTRing', 'sroRipple', 'ru', `rdx * ${f(RING_LOD_GRAD)}`, `rdy * ${f(RING_LOD_GRAD)}`, 'tm', 'rr', 'rg', '    ')}    let fp = sqrt(length(rdx) * length(rdy)) / ${f(TERRAIN_RING_SCALE)};
    let ra = max(film, pm * smoothstep(0.0, 0.15, rr)) * (1.0 - smoothstep(${f(RING_FADE_M[0])}, ${f(RING_FADE_M[1])}, fp));
    rip = rg.xy * (${f(TERRAIN_RING_GAIN)} * ra);
    alb = alb * clamp(1.0 + rg.w * (${f(RING_CONTRAST)} * ra), 0.4, 1.8);
    alb = mix(alb, vec3f(${f(RING_CROWN_ALBEDO)}), clamp(rg.z * ra * 0.8, 0.0, 1.0));
  }
#endif
  alb = alb * mix(1.0, 0.6, pm);
  rough = mix(rough, 0.03, pm);
  rough = mix(rough, min(rough, ${f(FILM_ROUGHNESS)}), film);
  nW = normalize(mix(nW, vN, max(pm, film * 0.7)) + vec3f(rip.x, 0.0, rip.y));
  sroR0 = max(sroR0, 0.04 + 0.06 * max(pm, film * 0.6));
#endif
#endif
${coastOnly(x, 'wgsl')}  sroAlbedo = alb;
  sroRough = clamp(rough, 0.02, 1.0);
  sroAO = ao;
  sroNormal = nW;
  let lmv = dot(lm, vec3f(0.33333334));
  sroBaked = select(1.0, clamp((lmv - ${f(TERRAIN_LIGHTMAP_FLOOR)}) / ${f(1 - TERRAIN_LIGHTMAP_FLOOR)}, 0.0, 1.0), uniforms.sroParams.x > 0.5);
  let csmR = uniforms.sroParams.z;
  let vz = abs((scene.view * vec4f(wp, 1.0)).z);
  sroCsm = select(0.0, 1.0 - smoothstep(csmR * 0.8, csmR, vz), csmR > 0.0);
  sroEmit = vec3f(0.0);
#ifdef ${D.nightSplat}
  sroEmit = alb * toLinearSpaceVec3(sroNightSplat(nightSplat, nightSplatSampler, lp, uniforms.nlNight.x)) * uniforms.sroSun.w;
#endif
}
`
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: definitions,
    CUSTOM_FRAGMENT_MAIN_BEGIN: 'sroTerrainEval();',
    CUSTOM_FRAGMENT_UPDATE_ALBEDO: 'surfaceAlbedo = sroAlbedo;',
    CUSTOM_FRAGMENT_UPDATE_ALPHA: 'normalW = sroNormal;',
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: 'metallicRoughness = vec2f(0.0, sroRough);',
    [AO_POINT]: '$1\naoOut.ambientOcclusionColor = aoOut.ambientOcclusionColor * sroAO;',
    CUSTOM_LIGHT0_COLOR: `{
  let sroW = clamp(dot(normalize(-light0.vLightData.xyz), uniforms.sroSun.xyz) * 2.0 - 0.6, 0.0, 1.0);
  let sroV = mix(mix(1.0, sroBaked, max(0.35, sroW)), 1.0, sroCsm) * sroCloud;
  diffuse0 = vec4f(diffuse0.rgb * sroV, diffuse0.a);
}`,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: 'finalEmissive = finalEmissive + sroEmit;',
    CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `#ifdef PREPASS_REFLECTIVITY
specularEnvironmentR0 = max(specularEnvironmentR0, vec3f(sroR0));
#endif`,
  }
}

function glslCode(x: TerrainExterns): TerrainPluginCode {
  const D = TERRAIN_FEATURE_DEFINES
  const definitions = `
uniform highp sampler2DArray sroTiles;
#ifdef ${D.tier}
uniform highp sampler2DArray sroTilesHi;
#endif
const vec4 SRO_NEUTRAL_ORMH = vec4(${NEUTRAL_ORMH});
uniform highp sampler2D sroLayerMap;
uniform sampler2D sroLightmap;
#ifdef ${D.normals}
uniform highp sampler2DArray sroNormals;
#endif
#ifdef ${D.ormh}
uniform highp sampler2DArray sroOrmh;
#endif
#ifdef ${D.detail}
uniform highp sampler2DArray sroDetail;
#endif
#ifdef ${D.wet}
uniform sampler2D sroWetMap;
#endif
#ifdef ${D.ripples}
uniform sampler2D sroRipple;
${rainRingCode('glsl', 'sroTRing')}#endif
#ifdef ${D.nightSplat}
uniform sampler2D nightSplat;
#endif
vec3 sroAlbedo;
float sroRough;
float sroAO;
float sroBaked;
float sroCsm;
float sroCloud;
vec3 sroNormal;
float sroR0;
vec3 sroEmit;
${externDecl(x.shelter, D.shelter, 'glsl')}${externDecl(x.cloudShadow, D.cloudShadow, 'glsl')}${externDecl(x.nightSplat, D.nightSplat, 'glsl')}${externDecl(x.coastWet ?? null, D.coastWet, 'glsl')}${externDecl(x.grassTint ?? null, D.grassTint, 'glsl')}float sroPeriod(int code) {
  if (code == 1) return 160.0;
  if (code == 3) return 40.0;
  if (code == 4) return 20.0;
  return 80.0;
}
${classFns('glsl')}float sroLuma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}
float sroHash(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + vec3(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
float sroNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  vec2 s = u * u * (3.0 - 2.0 * u);
  return mix(mix(sroHash(i), sroHash(i + vec2(1.0, 0.0)), s.x), mix(sroHash(i + vec2(0.0, 1.0)), sroHash(i + vec2(1.0, 1.0)), s.x), s.y);
}
vec3 sroIdColor(float id) {
  return fract(sin(vec3(id + 1.0) * vec3(12.9898, 78.233, 37.719)) * 43758.5453);
}
void sroTerrainEval() {
  vec3 wp = vPositionW;
  vec3 vN = normalize(vNormalW);
  vec2 lp = vec2(wp.x - sroRegion.x, sroRegion.y - wp.z) * 10.0;
  vec2 gx = dFdx(lp);
  vec2 gy = dFdy(lp);
  vec2 lmUv = (vec2(0.5) + lp * (511.0 / 1920.0)) / 512.0;
  vec3 lm = texture(sroLightmap, lmUv, -0.5).rgb;
  float camD = distance(vEyePosition.xyz, wp);
#ifdef ${D.triplanar}
  vec3 wgx = dFdx(wp) * 10.0;
  vec3 wgy = dFdy(wp) * 10.0;
#endif
#ifdef ${D.detail}
  vec2 duv = wp.xz / ${f(DETAIL_PERIOD_M)};
  vec2 dgx = dFdx(duv);
  vec2 dgy = dFdy(duv);
#endif
  float shelter = 1.0;
#ifdef ${D.shelter}
  shelter = sroShelter(${argOf(x.shelter)});
#endif
  sroCloud = 1.0;
#ifdef ${D.cloudShadow}
  sroCloud = sroCloudShadow(${argOf(x.cloudShadow)});
#endif
#ifdef ${D.parallax}
  if (camD < ${f(PARALLAX_RANGE_M)}) {
    ivec2 pc = ivec2(clamp(floor(lp / 20.0), vec2(0.0), vec2(95.0)));
    vec4 t0 = texelFetch(sroLayerMap, pc, 0);
    float p0 = sroPeriod(int(t0.g * 255.0 + 0.5));
    float i0 = floor(t0.r * 255.0 + 0.5);
    vec3 V = normalize(vEyePosition.xyz - wp);
    vec3 Tx = normalize(vec3(1.0, 0.0, 0.0) - vN * vN.x);
    vec3 Bv = cross(vN, Tx);
    vec3 vt = vec3(dot(V, Tx), dot(V, Bv), max(dot(V, vN), 0.25));
    float fade = 1.0 - smoothstep(${f(PARALLAX_RANGE_M * 0.6)}, ${f(PARALLAX_RANGE_M)}, camD);
    vec2 stp = -vt.xy / vt.z * (${f(PARALLAX_HEIGHT_M * 10)} * fade / 12.0);
    float depth = 0.0;
    vec2 cur = lp;
    for (int i = 0; i < 12; i++) {
      float h = i0 < sroTier.y - 0.5 ? textureGrad(sroOrmh, vec3(cur / p0, i0), gx / p0, gy / p0).a : 1.0;
      if (depth >= 1.0 - h) break;
      cur += stp;
      depth += 1.0 / 12.0;
    }
    lp = cur;
  }
#endif
  vec2 cf = lp / 20.0;
  vec2 cellF = clamp(floor(cf), vec2(0.0), vec2(95.0));
  vec2 fr = clamp(cf - cellF, vec2(0.0), vec2(1.0));
  ivec2 cell = ivec2(cellF);
  int n = int(sroRegion.z + 0.5);
  int dmode = int(sroParams.y + 0.5);
  vec3 color = vec3(0.0);
  vec4 cls = vec4(0.0);
  float hAcc = 0.5;
  float rough = 0.8;
  float ao = 1.0;
  vec3 nT = vec3(0.0, 0.0, 1.0);
  int drawn = 0;
  float firstIdx = 0.0;
  int topCls = 0;
  for (int k = 0; k < 8; k++) {
    if (k >= n) break;
    vec4 t = texelFetch(sroLayerMap, ivec2(cell.x, k * 96 + cell.y), 0);
    if (t.a < 0.5) break;
    float idx = floor(t.r * 255.0 + 0.5);
    int code = int(t.g * 255.0 + 0.5);
    int m = int(t.b * 255.0 + 0.5);
    int ab = int(t.a * 255.0 + 0.5);
    int sc = ab & 63;
    float p = sroPeriod(code);
    vec2 uv = lp / p;
#ifdef ${D.tier}
    vec3 c = idx < sroTier.x - 0.5 ? textureGrad(sroTilesHi, vec3(uv, idx), gx / p, gy / p).rgb : textureGrad(sroTiles, vec3(uv, idx), gx / p, gy / p).rgb;
#else
    vec3 c = textureGrad(sroTiles, vec3(uv, idx), gx / p, gy / p).rgb;
#endif
    if (k == 0) {
#ifdef ${D.triplanar}
      float steep = 1.0 - smoothstep(0.55, 0.75, abs(vN.y));
      if (steep > 0.0) {
        vec3 tw = pow(abs(vN), vec3(4.0));
        tw /= tw.x + tw.y + tw.z;
#ifdef ${D.tier}
        bool hi = idx < sroTier.x - 0.5;
        vec3 cx = hi ? textureGrad(sroTilesHi, vec3(vec2(-wp.z, -wp.y) * 10.0 / p, idx), vec2(-wgx.z, -wgx.y) / p, vec2(-wgy.z, -wgy.y) / p).rgb : textureGrad(sroTiles, vec3(vec2(-wp.z, -wp.y) * 10.0 / p, idx), vec2(-wgx.z, -wgx.y) / p, vec2(-wgy.z, -wgy.y) / p).rgb;
        vec3 cz = hi ? textureGrad(sroTilesHi, vec3(vec2(wp.x, -wp.y) * 10.0 / p, idx), vec2(wgx.x, -wgx.y) / p, vec2(wgy.x, -wgy.y) / p).rgb : textureGrad(sroTiles, vec3(vec2(wp.x, -wp.y) * 10.0 / p, idx), vec2(wgx.x, -wgx.y) / p, vec2(wgy.x, -wgy.y) / p).rgb;
#else
        vec3 cx = textureGrad(sroTiles, vec3(vec2(-wp.z, -wp.y) * 10.0 / p, idx), vec2(-wgx.z, -wgx.y) / p, vec2(-wgy.z, -wgy.y) / p).rgb;
        vec3 cz = textureGrad(sroTiles, vec3(vec2(wp.x, -wp.y) * 10.0 / p, idx), vec2(wgx.x, -wgx.y) / p, vec2(wgy.x, -wgy.y) / p).rgb;
#endif
        c = mix(c, c * tw.y + cx * tw.x + cz * tw.z, steep);
      }
#endif
#ifdef ${D.antiTiling}
      if ((ab & 64) == 0) {
        vec2 ruv = vec2(uv.x * 0.8 - uv.y * 0.6, uv.x * 0.6 + uv.y * 0.8) * 0.73 + vec2(0.37, 0.61);
        vec2 rgx = vec2(gx.x * 0.8 - gx.y * 0.6, gx.x * 0.6 + gx.y * 0.8) * (0.73 / p);
        vec2 rgy = vec2(gy.x * 0.8 - gy.y * 0.6, gy.x * 0.6 + gy.y * 0.8) * (0.73 / p);
#ifdef ${D.tier}
        vec3 c2 = idx < sroTier.x - 0.5 ? textureGrad(sroTilesHi, vec3(ruv, idx), rgx, rgy).rgb : textureGrad(sroTiles, vec3(ruv, idx), rgx, rgy).rgb;
#else
        vec3 c2 = textureGrad(sroTiles, vec3(ruv, idx), rgx, rgy).rgb;
#endif
        float wa = smoothstep(0.35, 0.75, sroNoise(lp / (p * 2.3)));
        c = mix(c, c2 * mix(1.0, (sroLuma(c) + 0.02) / (sroLuma(c2) + 0.02), 0.4), wa * 0.6);
      }
#endif
    }
    float b0 = float(m & 1);
    float b1 = float((m >> 1) & 1);
    float b2 = float((m >> 2) & 1);
    float b3 = float((m >> 3) & 1);
    float a = mix(mix(b0, b1, fr.x), mix(b2, b3, fr.x), fr.y);
    vec4 cp = sroClass(sc);
#ifdef ${D.ormh}
    vec4 o = idx < sroTier.y - 0.5 ? textureGrad(sroOrmh, vec3(uv, idx), gx / p, gy / p) : SRO_NEUTRAL_ORMH;
    float h = o.a;
    float r = max(o.g, 0.03);
    float aoK = o.r;
#else
    float h = sroLuma(c);
    float r = clamp(cp.x + 0.1 * (0.5 - sroLuma(c)), 0.03, 1.0);
    float aoK = 1.0;
#endif
#ifdef ${D.normals}
    vec2 nm = idx < sroTier.y - 0.5 ? textureGrad(sroNormals, vec3(uv, idx), gx / p, gy / p).rg * 2.0 - 1.0 : vec2(0.0);
    vec3 nk = vec3(nm * sroClassN(sc), 1.0);
#else
    vec3 nk = vec3(0.0, 0.0, 1.0);
#endif
    if (k == 0) {
      color = c;
      cls = cp;
      hAcc = h;
      rough = r;
      ao = aoK;
      nT = nk;
      firstIdx = idx;
      topCls = sc;
    } else if (dmode != 3) {
      float wk = a;
#ifdef ${D.heightBlend}
      float hx = a * 1.6 - 0.3 + (h - hAcc) * 0.5;
      wk = clamp((hx - 0.5) / 0.25 + 0.5, 0.0, 1.0);
#endif
      color = mix(color, c, wk);
      cls = mix(cls, cp, wk);
      hAcc = mix(hAcc, h, wk);
      rough = mix(rough, r, wk);
      ao = mix(ao, aoK, wk);
      nT = mix(nT, nk, wk);
      if (wk > 0.5) topCls = sc;
    }
    drawn = k + 1;
  }
  if (dmode == 1) {
    float hh = float(drawn) / 7.0;
    color = clamp(vec3(2.0 * hh - 0.5, 1.5 - abs(4.0 * hh - 2.0), 1.0 - 2.0 * hh), 0.0, 1.0);
  } else if (dmode == 2) {
    color = vec3(1.0);
  } else if (dmode == 4) {
    color = sroIdColor(firstIdx);
  }
#ifdef ${D.detail}
  float dfade = 1.0 - smoothstep(${f(DETAIL_FADE_M[0])}, ${f(DETAIL_FADE_M[1])}, camD);
  float dl = topCls == ${TERRAIN_SURFACE.grass} ? 1.0 : (topCls == ${TERRAIN_SURFACE.stone} ? 2.0 : 0.0);
  vec4 dd = textureGrad(sroDetail, vec3(duv, dl), dgx, dgy);
  color *= mix(1.0, dd.b * 2.0, 0.5 * dfade);
  nT = vec3(nT.xy + (dd.rg * 2.0 - 1.0) * (0.6 * dfade), nT.z);
#endif
  vec3 alb = toLinearSpace(color);
${tintCall(x)}  vec3 Tw = normalize(vec3(1.0, 0.0, 0.0) - vN * vN.x);
  vec3 Bw = cross(vN, Tw);
  vec3 nW = normalize(Tw * nT.x + Bw * (nT.y * ${f(TERRAIN_NORMAL_GREEN)}) + vN * nT.z);
  sroR0 = 0.0;
${coastPre(x, 'glsl')}#ifdef ${D.wet}
  float wW = ${coastW(x, 'clamp(sroWeather.y, 0.0, 1.0) * shelter')};
  float flatK = smoothstep(0.93, 0.98, vN.y);
  alb *= mix(1.0, 1.0 - 0.5 * cls.y, wW);
  rough = mix(rough, min(rough, cls.z), wW);
  nW = normalize(mix(nW, vN, 0.5 * wW));
  sroR0 = 0.04 + 0.03 * wW * flatK;
#ifdef ${D.puddles}
  vec4 wet4 = textureLod(sroWetMap, (lp / 20.0 + vec2(0.5)) / 97.0, 0.0);
  float hMod = sroNoise(lp * 0.015);
#ifdef ${D.ormh}
  hMod = 1.0 - hAcc;
#endif
  float pot = flatK * cls.w * (0.15 + 0.4 * hMod);
  if (sroRegion.w > 0.5) pot = wet4.r * (0.75 + 0.25 * hMod);
  float pth = ${f(PUDDLE_THRESHOLD[0])} - clamp(sroWeather.z, 0.0, 1.0) * ${f(PUDDLE_THRESHOLD[1])};
  float pm = smoothstep(pth - 0.05, pth + 0.05, pot) * shelter;
  vec2 rip = vec2(0.0);
  float film = 0.0;
#ifdef ${D.ripples}
  float rr = clamp(sroWeather.x, 0.0, 1.0);
  if (rr > 0.001) {
    film = smoothstep(${f(FILM_RAIN[0])}, ${f(FILM_RAIN[1])}, rr) * smoothstep(${f(FILM_WET[0])}, ${f(FILM_WET[1])}, wW) * smoothstep(${f(FILM_FLAT[0])}, ${f(FILM_FLAT[1])}, vN.y) * clamp(cls.w * ${f(FILM_CLASS_GAIN)}, 0.0, 1.0);
    vec2 ru = wp.xz * ${f(TERRAIN_RING_SCALE)};
    vec2 rdx = vec2(gx.x, -gx.y) * ${f(TERRAIN_RING_SCALE / 10)};
    vec2 rdy = vec2(gy.x, -gy.y) * ${f(TERRAIN_RING_SCALE / 10)};
    float tm = sroParams.w;
${ringTaps('glsl', 'sroTRing', 'sroRipple', 'ru', `rdx * ${f(RING_LOD_GRAD)}`, `rdy * ${f(RING_LOD_GRAD)}`, 'tm', 'rr', 'rg', '    ')}    float fp = sqrt(length(rdx) * length(rdy)) / ${f(TERRAIN_RING_SCALE)};
    float ra = max(film, pm * smoothstep(0.0, 0.15, rr)) * (1.0 - smoothstep(${f(RING_FADE_M[0])}, ${f(RING_FADE_M[1])}, fp));
    rip = rg.xy * (${f(TERRAIN_RING_GAIN)} * ra);
    alb *= clamp(1.0 + rg.w * (${f(RING_CONTRAST)} * ra), 0.4, 1.8);
    alb = mix(alb, vec3(${f(RING_CROWN_ALBEDO)}), clamp(rg.z * ra * 0.8, 0.0, 1.0));
  }
#endif
  alb *= mix(1.0, 0.6, pm);
  rough = mix(rough, 0.03, pm);
  rough = mix(rough, min(rough, ${f(FILM_ROUGHNESS)}), film);
  nW = normalize(mix(nW, vN, max(pm, film * 0.7)) + vec3(rip.x, 0.0, rip.y));
  sroR0 = max(sroR0, 0.04 + 0.06 * max(pm, film * 0.6));
#endif
#endif
${coastOnly(x, 'glsl')}  sroAlbedo = alb;
  sroRough = clamp(rough, 0.02, 1.0);
  sroAO = ao;
  sroNormal = nW;
  float lmv = dot(lm, vec3(0.33333334));
  sroBaked = sroParams.x > 0.5 ? clamp((lmv - ${f(TERRAIN_LIGHTMAP_FLOOR)}) / ${f(1 - TERRAIN_LIGHTMAP_FLOOR)}, 0.0, 1.0) : 1.0;
  float csmR = sroParams.z;
  float vz = abs((view * vec4(wp, 1.0)).z);
  sroCsm = csmR > 0.0 ? 1.0 - smoothstep(csmR * 0.8, csmR, vz) : 0.0;
  sroEmit = vec3(0.0);
#ifdef ${D.nightSplat}
  sroEmit = alb * toLinearSpace(sroNightSplat(nightSplat, lp, nlNight.x)) * sroSun.w;
#endif
}
`
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: definitions,
    CUSTOM_FRAGMENT_MAIN_BEGIN: 'sroTerrainEval();',
    CUSTOM_FRAGMENT_UPDATE_ALBEDO: 'surfaceAlbedo = sroAlbedo;',
    CUSTOM_FRAGMENT_UPDATE_ALPHA: 'normalW = sroNormal;',
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: 'metallicRoughness = vec2(0.0, sroRough);',
    [AO_POINT]: '$1\naoOut.ambientOcclusionColor = aoOut.ambientOcclusionColor * sroAO;',
    CUSTOM_LIGHT0_COLOR: `{
  float sroW = clamp(dot(normalize(-light0.vLightData.xyz), sroSun.xyz) * 2.0 - 0.6, 0.0, 1.0);
  float sroV = mix(mix(1.0, sroBaked, max(0.35, sroW)), 1.0, sroCsm) * sroCloud;
  diffuse0 = vec4(diffuse0.rgb * sroV, diffuse0.a);
}`,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: 'finalEmissive += sroEmit;',
    CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `#ifdef PREPASS_REFLECTIVITY
specularEnvironmentR0 = max(specularEnvironmentR0, vec3(sroR0));
#endif`,
  }
}

/** The fragment injection points of one language (tests compare the two key sets). */
export function terrainPluginCode(lang: 'wgsl' | 'glsl', externs: TerrainExterns = defaultTerrainExterns()): TerrainPluginCode {
  return lang === 'wgsl' ? wgslCode(externs) : glslCode(externs)
}

// ---- the plugin's own uniforms and samplers ---------------------------------------------------------------------

/**
 * UBO members (vec4 each):
 * - `sroRegion`  origin x, origin z (glTF m), layer count, 1 when the region's wet map is bound;
 * - `sroTier`    TX-R: the tier cap (layers below it read `sroTilesHi`; 0 = none), the map arrays' depth (layers at or
 *                above it get neutral maps; 1e6 when the arrays span every layer), 0, 0;
 * - `sroParams`  lightmap on, debug view (TERRAIN view 0..4), CSM range (m, 0 = none), time (s, mod 3600);
 * - `sroSun`     BAKED_LIGHT_DIR xyz (to the light), 1 / exposure (the night splat's display → scene-linear scale);
 * - `sroWeather` rain, wetness, puddles, wind (RenderWeather, the same frame as the Classic `wx*`, §2.2).
 */
export const TERRAIN_PLUGIN_UNIFORMS: readonly string[] = ['sroRegion', 'sroParams', 'sroSun', 'sroWeather', 'sroTier']
export const TERRAIN_PLUGIN_SAMPLERS: readonly string[] = ['sroTiles', 'sroLayerMap', 'sroLightmap', 'sroNormals', 'sroOrmh', 'sroDetail', 'sroWetMap', 'sroRipple', 'sroTilesHi']
/** The shared-uniform name of WX-R's ripple texture (D21), bound as `sroRipple`. */
export const RIPPLE_SHARED_NAME = 'wxRipple'

const UNIFORM_SIZE: Record<ExternUniform['type'], number> = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat4: 16 }

// ---- shared state (one per TerrainRenderer) ---------------------------------------------------------------------

/** One region as its plugin binds it (TerrainRenderer keeps these on its GPU record). */
export interface TerrainPbrRegion {
  originX: number
  originZ: number
  layerCount: number
  layerMap: BaseTexture
  lightmap: BaseTexture | null
  /** The region slot textures (wetMap, nightSplat, lightmapExtra), by reference. */
  textures: Partial<Record<string, BaseTexture>>
}

/**
 * The PBR terrain's shared state: textures every region samples, the per-frame vectors, the resolved features and the
 * plugins made against it (for define refreshes). TerrainRenderer owns one.
 */
export class TerrainPbr {
  tiles: BaseTexture | null = null
  normals: BaseTexture | null = null
  ormh: BaseTexture | null = null
  /** TX-R: the tier plane (tile-atlas.ts), sampled for layers below `tierLayers` under SRO_T_TIER. */
  tilesHi: BaseTexture | null = null
  tierLayers = 0
  /** TX-R: the map arrays' depth when they are capped with the tier plane (0: they span every layer). */
  mapLayers = 0
  readonly params = new Vector4(1, 0, 0, 0)
  readonly sun = new Vector4(BAKED_LIGHT_DIR.x, BAKED_LIGHT_DIR.y, BAKED_LIGHT_DIR.z, 1)
  readonly weather = new Vector4(0, 0, 0, 0)
  readonly plugins = new Set<SroTerrainPlugin>()
  readonly externs: TerrainExterns
  private featuresValue: TerrainFeatures = { ...NO_TERRAIN_FEATURES }
  private keyValue = featureKey(NO_TERRAIN_FEATURES)
  private detailTex: BaseTexture | null = null
  private blackTex: BaseTexture | null = null
  private whiteTex: BaseTexture | null = null
  private readonly code = new Map<string, TerrainPluginCode>()
  /** The defines the externs' sources test (not the plugin's own): mirrored from `laneDefines`. */
  readonly externDefines: readonly string[]
  private laneMask = 0

  constructor(
    readonly scene: Scene,
    readonly shared: ReadonlyMap<string, SharedValue>,
    externs?: TerrainExterns,
    /** The terrain's define set (TerrainRenderer.setDefine): the lanes' `WX_OCC8` and friends. */
    readonly laneDefines: { has(name: string): boolean } | null = null,
  ) {
    this.externs = externs ?? defaultTerrainExterns()
    const own = new Set(Object.values(TERRAIN_FEATURE_DEFINES))
    const names = new Set<string>()
    for (const e of [this.externs.shelter, this.externs.cloudShadow, this.externs.nightSplat, this.externs.coastWet, this.externs.grassTint]) {
      for (const d of e?.defines ?? []) if (!own.has(d)) names.add(d)
    }
    this.externDefines = [...names]
    this.laneMask = this.maskOf()
  }

  get features(): Readonly<TerrainFeatures> {
    return this.featuresValue
  }

  /** Whether a mirrored lane define is on. */
  laneDefine(name: string): boolean {
    return !!this.laneDefines?.has(name)
  }

  /** A lane define changed (TerrainRenderer.setDefine): recompile the regions when an extern tests it. */
  laneDefinesChanged(): void {
    const m = this.maskOf()
    if (m === this.laneMask) return
    this.laneMask = m
    for (const p of this.plugins) p.markAllDefinesAsDirty()
  }

  private maskOf(): number {
    let m = 0
    this.externDefines.forEach((d, i) => {
      if (this.laneDefine(d)) m |= 1 << i
    })
    return m
  }

  /** Which externs have a usable source. */
  get externsAvailable(): { shelter: boolean; cloudShadow: boolean; nightSplat: boolean; coastWet: boolean; grassTint: boolean } {
    const x = this.externs
    return { shelter: !!x.shelter, cloudShadow: !!x.cloudShadow, nightSplat: !!x.nightSplat, coastWet: !!x.coastWet, grassTint: !!x.grassTint }
  }

  /** Sets the features; a change marks every plugin's defines dirty (one recompile per region). True when changed. */
  setFeatures(f: Readonly<TerrainFeatures>): boolean {
    const key = featureKey(f)
    if (key === this.keyValue) return false
    this.keyValue = key
    this.featuresValue = { ...f }
    for (const p of this.plugins) p.markAllDefinesAsDirty()
    return true
  }

  /** The injection points of a language (built once per language). */
  codeFor(lang: 'wgsl' | 'glsl'): TerrainPluginCode {
    let c = this.code.get(lang)
    if (!c) this.code.set(lang, (c = terrainPluginCode(lang, this.externs)))
    return c
  }

  /** The procedural detail array (soil, grass, rock), made on first use. */
  get detail(): BaseTexture {
    return (this.detailTex ??= createDetailTexture(this.scene))
  }

  /** 1 × 1 black (an unbound optional sampler). */
  get black(): BaseTexture {
    return (this.blackTex ??= solid(this.scene, [0, 0, 0, 255], 'terrainPbrBlack'))
  }

  /** 1 × 1 white (a region without a lightmap). */
  get white(): BaseTexture {
    return (this.whiteTex ??= solid(this.scene, [255, 255, 255, 255], 'terrainPbrWhite'))
  }

  /** A region's PBR material with its plugin (the caller assigns it to the mesh and disposes both with the region). */
  createMaterial(name: string, region: TerrainPbrRegion): { material: PBRMaterial; plugin: SroTerrainPlugin } {
    const material = useWindowedLightFalloff(new PBRMaterial(name, this.scene))
    material.metallic = 0
    material.roughness = 0.85
    material.albedoColor.set(1, 1, 1)
    material.backFaceCulling = true
    const plugin = new SroTerrainPlugin(material, this, region)
    return { material, plugin }
  }

  dispose(): void {
    for (const p of [...this.plugins]) p.detach()
    this.detailTex?.dispose()
    this.blackTex?.dispose()
    this.whiteTex?.dispose()
    this.detailTex = this.blackTex = this.whiteTex = null
    this.tiles = this.normals = this.ormh = this.tilesHi = null
  }
}

function solid(scene: Scene, rgba: [number, number, number, number], name: string): RawTexture {
  const t = RawTexture.CreateRGBATexture(new Uint8Array(rgba), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE)
  t.name = name
  return t
}

// ---- the plugin -------------------------------------------------------------------------------------------------

type Defines = MaterialDefines & Record<string, boolean>

/** The state of the plugin being constructed (MaterialPluginBase asks for the code before the subclass fields exist). */
let constructing: TerrainPbr | null = null

export class SroTerrainPlugin extends MaterialPluginBase {
  readonly state!: TerrainPbr
  readonly region!: TerrainPbrRegion
  private attached!: boolean

  constructor(material: PBRMaterial, state: TerrainPbr, region: TerrainPbrRegion) {
    const defines: Record<string, boolean> = { SROTERRAIN: false }
    for (const d of Object.values(TERRAIN_FEATURE_DEFINES)) defines[d] = false
    for (const d of state.externDefines) defines[d] = false
    constructing = state
    super(material, SRO_TERRAIN_PLUGIN, 200, defines, true, true)
    constructing = null
    this.state = state
    this.region = region
    this.attached = true
    state.plugins.add(this)
  }

  /** The shared state, also while the base constructor runs. */
  private get st(): TerrainPbr {
    return this.state ?? constructing!
  }

  override getClassName(): string {
    return SRO_TERRAIN_PLUGIN
  }

  override isCompatible(): boolean {
    return true
  }

  /** Stops following the shared state (the material is being disposed). */
  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.state.plugins.delete(this)
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.detach()
    super.dispose(forceDisposeTextures)
  }

  override prepareDefines(defines: Defines): void {
    defines.SROTERRAIN = true
    const feats = this.st.features
    for (const k of TERRAIN_FEATURES) defines[TERRAIN_FEATURE_DEFINES[k]] = feats[k]
    for (const d of this.st.externDefines) defines[d] = this.st.laneDefine(d)
  }

  // The UBO layout is built once per material, so every available extern's uniforms and samplers are declared even
  // while its define is off (their code sits behind the define); binding follows the features.
  override getSamplers(samplers: string[]): void {
    samplers.push(...TERRAIN_PLUGIN_SAMPLERS)
    for (const e of this.externList(true)) for (const s of e.samplers) if (!samplers.includes(s)) samplers.push(s)
  }

  override getUniforms(lang?: ShaderLanguage): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    const ubo = TERRAIN_PLUGIN_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' }))
    for (const e of this.externList(true)) {
      for (const u of e.uniforms) if (!ubo.some(x => x.name === u.name)) ubo.push({ name: u.name, size: UNIFORM_SIZE[u.type], type: u.type })
    }
    return {
      ubo,
      fragment: lang === ShaderLanguage.WGSL ? '' : ubo.map(u => `uniform ${u.type} ${u.name};`).join('\n'),
    }
  }

  override getCustomCode(shaderType: string, lang?: ShaderLanguage): TerrainPluginCode | null {
    if (shaderType !== 'fragment') return null
    return this.st.codeFor(lang === ShaderLanguage.WGSL ? 'wgsl' : 'glsl')
  }

  override bindForSubMesh(ubo: UniformBuffer, scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const s = this.state
    const r = this.region
    const f = s.features
    const wetMap = r.textures.wetMap ?? null
    ubo.updateFloat4('sroRegion', r.originX, r.originZ, r.layerCount, wetMap ? 1 : 0)
    ubo.updateFloat4('sroParams', s.params.x, s.params.y, csmRange(subMesh, scene), s.params.w)
    ubo.updateVector4('sroSun', s.sun)
    ubo.updateVector4('sroWeather', s.weather)
    ubo.updateFloat4('sroTier', f.tier && s.tilesHi ? s.tierLayers : 0, s.mapLayers > 0 ? s.mapLayers : 1e6, 0, 0)
    if (s.tiles) ubo.setTexture('sroTiles', s.tiles)
    ubo.setTexture('sroLayerMap', r.layerMap)
    ubo.setTexture('sroLightmap', r.lightmap ?? s.white)
    if (f.normals && s.normals) ubo.setTexture('sroNormals', s.normals)
    if (f.ormh && s.ormh) ubo.setTexture('sroOrmh', s.ormh)
    if (f.tier && s.tilesHi) ubo.setTexture('sroTilesHi', s.tilesHi)
    if (f.detail) ubo.setTexture('sroDetail', s.detail)
    if (f.wet) ubo.setTexture('sroWetMap', wetMap ?? s.black)
    if (f.ripples) ubo.setTexture('sroRipple', textureOf(s.shared.get(RIPPLE_SHARED_NAME)) ?? s.black)
    for (const e of this.externList()) {
      for (const u of e.uniforms) bindUniform(ubo, u, s.shared.get(u.name))
      for (const name of e.samplers) ubo.setTexture(name, r.textures[name] ?? textureOf(s.shared.get(name)) ?? s.black)
    }
  }

  override getActiveTextures(active: BaseTexture[]): void {
    const s = this.state
    for (const t of [s.tiles, s.tilesHi, this.region.layerMap, this.region.lightmap]) if (t) active.push(t)
  }

  override hasTexture(texture: BaseTexture): boolean {
    return texture === this.region.layerMap || texture === this.region.lightmap
  }

  /** The externs switched on in the current features (all: every available one). */
  private externList(all = false): TerrainExtern[] {
    const x = this.st.externs
    const f = this.st.features
    const out: TerrainExtern[] = []
    if (x.shelter && (all || f.shelter)) out.push(x.shelter)
    if (x.cloudShadow && (all || f.cloudShadow)) out.push(x.cloudShadow)
    if (x.nightSplat && (all || f.nightSplat)) out.push(x.nightSplat)
    if (x.coastWet && (all || f.coastWet)) out.push(x.coastWet)
    if (x.grassTint && (all || f.grassTint)) out.push(x.grassTint)
    return out
  }
}

function textureOf(v: SharedValue | undefined): BaseTexture | null {
  return v && typeof v === 'object' && 'getInternalTexture' in v ? (v as BaseTexture) : null
}

function bindUniform(ubo: UniformBuffer, u: ExternUniform, v: SharedValue | undefined): void {
  if (v === undefined || textureOf(v)) return
  if (u.type === 'mat4') {
    if ('m' in (v as object)) ubo.updateMatrix(u.name, v as never)
    return
  }
  const o = v as { x?: number; y?: number; z?: number; w?: number } | number[]
  if (Array.isArray(o)) {
    ubo.updateFloat4(u.name, o[0] ?? 0, o[1] ?? 0, o[2] ?? 0, o[3] ?? 0)
    return
  }
  const x = o.x ?? 0, y = o.y ?? 0, z = o.z ?? 0, w = o.w ?? 0
  if (u.type === 'float') ubo.updateFloat(u.name, x)
  else if (u.type === 'vec2') ubo.updateFloat2(u.name, x, y)
  else if (u.type === 'vec3') ubo.updateFloat3(u.name, x, y, z)
  else ubo.updateFloat4(u.name, x, y, z, w)
}

/** Light 0's CSM range (m) when the mesh receives its shadows (0 = none: the baked shadows apply everywhere). */
function csmRange(subMesh: SubMesh, scene: Scene): number {
  const mesh = subMesh.getMesh()
  if (!mesh.receiveShadows || !scene.shadowsEnabled) return 0
  const light = mesh.lightSources[0]
  if (!light || !light.shadowEnabled) return 0
  const gen = light.getShadowGenerator(scene.activeCamera) as { getClassName?: () => string; shadowMaxZ?: number } | null
  if (!gen || gen.getClassName?.() !== 'CascadedShadowGenerator') return 0
  const z = gen.shadowMaxZ ?? 0
  return z > 0 ? z : (scene.activeCamera?.maxZ ?? 0)
}

// ---- the procedural detail layer (RENDER §6.2 item 5) -----------------------------------------------------------

/** Edge (px) of the detail layers: 1.5 m per repeat → 170 px/m. */
export const DETAIL_SIZE = 256

/**
 * Three tileable detail layers, RGBA8 (RG = tangent-space normal xy, B = luminance around 0.5, A = 255): 0 soil (grain
 * and pebbles), 1 grass (fine blades along one axis), 2 rock (ridged cracks). Our own procedural art, deterministic.
 */
export function makeDetailLayers(size = DETAIL_SIZE): Uint8Array[] {
  const hash = (x: number, y: number, s: number): number => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295
  }
  // Periodic value noise with `cells` lattice cells over the tile (cells divides size).
  const noise = (x: number, y: number, cells: number, seed: number): number => {
    const fx = (x / size) * cells, fy = (y / size) * cells
    const ix = Math.floor(fx), iy = Math.floor(fy)
    const ux = fx - ix, uy = fy - iy
    const sx = ux * ux * (3 - 2 * ux), sy = uy * uy * (3 - 2 * uy)
    const w = (i: number) => ((i % cells) + cells) % cells
    const a = hash(w(ix), w(iy), seed), b = hash(w(ix + 1), w(iy), seed)
    const c = hash(w(ix), w(iy + 1), seed), d = hash(w(ix + 1), w(iy + 1), seed)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
  const fbm = (x: number, y: number, base: number, oct: number, seed: number, ridged = false): number => {
    let v = 0, amp = 0.5, total = 0
    for (let o = 0; o < oct; o++) {
      let n = noise(x, y, base << o, seed + o * 17)
      if (ridged) n = 1 - Math.abs(n * 2 - 1)
      v += n * amp
      total += amp
      amp *= 0.5
    }
    return v / total
  }
  const heights: Float32Array[] = [new Float32Array(size * size), new Float32Array(size * size), new Float32Array(size * size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      // soil: fine grain + scattered pebbles
      const grain = fbm(x, y, 16, 4, 11)
      const peb = Math.max(0, fbm(x, y, 8, 2, 23) - 0.62) * 3
      heights[0]![i] = grain * 0.7 + peb * 0.6
      // grass: streaks along v (anisotropic: stretched lattice), plus soft clumps
      const blades = noise(x, y * 0.125, 64, 31) * 0.6 + noise(x, y * 0.25, 32, 37) * 0.4
      heights[1]![i] = blades * 0.75 + fbm(x, y, 4, 2, 41) * 0.25
      // rock: ridged cracks
      heights[2]![i] = fbm(x, y, 4, 5, 53, true)
    }
  }
  const strength = [2.5, 1.8, 4]
  return heights.map((h, k) => {
    let mean = 0
    for (const v of h) mean += v
    mean /= h.length
    const out = new Uint8Array(size * size * 4)
    const at = (x: number, y: number) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)]!
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength[k]!
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength[k]!
        const len = Math.hypot(dx, dy, 1)
        const o = (y * size + x) * 4
        // Tangent normal (−dh/du, −dh/dv, 1); u = +X, v = +Z (row + 1) for the detail uv (world xz / period). The
        // shader maps G through TERRAIN_NORMAL_GREEN and its +v axis (−Z for the tiles), so G is stored pre-flipped.
        out[o] = Math.round((-dx / len * 0.5 + 0.5) * 255)
        out[o + 1] = Math.round((dy / len * TERRAIN_NORMAL_GREEN * 0.5 + 0.5) * 255)
        out[o + 2] = Math.max(0, Math.min(255, Math.round((0.5 + (at(x, y) - mean) * 0.9) * 255)))
        out[o + 3] = 255
      }
    }
    return out
  })
}

function createDetailTexture(scene: Scene): BaseTexture {
  // textures.ts builds every layer's mip chain on both engines (NullEngine: a placeholder).
  return createTextureArray(scene, makeDetailLayers(), DETAIL_SIZE, 'terrainDetail')
}
