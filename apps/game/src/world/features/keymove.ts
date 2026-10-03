/**
 * MV-WASD (docs/MOVEMENT.md §13): walking with W A S D and the arrow keys, next to the click-to-move that stays as it is.
 *
 * - Keys (KeyMap group `movement`, ids `movement.forward|back|left|right`): W / ↑ forward, S / ↓ back, A / ← left,
 *   D / → right, RELATIVE TO THE CAMERA (its look direction on the ground); two keys give the diagonal, normalised.
 *   Only while Options → Controls → Keyboard movement is on (default on; off gives the arrows back to the camera,
 *   world/camera-keys.ts). Never while typing or while a modal is open (the KeyMap skips those keydowns, and a walk in
 *   progress stops when a text field takes the focus or a modal opens). S no longer opens the Skills window (K does).
 * - The server stays the authority, with the existing `moveTo` (no protocol change): while a key is held the client
 *   sends a target LOOKAHEAD_S of walking ahead along the direction, at once on a turn (≥ SEND_TURN_RAD) and else as a
 *   keep-alive every KEEPALIVE_MS, through a SEND_RATE / SEND_BURST bucket (10/s, 3 at once, against the server's 20/s). The
 *   server walks each one on its navmesh from its live point, as for a click; consecutive targets on a straight line
 *   continue the same line, so the other players see one smooth walk. On release the walk runs on for about one
 *   latency (RUN_ON_S) and the client sends that stop point as the last target; the server walks the few decimetres it
 *   is behind and stops there, just as the others hear of it (no walking past it and snapping back on their screens).
 * - Prediction: the own character moves on the key press. Its walk is planned on the client navmesh (the same data
 *   the server walks; the straight chord stops at a blocking edge), so it never walks through a blocked edge. Against
 *   a wall it slides along it when the keys point along it by more than 30° (chooseStep: the smallest turn, up to
 *   SLIDE_MAX_RAD, that gives SLIDE_FREE_M of free walk, then SLIDE_MARGIN_RAD away from the wall); straight into a
 *   wall it stops. The prediction overrides the
 *   own `move` / `stop` echoes (after the world screen applied them) while it runs; it may lead the server by the
 *   walk of half a round trip plus a slack (reconcile), and is pulled back toward the server when it gets further.
 *   After the release it holds the stop point until the server's stop there (or, after SETTLE_MIN_MS, takes the
 *   server's word: a glide for a few metres, else a snap).
 * - Clicks and keys: a left click in the world (ground, monster, item, NPC) ends a key walk without a stop (the click's
 *   own request drives); a key press ends a click walk (hold to move, the blocked-path check, an approach) and its
 *   `moveTo` ends the server's walk or chase, as a click does. An accepted attack, skill, pick-up or NPC talk also ends
 *   the key walk (the action takes over); the keys need a new press after either.
 * - Mounted, buffed or GM speed: the speed of the own latest `move` (DEFAULT_SPEED until one came). Dead: nothing. A
 *   stall owner: the features' `beforeGroundMove` veto (its "Close your stall first."). Space jumps while walking.
 * The pure parts (cameraRelative, chooseStep, KeyMover with injected dependencies) run in node tests.
 */
import { PointerEventTypes, type Observer, type PointerInfo } from '@babylonjs/core'
import type { NavGltf, NavMoveResult, NavPosition } from '@sro/nav'
import type { ClientMessage, MoveState, ServerMessage, Vec3 } from '@sro/shared'
import { NavWalker, spawnAt } from '@sro/world-render'
import { isTypingTarget, type KeyBinding } from '../../hud/keys.ts'
import type { StringKey } from '../../i18n/index.ts'
import { sampleMove } from '../../net/clock.ts'
import { settings } from '../../settings.ts'
import { cancelApproach } from '../approach.ts'
import { holdCameraFollow } from '../camera-keys.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { intents } from '../intents.ts'
import { groundMoveVetoed, noteKeyMove } from '../move-feedback.ts'

export type MoveKey = 'forward' | 'back' | 'left' | 'right'

/** The keys of each direction (KeyboardEvent.key as normalizeKey gives it): W A S D, the arrows as aliases. */
export const MOVE_KEYS: Readonly<Record<MoveKey, readonly string[]>> = {
  forward: ['w', 'arrowup'],
  back: ['s', 'arrowdown'],
  left: ['a', 'arrowleft'],
  right: ['d', 'arrowright'],
}
export const MOVE_KEY_ORDER: readonly MoveKey[] = ['forward', 'back', 'left', 'right']
const LABELS: Readonly<Record<MoveKey, StringKey>> = {
  forward: 'movement.key.forward',
  back: 'movement.key.back',
  left: 'movement.key.left',
  right: 'movement.key.right',
}

/** The server's default run speed (config MOVE_SPEED, m/s) until an own `move` tells the real one (mount, buff, GM). */
export const DEFAULT_SPEED = 5.5
/**
 * The target sent goes this much walking ahead of the predicted point (s), and at least LOOKAHEAD_MIN_M: with the
 * keep-alive every KEEPALIVE_MS the server's walk never runs out within 0.75 s of a late keep-alive (jitter, a frame
 * hitch), and the release still stops it exactly where the client did.
 */
export const LOOKAHEAD_S = 1
export const LOOKAHEAD_MIN_M = 3
/**
 * Sends: at once on a turn of SEND_TURN_RAD, else a keep-alive every KEEPALIVE_MS, through a bucket of SEND_BURST
 * that refills at SEND_RATE a second (mashed keys or a dragged camera never pass 10/s; the server allows 20/s). A
 * release waits for a token (the walk runs on until then), so the stop always goes out at once with its own point.
 */
export const SEND_RATE = 10
export const SEND_BURST = 3
/** The timer that runs the sends while a walk is on (slow frames do not hold back the keep-alives). */
export const TICK_MS = 100
export const KEEPALIVE_MS = 250
export const SEND_TURN_RAD = (4 * Math.PI) / 180
/** The local walk is planned again on a turn of REPLAN_TURN_RAD, when it ends, and every REPLAN_MS. */
export const REPLAN_TURN_RAD = (1 * Math.PI) / 180
export const REPLAN_MS = 200
/** The local walk is probed this much walking ahead (s), and at least PROBE_MIN_M (a frame hitch shorter than that never stalls it). */
export const PROBE_S = 1
export const PROBE_MIN_M = 1.5
/** Sliding starts when the straight walk is blocked within SLIDE_TRIGGER_M (SLIDE_STICKY_M while already sliding). */
export const SLIDE_TRIGGER_M = 0.3
export const SLIDE_STICKY_M = 1
/** A slide direction must give this much free walk (m); turns are tried in SLIDE_STEP_RAD steps up to SLIDE_MAX_RAD. */
export const SLIDE_FREE_M = 1
export const SLIDE_STEP_RAD = (15 * Math.PI) / 180
export const SLIDE_MAX_RAD = (60 * Math.PI) / 180
/** Bisections between the last blocked and the first free turn (15° / 2^3 ≈ 2°). */
export const SLIDE_BISECT = 3
/**
 * The slide turns this much further, away from the wall, when that is free too: the bisected turn can still point a
 * degree into the wall, and the server's chord to a target metres ahead would then stop at the wall before the next
 * keep-alive (a stop and a start for everyone watching).
 */
export const SLIDE_MARGIN_RAD = (2.5 * Math.PI) / 180
/** The prediction may lead the server by the walk of half a round trip plus LEAD_SLACK_S, plus DRIFT_M. */
export const LEAD_SLACK_S = 0.25
export const DRIFT_M = 0.75
/** A round trip not measured yet counts as this (ms). */
export const DEFAULT_RTT_MS = 150
/**
 * On release the walk runs on for half a round trip plus RUN_ON_S (at most RUN_ON_MAX_S) before it stops. Everyone
 * else draws us at the server's time and learns of the stop one latency late: with no run-on they would walk past
 * the stop point and snap back; with it the server's last chord reaches the stop point when they hear of it. The own
 * character stops 2 to 9 frames after the key comes up.
 */
export const RUN_ON_S = 0.03
export const RUN_ON_MAX_S = 0.15
/** After the release the stop point is held at least this long (ms; 2 round trips + 250 ms when longer). */
export const SETTLE_MIN_MS = 500
/** The server stopped within this of the stop point: done (m). */
export const SETTLE_EPS_M = 0.05
/** A server correction after the hold: a snap up to SNAP_M, a glide up to GLIDE_MAX_M, a snap beyond. */
export const SNAP_M = 0.6
export const GLIDE_MAX_M = 4
/** Accepted requests whose action takes over from the keys (the server walks, chases or casts for them). */
export const TAKE_OVER: ReadonlySet<string> = new Set(['attack', 'useSkill', 'pickup', 'npcTalk'])

export interface Dir {
  x: number
  z: number
}

/** The held keys as axes: x = right − left, y = forward − back. */
export function keyAxes(held: ReadonlySet<MoveKey>): { x: number; y: number } {
  return { x: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0), y: (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0) }
}

/**
 * The ground direction (unit XZ) of key axes for an ArcRotateCamera at `alpha`: forward is where the camera looks
 * (from its position toward its target), right is the screen's right (right-handed scene: forward × up). null when the
 * keys cancel out (W + S, or none).
 */
export function cameraRelative(axes: { x: number; y: number }, alpha: number, rightHanded = true): Dir | null {
  if (!axes.x && !axes.y) return null
  const fx = -Math.cos(alpha)
  const fz = -Math.sin(alpha)
  const rx = rightHanded ? -fz : fz
  const rz = rightHanded ? fx : -fx
  const x = fx * axes.y + rx * axes.x
  const z = fz * axes.y + rz * axes.x
  const l = Math.hypot(x, z)
  return l > 1e-9 ? { x: x / l, z: z / l } : null
}

/** `d` turned by `a` radians about +Y in the XZ plane. */
export function rotate(d: Dir, a: number): Dir {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: d.x * c - d.z * s, z: d.x * s + d.z * c }
}

/** The angle between two unit directions (0..π). */
export function angleBetween(a: Dir, b: Dir): number {
  return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z)))
}

/** A straight walk from the predicted point: where it stops (glTF metres), whether a blocker clipped it, its length. */
export interface Probe {
  x: number
  y: number
  z: number
  blocked: boolean
  distance: number
}

export interface Step {
  dir: Dir
  /** The probe of `dir` (null without a navmesh: straight and unclipped). */
  probe: Probe | null
  /** True when `dir` is a slide (not the keys' own direction). */
  slid: boolean
}

/**
 * The direction to walk for the keys' direction `want`, with `probe(dir)` a straight walk of the probe length:
 * - straight when it is not blocked within SLIDE_TRIGGER_M (SLIDE_STICKY_M while sliding: no zig-zag along a wall);
 * - else the smallest turn to either side, up to SLIDE_MAX_RAD (found in SLIDE_STEP_RAD steps, then bisected), whose
 *   walk is free for SLIDE_FREE_M: the walk slides along the wall, nearly parallel to it;
 * - else straight (into the wall: the walk stops at it).
 */
export function chooseStep(want: Dir, probe: (d: Dir) => Probe | null, sliding = false): Step {
  const straight = probe(want)
  if (!straight) return { dir: want, probe: null, slid: false }
  const trigger = sliding ? SLIDE_STICKY_M : SLIDE_TRIGGER_M
  if (!straight.blocked || straight.distance >= trigger) return { dir: want, probe: straight, slid: false }
  const free = (p: Probe | null): p is Probe => !!p && (!p.blocked || p.distance >= SLIDE_FREE_M)
  let best: Step | null = null
  let bestAngle = Infinity
  for (const side of [1, -1]) {
    let lo = 0
    let hi = -1
    let hit: Probe | null = null
    for (let a = SLIDE_STEP_RAD; a <= SLIDE_MAX_RAD + 1e-9; a += SLIDE_STEP_RAD) {
      const p = probe(rotate(want, side * a))
      if (free(p)) {
        hi = a
        hit = p
        break
      }
      lo = a
    }
    if (hi < 0 || !hit) continue
    for (let i = 0; i < SLIDE_BISECT; i++) {
      const mid = (lo + hi) / 2
      const p = probe(rotate(want, side * mid))
      if (free(p)) {
        hi = mid
        hit = p
      } else lo = mid
    }
    if (hi < bestAngle - 1e-9 || (best?.probe && Math.abs(hi - bestAngle) <= 1e-9 && hit.distance > best.probe.distance)) {
      let dir = rotate(want, side * hi)
      const wider = rotate(want, side * (hi + SLIDE_MARGIN_RAD))
      const p = probe(wider)
      if (p && !p.blocked) {
        dir = wider
        hit = p
      }
      best = { dir, probe: hit, slid: true }
      bestAngle = hi
    }
  }
  return best ?? { dir: want, probe: straight, slid: false }
}

/** The client navmesh as the key walk uses it: one retained walker at the predicted point. */
export interface KeyNav {
  /** No retained surface (a start, a correction, the nav back after streaming): stand at x/z on the surface nearest y. */
  place(x: number, y: number, z: number): void
  /** The predicted point is `d` metres along the committed walk. */
  advance(d: number): void
  /** A straight walk from the predicted point toward (x, z); nothing is kept. */
  probe(x: number, z: number): Probe
  /** The same walk, kept: the predicted point follows it from now on. */
  commit(x: number, z: number): Probe
}

function probeOf(r: NavMoveResult): Probe {
  return { x: r.end.x, y: r.end.y, z: r.end.z, blocked: r.blocked, distance: r.distance }
}

/** KeyNav over the world's NavGltf: a NavWalker carries the surface of each leg (bridges, stairs, the plaza). */
export function gltfKeyNav(nav: NavGltf): KeyNav {
  let walker: NavWalker | null = null
  let done = 0
  const start = (): NavPosition => {
    const w = walker!
    return w.moving ? (nav.settle(w.pos.surface, w.pos.x, w.pos.z) ?? w.pos) : w.pos
  }
  return {
    place(x, y, z) {
      walker = new NavWalker(nav, spawnAt(nav, x, z, Number.isFinite(y) ? y : Infinity))
      done = 0
    },
    advance(d) {
      if (!walker || !(d > done)) return
      walker.advance(d - done)
      done = d
    },
    probe(x, z) {
      return probeOf(nav.moveStraight(start(), x, z))
    },
    commit(x, z) {
      done = 0
      return probeOf(walker!.moveTo(x, z))
    },
  }
}

/** What the key walk needs of the own view (EntityView). */
export interface KeyMoveView {
  readonly pos: { readonly x: number; readonly y: number; readonly z: number }
  targetYaw: number
  readonly dead: boolean
  setMove(move: MoveState): void
  stop(pos: Vec3, yaw: number): void
}

export interface KeyMoveDeps {
  /** Sends one intent; false when not sent. */
  send(msg: ClientMessage): boolean
  /** Server time (ms): the clock the views are drawn at. */
  now(): number
  /** Round trip (ms; NaN or Infinity while unknown). */
  rtt(): number
  /** The own view (null before worldEnter). */
  self(): KeyMoveView | null
  /** The world camera's alpha (ArcRotateCamera). */
  cameraAlpha(): number
  readonly rightHanded: boolean
  /** Keyboard movement on, and the keyboard free (no text field focused, no modal open). */
  allowed(): boolean
  /** A world feature consumes ground moves now (a stall owner; it says why). */
  vetoed(): boolean
  /** The client navmesh around the box (x0, z0)–(x1, z1), or null (flat ground, regions not loaded). */
  nav(x0: number, z0: number, x1: number, z1: number): KeyNav | null
  /** The keys took over: a click walk in progress ends (hold to move, the blocked-path check, an approach). */
  tookOver(): void
}

type Mode = 'idle' | 'active' | 'settling'

const dist2 = (a: { x: number; z: number } | Vec3, b: { x: number; z: number } | Vec3): number => {
  const ax = Array.isArray(a) ? a[0] : (a as { x: number }).x
  const az = Array.isArray(a) ? a[2] : (a as { z: number }).z
  const bx = Array.isArray(b) ? b[0] : (b as { x: number }).x
  const bz = Array.isArray(b) ? b[2] : (b as { z: number }).z
  return Math.hypot(ax - bx, az - bz)
}

/** The coordinate as `intents.moveTo` sends it (cm). */
const cm = (v: number): number => Math.round(v * 100) / 100

/**
 * The key walk: held keys, the predicted walk, the sends and the reconciliation with the server (see the file header).
 * `idle`: the server drives the own view (click to move as before); `active`: keys held, the prediction drives it;
 * `settling`: released, the stop point is held until the server stops there.
 */
export class KeyMover {
  /** Physical keys held, by the direction they give. */
  private readonly keys = new Map<string, MoveKey>()
  private mode: Mode = 'idle'
  /** A press since the last take-over: a walk (re)starts while a direction is held. */
  private wanted = false
  /** The predicted walk (from the predicted point at `startedAt`, server ms). */
  private seg: MoveState | null = null
  /** Where the prediction stands when `seg` is null (a start, a correction). */
  private base: Vec3 = [0, 0, 0]
  /** The keys' direction `seg` was planned for, and the direction it walks (a slide may differ). */
  private planInput: Dir | null = null
  private planDir: Dir | null = null
  private sliding = false
  private planAt = -Infinity
  private startedAt = -Infinity
  private yaw = 0
  private sentAt = -Infinity
  private sentDir: Dir | null = null
  /** Send tokens (SEND_BURST at most, SEND_RATE a second) and when they were last counted. */
  private tokens = SEND_BURST
  private tokensAt = -Infinity
  /** The next target to send (the newest wins while the bucket is empty). */
  private pending: { x: number; z: number } | null = null
  private speed = DEFAULT_SPEED
  /** The own authoritative state: the latest own `move` or `stop` (or warp, spawn). */
  private server: { move: MoveState | null; pos: Vec3 } | null = null
  private stopAt: Vec3 | null = null
  /** The run-on from the release point to `stopAt` (null: none). */
  private tail: MoveState | null = null
  private settleUntil = 0
  private nav: KeyNav | null = null
  private navFresh = true
  /** Times the prediction was pulled back toward the server (tests, the debug overlay). */
  corrections = 0
  /** moveTo intents sent (tests). */
  sends = 0

  constructor(private readonly deps: KeyMoveDeps) {}

  get state(): Mode {
    return this.mode
  }

  get active(): boolean {
    return this.mode === 'active'
  }

  /** The directions held now. */
  held(): Set<MoveKey> {
    return new Set(this.keys.values())
  }

  /** The keys' ground direction now (camera-relative), or null. */
  direction(): Dir | null {
    return cameraRelative(keyAxes(this.held()), this.deps.cameraAlpha(), this.deps.rightHanded)
  }

  /** The predicted point at `now`. */
  at(now: number): Vec3 {
    return this.seg ? sampleMove(this.seg, now).pos : [...this.base]
  }

  /** A movement key went down (`key`: the physical key, `k`: its direction). */
  press(key: string, k: MoveKey, now = this.deps.now()): void {
    this.keys.set(key, k)
    this.wanted = true
    if (this.mode === 'active') {
      if (this.direction()) {
        this.plan(now)
        this.wantSend(now)
        this.flush(now)
      } else this.letGo(now)
    } else {
      this.tryStart(now)
      this.flush(now)
    }
  }

  /** A movement key went up; `key` '' (the KeyMap's blur stand-in) lets go of every key of direction `k`. */
  release(key: string, k: MoveKey, now = this.deps.now()): void {
    if (key) this.keys.delete(key)
    else for (const [name, dir] of [...this.keys]) if (dir === k) this.keys.delete(name)
    if (!this.keys.size) this.wanted = false
    if (this.mode !== 'active') return
    if (!this.direction()) this.letGo(now)
    else {
      this.plan(now)
      this.wantSend(now)
      this.flush(now)
    }
  }

  /** Every key let go (focus lost to a text field, a modal, the option off). */
  releaseAll(now = this.deps.now()): void {
    this.keys.clear()
    this.wanted = false
    if (this.mode === 'active') this.letGo(now)
  }

  /** No direction any more: stop now when a send token is there, else walk on until one is (frame asks again). */
  private letGo(now: number): void {
    if (this.canSend(now)) this.finish(now)
  }

  /**
   * A click in the world, an accepted action, death: the key walk ends without a stop of its own (the click's request
   * or the server's action drives), and the own view goes back to the server's state. The keys need a new press.
   */
  cancel(now = this.deps.now()): void {
    this.wanted = false
    this.pending = null
    if (this.mode === 'idle') return
    this.mode = 'idle'
    this.seg = null
    this.sliding = false
    this.sentDir = null
    this.stopAt = null
    this.tail = null
    this.handBack(now)
  }

  /** worldEnter: nothing held, no walk, no server state. */
  reset(): void {
    this.keys.clear()
    this.wanted = false
    this.pending = null
    this.mode = 'idle'
    this.seg = null
    this.sliding = false
    this.sentDir = null
    this.server = null
    this.stopAt = null
    this.tail = null
    this.speed = DEFAULT_SPEED
    this.navFresh = true
  }

  /** The own view appeared (spawn, worldEnter): its state is the server's. */
  seen(pos: Vec3, move: MoveState | undefined): void {
    this.server = { move: move ?? null, pos: [...pos] }
    if (move && move.speed > 0) this.speed = move.speed
  }

  /** Accepted request `re` (actionResult ok): an action that walks, chases or casts takes over from the keys. */
  accepted(re: string, now = this.deps.now()): void {
    if (!TAKE_OVER.has(re) || this.mode === 'idle') return
    // A result this soon after the walk started answers a request sent before it (a click just before the key).
    if (now - this.startedAt <= this.rttMs() + 100) return
    this.cancel(now)
  }

  /** The own `move` (after the world screen applied it to the view). */
  onSelfMove(move: MoveState, now = this.deps.now()): void {
    this.server = { move, pos: [...move.from] }
    if (move.speed > 0 && Math.abs(move.speed - this.speed) > 1e-6) {
      this.speed = move.speed
      if (this.mode === 'active' && this.direction()) this.plan(now)
    }
    if (this.mode === 'settling' && this.stopAt && dist2(move.to, this.stopAt) <= SETTLE_EPS_M) {
      // The server walks to the stop point: hold until it arrives.
      const len = Math.hypot(move.to[0] - move.from[0], move.to[2] - move.from[2])
      this.settleUntil = Math.max(this.settleUntil, move.startedAt + (len / Math.max(0.1, move.speed)) * 1000 + 150)
    }
    this.restore()
  }

  /** The own `stop`. */
  onSelfStop(pos: Vec3, now = this.deps.now()): void {
    this.server = { move: null, pos: [...pos] }
    if (this.mode === 'settling' && this.stopAt && dist2(pos, this.stopAt) <= SETTLE_EPS_M) {
      // Stopped where we did: done (the world screen put the view there already).
      this.mode = 'idle'
      this.stopAt = null
      this.tail = null
      return
    }
    void now
    this.restore()
  }

  /** The own `warp` (teleport, respawn, summon): the walk ends there; the world screen already moved the view. */
  onSelfWarp(pos: Vec3): void {
    this.server = { move: null, pos: [...pos] }
    this.wanted = false
    this.pending = null
    this.mode = 'idle'
    this.seg = null
    this.sliding = false
    this.sentDir = null
    this.stopAt = null
    this.tail = null
  }

  /** Per frame (server ms). */
  frame(now = this.deps.now()): void {
    const self = this.deps.self()
    if (this.mode !== 'idle' && (!self || self.dead)) {
      this.keys.clear()
      this.cancel(now)
      return
    }
    if (this.mode === 'active') {
      if (!this.deps.allowed()) this.releaseAll(now)
      else if (!this.direction()) this.letGo(now)
      else {
        this.reconcile(now)
        const input = this.direction()!
        const seg = this.seg
        const moving = !!seg && Math.hypot(seg.to[0] - seg.from[0], seg.to[2] - seg.from[2]) > 1e-3
        const ended = !seg || (moving && sampleMove(seg, now).arrived)
        if (ended || !this.planInput || angleBetween(input, this.planInput) > REPLAN_TURN_RAD || now - this.planAt >= REPLAN_MS) this.plan(now)
        this.wantSend(now)
      }
    } else if (this.mode === 'settling' && now >= this.settleUntil) this.settled(now)
    if (this.mode !== 'active' && this.wanted && this.keys.size && this.direction() && this.deps.allowed()) this.tryStart(now)
    this.flush(now)
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  private rttMs(): number {
    const r = this.deps.rtt()
    return Number.isFinite(r) && r >= 0 ? r : DEFAULT_RTT_MS
  }

  private probeLen(): number {
    return Math.max(PROBE_MIN_M, this.speed * PROBE_S)
  }

  private tryStart(now: number): void {
    const self = this.deps.self()
    if (!self || self.dead || !this.deps.allowed() || !this.direction()) return
    if (this.deps.vetoed()) {
      this.wanted = false
      return
    }
    this.deps.tookOver()
    this.base = this.mode === 'settling' && this.stopAt ? this.settlePoint(now) : [self.pos.x, self.pos.y, self.pos.z]
    this.mode = 'active'
    this.seg = null
    this.sliding = false
    this.sentDir = null
    this.stopAt = null
    this.tail = null
    this.navFresh = true
    this.startedAt = now
    this.plan(now)
    this.wantSend(now)
  }

  /** Plans the predicted walk from the predicted point now toward the keys' direction (sliding along walls). */
  private plan(now: number): void {
    const input = this.direction()
    if (!input) return
    const p = this.at(now)
    const look = this.probeLen()
    const nav = this.deps.nav(p[0] - look, p[2] - look, p[0] + look, p[2] + look)
    if (nav !== this.nav || this.navFresh || !this.seg) {
      nav?.place(p[0], p[1], p[2])
      this.nav = nav
      this.navFresh = false
    } else if (nav && this.seg) {
      const s = this.seg
      const len = Math.hypot(s.to[0] - s.from[0], s.to[2] - s.from[2])
      nav.advance(Math.min(len, Math.max(0, ((now - s.startedAt) / 1000) * s.speed)))
    }
    const step = chooseStep(input, d => (nav ? nav.probe(p[0] + d.x * look, p[2] + d.z * look) : null), this.sliding)
    let to: Vec3
    if (nav) {
      const r = nav.commit(p[0] + step.dir.x * look, p[2] + step.dir.z * look)
      to = [r.x, Number.isFinite(r.y) ? r.y : p[1], r.z]
    } else to = [p[0] + step.dir.x * look, p[1], p[2] + step.dir.z * look]
    this.seg = { from: [p[0], p[1], p[2]], to, speed: this.speed, startedAt: now }
    this.planInput = input
    this.planDir = step.dir
    this.sliding = step.slid
    this.planAt = now
    this.yaw = Math.atan2(step.dir.x, step.dir.z)
    this.restore()
  }

  /** Puts the own view on the prediction (the world screen applied a server echo just before). */
  private restore(): void {
    const v = this.deps.self()
    if (!v) return
    if (this.mode === 'active' && this.seg) {
      const s = this.seg
      if (Math.hypot(s.to[0] - s.from[0], s.to[2] - s.from[2]) > 1e-3) v.setMove(s)
      else v.stop([...s.from], this.yaw)
    } else if (this.mode === 'settling' && this.stopAt) {
      // The run-on to the stop point, then standing there.
      if (this.tail && !sampleMove(this.tail, this.deps.now()).arrived) v.setMove(this.tail)
      else v.stop([...this.stopAt], this.yaw)
    }
  }

  /** Queues a target ahead along the walk when the direction turned or the keep-alive is due. */
  private wantSend(now: number): void {
    const dir = this.planDir
    const seg = this.seg
    if (!dir || !seg) return
    const moving = Math.hypot(seg.to[0] - seg.from[0], seg.to[2] - seg.from[2]) > 1e-3
    const turned = !this.sentDir || angleBetween(dir, this.sentDir) >= SEND_TURN_RAD
    if (!turned && !(moving && now - this.sentAt >= KEEPALIVE_MS)) return
    const p = this.at(now)
    const look = Math.max(LOOKAHEAD_MIN_M, this.speed * LOOKAHEAD_S)
    this.pending = { x: p[0] + dir.x * look, z: p[2] + dir.z * look }
    this.sentDir = dir
  }

  /** True when the bucket holds a send token at `now` (refilled at SEND_RATE a second, at most SEND_BURST). */
  private canSend(now: number): boolean {
    if (now > this.tokensAt) {
      this.tokens = Number.isFinite(this.tokensAt) ? Math.min(SEND_BURST, this.tokens + ((now - this.tokensAt) * SEND_RATE) / 1000) : SEND_BURST
      this.tokensAt = now
    }
    return this.tokens >= 1
  }

  /** Sends the queued target when the bucket has a token. */
  private flush(now: number): void {
    if (!this.pending || !this.canSend(now)) return
    const p = this.pending
    this.pending = null
    if (this.deps.send(intents.moveTo(p.x, p.z))) {
      this.tokens -= 1
      this.sentAt = now
      this.sends++
    }
  }

  /**
   * The keys let go: the walk runs on a little along its own (nav-clipped) path, stops there, and the server is told
   * to stop at the same point; the point is held until the server has stopped there.
   */
  private finish(now: number): void {
    const p = this.at(now)
    let end = p
    const s = this.seg
    if (s && Math.hypot(s.to[0] - s.from[0], s.to[2] - s.from[2]) > 1e-3) {
      const runOn = Math.min(RUN_ON_MAX_S, this.rttMs() / 2000 + RUN_ON_S) * 1000
      end = sampleMove(s, now + runOn).pos
      // Never stop behind the server (a stalled prediction): it would walk back to the stop point for everyone.
      const srv = this.server?.move
      const dir = this.planDir
      if (srv && dir && !sampleMove(srv, now).arrived) {
        const there = sampleMove(srv, now + this.rttMs() / 2).pos
        if ((there[0] - end[0]) * dir.x + (there[2] - end[2]) * dir.z > 0.05) end = there
      }
    }
    this.stopAt = [cm(end[0]), end[1], cm(end[2])]
    this.tail = Math.hypot(this.stopAt[0] - p[0], this.stopAt[2] - p[2]) > 1e-3 ? { from: [...p], to: [...this.stopAt], speed: this.speed, startedAt: now } : null
    this.pending = { x: this.stopAt[0], z: this.stopAt[2] }
    this.mode = 'settling'
    this.settleUntil = now + Math.max(SETTLE_MIN_MS, 2 * this.rttMs() + 250)
    this.seg = null
    this.sliding = false
    this.sentDir = null
    this.planInput = null
    this.planDir = null
    this.restore()
    this.flush(now)
  }

  /** The hold ran out: the server's word (a glide for a few metres, else a snap). */
  private settled(now: number): void {
    this.mode = 'idle'
    const from = this.stopAt
    this.stopAt = null
    this.tail = null
    const v = this.deps.self()
    if (!v || !this.server || !from) return
    const s = this.serverAt(now)
    if (this.server.move && !sampleMove(this.server.move, now).arrived) {
      v.setMove(this.server.move)
      return
    }
    const d = dist2(s, from)
    if (d <= SETTLE_EPS_M) return
    if (d > SNAP_M && d <= GLIDE_MAX_M) v.setMove({ from: [...from], to: [...s], speed: this.speed, startedAt: now })
    else v.stop([...s], v.targetYaw)
  }

  /** The own view back on the server's state (a take-over: the click or the action drives from here). */
  private handBack(now: number): void {
    const v = this.deps.self()
    const srv = this.server
    if (!v || !srv) return
    if (srv.move && !sampleMove(srv.move, now).arrived) v.setMove(srv.move)
    else v.stop([...this.serverAt(now)], v.targetYaw)
  }

  /** Where the released walk is now: on its run-on, else at the stop point. */
  private settlePoint(now: number): Vec3 {
    if (this.tail) return sampleMove(this.tail, now).pos
    return this.stopAt ? [...this.stopAt] : [...this.base]
  }

  private serverAt(now: number): Vec3 {
    const srv = this.server!
    return srv.move ? sampleMove(srv.move, now).pos : [...srv.pos]
  }

  /** Pulls the prediction back when it leads the server by more than the lag explains. */
  private reconcile(now: number): void {
    if (!this.server) return
    const s = this.serverAt(now)
    const p = this.at(now)
    const allow = this.speed * (this.rttMs() / 2000 + LEAD_SLACK_S) + DRIFT_M
    const e = Math.hypot(p[0] - s[0], p[2] - s[2])
    if (e <= allow) return
    const k = allow / e
    this.base = [s[0] + (p[0] - s[0]) * k, p[1], s[2] + (p[2] - s[2]) * k]
    this.seg = null
    this.navFresh = true
    this.corrections++
  }
}

/** True while a text field has the focus (chat, the GM window, a dialog's input). */
function typingFocused(): boolean {
  return typeof document !== 'undefined' && isTypingTarget(document.activeElement)
}

export interface KeyMoveFeature extends WorldFeature {
  readonly mover: KeyMover
}

/**
 * The key walk in the world (composed by world/features/movement.ts, which stays the last feature): the four bindings,
 * the click hook, the camera follow hold, the own echoes. Needs the world camera and scene.
 */
export function keyMoveFeature(ctx: WorldFeatureContext): KeyMoveFeature {
  const navs = new WeakMap<NavGltf, KeyNav>()
  const self = (): EntityView | null => {
    const id = ctx.selfId()
    return id === null ? null : (ctx.view(id) ?? null)
  }
  const mover = new KeyMover({
    send: m => ctx.send(m),
    now: () => ctx.serverNow(),
    rtt: () => ctx.session?.clock.rtt ?? NaN,
    self,
    cameraAlpha: () => ctx.camera.alpha,
    rightHanded: ctx.scene.useRightHandedSystem,
    allowed: () => settings.get().controls.keyboardMove && !ctx.keys.isBlocked && !typingFocused(),
    vetoed: () => groundMoveVetoed(),
    nav: (x0, z0, x1, z1) => {
      const world = ctx.world()?.world
      if (!world?.nav) return null
      if (world.stream && !world.stream.navCovers(x0, z0, x1, z1)) return null
      let n = navs.get(world.nav)
      if (!n) navs.set(world.nav, (n = gltfKeyNav(world.nav)))
      return n
    },
    tookOver: () => {
      noteKeyMove()
      cancelApproach()
    },
  })
  const offs: (() => void)[] = []
  const enabled = () => settings.get().controls.keyboardMove
  for (const k of MOVE_KEY_ORDER) {
    const binding: KeyBinding = {
      id: `movement.${k}`,
      keys: [...MOVE_KEYS[k]],
      label: LABELS[k],
      group: 'movement',
      when: enabled,
      run: ev => mover.press(String(ev.key).toLowerCase(), k),
      up: ev => mover.release(String(ev.key ?? '').toLowerCase(), k),
    }
    offs.push(ctx.keys.register(binding))
  }
  // Debug handle (like window.__sroWeather): the key walk's state for browser checks.
  const debug = {
    mover,
    camera: ctx.camera,
    scene: ctx.scene,
    self: () => {
      const v = self()
      return v ? { x: v.pos.x, y: v.pos.y, z: v.pos.z, yaw: v.yaw, targetYaw: v.targetYaw, moving: v.moving, move: v.move } : null
    },
  }
  if (typeof window !== 'undefined') (window as unknown as { __sroKeyMove?: unknown }).__sroKeyMove = debug
  offs.push(() => {
    const w = typeof window !== 'undefined' ? (window as unknown as { __sroKeyMove?: unknown }) : null
    if (w && w.__sroKeyMove === debug) delete w.__sroKeyMove
  })
  // A left click in the world ends the key walk (after the world screen's own click: its request goes out first).
  const pointerObs: Observer<PointerInfo> | null = ctx.scene.onPointerObservable.add(pi => {
    if (pi.type === PointerEventTypes.POINTERDOWN && pi.event.button === 0) mover.cancel()
  })
  offs.push(() => ctx.scene.onPointerObservable.remove(pointerObs))
  offs.push(holdCameraFollow(() => mover.active))
  // The sends also run on a timer while a walk is on: a slow frame (streaming, a GPU stall) does not hold back the
  // keep-alives, so the server's walk does not run out under the others' eyes.
  const timer = setInterval(() => {
    if (mover.state !== 'idle') mover.frame(ctx.serverNow())
  }, TICK_MS)
  offs.push(() => clearInterval(timer))

  return {
    mover,
    onFrame(now) {
      mover.frame(now)
    },
    onMessage(msg: ServerMessage) {
      const id = ctx.selfId()
      switch (msg.t) {
        case 'move':
          if (msg.id === id) mover.onSelfMove(msg.move)
          break
        case 'stop':
          if (msg.id === id) mover.onSelfStop(msg.pos)
          break
        case 'warp':
          if (msg.id === id) mover.onSelfWarp(msg.pos)
          break
        case 'worldEnter':
          mover.reset()
          mover.seen(msg.self.pos, msg.self.move)
          break
        case 'actionResult':
          if (msg.ok) mover.accepted(msg.re)
          break
      }
    },
    onEntityAdded(v) {
      if (v.id === ctx.selfId()) mover.seen([v.pos.x, v.pos.y, v.pos.z], v.move)
    },
    dispose() {
      mover.reset()
      for (const off of offs.splice(0)) off()
    },
  }
}
