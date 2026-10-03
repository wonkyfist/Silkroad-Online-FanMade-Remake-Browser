/**
 * `SroFoliagePlugin`: trees, bushes and plants on the PBR presets (docs/RENDER.md §8.1, docs/WAVE_PLAN3.md §6.14,
 * D23), and `PbrFoliage`, the part that puts it on every PBR material of a foliage model (an ObjectMaterials
 * decorator) and follows the renderer's path and preset. Owned by RND-W.
 *
 * Per define (WGSL and GLSL, the same injection points; no GLSL on the WebGPU engine):
 *   SRO_FOL_WIND     static trees bend downwind (`CUSTOM_VERTEX_UPDATE_WORLDPOS`): the crown moves by
 *                    `wind direction × strength × h² × 0.012 × sroWind(root).x`, h = metres above the instance
 *                    origin. `sroWind` is WX-R's shared function (weather/chunks.ts), and the formula is the Classic
 *                    trees' (weather/wet-plugin.ts), so grass, Classic trees and PBR trees sway together (D23).
 *                    Skinned trees keep their retail clip (WX-R speeds it up in wind) and get only the flutter.
 *   SRO_FOL_FLUTTER  leaves (class foliage) flutter: a small fast per-vertex wobble that grows with the wind.
 *   SRO_FOL_TRANSL   back-lit leaves glow: `sun × albedo × translucency × pow(saturate(V·−L), 4) × thickness / π` added
 *                    to `finalDiffuse` at `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION` (not `CUSTOM_LIGHT0_COLOR`:
 *                    Babylon multiplies that colour by the clamped N·L, which is 0 exactly on the back-lit side, RENDER
 *                    verify). The term is shadowed: a regex point right after Babylon adds each light's diffuse keeps
 *                    the first light's shadow (the celestial light is light 0, RND-L), so a tree in a building's
 *                    shadow does not glow. thickness = 0.5 + 0.5 × saturate(4 × albedo.g) (thin bright leaves glow
 *                    most).
 *   SRO_FOL_PIVOT    BT-P (docs/BATCHING.md §3.3, §3.5): a region batch's merged trees carry each tree's root (its
 *                    placement origin, in the mesh's own space like the positions) as the `sroPivot` vertex attribute
 *                    (FOLIAGE_PIVOT_KIND), read in place of the instance origin `finalWorld[3]` (which is the batch's,
 *                    not the tree's), so every merged tree bends around its own root. An attribute, not a varying.
 *   SRO_FOL_BREEZE   BT-P (D30, Q3): the minimum breeze. The retail skinned trees swayed even in calm air; their static
 *                    variants (BT-T) sway at least as if the wind were `breeze` (FOLIAGE_MIN_BREEZE):
 *                    strength = max(wind, breeze). Off (breeze 0): today's strength.
 *   SRO_CLOTH_WIND   Wave 11 (W11-S's slot, docs/WAVE_PLAN7.md D3; TOWN_LIFE §5.1): cloth in a region batch's `+sheen`
 *                    group sways. Only a plugin made with `cloth: true` (batch/region-batch.ts `enableCloth`) carries
 *                    its code, on a mesh with the 4-float cloth pivot (`sroPivot`: pin height, hanging height, kind,
 *                    phase); the sway itself is TL-M's chunk (town/cloth-chunk.ts). Every other plugin's code is
 *                    byte for byte the code before the slot (`foliageCode`).
 *   SRO_FOL_VDATA    Wave 12 (W12-SA's skeleton, docs/WAVE_PLAN8.md D8; TREES §W3.4–§W3.5, T12-W's chunk): a merged tree
 *                    group's per-vertex wind data, the `sroTreeW` attribute (flex, phase, flutter, crown AO, decoded by
 *                    the merge; FOLIAGE_TREEW_KIND). Only a tree plugin (`FoliageOptions.tree`, the batch's tree groups)
 *                    on a mesh carrying it. It replaces the h² bend and the world-position flutter (§W3.5):
 *                    `offset = windDir × strength × (flex² × A(h) × sin(t × 1.1 + phase × 2π) + 0.3 × flex × sway)`,
 *                    sway = `sroWind(root).x` (the shared gust and lean, D23), strength = max(wind, breeze); the cards
 *                    flutter by `flutter × (0.012 + 0.05 × strength)` along the vertex normal. A(h) = 1.2 m ×
 *                    clamp(h / 10 m, 0.2, 1), h = the vertex's height above its root (T12-W decision: the material table
 *                    has no A column, and reading it here would declare the surface plugin's table in the vertex stage;
 *                    this gives §W3.5's 1.2 m for a ≥ 10 m crown and ≈ 0.25 m for a 2 m plant). TS mirror:
 *                    `treeWindBend`, `treeFlutter`.
 *   SRO_FOL_BAND     Wave 12 (the same): the band collapse (TREES §W3.3): a merged LOD1 / LOD2 vertex whose tree's band
 *                    byte is not its tier moves to the root (zero area). On a mesh with the 4-float tree pivot (root
 *                    xyz, slot × 4 + tier), **whatever the wind** (WF9), while the world's band texture is set
 *                    (`FoliageShared.setBand`, T12-N's R8 128 × 64; `sroTreeBand`, read with textureLoad / texelFetch in
 *                    the vertex stage only: no fragment unit, no varying). Tier 0 is never banded. TS mirror:
 *                    `treeBandTexel`, `treeBandShows`.
 *   SRO_FOL_PIVOT4   Wave 12 (the same; WF9): the pivot is the 4-float tree pivot, declared once as vec4 whenever BAND or
 *                    PIVOT is on (else PIVOT's vec3, HEAD's). With VDATA, BAND and PIVOT4 off a tree plugin's code is
 *                    `foliageCode` byte for byte once those three blocks are stripped (`treeFoliageCode`).
 * The moved vertex also moves `vPositionW`, so the fragment's shadow lookup, wetness and fog follow the swaying leaf.
 *
 * Shadow pass: RENDER §8.1 asks for `material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene,
 * { standalone: false })` on High+ (`foliage.csmCaster`), so the CSM would draw the leaves with this vertex code and
 * their shadows would sway too. In Babylon 9.28 on WebGPU that wrapper builds invalid shaders for a PBR material
 * (measured in the RND-W harness): the WGSL normal-bias include reads `vNormalW` (remappable), and with the prepass
 * on (High+: SSR) the PBR fragment writes MRT outputs, so the depth include's `fragmentOutputs.color` does not exist;
 * the invalid pipeline then drops every frame's command buffer. It is therefore off by default
 * (`PbrFoliageOptions.shadowWrapper`); the tree shadows stay the static CSM shadows (a crown sways by at most ~1 m in a
 * storm).
 *
 * Wetness is not here: the leaves carry RND-M's SroSurfacePlugin (class foliage: porosity 0.3, wet roughness 0.25), so
 * wet foliage darkens and shines through that one wet owner (D19). The plugin only goes on materials that carry it
 * (the PBR path); WX-R's WetnessPlugin never shares a material with it, so the `wxA`/`wxB` UBO names are this plugin's.
 */
import {
  MaterialPluginBase,
  PBRBaseMaterial,
  ShaderLanguage,
  ShadowDepthWrapper,
  type AbstractEngine,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Observer,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import type { RenderPath, RenderQuality } from '../render/quality.ts'
import { WX_SWAY_GLSL, WX_SWAY_WGSL } from '../weather/chunks.ts'
import type { WeatherUniforms } from '../weather/index.ts'
import { CLOTH_VERTEX_DEFS_GLSL, CLOTH_VERTEX_DEFS_WGSL, CLOTH_WORLDPOS_GLSL, CLOTH_WORLDPOS_WGSL } from '../town/cloth-chunk.ts'
import { MATERIAL_CLASS_PARAMS, isFoliageModel } from './classes.ts'
import { surfacePluginOf } from './surface-plugin.ts'

export const SRO_FOLIAGE_PLUGIN = 'SroFoliagePlugin'
/** The crown bend per metre² of height (the Classic trees' factor, weather/wet-plugin.ts). */
export const FOLIAGE_BEND = 0.012
/** Metres above the origin the bend stops growing at. */
export const FOLIAGE_MAX_H = 12
/** BT-P: the vertex-buffer kind of a merged tree's root (vec3, the mesh's space; SRO_FOL_PIVOT). */
export const FOLIAGE_PIVOT_KIND = 'sroPivot'
/** BT-P (BATCHING §3.5, D30, Q3): the minimum breeze of the static trees that replace the swaying retail clips. */
export const FOLIAGE_MIN_BREEZE = 0.15
/** W11-S: the floats of a cloth group's pivot attribute (the same `sroPivot` kind as the trees', vec4). */
export const CLOTH_PIVOT_FLOATS = 4
/** W12-SA (TREES §W3.3): the floats of a wave-12 merged tree's pivot (root xyz, band slot × 4 + tier; SRO_FOL_PIVOT4). */
export const TREE_PIVOT_FLOATS = 4
/** W12-SA (TREES §W3.4, WF5): the vertex-buffer kind of a merged tree's wind data (flex, phase, flutter, AO; VDATA). */
export const FOLIAGE_TREEW_KIND = 'sroTreeW'
/** W12-SA (D8): the wave-12 tree defines a tree plugin adds (off: HEAD's code once their blocks are stripped). */
export const TREE_FOLIAGE_DEFINES: readonly string[] = ['SRO_FOL_VDATA', 'SRO_FOL_BAND', 'SRO_FOL_PIVOT4']
/** T12-W (TREES §W3.3): the band texture's width and height in slots (R8, one byte per slot; slot = y × W + x). */
export const TREE_BAND_TEX_W = 128
export const TREE_BAND_TEX_H = 64
/** T12-W: the band texture's sampler (SRO_FOL_BAND; vertex stage only). */
export const TREE_BAND_SAMPLER = 'sroTreeBand'
/** T12-W (TREES §W3.5): the crown amplitude A of a tree at least TREE_W_AMP_H_M tall above its root (m). */
export const TREE_W_AMP_M = 1.2
/** T12-W: the height above the root A reaches TREE_W_AMP_M at (m); below it A falls linearly to TREE_W_AMP_MIN × it. */
export const TREE_W_AMP_H_M = 10
/** T12-W: A's floor as a fraction of TREE_W_AMP_M (a 2 m plant: 0.24 m, §W3.5's "plants 0.25 m"). */
export const TREE_W_AMP_MIN = 0.2
/** T12-W (§W3.5): the gust term's weight (× flex × sroWind's sway). */
export const TREE_W_GUST = 0.3
/** T12-W (§W3.5): the limb sway's angular frequency (rad/s of the weather clock). */
export const TREE_W_FREQ = 1.1

const DEFINES = {
  SRO_FOLIAGE: false, SRO_FOL_WIND: false, SRO_FOL_FLUTTER: false, SRO_FOL_TRANSL: false, SRO_FOL_PIVOT: false, SRO_FOL_BREEZE: false,
  SRO_CLOTH_WIND: false, SRO_FOL_VDATA: false, SRO_FOL_BAND: false, SRO_FOL_PIVOT4: false,
}
type FoliageDefines = { [K in keyof typeof DEFINES]: boolean }

/** UBO entries (vec4): the weather's wind vectors (read by `sroWind`) and the plugin's own. */
const UBO = ['wxA', 'wxB', 'sroFol'] as const

/** The first light's shadow, kept right after Babylon adds that light's diffuse (see the file comment). */
export const FOLIAGE_SHADOW_POINT = '!(diffuseBase\\+=info\\.diffuse\\*shadow;)'

// ---- shader code --------------------------------------------------------------------------------------------------

const ANY_MOVE = '#if defined(SRO_FOL_WIND) || defined(SRO_FOL_FLUTTER)\n'

const VERTEX_DEFS_WGSL = `${ANY_MOVE}${WX_SWAY_WGSL}#endif
#ifdef SRO_FOL_PIVOT
attribute ${FOLIAGE_PIVOT_KIND}: vec3f;
#endif
`
const VERTEX_DEFS_GLSL = `${ANY_MOVE}${WX_SWAY_GLSL}#endif
#ifdef SRO_FOL_PIVOT
attribute vec3 ${FOLIAGE_PIVOT_KIND};
#endif
`

const WORLDPOS_WGSL = /* wgsl */ `${ANY_MOVE}{
#ifdef SRO_FOL_PIVOT
  let folRoot = (finalWorld * vec4f(vertexInputs.${FOLIAGE_PIVOT_KIND}, 1.0)).xyz;
#else
  let folRoot = finalWorld[3].xyz;
#endif
  let folH = clamp(worldPos.y - folRoot.y, 0.0, ${FOLIAGE_MAX_H.toFixed(1)});
#ifdef SRO_FOL_BREEZE
  let folZ = max(clamp(uniforms.wxB.z, 0.0, 1.0), uniforms.sroFol.y);
#else
  let folZ = clamp(uniforms.wxB.z, 0.0, 1.0);
#endif
  var folO = vec3f(0.0);
#ifdef SRO_FOL_WIND
  let folWd = sroWind(folRoot);
  let folB = folZ * folH * folH * ${FOLIAGE_BEND} * folWd.x;
  folO = vec3f(uniforms.wxB.x * folB, 0.0, uniforms.wxB.y * folB);
#endif
#ifdef SRO_FOL_FLUTTER
  let folF = sin(uniforms.wxB.w * 7.3 + dot(worldPos.xyz, vec3f(1.7, 2.3, 1.1))) * (0.012 + 0.05 * folZ) * clamp(folH / 3.0, 0.0, 1.0);
  folO = folO + vec3f(uniforms.wxB.x * folF, 0.5 * folF, uniforms.wxB.y * folF);
#endif
  worldPos = vec4f(worldPos.xyz + folO, worldPos.w);
  vertexOutputs.vPositionW = worldPos.xyz;
}
#endif
`
const WORLDPOS_GLSL = /* glsl */ `${ANY_MOVE}{
#ifdef SRO_FOL_PIVOT
  vec3 folRoot = (finalWorld * vec4(${FOLIAGE_PIVOT_KIND}, 1.0)).xyz;
#else
  vec3 folRoot = finalWorld[3].xyz;
#endif
  float folH = clamp(worldPos.y - folRoot.y, 0.0, ${FOLIAGE_MAX_H.toFixed(1)});
#ifdef SRO_FOL_BREEZE
  float folZ = max(clamp(wxB.z, 0.0, 1.0), sroFol.y);
#else
  float folZ = clamp(wxB.z, 0.0, 1.0);
#endif
  vec3 folO = vec3(0.0);
#ifdef SRO_FOL_WIND
  vec3 folWd = sroWind(folRoot);
  float folB = folZ * folH * folH * ${FOLIAGE_BEND} * folWd.x;
  folO = vec3(wxB.x * folB, 0.0, wxB.y * folB);
#endif
#ifdef SRO_FOL_FLUTTER
  float folF = sin(wxB.w * 7.3 + dot(worldPos.xyz, vec3(1.7, 2.3, 1.1))) * (0.012 + 0.05 * folZ) * clamp(folH / 3.0, 0.0, 1.0);
  folO += vec3(wxB.x * folF, 0.5 * folF, wxB.y * folF);
#endif
  worldPos.xyz += folO;
  vPositionW = worldPos.xyz;
}
#endif
`

const FRAG_DEFS_WGSL = '#ifdef SRO_FOL_TRANSL\nvar<private> sroFolSh: f32 = -1.0;\n#endif\n'
const FRAG_DEFS_GLSL = '#ifdef SRO_FOL_TRANSL\nfloat sroFolSh = -1.0;\n#endif\n'

const SHADOW_WGSL = '$1\n#ifdef SRO_FOL_TRANSL\nif (sroFolSh < 0.0) {\n  sroFolSh = shadow;\n}\n#endif\n'
const SHADOW_GLSL = '$1\n#ifdef SRO_FOL_TRANSL\nif (sroFolSh < 0.0) {\n  sroFolSh = shadow;\n}\n#endif\n'

const TRANSL_WGSL = /* wgsl */ `#ifdef SRO_FOL_TRANSL
#if defined(LIGHT0) && defined(DIRLIGHT0)
{
  let folL = normalize(-light0.vLightData.xyz);
  let folBack = pow(clamp(dot(viewDirectionW, -folL), 0.0, 1.0), 4.0);
  let folThick = 0.5 + 0.5 * clamp(surfaceAlbedo.g * 4.0, 0.0, 1.0);
  let folSh = select(sroFolSh, 1.0, sroFolSh < 0.0);
  finalDiffuse = finalDiffuse + light0.vLightDiffuse.rgb * surfaceAlbedo * (uniforms.sroFol.x * folBack * folThick * folSh * 0.31830989);
}
#endif
#endif
`
const TRANSL_GLSL = /* glsl */ `#ifdef SRO_FOL_TRANSL
#if defined(LIGHT0) && defined(DIRLIGHT0)
{
  vec3 folL = normalize(-light0.vLightData.xyz);
  float folBack = pow(clamp(dot(viewDirectionW, -folL), 0.0, 1.0), 4.0);
  float folThick = 0.5 + 0.5 * clamp(surfaceAlbedo.g * 4.0, 0.0, 1.0);
  float folSh = sroFolSh < 0.0 ? 1.0 : sroFolSh;
  finalDiffuse += light0.vLightDiffuse.rgb * surfaceAlbedo * (sroFol.x * folBack * folThick * folSh * 0.31830989);
}
#endif
#endif
`

/** The injection points per stage and language (the tests compare the key sets). */
export function foliageCode(stage: 'vertex' | 'fragment', lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> {
  const w = lang === 'wgsl'
  if (stage === 'vertex') {
    return {
      CUSTOM_VERTEX_DEFINITIONS: w ? VERTEX_DEFS_WGSL : VERTEX_DEFS_GLSL,
      CUSTOM_VERTEX_UPDATE_WORLDPOS: w ? WORLDPOS_WGSL : WORLDPOS_GLSL,
    }
  }
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: w ? FRAG_DEFS_WGSL : FRAG_DEFS_GLSL,
    [FOLIAGE_SHADOW_POINT]: w ? SHADOW_WGSL : SHADOW_GLSL,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: w ? TRANSL_WGSL : TRANSL_GLSL,
  }
}

// ---- the cloth slot (W11-S; TL-M's chunk) -------------------------------------------------------------------------

const CLOTH_DEFS_WGSL = `#ifdef SRO_CLOTH_WIND
attribute ${FOLIAGE_PIVOT_KIND}: vec4f;
#if !defined(SRO_FOL_WIND) && !defined(SRO_FOL_FLUTTER)
${WX_SWAY_WGSL}#endif
${CLOTH_VERTEX_DEFS_WGSL}#endif
`
const CLOTH_DEFS_GLSL = `#ifdef SRO_CLOTH_WIND
attribute vec4 ${FOLIAGE_PIVOT_KIND};
#if !defined(SRO_FOL_WIND) && !defined(SRO_FOL_FLUTTER)
${WX_SWAY_GLSL}#endif
${CLOTH_VERTEX_DEFS_GLSL}#endif
`
const CLOTH_MOVE_WGSL = `#ifdef SRO_CLOTH_WIND
{
  let clothPivot = vertexInputs.${FOLIAGE_PIVOT_KIND};
${CLOTH_WORLDPOS_WGSL}  vertexOutputs.vPositionW = worldPos.xyz;
}
#endif
`
const CLOTH_MOVE_GLSL = `#ifdef SRO_CLOTH_WIND
{
  vec4 clothPivot = ${FOLIAGE_PIVOT_KIND};
${CLOTH_WORLDPOS_GLSL}  vPositionW = worldPos.xyz;
}
#endif
`

/**
 * W11-S: the injection points of a cloth plugin (`FoliageOptions.cloth`): `foliageCode` with the cloth slot appended to
 * the vertex definitions and the world-position hook (the same keys; the fragment is `foliageCode`'s).
 */
export function clothFoliageCode(stage: 'vertex' | 'fragment', lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> {
  const base = foliageCode(stage, lang)
  if (stage !== 'vertex') return base
  const w = lang === 'wgsl'
  return {
    CUSTOM_VERTEX_DEFINITIONS: base.CUSTOM_VERTEX_DEFINITIONS + (w ? CLOTH_DEFS_WGSL : CLOTH_DEFS_GLSL),
    CUSTOM_VERTEX_UPDATE_WORLDPOS: base.CUSTOM_VERTEX_UPDATE_WORLDPOS + (w ? CLOTH_MOVE_WGSL : CLOTH_MOVE_GLSL),
  }
}

// ---- the tree slots (W12-SA skeleton, WAVE_PLAN8 D8; T12-W's chunks) -----------------------------------------------

/**
 * The vertex definitions of a tree plugin: HEAD's, with one `vec4` pivot whenever SRO_FOL_PIVOT4 (BAND or PIVOT on a
 * 4-float tree pivot, WF9), else HEAD's vec3 under SRO_FOL_PIVOT; then the VDATA attribute and the BAND slot (T12-W).
 */
const TREE_DEFS_WGSL = `${ANY_MOVE}${WX_SWAY_WGSL}#endif
#ifdef SRO_FOL_PIVOT4
attribute ${FOLIAGE_PIVOT_KIND}: vec4f;
#else
#ifdef SRO_FOL_PIVOT
attribute ${FOLIAGE_PIVOT_KIND}: vec3f;
#endif
#endif
#ifdef SRO_FOL_VDATA
attribute ${FOLIAGE_TREEW_KIND}: vec4f;
#endif
#ifdef SRO_FOL_BAND
var ${TREE_BAND_SAMPLER}: texture_2d<f32>;
var ${TREE_BAND_SAMPLER}Sampler: sampler;
#endif
`
const TREE_DEFS_GLSL = `${ANY_MOVE}${WX_SWAY_GLSL}#endif
#ifdef SRO_FOL_PIVOT4
attribute vec4 ${FOLIAGE_PIVOT_KIND};
#else
#ifdef SRO_FOL_PIVOT
attribute vec3 ${FOLIAGE_PIVOT_KIND};
#endif
#endif
#ifdef SRO_FOL_VDATA
attribute vec4 ${FOLIAGE_TREEW_KIND};
#endif
#ifdef SRO_FOL_BAND
uniform highp sampler2D ${TREE_BAND_SAMPLER};
#endif
`

/** HEAD's root line and a tree plugin's (the vec4 pivot's xyz under SRO_FOL_PIVOT4). */
const HEAD_ROOT_WGSL = `  let folRoot = (finalWorld * vec4f(vertexInputs.${FOLIAGE_PIVOT_KIND}, 1.0)).xyz;\n`
const HEAD_ROOT_GLSL = `  vec3 folRoot = (finalWorld * vec4(${FOLIAGE_PIVOT_KIND}, 1.0)).xyz;\n`
const TREE_ROOT_WGSL = `#ifdef SRO_FOL_PIVOT4
  let folRoot = (finalWorld * vec4f(vertexInputs.${FOLIAGE_PIVOT_KIND}.xyz, 1.0)).xyz;
#else
${HEAD_ROOT_WGSL}#endif
`
const TREE_ROOT_GLSL = `#ifdef SRO_FOL_PIVOT4
  vec3 folRoot = (finalWorld * vec4(${FOLIAGE_PIVOT_KIND}.xyz, 1.0)).xyz;
#else
${HEAD_ROOT_GLSL}#endif
`
/** A WGSL / GLSL float literal of a TS constant. */
const lit = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v))
const TWO_PI = (2 * Math.PI).toFixed(9)

/**
 * T12-W (§W3.5): the VDATA bend and flutter, in place of HEAD's h² bend and world-position flutter inside the moving
 * block (folRoot, folH, folZ and folO are HEAD's). Each scalar line is one statement (the tests evaluate them).
 */
const VDATA_WGSL = /* wgsl */ `  let folTw = vertexInputs.${FOLIAGE_TREEW_KIND};
#ifdef SRO_FOL_WIND
  let folWd = sroWind(folRoot);
  let folA = ${lit(TREE_W_AMP_M)} * clamp(folH / ${lit(TREE_W_AMP_H_M)}, ${lit(TREE_W_AMP_MIN)}, 1.0);
  let folB = folZ * (folTw.x * folTw.x * folA * sin(uniforms.wxB.w * ${lit(TREE_W_FREQ)} + folTw.y * ${TWO_PI}) + ${lit(TREE_W_GUST)} * folTw.x * folWd.x);
  folO = vec3f(uniforms.wxB.x * folB, 0.0, uniforms.wxB.y * folB);
#endif
#ifdef SRO_FOL_FLUTTER
#ifdef NORMAL
  let folF = folTw.z * (0.012 + 0.05 * folZ) * sin(uniforms.wxB.w * 7.3 + folTw.y * ${TWO_PI} + dot(worldPos.xyz, vec3f(1.7, 2.3, 1.1)));
  folO = folO + vertexOutputs.vNormalW * folF;
#endif
#endif
`
const VDATA_GLSL = /* glsl */ `  vec4 folTw = ${FOLIAGE_TREEW_KIND};
#ifdef SRO_FOL_WIND
  vec3 folWd = sroWind(folRoot);
  float folA = ${lit(TREE_W_AMP_M)} * clamp(folH / ${lit(TREE_W_AMP_H_M)}, ${lit(TREE_W_AMP_MIN)}, 1.0);
  float folB = folZ * (folTw.x * folTw.x * folA * sin(wxB.w * ${lit(TREE_W_FREQ)} + folTw.y * ${TWO_PI}) + ${lit(TREE_W_GUST)} * folTw.x * folWd.x);
  folO = vec3(wxB.x * folB, 0.0, wxB.y * folB);
#endif
#ifdef SRO_FOL_FLUTTER
#ifdef NORMAL
  float folF = folTw.z * (0.012 + 0.05 * folZ) * sin(wxB.w * 7.3 + folTw.y * ${TWO_PI} + dot(worldPos.xyz, vec3(1.7, 2.3, 1.1)));
  folO += vNormalW * folF;
#endif
#endif
`

/**
 * T12-W (§W3.3, WF9): the band collapse, after the moving block (it runs whatever the wind): a banded vertex (tier ≠ 0)
 * whose slot's band byte is not its tier moves to its tree's root, so its triangles have zero area.
 */
const BAND_WGSL = /* wgsl */ `#ifdef SRO_FOL_BAND
{
  let folBw = u32(round(vertexInputs.${FOLIAGE_PIVOT_KIND}.w));
  let folTier = folBw & 3u;
  if (folTier != 0u) {
    let folSlot = i32(folBw >> 2u);
    let folBand = u32(round(textureLoad(${TREE_BAND_SAMPLER}, vec2i(folSlot % ${TREE_BAND_TEX_W}, folSlot / ${TREE_BAND_TEX_W}), 0).r * 255.0));
    if (folBand != folTier) {
      let folBr = (finalWorld * vec4f(vertexInputs.${FOLIAGE_PIVOT_KIND}.xyz, 1.0)).xyz;
      worldPos = vec4f(folBr, worldPos.w);
      vertexOutputs.vPositionW = folBr;
    }
  }
}
#endif
`
const BAND_GLSL = /* glsl */ `#ifdef SRO_FOL_BAND
{
  int folBw = int(${FOLIAGE_PIVOT_KIND}.w + 0.5);
  int folTier = folBw & 3;
  if (folTier != 0) {
    int folSlot = folBw >> 2;
    int folBand = int(texelFetch(${TREE_BAND_SAMPLER}, ivec2(folSlot % ${TREE_BAND_TEX_W}, folSlot / ${TREE_BAND_TEX_W}), 0).r * 255.0 + 0.5);
    if (folBand != folTier) {
      vec3 folBr = (finalWorld * vec4(${FOLIAGE_PIVOT_KIND}.xyz, 1.0)).xyz;
      worldPos = vec4(folBr, worldPos.w);
      vPositionW = folBr;
    }
  }
}
#endif
`

/** HEAD's anchors around the bend and flutter (the start of the offset and the line that applies it). */
const HEAD_OFFSET_WGSL = '  var folO = vec3f(0.0);\n'
const HEAD_OFFSET_GLSL = '  vec3 folO = vec3(0.0);\n'
const HEAD_APPLY_WGSL = '  worldPos = vec4f(worldPos.xyz + folO, worldPos.w);\n'
const HEAD_APPLY_GLSL = '  worldPos.xyz += folO;\n'

/**
 * Splices the tree chunks into HEAD's world-position code (each anchor must be there exactly once): the vec4 pivot's
 * root, VDATA in place of HEAD's bend and flutter (`#ifdef SRO_FOL_VDATA … #else HEAD #endif`), and BAND after the block.
 */
function treeWorldPos(head: string, w: boolean): string {
  const root = w ? HEAD_ROOT_WGSL : HEAD_ROOT_GLSL
  const from = w ? HEAD_OFFSET_WGSL : HEAD_OFFSET_GLSL
  const to = w ? HEAD_APPLY_WGSL : HEAD_APPLY_GLSL
  for (const a of [root, from, to]) if (head.split(a).length !== 2) throw new Error('foliage-plugin: the tree slots lost their anchors')
  const a = head.indexOf(from) + from.length
  const b = head.indexOf(to)
  if (b < a) throw new Error('foliage-plugin: the tree slots lost their anchors')
  const moved = `${head.slice(0, a)}#ifdef SRO_FOL_VDATA\n${w ? VDATA_WGSL : VDATA_GLSL}#else\n${head.slice(a, b)}#endif\n${head.slice(b)}`
  return moved.replace(root, w ? TREE_ROOT_WGSL : TREE_ROOT_GLSL) + (w ? BAND_WGSL : BAND_GLSL)
}

/**
 * W12-SA (D8): the injection points of a tree plugin (`FoliageOptions.tree`: the region batch's tree groups): HEAD's
 * `foliageCode` with the vec4 pivot (SRO_FOL_PIVOT4), the SRO_FOL_VDATA attribute and slot, and the SRO_FOL_BAND slot
 * (T12-W's chunks). With TREE_FOLIAGE_DEFINES off it is `foliageCode` byte for byte (their blocks stripped);
 * the fragment is `foliageCode`'s.
 */
export function treeFoliageCode(stage: 'vertex' | 'fragment', lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> {
  const base = foliageCode(stage, lang)
  if (stage !== 'vertex') return base
  const w = lang === 'wgsl'
  return {
    CUSTOM_VERTEX_DEFINITIONS: w ? TREE_DEFS_WGSL : TREE_DEFS_GLSL,
    CUSTOM_VERTEX_UPDATE_WORLDPOS: treeWorldPos(base.CUSTOM_VERTEX_UPDATE_WORLDPOS!, w),
  }
}

/** W12-SA: whether a mesh carries the 4-float tree pivot (TREE_PIVOT_FLOATS; a tree plugin never sees a cloth mesh). */
export function hasTreePivot4(mesh: AbstractMesh | null | undefined): boolean {
  return !!mesh && mesh.getVertexBuffer?.(FOLIAGE_PIVOT_KIND)?.getSize() === TREE_PIVOT_FLOATS
}

/** W11-S: whether a mesh carries the cloth pivot (the `sroPivot` vertex buffer, CLOTH_PIVOT_FLOATS wide). */
export function hasClothPivot(mesh: AbstractMesh | null | undefined): boolean {
  return !!mesh && mesh.getVertexBuffer?.(FOLIAGE_PIVOT_KIND)?.getSize() === CLOTH_PIVOT_FLOATS
}

/** The crown offset of the vertex code, in TS (tests): metres along the wind direction. */
export function foliageBend(heightM: number, strength: number, sway: number): number {
  const h = Math.min(FOLIAGE_MAX_H, Math.max(0, heightM))
  return Math.min(1, Math.max(0, strength)) * h * h * FOLIAGE_BEND * sway
}

/** The strength the vertex code bends with: the wind's, or the minimum breeze when larger (SRO_FOL_BREEZE; TS mirror). */
export function foliageStrength(wind: number, breeze = 0): number {
  const w = Math.min(1, Math.max(0, wind))
  return breeze > 0 ? Math.max(w, breeze) : w
}

/** T12-W: the crown amplitude A at `heightM` above the root (SRO_FOL_VDATA's folA; folH is clamped to FOLIAGE_MAX_H). */
export function treeWindAmp(heightM: number): number {
  const h = Math.min(FOLIAGE_MAX_H, Math.max(0, heightM))
  return TREE_W_AMP_M * Math.min(1, Math.max(TREE_W_AMP_MIN, h / TREE_W_AMP_H_M))
}

/**
 * T12-W: SRO_FOL_VDATA's bend in TS (the shader's folB): metres along the wind direction of a vertex with `flex` and
 * `phase` (sroTreeW.x, .y) at `heightM` above its root, at `strength` (max(wind, breeze)), weather time `t` and
 * `sway` = sroWind(root).x.
 */
export function treeWindBend(flex: number, phase: number, heightM: number, strength: number, t: number, sway: number): number {
  return strength * (flex * flex * treeWindAmp(heightM) * Math.sin(t * TREE_W_FREQ + phase * 2 * Math.PI) + TREE_W_GUST * flex * sway)
}

/**
 * T12-W: SRO_FOL_VDATA's card flutter in TS (the shader's folF): metres along the vertex normal, `posDot` =
 * dot(worldPos, (1.7, 2.3, 1.1)).
 */
export function treeFlutter(flutter: number, phase: number, strength: number, t: number, posDot: number): number {
  return flutter * (0.012 + 0.05 * strength) * Math.sin(t * 7.3 + phase * 2 * Math.PI + posDot)
}

/** T12-W: the band texture texel of a slot (SRO_FOL_BAND; x = slot mod TREE_BAND_TEX_W). */
export function treeBandTexel(slot: number): [number, number] {
  return [slot % TREE_BAND_TEX_W, Math.floor(slot / TREE_BAND_TEX_W)]
}

/**
 * T12-W: whether SRO_FOL_BAND shows a merged vertex with the pivot word `word` (slot × 4 + tier) while its slot's band
 * byte is `band` (0 near, 1 mid, 2 far, 3 hidden): tier 0 always, else only when the band is the tier.
 */
export function treeBandShows(word: number, band: number): boolean {
  const tier = Math.round(word) & 3
  return tier === 0 || Math.round(band) === tier
}

/** The translucency term's weight without the light and the albedo (tests): back lobe × thickness × shadow / π. */
export function foliageTranslucency(vDotMinusL: number, albedoG: number, translucency: number, shadow = 1): number {
  const back = Math.pow(Math.min(1, Math.max(0, vDotMinusL)), 4)
  const thick = 0.5 + 0.5 * Math.min(1, Math.max(0, albedoG * 4))
  return translucency * back * thick * shadow / Math.PI
}

// ---- shared state and the plugin ------------------------------------------------------------------------------------

/** The switches every plugin of a world shares (from the preset) and the weather's wind vectors. */
export class FoliageShared {
  /** The PBR path is on (off: every plugin preprocesses away). */
  active = false
  wind = false
  translucency = false
  /** The CSM draws the leaves with the plugin's vertex code (ShadowDepthWrapper). */
  csmCaster = false
  u: Pick<WeatherUniforms, 'wxA' | 'wxB'> | null = null
  readonly plugins = new Set<SroFoliagePlugin>()
  private bandTex: BaseTexture | null = null

  dirtyAll(): void {
    for (const p of this.plugins) p.markAllDefinesAsDirty()
  }

  /** T12-W: the world's band texture (T12-N's R8 TREE_BAND_TEX_W × TREE_BAND_TEX_H), or null (SRO_FOL_BAND off). */
  get band(): BaseTexture | null {
    return this.bandTex
  }

  /**
   * T12-W: sets or clears the band texture (T12-N's trees part, before it hands out a slot; null when it goes). The
   * tree plugins re-prepare their defines when the band switches on or off; a new texture of the same kind rebinds.
   */
  setBand(tex: BaseTexture | null): void {
    if (tex === this.bandTex) return
    const flip = (tex === null) !== (this.bandTex === null)
    this.bandTex = tex
    if (flip) for (const p of this.plugins) if (p.tree) p.markAllDefinesAsDirty()
  }
}

export interface FoliageOptions {
  /** Leaves (class foliage): flutter and translucency; else a trunk or branch (bends only). */
  leaf: boolean
  /** Thin-instanced static or a skinned clone (retail animation: flutter only). */
  kind: 'static' | 'clone'
  /** Back-light translucency (MATERIAL_CLASS_PARAMS.foliage.translucency). */
  translucency?: number
  /** BT-P: the minimum breeze (SRO_FOL_BREEZE; FOLIAGE_MIN_BREEZE for the static variants of skinned trees). 0: none. */
  breeze?: number
  /** The CSM may draw it with its own vertex code (a ShadowDepthWrapper; default true). Batch groups say false. */
  shadowWrapper?: boolean
  /**
   * W11-S: a region batch's `+sheen` group (TOWN_LIFE §5.1): the cloth slot (SRO_CLOTH_WIND) on meshes with the cloth
   * pivot, and nothing of the trees' (no bend, flutter, translucency or tree pivot). Default false.
   */
  cloth?: boolean
  /**
   * W12-SA (D8, TREES F2): a region batch's tree group (batch/trees.ts TreeMaterials): the wave-12 tree slots
   * (SRO_FOL_VDATA, SRO_FOL_BAND, the vec4 pivot; `treeFoliageCode`), switched on by the mesh's data. Default false.
   */
  tree?: boolean
}

export class SroFoliagePlugin extends MaterialPluginBase {
  readonly leaf: boolean
  readonly kind: 'static' | 'clone'
  /** W11-S: a cloth group's plugin (FoliageOptions.cloth). */
  readonly cloth: boolean
  /** W12-SA: a tree group's plugin (FoliageOptions.tree; never a cloth one). */
  readonly tree: boolean
  readonly translucency: number
  /** May the CSM draw it through a ShadowDepthWrapper (FoliageOptions.shadowWrapper)? */
  readonly wrappable: boolean
  /** The shadow-pass wrapper while the preset has the CSM draw the leaves. */
  wrapper: ShadowDepthWrapper | null = null
  private moving = false
  /** W11-S: the cloth slot may run (the path, the preset's wind and the weather's vectors), whatever the mesh. */
  private clothActive = false
  /** W12-SA: the tree slots may run (the PBR path, a tree plugin), whatever the mesh. */
  private treeActive = false
  private breezeValue: number

  constructor(material: Material, readonly shared: FoliageShared, opts: FoliageOptions) {
    super(material, SRO_FOLIAGE_PLUGIN, 260, { ...DEFINES }, true, true)
    this.cloth = opts.cloth ?? false
    this.tree = (opts.tree ?? false) && !this.cloth
    this.leaf = opts.leaf && !this.cloth
    this.kind = opts.kind
    this.translucency = opts.translucency ?? MATERIAL_CLASS_PARAMS.foliage.translucency
    this.breezeValue = Math.max(0, opts.breeze ?? 0)
    this.wrappable = opts.shadowWrapper ?? true
    shared.plugins.add(this)
  }

  /** The minimum breeze (SRO_FOL_BREEZE); switching it on or off re-prepares the defines. */
  get breeze(): number {
    return this.breezeValue
  }

  set breeze(v: number) {
    const next = Math.max(0, Number.isFinite(v) ? v : 0)
    if (next === this.breezeValue) return
    const flip = (next > 0) !== (this.breezeValue > 0)
    this.breezeValue = next
    if (flip) this.markAllDefinesAsDirty()
  }

  override getClassName(): string {
    return 'SroFoliagePlugin'
  }

  /** WGSL and GLSL both (the base class says GLSL only). */
  override isCompatible(_language: ShaderLanguage): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    const d = defines as unknown as FoliageDefines
    const s = this.shared
    const on = s.active && surfacePluginOf(this._material) !== null
    d.SRO_FOLIAGE = on
    d.SRO_FOL_WIND = on && s.wind && this.kind === 'static' && !this.cloth && s.u !== null
    d.SRO_FOL_FLUTTER = on && s.wind && this.leaf && s.u !== null
    d.SRO_FOL_TRANSL = on && s.translucency && this.leaf
    this.moving = d.SRO_FOL_WIND || d.SRO_FOL_FLUTTER
    d.SRO_FOL_PIVOT = this.pivotOn(mesh)
    this.clothActive = on && this.cloth && s.wind && s.u !== null
    d.SRO_CLOTH_WIND = this.clothOn(mesh)
    d.SRO_FOL_BREEZE = (this.moving || d.SRO_CLOTH_WIND) && this.breezeValue > 0
    // W12-SA (D8): the tree slots (a tree plugin only; off on every wave-10 mesh). WF9: the vec4 pivot whenever BAND or
    // PIVOT reads a 4-float tree pivot, whatever the wind.
    this.treeActive = on && this.tree
    d.SRO_FOL_VDATA = this.vdataOn(mesh)
    d.SRO_FOL_BAND = this.bandOn(mesh)
    d.SRO_FOL_PIVOT4 = (d.SRO_FOL_PIVOT || d.SRO_FOL_BAND) && this.tree && hasTreePivot4(mesh)
  }

  /**
   * W12-SA skeleton (SRO_FOL_VDATA): a tree plugin on a mesh carrying a merged tree's wind data (`sroTreeW`). The
   * attribute is declared and bound; T12-W's chunk reads it.
   */
  private vdataOn(mesh: AbstractMesh | null | undefined): boolean {
    return this.treeActive && !!mesh && mesh.isVerticesDataPresent(FOLIAGE_TREEW_KIND)
  }

  /**
   * SRO_FOL_BAND (T12-W): the band collapse on a mesh with the 4-float tree pivot while the world's band texture is set,
   * whatever the wind or the weather (WF9); the vec4 declaration and the attribute follow it.
   */
  private bandOn(mesh: AbstractMesh | null | undefined): boolean {
    return this.treeActive && this.shared.band !== null && hasTreePivot4(mesh)
  }

  /** W11-S: the mesh carries the cloth pivot and the cloth slot runs (SRO_CLOTH_WIND). */
  private clothOn(mesh: AbstractMesh | null | undefined): boolean {
    return this.clothActive && hasClothPivot(mesh)
  }

  /** The mesh carries merged trees' roots (FOLIAGE_PIVOT_KIND) and the vertex code moves it. */
  private pivotOn(mesh: AbstractMesh | null | undefined): boolean {
    return this.moving && !!mesh && mesh.isVerticesDataPresent(FOLIAGE_PIVOT_KIND)
  }

  /**
   * The pivot attribute, only while SRO_FOL_PIVOT, SRO_FOL_BAND or SRO_CLOTH_WIND declares it; W12-SA: the tree wind
   * data while SRO_FOL_VDATA does (Babylon calls this after prepareDefines).
   */
  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if (this.pivotOn(mesh) || this.clothOn(mesh) || this.bandOn(mesh)) attributes.push(FOLIAGE_PIVOT_KIND)
    if (this.vdataOn(mesh)) attributes.push(FOLIAGE_TREEW_KIND)
  }

  override getUniforms(language: ShaderLanguage = ShaderLanguage.GLSL) {
    const ubo = UBO.map(name => ({ name, size: 4, type: 'vec4' }))
    if (language === ShaderLanguage.WGSL) return { ubo }
    // GLSL without uniform buffers only (the UBO path ignores these).
    const decl = UBO.map(n => `uniform vec4 ${n};`).join('\n')
    return { ubo, vertex: `#ifdef SRO_FOLIAGE\n${decl}\n#endif`, fragment: `#ifdef SRO_FOLIAGE\n${decl}\n#endif` }
  }

  /** T12-W: a tree plugin's band sampler (Babylon collects the samplers once per material layout). */
  override getSamplers(samplers: string[]): void {
    if (this.tree) samplers.push(TREE_BAND_SAMPLER)
  }

  /** T12-W: a banded effect waits for the band texture (a missing binding would drop the WebGPU frame). */
  override isReadyForSubMesh(defines: MaterialDefines): boolean {
    if (!(defines as unknown as Partial<FoliageDefines>).SRO_FOL_BAND) return true
    return this.shared.band?.isReady() ?? false
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const s = this.shared
    if (!s.active) return
    const u = s.u
    if ((this.moving || this.clothActive) && u) {
      ubo.updateFloat4('wxA', u.wxA.x, u.wxA.y, u.wxA.z, u.wxA.w)
      ubo.updateFloat4('wxB', u.wxB.x, u.wxB.y, u.wxB.z, u.wxB.w)
    }
    ubo.updateFloat4('sroFol', this.translucency, this.breezeValue, 0, 0)
    if (this.tree && s.band && (subMesh.materialDefines as unknown as Partial<FoliageDefines> | null)?.SRO_FOL_BAND) ubo.setTexture(TREE_BAND_SAMPLER, s.band)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    const stage = shaderType === 'vertex' ? 'vertex' : 'fragment'
    const lang = language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl'
    // W11-S: only a cloth plugin carries the cloth slot; W12-SA: only a tree plugin the tree slots; every other
    // plugin's code is today's.
    return { ...(this.cloth ? clothFoliageCode(stage, lang) : this.tree ? treeFoliageCode(stage, lang) : foliageCode(stage, lang)) }
  }

  /** The shadow pass draws this material with its own vertex code (wind) while `on` (see the file comment). */
  syncWrapper(on: boolean): void {
    const mat = this._material
    on = on && this.wrappable
    if (on && !this.wrapper) {
      try {
        const wgsl = mat.shaderLanguage === ShaderLanguage.WGSL
        this.wrapper = new ShadowDepthWrapper(mat, mat.getScene(), { standalone: false, remappedVariables: wgsl ? ['vNormalW', 'vertexOutputs.vNormalW'] : undefined })
        mat.shadowDepthWrapper = this.wrapper
      } catch (err) {
        console.warn('[world] foliage shadow wrapper not attached to', mat.name, err)
        this.wrapper = null
      }
    } else if (!on && this.wrapper) {
      if (mat.shadowDepthWrapper === this.wrapper) mat.shadowDepthWrapper = null
      this.wrapper.dispose()
      this.wrapper = null
    }
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.syncWrapper(false)
    this.shared.plugins.delete(this)
    super.dispose(forceDisposeTextures)
  }
}

/** The foliage plugin of a material, if it has one. */
export function foliagePluginOf(mat: Material): SroFoliagePlugin | null {
  const p = mat.pluginManager?.getPlugin(SRO_FOLIAGE_PLUGIN)
  return p instanceof SroFoliagePlugin ? p : null
}

// ---- the part -------------------------------------------------------------------------------------------------------

/** The material decorator seam (ObjectMaterials.addDecorator). */
export interface FoliageMaterialSource {
  addDecorator(fn: (mat: Material, info: { source: string; kind: 'static' | 'clone'; alpha: 'opaque' | 'mask' | 'blend' }) => void): () => void
}

/** What the part follows (World's WorldRender and WorldWeather). */
export interface FoliageRenderSource {
  readonly mode: RenderPath
  readonly quality: Readonly<RenderQuality>
}

export interface PbrFoliageOptions {
  /** Put a ShadowDepthWrapper on the static foliage when the preset has the CSM draw it (default off: see above). */
  shadowWrapper?: boolean
}

/**
 * RND-W's foliage part: decorates the PBR materials of foliage models (`isFoliageModel(source)`, the model rule of
 * pbr/classes.ts) as ObjectMaterials converts them, and re-reads the renderer's path and preset before each render
 * (reference compares; a change re-prepares the plugins' defines and switches the shadow wrappers).
 */
export class PbrFoliage {
  readonly shared = new FoliageShared()
  private readonly off: () => void
  private readonly observer: Observer<Scene> | null
  private seenMode: RenderPath | null = null
  private seenQuality: Readonly<RenderQuality> | null = null
  private disposed = false
  private readonly wrapperOn: boolean

  constructor(
    readonly scene: Scene,
    materials: FoliageMaterialSource,
    private readonly render: FoliageRenderSource,
    weather: { readonly u: WeatherUniforms } | null = null,
    opts: PbrFoliageOptions = {},
  ) {
    this.wrapperOn = opts.shadowWrapper ?? false
    this.shared.u = weather?.u ?? null
    this.off = materials.addDecorator((mat, info) => this.decorate(mat, info))
    this.sync()
    this.observer = scene.onBeforeRenderObservable.add(() => this.sync())
  }

  /**
   * BT-P: puts the plugin on a material ObjectMaterials never converted (a region batch's tree group, BT-T), with the
   * world's shared switches. The material must carry the surface plugin (table mode). The CSM never wraps it (its
   * shadows are BT-S's casters). null when the part is gone or the material has no surface plugin.
   */
  attach(mat: Material, opts: FoliageOptions): SroFoliagePlugin | null {
    if (this.disposed || !(mat instanceof PBRBaseMaterial)) return null
    const have = foliagePluginOf(mat)
    if (have) return have
    if (!surfacePluginOf(mat)) return null
    try {
      return new SroFoliagePlugin(mat, this.shared, { ...opts, shadowWrapper: opts.shadowWrapper ?? false })
    } catch (err) {
      console.warn('[world] foliage plugin not attached to', mat.name, err)
      return null
    }
  }

  /** Puts the plugin on one converted material (a foliage model's PBR material carrying the surface plugin). */
  decorate(mat: Material, info: { source: string; kind: 'static' | 'clone' }): SroFoliagePlugin | null {
    if (this.disposed || !(mat instanceof PBRBaseMaterial)) return null
    const have = foliagePluginOf(mat)
    if (have) return have
    const surface = surfacePluginOf(mat)
    if (!surface) return null
    const meta = mat.metadata as { sroFoliage?: boolean } | null
    if (!meta?.sroFoliage && !isFoliageModel(info.source)) return null
    try {
      const p = new SroFoliagePlugin(mat, this.shared, { leaf: surface.cls === 'foliage', kind: info.kind })
      p.syncWrapper(this.shared.active && this.shared.csmCaster && p.kind === 'static')
      return p
    } catch (err) {
      console.warn('[world] foliage plugin not attached to', mat.name, err)
      return null
    }
  }

  /** Re-reads the path and preset (every frame; a change is an Options change, never time or weather). */
  sync(): void {
    const r = this.render
    if (r.mode === this.seenMode && r.quality === this.seenQuality) return
    this.seenMode = r.mode
    this.seenQuality = r.quality
    const s = this.shared
    const active = r.mode === 'pbr'
    const f = r.quality.foliage
    const next = { active, wind: active && f.wind, translucency: active && f.translucency, csmCaster: active && f.csmCaster && !!r.quality.shadows && this.wrapperOn }
    const changed = next.active !== s.active || next.wind !== s.wind || next.translucency !== s.translucency || next.csmCaster !== s.csmCaster
    if (!changed) return
    Object.assign(s, next)
    for (const p of s.plugins) p.syncWrapper(s.csmCaster && p.kind === 'static')
    s.dirtyAll()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.off()
    if (this.observer) this.scene.onBeforeRenderObservable.remove(this.observer)
    for (const p of [...this.shared.plugins]) p.syncWrapper(false)
  }
}
