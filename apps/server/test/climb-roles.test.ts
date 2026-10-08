/**
 * The Climb's monster roles (docs/CLIMB.md §2.3, layer L3; D3): packs link up to 2 idle nest-mates within 12 m (on a hit
 * or on sight; joiners never link on), ranged monsters and healers step back from melee once per 6 s, healers heal the
 * most hurt ally for 12 % after a 1.4 s cast that a stun cancels, cowards run at low HP and call nest-mates. Roles off
 * (CLIMB_ROLES or CLIMB) is the old AI. Plus the tick budget: roles on vs off over a 100-player field (worstTickMs).
 */
import { CLIMB_ROLE_RULES, CLIMB_ROSTER, climbRowOf, type MobDef, type NestDef, type ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerConfig } from '../src/config.ts'
import { ROLE_HEAL_SKILL } from '../src/climb/roles.ts'
import { GameData } from '../src/gamedata.ts'
import type { Mob, Player } from '../src/world.ts'
import { ITEMS, LEVELS, MANGNYANG, mob, nest } from './fixtures.ts'
import { npcHarness, type NpcHarness } from './npc-harness.ts'

const def = (code: string, over: Partial<MobDef> = {}): MobDef => {
  const r = climbRowOf(code)!
  return mob(code, { name: r.name, level: r.level, hp: 1000, runSpeed: 6, walkSpeed: 1.5, attackRange: 1, ...over })
}
const TIGER = def('MOB_CL_YOUNGTIGER_12')
const HEALER = def('MOB_CL_WATERGHOST_7', { attackRange: 1.6 })
const ARCHER = def('MOB_CL_ARCHER_12', { attackRange: 13 })
const COWARD = def('MOB_CL_BANDITSUB_11')
const PLAIN = def('MOB_CL_MANGNYANG_1')

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})
function setup(config: Partial<ServerConfig> = {}) {
  const data = new GameData({ mobs: [MANGNYANG, TIGER, HEALER, ARCHER, COWARD, PLAIN], items: ITEMS, levels: LEVELS, drops: [], npcs: [], shops: [], towns: [] })
  const h = npcHarness({ data, config: { climb: true, ...config } })
  harnesses.push(h)
  return h
}

const F = { x: 200, z: 200 }
let nestId = 900
function newNest(code: string, over: Partial<NestDef> = {}): NestDef {
  return nest(++nestId, code, F.x, F.z, { radius: 0, ...over })
}
function spawn(h: NpcHarness, d: MobDef, x: number, z: number, n: NestDef | null, p?: Player): Mob {
  const m = h.gameplay.createMob(d, 'normal', x, z, 0, n, h.now())
  if (p) p.known.add(m.id)
  return m
}
const hit = (h: NpcHarness, p: Player, m: Mob, damage: number) => h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage, hp: 0 }], {}, h.now())
const dist = (h: NpcHarness, a: Mob | Player, b: Mob | Player) => {
  const p = h.world.positionAt(a, h.now())
  const q = h.world.positionAt(b, h.now())
  return Math.hypot(p[0] - q[0], p[2] - q[2])
}

describe('roles data', () => {
  it('every roster row with roles is one of the four (and caster); healers and cowards are where §2.3 puts them', () => {
    const roles = new Set(CLIMB_ROSTER.flatMap((r) => r.roles ?? []))
    expect([...roles].every((r) => ['pack', 'ranged', 'healer', 'coward', 'caster'].includes(r))).toBe(true)
    const of = (role: string) => CLIMB_ROSTER.filter((r) => r.roles?.includes(role as never)).map((r) => r.name)
    expect(of('healer')).toEqual(expect.arrayContaining(['Water Ghost', 'Decayed Yeoha', 'Tomb Stone', 'Tomb Keeper', 'Hyungno Shaman']))
    expect(of('coward')).toEqual(expect.arrayContaining(['Weasel', 'Bandit Subordinate', 'Bandit', 'Chakji Worker']))
    expect(of('ranged')).toEqual(expect.arrayContaining(['Bandit Archer', 'Bandit Bowman', 'Stronghold Archer', 'Powder Ghost']))
    expect(climbRowOf('MOB_CL_CHAKJIWORKER_19')?.callN).toEqual([1, 2])
  })
})

describe('pack', () => {
  it('a hit pulls up to 2 idle nest-mates within 12 m after 0.5–2 s; joiners never link on', () => {
    const h = setup()
    const { p } = h.enter([F.x - 3, 0, F.z])
    const n = newNest(TIGER.code)
    const a = spawn(h, TIGER, F.x, F.z, n, p)
    const near = [spawn(h, TIGER, F.x + 3, F.z, n, p), spawn(h, TIGER, F.x + 5, F.z, n, p), spawn(h, TIGER, F.x + 8, F.z, n, p)]
    const far = spawn(h, TIGER, F.x + 20, F.z, n, p)
    const other = spawn(h, TIGER, F.x + 2, F.z + 1, newNest(TIGER.code), p)
    hit(h, p, a, 10)
    h.advance(400)
    expect(near.filter((m) => m.ai === 'chase')).toHaveLength(0)
    h.advance(1700)
    const joined = near.filter((m) => m.ai === 'chase')
    expect(joined).toHaveLength(2)
    expect(joined.every((m) => m.target === p.id)).toBe(true)
    expect(near[2].ai).toBe('idle')
    expect(far.ai).toBe('idle')
    expect(other.ai).toBe('idle')
    // a joiner that is hit does not link on
    hit(h, p, joined[0], 10)
    h.advance(2100)
    expect(near[2].ai).toBe('idle')
  })

  it('an aggressive pack member that sees a player links too', () => {
    const h = setup()
    const n = newNest(TIGER.code, { tactics: { id: 2, aggressive: true, sightRange: 10, leashRange: 40 } })
    const a = spawn(h, TIGER, F.x, F.z, n)
    const b = spawn(h, TIGER, F.x + 4, F.z + 9, n)
    const { p } = h.enter([F.x - 6, 0, F.z])
    h.advance(100)
    expect(a.ai).toBe('chase')
    expect(dist(h, b, p)).toBeGreaterThan(10)
    h.advance(2100)
    expect(b.ai).toBe('chase')
    expect(b.target).toBe(p.id)
  })

  it('roles off (CLIMB_ROLES, or CLIMB): no link', () => {
    for (const config of [{ climbRoles: false }, { climb: false }]) {
      const h = setup(config)
      const { p } = h.enter([F.x - 3, 0, F.z])
      const n = newNest(TIGER.code)
      const a = spawn(h, TIGER, F.x, F.z, n, p)
      const b = spawn(h, TIGER, F.x + 3, F.z, n, p)
      hit(h, p, a, 10)
      h.advance(2500)
      expect(b.ai).toBe('idle')
    }
  })
})

describe('healer', () => {
  it('heals the most hurt ally in 15 m for 12 % after a 1.4 s cast, every 7 s', () => {
    const h = setup()
    const { p, inbox } = h.enter([F.x - 3, 0, F.z])
    const healer = spawn(h, HEALER, F.x + 6, F.z, null, p)
    const a = spawn(h, PLAIN, F.x, F.z, null, p)
    const b = spawn(h, PLAIN, F.x, F.z + 1, null, p)
    hit(h, p, a, 400)
    hit(h, p, b, 600)
    hit(h, p, healer, 1)
    h.advance(50)
    const cast = inbox.find((m): m is Extract<ServerMessage, { t: 'cast' }> => m.t === 'cast' && m.id === healer.id)
    expect(cast).toMatchObject({ skill: ROLE_HEAL_SKILL, target: b.id, castMs: CLIMB_ROLE_RULES.healer.castMs, clip: 'ATTACK1' })
    expect(b.hp).toBe(400)
    h.advance(1400)
    expect(b.hp).toBe(520)
    expect(a.hp).toBe(600)
    h.advance(5000)
    expect(b.hp).toBe(520)
    h.advance(2000)
    expect(b.hp + a.hp).toBe(520 + 600 + 120)
  })

  it('a stun during the cast cancels it (castEnd interrupted), and nobody is healed', () => {
    const h = setup()
    const { p, inbox } = h.enter([F.x - 3, 0, F.z])
    const healer = spawn(h, HEALER, F.x + 6, F.z, null, p)
    const a = spawn(h, PLAIN, F.x, F.z, null, p)
    hit(h, p, a, 500)
    hit(h, p, healer, 1)
    h.advance(500)
    const held = h.gameplay.skills.held.bind(h.gameplay.skills)
    h.gameplay.skills.held = (e, now) => e === healer || held(e, now)
    h.advance(100)
    h.gameplay.skills.held = held
    h.advance(2000)
    expect(a.hp).toBe(500)
    expect(inbox.some((m) => m.t === 'castEnd' && m.id === healer.id && m.reason === 'interrupted')).toBe(true)
    expect(h.gameplay.roles.stats.healsInterrupted).toBe(1)
  })

  it('flees melee: a healer steps back from a melee fighter within 4 m', () => {
    const h = setup()
    const { p } = h.enter([F.x - 2, 0, F.z])
    p.combat.range = 1.5
    const healer = spawn(h, HEALER, F.x, F.z, null, p)
    hit(h, p, healer, 1)
    h.advance(1500)
    expect(dist(h, healer, p)).toBeGreaterThan(5)
    expect(h.gameplay.roles.stats.steps).toBe(1)
  })
})

describe('ranged', () => {
  it('steps back from melee once per 6 s, never from a ranged attacker', () => {
    const h = setup()
    const { p } = h.enter([F.x - 2, 0, F.z])
    p.combat.range = 1.5
    const archer = spawn(h, ARCHER, F.x, F.z, null, p)
    hit(h, p, archer, 1)
    h.advance(1200)
    expect(dist(h, archer, p)).toBeGreaterThanOrEqual(7)
    expect(h.gameplay.roles.stats.steps).toBe(1)
    h.world.warp(p, h.world.positionAt(archer, h.now())[0] - 2, 0, F.z, h.now())
    h.advance(3000)
    expect(h.gameplay.roles.stats.steps).toBe(1)
    h.advance(3200)
    expect(h.gameplay.roles.stats.steps).toBe(2)

    const h2 = setup()
    const q = h2.enter([F.x - 2, 0, F.z]).p
    q.combat.range = 20
    const a2 = spawn(h2, ARCHER, F.x, F.z, null, q)
    hit(h2, q, a2, 1)
    h2.advance(2000)
    expect(h2.gameplay.roles.stats.steps).toBe(0)
  })
})

describe('coward (runner)', () => {
  it('under 25 % it runs 5 s from the attacker, then shouts and an idle nest-mate joins 3 s later; a helper never runs', () => {
    const h = setup()
    const { p, inbox } = h.enter([F.x - 2, 0, F.z])
    ;(h.gameplay as { rng: () => number }).rng = () => 0
    const n = newNest(COWARD.code)
    const c = spawn(h, COWARD, F.x, F.z, n, p)
    const mate = spawn(h, COWARD, F.x + 20, F.z, n, p)
    hit(h, p, c, 100)
    h.advance(1000)
    expect(h.gameplay.roles.stats.flights).toBe(0)
    hit(h, p, c, 700)
    expect(h.gameplay.roles.stats.flights).toBe(1)
    h.advance(3000)
    expect(dist(h, c, p)).toBeGreaterThan(12)
    h.advance(2100)
    expect(inbox.some((m) => m.t === 'chat' && m.text === `${COWARD.name} calls for help!`)).toBe(true)
    expect(mate.ai).toBe('idle')
    h.advance(3100)
    expect(mate.ai).toBe('chase')
    expect(mate.target).toBe(p.id)
    hit(h, p, mate, 800)
    h.advance(1000)
    expect(h.gameplay.roles.stats.flights).toBe(1)
  })

  it('rolls once per fight (40 % stand and fight)', () => {
    const h = setup()
    const { p } = h.enter([F.x - 2, 0, F.z])
    ;(h.gameplay as { rng: () => number }).rng = () => 0.99
    const c = spawn(h, COWARD, F.x, F.z, null, p)
    hit(h, p, c, 800)
    hit(h, p, c, 10)
    expect(h.gameplay.roles.stats.flights).toBe(0)
  })
})

describe('tick budget (the 100-player bar)', () => {
  it('roles cost little: 100 players fighting in a 1,500-monster field, roles on vs off', () => {
    const run = (climbRoles: boolean) => {
      const h = setup({ climbRoles })
      ;(h.gameplay as { rng: () => number }).rng = (() => {
        let s = 99
        return () => ((s = (s * 16807) % 2147483647) / 2147483647)
      })()
      const defs = [TIGER, HEALER, ARCHER, COWARD]
      const players: Player[] = []
      for (let g = 0; g < 100; g++) {
        const cx = -450 + (g % 10) * 90
        const cz = -450 + Math.floor(g / 10) * 90
        const n = newNest(defs[g % 4].code, { x: cx, z: cz })
        const mobs: Mob[] = []
        for (let i = 0; i < 15; i++) mobs.push(spawn(h, defs[(g + i) % 4], cx + (i % 5) * 3, cz + Math.floor(i / 5) * 3, n))
        const p = h.enter([cx - 3, 0, cz]).p
        p.combat.range = 1.5
        players.push(p)
        for (const [k, m] of mobs.slice(0, 3).entries()) {
          p.known.add(m.id)
          hit(h, p, m, [400, 50, 800][k])
        }
      }
      for (const p of players) p.hp = p.maxHp = 1e9
      h.advance(2000)
      h.world.worstTickMs = 0
      const t0 = performance.now()
      const ticks = 400
      for (let i = 0; i < ticks; i++) h.world.timedTick(h.now() + 50 * (i + 1))
      const mean = (performance.now() - t0) / ticks
      return { mean, worst: h.world.worstTickMs, stats: { ...h.gameplay.roles.stats } }
    }
    run(true)
    const off = run(false)
    const on = run(true)
    console.log(`roles tick budget: off mean ${off.mean.toFixed(3)} ms worst ${off.worst.toFixed(2)} ms; on mean ${on.mean.toFixed(3)} ms worst ${on.worst.toFixed(2)} ms; ${JSON.stringify(on.stats)}`)
    expect(on.stats.links + on.stats.heals + on.stats.steps).toBeGreaterThan(0)
    expect(on.mean).toBeLessThan(off.mean * 1.5 + 0.5)
  })
})
