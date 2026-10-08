/**
 * Tiger Girl's moves, the maths (Play the Boss kit, docs/PLAY_THE_BOSS.md §3.5; presentation only, the server owns the
 * position and the hits). Babylon-free so it is unit-tested; world/features/tiger-moves.ts draws it.
 *
 * - **Pounce**: the server walks her straight to the landing point at the kit's speed and lands the hit on arrival.
 *   The client shows a leap over that same walk: a crouch wind-up (she hardly moves, the body squashes), then a
 *   parabola (apex 1–2 m by distance) that catches up with the server's progress and touches down exactly when the
 *   server's walk ends (the hit), then a short landing squash.
 * - **Roar**: the retail FIND clip played whole (the head goes up, the jaws open around ROAR_PEAK_S), not cut at the
 *   cast's action time; the sound, the ring and the shake at the peak.
 * - **Stalk** (any slow walk, really): the WALK clip at the rate that matches the ground speed (no skating), and a
 *   prowl weight that lowers her when she walks faster than her retail walk (Stalk is 0.4 × her run).
 */

/** A server-built pilot ability by its cast id (PILOT_TIGERWOMAN_POUNCE, kit.ts castIdOf). */
export type PilotMove = 'pounce' | 'roar'

/** The move of a cast id: the kit's leap and fear roar; other casts are the retail rows' own presentation. */
export function pilotMoveOf(skill: string): PilotMove | null {
  const m = /^PILOT_[A-Z0-9_]*_(POUNCE|ROAR)$/.exec(skill)
  if (!m) return null
  return m[1] === 'POUNCE' ? 'pounce' : 'roar'
}

// ---- Pounce -------------------------------------------------------------------------------------------------------

/** Share of the flight time spent in the crouch wind-up (she creeps WINDUP_PROGRESS of the way meanwhile). */
export const WINDUP_SHARE = 0.24
export const WINDUP_PROGRESS = 0.05
/** The wind-up never takes more than this (s): a long leap crouches as briefly as a short one. */
export const WINDUP_MAX_S = 0.28
/** Landing squash after touchdown (s). */
export const LAND_S = 0.35

/** Apex height (m) of a leap `distM` long: 1 m for a short hop, 2 m for the kit's 12 m. */
export function leapApex(distM: number): number {
  return Math.min(2, Math.max(1, 0.6 + distM * 0.12))
}

export interface LeapSample {
  /** 'windup' (crouched), 'air', 'land' (squash after touchdown), 'done'. */
  phase: 'windup' | 'air' | 'land' | 'done'
  /** Share 0..1 of the path shown (the server's own progress is linear in time). */
  progress: number
  /** Height above the ground (m). */
  lift: number
  /** Vertical scale of the body (1 = as animated; < 1 crouched, > 1 stretched). */
  squash: number
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/**
 * The leap at `t` seconds after it started, for a flight of `durS` seconds (the server's walk time) and apex `apexM`.
 * Touchdown is at exactly `durS` with progress 1 (where the server lands the hit).
 */
export function leapAt(t: number, durS: number, apexM: number): LeapSample {
  if (durS <= 0) return { phase: t < LAND_S ? 'land' : 'done', progress: 1, lift: 0, squash: 1 }
  const w = Math.min(WINDUP_MAX_S, durS * WINDUP_SHARE)
  if (t < w) {
    const s = t / w
    return { phase: 'windup', progress: WINDUP_PROGRESS * s * s, lift: 0, squash: 1 - 0.2 * smooth(s * 1.6) }
  }
  if (t < durS) {
    const f = (t - w) / (durS - w)
    const progress = WINDUP_PROGRESS + (1 - WINDUP_PROGRESS) * f
    // Stretched on take-off, back to normal at the apex, a little stretched again reaching for the ground.
    const squash = 1 + 0.08 * Math.abs(1 - 2 * f)
    return { phase: 'air', progress, lift: 4 * apexM * f * (1 - f), squash }
  }
  const l = t - durS
  if (l < LAND_S) {
    const k = l / LAND_S
    return { phase: 'land', progress: 1, lift: 0, squash: 1 - 0.18 * Math.sin(Math.PI * Math.min(1, k * 1.4)) * (1 - k * 0.3) }
  }
  return { phase: 'done', progress: 1, lift: 0, squash: 1 }
}

/**
 * The rate the pounce clip plays at so its strike (the clip's first hit event, `hitMs`) lands with the touchdown
 * `durS` seconds after the start: a 12 m leap at 24 m/s is 0.5 s against her ATTACK1's 1.1 s strike. Clamped 1..2.5.
 */
export function pounceClipRate(hitMs: number, durS: number): number {
  if (!(hitMs > 0) || !(durS > 0)) return 1
  return Math.min(2.5, Math.max(1, hitMs / 1000 / durS))
}

// ---- Roar ---------------------------------------------------------------------------------------------------------

/** Seconds into her FIND clip where the jaws are open widest: the sound, the ring and the shake start here. */
export const ROAR_PEAK_S = 0.55
/** Camera shake: within this distance (m), the amplitude falling to 0 at the edge; how long (s). */
export const ROAR_SHAKE_M = 30
export const ROAR_SHAKE_S = 0.9
/** Screen-offset amplitude at her feet (camera-keys.ts units; a crit taken is 0.12). */
export const ROAR_SHAKE_AMP = 0.16
/** The landing's smaller shake. */
export const LAND_SHAKE_M = 18
export const LAND_SHAKE_S = 0.35
export const LAND_SHAKE_AMP = 0.09

/** Shake amplitude `left` seconds before the end of a shake of `totalS`, `distM` from its source within `rangeM`. */
export function shakeAmp(distM: number, rangeM: number, amp: number, left: number, totalS: number): number {
  if (left <= 0 || totalS <= 0 || distM >= rangeM) return 0
  const near = 1 - Math.max(0, distM) / rangeM
  return amp * near * near * Math.min(1, left / totalS)
}

// ---- Stalk / locomotion -------------------------------------------------------------------------------------------

export interface Gait {
  clip: 'WALK' | 'RUN'
  /** Clip playback rate so the feet keep pace with the ground (1 = the retail speed). */
  rate: number
  /** 0..1: how low she prowls (a walk faster than her retail walk is Stalk). */
  prowl: number
}

/**
 * The locomotion of a mob with retail `walkSpeed` / `runSpeed` moving at `speed` (m/s): the clip whose own speed is
 * nearer (the split is their geometric mean), played at speed / that clip's speed (0.5..2), and the prowl weight.
 */
export function gaitFor(speed: number, walkSpeed: number, runSpeed: number): Gait {
  const walk = walkSpeed > 0 ? walkSpeed : 2
  const run = runSpeed > walk ? runSpeed : walk * 4
  const split = Math.sqrt(walk * run)
  const clamp = (r: number) => Math.min(2, Math.max(0.5, r))
  if (speed >= split) return { clip: 'RUN', rate: clamp(speed / run), prowl: 0 }
  return { clip: 'WALK', rate: clamp(speed / walk), prowl: smooth((speed - walk * 1.15) / (walk * 0.45)) }
}

/** The body's vertical scale at prowl weight `p` (her tiger sinks 18 %) and the rider's forward lean (radians). */
export const PROWL_SQUASH = 0.18
export const PROWL_LEAN = 0.32

/** Eases a value toward a target at `ratePerS` (frame-rate independent). */
export function approach(cur: number, target: number, ratePerS: number, dt: number): number {
  const k = 1 - Math.exp(-ratePerS * Math.max(0, dt))
  return cur + (target - cur) * k
}
