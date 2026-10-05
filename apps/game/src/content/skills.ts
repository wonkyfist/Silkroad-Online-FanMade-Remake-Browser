/**
 * Skill content for the client (docs/SKILLS.md §10.3): the SkillCatalog over skills.json / masteries.json (rows by
 * code and by group, the learnable next row, why a row is locked, tooltip lines) and SkillState, what the server
 * says the character has learned (`skills` / `skillsUpdate`). No DOM; the server decides every outcome, this only
 * explains the window and picks the rows to ask for.
 *
 * Rules mirrored from the server (SKILLS.md §1.2-§1.3): a mastery goes up one level at a time, costs
 * `levels[L-1].masterySp` SP to reach level L and stops at the character level; skill level N of a group needs level
 * N-1, the row's `masteryLevel` in its mastery, its `sp` and its `requires`. Chain segments after the first share
 * the head's group and level and are never learned on their own.
 */
import { HOTBAR_SLOTS, MASTERY_CODES, MOUSE_SLOT, type HotbarEntry, type LevelDef, type MasteryCode, type MasteryDef, type ServerMessage, type SkillDef, type SkillKind } from '@sro/shared'
import type { TooltipLine } from '../hud/items.ts'
import { t, type StringKey } from '../i18n/index.ts'

/** The Chinese mastery total cap (SKILLS.md §1.2); never reached below level 47. */
export const CH_MASTERY_TOTAL = 330

/** Why the next level of a skill (or a mastery) cannot be learned now. */
export type LearnBlock = 'max' | 'mastery' | 'requires' | 'sp' | 'cap' | 'total' | 'unknown'

/** One skill line on a mastery page (a `ui.column`, one entry per tier `ui.row`). */
export interface SkillLine {
  group: string
  column: number
  row: number
  /** Level-1 head row (name, icon, placement). */
  head: SkillDef
}

/** `12` -> '12', `411` ms -> '0.41', `3000` -> '3': seconds with up to two decimals. */
export function seconds(ms: number): string {
  return String(Math.round(ms / 10) / 100)
}

/** Long form for tooltips: '5 min 35 sec', '5 sec', '0.41 sec'. */
export function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    const total = Math.round(ms / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    return s ? t('skills.time.minSec', { m, s }) : t('skills.time.min', { m })
  }
  return t('skills.time.sec', { s: seconds(ms) })
}

/** Short form under buff icons: '5:35', '59s'. */
export function formatShort(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  if (total >= 60) return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  return `${total}s`
}

/** Group of a row code the catalog does not know: `SKILL_CH_SWORD_SMASH_A_03` -> `SKILL_CH_SWORD_SMASH_A`. */
export function fallbackGroup(code: string): string {
  return code.replace(/(_\dS)?_\d+$/, '')
}

const byLevel = (a: SkillDef, b: SkillDef) => a.skillLevel - b.skillLevel

export class SkillCatalog {
  private readonly byCode = new Map<string, SkillDef>()
  /** Head rows (learnable levels) per group, by skill level. */
  private readonly heads = new Map<string, SkillDef[]>()
  private readonly masteryDefs = new Map<string, MasteryDef>()

  constructor(skills: Iterable<SkillDef>, masteries: Iterable<MasteryDef> = [], private readonly levels: readonly LevelDef[] = []) {
    for (const s of skills) this.byCode.set(s.code, s)
    for (const s of this.byCode.values()) {
      if (!s.group || s.basicAttack || (s.chainIndex !== undefined && s.chainIndex > 1)) continue
      let list = this.heads.get(s.group)
      if (!list) this.heads.set(s.group, (list = []))
      list.push(s)
    }
    for (const list of this.heads.values()) list.sort(byLevel)
    for (const m of masteries) this.masteryDefs.set(m.code, m)
  }

  get size(): number {
    return this.byCode.size
  }

  get(code: string): SkillDef | undefined {
    return this.byCode.get(code)
  }

  groupOf(code: string): string {
    return this.byCode.get(code)?.group ?? fallbackGroup(code)
  }

  /** Learnable rows of a group (chain heads only), level 1 first. */
  rows(group: string): readonly SkillDef[] {
    return this.heads.get(group) ?? []
  }

  row(group: string, level: number): SkillDef | undefined {
    return this.rows(group).find(r => r.skillLevel === level)
  }

  maxLevel(group: string): number {
    const rows = this.rows(group)
    return rows.length ? rows[rows.length - 1]!.skillLevel : 0
  }

  /** Highest level whose mastery requirement a mastery at `masteryLevel` meets. */
  maxLearnable(group: string, masteryLevel: number): number {
    let best = 0
    for (const r of this.rows(group)) if (r.masteryLevel <= masteryLevel) best = Math.max(best, r.skillLevel)
    return best
  }

  /** The row to learn after `learnedLevel` (null at the top). */
  nextRow(group: string, learnedLevel: number): SkillDef | null {
    return this.row(group, learnedLevel + 1) ?? null
  }

  /** Segments of the chain a row starts (itself first), following `chainNext`. */
  chain(code: string): SkillDef[] {
    const out: SkillDef[] = []
    let s = this.byCode.get(code)
    while (s && out.length < 16 && !out.includes(s)) {
      out.push(s)
      s = s.chainNext ? this.byCode.get(s.chainNext) : undefined
    }
    return out
  }

  mastery(code: string): MasteryDef | undefined {
    return this.masteryDefs.get(code)
  }

  /** Masteries of one skill window tab, by page. */
  masteries(tab: 'weapon' | 'force'): MasteryDef[] {
    return [...this.masteryDefs.values()]
      .filter(m => MASTERY_CODES.includes(m.code as MasteryCode) && (m.tab ?? (m.weapons.length ? 'weapon' : 'force')) === tab)
      .sort((a, b) => (a.page ?? a.id) - (b.page ?? b.id))
  }

  /** Skill lines shown on a mastery's page (rows with a `ui` placement), by column then tier. */
  lines(mastery: string): SkillLine[] {
    const out: SkillLine[] = []
    for (const [group, rows] of this.heads) {
      const head = rows[0]
      if (!head || head.mastery !== mastery || !head.ui) continue
      out.push({ group, column: head.ui.column, row: head.ui.row, head })
    }
    return out.sort((a, b) => a.column - b.column || a.row - b.row)
  }

  /** SP to raise a mastery to `level` (levels.json masterySp of that level); null past the table. */
  masteryCost(level: number): number | null {
    const row = this.levels[level - 1]
    return row && typeof row.masterySp === 'number' ? row.masterySp : null
  }

  /** Why `mastery` cannot go up one level now (null = it can). */
  masteryBlock(mastery: MasteryCode, state: SkillState, sp: number, charLevel: number): LearnBlock | null {
    const level = state.masteries[mastery] ?? 0
    if (level >= charLevel) return 'cap'
    let total = 0
    for (const c of MASTERY_CODES) total += state.masteries[c] ?? 0
    if (total >= CH_MASTERY_TOTAL) return 'total'
    const cost = this.masteryCost(level + 1)
    if (cost === null) return 'unknown'
    return sp < cost ? 'sp' : null
  }

  /** Why `row` cannot be learned now (null = it can). */
  learnBlock(row: SkillDef | null, state: SkillState, sp: number): LearnBlock | null {
    if (!row) return 'max'
    const group = row.group ?? fallbackGroup(row.code)
    if (row.skillLevel !== state.level(group) + 1) return row.skillLevel <= state.level(group) ? 'max' : 'unknown'
    if (row.mastery && (state.masteries[row.mastery as MasteryCode] ?? 0) < row.masteryLevel) return 'mastery'
    if (row.requires?.some(r => state.level(r.group) < r.level)) return 'requires'
    return sp < row.sp ? 'sp' : null
  }

  /** The tooltip caption of a learn block. */
  blockText(block: LearnBlock, row: SkillDef | null, sp = 0): string {
    switch (block) {
      case 'max':
        return t('skills.lock.max')
      case 'mastery':
        return t('skills.lock.mastery', { mastery: this.masteryName(row?.mastery ?? ''), level: row?.masteryLevel ?? 0 })
      case 'requires': {
        const r = row?.requires?.[0]
        return t('skills.lock.requires', { skill: r ? this.groupName(r.group) : '?', level: r?.level ?? 0 })
      }
      case 'sp':
        return t('skills.lock.sp', { need: row?.sp ?? 0, have: sp })
      case 'cap':
        return t('skills.lock.cap')
      case 'total':
        return t('skills.lock.total', { total: CH_MASTERY_TOTAL })
      case 'unknown':
        return t('skills.lock.unknown')
    }
  }

  masteryName(code: string): string {
    return this.masteryDefs.get(code)?.name ?? code
  }

  /** Display name of a group (its first row's name). */
  groupName(group: string): string {
    return this.rows(group)[0]?.name ?? group
  }

  /** Display name of a row (chain segments show their head's name). */
  name(code: string): string {
    const s = this.byCode.get(code)
    return s?.name ?? (s?.group ? this.groupName(s.group) : code)
  }

  icon(code: string): string | null {
    const s = this.byCode.get(code)
    return s?.icon ?? (s?.group ? this.rows(s.group)[0]?.icon ?? null : null)
  }

  /**
   * SRO skill tooltip: name and level, kind and mastery, MP, cast time (prepare + cast), cooldown, range, damage,
   * hits, area, statuses, heal, duration, then requirements when not learned and the description.
   */
  tooltip(code: string, opts: { learned?: boolean; block?: string | null; hint?: string } = {}): TooltipLine[] {
    const s = this.byCode.get(code)
    if (!s) return [{ text: code, cls: 'title' }]
    const lines: TooltipLine[] = [{ text: t('skills.tt.title', { name: this.name(code), level: s.skillLevel }), cls: 'title' }]
    const kind = s.kind ? t(`skills.kind.${s.kind}` as StringKey) : ''
    lines.push({ text: [kind, s.mastery ? this.masteryName(s.mastery) : ''].filter(Boolean).join('  ·  '), cls: 'type' })
    const stat = (text: string) => lines.push({ text, cls: 'stat' })
    // Chain: the head carries the cost; the damage and timing add up over the segments.
    const segs = s.chainNext ? this.chain(code) : [s]
    if (s.mp > 0) stat(t('skills.tt.mp', { mp: s.mp }))
    if (s.hp) stat(t('skills.tt.hp', { hp: s.hp }))
    if (s.mpPct) stat(t('skills.tt.mpPct', { pct: s.mpPct }))
    if (s.kind !== 'passive') {
      const cast = (s.preparingMs ?? 0) + (s.castMs > 1 ? s.castMs : 0)
      if (!s.instant && cast > 0) stat(t('skills.tt.cast', { time: formatDuration(cast) }))
      if (s.cooldownMs > 0) stat(t('skills.tt.cooldown', { time: formatDuration(s.cooldownMs) }))
      if (s.range > 0) stat(t('skills.tt.range', { m: s.range }))
      else if (s.targets?.required && s.targets.groups.some(g => g.startsWith('enemy'))) stat(t('skills.tt.rangeWeapon'))
    }
    for (const [i, seg] of segs.entries()) {
      const d = seg.damage
      if (!d) continue
      const parts: string[] = []
      if (d.physPct) parts.push(t('skills.tt.phys', { pct: d.physPct }))
      if (d.magPct) parts.push(t('skills.tt.mag', { pct: d.magPct }))
      const flat = d.flat[1] > 0 ? t('skills.tt.flat', { min: d.flat[0], max: d.flat[1] }) : ''
      const text = [parts.join(' / '), flat].filter(Boolean).join(' + ')
      if (!text) continue
      stat(segs.length > 1 ? t('skills.tt.chainHit', { n: i + 1, text }) : s.kind === 'imbue' ? t('skills.tt.imbue', { text }) : t('skills.tt.damage', { text }))
      if (d.hits > 1) stat(t('skills.tt.hits', { n: d.hits }))
    }
    if (s.area) {
      const shape = s.area.shape.startsWith('unknown') ? 'target' : s.area.shape
      const targets = s.area.maxTargets > 0 ? t('skills.tt.areaMax', { n: s.area.maxTargets }) : ''
      stat(t(`skills.area.${shape}` as StringKey, { m: s.area.distance }) + targets)
    }
    for (const st of s.statuses ?? []) {
      stat(t('skills.tt.status', { status: t(`skills.status.${st.status}` as StringKey), pct: st.chancePct, level: st.level }))
    }
    if (s.heal) {
      if (s.heal.hp || s.heal.hpPct) stat(t('skills.tt.healHp', { v: s.heal.hp ? String(s.heal.hp) : `${s.heal.hpPct}%` }))
      if (s.heal.mp || s.heal.mpPct) stat(t('skills.tt.healMp', { v: s.heal.mp ? String(s.heal.mp) : `${s.heal.mpPct}%` }))
    }
    if (s.toggle) stat(t('skills.tt.toggle', { mp: s.toggle.mp, time: formatDuration(s.toggle.intervalMs) }))
    else if (s.durationMs && s.kind !== 'attack') stat(t('skills.tt.duration', { time: formatDuration(s.durationMs) }))
    if (!opts.learned) {
      if (s.mastery) lines.push({ text: t('skills.tt.reqMastery', { mastery: this.masteryName(s.mastery), level: s.masteryLevel }), cls: 'req' })
      if (s.sp > 0) lines.push({ text: t('skills.tt.reqSp', { sp: s.sp }), cls: 'req' })
    }
    if (s.weapons.length) lines.push({ text: t('skills.tt.weapons', { list: s.weapons.map(w => t(`skills.weapon.${w}` as StringKey)).join(', ') }), cls: 'req' })
    if (opts.block) lines.push({ text: opts.block, cls: 'bad' })
    if (s.description) lines.push({ text: s.description, cls: 'desc' })
    if (opts.hint) lines.push({ text: opts.hint, cls: 'hint' })
    return lines
  }
}

const zeroMasteries = (): Record<MasteryCode, number> => Object.fromEntries(MASTERY_CODES.map(c => [c, 0])) as Record<MasteryCode, number>

type SkillsMsg = Extract<ServerMessage, { t: 'skills' }>
type SkillsUpdateMsg = Extract<ServerMessage, { t: 'skillsUpdate' }>

/** What changed with one message (the windows redraw only that). */
export interface SkillStateChange {
  masteries: boolean
  learned: string[]
  hotbar: number[]
  /** The mouse quick slot changed. */
  mouse?: boolean
}

/** The character's masteries, learned rows and hotbar, as the server last described them. */
export class SkillState {
  masteries: Record<MasteryCode, number> = zeroMasteries()
  /** Group -> the highest learned row code. */
  readonly learned = new Map<string, string>()
  hotbar: (HotbarEntry | null)[] = new Array<HotbarEntry | null>(HOTBAR_SLOTS).fill(null)
  /** The mouse quick slot (MOUSE_SLOT), saved on the server like the hotbar. */
  mouse: HotbarEntry | null = null
  /** The `skills` snapshot has arrived. */
  known = false

  constructor(private readonly catalog: SkillCatalog) {}

  /** Learned level of a group (0 = not learned). */
  level(group: string): number {
    const code = this.learned.get(group)
    if (!code) return 0
    return this.catalog.get(code)?.skillLevel ?? (Number(/_(\d+)$/.exec(code)?.[1]) || 1)
  }

  /** The highest learned row of a group (what useSkill sends), or null. */
  code(group: string): string | null {
    return this.learned.get(group) ?? null
  }

  isLearned(code: string): boolean {
    return this.learned.has(this.catalog.groupOf(code))
  }

  applySnapshot(msg: SkillsMsg): SkillStateChange {
    this.known = true
    this.masteries = { ...zeroMasteries(), ...msg.masteries }
    this.learned.clear()
    for (const code of msg.skills) this.learn(code)
    this.hotbar = Array.from({ length: HOTBAR_SLOTS }, (_, i) => msg.hotbar[i] ?? null)
    this.mouse = msg.mouse ?? null
    return { masteries: true, learned: [...this.learned.keys()], hotbar: this.hotbar.map((_, i) => i), mouse: true }
  }

  applyUpdate(msg: SkillsUpdateMsg): SkillStateChange {
    const change: SkillStateChange = { masteries: false, learned: [], hotbar: [] }
    if (msg.masteries) {
      for (const [code, level] of Object.entries(msg.masteries)) {
        if (!MASTERY_CODES.includes(code as MasteryCode) || typeof level !== 'number') continue
        this.masteries[code as MasteryCode] = level
        change.masteries = true
      }
    }
    for (const code of msg.learned ?? []) change.learned.push(this.learn(code))
    for (const u of msg.hotbar ?? []) {
      if (u.slot === MOUSE_SLOT) {
        this.mouse = u.entry
        change.mouse = true
        continue
      }
      if (!Number.isInteger(u.slot) || u.slot < 0 || u.slot >= HOTBAR_SLOTS) continue
      this.hotbar[u.slot] = u.entry
      change.hotbar.push(u.slot)
    }
    return change
  }

  /** Records `code` as its group's learned row; returns the group. */
  private learn(code: string): string {
    const group = this.catalog.groupOf(code)
    this.learned.set(group, code)
    return group
  }
}
