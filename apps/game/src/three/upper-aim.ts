/**
 * Mounted attacks (mounted archery, mounts.ts): retail has no mounted attack
 * clips, so the on-foot clip plays on the upper-body joints only over the riding pose
 * (CharacterActor.playUpper). Two things the on-foot clip did with the hips are lost that way:
 *  - the hip turn: an archer stands sideways, the clip's pelvis turns ~75° and the spine turns the chest back to the
 *    target, so over the saddle's forward-facing hips the bow pointed ~75° off to the side;
 *  - the facing: on foot the whole body turns to the target, on a moving horse the hips cannot.
 * `upperTwist` puts both back as one turn about the model's up axis (the clip's hip yaw against the base's, plus the
 * aim towards the target), clamped to ±AIM_MAX, and spreads it over the spine joints (AIM_SPREAD), weighted by the
 * layer's fade in and out (`upperWeight`). Pure math on Babylon quaternions (Hamilton products, parent ⊗ local).
 */
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'

/** The most the upper body turns away from the hips (radians, ~100°). */
export const AIM_MAX = (100 * Math.PI) / 180
/** The upper layer fades in and out over this long (seconds). */
export const UPPER_FADE_S = 0.12
/** Share of the turn per spine joint, hips up (retail Bip01: Spine, Spine1, Neck). */
export const AIM_SPREAD: readonly number[] = [0.45, 0.4, 0.15]

const UP = new Vector3(0, 1, 0)

/** `a` wrapped into (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a % (2 * Math.PI)
  if (x <= -Math.PI) x += 2 * Math.PI
  else if (x > Math.PI) x -= 2 * Math.PI
  return x
}

/** The yaw (about +Y) of the rotation that takes orientation `from` to `to` (both in the same parent frame). */
export function yawBetween(from: Quaternion, to: Quaternion): number {
  // D = to ⊗ from⁻¹ (in the parent frame); its twist about +Y: 2·atan2(D.y, D.w)
  const d = to.multiply(Quaternion.Inverse(from))
  if (d.w < 0) d.scaleInPlace(-1)
  return wrapAngle(2 * Math.atan2(d.y, d.w))
}

/** The total turn of the upper body: hip yaw carried over plus the aim, clamped to ±AIM_MAX. */
export function upperTurn(hipYaw: number, aimYaw: number, max = AIM_MAX): number {
  const t = wrapAngle(hipYaw + aimYaw)
  return Math.max(-max, Math.min(max, t))
}

/** The turn split over the spine joints (AIM_SPREAD shares; any count of joints: the shares renormalised). */
export function spreadTurn(turn: number, joints: number, spread: readonly number[] = AIM_SPREAD): number[] {
  const s = spread.slice(0, joints)
  const sum = s.reduce((a, b) => a + b, 0) || 1
  return s.map(x => (turn * x) / sum)
}

/**
 * The layer's weight `t` seconds after it started, for a clip of `dur` seconds: 0 → 1 over `fade`, 1 while it plays,
 * then 1 → 0 over `fade` after it ended. 0 before the start and once faded out.
 */
export function upperWeight(t: number, dur: number, fade = UPPER_FADE_S): number {
  if (!(t >= 0)) return 0
  if (fade <= 0) return t <= dur ? 1 : 0
  if (t <= dur) return Math.min(1, t / fade)
  return Math.max(0, 1 - (t - dur) / fade)
}

/**
 * Babylon's clip blend steps once per evaluation: the blendingSpeed that fades in `seconds` at `fps` frames a second
 * (at most 1 = no blend).
 */
export function blendSpeedFor(seconds: number, fps = 60): number {
  if (!(seconds > 0) || !(fps > 0)) return 1
  return Math.min(1, 1 / (seconds * fps))
}

/**
 * Turns joint `local` (the joint's local rotation, its parent's orientation `parentWorld` in the model frame) by
 * `angle` about the model's up axis: local' = parentWorld⁻¹ ⊗ R(up, angle) ⊗ parentWorld ⊗ local. Written into `out`.
 */
export function turnJoint(local: Quaternion, parentWorld: Quaternion, angle: number, out: Quaternion): Quaternion {
  const r = Quaternion.RotationAxis(UP, angle)
  const inv = Quaternion.Inverse(parentWorld)
  inv.multiply(r).multiply(parentWorld).multiply(local).normalizeToRef(out)
  return out
}

/** The model frame's side axis: a bend about it tips the chest up or down (BEND_SIGN: + = up). */
const SIDE = new Vector3(1, 0, 0)
/** The sign that makes a positive bend lean the chest back (aim up) in the model frame (checked on the frame strips). */
export const BEND_SIGN = -1
/** The settle after a release in the air: the chest kicks back by RECOIL_RAD, peaking RECOIL_PEAK_S after it, then eases. */
export const RECOIL_RAD = 0.12
export const RECOIL_PEAK_S = 0.08

/** The settle's bend `t` seconds after the release (0 before it, RECOIL_RAD at the peak, fading out within ≈ 0.6 s). */
export function recoilAt(t: number): number {
  if (!(t > 0)) return 0
  const x = t / RECOIL_PEAK_S
  const r = RECOIL_RAD * x * Math.exp(1 - x)
  return r < 1e-3 && x > 1 ? 0 : r
}

/**
 * The chest's total bend (rad, + = up): the aim at the target (±AIM_MAX) times the layer's weight `w`, plus the settle
 * `sinceRelease` seconds after the release (null: none; only in the air).
 */
export function upperPitch(aimPitch: number, w: number, sinceRelease: number | null): number {
  const aim = Math.max(-AIM_MAX, Math.min(AIM_MAX, Number.isFinite(aimPitch) ? aimPitch : 0)) * w
  return aim + (sinceRelease === null ? 0 : recoilAt(sinceRelease) * w)
}

/** Bends joint `local` by `angle` (+ = chest up) about the model's side axis (as turnJoint does about up). */
export function bendJoint(local: Quaternion, parentWorld: Quaternion, angle: number, out: Quaternion): Quaternion {
  const r = Quaternion.RotationAxis(SIDE, angle * BEND_SIGN)
  const inv = Quaternion.Inverse(parentWorld)
  inv.multiply(r).multiply(parentWorld).multiply(local).normalizeToRef(out)
  return out
}
