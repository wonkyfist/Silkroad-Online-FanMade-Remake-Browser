/**
 * Sound index contract (docs/SOUND.md §4.3): what packages/convert/src/tools/export-sound.ts writes to
 * work/out/sound/index.json + sound/model/<CodeName128>.json, and what apps/game/src/audio/** reads.
 * Node-free and environment-neutral, like content.ts.
 *
 * File ids (SoundIndex.files keys) are the lower-case path under Data.pk2 prim/snd without extension
 * ('player/mvwalkgrass'); every url is relative to the asset root (/out/ or /out-opt/), e.g. 'sound/player/mvwalkgrass.ogg'.
 */

export const SOUND_INDEX_FORMAT = 'sro-sound'
export const SOUND_MODEL_FORMAT = 'sro-sound-model'

export type SoundCategory = 'music' | 'sfx' | 'ui' | 'ambient'
export type SoundCodec = 'opus' | 'wav'
/** tile2d.ifo surface types (TILE2D_TYPES) that effectsound.txt keys footsteps by. */
export type SoundSurface =
  | 'Dirt' | 'Sand' | 'Ashfield' | 'Stone' | 'Metal' | 'Wood' | 'Mud' | 'Water' | 'DeepWater'
  | 'Snow' | 'Grass' | 'LongGrass' | 'Forest' | 'Cloud'
/** What a clip track does; derived from the BSR event name (raw kept in ClipTrack.raw). */
export type SoundHandle =
  | 'step_walk'   // snd_walk, snd_walk1..3
  | 'step_run'    // snd_run, snd_run1..3
  | 'swing'       // snd_swing1..4, snd_swing_s, snd_swing_s1/_s2, snd_swing_1, snd_swign1/2
  | 'shout'       // voc_shout, voc_shout1/2, voc_shot2, snd_shout1/2
  | 'moan'        // voc_moan, voc_moan1/2
  | 'death_voice' // voc_death
  | 'death_thud'  // snd_death, snd_death1/2
  | 'block'       // snd_blocking
  | 'pickup'      // snd_pickup
  | 'idle'        // snd_stand, snd_stand1/2
  | 'emote'       // voc_emo
  | 'alert'       // snd_find, snd_helf
  | 'other'       // '' and anything else

export const SOUND_CATEGORIES: readonly SoundCategory[] = ['music', 'sfx', 'ui', 'ambient']
export const SOUND_SURFACES: readonly SoundSurface[] = [
  'Dirt', 'Sand', 'Ashfield', 'Stone', 'Metal', 'Wood', 'Mud', 'Water', 'DeepWater', 'Snow', 'Grass', 'LongGrass', 'Forest', 'Cloud',
]
export const SOUND_HANDLES: readonly SoundHandle[] = [
  'step_walk', 'step_run', 'swing', 'shout', 'moan', 'death_voice', 'death_thud', 'block', 'pickup', 'idle', 'emote', 'alert', 'other',
]

/** One encoded file. Key in SoundIndex.files: lower-case path under prim/snd without extension ('player/mvwalkgrass'). */
export interface SoundFile {
  /** Relative to /out/ ('sound/player/mvwalkgrass.ogg'). */
  url: string
  /** Relative to /out/, present only with --also-wav. */
  wav?: string
  /** Duration after trimming. */
  ms: number
  channels: 1 | 2
  bytes: number
}

/** A playable choice: one of `files` at random, at `gain` (effectsound volume / 100). */
export interface SoundCue {
  files: string[]
  gain: number
  category: SoundCategory
}

export interface ClipTrack {
  /** From the clip start at speed 1. */
  ms: number
  handle: SoundHandle
  /** BSR event name as stored ('snd_swing_s1'). */
  raw: string
  /** SoundIndex.files key. */
  file: string
}

/** sound/model/<code>.json */
export interface ModelSounds {
  format: typeof SOUND_MODEL_FORMAT
  version: 1
  code: string
  bsr: string
  /** Keyed by sidecar clip name ('ATTACK1_sword_base_01'); tracks sorted by ms. */
  clips: Record<string, ClipTrack[]>
}

export type HitClass = 'n' | 'b' | 'a'
/** SND_DMG files by strength (1 weak, 2 strong) and target class; any may be missing. */
export interface HitSet {
  weak: Partial<Record<HitClass, string>>
  strong: Partial<Record<HitClass, string>>
  gain: number
}

export interface SkillSounds {
  /** effectsound PLAYER rows for this skill group: handle raw name ('snd_swing_s1') -> files. */
  swing?: Record<string, string[]>
  dmg?: HitSet | string[]
  /** skilleffect cols 26/27, in table order. */
  stages?: Array<{ phase: string; startEvent: number; begin: string | null; end: string | null }>
}

export interface VoiceSet {
  /** effectsound object ('PCM_ADVENTURER', 'MOB_MANGNYANG'). */
  object: string
  moan: { normal: string[]; crit: string[] }
  deathVoice: string[]
  deathThud: string[]
  shout1: string[]
  shout2: string[]
  avoid: string[]
  /** VOC_SITDOWN / VOC_STANDUP (emoticon folder); players only, absent when the object has none. */
  sitDown?: string[]
  standUp?: string[]
  gain: number
}

export interface MobSounds extends VoiceSet {
  walk: string[]
  /** SND_STAND* idle sounds; absent when the object has none. */
  idle?: string[]
  /** Per mob skill (MSKILL_*): swing/shout/dmg rows. */
  attacks: Record<string, { swing?: string[]; shout?: string[]; dmg?: string[] }>
}

export interface AmbientLayer {
  file: string
  /** true: continuous loop ('0~0'); false: one-shot every everyS[0]..everyS[1] seconds. */
  loop: boolean
  everyS: [number, number]
}

export interface AreaSound {
  /** Area name as in regioninfo/effectenvsnd ('장안'). */
  source: string
  kind: 'town' | 'field'
  /** ui/index.json music key ('jangan_town') or null when not exported. */
  music: string | null
  day: AmbientLayer[]
  night: AmbientLayer[]
  /** regioninfo ALL/RECT rows as region ids (z << 8 | x); informational. */
  regions: number[]
}

export interface SoundIndex {
  format: typeof SOUND_INDEX_FORMAT
  version: 1
  generator: string
  generatedAt: string
  codec: SoundCodec
  wavFallback: boolean
  files: Record<string, SoundFile>
  /** Logical cues: 'ui.click', 'ui.click2', 'ui.windowOpen', 'ui.windowClose', 'ui.error', 'ui.warning',
   *  'ui.levelUp', 'ui.potion', 'ui.revive', 'ui.questOpen', 'ui.questDone', 'item.pickup', 'item.dropGold',
   *  'item.equip.<KIND>' (effectsound ITEM SND_EQUIP event1), 'hit.crit', 'block.normal', 'block.crit'.
   *  Extras written when the data has them: 'ui.repair', 'item.dropRare', 'hit.imbue', 'hit.imbueCrit'.
   *  Weather (WEATHER_CUES): 'weather.rain', 'weather.thunder.near/mid/far', 'weather.wind.strong', 'weather.wind.gust'. */
  cues: Record<string, SoundCue>
  steps: {
    walk: Partial<Record<SoundSurface, string[]>>
    run: Partial<Record<SoundSurface, string[]>>
    /** Surface used on navmesh object floors. */
    objectFloor: SoundSurface
  }
  /** Generic weapon hits: 'SWORD' 'BLADE' 'SPEAR' 'BOW' 'PUNCH' ... (PLAYER SND_DMG event1). */
  hits: Record<string, HitSet>
  /** SKILL_CH_* groups (and SKILL_CH_<FAMILY>_BASE). */
  skills: Record<string, SkillSounds>
  /** By CodeName128: CHAR_CH_* -> its PCM_/PCF_ voice set. */
  voices: Record<string, VoiceSet>
  /** By CodeName128 (MOB_CH_MANGNYANG, MOB_CH_TIGER_CLON, ...). */
  mobs: Record<string, MobSounds>
  /** CodeName128 -> 'sound/model/<code>.json' (players, mobs, NPCs with at least one track). */
  models: Record<string, string>
  /** 'JANGAN_TOWN', 'JANGAN_FIELD' (id = the music file stem upper-cased). */
  areas: Record<string, AreaSound>
  report: {
    sourceFiles: number
    sourceBytes: number
    outBytes: number
    tracks: number
    unresolved: Array<{ path: string; from: string[] }>
    notExported: string[]
  }
}

// ---- helpers shared by the exporter and the client ---------------------------------------------------

/**
 * Footstep file suffixes per surface (docs/SOUND.md §2.4, which follows the Korean description column of
 * effectsound.txt): file ids are `player/mvwalk<suffix>` and `player/mvrun<suffix>`.
 */
export const STEP_SUFFIX: Readonly<Record<SoundSurface, readonly [walk: readonly string[], run: readonly string[]]>> = {
  Dirt: [['ground'], ['ground']],
  Sand: [['gravel'], ['gravel']],
  Ashfield: [['grass'], ['grass']],
  Stone: [['hground'], ['hground']],
  Metal: [['gravel'], ['gravel']],
  Wood: [['hwood_a', 'hwood_b'], ['hwood']],
  Mud: [['mud'], ['mud']],
  Water: [['mud'], ['mud']],
  DeepWater: [['water'], ['water']],
  Snow: [['snow'], ['snow']],
  Grass: [['grass'], ['grass']],
  LongGrass: [['grass'], ['grass']],
  Forest: [['cloud'], ['cloud']],
  Cloud: [['cloud'], ['cloud']],
}

/** Surface used on navmesh object floors (the Jangan plaza, bridges, building floors): hard floor. */
export const OBJECT_FLOOR_SURFACE: SoundSurface = 'Stone'

/** Clip-track files that the runtime replaces with the surface's footstep ('player/mvwalkground', 'player/mvrunground'). */
export const STEP_FILE_RE = /^player\/mv(walk|run)/

/** The SoundHandle of a BSR event name (case-insensitive; typos included, see SoundHandle). */
export function soundHandle(rawEvent: string): SoundHandle {
  const e = rawEvent.trim().toLowerCase()
  if (/^snd_walk\d*$/.test(e)) return 'step_walk'
  if (/^snd_run\d*$/.test(e)) return 'step_run'
  if (/^snd_swi(?:ng|gn)(?:_s)?_?\d*$/.test(e)) return 'swing'
  if (/^voc_(?:shout|shot)\d*$/.test(e) || /^snd_shout\d*$/.test(e)) return 'shout'
  if (/^voc_moan\d*$/.test(e)) return 'moan'
  if (/^voc_death\d*$/.test(e)) return 'death_voice'
  if (/^snd_death\d*$/.test(e)) return 'death_thud'
  if (e === 'snd_blocking') return 'block'
  if (e === 'snd_pickup') return 'pickup'
  if (/^snd_stand\d*$/.test(e)) return 'idle'
  if (/^voc_emo/.test(e)) return 'emote'
  if (e === 'snd_find' || e === 'snd_helf') return 'alert'
  return 'other'
}

/** effectsound object of a mob code: MOB_CH_TIGER_CLON -> MOB_TIGER, MOB_WC_HYEONGCHEON -> MOB_HYEONGCHEON. */
export function mobSoundObject(code: string): string {
  const c = code.trim().toUpperCase()
  const m = /^MOB_[A-Z]{2,3}_(.+?)(?:_CLON)?$/.exec(c)
  return m ? `MOB_${m[1]}` : c
}

/** effectsound voice object of a player code: CHAR_CH_WOMAN_NECROMENCERB -> PCF_NECROMANCERB; null for others. */
export function playerVoiceObject(code: string): string | null {
  const m = /^CHAR_CH_(MAN|WOMAN)_(.+)$/.exec(code.trim().toUpperCase())
  if (!m) return null
  return `${m[1] === 'MAN' ? 'PCM' : 'PCF'}_${m[2]!.replace('NECROMENCER', 'NECROMANCER')}`
}

// ---- weather (docs/WEATHER.md §7.5, docs/SOUND.md §8) -------------------------------------------------

/**
 * The 12 weather files the export adds in every scope (retail durations, ffprobe): the rain loop `etc/rain1` (2.3 s,
 * stereo), the thunder `etc/lightning1..3` (6.2 / 8.2 / 11.8 s), the winds `env/dd_mainwind` (a steady 2.0 s loop),
 * `env/dd_wind_01/02` (3.6 / 3.4 s gusts) and `env/donhwang_wind01..05` (gusts; 04 is the longest, 20.7 s raw). All
 * ambient class: 64 kbps Opus, stereo kept; trailing silence is trimmed as for every file, so the index `ms` is
 * shorter for the winds. The light wind bed is `env/day_wind`, already exported by the Jangan area layers.
 */
export const WEATHER_SOUND_FILES: readonly string[] = [
  'etc/rain1',
  'etc/lightning1', 'etc/lightning2', 'etc/lightning3',
  'env/dd_mainwind', 'env/dd_wind_01', 'env/dd_wind_02',
  'env/donhwang_wind01', 'env/donhwang_wind02', 'env/donhwang_wind03', 'env/donhwang_wind04', 'env/donhwang_wind05',
]

/**
 * Weather cues (ambient bus, gain 1: the client scales by rain, gust and distance). Which file sounds right is a
 * listening call: reassign here (the client takes these cues over the exported index's whenever the index has their
 * files, so a reassignment among the exported files needs no re-export). The thunder split follows the envelopes
 * (lightning1 cracks at once, lightning2 peaks after 1.5 s, lightning3 is the long rumble). The donhwang winds are gusts
 * that swell and fade to silence, not steady loops, so they are the `weather.wind.gust` one-shots (one of six,
 * random); `weather.wind.strong` is the steady `dd_mainwind` (W9F A5: donhwang_wind04 as a bed was 39 % near-silence
 * with a 2.9 s dropout, so it pulsed), which the client lifts to the old bed's level (WEATHER_AUDIO.wind.bedGain).
 */
export const WEATHER_CUES: Readonly<Record<string, Readonly<SoundCue>>> = {
  'weather.rain': { files: ['etc/rain1'], gain: 1, category: 'ambient' },
  'weather.thunder.near': { files: ['etc/lightning1'], gain: 1, category: 'ambient' },
  'weather.thunder.mid': { files: ['etc/lightning2'], gain: 1, category: 'ambient' },
  'weather.thunder.far': { files: ['etc/lightning3'], gain: 1, category: 'ambient' },
  'weather.wind.strong': { files: ['env/dd_mainwind'], gain: 1, category: 'ambient' },
  'weather.wind.gust': {
    files: ['env/dd_wind_01', 'env/dd_wind_02', 'env/donhwang_wind01', 'env/donhwang_wind02', 'env/donhwang_wind03', 'env/donhwang_wind04', 'env/donhwang_wind05'],
    gain: 1,
    category: 'ambient',
  },
}

/** The thunder cue for a strike `distM` metres away: near below 800 m, mid below 2000 m, far beyond. */
export function thunderCue(distM: number): 'weather.thunder.near' | 'weather.thunder.mid' | 'weather.thunder.far' {
  return distM < 800 ? 'weather.thunder.near' : distM < 2000 ? 'weather.thunder.mid' : 'weather.thunder.far'
}

/**
 * Adds the weather files (as ambient) and cues to an export plan (`planSoundIndex`'s result fits structurally).
 * A file without a source ends in report.notExported and `finishSoundIndex` drops the cues left empty.
 */
export function addWeatherSounds(plan: { files: Set<string>; ambient: Set<string>; index: { cues: Record<string, SoundCue> } }): void {
  for (const id of WEATHER_SOUND_FILES) {
    plan.files.add(id)
    plan.ambient.add(id)
  }
  for (const [k, c] of Object.entries(WEATHER_CUES)) plan.index.cues[k] = { ...c, files: [...c.files] }
}

// ---- validation ---------------------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)

/** Problems found in an index (empty = valid). Same style as validateWorldManifest. */
export function validateSoundIndex(v: unknown): string[] {
  const errors: string[] = []
  const err = (path: string, what: string) => {
    if (errors.length < 200) errors.push(`${path}: ${what}`)
  }
  if (!isObj(v)) return ['index: not an object']
  if (v.format !== SOUND_INDEX_FORMAT) err('format', `expected ${SOUND_INDEX_FORMAT}`)
  if (v.version !== 1) err('version', 'expected 1')
  for (const k of ['generator', 'generatedAt']) if (!isStr(v[k])) err(k, 'expected a string')
  if (v.codec !== 'opus' && v.codec !== 'wav') err('codec', 'expected opus or wav')
  if (typeof v.wavFallback !== 'boolean') err('wavFallback', 'expected a boolean')

  const files = isObj(v.files) ? v.files : (err('files', 'expected an object'), {})
  for (const [id, f] of Object.entries(files)) {
    const p = `files.${id}`
    if (id !== id.toLowerCase() || id.includes('\\') || /\.(wav|ogg)$/.test(id)) err(p, 'id must be a lower-case path without extension')
    if (!isObj(f)) {
      err(p, 'expected an object')
      continue
    }
    if (!isStr(f.url) || !f.url.startsWith('sound/')) err(`${p}.url`, "expected 'sound/...'")
    if (f.wav !== undefined && (!isStr(f.wav) || !f.wav.startsWith('sound/'))) err(`${p}.wav`, "expected 'sound/...'")
    if (!isNum(f.ms) || f.ms < 0) err(`${p}.ms`, 'expected a number >= 0')
    if (f.channels !== 1 && f.channels !== 2) err(`${p}.channels`, 'expected 1 or 2')
    if (!isNum(f.bytes) || f.bytes <= 0) err(`${p}.bytes`, 'expected a number > 0')
  }
  const ref = (p: string, id: unknown) => {
    if (!isStr(id)) err(p, 'expected a file id')
    else if (!(id in files)) err(p, `unknown file ${id}`)
  }
  const refs = (p: string, ids: unknown) => {
    if (!isStrArr(ids)) return err(p, 'expected string[]')
    ids.forEach((id, i) => ref(`${p}[${i}]`, id))
  }
  const gain = (p: string, g: unknown) => {
    if (!isNum(g) || g < 0 || g > 1) err(p, 'expected a gain in 0..1')
  }
  const hitSet = (p: string, h: unknown) => {
    if (!isObj(h)) return err(p, 'expected a HitSet')
    for (const s of ['weak', 'strong'] as const) {
      const side = h[s]
      if (!isObj(side)) {
        err(`${p}.${s}`, 'expected an object')
        continue
      }
      for (const [k, id] of Object.entries(side)) {
        if (k !== 'n' && k !== 'b' && k !== 'a') err(`${p}.${s}.${k}`, 'expected n, b or a')
        ref(`${p}.${s}.${k}`, id)
      }
    }
    gain(`${p}.gain`, h.gain)
  }
  const voiceSet = (p: string, s: Record<string, unknown>) => {
    if (!isStr(s.object)) err(`${p}.object`, 'expected a string')
    if (!isObj(s.moan)) err(`${p}.moan`, 'expected {normal, crit}')
    else {
      refs(`${p}.moan.normal`, s.moan.normal)
      refs(`${p}.moan.crit`, s.moan.crit)
    }
    for (const k of ['deathVoice', 'deathThud', 'shout1', 'shout2', 'avoid']) refs(`${p}.${k}`, s[k])
    for (const k of ['sitDown', 'standUp', 'idle']) if (s[k] !== undefined) refs(`${p}.${k}`, s[k])
    gain(`${p}.gain`, s.gain)
  }

  const cues = isObj(v.cues) ? v.cues : (err('cues', 'expected an object'), {})
  for (const [k, c] of Object.entries(cues)) {
    if (!isObj(c)) {
      err(`cues.${k}`, 'expected a SoundCue')
      continue
    }
    refs(`cues.${k}.files`, c.files)
    if (isStrArr(c.files) && c.files.length === 0) err(`cues.${k}.files`, 'empty')
    gain(`cues.${k}.gain`, c.gain)
    if (!SOUND_CATEGORIES.includes(c.category as SoundCategory)) err(`cues.${k}.category`, 'bad category')
  }

  const steps = v.steps
  if (!isObj(steps)) err('steps', 'expected an object')
  else {
    for (const mode of ['walk', 'run'] as const) {
      const m = steps[mode]
      if (!isObj(m)) {
        err(`steps.${mode}`, 'expected an object')
        continue
      }
      for (const [surface, ids] of Object.entries(m)) {
        if (!SOUND_SURFACES.includes(surface as SoundSurface)) err(`steps.${mode}.${surface}`, 'unknown surface')
        refs(`steps.${mode}.${surface}`, ids)
      }
    }
    if (!SOUND_SURFACES.includes(steps.objectFloor as SoundSurface)) err('steps.objectFloor', 'unknown surface')
  }

  const hits = isObj(v.hits) ? v.hits : (err('hits', 'expected an object'), {})
  for (const [k, h] of Object.entries(hits)) hitSet(`hits.${k}`, h)

  const skills = isObj(v.skills) ? v.skills : (err('skills', 'expected an object'), {})
  for (const [k, s] of Object.entries(skills)) {
    const p = `skills.${k}`
    if (!isObj(s)) {
      err(p, 'expected an object')
      continue
    }
    if (s.swing !== undefined) {
      if (!isObj(s.swing)) err(`${p}.swing`, 'expected an object')
      else for (const [h, ids] of Object.entries(s.swing)) refs(`${p}.swing.${h}`, ids)
    }
    if (s.dmg !== undefined) {
      if (Array.isArray(s.dmg)) refs(`${p}.dmg`, s.dmg)
      else hitSet(`${p}.dmg`, s.dmg)
    }
    if (s.stages !== undefined) {
      if (!Array.isArray(s.stages)) err(`${p}.stages`, 'expected an array')
      else s.stages.forEach((st: unknown, i: number) => {
        if (!isObj(st) || !isStr(st.phase) || !isNum(st.startEvent)) return err(`${p}.stages[${i}]`, 'expected {phase, startEvent, begin, end}')
        if (st.begin !== null) ref(`${p}.stages[${i}].begin`, st.begin)
        if (st.end !== null) ref(`${p}.stages[${i}].end`, st.end)
      })
    }
  }

  const voices = isObj(v.voices) ? v.voices : (err('voices', 'expected an object'), {})
  for (const [k, s] of Object.entries(voices)) {
    if (!isObj(s)) err(`voices.${k}`, 'expected a VoiceSet')
    else voiceSet(`voices.${k}`, s)
  }
  const mobs = isObj(v.mobs) ? v.mobs : (err('mobs', 'expected an object'), {})
  for (const [k, s] of Object.entries(mobs)) {
    const p = `mobs.${k}`
    if (!isObj(s)) {
      err(p, 'expected MobSounds')
      continue
    }
    voiceSet(p, s)
    refs(`${p}.walk`, s.walk)
    if (!isObj(s.attacks)) err(`${p}.attacks`, 'expected an object')
    else {
      for (const [a, rows] of Object.entries(s.attacks)) {
        if (!isObj(rows)) {
          err(`${p}.attacks.${a}`, 'expected an object')
          continue
        }
        for (const h of ['swing', 'shout', 'dmg']) if (rows[h] !== undefined) refs(`${p}.attacks.${a}.${h}`, rows[h])
      }
    }
  }

  const models = isObj(v.models) ? v.models : (err('models', 'expected an object'), {})
  for (const [k, url] of Object.entries(models)) {
    if (url !== `sound/model/${k}.json`) err(`models.${k}`, `expected 'sound/model/${k}.json'`)
  }

  const areas = isObj(v.areas) ? v.areas : (err('areas', 'expected an object'), {})
  for (const [k, a] of Object.entries(areas)) {
    const p = `areas.${k}`
    if (!isObj(a)) {
      err(p, 'expected an AreaSound')
      continue
    }
    if (!isStr(a.source)) err(`${p}.source`, 'expected a string')
    if (a.kind !== 'town' && a.kind !== 'field') err(`${p}.kind`, 'expected town or field')
    if (a.music !== null && !isStr(a.music)) err(`${p}.music`, 'expected a string or null')
    for (const part of ['day', 'night'] as const) {
      const layers = a[part]
      if (!Array.isArray(layers)) {
        err(`${p}.${part}`, 'expected an array')
        continue
      }
      layers.forEach((l: unknown, i: number) => {
        const lp = `${p}.${part}[${i}]`
        if (!isObj(l)) return err(lp, 'expected an AmbientLayer')
        ref(`${lp}.file`, l.file)
        if (typeof l.loop !== 'boolean') err(`${lp}.loop`, 'expected a boolean')
        if (!Array.isArray(l.everyS) || l.everyS.length !== 2 || !l.everyS.every(isNum) || l.everyS[0] > l.everyS[1]) {
          err(`${lp}.everyS`, 'expected [min, max]')
        }
      })
    }
    if (!Array.isArray(a.regions) || !a.regions.every(isNum)) err(`${p}.regions`, 'expected number[]')
  }

  const r = v.report
  if (!isObj(r)) err('report', 'expected an object')
  else {
    for (const k of ['sourceFiles', 'sourceBytes', 'outBytes', 'tracks']) if (!isNum(r[k])) err(`report.${k}`, 'expected a number')
    if (!Array.isArray(r.unresolved) || !r.unresolved.every(u => isObj(u) && isStr(u.path) && isStrArr(u.from))) {
      err('report.unresolved', 'expected {path, from[]}[]')
    }
    if (!isStrArr(r.notExported)) err('report.notExported', 'expected string[]')
  }
  return errors
}

/** Problems found in a sound/model/<code>.json file (empty = valid); `files` checks the ids when given. */
export function validateModelSounds(v: unknown, files?: Record<string, unknown>): string[] {
  const errors: string[] = []
  const err = (path: string, what: string) => {
    if (errors.length < 200) errors.push(`${path}: ${what}`)
  }
  if (!isObj(v)) return ['model: not an object']
  if (v.format !== SOUND_MODEL_FORMAT) err('format', `expected ${SOUND_MODEL_FORMAT}`)
  if (v.version !== 1) err('version', 'expected 1')
  if (!isStr(v.code)) err('code', 'expected a string')
  if (!isStr(v.bsr)) err('bsr', 'expected a string')
  if (!isObj(v.clips)) return (err('clips', 'expected an object'), errors)
  for (const [clip, tracks] of Object.entries(v.clips)) {
    if (!Array.isArray(tracks) || tracks.length === 0) {
      err(`clips.${clip}`, 'expected a non-empty array')
      continue
    }
    let last = -Infinity
    tracks.forEach((t: unknown, i: number) => {
      const p = `clips.${clip}[${i}]`
      if (!isObj(t)) return err(p, 'expected a ClipTrack')
      if (!isNum(t.ms) || t.ms < 0) err(`${p}.ms`, 'expected a number >= 0')
      else if (t.ms < last) err(`${p}.ms`, 'tracks not sorted by ms')
      else last = t.ms
      if (!SOUND_HANDLES.includes(t.handle as SoundHandle)) err(`${p}.handle`, 'bad handle')
      if (!isStr(t.raw)) err(`${p}.raw`, 'expected a string')
      if (!isStr(t.file)) err(`${p}.file`, 'expected a file id')
      else if (files && !(t.file in files)) err(`${p}.file`, `unknown file ${t.file}`)
    })
  }
  return errors
}
