/**
 * The wildlife's shaders (docs/GRASS_LIFE.md §5.2–§5.5; lane GL-S), WGSL and GLSL ES 3.0, and the vertex layouts of
 * the three meshes GL-L draws (one mesh and one draw per kind). Ported from the prototype
 * (work/tmp/grass-life/lab/grass-shaders.ts), with the dragonflies (§5.5), per-species bird colours and HDR fireflies
 * added.
 *
 * The critters (butterflies and dragonflies) and the birds are built on the grass skeleton (grass/shaders.ts
 * `grassSkeleton`), so the sky, weather, night-light and RND-W chunks light them with no plumbing of their own; their
 * materials follow WorldScatter through `adopt` like the grass. The critters add one varying (`vUV2`, the wing
 * coordinates: the retail grass's count + 1); the birds add none. The fireflies are additive glow billboards with a
 * shader of their own (no chunks, no fog: they are light).
 *
 * Every material also binds, like the grass: `scLightmap` (the grass window texture, whose A channel is the baked
 * light, or any white texture), `scRegion` (the grass field's `regionVector`, or (x0, 0, z0 + 256, 0)) and `scTint`
 * (1, 1, 1, 0.5).
 *
 * **Critters** (`LIFE_CRITTER_SHADER`, attributes `position`): one instance per animal, the vertex shader flies it.
 *   position   (wing side −1 | +1, or 0 for the body; span 0..1 along the wing (body −1..1); chord −1..1)
 *   world0     (seed 0..1, species, wander radius m, 0)          world3   the anchor (x, y, z, 1), glTF m
 *   species    0 monarch (orange), 1 cabbage white, 2 brimstone, 3 blue: butterflies (two incommensurate loops
 *              around the anchor, a bob, a sit on a flower every ~14 s, flapping 15 Hz in flight and 2 Hz sitting);
 *              4 blue hawker, 5 red darter: dragonflies (dart-and-hover over the anchor, 0.3–1.2 m above
 *              max(anchor y, ground): the anchor's y is the water surface)
 *   grField    the grass field's window vector (x0, z0, hMin, hRange); hRange 0 = no field: the ground is anchor y
 *   crDay      x activity 0..1 (0 hides every critter: the scale goes to 0), y butterfly scale (2.2, X11),
 *              z dragonfly scale, w unused
 *   grFieldH   the grass field's height texture (any 1 × 1 texture with hRange 0)
 * **Birds** (`LIFE_BIRD_SHADER`, attributes `position`, `bladeA`): the CPU flies them (GL-L's flocks).
 *   position   bird space (x across the span −1..1 m at scale 1, y up, z forward); bladeA.x wing weight (0 body,
 *              1 inner wing, 2 outer wing), bladeA.y shade (0 back → 1 belly: the dark → light colour)
 *   world0     (forward xyz, flap phase rad)   world1 (bank rad, fold 0..1, scale, flap amplitude rad)
 *   world2     (dark colour, light colour) packed as r·65536 + g·256 + b (0..255, display sRGB; `packRgb`), 0, 0;
 *              both 0 = the prototype's sparrow
 *   world3     the bird's position (x, y, z, 1)
 * **Fireflies** (`LIFE_FIREFLY_SHADER`, attributes `position`; additive, no depth write):
 *   position   the quad corner (−1..1, −1..1, 0)            world0   (seed, 0, 0, 0)     world3   the anchor
 *   ffParams   x visibility 0..1, y size (m), z gain (display units at the post stack's exposure: × rgMisc.z =
 *              1 / exposure, the night-light rule; ≈ 6 matches the prototype's look at night), w unused
 */
import { Constants, ShaderLanguage, ShaderMaterial, type Scene } from '@babylonjs/core'
import {
  GRASS_HEIGHT_GLSL,
  GRASS_HEIGHT_SAMPLER,
  GRASS_HEIGHT_WGSL,
  grassSkeleton,
  registerSkeletonShader,
  type GrassSkeletonParts,
} from '../grass/shaders.ts'
import type { WorldShaderChunks } from '../shader-chunks.ts'
import { WORLD_SHADER_CHUNKS, type ShaderSources } from '../shaders.ts'

export const LIFE_CRITTER_SHADER = 'sroLifeCritter'
export const LIFE_BIRD_SHADER = 'sroLifeBird'
export const LIFE_FIREFLY_SHADER = 'sroLifeFirefly'

/** Critter species ids (world0.y). */
export const CRITTER_SPECIES = { monarch: 0, cabbageWhite: 1, brimstone: 2, blue: 3, blueHawker: 4, redDarter: 5 } as const
/** Species ids from this one up are dragonflies. */
export const DRAGONFLY_FIRST_SPECIES = 4
/** The butterflies' default scale (GRASS_LIFE X11: 2.2× life size, so they read at game distances). */
export const BUTTERFLY_SCALE = 2.2
export const DRAGONFLY_SCALE = 1.4

// ---- critters (butterflies, dragonflies) ------------------------------------------------------------------------------

const CRITTER_FNS_WGSL = `${GRASS_HEIGHT_WGSL}fn lfDart(k: f32, seed: f32) -> vec2f {
  let a = vec2f(grHash12(vec2f(k, seed * 97.0)), grHash12(vec2f(k + 7.1, seed * 61.0))) * 2.0 - vec2f(1.0);
  return a / max(1.0, length(a));
}
`
const CRITTER_FNS_GLSL = `${GRASS_HEIGHT_GLSL}vec2 lfDart(float k, float seed) {
  vec2 a = vec2(grHash12(vec2(k, seed * 97.0)), grHash12(vec2(k + 7.1, seed * 61.0))) * 2.0 - vec2(1.0);
  return a / max(1.0, length(a));
}
`

const CRITTER_BODY_WGSL = /* wgsl */ `
  let seed = finalWorld[0].x;
  let species = finalWorld[0].y;
  let rad = finalWorld[0].z;
  let anchor = finalWorld[3].xyz;
  let dragon = species > ${DRAGONFLY_FIRST_SPECIES - 0.5};
  // Butterflies: two incommensurate loops (clamped to the wander radius), a bob, a sit on a flower every ~14 s.
  let T = t * 0.55 + seed * 97.0;
  let cyc = fract(T / 7.7 + seed);
  var sit = smoothstep(0.78, 0.84, cyc) * (1.0 - smoothstep(0.96, 1.0, cyc));
  var wan = vec2f(sin(T * 0.61 + seed * 6.0) + 0.5 * sin(T * 1.37 + seed * 3.0), cos(T * 0.47 + seed * 5.0) + 0.5 * sin(T * 1.13 + seed)) * rad * 0.6;
  wan = wan / max(1.0, length(wan) / max(rad, 0.001));
  var vel = vec2f(0.61 * cos(T * 0.61 + seed * 6.0) + 0.685 * cos(T * 1.37 + seed * 3.0), -0.47 * sin(T * 0.47 + seed * 5.0) + 0.565 * cos(T * 1.13 + seed));
  var lift = 0.45 + 0.7 * abs(sin(T * 0.9 + seed * 4.0)) + 0.08 * sin(T * 11.0);
  var flap = sin(t * mix(15.0, 2.0, sit) + seed * 20.0) * 1.15 + 0.25;
  flap = mix(flap, 0.9 + 0.35 * sin(t * 1.3 + seed), sit);
  // Dragonflies: hover, then dart 1–3 m to the next point (a new point every ~1.1 s), 0.3–1.2 m up.
  let DT = t * 0.9 + seed * 53.0;
  let dk = floor(DT);
  let dm = smoothstep(0.72, 0.9, fract(DT));
  let d0 = lfDart(dk, seed) * rad;
  let d1 = lfDart(dk + 1.0, seed) * rad;
  if (dragon) {
    sit = 0.0;
    wan = mix(d0, d1, dm);
    vel = d1 - d0;
    lift = mix(0.3 + 0.9 * grHash12(vec2f(dk, seed)), 0.3 + 0.9 * grHash12(vec2f(dk + 1.0, seed)), dm) + 0.03 * sin(t * 9.0 + seed * 11.0);
    flap = sin(t * 38.0 + seed * 20.0) * 0.3 + 0.1;
  }
  vel = normalize(vel + vec2f(0.0001));
  let xz = anchor.xz + wan;
  var gy = anchor.y;
  if (uniforms.grField.w > 0.0) {
    gy = grHeightAt(xz - uniforms.grField.xy);
  }
  if (dragon) {
    gy = max(anchor.y, gy);
  }
  let root = vec3f(xz.x, gy + mix(lift, 0.5, sit), xz.y);
  let side = vertexInputs.position.x;
  let span = vertexInputs.position.y;
  let chord = vertexInputs.position.z;
  var sc = uniforms.crDay.y;
  var wingL = 0.055;
  var wingC = 0.04;
  var bodyL = 0.03;
  if (dragon) {
    sc = uniforms.crDay.z;
    wingL = 0.05;
    wingC = 0.028;
    bodyL = 0.07;
  }
  sc = sc * uniforms.crDay.x * (0.8 + 0.4 * fract(seed * 3.7));
  let fwd = vec3f(vel.x, 0.0, vel.y);
  let rt = vec3f(-vel.y, 0.0, vel.x);
  let ang = flap * side;
  let wingDir = rt * cos(ang) * side + vec3f(0.0, sin(abs(ang)), 0.0);
  var p = root + (wingDir * span * wingL + fwd * chord * wingC) * sc;
  var spc = species;
  if (abs(side) < 0.5) {
    p = root + (fwd * chord * bodyL + vec3f(0.0, span * 0.006, 0.0)) * sc;
    spc = species + 10.0;
  }
  let wp = p;
  let h = 0.5;
  let s = 1.0;
  vertexOutputs.vUV2 = vec3f(span, chord, spc);
  vertexOutputs.vCol = vec3f(1.0);
  vertexOutputs.vShade = 1.0;
`
const CRITTER_BODY_GLSL = /* glsl */ `
  float seed = finalWorld[0].x;
  float species = finalWorld[0].y;
  float rad = finalWorld[0].z;
  vec3 anchor = finalWorld[3].xyz;
  bool dragon = species > ${DRAGONFLY_FIRST_SPECIES - 0.5};
  float T = t * 0.55 + seed * 97.0;
  float cyc = fract(T / 7.7 + seed);
  float sit = smoothstep(0.78, 0.84, cyc) * (1.0 - smoothstep(0.96, 1.0, cyc));
  vec2 wan = vec2(sin(T * 0.61 + seed * 6.0) + 0.5 * sin(T * 1.37 + seed * 3.0), cos(T * 0.47 + seed * 5.0) + 0.5 * sin(T * 1.13 + seed)) * rad * 0.6;
  wan = wan / max(1.0, length(wan) / max(rad, 0.001));
  vec2 vel = vec2(0.61 * cos(T * 0.61 + seed * 6.0) + 0.685 * cos(T * 1.37 + seed * 3.0), -0.47 * sin(T * 0.47 + seed * 5.0) + 0.565 * cos(T * 1.13 + seed));
  float lift = 0.45 + 0.7 * abs(sin(T * 0.9 + seed * 4.0)) + 0.08 * sin(T * 11.0);
  float flap = sin(t * mix(15.0, 2.0, sit) + seed * 20.0) * 1.15 + 0.25;
  flap = mix(flap, 0.9 + 0.35 * sin(t * 1.3 + seed), sit);
  float DT = t * 0.9 + seed * 53.0;
  float dk = floor(DT);
  float dm = smoothstep(0.72, 0.9, fract(DT));
  vec2 d0 = lfDart(dk, seed) * rad;
  vec2 d1 = lfDart(dk + 1.0, seed) * rad;
  if (dragon) {
    sit = 0.0;
    wan = mix(d0, d1, dm);
    vel = d1 - d0;
    lift = mix(0.3 + 0.9 * grHash12(vec2(dk, seed)), 0.3 + 0.9 * grHash12(vec2(dk + 1.0, seed)), dm) + 0.03 * sin(t * 9.0 + seed * 11.0);
    flap = sin(t * 38.0 + seed * 20.0) * 0.3 + 0.1;
  }
  vel = normalize(vel + vec2(0.0001));
  vec2 xz = anchor.xz + wan;
  float gy = anchor.y;
  if (grField.w > 0.0) gy = grHeightAt(xz - grField.xy);
  if (dragon) gy = max(anchor.y, gy);
  vec3 root = vec3(xz.x, gy + mix(lift, 0.5, sit), xz.y);
  float side = position.x;
  float span = position.y;
  float chord = position.z;
  float sc = dragon ? crDay.z : crDay.y;
  float wingL = dragon ? 0.05 : 0.055;
  float wingC = dragon ? 0.028 : 0.04;
  float bodyL = dragon ? 0.07 : 0.03;
  sc *= crDay.x * (0.8 + 0.4 * fract(seed * 3.7));
  vec3 fwd = vec3(vel.x, 0.0, vel.y);
  vec3 rt = vec3(-vel.y, 0.0, vel.x);
  float ang = flap * side;
  vec3 wingDir = rt * cos(ang) * side + vec3(0.0, sin(abs(ang)), 0.0);
  vec3 p = root + (wingDir * span * wingL + fwd * chord * wingC) * sc;
  float spc = species;
  if (abs(side) < 0.5) {
    p = root + (fwd * chord * bodyL + vec3(0.0, span * 0.006, 0.0)) * sc;
    spc = species + 10.0;
  }
  vec3 wp = p;
  float h = 0.5;
  float s = 1.0;
  vUV2 = vec3(span, chord, spc);
  vCol = vec3(1.0);
  vShade = 1.0;
`

// Wings: butterflies a rounded fore and hind wing with a dark border and a pale spot (4 species); dragonflies two narrow
// pale wings per side with a dark stigma. Bodies (species + 10): a slim dark ellipse (a metallic blue or red abdomen for
// the dragonflies).
const CRITTER_FRAG_WGSL = /* wgsl */ `
  let wu = fragmentInputs.vUV2.x;
  let wv = fragmentInputs.vUV2.y;
  let spc = fragmentInputs.vUV2.z;
  var col = vec3f(0.08, 0.06, 0.05);
  if (spc > 9.5) {
    if (length(vec2f(wu, wv)) > 1.0) {
      discard;
    }
    if (spc > 14.5) {
      col = vec3f(0.62, 0.12, 0.08);
    } else if (spc > 13.5) {
      col = vec3f(0.10, 0.32, 0.62);
    }
  } else if (spc > ${DRAGONFLY_FIRST_SPECIES - 0.5}) {
    let fore = length(vec2f((wu - 0.52) / 0.5, (wv - 0.42) / 0.3));
    let hind = length(vec2f((wu - 0.48) / 0.48, (wv + 0.42) / 0.34));
    let m = min(fore, hind);
    if (m > 1.0) {
      discard;
    }
    let stigma = (1.0 - step(0.08, abs(wu - 0.86))) * step(0.2, abs(wv));
    col = mix(vec3f(0.80, 0.86, 0.90), vec3f(0.30, 0.34, 0.38), max(smoothstep(0.8, 0.95, m), stigma));
  } else {
    let fore = length(vec2f((wu - 0.55) / 0.55, (wv - 0.35) / 0.65));
    let hind = length(vec2f((wu - 0.4) / 0.42, (wv + 0.45) / 0.55));
    let m = min(fore, hind);
    if (m > 1.0) {
      discard;
    }
    var wc = vec3f(0.96, 0.52, 0.10);
    if (spc > 2.5) {
      wc = vec3f(0.35, 0.55, 0.95);
    } else if (spc > 1.5) {
      wc = vec3f(0.98, 0.88, 0.30);
    } else if (spc > 0.5) {
      wc = vec3f(0.95, 0.95, 0.90);
    }
    let border = smoothstep(0.72, 0.8, m);
    let spot = 1.0 - smoothstep(0.08, 0.11, length(vec2f(wu - 0.8, wv - 0.5)));
    let wroot = 1.0 - step(0.06, wu);
    col = mix(wc, vec3f(0.08, 0.06, 0.05), max(border * select(0.85, 0.25, spc > 0.5 && spc < 1.5), wroot));
    col = mix(col, vec3f(0.95), spot * 0.8);
  }
  let c = vec4f(col, 1.0);
`
const CRITTER_FRAG_GLSL = /* glsl */ `
  float wu = vUV2.x;
  float wv = vUV2.y;
  float spc = vUV2.z;
  vec3 col = vec3(0.08, 0.06, 0.05);
  if (spc > 9.5) {
    if (length(vec2(wu, wv)) > 1.0) discard;
    if (spc > 14.5) col = vec3(0.62, 0.12, 0.08);
    else if (spc > 13.5) col = vec3(0.10, 0.32, 0.62);
  } else if (spc > ${DRAGONFLY_FIRST_SPECIES - 0.5}) {
    float fore = length(vec2((wu - 0.52) / 0.5, (wv - 0.42) / 0.3));
    float hind = length(vec2((wu - 0.48) / 0.48, (wv + 0.42) / 0.34));
    float m = min(fore, hind);
    if (m > 1.0) discard;
    float stigma = (1.0 - step(0.08, abs(wu - 0.86))) * step(0.2, abs(wv));
    col = mix(vec3(0.80, 0.86, 0.90), vec3(0.30, 0.34, 0.38), max(smoothstep(0.8, 0.95, m), stigma));
  } else {
    float fore = length(vec2((wu - 0.55) / 0.55, (wv - 0.35) / 0.65));
    float hind = length(vec2((wu - 0.4) / 0.42, (wv + 0.45) / 0.55));
    float m = min(fore, hind);
    if (m > 1.0) discard;
    vec3 wc = spc > 2.5 ? vec3(0.35, 0.55, 0.95) : spc > 1.5 ? vec3(0.98, 0.88, 0.30) : spc > 0.5 ? vec3(0.95, 0.95, 0.90) : vec3(0.96, 0.52, 0.10);
    float border = smoothstep(0.72, 0.8, m);
    float spot = 1.0 - smoothstep(0.08, 0.11, length(vec2(wu - 0.8, wv - 0.5)));
    float wroot = 1.0 - step(0.06, wu);
    col = mix(wc, vec3(0.08, 0.06, 0.05), max(border * ((spc > 0.5 && spc < 1.5) ? 0.25 : 0.85), wroot));
    col = mix(col, vec3(0.95), spot * 0.8);
  }
  vec4 c = vec4(col, 1.0);
`

export const CRITTER_PARTS: GrassSkeletonParts = {
  attributes: [],
  uniforms: [
    { name: 'grField', wgsl: 'vec4f', glsl: 'vec4' },
    { name: 'crDay', wgsl: 'vec4f', glsl: 'vec4' },
  ],
  vertexTextures: [GRASS_HEIGHT_SAMPLER],
  varyings: [{ name: 'vUV2', wgsl: 'vec3f', glsl: 'vec3' }],
  sway: false,
  vertexFns: { wgsl: CRITTER_FNS_WGSL, glsl: CRITTER_FNS_GLSL },
  vertexBody: { wgsl: CRITTER_BODY_WGSL, glsl: CRITTER_BODY_GLSL },
  fragmentBody: { wgsl: CRITTER_FRAG_WGSL, glsl: CRITTER_FRAG_GLSL },
}

// ---- birds ----------------------------------------------------------------------------------------------------------

const BIRD_FNS_WGSL = `fn lfUnpack(v: f32) -> vec3f {
  let r = floor(v / 65536.0);
  let g = floor((v - r * 65536.0) / 256.0);
  return vec3f(r, g, v - r * 65536.0 - g * 256.0) / 255.0;
}
`
const BIRD_FNS_GLSL = `vec3 lfUnpack(float v) {
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  return vec3(r, g, v - r * 65536.0 - g * 256.0) / 255.0;
}
`

const BIRD_BODY_WGSL = /* wgsl */ `
  let fwd = normalize(finalWorld[0].xyz + vec3f(0.0001, 0.0, 0.0));
  let phase = finalWorld[0].w;
  let bank = finalWorld[1].x;
  let fold = finalWorld[1].y;
  let sc = finalWorld[1].z;
  let amp = finalWorld[1].w;
  let root = finalWorld[3].xyz;
  let rt0 = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)) + vec3f(0.0, 0.0, 0.0001));
  let up0 = cross(rt0, fwd);
  let rt = rt0 * cos(bank) + up0 * sin(bank);
  let up = cross(rt, fwd);
  var q = vertexInputs.position;
  let wgt = vertexInputs.bladeA.x;
  let a = sin(phase) * amp;
  if (wgt > 0.5) {
    let sgn = sign(q.x);
    let ax = abs(q.x);
    let a2 = a * 1.5 + 0.2 * amp;
    var y = ax * sin(a);
    var x = ax * cos(a);
    if (wgt > 1.5) {
      let e = ax - 0.45;
      x = 0.45 * cos(a) + e * cos(a2);
      y = 0.45 * sin(a) + e * sin(a2);
    }
    q = vec3f(mix(x, 0.08, fold) * sgn, mix(y, 0.03, fold), mix(q.z, q.z - ax * 0.6, fold));
  }
  var p = root + (rt * q.x + up * q.y + fwd * q.z) * sc;
  let wp = p;
  let h = 0.4;
  let s = 1.0;
  var dark = vec3f(0.12, 0.11, 0.10);
  var light = vec3f(0.55, 0.50, 0.44);
  if (max(finalWorld[2].x, finalWorld[2].y) > 0.5) {
    dark = lfUnpack(finalWorld[2].x);
    light = lfUnpack(finalWorld[2].y);
  }
  vertexOutputs.vCol = mix(dark, light, vertexInputs.bladeA.y);
  vertexOutputs.vShade = 1.0;
`
const BIRD_BODY_GLSL = /* glsl */ `
  vec3 fwd = normalize(finalWorld[0].xyz + vec3(0.0001, 0.0, 0.0));
  float phase = finalWorld[0].w;
  float bank = finalWorld[1].x;
  float fold = finalWorld[1].y;
  float sc = finalWorld[1].z;
  float amp = finalWorld[1].w;
  vec3 root = finalWorld[3].xyz;
  vec3 rt0 = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.0, 0.0001));
  vec3 up0 = cross(rt0, fwd);
  vec3 rt = rt0 * cos(bank) + up0 * sin(bank);
  vec3 up = cross(rt, fwd);
  vec3 q = position;
  float wgt = bladeA.x;
  float a = sin(phase) * amp;
  if (wgt > 0.5) {
    float sgn = sign(q.x);
    float ax = abs(q.x);
    float a2 = a * 1.5 + 0.2 * amp;
    float y = ax * sin(a);
    float x = ax * cos(a);
    if (wgt > 1.5) {
      float e = ax - 0.45;
      x = 0.45 * cos(a) + e * cos(a2);
      y = 0.45 * sin(a) + e * sin(a2);
    }
    q = vec3(mix(x, 0.08, fold) * sgn, mix(y, 0.03, fold), mix(q.z, q.z - ax * 0.6, fold));
  }
  vec3 p = root + (rt * q.x + up * q.y + fwd * q.z) * sc;
  vec3 wp = p;
  float h = 0.4;
  float s = 1.0;
  vec3 dark = vec3(0.12, 0.11, 0.10);
  vec3 light = vec3(0.55, 0.50, 0.44);
  if (max(finalWorld[2].x, finalWorld[2].y) > 0.5) {
    dark = lfUnpack(finalWorld[2].x);
    light = lfUnpack(finalWorld[2].y);
  }
  vCol = mix(dark, light, bladeA.y);
  vShade = 1.0;
`

export const BIRD_PARTS: GrassSkeletonParts = {
  attributes: [{ name: 'bladeA', wgsl: 'vec4f', glsl: 'vec4' }],
  uniforms: [],
  vertexTextures: [],
  varyings: [],
  sway: false,
  vertexFns: { wgsl: BIRD_FNS_WGSL, glsl: BIRD_FNS_GLSL },
  vertexBody: { wgsl: BIRD_BODY_WGSL, glsl: BIRD_BODY_GLSL },
  fragmentBody: {
    wgsl: '  let c = vec4f(fragmentInputs.vCol, 1.0);\n',
    glsl: '  vec4 c = vec4(vCol, 1.0);\n',
  },
}

// ---- fireflies ------------------------------------------------------------------------------------------------------

export const FIREFLY_UNIFORMS: readonly string[] = ['view', 'viewProjection', 'scCamera', 'ffParams', 'rgMisc', 'rgJitter']

const FIREFLY_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
#ifdef INSTANCES
attribute world0: vec4f;
attribute world1: vec4f;
attribute world2: vec4f;
attribute world3: vec4f;
#endif
uniform view: mat4x4f;
uniform viewProjection: mat4x4f;
uniform scCamera: vec4f;
uniform ffParams: vec4f;
uniform rgMisc: vec4f;
uniform rgJitter: vec4f;
varying vQ: vec3f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
#ifdef INSTANCES
  let seed = vertexInputs.world0.x;
  let anchor = vertexInputs.world3.xyz;
#else
  let seed = 0.5;
  let anchor = vec3f(0.0);
#endif
  let T = uniforms.scCamera.w * 0.35 + seed * 61.0;
  let off = vec3f(sin(T * 0.71 + seed * 9.0) * 2.5 + sin(T * 1.9) * 0.4, 0.5 + 0.9 * (0.5 + 0.5 * sin(T * 0.53 + seed * 4.0)), cos(T * 0.63 + seed * 7.0) * 2.5);
  let blink = pow(max(0.0, sin(uniforms.scCamera.w * (1.3 + seed) + seed * 40.0)), 5.0);
  let right = vec3f(uniforms.view[0][0], uniforms.view[1][0], uniforms.view[2][0]);
  let up = vec3f(uniforms.view[0][1], uniforms.view[1][1], uniforms.view[2][1]);
  let p = anchor + off + (right * vertexInputs.position.x + up * vertexInputs.position.y) * uniforms.ffParams.y * uniforms.ffParams.x;
  let pos = uniforms.viewProjection * vec4f(p, 1.0);
  vertexOutputs.position = vec4f(pos.xy + uniforms.rgJitter.xy * pos.w, pos.zw);
  vertexOutputs.vQ = vec3f(vertexInputs.position.xy, blink * uniforms.ffParams.x);
}
`
const FIREFLY_FRAGMENT_WGSL = /* wgsl */ `
uniform ffParams: vec4f;
uniform rgMisc: vec4f;
varying vQ: vec3f;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let d2 = dot(fragmentInputs.vQ.xy, fragmentInputs.vQ.xy);
  let g = exp(-d2 * 5.0) + 2.0 * exp(-d2 * 60.0);
  fragmentOutputs.color = vec4f(vec3f(0.75, 1.0, 0.3) * g * fragmentInputs.vQ.z * uniforms.ffParams.z * uniforms.rgMisc.z, 1.0);
}
`
const FIREFLY_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
#ifdef INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#endif
uniform mat4 view;
uniform mat4 viewProjection;
uniform vec4 scCamera;
uniform vec4 ffParams;
uniform vec4 rgMisc;
uniform vec4 rgJitter;
varying vec3 vQ;
void main(void) {
#ifdef INSTANCES
  float seed = world0.x;
  vec3 anchor = world3.xyz;
#else
  float seed = 0.5;
  vec3 anchor = vec3(0.0);
#endif
  float T = scCamera.w * 0.35 + seed * 61.0;
  vec3 off = vec3(sin(T * 0.71 + seed * 9.0) * 2.5 + sin(T * 1.9) * 0.4, 0.5 + 0.9 * (0.5 + 0.5 * sin(T * 0.53 + seed * 4.0)), cos(T * 0.63 + seed * 7.0) * 2.5);
  float blink = pow(max(0.0, sin(scCamera.w * (1.3 + seed) + seed * 40.0)), 5.0);
  vec3 right = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 up = vec3(view[0][1], view[1][1], view[2][1]);
  vec3 p = anchor + off + (right * position.x + up * position.y) * ffParams.y * ffParams.x;
  gl_Position = viewProjection * vec4(p, 1.0);
  gl_Position.xy += rgJitter.xy * gl_Position.w;
  vQ = vec3(position.xy, blink * ffParams.x);
}
`
const FIREFLY_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
uniform vec4 ffParams;
uniform vec4 rgMisc;
varying vec3 vQ;
void main(void) {
  float d2 = dot(vQ.xy, vQ.xy);
  float g = exp(-d2 * 5.0) + 2.0 * exp(-d2 * 60.0);
  gl_FragColor = vec4(vec3(0.75, 1.0, 0.3) * g * vQ.z * ffParams.z * rgMisc.z, 1.0);
}
`

// ---- sources, registration, materials ----------------------------------------------------------------------------------

/** The critters' shaders with `lanes`' chunks. */
export function critterShaders(lanes: readonly WorldShaderChunks[] = WORLD_SHADER_CHUNKS): ShaderSources {
  return grassSkeleton(CRITTER_PARTS, lanes)
}

/** The birds' shaders with `lanes`' chunks. */
export function birdShaders(lanes: readonly WorldShaderChunks[] = WORLD_SHADER_CHUNKS): ShaderSources {
  return grassSkeleton(BIRD_PARTS, lanes)
}

/** The fireflies' shaders (no chunks). */
export function fireflyShaders(): ShaderSources {
  return {
    vertexWGSL: FIREFLY_VERTEX_WGSL, fragmentWGSL: FIREFLY_FRAGMENT_WGSL, vertexGLSL: FIREFLY_VERTEX_GLSL, fragmentGLSL: FIREFLY_FRAGMENT_GLSL,
    uniforms: [...FIREFLY_UNIFORMS], samplers: [], chunkSamplers: [],
  }
}

export type LifeShaderKind = 'critter' | 'bird' | 'firefly'

const SHADERS: Record<LifeShaderKind, { name: string; attributes: readonly string[]; src: () => ShaderSources }> = {
  critter: { name: LIFE_CRITTER_SHADER, attributes: ['position'], src: () => critterShaders() },
  bird: { name: LIFE_BIRD_SHADER, attributes: ['position', 'bladeA'], src: () => birdShaders() },
  firefly: { name: LIFE_FIREFLY_SHADER, attributes: ['position'], src: () => fireflyShaders() },
}

/**
 * A wildlife ShaderMaterial of `kind` in the scene's language (WGSL on WebGPU: no GLSL reaches it). Critters and birds
 * are opaque and double-sided; the fireflies additive with no depth write. Hand it to WorldScatter.adopt (the shared
 * uniforms, defines, fallbacks and depth textures), then bind scLightmap / scRegion / scTint (and the critters' grField,
 * crDay, grFieldH; the fireflies' ffParams).
 */
export function createLifeMaterial(scene: Scene, kind: LifeShaderKind, name = `life_${kind}`): ShaderMaterial {
  const def = SHADERS[kind]
  const src = def.src()
  registerSkeletonShader(def.name, src)
  const mat = new ShaderMaterial(name, scene, def.name, {
    attributes: [...def.attributes],
    uniforms: src.uniforms,
    samplers: src.samplers,
    shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  })
  mat.backFaceCulling = false
  if (kind === 'firefly') {
    mat.alphaMode = Constants.ALPHA_ADD
    mat.needAlphaBlending = () => true
    mat.disableDepthWrite = true
  }
  return mat
}

// ---- geometry (the vertex layouts above) --------------------------------------------------------------------------------

export interface LifeGeometry {
  positions: Float32Array
  indices: Uint32Array
  /** The birds' bladeA (wing weight, shade, 0, 0); absent for the others. */
  bladeA?: Float32Array
}

/** The critter: two wing quads (span 0..1 × chord −1..1) and a body quad (6 triangles, 12 vertices). */
export function critterGeometry(): LifeGeometry {
  const pos: number[] = []
  const idx: number[] = []
  for (const sd of [-1, 1]) {
    const b = pos.length / 3
    pos.push(sd, 0, -1, sd, 0, 1, sd, 1, 1, sd, 1, -1)
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  const b = pos.length / 3
  pos.push(0, -1, -1, 0, -1, 1, 0, 1, 1, 0, 1, -1)
  idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

/** The prototype's songbird (17 triangles): a diamond body, a tail, two-segment wings (metres at scale 1). */
export function birdGeometry(): LifeGeometry {
  const P: number[] = [], A: number[] = [], I: number[] = []
  const v = (x: number, y: number, z: number, w: number, sh: number) => {
    P.push(x, y, z)
    A.push(w, sh, 0, 0)
    return P.length / 3 - 1
  }
  const nose = v(0, 0, 0.13, 0, 0.2), tail = v(0, 0.01, -0.12, 0, 0.2), top = v(0, 0.035, 0.02, 0, 0), bot = v(0, -0.03, 0.02, 0, 0.9)
  const l = v(-0.03, 0, 0.02, 0, 0.3), r = v(0.03, 0, 0.02, 0, 0.3)
  I.push(nose, l, top, nose, top, r, nose, bot, l, nose, r, bot, tail, top, l, tail, r, top, tail, l, bot, tail, bot, r)
  const tl = v(-0.04, 0.005, -0.2, 0, 0.1), tr = v(0.04, 0.005, -0.2, 0, 0.1)
  I.push(tail, tl, tr)
  for (const s of [-1, 1]) {
    const r0 = v(0.03 * s, 0.01, 0.05, 1, 0.1), r1 = v(0.03 * s, 0.01, -0.04, 1, 0.1)
    const m0 = v(0.135 * s, 0.01, 0.06, 1, 0.1), m1 = v(0.135 * s, 0.01, -0.06, 1, 0.1)
    const t0 = v(0.3 * s, 0.01, 0.02, 2, 0), t1 = v(0.26 * s, 0.01, -0.07, 2, 0.05)
    I.push(r0, m0, m1, r0, m1, r1, m0, t0, t1, m0, t1, m1)
  }
  return { positions: new Float32Array(P), indices: new Uint32Array(I), bladeA: new Float32Array(A) }
}

/** The firefly quad. */
export function fireflyGeometry(): LifeGeometry {
  return { positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }
}

/** A display sRGB colour (0..255 per channel) packed for the birds' world2 (exact in a 32-bit float). */
export function packRgb(r: number, g: number, b: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return c(r) * 65536 + c(g) * 256 + c(b)
}

// ---- TS twins (GL-L's tests: the flight stays within the wander radius) ------------------------------------------------

const fract = (v: number) => v - Math.floor(v)
function hash12(x: number, y: number): number {
  const rx = fract(x * 0.1031), ry = fract(y * 0.103)
  const dot = rx * (ry + 33.33) + ry * (rx + 33.33)
  const dx = rx + dot, dy = ry + dot
  return fract((dx + dy) * dx)
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Where a critter flies at shader time `t` (s): its offset from the anchor (x, z, m) and its height above the ground
 * (m), as the vertex shader computes it (butterflies: species 0..3; dragonflies: 4, 5).
 */
export function critterFlight(t: number, seed: number, species: number, radius: number): { x: number; z: number; lift: number; sit: number } {
  if (species >= DRAGONFLY_FIRST_SPECIES) {
    const DT = t * 0.9 + seed * 53
    const k = Math.floor(DT)
    const m = smooth(0.72, 0.9, fract(DT))
    const dart = (kk: number): [number, number] => {
      const ax = hash12(kk, seed * 97) * 2 - 1, az = hash12(kk + 7.1, seed * 61) * 2 - 1
      const l = Math.max(1, Math.hypot(ax, az))
      return [ax / l * radius, az / l * radius]
    }
    const a = dart(k), b = dart(k + 1)
    const lift = (0.3 + 0.9 * hash12(k, seed)) * (1 - m) + (0.3 + 0.9 * hash12(k + 1, seed)) * m + 0.03 * Math.sin(t * 9 + seed * 11)
    return { x: a[0] + (b[0] - a[0]) * m, z: a[1] + (b[1] - a[1]) * m, lift, sit: 0 }
  }
  const T = t * 0.55 + seed * 97
  const cyc = fract(T / 7.7 + seed)
  const sit = smooth(0.78, 0.84, cyc) * (1 - smooth(0.96, 1, cyc))
  let x = (Math.sin(T * 0.61 + seed * 6) + 0.5 * Math.sin(T * 1.37 + seed * 3)) * radius * 0.6
  let z = (Math.cos(T * 0.47 + seed * 5) + 0.5 * Math.sin(T * 1.13 + seed)) * radius * 0.6
  const k = Math.max(1, Math.hypot(x, z) / Math.max(radius, 0.001))
  x /= k
  z /= k
  const lift = 0.45 + 0.7 * Math.abs(Math.sin(T * 0.9 + seed * 4)) + 0.08 * Math.sin(T * 11)
  return { x, z, lift: lift + (0.5 - lift) * sit, sit }
}
