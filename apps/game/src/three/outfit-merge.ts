/**
 * The outfit merge (docs/CHARACTERS.md §3.3, P0): a far character's skinned parts, body, hair and every worn armour
 * piece, drawn as ONE mesh with ONE material whose albedo is an atlas of the parts' own textures (outfit-atlas.ts packs
 * it). Six to nine draws (and as many shadow draws) become one; weapons and shields stay on their sockets as they are.
 *
 * - **Who** (world/crowd-budget.ts): other characters beyond CLOSE_M in a crowd, never the own character, the target,
 *   the hovered one or a party member. Nothing within CLOSE_M changes, so up close every character is drawn as before.
 * - **The atlas** is built on the GPU (a copy pass per texture into a render target, with mips), so it works with any
 *   texture the parts use (retail PNG/WebP, the remaster's compressed KTX2). The copy writes the texel colour as stored
 *   (sRGB-buffer textures are encoded back), forces alpha 1 for opaque parts (their alpha is not coverage), and repeats
 *   the edge texels into ATLAS_PAD.
 * - **The material** is a glTF-like PBRMaterial (metallic 0, roughness 1) decorated by the library's decorators (the
 *   PBR path's character surface, the lights), alpha-tested at the body's cut-off, two-sided when any part is.
 * - **Shared**: characters with the same parts (texture ids and cut-out flags) share the atlas and the material. An
 *   atlas no one uses for EVICT_MS is freed; at most MAX_ATLASES live at once (no merge beyond it).
 */
import {
  Color4,
  Constants,
  EffectRenderer,
  EffectWrapper,
  Mesh,
  PBRMaterial,
  RenderTargetTexture,
  ShaderLanguage,
  ShaderStore,
  VertexBuffer,
  VertexData,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type Scene,
  type Skeleton,
} from '@babylonjs/core'
import { ATLAS_PAD, atlasKey, atlasSizeOf, packAtlas, remapUV, uvFits, type AtlasPlan } from './outfit-atlas.ts'

/** The atlas size (texels): a far character is at most ≈ 150 px tall on a 1080p screen. */
export const ATLAS_SIZE = 512
/** Atlases alive at once at most (≈ 1.4 MB each with mips). */
export const MAX_ATLASES = 160
/** An atlas no character uses for this long is freed (ms). */
export const EVICT_MS = 30_000

const SHADER = 'sroOutfitAtlas'

const GLSL = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D src;
uniform vec4 rect;
uniform vec4 padRect;
uniform vec4 flags;
uniform mat4 texMatrix;
void main(void) {
  // the atlas texel from the fragment's own position: row 0 is the texture's first row on both backends
  // (vUV's y runs the other way on WebGPU render targets)
  vec2 p = gl_FragCoord.xy / flags.z;
  if (p.x < padRect.x || p.y < padRect.y || p.x > padRect.x + padRect.z || p.y > padRect.y + padRect.w) discard;
  vec2 uv = clamp((p - rect.xy) / rect.zw, vec2(0.0), vec2(1.0));
  uv = (texMatrix * vec4(uv, 1.0, 0.0)).xy;
  vec4 c = texture2D(src, uv);
  vec3 rgb = flags.y > 0.5 ? pow(max(c.rgb, vec3(0.0)), vec3(1.0 / 2.2)) : c.rgb;
  gl_FragColor = vec4(rgb, flags.x > 0.5 ? 1.0 : c.a);
}
`

const WGSL = /* wgsl */ `
varying vUV: vec2f;
var srcSampler: sampler;
var src: texture_2d<f32>;
uniform rect: vec4f;
uniform padRect: vec4f;
uniform flags: vec4f;
uniform texMatrix: mat4x4f;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let p = fragmentInputs.position.xy / uniforms.flags.z;
  let pr = uniforms.padRect;
  if (p.x < pr.x || p.y < pr.y || p.x > pr.x + pr.z || p.y > pr.y + pr.w) {
    discard;
  }
  var uv = clamp((p - uniforms.rect.xy) / uniforms.rect.zw, vec2f(0.0), vec2f(1.0));
  uv = (uniforms.texMatrix * vec4f(uv, 1.0, 0.0)).xy;
  let c = textureSample(src, srcSampler, uv);
  var rgb = c.rgb;
  if (uniforms.flags.y > 0.5) {
    rgb = pow(max(c.rgb, vec3f(0.0)), vec3f(1.0 / 2.2));
  }
  var a = c.a;
  if (uniforms.flags.x > 0.5) {
    a = 1.0;
  }
  fragmentOutputs.color = vec4f(rgb, a);
}
`

/** One part of a character the merge can take: its mesh and what its material draws with. */
export interface OutfitPart {
  mesh: Mesh
  texture: BaseTexture
  /** Alpha-tested (its alpha is coverage); else opaque (alpha forced to 1). */
  cutout: boolean
  cutoff: number
  doubleSided: boolean
}

interface Atlas {
  key: string
  texture: RenderTargetTexture
  material: PBRMaterial
  plan: AtlasPlan
  /** Unique texture id → rect index. */
  slot: Map<number, number>
  users: number
  idleSince: number
}

/**
 * The part a material draws as an atlas source: a glTF PBRMaterial with an albedo texture, opaque or alpha-tested
 * (blended parts stay apart), no texture coordinate other than the first. null when it cannot be merged. `skeleton`
 * null: a rigid part (the crowd tier's weapons and shields), which must have no skeleton.
 */
export function outfitPartOf(mesh: AbstractMesh, skeleton: Skeleton | null): OutfitPart | null {
  if (!(mesh instanceof Mesh) || mesh.isDisposed() || mesh.skeleton !== skeleton || mesh.getTotalVertices() <= 0) return null
  if (mesh.subMeshes?.length !== 1 || mesh.morphTargetManager || mesh.hasThinInstances || mesh.instances.length) return null
  if (mesh.numBoneInfluencers > 4 || mesh.isVerticesDataPresent(VertexBuffer.MatricesIndicesExtraKind)) return null
  const mat = mesh.material
  if (!(mat instanceof PBRMaterial) || !mat.albedoTexture || mat.needAlphaBlending()) return null
  // §16.9: a licensed cloth palette material's albedo is a shade map its plugin colours: never copied into an atlas
  if ((mat.metadata as { sroNoAtlas?: boolean } | null)?.sroNoAtlas) return null
  const tex = mat.albedoTexture
  if (tex.coordinatesIndex !== 0 || !tex.isReady()) return null
  if (!mesh.isVerticesDataPresent(VertexBuffer.UVKind) || !mesh.isVerticesDataPresent(VertexBuffer.NormalKind)) return null
  return { mesh, texture: tex, cutout: mat.needAlphaTesting(), cutoff: mat.alphaCutOff, doubleSided: !mat.backFaceCulling }
}

/** The atlases and materials of the outfit merge in one scene (ModelLibrary owns one). */
export class OutfitAtlases {
  private readonly atlases = new Map<string, Atlas>()
  private renderer: EffectRenderer | null = null
  private wrapper: EffectWrapper | null = null
  /** Atlases built so far, and atlases handed out (one per outfit merge made; tests, the bench). */
  built = 0
  acquired = 0

  constructor(
    private readonly scene: Scene,
    private readonly decorate: (mat: Material) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get size(): number {
    return this.atlases.size
  }

  /** The copy pass is compiled (the first merge waits for it: a merge is never drawn from an unfinished atlas). */
  ready(): boolean {
    const engine = this.scene.getEngine()
    if (!this.wrapper) {
      ShaderStore.ShadersStore[`${SHADER}FragmentShader`] = GLSL
      ShaderStore.ShadersStoreWGSL[`${SHADER}FragmentShader`] = WGSL
      this.renderer = new EffectRenderer(engine)
      this.wrapper = new EffectWrapper({
        engine,
        name: SHADER,
        fragmentShader: SHADER,
        useShaderStore: true,
        uniformNames: ['rect', 'padRect', 'flags', 'texMatrix'],
        samplerNames: ['src'],
        shaderLanguage: engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      })
    }
    return this.wrapper.effect?.isReady() ?? false
  }

  /** The atlas for `parts` (built now when new); null when it cannot be made yet (shader compiling, at the cap). */
  acquire(parts: readonly OutfitPart[]): Atlas | null {
    const textures: BaseTexture[] = []
    const seen = new Map<number, number>()
    for (const p of parts) {
      if (!seen.has(p.texture.uniqueId)) {
        seen.set(p.texture.uniqueId, textures.length)
        textures.push(p.texture)
      }
    }
    // A texture drawn cut out by one part and opaque by another is copied cut out (the alpha of an opaque part is
    // forced to 1 by its own copy only when no part needs the coverage).
    const cut = textures.map(t => parts.some(p => p.texture === t && p.cutout))
    const key = atlasKey(textures.map((t, i) => ({ texture: t.uniqueId, cutout: cut[i]! })))
    const had = this.atlases.get(key)
    if (had) {
      had.users++
      this.acquired++
      return had
    }
    if (this.atlases.size >= MAX_ATLASES) this.evict(true)
    if (this.atlases.size >= MAX_ATLASES || !this.ready()) return null
    const plan = packAtlas(textures.map(atlasSizeOf), ATLAS_SIZE)
    if (!plan) return null
    const engine = this.scene.getEngine()
    const rtt = new RenderTargetTexture(`outfitAtlas${this.built}`, { width: ATLAS_SIZE, height: ATLAS_SIZE }, this.scene, {
      generateMipMaps: true,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      format: Constants.TEXTUREFORMAT_RGBA,
      samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
      generateDepthBuffer: false,
      noColorAttachment: false,
    })
    rtt.gammaSpace = true
    rtt.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE
    rtt.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE
    rtt.anisotropicFilteringLevel = 1
    // transparent black where no texture lands (the mips average into the padding only)
    engine.bindFramebuffer(rtt.renderTarget!)
    engine.clear(new Color4(0, 0, 0, 0), true, false, false)
    engine.unBindFramebuffer(rtt.renderTarget!)
    this.copyInto(rtt, ATLAS_SIZE, textures, plan.rects, cut)
    const first = parts.find(p => p.cutout) ?? parts[0]!
    const mat = new PBRMaterial(`outfitAtlas${this.built}`, this.scene)
    mat.albedoTexture = rtt
    mat.metallic = 0
    mat.roughness = 1
    mat.backFaceCulling = !parts.some(p => p.doubleSided)
    mat.twoSidedLighting = !mat.backFaceCulling
    if (cut.some(c => c)) {
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      mat.alphaCutOff = first.cutoff
      rtt.hasAlpha = true
    } else mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE
    this.decorate(mat)
    this.built++
    const atlas: Atlas = { key, texture: rtt, material: mat, plan, slot: seen, users: 1, idleSince: 0 }
    this.atlases.set(key, atlas)
    this.acquired++
    return atlas
  }

  /**
   * Copies `textures` into `rtt` (a `size`² target; the copy pass must be ready): texture i into rects[i] (texels,
   * the padding around it repeating its edge), alpha kept where `cut[i]`, else forced to 1. Only the padded rects
   * are written (the crowd tier's atlas pages fill one slot at a time).
   */
  copyInto(rtt: RenderTargetTexture, size: number, textures: readonly BaseTexture[], rects: readonly { x: number; y: number; w: number; h: number }[], cut: readonly boolean[]): void {
    const S = size
    const wrapper = this.wrapper!
    const renderer = this.renderer!
    textures.forEach((t, i) => {
      const r = rects[i]!
      const srgb = !!(t.getInternalTexture() as unknown as { _useSRGBBuffer?: boolean } | null)?._useSRGBBuffer
      const obs = wrapper.onApplyObservable.add(() => {
        const e = wrapper.effect
        e.setTexture('src', t)
        e.setFloat4('rect', r.x / S, r.y / S, r.w / S, r.h / S)
        e.setFloat4('padRect', (r.x - ATLAS_PAD) / S, (r.y - ATLAS_PAD) / S, (r.w + 2 * ATLAS_PAD) / S, (r.h + 2 * ATLAS_PAD) / S)
        e.setFloat4('flags', cut[i] ? 0 : 1, srgb ? 1 : 0, S, 0)
        e.setMatrix('texMatrix', t.getTextureMatrix())
      })
      renderer.render(wrapper, rtt)
      wrapper.onApplyObservable.remove(obs)
    })
  }

  release(atlas: Atlas): void {
    if (--atlas.users <= 0) {
      atlas.users = 0
      atlas.idleSince = this.now()
    }
    this.evict(false)
  }

  /** Frees the atlases nobody used for EVICT_MS (`all`: every unused one now). */
  evict(all: boolean): void {
    const now = this.now()
    for (const [k, a] of this.atlases) {
      if (a.users > 0 || (!all && now - a.idleSince < EVICT_MS)) continue
      a.material.dispose(false, false)
      a.texture.dispose()
      this.atlases.delete(k)
    }
  }

  dispose(): void {
    for (const a of this.atlases.values()) {
      a.material.dispose(false, false)
      a.texture.dispose()
    }
    this.atlases.clear()
    this.wrapper?.dispose()
    this.renderer?.dispose()
    this.wrapper = null
    this.renderer = null
  }
}

export type OutfitAtlas = NonNullable<ReturnType<OutfitAtlases['acquire']>>

/**
 * One skinned mesh of `parts` drawing from `atlas`: positions, normals, the UVs mapped into each part's atlas rect,
 * the bone indices and weights; the parts' own transform (they must share it, as glb parts of one character do: a
 * part whose world matrix differs is left out, `taken` says which went in). null when fewer than two parts fit.
 */
export function buildOutfitMesh(parts: readonly OutfitPart[], atlas: OutfitAtlas, name: string): { mesh: Mesh; taken: OutfitPart[] } | null {
  const first = parts[0]
  if (!first) return null
  const scene = first.mesh.getScene()
  const w0 = first.mesh.computeWorldMatrix(true).m
  const taken: OutfitPart[] = []
  for (const p of parts) {
    const w = p.mesh.computeWorldMatrix(true).m
    let same = true
    for (let i = 0; i < 16; i++) if (Math.abs(w[i]! - w0[i]!) > 1e-4) same = false
    const uv = p.mesh.getVerticesData(VertexBuffer.UVKind)
    if (same && uv && uvFits(uv)) taken.push(p)
  }
  if (taken.length < 2) return null
  let verts = 0
  for (const p of taken) verts += p.mesh.getTotalVertices()
  const pos = new Float32Array(verts * 3)
  const nrm = new Float32Array(verts * 3)
  const uvs = new Float32Array(verts * 2)
  const mi = new Float32Array(verts * 4)
  const mw = new Float32Array(verts * 4)
  const idx: number[] = []
  let base = 0
  for (const p of taken) {
    const m = p.mesh
    const n = m.getTotalVertices()
    pos.set(m.getVerticesData(VertexBuffer.PositionKind)!.slice(0, n * 3), base * 3)
    nrm.set(m.getVerticesData(VertexBuffer.NormalKind)!.slice(0, n * 3), base * 3)
    const rect = atlas.plan.rects[atlas.slot.get(p.texture.uniqueId)!]!
    remapUV(m.getVerticesData(VertexBuffer.UVKind)!, rect, atlas.plan.size, uvs.subarray(base * 2, (base + n) * 2))
    const ji = m.getVerticesData(VertexBuffer.MatricesIndicesKind)
    const jw = m.getVerticesData(VertexBuffer.MatricesWeightsKind)
    if (ji) mi.set(ji.slice(0, n * 4), base * 4)
    if (jw) mw.set(jw.slice(0, n * 4), base * 4)
    const ind = m.getIndices()!
    for (let i = 0; i < ind.length; i++) idx.push(ind[i]! + base)
    base += n
  }
  const vd = new VertexData()
  vd.positions = pos
  vd.normals = nrm
  vd.uvs = uvs
  vd.matricesIndices = mi
  vd.matricesWeights = mw
  vd.indices = verts > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx)
  const mesh = new Mesh(name, scene)
  vd.applyToMesh(mesh, false)
  const f = taken[0]!.mesh
  mesh.parent = f.parent
  mesh.position.copyFrom(f.position)
  if (f.rotationQuaternion) mesh.rotationQuaternion = f.rotationQuaternion.clone()
  else mesh.rotation.copyFrom(f.rotation)
  mesh.scaling.copyFrom(f.scaling)
  mesh.material = atlas.material
  mesh.skeleton = f.skeleton
  mesh.numBoneInfluencers = 4
  mesh.sideOrientation = f.sideOrientation
  mesh.overrideMaterialSideOrientation = f.overrideMaterialSideOrientation
  mesh.receiveShadows = f.receiveShadows
  mesh.layerMask = f.layerMask
  mesh.renderingGroupId = f.renderingGroupId
  mesh.isPickable = false
  mesh.metadata = f.metadata
  mesh.refreshBoundingInfo()
  return { mesh, taken }
}
