/**
 * Wave 11 (docs/UNIQUES.md §2.3, lane U-RC): the ridden-mob composite. A mob whose `MobDef.ride` names a ride (Tiger
 * Girl on her Blue Tiger) is drawn as two actors: the rider stays `EntityView.actor` (the leader of the clips: her
 * sidecar has the hit events, the attack clips, the sound palette) and the ride is her `companion` and her `lodLeader`.
 * The ride's root takes the place the rider's root had (parent = the entity root, scale, yaw: world/entities.ts); the
 * rider hangs under a seat node, a child of the ride's root, that copies the ride's `joint` (the saddle) every frame.
 *
 * - **The seat is the saddle's full transform** (position, rotation and scale), not its position alone (the horse
 *   RideLink's choice): her clips are authored relative to that joint, so she leans with the tiger's back at a run and
 *   is thrown to the ground beside it at the end of DIE1 (UNIQUES §2.1). The seat's local matrix is the product of the
 *   joint chain's local matrices up to the ride's root, set on `scene.onBeforeRenderObservable` (after `animate()`,
 *   before the render targets and the camera pass), so the shadows and the main pass draw the same seat, whatever the
 *   entity root does this frame. A ride that comes back into view on a frame the animation LOD skipped is stepped to the
 *   frame by the cull (`lodCatchUp`, after `onBeforeRender`): the seat is set again after the cull then.
 * - **Clips** pair by animation type through the `companion` seam (three/models.ts): the clip of the same name (the
 *   converter names a clip by its type), STUN → STAND1; a one-shot that ends first holds its last frame until the
 *   leader's resume (ATTACK2: the tiger's 3,333 ms against her 4,000 ms).
 * - **Animation LOD**: the ride is the rider's `lodLeader` (the bigger one), so both skip the same frames; the ride's
 *   culling sphere covers both (its bind extent plus RIDER_REACH_M above it).
 * - **Sizes**: the label, the pick cylinder and the damage numbers stand on the composite's height (the rider's
 *   `heightHook`), measured once per model pair in the STAND1 pose from both skinned bodies relative to the ride's root.
 * - **Dispose**: the rider's `dispose()` takes the ride (the companion seam); `RideMob.dispose()` ends the seating and
 *   disposes the ride and the seat (the rider is the caller's).
 *
 * Low (Classic) builds the same composite (UNIQUES §2.3 step 7: three meshes; no preset turns it off).
 */
import { Matrix, Quaternion, TransformNode, type AbstractMesh, type AnimationGroup, type Node, type Observer, type Scene, type Vector3 } from '@babylonjs/core'
import type { MobVisual } from '../content/catalog.ts'
import { cullSphereOf, type CharacterActor, type ModelLibrary } from '../three/models.ts'

/** The ride of a mob as the catalog resolves it (`catalog.mob(code).ride`: MobDef.ride with its /out/ urls). */
export type RideRef = NonNullable<MobVisual['ride']>

/** What `loadRide` needs (EntityView's context). */
export interface RideLoadContext {
  library: ModelLibrary
}

/** A loaded ride, wired to its rider. */
export interface RideMob {
  /**
   * The ride's actor: world/entities.ts parents its root to the entity root and turns and scales it (the rider follows
   * through the seat). It is the rider's `companion` and `lodLeader` (U-RC sets both, and the rider's `heightHook`).
   */
  readonly actor: CharacterActor
  /** Ends the seating and disposes the ride and its seat (the rider is the caller's). */
  dispose(): void
}

/**
 * Metres the ride's culling sphere reaches above its bind top: the rider's RUN bob and ATTACK3 leap (UNIQUES §2.3 step
 * 4: her top reaches 4.4 m on the 3.23 m tiger).
 */
export const RIDER_REACH_M = 1.5
/** STAND1 poses the composite height is measured at (evenly over the longer of the two loops; the highest top). */
export const HEIGHT_SAMPLES = 6
/** The composite height when it cannot be measured (metres before the root scaling; UNIQUES F2: ≈ 3.0 m). */
export const FALLBACK_HEIGHT_M = 3.0

/** Measured composite heights per rider glb, ride glb and joint (a respawn or an AOI re-entry measures nothing). */
const heights = new Map<string, number>()

const sane = (h: number) => Number.isFinite(h) && h > 0.3 && h < 12

/**
 * Loads `ride` for `rider` (same loader, cache, texture path and material decorators as the rider) and wires the
 * composite: companion, lodLeader, the seat, the height hook, the culling sphere. Null when there is no ride to draw
 * (a ride without the joint; the rider disposed meanwhile: the rider stands alone). A failed load throws (EntityView
 * warns, and the rider stands alone).
 */
export async function loadRide(ctx: RideLoadContext, rider: CharacterActor, ride: RideRef): Promise<RideMob | null> {
  if (rider.isDisposed) return null
  // Not drawn while the ride loads: the rider is not parented yet (it would stand at the world origin), and both appear,
  // and compile, in the same frame (UNIQUES §2.3 step 1).
  const shown = rider.root.isEnabled(false)
  rider.root.setEnabled(false)
  let actor: CharacterActor | null = null
  try {
    actor = await ctx.library.character(ride.model, {})
    if (rider.isDisposed) {
      actor.dispose()
      return null
    }
    const saddle = actor.joint(ride.joint)
    if (!saddle) {
      console.warn('[ride] no joint, the rider stands alone', ride.model.glb, ride.joint)
      actor.dispose()
      return null
    }
    return new RiddenMob(rider, actor, saddle, `${rider.model.glb}|${ride.model.glb}|${ride.joint}`)
  } catch (err) {
    if (actor && !actor.isDisposed) actor.dispose()
    throw err
  } finally {
    if (!rider.isDisposed) rider.root.setEnabled(shown)
  }
}

const localM = new Matrix()
const seatM = new Matrix()
const eulerQ = new Quaternion()

/** One TRS pose of an animated node (the height measurement puts it back). */
interface SavedPose {
  node: TransformNode
  position: Vector3
  rotation: Quaternion | null
  scaling: Vector3
}

class RiddenMob implements RideMob {
  /** The rider's root hangs here: a child of the ride's root with the saddle's transform relative to that root. */
  readonly seat: TransformNode
  /** Composite standing height (metres above the ride's root, before its scaling). */
  readonly height: number
  /** The joint and its ancestors below the ride's root, joint first. */
  private readonly chain: TransformNode[] = []
  private readonly scene: Scene
  private readonly beforeRender: Observer<Scene>
  private readonly afterCull: Observer<Scene>
  private readonly heightHook = () => this.height
  /** The ride was off screen at this frame's seat (a catch-up after the cull moves it: seat again). */
  private wasOff = false
  private disposed = false

  constructor(readonly rider: CharacterActor, readonly actor: CharacterActor, saddle: TransformNode, key: string) {
    const scene = (this.scene = actor.scene)
    let n: Node | null = saddle
    for (; n && n !== actor.root; n = n.parent) {
      if (!(n instanceof TransformNode)) throw new Error(`ride joint ${saddle.name} hangs under a non-transform node`)
      this.chain.push(n)
    }
    if (n !== actor.root) throw new Error(`ride joint ${saddle.name} is not under the ride's root`)
    this.seat = new TransformNode(`seat:${rider.model.code}`, scene)
    this.seat.rotationQuaternion = Quaternion.Identity()
    this.seat.parent = actor.root
    // The ride's sphere covers both (the rider copies its cull, three/models.ts): its bind extent, the rider above it.
    const f = actor.footprint
    actor.setCullSphere(cullSphereOf({ x: f.minX, y: 0, z: f.minZ }, { x: f.maxX, y: f.maxY + RIDER_REACH_M, z: f.maxZ }))
    const r = rider.root
    r.parent = this.seat
    r.position.setAll(0)
    r.rotationQuaternion = Quaternion.Identity()
    r.scaling.setAll(1)
    rider.companion = actor
    rider.lodLeader = actor
    this.seatNow()
    let h = heights.get(key)
    if (h === undefined) {
      h = this.measure()
      if (h !== FALLBACK_HEIGHT_M) heights.set(key, h)
    }
    this.height = h
    rider.heightHook = this.heightHook
    // After the world screen's frame tick (registered earlier on the same observable) and the animations.
    this.beforeRender = scene.onBeforeRenderObservable.add(() => this.onBeforeRender())
    // After ModelLibrary's cull (registered when the library was made): a catch-up moved both poses.
    this.afterCull = scene.onBeforeActiveMeshesEvaluationObservable.add(() => this.onAfterCull())
  }

  private onBeforeRender(): void {
    if (this.disposed || this.actor.isDisposed) return
    this.wasOff = this.actor.isOffscreen
    this.seatNow()
  }

  private onAfterCull(): void {
    if (this.disposed || this.actor.isDisposed || !this.wasOff || this.actor.isOffscreen) return
    this.wasOff = false
    this.seatNow()
  }

  /**
   * The seat takes the joint's transform relative to the ride's root: the product of the chain's local matrices
   * (Babylon's row-vector order, the joint's first), exact whatever the entity root's world matrix holds this frame.
   */
  seatNow(): void {
    seatM.copyFrom(Matrix.IdentityReadOnly)
    for (const node of this.chain) {
      let q = node.rotationQuaternion
      if (!q) {
        const e = node.rotation
        q = Quaternion.RotationYawPitchRollToRef(e.y, e.x, e.z, eulerQ)
      }
      Matrix.ComposeToRef(node.scaling, q, node.position, localM)
      seatM.multiplyToRef(localM, seatM)
    }
    seatM.decompose(this.seat.scaling, this.seat.rotationQuaternion!, this.seat.position)
  }

  /**
   * The composite's standing height: the highest top of both skinned bodies over HEIGHT_SAMPLES poses of their STAND1
   * loops (the rider seated on each), relative to the ride's root; the poses are put back afterwards. The bind poses
   * would not do: hers is a standing T-pose, 2.11 m above her pelvis (≈ 4.5 m on the saddle).
   */
  private measure(): number {
    const pairs: Array<[CharacterActor, AnimationGroup]> = []
    for (const a of [this.actor, this.rider]) {
      const g = a.group('STAND1') ?? a.clipFor('STAND1')
      if (g) pairs.push([a, g])
    }
    if (!pairs.length) return FALLBACK_HEIGHT_M
    const saved = savePoses(pairs.map(([, g]) => g))
    try {
      const lengthS = Math.max(...pairs.map(([, g]) => (g.to - g.from) / fpsOf(g)))
      const meshes = new Set<AbstractMesh>([...this.actor.meshes, ...this.rider.meshes])
      let top = -Infinity
      for (let i = 0; i < HEIGHT_SAMPLES; i++) {
        const t = (i / HEIGHT_SAMPLES) * lengthS
        for (const [, g] of pairs) poseAt(g, t)
        this.seatNow()
        top = Math.max(top, this.measureTop(meshes))
      }
      return sane(top) ? top : FALLBACK_HEIGHT_M
    } catch (err) {
      console.warn('[ride] height measurement failed', this.rider.model.code, err)
      return FALLBACK_HEIGHT_M
    } finally {
      restorePoses(saved)
      this.seatNow()
    }
  }

  /** The top of both skinned bodies in this pose, in the ride root's metres (the measurePose technique). */
  private measureTop(meshes: ReadonlySet<AbstractMesh>): number {
    for (const a of [this.actor, this.rider]) {
      a.skeleton?.prepare(true)
      for (const m of a.meshes) if (m.skeleton) m.refreshBoundingInfo({ applySkeleton: true })
    }
    const root = this.actor.root
    const b = root.getHierarchyBoundingVectors(true, x => meshes.has(x as AbstractMesh))
    const s = root.absoluteScaling.y || 1
    return (b.max.y - root.absolutePosition.y) / s
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scene.onBeforeRenderObservable.remove(this.beforeRender)
    this.scene.onBeforeActiveMeshesEvaluationObservable.remove(this.afterCull)
    const rider = this.rider
    if (!rider.isDisposed) {
      // The rider leaves the composite (it is the caller's): no more mirrored clips, LOD or height from the ride.
      if (rider.companion === this.actor) rider.companion = null
      if (rider.lodLeader === this.actor) rider.lodLeader = null
      if (rider.heightHook === this.heightHook) rider.heightHook = null
      if (rider.root.parent === this.seat) rider.root.parent = null
    }
    if (!this.actor.isDisposed) this.actor.dispose()
    if (!this.seat.isDisposed()) this.seat.dispose()
  }
}

/** Frames per second of a group's tracks (glTF clips: 60 in Babylon's frames). */
function fpsOf(g: AnimationGroup): number {
  const fps = g.targetedAnimations[0]?.animation.framePerSecond
  return fps && fps > 0 ? fps : 60
}

/** The TRS of every node `groups` animate, to put back after posing them. */
function savePoses(groups: readonly AnimationGroup[]): SavedPose[] {
  const seen = new Set<TransformNode>()
  const out: SavedPose[] = []
  for (const g of groups) {
    for (const ta of g.targetedAnimations) {
      const node = ta.target
      if (!(node instanceof TransformNode) || seen.has(node)) continue
      seen.add(node)
      out.push({ node, position: node.position.clone(), rotation: node.rotationQuaternion?.clone() ?? null, scaling: node.scaling.clone() })
    }
  }
  return out
}

function restorePoses(saved: readonly SavedPose[]): void {
  for (const p of saved) {
    p.node.position.copyFrom(p.position)
    if (!p.rotation) p.node.rotationQuaternion = null
    else if (p.node.rotationQuaternion) p.node.rotationQuaternion.copyFrom(p.rotation)
    else p.node.rotationQuaternion = p.rotation
    p.node.scaling.copyFrom(p.scaling)
  }
}

/** Sets the nodes `g` animates to its pose `seconds` into the loop (the tracks evaluated directly; nothing starts). */
function poseAt(g: AnimationGroup, seconds: number): void {
  const span = g.to - g.from
  const frame = g.from + (span > 0 ? (seconds * fpsOf(g)) % span : 0)
  for (const ta of g.targetedAnimations) {
    const node = ta.target
    if (!(node instanceof TransformNode)) continue
    const v = ta.animation.evaluate(frame) as unknown
    switch (ta.animation.targetProperty) {
      case 'position':
        node.position.copyFrom(v as Vector3)
        break
      case 'rotationQuaternion':
        if (node.rotationQuaternion) node.rotationQuaternion.copyFrom(v as Quaternion)
        else node.rotationQuaternion = (v as Quaternion).clone()
        break
      case 'scaling':
        node.scaling.copyFrom(v as Vector3)
        break
    }
  }
}
