import type { SkillArea } from '@sro/shared'

/**
 * Area target selection (docs/SKILLS.md §4.2, §10.1 "At release"). Pure: works on x/z points, so the engine feeds it
 * the living enemies near the fight. The primary target always comes first and counts towards `maxTargets`
 * (0 = unlimited).
 *  - caster / target: everyone within `distance` (plus their body radius) of the centre, nearest first;
 *  - pierce / projectile_pierce: everyone on the caster -> primary line, within PIERCE_HALF_WIDTH_M of it, extended to
 *    the line length, nearest first;
 *  - chain: from the primary, repeatedly the nearest not-yet-hit one within `distance` of the last.
 */

export interface Candidate {
  id: number
  x: number
  z: number
  radius: number
}

/** Rule: half width of a pierce line (metres beyond the body radius). */
export const PIERCE_HALF_WIDTH_M = 1
/** Rule: a melee pierce reaches this far past the primary target (the `efr` distance is unconfirmed for lines). */
export const PIERCE_EXTRA_M = 2

export function selectTargets(area: SkillArea | undefined, caster: { x: number; z: number }, primary: Candidate, candidates: readonly Candidate[], lineLength = 0): Candidate[] {
  if (!area || area.shape.startsWith('unknown')) return [primary]
  const max = area.maxTargets > 0 ? area.maxTargets : Infinity
  const others = candidates.filter((c) => c.id !== primary.id)
  const out: Candidate[] = [primary]
  const take = (list: Candidate[]) => {
    for (const c of list) {
      if (out.length >= max) break
      out.push(c)
    }
  }
  const d = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)
  switch (area.shape) {
    case 'caster':
    case 'target': {
      const centre = area.shape === 'caster' ? caster : primary
      take(others.filter((c) => d(c, centre) <= area.distance + c.radius).sort((a, b) => d(a, centre) - d(b, centre)))
      return out
    }
    case 'pierce':
    case 'projectile_pierce': {
      const len0 = d(caster, primary)
      if (len0 <= 1e-6) return out
      const ux = (primary.x - caster.x) / len0
      const uz = (primary.z - caster.z) / len0
      const len = Math.max(len0 + (area.shape === 'pierce' ? PIERCE_EXTRA_M : 0), lineLength)
      const on: { c: Candidate; t: number }[] = []
      for (const c of others) {
        const t = (c.x - caster.x) * ux + (c.z - caster.z) * uz
        const perp = Math.abs((c.x - caster.x) * uz - (c.z - caster.z) * ux)
        if (t >= 0 && t <= len + c.radius && perp <= PIERCE_HALF_WIDTH_M + c.radius) on.push({ c, t })
      }
      take(on.sort((a, b) => a.t - b.t).map((x) => x.c))
      return out
    }
    case 'chain': {
      let last = primary
      const left = [...others]
      while (out.length < max) {
        let best = -1
        let bestD = Infinity
        left.forEach((c, i) => {
          const dd = d(c, last)
          if (dd <= area.distance + c.radius && dd < bestD) {
            best = i
            bestD = dd
          }
        })
        if (best < 0) break
        last = left.splice(best, 1)[0]
        out.push(last)
      }
      return out
    }
  }
  return out
}
