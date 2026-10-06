/**
 * Breath vapour in the cold (docs/WINTER.md §8.2): while the frost is up, the people near the camera (players and NPCs
 * within BREATH_RANGE_M, at most BREATH_EMITTERS of them) breathe out a small puff every few seconds in front of the
 * face; each puff grows, drifts forward and with the wind, and fades in about 1.5 s.
 *
 * One updatable mesh of camera-facing quads (four vertices a puff, at most BREATH_MAX), placed in its vertex shader from
 * the camera's right and up vectors; a soft round puff in the fragment shader, no texture. Its colour is the scene's
 * precipitation tint (already divided by the HDR exposure), so a puff is white at noon and faint at night and never
 * glows. Made on the first puff, disposed with this.
 */
import { Constants, Matrix, Mesh, ShaderLanguage, ShaderMaterial, ShaderStore, Vector3, Vector4, VertexBuffer, VertexData, type Camera, type Scene } from '@babylonjs/core'

/** Puffs alive at most. */
export const BREATH_MAX = 48
/** People farther than this from the camera do not show their breath (m), and at most this many do. */
export const BREATH_RANGE_M = 25
export const BREATH_EMITTERS = 16
/** The frost from which breath shows. */
export const BREATH_FROST_MIN = 0.4
/** A puff lives this long (s); breaths come every BREATH_EVERY_S (± a third, per person). */
export const BREATH_LIFE_S = 1.5
export const BREATH_EVERY_S = 3.2
/** Mouth height above the feet (m) and forward of the body (m). */
const MOUTH_Y = 1.58
const MOUTH_FWD = 0.2

export interface Breather {
  id: number
  x: number
  y: number
  z: number
  /** Heading (glTF yaw: atan2(dx, dz)). */
  yaw: number
}

interface Puff {
  x: number
  y: number
  z: number
  vx: number
  vz: number
  age: number
}

/** The breathing rhythm (pure: no Babylon): who breathes out when. */
export class BreathClock {
  private readonly next = new Map<number, number>()
  private clock = 0

  /** Advances by `dt` and returns the breathers who breathe out now. */
  step(dt: number, people: readonly Breather[]): Breather[] {
    this.clock += Math.max(0, dt)
    const out: Breather[] = []
    const seen = new Set<number>()
    for (const p of people) {
      seen.add(p.id)
      let t = this.next.get(p.id)
      if (t === undefined) {
        // a stagger by id, so a crowd does not breathe in step
        t = this.clock + ((p.id * 0.618034) % 1) * BREATH_EVERY_S
        this.next.set(p.id, t)
      }
      if (this.clock < t) continue
      out.push(p)
      const jitter = 1 + (((p.id * 7919 + Math.floor(this.clock * 10)) % 13) / 13 - 0.5) * 0.66
      this.next.set(p.id, this.clock + BREATH_EVERY_S * jitter)
    }
    for (const id of [...this.next.keys()]) if (!seen.has(id)) this.next.delete(id)
    return out
  }
}

const VS_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
attribute color: vec4f;
uniform viewProjection: mat4x4f;
uniform brRight: vec4f;
uniform brUp: vec4f;
varying vUV: vec2f;
varying vA: f32;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let c = vertexInputs.uv * 2.0 - vec2f(1.0);
  let s = vertexInputs.color.r;
  let p = vertexInputs.position + uniforms.brRight.xyz * (c.x * s) + uniforms.brUp.xyz * (c.y * s);
  vertexOutputs.position = uniforms.viewProjection * vec4f(p, 1.0);
  vertexOutputs.vUV = c;
  vertexOutputs.vA = vertexInputs.color.a;
}
`
const FS_WGSL = /* wgsl */ `
uniform brColor: vec4f;
varying vUV: vec2f;
varying vA: f32;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let r = length(fragmentInputs.vUV);
  let a = (1.0 - smoothstep(0.2, 1.0, r)) * fragmentInputs.vA * uniforms.brColor.a;
  fragmentOutputs.color = vec4f(uniforms.brColor.rgb * a, a);
}
`
const VS_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 viewProjection;
uniform vec4 brRight;
uniform vec4 brUp;
varying vec2 vUV;
varying float vA;
void main(void) {
  vec2 c = uv * 2.0 - vec2(1.0);
  float s = color.r;
  vec3 p = position + brRight.xyz * (c.x * s) + brUp.xyz * (c.y * s);
  gl_Position = viewProjection * vec4(p, 1.0);
  vUV = c;
  vA = color.a;
}
`
const FS_GLSL = /* glsl */ `
precision highp float;
uniform vec4 brColor;
varying vec2 vUV;
varying float vA;
void main(void) {
  float r = length(vUV);
  float a = (1.0 - smoothstep(0.2, 1.0, r)) * vA * brColor.a;
  gl_FragColor = vec4(brColor.rgb * a, a);
}
`

/** The breath shaders by language (tests). */
export const BREATH_SHADERS = { wgsl: { vertex: VS_WGSL, fragment: FS_WGSL }, glsl: { vertex: VS_GLSL, fragment: FS_GLSL } } as const

let registered = false
function register(): void {
  if (registered) return
  registered = true
  ShaderStore.ShadersStoreWGSL['sroBreathVertexShader'] = VS_WGSL
  ShaderStore.ShadersStoreWGSL['sroBreathFragmentShader'] = FS_WGSL
  ShaderStore.ShadersStore['sroBreathVertexShader'] = VS_GLSL
  ShaderStore.ShadersStore['sroBreathFragmentShader'] = FS_GLSL
}

/** The breath of one world visit (see the file comment). */
export class BreathPuffs {
  readonly clock = new BreathClock()
  private readonly puffs: Puff[] = []
  private mesh: Mesh | null = null
  private mat: ShaderMaterial | null = null
  private readonly pos = new Float32Array(BREATH_MAX * 12)
  private readonly uv = new Float32Array(BREATH_MAX * 8)
  private readonly col = new Float32Array(BREATH_MAX * 16)
  private readonly right = new Vector4()
  private readonly up = new Vector4()
  private readonly color = new Vector4(0.8, 0.82, 0.85, 0.32)
  private readonly inv = new Matrix()
  private readonly tmp = new Vector3()

  constructor(private readonly scene: Scene) {
    for (let i = 0; i < BREATH_MAX; i++) {
      this.uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8)
    }
  }

  /** Puffs alive now (tests, the debug handle). */
  get count(): number {
    return this.puffs.length
  }

  /**
   * Per frame: `people` near the camera (already filtered and capped), the frost, the wind (unit x, z and m/s) and the
   * puff colour (display colour divided by the exposure). `dt` in s.
   */
  update(dt: number, camera: Camera | null, people: readonly Breather[], frost: number, wind: { x: number; z: number; ms: number }, tint: readonly [number, number, number]): void {
    const cold = frost >= BREATH_FROST_MIN
    for (const b of this.clock.step(dt, cold ? people : [])) {
      if (this.puffs.length >= BREATH_MAX) this.puffs.shift()
      const fx = Math.sin(b.yaw)
      const fz = Math.cos(b.yaw)
      this.puffs.push({ x: b.x + fx * MOUTH_FWD, y: b.y + MOUTH_Y, z: b.z + fz * MOUTH_FWD, vx: fx * 0.28 + wind.x * Math.min(3, wind.ms) * 0.12, vz: fz * 0.28 + wind.z * Math.min(3, wind.ms) * 0.12, age: 0 })
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!
      p.age += dt
      if (p.age >= BREATH_LIFE_S) this.puffs.splice(i, 1)
    }
    if (!this.puffs.length || !camera) {
      if (this.mesh?.isEnabled()) this.mesh.setEnabled(false)
      return
    }
    const mesh = this.ensure()
    this.col.fill(0)
    const n = this.puffs.length
    for (let i = 0; i < n; i++) {
      const p = this.puffs[i]!
      const t = p.age / BREATH_LIFE_S
      const x = p.x + p.vx * p.age
      const y = p.y + 0.06 * p.age
      const z = p.z + p.vz * p.age
      const size = 0.06 + 0.26 * Math.sqrt(t)
      const a = Math.min(1, t * 8) * (1 - t) * (1 - t)
      for (let k = 0; k < 4; k++) {
        const o = i * 4 + k
        this.pos[o * 3] = x
        this.pos[o * 3 + 1] = y
        this.pos[o * 3 + 2] = z
        this.col[o * 4] = size
        this.col[o * 4 + 3] = a
      }
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, this.pos)
    mesh.updateVerticesData(VertexBuffer.ColorKind, this.col)
    // the camera's right and up in world space
    camera.getViewMatrix().invertToRef(this.inv)
    Vector3.TransformNormalToRef(Vector3.RightReadOnly, this.inv, this.tmp)
    this.right.set(this.tmp.x, this.tmp.y, this.tmp.z, 0)
    Vector3.TransformNormalToRef(Vector3.UpReadOnly, this.inv, this.tmp)
    this.up.set(this.tmp.x, this.tmp.y, this.tmp.z, 0)
    this.color.set(Math.min(1.2, tint[0] * 1.25 + 0.03), Math.min(1.2, tint[1] * 1.25 + 0.03), Math.min(1.2, tint[2] * 1.25 + 0.03), 0.3)
    if (!mesh.isEnabled()) mesh.setEnabled(true)
  }

  private ensure(): Mesh {
    if (this.mesh) return this.mesh
    register()
    const mesh = new Mesh('winterBreath', this.scene)
    const vd = new VertexData()
    vd.positions = this.pos
    vd.uvs = this.uv
    vd.colors = this.col
    const idx = new Uint32Array(BREATH_MAX * 6)
    for (let i = 0; i < BREATH_MAX; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6)
    vd.indices = idx
    vd.applyToMesh(mesh, true)
    mesh.isPickable = false
    mesh.alwaysSelectAsActiveMesh = true
    mesh.doNotSyncBoundingInfo = true
    mesh.metadata = { sroWorld: 'weather' }
    const mat = new ShaderMaterial('winterBreathMat', this.scene, 'sroBreath', {
      attributes: ['position', 'uv', 'color'],
      uniforms: ['viewProjection', 'brRight', 'brUp', 'brColor'],
      needAlphaBlending: true,
      shaderLanguage: this.scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    mat.alphaMode = Constants.ALPHA_PREMULTIPLIED
    mat.disableDepthWrite = true
    mat.backFaceCulling = false
    mat.setVector4('brRight', this.right)
    mat.setVector4('brUp', this.up)
    mat.setVector4('brColor', this.color)
    mesh.material = mat
    this.mesh = mesh
    this.mat = mat
    return mesh
  }

  dispose(): void {
    this.puffs.length = 0
    this.mesh?.dispose()
    this.mat?.dispose()
    this.mesh = null
    this.mat = null
  }
}
