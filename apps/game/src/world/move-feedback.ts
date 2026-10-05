/**
 * Click-to-move feel (docs/UX_GAPS.md K4, K5):
 * - hold to move: with the left button held after a ground click, the walk follows the cursor (a new `moveTo` every
 *   250 ms while the point moved more than 1 m; at most 4 a second against the 20/s connection budget);
 * - blocked-path feedback: the server walks a straight line and stops at the first blocking edge. When our own
 *   `move` ends more than 1.5 m short of the point asked for, or no `move` comes at all (refused or blocked at
 *   once), the feature shows a red marker at the point, a dashed line to where we stop, and "You cannot get there."
 *   at most once per 2 s. Options → Controls → "Warn when a spot cannot be reached" off (`warn`) silences all of it;
 *   the walk itself is the server's either way (it already stops at the last reachable point on the line).
 * - a world feature's `beforeGroundMove` veto (vetoGroundMove, wave 8) ends the hold instead of sending the step.
 * - MV-WASD: the movement keys taking over (noteKeyMove) end the hold and forget the request, like an entity click.
 * The world screen reports each ground click with `noteGroundMove`; the rest is driven by the ux-world feature.
 * Pure logic with injected dependencies (tested without a scene).
 */
import type { ClientMessage, MoveState } from '@sro/shared'
import { intents } from './intents.ts'

export const HOLD_RESEND_MS = 250
export const HOLD_MIN_STEP = 1
export const BLOCKED_TOLERANCE = 1.5
/** No own `move` this long after a request (plus 1.5 round trips) = refused or blocked at once. */
export const NO_MOVE_MS = 400
export const BLOCKED_MESSAGE_MS = 2000

export interface GroundPoint {
  x: number
  z: number
}

const groundMoves = new Set<(p: GroundPoint) => void>()

/** screens/world.ts: a click on the ground sent `moveTo` to `p`. */
export function noteGroundMove(p: GroundPoint): void {
  for (const fn of groundMoves) {
    try {
      fn({ x: p.x, z: p.z })
    } catch (err) {
      console.error('[world] ground move listener failed', err)
    }
  }
}

export function onGroundMove(fn: (p: GroundPoint) => void): () => void {
  groundMoves.add(fn)
  return () => groundMoves.delete(fn)
}

const keyMoves = new Set<() => void>()

/** MV-WASD (world/features/keymove.ts): the movement keys took over; a click walk in progress ends (hold, blocked check). */
export function noteKeyMove(): void {
  for (const fn of keyMoves) {
    try {
      fn()
    } catch (err) {
      console.error('[world] key move listener failed', err)
    }
  }
}

export function onKeyMove(fn: () => void): () => void {
  keyMoves.add(fn)
  return () => keyMoves.delete(fn)
}

const groundVetoes = new Set<() => boolean>()

/**
 * screens/world.ts registers the features' `beforeGroundMove` (docs/WAVE_PLAN2.md §4.3) so a hold-to-move step asks
 * it too: true = consumed, the step is not sent and the hold ends. Returns an unregister function.
 */
export function vetoGroundMove(fn: () => boolean): () => void {
  groundVetoes.add(fn)
  return () => groundVetoes.delete(fn)
}

/** True when a registered veto consumes the next ground move (a throwing veto is logged and allows). */
export function groundMoveVetoed(): boolean {
  for (const fn of groundVetoes) {
    try {
      if (fn()) return true
    } catch (err) {
      console.error('[world] ground move veto failed', err)
    }
  }
  return false
}

export interface MoveFeedbackDeps {
  send(msg: ClientMessage): boolean
  /** Own position (null while dead or not in the world). */
  self(): GroundPoint | null
  /** The walkable point under the cursor right now. */
  cursorGround(): GroundPoint | null
  holdToMove(): boolean
  /** Round trip in ms (Infinity when unknown). */
  rtt(): number
  /** The walk to `wanted` stops at `stop` (or never starts: stop = where we stand); `message` = show the line. */
  blocked(wanted: GroundPoint, stop: GroundPoint, message: boolean): void
  /**
   * Options → Controls → "Warn when a spot cannot be reached" (settings.controls.unreachableWarning). False: a short
   * walk is not reported at all (no marker, no line, no sound). Absent = on.
   */
  warn?(): boolean
}

export class MoveFeedback {
  private holding = false
  private lastSentAt = -Infinity
  private lastSent: GroundPoint | null = null
  /** The newest request still waiting for our own `move`. */
  private pending: { p: GroundPoint; at: number } | null = null
  private lastMessageAt = -Infinity

  constructor(private readonly deps: MoveFeedbackDeps) {}

  /** A ground click sent `moveTo p` (the button is down). */
  begin(p: GroundPoint, now: number): void {
    this.holding = true
    this.request(p, now)
  }

  /** The left button went up (or the window lost focus). */
  end(): void {
    this.holding = false
  }

  /** Something else took over (entity click, death, warp): stop following the cursor and forget the request. */
  cancel(): void {
    this.holding = false
    this.pending = null
  }

  get isHolding(): boolean {
    return this.holding
  }

  /** Our own `move` arrived. */
  onSelfMove(move: MoveState, now: number): void {
    const req = this.pending
    if (!req) return
    this.pending = null
    const to = { x: move.to[0], z: move.to[2] }
    if (Math.hypot(to.x - req.p.x, to.z - req.p.z) > BLOCKED_TOLERANCE) this.report(req.p, to, now)
  }

  /** Per frame: hold-to-move re-sends and the "no move came" check. */
  tick(now: number): void {
    const req = this.pending
    if (req) {
      const rtt = this.deps.rtt()
      const wait = NO_MOVE_MS + (Number.isFinite(rtt) ? rtt * 1.5 : 300)
      if (now - req.at > wait) {
        this.pending = null
        const self = this.deps.self()
        if (self && Math.hypot(self.x - req.p.x, self.z - req.p.z) > BLOCKED_TOLERANCE) this.report(req.p, self, now)
      }
    }
    if (!this.holding || !this.deps.holdToMove() || now - this.lastSentAt < HOLD_RESEND_MS) return
    const p = this.deps.cursorGround()
    if (!p || (this.lastSent && Math.hypot(p.x - this.lastSent.x, p.z - this.lastSent.z) <= HOLD_MIN_STEP)) return
    const self = this.deps.self()
    if (!self) return this.cancel()
    if (groundMoveVetoed()) return this.end()
    if (this.deps.send(intents.moveTo(p.x, p.z))) this.request(p, now)
  }

  private request(p: GroundPoint, now: number): void {
    this.lastSent = p
    this.lastSentAt = now
    const self = this.deps.self()
    // A point where we already stand needs no move: nothing to check.
    this.pending = self && Math.hypot(self.x - p.x, self.z - p.z) > BLOCKED_TOLERANCE ? { p, at: now } : null
  }

  private report(wanted: GroundPoint, stop: GroundPoint, now: number): void {
    if (this.deps.warn && !this.deps.warn()) return
    const message = now - this.lastMessageAt >= BLOCKED_MESSAGE_MS
    if (message) this.lastMessageAt = now
    this.deps.blocked(wanted, stop, message)
  }
}
