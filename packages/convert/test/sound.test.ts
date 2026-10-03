/**
 * Sound export, synthetic (no game data): table parsers, the path resolver, handle/object helpers, the BSR clip join,
 * PCM trimming, hit-row parsing and the index assembly (docs/SOUND.md §6 lane 1).
 */
import { describe, expect, it } from 'vitest'
import { decodeTextdata, type BsrResource } from '@sro/formats'
import {
  SOUND_INDEX_FORMAT,
  STEP_SUFFIX,
  mobSoundObject,
  playerVoiceObject,
  soundHandle,
  validateModelSounds,
  validateSoundIndex,
  type SoundFile,
  type SoundIndex,
} from '../../shared/src/sound.ts'
import { finishModel, finishSoundIndex, planSoundIndex, surfaceOfDescription } from '../src/sound/build.ts'
import { EffectSoundTable, mergeEffectSound, parseEffectSound, parseHitRow, rowGain } from '../src/sound/effectsound.ts'
import { opusArgs } from '../src/sound/encode.ts'
import { parseEffectEnvSnd } from '../src/sound/envsnd.ts'
import { downmix, parseWav, pcmMs, trimTrailingSilence, writeWav16 } from '../src/sound/pcm.ts'
import { parseRegionInfo } from '../src/sound/regioninfo.ts'
import { SoundResolver, normalizeSoundPath } from '../src/sound/resolve.ts'
import { bsrSoundPaths, modelTracks } from '../src/sound/tracks.ts'

/** Tiny CP949 encoder for the few Hangul syllables these tests use (KS X 1001 codes); ASCII passes through. */
const CP949: Record<string, [number, number]> = {
  강: [0xb0, 0xad], 걷: [0xb0, 0xc8], 기: [0xb1, 0xe2], 낮: [0xb3, 0xb7], 닥: [0xb4, 0xda], 대: [0xb4, 0xeb], 드: [0xb5, 0xe5],
  바: [0xb9, 0xd9], 반: [0xb9, 0xdd], 밤: [0xb9, 0xe3], 안: [0xbe, 0xc8], 약: [0xbe, 0xe0], 일: [0xc0, 0xcf], 장: [0xc0, 0xe5],
  필: [0xc7, 0xca], 형: [0xc7, 0xfc], 흙: [0xc8, 0xeb],
}
function cp949(text: string): Uint8Array {
  const out: number[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code < 0x80) out.push(code)
    else {
      const b = CP949[ch]
      if (!b) throw new Error(`no CP949 code for ${ch} in the test table`)
      out.push(...b)
    }
  }
  return Uint8Array.from(out)
}

const row = (...cells: string[]) => ['', ...cells, ''].join('\t')

describe('effectsound.txt', () => {
  const text = [
    '//\tobject\thandle\tskill_ID\tevent1\tevent2\tevent3\tblank\tfolder\tfilename\tvolume\tdescription1\t',
    row('PLAYER', 'SND_WALK1', '-', 'FIELD', 'DIRT', '-', '0', 'player\\', 'mvWalkGround.wav', '80', '걷기 흙바닥'),
    '//' + row('PLAYER', 'SND_WALK1', '-', 'FIELD', 'SAND', '-', '0', 'player\\', 'mvWalkGravel.wav', '80', 'commented out'),
    row('UI', 'SND_BUTTON_CLICK', '-', '-', '-', '-', '0', 'ui\\', 'uibutton_a.wav', '80', 'click 1'),
    row('UI', 'SND_BUTTON_CLICK', '-', '-', '-', '-', '0', 'ui\\', 'uibutton_b.wav', '80', 'click 2'),
    row('PLAYER', 'SND_DMG', '-', 'PUNCH', '-', 'NORMAL', '0', 'player\\', 'batPunchHit1B.wav', '100', 'punch (강) / (대형)'),
    row('UI', 'SND_ODD', '-', '-', '-', '-', '0', 'ui\\', '-', '-', 'no wav: skipped'),
    '\t\t\t\t\t\t\t\t\t\t\t\t',
  ].join('\r\n')

  it('parses CP949 rows, skips comments and rows without a .wav, keeps duplicates', () => {
    const decoded = decodeTextdata(cp949(text))
    expect(decoded.encoding).toBe('cp949')
    const rows = parseEffectSound(decoded.text)
    expect(rows.map(r => r.handle)).toEqual(['SND_WALK1', 'SND_BUTTON_CLICK', 'SND_BUTTON_CLICK', 'SND_DMG'])
    const walk = rows[0]!
    expect(walk).toMatchObject({ object: 'PLAYER', skill: '', event1: 'FIELD', event2: 'DIRT', event3: '', file: 'player/mvWalkGround.wav', volume: 80, description: '걷기 흙바닥', line: 2 })
    expect(surfaceOfDescription(walk.description)).toBe('Dirt')
    expect(rows[3]!.description).toBe('punch (강) / (대형)')
    expect(new EffectSoundTable(rows).find('UI', { handle: 'SND_BUTTON_CLICK' }).map(r => r.file)).toEqual(['ui/uibutton_a.wav', 'ui/uibutton_b.wav'])
  })

  it('merges the copies with textdata winning per (object, handle, skill, event1..3)', () => {
    const td = parseEffectSound([
      row('MOB_MANGNYANG', 'VOC_MOAN', '-', 'NORMAL', '-', '-', '0', 'monster\\', 'cm_Mang_moan1.wav', '80', 'fixed'),
    ].join('\n'), 'textdata')
    const ri = parseEffectSound([
      row('MOB_MANGNYANG', 'VOC_MOAN', '-', 'NORMAL', '-', '-', '0', 'monster\\', 'cm_Mang_moan.wav', '80', 'old'),
      row('MOB_MANGNYANG', 'VOC_DEATH', '-', '-', '-', '-', '0', 'monster\\', 'cm_Mang_die.wav', '-', 'only here'),
    ].join('\n'), 'resinfo')
    const merged = mergeEffectSound(td, ri)
    expect(merged.map(r => `${r.handle}:${r.file}:${r.source}`)).toEqual([
      'VOC_MOAN:monster/cm_Mang_moan1.wav:textdata',
      'VOC_DEATH:monster/cm_Mang_die.wav:resinfo',
    ])
    expect(merged[1]!.volume).toBeNull()
    expect(rowGain(merged.slice(1))).toBe(1)
    expect(rowGain(td)).toBe(0.8)
  })

  it('reads hit strength and target class from the description, else the file name', () => {
    expect(parseHitRow({ description: '', file: 'player/batSwordHit2B.wav' })).toEqual({ strength: 'strong', cls: 'b' })
    expect(parseHitRow({ description: '', file: 'player/batBowHit1A.wav' })).toEqual({ strength: 'weak', cls: 'a' })
    // PUNCH: the strong rows reuse the Hit1 files; the description wins.
    expect(parseHitRow({ description: '펀치 타격 (강) / (일반)', file: 'player/batPunchHit1N.wav' })).toEqual({ strength: 'strong', cls: 'n' })
    expect(parseHitRow({ description: '비천일검 타격', file: 'skill/csk_sword_hit_c.wav' })).toBeNull()
  })
})

describe('effectenvsnd.txt and regioninfo.txt', () => {
  it('parses area blocks with loops and one-shot intervals', () => {
    const text = [
      '<1>\t장안\t\t\t\t',
      '\t"Jangan_Town.ogg"\t\t\t\t',
      '\t<2>\t낮\t\t\t',
      '\t\t\t<3>\t"day_wind.wav"\t0~0',
      '\t\t\t<3>\t"day_bird01.wav"  \t15~30',
      '\t\t\t\t\t',
      '\t<2>\t밤\t\t\t',
      '\t\t\t<3>\t"night_wind.wav"\t0~0',
      '<1>\t장안필드\t\t\t\t',
      '\t"Jangan_Field.ogg"\t\t\t\t',
    ].join('\r\n')
    const areas = parseEffectEnvSnd(decodeTextdata(cp949(text)).text)
    expect(areas.map(a => a.name)).toEqual(['장안', '장안필드'])
    expect(areas[0]).toMatchObject({
      music: 'Jangan_Town.ogg',
      day: [{ file: 'day_wind.wav', min: 0, max: 0 }, { file: 'day_bird01.wav', min: 15, max: 30 }],
      night: [{ file: 'night_wind.wav', min: 0, max: 0 }],
    })
    expect(areas[1]).toMatchObject({ music: 'Jangan_Field.ogg', day: [], night: [] })
  })

  it('parses #TOWN/#FIELD areas with ALL and RECT rows', () => {
    const areas = parseRegionInfo(['#TOWN\t장안\t\t', '168\t97\tALL\t\t', '169\t99\tRECT\t0\t220\t1720\t0\t', '', '#FIELD\t장안필드\tjangan', '182\t89\tALL'].join('\n'))
    expect(areas).toHaveLength(2)
    expect(areas[0]).toMatchObject({ kind: 'town', name: '장안', tag: '' })
    expect(areas[0]!.regions).toEqual([
      { x: 168, z: 97, mode: 'ALL', args: [], id: (97 << 8) | 168 },
      { x: 169, z: 99, mode: 'RECT', args: ['0', '220', '1720', '0'], id: (99 << 8) | 169 },
    ])
    expect(areas[1]).toMatchObject({ kind: 'field', name: '장안필드', tag: 'jangan' })
  })
})

describe('SoundResolver', () => {
  const r = new SoundResolver(['player/mvRunGround.wav', 'common/swordswing1.wav', 'player/twin.wav', 'monster/twin.wav', 'env/day_wind.wav'])

  it('resolves exact paths, a stray sound\\ prefix and a unique basename', () => {
    expect(normalizeSoundPath('prim\\snd\\Player\\mvRunGround.wav')).toBe('player/mvrunground.wav')
    expect(r.resolve('prim\\snd\\player\\mvrunground.wav', 'A')).toBe('player/mvrunground')
    expect(r.resolve('sound\\prim\\snd\\player\\MVRUNGROUND.WAV', 'A')).toBe('player/mvrunground')
    expect(r.resolve('prim\\snd\\swing\\swordswing1.wav', 'A')).toBe('common/swordswing1')
    expect(r.fixed.get('swing/swordswing1.wav')).toBe('common/swordswing1')
    expect(r.resolveIn('env', 'day_wind.wav', 'area')).toBe('env/day_wind')
  })

  it('reports ambiguous basenames and missing files as unresolved, with who referenced them', () => {
    expect(r.resolve('prim\\snd\\swing\\twin.wav', 'MOB_A')).toBeNull()
    expect(r.resolve('prim\\snd\\monster\\cm_mang_moan2.wav', 'MOB_B')).toBeNull()
    expect(r.resolve('prim\\snd\\monster\\cm_mang_moan2.wav', 'MOB_A')).toBeNull()
    expect(r.unresolved()).toEqual([
      { path: 'monster/cm_mang_moan2.wav', from: ['MOB_A', 'MOB_B'] },
      { path: 'swing/twin.wav', from: ['MOB_A'] },
    ])
  })
})

describe('handles and object names', () => {
  it('maps every BSR event name of §2.1, typos included', () => {
    const cases: Record<string, string> = {
      snd_walk: 'step_walk', snd_walk1: 'step_walk', snd_walk2: 'step_walk', snd_walk3: 'step_walk',
      snd_run: 'step_run', snd_run1: 'step_run', snd_run2: 'step_run', snd_run3: 'step_run',
      snd_swing1: 'swing', snd_swing2: 'swing', snd_swing3: 'swing', snd_swing4: 'swing', snd_swing_s: 'swing',
      snd_swing_s1: 'swing', snd_swing_s2: 'swing', snd_swing_1: 'swing', snd_swign1: 'swing', snd_swign2: 'swing',
      voc_shout: 'shout', voc_shout1: 'shout', voc_shout2: 'shout', voc_shot2: 'shout', snd_shout1: 'shout', snd_shout2: 'shout',
      voc_moan: 'moan', voc_moan1: 'moan', voc_moan2: 'moan',
      voc_death: 'death_voice', snd_death: 'death_thud', snd_death1: 'death_thud', snd_death2: 'death_thud',
      snd_blocking: 'block', snd_pickup: 'pickup', snd_stand: 'idle', snd_stand1: 'idle', snd_stand2: 'idle', snd_stand3: 'idle',
      voc_emo: 'emote', snd_find: 'alert', snd_helf: 'alert',
      '': 'other', snd_down: 'other', voc_down: 'other', whatever: 'other',
    }
    for (const [raw, handle] of Object.entries(cases)) expect(soundHandle(raw), raw).toBe(handle)
    expect(soundHandle(' SND_WALK1 ')).toBe('step_walk')
  })

  it('maps codes to effectsound objects', () => {
    expect(mobSoundObject('MOB_CH_MANGNYANG')).toBe('MOB_MANGNYANG')
    expect(mobSoundObject('MOB_WC_HYEONGCHEON')).toBe('MOB_HYEONGCHEON')
    expect(mobSoundObject('MOB_CH_TIGER_CLON')).toBe('MOB_TIGER')
    expect(mobSoundObject('MOB_CH_BIGEYEGHOST_L')).toBe('MOB_BIGEYEGHOST_L')
    expect(playerVoiceObject('CHAR_CH_MAN_ADVENTURER')).toBe('PCM_ADVENTURER')
    expect(playerVoiceObject('CHAR_CH_WOMAN_NECROMENCERB')).toBe('PCF_NECROMANCERB')
    expect(playerVoiceObject('CHAR_CH_WOMAN_NECROMENCERW')).toBe('PCF_NECROMANCERW')
    expect(playerVoiceObject('CHAR_EU_MAN_NOBLE')).toBeNull()
  })
})

// ---- synthetic BSR ----
type Track = { path: string; keyTimeMs: number; event: string } | null
const soundSet = (name: string, type: number, animationType: number, tracks: Track[], inner = 'default') => ({
  type,
  typeName: type === 0 ? 'LOCOMOTION' : 'SIMPLE',
  animationType,
  animationTypeName: undefined,
  name,
  mods: [{ kind: 'sound', sets: [{ name: inner, tracks }] }],
})
const fakeBsr = (systemSets: unknown[], aniSets: unknown[]) => ({ modPalette: { systemSets, aniSets } }) as unknown as BsrResource

describe('modelTracks', () => {
  const resolver = new SoundResolver(['player/mvrunground.wav', 'player/mvrunhground.wav', 'player/batswordswing1.wav', 'player/vcm_at_shout1_a.wav'])
  const bsr = fakeBsr(
    [soundSet('chinaman_fighter_runforward', 0, -1, [{ path: 'prim\\snd\\player\\mvrunhground.wav', keyTimeMs: 300, event: 'snd_run' }])],
    [
      soundSet('default', 1, 7, [
        { path: 'prim\\snd\\player\\mvrunground.wav', keyTimeMs: 619, event: 'snd_run1' },
        null,
        { path: 'prim\\snd\\player\\mvrunground.wav', keyTimeMs: 289, event: 'snd_run1' },
      ]),
      soundSet('sword', 1, 2, [
        { path: 'prim\\snd\\player\\vcm_at_shout1_a.wav', keyTimeMs: 186, event: 'voc_shout1' },
        { path: 'prim\\snd\\player\\batswordswing1.wav', keyTimeMs: 185, event: 'snd_swing1' },
        { path: 'prim\\snd\\player\\missing.wav', keyTimeMs: 500, event: 'snd_swing2' },
      ]),
    ],
  )

  it('prefers a LOCOMOTION set by BAN name over the aniSet by group + type, and sorts tracks', () => {
    const m = modelTracks('CHAR_X', 'res/char/x.bsr', bsr, [
      { name: 'RUN', group: 'default', type: 7, banName: 'chinaman_other_runforward' },
      { name: 'RUN_sword', group: 'sword', type: 7, banName: 'chinaman_fighter_runforward' },
      { name: 'ATTACK1_sword_base_01', group: 'sword', type: 2, banName: 'sword_attack01' },
      { name: 'STAND1', group: 'default', type: 0, banName: 'stand' },
    ], resolver)
    expect(m.clips.RUN).toEqual([
      { ms: 289, handle: 'step_run', raw: 'snd_run1', file: 'player/mvrunground' },
      { ms: 619, handle: 'step_run', raw: 'snd_run1', file: 'player/mvrunground' },
    ])
    expect(m.clips.RUN_sword).toEqual([{ ms: 300, handle: 'step_run', raw: 'snd_run', file: 'player/mvrunhground' }])
    expect(m.clips.ATTACK1_sword_base_01!.map(t => `${t.ms}:${t.handle}`)).toEqual(['185:swing', '186:shout'])
    expect(m.clips.STAND1).toBeUndefined()
    expect(resolver.unresolved()).toEqual([{ path: 'player/missing.wav', from: ['CHAR_X'] }])
    expect(validateModelSounds(m, Object.fromEntries(resolver.allIds().map(id => [id, 1])))).toEqual([])
    expect(bsrSoundPaths(bsr)).toHaveLength(5)
  })
})

describe('PCM', () => {
  const rate = 1000
  const sound = (lead: number, body: number, silence: number) => {
    const s = new Int16Array(lead + body + silence)
    for (let i = lead; i < lead + body; i++) s[i] = i % 2 ? 1000 : -1000
    return s
  }

  it('keeps leading silence and a 20 ms tail after the last sample above -60 dBFS', () => {
    const pcm = trimTrailingSilence({ sampleRate: rate, channels: [sound(100, 50, 500)] })
    expect(pcm.channels[0]!.length).toBe(100 + 50 + 20)
    expect(pcm.channels[0]![0]).toBe(0)
    expect(pcmMs(pcm)).toBe(170)
    // Quiet noise (|s| <= 32) counts as silence.
    const noisy = sound(0, 10, 100)
    noisy[80] = 32
    expect(trimTrailingSilence({ sampleRate: rate, channels: [noisy] }).channels[0]!.length).toBe(30)
  })

  it('round-trips 16-bit WAV, reads 8/24-bit, drops extra chunks and downmixes stereo', () => {
    const wav = writeWav16({ sampleRate: 22050, channels: [Int16Array.of(0, 100, -100), Int16Array.of(0, 300, -300)] })
    const back = parseWav(wav)
    expect(back.info).toMatchObject({ format: 1, channels: 2, sampleRate: 22050, bits: 16 })
    expect([...back.channels[1]!]).toEqual([0, 300, -300])
    expect([...downmix(back).channels[0]!]).toEqual([0, 200, -200])

    const mk = (bits: number, data: number[], extra = true) => {
      const body = Uint8Array.from(data)
      const list = extra ? [...'LIST'].map(c => c.charCodeAt(0)).concat([3, 0, 0, 0, 1, 2, 3, 0]) : []
      const out = new Uint8Array(12 + 24 + list.length + 8 + body.length)
      const dv = new DataView(out.buffer)
      out.set([...'RIFF'].map(c => c.charCodeAt(0)), 0)
      dv.setUint32(4, out.length - 8, true)
      out.set([...'WAVEfmt '].map(c => c.charCodeAt(0)), 8)
      dv.setUint32(16, 16, true)
      dv.setUint16(20, 1, true)
      dv.setUint16(22, 1, true)
      dv.setUint32(24, 11025, true)
      dv.setUint32(28, 11025 * (bits / 8), true)
      dv.setUint16(32, bits / 8, true)
      dv.setUint16(34, bits, true)
      out.set(list, 36)
      const d = 36 + list.length
      out.set([...'data'].map(c => c.charCodeAt(0)), d)
      dv.setUint32(d + 4, body.length, true)
      out.set(body, d + 8)
      return out
    }
    expect([...parseWav(mk(8, [128, 255, 0])).channels[0]!]).toEqual([0, 127 << 8, -128 << 8])
    expect([...parseWav(mk(24, [0x00, 0x34, 0x12, 0x00, 0x00, 0x80])).channels[0]!]).toEqual([0x1234, -32768])
    expect(() => parseWav(Uint8Array.of(1, 2, 3))).toThrow()
  })

  it('builds the §3 ffmpeg command', () => {
    expect(opusArgs('a.wav', 'b.ogg', 48, 1)).toEqual(['-v', 'error', '-y', '-i', 'a.wav', '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', '-application', 'audio', 'b.ogg'])
  })
})

describe('planSoundIndex / finishSoundIndex', () => {
  const rows = parseEffectSound([
    row('UI', 'SND_BUTTON_CLICK', '-', '-', '-', '-', '0', 'ui\\', 'uibutton_a.wav', '80', ''),
    row('UI', 'SND_BUTTON_CLICK', '-', '-', '-', '-', '0', 'ui\\', 'uibutton_b.wav', '80', ''),
    row('UI', 'SND_LEVUP', '-', 'CHINESS', '-', '-', '0', 'ui\\', 'itlevelup.wav', '80', ''),
    row('ITEM', 'SND_EQUIP', '-', 'SWORD', '-', '-', '0', 'ui\\', 'itSword.wav', '80', ''),
    row('ITEM', 'SND_DROPITEM', '-', 'GOLD', '-', '-', '0', 'ui\\', 'itGold.wav', '80', ''),
    row('PLAYER', 'SND_WALK1', '-', 'FIELD', 'DIRT', '-', '0', 'player\\', 'mvWalkGround.wav', '80', '걷기 흙바닥'),
    row('PLAYER', 'SND_RUN1', '-', 'FIELD', 'DIRT', '-', '0', 'player\\', 'mvWalkGround.wav', '80', '뛰기 흙바닥'),
    row('PLAYER', 'SND_RUN1', '-', 'FIELD', 'CLOUD', '-', '0', 'player\\', 'mvWalkSand.wav', '80', '뛰기 사막'),
    row('PLAYER', 'SND_CRIDMG', '-', '-', '-', '-', '0', 'player\\', 'batCriHit.wav', '100', ''),
    ...['1N', '1B', '1A'].flatMap(h => [
      row('PLAYER', 'SND_DMG', '-', 'PUNCH', '-', 'NORMAL', '0', 'player\\', `batPunchHit${h}.wav`, '100', `(약) / (${h[1] === 'N' ? '일반' : h[1] === 'B' ? '대형' : '갑옷'})`),
      row('PLAYER', 'SND_DMG', '-', 'PUNCH', '-', 'NORMAL', '0', 'player\\', `batPunchHit${h}.wav`, '100', `(강) / (${h[1] === 'N' ? '일반' : h[1] === 'B' ? '대형' : '갑옷'})`),
    ]),
    row('PLAYER', 'SND_SWING_S1', 'SKILL_CH_SWORD_SMASH_A', '-', '-', '-', '0', 'skill\\', 'csk_sword_swing_b.wav', '100', ''),
    row('PLAYER', 'SND_DMG', 'SKILL_CH_SWORD_SMASH_A', '-', '-', '-', '0', 'skill\\', 'csk_sword_hit_c.wav', '100', ''),
    row('PCM_ADVENTURER', 'VOC_MOAN', '-', 'NORMAL', '-', '-', '0', 'player\\', 'vcm_AT_moan1_a.wav', '100', ''),
    row('PCM_ADVENTURER', 'VOC_DEATH', '-', '-', '-', '-', '0', 'player\\', 'vcm_AT_die_a.wav', '100', ''),
    row('MOB_MANGNYANG', 'SND_WALK1', '-', '-', '-', '-', '0', 'monster\\', 'cm_Mang_walk.wav', '80', ''),
    row('MOB_MANGNYANG', 'SND_SWING1', 'MSKILL_CH_MANGNYANG_ATTACK01', '-', '-', '-', '0', 'player\\', 'batTSwordSwing2.wav', '80', ''),
    row('MOB_MANGNYANG', 'SND_DMG', 'MSKILL_CH_MANGNYANG_ATTACK01', '-', '-', '-', '0', 'player\\', 'batTSwordHit2N.wav', '80', ''),
  ].join('\n'))
  const files = [
    'ui/uibutton_a', 'ui/uibutton_b', 'ui/itlevelup', 'ui/itsword', 'ui/itgold', 'player/batcrihit',
    'player/mvwalkground', 'player/mvrunground', 'player/mvwalkgrass', 'player/mvrungrass', 'player/mvwalksand',
    'player/batpunchhit1n', 'player/batpunchhit1b', 'player/batpunchhit1a', 'skill/csk_sword_swing_b', 'skill/csk_sword_hit_c',
    'skill/csk_cold_ready', 'player/vcm_at_moan1_a', 'player/vcm_at_die_a', 'monster/cm_mang_walk', 'player/battswordswing2',
    'player/battswordhit2n', 'env/day_wind', 'env/day_bird01',
  ]
  const skillEffect = [
    '#section\tskilleffectset',
    ['x', 'SKILL_CH_COLD_GANGGI_A', 'READY', '0', ...Array(22).fill('none'), 'skill\\csk_cold_ready.wav', 'none'].join('\t'),
    ['-', 'SKILL_CH_COLD_GANGGI_A', 'SHOT', '0', ...Array(22).fill('none'), 'none', 'none'].join('\t'),
  ].join('\n')
  const make = () => {
    const resolver = new SoundResolver(files.map(f => `${f}.wav`))
    const bsr = fakeBsr([], [soundSet('default', 1, 4, [{ path: 'prim\\snd\\monster\\cm_mang_walk.wav', keyTimeMs: 0, event: 'snd_walk1' }])])
    const plan = planSoundIndex({
      scope: 'jangan',
      rows,
      envAreas: [
        { name: '장안', music: 'Jangan_Town.ogg', day: [{ file: 'day_wind.wav', min: 0, max: 0 }, { file: 'day_bird01.wav', min: 15, max: 30 }], night: [], line: 1 },
        { name: '장안필드', music: 'Jangan_Field.ogg', day: [{ file: 'day_wind.wav', min: 0, max: 0 }], night: [], line: 9 },
      ],
      regionAreas: [{ kind: 'town', name: '장안', tag: '', regions: [{ x: 168, z: 97, mode: 'ALL', args: [], id: (97 << 8) | 168 }], line: 1 }],
      skillEffectText: skillEffect,
      resolver,
      models: [{ code: 'MOB_CH_MANGNYANG', kind: 'mob', bsr: 'res/mob/china/mangnyang.bsr', res: bsr, clips: [{ name: 'DIE1', group: 'default', type: 4, banName: 'die' }] }],
      players: ['CHAR_CH_MAN_ADVENTURER'],
      mobs: [{ code: 'MOB_CH_MANGNYANG', skills: ['MSKILL_CH_MANGNYANG_ATTACK01'] }],
      skillGroups: ['SKILL_CH_SWORD_SMASH_A', 'SKILL_CH_COLD_GANGGI_A'],
      musicKeys: ['jangan_town'],
    })
    return { resolver, plan }
  }

  it('assembles cues, steps, hits, skills, voices, mobs, areas and models', () => {
    const { plan } = make()
    const idx = plan.index
    expect(idx.cues['ui.click']).toEqual({ files: ['ui/uibutton_a'], gain: 0.8, category: 'ui' })
    expect(idx.cues['ui.click2']!.files).toEqual(['ui/uibutton_b'])
    expect(idx.cues['ui.levelUp']!.files).toEqual(['ui/itlevelup'])
    expect(idx.cues['item.equip.SWORD']!.files).toEqual(['ui/itsword'])
    expect(idx.cues['item.dropGold']!.category).toBe('sfx')
    expect(idx.cues['hit.crit']!.files).toEqual(['player/batcrihit'])
    // Steps: rows first (desert row ignored), run rows take the mvrun* file, STEP_SUFFIX fills the rest when present.
    expect(idx.steps.walk.Dirt).toEqual(['player/mvwalkground'])
    expect(idx.steps.run.Dirt).toEqual(['player/mvrunground'])
    expect(idx.steps.walk.Grass).toEqual(['player/mvwalkgrass'])
    expect(idx.steps.run.Grass).toEqual(['player/mvrungrass'])
    expect(idx.steps.walk.Stone).toBeUndefined()
    expect(idx.steps.objectFloor).toBe('Stone')
    expect(STEP_SUFFIX.Wood[0]).toEqual(['hwood_a', 'hwood_b'])
    expect(plan.files.has('player/mvwalksand')).toBe(true) // every mv* file ships
    // PUNCH strong comes from the description.
    expect(idx.hits.PUNCH).toEqual({
      weak: { n: 'player/batpunchhit1n', b: 'player/batpunchhit1b', a: 'player/batpunchhit1a' },
      strong: { n: 'player/batpunchhit1n', b: 'player/batpunchhit1b', a: 'player/batpunchhit1a' },
      gain: 1,
    })
    expect(idx.skills.SKILL_CH_SWORD_SMASH_A).toEqual({ swing: { snd_swing_s1: ['skill/csk_sword_swing_b'] }, dmg: ['skill/csk_sword_hit_c'] })
    expect(idx.skills.SKILL_CH_COLD_GANGGI_A).toEqual({ stages: [{ phase: 'READY', startEvent: 0, begin: 'skill/csk_cold_ready', end: null }] })
    expect(idx.voices.CHAR_CH_MAN_ADVENTURER).toMatchObject({ object: 'PCM_ADVENTURER', moan: { normal: ['player/vcm_at_moan1_a'], crit: [] }, deathVoice: ['player/vcm_at_die_a'] })
    expect(idx.mobs.MOB_CH_MANGNYANG).toMatchObject({
      object: 'MOB_MANGNYANG',
      walk: ['monster/cm_mang_walk'],
      attacks: { MSKILL_CH_MANGNYANG_ATTACK01: { swing: ['player/battswordswing2'], dmg: ['player/battswordhit2n'] } },
    })
    expect(idx.areas.JANGAN_TOWN).toMatchObject({ source: '장안', kind: 'town', music: 'jangan_town', regions: [(97 << 8) | 168] })
    expect(idx.areas.JANGAN_TOWN!.day[0]).toEqual({ file: 'env/day_wind', loop: true, everyS: [0, 0] })
    expect(idx.areas.JANGAN_TOWN!.day[1]).toEqual({ file: 'env/day_bird01', loop: false, everyS: [15, 30] })
    expect(idx.areas.JANGAN_FIELD).toMatchObject({ kind: 'field', music: null })
    expect(plan.ambient.has('env/day_wind')).toBe(true)
    expect(idx.models).toEqual({ MOB_CH_MANGNYANG: 'sound/model/MOB_CH_MANGNYANG.json' })
    expect(plan.tracks).toBe(1)
  })

  it('finishes into a valid index, dropping references to files that were not exported', () => {
    const { plan, resolver } = make()
    const out: Record<string, SoundFile> = {}
    for (const id of plan.files) if (id !== 'player/vcm_at_die_a') out[id] = { url: `sound/${id}.ogg`, ms: 100, channels: 1, bytes: 10 }
    const idx = finishSoundIndex(plan, out, resolver, {
      codec: 'opus', wavFallback: false, generatedAt: 'now', sourceFiles: plan.files.size, sourceBytes: 1, outBytes: 1, notExported: ['player/vcm_at_die_a: test'],
    })
    expect(idx.format).toBe(SOUND_INDEX_FORMAT)
    expect(validateSoundIndex(idx)).toEqual([])
    expect(idx.voices.CHAR_CH_MAN_ADVENTURER!.deathVoice).toEqual([])
    const model = finishModel(plan.models[0]!, out)
    expect(validateModelSounds(model, out)).toEqual([])
  })

  it('validateSoundIndex reports broken references and shapes', () => {
    const bad = { format: SOUND_INDEX_FORMAT, version: 1, generator: 'x', generatedAt: 'y', codec: 'opus', wavFallback: false,
      files: { 'ui/a': { url: 'sound/ui/a.ogg', ms: 1, channels: 1, bytes: 1 }, 'UI/B.wav': { url: 'x', ms: -1, channels: 3, bytes: 0 } },
      cues: { 'ui.click': { files: ['ui/missing'], gain: 2, category: 'loud' } },
      steps: { walk: { Lava: ['ui/a'] }, run: {}, objectFloor: 'Stone' },
      hits: {}, skills: {}, voices: {}, mobs: {}, models: { X: 'wrong' }, areas: {},
      report: { sourceFiles: 0, sourceBytes: 0, outBytes: 0, tracks: 0, unresolved: [], notExported: [] },
    } as unknown as SoundIndex
    const problems = validateSoundIndex(bad).join('\n')
    for (const p of ['files.UI/B.wav', 'unknown file ui/missing', 'cues.ui.click.gain', 'cues.ui.click.category', 'steps.walk.Lava', 'models.X']) {
      expect(problems).toContain(p)
    }
    expect(validateSoundIndex(null)).toEqual(['index: not an object'])
  })
})
