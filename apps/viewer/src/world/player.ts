import {
  Color3,
  CreateTorus,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AnimationGroup,
  type Mesh,
  type Scene,
} from '@babylonjs/core'
import type { NavGltf, NavMoveResult, NavPosition } from '@sro/nav'
import { NavWalker, loadGlb, type Assets, type ObjectMaterials, type SidecarLite } from '@sro/world-render'

export const RUN_SPEED = 5
const TURN_RATE = 12
const BLEND_RATE = 8
/** Seconds the red "blocked" marker stays up after the walker has stopped. */
const BLOCKED_SHOW_S = 1.5

const MARKER_OK = new Color3(1, 0.85, 0.25)
const MARKER_BLOCKED = new Color3(1, 0.15, 0.1)

/**
 * The player character: loads the converted chinaman_adventurer (/out/char/...) and walks with @sro/nav
 * (NavWalker): a click is one moveStraight chord that stops at the first blocking edge; the height comes from the
 * surface the walker stands on (object floors, stairs and bridges, else terrain). STAND1 <-> RUN blend by speed.
 * The glTF model faces +Z; heading h rotates it about +Y, so it faces (sin h, 0, cos h). `scale` is the uniform
 * character Height factor (docs/CHARACTER_SCALE.md).
 */
export class Player {
  readonly node: TransformNode
  /** Render position (glTF metres) = walker.pos. */
  readonly position: Vector3
  readonly walker: NavWalker
  heading = Math.PI // facing north (-Z)
  speed = 0
  /** The last click's walk result. */
  lastMove: NavMoveResult | null = null
  private stand: AnimationGroup | null = null
  private run: AnimationGroup | null = null
  private runWeight = 0
  private marker: Mesh
  private markerMat: StandardMaterial
  private markerTimer = 0
  private turning = false
  loaded = false
  error: string | null = null

  constructor(readonly scene: Scene, readonly nav: NavGltf, spawn: NavPosition, scale = 1) {
    this.node = new TransformNode('player', scene)
    this.walker = new NavWalker(nav, spawn)
    this.position = new Vector3(spawn.x, spawn.y, spawn.z)
    this.node.position = this.position
    this.node.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), this.heading)
    this.setScale(scale)
    this.marker = CreateTorus('moveTarget', { diameter: 0.9, thickness: 0.08, tessellation: 24 }, scene)
    this.markerMat = new StandardMaterial('moveTarget', scene)
    this.markerMat.disableLighting = true
    this.markerMat.emissiveColor = MARKER_OK.clone()
    this.marker.material = this.markerMat
    this.marker.isPickable = false
    this.marker.setEnabled(false)
  }

  get scale(): number {
    return this.node.scaling.x
  }

  setScale(s: number): void {
    this.node.scaling.setAll(s)
  }

  /** Live nav position (glTF metres + surface). */
  get navPosition(): NavPosition {
    return this.walker.pos
  }

  async load(assets: Assets, materials: ObjectMaterials, glb: string, sidecar: string | null): Promise<void> {
    const [container, side] = await Promise.all([
      loadGlb(this.scene, assets, glb),
      sidecar ? assets.json<SidecarLite>(sidecar).catch(() => null) : Promise.resolve(null),
    ])
    await materials.convert(container, side, false)
    container.addAllToScene()
    for (const root of container.rootNodes) root.parent = this.node
    for (const m of container.meshes) m.isPickable = false
    for (const g of container.animationGroups) g.stop()
    this.stand = container.animationGroups.find(g => g.name === 'STAND1') ?? null
    this.run = container.animationGroups.find(g => g.name === 'RUN') ?? null
    for (const g of [this.stand, this.run]) {
      if (!g) continue
      g.start(true, 1, g.from, g.to)
    }
    this.applyWeights()
    this.loaded = true
  }

  private applyWeights(): void {
    if (this.stand && this.run) {
      this.run.weight = this.runWeight
      this.stand.weight = 1 - this.runWeight
    } else if (this.stand) {
      this.stand.weight = 1
    }
  }

  /** Click-to-move toward the picked point (glTF metres; y = the picked surface, used for the marker only). */
  moveTo(p: Vector3): NavMoveResult {
    const r = this.walker.moveTo(p.x, p.z)
    this.lastMove = r
    this.marker.position.set(p.x, p.y + 0.05, p.z)
    this.markerMat.emissiveColor.copyFrom(r.blocked ? MARKER_BLOCKED : MARKER_OK)
    this.marker.setEnabled(true)
    this.markerTimer = r.blocked ? BLOCKED_SHOW_S : 0
    this.turning = true
    this.syncPosition()
    return r
  }

  stop(): void {
    this.walker.stop()
    this.marker.setEnabled(false)
  }

  /** Teleport (no retained surface): the surface nearest to yHint at (x, z), default the highest. */
  teleport(x: number, z: number, yHint = Infinity): void {
    this.walker.teleport(x, z, yHint)
    this.marker.setEnabled(false)
    this.syncPosition()
  }

  private syncPosition(): void {
    const p = this.walker.pos
    this.position.set(p.x, p.y, p.z)
  }

  update(dt: number): void {
    const moved = this.walker.advance(RUN_SPEED * dt)
    this.syncPosition()
    if (this.turning) {
      // Face the click (also when the walk was blocked at once).
      const want = Math.atan2(this.walker.dirX, this.walker.dirZ)
      let d = want - this.heading
      d = Math.atan2(Math.sin(d), Math.cos(d))
      this.heading += d * Math.min(1, TURN_RATE * dt)
      if (Math.abs(d) < 1e-3 && !this.walker.moving) this.turning = false
    }
    this.speed = dt > 0 ? moved / dt : 0
    this.node.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), this.heading)
    const running = this.walker.moving || moved > 0 ? 1 : 0
    this.runWeight += (running - this.runWeight) * Math.min(1, BLEND_RATE * dt)
    this.applyWeights()
    if (this.marker.isEnabled()) {
      this.marker.rotation.y += dt
      if (!this.walker.moving) {
        // Arrived: hide the marker; a blocked move keeps its red marker up a little longer.
        this.markerTimer -= dt
        if (this.markerTimer <= 0) this.marker.setEnabled(false)
      }
    }
  }
}
