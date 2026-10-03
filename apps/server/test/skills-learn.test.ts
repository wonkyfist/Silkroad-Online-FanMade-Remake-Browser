/**
 * Skills engine: learning, masteries, the hotbar and the GM `skill` command body (docs/SKILLS.md §1.2-§1.3, §10.1
 * "Learning"; docs/WAVE_PLAN.md decision 7, §4.3 tests).
 */
import { HOTBAR_SLOTS } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { runSkillCommand } from '../src/skills/gm-skill.ts'
import { skillHarness } from './skills-fixtures.ts'

let h: ReturnType<typeof skillHarness>
afterEach(() => h?.cleanup())

describe('masteries and learning', () => {
  it('masteryUp costs 1, 1, 1, 2, 2 SP, is capped at the character level, and saves with the SP', () => {
    h = skillHarness()
    const { p, inbox, id } = h.hero({ level: 5, sp: 7 })
    for (let i = 0; i < 5; i++) h.req(p, { t: 'masteryUp', mastery: 'BICHEON' })
    expect(h.all(inbox, 'actionResult').filter((r) => r.re === 'masteryUp').every((r) => r.ok)).toBe(true)
    expect(p.progress.sp).toBe(0)
    expect(h.all(inbox, 'skillsUpdate').map((u) => u.masteries?.BICHEON)).toEqual([1, 2, 3, 4, 5])
    expect(h.all(inbox, 'statsDelta').at(-1)!.stats.sp).toBe(0)
    h.gameplay.skills.gmAddSp(p, 50)
    h.req(p, { t: 'masteryUp', mastery: 'BICHEON' })
    expect(h.result(inbox, 'masteryUp')).toMatchObject({ ok: false, reason: 'mastery_cap' })
    h.req(p, { t: 'masteryUp', mastery: 'COLD' })
    expect(h.result(inbox, 'masteryUp')).toMatchObject({ ok: true })
    expect(h.store.characterById(id)!.sp).toBe(49)
    const saved = h.store.db.prepare('SELECT code, level FROM char_masteries WHERE character_id = ? ORDER BY code').all(id)
    expect(saved).toEqual([{ code: 'BICHEON', level: 5 }, { code: 'COLD', level: 1 }])
  })

  it('no_sp when the SP is short', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 5, sp: 0 })
    h.req(p, { t: 'masteryUp', mastery: 'FIRE' })
    expect(h.result(inbox, 'masteryUp')).toMatchObject({ ok: false, reason: 'no_sp' })
  })

  it('skillLearn needs the previous row and the mastery; sends learned + sp; chain heads are learned for the whole chain', () => {
    h = skillHarness()
    const { p, inbox, id } = h.hero({ level: 5, sp: 30 })
    h.req(p, { t: 'skillLearn', skill: 'SKILL_CH_SWORD_SMASH_A_01' })
    expect(h.result(inbox, 'skillLearn')).toMatchObject({ ok: false, reason: 'requirements' })
    for (let i = 0; i < 3; i++) h.req(p, { t: 'masteryUp', mastery: 'BICHEON' })
    h.req(p, { t: 'skillLearn', skill: 'SKILL_CH_SWORD_SMASH_A_02' })
    expect(h.result(inbox, 'skillLearn')).toMatchObject({ ok: false, reason: 'requirements' })
    h.req(p, { t: 'skillLearn', skill: 'SKILL_CH_SWORD_SMASH_A_01' })
    expect(h.result(inbox, 'skillLearn')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'skillsUpdate').at(-1)).toEqual({ t: 'skillsUpdate', learned: ['SKILL_CH_SWORD_SMASH_A_01'] })
    h.req(p, { t: 'skillLearn', skill: 'SKILL_CH_SWORD_SMASH_A_02' })
    expect(h.result(inbox, 'skillLearn')).toMatchObject({ ok: true })
    expect(p.progress.sp).toBe(30 - 3 - 2 - 3)
    h.req(p, { t: 'skillLearn', skill: 'SKILL_CH_SWORD_CHAIN_A_2S_01' })
    expect(h.all(inbox, 'skillsUpdate').at(-1)).toEqual({ t: 'skillsUpdate', learned: ['SKILL_CH_SWORD_CHAIN_A_1S_01'] })
    expect(h.store.db.prepare('SELECT grp, level FROM char_skills WHERE character_id = ? ORDER BY grp').all(id)).toEqual([
      { grp: 'SKILL_CH_SWORD_CHAIN_A', level: 1 },
      { grp: 'SKILL_CH_SWORD_SMASH_A', level: 2 },
    ])
    h.req(p, { t: 'skillLearn', skill: 'SKILL_CH_SWORD_BASE_01' })
    expect(h.result(inbox, 'skillLearn')).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('enter-world `skills`: every mastery, the highest learned row per group, 40 hotbar slots', () => {
    h = skillHarness()
    const { p, id } = h.hero({ level: 10 })
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_02', 'SKILL_CH_SWORD_CHAIN_A_1S_01'], 3)
    h.world.remove(p.id, h.now)
    h.gameplay.forget(p)
    const again = h.hero({ characterId: id })
    const s = h.all(again.inbox, 'skills')[0]
    expect(s.masteries).toMatchObject({ BICHEON: 3, HEUKSAL: 3, FORCE: 3 })
    expect(s.skills.sort()).toEqual(['SKILL_CH_SWORD_CHAIN_A_1S_01', 'SKILL_CH_SWORD_SMASH_A_02'])
    expect(s.hotbar).toHaveLength(HOTBAR_SLOTS)
    expect(again.inbox.map((m) => m.t).slice(0, 3)).toEqual(['stats', 'inventory', 'skills'])
  })
})

describe('hotbar', () => {
  it('persists skill and item entries across a relog; items only when usable; unlearned skills refused', () => {
    h = skillHarness()
    const { p, inbox, id } = h.hero({ level: 10 })
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01'])
    h.req(p, { t: 'hotbarSet', slot: 0, entry: { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' } })
    expect(h.result(inbox, 'hotbarSet')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'skillsUpdate').at(-1)).toEqual({ t: 'skillsUpdate', hotbar: [{ slot: 0, entry: { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' } }] })
    h.req(p, { t: 'hotbarSet', slot: 39, entry: { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' } })
    expect(h.result(inbox, 'hotbarSet')).toMatchObject({ ok: true })
    h.req(p, { t: 'hotbarSet', slot: 5, entry: { kind: 'item', code: 'ITEM_CH_SWORD_01_A_DEF' } })
    expect(h.result(inbox, 'hotbarSet')).toMatchObject({ ok: false, reason: 'not_usable' })
    h.req(p, { t: 'hotbarSet', slot: 6, entry: { kind: 'skill', code: 'SKILL_CH_COLD_GANGGI_A_01' } })
    expect(h.result(inbox, 'hotbarSet')).toMatchObject({ ok: false, reason: 'not_learned' })
    h.req(p, { t: 'hotbarSet', slot: 7, entry: { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' } })
    h.req(p, { t: 'hotbarSet', slot: 7, entry: null })
    h.world.remove(p.id, h.now)
    h.gameplay.forget(p)
    const again = h.hero({ characterId: id })
    const bar = h.all(again.inbox, 'skills')[0].hotbar
    expect(bar[0]).toEqual({ kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' })
    expect(bar[39]).toEqual({ kind: 'item', code: 'ITEM_ETC_HP_POTION_01' })
    expect(bar.filter(Boolean)).toHaveLength(2)
  })

  it('is allowed while dead', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10 })
    h.gameplay.gmKill(p, h.now)
    h.req(p, { t: 'hotbarSet', slot: 1, entry: { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' } })
    expect(h.result(inbox, 'hotbarSet')).toMatchObject({ ok: true })
  })
})

describe('GM skill command body', () => {
  it('skill all learns every line up to the mastery; skill <code> [level]; sp; cooldown; reset', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 1 })
    const all = runSkillCommand(h.gameplay.skills, p, ['all', '3'], 20, h.now)
    expect(all).toMatchObject({ ok: true })
    const up = h.all(inbox, 'skillsUpdate').at(-1)!
    expect(up.masteries).toMatchObject({ BICHEON: 3, COLD: 3 })
    expect(up.learned).toContain('SKILL_CH_SWORD_SMASH_A_02')
    expect(up.learned).not.toContain('SKILL_CH_SWORD_SMASH_A_03')
    expect(runSkillCommand(h.gameplay.skills, p, ['skill_ch_sword_smash_a_03'], 20, h.now)).toMatchObject({ ok: true })
    expect(h.gameplay.skills.masteriesOf(p).BICHEON).toBe(5)
    expect(runSkillCommand(h.gameplay.skills, p, ['SKILL_CH_SWORD_SMASH_A', '1'], 20, h.now)).toMatchObject({ ok: true })
    expect(runSkillCommand(h.gameplay.skills, p, ['SKILL_NOPE'], 20, h.now)).toMatchObject({ ok: false })
    expect(runSkillCommand(h.gameplay.skills, p, ['sp', '500'], 20, h.now)).toMatchObject({ ok: true, data: { sp: 500 } })
    expect(runSkillCommand(h.gameplay.skills, p, ['sp', '-1'], 20, h.now)).toMatchObject({ ok: false })
    expect(runSkillCommand(h.gameplay.skills, p, ['all', 'x'], 20, h.now)).toMatchObject({ ok: false })
    expect(runSkillCommand(h.gameplay.skills, p, [], 20, h.now)).toMatchObject({ ok: false })
    expect(runSkillCommand(h.gameplay.skills, p, ['cooldown'], 20, h.now)).toMatchObject({ ok: true })
    expect(runSkillCommand(h.gameplay.skills, p, ['reset'], 20, h.now)).toMatchObject({ ok: true })
    const snap = h.all(inbox, 'skills').at(-1)!
    expect(snap.skills).toEqual([])
    expect(Object.values(snap.masteries).every((l) => l === 0)).toBe(true)
  })
})
