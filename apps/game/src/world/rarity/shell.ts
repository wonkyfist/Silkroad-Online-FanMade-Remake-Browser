/**
 * The aura that hugs a rare weapon's silhouette (docs/RARITY.md §5.10): three copies of the weapon's own mesh (shared
 * geometry), each pushed outward from the blade's centre line by its margin in the blade's plane (and past the tip),
 * and pushed a few centimetres away from the camera along the view ray, drawn additively with the depth test on. Where
 * a copy lies behind the weapon the weapon hides it; only the band that sticks out past the silhouette shows: a thin
 * white-hot line, then softer, wider ones in the tier's colour (a stepped falloff), with energy running along them and
 * swelling with the breath. Nothing is drawn over the weapon's face, so its art stays readable. Swaying parts
 * (tassels) get no shell: they move in their own shader. Only your own and the nearest rare weapons (the effects layer's full LOD) carry shells:
 * three draws each.
 */
import { Constants, Mesh, Quaternion, ShaderLanguage, ShaderMaterial, ShaderStore, Vector4, type AbstractMesh, type Scene } from '@babylonjs/core'
import { SWAY_KIND } from '../../three/weapon-sway-parts.ts'

const VS_WGSL = /* wgsl */ `
attribute position: vec3f;
#ifdef SWAY
attribute ${SWAY_KIND}: vec4f;
#endif
uniform world: mat4x4f;
uniform view: mat4x4f;
uniform projection: mat4x4f;
uniform shO: vec4f;
uniform shA: vec4f;
uniform shN: vec4f;
uniform shP: vec4f;
uniform shE: vec4f;
varying vT: f32;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  var p = vertexInputs.position;
  let a = uniforms.shA.xyz;
  let t = dot(p - uniforms.shO.xyz, a) / max(dot(a, a), 1e-8);
  let c = uniforms.shO.xyz + a * clamp(t, 0.0, 1.0);
  let n = normalize(uniforms.shN.xyz);
  var r = p - c;
  r = r - n * dot(r, n);
  let rl = length(r);
  var dir = vec3f(0.0);
  if (rl > 1e-5) {
    dir = r / rl;
  }
  var m = uniforms.shP.x * mix(uniforms.shP.w, 1.0, smoothstep(uniforms.shP.z - 0.08, uniforms.shP.z + 0.04, t));
  p = p + dir * m + normalize(a) * (m * smoothstep(0.9, 1.0, t));
  // pushed away from the eye along its own view ray (view space: exact for the camera that draws it)
  var vp = (uniforms.view * (uniforms.world * vec4f(p, 1.0))).xyz;
  vp = vp + normalize(vp) * uniforms.shP.y;
#ifdef SWAY
  // the swaying parts move in their own shader: no shell for them (all their vertices meet in one point)
  if (vertexInputs.sroSway.z > 0.0) {
    vp = vec3f(0.0, 0.0, -1.0);
  }
#endif
  vertexOutputs.position = uniforms.projection * vec4f(vp, 1.0);
  vertexOutputs.vT = t;
}
`
const FS_WGSL = /* wgsl */ `
uniform shC: vec4f;
uniform shF: vec4f;
varying vT: f32;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let t = fragmentInputs.vT;
  let run = 0.55 + 0.45 * sin(t * uniforms.shF.y - uniforms.shF.x * 3.2);
  let run2 = pow(0.5 + 0.5 * sin(t * 4.0 - uniforms.shF.x * 1.3), 4.0);
  let k = uniforms.shC.w * (run * 0.7 + run2 * 0.6) * uniforms.shF.z;
  fragmentOutputs.color = vec4f(uniforms.shC.rgb * k, 0.0);
}
`
const VS_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
#ifdef SWAY
attribute vec4 ${SWAY_KIND};
#endif
uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
uniform vec4 shO;
uniform vec4 shA;
uniform vec4 shN;
uniform vec4 shP;
uniform vec4 shE;
varying float vT;
void main(void) {
  vec3 p = position;
  vec3 a = shA.xyz;
  float t = dot(p - shO.xyz, a) / max(dot(a, a), 1e-8);
  vec3 c = shO.xyz + a * clamp(t, 0.0, 1.0);
  vec3 n = normalize(shN.xyz);
  vec3 r = p - c;
  r -= n * dot(r, n);
  float rl = length(r);
  vec3 dir = rl > 1e-5 ? r / rl : vec3(0.0);
  float m = shP.x * mix(shP.w, 1.0, smoothstep(shP.z - 0.08, shP.z + 0.04, t));
  p += dir * m + normalize(a) * (m * smoothstep(0.9, 1.0, t));
  vec3 vp = (view * (world * vec4(p, 1.0))).xyz;
  vp += normalize(vp) * shP.y;
#ifdef SWAY
  if (sroSway.z > 0.0) vp = vec3(0.0, 0.0, -1.0);
#endif
  gl_Position = projection * vec4(vp, 1.0);
  vT = t;
}
`
const FS_GLSL = /* glsl */ `
precision highp float;
uniform vec4 shC;
uniform vec4 shF;
varying float vT;
void main(void) {
  float run = 0.55 + 0.45 * sin(vT * shF.y - shF.x * 3.2);
  float run2 = pow(0.5 + 0.5 * sin(vT * 4.0 - shF.x * 1.3), 4.0);
  float k = shC.w * (run * 0.7 + run2 * 0.6) * shF.z;
  gl_FragColor = vec4(shC.rgb * k, 0.0);
}
`

export const SHELL_SHADERS = { wgsl: { vertex: VS_WGSL, fragment: FS_WGSL }, glsl: { vertex: VS_GLSL, fragment: FS_GLSL } } as const

let registered = false
function register(): void {
  if (registered) return
  registered = true
  ShaderStore.ShadersStoreWGSL['sroRareShellVertexShader'] = VS_WGSL
  ShaderStore.ShadersStoreWGSL['sroRareShellFragmentShader'] = FS_WGSL
  ShaderStore.ShadersStore['sroRareShellVertexShader'] = VS_GLSL
  ShaderStore.ShadersStore['sroRareShellFragmentShader'] = FS_GLSL
}

/** The shell's frame and look, in the source mesh's own space (weapon-rarity.ts MeshRarity). */
export interface ShellFrame {
  origin: { x: number; y: number; z: number }
  axis: { x: number; y: number; z: number }
  normal: { x: number; y: number; z: number }
  /** Margin (m, mesh space) of the inner line; the outer is SHELL_OUTER × it. */
  margin: number
  /** Blade units: from here on (toward the tip) the full margin, below it `shaft` × it. */
  from: number
  shaft: number
}

/** The shells: margin (× the frame's) and strength of each, inner to outer (a stepped falloff). */
export const SHELL_LAYERS = [
  { margin: 0.35, gain: 1 },
  { margin: 0.9, gain: 0.3 },
  { margin: 1.8, gain: 0.1 },
] as const
/** How far the shells sit behind the weapon (m, away from the camera). */
export const SHELL_PUSH_M = 0.035

interface Layer {
  mesh: Mesh
  mat: ShaderMaterial
  c: Vector4
  f: Vector4
}

/** The two shells of one weapon mesh. */
export class RareShell {
  private readonly layers: Layer[] = []
  private readonly eye = new Vector4()
  private disposed = false

  constructor(readonly source: AbstractMesh, frame: ShellFrame, scene: Scene) {
    register()
    const sway = source.isVerticesDataPresent(SWAY_KIND)
    for (const layer of SHELL_LAYERS) {
      const outer = layer.margin > 1
      const mesh = new Mesh(`rareShell${outer ? 'O' : 'I'}`, scene, null, source as Mesh, true, false)
      mesh.parent = source
      mesh.position.setAll(0)
      mesh.rotationQuaternion = Quaternion.Identity()
      mesh.scaling.setAll(1)
      mesh.isPickable = false
      mesh.alwaysSelectAsActiveMesh = true
      mesh.alphaIndex = 899
      mesh.metadata = { sroWorld: 'fx' }
      const mat = new ShaderMaterial(`rareShellMat${outer ? 'O' : 'I'}`, scene, 'sroRareShell', {
        attributes: sway ? ['position', SWAY_KIND] : ['position'],
        uniforms: ['world', 'view', 'projection', 'shO', 'shA', 'shN', 'shP', 'shE', 'shC', 'shF'],
        defines: sway ? ['#define SWAY'] : [],
        needAlphaBlending: true,
        shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      })
      mat.alphaMode = Constants.ALPHA_ONEONE
      mat.disableDepthWrite = true
      mat.backFaceCulling = false
      const m = frame.margin * layer.margin
      mat.setVector4('shO', new Vector4(frame.origin.x, frame.origin.y, frame.origin.z, 0))
      mat.setVector4('shA', new Vector4(frame.axis.x, frame.axis.y, frame.axis.z, 0))
      mat.setVector4('shN', new Vector4(frame.normal.x, frame.normal.y, frame.normal.z, 0))
      mat.setVector4('shP', new Vector4(m, SHELL_PUSH_M, frame.from, frame.shaft))
      const c = new Vector4()
      const f = new Vector4()
      mat.setVector4('shC', c)
      mat.setVector4('shF', f)
      mat.setVector4('shE', this.eye)
      mesh.material = mat
      this.layers.push({ mesh, mat, c, f })
    }
  }

  /**
   * This frame's look: colour (linear, display-relative: already × 1 / exposure), the breath gain, the clock and the
   * eye (world). `vis` fades it with the weapon.
   */
  update(r: number, g: number, b: number, gain: number, seconds: number, eye: { x: number; y: number; z: number }, vis: number, runs = 18): void {
    if (this.disposed) return
    const on = vis > 0.01 && this.source.isEnabled() && this.source.isVisible
    this.eye.set(eye.x, eye.y, eye.z, 0)
    for (let i = 0; i < this.layers.length; i++) {
      const L = this.layers[i]!
      L.mesh.setEnabled(on)
      if (!on) continue
      const w = i === 0 ? 0.45 : 0
      const m = Math.max(r, g, b)
      L.c.set(r + (m - r) * w, g + (m - g) * w, b + (m - b) * w, SHELL_LAYERS[i]!.gain * vis)
      L.f.set(seconds % 600, runs, gain, 0)
      L.mat.setVector4('shC', L.c)
      L.mat.setVector4('shF', L.f)
      L.mat.setVector4('shE', this.eye)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const L of this.layers) {
      L.mesh.dispose(false, false)
      L.mat.dispose()
    }
    this.layers.length = 0
  }
}
