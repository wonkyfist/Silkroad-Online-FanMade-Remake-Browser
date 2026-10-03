import type { MoveState, Vec3 } from '@sro/shared'

/**
 * The page's monotonic clock in epoch-like ms: performance.timeOrigin + performance.now(). It never steps with the OS
 * clock (a manual change, an NTP step, a VM resume), so a local step cannot put the server-time estimate out
 * (W9F F1). Falls back to Date.now() without a performance clock.
 */
export function monotonicNow(): number {
  const p = globalThis.performance
  return p && typeof p.now === 'function' && Number.isFinite(p.timeOrigin) ? p.timeOrigin + p.now() : Date.now()
}

/**
 * Server clock estimate from ping/pong: offset = serverTime + rtt / 2 - receiveTime.
 * Keeps the last few samples and trusts the one with the smallest round trip (least queueing).
 *
 * The local side is `now` (default monotonicNow; the pings carry the same clock's value). A sample whose offset is
 * further from the estimate than its round trip can explain (> max(STEP_MIN_MS, 2 × rtt)) means one of the clocks
 * stepped (the server's wall clock, or an injected local one): the older samples are dropped, so the next pong corrects
 * the estimate instead of the stale minimum-RTT sample holding it for up to 8 pings (W9F F1).
 */
export class ServerClock {
  /** The smallest offset jump read as a clock step (ms). */
  static readonly STEP_MIN_MS = 1000
  private samples: { rtt: number; offset: number }[] = []
  private offsetMs = 0
  private seeded = false

  constructor(readonly now: () => number = monotonicNow) {}

  /** Rough first estimate (e.g. from `worldEnter.world.serverTime`) until a pong arrives. */
  seed(serverTime: number): void {
    if (this.samples.length) return
    this.offsetMs = serverTime - this.now()
    this.seeded = true
  }

  /** Feeds one pong. `clientTime` is the value the ping carried (this clock's `now()` at send). */
  pong(clientTime: number, serverTime: number): void {
    const received = this.now()
    const rtt = Math.max(0, received - clientTime)
    const offset = serverTime + rtt / 2 - received
    if (this.samples.length && Math.abs(offset - this.offsetMs) > Math.max(ServerClock.STEP_MIN_MS, 2 * rtt)) this.samples.length = 0
    this.samples.push({ rtt, offset })
    if (this.samples.length > 8) this.samples.shift()
    let best = this.samples[0]!
    for (const s of this.samples) if (s.rtt < best.rtt) best = s
    this.offsetMs = best.offset
    this.seeded = true
  }

  get offset(): number {
    return this.offsetMs
  }

  get synced(): boolean {
    return this.seeded
  }

  /** Round trip of the latest sample, ms. */
  get rtt(): number {
    return this.samples.at(-1)?.rtt ?? NaN
  }

  serverNow(): number {
    return this.now() + this.offsetMs
  }
}

export interface MoveSample {
  pos: Vec3
  /** Unit direction on XZ (0,0 when from == to). */
  dir: [number, number]
  arrived: boolean
}

/** Position along a server MoveState at server time `t` (linear, clamped at `to`). */
export function sampleMove(move: MoveState, t: number): MoveSample {
  const dx = move.to[0] - move.from[0]
  const dy = move.to[1] - move.from[1]
  const dz = move.to[2] - move.from[2]
  const dist = Math.hypot(dx, dz)
  if (dist < 1e-6 || move.speed <= 0) return { pos: [...move.to], dir: [0, 0], arrived: true }
  const travelled = Math.max(0, (t - move.startedAt) / 1000) * move.speed
  const f = Math.min(1, travelled / dist)
  return {
    pos: [move.from[0] + dx * f, move.from[1] + dy * f, move.from[2] + dz * f],
    dir: [dx / dist, dz / dist],
    arrived: f >= 1,
  }
}

/** Yaw (radians about +Y, 0 = facing +Z) of an XZ direction. A right-handed rotation about +Y maps +Z to (sin, 0, cos). */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz)
}
