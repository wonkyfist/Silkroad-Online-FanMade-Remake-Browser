/**
 * Monster skills (docs/SYSTEMS_COMBAT.md §2.2-§2.3, §2.6, §8 lane MS-S): the weighted pick with per-row cooldowns, the
 * busy window, releases with dodge slack (`target_lost`), stuns before the release (`interrupted`), areas over players,
 * projectiles landing at `at`, the Water Ghost gas (0 damage + poison), the MOB_SKILL_DAMAGE modes, the ranged special,
 * summons behind MOB_SUMMONS and `/mobskill`. The MSKILL rows below copy the exported skills.json rows (the last block
 * checks them against work/out when it is there); a hand-driven 20 Hz clock and a steerable rng.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentEntries, type MobDef, type ServerMessage, type SkillDef } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { thinkMob } from '../src/ai.ts'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import { MOB_RELEASE_SLACK_M, hasDamage, mobHitPct, pickRow } from '../src/mob-skills.ts'
import { SkillBook } from '../src/skills/book.ts'
import type { Player } from '../src/world.ts'
import { mob, seeded } from './fixtures.ts'
import { DUMMY, MASTERIES, SAFE_TOWN, SKILLS, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

// ---- the exported MSKILL rows (work/out/data/skills.json, wave 8 EXP) ------------------------------------------------

const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']
function mrow(code: string, o: Partial<SkillDef>): SkillDef {
  return {
    code, id: 1, name: null, mastery: null, masteryLevel: 0, skillLevel: 1, sp: 0, mp: 0, category: 'melee', castMs: 0, actionMs: 0, cooldownMs: 0,
    range: 0, weapons: [], icon: null, group: code, kind: 'attack', targets: enemy, aniGroup: 'DEFAULT', mob: true, aiChance: 100, ...o,
  } as SkillDef
}
const att = (physPct: number, flat: [number, number], hits = 1, magPct = 0) => ({ physPct, magPct, flat, hits })
const shot = (n: number) => ({ shot: `ATTACK${n}` })

const ROWS: SkillDef[] = [
  mrow('MSKILL_CH_MANGNYANG_ATTACK01', { actionMs: 2400, cooldownMs: 3000, range: 1, animation: shot(1), damage: att(200, [17, 19]), hitCues: [{ phase: 'SHOT', event: 1 }] }),
  mrow('MSKILL_CH_MANGNYANG_ATTACK02', { actionMs: 2500, cooldownMs: 3000, range: 1, animation: shot(2), damage: att(100, [17, 19], 2), hitCues: [{ phase: 'SHOT', event: 1 }, { phase: 'SHOT', event: 2 }] }),
  mrow('MSKILL_CH_WATERGHOST_ATTACK01', { actionMs: 1666, cooldownMs: 2000, range: 1.6, animation: shot(1), damage: att(133, [47, 54]) }),
  mrow('MSKILL_CH_WATERGHOST_ATTACK02', { kind: 'debuff', castMs: 1196, actionMs: 2470, cooldownMs: 4000, range: 1.6, animation: shot(2), aiChance: 10, statuses: [{ status: 'poison', level: 34, chancePct: 100, extra: [16] }], hitCues: [{ phase: 'SHOT', event: 2 }] }),
  mrow('MSKILL_CH_TOMBSTONE_CLON_ATTACK01', { category: 'ranged', castMs: 1265, actionMs: 735, cooldownMs: 2500, range: 10, animation: shot(1), damage: att(0, [74, 83], 1, 167), hitCues: [{ phase: 'SHOT', event: 1, projectile: { move: 'MOV_STRAIGHT', delayMs: 0, speed: 200 } }] }),
  mrow('MSKILL_CH_BANDITARCHER_ATTACK01', { category: 'ranged', castMs: 1383, actionMs: 617, cooldownMs: 2500, range: 13, animation: shot(1), damage: att(167, [77, 92]), hitCues: [{ phase: 'SHOT', event: 1, projectile: { move: 'MOV_UPR', delayMs: 0, speed: 400 } }] }),
  mrow('MSKILL_CH_WHITETIGER_CLON_ATTACK01', { actionMs: 1500, cooldownMs: 1500, range: 0.4, animation: shot(1), damage: att(50, [111, 133], 2) }),
  mrow('MSKILL_CH_WHITETIGER_CLON_ATTACK03', {
    castMs: 1044, actionMs: 1456, cooldownMs: 3000, range: 0.4, animation: shot(3), damage: att(200, [151, 173]),
    area: { shape: 'caster', distance: 2, maxTargets: 5, reductionPct: 0, targetMask: 24, raw: [1, 1, 20, 5, 0, 24] },
  }),
  mrow('MSKILL_CH_TIGERWOMAN_ATTACK01', { castMs: 1109, actionMs: 1391, cooldownMs: 3000, range: 2.8, animation: shot(1), damage: att(100, [181, 217], 2) }),
  mrow('MSKILL_CH_TIGERWOMAN_ATTACK02', {
    actionMs: 4000, cooldownMs: 4500, range: 2.8, animation: shot(2), damage: att(300, [281, 321]), aiChance: 30,
    area: { shape: 'caster', distance: 4, maxTargets: 5, reductionPct: 0, targetMask: 24, raw: [1, 1, 40, 5, 0, 24] },
  }),
  mrow('MSKILL_CH_TIGERWOMAN_ATTACK03', { category: 'ranged', castMs: 3003, actionMs: 1997, cooldownMs: 5500, range: 15, animation: shot(3), damage: att(0, [281, 321], 1, 367), aiChance: 10, statuses: [{ status: 'zombie', level: 72, chancePct: 100 }] }),
  ...([80, 60, 40, 0] as const).map((band, i) =>
    mrow(`MSKILL_CH_TIGERWOMAN_SUMMON0${i + 1}`, {
      kind: 'buff', category: 'buff', cooldownMs: 500, aiChance: band, targets: { required: false, groups: [] },
      summon: [{ mob: 'MOB_CH_WHITETIGER', rarity: 0, min: 3, max: 6 }, { mob: 'MOB_CH_WHITETIGER_CLON', rarity: i === 3 ? 6 : 0, min: 3, max: 6 }],
    }),
  ),
]
const row = (code: string) => ROWS.find((r) => r.code === code)!
const codes = (prefix: string) => ROWS.filter((r) => r.code.startsWith(prefix)).map((r) => r.code)

// The mob kinds (mobs.json numbers that matter here; walk/run 0 unless a test moves them).
const still = { walkSpeed: 0, runSpeed: 0 }
const MOBS: MobDef[] = [
  mob('MOB_CH_MANGNYANG', { level: 1, physAttack: [17, 19], attackRange: 1, attackIntervalMs: 3000, radius: 0.6, skills: codes('MSKILL_CH_MANGNYANG'), ...still }),
  mob('MOB_CH_WATERGHOST', { level: 7, physAttack: [47, 54], attackRange: 1.6, attackIntervalMs: 2000, radius: 0.6, skills: codes('MSKILL_CH_WATERGHOST'), ...still }),
  mob('MOB_CH_TOMBSTONE_CLON', { level: 8, physAttack: [0, 0], magAttack: [74, 83], attackRange: 10, attackIntervalMs: 2500, radius: 0.4, skills: codes('MSKILL_CH_TOMBSTONE_CLON'), ...still }),
  mob('MOB_CH_BANDITARCHER', { level: 12, physAttack: [77, 92], attackRange: 13, attackIntervalMs: 2500, radius: 0.6, skills: codes('MSKILL_CH_BANDITARCHER'), ...still }),
  mob('MOB_CH_WHITETIGER_CLON', { level: 17, physAttack: [111, 133], attackRange: 0.4, attackIntervalMs: 1500, radius: 1.2, skills: codes('MSKILL_CH_WHITETIGER_CLON'), ...still }),
  mob('MOB_CH_WHITETIGER', { level: 18, physAttack: [120, 143], attackRange: 0.9, attackIntervalMs: 1500, radius: 1.2, walkSpeed: 2, runSpeed: 4 }),
  mob('MOB_CH_TIGERWOMAN', { level: 20, rarity: 'unique', hp: 10_000, physAttack: [181, 217], attackRange: 2.8, attackIntervalMs: 3000, radius: 2.8, skills: codes('MSKILL_CH_TIGERWOMAN'), ...still }),
]

let h: ReturnType<typeof skillHarness> | null = null
afterEach(() => {
  h?.cleanup()
  h = null
})

/** The harness with the mob rows in its book, the mob kinds in its data and a steerable rng (default 0.5: every hit lands). */
function setup() {
  // `q` answers the next calls first (a pick), then `v` (0.5: every hit lands as a plain hit).
  const rng = { v: 0.5, q: [] as number[] }
  const data = new GameData({ mobs: [DUMMY, ...MOBS], items: SKILL_ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN] })
  const hh = skillHarness({ data, book: new SkillBook([...SKILLS, ...ROWS], MASTERIES), rng: () => rng.q.shift() ?? rng.v })
  h = hh
  // Gameplay.now follows the hand clock from the first tick on.
  hh.runTo(hh.now + 50)
  const spawn = (code: string, x: number, z: number) => hh.gameplay.createMob(hh.data.mob(code)!, hh.data.mob(code)!.rarity === 'unique' ? 'unique' : 'normal', x, z, 0, null, hh.now)
  /** A sturdy level-20 player at x/z (a huge HP pool: the tests look at hits, not deaths). */
  const player = (x: number, z: number, level = 20) => {
    const r = hh.hero({ pos: [x, 0, z], level })
    r.p.maxHp = r.p.hp = 1_000_000
    return r
  }
  const at = (p: Player, x: number, z: number) => {
    p.move = null
    p.pos = [x, 0, z]
  }
  const combats = (inbox: ServerMessage[], attacker: number) => hh.all(inbox, 'combat').filter((c) => c.attacker === attacker)
  return { h: hh, rng, spawn, player, at, combats, ms: hh.gameplay.mobSkills }
}

describe('the pick (§2.2)', () => {
  it("Tiger Girl's rows by weight over 10,000 swings: 71 / 21 / 7 % (± 2); weight 0 never; nothing ready -> the primary", () => {
    const tg = codes('MSKILL_CH_TIGERWOMAN_ATTACK').map(row)
    const rng = seeded(8)
    const n = new Map<string, number>()
    for (let i = 0; i < 10_000; i++) {
      const r = pickRow(tg, rng)!
      n.set(r.code, (n.get(r.code) ?? 0) + 1)
    }
    const pct = (c: string) => ((n.get(c) ?? 0) / 10_000) * 100
    expect(pct('MSKILL_CH_TIGERWOMAN_ATTACK01')).toBeGreaterThan(71.4 - 2)
    expect(pct('MSKILL_CH_TIGERWOMAN_ATTACK01')).toBeLessThan(71.4 + 2)
    expect(Math.abs(pct('MSKILL_CH_TIGERWOMAN_ATTACK02') - 21.4)).toBeLessThan(2)
    expect(Math.abs(pct('MSKILL_CH_TIGERWOMAN_ATTACK03') - 7.1)).toBeLessThan(2)
    expect(pickRow([{ ...tg[0], aiChance: 0 }], rng)).toBeNull()
    expect(pickRow([{ ...tg[0], aiChance: 0 }, tg[2]], () => 0)).toBe(tg[2])
  })

  it('a swing runs the picked row: cast at once, cooldown per row, the rest of the rotation, then the primary even on cooldown', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 1.5)
    const m = t.spawn('MOB_CH_MANGNYANG', 0, 0)
    // 0.1 picks the first ready row (weights 100 : 100).
    t.rng.q = [0.1]
    t.ms.swing(m, p, t.h.now)
    const cast = t.h.all(inbox, 'cast').filter((c) => c.id === m.id)
    expect(cast).toEqual([{ t: 'cast', id: m.id, skill: 'MSKILL_CH_MANGNYANG_ATTACK01', instance: cast[0].instance, target: p.id, prepareMs: 0, castMs: 0, actionMs: 2400 }])
    // castMs 0: the hit lands with the cast, with its instance and skill.
    expect(t.combats(inbox, m.id)).toMatchObject([{ target: p.id, skill: 'MSKILL_CH_MANGNYANG_ATTACK01', instance: cast[0].instance, hits: [{ outcome: 'hit' }] }])
    expect(m.nextSwingAt).toBe(t.h.now + 3000)
    expect(t.ms.busy(m, t.h.now + 2399)).toBe(true)
    expect(t.ms.busy(m, t.h.now + 2400)).toBe(false)
    // ATTACK01 on cooldown: the next swing is ATTACK02 (two hits, two numbers).
    t.h.runTo(t.h.now + 3000)
    t.ms.swing(m, p, t.h.now)
    expect(t.combats(inbox, m.id).at(-1)).toMatchObject({ skill: 'MSKILL_CH_MANGNYANG_ATTACK02' })
    expect(t.combats(inbox, m.id).at(-1)!.hits).toHaveLength(2)
    // Both on cooldown (a GM-fast swing): the primary, never an idle mob in reach.
    t.ms.swing(m, p, t.h.now + 100)
    expect(t.combats(inbox, m.id).at(-1)).toMatchObject({ skill: 'MSKILL_CH_MANGNYANG_ATTACK01' })
  })

  it('a mob without skill data keeps the one basic attack of today (no cast)', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 1)
    const m = t.h.dummy(0, 0, { physAttack: [5, 5] })
    t.h.gameplay.swing(m, p)
    expect(t.h.all(inbox, 'cast').filter((c) => c.id === m.id)).toEqual([])
    expect(t.combats(inbox, m.id)).toHaveLength(1)
    expect(t.combats(inbox, m.id)[0].skill).toBeUndefined()
    expect(t.ms.busy(m, t.h.now)).toBe(false)
  })
})

describe('release and hits (§2.3)', () => {
  it('a castMs 1383 archer shot lands at release + distance / 40 m/s; a Tomb Stone Ghost force bolt at distance / 20 m/s', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 0)
    const archer = t.spawn('MOB_CH_BANDITARCHER', 0, 10)
    const tomb = t.spawn('MOB_CH_TOMBSTONE_CLON', 8, 0)
    const t0 = t.h.now
    t.ms.swing(archer, p, t0)
    t.ms.swing(tomb, p, t0)
    expect(t.h.all(inbox, 'cast').map((c) => [c.id, c.skill, c.castMs])).toEqual([
      [archer.id, 'MSKILL_CH_BANDITARCHER_ATTACK01', 1383],
      [tomb.id, 'MSKILL_CH_TOMBSTONE_CLON_ATTACK01', 1265],
    ])
    // Released on the first 20 Hz tick at or after castMs: nothing lands yet (the bolt and the arrow fly).
    t.h.runTo(t0 + 1400)
    expect(t.combats(inbox, archer.id)).toEqual([])
    expect(t.combats(inbox, tomb.id)).toEqual([])
    t.h.runTo(t0 + 3000)
    const arrow = t.combats(inbox, archer.id)
    const bolt = t.combats(inbox, tomb.id)
    // Archer: released at t0 + 1400 (the tick), 10 m at 40 m/s = 250 ms. Tomb Stone Ghost: t0 + 1300, 8 m at 20 m/s = 400 ms.
    expect(arrow).toMatchObject([{ skill: 'MSKILL_CH_BANDITARCHER_ATTACK01', at: t0 + 1400 + 250 }])
    expect(bolt).toMatchObject([{ skill: 'MSKILL_CH_TOMBSTONE_CLON_ATTACK01', at: t0 + 1300 + 400 }])
    expect(arrow[0].instance).toBe(t.h.all(inbox, 'cast')[0].instance)
    // The HP changed when it landed, not at the release.
    expect(arrow[0].hits[0].damage).toBeGreaterThan(0)
  })

  it('a projectile whose target warped away (or died) is dropped', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 0)
    const archer = t.spawn('MOB_CH_BANDITARCHER', 0, 12)
    t.ms.swing(archer, p, t.h.now)
    t.h.runTo(t.h.now + 1400)
    t.at(p, 0, -200)
    t.h.runTo(t.h.now + 2000)
    expect(t.combats(inbox, archer.id)).toEqual([])
  })

  it('stepping 2 m out of a melee cast\'s reach before the release -> castEnd target_lost; within the slack it still lands', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 5)
    const tg = t.spawn('MOB_CH_TIGERWOMAN', 0, 0)
    const reach = 2.8 + 2.8 + 0.5
    t.rng.q = [0.1] // ATTACK01 (the first row)
    t.ms.swing(tg, p, t.h.now)
    const c = t.h.all(inbox, 'cast').at(-1)!
    expect(c).toMatchObject({ skill: 'MSKILL_CH_TIGERWOMAN_ATTACK01', castMs: 1109 })
    t.at(p, 0, reach + 2)
    t.h.runTo(t.h.now + 1150)
    expect(t.h.all(inbox, 'castEnd')).toEqual([{ t: 'castEnd', id: tg.id, instance: c.instance, reason: 'target_lost' }])
    expect(t.combats(inbox, tg.id)).toEqual([])
    // The lost swing frees the mob at once (it may chase again); its swing time stays.
    expect(t.ms.busy(tg, t.h.now)).toBe(false)
    // Half a metre out (inside the 1 m slack): the hits land.
    t.h.runTo(t.h.now + 3000)
    t.at(p, 0, 4)
    t.rng.q = [0.1]
    t.ms.swing(tg, p, t.h.now)
    t.at(p, 0, reach + MOB_RELEASE_SLACK_M - 0.5)
    t.h.runTo(t.h.now + 1150)
    expect(t.combats(inbox, tg.id).at(-1)).toMatchObject({ skill: 'MSKILL_CH_TIGERWOMAN_ATTACK01' })
    expect(t.combats(inbox, tg.id).at(-1)!.hits).toHaveLength(2)
  })

  it('a stun before the release -> castEnd interrupted; a mob that dies mid-cast ends it too; a despawn is quiet', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 4)
    const tg = t.spawn('MOB_CH_TIGERWOMAN', 0, 0)
    t.rng.q = [0.1]
    t.ms.swing(tg, p, t.h.now)
    const c = t.h.all(inbox, 'cast').at(-1)!
    t.h.gameplay.skills.effects.add({ instance: 999, carrier: tg.id, source: p.id, kind: 'status', status: 'stun', overlap: 0, mods: [], startedAt: t.h.now, until: t.h.now + 3000 })
    t.h.runTo(t.h.now + 100)
    expect(t.h.all(inbox, 'castEnd')).toEqual([{ t: 'castEnd', id: tg.id, instance: c.instance, reason: 'interrupted' }])
    t.h.runTo(t.h.now + 2000)
    expect(t.combats(inbox, tg.id)).toEqual([])
    expect(t.ms.busy(tg, t.h.now)).toBe(false)

    const w = t.spawn('MOB_CH_WATERGHOST', 0, 3)
    t.rng.q = [0.95] // the gas (the second row, weight 10 of 110)
    t.ms.swing(w, p, t.h.now)
    const gas = t.h.all(inbox, 'cast').at(-1)!
    expect(gas).toMatchObject({ id: w.id, skill: 'MSKILL_CH_WATERGHOST_ATTACK02' })
    t.h.gameplay.gmKill(w, t.h.now)
    t.h.runTo(t.h.now + 100)
    expect(t.h.all(inbox, 'castEnd').at(-1)).toEqual({ t: 'castEnd', id: w.id, instance: gas.instance, reason: 'interrupted' })

    const a = t.spawn('MOB_CH_BANDITARCHER', 0, 10)
    t.ms.swing(a, p, t.h.now)
    t.h.gameplay.despawnNestMobs([a.id])
    expect(() => t.h.runTo(t.h.now + 3000)).not.toThrow()
    expect(t.combats(inbox, a.id)).toEqual([])
  })

  it('the Black Tiger howl hits the 3 players within 2 m and not the one at 3 m (area over players, primary first)', () => {
    const t = setup()
    const a = t.player(0, 1.5)
    const b = t.player(1.5, 0)
    const c = t.player(-1.2, -1.2)
    const far = t.player(0, -3)
    const bt = t.spawn('MOB_CH_WHITETIGER_CLON', 0, 0)
    t.ms.use(bt, row('MSKILL_CH_WHITETIGER_CLON_ATTACK03'), a.p, t.h.now)
    t.h.runTo(t.h.now + 1100)
    const own = (x: ReturnType<typeof t.player>) => t.combats(x.inbox, bt.id).filter((m) => m.target === x.p.id)
    for (const x of [a, b, c]) expect(own(x), x.p.name).toMatchObject([{ skill: 'MSKILL_CH_WHITETIGER_CLON_ATTACK03', hits: [{ outcome: 'hit' }] }])
    expect(own(a)[0].aoe).toBeUndefined()
    expect([own(b)[0].aoe, own(c)[0].aoe]).toEqual([true, true])
    expect(t.combats(far.inbox, bt.id).some((x) => x.target === far.p.id)).toBe(false)
    expect(far.p.hp).toBe(1_000_000)
  })

  it('Water Ghost gas: poison (level 34, 16 per tick), 0 damage (its exported damage is absent)', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 2)
    const w = t.spawn('MOB_CH_WATERGHOST', 0, 0)
    expect(hasDamage(row('MSKILL_CH_WATERGHOST_ATTACK02'))).toBe(false)
    // The older export shape (0 % and flat 0-0 kept) is no damage too.
    expect(hasDamage({ ...row('MSKILL_CH_WATERGHOST_ATTACK02'), damage: { physPct: 0, magPct: 0, flat: [0, 0], hits: 1 } })).toBe(false)
    t.ms.use(w, row('MSKILL_CH_WATERGHOST_ATTACK02'), p, t.h.now)
    t.h.runTo(t.h.now + 1200)
    const gas = t.combats(inbox, w.id)
    expect(gas).toMatchObject([{ skill: 'MSKILL_CH_WATERGHOST_ATTACK02', hits: [{ outcome: 'hit', damage: 0, status: 'poison' }] }])
    expect(p.hp).toBe(1_000_000)
    const eff = t.h.all(inbox, 'effectAdd').find((e) => e.id === p.id)
    expect(eff?.effect).toMatchObject({ status: 'poison', level: 34, source: w.id })
    // The poison ticks 16 through dealHits (dot).
    t.h.runTo(t.h.now + 1100)
    expect(p.hp).toBe(1_000_000 - 16)
  })

  it("the Tiger Girl curse (magic) puts the zombie state on a level-20 player", () => {
    const t = setup()
    const { p, inbox } = t.player(0, 12)
    const tg = t.spawn('MOB_CH_TIGERWOMAN', 0, 0)
    t.ms.use(tg, row('MSKILL_CH_TIGERWOMAN_ATTACK03'), p, t.h.now)
    t.h.runTo(t.h.now + 3050)
    expect(t.combats(inbox, tg.id)).toMatchObject([{ skill: 'MSKILL_CH_TIGERWOMAN_ATTACK03', hits: [{ outcome: 'hit', status: 'zombie' }] }])
    expect(t.h.all(inbox, 'effectAdd').find((e) => e.id === p.id)?.effect).toMatchObject({ status: 'zombie', level: 72 })
  })
})

describe('damage scale MOB_SKILL_DAMAGE (§2.6)', () => {
  it('relative: Mangnyang ATTACK02 = 2 x 50 %, Black Tiger ATTACK01 = 2 x 50 % and its howl 1 x 200 %; retail: ATTACK01 = 200 %; flat: 100 %', () => {
    const mg1 = row('MSKILL_CH_MANGNYANG_ATTACK01')
    const mg2 = row('MSKILL_CH_MANGNYANG_ATTACK02')
    const bt1 = row('MSKILL_CH_WHITETIGER_CLON_ATTACK01')
    const bt3 = row('MSKILL_CH_WHITETIGER_CLON_ATTACK03')
    expect(mobHitPct(mg1, mg1, 'relative')).toBe(100)
    expect(mobHitPct(mg2, mg1, 'relative')).toBe(50)
    expect(mobHitPct(bt1, bt1, 'relative')).toBe(50)
    expect(mobHitPct(bt3, bt1, 'relative')).toBe(200)
    const tg1 = row('MSKILL_CH_TIGERWOMAN_ATTACK01')
    expect(mobHitPct(row('MSKILL_CH_TIGERWOMAN_ATTACK02'), tg1, 'relative')).toBe(150)
    expect(mobHitPct(row('MSKILL_CH_TIGERWOMAN_ATTACK03'), tg1, 'relative')).toBeCloseTo(183.5, 5)
    expect(mobHitPct(mg1, mg1, 'retail')).toBe(200)
    expect(mobHitPct(mg2, mg1, 'retail')).toBe(100)
    expect(mobHitPct(mg1, mg1, 'flat')).toBe(100)
    expect(mobHitPct(mg2, mg1, 'flat')).toBe(100)
  })

  it("relative keeps today's primary swing to the point: Mangnyang ATTACK01 hits exactly what the old basic attack hit", () => {
    const t = setup()
    const { p, inbox } = t.player(0, 1.5, 1)
    const m = t.spawn('MOB_CH_MANGNYANG', 0, 0)
    t.h.gameplay.attack(m, p, t.h.now)
    const today = t.combats(inbox, m.id)[0].hits[0].damage
    t.ms.use(m, row('MSKILL_CH_MANGNYANG_ATTACK01'), p, t.h.now)
    expect(t.combats(inbox, m.id)[1].hits[0].damage).toBe(today)
    // ATTACK02: two hits of half as much (to rounding).
    t.ms.use(m, row('MSKILL_CH_MANGNYANG_ATTACK02'), p, t.h.now)
    const two = t.combats(inbox, m.id)[2].hits.map((x) => x.damage)
    expect(two).toHaveLength(2)
    expect(Math.abs(two[0] + two[1] - today)).toBeLessThanOrEqual(1)
    // retail: ATTACK01 hits twice as hard; MOB_DAMAGE_RATE 0.5 halves it again.
    t.h.config.mobSkillDamage = 'retail'
    t.ms.use(m, row('MSKILL_CH_MANGNYANG_ATTACK01'), p, t.h.now)
    expect(Math.abs(t.combats(inbox, m.id)[3].hits[0].damage - 2 * today)).toBeLessThanOrEqual(1)
    t.h.config.mobDamageRate = 0.5
    t.ms.use(m, row('MSKILL_CH_MANGNYANG_ATTACK01'), p, t.h.now)
    expect(Math.abs(t.combats(inbox, m.id)[4].hits[0].damage - today)).toBeLessThanOrEqual(1)
  })

  it('the row flat replaces the attack power (x variant): a giant Black Tiger howl hits harder than a normal one', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 1.5)
    const def = t.h.data.mob('MOB_CH_WHITETIGER_CLON')!
    const normal = t.h.gameplay.createMob(def, 'normal', 0, 0, 0, null, t.h.now)
    const giant = t.h.gameplay.createMob(def, 'giant', 0, 0, 0, null, t.h.now)
    t.ms.use(normal, row('MSKILL_CH_WHITETIGER_CLON_ATTACK01'), p, t.h.now)
    t.ms.use(giant, row('MSKILL_CH_WHITETIGER_CLON_ATTACK01'), p, t.h.now)
    expect(t.combats(inbox, giant.id)[0].hits[0].damage).toBeGreaterThan(t.combats(inbox, normal.id)[0].hits[0].damage * 1.5)
  })
})

describe('busy window and the AI (§2.2)', () => {
  it('the busy window stops the mob moving; it chases again after cast + action', () => {
    const t = setup()
    const { p } = t.player(0, 1.2)
    const def = { ...t.h.data.mob('MOB_CH_MANGNYANG')!, walkSpeed: 2, runSpeed: 4 }
    const m = t.h.gameplay.createMob(def, 'normal', 0, 0, 0, null, t.h.now)
    m.ai = 'chase'
    m.target = p.id
    t.h.runTo(t.h.now + 50)
    expect(t.ms.busy(m, t.h.now)).toBe(true)
    // The target runs off: the mob stands in its 2.4 s swing.
    t.at(p, 0, 12)
    const from = [...m.pos]
    t.h.runTo(t.h.now + 2300)
    expect(m.move).toBeNull()
    expect(m.pos).toEqual(from)
    t.h.runTo(t.h.now + 600)
    expect(m.move).not.toBeNull()
  })

  it('the chase branch asks for a ranged special only on the swing rhythm; the Tiger Girl curses a kiting player', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 12)
    const tg = t.h.gameplay.createMob({ ...t.h.data.mob('MOB_CH_TIGERWOMAN')!, walkSpeed: 2, runSpeed: 4 }, 'unique', 0, 0, 0, null, t.h.now)
    tg.ai = 'chase'
    tg.target = p.id
    // A roll above 10 % (the curse's chance): no special, the mob chases (runSpeed 0 here: it just stays).
    t.rng.v = 0.5
    expect(t.h.gameplay.ranged(tg, p, 12)).toBe(false)
    // At most once per CHASE_REPLAN_MS, and never before the next swing time (ai.ts).
    t.rng.v = 0.05
    expect(t.h.gameplay.ranged(tg, p, 12)).toBe(false)
    tg.nextSwingAt = t.h.now + 10_000
    tg.nextThinkAt = 0
    t.h.now += 400
    t.h.gameplay.now = t.h.now
    thinkMob(tg, t.h.gameplay)
    expect(tg.move).not.toBeNull()
    expect(t.h.all(inbox, 'cast').filter((c) => c.id === tg.id)).toEqual([])
    tg.nextSwingAt = 0
    thinkMob(tg, t.h.gameplay)
    expect(t.h.all(inbox, 'cast').filter((c) => c.id === tg.id)).toMatchObject([{ skill: 'MSKILL_CH_TIGERWOMAN_ATTACK03', castMs: 3003, target: p.id }])
    expect(t.ms.busy(tg, t.h.now)).toBe(true)
    expect(tg.nextSwingAt).toBe(t.h.now + 5500)
    // Beyond 15 m + radii: no curse.
    const far = t.spawn('MOB_CH_TIGERWOMAN', 0, 40)
    expect(t.h.gameplay.ranged(far, p, 28 + 3.3 + 1)).toBe(false)
    // Only non-primary rows: a Mangnyang never has one.
    const mg = t.spawn('MOB_CH_MANGNYANG', 0, -10)
    expect(t.h.gameplay.ranged(mg, p, 5)).toBe(false)
  })
})

describe('summons (MOB_SUMMONS, phase 2)', () => {
  it('off by default; on: each band fires once as HP falls, capped by MOB_SUMMON_CAP, attacking her target; full HP re-arms', () => {
    const t = setup()
    const { p } = t.player(0, 5)
    const tg = t.spawn('MOB_CH_TIGERWOMAN', 0, 0)
    tg.ai = 'chase'
    tg.target = p.id
    const count = () => [...t.h.world.mobs.values()].filter((m) => m.def.code.startsWith('MOB_CH_WHITETIGER')).length
    tg.hp = tg.maxHp * 0.7
    t.h.runTo(t.h.now + 100)
    expect(count()).toBe(0)
    t.h.config.mobSummons = 1
    t.h.config.mobSummonCap = 4
    t.h.runTo(t.h.now + 100)
    expect(count()).toBe(4)
    const tigers = [...t.h.world.mobs.values()].filter((m) => m.def.code.startsWith('MOB_CH_WHITETIGER'))
    expect(tigers.every((m) => m.ai === 'chase' && m.target === p.id)).toBe(true)
    // The 80 band fired once; the 60 band finds the cap full; killing two lets band 40 bring two more.
    tg.hp = tg.maxHp * 0.5
    t.h.runTo(t.h.now + 100)
    expect(count()).toBe(4)
    for (const m of tigers.slice(0, 2)) t.h.gameplay.gmKill(m, t.h.now)
    tg.hp = tg.maxHp * 0.35
    t.h.runTo(t.h.now + 100)
    expect([...t.h.world.mobs.values()].filter((m) => m.def.code.startsWith('MOB_CH_WHITETIGER') && m.ai !== 'dead').length).toBe(4)
    // Band 0 never fires.
    tg.hp = 1
    t.h.runTo(t.h.now + 100)
    expect([...t.h.world.mobs.values()].filter((m) => m.def.code.startsWith('MOB_CH_WHITETIGER') && m.ai !== 'dead').length).toBe(4)
  })
})

describe('GM /mobskill', () => {
  it('lists the rows, uses one now on the GM (the mob turns on it), or queues it for the next swing', () => {
    const t = setup()
    const { p, inbox } = t.player(0, 3)
    const tg = t.spawn('MOB_CH_TIGERWOMAN', 0, 0)
    expect(t.ms.gm(p, [])).toMatchObject({ ok: false })
    expect(t.ms.gm(p, ['424242'])).toMatchObject({ ok: false, message: 'No monster with id 424242.' })
    const list = t.ms.gm(p, [String(tg.id)])
    expect(list).toMatchObject({ ok: true, data: { rows: ['MSKILL_CH_TIGERWOMAN_ATTACK01', 'MSKILL_CH_TIGERWOMAN_ATTACK02', 'MSKILL_CH_TIGERWOMAN_ATTACK03'] } })
    expect(t.ms.gm(p, [String(tg.id), 'NOPE']).ok).toBe(false)
    const r = t.ms.gm(p, [String(tg.id), '2'])
    expect(r).toMatchObject({ ok: true, data: { skill: 'MSKILL_CH_TIGERWOMAN_ATTACK02', now: true } })
    expect(tg).toMatchObject({ ai: 'chase', target: p.id })
    expect(t.combats(inbox, tg.id)).toMatchObject([{ skill: 'MSKILL_CH_TIGERWOMAN_ATTACK02' }])
    // Busy: the curse is queued, and the next swing (here the AI's) uses it.
    expect(t.ms.gm(p, [String(tg.id), 'attack03'])).toMatchObject({ ok: true, data: { skill: 'MSKILL_CH_TIGERWOMAN_ATTACK03', now: false } })
    t.h.runTo(t.h.now + 4600)
    t.ms.swing(tg, p, t.h.now)
    expect(t.h.all(inbox, 'cast').at(-1)).toMatchObject({ skill: 'MSKILL_CH_TIGERWOMAN_ATTACK03' })
    // No data: refused.
    const d = t.h.dummy(0, 1)
    expect(t.ms.gm(p, [String(d.id), '1'])).toMatchObject({ ok: false })
  })
})

// ---- the fixtures above against the exported data ----------------------------------------------------------------

const OUT = join(REPO_ROOT, 'work/out/data')
const HAVE = existsSync(join(OUT, 'skills.json')) && existsSync(join(OUT, 'mobs.json'))

describe.skipIf(!HAVE)('the exported rows (work/out)', () => {
  it('match the fixtures (timing, range, damage, weights, areas, statuses, projectiles) and the mobs list them', () => {
    const skills = new Map(contentEntries<SkillDef>(JSON.parse(readFileSync(join(OUT, 'skills.json'), 'utf8'))).map((s) => [s.code, s]))
    const mobs = new Map(contentEntries<MobDef>(JSON.parse(readFileSync(join(OUT, 'mobs.json'), 'utf8'))).map((m) => [m.code, m]))
    const pick = (s: SkillDef) => ({
      castMs: s.castMs, actionMs: s.actionMs, cooldownMs: s.cooldownMs, range: s.range, damage: s.damage, aiChance: s.aiChance, kind: s.kind,
      area: s.area && { shape: s.area.shape, distance: s.area.distance, maxTargets: s.area.maxTargets }, statuses: s.statuses,
      projectile: s.hitCues?.find((c) => c.projectile)?.projectile, summon: s.summon && [...new Set(s.summon.map((x) => x.mob))].sort(),
    })
    for (const r of ROWS) {
      const real = skills.get(r.code)
      expect(real, r.code).toBeDefined()
      expect(real!.mob, r.code).toBe(true)
      expect(pick(real!), r.code).toEqual(pick(r))
    }
    for (const m of MOBS.filter((x) => x.skills)) {
      const real = mobs.get(m.code)!
      expect(real.skills, m.code).toEqual(m.skills)
      expect([real.attackRange, real.radius, real.attackIntervalMs], m.code).toEqual([m.attackRange, m.radius, m.attackIntervalMs])
    }
  })
})
