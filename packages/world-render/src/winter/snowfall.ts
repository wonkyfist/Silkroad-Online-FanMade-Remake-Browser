/**
 * Snowfall (docs/WINTER.md §7.4): the rain box (weather/rain.ts) re-cut for flakes, GPU only. One static mesh of N
 * camera-facing quads per layer; every flake is placed in its vertex shader, world-anchored and wrapped in a box around
 * the camera (it never swims when the camera moves), falling at its own speed with a sideways wobble and the wind. A
 * near layer (small flakes) and a far layer (bigger, fainter) give depth; a blizzard drives them sideways, faster and
 * thicker, stretched along their path. No CPU particles, no textures; WGSL on WebGPU, GLSL on WebGL2.
 *
 * Counts per weather level (SNOWFALL_COUNTS): Low 4k near only, Medium 8k + 4k, High 16k + 9k, Ultra 20k + 12k; Off
 * none. The share drawn follows the snowfall rate (a vertex whose share is out collapses), so light snow costs little.
 * The flake colour is the scene's precipitation tint (WorldWeather: the horizon light, already divided by the HDR
 * exposure), lifted: lit at noon, grey in a storm, dim at night, never glowing.
 */
import { BoundingInfo, Constants, Mesh, ShaderLanguage, ShaderMaterial, ShaderStore, Vector3, Vector4, VertexData, type Camera, type Scene } from '@babylonjs/core'
import type { WeatherLevel } from '../weather/presets.ts'
import { RAIN_ALPHA_INDEX } from '../weather/rain.ts'

/** Flakes per layer (near, far) per weather level. */
export const SNOWFALL_COUNTS: Readonly<Record<WeatherLevel, readonly [number, number]>> = {
  off: [0, 0],
  low: [4000, 0],
  medium: [8000, 4000],
  high: [16000, 9000],
  ultra: [20000, 12000],
}

const H3_WGSL = 'fn snfH3(n: f32) -> vec3f { return fract(sin(vec3f(n, n + 1.0, n + 2.0)) * vec3f(43758.5453, 22578.1459, 19642.349)); }\n'
const H3_GLSL = 'vec3 snfH3(float n) { return fract(sin(vec3(n, n + 1.0, n + 2.0)) * vec3(43758.5453, 22578.1459, 19642.349)); }\n'

// snfCam: camera xyz, time; snfP0: fall offset xyz, share drawn; snfP1: box xyz, flake size (m);
// snfP2: unit velocity xyz, stretch; snfP3: wobble (m), pixel angle, near fade (m), 0; snfC: colour rgb, alpha.
const VS_WGSL = /* wgsl */ `
attribute position: vec3f;
uniform viewProjection: mat4x4f;
uniform snfCam: vec4f;
uniform snfP0: vec4f;
uniform snfP1: vec4f;
uniform snfP2: vec4f;
uniform snfP3: vec4f;
varying vUV: vec2f;
varying vA: f32;
${H3_WGSL}
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let id = vertexInputs.position.z;
  let corner = vertexInputs.position.xy;
  let seed = snfH3(id * 1.618);
  let s2 = snfH3(id * 3.17 + 11.0);
  let cam = uniforms.snfCam.xyz;
  let t = uniforms.snfCam.w;
  let size = uniforms.snfP1.xyz;
  let lo = cam - size * 0.5;
  let off = uniforms.snfP0.xyz * vec3f(1.0, 0.7 + 0.6 * s2.x, 1.0);
  let wob = vec3f(sin(t * (0.8 + s2.y) + seed.x * 31.0), 0.0, cos(t * (0.6 + s2.z) + seed.z * 27.0)) * uniforms.snfP3.x;
  let q = seed * size + off + wob - lo;
  let p = lo + q - size * floor(q / size);
  let keep = step(fract(seed.x * 7.13 + seed.z * 3.71), uniforms.snfP0.w);
  let toCam = cam - p;
  let d = length(toCam);
  let fs0 = uniforms.snfP1.w * (0.55 + 0.9 * s2.z);
  let fs = max(fs0, d * uniforms.snfP3.y * 1.3);
  let fwd = toCam / max(d, 1e-4);
  let side = normalize(cross(fwd, uniforms.snfP2.xyz) + vec3f(1e-5, 0.0, 1e-5));
  let up = normalize(cross(side, fwd));
  let along = uniforms.snfP2.xyz - fwd * dot(uniforms.snfP2.xyz, fwd);
  let pos = p + side * (corner.x * fs) + up * (corner.y * fs) + along * (corner.y * fs * uniforms.snfP2.w);
  let fadeR = size.x * 0.5;
  vertexOutputs.vA = keep * smoothstep(uniforms.snfP3.z, uniforms.snfP3.z * 3.0, d) * (1.0 - smoothstep(fadeR * 0.6, fadeR, d)) * min(1.0, (fs0 / fs) * (fs0 / fs) + 0.25);
  vertexOutputs.vUV = corner * 2.0;
  vertexOutputs.position = (uniforms.viewProjection * vec4f(pos, 1.0)) * keep;
}
`
const FS_WGSL = /* wgsl */ `
uniform snfC: vec4f;
varying vUV: vec2f;
varying vA: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let r = length(fragmentInputs.vUV);
  let a = (1.0 - smoothstep(0.35, 1.0, r)) * fragmentInputs.vA * uniforms.snfC.w;
  fragmentOutputs.color = vec4f(uniforms.snfC.rgb * a, a);
}
`
const VS_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
uniform vec4 snfCam;
uniform vec4 snfP0;
uniform vec4 snfP1;
uniform vec4 snfP2;
uniform vec4 snfP3;
varying vec2 vUV;
varying float vA;
${H3_GLSL}
void main(void) {
  float id = position.z;
  vec2 corner = position.xy;
  vec3 seed = snfH3(id * 1.618);
  vec3 s2 = snfH3(id * 3.17 + 11.0);
  vec3 cam = snfCam.xyz;
  float t = snfCam.w;
  vec3 size = snfP1.xyz;
  vec3 lo = cam - size * 0.5;
  vec3 off = snfP0.xyz * vec3(1.0, 0.7 + 0.6 * s2.x, 1.0);
  vec3 wob = vec3(sin(t * (0.8 + s2.y) + seed.x * 31.0), 0.0, cos(t * (0.6 + s2.z) + seed.z * 27.0)) * snfP3.x;
  vec3 q = seed * size + off + wob - lo;
  vec3 p = lo + q - size * floor(q / size);
  float keep = step(fract(seed.x * 7.13 + seed.z * 3.71), snfP0.w);
  vec3 toCam = cam - p;
  float d = length(toCam);
  float fs0 = snfP1.w * (0.55 + 0.9 * s2.z);
  float fs = max(fs0, d * snfP3.y * 1.3);
  vec3 fwd = toCam / max(d, 1e-4);
  vec3 side = normalize(cross(fwd, snfP2.xyz) + vec3(1e-5, 0.0, 1e-5));
  vec3 up = normalize(cross(side, fwd));
  vec3 along = snfP2.xyz - fwd * dot(snfP2.xyz, fwd);
  vec3 pos = p + side * (corner.x * fs) + up * (corner.y * fs) + along * (corner.y * fs * snfP2.w);
  float fadeR = size.x * 0.5;
  vA = keep * smoothstep(snfP3.z, snfP3.z * 3.0, d) * (1.0 - smoothstep(fadeR * 0.6, fadeR, d)) * min(1.0, (fs0 / fs) * (fs0 / fs) + 0.25);
  vUV = corner * 2.0;
  gl_Position = (viewProjection * vec4(pos, 1.0)) * keep;
}
`
const FS_GLSL = /* glsl */ `
precision highp float;
uniform vec4 snfC;
varying vec2 vUV;
varying float vA;
void main(void) {
  float r = length(vUV);
  float a = (1.0 - smoothstep(0.35, 1.0, r)) * vA * snfC.w;
  gl_FragColor = vec4(snfC.rgb * a, a);
}
`

/** The flake shaders by language (tests). */
export const SNOWFALL_SHADERS = { wgsl: { vertex: VS_WGSL, fragment: FS_WGSL }, glsl: { vertex: VS_GLSL, fragment: FS_GLSL } } as const

let registered = false
function register(): void {
  if (registered) return
  registered = true
  ShaderStore.ShadersStoreWGSL['sroSnowFallVertexShader'] = VS_WGSL
  ShaderStore.ShadersStoreWGSL['sroSnowFallFragmentShader'] = FS_WGSL
  ShaderStore.ShadersStore['sroSnowFallVertexShader'] = VS_GLSL
  ShaderStore.ShadersStore['sroSnowFallFragmentShader'] = FS_GLSL
}

function quads(scene: Scene, name: string, n: number): Mesh {
  const pos = new Float32Array(n * 12)
  const idx = new Uint32Array(n * 6)
  for (let i = 0; i < n; i++) {
    pos.set([-0.5, -0.5, i, 0.5, -0.5, i, 0.5, 0.5, i, -0.5, 0.5, i], i * 12)
    const v = i * 4
    idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6)
  }
  const mesh = new Mesh(name, scene)
  const vd = new VertexData()
  vd.positions = pos
  vd.indices = idx
  vd.applyToMesh(mesh, false)
  mesh.isPickable = false
  mesh.alwaysSelectAsActiveMesh = true
  mesh.doNotSyncBoundingInfo = true
  mesh.alphaIndex = RAIN_ALPHA_INDEX
  mesh.metadata = { sroWorld: 'weather' }
  mesh.setBoundingInfo(new BoundingInfo(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)))
  return mesh
}

interface Layer {
  mesh: Mesh
  mat: ShaderMaterial
  box: Vector3
  flake: number
  alpha: number
  speed: number
  cam: Vector4
  p0: Vector4
  p1: Vector4
  p2: Vector4
  p3: Vector4
  c: Vector4
  offset: Vector3
}

/** What the flakes follow each frame. */
export interface SnowfallInput {
  /** Snowfall rate 0..1 (1 = a blizzard). */
  snow: number
  /** Unit wind direction and the gusting speed (m/s). */
  windX: number
  windZ: number
  gustMs: number
  /** The precipitation tint (display colour already divided by the HDR exposure). */
  color: readonly [number, number, number]
}

export class Snowfall {
  private readonly layers: Layer[] = []
  private t = 0
  private readonly vel = new Vector3()

  constructor(private readonly scene: Scene, readonly level: WeatherLevel) {
    register()
    const [near, far] = SNOWFALL_COUNTS[level]
    if (near > 0) this.layers.push(this.layer('snowFallNear', near, new Vector3(40, 24, 40), 0.032, 0.8, 1.0))
    if (far > 0) this.layers.push(this.layer('snowFallFar', far, new Vector3(110, 50, 110), 0.11, 0.55, 1.15))
  }

  /** Flakes this level can draw (all layers). */
  get capacity(): number {
    return SNOWFALL_COUNTS[this.level][0] + SNOWFALL_COUNTS[this.level][1]
  }

  /** Whether a layer draws now. */
  get drawing(): boolean {
    return this.layers.some(l => l.mesh.isEnabled())
  }

  private layer(name: string, n: number, box: Vector3, flake: number, alpha: number, speed: number): Layer {
    const mesh = quads(this.scene, name, n)
    const mat = new ShaderMaterial(name, this.scene, 'sroSnowFall', {
      attributes: ['position'],
      uniforms: ['viewProjection', 'snfCam', 'snfP0', 'snfP1', 'snfP2', 'snfP3', 'snfC'],
      needAlphaBlending: true,
      shaderLanguage: this.scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    mat.alphaMode = Constants.ALPHA_PREMULTIPLIED
    mat.disableDepthWrite = true
    mat.backFaceCulling = false
    mesh.material = mat
    const L: Layer = { mesh, mat, box, flake, alpha, speed, cam: new Vector4(), p0: new Vector4(), p1: new Vector4(), p2: new Vector4(), p3: new Vector4(), c: new Vector4(), offset: new Vector3() }
    for (const [k, v] of [['snfCam', L.cam], ['snfP0', L.p0], ['snfP1', L.p1], ['snfP2', L.p2], ['snfP3', L.p3], ['snfC', L.c]] as const) mat.setVector4(k, v)
    mesh.setEnabled(false)
    return L
  }

  /** Per frame (dt in s). */
  update(dt: number, camera: Camera | null, f: Readonly<SnowfallInput>): void {
    const snow = Math.min(1, Math.max(0, f.snow || 0))
    const on = snow > 0.01 && !!camera
    for (const L of this.layers) if (L.mesh.isEnabled() !== on) L.mesh.setEnabled(on)
    if (!on || !camera) return
    this.t = (this.t + dt) % 3600
    // a blizzard: from snowfall 0.6 (the snow state) to 1
    const bz = Math.min(1, Math.max(0, (snow - 0.6) / 0.4))
    const wind = Math.max(0, f.gustMs || 0)
    const fall = 1.1 + 2.0 * bz
    this.vel.set(f.windX * wind * 0.35, -fall, f.windZ * wind * 0.35)
    const vlen = Math.max(1e-4, this.vel.length())
    const engine = this.scene.getEngine()
    const fov = (camera as { fov?: number }).fov ?? 0.8
    const pix = (2 * Math.tan(fov / 2)) / Math.max(1, engine.getRenderHeight())
    const p = camera.globalPosition
    const [r, g, b] = f.color
    const share = Math.min(1, 0.15 + 0.85 * snow) * (1 + 0.3 * bz)
    for (const L of this.layers) {
      L.offset.x = (L.offset.x + this.vel.x * dt * L.speed) % (L.box.x * 64)
      L.offset.y = (L.offset.y + this.vel.y * dt * L.speed) % (L.box.y * 64)
      L.offset.z = (L.offset.z + this.vel.z * dt * L.speed) % (L.box.z * 64)
      L.cam.set(p.x, p.y, p.z, this.t)
      L.p0.set(L.offset.x, L.offset.y, L.offset.z, Math.min(1, share))
      L.p1.set(L.box.x, L.box.y, L.box.z, L.flake * (1 + 0.3 * bz))
      L.p2.set(this.vel.x / vlen, this.vel.y / vlen, this.vel.z / vlen, 0.3 + 2.8 * bz)
      L.p3.set(0.35 * (1 - 0.6 * bz), pix, L.flake < 0.05 ? 2.8 : 6, 0)
      L.c.set(r, g, b, L.alpha * (0.85 + 0.15 * bz))
    }
  }

  dispose(): void {
    for (const L of this.layers) {
      L.mesh.dispose()
      L.mat.dispose()
    }
    this.layers.length = 0
  }
}
