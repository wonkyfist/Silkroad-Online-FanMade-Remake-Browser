/**
 * Play the Boss world effects (docs/PLAY_THE_BOSS.md §4.1, §4.4): her paw prints for the hunters (`huntTrail`: one
 * thin-instanced quad for every print, fading over TRAIL_FADE_S) and the faint aura of a body in a trance (an
 * attachment on player views; built only while `state.trance` is set). Babylon only; the maths is pilot-model.ts'.
 */
import { Color3, Constants, CreateCylinder, CreateGround, CreateTorus, DynamicTexture, Material, Matrix, Mesh, Quaternion, StandardMaterial, TransformNode, Vector3, type Scene } from '@babylonjs/core'
import type { EntityAttachment, EntityView } from './entities.ts'
import { fadeAt, TRAIL_FADE_S } from './pilot-model.ts'

/** Prints kept at most (the oldest go first). */
export const PAW_MAX = 600
/** One print's size (m) and the paws' offsets from the trail point (m). */
const PAW_SIZE = 0.55
const PAW_SIDE = 0.32
const PAW_STRIDE = 0.28
/** The fade is redrawn this often (s). */
const REFRESH_S = 0.5

interface Print {
  x: number
  z: number
  at: number
  yaw: number
}

/** A paw (one pad, four toes) on a 64×64 canvas, white with alpha (tinted by the material). */
function pawTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture('pilotPaw', { width: 64, height: 64 }, scene, true)
  const c = tex.getContext() as CanvasRenderingContext2D
  c.clearRect(0, 0, 64, 64)
  c.fillStyle = 'rgba(255,255,255,0.95)'
  c.beginPath()
  c.ellipse(32, 40, 13, 11, 0, 0, Math.PI * 2)
  c.fill()
  for (const [x, y] of [[16, 22], [26, 14], [38, 14], [48, 22]] as const) {
    c.beginPath()
    c.ellipse(x, y, 5.5, 7, 0, 0, Math.PI * 2)
    c.fill()
  }
  tex.update()
  tex.hasAlpha = true
  return tex
}

/**
 * Her footprints: `add` the server's points ([x, z, server ms]); each becomes a pair of paws turned along the trail
 * (the heading from the nearest earlier point). One mesh, one draw call; the buffers are rebuilt on change and every
 * REFRESH_S for the fade. `heightAt` places a paw on the ground.
 */
export class PawPrints {
  private readonly prints: Print[] = []
  private readonly seen = new Set<string>()
  private mesh: Mesh | null = null
  private mat: StandardMaterial | null = null
  private tex: DynamicTexture | null = null
  private dirty = false
  private refresh = 0
  private readonly tmpM = new Matrix()
  private readonly tmpQ = new Quaternion()
  private readonly tmpS = new Vector3(PAW_SIZE, 1, PAW_SIZE)
  private readonly tmpT = new Vector3()

  constructor(private readonly scene: Scene, private readonly heightAt: (x: number, z: number) => number) {}

  /** Prints alive now (tests, the debug handle). */
  get count(): number {
    return this.prints.length
  }

  /** The debug handle's view: drawn instances, whether the mesh is on, the first print. */
  stats(): { prints: number; instances: number; enabled: boolean; first: Print | null } {
    return { prints: this.prints.length, instances: this.mesh?.thinInstanceCount ?? 0, enabled: !!this.mesh?.isEnabled(), first: this.prints[0] ?? null }
  }

  add(points: readonly (readonly [number, number, number])[]): void {
    const fresh = points.filter(p => {
      const k = `${p[0]},${p[1]},${p[2]}`
      if (this.seen.has(k)) return false
      this.seen.add(k)
      return true
    })
    if (!fresh.length) return
    const all = [...this.prints.map(p => [p.x, p.z, p.at] as const), ...fresh].sort((a, b) => a[2] - b[2])
    this.prints.length = 0
    for (let i = 0; i < all.length; i++) {
      const [x, z, at] = all[i]!
      const prev = i > 0 ? all[i - 1]! : null
      const next = i + 1 < all.length ? all[i + 1]! : null
      // Heading along the trail (glTF yaw: atan2(dx, dz), as EntityView); a lone point faces north.
      const ref = prev && Math.hypot(x - prev[0], z - prev[1]) < 40 ? [prev[0], prev[1], x, z] : next && Math.hypot(next[0] - x, next[1] - z) < 40 ? [x, z, next[0], next[1]] : null
      const yaw = ref ? Math.atan2(ref[2]! - ref[0]!, ref[3]! - ref[1]!) : 0
      this.prints.push({ x, z, at, yaw })
    }
    while (this.prints.length > PAW_MAX / 2) {
      const p = this.prints.shift()!
      this.seen.delete(`${p.x},${p.z},${p.at}`)
    }
    this.dirty = true
  }

  /** Per frame: drops faded prints and redraws the fade every REFRESH_S (server ms `now`, `dt` s). */
  update(now: number, dt: number): void {
    this.refresh -= dt
    if (!this.dirty && this.refresh > 0) return
    this.refresh = REFRESH_S
    const span = TRAIL_FADE_S * 1000
    while (this.prints.length && fadeAt(this.prints[0]!.at, now, span) <= 0) {
      const p = this.prints.shift()!
      this.seen.delete(`${p.x},${p.z},${p.at}`)
      this.dirty = true
    }
    if (!this.prints.length) {
      if (this.mesh) this.mesh.setEnabled(false)
      this.dirty = false
      return
    }
    this.build(now, span)
    this.dirty = false
  }

  private ensureMesh(): Mesh {
    if (this.mesh) return this.mesh
    const mesh = CreateGround('pilotPaws', { width: 1, height: 1 }, this.scene)
    const mat = new StandardMaterial('pilotPawsMat', this.scene)
    const tex = pawTexture(this.scene)
    mat.diffuseTexture = tex
    mat.useAlphaFromDiffuseTexture = true
    mat.disableLighting = true
    mat.diffuseColor = new Color3(0.2, 0.13, 0.07)
    mat.specularColor = Color3.Black()
    mat.backFaceCulling = false
    mat.zOffset = -2
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND
    mesh.material = mat
    mesh.isPickable = false
    mesh.alwaysSelectAsActiveMesh = true
    mesh.thinInstanceRegisterAttribute('color', 4)
    this.mesh = mesh
    this.mat = mat
    this.tex = tex
    return mesh
  }

  private build(now: number, span: number): void {
    const mesh = this.ensureMesh()
    const n = this.prints.length * 2
    const mats = new Float32Array(n * 16)
    const cols = new Float32Array(n * 4)
    let i = 0
    for (const p of this.prints) {
      const a = fadeAt(p.at, now, span) * 0.85
      const s = Math.sin(p.yaw)
      const c = Math.cos(p.yaw)
      // Left and right paw: across the heading (right = (c, -s)) and a little along it (forward = (s, c)).
      for (const side of [-1, 1]) {
        const x = p.x + c * PAW_SIDE * side + s * PAW_STRIDE * side
        const z = p.z - s * PAW_SIDE * side + c * PAW_STRIDE * side
        const y = this.heightAt(x, z) + 0.03
        Quaternion.RotationYawPitchRollToRef(p.yaw, 0, 0, this.tmpQ)
        Matrix.ComposeToRef(this.tmpS, this.tmpQ, this.tmpT.set(x, y, z), this.tmpM)
        this.tmpM.copyToArray(mats, i * 16)
        cols.set([1, 1, 1, a], i * 4)
        i++
      }
    }
    mesh.thinInstanceSetBuffer('matrix', mats, 16, false)
    mesh.thinInstanceSetBuffer('color', cols, 4, false)
    mesh.setEnabled(true)
  }

  clear(): void {
    this.prints.length = 0
    this.seen.clear()
    this.mesh?.setEnabled(false)
  }

  dispose(): void {
    this.clear()
    this.mesh?.dispose()
    this.mat?.dispose()
    this.tex?.dispose()
    this.mesh = null
    this.mat = null
    this.tex = null
  }
}

/** The vertical gradient of the aura column (clear at the top). */
function auraTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture('pilotAuraTex', { width: 8, height: 64 }, scene, false)
  const c = tex.getContext() as CanvasRenderingContext2D
  const g = c.createLinearGradient(0, 0, 0, 64)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.6, 'rgba(255,255,255,0.35)')
  g.addColorStop(1, 'rgba(255,255,255,0.8)')
  c.fillStyle = g
  c.fillRect(0, 0, 8, 64)
  tex.update()
  tex.hasAlpha = true
  return tex
}

/**
 * The faint aura of a body in a trance (docs/PLAY_THE_BOSS.md §3.3): a pale blue column and a ring at the feet,
 * additive, slowly pulsing; made when `view.state.trance` turns on, removed when it turns off. One per player view.
 */
export function tranceAura(scene: Scene, view: EntityView): EntityAttachment | null {
  if (view.kind !== 'player') return null
  let root: TransformNode | null = null
  let mat: StandardMaterial | null = null
  let tex: DynamicTexture | null = null
  let t = 0
  const drop = () => {
    root?.dispose(false, true)
    tex?.dispose()
    root = null
    mat = null
    tex = null
  }
  const make = () => {
    const id = view.id
    root = new TransformNode(`pilotAura:${id}`, scene)
    root.parent = view.root
    tex = auraTexture(scene)
    mat = new StandardMaterial(`pilotAuraMat:${id}`, scene)
    mat.disableLighting = true
    mat.emissiveColor = new Color3(0.45, 0.75, 1)
    mat.diffuseColor = Color3.Black()
    mat.specularColor = Color3.Black()
    mat.backFaceCulling = false
    mat.alphaMode = Constants.ALPHA_ADD
    mat.emissiveTexture = tex
    mat.opacityTexture = tex
    const h = Math.max(1.2, view.height * 0.8)
    const column = CreateCylinder(`pilotAuraCol:${id}`, { height: h, diameterTop: 1.1, diameterBottom: 1.3, tessellation: 24, cap: Mesh.NO_CAP }, scene)
    column.position.y = h / 2
    const ring = CreateTorus(`pilotAuraRing:${id}`, { diameter: 1.4, thickness: 0.05, tessellation: 32 }, scene)
    ring.position.y = 0.05
    for (const m of [column, ring]) {
      m.material = mat
      m.parent = root
      m.isPickable = false
    }
  }
  return {
    update(_now, dt) {
      const on = !!view.state.trance && !view.dead
      if (on && !root) make()
      else if (!on && root) drop()
      if (!root || !mat) return
      t += dt
      mat.alpha = 0.35 + 0.15 * Math.sin(t * 1.6)
    },
    dispose: drop,
  }
}
