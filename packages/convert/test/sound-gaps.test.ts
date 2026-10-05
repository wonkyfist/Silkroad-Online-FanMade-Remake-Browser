/**
 * docs/SOUND.md §10 (the missing-sound pass), export side:
 * - the resolver's retail path fixes (typos and renamed files) map to the files the folder has, and only when the
 *   target exists;
 * - the plan writes the Berserk ('hwan') rows as `swing.hwan.<WEAPON>`, `hit.hwan`, `hit.hwanCrit` (not the old
 *   `*.imbue` names), the imbue skills' SND_DMG rows, the shield buffs' SND_DDMG, and the QUICKSLOT equip cue whose
 *   retail file name is misspelled;
 * - the real export (skips without work/out/sound/index.json) has those cues with files on disk.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SoundIndex } from '../../shared/src/sound.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { planSoundIndex } from '../src/sound/build.ts'
import { parseEffectSound } from '../src/sound/effectsound.ts'
import { RETAIL_PATH_FIXES, SoundResolver } from '../src/sound/resolve.ts'

const row = (...cells: string[]) => ['', ...cells, ''].join('\t')

describe('retail path fixes', () => {
  const r = new SoundResolver([
    'ui/itQuickIcon.wav', 'player/mvRunGround.wav', 'skill/csk_bow_swing.wav', 'monster/wcm_jombie_walk.wav', 'monster/wcm_hchen_moan1_a.wav',
    'monster/cm_yeoha_die.wav', 'monster/cara_bunwang_shout.wav', 'monster/cm_mang_moan1.wav',
  ])

  it('maps each known defect to the file that exists', () => {
    expect(r.resolve('ui\\itQuckicon.wav', 'effectsound ITEM SND_EQUIP')).toBe('ui/itquickicon')
    expect(r.resolve('prim\\snd\\player\\mvfrunground.wav', 'MOB_WC_EARTHGHOST')).toBe('player/mvrunground')
    expect(r.resolve('prim\\snd\\skill\\csk_bow_swing_a.wav', 'CHAR')).toBe('skill/csk_bow_swing')
    expect(r.resolve('skill\\csk_bow_swing_b.wav', 'effectsound')).toBe('skill/csk_bow_swing')
    expect(r.resolve('prim\\snd\\monster\\wchina_jombie_walk.wav', 'MOB_WC_HYUNGNO')).toBe('monster/wcm_jombie_walk')
    expect(r.resolve('prim\\snd\\monster\\wcm_hchen_moan1.wav', 'MOB_WC_HYEONGCHEON')).toBe('monster/wcm_hchen_moan1_a')
    expect(r.resolve('prim\\snd\\monster\\cm_yeoha_die_a.wav', 'MOB_CH_YEOHA')).toBe('monster/cm_yeoha_die')
    expect(r.resolve('prim\\snd\\monster\\cara_bunwang_shout1.wav', 'MOB_WC_HYUNGNO')).toBe('monster/cara_bunwang_shout')
    expect(r.resolve('prim\\snd\\monster\\cm_mang_moan2.wav', 'MOB_CH_MANGNYANG')).toBe('monster/cm_mang_moan1')
    expect(r.fixed.get('ui/itquckicon.wav')).toBe('ui/itquickicon')
    expect(r.unresolved()).toEqual([])
  })

  it('a fix whose target is missing stays unresolved', () => {
    const bare = new SoundResolver(['ui/uibutton_a.wav'])
    expect(bare.resolve('monster\\wchina_jombie_moan1.wav', 'MOB_WC_HYUNGNO')).toBeNull()
    expect(bare.unresolved().map(u => u.path)).toEqual(['monster/wchina_jombie_moan1.wav'])
    expect(RETAIL_PATH_FIXES.length).toBeGreaterThan(0)
  })
})

describe('the plan (§10)', () => {
  const rows = parseEffectSound([
    row('ITEM', 'SND_EQUIP', '-', 'RING', '-', '-', '0', 'ui\\', 'itRing.wav', '80', ''),
    row('ITEM', 'SND_EQUIP', '-', 'QUICKSLOT', '-', '-', '0', 'ui\\', 'itQuckicon.wav', '80', ''),
    row('PLAYER', 'SND_DMG', '-', 'HWAN', '-', '-', '0', 'player\\', 'batHwanHit.wav', '100', ''),
    row('PLAYER', 'SND_CRIDMG', '-', 'HWAN', '-', '-', '0', 'player\\', 'batHwanCriHit.wav', '100', ''),
    row('PLAYER', 'SND_SWING3', '-', ' HWAN', 'SWORD', '-', '0', 'player\\', 'HWSwordSwing.wav', '100', ''),
    row('PLAYER', 'SND_SWING3', '-', ' HWAN', 'SPEAR', '-', '0', 'player\\', 'HWBladeSwing.wav', '100', ''),
    row('PLAYER', 'SND_SWING3', '-', ' HWAN', 'DAGGER', '-', '0', 'player\\', 'HWbatDaggerSwing1.wav', '100', ''),
    row('PLAYER', 'SND_DMG', 'SKILL_CH_COLD_GIGONGTA_A', '-', '-', '-', '0', 'skill\\', 'csk_cold_gigong_hit.wav', '80', ''),
    row('PLAYER', 'SND_DDMG', 'SKILL_CH_COLD_BINGBYEOK_A', '-', '-', '-', '0', 'skill\\', 'csk_cold_hosin_hit.wav', '100', ''),
  ].join('\n'))
  const files = [
    'ui/itring', 'ui/itquickicon', 'player/bathwanhit', 'player/bathwancrihit', 'player/hwswordswing', 'player/hwbladeswing',
    'player/hwbatdaggerswing1', 'skill/csk_cold_gigong_hit', 'skill/csk_cold_hosin_hit',
  ]
  const resolver = new SoundResolver(files.map(f => `${f}.wav`))
  const plan = planSoundIndex({
    scope: 'jangan', rows, envAreas: [], regionAreas: [], skillEffectText: '', resolver, models: [], players: [], mobs: [],
    skillGroups: ['SKILL_CH_COLD_GIGONGTA_A', 'SKILL_CH_COLD_BINGBYEOK_A'], musicKeys: [],
  })
  const cues = plan.index.cues

  it('Berserk rows become hwan cues per Chinese weapon; nothing is called imbue', () => {
    expect(cues['hit.hwan']?.files).toEqual(['player/bathwanhit'])
    expect(cues['hit.hwanCrit']?.files).toEqual(['player/bathwancrihit'])
    expect(cues['swing.hwan.SWORD']?.files).toEqual(['player/hwswordswing'])
    expect(cues['swing.hwan.SPEAR']?.files).toEqual(['player/hwbladeswing'])
    expect(cues['swing.hwan.DAGGER']).toBeUndefined() // European, out of the Jangan scope
    expect(Object.keys(cues).filter(k => /imbue/i.test(k))).toEqual([])
  })

  it('imbues keep their own SND_DMG, shield buffs their SND_DDMG, and the misspelled quick-slot file resolves', () => {
    expect(plan.index.skills.SKILL_CH_COLD_GIGONGTA_A?.dmg).toEqual(['skill/csk_cold_gigong_hit'])
    expect(plan.index.skills.SKILL_CH_COLD_BINGBYEOK_A?.swing?.snd_ddmg).toEqual(['skill/csk_cold_hosin_hit'])
    expect(cues['item.equip.QUICKSLOT']?.files).toEqual(['ui/itquickicon'])
    expect(cues['item.equip.RING']?.files).toEqual(['ui/itring'])
    // (The plan's own fixed cues, Berserk's start/end, are not in this tiny file list.)
    expect(resolver.unresolved().filter(u => u.from.some(f => f.startsWith('effectsound')))).toEqual([])
  })
})

const OUT = join(REPO_ROOT, 'work', 'out')
const INDEX = join(OUT, 'sound', 'index.json')
describe.skipIf(!existsSync(INDEX))('the exported index (§10)', () => {
  const idx = existsSync(INDEX) ? (JSON.parse(readFileSync(INDEX, 'utf8')) as SoundIndex) : (null as unknown as SoundIndex)
  const onDisk = (id: string) => {
    const f = idx.files[id]
    return !!f && existsSync(join(OUT, ...f.url.split('/')))
  }

  it('has the Berserk cues for every Chinese weapon and the quick-slot, drop, quest, revival and orb cues', () => {
    for (const cue of ['hit.hwan', 'hit.hwanCrit', 'swing.hwan.SWORD', 'swing.hwan.BLADE', 'swing.hwan.SPEAR', 'swing.hwan.BOW', 'swing.hwan.PUNCH',
      'item.equip.QUICKSLOT', 'item.equip.RING', 'item.equip.EARRING', 'item.equip.NECKLACE', 'item.dropRare', 'item.dropElixir',
      'ui.questOpen', 'ui.questDone', 'ui.revive', 'ui.hyan']) {
      const c = idx.cues[cue]
      expect(c, cue).toBeTruthy()
      for (const f of c!.files) expect(onDisk(f), `${cue} ${f}`).toBe(true)
    }
    expect(idx.cues['item.equip.RING']!.files).toEqual(['ui/itring'])
  })

  it('the three imbue lines hit with their element sound (on disk)', () => {
    for (const [el, file] of [['COLD', 'skill/csk_cold_gigong_hit'], ['LIGHTNING', 'skill/csk_light_gigong_hit'], ['FIRE', 'skill/csk_fire_gigong_hit']]) {
      const dmg = idx.skills[`SKILL_CH_${el}_GIGONGTA_A`]?.dmg
      expect(dmg, el).toEqual([file])
      expect(onDisk(file!), file).toBe(true)
    }
  })

  it('the retail path fixes are exported (Hyungno walks, the bow skills swing)', () => {
    for (const f of ['monster/wcm_jombie_walk', 'skill/csk_bow_swing', 'ui/itquickicon', 'monster/cara_bunwang_shout']) expect(onDisk(f), f).toBe(true)
    const fixed = new Set(idx.report.unresolved.map(u => u.path))
    for (const p of ['ui/itquckicon.wav', 'player/mvfrunground.wav', 'skill/csk_bow_swing_a.wav', 'monster/wchina_jombie_walk.wav', 'monster/cm_mang_moan2.wav']) {
      expect(fixed.has(p), p).toBe(false)
    }
  })
})
