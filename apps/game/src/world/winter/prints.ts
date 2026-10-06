/**
 * Footprints in the snow (docs/WINTER.md §8.1), the Play the Boss paw-print idea (world/pilot-fx.ts PawPrints) grown
 * to every walker: players, monsters and NPCs within PRINT_RANGE_M of the camera leave a print every PRINT_STRIDE_M,
 * left and right in turn, turned along their path, while the snow cover is deep enough. Prints fade over PRINT_FADE_S
 * (faster while it snows: fresh snow fills them) and the oldest go first past PRINT_MAX.
 *
 * Drawn as ONE updatable mesh (four vertices a print; rebuilt at most every REBUILD_S) with a tiny shader: a procedural
 * boot sole and heel, multiplied into what is under it (blend DST_COLOR × SRC), so a print darkens the snow the same on
 * the Classic and the HDR path, at noon and at night, with no texture and no exposure to follow. Its material and mesh
 * are made on the first print and disposed with this.
 */
import { Constants, Mesh, ShaderLanguage, ShaderMaterial, ShaderStore, Vector4, VertexBuffer, VertexData, type Scene } from '@babylonjs/core'

/** Prints kept at most (the oldest go first). */
export const PRINT_MAX = 900
/** Distance between two prints of one walker (m). */
export const PRINT_STRIDE_M = 0.72
/** Walkers farther than this from the camera leave none (m). */
export const PRINT_RANGE_M = 45
/** A print fades out over this long (s), or over PRINT_FADE_SNOW_S while it snows hard. */
export const PRINT_FADE_S = 120
export const PRINT_FADE_SNOW_S = 40
/** The snow cover from which there are prints (and at which they are faint). */
export const PRINT_COVER_MIN = 0.2
/** The mesh is rebuilt at most this often (s) while prints change or fade. */
const REBUILD_S = 0.25
/** Half the print's size (m): width, length. */
const HALF_W = 0.12
const HALF_L = 0.2
/** A foot sits this far beside the walker's line (m). */
const FOOT_SIDE_M = 0.14

export interface Print {
  x: number
  y: number
  z: number
  yaw: number
  /** Seconds (the tracker's clock) it was made. */
  at: number
}

interface Walker {
  x: number
  z: number
  side: number
  seen: number
}

/**
 * The bookkeeping (pure: no Babylon): which walker made a print where. `step` takes this frame's walkers and returns
 * whether the print list changed.
 */
export class PrintTrail {
  readonly prints: Print[] = []
  private readonly walkers = new Map<number, Walker>()
  private clock = 0
  private frame = 0

  get time(): number {
    return this.clock
  }

  /**
   * One frame: `walkers` are (id, x, y, z) of the walkers in range on the ground now; `cover` the snow cover; `fadeS`
   * the current fade time. New prints where a walker moved a stride since its last one.
   */
  step(dt: number, walkers: Iterable<{ id: number; x: number; y: number; z: number }>, cover: number, fadeS: number): boolean {
    this.clock += Math.max(0, dt)
    this.frame++
    let changed = false
    const deep = cover >= PRINT_COVER_MIN
    for (const w of walkers) {
      const last = this.walkers.get(w.id)
      if (!last) {
        this.walkers.set(w.id, { x: w.x, z: w.z, side: 1, seen: this.frame })
        continue
      }
      last.seen = this.frame
      const dx = w.x - last.x
      const dz = w.z - last.z
      const d = Math.hypot(dx, dz)
      if (d < PRINT_STRIDE_M) continue
      // a teleport or a fast ride: no trail across it
      if (d > PRINT_STRIDE_M * 6 || !deep) {
        last.x = w.x
        last.z = w.z
        continue
      }
      const yaw = Math.atan2(dx, dz)
      const sx = Math.cos(yaw) * FOOT_SIDE_M * last.side
      const sz = -Math.sin(yaw) * FOOT_SIDE_M * last.side
      this.prints.push({ x: w.x + sx, y: w.y, z: w.z + sz, yaw, at: this.clock })
      last.side = -last.side
      last.x = w.x
      last.z = w.z
      changed = true
    }
    // walkers gone from range forget their place (a walker coming back starts a new trail)
    if (this.frame % 30 === 0) for (const [id, w] of this.walkers) if (w.seen !== this.frame) this.walkers.delete(id)
    while (this.prints.length > PRINT_MAX) {
      this.prints.shift()
      changed = true
    }
    while (this.prints.length && this.clock - this.prints[0]!.at > fadeS) {
      this.prints.shift()
      changed = true
    }
    return changed
  }

  /** The fade of a print 0..1 (1 new, 0 gone). */
  fade(p: Print, fadeS: number): number {
    const k = 1 - (this.clock - p.at) / Math.max(1, fadeS)
    return k < 0 ? 0 : k > 1 ? 1 : k
  }

  clear(): void {
    this.prints.length = 0
    this.walkers.clear()
  }
}

const VS_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;
attribute color: vec4f;
uniform viewProjection: mat4x4f;
varying vUV: vec2f;
varying vA: f32;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = uniforms.viewProjection * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.vUV = vertexInputs.uv;
  vertexOutputs.vA = vertexInputs.color.a;
}
`
const FS_WGSL = /* wgsl */ `
uniform prTint: vec4f;
varying vUV: vec2f;
varying vA: f32;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let p = fragmentInputs.vUV * 2.0 - vec2f(1.0);
  let sole = length(vec2f(p.x * 1.05, (p.y - 0.28) * 0.8));
  let heel = length(vec2f(p.x * 1.2, (p.y + 0.62) * 1.5));
  let shape = max(1.0 - smoothstep(0.62, 0.8, sole), 1.0 - smoothstep(0.45, 0.62, heel));
  let k = shape * fragmentInputs.vA;
  fragmentOutputs.color = vec4f(mix(vec3f(1.0), uniforms.prTint.rgb, k), 1.0);
}
`
const VS_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 viewProjection;
varying vec2 vUV;
varying float vA;
void main(void) {
  gl_Position = viewProjection * vec4(position, 1.0);
  vUV = uv;
  vA = color.a;
}
`
const FS_GLSL = /* glsl */ `
precision highp float;
uniform vec4 prTint;
varying vec2 vUV;
varying float vA;
void main(void) {
  vec2 p = vUV * 2.0 - vec2(1.0);
  float sole = length(vec2(p.x * 1.05, (p.y - 0.28) * 0.8));
  float heel = length(vec2(p.x * 1.2, (p.y + 0.62) * 1.5));
  float shape = max(1.0 - smoothstep(0.62, 0.8, sole), 1.0 - smoothstep(0.45, 0.62, heel));
  float k = shape * vA;
  gl_FragColor = vec4(mix(vec3(1.0), prTint.rgb, k), 1.0);
}
`

let registered = false
function register(): void {
  if (registered) return
  registered = true
  ShaderStore.ShadersStoreWGSL['sroSnowPrintVertexShader'] = VS_WGSL
  ShaderStore.ShadersStoreWGSL['sroSnowPrintFragmentShader'] = FS_WGSL
  ShaderStore.ShadersStore['sroSnowPrintVertexShader'] = VS_GLSL
  ShaderStore.ShadersStore['sroSnowPrintFragmentShader'] = FS_GLSL
}

/** The prints' shaders by language (tests). */
export const PRINT_SHADERS = { wgsl: { vertex: VS_WGSL, fragment: FS_WGSL }, glsl: { vertex: VS_GLSL, fragment: FS_GLSL } } as const

/** The footprints of one world visit (see the file comment). */
export class SnowPrints {
  readonly trail = new PrintTrail()
  private mesh: Mesh | null = null
  private mat: ShaderMaterial | null = null
  private rebuildIn = 0
  private capacity = 0

  constructor(private readonly scene: Scene) {}

  /** Prints alive now and whether the mesh draws (tests, the debug handle). */
  stats(): { prints: number; drawn: boolean } {
    return { prints: this.trail.prints.length, drawn: !!this.mesh?.isEnabled() }
  }

  /**
   * Per frame: `walkers` on the ground in range, the snow `cover` (prints show from PRINT_COVER_MIN), the snowfall
   * `snow` (fresh snow fills them faster). `dt` in s.
   */
  update(dt: number, walkers: Iterable<{ id: number; x: number; y: number; z: number }>, cover: number, snow: number): void {
    const fadeS = snow > 0.3 ? PRINT_FADE_SNOW_S : PRINT_FADE_S
    this.trail.step(dt, walkers, cover, fadeS)
    if (!this.trail.prints.length) {
      if (this.mesh?.isEnabled()) this.mesh.setEnabled(false)
      return
    }
    this.rebuildIn -= dt
    if (this.rebuildIn > 0) return
    this.rebuildIn = REBUILD_S
    // the fade is redrawn with the rebuild, so a rebuild happens while any print shows
    this.build(fadeS, cover)
  }

  private ensure(n: number): Mesh {
    if (this.mesh && n <= this.capacity) return this.mesh
    register()
    this.mesh?.dispose()
    const cap = Math.min(PRINT_MAX, Math.max(64, n * 2))
    const mesh = new Mesh('snowPrints', this.scene)
    const vd = new VertexData()
    vd.positions = new Float32Array(cap * 12)
    vd.uvs = new Float32Array(cap * 8)
    vd.colors = new Float32Array(cap * 16)
    const idx = new Uint32Array(cap * 6)
    for (let i = 0; i < cap; i++) idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2], i * 6)
    vd.indices = idx
    vd.applyToMesh(mesh, true)
    mesh.isPickable = false
    mesh.alwaysSelectAsActiveMesh = true
    mesh.doNotSyncBoundingInfo = true
    mesh.metadata = { sroWorld: 'weather' }
    if (!this.mat) {
      const mat = new ShaderMaterial('snowPrintsMat', this.scene, 'sroSnowPrint', {
        attributes: ['position', 'uv', 'color'],
        uniforms: ['viewProjection', 'prTint'],
        needAlphaBlending: true,
        shaderLanguage: this.scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      })
      mat.alphaMode = Constants.ALPHA_MULTIPLY
      mat.disableDepthWrite = true
      mat.backFaceCulling = false
      mat.zOffset = -2
      this.mat = mat
    }
    mesh.material = this.mat
    this.mesh = mesh
    this.capacity = cap
    return mesh
  }

  private build(fadeS: number, cover: number): void {
    const prints = this.trail.prints
    const mesh = this.ensure(prints.length)
    const pos = new Float32Array(this.capacity * 12)
    const uv = new Float32Array(this.capacity * 8)
    const col = new Float32Array(this.capacity * 16)
    const depth = Math.min(1, (cover - PRINT_COVER_MIN) / 0.3 + 0.35)
    let i = 0
    for (const p of prints) {
      const a = this.trail.fade(p, fadeS) * depth
      const s = Math.sin(p.yaw)
      const c = Math.cos(p.yaw)
      // forward (s, c), right (c, −s); corners (−w, −l), (w, −l), (w, l), (−w, l)
      const corners = [[-HALF_W, -HALF_L], [HALF_W, -HALF_L], [HALF_W, HALF_L], [-HALF_W, HALF_L]] as const
      for (let k = 0; k < 4; k++) {
        const [u, v] = corners[k]!
        const o = (i * 4 + k)
        pos[o * 3] = p.x + c * u + s * v
        pos[o * 3 + 1] = p.y + 0.025
        pos[o * 3 + 2] = p.z - s * u + c * v
        uv[o * 2] = u > 0 ? 1 : 0
        uv[o * 2 + 1] = v > 0 ? 1 : 0
        col[o * 4 + 3] = a
      }
      i++
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, pos)
    mesh.updateVerticesData(VertexBuffer.UVKind, uv)
    mesh.updateVerticesData(VertexBuffer.ColorKind, col)
    this.mat!.setVector4('prTint', PRINT_TINT)
    if (!mesh.isEnabled()) mesh.setEnabled(true)
  }

  dispose(): void {
    this.trail.clear()
    this.mesh?.dispose()
    this.mat?.dispose()
    this.mesh = null
    this.mat = null
    this.capacity = 0
  }
}

/** The print's shade: the snow darkened toward a cold shadow (multiplied into what is under it). */
const PRINT_TINT = new Vector4(0.5, 0.55, 0.64, 1)
