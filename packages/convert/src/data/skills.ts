/**
 * skills.json / masteries.json: the seven Chinese masteries and their skills up to a mastery level (default 20, the
 * level cap), plus the weapon basic attacks. Client skilldata (plaintext skilldata_*.txt), skillmasterydata,
 * skilleffect (skillaniset2 section) and the string tables. Also the monster attacks mobs.ts reads.
 */
import { skillDetail, type SkillDataRow, type SkillDetail, type SkillParam } from '@sro/formats'
import type { MasteryDef, SkillArea, SkillCategory, SkillDamage, SkillDef, SkillHitCue, SkillKind, SkillStatus, SkillTargets, SkillUi, WeaponType } from '../../../shared/src/content.ts'
// The skills.json field types live in @sro/shared (content.ts, docs/WAVE_PLAN.md §2.1); re-exported for existing importers.
export type { SkillArea, SkillHitCue, SkillKind, SkillStatus, SkillTargets, SkillUi } from '../../../shared/src/content.ts'
import { textOf } from './client-source.ts'
import { iconUrl } from './models.ts'

/** Chinese mastery ids (skillmasterydata col 0) and the code the export gives them. */
export const CH_MASTERIES: ReadonlyArray<{ id: number; code: string }> = [
  { id: 257, code: 'BICHEON' },
  { id: 258, code: 'HEUKSAL' },
  { id: 259, code: 'PACHEON' },
  { id: 273, code: 'COLD' },
  { id: 274, code: 'LIGHTNING' },
  { id: 275, code: 'FIRE' },
  { id: 276, code: 'FORCE' },
]

/** Highest mastery level whose skill rows are exported: the level cap (25 since the Climb, docs/CLIMB.md §5.2; was 20). */
export const MAX_SKILL_MASTERY_LEVEL = 25

const WEAPON_BY_TID4: Readonly<Record<number, WeaponType>> = { 2: 'sword', 3: 'blade', 4: 'spear', 5: 'glaive', 6: 'bow' }

/**
 * Category: Basic_Activity 0 or Param1 (col 68) 4 -> passive; Param1 3 -> buff (imbues, self buffs); Param1 1 ->
 * ranged. Otherwise a skill that hits enemies (an 'att' record, or enemy target groups such as Cold wave - Arrest)
 * is ranged when it has its own Range (col 21 > 0: Shock Lion Shout 15 m) and melee when it uses the weapon's
 * reach; anything else (heals, cures, shields with Param1 0) -> buff. `extra` is optional so callers that only
 * have the detail keep the old answer.
 */
export function skillCategory(d: Pick<SkillDetail, 'activity' | 'category' | 'params'> & { range?: number }, extra: { targetsEnemy?: boolean } = {}): SkillCategory {
  if (d.activity === 0 || d.category === 4) return 'passive'
  if (d.category === 3) return 'buff'
  if (d.category === 1) return 'ranged'
  if (d.params.some(p => p.tag === 'att') || extra.targetsEnemy) return (d.range ?? 0) > 0 ? 'ranged' : 'melee'
  return 'buff'
}

const TARGET_GROUPS = ['self', 'ally', 'party', 'enemy_mob', 'enemy_player', 'neutral', 'any'] as const

const cellNum = (cells: readonly string[], col: number): number => {
  const n = Number((cells[col] ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

export function skillTargets(cells: readonly string[]): SkillTargets {
  const t: SkillTargets = { required: cellNum(cells, 22) !== 0, groups: TARGET_GROUPS.filter((_, i) => cellNum(cells, 26 + i) !== 0) }
  if (cellNum(cells, 33) !== 0) t.deadBody = true
  return t
}

export function skillUi(cells: readonly string[]): SkillUi | undefined {
  const [tab, page, column, row] = [57, 58, 59, 60].map(c => cellNum(cells, c)) as [number, number, number, number]
  if (tab === 255 || page === 255 || column === 255 || (tab !== 0 && tab !== 1)) return undefined
  return { tab: tab === 0 ? 'weapon' : 'force', page, column, row }
}

/**
 * 'efr' [1, shape, distance, maxTargets, reduction, targetMask] (6 args on every row). Shape, read from the
 * skills that use it: 1 a circle around the caster (Ghost Spear - Petal 2 m, Force Cure area 20 m), 2 a circle
 * around the primary target (Dancing Demon Spear 1 m, Shock Lion Shout 2 m), 3 a melee pierce through the target
 * (Wolf Bite Spear), 4 a projectile pierce (Autumn Wind - Flame), 6 a chain from target to target (Thunder Tiger
 * Force 3.5 m). `distance` is in dm like Range (bow special rows repeat their col 21 value). `maxTargets` counts
 * the primary target (0 = unlimited). `reduction` (0-80) is unconfirmed: it shrinks with the higher tiers of the
 * pierce lines (35, 25, 20), so it is probably the damage reduction for secondary targets. `targetMask` repeats the
 * target-group bits of cols 26-30 (1 self, 2 ally, 4 party, 8 enemy mob, 16 enemy player): 24 on attacks, 5/7 on
 * party heals and cures.
 */
const AREA_SHAPES: Readonly<Record<number, SkillArea['shape']>> = { 1: 'caster', 2: 'target', 3: 'pierce', 4: 'projectile_pierce', 6: 'chain' }

export function skillArea(params: readonly SkillParam[]): SkillArea | undefined {
  const efr = params.find(p => p.tag === 'efr')
  if (!efr || efr.args.length < 4) return undefined
  const [, shape, distance, maxTargets, reduction, mask] = efr.args as [number, number, number, number, number?, number?]
  return {
    shape: AREA_SHAPES[shape] ?? `unknown_${shape}`,
    distance: Math.round(distance) / 10,
    maxTargets,
    reductionPct: reduction ?? 0,
    targetMask: mask ?? 0,
    raw: [...efr.args],
  }
}

/**
 * Abnormal states and crowd control a skill inflicts (param records): fz freeze / fb frostbite [level, chance %],
 * es electric shock [level, chance %, effect %], bu burn [level, chance %, damage], ps poison, zb zombie, dn
 * darkness (same [level, chance] head), st stun [duration ms, chance %, level], ko knockdown [level, chance %],
 * kb knockback [distance/level, chance %]. Names follow textuisystem PARAM_FZ/FB/ES/BU/KO/KB and the
 * UIIT_MSG_STATE_SKILL_CURSING_* messages; argument meanings are read from the rows (levels rise with the skill,
 * chances stay put), not from a spec.
 */
const STATUS_TAGS: Readonly<Record<string, SkillStatus['status']>> = {
  fz: 'freeze', fb: 'frostbite', es: 'shock', bu: 'burn', ps: 'poison', zb: 'zombie', dn: 'darkness', ko: 'knockdown', kb: 'knockback',
}

export function skillStatuses(params: readonly SkillParam[]): SkillStatus[] {
  const out: SkillStatus[] = []
  for (const p of params) {
    if (p.tag === 'st' && p.args.length >= 3) {
      out.push({ status: 'stun', level: p.args[2]!, chancePct: p.args[1]!, durationMs: p.args[0]! })
      continue
    }
    const status = STATUS_TAGS[p.tag]
    if (!status || p.args.length < 2) continue
    const s: SkillStatus = { status, level: p.args[0]!, chancePct: p.args[1]! }
    if (p.args.length > 2) s.extra = p.args.slice(2)
    out.push(s)
  }
  return out
}

/** 'heal' [hp, hp %, mp, mp %] (Heal - Medical Hand 369; Soul Rebirth Art 0, 10, 0, 10). */
export function skillHeal(params: readonly SkillParam[]): { hp: number; hpPct: number; mp: number; mpPct: number } | undefined {
  const h = params.find(p => p.tag === 'heal')
  if (!h || !h.args.length) return undefined
  const [hp = 0, hpPct = 0, mp = 0, mpPct = 0] = h.args
  return { hp, hpPct, mp, mpPct }
}

/**
 * What the skill does, for the engine and the tooltip: passive (activity 0 / Param1 4), imbue (activity 1 with an
 * 'att' record: the weapon-infusing force skills), attack ('att'), resurrect ('resu'), heal ('heal'), cure
 * ('curt'/'curl'), debuff (hits enemies with statuses only: Cold wave - Arrest), otherwise buff.
 */
export function skillKind(d: Pick<SkillDetail, 'activity' | 'category' | 'params'>, targets?: SkillTargets): SkillKind {
  const has = (t: string) => d.params.some(p => p.tag === t)
  if (d.activity === 0 || d.category === 4) return 'passive'
  if (has('att')) return d.activity === 1 ? 'imbue' : 'attack'
  if (has('resu')) return 'resurrect'
  if (has('heal')) return 'heal'
  if (has('curt') || has('curl')) return 'cure'
  if (targets?.groups.some(g => g === 'enemy_mob' || g === 'enemy_player')) return 'debuff'
  return 'buff'
}

/**
 * Damage moments from skilleffect.txt `skilleffectset` rows whose DMG Event (col 4) is TRUE, keyed by
 * SkillEffectID (col 1 = Basic_Group), in phase order READY, WAIT, SHOT, then ACT_*, then StartEvent. `event` is
 * the StartEvent (col 3): N = the N-th type-1 (hit) event of that phase's clip, 0 = the phase start. A row with an
 * AT_MOV_* ActType (col 13) is a projectile: `move` is MovTypeSpeed (col 14) `MOV_<type>,<delay ms>,<speed>,<speed>`
 * and the damage shows on arrival. Checked on the real rows: Strike Smash SHOT event 1 = 410 ms (CastingTime 411),
 * Soul Cut Blade SHOT event 2 = 341 ms (CastingTime 341), Blood Blade Force event 2 = 753 ms (759).
 */
const PHASE_ORDER = ['READY', 'WAIT', 'SHOT']
const phaseRank = (p: string) => {
  const i = PHASE_ORDER.indexOf(p)
  return i >= 0 ? i : PHASE_ORDER.length
}

export function skillHitCues(skilleffect: readonly string[][]): Map<string, SkillHitCue[]> {
  const out = new Map<string, SkillHitCue[]>()
  let section = ''
  for (const c of skilleffect) {
    if (c[0] === '#section') {
      section = c[1] ?? ''
      continue
    }
    if (section !== 'skilleffectset') continue
    const group = (c[1] ?? '').trim()
    if (!group || (c[4] ?? '').trim().toUpperCase() !== 'TRUE') continue
    const cue: SkillHitCue = { phase: (c[2] ?? '').trim(), event: Number(c[3]) || 0 }
    const act = (c[13] ?? '').trim()
    if (act.startsWith('AT_MOV')) {
      const [move = '', delay = '0', speed = '0'] = (c[14] ?? '').trim().split(',')
      cue.projectile = { move, delayMs: Number(delay) || 0, speed: Number(speed) || 0 }
    }
    let list = out.get(group)
    if (!list) out.set(group, (list = []))
    list.push(cue)
  }
  for (const list of out.values()) list.sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || a.phase.localeCompare(b.phase) || a.event - b.event)
  return out
}

/** skillaniset2 AniGroup (col 6): which BSR aniGroup the clips come from (SWORD, SPEAR, BOW or DEFAULT). */
export function skillAniGroups(skilleffect: readonly string[][]): Map<string, string> {
  const out = new Map<string, string>()
  let section = ''
  for (const c of skilleffect) {
    if (c[0] === '#section') {
      section = c[1] ?? ''
      continue
    }
    const g = (c[6] ?? '').trim()
    if (section === 'skillaniset2' && c[2] && !out.has(c[2]) && g && g !== 'none') out.set(c[2], g)
  }
  return out
}

/**
 * 'att' record: [kind, percent, flat min, flat max, percent2]. Kinds 5 (melee) and 6 (ranged) are physical,
 * 8 (imbue) and 10 (force) magical; `percent` is the share of the attacker's attack power. 'mc' [2, N] = N hits.
 */
export function skillDamage(params: readonly SkillParam[]): SkillDamage | undefined {
  const att = params.find(p => p.tag === 'att')
  if (!att || att.args.length < 4) return undefined
  const [kind, pct, min, max] = att.args as [number, number, number, number]
  const magical = kind === 8 || kind === 10
  const mc = params.find(p => p.tag === 'mc')
  const hits = mc && mc.args.length >= 2 ? mc.args[1]! : 1
  return { physPct: magical ? 0 : pct, magPct: magical ? pct : 0, flat: [min, max], hits }
}

/**
 * skilleffect.txt skillaniset2 rows: Basic_Group (col 2) -> READY/WAIT/SHOT animation slots (cols 7-9), with the
 * ANI_ prefix dropped (ANI_SKILL_1 -> SKILL_1, the converter's clip names). A slot may list alternatives
 * separated by commas (basic attacks: 'ATTACK1,ATTACK2,ATTACK3,ATTACK4').
 */
export function skillAnimations(skilleffect: readonly string[][]): Map<string, { ready?: string; wait?: string; shot?: string }> {
  const out = new Map<string, { ready?: string; wait?: string; shot?: string }>()
  let section = ''
  for (const c of skilleffect) {
    if (c[0] === '#section') {
      section = c[1] ?? ''
      continue
    }
    if (section !== 'skillaniset2' || !c[2] || out.has(c[2])) continue
    const clip = (v: string | undefined) =>
      v && v !== 'none' ? v.split(',').map(s => s.trim().replace(/^ANI_/, '')).filter(Boolean).join(',') || undefined : undefined
    const a: { ready?: string; wait?: string; shot?: string } = {}
    const ready = clip(c[7])
    const wait = clip(c[8])
    const shot = clip(c[9])
    if (ready) a.ready = ready
    if (wait) a.wait = wait
    if (shot) a.shot = shot
    out.set(c[2], a)
  }
  return out
}

export const targetsEnemy = (t: SkillTargets) => t.groups.includes('enemy_mob') || t.groups.includes('enemy_player')

/**
 * Additive skills.json fields (docs/SKILLS.md §3). Every key is optional in the output; absent = the default in
 * parentheses.
 */
export interface SkillExtras {
  kind: SkillKind
  /** English tooltip text (UI_SkillToolTip_Desc col 64). */
  description?: string
  /** Basic_Activity 1 (col 8): used instantly, without an action (imbues, Grass Walk). (false) */
  instant?: true
  targets: SkillTargets
  ui?: SkillUi
  /** skillaniset2 AniGroup (col 6): SWORD / SPEAR / BOW / DEFAULT. */
  aniGroup?: string
  /** Damage moments (skilleffectset DMG Event rows), in play order. */
  hitCues?: SkillHitCue[]
  /** 'dura' (ms): how long the buff / imbue window lasts. */
  durationMs?: number
  area?: SkillArea
  statuses?: SkillStatus[]
  heal?: { hp: number; hpPct: number; mp: number; mpPct: number }
  /** 'onff' [interval ms, MP]: a toggle that drains MP every interval while on (Crystal Wall). */
  toggle?: { intervalMs: number; mp: number }
  /** 'reqi' [TypeID3, TypeID4]: item that must be equipped (4/1 Chinese shield, 6/6 bow). */
  requiresItem?: { typeId3: number; typeId4: number }
  /** 'reqc' [state]: target state required (1 = knocked down, for Flower Bloom Blade). */
  requiresTargetState?: number
  /** 'cnsm' [TypeID3, TypeID4, count]: ammunition consumed per use (bow skills: 1 arrow). */
  consumes?: { typeId3: number; typeId4: number; count: number }
  /** Consume_HPRatio / Consume_MPRatio (cols 54, 55), percent. */
  hpPct?: number
  mpPct?: number
  /** ReqCommon_Str / Int (cols 38, 39). */
  reqStr?: number
  reqInt?: number
  /** Action_Overlap (col 18) raw: low byte = buff stacking class (all imbues 1), high byte set on attack skills. */
  overlap?: number
  /** Action_AutoAttackType (col 19): 1 on attack skills (basic attack resumes after), 2 on some ranged/buff rows. */
  autoAttack?: number
  /** Chain segments: the first segment's code and this segment's 1-based position. */
  chainRoot?: string
  chainIndex?: number
}

export function skillExtras(r: SkillDataRow, d: SkillDetail, ctx: { strings: ReadonlyMap<string, string>; cues?: SkillHitCue[]; aniGroup?: string }): SkillExtras {
  const targets = skillTargets(r.cells)
  const x: SkillExtras = { kind: skillKind(d, targets), targets }
  const description = textOf(ctx.strings, d.descStrId)
  if (description) x.description = description
  if (d.activity === 1) x.instant = true
  const ui = skillUi(r.cells)
  if (ui) x.ui = ui
  if (ctx.aniGroup) x.aniGroup = ctx.aniGroup
  if (ctx.cues?.length) x.hitCues = ctx.cues
  const arg = (tag: string) => d.params.find(p => p.tag === tag)?.args
  const dura = arg('dura')
  if (dura?.length) x.durationMs = dura[0]!
  const area = skillArea(d.params)
  if (area) x.area = area
  const statuses = skillStatuses(d.params)
  if (statuses.length) x.statuses = statuses
  const heal = skillHeal(d.params)
  if (heal) x.heal = heal
  const onff = arg('onff')
  if (onff && onff.length >= 2) x.toggle = { intervalMs: onff[0]!, mp: onff[1]! }
  const reqi = arg('reqi')
  if (reqi && reqi.length >= 2) x.requiresItem = { typeId3: reqi[0]!, typeId4: reqi[1]! }
  const reqc = arg('reqc')
  if (reqc?.length) x.requiresTargetState = reqc[0]!
  const cnsm = arg('cnsm')
  if (cnsm && cnsm.length >= 3) x.consumes = { typeId3: cnsm[0]!, typeId4: cnsm[1]!, count: cnsm[2]! }
  const set = (key: 'hpPct' | 'mpPct' | 'reqStr' | 'reqInt' | 'overlap' | 'autoAttack', col: number) => {
    const v = cellNum(r.cells, col)
    if (v) x[key] = v
  }
  set('hpPct', 54)
  set('mpPct', 55)
  set('reqStr', 38)
  set('reqInt', 39)
  set('overlap', 18)
  set('autoAttack', 19)
  return x
}

/**
 * Sets chainRoot / chainIndex on every segment reachable from a chain head (a skill nobody chains into). The
 * segments share one Basic_Group, so skilleffect lists the damage cues of the whole clip on each of them; segment
 * i keeps cue i (the last segment keeps the rest when the clip has more cues than segments). Research report §5.5:
 * Blood Chain's segment i lands on hit event i and the clip plays once.
 */
export function linkChains(skills: ReadonlyArray<SkillDef & Record<string, unknown>>): void {
  const byCode = new Map(skills.map(s => [s.code, s]))
  const targets = new Set(skills.map(s => s.chainNext).filter((c): c is string => !!c))
  for (const head of skills) {
    if (!head.chainNext || targets.has(head.code)) continue
    const segments: Array<SkillDef & Record<string, unknown>> = []
    for (let cur: (SkillDef & Record<string, unknown>) | undefined = head; cur && segments.length < 16; cur = cur.chainNext ? byCode.get(cur.chainNext) : undefined) {
      segments.push(cur)
    }
    segments.forEach((s, i) => {
      s.chainRoot = head.code
      s.chainIndex = i + 1
      const cues = s.hitCues as SkillHitCue[] | undefined
      if (cues && cues.length > 1 && i < cues.length) s.hitCues = i === segments.length - 1 ? cues.slice(i) : [cues[i]!]
    })
  }
}

export interface MasteryExtras {
  tab: 'weapon' | 'force'
  /** Page inside the tab (the skills' UI_SkillPage, col 58): Bicheon 0 .. Pacheon 2, Cold 0 .. Force 3. */
  page?: number
  /** Skill lines on the page (GroupNum). */
  lines: number
  tabName?: string
  icon?: string
  iconFocus?: string
}

/**
 * Additive masteries.json fields from skillmasterydata: col 3 GroupNum (skill lines on the page), col 5 tab
 * caption key, col 6 Type (0 weapon, 1 force tab), col 7 SkillToolTipType (0 weapon, 1 force, 2 Force/heal
 * "skills that do not scale with the level"), cols 11/12 mastery icon and its focus variant.
 */
export function masteryExtras(row: readonly string[], strings: ReadonlyMap<string, string>, hasIcon: (assoc: string) => boolean,
  icons: Set<string>): MasteryExtras {
  const out: MasteryExtras = { tab: cellNum(row, 6) === 1 ? 'force' : 'weapon', lines: cellNum(row, 3) }
  const tabName = textOf(strings, row[5]?.trim())
  if (tabName) out.tabName = tabName
  for (const [key, col] of [['icon', 11], ['iconFocus', 12]] as const) {
    // skillmasterydata paths start at Media's root (icon\skillmastery\...); skilldata's are relative to icon\.
    const assoc = (row[col] ?? '').trim().replace(/^icon[\\/]/i, '')
    if (!assoc || assoc === 'xxx') continue
    icons.add(assoc)
    const url = hasIcon(assoc) ? iconUrl(assoc) : null
    if (url) out[key] = url
  }
  return out
}

export interface SkillsResult {
  skills: SkillDef[]
  masteries: MasteryDef[]
  /** Weapon TypeID4 -> basic-attack skill code. */
  basicAttacks: Map<number, string>
  /** Media.pk2 icon paths (relative to icon/) the skills and masteries use, for the icon export. */
  icons: string[]
}

export function buildSkills(
  rows: readonly SkillDataRow[],
  tables: { skillmasterydata: readonly string[][]; skilleffect: readonly string[][] },
  strings: ReadonlyMap<string, string>,
  maxMasteryLevel = MAX_SKILL_MASTERY_LEVEL,
  hasIcon: (assocIcon: string) => boolean = () => true,
): SkillsResult {
  const masteryById = new Map(CH_MASTERIES.map(m => [m.id, m.code]))
  const byId = new Map<number, SkillDataRow>()
  const groupName = new Map<number, string>()
  for (const r of rows) {
    if (r.service && !byId.has(r.id)) byId.set(r.id, r)
    if (!groupName.has(r.groupId)) groupName.set(r.groupId, r.group)
  }
  const anims = skillAnimations(tables.skilleffect)
  const cues = skillHitCues(tables.skilleffect)
  const aniGroups = skillAniGroups(tables.skilleffect)
  const extras = (r: SkillDataRow, d: SkillDetail) => skillExtras(r, d, { strings, cues: cues.get(r.group), aniGroup: aniGroups.get(r.group) })
  const skills: SkillDef[] = []
  const basicAttacks = new Map<number, string>()
  const selected: Array<{ r: SkillDataRow; d: SkillDetail }> = []
  for (const r of byId.values()) {
    if (!/^SKILL_CH_/.test(r.code)) continue
    const d = skillDetail(r)
    if (!masteryById.has(d.masteries[0]) || d.masteryLevels[0] > maxMasteryLevel) continue
    selected.push({ r, d })
  }
  const chainCode = (id: number) => (id ? byId.get(id)?.code : undefined)
  for (const { r, d } of selected) {
    const basic = /_BASE_01$/.test(r.code)
    const def: SkillDef & Record<string, unknown> = {
      code: r.code,
      id: r.id,
      name: textOf(strings, d.nameStrId),
      mastery: masteryById.get(d.masteries[0]) ?? null,
      masteryLevel: d.masteryLevels[0],
      skillLevel: r.level,
      sp: d.sp,
      mp: d.mpCost,
      category: skillCategory(d, { targetsEnemy: targetsEnemy(skillTargets(r.cells)) }),
      castMs: d.castingMs,
      actionMs: d.actionMs,
      cooldownMs: d.reuseMs,
      range: Math.round(d.range) / 10,
      weapons: d.weapons.map(w => WEAPON_BY_TID4[w]).filter((w): w is WeaponType => !!w),
      icon: d.icon && hasIcon(d.icon) ? iconUrl(d.icon) : null,
    }
    def.group = r.group
    const next = chainCode(d.chainId)
    if (next) def.chainNext = next
    const anim = anims.get(r.group)
    if (anim && Object.keys(anim).length) def.animation = anim
    const dmg = skillDamage(d.params)
    if (dmg) def.damage = dmg
    if (basic) {
      def.basicAttack = true
      for (const w of d.weapons) if (!basicAttacks.has(w)) basicAttacks.set(w, r.code)
    }
    if (d.preparingMs) def.preparingMs = d.preparingMs
    if (d.hpCost) def.hp = d.hpCost
    if (d.reqSkills.length) {
      def.requires = d.reqSkills.map(q => ({ group: groupName.get(q.group) ?? String(q.group), level: q.level }))
    }
    Object.assign(def, extras(r, d))
    def.params = d.params
    skills.push(def)
  }
  skills.sort((a, b) => (a.masteryLevel - b.masteryLevel) || (a.id - b.id))
  linkChains(skills as Array<SkillDef & Record<string, unknown>>)
  // Punch (no weapon): SKILL_PUNCH_01 is the shared unarmed basic attack.
  const punch = [...byId.values()].find(r => r.code === 'SKILL_PUNCH_01')
  if (punch) {
    const d = skillDetail(punch)
    const def: SkillDef = {
      code: punch.code,
      id: punch.id,
      name: null,
      mastery: null,
      masteryLevel: 0,
      skillLevel: punch.level,
      sp: 0,
      mp: 0,
      category: 'melee',
      castMs: d.castingMs,
      actionMs: d.actionMs,
      cooldownMs: d.reuseMs,
      range: Math.round(d.range) / 10,
      weapons: [],
      basicAttack: true,
      icon: null,
    }
    const dmg = skillDamage(d.params)
    if (dmg) def.damage = dmg
    const anim = anims.get(punch.group)
    if (anim && Object.keys(anim).length) def.animation = anim
    Object.assign(def, extras(punch, d))
    skills.unshift(def)
  }

  const masteries: MasteryDef[] = []
  const icons = new Set<string>()
  for (const s of selected) if (s.d.icon) icons.add(s.d.icon)
  for (const m of CH_MASTERIES) {
    const row = tables.skillmasterydata.find(c => Number(c[0]) === m.id)
    const weapons = row ? [row[8], row[9], row[10]].map(Number).map(w => WEAPON_BY_TID4[w]).filter((w): w is WeaponType => !!w) : []
    const def: MasteryDef & Record<string, unknown> = {
      code: m.code,
      id: m.id,
      name: textOf(strings, row?.[2]),
      race: 'china',
      weapons,
      skills: skills.filter(s => s.mastery === m.code).map(s => s.code),
    }
    if (row) Object.assign(def, masteryExtras(row, strings, hasIcon, icons))
    const page = (skills as Array<SkillDef & { ui?: SkillUi }>).find(s => s.mastery === m.code && s.ui)?.ui?.page
    if (page !== undefined) def.page = page
    masteries.push(def)
  }
  return { skills, masteries, basicAttacks, icons: [...icons].sort() }
}

/**
 * Monster skill rows for skills.json (docs/SYSTEMS_COMBAT.md §2.4, WAVE_PLAN2 D6): every MSKILL_* row a mob in
 * mobs.json lists (MobDef.skills), in the SkillDef shape with mastery null, no skill-window placement, `mob: true`,
 * `aiChance` (AI_AttackChance col 66: the pick weight on attack rows, the HP-% band on SUMMON rows) and `summon`
 * (the 'ssou' records [refObjId, rarity, min, max] x n, refObjId resolved to a characterdata code). The cooldown is
 * max(ReuseDelay col 14, CoolTime col 15), as mobAttack. A row whose 'att' is 0 % and flat 0-0 (Water Ghost poison
 * gas) carries no `damage` and is a 'debuff' (the engine then sends one empty hit carrying the statuses, §2.3).
 */
export function buildMobSkills(
  rows: readonly SkillDataRow[],
  mobs: ReadonlyArray<{ code: string; skills?: readonly string[] }>,
  tables: { skilleffect: readonly string[][] },
  strings: ReadonlyMap<string, string>,
  codeById: (id: number) => string | undefined,
): { skills: SkillDef[]; warnings: string[] } {
  const byCode = new Map<string, SkillDataRow>()
  for (const r of rows) if (r.service && !byCode.has(r.code)) byCode.set(r.code, r)
  const anims = skillAnimations(tables.skilleffect)
  const cues = skillHitCues(tables.skilleffect)
  const aniGroups = skillAniGroups(tables.skilleffect)
  const warnings: string[] = []
  const done = new Set<string>()
  const out: SkillDef[] = []
  for (const mob of mobs) {
    for (const code of mob.skills ?? []) {
      if (done.has(code)) continue
      done.add(code)
      const r = byCode.get(code)
      if (!r) {
        warnings.push(`mob skills: ${mob.code} lists ${code}, which has no skilldata row`)
        continue
      }
      const d = skillDetail(r)
      const hasAtt = d.params.some(p => p.tag === 'att')
      // Monster rows have Basic_Group 'xxx': skilleffect keys them (and the fx index v2 its MSKILL groups) by code.
      const group = r.group && r.group !== 'xxx' ? r.group : r.code
      const range = Math.round(d.range) / 10
      const def: SkillDef & Record<string, unknown> = {
        code: r.code,
        id: r.id,
        name: textOf(strings, d.nameStrId),
        mastery: null,
        masteryLevel: 0,
        skillLevel: r.level,
        sp: 0,
        mp: d.mpCost,
        // Param1 (col 68) 1 = ranged (bows, force bolts); a reach of 3 m or more is ranged too (Tiger Girl's 15 m
        // curse has Param1 0); the other attack rows are melee (§2.3 release slack: melee < 3 m).
        category: hasAtt ? (d.category === 1 || range >= 3 ? 'ranged' : 'melee') : skillCategory(d),
        castMs: d.castingMs,
        actionMs: d.actionMs,
        cooldownMs: Math.max(d.reuseMs, d.coolMs),
        range,
        weapons: [],
        icon: null,
      }
      def.group = group
      const anim = anims.get(group)
      if (anim && Object.keys(anim).length) def.animation = anim
      const dmg = skillDamage(d.params)
      const noDamage = !!dmg && dmg.physPct === 0 && dmg.magPct === 0 && dmg.flat[0] === 0 && dmg.flat[1] === 0
      if (dmg && !noDamage) def.damage = dmg
      const x = skillExtras(r, d, { strings, cues: cues.get(group), aniGroup: aniGroups.get(group) })
      delete x.ui
      delete x.description
      Object.assign(def, x)
      if (noDamage && x.statuses?.length) def.kind = 'debuff'
      def.mob = true
      def.aiChance = cellNum(r.cells, 66)
      const ssou = d.params.filter(p => p.tag === 'ssou').flatMap(p => p.args)
      if (ssou.length) {
        const summon: NonNullable<SkillDef['summon']> = []
        for (let i = 0; i + 3 < ssou.length; i += 4) {
          const [id, rarity, min, max] = ssou.slice(i, i + 4) as [number, number, number, number]
          if (!id) continue
          const mobCode = codeById(id)
          if (!mobCode) {
            warnings.push(`mob skills: ${r.code} summons characterdata id ${id}, which has no row`)
            continue
          }
          summon.push({ mob: mobCode, rarity, min, max })
        }
        if (summon.length) def.summon = summon
      }
      def.fieldSources = {
        cooldownMs: 'client skilldata max(ReuseDelay col 14, CoolTime col 15)',
        aiChance: 'client skilldata AI_AttackChance (col 66): pick weight (attack rows) or HP-% band (SUMMON rows)',
        ...(noDamage ? { damage: "dropped: 'att' 0 % and flat 0-0 (a pure debuff)" } : {}),
      }
      out.push(def)
    }
  }
  return { skills: out.sort((a, b) => a.id - b.id), warnings }
}

/** A monster's default-skill attack, for mobs.ts. */
export interface MobAttack {
  code: string
  damage?: SkillDamage
  castMs: number
  actionMs: number
  cooldownMs: number
  /** Metres beyond both body radii (col 21 x 0.1). */
  range: number
}

export function mobAttack(r: SkillDataRow): MobAttack {
  const d = skillDetail(r)
  const a: MobAttack = {
    code: r.code,
    castMs: d.castingMs,
    actionMs: d.actionMs,
    // Monster rows carry the repeat time in CoolTime (col 15) and ReuseDelay (col 14); both are 3000 on Mangnyang.
    cooldownMs: Math.max(d.reuseMs, d.coolMs),
    range: Math.round(d.range) / 10,
  }
  const dmg = skillDamage(d.params)
  if (dmg) a.damage = dmg
  return a
}
