/**
 * Grass-tint chunks (docs/GRASS_LIFE.md §3.3 "beyond the far tier", GL-T; docs/WAVE_PLAN6.md D11, §5 GL-T row): the
 * PBR terrain pulls the grass-weighted ground toward the grass palette's mid colour by density, so the carpet's far
 * edge does not show. Created empty by W10-S; filled by GL-T. See shader-chunks.ts for the points and rules.
 *
 * - `GRASS_TINT_CHUNKS`: the Classic terrain chunk (at `postLight`, behind `SRO_GRASS_TINT`), in WORLD_SHADER_CHUNKS
 *   after the coast lane and before render. **Empty on purpose**: the new grass never draws on the Classic path
 *   (Classic = Low keeps the retail scatter, scatter.ts / world.ts syncGrassStyle), so the Classic strings stay HEAD's
 *   (the Low guard: seams-classic, release-lowguard, abuse-w9f-lowguard).
 * - `GRASS_TINT_WGSL` / `GRASS_TINT_GLSL`: the PBR terrain plugin's extern
 *   `fn sroGrassTint(alb: vec3f, lp: vec2f, wp: vec3f) -> vec3f`, called under `SRO_GRASS_TINT` right after the
 *   splat's albedo is made (before wetness), in both languages.
 *
 * What the extern does (X6: **no sampler**, the terrain's WebGL2 units are full on High, D32):
 * 1. **Grass density**, exactly as the field's bake makes it (grass/bake.ts): the region's own layer map
 *    (`sroLayerMap`, the texels the splat loop just read, `textureLoad` / `texelFetch` only) composited in draw order,
 *    each layer's grass weight replacing the cell corners its mask covers, interpolated across the 2 m cell, × the
 *    slope fade `smoothstep(0.70, 0.80, normal.y)`. The palette slot is the last grass layer's.
 * 2. **The per-tile table** is a uniform table indexed by the layer ids the terrain already fetches: one byte per
 *    tile-array layer (grass weight in 4 bits, palette slot in 4 bits), three bytes per float (exact below 2^24),
 *    16 floats per mat4: `sroGt0..5` (288 layers ≥ the 256-layer array cap). Rewritten by grass/tint.ts whenever the
 *    streamer's tile atlas moves a grass tile (a layer map never changes meaning, tile-atlas.ts).
 * 3. **The palette**: `sroGtPal`, 16 slots (GRASS_PALETTE_SLOTS), each the slot's mid blade colour as display sRGB
 *    8:8:8 in one float; the same large-scale hue noise the blades use (grass/shaders.ts `n1`, `n2`) paints the
 *    patches, so the ground beyond the carpet keeps its painted look.
 * 4. **How much**: `sroGtFade` = (ramp start m, ramp end m, near strength, far strength): the pull is `near` under the
 *    carpet and ramps to `far` over the far tier's thinning (the level's `cut0` range, the distance the tier-0 blades
 *    drop out), 2D from the camera like the grass cull, × the density. With `near` 0 (grass/tint.ts) every pixel under
 *    the carpet returns before the layer loop.
 * 5. **The far carpet** (GRASS_FAR, docs/GRASS_FAR.md §4, ring C): `sroGtLook` = (tuft pattern share, band noise m,
 *    the meadow ring's outer fade start and end m: under the ring's tufts the ground is shaded by GRASS_TINT_RING_SHADE,
 *    the ground between tufts reads as their shaded roots; 0, 0: no ring) and `sroGtWind` = (wind direction x, z, sheen
 *    share, time). The ramp moves inward by the band noise exactly as
 *    the near ring's tier-0 cut-off and the meadow ring's fade-in do (the same value noise), so the hand-over wanders.
 *    Past it the ground reads as a grass carpet, not a flat palette colour: three octaves of tuft-scale value noise
 *    (0.43, 1.25 and 3.4 m) darken the roots and lighten the tips around the palette's mid colour (the mean stays the
 *    mid colour the seam was matched with), each octave fading where its wavelength nears the pixel's footprint along
 *    the view (no derivative: this runs after the layer loop, `GRASS_TINT_PX`); and the gust wave the near blades bend
 *    with (`sroWind`'s phase, 18 m) and a slow 78 m swell brighten the carpet as a soft sheen sweeping downwind, the
 *    meadow ring's tips with it (grass/ring-shaders.ts). Both shares 0 (Grass: Low): today's output.
 *
 * Cost: past the ramp start at most 8 layer-map loads (already in cache) and a few table reads per terrain pixel;
 * nothing nearer. Measured ≤ one 0.13 ms timestamp quantum on WebGPU High 1080p looking down on the fields (§5: ≤ 0.1).
 */
import type { WorldShaderChunks } from '../shader-chunks.ts'

// No value imports here: pbr/terrain-plugin.ts and shaders.ts import this file while grass/shaders.ts imports
// shaders.ts, so a value import of the grass modules would close an evaluation cycle. grass/tint.ts holds the runtime.

/**
 * X2 (look item 7, the far ground): the cell lookup wanders by up to ±GRASS_TINT_JITTER_M on a ~3 m value noise, so a
 * palette or density change between 2 m cells reads as an irregular blend from afar instead of hard rectangles. No
 * extra load: the same one cell, at a jittered point. `lp` is in 0.1 m units (20 per cell).
 */
export const GRASS_TINT_JITTER_M = 4
const JITTER_FREQ = '0.33'
const JITTER_LP = `${(GRASS_TINT_JITTER_M * 2 * 10).toFixed(1)}`

/** The Classic terrain chunk: empty (Classic never draws the new grass; the Low guard). */
export const GRASS_TINT_CHUNKS: WorldShaderChunks = {}

/** Table matrices (`sroGt0` .. `sroGt5`). */
export const GRASS_TINT_MATRICES = 6
/** Tile-array layers per float (8 bits each, exact in a float below 2^24). */
export const GRASS_TINT_PER_FLOAT = 3
/** Layers the table covers (≥ the 256-layer texture-array cap, material-budgets.test.ts). */
export const GRASS_TINT_LAYERS = GRASS_TINT_MATRICES * 16 * GRASS_TINT_PER_FLOAT
/** Palette slots in `sroGtPal` (= grass/shaders.ts GRASS_PALETTE_SLOTS, grass-chunks.test.ts). */
export const GRASS_TINT_SLOTS = 16
/** Weight levels in a table byte's high nibble (0 = no grass). */
export const GRASS_TINT_WEIGHT_STEPS = 15

/** The uniform names (the terrain's `sharedUniforms`, grass/tint.ts). */
export const GRASS_TINT_TABLE_UNIFORMS: readonly string[] = Array.from({ length: GRASS_TINT_MATRICES }, (_, i) => `sroGt${i}`)
export const GRASS_TINT_PALETTE_UNIFORM = 'sroGtPal'
export const GRASS_TINT_FADE_UNIFORM = 'sroGtFade'
/** GRASS_FAR: (tuft pattern share, band noise m, 0, 0) and (wind direction x, z, sheen share, time s). */
export const GRASS_TINT_LOOK_UNIFORM = 'sroGtLook'
export const GRASS_TINT_WIND_UNIFORM = 'sroGtWind'
/**
 * The pixel size per metre of distance the pattern's fade assumes (1080p at the game camera's 0.85 rad: 2 tan(0.425) /
 * 1080 ≈ 0.00084; a little coarser, so a 1440p or 0.75-scale view never sees the pattern alias).
 */
export const GRASS_TINT_PX = 0.0009
/** The ground under the meadow ring's tufts: × this (their shaded roots), back to 1 past the ring's outer fade. */
export const GRASS_TINT_RING_SHADE = 0.86
/** The band noise's frequency (grass/shaders.ts GRASS_BAND_FREQ; a copy: no value import here, grass-chunks.test.ts). */
const BAND_FREQ = '0.027'
/** The wind sheen (grass/ring-shaders.ts GRASS_SHEEN_GAIN, GRASS_SHEEN_SHARE; copies, the test checks them). */
export const GRASS_TINT_SHEEN_GAIN = '1.18, 1.16, 1.05'
export const GRASS_TINT_SHEEN_SHARE = '0.55'

/** The blade hue noise of grass/shaders.ts (`n1` at 0.075 /m, `n2` at 0.021 /m + (17, 3); same hash, same mix). */
const HUE_LOW = '0.86, 1.02, 1.08'
const HUE_HIGH = '1.12, 1.06, 0.78'
/** How much of the blade hue variation the ground carries (the tips carry all of it, the bases half). */
const HUE_SHARE = '0.8'

function tableReadWgsl(): string {
  const arms = GRASS_TINT_TABLE_UNIFORMS.map((u, i) => `${i ? ' else ' : '  '}if (q == ${i}) { v = uniforms.${u}[c][r]; }`).join('')
  return `fn sroGtEntry(layer: i32) -> u32 {
  let b = clamp(layer, 0, ${GRASS_TINT_LAYERS - 1});
  let fi = b / ${GRASS_TINT_PER_FLOAT};
  let q = fi / 16;
  let c = (fi % 16) / 4;
  let r = fi % 4;
  var v = 0.0;
${arms}
  return (u32(v + 0.5) >> (u32(b % ${GRASS_TINT_PER_FLOAT}) * 8u)) & 255u;
}
`
}

function tableReadGlsl(): string {
  const arms = GRASS_TINT_TABLE_UNIFORMS.map((u, i) => `${i ? ' else ' : '  '}if (q == ${i}) v = ${u}[c][r];`).join('')
  return `uint sroGtEntry(int layer) {
  int b = clamp(layer, 0, ${GRASS_TINT_LAYERS - 1});
  int fi = b / ${GRASS_TINT_PER_FLOAT};
  int q = fi / 16;
  int c = (fi % 16) / 4;
  int r = fi % 4;
  float v = 0.0;
${arms}
  return (uint(v + 0.5) >> (uint(b % ${GRASS_TINT_PER_FLOAT}) * 8u)) & 255u;
}
`
}

/** `fn sroGrassTint(alb: vec3f, lp: vec2f, wp: vec3f) -> vec3f` (the terrain plugin's extern, WGSL). */
export const GRASS_TINT_WGSL = /* wgsl */ `${GRASS_TINT_TABLE_UNIFORMS.map(u => `uniform ${u}: mat4x4f;\n`).join('')}uniform ${GRASS_TINT_PALETTE_UNIFORM}: mat4x4f;
uniform ${GRASS_TINT_FADE_UNIFORM}: vec4f;
uniform ${GRASS_TINT_LOOK_UNIFORM}: vec4f;
uniform ${GRASS_TINT_WIND_UNIFORM}: vec4f;
${tableReadWgsl()}fn sroGtHash(q: vec2f) -> f32 {
  let r = fract(q * vec2f(0.1031, 0.1030));
  let d = r + dot(r, r.yx + 33.33);
  return fract((d.x + d.y) * d.x);
}
fn sroGtNoise(q: vec2f) -> f32 {
  let i = floor(q);
  let f = fract(q);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sroGtHash(i), sroGtHash(i + vec2f(1.0, 0.0)), u.x), mix(sroGtHash(i + vec2f(0.0, 1.0)), sroGtHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn sroGrassTint(alb: vec3f, lp: vec2f, wp: vec3f) -> vec3f {
  let f = uniforms.${GRASS_TINT_FADE_UNIFORM};
  let lk = uniforms.${GRASS_TINT_LOOK_UNIFORM};
  let camD = distance(scene.vEyePosition.xz, wp.xz);
  if (f.z <= 0.0 && camD <= f.x - lk.y) { return alb; }
  let band = sroGtNoise(wp.xz * ${BAND_FREQ}) * lk.y;
  let pull = mix(f.z, f.w, smoothstep(f.x - band, f.y - band, camD));
  if (pull <= 0.0) { return alb; }
  let jt = (vec2f(sroGtNoise(wp.xz * ${JITTER_FREQ}), sroGtNoise(wp.xz * ${JITTER_FREQ} + vec2f(41.0, 7.0))) - vec2f(0.5)) * ${JITTER_LP};
  let cf = (lp + jt) / 20.0;
  let cellF = clamp(floor(cf), vec2f(0.0), vec2f(95.0));
  let fr = clamp(cf - cellF, vec2f(0.0), vec2f(1.0));
  let cell = vec2i(cellF);
  let n = i32(uniforms.sroRegion.z + 0.5);
  var wc = vec4f(0.0);
  var slot = -1;
  for (var k = 0; k < 8; k++) {
    if (k >= n) { break; }
    let t = textureLoad(sroLayerMap, vec2i(cell.x, k * 96 + cell.y), 0);
    if (t.a < 0.5) { break; }
    let e = sroGtEntry(i32(t.r * 255.0 + 0.5));
    let m = u32(t.b * 255.0 + 0.5);
    let g = f32(e >> 4u) / ${GRASS_TINT_WEIGHT_STEPS}.0;
    wc = select(wc, vec4f(g), vec4<bool>((m & 1u) != 0u, (m & 2u) != 0u, (m & 4u) != 0u, (m & 8u) != 0u));
    if (e >= 16u) { slot = i32(e & 15u); }
  }
  let ny = normalize(fragmentInputs.vNormalW).y;
  let dens = clamp(mix(mix(wc.x, wc.y, fr.x), mix(wc.z, wc.w, fr.x), fr.y), 0.0, 1.0) * smoothstep(0.7, 0.8, ny);
  if (slot < 0 || dens <= 0.0) { return alb; }
  let k = dens * pull;
  let pv = u32(uniforms.${GRASS_TINT_PALETTE_UNIFORM}[slot / 4][slot % 4] + 0.5);
  let mid = vec3f(f32(pv & 255u), f32((pv >> 8u) & 255u), f32((pv >> 16u) & 255u)) / 255.0;
  let n1 = sroGtNoise(wp.xz * 0.075);
  let n2 = sroGtNoise(wp.xz * 0.021 + vec2f(17.0, 3.0));
  let hue = mix(vec3f(${HUE_LOW}), vec3f(${HUE_HIGH}), smoothstep(0.25, 0.75, n1 * 0.6 + n2 * 0.4));
  var col = mid * mix(vec3f(1.0), hue, ${HUE_SHARE});
  let eye = scene.vEyePosition.xyz;
  let ed = max(distance(eye, wp), 0.001);
  let foot = ed * ${GRASS_TINT_PX} / max(abs(eye.y - wp.y) / ed, 0.04);
  let tuft = (sroGtNoise(wp.xz * 2.3 + vec2f(3.1, 9.7)) - 0.5) * 0.9 * (1.0 - smoothstep(0.11, 0.22, foot))
    + (sroGtNoise(wp.xz * 0.8 + vec2f(11.3, 5.1)) - 0.5) * 0.75 * (1.0 - smoothstep(0.31, 0.62, foot))
    + (sroGtNoise(wp.xz * 0.29 + vec2f(7.7, 2.9)) - 0.5) * 0.6 * (1.0 - smoothstep(0.85, 1.7, foot));
  col = col * (vec3f(1.0) + clamp(tuft * lk.x, -0.5, 0.5) * vec3f(0.64, 0.6, 0.5));
  col = col * select(1.0, mix(${GRASS_TINT_RING_SHADE}, 1.0, smoothstep(lk.z, lk.w, camD)), lk.w > lk.z);
  let wd = uniforms.${GRASS_TINT_WIND_UNIFORM};
  let wv = sin(dot(wp.xz, wd.xy) * 0.35 - wd.w * 2.1 + (n1 - 0.5) * 2.0);
  let sw = sin(dot(wp.xz, wd.xy) * 0.08 - wd.w * 0.75 + n2 * 3.0);
  let sheen = (smoothstep(0.2, 1.0, wv) * 0.6 + smoothstep(0.4, 1.0, sw) * 0.4) * wd.z;
  col = mix(col, col * vec3f(${GRASS_TINT_SHEEN_GAIN}) + vec3f(0.01), sheen * ${GRASS_TINT_SHEEN_SHARE});
  let tgt = toLinearSpaceVec3(clamp(col, vec3f(0.0), vec3f(1.0)));
  return mix(alb, tgt, clamp(k, 0.0, 1.0));
}
`

/** `vec3 sroGrassTint(vec3 alb, vec2 lp, vec3 wp)` (the terrain plugin's extern, GLSL ES 3.0). */
export const GRASS_TINT_GLSL = /* glsl */ `${GRASS_TINT_TABLE_UNIFORMS.map(u => `uniform mat4 ${u};\n`).join('')}uniform mat4 ${GRASS_TINT_PALETTE_UNIFORM};
uniform vec4 ${GRASS_TINT_FADE_UNIFORM};
uniform vec4 ${GRASS_TINT_LOOK_UNIFORM};
uniform vec4 ${GRASS_TINT_WIND_UNIFORM};
${tableReadGlsl()}float sroGtHash(vec2 q) {
  vec2 r = fract(q * vec2(0.1031, 0.1030));
  vec2 d = r + dot(r, r.yx + 33.33);
  return fract((d.x + d.y) * d.x);
}
float sroGtNoise(vec2 q) {
  vec2 i = floor(q);
  vec2 f = fract(q);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sroGtHash(i), sroGtHash(i + vec2(1.0, 0.0)), u.x), mix(sroGtHash(i + vec2(0.0, 1.0)), sroGtHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 sroGrassTint(vec3 alb, vec2 lp, vec3 wp) {
  vec4 f = ${GRASS_TINT_FADE_UNIFORM};
  vec4 lk = ${GRASS_TINT_LOOK_UNIFORM};
  float camD = distance(vEyePosition.xz, wp.xz);
  if (f.z <= 0.0 && camD <= f.x - lk.y) return alb;
  float band = sroGtNoise(wp.xz * ${BAND_FREQ}) * lk.y;
  float pull = mix(f.z, f.w, smoothstep(f.x - band, f.y - band, camD));
  if (pull <= 0.0) return alb;
  vec2 jt = (vec2(sroGtNoise(wp.xz * ${JITTER_FREQ}), sroGtNoise(wp.xz * ${JITTER_FREQ} + vec2(41.0, 7.0))) - vec2(0.5)) * ${JITTER_LP};
  vec2 cf = (lp + jt) / 20.0;
  vec2 cellF = clamp(floor(cf), vec2(0.0), vec2(95.0));
  vec2 fr = clamp(cf - cellF, vec2(0.0), vec2(1.0));
  ivec2 cell = ivec2(cellF);
  int n = int(sroRegion.z + 0.5);
  vec4 wc = vec4(0.0);
  int slot = -1;
  for (int k = 0; k < 8; k++) {
    if (k >= n) break;
    vec4 t = texelFetch(sroLayerMap, ivec2(cell.x, k * 96 + cell.y), 0);
    if (t.a < 0.5) break;
    uint e = sroGtEntry(int(t.r * 255.0 + 0.5));
    uint m = uint(t.b * 255.0 + 0.5);
    float g = float(e >> 4u) / ${GRASS_TINT_WEIGHT_STEPS}.0;
    wc = mix(wc, vec4(g), bvec4((m & 1u) != 0u, (m & 2u) != 0u, (m & 4u) != 0u, (m & 8u) != 0u));
    if (e >= 16u) slot = int(e & 15u);
  }
  float ny = normalize(vNormalW).y;
  float dens = clamp(mix(mix(wc.x, wc.y, fr.x), mix(wc.z, wc.w, fr.x), fr.y), 0.0, 1.0) * smoothstep(0.7, 0.8, ny);
  if (slot < 0 || dens <= 0.0) return alb;
  float k = dens * pull;
  uint pv = uint(${GRASS_TINT_PALETTE_UNIFORM}[slot / 4][slot % 4] + 0.5);
  vec3 mid = vec3(float(pv & 255u), float((pv >> 8u) & 255u), float((pv >> 16u) & 255u)) / 255.0;
  float n1 = sroGtNoise(wp.xz * 0.075);
  float n2 = sroGtNoise(wp.xz * 0.021 + vec2(17.0, 3.0));
  vec3 hue = mix(vec3(${HUE_LOW}), vec3(${HUE_HIGH}), smoothstep(0.25, 0.75, n1 * 0.6 + n2 * 0.4));
  vec3 col = mid * mix(vec3(1.0), hue, ${HUE_SHARE});
  vec3 eye = vEyePosition.xyz;
  float ed = max(distance(eye, wp), 0.001);
  float foot = ed * ${GRASS_TINT_PX} / max(abs(eye.y - wp.y) / ed, 0.04);
  float tuft = (sroGtNoise(wp.xz * 2.3 + vec2(3.1, 9.7)) - 0.5) * 0.9 * (1.0 - smoothstep(0.11, 0.22, foot))
    + (sroGtNoise(wp.xz * 0.8 + vec2(11.3, 5.1)) - 0.5) * 0.75 * (1.0 - smoothstep(0.31, 0.62, foot))
    + (sroGtNoise(wp.xz * 0.29 + vec2(7.7, 2.9)) - 0.5) * 0.6 * (1.0 - smoothstep(0.85, 1.7, foot));
  col *= vec3(1.0) + clamp(tuft * lk.x, -0.5, 0.5) * vec3(0.64, 0.6, 0.5);
  col *= lk.w > lk.z ? mix(${GRASS_TINT_RING_SHADE}, 1.0, smoothstep(lk.z, lk.w, camD)) : 1.0;
  vec4 wd = ${GRASS_TINT_WIND_UNIFORM};
  float wv = sin(dot(wp.xz, wd.xy) * 0.35 - wd.w * 2.1 + (n1 - 0.5) * 2.0);
  float sw = sin(dot(wp.xz, wd.xy) * 0.08 - wd.w * 0.75 + n2 * 3.0);
  float sheen = (smoothstep(0.2, 1.0, wv) * 0.6 + smoothstep(0.4, 1.0, sw) * 0.4) * wd.z;
  col = mix(col, col * vec3(${GRASS_TINT_SHEEN_GAIN}) + vec3(0.01), sheen * ${GRASS_TINT_SHEEN_SHARE});
  vec3 tgt = toLinearSpace(clamp(col, vec3(0.0), vec3(1.0)));
  return mix(alb, tgt, clamp(k, 0.0, 1.0));
}
`
