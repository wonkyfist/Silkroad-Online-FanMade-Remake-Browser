/**
 * Rain, curtain, splashes, drips and the lightning bolt (docs/WEATHER.md §6.8, §7.3; ported from the measured
 * prototype work/tmp/weather/gpu/main.ts). No CPU particles: every drop is placed in its vertex shader.
 *
 * - Rain box: one static mesh of N streak quads (vertex = corner u, corner v, drop id). Each drop's position is
 *   world-anchored and wraps inside a box around the camera (`p = lo + mod(seed × size + offset − lo, size)`), so it
 *   never swims when the camera moves; `offset` is the fall integrated on the CPU (a gust changes the slant, it never
 *   teleports the drops). Drops with hash > rain collapse (a light rain is sparse with the same mesh), and so does a
 *   drop under the shelter map's cover. Streaks are at least one pixel wide (alpha scaled down to match) and fade near
 *   the camera and at the box edge.
 * - Curtain: an open cylinder (45 m, 40 m high) of scrolling procedural streaks beyond the box, depth-tested.
 * - Splashes: slots on a world-anchored grid around the camera, re-seeded every 0.35 s, on the shelter map's top
 *   (roofs, ground and water alike); wave 12 RAIN-P: a crown of droplets and three flung droplets on a camera-facing
 *   sprite (the flat 4–10 cm rings could not be seen from the game camera).
 * - Drips: short streaks falling from covers at least 2.5 m above the character, while wet (`max(rain, wet × 0.5)`).
 * - Bolt (High+): a jagged camera-facing ribbon with one fork toward the flash, built on the flash's rising edge,
 *   additive, only while the flash is bright (a `reduceFlashing` flash never reaches it).
 *
 * Every mesh is in rendering group 0 with an explicit alphaIndex (NOT group 1: Babylon clears depth before each group,
 * so rain there would draw over the buildings). Transparent meshes sort by alphaIndex, then back to front; the water
 * keeps the default alphaIndex, and the rain meshes, centred on the camera, sort after it (the curtain's sort centre
 * sits 20 m out, so it draws before the box).
 */
import {
  BoundingInfo,
  Constants,
  Mesh,
  ShaderLanguage,
  ShaderMaterial,
  ShaderStore,
  Vector3,
  Vector4,
  VertexData,
  type BaseTexture,
  type Camera,
  type Scene,
} from '@babylonjs/core'
import { WX_SHELTER_GLSL, WX_SHELTER_WGSL } from './chunks.ts'
import type { WeatherFrame } from './frame.ts'
import type { WeatherPreset } from './presets.ts'

/** The sort tier of every weather mesh (the water keeps the same default; distance orders within it). */
export const RAIN_ALPHA_INDEX = Number.MAX_VALUE

/** Streak look (WEATHER §6.8). */
export const RAIN_WIDTH_M = 0.012
export const RAIN_ALPHA = 0.28
/**
 * Streaks fade in between these distances (m). W9 LOOK: 0.5–2 m let a drop beside the camera cross half the screen as a
 * long bright line.
 */
export const RAIN_NEAR_M: readonly [number, number] = [1.5, 4]
export const CURTAIN_RADIUS_M = 45
export const CURTAIN_HEIGHT_M = 40
/**
 * Curtain columns around the cylinder (outer, inner layer) and its opacity at full rain. W9 LOOK: 420/260 columns made
 * 0.7 m wide, 1 m tall dashes at 45 m, the "white blocks" of the storms; now ~0.2 m columns with a thin profile, longer
 * streaks leaning with the wind.
 */
export const CURTAIN_COLUMNS: readonly [number, number] = [1500, 1000]
export const CURTAIN_ALPHA = 0.5
export const SPLASH_RADIUS_M = 18
export const SPLASH_CYCLE_S = 0.35
/**
 * Splash crowns (wave 12 RAIN-P; the W9 LOOK flat rings, 4–10 cm at 0.15 opacity, could not be seen from the game
 * camera): the crown's rim radius and height (m) from a drizzle to a downpour (± 25 % / 30 % per drop), its droplets
 * 25 % of the radius (at least ~0.7 px, fainter when widened), three flung droplets; opacity SPLASH_ALPHA, colour the
 * streaks' × SPLASH_BRIGHT (a crown catches the sky). The crown lives SPLASH_CROWN_LIFE of the cycle; the sprite's
 * half size (m) and how far its centre is lifted (× the half size × 2).
 */
export const SPLASH_CROWN_M: readonly [number, number] = [0.06, 0.09]
export const SPLASH_HEIGHT_M: readonly [number, number] = [0.05, 0.09]
export const SPLASH_ALPHA = 0.7
export const SPLASH_BRIGHT = 1.4
export const SPLASH_CROWN_LIFE = 0.6
export const SPLASH_HALF_M = 0.3
export const SPLASH_LIFT = 0.17
export const DRIP_SQUARE_M = 20

/** Fall speed (9 m/s rain .. 11 m/s storm), streak length (0.55 .. 0.8 m) and the wind drift (× 0.6 of the gust). */
export interface RainMotion {
  vel: [number, number, number]
  length: number
}

export function rainMotion(f: Pick<WeatherFrame, 'rain' | 'windX' | 'windZ' | 'gustMs'>, out: RainMotion = { vel: [0, 0, 0], length: 0 }): RainMotion {
  const k = smoothstep(0.6, 1, f.rain)
  const drift = 0.6 * Math.max(0, f.gustMs)
  out.vel[0] = f.windX * drift
  out.vel[1] = -(9 + 2 * k)
  out.vel[2] = f.windZ * drift
  out.length = 0.55 + 0.25 * k
  return out
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** fract(sin(n + i) × k) per component: the shaders' hash, mirrored for the tests. */
export function hash3(n: number): [number, number, number] {
  const fr = (v: number) => v - Math.floor(v)
  return [fr(Math.sin(n) * 43758.5453), fr(Math.sin(n + 1) * 22578.1459), fr(Math.sin(n + 2) * 19642.349)]
}

/**
 * The rain box's wrap, a TS mirror of the vertex shader: a drop's position for the camera at `cam`, the box `size` and
 * the integrated fall `offset` (floored modulo, both languages). Always inside [cam − size/2, cam + size/2).
 */
export function rainDropPosition(id: number, cam: readonly number[], size: readonly number[], offset: readonly number[]): [number, number, number] {
  const seed = hash3(id * 1.618)
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const lo = cam[i]! - size[i]! * 0.5
    const q = seed[i]! * size[i]! + offset[i]! - lo
    out[i] = lo + q - size[i]! * Math.floor(q / size[i]!)
  }
  return out
}

// ---- shaders -----------------------------------------------------------------------------------------------------

const HASH_WGSL = /* wgsl */ `fn wxHash3(n: f32) -> vec3f {
  return fract(sin(vec3f(n, n + 1.0, n + 2.0)) * vec3f(43758.5453, 22578.1459, 19642.349));
}
`
const HASH_GLSL = /* glsl */ `vec3 wxHash3(float n) {
  return fract(sin(vec3(n, n + 1.0, n + 2.0)) * vec3(43758.5453, 22578.1459, 19642.349));
}
`

// Rain streaks (box) and drips (DRIPS): rainP0 = offset xyz (m) + count fraction, rainP1 = velocity xyz + length,
// rainP2 = box size xyz + pixel angle (drips: grid cells, cell size, drip speed, pixel angle).
const RAIN_VS_WGSL = /* wgsl */ `
attribute position: vec3f;
uniform viewProjection: mat4x4f;
uniform wxA: vec4f;
uniform wxF: vec4f;
uniform wxCam: vec4f;
uniform wxOcc: vec4f;
uniform wxOccM: vec4f;
uniform rainP0: vec4f;
uniform rainP1: vec4f;
uniform rainP2: vec4f;
varying vA: f32;
varying vUV: vec2f;
${HASH_WGSL}
#ifdef WX_SHELTER
${WX_SHELTER_WGSL}#endif

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let id = vertexInputs.position.z;
  let corner = vertexInputs.position.xy;
  let seed = wxHash3(id * 1.618);
  let cam = uniforms.wxCam.xyz;
  var dir = normalize(uniforms.rainP1.xyz);
#ifdef DRIPS
  let g = uniforms.rainP2.x;
  let cell = uniforms.rainP2.y;
  let gi = vec2f(id - g * floor(id / g), floor(id / g));
  let c = floor(cam.xz / cell) - vec2f(floor(g * 0.5)) + gi;
  let h = wxHash3(dot(c, vec2f(12.9898, 78.233)));
  let xz = (c + h.xy) * cell;
  var top = -10000.0;
#ifdef WX_SHELTER
  top = sroShelterTop(xz);
#endif
  let period = 1.1 + h.z;
  let ph = fract(uniforms.wxA.w / period + h.z * 7.0);
  let p = vec3f(xz.x, top - 0.2 - uniforms.rainP2.z * ph, xz.y);
  dir = vec3f(0.0, -1.0, 0.0);
  let len = uniforms.rainP1.w;
  let keep = step(h.x * 0.7 + h.y * 0.3, uniforms.rainP0.w) * step(uniforms.wxF.x + 2.5, top);
  let fadeR = uniforms.rainP2.y * g * 0.5;
#else
  let size = uniforms.rainP2.xyz;
  let lo = cam - size * 0.5;
  let q = seed * size + uniforms.rainP0.xyz - lo;
  let p = lo + q - size * floor(q / size);
  let len = uniforms.rainP1.w;
  var keep = step(fract(seed.x * 7.13 + seed.z * 3.71), uniforms.rainP0.w);
#ifdef WX_SHELTER
  keep = keep * step(sroShelterTop(p.xz), p.y);
#endif
  let fadeR = size.x * 0.5;
#endif
  let toCam = cam - p;
  let d = length(toCam);
  let width = max(${RAIN_WIDTH_M}, 1.2 * d * uniforms.rainP2.w);
  let side = normalize(cross(dir, toCam) + vec3f(1e-5, 0.0, 1e-5)) * width;
  let pos = p - dir * (len * corner.y) + side * corner.x;
  vertexOutputs.vA = keep * smoothstep(${RAIN_NEAR_M[0].toFixed(1)}, ${RAIN_NEAR_M[1].toFixed(1)}, d) * (1.0 - smoothstep(fadeR * 0.7, fadeR, d)) * (${RAIN_WIDTH_M} / width);
  vertexOutputs.vUV = vec2f(corner.x + 0.5, corner.y);
  vertexOutputs.position = (uniforms.viewProjection * vec4f(pos, 1.0)) * keep;
}
`
const RAIN_FS_WGSL = /* wgsl */ `
uniform rainP3: vec4f;
varying vA: f32;
varying vUV: vec2f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let x = 1.0 - abs(fragmentInputs.vUV.x * 2.0 - 1.0);
  let a = x * x * sin(fragmentInputs.vUV.y * 3.14159) * fragmentInputs.vA * uniforms.rainP3.w;
  fragmentOutputs.color = vec4f(uniforms.rainP3.rgb * a, a);
}
`
const RAIN_VS_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
uniform vec4 wxA;
uniform vec4 wxF;
uniform vec4 wxCam;
uniform vec4 wxOcc;
uniform vec4 wxOccM;
uniform vec4 rainP0;
uniform vec4 rainP1;
uniform vec4 rainP2;
varying float vA;
varying vec2 vUV;
${HASH_GLSL}
#ifdef WX_SHELTER
${WX_SHELTER_GLSL}#endif

void main(void) {
  float id = position.z;
  vec2 corner = position.xy;
  vec3 seed = wxHash3(id * 1.618);
  vec3 cam = wxCam.xyz;
  vec3 dir = normalize(rainP1.xyz);
#ifdef DRIPS
  float g = rainP2.x;
  float cell = rainP2.y;
  vec2 gi = vec2(id - g * floor(id / g), floor(id / g));
  vec2 c = floor(cam.xz / cell) - vec2(floor(g * 0.5)) + gi;
  vec3 h = wxHash3(dot(c, vec2(12.9898, 78.233)));
  vec2 xz = (c + h.xy) * cell;
  float top = -10000.0;
#ifdef WX_SHELTER
  top = sroShelterTop(xz);
#endif
  float period = 1.1 + h.z;
  float ph = fract(wxA.w / period + h.z * 7.0);
  vec3 p = vec3(xz.x, top - 0.2 - rainP2.z * ph, xz.y);
  dir = vec3(0.0, -1.0, 0.0);
  float len = rainP1.w;
  float keep = step(h.x * 0.7 + h.y * 0.3, rainP0.w) * step(wxF.x + 2.5, top);
  float fadeR = rainP2.y * g * 0.5;
#else
  vec3 size = rainP2.xyz;
  vec3 lo = cam - size * 0.5;
  vec3 q = seed * size + rainP0.xyz - lo;
  vec3 p = lo + q - size * floor(q / size);
  float len = rainP1.w;
  float keep = step(fract(seed.x * 7.13 + seed.z * 3.71), rainP0.w);
#ifdef WX_SHELTER
  keep *= step(sroShelterTop(p.xz), p.y);
#endif
  float fadeR = size.x * 0.5;
#endif
  vec3 toCam = cam - p;
  float d = length(toCam);
  float width = max(${RAIN_WIDTH_M}, 1.2 * d * rainP2.w);
  vec3 side = normalize(cross(dir, toCam) + vec3(1e-5, 0.0, 1e-5)) * width;
  vec3 pos = p - dir * (len * corner.y) + side * corner.x;
  vA = keep * smoothstep(${RAIN_NEAR_M[0].toFixed(1)}, ${RAIN_NEAR_M[1].toFixed(1)}, d) * (1.0 - smoothstep(fadeR * 0.7, fadeR, d)) * (${RAIN_WIDTH_M} / width);
  vUV = vec2(corner.x + 0.5, corner.y);
  gl_Position = (viewProjection * vec4(pos, 1.0)) * keep;
}
`
const RAIN_FS_GLSL = /* glsl */ `
precision highp float;
uniform vec4 rainP3;
varying float vA;
varying vec2 vUV;

void main(void) {
  float x = 1.0 - abs(vUV.x * 2.0 - 1.0);
  float a = x * x * sin(vUV.y * 3.14159) * vA * rainP3.w;
  gl_FragColor = vec4(rainP3.rgb * a, a);
}
`

// Splashes (wave 12 RAIN-P): splP0 = grid cells per side, cell size (m), count fraction, cycle (s); splP1 = crown
// radius (m), crown height (m), pixel angle (rad), sprite half size (m). Each slot is a camera-facing sprite on the
// shelter map's top (ground, roofs, water alike), moved 0.3 m toward the camera so the ground in front of it never
// hides its lower half. The fragment draws a drop's crown (six jittered droplets on a rim that rises and sinks, seen at
// the camera's elevation) and three droplets flung out along parabolas; corner in −0.5..0.5.
const SPLASH_VS_WGSL = /* wgsl */ `
attribute position: vec3f;
uniform viewProjection: mat4x4f;
uniform wxA: vec4f;
uniform wxF: vec4f;
uniform wxCam: vec4f;
uniform wxOcc: vec4f;
uniform wxOccM: vec4f;
uniform splP0: vec4f;
uniform splP1: vec4f;
varying vUV: vec4f;
varying vSp: vec4f;
${HASH_WGSL}${WX_SHELTER_WGSL}
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let id = vertexInputs.position.z;
  let corner = vertexInputs.position.xy;
  let g = uniforms.splP0.x;
  let cell = uniforms.splP0.y;
  let cam = uniforms.wxCam.xyz;
  let gi = vec2f(id - g * floor(id / g), floor(id / g));
  let c = floor(cam.xz / cell) - vec2f(floor(g * 0.5)) + gi;
  let k = dot(c, vec2f(12.9898, 78.233));
  let h = wxHash3(k);
  let t = uniforms.wxA.w / uniforms.splP0.w + h.z;
  let h2 = wxHash3(k + floor(t) * 17.13);
  let ph = fract(t);
  let xz = (c + h2.xy) * cell;
  let top = sroShelterTop(xz);
  let r = g * cell * 0.5;
  let dist = distance(xz, cam.xz);
  let keep = step(h2.z, uniforms.splP0.z) * step(-9000.0, top) * step(dist, r);
  let p = vec3f(xz.x, top + 0.02, xz.y);
  let toCam = cam - p;
  let d = max(length(toCam), 0.001);
  let v = toCam / d;
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), v) + vec3f(1e-5, 0.0, 1e-5));
  let up = cross(v, right);
  let q = uniforms.splP1.w;
  let local = vec2f(corner.x, corner.y + ${SPLASH_LIFT.toFixed(2)}) * (2.0 * q);
  let pos = p + v * 0.3 + right * local.x + up * local.y;
  let se = clamp(v.y, 0.0, 1.0);
  vertexOutputs.vUV = vec4f(local, ph, 1.0 - smoothstep(r * 0.7, r, dist));
  vertexOutputs.vSp = vec4f(se, sqrt(1.0 - se * se), fract(h2.x * 7.31 + h2.y * 3.17), d * uniforms.splP1.z * 0.7);
  vertexOutputs.position = (uniforms.viewProjection * vec4f(pos, 1.0)) * keep;
}
`
const SPLASH_FS_WGSL = /* wgsl */ `
uniform rainP3: vec4f;
uniform splP0: vec4f;
uniform splP1: vec4f;
varying vUV: vec4f;
varying vSp: vec4f;

fn sroDrop(u: vec2f, c: vec2f, r: f32) -> f32 {
  return 1.0 - smoothstep(r * 0.45, r, length(u - c));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let u = fragmentInputs.vUV.xy;
  let ph = fragmentInputs.vUV.z;
  let se = fragmentInputs.vSp.x;
  let ce = fragmentInputs.vSp.y;
  let seed = fragmentInputs.vSp.z;
  let minR = fragmentInputs.vSp.w;
  let r0 = uniforms.splP1.x * mix(0.75, 1.25, fract(seed * 7.31));
  let h0 = uniforms.splP1.y * mix(0.7, 1.3, fract(seed * 3.17));
  let pc = clamp(ph / ${SPLASH_CROWN_LIFE.toFixed(2)}, 0.0, 1.0);
  let rc = r0 * (0.35 + 0.65 * sqrt(pc));
  let hc = h0 * sin(3.14159 * pc);
  let rd0 = r0 * 0.25 * (1.0 - 0.5 * pc);
  let rd = max(rd0, minR);
  var a = 0.0;
  for (var i = 0; i < 6; i++) {
    let fi = f32(i);
    let jit = fract(seed * 31.7 + fi * 0.73);
    let ang = fi * 1.0472 + seed * 6.2832 + (jit - 0.5) * 0.8;
    let hk = hc * (0.75 + 0.5 * fract(seed * 13.7 + fi * 0.37));
    let rk = rc * (0.8 + 0.4 * jit);
    a = max(a, sroDrop(u, vec2f(rk * cos(ang), rk * sin(ang) * se + hk * ce), rd));
  }
  a = a * (1.0 - smoothstep(0.75, 1.0, pc)) * min(1.0, rd0 / rd);
  let tt = ph * uniforms.splP0.w;
  let rj0 = r0 * 0.16;
  let rj = max(rj0, minR);
  for (var j = 0; j < 3; j++) {
    let fj = f32(j);
    let aj = seed * 11.3 + fj * 2.1;
    let v0 = 0.9 + 0.8 * fract(seed * 5.7 + fj * 0.61);
    let vh = 0.2 + 0.3 * fract(seed * 9.1 + fj * 0.29);
    let y = v0 * tt - 4.9 * tt * tt;
    let rr = r0 * 0.5 + vh * tt;
    let m = step(0.0, y) * step(0.03, tt) * min(1.0, rj0 / rj);
    a = max(a, sroDrop(u, vec2f(rr * cos(aj), rr * sin(aj) * se + y * ce), rj) * m);
  }
  let al = a * fragmentInputs.vUV.w * ${SPLASH_ALPHA.toFixed(2)};
  fragmentOutputs.color = vec4f(uniforms.rainP3.rgb * ${SPLASH_BRIGHT.toFixed(2)} * al, al);
}
`
const SPLASH_VS_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
uniform vec4 wxA;
uniform vec4 wxF;
uniform vec4 wxCam;
uniform vec4 wxOcc;
uniform vec4 wxOccM;
uniform vec4 splP0;
uniform vec4 splP1;
varying vec4 vUV;
varying vec4 vSp;
${HASH_GLSL}${WX_SHELTER_GLSL}
void main(void) {
  float id = position.z;
  vec2 corner = position.xy;
  float g = splP0.x;
  float cell = splP0.y;
  vec3 cam = wxCam.xyz;
  vec2 gi = vec2(id - g * floor(id / g), floor(id / g));
  vec2 c = floor(cam.xz / cell) - vec2(floor(g * 0.5)) + gi;
  float k = dot(c, vec2(12.9898, 78.233));
  vec3 h = wxHash3(k);
  float t = wxA.w / splP0.w + h.z;
  vec3 h2 = wxHash3(k + floor(t) * 17.13);
  float ph = fract(t);
  vec2 xz = (c + h2.xy) * cell;
  float top = sroShelterTop(xz);
  float r = g * cell * 0.5;
  float dist = distance(xz, cam.xz);
  float keep = step(h2.z, splP0.z) * step(-9000.0, top) * step(dist, r);
  vec3 p = vec3(xz.x, top + 0.02, xz.y);
  vec3 toCam = cam - p;
  float d = max(length(toCam), 0.001);
  vec3 v = toCam / d;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), v) + vec3(1e-5, 0.0, 1e-5));
  vec3 up = cross(v, right);
  float q = splP1.w;
  vec2 local = vec2(corner.x, corner.y + ${SPLASH_LIFT.toFixed(2)}) * (2.0 * q);
  vec3 pos = p + v * 0.3 + right * local.x + up * local.y;
  float se = clamp(v.y, 0.0, 1.0);
  vUV = vec4(local, ph, 1.0 - smoothstep(r * 0.7, r, dist));
  vSp = vec4(se, sqrt(1.0 - se * se), fract(h2.x * 7.31 + h2.y * 3.17), d * splP1.z * 0.7);
  gl_Position = (viewProjection * vec4(pos, 1.0)) * keep;
}
`
const SPLASH_FS_GLSL = /* glsl */ `
precision highp float;
uniform vec4 rainP3;
uniform vec4 splP0;
uniform vec4 splP1;
varying vec4 vUV;
varying vec4 vSp;

float sroDrop(vec2 u, vec2 c, float r) {
  return 1.0 - smoothstep(r * 0.45, r, length(u - c));
}

void main(void) {
  vec2 u = vUV.xy;
  float ph = vUV.z;
  float se = vSp.x;
  float ce = vSp.y;
  float seed = vSp.z;
  float minR = vSp.w;
  float r0 = splP1.x * mix(0.75, 1.25, fract(seed * 7.31));
  float h0 = splP1.y * mix(0.7, 1.3, fract(seed * 3.17));
  float pc = clamp(ph / ${SPLASH_CROWN_LIFE.toFixed(2)}, 0.0, 1.0);
  float rc = r0 * (0.35 + 0.65 * sqrt(pc));
  float hc = h0 * sin(3.14159 * pc);
  float rd0 = r0 * 0.25 * (1.0 - 0.5 * pc);
  float rd = max(rd0, minR);
  float a = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float jit = fract(seed * 31.7 + fi * 0.73);
    float ang = fi * 1.0472 + seed * 6.2832 + (jit - 0.5) * 0.8;
    float hk = hc * (0.75 + 0.5 * fract(seed * 13.7 + fi * 0.37));
    float rk = rc * (0.8 + 0.4 * jit);
    a = max(a, sroDrop(u, vec2(rk * cos(ang), rk * sin(ang) * se + hk * ce), rd));
  }
  a *= (1.0 - smoothstep(0.75, 1.0, pc)) * min(1.0, rd0 / rd);
  float tt = ph * splP0.w;
  float rj0 = r0 * 0.16;
  float rj = max(rj0, minR);
  for (int j = 0; j < 3; j++) {
    float fj = float(j);
    float aj = seed * 11.3 + fj * 2.1;
    float v0 = 0.9 + 0.8 * fract(seed * 5.7 + fj * 0.61);
    float vh = 0.2 + 0.3 * fract(seed * 9.1 + fj * 0.29);
    float y = v0 * tt - 4.9 * tt * tt;
    float rr = r0 * 0.5 + vh * tt;
    float m = step(0.0, y) * step(0.03, tt) * min(1.0, rj0 / rj);
    a = max(a, sroDrop(u, vec2(rr * cos(aj), rr * sin(aj) * se + y * ce), rj) * m);
  }
  float al = a * vUV.w * ${SPLASH_ALPHA.toFixed(2)};
  gl_FragColor = vec4(rainP3.rgb * ${SPLASH_BRIGHT.toFixed(2)} * al, al);
}
`

// Curtain: curP0 = fall speed, wind drift x, wind drift z, alpha; position = (angle 0..1, height 0..1, layer).
const CURTAIN_VS_WGSL = /* wgsl */ `
attribute position: vec3f;
uniform viewProjection: mat4x4f;
uniform wxCam: vec4f;
varying vUV: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let a = vertexInputs.position.x * 6.2831853;
  let r = ${CURTAIN_RADIUS_M.toFixed(1)} - vertexInputs.position.z * 6.0;
  let y = uniforms.wxCam.y - ${(CURTAIN_HEIGHT_M * 0.35).toFixed(1)} + vertexInputs.position.y * ${CURTAIN_HEIGHT_M.toFixed(1)};
  let pos = vec3f(uniforms.wxCam.x + cos(a) * r, y, uniforms.wxCam.z + sin(a) * r);
  vertexOutputs.vUV = vec3f(vertexInputs.position.x, vertexInputs.position.y, vertexInputs.position.z);
  vertexOutputs.position = uniforms.viewProjection * vec4f(pos, 1.0);
}
`
const CURTAIN_FS_WGSL = /* wgsl */ `
uniform wxA: vec4f;
uniform curP0: vec4f;
uniform rainP3: vec4f;
varying vUV: vec3f;

fn wxH1(n: f32) -> f32 {
  var p = fract(n * 0.1031);
  p = p * (p + 33.33);
  return fract(p * (p + p));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let layer = fragmentInputs.vUV.z;
  let cols = mix(${CURTAIN_COLUMNS[0].toFixed(1)}, ${CURTAIN_COLUMNS[1].toFixed(1)}, layer);
  // The streaks lean with the wind: its part along the cylinder per metre of fall, in columns.
  let ang = fragmentInputs.vUV.x * 6.2831853;
  let lean = (uniforms.curP0.z * cos(ang) - uniforms.curP0.y * sin(ang)) / max(uniforms.curP0.x, 1.0);
  let perM = cols / (6.2831853 * (${CURTAIN_RADIUS_M.toFixed(1)} - layer * 6.0));
  let u = fragmentInputs.vUV.x * cols + fragmentInputs.vUV.y * ${CURTAIN_HEIGHT_M.toFixed(1)} * lean * perM;
  let col = floor(u);
  let hc = wxH1(col + layer * 91.0);
  let y = fragmentInputs.vUV.y * ${CURTAIN_HEIGHT_M.toFixed(1)} + uniforms.wxA.w * uniforms.curP0.x * (0.8 + 0.4 * hc) + hc * 50.0;
  let seg = fract(y / mix(3.0, 4.5, layer));
  let w = 1.0 - abs(fract(u) * 2.0 - 1.0);
  let streak = smoothstep(0.0, 0.05, seg) * (1.0 - smoothstep(0.3, 0.55, seg)) * pow(w, 6.0) * step(0.35, hc);
  let edge = smoothstep(0.0, 0.25, fragmentInputs.vUV.y) * (1.0 - smoothstep(0.7, 1.0, fragmentInputs.vUV.y));
  let a = streak * edge * uniforms.curP0.w;
  fragmentOutputs.color = vec4f(uniforms.rainP3.rgb * a, a);
}
`
const CURTAIN_VS_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
uniform vec4 wxCam;
varying vec3 vUV;

void main(void) {
  float a = position.x * 6.2831853;
  float r = ${CURTAIN_RADIUS_M.toFixed(1)} - position.z * 6.0;
  float y = wxCam.y - ${(CURTAIN_HEIGHT_M * 0.35).toFixed(1)} + position.y * ${CURTAIN_HEIGHT_M.toFixed(1)};
  vec3 pos = vec3(wxCam.x + cos(a) * r, y, wxCam.z + sin(a) * r);
  vUV = position;
  gl_Position = viewProjection * vec4(pos, 1.0);
}
`
const CURTAIN_FS_GLSL = /* glsl */ `
precision highp float;
uniform vec4 wxA;
uniform vec4 curP0;
uniform vec4 rainP3;
varying vec3 vUV;

float wxH1(float n) {
  float p = fract(n * 0.1031);
  p = p * (p + 33.33);
  return fract(p * (p + p));
}

void main(void) {
  float layer = vUV.z;
  float cols = mix(${CURTAIN_COLUMNS[0].toFixed(1)}, ${CURTAIN_COLUMNS[1].toFixed(1)}, layer);
  float ang = vUV.x * 6.2831853;
  float lean = (curP0.z * cos(ang) - curP0.y * sin(ang)) / max(curP0.x, 1.0);
  float perM = cols / (6.2831853 * (${CURTAIN_RADIUS_M.toFixed(1)} - layer * 6.0));
  float u = vUV.x * cols + vUV.y * ${CURTAIN_HEIGHT_M.toFixed(1)} * lean * perM;
  float col = floor(u);
  float hc = wxH1(col + layer * 91.0);
  float y = vUV.y * ${CURTAIN_HEIGHT_M.toFixed(1)} + wxA.w * curP0.x * (0.8 + 0.4 * hc) + hc * 50.0;
  float seg = fract(y / mix(3.0, 4.5, layer));
  float w = 1.0 - abs(fract(u) * 2.0 - 1.0);
  float streak = smoothstep(0.0, 0.05, seg) * (1.0 - smoothstep(0.3, 0.55, seg)) * pow(w, 6.0) * step(0.35, hc);
  float edge = smoothstep(0.0, 0.25, vUV.y) * (1.0 - smoothstep(0.7, 1.0, vUV.y));
  float a = streak * edge * curP0.w;
  gl_FragColor = vec4(rainP3.rgb * a, a);
}
`

// Bolt: world positions rebuilt per strike; boltP = colour rgb, intensity.
const BOLT_VS_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
uniform viewProjection: mat4x4f;
varying vUV: vec2f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.vUV = vertexInputs.uv;
  vertexOutputs.position = uniforms.viewProjection * vec4f(vertexInputs.position, 1.0);
}
`
const BOLT_FS_WGSL = /* wgsl */ `
uniform boltP: vec4f;
varying vUV: vec2f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let w = 1.0 - abs(fragmentInputs.vUV.x * 2.0 - 1.0);
  let a = pow(w, 3.0) * uniforms.boltP.w * fragmentInputs.vUV.y;
  fragmentOutputs.color = vec4f(uniforms.boltP.rgb * a, a);
}
`
const BOLT_VS_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
varying vec2 vUV;

void main(void) {
  vUV = uv;
  gl_Position = viewProjection * vec4(position, 1.0);
}
`
const BOLT_FS_GLSL = /* glsl */ `
precision highp float;
uniform vec4 boltP;
varying vec2 vUV;

void main(void) {
  float w = 1.0 - abs(vUV.x * 2.0 - 1.0);
  float a = pow(w, 3.0) * boltP.w * vUV.y;
  gl_FragColor = vec4(boltP.rgb * a, a);
}
`

/** Every weather effect shader pair (tests: both languages, the same uniform names). */
export const RAIN_SHADERS = {
  sroRain: { vertexWGSL: RAIN_VS_WGSL, fragmentWGSL: RAIN_FS_WGSL, vertexGLSL: RAIN_VS_GLSL, fragmentGLSL: RAIN_FS_GLSL },
  sroSplash: { vertexWGSL: SPLASH_VS_WGSL, fragmentWGSL: SPLASH_FS_WGSL, vertexGLSL: SPLASH_VS_GLSL, fragmentGLSL: SPLASH_FS_GLSL },
  sroCurtain: { vertexWGSL: CURTAIN_VS_WGSL, fragmentWGSL: CURTAIN_FS_WGSL, vertexGLSL: CURTAIN_VS_GLSL, fragmentGLSL: CURTAIN_FS_GLSL },
  sroBolt: { vertexWGSL: BOLT_VS_WGSL, fragmentWGSL: BOLT_FS_WGSL, vertexGLSL: BOLT_VS_GLSL, fragmentGLSL: BOLT_FS_GLSL },
} as const

let registered = false
function registerShaders(): void {
  if (registered) return
  registered = true
  for (const [name, s] of Object.entries(RAIN_SHADERS)) {
    ShaderStore.ShadersStoreWGSL[`${name}VertexShader`] = s.vertexWGSL
    ShaderStore.ShadersStoreWGSL[`${name}FragmentShader`] = s.fragmentWGSL
    ShaderStore.ShadersStore[`${name}VertexShader`] = s.vertexGLSL
    ShaderStore.ShadersStore[`${name}FragmentShader`] = s.fragmentGLSL
  }
}

// ---- meshes ------------------------------------------------------------------------------------------------------

/** N quads of (corner u, corner v, id): u −0.5..0.5, v 0..1 (streaks) or −0.5..0.5 (splashes). */
function quads(scene: Scene, name: string, n: number, centeredV: boolean): Mesh {
  const pos = new Float32Array(n * 12)
  const idx = new Uint32Array(n * 6)
  const v0 = centeredV ? -0.5 : 0
  const v1 = centeredV ? 0.5 : 1
  for (let i = 0; i < n; i++) {
    pos.set([-0.5, v0, i, 0.5, v0, i, 0.5, v1, i, -0.5, v1, i], i * 12)
    const v = i * 4
    idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6)
  }
  return fromData(scene, name, pos, idx)
}

function fromData(scene: Scene, name: string, positions: Float32Array, indices: Uint32Array, uvs?: Float32Array): Mesh {
  const mesh = new Mesh(name, scene)
  const vd = new VertexData()
  vd.positions = positions
  vd.indices = indices
  if (uvs) vd.uvs = uvs
  vd.applyToMesh(mesh, !!uvs)
  mesh.isPickable = false
  mesh.alwaysSelectAsActiveMesh = true
  mesh.doNotSyncBoundingInfo = true
  mesh.alphaIndex = RAIN_ALPHA_INDEX
  mesh.metadata = { sroWorld: 'weather' }
  // A small box at the mesh's position: the transparent sort's distance is the camera's distance to its centre.
  mesh.setBoundingInfo(new BoundingInfo(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)))
  return mesh
}

/** The curtain cylinder: (angle 0..1, height 0..1, layer 0/1) per vertex. */
function cylinder(scene: Scene, layers: number): Mesh {
  const seg = 48
  const pos: number[] = []
  const idx: number[] = []
  for (let l = 0; l < layers; l++) {
    const base = pos.length / 3
    for (let s = 0; s <= seg; s++) pos.push(s / seg, 0, l, s / seg, 1, l)
    for (let s = 0; s < seg; s++) {
      const a = base + s * 2
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  return fromData(scene, 'wxCurtain', new Float32Array(pos), new Uint32Array(idx))
}

function material(scene: Scene, name: string, shader: keyof typeof RAIN_SHADERS, uniforms: string[], samplers: string[], defines: string[], additive = false): ShaderMaterial {
  registerShaders()
  const mat = new ShaderMaterial(name, scene, shader, {
    attributes: shader === 'sroBolt' ? ['position', 'uv'] : ['position'],
    uniforms: ['viewProjection', ...uniforms],
    samplers,
    defines: defines.map(d => `#define ${d}`),
    needAlphaBlending: true,
    shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  })
  mat.alphaMode = additive ? Constants.ALPHA_ONEONE : Constants.ALPHA_PREMULTIPLIED
  mat.disableDepthWrite = true
  mat.backFaceCulling = false
  return mat
}

/** The shared weather vectors the effects read (weather/index.ts WeatherUniforms). */
export interface RainUniforms {
  wxA: Vector4
  wxB: Vector4
  wxC: Vector4
  wxD: Vector4
  wxF: Vector4
  wxCam: Vector4
  wxOcc: Vector4
  wxOccM: Vector4
}

/** Per-frame inputs besides the frame: colours and the shelter. */
export interface RainEnv {
  /** Streak colour (linear-ish LDR, before the flash): mix(horizon, sun × 0.5, 0.3). */
  color: readonly [number, number, number]
  /** How far a bolt may be drawn (m): inside the fog end. */
  boltMaxM: number
}

export class WeatherRain {
  box: Mesh | null = null
  curtain: Mesh | null = null
  splashes: Mesh | null = null
  drips: Mesh | null = null
  bolt: Mesh | null = null
  private readonly mats: ShaderMaterial[] = []
  private readonly offset = new Vector3(0, 0, 0)
  private readonly p0 = new Vector4(0, 0, 0, 0)
  private readonly p1 = new Vector4(0, -9, 0, 0.55)
  private readonly p2 = new Vector4(40, 24, 40, 0.001)
  private readonly p3 = new Vector4(0.7, 0.72, 0.75, RAIN_ALPHA)
  private readonly dripP0 = new Vector4(0, 0, 0, 0)
  private readonly dripP1 = new Vector4(0, -1, 0, 0.08)
  private readonly dripP2 = new Vector4(16, 1.25, 8, 0.001)
  private readonly splP0 = new Vector4(22, 1.6, 0, SPLASH_CYCLE_S)
  private readonly splP1 = new Vector4(SPLASH_CROWN_M[0], SPLASH_HEIGHT_M[0], 0.001, SPLASH_HALF_M)
  private readonly curP0 = new Vector4(9, 0, 0, 0)
  private readonly boltP = new Vector4(0.8, 0.85, 1, 0)
  private boltArmed = true
  private boltSeed = 1
  private readonly size: [number, number, number]
  private readonly motion: RainMotion = { vel: [0, 0, 0], length: 0 }

  constructor(readonly scene: Scene, readonly preset: Readonly<WeatherPreset>, u: RainUniforms, shelter: { texture: BaseTexture; packed: boolean } | null) {
    this.size = [preset.box[0], preset.box[1], preset.box[2]]
    const shelterDefs = shelter ? ['WX_SHELTER', ...(shelter.packed ? ['WX_OCC8'] : [])] : []
    const shared = ['wxA', 'wxF', 'wxCam', 'wxOcc', 'wxOccM']
    const bind = (mat: ShaderMaterial, names: string[]) => {
      for (const n of names) mat.setVector4(n, u[n as keyof RainUniforms])
      if (shelter && mat.options.samplers?.includes('wxOccMap')) mat.setTexture('wxOccMap', shelter.texture)
      this.mats.push(mat)
      return mat
    }
    if (preset.streaks > 0) {
      const m = bind(material(scene, 'wxRain', 'sroRain', [...shared, 'rainP0', 'rainP1', 'rainP2', 'rainP3'], shelter ? ['wxOccMap'] : [], shelterDefs), shared)
      m.setVector4('rainP0', this.p0)
      m.setVector4('rainP1', this.p1)
      this.p2.set(this.size[0], this.size[1], this.size[2], 0.001)
      m.setVector4('rainP2', this.p2)
      m.setVector4('rainP3', this.p3)
      this.box = quads(scene, 'wxRain', preset.streaks, false)
      this.box.material = m
    }
    if (preset.curtainLayers > 0) {
      const m = bind(material(scene, 'wxCurtain', 'sroCurtain', ['wxCam', 'wxA', 'curP0', 'rainP3'], [], []), ['wxCam', 'wxA'])
      m.setVector4('curP0', this.curP0)
      m.setVector4('rainP3', this.p3)
      this.curtain = cylinder(scene, preset.curtainLayers)
      this.curtain.material = m
      // Sort centre 20 m out: the curtain draws before the box.
      this.curtain.setBoundingInfo(new BoundingInfo(new Vector3(19, -1, -1), new Vector3(21, 1, 1)))
    }
    if (shelter && preset.splashes > 0) {
      const g = Math.ceil(Math.sqrt(preset.splashes * 4 / Math.PI))
      this.splP0.set(g, (SPLASH_RADIUS_M * 2) / g, 0, SPLASH_CYCLE_S)
      const m = bind(material(scene, 'wxSplash', 'sroSplash', [...shared, 'splP0', 'splP1', 'rainP3'], ['wxOccMap'], shelterDefs), shared)
      m.setVector4('splP0', this.splP0)
      m.setVector4('splP1', this.splP1)
      m.setVector4('rainP3', this.p3)
      this.splashes = quads(scene, 'wxSplash', g * g, true)
      this.splashes.material = m
    }
    if (shelter && preset.drips > 0) {
      const g = Math.ceil(Math.sqrt(preset.drips))
      this.dripP2.set(g, DRIP_SQUARE_M / g, 8, 0.001)
      const m = bind(material(scene, 'wxDrip', 'sroRain', [...shared, 'rainP0', 'rainP1', 'rainP2', 'rainP3'], ['wxOccMap'], [...shelterDefs, 'DRIPS']), shared)
      m.setVector4('rainP0', this.dripP0)
      m.setVector4('rainP1', this.dripP1)
      m.setVector4('rainP2', this.dripP2)
      m.setVector4('rainP3', this.p3)
      this.drips = quads(scene, 'wxDrip', g * g, false)
      this.drips.material = m
    }
    if (preset.bolt) {
      const m = bind(material(scene, 'wxBolt', 'sroBolt', ['boltP'], [], [], true), [])
      m.setVector4('boltP', this.boltP)
      const n = BOLT_SEGMENTS + BOLT_FORK
      this.bolt = fromData(scene, 'wxBolt', new Float32Array(n * 12), boltIndices(n), new Float32Array(n * 8))
      this.bolt.material = m
      this.bolt.setEnabled(false)
    }
    for (const mesh of this.meshes()) mesh.setEnabled(false)
  }

  /**
   * Starts the effect of every hidden rain mesh with the defines it will draw with (the scene fog included), so none
   * compiles on the frame it first shows: the bolt is only enabled during a strike (W9F R2: the first strike of a
   * session compiled sroBolt exactly when the flash, thunder and SH jump land), the rain only once it rains. The
   * warm-up renders a few frames, so this lands inside it. Cheap once ready (one cached define check per hidden mesh).
   * WebGPU still builds each pipeline at the first draw.
   */
  private prewarm(): void {
    for (const mesh of this.meshes()) {
      if (mesh.isEnabled(false)) continue
      mesh.material?.isReady(mesh)
    }
  }

  meshes(): Mesh[] {
    return [this.curtain, this.box, this.splashes, this.drips, this.bolt].filter((m): m is Mesh => m !== null)
  }

  /** Streaks drawn now (the count fraction × N). */
  get streaks(): number {
    return this.box ? Math.round(this.preset.streaks * this.p0.w) : 0
  }

  /** Per frame, after the weather vectors: the fall, the counts, the colour, what is visible. */
  update(dt: number, camera: Camera | null, f: Readonly<WeatherFrame>, env: RainEnv): void {
    const rain = Math.max(0, Math.min(1, f.rain))
    const { vel, length } = rainMotion(f, this.motion)
    // The fall integrated on the CPU, wrapped by the box (the shader wraps modulo the same size).
    const size = this.size
    const o = this.offset
    o.x = wrap(o.x + vel[0] * dt, size[0])
    o.y = wrap(o.y + vel[1] * dt, size[1])
    o.z = wrap(o.z + vel[2] * dt, size[2])
    this.p0.set(o.x, o.y, o.z, rain)
    this.p1.set(vel[0], vel[1], vel[2], length)
    const pixel = camera ? pixelAngle(camera) : 0.001
    this.p2.w = pixel
    this.dripP2.w = pixel
    const flash = 1 + Math.max(0, f.flash)
    this.p3.set(env.color[0] * flash, env.color[1] * flash, env.color[2] * flash, RAIN_ALPHA)
    this.curP0.set(-vel[1], vel[0], vel[2], CURTAIN_ALPHA * rain)
    this.splP0.z = rain > 0.1 ? rain : 0
    this.splP1.set(
      SPLASH_CROWN_M[0] + (SPLASH_CROWN_M[1] - SPLASH_CROWN_M[0]) * rain,
      SPLASH_HEIGHT_M[0] + (SPLASH_HEIGHT_M[1] - SPLASH_HEIGHT_M[0]) * rain,
      pixel,
      SPLASH_HALF_M,
    )
    const drip = Math.max(rain, Math.max(0, f.wet) * 0.5)
    this.dripP0.w = drip
    const cam = camera?.globalPosition ?? null
    place(this.box, rain > 0.001, cam)
    place(this.curtain, rain > 0.001, cam)
    place(this.splashes, rain > 0.1, cam)
    place(this.drips, drip > 0.01, cam)
    this.updateBolt(f, cam, env.boltMaxM)
    this.prewarm()
  }

  private updateBolt(f: Readonly<WeatherFrame>, cam: Vector3 | null, maxM: number): void {
    const bolt = this.bolt
    if (!bolt) return
    // a placed strike's bolt is the game's (world/lightning/fx.ts): this camera-relative one stays off for it
    const flash = f.boltOwned ? 0 : Math.max(0, f.flash)
    if (flash < 0.2) this.boltArmed = true
    if (flash >= 1 && this.boltArmed && cam) {
      this.boltArmed = false
      this.buildBolt(cam, f.flashX, f.flashZ, Math.min(maxM, 400))
    }
    const on = !this.boltArmed && flash >= 0.3
    if (bolt.isEnabled() !== on) bolt.setEnabled(on)
    this.boltP.w = Math.min(1, flash / 2)
  }

  /** A jagged ribbon from the cloud base to the ground toward (dx, dz), `dist` metres out, with one fork. */
  private buildBolt(cam: Vector3, dx: number, dz: number, dist: number): void {
    const bolt = this.bolt!
    let s = (this.boltSeed = (this.boltSeed * 1103515245 + 12345) >>> 0)
    const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296 - 0.5)
    const len = Math.hypot(dx, dz) || 1
    const ux = dx / len, uz = dz / len
    const baseX = cam.x + ux * dist, baseZ = cam.z + uz * dist
    const top = cam.y + 250, bottom = cam.y - 20
    const pts: Vector3[] = []
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
      const k = i / BOLT_SEGMENTS
      const j = i === 0 || i === BOLT_SEGMENTS ? 0.3 : 1
      pts.push(new Vector3(baseX + rnd() * 24 * j, top + (bottom - top) * k, baseZ + rnd() * 24 * j))
    }
    const fork: Vector3[] = [pts[4]!.clone()]
    for (let i = 1; i <= BOLT_FORK; i++) {
      const p = fork[i - 1]!
      fork.push(new Vector3(p.x + ux * 10 + rnd() * 16, p.y - 22, p.z + uz * 10 + rnd() * 16))
    }
    const positions = new Float32Array((BOLT_SEGMENTS + BOLT_FORK) * 12)
    const uvs = new Float32Array((BOLT_SEGMENTS + BOLT_FORK) * 8)
    let q = 0
    const ribbon = (a: Vector3, b: Vector3, width: number, fade: number) => {
      const d = b.subtract(a)
      const side = Vector3.Cross(d, cam.subtract(a)).normalize().scaleInPlace(width)
      const v = [a.subtract(side), a.add(side), b.add(side), b.subtract(side)]
      for (let i = 0; i < 4; i++) positions.set([v[i]!.x, v[i]!.y, v[i]!.z], q * 12 + i * 3)
      uvs.set([0, fade, 1, fade, 1, fade, 0, fade], q * 8)
      q++
    }
    for (let i = 0; i < BOLT_SEGMENTS; i++) ribbon(pts[i]!, pts[i + 1]!, 1.6, 1)
    for (let i = 0; i < BOLT_FORK; i++) ribbon(fork[i]!, fork[i + 1]!, 0.9, 0.6 * (1 - i / BOLT_FORK))
    bolt.updateVerticesData('position', positions)
    bolt.updateVerticesData('uv', uvs)
  }

  dispose(): void {
    for (const m of this.meshes()) m.dispose(false, false)
    for (const m of this.mats) m.dispose(true, false)
    this.mats.length = 0
    this.box = this.curtain = this.splashes = this.drips = this.bolt = null
  }
}

const BOLT_SEGMENTS = 11
const BOLT_FORK = 4

function boltIndices(n: number): Uint32Array {
  const idx = new Uint32Array(n * 6)
  for (let i = 0; i < n; i++) {
    const v = i * 4
    idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6)
  }
  return idx
}

/** Shows or hides an effect mesh and keeps its sort centre on the camera. */
function place(m: Mesh | null, on: boolean, cam: Vector3 | null): void {
  if (!m) return
  if (m.isEnabled() !== on) m.setEnabled(on)
  if (on && cam) m.position.copyFrom(cam)
}

function wrap(v: number, size: number): number {
  return size > 0 ? v - size * Math.floor(v / size) : 0
}

/** Radians per pixel of the camera (vertical fov / render height): a streak is at least one pixel wide. */
function pixelAngle(camera: Camera): number {
  const h = camera.getEngine().getRenderHeight() || 1080
  return (camera.fov || 0.8) / h
}
