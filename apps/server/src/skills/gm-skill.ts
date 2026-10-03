import { MASTERY_CODES, type MasteryCode } from '@sro/shared'
import type { Player } from '../world.ts'
import { groupOf } from './book.ts'
import type { SkillEngine } from './engine.ts'

/**
 * The GM `skill` command body (docs/SKILLS.md §10.1 "Learning"; docs/WAVE_PLAN.md §4.3). gm.ts runs it behind the
 * usual role check and audit (PROTOCOL §10); it only changes the GM's own character.
 *
 *   skill all [mastery]    every mastery at `mastery` (default: the level cap) and every skill up to it
 *   skill <code> [level]   one skill line (a row code or its group) at `level` (default: the row's / the highest)
 *   skill sp <n>           adds n skill points
 *   skill cooldown         clears your skill cooldowns
 *   skill reset            forgets every mastery and skill
 */

export const SKILL_USAGE = 'skill all [mastery] | skill <code> [level] | skill sp <n> | skill cooldown | skill reset'

/** Most SP one `skill sp` adds. */
export const GM_SP_MAX = 1_000_000

export interface SkillCommandResult {
  ok: boolean
  message: string
  data?: unknown
}

const ok = (message: string, data?: unknown): SkillCommandResult => (data === undefined ? { ok: true, message } : { ok: true, message, data })
const no = (message: string): SkillCommandResult => ({ ok: false, message })

function int(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : NaN
}

export function runSkillCommand(engine: SkillEngine, p: Player, args: string[], levelCap: number, now = Date.now()): SkillCommandResult {
  const book = engine.book
  const sub = (args[0] ?? '').toLowerCase()
  if (!sub) return no(`Usage: ${SKILL_USAGE}`)
  if (book.size === 0) return no('No skills are loaded (skills.json is missing).')
  if (sub === 'all') {
    const level = int(args[1], 0, 300) ?? levelCap
    if (Number.isNaN(level) || args.length > 2) return no('Usage: skill all [mastery level 0-300]')
    const masteries = Object.fromEntries(MASTERY_CODES.map((c) => [c, level])) as Record<MasteryCode, number>
    const skills: [string, number][] = []
    for (const group of book.byGroup.keys()) {
      const row = book.maxLearned(group, level)
      if (row) skills.push([group, row.skillLevel])
    }
    engine.gmSet(p, masteries, skills, now)
    return ok(`Every mastery is now ${level}; ${skills.length} skill lines learned up to it.`, { mastery: level, skills: skills.length })
  }
  if (sub === 'sp') {
    const n = int(args[1], 1, GM_SP_MAX)
    if (n === null || Number.isNaN(n) || args.length > 2) return no(`Usage: skill sp <1-${GM_SP_MAX}>`)
    const sp = engine.gmAddSp(p, n)
    return ok(`Added ${n} SP (${sp} now).`, { sp })
  }
  if (sub === 'cooldown' || sub === 'cd') {
    engine.gmClearCooldowns(p)
    return ok('Your skill cooldowns are cleared.')
  }
  if (sub === 'reset') {
    engine.gmReset(p, now)
    return ok('Every mastery and skill is forgotten.')
  }
  const code = args[0].trim().toUpperCase()
  const any = book.skill(code)
  const group = any ? groupOf(book.head(any)) : book.byGroup.has(code) ? code : null
  if (!group || !book.byGroup.has(group)) return no(`No skill ${code}. ${SKILL_USAGE}`)
  const rows = book.byGroup.get(group)!
  const level = int(args[1], 1, rows[rows.length - 1].skillLevel)
  if (Number.isNaN(level) || args.length > 2) return no(`Usage: skill <code> [level 1-${rows[rows.length - 1].skillLevel}]`)
  const row = level !== null ? book.row(group, level) : any && !any.basicAttack ? book.head(any) : book.maxLearned(group, levelCap)
  if (!row) return no(`${code} has no level ${level}.`)
  const mastery = row.mastery as MasteryCode
  const have = engine.masteriesOf(p)[mastery] ?? 0
  engine.gmSet(p, have < row.masteryLevel ? { [mastery]: row.masteryLevel } : {}, [[group, row.skillLevel]], now)
  return ok(`Learned ${row.name ?? row.code} level ${row.skillLevel}${have < row.masteryLevel ? ` (${mastery} raised to ${row.masteryLevel})` : ''}.`, { skill: row.code })
}
