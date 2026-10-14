/**
 * Tassels, ribbons, banners, plumes and cords on weapons move (docs/RARITY.md §6): every degree, not only the seals.
 * The parts come from the model's own geometry at load (weapon-sway-parts.ts: the `sroSway` vertex attribute, 4 floats:
 * weight, phase, length, stiffness); a vertex plugin (SroSway, on the weapon's shared material, per-mesh define) moves
 * them in world space at CUSTOM_VERTEX_UPDATE_WORLDPOS: pinned where they hang, the free end swinging most, pushed by
 * the weather's wind (storms harder, a breeze always), fluttering, and trailing behind the weapon's own motion (a
 * damped spring per worn weapon, fed by the parts' world speed: running and swings throw them back, they swing past
 * and settle). Cost: two vec4 uniforms per draw, a few ALU per vertex of the ~4-300 vertex weapons, a spring per worn
 * weapon on the CPU; nothing for the weapons without swaying parts (no define).
 */
import {
  Matrix,
  MaterialPluginBase,
  PBRMaterial,
  ShaderLanguage,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type AssetContainer,
  type Material,
  type MaterialDefines,
  type Mesh,
  type Node,
  type Nullable,
  type Observer,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import { SWAY_KIND, subdivideParts, swayModelName, swayParts, swayStrength, type Stream, type SwayPart } from './weapon-sway-parts.ts'

/** Subdivision passes on the swaying parts (each × 4 triangles). */
export const SWAY_PASSES = 2
import { isWeaponGlb } from './weapon-solid.ts'

export const SWAY_PLUGIN = 'SroSway'
export const SWAY_UNIFORMS = ['sroSwayA', 'sroSwayB'] as const

/*
 * sroSwayA: wind dir x, z (unit), strength (0.22..1.4), time (s); sroSwayB: the inertia lag (world m per metre of part).
 * Per vertex (w the weight, 0 at the pin .. 1 at the free end; l = length / stiffness; a its phase; s the strength):
 *   gust   = 0.6 + 0.25 sin(1.3 t + a) + 0.15 sin(3.7 t + 2a)
 *   ripple = (sin((4 + 4s) t + a - 7w) + 0.45 sin((7 + 5s) t + 3a - 12w)) * (0.13 + 0.12 s) * gust   (a wave down the strip)
 *   offset = l * (normal * ripple * w^1.2 + wind * (0.12 + 0.3 s) gust * w^1.6 + up * 0.08 s gust * w^1.6) + lag * w^1.6 L
 * The ripple moves the card along its own normal, so a streamer bends and flaps like cloth (the parts are subdivided at
 * load, subdivideParts). weapon-sway-parts.ts swayOffset is the TS mirror.
 */
const VDEFS_GLSL = `
#ifdef SROSWAY
attribute vec4 ${SWAY_KIND};
#endif
`
const VDEFS_WGSL = `
#ifdef SROSWAY
attribute ${SWAY_KIND}: vec4f;
#endif
`
const WORLD_GLSL = `
#ifdef SROSWAY
{
  vec4 swV = ${SWAY_KIND};
  if (swV.x > 0.0) {
    float swW = swV.x;
    float swL = swV.z / max(0.3, swV.w);
    float swA = swV.y * 6.2831853;
    float swT = sroSwayA.w;
    float swS = sroSwayA.z;
    float swGust = 0.6 + 0.25 * sin(swT * 1.3 + swA) + 0.15 * sin(swT * 3.7 + swA * 2.0);
    // the ripple: a wave running down the strip, growing toward the free end
    float swR = (sin(swT * (4.0 + 4.0 * swS) + swA - swW * 7.0) + 0.45 * sin(swT * (7.0 + 5.0 * swS) + swA * 3.0 - swW * 12.0)) * (0.13 + 0.12 * swS) * swGust;
    vec3 swN = vec3(-sroSwayA.y, 0.0, sroSwayA.x);
#ifdef NORMAL
    swN = vNormalW;
#endif
    float swP = (0.12 + 0.3 * swS) * swGust;
    float swG = pow(swW, 1.6);
    vec3 swO = (swN * (swR * pow(swW, 1.2)) + vec3(sroSwayA.x, 0.08 * swS * swGust / max(swP, 1e-3), sroSwayA.y) * (swP * swG)) * swL;
    swO += sroSwayB.xyz * (swG * swV.z);
    worldPos.xyz += swO;
    vPositionW = worldPos.xyz;
  }
}
#endif
`
const WORLD_WGSL = `
#ifdef SROSWAY
{
  let swV = vertexInputs.${SWAY_KIND};
  if (swV.x > 0.0) {
    let swW = swV.x;
    let swL = swV.z / max(0.3, swV.w);
    let swA = swV.y * 6.2831853;
    let swT = uniforms.sroSwayA.w;
    let swS = uniforms.sroSwayA.z;
    let swGust = 0.6 + 0.25 * sin(swT * 1.3 + swA) + 0.15 * sin(swT * 3.7 + swA * 2.0);
    // the ripple: a wave running down the strip, growing toward the free end
    let swR = (sin(swT * (4.0 + 4.0 * swS) + swA - swW * 7.0) + 0.45 * sin(swT * (7.0 + 5.0 * swS) + swA * 3.0 - swW * 12.0)) * (0.13 + 0.12 * swS) * swGust;
    var swN = vec3f(-uniforms.sroSwayA.y, 0.0, uniforms.sroSwayA.x);
#ifdef NORMAL
    swN = vertexOutputs.vNormalW;
#endif
    let swP = (0.12 + 0.3 * swS) * swGust;
    let swG = pow(swW, 1.6);
    var swO = (swN * (swR * pow(swW, 1.2)) + vec3f(uniforms.sroSwayA.x, 0.08 * swS * swGust / max(swP, 1e-3), uniforms.sroSwayA.y) * (swP * swG)) * swL;
    swO = swO + uniforms.sroSwayB.xyz * (swG * swV.z);
    worldPos = vec4f(worldPos.xyz + swO, worldPos.w);
    vertexOutputs.vPositionW = worldPos.xyz;
  }
}
#endif
`

/** The injections per language (tests read them). */
export function swayCode(lang: 'glsl' | 'wgsl'): Readonly<Record<string, string>> {
  return {
    CUSTOM_VERTEX_DEFINITIONS: lang === 'wgsl' ? VDEFS_WGSL : VDEFS_GLSL,
    CUSTOM_VERTEX_UPDATE_WORLDPOS: lang === 'wgsl' ? WORLD_WGSL : WORLD_GLSL,
  }
}

/** What the plugin asks of its manager. */
export interface SwaySource {
  on(mesh: AbstractMesh): boolean
  writeUniforms(ubo: UniformBuffer, mesh: AbstractMesh): void
}

export class SwayPlugin extends MaterialPluginBase {
  constructor(material: Material, readonly source: SwaySource) {
    super(material, SWAY_PLUGIN, 320, { SROSWAY: false }, true, false)
    this._enable(true)
  }

  override getClassName(): string {
    return SWAY_PLUGIN
  }

  override isCompatible(): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines, _scene?: Scene, mesh?: AbstractMesh): void {
    const d = defines as MaterialDefines & Record<string, unknown>
    const on = !!mesh && d.INSTANCES !== true && d.THIN_INSTANCES !== true && this.source.on(mesh)
    if (d.SROSWAY !== on) {
      d.SROSWAY = on
      defines.markAsUnprocessed()
    }
  }

  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if (this.source.on(mesh) && !attributes.includes(SWAY_KIND)) attributes.push(SWAY_KIND)
  }

  override getUniforms(shaderLanguage?: ShaderLanguage): { ubo: Array<{ name: string; size: number; type: string }>; vertex: string } {
    return {
      ubo: SWAY_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' })),
      vertex: shaderLanguage === ShaderLanguage.WGSL ? '' : `#ifdef SROSWAY\n${SWAY_UNIFORMS.map(n => `uniform vec4 ${n};`).join('\n')}\n#endif`,
    }
  }

  override hardBindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const m = subMesh.getMesh()
    if (this.source.on(m)) this.source.writeUniforms(ubo, m)
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    if (shaderType !== 'vertex') return null
    return { ...swayCode(shaderLanguage === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') }
  }
}

// ---- the parts at load ------------------------------------------------------------------------------------------

/** Per geometry: the swaying parts' centroid (model space) and the parts (the lab). */
const SWAY_INFO = new WeakMap<object, { centre: Vector3; parts: SwayPart[]; model: string }>()

const tmpP = new Vector3()

/** Counts for the lab (models dressed, parts). */
export const swayStats = { models: 0, parts: 0 }

/**
 * Marks the swaying parts of a weapon glb's meshes (call once per loaded container, before it is instantiated: the
 * clones share the geometry and its attribute). Returns the number of parts.
 */
export function dressWeaponSway(container: AssetContainer, glb: string): number {
  if (!isWeaponGlb(glb) || /shield/i.test(glb)) return 0
  const model = swayModelName(glb)
  let total = 0
  for (const m of container.meshes) {
    const g = (m as { geometry?: object | null }).geometry
    if (!g || SWAY_INFO.has(g)) continue
    const raw = m.getVerticesData('position')
    const idx = m.getIndices()
    if (!raw || !idx) continue
    // into the glTF's own space (metres): the optimized glbs are quantized (a node scale and offset), and Babylon's
    // __root__ (the handedness flip) is left out so the overrides' centres match the converter's coordinates
    let root: Node = m
    while (root.parent) root = root.parent
    const toModel = m.computeWorldMatrix(true).multiply(Matrix.Invert(root.computeWorldMatrix(true)))
    const pos = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(raw[i]!, raw[i + 1]!, raw[i + 2]!, toModel, tmpP)
      pos[i] = tmpP.x
      pos[i + 1] = tmpP.y
      pos[i + 2] = tmpP.z
    }
    const r = swayParts(pos, idx, model, m.material?.name ?? '')
    if (!r.data) continue
    // the centroid back in the mesh's own space (the spring's probe)
    Vector3.TransformCoordinatesFromFloatsToRef(r.centre[0], r.centre[1], r.centre[2], Matrix.Invert(toModel), tmpP)
    r.centre[0] = tmpP.x
    r.centre[1] = tmpP.y
    r.centre[2] = tmpP.z
    // the cards bend along their length: cut their triangles (SWAY_PASSES × 4) and carry every stream with them
    const mm = m as unknown as Mesh
    const streams: Record<string, Stream> = { [SWAY_KIND]: { data: r.data, stride: 4 } }
    for (const k of mm.getVerticesDataKinds()) {
      const d = mm.getVerticesData(k)
      const vb = mm.getVertexBuffer(k)
      if (d && vb && k !== SWAY_KIND) streams[k] = { data: d, stride: vb.getSize() }
    }
    const sub = subdivideParts(streams, idx, i => r.data![i * 4 + 2]! > 0, (mm.subMeshes?.length ?? 1) <= 1 ? SWAY_PASSES : 0)
    for (const [k, d] of Object.entries(sub.streams)) mm.setVerticesData(k, new Float32Array(d), false, streams[k]!.stride)
    mm.setIndices(sub.indices)
    SWAY_INFO.set(g, { centre: new Vector3(r.centre[0], r.centre[1], r.centre[2]), parts: r.parts, model })
    total += r.parts.length
    swayStats.models++
    swayStats.parts += r.parts.length
  }
  return total
}

/** The parts of a mesh (lab). */
export function swayInfoOf(mesh: AbstractMesh): { centre: Vector3; parts: readonly SwayPart[]; model: string } | null {
  const g = (mesh as { geometry?: object | null }).geometry
  return g ? SWAY_INFO.get(g) ?? null : null
}

// ---- the wind and the springs -------------------------------------------------------------------------------------

/** The world's wind (set by the weather feature each frame): unit direction and gusts (m/s). */
const wind = { x: 0.8, z: 0.6, gustMs: 3 }

/** The lab holds a wind of its own (the weather's frames are ignored while held). */
let windHeld = false

export function setWeaponWind(x: number, z: number, gustMs: number, lab?: { hold: boolean }): void {
  if (lab) windHeld = lab.hold
  else if (windHeld) return
  const l = Math.hypot(x, z)
  if (l > 1e-4) {
    wind.x = x / l
    wind.z = z / l
  }
  wind.gustMs = Math.max(0, gustMs)
}

interface Spring {
  /** The parts' centre in world space last frame. */
  last: Vector3
  has: boolean
  /** Lag (world m per metre of part) and its velocity. */
  d: Vector3
  v: Vector3
  frame: number
}

/** Seconds of motion the parts trail by, the spring's stiffness (1/s²) and damping (1/s), the lag's cap (m/m). */
export const SWAY_LAG_S = 0.09
const K = 60
const C = 7
const LAG_MAX = 0.9

/**
 * One damped-spring step (pure, tests): the lag `d` (and its velocity `v`) follows −velocity × SWAY_LAG_S, capped.
 */
export function springStep(d: Vector3, v: Vector3, vel: Vector3, dt: number): void {
  const tx = -vel.x * SWAY_LAG_S, ty = -vel.y * SWAY_LAG_S * 0.6, tz = -vel.z * SWAY_LAG_S
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
  const h = dt / steps
  for (let i = 0; i < steps; i++) {
    v.x += (K * (tx - d.x) - C * v.x) * h
    v.y += (K * (ty - d.y) - C * v.y) * h
    v.z += (K * (tz - d.z) - C * v.z) * h
    d.x += v.x * h
    d.y += v.y * h
    d.z += v.z * h
  }
  const l = d.length()
  if (l > LAG_MAX) d.scaleInPlace(LAG_MAX / l)
}

const tmpW = new Vector3()
const tmpVel = new Vector3()

/** The scene's swaying weapons (ModelLibrary owns one per scene). */
export class WeaponSway implements SwaySource {
  private readonly plugins = new WeakMap<Material, SwayPlugin>()
  private readonly springs = new Map<AbstractMesh, Spring>()
  private readonly frameObs: Nullable<Observer<Scene>>
  private t = 0
  private last = -1
  private frameNo = 0
  private disposed = false
  /** Lab: a held clock (null: real time). */
  held: number | null = null

  constructor(readonly scene: Scene) {
    this.frameObs = scene.onBeforeRenderObservable.add(() => this.frame())
  }

  on(mesh: AbstractMesh): boolean {
    return this.springs.has(mesh)
  }

  /** Puts the plugin on the worn meshes that carry swaying parts. */
  prepare(meshes: readonly AbstractMesh[]): void {
    if (this.disposed) return
    for (const m of meshes) {
      if (!m.isVerticesDataPresent(SWAY_KIND)) continue
      const mat = m.material
      if (!(mat instanceof PBRMaterial)) continue
      if (!this.plugins.has(mat)) this.plugins.set(mat, (mat.pluginManager?.getPlugin(SWAY_PLUGIN) as SwayPlugin | null) ?? new SwayPlugin(mat, this))
      if (!this.springs.has(m)) {
        this.springs.set(m, { last: new Vector3(), has: false, d: new Vector3(), v: new Vector3(), frame: 0 })
        m.onDisposeObservable.addOnce(() => this.springs.delete(m))
        mat.markAsDirty(1)
      }
    }
  }

  get count(): number {
    return this.springs.size
  }

  writeUniforms(ubo: UniformBuffer, mesh: AbstractMesh): void {
    const s = this.springs.get(mesh)
    ubo.updateFloat4('sroSwayA', wind.x, wind.z, swayStrength(wind.gustMs), this.t % 600)
    ubo.updateFloat4('sroSwayB', s ? s.d.x : 0, s ? s.d.y : 0, s ? s.d.z : 0, 0)
  }

  private frame(): void {
    if (this.disposed || !this.springs.size) return
    const now = this.held ?? performance.now() / 1000
    const dt = this.last < 0 ? 0 : Math.min(0.1, Math.max(0, now - this.last))
    this.last = now
    this.t = now
    this.frameNo++
    for (const [m, s] of this.springs) {
      if (!m.isEnabled() || !m.isVisible) {
        s.has = false
        continue
      }
      const info = swayInfoOf(m)
      Vector3.TransformCoordinatesToRef(info?.centre ?? Vector3.ZeroReadOnly, m.getWorldMatrix(), tmpW)
      if (s.has && dt > 0) {
        tmpW.subtractToRef(s.last, tmpVel).scaleInPlace(1 / dt)
        // a teleport (warp, re-hang) is not a motion
        if (tmpVel.lengthSquared() > 900) tmpVel.setAll(0)
        springStep(s.d, s.v, tmpVel, dt)
      }
      s.last.copyFrom(tmpW)
      s.has = true
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameObs) this.scene.onBeforeRenderObservable.remove(this.frameObs)
    this.springs.clear()
  }
}

const perScene = new WeakMap<Scene, WeaponSway>()

/** The scene's sway manager (made on first use). */
export function weaponSwayFor(scene: Scene): WeaponSway {
  let s = perScene.get(scene)
  if (!s) {
    perScene.set(scene, (s = new WeaponSway(scene)))
    scene.onDisposeObservable.addOnce(() => s!.dispose())
  }
  return s
}
