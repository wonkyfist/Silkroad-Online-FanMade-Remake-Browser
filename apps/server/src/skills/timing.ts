import type { SkillDef } from '@sro/shared'

/**
 * Action timing (docs/SKILLS.md §5): t0 = accepted (cost paid, cooldown armed); READY for preparingMs, WAIT for
 * castMs, release at t0 + preparingMs + castMs; SHOT for actionMs; the action closes at release + actionMs.
 * Projectile cues land `delayMs + distance / (speed / 10)` after the release (speed in dm/s, §5.3).
 */

export interface Phases {
  prepareMs: number
  castMs: number
  actionMs: number
}

export interface Timeline extends Phases {
  t0: number
  releaseAt: number
  endAt: number
}

export function phases(s: SkillDef): Phases {
  return { prepareMs: Math.max(0, s.preparingMs ?? 0), castMs: Math.max(0, s.castMs), actionMs: Math.max(0, s.actionMs) }
}

export function timeline(s: SkillDef, t0: number): Timeline {
  const p = phases(s)
  const releaseAt = t0 + p.prepareMs + p.castMs
  return { ...p, t0, releaseAt, endAt: releaseAt + p.actionMs }
}

/** The skill's projectile (first damage cue that flies), if any. */
export function projectileOf(s: SkillDef): { delayMs: number; speed: number } | null {
  const cue = s.hitCues?.find((c) => c.projectile)
  return cue?.projectile && cue.projectile.speed > 0 ? { delayMs: Math.max(0, cue.projectile.delayMs), speed: cue.projectile.speed } : null
}

/** Arrival time of a projectile released at `releaseAt` over `distance` metres (speed: dm per second). */
export function arrivalAt(releaseAt: number, distance: number, projectile: { delayMs: number; speed: number }): number {
  return Math.round(releaseAt + projectile.delayMs + (Math.max(0, distance) / (projectile.speed / 10)) * 1000)
}
