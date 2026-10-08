/**
 * The shelter (rain occlusion) map (docs/WAVE_PLAN3.md D20, docs/WEATHER.md §6.5): one top-down height map around the
 * camera that the rain, the splashes, the drips, the Classic wet chunks, the WetnessPlugin and the PBR plugins read
 * (`sroShelter(worldPos)`, weather/chunks.ts), so nothing falls or gets wet under a roof or a canopy.
 *
 * - 512² over 128 m (25 cm texels); R16F height **relative to the map centre** (world heights reach 354 m, where
 *   half floats step by 0.25 m); without half-float render targets RGBA8 with the 16-bit height in R and G.
 * - Terrain, objects (thin-instance chunks and skinned clones: Babylon's instance and bone includes) and water surfaces
 *   within the square, drawn with one height ShaderMaterial (`getCustomRenderList`, so the list is built at render
 *   time and never holds a disposed mesh). Characters and grass are not in it.
 * - Rendered on demand only: after the focus moved 8 m from the centre, when a region or its objects commit inside the
 *   square, and every 2 s while it rains; never while dry (rain 0 and wet 0). The centre snaps to 0.5 m.
 * - The world-XZ → texture mapping comes from the render camera's own matrices (`mapping`, the `wxOccM` uniform), so
 *   the lookup never depends on the camera's orientation or the scene's handedness.
 * - `topAt(x, z)` answers from a CPU copy read back after each render (async; 0.5 MB): the game's audio shelter test.
 */
import {
  Camera,
  Color4,
  Constants,
  FreeCamera,
  Matrix,
  RenderTargetTexture,
  ShaderLanguage,
  ShaderMaterial,
  ShaderStore,
  Texture,
  Vector3,
  Vector4,
  type AbstractMesh,
  type BaseTexture,
  type Scene,
} from '@babylonjs/core'
import { FOLIAGE_PIVOT_KIND, TREE_BAND_SAMPLER, TREE_BAND_TEX_W, TREE_PIVOT_FLOATS } from '../pbr/foliage-plugin.ts'
import { addWarmupHook } from '../warmup-hooks.ts'
import '@babylonjs/core/ShadersWGSL/ShadersInclude/instancesDeclaration.js'
import '@babylonjs/core/ShadersWGSL/ShadersInclude/instancesVertex.js'
import '@babylonjs/core/ShadersWGSL/ShadersInclude/bonesDeclaration.js'
import '@babylonjs/core/ShadersWGSL/ShadersInclude/bonesVertex.js'
import '@babylonjs/core/Shaders/ShadersInclude/instancesDeclaration.js'
import '@babylonjs/core/Shaders/ShadersInclude/instancesVertex.js'
import '@babylonjs/core/Shaders/ShadersInclude/bonesDeclaration.js'
import '@babylonjs/core/Shaders/ShadersInclude/bonesVertex.js'
import type { ShelterMap } from './index.ts'

export const SHELTER_SIZE_M = 128
export const SHELTER_RESOLUTION = 512
/** Re-render after the focus moved this far from the map centre (m). */
export const SHELTER_MOVE_M = 8
/** Re-render this often while it rains (ms). */
export const SHELTER_RAIN_REFRESH_MS = 2000
/** The render camera sits this far above the centre (the map covers ±this much height). */
const CAM_HEIGHT = 300
/** Clear value (R16F): "no cover". RGBA8 clears to 0, i.e. −64 m. */
const NONE = -10000

const HEIGHT_VS_WGSL = /* wgsl */ `
#include<bonesDeclaration>
#include<instancesDeclaration>
attribute position: vec3f;
uniform viewProjection: mat4x4f;
uniform shParams: vec4f;
varying vY: f32;
#ifdef SH_BAND
attribute ${FOLIAGE_PIVOT_KIND}: vec4f;
var ${TREE_BAND_SAMPLER}: texture_2d<f32>;
var ${TREE_BAND_SAMPLER}Sampler: sampler;
#endif

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
#include<instancesVertex>
#include<bonesVertex>
  var wp = finalWorld * vec4f(vertexInputs.position, 1.0);
#ifdef SH_BAND
  {
    let shBw = u32(round(vertexInputs.${FOLIAGE_PIVOT_KIND}.w));
    let shTier = shBw & 3u;
    if (shTier != 0u) {
      let shSlot = i32(shBw >> 2u);
      let shBand = u32(round(textureLoad(${TREE_BAND_SAMPLER}, vec2i(shSlot % ${TREE_BAND_TEX_W}, shSlot / ${TREE_BAND_TEX_W}), 0).r * 255.0));
      if (shBand != shTier) { wp = finalWorld * vec4f(vertexInputs.${FOLIAGE_PIVOT_KIND}.xyz, 1.0); }
    }
  }
#endif
  vertexOutputs.position = uniforms.viewProjection * wp;
  vertexOutputs.vY = wp.y - uniforms.shParams.x;
}
`
const HEIGHT_FS_WGSL = /* wgsl */ `
varying vY: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
#ifdef WX_OCC8
  let v = floor(clamp((fragmentInputs.vY + 64.0) / 128.0, 0.0, 1.0) * 65535.0 + 0.5);
  let hi = floor(v / 256.0);
  fragmentOutputs.color = vec4f(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
#else
  fragmentOutputs.color = vec4f(fragmentInputs.vY, 0.0, 0.0, 1.0);
#endif
}
`
const HEIGHT_VS_GLSL = /* glsl */ `
precision highp float;
#include<bonesDeclaration>
#include<instancesDeclaration>
attribute vec3 position;
uniform mat4 viewProjection;
uniform vec4 shParams;
varying float vY;
#ifdef SH_BAND
attribute vec4 ${FOLIAGE_PIVOT_KIND};
uniform highp sampler2D ${TREE_BAND_SAMPLER};
#endif

void main(void) {
#include<instancesVertex>
#include<bonesVertex>
  vec4 wp = finalWorld * vec4(position, 1.0);
#ifdef SH_BAND
  {
    int shBw = int(${FOLIAGE_PIVOT_KIND}.w + 0.5);
    int shTier = shBw & 3;
    if (shTier != 0) {
      int shSlot = shBw >> 2;
      int shBand = int(texelFetch(${TREE_BAND_SAMPLER}, ivec2(shSlot % ${TREE_BAND_TEX_W}, shSlot / ${TREE_BAND_TEX_W}), 0).r * 255.0 + 0.5);
      if (shBand != shTier) wp = finalWorld * vec4(${FOLIAGE_PIVOT_KIND}.xyz, 1.0);
    }
  }
#endif
  gl_Position = viewProjection * wp;
  vY = wp.y - shParams.x;
}
`
const HEIGHT_FS_GLSL = /* glsl */ `
precision highp float;
varying float vY;

void main(void) {
#ifdef WX_OCC8
  float v = floor(clamp((vY + 64.0) / 128.0, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(v / 256.0);
  gl_FragColor = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
#else
  gl_FragColor = vec4(vY, 0.0, 0.0, 1.0);
#endif
}
`

let registered = false
function registerShaders(): void {
  if (registered) return
  registered = true
  ShaderStore.ShadersStoreWGSL['sroShelterHeightVertexShader'] = HEIGHT_VS_WGSL
  ShaderStore.ShadersStoreWGSL['sroShelterHeightFragmentShader'] = HEIGHT_FS_WGSL
  ShaderStore.ShadersStore['sroShelterHeightVertexShader'] = HEIGHT_VS_GLSL
  ShaderStore.ShadersStore['sroShelterHeightFragmentShader'] = HEIGHT_FS_GLSL
}

/** The shader sources (tests: both languages exist and declare the same names). */
export const SHELTER_SHADERS = { vertexWGSL: HEIGHT_VS_WGSL, fragmentWGSL: HEIGHT_FS_WGSL, vertexGLSL: HEIGHT_VS_GLSL, fragmentGLSL: HEIGHT_FS_GLSL }

/** Where the map may draw from: every candidate mesh (filtered to the square at render time). */
export type ShelterCandidates = () => Iterable<AbstractMesh>

/**
 * The region batch's merged tree groups (BT-T / T12-W: the 4-float `sroPivot`, root xyz + band slot × 4 + tier) hold
 * every tier of a swapped tree (LOD1 and LOD2); the foliage plugin's band collapse (SRO_FOL_BAND) moves the tiers a
 * tree's band does not show to its root in the vertex stage. The height pass must do the same (SH_BAND, with the
 * world's band texture), or the hidden tiers of every tree in the region draw a solid roof ~40 m up over the whole
 * town (the Jangan plaza never got wet: PLAZA-RAIN).
 */
export function isBandedTreeMesh(m: AbstractMesh): boolean {
  return m.getVertexBuffer?.(FOLIAGE_PIVOT_KIND)?.getSize() === TREE_PIVOT_FLOATS
}

/** The world-xz → shelter-uv mapping (the chunks' `wxOccUv`), for the CPU side. */
export function shelterUv(m: Readonly<Vector4>, cx: number, cz: number, x: number, z: number): [number, number] {
  const dx = x - cx
  const dz = z - cz
  return [(m.x * dx + m.y * dz) * 0.5 + 0.5, (m.z * dx + m.w * dz) * 0.5 + 0.5]
}

interface CpuCopy {
  data: ArrayBufferView
  channels: number
  cx: number
  cy: number
  cz: number
  mapping: Vector4
}

export class WeatherShelter implements ShelterMap {
  readonly texture: RenderTargetTexture
  readonly sizeM = SHELTER_SIZE_M
  readonly resolution: number
  /** RGBA8 with the height in R and G (no half-float render targets). */
  readonly packed: boolean
  /** The centre of the map the texture holds now (the uniforms follow it after each render). */
  centerX = 0
  centerY = 0
  centerZ = 0
  /** World xz − centre → clip xy of the map the texture holds (the `wxOccM` uniform). */
  readonly mapping = new Vector4(2 / SHELTER_SIZE_M, 0, 0, 2 / SHELTER_SIZE_M)
  /** True once a render finished. */
  valid = false
  /** Renders so far (the tests: none while dry). */
  renders = 0
  /** Called after each render with the map now in the texture (weather/index.ts pushes the uniforms). */
  onRendered: (() => void) | null = null
  private readonly camera: FreeCamera
  private readonly material: ShaderMaterial
  private readonly params = new Vector4(0, 0, 0, 0)
  private readonly pending = { x: 0, y: 0, z: 0, mapping: new Vector4() }
  private requested = false
  private added = false
  private dirty = true
  private lastRenderMs = -Infinity
  private readbackWanted = false
  private cpu: CpuCopy | null = null
  private notReady = 0
  private disposed = false
  private readonly list: AbstractMesh[] = []
  private readonly treeList: AbstractMesh[] = []
  /** SH_BAND (PLAZA-RAIN): the height material of the banded tree groups, made when a band texture first exists. */
  private treeMaterial: ShaderMaterial | null = null
  private readonly treeBand: () => BaseTexture | null
  private readonly offWarmup: () => void

  constructor(
    readonly scene: Scene,
    private readonly candidates: ShelterCandidates,
    opts: { resolution?: number; treeBand?: () => BaseTexture | null } = {},
  ) {
    this.treeBand = opts.treeBand ?? (() => null)
    registerShaders()
    const engine = scene.getEngine()
    this.resolution = opts.resolution ?? SHELTER_RESOLUTION
    this.packed = !engine.isWebGPU && !engine.getCaps().textureHalfFloatRender
    this.texture = new RenderTargetTexture('wxShelter', this.resolution, scene, {
      generateMipMaps: false,
      type: this.packed ? Constants.TEXTURETYPE_UNSIGNED_BYTE : Constants.TEXTURETYPE_HALF_FLOAT,
      format: this.packed ? Constants.TEXTUREFORMAT_RGBA : Constants.TEXTUREFORMAT_R,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
      generateDepthBuffer: true,
      generateStencilBuffer: false,
    })
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE
    this.texture.clearColor = this.packed ? new Color4(0, 0, 0, 0) : new Color4(NONE, 0, 0, 1)
    this.texture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
    // Never through the prepass renderer (a height map, one ShaderMaterial): Babylon gives every other render target
    // its own prepass MRT, and when the prepass is dirty (the post stack was just rebuilt: the modern graphics turned
    // on, a preset change) the first target drawn re-reads its state with the scene camera set to ours. Ours has no
    // post-processes, so the prepass turned itself off and SSR bound textures at index -1: a TypeError that stopped
    // the render loop on High and Ultra whenever it rained (render/post.ts settles the prepass first as well).
    this.texture.noPrePassRenderer = true
    this.texture.renderList = []
    this.texture.renderParticles = false
    this.texture.renderSprites = false

    // Not the scene's camera (setActiveOnSceneIfNoneActive = false); explicit ortho bounds, so no aspect enters.
    const cam = new FreeCamera('wxShelterCam', new Vector3(0, CAM_HEIGHT, 0), scene, false)
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA
    const h = SHELTER_SIZE_M / 2
    cam.orthoLeft = -h
    cam.orthoRight = h
    cam.orthoTop = h
    cam.orthoBottom = -h
    cam.minZ = 1
    cam.maxZ = CAM_HEIGHT * 2
    this.camera = cam
    this.texture.activeCamera = cam

    this.material = new ShaderMaterial('wxShelterHeight', scene, 'sroShelterHeight', {
      attributes: ['position'],
      uniforms: ['world', 'viewProjection', 'shParams'],
      defines: this.packed ? ['#define WX_OCC8'] : [],
      shaderLanguage: engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    this.material.backFaceCulling = false
    this.material.setVector4('shParams', this.params)

    this.texture.getCustomRenderList = () => {
      this.list.length = 0
      this.treeList.length = 0
      const cx = this.pending.x, cz = this.pending.z
      const r = SHELTER_SIZE_M / 2
      const tree = this.treeHeightMaterial()
      for (const m of this.candidates()) {
        if (m.isDisposed() || !m.isEnabled() || !m.isVisible || !m.getTotalVertices()) continue
        const bb = m.getBoundingInfo().boundingBox
        if (bb.maximumWorld.x < cx - r || bb.minimumWorld.x > cx + r || bb.maximumWorld.z < cz - r || bb.minimumWorld.z > cz + r) continue
        this.list.push(m)
        if (tree && isBandedTreeMesh(m)) this.treeList.push(m)
      }
      this.texture.setMaterialForRendering(this.list, this.material)
      if (tree && this.treeList.length) this.texture.setMaterialForRendering(this.treeList, tree)
      return this.list
    }
    // A mesh whose height effect is still compiling makes Babylon retry the render next frame; after 30 tries it draws
    // what is ready rather than re-rendering every frame.
    this.texture.customIsReadyFunction = (mesh, refreshRate) => {
      const ready = mesh.isReady(refreshRate === 0)
      if (!ready) this.notReady++
      return ready || this.notReady > 30
    }
    this.texture.onAfterRenderObservable.add(() => this.afterRender())
    this.offWarmup = addWarmupHook(scene, () => this.warm())
  }

  /**
   * W9F R1: asks the height material for one mesh of each kind among the candidates (plain, instanced, thin-instanced,
   * skinned, morphed), so the game's warm-up compiles its variants while it is dry and the first rain compiles
   * nothing in play. True once every variant is ready.
   */
  warm(): boolean {
    if (this.disposed) return true
    let ready = true
    const seen = new Set<string>()
    for (const m of this.candidates()) {
      if (m.isDisposed() || !m.getTotalVertices()) continue
      const inst = !!(m as { hasInstances?: boolean }).hasInstances
      const key = `${inst ? 'i' : ''}${m.hasThinInstances ? 't' : ''}${m.skeleton ? 's' : ''}${m.morphTargetManager ? 'm' : ''}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!this.material.isReady(m, inst || m.hasThinInstances)) ready = false
    }
    // PLAZA-RAIN: the banded tree groups' SH_BAND variant (once the band texture exists).
    const tree = this.treeHeightMaterial()
    if (tree) {
      for (const m of this.candidates()) {
        if (m.isDisposed() || !m.getTotalVertices() || !isBandedTreeMesh(m)) continue
        if (!tree.isReady(m, false)) ready = false
        break
      }
    }
    return ready
  }

  /**
   * The SH_BAND height material, bound to the world's current band texture (null while there is none: the tree groups
   * then show every tier in the world too, and the plain material draws what they draw).
   */
  private treeHeightMaterial(): ShaderMaterial | null {
    const band = this.treeBand()
    if (!band) return null
    if (!this.treeMaterial) {
      const engine = this.scene.getEngine()
      this.treeMaterial = new ShaderMaterial('wxShelterHeightTree', this.scene, 'sroShelterHeight', {
        attributes: ['position', FOLIAGE_PIVOT_KIND],
        uniforms: ['world', 'viewProjection', 'shParams'],
        samplers: [TREE_BAND_SAMPLER],
        defines: ['#define SH_BAND', ...(this.packed ? ['#define WX_OCC8'] : [])],
        shaderLanguage: engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      })
      this.treeMaterial.backFaceCulling = false
      this.treeMaterial.setVector4('shParams', this.params)
    }
    this.treeMaterial.setTexture(TREE_BAND_SAMPLER, band)
    return this.treeMaterial
  }

  /** The map texture as the plugins read it. */
  get shelterTexture(): { texture: RenderTargetTexture; packed: boolean } {
    return { texture: this.texture, packed: this.packed }
  }

  /** Something inside the square changed (a region or its objects committed): re-render at the next chance. */
  markDirty(x?: number, z?: number, radius = 0): void {
    if (x !== undefined && z !== undefined && this.valid) {
      const r = SHELTER_SIZE_M / 2 + radius
      if (Math.abs(x - this.centerX) > r || Math.abs(z - this.centerZ) > r) return
    }
    this.dirty = true
  }

  /**
   * Per frame: re-renders when needed (moved 8 m, dirty, every 2 s in rain), never while dry. `focus` is the map's
   * centre-to-be (the camera). Also starts the CPU readback of the last render.
   */
  update(focus: { x: number; y: number; z: number }, rain: number, wet: number, nowMs: number): void {
    if (this.disposed) return
    if (this.readbackWanted) this.readback()
    if (!(rain > 0) && !(wet > 0)) return
    if (this.requested) return
    const moved = Math.hypot(focus.x - this.centerX, focus.z - this.centerZ) > SHELTER_MOVE_M
    const due = rain > 0 && nowMs - this.lastRenderMs >= SHELTER_RAIN_REFRESH_MS
    if (!this.valid || moved || this.dirty || due) this.request(focus)
  }

  private request(focus: { x: number; y: number; z: number }): void {
    const p = this.pending
    p.x = Math.round(focus.x * 2) / 2
    p.z = Math.round(focus.z * 2) / 2
    p.y = Math.round(focus.y)
    const cam = this.camera
    cam.position.set(p.x, p.y + CAM_HEIGHT, p.z)
    cam.setTarget(new Vector3(p.x, p.y, p.z - 1e-4))
    const vp = cam.getViewMatrix(true).multiply(cam.getProjectionMatrix(true))
    mappingFrom(vp, p.x, p.y, p.z, p.mapping)
    this.params.x = p.y
    this.dirty = false
    this.requested = true
    this.notReady = 0
    if (!this.added) {
      // First request: joining the scene's targets renders it once (REFRESHRATE_RENDER_ONCE); never before.
      this.scene.customRenderTargets.push(this.texture)
      this.added = true
    } else this.texture.resetRefreshCounter()
  }

  private afterRender(): void {
    if (this.disposed || !this.requested) return
    const p = this.pending
    this.centerX = p.x
    this.centerY = p.y
    this.centerZ = p.z
    this.mapping.copyFrom(p.mapping)
    this.requested = false
    this.valid = true
    this.renders++
    this.lastRenderMs = performance.now()
    this.readbackWanted = true
    this.onRendered?.()
  }

  /** Starts the async CPU copy of the map (outside the render; the next update). */
  private readback(): void {
    this.readbackWanted = false
    const snap = { cx: this.centerX, cy: this.centerY, cz: this.centerZ, mapping: this.mapping.clone() }
    let p: Promise<ArrayBufferView> | null = null
    try {
      p = this.texture.readPixels(0, 0, null, true, false)
    } catch {
      p = null
    }
    if (!p) return
    p.then(data => {
      if (this.disposed || !data) return
      const texels = this.resolution * this.resolution
      const length = (data as ArrayBufferView & { length?: number }).length ?? 0
      const channels = Math.max(1, Math.round(length / texels))
      this.cpu = { data, channels, ...snap }
    }).catch(() => {})
  }

  /** The top of the cover above (x, z) in world metres from the last CPU copy, or null (none / not read yet). */
  topAt(x: number, z: number): number | null {
    const c = this.cpu
    if (!c) return null
    const [u, v] = shelterUv(c.mapping, c.cx, c.cz, x, z)
    if (!(u > 0 && u < 1 && v > 0 && v < 1)) return null
    const n = this.resolution
    const col = Math.min(n - 1, Math.floor(u * n))
    const row = Math.min(n - 1, Math.floor(v * n))
    const i = (row * n + col) * c.channels
    const d = c.data as unknown as ArrayLike<number>
    let rel: number
    if (this.packed) {
      // RGBA8 bytes (or 0..1 floats on an engine that converts).
      const scale = d instanceof Uint8Array ? 1 : 255
      const v16 = Math.round(d[i]! * scale) * 256 + Math.round(d[i + 1]! * scale)
      rel = (v16 / 65535) * 128 - 64
      if (rel <= -63.9) return null
    } else {
      rel = d[i]!
      if (!(rel > NONE / 2)) return null
    }
    return rel + c.cy
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offWarmup()
    const i = this.scene.customRenderTargets.indexOf(this.texture)
    if (i >= 0) this.scene.customRenderTargets.splice(i, 1)
    this.texture.getCustomRenderList = null
    this.texture.dispose()
    this.material.dispose()
    this.treeMaterial?.dispose()
    this.treeMaterial = null
    this.camera.dispose()
    this.cpu = null
    this.onRendered = null
    this.list.length = 0
    this.treeList.length = 0
  }
}

const tmpA = new Vector3()
const tmpB = new Vector3()

/** The 2 × 2 map from (x − cx, z − cz) to clip xy through a view-projection (an ortho top-down camera). */
export function mappingFrom(vp: Matrix, cx: number, cy: number, cz: number, out: Vector4): Vector4 {
  const o = Vector3.TransformCoordinatesFromFloatsToRef(cx, cy, cz, vp, tmpA)
  const ox = o.x, oy = o.y
  const ex = Vector3.TransformCoordinatesFromFloatsToRef(cx + 1, cy, cz, vp, tmpB)
  const a = ex.x - ox, c = ex.y - oy
  const ez = Vector3.TransformCoordinatesFromFloatsToRef(cx, cy, cz + 1, vp, tmpB)
  const b = ez.x - ox, d = ez.y - oy
  return out.set(a, b, c, d)
}
