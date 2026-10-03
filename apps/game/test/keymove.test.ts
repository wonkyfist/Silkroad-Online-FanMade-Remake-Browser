/**
 * MV-WASD (docs/MOVEMENT.md §13; world/features/keymove.ts): walking with W A S D and the arrows.
 * - the key maths: camera-relative (checked against Babylon's own projection, right- and left-handed), diagonals
 *   normalised, opposite keys cancel;
 * - wall sliding (chooseStep) on a synthetic wall, and on the real Jangan navmesh (the fountain rim; skipped without
 *   work/out/world/jangan/nav.bin): it slides along, never crosses a blocked edge, and stops dead straight into a wall;
 * - the stream against a simulated server with latency and jitter: no stop between the keep-alives (no stutter), a
 *   viewer's copy as smooth as the walk, no rubber band on the own view, the server stopping exactly where the client
 *   did, never more sends than the bucket allows (3 at once, 10/s) even when keys are mashed;
 * - reconciliation (a server that does not follow), the speed of the own move, the settle hold;
 * - clicks and keys cancel each other; focus, modal, the option, death and the stall veto suppress the keys;
 * - the feature wiring in a KeyMap: the bindings, the key help, the arrows back to the camera when the option is off,
 *   Space while walking, the camera follow hold; the Skills window moved to K.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArcRotateCamera, Matrix, NullEngine, Scene, Vector3, Viewport } from '@babylonjs/core'
import { NavGltf, NavWorld, decodeNavData } from '@sro/nav'
import { validateClientMessage, type ClientMessage, type MoveState, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeyMap, type KeyEventLike } from '../src/hud/keys.ts'
import { keyHelpGroups } from '../src/hud/keyhelp.ts'
import { en } from '../src/i18n/en.ts'
import { sampleMove } from '../src/net/clock.ts'
import { settings } from '../src/settings.ts'
import { cameraFollowHeld } from '../src/world/camera-keys.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import {
  DEFAULT_SPEED,
  KEEPALIVE_MS,
  KeyMover,
  LOOKAHEAD_S,
  SEND_BURST,
  SEND_RATE,
  MOVE_KEYS,
  SLIDE_MAX_RAD,
  angleBetween,
  cameraRelative,
  chooseStep,
  gltfKeyNav,
  keyAxes,
  type Dir,
  type KeyMoveDeps,
  type KeyNav,
  type MoveKey,
  type Probe,
} from '../src/world/features/keymove.ts'
import { movementFeature } from '../src/world/features/movement.ts'
import { SKILLS_WINDOW_HOTKEY, SKILLS_WINDOW_KEYS } from '../src/world/features/skills.ts'
import { MoveFeedback, noteGroundMove, noteKeyMove, onGroundMove, onKeyMove } from '../src/world/move-feedback.ts'

afterEach(() => {
  vi.restoreAllMocks()
  settings.set({ controls: { keyboardMove: true } })
})

// ---- a synthetic world: wall segments, a straight walk stopping 2 cm short of the first one ----------------------------

type Wall = [number, number, number, number]

/** The straight walk from (x0, z0) toward (x1, z1), clipped 2 cm before the first wall it crosses. */
function walkWalls(walls: readonly Wall[], x0: number, z0: number, x1: number, z1: number): Probe {
  const dx = x1 - x0
  const dz = z1 - z0
  const len = Math.hypot(dx, dz)
  let tHit = 1
  for (const [ax, az, bx, bz] of walls) {
    const ex = bx - ax
    const ez = bz - az
    const den = dx * ez - dz * ex
    if (Math.abs(den) < 1e-12) continue
    const t = ((ax - x0) * ez - (az - z0) * ex) / den
    const u = ((ax - x0) * dz - (az - z0) * dx) / den
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) tHit = Math.min(tHit, t)
  }
  if (tHit >= 1 || len < 1e-9) return { x: x1, y: 0, z: z1, blocked: false, distance: len }
  const d = Math.max(0, tHit * len - 0.02)
  return { x: x0 + (dx / len) * d, y: 0, z: z0 + (dz / len) * d, blocked: true, distance: d }
}

/** KeyNav over the synthetic walls: the predicted point follows the committed walk. */
function wallNav(walls: readonly Wall[]): KeyNav & { placed: number } {
  let ox = 0
  let oz = 0
  let dirX = 0
  let dirZ = 0
  let total = 0
  let d = 0
  const live = () => ({ x: ox + dirX * Math.min(d, total), z: oz + dirZ * Math.min(d, total) })
  return {
    placed: 0,
    place(x, _y, z) {
      ox = x
      oz = z
      total = 0
      d = 0
      this.placed++
    },
    advance(dist) {
      d = dist
    },
    probe(x, z) {
      const p = live()
      return walkWalls(walls, p.x, p.z, x, z)
    },
    commit(x, z) {
      const p = live()
      const r = walkWalls(walls, p.x, p.z, x, z)
      ox = p.x
      oz = p.z
      const l = Math.hypot(r.x - p.x, r.z - p.z)
      dirX = l > 1e-9 ? (r.x - p.x) / l : 0
      dirZ = l > 1e-9 ? (r.z - p.z) / l : 0
      total = l
      d = 0
      return r
    },
  }
}

/** Camera alpha whose W walks along `d` (forward = (−cos α, −sin α)). */
const alphaFor = (d: Dir) => Math.atan2(-d.z, -d.x)

// ---- the key maths -------------------------------------------------------------------------------------------------

describe('camera-relative directions', () => {
  const screenOf = (rightHanded: boolean, alpha: number) => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = rightHanded
    const cam = new ArcRotateCamera('cam', alpha, 1.1, 9, Vector3.Zero(), scene)
    const vp = new Viewport(0, 0, 1000, 1000)
    const vpm = cam.getViewMatrix(true).multiply(cam.getProjectionMatrix(true))
    const project = (x: number, z: number) => Vector3.Project(new Vector3(x, 0, z), Matrix.Identity(), vpm, vp)
    return { project, dispose: () => engine.dispose() }
  }

  for (const rightHanded of [true, false]) {
    it(`W walks where the camera looks and D to the screen's right (${rightHanded ? 'right' : 'left'}-handed scene)`, () => {
      for (const alpha of [-Math.PI / 2, 0, 0.7, 2.5, -2.2]) {
        const s = screenOf(rightHanded, alpha)
        const c = s.project(0, 0)
        const go = (k: MoveKey) => cameraRelative(keyAxes(new Set([k])), alpha, rightHanded)!
        const w = s.project(go('forward').x, go('forward').z)
        const b = s.project(go('back').x, go('back').z)
        const d = s.project(go('right').x, go('right').z)
        const a = s.project(go('left').x, go('left').z)
        // Forward goes up the screen (away from the camera) and back comes down, both on the centre line.
        expect(w.y, `alpha ${alpha}`).toBeLessThan(c.y - 10)
        expect(Math.abs(w.x - c.x)).toBeLessThan(1)
        expect(b.y).toBeGreaterThan(c.y + 10)
        // Right goes right, left goes left, both on the centre's row.
        expect(d.x, `alpha ${alpha}`).toBeGreaterThan(c.x + 10)
        expect(Math.abs(d.y - c.y)).toBeLessThan(1)
        expect(a.x).toBeLessThan(c.x - 10)
        s.dispose()
      }
    })
  }

  it('diagonals are normalised; opposite keys cancel; no key is no direction', () => {
    const alpha = 0.4
    const w = cameraRelative({ x: 0, y: 1 }, alpha)!
    const d = cameraRelative({ x: 1, y: 0 }, alpha)!
    const wd = cameraRelative(keyAxes(new Set<MoveKey>(['forward', 'right'])), alpha)!
    expect(Math.hypot(wd.x, wd.z)).toBeCloseTo(1, 12)
    expect(wd.x).toBeCloseTo((w.x + d.x) / Math.SQRT2, 12)
    expect(wd.z).toBeCloseTo((w.z + d.z) / Math.SQRT2, 12)
    expect(angleBetween(wd, w)).toBeCloseTo(Math.PI / 4, 12)
    expect(cameraRelative(keyAxes(new Set<MoveKey>(['forward', 'back'])), alpha)).toBeNull()
    expect(cameraRelative(keyAxes(new Set<MoveKey>(['left', 'right'])), alpha)).toBeNull()
    expect(cameraRelative(keyAxes(new Set<MoveKey>(['forward', 'back', 'left', 'right'])), alpha)).toBeNull()
    expect(cameraRelative(keyAxes(new Set<MoveKey>()), alpha)).toBeNull()
    // W + S + D is D.
    expect(cameraRelative(keyAxes(new Set<MoveKey>(['forward', 'back', 'right'])), alpha)).toEqual(d)
    // The camera behind a character facing +z (camera-keys behindAlpha(0) = -π/2): W walks +z.
    const behind = cameraRelative({ x: 0, y: 1 }, -Math.PI / 2)!
    expect(behind.x).toBeCloseTo(0, 12)
    expect(behind.z).toBeCloseTo(1, 12)
  })

  it('W A S D and the arrows', () => {
    expect(MOVE_KEYS).toEqual({ forward: ['w', 'arrowup'], back: ['s', 'arrowdown'], left: ['a', 'arrowleft'], right: ['d', 'arrowright'] })
  })
})

// ---- sliding -------------------------------------------------------------------------------------------------------

describe('wall sliding (chooseStep)', () => {
  // A wall along x = 1 (from z = -50 to 50).
  const walls: Wall[] = [[1, -50, 1, 50]]
  const from = { x: 0.98, z: 0 }
  const probe = (d: Dir) => walkWalls(walls, from.x, from.z, from.x + d.x * 2, from.z + d.z * 2)

  it('straight when nothing is in the way, or the wall is not near yet', () => {
    const s = chooseStep({ x: 0, z: 1 }, probe)
    expect(s).toMatchObject({ dir: { x: 0, z: 1 }, slid: false })
    const far = chooseStep({ x: 1, z: 0 }, d => walkWalls(walls, 0, 0, d.x * 2, d.z * 2))
    expect(far.slid).toBe(false)
    expect(far.probe!.distance).toBeCloseTo(0.98, 6)
  })

  it('straight into the wall it stops (no slide past SLIDE_MAX_RAD off the keys)', () => {
    const s = chooseStep({ x: 1, z: 0 }, probe)
    expect(s.slid).toBe(false)
    expect(s.probe!.blocked).toBe(true)
    expect(s.probe!.distance).toBeLessThan(0.01)
    // 20° off the wall's normal: still more than SLIDE_MAX_RAD (60°) from the wall's direction.
    const a = (20 * Math.PI) / 180
    expect(chooseStep({ x: Math.cos(a), z: Math.sin(a) }, probe).slid).toBe(false)
  })

  it('at an angle it slides along the wall on the side of the keys, nearly parallel to it', () => {
    for (const deg of [45, -45, 35, 60]) {
      const a = (deg * Math.PI) / 180
      const s = chooseStep({ x: Math.cos(a), z: Math.sin(a) }, probe)
      expect(s.slid, `${deg}°`).toBe(true)
      expect(Math.sign(s.dir.z)).toBe(Math.sign(deg))
      // Along the wall: never into it (the server's chord would stop at it), at most a few degrees away from it.
      expect(s.dir.x).toBeLessThanOrEqual(0)
      expect(Math.abs(Math.atan2(s.dir.x, Math.abs(s.dir.z)))).toBeLessThan((4.5 * Math.PI) / 180)
      expect(s.probe!.blocked).toBe(false)
      expect(angleBetween(s.dir, { x: Math.cos(a), z: Math.sin(a) })).toBeLessThanOrEqual(SLIDE_MAX_RAD + 1e-9)
      expect(s.probe!.distance).toBeGreaterThanOrEqual(1)
    }
  })

  it('sticky: while sliding, a wall within 1 m keeps the slide (no zig-zag); not sliding, it walks up to it first', () => {
    const near = (d: Dir) => walkWalls(walls, 0.5, 0, 0.5 + d.x * 2, d.z * 2)
    const a = (40 * Math.PI) / 180
    const dir = { x: Math.cos(a), z: Math.sin(a) }
    expect(chooseStep(dir, near, false).slid).toBe(false)
    expect(chooseStep(dir, near, true).slid).toBe(true)
  })

  it('no navmesh: straight and unclipped', () => {
    expect(chooseStep({ x: 1, z: 0 }, () => null)).toEqual({ dir: { x: 1, z: 0 }, probe: null, slid: false })
  })
})

// ---- the key walk against a simulated server -------------------------------------------------------------------------

interface SimOpts {
  walls?: Wall[]
  latencyMs?: number
  jitterMs?: number
  speed?: number
  /** The server ignores every moveTo (a gate the client does not know). */
  deaf?: boolean
  start?: Vec3
  alpha?: number
}

/** A world screen in miniature: the own view, a viewer's copy of us, a server with latency and jitter, the frames. */
function sim(opts: SimOpts = {}) {
  const walls = opts.walls ?? []
  const latency = opts.latencyMs ?? 40
  const jitter = opts.jitterMs ?? 0
  const speed = opts.speed ?? DEFAULT_SPEED
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const clock = { t: 100_000 }
  const start = opts.start ?? [0, 0, 0]

  // The server (glTF metres; the same walls).
  const srv = { move: null as MoveState | null, pos: [...start] as Vec3 }
  const live = (now: number): Vec3 => (srv.move ? sampleMove(srv.move, now).pos : [...srv.pos])
  const toClient: { at: number; msg: ServerMessage }[] = []
  const toServer: { at: number; msg: ClientMessage }[] = []
  let lastUp = 0
  let lastDown = 0
  const broadcast = (msg: ServerMessage, now: number) => {
    lastDown = Math.max(lastDown, now + latency + rnd() * jitter)
    toClient.push({ at: lastDown, msg })
  }
  const serverReceive = (msg: ClientMessage, now: number) => {
    if (msg.t !== 'moveTo' || opts.deaf) return
    const p = live(now)
    const r = walkWalls(walls, p[0], p[2], msg.x, msg.z)
    if (Math.hypot(r.x - p[0], r.z - p[2]) < 0.01) {
      const was = srv.move !== null
      srv.move = null
      srv.pos = p
      if (was) broadcast({ t: 'stop', id: 1, pos: [...p], yaw: 0 }, now)
      return
    }
    srv.move = { from: p, to: [r.x, 0, r.z], speed, startedAt: now }
    broadcast({ t: 'move', id: 1, move: { ...srv.move, from: [...p], to: [r.x, 0, r.z] } }, now)
  }
  const serverTick = (now: number) => {
    if (srv.move && sampleMove(srv.move, now).arrived) {
      srv.pos = [...srv.move.to]
      srv.move = null
      broadcast({ t: 'stop', id: 1, pos: [...srv.pos], yaw: 0 }, now)
    }
  }

  // The own view (EntityView's update in miniature) and a viewer's copy (server messages only).
  const view = {
    pos: { x: start[0], y: start[1], z: start[2] },
    targetYaw: 0,
    dead: false,
    move: undefined as MoveState | undefined,
    setMove(m: MoveState) {
      this.move = m
    },
    stop(p: Vec3, yaw: number) {
      this.move = undefined
      this.pos = { x: p[0], y: p[1], z: p[2] }
      this.targetYaw = yaw
    },
  }
  const viewer = { pos: { x: start[0], z: start[2] }, move: undefined as MoveState | undefined }
  const sent: { at: number; msg: ClientMessage }[] = []
  const state = { allowed: true, vetoed: false, vetoCalls: 0, alpha: opts.alpha ?? -Math.PI / 2, rtt: 2 * latency + jitter }
  const tookOver = vi.fn()
  const deps: KeyMoveDeps = {
    send: m => {
      expect(validateClientMessage(m).ok).toBe(true)
      sent.push({ at: clock.t, msg: m })
      lastUp = Math.max(lastUp, clock.t + latency + rnd() * jitter)
      toServer.push({ at: lastUp, msg: m })
      return true
    },
    now: () => clock.t,
    rtt: () => state.rtt,
    self: () => view,
    cameraAlpha: () => state.alpha,
    rightHanded: true,
    allowed: () => state.allowed,
    vetoed: () => (state.vetoCalls++, state.vetoed),
    nav: () => (walls.length ? navOf : null),
    tookOver,
  }
  const navOf = wallNav(walls)
  const mover = new KeyMover(deps)
  mover.seen(start, undefined)
  const own: { t: number; x: number; z: number }[] = []
  const seen: { t: number; x: number; z: number }[] = []
  const stopsSeen: number[] = []
  const marks = { firstMove: Infinity }

  const frame = (dt = 16) => {
    clock.t += dt
    const now = clock.t
    while (toServer.length && toServer[0]!.at <= now) {
      const m = toServer.shift()!
      serverTick(m.at)
      serverReceive(m.msg, m.at)
    }
    serverTick(now)
    while (toClient.length && toClient[0]!.at <= now) {
      const msg = toClient.shift()!.msg
      // The world screen first, then the feature (features.ts onMessage order).
      if (msg.t === 'move') {
        view.setMove(msg.move)
        viewer.move = msg.move
        marks.firstMove = Math.min(marks.firstMove, now)
        mover.onSelfMove(msg.move, now)
      } else if (msg.t === 'stop') {
        view.stop(msg.pos, msg.yaw)
        viewer.move = undefined
        viewer.pos = { x: msg.pos[0], z: msg.pos[2] }
        stopsSeen.push(now)
        mover.onSelfStop(msg.pos, now)
      }
    }
    // EntityView.update for both.
    if (view.move) {
      const s = sampleMove(view.move, now)
      view.pos = { x: s.pos[0], y: s.pos[1], z: s.pos[2] }
      if (s.arrived) view.move = undefined
    }
    if (viewer.move) {
      const s = sampleMove(viewer.move, now)
      viewer.pos = { x: s.pos[0], z: s.pos[2] }
      if (s.arrived) viewer.move = undefined
    }
    mover.frame(now)
    own.push({ t: now, x: view.pos.x, z: view.pos.z })
    seen.push({ t: now, x: viewer.pos.x, z: viewer.pos.z })
  }
  const run = (ms: number, dt = 16) => {
    const end = clock.t + ms
    while (clock.t < end) frame(dt)
  }
  const press = (k: MoveKey, key = MOVE_KEYS[k][0]!) => mover.press(key, k, clock.t)
  const release = (k: MoveKey, key = MOVE_KEYS[k][0]!) => mover.release(key, k, clock.t)
  /** The largest jump of a track between two frames, beyond what `speed` covers. */
  const worstJump = (track: { t: number; x: number; z: number }[], from = 0, to = Infinity) => {
    let worst = 0
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1]!
      const b = track[i]!
      if (b.t <= from || b.t > to) continue
      worst = Math.max(worst, Math.hypot(b.x - a.x, b.z - a.z) - (speed * (b.t - a.t)) / 1000)
    }
    return worst
  }
  return { clock, mover, view, viewer, srv, sent, state, tookOver, frame, run, press, release, own, seen, stopsSeen, marks, worstJump, navOf, live }
}

const moveTos = (sent: { msg: ClientMessage }[]) => sent.filter(s => s.msg.t === 'moveTo').map(s => s.msg as Extract<ClientMessage, { t: 'moveTo' }>)

/** Send times within the client bucket: at most SEND_BURST at once and SEND_RATE a second after that, in any window. */
function expectBucket(ts: readonly number[]): void {
  for (const t0 of ts) {
    for (const w of [50, 100, 500, 1000, 2000]) expect(ts.filter(t => t >= t0 && t < t0 + w).length, `${w} ms from ${t0}`).toBeLessThanOrEqual(SEND_BURST + Math.ceil((w * SEND_RATE) / 1000))
  }
}

describe('the key walk against a server with latency', () => {
  it('starts on the key press (prediction) and sends a target LOOKAHEAD_S ahead at once', () => {
    const s = sim()
    s.press('forward')
    expect(s.mover.state).toBe('active')
    expect(s.tookOver).toHaveBeenCalledTimes(1)
    const first = moveTos(s.sent)
    expect(first).toHaveLength(1)
    expect(first[0]!.x).toBeCloseTo(0, 2)
    expect(first[0]!.z).toBeCloseTo(DEFAULT_SPEED * LOOKAHEAD_S, 2)
    // One frame later the own character already walks (the server has not even heard of it yet).
    s.frame()
    expect(s.view.pos.z).toBeGreaterThan(0.05)
    expect(s.srv.move).toBeNull()
  })

  for (const jitter of [0, 60]) {
    it(`a straight walk: keep-alives, no stop in between, smooth for a viewer and for us, stops where we stopped (jitter ${jitter} ms)`, () => {
      const s = sim({ latencyMs: 50, jitterMs: jitter })
      s.press('forward')
      s.run(3000)
      const walkEnd = s.clock.t
      s.release('forward')
      s.run(1500)
      // Keep-alives every KEEPALIVE_MS while straight: about 3000 / 250 + 1 and the stop, within the bucket.
      const ts = s.sent.map(x => x.at)
      expect(ts.length).toBeGreaterThanOrEqual(12)
      expect(ts.length).toBeLessThanOrEqual(15)
      expectBucket(ts)
      // The server never stopped us while the key was held (no stutter for anyone).
      expect(s.stopsSeen.filter(t => t <= walkEnd + 50)).toEqual([])
      // A viewer's copy never jumps once it walks (each keep-alive continues the same line; the start shows one
      // latency late, as every click walk does), and our own view never jumps at all.
      // (With jitter a late stop can still be one frame past the run-on.)
      expect(s.worstJump(s.seen, s.marks.firstMove)).toBeLessThan(jitter ? DEFAULT_SPEED * 0.017 : 1e-6)
      expect(s.worstJump(s.own)).toBeLessThan(1e-6)
      // Released: the server walked the few cm it was behind and stopped exactly where we did; we are idle again.
      const stop = moveTos(s.sent).at(-1)!
      expect(s.srv.move).toBeNull()
      expect(s.srv.pos[0]).toBeCloseTo(stop.x, 6)
      expect(s.srv.pos[2]).toBeCloseTo(stop.z, 6)
      expect(Math.hypot(s.view.pos.x - stop.x, s.view.pos.z - stop.z)).toBeLessThan(0.01)
      expect(s.mover.state).toBe('idle')
      expect(s.view.pos.z).toBeGreaterThan(DEFAULT_SPEED * 2.9)
      expect(s.mover.corrections).toBe(0)
    })
  }

  it('turns with the camera: a new target at once on a turn, never more than the bucket allows', () => {
    const s = sim({ latencyMs: 40 })
    s.press('forward')
    s.run(500)
    const before = s.sent.length
    const dragStart = s.clock.t
    // The player drags the camera round by 90° over 300 ms.
    for (let i = 0; i < 20; i++) {
      s.state.alpha += Math.PI / 2 / 20
      s.frame(15)
    }
    const during = s.sent.slice(before)
    expect(during.length).toBeGreaterThanOrEqual(2)
    // A turn does not wait for the keep-alive: the first new target goes out on the first turned frame.
    expect(during[0]!.at).toBe(dragStart + 15)
    expect(during.length).toBeGreaterThanOrEqual(4)
    expectBucket(s.sent.map(x => x.at))
    s.run(1000)
    // Walking the new way (forward at alpha + 90°).
    const dir = cameraRelative({ x: 0, y: 1 }, s.state.alpha)!
    const a = s.own.at(-60)!
    const b = s.own.at(-1)!
    const walked = { x: b.x - a.x, z: b.z - a.z }
    const l = Math.hypot(walked.x, walked.z)
    expect(angleBetween({ x: walked.x / l, z: walked.z / l }, dir)).toBeLessThan(0.02)
    // A viewer sees no stop and only small corners (the turn arrives one latency late: ≤ 0.22 m × 2 sin 15°).
    expect(s.stopsSeen).toEqual([])
    expect(s.worstJump(s.seen, s.marks.firstMove)).toBeLessThan(0.15)
  })

  it('slow frames (hitches up to 0.6 s): the prediction keeps pace, the server never stops mid-walk nor walks back', () => {
    const s = sim({ latencyMs: 40 })
    s.press('forward')
    for (let i = 0; i < 12; i++) {
      s.frame(i % 3 ? 16 : 600)
    }
    const walkEnd = s.clock.t
    s.release('forward')
    s.run(1200)
    // The own view walked at full speed through the hitches (no stall at the end of a short plan).
    const walked = Math.hypot(s.view.pos.x, s.view.pos.z)
    expect(walked).toBeGreaterThan(DEFAULT_SPEED * ((walkEnd - 100_000) / 1000) * 0.98)
    expect(s.stopsSeen.filter(t => t <= walkEnd)).toEqual([])
    // The last move the server made heads the same way as the walk (no turning round to a stop point behind it).
    const stop = moveTos(s.sent).at(-1)!
    expect(s.srv.pos[2]).toBeCloseTo(stop.z, 6)
    expect(Math.hypot(s.srv.pos[0] - s.view.pos.x, s.srv.pos[2] - s.view.pos.z)).toBeLessThan(0.01)
    expect(Math.min(...s.seen.slice(1).map((p, i) => p.z - s.seen[i]!.z))).toBeGreaterThanOrEqual(-1e-9)
  })

  it('mashing the keys never sends more than the bucket allows: 3 at once, 10/s (the server allows 20/s)', () => {
    const s = sim()
    for (let i = 0; i < 70; i++) {
      if (i % 2) s.release('forward')
      else s.press('forward')
      s.frame(30)
    }
    s.release('forward')
    s.run(600)
    const ts = s.sent.map(x => x.at)
    expect(ts.length).toBeGreaterThan(5)
    expectBucket(ts)
    // ≤ 10/s over any second.
    expect(ts.length).toBeGreaterThan(15)
    // The last word is a stop where the client stands, and the server stands there too.
    expect(s.mover.state).toBe('idle')
    const stop = moveTos(s.sent).at(-1)!
    expect(Math.hypot(s.srv.pos[0] - stop.x, s.srv.pos[2] - stop.z)).toBeLessThan(1e-6)
  })

  it('diagonal into a wall: slides along it on the client and the server, never through it', () => {
    // A wall along x = 3; W + D with the camera behind (+z forward, D = -x)... use A (+x) so the walk meets the wall.
    const s = sim({ walls: [[3, -100, 3, 100]], latencyMs: 40 })
    s.press('forward')
    s.press('left')
    s.run(2500)
    s.release('left')
    s.release('forward')
    s.run(1000)
    expect(Math.max(...s.own.map(p => p.x))).toBeLessThan(3)
    expect(Math.max(...s.seen.map(p => p.x))).toBeLessThan(3)
    // It reached the wall and kept going along it (+z) instead of stopping dead.
    const last = s.own.at(-1)!
    expect(last.x).toBeGreaterThan(2.9)
    expect(last.z).toBeGreaterThan(DEFAULT_SPEED * 2.5 * 0.85)
    expect(s.srv.pos[0]).toBeLessThan(3)
    expect(Math.hypot(s.srv.pos[0] - last.x, s.srv.pos[2] - last.z)).toBeLessThan(0.05)
    expect(s.worstJump(s.own)).toBeLessThan(0.05)
  })

  it('straight into a wall: stops at it (no slide, no walking through), and so does the server', () => {
    const s = sim({ walls: [[-100, 3, 100, 3]], latencyMs: 40 })
    s.press('forward')
    s.run(1500)
    expect(s.view.pos.z).toBeLessThan(3)
    expect(s.view.pos.z).toBeGreaterThan(2.9)
    expect(Math.abs(s.view.pos.x)).toBeLessThan(0.01)
    s.release('forward')
    s.run(800)
    expect(s.srv.pos[2]).toBeLessThan(3)
    expect(Math.hypot(s.srv.pos[0] - s.view.pos.x, s.srv.pos[2] - s.view.pos.z)).toBeLessThan(0.05)
  })

  it('a server that does not follow (a gate the client does not know): the prediction is held near it, then snaps back', () => {
    const s = sim({ deaf: true, latencyMs: 40 })
    s.press('forward')
    s.run(2000)
    const allow = DEFAULT_SPEED * (s.state.rtt / 2000 + 0.25) + 0.75
    expect(s.mover.corrections).toBeGreaterThan(0)
    expect(Math.hypot(s.view.pos.x, s.view.pos.z)).toBeLessThanOrEqual(allow + DEFAULT_SPEED * 0.02)
    s.release('forward')
    s.run(1200)
    // The hold ran out: the server's word (it never moved).
    expect(s.mover.state).toBe('idle')
    expect(Math.hypot(s.view.pos.x, s.view.pos.z)).toBeLessThan(0.01)
  })

  it('takes the speed of the own move (a horse, a buff, GM speed)', () => {
    const s = sim({ speed: 9.9, latencyMs: 30 })
    s.press('forward')
    s.run(1000)
    s.release('forward')
    s.run(800)
    expect(s.view.pos.z).toBeGreaterThan(9.9 * 0.9)
    expect(Math.hypot(s.srv.pos[0] - s.view.pos.x, s.srv.pos[2] - s.view.pos.z)).toBeLessThan(0.02)
  })
})

describe('clicks, actions and the keyboard owner', () => {
  it('a click ends the key walk without a stop of its own and hands the view back to the server; the keys need a new press', () => {
    const s = sim({ latencyMs: 40 })
    s.press('forward')
    s.run(1000)
    const n = s.sent.length
    s.mover.cancel(s.clock.t)
    expect(s.mover.state).toBe('idle')
    // Back on the server's walk: a few decimetres behind the prediction, on the same line.
    const srvNow = s.live(s.clock.t)
    expect(s.view.move).toBeDefined()
    expect(sampleMove(s.view.move!, s.clock.t).pos[2]).toBeCloseTo(srvNow[2], 6)
    s.run(1000)
    expect(s.sent.length).toBe(n)
    expect(s.mover.state).toBe('idle')
    // A fresh press walks again.
    s.release('forward')
    s.press('forward')
    expect(s.mover.state).toBe('active')
    expect(s.sent.length).toBe(n + 1)
  })

  it('an accepted attack, skill, pick-up or NPC talk takes over; one answering a request older than the walk does not', () => {
    const s = sim({ latencyMs: 40 })
    s.press('forward')
    s.frame()
    s.mover.accepted('attack', s.clock.t) // within a round trip of the start: a click just before the key
    expect(s.mover.state).toBe('active')
    s.run(500)
    s.mover.accepted('jump', s.clock.t)
    s.mover.accepted('emote', s.clock.t)
    expect(s.mover.state).toBe('active')
    s.mover.accepted('useSkill', s.clock.t)
    expect(s.mover.state).toBe('idle')
  })

  it('focus taken (a text field, a modal, the option off) stops the walk with a stop where we stand', () => {
    const s = sim()
    s.press('forward')
    s.run(500)
    s.state.allowed = false
    s.frame()
    expect(s.mover.state).toBe('settling')
    s.run(150)
    const stop = moveTos(s.sent).at(-1)!
    expect(stop.z).toBeCloseTo(s.view.pos.z, 2)
    s.state.allowed = true
    s.run(1000)
    // Still held, but the keys were let go: no walk until a new press.
    expect(s.mover.state).toBe('idle')
    expect(s.mover.held().size).toBe(0)
  })

  it('dead: nothing starts, and a walk in progress ends with no send', () => {
    const s = sim()
    s.view.dead = true
    s.press('forward')
    expect(s.mover.state).toBe('idle')
    expect(s.sent).toEqual([])
    s.view.dead = false
    s.release('forward')
    s.press('forward')
    s.run(300)
    const n = s.sent.length
    s.view.dead = true
    s.frame()
    expect(s.mover.state).toBe('idle')
    expect(s.sent.length).toBe(n)
  })

  it('a veto (a stall owner) keeps the keys from walking, asked once per press', () => {
    const s = sim()
    s.state.vetoed = true
    s.press('forward')
    s.run(500)
    expect(s.sent).toEqual([])
    expect(s.mover.state).toBe('idle')
    expect(s.state.vetoCalls).toBe(1)
    // The stall closed: the next press walks.
    s.state.vetoed = false
    s.release('forward')
    s.press('forward')
    expect(s.mover.state).toBe('active')
  })

  it('W + S cancel out (a stop); letting go of S walks forward again without a new press', () => {
    const s = sim()
    s.press('forward')
    s.run(300)
    s.press('back')
    expect(s.mover.state).toBe('settling')
    s.run(300)
    s.release('back')
    s.frame()
    expect(s.mover.state).toBe('active')
  })

  it('W and the up arrow together: letting go of one keeps walking; the blur stand-in lets go of both', () => {
    const s = sim()
    s.press('forward', 'w')
    s.press('forward', 'arrowup')
    s.run(200)
    s.release('forward', 'w')
    expect(s.mover.state).toBe('active')
    s.mover.release('', 'forward', s.clock.t)
    expect(s.mover.state).toBe('settling')
  })
})

// ---- the feature in a KeyMap ----------------------------------------------------------------------------------------

const rigs: { dispose(): void }[] = []
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose()
})

function featureRig() {
  const keys = new KeyMap()
  const clock = { t: 50_000 }
  const sent: ClientMessage[] = []
  let pointer: ((pi: { type: number; event: { button: number } }) => void) | null = null
  const self = {
    id: 1,
    kind: 'player',
    dead: false,
    idle: 'stand',
    state: {},
    actor: { skillActing: false, clipGroup: 'default', ensureMovementClips: async () => true },
    jump: vi.fn(() => true),
    pos: { x: 0, y: 0, z: 0 },
    targetYaw: 0,
    move: undefined as MoveState | undefined,
    setMove(m: MoveState) {
      this.move = m
    },
    stop(p: Vec3, yaw: number) {
      this.move = undefined
      this.pos = { x: p[0], y: p[1], z: p[2] }
      this.targetYaw = yaw
    },
  }
  const views = new Map<number, unknown>([[1, self]])
  const ctx = {
    keys,
    hud: { toast() {} },
    send: (m: ClientMessage) => (sent.push(m), true),
    selfId: () => 1,
    view: (id: number) => views.get(id),
    views: () => views.values(),
    serverNow: () => clock.t,
    addAttachment: () => () => {},
    camera: { alpha: -Math.PI / 2 },
    scene: {
      useRightHandedSystem: true,
      onPointerObservable: {
        add: (fn: typeof pointer) => ((pointer = fn), {}),
        remove: () => {},
      },
    },
    session: { clock: { rtt: 40 } },
    world: () => null,
  } as unknown as WorldFeatureContext
  const feature = movementFeature(ctx, () => clock.t)
  rigs.push({ dispose: () => feature.dispose?.() })
  const ev = (key: string, type: 'keydown' | 'keyup' = 'keydown', over: Partial<KeyEventLike> = {}): KeyEventLike => ({
    key,
    type,
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    preventDefault() {},
    ...over,
  })
  const frame = (ms = 16) => {
    clock.t += ms
    feature.onFrame?.(clock.t, ms / 1000)
  }
  return { keys, clock, sent, self, feature, ev, frame, click: () => pointer?.({ type: 1, event: { button: 0 } }) }
}

describe('the movement feature with keyboard movement', () => {
  it('binds W A S D and the arrows in the movement group; the key help lists them; S is not the Skills window any more', () => {
    const r = featureRig()
    const ids = r.keys.list().map(b => b.id)
    expect(ids).toEqual(expect.arrayContaining(['movement.jump', 'movement.forward', 'movement.back', 'movement.left', 'movement.right']))
    const rows = keyHelpGroups(r.keys.list()).find(g => g.group === 'movement')!.rows
    expect(rows).toEqual([
      { keys: 'Space', label: 'movement.key.jump' },
      { keys: 'W / ↑', label: 'movement.key.forward' },
      { keys: 'S / ↓', label: 'movement.key.back' },
      { keys: 'A / ←', label: 'movement.key.left' },
      { keys: 'D / →', label: 'movement.key.right' },
    ])
    for (const k of ['movement.key.forward', 'movement.key.back', 'movement.key.left', 'movement.key.right', 'keyhelp.wasd', 'options.keyboardMove'] as const) expect(en[k]).toBeTruthy()
    // The Skills window is K only (and the menu bar says K).
    expect(SKILLS_WINDOW_KEYS).toEqual(['k'])
    expect(SKILLS_WINDOW_HOTKEY).toBe('K')
    r.keys.register({ id: 'window.skills', keys: [...SKILLS_WINDOW_KEYS], label: 'skills.keys.window', group: 'windows', run() {} })
    expect(r.keys.list().filter(b => b.keys.includes('s')).map(b => b.id)).toEqual(['movement.back'])
    r.feature.dispose?.()
    expect(r.keys.list().some(b => b.id.startsWith('movement.'))).toBe(false)
  })

  it('W walks and its release stops; never while typing or with a modal open, never on key repeat', () => {
    const r = featureRig()
    r.keys.handle(r.ev('w', 'keydown', { target: { tagName: 'INPUT' } as unknown as EventTarget }))
    r.keys.handle(r.ev('w', 'keydown', { target: { tagName: 'TEXTAREA' } as unknown as EventTarget }))
    expect(r.sent).toEqual([])
    r.keys.handle(r.ev('W'))
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatchObject({ t: 'moveTo' })
    r.frame()
    expect(r.self.move).toBeDefined()
    r.keys.handle(r.ev('w', 'keydown', { repeat: true }))
    for (let i = 0; i < 10; i++) r.frame()
    r.keys.handle(r.ev('w', 'keyup'))
    // The stop: where the short run-on ends (the view walks it, then stands there).
    const stop = r.sent.at(-1) as Extract<ClientMessage, { t: 'moveTo' }>
    expect(r.self.move).toBeDefined()
    expect(stop.z).toBeCloseTo(r.self.move!.to[2], 6)
    expect(stop.z - r.self.move!.from[2]).toBeCloseTo(DEFAULT_SPEED * (40 / 2000 + 0.03), 2)
    // A modal owns the keyboard: keydowns skipped.
    const blocked = new KeyMap({ blocked: () => true })
    expect(blocked.isBlocked).toBe(true)
    expect(new KeyMap().isBlocked).toBe(false)
  })

  it('a text field taking the focus while walking stops the walk', () => {
    const r = featureRig()
    const had = 'document' in globalThis
    const doc = { activeElement: null as unknown }
    ;(globalThis as Record<string, unknown>).document = doc
    try {
      r.keys.handle(r.ev('w'))
      r.frame()
      expect(r.sent).toHaveLength(1)
      doc.activeElement = { tagName: 'INPUT' }
      r.frame(120)
      expect(r.sent).toHaveLength(2)
      for (let i = 0; i < 40; i++) r.frame()
      expect(r.sent).toHaveLength(2)
    } finally {
      if (!had) delete (globalThis as Record<string, unknown>).document
    }
  })

  it('the option off: W does nothing and the arrows go back to the camera (no clash warning either way)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const keys = new KeyMap()
    const camera: string[] = []
    // camera-keys.ts registers its arrows first (ux-world runs before the movement feature).
    keys.register({ id: 'camera.left', keys: ['arrowleft'], label: 'keys.camera.left', group: 'camera', repeat: true, when: () => !settings.get().controls.keyboardMove, run: () => camera.push('left') })
    const r = featureRig()
    for (const b of r.keys.list()) if (b.id.startsWith('movement.')) keys.register(b)
    expect(warn).not.toHaveBeenCalled()
    keys.handle(r.ev('ArrowLeft'))
    expect(camera).toEqual([])
    expect(r.sent).toHaveLength(1)
    keys.handle(r.ev('ArrowLeft', 'keyup'))
    settings.set({ controls: { keyboardMove: false } })
    r.sent.length = 0
    keys.handle(r.ev('ArrowLeft'))
    keys.handle(r.ev('w'))
    expect(camera).toEqual(['left'])
    expect(r.sent).toEqual([])
    // The key help shows the camera's arrow again, and only the jump under movement.
    const help = keyHelpGroups(keys.list())
    expect(help.find(g => g.group === 'movement')!.rows).toEqual([{ keys: 'Space', label: 'movement.key.jump' }])
    expect(help.find(g => g.group === 'camera')!.rows).toEqual([{ keys: '←', label: 'keys.camera.left' }])
  })

  it('Space jumps while walking, and the walk goes on', () => {
    const r = featureRig()
    r.keys.handle(r.ev('w'))
    for (let i = 0; i < 10; i++) r.frame()
    r.keys.handle(r.ev(' '))
    expect(r.sent.filter(m => m.t === 'jump')).toHaveLength(1)
    const before = r.sent.filter(m => m.t === 'moveTo').length
    for (let i = 0; i < 30; i++) r.frame()
    expect(r.sent.filter(m => m.t === 'moveTo').length).toBeGreaterThan(before)
    expect(r.self.move).toBeDefined()
  })

  it('a click in the world ends the key walk; a key press ends the click walk (hold to move, the pending check)', () => {
    const r = featureRig()
    r.keys.handle(r.ev('w'))
    r.frame()
    expect(cameraFollowHeld()).toBe(true)
    r.click()
    expect(cameraFollowHeld()).toBe(false)
    const n = r.sent.length
    for (let i = 0; i < 30; i++) r.frame()
    expect(r.sent.length).toBe(n)
    r.keys.handle(r.ev('w', 'keyup'))
    // A ground click walk with the button held (hold to move; ux-world wires onKeyMove to MoveFeedback.cancel), then
    // a key: the hold ends, the approach seam is told too.
    const fb = new MoveFeedback({ send: () => true, self: () => ({ x: 0, z: 0 }), cursorGround: () => ({ x: 9, z: 9 }), holdToMove: () => true, rtt: () => 40, blocked: vi.fn() })
    const offs = [onGroundMove(p => fb.begin(p, r.clock.t)), onKeyMove(() => fb.cancel())]
    noteGroundMove({ x: 5, z: 5 })
    expect(fb.isHolding).toBe(true)
    r.keys.handle(r.ev('d'))
    expect(r.sent.length).toBe(n + 1)
    expect(fb.isHolding).toBe(false)
    for (const off of offs) off()
  })

  it('worldEnter resets; an own warp ends the walk where the server put us', () => {
    const r = featureRig()
    r.keys.handle(r.ev('w'))
    r.frame()
    r.feature.onMessage?.({ t: 'warp', id: 1, pos: [50, 0, 50], yaw: 0 })
    const n = r.sent.length
    for (let i = 0; i < 20; i++) r.frame()
    expect(r.sent.length).toBe(n)
    r.keys.handle(r.ev('w', 'keyup'))
    r.keys.handle(r.ev('w'))
    expect(r.sent.length).toBe(n + 1)
  })
})

describe('the hold-to-move seam', () => {
  it('noteKeyMove ends a hold and its pending blocked check (ux-world subscribes MoveFeedback.cancel)', () => {
    const blocked = vi.fn()
    const fb = new MoveFeedback({ send: () => true, self: () => ({ x: 0, z: 0 }), cursorGround: () => ({ x: 9, z: 9 }), holdToMove: () => true, rtt: () => 40, blocked })
    const off = onKeyMove(() => fb.cancel())
    fb.begin({ x: 20, z: 0 }, 0)
    expect(fb.isHolding).toBe(true)
    noteKeyMove()
    expect(fb.isHolding).toBe(false)
    fb.tick(5000)
    expect(blocked).not.toHaveBeenCalled()
    off()
  })
})

// ---- the real Jangan navmesh ---------------------------------------------------------------------------------------

const NAV_FILE = join(fileURLToPath(new URL('../../../', import.meta.url)), 'work', 'out', 'world', 'jangan', 'nav.bin')

describe.skipIf(!existsSync(NAV_FILE))('on the real Jangan navmesh (the fountain rim)', () => {
  const nav = new NavGltf(new NavWorld(decodeNavData(new Uint8Array(readFileSync(NAV_FILE)))), { x: 168, z: 97 })
  /** docs/NAVIGATION.md §8: the plaza test point (deck -3.261 m) and the fountain centre (blocked rim about 10 m out). */
  const PLAZA: Vec3 = [100.84, -3.261, -71.5]
  const FOUNTAIN = { x: 97.9, z: -85.6 }

  function walk(dir: Dir, ms: number) {
    const clock = { t: 0 }
    const view = {
      pos: { x: PLAZA[0], y: PLAZA[1], z: PLAZA[2] },
      targetYaw: 0,
      dead: false,
      move: undefined as MoveState | undefined,
      setMove(m: MoveState) {
        this.move = m
      },
      stop(p: Vec3) {
        this.move = undefined
        this.pos = { x: p[0], y: p[1], z: p[2] }
      },
    }
    const keyNav = gltfKeyNav(nav)
    const mover = new KeyMover({
      send: () => true,
      now: () => clock.t,
      rtt: () => 40,
      self: () => view,
      cameraAlpha: () => alphaFor(dir),
      rightHanded: true,
      allowed: () => true,
      vetoed: () => false,
      nav: () => keyNav,
      tookOver: () => {},
    })
    const track: { x: number; y: number; z: number }[] = []
    mover.press('w', 'forward', clock.t)
    while (clock.t < ms) {
      clock.t += 16
      if (view.move) {
        const s = sampleMove(view.move, clock.t)
        view.pos = { x: s.pos[0], y: s.pos[1], z: s.pos[2] }
        if (s.arrived) view.move = undefined
      }
      mover.frame(clock.t)
      track.push({ ...view.pos })
    }
    return track
  }

  /** Every step of the track is a straight nav walk that no blocking edge clips (it never crosses one). */
  function legal(track: { x: number; y: number; z: number }[]) {
    let pos = nav.locate(PLAZA[0], PLAZA[2], PLAZA[1])!
    let worst = 0
    for (const p of track) {
      const r = nav.moveStraight(pos, p.x, p.z)
      worst = Math.max(worst, Math.hypot(r.end.x - p.x, r.end.z - p.z))
      pos = r.end
    }
    return worst
  }

  it('straight at the fountain: stops at the rim', () => {
    const to = { x: FOUNTAIN.x - PLAZA[0], z: FOUNTAIN.z - PLAZA[2] }
    const l = Math.hypot(to.x, to.z)
    const track = walk({ x: to.x / l, z: to.z / l }, 2500)
    const last = track.at(-1)!
    const r = Math.hypot(last.x - FOUNTAIN.x, last.z - FOUNTAIN.z)
    expect(r).toBeGreaterThan(8)
    expect(r).toBeLessThan(11)
    expect(legal(track)).toBeLessThan(0.05)
  })

  it('at an angle into the rim: slides round it, never inside, every step a legal walk', () => {
    const to = { x: FOUNTAIN.x - PLAZA[0], z: FOUNTAIN.z - PLAZA[2] }
    const l = Math.hypot(to.x, to.z)
    const dir = rotate45({ x: to.x / l, z: to.z / l })
    const track = walk(dir, 3000)
    const minR = Math.min(...track.map(p => Math.hypot(p.x - FOUNTAIN.x, p.z - FOUNTAIN.z)))
    const first = track[0]!
    const last = track.at(-1)!
    expect(minR).toBeGreaterThan(8)
    // It kept walking (sliding) rather than stopping at the rim: well over 8 m in 3 s.
    expect(Math.hypot(last.x - first.x, last.z - first.z)).toBeGreaterThan(8)
    expect(legal(track)).toBeLessThan(0.05)
    // On the plaza deck all the way (no fall to the terrain under it).
    expect(Math.min(...track.map(p => p.y))).toBeGreaterThan(-3.6)
  })
})

function rotate45(d: Dir): Dir {
  const a = (40 * Math.PI) / 180
  return { x: d.x * Math.cos(a) - d.z * Math.sin(a), z: d.x * Math.sin(a) + d.z * Math.cos(a) }
}

void KEEPALIVE_MS
