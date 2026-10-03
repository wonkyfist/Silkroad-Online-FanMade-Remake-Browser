/**
 * Walk up to an entity, then act (docs/SYSTEMS_SOCIAL.md §9.1; docs/WAVE_PLAN2.md §4.3, W8-FC). The trade and stall
 * features call it on a `too_far` refusal, so the server needs no walk action:
 * - one `moveTo` to the point `range − 2` m short of the target, on the line from it to us (none when already there);
 * - every frame: once we stand within `range − 1` m of the target, `run()` runs, once;
 * - it gives up (without running) after 10 s, on another left click in the world (ground or entity), when the target
 *   or our own view despawns, when we die, when the movement keys take over (cancelApproach, MV-WASD), or when the
 *   returned function is called. A new approach replaces the last.
 * The approach's own `moveTo` is not a ground click: it asks no `beforeGroundMove` veto and no blocked-path feedback.
 */
import { PointerEventTypes, type PointerInfo, type Scene } from '@babylonjs/core'
import type { WorldFeatureContext } from './features.ts'
import { intents } from './intents.ts'

export const APPROACH_TIMEOUT_MS = 10_000
/** The walk stops this far inside `range` (m). */
export const APPROACH_SHORT_M = 2
/** Arrival: within `range` minus this (m), slack for the server's own position check. */
export const APPROACH_SLACK_M = 1

export type ApproachContext = Pick<WorldFeatureContext, 'send' | 'selfId' | 'view' | 'serverNow'> & {
  readonly scene: Pick<Scene, 'onBeforeRenderObservable' | 'onPointerObservable'>
}

/** The approach in progress (one walk at a time). */
let current: (() => void) | null = null

/** MV-WASD: the movement keys took over; the approach in progress gives up without running (like another click). */
export function cancelApproach(): void {
  current?.()
}

/** Walks to entity `entityId` until within `range` m, then calls `run` once. Returns a cancel function (idempotent). */
export function approachThen(ctx: ApproachContext, entityId: number, range: number, run: () => void): () => void {
  current?.()
  const started = ctx.serverNow()
  let done = false
  /** Pointer events only cancel from the first frame on: the click that started us is not "another" click. */
  let armed = false
  const selfView = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const gap = (a: { pos: { x: number; z: number } }, b: { pos: { x: number; z: number } }) => Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z)

  const frameObs = ctx.scene.onBeforeRenderObservable.add(() => {
    if (done) return
    armed = true
    const self = selfView()
    const target = ctx.view(entityId)
    if (!self || !target || self.dead || target.isDisposed) return cancel()
    if (gap(self, target) <= range - APPROACH_SLACK_M) {
      cancel()
      try {
        run()
      } catch (err) {
        console.error('[world] approach action failed', err)
      }
      return
    }
    if (ctx.serverNow() - started >= APPROACH_TIMEOUT_MS) cancel()
  })
  const pointerObs = ctx.scene.onPointerObservable.add((pi: PointerInfo) => {
    if (armed && pi.type === PointerEventTypes.POINTERDOWN && pi.event.button === 0) cancel()
  })

  function cancel(): void {
    if (done) return
    done = true
    ctx.scene.onBeforeRenderObservable.remove(frameObs)
    ctx.scene.onPointerObservable.remove(pointerObs)
    if (current === cancel) current = null
  }
  current = cancel

  const self = selfView()
  const target = ctx.view(entityId)
  if (!self || !target || self.dead) {
    cancel()
    return cancel
  }
  const d = gap(self, target)
  const stop = Math.max(0, range - APPROACH_SHORT_M)
  if (d > stop) {
    const k = stop / d
    const x = target.pos.x + (self.pos.x - target.pos.x) * k
    const z = target.pos.z + (self.pos.z - target.pos.z) * k
    if (!ctx.send(intents.moveTo(x, z))) cancel()
  }
  return cancel
}
