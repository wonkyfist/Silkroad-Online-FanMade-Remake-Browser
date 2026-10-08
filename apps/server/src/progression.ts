import { CHARACTER_RULES } from '@sro/shared'

/** Saved growth state of a character (characters table, migration 3). */
export interface Progress {
  level: number
  /** EXP into the current level. */
  exp: number
  sp: number
  /** SP-EXP towards the next skill point. */
  spExp: number
  str: number
  int: number
  statPoints: number
}

/**
 * Adds EXP and SP-EXP (research report §4.5, CHARACTER_RULES): EXP overflow carries across several levels,
 * each level gives +1 STR, +1 INT and 3 stat points; at `cap` no EXP is kept (SP-EXP still counts);
 * every 400 SP-EXP becomes 1 SP. `expToNext(level)` = EXP from level to level + 1 (0 = unknown: stop).
 * Mutates `p`; returns the number of levels gained.
 */
export function gainExp(p: Progress, exp: number, spExp: number, cap: number, expToNext: (level: number) => number): number {
  let levels = 0
  if (p.level < cap) {
    p.exp += Math.max(0, Math.floor(exp))
    for (;;) {
      if (p.level >= cap) break
      const need = expToNext(p.level)
      if (need <= 0 || p.exp < need) break
      p.exp -= need
      p.level++
      levels++
      p.str += 1
      p.int += 1
      p.statPoints += CHARACTER_RULES.statPointsPerLevel
    }
  }
  if (p.level >= cap) p.exp = 0
  p.spExp += Math.max(0, Math.floor(spExp))
  p.sp += Math.floor(p.spExp / CHARACTER_RULES.spExpPerSp)
  p.spExp %= CHARACTER_RULES.spExpPerSp
  return levels
}

/**
 * SP a typical player owns on reaching `level` at SP_RATE 1 on the Climb's curve (docs/CLIMB.md §5.2, cap 25): the
 * kill SP-EXP of levels 1 … level−1 (kill SP-EXP = kill EXP = each level's EXP minus its quest share: 50 / 35 / 30 /
 * 25 / 20 % by band, 1–5, 6–10, 11–15, 16–20, 21–24) / 400, plus the quest SP (quest EXP / 600), over
 * content/climb/levels.json. Index = level − 1. Level 20 = 1,533 SP, level 25 = 3,575 (CLIMB §5.2's ≈ 3,575).
 * (The pre-Climb table, retail curve and the old questline: 0, 2, 4, 7, 10, 16, 28, 48, 78, 118, 171, 250, 357, 499,
 * 676, 894, 1182, 1546, 1993, 2530.)
 *
 *   level  1  2  3   4   5   6   7   8    9   10   11   12   13   14   15   16   17    18    19    20    21    22    23    24    25
 *   SP     0  3  9  17  29  45  67  97  135  183  241  312  396  496  611  746  903  1085  1293  1533  1813  2144  2536  3005  3575
 */
export const TYPICAL_SP_BY_LEVEL: readonly number[] = [0, 3, 9, 17, 29, 45, 67, 97, 135, 183, 241, 312, 396, 496, 611, 746, 903, 1085, 1293, 1533, 1813, 2144, 2536, 3005, 3575]

/**
 * `TYPICAL_SP_BY_LEVEL` for any level. Past the table (LEVEL_CAP > 25) every further level adds its kill SP-EXP, which
 * is the whole level's EXP there (no questline): floor(expToNext(l) / 400) for l = 25 … level−1 (0 without `expToNext`).
 */
export function typicalSp(level: number, expToNext?: (level: number) => number): number {
  const table = TYPICAL_SP_BY_LEVEL
  const l = Math.max(1, Math.floor(level))
  if (l <= table.length) return table[l - 1]!
  let sp = table[table.length - 1]!
  if (expToNext) for (let k = table.length; k < l; k++) sp += Math.floor(Math.max(0, expToNext(k)) / CHARACTER_RULES.spExpPerSp)
  return sp
}

/** What a GM setlevel changed, for the reply and the gm_audit row (never silent: docs/PLAYTEST.md, apps/server/README.md). */
export interface SetLevelChange {
  from: number
  to: number
  /** STR/INT change (+/−1 per level; never below the level-1 base). */
  str: number
  int: number
  /** Change of the free stat points (+3 per level raised; lowering takes back only unspent points). */
  statPoints: number
  /** Stat points of the removed levels that were already spent (lowering): they stay in STR/INT. */
  spentKept: number
  /** SP granted (raising: the typical SP of the new level minus that of the old one). Never negative. */
  sp: number
}

/**
 * GM setlevel: moves the level, resets the EXP into it to 0, and applies what a player of that level would have.
 * - Raising (from → to): the level-up growth for every level (+1 STR, +1 INT, +3 free stat points each, as gainExp),
 *   and the SP a typical player earns on the way at SP_RATE 1: typicalSp(to) − typicalSp(from).
 * - Lowering: takes back the automatic growth of the removed levels, +1 STR / +1 INT each (never below the level-1
 *   base) and their 3 free stat points each, but only as far as they are unspent; points already spent stay where
 *   they are. SP, SP-EXP and learned skills are never taken away (the SP may already be spent on skills). Raising
 *   again grants the SP again: GMs are trusted, and every change is in the reply and in gm_audit (SetLevelChange).
 * Mutates `p` and returns the change.
 */
export function setLevel(p: Progress, level: number, expToNext?: (level: number) => number): SetLevelChange {
  const from = p.level
  const d = level - from
  const before = { str: p.str, int: p.int, statPoints: p.statPoints, sp: p.sp }
  p.level = level
  p.exp = 0
  p.str = Math.max(CHARACTER_RULES.baseStr, p.str + d)
  p.int = Math.max(CHARACTER_RULES.baseInt, p.int + d)
  const points = p.statPoints + d * CHARACTER_RULES.statPointsPerLevel
  p.statPoints = Math.max(0, points)
  if (d > 0) p.sp += Math.max(0, typicalSp(level, expToNext) - typicalSp(from, expToNext))
  return {
    from,
    to: level,
    str: p.str - before.str,
    int: p.int - before.int,
    statPoints: p.statPoints - before.statPoints,
    spentKept: Math.max(0, -points),
    sp: p.sp - before.sp,
  }
}

/** One line for the GM reply and gm_audit, e.g. "STR +11, INT +11, stat points +33, SP +250". */
export function describeSetLevel(c: SetLevelChange): string {
  const n = (v: number) => (v >= 0 ? `+${v}` : String(v))
  const parts = [`STR ${n(c.str)}`, `INT ${n(c.int)}`, `stat points ${n(c.statPoints)}`]
  if (c.spentKept > 0) parts.push(`${c.spentKept} spent stat point${c.spentKept === 1 ? '' : 's'} kept`)
  parts.push(c.to < c.from ? `SP kept (${n(c.sp)})` : `SP ${n(c.sp)}`)
  return parts.join(', ')
}
