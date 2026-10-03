/**
 * Horses, client side (lane MR-C; docs/SYSTEMS_COMBAT.md §1.5; docs/WAVE_PLAN2.md §6.4, D8, D9):
 *  - the horse view (world/mount-view.ts, registered for the `cos` kind) and the ride links: each frame, after every
 *    view has moved, a ridden horse is put under its rider and the rider's actor on its saddle (`cart` clips);
 *  - `EntityState.mount` / `rider` kept on the views from `entityUpdate` (the world screen does not apply them);
 *  - clicking your own parked horse sends `mountRide` (the server walks you there first); another player's horse
 *    does nothing;
 *  - clicking a monster while mounted steps down, then attacks: `stopAction`, then `mountDismount` and `attack` (at
 *    once when standing, on the own `stop` when moving: the server refuses a dismount while moving);
 *  - `/dismount` and `/unsummon` (ChatBox.registerPrefix, D9);
 *  - the horse frame (hud/mount-frame.ts) in `PlayerFrame.petHost` while you own a horse: face, name, level, HP,
 *    Ride / Dismount and Dismiss (asks first);
 *  - sounds (cos.horse.* cues: run while ridden and moving, moan on a hit, die and thud) and, on a summon, the
 *    `ui.cos_summon` cue and the SYSTEM_PET_APPEAR effect;
 *  - refusals of the three mount requests toasted with the retail line where there is one.
 */
import type { ActionFailReason, ClientMessage, EntityState, ServerMessage } from '@sro/shared'
import { MountFrame, type MountFrameInfo } from '../../hud/mount-frame.ts'
import { t, type StringKey } from '../../i18n/index.ts'
import { kitArt } from '../../ui/kit/host.ts'
import { MessageBox } from '../../ui/kit/dialog.ts'
import type { EntityView } from '../entities.ts'
import type { CombatMessage, WorldFeature, WorldFeatureContext, WorldFeatureFactory } from '../features.ts'
import { systemFxFor } from '../fx/system-fx.ts'
import { HorseView, registerHorseView, RideLink } from '../mount-view.ts'

/** Chat commands (retail UIIT_KEY_COS_DISMOUNT / UIIT_KEY_COS_RETURN). */
export const DISMOUNT_COMMAND = '/dismount'
export const UNSUMMON_COMMAND = '/unsummon'
/** A stop-first dismount gives up when the own `stop` has not come by then (ms). */
export const DISMOUNT_WAIT_MS = 1500
/** A horse that spawns parked and gets its rider this soon after was just summoned (ms): the appear effect plays. */
export const SUMMON_WINDOW_MS = 1500
/** No summon effect this soon after entering the world (ms): a saved horse comes back with the character (relog). */
export const ENTER_QUIET_MS = 4000
/** How often the run loop is re-asked while a ridden horse moves (ms; `unique` keeps one voice per horse). */
const RUN_CUE_MS = 300
/** How long a ridden horse ignores its rider's `stop` (s): the dismount pair follows the step-aside stop at once. */
export const STOP_HOLD_S = 0.3
/** The thud after the death cry (ms). */
const THUD_DELAY_MS = 900
/** The frame is refreshed at most this often (ms). */
const FRAME_REFRESH_MS = 100
/** The mount requests whose refusals this feature toasts (the HUD does not). */
const MOUNT_REQUESTS: ReadonlySet<string> = new Set(['mountRide', 'mountDismount', 'mountDismiss'])

/**
 * Stepping down: `stopAction` (it also drops a chase or an action in progress), then `mountDismount` and `then` (an
 * attack) at once when standing, or on the own `stop` when moving (the server refuses a dismount while moving).
 */
export function stepDownPlan(moving: boolean, then: readonly ClientMessage[] = []): { now: ClientMessage[]; afterStop: ClientMessage[] } {
  const rest: ClientMessage[] = [{ t: 'mountDismount' }, ...then]
  return moving ? { now: [{ t: 'stopAction' }], afterStop: rest } : { now: [{ t: 'stopAction' }, ...rest], afterStop: [] }
}

/** What a click on a monster sends while mounted (docs/SYSTEMS_COMBAT.md §1.5): step down, then attack. */
export function dismountThenAttack(target: number, moving: boolean): { now: ClientMessage[]; afterStop: ClientMessage[] } {
  return stepDownPlan(moving, [{ t: 'attack', target }])
}

/** The refusal line of a mount request: retail's own where there is one (mount.fail.*), else action.fail.<reason>. */
export function mountFailText(reason: ActionFailReason | undefined, message?: string): string {
  if (!reason) return message ?? t('action.fail.generic')
  for (const key of [`mount.fail.${reason}`, `action.fail.${reason}`]) {
    const text = t(key as StringKey)
    if (text !== key) return text
  }
  return message ?? t('action.fail.generic')
}

/** Moving right now (an interpolated walk in progress, or a move not yet sampled). */
const isMoving = (v: EntityView | undefined): boolean => !!v && (v.moving || v.move !== undefined)

/** Applies `entityUpdate.mount` / `rider` (null = absent) to a view's state. */
export function applyMountUpdate(state: EntityState, msg: { mount?: number | null; rider?: number | null }): void {
  if (msg.mount !== undefined) {
    if (msg.mount === null) delete state.mount
    else state.mount = msg.mount
  }
  if (msg.rider !== undefined) {
    if (msg.rider === null) delete state.rider
    else state.rider = msg.rider
  }
}

export const mountFeature: WorldFeatureFactory = (ctx: WorldFeatureContext): WorldFeature => {
  // A bare context (the feature-list tests): nothing to hook.
  if (!ctx?.hud || !ctx.scene) return {}
  const offKind = registerHorseView()
  const audio = ctx.app?.audio
  const horses = new Set<HorseView>()
  const links = new Map<number, RideLink>()
  /** Horses that came into view already ridden: their rider sits down at once, without the tween. */
  const seated = new Set<number>()
  /** Parked horses just spawned (id → wall time): a rider this soon after is a summon. */
  const spawned = new Map<number, number>()
  let pending: { send: ClientMessage[]; until: number } | null = null
  let enteredAt = -Infinity
  let runT = 0
  let frameT = 0
  let frameKey = ''
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const wall = () => performance.now()

  const selfView = (): EntityView | undefined => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const mounted = (): boolean => selfView()?.state.mount !== undefined
  const ownHorse = (): HorseView | undefined => {
    let best: HorseView | undefined
    for (const h of horses) if (h.own && !h.isDisposed && (!best || (best.dead && !h.dead))) best = h
    return best
  }
  /** Sends in order; false at the first message that could not be sent. */
  const send = (msgs: readonly ClientMessage[]): boolean => {
    for (const m of msgs) if (!ctx.send(m)) return false
    return true
  }

  // ---- requests ----------------------------------------------------------------------------------------------------
  /** Steps down (stepDownPlan), then sends `then` (an attack). */
  const stepDown = (then: ClientMessage[] = []) => {
    const plan = stepDownPlan(isMoving(selfView()), then)
    pending = null
    if (send(plan.now) && plan.afterStop.length) pending = { send: plan.afterStop, until: wall() + DISMOUNT_WAIT_MS }
  }
  const flushPending = () => {
    const p = pending
    pending = null
    if (p && wall() <= p.until) send(p.send)
  }
  const ride = () => {
    const h = ownHorse()
    if (h && !h.dead) ctx.send({ t: 'mountRide', cos: h.id })
  }
  const dismount = () => stepDown()
  const dismissNow = () => {
    pending = null
    ctx.send({ t: 'mountDismiss' })
  }
  const dismissAsk = () => {
    const h = ownHorse()
    void MessageBox.confirm({ title: t('mount.dismiss.title'), text: t('mount.dismiss.confirm', { name: h?.displayName() ?? '' }) }).then(ok => {
      if (ok) dismissNow()
    })
  }

  // ---- frame ---------------------------------------------------------------------------------------------------------
  const frame = new MountFrame(kitArt(), { ride, dismount, dismiss: dismissAsk })
  frame.attach(ctx.hud.playerFrame?.petHost ?? null)
  const frameInfo = (): MountFrameInfo | null => {
    const h = ownHorse()
    if (!h) return null
    const def = ctx.app?.catalog?.cos(h.state.model)
    return {
      name: h.displayName(),
      level: h.state.level,
      hp: h.hp,
      maxHp: h.maxHp || def?.hp || 0,
      icon: def?.icon ?? null,
      mounted: h.state.rider !== undefined && h.state.rider === ctx.selfId(),
      dead: h.dead,
    }
  }
  const refreshFrame = () => {
    const info = frameInfo()
    const key = info ? JSON.stringify(info) : ''
    if (key === frameKey) return
    frameKey = key
    frame.set(info)
  }

  // ---- presentation --------------------------------------------------------------------------------------------------
  const at = (v: EntityView) => {
    const self = v.id === ctx.selfId() || (v instanceof HorseView && v.rider?.id === ctx.selfId())
    return {
      entity: v.id,
      pos: self ? undefined : { x: v.root.position.x, y: v.root.position.y + 1, z: v.root.position.z },
      self,
      priority: audio?.priorityOf(v.id, v.kind, self),
    }
  }
  const cue = (name: string, v: EntityView, unique = false) => {
    try {
      audio?.play(name, { ...at(v), unique })
    } catch (err) {
      console.warn('[mount] sound failed', name, err)
    }
  }
  const later = (ms: number, fn: () => void) => {
    const id = setTimeout(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
  }
  const summoned = (h: HorseView) => {
    if (h.own) audio?.ui('ui.cos_summon')
    else cue('ui.cos_summon', h)
    cue('cos.horse.stand', h)
    try {
      systemFxFor(ctx.scene).play('SYSTEM_PET_APPEAR', 'start', h)
    } catch (err) {
      console.warn('[mount] appear effect failed', err)
    }
  }
  const died = (h: HorseView) => {
    cue('cos.horse.die', h)
    later(THUD_DELAY_MS, () => {
      if (!h.isDisposed) cue('cos.horse.thud', h)
    })
  }

  // ---- ride links ----------------------------------------------------------------------------------------------------
  const endLink = (id: number) => {
    links.get(id)?.dispose()
    links.delete(id)
  }
  const reconcile = (dtMs: number) => {
    for (const h of horses) {
      const riderId = h.state.rider
      const rider = riderId !== undefined ? ctx.view(riderId) : undefined
      const link = links.get(h.id)
      const ready = !!rider && rider.kind === 'player' && !rider.isDisposed && !!rider.actor && !!h.actor && !h.dead && !h.isDisposed
      if (ready) {
        if (!link || !link.riding || link.rider !== rider || link.actor !== rider.actor) {
          if (link) endLink(h.id)
          try {
            links.set(h.id, new RideLink(h, rider, ctx.scene, seated.has(h.id)))
          } catch (err) {
            console.error('[mount] ride link failed', err)
          }
          seated.delete(h.id)
        }
      } else if (link?.riding) {
        // Stepped down (or the horse died): the tween back to the ground, unless the rider is gone.
        if (!rider || rider.isDisposed || link.rider !== rider) endLink(h.id)
        else link.leave()
      }
    }
    for (const [id, link] of links) if (!link.sync(dtMs)) endLink(id)
  }

  // ---- hooks ---------------------------------------------------------------------------------------------------------
  const offs = [
    ctx.chat.registerPrefix(DISMOUNT_COMMAND, () => dismount()),
    ctx.chat.registerPrefix(UNSUMMON_COMMAND, () => dismissNow()),
  ]
  refreshFrame()

  return {
    onMessage(msg: ServerMessage) {
      switch (msg.t) {
        case 'worldEnter':
          pending = null
          enteredAt = wall()
          spawned.clear()
          seated.clear()
          for (const e of msg.entities) if (e.kind === 'cos' && e.rider !== undefined) seated.add(e.id)
          break
        case 'spawn': {
          const e = msg.entity
          if (e.kind !== 'cos') break
          if (e.rider !== undefined) seated.add(e.id)
          else if (wall() - enteredAt > ENTER_QUIET_MS) spawned.set(e.id, wall())
          break
        }
        case 'despawn':
          spawned.delete(msg.id)
          seated.delete(msg.id)
          break
        case 'entityUpdate': {
          const v = ctx.view(msg.id)
          if (!v || (msg.mount === undefined && msg.rider === undefined && msg.hp === undefined && msg.state === undefined)) break
          applyMountUpdate(v.state, msg)
          if (!(v instanceof HorseView)) break
          if (msg.rider !== undefined) {
            v.refreshOwner()
            const at0 = spawned.get(v.id)
            spawned.delete(v.id)
            if (msg.rider !== null && at0 !== undefined && wall() - at0 <= SUMMON_WINDOW_MS) summoned(v)
          }
          if (msg.state === 'dead') died(v)
          break
        }
        case 'stop':
          // A ridden horse stays put for a moment: this stop may be the dismount's step aside (HorseView.hold).
          for (const h of horses) if (h.state.rider === msg.id) h.hold(STOP_HOLD_S)
          if (pending && msg.id === ctx.selfId()) flushPending()
          break
        case 'warp':
          for (const h of horses) if (h.state.rider === msg.id) h.release()
          break
        case 'actionResult':
          if (msg.re === 'stopAction' && pending) {
            if (msg.ok) flushPending()
            else pending = null
          }
          if (!msg.ok && MOUNT_REQUESTS.has(msg.re) && msg.reason !== 'rate_limited') ctx.hud.toast(mountFailText(msg.reason, msg.message), 'error')
          break
      }
    },

    onCombatHit(msg: CombatMessage, index: number) {
      const v = ctx.view(msg.target)
      const hit = msg.hits[index]
      if (!(v instanceof HorseView) || !hit || v.dead) return
      if (hit.outcome === 'crit') cue('cos.horse.moanCrit', v)
      else if (hit.outcome === 'hit') cue('cos.horse.moan', v)
    },

    clickEntity(v: EntityView): boolean {
      if (v instanceof HorseView || v.kind === 'cos') {
        // Your own parked horse: ride it (the server walks you there). Anyone else's: nothing.
        const h = v as HorseView
        if (h.own && !h.dead && h.state.rider === undefined && !selfView()?.dead) ctx.send({ t: 'mountRide', cos: h.id })
        return true
      }
      if (v.kind !== 'mob' || v.dead || !mounted() || selfView()?.dead) return false
      // Mounted: step down, then attack (docs/SYSTEMS_COMBAT.md §1.5).
      ctx.setTarget(v)
      stepDown([{ t: 'attack', target: v.id }])
      return true
    },

    beforeGroundMove() {
      // A ground click drops a stop-first dismount still waiting (it never consumes the click).
      pending = null
      return false
    },

    onEntityAdded(v: EntityView) {
      if (v instanceof HorseView) horses.add(v)
    },

    onEntityRemoved(v: EntityView) {
      if (v instanceof HorseView) {
        horses.delete(v)
        endLink(v.id)
      }
      for (const [id, link] of links) if (link.rider === v) endLink(id)
    },

    onFrame(_now: number, dt: number) {
      const ms = dt * 1000
      reconcile(ms)
      if (pending && wall() > pending.until) pending = null
      runT -= ms
      if (runT <= 0 && audio) {
        runT = RUN_CUE_MS
        for (const h of horses) if (h.rider && h.moving && !h.dead) cue('cos.horse.run', h, true)
      }
      frameT -= ms
      if (frameT <= 0) {
        frameT = FRAME_REFRESH_MS
        refreshFrame()
      }
    },

    dispose() {
      for (const id of [...links.keys()]) endLink(id)
      for (const id of timers) clearTimeout(id)
      timers.clear()
      for (const off of offs) off()
      offKind()
      frame.dispose()
      horses.clear()
    },
  }
}
