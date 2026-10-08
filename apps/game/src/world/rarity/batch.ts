/**
 * One draw for every rare-weapon effect on screen (docs/RARITY.md §5.2): a pooled mesh of quads written on the CPU
 * each frame (billboards, flat ground decals, oriented emblems, ribbon segments), textured from the effect atlas
 * (atlas.ts) and blended premultiplied: the colour adds light (an emissive glow; HDR above 1 blooms), the alpha
 * darkens what is behind (smoke, scorch) and is 0 for pure light. The atlas is RGB on black: the coverage is the
 * brightest channel. Colours are display colours: the shader decodes the sRGB art and divides by the scene's
 * exposure on the PBR presets (the same at noon and at night), and passes it through on Classic. The buffers grow by
 * doubling and are reused: nothing is allocated per frame once warm.
 */
import { BoundingInfo, Constants, Mesh, RawTexture, ShaderLanguage, ShaderMaterial, ShaderStore, Texture, Vector3, Vector4, VertexBuffer, VertexData, type Scene } from '@babylonjs/core'
import { ATLAS_URL, SPRITES, spriteUv, type SpriteName } from './atlas.ts'

const VS_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
attribute color: vec4f;
uniform viewProjection: mat4x4f;
varying vUV: vec2f;
varying vColor: vec4f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = uniforms.viewProjection * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.vUV = vertexInputs.uv;
  vertexOutputs.vColor = vertexInputs.color;
}
`
const FS_WGSL = /* wgsl */ `
uniform rfGain: vec4f;
var rfAtlasSampler: sampler;
var rfAtlas: texture_2d<f32>;
varying vUV: vec2f;
varying vColor: vec4f;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  // the mip is clamped (cells sit edge to edge: a deep mip would bleed a neighbour in)
  let px = fragmentInputs.vUV * vec2f(2048.0, 2560.0);
  let lod = min(0.5 * log2(max(max(dot(dpdx(px), dpdx(px)), dot(dpdy(px), dpdy(px))), 1.0)), 3.5);
  let s = textureSampleLevel(rfAtlas, rfAtlasSampler, fragmentInputs.vUV, lod).rgb;
  let cov = max(s.r, max(s.g, s.b));
  let lin = mix(s, pow(s, vec3f(2.2)), uniforms.rfGain.y);
  fragmentOutputs.color = vec4f(lin * fragmentInputs.vColor.rgb * uniforms.rfGain.x, cov * fragmentInputs.vColor.a);
}
`
const VS_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 viewProjection;
varying vec2 vUV;
varying vec4 vColor;
void main(void) {
  gl_Position = viewProjection * vec4(position, 1.0);
  vUV = uv;
  vColor = color;
}
`
const FS_GLSL = /* glsl */ `
precision highp float;
uniform vec4 rfGain;
uniform sampler2D rfAtlas;
varying vec2 vUV;
varying vec4 vColor;
void main(void) {
  vec2 px = vUV * vec2(2048.0, 2560.0);
  float lod = min(0.5 * log2(max(max(dot(dFdx(px), dFdx(px)), dot(dFdy(px), dFdy(px))), 1.0)), 3.5);
  vec3 s = textureLod(rfAtlas, vUV, lod).rgb;
  float cov = max(s.r, max(s.g, s.b));
  vec3 lin = mix(s, pow(s, vec3(2.2)), rfGain.y);
  gl_FragColor = vec4(lin * vColor.rgb * rfGain.x, cov * vColor.a);
}
`

/** The batch shaders by language (tests). */
export const RARITY_BATCH_SHADERS = { wgsl: { vertex: VS_WGSL, fragment: FS_WGSL }, glsl: { vertex: VS_GLSL, fragment: FS_GLSL } } as const

let registered = false
function register(): void {
  if (registered) return
  registered = true
  ShaderStore.ShadersStoreWGSL['sroRareFxVertexShader'] = VS_WGSL
  ShaderStore.ShadersStoreWGSL['sroRareFxFragmentShader'] = FS_WGSL
  ShaderStore.ShadersStore['sroRareFxVertexShader'] = VS_GLSL
  ShaderStore.ShadersStore['sroRareFxFragmentShader'] = FS_GLSL
}

/** u0, v0, u1, v1 per sprite, computed once. */
const UV: Readonly<Record<SpriteName, readonly [number, number, number, number]>> = Object.fromEntries(
  (Object.keys(SPRITES) as SpriteName[]).map(n => [n, spriteUv(n)]),
) as unknown as Record<SpriteName, readonly [number, number, number, number]>

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export class FxBatch {
  readonly mesh: Mesh
  readonly material: ShaderMaterial
  readonly atlas: Texture
  private capacity = 0
  private pos = new Float32Array(0)
  private uv = new Float32Array(0)
  private col = new Float32Array(0)
  /** Quads written this frame. */
  count = 0
  /** Most quads ever written in one frame (stats). */
  peak = 0
  private readonly gain = new Vector4(1, 1, 0, 0)
  private disposed = false

  constructor(readonly scene: Scene, initial = 256) {
    register()
    this.mesh = new Mesh('rarityFx', scene)
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.doNotSyncBoundingInfo = true
    // drawn after the scene's other transparent things (its sort sphere is the whole world)
    this.mesh.alphaIndex = 900
    this.mesh.metadata = { sroWorld: 'fx' }
    // NullEngine (tests): nothing loads; a 1×1 white stands in
    this.atlas = scene.getEngine().getClassName?.() === 'NullEngine'
      ? RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false)
      : new Texture(ATLAS_URL, scene, { noMipmap: false, invertY: false, samplingMode: Texture.TRILINEAR_SAMPLINGMODE })
    this.atlas.wrapU = Texture.CLAMP_ADDRESSMODE
    this.atlas.wrapV = Texture.CLAMP_ADDRESSMODE
    this.atlas.anisotropicFilteringLevel = 4
    const mat = new ShaderMaterial('rarityFxMat', scene, 'sroRareFx', {
      attributes: ['position', 'uv', 'color'],
      uniforms: ['viewProjection', 'rfGain'],
      samplers: ['rfAtlas'],
      needAlphaBlending: true,
      shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    mat.alphaMode = Constants.ALPHA_PREMULTIPLIED
    mat.disableDepthWrite = true
    mat.backFaceCulling = false
    mat.zOffset = -2
    mat.setTexture('rfAtlas', this.atlas)
    mat.setVector4('rfGain', this.gain)
    this.material = mat
    this.mesh.material = mat
    this.mesh.isVisible = false
    this.ensure(initial)
  }

  /** The shader's gain (display colours: 1 / exposure on PBR) and whether the art is decoded from sRGB. */
  setGain(gain: number, linear: boolean): void {
    if (this.gain.x === gain && this.gain.y === (linear ? 1 : 0)) return
    this.gain.set(gain, linear ? 1 : 0, 0, 0)
    this.material.setVector4('rfGain', this.gain)
  }

  private ensure(quads: number): void {
    if (quads <= this.capacity) return
    let cap = Math.max(64, this.capacity)
    while (cap < quads) cap *= 2
    const pos = new Float32Array(cap * 12)
    const uv = new Float32Array(cap * 8)
    const col = new Float32Array(cap * 16)
    pos.set(this.pos)
    uv.set(this.uv)
    col.set(this.col)
    this.pos = pos
    this.uv = uv
    this.col = col
    this.capacity = cap
    const idx = new Uint32Array(cap * 6)
    for (let q = 0; q < cap; q++) {
      const v = q * 4
      idx[q * 6] = v
      idx[q * 6 + 1] = v + 1
      idx[q * 6 + 2] = v + 2
      idx[q * 6 + 3] = v
      idx[q * 6 + 4] = v + 2
      idx[q * 6 + 5] = v + 3
    }
    const vd = new VertexData()
    vd.positions = this.pos
    vd.uvs = this.uv
    vd.colors = this.col
    vd.indices = idx
    vd.applyToMesh(this.mesh, true)
    // a fixed, huge bound: the quads move every frame (never culled; transparent sorting reads the sphere)
    const bi = new BoundingInfo(new Vector3(-1e5, -1e5, -1e5), new Vector3(1e5, 1e5, 1e5))
    this.mesh.setBoundingInfo(bi)
    for (const sub of this.mesh.subMeshes ?? []) sub.setBoundingInfo(bi)
  }

  begin(): void {
    this.count = 0
  }

  /** A free quad slot (grows the pool), or -1 past `max`. */
  private slot(): number {
    if (this.count >= this.capacity) this.ensure(this.count + 1)
    return this.count++
  }

  /**
   * A quad centred at (cx, cy, cz) spanning ±a along one axis (u) and ±b along the other (v, image up = +b), sprite
   * `name` (a turned sprite swaps its axes), colour `c` (premultiplied light rgb, darkening a), all four corners alike.
   */
  quad(cx: number, cy: number, cz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, name: SpriteName, c: Rgba): void {
    const q = this.slot()
    const p = this.pos
    const o = q * 12
    // corners: 0 (-a, +b) top-left, 1 (+a, +b), 2 (+a, -b), 3 (-a, -b)
    p[o] = cx - ax + bx
    p[o + 1] = cy - ay + by
    p[o + 2] = cz - az + bz
    p[o + 3] = cx + ax + bx
    p[o + 4] = cy + ay + by
    p[o + 5] = cz + az + bz
    p[o + 6] = cx + ax - bx
    p[o + 7] = cy + ay - by
    p[o + 8] = cz + az - bz
    p[o + 9] = cx - ax - bx
    p[o + 10] = cy - ay - by
    p[o + 11] = cz - az - bz
    this.uvRect(q, name)
    this.color4(q, c, c, c, c)
  }

  /** Four explicit corners (ribbons): p0 p1 at the leading edge (v = top), p2 p3 trailing; u from u0 to u1. */
  ribbon(
    p0x: number, p0y: number, p0z: number, p1x: number, p1y: number, p1z: number,
    p2x: number, p2y: number, p2z: number, p3x: number, p3y: number, p3z: number,
    name: SpriteName, u0: number, u1: number, c0: Rgba, c1: Rgba, c2: Rgba, c3: Rgba,
  ): void {
    const q = this.slot()
    const p = this.pos
    const o = q * 12
    p[o] = p0x
    p[o + 1] = p0y
    p[o + 2] = p0z
    p[o + 3] = p1x
    p[o + 4] = p1y
    p[o + 5] = p1z
    p[o + 6] = p2x
    p[o + 7] = p2y
    p[o + 8] = p2z
    p[o + 9] = p3x
    p[o + 10] = p3y
    p[o + 11] = p3z
    const r = UV[name]
    const du = r[2] - r[0]
    const k = q * 8
    const t = this.uv
    // leading edge = the strip's top row (v0)
    t[k] = r[0] + du * u0
    t[k + 1] = r[1]
    t[k + 2] = r[0] + du * u1
    t[k + 3] = r[1]
    t[k + 4] = r[0] + du * u1
    t[k + 5] = r[3]
    t[k + 6] = r[0] + du * u0
    t[k + 7] = r[3]
    this.color4(q, c0, c1, c2, c3)
  }

  private uvRect(q: number, name: SpriteName): void {
    const r = UV[name]
    const t = this.uv
    const k = q * 8
    t[k] = r[0]
    t[k + 1] = r[1]
    t[k + 2] = r[2]
    t[k + 3] = r[1]
    t[k + 4] = r[2]
    t[k + 5] = r[3]
    t[k + 6] = r[0]
    t[k + 7] = r[3]
  }

  private color4(q: number, c0: Rgba, c1: Rgba, c2: Rgba, c3: Rgba): void {
    const c = this.col
    const k = q * 16
    c[k] = c0.r
    c[k + 1] = c0.g
    c[k + 2] = c0.b
    c[k + 3] = c0.a
    c[k + 4] = c1.r
    c[k + 5] = c1.g
    c[k + 6] = c1.b
    c[k + 7] = c1.a
    c[k + 8] = c2.r
    c[k + 9] = c2.g
    c[k + 10] = c2.b
    c[k + 11] = c2.a
    c[k + 12] = c3.r
    c[k + 13] = c3.g
    c[k + 14] = c3.b
    c[k + 15] = c3.a
  }

  /** Uploads the frame (the unused tail is zeroed once so stale quads never show). */
  end(): void {
    if (this.disposed) return
    const n = this.count
    this.peak = Math.max(this.peak, n)
    if (!n) {
      this.mesh.isVisible = false
      return
    }
    this.pos.fill(0, n * 12, Math.min(this.pos.length, (this.lastCount > n ? this.lastCount : n) * 12))
    this.lastCount = n
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.pos, false, false)
    this.mesh.updateVerticesData(VertexBuffer.UVKind, this.uv, false, false)
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.col, false, false)
    const sub = this.mesh.subMeshes?.[0]
    if (sub) sub.indexCount = n * 6
    this.mesh.isVisible = true
  }

  private lastCount = 0

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mesh.dispose(false, false)
    this.material.dispose()
    this.atlas.dispose()
  }
}
