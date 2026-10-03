/**
 * The modern sky dome (docs/SKY.md §4, §5): hand-written WGSL for WebGPU and GLSL ES 3.0 for WebGL2 (no GLSL ever
 * reaches the WebGPU engine; Babylon would download its converter otherwise). One fragment per sky pixel:
 *
 *   1. atmosphere: the sun and moon sky-view LUTs (u = azimuth from the light 0..π, v = Hillaire's quadratic
 *      elevation), plus a night airglow floor (the retail night SkyTop), graded toward the retail SkyTop hue;
 *   2. the sun disc (limb darkened, coloured by the transmittance), 3. the moon (the retail phase texture on a 2.2°
 *      disc, earthshine in the unlit part), 4. procedural stars on a cube-face grid in star space (G15 alpha);
 *   5. clouds: the retail cloud1 plane (Low) or lit 2.5D cumulus on a curved shell (Medium+), cirrus (High+);
 *   6. the lightning flash, 7. output: sRGB(ACES(rgb × exposure)) (outputMode 0) or linear rgb × hdrScale (1, PBR).
 *   Below the horizon the dome shows the fog colour, as retail does.
 *
 * No runtime branch at all (only preprocessor tiers and select()), so every textureSample / fwidth is in uniform
 * control flow (WGSL). Tiers are defines, set from the preset (Options only, never per frame):
 *   SKY_CLOUDS_RETAIL | SKY_CLOUDS_CUMULUS, SKY_LIGHT_TAPS 1..3, SKY_CIRRUS, SKY_DETAIL, SKY_TWINKLE, SKY_MILKYWAY.
 *
 * Uniforms (vec4 unless noted):
 *   skySun         xyz direction to the sun, w disc radiance
 *   skyMoon        xyz direction to the moon, w disc radiance (0 = hidden)
 *   skySunColor    rgb transmittance at the camera (disc colour), a sun angular radius (rad)
 *   skyParams      x exposure, y moon sky-view weight, z star alpha (retail G15), w outputMode (0 / 1)
 *   skyStarsX/Y/Z  rows of the world → star-space rotation; skyStarsX.w cells per face, skyStarsY.w density
 *   skyCloud0      xy cumulus uv offset (wind), z cover, w thickness
 *   skyCloud1      x cirrus, y darkness, z precipitation, w hdrScale
 *   skyCloudLight  rgb light on the clouds (transmittance at 1.8 km × light), a flash (0..1)
 *   skyCloudAmb    rgb cloud ambient, a moon angular radius (rad)
 *   skyCloudDir    xyz direction to the cloud light (sun, or moon at night), w unused
 *   skyFog         rgb below-horizon colour (LDR), a unused
 *   skyGrade       rgb hue grade (SKY §6.4 gradeSky), a unused
 *   skyNight       rgb airglow radiance (pre-exposure), a earthshine
 *   skyCam         xyz camera (glTF metres), w seconds
 *   skyMoonU/V     moon tangent frame (xyz), w unused
 * Samplers: skyView, moonView, cloudNoise, cloudRetail, moonTex.
 */

export const SKY_DOME_UNIFORMS = [
  'world', 'viewProjection',
  'skySun', 'skyMoon', 'skySunColor', 'skyParams', 'skyStarsX', 'skyStarsY', 'skyStarsZ',
  'skyCloud0', 'skyCloud1', 'skyCloudLight', 'skyCloudAmb', 'skyCloudDir', 'skyFog', 'skyGrade', 'skyNight',
  'skyCam', 'skyMoonU', 'skyMoonV',
]
export const SKY_DOME_SAMPLERS = ['skyView', 'moonView', 'cloudNoise', 'cloudRetail', 'moonTex']

/** Uniform names that are vec4 (everything but the two matrices). */
export const SKY_DOME_VEC4 = SKY_DOME_UNIFORMS.slice(2)

const UNIFORMS_WGSL = SKY_DOME_VEC4.map(n => `uniform ${n}: vec4f;`).join('\n')
const UNIFORMS_GLSL = SKY_DOME_VEC4.map(n => `uniform vec4 ${n};`).join('\n')

export const skyVertexWGSL = /* wgsl */ `
attribute position: vec3f;
uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
varying vDir: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let wp = uniforms.world * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.position = uniforms.viewProjection * wp;
  vertexOutputs.vDir = vertexInputs.position;
}
`

export const skyFragmentWGSL = /* wgsl */ `
var skyView: texture_2d<f32>;
var skyViewSampler: sampler;
var moonView: texture_2d<f32>;
var moonViewSampler: sampler;
var cloudNoise: texture_2d<f32>;
var cloudNoiseSampler: sampler;
var cloudRetail: texture_2d<f32>;
var cloudRetailSampler: sampler;
var moonTex: texture_2d<f32>;
var moonTexSampler: sampler;
${UNIFORMS_WGSL}
varying vDir: vec3f;

const SKY_PI = 3.14159265;
const SKY_EARTH_KM = 6360.0;

fn skyLutUV(dir: vec3f, light: vec3f) -> vec2f {
  let dh = vec2f(dir.x, dir.z);
  let lh = vec2f(light.x, light.z);
  let dl = length(dh);
  let ll = length(lh);
  let a = select(vec2f(1.0, 0.0), dh / max(dl, 1e-6), dl > 1e-5);
  let b = select(vec2f(1.0, 0.0), lh / max(ll, 1e-6), ll > 1e-5);
  let u = acos(clamp(dot(a, b), -1.0, 1.0)) / SKY_PI;
  let el = asin(clamp(dir.y, -1.0, 1.0));
  let v = 0.5 + 0.5 * sign(el) * sqrt(min(abs(el) / (SKY_PI * 0.5), 1.0));
  return vec2f(u, v);
}

fn skyShell(sinEl: f32, hKm: f32) -> f32 {
  let s = clamp(sinEl, 0.0, 1.0);
  let t = s / max(sqrt(1.0 - s * s), 1e-4);
  return 2.0 * hKm / (t + sqrt(t * t + 2.0 * hKm / SKY_EARTH_KM));
}

fn skyHG(mu: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * SKY_PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

fn skyAces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn skyHash3(p: vec3f) -> vec3f {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

fn skyLum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let dir = normalize(fragmentInputs.vDir);
  let sunD = uniforms.skySun.xyz;
  let moonD = uniforms.skyMoon.xyz;
  let exposure = uniforms.skyParams.x;
  let precip = uniforms.skyCloud1.z;
  let up = clamp(dir.y, 0.0, 1.0);
  let hdir = select(vec2f(1.0, 0.0), normalize(vec2f(dir.x, dir.z) + vec2f(1e-7, 0.0)), length(vec2f(dir.x, dir.z)) > 1e-5);

  // Star space and the pixel footprint first (fwidth in uniform control flow).
  let sd = vec3f(dot(uniforms.skyStarsX.xyz, dir), dot(uniforms.skyStarsY.xyz, dir), dot(uniforms.skyStarsZ.xyz, dir));
  let fw = length(fwidth(sd));

  // 1. atmosphere
  var rgb = textureSample(skyView, skyViewSampler, skyLutUV(dir, sunD)).rgb;
  rgb = rgb + textureSample(moonView, moonViewSampler, skyLutUV(dir, moonD)).rgb * uniforms.skyParams.y;
  rgb = rgb + uniforms.skyNight.rgb * mix(0.35, 1.0, up);
  rgb = rgb * uniforms.skyGrade.rgb;
  let atmo = rgb;

  // 2. sun disc
  let sunA = length(cross(dir, sunD));
  let sunR = uniforms.skySunColor.a;
  let sunFw = max(fwidth(sunA), 1e-5);
  let inSun = smoothstep(sunR + sunFw, sunR - sunFw, sunA) * step(0.0, dot(dir, sunD));
  let muSun = sqrt(max(1.0 - (sunA / sunR) * (sunA / sunR), 0.0));
  rgb = rgb + uniforms.skySunColor.rgb * (uniforms.skySun.w * inSun * (1.0 - 0.6 * (1.0 - muSun * muSun)) * (1.0 - precip));

  // 3. moon: the retail phase texture on its disc; the texture alpha masks the disc
  let moonR = uniforms.skyCloudAmb.a;
  let tr = tan(moonR);
  let mu2 = vec2f(dot(dir, uniforms.skyMoonU.xyz), dot(dir, uniforms.skyMoonV.xyz)) / tr;
  let inMoon = step(0.0, dot(dir, moonD)) * (1.0 - smoothstep(0.96, 1.0, length(mu2)));
  let mt = textureSampleLevel(moonTex, moonTexSampler, clamp(mu2 * vec2f(0.5, -0.5) + 0.5, vec2f(0.0), vec2f(1.0)), 0.0);
  let moonMask = inMoon * mt.a;
  let moonLit = mt.rgb * mt.rgb * vec3f(0.9, 0.95, 1.05) + vec3f(uniforms.skyNight.a);
  rgb = rgb + moonLit * (uniforms.skyMoon.w * moonMask * (1.0 - precip));

  // 5. clouds, over everything above (composited in radiance, before exposure)
  let cloudL = uniforms.skyCloudDir.xyz;
  let muC = dot(dir, cloudL);
  var cloudA = 0.0;
#ifdef SKY_CIRRUS
  {
    let dC = skyShell(max(up, 0.002), 8.0);
    let uvC = (uniforms.skyCam.xz * 0.001 + hdir * dC) / 25.0 + uniforms.skyCloud0.xy * 0.5 + vec2f(0.31, 0.77);
    let b = textureSample(cloudNoise, cloudNoiseSampler, uvC).b;
    let aC = uniforms.skyCloud1.x * 0.7 * smoothstep(0.45, 0.9, b) * (1.0 - smoothstep(60.0, 160.0, dC)) * smoothstep(0.0, 0.05, dir.y);
    let colC = uniforms.skyCloudLight.rgb * (0.35 + skyHG(muC, 0.5) * 2.0) + uniforms.skyCloudAmb.rgb;
    rgb = mix(rgb, colC, aC);
    cloudA = aC;
  }
#endif
  let dK = skyShell(max(up, 0.002), 1.8);
  let uvK = (uniforms.skyCam.xz * 0.001 + hdir * dK) / 9.0 + uniforms.skyCloud0.xy;
  let fadeK = (1.0 - smoothstep(30.0, 80.0, dK)) * smoothstep(0.0, 0.03, dir.y);
  // W9 LOOK: the overcast deck. As the cover closes (0.7 → 0.98) a uniform cloud layer fills the gaps down to the
  // horizon, so a full overcast or a storm shows no blue (radiance() and the ambient hide the sky over the same range:
  // sky-system.ts cloudSkyWeight). The layers below draw their shapes over it.
  {
    let deck = smoothstep(0.7, 0.98, uniforms.skyCloud0.z) * smoothstep(-0.02, 0.02, dir.y);
    let deckCol = uniforms.skyCloudAmb.rgb * 0.65 + uniforms.skyCloudLight.rgb * (0.06 + skyHG(muC, 0.3) * 0.3);
    rgb = mix(rgb, deckCol, deck);
    cloudA = max(cloudA, deck);
  }
#ifdef SKY_CLOUDS_RETAIL
  {
    let tex = textureSample(cloudRetail, cloudRetailSampler, uvK * 1.5).r;
    let a = clamp((tex * tex - (1.0 - uniforms.skyCloud0.z)) / max(uniforms.skyCloud0.z, 0.05), 0.0, 1.0) * fadeK;
    let col = uniforms.skyCloudLight.rgb * (0.2 + skyHG(muC, 0.6) * 1.5) * tex + uniforms.skyCloudAmb.rgb;
    rgb = mix(rgb, col, a);
    cloudA = max(cloudA, a);
  }
#endif
#ifdef SKY_CLOUDS_CUMULUS
  {
    let cover = uniforms.skyCloud0.z;
    let thick = uniforms.skyCloud0.w;
    let low = textureSample(cloudNoise, cloudNoiseSampler, uvK * 0.25).a;
    let cov = clamp(cover + (low - 0.5) * 0.3 * (1.0 - cover), 0.001, 1.0);
    let shapeN = textureSample(cloudNoise, cloudNoiseSampler, uvK).r;
    let shape = clamp((shapeN - (1.0 - cov)) / cov, 0.0, 1.0);
    let det = textureSample(cloudNoise, cloudNoiseSampler, uvK * 6.3).g;
    var dens = clamp(shape - (1.0 - det) * 0.35 * (1.0 - shape), 0.0, 1.0);
#ifdef SKY_DETAIL
    let det2 = textureSample(cloudNoise, cloudNoiseSampler, uvK * 17.0).g;
    dens = clamp(dens - (1.0 - det2) * 0.15 * (1.0 - dens), 0.0, 1.0);
#endif
    let lo = cloudL.xz;
    var tow = textureSample(cloudNoise, cloudNoiseSampler, uvK + lo * 0.012).r;
#if SKY_LIGHT_TAPS > 1
    tow = tow + textureSample(cloudNoise, cloudNoiseSampler, uvK + lo * 0.03).r;
#endif
#if SKY_LIGHT_TAPS > 2
    tow = tow + textureSample(cloudNoise, cloudNoiseSampler, uvK + lo * 0.055).r;
#endif
    tow = tow / f32(SKY_LIGHT_TAPS);
    let towD = clamp((tow - (1.0 - cov)) / cov, 0.0, 1.0);
    let lightT = exp(-towD * 2.5 * thick);
    let powder = 1.0 - exp(-dens * 8.0);
    let silver = skyHG(muC, 0.6) * 0.4 + skyHG(muC, -0.2) * 0.6;
    let col = uniforms.skyCloudLight.rgb * (lightT * powder * silver * 4.0 * SKY_PI) + uniforms.skyCloudAmb.rgb * mix(0.6, 1.0, 1.0 - dens * 0.5);
    let a = (1.0 - exp(-dens * 6.0 * thick)) * fadeK;
    rgb = mix(rgb, col, a);
    cloudA = max(cloudA, a);
  }
#endif

  // rain: a greyer, flatter sky
  rgb = mix(rgb, vec3f(skyLum(rgb)), 0.3 * precip);

  // 4. stars (LDR, after the exposure; hidden by clouds, the moon and a bright sky)
  let cells = uniforms.skyStarsX.w;
  let ad = abs(sd);
  let isX = ad.x >= ad.y && ad.x >= ad.z;
  let isY = !isX && ad.y >= ad.z;
  let major = max(select(select(ad.z, ad.y, isY), ad.x, isX), 1e-4);
  let fuv = select(select(sd.xy, sd.xz, isY), sd.yz, isX) / major;
  let face = select(select(4.0, 2.0, isY), 0.0, isX) + step(0.0, select(select(sd.z, sd.y, isY), sd.x, isX));
  let g = (fuv * 0.5 + 0.5) * cells;
  let cell = floor(g);
  let h = skyHash3(vec3f(cell, face * 17.0 + 3.0));
  let h2 = skyHash3(vec3f(cell.yx + 11.0, face * 5.0 + 1.0));
  let center = cell + 0.2 + 0.6 * h.yz;
  let rPx = max(fw * cells * 0.5 * 1.3, 0.02);
  let disc = smoothstep(rPx, 0.0, length(g - center)) * step(1.0 - uniforms.skyStarsY.w, h.x);
  var twinkle = 1.0;
#ifdef SKY_TWINKLE
  twinkle = 0.8 + 0.2 * sin(uniforms.skyCam.w * (3.0 + 5.0 * h2.z) + h2.x * 6.28);
#endif
  let starCol = mix(vec3f(1.0, 0.78, 0.6), vec3f(0.72, 0.82, 1.0), h2.y) * (0.3 + 3.0 * pow(h2.x, 6.0)) * twinkle;
  let exposed = rgb * exposure;
  let starVis = uniforms.skyParams.z * (1.0 - cloudA) * (1.0 - moonMask) * clamp(1.0 - 40.0 * skyLum(atmo * exposure), 0.0, 1.0) * (1.0 - precip) * smoothstep(0.0, 0.05, dir.y);
  var stars = starCol * disc * starVis;
#ifdef SKY_MILKYWAY
  {
    let band = exp(-sd.z * sd.z * 30.0);
    let mw = textureSample(cloudNoise, cloudNoiseSampler, sd.xy * 1.7 + vec2f(0.5)).b;
    stars = stars + vec3f(0.55, 0.6, 0.75) * (band * mw * mw * 0.12 * starVis);
  }
#endif

  // 6, 7. output
  let flash = uniforms.skyCloudLight.a * vec3f(0.8, 0.85, 1.0) * (0.3 + 0.7 * cloudA);
  let ldr = pow(skyAces(exposed), vec3f(1.0 / 2.2)) + stars + flash;
  let hdr = rgb * uniforms.skyCloud1.w + (stars + flash) / max(exposure, 1e-3);
  let fogL = uniforms.skyFog.rgb;
  // outputMode 1: SkySystem writes skyFog scene-linear already (the post's display transform inverted, D4).
  let fogH = fogL;
  let above = smoothstep(-0.02, 0.01, dir.y);
  let isHdr = uniforms.skyParams.w > 0.5;
  let outC = select(mix(fogL, ldr, above), mix(fogH, hdr, above), isHdr);
  fragmentOutputs.color = vec4f(outC, 1.0);
}
`

export const skyVertexGLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vDir;

void main(void) {
  vec4 wp = world * vec4(position, 1.0);
  gl_Position = viewProjection * wp;
  vDir = position;
}
`

export const skyFragmentGLSL = /* glsl */ `
precision highp float;
uniform sampler2D skyView;
uniform sampler2D moonView;
uniform sampler2D cloudNoise;
uniform sampler2D cloudRetail;
uniform sampler2D moonTex;
${UNIFORMS_GLSL}
varying vec3 vDir;

#define SKY_PI 3.14159265
#define SKY_EARTH_KM 6360.0

vec2 skyLutUV(vec3 dir, vec3 light) {
  vec2 dh = dir.xz;
  vec2 lh = light.xz;
  float dl = length(dh);
  float ll = length(lh);
  vec2 a = dl > 1e-5 ? dh / dl : vec2(1.0, 0.0);
  vec2 b = ll > 1e-5 ? lh / ll : vec2(1.0, 0.0);
  float u = acos(clamp(dot(a, b), -1.0, 1.0)) / SKY_PI;
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(min(abs(el) / (SKY_PI * 0.5), 1.0));
  return vec2(u, v);
}

float skyShell(float sinEl, float hKm) {
  float s = clamp(sinEl, 0.0, 1.0);
  float t = s / max(sqrt(1.0 - s * s), 1e-4);
  return 2.0 * hKm / (t + sqrt(t * t + 2.0 * hKm / SKY_EARTH_KM));
}

float skyHG(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * SKY_PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

vec3 skyAces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 skyHash3(vec3 p) {
  vec3 q = fract(p * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

float skyLum(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main(void) {
  vec3 dir = normalize(vDir);
  vec3 sunD = skySun.xyz;
  vec3 moonD = skyMoon.xyz;
  float exposure = skyParams.x;
  float precip = skyCloud1.z;
  float up = clamp(dir.y, 0.0, 1.0);
  vec2 hdir = length(dir.xz) > 1e-5 ? normalize(dir.xz) : vec2(1.0, 0.0);

  vec3 sd = vec3(dot(skyStarsX.xyz, dir), dot(skyStarsY.xyz, dir), dot(skyStarsZ.xyz, dir));
  float fw = length(fwidth(sd));

  // 1. atmosphere
  vec3 rgb = texture(skyView, skyLutUV(dir, sunD)).rgb;
  rgb += texture(moonView, skyLutUV(dir, moonD)).rgb * skyParams.y;
  rgb += skyNight.rgb * mix(0.35, 1.0, up);
  rgb *= skyGrade.rgb;
  vec3 atmo = rgb;

  // 2. sun disc
  float sunA = length(cross(dir, sunD));
  float sunR = skySunColor.a;
  float sunFw = max(fwidth(sunA), 1e-5);
  float inSun = smoothstep(sunR + sunFw, sunR - sunFw, sunA) * step(0.0, dot(dir, sunD));
  float muSun = sqrt(max(1.0 - (sunA / sunR) * (sunA / sunR), 0.0));
  rgb += skySunColor.rgb * (skySun.w * inSun * (1.0 - 0.6 * (1.0 - muSun * muSun)) * (1.0 - precip));

  // 3. moon
  float moonR = skyCloudAmb.a;
  float tr = tan(moonR);
  vec2 mu2 = vec2(dot(dir, skyMoonU.xyz), dot(dir, skyMoonV.xyz)) / tr;
  float inMoon = step(0.0, dot(dir, moonD)) * (1.0 - smoothstep(0.96, 1.0, length(mu2)));
  vec4 mt = textureLod(moonTex, clamp(mu2 * vec2(0.5, -0.5) + 0.5, 0.0, 1.0), 0.0);
  float moonMask = inMoon * mt.a;
  vec3 moonLit = mt.rgb * mt.rgb * vec3(0.9, 0.95, 1.05) + vec3(skyNight.a);
  rgb += moonLit * (skyMoon.w * moonMask * (1.0 - precip));

  // 5. clouds
  vec3 cloudL = skyCloudDir.xyz;
  float muC = dot(dir, cloudL);
  float cloudA = 0.0;
#ifdef SKY_CIRRUS
  {
    float dC = skyShell(max(up, 0.002), 8.0);
    vec2 uvC = (skyCam.xz * 0.001 + hdir * dC) / 25.0 + skyCloud0.xy * 0.5 + vec2(0.31, 0.77);
    float b = texture(cloudNoise, uvC).b;
    float aC = skyCloud1.x * 0.7 * smoothstep(0.45, 0.9, b) * (1.0 - smoothstep(60.0, 160.0, dC)) * smoothstep(0.0, 0.05, dir.y);
    vec3 colC = skyCloudLight.rgb * (0.35 + skyHG(muC, 0.5) * 2.0) + skyCloudAmb.rgb;
    rgb = mix(rgb, colC, aC);
    cloudA = aC;
  }
#endif
  float dK = skyShell(max(up, 0.002), 1.8);
  vec2 uvK = (skyCam.xz * 0.001 + hdir * dK) / 9.0 + skyCloud0.xy;
  float fadeK = (1.0 - smoothstep(30.0, 80.0, dK)) * smoothstep(0.0, 0.03, dir.y);
  // W9 LOOK: the overcast deck (see the WGSL twin).
  {
    float deck = smoothstep(0.7, 0.98, skyCloud0.z) * smoothstep(-0.02, 0.02, dir.y);
    vec3 deckCol = skyCloudAmb.rgb * 0.65 + skyCloudLight.rgb * (0.06 + skyHG(muC, 0.3) * 0.3);
    rgb = mix(rgb, deckCol, deck);
    cloudA = max(cloudA, deck);
  }
#ifdef SKY_CLOUDS_RETAIL
  {
    float tex = texture(cloudRetail, uvK * 1.5).r;
    float a = clamp((tex * tex - (1.0 - skyCloud0.z)) / max(skyCloud0.z, 0.05), 0.0, 1.0) * fadeK;
    vec3 col = skyCloudLight.rgb * (0.2 + skyHG(muC, 0.6) * 1.5) * tex + skyCloudAmb.rgb;
    rgb = mix(rgb, col, a);
    cloudA = max(cloudA, a);
  }
#endif
#ifdef SKY_CLOUDS_CUMULUS
  {
    float cover = skyCloud0.z;
    float thick = skyCloud0.w;
    float low = texture(cloudNoise, uvK * 0.25).a;
    float cov = clamp(cover + (low - 0.5) * 0.3 * (1.0 - cover), 0.001, 1.0);
    float shapeN = texture(cloudNoise, uvK).r;
    float shape = clamp((shapeN - (1.0 - cov)) / cov, 0.0, 1.0);
    float det = texture(cloudNoise, uvK * 6.3).g;
    float dens = clamp(shape - (1.0 - det) * 0.35 * (1.0 - shape), 0.0, 1.0);
#ifdef SKY_DETAIL
    float det2 = texture(cloudNoise, uvK * 17.0).g;
    dens = clamp(dens - (1.0 - det2) * 0.15 * (1.0 - dens), 0.0, 1.0);
#endif
    vec2 lo = cloudL.xz;
    float tow = texture(cloudNoise, uvK + lo * 0.012).r;
#if SKY_LIGHT_TAPS > 1
    tow += texture(cloudNoise, uvK + lo * 0.03).r;
#endif
#if SKY_LIGHT_TAPS > 2
    tow += texture(cloudNoise, uvK + lo * 0.055).r;
#endif
    tow /= float(SKY_LIGHT_TAPS);
    float towD = clamp((tow - (1.0 - cov)) / cov, 0.0, 1.0);
    float lightT = exp(-towD * 2.5 * thick);
    float powder = 1.0 - exp(-dens * 8.0);
    float silver = skyHG(muC, 0.6) * 0.4 + skyHG(muC, -0.2) * 0.6;
    vec3 col = skyCloudLight.rgb * (lightT * powder * silver * 4.0 * SKY_PI) + skyCloudAmb.rgb * mix(0.6, 1.0, 1.0 - dens * 0.5);
    float a = (1.0 - exp(-dens * 6.0 * thick)) * fadeK;
    rgb = mix(rgb, col, a);
    cloudA = max(cloudA, a);
  }
#endif

  rgb = mix(rgb, vec3(skyLum(rgb)), 0.3 * precip);

  // 4. stars
  float cells = skyStarsX.w;
  vec3 ad = abs(sd);
  bool isX = ad.x >= ad.y && ad.x >= ad.z;
  bool isY = !isX && ad.y >= ad.z;
  float major = max(isX ? ad.x : (isY ? ad.y : ad.z), 1e-4);
  vec2 fuv = (isX ? sd.yz : (isY ? sd.xz : sd.xy)) / major;
  float face = (isX ? 0.0 : (isY ? 2.0 : 4.0)) + step(0.0, isX ? sd.x : (isY ? sd.y : sd.z));
  vec2 g = (fuv * 0.5 + 0.5) * cells;
  vec2 cell = floor(g);
  vec3 h = skyHash3(vec3(cell, face * 17.0 + 3.0));
  vec3 h2 = skyHash3(vec3(cell.yx + 11.0, face * 5.0 + 1.0));
  vec2 center = cell + 0.2 + 0.6 * h.yz;
  float rPx = max(fw * cells * 0.5 * 1.3, 0.02);
  float disc = smoothstep(rPx, 0.0, length(g - center)) * step(1.0 - skyStarsY.w, h.x);
  float twinkle = 1.0;
#ifdef SKY_TWINKLE
  twinkle = 0.8 + 0.2 * sin(skyCam.w * (3.0 + 5.0 * h2.z) + h2.x * 6.28);
#endif
  vec3 starCol = mix(vec3(1.0, 0.78, 0.6), vec3(0.72, 0.82, 1.0), h2.y) * (0.3 + 3.0 * pow(h2.x, 6.0)) * twinkle;
  vec3 exposed = rgb * exposure;
  float starVis = skyParams.z * (1.0 - cloudA) * (1.0 - moonMask) * clamp(1.0 - 40.0 * skyLum(atmo * exposure), 0.0, 1.0) * (1.0 - precip) * smoothstep(0.0, 0.05, dir.y);
  vec3 stars = starCol * disc * starVis;
#ifdef SKY_MILKYWAY
  {
    float band = exp(-sd.z * sd.z * 30.0);
    float mw = texture(cloudNoise, sd.xy * 1.7 + vec2(0.5)).b;
    stars += vec3(0.55, 0.6, 0.75) * (band * mw * mw * 0.12 * starVis);
  }
#endif

  vec3 flash = skyCloudLight.a * vec3(0.8, 0.85, 1.0) * (0.3 + 0.7 * cloudA);
  vec3 ldr = pow(skyAces(exposed), vec3(1.0 / 2.2)) + stars + flash;
  vec3 hdr = rgb * skyCloud1.w + (stars + flash) / max(exposure, 1e-3);
  vec3 fogL = skyFog.rgb;
  // outputMode 1: SkySystem writes skyFog scene-linear already (the post's display transform inverted, D4).
  vec3 fogH = fogL;
  float above = smoothstep(-0.02, 0.01, dir.y);
  vec3 outC = skyParams.w > 0.5 ? mix(fogH, hdr, above) : mix(fogL, ldr, above);
  gl_FragColor = vec4(outC, 1.0);
}
`
