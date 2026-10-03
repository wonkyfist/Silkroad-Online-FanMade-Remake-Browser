import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTENT_FILES, MASTERY_CODES, contentEntries, type MasteryCode, type MasteryDef, type SkillDef, type WeaponType } from '@sro/shared'

/**
 * The skill book (docs/SKILLS.md §1.3, §2, §3.2; docs/WAVE_PLAN.md §4.3): skills.json and masteries.json indexed by
 * row code and by group. A group's learnable rows are its chain heads (every segment of Illusion Chain shares the
 * group and the skill level; only the first segment is learned and cast, the others follow it).
 */

/** Rows the engine can run: Chinese masteries, and the basic attacks. */
const USABLE_MASTERIES = new Set<string>(MASTERY_CODES)

/** Basic-attack row of a weapon family when the weapon's ItemDef.basicAttack is absent (docs/WAVE_PLAN.md decision 10). */
export const BASIC_ROWS: Record<WeaponType | 'fist', string> = {
  fist: 'SKILL_PUNCH_01',
  sword: 'SKILL_CH_SWORD_BASE_01',
  blade: 'SKILL_CH_SWORD_BASE_01',
  spear: 'SKILL_CH_SPEAR_BASE_01',
  glaive: 'SKILL_CH_SPEAR_BASE_01',
  bow: 'SKILL_CH_BOW_BASE_01',
}

export const groupOf = (s: SkillDef): string => s.group ?? s.code

/** A row of a line that the player learns (not a chain segment after the first). */
export const isHead = (s: SkillDef): boolean => (s.chainIndex ?? 1) === 1

export class SkillBook {
  readonly byCode = new Map<string, SkillDef>()
  /** group -> learnable rows (chain heads), by skill level. */
  readonly byGroup = new Map<string, SkillDef[]>()
  readonly masteries = new Map<string, MasteryDef>()
  /** Lines (groups) per mastery, in data order. */
  readonly linesOf = new Map<string, string[]>()

  static load(outDir: string, log: (m: string) => void = () => {}): SkillBook {
    const read = (file: string): unknown[] => {
      try {
        return contentEntries<unknown>(JSON.parse(readFileSync(join(outDir, 'data', file), 'utf8')))
      } catch {
        return []
      }
    }
    const skills = read(CONTENT_FILES.skills).filter(validSkill)
    const masteries = read(CONTENT_FILES.masteries).filter(validMastery)
    const book = new SkillBook(skills, masteries)
    log(`content skills.json: ${book.byCode.size} rows, ${book.byGroup.size} skill lines, ${book.masteries.size} masteries`)
    return book
  }

  constructor(skills: SkillDef[] = [], masteries: MasteryDef[] = []) {
    for (const m of masteries) this.masteries.set(m.code, m)
    for (const s of skills) {
      if (this.byCode.has(s.code)) continue
      if (s.mastery !== null && !USABLE_MASTERIES.has(s.mastery)) continue
      this.byCode.set(s.code, s)
      if (s.basicAttack || !isHead(s) || s.mastery === null) continue
      const g = groupOf(s)
      const rows = this.byGroup.get(g)
      if (rows) rows.push(s)
      else {
        this.byGroup.set(g, [s])
        this.linesOf.set(s.mastery, [...(this.linesOf.get(s.mastery) ?? []), g])
      }
    }
    for (const rows of this.byGroup.values()) rows.sort((a, b) => a.skillLevel - b.skillLevel)
  }

  get size(): number {
    return this.byCode.size
  }

  skill(code: string): SkillDef | undefined {
    return this.byCode.get(code)
  }

  /** The learnable row of `group` at skill level `level`. */
  row(group: string, level: number): SkillDef | undefined {
    return this.byGroup.get(group)?.find((s) => s.skillLevel === level)
  }

  /** The chain head of a row (itself when it is not a later segment). */
  head(s: SkillDef): SkillDef {
    if (isHead(s)) return s
    const root = s.chainRoot ? this.byCode.get(s.chainRoot) : undefined
    return root ?? s
  }

  /** The row after `level` in `group` (the next one to learn), if any. */
  nextRow(group: string, level: number): SkillDef | undefined {
    return this.byGroup.get(group)?.find((s) => s.skillLevel > level)
  }

  /** Highest row of `group` whose mastery level is at most `masteryLevel`. */
  maxLearned(group: string, masteryLevel: number): SkillDef | undefined {
    let best: SkillDef | undefined
    for (const s of this.byGroup.get(group) ?? []) if (s.masteryLevel <= masteryLevel) best = s
    return best
  }

  /** The segment after `s` in its chain (Illusion Chain 1S -> 2S -> 3S). */
  chain(s: SkillDef): SkillDef | undefined {
    return s.chainNext ? this.byCode.get(s.chainNext) : undefined
  }

  /** The basic-attack row for a weapon: its ItemDef.basicAttack, else the family's row (fist: punch). */
  basic(weapon: WeaponType | 'fist' | string, itemBasic?: string): SkillDef | undefined {
    return (itemBasic ? this.byCode.get(itemBasic) : undefined) ?? this.byCode.get(BASIC_ROWS[weapon as WeaponType | 'fist'] ?? BASIC_ROWS.fist)
  }

  /** A mastery code as the wire knows it. */
  static mastery(code: string | null): MasteryCode | null {
    return code !== null && USABLE_MASTERIES.has(code) ? (code as MasteryCode) : null
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Lenient check of a skills.json row: the fields the engine reads without guards. */
function validSkill(v: unknown): v is SkillDef {
  return (
    isObj(v) &&
    typeof v.code === 'string' &&
    (v.mastery === null || typeof v.mastery === 'string') &&
    num(v.masteryLevel) &&
    num(v.skillLevel) &&
    num(v.sp) &&
    num(v.mp) &&
    num(v.castMs) &&
    num(v.actionMs) &&
    num(v.cooldownMs) &&
    num(v.range) &&
    Array.isArray(v.weapons)
  )
}

function validMastery(v: unknown): v is MasteryDef {
  return isObj(v) && typeof v.code === 'string' && Array.isArray(v.skills)
}
