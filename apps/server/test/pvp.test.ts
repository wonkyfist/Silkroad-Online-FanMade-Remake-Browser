/**
 * Open-world PvP, opt-in (docs/PVP.md) and area skills against monsters and players.
 *
 * - pure rules: the cape row of `pvpAllowed` (both caped, neither in a town, never associates / the jailed / the stockade),
 *   on (town or out of combat) and off (town, or 5 minutes after it went on and after the last PvP hit);
 * - the `pvpFlag` request: EntityState.pvp and `entityUpdate.pvp`, the refusals, the lock restarting on a PvP hit, the
 *   cape surviving a relog;
 * - fighting: caped against caped outside towns; never with one cape, in town, or within a party; a PvP death costs no EXP;
 * - area skills, one test per area type (target, caster, pierce, projectile_pierce, chain): every monster in range is hit,
 *   a caped player in range is hit when the caster is caped, an uncaped player and a party member never; a player
 *   primary's area reaches the monsters around it too.
 */
import { PVP_OFF_AFTER_MS, capePvp, pvpAllowed, pvpOffRefusal, pvpOnRefusal, type PvpSide, type ServerMessage, type SkillDef, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { Player } from '../src/world.ts'
import { SKILLS, skill, skillHarness } from './skills-fixtures.ts'

const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']
const dmg = { physPct: 100, magPct: 0, flat: [10, 10] as [number, number], hits: 1 }
const area = (shape: NonNullable<SkillDef['area']>['shape'], distance: number, maxTargets: number) => ({ shape, distance, maxTargets, reductionPct: 0, targetMask: 24, raw: [] })
// area rows for the shapes the fixtures lack (the engine reads `area` only; no projectile, so they land at release)
const EXTRA = [
  skill('SKILL_TEST_AREA_CASTER_01', { kind: 'attack', mastery: 'HEUKSAL', mp: 10, castMs: 100, actionMs: 300, range: 5, weapons: ['spear', 'glaive'], damage: dmg, targets: enemy, area: area('caster', 4, 0) }),
  skill('SKILL_TEST_AREA_PROJPIERCE_01', { kind: 'attack', mastery: 'HEUKSAL', mp: 10, castMs: 100, actionMs: 300, range: 5, weapons: ['spear', 'glaive'], damage: dmg, targets: enemy, area: area('projectile_pierce', 2, 3) }),
  skill('SKILL_TEST_AREA_CHAIN_01', { kind: 'attack', mastery: 'HEUKSAL', mp: 10, castMs: 100, actionMs: 300, range: 5, weapons: ['spear', 'glaive'], damage: dmg, targets: enemy, area: area('chain', 3, 5) }),
]
for (const s of EXTRA) if (!SKILLS.some((x) => x.code === s.code)) SKILLS.push(s)

let cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function harness() {
  const h = skillHarness({ config: { uniques: false } })
  cleanups.push(h.cleanup)
  const g = h.gameplay
  const char = (pos: Vec3, name?: string) => {
    const r = h.hero({ pos, level: 10, weapon: 'spear', ...(name ? { name } : {}) })
    r.p.maxHp = r.p.hp = 5000
    return r
  }
  const cape = (r: { p: Player; inbox: ServerMessage[] }, on = true) => {
    h.req(r.p, { t: 'pvpFlag', on })
    return h.result(r.inbox, 'pvpFlag')
  }
  const attack = (a: { p: Player; inbox: ServerMessage[] }, t: Player) => {
    h.req(a.p, { t: 'attack', target: t.id })
    return h.result(a.inbox, 'attack')
  }
  const tick = (ms: number) => h.runTo(h.now + ms)
  /** Ids the caster's hits landed on (combat messages it saw). */
  const hitIds = (r: { p: Player; inbox: ServerMessage[] }) => new Set(h.all(r.inbox, 'combat').filter((c) => c.attacker === r.p.id).map((c) => c.target))
  return { h, g, char, cape, attack, tick, hitIds }
}

// ---- pure rules -------------------------------------------------------------------------------------------------------------

describe('the PvP cape rule (pure)', () => {
  const side = (o: Partial<PvpSide> = {}): PvpSide => ({ hunter: false, wanted: false, jailed: false, pardoned: false, inStockade: false, ...o })
  it('both caped and neither in a town; never associates, the jailed or the stockade', () => {
    expect(pvpAllowed(side({ pk: true }), side({ pk: true }), false)).toBe(true)
    expect(pvpAllowed(side({ pk: true }), side(), false)).toBe(false)
    expect(pvpAllowed(side(), side({ pk: true }), false)).toBe(false)
    expect(pvpAllowed(side({ pk: true, inTown: true }), side({ pk: true }), false)).toBe(false)
    expect(pvpAllowed(side({ pk: true }), side({ pk: true, inTown: true }), false)).toBe(false)
    expect(pvpAllowed(side({ pk: true }), side({ pk: true }), true)).toBe(false)
    expect(pvpAllowed(side({ pk: true, jailed: true }), side({ pk: true }), false)).toBe(false)
    expect(pvpAllowed(side({ pk: true }), side({ pk: true, inStockade: true }), false)).toBe(false)
    // the Hunter / Wanted row is unchanged by the capes (the Wanted have no sanctuary in town)
    expect(pvpAllowed(side({ hunter: true, inTown: true }), side({ wanted: true, inTown: true }), false)).toBe(true)
    expect(capePvp({ pk: true }, { pk: true })).toBe(true)
  })
  it('on: in town always, elsewhere out of combat; off: in town, or 5 min after it went on and after the last PvP hit', () => {
    const now = 1_000_000
    expect(pvpOnRefusal(true, now - 1000, now)).toBeNull()
    expect(pvpOnRefusal(false, now - 1000, now)).toBe('in_combat')
    expect(pvpOnRefusal(false, now - 60_000, now)).toBeNull()
    expect(pvpOffRefusal(true, now, now, now)).toBeNull()
    expect(pvpOffRefusal(false, now - PVP_OFF_AFTER_MS, null, now)).toBeNull()
    expect(pvpOffRefusal(false, now - 1000, null, now)).toBeNull()
    expect(pvpOffRefusal(false, now - 2000, now - 1000, now)).toBe('locked')
    expect(pvpOffRefusal(false, now - 2 * PVP_OFF_AFTER_MS, now - 1000, now)).toBe('locked')
  })
})

// ---- the cape ---------------------------------------------------------------------------------------------------------------

describe('the PvP cape (pvpFlag)', () => {
  it('starts off; on out of combat (EntityState.pvp, entityUpdate to everyone around); refused in combat outside town', () => {
    const x = harness()
    const a = x.char([0, 0, 0])
    const b = x.char([2, 0, 0])
    x.tick(100)
    expect(x.g.pvp.isOn(a.p.characterId)).toBe(false)
    a.p.lastCombatAt = x.h.now - 1000
    expect(x.cape(a)).toMatchObject({ ok: false, reason: 'in_combat' })
    a.p.lastCombatAt = 0
    expect(x.cape(a)).toMatchObject({ ok: true })
    expect(x.g.pvp.isOn(a.p.characterId)).toBe(true)
    expect(x.h.all(b.inbox, 'entityUpdate').some((m) => m.id === a.p.id && m.pvp === true)).toBe(true)
    expect(x.h.world.snapshotFor(b.p, x.h.now).find((e) => e.id === a.p.id)?.pvp).toBe(true)
    // in town it goes on even in combat
    const c = x.char([200, 0, 200])
    c.p.lastCombatAt = x.h.now
    expect(x.cape(c)).toMatchObject({ ok: true })
  })

  it('off outside town at once without a PvP fight, else 5 min after the last PvP hit; at once in town; a relog keeps it', () => {
    const x = harness()
    const a = x.char([0, 0, 0], 'Alpha')
    const b = x.char([1, 0, 0], 'Beta')
    x.tick(100)
    expect(x.cape(a)).toMatchObject({ ok: true })
    expect(x.cape(b)).toMatchObject({ ok: true })
    // no PvP fight since it went on: off at once, and back on
    expect(x.cape(a, false)).toMatchObject({ ok: true })
    expect(x.cape(a)).toMatchObject({ ok: true })
    x.h.now += PVP_OFF_AFTER_MS - 2000
    expect(x.attack(b, a.p)).toMatchObject({ ok: true })
    x.tick(3000)
    expect(x.g.hunters.lastPvpAt(a.p.characterId)).not.toBeNull()
    // the hit restarted the lock
    expect(x.cape(a, false)).toMatchObject({ ok: false, reason: 'pvp_locked' })
    x.h.req(b.p, { t: 'stopAction' })
    // a relog does not take it off
    x.h.world.remove(a.p.id, x.h.now)
    x.g.forget(a.p)
    const back = x.h.hero({ pos: [0, 0, 0], characterId: a.p.characterId })
    expect(x.g.pvp.isOn(back.p.characterId)).toBe(true)
    // in town at once
    x.h.world.warp(back.p, 200, 0, 200, x.h.now)
    expect(x.cape(back, false)).toMatchObject({ ok: true })
    expect(x.g.pvp.isOn(back.p.characterId)).toBe(false)
    // and outside town after 5 quiet minutes
    x.h.now += PVP_OFF_AFTER_MS + 1000
    expect(x.cape(b, false)).toMatchObject({ ok: true })
  })

  it('caped against caped outside towns only; one cape, a town or a party says no; a PvP death costs no EXP', () => {
    const x = harness()
    const a = x.char([0, 0, 0], 'Alpha')
    const b = x.char([1, 0, 0], 'Beta')
    x.tick(100)
    expect(x.attack(a, b.p)).toMatchObject({ ok: false, reason: 'invalid_target', message: 'no PvP' })
    x.cape(a)
    expect(x.attack(a, b.p)).toMatchObject({ ok: false, message: 'They are not wearing the PvP cape.' })
    expect(x.attack(b, a.p)).toMatchObject({ ok: false, message: 'Put on your PvP cape to fight them.' })
    x.cape(b)
    expect(x.attack(a, b.p)).toMatchObject({ ok: true })
    // the town is safe
    x.h.req(a.p, { t: 'stopAction' })
    x.h.world.warp(a.p, 200, 0, 200, x.h.now)
    x.h.world.warp(b.p, 201, 0, 200, x.h.now)
    expect(x.attack(a, b.p)).toMatchObject({ ok: false, reason: 'safe_zone' })
    // the party never
    x.h.world.warp(a.p, 0, 0, 0, x.h.now)
    x.h.world.warp(b.p, 1, 0, 0, x.h.now)
    x.h.req(a.p, { t: 'partyInvite', target: b.p.id })
    x.h.req(b.p, { t: 'partyRespond', inviter: a.p.id, accept: true })
    expect(x.attack(a, b.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    x.h.req(b.p, { t: 'partyLeave' })
    // a death: no EXP lost
    const c = x.char([0, 0, 1], 'Gamma')
    x.tick(100)
    x.cape(c)
    c.p.hp = 1
    const exp0 = x.h.store.characterById(c.p.characterId)!.exp
    expect(x.attack(a, c.p)).toMatchObject({ ok: true })
    x.tick(3000)
    expect(c.p.dead).toBe(true)
    expect(x.h.store.characterById(c.p.characterId)!.exp).toBe(exp0)
    expect(x.h.all(c.inbox, 'chat').some((m) => m.text.includes('defeated you in PvP'))).toBe(true)
  })
})

// ---- area skills ------------------------------------------------------------------------------------------------------------

describe('area skills hit every monster in range and only the players the PvP rule allows', () => {
  /**
   * Caster at the origin, the primary monster 1 m east; `spots` puts a second monster, a caped player, an uncaped player
   * and a caped party member where the shape reaches. Returns what the caster hit.
   */
  const run = (code: string, spots: { mob: Vec3; caped: Vec3; plain: Vec3; mate: Vec3 }) => {
    const x = harness()
    const caster = x.char([0, 0, 0], 'Caster')
    const primary = x.h.dummy(1, 0)
    const mob2 = x.h.dummy(spots.mob[0], spots.mob[2])
    const caped = x.char(spots.caped, 'Caped')
    const plain = x.char(spots.plain, 'Plain')
    const mate = x.char(spots.mate, 'Mate')
    x.tick(100)
    x.cape(caster)
    x.cape(caped)
    x.cape(mate)
    x.h.req(caster.p, { t: 'partyInvite', target: mate.p.id })
    x.h.req(mate.p, { t: 'partyRespond', inviter: caster.p.id, accept: true })
    x.h.learn(caster.p, [code])
    x.h.req(caster.p, { t: 'useSkill', skill: code, target: primary.id })
    expect(x.h.result(caster.inbox, 'useSkill')).toMatchObject({ ok: true })
    x.tick(3000)
    const ids = x.hitIds(caster)
    return { ids, primary: primary.id, mob2: mob2.id, caped: caped.p.id, plain: plain.p.id, mate: mate.p.id }
  }
  const expectHits = (r: ReturnType<typeof run>, mobs: boolean, caped: boolean) => {
    expect(r.ids.has(r.primary)).toBe(true)
    expect(r.ids.has(r.mob2)).toBe(mobs)
    expect(r.ids.has(r.caped)).toBe(caped)
    expect(r.ids.has(r.plain)).toBe(false)
    expect(r.ids.has(r.mate)).toBe(false)
  }

  it('target (around the primary, 3 targets): a monster and a caped player around it', () => {
    // two candidates fit maxTargets 3 with the primary: the second monster and the caped player
    expectHits(run('SKILL_CH_SPEAR_FRONTAREA_A_01', { mob: [2, 0, 0.5], caped: [1.5, 0, -1], plain: [1, 0, 1], mate: [0.5, 0, -0.5] }), true, true)
  })
  it('caster (around the caster, unlimited): every monster and every caped player in the circle', () => {
    expectHits(run('SKILL_TEST_AREA_CASTER_01', { mob: [-2, 0, 0], caped: [0, 0, 3], plain: [0, 0, -2], mate: [-1, 0, 1] }), true, true)
  })
  it('pierce (the line through the primary, 2 targets): the caped player behind the primary', () => {
    expectHits(run('SKILL_CH_SPEAR_PIERCE_A_01', { mob: [-3, 0, 3], caped: [2, 0, 0], plain: [2.5, 0, 0.3], mate: [1.5, 0, 0.2] }), false, true)
  })
  it('projectile_pierce (the long line, 3 targets): a monster and a caped player on it', () => {
    expectHits(run('SKILL_TEST_AREA_PROJPIERCE_01', { mob: [3, 0, 0], caped: [4, 0, 0.3], plain: [2, 0, 0], mate: [2.5, 0, -0.2] }), true, true)
  })
  it('chain (hops of 3 m, 5 targets): hops across monsters and caped players, far beyond the first hop', () => {
    expectHits(run('SKILL_TEST_AREA_CHAIN_01', { mob: [3.5, 0, 0], caped: [6, 0, 0], plain: [2, 0, 1], mate: [2, 0, -1] }), true, true)
  })
  it('a caped player as the primary: the area reaches the monsters around them too; uncaped casters never hit players', () => {
    const x = harness()
    const caster = x.char([0, 0, 0], 'Caster')
    const victim = x.char([1, 0, 0], 'Victim')
    const mob = x.h.dummy(2, 0.5)
    const plain = x.char([-0.5, 0, 0.5], 'Plain')
    x.tick(100)
    x.cape(caster)
    x.cape(victim)
    const code = 'SKILL_CH_SPEAR_FRONTAREA_A_01'
    x.h.learn(caster.p, [code])
    x.h.req(caster.p, { t: 'useSkill', skill: code, target: victim.p.id })
    expect(x.h.result(caster.inbox, 'useSkill')).toMatchObject({ ok: true })
    x.tick(3000)
    const ids = x.hitIds(caster)
    expect(ids.has(victim.p.id)).toBe(true)
    expect(ids.has(mob.id)).toBe(true)
    expect(ids.has(plain.p.id)).toBe(false)
    // an uncaped caster's area on a monster leaves a caped player next to it alone
    const y = harness()
    const c2 = y.char([0, 0, 0], 'NoCape')
    const m2 = y.h.dummy(1, 0)
    const k2 = y.char([1.5, 0, 0.5], 'Caped')
    y.tick(100)
    y.cape(k2)
    y.h.learn(c2.p, [code])
    y.h.req(c2.p, { t: 'useSkill', skill: code, target: m2.id })
    y.tick(3000)
    const ids2 = y.hitIds(c2)
    expect(ids2.has(m2.id)).toBe(true)
    expect(ids2.has(k2.p.id)).toBe(false)
  })
  it('one area hits two caped players and skips an uncaped player, a party member and a caped player in town', () => {
    // the fight just outside the test town's west edge (x 190..210): the town player stands inside, within the circle
    const x = harness()
    const caster = x.char([186, 0, 200], 'Caster')
    const primary = x.h.dummy(187, 200)
    const a = x.char([186, 0, 202], 'CapedA')
    const b = x.char([185, 0, 198.5], 'CapedB')
    const plain = x.char([187, 0, 201], 'Plain')
    const mate = x.char([185, 0, 201], 'Mate')
    const townie = x.char([190.5, 0, 200], 'Townie')
    x.tick(100)
    for (const r of [caster, a, b, mate, townie]) expect(x.cape(r)).toMatchObject({ ok: true })
    x.h.req(caster.p, { t: 'partyInvite', target: mate.p.id })
    x.h.req(mate.p, { t: 'partyRespond', inviter: caster.p.id, accept: true })
    const code = 'SKILL_TEST_AREA_CASTER_01'
    x.h.learn(caster.p, [code])
    x.h.req(caster.p, { t: 'useSkill', skill: code, target: primary.id })
    expect(x.h.result(caster.inbox, 'useSkill')).toMatchObject({ ok: true })
    x.tick(3000)
    const ids = x.hitIds(caster)
    expect(ids.has(primary.id)).toBe(true)
    expect(ids.has(a.p.id)).toBe(true)
    expect(ids.has(b.p.id)).toBe(true)
    expect(ids.has(plain.p.id)).toBe(false)
    expect(ids.has(mate.p.id)).toBe(false)
    expect(ids.has(townie.p.id)).toBe(false)
  })
  it('a chain imbue (Thunder Force) bounces off a caped player to the next caped player, never to an uncaped one', () => {
    const x = harness()
    const caster = x.char([0, 0, 0], 'Caster')
    const victim = x.char([1, 0, 0], 'Victim')
    const next = x.char([2.5, 0, 0], 'Next')
    const plain = x.char([1.5, 0, 0.5], 'Plain')
    x.tick(100)
    for (const r of [caster, victim, next]) x.cape(r)
    const code = 'SKILL_CH_LIGHTNING_GIGONGTA_A_01'
    x.h.learn(caster.p, [code])
    x.h.req(caster.p, { t: 'useSkill', skill: code })
    expect(x.h.result(caster.inbox, 'useSkill')).toMatchObject({ ok: true })
    x.tick(100)
    expect(x.attack(caster, victim.p)).toMatchObject({ ok: true })
    x.tick(1500)
    const ids = x.hitIds(caster)
    expect(ids.has(victim.p.id)).toBe(true)
    expect(ids.has(next.p.id)).toBe(true)
    expect(ids.has(plain.p.id)).toBe(false)
  })
})
