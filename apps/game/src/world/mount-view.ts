/**
 * Horses in the world (lane MR-C; docs/SYSTEMS_COMBAT.md §1.2, §1.5; docs/WAVE_PLAN2.md D8):
 *  - `HorseView`, the view of a `cos` entity (registered with `registerEntityKind('cos', …)`): the horse glb of
 *    `catalog.cos(code)`, its name label ("Red Horse") with an HP bar for its owner only. A ridden horse is never
 *    moved by its own messages: it follows its rider (gait from the rider's move, position and yaw each frame), its
 *    label and pick proxy are off (you click the rider).
 *  - `RideLink`, one rider on one horse: the rider's actor switches to the `cart` clip group (STAND1_cart_stand01,
 *    RUN_cart_walk) and sits on the horse's `saddle` joint through a seat node (`CharacterActor.attachTo`), with the
 *    250 ms tween between the ground and the saddle on mount and dismount (there are no retail clips for them).
 * The seat is a free node placed at the saddle joint every frame (after every view has moved, world/features/mount.ts
 * onFrame), so the rider bobs with the gait but keeps its own yaw and scale from its view.
 */
import { TransformNode, Vector3, type Node, type Scene } from '@babylonjs/core'
import type { EntityState } from '@sro/shared'
import type { Catalog, ContentModel } from '../content/catalog.ts'
import type { CharacterActor } from '../three/models.ts'
import { el } from '../ui/dom.ts'
import { EntityView, registerEntityKind, type EntityContext } from './entities.ts'

/** The horse skeleton's rider joint (c_horse.bsk). */
export const SADDLE_JOINT = 'saddle'
/**
 * Where the rider's root (its feet in the cart pose) sits relative to the saddle joint, in the horse's frame (metres:
 * y up, z forward). Checked by eye (COMBAT H3): the cart pose has the rider's hips at its root, so zero puts the seat
 * on the saddle.
 */
export const SEAT_OFFSET: Readonly<{ y: number; z: number }> = { y: -0.04, z: 0 }
/** Getting on or off takes this long (ms): a straight tween between the ground beside the horse and the saddle. */
export const MOUNT_TWEEN_MS = 250
/** Radius of a horse whose CosDef is unknown (the Red Horse's BCRadius, 1.2 m). */
const DEFAULT_RADIUS = 1.2

const CSS = `
.entity-label.kind-cos .name { color: #e9dcb4; }
.entity-label.kind-cos.own .name { color: #fff3a8; }
`
let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'mount'
  s.textContent = CSS
  document.head.append(s)
}

/**
 * The catalog seen by a horse view: EntityView.load draws a non-mob, non-player kind with `catalog.npc(code)`, so a
 * horse code answers its cos.json model there (the other lookups are the real catalog's).
 */
export function horseCatalog(catalog: Catalog | null | undefined): Catalog {
  if (!catalog) return catalog as unknown as Catalog
  const c = Object.create(catalog) as Catalog
  c.npc = (code: string): ContentModel | undefined => {
    const m = catalog.cos(code)?.model
    return m ? { code, glb: m.glb, sidecar: m.sidecar } : catalog.npc(code)
  }
  return c
}

/** Smooth start and stop of the mount tween (0..1 → 0..1). */
export function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/** The world position of `node` this frame: every ancestor's world matrix is recomputed first (the root just moved). */
export function worldPoint(node: Node, out: Vector3): Vector3 {
  const chain: Node[] = []
  for (let n: Node | null = node; n; n = n.parent) chain.push(n)
  for (let i = chain.length - 1; i >= 0; i--) chain[i]!.computeWorldMatrix(true)
  return out.copyFrom((node as TransformNode).absolutePosition ?? Vector3.ZeroReadOnly)
}

export class HorseView extends EntityView {
  /** The rider's view while ridden (set by RideLink): the horse follows it and takes its gait. */
  rider: EntityView | null = null
  private ownHp: HTMLElement | null = null
  private ownFill: HTMLElement | null = null
  private selfId: (() => number) | null = null
  /** Seconds the horse stays put although ridden (hold): the rider's `stop` may be the dismount's step aside. */
  private holdLeft = 0
  private readonly holdPos = new Vector3()

  constructor(state: EntityState, ctx: EntityContext) {
    super(state, { ...ctx, catalog: horseCatalog(ctx.catalog) })
    ensureStyles()
    this.selfId = ctx.selfId
    this.radius = ctx.catalog?.cos(state.model)?.radius ?? DEFAULT_RADIUS
    this.pick.scaling.x = this.pick.scaling.z = this.radius * 2
    this.refreshOwner()
  }

  /** Owned by the viewer (EntityState.owner = the owning player's entity id, D31). */
  get own(): boolean {
    return !!this.selfId && this.state.owner !== undefined && this.state.owner === this.selfId()
  }

  /** A ridden horse is clicked through its rider; a parked one is clickable (your own: ride it). */
  override get selectable(): boolean {
    return super.selectable && !this.rider && this.state.rider === undefined
  }

  /** Label and HP bar again after `owner` or `rider` changed. */
  refreshOwner(): void {
    if (!this.selfId) return
    this.setLabelClass('own', this.own)
    this.pick.setEnabled(this.selectable)
    this.refreshOwnHp()
  }

  override refreshLabel(): void {
    super.refreshLabel()
    this.refreshOwnHp()
  }

  override setHp(hp: number, maxHp?: number): void {
    super.setHp(hp, maxHp)
    this.refreshOwnHp()
  }

  /** The owner's HP bar under the name (the label's mob bar is for mobs only). */
  private refreshOwnHp(): void {
    if (!this.selfId) return
    const show = this.own && !this.dead && this.maxHp > 0
    if (show && !this.ownHp) {
      this.ownFill = el('i')
      this.ownHp = el('div', 'hp cos-hp', this.ownFill)
      this.label.append(this.ownHp)
    }
    if (!this.ownHp) return
    this.ownHp.hidden = !show
    if (show) this.ownFill!.style.width = `${Math.max(0, Math.min(100, (100 * this.hp) / this.maxHp)).toFixed(1)}%`
  }

  /**
   * The rider got a `stop`: the horse stays where it stands for `seconds` (world/features/mount.ts). A dismount sends
   * the rider's `stop` 1.2 m aside just before `mount: null`; without the hold the ridden horse would follow the rider
   * there for a frame and park on the rider's new spot. A plain halt ends the hold and the horse catches up.
   */
  hold(seconds: number): void {
    if (this.holdLeft <= 0) this.holdPos.copyFrom(this.pos)
    this.holdLeft = seconds
  }

  /** Holding still under a rider's `stop` (hold). */
  get held(): boolean {
    return this.holdLeft > 0
  }

  /** Ends a hold at once (the rider moves again, or warps). */
  release(): void {
    this.holdLeft = 0
  }

  override update(now: number, dt: number): boolean {
    const r = this.rider
    if (this.holdLeft > 0) {
      this.holdLeft -= dt
      this.move = undefined
      this.pos.copyFrom(this.holdPos)
      if (!r || this.dead) return super.update(now, dt)
      if (r.move) this.holdLeft = 0
      else return super.update(now, dt)
    }
    if (r && !this.dead) {
      // The rider's move drives the gait (RUN above 3.2 m/s, as for players); a stopped rider stands the horse.
      this.move = r.move
      if (!r.move) {
        this.pos.copyFrom(r.pos)
        this.targetYaw = r.yaw
      }
      if (!!r.state.invisible !== !!this.state.invisible) this.setInvisible(!!r.state.invisible)
    }
    return super.update(now, dt)
  }

  /** Puts the horse exactly under its rider (after every view has moved this frame). */
  followRider(): void {
    const r = this.rider
    if (!r || this.dead || this.holdLeft > 0) return
    this.pos.copyFrom(r.pos)
    this.yaw = this.targetYaw = r.yaw
    this.root.position.copyFrom(r.root.position)
    this.actor?.setYaw(r.yaw)
  }

  /** The saddle point (world, with SEAT_OFFSET) this frame; null without a model or a saddle joint. */
  saddlePoint(out: Vector3): Vector3 | null {
    const joint = this.actor?.joint(SADDLE_JOINT)
    if (!joint || joint.isDisposed()) return null
    worldPoint(joint, out)
    const s = this.scale || 1
    out.x += Math.sin(this.yaw) * SEAT_OFFSET.z * s
    out.z += Math.cos(this.yaw) * SEAT_OFFSET.z * s
    out.y += SEAT_OFFSET.y * s
    return out
  }

  override updateLabel(scene: Scene, tmp: Vector3, focus: Vector3): void {
    if (this.rider) {
      this.label.hidden = true
      return
    }
    super.updateLabel(scene, tmp, focus)
  }
}

/**
 * EntityView getters a RideLink replaces while the rider sits high (label and damage numbers over the head, camera
 * focus): in the saddle they measure from the saddle, seated (metres above the saddle at scale 1).
 */
const LIFTED = { height: 1.25, focusHeight: 0.6 } as const
const baseGetter = (name: keyof typeof LIFTED) => Object.getOwnPropertyDescriptor(EntityView.prototype, name)!.get!

/**
 * One rider on one horse. `sync(dtMs)` each frame after every view has moved; `leave()` starts the dismount tween,
 * after which `sync` answers false and the owner disposes the link (the rider's actor back on its view, default clips).
 */
export class RideLink {
  readonly seat: TransformNode
  /** 0 = on the ground beside the horse, 1 = in the saddle. */
  private blend = 0
  private dir: 1 | -1 = 1
  /** Saddle height above the horse's feet (metres), measured on the first synced frame. */
  private lift: number | null = null
  private disposed = false
  /** The cart clips are in (until then the rider is hidden: no standing pose on the saddle, no tween). */
  private ready = false
  private readonly tmp = new Vector3()
  readonly actor: CharacterActor

  constructor(readonly horse: HorseView, readonly rider: EntityView, scene: Scene, instant = false) {
    const actor = rider.actor
    if (!actor) throw new Error('RideLink needs a loaded rider')
    this.actor = actor
    this.seat = new TransformNode(`mount-seat:${horse.id}`, scene)
    this.seat.position.copyFrom(rider.root.position)
    if (instant) this.blend = 1
    horse.rider = rider
    horse.refreshOwner()
    actor.attachTo(this.seat)
    actor.setEnabled(false)
    void actor.useClipGroup('cart').then(() => this.show())
    for (const name of Object.keys(LIFTED) as (keyof typeof LIFTED)[]) {
      const get = baseGetter(name)
      Object.defineProperty(rider, name, {
        configurable: true,
        get: (): number => {
          const base = get.call(rider) as number
          if (this.lift === null) return base
          return base + (this.lift + LIFTED[name] * (rider.scale || 1) - base) * ease(this.blend)
        },
      })
    }
  }

  /** The rider shows again once its cart clips are in (or at once when getting off). */
  private show(): void {
    this.ready = true
    if (!this.disposed && !this.actor.isDisposed) this.actor.setEnabled(true)
  }

  /** The cart clips are loaded and the rider shows. */
  get loaded(): boolean {
    return this.ready
  }

  /** On the horse (or getting on); false once the dismount started. */
  get riding(): boolean {
    return this.dir === 1 && !this.disposed
  }

  /** How far up the tween is (0..1), for tests. */
  get progress(): number {
    return this.blend
  }

  /** Starts the dismount tween (the horse is parked from now on). `instant` ends it at once. */
  leave(instant = false): void {
    if (this.dir === -1 && !instant) return
    this.dir = -1
    if (this.horse.rider === this.rider) this.horse.rider = null
    this.horse.refreshOwner()
    if (instant) this.blend = 0
    if (!this.ready) this.show()
  }

  /** Places the seat for this frame; false when the dismount has finished (dispose the link). */
  sync(dtMs: number): boolean {
    if (this.disposed) return false
    if (this.actor.isDisposed || this.rider.isDisposed) return false
    if (this.ready) this.blend = Math.min(1, Math.max(0, this.blend + (this.dir * dtMs) / MOUNT_TWEEN_MS))
    if (this.dir === 1) this.horse.followRider()
    const ground = this.rider.root.position
    const saddle = this.horse.isDisposed ? null : this.horse.saddlePoint(this.tmp)
    if (!saddle) {
      this.seat.position.copyFrom(ground)
    } else {
      if (this.lift === null && this.dir === 1) this.lift = Math.max(0, saddle.y - this.horse.root.position.y)
      Vector3.LerpToRef(ground, saddle, ease(this.blend), this.seat.position)
    }
    return this.dir === 1 || this.blend > 0
  }

  /** The rider's actor back on its own view, default clips, the lifted getters dropped. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.horse.rider === this.rider) this.horse.rider = null
    if (!this.horse.isDisposed) this.horse.refreshOwner()
    for (const name of Object.keys(LIFTED)) delete (this.rider as unknown as Record<string, unknown>)[name]
    if (!this.actor.isDisposed) {
      this.actor.setEnabled(true)
      this.actor.attachTo(null)
      void this.actor.useClipGroup('default')
    }
    this.seat.dispose()
  }
}

/** Registers the horse view for the `cos` entity kind; returns the unregister function. */
export function registerHorseView(): () => void {
  return registerEntityKind('cos', (state, ctx) => new HorseView(state, ctx))
}
