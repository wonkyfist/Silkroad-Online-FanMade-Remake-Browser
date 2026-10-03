// Golden copies of the Classic shader strings at HEAD 02cd8d8 (packages/world-render/src/shaders.ts and
// scatter-assets.ts), taken before the wave-9 chunk seams. seams-classic.test.ts asserts that the generated shaders
// with every chunk empty equal these byte for byte (the Low guard, docs/WAVE_PLAN3.md §4.4). Never edit.

// Hand-written shader pairs (WGSL for WebGPU, GLSL ES 3.0 for WebGL2) for the terrain and the water.
// No GLSL ever reaches the WebGPU engine (that would trigger Babylon's glslang/twgsl download from its CDN).
// Babylon dialects: WGSL `attribute`/`varying`/`uniform` declarations are rewritten by its WGSL processor
// (uniforms end up in one UBO read as `uniforms.x`); GLSL `attribute`/`varying`/`gl_FragColor` become ES 3.0 in/out.
//
// Terrain (docs/TERRAIN.md 2.2, 2.3, 3.1, 5.2, 8.1):
//   vLocal        region-local FILE units (0..1920), from the `uv` attribute; x east, y = file z (north)
//   tile UV       vLocal / period(code), periods 80/160/80/40/20 units, gradients taken once from the continuous
//                 coordinate (uniform control flow) and scaled per layer
//   layer map     96 x (96 * L) RGBA8, texel (cx, k * 96 + cz) = [array layer, tiling code, mask4, 255 | 0]
//                 (the TerrainBin layer planes with the tile id remapped to the tile array layer on the CPU)
//   blending      layer 0 opaque, later layers mix with alpha = bilinear of the mask4 corner bits
//                 (bit 0 (cx, cz), 1 (cx+1, cz), 2 (cx, cz+1), 3 (cx+1, cz+1))
//   lightmap      u = (0.5 + 511 lx / 1920) / 512 (likewise v with lz), LOD bias -0.5,
//                 colour *= saturate(lightmap + TerrainShadowColor)   (1x modulate)
//   fog           linear on view-space depth, terrain fog colour = sqrt(saturate(FogColor)) (set by the caller)
//   viewParams    x: lightmap on, y: unused, z: debug view (0 textured, 1 layer count, 2 lightmap only,
//                 3 first layer only, 4 tile ids)

export const TERRAIN_UNIFORMS = ['world', 'view', 'viewProjection', 'layerCount', 'fogParams', 'fogColor', 'shadowColor', 'viewParams']
export const TERRAIN_SAMPLERS = ['tiles', 'layerMap', 'lightmap']

export const terrainVertexWGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
uniform world: mat4x4f;
uniform view: mat4x4f;
uniform viewProjection: mat4x4f;
varying vLocal: vec2f;
varying vDepth: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let wp = uniforms.world * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.position = uniforms.viewProjection * wp;
  vertexOutputs.vLocal = vertexInputs.uv;
  vertexOutputs.vDepth = abs((uniforms.view * wp).z);
}
`

export const terrainFragmentWGSL = /* wgsl */ `
var tiles: texture_2d_array<f32>;
var tilesSampler: sampler;
var layerMap: texture_2d<f32>;
var lightmap: texture_2d<f32>;
var lightmapSampler: sampler;
uniform layerCount: f32;
uniform fogParams: vec4f;
uniform fogColor: vec4f;
uniform shadowColor: vec4f;
uniform viewParams: vec4f;
varying vLocal: vec2f;
varying vDepth: f32;

fn periodFor(code: i32) -> f32 {
  if (code == 1) { return 160.0; }
  if (code == 3) { return 40.0; }
  if (code == 4) { return 20.0; }
  return 80.0;
}

fn idColor(id: f32) -> vec3f {
  return fract(sin(vec3f(id + 1.0) * vec3f(12.9898, 78.233, 37.719)) * 43758.5453);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let lp = fragmentInputs.vLocal;
  let gx = dpdx(lp);
  let gy = dpdy(lp);
  let lmUv = (vec2f(0.5) + lp * (511.0 / 1920.0)) / 512.0;
  let lm = textureSampleBias(lightmap, lightmapSampler, lmUv, -0.5).rgb;
  let cf = lp / 20.0;
  let cellF = clamp(floor(cf), vec2f(0.0), vec2f(95.0));
  let fr = clamp(cf - cellF, vec2f(0.0), vec2f(1.0));
  let cell = vec2i(cellF);
  let n = i32(uniforms.layerCount + 0.5);
  let dmode = i32(uniforms.viewParams.z + 0.5);
  var color = vec3f(0.0);
  var drawn = 0;
  var firstIdx = 0.0;
  for (var k = 0; k < 8; k++) {
    if (k >= n) { break; }
    let t = textureLoad(layerMap, vec2i(cell.x, k * 96 + cell.y), 0);
    if (t.a < 0.5) { break; }
    let idx = i32(t.r * 255.0 + 0.5);
    let code = i32(t.g * 255.0 + 0.5);
    let m = u32(t.b * 255.0 + 0.5);
    let p = periodFor(code);
    let c = textureSampleGrad(tiles, tilesSampler, lp / p, idx, gx / p, gy / p).rgb;
    let b0 = f32(m & 1u);
    let b1 = f32((m >> 1u) & 1u);
    let b2 = f32((m >> 2u) & 1u);
    let b3 = f32((m >> 3u) & 1u);
    let a = mix(mix(b0, b1, fr.x), mix(b2, b3, fr.x), fr.y);
    if (k == 0) {
      color = c;
      firstIdx = f32(idx);
    } else if (dmode != 3) {
      color = mix(color, c, a);
    }
    drawn = k + 1;
  }
  if (dmode == 1) {
    let h = f32(drawn) / 7.0;
    color = clamp(vec3f(2.0 * h - 0.5, 1.5 - abs(4.0 * h - 2.0), 1.0 - 2.0 * h), vec3f(0.0), vec3f(1.0));
  } else if (dmode == 2) {
    color = vec3f(1.0);
  } else if (dmode == 4) {
    color = idColor(firstIdx);
  }
  if (uniforms.viewParams.x > 0.5 || dmode == 2) {
    color = color * clamp(lm + uniforms.shadowColor.rgb, vec3f(0.0), vec3f(1.0));
  }
  if (uniforms.fogParams.z > 0.5) {
    let ff = clamp((fragmentInputs.vDepth - uniforms.fogParams.x) / max(uniforms.fogParams.y - uniforms.fogParams.x, 0.001), 0.0, 1.0);
    color = mix(color, uniforms.fogColor.rgb, ff);
  }
  fragmentOutputs.color = vec4f(color, 1.0);
}
`

export const terrainVertexGLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
varying vec2 vLocal;
varying float vDepth;

void main(void) {
  vec4 wp = world * vec4(position, 1.0);
  gl_Position = viewProjection * wp;
  vLocal = uv;
  vDepth = abs((view * wp).z);
}
`

export const terrainFragmentGLSL = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
uniform sampler2DArray tiles;
uniform sampler2D layerMap;
uniform sampler2D lightmap;
uniform float layerCount;
uniform vec4 fogParams;
uniform vec4 fogColor;
uniform vec4 shadowColor;
uniform vec4 viewParams;
varying vec2 vLocal;
varying float vDepth;

float periodFor(int code) {
  if (code == 1) return 160.0;
  if (code == 3) return 40.0;
  if (code == 4) return 20.0;
  return 80.0;
}

vec3 idColor(float id) {
  return fract(sin(vec3(id + 1.0) * vec3(12.9898, 78.233, 37.719)) * 43758.5453);
}

void main(void) {
  vec2 lp = vLocal;
  vec2 gx = dFdx(lp);
  vec2 gy = dFdy(lp);
  vec2 lmUv = (vec2(0.5) + lp * (511.0 / 1920.0)) / 512.0;
  vec3 lm = texture(lightmap, lmUv, -0.5).rgb;
  vec2 cf = lp / 20.0;
  vec2 cellF = clamp(floor(cf), vec2(0.0), vec2(95.0));
  vec2 fr = clamp(cf - cellF, vec2(0.0), vec2(1.0));
  ivec2 cell = ivec2(cellF);
  int n = int(layerCount + 0.5);
  int dmode = int(viewParams.z + 0.5);
  vec3 color = vec3(0.0);
  int drawn = 0;
  float firstIdx = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= n) break;
    vec4 t = texelFetch(layerMap, ivec2(cell.x, k * 96 + cell.y), 0);
    if (t.a < 0.5) break;
    float idx = floor(t.r * 255.0 + 0.5);
    int code = int(t.g * 255.0 + 0.5);
    int m = int(t.b * 255.0 + 0.5);
    float p = periodFor(code);
    vec3 c = textureGrad(tiles, vec3(lp / p, idx), gx / p, gy / p).rgb;
    float b0 = float(m & 1);
    float b1 = float((m >> 1) & 1);
    float b2 = float((m >> 2) & 1);
    float b3 = float((m >> 3) & 1);
    float a = mix(mix(b0, b1, fr.x), mix(b2, b3, fr.x), fr.y);
    if (k == 0) {
      color = c;
      firstIdx = idx;
    } else if (dmode != 3) {
      color = mix(color, c, a);
    }
    drawn = k + 1;
  }
  if (dmode == 1) {
    float h = float(drawn) / 7.0;
    color = clamp(vec3(2.0 * h - 0.5, 1.5 - abs(4.0 * h - 2.0), 1.0 - 2.0 * h), 0.0, 1.0);
  } else if (dmode == 2) {
    color = vec3(1.0);
  } else if (dmode == 4) {
    color = idColor(firstIdx);
  }
  if (viewParams.x > 0.5 || dmode == 2) {
    color *= clamp(lm + shadowColor.rgb, 0.0, 1.0);
  }
  if (fogParams.z > 0.5) {
    float ff = clamp((vDepth - fogParams.x) / max(fogParams.y - fogParams.x, 0.001), 0.0, 1.0);
    color = mix(color, fogColor.rgb, ff);
  }
  gl_FragColor = vec4(color, 1.0);
}
`

// Water (TERRAIN.md 4, 8.2): colour = frame texture x saturate(WaterColor), alpha = per-vertex depth alpha (color.a),
// blended SRCALPHA / INVSRCALPHA without depth write. waterParams: x = frame layer (0..29), y = fog on.
// uv = region-local file units / 80 (4 repeats per 320-unit block).

export const WATER_UNIFORMS = ['world', 'view', 'viewProjection', 'waterColor', 'waterParams', 'fogParams', 'fogColor']
export const WATER_SAMPLERS = ['frames']

export const waterVertexWGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
attribute color: vec4f;
uniform world: mat4x4f;
uniform view: mat4x4f;
uniform viewProjection: mat4x4f;
varying vUV: vec2f;
varying vAlpha: f32;
varying vDepth: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let wp = uniforms.world * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.position = uniforms.viewProjection * wp;
  vertexOutputs.vUV = vertexInputs.uv;
  vertexOutputs.vAlpha = vertexInputs.color.a;
  vertexOutputs.vDepth = abs((uniforms.view * wp).z);
}
`

export const waterFragmentWGSL = /* wgsl */ `
var frames: texture_2d_array<f32>;
var framesSampler: sampler;
uniform waterColor: vec4f;
uniform waterParams: vec4f;
uniform fogParams: vec4f;
uniform fogColor: vec4f;
varying vUV: vec2f;
varying vAlpha: f32;
varying vDepth: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let fi = i32(uniforms.waterParams.x + 0.5);
  var rgb = textureSample(frames, framesSampler, fragmentInputs.vUV, fi).rgb * clamp(uniforms.waterColor.rgb, vec3f(0.0), vec3f(1.0));
  if (uniforms.fogParams.z > 0.5) {
    let ff = clamp((fragmentInputs.vDepth - uniforms.fogParams.x) / max(uniforms.fogParams.y - uniforms.fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, uniforms.fogColor.rgb, ff);
  }
  fragmentOutputs.color = vec4f(rgb, clamp(fragmentInputs.vAlpha, 0.0, 1.0));
}
`

export const waterVertexGLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
varying vec2 vUV;
varying float vAlpha;
varying float vDepth;

void main(void) {
  vec4 wp = world * vec4(position, 1.0);
  gl_Position = viewProjection * wp;
  vUV = uv;
  vAlpha = color.a;
  vDepth = abs((view * wp).z);
}
`

export const waterFragmentGLSL = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray frames;
uniform vec4 waterColor;
uniform vec4 waterParams;
uniform vec4 fogParams;
uniform vec4 fogColor;
varying vec2 vUV;
varying float vAlpha;
varying float vDepth;

void main(void) {
  vec3 rgb = texture(frames, vec3(vUV, floor(waterParams.x + 0.5))).rgb * clamp(waterColor.rgb, 0.0, 1.0);
  if (fogParams.z > 0.5) {
    float ff = clamp((vDepth - fogParams.x) / max(fogParams.y - fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, fogColor.rgb, ff);
  }
  gl_FragColor = vec4(rgb, clamp(vAlpha, 0.0, 1.0));
}
`

export const SCATTER_UNIFORMS = ['world', 'view', 'viewProjection', 'scCamera', 'scFade', 'scRegion', 'scTint', 'scShadow', 'fogParams', 'fogColor']
export const SCATTER_SAMPLERS = ['scDiffuse', 'scLightmap']

export const scatterVertexWGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
#ifdef INSTANCES
attribute world0: vec4f;
attribute world1: vec4f;
attribute world2: vec4f;
attribute world3: vec4f;
#endif
uniform world: mat4x4f;
uniform view: mat4x4f;
uniform viewProjection: mat4x4f;
uniform scCamera: vec4f;
uniform scFade: vec4f;
uniform scRegion: vec4f;
varying vUV: vec2f;
varying vLm: vec2f;
varying vShade: f32;
varying vDepth: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
#ifdef INSTANCES
  let finalWorld = uniforms.world * mat4x4f(vertexInputs.world0, vertexInputs.world1, vertexInputs.world2, vertexInputs.world3);
#else
  let finalWorld = uniforms.world;
#endif
  let root = finalWorld[3].xyz;
  let wp = (finalWorld * vec4f(vertexInputs.position, 1.0)).xyz;
  let h = max(wp.y - root.y, 0.0);
  let d = distance(uniforms.scCamera.xz, root.xz);
  var s = 1.0 - smoothstep(uniforms.scFade.x, uniforms.scFade.y, d);
  s = s * smoothstep(uniforms.scFade.w * 0.5, uniforms.scFade.w, distance(uniforms.scCamera.xyz, root));
  let ph = dot(root.xz, vec2f(0.21, 0.17));
  let t = uniforms.scCamera.w;
  let sway = sin(t * 1.9 + ph) * 0.65 + sin(t * 3.3 + ph * 1.7) * 0.35;
  let bend = uniforms.scFade.z * h * clamp(h, 0.3, 1.0) * sway;
  var p = root + (wp - root) * s;
  p = p + vec3f(0.8, 0.0, 0.6) * (bend * s);
  vertexOutputs.position = uniforms.viewProjection * vec4f(p, 1.0);
  vertexOutputs.vUV = vertexInputs.uv;
  let l = vec2f(root.x - uniforms.scRegion.x, uniforms.scRegion.z - root.z) * 10.0;
  vertexOutputs.vLm = (vec2f(0.5) + l * (511.0 / 1920.0)) / 512.0;
  let jit = fract(sin(ph * 12.9898) * 43758.5453);
  vertexOutputs.vShade = mix(0.7, 1.0, clamp(h / 0.8, 0.0, 1.0)) * (0.88 + 0.24 * jit);
  vertexOutputs.vDepth = abs((uniforms.view * vec4f(p, 1.0)).z);
}
`

export const scatterFragmentWGSL = /* wgsl */ `
var scDiffuse: texture_2d<f32>;
var scDiffuseSampler: sampler;
var scLightmap: texture_2d<f32>;
var scLightmapSampler: sampler;
uniform scRegion: vec4f;
uniform scTint: vec4f;
uniform scShadow: vec4f;
uniform fogParams: vec4f;
uniform fogColor: vec4f;
varying vUV: vec2f;
varying vLm: vec2f;
varying vShade: f32;
varying vDepth: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let c = textureSample(scDiffuse, scDiffuseSampler, fragmentInputs.vUV);
  let lmRaw = textureSample(scLightmap, scLightmapSampler, fragmentInputs.vLm).rgb;
  if (c.a < uniforms.scTint.a) {
    discard;
  }
  let lm = mix(vec3f(1.0), lmRaw, uniforms.scRegion.y);
  var rgb = c.rgb * uniforms.scTint.rgb * clamp(lm + uniforms.scShadow.rgb, vec3f(0.0), vec3f(1.0)) * fragmentInputs.vShade;
  if (uniforms.fogParams.z > 0.5) {
    let ff = clamp((fragmentInputs.vDepth - uniforms.fogParams.x) / max(uniforms.fogParams.y - uniforms.fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, uniforms.fogColor.rgb, ff);
  }
  fragmentOutputs.color = vec4f(rgb, 1.0);
}
`

export const scatterVertexGLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
#ifdef INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#endif
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
uniform vec4 scCamera;
uniform vec4 scFade;
uniform vec4 scRegion;
varying vec2 vUV;
varying vec2 vLm;
varying float vShade;
varying float vDepth;

void main(void) {
#ifdef INSTANCES
  mat4 finalWorld = world * mat4(world0, world1, world2, world3);
#else
  mat4 finalWorld = world;
#endif
  vec3 root = finalWorld[3].xyz;
  vec3 wp = (finalWorld * vec4(position, 1.0)).xyz;
  float h = max(wp.y - root.y, 0.0);
  float d = distance(scCamera.xz, root.xz);
  float s = 1.0 - smoothstep(scFade.x, scFade.y, d);
  s *= smoothstep(scFade.w * 0.5, scFade.w, distance(scCamera.xyz, root));
  float ph = dot(root.xz, vec2(0.21, 0.17));
  float t = scCamera.w;
  float sway = sin(t * 1.9 + ph) * 0.65 + sin(t * 3.3 + ph * 1.7) * 0.35;
  float bend = scFade.z * h * clamp(h, 0.3, 1.0) * sway;
  vec3 p = root + (wp - root) * s;
  p += vec3(0.8, 0.0, 0.6) * (bend * s);
  gl_Position = viewProjection * vec4(p, 1.0);
  vUV = uv;
  vec2 l = vec2(root.x - scRegion.x, scRegion.z - root.z) * 10.0;
  vLm = (vec2(0.5) + l * (511.0 / 1920.0)) / 512.0;
  float jit = fract(sin(ph * 12.9898) * 43758.5453);
  vShade = mix(0.7, 1.0, clamp(h / 0.8, 0.0, 1.0)) * (0.88 + 0.24 * jit);
  vDepth = abs((view * vec4(p, 1.0)).z);
}
`

export const scatterFragmentGLSL = /* glsl */ `
precision highp float;
uniform sampler2D scDiffuse;
uniform sampler2D scLightmap;
uniform vec4 scRegion;
uniform vec4 scTint;
uniform vec4 scShadow;
uniform vec4 fogParams;
uniform vec4 fogColor;
varying vec2 vUV;
varying vec2 vLm;
varying float vShade;
varying float vDepth;

void main(void) {
  vec4 c = texture(scDiffuse, vUV);
  vec3 lmRaw = texture(scLightmap, vLm).rgb;
  if (c.a < scTint.a) discard;
  vec3 lm = mix(vec3(1.0), lmRaw, scRegion.y);
  vec3 rgb = c.rgb * scTint.rgb * clamp(lm + scShadow.rgb, 0.0, 1.0) * vShade;
  if (fogParams.z > 0.5) {
    float ff = clamp((vDepth - fogParams.x) / max(fogParams.y - fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, fogColor.rgb, ff);
  }
  gl_FragColor = vec4(rgb, 1.0);
}
`
