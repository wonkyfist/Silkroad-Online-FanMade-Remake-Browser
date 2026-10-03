/**
 * Skills engine, pure parts (docs/SKILLS.md §1-§5; docs/WAVE_PLAN.md §4.3): the skill book, the learning rules, the
 * action timeline, area target selection and the stat-mod table.
 */
import { describe, expect, it } from 'vitest'
import { SkillBook } from '../src/skills/book.ts'
import { CH_MASTERY_TOTAL, checkLearn, checkMasteryUp, masteryCost } from '../src/skills/learn.ts'
import { applyMods, modsFromParams, sumMods } from '../src/skills/mods.ts'
import { emptyMasteries } from '../src/skills/store.ts'
import { selectTargets } from '../src/skills/targeting.ts'
import { arrivalAt, projectileOf, timeline } from '../src/skills/timing.ts'
import { imbueDamage, reductionMul, rollSkillHit, type CombatStats } from '../src/formulas.ts'
import { MASTERIES, SKILLS, SKILL_LEVELS } from './skills-fixtures.ts'

const book = new SkillBook(SKILLS, MASTERIES)
const code = (c: string) => book.skill(c)!

function stats(over: Partial<CombatStats> = {}): CombatStats {
  return { level: 1, physAttack: [100, 100], magAttack: [100, 100], physDefence: 0, magDefence: 0, physAbsorb: 0, magAbsorb: 0, hitRate: 20, parryRate: 0, blockRate: 0, critRate: 0, balance: 1, ...over }
}

describe('SkillBook', () => {
  it('indexes rows by code and learnable rows by group, chain heads only', () => {
    expect(book.byGroup.get('SKILL_CH_SWORD_SMASH_A')!.map((s) => s.skillLevel)).toEqual([1, 2, 3])
    expect(book.byGroup.get('SKILL_CH_SWORD_CHAIN_A')!.map((s) => s.code)).toEqual(['SKILL_CH_SWORD_CHAIN_A_1S_01'])
    expect(book.byGroup.has('SKILL_CH_SWORD_BASE')).toBe(false)
    expect(book.head(code('SKILL_CH_SWORD_CHAIN_A_3S_01')).code).toBe('SKILL_CH_SWORD_CHAIN_A_1S_01')
    expect(book.chain(code('SKILL_CH_SWORD_CHAIN_A_1S_01'))!.code).toBe('SKILL_CH_SWORD_CHAIN_A_2S_01')
    expect(book.chain(code('SKILL_CH_SWORD_CHAIN_A_3S_01'))).toBeUndefined()
    expect(book.nextRow('SKILL_CH_SWORD_SMASH_A', 1)!.code).toBe('SKILL_CH_SWORD_SMASH_A_02')
    expect(book.nextRow('SKILL_CH_SWORD_SMASH_A', 3)).toBeUndefined()
    expect(book.maxLearned('SKILL_CH_SWORD_SMASH_A', 4)!.code).toBe('SKILL_CH_SWORD_SMASH_A_02')
    expect(book.maxLearned('SKILL_CH_SWORD_SMASH_A', 0)).toBeUndefined()
    expect(book.linesOf.get('BICHEON')).toContain('SKILL_CH_SWORD_GEOMGI_A')
  })

  it('picks the basic-attack row from the weapon (item field first, family otherwise, fist = punch)', () => {
    expect(book.basic('sword')!.code).toBe('SKILL_CH_SWORD_BASE_01')
    expect(book.basic('blade')!.code).toBe('SKILL_CH_SWORD_BASE_01')
    expect(book.basic('bow')!.code).toBe('SKILL_CH_BOW_BASE_01')
    expect(book.basic('fist')!.code).toBe('SKILL_PUNCH_01')
    expect(book.basic('spear')).toBeUndefined()
    expect(book.basic('spear', 'SKILL_CH_BOW_BASE_01')!.code).toBe('SKILL_CH_BOW_BASE_01')
  })

  it('an empty or missing export gives an empty book', () => {
    expect(SkillBook.load('/definitely/not/here').size).toBe(0)
  })
})

describe('learning rules', () => {
  it('mastery levels cost levels.json masterySp of the level reached (1, 1, 1, 2, 2, ...)', () => {
    expect([1, 2, 3, 4, 5].map((l) => masteryCost(SKILL_LEVELS, l))).toEqual([1, 1, 1, 2, 2])
    expect(masteryCost(SKILL_LEVELS, 99)).toBeNull()
    const m = emptyMasteries()
    expect(checkMasteryUp({ level: 5, sp: 10 }, m, 'BICHEON', SKILL_LEVELS)).toEqual({ ok: true, sp: 1 })
    m.BICHEON = 3
    expect(checkMasteryUp({ level: 5, sp: 10 }, m, 'BICHEON', SKILL_LEVELS)).toEqual({ ok: true, sp: 2 })
    expect(checkMasteryUp({ level: 5, sp: 1 }, m, 'BICHEON', SKILL_LEVELS)).toMatchObject({ ok: false, reason: 'no_sp' })
  })

  it('a mastery stops at the character level and the total at CH_MASTERY_TOTAL', () => {
    const m = emptyMasteries()
    m.COLD = 5
    expect(checkMasteryUp({ level: 5, sp: 100 }, m, 'COLD', SKILL_LEVELS)).toMatchObject({ ok: false, reason: 'mastery_cap' })
    const full = emptyMasteries()
    full.BICHEON = CH_MASTERY_TOTAL
    expect(checkMasteryUp({ level: 400, sp: 1e6 }, full, 'COLD', SKILL_LEVELS)).toMatchObject({ ok: false, reason: 'mastery_cap' })
  })

  it('a skill level needs the previous level, the mastery, the SP and its prerequisites', () => {
    const m = emptyMasteries()
    const skills = new Map<string, number>()
    const smash1 = code('SKILL_CH_SWORD_SMASH_A_01')
    const smash2 = code('SKILL_CH_SWORD_SMASH_A_02')
    expect(checkLearn(smash1, book, 10, m, skills)).toMatchObject({ ok: false, reason: 'requirements' })
    m.BICHEON = 1
    expect(checkLearn(smash1, book, 1, m, skills)).toMatchObject({ ok: false, reason: 'no_sp' })
    expect(checkLearn(smash1, book, 10, m, skills)).toEqual({ ok: true, sp: 2 })
    expect(checkLearn(smash2, book, 10, m, skills)).toMatchObject({ ok: false, reason: 'requirements' })
    skills.set('SKILL_CH_SWORD_SMASH_A', 1)
    expect(checkLearn(smash1, book, 10, m, skills)).toMatchObject({ ok: false, reason: 'requirements' })
    expect(checkLearn(smash2, book, 10, m, skills)).toMatchObject({ ok: false, reason: 'requirements' }) // mastery 3 needed
    m.BICHEON = 3
    expect(checkLearn(smash2, book, 10, m, skills)).toEqual({ ok: true, sp: 3 })
    expect(checkLearn(code('SKILL_CH_SWORD_BASE_01'), book, 10, m, skills)).toMatchObject({ ok: false, reason: 'not_found' })
    const withReq = { ...smash1, requires: [{ group: 'SKILL_CH_SPEAR_PIERCE_A', level: 1 }] }
    const b2 = new SkillBook([withReq, ...SKILLS.filter((s) => s.code !== smash1.code)], MASTERIES)
    expect(checkLearn(b2.skill(smash1.code)!, b2, 10, m, new Map())).toMatchObject({ ok: false, reason: 'requirements' })
  })
})

describe('timing', () => {
  it('release at prepare + cast, end at release + action (docs/SKILLS.md §5.1)', () => {
    expect(timeline(code('SKILL_CH_SWORD_SMASH_A_01'), 1000)).toMatchObject({ prepareMs: 0, castMs: 400, actionMs: 1000, releaseAt: 1400, endAt: 2400 })
    expect(timeline(code('SKILL_CH_COLD_GANGGI_A_01'), 0)).toMatchObject({ prepareMs: 1000, releaseAt: 2000, endAt: 3000 })
  })

  it('projectiles land delay + distance / (speed / 10) seconds after the release', () => {
    const p = projectileOf(code('SKILL_CH_SWORD_GEOMGI_A_01'))!
    expect(p).toEqual({ delayMs: 0, speed: 300 })
    expect(arrivalAt(5000, 9, p)).toBe(5000 + 300)
    expect(arrivalAt(5000, 9, { delayMs: 100, speed: 500 })).toBe(5000 + 100 + 180)
    expect(projectileOf(code('SKILL_CH_SWORD_SMASH_A_01'))).toBeNull()
  })
})

describe('area targets', () => {
  const at = (id: number, x: number, z: number) => ({ id, x, z, radius: 0.5 })
  const caster = { x: 0, z: 0 }
  const primary = at(1, 0, 5)

  it('no area: the primary only', () => {
    expect(selectTargets(undefined, caster, primary, [at(2, 0, 5.5)]).map((c) => c.id)).toEqual([1])
  })

  it('target circle: nearest first, maxTargets counts the primary', () => {
    const area = code('SKILL_CH_SPEAR_FRONTAREA_A_01').area!
    const others = [at(4, 0, 7.4), at(2, 1, 5), at(3, 0, 6), at(5, 9, 9)]
    expect(selectTargets(area, caster, primary, others).map((c) => c.id)).toEqual([1, 2, 3])
  })

  it('caster circle', () => {
    const area = { shape: 'caster' as const, distance: 2, maxTargets: 5, reductionPct: 0, targetMask: 24, raw: [] }
    expect(selectTargets(area, caster, at(1, 0, 1), [at(2, 1, 1), at(3, 5, 5), at(4, -1.5, 0)]).map((c) => c.id)).toEqual([1, 2, 4])
  })

  it('pierce: the line through the primary, beyond it, not beside it', () => {
    const area = code('SKILL_CH_SPEAR_PIERCE_A_01').area!
    const others = [at(2, 0, 6.5), at(3, 3, 5), at(4, 0, -2)]
    expect(selectTargets(area, caster, primary, others).map((c) => c.id)).toEqual([1, 2])
  })

  it('chain: hops from the last one hit to the nearest within the distance', () => {
    const area = { shape: 'chain' as const, distance: 3.5, maxTargets: 3, reductionPct: 80, targetMask: 24, raw: [] }
    const others = [at(2, 3, 5), at(3, 6, 5), at(4, 20, 5)]
    expect(selectTargets(area, caster, primary, others).map((c) => c.id)).toEqual([1, 2, 3])
  })
})

describe('mods and damage', () => {
  it('maps the FourCC tags; defp below 20 is percent, 20 and above flat', () => {
    const t = sumMods(modsFromParams([
      { tag: 'defp', args: [10, 37] },
      { tag: 'dru', args: [3, 0] },
      { tag: 'hste', args: [20] },
      { tag: 'hpi', args: [102] },
      { tag: 'er', args: [9] },
      { tag: 'ru', args: [20] },
      { tag: 'getv', args: [1] },
    ]))
    expect(t).toMatchObject({ physDefencePct: 10, magDefence: 37, physDamagePct: 3, speedPct: 20, maxHp: 102, parryRate: 9, range: 2 })
    const c = applyMods({ ...stats({ physDefence: 100, magDefence: 10, parryRate: 10 }), range: 1 }, t)
    expect(c).toMatchObject({ physDefence: 110, magDefence: 47, parryRate: 19, range: 3, physDamagePct: 3 })
  })

  it('skill hits add the flat damage and the multiplier; imbues add a magical component; reduction shrinks secondaries', () => {
    const r = () => 0.5
    const plain = rollSkillHit(stats(), stats(), { pct: 100 }, r)
    expect(plain.outcome).toBe('hit')
    expect(rollSkillHit(stats(), stats(), { pct: 100, flat: [20, 20] }, r).damage).toBeGreaterThan(plain.damage)
    expect(rollSkillHit(stats(), stats(), { pct: 100, mul: 0.5 }, r).damage).toBe(Math.round(plain.damage / 2))
    expect(rollSkillHit(stats({ physDamagePct: 10 }), stats(), { pct: 100 }, r).damage).toBe(Math.round(plain.damage * 1.1))
    expect(rollSkillHit(stats(), stats(), { pct: 100, critBonus: 100 }, () => 0.4).outcome).toBe('crit') // capped at CRIT_MAX 50 %
    expect(imbueDamage(stats(), stats({ magDefence: 1000 }), 100, [0, 0], r)).toBeGreaterThanOrEqual(1)
    expect(imbueDamage(stats(), stats(), 100, [40, 40], r)).toBe(140)
    expect(reductionMul(35)).toBeCloseTo(0.65)
    expect(reductionMul(0)).toBe(1)
  })
})
