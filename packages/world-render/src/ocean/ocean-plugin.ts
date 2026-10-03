/**
 * Portions ported from Tidewater (github.com/dgreenheck/tidewater, `WaterSurface.js` at `4811ba4`), MIT licence, Copyright (c)
 * 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.
 *
 * `SroOceanPlugin`: the ocean on the PBR presets (docs/COAST.md §8.2, §8.5, §8.6), a MaterialPluginBase on a
 * PBRMaterial, in WGSL and GLSL at the same injection points (no GLSL ever reaches the WebGPU engine: the plugin hands
 * Babylon the language it asks for). Babylon's PBR already does what Tidewater writes by hand (the environment
 * reflection with Fresnel, the key light's GGX glint and its shadows); the plugin supplies the inputs
 * (`WaterSurface.js` and `WaterMaterial.js`'s parts):
 *
 * - **Vertex** (`CUSTOM_VERTEX_UPDATE_POSITION`): the CDLOD placement and morph (cdlod.ts; the per-node record is the
 *   thin-instance attribute `cdlodNode` = x, z, size, lod; the instance matrices stay identity), the coast field at the
 *   rest position, the summed cascades with the per-cascade shallow-water attenuation (§8.5) and band-limiting (each
 *   cascade sampled at mip `max(log2(spacing / texel) + 0.7, 0)`, explicit-level taps only, F14), the shore seam's
 *   vertex code, then the world position. One packed varying, `vSroOcean` = (rest x, rest z, vertex foam, swash)
 *   (§8.6's one-vec4 rule).
 * - **Fragment** (`CUSTOM_FRAGMENT_MAIN_BEGIN`, uniform control flow, so plain `textureSample` taps are allowed, F14):
 *   the field again (per pixel), the slopes of every weighted cascade at the rest position (`∂Dy/∂x / (1 + ∂Dx/∂x)`,
 *   …), RND-W's two world-space normal-map layers and, in rain, WX-R's ripple rings; the Jacobian whitecaps; the
 *   shore seam's fragment code; the mask (the sea is discarded where the field has no water: the town below the sea
 *   level, the retail water it joins); facets whose reflection would dip under the horizon are bent to grazing
 *   (`WaterMaterial.js`); the roughness from Cox–Munk's unresolved slope (`α² = α0² + 2 mss · unresolved + 0.2 foam`,
 *   `mss = 0.003 + 0.00512 U`); the colour and the alpha from the water column (field B on every preset, R4): alpha
 *   = 1 − the mean transmittance `exp(−σt · path)`, and the albedo is Gordon's `R = 0.33 bb / (a + bb)` per channel,
 *   tinted by the per-channel transmittance, so the diffuse PBR light is the light scattered up from inside the
 *   water; foam is a diffuse scatterer (albedo 0.85, opaque).
 * - **Join** (§8.1, §8.5, F6): within 64 m of a retail water block at the sea level (field A) the waves and swash fade
 *   to 0 and the colour, alpha, normal layers and roughness become RND-W's water's own (the same `WaterPbrState`, its
 *   frame array and normal texture, its albedo formula), so the bay mouth joins flat.
 * - `CUSTOM_FRAGMENT_UPDATE_ALBEDO` / `_ALPHA` / `_METALLICROUGHNESS`: the albedo, the alpha and the normal, the
 *   roughness; `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION`: the crest translucency (crests lit from behind glow
 *   green-blue in proportion to their height, (0.12, 0.55, 0.45) × 0.06).
 *
 * The height fog (SroFogPlugin) attaches itself to this material like to every PBR material of a fogged scene, and
 * runs after it. Defines: `SRO_OCEAN` (the wave array and the field are bound), `SRO_OCEAN_LERP` (the worker tile: two
 * ticks, interpolated), `SRO_OCEAN_C4` (four cascades), `SRO_OCEAN_RIPPLE` (rain), `SRO_OCEAN_SHORE` (the shore seam,
 * shore-seam.ts). No uniform or sampler name is shared with another plugin (all start with `sroOc` / `sroShore`).
 */
import {
  Color3,
  MaterialPluginBase,
  PBRMaterial,
  ShaderLanguage,
  Vector4,
  type AbstractEngine,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import { WATER_ALBEDO_WEIGHT, WATER_FRAME_REPEAT_M, WATER_NORMAL_LAYERS, WATER_SHORE_M } from '../pbr/water-plugin.ts'
import { useWindowedLightFalloff } from '../render/babylon-fixes.ts'
import { rainRingCode, ringTaps } from '../weather/ripples.ts'
import { SHORE_FRAGMENT, SHORE_SAMPLERS, SHORE_UNIFORMS, SHORE_VERTEX } from '../shore/chunks.ts'
import { CDLOD_MORPH_START } from './cdlod.ts'
import { FIELD_DIST_STEP_M, FIELD_HEIGHT_RANGE_M, lowLandFloorCode, SWASH_BAND_M, SWASH_HEIGHT_M } from './field.ts'
import { SHORE_DEFINE, shoreHasCode, type ShoreBinder, type ShorePart } from './shore-seam.ts'

export const SRO_OCEAN_PLUGIN = 'SroOceanPlugin'
/** The thin-instance attribute holding a CDLOD node (x, z, size, lod). */
export const CDLOD_ATTRIBUTE = 'cdlodNode'
/** The one packed varying (rest x, rest z, vertex foam, swash). */
export const OCEAN_VARYING = 'vSroOcean'

/** The ocean's vec4 uniforms (see OceanPbrState). */
export const OCEAN_UNIFORMS = [
  'sroOcA', 'sroOcS', 'sroOcCam', 'sroOcLat', 'sroOcT', 'sroOcK0', 'sroOcK1', 'sroOcK2', 'sroOcK3', 'sroOcW',
  'sroOcFieldXf', 'sroOcIopA', 'sroOcIopS', 'sroOcSun', 'sroOcRough', 'sroOcWA', 'sroOcWB', 'sroOcWC', 'sroOcHorizon',
  'sroOcZenith',
] as const
/** The ocean's samplers: the wave array (both stages), the field (both), RND-W's normal map and frames, the ripples. */
export const OCEAN_SAMPLERS = ['sroOcWaves', 'sroOcFieldMap', 'sroOcNormal', 'sroOcFrames', 'sroOcRipple'] as const

/** Deep-water crest glow (Tidewater): the colour × 0.06 per metre of crest height, lit from behind. */
export const CREST_GLOW: readonly [number, number, number] = [0.12 * 0.06, 0.55 * 0.06, 0.45 * 0.06]
/** Cox–Munk: the base roughness α0 and the mean square slope per m/s of wind. */
export const ROUGH_ALPHA0 = 0.035
export const MSS_BASE = 0.003
export const MSS_PER_MS = 0.00512
/** The water column's path is clamped here (m). */
export const PATH_MAX_M = 60
/** Water's normal-incidence reflectance (IOR 1.333: ((n − 1) / (n + 1))² ≈ 0.02). */
export const WATER_F0 = 0.02
/** The detail normal (RND-W's layers) on the open sea, relative to the retail water's (P-LOOK: 0.5 → 0.7). */
export const DETAIL_AMP = 0.7
/**
 * Rain rings on the sea (wave 12 RAIN-P; weather/ripples.ts `rainRingCode`): ripple-texture repeats per metre (a 2.9 m
 * tile, rings up to 26 cm: the sea is seen from farther than a puddle), the slope gain at full strength, the camera
 * distance (m) over which they fade, and the foam a drop's impact crown makes (a white fleck). Tried 0.25 (a 4 m tile,
 * 36 cm rings): a little more legible 20 m out, but visibly sparser than the reference photo's rain; kept 0.35.
 */
export const OCEAN_RING_SCALE = 0.35
export const OCEAN_RING_GAIN = 1.0
export const OCEAN_RING_FADE_M: readonly [number, number] = [40, 90]
export const OCEAN_CROWN_FOAM = 0.75
/** The rings' glint: a crest adds this × the sky colour the sea mirrors (sroOcZenith/Horizon), as the water's glint. */
export const OCEAN_RING_GLINT = 0.35
/**
 * The ring lines: a crest becomes foam (the sea's own white scatterer, opaque) at this × its height, so the rings read
 * on the shallow, nearly transparent swash as well as on the open sea.
 */
export const OCEAN_RING_LINE = 0.4

/** Default inherent optical properties (per metre): absorption and scattering by channel (tuned by eye). */
export const IOP_ABSORPTION: readonly [number, number, number] = [0.35, 0.066, 0.036]
export const IOP_SCATTERING: readonly [number, number, number] = [0.03, 0.04, 0.05]
/** Backscatter fraction: 70 % Henyey–Greenstein g 0.86 particles (~3 % back) + 30 % isotropic (50 %). */
export const IOP_BACKSCATTER = 0.7 * 0.03 + 0.3 * 0.5

/** Gordon's sub-surface reflectance per channel (the deep-water albedo). */
export function deepAlbedo(a: readonly number[] = IOP_ABSORPTION, s: readonly number[] = IOP_SCATTERING): [number, number, number] {
  return [0, 1, 2].map(c => (0.33 * s[c]! * IOP_BACKSCATTER) / (a[c]! + s[c]! * IOP_BACKSCATTER)) as [number, number, number]
}

/** The shader's water alpha and albedo for a path length (m), in TS (tests; the CPU colour of the sea). */
export function waterColour(pathM: number, a: readonly number[] = IOP_ABSORPTION, s: readonly number[] = IOP_SCATTERING): { alpha: number; albedo: [number, number, number] } {
  const p = Math.min(PATH_MAX_M, Math.max(0, pathM))
  const t = [0, 1, 2].map(c => Math.exp(-(a[c]! + s[c]!) * p))
  const alpha = 1 - (t[0]! + t[1]! + t[2]!) / 3
  const r = deepAlbedo(a, s)
  return { alpha, albedo: [0, 1, 2].map(c => (r[c]! * (1 - t[c]!)) / Math.max(alpha, 1e-3)) as [number, number, number] }
}

/**
 * RND-W's albedo in the join zone (pbr/water-plugin.ts's formula, with its constants): the retail frame × the water
 * colour at 60 %, linearised, darkened toward the deep multiplier over 4 m (the High+ depth shore; Medium's retail
 * alpha is full at 3 m and darkens with it).
 */
export function joinAlbedo(frame: readonly number[], hue: readonly number[], deep: readonly number[], depthM: number, depthShore: boolean): { albedo: [number, number, number]; alpha: number } {
  const shallow = [0, 1, 2].map(c => Math.pow(Math.min(1, Math.max(0, frame[c]! * hue[c]!)), 2.2) * WATER_ALBEDO_WEIGHT)
  const d = depthShore ? Math.min(1, Math.max(0, depthM / 4)) : Math.min(1, Math.max(0, Math.trunc(depthM * 5) / 15))
  const albedo = [0, 1, 2].map(c => shallow[c]! + (shallow[c]! * deep[c]! - shallow[c]!) * d) as [number, number, number]
  const alpha = depthShore ? Math.min(1, Math.max(0, depthM / WATER_SHORE_M)) : Math.min(1, Math.max(0, Math.trunc(depthM * 5) / 15))
  return { albedo, alpha }
}

// ---- shader code --------------------------------------------------------------------------------------------------

export type Lang = 'wgsl' | 'glsl'
const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v))
const L0 = WATER_NORMAL_LAYERS[0], L1 = WATER_NORMAL_LAYERS[1]
const MORPH_K = 0.5 + 0.5 * CDLOD_MORPH_START

/** Per cascade c: `K`: (1/L, texel m, d0, floor); the foam weight is sroOcW[c]. */
function cascades(lang: Lang, body: (c: number, k: string, w: string) => string): string {
  const w = lang === 'wgsl'
  const u = (n: string) => (w ? `uniforms.${n}` : n)
  const one = (c: number) => body(c, u(`sroOcK${c}`), `${u('sroOcW')}.${'xyzw'[c]}`)
  return `${one(0)}${one(1)}#ifdef SRO_OCEAN_C4\n${one(2)}${one(3)}#endif\n`
}

export function shoreCode(lang: Lang, stage: 'vertex' | 'fragment', part: 'definitions' | 'main'): string {
  const src = (stage === 'vertex' ? SHORE_VERTEX : SHORE_FRAGMENT)[lang][part]
  return src ? `#ifdef ${SHORE_DEFINE}\n${src}\n#endif\n` : ''
}

export const COMMON_WGSL = `fn sroOcDecode(t: vec4f) -> vec4f {
  let s = (t.b * 255.0 - 128.0) / 127.0;
  return vec4f(t.r, (t.g * 255.0 - 128.0) * ${f(FIELD_DIST_STEP_M)}, sign(s) * s * s * ${f(FIELD_HEIGHT_RANGE_M)}, t.a);
}
fn sroOcAtten(k: vec4f, depth: f32, join: f32) -> f32 {
  return mix(k.w * smoothstep(0.0, 0.6, depth), 1.0, smoothstep(0.0, k.z, depth)) * (1.0 - join);
}
`
export const COMMON_GLSL = `vec4 sroOcDecode(vec4 t) {
  float s = (t.b * 255.0 - 128.0) / 127.0;
  return vec4(t.r, (t.g * 255.0 - 128.0) * ${f(FIELD_DIST_STEP_M)}, sign(s) * s * s * ${f(FIELD_HEIGHT_RANGE_M)}, t.a);
}
float sroOcAtten(vec4 k, float depth, float join) {
  return mix(k.w * smoothstep(0.0, 0.6, depth), 1.0, smoothstep(0.0, k.z, depth)) * (1.0 - join);
}
`

function vertexDefinitions(lang: Lang): string {
  if (lang === 'wgsl') {
    return `#ifdef SRO_OCEAN
attribute ${CDLOD_ATTRIBUTE}: vec4f;
varying ${OCEAN_VARYING}: vec4f;
var sroOcWaves: texture_2d_array<f32>;
var sroOcWavesSampler: sampler;
var sroOcFieldMap: texture_2d<f32>;
var sroOcFieldMapSampler: sampler;
var<private> sroOcRest: vec2f;
var<private> sroOcField: vec4f;
var<private> sroOcPos: vec3f;
var<private> sroOcFoam: f32;
var<private> sroOcSwash: f32;
${COMMON_WGSL}${shoreCode('wgsl', 'vertex', 'definitions')}#endif
`
  }
  return `#ifdef SRO_OCEAN
attribute vec4 ${CDLOD_ATTRIBUTE};
varying vec4 ${OCEAN_VARYING};
uniform highp sampler2DArray sroOcWaves;
uniform sampler2D sroOcFieldMap;
vec2 sroOcRest;
vec4 sroOcField;
vec3 sroOcPos;
float sroOcFoam;
float sroOcSwash;
${COMMON_GLSL}${shoreCode('glsl', 'vertex', 'definitions')}#endif
`
}

/**
 * The CDLOD placement and morph of a grid vertex, then the coast field at its rest position (both ocean materials):
 * declares `sroNode`, `sroSpacing`, `sroK`, `sroSL`, `sroDepth`, `sroEff` and sets `sroOcRest`, `sroOcField`.
 * `pos` is the grid vertex (x, z in [0, 1]).
 */
export function oceanMorphCode(lang: Lang, pos: string): string {
  if (lang === 'wgsl') {
    return `  let sroNode = vertexInputs.${CDLOD_ATTRIBUTE};
  let sroOrg = uniforms.sroOcLat.xy;
  let sroRange = uniforms.sroOcLat.z * exp2(sroNode.w) * uniforms.sroOcLat.w;
  let sroSpacing = uniforms.sroOcLat.z * exp2(sroNode.w) / uniforms.sroOcCam.w;
  var sroP = sroNode.xy + ${pos}.xz * sroNode.z - sroOrg;
  sroP = floor(sroP / sroSpacing + vec2f(0.25)) * sroSpacing;
  let sroSL = uniforms.sroOcA.x;
  let sroD = distance(uniforms.sroOcCam.xyz, vec3f(sroP.x + sroOrg.x, sroSL, sroP.y + sroOrg.y));
  let sroStart = select(sroRange * ${f(MORPH_K)}, sroRange * ${f(CDLOD_MORPH_START)}, sroNode.w < 0.5);
  let sroK = clamp((sroD - sroStart) / max(sroRange - sroStart, 1e-3), 0.0, 1.0);
  sroP = sroP - fract(sroP / (2.0 * sroSpacing)) * (2.0 * sroSpacing * sroK);
  sroOcRest = sroP + sroOrg;
  sroOcField = sroOcDecode(textureSampleLevel(sroOcFieldMap, sroOcFieldMapSampler, sroOcRest * uniforms.sroOcFieldXf.xy + uniforms.sroOcFieldXf.zw, 0.0));
  let sroDepth = max(-sroOcField.z, 0.0);
  let sroEff = sroSpacing * (1.0 + sroK);
`
  }
  return `  vec4 sroNode = ${CDLOD_ATTRIBUTE};
  vec2 sroOrg = sroOcLat.xy;
  float sroRange = sroOcLat.z * exp2(sroNode.w) * sroOcLat.w;
  float sroSpacing = sroOcLat.z * exp2(sroNode.w) / sroOcCam.w;
  vec2 sroP = sroNode.xy + ${pos}.xz * sroNode.z - sroOrg;
  sroP = floor(sroP / sroSpacing + vec2(0.25)) * sroSpacing;
  float sroSL = sroOcA.x;
  float sroD = distance(sroOcCam.xyz, vec3(sroP.x + sroOrg.x, sroSL, sroP.y + sroOrg.y));
  float sroStart = sroNode.w < 0.5 ? sroRange * ${f(CDLOD_MORPH_START)} : sroRange * ${f(MORPH_K)};
  float sroK = clamp((sroD - sroStart) / max(sroRange - sroStart, 1e-3), 0.0, 1.0);
  sroP = sroP - fract(sroP / (2.0 * sroSpacing)) * (2.0 * sroSpacing * sroK);
  sroOcRest = sroP + sroOrg;
  sroOcField = sroOcDecode(textureLod(sroOcFieldMap, sroOcRest * sroOcFieldXf.xy + sroOcFieldXf.zw, 0.0));
  float sroDepth = max(-sroOcField.z, 0.0);
  float sroEff = sroSpacing * (1.0 + sroK);
`
}

function vertexMain(lang: Lang): string {
  if (lang === 'wgsl') {
    const tap = (layer: string, uv: string, lod: string) => `textureSampleLevel(sroOcWaves, sroOcWavesSampler, ${uv}, i32(${layer} + 0.5), ${lod})`
    return `#ifdef SRO_OCEAN
{
${oceanMorphCode('wgsl', 'positionUpdated')}  var sroDisp = vec3f(0.0);
  var sroFoamV = 0.0;
${cascades('wgsl', (c, k, w) => `  {
    let sroUv = sroOcRest * ${k}.x;
    let sroLod = max(log2(sroEff / ${k}.y) + 0.7, 0.0);
    var sroA = ${tap(`uniforms.sroOcT.y + ${f(c)}`, 'sroUv', 'sroLod')};
#ifdef SRO_OCEAN_LERP
    sroA = mix(sroA, ${tap(`uniforms.sroOcT.z + ${f(c)}`, 'sroUv', 'sroLod')}, uniforms.sroOcT.x);
#endif
    let sroWt = sroOcAtten(${k}, sroDepth, sroOcField.w);
    sroDisp = sroDisp + sroA.xyz * sroWt;
    sroFoamV = sroFoamV + sroA.w * ${w} * sroWt;
  }
`)}  sroOcPos = vec3f(sroOcRest.x + sroDisp.x, sroSL + sroDisp.y, sroOcRest.y + sroDisp.z);
  sroOcFoam = sroFoamV;
  sroOcSwash = 0.0;
${shoreCode('wgsl', 'vertex', 'main')}  positionUpdated = sroOcPos;
  vertexOutputs.${OCEAN_VARYING} = vec4f(sroOcRest, sroOcFoam, sroOcSwash);
}
#endif
`
  }
  const tap = (layer: string, uv: string, lod: string) => `textureLod(sroOcWaves, vec3(${uv}, floor(${layer} + 0.5)), ${lod})`
  return `#ifdef SRO_OCEAN
{
${oceanMorphCode('glsl', 'positionUpdated')}  vec3 sroDisp = vec3(0.0);
  float sroFoamV = 0.0;
${cascades('glsl', (c, k, w) => `  {
    vec2 sroUv = sroOcRest * ${k}.x;
    float sroLod = max(log2(sroEff / ${k}.y) + 0.7, 0.0);
    vec4 sroA = ${tap(`sroOcT.y + ${f(c)}`, 'sroUv', 'sroLod')};
#ifdef SRO_OCEAN_LERP
    sroA = mix(sroA, ${tap(`sroOcT.z + ${f(c)}`, 'sroUv', 'sroLod')}, sroOcT.x);
#endif
    float sroWt = sroOcAtten(${k}, sroDepth, sroOcField.w);
    sroDisp += sroA.xyz * sroWt;
    sroFoamV += sroA.w * ${w} * sroWt;
  }
`)}  sroOcPos = vec3(sroOcRest.x + sroDisp.x, sroSL + sroDisp.y, sroOcRest.y + sroDisp.z);
  sroOcFoam = sroFoamV;
  sroOcSwash = 0.0;
${shoreCode('glsl', 'vertex', 'main')}  positionUpdated = sroOcPos;
  ${OCEAN_VARYING} = vec4(sroOcRest, sroOcFoam, sroOcSwash);
}
#endif
`
}

function fragmentDefinitions(lang: Lang): string {
  if (lang === 'wgsl') {
    return `#ifdef SRO_OCEAN
varying ${OCEAN_VARYING}: vec4f;
var sroOcWaves: texture_2d_array<f32>;
var sroOcWavesSampler: sampler;
var sroOcFieldMap: texture_2d<f32>;
var sroOcFieldMapSampler: sampler;
var sroOcNormal: texture_2d<f32>;
var sroOcNormalSampler: sampler;
var sroOcFrames: texture_2d_array<f32>;
var sroOcFramesSampler: sampler;
#ifdef SRO_OCEAN_RIPPLE
var sroOcRipple: texture_2d<f32>;
var sroOcRippleSampler: sampler;
${rainRingCode('wgsl', 'sroOcRing')}#endif
var<private> sroOcRest: vec2f;
var<private> sroOcField: vec4f;
var<private> sroOcFoam: f32;
var<private> sroOcSwash: f32;
var<private> sroOcAlpha: f32;
var<private> sroOcAlb: vec3f;
var<private> sroOcN: vec3f;
var<private> sroOcRgh: f32;
var<private> sroOcGlow: vec3f;
var<private> sroOcSky: vec3f;
var<private> sroOcFr: f32;
${COMMON_WGSL}${shoreCode('wgsl', 'fragment', 'definitions')}#endif
`
  }
  return `#ifdef SRO_OCEAN
varying vec4 ${OCEAN_VARYING};
uniform highp sampler2DArray sroOcWaves;
uniform sampler2D sroOcFieldMap;
uniform sampler2D sroOcNormal;
uniform highp sampler2DArray sroOcFrames;
#ifdef SRO_OCEAN_RIPPLE
uniform sampler2D sroOcRipple;
${rainRingCode('glsl', 'sroOcRing')}#endif
vec2 sroOcRest;
vec4 sroOcField;
float sroOcFoam;
float sroOcSwash;
float sroOcAlpha;
vec3 sroOcAlb;
vec3 sroOcN;
float sroOcRgh;
vec3 sroOcGlow;
vec3 sroOcSky;
float sroOcFr;
${COMMON_GLSL}${shoreCode('glsl', 'fragment', 'definitions')}#endif
`
}

function fragmentMain(lang: Lang): string {
  const w = lang === 'wgsl'
  const u = (n: string) => (w ? `uniforms.${n}` : n)
  const V2 = w ? 'vec2f' : 'vec2', V3 = w ? 'vec3f' : 'vec3'
  const decl = (type: string, name: string, value: string, mutable = false) => (w ? `${mutable ? 'var' : 'let'} ${name} = ${value};` : `${type} ${name} = ${value};`)
  /** `b` where `cond`, else `a`. */
  const sel = (a: string, b: string, cond: string) => (w ? `select(${a}, ${b}, ${cond})` : `((${cond}) ? (${b}) : (${a}))`)
  const tap = (layer: string, uv: string) => (w ? `textureSample(sroOcWaves, sroOcWavesSampler, ${uv}, i32(${layer} + 0.5))` : `texture(sroOcWaves, vec3(${uv}, floor(${layer} + 0.5)))`)
  const t2 = (tex: string, uv: string) => (w ? `textureSample(${tex}, ${tex}Sampler, ${uv})` : `texture(${tex}, ${uv})`)
  const posW = w ? 'fragmentInputs.vPositionW' : 'vPositionW'
  const vary = w ? `fragmentInputs.${OCEAN_VARYING}` : OCEAN_VARYING
  const eye = w ? 'scene.vEyePosition.xyz' : 'vEyePosition.xyz'
  const T = u('sroOcT')
  const frames = w
    ? `textureSample(sroOcFrames, sroOcFramesSampler, ${posW}.xz / ${f(WATER_FRAME_REPEAT_M)}, i32(${u('sroOcWA')}.x + 0.5)).rgb`
    : `texture(sroOcFrames, vec3(${posW}.xz / ${f(WATER_FRAME_REPEAT_M)}, floor(${u('sroOcWA')}.x + 0.5))).rgb`
  const shoreDepth = `${u('sroOcWC')}.w < 0.0`
  return `#ifdef SRO_OCEAN
{
  sroOcRest = ${vary}.xy;
  sroOcSwash = ${vary}.w;
  sroOcField = sroOcDecode(${t2('sroOcFieldMap', `sroOcRest * ${u('sroOcFieldXf')}.xy + ${u('sroOcFieldXf')}.zw`)});
  ${decl('float', 'sroDepth', 'max(-sroOcField.z, 0.0)')}
  ${decl('vec2', 'sroSlope0', `${V2}(0.0)`, true)}
  ${decl('float', 'sroFoamF', '0.0', true)}
  ${decl('float', 'sroFine', '0.0', true)}
${cascades(lang, (c, k, wt) => `  {
    ${decl('vec2', 'sroUv', `sroOcRest * ${k}.x`)}
    ${decl('vec4', 'sroDv', tap(`${T}.y + ${T}.w + ${f(c)}`, 'sroUv'), true)}
    ${decl('float', 'sroFo', `${tap(`${T}.y + ${f(c)}`, 'sroUv')}.w`, true)}
#ifdef SRO_OCEAN_LERP
    sroDv = mix(sroDv, ${tap(`${T}.z + ${T}.w + ${f(c)}`, 'sroUv')}, ${T}.x);
    sroFo = mix(sroFo, ${tap(`${T}.z + ${f(c)}`, 'sroUv')}.w, ${T}.x);
#endif
    ${decl('float', 'sroWt', `sroOcAtten(${k}, sroDepth, sroOcField.w)`)}
    sroSlope0 = sroSlope0 + ${V2}(sroDv.x / max(1.0 + sroDv.z, 0.2), sroDv.y / max(1.0 + sroDv.w, 0.2)) * sroWt;
    sroFoamF = sroFoamF + sroFo * ${wt} * sroWt;
    sroFine = sroWt;
  }
`)}  ${decl('vec2', 'sroWP', `${posW}.xz`)}
  ${decl('float', 'sroWT', `${u('sroOcWA')}.y`)}
  ${decl('vec2', 'sroN0', `${t2('sroOcNormal', `(sroWP + sroWT * ${V2}(${f(L0.scroll[0])}, ${f(L0.scroll[1])})) / ${f(L0.periodM)}`)}.xy * 2.0 - ${V2}(1.0)`)}
  ${decl('vec2', 'sroN1', `${t2('sroOcNormal', `(sroWP + sroWT * ${V2}(${f(L1.scroll[0])}, ${f(L1.scroll[1])})) / ${f(L1.periodM)}`)}.xy * 2.0 - ${V2}(1.0)`)}
  ${decl('float', 'sroJoin', 'sroOcField.w')}
  ${decl('vec2', 'sroSlope', `sroSlope0 + (sroN0 + sroN1 * 0.7) * (0.35 * mix(${f(DETAIL_AMP)} * max(sroFine, 0.3), abs(${u('sroOcWC')}.w), sroJoin))`, true)}
  ${decl('float', 'sroCrown', '0.0', true)}
  ${decl('float', 'sroRingG', '0.0', true)}
#ifdef SRO_OCEAN_RIPPLE
  ${decl('vec2', 'sroRu', `sroWP * ${f(OCEAN_RING_SCALE)}`)}
  ${decl('float', 'sroRr', `clamp(${u('sroOcS')}.w, 0.0, 1.0)`)}
${ringTaps(lang, 'sroOcRing', 'sroOcRipple', 'sroRu', null, null, `${u('sroOcWA')}.w`, 'sroRr', 'sroR')}  ${decl('float', 'sroRa', `smoothstep(0.0, 0.15, sroRr) * (1.0 - smoothstep(${f(OCEAN_RING_FADE_M[0])}, ${f(OCEAN_RING_FADE_M[1])}, distance(${eye}, ${posW})))`)}
  sroSlope = sroSlope - sroR.xy * (${f(OCEAN_RING_GAIN)} * sroRa);
  sroRingG = max(sroR.w, 0.0) * sroRa;
  sroCrown = max(clamp(sroR.z * sroRa, 0.0, 1.0) * ${f(OCEAN_CROWN_FOAM)}, clamp(sroRingG * ${f(OCEAN_RING_LINE)}, 0.0, 1.0));
#endif
  ${decl('vec3', 'sroFrame', frames)}
  ${decl('vec2', 'sroFp', `fwidth(${posW}.xz)`)}
  sroOcFoam = max(max(sroFoamF, ${vary}.z * 0.5), sroCrown);
  sroOcAlpha = 1.0;
${shoreCode(lang, 'fragment', 'main')}  ${decl('bool', 'sroKeep', `sroOcField.x >= 0.5 || (sroJoin < 0.5 && sroOcField.z > ${lowLandFloorCode('sroOcField.y')} && sroOcField.z < ${f(SWASH_HEIGHT_M)} && sroOcField.y > ${f(-SWASH_BAND_M)})`)}
  if (!sroKeep || sroOcAlpha <= 0.0) {
    discard;
  }
  // The normal, bent so the reflected ray never dips below the horizon (WaterMaterial.js: facets turned away go grazing).
  ${decl('vec3', 'sroV', `normalize(${eye} - ${posW})`)}
  ${decl('vec3', 'sroNr', `normalize(${V3}(-sroSlope.x, 1.0, -sroSlope.y))`)}
  ${decl('vec3', 'sroRf', 'reflect(-sroV, sroNr)')}
  ${decl('vec3', 'sroRh', `normalize(${V3}(sroRf.x, max(sroRf.y, 0.02), sroRf.z))`)}
  sroOcN = ${sel('sroNr', 'normalize(sroV + sroRh)', 'sroRf.y < 0.02')};
  // The water column and the refracted path (field B on every preset, R4).
  ${decl('float', 'sroCol', `max(${posW}.y - (${u('sroOcA')}.x + sroOcField.z), 0.0)`)}
  ${decl('float', 'sroCosI', 'clamp(dot(sroOcN, sroV), 0.02, 1.0)')}
  ${decl('float', 'sroCosT', 'sqrt(1.0 - (1.0 - sroCosI * sroCosI) / 1.7769)')}
  ${decl('float', 'sroPath', `min(sroCol / max(sroCosT, 0.1), ${f(PATH_MAX_M)})`)}
  ${decl('vec3', 'sroSa', `${u('sroOcIopA')}.rgb`)}
  ${decl('vec3', 'sroSs', `${u('sroOcIopS')}.rgb`)}
  ${decl('vec3', 'sroTr', 'exp(-(sroSa + sroSs) * sroPath)')}
  ${decl('float', 'sroAlpha', '1.0 - (sroTr.r + sroTr.g + sroTr.b) / 3.0')}
  ${decl('vec3', 'sroBb', `sroSs * ${f(IOP_BACKSCATTER)}`)}
  ${decl('vec3', 'sroRinf', '0.33 * sroBb / (sroSa + sroBb)')}
  ${decl('vec3', 'sroScat', `sroRinf * (${V3}(1.0) - sroTr) / max(sroAlpha, 1e-3)`)}
  // RND-W's water in the join zone (the same state, frames and formula).
  ${decl('vec3', 'sroShallow', `pow(clamp(sroFrame * ${u('sroOcWB')}.rgb, ${V3}(0.0), ${V3}(1.0)), ${V3}(2.2)) * ${f(WATER_ALBEDO_WEIGHT)}`)}
  ${decl('float', 'sroRetail', 'clamp(trunc(sroDepth * 5.0) / 15.0, 0.0, 1.0)')}
  ${decl('float', 'sroJd', sel('sroRetail', 'clamp(sroDepth / 4.0, 0.0, 1.0)', shoreDepth))}
  ${decl('float', 'sroJa', sel('sroRetail', `clamp(sroDepth / ${f(WATER_SHORE_M)}, 0.0, 1.0)`, shoreDepth))}
  ${decl('vec3', 'sroJalb', `mix(sroShallow, sroShallow * ${u('sroOcWC')}.rgb, sroJd)`)}
  ${decl('float', 'sroFoam', 'clamp(sroOcFoam, 0.0, 1.0)')}
  sroOcAlb = mix(mix(sroScat, sroJalb, sroJoin), ${V3}(0.85), sroFoam);
  sroOcAlpha = min(sroOcAlpha, max(mix(sroAlpha, sroJa, sroJoin), sroFoam));
  // Cox–Munk roughness from the unresolved slope (the pixel footprint), with foam.
  ${decl('float', 'sroFoot', 'clamp(length(sroFp) / 2.0, 0.0, 1.0)')}
  ${decl('float', 'sroMss', `${f(MSS_BASE)} + ${f(MSS_PER_MS)} * ${u('sroOcRough')}.x`)}
  ${decl('float', 'sroA2', `${f(ROUGH_ALPHA0 * ROUGH_ALPHA0)} + 2.0 * sroMss * (0.15 + 0.85 * sroFoot) + 0.2 * sroFoam + 0.02 * ${u('sroOcS')}.w`)}
  sroOcRgh = mix(sqrt(sqrt(sroA2)), ${u('sroOcWB')}.w, sroJoin);
  // Crest translucency: crests above the sea level, lit from behind.
  ${decl('float', 'sroCrest', `max(${posW}.y - ${u('sroOcA')}.x, 0.0) * max(dot(-sroV, ${u('sroOcSun')}.xyz), 0.0) * ${u('sroOcSun')}.w * (1.0 - sroJoin)`)}
  sroOcGlow = ${V3}(${f(CREST_GLOW[0])}, ${f(CREST_GLOW[1])}, ${f(CREST_GLOW[2])}) * sroCrest * (1.0 - sroFoam);
  // The sky's reflection (CST-O spike, P-LOOK): Babylon's split-sum on the blurred sky cube gives a near-horizon
  // reflection only ~5–10 % of the horizon sky and next to no gradient, so every facet mirrored the same pale colour and
  // the waves read only through the Fresnel weight: a flat sea. The exact Schlick Fresnel of the sky along the
  // reflected ray is added, minus what the cube already gives (its ~0.08): the horizon colour (the height fog's own,
  // exposed scene-linear) blending to the zenith's deeper blue (sroOcZenith: the horizon × the sky's hemisphere ratio)
  // as the ray rises, so a wave's face turned toward the camera mirrors the deeper sky and its back the pale horizon.
  ${decl('float', 'sroCv', 'clamp(dot(sroOcN, sroV), 0.0, 1.0)')}
  ${decl('float', 'sroFr', `${f(0.02)} + 0.98 * pow(1.0 - sroCv, 5.0)`)}
  ${decl('float', 'sroRy', 'reflect(-sroV, sroOcN).y')}
  ${decl('vec3', 'sroSkyC', `mix(${u('sroOcHorizon')}.rgb, ${u('sroOcZenith')}.rgb, ${u('sroOcZenith')}.w * pow(smoothstep(0.0, 0.7, sroRy), 0.6))`)}
  sroOcSky = sroSkyC * (max(sroFr - 0.08, 0.0) * ${u('sroOcHorizon')}.w * (1.0 - sroFoam) * (1.0 - sroJoin) + ${f(OCEAN_RING_GLINT)} * sroRingG);
  // P-LOOK: the surface's Fresnel for the blend (Schlick with roughness, as the environment BRDF sees it; foam scatters
  // diffusely; the join keeps RND-W's water as it is). See blendCode.
  sroOcFr = (${f(WATER_F0)} + (max(1.0 - sroOcRgh, ${f(WATER_F0)}) - ${f(WATER_F0)}) * pow(1.0 - sroCv, 5.0)) * (1.0 - sroFoam) * (1.0 - sroJoin);
}
#endif
`
}

/**
 * P-LOOK (wave 10 polish), the blend with the Fresnel: the sea is alpha-blended, and Babylon's
 * radiance-over-alpha only raises the alpha by the reflection's luminance squared, in scene units that the post
 * stack's exposure (≈ 8–11 at noon) later multiplies: a few thousandths. So in shallow water (a low column alpha)
 * the sky's reflection and the sun's glint were scaled down with the water colour and the sand showed through at
 * grazing angles, where real water is a mirror: the sea near the beach read as sand with foam on it and the open sea
 * as a thin flat band. Here the background is weighted by the light the surface transmits, `(1 − F)(1 − α)`, so the
 * alpha is `α' = α + F (1 − α)`; the reflected terms (the environment radiance, the key light's specular, the grazing
 * sky) are divided by α' (they reach the screen at full strength), and the light scattered up from the water column
 * (diffuse, ambient, irradiance, the crest glow) is scaled by α (1 − F) / α' (as before, less what the surface
 * reflects). This replaces Babylon's radiance-over-alpha bump (the alpha is set here, after it).
 */
function blendCode(lang: Lang): string {
  const w = lang === 'wgsl'
  const F = w ? 'let' : 'float'
  return `#ifdef SRO_OCEAN
{
  ${F} sroBa = clamp(sroOcAlpha, 0.0, 1.0);
  ${F} sroBf = clamp(sroOcFr, 0.0, 1.0);
  ${F} sroB1 = max(sroBa + sroBf * (1.0 - sroBa), 0.001);
  ${F} sroKd = sroBa * (1.0 - sroBf) / sroB1;
  ${F} sroKr = 1.0 / sroB1;
  finalDiffuse = finalDiffuse * sroKd;
  finalAmbient = finalAmbient * sroKd;
#ifdef REFLECTION
  finalIrradiance = finalIrradiance * sroKd;
  finalRadianceScaled = finalRadianceScaled * sroKr;
#endif
#ifdef SPECULARTERM
  finalSpecularScaled = finalSpecularScaled * sroKr;
#endif
  finalEmissive = finalEmissive + sroOcGlow * sroKd + sroOcSky * sroKr;
  alpha = sroB1;
}
#endif
`
}

function fragmentCode(lang: Lang): Record<string, string> {
  const w = lang === 'wgsl'
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: fragmentDefinitions(lang),
    CUSTOM_FRAGMENT_MAIN_BEGIN: fragmentMain(lang),
    CUSTOM_FRAGMENT_UPDATE_ALBEDO: `#ifdef SRO_OCEAN\nsurfaceAlbedo = sroOcAlb;\n#endif\n`,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: `#ifdef SRO_OCEAN\nalpha = sroOcAlpha;\nnormalW = sroOcN;\n#endif\n`,
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `#ifdef SRO_OCEAN\nmetallicRoughness = ${w ? 'vec2f' : 'vec2'}(0.0, sroOcRgh);\n#endif\n`,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: blendCode(lang),
  }
}

/** The injection points per stage and language (the same keys in both; test/ocean-plugin.test.ts). */
export function oceanCode(stage: 'vertex' | 'fragment', lang: Lang): Readonly<Record<string, string>> {
  if (stage === 'vertex') return { CUSTOM_VERTEX_DEFINITIONS: vertexDefinitions(lang), CUSTOM_VERTEX_UPDATE_POSITION: vertexMain(lang) }
  return fragmentCode(lang)
}

// ---- state and plugin -----------------------------------------------------------------------------------------------

/**
 * What the ocean material binds (the ocean part writes it each frame):
 *   A     sea level, time (s, mod 3600), Hs, peak period          (the shore seam reads A and S)
 *   S     swell direction x, z, storminess, rain
 *   Cam   camera x, y, z, grid G
 *   Lat   lattice origin x, z, leaf (m), range factor
 *   T     tick lerp, previous set's layer base, next set's layer base, cascade count C (derivative layers = base + C)
 *   K0-3  per cascade: 1/L, texel (m), d0 (m), floor
 *   W     foam weight per cascade
 *   FieldXf  uv = xz × xy + zw
 *   IopA, IopS  absorption and scattering per channel (1/m)
 *   Sun   key light direction (to the light), crest-glow intensity
 *   Rough Cox–Munk wind (m/s)
 *   Horizon, Zenith  the sky the surface mirrors (P-LOOK: the reflection's gradient)
 *   WA, WB, WC  RND-W's WaterPbrState a, b, c (the join); WC.w < 0 = its High+ depth shore (|WC.w| = the amplitude)
 */
export class OceanPbrState {
  readonly a = new Vector4(5, 0, 0.5, 9)
  readonly s = new Vector4(0, 1, 0, 0)
  readonly cam = new Vector4(0, 100, 0, 16)
  readonly lat = new Vector4(0, 0, 8, 2.5)
  readonly t = new Vector4(0, 0, 0, 2)
  readonly k = [new Vector4(1 / 400, 400 / 64, 40, 0), new Vector4(0.0142, 70 / 64, 5.6, 0.13), new Vector4(0, 1, 1, 0.25), new Vector4(0, 1, 1, 0.5)]
  readonly w = new Vector4(0.45, 0.5, 0.5, 0.25)
  readonly fieldXf = new Vector4(0, 0, 0, 0)
  readonly iopA = new Vector4(IOP_ABSORPTION[0], IOP_ABSORPTION[1], IOP_ABSORPTION[2], 0)
  readonly iopS = new Vector4(IOP_SCATTERING[0], IOP_SCATTERING[1], IOP_SCATTERING[2], 0)
  readonly sun = new Vector4(0, 1, 0, 1)
  readonly rough = new Vector4(2, 0, 0, 0)
  readonly wa = new Vector4(0, 0, 0, 0)
  readonly wb = new Vector4(0.25, 0.69, 0.62, 0.04)
  readonly wc = new Vector4(0.35, 0.5, 0.55, 1)
  /** The horizon sky (the height fog's colour: exposed scene-linear) and the grazing term's strength (0: off). */
  readonly horizon = new Vector4(0, 0, 0, 0)
  /** P-LOOK: the zenith sky in the same units (rgb) and how far the reflection blends to it (w: 0 = the horizon only). */
  readonly zenith = new Vector4(0, 0, 0, 0)
  waves: BaseTexture | null = null
  field: BaseTexture | null = null
  normal: BaseTexture | null = null
  frames: BaseTexture | null = null
  ripple: BaseTexture | null = null
  shore: ShorePart | null = null
  lerp = true
  cascades4 = false
  private shoreOn = false
  readonly plugins = new Set<SroOceanPlugin>()

  /** Whether everything the base code binds exists. */
  get ready(): boolean {
    return !!(this.waves && this.field && this.normal && this.frames)
  }

  /** The shore seam is live (its code is non-empty and its part is ready). */
  get shoreLive(): boolean {
    return this.shoreOn
  }

  /** Switches that change defines (a preset, a weather level or a shore change; never per frame). */
  setSwitches(o: { lerp?: boolean; cascades4?: boolean; ripple?: BaseTexture | null }): void {
    const shore = !!this.shore?.ready && (shoreHasCode(SHORE_VERTEX) || shoreHasCode(SHORE_FRAGMENT))
    let changed = shore !== this.shoreOn
    this.shoreOn = shore
    if (o.lerp !== undefined && o.lerp !== this.lerp) {
      this.lerp = o.lerp
      changed = true
    }
    if (o.cascades4 !== undefined && o.cascades4 !== this.cascades4) {
      this.cascades4 = o.cascades4
      changed = true
    }
    if (o.ripple !== undefined && (o.ripple !== null) !== (this.ripple !== null)) changed = true
    if (o.ripple !== undefined) this.ripple = o.ripple
    if (changed) for (const p of this.plugins) p.markAllDefinesAsDirty()
  }

  /** Re-evaluates the defines of every material (a texture appeared). */
  refresh(): void {
    for (const p of this.plugins) p.markAllDefinesAsDirty()
  }
}

export class SroOceanPlugin extends MaterialPluginBase {
  constructor(material: Material, readonly state: OceanPbrState) {
    super(material, SRO_OCEAN_PLUGIN, 250, { SRO_OCEAN: false, SRO_OCEAN_LERP: false, SRO_OCEAN_C4: false, SRO_OCEAN_RIPPLE: false, [SHORE_DEFINE]: false }, true, true)
    state.plugins.add(this)
  }

  override getClassName(): string {
    return 'SroOceanPlugin'
  }

  override isCompatible(_language: ShaderLanguage): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, _mesh: AbstractMesh): void {
    const s = this.state
    const on = s.ready
    defines['SRO_OCEAN'] = on
    defines['SRO_OCEAN_LERP'] = on && s.lerp
    defines['SRO_OCEAN_C4'] = on && s.cascades4
    defines['SRO_OCEAN_RIPPLE'] = on && s.ripple !== null
    defines[SHORE_DEFINE] = on && s.shoreLive
  }

  override getAttributes(attributes: string[], _scene: Scene, _mesh: AbstractMesh): void {
    if (this.state.ready && !attributes.includes(CDLOD_ATTRIBUTE)) attributes.push(CDLOD_ATTRIBUTE)
  }

  override getUniforms(language: ShaderLanguage = ShaderLanguage.GLSL) {
    const names = [...OCEAN_UNIFORMS, ...SHORE_UNIFORMS]
    const ubo = names.map(name => ({ name, size: 4, type: 'vec4' }))
    if (language === ShaderLanguage.WGSL) return { ubo }
    // GLSL without uniform buffers only (the UBO path ignores these).
    const decl = `#ifdef SRO_OCEAN\n${names.map(n => `uniform vec4 ${n};`).join('\n')}\n#endif`
    return { ubo, vertex: decl, fragment: decl }
  }

  override getSamplers(samplers: string[]): void {
    samplers.push(...OCEAN_SAMPLERS, ...SHORE_SAMPLERS)
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = this.state
    if (!s.ready) return
    ubo.updateVector4('sroOcA', s.a)
    ubo.updateVector4('sroOcS', s.s)
    ubo.updateVector4('sroOcCam', s.cam)
    ubo.updateVector4('sroOcLat', s.lat)
    ubo.updateVector4('sroOcT', s.t)
    for (let c = 0; c < 4; c++) ubo.updateVector4(`sroOcK${c}`, s.k[c]!)
    ubo.updateVector4('sroOcW', s.w)
    ubo.updateVector4('sroOcFieldXf', s.fieldXf)
    ubo.updateVector4('sroOcIopA', s.iopA)
    ubo.updateVector4('sroOcIopS', s.iopS)
    ubo.updateVector4('sroOcSun', s.sun)
    ubo.updateVector4('sroOcRough', s.rough)
    ubo.updateVector4('sroOcWA', s.wa)
    ubo.updateVector4('sroOcWB', s.wb)
    ubo.updateVector4('sroOcWC', s.wc)
    ubo.updateVector4('sroOcHorizon', s.horizon)
    ubo.updateVector4('sroOcZenith', s.zenith)
    ubo.setTexture('sroOcWaves', s.waves)
    ubo.setTexture('sroOcFieldMap', s.field)
    ubo.setTexture('sroOcNormal', s.normal)
    ubo.setTexture('sroOcFrames', s.frames)
    if (s.ripple) ubo.setTexture('sroOcRipple', s.ripple)
    if (s.shoreLive && s.shore) s.shore.bind(uboBinder(ubo))
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    const lang = language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl'
    return { ...oceanCode(shaderType === 'vertex' ? 'vertex' : 'fragment', lang) }
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.state.plugins.delete(this)
    super.dispose(forceDisposeTextures)
  }
}

function uboBinder(ubo: UniformBuffer): ShoreBinder {
  return { vec4: (n, v) => ubo.updateVector4(n, v), texture: (n, t) => ubo.setTexture(n, t) }
}

/** The ocean's PBR material with its plugin (one per world). */
export function createOceanMaterial(scene: Scene, state: OceanPbrState): { material: PBRMaterial; plugin: SroOceanPlugin } {
  const m = useWindowedLightFalloff(new PBRMaterial('oceanPbr', scene))
  m.metallic = 0
  m.roughness = 0.1
  m.indexOfRefraction = 1.333
  m.albedoColor = Color3.White()
  m.emissiveColor = Color3.Black()
  m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND
  // CST-O spike (COAST §8.2 F3/F4, §12.4 item 5): the sea writes depth in its colour pass instead of a depth pre-pass.
  // Both put the sea in the hardware depth buffer and keep a folded storm crest from drawing over the trough in front
  // of it; the pre-pass measured +0.23 ms of render CPU on High/WebGPU (a second draw, and `checkReadyOnEveryCall`),
  // the depth write +0. The difference: where near and far water overlap in draw order the nearer blends over the
  // farther instead of replacing it, which only shows through thin (shallow, translucent) water.
  m.disableDepthWrite = false
  m.needDepthPrePass = false
  m.backFaceCulling = false
  m.useRadianceOverAlpha = true
  m.useSpecularOverAlpha = true
  const plugin = new SroOceanPlugin(m, state)
  return { material: m, plugin }
}
