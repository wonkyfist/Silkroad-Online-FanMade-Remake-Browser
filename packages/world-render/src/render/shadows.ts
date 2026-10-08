/**
 * Sun shadows for the PBR presets (docs/RENDER.md §4.3–4.4, docs/WAVE_PLAN3.md §6.12): one CascadedShadowGenerator on
 * the celestial light, fed by **shadow proxies**. Babylon draws every mesh of a shadow map's render list into every
 * cascade with no per-cascade test, so the cost is CPU draw submission: every static chunk as a caster measured +43 ms,
 * the proxy rule +0.75 ms (RENDER §11.2). Owned by RND-L.
 *
 * - `ShadowProxies`: per region, every opaque static instance (LOD group 2; group 3 too on Ultra) merged into one
 *   position-only mesh, built as the region's `shadowProxy` commit step (after its objects, debounced 500 ms) and
 *   dropped with the region. The mesh carries SHADOW_PROXY_LAYER, outside every camera mask, so only the shadow pass
 *   draws it; one shared two-sided opaque material.
 * - `ShadowCasters` (WorldShadows.refreshCasters, every 8 m of camera movement or when something changed, and every
 *   CHARACTER_REFRESH_MS while characters are registered, since they move on their own): the proxies within
 *   `shadowMaxZ` (+ their radius), the alpha-tested statics (trees, fences) within `foliageM` (High+), skinned clones
 *   taller than 1 m within 40 m (trees only when foliage casts), the terrain on High+, and the shown parts of the
 *   characters within CHARACTER_CASTER_M (W9A perf pass: 141 of 210 casters in a crowd were character parts, with no
 *   distance limit).
 * - Receivers: every object, terrain and character mesh.
 * - `cascadeCulling` (on by default since the W9A perf pass; false is the LAB A/B): each cascade gets only the casters
 *   inside its light-space extents through `getCustomRenderList` (Babylon renders layer k of the map as pass k:
 *   RenderTargetTexture._renderToTarget passes `faceIndex + layer`). Without it every cascade drew every caster
 *   (193/193/193 in the crowd on High; with it about 77/107/205).
 * - Receivers' shadow defines (W9 release verify 2): Babylon gives a receiver SHADOWn only while the generator's render
 *   list is non-empty (PrepareDefinesForLight), decides it when the material's light defines are dirty, and nothing marks
 *   them when the list is replaced. A new generator (a preset switch) starts with an empty list, so a receiver whose
 *   material was checked before the first refresh (the warm-up's `isReady(true)`, or a frame with rAF stalled) kept no
 *   SHADOW0 for good. A new generator therefore starts with the current casters, and a list that turns empty or
 *   non-empty marks the light's meshes light-dirty.
 * - W10-S (docs/BATCHING.md §3.1, §3.9, F10): a region batch (`batched`) brings its own opaque proxy and its cut-out
 *   casters (the batch meshes never come through `placed`); `addCasterSource` adds other casters.
 * - BT-S (BATCHING §3.9; WAVE_PLAN6 §6.1):
 *   - **Proxies from the merge worker.** A batched region's opaque proxy is the worker's (no main-thread merge). The
 *     `shadowProxy` step adds to it only what the worker cannot hold: the chunks that stayed separate, the batch's
 *     group-3 opaque pieces on Ultra (`props`), and the terrain skin. With nothing to add (Medium), the worker's mesh
 *     casts as it is; otherwise one mesh per region holds all of it, and the worker's mesh is not drawn.
 *   - **The terrain skin** (High+, `terrain`): every 4th terrain vertex (8 m), folded into the region's proxy, so a
 *     region casts in one draw per cascade and its full-resolution terrain mesh no longer casts. Each skin vertex takes
 *     the lowest height around it (`terrainSkin`): the skin stays under the ground, so the terrain never receives the
 *     shadow of its own coarse skin (a hill's shadow shrinks by its relief within 8 m). Region edges use the edge line
 *     only, and corners the exact height, so neighbouring skins meet without cracks.
 *   - **The cut-out caster per region.** A region batch's table-mode cut-out groups (fences, lattices, leaves: no 2D
 *     albedo map, so Babylon's depth shader cannot alpha-test them and would cast them solid) merge into one
 *     shadow-only mesh on SHADOW_PROXY_LAYER (never drawn in the main pass) with the standalone `CutoutCasterMaterial`:
 *     a ShaderMaterial whose depth shader reads the slot's albedo cell and cut-off from the material table (UV2) and
 *     alpha-tests the albedo atlas. Its shadow-depth wrapper (`CasterDepthWrapper`) makes one depth effect per shadow
 *     define set, shared by every caster (Babylon's ShadowDepthWrapper compiles one per submesh and re-injects code;
 *     the PBR material's own wrapper is broken on WebGPU with the prepass). Group-3 pieces keep today's range: each
 *     vertex carries its sub-chunk's sphere (`sroCull`) and collapses past 48 m × the live range scale, as the batch
 *     hides the sub-chunk (BATCHING §3.8). The caster is built only for regions near the camera (within the foliage
 *     range + CASTER_BUILD_MARGIN_M, one region per refresh, the main thread copying the groups' vertex data) and
 *     dropped past CASTER_DROP_MARGIN_M: its VRAM stays with the few regions that can cast. A material-mode cut-out
 *     group (a converted material with its texture) casts as itself, as the chunks do.
 * - T12-M (docs/TREES.md §W3.6, WF15): the new trees cast their **LOD1 only**. A region built on a preset that casts
 *   foliage brings the caster's vertex data from the merge worker (`RegionBatch.casterData`: the table cut-out groups'
 *   LOD1 prefixes with `sroCull`), which the caster uploads as it is (no main-thread copy). Otherwise (a region built on
 *   Medium, then High) the main thread copies each group's LOD1 prefix (`metadata.sroCasterPrefix`). The caster draws
 *   stay one per region.
 */
import {
  BoundingInfo,
  CascadedShadowGenerator,
  DrawWrapper,
  Material,
  Mesh,
  ShaderLanguage,
  ShaderMaterial,
  ShaderStore,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
  Vector4,
  VertexBuffer,
  VertexData,
  type AbstractMesh,
  type BaseTexture,
  type Camera,
  type DirectionalLight,
  type Effect,
  type Matrix,
  type Scene,
  type ShadowDepthWrapper,
  type SubMesh,
} from '@babylonjs/core'
import '@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexExtraDeclaration.js'
import '@babylonjs/core/Shaders/ShadersInclude/shadowMapFragmentExtraDeclaration.js'
import '@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexNormalBias.js'
import '@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexMetric.js'
import '@babylonjs/core/Shaders/ShadersInclude/shadowMapFragment.js'
import '@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapVertexExtraDeclaration.js'
import '@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapFragmentExtraDeclaration.js'
import '@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapVertexNormalBias.js'
import '@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapVertexMetric.js'
import '@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapFragment.js'
import type { WorldModel, WorldPlacement } from '../../../convert/src/world/manifest.ts'
import { casterPrefixOf, type MergedCaster } from '../batch/merge-core.ts'
import type { RegionBatch } from '../batch/types.ts'
import { GROUP_RANGE_M } from '../objects.ts'
import { SRO_SURFACE_PLUGIN, TABLE_MIN_CUTOFF, TABLE_TEXEL, type SroSurfacePlugin, type SurfaceTable } from '../pbr/surface-plugin.ts'
import type { PlacedModelInfo, RegionListener } from '../objects.ts'
import type { RegionData } from '../regions.ts'
import type { CommitStepAfter } from '../stream.ts'
import { uvScrollPluginOf } from '../uv-scroll.ts'
import type { RenderPart } from './index.ts'
import { LIGHT_LOOK } from './look.ts'
import type { RenderQuality, ShadowQuality } from './quality.ts'

/** Layer-mask bit of the shadow proxies: outside Babylon's default camera mask 0x0FFFFFFF and WORLD_OBJECT_LAYER. */
export const SHADOW_PROXY_LAYER = 0x20000000
/** The caster list is rebuilt after the camera moved this far (m). */
export const CASTER_REFRESH_M = 8
/** Skinned clones cast within this distance (m) when taller than CLONE_MIN_HEIGHT_M. */
export const CLONE_CASTER_M = 40
/**
 * Characters (players, mobs, NPCs, horses) cast within this distance of the camera (m; at most the shadow distance).
 * Wider than the clones' 40 m: the camera orbits the player at up to 40 m, and the player's own shadow must stay.
 */
export const CHARACTER_CASTER_M = 50
/** While characters are registered the caster list is refreshed this often (ms): they walk in and out of range. */
export const CHARACTER_REFRESH_MS = 500
export const CLONE_MIN_HEIGHT_M = 1
/** The proxy commit step's debounce after a region's objects are in (ms). */
export const PROXY_DEBOUNCE_MS = 500

export type CsmFilter = 'low' | 'medium' | 'high'

/** The CSM per preset (RENDER §4.3), from the preset's shadow block. */
export interface CsmSettings {
  mapSize: number
  cascades: number
  maxZ: number
  lambda: number
  blend: number
  filter: CsmFilter
  /** PCSS light size (shadow-map uv), 0 = PCF (ShadowQuality.soft). */
  soft: number
}

/**
 * Lighting pass 2 (docs/LIGHTING.md §6): on WebGL2 the cascades are at most this size. The 2048² shadow map was the
 * largest part of WebGL2 High's ~11 ms GPU (ANGLE/D3D11: no shadows −3.3 ms, 1024² −1.5…2.3 ms at the plaza);
 * WebGPU keeps 2048².
 */
export const WEBGL2_SHADOW_MAP_MAX = 1024

export function csmSettings(q: Readonly<ShadowQuality>, o: { webgl?: boolean } = {}): CsmSettings {
  // Medium 2 cascades, High 3, Ultra 4 (RENDER §4.3's columns).
  const tier = q.cascades <= 2 ? 0 : q.cascades === 3 ? 1 : 2
  return {
    mapSize: o.webgl ? Math.min(q.mapSize, WEBGL2_SHADOW_MAP_MAX) : q.mapSize,
    cascades: q.cascades,
    maxZ: q.distanceM,
    lambda: [0.7, 0.8, 0.85][tier]!,
    blend: [0.1, 0.08, 0.05][tier]!,
    filter: (['low', 'medium', 'high'] as const)[tier]!,
    soft: q.soft ?? 0,
  }
}

const FILTER_QUALITY: Record<CsmFilter, number> = {
  low: ShadowGenerator.QUALITY_LOW,
  medium: ShadowGenerator.QUALITY_MEDIUM,
  high: ShadowGenerator.QUALITY_HIGH,
}

/** An opaque material (no blending, no alpha test); a mesh without one draws with the scene's default (opaque). */
export function isOpaqueMaterial(mat: Material | null | undefined): boolean {
  if (!mat) return true
  if (mat.alpha < 1) return false
  const tm = mat.transparencyMode
  if (tm !== null && tm !== undefined) return tm === Material.MATERIAL_OPAQUE
  return !mat.needAlphaBlending() && !mat.needAlphaTesting()
}

/** One placement batch a region listener was told about. */
interface Batch {
  owner: number
  /** The owner's region id (streamed batches); -1 for the whole-world load, whose instances are split by position. */
  region: number
  kind: 'static' | 'clone'
  foliage: boolean
  /** Any placement in LOD group 2 (group 3 = small props, in the proxies only on Ultra). */
  g2: boolean
  heightM: number
  meshes: AbstractMesh[]
}

export interface ShadowProxy {
  region: number
  /** The owner whose placements it merged (-1: the whole-world load; SKIN_ONLY_OWNER: a region with no objects). */
  owner: number
  mesh: Mesh
  center: Vector3
  radius: number
  triangles: number
  /** BT-S: it holds the worker proxy of this owner's region batch (that mesh is then not drawn). */
  batchOwner?: number
  /** BT-S: it holds the region's terrain skin (the region's terrain mesh then casts no more). */
  skin?: boolean
}

/** The owner of a proxy built for a region without objects (only its terrain skin): `removed` never names it. */
export const SKIN_ONLY_OWNER = -2
/** The terrain skin keeps every SKIN_STEP-th terrain vertex (BATCHING §3.9: 4 = 8 m). */
export const SKIN_STEP = 4

/**
 * BT-S (BATCHING §3.9): a region's coarse terrain skin for the shadow proxy, in world space. `heights` is the region's
 * (grid × grid, row gz then column gx; vertex (gx, gz) at origin + (spacing gx, h, −spacing gz), as terrain.ts builds
 * its mesh). It keeps every `step`-th vertex, each at the lowest height around it, so the skin stays under the ground
 * and the terrain never receives the shadow of its own skin: an interior vertex takes the minimum of the
 * (2 step + 1)² window, an edge vertex the minimum along its edge line only (the shared edge row: a neighbour's skin
 * makes the same vertex, no crack), and a corner its exact height. Two triangles per cell (the proxy draws both faces).
 */
export function terrainSkin(heights: ArrayLike<number>, origin: readonly number[], step = SKIN_STEP, spacing = 2): { positions: Float32Array; indices: Uint32Array } {
  const grid = Math.round(Math.sqrt(heights.length))
  if (grid < 2 || grid * grid !== heights.length) return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  const s = (grid - 1) % step === 0 ? step : 1
  const n = (grid - 1) / s + 1
  const last = grid - 1
  const h = (gx: number, gz: number) => heights[gz * grid + gx]!
  const positions = new Float32Array(n * n * 3)
  for (let j = 0; j < n; j++) {
    const gz = j * s
    const zEdge = gz === 0 || gz === last
    for (let i = 0; i < n; i++) {
      const gx = i * s
      const xEdge = gx === 0 || gx === last
      let y = Infinity
      if (xEdge && zEdge) y = h(gx, gz)
      else if (xEdge) for (let z = Math.max(0, gz - s); z <= Math.min(last, gz + s); z++) y = Math.min(y, h(gx, z))
      else if (zEdge) for (let x = Math.max(0, gx - s); x <= Math.min(last, gx + s); x++) y = Math.min(y, h(x, gz))
      else {
        for (let z = Math.max(0, gz - s); z <= Math.min(last, gz + s); z++) {
          for (let x = Math.max(0, gx - s); x <= Math.min(last, gx + s); x++) y = Math.min(y, h(x, z))
        }
      }
      const o = (j * n + i) * 3
      positions[o] = origin[0]! + spacing * gx
      positions[o + 1] = origin[1]! + y
      positions[o + 2] = origin[2]! - spacing * gz
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6)
  let k = 0
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      const b = a + 1
      const c = a + n
      const d = c + 1
      indices[k++] = a
      indices[k++] = c
      indices[k++] = b
      indices[k++] = b
      indices[k++] = c
      indices[k++] = d
    }
  }
  return { positions, indices }
}

/** Concatenates position/index lists (indices re-based). */
function concatGeometry(parts: ReadonlyArray<{ positions: ArrayLike<number>; indices: ArrayLike<number> }>): { positions: Float32Array; indices: Uint32Array } {
  let pv = 0
  let iv = 0
  for (const p of parts) {
    pv += p.positions.length
    iv += p.indices.length
  }
  const positions = new Float32Array(pv)
  const indices = new Uint32Array(iv)
  let po = 0
  let io = 0
  for (const p of parts) {
    positions.set(p.positions, po)
    const base = po / 3
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i]! + base
    po += p.positions.length
    io += p.indices.length
  }
  return { positions, indices }
}

/** The positions and indices of a plain mesh (a worker proxy), or null without data. */
function geometryOf(mesh: AbstractMesh | null | undefined): { positions: ArrayLike<number>; indices: ArrayLike<number> } | null {
  if (!mesh || mesh.isDisposed()) return null
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)
  if (!positions || positions.length < 9) return null
  const idx = mesh.getIndices()
  return { positions, indices: idx && idx.length ? idx : Array.from({ length: positions.length / 3 }, (_, i) => i) }
}

/** The LOD group of a region-batch group mesh (its name `batch:<owner>:<lod>:…`, region-batch.ts); 2 when unknown. */
function batchLodOf(mesh: AbstractMesh): number {
  const m = /^batch:-?\d+:(\d):/.exec(mesh.name)
  return m ? Number(m[1]) : 2
}

// ---- the cut-out caster (BT-S, BATCHING §3.9) ------------------------------------------------------------------------

/** The cut-out caster's shader name (ShaderStore, both languages). */
export const CUTOUT_CASTER_SHADER = 'sroCutoutCaster'
/** Its samplers: the albedo atlas array (alpha = the cut-out mask) and the material table. */
export const CUTOUT_CASTER_SAMPLERS: readonly string[] = ['sroAlbArr', 'sroTable']
/** Its own uniforms, then the ones Babylon's shadow generator sets on a depth effect. */
export const CUTOUT_CASTER_UNIFORMS: readonly string[] = ['world', 'viewProjection', 'sroEye', 'biasAndScaleSM', 'depthValuesSM', 'lightDataSM', 'softTransparentShadowSM']
/** The per-vertex range sphere of a merged caster: (centre, radius) of a group-3 piece's sub-chunk, radius < 0 for group 2. */
export const CASTER_CULL_KIND = 'sroCull'
export const CUTOUT_CASTER_ATTRIBUTES: readonly string[] = ['position', 'normal', 'uv', 'uv2', CASTER_CULL_KIND]
/** A region's merged cut-out caster is built once the camera is this close to the foliage range of its groups (m). */
export const CASTER_BUILD_MARGIN_M = 40
/** …and dropped (its VRAM freed) past this margin (m). */
export const CASTER_DROP_MARGIN_M = 120
/** Merged casters built per caster refresh (the rest follow on the next frames: a bounded main-thread copy). */
export const CASTER_BUILDS_PER_REFRESH = 1

const MIN_CUT = TABLE_MIN_CUTOFF.toFixed(3)

/**
 * The cut-out caster's shaders. The material's own effect (never drawn: the caster is on SHADOW_PROXY_LAYER) skips the
 * shadow code; the depth effect `CasterDepthWrapper` makes from the same source has Babylon's shadow defines
 * (`SM_FLOAT` is always among them) and runs Babylon's shadow-map includes, exactly as Babylon's own depth shader
 * does: normal bias, the depth metric, depth clamp. The alpha test reads the slot (UV2's integer part, packTableUv2)
 * row of the material table: its albedo cell (TABLE_TEXEL.albedo; v scale in misc.w) and cut-off (misc.z), and samples
 * the albedo atlas with explicit gradients taken first, in uniform control flow (as SRO_TABLE does). A vertex whose
 * `sroCull` sphere lies past the group-3 range from the eye (`sroEye`: the camera position, w the range) goes to the
 * sphere's centre, so its piece has no area (BATCHING §3.8's collapse; the batch's own `distance − radius < range`).
 */
export function cutoutCasterShaders(): { vertexWGSL: string; fragmentWGSL: string; vertexGLSL: string; fragmentGLSL: string; uniforms: string[]; samplers: string[]; chunkSamplers: string[] } {
  const A = TABLE_TEXEL.albedo
  const M = TABLE_TEXEL.misc
  const vertexWGSL = /* wgsl */ `
attribute position: vec3f;
attribute normal: vec3f;
attribute uv: vec2f;
attribute uv2: vec2f;
attribute sroCull: vec4f;
uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform sroEye: vec4f;
varying vUV: vec2f;
varying vUV2: vec2f;
#ifdef SM_FLOAT
#include<shadowMapVertexExtraDeclaration>
#endif
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  var worldPos = uniforms.world * vec4f(vertexInputs.position, 1.0);
  let sroC = vertexInputs.sroCull;
  if (sroC.w >= 0.0 && distance(uniforms.sroEye.xyz, sroC.xyz) - sroC.w > uniforms.sroEye.w) {
    worldPos = vec4f(sroC.xyz, 1.0);
  }
#ifdef SM_FLOAT
#if SM_NORMALBIAS==1
  let normWorldSM = mat3x3f(uniforms.world[0].xyz, uniforms.world[1].xyz, uniforms.world[2].xyz);
  let vNormalW = normalize(normWorldSM * vertexInputs.normal);
#endif
#include<shadowMapVertexNormalBias>
#endif
  vertexOutputs.position = uniforms.viewProjection * worldPos;
#ifdef SM_FLOAT
#include<shadowMapVertexMetric>
#endif
  vertexOutputs.vUV = vertexInputs.uv;
  vertexOutputs.vUV2 = vertexInputs.uv2;
}
`
  const fragmentWGSL = /* wgsl */ `
var sroAlbArr: texture_2d_array<f32>;
var sroAlbArrSampler: sampler;
var sroTable: texture_2d<f32>;
var sroTableSampler: sampler;
varying vUV: vec2f;
varying vUV2: vec2f;
#ifdef SM_FLOAT
#include<shadowMapFragmentExtraDeclaration>
#endif
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let sroD1 = dpdx(fragmentInputs.vUV);
  let sroD2 = dpdy(fragmentInputs.vUV);
  let sroSlot = i32(floor(fragmentInputs.vUV2.y * 0.5));
  let sroA = textureLoad(sroTable, vec2i(${A}, sroSlot), 0);
  let sroM = textureLoad(sroTable, vec2i(${M}, sroSlot), 0);
  let sroS = vec2f(sroA.w, sroM.w);
  let sroAlpha = textureSampleGrad(sroAlbArr, sroAlbArrSampler, sroA.yz + fract(fragmentInputs.vUV) * sroS, i32(sroA.x + 0.5), sroD1 * sroS, sroD2 * sroS).a;
  if (sroAlpha < max(sroM.z, ${MIN_CUT})) {
    discard;
  }
#ifdef SM_FLOAT
#include<shadowMapFragment>
#else
  fragmentOutputs.color = vec4f(1.0);
#endif
}
`
  const vertexGLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec2 uv2;
attribute vec4 sroCull;
uniform mat4 world;
uniform mat4 viewProjection;
uniform vec4 sroEye;
varying vec2 vUV;
varying vec2 vUV2;
#ifdef SM_FLOAT
#include<shadowMapVertexExtraDeclaration>
#endif
void main(void) {
  vec4 worldPos = world * vec4(position, 1.0);
  if (sroCull.w >= 0.0 && distance(sroEye.xyz, sroCull.xyz) - sroCull.w > sroEye.w) worldPos = vec4(sroCull.xyz, 1.0);
#ifdef SM_FLOAT
#if SM_NORMALBIAS==1
  vec3 vNormalW = normalize(mat3(world) * normal);
#endif
#include<shadowMapVertexNormalBias>
#endif
  gl_Position = viewProjection * worldPos;
#ifdef SM_FLOAT
#include<shadowMapVertexMetric>
#endif
  vUV = uv;
  vUV2 = uv2;
}
`
  const fragmentGLSL = /* glsl */ `
precision highp float;
uniform highp sampler2DArray sroAlbArr;
uniform highp sampler2D sroTable;
varying vec2 vUV;
varying vec2 vUV2;
#ifdef SM_FLOAT
#include<shadowMapFragmentExtraDeclaration>
#endif
void main(void) {
  vec2 sroD1 = dFdx(vUV);
  vec2 sroD2 = dFdy(vUV);
  int sroSlot = int(floor(vUV2.y * 0.5));
  vec4 sroA = texelFetch(sroTable, ivec2(${A}, sroSlot), 0);
  vec4 sroM = texelFetch(sroTable, ivec2(${M}, sroSlot), 0);
  vec2 sroS = vec2(sroA.w, sroM.w);
  float sroAlpha = textureGrad(sroAlbArr, vec3(sroA.yz + fract(vUV) * sroS, floor(sroA.x + 0.5)), sroD1 * sroS, sroD2 * sroS).a;
  if (sroAlpha < max(sroM.z, ${MIN_CUT})) discard;
#ifdef SM_FLOAT
#include<shadowMapFragment>
#else
  gl_FragColor = vec4(1.0);
#endif
}
`
  return { vertexWGSL, fragmentWGSL, vertexGLSL, fragmentGLSL, uniforms: [...CUTOUT_CASTER_UNIFORMS], samplers: [...CUTOUT_CASTER_SAMPLERS], chunkSamplers: [] }
}

let casterShadersRegistered = false
function registerCasterShaders(): void {
  if (casterShadersRegistered) return
  casterShadersRegistered = true
  const src = cutoutCasterShaders()
  ShaderStore.ShadersStoreWGSL[`${CUTOUT_CASTER_SHADER}VertexShader`] = src.vertexWGSL
  ShaderStore.ShadersStoreWGSL[`${CUTOUT_CASTER_SHADER}FragmentShader`] = src.fragmentWGSL
  ShaderStore.ShadersStore[`${CUTOUT_CASTER_SHADER}VertexShader`] = src.vertexGLSL
  ShaderStore.ShadersStore[`${CUTOUT_CASTER_SHADER}FragmentShader`] = src.fragmentGLSL
}

/**
 * The cut-out caster's shadow-depth wrapper (duck-typed as Babylon's ShadowDepthWrapper, `standalone`): the shadow
 * generator asks it for a depth effect per submesh, and it hands every caster the same effect per shadow define set
 * (Babylon's own wrapper compiles one per submesh from the material's processed code). Each submesh keeps its own
 * DrawWrapper per render pass (its draw context), as Babylon's does. The material binds it (`bindForSubMesh` with the
 * override effect): world, viewProjection (the cascade's: the generator sets the scene's transform per layer) and the
 * table's textures.
 */
export class CasterDepthWrapper {
  readonly standalone = true
  readonly doNotInjectCode = true
  private readonly effects = new Map<string, Effect>()
  private readonly draws = new WeakMap<SubMesh, Map<number, { key: string; draw: DrawWrapper }>>()

  constructor(readonly baseMaterial: CutoutCasterMaterial) {}

  /** The depth effects made so far (one per shadow define set). */
  get effectCount(): number {
    return this.effects.size
  }

  isReadyForSubMesh(subMesh: SubMesh, defines: readonly string[], _generator: unknown, useInstances: boolean, passId: number): boolean {
    const base = this.baseMaterial
    if (!base.isReadyForSubMesh(subMesh.getMesh(), subMesh, useInstances)) return false
    const key = defines.join('\n')
    let effect = this.effects.get(key)
    if (!effect) {
      const engine = base.getScene().getEngine()
      effect = engine.createEffect({ vertex: CUTOUT_CASTER_SHADER, fragment: CUTOUT_CASTER_SHADER }, {
        attributes: [...CUTOUT_CASTER_ATTRIBUTES],
        uniformsNames: [...CUTOUT_CASTER_UNIFORMS],
        uniformBuffersNames: [],
        samplers: [...CUTOUT_CASTER_SAMPLERS],
        defines: key,
        fallbacks: null,
        onCompiled: null,
        onError: null,
        indexParameters: {},
        shaderLanguage: base.shaderLanguage,
      }, engine)
      this.effects.set(key, effect)
    }
    let perPass = this.draws.get(subMesh)
    if (!perPass) this.draws.set(subMesh, perPass = new Map())
    let entry = perPass.get(passId)
    if (!entry) perPass.set(passId, entry = { key: '', draw: new DrawWrapper(base.getScene().getEngine()) })
    if (entry.key !== key) {
      entry.draw.setEffect(effect, null)
      entry.key = key
    }
    return effect.isReady()
  }

  getEffect(subMesh: SubMesh, _generator: unknown, passId: number): DrawWrapper | null {
    return this.draws.get(subMesh)?.get(passId)?.draw ?? null
  }

  dispose(): void {
    for (const e of this.effects.values()) e.dispose()
    this.effects.clear()
  }
}

/**
 * The standalone cut-out caster material (BATCHING §3.9): only shadow-only meshes use it, so no PBR prepass or MRT
 * applies. It reads the table's textures at every readiness check and bind (BT-A swaps a grown array in place), and
 * is not ready until the albedo array and the table exist and are ready (a missing binding would drop the WebGPU
 * frame). Two-sided: a single-sided cut-out piece casts from both faces, like the proxies.
 */
export class CutoutCasterMaterial extends ShaderMaterial {
  readonly depth: CasterDepthWrapper
  /** The eye (the camera's position) and the group-3 range (m) of the vertex collapse; set every frame by WorldShadows. */
  readonly eye = new Vector4(0, 0, 0, 1e9)
  private albedoBound: BaseTexture | null = null
  private tableBound: BaseTexture | null = null

  constructor(name: string, scene: Scene, readonly table: SurfaceTable) {
    registerCasterShaders()
    super(name, scene, CUTOUT_CASTER_SHADER, {
      attributes: [...CUTOUT_CASTER_ATTRIBUTES],
      uniforms: [...CUTOUT_CASTER_UNIFORMS],
      samplers: [...CUTOUT_CASTER_SAMPLERS],
      shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    this.backFaceCulling = false
    this.setVector4('sroEye', this.eye)
    this.depth = new CasterDepthWrapper(this)
    this.shadowDepthWrapper = this.depth as unknown as ShadowDepthWrapper
  }

  /** Binds the table's current textures; false while one is missing or (with `ready`) not ready. */
  private syncTextures(ready: boolean): boolean {
    const t = this.table
    if (!t.albedo || !t.table) return false
    if (ready && (!t.albedo.isReady() || !t.table.isReady())) return false
    if (this.albedoBound !== t.albedo) this.setTexture('sroAlbArr', this.albedoBound = t.albedo)
    if (this.tableBound !== t.table) this.setTexture('sroTable', this.tableBound = t.table)
    return true
  }

  override isReady(mesh?: AbstractMesh, useInstances?: boolean, subMesh?: SubMesh): boolean {
    if (!this.syncTextures(true)) return false
    return super.isReady(mesh, useInstances, subMesh)
  }

  /**
   * Every caster binds in full: ShaderMaterial skips its textures and uniforms when the scene's cached material is this
   * one, but on WebGPU each caster draws through its own DrawWrapper (its own material context), so a skipped bind left
   * the next casters on the array BT-A had just replaced (a destroyed texture in every submit) and on the previous
   * cascade's viewProjection.
   */
  override bind(world: Matrix, mesh?: AbstractMesh, effectOverride?: Effect | null, subMesh?: SubMesh): void {
    this.syncTextures(false)
    this.getScene().resetCachedMaterial()
    super.bind(world, mesh, effectOverride, subMesh)
  }

  override dispose(forceDisposeEffect?: boolean, forceDisposeTextures?: boolean, notBoundToMesh?: boolean): void {
    this.depth.dispose()
    this.shadowDepthWrapper = null
    // The textures are the table's (BT-A owns them).
    super.dispose(forceDisposeEffect, false, notBoundToMesh)
  }
}

/** The material table of a table-mode group mesh (its SroSurfacePlugin in table mode), or null. */
export function surfaceTableOf(mesh: AbstractMesh): SurfaceTable | null {
  const mat = mesh.material as { pluginManager?: { getPlugin(name: string): unknown } | null } | null
  const plugin = mat?.pluginManager?.getPlugin(SRO_SURFACE_PLUGIN) as SroSurfacePlugin | null | undefined
  return plugin && plugin.table && plugin.tableOn(mesh) ? plugin.table : null
}

/** What ShadowProxies keeps of one owner's region batch. */
interface BatchShadow {
  region: number
  batch: RegionBatch
  /** The worker's proxy (not ours to dispose). */
  proxy: ShadowProxy | null
  /** Cut-out group meshes that cast as themselves (material mode: their converted material alpha-tests). */
  cutouts: AbstractMesh[]
  /** The table-mode cut-out groups (merged into `caster` near the camera) and their table. */
  sources: Mesh[]
  table: SurfaceTable | null
  /** The sources' world sphere (the build and drop distance test). */
  center: Vector3
  radius: number
  /** The region's merged cut-out caster, while near. */
  caster: Mesh | null
}

/** The first `n` values of an array (a view of a typed array; a copy of a plain one). */
function head(a: ArrayLike<number>, n: number): ArrayLike<number> {
  if (a.length <= n) return a
  return ArrayBuffer.isView(a) ? (a as unknown as Float32Array).subarray(0, n) : Array.prototype.slice.call(a, 0, n)
}

/** The cut-out caster's vertex data (the worker's `MergedCaster` layout, render/shadows.ts' main-thread copy). */
export type CasterData = Pick<MergedCaster, 'positions' | 'normals' | 'uvs' | 'uvs2' | 'cull' | 'indices'>

/**
 * T12-M (WF15): the merge worker's caster data of a region batch (`casterData`, region-batch.ts), when it holds exactly
 * the `sources` groups this region casts with; null otherwise (the main-thread copy then).
 */
export function workerCasterOf(batch: RegionBatch, sources: number): CasterData | null {
  const c = (batch as { casterData?: MergedCaster | null }).casterData
  return c && c.groups === sources && c.positions.length >= 9 ? c : null
}

/**
 * Merges table-mode cut-out group meshes (world space, identity world matrices: BT-M's groups) into one caster's vertex
 * data: positions, normals, uv, uv2, and per vertex `sroCull` = its group-3 sub-chunk's sphere (radius −1 for group 2).
 * T12-M: a tree group with tier-2 pieces gives its LOD1 prefix only (`metadata.sroCasterPrefix`). null when no source
 * has the data.
 */
export function mergeCutoutCasters(sources: readonly AbstractMesh[]): CasterData | null {
  type Part = { pos: ArrayLike<number>; nrm: ArrayLike<number> | null; uv: ArrayLike<number>; uv2: ArrayLike<number>; idx: ArrayLike<number> | null; sphere: [number, number, number, number] }
  const parts: Part[] = []
  let nv = 0
  let ni = 0
  for (const m of sources) {
    if (m.isDisposed()) continue
    let pos: ArrayLike<number> | null = m.getVerticesData(VertexBuffer.PositionKind)
    let uv: ArrayLike<number> | null = m.getVerticesData(VertexBuffer.UVKind)
    let uv2: ArrayLike<number> | null = m.getVerticesData(VertexBuffer.UV2Kind)
    let nrm: ArrayLike<number> | null = m.getVerticesData(VertexBuffer.NormalKind)
    let idx: ArrayLike<number> | null = m.getIndices()
    const pre = casterPrefixOf(m)
    if (pre && pos && uv && uv2) {
      pos = head(pos, pre.vertices * 3)
      uv = head(uv, pre.vertices * 2)
      uv2 = head(uv2, pre.vertices * 2)
      nrm = nrm ? head(nrm, pre.vertices * 3) : null
      idx = idx ? head(idx, pre.indices) : null
    }
    if (!pos || !uv || !uv2 || pos.length < 9) continue
    let sphere: [number, number, number, number] = [0, 0, 0, -1]
    if (batchLodOf(m) === 3) {
      const s = m.getBoundingInfo().boundingSphere
      sphere = [s.centerWorld.x, s.centerWorld.y, s.centerWorld.z, s.radiusWorld]
    }
    parts.push({ pos, nrm, uv, uv2, idx: idx && idx.length ? idx : null, sphere })
    nv += pos.length / 3
    ni += idx && idx.length ? idx.length : pos.length / 3
  }
  if (!nv) return null
  const positions = new Float32Array(nv * 3)
  const normals = new Float32Array(nv * 3)
  const uvs = new Float32Array(nv * 2)
  const uvs2 = new Float32Array(nv * 2)
  const cull = new Float32Array(nv * 4)
  const indices = new Uint32Array(ni)
  let v = 0
  let i = 0
  for (const p of parts) {
    const n = p.pos.length / 3
    positions.set(p.pos, v * 3)
    if (p.nrm && p.nrm.length === n * 3) normals.set(p.nrm, v * 3)
    uvs.set(head(p.uv, n * 2), v * 2)
    uvs2.set(head(p.uv2, n * 2), v * 2)
    for (let k = 0; k < n; k++) cull.set(p.sphere, (v + k) * 4)
    if (p.idx) for (let k = 0; k < p.idx.length; k++) indices[i++] = p.idx[k]! + v
    else for (let k = 0; k < n; k++) indices[i++] = v + k
    v += n
  }
  return { positions, normals, uvs, uvs2, cull, indices }
}

interface RegionRect {
  id: number
  x0: number
  x1: number
  z0: number
  z1: number
}

const rectOf = (r: RegionData): RegionRect => {
  const o = r.region.origin
  return { id: r.region.id, x0: o[0], x1: o[0] + 192, z0: o[2] - 192, z1: o[2] }
}
const rectDistance = (r: RegionRect, x: number, z: number) =>
  Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1))

/** The loaded region nearest to (x, z) (0 inside it); ties go to the first. */
function nearestRegion(rects: readonly RegionRect[], x: number, z: number): number {
  let best = -1
  let bestD = Infinity
  for (const r of rects) {
    const d = rectDistance(r, x, z)
    if (d < bestD) {
      bestD = d
      best = r.id
      if (d === 0) break
    }
  }
  return best
}

/** Thin-instance matrices of a mesh (flat, 16 per instance), or its world matrix when it has none. */
function instanceMatrices(mesh: AbstractMesh): { data: ArrayLike<number>; count: number } {
  const m = mesh as AbstractMesh & { _thinInstanceDataStorage?: { matrixData?: Float32Array | null; instancesCount?: number }; thinInstanceCount?: number }
  const store = m._thinInstanceDataStorage
  const count = m.thinInstanceCount ?? 0
  if (store?.matrixData && count > 0) return { data: store.matrixData, count }
  return { data: mesh.computeWorldMatrix(true).m, count: 1 }
}

/**
 * Merges the instances of `meshes` into one position/index list (world space). `keep(x, z)` filters instances by the
 * translation of their matrix (the whole-world load's region split); chunk meshes are frozen at identity, so their
 * instance matrices are world matrices (a mesh that is not at identity is multiplied in).
 */
export function mergeInstances(meshes: readonly AbstractMesh[], keep: (x: number, z: number) => boolean = () => true): { positions: Float32Array; indices: Uint32Array } {
  const parts: Array<{ pos: ArrayLike<number>; idx: ArrayLike<number> | null; mats: number[][] }> = []
  let vertices = 0
  let indexCount = 0
  for (const mesh of meshes) {
    if (mesh.isDisposed()) continue
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind)
    if (!pos || pos.length < 9) continue
    const idx = mesh.getIndices()
    const world = mesh.computeWorldMatrix(true)
    const identity = world.isIdentity()
    const { data, count } = instanceMatrices(mesh)
    const hasThin = count > 0 && data !== world.m
    const mats: number[][] = []
    for (let k = 0; k < count; k++) {
      let m: number[] = Array.from({ length: 16 }, (_, i) => data[k * 16 + i]!)
      if (hasThin && !identity) {
        // instance × mesh world (Babylon's row-vector order).
        const w = world.m
        const r: number[] = new Array(16).fill(0)
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
          let s = 0
          for (let q = 0; q < 4; q++) s += m[i * 4 + q]! * w[q * 4 + j]!
          r[i * 4 + j] = s
        }
        m = r
      }
      if (!keep(m[12]!, m[14]!)) continue
      mats.push(m)
    }
    if (!mats.length) continue
    parts.push({ pos, idx, mats })
    vertices += (pos.length / 3) * mats.length
    indexCount += (idx ? idx.length : pos.length / 3) * mats.length
  }
  const positions = new Float32Array(vertices * 3)
  const indices = new Uint32Array(indexCount)
  let vo = 0
  let io = 0
  for (const { pos, idx, mats } of parts) {
    const n = pos.length / 3
    for (const m of mats) {
      const base = vo
      for (let v = 0; v < n; v++) {
        const x = pos[v * 3]!
        const y = pos[v * 3 + 1]!
        const z = pos[v * 3 + 2]!
        const w = x * m[3]! + y * m[7]! + z * m[11]! + m[15]!
        const iw = w !== 0 && w !== 1 ? 1 / w : 1
        positions[vo * 3] = (x * m[0]! + y * m[4]! + z * m[8]! + m[12]!) * iw
        positions[vo * 3 + 1] = (x * m[1]! + y * m[5]! + z * m[9]! + m[13]!) * iw
        positions[vo * 3 + 2] = (x * m[2]! + y * m[6]! + z * m[10]! + m[14]!) * iw
        vo++
      }
      if (idx) for (let t = 0; t < idx.length; t++) indices[io++] = base + idx[t]!
      else for (let t = 0; t < n; t++) indices[io++] = base + t
    }
  }
  return { positions, indices }
}

/**
 * Per-region shadow proxies and the caster sources (fed by a WorldObjects region listener). Pure bookkeeping plus
 * mesh building; WorldShadows decides which of them reach the shadow map.
 */
export class ShadowProxies implements RegionListener {
  private readonly batches: Batch[] = []
  readonly proxies = new Map<number, ShadowProxy>()
  /**
   * W10-S / BT-S (docs/BATCHING.md §3.1, §3.9, F10): per owner, the region batch's own shadow proxy (built by the merge
   * worker; the batch's, never disposed here), its cut-out groups that cast as themselves, and the casters made for its
   * table-mode cut-out groups (ours). Dropped with the owner.
   */
  private readonly fromBatches = new Map<number, BatchShadow>()
  /** BT-S: the cut-out caster material per material table, with its caster count. */
  private readonly casterMaterials = new Map<SurfaceTable, { material: CutoutCasterMaterial; users: number }>()
  /** BT-S: merged cut-out casters built so far (tests, the lab). */
  castersBuilt = 0
  readonly material: StandardMaterial
  /** Group-3 props merged too (Ultra). */
  props = false
  /** BT-S: the terrain skin is folded into each region's proxy (the preset's `shadows.terrain`: High+). */
  terrain = false
  /** Bumped whenever a proxy or a caster source changed (WorldShadows rebuilds its list). */
  version = 0

  constructor(readonly scene: Scene, private readonly regionsOf: () => readonly RegionData[]) {
    this.material = new StandardMaterial('shadowProxy', scene)
    this.material.backFaceCulling = false
    this.material.disableLighting = true
  }

  // ---- RegionListener -----------------------------------------------------------------------------------------------

  placed(owner: number, _model: WorldModel, info: PlacedModelInfo, meshes: readonly AbstractMesh[], placements: readonly WorldPlacement[]): void {
    const batch: Batch = {
      owner,
      region: owner >= 0 ? placements[0]?.region ?? -1 : -1,
      kind: info.kind,
      foliage: info.isFoliage,
      g2: placements.length === 0 || placements.some(p => p.group !== 3),
      heightM: info.heightM,
      meshes: meshes.filter(m => m.getTotalVertices() > 0),
    }
    for (const m of batch.meshes) m.receiveShadows = true
    this.batches.push(batch)
    this.version++
  }

  removed(owner: number): void {
    for (let i = this.batches.length - 1; i >= 0; i--) if (this.batches[i]!.owner === owner) this.batches.splice(i, 1)
    for (const [region, p] of this.proxies) {
      if (p.owner !== owner) continue
      p.mesh.dispose(false, false)
      this.proxies.delete(region)
    }
    this.dropBatch(owner)
    this.version++
  }

  /**
   * W10-S / BT-S, the proxy input (BATCHING §3.9): a region batch brings its own opaque proxy (the merge worker's,
   * positions only) and its cut-out groups; the batch meshes receive shadows like the chunks. The table-mode cut-out
   * groups wait for their region's merged caster (`updateCasters`); a material-mode one casts as itself.
   */
  batched(owner: number, batch: RegionBatch): void {
    this.dropBatch(owner)
    for (const m of batch.meshes) m.receiveShadows = true
    let proxy: ShadowProxy | null = null
    const pm = batch.shadowProxy
    if (pm && !pm.isDisposed() && pm.getTotalVertices() > 0) {
      const s = pm.getBoundingInfo().boundingSphere
      proxy = { region: batch.region, owner, mesh: pm as Mesh, center: s.centerWorld.clone(), radius: s.radiusWorld, triangles: (pm.getTotalIndices() || pm.getTotalVertices()) / 3 }
    }
    const cutouts: AbstractMesh[] = []
    const sources: Mesh[] = []
    let table: SurfaceTable | null = null
    const min = new Vector3(Infinity, Infinity, Infinity)
    const max = new Vector3(-Infinity, -Infinity, -Infinity)
    for (const m of batch.cutoutCasters) {
      const t = m instanceof Mesh && !m.isDisposed() ? surfaceTableOf(m) : null
      // One material table per world; a group on another one (never in practice) casts as itself.
      if (t && (!table || t === table)) {
        table = t
        sources.push(m as Mesh)
        const box = m.getBoundingInfo().boundingBox
        min.minimizeInPlace(box.minimumWorld)
        max.maximizeInPlace(box.maximumWorld)
      } else cutouts.push(m)
    }
    const center = sources.length ? min.add(max).scaleInPlace(0.5) : Vector3.Zero()
    const radius = sources.length ? Vector3.Distance(min, max) / 2 : 0
    this.fromBatches.set(owner, { region: batch.region, batch, proxy, cutouts, sources, table, center, radius, caster: null })
    this.version++
  }

  /**
   * BT-S: builds the merged cut-out caster of the regions whose cut-out groups come within the foliage range +
   * CASTER_BUILD_MARGIN_M of `cam` (at most CASTER_BUILDS_PER_REFRESH, nearest first), and drops the ones past
   * CASTER_DROP_MARGIN_M (or every one when the preset casts no foliage). Returns true while builds are pending.
   */
  updateCasters(cam: Vector3, foliageM: number): boolean {
    const want: Array<[number, BatchShadow, number]> = []
    for (const [owner, b] of this.fromBatches) {
      if (!b.sources.length || !b.table) continue
      const d = Vector3.Distance(cam, b.center) - b.radius
      // H-12 MM3: past the drop range the worker's caster arrays go too (a region that comes back near is copied from
      // its groups on the main thread, as a region built on a preset without foliage casting is)
      if (d > foliageM + CASTER_DROP_MARGIN_M && (b.batch as { casterData?: unknown }).casterData) (b.batch as { casterData?: unknown }).casterData = null
      if (b.caster && (foliageM <= 0 || d > foliageM + CASTER_DROP_MARGIN_M)) {
        this.dropCaster(b)
        this.version++
      } else if (!b.caster && foliageM > 0 && d < foliageM + CASTER_BUILD_MARGIN_M) want.push([owner, b, d])
    }
    want.sort((x, y) => x[2] - y[2])
    let pending = false
    for (const [owner, b] of want.slice(0, CASTER_BUILDS_PER_REFRESH)) if (this.buildCaster(owner, b) === 'pending') pending = true
    return want.length > CASTER_BUILDS_PER_REFRESH || pending
  }

  /** Every merged caster's material: the eye and the group-3 range (m) of the vertex collapse (per frame). */
  setEye(eye: Vector3, rangeM: number): void {
    for (const m of this.casterMaterials.values()) m.material.eye.set(eye.x, eye.y, eye.z, rangeM)
  }

  /**
   * The region's merged cut-out caster (one shadow-only mesh for every table cut-out group). T12-M: from the merge
   * worker's arrays when the batch brought them (no main-thread copy), else copied here.
   */
  private buildCaster(owner: number, b: BatchShadow): 'pending' | void {
    let data = workerCasterOf(b.batch, b.sources.length)
    if (!data) {
      // H-12 MM3: the worker builds it on demand (the region was far, or built on a preset without foliage shadows)
      const req = (b.batch as { requestCaster?: () => boolean }).requestCaster
      if (req?.call(b.batch)) return 'pending'
      data = mergeCutoutCasters(b.sources)
    }
    if (!data || !b.table) {
      b.sources = []
      return
    }
    let m = this.casterMaterials.get(b.table)
    if (!m) {
      // a new table (a quality switch rebuilt the batch tables): the unused materials of disposed tables go (a
      // disposed BatchTable's textures read null)
      for (const [table, old] of this.casterMaterials) {
        if (old.users > 0 || table.table) continue
        old.material.dispose()
        this.casterMaterials.delete(table)
      }
      this.casterMaterials.set(b.table, m = { material: new CutoutCasterMaterial('cutoutCaster', this.scene, b.table), users: 0 })
    }
    m.users++
    const mesh = new Mesh(`cutoutCaster:${owner}`, this.scene)
    mesh.setVerticesData(VertexBuffer.PositionKind, data.positions, false, 3)
    mesh.setVerticesData(VertexBuffer.NormalKind, data.normals, false, 3)
    mesh.setVerticesData(VertexBuffer.UVKind, data.uvs, false, 2)
    mesh.setVerticesData(VertexBuffer.UV2Kind, data.uvs2, false, 2)
    mesh.setVerticesData(CASTER_CULL_KIND, data.cull, false, 4)
    mesh.setIndices(data.indices, data.positions.length / 3)
    mesh.material = m.material
    mesh.layerMask = SHADOW_PROXY_LAYER
    mesh.isPickable = false
    mesh.receiveShadows = false
    mesh.metadata = { sroWorld: 'shadowProxy', sroBatch: 'cutoutCaster' }
    mesh.freezeWorldMatrix()
    mesh.doNotSyncBoundingInfo = true
    b.caster = mesh
    this.castersBuilt++
    this.version++
  }

  private dropCaster(b: BatchShadow): void {
    const mesh = b.caster
    if (!mesh) return
    b.caster = null
    const material = mesh.material as CutoutCasterMaterial | null
    mesh.dispose(false, false)
    const m = material ? this.casterMaterials.get(material.table) : undefined
    // H-12 HI-1: the material stays when its last caster goes (it holds no VRAM of its own): a caster built after a
    // teleport or a respawn reuses its compiled effects instead of compiling them again in play (D25). It goes with
    // ShadowProxies.dispose, or when its table is replaced (buildCaster).
    if (m) m.users = Math.max(0, m.users - 1)
  }

  private dropBatch(owner: number): void {
    const b = this.fromBatches.get(owner)
    if (!b) return
    this.fromBatches.delete(owner)
    this.dropCaster(b)
  }

  /** Every proxy that may cast: the built ones, and the region batches' that no built one holds (W10-S, BT-S). */
  *allProxies(): IterableIterator<ShadowProxy> {
    yield* this.proxies.values()
    for (const [owner, b] of this.fromBatches) if (b.proxy && this.proxies.get(b.region)?.batchOwner !== owner) yield b.proxy
  }

  /** The region's proxy holds its terrain skin (its terrain mesh casts no more). */
  hasSkin(region: number): boolean {
    return this.proxies.get(region)?.skin === true
  }

  /** The region batch shadow state of a region (its newest owner), or null. */
  private batchOfRegion(region: number): [number, BatchShadow] | null {
    let best: [number, BatchShadow] | null = null
    for (const [owner, b] of this.fromBatches) if (b.region === region && (!best || owner > best[0])) best = [owner, b]
    return best
  }

  // ---- proxies ------------------------------------------------------------------------------------------------------

  /**
   * Builds (or rebuilds) one region's proxy (the `shadowProxy` commit step). It holds the opaque statics placed as
   * chunks, and on a batched region the worker's proxy plus what it lacks (group-3 pieces on Ultra), and the terrain
   * skin when the preset casts terrain (BT-S). A batched region with nothing to add keeps the worker's mesh (returned,
   * not stored). null when there is nothing to cast.
   */
  build(region: RegionData): ShadowProxy | null {
    const id = region.region.id
    const old = this.proxies.get(id)
    if (old) {
      old.mesh.dispose(false, false)
      this.proxies.delete(id)
      this.version++
    }
    const wants = (b: Batch) => b.kind === 'static' && !b.foliage && (b.g2 || this.props)
    // Streamed: the newest owner of this region (an old chunk may still be unloading).
    let owner = -1
    for (const b of this.batches) if (b.region === id && b.owner > owner) owner = b.owner
    const fb = this.batchOfRegion(id)
    if (fb && fb[0] > owner) owner = fb[0]
    const opaque = (list: Batch[]) => list.flatMap(b => b.meshes.filter(m => !m.isDisposed() && isOpaqueMaterial(m.material)))
    const own = opaque(this.batches.filter(b => owner >= 0 && b.owner === owner && wants(b)))
    const whole = opaque(this.batches.filter(b => b.owner < 0 && wants(b)))
    let rects: RegionRect[] | null = null
    const inRegion = (x: number, z: number) => nearestRegion(rects ??= this.regionsOf().map(rectOf), x, z) === id
    const extra: Array<{ positions: ArrayLike<number>; indices: ArrayLike<number> }> = []
    if (own.length) extra.push(mergeInstances(own))
    if (whole.length) extra.push(mergeInstances(whole, inRegion))
    const batch = fb && fb[0] === owner ? fb[1] : null
    if (batch && this.props) {
      // The worker's proxy holds group 2 only (BATCHING §3.9); Ultra casts the batch's opaque group-3 pieces too.
      const cut = new Set<AbstractMesh>(batch.batch.cutoutCasters)
      const g3 = batch.batch.meshes.filter(m => !m.isDisposed() && !cut.has(m) && batchLodOf(m) === 3 && isOpaqueMaterial(m.material))
      if (g3.length) extra.push(mergeInstances(g3))
    }
    const heights = (region as Partial<RegionData>).terrain?.heights
    const skin = this.terrain && heights ? terrainSkin(heights, region.region.origin) : null
    if (skin && skin.indices.length) extra.push(skin)
    const parts = extra.filter(p => p.indices.length > 0)
    if (!parts.length) {
      // Nothing to add: the worker's mesh casts as it is (allProxies yields it).
      return batch?.proxy ?? null
    }
    const batchGeometry = batch?.proxy ? geometryOf(batch.proxy.mesh) : null
    if (batchGeometry) parts.unshift(batchGeometry)
    const { positions, indices } = concatGeometry(parts)
    const mesh = new Mesh(`shadowProxy:${id}`, this.scene)
    const vd = new VertexData()
    vd.positions = positions
    vd.indices = indices
    vd.applyToMesh(mesh, false)
    mesh.layerMask = SHADOW_PROXY_LAYER
    mesh.isPickable = false
    mesh.receiveShadows = false
    mesh.material = this.material
    mesh.metadata = { sroWorld: 'shadowProxy' }
    mesh.freezeWorldMatrix()
    mesh.doNotSyncBoundingInfo = true
    const s = mesh.getBoundingInfo().boundingSphere
    const proxy: ShadowProxy = {
      region: id,
      // A region with no objects: only its skin, which `removed` never names (prune drops it).
      owner: owner === -1 && !whole.length ? SKIN_ONLY_OWNER : owner,
      mesh,
      center: s.centerWorld.clone(),
      radius: s.radiusWorld,
      triangles: indices.length / 3,
    }
    if (batchGeometry) proxy.batchOwner = owner
    if (skin && skin.indices.length) proxy.skin = true
    this.proxies.set(id, proxy)
    this.version++
    return proxy
  }

  /** Drops the skin-only proxies of regions no longer loaded (no owner that `removed` would name). */
  prune(): void {
    let ids: Set<number> | null = null
    for (const [region, p] of this.proxies) {
      if (p.owner !== SKIN_ONLY_OWNER) continue
      ids ??= new Set(this.regionsOf().map(r => r.region.id))
      if (ids.has(region)) continue
      p.mesh.dispose(false, false)
      this.proxies.delete(region)
      this.version++
    }
  }

  /** Regions that have placements (for a rebuild after `props` changed). */
  regionIds(): number[] {
    const ids = new Set<number>()
    for (const b of this.batches) if (b.region >= 0) ids.add(b.region)
    for (const b of this.fromBatches.values()) ids.add(b.region)
    if (this.batches.some(b => b.owner < 0)) for (const r of this.regionsOf()) ids.add(r.region.id)
    return [...ids]
  }

  /**
   * Cut-out statics (trees, bushes, alpha-tested props): they cast within the foliage range, never in a proxy. A
   * region batch's table-mode cut-out groups cast through its merged caster (BT-S), the others as themselves.
   */
  cutouts(): AbstractMesh[] {
    const out: AbstractMesh[] = []
    for (const b of this.batches) {
      if (b.kind !== 'static') continue
      // UV scroll: a scrolling sheet (a waterfall) casts no cut-out shadow: the shadow pass's mask would stand still.
      for (const m of b.meshes) if (!m.isDisposed() && (b.foliage || !isOpaqueMaterial(m.material)) && !uvScrollPluginOf(m.material)) out.push(m)
    }
    for (const b of this.fromBatches.values()) {
      for (const m of b.cutouts) if (!m.isDisposed()) out.push(m)
      if (b.caster && !b.caster.isDisposed()) out.push(b.caster)
    }
    return out
  }

  /** The merged cut-out caster of an owner's batch, or null (tests, the lab). */
  casterOf(owner: number): Mesh | null {
    return this.fromBatches.get(owner)?.caster ?? null
  }

  /** Skinned clones taller than CLONE_MIN_HEIGHT_M, per batch (their meshes and whether they are foliage). */
  clones(): Array<{ foliage: boolean; meshes: AbstractMesh[] }> {
    return this.batches.filter(b => b.kind === 'clone' && b.heightM > CLONE_MIN_HEIGHT_M).map(b => ({ foliage: b.foliage, meshes: b.meshes }))
  }

  dispose(): void {
    for (const p of this.proxies.values()) p.mesh.dispose(false, false)
    this.proxies.clear()
    for (const owner of [...this.fromBatches.keys()]) this.dropBatch(owner)
    for (const m of this.casterMaterials.values()) m.material.dispose()
    this.casterMaterials.clear()
    this.batches.length = 0
    this.material.dispose()
  }
}

/**
 * W10-S (docs/BATCHING.md §3.9, D8): another source of shadow casters (BT-S: the per-region cut-out casters and the
 * terrain skin). `casters` gives the ones to draw for a camera position and preset; bump `version` whenever they
 * change, and WorldShadows rebuilds its list at the next update.
 */
export interface ShadowCasterSource {
  readonly version: number
  casters(cam: Vector3, q: Readonly<ShadowQuality>): Iterable<AbstractMesh>
}

/** A mesh's world bounding sphere (from its bounding info). */
function sphereOf(m: AbstractMesh): { c: Vector3; r: number } {
  const s = m.getBoundingInfo().boundingSphere
  return { c: s.centerWorld, r: s.radiusWorld }
}

/** Within `range` of the camera: distance to the sphere's surface < range. */
const within = (cam: Vector3, c: Vector3, r: number, range: number) => Vector3.Distance(cam, c) - r < range

export interface CasterInputs {
  proxies: Iterable<ShadowProxy>
  cutouts: readonly AbstractMesh[]
  clones: ReadonlyArray<{ foliage: boolean; meshes: AbstractMesh[] }>
  terrain: readonly AbstractMesh[]
  characters: Iterable<AbstractMesh>
  /** Characters cast within this distance of the camera (m; default CHARACTER_CASTER_M, capped by the shadow distance). */
  characterM?: number
  /**
   * G1 rescue (the crowd budget, WorldShadows.setCharacterCascades): how many cascades a character root casts into
   * (absent: all). A root at 0 casts nothing; one limited to k ≥ 1 is listed and gets k in `limited` (with its parts).
   */
  characterCascades?: ReadonlyMap<AbstractMesh, number>
  /** Filled with every listed character mesh whose root is limited to fewer cascades than the shadow has. */
  limited?: Map<AbstractMesh, number>
}

/** The shadow map's render list for a camera position (RENDER §4.3 `ShadowCasters.update`). */
export function selectCasters(cam: Vector3, q: Readonly<ShadowQuality>, i: CasterInputs): AbstractMesh[] {
  const out: AbstractMesh[] = []
  for (const p of i.proxies) if (!p.mesh.isDisposed() && within(cam, p.center, p.radius, q.distanceM)) out.push(p.mesh)
  if (q.foliageM > 0) {
    for (const m of i.cutouts) {
      const s = sphereOf(m)
      if (within(cam, s.c, s.r, q.foliageM)) out.push(m)
    }
  }
  for (const c of i.clones) {
    if (c.foliage && q.foliageM <= 0) continue
    const range = c.foliage ? Math.min(CLONE_CASTER_M, q.foliageM) : CLONE_CASTER_M
    for (const m of c.meshes) {
      if (m.isDisposed()) continue
      const s = sphereOf(m)
      if (Vector3.Distance(cam, s.c) < range) out.push(m)
    }
  }
  if (q.terrain) {
    for (const m of i.terrain) {
      const s = sphereOf(m)
      if (within(cam, s.c, s.r, q.distanceM)) out.push(m)
    }
  }
  // Characters by their root's position (skinned parts keep bind-pose bounds), and only their shown parts: an armour
  // piece hides the body part it replaces, and the periodic refresh picks a part up again once it is shown.
  const charM = Math.min(i.characterM ?? CHARACTER_CASTER_M, q.distanceM)
  for (const root of i.characters) {
    if (root.isDisposed() || !root.isEnabled()) continue
    // G1 rescue: a character over the crowd budget casts nothing, or into the first cascades only.
    const k = i.characterCascades?.get(root) ?? Infinity
    if (!(k > 0)) continue
    if (Vector3.DistanceSquared(cam, root.getAbsolutePosition()) > charM * charM) continue
    const from = out.length
    if (root.getTotalVertices() > 0 && !noCast(root)) out.push(root)
    // `metadata.sroNoCast`: a part that must not cast (hair cards and lashes: the shadow map draws their whole quads,
    // which printed hard rectangles on the face, CHARACTERS §16.3)
    for (const m of root.getChildMeshes(false)) if (m.isEnabled() && m.getTotalVertices() > 0 && !noCast(m)) out.push(m)
    if (i.limited && k < q.cascades) for (let n = from; n < out.length; n++) i.limited.set(out[n]!, k)
  }
  return out
}

const noCast = (m: AbstractMesh): boolean =>
  !!(m.metadata as { sroNoCast?: unknown } | null | undefined)?.sroNoCast || !!(m.material?.metadata as { sroNoCast?: unknown } | null | undefined)?.sroNoCast

/** The same meshes in the same order. */
const sameList = (a: readonly AbstractMesh[] | null | undefined, b: readonly AbstractMesh[]): boolean =>
  !!a && a.length === b.length && a.every((m, k) => m === b[k])

/**
 * The cascade filter of the `cascadeCulling` experiment: keep a caster whose bounding sphere overlaps the cascade's
 * light-space extents in x and y (z is left alone: depth clamp keeps casters in front of the cascade).
 */
export function inCascade(viewCenter: Vector3, radius: number, min: Vector3, max: Vector3): boolean {
  return viewCenter.x + radius >= min.x && viewCenter.x - radius <= max.x && viewCenter.y + radius >= min.y && viewCenter.y - radius <= max.y
}

/** The region id of a terrain mesh (terrain.ts `metadata.sroRegion`), or NaN. */
const regionOfTerrain = (m: AbstractMesh): number => {
  const id = (m.metadata as { sroRegion?: unknown } | null | undefined)?.sroRegion
  return typeof id === 'number' ? id : NaN
}

/** What WorldShadows needs from the world (World satisfies it). */
export interface ShadowHost {
  readonly objects: { addRegionListener(listener: RegionListener): () => void }
  readonly terrain: { readonly meshes: readonly AbstractMesh[] }
  readonly regions: { readonly regions: readonly RegionData[] }
  addCommitStep(name: string, run: (region: RegionData) => void, after: CommitStepAfter, debounceMs?: number): () => void
}

export interface WorldShadowsOptions {
  quality: Readonly<RenderQuality>
  /** The per-cascade caster filter (default on; false for the LAB A/B). */
  cascadeCulling?: boolean
  /** Characters cast within this distance (m; default CHARACTER_CASTER_M; Infinity for the LAB A/B). */
  characterM?: number
  /** The clock of the characters' periodic refresh (ms; default performance.now). */
  now?: () => number
}

/** RND-L's shadow part (WorldRender.shadows). */
export class WorldShadows implements RenderPart {
  readonly proxies: ShadowProxies
  generator: CascadedShadowGenerator | null = null
  settings: CsmSettings | null = null
  quality: Readonly<RenderQuality>
  cascadeCulling: boolean
  /** Characters cast within this distance (m). */
  characterM: number
  /** The casters of the last refresh. */
  casters: AbstractMesh[] = []
  private readonly characters = new Set<AbstractMesh>()
  /** G1 rescue: the crowd budget's cascade count per character root (absent: all; setCharacterCascades). */
  private readonly characterCascades = new Map<AbstractMesh, number>()
  /** The listed character meshes limited to their first k cascades (rebuilt at every refresh; the cascade filter reads it). */
  private limited = new Map<AbstractMesh, number>()
  /** W10-S: other caster sources (addCasterSource). */
  private readonly sources: ShadowCasterSource[] = []
  private readonly now: () => number
  private lastRefresh = -Infinity
  private readonly lastCam = new Vector3(NaN, NaN, NaN)
  /** PCSS: the casters' depth bounds around the eye (see pcssBounds). */
  private readonly pcssMin = new Vector3()
  private readonly pcssMax = new Vector3()
  private pcssInfo: BoundingInfo | null = null
  private seenVersion = -1
  private dirty = true
  private readonly offs: Array<() => void> = []
  private disposed = false

  constructor(readonly scene: Scene, readonly light: DirectionalLight, readonly host: ShadowHost, opts: WorldShadowsOptions) {
    this.quality = opts.quality
    this.cascadeCulling = opts.cascadeCulling ?? true
    this.characterM = opts.characterM ?? CHARACTER_CASTER_M
    this.now = opts.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()))
    this.proxies = new ShadowProxies(scene, () => host.regions.regions)
    this.proxies.props = !!opts.quality.shadows?.props
    this.proxies.terrain = !!opts.quality.shadows?.terrain
    // The listener replays what is placed already; the step queues every region already past its objects.
    this.offs.push(host.objects.addRegionListener(this.proxies))
    this.offs.push(host.addCommitStep('shadowProxy', region => {
      if (!this.disposed) this.proxies.build(region)
    }, 'objects', PROXY_DEBOUNCE_MS))
    this.applyQuality()
  }

  setQuality(q: Readonly<RenderQuality>): void {
    const props = !!q.shadows?.props
    const terrain = !!q.shadows?.terrain
    this.quality = q
    this.applyQuality()
    if (terrain !== this.proxies.terrain) {
      // BT-S: the skins come or go: every loaded region's proxy (a region without objects may have one).
      this.proxies.props = props
      this.proxies.terrain = terrain
      for (const r of this.host.regions.regions) this.proxies.build(r)
    } else if (props !== this.proxies.props) {
      this.proxies.props = props
      const ids = new Set(this.proxies.regionIds())
      for (const r of this.host.regions.regions) if (ids.has(r.region.id)) this.proxies.build(r)
    }
  }

  private applyQuality(): void {
    const q = this.quality.shadows
    const next = q ? csmSettings(q, { webgl: !this.scene.getEngine().isWebGPU }) : null
    const same = !!next && !!this.settings && next.mapSize === this.settings.mapSize && next.cascades === this.settings.cascades
    if (!same) {
      this.generator?.dispose()
      this.generator = null
      if (next && CascadedShadowGenerator.IsSupported) {
        this.generator = new CascadedShadowGenerator(next.mapSize, this.light)
        // The last casters until the next refresh (dirty below): a receiver checked before it keeps its SHADOWn.
        const map = this.generator.getShadowMap()
        if (map && this.casters.length) map.renderList = this.casters.slice()
      }
    }
    this.settings = next
    const g = this.generator
    if (g && next) {
      g.numCascades = next.cascades
      g.shadowMaxZ = next.maxZ
      g.lambda = next.lambda
      g.cascadeBlendPercentage = next.blend
      g.stabilizeCascades = true
      g.depthClamp = true
      g.autoCalcDepthBounds = false
      g.bias = 0.002
      g.normalBias = 0.02
      const pcss = next.soft > 0 && LIGHT_LOOK.softShadows
      // PCSS turns Babylon's depth clamp off, so the cascades' near plane comes from the casters' bounding info; ours
      // (merged proxies, thin instances) under-reported it and distant terrain casters were clipped: the shaded slopes
      // read sunlit. The bounds are a fixed box around the eye instead (pcssBounds).
      g.freezeShadowCastersBoundingInfo = pcss
      if (pcss) {
        // PCSS (docs/LIGHTING.md §4) keeps the comparison depth map: the grass root tap and the shafts read it as before.
        g.useContactHardeningShadow = true
        g.contactHardeningLightSizeUVRatio = next.soft
        // High: 16 blocker taps + 16 PCF taps (+1.3 ms GPU at 1080p on the dev GPU with 32); Ultra 16 + 32.
        g.filteringQuality = next.filter === 'high' ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW
      } else {
        g.usePercentageCloserFiltering = true
        g.filteringQuality = FILTER_QUALITY[next.filter]
      }
      this.installCascadeFilter()
    }
    this.dirty = true
  }

  /** Switches the per-cascade caster filter (on by default; off is the LAB A/B). */
  setCascadeCulling(on: boolean): void {
    this.cascadeCulling = on
    this.installCascadeFilter()
  }

  /** The characters' caster distance (m; Infinity is the LAB A/B); the list is rebuilt at the next update. */
  setCharacterRange(m: number): void {
    this.characterM = m
    this.dirty = true
  }

  /**
   * The per-cascade list (Babylon's `getCustomRenderList`): the cascade culling's extents test, and the crowd budget's
   * cascade limits (a character limited to k cascades is left out of cascade k and up). Without either, Babylon's own list.
   */
  private installCascadeFilter(): void {
    const g = this.generator
    const map = g?.getShadowMap()
    if (!g || !map) return
    if (!this.cascadeCulling && !this.limited.size) {
      map.getCustomRenderList = null
      return
    }
    const kept: AbstractMesh[] = []
    const tmp = new Vector3()
    map.getCustomRenderList = (layer, list, count) => {
      if (layer < 0 || layer >= g.numCascades || !list) return null
      const limited = this.limited
      const cull = this.cascadeCulling
      if (!cull && !limited.size) return null
      const view = cull ? g.getCascadeViewMatrix(layer) : null
      const min = cull ? g.getCascadeMinExtents(layer) : null
      const max = cull ? g.getCascadeMaxExtents(layer) : null
      if (cull && (!view || !min || !max)) return null
      kept.length = 0
      for (let i = 0; i < count; i++) {
        const m = list[i] as AbstractMesh
        if (limited.size) {
          const k = limited.get(m)
          if (k !== undefined && layer >= k) continue
        }
        if (view && min && max) {
          const s = m.getBoundingInfo().boundingSphere
          Vector3.TransformCoordinatesToRef(s.centerWorld, view, tmp)
          if (!inCascade(tmp, s.radiusWorld, min, max)) continue
        }
        kept.push(m)
      }
      return kept
    }
  }

  addCharacter(mesh: AbstractMesh): void {
    this.characters.add(mesh)
    mesh.receiveShadows = true
    for (const m of mesh.getChildMeshes(false)) m.receiveShadows = true
    this.dirty = true
  }

  removeCharacter(mesh: AbstractMesh): void {
    this.characterCascades.delete(mesh)
    if (this.characters.delete(mesh)) this.dirty = true
  }

  /**
   * G1 rescue (the crowd budget, apps/game world/crowd-budget.ts): how many cascades a character root casts into.
   * Infinity (the default) every cascade, 0 none, k ≥ 1 the first k (on High, the far ones of a crowd cast into cascade 0
   * only). A change rebuilds the list at the next update; the same value changes nothing.
   */
  setCharacterCascades(mesh: AbstractMesh, cascades: number): void {
    const k = cascades >= 0 ? Math.floor(cascades) : Infinity
    const had = this.characterCascades.get(mesh) ?? Infinity
    if (k === had) return
    if (k === Infinity) this.characterCascades.delete(mesh)
    else this.characterCascades.set(mesh, k)
    if (this.characters.has(mesh)) this.dirty = true
  }

  /** The cascade count set for a character root (Infinity: every cascade). */
  characterCascadesOf(mesh: AbstractMesh): number {
    return this.characterCascades.get(mesh) ?? Infinity
  }

  /**
   * W10-S (BATCHING §3.9, D8): adds a caster source (BT-S's cut-out casters, the terrain skin). Its casters join the
   * render list at every refresh; a `version` change triggers one. Returns a remover.
   */
  addCasterSource(source: ShadowCasterSource): () => void {
    this.sources.push(source)
    this.dirty = true
    return () => {
      const i = this.sources.indexOf(source)
      if (i >= 0) this.sources.splice(i, 1)
      this.dirty = true
    }
  }

  /** The proxies' version plus every caster source's (a change of any triggers a refresh). */
  private casterVersion(): number {
    let v = this.proxies.version
    for (const s of this.sources) v += s.version
    return v
  }

  update(camera: Camera | null): void {
    if (this.disposed || !camera || !this.settings) return
    const cam = camera.globalPosition
    if (this.generator?.useContactHardeningShadow) this.pcssBounds(this.generator, cam)
    // BT-S: the merged cut-out casters collapse group-3 pieces past their range from this eye.
    const objects = this.host.objects as { drawRangeScale?: number }
    this.proxies.setEye(cam, (GROUP_RANGE_M[3] ?? 48) * (objects.drawRangeScale ?? 1))
    const moved = !(Vector3.DistanceSquared(cam, this.lastCam) < CASTER_REFRESH_M * CASTER_REFRESH_M)
    const walked = this.characters.size > 0 && this.now() - this.lastRefresh >= CHARACTER_REFRESH_MS
    if (moved || walked || this.dirty || this.casterVersion() !== this.seenVersion) this.refreshCasters(cam)
  }

  /** PCSS: the casters' bounds = the shadow distance + 400 m around the eye, 300 m below to 800 m above it. */
  private pcssBounds(g: CascadedShadowGenerator, cam: Vector3): void {
    const r = (this.settings?.maxZ ?? 150) + 400
    this.pcssMin.set(cam.x - r, cam.y - 300, cam.z - r)
    this.pcssMax.set(cam.x + r, cam.y + 800, cam.z + r)
    if (!this.pcssInfo) this.pcssInfo = new BoundingInfo(this.pcssMin, this.pcssMax)
    else this.pcssInfo.reConstruct(this.pcssMin, this.pcssMax)
    g.shadowCastersBoundingInfo = this.pcssInfo
  }

  /** Rebuilds the render list around `cam` (RENDER §4.3 ShadowCasters.update). */
  refreshCasters(cam: Vector3): AbstractMesh[] {
    const q = this.quality.shadows
    this.lastCam.copyFrom(cam)
    this.lastRefresh = this.now()
    this.seenVersion = this.casterVersion()
    this.dirty = false
    for (const m of this.host.terrain.meshes) if (!m.receiveShadows) m.receiveShadows = true
    this.proxies.prune()
    // BT-S: the merged cut-out casters near the camera (one built per refresh; the next frame refreshes for the rest).
    if (this.proxies.updateCasters(cam, q?.foliageM ?? 0)) this.dirty = true
    // BT-S: a region whose proxy holds its terrain skin casts no full-resolution terrain.
    const terrain = this.proxies.terrain ? this.host.terrain.meshes.filter(m => !this.proxies.hasSkin(regionOfTerrain(m))) : this.host.terrain.meshes
    const limited = new Map<AbstractMesh, number>()
    const next = q
      ? selectCasters(cam, q, {
        proxies: this.proxies.allProxies(),
        cutouts: this.proxies.cutouts(),
        clones: this.proxies.clones(),
        terrain,
        characters: this.characters,
        characterM: this.characterM,
        characterCascades: this.characterCascades,
        limited,
      })
      : []
    // The cascade filter reads the limits live; without cascade culling it exists only while something is limited.
    const hadLimits = this.limited.size > 0
    this.limited = limited
    if (!this.cascadeCulling && hadLimits !== limited.size > 0) this.installCascadeFilter()
    if (q && this.sources.length) {
      const seen = new Set(next)
      for (const s of this.sources) {
        for (const m of s.casters(cam, q)) {
          if (m.isDisposed() || seen.has(m)) continue
          seen.add(m)
          next.push(m)
        }
      }
    }
    // The periodic refresh mostly finds the same list: keep it (and the shadow map's) then.
    if (!sameList(this.casters, next)) this.casters = next
    const map = this.generator?.getShadowMap()
    if (map && !sameList(map.renderList, this.casters)) {
      const had = (map.renderList?.length ?? 0) > 0
      map.renderList = this.casters.slice()
      // Babylon's SHADOWn follows `renderList.length > 0` only when the light defines are dirty (see the file comment).
      if (had !== this.casters.length > 0) this.light._markMeshesAsLightDirty()
    }
    return this.casters
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.offs.splice(0)) off()
    this.generator?.dispose()
    this.generator = null
    this.proxies.dispose()
    this.characters.clear()
    this.characterCascades.clear()
    this.limited = new Map()
    this.sources.length = 0
    this.casters = []
  }
}
