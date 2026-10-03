/**
 * Low's ocean (docs/COAST.md §8.4, §8.10: the Classic fallback): the retail water's look (frames `water101..130` ×
 * WaterColor, the retail alpha rule, full at 3 m, on the field's depth, the Classic linear fog) on the same CDLOD grid,
 * displaced by three Gerstner waves drawn from the spectrum (gerstner.ts) with the per-wave shallow-water attenuation,
 * and faded to flat at the retail-water join. A ShaderMaterial in WGSL (WebGPU) and GLSL (WebGL2). The shore seam's
 * code is inserted at the same places as in the PBR plugin (shore-seam.ts; Low's shore is the vertex swash and the
 * scrolling foam band). No depth pre-pass: Low's waves are gentle (Q k A ≤ 0.2 each) and it keeps its draw count.
 */
import { Constants, ShaderLanguage, ShaderMaterial, ShaderStore, Vector4, type BaseTexture, type Scene } from '@babylonjs/core'
import { SHORE_SAMPLERS, SHORE_UNIFORMS } from '../shore/chunks.ts'
import { lowLandFloorCode, SWASH_BAND_M, SWASH_HEIGHT_M } from './field.ts'
import type { GerstnerWave } from './gerstner.ts'
import { CDLOD_ATTRIBUTE, COMMON_GLSL, COMMON_WGSL, OCEAN_VARYING, oceanMorphCode, shoreCode } from './ocean-plugin.ts'
import { SHORE_DEFINE } from './shore-seam.ts'

export const CLASSIC_OCEAN_SHADER = 'sroOceanClassic'
export const CLASSIC_OCEAN_UNIFORMS = [
  'viewProjection', 'view', 'sroOcA', 'sroOcS', 'sroOcCam', 'sroOcLat', 'sroOcFieldXf',
  'sroOcG0', 'sroOcG1', 'sroOcG2', 'sroOcH0', 'sroOcH1', 'sroOcH2', 'sroOcHf',
  'waterColor', 'waterParams', 'fogParams', 'fogColor',
] as const
export const CLASSIC_OCEAN_SAMPLERS = ['frames', 'sroOcFieldMap'] as const
/** Retail frame repeat (m), as the Classic water (4 repeats per 32 m block). */
const FRAME_REPEAT_M = 8

/** The mask (field.ts `drawsWater`): open sea, or the swash band on a beach, never the retail-water join. */
const KEEP = `sroOcField.x >= 0.5 || (sroOcField.w < 0.5 && sroOcField.z > ${lowLandFloorCode('sroOcField.y')} && sroOcField.z < ${SWASH_HEIGHT_M.toFixed(1)} && sroOcField.y > ${(-SWASH_BAND_M).toFixed(1)})`

function waveTerms(lang: 'wgsl' | 'glsl'): string {
  const w = lang === 'wgsl'
  const u = (n: string) => (w ? `uniforms.${n}` : n)
  let out = ''
  for (let i = 0; i < 3; i++) {
    const g = u(`sroOcG${i}`), h = u(`sroOcH${i}`), fl = `${u('sroOcHf')}.${'xyz'[i]}`
    out += w
      ? `  {
    let a = ${h}.x * mix(${fl} * smoothstep(0.0, 0.6, sroDepth), 1.0, smoothstep(0.0, ${h}.w, sroDepth)) * (1.0 - sroOcField.w);
    let th = ${g}.z * dot(${g}.xy, sroOcRest) - ${g}.w * ${u('sroOcA')}.y + ${h}.z;
    sroDisp = sroDisp + vec3f(${g}.x * ${h}.y * a * cos(th), a * sin(th), ${g}.y * ${h}.y * a * cos(th));
  }
`
      : `  {
    float a = ${h}.x * mix(${fl} * smoothstep(0.0, 0.6, sroDepth), 1.0, smoothstep(0.0, ${h}.w, sroDepth)) * (1.0 - sroOcField.w);
    float th = ${g}.z * dot(${g}.xy, sroOcRest) - ${g}.w * ${u('sroOcA')}.y + ${h}.z;
    sroDisp += vec3(${g}.x * ${h}.y * a * cos(th), a * sin(th), ${g}.y * ${h}.y * a * cos(th));
  }
`
  }
  return out
}

const UNIFORMS_WGSL = [...CLASSIC_OCEAN_UNIFORMS.filter(n => n !== 'viewProjection' && n !== 'view'), ...SHORE_UNIFORMS].map(n => `uniform ${n}: vec4f;`).join('\n')
const UNIFORMS_GLSL = [...CLASSIC_OCEAN_UNIFORMS.filter(n => n !== 'viewProjection' && n !== 'view'), ...SHORE_UNIFORMS].map(n => `uniform vec4 ${n};`).join('\n')

/** The Classic ocean's four shader sources. */
export function classicOceanShaders(): { vertexWGSL: string; fragmentWGSL: string; vertexGLSL: string; fragmentGLSL: string } {
  const vertexWGSL = /* wgsl */ `
attribute position: vec3f;
attribute ${CDLOD_ATTRIBUTE}: vec4f;
uniform viewProjection: mat4x4f;
uniform view: mat4x4f;
${UNIFORMS_WGSL}
varying ${OCEAN_VARYING}: vec4f;
varying vDepth: f32;
var sroOcFieldMap: texture_2d<f32>;
var sroOcFieldMapSampler: sampler;
var<private> sroOcRest: vec2f;
var<private> sroOcField: vec4f;
var<private> sroOcPos: vec3f;
var<private> sroOcFoam: f32;
var<private> sroOcSwash: f32;
${COMMON_WGSL}${shoreCode('wgsl', 'vertex', 'definitions')}
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
${oceanMorphCode('wgsl', 'vertexInputs.position')}  var sroDisp = vec3f(0.0);
${waveTerms('wgsl')}  sroOcPos = vec3f(sroOcRest.x + sroDisp.x, sroSL + sroDisp.y, sroOcRest.y + sroDisp.z);
  sroOcFoam = 0.0;
  sroOcSwash = 0.0;
${shoreCode('wgsl', 'vertex', 'main')}  let wp = vec4f(sroOcPos, 1.0);
  vertexOutputs.position = uniforms.viewProjection * wp;
  vertexOutputs.vDepth = abs((uniforms.view * wp).z);
  vertexOutputs.${OCEAN_VARYING} = vec4f(sroOcRest, sroOcFoam, sroOcSwash);
}
`
  const fragmentWGSL = /* wgsl */ `
var frames: texture_2d_array<f32>;
var framesSampler: sampler;
var sroOcFieldMap: texture_2d<f32>;
var sroOcFieldMapSampler: sampler;
${UNIFORMS_WGSL}
varying ${OCEAN_VARYING}: vec4f;
varying vDepth: f32;
var<private> sroOcRest: vec2f;
var<private> sroOcField: vec4f;
var<private> sroOcFoam: f32;
var<private> sroOcSwash: f32;
var<private> sroOcAlpha: f32;
${COMMON_WGSL}${shoreCode('wgsl', 'fragment', 'definitions')}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  sroOcRest = fragmentInputs.${OCEAN_VARYING}.xy;
  sroOcFoam = fragmentInputs.${OCEAN_VARYING}.z;
  sroOcSwash = fragmentInputs.${OCEAN_VARYING}.w;
  sroOcField = sroOcDecode(textureSample(sroOcFieldMap, sroOcFieldMapSampler, sroOcRest * uniforms.sroOcFieldXf.xy + uniforms.sroOcFieldXf.zw));
  let fi = i32(uniforms.waterParams.x + 0.5);
  var rgb = textureSample(frames, framesSampler, sroOcRest / ${FRAME_REPEAT_M.toFixed(1)}, fi).rgb * clamp(uniforms.waterColor.rgb, vec3f(0.0), vec3f(1.0));
  let depth = max(-sroOcField.z, 0.0);
  sroOcAlpha = clamp(trunc(depth * 5.0) / 15.0, 0.0, 1.0);
${shoreCode('wgsl', 'fragment', 'main')}  if (!(${KEEP}) || sroOcAlpha <= 0.0) {
    discard;
  }
  rgb = mix(rgb, vec3f(0.85) * clamp(uniforms.waterColor.rgb * 1.6, vec3f(0.0), vec3f(1.0)), clamp(sroOcFoam, 0.0, 1.0));
  if (uniforms.fogParams.z > 0.5) {
    let ff = clamp((fragmentInputs.vDepth - uniforms.fogParams.x) / max(uniforms.fogParams.y - uniforms.fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, uniforms.fogColor.rgb, ff);
  }
  fragmentOutputs.color = vec4f(rgb, clamp(sroOcAlpha, 0.0, 1.0));
}
`
  const vertexGLSL = /* glsl */ `
precision highp float;
precision highp sampler2D;
attribute vec3 position;
attribute vec4 ${CDLOD_ATTRIBUTE};
uniform mat4 viewProjection;
uniform mat4 view;
${UNIFORMS_GLSL}
uniform sampler2D sroOcFieldMap;
varying vec4 ${OCEAN_VARYING};
varying float vDepth;
vec2 sroOcRest;
vec4 sroOcField;
vec3 sroOcPos;
float sroOcFoam;
float sroOcSwash;
${COMMON_GLSL}${shoreCode('glsl', 'vertex', 'definitions')}
void main(void) {
${oceanMorphCode('glsl', 'position')}  vec3 sroDisp = vec3(0.0);
${waveTerms('glsl')}  sroOcPos = vec3(sroOcRest.x + sroDisp.x, sroSL + sroDisp.y, sroOcRest.y + sroDisp.z);
  sroOcFoam = 0.0;
  sroOcSwash = 0.0;
${shoreCode('glsl', 'vertex', 'main')}  vec4 wp = vec4(sroOcPos, 1.0);
  gl_Position = viewProjection * wp;
  vDepth = abs((view * wp).z);
  ${OCEAN_VARYING} = vec4(sroOcRest, sroOcFoam, sroOcSwash);
}
`
  const fragmentGLSL = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray frames;
uniform sampler2D sroOcFieldMap;
${UNIFORMS_GLSL}
varying vec4 ${OCEAN_VARYING};
varying float vDepth;
vec2 sroOcRest;
vec4 sroOcField;
float sroOcFoam;
float sroOcSwash;
float sroOcAlpha;
${COMMON_GLSL}${shoreCode('glsl', 'fragment', 'definitions')}
void main(void) {
  sroOcRest = ${OCEAN_VARYING}.xy;
  sroOcFoam = ${OCEAN_VARYING}.z;
  sroOcSwash = ${OCEAN_VARYING}.w;
  sroOcField = sroOcDecode(texture(sroOcFieldMap, sroOcRest * sroOcFieldXf.xy + sroOcFieldXf.zw));
  vec3 rgb = texture(frames, vec3(sroOcRest / ${FRAME_REPEAT_M.toFixed(1)}, floor(waterParams.x + 0.5))).rgb * clamp(waterColor.rgb, 0.0, 1.0);
  float depth = max(-sroOcField.z, 0.0);
  sroOcAlpha = clamp(trunc(depth * 5.0) / 15.0, 0.0, 1.0);
${shoreCode('glsl', 'fragment', 'main')}  if (!(${KEEP}) || sroOcAlpha <= 0.0) {
    discard;
  }
  rgb = mix(rgb, vec3(0.85) * clamp(waterColor.rgb * 1.6, 0.0, 1.0), clamp(sroOcFoam, 0.0, 1.0));
  if (fogParams.z > 0.5) {
    float ff = clamp((vDepth - fogParams.x) / max(fogParams.y - fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, fogColor.rgb, ff);
  }
  gl_FragColor = vec4(rgb, clamp(sroOcAlpha, 0.0, 1.0));
}
`
  return { vertexWGSL, fragmentWGSL, vertexGLSL, fragmentGLSL }
}

/** The Classic ocean's per-frame values (the ocean part writes them; the material reads them at bind). */
export class ClassicOceanState {
  readonly g = [new Vector4(), new Vector4(), new Vector4()]
  readonly h = [new Vector4(), new Vector4(), new Vector4()]
  readonly hf = new Vector4()
  readonly water = new Vector4(0.25, 0.69, 0.62, 1)
  readonly params = new Vector4()
  readonly fog = new Vector4()
  readonly fogColor = new Vector4()

  /** Loads a Gerstner set (3 waves). */
  setWaves(waves: readonly GerstnerWave[]): void {
    for (let i = 0; i < 3; i++) {
      const w = waves[i]
      if (!w) {
        this.g[i]!.set(1, 0, 0, 0)
        this.h[i]!.set(0, 0, 0, 1)
        continue
      }
      this.g[i]!.set(w.dirX, w.dirZ, w.k, w.omega)
      this.h[i]!.set(w.amp, w.q, w.phase, w.d0)
    }
    this.hf.set(waves[0]?.floor ?? 0, waves[1]?.floor ?? 0, waves[2]?.floor ?? 0, 0)
  }
}

let registered = false

/** The Classic ocean ShaderMaterial (one per world; the ocean part binds its vectors each frame). */
export function createClassicOceanMaterial(scene: Scene, shore: boolean): ShaderMaterial {
  if (!registered) {
    const src = classicOceanShaders()
    ShaderStore.ShadersStoreWGSL[`${CLASSIC_OCEAN_SHADER}VertexShader`] = src.vertexWGSL
    ShaderStore.ShadersStoreWGSL[`${CLASSIC_OCEAN_SHADER}FragmentShader`] = src.fragmentWGSL
    ShaderStore.ShadersStore[`${CLASSIC_OCEAN_SHADER}VertexShader`] = src.vertexGLSL
    ShaderStore.ShadersStore[`${CLASSIC_OCEAN_SHADER}FragmentShader`] = src.fragmentGLSL
    registered = true
  }
  const mat = new ShaderMaterial('oceanClassic', scene, CLASSIC_OCEAN_SHADER, {
    attributes: ['position', CDLOD_ATTRIBUTE],
    uniforms: [...CLASSIC_OCEAN_UNIFORMS, ...SHORE_UNIFORMS],
    samplers: [...CLASSIC_OCEAN_SAMPLERS, ...SHORE_SAMPLERS],
    defines: shore ? [SHORE_DEFINE] : [],
    needAlphaBlending: true,
    shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  })
  mat.alphaMode = Constants.ALPHA_COMBINE
  mat.disableDepthWrite = true
  mat.backFaceCulling = false
  return mat
}

/** Binds the state's vectors and the textures on the material (every frame it draws). */
export function bindClassicOcean(mat: ShaderMaterial, s: ClassicOceanState, v: { a: Vector4; s: Vector4; cam: Vector4; lat: Vector4; fieldXf: Vector4 }, frames: BaseTexture | null, field: BaseTexture | null): void {
  mat.setVector4('sroOcA', v.a)
  mat.setVector4('sroOcS', v.s)
  mat.setVector4('sroOcCam', v.cam)
  mat.setVector4('sroOcLat', v.lat)
  mat.setVector4('sroOcFieldXf', v.fieldXf)
  for (let i = 0; i < 3; i++) {
    mat.setVector4(`sroOcG${i}`, s.g[i]!)
    mat.setVector4(`sroOcH${i}`, s.h[i]!)
  }
  mat.setVector4('sroOcHf', s.hf)
  mat.setVector4('waterColor', s.water)
  mat.setVector4('waterParams', s.params)
  mat.setVector4('fogParams', s.fog)
  mat.setVector4('fogColor', s.fogColor)
  if (frames) mat.setTexture('frames', frames)
  if (field) mat.setTexture('sroOcFieldMap', field)
}
