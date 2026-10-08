/**
 * The Climb's reward rules (packages/shared/src/climb-rewards.ts; docs/CLIMB.md §4.2, §5.1, §7.3): the set steps, the
 * Arts' row changes and their gates, the title data, and the protocol's two new requests.
 */
import { describe, expect, it } from 'vitest'
import {
  CLIMB_ACHIEVEMENTS,
  CLIMB_ARTS,
  CLIMB_ART_TREES,
  CLIMB_BOSSES,
  PILOT_HONOR,
  TITLE_NAMES,
  applyClimbArts,
  climbActiveArts,
  climbArt,
  climbArtsHitMul,
  climbSetBonus,
  climbSetLineFor,
  climbTreeLevel,
  parseClimbArts,
  parseClientMessage,
  type ItemDef,
  type SkillDef,
} from '../src/index.ts'

const piece = (code: string, degree: number, slot: ItemDef['slot'] = 'chest', category: ItemDef['category'] = 'armor') => ({ code, degree, slot, category })
const ARM = ['head', 'shoulders', 'chest', 'legs', 'hands', 'feet'] as const
const row = (o: Partial<SkillDef>): SkillDef => ({ code: 'X_01', id: 1, name: null, mastery: 'BICHEON', masteryLevel: 1, skillLevel: 1, sp: 1, mp: 40, category: 'melee', castMs: 0, actionMs: 0, cooldownMs: 3000, range: 0, weapons: [], icon: null, kind: 'attack', ...o }) as SkillDef

describe('set bonuses (§4.2)', () => {
  it('a family is a degree over the six armour pieces: 4 = +3 % HP, 6 = +5 % HP and +3 % defence; the steps replace', () => {
    expect(climbSetBonus(ARM.slice(0, 3).map((s) => piece(`ITEM_CH_M_HEAVY_03_${s}_A`, 3, s))).mods).toEqual({ maxHpPct: 0, defencePct: 0, damagePct: 0 })
    const four = climbSetBonus([...ARM.slice(0, 3).map((s) => piece(`A_${s}`, 3, s)), piece('B_feet', 3, 'feet')])
    expect(four.mods).toEqual({ maxHpPct: 3, defencePct: 0, damagePct: 0 })
    expect(four.lines[0]).toMatchObject({ name: 'Iron set', count: 4, of: 6, bonus: '+3 % max HP', next: { at: 6 } })
    expect(climbSetBonus(ARM.map((s) => piece(`A_${s}`, 4, s))).mods).toEqual({ maxHpPct: 5, defencePct: 3, damagePct: 0 })
    // a weapon or a ring is no family piece; mixed degrees are two families
    expect(climbSetBonus([...ARM.slice(0, 2).map((s) => piece(`A_${s}`, 3, s)), ...ARM.slice(2, 4).map((s) => piece(`B_${s}`, 2, s)), piece('W', 3, 'weapon', 'weapon')]).mods.maxHpPct).toBe(0)
  })
  it('the Seal set counts any _RARE item: 3 = +5 % damage, 5 = +8 % damage and +5 % HP; it adds to a family', () => {
    const seals = (n: number) => Array.from({ length: n }, (_, i) => piece(`ITEM_CH_X${i}_04_A_RARE`, 4, 'weapon', 'weapon'))
    expect(climbSetBonus(seals(3)).mods.damagePct).toBe(5)
    expect(climbSetBonus(seals(5)).mods).toEqual({ maxHpPct: 5, defencePct: 0, damagePct: 8 })
    const mix = climbSetBonus([...seals(3), ...ARM.slice(0, 4).map((s) => piece(`A_${s}`, 4, s))])
    expect(mix.mods).toEqual({ maxHpPct: 3, defencePct: 0, damagePct: 5 })
    expect(climbSetLineFor(piece('ITEM_Z_RARE', 4, 'weapon', 'weapon'), mix.lines)).toMatchObject({ id: 'seal', count: 3 })
    expect(climbSetLineFor(piece('ITEM_Q', 1, 'chest'), mix.lines)).toMatchObject({ id: 'family:1', count: 0, next: { at: 4 } })
    expect(climbSetLineFor(piece('ITEM_W', 1, 'weapon', 'weapon'), mix.lines)).toBeNull()
  })
})

describe('Arts (§5.1)', () => {
  it('24 Arts, two per tree and tier (10 / 15 / 20)', () => {
    expect(CLIMB_ARTS).toHaveLength(24)
    for (const tree of CLIMB_ART_TREES) for (const tier of [10, 15, 20]) expect(CLIMB_ARTS.filter((a) => a.tree === tree && a.tier === tier)).toHaveLength(2)
  })
  it('change the numbers of their rows only (a copy), each as the table says', () => {
    const smash = row({ group: 'SKILL_CH_SWORD_SMASH_A', damage: { physPct: 150, magPct: 0, flat: [10, 10], hits: 1 } })
    const heavy = applyClimbArts(smash, [climbArt('heavy_smash')!])
    expect([heavy.damage!.physPct, heavy.cooldownMs]).toEqual([188, 4000])
    expect(smash.cooldownMs).toBe(3000)
    expect(applyClimbArts(row({ group: 'OTHER' }), [climbArt('heavy_smash')!]).cooldownMs).toBe(3000)
    expect(applyClimbArts(row({ group: 'SKILL_CH_SWORD_GEOMGI_A', range: 12 }), [climbArt('long_reach')!]).range).toBe(16)
    const chain = (i: number) => row({ group: 'SKILL_CH_SWORD_CHAIN_A', chainIndex: i, damage: { physPct: 100, magPct: 0, flat: [0, 0], hits: 1 } })
    expect([1, 2, 3].map((i) => applyClimbArts(chain(i), [climbArt('chain_momentum')!]).damage!.physPct)).toEqual([100, 100, 150])
    const stun = applyClimbArts(row({ group: 'SKILL_CH_SPEAR_STUN_A', statuses: [{ status: 'stun', level: 2, chancePct: 20, durationMs: 5000 }] }), [climbArt('thunder_stun')!])
    expect(stun.statuses![0]!.durationMs).toBe(6000)
    const area = { shape: 'caster' as const, distance: 2, maxTargets: 5, reductionPct: 0, targetMask: 0, raw: [] }
    expect(applyClimbArts(row({ group: 'SKILL_CH_SPEAR_ROUNDAREA_A', area }), [climbArt('petal_storm')!]).area!.distance).toBe(3)
    expect(applyClimbArts(row({ group: 'SKILL_CH_SPEAR_PIERCE_A', area: { ...area, maxTargets: 2 } }), [climbArt('wide_bite')!]).area!.maxTargets).toBe(3)
    expect(applyClimbArts(row({ kind: 'imbue', mp: 100 }), [climbArt('lean_imbue')!]).mp).toBe(75)
    expect(applyClimbArts(row({ group: 'SKILL_CH_WATER_SELFHEAL_A', cooldownMs: 2100 }), [climbArt('second_wind')!]).cooldownMs).toBe(1050)
    expect(applyClimbArts(row({ group: 'SKILL_CH_WATER_HEAL_A', heal: { hp: 300, hpPct: 0, mp: 0, mpPct: 0 } }), [climbArt('mender')!]).heal!.hp).toBe(360)
  })
  it('Executioner: +30 % with Bicheon rows on a target under 30 % HP', () => {
    const ex = [climbArt('executioner')!]
    expect(climbArtsHitMul(ex, row({}), 29)).toBeCloseTo(1.3)
    expect(climbArtsHitMul(ex, row({}), 30)).toBe(1)
    expect(climbArtsHitMul(ex, row({ mastery: 'HEUKSAL' }), 10)).toBe(1)
  })
  it('the force tree reads the best force mastery; a pick above the mastery is off; bad saved picks are dropped', () => {
    expect(climbTreeLevel('FORCE', { COLD: 12, FIRE: 16, BICHEON: 20 })).toBe(16)
    const picks = parseClimbArts(JSON.stringify({ 'FORCE:15': 'mender', 'FORCE:20': 'rebirth', 'BICHEON:10': 'mender', 'X:1': 'nope' }))
    expect(picks).toEqual({ 'FORCE:15': 'mender', 'FORCE:20': 'rebirth' })
    expect(climbActiveArts(picks, { FIRE: 16 }).map((a) => a.id)).toEqual(['mender'])
    expect(parseClimbArts('not json')).toEqual({})
  })
  it('the protocol: climbArt and climbTitle are strict', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'climbArt', tree: 'PACHEON', tier: 15, art: 'flame_pierce' }))).toEqual({ ok: true, msg: { t: 'climbArt', tree: 'PACHEON', tier: 15, art: 'flame_pierce' } })
    expect(parseClientMessage(JSON.stringify({ t: 'climbArt', tree: 'COLD', tier: 15, art: 'x' })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ t: 'climbTitle', code: '' })).ok).toBe(true)
    expect(parseClientMessage(JSON.stringify({ t: 'climbTitle', code: 'Bad Code' })).ok).toBe(false)
  })
})

describe('titles (§7.3)', () => {
  it('every title code is an honor code with a name; each mini-boss has its Breaker title', () => {
    for (const a of CLIMB_ACHIEVEMENTS) {
      expect(a.code).toMatch(PILOT_HONOR)
      expect(TITLE_NAMES[a.code]).toBe(a.name)
    }
    for (const b of CLIMB_BOSSES) expect(CLIMB_ACHIEVEMENTS.some((a) => a.rule.kind === 'kill' && a.rule.mobs.includes(b.code) && a.rule.n === 10), b.code).toBe(true)
  })
})
