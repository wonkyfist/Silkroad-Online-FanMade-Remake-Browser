/**
 * Sound runtime (docs/SOUND.md §5, §6 lane 2; WAVE_PLAN §4.9): settings, the clip-track driver, cue resolution,
 * the voice policy, ambience scheduling, the footstep surface probe (including a region that streamed out,
 * decision 51), the bank's cache and the GameAudio facade over a fake backend. Node only: no AudioContext, no DOM.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateModelSounds, validateSoundIndex, type AreaSound, type ClipTrack, type SoundIndex } from '@sro/shared'
import { AmbientPlayer, FLUSH_BIRD_FILES, FLUSH_GAP_S, type AmbientOutput } from '../src/audio/ambient.ts'
import type { AudioBackend, SoundBuffer, StartOptions, Vec3Like } from '../src/audio/backend.ts'
import { SoundBank, usableIndex, type FetchResponse } from '../src/audio/bank.ts'
import { ClipSoundDriver, type ClipCursor, type ClipCursors } from '../src/audio/clips.ts'
import { equipKind, hitClassOf, hitSound, mobAttackOf, pick, skillGroupOf, stepFile, trackFile, type TrackContext } from '../src/audio/cues.ts'
import { EntitySound, type SoundView } from '../src/audio/entity.ts'
import { GameAudio, resolveArea } from '../src/audio/index.ts'
import { AUDIO_DEFAULTS, AUDIO_SETTINGS_KEY, AudioSettings, MUTE_KEY, parseAudioLevels, type StorageLike } from '../src/audio/settings.ts'
import { SurfaceProbe, surfaceOfType, type SurfaceWorld } from '../src/audio/surface.ts'
import { clickCue } from '../src/audio/ui-sounds.ts'
import { VoicePolicy, type ActiveVoice, type VoiceRequest } from '../src/audio/voices.ts'

// ---- fixture index (a few entries of SOUND §4.3) ---------------------------------------------------------

const f = (id: string, ms = 300) => [id, { url: `sound/${id}.ogg`, ms, channels: 1 as const, bytes: 1000 }] as const
const FILES = [
  'player/mvwalkground', 'player/mvrunground', 'player/mvwalkhground', 'player/mvrunhground', 'player/mvwalkgrass', 'player/mvrungrass',
  'player/mvwalkmud', 'player/mvrunmud', 'player/batswordswing1', 'player/batswordswing2', 'player/batswordhit1n', 'player/batswordhit1b',
  'player/batswordhit2n', 'player/batswordhit2b', 'player/batpunchhit1n', 'player/batcrihit', 'player/batblock1', 'player/vcm_at_avoid_a',
  'player/vcm_at_moan1_c', 'player/battswordswing1', 'player/battswordhit2n', 'monster/cm_mang_walk', 'monster/cm_mang_shout',
  'monster/cm_mang_die', 'monster/cm_beye_thud', 'monster/cm_mang_moan1', 'skill/csk_sword_swing_a', 'skill/csk_sword_swing_b',
  'skill/csk_sword_hit_c', 'skill/csk_cold_ready', 'ui/uibutton_a', 'ui/itlevelup', 'ui/itpickup', 'ui/itgold', 'ui/itsword', 'ui/itmetal',
  'env/day_wind', 'env/day_bird01', 'env/day_bird02',
]
const JANGAN_TOWN: AreaSound = {
  source: '장안',
  kind: 'town',
  music: 'jangan_town',
  day: [
    { file: 'env/day_wind', loop: true, everyS: [0, 0] },
    { file: 'env/day_bird01', loop: false, everyS: [15, 30] },
    { file: 'env/day_bird02', loop: false, everyS: [10, 20] },
  ],
  night: [],
  regions: [24743],
}
const hitSet = (w: string, s: string, wb?: string, sb?: string) => ({ weak: { n: w, ...(wb ? { b: wb } : {}) }, strong: { n: s, ...(sb ? { b: sb } : {}) }, gain: 1 })

function fixtureIndex(): SoundIndex {
  return {
    format: 'sro-sound',
    version: 1,
    generator: 'test',
    generatedAt: '2026-09-28T00:00:00Z',
    codec: 'opus',
    wavFallback: false,
    files: Object.fromEntries(FILES.map(id => f(id))),
    cues: {
      'ui.click': { files: ['ui/uibutton_a'], gain: 0.8, category: 'ui' },
      'ui.levelUp': { files: ['ui/itlevelup'], gain: 0.8, category: 'ui' },
      'item.pickup': { files: ['ui/itpickup'], gain: 0.8, category: 'sfx' },
      'item.dropGold': { files: ['ui/itgold'], gain: 0.8, category: 'sfx' },
      'item.equip.SWORD': { files: ['ui/itsword'], gain: 1, category: 'ui' },
      'item.equip.METAL': { files: ['ui/itmetal'], gain: 1, category: 'ui' },
      'hit.crit': { files: ['player/batcrihit'], gain: 1, category: 'sfx' },
      'block.normal': { files: ['player/batblock1'], gain: 1, category: 'sfx' },
    },
    steps: {
      walk: { Dirt: ['player/mvwalkground'], Stone: ['player/mvwalkhground'], Grass: ['player/mvwalkgrass'], Water: ['player/mvwalkmud'], Mud: ['player/mvwalkmud'] },
      run: { Dirt: ['player/mvrunground'], Stone: ['player/mvrunhground'], Grass: ['player/mvrungrass'], Water: ['player/mvrunmud'], Mud: ['player/mvrunmud'] },
      objectFloor: 'Stone',
    },
    hits: {
      SWORD: hitSet('player/batswordhit1n', 'player/batswordhit2n', 'player/batswordhit1b', 'player/batswordhit2b'),
      PUNCH: hitSet('player/batpunchhit1n', 'player/batpunchhit1n'),
    },
    skills: {
      SKILL_CH_SWORD_BASE: { swing: { snd_swing1: ['player/batswordswing1', 'player/batswordswing2'] }, dmg: hitSet('player/batswordhit1n', 'player/batswordhit2n', 'player/batswordhit1b', 'player/batswordhit2b') },
      SKILL_CH_SWORD_SMASH_A: { swing: { snd_swing_s1: ['skill/csk_sword_swing_b'] }, dmg: ['skill/csk_sword_hit_c'] },
      SKILL_CH_COLD_GANGGI_A: { stages: [{ phase: 'READY', startEvent: 0, begin: 'skill/csk_cold_ready', end: null }] },
    },
    voices: {
      CHAR_CH_MAN_ADVENTURER: {
        object: 'PCM_ADVENTURER', moan: { normal: [], crit: ['player/vcm_at_moan1_c'] }, deathVoice: [], deathThud: [], shout1: [], shout2: [],
        avoid: ['player/vcm_at_avoid_a'], gain: 1,
      },
    },
    mobs: {
      MOB_CH_MANGNYANG: {
        object: 'MOB_MANGNYANG', moan: { normal: ['monster/cm_mang_moan1'], crit: ['monster/cm_mang_moan1'] }, deathVoice: ['monster/cm_mang_die'],
        deathThud: ['monster/cm_beye_thud'], shout1: [], shout2: [], avoid: [], gain: 0.8, walk: ['monster/cm_mang_walk'],
        attacks: {
          MSKILL_CH_MANGNYANG_ATTACK01: { swing: ['player/battswordswing1'], shout: ['monster/cm_mang_shout'], dmg: ['player/battswordhit2n'] },
          MSKILL_CH_MANGNYANG_ATTACK02: { dmg: ['player/batswordhit2n'] },
        },
      },
    },
    models: { MOB_CH_MANGNYANG: 'sound/model/MOB_CH_MANGNYANG.json' },
    areas: { JANGAN_TOWN, JANGAN_FIELD: { ...JANGAN_TOWN, source: '장안필드', kind: 'field', music: 'jangan_field' } },
    report: { sourceFiles: 1, sourceBytes: 1, outBytes: 1, tracks: 1, unresolved: [], notExported: [] },
  }
}

const MANG_MODEL = {
  format: 'sro-sound-model' as const,
  version: 1 as const,
  code: 'MOB_CH_MANGNYANG',
  bsr: 'res/mob/china/mangnyang.bsr',
  clips: {
    WALK: [{ ms: 254, handle: 'step_walk' as const, raw: 'snd_walk1', file: 'monster/cm_mang_walk' }],
    ATTACK1: [
      { ms: 603, handle: 'shout' as const, raw: 'voc_shout1', file: 'monster/cm_mang_shout' },
      { ms: 607, handle: 'swing' as const, raw: 'snd_swing1', file: 'player/battswordswing1' },
    ],
    DIE1: [
      { ms: 0, handle: 'death_voice' as const, raw: 'voc_death', file: 'monster/cm_mang_die' },
      { ms: 1503, handle: 'death_thud' as const, raw: 'snd_death', file: 'monster/cm_beye_thud' },
    ],
  },
}

const seq = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length]!
}

/** Seeded LCG in 0..1. */
function seeded(seed = 7): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// ---- settings ------------------------------------------------------------------------------------------

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>()
  getItem(k: string): string | null {
    return this.data.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v)
  }
}

describe('AudioSettings', () => {
  it('starts from the defaults and persists changes, clamped to 0..1', () => {
    const store = new MemoryStorage()
    const s = new AudioSettings(store)
    expect(s.get()).toEqual(AUDIO_DEFAULTS)
    expect(s.muted).toBe(false)
    const seen: number[] = []
    s.onChange(l => seen.push(l.sfx))
    s.set({ sfx: 1.7, ui: -3, music: Number.NaN, muteHidden: false })
    expect(s.get()).toMatchObject({ sfx: 1, ui: 0, music: AUDIO_DEFAULTS.music, muteHidden: false })
    expect(seen).toEqual([1])
    expect(JSON.parse(store.data.get(AUDIO_SETTINGS_KEY)!)).toMatchObject({ sfx: 1, ui: 0, muteHidden: false })
    // A new page reads them back.
    expect(new AudioSettings(store).get()).toEqual(s.get())
  })

  it('falls back per field on corrupt or partial JSON', () => {
    expect(parseAudioLevels('{nope')).toEqual(AUDIO_DEFAULTS)
    expect(parseAudioLevels('[1,2]')).toEqual(AUDIO_DEFAULTS)
    expect(parseAudioLevels(JSON.stringify({ master: 0.3, sfx: 'loud', ambient: 2, muteHidden: 'yes' }))).toEqual({ ...AUDIO_DEFAULTS, master: 0.3, ambient: 1 })
  })

  it('survives a storage that throws, and a missing one', () => {
    const throwing: StorageLike = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
    }
    const s = new AudioSettings(throwing)
    expect(s.get()).toEqual(AUDIO_DEFAULTS)
    s.set({ master: 0.5 })
    s.setMuted(true)
    expect(s.get().master).toBe(0.5)
    expect(s.muted).toBe(true)
    expect(new AudioSettings(null).get()).toEqual(AUDIO_DEFAULTS)
  })

  it("keeps the old 'sro.muted' master mute; ?mute=1 mutes without saving", () => {
    const store = new MemoryStorage()
    store.setItem(MUTE_KEY, '1')
    const s = new AudioSettings(store)
    expect(s.muted).toBe(true)
    expect(s.gain('sfx')).toBe(0)
    s.toggleMuted()
    expect(store.data.get(MUTE_KEY)).toBe('0')
    expect(s.gain('sfx')).toBeCloseTo(AUDIO_DEFAULTS.master * AUDIO_DEFAULTS.sfx)
    const forced = new AudioSettings(store, true)
    expect(forced.muted).toBe(true)
    expect(store.data.get(MUTE_KEY)).toBe('0')
  })
})

// ---- clip driver ---------------------------------------------------------------------------------------

const RUN: ClipTrack[] = [
  { ms: 289, handle: 'step_run', raw: 'snd_run1', file: 'player/mvrunground' },
  { ms: 619, handle: 'step_run', raw: 'snd_run1', file: 'player/mvrunground' },
]
const ATTACK: ClipTrack[] = [
  { ms: 185, handle: 'swing', raw: 'snd_swing1', file: 'player/batswordswing1' },
  { ms: 559, handle: 'swing', raw: 'snd_swing2', file: 'player/batswordswing2' },
]
const DIE: ClipTrack[] = [
  { ms: 0, handle: 'death_voice', raw: 'voc_death', file: 'monster/cm_mang_die' },
  { ms: 1503, handle: 'death_thud', raw: 'snd_death', file: 'monster/cm_beye_thud' },
]
const TRACKS: Record<string, ClipTrack[]> = { RUN, ATTACK1: ATTACK, DIE1: DIE }
const cur = (name: string, ms: number, run = 1, durationMs = name === 'RUN' ? 800 : name === 'DIE1' ? 1833 : 1133, silent?: true): ClipCursor => ({ name, ms, run, durationMs, ...(silent ? { silent } : {}) })
const top = (c: ClipCursor | null) => ({ top: c, overlay: null })
const ms = (t: ClipTrack[]) => t.map(x => x.ms)

describe('ClipSoundDriver', () => {
  it('fires the tracks crossed between polls', () => {
    const d = new ClipSoundDriver(n => TRACKS[n])
    expect(ms(d.update(top(cur('ATTACK1', 100)), 0))).toEqual([])
    expect(ms(d.update(top(cur('ATTACK1', 300)), 200))).toEqual([185])
    expect(ms(d.update(top(cur('ATTACK1', 600)), 500))).toEqual([559])
    expect(ms(d.update(top(cur('ATTACK1', 900)), 800))).toEqual([])
  })

  it('RUN at 289/619 fires twice per 800 ms loop, across the wrap', () => {
    const d = new ClipSoundDriver(n => TRACKS[n])
    let fired = 0
    for (let t = 0; t <= 3200; t += 16) fired += d.update(top(cur('RUN', t % 800)), t).length
    expect(fired).toBe(8)
    // An explicit wrap: tail of the last pass, then the head of this one.
    const w = new ClipSoundDriver(n => TRACKS[n])
    w.update(top(cur('RUN', 600)), 0)
    expect(ms(w.update(top(cur('RUN', 300)), 500))).toEqual([619, 289])
  })

  it('a new clip fires from its start; an action back to the base resumes the base from its start', () => {
    const d = new ClipSoundDriver(n => TRACKS[n])
    d.update(top(cur('RUN', 200)), 0)
    expect(ms(d.update(top(cur('ATTACK1', 190)), 16))).toEqual([185])
    expect(ms(d.update(top(cur('ATTACK1', 1100)), 950))).toEqual([559])
    expect(ms(d.update(top(cur('RUN', 300)), 966))).toEqual([289])
  })

  it('a restart of the same clip (new run) does not fire the tail of the aborted run', () => {
    const d = new ClipSoundDriver(n => TRACKS[n])
    d.update(top(cur('ATTACK1', 0, 1)), 0)
    expect(ms(d.update(top(cur('ATTACK1', 300, 1)), 300))).toEqual([185])
    // Restarted: the old run's 559 must not fire; the new run is at 100.
    expect(ms(d.update(top(cur('ATTACK1', 100, 2)), 400))).toEqual([])
    expect(ms(d.update(top(cur('ATTACK1', 400, 2)), 700))).toEqual([185])
  })

  it('a large jump (hidden tab) fires nothing', () => {
    const d = new ClipSoundDriver(n => TRACKS[n])
    d.update(top(cur('RUN', 100)), 0)
    expect(d.update(top(cur('RUN', 700)), 5000)).toEqual([])
    expect(ms(d.update(top(cur('RUN', 100)), 5016))).toEqual([])
    expect(ms(d.update(top(cur('RUN', 300)), 5216))).toEqual([289])
  })

  it('a silent DIE1 (arrived dead) fires nothing; a real death fires the cry and the thud', () => {
    const d = new ClipSoundDriver(n => TRACKS[n])
    expect(d.update(top(cur('DIE1', 0, 1, 1833, true)), 0)).toEqual([])
    expect(d.update(top(cur('DIE1', 1833, 1, 1833, true)), 90)).toEqual([])
    const e = new ClipSoundDriver(n => TRACKS[n])
    expect(ms(e.update(top(cur('DIE1', 10, 1, 1833)), 0))).toEqual([0])
    expect(ms(e.update(top(cur('DIE1', 1600, 1, 1833)), 1600))).toEqual([1503])
  })

  it('fire=false only syncs (coming back into range)', () => {
    const d = new ClipSoundDriver(n => TRACKS[n])
    expect(d.update(top(cur('RUN', 700)), 0, false)).toEqual([])
    expect(ms(d.update(top(cur('RUN', 100)), 200))).toEqual([])
    expect(ms(d.update(top(cur('RUN', 300)), 400))).toEqual([289])
  })

  it('the overlay layer (DAMAGE1) runs beside the top clip', () => {
    const moan: ClipTrack = { ms: 0, handle: 'moan', raw: 'voc_moan', file: 'monster/cm_mang_moan1' }
    const d = new ClipSoundDriver(n => (n === 'DAMAGE1' ? [moan] : TRACKS[n]))
    d.update(top(cur('RUN', 100)), 0)
    const out = d.update({ top: cur('RUN', 300), overlay: cur('DAMAGE1', 20, 1, 500) }, 200)
    expect(out.map(t => t.file)).toEqual(['player/mvrunground', 'monster/cm_mang_moan1'])
  })
})

// ---- cues ----------------------------------------------------------------------------------------------

describe('cue resolution', () => {
  const index = fixtureIndex()
  const run: ClipTrack = RUN[0]!

  it('swaps the neutral player footstep for the surface; mob walks keep their own file', () => {
    expect(stepFile(index, run, 'Stone')).toBe('player/mvrunhground')
    expect(stepFile(index, run, 'Grass')).toBe('player/mvrungrass')
    expect(stepFile(index, run, 'Water')).toBe('player/mvrunmud')
    expect(stepFile(index, { ms: 1, handle: 'step_walk', raw: 'snd_walk1', file: 'player/mvwalkground' }, 'Stone')).toBe('player/mvwalkhground')
    // A surface the index has no row for falls back to Dirt.
    expect(stepFile(index, run, 'Snow')).toBe('player/mvrunground')
    expect(stepFile(index, { ms: 254, handle: 'step_walk', raw: 'snd_walk1', file: 'monster/cm_mang_walk' }, 'Stone')).toBe('monster/cm_mang_walk')
  })

  it('picks hit sets: hit -> weak n, crit -> strong n + the crit layer, big mob -> b', () => {
    const sword = { kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER', family: 'sword' as const }
    const mang = { kind: 'mob', model: 'MOB_CH_MANGNYANG', radius: 0.6 }
    expect(hitSound(index, { attacker: sword, victim: mang, outcome: 'hit' })?.files).toEqual(['player/batswordhit1n'])
    expect(hitSound(index, { attacker: sword, victim: mang, outcome: 'crit' })?.files).toEqual(['player/batswordhit2n', 'player/batcrihit'])
    expect(hitSound(index, { attacker: sword, victim: { ...mang, radius: 1.5 }, outcome: 'hit' })?.files).toEqual(['player/batswordhit1b'])
    expect(hitClassOf({ kind: 'mob', rarity: 'giant' })).toBe('b')
    expect(hitClassOf({ kind: 'player', radius: 3 })).toBe('n')
    // The skill row wins over the weapon (row code -> group).
    expect(hitSound(index, { skill: 'SKILL_CH_SWORD_SMASH_A_01', attacker: sword, victim: mang, outcome: 'hit' })?.files).toEqual(['skill/csk_sword_hit_c'])
    // Block and miss.
    expect(hitSound(index, { attacker: sword, victim: mang, outcome: 'block' })?.files).toEqual(['player/batblock1'])
    expect(hitSound(index, { attacker: sword, victim: mang, outcome: 'miss' })).toBeNull()
    expect(hitSound(index, { attacker: null, victim: { kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER' }, outcome: 'miss' })?.files).toEqual(['player/vcm_at_avoid_a'])
  })

  it('mob attacks use their own rows by clip; unknown codes use the generic sets', () => {
    const victim = { kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER' }
    expect(mobAttackOf(index, 'MOB_CH_MANGNYANG', 'ATTACK2')).toBe('MSKILL_CH_MANGNYANG_ATTACK02')
    expect(hitSound(index, { attacker: { kind: 'mob', model: 'MOB_CH_MANGNYANG', clip: 'ATTACK1' }, victim, outcome: 'hit' })?.files).toEqual(['player/battswordhit2n'])
    expect(hitSound(index, { attacker: { kind: 'mob', model: 'MOB_CH_MANGNYANG', clip: 'ATTACK2' }, victim, outcome: 'hit' })?.files).toEqual(['player/batswordhit2n'])
    expect(hitSound(index, { attacker: { kind: 'mob', model: 'MOB_CH_NOBODY', clip: 'ATTACK1' }, victim, outcome: 'hit' })?.files).toEqual(['player/batpunchhit1n'])
    expect(hitSound(index, { attacker: { kind: 'player', model: 'CHAR_CH_X', family: null }, victim, outcome: 'hit' })?.files).toEqual(['player/batpunchhit1n'])
    expect(hitSound(index, { skill: 'SKILL_CH_UNKNOWN_A_01', attacker: { kind: 'player', model: 'CHAR_CH_X', family: 'sword' }, victim, outcome: 'hit' })?.files).toEqual(['player/batswordhit1n'])
  })

  it('the skill swing row replaces the clip file only while overriding', () => {
    const swing: ClipTrack = { ms: 415, handle: 'swing', raw: 'snd_swing_s1', file: 'skill/csk_sword_swing_a' }
    const ctx = (skill: string | null, overrideSwing: boolean): TrackContext => ({ surface: () => 'Dirt', skill, overrideSwing, rng: () => 0 })
    expect(trackFile(index, swing, ctx('SKILL_CH_SWORD_SMASH_A', true))).toBe('skill/csk_sword_swing_b')
    expect(trackFile(index, swing, ctx('SKILL_CH_SWORD_SMASH_A', false))).toBe('skill/csk_sword_swing_a')
    expect(trackFile(index, swing, ctx(null, true))).toBe('skill/csk_sword_swing_a')
    expect(trackFile(index, swing, ctx('SKILL_CH_NOPE', true))).toBe('skill/csk_sword_swing_a')
  })

  it('maps skill rows to groups and items to equip kinds', () => {
    expect(skillGroupOf('SKILL_CH_SWORD_SMASH_A_01')).toBe('SKILL_CH_SWORD_SMASH_A')
    expect(skillGroupOf('MSKILL_CH_MANGNYANG_ATTACK01')).toBe('MSKILL_CH_MANGNYANG_ATTACK01')
    expect(skillGroupOf(undefined)).toBeNull()
    expect(equipKind({ category: 'weapon', weaponType: 'glaive' })).toBe('TBLADE')
    expect(equipKind({ category: 'armor', slot: 'head', armorType: 'garment' })).toBe('CAP')
    expect(equipKind({ category: 'armor', slot: 'chest', armorType: 'armor' })).toBe('BREASTPLATE')
    expect(equipKind({ category: 'accessory', slot: 'ring' })).toBe('RING')
    expect(equipKind(undefined)).toBe('METAL')
    expect(pick([], () => 0)).toBeNull()
    expect(pick(['a', 'b'], () => 0.99)).toBe('b')
  })

  it('reads the click cue of a button', () => {
    const btn = (attrs: { sfx?: string; disabled?: boolean } = {}) => {
      const b = { dataset: attrs.sfx === undefined ? {} : { sfx: attrs.sfx }, disabled: !!attrs.disabled, getAttribute: () => null } as unknown as Element
      return { closest: () => b }
    }
    expect(clickCue(btn() as unknown as EventTarget)).toBe('ui.click')
    expect(clickCue(btn({ sfx: 'click2' }) as unknown as EventTarget)).toBe('ui.click2')
    expect(clickCue(btn({ sfx: 'none' }) as unknown as EventTarget)).toBeNull()
    expect(clickCue(btn({ disabled: true }) as unknown as EventTarget)).toBeNull()
    expect(clickCue({ closest: () => null } as unknown as EventTarget)).toBeNull()
    expect(clickCue(null)).toBeNull()
  })

  it('the fixture index is valid', () => {
    expect(validateSoundIndex(fixtureIndex())).toEqual([])
    expect(validateModelSounds(MANG_MODEL, fixtureIndex().files)).toEqual([])
    expect(usableIndex(fixtureIndex())).toBe(true)
    expect(usableIndex({ format: 'sro-sound' })).toBe(false)
    expect(resolveArea(fixtureIndex(), 'JANGAN_TOWN')?.[0]).toBe('JANGAN_TOWN')
    expect(resolveArea(fixtureIndex(), 'SOMEWHERE_FIELD')?.[1].kind).toBe('field')
  })
})

// ---- voices --------------------------------------------------------------------------------------------

describe('VoicePolicy', () => {
  const policy = new VoicePolicy()
  let nextId = 0
  const req = (o: Partial<VoiceRequest> = {}): VoiceRequest => ({ bus: 'sfx', file: `f${nextId}`, kind: 'other', priority: 0, distance: 10, self: false, ...o })
  const voice = (o: Partial<ActiveVoice> = {}): ActiveVoice => ({ ...req(), id: ++nextId, startedAt: 0, ...o })

  it('caps each bus and steals by priority, then distance, then age', () => {
    const ui = Array.from({ length: 4 }, (_, i) => voice({ bus: 'ui', file: `u${i}`, priority: 3, distance: 0, startedAt: i }))
    // A full UI bus: the new click takes the oldest one's place.
    const a = policy.admit(req({ bus: 'ui', file: 'u9', priority: 3, distance: 0 }), ui, 100)
    expect(a).toEqual({ ok: true, steal: [ui[0]!.id] })
    const sfx = Array.from({ length: 24 }, (_, i) => voice({ file: `s${i}`, priority: i === 5 ? 0 : 1, distance: i === 7 ? 30 : 5, startedAt: i }))
    // Lowest priority first.
    expect(policy.admit(req({ file: 'x', priority: 1, distance: 1 }), sfx, 100)).toEqual({ ok: true, steal: [sfx[5]!.id] })
    // Among equals, the farthest.
    const even = sfx.map(v => ({ ...v, priority: 1 }))
    expect(policy.admit(req({ file: 'x', priority: 1, distance: 1 }), even, 100)).toEqual({ ok: true, steal: [even[7]!.id] })
    // A sound ranking below everything playing is dropped.
    expect(policy.admit(req({ file: 'x', priority: 0, distance: 35 }), even, 100)).toEqual({ ok: false, reason: 'busy' })
  })

  it('the same file plays at most 4 times: the 5th steals the oldest', () => {
    const same = Array.from({ length: 4 }, (_, i) => voice({ file: 'hit', startedAt: 10 + i, entity: 100 + i }))
    expect(policy.admit(req({ file: 'hit' }), same, 200)).toEqual({ ok: true, steal: [same[0]!.id] })
  })

  it('one voice per entity: a new shout replaces the old one, nothing replaces a death cry', () => {
    const shout = voice({ entity: 7, kind: 'voice', file: 'shout' })
    expect(policy.admit(req({ entity: 7, kind: 'voice', file: 'moan' }), [shout], 500)).toEqual({ ok: true, steal: [shout.id] })
    const cry = voice({ entity: 7, kind: 'death', file: 'die' })
    expect(policy.admit(req({ entity: 7, kind: 'voice', file: 'moan' }), [cry], 500)).toEqual({ ok: false, reason: 'voice' })
    // Two sfx per entity: a third steals the older.
    const s1 = voice({ entity: 8, file: 'a', startedAt: 1 })
    const s2 = voice({ entity: 8, file: 'b', startedAt: 2 })
    expect(policy.admit(req({ entity: 8, file: 'c' }), [s1, s2], 500)).toEqual({ ok: true, steal: [s1.id] })
  })

  it('ignores a retrigger of the same file by the same entity within 60 ms', () => {
    const v = voice({ entity: 3, file: 'step', startedAt: 1000 })
    expect(policy.admit(req({ entity: 3, file: 'step' }), [v], 1040)).toEqual({ ok: false, reason: 'retrigger' })
    expect(policy.admit(req({ entity: 3, file: 'step' }), [v], 1070).ok).toBe(true)
  })

  it('culls by distance per kind, never your own sounds', () => {
    expect(policy.admit(req({ kind: 'step', distance: 21 }), [], 0)).toEqual({ ok: false, reason: 'culled' })
    expect(policy.admit(req({ kind: 'step', distance: 19 }), [], 0).ok).toBe(true)
    expect(policy.admit(req({ kind: 'idle', distance: 16 }), [], 0).ok).toBe(false)
    expect(policy.admit(req({ kind: 'voice', distance: 29 }), [], 0).ok).toBe(true)
    expect(policy.admit(req({ kind: 'voice', distance: 31 }), [], 0).ok).toBe(false)
    expect(policy.admit(req({ kind: 'other', distance: 41 }), [], 0).ok).toBe(false)
    expect(policy.admit(req({ kind: 'step', distance: 90, self: true }), [], 0).ok).toBe(true)
  })

  it('ambient: 5 one-shots beside the loop', () => {
    const loop = voice({ bus: 'ambient', loop: true, file: 'wind' })
    const shots = Array.from({ length: 5 }, (_, i) => voice({ bus: 'ambient', file: `bird${i}`, priority: 0, distance: 0, startedAt: i }))
    const a = policy.admit(req({ bus: 'ambient', file: 'bird9', priority: 0, distance: 0 }), [loop, ...shots], 100)
    expect(a).toEqual({ ok: true, steal: [shots[0]!.id] })
  })
})

// ---- ambience ------------------------------------------------------------------------------------------

class FakeAmbientOut implements AmbientOutput {
  t = 0
  loops: { file: string; stopped: boolean }[] = []
  shots: { file: string; at: number; gain: number; pan: number }[] = []
  loadable = true
  now(): number {
    return this.t
  }
  loop(file: string): { stop(): void } | null {
    if (!this.loadable) return null
    const l = { file, stopped: false }
    this.loops.push(l)
    return { stop: () => (l.stopped = true) }
  }
  oneShot(file: string, gain: number, pan: number): void {
    this.shots.push({ file, at: this.t, gain, pan })
  }
  spatial: { file: string; at: number; gain: number; pos: { x: number; y: number; z: number } }[] = []
  oneShotAt(file: string, gain: number, pos: { x: number; y: number; z: number }): void {
    this.spatial.push({ file, at: this.t, gain, pos })
  }
}

describe('AmbientPlayer', () => {
  it('starts the loop once and repeats one-shots inside everyS', () => {
    const out = new FakeAmbientOut()
    const amb = new AmbientPlayer(out, seeded(3))
    amb.setArea('JANGAN_TOWN', JANGAN_TOWN)
    amb.setArea('JANGAN_TOWN', JANGAN_TOWN)
    expect(out.loops.map(l => l.file)).toEqual(['env/day_wind'])
    for (const s of amb.schedule()) {
      const layer = JANGAN_TOWN.day.find(l => l.file === s.file)!
      expect(s.at).toBeGreaterThanOrEqual(layer.everyS[0])
      expect(s.at).toBeLessThanOrEqual(layer.everyS[1])
    }
    const last = new Map<string, number>()
    for (out.t = 0; out.t < 300; out.t += 0.25) {
      amb.tick()
      for (const s of out.shots.splice(0)) {
        const layer = JANGAN_TOWN.day.find(l => l.file === s.file)!
        const prev = last.get(s.file)
        if (prev !== undefined) {
          expect(s.at - prev).toBeGreaterThanOrEqual(layer.everyS[0] - 0.01)
          expect(s.at - prev).toBeLessThanOrEqual(layer.everyS[1] + 0.26)
        }
        expect(s.gain).toBeGreaterThanOrEqual(0.5)
        expect(Math.abs(s.pan)).toBeLessThanOrEqual(0.6)
        last.set(s.file, s.at)
      }
    }
    expect(last.size).toBe(2)
    expect(out.loops).toHaveLength(1)
  })

  it('an area change cancels the old timers; the same loop file carries on without a restart', () => {
    const out = new FakeAmbientOut()
    const amb = new AmbientPlayer(out, () => 0.5)
    amb.setArea('JANGAN_TOWN', JANGAN_TOWN)
    const field: AreaSound = { ...JANGAN_TOWN, kind: 'field', day: [JANGAN_TOWN.day[0]!, { file: 'env/day_bird02', loop: false, everyS: [10, 20] }] }
    out.t = 5
    amb.setArea('JANGAN_FIELD', field)
    expect(out.loops).toHaveLength(1)
    expect(out.loops[0]!.stopped).toBe(false)
    expect(amb.schedule()).toEqual([{ file: 'env/day_bird02', at: 20 }])
    amb.setArea(null, null)
    expect(out.loops[0]!.stopped).toBe(true)
    expect(amb.schedule()).toEqual([])
  })

  it('a flush plays one day bird one-shot at the flock, once per flush (GRASS_LIFE §5.3)', () => {
    const out = new FakeAmbientOut()
    const amb = new AmbientPlayer(out, seeded(7))
    expect(amb.flush({ x: 1, y: 2, z: 3 })).toBe(false)
    amb.setArea('JANGAN_TOWN', JANGAN_TOWN)
    out.t = 4
    expect(amb.flush({ x: 1, y: 2, z: 3 })).toBe(true)
    expect(out.spatial).toHaveLength(1)
    expect(out.spatial[0]!.pos).toEqual({ x: 1, y: 2, z: 3 })
    expect(['env/day_bird01', 'env/day_bird02']).toContain(out.spatial[0]!.file)
    expect(out.spatial[0]!.gain).toBeGreaterThanOrEqual(0.7)
    // A second flock flushing in the same burst shares the sound; the next flush plays its own.
    out.t += FLUSH_GAP_S / 2
    expect(amb.flush({ x: 5, y: 2, z: 3 })).toBe(false)
    out.t += FLUSH_GAP_S
    expect(amb.flush({ x: 5, y: 2, z: 3 })).toBe(true)
    expect(out.spatial).toHaveLength(2)
    expect(out.shots).toHaveLength(0)
    // An area without bird layers still sounds the retail day birds; leaving the world silences it.
    amb.setArea('BARE', { ...JANGAN_TOWN, day: [JANGAN_TOWN.day[0]!] })
    out.t += 1
    amb.flush({ x: 0, y: 0, z: 0 })
    expect(FLUSH_BIRD_FILES).toContain(out.spatial[2]!.file)
    amb.setArea(null, null)
    out.t += 1
    expect(amb.flush({ x: 0, y: 0, z: 0 })).toBe(false)
    expect(out.spatial).toHaveLength(3)
  })

  it('a flush is muted in rain like the area one-shots, and plays again after it', () => {
    const out = new FakeAmbientOut()
    const amb = new AmbientPlayer(out, () => 0.5)
    amb.setArea('JANGAN_TOWN', JANGAN_TOWN)
    amb.mute('weather', true)
    out.t = 2
    expect(amb.flush({ x: 0, y: 0, z: 0 })).toBe(false)
    expect(out.spatial).toHaveLength(0)
    amb.mute('weather', false)
    expect(amb.flush({ x: 0, y: 0, z: 0 })).toBe(true)
    expect(out.spatial).toHaveLength(1)
  })

  it('without a spatial output a flush plays centred', () => {
    const out = new FakeAmbientOut()
    const plain: AmbientOutput = { now: () => out.now(), loop: f => out.loop(f), oneShot: (f, g, p) => out.oneShot(f, g, p) }
    const amb = new AmbientPlayer(plain, () => 0.5)
    amb.setArea('JANGAN_TOWN', JANGAN_TOWN)
    expect(amb.flush({ x: 0, y: 0, z: 0 })).toBe(true)
    expect(out.shots).toEqual([{ file: 'env/day_bird02', at: 0, gain: 0.85, pan: 0 }])
  })

  it('retries a loop that is still loading', () => {
    const out = new FakeAmbientOut()
    out.loadable = false
    const amb = new AmbientPlayer(out, () => 0.5)
    amb.setArea('JANGAN_TOWN', JANGAN_TOWN)
    expect(out.loops).toHaveLength(0)
    out.loadable = true
    amb.tick()
    amb.tick()
    expect(out.loops).toHaveLength(1)
  })
})

// ---- surface probe --------------------------------------------------------------------------------------

/**
 * Synthetic 2 x 2 regions of 192 m (x 0..384, z 0..-384), flat terrain at y 10. Tile ids: 1 Grass, 2 Stone, 3 Water,
 * 4 without a type. Region (0,0) is Grass with a Stone vertex at grid (10, 10); (1,0) Water; (0,1) type-less; (1,1)
 * absent (not loaded, or streamed out).
 */
function syntheticWorld(): SurfaceWorld & { loaded: Set<string>; locates: number } {
  const regionTiles: Record<string, number> = { '0,0': 1, '1,0': 3, '0,1': 4 }
  const make = (tile: number) => {
    const textures = new Uint16Array(97 * 97).fill(tile | (2 << 13))
    if (tile === 1) textures[10 * 97 + 10] = 2
    return { terrain: { textures } }
  }
  const data = Object.fromEntries(Object.entries(regionTiles).map(([k, t]) => [k, make(t)]))
  const w = {
    loaded: new Set(Object.keys(regionTiles)),
    locates: 0,
    regions: {
      heightAt(x: number, z: number) {
        return w.regions.locate(x, z) ? 10 : null
      },
      locate(x: number, z: number) {
        w.locates++
        const rx = Math.floor(x / 192)
        const rz = Math.floor(-z / 192)
        const key = `${rx},${rz}`
        if (!w.loaded.has(key) || !data[key]) return null
        return { data: data[key]!, lx: (x - rx * 192) * 10, lz: (-z - rz * 192) * 10 }
      },
    },
    manifest: { tiles: [{ id: 1, typeName: 'Grass' }, { id: 2, typeName: 'STONE' }, { id: 3, typeName: 'water' }, { id: 4, typeName: null }] },
  }
  return w
}

describe('SurfaceProbe', () => {
  it('reads the tile type under the nearest terrain vertex', () => {
    const w = syntheticWorld()
    const p = new SurfaceProbe('Stone')
    expect(p.surfaceAt(w, 50, 10, -50)).toBe('Grass')
    // Vertex (10, 10) is 20 m east and 20 m south of the region corner (lz grows southward = -z).
    expect(p.surfaceAt(w, 20.4, 10, -19.7)).toBe('Stone')
    expect(p.surfaceAt(w, 250, 10, -50)).toBe('Water')
    expect(surfaceOfType('LONGGRASS')).toBe('LongGrass')
    expect(surfaceOfType('Lava')).toBeNull()
  })

  it('standing more than 0.25 m above the terrain is an object floor', () => {
    const w = syntheticWorld()
    const p = new SurfaceProbe('Stone')
    expect(p.surfaceAt(w, 50, 10.2, -50)).toBe('Grass')
    expect(p.surfaceAt(w, 50, 10.3, -50)).toBe('Stone')
    expect(new SurfaceProbe('Wood').surfaceAt(w, 50, 12, -50)).toBe('Wood')
  })

  it('a tile without a type, outside the world or without a world is Dirt', () => {
    const w = syntheticWorld()
    const p = new SurfaceProbe()
    expect(p.surfaceAt(w, 50, 10, -250)).toBe('Dirt')
    expect(p.surfaceAt(w, -5, 10, 5)).toBe('Dirt')
    expect(p.surfaceAt(null, 50, 10, -50)).toBe('Dirt')
  })

  it('a streamed-out region is Dirt, and no region is cached across calls (decision 51)', () => {
    const w = syntheticWorld()
    const p = new SurfaceProbe()
    expect(p.surfaceAt(w, 300, 10, -300)).toBe('Dirt') // (1,1) was never loaded
    expect(p.surfaceAt(w, 250, 10, -50)).toBe('Water')
    // The region streams out between two frames: the next lookup must not reuse it.
    w.loaded.delete('1,0')
    expect(p.surfaceAt(w, 250, 10, -50)).toBe('Dirt')
    // And back in.
    w.loaded.add('1,0')
    const before = w.locates
    expect(p.surfaceAt(w, 250, 10, -50)).toBe('Water')
    expect(w.locates).toBeGreaterThan(before)
  })

  it('a world whose lookups throw is Dirt', () => {
    const broken: SurfaceWorld = {
      regions: {
        heightAt() {
          throw new Error('region disposed')
        },
        locate: () => null,
      },
      manifest: { tiles: [] },
    }
    expect(new SurfaceProbe().surfaceAt(broken, 1, 1, 1)).toBe('Dirt')
  })
})

// ---- bank -----------------------------------------------------------------------------------------------

function fakeFetch(files: Record<string, unknown>, log: string[] = []) {
  let active = 0
  let peak = 0
  const fn = async (url: string): Promise<FetchResponse> => {
    log.push(url)
    active++
    peak = Math.max(peak, active)
    await new Promise(r => setTimeout(r, 1))
    active--
    const body = files[url]
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(8),
    }
  }
  return { fn, peak: () => peak }
}

const decoded = (bytes = 1000): SoundBuffer => ({ duration: 0.3, bytes })

describe('SoundBank', () => {
  it('loads each file once, caps concurrent fetches, and answers null for unknown or missing files', async () => {
    const index = fixtureIndex()
    const files: Record<string, unknown> = {}
    for (const f of Object.values(index.files)) files[`/out/${f.url}`] = 1
    delete files['/out/sound/ui/itgold.ogg']
    const log: string[] = []
    const ff = fakeFetch(files, log)
    let decodes = 0
    const bank = new SoundBank({ fetch: ff.fn, maxFetches: 3, decode: async () => (decodes++, decoded()) })
    bank.setIndex(index)
    const [a, b] = await Promise.all([bank.load('ui/uibutton_a'), bank.load('ui/uibutton_a')])
    expect(a).toBe(b)
    expect(decodes).toBe(1)
    expect(bank.get('ui/uibutton_a')).toBe(a)
    expect(await bank.load('nope/nothing')).toBeNull()
    expect(await bank.load('ui/itgold')).toBeNull()
    expect(await bank.load('ui/itgold')).toBeNull()
    expect(log.filter(u => u.endsWith('itgold.ogg'))).toHaveLength(1)
    await Promise.all(FILES.map(id => bank.load(id)))
    expect(ff.peak()).toBeLessThanOrEqual(3)
  })

  it('evicts the least recently used buffers over budget, never a playing one', async () => {
    const index = fixtureIndex()
    const files = Object.fromEntries(Object.values(index.files).map(f => [`/out/${f.url}`, 1]))
    const bank = new SoundBank({ fetch: fakeFetch(files).fn, budgetBytes: 2500, decode: async () => decoded(1000) })
    bank.setIndex(index)
    await bank.load('ui/uibutton_a')
    bank.retain('ui/uibutton_a')
    await bank.load('ui/itlevelup')
    await bank.load('ui/itpickup')
    await bank.load('ui/itgold')
    expect(bank.get('ui/uibutton_a')).not.toBeNull()
    expect(bank.get('ui/itlevelup')).toBeNull()
    expect(bank.stats().bytes).toBeLessThanOrEqual(2500)
    bank.release('ui/uibutton_a')
  })

  it('a missing index disables sound quietly; model files load once', async () => {
    const none = new SoundBank({ fetch: fakeFetch({}).fn, decode: async () => decoded() })
    expect(await none.loadIndex()).toBeNull()
    expect(await none.model('MOB_CH_MANGNYANG')).toBeNull()
    const index = fixtureIndex()
    const log: string[] = []
    const bank = new SoundBank({ fetch: fakeFetch({ '/out/sound/index.json': index, '/out/sound/model/MOB_CH_MANGNYANG.json': MANG_MODEL }, log).fn, decode: async () => decoded() })
    expect(await bank.loadIndex()).toEqual(index)
    const [m1, m2] = await Promise.all([bank.model('MOB_CH_MANGNYANG'), bank.model('MOB_CH_MANGNYANG')])
    expect(m1?.clips.ATTACK1).toHaveLength(2)
    expect(m2).toBe(m1)
    expect(bank.modelNow('MOB_CH_MANGNYANG')).toBe(m1)
    expect(await bank.model('CHAR_CH_NOBODY')).toBeNull()
    expect(log.filter(u => u.includes('model/'))).toHaveLength(1)
  })
})

// ---- GameAudio over a fake backend ------------------------------------------------------------------------

class FakeBackend implements AudioBackend {
  ready = true
  t = 0
  started: (StartOptions & { id: number; stopped: boolean; end: () => void })[] = []
  gains = new Map<string, number>()
  suspended = false
  listener: Vec3Like | null = null
  now(): number {
    return this.t
  }
  async decode(): Promise<SoundBuffer> {
    return decoded()
  }
  start(_b: SoundBuffer, opts: StartOptions) {
    const v = { ...opts, id: this.started.length, stopped: false, end: () => opts.onEnded?.() }
    this.started.push(v)
    return { stop: () => ((v.stopped = true), opts.onEnded?.()), setPosition: (p: Vec3Like) => (v.pos = p) }
  }
  setBusGain(bus: string, g: number): void {
    this.gains.set(bus, g)
  }
  setListener(pos: Vec3Like): void {
    this.listener = pos
  }
  suspend(): void {
    this.suspended = true
  }
  resume(): void {
    this.suspended = false
  }
}

async function readyAudio(opts: { muted?: boolean } = {}) {
  const backend = new FakeBackend()
  const store = new MemoryStorage()
  if (opts.muted) store.setItem(MUTE_KEY, '1')
  const index = fixtureIndex()
  const files: Record<string, unknown> = Object.fromEntries(Object.values(index.files).map(f => [`/out/${f.url}`, 1]))
  files['/out/sound/model/MOB_CH_MANGNYANG.json'] = MANG_MODEL
  let clock = 0
  const audio = new GameAudio({
    backend,
    settings: new AudioSettings(store),
    bank: new SoundBank({ fetch: fakeFetch(files).fn, decode: async () => decoded(2000) }),
    rng: () => 0,
    clock: () => clock,
  })
  audio.bank.setIndex(index)
  await Promise.all(FILES.map(id => audio.bank.load(id)))
  return { audio, backend, advance: (ms: number) => (clock += ms) }
}

describe('GameAudio', () => {
  it('plays cues on their bus; your own and UI sounds are non-spatial', async () => {
    const { audio, backend } = await readyAudio()
    audio.ui('ui.click')
    audio.play('item.dropGold', { pos: { x: 3, y: 0, z: 4 } })
    expect(backend.started.map(s => [s.bus, !!s.pos])).toEqual([['ui', false], ['sfx', true]])
    expect(backend.started[0]!.gain).toBeCloseTo(0.8 * 0.9)
    expect(backend.gains.get('master')).toBe(AUDIO_DEFAULTS.master)
  })

  it('stays silent without an index, while muted, while hidden, and for files not loaded yet', async () => {
    const { audio, backend } = await readyAudio({ muted: true })
    audio.ui('ui.click')
    expect(backend.started).toHaveLength(0)
    expect(backend.gains.get('master')).toBe(0)
    audio.settings.setMuted(false)
    expect(backend.gains.get('master')).toBe(AUDIO_DEFAULTS.master)
    audio.setHidden(true)
    expect(backend.suspended).toBe(true)
    audio.ui('ui.click')
    expect(backend.started).toHaveLength(0)
    audio.setHidden(false)
    expect(backend.suspended).toBe(false)
    audio.playFile('env/not_in_index', {})
    expect(backend.started).toHaveLength(0)
    const bare = new GameAudio({ backend: new FakeBackend(), settings: new AudioSettings(null), bank: new SoundBank({ fetch: fakeFetch({}).fn, decode: async () => decoded() }) })
    expect(() => {
      bare.ui('ui.click')
      bare.setArea('JANGAN_TOWN')
      bare.hit({ attacker: null, victim: { kind: 'mob', model: 'X' }, outcome: 'crit' }, { entity: 1, self: false, priority: 0 })
      bare.tick()
    }).not.toThrow()
  })

  it('does not suspend a hidden tab when muteHidden is off', async () => {
    const { audio, backend } = await readyAudio()
    audio.settings.set({ muteHidden: false })
    audio.setHidden(true)
    expect(backend.suspended).toBe(false)
  })

  it('hit plays the impact and the crit layer at the victim; a player victim also cries out on a crit', async () => {
    const { audio, backend } = await readyAudio()
    audio.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
    audio.hit(
      { attacker: { kind: 'mob', model: 'MOB_CH_MANGNYANG', clip: 'ATTACK1' }, victim: { kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER' }, outcome: 'crit' },
      { entity: 5, pos: { x: 0, y: 1, z: 0 }, self: true, priority: 3 },
    )
    expect(backend.started.map(s => s.pos)).toEqual([undefined, undefined, undefined])
    expect(backend.started).toHaveLength(3)
  })

  it('area ambience starts its loop and crossfades nothing when the loop file stays the same', async () => {
    const { audio, backend } = await readyAudio()
    audio.setArea('JANGAN_TOWN')
    audio.tick()
    audio.setArea('JANGAN_FIELD')
    audio.tick()
    const loops = backend.started.filter(s => s.loop)
    expect(loops).toHaveLength(1)
    expect(loops[0]!.bus).toBe('ambient')
    audio.setArea(null)
    expect(loops[0]!.stopped).toBe(true)
  })

  it('a flush plays on the ambient bus at the flock; the weather mutes it in rain', async () => {
    const { audio, backend } = await readyAudio()
    audio.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
    audio.setArea('JANGAN_FIELD')
    // The weather's rain mute (WeatherAudio muteBirds) silences the flush too.
    audio.ambient.mute('weather', true)
    audio.ambient.flush({ x: 4, y: 0, z: 6 })
    expect(backend.started.filter(s => !s.loop)).toHaveLength(0)
    audio.ambient.mute('weather', false)
    audio.ambient.flush({ x: 4, y: 0, z: 6 })
    const birds = backend.started.filter(s => !s.loop)
    expect(birds).toHaveLength(1)
    expect(birds[0]!.bus).toBe('ambient')
    expect(birds[0]!.pos).toEqual({ x: 4, y: 0, z: 6 })
  })

  it('equip plays the item kind, falling back to METAL', async () => {
    const backend = new FakeBackend()
    const audio = new GameAudio({
      backend,
      settings: new AudioSettings(null),
      bank: new SoundBank({ fetch: fakeFetch(Object.fromEntries(Object.values(fixtureIndex().files).map(f => [`/out/${f.url}`, 1]))).fn, decode: async () => decoded() }),
      itemDef: code => (code === 'ITEM_CH_SWORD_01_A' ? ({ category: 'weapon', weaponType: 'sword' } as never) : undefined),
    })
    audio.bank.setIndex(fixtureIndex())
    await Promise.all(['ui/itsword', 'ui/itmetal'].map(id => audio.bank.load(id)))
    audio.equip([undefined, 'ITEM_CH_SWORD_01_A'])
    audio.equip(['ITEM_CH_HAT_X'])
    expect(backend.started).toHaveLength(2)
  })

  it('skill stages play once per entity even when a clip track names the same file', async () => {
    const { audio, backend } = await readyAudio()
    expect(audio.skillStage('SKILL_CH_COLD_GANGGI_A', 'READY', { entity: 9, self: true })).toBe(true)
    expect(audio.skillStage('SKILL_CH_COLD_GANGGI_A', 'READY', { entity: 9, self: true })).toBe(true)
    expect(backend.started).toHaveLength(1)
    expect(audio.skillStage('SKILL_CH_COLD_GANGGI_A', 'SHOT', { entity: 9, self: true })).toBe(false)
  })
})

// ---- EntitySound -----------------------------------------------------------------------------------------

describe('EntitySound', () => {
  type TestView = SoundView & { position: Vec3Like; deadNow: boolean }
  const view = (o: { kind?: SoundView['kind']; model?: string; isSelf?: boolean; dead?: boolean; cursors?: () => ClipCursors }): TestView => {
    const v: TestView = {
      id: 42,
      kind: o.kind ?? 'mob',
      state: { model: o.model ?? 'MOB_CH_MANGNYANG' },
      position: { x: 5, y: 10, z: 0 },
      deadNow: !!o.dead,
      isSelf: !!o.isSelf,
      get root() {
        return { position: v.position }
      },
      get dead() {
        return v.deadNow
      },
      actor: o.cursors ? { clipCursors: o.cursors } : null,
    }
    return v
  }

  it('plays clip tracks at the entity, with surface footsteps for players and a 40 m polling range', async () => {
    const { audio, backend } = await readyAudio()
    await audio.bank.model('MOB_CH_MANGNYANG')
    audio.setListener({ x: 0, y: 8.4, z: 0 }, { x: 0, y: 0, z: 1 })
    let c: ClipCursor = cur('ATTACK1', 500, 1, 1666)
    const v = view({ cursors: () => top(c) })
    const s = new EntitySound(audio, v)
    s.update(0)
    c = cur('ATTACK1', 700, 1, 1666)
    s.update(200)
    expect(backend.started.map(x => !!x.pos)).toEqual([true, true])
    // Out of range: nothing, and coming back does not replay what was skipped.
    v.position = { x: 60, y: 10, z: 0 }
    c = cur('ATTACK1', 100, 2, 1666)
    s.update(400)
    v.position = { x: 5, y: 10, z: 0 }
    c = cur('ATTACK1', 650, 2, 1666)
    s.update(900)
    expect(backend.started).toHaveLength(2)
  })

  it('swaps player footsteps by the surface the host reports', async () => {
    const { audio, backend } = await readyAudio()
    const index = audio.index!
    index.models.CHAR_CH_MAN_ADVENTURER = 'sound/model/CHAR_CH_MAN_ADVENTURER.json'
    Object.assign(audio, { surfaceAt: () => 'Stone' })
    const bank = audio.bank as unknown as { models: Map<string, unknown> }
    bank.models.set('CHAR_CH_MAN_ADVENTURER', { format: 'sro-sound-model', version: 1, code: 'CHAR_CH_MAN_ADVENTURER', bsr: 'x', clips: { RUN } })
    let c = cur('RUN', 100)
    const v = view({ kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER', isSelf: true, cursors: () => top(c) })
    const s = new EntitySound(audio, v)
    s.update(0)
    c = cur('RUN', 300)
    s.update(200)
    expect(backend.started).toHaveLength(1)
    expect(backend.started[0]!.pos).toBeUndefined()
    const played = (audio as unknown as { voices: { file: string }[] }).voices.map(x => x.file)
    expect(played).toEqual(['player/mvrunhground'])
  })

  it('a model without DIE1 tracks falls back to the mob death cry and a later thud; arriving dead stays quiet', async () => {
    const { audio, backend } = await readyAudio()
    const bank = audio.bank as unknown as { models: Map<string, unknown> }
    bank.models.set('MOB_CH_MANGNYANG', null)
    audio.setListener({ x: 0, y: 8.4, z: 0 }, { x: 0, y: 0, z: 1 })
    const v = view({})
    const s = new EntitySound(audio, v)
    s.update(0)
    v.deadNow = true
    s.update(100)
    expect(backend.started).toHaveLength(1)
    s.update(1700)
    expect(backend.started).toHaveLength(2)
    const corpse = view({ dead: true })
    const quiet = new EntitySound(audio, corpse)
    quiet.update(0)
    quiet.update(2000)
    expect(backend.started).toHaveLength(2)
  })
})

// ---- the real export (skips without work/out/sound/index.json) --------------------------------------------

const REAL = new URL('../../../work/out/sound/index.json', import.meta.url)
describe.skipIf(!existsSync(REAL))('the exported sound index', () => {
  const index = JSON.parse(readFileSync(REAL, 'utf8')) as SoundIndex

  it('is usable by the runtime and resolves the SOUND §2.7 examples', () => {
    expect(usableIndex(index)).toBe(true)
    for (const cue of ['ui.click', 'ui.windowOpen', 'ui.windowClose', 'ui.error', 'ui.levelUp', 'item.pickup', 'item.dropGold', 'hit.crit', 'ui.potion']) expect(index.cues[cue], cue).toBeTruthy()
    const run: ClipTrack = { ms: 289, handle: 'step_run', raw: 'snd_run1', file: 'player/mvrunground' }
    expect(stepFile(index, run, 'Stone')).toBe('player/mvrunhground')
    expect(stepFile(index, run, 'Grass')).toBe('player/mvrungrass')
    const blade = { kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER', family: 'blade' as const }
    const mang = { kind: 'mob', model: 'MOB_CH_MANGNYANG', radius: 0.6 }
    expect(hitSound(index, { attacker: blade, victim: mang, outcome: 'hit' })?.files).toEqual(['player/batswordhit1n'])
    expect(hitSound(index, { attacker: blade, victim: mang, outcome: 'crit' })?.files).toEqual(['player/batswordhit2n', 'player/batcrihit'])
    expect(hitSound(index, { skill: 'SKILL_CH_SWORD_SMASH_A_01', attacker: blade, victim: mang, outcome: 'hit' })?.files).toEqual(['skill/csk_sword_hit_c'])
    expect(hitSound(index, { attacker: { kind: 'mob', model: 'MOB_CH_MANGNYANG', clip: 'ATTACK1' }, victim: { kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER' }, outcome: 'hit' })?.files).toEqual(['player/battswordhit2n'])
    expect(resolveArea(index, 'JANGAN_TOWN')?.[1].day.some(l => l.loop)).toBe(true)
    expect(resolveArea(index, 'JANGAN_FIELD')?.[1].day.some(l => l.loop)).toBe(true)
  })
})

// ---- WebAudioBackend over a stub AudioContext (graph wiring, z flip, both listener APIs) -------------------

describe('WebAudioBackend', () => {
  class Param {
    value = 0
    events: string[] = []
    setValueAtTime(v: number) {
      this.value = v
    }
    linearRampToValueAtTime(v: number) {
      this.events.push(`ramp ${v}`)
    }
    setTargetAtTime(v: number) {
      this.value = v
    }
    cancelScheduledValues() {}
  }
  class Node {
    out: Node[] = []
    connect(n: Node) {
      this.out.push(n)
      return n
    }
    disconnect() {
      this.out = []
    }
  }
  class Gain extends Node {
    gain = new Param()
  }
  class Panner extends Node {
    positionX = new Param()
    positionY = new Param()
    positionZ = new Param()
    panningModel = ''
    distanceModel = ''
    refDistance = 0
    rolloffFactor = 0
    maxDistance = 0
  }
  class Stereo extends Node {
    pan = new Param()
  }
  class Source extends Node {
    buffer: unknown = null
    loop = false
    onended: (() => void) | null = null
    started = false
    stopAt = -1
    start() {
      this.started = true
    }
    stop(t: number) {
      this.stopAt = t
    }
  }
  const made: Record<string, Node[]> = {}
  const track = <T extends Node>(kind: string, n: T) => ((made[kind] ??= []).push(n), n)
  class Ctx {
    static instances: Ctx[] = []
    currentTime = 1
    state = 'suspended'
    destination = new Node()
    listener: Record<string, unknown>
    constructor() {
      Ctx.instances.push(this)
      this.listener = legacyListener ? { setPosition: (...a: number[]) => (this.listener.pos = a), setOrientation: (...a: number[]) => (this.listener.ori = a) } : Object.fromEntries(['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].map(k => [k, new Param()]))
    }
    createGain() {
      return track('gain', new Gain())
    }
    createPanner() {
      return track('panner', new Panner())
    }
    createStereoPanner() {
      return track('stereo', new Stereo())
    }
    createBufferSource() {
      return track('source', new Source())
    }
    async decodeAudioData() {
      return { duration: 0.5, length: 24000, numberOfChannels: 1 }
    }
    async resume() {
      this.state = 'running'
    }
    async suspend() {
      this.state = 'suspended'
    }
  }
  let legacyListener = false

  it('builds the bus graph on unlock, flips z for panners and the listener, fades on stop', async () => {
    const g = globalThis as unknown as { window?: unknown }
    const had = 'window' in g
    const prev = g.window
    g.window = { AudioContext: Ctx }
    try {
      const { WebAudioBackend } = await import('../src/audio/backend.ts')
      const b = new WebAudioBackend()
      b.setBusGain('sfx', 0.5)
      const pendingDecode = b.decode(new ArrayBuffer(4))
      expect(b.ready).toBe(false)
      expect(b.unlock()).toBe(true)
      const buf = await pendingDecode
      expect(buf.bytes).toBe(24000 * 4)
      const ctx = Ctx.instances.at(-1)!
      // master + 3 buses, with the gain set before the context existed.
      expect(made.gain!.slice(-4).map(x => (x as Gain).gain.value)).toEqual([1, 0.5, 1, 1])
      const v = b.start(buf, { bus: 'sfx', gain: 0.7, pos: { x: 1, y: 2, z: 3 } })!
      const p = made.panner!.at(-1) as Panner
      expect([p.positionX.value, p.positionY.value, p.positionZ.value]).toEqual([1, 2, -3])
      expect(p.distanceModel).toBe('inverse')
      v.setPosition({ x: 4, y: 0, z: 5 })
      expect(p.positionZ.value).toBe(-5)
      v.stop(0.05)
      const src = made.source!.at(-1) as Source
      expect(src.started).toBe(true)
      expect(src.stopAt).toBeCloseTo(1.06)
      b.start(buf, { bus: 'ambient', gain: 0.4, pan: -0.5 })
      expect((made.stereo!.at(-1) as Stereo).pan.value).toBe(-0.5)
      b.setListener({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 2 })
      const l = ctx.listener as Record<string, Param>
      expect([l.positionZ!.value, l.forwardZ!.value]).toEqual([-3, -1])
      b.suspend()
      expect(ctx.state).toBe('suspended')
      legacyListener = true
      const b2 = new WebAudioBackend()
      b2.unlock()
      b2.setListener({ x: 1, y: 2, z: 3 }, { x: 1, y: 0, z: 0 })
      expect(Ctx.instances.at(-1)!.listener.pos).toEqual([1, 2, -3])
      expect(Ctx.instances.at(-1)!.listener.ori).toEqual([1, 0, -0, 0, 1, 0])
    } finally {
      if (had) g.window = prev
      else delete g.window
    }
  })
})
