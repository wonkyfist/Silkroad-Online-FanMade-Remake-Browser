/**
 * Snow shader code (docs/WINTER.md §7): the PBR snow plugin's snippets, the Classic StandardMaterial plugin's, and the
 * Classic terrain and grass chunks (WINTER_CHUNKS). WGSL and GLSL side by side with the same names; every function and
 * variable is `snw`-prefixed (no clash with the other lanes' helpers). Uniforms (one set, PBR UBO members / Classic
 * shared values):
 *
 *   snwA  x cover 0..1 (× the admin strength), y frost 0..1, z overcast 0..1 (shape: the snow greys and keeps its
 *         relief under a flat sky), w night 0..1 (the cold tint fades: no blue snow at night)
 *   snwB  rgb snow albedo (PBR: linear; Classic: display), w snow roughness
 *
 * Coverage: a field from the up-ness of the final normal, a world-space noise and (terrain) a slope cut-off, compared
 * with a threshold that falls as the cover rises: a thin cover is a dusting on the flattest, highest spots; a full cover
 * hides everything flat. Walls stay bare, roofs and wall tops whiten; trees get patchy snow on top.
 */

const NOISE_WGSL = /* wgsl */ `
fn snwHash(p: vec2f) -> f32 {
  let r = fract(p * vec2f(0.1031, 0.1030));
  let d = r + dot(r, r.yx + 33.33);
  return fract((d.x + d.y) * d.x);
}
fn snwNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(snwHash(i), snwHash(i + vec2f(1.0, 0.0)), u.x), mix(snwHash(i + vec2f(0.0, 1.0)), snwHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn snwFbm(p: vec2f) -> f32 { return snwNoise(p) * 0.55 + snwNoise(p * 2.7 + vec2f(5.2, 1.3)) * 0.3 + snwNoise(p * 7.1 + vec2f(2.1, 8.7)) * 0.15; }
`
const NOISE_GLSL = /* glsl */ `
float snwHash(vec2 p) {
  vec2 r = fract(p * vec2(0.1031, 0.1030));
  vec2 d = r + dot(r, r.yx + 33.33);
  return fract((d.x + d.y) * d.x);
}
float snwNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(snwHash(i), snwHash(i + vec2(1.0, 0.0)), u.x), mix(snwHash(i + vec2(0.0, 1.0)), snwHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float snwFbm(vec2 p) { return snwNoise(p) * 0.55 + snwNoise(p * 2.7 + vec2(5.2, 1.3)) * 0.3 + snwNoise(p * 7.1 + vec2(2.1, 8.7)) * 0.15; }
`

/** The noise helpers (the hash is sine-free: sin() of large world coordinates loses precision on WebGPU). */
export const SNOW_NOISE = { wgsl: NOISE_WGSL, glsl: NOISE_GLSL } as const

// ---- PBR (CUSTOM_FRAGMENT_UPDATE_ALPHA: the final normal is known, the albedo is final; the terrain plugin writes its
// normal there before us). Defines: SNOW (on), SNOW_T terrain, SNOW_F foliage cards, SNOW_I ice. ----

const PBR_APPLY_WGSL = /* wgsl */ `
#ifdef SNOW
{
  let snwP = fragmentInputs.vPositionW;
  let snwNy = mix(normalW.y, geometricNormalW.y, 0.5);
  let snwN = snwFbm(snwP.xz * 0.45);
  let snwN2 = snwFbm(snwP.xz * 0.07 + vec2f(3.1, 7.7));
  let snwBase = surfaceAlbedo;
  let snwLum = dot(snwBase, vec3f(0.2126, 0.7152, 0.0722));
  let snwT = 1.0 - uniforms.snwA.x * 1.2;
#if defined(SNOW_T)
  let snwF = smoothstep(0.62, 0.82, snwNy + (snwN - 0.5) * 0.3) * (0.62 + 0.38 * (snwN2 * 0.6 + snwN * 0.4));
  var snwK = smoothstep(snwT, snwT + 0.22, snwF);
#elif defined(SNOW_F)
  let snwF = smoothstep(0.0, 0.6, snwNy) * (0.45 + 0.55 * smoothstep(0.3, 0.6, snwFbm(snwP.xz * 2.3 + vec2f(snwP.y * 1.7, 0.0))));
  var snwK = smoothstep(snwT, snwT + 0.3, snwF) * 0.85;
#elif defined(SNOW_I)
  let snwC1 = abs(snwNoise(snwP.xz * 0.55) - 0.5);
  let snwC2 = abs(snwNoise(snwP.xz * 1.9 + vec2f(4.0, 9.0)) - 0.5);
  let snwCrack = (1.0 - smoothstep(0.0, 0.035, snwC1)) * 0.9 + (1.0 - smoothstep(0.0, 0.025, snwC2)) * 0.6;
  surfaceAlbedo = mix(surfaceAlbedo * (0.65 + 0.7 * snwN2), vec3f(0.62, 0.7, 0.76), clamp(snwCrack, 0.0, 1.0) * 0.7);
  let snwTi = max(snwT + 0.2, 0.5);
  var snwK = smoothstep(snwTi, snwTi + 0.25, snwN2 * 0.55 + snwN * 0.45) * 0.85;
#else
  let snwF = smoothstep(0.5, 0.74, snwNy + (snwN - 0.5) * 0.3) * (0.7 + 0.3 * snwN2);
  var snwK = smoothstep(snwT, snwT + 0.2, snwF);
#endif
  snwK = clamp(snwK, 0.0, 1.0);
  snwKeep = snwK;
#ifndef SNOW_F
  normalW = normalize(mix(normalW, geometricNormalW, snwK * 0.6));
#ifndef SNOW_I
  {
    let snwG = vec2f(snwFbm((snwP.xz + vec2f(0.3, 0.0)) * 0.45) - snwN, snwFbm((snwP.xz + vec2f(0.0, 0.3)) * 0.45) - snwN) / 0.3;
    normalW = normalize(normalW + vec3f(-snwG.x, 0.0, -snwG.y) * (0.9 * snwK));
  }
#endif
#endif
  // the cold: a little desaturation by day (none at night: the night grade is blue enough)
  let snwCold = uniforms.snwA.y * (1.0 - uniforms.snwA.w) * 0.18;
  surfaceAlbedo = mix(surfaceAlbedo, vec3f(dot(surfaceAlbedo, vec3f(0.2126, 0.7152, 0.0722))) * vec3f(0.97, 0.99, 1.01), snwCold);
  // the snow keeps the relief: darker in the texture's dark lines (mortar, cracks, bark), greyer under a flat sky
  let snwAo = mix(1.0, 0.62 + 0.55 * clamp(snwLum * 2.4, 0.0, 1.0), 0.6);
  let snwCol = uniforms.snwB.rgb * (0.86 + 0.14 * snwN) * snwAo * (1.0 - 0.12 * uniforms.snwA.z);
  surfaceAlbedo = mix(surfaceAlbedo, snwCol, snwK);
}
#endif
`
const PBR_APPLY_GLSL = /* glsl */ `
#ifdef SNOW
{
  vec3 snwP = vPositionW;
  float snwNy = mix(normalW.y, geometricNormalW.y, 0.5);
  float snwN = snwFbm(snwP.xz * 0.45);
  float snwN2 = snwFbm(snwP.xz * 0.07 + vec2(3.1, 7.7));
  vec3 snwBase = surfaceAlbedo;
  float snwLum = dot(snwBase, vec3(0.2126, 0.7152, 0.0722));
  float snwT = 1.0 - snwA.x * 1.2;
#if defined(SNOW_T)
  float snwF = smoothstep(0.62, 0.82, snwNy + (snwN - 0.5) * 0.3) * (0.62 + 0.38 * (snwN2 * 0.6 + snwN * 0.4));
  float snwK = smoothstep(snwT, snwT + 0.22, snwF);
#elif defined(SNOW_F)
  float snwF = smoothstep(0.0, 0.6, snwNy) * (0.45 + 0.55 * smoothstep(0.3, 0.6, snwFbm(snwP.xz * 2.3 + vec2(snwP.y * 1.7, 0.0))));
  float snwK = smoothstep(snwT, snwT + 0.3, snwF) * 0.85;
#elif defined(SNOW_I)
  float snwC1 = abs(snwNoise(snwP.xz * 0.55) - 0.5);
  float snwC2 = abs(snwNoise(snwP.xz * 1.9 + vec2(4.0, 9.0)) - 0.5);
  float snwCrack = (1.0 - smoothstep(0.0, 0.035, snwC1)) * 0.9 + (1.0 - smoothstep(0.0, 0.025, snwC2)) * 0.6;
  surfaceAlbedo = mix(surfaceAlbedo * (0.65 + 0.7 * snwN2), vec3(0.62, 0.7, 0.76), clamp(snwCrack, 0.0, 1.0) * 0.7);
  float snwTi = max(snwT + 0.2, 0.5);
  float snwK = smoothstep(snwTi, snwTi + 0.25, snwN2 * 0.55 + snwN * 0.45) * 0.85;
#else
  float snwF = smoothstep(0.5, 0.74, snwNy + (snwN - 0.5) * 0.3) * (0.7 + 0.3 * snwN2);
  float snwK = smoothstep(snwT, snwT + 0.2, snwF);
#endif
  snwK = clamp(snwK, 0.0, 1.0);
  snwKeep = snwK;
#ifndef SNOW_F
  normalW = normalize(mix(normalW, geometricNormalW, snwK * 0.6));
#ifndef SNOW_I
  {
    vec2 snwG = vec2(snwFbm((snwP.xz + vec2(0.3, 0.0)) * 0.45) - snwN, snwFbm((snwP.xz + vec2(0.0, 0.3)) * 0.45) - snwN) / 0.3;
    normalW = normalize(normalW + vec3(-snwG.x, 0.0, -snwG.y) * (0.9 * snwK));
  }
#endif
#endif
  float snwCold = snwA.y * (1.0 - snwA.w) * 0.18;
  surfaceAlbedo = mix(surfaceAlbedo, vec3(dot(surfaceAlbedo, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.97, 0.99, 1.01), snwCold);
  float snwAo = mix(1.0, 0.62 + 0.55 * clamp(snwLum * 2.4, 0.0, 1.0), 0.6);
  vec3 snwCol = snwB.rgb * (0.86 + 0.14 * snwN) * snwAo * (1.0 - 0.12 * snwA.z);
  surfaceAlbedo = mix(surfaceAlbedo, snwCol, snwK);
}
#endif
`
const PBR_ROUGH_WGSL = /* wgsl */ `
#ifdef SNOW
metallicRoughness = vec2f(mix(metallicRoughness.x, 0.0, snwKeep), mix(metallicRoughness.y, uniforms.snwB.w, snwKeep));
#endif
`
const PBR_ROUGH_GLSL = /* glsl */ `
#ifdef SNOW
metallicRoughness = vec2(mix(metallicRoughness.x, 0.0, snwKeep), mix(metallicRoughness.y, snwB.w, snwKeep));
#endif
`

/** The PBR plugin's snippets by language (CUSTOM_FRAGMENT_DEFINITIONS, UPDATE_ALPHA, UPDATE_METALLICROUGHNESS). */
export function snowPbrCode(lang: 'wgsl' | 'glsl'): Record<string, string> {
  const w = lang === 'wgsl'
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef SNOW\n${w ? 'var<private> snwKeep: f32;\n' : 'float snwKeep;\n'}${w ? NOISE_WGSL : NOISE_GLSL}#endif\n`,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: w ? PBR_APPLY_WGSL : PBR_APPLY_GLSL,
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: w ? PBR_ROUGH_WGSL : PBR_ROUGH_GLSL,
  }
}

// ---- Classic StandardMaterial (CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `baseColor` is the diffuse sample, display-referred,
// lit afterwards by the world sun and the object lightmap). Defines: SNOWC, SNOWC_F (alpha-tested foliage), SNOWC_I. ----

const STD_WGSL = /* wgsl */ `
#ifdef SNOWC
{
  let snwP = fragmentInputs.vPositionW;
  let snwN = snwFbm(snwP.xz * 0.45);
  let snwN2 = snwFbm(snwP.xz * 0.07 + vec2f(3.1, 7.7));
  let snwT = 1.0 - uniforms.snwA.x * 1.2;
  let snwLum = dot(baseColor.rgb, vec3f(0.3, 0.55, 0.15));
#if defined(SNOWC_F)
  let snwK = smoothstep(snwT, snwT + 0.3, smoothstep(0.0, 0.6, normalW.y) * (0.45 + 0.55 * smoothstep(0.3, 0.6, snwFbm(snwP.xz * 2.3 + vec2f(snwP.y * 1.7, 0.0))))) * 0.85;
#elif defined(SNOWC_I)
  let snwC1 = abs(snwNoise(snwP.xz * 0.55) - 0.5);
  let snwCrack = (1.0 - smoothstep(0.0, 0.035, snwC1)) * 0.8;
  baseColor = vec4f(mix(vec3f(0.42, 0.52, 0.6) * (0.75 + 0.5 * snwN2), vec3f(0.78, 0.84, 0.88), snwCrack), 1.0);
  let snwTi = max(snwT + 0.2, 0.5);
  let snwK = smoothstep(snwTi, snwTi + 0.25, snwN2 * 0.55 + snwN * 0.45) * 0.85;
#else
  let snwK = smoothstep(snwT, snwT + 0.2, smoothstep(0.5, 0.74, normalW.y + (snwN - 0.5) * 0.3) * (0.7 + 0.3 * snwN2));
#endif
  var snwC = mix(baseColor.rgb, vec3f(snwLum) * vec3f(0.96, 0.98, 1.02), 0.22 * uniforms.snwA.y * (1.0 - uniforms.snwA.w));
  let snwAo = mix(1.0, 0.64 + 0.5 * clamp(snwLum * 2.2, 0.0, 1.0), 0.55);
  snwC = mix(snwC, uniforms.snwB.rgb * (0.88 + 0.12 * snwN) * snwAo * (1.0 - 0.1 * uniforms.snwA.z), clamp(snwK, 0.0, 1.0));
  baseColor = vec4f(snwC, baseColor.a);
}
#endif
`
const STD_GLSL = /* glsl */ `
#ifdef SNOWC
{
  vec3 snwP = vPositionW;
  float snwN = snwFbm(snwP.xz * 0.45);
  float snwN2 = snwFbm(snwP.xz * 0.07 + vec2(3.1, 7.7));
  float snwT = 1.0 - snwA.x * 1.2;
  float snwLum = dot(baseColor.rgb, vec3(0.3, 0.55, 0.15));
#if defined(SNOWC_F)
  float snwK = smoothstep(snwT, snwT + 0.3, smoothstep(0.0, 0.6, normalW.y) * (0.45 + 0.55 * smoothstep(0.3, 0.6, snwFbm(snwP.xz * 2.3 + vec2(snwP.y * 1.7, 0.0))))) * 0.85;
#elif defined(SNOWC_I)
  float snwC1 = abs(snwNoise(snwP.xz * 0.55) - 0.5);
  float snwCrack = (1.0 - smoothstep(0.0, 0.035, snwC1)) * 0.8;
  baseColor = vec4(mix(vec3(0.42, 0.52, 0.6) * (0.75 + 0.5 * snwN2), vec3(0.78, 0.84, 0.88), snwCrack), 1.0);
  float snwTi = max(snwT + 0.2, 0.5);
  float snwK = smoothstep(snwTi, snwTi + 0.25, snwN2 * 0.55 + snwN * 0.45) * 0.85;
#else
  float snwK = smoothstep(snwT, snwT + 0.2, smoothstep(0.5, 0.74, normalW.y + (snwN - 0.5) * 0.3) * (0.7 + 0.3 * snwN2));
#endif
  vec3 snwC = mix(baseColor.rgb, vec3(snwLum) * vec3(0.96, 0.98, 1.02), 0.22 * snwA.y * (1.0 - snwA.w));
  float snwAo = mix(1.0, 0.64 + 0.5 * clamp(snwLum * 2.2, 0.0, 1.0), 0.55);
  snwC = mix(snwC, snwB.rgb * (0.88 + 0.12 * snwN) * snwAo * (1.0 - 0.1 * snwA.z), clamp(snwK, 0.0, 1.0));
  baseColor = vec4(snwC, baseColor.a);
}
#endif
`

/** The Classic plugin's snippets (CUSTOM_FRAGMENT_DEFINITIONS, CUSTOM_FRAGMENT_UPDATE_DIFFUSE). */
export function snowStdCode(lang: 'wgsl' | 'glsl'): Record<string, string> {
  const w = lang === 'wgsl'
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef SNOWC\n${w ? NOISE_WGSL : NOISE_GLSL}#endif\n`,
    CUSTOM_FRAGMENT_UPDATE_DIFFUSE: w ? STD_WGSL : STD_GLSL,
  }
}

// ---- Classic terrain (shader-chunks.ts terrain points; behind SRO_SNOW, set by WorldWinter on the terrain). The
// facet normal comes from the world-position derivatives (forced up: Babylon rewrites dpdy on WebGPU only). preLight
// decides the cover from the unlit albedo; postLight lays the snow lit by the same light the ground got (the lit colour
// over the unlit albedo), so it darkens at night and in the baked shadows like the ground. ----

const TERRAIN_SAMPLERS_WGSL = `#ifdef SRO_SNOW\nvar<private> snwKeep: f32;\nvar<private> snwSnow: vec3f;\n${NOISE_WGSL}#endif\n`
const TERRAIN_SAMPLERS_GLSL = `#ifdef SRO_SNOW\nfloat snwKeep;\nvec3 snwSnow;\n${NOISE_GLSL}#endif\n`

const TERRAIN_PRE_WGSL = /* wgsl */ `#ifdef SRO_SNOW
  {
    let snwDx = dpdx(fragmentInputs.vWorld);
    let snwDy = dpdy(fragmentInputs.vWorld);
    var snwNrm = normalize(cross(snwDx, snwDy));
    snwNrm = snwNrm * sign(snwNrm.y);
    let snwP = fragmentInputs.vWorld;
    let snwN = snwFbm(snwP.xz * 0.45);
    let snwN2 = snwFbm(snwP.xz * 0.07 + vec2f(3.1, 7.7));
    let snwT = 1.0 - uniforms.snwA.x * 1.2;
    let snwF = smoothstep(0.6, 0.8, snwNrm.y + (snwN - 0.5) * 0.3) * (0.62 + 0.38 * (snwN2 * 0.6 + snwN * 0.4));
    let snwL = dot(color, vec3f(0.3, 0.55, 0.15));
    color = mix(color, vec3f(snwL) * vec3f(0.96, 0.98, 1.02), 0.25 * uniforms.snwA.y * (1.0 - uniforms.snwA.w));
    let snwAo = mix(1.0, 0.64 + 0.5 * clamp(snwL * 2.2, 0.0, 1.0), 0.55);
    snwKeep = smoothstep(snwT, snwT + 0.22, snwF);
    snwSnow = uniforms.snwB.rgb * (0.88 + 0.12 * snwN) * snwAo * (1.0 - 0.1 * uniforms.snwA.z);
  }
#endif
`
const TERRAIN_PRE_GLSL = /* glsl */ `#ifdef SRO_SNOW
  {
    vec3 snwDx = dFdx(vWorld);
    vec3 snwDy = dFdy(vWorld);
    vec3 snwNrm = normalize(cross(snwDx, snwDy));
    snwNrm *= sign(snwNrm.y);
    vec3 snwP = vWorld;
    float snwN = snwFbm(snwP.xz * 0.45);
    float snwN2 = snwFbm(snwP.xz * 0.07 + vec2(3.1, 7.7));
    float snwT = 1.0 - snwA.x * 1.2;
    float snwF = smoothstep(0.6, 0.8, snwNrm.y + (snwN - 0.5) * 0.3) * (0.62 + 0.38 * (snwN2 * 0.6 + snwN * 0.4));
    float snwL = dot(color, vec3(0.3, 0.55, 0.15));
    color = mix(color, vec3(snwL) * vec3(0.96, 0.98, 1.02), 0.25 * snwA.y * (1.0 - snwA.w));
    float snwAo = mix(1.0, 0.64 + 0.5 * clamp(snwL * 2.2, 0.0, 1.0), 0.55);
    snwKeep = smoothstep(snwT, snwT + 0.22, snwF);
    snwSnow = snwB.rgb * (0.88 + 0.12 * snwN) * snwAo * (1.0 - 0.1 * snwA.z);
  }
#endif
`
const TERRAIN_POST_WGSL = /* wgsl */ `#ifdef SRO_SNOW
  {
    let snwLit = clamp(dot(color, vec3f(0.3, 0.55, 0.15)) / max(dot(albedo, vec3f(0.3, 0.55, 0.15)), 0.02), 0.0, 1.6);
    color = mix(color, snwSnow * snwLit, clamp(snwKeep, 0.0, 1.0));
  }
#endif
`
const TERRAIN_POST_GLSL = /* glsl */ `#ifdef SRO_SNOW
  {
    float snwLit = clamp(dot(color, vec3(0.3, 0.55, 0.15)) / max(dot(albedo, vec3(0.3, 0.55, 0.15)), 0.02), 0.0, 1.6);
    color = mix(color, snwSnow * snwLit, clamp(snwKeep, 0.0, 1.0));
  }
#endif
`

// ---- grass (every grass shader: the Classic scatter, the field and the meadow ring). vertexSway: frost flattens the
// blades (to 45 %) and the snow buries a share of them (cover); fragmentColor: the frost pales them toward a cold grey,
// keeping their light (luminance-preserving, so it works lit or HDR). ----

const GRASS_SWAY_WGSL = /* wgsl */ `#ifdef SRO_SNOW
  {
    let snwH = 1.0 - 0.55 * clamp(uniforms.snwA.y, 0.0, 1.0);
    let snwGone = step(fract(sin(dot(root.xz, vec2f(12.9898, 78.233))) * 43758.5453), uniforms.snwA.x * 0.45);
    p = vec3f(p.x, root.y + (p.y - root.y) * snwH * (1.0 - snwGone), p.z);
  }
#endif
`
const GRASS_SWAY_GLSL = /* glsl */ `#ifdef SRO_SNOW
  {
    float snwH = 1.0 - 0.55 * clamp(snwA.y, 0.0, 1.0);
    float snwGone = step(fract(sin(dot(root.xz, vec2(12.9898, 78.233))) * 43758.5453), snwA.x * 0.45);
    p.y = root.y + (p.y - root.y) * snwH * (1.0 - snwGone);
  }
#endif
`
const GRASS_COLOR_WGSL = /* wgsl */ `#ifdef SRO_SNOW
  {
    let snwL = dot(rgb, vec3f(0.3, 0.55, 0.15));
    rgb = mix(rgb, vec3f(snwL) * vec3f(1.42, 1.45, 1.48) * (1.0 - 0.1 * uniforms.snwA.w), clamp(uniforms.snwA.y * 0.78, 0.0, 1.0));
  }
#endif
`
const GRASS_COLOR_GLSL = /* glsl */ `#ifdef SRO_SNOW
  {
    float snwL = dot(rgb, vec3(0.3, 0.55, 0.15));
    rgb = mix(rgb, vec3(snwL) * vec3(1.42, 1.45, 1.48) * (1.0 - 0.1 * snwA.w), clamp(snwA.y * 0.78, 0.0, 1.0));
  }
#endif
`

/** The Classic chunk pieces (winter/chunks.ts assembles WINTER_CHUNKS from these). */
export const SNOW_CHUNK_CODE = {
  terrain: {
    wgsl: { samplers: TERRAIN_SAMPLERS_WGSL, preLight: TERRAIN_PRE_WGSL, postLight: TERRAIN_POST_WGSL },
    glsl: { samplers: TERRAIN_SAMPLERS_GLSL, preLight: TERRAIN_PRE_GLSL, postLight: TERRAIN_POST_GLSL },
  },
  grass: {
    wgsl: { vertexSway: GRASS_SWAY_WGSL, fragmentColor: GRASS_COLOR_WGSL },
    glsl: { vertexSway: GRASS_SWAY_GLSL, fragmentColor: GRASS_COLOR_GLSL },
  },
} as const
