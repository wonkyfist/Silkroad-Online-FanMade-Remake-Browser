// Hand-written shader pairs (WGSL for WebGPU, GLSL ES 3.0 for WebGL2) for the terrain and the water.
// No GLSL ever reaches the WebGPU engine (that would trigger Babylon's glslang/twgsl download from its CDN).
// Wave 9 (docs/WAVE_PLAN3.md §4.2, D1): both shaders are assembled from their HEAD text plus the chunk points of
// shader-chunks.ts, filled from the lane-owned chunk files (WORLD_SHADER_CHUNKS). With every chunk empty the strings
// equal HEAD's byte for byte (test/seams-classic.test.ts). No lane edits this file.
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
//   layer alpha   128 + surface class (pbr/classes.ts TERRAIN_SURFACE) + 64 no-anti-tile (TT-Q, read `& 63`); 0 = no
//                 layer, so `t.a < 0.5` is unchanged

import { COAST_CHUNKS } from './coast/chunks.ts'
import { GRASS_TINT_CHUNKS } from './grass/chunks.ts'
import { NIGHT_CHUNKS } from './night-chunks.ts'
import { RENDER_GRASS_CHUNKS } from './render/grass-chunks.ts'
import { ChunkSet, type TerrainPoint, type WaterPoint, type WorldShaderChunks } from './shader-chunks.ts'
import { SKY_CHUNKS } from './sky/chunks.ts'
import { WEATHER_CHUNKS } from './weather/chunks.ts'
import { WINTER_CHUNKS } from './winter/chunks.ts'

/**
 * Every lane's chunks in the fixed order sky → weather → night → coast → grass tint → render → winter (docs/WAVE_PLAN3.md
 * §4.2; wave 10: docs/WAVE_PLAN6.md D11 adds CST-S's coast and GL-T's grass tint, both empty until those lanes land;
 * docs/WINTER.md §7.2: the winter lane last, so the snow lies on the tinted, lit ground and the frost on the lit grass).
 */
export const WORLD_SHADER_CHUNKS: readonly WorldShaderChunks[] = [
  SKY_CHUNKS, WEATHER_CHUNKS, NIGHT_CHUNKS, COAST_CHUNKS, GRASS_TINT_CHUNKS, RENDER_GRASS_CHUNKS, WINTER_CHUNKS,
]

/** A generated shader pair per language with its ShaderMaterial name lists. */
export interface ShaderSources {
  vertexWGSL: string
  fragmentWGSL: string
  vertexGLSL: string
  fragmentGLSL: string
  uniforms: string[]
  samplers: string[]
  /** The samplers added by chunks (a 1 x 1 black texture is bound until a lane binds one). */
  chunkSamplers: string[]
}

export type Both = { wgsl: string; glsl: string }
const NONE: Both = { wgsl: '', glsl: '' }

/** The vWorld varying declaration and vertex write, only when a chunk asks for it (the plan's SRO_VWORLD). */
export function vWorldParts(on: boolean, out: Both): { vwDecl: Both; vwOut: Both } {
  if (!on) return { vwDecl: NONE, vwOut: NONE }
  return { vwDecl: { wgsl: 'varying vWorld: vec3f;\n', glsl: 'varying vec3 vWorld;\n' }, vwOut: out }
}

export const TERRAIN_BASE_UNIFORMS = ['world', 'view', 'viewProjection', 'layerCount', 'fogParams', 'fogColor', 'shadowColor', 'viewParams']
export const TERRAIN_BASE_SAMPLERS = ['tiles', 'layerMap', 'lightmap']

/** The terrain shaders with `lanes`' chunks (tests pass their own; the renderer uses WORLD_SHADER_CHUNKS). */
export function terrainShaders(lanes: readonly WorldShaderChunks[] = WORLD_SHADER_CHUNKS): ShaderSources {
  const c: ChunkSet<TerrainPoint> = ChunkSet.of(lanes, 'terrain')
  const { vwDecl, vwOut } = vWorldParts(c.vWorld, { wgsl: '  vertexOutputs.vWorld = wp.xyz;\n', glsl: '  vWorld = wp.xyz;\n' })
  const layer: Both = {
    wgsl: c.has('wgsl', 'layer') ? `    let sroClass = i32(t.a * 255.0 + 0.5) & 63;\n${c.at('wgsl', 'layer')}` : '',
    glsl: c.has('glsl', 'layer') ? `    int sroClass = int(t.a * 255.0 + 0.5) & 63;\n${c.at('glsl', 'layer')}` : '',
  }
  const needAlbedo = (l: 'wgsl' | 'glsl') => c.has(l, 'lightTerm') || c.has(l, 'postLight')
  const pre: Both = {
    wgsl: c.at('wgsl', 'preLight') + (needAlbedo('wgsl') ? '  let albedo = color;\n' : ''),
    glsl: c.at('glsl', 'preLight') + (needAlbedo('glsl') ? '  vec3 albedo = color;\n' : ''),
  }
  const light: Both = {
    wgsl: c.has('wgsl', 'lightTerm') ? `    var lmT = lm;\n${c.at('wgsl', 'lightTerm')}` : '',
    glsl: c.has('glsl', 'lightTerm') ? `    vec3 lmT = lm;\n${c.at('glsl', 'lightTerm')}` : '',
  }
  const lmW = c.has('wgsl', 'lightTerm') ? 'lmT' : 'lm'
  const lmG = c.has('glsl', 'lightTerm') ? 'lmT' : 'lm'
  const vertexWGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
uniform world: mat4x4f;
uniform view: mat4x4f;
uniform viewProjection: mat4x4f;
${c.at('wgsl', 'uniforms')}varying vLocal: vec2f;
varying vDepth: f32;
${vwDecl.wgsl}${c.at('wgsl', 'varyings')}${c.at('wgsl', 'vertexDecl')}
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let wp = uniforms.world * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.position = uniforms.viewProjection * wp;
  vertexOutputs.vLocal = vertexInputs.uv;
  vertexOutputs.vDepth = abs((uniforms.view * wp).z);
${vwOut.wgsl}${c.at('wgsl', 'vertexOut')}}
`
  const fragmentWGSL = /* wgsl */ `
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
${c.at('wgsl', 'uniforms')}varying vLocal: vec2f;
varying vDepth: f32;
${vwDecl.wgsl}${c.at('wgsl', 'varyings')}${c.at('wgsl', 'samplers')}
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
${layer.wgsl}  }
  if (dmode == 1) {
    let h = f32(drawn) / 7.0;
    color = clamp(vec3f(2.0 * h - 0.5, 1.5 - abs(4.0 * h - 2.0), 1.0 - 2.0 * h), vec3f(0.0), vec3f(1.0));
  } else if (dmode == 2) {
    color = vec3f(1.0);
  } else if (dmode == 4) {
    color = idColor(firstIdx);
  }
${pre.wgsl}  if (uniforms.viewParams.x > 0.5 || dmode == 2) {
${light.wgsl}    color = color * clamp(${lmW} + uniforms.shadowColor.rgb, vec3f(0.0), vec3f(1.0));
  }
${c.at('wgsl', 'postLight')}  if (uniforms.fogParams.z > 0.5) {
    let ff = clamp((fragmentInputs.vDepth - uniforms.fogParams.x) / max(uniforms.fogParams.y - uniforms.fogParams.x, 0.001), 0.0, 1.0);
    color = mix(color, uniforms.fogColor.rgb, ff);
  }
  fragmentOutputs.color = vec4f(color, 1.0);
}
`
  const vertexGLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
${c.at('glsl', 'uniforms')}varying vec2 vLocal;
varying float vDepth;
${vwDecl.glsl}${c.at('glsl', 'varyings')}${c.at('glsl', 'vertexDecl')}
void main(void) {
  vec4 wp = world * vec4(position, 1.0);
  gl_Position = viewProjection * wp;
  vLocal = uv;
  vDepth = abs((view * wp).z);
${vwOut.glsl}${c.at('glsl', 'vertexOut')}}
`
  const fragmentGLSL = /* glsl */ `
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
${c.at('glsl', 'uniforms')}varying vec2 vLocal;
varying float vDepth;
${vwDecl.glsl}${c.at('glsl', 'varyings')}${c.at('glsl', 'samplers')}
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
${layer.glsl}  }
  if (dmode == 1) {
    float h = float(drawn) / 7.0;
    color = clamp(vec3(2.0 * h - 0.5, 1.5 - abs(4.0 * h - 2.0), 1.0 - 2.0 * h), 0.0, 1.0);
  } else if (dmode == 2) {
    color = vec3(1.0);
  } else if (dmode == 4) {
    color = idColor(firstIdx);
  }
${pre.glsl}  if (viewParams.x > 0.5 || dmode == 2) {
${light.glsl}    color *= clamp(${lmG} + shadowColor.rgb, 0.0, 1.0);
  }
${c.at('glsl', 'postLight')}  if (fogParams.z > 0.5) {
    float ff = clamp((vDepth - fogParams.x) / max(fogParams.y - fogParams.x, 0.001), 0.0, 1.0);
    color = mix(color, fogColor.rgb, ff);
  }
  gl_FragColor = vec4(color, 1.0);
}
`
  return {
    vertexWGSL, fragmentWGSL, vertexGLSL, fragmentGLSL,
    uniforms: c.uniforms(TERRAIN_BASE_UNIFORMS),
    samplers: c.samplers(TERRAIN_BASE_SAMPLERS),
    chunkSamplers: c.extraSamplers,
  }
}

const TERRAIN = terrainShaders()
export const TERRAIN_UNIFORMS = TERRAIN.uniforms
export const TERRAIN_SAMPLERS = TERRAIN.samplers
/** Samplers declared by terrain chunks. */
export const TERRAIN_CHUNK_SAMPLERS = TERRAIN.chunkSamplers
export const terrainVertexWGSL = TERRAIN.vertexWGSL
export const terrainFragmentWGSL = TERRAIN.fragmentWGSL
export const terrainVertexGLSL = TERRAIN.vertexGLSL
export const terrainFragmentGLSL = TERRAIN.fragmentGLSL

// Water (TERRAIN.md 4, 8.2): colour = frame texture x saturate(WaterColor), alpha = per-vertex depth alpha (color.a),
// blended SRCALPHA / INVSRCALPHA without depth write. waterParams: x = frame layer (0..29), y = fog on.
// uv = region-local file units / 80 (4 repeats per 320-unit block).

export const WATER_BASE_UNIFORMS = ['world', 'view', 'viewProjection', 'waterColor', 'waterParams', 'fogParams', 'fogColor']
export const WATER_BASE_SAMPLERS = ['frames']

/** The water shaders with `lanes`' chunks. */
export function waterShaders(lanes: readonly WorldShaderChunks[] = WORLD_SHADER_CHUNKS): ShaderSources {
  const c: ChunkSet<WaterPoint> = ChunkSet.of(lanes, 'water')
  const { vwDecl, vwOut } = vWorldParts(c.vWorld, { wgsl: '  vertexOutputs.vWorld = wp.xyz;\n', glsl: '  vWorld = wp.xyz;\n' })
  const normal: Both = {
    wgsl: c.has('wgsl', 'normal') || c.has('wgsl', 'postColor') ? `  var nrm = vec3f(0.0, 1.0, 0.0);\n${c.at('wgsl', 'normal')}` : '',
    glsl: c.has('glsl', 'normal') || c.has('glsl', 'postColor') ? `  vec3 nrm = vec3(0.0, 1.0, 0.0);\n${c.at('glsl', 'normal')}` : '',
  }
  const vertexWGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
attribute color: vec4f;
uniform world: mat4x4f;
uniform view: mat4x4f;
uniform viewProjection: mat4x4f;
${c.at('wgsl', 'uniforms')}varying vUV: vec2f;
varying vAlpha: f32;
varying vDepth: f32;
${vwDecl.wgsl}${c.at('wgsl', 'varyings')}${c.at('wgsl', 'vertexDecl')}
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let wp = uniforms.world * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.position = uniforms.viewProjection * wp;
  vertexOutputs.vUV = vertexInputs.uv;
  vertexOutputs.vAlpha = vertexInputs.color.a;
  vertexOutputs.vDepth = abs((uniforms.view * wp).z);
${vwOut.wgsl}${c.at('wgsl', 'vertexOut')}}
`
  const fragmentWGSL = /* wgsl */ `
var frames: texture_2d_array<f32>;
var framesSampler: sampler;
uniform waterColor: vec4f;
uniform waterParams: vec4f;
uniform fogParams: vec4f;
uniform fogColor: vec4f;
${c.at('wgsl', 'uniforms')}varying vUV: vec2f;
varying vAlpha: f32;
varying vDepth: f32;
${vwDecl.wgsl}${c.at('wgsl', 'varyings')}${c.at('wgsl', 'samplers')}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let fi = i32(uniforms.waterParams.x + 0.5);
  var rgb = textureSample(frames, framesSampler, fragmentInputs.vUV, fi).rgb * clamp(uniforms.waterColor.rgb, vec3f(0.0), vec3f(1.0));
${normal.wgsl}${c.at('wgsl', 'postColor')}  if (uniforms.fogParams.z > 0.5) {
    let ff = clamp((fragmentInputs.vDepth - uniforms.fogParams.x) / max(uniforms.fogParams.y - uniforms.fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, uniforms.fogColor.rgb, ff);
  }
  fragmentOutputs.color = vec4f(rgb, clamp(fragmentInputs.vAlpha, 0.0, 1.0));
}
`
  const vertexGLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
${c.at('glsl', 'uniforms')}varying vec2 vUV;
varying float vAlpha;
varying float vDepth;
${vwDecl.glsl}${c.at('glsl', 'varyings')}${c.at('glsl', 'vertexDecl')}
void main(void) {
  vec4 wp = world * vec4(position, 1.0);
  gl_Position = viewProjection * wp;
  vUV = uv;
  vAlpha = color.a;
  vDepth = abs((view * wp).z);
${vwOut.glsl}${c.at('glsl', 'vertexOut')}}
`
  const fragmentGLSL = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray frames;
uniform vec4 waterColor;
uniform vec4 waterParams;
uniform vec4 fogParams;
uniform vec4 fogColor;
${c.at('glsl', 'uniforms')}varying vec2 vUV;
varying float vAlpha;
varying float vDepth;
${vwDecl.glsl}${c.at('glsl', 'varyings')}${c.at('glsl', 'samplers')}
void main(void) {
  vec3 rgb = texture(frames, vec3(vUV, floor(waterParams.x + 0.5))).rgb * clamp(waterColor.rgb, 0.0, 1.0);
${normal.glsl}${c.at('glsl', 'postColor')}  if (fogParams.z > 0.5) {
    float ff = clamp((vDepth - fogParams.x) / max(fogParams.y - fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, fogColor.rgb, ff);
  }
  gl_FragColor = vec4(rgb, clamp(vAlpha, 0.0, 1.0));
}
`
  return {
    vertexWGSL, fragmentWGSL, vertexGLSL, fragmentGLSL,
    uniforms: c.uniforms(WATER_BASE_UNIFORMS),
    samplers: c.samplers(WATER_BASE_SAMPLERS),
    chunkSamplers: c.extraSamplers,
  }
}

const WATER = waterShaders()
export const WATER_UNIFORMS = WATER.uniforms
export const WATER_SAMPLERS = WATER.samplers
/** Samplers declared by water chunks. */
export const WATER_CHUNK_SAMPLERS = WATER.chunkSamplers
export const waterVertexWGSL = WATER.vertexWGSL
export const waterFragmentWGSL = WATER.fragmentWGSL
export const waterVertexGLSL = WATER.vertexGLSL
export const waterFragmentGLSL = WATER.fragmentGLSL
