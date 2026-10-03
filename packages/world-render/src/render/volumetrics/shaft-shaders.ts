/**
 * The light shafts' three post-process shaders (render/volumetrics/shafts.ts), WGSL for WebGPU and GLSL for WebGL2:
 *
 * - **march** (reduced resolution): reconstructs the pixel's world position from the scene's hardware depth.
 *   - `SRO_SHAFTS_MARCH`: walks the view ray from the eye to the surface (at most the shadow distance) with quadratically
 *     spaced, jittered steps; each step reads the sun's cascaded shadow map once (a hardware 2 × 2 compare) and adds
 *     σ·T·Δt. Out: the lit in-scatter `S` (x), the in-scatter if everything were lit `A` (y).
 *   - `SRO_SHAFTS_RADIAL`: the light source of the screen-space beams: the open sky (depth at the clear value, four
 *     full-resolution taps per texel, so leaves do not alias) near the sun's screen position (w).
 *   - Always: the pixel's view depth (z), for the resolve's reprojection and the composite's depth-aware upsample.
 * - **resolve** (reduced resolution): a 3 × 3 depth-aware blur of the march, then a temporal blend with last frame's
 *   result, reprojected through the previous view-projection, clamped to the blurred neighbourhood and dropped where the
 *   depth disagrees (disocclusion) or the pixel came from off screen. `SRO_SHAFTS_MARCH`: the **baseline**: the march
 *   keeps only the in-scatter above `open` × the region's lit share (ΣS / ΣA over two rings of taps, ±32 px of the
 *   render at any level, any depth), so lit air that is the same everywhere (an open field, the sunlit air in front of
 *   a shaded wall) adds nothing and a beam keeps what it has above the air beside it; the **dapple boost** lifts places
 *   where lit and shadowed air mix (a forest, an alley, a gate). `SRO_SHAFTS_RADIAL`: the radial walk from the texel
 *   towards the sun over the march's sky mask (bilinear taps, a decay per tap), shaped by the open share of the walk
 *   (the mask against what an all-open sky would give: open sky round the sun is no beam), faded for near pixels
 *   (little air in front of them), and, beside the march (hybrid), times the pixel's own lit share, so the tree beams
 *   only light air the buildings leave in the sun; its history is not clamped (no neighbourhood to clamp to) and
 *   blends at half the rate. Out: shaped `S` (x), the pixel's lit share (y, for the overlay), view depth (z), `R` (w).
 * - **composite** (full resolution, in the HDR chain before the default pipeline): a joint-bilateral upsample of the
 *   resolved shafts (four low-resolution texels weighted by bilinear × depth similarity, the nearest-depth texel when
 *   none matches), the phase function towards the light (capped) on the march, plus the radial part, added to the scene
 *   in scene-linear light.
 *
 * Every texture read is `textureLoad` / `textureSampleLevel` / `textureSampleCompareLevel`: no implicit derivatives,
 * so the loops and branches keep to the WGSL uniformity rules. The only varying is Babylon's post-process `vUV`. Loop
 * counts are clamped in the shader (a garbage uniform never hangs the GPU). `IS_NDC_HALF_ZRANGE` (WebGPU's 0..1 clip
 * depth) is one of Babylon's global defines. Lane GODRAYS (wave 12).
 */

/** Babylon shader-store names (`<name>FragmentShader`, both languages). */
export const SHAFT_MARCH_SHADER = 'sroShaftsMarch'
export const SHAFT_RESOLVE_SHADER = 'sroShaftsResolve'
export const SHAFT_COMPOSITE_SHADER = 'sroShaftsComposite'

/** The shadow-map march and the screen-space radial walk (march and composite; either or both). */
export const SHAFT_MARCH_DEFINE = 'SRO_SHAFTS_MARCH'
export const SHAFT_RADIAL_DEFINE = 'SRO_SHAFTS_RADIAL'

/** Uniforms per pass (Babylon adds `scale` for its post-process vertex shader). */
export const SHAFT_MARCH_UNIFORMS: readonly string[] = [
  'sroInvViewProj', 'sroEye', 'sroFwd', 'sroCam', 'sroSplits', 'sroMarch', 'sroSun', 'sroRadial',
  'sroLightMat0', 'sroLightMat1', 'sroLightMat2', 'sroLightMat3',
]
export const SHAFT_RESOLVE_UNIFORMS: readonly string[] = ['sroInvViewProj', 'sroPrevViewProj', 'sroEye', 'sroFwd', 'sroResolve', 'sroSun', 'sroRadial', 'sroShape']
export const SHAFT_COMPOSITE_UNIFORMS: readonly string[] = ['sroInvViewProj', 'sroEye', 'sroFwd', 'sroCam', 'sroSunDir', 'sroShaftColor', 'sroPhase']

/** Samplers per pass besides Babylon's `textureSampler` (the pass's input). */
export const SHAFT_MARCH_SAMPLERS: readonly string[] = ['sroDepth', 'sroShadowMap']
export const SHAFT_RESOLVE_SAMPLERS: readonly string[] = ['sroHistory']
export const SHAFT_COMPOSITE_SAMPLERS: readonly string[] = ['sroScene', 'sroDepth']

/** The cascades the march reads at most (Ultra's CSM). */
export const SHAFT_MAX_CASCADES = 4
/** The most steps a ray or a radial walk takes, whatever the uniform says. */
export const SHAFT_MAX_STEPS = 64
/**
 * The near-field emphasis: the march weighs its in-scatter by exp(−REACH · t / the ray's longest reach), so the air
 * within the first third of it carries the shafts and the far air (the height fog's job) only a little.
 */
export const SHAFT_REACH = 3

export interface ShaftShaderSource {
  name: string
  wgsl: string
  glsl: string
  uniforms: readonly string[]
  samplers: readonly string[]
}

const M = SHAFT_MARCH_DEFINE
const R = SHAFT_RADIAL_DEFINE
const N = SHAFT_MAX_STEPS
const C = SHAFT_MAX_CASCADES
const REACH = SHAFT_REACH.toFixed(1)

// ---- march ----------------------------------------------------------------------------------------------------------

const MARCH_WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
var sroDepth: texture_2d<f32>;
#ifdef ${M}
var sroShadowMapSampler: sampler_comparison;
var sroShadowMap: texture_depth_2d_array;
#endif
uniform sroInvViewProj: mat4x4f;
uniform sroEye: vec4f;
uniform sroFwd: vec4f;
uniform sroCam: vec4f;
uniform sroSplits: vec4f;
uniform sroMarch: vec4f;
uniform sroSun: vec4f;
uniform sroRadial: vec4f;
uniform sroLightMat0: mat4x4f;
uniform sroLightMat1: mat4x4f;
uniform sroLightMat2: mat4x4f;
uniform sroLightMat3: mat4x4f;

fn sroDepthAt(uv: vec2f) -> f32 {
  let size = vec2f(textureDimensions(sroDepth, 0));
  let p = vec2i(clamp(floor(uv * size), vec2f(0.0), size - vec2f(1.0)));
  return textureLoad(sroDepth, p, 0).r;
}

fn sroWorldAt(uv: vec2f, d: f32) -> vec3f {
  var z = d;
#ifndef IS_NDC_HALF_ZRANGE
  z = d * 2.0 - 1.0;
#endif
  let p = uniforms.sroInvViewProj * vec4f(uv * 2.0 - 1.0, z, 1.0);
  return p.xyz / p.w;
}

fn sroNoise(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

#define CUSTOM_FRAGMENT_DEFINITIONS

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;
  let d = sroDepthAt(uv);
  let sky = d >= 1.0;
  let eye = uniforms.sroEye.xyz;
  let toP = sroWorldAt(uv, select(d, 1.0, sky)) - eye;
  let dist = length(toP);
  let dir = toP / max(dist, 1e-4);
  let cosF = max(dot(dir, uniforms.sroFwd.xyz), 0.05);
  let viewZ = select(dist * cosF, uniforms.sroCam.y, sky);
  if (uniforms.sroCam.w < 0.5) {
    fragmentOutputs.color = vec4f(0.0, 0.0, viewZ, 0.0);
    return fragmentOutputs;
  }
  let jitter = fract(sroNoise(floor(uv * uniforms.sroMarch.zw)) + uniforms.sroCam.z);
  var S = 0.0;
  var A = 0.0;
  var Rad = 0.0;
#ifdef ${M}
  let steps = clamp(i32(uniforms.sroFwd.w), 1, ${N});
  let n = f32(steps);
  let sigma = uniforms.sroMarch.x;
  let cascades = clamp(i32(uniforms.sroMarch.y), 1, ${C});
  let lastSplit = uniforms.sroSplits[cascades - 1];
  let len = min(min(select(dist, 1e6, sky), uniforms.sroEye.w), lastSplit / cosF);
  var lo: array<vec4f, ${C}>;
  var ld: array<vec4f, ${C}>;
  lo[0] = uniforms.sroLightMat0 * vec4f(eye, 1.0);
  ld[0] = uniforms.sroLightMat0 * vec4f(dir, 0.0);
  lo[1] = uniforms.sroLightMat1 * vec4f(eye, 1.0);
  ld[1] = uniforms.sroLightMat1 * vec4f(dir, 0.0);
  lo[2] = uniforms.sroLightMat2 * vec4f(eye, 1.0);
  ld[2] = uniforms.sroLightMat2 * vec4f(dir, 0.0);
  lo[3] = uniforms.sroLightMat3 * vec4f(eye, 1.0);
  ld[3] = uniforms.sroLightMat3 * vec4f(dir, 0.0);
  for (var i = 0; i < steps; i++) {
    let u = (f32(i) + jitter) / n;
    let t = len * u * u;
    let dt = len * 2.0 * u / n;
    let vz = t * cosF;
    var c = 0;
    if (vz > uniforms.sroSplits.x) { c = 1; }
    if (vz > uniforms.sroSplits.y) { c = 2; }
    if (vz > uniforms.sroSplits.z) { c = 3; }
    c = min(c, cascades - 1);
    let lp = lo[c] + ld[c] * t;
    var uvz = vec3f(lp.xy * 0.5 + vec2f(0.5), lp.z);
#ifndef IS_NDC_HALF_ZRANGE
    uvz.z = lp.z * 0.5 + 0.5;
#endif
    var lit = 1.0;
    if (all(uvz.xy > vec2f(0.0)) && all(uvz.xy < vec2f(1.0))) {
      lit = textureSampleCompareLevel(sroShadowMap, sroShadowMapSampler, uvz.xy, c, clamp(uvz.z, 0.0, 0.99999994));
    }
    let w = sigma * exp(-(sigma + ${REACH} / uniforms.sroEye.w) * t) * dt;
    S += w * lit;
    A += w;
  }
#endif
#ifdef ${R}
  let px = 0.25 / uniforms.sroMarch.zw;
  var open = 0.0;
  open += select(0.0, 0.25, sroDepthAt(uv + vec2f(-px.x, -px.y)) >= 1.0);
  open += select(0.0, 0.25, sroDepthAt(uv + vec2f(px.x, -px.y)) >= 1.0);
  open += select(0.0, 0.25, sroDepthAt(uv + vec2f(-px.x, px.y)) >= 1.0);
  open += select(0.0, 0.25, sroDepthAt(uv + vec2f(px.x, px.y)) >= 1.0);
  let o = (uv - uniforms.sroSun.xy) * vec2f(uniforms.sroRadial.y, 1.0);
  Rad = open * exp(-dot(o, o) * uniforms.sroRadial.x);
#endif
  fragmentOutputs.color = vec4f(S, A, viewZ, Rad);
}
`

const MARCH_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform highp sampler2D sroDepth;
#ifdef ${M}
uniform highp sampler2DArrayShadow sroShadowMap;
#endif
uniform mat4 sroInvViewProj;
uniform vec4 sroEye;
uniform vec4 sroFwd;
uniform vec4 sroCam;
uniform vec4 sroSplits;
uniform vec4 sroMarch;
uniform vec4 sroSun;
uniform vec4 sroRadial;
uniform mat4 sroLightMat0;
uniform mat4 sroLightMat1;
uniform mat4 sroLightMat2;
uniform mat4 sroLightMat3;

float sroDepthAt(vec2 uv) {
  vec2 size = vec2(textureSize(sroDepth, 0));
  ivec2 p = ivec2(clamp(floor(uv * size), vec2(0.0), size - vec2(1.0)));
  return texelFetch(sroDepth, p, 0).r;
}

vec3 sroWorldAt(vec2 uv, float d) {
  float z = d;
#ifndef IS_NDC_HALF_ZRANGE
  z = d * 2.0 - 1.0;
#endif
  vec4 p = sroInvViewProj * vec4(uv * 2.0 - 1.0, z, 1.0);
  return p.xyz / p.w;
}

float sroNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

#define CUSTOM_FRAGMENT_DEFINITIONS

void main(void) {
  vec2 uv = vUV;
  float d = sroDepthAt(uv);
  bool sky = d >= 1.0;
  vec3 eye = sroEye.xyz;
  vec3 toP = sroWorldAt(uv, sky ? 1.0 : d) - eye;
  float dist = length(toP);
  vec3 dir = toP / max(dist, 1e-4);
  float cosF = max(dot(dir, sroFwd.xyz), 0.05);
  float viewZ = sky ? sroCam.y : dist * cosF;
  if (sroCam.w < 0.5) {
    gl_FragColor = vec4(0.0, 0.0, viewZ, 0.0);
    return;
  }
  float jitter = fract(sroNoise(floor(uv * sroMarch.zw)) + sroCam.z);
  float S = 0.0;
  float A = 0.0;
  float Rad = 0.0;
#ifdef ${M}
  int steps = clamp(int(sroFwd.w), 1, ${N});
  float n = float(steps);
  float sigma = sroMarch.x;
  int cascades = clamp(int(sroMarch.y), 1, ${C});
  float lastSplit = sroSplits[cascades - 1];
  float len = min(min(sky ? 1e6 : dist, sroEye.w), lastSplit / cosF);
  vec4 lo[${C}];
  vec4 ld[${C}];
  lo[0] = sroLightMat0 * vec4(eye, 1.0);
  ld[0] = sroLightMat0 * vec4(dir, 0.0);
  lo[1] = sroLightMat1 * vec4(eye, 1.0);
  ld[1] = sroLightMat1 * vec4(dir, 0.0);
  lo[2] = sroLightMat2 * vec4(eye, 1.0);
  ld[2] = sroLightMat2 * vec4(dir, 0.0);
  lo[3] = sroLightMat3 * vec4(eye, 1.0);
  ld[3] = sroLightMat3 * vec4(dir, 0.0);
  for (int i = 0; i < steps; i++) {
    float u = (float(i) + jitter) / n;
    float t = len * u * u;
    float dt = len * 2.0 * u / n;
    float vz = t * cosF;
    int c = 0;
    if (vz > sroSplits.x) c = 1;
    if (vz > sroSplits.y) c = 2;
    if (vz > sroSplits.z) c = 3;
    c = min(c, cascades - 1);
    vec4 lp = lo[c] + ld[c] * t;
    vec3 uvz = vec3(lp.xy * 0.5 + vec2(0.5), lp.z);
#ifndef IS_NDC_HALF_ZRANGE
    uvz.z = lp.z * 0.5 + 0.5;
#endif
    float lit = 1.0;
    if (all(greaterThan(uvz.xy, vec2(0.0))) && all(lessThan(uvz.xy, vec2(1.0)))) {
      lit = texture(sroShadowMap, vec4(uvz.xy, float(c), clamp(uvz.z, 0.0, 0.99999994)));
    }
    float w = sigma * exp(-(sigma + ${REACH} / sroEye.w) * t) * dt;
    S += w * lit;
    A += w;
  }
#endif
#ifdef ${R}
  vec2 px = 0.25 / sroMarch.zw;
  float open = 0.0;
  open += sroDepthAt(uv + vec2(-px.x, -px.y)) >= 1.0 ? 0.25 : 0.0;
  open += sroDepthAt(uv + vec2(px.x, -px.y)) >= 1.0 ? 0.25 : 0.0;
  open += sroDepthAt(uv + vec2(-px.x, px.y)) >= 1.0 ? 0.25 : 0.0;
  open += sroDepthAt(uv + vec2(px.x, px.y)) >= 1.0 ? 0.25 : 0.0;
  vec2 o = (uv - sroSun.xy) * vec2(sroRadial.y, 1.0);
  Rad = open * exp(-dot(o, o) * sroRadial.x);
#endif
  gl_FragColor = vec4(S, A, viewZ, Rad);
}
`

// ---- resolve --------------------------------------------------------------------------------------------------------

const RESOLVE_WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
var sroHistorySampler: sampler;
var sroHistory: texture_2d<f32>;
uniform sroInvViewProj: mat4x4f;
uniform sroPrevViewProj: mat4x4f;
uniform sroEye: vec4f;
uniform sroFwd: vec4f;
uniform sroResolve: vec4f;
uniform sroSun: vec4f;
uniform sroRadial: vec4f;
uniform sroShape: vec4f;

fn sroRay(uv: vec2f) -> vec3f {
  let p = uniforms.sroInvViewProj * vec4f(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(p.xyz / p.w - uniforms.sroEye.xyz);
}

fn sroNoise(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

fn sroShapeOf(lit: f32) -> f32 {
  let l = clamp(lit, 0.0, 1.0);
  return (1.0 - uniforms.sroShape.x * pow(l, uniforms.sroShape.z)) * (1.0 + uniforms.sroShape.y * 4.0 * l * (1.0 - l));
}

fn sroTapSA(p: vec2i, size: vec2i) -> vec2f {
  return textureLoad(textureSampler, clamp(p, vec2i(0), size - vec2i(1)), 0).xy;
}

#define CUSTOM_FRAGMENT_DEFINITIONS

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;
  let size = vec2i(textureDimensions(textureSampler, 0));
  let pc = clamp(vec2i(floor(uv * vec2f(size))), vec2i(0), size - vec2i(1));
  let c = textureLoad(textureSampler, pc, 0);
  let tol = 0.08 * c.z + 0.5;
  var sum = vec3f(0.0);
  var wsum = 0.0;
  var mn = c.xyw;
  var mx = c.xyw;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = textureLoad(textureSampler, clamp(pc + vec2i(dx, dy), vec2i(0), size - vec2i(1)), 0);
      let w = max(0.0, 1.0 - abs(q.z - c.z) / tol) * select(1.0, 2.0, dx == 0 && dy == 0);
      sum += q.xyw * w;
      wsum += w;
      if (w > 0.0) {
        mn = min(mn, q.xyw);
        mx = max(mx, q.xyw);
      }
    }
  }
  var cur = sum / max(wsum, 1e-4);
  let litPix = select(1.0, clamp(cur.x / cur.y, 0.0, 1.0), cur.y > 1e-6);
#ifdef ${M}
  let rr = max(1, i32(uniforms.sroShape.w));
  let rd = max(1, (rr * 7) / 10);
  var reg = cur.xy * 2.0;
  for (var k = 1; k <= 2; k++) {
    let a = rr * k;
    let b = rd * k;
    reg += sroTapSA(pc + vec2i(a, 0), size);
    reg += sroTapSA(pc + vec2i(-a, 0), size);
    reg += sroTapSA(pc + vec2i(0, a), size);
    reg += sroTapSA(pc + vec2i(0, -a), size);
    reg += sroTapSA(pc + vec2i(b, b), size);
    reg += sroTapSA(pc + vec2i(-b, b), size);
    reg += sroTapSA(pc + vec2i(b, -b), size);
    reg += sroTapSA(pc + vec2i(-b, -b), size);
  }
  let litReg = select(1.0, clamp(reg.x / reg.y, 0.0, 1.0), reg.y > 1e-6);
  let base = uniforms.sroShape.x * cur.y * litReg;
  let boost = 1.0 + uniforms.sroShape.y * 4.0 * litReg * (1.0 - litReg);
  cur.x = max(cur.x - base, 0.0) * boost;
  mn.x = max(mn.x - base, 0.0) * boost;
  mx.x = max(mx.x - base, 0.0) * boost;
#endif
#ifdef ${R}
  let rsteps = clamp(i32(uniforms.sroRadial.w), 1, ${N});
  let rn = f32(rsteps);
  let delta = (uniforms.sroSun.xy - uv) / rn;
  var p = uv + delta * fract(sroNoise(vec2f(pc)) + uniforms.sroResolve.w);
  var decay = 1.0;
  var rad = 0.0;
  var full = 0.0;
  for (var i = 0; i < rsteps; i++) {
    let pp = clamp(p, vec2f(0.0), vec2f(1.0));
    let o = (pp - uniforms.sroSun.xy) * vec2f(uniforms.sroRadial.y, 1.0);
    rad += decay * textureSampleLevel(textureSampler, textureSamplerSampler, pp, 0.0).w;
    full += decay * exp(-dot(o, o) * uniforms.sroRadial.x);
    decay *= uniforms.sroSun.w;
    p += delta;
  }
  var r = rad / rn * uniforms.sroSun.z * (1.0 - exp(-c.z * uniforms.sroRadial.z));
  r *= sroShapeOf(select(1.0, rad / full, full > 1e-6));
#ifdef ${M}
  r *= litPix;
#endif
  cur.z = r;
  mn.z = 0.0;
  mx.z = 60000.0;
#endif
  let dir = sroRay(uv);
  let pos = uniforms.sroEye.xyz + dir * (c.z / max(dot(dir, uniforms.sroFwd.xyz), 0.05));
  let prev = uniforms.sroPrevViewProj * vec4f(pos, 1.0);
  let puv = prev.xy / max(prev.w, 1e-4) * 0.5 + vec2f(0.5);
  let h = textureSampleLevel(sroHistory, sroHistorySampler, puv, 0.0);
  var alpha = uniforms.sroResolve.x;
  let off = prev.w <= 0.0 || any(puv < vec2f(0.0)) || any(puv > vec2f(1.0));
  let moved = abs(h.z - c.z) > uniforms.sroResolve.z * c.z + 1.0;
  if (uniforms.sroResolve.y > 0.5 || off || moved) {
    alpha = 1.0;
  }
  let pad = (mx - mn) * 0.25;
  let hc = clamp(h.xyw, mn - pad, mx + pad);
  var o = mix(hc, cur, alpha);
#ifdef ${R}
  o.z = mix(hc.z, cur.z, select(alpha * 0.5, 1.0, alpha >= 1.0));
#endif
  fragmentOutputs.color = vec4f(o.x, litPix, c.z, o.z);
}
`

const RESOLVE_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform highp sampler2D textureSampler;
uniform highp sampler2D sroHistory;
uniform mat4 sroInvViewProj;
uniform mat4 sroPrevViewProj;
uniform vec4 sroEye;
uniform vec4 sroFwd;
uniform vec4 sroResolve;
uniform vec4 sroSun;
uniform vec4 sroRadial;
uniform vec4 sroShape;

vec3 sroRay(vec2 uv) {
  vec4 p = sroInvViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(p.xyz / p.w - sroEye.xyz);
}

float sroNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float sroShapeOf(float lit) {
  float l = clamp(lit, 0.0, 1.0);
  return (1.0 - sroShape.x * pow(l, sroShape.z)) * (1.0 + sroShape.y * 4.0 * l * (1.0 - l));
}

vec2 sroTapSA(ivec2 p, ivec2 size) {
  return texelFetch(textureSampler, clamp(p, ivec2(0), size - ivec2(1)), 0).xy;
}

#define CUSTOM_FRAGMENT_DEFINITIONS

void main(void) {
  vec2 uv = vUV;
  ivec2 size = textureSize(textureSampler, 0);
  ivec2 pc = clamp(ivec2(floor(uv * vec2(size))), ivec2(0), size - ivec2(1));
  vec4 c = texelFetch(textureSampler, pc, 0);
  float tol = 0.08 * c.z + 0.5;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  vec3 mn = c.xyw;
  vec3 mx = c.xyw;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec4 q = texelFetch(textureSampler, clamp(pc + ivec2(dx, dy), ivec2(0), size - ivec2(1)), 0);
      float w = max(0.0, 1.0 - abs(q.z - c.z) / tol) * ((dx == 0 && dy == 0) ? 2.0 : 1.0);
      sum += q.xyw * w;
      wsum += w;
      if (w > 0.0) {
        mn = min(mn, q.xyw);
        mx = max(mx, q.xyw);
      }
    }
  }
  vec3 cur = sum / max(wsum, 1e-4);
  float litPix = cur.y > 1e-6 ? clamp(cur.x / cur.y, 0.0, 1.0) : 1.0;
#ifdef ${M}
  int rr = max(1, int(sroShape.w));
  int rd = max(1, (rr * 7) / 10);
  vec2 reg = cur.xy * 2.0;
  for (int k = 1; k <= 2; k++) {
    int a = rr * k;
    int b = rd * k;
    reg += sroTapSA(pc + ivec2(a, 0), size);
    reg += sroTapSA(pc + ivec2(-a, 0), size);
    reg += sroTapSA(pc + ivec2(0, a), size);
    reg += sroTapSA(pc + ivec2(0, -a), size);
    reg += sroTapSA(pc + ivec2(b, b), size);
    reg += sroTapSA(pc + ivec2(-b, b), size);
    reg += sroTapSA(pc + ivec2(b, -b), size);
    reg += sroTapSA(pc + ivec2(-b, -b), size);
  }
  float litReg = reg.y > 1e-6 ? clamp(reg.x / reg.y, 0.0, 1.0) : 1.0;
  float base = sroShape.x * cur.y * litReg;
  float boost = 1.0 + sroShape.y * 4.0 * litReg * (1.0 - litReg);
  cur.x = max(cur.x - base, 0.0) * boost;
  mn.x = max(mn.x - base, 0.0) * boost;
  mx.x = max(mx.x - base, 0.0) * boost;
#endif
#ifdef ${R}
  int rsteps = clamp(int(sroRadial.w), 1, ${N});
  float rn = float(rsteps);
  vec2 delta = (sroSun.xy - uv) / rn;
  vec2 p = uv + delta * fract(sroNoise(vec2(pc)) + sroResolve.w);
  float decay = 1.0;
  float rad = 0.0;
  float full = 0.0;
  for (int i = 0; i < rsteps; i++) {
    vec2 pp = clamp(p, vec2(0.0), vec2(1.0));
    vec2 o = (pp - sroSun.xy) * vec2(sroRadial.y, 1.0);
    rad += decay * textureLod(textureSampler, pp, 0.0).w;
    full += decay * exp(-dot(o, o) * sroRadial.x);
    decay *= sroSun.w;
    p += delta;
  }
  float r = rad / rn * sroSun.z * (1.0 - exp(-c.z * sroRadial.z));
  r *= sroShapeOf(full > 1e-6 ? rad / full : 1.0);
#ifdef ${M}
  r *= litPix;
#endif
  cur.z = r;
  mn.z = 0.0;
  mx.z = 60000.0;
#endif
  vec3 dir = sroRay(uv);
  vec3 pos = sroEye.xyz + dir * (c.z / max(dot(dir, sroFwd.xyz), 0.05));
  vec4 prev = sroPrevViewProj * vec4(pos, 1.0);
  vec2 puv = prev.xy / max(prev.w, 1e-4) * 0.5 + vec2(0.5);
  vec4 h = textureLod(sroHistory, puv, 0.0);
  float alpha = sroResolve.x;
  bool off = prev.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)));
  bool moved = abs(h.z - c.z) > sroResolve.z * c.z + 1.0;
  if (sroResolve.y > 0.5 || off || moved) alpha = 1.0;
  vec3 pad = (mx - mn) * 0.25;
  vec3 hc = clamp(h.xyw, mn - pad, mx + pad);
  vec3 o = mix(hc, cur, alpha);
#ifdef ${R}
  o.z = mix(hc.z, cur.z, alpha >= 1.0 ? 1.0 : alpha * 0.5);
#endif
  gl_FragColor = vec4(o.x, litPix, c.z, o.z);
}
`

// ---- composite ------------------------------------------------------------------------------------------------------

const COMPOSITE_WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
var sroSceneSampler: sampler;
var sroScene: texture_2d<f32>;
var sroDepth: texture_2d<f32>;
uniform sroInvViewProj: mat4x4f;
uniform sroEye: vec4f;
uniform sroFwd: vec4f;
uniform sroCam: vec4f;
uniform sroSunDir: vec4f;
uniform sroShaftColor: vec4f;
uniform sroPhase: vec4f;

fn sroTap(tc: vec2f, lsize: vec2f) -> vec4f {
  return textureLoad(textureSampler, vec2i(clamp(tc, vec2f(0.0), lsize - vec2f(1.0))), 0);
}

#define CUSTOM_FRAGMENT_DEFINITIONS

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;
  let base0 = textureSampleLevel(sroScene, sroSceneSampler, uv, 0.0);
  fragmentOutputs.color = base0;
  if (uniforms.sroCam.w < 0.5) {
    return fragmentOutputs;
  }
  let dsize = vec2f(textureDimensions(sroDepth, 0));
  let d = textureLoad(sroDepth, vec2i(clamp(floor(uv * dsize), vec2f(0.0), dsize - vec2f(1.0))), 0).r;
  var zc = d;
#ifndef IS_NDC_HALF_ZRANGE
  zc = d * 2.0 - 1.0;
#endif
  let wp = uniforms.sroInvViewProj * vec4f(uv * 2.0 - 1.0, select(zc, 1.0, d >= 1.0), 1.0);
  let toP = wp.xyz / wp.w - uniforms.sroEye.xyz;
  let dir = normalize(toP);
  let z = select(dot(toP, uniforms.sroFwd.xyz), uniforms.sroCam.y, d >= 1.0);
  let lsize = vec2f(textureDimensions(textureSampler, 0));
  let lp = uv * lsize - vec2f(0.5);
  let base = floor(lp);
  let fr = lp - base;
  let t00 = sroTap(base, lsize);
  let t10 = sroTap(base + vec2f(1.0, 0.0), lsize);
  let t01 = sroTap(base + vec2f(0.0, 1.0), lsize);
  let t11 = sroTap(base + vec2f(1.0, 1.0), lsize);
  let iz = 12.0 / max(z, 1.0);
  let w00 = (1.0 - fr.x) * (1.0 - fr.y) * exp(-abs(t00.z - z) * iz);
  let w10 = fr.x * (1.0 - fr.y) * exp(-abs(t10.z - z) * iz);
  let w01 = (1.0 - fr.x) * fr.y * exp(-abs(t01.z - z) * iz);
  let w11 = fr.x * fr.y * exp(-abs(t11.z - z) * iz);
  let wsum = w00 + w10 + w01 + w11;
  var sa = (t00.xw * w00 + t10.xw * w10 + t01.xw * w01 + t11.xw * w11) / max(wsum, 1e-6);
  if (wsum < 1e-3) {
    var best = t00;
    if (abs(t10.z - z) < abs(best.z - z)) { best = t10; }
    if (abs(t01.z - z) < abs(best.z - z)) { best = t01; }
    if (abs(t11.z - z) < abs(best.z - z)) { best = t11; }
    sa = best.xw;
  }
  let g = uniforms.sroPhase.x;
  let cosT = dot(dir, uniforms.sroSunDir.xyz);
  let hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
  let phase = mix(1.0, min(hg, uniforms.sroPhase.z), uniforms.sroPhase.y);
  var amount = 0.0;
#ifdef ${M}
  amount += sa.x * phase;
#endif
#ifdef ${R}
  amount += sa.y * uniforms.sroCam.z;
#endif
  fragmentOutputs.color = vec4f(base0.rgb + uniforms.sroShaftColor.rgb * max(amount, 0.0), base0.a);
}
`

const COMPOSITE_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform highp sampler2D textureSampler;
uniform sampler2D sroScene;
uniform highp sampler2D sroDepth;
uniform mat4 sroInvViewProj;
uniform vec4 sroEye;
uniform vec4 sroFwd;
uniform vec4 sroCam;
uniform vec4 sroSunDir;
uniform vec4 sroShaftColor;
uniform vec4 sroPhase;

vec4 sroTap(vec2 tc, vec2 lsize) {
  return texelFetch(textureSampler, ivec2(clamp(tc, vec2(0.0), lsize - vec2(1.0))), 0);
}

#define CUSTOM_FRAGMENT_DEFINITIONS

void main(void) {
  vec2 uv = vUV;
  vec4 base0 = textureLod(sroScene, uv, 0.0);
  gl_FragColor = base0;
  if (sroCam.w < 0.5) return;
  vec2 dsize = vec2(textureSize(sroDepth, 0));
  float d = texelFetch(sroDepth, ivec2(clamp(floor(uv * dsize), vec2(0.0), dsize - vec2(1.0))), 0).r;
  float zc = d;
#ifndef IS_NDC_HALF_ZRANGE
  zc = d * 2.0 - 1.0;
#endif
  vec4 wp = sroInvViewProj * vec4(uv * 2.0 - 1.0, d >= 1.0 ? 1.0 : zc, 1.0);
  vec3 toP = wp.xyz / wp.w - sroEye.xyz;
  vec3 dir = normalize(toP);
  float z = d >= 1.0 ? sroCam.y : dot(toP, sroFwd.xyz);
  vec2 lsize = vec2(textureSize(textureSampler, 0));
  vec2 lp = uv * lsize - vec2(0.5);
  vec2 base = floor(lp);
  vec2 fr = lp - base;
  vec4 t00 = sroTap(base, lsize);
  vec4 t10 = sroTap(base + vec2(1.0, 0.0), lsize);
  vec4 t01 = sroTap(base + vec2(0.0, 1.0), lsize);
  vec4 t11 = sroTap(base + vec2(1.0, 1.0), lsize);
  float iz = 12.0 / max(z, 1.0);
  float w00 = (1.0 - fr.x) * (1.0 - fr.y) * exp(-abs(t00.z - z) * iz);
  float w10 = fr.x * (1.0 - fr.y) * exp(-abs(t10.z - z) * iz);
  float w01 = (1.0 - fr.x) * fr.y * exp(-abs(t01.z - z) * iz);
  float w11 = fr.x * fr.y * exp(-abs(t11.z - z) * iz);
  float wsum = w00 + w10 + w01 + w11;
  vec2 sa = (t00.xw * w00 + t10.xw * w10 + t01.xw * w01 + t11.xw * w11) / max(wsum, 1e-6);
  if (wsum < 1e-3) {
    vec4 best = t00;
    if (abs(t10.z - z) < abs(best.z - z)) best = t10;
    if (abs(t01.z - z) < abs(best.z - z)) best = t01;
    if (abs(t11.z - z) < abs(best.z - z)) best = t11;
    sa = best.xw;
  }
  float g = sroPhase.x;
  float cosT = dot(dir, sroSunDir.xyz);
  float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
  float phase = mix(1.0, min(hg, sroPhase.z), sroPhase.y);
  float amount = 0.0;
#ifdef ${M}
  amount += sa.x * phase;
#endif
#ifdef ${R}
  amount += sa.y * sroCam.z;
#endif
  gl_FragColor = vec4(base0.rgb + sroShaftColor.rgb * max(amount, 0.0), base0.a);
}
`

/** The three passes' sources (both languages) with their uniform and sampler lists. */
export const SHAFT_SHADERS: Readonly<Record<'march' | 'resolve' | 'composite', ShaftShaderSource>> = {
  march: { name: SHAFT_MARCH_SHADER, wgsl: MARCH_WGSL, glsl: MARCH_GLSL, uniforms: SHAFT_MARCH_UNIFORMS, samplers: SHAFT_MARCH_SAMPLERS },
  resolve: { name: SHAFT_RESOLVE_SHADER, wgsl: RESOLVE_WGSL, glsl: RESOLVE_GLSL, uniforms: SHAFT_RESOLVE_UNIFORMS, samplers: SHAFT_RESOLVE_SAMPLERS },
  composite: { name: SHAFT_COMPOSITE_SHADER, wgsl: COMPOSITE_WGSL, glsl: COMPOSITE_GLSL, uniforms: SHAFT_COMPOSITE_UNIFORMS, samplers: SHAFT_COMPOSITE_SAMPLERS },
}
