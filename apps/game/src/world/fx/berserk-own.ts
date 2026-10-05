/**
 * The combat feel of Berserk on your own screen (docs/EFFECTS.md §3.9 "Makeover"): the camera push-in, shake and hit
 * bumps (on the field of view and the screen offset, added on top of what the camera keys do and taken off again), the
 * hit-freeze and hit-stop (the scene's animation time scale), and the flinch of a monster you hit (a visual push of its
 * model root, back to where it was). Every change is undone exactly: a value someone else wrote meanwhile is kept.
 */
import type { Scene, TransformNode, Vector2 } from '@babylonjs/core'
import { flinch } from './berserk-look.ts'

/** The camera parts the nudge moves. */
export interface NudgeCamera {
  fov: number
  readonly targetScreenOffset: Vector2
}

/**
 * Adds a field-of-view push (a share: 0.1 = 10 % narrower) and a screen offset to the camera, frame by frame, on top of
 * its own values; `apply(0, 0, 0)` (or dispose) leaves the camera as it would be without it.
 */
export class CameraNudge {
  private fovDelta = 0
  private fovSet = Number.NaN
  private fovBase = Number.NaN
  private dx = 0
  private dy = 0
  private offSet = { x: Number.NaN, y: Number.NaN }
  private offBase = { x: 0, y: 0 }

  constructor(private readonly camera: NudgeCamera) {}

  apply(push: number, x: number, y: number): void {
    const c = this.camera
    // A fov or offset someone else wrote since our last frame is the new base (our delta was replaced with it); else
    // the base we kept, so the camera gets its exact value back when the nudge is over.
    if (c.fov !== this.fovSet) this.fovBase = c.fov
    this.fovDelta = -this.fovBase * Math.max(-0.5, Math.min(0.5, push))
    c.fov = this.fovDelta ? this.fovBase + this.fovDelta : this.fovBase
    this.fovSet = c.fov
    const o = c.targetScreenOffset
    if (o.x !== this.offSet.x || o.y !== this.offSet.y) this.offBase = { x: o.x, y: o.y }
    this.dx = x
    this.dy = y
    o.x = x ? this.offBase.x + x : this.offBase.x
    o.y = y ? this.offBase.y + y : this.offBase.y
    this.offSet = { x: o.x, y: o.y }
  }

  /** Nothing of ours is on the camera. */
  get idle(): boolean {
    return this.fovDelta === 0 && this.dx === 0 && this.dy === 0
  }

  dispose(): void {
    this.apply(0, 0, 0)
  }
}

/**
 * The hit-freeze: the scene's animations run at `scale` until `until` (ms of the caller's clock), then at the speed they
 * had. A longer freeze wins over a shorter one; a time scale someone else set meanwhile is left alone.
 */
export class TimeFreeze {
  private until = -Infinity
  private was = 1
  private set = Number.NaN

  constructor(private readonly scene: Pick<Scene, 'animationTimeScale'>) {}

  freeze(now: number, ms: number, scale: number): void {
    if (!this.active) this.was = this.scene.animationTimeScale
    this.until = Math.max(this.until, now + ms)
    this.scene.animationTimeScale = this.set = scale
  }

  get active(): boolean {
    return this.until > -Infinity
  }

  update(now: number): void {
    if (!this.active || now < this.until) return
    this.release()
  }

  private release(): void {
    if (this.scene.animationTimeScale === this.set) this.scene.animationTimeScale = this.was
    this.until = -Infinity
    this.set = Number.NaN
  }

  dispose(): void {
    if (this.active) this.release()
  }
}

interface FlinchEntry {
  root: TransformNode
  born: number
  dx: number
  dz: number
  /** What we added last frame (taken off before the next push). */
  ax: number
  az: number
}

/**
 * Monsters you hit while berserk are pushed back a little (visual only: the server keeps their position): their model
 * root (a child of the entity root, normally at 0) moves `amp` metres away from you and springs back (FLINCH_MS).
 */
export class Flinches {
  private readonly list = new Map<number, FlinchEntry>()

  hit(id: number, root: TransformNode, now: number, dirX: number, dirZ: number, amp: number): void {
    const l = Math.hypot(dirX, dirZ)
    if (!(l > 1e-4)) return
    const had = this.list.get(id)
    if (had && had.root !== root) this.undo(had)
    const e = had && had.root === root ? had : { root, born: now, dx: 0, dz: 0, ax: 0, az: 0 }
    e.born = now
    e.dx = (dirX / l) * amp
    e.dz = (dirZ / l) * amp
    this.list.set(id, e)
  }

  update(now: number): void {
    for (const [id, e] of this.list) {
      if (e.root.isDisposed()) {
        this.list.delete(id)
        continue
      }
      const k = flinch(now - e.born)
      const p = e.root.position
      p.x += e.dx * k - e.ax
      p.z += e.dz * k - e.az
      e.ax = e.dx * k
      e.az = e.dz * k
      if (k === 0 && now - e.born > 0) {
        this.list.delete(id)
      }
    }
  }

  private undo(e: FlinchEntry): void {
    if (e.root.isDisposed()) return
    e.root.position.x -= e.ax
    e.root.position.z -= e.az
    e.ax = 0
    e.az = 0
  }

  /** Puts `id` back now (it died, left, or warped). */
  forget(id: number): void {
    const e = this.list.get(id)
    if (!e) return
    this.undo(e)
    this.list.delete(id)
  }

  get size(): number {
    return this.list.size
  }

  dispose(): void {
    for (const e of this.list.values()) this.undo(e)
    this.list.clear()
  }
}
