/**
 * `SroSurfacePlugin`: the PBR response of world objects and characters on the PBR presets (docs/RENDER.md §3.3–3.5,
 * §9.2–9.3; docs/WAVE_PLAN3.md §6.10, D16, D19, D28, D31; DETAIL H3/H4/H6), and `PbrSurfaces`, RND-M's part of
 * WorldRender (render/index.ts `materials`) that feeds every plugin and decorates character materials.
 *
 * What the plugin does, per define (all in WGSL and GLSL, same injection points; no GLSL on the WebGPU engine):
 *   SRO_LUMA_ROUGH   no roughness map: roughness = class roughness + 0.1 × (0.5 − luma(albedo));
 *   SRO_BAKED        the object lightmap (TEXCOORD_1) is baked sun visibility, not a colour multiply (§3.4):
 *                    bakedVis = saturate((lm − 0.55) / 0.4) scales light 0 (the celestial light), faded as the sun
 *                    leaves the bake direction (D16: mix(1, bakedVis, max(0.35, bakedWeight))) and handed over to the
 *                    CSM inside its range; ao = mix(1, lm / 0.95, 0.5) on the ambient and IBL diffuse. Babylon's own
 *                    lightmap multiply is off (LIGHTMAPEXCLUDED) and the lightmap is read raw (GAMMALIGHTMAP off);
 *   SRO_WET          wetness (D19; WEATHER §6.3 for PBR inputs): w = wet × exposure(N.y) × shelter; albedo darkens by
 *                    porosity, roughness goes to the class's wet roughness, normal maps flatten; the sky reflection is
 *                    capped by the surface's own light (WET_REFLECT_MAX, W9 LOOK);
 *   SRO_PUDDLES      flat floors (N.y > 0.95) of puddle classes on High+ (RENDER §9.3 mask with noise): dark bottom,
 *                    roughness 0.03, up normal. The noise hash is sine-free (W9 LOOK): fract(sin(dot(p, k)) × 43758)
 *                    at world coordinates ~15 × 300 lost its precision on WebGPU and drew striped puddle patches;
 *   SRO_RAIN         wave 12 RAIN-P, Medium+ weather: on every flat, open, wet floor of a world object (batched slots
 *                    and baked materials of RAIN_FILM_CLASSES; never characters), a rain film (gloss, flatter normal)
 *                    with rain rings and impact crowns from the texture-free ring field (RAIN_CELLS_M);
 *   SRO_SHELTER      `sroShelter(worldPos)` from weather/chunks.ts (D20) when WX-R ships it;
 *   SRO_CLOUDSHADOW  `sroCloudShadow(worldPos)` from sky/chunks.ts (D28) on Ultra, on the celestial light;
 *   SRO_LAMP         cloth lanterns and lamps glow at night: emissive += albedo × 1.5 × night (§3.3);
 *   SRO_SELFLIT      a retail self-illuminated material (BMT emissive): the emissive samples the albedo, and PbrSurfaces
 *                    ties its level to the sky's ambient every frame (W9 LOOK, PbrSurfaces.addEmissive);
 *   SRO_TABLE        BT-P (docs/BATCHING.md §3.2–§3.4, §3.10): a region batch's group material. The merged vertex's UV2
 *                    carries (lightmap layer, slot) in its integer part (packTableUv2); the slot's row of the material
 *                    table (TABLE_TEXEL) gives the albedo and NRAO atlas cells (sampled with explicit gradients through
 *                    `fract`, so REPEAT UVs wrap inside the cell), the class values (`sroSurf`, metallic, roughness,
 *                    normal strength), the direct intensity, SSR mask, cut-off and lamp emissive; the lightmap comes from
 *                    the 256² lightmap array. The normal map goes through Babylon's cotangent frame, the NRAO AO where
 *                    Babylon puts an ORM AO (irradiance, ambient, direct diffuse, radiance occlusion), the direct
 *                    intensity where `vLightingIntensity.x` goes. The material binds no 2D map: 4 object samplers (F8),
 *                    no new varying (vMainUV1 / vMainUV2 are the lightmapped object's own). Off, the code is HEAD's;
 *                    no regex on Babylon's text;
 *   always           the SSR mask (D31): puddles, wet flat surfaces, metal and polished marble raise
 *                    specularEnvironmentR0 / microSurface in the prepass reflectivity only.
 *
 * The chunk owners' functions read uniforms this plugin declares in its UBO, by their published lists:
 * `WX_SHELTER_UNIFORMS` (weather/chunks.ts; bound from `world.weather.u`, plus `WX_OCC8` for an RGBA8 map) and
 * `SKY_CLOUD_SHADOW_UBO` (sky/chunks.ts; bound from SkyState). Their function strings declare their own textures
 * (`wxOccMap`, `cloudNoise`); a string that does not gets them declared here.
 *
 * Translucency is not here (RND-W's SroFoliagePlugin owns foliage; skin uses Babylon's subsurface on Ultra).
 * Owned by RND-M.
 */
import {
  Color3,
  MaterialPluginBase,
  PBRMaterial,
  RawTexture,
  ShaderLanguage,
  Vector4,
  VertexBuffer,
  type AbstractEngine,
  type AbstractMesh,
  type BaseTexture,
  type Camera,
  type Material,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import type { RenderPart } from '../render/index.ts'
import type { RenderPath, RenderQuality } from '../render/quality.ts'
import type { RenderWeather } from '../render/weather.ts'
import { SKY_CLOUD_SHADOW_GLSL, SKY_CLOUD_SHADOW_UBO, SKY_CLOUD_SHADOW_WGSL } from '../sky/chunks.ts'
import { BAKED_LIGHT_DIR, type SkyState } from '../sky/types.ts'
import { WX_SHELTER_GLSL, WX_SHELTER_SAMPLER, WX_SHELTER_UNIFORMS, WX_SHELTER_WGSL } from '../weather/chunks.ts'
import type { ShelterMap, WeatherUniforms } from '../weather/index.ts'
import type { WeatherPreset } from '../weather/presets.ts'
import { rainCellCode } from '../weather/ripples.ts'
import { classParams, classify, type MaterialClass } from './classes.ts'
import { ktx2MapsAvailable, mapPolicy, pageTextureSetting, PbrMapIndex, PbrTextureCache, type MapPolicy, type MapTextureSource, type TextureSetting } from './maps.ts'

/** The plugin's name (D19: WX-R's attachWetness skips materials that carry it). */
export const SRO_SURFACE_PLUGIN = 'SroSurfacePlugin'

// ---- tiers --------------------------------------------------------------------------------------------------------

export type MaterialTier = 'classic' | 'medium' | 'high' | 'ultra'

/**
 * The material detail level of a render preset. The terrain detail flags double as it (they are not Options
 * "Advanced" rows, so a player turning SSAO off on High keeps High's materials): parallax = Ultra, layer normals =
 * High.
 */
export function materialTier(q: Readonly<RenderQuality>): MaterialTier {
  if (q.path === 'classic') return 'classic'
  if (q.terrain.parallax) return 'ultra'
  if (q.terrain.layerNormals) return 'high'
  return 'medium'
}

/** §2.5 lightmap floor for objects, its range, the lightmap p95 (TERRAIN.md §3.3) and the AO share (§3.4). */
export const OBJECT_LIGHTMAP = { floor: 0.55, range: 0.4, p95: 0.95, aoShare: 0.5 } as const
/**
 * W9 LOOK (c): the wet reflection is tied to the light the surface itself receives: the sky a wet or puddled surface
 * mirrors (the IBL radiance) is capped at this × that light (its direct and ambient irradiance / π, AO and baked
 * shadow included). In the open by day the sun keeps it far above any sky; in shade and at night a soaked plaza reads
 * dark and wet instead of mirroring a light blue sky.
 */
export const WET_REFLECT_MAX = 0.6
/**
 * Wave 12 RAIN-P: the rain film and rings on the flat floors of world objects (the plaza's paving is an object),
 * SRO_RAIN on Medium+ weather: the same film as the PBR terrain (terrain-plugin.ts FILM_*), its rings from the
 * texture-free ring field (weather/ripples.ts `rainCellCode`, so no object material takes a sampler): two layers of
 * RAIN_CELLS_M cells (a ring reaches half a cell), normal gain RAIN_OBJECT_GAIN, fading out over RAIN_OBJECT_FADE_M of
 * camera distance, the crown and crest albedo lift of the terrain.
 */
export const RAIN_CELLS_M: readonly [number, number] = [0.34, 0.25]
/**
 * The film covers every flat, open, wet floor of a world object (not only the puddle classes: the plaza's paving is
 * the `default`-class `cj_jang_gate07`), at this share of full strength for classes without a puddle weight; the
 * puddle classes (stone, soil) take the whole film. Characters (never baked) and the classes below never get it.
 */
export const RAIN_OBJECT_FILM_MIN = 0.75
export const RAIN_FILM_CLASSES: ReadonlySet<MaterialClass> = new Set<MaterialClass>(['stone', 'ground_soil', 'ground_grass', 'default', 'wood', 'roof_tile'])
export const RAIN_OBJECT_GAIN = 2
/** The ring lines' albedo contrast (1 ± this × the ring height), as the terrain's RING_CONTRAST. */
export const RAIN_OBJECT_CONTRAST = 0.85
export const RAIN_OBJECT_FADE_M: readonly [number, number] = [22, 45]
/** RENDER §3.3: lanterns glow at night. */
export const LAMP_EMISSIVE = 1.5
/**
 * W9 LOOK: a retail self-illuminated material's emissive (BMT emissive, × the albedo) is this × its colour × the sky's
 * up-facing ambient (SkyState.ambient.sky × environmentIntensity). Retail added the emissive to the lit term before
 * the 2× texture multiply, a floor ~1.27× the noon ambient term (0.59 against ObjectAmbient 0.79 × 0.59).
 */
export const EMISSIVE_AMBIENT = 2
/** H6: skin F0 ≈ 0.028 = ((ior − 1) / (ior + 1))² at ior 1.4. */
export const SKIN_IOR = 1.4
/** D16: the smallest share of the baked shadow kept beyond the CSM range. */
export const BAKED_MIN = 0.35

/** D16: max(0.35, saturate(dot(lightDir, bakeDir) × 2 − 0.6)) for a unit direction TO the light. */
export function bakedWeight(dir: { x: number; y: number; z: number }): number {
  const d = dir.x * BAKED_LIGHT_DIR.x + dir.y * BAKED_LIGHT_DIR.y + dir.z * BAKED_LIGHT_DIR.z
  return Math.max(BAKED_MIN, Math.min(1, Math.max(0, d * 2 - 0.6)))
}

// ---- the material table (BT-P; docs/BATCHING.md §3.2–§3.4) --------------------------------------------------------

/**
 * Texels per slot of the region batches' material table (RGBA16F, BT-A's `batch/table.ts`): slot `s` is row `s` and its
 * texel `k` is column `k`, fetched at (k, s) with no filtering.
 */
export const TABLE_TEXELS_PER_SLOT = 6
/**
 * What each texel of a slot holds (BATCHING §3.2); SRO_TABLE reads exactly this layout:
 *   albedo    the albedo cell: (page layer, u offset, v offset, u scale) in the albedo atlas array; the cell's v scale is
 *             `misc.w` (rectangular cells, F6). Page coordinates as uploaded (no invertY), like glTF UVs.
 *   nrao      the NRAO cell: (layer, u offset, v offset, u scale), layer < 0 = none; its v scale keeps the albedo cell's
 *             aspect (u scale × misc.w / albedo.w). The cell holds normal xy (the material's X/Y inversion baked,
 *             tangent space as Babylon's `vTangentSpaceParams` (1, 1)), roughness, AO; `params.w` says which are real.
 *   surf      the surface plugin's `sroSurf`: luma-roughness k (0 with a roughness map), porosity, wet roughness, puddle.
 *   params    (metallic, roughness, normal strength, flags: TABLE_FLAG).
 *   misc      (direct intensity: 0.8 for map sets that are not de-lit, SSR mask, alpha cut-off, albedo cell v scale).
 *   emissive  rgb: the emissive colour as `emissiveColor` would carry it (NL's night lamp colour × level, divided by the
 *             exposure; a retail emissive × the ambient, PbrSurfaces.addSlotEmissive); a: 1 = self-lit (× the albedo, as
 *             SRO_SELFLIT), 0 = a flat colour. Read only by a lamp group (its plugin is `selfLit`).
 */
export const TABLE_TEXEL = { albedo: 0, nrao: 1, surf: 2, params: 3, misc: 4, emissive: 5 } as const
/** The planes of a slot's NRAO cell (TABLE_TEXEL.params w is their sum): missing ones use the table's values. */
export const TABLE_FLAG = { normal: 1, roughness: 2, ao: 4 } as const
/** The lightmap array's layer size (BATCHING §3.2, F7: one 256²-layer array; 128² and 64² maps in quadrants). */
export const TABLE_LIGHTMAP_SIZE = 256
/** The lightmap's mip level is clamped to this (lightmaps are low-frequency; the quadrant margin holds at mip 1). */
export const TABLE_LIGHTMAP_MAX_LOD = 1
/** The smallest cut-off the rescale divides by. */
export const TABLE_MIN_CUTOFF = 0.001
/** The largest slot or lightmap layer the UV2 packing keeps ≤ 0.25 lightmap texel precise (BATCHING §3.3). */
export const TABLE_MAX_ID = 4095
const TABLE_LIGHTMAP_TEXELS2 = (TABLE_LIGHTMAP_SIZE * TABLE_LIGHTMAP_SIZE).toFixed(1)
const LM_MAX_LOD = TABLE_LIGHTMAP_MAX_LOD.toFixed(1)
const MIN_CUT = TABLE_MIN_CUTOFF.toFixed(3)
/**
 * The albedo / NRAO atlas page (batch/atlas.ts ATLAS_PAGE). RA-1: `sroGradK(s, d1, d2)` (both languages) is the factor
 * on a cell's uv gradients that keeps its mip level at or below decode-core `atlasMaxLod` (the wrap gutter stays at
 * least half a texel, so no bilinear tap reads the neighbouring cell); `s` is the cell's inner uv scale.
 */
export const TABLE_ATLAS_PAGE = 1024
const ATLAS_PAGE_F = TABLE_ATLAS_PAGE.toFixed(1)

/**
 * BATCHING §3.3: the (slot, lightmap layer) of a merged vertex ride in the integer part of its UV2 (lightmap UVs lie in
 * [0.015, 0.985] after the quadrant remap): uv2 = (u + 2 × layer, v + 2 × slot). No extra varying.
 */
export function packTableUv2(u: number, v: number, layer: number, slot: number): [number, number] {
  return [u + 2 * layer, v + 2 * slot]
}

/** The shader's decode of `packTableUv2` (floor(uv2 / 2) = the ids; the rest is the lightmap UV). */
export function unpackTableUv2(u2: number, v2: number): { u: number; v: number; layer: number; slot: number } {
  const layer = Math.floor(u2 * 0.5)
  const slot = Math.floor(v2 * 0.5)
  return { u: u2 - 2 * layer, v: v2 - 2 * slot, layer, slot }
}

/**
 * The cut-off rescale of a cut-out group (one ALPHATESTVALUE per material, a cut-off per slot): the alpha the albedo
 * block tests against `alphaTestValue` is `alpha × alphaTestValue / cutoff`, so a texel is kept exactly when
 * `alpha ≥ cutoff` (the shader's line, in TS for the tests).
 */
export function tableTestAlpha(alpha: number, cutoff: number, alphaTestValue: number): number {
  return alpha * (alphaTestValue / Math.max(cutoff, TABLE_MIN_CUTOFF))
}

/** The four object samplers of a table-mode material (F8: albedo atlas, NRAO atlas, lightmap array, table). */
export const SURFACE_TABLE_SAMPLERS: readonly string[] = ['sroAlbArr', 'sroNraoArr', 'sroLmArr', 'sroTable']

/**
 * BT-A's textures a table-mode plugin binds (read at every bind, so BT-A may swap a grown array in place):
 * `albedo` and `nrao` are 2D texture arrays of RGBA8 pages (gamma-encoded albedo, decoded in the shader like Babylon's
 * GAMMAALBEDO; linear NRAO), `lightmap` a 2D array of 256² RGBA8 layers (raw sun visibility, layer 0 quadrant 0 white),
 * `table` the RGBA16F material table. A material whose table lacks one of them is not ready.
 */
export interface SurfaceTable {
  albedo: BaseTexture | null
  nrao: BaseTexture | null
  lightmap: BaseTexture | null
  table: BaseTexture | null
}

// ---- shader code --------------------------------------------------------------------------------------------------

const LUMA_WGSL = 'vec3f(0.2126, 0.7152, 0.0722)'
const LUMA_GLSL = 'vec3(0.2126, 0.7152, 0.0722)'

function wgslCode(shelter: string, cloud: string): Record<string, string> {
  const shelterTex = /var\s+wxOccMap\s*:/.test(shelter) ? '' : 'var wxOccMap: texture_2d<f32>;\nvar wxOccMapSampler: sampler;\n'
  const cloudTex = /var\s+cloudNoise\s*:/.test(cloud) ? '' : 'var cloudNoise: texture_2d<f32>;\nvar cloudNoiseSampler: sampler;\n'
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef SRO_SHELTER
${shelterTex}${shelter}
#endif
#ifdef SRO_CLOUDSHADOW
${cloudTex}${cloud}
#endif
var<private> sroLuma: f32;
var<private> sroLumaK: f32;
var<private> sroWetW: f32;
var<private> sroWetRough: f32;
var<private> sroPuddle: f32;
var<private> sroDark: f32;
#ifdef SRO_RAIN
var<private> sroFilm: f32;
var<private> sroRing: vec4f;
#endif
fn sroHash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + vec3f(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
fn sroNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (vec2f(3.0) - 2.0 * f);
  return mix(mix(sroHash(i), sroHash(i + vec2f(1.0, 0.0)), u.x), mix(sroHash(i + vec2f(0.0, 1.0)), sroHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn sroRoughness(r: f32) -> f32 {
  var o = r;
#ifdef SRO_LUMA_ROUGH
  o = clamp(o + sroLumaK * (0.5 - sroLuma), 0.02, 1.0);
#endif
#ifdef SRO_WET
  o = mix(o, sroWetRough, sroWetW);
  o = mix(o, 0.03, sroPuddle);
#ifdef SRO_RAIN
  o = mix(o, min(o, 0.08), sroFilm);
#endif
#endif
  return o;
}
#ifdef SRO_RAIN
${rainCellCode('wgsl', 'sroRainCells', 'sroHash')}#endif
#ifdef SRO_TABLE
var sroAlbArr: texture_2d_array<f32>;
var sroAlbArrSampler: sampler;
var sroNraoArr: texture_2d_array<f32>;
var sroNraoArrSampler: sampler;
var sroLmArr: texture_2d_array<f32>;
var sroLmArrSampler: sampler;
var sroTable: texture_2d<f32>;
var sroTableSampler: sampler;
fn sroGradK(s: vec2f, d1: vec2f, d2: vec2f) -> f32 {
  let inner = max(min(s.x, s.y) * ${ATLAS_PAGE_F}, 1.0);
  let lim = exp2(max(2.0, floor(log2(inner) + 0.05) - 5.0));
  let t1 = d1 * s * ${ATLAS_PAGE_F};
  let t2 = d2 * s * ${ATLAS_PAGE_F};
  let m = max(max(dot(t1, t1), dot(t2, t2)), 1e-20);
  return select(1.0, lim * inverseSqrt(m), m > lim * lim);
}
var<private> sroTAlb: vec4f;
var<private> sroTNr: vec4f;
var<private> sroTSurf: vec4f;
var<private> sroTPar: vec4f;
var<private> sroTMisc: vec4f;
var<private> sroTEm: vec4f;
var<private> sroTLm: vec3f;
var<private> sroTRough: f32;
var<private> sroTAo: f32;
var<private> sroTFlags: u32;
var<private> sroTDp1: vec3f;
var<private> sroTDp2: vec3f;
var<private> sroTDuv1: vec2f;
var<private> sroTDuv2: vec2f;
fn sroTexel(k: i32, slot: i32) -> vec4f {
  return textureLoad(sroTable, vec2i(k, slot), 0);
}
#endif
`,
    CUSTOM_FRAGMENT_MAIN_BEGIN: `
#ifdef SRO_TABLE
{
  let sroUv = fragmentInputs.vMainUV1;
  let sroUv2 = fragmentInputs.vMainUV2;
  let sroIds = floor(sroUv2 * 0.5);
  let sroSlot = i32(sroIds.y);
  let sroA = sroTexel(${TABLE_TEXEL.albedo}, sroSlot);
  let sroNc = sroTexel(${TABLE_TEXEL.nrao}, sroSlot);
  sroTSurf = sroTexel(${TABLE_TEXEL.surf}, sroSlot);
  sroTPar = sroTexel(${TABLE_TEXEL.params}, sroSlot);
  sroTMisc = sroTexel(${TABLE_TEXEL.misc}, sroSlot);
#ifdef SRO_SELFLIT
  sroTEm = sroTexel(${TABLE_TEXEL.emissive}, sroSlot);
#endif
  sroTFlags = u32(max(sroTPar.w, 0.0) + 0.5);
  sroTDp1 = dpdx(fragmentInputs.vPositionW);
  sroTDp2 = dpdy(fragmentInputs.vPositionW);
  sroTDuv1 = dpdx(sroUv);
  sroTDuv2 = dpdy(sroUv);
  let sroLd1 = dpdx(sroUv2);
  let sroLd2 = dpdy(sroUv2);
  let sroF = fract(sroUv);
  let sroAs = vec2f(sroA.w, sroTMisc.w);
  let sroAk = sroAs * sroGradK(sroAs, sroTDuv1, sroTDuv2);
  sroTAlb = textureSampleGrad(sroAlbArr, sroAlbArrSampler, sroA.yz + sroF * sroAs, i32(sroA.x + 0.5), sroTDuv1 * sroAk, sroTDuv2 * sroAk);
  sroTNr = vec4f(0.5, 0.5, sroTPar.y, 1.0);
  if (sroNc.x >= 0.0) {
    let sroNs = vec2f(sroNc.w, sroNc.w * sroTMisc.w / max(sroA.w, 1e-6));
    let sroNk = sroNs * sroGradK(sroNs, sroTDuv1, sroTDuv2);
    sroTNr = textureSampleGrad(sroNraoArr, sroNraoArrSampler, sroNc.yz + sroF * sroNs, i32(sroNc.x + 0.5), sroTDuv1 * sroNk, sroTDuv2 * sroNk);
  }
  sroTRough = select(sroTPar.y, sroTNr.z, (sroTFlags & ${TABLE_FLAG.roughness}u) != 0u);
  sroTAo = select(1.0, sroTNr.w, (sroTFlags & ${TABLE_FLAG.ao}u) != 0u);
  let sroLod = clamp(0.5 * log2(max(max(dot(sroLd1, sroLd1), dot(sroLd2, sroLd2)) * ${TABLE_LIGHTMAP_TEXELS2}, 1e-8)), 0.0, ${LM_MAX_LOD});
  sroTLm = textureSampleLevel(sroLmArr, sroLmArrSampler, sroUv2 - sroIds * 2.0, i32(sroIds.x), sroLod).rgb;
}
#endif
{
#ifdef SRO_TABLE
  sroLumaK = sroTSurf.x;
  sroWetRough = sroTSurf.z;
#else
  sroLumaK = uniforms.sroSurf.x;
  sroWetRough = uniforms.sroSurf.z;
#endif
  sroWetW = 0.0;
  sroPuddle = 0.0;
  sroDark = 1.0;
#ifdef SRO_WET
  var sroN = vec3f(0.0, 1.0, 0.0);
#ifdef NORMAL
  sroN = normalize(fragmentInputs.vNormalW);
#endif
  var sroShel = 1.0;
#ifdef SRO_SHELTER
  sroShel = sroShelter(fragmentInputs.vPositionW);
#endif
  let sroExpo = smoothstep(-0.5, -0.2, sroN.y) * mix(0.6, 1.0, smoothstep(0.0, 0.6, sroN.y));
  sroWetW = clamp(uniforms.sroWeather.y * sroExpo * sroShel, 0.0, 1.0);
#ifdef SRO_PUDDLES
  let sroFlat = smoothstep(0.95, 0.99, sroN.y);
  let sroP = 1.0 - uniforms.sroWeather.z * 0.45;
  let sroMask = 0.35 + sroNoise(fragmentInputs.vPositionW.xz * 0.15) * 0.3;
#ifdef SRO_TABLE
  sroPuddle = smoothstep(sroP - 0.05, sroP + 0.05, sroMask) * sroFlat * sroTSurf.w * sroShel;
#else
  sroPuddle = smoothstep(sroP - 0.05, sroP + 0.05, sroMask) * sroFlat * uniforms.sroSurf.w * sroShel;
#endif
#endif
#ifdef SRO_TABLE
  sroDark = mix(1.0, 1.0 - 0.5 * sroTSurf.y, sroWetW) * mix(1.0, 0.6, sroPuddle);
#else
  sroDark = mix(1.0, 1.0 - 0.5 * uniforms.sroSurf.y, sroWetW) * mix(1.0, 0.6, sroPuddle);
#endif
#ifdef SRO_RAIN
  let sroRr = clamp(uniforms.sroWeather.x, 0.0, 1.0);
#ifdef SRO_TABLE
  let sroPw = sroTSurf.w;
#else
  let sroPw = uniforms.sroSurf.w;
#endif
  sroFilm = smoothstep(0.02, 0.3, sroRr) * smoothstep(0.05, 0.35, sroWetW) * smoothstep(0.86, 0.96, sroN.y) * mix(${RAIN_OBJECT_FILM_MIN.toFixed(2)}, 1.0, clamp(sroPw * 1.15, 0.0, 1.0));
  sroRing = vec4f(0.0);
  if (sroFilm > 0.001) {
    let sroWp = fragmentInputs.vPositionW.xz;
    let sroTm = uniforms.sroRainT.x;
    let sroRa = sroFilm * (1.0 - smoothstep(${RAIN_OBJECT_FADE_M[0].toFixed(1)}, ${RAIN_OBJECT_FADE_M[1].toFixed(1)}, distance(fragmentInputs.vPositionW, scene.vEyePosition.xyz)));
    sroRing = (sroRainCells(sroWp / ${RAIN_CELLS_M[0].toFixed(2)}, sroTm, sroRr) + sroRainCells(vec2f(sroWp.x * 0.8 - sroWp.y * 0.6, sroWp.x * 0.6 + sroWp.y * 0.8) / ${RAIN_CELLS_M[1].toFixed(2)} + vec2f(0.37, 0.61), sroTm + 0.5, sroRr)) * sroRa;
  }
#endif
#endif
}
`,
    CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
#ifdef SRO_TABLE
surfaceAlbedo = vAlbedoColor.rgb * toLinearSpaceVec3(sroTAlb.rgb);
#ifdef ALPHATEST
alpha = vAlbedoColor.a * sroTAlb.a * (ALPHATESTVALUE / max(sroTMisc.z, ${MIN_CUT}));
#endif
#endif
sroLuma = dot(surfaceAlbedo, ${LUMA_WGSL});
#ifdef SRO_WET
surfaceAlbedo = surfaceAlbedo * sroDark;
#ifdef SRO_RAIN
surfaceAlbedo = surfaceAlbedo * clamp(1.0 + sroRing.w * ${RAIN_OBJECT_CONTRAST.toFixed(2)}, 0.4, 1.8);
surfaceAlbedo = mix(surfaceAlbedo, vec3f(0.45), clamp(sroRing.z * 0.8, 0.0, 1.0));
#endif
#endif
`,
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `
#ifdef SRO_TABLE
metallicRoughness = vec2f(sroTPar.x, sroTRough);
#endif
metallicRoughness = vec2f(metallicRoughness.x, sroRoughness(metallicRoughness.y));
`,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#ifdef SRO_TABLE
if ((sroTFlags & ${TABLE_FLAG.normal}u) != 0u) {
  let sroXY = sroTNr.xy * 2.0 - 1.0;
  let sroTs = vec3f(sroXY * sroTPar.z, sqrt(max(0.0, 1.0 - dot(sroXY, sroXY))));
  let sroP2p = cross(sroTDp2, normalW);
  let sroP1p = cross(normalW, sroTDp1);
  let sroT = sroP2p * sroTDuv1.x + sroP1p * sroTDuv2.x;
  let sroB = sroP2p * sroTDuv1.y + sroP1p * sroTDuv2.y;
  let sroDet = max(dot(sroT, sroT), dot(sroB, sroB));
  let sroInv = select(inverseSqrt(sroDet), 0.0, sroDet == 0.0);
  normalW = normalize(mat3x3f(sroT * sroInv, sroB * sroInv, normalW) * sroTs);
}
#endif
#ifdef SRO_WET
normalW = normalize(mix(normalW, geometricNormalW, 0.5 * sroWetW));
#ifdef SRO_PUDDLES
normalW = normalize(mix(normalW, vec3f(0.0, 1.0, 0.0), sroPuddle));
#endif
#ifdef SRO_RAIN
normalW = normalize(mix(normalW, geometricNormalW, 0.7 * sroFilm) + vec3f(sroRing.x, 0.0, sroRing.y) * ${RAIN_OBJECT_GAIN.toFixed(2)});
#endif
#endif
`,
    CUSTOM_LIGHT0_COLOR: `
#if defined(SRO_BAKED) || defined(SRO_CLOUDSHADOW)
{
  var sroVis = 1.0;
#ifdef SRO_BAKED
#ifdef SRO_TABLE
  let sroLm = dot(sroTLm, ${LUMA_WGSL});
#else
  let sroLm = dot(lightmapColor.rgb, ${LUMA_WGSL});
#endif
  let sroBaked = mix(1.0, clamp((sroLm - uniforms.sroBake.x) * uniforms.sroBake.y, 0.0, 1.0), uniforms.sroSun.x);
  let sroDist = distance(fragmentInputs.vPositionW, scene.vEyePosition.xyz);
  let sroCsm = uniforms.sroSun.w * (1.0 - clamp((sroDist - uniforms.sroSun.y) * uniforms.sroSun.z, 0.0, 1.0));
  sroVis = mix(sroBaked, 1.0, sroCsm);
#endif
#ifdef SRO_CLOUDSHADOW
  sroVis = sroVis * sroCloudShadow(fragmentInputs.vPositionW);
#endif
  diffuse0 = vec4f(diffuse0.rgb * sroVis, diffuse0.a);
}
#endif
`,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef SRO_TABLE
#ifndef UNLIT
{
  let sroDI = sroTMisc.x;
  finalDiffuse = finalDiffuse * (sroDI * sroTAo);
  finalAmbient = finalAmbient * sroTAo;
#ifdef SPECULARTERM
  finalSpecularScaled = finalSpecularScaled * sroDI;
#endif
#ifdef SHEEN
  finalSheenScaled = finalSheenScaled * sroDI;
#endif
#ifdef REFLECTION
  finalIrradiance = finalIrradiance * sroTAo;
#if defined(ENVIRONMENTBRDF) && !defined(REFLECTIONMAP_SKYBOX)
  var sroEnv = 1.0;
#ifdef RADIANCEOCCLUSION
  sroEnv = environmentRadianceOcclusion(sroTAo, NdotVUnclamped);
#endif
#if defined(HORIZONOCCLUSION) && defined(REFLECTIONMAP_3D) && !defined(BUMP)
  if ((sroTFlags & ${TABLE_FLAG.normal}u) != 0u) {
    sroEnv = sroEnv * environmentHorizonOcclusion(-viewDirectionW, normalW, geometricNormalW);
  }
#endif
  finalRadianceScaled = finalRadianceScaled * sroEnv;
#ifdef SHEEN
  sheenOut.finalSheenRadianceScaled = sheenOut.finalSheenRadianceScaled * sroEnv;
#endif
#endif
#endif
}
#endif
#endif
#ifdef SRO_SELFLIT
finalEmissive = finalEmissive * surfaceAlbedo;
#endif
#ifdef SRO_TABLE
#ifdef SRO_SELFLIT
finalEmissive = sroTEm.rgb * uniforms.vLightingIntensity.y * select(vec3f(1.0), surfaceAlbedo, sroTEm.a > 0.5);
#endif
#endif
#ifdef SRO_BAKED
{
#ifdef SRO_TABLE
  let sroLmA = dot(sroTLm, ${LUMA_WGSL});
#else
  let sroLmA = dot(lightmapColor.rgb, ${LUMA_WGSL});
#endif
  let sroAO = mix(1.0, clamp(sroLmA * uniforms.sroBake.z, 0.0, 1.0), uniforms.sroBake.w);
#if !defined(UNLIT) && defined(REFLECTION)
  finalIrradiance = finalIrradiance * sroAO;
#endif
  finalAmbient = finalAmbient * sroAO;
}
#endif
#if defined(SRO_WET) && defined(REFLECTION) && !defined(UNLIT)
{
  let sroIn = dot((finalIrradiance + finalDiffuse) / max(surfaceAlbedo, vec3f(0.02)), ${LUMA_WGSL});
  let sroRefl = dot(finalRadianceScaled, ${LUMA_WGSL});
  let sroK = min(1.0, sroIn * ${WET_REFLECT_MAX.toFixed(2)} / max(sroRefl, 1e-6));
  finalRadianceScaled = finalRadianceScaled * mix(1.0, sroK, clamp(max(sroWetW, sroPuddle), 0.0, 1.0));
}
#endif
#ifdef SRO_LAMP
finalEmissive = finalEmissive + surfaceAlbedo * (uniforms.sroMisc.x * uniforms.sroMisc.z);
#endif
`,
    CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#if defined(PREPASS_REFLECTIVITY) && !defined(UNLIT)
{
  let sroFlatN = smoothstep(0.9, 0.98, geometricNormalW.y);
#ifdef SRO_TABLE
  let sroM = clamp(max(sroTMisc.y, max(sroPuddle, sroWetW * sroFlatN)), 0.0, 1.0);
#else
  let sroM = clamp(max(uniforms.sroMisc.y, max(sroPuddle, sroWetW * sroFlatN)), 0.0, 1.0);
#endif
  specularEnvironmentR0 = max(specularEnvironmentR0, vec3f(0.02 + 0.18 * sroM));
  microSurface = max(microSurface, mix(microSurface, 0.95, sroM));
}
#endif
`,
  }
}

function glslCode(shelter: string, cloud: string): Record<string, string> {
  const shelterTex = /uniform\s+(highp\s+)?sampler2D\s+wxOccMap\b/.test(shelter) ? '' : 'uniform sampler2D wxOccMap;\n'
  const cloudTex = /uniform\s+(highp\s+)?sampler2D\s+cloudNoise\b/.test(cloud) ? '' : 'uniform sampler2D cloudNoise;\n'
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef SRO_SHELTER
${shelterTex}${shelter}
#endif
#ifdef SRO_CLOUDSHADOW
${cloudTex}${cloud}
#endif
float sroLuma;
float sroLumaK;
float sroWetW;
float sroWetRough;
float sroPuddle;
float sroDark;
#ifdef SRO_RAIN
float sroFilm;
vec4 sroRing;
#endif
float sroHash(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + vec3(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
float sroNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (vec2(3.0) - 2.0 * f);
  return mix(mix(sroHash(i), sroHash(i + vec2(1.0, 0.0)), u.x), mix(sroHash(i + vec2(0.0, 1.0)), sroHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sroRoughness(float r) {
  float o = r;
#ifdef SRO_LUMA_ROUGH
  o = clamp(o + sroLumaK * (0.5 - sroLuma), 0.02, 1.0);
#endif
#ifdef SRO_WET
  o = mix(o, sroWetRough, sroWetW);
  o = mix(o, 0.03, sroPuddle);
#ifdef SRO_RAIN
  o = mix(o, min(o, 0.08), sroFilm);
#endif
#endif
  return o;
}
#ifdef SRO_RAIN
${rainCellCode('glsl', 'sroRainCells', 'sroHash')}#endif
#ifdef SRO_TABLE
uniform highp sampler2DArray sroAlbArr;
uniform highp sampler2DArray sroNraoArr;
uniform highp sampler2DArray sroLmArr;
uniform highp sampler2D sroTable;
vec4 sroTAlb;
vec4 sroTNr;
vec4 sroTSurf;
vec4 sroTPar;
vec4 sroTMisc;
vec4 sroTEm;
vec3 sroTLm;
float sroTRough;
float sroTAo;
uint sroTFlags;
vec3 sroTDp1;
vec3 sroTDp2;
vec2 sroTDuv1;
vec2 sroTDuv2;
vec4 sroTexel(int k, int slot) {
  return texelFetch(sroTable, ivec2(k, slot), 0);
}
float sroGradK(vec2 s, vec2 d1, vec2 d2) {
  float inner = max(min(s.x, s.y) * ${ATLAS_PAGE_F}, 1.0);
  float lim = exp2(max(2.0, floor(log2(inner) + 0.05) - 5.0));
  vec2 t1 = d1 * s * ${ATLAS_PAGE_F};
  vec2 t2 = d2 * s * ${ATLAS_PAGE_F};
  float m = max(max(dot(t1, t1), dot(t2, t2)), 1e-20);
  return m > lim * lim ? lim * inversesqrt(m) : 1.0;
}
#endif
`,
    CUSTOM_FRAGMENT_MAIN_BEGIN: `
#ifdef SRO_TABLE
{
  vec2 sroUv = vMainUV1;
  vec2 sroUv2 = vMainUV2;
  vec2 sroIds = floor(sroUv2 * 0.5);
  int sroSlot = int(sroIds.y);
  vec4 sroA = sroTexel(${TABLE_TEXEL.albedo}, sroSlot);
  vec4 sroNc = sroTexel(${TABLE_TEXEL.nrao}, sroSlot);
  sroTSurf = sroTexel(${TABLE_TEXEL.surf}, sroSlot);
  sroTPar = sroTexel(${TABLE_TEXEL.params}, sroSlot);
  sroTMisc = sroTexel(${TABLE_TEXEL.misc}, sroSlot);
#ifdef SRO_SELFLIT
  sroTEm = sroTexel(${TABLE_TEXEL.emissive}, sroSlot);
#endif
  sroTFlags = uint(max(sroTPar.w, 0.0) + 0.5);
  sroTDp1 = dFdx(vPositionW);
  sroTDp2 = dFdy(vPositionW);
  sroTDuv1 = dFdx(sroUv);
  sroTDuv2 = dFdy(sroUv);
  vec2 sroLd1 = dFdx(sroUv2);
  vec2 sroLd2 = dFdy(sroUv2);
  vec2 sroF = fract(sroUv);
  vec2 sroAs = vec2(sroA.w, sroTMisc.w);
  vec2 sroAk = sroAs * sroGradK(sroAs, sroTDuv1, sroTDuv2);
  sroTAlb = textureGrad(sroAlbArr, vec3(sroA.yz + sroF * sroAs, floor(sroA.x + 0.5)), sroTDuv1 * sroAk, sroTDuv2 * sroAk);
  sroTNr = vec4(0.5, 0.5, sroTPar.y, 1.0);
  if (sroNc.x >= 0.0) {
    vec2 sroNs = vec2(sroNc.w, sroNc.w * sroTMisc.w / max(sroA.w, 1e-6));
    vec2 sroNk = sroNs * sroGradK(sroNs, sroTDuv1, sroTDuv2);
    sroTNr = textureGrad(sroNraoArr, vec3(sroNc.yz + sroF * sroNs, floor(sroNc.x + 0.5)), sroTDuv1 * sroNk, sroTDuv2 * sroNk);
  }
  sroTRough = (sroTFlags & ${TABLE_FLAG.roughness}u) != 0u ? sroTNr.z : sroTPar.y;
  sroTAo = (sroTFlags & ${TABLE_FLAG.ao}u) != 0u ? sroTNr.w : 1.0;
  float sroLod = clamp(0.5 * log2(max(max(dot(sroLd1, sroLd1), dot(sroLd2, sroLd2)) * ${TABLE_LIGHTMAP_TEXELS2}, 1e-8)), 0.0, ${LM_MAX_LOD});
  sroTLm = textureLod(sroLmArr, vec3(sroUv2 - sroIds * 2.0, sroIds.x), sroLod).rgb;
}
#endif
{
#ifdef SRO_TABLE
  sroLumaK = sroTSurf.x;
  sroWetRough = sroTSurf.z;
#else
  sroLumaK = sroSurf.x;
  sroWetRough = sroSurf.z;
#endif
  sroWetW = 0.0;
  sroPuddle = 0.0;
  sroDark = 1.0;
#ifdef SRO_WET
  vec3 sroN = vec3(0.0, 1.0, 0.0);
#ifdef NORMAL
  sroN = normalize(vNormalW);
#endif
  float sroShel = 1.0;
#ifdef SRO_SHELTER
  sroShel = sroShelter(vPositionW);
#endif
  float sroExpo = smoothstep(-0.5, -0.2, sroN.y) * mix(0.6, 1.0, smoothstep(0.0, 0.6, sroN.y));
  sroWetW = clamp(sroWeather.y * sroExpo * sroShel, 0.0, 1.0);
#ifdef SRO_PUDDLES
  float sroFlat = smoothstep(0.95, 0.99, sroN.y);
  float sroP = 1.0 - sroWeather.z * 0.45;
  float sroMask = 0.35 + sroNoise(vPositionW.xz * 0.15) * 0.3;
#ifdef SRO_TABLE
  sroPuddle = smoothstep(sroP - 0.05, sroP + 0.05, sroMask) * sroFlat * sroTSurf.w * sroShel;
#else
  sroPuddle = smoothstep(sroP - 0.05, sroP + 0.05, sroMask) * sroFlat * sroSurf.w * sroShel;
#endif
#endif
#ifdef SRO_TABLE
  sroDark = mix(1.0, 1.0 - 0.5 * sroTSurf.y, sroWetW) * mix(1.0, 0.6, sroPuddle);
#else
  sroDark = mix(1.0, 1.0 - 0.5 * sroSurf.y, sroWetW) * mix(1.0, 0.6, sroPuddle);
#endif
#ifdef SRO_RAIN
  float sroRr = clamp(sroWeather.x, 0.0, 1.0);
#ifdef SRO_TABLE
  float sroPw = sroTSurf.w;
#else
  float sroPw = sroSurf.w;
#endif
  sroFilm = smoothstep(0.02, 0.3, sroRr) * smoothstep(0.05, 0.35, sroWetW) * smoothstep(0.86, 0.96, sroN.y) * mix(${RAIN_OBJECT_FILM_MIN.toFixed(2)}, 1.0, clamp(sroPw * 1.15, 0.0, 1.0));
  sroRing = vec4(0.0);
  if (sroFilm > 0.001) {
    vec2 sroWp = vPositionW.xz;
    float sroTm = sroRainT.x;
    float sroRa = sroFilm * (1.0 - smoothstep(${RAIN_OBJECT_FADE_M[0].toFixed(1)}, ${RAIN_OBJECT_FADE_M[1].toFixed(1)}, distance(vPositionW, vEyePosition.xyz)));
    sroRing = (sroRainCells(sroWp / ${RAIN_CELLS_M[0].toFixed(2)}, sroTm, sroRr) + sroRainCells(vec2(sroWp.x * 0.8 - sroWp.y * 0.6, sroWp.x * 0.6 + sroWp.y * 0.8) / ${RAIN_CELLS_M[1].toFixed(2)} + vec2(0.37, 0.61), sroTm + 0.5, sroRr)) * sroRa;
  }
#endif
#endif
}
`,
    CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
#ifdef SRO_TABLE
surfaceAlbedo = vAlbedoColor.rgb * toLinearSpace(sroTAlb.rgb);
#ifdef ALPHATEST
alpha = vAlbedoColor.a * sroTAlb.a * (ALPHATESTVALUE / max(sroTMisc.z, ${MIN_CUT}));
#endif
#endif
sroLuma = dot(surfaceAlbedo, ${LUMA_GLSL});
#ifdef SRO_WET
surfaceAlbedo = surfaceAlbedo * sroDark;
#ifdef SRO_RAIN
surfaceAlbedo = surfaceAlbedo * clamp(1.0 + sroRing.w * ${RAIN_OBJECT_CONTRAST.toFixed(2)}, 0.4, 1.8);
surfaceAlbedo = mix(surfaceAlbedo, vec3(0.45), clamp(sroRing.z * 0.8, 0.0, 1.0));
#endif
#endif
`,
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `
#ifdef SRO_TABLE
metallicRoughness = vec2(sroTPar.x, sroTRough);
#endif
metallicRoughness = vec2(metallicRoughness.x, sroRoughness(metallicRoughness.y));
`,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#ifdef SRO_TABLE
if ((sroTFlags & ${TABLE_FLAG.normal}u) != 0u) {
  vec2 sroXY = sroTNr.xy * 2.0 - 1.0;
  vec3 sroTs = vec3(sroXY * sroTPar.z, sqrt(max(0.0, 1.0 - dot(sroXY, sroXY))));
  vec3 sroP2p = cross(sroTDp2, normalW);
  vec3 sroP1p = cross(normalW, sroTDp1);
  vec3 sroT = sroP2p * sroTDuv1.x + sroP1p * sroTDuv2.x;
  vec3 sroB = sroP2p * sroTDuv1.y + sroP1p * sroTDuv2.y;
  float sroDet = max(dot(sroT, sroT), dot(sroB, sroB));
  float sroInv = sroDet == 0.0 ? 0.0 : inversesqrt(sroDet);
  normalW = normalize(mat3(sroT * sroInv, sroB * sroInv, normalW) * sroTs);
}
#endif
#ifdef SRO_WET
normalW = normalize(mix(normalW, geometricNormalW, 0.5 * sroWetW));
#ifdef SRO_PUDDLES
normalW = normalize(mix(normalW, vec3(0.0, 1.0, 0.0), sroPuddle));
#endif
#ifdef SRO_RAIN
normalW = normalize(mix(normalW, geometricNormalW, 0.7 * sroFilm) + vec3(sroRing.x, 0.0, sroRing.y) * ${RAIN_OBJECT_GAIN.toFixed(2)});
#endif
#endif
`,
    CUSTOM_LIGHT0_COLOR: `
#if defined(SRO_BAKED) || defined(SRO_CLOUDSHADOW)
{
  float sroVis = 1.0;
#ifdef SRO_BAKED
#ifdef SRO_TABLE
  float sroLm = dot(sroTLm, ${LUMA_GLSL});
#else
  float sroLm = dot(lightmapColor.rgb, ${LUMA_GLSL});
#endif
  float sroBaked = mix(1.0, clamp((sroLm - sroBake.x) * sroBake.y, 0.0, 1.0), sroSun.x);
  float sroDist = distance(vPositionW, vEyePosition.xyz);
  float sroCsm = sroSun.w * (1.0 - clamp((sroDist - sroSun.y) * sroSun.z, 0.0, 1.0));
  sroVis = mix(sroBaked, 1.0, sroCsm);
#endif
#ifdef SRO_CLOUDSHADOW
  sroVis = sroVis * sroCloudShadow(vPositionW);
#endif
  diffuse0 = vec4(diffuse0.rgb * sroVis, diffuse0.a);
}
#endif
`,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef SRO_TABLE
#ifndef UNLIT
{
  float sroDI = sroTMisc.x;
  finalDiffuse = finalDiffuse * (sroDI * sroTAo);
  finalAmbient = finalAmbient * sroTAo;
#ifdef SPECULARTERM
  finalSpecularScaled = finalSpecularScaled * sroDI;
#endif
#ifdef SHEEN
  finalSheenScaled = finalSheenScaled * sroDI;
#endif
#ifdef REFLECTION
  finalIrradiance = finalIrradiance * sroTAo;
#if defined(ENVIRONMENTBRDF) && !defined(REFLECTIONMAP_SKYBOX)
  float sroEnv = 1.0;
#ifdef RADIANCEOCCLUSION
  sroEnv = environmentRadianceOcclusion(sroTAo, NdotVUnclamped);
#endif
#if defined(HORIZONOCCLUSION) && defined(REFLECTIONMAP_3D) && !defined(BUMP)
  if ((sroTFlags & ${TABLE_FLAG.normal}u) != 0u) {
    sroEnv = sroEnv * environmentHorizonOcclusion(-viewDirectionW, normalW, geometricNormalW);
  }
#endif
  finalRadianceScaled = finalRadianceScaled * sroEnv;
#ifdef SHEEN
  sheenOut.finalSheenRadianceScaled = sheenOut.finalSheenRadianceScaled * sroEnv;
#endif
#endif
#endif
}
#endif
#endif
#ifdef SRO_SELFLIT
finalEmissive = finalEmissive * surfaceAlbedo;
#endif
#ifdef SRO_TABLE
#ifdef SRO_SELFLIT
finalEmissive = sroTEm.rgb * vLightingIntensity.y * (sroTEm.a > 0.5 ? surfaceAlbedo : vec3(1.0));
#endif
#endif
#ifdef SRO_BAKED
{
#ifdef SRO_TABLE
  float sroLmA = dot(sroTLm, ${LUMA_GLSL});
#else
  float sroLmA = dot(lightmapColor.rgb, ${LUMA_GLSL});
#endif
  float sroAO = mix(1.0, clamp(sroLmA * sroBake.z, 0.0, 1.0), sroBake.w);
#if !defined(UNLIT) && defined(REFLECTION)
  finalIrradiance = finalIrradiance * sroAO;
#endif
  finalAmbient = finalAmbient * sroAO;
}
#endif
#if defined(SRO_WET) && defined(REFLECTION) && !defined(UNLIT)
{
  float sroIn = dot((finalIrradiance + finalDiffuse) / max(surfaceAlbedo, vec3(0.02)), ${LUMA_GLSL});
  float sroRefl = dot(finalRadianceScaled, ${LUMA_GLSL});
  float sroK = min(1.0, sroIn * ${WET_REFLECT_MAX.toFixed(2)} / max(sroRefl, 1e-6));
  finalRadianceScaled = finalRadianceScaled * mix(1.0, sroK, clamp(max(sroWetW, sroPuddle), 0.0, 1.0));
}
#endif
#ifdef SRO_LAMP
finalEmissive = finalEmissive + surfaceAlbedo * (sroMisc.x * sroMisc.z);
#endif
`,
    CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#if defined(PREPASS_REFLECTIVITY) && !defined(UNLIT)
{
  float sroFlatN = smoothstep(0.9, 0.98, geometricNormalW.y);
#ifdef SRO_TABLE
  float sroM = clamp(max(sroTMisc.y, max(sroPuddle, sroWetW * sroFlatN)), 0.0, 1.0);
#else
  float sroM = clamp(max(sroMisc.y, max(sroPuddle, sroWetW * sroFlatN)), 0.0, 1.0);
#endif
  specularEnvironmentR0 = max(specularEnvironmentR0, vec3(0.02 + 0.18 * sroM));
  microSurface = max(microSurface, mix(microSurface, 0.95, sroM));
}
#endif
`,
  }
}

let codeCache: { wgsl: Record<string, string>; glsl: Record<string, string> } | null = null

/** Every point sits under SRO_SURFACE: a disabled plugin (a character back on the Classic path) preprocesses away. */
function gated(code: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(code)) out[k] = `#ifdef SRO_SURFACE\n${v.trim()}\n#endif\n`
  return out
}

/** The fragment injection points of the plugin per language (the same keys in both; test/pbr-plugins.test.ts). */
export function surfaceFragmentCode(lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> {
  codeCache ??= {
    wgsl: gated(wgslCode(shelterWgsl(), cloudWgsl())),
    glsl: gated(glslCode(shelterGlsl(), cloudGlsl())),
  }
  return codeCache[lang]
}

// The chunk functions are used only when both languages ship them.
const hasShelterFn = () => WX_SHELTER_WGSL.trim() !== '' && WX_SHELTER_GLSL.trim() !== ''
const hasCloudFn = () => SKY_CLOUD_SHADOW_WGSL.trim() !== '' && SKY_CLOUD_SHADOW_GLSL.trim() !== ''
const shelterWgsl = () => (hasShelterFn() ? WX_SHELTER_WGSL : '')
const shelterGlsl = () => (hasShelterFn() ? WX_SHELTER_GLSL : '')
const cloudWgsl = () => (hasCloudFn() ? SKY_CLOUD_SHADOW_WGSL : '')
const cloudGlsl = () => (hasCloudFn() ? SKY_CLOUD_SHADOW_GLSL : '')

/** The plugin's own UBO entries (vec4 each). */
const OWN_UNIFORMS = ['sroSurf', 'sroBake', 'sroSun', 'sroWeather', 'sroMisc', 'sroRainT'] as const
/** Every UBO entry (vec4): its own, then what the shelter and cloud-shadow functions read. */
export const SURFACE_UNIFORMS: readonly string[] = [...new Set<string>([
  ...OWN_UNIFORMS, ...WX_SHELTER_UNIFORMS, ...SKY_CLOUD_SHADOW_UBO.map(u => u.name),
])]
export const SURFACE_SAMPLERS: readonly string[] = [WX_SHELTER_SAMPLER, 'cloudNoise']

const SURFACE_DEFINES = {
  SRO_SURFACE: false,
  SRO_LUMA_ROUGH: false,
  SRO_BAKED: false,
  SRO_WET: false,
  SRO_PUDDLES: false,
  SRO_RAIN: false,
  SRO_SHELTER: false,
  WX_OCC8: false,
  SRO_CLOUDSHADOW: false,
  SRO_LAMP: false,
  SRO_SELFLIT: false,
  SRO_TABLE: false,
}

// ---- shared state -------------------------------------------------------------------------------------------------

/** What the part reads from the world's weather (WorldWeather satisfies it). */
export interface SurfaceWeatherSource {
  readonly preset: Readonly<WeatherPreset>
  readonly shelter: ShelterMap | null
  readonly u: WeatherUniforms
}

/**
 * The values every SroSurfacePlugin of a world binds (by reference, one write per frame) and the define switches
 * they share; a switch change re-prepares every plugin's defines (one recompile per distinct define set).
 */
export class SurfaceShared {
  /** floor, 1 / range, 1 / p95, AO share (OBJECT_LIGHTMAP). */
  readonly bake = new Vector4(OBJECT_LIGHTMAP.floor, 1 / OBJECT_LIGHTMAP.range, 1 / OBJECT_LIGHTMAP.p95, OBJECT_LIGHTMAP.aoShare)
  /** D16: max(0.35, bakedWeight) of the key light this frame (bakedWeight()). */
  bakedK = 1
  /** rain, wetness, puddles, wind (RenderWeather). */
  readonly weather = new Vector4(0, 0, 0, 0.25)
  night = 0
  flash = 0
  wet = false
  puddles = false
  /** RAIN-P: the rain film and rings on flat floors (Medium+ weather: the level has ripples). */
  rings = false
  shelter: ShelterMap | null = null
  wx: WeatherUniforms | null = null
  cloud: Vector4 | null = null
  cloudProj: Vector4 | null = null
  cloudNoise: BaseTexture | null = null
  readonly plugins = new Set<SroSurfacePlugin>()

  get shelterOn(): boolean {
    return this.wet && this.shelter !== null && hasShelterFn()
  }

  /**
   * The define follows the preset and Options only (Ultra, cloud shadows on, the modern sky), not the sky's async
   * noise load (W9F R4: its arrival recompiled every object and character in play). Until the noise lands the
   * plugin binds a 1 × 1 black texture, for which sroCloudShadow returns 1 (no shadow): the arrival only rebinds.
   */
  get cloudOn(): boolean {
    return this.cloud !== null && this.cloudProj !== null && hasCloudFn()
  }

  /** Re-prepares every plugin's defines (after a switch changed). */
  dirtyAll(): void {
    for (const p of this.plugins) p.markAllDefinesAsDirty()
  }
}

const NO_CLOUD_NOISE = new WeakMap<Scene, RawTexture>()

/** A 1 × 1 black noise texture: sroCloudShadow gives 1 (no cloud shadow) for it. */
function noCloudNoise(scene: Scene): RawTexture {
  let t = NO_CLOUD_NOISE.get(scene)
  if (!t) {
    t = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene, false, false)
    t.name = 'sroNoCloudNoise'
    NO_CLOUD_NOISE.set(scene, t)
  }
  return t
}

// ---- the plugin ---------------------------------------------------------------------------------------------------

export interface SurfaceOptions {
  cls: MaterialClass
  /** The material has an object lightmap (SRO_BAKED). */
  baked?: boolean
  /** A cloth lantern or lamp (SRO_LAMP). */
  lamp?: boolean
  /** Retail self-illumination: the emissive samples the albedo (SRO_SELFLIT). */
  selfLit?: boolean
  /** A roughness map is bound (ORMH): no luminance roughness. */
  roughnessMap?: boolean
  /** Porosity from a review (`sro-pbr` params). */
  porosity?: number
  /**
   * BT-P (docs/BATCHING.md §3.4): a region batch's group material. Every per-material value comes from the material
   * table (TABLE_TEXEL) of the merged vertex's slot, the textures from BT-A's atlas arrays; the material itself binds no
   * 2D map (F8). The mesh needs `uv` and `uv2` (packTableUv2). Implies `baked` (a slot without a lightmap samples the
   * white quadrant); SRO_PUDDLES then follows the weather only (each slot's puddle weight is in its table row).
   */
  table?: SurfaceTable
}

export class SroSurfacePlugin extends MaterialPluginBase {
  cls: MaterialClass
  baked: boolean
  lamp: boolean
  /** SRO_SELFLIT (PbrSurfaces.addEmissive sets it and refreshes the defines). */
  selfLit: boolean
  roughnessMap: boolean
  /** luma roughness amount, porosity, wet roughness, puddle eligibility. */
  readonly surf = new Vector4()
  /** 1 for metal and polished marble (the SSR mask, D31). */
  ssr = 0
  private tableRef: SurfaceTable | null
  private enabled = true

  constructor(material: Material, readonly shared: SurfaceShared, opts: SurfaceOptions) {
    super(material, SRO_SURFACE_PLUGIN, 250, { ...SURFACE_DEFINES }, true, true)
    this.cls = opts.cls
    this.tableRef = opts.table ?? null
    this.baked = opts.baked ?? this.tableRef !== null
    this.lamp = opts.lamp ?? false
    this.selfLit = opts.selfLit ?? false
    this.roughnessMap = opts.roughnessMap ?? false
    const p = classParams(opts.cls)
    this.surf.set(0.1, opts.porosity ?? p.porosity, p.wetRoughness, p.puddle)
    this.ssr = opts.cls === 'metal' ? 1 : 0
    shared.plugins.add(this)
  }

  override getClassName(): string {
    return SRO_SURFACE_PLUGIN
  }

  /** WGSL and GLSL both (the base class answers GLSL only, and the manager throws on WGSL materials). */
  override isCompatible(): boolean {
    return true
  }

  /** Flags changed after creation (a late map landed): re-prepare this material's defines. */
  refresh(): void {
    this.markAllDefinesAsDirty()
  }

  /**
   * Off: every define is false and the injected code preprocesses away (Babylon cannot remove an active plugin; a
   * character switched back to the Classic path).
   */
  get isEnabled(): boolean {
    return this.enabled
  }

  set isEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    this.markAllDefinesAsDirty()
  }

  /** BT-P: the material table and atlases of a region batch's group material (SurfaceOptions.table); null: HEAD's. */
  get table(): SurfaceTable | null {
    return this.tableRef
  }

  /**
   * Switches a new group material to the table (BT-A's `BatchTables.bindMaterial`), or back (null). Meant once, before
   * the material's first draw; a later call rebuilds the material's uniform layout (the table samplers are registered
   * with it) and recompiles. `baked` follows (a table material always reads the lightmap array).
   */
  setTable(table: SurfaceTable | null): void {
    if (table === this.tableRef) return
    const had = this.tableRef !== null
    this.tableRef = table
    if (table) this.baked = true
    if (had !== (table !== null)) {
      // As Babylon does for a plugin added late (MaterialPluginManager._addPlugin): a fresh uniform buffer and layout.
      const m = this._material as unknown as { _uniformBufferLayoutBuilt?: boolean; resetDrawCache(): void; _createUniformBuffer?(): void }
      if (m._uniformBufferLayoutBuilt) {
        m.resetDrawCache()
        m._createUniformBuffer?.()
      }
    }
    this.markAllDefinesAsDirty()
  }

  /**
   * Table mode is on for a mesh with both UV sets (the atlas UV and the packed UV2, BATCHING §3.3); any other mesh (or
   * a disabled plugin) draws with HEAD's code.
   */
  tableOn(mesh: AbstractMesh): boolean {
    return this.tableRef !== null && this.enabled && mesh.isVerticesDataPresent(VertexBuffer.UVKind) && mesh.isVerticesDataPresent(VertexBuffer.UV2Kind)
  }

  /**
   * SRO_TABLE sets what the missing textures would have (F8): the atlas UV (MAINUV1) and the lightmap UV (MAINUV2)
   * varyings, before Babylon reads the mesh's attributes (`PrepareDefinesForAttributes` then turns on UV1 / UV2).
   */
  override prepareDefinesBeforeAttributes(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    if (!this.tableOn(mesh)) return
    const d = defines as MaterialDefines & Record<string, unknown>
    d._needUVs = true
    d.MAINUV1 = true
    d.MAINUV2 = true
  }

  override prepareDefines(defines: MaterialDefines, _scene?: Scene, mesh?: AbstractMesh): void {
    const d = defines as MaterialDefines & Record<string, unknown>
    const s = this.shared
    if (!this.enabled) {
      for (const k of Object.keys(SURFACE_DEFINES)) d[k] = false
      return
    }
    const table = !!mesh && this.tableOn(mesh)
    d.SRO_TABLE = table
    d.SRO_SURFACE = true
    d.SRO_LUMA_ROUGH = !this.roughnessMap
    const baked = this.baked && d.LIGHTMAP === true
    d.SRO_BAKED = baked || table
    if (baked) {
      // The lightmap is baked sun visibility (§3.4), read raw: no colour multiply, no gamma decode.
      d.LIGHTMAPEXCLUDED = true
      d.GAMMALIGHTMAP = false
    }
    d.SRO_WET = s.wet
    d.SRO_PUDDLES = s.wet && s.puddles && (table || this.surf.w > 0)
    d.SRO_RAIN = s.wet && s.rings && (table || (this.baked && RAIN_FILM_CLASSES.has(this.cls)))
    d.SRO_SHELTER = s.shelterOn
    d.WX_OCC8 = s.shelterOn && (s.shelter as { packed?: boolean } | null)?.packed === true
    d.SRO_CLOUDSHADOW = s.cloudOn
    d.SRO_LAMP = this.lamp
    d.SRO_SELFLIT = this.selfLit
  }

  override getUniforms(shaderLanguage?: ShaderLanguage): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    return {
      ubo: SURFACE_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' })),
      // GLSL without uniform buffers declares them itself; WGSL reads them from the UBO.
      fragment: shaderLanguage === ShaderLanguage.WGSL ? '' : SURFACE_UNIFORMS.map(n => `uniform vec4 ${n};`).join('\n'),
    }
  }

  override getSamplers(samplers: string[]): void {
    samplers.push(...SURFACE_SAMPLERS)
    // Babylon collects the samplers once per material (its uniform layout): a table material registers them up front.
    if (this.tableRef) samplers.push(...SURFACE_TABLE_SAMPLERS)
  }

  /** A table-mode effect waits for every table texture (a missing binding would drop the WebGPU frame). */
  override isReadyForSubMesh(defines: MaterialDefines): boolean {
    if (!(defines as MaterialDefines & Record<string, unknown>).SRO_TABLE) return true
    const t = this.tableRef
    return !!t && [t.albedo, t.nrao, t.lightmap, t.table].every(x => !!x && x.isReady())
  }

  override bindForSubMesh(ubo: UniformBuffer, scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    if (!this.enabled) return
    const s = this.shared
    const t = this.tableRef
    if (t && (subMesh.materialDefines as (MaterialDefines & Record<string, unknown>) | null)?.SRO_TABLE) {
      if (t.albedo) ubo.setTexture('sroAlbArr', t.albedo)
      if (t.nrao) ubo.setTexture('sroNraoArr', t.nrao)
      if (t.lightmap) ubo.setTexture('sroLmArr', t.lightmap)
      if (t.table) ubo.setTexture('sroTable', t.table)
    }
    ubo.updateVector4('sroSurf', this.surf)
    ubo.updateVector4('sroBake', s.bake)
    // The CSM takes over within its range, fading over the last 20% (RND-L); no CSM on this mesh: baked shadows only.
    const range = this.baked ? csmRange(subMesh, scene) : 0
    ubo.updateFloat4('sroSun', s.bakedK, range * 0.8, range > 0 ? 5 / range : 0, range > 0 ? 1 : 0)
    ubo.updateVector4('sroWeather', s.weather)
    ubo.updateFloat4('sroMisc', s.night, this.ssr, LAMP_EMISSIVE, s.flash)
    ubo.updateFloat4('sroRainT', s.wx?.wxA.w ?? 0, 0, 0, 0)
    if (s.shelterOn && s.shelter && s.wx) {
      const wx = s.wx as unknown as Record<string, Vector4 | undefined>
      for (const n of WX_SHELTER_UNIFORMS) {
        const v = wx[n]
        if (v) ubo.updateVector4(n, v)
      }
      ubo.setTexture(WX_SHELTER_SAMPLER, s.shelter.texture)
    }
    if (s.cloudOn) {
      ubo.updateVector4('skyCloudShadow', s.cloud!)
      ubo.updateVector4('skyCloudProj', s.cloudProj!)
      ubo.setTexture('cloudNoise', s.cloudNoise ?? noCloudNoise(scene))
    }
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return { ...surfaceFragmentCode(shaderLanguage === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') }
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.shared.plugins.delete(this)
    super.dispose(forceDisposeTextures)
  }
}

/** Light 0's CSM range (m) when the mesh receives its shadows; 0 = none (the same rule as the terrain plugin). */
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

/** The surface plugin of a material, if it has one. */
export function surfacePluginOf(mat: Material): SroSurfacePlugin | null {
  const p = mat.pluginManager?.getPlugin(SRO_SURFACE_PLUGIN)
  return p instanceof SroSurfacePlugin ? p : null
}

// ---- class extras (DETAIL H4, H6) ---------------------------------------------------------------------------------

/** Class features per tier: cloth sheen on High+ (H4); skin F0 0.028 always, translucency on Ultra (H6). */
export function applyClassExtras(mat: PBRMaterial, cls: MaterialClass, tier: MaterialTier): void {
  if (cls === 'cloth') {
    const on = tier === 'high' || tier === 'ultra'
    if (mat.sheen.isEnabled !== on) mat.sheen.isEnabled = on
    if (on) {
      mat.sheen.intensity = 0.4
      mat.sheen.color = new Color3(1, 1, 1)
      mat.sheen.roughness = 0.5
    }
  }
  if (cls === 'skin') {
    mat.subSurface.indexOfRefraction = SKIN_IOR
    const on = tier === 'ultra'
    if (mat.subSurface.isTranslucencyEnabled !== on) mat.subSurface.isTranslucencyEnabled = on
    if (on) {
      mat.subSurface.translucencyIntensity = classParams('skin').translucency
      mat.subSurface.tintColor = new Color3(1, 0.45, 0.35)
      mat.subSurface.minimumThickness = 0
      mat.subSurface.maximumThickness = 1
    }
  }
}

/** Undoes applyClassExtras (the Classic path keeps today's character materials). */
function removeClassExtras(mat: PBRMaterial, cls: MaterialClass, ior: number): void {
  if (cls === 'cloth' && mat.sheen.isEnabled) mat.sheen.isEnabled = false
  if (cls === 'skin') {
    mat.subSurface.indexOfRefraction = ior
    if (mat.subSurface.isTranslucencyEnabled) mat.subSurface.isTranslucencyEnabled = false
  }
}

/** A character / equipment texture's class from its glTF image name (the retail stem) and material name. */
export function classifyActor(image: string, materialName = ''): MaterialClass {
  if (/_(face|body|hand)/i.test(image) || /_(face|body|hand)/i.test(materialName)) return 'skin'
  return classify(image, { materialName })
}

// ---- the render part ----------------------------------------------------------------------------------------------

interface CharacterEntry {
  /** Attached on the first dress on the PBR path (a character that stays Classic never gets one). */
  plugin: SroSurfacePlugin | null
  cls: MaterialClass
  orig: { metallic: number | null; roughness: number | null; ior: number; specularAA: boolean; emissive: Color3 }
}

/** A self-lit material (addEmissive): its retail emissive colour and plugin. */
interface EmissiveEntry {
  base: Color3
  plugin: SroSurfacePlugin
}

/** A batch slot with a retail emissive (addSlotEmissive): its colour and the table writer. */
interface SlotEmissiveEntry {
  base: Color3
  write: (r: number, g: number, b: number) => void
}

/** Is the colour (a retail emissive) black? */
const isBlack = (c: Readonly<Color3>) => !(c.r > 1e-4 || c.g > 1e-4 || c.b > 1e-4)

/** What the part needs of WorldRender (render/index.ts). */
export interface SurfaceRenderHost {
  readonly mode: RenderPath
  readonly quality: Readonly<RenderQuality>
  readonly weather: Readonly<RenderWeather>
  materials: RenderPart | null
}

export interface PbrSurfacesOptions {
  /** Textures for map sets (default: none; ObjectMaterials passes URL textures over its Assets). */
  source?: MapTextureSource
  /** Loads the map index (default: no sets). */
  loadIndex?: () => Promise<PbrMapIndex>
}

/**
 * RND-M's part of WorldRender (`world.render.materials`): the shared plugin state from the weather, the sky and the
 * preset; the map index and texture cache ObjectMaterials uses on the PBR path; the character decorator (GAME
 * registers `world.render.decorateCharacterMaterials` through ModelLibrary.addMaterialDecorator). On the Classic path
 * it does nothing, so Low stays HEAD's.
 */
export class PbrSurfaces implements RenderPart {
  readonly shared = new SurfaceShared()
  readonly cache: PbrTextureCache
  mode: RenderPath = 'classic'
  tier: MaterialTier = 'medium'
  /** TX-R: the texture setting (RenderQuality.textures; null = the page's setting, maps.ts pageTextureSetting). */
  textures: TextureSetting | null = null
  private weatherSource: SurfaceWeatherSource | null = null
  private render: SurfaceRenderHost | null = null
  private indexPromise: Promise<PbrMapIndex> | null = null
  private readonly loadIndex: () => Promise<PbrMapIndex>
  /** World materials with class extras (sheen / skin), re-applied when the tier changes. */
  private readonly extras = new Map<PBRMaterial, MaterialClass>()
  private readonly characters = new Map<PBRMaterial, CharacterEntry>()
  /** Self-lit materials (world objects and characters with a retail emissive), set from the ambient every frame. */
  private readonly emissive = new Map<PBRMaterial, EmissiveEntry>()
  /** BT-P: region batch slots with a retail emissive (addSlotEmissive), written every frame. */
  private readonly slotEmissive = new Set<SlotEmissiveEntry>()

  constructor(readonly scene: Scene, opts: PbrSurfacesOptions = {}) {
    this.cache = new PbrTextureCache(opts.source ?? NO_SOURCE)
    this.loadIndex = opts.loadIndex ?? (() => Promise.resolve(PbrMapIndex.EMPTY))
  }

  /**
   * Wires the part to a world's renderer and weather (World constructor). The part puts itself in
   * `render.materials` only while the path is PBR, so the Classic path (Low) has no render part at all
   * (seams-classic.test.ts); ObjectMaterials.mode forwards path switches here.
   */
  attach(render: SurfaceRenderHost, weather: SurfaceWeatherSource | null = null): this {
    this.render = render
    this.weatherSource = weather
    this.setQuality(render.quality)
    this.setMode(render.mode)
    this.install()
    return this
  }

  /** Joins or leaves WorldRender's parts with the path; on joining it takes the renderer's preset and weather. */
  private install(): void {
    const r = this.render
    if (!r) return
    if (this.mode === 'pbr') {
      if (r.materials === this) return
      r.materials = this
      this.setQuality(r.quality)
      this.setWeather(r.weather)
    } else if (r.materials === this) {
      r.materials = null
    }
  }

  /** The map sets (loaded once, on the first PBR conversion). */
  maps(): Promise<PbrMapIndex> {
    this.indexPromise ??= this.loadIndex().catch(() => PbrMapIndex.EMPTY)
    return this.indexPromise
  }

  /** What the current preset loads from the sets (D39). */
  policy(): MapPolicy {
    return mapPolicy(this.tier === 'classic' ? 'medium' : this.tier, { textures: this.textures ?? pageTextureSetting(), ktx2: ktx2MapsAvailable(this.scene) })
  }

  setMode(mode: RenderPath): void {
    if (mode === this.mode) return
    this.mode = mode
    for (const [mat, e] of this.characters) {
      if (mode === 'pbr') this.dressCharacter(mat, e)
      else this.undressCharacter(mat, e)
    }
    this.syncFlags()
    this.install()
  }

  setQuality(q: Readonly<RenderQuality>): void {
    this.textures = q.textures ?? null
    const tier = materialTier(q)
    const changed = tier !== this.tier
    this.tier = tier
    if (changed && tier !== 'classic') {
      for (const [mat, cls] of this.extras) applyClassExtras(mat, cls, tier)
      if (this.mode === 'pbr') for (const [mat, e] of this.characters) applyClassExtras(mat, e.cls, tier)
    }
    this.syncFlags()
  }

  setWeather(w: Readonly<RenderWeather>): void {
    this.shared.weather.set(w.rain, w.wetness, w.puddles, w.wind)
    this.shared.flash = w.flash
  }

  update(_camera: Camera | null, sky: Readonly<SkyState>): void {
    if (this.mode !== 'pbr') return
    const s = this.shared
    s.bakedK = bakedWeight(sky.keyLight.dir)
    s.night = sky.night
    // D28: objects take the cloud shadow on Ultra only.
    const ultra = this.tier === 'ultra'
    const before = s.cloudOn
    s.cloud = ultra ? sky.cloudShadow : null
    s.cloudProj = ultra ? (sky as { cloudShadowProj?: Vector4 | null }).cloudShadowProj ?? null : null
    s.cloudNoise = ultra ? sky.cloudNoise : null
    if (s.cloudOn !== before) s.dirtyAll()
    this.syncFlags()
    if (this.emissive.size || this.slotEmissive.size) {
      const a = sky.ambient.sky
      const k = EMISSIVE_AMBIENT * this.scene.environmentIntensity
      for (const [mat, e] of this.emissive) mat.emissiveColor.set(e.base.r * a[0] * k, e.base.g * a[1] * k, e.base.b * a[2] * k)
      for (const e of this.slotEmissive) e.write(e.base.r * a[0] * k, e.base.g * a[1] * k, e.base.b * a[2] * k)
    }
  }

  /**
   * BT-P (docs/BATCHING.md §3.7, §3.10): a region batch's lamp-group slot made from a material with a retail emissive
   * (addEmissive's materials, e.g. the luxury-house tiger) keeps its look: every frame on the PBR path its table
   * emissive (texel 5 rgb, whose a = 1 makes it sample the albedo) is `base × EMISSIVE_AMBIENT × the sky's up-facing
   * ambient`, written through `write` (BT-A's table). Returns the remover (the slot's release). Black colours are
   * ignored.
   */
  addSlotEmissive(base: Readonly<Color3>, write: (r: number, g: number, b: number) => void): () => void {
    if (isBlack(base)) return () => {}
    const e: SlotEmissiveEntry = { base: new Color3(base.r, base.g, base.b), write }
    this.slotEmissive.add(e)
    return () => {
      this.slotEmissive.delete(e)
    }
  }

  /** Batch slots with a retail emissive now (tests, the console). */
  get slotEmissiveCount(): number {
    return this.slotEmissive.size
  }

  /**
   * W9 LOOK: a material with a retail emissive (the Event So-Ok NPC's 0.59, the luxury-house tiger) becomes self-lit on
   * the PBR path. Babylon's PBR adds emissiveColor after the lighting, unmodulated and scene-linear, so a copied 0.59
   * showed at 0.59 × the exposure (8 by day, 24–40 at night): a glowing white figure. Here the emissive samples the
   * albedo (SRO_SELFLIT) and `update` sets it to base × EMISSIVE_AMBIENT × the ambient every frame: evenly lit like the
   * retail material, as bright as its surroundings. Black colours are ignored.
   */
  addEmissive(mat: PBRMaterial, plugin: SroSurfacePlugin, base: Readonly<Color3>): void {
    if (isBlack(base)) return
    this.emissive.set(mat, { base: new Color3(base.r, base.g, base.b), plugin })
    mat.emissiveColor.set(0, 0, 0)
    if (!plugin.selfLit) {
      plugin.selfLit = true
      plugin.refresh()
    }
  }

  /** Undoes addEmissive (the material's emissive goes back to its retail colour). */
  removeEmissive(mat: PBRMaterial): void {
    const e = this.emissive.get(mat)
    if (!e) return
    this.emissive.delete(mat)
    mat.emissiveColor.copyFrom(e.base)
    if (e.plugin.selfLit) {
      e.plugin.selfLit = false
      e.plugin.refresh()
    }
  }

  /** Self-lit materials now (tests, the console). */
  get emissiveCount(): number {
    return this.emissive.size
  }

  /** Reads the weather level's switches (rarely changing) and re-prepares the plugins when one flips. */
  private syncFlags(): void {
    const s = this.shared
    const ws = this.weatherSource
    const pbr = this.mode === 'pbr'
    const wet = pbr && !!ws?.preset.wet
    // RENDER §9.3: flat object floors get puddles on High+.
    const puddles = wet && !!ws?.preset.puddles && (this.tier === 'high' || this.tier === 'ultra')
    // RAIN-P: the rain film and rings on every PBR tier whose weather level has ripples (Medium+).
    const rings = wet && (ws?.preset.rippleSize ?? 0) > 0
    const shelter = wet ? ws?.shelter ?? null : null
    const onBefore = s.shelterOn
    const changed = wet !== s.wet || puddles !== s.puddles || rings !== s.rings
    s.wet = wet
    s.puddles = puddles
    s.rings = rings
    s.shelter = shelter
    s.wx = ws?.u ?? null
    if (changed || onBefore !== s.shelterOn) s.dirtyAll()
  }

  /** Registers a world material's class extras (sheen, skin) so a tier change updates it. */
  addExtras(mat: PBRMaterial, cls: MaterialClass): void {
    if (cls !== 'cloth' && cls !== 'skin') return
    this.extras.set(mat, cls)
    if (this.tier !== 'classic') applyClassExtras(mat, cls, this.tier)
  }

  removeExtras(mat: PBRMaterial): void {
    this.extras.delete(mat)
  }

  /**
   * A character / equipment material (RENDER §3.1: glTF PBRMaterial + SroSurfacePlugin on the PBR presets). The class
   * comes from the base texture's image name; the class roughness and metallic apply when the material has no
   * metallic texture (DETAIL H3/H4/H6 per tier). Idempotent. Through WorldRender it only runs on the PBR path (the
   * part is not a render part on Classic); called directly on Classic it records the material and a later switch to
   * PBR dresses it. Register it before WX-C's actor wetness decorator, which skips materials that carry this plugin.
   */
  decorateCharacterMaterial(mat: Material): void {
    if (!(mat instanceof PBRMaterial) || mat.unlit || this.characters.has(mat)) return
    if (surfacePluginOf(mat)) return
    const image = mat.albedoTexture?.getInternalTexture?.()?.label || mat.albedoTexture?.name || ''
    const cls = classifyActor(image, mat.name)
    const orig = { metallic: mat.metallic, roughness: mat.roughness, ior: mat.subSurface.indexOfRefraction, specularAA: mat.enableSpecularAntiAliasing, emissive: mat.emissiveColor.clone() }
    const e: CharacterEntry = { plugin: null, cls, orig }
    this.characters.set(mat, e)
    mat.onDisposeObservable.addOnce(() => {
      this.characters.delete(mat)
      this.emissive.delete(mat)
    })
    if (this.mode === 'pbr') this.dressCharacter(mat, e)
  }

  private dressCharacter(mat: PBRMaterial, e: CharacterEntry): void {
    const p = classParams(e.cls)
    if (!mat.metallicTexture) {
      mat.metallic = p.metallic
      mat.roughness = p.roughness
    }
    if (mat.bumpTexture) mat.enableSpecularAntiAliasing = true
    applyClassExtras(mat, e.cls, this.tier === 'classic' ? 'medium' : this.tier)
    if (e.plugin) e.plugin.isEnabled = true
    else e.plugin = new SroSurfacePlugin(mat, this.shared, { cls: e.cls, roughnessMap: !!mat.metallicTexture })
    this.addEmissive(mat, e.plugin, e.orig.emissive)
  }

  private undressCharacter(mat: PBRMaterial, e: CharacterEntry): void {
    this.removeEmissive(mat)
    if (e.plugin) e.plugin.isEnabled = false
    mat.metallic = e.orig.metallic
    mat.roughness = e.orig.roughness
    mat.enableSpecularAntiAliasing = e.orig.specularAA
    removeClassExtras(mat, e.cls, e.orig.ior)
  }

  /** Characters decorated so far (tests, the console). */
  get characterCount(): number {
    return this.characters.size
  }

  dispose(): void {
    for (const [mat, e] of this.characters) this.undressCharacter(mat, e)
    this.characters.clear()
    for (const mat of [...this.emissive.keys()]) this.removeEmissive(mat)
    this.slotEmissive.clear()
    this.extras.clear()
    this.cache.dispose()
    this.shared.plugins.clear()
  }
}

/** A texture source that never runs (the part without map sets). */
const NO_SOURCE: MapTextureSource = {
  texture() {
    throw new Error('no map texture source')
  },
  pixels() {
    return Promise.reject(new Error('no map texture source'))
  },
  raw() {
    throw new Error('no map texture source')
  },
}
