/**
 * Aiming an attack at a target above or below (mounted archery, the rider's upper-body attacks): the chest pitches
 * towards it (the actor's aimPitch, applied in models.ts applyUpperAim). No Babylon here (unit-tested).
 */

/** The height of the chest above an entity's feet (m, × its scale): where shots and swings aim. */
export const CHEST_Y = 1.1
/** The chest bends up or down at most this far towards its target (rad). */
export const AIM_PITCH_MAX = 0.75

/** The chest's pitch towards a point `dy` above (m, negative = below) at `horizontal` metres: + = up, clamped. */
export function aimPitchTo(dy: number, horizontal: number): number {
  if (!Number.isFinite(dy) || !Number.isFinite(horizontal)) return 0
  const p = Math.atan2(dy, Math.max(0.5, horizontal))
  return Math.max(-AIM_PITCH_MAX, Math.min(AIM_PITCH_MAX, p))
}
