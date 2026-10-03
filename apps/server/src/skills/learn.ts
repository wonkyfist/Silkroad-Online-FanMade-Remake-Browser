import type { ActionFailReason, LevelDef, MasteryCode, SkillDef } from '@sro/shared'
import type { SkillBook } from './book.ts'

/**
 * Learning rules (docs/SKILLS.md §1.2-§1.3): a mastery level costs levels.json `masterySp` of the level reached
 * (1, 1, 1, 2, 2, 4, ...), stops at the character level and at CH_MASTERY_TOTAL over all masteries; skill level N
 * needs level N - 1 of the group, the mastery at the row's level, its SP and its prerequisites.
 */

/** RR §4.4: total mastery levels of a Chinese character (never reached below level 47). */
export const CH_MASTERY_TOTAL = 330

export type LearnCheck = { ok: true; sp: number } | { ok: false; reason: ActionFailReason; message?: string }

const no = (reason: ActionFailReason, message?: string): LearnCheck => (message ? { ok: false, reason, message } : { ok: false, reason })

/** SP to raise a mastery to `level` (levels.json row `level`); null when the table has no such row. */
export function masteryCost(levels: readonly LevelDef[], level: number): number | null {
  const row = levels[level - 1]
  return row && row.level === level ? row.masterySp : null
}

export function checkMasteryUp(p: { level: number; sp: number }, masteries: Record<MasteryCode, number>, code: MasteryCode, levels: readonly LevelDef[]): LearnCheck {
  const next = (masteries[code] ?? 0) + 1
  if (next > p.level) return no('mastery_cap', 'A mastery cannot go above your character level.')
  const total = Object.values(masteries).reduce((s, l) => s + l, 0)
  if (total + 1 > CH_MASTERY_TOTAL) return no('mastery_cap', `At most ${CH_MASTERY_TOTAL} mastery levels in total.`)
  const cost = masteryCost(levels, next)
  if (cost === null) return no('mastery_cap')
  if (p.sp < cost) return no('no_sp')
  return { ok: true, sp: cost }
}

/** Whether `row` is the next learnable row for this character. */
export function checkLearn(row: SkillDef, book: SkillBook, sp: number, masteries: Record<MasteryCode, number>, skills: ReadonlyMap<string, number>): LearnCheck {
  const group = row.group ?? row.code
  if (row.basicAttack || row.mastery === null || !book.row(group, row.skillLevel) || book.row(group, row.skillLevel) !== row) return no('not_found')
  const have = skills.get(group) ?? 0
  if (row.skillLevel <= have) return no('requirements', 'You already know this skill level.')
  if (row.skillLevel !== have + 1) return no('requirements', 'Learn the previous level first.')
  if ((masteries[row.mastery as MasteryCode] ?? 0) < row.masteryLevel) return no('requirements', `Needs mastery level ${row.masteryLevel}.`)
  for (const r of row.requires ?? []) if ((skills.get(r.group) ?? 0) < r.level) return no('requirements')
  if (sp < row.sp) return no('no_sp')
  return { ok: true, sp: row.sp }
}
