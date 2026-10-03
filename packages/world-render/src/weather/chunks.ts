/**
 * Weather chunks for the Classic shaders (docs/WAVE_PLAN3.md §4.2, D1, D20, D23; docs/WEATHER.md §6.2, §6.3, §6.7,
 * §6.9, §7.1): terrain surface parameters (`layer`), wet albedo and puddles (`preLight`), the baked-shadow contrast
 * under overcast (`lightTerm`), sky reflection, glint, lightning flash and overcast brightness (`postLight`); water
 * ripples and sky reflection; grass wind (`vertexSway`), per-plant shelter (`vertexLight`) and wet darkening
 * (`fragmentColor`). Also the shared helpers every consumer calls: `sroShelter(worldPos)` (D20; the rain, the Classic
 * wet chunks, the WetnessPlugin and the PBR plugins) and `sroWind(root)` (D23; grass, Classic trees, PBR foliage).
 * Owned by WX-R. See shader-chunks.ts for the points and rules.
 *
 * Defines (set by weather/index.ts from the level, once per Options change; never by the weather itself):
 *   WX          wet darkening + sheen (terrain, grass)          WX_REFL     sky reflection on wet ground (Medium+)
 *   WX_PUDDLE   puddles from the region wet map (Medium+)       WX_RIPPLE   ripple normals in puddles (1 tap; WX_RIPPLE2: 2)
 *   WX_SHELTER  the shelter map (Medium+)                       WX_OCC8     the shelter map is RGBA8 (no half-float RT)
 *   WX_WIND     weather wind on the grass (Low+; Off keeps the fixed retail sway, the Low guard)
 *   WX_WATER    water ripples and sky reflection (Medium+)
 * Without any define (weather Off) every chunk compiles to HEAD's image; the two always-on terms (the lightning flash
 * and the Classic-sky overcast light) sit in uniform branches that are skipped at their clear values.
 *
 * Uniforms (weather/index.ts WeatherUniforms, bound by reference through the renderers' sharedUniforms):
 *   wxA wet, puddle, rain, time    wxB wind x, z, strength, time    wxC sky zenith rgb, flash 0..3
 *   wxD sky horizon rgb, ripple    wxE to-sun xyz, glint            wxF shelter centre y, overcast brightness,
 *   wxCam camera xyz, shelter ok   wxOcc shelter centre x, z, size, 1/size       lightmap contrast, 1 = overcast on
 *   wxOccM world xz → shelter clip xy (2 × 2, row-major)
 * Samplers: wetMap (per region), wxRipple, wxOccMap.
 *
 * WGSL rules: every tap here is textureSampleLevel / textureSampleGrad (the gradients come from the terrain's own
 * uniform `dpdx(lp)`), so nothing depends on uniform control flow; no swizzle assignment; no `?:`.
 */
import { TERRAIN_SURFACE_PARAMS } from '../pbr/classes.ts'
import type { WorldShaderChunks } from '../shader-chunks.ts'
import { RAIN_RING_DENSE, RAIN_RING_DENSE_FULL, rainRingCode } from './ripples.ts'

/** Uniform names by shader (the WeatherUniforms keys each one declares). */
export const WX_TERRAIN_UNIFORMS = ['wxA', 'wxB', 'wxC', 'wxD', 'wxE', 'wxF', 'wxCam', 'wxOcc', 'wxOccM'] as const
export const WX_WATER_UNIFORMS = ['wxA', 'wxB', 'wxC', 'wxD', 'wxCam'] as const
export const WX_GRASS_UNIFORMS = ['wxA', 'wxB', 'wxC', 'wxD', 'wxF', 'wxCam', 'wxOcc', 'wxOccM'] as const
/** What `sroShelter` / `sroShelterTop` read: the uniforms and the sampler (a consumer declares the uniforms itself). */
export const WX_SHELTER_UNIFORMS = ['wxCam', 'wxOcc', 'wxOccM', 'wxF'] as const
export const WX_SHELTER_SAMPLER = 'wxOccMap'
/** What `sroWind` reads. */
export const WX_SWAY_UNIFORMS = ['wxA', 'wxB'] as const

/** Every weather define (weather/index.ts turns them on per level). */
export const WX_DEFINES = ['WX', 'WX_REFL', 'WX_PUDDLE', 'WX_RIPPLE', 'WX_RIPPLE2', 'WX_SHELTER', 'WX_OCC8', 'WX_WIND', 'WX_WATER'] as const
export type WeatherDefine = (typeof WX_DEFINES)[number]

const f = (v: number) => v.toFixed(3)
const uniformsWGSL = (names: readonly string[]) => names.map(n => `uniform ${n}: vec4f;\n`).join('')
const uniformsGLSL = (names: readonly string[]) => names.map(n => `uniform vec4 ${n};\n`).join('')

// ---- shared helpers ----------------------------------------------------------------------------------------------

/**
 * The shelter map (D20) and its readers, WGSL: `sroShelterTop(xz)` = the top of the cover above (x, z) in world metres
 * (−10000: none, outside the map, or no valid map), `sroShelter(p)` = 1 exposed .. 0 sheltered (`1 − smoothstep(0.25,
 * 1, top − y)`, fading to exposed over the last 4 m of the map). Declares `wxOccMap`; the caller declares the
 * WX_SHELTER_UNIFORMS. Every tap is textureSampleLevel, so it runs in any stage and any control flow. `WX_OCC8`: the
 * map is RGBA8 with the 16-bit height in R and G.
 */
export const WX_SHELTER_WGSL = /* wgsl */ `var wxOccMap: texture_2d<f32>;
var wxOccMapSampler: sampler;
fn wxOccUv(xz: vec2f) -> vec2f {
  let d = xz - uniforms.wxOcc.xy;
  return vec2f(dot(uniforms.wxOccM.xy, d), dot(uniforms.wxOccM.zw, d)) * 0.5 + vec2f(0.5);
}
fn sroShelterTop(xz: vec2f) -> f32 {
  let uv = wxOccUv(xz);
  let t = textureSampleLevel(wxOccMap, wxOccMapSampler, uv, 0.0);
#ifdef WX_OCC8
  let rel = (t.r * 65280.0 + t.g * 255.0) / 65535.0 * 128.0 - 64.0;
#else
  let rel = t.r;
#endif
  let inside = uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 && uniforms.wxCam.w > 0.5;
  return select(-10000.0, rel + uniforms.wxF.x, inside);
}
fn sroShelter(p: vec3f) -> f32 {
  let uv = wxOccUv(p.xz);
  let edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)) * uniforms.wxOcc.z;
  let s = 1.0 - smoothstep(0.25, 1.0, sroShelterTop(p.xz) - p.y);
  return mix(1.0, s, smoothstep(0.0, 4.0, edge));
}
`

/** GLSL twin of WX_SHELTER_WGSL (a highp sampler: the vertex stage's default sampler precision is lowp). */
export const WX_SHELTER_GLSL = /* glsl */ `uniform highp sampler2D wxOccMap;
vec2 wxOccUv(vec2 xz) {
  vec2 d = xz - wxOcc.xy;
  return vec2(dot(wxOccM.xy, d), dot(wxOccM.zw, d)) * 0.5 + vec2(0.5);
}
float sroShelterTop(vec2 xz) {
  vec2 uv = wxOccUv(xz);
  vec4 t = textureLod(wxOccMap, uv, 0.0);
#ifdef WX_OCC8
  float rel = (t.r * 65280.0 + t.g * 255.0) / 65535.0 * 128.0 - 64.0;
#else
  float rel = t.r;
#endif
  bool inside = uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 && wxCam.w > 0.5;
  return inside ? rel + wxF.x : -10000.0;
}
float sroShelter(vec3 p) {
  vec2 uv = wxOccUv(p.xz);
  float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)) * wxOcc.z;
  float s = 1.0 - smoothstep(0.25, 1.0, sroShelterTop(p.xz) - p.y);
  return mix(1.0, s, smoothstep(0.0, 4.0, edge));
}
`

/**
 * The wind shared by grass, Classic trees and the PBR foliage plugin (D23), WGSL: `sroWind(root)` → x = the sway
 * signal at that root (two sines phased by position, a gust wave travelling downwind, a steady downwind lean that grows
 * with the wind; about −1..1 calm, up to ~2 in a storm), y = the strength multiplier (0.4 calm .. 2.6 storm, × the
 * retail bend), z = the rain droop 0..1. Direction: (wxB.x, wxB.y). Reads wxA, wxB (time in wxB.w).
 */
export const WX_SWAY_WGSL = /* wgsl */ `fn sroWind(root: vec3f) -> vec3f {
  let t = uniforms.wxB.w;
  let z = clamp(uniforms.wxB.z, 0.0, 1.0);
  let ph = dot(root.xz, vec2f(0.21, 0.17));
  let sway = sin(t * 1.9 + ph) * 0.65 + sin(t * 3.3 + ph * 1.7) * 0.35;
  let gust = sin(dot(root.xz, uniforms.wxB.xy) * 0.35 - t * 2.1);
  return vec3f(sway + 0.5 * z * gust + 0.6 * z, 0.4 + 2.2 * z, clamp(uniforms.wxA.z, 0.0, 1.0));
}
`

export const WX_SWAY_GLSL = /* glsl */ `vec3 sroWind(vec3 root) {
  float t = wxB.w;
  float z = clamp(wxB.z, 0.0, 1.0);
  float ph = dot(root.xz, vec2(0.21, 0.17));
  float sway = sin(t * 1.9 + ph) * 0.65 + sin(t * 3.3 + ph * 1.7) * 0.35;
  float gust = sin(dot(root.xz, wxB.xy) * 0.35 - t * 2.1);
  return vec3(sway + 0.5 * z * gust + 0.6 * z, 0.4 + 2.2 * z, clamp(wxA.z, 0.0, 1.0));
}
`

/** Rec. 601 luma, value noise (WGSL). */
const HELPERS_WGSL = /* wgsl */ `fn wxLuma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}
fn wxHash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn wxNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let q = fract(p);
  let u = q * q * (3.0 - 2.0 * q);
  return mix(mix(wxHash(i), wxHash(i + vec2f(1.0, 0.0)), u.x), mix(wxHash(i + vec2f(0.0, 1.0)), wxHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
`
const HELPERS_GLSL = /* glsl */ `float wxLuma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}
float wxHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float wxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 q = fract(p);
  vec2 u = q * q * (3.0 - 2.0 * q);
  return mix(mix(wxHash(i), wxHash(i + vec2(1.0, 0.0)), u.x), mix(wxHash(i + vec2(0.0, 1.0)), wxHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`

/**
 * Rain ripples (WEATHER §6.6; wave 12 RAIN-P: weather/ripples.ts `rainRingCode`, the one ring function of every
 * consumer, with the drop density and ring size growing with the rain rate): each tap of the ripple texture becomes an
 * expanding ring; returns (tilt x, tilt z, crown, |height|) summed over one or two layers (WX_RIPPLE2: the second at ×
 * 1.37, offset, half a period later; both: a third, coarser one in a downpour). Gradient taps.
 */
const RIPPLES_WGSL = /* wgsl */ `${rainRingCode('wgsl', 'wxRing')}fn wxRipples(uv: vec2f, du: vec2f, dv: vec2f) -> vec4f {
  let rr = clamp(uniforms.wxA.z, 0.0, 1.0);
  var r = wxRing(textureSampleGrad(wxRipple, wxRippleSampler, uv, du, dv), 0.0, uniforms.wxA.w, rr);
#ifdef WX_RIPPLE2
  r = r + wxRing(textureSampleGrad(wxRipple, wxRippleSampler, uv * 1.37 + vec2f(0.31, 0.57), du * 1.37, dv * 1.37), 0.5, uniforms.wxA.w, rr);
#endif
  r = r + wxRing(textureSampleGrad(wxRipple, wxRippleSampler, uv * 0.73 + vec2f(0.61, 0.13), du * 0.73, dv * 0.73), 0.25, uniforms.wxA.w, rr) * smoothstep(${RAIN_RING_DENSE.toFixed(3)}, ${RAIN_RING_DENSE_FULL.toFixed(3)}, rr);
  return r;
}
`
const RIPPLES_GLSL = /* glsl */ `${rainRingCode('glsl', 'wxRing')}vec4 wxRipples(vec2 uv, vec2 du, vec2 dv) {
  float rr = clamp(wxA.z, 0.0, 1.0);
  vec4 r = wxRing(textureGrad(wxRipple, uv, du, dv), 0.0, wxA.w, rr);
#ifdef WX_RIPPLE2
  r += wxRing(textureGrad(wxRipple, uv * 1.37 + vec2(0.31, 0.57), du * 1.37, dv * 1.37), 0.5, wxA.w, rr);
#endif
  r += wxRing(textureGrad(wxRipple, uv * 0.73 + vec2(0.61, 0.13), du * 0.73, dv * 0.73), 0.25, wxA.w, rr) * smoothstep(${RAIN_RING_DENSE.toFixed(3)}, ${RAIN_RING_DENSE_FULL.toFixed(3)}, rr);
  return r;
}
`

/** The terrain surface class table (pbr/classes.ts TERRAIN_SURFACE_PARAMS) as a function: porosity, gloss, puddle. */
function surfFn(lang: 'wgsl' | 'glsl'): string {
  const P = TERRAIN_SURFACE_PARAMS
  const v = (i: number) => `${lang === 'wgsl' ? 'vec4f' : 'vec4'}(${f(P[i]!.porosity)}, ${f(P[i]!.gloss)}, ${f(P[i]!.puddle)}, 0.0)`
  const cases = P.map((_, i) => i).slice(1)
    .map(i => lang === 'wgsl' ? `  if (c == ${i}) { return ${v(i)}; }\n` : `  if (c == ${i}) return ${v(i)};\n`).join('')
  return lang === 'wgsl'
    ? `fn wxSurf(c: i32) -> vec4f {\n${cases}  return ${v(0)};\n}\n`
    : `vec4 wxSurf(int c) {\n${cases}  return ${v(0)};\n}\n`
}

// ---- terrain -----------------------------------------------------------------------------------------------------

const TERRAIN_SAMPLERS_WGSL = /* wgsl */ `#ifdef WX
var<private> wxS: vec4f;
var<private> wxGloss: f32;
var<private> wxPud: f32;
var<private> wxFilm: f32;
var<private> wxN: vec3f;
${surfFn('wgsl')}${HELPERS_WGSL}#ifdef WX_PUDDLE
var wetMap: texture_2d<f32>;
var wetMapSampler: sampler;
#endif
#ifdef WX_RIPPLE
var wxRipple: texture_2d<f32>;
var wxRippleSampler: sampler;
${RIPPLES_WGSL}#endif
#ifdef WX_SHELTER
${WX_SHELTER_WGSL}#endif
#endif
`
const TERRAIN_SAMPLERS_GLSL = /* glsl */ `#ifdef WX
vec4 wxS;
float wxGloss;
float wxPud;
float wxFilm;
vec3 wxN;
${surfFn('glsl')}${HELPERS_GLSL}#ifdef WX_PUDDLE
uniform sampler2D wetMap;
#endif
#ifdef WX_RIPPLE
uniform sampler2D wxRipple;
${RIPPLES_GLSL}#endif
#ifdef WX_SHELTER
${WX_SHELTER_GLSL}#endif
#endif
`

// Inside the layer loop: the surface parameters blend with the layer's weight, like the colour.
const TERRAIN_LAYER_WGSL = /* wgsl */ `#ifdef WX
    if (k == 0) {
      wxS = wxSurf(sroClass);
    } else {
      wxS = mix(wxS, wxSurf(sroClass), a);
    }
#endif
`
const TERRAIN_LAYER_GLSL = /* glsl */ `#ifdef WX
    if (k == 0) {
      wxS = wxSurf(sroClass);
    } else {
      wxS = mix(wxS, wxSurf(sroClass), a);
    }
#endif
`

// Before the lightmap: the soaked albedo (WEATHER §6.3) and, from the wet map, the puddle and its dark bottom. The
// puddle threshold falls as the puddle level rises, so the deepest basins fill first.
const TERRAIN_PRE_WGSL = /* wgsl */ `#ifdef WX
  wxGloss = 0.0;
  wxPud = 0.0;
  wxFilm = 0.0;
  wxN = vec3f(0.0, 1.0, 0.0);
  if (uniforms.wxA.x + uniforms.wxA.y > 0.001) {
    let wxP = fragmentInputs.vWorld;
    var wxX = 1.0;
#ifdef WX_SHELTER
    wxX = sroShelter(wxP);
#endif
    let wxW = clamp(uniforms.wxA.x, 0.0, 1.0) * wxX;
    color = color * mix(1.0, 1.0 - 0.45 * wxS.x, wxW);
    color = max(mix(vec3f(wxLuma(color)), color, 1.0 + 0.15 * wxW), vec3f(0.0));
    var wxG = wxS.y * wxW * 0.6;
#ifdef WX_PUDDLE
    let wxM = textureSampleLevel(wetMap, wetMapSampler, (lp / 20.0 + vec2f(0.5)) / 97.0, 0.0);
    let wxQ = vec2f(wxM.g, wxM.a) * 2.0 - vec2f(1.0);
    let wxQq = dot(wxQ, wxQ);
    wxN = select(vec3f(0.0, 1.0, 0.0), normalize(vec3f(wxQ.x, max(0.2, sqrt(max(0.0, 1.0 - wxQq))), wxQ.y)), wxQq <= 1.02);
    let wxL = clamp(uniforms.wxA.y, 0.0, 1.0);
    let wxNz = wxNoise(wxP.xz * 0.7) * 0.6 + wxNoise(wxP.xz * 2.3) * 0.4;
    let wxT = 1.0 - 0.65 * wxL;
    wxPud = smoothstep(wxT, wxT + 0.08, wxM.r + (wxNz - 0.5) * 0.24) * smoothstep(0.0, 0.1, wxL) * wxX * min(1.0, wxS.z * 4.0);
    color = mix(color, color * 0.55, wxPud);
    wxG = mix(wxG, 1.0, wxPud);
#ifdef WX_RIPPLE
    wxFilm = clamp(uniforms.wxA.z, 0.0, 1.0) * smoothstep(0.05, 0.35, wxW) * smoothstep(0.2, 0.6, wxM.b) * clamp(wxS.z * 1.15, 0.0, 1.0);
    wxG = max(wxG, wxFilm * 0.8);
#endif
#endif
    wxGloss = wxG;
  }
#endif
`
const TERRAIN_PRE_GLSL = /* glsl */ `#ifdef WX
  wxGloss = 0.0;
  wxPud = 0.0;
  wxFilm = 0.0;
  wxN = vec3(0.0, 1.0, 0.0);
  if (wxA.x + wxA.y > 0.001) {
    vec3 wxP = vWorld;
    float wxX = 1.0;
#ifdef WX_SHELTER
    wxX = sroShelter(wxP);
#endif
    float wxW = clamp(wxA.x, 0.0, 1.0) * wxX;
    color *= mix(1.0, 1.0 - 0.45 * wxS.x, wxW);
    color = max(mix(vec3(wxLuma(color)), color, 1.0 + 0.15 * wxW), vec3(0.0));
    float wxG = wxS.y * wxW * 0.6;
#ifdef WX_PUDDLE
    vec4 wxM = textureLod(wetMap, (lp / 20.0 + vec2(0.5)) / 97.0, 0.0);
    vec2 wxQ = vec2(wxM.g, wxM.a) * 2.0 - vec2(1.0);
    float wxQq = dot(wxQ, wxQ);
    wxN = wxQq <= 1.02 ? normalize(vec3(wxQ.x, max(0.2, sqrt(max(0.0, 1.0 - wxQq))), wxQ.y)) : vec3(0.0, 1.0, 0.0);
    float wxL = clamp(wxA.y, 0.0, 1.0);
    float wxNz = wxNoise(wxP.xz * 0.7) * 0.6 + wxNoise(wxP.xz * 2.3) * 0.4;
    float wxT = 1.0 - 0.65 * wxL;
    wxPud = smoothstep(wxT, wxT + 0.08, wxM.r + (wxNz - 0.5) * 0.24) * smoothstep(0.0, 0.1, wxL) * wxX * min(1.0, wxS.z * 4.0);
    color = mix(color, color * 0.55, wxPud);
    wxG = mix(wxG, 1.0, wxPud);
#ifdef WX_RIPPLE
    wxFilm = clamp(wxA.z, 0.0, 1.0) * smoothstep(0.05, 0.35, wxW) * smoothstep(0.2, 0.6, wxM.b) * clamp(wxS.z * 1.15, 0.0, 1.0);
    wxG = max(wxG, wxFilm * 0.8);
#endif
#endif
    wxGloss = wxG;
  }
#endif
`

// Inside the lightmap block: baked shadows fade under overcast (Classic sky only, WEATHER §7.1).
const TERRAIN_LIGHT_WGSL = /* wgsl */ `    if (uniforms.wxF.w > 0.5) {
      lmT = mix(vec3f(0.85), lmT, uniforms.wxF.z);
    }
`
const TERRAIN_LIGHT_GLSL = /* glsl */ `    if (wxF.w > 0.5) {
      lmT = mix(vec3(0.85), lmT, wxF.z);
    }
`

// After the lightmap: sky reflection (Fresnel plus a stylised floor, so wet ground keeps a faint sheen and a puddle
// mirrors the sky even seen from above; the LDR sky is lifted × 1.25 since a real sky outshines the ground; dimmer in
// baked shadow), the sun glint (only where the lightmap is lit), ripple normals and rings in puddles; then the lightning
// flash and the overcast brightness (both always on, uniform branches).
const TERRAIN_POST_WGSL = /* wgsl */ `#ifdef WX
  if (wxGloss > 0.001) {
    let wxP = fragmentInputs.vWorld;
    var wxNn = normalize(mix(wxN, vec3f(0.0, 1.0, 0.0), wxPud));
    var wxRg = 0.0;
#ifdef WX_RIPPLE
    let wxR = wxRipples(wxP.xz * 0.45, vec2f(gx.x, -gx.y) * 0.0135, vec2f(gy.x, -gy.y) * 0.0135);
    let wxRa = max(wxPud * smoothstep(0.0, 0.15, uniforms.wxD.w), wxFilm) * (1.0 - smoothstep(0.02, 0.05, sqrt(length(gx) * length(gy)) * 0.1));
    wxNn = normalize(wxNn + vec3f(wxR.x, 0.0, wxR.y) * (0.9 * wxRa));
    wxRg = (abs(wxR.w) * 0.6 + wxR.z) * wxRa;
#endif
    let wxV = normalize(uniforms.wxCam.xyz - wxP);
    let wxRd = reflect(-wxV, wxNn);
    let wxFr = 0.02 + 0.98 * pow(1.0 - clamp(dot(wxNn, wxV), 0.0, 1.0), 5.0);
    let wxLm = clamp(wxLuma(lm), 0.0, 1.0);
#ifdef WX_REFL
    let wxSky = mix(uniforms.wxD.rgb, uniforms.wxC.rgb, clamp(wxRd.y, 0.0, 1.0)) * 1.25;
    color = mix(color, wxSky * mix(0.55, 1.0, wxLm), clamp((wxFr + mix(0.06, 0.3, wxPud)) * wxGloss, 0.0, 1.0));
    color = color + wxSky * (0.3 * wxRg);
#endif
    let wxGl = uniforms.wxE.w * wxGloss * pow(max(dot(wxRd, uniforms.wxE.xyz), 0.0), mix(40.0, 600.0, wxPud)) * 0.6 * smoothstep(0.45, 0.85, wxLm);
    color = color + vec3f(wxGl);
  }
#endif
  if (uniforms.wxC.w > 0.001) {
    color = color + albedo * (uniforms.wxC.w * 0.25);
  }
  if (uniforms.wxF.w > 0.5) {
    color = color * uniforms.wxF.y;
  }
`
const TERRAIN_POST_GLSL = /* glsl */ `#ifdef WX
  if (wxGloss > 0.001) {
    vec3 wxP = vWorld;
    vec3 wxNn = normalize(mix(wxN, vec3(0.0, 1.0, 0.0), wxPud));
    float wxRg = 0.0;
#ifdef WX_RIPPLE
    vec4 wxR = wxRipples(wxP.xz * 0.45, vec2(gx.x, -gx.y) * 0.0135, vec2(gy.x, -gy.y) * 0.0135);
    float wxRa = max(wxPud * smoothstep(0.0, 0.15, wxD.w), wxFilm) * (1.0 - smoothstep(0.02, 0.05, sqrt(length(gx) * length(gy)) * 0.1));
    wxNn = normalize(wxNn + vec3(wxR.x, 0.0, wxR.y) * (0.9 * wxRa));
    wxRg = (abs(wxR.w) * 0.6 + wxR.z) * wxRa;
#endif
    vec3 wxV = normalize(wxCam.xyz - wxP);
    vec3 wxRd = reflect(-wxV, wxNn);
    float wxFr = 0.02 + 0.98 * pow(1.0 - clamp(dot(wxNn, wxV), 0.0, 1.0), 5.0);
    float wxLm = clamp(wxLuma(lm), 0.0, 1.0);
#ifdef WX_REFL
    vec3 wxSky = mix(wxD.rgb, wxC.rgb, clamp(wxRd.y, 0.0, 1.0)) * 1.25;
    color = mix(color, wxSky * mix(0.55, 1.0, wxLm), clamp((wxFr + mix(0.06, 0.3, wxPud)) * wxGloss, 0.0, 1.0));
    color += wxSky * (0.3 * wxRg);
#endif
    float wxGl = wxE.w * wxGloss * pow(max(dot(wxRd, wxE.xyz), 0.0), mix(40.0, 600.0, wxPud)) * 0.6 * smoothstep(0.45, 0.85, wxLm);
    color += vec3(wxGl);
  }
#endif
  if (wxC.w > 0.001) {
    color += albedo * (wxC.w * 0.25);
  }
  if (wxF.w > 0.5) {
    color *= wxF.y;
  }
`

// ---- water -------------------------------------------------------------------------------------------------------

const WATER_SAMPLERS_WGSL = /* wgsl */ `#ifdef WX_WATER
var wxRipple: texture_2d<f32>;
var wxRippleSampler: sampler;
${RIPPLES_WGSL}#endif
`
const WATER_SAMPLERS_GLSL = /* glsl */ `#ifdef WX_WATER
uniform sampler2D wxRipple;
${RIPPLES_GLSL}#endif
`

// The derivatives come first, in the fragment's uniform control flow; the taps are gradient taps.
const WATER_NORMAL_WGSL = /* wgsl */ `#ifdef WX_WATER
  let wxP = fragmentInputs.vWorld;
  let wxU = wxP.xz * 0.45;
  let wxDu = dpdx(wxU);
  let wxDv = dpdy(wxU);
  var wxRg = 0.0;
  if (uniforms.wxA.z > 0.001) {
    let wxR = wxRipples(wxU, wxDu * 0.3, wxDv * 0.3);
    nrm = normalize(nrm + vec3f(wxR.x, 0.0, wxR.y) * (0.9 * smoothstep(0.0, 0.15, uniforms.wxA.z)));
    wxRg = abs(wxR.w) * 0.6 + wxR.z;
  }
#endif
`
const WATER_NORMAL_GLSL = /* glsl */ `#ifdef WX_WATER
  vec3 wxP = vWorld;
  vec2 wxU = wxP.xz * 0.45;
  vec2 wxDu = dFdx(wxU);
  vec2 wxDv = dFdy(wxU);
  float wxRg = 0.0;
  if (wxA.z > 0.001) {
    vec4 wxR = wxRipples(wxU, wxDu * 0.3, wxDv * 0.3);
    nrm = normalize(nrm + vec3(wxR.x, 0.0, wxR.y) * (0.9 * smoothstep(0.0, 0.15, wxA.z)));
    wxRg = abs(wxR.w) * 0.6 + wxR.z;
  }
#endif
`

const WATER_COLOR_WGSL = /* wgsl */ `#ifdef WX_WATER
  {
    let wxV = normalize(uniforms.wxCam.xyz - wxP);
    let wxRd = reflect(-wxV, nrm);
    let wxFr = 0.02 + 0.98 * pow(1.0 - clamp(dot(nrm, wxV), 0.0, 1.0), 5.0);
    let wxSky = mix(uniforms.wxD.rgb, uniforms.wxC.rgb, clamp(wxRd.y, 0.0, 1.0));
    rgb = mix(rgb, wxSky, wxFr * 0.6);
    rgb = rgb + wxSky * (wxRg * 0.35 * uniforms.wxA.z);
  }
#endif
  if (uniforms.wxC.w > 0.001) {
    rgb = rgb * (1.0 + uniforms.wxC.w * 0.25);
  }
`
const WATER_COLOR_GLSL = /* glsl */ `#ifdef WX_WATER
  {
    vec3 wxV = normalize(wxCam.xyz - wxP);
    vec3 wxRd = reflect(-wxV, nrm);
    float wxFr = 0.02 + 0.98 * pow(1.0 - clamp(dot(nrm, wxV), 0.0, 1.0), 5.0);
    vec3 wxSky = mix(wxD.rgb, wxC.rgb, clamp(wxRd.y, 0.0, 1.0));
    rgb = mix(rgb, wxSky, wxFr * 0.6);
    rgb += wxSky * (wxRg * 0.35 * wxA.z);
  }
#endif
  if (wxC.w > 0.001) {
    rgb *= 1.0 + wxC.w * 0.25;
  }
`

// ---- grass -------------------------------------------------------------------------------------------------------

const GRASS_VARYINGS_WGSL = '#ifdef WX\nvarying vWxG: vec2f;\n#endif\n'
const GRASS_VARYINGS_GLSL = '#ifdef WX\nvarying vec2 vWxG;\n#endif\n'

const GRASS_DECL_WGSL = `#ifdef WX_WIND
${WX_SWAY_WGSL}#endif
#ifdef WX
#ifdef WX_SHELTER
${WX_SHELTER_WGSL}#endif
#endif
`
const GRASS_DECL_GLSL = `#ifdef WX_WIND
${WX_SWAY_GLSL}#endif
#ifdef WX
#ifdef WX_SHELTER
${WX_SHELTER_GLSL}#endif
#endif
`

// Replaces the fixed retail sway: the weather's direction and strength, a gust wave, and in rain the heads bow
// downwind and droop (WEATHER §6.7). Weather Off keeps HEAD's line.
const GRASS_SWAY_WGSL = /* wgsl */ `#ifdef WX_WIND
  let wxWd = sroWind(root);
  let wxBend = uniforms.scFade.z * h * clamp(h, 0.3, 1.0) * wxWd.x * wxWd.y;
  let wxDroop = wxWd.z * h * s;
  p = p + vec3f(uniforms.wxB.x, 0.0, uniforms.wxB.y) * (wxBend * s + 0.25 * wxDroop) - vec3f(0.0, 0.15 * wxDroop * clamp(h, 0.0, 1.0), 0.0);
#else
  p = p + vec3f(0.8, 0.0, 0.6) * (bend * s);
#endif
`
const GRASS_SWAY_GLSL = /* glsl */ `#ifdef WX_WIND
  vec3 wxWd = sroWind(root);
  float wxBend = scFade.z * h * clamp(h, 0.3, 1.0) * wxWd.x * wxWd.y;
  float wxDroop = wxWd.z * h * s;
  p += vec3(wxB.x, 0.0, wxB.y) * (wxBend * s + 0.25 * wxDroop) - vec3(0.0, 0.15 * wxDroop * clamp(h, 0.0, 1.0), 0.0);
#else
  p += vec3(0.8, 0.0, 0.6) * (bend * s);
#endif
`

// Per plant (vertex): wetness under the shelter test at the plant's top, and a Fresnel sheen with an up normal.
const GRASS_LIGHT_WGSL = /* wgsl */ `#ifdef WX
  {
    var wxX = 1.0;
#ifdef WX_SHELTER
    wxX = sroShelter(root + vec3f(0.0, 0.3, 0.0));
#endif
    let wxW = clamp(uniforms.wxA.x, 0.0, 1.0) * wxX;
    let wxV = normalize(uniforms.wxCam.xyz - p);
    let wxFr = 0.02 + 0.98 * pow(1.0 - abs(wxV.y), 5.0);
    vertexOutputs.vWxG = vec2f(wxW, wxFr * wxW);
  }
#endif
`
const GRASS_LIGHT_GLSL = /* glsl */ `#ifdef WX
  {
    float wxX = 1.0;
#ifdef WX_SHELTER
    wxX = sroShelter(root + vec3(0.0, 0.3, 0.0));
#endif
    float wxW = clamp(wxA.x, 0.0, 1.0) * wxX;
    vec3 wxV = normalize(wxCam.xyz - p);
    float wxFr = 0.02 + 0.98 * pow(1.0 - abs(wxV.y), 5.0);
    vWxG = vec2(wxW, wxFr * wxW);
  }
#endif
`

const GRASS_COLOR_WGSL = /* wgsl */ `#ifdef WX
  rgb = rgb * mix(1.0, 0.775, fragmentInputs.vWxG.x);
  rgb = rgb + uniforms.wxD.rgb * (0.12 * (0.3 * fragmentInputs.vWxG.x + fragmentInputs.vWxG.y));
#endif
#ifndef SRO_HDR
  if (uniforms.wxC.w > 0.001) {
    rgb = rgb * (1.0 + uniforms.wxC.w * 0.25);
  }
#endif
  if (uniforms.wxF.w > 0.5) {
    rgb = rgb * uniforms.wxF.y;
  }
`
const GRASS_COLOR_GLSL = /* glsl */ `#ifdef WX
  rgb *= mix(1.0, 0.775, vWxG.x);
  rgb += wxD.rgb * (0.12 * (0.3 * vWxG.x + vWxG.y));
#endif
#ifndef SRO_HDR
  if (wxC.w > 0.001) {
    rgb *= 1.0 + wxC.w * 0.25;
  }
#endif
  if (wxF.w > 0.5) {
    rgb *= wxF.y;
  }
`

export const WEATHER_CHUNKS: WorldShaderChunks = {
  terrain: {
    uniforms: WX_TERRAIN_UNIFORMS,
    samplers: ['wetMap', 'wxRipple', 'wxOccMap'],
    vWorld: true,
    wgsl: {
      uniforms: uniformsWGSL(WX_TERRAIN_UNIFORMS),
      samplers: TERRAIN_SAMPLERS_WGSL,
      layer: TERRAIN_LAYER_WGSL,
      preLight: TERRAIN_PRE_WGSL,
      lightTerm: TERRAIN_LIGHT_WGSL,
      postLight: TERRAIN_POST_WGSL,
    },
    glsl: {
      uniforms: uniformsGLSL(WX_TERRAIN_UNIFORMS),
      samplers: TERRAIN_SAMPLERS_GLSL,
      layer: TERRAIN_LAYER_GLSL,
      preLight: TERRAIN_PRE_GLSL,
      lightTerm: TERRAIN_LIGHT_GLSL,
      postLight: TERRAIN_POST_GLSL,
    },
  },
  water: {
    uniforms: WX_WATER_UNIFORMS,
    samplers: ['wxRipple'],
    vWorld: true,
    wgsl: {
      uniforms: uniformsWGSL(WX_WATER_UNIFORMS),
      samplers: WATER_SAMPLERS_WGSL,
      normal: WATER_NORMAL_WGSL,
      postColor: WATER_COLOR_WGSL,
    },
    glsl: {
      uniforms: uniformsGLSL(WX_WATER_UNIFORMS),
      samplers: WATER_SAMPLERS_GLSL,
      normal: WATER_NORMAL_GLSL,
      postColor: WATER_COLOR_GLSL,
    },
  },
  grass: {
    uniforms: WX_GRASS_UNIFORMS,
    samplers: ['wxOccMap'],
    wgsl: {
      uniforms: uniformsWGSL(WX_GRASS_UNIFORMS),
      varyings: GRASS_VARYINGS_WGSL,
      vertexDecl: GRASS_DECL_WGSL,
      vertexSway: GRASS_SWAY_WGSL,
      vertexLight: GRASS_LIGHT_WGSL,
      fragmentColor: GRASS_COLOR_WGSL,
    },
    glsl: {
      uniforms: uniformsGLSL(WX_GRASS_UNIFORMS),
      varyings: GRASS_VARYINGS_GLSL,
      vertexDecl: GRASS_DECL_GLSL,
      vertexSway: GRASS_SWAY_GLSL,
      vertexLight: GRASS_LIGHT_GLSL,
      fragmentColor: GRASS_COLOR_GLSL,
    },
  },
}

/** Shared helper strings other weather modules paste (the rain, the plugin). */
export const WX_HELPERS_WGSL = HELPERS_WGSL
export const WX_HELPERS_GLSL = HELPERS_GLSL
