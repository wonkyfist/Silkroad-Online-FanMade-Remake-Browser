/**
 * The budget line (docs/WORLD_EDITOR.md §5 bottom bar, §7.2, D42, §F20): the region under the camera against the
 * per-region guardrails measured on today's export (warn early, refuse late), and the view's draws beside the nearest
 * measured bench scene. The guardrails count the carriers' retail LOD 0 triangles, before the tree swap (§7.2); the
 * Publish bench measures the swapped result.
 */
import { WE_GUARDRAILS } from '../../../../packages/shared/src/world-edits/index.ts'

export type BudgetLevel = 'ok' | 'warn' | 'refuse'

export interface RegionBudget {
  region: number
  placements: number
  models: number
  /** null while a model's triangles are still unknown (not loaded yet). */
  triangles: number | null
  level: BudgetLevel
  /** Plain-English problems ("Region 171,97 has 61,200 object triangles: over the 60,000 warning line"). */
  notes: string[]
}

export const levelOf = (v: number, line: { warn: number; refuse: number }): BudgetLevel => (v >= line.refuse ? 'refuse' : v >= line.warn ? 'warn' : 'ok')

const worst = (a: BudgetLevel, b: BudgetLevel): BudgetLevel => (a === 'refuse' || b === 'refuse' ? 'refuse' : a === 'warn' || b === 'warn' ? 'warn' : 'ok')

const n = (v: number) => v.toLocaleString('en-US')

/**
 * One region's numbers. `placements`: its current list (each with its model indices), `trianglesOf`: a model's LOD 0
 * triangles (undefined: not known yet).
 */
export function regionBudget(region: number, placements: ReadonlyArray<{ models: readonly number[] }>, trianglesOf: (model: number) => number | undefined): RegionBudget {
  const models = new Set<number>()
  let tris = 0
  let known = true
  for (const p of placements) {
    for (const m of p.models) {
      models.add(m)
      const t = trianglesOf(m)
      if (t === undefined) known = false
      else tris += t
    }
  }
  const name = `${region & 0xff},${region >> 8}`
  const notes: string[] = []
  const G = WE_GUARDRAILS
  let level: BudgetLevel = 'ok'
  const check = (v: number, line: { warn: number; refuse: number }, what: string) => {
    const l = levelOf(v, line)
    level = worst(level, l)
    if (l === 'warn') notes.push(`Region ${name} has ${n(v)} ${what}: over the ${n(line.warn)} warning line (Publish refuses at ${n(line.refuse)}).`)
    if (l === 'refuse') notes.push(`Region ${name} has ${n(v)} ${what}: Publish refuses at ${n(line.refuse)}. Delete or move some objects.`)
  }
  check(placements.length, G.placements, 'objects')
  check(models.size, G.models, 'different models')
  if (known) check(tris, G.objectTriangles, 'object triangles')
  return { region, placements: placements.length, models: models.size, triangles: known ? tris : null, level, notes }
}

/** The nearest measured bench scene for the view meter (budgets.md polish re-bench, WebGPU, engine draws). */
export const PLAZA_DRAWS = { low: 152, medium: 152, high: 218, ultra: 218 } as const

/** The bottom bar's budget text (plain text; the page colours the level). */
export function budgetText(b: RegionBudget | null, view: { draws: number; preset: keyof typeof PLAZA_DRAWS }): string {
  const parts: string[] = []
  if (b) {
    const name = `${b.region & 0xff},${b.region >> 8}`
    parts.push(b.triangles === null
      ? `Region ${name}: ${n(b.placements)} objects, ${n(b.models)} models (triangles: loading)`
      : `Region ${name}: ${n(b.triangles)} / ${n(WE_GUARDRAILS.objectTriangles.warn)} object triangles, ${n(b.placements)} objects`)
  }
  parts.push(`view ${n(view.draws)} draws (the plaza measures ${PLAZA_DRAWS[view.preset]} on ${view.preset[0]!.toUpperCase()}${view.preset.slice(1)})`)
  parts.push(!b || b.level === 'ok' ? 'within budget' : b.level === 'warn' ? 'over the warning line' : 'Publish would refuse this region')
  return parts.join(' · ')
}
