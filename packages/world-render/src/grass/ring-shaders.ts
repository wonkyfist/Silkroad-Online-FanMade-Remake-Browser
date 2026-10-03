/**
 * The meadow ring's shaders (docs/GRASS_FAR.md §2, ring B; lane P-GRASS-FAR), WGSL for WebGPU and GLSL ES 3.0 for
 * WebGL2, on the grass skeleton (grass/shaders.ts): the same chunk points, uniforms and varyings as the near field, so
 * the sky, weather, night-light and RND-W chunks light the tufts as they light the blades (the material strips only the
 * CSM tap: real-time shadows stay the near ring's, GrassField).
 *
 * Vertex layout (grass/ring.ts): position = (side −1 | 0 | 1, t 0..1 up the blade, kind: 0..2 blade k of the tuft, 3
 * a flower dot (x, y = its diamond corner)); bladeA = (x, z in the 16 m cell, the tuft's density random (a dot's flower
 * random), keep value); bladeB = (height, twist, blade random, colour random). Instance: world3.xz = the cell's corner.
 *
 * Per tuft: the cell's variant (4 rotations × a mirror), the ring window's density (a tuft grows where density > its
 * random, shortening toward the edge), the fade-in (the complement of the near ring's tier-0 cut-off, moved inward by
 * the band noise as the near ring's is), the thinning of the sub-rings with the survivors' growth (coverage kept), the
 * outer cut-off (random per tuft, ± 20 m of 90 m noise), three blades fanned in the plane facing the camera (the side
 * blades shorter and leaning out), the pixel-width floor, the near blades' palette and painted hue patches, and the wind
 * sheen on the tips. Flower dots: a camera-facing diamond in the meadow mask, fading in where the near flowers fade out.
 *
 * Uniforms (vec4 unless noted):
 *   grRing      the ring window's x0, z0 (south-west corner, glTF m), hMin, hRange
 *   grRingLod0  fade-in min, max; B1 → B2 thinning min, max (m from the camera, 2D)
 *   grRingLod1  B2 → B3 thinning min, max; outer cut-off min, max
 *   grRingLod2  dots fade in min, max; fade out min, max
 *   grRingStyle blade base half width (m), keep2, keep3, height scale
 *   grPal       vec4[GRASS_PALETTE_SLOTS × 2]: per palette slot (base, tip), display sRGB 0..1 (the near field's table)
 *   grView      pixel size per metre of distance, the minimum blade width (px), the band noise (m), 0
 *   grWind      wind direction x, z (unit), sheen 0..1 (0: off), time (s; the weather's sway clock)
 * Vertex textures: grRingA (RGBA8 416² at 2 m: density, meadow, palette slot, baked light), grRingH (RGBA8 417²: the
 * 16-bit heights). Fragment: scLightmap = grRingA again (its A, bilinear), scRegion = (x0, lightmap on, z0 + 832, 0).
 */
import type { WorldShaderChunks } from '../shader-chunks.ts'
import { WORLD_SHADER_CHUNKS, type ShaderSources } from '../shaders.ts'
import { RING_OUT_NOISE_M } from './cull.ts'
import { GRASS_RING_HEIGHT_GRID, GRASS_RING_TEXELS, GRASS_RING_WINDOW_M } from './ring-window.ts'
import { GRASS_BAND_FREQ, GRASS_PALETTE_SLOTS, grassHeightFn, grassSkeleton, type GrassSkeletonParts } from './shaders.ts'

export const GRASS_RING_FIELD_SAMPLER = 'grRingA'
export const GRASS_RING_HEIGHT_SAMPLER = 'grRingH'
export const GRASS_RING_SHADER = 'sroGrassRing'

/** The wind sheen (GRASS_FAR §4.3): the tips (and the far carpet, grass/chunks.ts) brighten this much in a gust's crest. */
export const GRASS_SHEEN_GAIN = '1.18, 1.16, 1.05'
export const GRASS_SHEEN_SHARE = 0.55

type Decl = { name: string; wgsl: string; glsl: string }

export const GRASS_RING_UNIFORMS: readonly Decl[] = [
  { name: 'grRing', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grRingLod0', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grRingLod1', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grRingLod2', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grRingStyle', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grPal', wgsl: `array<vec4f, ${GRASS_PALETTE_SLOTS * 2}>`, glsl: `vec4[${GRASS_PALETTE_SLOTS * 2}]` },
  { name: 'grView', wgsl: 'vec4f', glsl: 'vec4' },
  { name: 'grWind', wgsl: 'vec4f', glsl: 'vec4' },
]

const RING_HEIGHT = grassHeightFn('grRingHeightAt', GRASS_RING_HEIGHT_SAMPLER, 'grRing', GRASS_RING_HEIGHT_GRID)
const OUT2 = `${2 * RING_OUT_NOISE_M}.0`
const SHEEN = GRASS_SHEEN_SHARE.toFixed(2)

const RING_BODY_WGSL = /* wgsl */ `
  let cell = finalWorld[3].xz;
  let cellH = grHash12(cell * 0.173 + vec2f(3.1, 7.7));
  var lp = vertexInputs.bladeA.xy - vec2f(8.0);
  if (cellH > 0.5) {
    lp = vec2f(-lp.x, lp.y);
  }
  let rq = floor(fract(cellH * 7.31) * 4.0);
  if (rq > 2.5) {
    lp = vec2f(lp.y, -lp.x);
  } else if (rq > 1.5) {
    lp = -lp;
  } else if (rq > 0.5) {
    lp = vec2f(-lp.y, lp.x);
  }
  let rxz = cell + vec2f(8.0) + lp;
  let fp = rxz - uniforms.grRing.xy;
  let fa = textureLoad(grRingA, clamp(vec2i(floor(fp * 0.5)), vec2i(0), vec2i(${GRASS_RING_TEXELS - 1})), 0);
  let dens = fa.r;
  let crand = vertexInputs.bladeA.z;
  let riKeep = vertexInputs.bladeA.w;
  let kind = vertexInputs.position.z;
  let root = vec3f(rxz.x, grRingHeightAt(fp), rxz.y);
  let camD = distance(uniforms.scCamera.xz, rxz);
  let riBand = grNoise(rxz * ${GRASS_BAND_FREQ}) * uniforms.grView.z;
  let riIn = mix(uniforms.grRingLod0.x, uniforms.grRingLod0.y, fract(crand * 13.7)) - riBand;
  let riFin = smoothstep(riIn - 6.0, riIn, camD);
  let riT1 = mix(uniforms.grRingLod0.z, uniforms.grRingLod0.w, fract(riKeep * 7.13 + crand * 3.1));
  let riT2 = mix(uniforms.grRingLod1.x, uniforms.grRingLod1.y, fract(riKeep * 5.71 + crand * 1.7));
  var riThin = 1.0;
  if (riKeep >= uniforms.grRingStyle.y) {
    riThin = 1.0 - smoothstep(riT1 - 6.0, riT1, camD);
  } else if (riKeep >= uniforms.grRingStyle.z) {
    riThin = 1.0 - smoothstep(riT2 - 8.0, riT2, camD);
  }
  let riG1 = clamp((camD - uniforms.grRingLod0.z + 3.0) / max(uniforms.grRingLod0.w - uniforms.grRingLod0.z, 1.0), 0.0, 1.0);
  let riG2 = clamp((camD - uniforms.grRingLod1.x + 4.0) / max(uniforms.grRingLod1.y - uniforms.grRingLod1.x, 1.0), 0.0, 1.0);
  let riShare = 1.0 - (1.0 - uniforms.grRingStyle.y) * riG1 - (uniforms.grRingStyle.y - uniforms.grRingStyle.z) * riG2;
  let riGrow = inverseSqrt(max(riShare, uniforms.grRingStyle.z));
  let riOn = grNoise(rxz * 0.011 + vec2f(5.3, 1.9));
  let riCut = mix(uniforms.grRingLod1.z, uniforms.grRingLod1.w, fract(crand * 3.7 + riKeep * 5.3)) + (riOn - 0.5) * ${OUT2};
  let riFout = 1.0 - smoothstep(riCut - 12.0, riCut, camD);
  let edge = smoothstep(0.0, 0.3, dens - crand * 0.999);
  let r1 = vertexInputs.bladeB.x;
  let toCam = normalize(uniforms.scCamera.xz - rxz + vec2f(0.0001));
  let pi = min(i32(fa.b * 255.0 + 0.5), ${GRASS_PALETTE_SLOTS - 1});
  let n1 = grNoise(rxz * 0.075);
  let n2 = grNoise(rxz * 0.021 + vec2f(17.0, 3.0));
  var base = uniforms.grPal[pi * 2].rgb;
  var tip = uniforms.grPal[pi * 2 + 1].rgb;
  let hue = mix(vec3f(0.86, 1.02, 1.08), vec3f(1.12, 1.06, 0.78), smoothstep(0.25, 0.75, n1 * 0.6 + n2 * 0.4));
  tip = tip * hue * (0.92 + 0.16 * vertexInputs.bladeB.w);
  base = base * mix(vec3f(1.0), hue, 0.5);
  if (vertexInputs.bladeB.w > 0.985) {
    tip = vec3f(0.62, 0.55, 0.30);
    base = vec3f(0.36, 0.32, 0.16);
  }
  let riWv = sin(dot(rxz, uniforms.grWind.xy) * 0.35 - uniforms.grWind.w * 2.1 + (n1 - 0.5) * 2.0);
  let riSw = sin(dot(rxz, uniforms.grWind.xy) * 0.08 - uniforms.grWind.w * 0.75 + n2 * 3.0);
  let riSheen = (smoothstep(0.2, 1.0, riWv) * 0.6 + smoothstep(0.4, 1.0, riSw) * 0.4) * uniforms.grWind.z;
  tip = mix(tip, tip * vec3f(${GRASS_SHEEN_GAIN}) + vec3f(0.01), riSheen * ${SHEEN});
  let riPx = distance(uniforms.scCamera.xyz, root) * uniforms.grView.x;
  var p = root;
  var wp = root;
  var h = 0.0;
  let s = 1.0;
  if (kind < 2.5) {
    let k = kind - 1.0;
    let H = mix(0.32, 0.68, r1) * mix(0.55, 1.0, dens) * mix(1.0, 0.74, abs(k)) * (0.85 + 0.3 * vertexInputs.bladeB.z) * edge * riFin * riThin * riFout * sqrt(riGrow) * uniforms.grRingStyle.w;
    let W = max(uniforms.grRingStyle.x * (0.8 + 0.4 * vertexInputs.bladeB.w) * riGrow, riPx * uniforms.grView.y) * step(0.0001, H);
    let tw = (vertexInputs.bladeB.y - 0.5) * 0.7;
    let fdir = normalize(toCam + vec2f(-toCam.y, toCam.x) * tw);
    let sd = vec2f(-fdir.y, fdir.x);
    let bt = vertexInputs.position.y;
    let spread = 0.1 * riGrow * (0.7 + 0.6 * vertexInputs.bladeB.z);
    let yaw = vertexInputs.bladeB.z * 6.2831853;
    let lean = (sd * (k * 0.4) + vec2f(cos(yaw), sin(yaw)) * 0.12) * (H * bt * bt);
    let o = k * spread + W * (1.0 - bt) * vertexInputs.position.x;
    p = vec3f(root.x + sd.x * o + lean.x, root.y + bt * H, root.z + sd.y * o + lean.y);
    vertexOutputs.vCol = mix(base, tip, pow(bt, 0.8));
    vertexOutputs.vShade = mix(0.5, 1.0, pow(bt, 0.6));
  } else {
    let dIn = mix(uniforms.grRingLod2.x, uniforms.grRingLod2.y, fract(crand * 9.1));
    let dOut = mix(uniforms.grRingLod2.z, uniforms.grRingLod2.w, fract(crand * 5.3));
    let fl = step(crand, fa.g * 1.4) * step(0.001, dens) * smoothstep(dIn - 3.0, dIn, camD) * (1.0 - smoothstep(dOut - 10.0, dOut, camD)) * riThin;
    let HF = mix(0.36, 0.58, r1) * mix(0.55, 1.0, dens) * uniforms.grRingStyle.w;
    let top = root + vec3f(0.0, HF, 0.0);
    let n = normalize(vec3f(toCam.x, 1.4, toCam.y));
    let u = normalize(cross(n, vec3f(0.3, 0.0, 1.0)));
    let v = cross(n, u);
    let R = max(mix(0.06, 0.09, vertexInputs.bladeB.z), riPx * 0.8) * fl;
    p = top + (u * vertexInputs.position.x + v * vertexInputs.position.y) * R;
    let fcol = floor(fract(vertexInputs.bladeB.w * 7.3) * 5.0);
    var petal = vec3f(0.95, 0.93, 0.86);
    if (fcol > 3.5) {
      petal = vec3f(0.86, 0.22, 0.16);
    } else if (fcol > 2.5) {
      petal = vec3f(0.95, 0.55, 0.66);
    } else if (fcol > 1.5) {
      petal = vec3f(0.66, 0.50, 0.86);
    } else if (fcol > 0.5) {
      petal = vec3f(0.98, 0.80, 0.22);
    }
    vertexOutputs.vCol = petal;
    vertexOutputs.vShade = 1.0;
  }
  wp = p;
  h = max(p.y - root.y, 0.0);
`

const RING_BODY_GLSL = /* glsl */ `
  vec2 cell = finalWorld[3].xz;
  float cellH = grHash12(cell * 0.173 + vec2(3.1, 7.7));
  vec2 lp = bladeA.xy - vec2(8.0);
  if (cellH > 0.5) lp = vec2(-lp.x, lp.y);
  float rq = floor(fract(cellH * 7.31) * 4.0);
  if (rq > 2.5) lp = vec2(lp.y, -lp.x);
  else if (rq > 1.5) lp = -lp;
  else if (rq > 0.5) lp = vec2(-lp.y, lp.x);
  vec2 rxz = cell + vec2(8.0) + lp;
  vec2 fp = rxz - grRing.xy;
  vec4 fa = texelFetch(grRingA, clamp(ivec2(floor(fp * 0.5)), ivec2(0), ivec2(${GRASS_RING_TEXELS - 1})), 0);
  float dens = fa.r;
  float crand = bladeA.z;
  float riKeep = bladeA.w;
  float kind = position.z;
  vec3 root = vec3(rxz.x, grRingHeightAt(fp), rxz.y);
  float camD = distance(scCamera.xz, rxz);
  float riBand = grNoise(rxz * ${GRASS_BAND_FREQ}) * grView.z;
  float riIn = mix(grRingLod0.x, grRingLod0.y, fract(crand * 13.7)) - riBand;
  float riFin = smoothstep(riIn - 6.0, riIn, camD);
  float riT1 = mix(grRingLod0.z, grRingLod0.w, fract(riKeep * 7.13 + crand * 3.1));
  float riT2 = mix(grRingLod1.x, grRingLod1.y, fract(riKeep * 5.71 + crand * 1.7));
  float riThin = 1.0;
  if (riKeep >= grRingStyle.y) riThin = 1.0 - smoothstep(riT1 - 6.0, riT1, camD);
  else if (riKeep >= grRingStyle.z) riThin = 1.0 - smoothstep(riT2 - 8.0, riT2, camD);
  float riG1 = clamp((camD - grRingLod0.z + 3.0) / max(grRingLod0.w - grRingLod0.z, 1.0), 0.0, 1.0);
  float riG2 = clamp((camD - grRingLod1.x + 4.0) / max(grRingLod1.y - grRingLod1.x, 1.0), 0.0, 1.0);
  float riShare = 1.0 - (1.0 - grRingStyle.y) * riG1 - (grRingStyle.y - grRingStyle.z) * riG2;
  float riGrow = inversesqrt(max(riShare, grRingStyle.z));
  float riOn = grNoise(rxz * 0.011 + vec2(5.3, 1.9));
  float riCut = mix(grRingLod1.z, grRingLod1.w, fract(crand * 3.7 + riKeep * 5.3)) + (riOn - 0.5) * ${OUT2};
  float riFout = 1.0 - smoothstep(riCut - 12.0, riCut, camD);
  float edge = smoothstep(0.0, 0.3, dens - crand * 0.999);
  float r1 = bladeB.x;
  vec2 toCam = normalize(scCamera.xz - rxz + vec2(0.0001));
  int pi = min(int(fa.b * 255.0 + 0.5), ${GRASS_PALETTE_SLOTS - 1});
  float n1 = grNoise(rxz * 0.075);
  float n2 = grNoise(rxz * 0.021 + vec2(17.0, 3.0));
  vec3 base = grPal[pi * 2].rgb;
  vec3 tip = grPal[pi * 2 + 1].rgb;
  vec3 hue = mix(vec3(0.86, 1.02, 1.08), vec3(1.12, 1.06, 0.78), smoothstep(0.25, 0.75, n1 * 0.6 + n2 * 0.4));
  tip *= hue * (0.92 + 0.16 * bladeB.w);
  base *= mix(vec3(1.0), hue, 0.5);
  if (bladeB.w > 0.985) {
    tip = vec3(0.62, 0.55, 0.30);
    base = vec3(0.36, 0.32, 0.16);
  }
  float riWv = sin(dot(rxz, grWind.xy) * 0.35 - grWind.w * 2.1 + (n1 - 0.5) * 2.0);
  float riSw = sin(dot(rxz, grWind.xy) * 0.08 - grWind.w * 0.75 + n2 * 3.0);
  float riSheen = (smoothstep(0.2, 1.0, riWv) * 0.6 + smoothstep(0.4, 1.0, riSw) * 0.4) * grWind.z;
  tip = mix(tip, tip * vec3(${GRASS_SHEEN_GAIN}) + vec3(0.01), riSheen * ${SHEEN});
  float riPx = distance(scCamera.xyz, root) * grView.x;
  vec3 p = root;
  vec3 wp = root;
  float h = 0.0;
  float s = 1.0;
  if (kind < 2.5) {
    float k = kind - 1.0;
    float H = mix(0.32, 0.68, r1) * mix(0.55, 1.0, dens) * mix(1.0, 0.74, abs(k)) * (0.85 + 0.3 * bladeB.z) * edge * riFin * riThin * riFout * sqrt(riGrow) * grRingStyle.w;
    float W = max(grRingStyle.x * (0.8 + 0.4 * bladeB.w) * riGrow, riPx * grView.y) * step(0.0001, H);
    float tw = (bladeB.y - 0.5) * 0.7;
    vec2 fdir = normalize(toCam + vec2(-toCam.y, toCam.x) * tw);
    vec2 sd = vec2(-fdir.y, fdir.x);
    float bt = position.y;
    float spread = 0.1 * riGrow * (0.7 + 0.6 * bladeB.z);
    float yaw = bladeB.z * 6.2831853;
    vec2 lean = (sd * (k * 0.4) + vec2(cos(yaw), sin(yaw)) * 0.12) * (H * bt * bt);
    float o = k * spread + W * (1.0 - bt) * position.x;
    p = vec3(root.x + sd.x * o + lean.x, root.y + bt * H, root.z + sd.y * o + lean.y);
    vCol = mix(base, tip, pow(bt, 0.8));
    vShade = mix(0.5, 1.0, pow(bt, 0.6));
  } else {
    float dIn = mix(grRingLod2.x, grRingLod2.y, fract(crand * 9.1));
    float dOut = mix(grRingLod2.z, grRingLod2.w, fract(crand * 5.3));
    float fl = step(crand, fa.g * 1.4) * step(0.001, dens) * smoothstep(dIn - 3.0, dIn, camD) * (1.0 - smoothstep(dOut - 10.0, dOut, camD)) * riThin;
    float HF = mix(0.36, 0.58, r1) * mix(0.55, 1.0, dens) * grRingStyle.w;
    vec3 top = root + vec3(0.0, HF, 0.0);
    vec3 n = normalize(vec3(toCam.x, 1.4, toCam.y));
    vec3 u = normalize(cross(n, vec3(0.3, 0.0, 1.0)));
    vec3 v = cross(n, u);
    float R = max(mix(0.06, 0.09, bladeB.z), riPx * 0.8) * fl;
    p = top + (u * position.x + v * position.y) * R;
    float fcol = floor(fract(bladeB.w * 7.3) * 5.0);
    vCol = fcol > 3.5 ? vec3(0.86, 0.22, 0.16) : fcol > 2.5 ? vec3(0.95, 0.55, 0.66) : fcol > 1.5 ? vec3(0.66, 0.50, 0.86) : fcol > 0.5 ? vec3(0.98, 0.80, 0.22) : vec3(0.95, 0.93, 0.86);
    vShade = 1.0;
  }
  wp = p;
  h = max(p.y - root.y, 0.0);
`

export const GRASS_RING_PARTS: GrassSkeletonParts = {
  attributes: [
    { name: 'bladeA', wgsl: 'vec4f', glsl: 'vec4' },
    { name: 'bladeB', wgsl: 'vec4f', glsl: 'vec4' },
  ],
  uniforms: GRASS_RING_UNIFORMS,
  vertexTextures: [GRASS_RING_FIELD_SAMPLER, GRASS_RING_HEIGHT_SAMPLER],
  varyings: [],
  sway: true,
  vertexFns: RING_HEIGHT,
  vertexBody: { wgsl: RING_BODY_WGSL, glsl: RING_BODY_GLSL },
  fragmentBody: {
    wgsl: '  let c = vec4f(fragmentInputs.vCol, 1.0);\n',
    glsl: '  vec4 c = vec4(vCol, 1.0);\n',
  },
}

/** The meadow ring's shaders with `lanes`' chunks (tests pass their own; the field uses WORLD_SHADER_CHUNKS). */
export function grassRingShaders(lanes: readonly WorldShaderChunks[] = WORLD_SHADER_CHUNKS): ShaderSources {
  return grassSkeleton(GRASS_RING_PARTS, lanes, GRASS_RING_WINDOW_M)
}

// ---- TS twins (tests) ------------------------------------------------------------------------------------------------

/** The value noise both the shaders and the terrain tint use (grNoise / sroGtNoise), in doubles. */
export function grassNoise(x: number, z: number): number {
  const fract = (v: number) => v - Math.floor(v)
  const hash = (qx: number, qz: number) => {
    const rx = fract(qx * 0.1031), rz = fract(qz * 0.103)
    const d = rx * (rz + 33.33) + rz * (rx + 33.33)
    const dx = rx + d, dz = rz + d
    return fract((dx + dz) * dx)
  }
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz)
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1)
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz
}

/**
 * A tuft's visibility at distance `d` as the vertex shader computes it (fade-in × sub-ring thinning × outer cut-off),
 * before the density test; `band` = the band noise there (m), `outNoise` = the outer noise value 0..1.
 */
export function ringTuftVisible(ring: { in: readonly [number, number]; thin1: readonly [number, number]; thin2: readonly [number, number]; out: readonly [number, number]; keep2: number; keep3: number },
  crand: number, keep: number, d: number, band = 0, outNoise = 0.5): number {
  const fract = (v: number) => v - Math.floor(v)
  const ss = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  const aIn = ring.in[0] + (ring.in[1] - ring.in[0]) * fract(crand * 13.7) - band
  const fin = ss(aIn - 6, aIn, d)
  const t1 = ring.thin1[0] + (ring.thin1[1] - ring.thin1[0]) * fract(keep * 7.13 + crand * 3.1)
  const t2 = ring.thin2[0] + (ring.thin2[1] - ring.thin2[0]) * fract(keep * 5.71 + crand * 1.7)
  const thin = keep >= ring.keep2 ? 1 - ss(t1 - 6, t1, d) : keep >= ring.keep3 ? 1 - ss(t2 - 8, t2, d) : 1
  const cut = ring.out[0] + (ring.out[1] - ring.out[0]) * fract(crand * 3.7 + keep * 5.3) + (outNoise - 0.5) * 2 * RING_OUT_NOISE_M
  const fout = 1 - ss(cut - 12, cut, d)
  return fin * thin * fout
}
