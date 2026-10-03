/**
 * Index of the effects the Chinese masteries use: skilldata (who owns a skill) joined with skilleffect.txt
 * (which .efp each phase plays). Node-free; the caller supplies the decoded tables.
 *
 * skilleffect.txt (Media.pk2 server_dep/silkroad/textdata, UTF-16LE) is split by "#section\t<name>" lines. Columns
 * (openroad docs/formats/textdata-skilleffect.md, read as documentation; checked on 1.188 rows such as
 * SKILL_CH_COLD_GANGGI_A):
 *   skillaniset2   0 Service, 2 SkillID (= skilldata Basic_Group), 6 AniGroup, 7-9 READY/WAIT/SHOT clip slots,
 *                  13 DefenseEfp, 14 DamageEfp, 20 arrow tail .efp, 21 arrow force .efp
 *   skilleffectset 1 SkillEffectID (= Basic_Group), 2 phase (READY, WAIT, SHOT, ACT_S, ACT_L, ...), 3 StartEvent,
 *                  4 DMG Event (TRUE/FALSE), 5 DamageType ("NOR|CRI|HWAN" in one cell), 7 ID, 10 Kill,
 *                  13 ActType (AT_*), 14 MovTypeSpeed, 17 object folder, 18 object name (.efp or .bsr),
 *                  19 StartBone, 20 StartOffset, 21 TargetBone, 22 TargetOffset, 23 ObjName2 (.efp),
 *                  24 Rotate, 25 Script, 26/27 SndBegin/SndEnd (.wav)
 * Effect paths are Particles.pk2 paths (the folder column ends with a backslash).
 *
 * v2 (buildSkillIndexV2, docs/EFFECTS.md §5.1) keeps every v1 field and adds the columns v1 drops (./skilleffect.ts
 * parses every section), the MSKILL groups of the exported mobs, the SYSTEM_* pseudo-skills, the lights and the
 * characterInfo rows. `version: 2`; a v1 reader (readFxSkills: `skills[].group` + `stages`) reads it unchanged.
 */
import { fxEffectUrl, fxKey } from './compile.ts'
import { resPath, type AnisetRow, type SkillEffectFile, type StageRow } from './skilleffect.ts'

export const FX_SKILLS_FORMAT = 'sro-fx-skills'

/** Chinese player masteries (skilldata ReqCommon_Mastery1); names are the in-game ones. */
export const CHINESE_MASTERIES: ReadonlyArray<{ id: number; name: string; family: string }> = [
  { id: 257, name: 'Bicheon', family: 'SWORD' },
  { id: 258, name: 'Heuksal', family: 'SPEAR' },
  { id: 259, name: 'Pacheon', family: 'BOW' },
  { id: 273, name: 'Cold', family: 'COLD' },
  { id: 274, name: 'Lightning', family: 'LIGHTNING' },
  { id: 275, name: 'Fire', family: 'FIRE' },
  { id: 276, name: 'Force', family: 'WATER' },
]

export interface SkillEffectStage {
  phase: string
  startEvent: number
  actType: string
  move: string
  /** Object as stored (folder + name); an .efp key when it is an effect. */
  object: string
  effect: string | null
  startBone: string | null
  startOffset: string
  targetBone: string | null
  targetOffset: string
  /** ObjName2 (.efp) played at the target / arrival. */
  effect2: string | null
  rotate: string
  script: string | null
  /** DMG Event (col 4): the row shows a hit (its StartEvent is the damage cue). */
  dmg: boolean
  /** Kill (col 10): 1 = playing this row ends the phase's looping rows (the heal/buff SHOT row) [likely]. */
  kill: number
  /**
   * SndBegin/SndEnd (cols 26/27) as sound keys: the lower-case path under prim/snd without extension
   * (docs/SOUND.md keys, e.g. 'skill/csk_cold_ready'); null = none.
   */
  sound: { begin: string | null; end: string | null }
}

export interface SkillEffects {
  /** Basic_Group, e.g. SKILL_CH_COLD_GANGGI_A. */
  group: string
  mastery: number
  /** English name (level 1 row), when the string exists. */
  name: string | null
  /** Mastery level needed for the first level (the game gates by its level cap). */
  masteryLevel: number
  levels: number
  aniGroup: string | null
  clips: { ready: string | null; wait: string | null; shot: string | null }
  /** Aniset slots (effect keys). */
  defense: string | null
  damage: string | null
  arrowTail: string | null
  arrowForce: string | null
  stages: SkillEffectStage[]
}

export interface FxSkillIndex {
  format: typeof FX_SKILLS_FORMAT
  version: 1
  provenance: string
  masteries: typeof CHINESE_MASTERIES
  skills: SkillEffects[]
  /** Every effect key the skills reference, with the skills that use it and its program URL ('' = not exported). */
  effects: Record<string, { skills: string[]; url: string }>
}

export interface SkillRowLite {
  group: string
  code: string
  level: number
  mastery: number
  masteryLevel: number
  nameKey: string | null
}

const none = (v: string | undefined): string | null => {
  const t = (v ?? '').trim()
  return t === '' || t.toLowerCase() === 'none' || t === 'xxx' ? null : t
}

const efp = (v: string | null): string | null => (v && v.toLowerCase().endsWith('.efp') ? fxKey(v) : null)

/** 'skill\Csk_Cold_Binghon.wav' -> 'skill/csk_cold_binghon' (docs/SOUND.md file keys); null for none. */
export function soundKey(v: string | undefined): string | null {
  const t = none(v)
  if (!t) return null
  const k = t.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase().replace(/\.wav$/, '')
  return k || null
}

/** A skilleffectset row (cells as stored) -> the v1 stage fields. */
export function stageFromCells(c: readonly string[]): SkillEffectStage {
  const folder = none(c[17]) ?? ''
  const name = none(c[18])
  const object = name ? (folder === '*' ? name : folder + name) : ''
  return {
    phase: (c[2] ?? '').trim(),
    startEvent: Number(c[3]) || 0,
    actType: (c[13] ?? '').trim(),
    move: (c[14] ?? '').trim(),
    object,
    effect: efp(object || null),
    startBone: none(c[19]),
    startOffset: (c[20] ?? '').trim(),
    targetBone: none(c[21]),
    targetOffset: (c[22] ?? '').trim(),
    effect2: efp(none(c[23])),
    rotate: (c[24] ?? '').trim(),
    script: none(c[25]),
    dmg: (c[4] ?? '').trim().toUpperCase() === 'TRUE',
    kill: Number(c[10]) || 0,
    sound: { begin: soundKey(c[26]), end: soundKey(c[27]) },
  }
}

/** Splits skilleffect.txt into its sections' rows (tab-separated cells). */
export function skillEffectSections(text: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>()
  let current: string[][] | null = null
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.startsWith('#section')) {
      const name = line.split('\t')[1]?.trim() ?? ''
      current = []
      out.set(name, current)
      continue
    }
    if (!current || line.trim() === '' || line.trimStart().startsWith('//')) continue
    current.push(line.split('\t'))
  }
  return out
}

export function buildSkillIndex(skillRows: readonly SkillRowLite[], skillEffectText: string, strings: ReadonlyMap<string, string>,
  exported: (key: string) => boolean): FxSkillIndex {
  const masteryIds = new Set(CHINESE_MASTERIES.map(m => m.id))
  const groups = new Map<string, SkillRowLite[]>()
  for (const r of skillRows) {
    if (!r.code.startsWith('SKILL_CH_') || !masteryIds.has(r.mastery)) continue
    let g = groups.get(r.group)
    if (!g) groups.set(r.group, (g = []))
    g.push(r)
  }
  const sections = skillEffectSections(skillEffectText)
  const aniset = new Map<string, string[]>()
  for (const row of sections.get('skillaniset2') ?? []) if (row[0]?.trim() === '1' && row[2]) aniset.set(row[2].trim(), row)
  const stages = new Map<string, SkillEffectStage[]>()
  for (const c of sections.get('skilleffectset') ?? []) {
    const id = c[1]?.trim()
    if (!id || !groups.has(id)) continue
    const stage = stageFromCells(c)
    let list = stages.get(id)
    if (!list) stages.set(id, (list = []))
    list.push(stage)
  }
  const skills: SkillEffects[] = []
  const effects: FxSkillIndex['effects'] = {}
  const use = (key: string | null, group: string) => {
    if (!key) return
    const e = (effects[key] ??= { skills: [], url: exported(key) ? fxEffectUrl(key) : '' })
    if (!e.skills.includes(group)) e.skills.push(group)
  }
  for (const [group, rows] of [...groups].sort((a, b) => a[1][0]!.mastery - b[1][0]!.mastery || a[0].localeCompare(b[0]))) {
    rows.sort((a, b) => a.level - b.level)
    const first = rows[0]!
    const a = aniset.get(group)
    const s: SkillEffects = {
      group,
      mastery: first.mastery,
      name: first.nameKey ? (strings.get(first.nameKey) ?? null) : null,
      masteryLevel: first.masteryLevel,
      levels: rows.length,
      aniGroup: a ? none(a[6]) : null,
      clips: { ready: a ? none(a[7]) : null, wait: a ? none(a[8]) : null, shot: a ? none(a[9]) : null },
      defense: a ? efp(none(a[13])) : null,
      damage: a ? efp(none(a[14])) : null,
      arrowTail: a ? efp(none(a[20])) : null,
      arrowForce: a ? efp(none(a[21])) : null,
      stages: stages.get(group) ?? [],
    }
    for (const k of [s.defense, s.damage, s.arrowTail, s.arrowForce]) use(k, group)
    for (const st of s.stages) {
      use(st.effect, group)
      use(st.effect2, group)
    }
    skills.push(s)
  }
  return {
    format: FX_SKILLS_FORMAT,
    version: 1,
    provenance: 'Media.pk2 textdata skilldata_*.txt + skilleffect.txt (skillaniset2, skilleffectset); strings from textdataname.txt',
    masteries: CHINESE_MASTERIES,
    skills,
    effects,
  }
}

// ---- v2 (docs/EFFECTS.md §5.1): additive, v1 readers keep working -----------------------------------------------

export const FX_SKILLS_VERSION = 2

/** A converted model: `pnpm sro convert` output URLs under /out/ (data/game-data.ts convertedPaths). */
export interface ModelFiles {
  glb: string
  sidecar: string
}

export type FxDamageType = 'NOR' | 'CRI' | 'HWAN'

export interface SkillEffectStageV2 extends SkillEffectStage {
  /** Col 5: the hit outcomes the row plays for; null = none. */
  damageTypes: FxDamageType[] | null
  /** Col 6: MOB_BASE = scaled by the carrier's characterInfo Size; CHAR_BASE = by the character. */
  scale: 'CHAR_BASE' | 'MOB_BASE' | null
  /** Col 7: loop identity (Kill and Trade refer to it). */
  id: number
  /** Col 8 (0 on every row). */
  attach: number
  /** Col 9: 1 = this flight takes over the live loop with the same ID (the nocked arrow leaves the hand). */
  trade: number
  /** Col 11 (unknown use). */
  createCount: number
  /** Col 12: fade-in / fade-out ms of the instance; outMs -1 = keep until it ends by itself. */
  fade: { inMs: number; outMs: number }
  /** Col 15: Param[0] = arc height (dm) of MOV_UPR flights. */
  param: [number, number, number]
  /** Col 16 as stored. */
  actOption: string
  /** Rows whose object is a .bsr (arrows, the white hawk): the converted model, null when not converted. */
  objectModel?: ModelFiles | null
}

export type FxSkillKind = 'player' | 'mob' | 'system'

export interface FxTrail {
  /** Afterimage lifetime (ms, our reading of the Length column). */
  lengthMs: number
  /** A, R, G, B (0-255): multiplies the texture. */
  argb: [number, number, number, number]
  /** ONE = additive, INVSRCALPHA = alpha blend. */
  op: 'ONE' | 'INVSRCALPHA'
  /** Particles key 'textures/mirage_texture_smash.ddj' (URL: /out/fx/tex/ + key with .png), or null. */
  texture: string | null
}

export interface SkillEffectsV2 extends Omit<SkillEffects, 'stages'> {
  stages: SkillEffectStageV2[]
  /** Aniset col 3: a higher priority trail/DamageEfp replaces the basic attack's while active (imbues 2, Berserk 10). */
  priority: number
  /** Aniset col 5: weapon and shield hidden for the action. */
  hideWeapon: boolean
  /** Aniset cols 15-18; null when the length is 0. */
  trail: FxTrail | null
  /** Aniset col 22: 'LIGHT_n' (see FxSkillIndexV2.lights), or null. */
  light: string | null
  /** Aniset col 24: waist twist toward the target ('Roll', 'RollR', 'Yaw', 'Pitch' as stored), or null. */
  twist: string | null
  /** Aniset col 26: landed hits play the victim's BloodType. */
  bleeds: boolean
  kind: FxSkillKind
}

export interface FxLight {
  argb: [number, number, number, number]
  timeMs: number
  /** As stored (unit unknown, docs/EFFECTS.md §1.2). */
  range: number
  atten: number
}

export interface FxCharacterInfo {
  /** Metres. */
  size: number
  damageBone: string | null
  /** Hit point, dm in the model's own frame, as stored (glTF: x, y, -z times 0.1). */
  damagePos: [number, number, number]
  /** Effect key, e.g. 'hiteffect/hit_2_redblood.efp'. */
  bloodType: string | null
  dieModel: ModelFiles | null
  ride: ModelFiles | null
}

export interface FxSkillIndexV2 extends Omit<FxSkillIndex, 'version' | 'skills'> {
  version: typeof FX_SKILLS_VERSION
  skills: SkillEffectsV2[]
  lights: Record<string, FxLight>
  /** characterInfo by CodeName128: every CHAR_CH_*, the mobs and NPCs asked for. */
  characters: Record<string, FxCharacterInfo>
}

export interface SkillIndexV2Input {
  skillRows: readonly SkillRowLite[]
  /** SE (and SE-R's light section), parsed by ./skilleffect.ts. */
  file: SkillEffectFile
  strings: ReadonlyMap<string, string>
  /** Is this effect key exported (fx/efp/...)? */
  exported: (key: string) => boolean
  /** MSKILL codes to include (every MobDef.skills entry of mobs.json). */
  mobSkills: readonly string[]
  /** characterInfo codes to include besides every CHAR_CH_* (the MOB_* of mobs.json, the NPC_* of npcs.json). */
  characters: readonly string[]
  /** The converted model of a res/... .bsr path (lower case, forward slashes), or null. */
  model: (bsrPath: string) => ModelFiles | null
}

/** Basic attacks outside the Chinese masteries (fists). */
export const EXTRA_PLAYER_GROUPS: readonly string[] = ['SKILL_PUNCH']

const DAMAGE_TYPES: ReadonlySet<string> = new Set(['NOR', 'CRI', 'HWAN'])

function stageV2(row: StageRow, model: SkillIndexV2Input['model']): SkillEffectStageV2 {
  const st: SkillEffectStageV2 = {
    ...stageFromCells(row.cells),
    damageTypes: row.damageTypes ? (row.damageTypes.filter(t => DAMAGE_TYPES.has(t)) as FxDamageType[]) : null,
    scale: row.scale === 'CHAR_BASE' || row.scale === 'MOB_BASE' ? row.scale : null,
    id: row.id,
    attach: row.attach,
    trade: row.trade,
    createCount: row.createCount,
    fade: row.fade,
    param: row.param,
    actOption: row.actOption,
  }
  if (/\.bsr$/i.test(st.object)) st.objectModel = model(resPath(st.object) ?? st.object)
  return st
}

function trailOf(a: AnisetRow | undefined): FxTrail | null {
  if (!a || a.trailLength <= 0) return null
  return {
    lengthMs: a.trailLength,
    argb: a.trailArgb,
    op: a.trailOp.toUpperCase() === 'INVSRCALPHA' ? 'INVSRCALPHA' : 'ONE',
    texture: a.trailTexture ? fxKey(`textures/${a.trailTexture.replace(/^.*[\\/]/, '')}`) : null,
  }
}

/**
 * fx index v2: the v1 Chinese mastery groups (their v1 fields unchanged) plus the fist basic attack, the MSKILL
 * groups of the given mobs and every SYSTEM_* group, each with the aniset and stage columns v1 dropped; the lights
 * (SE-R) and the characterInfo rows of the given characters.
 */
export function buildSkillIndexV2(input: SkillIndexV2Input): FxSkillIndexV2 {
  const { skillRows, file, strings, exported, model } = input
  const masteryIds = new Set(CHINESE_MASTERIES.map(m => m.id))
  const skills: SkillEffectsV2[] = []
  const effects: FxSkillIndexV2['effects'] = {}
  const use = (key: string | null, group: string | null) => {
    if (!key) return
    const e = (effects[key] ??= { skills: [], url: exported(key) ? fxEffectUrl(key) : '' })
    if (group && !e.skills.includes(group)) e.skills.push(group)
  }
  const add = (group: string, rows: readonly SkillRowLite[], kind: FxSkillKind) => {
    const first = rows[0]
    const a = file.aniset.get(group)
    const s: SkillEffectsV2 = {
      group,
      mastery: first?.mastery ?? 0,
      name: first?.nameKey ? (strings.get(first.nameKey) ?? null) : null,
      masteryLevel: first?.masteryLevel ?? 0,
      levels: Math.max(rows.length, 1),
      aniGroup: a ? a.aniGroup : null,
      clips: { ready: a ? a.ready : null, wait: a ? a.wait : null, shot: a ? a.shot : null },
      defense: a ? efp(a.defense) : null,
      damage: a ? efp(a.damage) : null,
      arrowTail: a ? efp(a.arrowTail) : null,
      arrowForce: a ? efp(a.arrowForce) : null,
      stages: (file.stages.get(group) ?? []).map(r => stageV2(r, model)),
      priority: a?.priority ?? 0,
      hideWeapon: a?.hideWeapon ?? false,
      trail: trailOf(a),
      light: a?.light ?? null,
      twist: a?.twist ?? null,
      bleeds: a?.bleeds ?? false,
      kind,
    }
    for (const k of [s.defense, s.damage, s.arrowTail, s.arrowForce]) use(k, group)
    for (const st of s.stages) {
      use(st.effect, group)
      use(st.effect2, group)
    }
    skills.push(s)
  }

  // Players: the v1 selection and order, then the fist.
  const groups = new Map<string, SkillRowLite[]>()
  for (const r of skillRows) {
    if (!r.code.startsWith('SKILL_CH_') || !masteryIds.has(r.mastery)) continue
    let g = groups.get(r.group)
    if (!g) groups.set(r.group, (g = []))
    g.push(r)
  }
  for (const [group, rows] of [...groups].sort((a, b) => a[1][0]!.mastery - b[1][0]!.mastery || a[0].localeCompare(b[0]))) {
    add(group, rows.sort((a, b) => a.level - b.level), 'player')
  }
  for (const group of EXTRA_PLAYER_GROUPS) {
    if (!file.aniset.has(group) && !file.stages.has(group)) continue
    add(group, skillRows.filter(r => r.group === group).sort((a, b) => a.level - b.level), 'player')
  }

  // Mobs: MSKILL codes (their skilldata Basic_Group is 'xxx', so the code is the group).
  const done = new Set(skills.map(s => s.group))
  const rowsByCode = new Map(skillRows.map(r => [r.code, r]))
  const known = (g: string) => file.aniset.has(g) || file.stages.has(g)
  for (const code of [...new Set(input.mobSkills)].sort()) {
    const r = rowsByCode.get(code)
    const group = r && r.group !== 'xxx' && known(r.group) ? r.group : code
    if (done.has(group) || !known(group)) continue
    done.add(group)
    add(group, r ? [r] : [], 'mob')
  }

  // System pseudo-skills: every SYSTEM_* group.
  const system = new Set([...file.aniset.keys(), ...file.stages.keys()].filter(g => g.startsWith('SYSTEM_')))
  for (const group of [...system].sort()) if (!done.has(group)) add(group, [], 'system')

  const lights: FxSkillIndexV2['lights'] = {}
  for (const l of [...file.lights.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
    lights[l.name] = { argb: l.argb, timeMs: l.timeMs, range: l.range, atten: l.atten }
  }

  const characters: FxSkillIndexV2['characters'] = {}
  const wanted = new Set([...[...file.characterInfo.keys()].filter(c => c.startsWith('CHAR_CH_')), ...input.characters])
  for (const code of [...wanted].sort()) {
    const c = file.characterInfo.get(code)
    if (!c) continue
    const blood = c.bloodType ? fxKey(`hiteffect/${c.bloodType}.efp`) : null
    if (blood) {
      use(blood, null)
      const down = blood.replace(/\.efp$/, '_down.efp')
      if (exported(down)) use(down, null)
    }
    characters[code] = {
      size: c.size,
      damageBone: c.damageBone,
      damagePos: c.damagePos,
      bloodType: blood,
      dieModel: c.dieModel ? model(c.dieModel) : null,
      ride: c.ride ? model(c.ride) : null,
    }
  }

  return {
    format: FX_SKILLS_FORMAT,
    version: FX_SKILLS_VERSION,
    provenance:
      'Media.pk2 textdata skilldata_*.txt + skilleffect.txt (characterInfo, skillaniset2, skilleffectset; light from ' +
      'resinfo/skilleffect.txt); strings from textdataname.txt; mob skills and characters from mobs.json and npcs.json',
    masteries: CHINESE_MASTERIES,
    skills,
    effects,
    lights,
    characters,
  }
}
