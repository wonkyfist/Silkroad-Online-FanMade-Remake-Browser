/**
 * The town's dynamic dressing that is never batched (docs/TOWN_LIFE.md §2.3, §3.3, §3.5, §8.1; docs/WAVE_PLAN7.md
 * §6.1 TL-C): what follows the crowd rather than the map.
 *
 * - **Blob shadows** (Medium and the default on High: TOWN_PRESETS `shadows: 'blob'`): one soft dark disc under each
 *   drawn townsperson and animal, one thin-instanced quad multiplying the ground (ALPHA_MULTIPLY, as the decals),
 *   **one draw**, growing and shrinking with its owner's fade.
 * - **Carried lanterns**: a lantern carrier at dusk and every guard at night holds a small glowing lantern (one
 *   thin-instanced box, one draw). Its colour is display-referred (H11-NT-2): divided by the exposure the post applies,
 *   as NightLights does for the lamp glow, so it reads warm orange at a clear night's exposure (≈ 24), not white.
 *   TOWN_LIFE §7.1 (H11-NT-3): the LANTERN_LIGHTS nearest holders carry a warm point light through the night cluster
 *   (`NightLights.addDynamicLight`). The lights are made only when the cluster would take them (`canAddDynamicLight`,
 *   so none is ever drawn as a scene light: no material light-count change), once, then only moved and faded
 *   (intensity 0 by day); they are dropped when the cluster lets go of them (a preset without one) and on dispose.
 *
 * Every mesh is tagged 'town' (the batcher refuses it) and not pickable.
 */
import {
  BoundingInfo,
  Color3,
  Constants,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  RawTexture,
  StandardMaterial,
  Texture,
  Vector3,
  type Light,
  type Scene,
} from '@babylonjs/core'
import { displayToScene, sceneDisplay } from '../render/display.ts'
import { newDrawn, type CrowdAgent, type TownCrowd } from './crowd.ts'
import { TOWN_TAG } from './types.ts'

/**
 * A blob's radius per metre of the owner's height, and how much it darkens the ground at its middle (0..1; strong, since
 * the multiply works on the HDR frame before the tone map compresses a bright noon paving).
 */
export const BLOB_RADIUS_PER_M = 0.32
export const BLOB_DARK = 0.72
/** Lanterns: guards carry one between these solar times (night), carriers whenever they are out. */
export const NIGHT_FROM = 19 / 24
export const NIGHT_TO = 5 / 24

function tagged(mesh: Mesh): Mesh {
  mesh.metadata = { sroWorld: TOWN_TAG }
  mesh.isPickable = false
  mesh.doNotSyncBoundingInfo = true
  mesh.alwaysSelectAsActiveMesh = false
  mesh.isVisible = false
  mesh.freezeWorldMatrix()
  return mesh
}

/**
 * The blob's texture (64², no mips): white at the rim, BLOB_DARK darker in the middle, a smooth radial falloff. Drawn
 * with ALPHA_MULTIPLY (the town decals' recipe, town/decals.ts): white leaves the ground unchanged, so the blob darkens
 * whatever light the paving has, day or night, with no lighting of its own (an alpha-blended black quad showed nothing
 * in the PBR pipeline in the check).
 */
function blobTexture(scene: Scene): RawTexture {
  const n = 64
  const data = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = ((x + 0.5) / n) * 2 - 1
      const dy = ((y + 0.5) / n) * 2 - 1
      const t = Math.max(0, Math.min(1, (Math.hypot(dx, dy) - 0.2) / 0.8))
      const f = (1 - t * t * (3 - 2 * t)) ** 1.3
      const v = Math.round(255 * (1 - BLOB_DARK * f))
      const o = (y * n + x) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  const tex = RawTexture.CreateRGBATexture(data, n, n, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE)
  tex.name = 'town:blob'
  tex.wrapU = Texture.CLAMP_ADDRESSMODE
  tex.wrapV = Texture.CLAMP_ADDRESSMODE
  return tex
}

/** A thin-instance set with a matrix and a colour per instance and live bounds. */
class InstanceSet {
  readonly mats: Float32Array
  readonly colors: Float32Array
  count = 0
  private readonly min = new Vector3()
  private readonly max = new Vector3()

  constructor(readonly mesh: Mesh, readonly cap: number) {
    this.mats = new Float32Array(Math.max(1, cap) * 16)
    this.colors = new Float32Array(Math.max(1, cap) * 4).fill(1)
    mesh.thinInstanceSetBuffer('matrix', this.mats, 16, false)
    mesh.thinInstanceSetBuffer('color', this.colors, 4, false)
    mesh.thinInstanceCount = 0
    mesh.setBoundingInfo(new BoundingInfo(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)))
  }

  begin(): void {
    this.count = 0
    this.min.set(Infinity, Infinity, Infinity)
    this.max.set(-Infinity, -Infinity, -Infinity)
  }

  /** One instance: scale (sx, sy, sz), yaw, at (x, y, z), colour (r, g, b, a). */
  add(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, a: number): void {
    if (this.count >= this.cap) return
    const o = this.count * 16
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const m = this.mats
    m[o] = c * sx
    m[o + 1] = 0
    m[o + 2] = -s * sx
    m[o + 3] = 0
    m[o + 4] = 0
    m[o + 5] = sy
    m[o + 6] = 0
    m[o + 7] = 0
    m[o + 8] = s * sz
    m[o + 9] = 0
    m[o + 10] = c * sz
    m[o + 11] = 0
    m[o + 12] = x
    m[o + 13] = y
    m[o + 14] = z
    m[o + 15] = 1
    const k = this.count * 4
    this.colors[k] = r
    this.colors[k + 1] = g
    this.colors[k + 2] = b
    this.colors[k + 3] = a
    const e = Math.max(sx, sz)
    if (x - e < this.min.x) this.min.x = x - e
    if (y - 0.5 < this.min.y) this.min.y = y - 0.5
    if (z - e < this.min.z) this.min.z = z - e
    if (x + e > this.max.x) this.max.x = x + e
    if (y + 0.5 > this.max.y) this.max.y = y + 0.5
    if (z + e > this.max.z) this.max.z = z + e
    this.count++
  }

  end(): void {
    const m = this.mesh
    if (m.thinInstanceCount !== this.count) m.thinInstanceCount = this.count
    const vis = this.count > 0
    if (m.isVisible !== vis) m.isVisible = vis
    if (!vis) return
    m.thinInstanceBufferUpdated('matrix')
    m.thinInstanceBufferUpdated('color')
    m.getBoundingInfo().reConstruct(this.min, this.max)
  }
}

/** The blobs under the crowd (one draw). */
export class TownBlobs {
  readonly mesh: Mesh
  private readonly set: InstanceSet
  private readonly tex: RawTexture
  private readonly mat: StandardMaterial
  private readonly drawn = newDrawn()

  constructor(scene: Scene, cap: number) {
    this.mesh = tagged(MeshBuilder.CreateGround('town:blobs', { width: 1, height: 1 }, scene))
    this.tex = blobTexture(scene)
    const mat = new StandardMaterial('town:blobs', scene)
    mat.diffuseTexture = this.tex
    // unlit: with lighting off the diffuse term is 0, so the emissive white carries the texture (out = tex)
    mat.disableLighting = true
    mat.emissiveColor = Color3.White()
    mat.diffuseColor = Color3.Black()
    mat.specularColor = Color3.Black()
    mat.backFaceCulling = false
    mat.fogEnabled = false
    mat.disableDepthWrite = true
    mat.zOffset = -2
    mat.alphaMode = Constants.ALPHA_MULTIPLY
    // the multiply needs the transparent pass (after the ground it darkens); alpha itself is unused by the blend
    mat.needAlphaBlending = () => true
    this.mat = mat
    this.mesh.material = mat
    this.mesh.receiveShadows = false
    this.set = new InstanceSet(this.mesh, cap)
  }

  /** Puts a blob under every agent `crowd` draws (`agents` of them). */
  begin(): void {
    this.set.begin()
  }

  addCrowd(crowd: TownCrowd, agents: number): void {
    const d = this.drawn
    for (let i = 0; i < agents; i++) {
      if (!crowd.drawnOf(i, d)) continue
      // a multiply cannot fade by alpha: the blob grows and shrinks with its owner's fade instead
      const r = Math.max(0.15, d.h * BLOB_RADIUS_PER_M) * Math.min(1, d.alpha)
      this.set.add(d.x, d.y + 0.04, d.z, 0, r * 2, 1, r * 2, 1, 1, 1, 1)
    }
  }

  end(): void {
    this.set.end()
  }

  get count(): number {
    return this.set.count
  }

  dispose(): void {
    this.mesh.dispose()
    this.mat.dispose()
    this.tex.dispose()
  }
}

/** The lantern's colour on screen (display-referred, sRGB 0..1): a warm paper-lantern orange (b / r ≈ 0.3). */
export const LANTERN_DISPLAY: readonly [number, number, number] = [1, 0.66, 0.3]
/**
 * The sky exposure assumed until a frame tells the real one: a clear night's (measured 24.29 in the viewer at 21:36);
 * the lanterns show at dusk and at night.
 */
export const LANTERN_NIGHT_EXPOSURE = 24
/** At most this many moving lantern lights, the nearest holders (TOWN_LIFE §7.1, WAVE_PLAN7 §2.5). */
export const LANTERN_LIGHTS = 4
/** A lantern light's reach (m), colour (linear) and peak intensity (the cluster's lamps run kind 1 × gain 3). */
export const LANTERN_LIGHT_RANGE_M = 6
export const LANTERN_LIGHT_COLOR: readonly [number, number, number] = [1, 0.62, 0.28]
export const LANTERN_LIGHT_PEAK = 2.4
/** Holders farther than this from the focus get no light (m). */
export const LANTERN_LIGHT_NEAR_M = 40
/** A light fades in or out over this (s) when it moves to another holder. */
export const LANTERN_LIGHT_FADE_S = 0.3
/** Where a dark light waits (night-lights.ts parks its own the same way: the cluster's tile pass then skips it). */
const PARKED_RANGE_M = 0.01
const PARKED_Y = -1000

/** The part of world-render's NightLights the lanterns use (night-lights.ts; `nightLightsOf(scene)`). */
export interface LanternCluster {
  canAddDynamicLight(): boolean
  addDynamicLight(light: Light): boolean
  removeDynamicLight(light: Light): void
  hasDynamicLight(light: Light): boolean
}

interface LanternLight {
  readonly light: PointLight
  /** The holder (agent index) it follows; −1: free. */
  agent: number
  /** Its fade 0..1. */
  w: number
}

/** The carried lanterns (one draw): carriers when out, guards at night. */
export class TownLanterns {
  readonly mesh: Mesh
  private readonly set: InstanceSet
  private readonly mat: PBRMaterial
  private readonly carriers: Int32Array
  private readonly guards: Int32Array
  private readonly drawn = newDrawn()
  /** This frame's holders: agent, lantern position, distance² to the focus. */
  private readonly hAgent: Int32Array
  private readonly hX: Float32Array
  private readonly hY: Float32Array
  private readonly hZ: Float32Array
  private readonly hD: Float32Array
  private held = 0
  /** The nearest holders this frame (indices into the holder arrays; −1: taken or none). */
  private readonly near = new Int32Array(LANTERN_LIGHTS)
  private readonly lights: LanternLight[] = []
  private cluster: LanternCluster | null = null
  /**
   * How many moving lights this preset allows (≤ LANTERN_LIGHTS; TOWN_PRESETS `lanternLights`: Medium 2, High+ 4).
   * Measured (viewer, Medium WebGPU, 4 lit holders by the camera): ≈ 0.3–0.5 ms a frame for four, so Medium keeps two.
   */
  maxLights = LANTERN_LIGHTS
  private exposureAt = Number.NaN
  private readonly rgb: [number, number, number] = [0, 0, 0]

  constructor(scene: Scene, agents: readonly CrowdAgent[]) {
    const carriers: number[] = []
    const guards: number[] = []
    agents.forEach((a, i) => {
      if (a.role === 'lanternCarrier') carriers.push(i)
      else if (a.role === 'guard') guards.push(i)
    })
    this.carriers = Int32Array.from(carriers)
    this.guards = Int32Array.from(guards)
    this.mesh = tagged(MeshBuilder.CreateBox('town:lanterns', { width: 0.16, height: 0.22, depth: 0.16 }, scene))
    const mat = new PBRMaterial('town:lanterns', scene)
    mat.unlit = true
    mat.albedoColor = new Color3(1, 0.62, 0.28)
    mat.metallic = 0
    mat.roughness = 1
    this.mat = mat
    this.mesh.material = mat
    const n = carriers.length + guards.length
    this.set = new InstanceSet(this.mesh, n)
    this.hAgent = new Int32Array(n)
    this.hX = new Float32Array(n)
    this.hY = new Float32Array(n)
    this.hZ = new Float32Array(n)
    this.hD = new Float32Array(n)
    this.setExposure(LANTERN_NIGHT_EXPOSURE)
  }

  /** How many lanterns could show (none: the part skips this set). */
  get holders(): number {
    return this.carriers.length + this.guards.length
  }

  /** Moving lights made (tests and stats). */
  get lightCount(): number {
    return this.lights.length
  }

  /** Moving lights lit now (intensity > 0). */
  get litCount(): number {
    let n = 0
    for (const l of this.lights) if (l.light.intensity > 0) n++
    return n
  }

  /**
   * One frame. `skyExposure`: SkyState.exposure (not finite: keep the last); `night` 0..1 (SkyState.night) and
   * `cluster` (the scene's NightLights; null: none) drive the moving lights round the focus (fx, fz).
   */
  update(crowd: TownCrowd, solarT: number, skyExposure = Number.NaN, night = 0, cluster: LanternCluster | null = null, fx = 0, fz = 0, dt = 0): void {
    if (skyExposure > 0 && Number.isFinite(skyExposure)) this.setExposure(skyExposure)
    this.set.begin()
    this.held = 0
    const nightTime = solarT >= NIGHT_FROM || solarT < NIGHT_TO
    this.hold(crowd, this.carriers, fx, fz)
    if (nightTime) this.hold(crowd, this.guards, fx, fz)
    this.set.end()
    this.updateLights(cluster, night, dt)
  }

  /** The unlit colour that shows LANTERN_DISPLAY through the post at this exposure (set again on a 2 % change). */
  private setExposure(skyExposure: number): void {
    const d = sceneDisplay(this.mesh.getScene(), skyExposure)
    if (Math.abs(d.exposure - this.exposureAt) < 0.02 * this.exposureAt) return
    this.exposureAt = d.exposure
    const c = displayToScene(LANTERN_DISPLAY, d, this.rgb)
    this.mat.albedoColor.set(c[0]!, c[1]!, c[2]!)
  }

  private hold(crowd: TownCrowd, list: Int32Array, fx: number, fz: number): void {
    const d = this.drawn
    for (let k = 0; k < list.length; k++) {
      if (!crowd.drawnOf(list[k]!, d) || d.alpha < 0.5) continue
      // the right hand, a little ahead: (−0.3, 0.78, 0.18) × the body scale, turned by the yaw
      const s = Math.sin(d.yaw)
      const c = Math.cos(d.yaw)
      const lx = -0.3 * d.scale
      const lz = 0.18 * d.scale
      const x = d.x + lx * c + lz * s
      const y = d.y + 0.78 * d.scale
      const z = d.z - lx * s + lz * c
      this.set.add(x, y, z, d.yaw, 1, 1, 1, 1, 1, 1, 1)
      const h = this.held++
      this.hAgent[h] = list[k]!
      this.hX[h] = x
      this.hY[h] = y
      this.hZ[h] = z
      this.hD[h] = (x - fx) * (x - fx) + (z - fz) * (z - fz)
    }
  }

  /** The maxLights nearest holders keep (or take, fading in) a cluster light; the rest fade out. No allocation. */
  private updateLights(cluster: LanternCluster | null, night: number, dt: number): void {
    const max = Math.max(0, Math.min(LANTERN_LIGHTS, Math.floor(this.maxLights)))
    // the cluster went (a dispose), changed, or let go of our lights (a preset without one), or the preset's count
    // changed: drop them (made again below when needed)
    if (this.lights.length && (cluster !== this.cluster || !cluster || this.lights.length !== max || !cluster.hasDynamicLight(this.lights[0]!.light))) this.dropLights()
    this.cluster = cluster
    const near = this.near
    near.fill(-1)
    let nearN = 0
    if (night > 0.02 && cluster) {
      const r2 = LANTERN_LIGHT_NEAR_M * LANTERN_LIGHT_NEAR_M
      for (let h = 0; h < this.held; h++) {
        const d = this.hD[h]!
        if (d > r2) continue
        if (max === 0 || (nearN === max && d >= this.hD[near[nearN - 1]!]!)) continue
        let k = nearN < max ? nearN++ : max - 1
        while (k > 0 && this.hD[near[k - 1]!]! > d) {
          near[k] = near[k - 1]!
          k--
        }
        near[k] = h
      }
    }
    // made once, when the first is needed and the cluster would take them (never a scene light)
    if (nearN > 0 && !this.lights.length && cluster && cluster.canAddDynamicLight()) this.makeLights(cluster, max)
    if (!this.lights.length) return
    const step = dt > 0 ? dt / LANTERN_LIGHT_FADE_S : 1
    for (const l of this.lights) {
      if (l.agent < 0) continue
      let at = -1
      for (let k = 0; k < nearN; k++) {
        const h = near[k]!
        if (h >= 0 && this.hAgent[h] === l.agent) {
          at = h
          near[k] = -1
          break
        }
      }
      if (at >= 0) {
        l.w = Math.min(1, l.w + step)
        this.moveTo(l, at)
        continue
      }
      // not wanted any more: fade out where the holder is (still drawn) or was
      l.w = Math.max(0, l.w - step)
      if (l.w <= 0) l.agent = -1
      else for (let h = 0; h < this.held; h++) if (this.hAgent[h] === l.agent) this.moveTo(l, h)
    }
    for (const l of this.lights) {
      if (l.agent >= 0) continue
      for (let k = 0; k < nearN; k++) {
        const h = near[k]!
        if (h < 0) continue
        near[k] = -1
        l.agent = this.hAgent[h]!
        l.w = Math.min(1, step)
        this.moveTo(l, h)
        break
      }
    }
    const peak = LANTERN_LIGHT_PEAK * Math.min(1, Math.max(0, night))
    for (const l of this.lights) {
      const i = l.agent >= 0 ? peak * l.w : 0
      if (l.light.intensity !== i) l.light.intensity = i
      // a dark light is parked (as NightLights parks its own): a tiny reach far below, so the cluster's tiles skip it
      const range = i > 0 ? LANTERN_LIGHT_RANGE_M : PARKED_RANGE_M
      if (l.light.range !== range) l.light.range = range
      if (i <= 0 && l.light.position.y !== PARKED_Y) l.light.position.set(0, PARKED_Y, 0)
    }
  }

  private moveTo(l: LanternLight, h: number): void {
    l.light.position.set(this.hX[h]!, this.hY[h]! + 0.15, this.hZ[h]!)
  }

  private makeLights(cluster: LanternCluster, n: number): void {
    const scene = this.mesh.getScene()
    for (let k = 0; k < n; k++) {
      // not added to the scene (no scene light even for this call, no onNewLightAdded): the cluster takes it next
      const light = new PointLight(`town:lantern${k}`, new Vector3(0, PARKED_Y, 0), scene, true)
      light.intensity = 0
      light.range = PARKED_RANGE_M
      light.diffuse.set(LANTERN_LIGHT_COLOR[0], LANTERN_LIGHT_COLOR[1], LANTERN_LIGHT_COLOR[2])
      light.specular = Color3.Black()
      // into the cluster in the same call, before any frame; refused: no moving light (the lantern stays emissive only)
      if (!cluster.addDynamicLight(light)) {
        light.dispose()
        break
      }
      this.lights.push({ light, agent: -1, w: 0 })
    }
  }

  private dropLights(): void {
    for (const l of this.lights) {
      try {
        this.cluster?.removeDynamicLight(l.light)
      } catch {
        // the cluster went first
      }
      if (!l.light.isDisposed()) l.light.dispose()
    }
    this.lights.length = 0
  }

  get count(): number {
    return this.set.count
  }

  dispose(): void {
    this.dropLights()
    this.cluster = null
    this.mesh.dispose()
    this.mat.dispose()
  }
}
