/**
 * skilleffect.txt, every section and every column (docs/EFFECTS.md §1.2, §5.1). Node-free; the caller decodes the
 * files (packages/formats decodeTextdata).
 *
 * Two copies ship with 1.188 [confirmed]:
 *   SE    Media.pk2 server_dep/silkroad/textdata/skilleffect.txt (UTF-16LE): characterInfo, skillaniset2,
 *         skilleffectset. The exporter's source.
 *   SE-R  Media.pk2 resinfo/skilleffect.txt (CP949): the same sections, older and shorter, plus `#section light`
 *         (LIGHT_1..8). Only `light` is taken from it.
 *
 * Comments: a line starting with `//` is skipped; `/*` ... `*\/` blocks (SE has four: the Jupiter temple mobs and
 * skills, the fortress-war structures and the 2010 trade/job rows) are skipped whole. Rows of skilleffectset whose
 * first cell is `-` are ordinary rows (the first cell is a free-text name; `-` repeats the previous one).
 *
 * Columns (0-based):
 *   characterInfo   0 ResourceFileID (CodeName128), 1 ResourceTypeName, 2 Size (m), 3 Ride Type, 4 ride (.bsr),
 *                   5 Die Bsr, 6 Die Effect, 7 DamageBone, 8 DamagePos (dm, model-local), 9 BloodType, 10 Dead Effect,
 *                   11 environment flag, 12 ranged-target offset
 *   light (SE-R)    0 name, 1 TYPE, 2 ARGB, 3 TIME (ms), 4 RANGE, 5 Attenuation1
 *   skillaniset2    0 Service, 1 SkillName, 2 SkillID (= skilldata Basic_Group, or the MSKILL/SYSTEM code),
 *                   3 Priority, 4 AniTRUE, 5 Hide Weapon, 6 AniGroup, 7-9 AniReady/AniWait/AniShot,
 *                   10 Ani play Timing, 11 Act W, 12 Act S, 13 DefenseEfp, 14 DamageEfp, 15 trail Length (ms),
 *                   16 trail Color (A,R,G,B), 17 trail Op., 18 trail Texture, 19 start timing, 20 arrow tail .efp,
 *                   21 arrow force .efp, 22 Light Effect, 23 Skill Object, 24 waist twist (none/Roll/Yaw/Pitch),
 *                   25 is attack skill, 26 bleeds
 *   skilleffectset  0 SkillName, 1 SkillEffectID, 2 AniType (phase), 3 StartEvent, 4 DMG Event, 5 DamageType,
 *                   6 Scale, 7 ID, 8 Attach, 9 Trade, 10 Kill, 11 CreateCnt, 12 Fade, 13 ActType, 14 MovTypeSpeed,
 *                   15 Param, 16 Act Option, 17 Obj Path, 18 ObjName, 19 StartBone, 20 StartOffset, 21 TargetBone,
 *                   22 TargetOffset, 23 ObjName2, 24 Rotate, 25 Script, 26 SndBegin, 27 SndEnd
 */

/** `#section` name -> its rows (tab-separated cells), comments and blank lines removed. */
export function skilleffectSections(text: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>()
  let current: string[][] | null = null
  let block = false
  for (const line of text.split(/\r\n|\n|\r/)) {
    const t = line.trimStart()
    if (block) {
      if (line.includes('*/')) block = false
      continue
    }
    if (t.startsWith('/*')) {
      block = !t.slice(2).includes('*/')
      continue
    }
    if (line.startsWith('#section')) {
      const name = line.split('\t')[1]?.trim() ?? ''
      current = out.get(name) ?? []
      out.set(name, current)
      continue
    }
    if (!current || line.trim() === '' || t.startsWith('//')) continue
    current.push(line.split('\t'))
  }
  return out
}

/** A cell as text; null for '', 'none', 'xxx'. */
export function cell(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  return t === '' || t.toLowerCase() === 'none' || t === 'xxx' ? null : t
}

const num = (v: string | undefined, fallback = 0): number => {
  const n = Number((v ?? '').trim())
  return Number.isFinite(n) && (v ?? '').trim() !== '' ? n : fallback
}

/** "a,b,c" -> numbers (missing or bad parts = 0), padded to `n`. */
export function numbers(v: string | undefined, n: number): number[] {
  const parts = (v ?? '').split(',')
  return Array.from({ length: n }, (_, i) => num(parts[i]))
}

const bool = (v: string | undefined): boolean => {
  const t = (v ?? '').trim().toUpperCase()
  return t === 'TRUE' || t === '1'
}

/** A path cell ('res\mob\common\mangnyang_die.bsr') as a forward-slash, lower-case path; null for none. */
export function resPath(v: string | undefined): string | null {
  const t = cell(v)
  return t ? t.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase() : null
}

export interface CharacterInfoRow {
  code: string
  typeName: string | null
  size: number
  rideType: string | null
  /** Model the character sits on (Tiger Girl: res/mob/china/bluetiger.bsr). */
  ride: string | null
  /** Model swapped in at death (res/mob/common/mangnyang_die.bsr). */
  dieModel: string | null
  dieEffect: string | null
  damageBone: string | null
  /** Hit point, dm in the model's own frame (x, y, z as stored). */
  damagePos: [number, number, number]
  /** 'hit_2_redblood' (a hiteffect/ .efp name without folder or extension), or null. */
  bloodType: string | null
  deadEffect: string | null
  env: number
  rangedOffset: string | null
}

export interface LightRow {
  name: string
  type: string
  /** A, R, G, B (0-255). */
  argb: [number, number, number, number]
  timeMs: number
  range: number
  atten: number
}

export interface AnisetRow {
  service: boolean
  name: string
  group: string
  priority: number
  aniTrue: boolean
  hideWeapon: boolean
  aniGroup: string | null
  ready: string | null
  wait: string | null
  shot: string | null
  playTiming: string | null
  actW: string | null
  actS: string | null
  /** Raw effect paths as stored (folder\name.efp). */
  defense: string | null
  damage: string | null
  trailLength: number
  trailArgb: [number, number, number, number]
  trailOp: string
  trailTexture: string | null
  startTiming: string | null
  arrowTail: string | null
  arrowForce: string | null
  light: string | null
  object: string | null
  twist: string | null
  attack: boolean
  bleeds: boolean
}

export interface StageRow {
  name: string
  group: string
  phase: string
  startEvent: number
  dmg: boolean
  /** DamageType ('NOR|CRI|HWAN' in one cell) split; null for none. */
  damageTypes: string[] | null
  scale: string | null
  id: number
  attach: number
  trade: number
  kill: number
  createCount: number
  fade: { inMs: number; outMs: number }
  actType: string
  move: string
  param: [number, number, number]
  actOption: string
  folder: string | null
  objectName: string | null
  startBone: string | null
  startOffset: string
  targetBone: string | null
  targetOffset: string
  object2: string | null
  rotate: string
  script: string | null
  soundBegin: string | null
  soundEnd: string | null
  /** The row's cells as stored (the v1 builder reads these). */
  cells: string[]
}

export interface SkillEffectFile {
  characterInfo: Map<string, CharacterInfoRow>
  /** Service = 1 rows only, by SkillID. */
  aniset: Map<string, AnisetRow>
  /** By SkillEffectID, in file order. */
  stages: Map<string, StageRow[]>
  lights: Map<string, LightRow>
}

export function characterInfoRow(c: string[]): CharacterInfoRow | null {
  const code = cell(c[0])
  if (!code) return null
  const pos = numbers(c[8], 3)
  return {
    code,
    typeName: cell(c[1]),
    size: num(c[2]),
    rideType: cell(c[3]),
    ride: resPath(c[4]),
    dieModel: resPath(c[5]),
    dieEffect: cell(c[6]),
    damageBone: cell(c[7]),
    damagePos: [pos[0]!, pos[1]!, pos[2]!],
    bloodType: cell(c[9]),
    deadEffect: cell(c[10]),
    env: num(c[11]),
    rangedOffset: cell(c[12]),
  }
}

export function lightRow(c: string[]): LightRow | null {
  const name = cell(c[0])
  if (!name) return null
  const a = numbers(c[2], 4)
  return { name, type: (c[1] ?? '').trim(), argb: [a[0]!, a[1]!, a[2]!, a[3]!], timeMs: num(c[3]), range: num(c[4]), atten: num(c[5]) }
}

export function anisetRow(c: string[]): AnisetRow | null {
  const group = cell(c[2])
  if (!group) return null
  const argb = numbers(c[16], 4)
  return {
    service: (c[0] ?? '').trim() === '1',
    name: (c[1] ?? '').trim(),
    group,
    priority: num(c[3]),
    aniTrue: bool(c[4]),
    hideWeapon: num(c[5]) === 1,
    aniGroup: cell(c[6]),
    ready: cell(c[7]),
    wait: cell(c[8]),
    shot: cell(c[9]),
    playTiming: cell(c[10]),
    actW: cell(c[11]),
    actS: cell(c[12]),
    defense: cell(c[13]),
    damage: cell(c[14]),
    trailLength: num(c[15]),
    trailArgb: [argb[0]!, argb[1]!, argb[2]!, argb[3]!],
    trailOp: (c[17] ?? '').trim(),
    trailTexture: cell(c[18]),
    startTiming: cell(c[19]),
    arrowTail: cell(c[20]),
    arrowForce: cell(c[21]),
    light: cell(c[22]),
    object: cell(c[23]),
    twist: cell(c[24]),
    attack: num(c[25]) === 1,
    bleeds: num(c[26]) === 1,
  }
}

/** "0,-1" -> { inMs: 0, outMs: -1 } (-1: keep until the instance ends by itself). */
export function parseFade(v: string | undefined): { inMs: number; outMs: number } {
  const [a, b] = numbers(v, 2)
  return { inMs: a!, outMs: b! }
}

export function stageRow(c: string[]): StageRow | null {
  const group = cell(c[1])
  if (!group) return null
  const types = cell(c[5])
  const param = numbers(c[15], 3)
  return {
    name: (c[0] ?? '').trim(),
    group,
    phase: (c[2] ?? '').trim(),
    startEvent: num(c[3]),
    dmg: (c[4] ?? '').trim().toUpperCase() === 'TRUE',
    damageTypes: types ? types.split('|').map(s => s.trim()).filter(Boolean) : null,
    scale: cell(c[6]),
    id: num(c[7]),
    attach: num(c[8]),
    trade: num(c[9]),
    kill: num(c[10]),
    createCount: num(c[11]),
    fade: parseFade(c[12]),
    actType: (c[13] ?? '').trim(),
    move: (c[14] ?? '').trim(),
    param: [param[0]!, param[1]!, param[2]!],
    actOption: (c[16] ?? '').trim(),
    folder: cell(c[17]),
    objectName: cell(c[18]),
    startBone: cell(c[19]),
    startOffset: (c[20] ?? '').trim(),
    targetBone: cell(c[21]),
    targetOffset: (c[22] ?? '').trim(),
    object2: cell(c[23]),
    rotate: (c[24] ?? '').trim(),
    script: cell(c[25]),
    soundBegin: cell(c[26]),
    soundEnd: cell(c[27]),
    cells: c,
  }
}

/**
 * Parses SE (and the `light` section of SE-R when given). A duplicated aniset SkillID keeps its last row (as the v1
 * exporter did); a duplicated characterInfo code or light name keeps its first row. None of the rows the game
 * uses is duplicated [confirmed on 1.188].
 */
export function parseSkillEffect(text: string, resinfoText?: string | null): SkillEffectFile {
  const sections = skilleffectSections(text)
  const characterInfo = new Map<string, CharacterInfoRow>()
  for (const c of sections.get('characterInfo') ?? []) {
    const r = characterInfoRow(c)
    if (r && !characterInfo.has(r.code)) characterInfo.set(r.code, r)
  }
  const aniset = new Map<string, AnisetRow>()
  for (const c of sections.get('skillaniset2') ?? []) {
    const r = anisetRow(c)
    if (r?.service) aniset.set(r.group, r)
  }
  const stages = new Map<string, StageRow[]>()
  for (const c of sections.get('skilleffectset') ?? []) {
    const r = stageRow(c)
    if (!r) continue
    let list = stages.get(r.group)
    if (!list) stages.set(r.group, (list = []))
    list.push(r)
  }
  const lights = new Map<string, LightRow>()
  const lightRows = [...(sections.get('light') ?? []), ...(resinfoText ? (skilleffectSections(resinfoText).get('light') ?? []) : [])]
  for (const c of lightRows) {
    const r = lightRow(c)
    if (r && !lights.has(r.name)) lights.set(r.name, r)
  }
  return { characterInfo, aniset, stages, lights }
}
