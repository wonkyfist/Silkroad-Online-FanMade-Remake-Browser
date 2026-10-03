/**
 * Coast chunks (docs/COAST.md §8.6, §8.8; docs/WAVE_PLAN6.md D11): the terrain's wet band along the shore, driven by
 * the shore v1 swash. Created empty by W10-S; owned by CST-S. See shader-chunks.ts for the points and rules.
 *
 * - `COAST_CHUNKS`: the Classic terrain chunk (at `preLight`), in WORLD_SHADER_CHUNKS between the night and the
 *   grass-tint lanes. **Empty on purpose**: Low keeps its terrain strings byte for byte (the Low guard); Low's shore is
 *   the sea's own (COAST §8.8 "Low: the vertex swash and the scrolling foam band").
 * - `COAST_WET_WGSL` / `COAST_WET_GLSL`: the PBR terrain plugin's `sroCoastWet(p: vec3f) -> f32` extern (0 dry … 1
 *   soaked), called under `SRO_COAST_WET` (shore/index.ts sets it with TerrainRenderer.setDefine while the PBR ocean
 *   draws) and fed into the plugin's wetness as `max(weather wetness, coast wetness)`, so porosity, wet roughness and
 *   the SSR mask apply unchanged. It takes the world position (`vPositionW`: no new varying) and samples one texture,
 *   the coast field (the ocean's packed `sroOcFieldMap`, shared by reference as `sroCoastField`; one explicit-level tap,
 *   after a height test so dry ground above the run-up costs no tap). The swash it follows is the sea's: the same cycle
 *   counter, the same along-shore offset and lobes (shore/chunks.ts, shore/swash.ts `coastWetness` is its CPU twin):
 *   - the damp band: below SL + R_max the sand darkens (DAMP_WETNESS, fading out from 0.45 R_max), 0 above R_max;
 *   - the covered sand: 1 under the sheet;
 *   - the receding sheen: where the backwash uncovered the sand in the last seconds, `exp(−t / 2.5 s)`;
 *   only within the swash's reach of the shoreline (`G` in the field), so a hollow inland stays dry. P-LOOK (wave 10
 *   polish): each wave's run-up also carries the sheet's beach cusps (shore/swash.ts CUSP_M, CUSP_SHARE), the heights
 *   the edges test are jittered at three fine scales (WET_EDGE_JITTER_M), and the film edge and the reach line are
 *   feathered (WET_FEATHER_M), so the dark sand ends in a scalloped, ragged line instead of a straight contour.
 * Every final terrain define set stays ≤ 16 WebGL2 units (material-budgets.test.ts, D32/F16): in the sets that are
 * already full (High/Ultra with map arrays and the shelter map) the extern falls back to the static damp band from the
 * height alone (with the same ragged edge) and declares no texture (`FULL_SET`).
 *
 * Uniforms (vec4, bound from TerrainRenderer.sharedUniforms by shore/index.ts): `sroCoastXf` = the field's uv transform
 * (uv = xz × xy + zw), `sroCoastShore` = (cycle counter, period s, maximum run-up m, sea level m).
 */
import type { WorldShaderChunks } from '../shader-chunks.ts'
import {
  BACKWASH_EXP,
  BACKWASH_SHARE,
  CUSP_M,
  CUSP_SHARE,
  DAMP_FADE_START,
  DAMP_WETNESS,
  MIN_FILM_M,
  NOMINAL_SLOPE,
  SHEEN_FADE_S,
  UNDERWATER_WETNESS,
  UPRUSH_EXP,
  UPRUSH_SHARE,
  WET_EDGE_JITTER_M,
  WET_EDGE_SCALES_M,
  WET_FEATHER_M,
} from '../shore/swash.ts'

/** The coast's terrain define (the PBR extern and the Classic chunk test it). */
export const COAST_WET_DEFINE = 'SRO_COAST_WET'
/** The shared values the extern reads (TerrainRenderer.sharedUniforms). */
export const COAST_WET_FIELD = 'sroCoastField'
export const COAST_WET_XF = 'sroCoastXf'
export const COAST_WET_SHORE = 'sroCoastShore'

/** Low's Classic terrain: no chunk (its strings stay HEAD's). */
export const COAST_CHUNKS: WorldShaderChunks = {}

/**
 * The terrain define sets that are already full (High/Ultra with a texture set's map arrays and a weather level with
 * the shelter map: 16 WebGL2 units without the coast, material-budgets.test.ts, COAST F16): there the extern reads no
 * texture and gives the static damp band below the run-up from the height alone (no swash timing, no sheen, no shore
 * distance), so those sets stay at 16.
 */
const FULL_SET = 'defined(SRO_SHELTER) && defined(SRO_T_NORMALS)'

const f = (v: number): string => {
  const r = Math.round(v * 1e6) / 1e6
  return Number.isInteger(r) ? r.toFixed(1) : String(r)
}
const UE = UPRUSH_SHARE + BACKWASH_SHARE

/** The ragged edge's height jitter (m) at the world position `p` (a WGSL / GLSL expression; P-LOOK). */
function jitterExpr(lang: 'wgsl' | 'glsl'): string {
  const V2 = lang === 'wgsl' ? 'vec2f' : 'vec2'
  const [a, b, c] = WET_EDGE_SCALES_M
  return `${f(2 * WET_EDGE_JITTER_M)} * (0.5 * sroCwNoise(p.xz / ${f(a)} + ${V2}(2.9, 8.1)) + 0.3 * sroCwNoise(p.xz / ${f(b)}) + 0.2 * sroCwNoise(p.xz / ${f(c)} + ${V2}(5.3, 1.7)) - 0.5)`
}

/** `fn sroCoastWet(p: vec3f) -> f32`. */
export const COAST_WET_WGSL = `uniform ${COAST_WET_XF}: vec4f;
uniform ${COAST_WET_SHORE}: vec4f;
fn sroCwHash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + vec3f(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
fn sroCwNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let u = fract(p);
  let s = u * u * (vec2f(3.0) - 2.0 * u);
  return mix(mix(sroCwHash(i), sroCwHash(i + vec2f(1.0, 0.0)), s.x), mix(sroCwHash(i + vec2f(0.0, 1.0)), sroCwHash(i + vec2f(1.0, 1.0)), s.x), s.y);
}
#if ${FULL_SET}
fn sroCoastWet(p: vec3f) -> f32 {
  let sh = uniforms.${COAST_WET_SHORE};
  let h = p.y - sh.w;
  if (h >= sh.z + ${f(WET_EDGE_JITTER_M)} || h < -0.3 || sh.z <= 0.0) {
    return 0.0;
  }
  let he = h + ${jitterExpr('wgsl')};
  return ${f(DAMP_WETNESS)} * (1.0 - smoothstep(${f(DAMP_FADE_START)} * sh.z, sh.z, he));
}
#else
var ${COAST_WET_FIELD}: texture_2d<f32>;
var ${COAST_WET_FIELD}Sampler: sampler;
fn sroCoastWet(p: vec3f) -> f32 {
  let sh = uniforms.${COAST_WET_SHORE};
  let h = p.y - sh.w;
  if (h >= sh.z + ${f(WET_EDGE_JITTER_M)} || sh.z <= 0.0) {
    return 0.0;
  }
  let t = textureSampleLevel(${COAST_WET_FIELD}, ${COAST_WET_FIELD}Sampler, p.xz * uniforms.${COAST_WET_XF}.xy + uniforms.${COAST_WET_XF}.zw, 0.0);
  let g = (t.g * 255.0 - 128.0) * 0.5;
  let reach = 1.25 * sh.z * ${f(NOMINAL_SLOPE)} + 2.0;
  let zone = (1.0 - smoothstep(reach, reach + 4.0, max(-g, 0.0))) * (1.0 - clamp(t.a, 0.0, 1.0));
  let cyc = sh.x + 0.6 * (sroCwNoise(p.xz / 90.0) - 0.5) + 0.25 * (sroCwNoise(p.xz / 37.0 + vec2f(17.3, 5.1)) - 0.5);
  let s = fract(cyc);
  let wv = floor(cyc);
  let o = sroCwHash(vec2f(wv, 7.7)) * 97.0;
  let oc = sroCwHash(vec2f(wv, 3.1)) * 89.0;
  let cusp = 1.0 - ${f(CUSP_SHARE)} * sroCwNoise(p.xz / ${f(CUSP_M)} + vec2f(oc, -oc * 0.73));
  let rw = sh.z * (0.6 + 0.4 * sroCwNoise(p.xz / 14.0 + vec2f(o, o * 0.61))) * cusp;
  let he = h + ${jitterExpr('wgsl')};
  var c = 0.0;
  if (s < ${f(UPRUSH_SHARE)}) {
    c = 1.0 - pow(max(1.0 - s / ${f(UPRUSH_SHARE)}, 0.0), ${f(UPRUSH_EXP)});
  } else if (s < ${f(UE)}) {
    c = 1.0 - pow(max((s - ${f(UPRUSH_SHARE)}) / ${f(BACKWASH_SHARE)}, 0.0), ${f(BACKWASH_EXP)});
  }
  let now = ${f(MIN_FILM_M)} + max(rw - ${f(MIN_FILM_M)}, 0.0) * c;
  let damp = ${f(DAMP_WETNESS)} * (1.0 - smoothstep(${f(DAMP_FADE_START)} * sh.z, sh.z, he));
  let q = clamp((he - ${f(MIN_FILM_M)}) / max(rw - ${f(MIN_FILM_M)}, 0.0001), 0.0, 1.0);
  let su = ${f(UPRUSH_SHARE)} + ${f(BACKWASH_SHARE)} * pow(max(1.0 - q, 0.0), ${f(1 / BACKWASH_EXP)});
  let since = (select(s, s + 1.0, s < ${f(UPRUSH_SHARE)}) - su) * sh.y;
  let sheen = select(0.0, exp(-since / ${f(SHEEN_FADE_S)}) * (1.0 - smoothstep(rw - ${f(WET_FEATHER_M)}, rw, he)), since >= 0.0);
  let cover = smoothstep(0.0, ${f(WET_FEATHER_M)}, now - he);
  return mix(max(damp, sheen), select(1.0, ${f(UNDERWATER_WETNESS)}, he < 0.0), cover) * zone;
}
#endif
`

/** `float sroCoastWet(vec3 p)`. */
export const COAST_WET_GLSL = `uniform vec4 ${COAST_WET_XF};
uniform vec4 ${COAST_WET_SHORE};
float sroCwHash(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + vec3(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
float sroCwNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  vec2 s = u * u * (vec2(3.0) - 2.0 * u);
  return mix(mix(sroCwHash(i), sroCwHash(i + vec2(1.0, 0.0)), s.x), mix(sroCwHash(i + vec2(0.0, 1.0)), sroCwHash(i + vec2(1.0, 1.0)), s.x), s.y);
}
#if ${FULL_SET}
float sroCoastWet(vec3 p) {
  vec4 sh = ${COAST_WET_SHORE};
  float h = p.y - sh.w;
  if (h >= sh.z + ${f(WET_EDGE_JITTER_M)} || h < -0.3 || sh.z <= 0.0) return 0.0;
  float he = h + ${jitterExpr('glsl')};
  return ${f(DAMP_WETNESS)} * (1.0 - smoothstep(${f(DAMP_FADE_START)} * sh.z, sh.z, he));
}
#else
uniform sampler2D ${COAST_WET_FIELD};
float sroCoastWet(vec3 p) {
  vec4 sh = ${COAST_WET_SHORE};
  float h = p.y - sh.w;
  if (h >= sh.z + ${f(WET_EDGE_JITTER_M)} || sh.z <= 0.0) return 0.0;
  vec4 t = textureLod(${COAST_WET_FIELD}, p.xz * ${COAST_WET_XF}.xy + ${COAST_WET_XF}.zw, 0.0);
  float g = (t.g * 255.0 - 128.0) * 0.5;
  float reach = 1.25 * sh.z * ${f(NOMINAL_SLOPE)} + 2.0;
  float zone = (1.0 - smoothstep(reach, reach + 4.0, max(-g, 0.0))) * (1.0 - clamp(t.a, 0.0, 1.0));
  float cyc = sh.x + 0.6 * (sroCwNoise(p.xz / 90.0) - 0.5) + 0.25 * (sroCwNoise(p.xz / 37.0 + vec2(17.3, 5.1)) - 0.5);
  float s = fract(cyc);
  float wv = floor(cyc);
  float o = sroCwHash(vec2(wv, 7.7)) * 97.0;
  float oc = sroCwHash(vec2(wv, 3.1)) * 89.0;
  float cusp = 1.0 - ${f(CUSP_SHARE)} * sroCwNoise(p.xz / ${f(CUSP_M)} + vec2(oc, -oc * 0.73));
  float rw = sh.z * (0.6 + 0.4 * sroCwNoise(p.xz / 14.0 + vec2(o, o * 0.61))) * cusp;
  float he = h + ${jitterExpr('glsl')};
  float c = 0.0;
  if (s < ${f(UPRUSH_SHARE)}) c = 1.0 - pow(max(1.0 - s / ${f(UPRUSH_SHARE)}, 0.0), ${f(UPRUSH_EXP)});
  else if (s < ${f(UE)}) c = 1.0 - pow(max((s - ${f(UPRUSH_SHARE)}) / ${f(BACKWASH_SHARE)}, 0.0), ${f(BACKWASH_EXP)});
  float now = ${f(MIN_FILM_M)} + max(rw - ${f(MIN_FILM_M)}, 0.0) * c;
  float damp = ${f(DAMP_WETNESS)} * (1.0 - smoothstep(${f(DAMP_FADE_START)} * sh.z, sh.z, he));
  float q = clamp((he - ${f(MIN_FILM_M)}) / max(rw - ${f(MIN_FILM_M)}, 0.0001), 0.0, 1.0);
  float su = ${f(UPRUSH_SHARE)} + ${f(BACKWASH_SHARE)} * pow(max(1.0 - q, 0.0), ${f(1 / BACKWASH_EXP)});
  float since = ((s < ${f(UPRUSH_SHARE)} ? s + 1.0 : s) - su) * sh.y;
  float sheen = since >= 0.0 ? exp(-since / ${f(SHEEN_FADE_S)}) * (1.0 - smoothstep(rw - ${f(WET_FEATHER_M)}, rw, he)) : 0.0;
  float cover = smoothstep(0.0, ${f(WET_FEATHER_M)}, now - he);
  return mix(max(damp, sheen), he < 0.0 ? ${f(UNDERWATER_WETNESS)} : 1.0, cover) * zone;
}
#endif
`
