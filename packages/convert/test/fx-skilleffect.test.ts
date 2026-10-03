/**
 * skilleffect.txt v2 parsing (docs/EFFECTS.md §1.2, §5.1, §6.2), the fx index v2 builder and the model-bound
 * particles (§5.2), on synthetic rows shaped like the 1.188 ones: every column, `-` continuation rows, `//` and
 * `/* *\/` comments, 'none' cells and '0,-1' fades.
 */
import { describe, expect, it } from 'vitest'
import type { BsrResource } from '@sro/formats'
import { modelParticles, tidy } from '../src/fx/model-fx.ts'
import { parseFade, parseSkillEffect, skilleffectSections } from '../src/fx/skilleffect.ts'
import { buildSkillIndex, buildSkillIndexV2, type SkillEffectStage, type SkillRowLite } from '../src/fx/skills.ts'

/** A row of `n` cells from a sparse map (unset cells are ''). */
const cells = (n: number, c: Record<number, string>): string => Array.from({ length: n }, (_, i) => c[i] ?? '').join('\t')

/** One skilleffectset row: cells 0..27, the defaults of a plain 1.188 row. */
function stage(c: Record<number, string>): string {
  const d: Record<number, string> = {
    0: '-', 3: '0', 4: 'FALSE', 5: 'none', 6: 'none', 7: '0', 8: '0', 9: '0', 10: '0', 11: '1', 12: '0,0', 13: 'AT_ONE_FOLLOW',
    14: 'MOV_NONE,0,0,0', 15: '0,0,0', 16: 'false,0,0,0,0,false', 17: 'none', 18: 'none', 19: 'none', 20: '0,0,0', 21: 'none',
    22: '0,0,0', 23: 'none', 24: '0', 25: 'none', 26: 'none', 27: 'none',
  }
  return cells(28, { ...d, ...c })
}

/** One skillaniset2 row: cells 0..26. */
function aniset(c: Record<number, string>): string {
  const d: Record<number, string> = {
    0: '1', 1: 'name', 3: '0', 4: 'FALSE', 5: '0', 6: 'DEFAULT', 7: 'none', 8: 'none', 9: 'none', 10: 'none', 11: 'none', 12: 'none',
    13: 'none', 14: 'none', 15: '0', 16: '0,0,0,0', 17: 'ONE', 18: 'none', 19: 'none', 20: 'none', 21: 'none', 22: 'none', 23: 'none',
    24: 'none', 25: '0', 26: '1',
  }
  return cells(27, { ...d, ...c })
}

const SE = [
  '#section\tcharacterInfo',
  '//ResourceFileID\tResourceTypeName\tSize\tRide Type\tride\tDie Bsr\tDie Effect\tDamageBone\tDamagePos\tBloodType\tDead Effect',
  cells(15, { 0: 'CHAR_CH_MAN_ADVENTURER', 1: 'PCM_ADVENTURER', 2: '2', 3: 'none', 4: 'none', 5: 'none', 6: 'none', 7: 'none', 8: '0,13,-2', 9: 'hit_2_redblood', 10: 'none', 11: '0', 12: '0' }),
  cells(15, { 0: 'MOB_CH_TIGER', 1: 'MOB_TIGER', 2: '1.5', 3: 'none', 4: 'none', 5: 'none', 6: 'none', 7: 'none', 8: '0,11,-13', 9: 'hit_2_redblood', 10: 'none', 11: '0', 12: '0' }),
  cells(15, { 0: 'MOB_CH_MANGNYANG', 1: 'MOB_MANGNYANG', 2: '1.5', 3: 'none', 4: 'none', 5: 'res\\mob\\common\\mangnyang_die.bsr', 6: 'none', 7: 'none', 8: '0,10,-6', 9: 'hit_2_redblood', 10: 'none', 11: '0', 12: '0' }),
  cells(15, { 0: 'MOB_CH_TIGERWOMAN', 1: 'MOB_TIGERWOMAN', 2: '2.8', 3: 'none', 4: 'res\\mob\\china\\bluetiger.bsr', 5: 'none', 6: 'none', 7: 'none', 8: '0,15,-30', 9: 'hit_2_redblood', 10: 'none', 11: '0', 12: '0' }),
  cells(15, { 0: 'NPC_CH_SMITH', 1: 'PLAYER', 2: '1.5', 3: 'none', 4: 'none', 5: 'none', 6: 'none', 7: 'none', 8: '0,13,-2', 9: 'none', 10: 'none', 11: '0', 12: '0' }),
  '\t\t\t\t',
  '/*jupiter temple\t\t\t',
  cells(15, { 0: 'MOB_JUPITER_TEMPLE_WATCH', 2: '2.5', 8: '0,10,-5', 9: 'hit_2_redblood' }),
  '*/\t\t\t',
  '#section\tskillaniset2',
  '//\tSkillName\tSkillID\tPriority',
  aniset({ 1: 'sword basic', 2: 'SKILL_CH_SWORD_BASE', 6: 'SWORD', 9: 'ANI_ATTACK1,ANI_ATTACK2,ANI_ATTACK3,ANI_ATTACK4', 14: 'hiteffect\\hit_3_normal.efp', 15: '80', 16: '64,255,255,255', 18: 'mirage_texture_normal.ddj', 22: 'LIGHT_1', 25: '1' }),
  aniset({ 1: 'smash', 2: 'SKILL_CH_SWORD_SMASH_A', 6: 'SWORD', 9: 'ANI_SKILL_1', 14: 'hiteffect\\hit_3_critical.efp', 15: '120', 16: '200,255,255,255', 18: 'mirage_texture_smash.ddj', 22: 'LIGHT_4', 25: '1' }),
  aniset({ 1: 'ganggi', 2: 'SKILL_CH_COLD_GANGGI_A', 5: '1', 7: 'ANI_READY04', 8: 'ANI_WAIT04', 9: 'ANI_SKILL_4', 13: 'skill\\china\\cold_ganggi_damage_a.efp' }),
  aniset({ 1: 'fire imbue', 2: 'SKILL_CH_FIRE_GIGONGTA_A', 3: '2', 14: 'hiteffect\\hit_4_fire_hit_a.efp', 15: '160', 16: '200,255,128,0', 18: 'mirage_texture_fire.ddj', 22: 'LIGHT_4' }),
  aniset({ 1: 'bow critical', 2: 'SKILL_CH_BOW_CRITICAL_A', 6: 'BOW', 7: 'ANI_READY01', 8: 'ANI_WAIT01', 9: 'ANI_SKILL_40', 14: 'hiteffect\\hit_3_critical.efp', 15: '120', 20: 'skill\\china\\mirage_bow_critical.efp', 21: 'skill\\china\\force_bow_critical_a.efp', 22: 'LIGHT_4', 24: 'Roll', 25: '1' }),
  aniset({ 1: 'fist', 2: 'SKILL_PUNCH', 9: 'ANI_ATTACK1,ANI_ATTACK2', 14: 'hiteffect\\hit_3_hand.efp', 22: 'LIGHT_1', 25: '1' }),
  aniset({ 1: 'tomb', 2: 'MSKILL_CH_TOMBSTONE_ATTACK02', 9: 'ANI_ATTACK1', 17: 'INVSRCALPHA' }),
  aniset({ 1: 'archer', 2: 'MSKILL_CH_BANDITARCHER_ATTACK01', 9: 'ANI_ATTACK1', 14: 'hiteffect\\hit_3_bow.efp', 15: '120', 20: 'skill\\china\\mirage_bow_normal.efp', 24: 'Roll' }),
  aniset({ 0: '0', 1: 'out of service', 2: 'MSKILL_CH_GYO_ATTACK02', 9: 'ANI_ATTACK2' }),
  aniset({ 1: 'levelup', 2: 'SYSTEM_LEVELUP' }),
  aniset({ 1: 'hwan', 2: 'SYSTEM_CH_HWANMODE', 3: '10', 14: 'hiteffect\\hit_4_hwan.efp', 15: '160', 16: '200,255,255,255', 18: 'mirage_texture_hwan.ddj' }),
  '#section\tskilleffectset',
  '//SkillName11\tSkillEffectID\tAniType',
  stage({ 0: 'smash', 1: 'SKILL_CH_SWORD_SMASH_A', 2: 'SHOT', 3: '1', 5: 'NOR|CRI|HWAN', 17: 'hiteffect\\', 18: 'hit_1_cut_smash.efp', 20: '0,10,-13', 24: '1035' }),
  stage({ 1: 'SKILL_CH_SWORD_SMASH_A', 2: 'SHOT', 3: '1', 4: 'TRUE', 5: 'NOR|CRI|HWAN', 13: 'AT_DMG_POS', 17: 'hiteffect\\', 18: 'hit_1_cut_critical.efp', 25: 'SCT_RUT,315' }),
  '//-\tSKILL_CH_SWORD_SMASH_A\tSHOT\t1\tFALSE',
  stage({ 0: 'ganggi', 1: 'SKILL_CH_COLD_GANGGI_A', 2: 'READY', 7: '1', 12: '500,500', 13: 'AT_LOOP', 17: 'skill\\china\\', 18: 'cold_assist_motion_wait.efp', 20: '0,0,4', 26: 'skill\\csk_cold_ready.wav' }),
  stage({ 1: 'SKILL_CH_COLD_GANGGI_A', 2: 'SHOT', 10: '1' }),
  stage({ 1: 'SKILL_CH_COLD_GANGGI_A', 2: 'ACT_L', 12: '0,-1', 13: 'AT_LOOP', 17: 'skill\\china\\', 18: 'cold_ganggi_keep_a.efp', 19: 'Bip01' }),
  stage({ 1: 'SKILL_CH_BOW_CRITICAL_A', 2: 'READY', 7: '1', 13: 'AT_LOOP', 17: 'res\\item\\china\\weapon\\', 18: 'cha_arrow_normal.bsr', 19: 'Bip01 R Hand', 24: '90', 25: 'SCT_ARROW' }),
  stage({ 1: 'MSKILL_CH_TOMBSTONE_ATTACK02', 2: 'SHOT', 3: '1', 6: 'MOB_BASE', 7: '1', 13: 'AT_MOV_1TAR', 14: 'MOV_STRAIGHT,0,200,200', 17: 'monster\\', 18: 'skill_tombstone_ghost_shot.efp', 19: 'fire', 22: '2,10,0', 23: 'monster\\skill_tombstone_ghost_hit.efp' }),
  stage({ 1: 'MSKILL_CH_TOMBSTONE_ATTACK02', 2: 'SHOT', 3: '1', 4: 'TRUE', 5: 'NOR|CRI|HWAN', 6: 'MOB_BASE', 9: '1', 13: 'AT_MOV_1TAR', 14: 'MOV_STRAIGHT,0,200,200', 15: '40,0,0', 17: 'monster\\', 18: 'skill_tombstone_force_shot.efp', 19: 'fire01', 22: '-2,8,0', 26: 'monster\\Cm_Tomb_Force1_Swing.wav' }),
  stage({ 1: 'MSKILL_CH_BANDITARCHER_ATTACK01', 2: 'SHOT', 7: '1', 13: 'AT_LOOP', 17: 'res\\mob\\china\\', 18: 'banditarcher_arrow.bsr', 19: 'Bip01 R Hand' }),
  stage({ 0: 'levelup', 1: 'SYSTEM_LEVELUP', 2: 'ACT_S', 17: 'system\\', 18: 'system_levelup.efp' }),
  stage({ 0: 'hwan', 1: 'SYSTEM_CH_HWANMODE', 2: 'ACT_S', 6: 'CHAR_BASE', 17: 'system\\', 18: 'system_hwan_motion.efp', 19: 'Bip01', 26: 'player\\hwanchange.wav' }),
  '/* 2010 trade\t\t',
  stage({ 1: 'SYSTEM_LEVELUP', 2: 'ACT_S', 17: 'hiteffect\\', 18: 'commented_out.efp' }),
  '/* nested open\t',
  stage({ 1: 'SYSTEM_TRADE_THING', 2: 'ACT_S', 17: 'system\\', 18: 'nothing.efp' }),
  '*/',
].join('\r\n')

const SE_R = [
  '#section\tlight\t\t\t\t',
  '//Light Name\tTYPE\tARGB\tTIME\tRANGE\tAttenuation1',
  'LIGHT_1\tPOINT\t255,255,255,255\t300\t1000\t0.2\t\t',
  'LIGHT_4\tPOINT\t255,255,28,28\t300\t1000\t0.2\t\t',
  '#section\tskillaniset2\t\t',
  aniset({ 1: 'ignored', 2: 'SKILL_CH_SWORD_SMASH_A', 15: '999' }),
].join('\r\n')

const ROWS: SkillRowLite[] = [
  { group: 'SKILL_CH_SWORD_BASE', code: 'SKILL_CH_SWORD_BASE_01', level: 1, mastery: 257, masteryLevel: 0, nameKey: null },
  { group: 'SKILL_CH_SWORD_SMASH_A', code: 'SKILL_CH_SWORD_SMASH_A_01', level: 1, mastery: 257, masteryLevel: 5, nameKey: 'SN_SMASH' },
  { group: 'SKILL_CH_SWORD_SMASH_A', code: 'SKILL_CH_SWORD_SMASH_A_02', level: 2, mastery: 257, masteryLevel: 6, nameKey: 'SN_SMASH' },
  { group: 'SKILL_CH_BOW_CRITICAL_A', code: 'SKILL_CH_BOW_CRITICAL_A_01', level: 1, mastery: 259, masteryLevel: 5, nameKey: null },
  { group: 'SKILL_CH_COLD_GANGGI_A', code: 'SKILL_CH_COLD_GANGGI_A_01', level: 1, mastery: 273, masteryLevel: 8, nameKey: null },
  { group: 'SKILL_CH_FIRE_GIGONGTA_A', code: 'SKILL_CH_FIRE_GIGONGTA_A_01', level: 1, mastery: 275, masteryLevel: 5, nameKey: null },
  { group: 'SKILL_PUNCH', code: 'SKILL_PUNCH_01', level: 1, mastery: 0, masteryLevel: 0, nameKey: null },
  { group: 'xxx', code: 'MSKILL_CH_TOMBSTONE_ATTACK02', level: 9, mastery: 0, masteryLevel: 0, nameKey: null },
  { group: 'xxx', code: 'MSKILL_CH_BANDITARCHER_ATTACK01', level: 10, mastery: 0, masteryLevel: 0, nameKey: null },
]

const MODELS = new Set(['res/item/china/weapon/cha_arrow_normal.bsr', 'res/mob/common/mangnyang_die.bsr'])
const model = (p: string) => (MODELS.has(p) ? { glb: `/out/${p.slice(4, -4)}.glb`, sidecar: `/out/${p.slice(4, -4)}.json` } : null)

describe('skilleffect.txt parser', () => {
  const file = parseSkillEffect(SE, SE_R)

  it('skips // rows, /* */ blocks (unmatched inner /* included) and blank rows; keeps - rows', () => {
    const sections = skilleffectSections(SE)
    expect(sections.get('characterInfo')!.map(r => r[0])).toEqual(['CHAR_CH_MAN_ADVENTURER', 'MOB_CH_TIGER', 'MOB_CH_MANGNYANG', 'MOB_CH_TIGERWOMAN', 'NPC_CH_SMITH'])
    expect(file.characterInfo.has('MOB_JUPITER_TEMPLE_WATCH')).toBe(false)
    expect(file.stages.get('SKILL_CH_SWORD_SMASH_A')!.map(s => s.name)).toEqual(['smash', '-'])
    expect(file.stages.has('SYSTEM_TRADE_THING')).toBe(false)
    expect([...file.stages.values()].flat().some(s => s.objectName === 'commented_out.efp')).toBe(false)
    expect(file.stages.get('SYSTEM_LEVELUP')).toHaveLength(1)
  })

  it('reads every characterInfo column', () => {
    expect(file.characterInfo.get('MOB_CH_TIGER')).toMatchObject({ size: 1.5, damagePos: [0, 11, -13], bloodType: 'hit_2_redblood', damageBone: null, dieModel: null, ride: null })
    expect(file.characterInfo.get('MOB_CH_MANGNYANG')!.dieModel).toBe('res/mob/common/mangnyang_die.bsr')
    expect(file.characterInfo.get('MOB_CH_TIGERWOMAN')!.ride).toBe('res/mob/china/bluetiger.bsr')
    expect(file.characterInfo.get('NPC_CH_SMITH')!.bloodType).toBeNull()
  })

  it('reads every aniset column (service 1 only)', () => {
    expect(file.aniset.has('MSKILL_CH_GYO_ATTACK02')).toBe(false)
    expect(file.aniset.get('SKILL_CH_SWORD_SMASH_A')).toMatchObject({
      priority: 0, hideWeapon: false, aniGroup: 'SWORD', shot: 'ANI_SKILL_1', damage: 'hiteffect\\hit_3_critical.efp', trailLength: 120,
      trailArgb: [200, 255, 255, 255], trailOp: 'ONE', trailTexture: 'mirage_texture_smash.ddj', light: 'LIGHT_4', object: null, twist: null,
      attack: true, bleeds: true,
    })
    expect(file.aniset.get('SKILL_CH_COLD_GANGGI_A')).toMatchObject({ hideWeapon: true, defense: 'skill\\china\\cold_ganggi_damage_a.efp', light: null })
    expect(file.aniset.get('SKILL_CH_FIRE_GIGONGTA_A')!.priority).toBe(2)
    expect(file.aniset.get('SKILL_CH_BOW_CRITICAL_A')).toMatchObject({ twist: 'Roll', arrowForce: 'skill\\china\\force_bow_critical_a.efp' })
  })

  it('reads every skilleffectset column', () => {
    const [ghost, force] = file.stages.get('MSKILL_CH_TOMBSTONE_ATTACK02')!
    expect(ghost).toMatchObject({ dmg: false, scale: 'MOB_BASE', id: 1, trade: 0, startBone: 'fire', targetOffset: '2,10,0', object2: 'monster\\skill_tombstone_ghost_hit.efp' })
    expect(force).toMatchObject({
      phase: 'SHOT', startEvent: 1, dmg: true, damageTypes: ['NOR', 'CRI', 'HWAN'], id: 0, attach: 0, trade: 1, kill: 0, createCount: 1,
      fade: { inMs: 0, outMs: 0 }, actType: 'AT_MOV_1TAR', move: 'MOV_STRAIGHT,0,200,200', param: [40, 0, 0], actOption: 'false,0,0,0,0,false',
      folder: 'monster\\', objectName: 'skill_tombstone_force_shot.efp', startBone: 'fire01', soundBegin: 'monster\\Cm_Tomb_Force1_Swing.wav', soundEnd: null,
    })
    const ganggi = file.stages.get('SKILL_CH_COLD_GANGGI_A')!
    expect(ganggi.map(s => [s.phase, s.fade, s.kill, s.damageTypes])).toEqual([
      ['READY', { inMs: 500, outMs: 500 }, 0, null],
      ['SHOT', { inMs: 0, outMs: 0 }, 1, null],
      ['ACT_L', { inMs: 0, outMs: -1 }, 0, null],
    ])
    expect(parseFade('10,500')).toEqual({ inMs: 10, outMs: 500 })
    expect(parseFade('')).toEqual({ inMs: 0, outMs: 0 })
  })

  it('takes the lights from SE-R', () => {
    expect([...file.lights.keys()]).toEqual(['LIGHT_1', 'LIGHT_4'])
    expect(file.lights.get('LIGHT_4')).toEqual({ name: 'LIGHT_4', type: 'POINT', argb: [255, 255, 28, 28], timeMs: 300, range: 1000, atten: 0.2 })
    // SE-R's other sections are not read: SE's aniset wins.
    expect(file.aniset.get('SKILL_CH_SWORD_SMASH_A')!.trailLength).toBe(120)
  })
})

describe('fx index v2', () => {
  const file = parseSkillEffect(SE, SE_R)
  const strings = new Map([['SN_SMASH', 'Strike Smash']])
  const v2 = buildSkillIndexV2({
    skillRows: ROWS, file, strings, exported: k => k !== 'hiteffect/hit_2_redblood_down.efp', model,
    mobSkills: ['MSKILL_CH_TOMBSTONE_ATTACK02', 'MSKILL_CH_BANDITARCHER_ATTACK01', 'MSKILL_CH_GYO_ATTACK02', 'MSKILL_CH_TOMBSTONE_ATTACK02'],
    characters: ['MOB_CH_TIGER', 'MOB_CH_MANGNYANG', 'MOB_CH_TIGERWOMAN', 'NPC_CH_SMITH', 'MOB_CH_UNKNOWN'],
  })
  const g = (group: string) => v2.skills.find(s => s.group === group)!

  it('is version 2 with the kinds in order: players (v1 order, then the fist), mobs, systems', () => {
    expect(v2.version).toBe(2)
    expect(v2.format).toBe('sro-fx-skills')
    expect(v2.skills.map(s => [s.group, s.kind])).toEqual([
      ['SKILL_CH_SWORD_BASE', 'player'],
      ['SKILL_CH_SWORD_SMASH_A', 'player'],
      ['SKILL_CH_BOW_CRITICAL_A', 'player'],
      ['SKILL_CH_COLD_GANGGI_A', 'player'],
      ['SKILL_CH_FIRE_GIGONGTA_A', 'player'],
      ['SKILL_PUNCH', 'player'],
      ['MSKILL_CH_BANDITARCHER_ATTACK01', 'mob'],
      ['MSKILL_CH_TOMBSTONE_ATTACK02', 'mob'],
      ['SYSTEM_CH_HWANMODE', 'system'],
      ['SYSTEM_LEVELUP', 'system'],
    ])
  })

  it('keeps the v1 fields of the Chinese groups byte-equal', () => {
    const v1 = buildSkillIndex(ROWS, SE, strings, k => k !== 'hiteffect/hit_2_redblood_down.efp')
    const V1_STAGE_KEYS = Object.keys(v1.skills[1]!.stages[0]!) as Array<keyof SkillEffectStage>
    for (const s1 of v1.skills) {
      const s2 = g(s1.group)
      const { stages: st1, ...rest1 } = s1
      const rest2 = Object.fromEntries(Object.keys(rest1).map(k => [k, (s2 as unknown as Record<string, unknown>)[k]]))
      expect(JSON.stringify(rest2)).toBe(JSON.stringify(rest1))
      const st2 = s2.stages.map(st => Object.fromEntries(V1_STAGE_KEYS.map(k => [k, st[k]])))
      expect(JSON.stringify(st2)).toBe(JSON.stringify(st1))
    }
    for (const [k, e] of Object.entries(v1.effects)) expect(v2.effects[k]!.skills).toEqual(expect.arrayContaining(e.skills))
  })

  it('adds the aniset columns', () => {
    expect(g('SKILL_CH_SWORD_SMASH_A')).toMatchObject({
      name: 'Strike Smash', levels: 2, priority: 0, hideWeapon: false, light: 'LIGHT_4', twist: null, bleeds: true,
      trail: { lengthMs: 120, argb: [200, 255, 255, 255], op: 'ONE', texture: 'textures/mirage_texture_smash.ddj' },
    })
    expect(g('SKILL_CH_COLD_GANGGI_A')).toMatchObject({ hideWeapon: true, trail: null, defense: 'skill/china/cold_ganggi_damage_a.efp' })
    expect(g('SKILL_CH_FIRE_GIGONGTA_A')).toMatchObject({ priority: 2, trail: { lengthMs: 160, argb: [200, 255, 128, 0], texture: 'textures/mirage_texture_fire.ddj' } })
    expect(g('SKILL_CH_BOW_CRITICAL_A').trail).toEqual({ lengthMs: 120, argb: [0, 0, 0, 0], op: 'ONE', texture: null })
    expect(g('SYSTEM_CH_HWANMODE')).toMatchObject({ priority: 10, damage: 'hiteffect/hit_4_hwan.efp', trail: { texture: 'textures/mirage_texture_hwan.ddj' } })
    expect(g('MSKILL_CH_TOMBSTONE_ATTACK02')).toMatchObject({ mastery: 0, levels: 1, clips: { ready: null, wait: null, shot: 'ANI_ATTACK1' }, trail: null })
    expect(g('SKILL_PUNCH')).toMatchObject({ damage: 'hiteffect/hit_3_hand.efp', light: 'LIGHT_1', trail: null })
  })

  it('adds the stage columns and the .bsr object models', () => {
    const [ghost, force] = g('MSKILL_CH_TOMBSTONE_ATTACK02').stages
    expect(ghost).toMatchObject({ dmg: false, id: 1, trade: 0, scale: 'MOB_BASE', effect: 'monster/skill_tombstone_ghost_shot.efp', effect2: 'monster/skill_tombstone_ghost_hit.efp' })
    expect(force).toMatchObject({ dmg: true, trade: 1, damageTypes: ['NOR', 'CRI', 'HWAN'], param: [40, 0, 0], fade: { inMs: 0, outMs: 0 }, createCount: 1, attach: 0, actOption: 'false,0,0,0,0,false' })
    expect(force!.sound.begin).toBe('monster/cm_tomb_force1_swing')
    expect('objectModel' in force!).toBe(false)
    expect(g('SKILL_CH_COLD_GANGGI_A').stages[2]!.fade).toEqual({ inMs: 0, outMs: -1 })
    expect(g('SKILL_CH_BOW_CRITICAL_A').stages[0]!.objectModel).toEqual({ glb: '/out/item/china/weapon/cha_arrow_normal.glb', sidecar: '/out/item/china/weapon/cha_arrow_normal.json' })
    expect(g('MSKILL_CH_BANDITARCHER_ATTACK01').stages[0]!.objectModel).toBeNull()
    expect(g('SYSTEM_CH_HWANMODE').stages[0]).toMatchObject({ scale: 'CHAR_BASE', startBone: 'Bip01', sound: { begin: 'player/hwanchange', end: null } })
  })

  it('carries lights and characters', () => {
    expect(v2.lights).toEqual({
      LIGHT_1: { argb: [255, 255, 255, 255], timeMs: 300, range: 1000, atten: 0.2 },
      LIGHT_4: { argb: [255, 255, 28, 28], timeMs: 300, range: 1000, atten: 0.2 },
    })
    expect(Object.keys(v2.characters)).toEqual(['CHAR_CH_MAN_ADVENTURER', 'MOB_CH_MANGNYANG', 'MOB_CH_TIGER', 'MOB_CH_TIGERWOMAN', 'NPC_CH_SMITH'])
    expect(v2.characters.MOB_CH_TIGER).toEqual({ size: 1.5, damageBone: null, damagePos: [0, 11, -13], bloodType: 'hiteffect/hit_2_redblood.efp', dieModel: null, ride: null })
    expect(v2.characters.CHAR_CH_MAN_ADVENTURER!.size).toBe(2)
    expect(v2.characters.MOB_CH_MANGNYANG!.dieModel).toEqual({ glb: '/out/mob/common/mangnyang_die.glb', sidecar: '/out/mob/common/mangnyang_die.json' })
    expect(v2.characters.MOB_CH_TIGERWOMAN!.ride).toBeNull()
    expect(v2.characters.NPC_CH_SMITH!.bloodType).toBeNull()
    expect(v2.effects['hiteffect/hit_2_redblood.efp']).toEqual({ skills: [], url: 'fx/efp/hiteffect/hit_2_redblood.json' })
    expect(v2.effects['hiteffect/hit_2_redblood_down.efp']).toBeUndefined()
    expect(v2.effects['monster/skill_tombstone_force_shot.efp']!.skills).toEqual(['MSKILL_CH_TOMBSTONE_ATTACK02'])
  })

  it('stays readable by a v1 reader (group + stages)', () => {
    const json = JSON.parse(JSON.stringify(v2)) as { skills: Array<{ group: unknown; stages: unknown }> }
    expect(json.skills.every(s => typeof s.group === 'string' && Array.isArray(s.stages))).toBe(true)
  })
})

describe('model particles (BSR mod palette)', () => {
  const particle = (path: string, bone: string, position: [number, number, number], extra: Partial<{ birthTimeMs: number; bytes: [number, number, number, number]; extraVector: [number, number, number] | null }> = {}) => ({
    flag: 1, path, bone, position, birthTimeMs: 0, bytes: [0, 0, 0, 0] as [number, number, number, number], extraVector: null, ...extra,
  })
  const set = (name: string, type: number, typeName: string, particles: ReturnType<typeof particle>[], animationTypeName?: string) => ({
    type, typeName, animationType: animationTypeName ? 122 : -1, animationTypeName, name,
    mods: [{ kind: 'particle', particles }, { kind: 'mtrl' }],
  })
  const bsr = {
    modPalette: {
      systemSets: [
        set('ambient', 2, 'AMBIENT', [
          particle('system\\item_drop_equip.efp', '', [0, 0.04957157373428345, 1.1920928955078125e-7]),
          particle('system\\item_drop_acc.efp', '', [1.401298464324817e-45, 1.3384324312210083, -0.024785757064819336]),
          particle('map\\cj_pal_lamp_red.efp', 'Bone01', [10, 81, 3], { bytes: [0, 1, 0, 0] }),
        ]),
        set('status_bad_burn', 0, 'LOCOMOTION', [particle('monster\\status_bad_burn.efp', '', [0, 0, 0])]),
        set('system_appear', 0, 'LOCOMOTION', [particle('monster\\system_appear.efp', '', [0, 0, 0])]),
      ],
      aniSets: [set('default', 1, 'SIMPLE', [particle('npc\\npc_chinasystem_shaman_pipesmoke.efp', 'Bone09', [0, 0, 0], { birthTimeMs: 3206, bytes: [0, 0, 0, 1], extraVector: [1.5707963705062866, 0, 0] })], 'STAND2')],
    },
  } as unknown as BsrResource

  it('converts positions with toGltfPosition and classifies the sets', () => {
    const { particles, warnings } = modelParticles(bsr)
    expect(warnings).toEqual([])
    expect(particles.map(p => [p.set, p.kind, p.efp, p.bone, p.night])).toEqual([
      ['ambient', 'ambient', 'system/item_drop_equip.efp', null, false],
      ['ambient', 'ambient', 'system/item_drop_acc.efp', null, false],
      ['ambient', 'ambient', 'map/cj_pal_lamp_red.efp', 'Bone01', true],
      ['status_bad_burn', 'status', 'monster/status_bad_burn.efp', null, false],
      ['system_appear', 'status', 'monster/system_appear.efp', null, false],
      ['default', 'clip', 'npc/npc_chinasystem_shaman_pipesmoke.efp', 'Bone09', false],
    ])
    expect(particles[1]!.position).toEqual([0, 0.13384, 0.00248])
    expect(particles[0]!.position).toEqual([0, 0.00496, 0])
    expect(particles[2]!.position).toEqual([1, 8.1, -0.3])
    expect(particles[5]).toMatchObject({ clip: 'STAND2', birthMs: 3206, extra: [1.5707963705062866, 0, 0] })
    expect('clip' in particles[0]!).toBe(false)
  })

  it('drops particles whose .efp is not in Particles.pk2, with a warning', () => {
    const { particles, warnings } = modelParticles(bsr, k => k !== 'monster/system_appear.efp')
    expect(particles.some(p => p.efp === 'monster/system_appear.efp')).toBe(false)
    expect(particles).toHaveLength(5)
    expect(warnings).toEqual(['particle monster/system_appear.efp (set system_appear) is not in Particles.pk2; dropped'])
  })

  it('tidies file floats', () => {
    expect(tidy(1.4e-46)).toBe(0)
    expect(Object.is(tidy(-0.0000001), 0)).toBe(true)
    expect(tidy(0.123456789)).toBe(0.12346)
  })
})
