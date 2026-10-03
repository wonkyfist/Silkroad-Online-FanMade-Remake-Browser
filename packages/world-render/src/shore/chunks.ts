/**
 * Portions ported from Tidewater (github.com/dgreenheck/tidewater, `ShoreWaves.js` at `4811ba4`), MIT licence, Copyright (c)
 * 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.
 *
 * Shore v1's shader code (docs/COAST.md §8.8, §12.5), inserted into the ocean's materials through the shore seam
 * (ocean/shore-seam.ts: the insertion points, the variables, the uniforms). Owned by CST-S. The numbers are shore/swash.ts'
 * (the CPU reference the tests check):
 *
 * - **Vertex:** the Gerstner shore swell (one train per shore point, travelling along −∇G, the field's shore normal;
 *   phase = the cycle counter + the along-shore offset + the travel time 2G / √(g d), exact on a planar slope, so the
 *   crests bunch up in shallow water; Green's law height until H = 0.78 d, then the bore's 0.78 d; the front face
 *   steepens once it breaks) and the swash sheet (`y = max(wave, SL + R(t))`, R from the swash cycle with lobes and
 *   beach cusps (P-LOOK: swash.ts CUSP_M) that differ from wave to wave along the shore, never below the minimum film, only the film on steep land, sinking under
 *   the sand beyond the run-up's reach so no hollow behind a beach floods). The depth test against the terrain shows the
 *   water climbing the sand and sliding back. `sroOcSwash` = the sheet's height above the sea level.
 * - **Fragment:** the foam: the breaking line and its trail behind each crest,
 *   a band along the waterline (its last 2.5 m of sea: COAST's "shallower than 0.3 m" by depth covered 10 m of S1's
 *   1:33 floor in white), the swash bore (a foam band at the uprush's front over a light
 *   lace, then the lace decaying on the backwash) and
 *   the analytic bead where the film `sroOcSwash − h_sand` is thinner than 3 cm; shaped by the lace (shore/lace.ts:
 *   two taps, a mat → holes → lace → strands as the amount falls) where `sroShoreB.z` is on, else the plain amount.
 *
 * No varying, no attribute (the ocean's one packed varying carries the sheet height). Field taps: two explicit-level
 * taps in the vertex stage and two in the fragment (the shore normal), plus two lace taps at the ocean's fragment
 * point (uniform control flow, COAST F14). Every name starts with `sroSh`.
 *
 * Uniforms (vec4): `sroShoreA` = (cycle counter in waves (wraps at PHASE_WRAP), period s, maximum run-up m, the shore
 * swell's height at the reference depth m); `sroShoreB` = (the nominal slope 1:n, foam gain, lace on, bead on).
 */
import type { ShoreCode } from '../ocean/shore-seam.ts'
import { LACE_TILE_M } from './lace.ts'
import {
  BACKWASH_EXP,
  BACKWASH_SHARE,
  BEAD_FILM_M,
  BREAK_GAMMA,
  CUSP_M,
  CUSP_SHARE,
  G_ACCEL,
  GREEN_REF_DEPTH_M,
  MIN_DEPTH_M,
  MIN_FILM_M,
  ROCK_SLOPE,
  SWELL_ZONE_M,
  UPRUSH_EXP,
  UPRUSH_SHARE,
} from './swash.ts'

type Lang = 'wgsl' | 'glsl'

const f = (v: number): string => {
  const r = Math.round(v * 1e6) / 1e6
  return Number.isInteger(r) ? r.toFixed(1) : String(r)
}

/** The lace tile (m) and the second tap's scale (m). */
export const LACE_TAP_M: readonly [number, number] = [LACE_TILE_M, LACE_TILE_M * 1.55]
/** The breaking foam's trail behind a crest (s) and the backwash's foam decay (s). */
export const BREAK_TRAIL_S = 2.2
export const BACKWASH_FOAM_S = 1.6
/** The waterline's foam band: full to the first, gone by the second shore distance (m, sea side). */
export const EDGE_BAND_M: readonly [number, number] = [0.5, 2.5]
/** The uprushing bore's foam band lies where its film is thinner than this (m): the front; behind it a light lace. */
export const BORE_FRONT_FILM_M = 0.1

/** The helper functions (both stages declare their own copy). */
function helpers(lang: Lang): string {
  if (lang === 'wgsl') {
    return `fn sroShHash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + vec3f(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
fn sroShNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let u = fract(p);
  let s = u * u * (vec2f(3.0) - 2.0 * u);
  return mix(mix(sroShHash(i), sroShHash(i + vec2f(1.0, 0.0)), s.x), mix(sroShHash(i + vec2f(0.0, 1.0)), sroShHash(i + vec2f(1.0, 1.0)), s.x), s.y);
}
fn sroShOff(p: vec2f) -> f32 {
  return 0.6 * (sroShNoise(p / 90.0) - 0.5) + 0.25 * (sroShNoise(p / 37.0 + vec2f(17.3, 5.1)) - 0.5);
}
fn sroShLobe(p: vec2f, wave: f32) -> f32 {
  let o = sroShHash(vec2f(wave, 7.7)) * 97.0;
  return 0.6 + 0.4 * sroShNoise(p / 14.0 + vec2f(o, o * 0.61));
}
fn sroShCusp(p: vec2f, wave: f32) -> f32 {
  let o = sroShHash(vec2f(wave, 3.1)) * 89.0;
  return 1.0 - ${f(CUSP_SHARE)} * sroShNoise(p / ${f(CUSP_M)} + vec2f(o, -o * 0.73));
}
fn sroShCycle(s: f32) -> f32 {
  if (s < ${f(UPRUSH_SHARE)}) {
    return 1.0 - pow(max(1.0 - s / ${f(UPRUSH_SHARE)}, 0.0), ${f(UPRUSH_EXP)});
  }
  if (s < ${f(UPRUSH_SHARE + BACKWASH_SHARE)}) {
    return 1.0 - pow(max((s - ${f(UPRUSH_SHARE)}) / ${f(BACKWASH_SHARE)}, 0.0), ${f(BACKWASH_EXP)});
  }
  return 0.0;
}
fn sroShNormal(rest: vec2f, g: f32) -> vec2f {
  let uv = rest * uniforms.sroOcFieldXf.xy + uniforms.sroOcFieldXf.zw;
  let gx = sroOcDecode(textureSampleLevel(sroOcFieldMap, sroOcFieldMapSampler, uv + vec2f(4.0 * uniforms.sroOcFieldXf.x, 0.0), 0.0)).y;
  let gz = sroOcDecode(textureSampleLevel(sroOcFieldMap, sroOcFieldMapSampler, uv + vec2f(0.0, 4.0 * uniforms.sroOcFieldXf.y), 0.0)).y;
  let n = -vec2f(gx - g, gz - g) * 0.25;
  let l = length(n);
  return select(uniforms.sroOcS.xy, n / max(l, 1e-4), l > 0.3);
}
`
  }
  return `float sroShHash(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + vec3(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
float sroShNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  vec2 s = u * u * (vec2(3.0) - 2.0 * u);
  return mix(mix(sroShHash(i), sroShHash(i + vec2(1.0, 0.0)), s.x), mix(sroShHash(i + vec2(0.0, 1.0)), sroShHash(i + vec2(1.0, 1.0)), s.x), s.y);
}
float sroShOff(vec2 p) {
  return 0.6 * (sroShNoise(p / 90.0) - 0.5) + 0.25 * (sroShNoise(p / 37.0 + vec2(17.3, 5.1)) - 0.5);
}
float sroShLobe(vec2 p, float wave) {
  float o = sroShHash(vec2(wave, 7.7)) * 97.0;
  return 0.6 + 0.4 * sroShNoise(p / 14.0 + vec2(o, o * 0.61));
}
float sroShCusp(vec2 p, float wave) {
  float o = sroShHash(vec2(wave, 3.1)) * 89.0;
  return 1.0 - ${f(CUSP_SHARE)} * sroShNoise(p / ${f(CUSP_M)} + vec2(o, -o * 0.73));
}
float sroShCycle(float s) {
  if (s < ${f(UPRUSH_SHARE)}) return 1.0 - pow(max(1.0 - s / ${f(UPRUSH_SHARE)}, 0.0), ${f(UPRUSH_EXP)});
  if (s < ${f(UPRUSH_SHARE + BACKWASH_SHARE)}) return 1.0 - pow(max((s - ${f(UPRUSH_SHARE)}) / ${f(BACKWASH_SHARE)}, 0.0), ${f(BACKWASH_EXP)});
  return 0.0;
}
vec2 sroShNormal(vec2 rest, float g) {
  vec2 uv = rest * sroOcFieldXf.xy + sroOcFieldXf.zw;
  float gx = sroOcDecode(textureLod(sroOcFieldMap, uv + vec2(4.0 * sroOcFieldXf.x, 0.0), 0.0)).y;
  float gz = sroOcDecode(textureLod(sroOcFieldMap, uv + vec2(0.0, 4.0 * sroOcFieldXf.y), 0.0)).y;
  vec2 n = -vec2(gx - g, gz - g) * 0.25;
  float l = length(n);
  return l > 0.3 ? n / max(l, 1e-4) : sroOcS.xy;
}
`
}

/** Statements shared by both stages: the shore point's field values, phase and run-up (`v` = let/float, etc.). */
function common(lang: Lang): string {
  const w = lang === 'wgsl'
  const u = (n: string) => (w ? `uniforms.${n}` : n)
  const F = w ? 'let' : 'float'
  const V2 = w ? 'let' : 'vec2'
  return `  ${F} shG = sroOcField.y;
  ${F} shE = sroOcField.z;
  ${F} shD = max(-shE, ${f(MIN_DEPTH_M)});
  ${F} shJ = 1.0 - clamp(sroOcField.w, 0.0, 1.0);
  ${V2} shN = sroShNormal(sroOcRest, shG);
  ${F} shOff = sroShOff(sroOcRest);
  ${F} shTau = 2.0 * max(shG, 0.0) / sqrt(${f(G_ACCEL)} * shD);
  ${F} shW = ${u('sroShoreA')}.x + shOff + shTau / ${u('sroShoreA')}.y;
  ${F} shGreen = ${u('sroShoreA')}.w * pow(${f(GREEN_REF_DEPTH_M)} / shD, 0.25);
  ${F} shBrk = smoothstep(0.85, 1.0, shGreen / max(${f(BREAK_GAMMA)} * shD, 0.001));
  ${F} shZone = (1.0 - smoothstep(${f(SWELL_ZONE_M[0])}, ${f(SWELL_ZONE_M[1])}, shG)) * shJ;
  ${F} shCyc = ${u('sroShoreA')}.x + shOff;
  ${F} shS = fract(shCyc);
  ${F} shRw = ${u('sroShoreA')}.z * sroShLobe(sroOcRest, floor(shCyc)) * sroShCusp(sroOcRest, floor(shCyc));
  ${F} shIn = max(-shG, 0.0);
  ${F} shRock = smoothstep(${f(ROCK_SLOPE[0])}, ${f(ROCK_SLOPE[1])}, max(shE, 0.0) / max(shIn, 2.0));
  ${F} shReach = ${u('sroShoreA')}.z * ${u('sroShoreB')}.x;
`
}

function vertexMain(lang: Lang): string {
  const w = lang === 'wgsl'
  const F = w ? 'let' : 'float'
  const VAR = w ? 'var' : 'float'
  const V3 = w ? 'vec3f' : 'vec3'
  const u = (n: string) => (w ? `uniforms.${n}` : n)
  return `{
${common(lang)}  // The shore swell (sea side): Green's law until it breaks, then the bore; the front face steepens once broken.
  ${F} shAmp = 0.5 * min(shGreen, ${f(BREAK_GAMMA)} * max(-shE, 0.0)) * shZone * step(0.0, shG);
  ${F} shPsi = 6.2831853 * fract(shW);
  ${F} shPs = shPsi - (0.15 + 0.5 * shBrk) * (1.0 - cos(shPsi));
  sroOcPos = sroOcPos + ${V3}(shN.x * 0.6 * shAmp * sin(shPs), shAmp * cos(shPs), shN.y * 0.6 * shAmp * sin(shPs));
  // The swash sheet: SL + R(t) on gentle sand, the film on rock, sinking under the sand past the reach.
  ${F} shR = ${f(MIN_FILM_M)} + max(shRw - ${f(MIN_FILM_M)}, 0.0) * sroShCycle(shS);
  ${VAR} shSheet = mix(shR, ${f(MIN_FILM_M)}, shRock) - max(shIn - 1.25 * shReach - 2.0, 0.0) * 0.25;
  shSheet = shSheet * shJ * (1.0 - smoothstep(0.0, 8.0, shG));
  sroOcPos.y = max(sroOcPos.y, ${u('sroOcA')}.x + shSheet);
  sroOcSwash = shSheet;
}
`
}

function fragmentDefinitions(lang: Lang): string {
  const decl = lang === 'wgsl'
    ? 'var sroShoreLace: texture_2d<f32>;\nvar sroShoreLaceSampler: sampler;\n'
    : 'uniform sampler2D sroShoreLace;\n'
  return decl + helpers(lang)
}

function fragmentMain(lang: Lang): string {
  const w = lang === 'wgsl'
  const F = w ? 'let' : 'float'
  const VAR = w ? 'var' : 'float'
  const V2 = w ? 'vec2f' : 'vec2'
  const V4 = w ? 'let' : 'vec4'
  const L2 = w ? 'let' : 'vec2'
  const u = (n: string) => (w ? `uniforms.${n}` : n)
  const sel = (a: string, b: string, cond: string) => (w ? `select(${a}, ${b}, ${cond})` : `((${cond}) ? (${b}) : (${a}))`)
  const lace = (uv: string) => (w ? `textureSample(sroShoreLace, sroShoreLaceSampler, ${uv})` : `texture(sroShoreLace, ${uv})`)
  return `{
${common(lang)}  // Breaking: a foam line at each crest once the wave has broken, trailing behind it (and the steepening front face).
  ${F} shAge = fract(shW) * ${u('sroShoreA')}.y;
  ${F} shSea = shBrk * shZone * step(0.0, shG);
  ${F} shFb = shSea * max(0.85 * exp(-shAge / ${f(BREAK_TRAIL_S)}), 0.3 * smoothstep(0.88, 1.0, fract(shW)));
  // The band at the waterline: the last metres of sea (by the shore distance, not the depth: on S1's 1:33 floor the
  // water stays shallower than 0.3 m for 10 m, which read as a white sheet).
  ${F} shFs = (1.0 - smoothstep(${f(EDGE_BAND_M[0])}, ${f(EDGE_BAND_M[1])}, shG)) * step(0.0, shG) * shJ;
  // The swash bore on the sand: foamy on the uprush, decaying on the backwash; and the bead at the film's front.
  ${F} shFilm = sroOcSwash - shE;
  ${F} shOn = smoothstep(-0.01, 0.02, shFilm) * (1.0 - step(3.0, shG)) * shJ;
  ${F} shFront = 1.0 - smoothstep(0.0, ${f(BORE_FRONT_FILM_M)}, shFilm);
  ${F} shFw = ${sel(`0.4 * exp(-(shS - ${f(UPRUSH_SHARE)}) * ${u('sroShoreA')}.y / ${f(BACKWASH_FOAM_S)}) + 0.15 * shFront`, 'max(shFront, 0.1)', `shS < ${f(UPRUSH_SHARE)}`)} * shOn * (1.0 - 0.6 * shRock);
  ${F} shBead = (1.0 - smoothstep(0.0, ${f(BEAD_FILM_M)}, shFilm)) * step(-0.005, shFilm) * (1.0 - step(3.0, shG)) * (1.0 - shRock) * shJ * ${u('sroShoreB')}.w;
  ${F} shAmt = max(max(shFb, shFs * 0.8), shFw) * ${u('sroShoreB')}.y;
  // The lace, carried up the beach with the sheet (two taps at different scales and angles).
  ${L2} shDrift = shN * (max(sroOcSwash, 0.0) * ${u('sroShoreB')}.x * 0.8 * (1.0 - step(3.0, shG)));
  ${L2} shP = sroOcRest - shDrift;
  ${V4} shL1 = ${lace(`shP / ${f(LACE_TAP_M[0])}`)};
  ${V4} shL2 = ${lace(`${V2}(0.8 * shP.x - 0.6 * shP.y, 0.6 * shP.x + 0.8 * shP.y) / ${f(LACE_TAP_M[1])} + ${V2}(0.37, 0.71)`)};
  ${F} shDist = min(shL1.r, shL2.r * 1.15 + 0.05);
  // Mottled: the amount varies by patch (B, two scales) and by bubble cell (A), so a fading foam breaks into patches,
  // lace and loose strands instead of an even net.
  ${F} shMot = 0.5 * shL1.b + 0.5 * shL2.b;
  ${F} shFe = clamp(shAmt, 0.0, 1.2) * (0.35 + 1.3 * shMot) * (0.8 + 0.4 * shL1.a);
  ${VAR} shLace = 1.0 - smoothstep(shFe * 0.65 - 0.05, shFe * 0.65 + 0.02, shDist);
  shLace = max(shLace * smoothstep(0.12, 0.3, shFe), max(shL1.g, shL2.g) * smoothstep(0.2, 0.5, shFe)) * smoothstep(0.03, 0.15, shAmt);
  ${F} shFoam = ${sel('clamp(shAmt, 0.0, 1.0)', 'shLace', `${u('sroShoreB')}.z > 0.5`)};
  sroOcFoam = max(sroOcFoam, max(shFoam, shBead));
}
`
}

/** The vertex stage (after the waves, before the ocean writes the position and its varying). */
export const SHORE_VERTEX: ShoreCode = {
  wgsl: { definitions: helpers('wgsl'), main: vertexMain('wgsl') },
  glsl: { definitions: helpers('glsl'), main: vertexMain('glsl') },
}

/** The fragment stage (after the ocean's taps, before it composes the colour). */
export const SHORE_FRAGMENT: ShoreCode = {
  wgsl: { definitions: fragmentDefinitions('wgsl'), main: fragmentMain('wgsl') },
  glsl: { definitions: fragmentDefinitions('glsl'), main: fragmentMain('glsl') },
}

/** vec4 uniforms the shore reads; the ocean declares them (names start with `sroShore`). */
export const SHORE_UNIFORMS: readonly string[] = ['sroShoreA', 'sroShoreB']

/** 2D samplers the shore's fragment definitions declare (names start with `sroShore`). */
export const SHORE_SAMPLERS: readonly string[] = ['sroShoreLace']
