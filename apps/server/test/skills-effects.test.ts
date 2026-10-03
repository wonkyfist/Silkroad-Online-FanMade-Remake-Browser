/**
 * Skills engine: effects (docs/SKILLS.md §10.1 "Imbues", "Buffs / debuffs model"; docs/WAVE_PLAN.md §4.3 tests).
 * Imbues on basic hits, replacement, buff overlap and expiry, buffCancel, toggles, passives, move speed, late joiners
 * and death.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { skillHarness } from './skills-fixtures.ts'

let h: ReturnType<typeof skillHarness>
afterEach(() => h?.cleanup())

describe('imbues', () => {
  it('add a magical component to a basic hit and roll their statuses; a new imbue replaces the old', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 1.5)
    const plain = h.dummy(1, 1.5)
    h.learn(p, ['SKILL_CH_COLD_GIGONGTA_A_01', 'SKILL_CH_FIRE_GIGONGTA_A_01'])
    // a basic hit without the imbue, for comparison (constant rng: identical rolls)
    h.req(p, { t: 'attack', target: plain.id })
    h.runTo(h.now + 60)
    const base = h.all(inbox, 'combat').find((c) => c.target === plain.id)!.hits[0].damage
    h.req(p, { t: 'stopAction' })
    h.runTo(h.now + 1000)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_GIGONGTA_A_01' })
    const cold = h.all(inbox, 'effectAdd').at(-1)!
    expect(cold).toMatchObject({ id: p.id, effect: { skill: 'SKILL_CH_COLD_GIGONGTA_A_01', remainingMs: 5000 } })
    h.req(p, { t: 'attack', target: m.id })
    h.runTo(h.now + 60)
    const hit = h.all(inbox, 'combat').find((c) => c.target === m.id)!.hits[0]
    expect(hit.damage).toBeGreaterThan(base)
    expect(hit.status).toBe('frostbite')
    expect(h.all(inbox, 'effectAdd').some((e) => e.id === m.id && e.effect.status === 'frostbite')).toBe(true)
    // Fire replaces Cold (same overlap class 1)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_FIRE_GIGONGTA_A_01' })
    expect(h.all(inbox, 'effectRemove').find((e) => e.instance === cold.effect.instance)).toMatchObject({ id: p.id, reason: 'replaced' })
    expect(h.gameplay.skills.effects.list(p.id).filter((e) => e.kind === 'imbue').map((e) => e.skill!.code)).toEqual(['SKILL_CH_FIRE_GIGONGTA_A_01'])
  })

  it('burn ticks damage every second through dealHits, credited to the caster', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 1.5)
    h.learn(p, ['SKILL_CH_FIRE_GIGONGTA_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_FIRE_GIGONGTA_A_01' })
    h.req(p, { t: 'attack', target: m.id })
    h.runTo(h.now + 60)
    h.req(p, { t: 'stopAction' })
    const before = h.all(inbox, 'combat').length
    h.runTo(h.now + 5200)
    const ticks = h.all(inbox, 'combat').slice(before).filter((c) => c.attacker === p.id && c.hits[0].damage === 5)
    expect(ticks.length).toBe(5)
    expect(ticks[0].skill).toBe('SKILL_CH_FIRE_GIGONGTA_A_01')
    expect(m.damage.get(p.id)).toBeGreaterThan(25)
  })

  it('a chain imbue bounces its component to the nearest other enemy (aoe, reduced)', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 1.5)
    const other = h.dummy(2, 2)
    h.learn(p, ['SKILL_CH_LIGHTNING_GIGONGTA_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_LIGHTNING_GIGONGTA_A_01' })
    h.req(p, { t: 'attack', target: m.id })
    h.runTo(h.now + 60)
    const bounce = h.all(inbox, 'combat').find((c) => c.target === other.id)
    expect(bounce).toMatchObject({ aoe: true, skill: 'SKILL_CH_LIGHTNING_GIGONGTA_A_01' })
  })
})

describe('buffs', () => {
  it('Weak Guard of Ice: READY/WAIT/SHOT, then effectAdd + stats with PD up; buffCancel -> effectRemove cancelled + PD back', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10, wear: ['ITEM_CH_SHIELD_01_A'] })
    h.learn(p, ['SKILL_CH_COLD_GANGGI_A_01'])
    const pd = p.combat.physDefence
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_GANGGI_A_01' })
    expect(h.all(inbox, 'cast').at(-1)).toMatchObject({ prepareMs: 1000, castMs: 1000, actionMs: 1000 })
    h.runTo(h.now + 1950)
    expect(h.all(inbox, 'effectAdd')).toHaveLength(0)
    h.runTo(h.now + 100)
    const add = h.all(inbox, 'effectAdd')[0]
    expect(add).toMatchObject({ id: p.id, effect: { skill: 'SKILL_CH_COLD_GANGGI_A_01', remainingMs: 300000, source: p.id } })
    expect(p.combat.physDefence).toBe(Math.round(pd * 1.1))
    expect(h.all(inbox, 'stats').at(-1)!.stats.physDefence).toBe(p.combat.physDefence)
    h.req(p, { t: 'buffCancel', skill: 'SKILL_CH_COLD_GANGGI_A_01' })
    expect(h.result(inbox, 'buffCancel')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'effectRemove').at(-1)).toMatchObject({ id: p.id, instance: add.effect.instance, reason: 'cancelled' })
    expect(p.combat.physDefence).toBe(pd)
    h.req(p, { t: 'buffCancel', skill: 'SKILL_CH_COLD_GANGGI_A_01' })
    expect(h.result(inbox, 'buffCancel')).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('expiry -> effectRemove expired + stats; a same-class buff replaces the old one', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10, wear: ['ITEM_CH_SHIELD_01_A'] })
    h.learn(p, ['SKILL_CH_SWORD_SHIELD_A_01'])
    const pd = p.combat.physDefence
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SHIELD_A_01' })
    // zero-length action: applied at once, no action left running
    expect(h.gameplay.skills.busy(p, h.now)).toBe(false)
    expect(p.combat.physDefence).toBe(pd + 50)
    const first = h.all(inbox, 'effectAdd')[0]
    h.runTo(h.now + 15_050)
    expect(h.all(inbox, 'effectRemove').at(-1)).toMatchObject({ instance: first.effect.instance, reason: 'expired' })
    expect(p.combat.physDefence).toBe(pd)
    expect(h.all(inbox, 'stats').at(-1)!.stats.physDefence).toBe(pd)
    // same group again after the cooldown: the new instance replaces the old
    h.gameplay.skills.gmClearCooldowns(p)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SHIELD_A_01' })
    h.gameplay.skills.gmClearCooldowns(p)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SHIELD_A_01' })
    const adds = h.all(inbox, 'effectAdd')
    expect(h.all(inbox, 'effectRemove').at(-1)).toMatchObject({ instance: adds.at(-2)!.effect.instance, reason: 'replaced' })
    expect(h.gameplay.skills.effects.list(p.id)).toHaveLength(1)
    expect(p.combat.physDefence).toBe(pd + 50)
  })

  it('taking the shield off ends the buff that needs it and the shield passive', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10, wear: ['ITEM_CH_SHIELD_01_A'] })
    const block = p.combat.blockRate
    h.learn(p, ['SKILL_CH_SWORD_SHIELD_A_01', 'SKILL_CH_SWORD_PASSIVE_A_01'])
    expect(p.combat.blockRate).toBe(block + 15)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SHIELD_A_01' })
    h.req(p, { t: 'itemUnequip', slot: 'shield' })
    expect(h.result(inbox, 'itemUnequip')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'effectRemove').at(-1)).toMatchObject({ reason: 'cancelled' })
    expect(p.combat.blockRate).toBe(0)
  })

  it('Grass Walk (instant) speeds the player up, combined with a GM speed', () => {
    h = skillHarness()
    const { p } = h.hero({ level: 10 })
    h.learn(p, ['SKILL_CH_LIGHTNING_GYEONGGONG_A_01'])
    h.world.setSpeed(p, 2, h.now)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_LIGHTNING_GYEONGGONG_A_01' })
    expect(p.speedMul).toBeCloseTo(2.4)
    h.req(p, { t: 'buffCancel', skill: 'SKILL_CH_LIGHTNING_GYEONGGONG_A_01' })
    expect(p.speedMul).toBeCloseTo(2)
  })

  it('toggle: on until used again, drains MP every interval and ends at 0 MP; its wall absorbs physical damage', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10 })
    h.learn(p, ['SKILL_CH_COLD_BINGBYEOK_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_BINGBYEOK_A_01' })
    const on = h.all(inbox, 'effectAdd').at(-1)!
    expect(on.effect.remainingMs).toBe(0)
    const mp = p.mp
    p.lastCombatAt = h.now + 60_000 // no out-of-combat regeneration in the way
    h.runTo(h.now + 5050)
    expect(p.mp).toBe(mp - 40)
    // the wall (100) takes a mob's hit first
    const tiger = h.dummy(0, 1, { physAttack: [60, 60], hitRate: 1e6, attackIntervalMs: 100000, aggressive: true, walkSpeed: 1, runSpeed: 1, level: 1 })
    const hp = p.hp
    h.gameplay.attack(tiger, p, h.now)
    expect(p.hp).toBe(hp)
    // using it again turns it off (no cost, no cooldown check)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_BINGBYEOK_A_01' })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'effectRemove').at(-1)).toMatchObject({ instance: on.effect.instance, reason: 'cancelled' })
    // on again, then MP runs out
    h.gameplay.skills.gmClearCooldowns(p)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_BINGBYEOK_A_01' })
    h.gameplay.setVitals(p, p.hp, 10)
    h.runTo(h.now + 5100)
    expect(h.all(inbox, 'effectRemove').at(-1)).toMatchObject({ reason: 'expired' })
    expect(h.gameplay.skills.effects.list(p.id)).toHaveLength(0)
  })
})

describe('passives, late joiners, death', () => {
  it('a passive changes the stats totals once learned; hpi raises maxHp', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10 })
    const max = p.maxHp
    h.learn(p, ['SKILL_CH_SPEAR_PASSIVE_A_01'])
    expect(p.maxHp).toBe(max + 100)
    expect(h.all(inbox, 'stats').at(-1)!.stats.maxHp).toBe(max + 100)
    expect(h.all(inbox, 'entityUpdate').at(-1)).toMatchObject({ id: p.id, maxHp: max + 100 })
  })

  it('a relog keeps the passive HP (world.add clamps without passives; enter restores)', () => {
    h = skillHarness()
    const { p, id } = h.hero({ level: 10 })
    h.learn(p, ['SKILL_CH_SPEAR_PASSIVE_A_01'])
    h.gameplay.setVitals(p, p.maxHp, p.mp)
    const full = p.maxHp
    h.world.remove(p.id, h.now)
    h.gameplay.forget(p)
    const again = h.hero({ characterId: id })
    expect(again.p.maxHp).toBe(full)
    expect(again.p.hp).toBe(full)
  })

  it('a late joiner sees the effects in EntityState; death clears all but the passives', () => {
    h = skillHarness()
    const { p, inbox } = h.hero({ level: 10 })
    h.learn(p, ['SKILL_CH_LIGHTNING_GYEONGGONG_A_01', 'SKILL_CH_SPEAR_PASSIVE_A_01', 'SKILL_CH_COLD_GIGONGTA_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_LIGHTNING_GYEONGGONG_A_01' })
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_GIGONGTA_A_01' })
    const { seen } = h.hero({ pos: [3, 0, 3] })
    expect(seen.find((s) => s.id === p.id)?.effects?.map((e) => e.skill).sort()).toEqual(['SKILL_CH_COLD_GIGONGTA_A_01', 'SKILL_CH_LIGHTNING_GYEONGGONG_A_01'])
    const max = p.maxHp
    h.gameplay.gmKill(p, h.now)
    expect(h.all(inbox, 'effectRemove').filter((e) => e.reason === 'death')).toHaveLength(2)
    expect(h.gameplay.skills.effects.list(p.id)).toHaveLength(0)
    expect(p.maxHp).toBe(max)
    expect(p.speedMul).toBeCloseTo(1)
  })
})
