/**
 * Art for the grass and plant scatter (scatter.ts, docs/WAVE_PLAN.md §6 W5-G): the plant kinds, their meshes and
 * textures, and the wind-sway shader pair (WGSL for WebGPU, GLSL ES 3.0 for WebGL2, like shaders.ts).
 *
 * Census of the retail client (vSRO 1.188): Map/tile2d.ifo gives a few tiles a 3D grass model ({object.ifo id,
 * density}); the Jangan field tiles c_grass_fld_09 / _10 use res/nature/common/grass/grs_weed07 and grass_single03,
 * and the Jangan exports already carry those and other small plants (flowers, weeds) as converted glbs because some
 * .o2 placements use them. Each kind below names the retail models it prefers, by source file name, in the export's
 * manifest.models; a kind whose model is not in the export (or fails to load) falls back to procedural crossed cards
 * with an alpha texture generated here (deterministic, no asset needed).
 */
import {
  Constants,
  RawTexture,
  Texture,
  TransformNode,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type Mesh,
  type Scene,
} from '@babylonjs/core'
import type { WorldModel } from '../../convert/src/world/manifest.ts'
import type { Assets } from './assets.ts'
import { loadGlb } from './objects.ts'
import { ChunkSet, type GrassPoint, type WorldShaderChunks } from './shader-chunks.ts'
import { WORLD_SHADER_CHUNKS, vWorldParts, type Both, type ShaderSources } from './shaders.ts'

export type ScatterKindId = 'grass' | 'weed' | 'bush' | 'flowerY' | 'flowerW'

export interface ScatterKindDef {
  id: ScatterKindId
  /** Retail models by source file name (res/nature/common/...), first found in the export wins. */
  retail: readonly string[]
  /** Plant height range (m); each model is scaled uniformly from its own height to a height in this range. */
  heightM: readonly [number, number]
  /** Colour factor of the retail material (BMT diffuse 0.588 x the 2x colour tint of ObjectMaterials). */
  tint: number
  /** Procedural fallback: card size (m) and palette. */
  card: { width: number; height: number; cards: number; style: 'blades' | 'weed' | 'flower'; flower?: readonly [number, number, number] }
}

/** Plant kinds in draw order. Kind selection per placement is in scatter.ts (pickKind). */
export const SCATTER_KINDS: readonly ScatterKindDef[] = [
  { id: 'grass', retail: ['grass_single03.bsr', 'grass_single.bsr', 'grass_single02.bsr'], heightM: [0.45, 0.8], tint: 1.18, card: { width: 1, height: 0.8, cards: 3, style: 'blades' } },
  { id: 'weed', retail: ['grs_weed07.bsr', 'grs_weed10.bsr', 'grs_weed06.bsr'], heightM: [0.7, 1.1], tint: 1.18, card: { width: 1.2, height: 1, cards: 3, style: 'weed' } },
  { id: 'bush', retail: ['grs_weed01.bsr', 'grs_weed06.bsr'], heightM: [0.9, 1.4], tint: 1.18, card: { width: 1.6, height: 1.3, cards: 3, style: 'weed' } },
  { id: 'flowerY', retail: ['flw_g01_yall.bsr', 'grs_flower_02.bsr'], heightM: [0.45, 0.65], tint: 1.18, card: { width: 0.6, height: 0.5, cards: 2, style: 'flower', flower: [236, 206, 64] } },
  { id: 'flowerW', retail: ['flw_g01_wha.bsr'], heightM: [0.45, 0.65], tint: 1.18, card: { width: 0.6, height: 0.5, cards: 2, style: 'flower', flower: [236, 232, 220] } },
]

/** One kind ready to draw: merged model-space geometry (glTF metres, base at y ~ 0) and its alpha-tested texture. */
export interface ScatterKindAsset {
  def: ScatterKindDef
  positions: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  texture: BaseTexture
  /** Top of the geometry (m). */
  heightM: number
  /** Where the art came from: the retail model's source path, or 'procedural'. */
  source: string
}

/** Retail manifest model of a kind (first preferred name present with a glb), or null. */
export function retailModelFor(def: ScatterKindDef, models: readonly WorldModel[]): WorldModel | null {
  const byName = new Map<string, WorldModel>()
  for (const m of models) {
    if (!m.glb || m.kind !== 'static') continue
    const name = m.source.split(/[\\/]/).pop()!.toLowerCase()
    if (!byName.has(name)) byName.set(name, m)
  }
  for (const name of def.retail) {
    const m = byName.get(name.toLowerCase())
    if (m) return m
  }
  return null
}

/**
 * Loads every kind: the retail glb when the export has it (its geometry baked to model space and merged, its base
 * colour texture kept), else procedural cards. Never rejects; `retail: false` skips the glbs (tests, low memory).
 */
export async function loadScatterKinds(scene: Scene, assets: Assets, models: readonly WorldModel[], retail = true): Promise<ScatterKindAsset[]> {
  return Promise.all(SCATTER_KINDS.map(async def => {
    const model = retail ? retailModelFor(def, models) : null
    if (model?.glb) {
      try {
        const a = await retailKind(scene, assets, def, model.glb, model.source)
        if (a) return a
      } catch (err) {
        console.warn(`[world] scatter ${def.id}: ${model.glb} unusable, using procedural cards:`, err)
      }
    }
    return proceduralKind(scene, def)
  }))
}

async function retailKind(scene: Scene, assets: Assets, def: ScatterKindDef, glb: string, source: string): Promise<ScatterKindAsset | null> {
  const container = await loadGlb(scene, assets, glb)
  try {
    for (const root of container.rootNodes) {
      if (root instanceof TransformNode) root.computeWorldMatrix(true)
      for (const n of root.getDescendants(false)) if (n instanceof TransformNode) n.computeWorldMatrix(true)
    }
    const meshes = container.meshes.filter((m: AbstractMesh): m is Mesh => m.getTotalVertices() > 0 && 'getIndices' in m)
    const pos: number[] = []
    const uv: number[] = []
    const idx: number[] = []
    let texture: BaseTexture | null = null
    for (const mesh of meshes) {
      const p = mesh.getVerticesData('position')
      const t = mesh.getVerticesData('uv')
      const ind = mesh.getIndices()
      if (!p || !t || !ind) continue
      const tex = albedoOf(mesh.material)
      if (!tex) continue
      if (texture && tex !== texture) continue // one texture per kind: extra materials are dropped
      texture = tex
      const m = mesh.computeWorldMatrix(true).asArray()
      const base = pos.length / 3
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!
        pos.push(
          x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
          x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
          x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
        )
      }
      for (let i = 0; i < t.length; i++) uv.push(t[i]!)
      for (let i = 0; i < ind.length; i++) idx.push(base + ind[i]!)
    }
    if (!texture || !pos.length) return null
    // Keep the texture past the container's disposal.
    const ti = container.textures.indexOf(texture as Texture)
    if (ti >= 0) container.textures.splice(ti, 1)
    texture.hasAlpha = true
    let minY = Infinity, maxY = -Infinity
    for (let i = 1; i < pos.length; i += 3) {
      minY = Math.min(minY, pos[i]!)
      maxY = Math.max(maxY, pos[i]!)
    }
    // Retail plants sit a little below their origin (grass_single03: -0.125 m): lift so the base meets the ground.
    const lift = minY < 0 ? Math.min(-minY, 0.3) * 0.5 : 0
    if (lift) for (let i = 1; i < pos.length; i += 3) pos[i] = pos[i]! + lift
    return {
      def,
      positions: new Float32Array(pos),
      uvs: new Float32Array(uv),
      indices: new Uint32Array(idx),
      texture,
      heightM: Math.max(0.1, maxY + lift),
      source: source.replace(/\\/g, '/'),
    }
  } finally {
    container.dispose()
  }
}

function albedoOf(material: Material | null): BaseTexture | null {
  const m = material as (Material & { albedoTexture?: BaseTexture | null; diffuseTexture?: BaseTexture | null }) | null
  return m?.albedoTexture ?? m?.diffuseTexture ?? null
}

// ---- procedural fallback --------------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TEX_W = 64
const TEX_H = 64

/**
 * RGBA pixels (TEX_W x TEX_H, row 0 = the bottom of the card, v = 0) of a procedural plant card: tapered blades from
 * dark green at the base to a light yellow-green tip, a denser clump for weeds, small heads on top for flowers.
 * Alpha is 0 or 255 (alpha-tested).
 */
export function proceduralPixels(style: ScatterKindDef['card']['style'], seed: number, flower?: readonly [number, number, number]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(TEX_W * TEX_H * 4)
  const rnd = mulberry32(seed)
  const blades = style === 'weed' ? 14 : style === 'flower' ? 6 : 9
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || x >= TEX_W || y < 0 || y >= TEX_H) return
    const o = (y * TEX_W + x) * 4
    out[o] = r
    out[o + 1] = g
    out[o + 2] = b
    out[o + 3] = 255
  }
  for (let i = 0; i < blades; i++) {
    const x0 = 6 + rnd() * (TEX_W - 12)
    const h = TEX_H * (style === 'flower' ? 0.55 + rnd() * 0.25 : 0.55 + rnd() * 0.43)
    const lean = (rnd() - 0.5) * (style === 'weed' ? 22 : 16)
    const w0 = style === 'weed' ? 2.2 + rnd() * 1.6 : 1.6 + rnd() * 1.2
    const shade = 0.85 + rnd() * 0.3
    for (let y = 0; y < h; y++) {
      const f = y / h
      const cx = x0 + lean * f * f
      const hw = Math.max(0.35, w0 * (1 - f))
      const r = Math.min(255, (38 + 110 * f) * shade)
      const g = Math.min(255, (78 + 120 * f) * shade)
      const b = Math.min(255, (22 + 40 * f) * shade)
      for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw); x++) if (Math.abs(x + 0.5 - cx) <= hw) put(x, y, r, g, b)
    }
    if (style === 'flower' && flower) {
      const fx = x0 + lean
      const fy = h
      const rad = 2.2 + rnd() * 1.4
      for (let y = Math.floor(fy - rad); y <= Math.ceil(fy + rad); y++) {
        for (let x = Math.floor(fx - rad); x <= Math.ceil(fx + rad); x++) {
          const d = Math.hypot(x + 0.5 - fx, y + 0.5 - fy)
          if (d > rad) continue
          const c = d < rad * 0.35 ? 0.7 : 1
          put(x, y, flower[0] * c, flower[1] * c, flower[2] * c)
        }
      }
    }
  }
  return out
}

/** Crossed vertical cards around +Y (uv v = 0 at the bottom). */
export function crossedCards(width: number, height: number, cards: number): { positions: Float32Array; uvs: Float32Array; indices: Uint32Array } {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let c = 0; c < cards; c++) {
    const a = (c * Math.PI) / cards
    const dx = (Math.cos(a) * width) / 2
    const dz = (Math.sin(a) * width) / 2
    const b = pos.length / 3
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, height, dz, -dx, height, -dz)
    uv.push(0, 0, 1, 0, 1, 1, 0, 1)
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  return { positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx) }
}

export function proceduralKind(scene: Scene, def: ScatterKindDef): ScatterKindAsset {
  const seed = 0x5eed + SCATTER_KINDS.indexOf(def) * 7919
  const pixels = proceduralPixels(def.card.style, seed, def.card.flower)
  const texture = new RawTexture(pixels, TEX_W, TEX_H, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
  texture.name = `scatter_${def.id}`
  texture.hasAlpha = true
  texture.wrapU = Texture.CLAMP_ADDRESSMODE
  texture.wrapV = Texture.CLAMP_ADDRESSMODE
  const g = crossedCards(def.card.width, def.card.height, def.card.cards)
  return { def, ...g, texture, heightM: def.card.height, source: 'procedural' }
}

// ---- shaders ----------------------------------------------------------------------------------------------------
//
// Per instance: the thin-instance matrix (translation = the plant's root on the terrain, rotation about +Y, uniform
// scale). The vertex shader
//   - fades the plant out by shrinking it into its root between scFade.x and scFade.y metres from the camera (2D), and
//     near the camera (scFade.w, so plants never fill the screen when the camera dips into the grass): a plant past the
//     fade collapses to a point and draws no pixels;
//   - sways it in the wind: a horizontal offset growing with the height above the root, two sines phased by the root
//     position (scCamera.w = time in seconds, scFade.z = strength);
//   - passes the region lightmap uv of the root (the terrain's own lightmap, TERRAIN.md 3.1, so plants in baked shadow
//     are as dark as the ground under them) and a shade that darkens the base and varies per plant.
// The fragment shader alpha-tests (scTint.a), colours texture x scTint.rgb x saturate(lightmap + shadow) x shade, and
// fogs like the terrain.

export const SCATTER_BASE_UNIFORMS = ['world', 'view', 'viewProjection', 'scCamera', 'scFade', 'scRegion', 'scTint', 'scShadow', 'fogParams', 'fogColor']
export const SCATTER_BASE_SAMPLERS = ['scDiffuse', 'scLightmap']

/**
 * The grass shaders with `lanes`' chunks (docs/WAVE_PLAN3.md §4.2, D1, D23; points in shader-chunks.ts GrassPoint).
 * With every chunk empty the strings equal HEAD's (test/seams-classic.test.ts). No lane edits these shaders.
 */
export function scatterShaders(lanes: readonly WorldShaderChunks[] = WORLD_SHADER_CHUNKS): ShaderSources {
  const c: ChunkSet<GrassPoint> = ChunkSet.of(lanes, 'grass')
  const { vwDecl, vwOut } = vWorldParts(c.vWorld, { wgsl: '  vertexOutputs.vWorld = p;\n', glsl: '  vWorld = p;\n' })
  // The chunk replaces HEAD's fixed sway direction.
  const sway: Both = {
    wgsl: c.at('wgsl', 'vertexSway') || '  p = p + vec3f(0.8, 0.0, 0.6) * (bend * s);\n',
    glsl: c.at('glsl', 'vertexSway') || '  p += vec3(0.8, 0.0, 0.6) * (bend * s);\n',
  }
  const vertexWGSL = /* wgsl */ `
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
${c.at('wgsl', 'uniforms')}varying vUV: vec2f;
varying vLm: vec2f;
varying vShade: f32;
varying vDepth: f32;
${vwDecl.wgsl}${c.at('wgsl', 'varyings')}${c.at('wgsl', 'vertexDecl')}
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
${sway.wgsl}  vertexOutputs.position = uniforms.viewProjection * vec4f(p, 1.0);
  vertexOutputs.vUV = vertexInputs.uv;
  let l = vec2f(root.x - uniforms.scRegion.x, uniforms.scRegion.z - root.z) * 10.0;
  vertexOutputs.vLm = (vec2f(0.5) + l * (511.0 / 1920.0)) / 512.0;
  let jit = fract(sin(ph * 12.9898) * 43758.5453);
  vertexOutputs.vShade = mix(0.7, 1.0, clamp(h / 0.8, 0.0, 1.0)) * (0.88 + 0.24 * jit);
  vertexOutputs.vDepth = abs((uniforms.view * vec4f(p, 1.0)).z);
${vwOut.wgsl}${c.at('wgsl', 'vertexLight')}}
`
  const fragmentWGSL = /* wgsl */ `
var scDiffuse: texture_2d<f32>;
var scDiffuseSampler: sampler;
var scLightmap: texture_2d<f32>;
var scLightmapSampler: sampler;
uniform scRegion: vec4f;
uniform scTint: vec4f;
uniform scShadow: vec4f;
uniform fogParams: vec4f;
uniform fogColor: vec4f;
${c.at('wgsl', 'uniforms')}varying vUV: vec2f;
varying vLm: vec2f;
varying vShade: f32;
varying vDepth: f32;
${vwDecl.wgsl}${c.at('wgsl', 'varyings')}${c.at('wgsl', 'samplers')}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let c = textureSample(scDiffuse, scDiffuseSampler, fragmentInputs.vUV);
  let lmRaw = textureSample(scLightmap, scLightmapSampler, fragmentInputs.vLm).rgb;
  if (c.a < uniforms.scTint.a) {
    discard;
  }
  let lm = mix(vec3f(1.0), lmRaw, uniforms.scRegion.y);
  var rgb = c.rgb * uniforms.scTint.rgb * clamp(lm + uniforms.scShadow.rgb, vec3f(0.0), vec3f(1.0)) * fragmentInputs.vShade;
${c.at('wgsl', 'fragmentColor')}  if (uniforms.fogParams.z > 0.5) {
    let ff = clamp((fragmentInputs.vDepth - uniforms.fogParams.x) / max(uniforms.fogParams.y - uniforms.fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, uniforms.fogColor.rgb, ff);
  }
  fragmentOutputs.color = vec4f(rgb, 1.0);
}
`
  const vertexGLSL = /* glsl */ `
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
${c.at('glsl', 'uniforms')}varying vec2 vUV;
varying vec2 vLm;
varying float vShade;
varying float vDepth;
${vwDecl.glsl}${c.at('glsl', 'varyings')}${c.at('glsl', 'vertexDecl')}
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
${sway.glsl}  gl_Position = viewProjection * vec4(p, 1.0);
  vUV = uv;
  vec2 l = vec2(root.x - scRegion.x, scRegion.z - root.z) * 10.0;
  vLm = (vec2(0.5) + l * (511.0 / 1920.0)) / 512.0;
  float jit = fract(sin(ph * 12.9898) * 43758.5453);
  vShade = mix(0.7, 1.0, clamp(h / 0.8, 0.0, 1.0)) * (0.88 + 0.24 * jit);
  vDepth = abs((view * vec4(p, 1.0)).z);
${vwOut.glsl}${c.at('glsl', 'vertexLight')}}
`
  const fragmentGLSL = /* glsl */ `
precision highp float;
uniform sampler2D scDiffuse;
uniform sampler2D scLightmap;
uniform vec4 scRegion;
uniform vec4 scTint;
uniform vec4 scShadow;
uniform vec4 fogParams;
uniform vec4 fogColor;
${c.at('glsl', 'uniforms')}varying vec2 vUV;
varying vec2 vLm;
varying float vShade;
varying float vDepth;
${vwDecl.glsl}${c.at('glsl', 'varyings')}${c.at('glsl', 'samplers')}
void main(void) {
  vec4 c = texture(scDiffuse, vUV);
  vec3 lmRaw = texture(scLightmap, vLm).rgb;
  if (c.a < scTint.a) discard;
  vec3 lm = mix(vec3(1.0), lmRaw, scRegion.y);
  vec3 rgb = c.rgb * scTint.rgb * clamp(lm + scShadow.rgb, 0.0, 1.0) * vShade;
${c.at('glsl', 'fragmentColor')}  if (fogParams.z > 0.5) {
    float ff = clamp((vDepth - fogParams.x) / max(fogParams.y - fogParams.x, 0.001), 0.0, 1.0);
    rgb = mix(rgb, fogColor.rgb, ff);
  }
  gl_FragColor = vec4(rgb, 1.0);
}
`
  return {
    vertexWGSL, fragmentWGSL, vertexGLSL, fragmentGLSL,
    uniforms: c.uniforms(SCATTER_BASE_UNIFORMS),
    samplers: c.samplers(SCATTER_BASE_SAMPLERS),
    chunkSamplers: c.extraSamplers,
  }
}

const SCATTER = scatterShaders()
export const SCATTER_UNIFORMS = SCATTER.uniforms
export const SCATTER_SAMPLERS = SCATTER.samplers
/** Samplers declared by grass chunks. */
export const SCATTER_CHUNK_SAMPLERS = SCATTER.chunkSamplers
export const scatterVertexWGSL = SCATTER.vertexWGSL
export const scatterFragmentWGSL = SCATTER.fragmentWGSL
export const scatterVertexGLSL = SCATTER.vertexGLSL
export const scatterFragmentGLSL = SCATTER.fragmentGLSL
