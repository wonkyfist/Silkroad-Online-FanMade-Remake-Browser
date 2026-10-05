/**
 * Wave 10 (docs/MOVEMENT.md §6, jump only; lane MV-C): the jump on Space.
 *  - Space (KeyMap group `movement`; never on key repeat) sends `jump` (world/intents.ts). A client cooldown gate
 *    (JUMP_COOLDOWN_MS from the last press it sent) drops a spammed Space silently: no send, no toast.
 *  - Prediction: the own character starts the clip on the key press, and the server's echo of that press is ignored.
 *    The echo is matched to its request, not to a timer (MV-1: a window on the local clock measures the round trip,
 *    the viewers' late drop one way, so a 600–1200 ms round trip played the jump twice): every press sent joins a FIFO
 *    (JumpEcho), a refusal (`actionResult {re:'jump', ok:false}`, or `error {re:'jump'}`) takes its entry out (no echo
 *    will come), and the own `jump` echo takes the oldest entry and is swallowed when that press was predicted. No
 *    prediction where the client knows it would look wrong (§6.3,
 *    fact-check 2): sitting (the server stands the sitter up first, then the echoed jump plays), a skill action or a
 *    return-scroll cast, mounted, a stall owner, dead, or held (stunned, frozen, knocked down, knocked back). The
 *    request is still sent; the server decides.
 *  - Every other `jump {id, at}` plays on that view (EntityView.jump: the late drop, the one seek budget).
 *  - Refusals: a toast only for `mounted` and `stalling` (i18n/en-movement.ts); dead, cant_act, busy and cooldown are
 *    silent (the jump is cosmetic).
 *  - A focused non-typing element (the last clicked HUD button) is blurred on Space, so the browser's
 *    Space-activates-button on keyup cannot click it (§6.3).
 *  - The movement pack is loaded per player actor once its model is in (after worldEnter; never on the stages, D32).
 * The jump has no per-frame work (no onFrame of its own, and the per-view attachment has no update).
 *
 * MV-WASD (docs/MOVEMENT.md §13): walking with W A S D and the arrows is world/features/keymove.ts, composed here (this
 * feature stays the last one, WAVE_PLAN6 §4.2) when the context has the world camera and scene (lane tests without
 * them get the jump alone). Its onFrame and onMessage run after the jump's.
 */
import { JUMP_COOLDOWN_MS, JUMP_LATE_DROP_MS, type ServerMessage, type SkillStatusKind } from '@sro/shared'
import { isTypingTarget } from '../../hud/keys.ts'
import { t } from '../../i18n/index.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { intents } from '../intents.ts'
import { isPiloting } from '../pilot-model.ts'
import { keyMoveFeature } from './keymove.ts'

/** The Space key as KeyboardEvent.key reports it (normalizeKey keeps it). */
export const JUMP_KEYS: readonly string[] = [' ']
/** Crowd control that holds a body still (the server's STATUS_RULES `blocks`): the server refuses `cant_act`. */
export const HELD_STATUSES: ReadonlySet<SkillStatusKind> = new Set<SkillStatusKind>(['stun', 'freeze', 'knockdown', 'knockback'])

/** What the own character is doing, as far as the client knows (the no-prediction rules, MOVEMENT §6.3). */
export interface JumpSelfState {
  dead: boolean
  seated: boolean
  mounted: boolean
  stallOwner: boolean
  held: boolean
  skillAction: boolean
  scrollCast: boolean
}

/** True when the own character may start the jump on the key press (else it waits for the server's echo). */
export function predictsJump(s: JumpSelfState): boolean {
  return !s.dead && !s.seated && !s.mounted && !s.stallOwner && !s.held && !s.skillAction && !s.scrollCast
}

/** The client's own cooldown gate: one press a JUMP_COOLDOWN_MS (a spammed Space is dropped, no toast). */
export class JumpGate {
  private readyAt = -Infinity

  constructor(private readonly cooldownMs = JUMP_COOLDOWN_MS) {}

  /** True (and the gate closes for the cooldown) when a jump may be sent at `now` (ms). */
  press(now: number): boolean {
    if (now < this.readyAt) return false
    this.readyAt = now + this.cooldownMs
    return true
  }

  reset(): void {
    this.readyAt = -Infinity
  }
}

/**
 * A request in flight is forgotten this long (local ms) after its press: one whose answer never came (the connection's
 * global rate limit drops a message with an `error` that names no request). An echo later than that has a one-way
 * delay past JUMP_LATE_DROP_MS on any but a very lopsided link, so the view drops it anyway.
 */
export const JUMP_ECHO_EXPIRY_MS = JUMP_COOLDOWN_MS + 2 * JUMP_LATE_DROP_MS

/**
 * The own jump requests in flight, oldest first (the server answers and echoes them in order): the echo of a predicted
 * press is ignored (the clip would restart), the echo of one not predicted plays (MV-1).
 */
export class JumpEcho {
  private readonly pending: { at: number; predicted: boolean }[] = []

  constructor(private readonly expiryMs = JUMP_ECHO_EXPIRY_MS) {}

  /** A jump request was sent at `now` (local ms); `predicted`: its clip already plays. */
  sent(now: number, predicted: boolean): void {
    this.pending.push({ at: now, predicted })
  }

  /** The server refused the oldest request in flight: no echo will come for it. */
  refused(now: number): void {
    this.expire(now)
    this.pending.shift()
  }

  /** The own echo arrived at `now`: true when it belongs to a predicted press (its entry is consumed either way). */
  swallow(now: number): boolean {
    this.expire(now)
    return this.pending.shift()?.predicted ?? false
  }

  /** Requests in flight (tests). */
  get size(): number {
    return this.pending.length
  }

  reset(): void {
    this.pending.length = 0
  }

  private expire(now: number): void {
    while (this.pending.length && now - this.pending[0].at > this.expiryMs) this.pending.shift()
  }
}

/** Blurs a focused element that is not a typing target (a button the player last clicked), so Space cannot click it. */
export function blurFocusedControl(target: EventTarget | null, active: Element | null = typeof document !== 'undefined' ? document.activeElement : null): void {
  for (const el of [target, active]) {
    const n = el as { blur?: unknown; tagName?: unknown } | null
    if (!n || typeof n.blur !== 'function' || isTypingTarget(n as EventTarget)) continue
    if (n.tagName === 'BODY' || n.tagName === 'HTML') continue
    ;(n.blur as () => void).call(n)
  }
}

/**
 * `clock`: the local monotonic clock (ms) of the gate and the echo FIFO's expiry. Not the server clock: a clock resync
 * step between the press and the echo would otherwise reopen the gate early.
 */
export function movementFeature(ctx: WorldFeatureContext, clock: () => number = () => performance.now()): WorldFeature {
  const gate = new JumpGate()
  const echo = new JumpEcho()
  /** Own held statuses by effect instance (effectAdd / effectRemove / the spawn's effects). */
  const held = new Set<number>()
  let scrollCast = false
  const offs: (() => void)[] = []

  const self = (): EntityView | undefined => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }

  const selfState = (v: EntityView): JumpSelfState => ({
    dead: v.dead,
    seated: v.idle === 'sit' || v.idle === 'vendor' || v.state.posture === 'sit',
    mounted: v.state.mount !== undefined || v.actor?.clipGroup === 'cart',
    stallOwner: v.state.stall !== undefined,
    held: held.size > 0,
    skillAction: !!v.actor?.skillActing,
    scrollCast,
  })

  const loadClips = (v: EntityView) => {
    if (v.kind === 'player') void v.actor?.ensureMovementClips()
  }

  const press = (ev: KeyboardEvent) => {
    blurFocusedControl(ev.target)
    const v = self()
    if (!v || v.dead) return
    if (!gate.press(clock())) return
    const sent = ctx.send(intents.jump())
    if (!sent) return
    const now = ctx.serverNow()
    echo.sent(clock(), predictsJump(selfState(v)) && v.jump(now, now))
  }

  // Play the Boss (docs/PLAY_THE_BOSS.md §4.2): Space does nothing while piloting (the body in its trance cannot jump).
  offs.push(ctx.keys.register({ id: 'movement.jump', keys: [...JUMP_KEYS], label: 'movement.key.jump', group: 'movement', when: () => !isPiloting(ctx), run: press }))
  // The movement pack per player actor once its model is in (views from now on), and for the views already there.
  offs.push(ctx.addAttachment(v => (v.kind === 'player' ? { loaded: () => loadClips(v), dispose() {} } : null)))
  for (const v of ctx.views()) loadClips(v)

  const resetSelf = () => {
    held.clear()
    scrollCast = false
    echo.reset()
    gate.reset()
  }

  // MV-WASD: the key walk needs the camera (its direction) and the scene (the click hook).
  const keyMove = ctx.camera && ctx.scene ? keyMoveFeature(ctx) : null

  return {
    onFrame: keyMove ? (now: number, dt: number) => keyMove.onFrame?.(now, dt) : undefined,
    onMessage(msg: ServerMessage) {
      jumpMessage(msg)
      keyMove?.onMessage?.(msg)
    },
    onEntityAdded(v) {
      if (v.id === ctx.selfId()) {
        held.clear()
        for (const e of v.state.effects ?? []) if (e.status && HELD_STATUSES.has(e.status)) held.add(e.instance)
      }
      keyMove?.onEntityAdded?.(v)
    },
    dispose() {
      keyMove?.dispose?.()
      for (const off of offs.splice(0)) off()
    },
  }

  function jumpMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'jump':
        if (msg.id === ctx.selfId() && echo.swallow(clock())) break
        ctx.view(msg.id)?.jump(msg.at, ctx.serverNow())
        break
      case 'actionResult':
        if (msg.re !== 'jump' || msg.ok) break
        echo.refused(clock())
        if (msg.reason === 'mounted') ctx.hud.toast(t('movement.fail.mounted'), 'error')
        else if (msg.reason === 'stalling') ctx.hud.toast(t('movement.fail.stalling'), 'error')
        break
      case 'error':
        if (msg.re === 'jump') echo.refused(clock())
        break
      case 'effectAdd':
        if (msg.id === ctx.selfId() && msg.effect.status && HELD_STATUSES.has(msg.effect.status)) held.add(msg.effect.instance)
        break
      case 'effectRemove':
        if (msg.id === ctx.selfId()) held.delete(msg.instance)
        break
      case 'itemCast':
        if (msg.id === ctx.selfId()) scrollCast = true
        break
      case 'itemCastEnd':
        if (msg.id === ctx.selfId()) scrollCast = false
        break
      case 'worldEnter':
        resetSelf()
        break
    }
  }
}
