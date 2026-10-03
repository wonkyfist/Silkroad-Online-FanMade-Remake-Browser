/**
 * fx/skills.json stage fields added in wave 5 (docs/SKILLS.md §7.2, §10.5 item 4): the DMG Event flag (col 4), Kill
 * (col 10) and the SndBegin/SndEnd sound keys (cols 26/27), on synthetic skilleffect.txt rows shaped like the
 * 1.188 ones (Strike Smash, Weak Guard of Ice; "NOR|CRI|HWAN" is one cell).
 */
import { describe, expect, it } from 'vitest'
import { buildSkillIndex, soundKey, type SkillRowLite } from '../src/fx/skills.ts'

/** One skilleffectset row: cells 0..27 (cell 0 is empty, like the file). */
function row(c: Record<number, string>): string {
  const cells = Array.from({ length: 28 }, (_, i) => c[i] ?? (i === 0 ? '' : '0'))
  return cells.join('\t')
}

const TEXT = [
  '#section\tskillaniset2',
  ['1', '', 'SKILL_CH_SWORD_SMASH_A', '0', '', '0', 'SWORD', 'ANI_SKILL_1', 'none', 'none', '', '', '', 'none', 'hiteffect\\hit_3_critical.efp'].join('\t'),
  '#section\tskilleffectset',
  row({ 1: 'SKILL_CH_SWORD_SMASH_A', 2: 'SHOT', 3: '1', 4: 'FALSE', 5: 'NOR|CRI|HWAN', 6: 'none', 13: 'AT_ONE_FOLLOW', 14: 'MOV_NONE,0,0,0', 17: 'hiteffect\\', 18: 'hit_1_cut_smash.efp', 19: 'none', 20: '0,10,-13', 21: 'none', 22: '0,0,0', 23: 'none', 24: '1035', 25: 'none', 26: 'none', 27: 'none' }),
  row({ 1: 'SKILL_CH_SWORD_SMASH_A', 2: 'SHOT', 3: '1', 4: 'TRUE', 5: 'NOR|CRI|HWAN', 6: 'none', 13: 'AT_DMG_POS', 14: 'MOV_NONE,0,0,0', 17: 'hiteffect\\', 18: 'hit_1_cut_critical.efp', 19: 'none', 20: '0,0,0', 21: 'none', 22: '0,0,0', 23: 'none', 24: '0', 25: 'SCT_RUT,315', 26: 'none', 27: 'none' }),
  row({ 1: 'SKILL_CH_COLD_GANGGI_A', 2: 'READY', 3: '0', 4: 'FALSE', 5: 'none', 6: 'none', 7: '1', 13: 'AT_LOOP', 14: 'MOV_NONE,0,0,0', 17: 'skill\\china\\', 18: 'cold_motion_keep.efp', 19: 'Bip01 R Hand', 20: '0,0,0', 21: 'none', 22: '0,0,0', 23: 'none', 24: '0', 25: 'none', 26: 'skill\\csk_cold_ready.wav', 27: 'none' }),
  row({ 1: 'SKILL_CH_COLD_GANGGI_A', 2: 'SHOT', 3: '0', 4: 'FALSE', 5: 'none', 6: 'none', 10: '1', 13: 'AT_ONE_FOLLOW', 14: 'MOV_NONE,0,0,0', 17: 'none', 18: 'none', 19: 'none', 20: '0,0,0', 21: 'none', 22: '0,0,0', 23: 'none', 24: '0', 25: 'none', 26: 'none', 27: 'none' }),
  row({ 1: 'SKILL_CH_COLD_GANGGI_A', 2: 'ACT_S', 3: '0', 4: 'FALSE', 5: 'none', 6: 'none', 13: 'AT_ONE_FOLLOW', 14: 'MOV_NONE,0,0,0', 17: 'skill\\china\\', 18: 'cold_ganggi_keep_a.efp', 19: 'Bip01', 20: '0,0,0', 21: 'none', 22: '0,0,0', 23: 'none', 24: '0', 25: 'none', 26: 'skill\\Csk_Cold_Binghon.wav', 27: 'none' }),
].join('\r\n')

const ROWS: SkillRowLite[] = [
  { group: 'SKILL_CH_SWORD_SMASH_A', code: 'SKILL_CH_SWORD_SMASH_A_01', level: 1, mastery: 257, masteryLevel: 5, nameKey: null },
  { group: 'SKILL_CH_COLD_GANGGI_A', code: 'SKILL_CH_COLD_GANGGI_A_01', level: 1, mastery: 273, masteryLevel: 8, nameKey: null },
]

describe('fx/skills.json stage fields', () => {
  it('carries dmg, kill and sound per stage', () => {
    const index = buildSkillIndex(ROWS, TEXT, new Map(), () => true)
    const smash = index.skills.find(s => s.group === 'SKILL_CH_SWORD_SMASH_A')!
    expect(smash.damage).toBe('hiteffect/hit_3_critical.efp')
    expect(smash.stages.map(s => [s.actType, s.effect, s.dmg, s.kill])).toEqual([
      ['AT_ONE_FOLLOW', 'hiteffect/hit_1_cut_smash.efp', false, 0],
      ['AT_DMG_POS', 'hiteffect/hit_1_cut_critical.efp', true, 0],
    ])
    expect(smash.stages[1]!.script).toBe('SCT_RUT,315')
    const ganggi = index.skills.find(s => s.group === 'SKILL_CH_COLD_GANGGI_A')!
    expect(ganggi.stages.map(s => [s.phase, s.kill, s.sound])).toEqual([
      ['READY', 0, { begin: 'skill/csk_cold_ready', end: null }],
      ['SHOT', 1, { begin: null, end: null }],
      ['ACT_S', 0, { begin: 'skill/csk_cold_binghon', end: null }],
    ])
    expect(ganggi.stages[1]!.effect).toBeNull()
  })

  it('normalises sound cells to prim/snd keys', () => {
    expect(soundKey('skill\\Csk_Cold_Binghon.wav')).toBe('skill/csk_cold_binghon')
    expect(soundKey('none')).toBeNull()
    expect(soundKey('')).toBeNull()
    expect(soundKey(undefined)).toBeNull()
  })
})
