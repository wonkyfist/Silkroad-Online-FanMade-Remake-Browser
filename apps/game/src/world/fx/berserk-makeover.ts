/**
 * The Berserk makeover in the 3D view (docs/EFFECTS.md §3.9 "Makeover"; the rules are in ./berserk-look.ts, the feature
 * that drives it is world/features/berserk.ts):
 *
 * - **The fire outline**: a shell per drawn mesh of the character (body parts, armour, the weapon, the hwan hair), sharing
 *   its geometry and its skeleton, so the custom skinning and animation path (CharacterActor's clips, the part merge,
 *   the animation LOD, the Volume skin patch) is exactly the character's. It is drawn with one StandardMaterial and a
 *   material plugin (SroBerserkShell): the vertices pushed out along their normals before skinning, both faces drawn
 *   additively with a rim (fresnel) term, so the back faces make a halo outside the silhouette and the front faces a hot
 *   rim inside it. Babylon's HighlightLayer is not used: it missed the skinned body parts. The shells are not parented
 *   into the actor (the shadow casters and the renderer's character roots walk that tree): each one takes its source's
 *   world matrix by reference.
 * - **Afterimages**: a few ghost rigs per character, each a clone of the skeleton (unlinked from the animated joints)
 *   and ghost meshes on the same geometry; a ghost takes a snapshot of the pose and fades out.
 * - **The shared pool** (one per scene, refcounted by the looks): the embers and heat wisps (one particle system each for
 *   every berserk character: emitters are picked per particle), the dust and steam bursts, and the ground decals and
 *   eyes as thin instances (one draw each): the shockwave rings, the burning footsteps, the fire ring under the feet and
 *   the glowing eyes. The textures are made in code (RGBA bytes). The pool disposes everything once no look uses it
 *   and its last ring, footstep and particle are gone.
 */
import {
  Color3,
  Color4,
  Constants,
  Material,
  MaterialPluginBase,
  Matrix,
  Mesh,
  ParticleSystem,
  Quaternion,
  RawTexture,
  ShaderLanguage,
  StandardMaterial,
  Texture,
  Vector3,
  VertexData,
  type AbstractEngine,
  type AbstractMesh,
  type MaterialDefines,
  type Node,
  type Observer,
  type Particle,
  type Scene,
  type Skeleton,
  type SubMesh,
  type TransformNode,
  type UniformBuffer,
} from '@babylonjs/core'
import { mergeSkinnedParts } from '../../three/models.ts'
import { displayEmissive, displayScale } from '../display-tone.ts'
import {
  EYE_LIFT,
  GHOST_ALPHA,
  GHOST_EVERY_MS,
  GHOST_LIFE_MS,
  SHELL_CORE,
  SHELL_EDGE,
  SHELL_INNER,
  SHELL_INNER_GAIN,
  SHELL_POWER,
  eyeFacing,
  hash01,
  ringTexture,
  shellWidth,
  sigilTexture,
  softDotTexture,
  stepTexture,
  type MakeoverParts,
} from './berserk-look.ts'

// ---- the shell material ----------------------------------------------------------------------------------------------

export const SHELL_PLUGIN = 'SroBerserkShell'

/** What one shell (or ghost) mesh draws: read per draw by the plugin. */
export interface ShellParams {
  /** Extrusion along the normal (m, before skinning). */
  width: number
  /** Rim power (higher = thinner rim). */
  power: number
  /** Opacity of the rim, and of the whole surface (fill: the afterimages' body). */
  alpha: number
  fill: number
  /** Linear colours at the rim (edge) and inside (core). */
  edge: readonly [number, number, number]
  core: readonly [number, number, number]
  /**
   * The faces towards the camera (the rim over the body) take power × `inner` and × `innerGain`; the faces away from it
   * make the halo outside the silhouette at the plain power.
   */
  inner: number
  innerGain: number
}

const SHELL_PARAMS = new WeakMap<AbstractMesh, ShellParams>()

const VERTEX_GLSL = `
#ifdef NORMAL
positionUpdated += normalUpdated * sroShellA.x;
#endif
`
const VERTEX_WGSL = `
#ifdef NORMAL
positionUpdated = positionUpdated + normalUpdated * uniforms.sroShellA.x;
#endif
`
const FRAGMENT_GLSL = `
{
  float shD = dot(normalW, viewDirectionW);
  float shR = clamp(1.0 - abs(shD), 0.0, 1.0);
  float shK = shD > 0.0 ? pow(shR, sroShellA.y * sroShellE.w) * sroShellC.w : pow(shR, sroShellA.y);
  vec3 shC = mix(sroShellC.rgb, sroShellE.rgb, clamp(shK, 0.0, 1.0));
  color = vec4(shC, clamp(shK * sroShellA.z + sroShellA.w, 0.0, 1.0));
}
`
const FRAGMENT_WGSL = `
{
  let shD = dot(normalW, viewDirectionW);
  let shR = clamp(1.0 - abs(shD), 0.0, 1.0);
  let shK = select(pow(shR, uniforms.sroShellA.y), pow(shR, uniforms.sroShellA.y * uniforms.sroShellE.w) * uniforms.sroShellC.w, shD > 0.0);
  let shC = mix(uniforms.sroShellC.rgb, uniforms.sroShellE.rgb, clamp(shK, 0.0, 1.0));
  color = vec4f(shC, clamp(shK * uniforms.sroShellA.z + uniforms.sroShellA.w, 0.0, 1.0));
}
`

/** The shader injections per language (tests read them). */
export function shellCode(lang: 'glsl' | 'wgsl', stage: 'vertex' | 'fragment'): Record<string, string> {
  if (stage === 'vertex') return { CUSTOM_VERTEX_UPDATE_POSITION: lang === 'wgsl' ? VERTEX_WGSL : VERTEX_GLSL }
  return { CUSTOM_FRAGMENT_BEFORE_FOG: lang === 'wgsl' ? FRAGMENT_WGSL : FRAGMENT_GLSL }
}

const SHELL_UNIFORMS = ['sroShellA', 'sroShellE', 'sroShellC'] as const

/** The shell plugin on the pool's one material: per-draw values from the drawn mesh's ShellParams. */
export class ShellPlugin extends MaterialPluginBase {
  constructor(material: Material, private readonly colorScale: () => number) {
    super(material, SHELL_PLUGIN, 400, { SROSHELL: true }, true, false)
    this.registerForExtraEvents = true
    this._enable(true)
  }

  override getClassName(): string {
    return SHELL_PLUGIN
  }

  override isCompatible(): boolean {
    return true
  }

  /** The rim needs the normals even though the material is unlit. */
  override prepareDefinesBeforeAttributes(defines: MaterialDefines): void {
    ;(defines as MaterialDefines & { _needNormals: boolean })._needNormals = true
  }

  override getUniforms(shaderLanguage?: ShaderLanguage): { ubo: Array<{ name: string; size: number; type: string }>; vertex: string; fragment: string } {
    const glsl = shaderLanguage !== ShaderLanguage.WGSL
    return {
      ubo: SHELL_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' })),
      vertex: glsl ? 'uniform vec4 sroShellA;' : '',
      fragment: glsl ? SHELL_UNIFORMS.map(n => `uniform vec4 ${n};`).join('\n') : '',
    }
  }

  override hardBindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const p = SHELL_PARAMS.get(subMesh.getMesh())
    if (!p) {
      ubo.updateFloat4('sroShellA', 0, 1, 0, 0)
      return
    }
    const k = this.colorScale()
    ubo.updateFloat4('sroShellA', p.width, p.power, p.alpha, p.fill)
    ubo.updateFloat4('sroShellE', p.edge[0] * k, p.edge[1] * k, p.edge[2] * k, p.inner)
    ubo.updateFloat4('sroShellC', p.core[0] * k, p.core[1] * k, p.core[2] * k, p.innerGain)
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    const lang = shaderLanguage === ShaderLanguage.WGSL ? 'wgsl' : 'glsl'
    if (shaderType === 'vertex') return shellCode(lang, 'vertex')
    if (shaderType === 'fragment') return shellCode(lang, 'fragment')
    return null
  }
}

function makeShellMaterial(scene: Scene, colorScale: () => number): StandardMaterial {
  const m = new StandardMaterial('bz:shell', scene)
  m.disableLighting = true
  m.diffuseColor.set(0, 0, 0)
  m.specularColor.set(0, 0, 0)
  m.emissiveColor.set(0, 0, 0)
  m.ambientColor.set(0, 0, 0)
  m.fogEnabled = false
  m.alpha = 0.999
  m.transparencyMode = Material.MATERIAL_ALPHABLEND
  m.alphaMode = Constants.ALPHA_ADD
  m.disableDepthWrite = true
  m.backFaceCulling = false
  new ShellPlugin(m, colorScale)
  return m
}

// ---- thin-instanced decals ---------------------------------------------------------------------------------------------

interface DecalInstance {
  x: number
  y: number
  z: number
  yaw: number
  sx: number
  sz: number
  r: number
  g: number
  b: number
  a: number
}

/** One texture's quads (ground decals, or camera-facing for the eyes), as thin instances of one mesh: one draw. */
class Decals {
  readonly mesh: Mesh
  readonly material: StandardMaterial
  private capacity = 0
  private matrices = new Float32Array(0)
  private colors = new Float32Array(0)
  readonly list: DecalInstance[] = []

  constructor(scene: Scene, name: string, texture: Texture, private readonly facing: 'ground' | 'camera', blend: number, private readonly lift = 0) {
    this.mesh = new Mesh(`bz:${name}`, scene)
    const vd = new VertexData()
    vd.positions = facing === 'ground' ? [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5] : [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]
    vd.normals = facing === 'ground' ? [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0] : [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]
    vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1]
    vd.indices = [0, 2, 1, 0, 3, 2]
    vd.applyToMesh(this.mesh)
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.hasVertexAlpha = true
    this.mesh.receiveShadows = false
    this.mesh.isVisible = false
    const m = new StandardMaterial(`bz:${name}`, scene)
    m.disableLighting = true
    m.diffuseColor.set(1, 1, 1)
    m.specularColor.set(0, 0, 0)
    m.ambientColor.set(0, 0, 0)
    m.diffuseTexture = texture
    m.useAlphaFromDiffuseTexture = true
    m.fogEnabled = false
    m.transparencyMode = Material.MATERIAL_ALPHABLEND
    m.alphaMode = blend
    m.disableDepthWrite = true
    m.backFaceCulling = false
    if (facing === 'ground') m.zOffset = -2
    displayEmissive(m, Color3.White())
    this.material = m
    this.mesh.material = m
    this.ensure(8)
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return
    this.capacity = Math.max(n, this.capacity * 2)
    this.matrices = new Float32Array(this.capacity * 16)
    this.colors = new Float32Array(this.capacity * 4)
    this.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, false)
    this.mesh.thinInstanceSetBuffer('color', this.colors, 4, false)
  }

  /** Writes `list` to the GPU; `right`/`up`/`back` is the camera basis (camera-facing quads). */
  flush(right: Vector3, up: Vector3, back: Vector3): void {
    const n = this.list.length
    if (!n) {
      this.mesh.isVisible = false
      this.mesh.thinInstanceCount = 0
      return
    }
    this.ensure(n)
    const m = this.matrices
    const c = this.colors
    for (let i = 0; i < n; i++) {
      const d = this.list[i]!
      const o = i * 16
      if (this.facing === 'ground') {
        const cs = Math.cos(d.yaw)
        const sn = Math.sin(d.yaw)
        m[o] = cs * d.sx
        m[o + 1] = 0
        m[o + 2] = -sn * d.sx
        m[o + 3] = 0
        m[o + 4] = 0
        m[o + 5] = 1
        m[o + 6] = 0
        m[o + 7] = 0
        m[o + 8] = sn * d.sz
        m[o + 9] = 0
        m[o + 10] = cs * d.sz
        m[o + 11] = 0
      } else {
        m[o] = right.x * d.sx
        m[o + 1] = right.y * d.sx
        m[o + 2] = right.z * d.sx
        m[o + 3] = 0
        m[o + 4] = up.x * d.sz
        m[o + 5] = up.y * d.sz
        m[o + 6] = up.z * d.sz
        m[o + 7] = 0
        m[o + 8] = back.x
        m[o + 9] = back.y
        m[o + 10] = back.z
        m[o + 11] = 0
      }
      // Camera-facing quads (the eyes) come `lift` metres towards the camera, out of the face they sit on.
      const lift = this.facing === 'camera' ? this.lift : 0
      m[o + 12] = d.x + back.x * lift
      m[o + 13] = d.y + back.y * lift
      m[o + 14] = d.z + back.z * lift
      m[o + 15] = 1
      c[i * 4] = d.r
      c[i * 4 + 1] = d.g
      c[i * 4 + 2] = d.b
      c[i * 4 + 3] = d.a
    }
    this.mesh.thinInstanceCount = n
    this.mesh.thinInstanceBufferUpdated('matrix')
    this.mesh.thinInstanceBufferUpdated('color')
    this.mesh.isVisible = true
  }

  dispose(): void {
    this.mesh.dispose(false, false)
    this.material.dispose(false, false)
  }
}

// ---- the pool ------------------------------------------------------------------------------------------------------

/** An ember / wisp source: where the body stands now (feet, world) and how many per second. */
export interface EmberSource {
  feet(): Vector3 | null
  rate: number
  /** The body's height (m). */
  height: number
}

interface Timed {
  x: number
  y: number
  z: number
  yaw: number
  born: number
}

/** Ring and footprint looks. */
export const RING_MS = 650
export const RING_RADIUS = 7
export const STEP_MS = 1700
export const STEP_EVERY_MS = 300
export const MAX_STEPS = 96
/** A burst (dust, steam) waits this long at most for its particles (ms). */
export const BURST_MS = 2000

const emberColor1 = new Color4(1.4, 0.85, 0.3, 1)
const emberColor2 = new Color4(1.3, 0.45, 0.08, 1)
const emberDead = new Color4(0.5, 0.05, 0, 0)

/**
 * One per scene while any character is berserk (BerserkPool.for): the shell material, the textures, the particle
 * systems and the decal meshes every look shares. `beginFrame` / `endFrame` bracket the looks' per-frame calls.
 */
export class BerserkPool {
  readonly shellMaterial: StandardMaterial
  private readonly textures: Texture[] = []
  private readonly dot: Texture
  readonly rings: Decals
  readonly steps: Decals
  readonly sigils: Decals
  readonly eyes: Decals
  private readonly embers: ParticleSystem
  private readonly wisps: ParticleSystem
  private dust: ParticleSystem | null = null
  private steam: ParticleSystem | null = null
  private readonly emberSources: EmberSource[] = []
  private readonly wispSources: EmberSource[] = []
  private readonly bursts: { kind: 'dust' | 'steam'; x: number; y: number; z: number; left: number; born: number }[] = []
  private readonly ringList: Timed[] = []
  private readonly stepList: Timed[] = []
  private users = 0
  private colorK = 1
  private particleK = -1
  private lastBurstAt = -Infinity
  private disposed = false

  constructor(readonly scene: Scene, private readonly clock: () => number = () => performance.now()) {
    const tex = (name: string, data: Uint8Array, size: number) => {
      const t = RawTexture.CreateRGBATexture(data, size, size, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
      t.name = `bz:${name}`
      t.wrapU = Texture.CLAMP_ADDRESSMODE
      t.wrapV = Texture.CLAMP_ADDRESSMODE
      t.hasAlpha = true
      this.textures.push(t)
      return t
    }
    this.dot = tex('dot', softDotTexture(32), 32)
    this.shellMaterial = makeShellMaterial(scene, () => this.colorK)
    this.rings = new Decals(scene, 'ring', tex('ring', ringTexture(128), 128), 'ground', Constants.ALPHA_ADD)
    this.steps = new Decals(scene, 'step', tex('step', stepTexture(32), 32), 'ground', Constants.ALPHA_ADD)
    this.sigils = new Decals(scene, 'sigil', tex('sigil', sigilTexture(128), 128), 'ground', Constants.ALPHA_ADD)
    this.eyes = new Decals(scene, 'eyes', this.dot, 'camera', Constants.ALPHA_ADD, EYE_LIFT)
    this.embers = this.particles('embers', 700, ParticleSystem.BLENDMODE_ADD)
    this.embers.minSize = 0.035
    this.embers.maxSize = 0.085
    this.embers.minLifeTime = 0.7
    this.embers.maxLifeTime = 1.5
    this.embers.minEmitPower = 0.25
    this.embers.maxEmitPower = 0.8
    this.embers.gravity = new Vector3(0, 0.9, 0)
    this.embers.minAngularSpeed = -2
    this.embers.maxAngularSpeed = 2
    this.feed(this.embers, this.emberSources, (s, p) => {
      const a = Math.random() * Math.PI * 2
      const r = 0.18 + Math.random() * 0.32
      p.set(s.x + Math.cos(a) * r, s.y + 0.1 + Math.random() * s.h * 0.95, s.z + Math.sin(a) * r)
    })
    this.wisps = this.particles('heat', 160, ParticleSystem.BLENDMODE_ADD)
    this.wisps.minSize = 0.35
    this.wisps.maxSize = 0.75
    this.wisps.minLifeTime = 0.9
    this.wisps.maxLifeTime = 1.6
    this.wisps.minEmitPower = 0.3
    this.wisps.maxEmitPower = 0.6
    this.wisps.gravity = new Vector3(0, 0.35, 0)
    this.wisps.minAngularSpeed = -0.8
    this.wisps.maxAngularSpeed = 0.8
    this.feed(this.wisps, this.wispSources, (s, p) => {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * 0.3
      p.set(s.x + Math.cos(a) * r, s.y + 0.2 + Math.random() * s.h * 0.7, s.z + Math.sin(a) * r)
    })
    this.applyParticleColors()
  }

  private particles(name: string, capacity: number, blend: number): ParticleSystem {
    const ps = new ParticleSystem(`bz:${name}`, capacity, this.scene)
    ps.particleTexture = this.dot
    ps.emitter = Vector3.Zero()
    ps.blendMode = blend
    ps.emitRate = 0
    ps.isLocal = false
    ps.updateSpeed = 1 / 60
    ps.start()
    return ps
  }

  /** Particles of `ps` start at a source picked by its rate; the direction is mostly up. */
  private feed(ps: ParticleSystem, sources: EmberSource[], at: (s: { x: number; y: number; z: number; h: number }, p: Vector3) => void): void {
    const pick = { x: 0, y: 0, z: 0, h: 1.8 }
    ps.startPositionFunction = (_w: Matrix, pos: Vector3, _p: Particle) => {
      let total = 0
      for (const s of sources) total += s.rate
      let r = Math.random() * total
      let src: EmberSource | undefined
      for (const s of sources) {
        r -= s.rate
        if (r <= 0) {
          src = s
          break
        }
      }
      const f = (src ?? sources[0])?.feet()
      if (!f) {
        pos.set(0, -1e4, 0)
        return
      }
      pick.x = f.x
      pick.y = f.y
      pick.z = f.z
      pick.h = src?.height ?? 1.8
      at(pick, pos)
    }
    ps.startDirectionFunction = (_w: Matrix, dir: Vector3) => {
      dir.set((Math.random() - 0.5) * 0.5, 0.6 + Math.random() * 0.6, (Math.random() - 0.5) * 0.5)
    }
  }

  private applyParticleColors(): void {
    const k = displayScale(this.scene)
    if (k === this.particleK) return
    this.particleK = k
    const scaled = (c: Color4) => new Color4(c.r * k, c.g * k, c.b * k, c.a)
    this.embers.color1 = scaled(emberColor1)
    this.embers.color2 = scaled(emberColor2)
    this.embers.colorDead = emberDead
    this.wisps.color1 = new Color4(0.55 * k, 0.16 * k, 0.04 * k, 0.07)
    this.wisps.color2 = new Color4(0.4 * k, 0.08 * k, 0.02 * k, 0.05)
    this.wisps.colorDead = new Color4(0, 0, 0, 0)
  }

  // -- users ---------------------------------------------------------------------------------------------------------

  acquire(): void {
    this.users++
  }

  release(): void {
    this.users = Math.max(0, this.users - 1)
  }

  /** No look uses it and nothing it drew is still alive (rings, footsteps, particles, bursts). */
  get idle(): boolean {
    if (this.users > 0 || this.ringList.length || this.stepList.length || this.bursts.length) return false
    if (this.clock() - this.lastBurstAt < 3500) return false
    return this.embers.getActiveCount() === 0 && this.wisps.getActiveCount() === 0
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  // -- per frame -----------------------------------------------------------------------------------------------------

  /** Clears the per-frame lists (eyes, fire rings, emitters); the looks fill them, then endFrame draws. */
  beginFrame(): void {
    this.eyes.list.length = 0
    this.sigils.list.length = 0
    this.emberSources.length = 0
    this.wispSources.length = 0
  }

  addEmbers(src: EmberSource): void {
    if (src.rate > 0) this.emberSources.push(src)
  }

  addHeat(src: EmberSource): void {
    if (src.rate > 0) this.wispSources.push(src)
  }

  addEye(p: Vector3, size: number, a: number): void {
    this.eyes.list.push({ x: p.x, y: p.y, z: p.z, yaw: 0, sx: size * 1.6, sz: size, r: 1, g: 0.55 + 0.3 * a, b: 0.15, a: Math.min(1, a) })
  }

  addSigil(p: Vector3, yaw: number, radius: number, a: number): void {
    this.sigils.list.push({ x: p.x, y: p.y + 0.03, z: p.z, yaw, sx: radius * 2, sz: radius * 2, r: 1, g: 0.3, b: 0.08, a: Math.min(1, a) })
  }

  ring(p: Vector3): void {
    this.ringList.push({ x: p.x, y: p.y + 0.05, z: p.z, yaw: Math.random() * Math.PI * 2, born: this.clock() })
  }

  step(p: Vector3, yaw: number): void {
    this.stepList.push({ x: p.x, y: p.y + 0.025, z: p.z, yaw, born: this.clock() })
    if (this.stepList.length > MAX_STEPS) this.stepList.shift()
  }

  burst(kind: 'dust' | 'steam', p: Vector3, count: number): void {
    if (count <= 0) return
    const ps = kind === 'dust' ? (this.dust ??= this.makeDust()) : (this.steam ??= this.makeSteam())
    this.bursts.push({ kind, x: p.x, y: p.y, z: p.z, left: count, born: this.clock() })
    ps.manualEmitCount = (ps.manualEmitCount > 0 ? ps.manualEmitCount : 0) + count
    this.lastBurstAt = this.clock()
  }

  private nextBurst(kind: 'dust' | 'steam'): { x: number; y: number; z: number } | null {
    const b = this.bursts.find(x => x.kind === kind)
    if (!b) return null
    if (--b.left <= 0) this.bursts.splice(this.bursts.indexOf(b), 1)
    return b
  }

  private makeDust(): ParticleSystem {
    const ps = this.particles('dust', 220, ParticleSystem.BLENDMODE_STANDARD)
    ps.minSize = 0.12
    ps.maxSize = 0.45
    ps.minLifeTime = 0.6
    ps.maxLifeTime = 1.4
    ps.minEmitPower = 2.5
    ps.maxEmitPower = 5.5
    ps.gravity = new Vector3(0, -2.5, 0)
    ps.minAngularSpeed = -6
    ps.maxAngularSpeed = 6
    ps.color1 = new Color4(0.62, 0.52, 0.38, 0.7)
    ps.color2 = new Color4(0.42, 0.46, 0.2, 0.85)
    ps.colorDead = new Color4(0.4, 0.34, 0.25, 0)
    ps.startPositionFunction = (_w: Matrix, pos: Vector3) => {
      const b = this.nextBurst('dust')
      const a = Math.random() * Math.PI * 2
      const r = 0.4 + Math.random() * 0.8
      if (b) pos.set(b.x + Math.cos(a) * r, b.y + 0.05, b.z + Math.sin(a) * r)
      else pos.set(0, -1e4, 0)
    }
    ps.startDirectionFunction = (_w: Matrix, dir: Vector3, p: Particle) => {
      const dx = p.position.x
      const dz = p.position.z
      // Outward from the burst centre (the last burst asked: bursts are rare), and up.
      const b = this.bursts[this.bursts.length - 1]
      const ox = b ? dx - b.x : Math.random() - 0.5
      const oz = b ? dz - b.z : Math.random() - 0.5
      const l = Math.hypot(ox, oz) || 1
      dir.set(ox / l, 0.35 + Math.random() * 0.6, oz / l)
    }
    return ps
  }

  private makeSteam(): ParticleSystem {
    const ps = this.particles('steam', 160, ParticleSystem.BLENDMODE_STANDARD)
    ps.minSize = 0.3
    ps.maxSize = 0.8
    ps.minLifeTime = 0.9
    ps.maxLifeTime = 1.8
    ps.minEmitPower = 0.5
    ps.maxEmitPower = 1.4
    ps.gravity = new Vector3(0, 0.8, 0)
    ps.minAngularSpeed = -1
    ps.maxAngularSpeed = 1
    ps.color1 = new Color4(0.92, 0.9, 0.88, 0.5)
    ps.color2 = new Color4(0.8, 0.78, 0.76, 0.38)
    ps.colorDead = new Color4(0.85, 0.85, 0.85, 0)
    ps.addSizeGradient(0, 0.5)
    ps.addSizeGradient(1, 1.6)
    ps.startPositionFunction = (_w: Matrix, pos: Vector3) => {
      const b = this.nextBurst('steam')
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * 0.35
      if (b) pos.set(b.x + Math.cos(a) * r, b.y + 0.4 + Math.random() * 1.3, b.z + Math.sin(a) * r)
      else pos.set(0, -1e4, 0)
    }
    ps.startDirectionFunction = (_w: Matrix, dir: Vector3) => {
      dir.set((Math.random() - 0.5) * 1.2, 0.5 + Math.random(), (Math.random() - 0.5) * 1.2)
    }
    return ps
  }

  /** Draws this frame: the decals' instances, the transient rings and footsteps, the emitters' rates. */
  endFrame(): void {
    this.colorK = displayScale(this.scene)
    this.applyParticleColors()
    let rate = 0
    for (const s of this.emberSources) rate += s.rate
    this.embers.emitRate = rate
    rate = 0
    for (const s of this.wispSources) rate += s.rate
    this.wisps.emitRate = rate
    const now = this.clock()
    // A burst the particle system never took (not ready yet, or a hidden tab) is dropped after a while.
    for (let i = this.bursts.length - 1; i >= 0; i--) if (now - this.bursts[i]!.born > BURST_MS) this.bursts.splice(i, 1)
    this.rings.list.length = 0
    for (let i = this.ringList.length - 1; i >= 0; i--) {
      const r = this.ringList[i]!
      const u = (now - r.born) / RING_MS
      if (u >= 1) {
        this.ringList.splice(i, 1)
        continue
      }
      const e = 1 - (1 - u) ** 3
      const d = (0.4 + RING_RADIUS * e) * 2
      this.rings.list.push({ x: r.x, y: r.y, z: r.z, yaw: r.yaw, sx: d, sz: d, r: 1, g: 0.62, b: 0.22, a: (1 - u) ** 1.3 })
    }
    this.steps.list.length = 0
    for (let i = this.stepList.length - 1; i >= 0; i--) {
      const s = this.stepList[i]!
      const u = (now - s.born) / STEP_MS
      if (u >= 1) {
        this.stepList.splice(i, 1)
        continue
      }
      // Glows white-gold for a moment, then cools to a dull red and fades.
      const hot = Math.max(0, 1 - u * 4)
      this.steps.list.push({ x: s.x, y: s.y, z: s.z, yaw: s.yaw, sx: 0.16, sz: 0.3, r: 1, g: 0.3 + 0.5 * hot, b: 0.06 + 0.3 * hot, a: (1 - u) ** 1.5 })
    }
    const cam = this.scene.activeCamera
    const right = new Vector3(1, 0, 0)
    const up = new Vector3(0, 1, 0)
    const back = new Vector3(0, 0, 1)
    if (cam) {
      const w = cam.getWorldMatrix().m
      right.set(w[0]!, w[1]!, w[2]!).normalize()
      up.set(w[4]!, w[5]!, w[6]!).normalize()
      Vector3.CrossToRef(right, up, back)
    }
    this.rings.flush(right, up, back)
    this.steps.flush(right, up, back)
    this.sigils.flush(right, up, back)
    this.eyes.flush(right, up, back)
  }

  /** What the pool holds now (tests, the perf readout). */
  stats(): { users: number; rings: number; steps: number; eyes: number; sigils: number; embers: number; wisps: number } {
    return {
      users: this.users,
      rings: this.ringList.length,
      steps: this.stepList.length,
      eyes: this.eyes.list.length,
      sigils: this.sigils.list.length,
      embers: this.embers.getActiveCount(),
      wisps: this.wisps.getActiveCount(),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const ps of [this.embers, this.wisps, this.dust, this.steam]) ps?.dispose(false)
    for (const d of [this.rings, this.steps, this.sigils, this.eyes]) d.dispose()
    this.shellMaterial.dispose(false, false)
    for (const t of this.textures) t.dispose()
    this.textures.length = 0
    this.ringList.length = 0
    this.stepList.length = 0
    this.bursts.length = 0
  }
}

// ---- one character -------------------------------------------------------------------------------------------------

/** The slice of CharacterActor the makeover reads (tests pass a small fake on a NullEngine scene). */
export interface MakeoverActor {
  readonly skeleton: Skeleton | null
  readonly isDisposed: boolean
  readonly mergeVersion: number
  /** Out of the main camera's view at the last cull (its outline is not drawn). */
  readonly isOffscreen?: boolean
  allMeshes(): AbstractMesh[]
  joint(name: string): TransformNode | undefined
}

/** The berserk character as the makeover sees it. */
export interface MakeoverSubject {
  readonly actor: MakeoverActor | null
  /** Feet position in the world now. */
  feet(): Vector3
  readonly yaw: number
  readonly moving: boolean
  /** An attack or skill clip plays (afterimages while swinging). */
  swinging(): boolean
  /** The body's height (m, scaled). */
  height(): number
  /** Extra meshes that get an outline (the hwan hair). */
  extraMeshes?(): AbstractMesh[]
}

const HEAD = 'Bip01 Head'
const FEET = ['Bip01 L Foot', 'Bip01 R Foot'] as const
/** Eyes in the bind pose relative to the head joint (glTF metres: x to the side, y up, z forward). */
export const EYE_OFFSET = { side: 0.034, up: 0.08, fwd: 0.09 }
/** How often the shells look for new or gone meshes (ms): a re-dress, the part merge. */
const SCAN_MS = 400
/** Afterimage rigs a character no longer gets (its rank moved past the cap) are kept hidden this long first (ms). */
const GHOST_KEEP_MS = 2500

/** A mesh that can carry an outline (drawn, with geometry, not alpha-blended). */
export function shellable(m: AbstractMesh): m is Mesh {
  if (!(m instanceof Mesh) || m.isDisposed() || !m.isEnabled() || !m.isVisible || m.visibility <= 0) return false
  if (!m.geometry || m.getTotalVertices() <= 0 || m.hasThinInstances || m.name.startsWith('bz:')) return false
  const mat = m.material
  // Alpha-tested skins (the body) are fine: the shell is the mesh, not its texture. Blended ones (veils) are not.
  return !mat || !mat.needAlphaBlending()
}

interface Shell {
  mesh: Mesh
  /** What it outlines: one mesh, or a group of skinned parts merged into one shell (one draw). */
  sources: Mesh[]
  offs: Observer<Node>[]
}

/** The vertex layout of a mesh (parts that share it, the skeleton and the transform can share one merged shell). */
function layoutKey(m: Mesh): string {
  const kinds = m.getVerticesDataKinds().slice().sort()
  const vbs = kinds.map(k => {
    const vb = m.getVertexBuffer(k)
    return vb ? `${k}:${vb.type}:${vb.normalized}:${vb.byteStride}:${vb.getSize()}` : k
  })
  const q = m.rotationQuaternion
  return [m.parent?.uniqueId ?? -1, m.numBoneInfluencers, m.position.asArray().join(','), q ? q.asArray().join(',') : m.rotation.asArray().join(','), m.scaling.asArray().join(','), ...vbs].join('|')
}

/**
 * The outline groups of the drawn meshes: the skinned parts on `skeleton` with the same layout together (one merged shell
 * each: a body is 6-8 parts), every other mesh on its own (the weapon, the hwan hair).
 */
export function shellGroups(meshes: readonly Mesh[], skeleton: Skeleton | null): Mesh[][] {
  const groups = new Map<string, Mesh[]>()
  const out: Mesh[][] = []
  for (const m of meshes) {
    if (!skeleton || m.skeleton !== skeleton || m.subMeshes?.length !== 1) {
      out.push([m])
      continue
    }
    const k = layoutKey(m)
    const g = groups.get(k)
    if (g) g.push(m)
    else groups.set(k, [m])
  }
  return [...groups.values(), ...out]
}


/** A snapshot of the pose that fades out. */
class Ghost {
  readonly skeleton: Skeleton
  meshes: { mesh: Mesh; world: Matrix; src: Mesh }[] = []
  readonly params: ShellParams = { width: 0.004, power: 1.3, alpha: 0, fill: 0, edge: [1, 0.55, 0.15], core: [0.9, 0.12, 0.02], inner: 1, innerGain: 1 }
  born = -Infinity

  constructor(live: Skeleton, name: string) {
    this.skeleton = live.clone(name)
    for (const b of this.skeleton.bones) b.linkTransformNode(null)
  }

  /** Ghost meshes for the sources (the skinned ones on the live skeleton, and the static ones). */
  build(scene: Scene, sources: readonly Mesh[], live: Skeleton, material: Material): void {
    this.clear()
    for (const src of sources) {
      if (src.skeleton && src.skeleton !== live) continue
      const g = new Mesh(`bz:ghost:${src.name}`, scene)
      src.geometry!.applyToMesh(g)
      if (src.skeleton) {
        g.skeleton = this.skeleton
        g.numBoneInfluencers = src.numBoneInfluencers
      }
      g.material = material
      g.isPickable = false
      g.receiveShadows = false
      g.alwaysSelectAsActiveMesh = true
      g.setEnabled(false)
      const world = new Matrix()
      g.freezeWorldMatrix(world)
      SHELL_PARAMS.set(g, this.params)
      this.meshes.push({ mesh: g, world, src })
    }
  }

  /** Takes the live pose and places the copy where the character stands now. */
  snap(live: Skeleton, now: number): void {
    const bones = this.skeleton.bones
    live.bones.forEach((lb, i) => {
      const gb = bones[i]
      if (!gb) return
      const tn = lb.getTransformNode()
      if (tn) {
        gb.position = tn.position
        gb.rotationQuaternion = tn.rotationQuaternion ?? Quaternion.FromEulerVector(tn.rotation)
        gb.scaling = tn.scaling
      } else {
        gb.getLocalMatrix().copyFrom(lb.getLocalMatrix())
        gb.markAsDirty()
      }
    })
    for (const g of this.meshes) {
      g.world.copyFrom(g.src.getWorldMatrix())
      g.mesh.freezeWorldMatrix(g.world)
      g.mesh.setEnabled(true)
    }
    this.born = now
  }

  /** Fades; false once it is out (its meshes hidden). */
  fade(now: number): boolean {
    const u = (now - this.born) / GHOST_LIFE_MS
    if (u >= 1 || u < 0) {
      for (const g of this.meshes) g.mesh.setEnabled(false)
      this.params.alpha = 0
      return false
    }
    const k = (1 - u) ** 1.6
    this.params.alpha = GHOST_ALPHA * k
    this.params.fill = 0.14 * k
    return true
  }

  clear(): void {
    for (const g of this.meshes) g.mesh.dispose(false, false)
    this.meshes = []
  }

  dispose(): void {
    this.clear()
    this.skeleton.dispose()
  }
}

/**
 * One berserk character's makeover: outline shells, afterimages, eyes, footsteps, the fire ring under it and its embers
 * (through the pool). `update` every frame with the parts the tier and split allow; `end` / `dispose` remove it all.
 */
export class BerserkMakeover {
  private readonly shells = new Map<string, Shell>()
  private readonly params: ShellParams = { width: 0.03, power: SHELL_POWER, alpha: 0, fill: 0, edge: SHELL_EDGE, core: SHELL_CORE, inner: SHELL_INNER, innerGain: SHELL_INNER_GAIN }
  private scanAt = -Infinity
  private mergeSeen = -1
  private actorSeen: MakeoverActor | null = null
  private ghosts: Ghost[] = []
  private ghostAt = -Infinity
  private ghostKey = ''
  private ghostsOffAt: number | null = null
  private extrasSeen = false
  private stepAt = -Infinity
  private stepFoot = 0
  private disposed = false
  private readonly seed: number
  private readonly tmp = new Vector3()
  private readonly emberSrc: EmberSource
  private readonly heatSrc: EmberSource

  constructor(private readonly pool: BerserkPool, private readonly subject: MakeoverSubject, seed: number) {
    pool.acquire()
    this.seed = seed
    const feet = () => this.subject.feet()
    this.emberSrc = { feet, rate: 0, height: 1.8 }
    this.heatSrc = { feet, rate: 0, height: 1.8 }
  }

  /** The start moment (everyone): the shockwave ring and, by tier, the dust and leaves. */
  start(parts: MakeoverParts): void {
    if (this.disposed) return
    const p = this.subject.feet()
    if (parts.ring) this.pool.ring(p)
    if (parts.dust) this.pool.burst('dust', p, 70)
  }

  /** Per frame (`now` in ms of the feature's clock): `level` is the outline strength (berserk-look glowLevel). */
  update(now: number, level: number, parts: MakeoverParts): void {
    if (this.disposed) return
    const actor = this.subject.actor
    if (!actor || actor.isDisposed) {
      this.clearShells()
      this.clearGhosts()
      return
    }
    // Outline.
    if (parts.outline) {
      // Scans are spread over the looks (seed), so twenty berserk players do not all scan in one frame.
      if (actor !== this.actorSeen || actor.mergeVersion !== this.mergeSeen || parts.outlineExtras !== this.extrasSeen || now - this.scanAt > SCAN_MS * (1 + this.seed * 0.5)) this.scan(actor, now, parts.outlineExtras)
      this.params.width = shellWidth(level)
      this.params.alpha = Math.min(1.25, level) * 0.95
      this.params.power = SHELL_POWER
      // Shells are always selected (their world matrix is their source's, by reference: no bounds to keep) and are
      // switched off with an actor out of view (CharacterActor.isOffscreen). Additive: no sort order to keep either.
      const off = actor.isOffscreen === true
      for (const s of this.shells.values()) s.mesh.setEnabled(!off && s.sources.some(src => src.isEnabled() && src.isVisible))
    } else this.clearShells()
    const h = this.subject.height()
    const feet = this.subject.feet()
    // Embers and heat.
    this.emberSrc.rate = parts.embers * Math.max(0.3, level)
    this.emberSrc.height = h
    this.pool.addEmbers(this.emberSrc)
    if (parts.heat) {
      this.heatSrc.rate = 5 * Math.max(0.3, level)
      this.heatSrc.height = h
      this.pool.addHeat(this.heatSrc)
    }
    // The fire ring under the feet, pulsing with the outline.
    if (parts.aura) this.pool.addSigil(feet, now * 0.0004 + this.seed, 0.95 + 0.12 * level, 0.35 + 0.4 * Math.min(1, level))
    if (parts.eyes) this.eyes(actor, level)
    if (parts.footsteps && this.subject.moving) this.footsteps(actor, now)
    this.afterimages(actor, now, parts.afterimages)
  }

  private scan(actor: MakeoverActor, now: number, extras: boolean): void {
    this.scanAt = now
    this.mergeSeen = actor.mergeVersion
    this.actorSeen = actor
    this.extrasSeen = extras
    const want: Mesh[] = []
    // Far others (no extras): the skinned body only, merged (1-2 draws); near ones and yourself: the weapon and the hwan hair too.
    const body = actor.skeleton
    for (const m of [...actor.allMeshes(), ...(extras ? (this.subject.extraMeshes?.() ?? []) : [])]) if (shellable(m) && (extras || (body && m.skeleton === body)) && !want.includes(m)) want.push(m)
    const groups = new Map(shellGroups(want, actor.skeleton).map(g => [g.map(m => m.uniqueId).join(','), g] as const))
    for (const [k, sh] of [...this.shells]) if (!groups.has(k) || sh.sources.some(x => x.isDisposed())) this.dropShell(k)
    for (const [k, g] of groups) {
      if (this.shells.has(k)) continue
      if (g.length > 1) {
        // One draw for the group; a group whose buffers cannot merge gets a shell per part.
        const merged = mergeSkinnedParts(g)
        if (merged) {
          this.addShell(k, merged, g)
          continue
        }
        for (const m of g) if (!this.shells.has(String(m.uniqueId))) this.addShell(String(m.uniqueId), this.shellOf(m), [m])
        continue
      }
      this.addShell(k, this.shellOf(g[0]!), g)
    }
  }

  /** A shell on `src`'s own geometry. */
  private shellOf(src: Mesh): Mesh {
    const s = new Mesh(`bz:shell:${src.name}`, src.getScene())
    src.geometry!.applyToMesh(s)
    s.skeleton = src.skeleton
    s.numBoneInfluencers = src.numBoneInfluencers
    return s
  }

  private addShell(key: string, s: Mesh, sources: Mesh[]): void {
    const src = sources[0]!
    s.name = sources.length > 1 ? `bz:shell:${src.name}+${sources.length - 1}` : `bz:shell:${src.name}`
    // Outside the actor's tree (the shadow casters and the renderer's character roots walk it): the source's world
    // matrix by reference (a merged group's parts share one parent and transform).
    s.parent = null
    s.material = this.pool.shellMaterial
    s.isPickable = false
    s.receiveShadows = false
    s.renderingGroupId = src.renderingGroupId
    s.layerMask = src.layerMask
    s.alwaysSelectAsActiveMesh = true
    s.freezeWorldMatrix(src.getWorldMatrix())
    SHELL_PARAMS.set(s, this.params)
    const offs = sources.map(m => m.onDisposeObservable.addOnce(() => this.dropShell(key)))
    this.shells.set(key, { mesh: s, sources, offs })
  }

  private dropShell(key: string): void {
    const sh = this.shells.get(key)
    if (!sh) return
    this.shells.delete(key)
    sh.sources.forEach((m, i) => m.onDisposeObservable.remove(sh.offs[i]!))
    sh.mesh.dispose(false, false)
  }

  private clearShells(): void {
    for (const k of [...this.shells.keys()]) this.dropShell(k)
    this.actorSeen = null
  }

  /** The outline meshes now (tests). */
  get shellCount(): number {
    return this.shells.size
  }

  private eyes(actor: MakeoverActor, level: number): void {
    const head = actor.joint(HEAD)
    if (!head) return
    // Placed from the head joint along the character's facing (the head's own frame carries the glTF mirror, and its
    // tilt hardly shows on two glows): EYE_OFFSET × the body's scale, then lifted towards the camera (EYE_LIFT; the
    // hwan hair's band covers the eyes). It fades out as the face turns away, so it never floats beside the head.
    const hp = head.getAbsolutePosition()
    const fx = Math.sin(this.subject.yaw)
    const fz = Math.cos(this.subject.yaw)
    const cam = this.pool.scene.activeCamera?.globalPosition
    let facing = 1
    if (cam) {
      const dx = cam.x - hp.x
      const dz = cam.z - hp.z
      facing = eyeFacing((fx * dx + fz * dz) / (Math.hypot(dx, dz) || 1))
    }
    if (facing <= 0) return
    const k = Math.max(0.7, Math.min(1.6, this.subject.height() / 1.8))
    const o = EYE_OFFSET
    const a = Math.min(1, 0.55 + 0.45 * level) * facing
    for (const side of [-1, 1]) {
      this.tmp.set(hp.x + (fx * o.fwd + fz * side * o.side) * k, hp.y + o.up * k, hp.z + (fz * o.fwd - fx * side * o.side) * k)
      this.pool.addEye(this.tmp, 0.06 * k, a)
    }
  }


  private footsteps(actor: MakeoverActor, now: number): void {
    if (now - this.stepAt < STEP_EVERY_MS) return
    this.stepAt = now
    this.stepFoot = 1 - this.stepFoot
    const foot = actor.joint(FEET[this.stepFoot]!)
    const feet = this.subject.feet()
    if (foot) {
      const p = foot.getAbsolutePosition()
      this.tmp.set(p.x, feet.y, p.z)
    } else this.tmp.copyFrom(feet)
    this.pool.step(this.tmp, this.subject.yaw)
  }

  private afterimages(actor: MakeoverActor, now: number, slots: number): void {
    const live = actor.skeleton
    if (!slots || !live) {
      // Out of the cap (or the tier): hidden at once, the rigs kept a while (the rank of near players flickers).
      if (!this.ghosts.length) return
      if (this.ghostsOffAt === null) this.ghostsOffAt = now
      for (const g of this.ghosts) g.fade(-Infinity)
      if (!live || now - this.ghostsOffAt > GHOST_KEEP_MS) this.clearGhosts()
      return
    }
    this.ghostsOffAt = null
    let alive = false
    for (const g of this.ghosts) if (g.fade(now)) alive = true
    const active = this.subject.moving || this.subject.swinging()
    if (!active && !alive && this.ghosts.length === 0) return
    // (Re)build the rigs on a change of the drawn meshes.
    const sources = [...this.shells.values()].map(sh => sh.mesh)
    const key = `${live.uniqueId}|${sources.map(s => s.uniqueId).join(',')}`
    if (key !== this.ghostKey || this.ghosts.length !== slots) {
      this.clearGhosts()
      this.ghostKey = key
      for (let i = 0; i < slots; i++) {
        const g = new Ghost(live, `bz:ghost${i}`)
        g.build(live.getScene(), sources, live, this.pool.shellMaterial)
        this.ghosts.push(g)
      }
    }
    if (!active || now - this.ghostAt < GHOST_EVERY_MS) return
    // The oldest slot takes the new snapshot.
    let oldest = this.ghosts[0]!
    for (const g of this.ghosts) if (g.born < oldest.born) oldest = g
    oldest.snap(live, now)
    oldest.fade(now)
    this.ghostAt = now
  }

  private clearGhosts(): void {
    for (const g of this.ghosts) g.dispose()
    this.ghosts = []
    this.ghostKey = ''
    this.ghostsOffAt = null
  }

  /** Afterimage rigs now (tests). */
  get ghostCount(): number {
    return this.ghosts.length
  }

  /** A warp: what trails behind (afterimages, the next footstep) starts over at the new spot. */
  warped(): void {
    for (const g of this.ghosts) {
      g.born = -Infinity
      for (const m of g.meshes) m.mesh.setEnabled(false)
    }
    this.stepAt = -Infinity
  }

  /** The Berserk ended (`steam`: the steam puff where it stands). */
  end(steam: boolean): void {
    if (this.disposed) return
    if (steam) this.pool.burst('steam', this.subject.feet(), 46)
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearShells()
    this.clearGhosts()
    this.pool.release()
  }

  /** A per-character 0..1 value (phases of the flicker and the fire ring). */
  static seedOf(id: number): number {
    return hash01(id)
  }
}
