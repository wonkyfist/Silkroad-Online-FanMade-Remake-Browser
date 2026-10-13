/**
 * Attacking from the air (docs/SKY_MONSTERS.md §4), the body's side: the clip, the cast effects and the projectiles
 * play on the upper body (models.ts playUpperSkill) while this blends the flight pose into an attack stance. No
 * Babylon here (unit-tested): EntityView.updateAir applies the result.
 *  - a steady hover for bows and nukes (and a melee swing once in reach): the torso upright, the legs hanging (FLY_HOVER),
 *    slower, stronger wingbeats;
 *  - a melee dash (the server's ≤ 8 m dash in at 22 m/s) leans into a short swoop, nose towards the lunge;
 *  - out of it again over STANCE_BLEND_S when the action has faded.
 * The chest's pitch towards a target above or below and the settle after the release are the actor's (aimPitch, the
 * recoil in models.ts applyUpperAim).
 */
import type { BaseClip } from '../three/models.ts'

/** Blend in / out of the attack stance (s). */
export const STANCE_BLEND_S = 0.25
/** The body's pitch while hovering to attack (rad, + = nose down): all but upright. */
export const HOVER_ATTACK_PITCH = 0.04
/** The hover clip's rate while attacking: slower, stronger beats than a free hover (the wings follow the clip). */
export const HOVER_ATTACK_RATE = 0.8
/** Faster than this over the ground (m/s) while attacking = the melee dash: a swoop. */
export const SWOOP_SPEED = 8
/** The swoop's lean (rad): from SWOOP_PITCH_MIN, more the faster, at most SWOOP_PITCH_MAX. */
export const SWOOP_PITCH_MIN = 0.35
export const SWOOP_PITCH_MAX = 0.9
/** The height of the chest above an entity's feet (m, × its scale): where shots and swings aim. */
export const CHEST_Y = 1.1
/** The chest bends up or down at most this far towards its target (rad). */
export const AIM_PITCH_MAX = 0.75

export interface AirPose {
  pitch: number
  roll: number
  clip: BaseClip
  rate?: number
}

export interface AirStance {
  /** 0 = the flight pose, 1 = the attack stance. */
  weight: number
  pitch: number
  roll: number
  clip: BaseClip
  rate: number
  swoop: boolean
}

/**
 * The stance this frame: `weight` (the previous frame's) eases towards `attacking`; `vel` is the flyer's velocity
 * (m/s). The flight pose `a` (from the flight prediction) is kept as it is at weight 0.
 */
export function airStance(weight: number, a: AirPose, vel: readonly number[], attacking: boolean, dt: number): AirStance {
  const step = dt > 0 ? dt / STANCE_BLEND_S : 0
  const w = Math.max(0, Math.min(1, weight + (attacking ? step : -step)))
  const ground = Math.hypot(vel[0] ?? 0, vel[2] ?? 0)
  const swoop = attacking && ground > SWOOP_SPEED
  const want = swoop ? Math.min(SWOOP_PITCH_MAX, SWOOP_PITCH_MIN + (ground - SWOOP_SPEED) * 0.04) : HOVER_ATTACK_PITCH
  const pitch = a.pitch + (want - a.pitch) * w
  const roll = a.roll * (1 - w)
  const stanceClip: BaseClip = swoop ? a.clip : 'FLY_HOVER'
  const clip = w > 0.5 ? stanceClip : a.clip
  const rate = w > 0.5 && !swoop ? HOVER_ATTACK_RATE : (a.rate ?? 1)
  return { weight: w, pitch, roll, clip, rate, swoop }
}

/** The chest's pitch towards a point `dy` above (m, negative = below) at `horizontal` metres: + = up, clamped. */
export function aimPitchTo(dy: number, horizontal: number): number {
  if (!Number.isFinite(dy) || !Number.isFinite(horizontal)) return 0
  const p = Math.atan2(dy, Math.max(0.5, horizontal))
  return Math.max(-AIM_PITCH_MAX, Math.min(AIM_PITCH_MAX, p))
}
