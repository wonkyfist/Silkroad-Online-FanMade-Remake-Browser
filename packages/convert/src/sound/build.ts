/**
 * Assembles the SoundIndex (docs/SOUND.md §4.3) from the parsed sources: effectsound rows, effectenvsnd areas,
 * regioninfo areas, skilleffect stage sounds and the per-model clip tracks. `planSoundIndex` decides every cue and
 * which files are needed; the CLI (tools/export-sound.ts) encodes them and `finishSoundIndex` adds `files` and the
 * report. Node-free.
 */
import type { BsrResource } from '@sro/formats'
import {
  OBJECT_FLOOR_SURFACE,
  SOUND_INDEX_FORMAT,
  STEP_SUFFIX,
  mobSoundObject,
  playerVoiceObject,
  type AmbientLayer,
  type AreaSound,
  type HitSet,
  type MobSounds,
  type ModelSounds,
  type SkillSounds,
  type SoundCategory,
  type SoundCodec,
  type SoundCue,
  type SoundFile,
  type SoundIndex,
  type SoundSurface,
  type VoiceSet,
} from '../../../shared/src/sound.ts'
import { skillEffectSections } from '../fx/skills.ts'
import { EffectSoundTable, parseHitRow, rowGain, type EffectSoundRow } from './effectsound.ts'
import type { EnvArea } from './envsnd.ts'
import type { RegionArea } from './regioninfo.ts'
import type { SoundResolver } from './resolve.ts'
import { bsrSoundPaths, modelTracks, trackCount, type SidecarClip } from './tracks.ts'

export type SoundScope = 'jangan' | 'all'

/** Area names (regioninfo / effectenvsnd, matched exactly) in the Jangan scope. */
export const JANGAN_AREAS = ['장안', '장안필드']
/** PLAYER SND_DMG event1 weapon kinds in the Jangan scope (Chinese weapons + unarmed). */
export const JANGAN_HIT_WEAPONS = ['SWORD', 'BLADE', 'SPEAR', 'BOW', 'PUNCH']
/** Swing rows replace the clip track's file for the same handle (docs/SOUND.md §2.7 example 10); one-line A/B. */
export const SKILL_ROWS_OVERRIDE_CLIP = true

/**
 * The retail UI rows cross the durability sounds: SND_EQBREAK ("아이템 부서지는 소리", the item breaking) names
 * ui/Itemdanger.wav and SND_EQDANGER ("아이템 부서지기 경고음", the about-to-break warning) names ui/itembreak.wav.
 * The files match their own names (measured: itembreak is an 800 ms crash with ringing 3.4 kHz / 560 Hz partials and a
 * bouncing decay; itemdanger a 400 ms low 86-172 Hz buzz held at constant level for 140 ms), so the cues follow the
 * files' content: ui.eqbreak = the crash, ui.eqdanger = the buzz (docs/SYSTEMS_COMBAT.md §3.1, WAVE_PLAN2 §6.3).
 * One-line A/B: false keeps the retail table's crossing.
 */
export const EQ_SOUNDS_BY_CONTENT = true

/** Swaps the files of ui.eqbreak and ui.eqdanger when both are the retail table's crossed pair. */
export function swapEqSounds(cues: Record<string, SoundCue>): void {
  const br = cues['ui.eqbreak']
  const dg = cues['ui.eqdanger']
  if (!br || !dg || !br.files.every(f => /itemdanger$/.test(f)) || !dg.files.every(f => /itembreak$/.test(f))) return
  cues['ui.eqbreak'] = { ...br, files: dg.files }
  cues['ui.eqdanger'] = { ...dg, files: br.files }
}

/** Berserk cues (docs/SYSTEMS_COMBAT.md §5.1): Data.pk2 prim/snd/player/hwanchange.wav and hwanreturn.wav. */
export const BERSERK_CUES: ReadonlyArray<readonly [string, string]> = [
  ['berserk.start', 'player\\hwanchange.wav'],
  ['berserk.end', 'player\\hwanreturn.wav'],
]

/**
 * Wave 11 (docs/WAVE_PLAN7.md D12, lane W11-CV; the one writer of this list). Retail files no effectsound row names,
 * as cues of the sound index; `addUniqueAndTownSounds` adds them to every export scope. A file without a source ends
 * in report.notExported and `finishSoundIndex` drops a cue left without a file.
 *
 * The unique notices (docs/UNIQUES.md §3.3): `ui.uniqueAppear` = the retail alarm (4.9 s), `ui.uniqueDown` = the
 * event-complete sting (3.1 s). No retail table names either file for this use; the user judges them by ear.
 */
export const UNIQUE_CUES: ReadonlyArray<readonly [string, string]> = [
  ['ui.uniqueAppear', 'ui/alarm_sound.wav'],
  ['ui.uniqueDown', 'ui/eventcomplete.wav'],
]

/**
 * The town's retail sounds (docs/TOWN_LIFE.md §6; TL-S plays them, its synthesized loops are its own files): the
 * temple bell on the game hour, and the townsfolk's animals: tied and led horses, the cat, the dog (the pet wolf's
 * voice, pitched up by the player), donkeys and cows. Several files per cue = variants picked at random.
 */
export const TOWN_CUES: ReadonlyArray<readonly [string, SoundCategory, readonly string[]]> = [
  ['town.bell', 'ambient', ['env/bell towel 3.wav']],
  ['town.horse.snort', 'sfx', ['cos/cos_horse_stand.wav', 'cos/cos_horse_moan1.wav', 'cos/cos_horse_moan2.wav']],
  ['town.horse.step', 'sfx', ['cos/cos_horse_run.wav']],
  ['town.cat', 'sfx', ['cos/cos_cat_stand1.wav']],
  ['town.dog', 'sfx', ['cos/cos_wolf_01_stand1.wav', 'cos/cos_wolf_01_moan1.wav', 'cos/cos_wolf_01_moan2.wav', 'cos/cos_wolf_01_shout.wav']],
  ['town.donkey', 'sfx', ['cos/cos_donkey_stand.wav', 'cos/cos_donkey_moan1.wav', 'cos/cos_donkey_moan2.wav']],
  ['town.cow', 'sfx', ['cos/cos_cow_stand.wav', 'cos/cos_cow_moan1.wav', 'cos/cos_cow_moan2.wav']],
  ['town.cow.walk', 'sfx', ['cos/cos_cow_walk.wav']],
]

/** Every retail file of UNIQUE_CUES and TOWN_CUES, as stored (relative to prim/snd). */
export const WAVE11_SOUND_FILES: readonly string[] = [...UNIQUE_CUES.map(([, f]) => f), ...TOWN_CUES.flatMap(([, , fs]) => fs)]

/**
 * Adds the unique-notice and town cues (and their files) to an export plan, in every scope. A file the resolver does
 * not know is recorded as unresolved and left out; a cue with no file left is not written. Returns the cue keys added.
 */
export function addUniqueAndTownSounds(plan: { files: Set<string>; ambient: Set<string>; index: { cues: Record<string, SoundCue> } }, resolver: SoundResolver): string[] {
  const added: string[] = []
  const put = (key: string, category: SoundCategory, raw: readonly string[]) => {
    const ids = [...new Set(raw.map(f => resolver.resolve(f, `wave 11 cue ${key}`)).filter((id): id is string => id !== null))]
    if (!ids.length) return
    for (const id of ids) {
      plan.files.add(id)
      if (category === 'ambient') plan.ambient.add(id)
    }
    plan.index.cues[key] = { files: ids, gain: 1, category }
    added.push(key)
  }
  for (const [key, file] of UNIQUE_CUES) put(key, 'ui', [file])
  for (const [key, category, files] of TOWN_CUES) put(key, category, files)
  return added
}

export interface ModelInput {
  code: string
  kind: 'player' | 'mob' | 'npc'
  bsr: string
  res: BsrResource | null
  clips: readonly SidecarClip[]
}

export interface SoundInputs {
  scope: SoundScope
  rows: readonly EffectSoundRow[]
  envAreas: readonly EnvArea[]
  regionAreas: readonly RegionArea[]
  /** skilleffect.txt, decoded. */
  skillEffectText: string
  resolver: SoundResolver
  models: readonly ModelInput[]
  /** Player codes (CHAR_CH_*), mob codes with their skill codes. */
  players: readonly string[]
  mobs: ReadonlyArray<{ code: string; skills: readonly string[] }>
  /** Skill groups in scope (skills.json `group`), e.g. SKILL_CH_SWORD_SMASH_A, SKILL_CH_SWORD_BASE. */
  skillGroups: readonly string[]
  /** ui/index.json `music` keys ('jangan_town'). */
  musicKeys: readonly string[]
}

export interface SoundPlan {
  index: Omit<SoundIndex, 'files' | 'report' | 'generatedAt' | 'codec' | 'wavFallback'>
  models: ModelSounds[]
  /** Every file id the index and the model files reference. */
  files: Set<string>
  tracks: number
  /** Ids referenced by ambient layers (encoded at the ambience bitrate, stereo kept). */
  ambient: Set<string>
}

/** Footstep surface from an effectsound description (the event2 column has copy-paste errors; §2.4). */
const SURFACE_WORDS: Array<[string, SoundSurface]> = [
  ['높은풀숲', 'LongGrass'],
  ['우거진풀숲', 'Forest'],
  ['풀숲', 'Grass'],
  ['흙바닥', 'Dirt'],
  ['모래', 'Sand'],
  ['화산재', 'Ashfield'],
  ['딱딱한바닥', 'Stone'],
  ['자갈', 'Metal'],
  ['나무', 'Wood'],
  ['진흙', 'Mud'],
  ['얕은물', 'Water'],
  ['깊은물', 'DeepWater'],
  ['설원', 'Snow'],
  ['구름', 'Cloud'],
]

export function surfaceOfDescription(description: string): SoundSurface | null {
  for (const [word, s] of SURFACE_WORDS) if (description.includes(word)) return s
  return null
}

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)]

export function planSoundIndex(inp: SoundInputs): SoundPlan {
  const table = new EffectSoundTable(inp.rows)
  const { resolver } = inp
  const files = new Set<string>()
  const ambient = new Set<string>()
  const use = (id: string | null): id is string => {
    if (id) files.add(id)
    return id !== null
  }
  const resolveRows = (rows: readonly EffectSoundRow[]): string[] =>
    uniq(rows.map(r => resolver.resolve(r.file, `effectsound ${r.object} ${r.handle}${r.skill ? ' ' + r.skill : ''}`)).filter(use))

  // ---- cues ----
  const cues: Record<string, SoundCue> = {}
  const cue = (key: string, rows: readonly EffectSoundRow[], category: SoundCategory) => {
    const ids = resolveRows(rows)
    if (ids.length) cues[key] = { files: ids, gain: rowGain(rows), category }
  }
  const clicks = table.find('UI', { handle: 'SND_BUTTON_CLICK' })
  cue('ui.click', clicks.slice(0, 1), 'ui')
  cue('ui.click2', clicks.slice(1, 2), 'ui')
  cue('ui.windowOpen', table.find('UI', { handle: 'SND_WINDOW_OPEN' }), 'ui')
  cue('ui.windowClose', table.find('UI', { handle: 'SND_WINDOW_CLOSE' }), 'ui')
  cue('ui.error', table.find('UI', { handle: 'SND_ERROR' }), 'ui')
  cue('ui.warning', table.find('UI', { handle: 'SND_WARNING' }), 'ui')
  const levUp = table.find('UI', { handle: 'SND_LEVUP', event1: 'CHINESS' })
  cue('ui.levelUp', levUp.length ? levUp : table.find('UI', { handle: 'SND_LEVUP' }), 'ui')
  cue('ui.potion', table.find('UI', { handle: 'SND_POTION' }), 'ui')
  cue('ui.revive', table.find('UI', { handle: 'SND_REVIVE' }), 'ui')
  cue('ui.questOpen', table.find('UI', { handle: 'SND_QUEST' }), 'ui')
  cue('ui.questDone', table.find('UI', { handle: 'SND_QUEST_END' }), 'ui')
  cue('ui.repair', table.find('UI', { handle: 'SND_REPAIR' }), 'ui')
  cue('item.pickup', table.find('ITEM', { handle: 'SND_PICKUP' }), 'sfx')
  cue('item.dropGold', table.find('ITEM', { handle: 'SND_DROPITEM', event1: 'GOLD' }), 'sfx')
  cue('item.dropRare', table.find('ITEM', { handle: 'SND_DROPITEM', event1: 'RARE' }), 'sfx')
  for (const kind of uniq(table.find('ITEM', { handle: 'SND_EQUIP' }).map(r => r.event1).filter(Boolean))) {
    cue(`item.equip.${kind}`, table.find('ITEM', { handle: 'SND_EQUIP', event1: kind }), 'ui')
  }
  for (const kind of uniq(table.find('ITEM', { handle: 'SND_DROPITEM' }).map(r => r.event1).filter(k => k && k !== 'GOLD' && k !== 'RARE'))) {
    cue(`item.drop${kind[0]}${kind.slice(1).toLowerCase()}`, table.find('ITEM', { handle: 'SND_DROPITEM', event1: kind }), 'sfx')
  }
  // The remaining UI rows (gacha, elixir, sockets, set items, ...), keyed by handle: SND_GACHA_MOVE -> 'ui.gacha_move'.
  const named = new Set(['SND_BUTTON_CLICK', 'SND_WINDOW_OPEN', 'SND_WINDOW_CLOSE', 'SND_ERROR', 'SND_WARNING', 'SND_LEVUP', 'SND_POTION', 'SND_REVIVE', 'SND_QUEST', 'SND_QUEST_END', 'SND_REPAIR'])
  for (const handle of uniq(table.find('UI').map(r => r.handle).filter(h => !named.has(h)))) {
    cue(`ui.${handle.replace(/^SND_/, '').toLowerCase()}`, table.find('UI', { handle }), 'ui')
  }
  if (EQ_SOUNDS_BY_CONTENT) swapEqSounds(cues)
  // Wave 8 (docs/SYSTEMS_COMBAT.md §1.2): the Red Horse's effectsound rows (object COS_C_HORSE).
  const horse = (handle: string | RegExp, f: { event1?: string } = {}) => table.find('COS_C_HORSE', { handle, skill: '', ...f })
  cue('cos.horse.stand', horse('SND_STAND'), 'sfx')
  cue('cos.horse.moan', horse('VOC_MOAN', { event1: 'NORMAL' }), 'sfx')
  cue('cos.horse.moanCrit', horse('VOC_MOAN', { event1: 'CRITYCAL' }), 'sfx')
  cue('cos.horse.die', horse(/^VOC_DEATH\d*$/), 'sfx')
  cue('cos.horse.thud', horse(/^SND_DEATH\d*$/), 'sfx')
  cue('cos.horse.run', horse(/^SND_RUN\d*$/), 'sfx')
  // Wave 8 (§5.1): Berserk start / end. No effectsound row names them; skilleffect SYSTEM_CH_HWANMODE plays them.
  for (const [key, file] of BERSERK_CUES) {
    const id = resolver.resolve(file, `berserk cue ${key}`)
    if (use(id)) cues[key] = { files: [id], gain: 1, category: 'sfx' }
  }
  // Generic weapon swings (the clip tracks normally carry them): 'swing.SWORD' ...
  for (const w of inp.scope === 'jangan' ? JANGAN_HIT_WEAPONS : uniq(table.find('PLAYER', { handle: /^SND_SWING\d$/, skill: '' }).map(r => r.event1).filter(w => w && w !== 'HWAN'))) {
    cue(`swing.${w}`, table.find('PLAYER', { handle: /^SND_SWING\d$/, skill: '', event1: w }), 'sfx')
  }
  // Berserk ('hwan', 환; docs/SOUND.md §10.3): per weapon the SND_SWING3 HWAN <weapon> swing, and the HWAN hit and
  // crit rows. (Not the imbues: those are skill groups, SKILL_CH_*_GIGONGTA_*, with their own SND_DMG rows.)
  const hwanSwings = table.find('PLAYER', { handle: /^SND_SWING\d$/, skill: '', event1: 'HWAN' })
  for (const w of uniq(hwanSwings.map(r => r.event2).filter(w => w && (inp.scope === 'all' || JANGAN_HIT_WEAPONS.includes(w))))) {
    cue(`swing.hwan.${w}`, hwanSwings.filter(r => r.event2 === w), 'sfx')
  }
  cue('hit.crit', table.find('PLAYER', { handle: 'SND_CRIDMG', skill: '', event1: '' }), 'sfx')
  cue('hit.hwan', table.find('PLAYER', { handle: 'SND_DMG', skill: '', event1: 'HWAN', event2: '' }), 'sfx')
  cue('hit.hwanCrit', table.find('PLAYER', { handle: 'SND_CRIDMG', skill: '', event1: 'HWAN' }), 'sfx')
  cue('block.normal', table.find('PLAYER', { handle: 'SND_BLOCKING', skill: '', event1: '', event2: 'NORMAL' }), 'sfx')
  cue('block.crit', table.find('PLAYER', { handle: 'SND_BLOCKING', skill: '', event1: '', event2: 'CRITYCAL' }), 'sfx')
  cue('block.bow', table.find('PLAYER', { handle: 'SND_BLOCKING', skill: '', event1: 'BOW' }).filter(r => r.event2 !== 'CRITYCAL'), 'sfx')
  cue('block.bowCrit', table.find('PLAYER', { handle: 'SND_BLOCKING', skill: '', event1: 'BOW', event2: 'CRITYCAL' }), 'sfx')

  // ---- footsteps ----
  const steps: SoundIndex['steps'] = { walk: {}, run: {}, objectFloor: OBJECT_FLOOR_SURFACE }
  const stepRows = (handle: string) => table.find('PLAYER', { handle, skill: '', event1: 'FIELD' })
  for (const r of stepRows('SND_WALK1')) {
    const s = surfaceOfDescription(r.description)
    const id = s && resolver.resolve(r.file, `effectsound PLAYER SND_WALK1 ${s}`)
    if (s && id) steps.walk[s] = uniq([...(steps.walk[s] ?? []), id])
  }
  for (const r of stepRows('SND_RUN1')) {
    const s = surfaceOfDescription(r.description)
    const walk = s && resolver.resolve(r.file, `effectsound PLAYER SND_RUN1 ${s}`)
    if (!s || !walk) continue
    // The RUN rows name mvWalk* files, but mvrun* exists for most surfaces: prefer it (§2.4).
    const run = walk.replace(/^player\/mvwalk/, 'player/mvrun')
    const id = resolver.has(run) ? run : resolver.has(run.replace(/_[ab]$/, '')) ? run.replace(/_[ab]$/, '') : walk
    steps.run[s] = uniq([...(steps.run[s] ?? []), id])
  }
  for (const [s, [walk, run]] of Object.entries(STEP_SUFFIX) as Array<[SoundSurface, readonly [readonly string[], readonly string[]]]>) {
    if (!steps.walk[s]) {
      const ids = walk.map(x => `player/mvwalk${x}`).filter(id => resolver.has(id))
      if (ids.length) steps.walk[s] = ids
    }
    if (!steps.run[s]) {
      const ids = run.map(x => `player/mvrun${x}`).filter(id => resolver.has(id))
      if (ids.length) steps.run[s] = ids
    }
  }
  for (const m of [steps.walk, steps.run]) for (const ids of Object.values(m)) for (const id of ids ?? []) files.add(id)
  // Every mv* file ships, even those no row names (the runtime substitutes by surface).
  for (const id of resolver.allIds()) if (/^player\/mv(walk|run)/.test(id)) files.add(id)

  // ---- generic weapon hits ----
  const hitSetOf = (rows: readonly EffectSoundRow[], from: string): HitSet | null => {
    const set: HitSet = { weak: {}, strong: {}, gain: rowGain(rows) }
    const parsed = rows.map(parseHitRow)
    if (!rows.length || parsed.some(h => !h)) return null
    let any = false
    for (const [i, r] of rows.entries()) {
      const h = parsed[i]!
      const id = resolver.resolve(r.file, from)
      if (!use(id)) continue
      set[h.strength][h.cls] ??= id
      any = true
    }
    return any ? set : null
  }
  const hits: Record<string, HitSet> = {}
  const weapons = inp.scope === 'jangan'
    ? JANGAN_HIT_WEAPONS
    : uniq(table.find('PLAYER', { handle: 'SND_DMG', skill: '', event2: '' }).map(r => r.event1).filter(w => w && w !== 'HWAN'))
  for (const w of weapons) {
    const set = hitSetOf(table.find('PLAYER', { handle: 'SND_DMG', skill: '', event1: w, event2: '' }), `effectsound PLAYER SND_DMG ${w}`)
    if (set) hits[w] = set
  }

  // ---- skills ----
  const stagesByGroup = new Map<string, NonNullable<SkillSounds['stages']>>()
  const scopeGroups = new Set(inp.skillGroups.map(g => g.toUpperCase()))
  // Jangan: every Chinese skill group (SKILL_CH_*, all levels of the table), plus the skills.json groups.
  const inScopeSkill = (g: string) => (inp.scope === 'all' ? g.startsWith('SKILL_') : g.startsWith('SKILL_CH_') || scopeGroups.has(g))
  for (const c of skillEffectSections(inp.skillEffectText).get('skilleffectset') ?? []) {
    const group = (c[1] ?? '').trim().toUpperCase()
    if (!group || !inScopeSkill(group)) continue
    const snd = (v: string | undefined) => {
      const t = (v ?? '').trim()
      if (!t || t.toLowerCase() === 'none' || !/\.wav$/i.test(t)) return null
      const id = resolver.resolve(t, `skilleffect ${group}`)
      return use(id) ? id : null
    }
    const begin = snd(c[26])
    const end = snd(c[27])
    if (!begin && !end) continue
    let list = stagesByGroup.get(group)
    if (!list) stagesByGroup.set(group, (list = []))
    list.push({ phase: (c[2] ?? '').trim(), startEvent: Number(c[3]) || 0, begin, end })
  }
  const skills: Record<string, SkillSounds> = {}
  const groups = uniq([...table.skills('PLAYER').filter(inScopeSkill), ...stagesByGroup.keys(), ...(inp.scope === 'jangan' ? scopeGroups : [])])
  for (const group of groups.sort()) {
    const rows = table.find('PLAYER', { skill: group })
    const s: SkillSounds = {}
    const swingRows = rows.filter(r => r.handle !== 'SND_DMG' && r.handle !== 'SND_CRIDMG')
    for (const handle of uniq(swingRows.map(r => r.handle))) {
      const ids = resolveRows(swingRows.filter(r => r.handle === handle))
      if (ids.length) (s.swing ??= {})[handle.toLowerCase()] = ids
    }
    const dmgRows = rows.filter(r => r.handle === 'SND_DMG')
    if (dmgRows.length) {
      const set = hitSetOf(dmgRows, `effectsound PLAYER SND_DMG ${group}`)
      const ids = set ? null : resolveRows(dmgRows)
      if (set) s.dmg = set
      else if (ids?.length) s.dmg = ids
    }
    const stages = stagesByGroup.get(group)
    if (stages?.length) s.stages = stages
    if (s.swing || s.dmg || s.stages) skills[group] = s
  }

  // ---- voices and mobs ----
  const voiceSet = (object: string): VoiceSet => {
    const all = table.find(object)
    const pick = (handle: string | RegExp, f: { event1?: string } = {}) =>
      resolveRows(table.find(object, { handle, skill: '', ...f }))
    return {
      object,
      moan: { normal: pick('VOC_MOAN', { event1: 'NORMAL' }), crit: pick('VOC_MOAN', { event1: 'CRITYCAL' }) },
      deathVoice: pick(/^VOC_DEATH\d*$/),
      deathThud: pick(/^SND_DEATH\d*$/),
      shout1: pick('VOC_SHOUT1'),
      shout2: pick('VOC_SHOUT2'),
      avoid: pick('VOC_AVOID'),
      gain: rowGain(all),
    }
  }
  const optional = (v: VoiceSet, key: 'sitDown' | 'standUp', handle: string) => {
    const ids = resolveRows(table.find(v.object, { handle, skill: '' }))
    if (ids.length) v[key] = ids
  }
  const voices: Record<string, VoiceSet> = {}
  for (const code of inp.players) {
    const object = playerVoiceObject(code)
    if (!object) continue
    const v = voiceSet(object)
    optional(v, 'sitDown', 'VOC_SITDOWN')
    optional(v, 'standUp', 'VOC_STANDUP')
    voices[code] = v
  }
  const mobs: Record<string, MobSounds> = {}
  for (const { code } of inp.mobs) {
    const object = mobSoundObject(code)
    const v = voiceSet(object)
    const walk = resolveRows(table.find(object, { handle: /^SND_(WALK|RUN)\d*$/, skill: '' }))
    const attacks: MobSounds['attacks'] = {}
    for (const skill of table.skills(object)) {
      const rows = table.find(object, { skill })
      const a: MobSounds['attacks'][string] = {}
      const swing = resolveRows(rows.filter(r => /^SND_SW/.test(r.handle)))
      const shout = resolveRows(rows.filter(r => /SHOUT/.test(r.handle)))
      const dmg = resolveRows(rows.filter(r => r.handle === 'SND_DMG'))
      if (swing.length) a.swing = swing
      if (shout.length) a.shout = shout
      if (dmg.length) a.dmg = dmg
      if (a.swing || a.shout || a.dmg) attacks[skill] = a
    }
    const idle = resolveRows(table.find(object, { handle: /^SND_STAND\d*$/, skill: '' }))
    mobs[code] = { ...v, walk, ...(idle.length ? { idle } : {}), attacks }
  }

  // ---- areas ----
  const areas: Record<string, AreaSound> = {}
  const music = new Set(inp.musicKeys.map(k => k.toLowerCase()))
  const envByName = new Map(inp.envAreas.map(a => [a.name, a] as const))
  const regionsByName = new Map<string, RegionArea>()
  for (const a of inp.regionAreas) if (!regionsByName.has(a.name)) regionsByName.set(a.name, a)
  const areaNames = inp.scope === 'jangan' ? JANGAN_AREAS : uniq(inp.envAreas.map(a => a.name))
  for (const name of areaNames) {
    const env = envByName.get(name)
    if (!env) continue
    const region = regionsByName.get(name)
    const stem = env.music ? env.music.replace(/\.[a-z0-9]+$/i, '') : name
    let id = stem.toUpperCase()
    for (let n = 2; areas[id]; n++) id = `${stem.toUpperCase()}_${n}`
    const layers = (list: EnvArea['day']): AmbientLayer[] => {
      const out: AmbientLayer[] = []
      for (const l of list) {
        const file = resolver.resolveIn('env', l.file, `effectenvsnd ${name}`)
        if (!use(file)) continue
        ambient.add(file)
        out.push({ file, loop: l.min === 0 && l.max === 0, everyS: [l.min, l.max] })
      }
      return out
    }
    areas[id] = {
      source: name,
      kind: region?.kind ?? (name.endsWith('필드') ? 'field' : 'town'),
      music: env.music && music.has(stem.toLowerCase()) ? stem.toLowerCase() : null,
      day: layers(env.day),
      night: layers(env.night),
      regions: region ? region.regions.map(r => r.id) : [],
    }
  }

  // ---- model clip tracks ----
  const models: ModelSounds[] = []
  const modelUrls: Record<string, string> = {}
  let tracks = 0
  const bsrDone = new Set<string>()
  for (const m of inp.models) {
    if (!m.res) continue
    // The §4.2 union: every resolved track of the model's BSR ships, also those of sets no exported clip plays
    // (other aniGroups, other costumes' locomotion BANs), so a wider clip set later needs no re-export.
    if (!bsrDone.has(m.bsr.toLowerCase())) {
      bsrDone.add(m.bsr.toLowerCase())
      for (const p of bsrSoundPaths(m.res)) use(resolver.resolve(p, m.code))
    }
    const ms = modelTracks(m.code, m.bsr, m.res, m.clips, resolver)
    const n = trackCount(ms)
    if (!n) continue
    for (const list of Object.values(ms.clips)) for (const t of list) files.add(t.file)
    models.push(ms)
    modelUrls[m.code] = `sound/model/${m.code}.json`
    tracks += n
  }

  return {
    index: {
      format: SOUND_INDEX_FORMAT,
      version: 1,
      generator: 'packages/convert/src/tools/export-sound.ts',
      cues,
      steps,
      hits,
      skills,
      voices,
      mobs,
      models: modelUrls,
      areas,
    },
    models,
    files,
    tracks,
    ambient,
  }
}

export interface FinishStats {
  codec: SoundCodec
  wavFallback: boolean
  generatedAt: string
  sourceFiles: number
  sourceBytes: number
  outBytes: number
  notExported: string[]
}

/**
 * The final index: `files` holds what was written; references to files that could not be exported are removed
 * (listed in report.notExported) so the index stays self-consistent.
 */
export function finishSoundIndex(plan: SoundPlan, files: Record<string, SoundFile>, resolver: SoundResolver, st: FinishStats): SoundIndex {
  const ok = (id: string) => id in files
  const keep = (ids: string[]) => ids.filter(ok)
  const idx = plan.index
  const cues: Record<string, SoundCue> = {}
  for (const [k, c] of Object.entries(idx.cues)) {
    const f = keep(c.files)
    if (f.length) cues[k] = { ...c, files: f }
  }
  const stepMap = (m: Partial<Record<SoundSurface, string[]>>) => {
    const out: Partial<Record<SoundSurface, string[]>> = {}
    for (const [s, ids] of Object.entries(m) as Array<[SoundSurface, string[]]>) if (keep(ids).length) out[s] = keep(ids)
    return out
  }
  const hitSet = (h: HitSet): HitSet => {
    const side = (x: HitSet['weak']) => Object.fromEntries(Object.entries(x).filter(([, id]) => id && ok(id)))
    return { weak: side(h.weak), strong: side(h.strong), gain: h.gain }
  }
  const voice = <T extends VoiceSet>(v: T): T => ({
    ...v,
    moan: { normal: keep(v.moan.normal), crit: keep(v.moan.crit) },
    deathVoice: keep(v.deathVoice),
    deathThud: keep(v.deathThud),
    shout1: keep(v.shout1),
    shout2: keep(v.shout2),
    avoid: keep(v.avoid),
    ...(v.sitDown ? { sitDown: keep(v.sitDown) } : {}),
    ...(v.standUp ? { standUp: keep(v.standUp) } : {}),
  })
  const skills: Record<string, SkillSounds> = {}
  for (const [g, s] of Object.entries(idx.skills)) {
    const o: SkillSounds = {}
    if (s.swing) {
      for (const [h, ids] of Object.entries(s.swing)) if (keep(ids).length) (o.swing ??= {})[h] = keep(ids)
    }
    if (s.dmg) o.dmg = Array.isArray(s.dmg) ? keep(s.dmg) : hitSet(s.dmg)
    if (s.stages) o.stages = s.stages.map(st => ({ ...st, begin: st.begin && ok(st.begin) ? st.begin : null, end: st.end && ok(st.end) ? st.end : null }))
    skills[g] = o
  }
  const mobs: Record<string, MobSounds> = {}
  for (const [code, m] of Object.entries(idx.mobs)) {
    const attacks: MobSounds['attacks'] = {}
    for (const [k, a] of Object.entries(m.attacks)) {
      attacks[k] = Object.fromEntries(Object.entries(a).map(([h, ids]) => [h, keep(ids ?? [])]).filter(([, ids]) => (ids as string[]).length))
    }
    mobs[code] = { ...voice(m), walk: keep(m.walk), ...(m.idle ? { idle: keep(m.idle) } : {}), attacks }
  }
  const areas: Record<string, AreaSound> = {}
  for (const [k, a] of Object.entries(idx.areas)) areas[k] = { ...a, day: a.day.filter(l => ok(l.file)), night: a.night.filter(l => ok(l.file)) }
  const sortedFiles = Object.fromEntries(Object.entries(files).sort((a, b) => a[0].localeCompare(b[0])))
  return {
    format: idx.format,
    version: 1,
    generator: idx.generator,
    generatedAt: st.generatedAt,
    codec: st.codec,
    wavFallback: st.wavFallback,
    files: sortedFiles,
    cues,
    steps: { walk: stepMap(idx.steps.walk), run: stepMap(idx.steps.run), objectFloor: idx.steps.objectFloor },
    hits: Object.fromEntries(Object.entries(idx.hits).map(([k, h]) => [k, hitSet(h)])),
    skills,
    voices: Object.fromEntries(Object.entries(idx.voices).map(([k, v]) => [k, voice(v)])),
    mobs,
    models: idx.models,
    areas,
    report: {
      sourceFiles: st.sourceFiles,
      sourceBytes: st.sourceBytes,
      outBytes: st.outBytes,
      tracks: plan.tracks,
      unresolved: resolver.unresolved(),
      notExported: st.notExported,
    },
  }
}

/** Model files with tracks to files that were not exported removed (empty clips dropped). */
export function finishModel(m: ModelSounds, files: Record<string, SoundFile>): ModelSounds {
  const clips: ModelSounds['clips'] = {}
  for (const [k, list] of Object.entries(m.clips)) {
    const kept = list.filter(t => t.file in files)
    if (kept.length) clips[k] = kept
  }
  return { ...m, clips }
}
