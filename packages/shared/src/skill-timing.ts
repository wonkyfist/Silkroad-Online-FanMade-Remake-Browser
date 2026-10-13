import type { SkillDef } from './content.ts'

/**
 * Projectile hit timing shared by the server (skills/engine.ts), the client's FX lab and the tests (docs/SKILLS.md
 * §5.3): hit i of a row flies on cue i (the last cue for extra hits), leaves `offsetMs` after the release (its clip
 * event: a 4 Arrow Combo releases one arrow per event) and lands `delayMs + distance / (speed / 10)` later.
 */

/** ms after the release at which each of `hits` hits lands at `distanceM` metres; null when the row flies nothing. */
export function hitArrivalsMs(row: Pick<SkillDef, 'hitCues'>, hits: number, distanceM: number): number[] | null {
  const cues = row.hitCues ?? []
  const first = cues.find(c => c.projectile && c.projectile.speed > 0)?.projectile
  if (!first) return null
  const d = Math.max(0, distanceM)
  return Array.from({ length: Math.max(1, hits) }, (_, i) => {
    const cue = cues[i] ?? cues[cues.length - 1]
    const p = cue?.projectile && cue.projectile.speed > 0 ? cue.projectile : first
    return Math.round(Math.max(0, cue?.offsetMs ?? 0) + Math.max(0, p.delayMs) + (d / (p.speed / 10)) * 1000)
  })
}

/** Consecutive hits that land together (one combat each): first hit index, count, ms after the release. */
export function arrivalGroups(arrivals: readonly number[]): { from: number; count: number; ms: number }[] {
  const out: { from: number; count: number; ms: number }[] = []
  arrivals.forEach((ms, i) => {
    const last = out[out.length - 1]
    if (last && last.ms === ms) last.count++
    else out.push({ from: i, count: 1, ms })
  })
  return out
}
