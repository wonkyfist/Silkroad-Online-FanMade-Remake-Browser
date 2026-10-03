/**
 * skills.json additions (docs/SKILLS.md §3): target flags, skill-window placement, 'efr' areas, statuses, heals,
 * kinds, damage cues from skilleffectset and chain linking. Synthetic rows first; then the real client (skips
 * without sro.config.json), including the timing evidence against the converted character clips when present.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseSkillParams, type SkillDataRow } from '@sro/formats'
import type { SkillDef } from '../../shared/src/content.ts'
import { loadClientSources } from '../src/data/client-source.ts'
import {
  buildSkills,
  linkChains,
  skillAniGroups,
  skillArea,
  skillCategory,
  skillHeal,
  skillHitCues,
  skillKind,
  skillStatuses,
  skillTargets,
  skillUi,
  type SkillExtras,
  type SkillsResult,
} from '../src/data/skills.ts'
import { textdataReader } from '../src/data/textdata-source.ts'
import { loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'

const fourcc = (s: string) => [...s].reduce((a, c) => a * 256 + c.charCodeAt(0), 0)
const params = (...v: Array<string | number>) => parseSkillParams(v.map(x => (typeof x === 'string' ? fourcc(x) : x)))

/** 118 skilldata cells with the given overrides. */
const cells = (over: Record<number, string | number>) => {
  const c = Array.from({ length: 118 }, () => '0')
  for (const [k, v] of Object.entries(over)) c[Number(k)] = String(v)
  return c
}

describe('skilldata column readers', () => {
  it('reads target flags (cols 22-33)', () => {
    expect(skillTargets(cells({ 22: 1, 23: 1, 29: 1, 30: 1 }))).toEqual({ required: true, groups: ['enemy_mob', 'enemy_player'] })
    expect(skillTargets(cells({ 22: 1, 26: 1, 27: 1, 28: 1 }))).toEqual({ required: true, groups: ['self', 'ally', 'party'] })
    expect(skillTargets(cells({ 22: 1, 27: 1, 28: 1, 33: 1 }))).toEqual({ required: true, groups: ['ally', 'party'], deadBody: true })
  })

  it('reads the skill window placement (cols 57-60) and hides 255 rows', () => {
    expect(skillUi(cells({ 57: 1, 58: 3, 59: 3, 60: 0 }))).toEqual({ tab: 'force', page: 3, column: 3, row: 0 })
    expect(skillUi(cells({ 57: 0, 58: 0, 59: 1, 60: 1 }))).toEqual({ tab: 'weapon', page: 0, column: 1, row: 1 })
    expect(skillUi(cells({ 57: 255, 58: 255, 59: 255, 60: 255 }))).toBeUndefined()
  })
})

describe('parameter decoders', () => {
  it('decodes efr areas', () => {
    expect(skillArea(params('efr', 1, 1, 20, 5, 35, 24))).toEqual({ shape: 'caster', distance: 2, maxTargets: 5, reductionPct: 35, targetMask: 24, raw: [1, 1, 20, 5, 35, 24] })
    expect(skillArea(params('efr', 1, 6, 35, 2, 80, 24))?.shape).toBe('chain')
    expect(skillArea(params('efr', 1, 9, 1, 1, 0, 24))?.shape).toBe('unknown_9')
    expect(skillArea(params('att', 5, 143, 15, 18, 143))).toBeUndefined()
  })

  it('decodes statuses, stun and heal', () => {
    expect(skillStatuses(params('dura', 5000, 'att', 8, 100, 13, 19, 100, 'fz', 30, 5, 'fb', 30, 25))).toEqual([
      { status: 'freeze', level: 30, chancePct: 5 },
      { status: 'frostbite', level: 30, chancePct: 25 },
    ])
    expect(skillStatuses(params('att', 5, 250, 37, 48, 250, 'st', 5000, 20, 2))).toEqual([{ status: 'stun', level: 2, chancePct: 20, durationMs: 5000 }])
    expect(skillStatuses(params('es', 30, 20, 50))).toEqual([{ status: 'shock', level: 30, chancePct: 20, extra: [50] }])
    expect(skillHeal(params('heal', 369))).toEqual({ hp: 369, hpPct: 0, mp: 0, mpPct: 0 })
    expect(skillHeal(params('heal', 0, 10, 0, 10, 'resu', 27, 1))).toEqual({ hp: 0, hpPct: 10, mp: 0, mpPct: 10 })
  })

  it('classifies kinds and keeps the old categories for detail-only callers', () => {
    const d = (activity: number, category: number, p: ReturnType<typeof params>) => ({ activity, category, params: p })
    const enemy = { required: true, groups: ['enemy_mob' as const] }
    expect(skillKind(d(1, 3, params('dura', 5000, 'att', 8, 100, 13, 19, 100)))).toBe('imbue')
    expect(skillKind(d(2, 0, params('att', 5, 143, 15, 18, 143)))).toBe('attack')
    expect(skillKind(d(2, 0, params('heal', 0, 10, 0, 10, 'resu', 27, 1)))).toBe('resurrect')
    expect(skillKind(d(2, 0, params('heal', 369)))).toBe('heal')
    expect(skillKind(d(2, 0, params('fb', 44, 100, 'tant', 118)), enemy)).toBe('debuff')
    expect(skillKind(d(1, 3, params('dura', 355462, 'hste', 20)))).toBe('buff')
    expect(skillKind(d(0, 0, params('hpi', 102)))).toBe('passive')
    // Old callers (no range, no targets) get the old answers.
    expect(skillCategory(d(2, 0, params('att', 5, 143, 15, 18, 143)))).toBe('melee')
    expect(skillCategory(d(2, 0, params('heal', 369)))).toBe('buff')
    // Own Range or enemy targets make force attacks and debuffs ranged.
    expect(skillCategory({ ...d(2, 0, params('att', 10, 100, 46, 86, 33)), range: 150 })).toBe('ranged')
    expect(skillCategory({ ...d(2, 0, params('fb', 44, 100)), range: 150 }, { targetsEnemy: true })).toBe('ranged')
  })
})

describe('skilleffect readers', () => {
  const t = [
    ['#section', 'skillaniset2'],
    ['1', 'x', 'SKILL_CH_SWORD_GEOMGI_A', '0', 'FALSE', '0', 'SWORD', 'none', 'none', 'ANI_SKILL_5'],
    ['1', 'x', 'SKILL_CH_WATER_HEAL_A', '0', 'FALSE', '0', 'DEFAULT', 'ANI_READY01', 'ANI_WAIT01', 'ANI_SKILL_1'],
    ['#section', 'skilleffectset'],
    ['x', 'SKILL_CH_SWORD_GEOMGI_A', 'SHOT', '2', 'TRUE', 'NOR|CRI|HWAN', 'none', '0', '0', '0', '0', '1', '0,0', 'AT_MOV_1TAR', 'MOV_STRAIGHT,0,300,300'],
    ['-', 'SKILL_CH_SWORD_GEOMGI_A', 'SHOT', '1', 'FALSE', 'NOR|CRI|HWAN', 'none', '0', '0', '0', '0', '1', '0,0', 'AT_ONE_FOLLOW', 'MOV_NONE,0,0,0'],
    ['x', 'SKILL_CH_SWORD_CHAIN_A', 'SHOT', '3', 'TRUE', 'NOR', 'none', '0', '0', '0', '0', '1', '0,0', 'AT_DMG_POS', 'MOV_NONE,0,0,0'],
    ['-', 'SKILL_CH_SWORD_CHAIN_A', 'SHOT', '1', 'TRUE', 'NOR', 'none', '0', '0', '0', '0', '1', '0,0', 'AT_DMG_POS', 'MOV_NONE,0,0,0'],
    ['-', 'SKILL_CH_SWORD_CHAIN_A', 'READY', '0', 'TRUE', 'NOR', 'none', '0', '0', '0', '0', '1', '0,0', 'AT_DMG_POS', 'MOV_NONE,0,0,0'],
    ['-', 'SKILL_CH_SWORD_CHAIN_A', 'SHOT', '2', 'TRUE', 'NOR', 'none', '0', '0', '0', '0', '1', '0,0', 'AT_DMG_POS', 'MOV_NONE,0,0,0'],
  ]

  it('collects DMG Event rows in play order, with projectiles', () => {
    const cues = skillHitCues(t)
    expect(cues.get('SKILL_CH_SWORD_GEOMGI_A')).toEqual([{ phase: 'SHOT', event: 2, projectile: { move: 'MOV_STRAIGHT', delayMs: 0, speed: 300 } }])
    expect(cues.get('SKILL_CH_SWORD_CHAIN_A')?.map(c => `${c.phase}${c.event}`)).toEqual(['READY0', 'SHOT1', 'SHOT2', 'SHOT3'])
    expect(skillAniGroups(t).get('SKILL_CH_WATER_HEAL_A')).toBe('DEFAULT')
  })

  it('gives chain segment i the i-th cue and the last segment the rest', () => {
    const cue = (event: number) => ({ phase: 'SHOT', event })
    const all = [cue(1), cue(2), cue(3), cue(4)]
    const seg = (code: string, next?: string) => ({ code, ...(next ? { chainNext: next } : {}), hitCues: all }) as unknown as SkillDef & Record<string, unknown>
    const skills = [seg('A1', 'A2'), seg('A2', 'A3'), seg('A3')]
    linkChains(skills)
    expect(skills.map(s => [s.chainRoot, s.chainIndex, (s.hitCues as Array<{ event: number }>).map(c => c.event)])).toEqual([
      ['A1', 1, [1]],
      ['A1', 2, [2]],
      ['A1', 3, [3, 4]],
    ])
  })
})

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

describe.skipIf(!hasConfig)('skills export (vSRO 1.188 client)', () => {
  let r: SkillsResult
  type S = SkillDef & SkillExtras & { group: string; preparingMs?: number }
  const skill = (code: string) => r.skills.find(s => s.code === code) as S

  beforeAll(() => {
    const client = loadClientSources(textdataReader(openArchive('Media', loadConfig())))
    r = buildSkills(client.skills as SkillDataRow[], { skillmasterydata: client.tables['skillmasterydata.txt'], skilleffect: client.tables['skilleffect.txt'] }, client.strings)
  })

  it('keeps the existing fields and adds the new ones', () => {
    expect(r.skills).toHaveLength(180)
    expect(skill('SKILL_CH_SWORD_SMASH_A_01')).toMatchObject({
      name: 'Strike Smash', castMs: 411, actionMs: 1022, category: 'melee', kind: 'attack', aniGroup: 'SWORD',
      targets: { required: true, groups: ['enemy_mob', 'enemy_player'] }, ui: { tab: 'weapon', page: 0, column: 0, row: 0 },
      hitCues: [{ phase: 'SHOT', event: 1 }],
    })
    expect(skill('SKILL_CH_COLD_GIGONGJANG_A_01')).toMatchObject({ kind: 'debuff', category: 'ranged', range: 15, statuses: [{ status: 'frostbite', level: 44, chancePct: 100 }] })
    expect(skill('SKILL_CH_LIGHTNING_CHUNDUNG_A_01')).toMatchObject({ kind: 'attack', category: 'ranged', area: { shape: 'target', distance: 2, maxTargets: 3 } })
    expect(skill('SKILL_CH_LIGHTNING_GIGONGTA_A_01')).toMatchObject({ kind: 'imbue', instant: true, durationMs: 5000, overlap: 1 })
    expect(skill('SKILL_CH_WATER_HEAL_A_01')).toMatchObject({ kind: 'heal', heal: { hp: 369 }, preparingMs: 1000, targets: { groups: ['self', 'ally', 'party'] } })
    expect(skill('SKILL_CH_WATER_RESURRECTION_A_01')).toMatchObject({ kind: 'resurrect', targets: { deadBody: true } })
    expect(skill('SKILL_CH_COLD_BINGBYEOK_A_01').toggle).toEqual({ intervalMs: 5000, mp: 41 })
    expect(skill('SKILL_CH_SWORD_SHIELD_A_01').requiresItem).toEqual({ typeId3: 4, typeId4: 1 })
    expect(skill('SKILL_CH_SWORD_DOWNATTACK_A_01').requiresTargetState).toBe(1)
    expect(skill('SKILL_CH_SWORD_CHAIN_A_3S_01')).toMatchObject({ chainRoot: 'SKILL_CH_SWORD_CHAIN_A_1S_01', chainIndex: 3, hitCues: [{ phase: 'SHOT', event: 3 }] })
    // Every attack except the basic attacks has a damage cue; every imbue is instant; every buff has a duration or is a toggle/heal/cure.
    for (const s of r.skills as S[]) {
      if (s.kind === 'attack' && !s.basicAttack) expect(s.hitCues?.length, s.code).toBeGreaterThan(0)
      if (s.kind === 'imbue') expect(s.instant, s.code).toBe(true)
    }
  })

  it('places masteries on the skill window tabs with their icons', () => {
    expect(r.masteries.map(m => [m.code, (m as unknown as { tab: string; page: number }).tab, (m as unknown as { page: number }).page])).toEqual([
      ['BICHEON', 'weapon', 0], ['HEUKSAL', 'weapon', 1], ['PACHEON', 'weapon', 2],
      ['COLD', 'force', 0], ['LIGHTNING', 'force', 1], ['FIRE', 'force', 2], ['FORCE', 'force', 3],
    ])
    expect(r.masteries[0]).toMatchObject({ icon: '/out/icon/skillmastery/china/mastery_sword.png' })
    expect(r.icons).toContain('skillmastery\\china\\mastery_sword.ddj')
  })

  // Timing evidence (docs/SKILLS.md §5): the damage cue's keytime in the converted clip equals CastingTime.
  const sidecar = join(REPO_ROOT, 'work', 'out', 'char', 'china', 'chinaman_adventurer.json')
  it.skipIf(!existsSync(sidecar))('puts each damage cue at CastingTime (+ PreparingTime) in the character clips', () => {
    const anims = (JSON.parse(readFileSync(sidecar, 'utf8')) as { animations: Array<{ group: string; typeName: string; durationMs: number; events: Array<{ timeMs: number; type: number }> }> }).animations
    const clip = (group: string, type: string) => anims.find(a => a.group === group.toLowerCase() && a.typeName === type) ?? anims.find(a => a.group === 'default' && a.typeName === type)
    const checked: string[] = []
    for (const code of ['SKILL_CH_SWORD_SMASH_A_01', 'SKILL_CH_SWORD_GEOMGI_A_01', 'SKILL_CH_SWORD_KNOCKDOWN_A_01', 'SKILL_CH_SPEAR_PIERCE_A_01', 'SKILL_CH_SPEAR_STUN_A_01', 'SKILL_CH_SPEAR_FRONTAREA_A_01', 'SKILL_CH_BOW_CHAIN_A_01']) {
      const s = skill(code)
      const cue = s.hitCues![0]!
      const c = clip(s.aniGroup!, s.animation!.shot!)!
      const hits = c.events.filter(e => e.type === 1).map(e => e.timeMs).sort((a, b) => a - b)
      expect(Math.abs(hits[cue.event - 1]! - s.castMs), code).toBeLessThanOrEqual(12)
      checked.push(code)
    }
    // Clip length = CastingTime + ActionDuration on the non-charged attacks.
    for (const code of ['SKILL_CH_SWORD_SMASH_A_01', 'SKILL_CH_SWORD_GEOMGI_A_01', 'SKILL_CH_SPEAR_STUN_A_01']) {
      const s = skill(code)
      expect(Math.abs(clip(s.aniGroup!, s.animation!.shot!)!.durationMs - (s.castMs + s.actionMs)), code).toBeLessThanOrEqual(12)
    }
    // Charged skills: READY lasts PreparingTime, SHOT lasts ActionDuration (Anti Devil Bow - Missile 670 / 530).
    const bow = skill('SKILL_CH_BOW_CRITICAL_A_01')
    expect(Math.abs(clip('BOW', bow.animation!.ready!)!.durationMs - bow.preparingMs!)).toBeLessThanOrEqual(12)
    expect(Math.abs(clip('BOW', bow.animation!.shot!)!.durationMs - bow.actionMs)).toBeLessThanOrEqual(12)
    expect(checked).toHaveLength(7)
  })
})
