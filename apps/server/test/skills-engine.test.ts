/**
 * Skills engine: using skills (docs/SKILLS.md §5, §10.1; docs/WAVE_PLAN.md §4.3 tests). Validation reasons in the
 * §10.1 order, MP and per-group cooldowns, the action timeline on the 20 Hz tick, chains, projectiles, areas,
 * crowd control, interrupts, queueing and the basic attack rows. Synthetic content (skills-fixtures.ts), a constant
 * rng (every hit lands, 100 % statuses stick) and a hand-driven clock.
 */
import type { ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { skillHarness } from './skills-fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

let h: ReturnType<typeof skillHarness>
afterEach(() => h?.cleanup())

const TICK = 50

function setup(o: Parameters<typeof skillHarness>[0] = {}) {
  h = skillHarness(o)
  return h
}

describe('validation (docs/SKILLS.md §10.1 order)', () => {
  it('not_found, not_learned, dead, cant_act, wrong_weapon, requirements, no_ammo, cooldown, not_enough_mp, targets, safe_zone', () => {
    setup({ skillAmmo: 1 })
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    const use = (skill: string, target?: number) => {
      h.req(p, target === undefined ? { t: 'useSkill', skill } : { t: 'useSkill', skill, target })
      return h.result(inbox, 'useSkill')
    }
    expect(use('SKILL_CH_NOPE_01', m.id)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(use('SKILL_CH_SWORD_BASE_01', m.id)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(use('SKILL_CH_SWORD_SMASH_A_01', m.id)).toMatchObject({ ok: false, reason: 'not_learned' })
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01', 'SKILL_CH_SPEAR_PIERCE_A_01', 'SKILL_CH_SWORD_SHIELD_A_01', 'SKILL_CH_BOW_CRITICAL_A_01', 'SKILL_CH_SWORD_PASSIVE_A_01'])
    expect(use('SKILL_CH_SWORD_PASSIVE_A_01')).toMatchObject({ ok: false, reason: 'not_usable' })
    // stunned
    h.gameplay.skills.effects.add({ instance: 999, carrier: p.id, source: m.id, kind: 'status', status: 'stun', overlap: 0, mods: [], startedAt: h.now, until: h.now + 1000 })
    expect(use('SKILL_CH_SWORD_SMASH_A_01', m.id)).toMatchObject({ ok: false, reason: 'cant_act' })
    h.gameplay.skills.effects.remove(p.id, 999)
    expect(use('SKILL_CH_SPEAR_PIERCE_A_01', m.id)).toMatchObject({ ok: false, reason: 'wrong_weapon' })
    expect(use('SKILL_CH_SWORD_SHIELD_A_01')).toMatchObject({ ok: false, reason: 'requirements' })
    // no MP
    h.gameplay.setVitals(p, p.hp, 5)
    expect(use('SKILL_CH_SWORD_SMASH_A_01', m.id)).toMatchObject({ ok: false, reason: 'not_enough_mp' })
    h.gameplay.setVitals(p, p.hp, p.maxMp)
    // targets
    expect(use('SKILL_CH_SWORD_SMASH_A_01')).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(use('SKILL_CH_SWORD_SMASH_A_01', 424242)).toMatchObject({ ok: false, reason: 'not_found' })
    const { p: other } = h.hero({ pos: [1, 0, 0] })
    expect(use('SKILL_CH_SWORD_SMASH_A_01', other.id)).toMatchObject({ ok: false, reason: 'invalid_target', message: 'no PvP' })
    const corpse = h.dummy(0, 3)
    h.gameplay.gmKill(corpse, h.now)
    expect(use('SKILL_CH_SWORD_SMASH_A_01', corpse.id)).toMatchObject({ ok: false, reason: 'target_dead' })
    // cooldown: the first use arms it
    expect(use('SKILL_CH_SWORD_SMASH_A_01', m.id)).toMatchObject({ ok: true })
    h.runTo(h.now + 1500)
    expect(use('SKILL_CH_SWORD_SMASH_A_01', m.id)).toMatchObject({ ok: false, reason: 'cooldown' })
    // safe zone (the town's safe area is around 200, 200)
    const { p: townie, inbox: tin } = h.hero({ pos: [200, 0, 200], level: 10 })
    h.learn(townie, ['SKILL_CH_SWORD_SMASH_A_01'])
    const tm = h.dummy(200, 202)
    h.req(townie, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: tm.id })
    expect(h.result(tin, 'useSkill')).toMatchObject({ ok: false, reason: 'safe_zone' })
    // no ammo (SKILL_AMMO=1): a bow skill without arrows
    const { p: archer, inbox: ain } = h.hero({ weapon: 'bow', pos: [0, 0, -5] })
    h.learn(archer, ['SKILL_CH_BOW_CRITICAL_A_01'])
    h.req(archer, { t: 'useSkill', skill: 'SKILL_CH_BOW_CRITICAL_A_01', target: m.id })
    expect(h.result(ain, 'useSkill')).toMatchObject({ ok: false, reason: 'no_ammo' })
    h.gameplay.gmItem(archer, h.data.item('ITEM_ETC_AMMO_ARROW_01')!, 'ITEM_ETC_AMMO_ARROW_01', 5)
    h.req(archer, { t: 'useSkill', skill: 'SKILL_CH_BOW_CRITICAL_A_01', target: m.id })
    expect(h.result(ain, 'useSkill'), JSON.stringify(h.result(ain, 'useSkill'))).toMatchObject({ ok: true })
    const bag = h.store.loadInventory(archer.characterId).bag.find((i) => i?.code === 'ITEM_ETC_AMMO_ARROW_01')
    expect(bag?.count).toBe(4)
  })

  it('a dead player gets dead (the Gameplay dead check); unlearned rows of a learned line run the learned level', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_02'], 5)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'cast').at(-1)).toMatchObject({ skill: 'SKILL_CH_SWORD_SMASH_A_02' })
    h.gameplay.gmKill(p, h.now)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'dead' })
  })
})

describe('MP, cooldown and timing', () => {
  it('pays MP at t0, sends cast, releases at cast time and ends at + action (±1 tick)', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01'])
    const mp = p.mp
    const t0 = h.now
    inbox.length = 0
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    expect(inbox.map((x) => x.t).slice(0, 3)).toEqual(['actionResult', 'cast', 'statsDelta'])
    expect(p.mp).toBe(mp - 20)
    expect(h.all(inbox, 'cast')[0]).toMatchObject({ id: p.id, skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id, prepareMs: 0, castMs: 400, actionMs: 1000 })
    let hitAt = 0
    let freeAt = 0
    while (h.now < t0 + 3000) {
      h.runTo(h.now + TICK)
      if (!hitAt && h.all(inbox, 'combat').length) hitAt = h.now
      if (!freeAt && !h.gameplay.skills.busy(p, h.now)) freeAt = h.now
    }
    expect(Math.abs(hitAt - (t0 + 400))).toBeLessThanOrEqual(TICK)
    expect(Math.abs(freeAt - (t0 + 1400))).toBeLessThanOrEqual(TICK)
    const c = h.all(inbox, 'combat')[0]
    expect(c).toMatchObject({ attacker: p.id, target: m.id, skill: 'SKILL_CH_SWORD_SMASH_A_01', instance: h.all(inbox, 'cast')[0].instance })
    // the cooldown (3000 ms from t0) is per group and ends on time
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
  })

  it('cooldowns are keyed by character: they survive a relog (and are sent in skills)', () => {
    setup()
    const { p, id } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    h.world.remove(p.id, h.now)
    h.gameplay.forget(p)
    h.runTo(h.now + 500)
    const again = h.hero({ characterId: id })
    const skills = h.all(again.inbox, 'skills')[0]
    expect(skills.cooldowns).toEqual([{ group: 'SKILL_CH_SWORD_SMASH_A', readyInMs: 2500 }])
    const m2 = h.dummy(0, 2)
    h.req(again.p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m2.id })
    expect(h.result(again.inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'cooldown' })
  })

  it('a charged skill runs READY then WAIT: prepareMs in cast, release at prepare + cast', () => {
    setup()
    const { p, inbox } = h.hero({ weapon: 'bow', level: 10 })
    const m = h.dummy(0, 10)
    h.learn(p, ['SKILL_CH_BOW_CRITICAL_A_01'])
    const t0 = h.now
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_BOW_CRITICAL_A_01', target: m.id })
    expect(h.all(inbox, 'cast')[0]).toMatchObject({ prepareMs: 700, castMs: 300, actionMs: 500 })
    h.runTo(t0 + 950)
    expect(h.all(inbox, 'combat')).toHaveLength(0)
    h.runTo(t0 + 1000)
    expect(h.all(inbox, 'combat')).toHaveLength(1)
  })
})

describe('interrupts and the queue', () => {
  it('moveTo before the release -> castEnd interrupted, the cost and cooldown stay; after the release nothing is cancelled', () => {
    setup()
    const { p, inbox } = h.hero({ weapon: 'bow', level: 10 })
    const m = h.dummy(0, 10)
    h.learn(p, ['SKILL_CH_BOW_CRITICAL_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_BOW_CRITICAL_A_01', target: m.id })
    const cast = h.all(inbox, 'cast')[0]
    const mp = p.mp
    h.runTo(h.now + 300)
    expect(h.gameplay.onMoveTo(p, h.now)).toBe(true)
    h.world.moveTo(p, 5, 0, h.now)
    expect(h.all(inbox, 'castEnd')).toEqual([{ t: 'castEnd', id: p.id, instance: cast.instance, reason: 'interrupted' }])
    h.runTo(h.now + 2000)
    expect(h.all(inbox, 'combat')).toHaveLength(0)
    expect(p.mp).toBeGreaterThanOrEqual(mp)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_BOW_CRITICAL_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'cooldown' })
  })

  it('stopAction before the release -> cancelled; after the release the hit still lands', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01', 'SKILL_CH_SWORD_KNOCKDOWN_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    h.runTo(h.now + 100)
    h.req(p, { t: 'stopAction' })
    expect(h.all(inbox, 'castEnd').at(-1)).toMatchObject({ reason: 'cancelled' })
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_KNOCKDOWN_A_01', target: m.id })
    h.runTo(h.now + 750)
    expect(h.all(inbox, 'combat')).toHaveLength(1)
    h.req(p, { t: 'stopAction' })
    expect(h.all(inbox, 'castEnd')).toHaveLength(1)
  })

  it('a use while busy queues one skill; it starts when the action ends; a newer request replaces it', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01', 'SKILL_CH_SWORD_KNOCKDOWN_A_01', 'SKILL_CH_SWORD_GEOMGI_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    const end = h.now + 1400
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_GEOMGI_A_01', target: m.id })
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_KNOCKDOWN_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'cast')).toHaveLength(1)
    h.runTo(end - TICK)
    expect(h.all(inbox, 'cast')).toHaveLength(1)
    h.runTo(end + TICK)
    expect(h.all(inbox, 'cast').map((c) => c.skill)).toEqual(['SKILL_CH_SWORD_SMASH_A_01', 'SKILL_CH_SWORD_KNOCKDOWN_A_01'])
  })

  it('instant skills apply at once and leave the running action alone', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01', 'SKILL_CH_COLD_GIGONGTA_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_GIGONGTA_A_01' })
    expect(h.all(inbox, 'cast').map((c) => [c.skill, c.instant ?? false])).toEqual([
      ['SKILL_CH_SWORD_SMASH_A_01', false],
      ['SKILL_CH_COLD_GIGONGTA_A_01', true],
    ])
    expect(h.all(inbox, 'effectAdd')).toHaveLength(1)
    expect(h.gameplay.skills.busy(p, h.now)).toBe(true)
  })

  it('out of reach: walks into range first (like auto-attack), then casts', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 20)
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    expect(p.action?.kind).toBe('skill')
    expect(h.all(inbox, 'cast')).toHaveLength(0)
    h.runTo(h.now + 5000)
    expect(h.all(inbox, 'move').length).toBeGreaterThan(0)
    expect(h.all(inbox, 'cast')).toHaveLength(1)
    expect(h.all(inbox, 'combat').length).toBeGreaterThan(0)
  })
})

describe('chains, projectiles and areas', () => {
  it('Illusion Chain: three segments, one instance, each a cast and a combat; only the head costs', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_CHAIN_A_1S_01'])
    const mp = p.mp
    const t0 = h.now
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_CHAIN_A_1S_01', target: m.id })
    h.runTo(t0 + 2500)
    const casts = h.all(inbox, 'cast')
    const combats = h.all(inbox, 'combat').filter((c) => c.instance !== undefined)
    expect(casts.map((c) => c.skill)).toEqual(['SKILL_CH_SWORD_CHAIN_A_1S_01', 'SKILL_CH_SWORD_CHAIN_A_2S_01', 'SKILL_CH_SWORD_CHAIN_A_3S_01'])
    expect(new Set(casts.map((c) => c.instance)).size).toBe(1)
    expect(combats.map((c) => c.skill)).toEqual(casts.map((c) => c.skill))
    expect(combats.every((c) => c.instance === casts[0].instance)).toBe(true)
    expect(p.mp).toBe(mp - 30)
    // segment ends: 400, 400 + 600, then + 1000 -> free at 2000
    expect(h.gameplay.skills.busy(p, t0 + 1950)).toBe(false)
  })

  it('a chain aborts when its target dies (castEnd target_lost)', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_CHAIN_A_1S_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_CHAIN_A_1S_01', target: m.id })
    h.gameplay.gmKill(m, h.now)
    h.runTo(h.now + 2500)
    expect(h.all(inbox, 'cast')).toHaveLength(1)
    expect(h.all(inbox, 'castEnd')).toEqual([{ t: 'castEnd', id: p.id, instance: h.all(inbox, 'cast')[0].instance, reason: 'target_lost' }])
  })

  it('projectile: combat.at = release + distance / (speed / 10), damage applied then', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 9)
    h.learn(p, ['SKILL_CH_SWORD_GEOMGI_A_01'])
    const t0 = h.now
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_GEOMGI_A_01', target: m.id })
    const hp = m.hp
    const release = t0 + 300
    const at = release + Math.round((9 / 30) * 1000)
    h.runTo(at - TICK)
    expect(h.all(inbox, 'combat')).toHaveLength(0)
    expect(m.hp).toBe(hp)
    h.runTo(at + TICK)
    const c = h.all(inbox, 'combat')
    expect(c).toHaveLength(1)
    expect(c[0].at).toBe(at)
    expect(m.hp).toBeLessThan(hp)
  })

  it('target area: maxTargets includes the primary; secondaries get aoe and take reductionPct less', () => {
    setup()
    const { p, inbox } = h.hero({ weapon: 'spear', level: 10 })
    const m = h.dummy(0, 3)
    const near = [h.dummy(1, 3), h.dummy(-1, 3.5), h.dummy(0.5, 4)]
    h.dummy(0, 9)
    h.learn(p, ['SKILL_CH_SPEAR_FRONTAREA_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SPEAR_FRONTAREA_A_01', target: m.id })
    h.runTo(h.now + 1000)
    const c = h.all(inbox, 'combat')
    expect(c).toHaveLength(3)
    expect(c[0]).toMatchObject({ target: m.id })
    expect(c[0].aoe).toBeUndefined()
    expect(c.slice(1).every((x) => x.aoe === true && near.some((n) => n.id === x.target))).toBe(true)
    // same rolls (constant rng): a secondary takes half (reductionPct 50)
    expect(c[1].hits[0].damage).toBe(Math.round(c[0].hits[0].damage * 0.5))
  })

  it('pierce: hits the one behind the target on the line', () => {
    setup()
    const { p, inbox } = h.hero({ weapon: 'spear', level: 10 })
    const m = h.dummy(0, 3)
    const behind = h.dummy(0, 4.5)
    h.dummy(3, 3)
    h.learn(p, ['SKILL_CH_SPEAR_PIERCE_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SPEAR_PIERCE_A_01', target: m.id })
    h.runTo(h.now + 700)
    expect(h.all(inbox, 'combat').map((c) => c.target)).toEqual([m.id, behind.id])
  })
})

describe('crowd control', () => {
  it('a stunned mob does not act; a knocked-down target enables the down attack (invalid_target otherwise)', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2, { attackIntervalMs: 200 })
    h.learn(p, ['SKILL_CH_SWORD_KNOCKDOWN_A_01', 'SKILL_CH_SWORD_DOWNATTACK_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_DOWNATTACK_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'invalid_target' })
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_KNOCKDOWN_A_01', target: m.id })
    h.runTo(h.now + 750)
    const hit = h.all(inbox, 'combat')[0].hits[0]
    expect(hit).toMatchObject({ status: 'knockdown', down: true })
    expect(h.all(inbox, 'effectAdd').at(-1)).toMatchObject({ id: m.id, effect: { status: 'knockdown' } })
    // held: the mob (which retaliates) swings at nobody while it is down
    const swingsBefore = h.all(inbox, 'combat').filter((c) => c.attacker === m.id).length
    h.runTo(h.now + 400)
    expect(h.all(inbox, 'combat').filter((c) => c.attacker === m.id).length).toBe(swingsBefore)
    expect(h.gameplay.skills.held(m, h.now)).toBe(true)
    // after the action ends, the down attack is accepted while the target is still down
    h.runTo(h.now + 700)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_DOWNATTACK_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    h.runTo(h.now + 3000)
    expect(h.all(inbox, 'effectRemove').some((e) => e.id === m.id && e.reason === 'expired')).toBe(true)
    expect(h.gameplay.skills.held(m, h.now)).toBe(false)
  })

  it('stun from a skill status (data duration) holds the mob for 5 s', () => {
    setup()
    const { p, inbox } = h.hero({ weapon: 'spear', level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SPEAR_STUN_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SPEAR_STUN_A_01', target: m.id })
    h.runTo(h.now + 1150)
    const add = h.all(inbox, 'effectAdd').find((e) => e.id === m.id)!
    expect(add.effect).toMatchObject({ status: 'stun', remainingMs: 5000, source: p.id })
    expect(h.gameplay.skills.held(m, h.now + 4900)).toBe(true)
  })
})

describe('basic attacks', () => {
  it('read the weapon row: hits, percent and cadence (sword 2 x 50 % every 1000 ms here); combat.skill = the row', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 1.5)
    expect(h.gameplay.skills.basicFor(p)).toMatchObject({ hits: 2, pct: 50, intervalMs: 1000 })
    h.req(p, { t: 'attack', target: m.id })
    h.runTo(h.now + 2100)
    const c = h.all(inbox, 'combat').filter((x) => x.attacker === p.id)
    expect(c).toHaveLength(3)
    expect(c[0].hits).toHaveLength(2)
    expect(c[0].skill).toBe('SKILL_CH_SWORD_BASE_01')
  })

  it('a skill pauses auto-attack and it resumes on the skill target afterwards', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 1.5)
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01'])
    h.req(p, { t: 'attack', target: m.id })
    h.runTo(h.now + 100)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    const start = h.now
    h.runTo(start + 1350)
    const during = h.all(inbox, 'combat').filter((x) => x.attacker === p.id && x.skill === 'SKILL_CH_SWORD_BASE_01')
    h.runTo(start + 2600)
    const after = h.all(inbox, 'combat').filter((x) => x.attacker === p.id && x.skill === 'SKILL_CH_SWORD_BASE_01')
    expect(during).toHaveLength(1) // the swing before the skill
    expect(after.length).toBeGreaterThan(1)
    expect(p.action).toMatchObject({ kind: 'attack', target: m.id })
  })

  it('bow basic attacks take an arrow with SKILL_AMMO=1 and stop without one', () => {
    setup({ skillAmmo: 1 })
    const { p, inbox } = h.hero({ weapon: 'bow', level: 10 })
    const m = h.dummy(0, 5)
    h.gameplay.gmItem(p, h.data.item('ITEM_ETC_AMMO_ARROW_01')!, 'ITEM_ETC_AMMO_ARROW_01', 1)
    h.req(p, { t: 'attack', target: m.id })
    h.runTo(h.now + 2000)
    expect(h.all(inbox, 'combat').filter((x) => x.attacker === p.id)).toHaveLength(1)
    expect(p.action).toBeNull()
    expect(h.all(inbox, 'chat').some((c) => /no arrows/.test(c.text))).toBe(true)
  })
})

describe('heal and resurrect (decisions 13, 14)', () => {
  it('Heal targets any visible player within 15 m (walking there first), self by default', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10, name: 'Healer' })
    const { p: friend, inbox: fin } = h.hero({ pos: [0, 0, 25], name: 'Friend' })
    h.learn(p, ['SKILL_CH_WATER_HEAL_A_01'])
    h.gameplay.setVitals(friend, 50, friend.mp)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_WATER_HEAL_A_01', target: friend.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    h.runTo(h.now + 6000)
    expect(friend.hp).toBe(Math.min(friend.maxHp, 350))
    expect(h.all(fin, 'statsDelta').some((d) => d.stats.hp === Math.round(friend.hp))).toBe(true)
    // a monster selected: the heal lands on the caster
    const m = h.dummy(0, 2)
    h.gameplay.skills.gmClearCooldowns(p)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_WATER_HEAL_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'cast').at(-1)!.target).toBeUndefined()
  })

  it('Soul Rebirth Art stands a dead player up where it lies (entityUpdate alive, stats), no warp', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const { p: dead, inbox: din } = h.hero({ pos: [0, 0, 3] })
    h.learn(p, ['SKILL_CH_WATER_RESURRECTION_A_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_WATER_RESURRECTION_A_01', target: dead.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'invalid_target' })
    h.gameplay.gmKill(dead, h.now)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_WATER_RESURRECTION_A_01', target: dead.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    h.runTo(h.now + 4100)
    expect(dead.dead).toBe(false)
    expect(h.all(din, 'entityUpdate').find((u) => u.id === dead.id && u.state === 'alive')).toMatchObject({ hp: Math.round(dead.maxHp * 0.1), maxHp: dead.maxHp })
    expect(h.all(din, 'warp')).toHaveLength(0)
  })
})

describe('protocol shape', () => {
  it('every message the engine sends passes the client parser', async () => {
    const { parseServerMessage } = await import('@sro/shared')
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01', 'SKILL_CH_COLD_GIGONGTA_A_01', 'SKILL_CH_COLD_GANGGI_A_01', 'SKILL_CH_SWORD_CHAIN_A_1S_01'])
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_GIGONGTA_A_01' })
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    h.runTo(h.now + 1500)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_GANGGI_A_01' })
    h.runTo(h.now + 3500)
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_CHAIN_A_1S_01', target: m.id })
    h.runTo(h.now + 3000)
    for (const msg of inbox) {
      const r = parseServerMessage(JSON.stringify(msg))
      expect(r.ok, `${msg.t}: ${JSON.stringify(msg)} ${r.ok ? '' : r.error}`).toBe(true)
    }
    const kinds = new Set(inbox.map((x) => x.t))
    for (const t of ['skills', 'skillsUpdate', 'cast', 'combat', 'effectAdd', 'stats'] as const) expect(kinds.has(t), t).toBe(true)
    const state = h.world.state(p)
    expect(state.effects?.length).toBeGreaterThan(0)
    void ({} as Msg<'cast'>)
  })
})
