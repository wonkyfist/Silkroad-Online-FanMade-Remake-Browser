import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHARACTER_RULES, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { goHome, mobReach, retaliate, thinkMob, type AiHost } from '../src/ai.ts'
import { openStore } from '../src/db.ts'
import {
  BASIC_ATTACK,
  MISS_MAX,
  MISS_MIN,
  balanceRatio,
  damageRoll,
  levelDiffBonus,
  maxHpFor,
  maxMpFor,
  missChance,
  mobCombatStats,
  playerCombatStats,
  rollHit,
  type CombatStats,
} from '../src/formulas.ts'
import { goldCode, rollDrops, shareRewards } from '../src/gameplay.ts'
import { withTownSpawn, type WorldSetup } from '../src/content.ts'
import { GameData, genderOf, parseContent, parseTowns } from '../src/gamedata.ts'
import { InvDraft, addItem, equipItem, fail, moveItem, newItem, splitItem, takeFromBag, unequipItem, type InvState } from '../src/inventory.ts'
import { FlatNav } from '../src/nav.ts'
import { gainExp, setLevel } from '../src/progression.ts'
import { Spawner } from '../src/spawner.ts'
import { World, type Mob, type Player } from '../src/world.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, TIGER, nest, seeded, wrap } from './fixtures.ts'

const defs = new Map(ITEMS.map((i) => [i.code, i]))
const lookup = (c: string) => defs.get(c)

function stats(over: Partial<CombatStats> = {}): CombatStats {
  return {
    level: 1,
    physAttack: [10, 20],
    magAttack: [0, 0],
    physDefence: 0,
    magDefence: 0,
    physAbsorb: 0,
    magAbsorb: 0,
    hitRate: 20,
    parryRate: 20,
    blockRate: 0,
    critRate: 0,
    balance: 1,
    ...over,
  }
}

describe('formulas', () => {
  it('max HP/MP follow 1.02^(lvl-1) x stat x 10 (200 at level 1 with 20 STR)', () => {
    expect(maxHpFor(1, 20)).toBe(200)
    expect(maxMpFor(1, 20)).toBe(200)
    expect(maxHpFor(20, 39)).toBe(Math.floor(Math.pow(1.02, 19) * 390))
  })

  it('balance ratio and level-difference bonus are clamped', () => {
    expect(balanceRatio(1, 20)).toBeCloseTo(20 / 32)
    expect(balanceRatio(1, 1000)).toBe(1.2)
    expect(levelDiffBonus(10, 1)).toBeCloseTo(0.27)
    expect(levelDiffBonus(30, 1)).toBe(0.3)
    expect(levelDiffBonus(1, 10)).toBe(0)
  })

  it('miss chance grows with the parry/hit ratio and the level gap, within bounds', () => {
    expect(missChance(stats(), stats())).toBeCloseTo(0.08)
    expect(missChance(stats({ hitRate: 1e6 }), stats())).toBe(MISS_MIN)
    expect(missChance(stats({ hitRate: 1 }), stats({ parryRate: 1e6 }))).toBe(MISS_MAX)
    expect(missChance(stats(), stats({ level: 6 }))).toBeCloseTo(0.18)
  })

  it('damage: defence and absorb reduce it, it never drops to 0, and crits double it', () => {
    const r = seeded(7)
    for (let i = 0; i < 200; i++) {
      const d = damageRoll(stats(), stats({ physDefence: 5 }), 100, false, r)
      expect(d).toBeGreaterThanOrEqual(1)
      expect(d).toBeLessThanOrEqual(15)
    }
    // armour far above the attack: a random 1-10% of the rolled AP, at least 1
    for (let i = 0; i < 50; i++) expect(damageRoll(stats(), stats({ physDefence: 1000 }), 100, false, r)).toBeLessThanOrEqual(2)
    const fixed = () => 0.5
    const plain = damageRoll(stats({ physAttack: [100, 100] }), stats(), 100, false, fixed)
    expect(damageRoll(stats({ physAttack: [100, 100] }), stats(), 100, true, fixed)).toBe(plain * 2)
    expect(damageRoll(stats({ physAttack: [100, 100] }), stats({ physAbsorb: 100 }), 100, false, fixed)).toBe(plain / 2)
    expect(damageRoll(stats({ physAttack: [100, 100], balance: 0.5 }), stats(), 100, false, fixed)).toBe(plain / 2)
  })

  it('rollHit produces misses, blocks and crits at roughly their rates', () => {
    const r = seeded(3)
    const n = 4000
    const count = { hit: 0, crit: 0, miss: 0, block: 0 }
    for (let i = 0; i < n; i++) count[rollHit(stats({ critRate: 10 }), stats({ blockRate: 20 }), 100, r).outcome]++
    expect(count.miss / n).toBeCloseTo(0.08, 1)
    expect(count.block / n).toBeCloseTo(0.92 * 0.2, 1)
    expect(count.crit / (count.crit + count.hit)).toBeCloseTo(0.1, 1)
  })

  it('player stats come from level, STR/INT and worn items', () => {
    const blade = defs.get('ITEM_CH_BLADE_01_A_DEF')!
    const s = playerCombatStats(1, 20, 20, [{ def: blade, stack: { code: blade.code, count: 1 } }])
    expect(s.physAttack).toEqual([14, 18])
    expect(s.weapon).toBe('blade')
    expect(s.range).toBe(1.5)
    expect(playerCombatStats(1, 20, 20, []).weapon).toBe('fist')
    expect(mobCombatStats(MANGNYANG, 'champion').physAttack).toEqual([5, 7])
    expect(BASIC_ATTACK.blade.hits).toBe(2)
  })
})

describe('progression', () => {
  const need = (l: number) => LEVELS[l - 1]?.exp ?? 0
  it('carries EXP over several levels and grants STR/INT/stat points', () => {
    const p = { level: 1, exp: 0, sp: 0, spExp: 0, str: 20, int: 20, statPoints: 0 }
    expect(gainExp(p, 30 + 100 + 25, 0, 20, need)).toBe(2)
    expect(p).toMatchObject({ level: 3, exp: 25, str: 22, int: 22, statPoints: 6 })
  })
  it('stops at the cap (no EXP kept) but still converts SP-EXP', () => {
    const p = { level: 1, exp: 0, sp: 0, spExp: 0, str: 20, int: 20, statPoints: 0 }
    gainExp(p, 1e9, CHARACTER_RULES.spExpPerSp * 2 + 5, 3, need)
    expect(p).toMatchObject({ level: 3, exp: 0, sp: 2, spExp: 5 })
    expect(gainExp(p, 100, 0, 3, need)).toBe(0)
    expect(p.exp).toBe(0)
  })
  it('stops when the level table ends', () => {
    const p = { level: 5, exp: 0, sp: 0, spExp: 0, str: 24, int: 24, statPoints: 12 }
    gainExp(p, 1e6, 0, 20, need)
    expect(p.level).toBe(6)
  })
  it('setLevel applies the growth for the difference, never below the base', () => {
    const p = { level: 1, exp: 10, sp: 0, spExp: 0, str: 20, int: 20, statPoints: 0 }
    setLevel(p, 10)
    expect(p).toMatchObject({ level: 10, exp: 0, str: 29, int: 29, statPoints: 27 })
    setLevel(p, 1)
    expect(p).toMatchObject({ level: 1, str: 20, int: 20, statPoints: 0 })
  })
})

describe('content loading', () => {
  it('skips malformed records, reports them and accepts bare level arrays', () => {
    const { entries, report } = parseContent('mobs', wrap('mobs', [MANGNYANG, { ...MANGNYANG, code: 'bad code' }, 5]))
    expect(entries.map((m: any) => m.code)).toEqual([MANGNYANG.code])
    expect(report).toMatchObject({ count: 1, skipped: 2, status: 'ok' })
    expect(parseContent('levels', JSON.stringify(LEVELS)).entries).toHaveLength(5)
    expect(parseContent('items', null).report.status).toBe('missing')
    expect(parseContent('items', '{nope').report.status).not.toBe('ok')
    expect(parseContent('items', wrap('mobs', [])).report.status).toMatch(/kind/)
  })

  it('loads nothing (without throwing) from an empty directory', () => {
    const data = GameData.load(join(tmpdir(), 'sro-no-such-dir'))
    expect(data.mobs.size + data.items.size + data.nests.length).toBe(0)
    expect(data.summary()).toHaveLength(8)
    expect(data.summary()[0]).toMatch(/missing/)
  })

  it('picks the starter weapon and the default garments by gender', () => {
    const data = new GameData({ items: ITEMS, levels: LEVELS })
    expect(data.starterWeapon('blade')!.code).toBe('ITEM_CH_BLADE_01_A_DEF')
    expect(data.starterWeapon('glaive')!.code).toBe('ITEM_CH_TBLADE_01_A_DEF')
    expect(data.starterGarments('female').map((i) => i.code).sort()).toEqual([
      'ITEM_CH_W_CLOTHES_01_BA_A_DEF',
      'ITEM_CH_W_CLOTHES_01_FA_A_DEF',
      'ITEM_CH_W_CLOTHES_01_LA_A_DEF',
    ])
    expect(data.expToNext(1, 20)).toBe(30)
    expect(data.expToNext(20, 20)).toBe(0)
    expect(genderOf('CHAR_CH_WOMAN_FOX')).toBe('female')
    expect(genderOf('CHAR_CH_MAN_MONK')).toBe('male')
  })
})

describe('loot and rewards', () => {
  it('rolls gold and one weighted entry per group, ignoring unknown items', () => {
    const drops = rollDrops(DROPS[0], seeded(1), (c) => defs.has(c))
    expect(drops[0]).toMatchObject({ gold: true, code: 'ITEM_ETC_GOLD_01' })
    expect(drops[0].count).toBeGreaterThanOrEqual(10)
    expect(drops[0].count).toBeLessThanOrEqual(20)
    expect(drops.slice(1)).toEqual([{ code: 'ITEM_CH_BLADE_02_A', count: 1 }])
    expect(goldCode(999)).toBe('ITEM_ETC_GOLD_01')
    expect(goldCode(5000)).toBe('ITEM_ETC_GOLD_02')
    expect(goldCode(10_000)).toBe('ITEM_ETC_GOLD_03')
  })
  it('shares EXP by damage among players still present', () => {
    const shares = shareRewards(new Map([[1, 30], [2, 10], [3, 60]]), (id) => id !== 3, 100, 40)
    expect(Object.fromEntries(shares)).toEqual({ 1: { exp: 75, spExp: 30 }, 2: { exp: 25, spExp: 10 } })
    expect(shareRewards(new Map(), () => true, 100, 100).size).toBe(0)
  })
})

describe('spawner', () => {
  it('fills nests, skips other worlds/unknown/too high/outside, respawns after the delay', () => {
    const nests = [
      nest(1, MANGNYANG.code, 0, 0, { count: 3, respawnSec: [2, 4] }),
      nest(2, MANGNYANG.code, 0, 0, { world: 'donwhang' }),
      nest(3, 'MOB_CH_NOBODY', 0, 0),
      nest(4, TIGER.code, 0, 0),
      nest(5, MANGNYANG.code, 999, 0),
    ]
    const mobs = new Map([[MANGNYANG.code, MANGNYANG], [TIGER.code, TIGER]])
    const sp = new Spawner(nests, (c) => mobs.get(c), { world: 'jangan', mobLevelMax: 10, rng: () => 0.5 }, (x) => x < 500)
    expect(sp.nests.map((n) => n.def.id)).toEqual([1])
    expect(sp.skipped.map((s) => s.nest)).toEqual([2, 3, 4, 5])
    let next = 100
    const spawn = () => next++
    expect(sp.fill(spawn)).toBe(3)
    expect(sp.fill(spawn)).toBe(0)
    expect(sp.died(100, 1000)).toBe(1000 + 3000)
    expect(sp.died(100, 1000)).toBeNull()
    expect(sp.died(999, 1000)).toBeNull()
    expect(sp.tick(3999, spawn)).toBe(0)
    expect(sp.tick(4000, spawn)).toBe(1)
    expect(sp.nests[0].alive.size).toBe(3)
    // a failed spawn is retried later, not lost
    sp.died(101, 5000)
    expect(sp.tick(9000, () => null)).toBe(0)
    expect(sp.nests[0].pending).toEqual([14000])
  })
})

describe('mob AI', () => {
  function makeMob(over: Partial<Mob> = {}): Mob {
    return {
      kind: 'mob', id: 1, def: MANGNYANG, variant: 'normal', name: 'm', level: 1, hp: 20, maxHp: 20, radius: 0.5,
      combat: mobCombatStats(MANGNYANG, 'normal'), pos: [0, 0, 0], yaw: 0, move: null, home: [0, 0], roamRadius: 5,
      sightRange: 10, leashRange: 25, aggressive: false, nest: null, ai: 'idle', target: null, damage: new Map(),
      nextSwingAt: 0, nextThinkAt: 0, lastCombatAt: 0, nextRegenAt: 0, diedAt: 0, ...over,
    }
  }
  function makePlayer(id: number, pos: Vec3): Player {
    return { id, kind: 'player', pos, radius: 0.5, dead: false, invisible: false, move: null } as unknown as Player
  }
  function host(players: Player[], now = 1000) {
    const log: string[] = []
    const h: AiHost & { log: string[]; now: number } = {
      now,
      log,
      rng: seeded(2),
      positionOf: (e) => [...e.pos] as Vec3,
      target: (id) => players.find((p) => p.id === id && !p.dead),
      playersNear: (x, z, r) => players.filter((p) => !p.dead && Math.hypot(p.pos[0] - x, p.pos[2] - z) <= r),
      canWalk: () => true,
      move: (m, x, z, speed) => {
        log.push(`move ${x.toFixed(1)},${z.toFixed(1)} @${speed}`)
        m.pos = [x, 0, z] // teleport-style: the fake host moves instantly
        m.move = null
        return true
      },
      halt: (_m, yaw) => log.push(`halt ${yaw === undefined ? '' : yaw.toFixed(2)}`),
      swing: (_m, t) => log.push(`swing ${t.id}`),
      restored: (m) => {
        m.hp = m.maxHp
        log.push('restored')
      },
    }
    return h
  }

  it('idle mobs wander inside their roam radius', () => {
    const m = makeMob()
    const h = host([])
    for (let i = 0; i < 20; i++) {
      h.now += 20_000
      thinkMob(m, h)
      expect(Math.hypot(m.pos[0], m.pos[2])).toBeLessThanOrEqual(5 + 1e-9)
    }
    expect(h.log.filter((l) => l.startsWith('move'))).toHaveLength(20)
    expect(h.log[0]).toMatch(/@1.5$/)
  })

  it('passive mobs ignore players until hit, then chase at run speed and attack at their interval', () => {
    const p = makePlayer(7, [6, 0, 0])
    const m = makeMob()
    const h = host([p])
    thinkMob(m, h)
    expect(m.ai).toBe('idle')
    retaliate(m, 7, 5)
    expect(m).toMatchObject({ ai: 'chase', target: 7 })
    thinkMob(m, h)
    expect(h.log.at(-1)).toMatch(/@4$/)
    expect(Math.hypot(m.pos[0] - 6, m.pos[2])).toBeLessThanOrEqual(mobReach(m, p))
    thinkMob(m, h)
    expect(h.log.at(-1)).toBe('swing 7')
    h.now += 1000
    thinkMob(m, h)
    expect(h.log.filter((l) => l === 'swing 7')).toHaveLength(1)
    h.now += 1000
    thinkMob(m, h)
    expect(h.log.filter((l) => l === 'swing 7')).toHaveLength(2)
  })

  it('aggressive mobs acquire the nearest player in sight', () => {
    const near = makePlayer(1, [4, 0, 0])
    const far = makePlayer(2, [20, 0, 0])
    const m = makeMob({ aggressive: true })
    thinkMob(m, host([far, near]))
    expect(m).toMatchObject({ ai: 'chase', target: 1 })
    const m2 = makeMob({ aggressive: true })
    thinkMob(m2, host([far]))
    expect(m2.ai).toBe('idle')
  })

  it('leashes: gives up past the leash range, runs home, regenerates, goes idle', () => {
    const p = makePlayer(1, [3, 0, 0])
    const m = makeMob({ aggressive: true, hp: 3 })
    const h = host([p])
    thinkMob(m, h)
    thinkMob(m, h)
    p.pos = [40, 0, 0]
    thinkMob(m, h)
    expect(m.ai).toBe('return')
    expect(m.target).toBeNull()
    expect(m.damage.size).toBe(0)
    thinkMob(m, h)
    expect(m.ai).toBe('idle')
    expect(m.hp).toBe(20)
    expect(h.log).toContain('restored')
  })

  it('switches to the next attacker when its target dies, and goes home when none is left', () => {
    const a = makePlayer(1, [1, 0, 0])
    const b = makePlayer(2, [-1, 0, 0])
    const m = makeMob()
    const h = host([a, b])
    retaliate(m, 1, 10)
    retaliate(m, 2, 3)
    a.dead = true
    thinkMob(m, h)
    expect(m.target).toBe(2)
    b.dead = true
    thinkMob(m, h)
    expect(m.ai).toBe('return')
    thinkMob(m, h)
    expect(m.ai).toBe('idle')
    // a mob that cannot move at all is home at once
    const stuck = makeMob({ ai: 'chase', pos: [3, 0, 0] })
    goHome(stuck, { ...h, move: () => false })
    expect(stuck.ai).toBe('idle')
  })

  it('navmesh: wander points behind a wall are dropped for clear ones; a mob walled off from home is warped back', () => {
    const m = makeMob()
    const h = host([])
    const tried: [number, number][] = []
    // only points east of x = 1 have a clear straight walk
    h.clear = (_m, x, z) => {
      tried.push([x, z])
      return x > 1
    }
    for (let i = 0; i < 10; i++) {
      h.now += 20_000
      thinkMob(m, h)
    }
    const moves = h.log.filter((l) => l.startsWith('move'))
    expect(moves.length).toBeGreaterThan(0)
    for (const l of moves) expect(Number(/^move (-?[\d.]+),/.exec(l)![1])).toBeGreaterThan(1)
    expect(tried.some(([x]) => x <= 1)).toBe(true)

    // chased away, then the run home is blocked right away: leash reset (warp home), restored, idle
    const warped: number[] = []
    const far = makeMob({ ai: 'return', pos: [30, 0, 0] })
    thinkMob(far, { ...h, move: () => false, warpHome: (mm) => {
      warped.push(mm.id)
      mm.pos = [0, 0, 0]
    } })
    expect(warped).toEqual([far.id])
    expect(far.ai).toBe('idle')
    expect(far.pos).toEqual([0, 0, 0])
  })
})

describe('inventory rules', () => {
  const empty = (bagSize = 4): InvState => ({ bagSize, bag: Array(bagSize).fill(null), equip: {}, gold: 0 })
  const potion = defs.get('ITEM_ETC_HP_POTION_01')!

  it('adds stacks (top up first, then empty slots) all-or-nothing', () => {
    const d = new InvDraft(empty())
    expect(addItem(d, potion, 70)).toEqual({ ok: true, value: [0, 1] })
    expect(d.bag.map((i) => i?.count ?? 0)).toEqual([50, 20, 0, 0])
    expect(addItem(d, potion, 40)).toEqual({ ok: true, value: [1, 2] })
    expect(d.bag.map((i) => i?.count ?? 0)).toEqual([50, 50, 10, 0])
    const before = JSON.stringify(d.bag)
    const full = new InvDraft(d.state())
    expect(addItem(full, potion, 1000)).toEqual(fail('inventory_full'))
    expect(JSON.stringify(d.bag)).toBe(before)
    expect(addItem(d, potion, 0).ok).toBe(false)
  })

  it('moves: into empty slots, merges same stacks, swaps otherwise', () => {
    const d = new InvDraft(empty())
    d.setBag(0, newItem(potion.code, 30))
    d.setBag(1, newItem(potion.code, 40))
    d.setBag(2, newItem('ITEM_CH_BLADE_02_A', 1))
    expect(moveItem(d, 0, 1, lookup).ok).toBe(true)
    expect([d.bag[0]?.count, d.bag[1]?.count]).toEqual([20, 50])
    expect(moveItem(d, 2, 0, lookup).ok).toBe(true)
    expect([d.bag[0]?.code, d.bag[2]?.code]).toEqual(['ITEM_CH_BLADE_02_A', potion.code])
    expect(moveItem(d, 3, 0, lookup)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(moveItem(d, 0, 0, lookup).ok).toBe(false)
    expect(moveItem(d, 0, 4, lookup).ok).toBe(false)
  })

  it('splits only into an empty slot and only part of a stack', () => {
    const d = new InvDraft(empty())
    d.setBag(0, newItem(potion.code, 10))
    expect(splitItem(d, 0, 1, 10)).toMatchObject({ reason: 'invalid_count' })
    expect(splitItem(d, 0, 1, 4).ok).toBe(true)
    expect([d.bag[0]?.count, d.bag[1]?.count]).toEqual([6, 4])
    expect(splitItem(d, 0, 1, 1)).toMatchObject({ reason: 'invalid_slot' })
    expect(takeFromBag(d, 0, 7)).toMatchObject({ reason: 'invalid_count' })
    expect(takeFromBag(d, 0, 6)).toMatchObject({ ok: true, value: { count: 6 } })
    expect(d.bag[0]).toBeNull()
  })

  it('equip rules: slot, level, gender, race, rings, two-handed vs shield', () => {
    const who = { level: 1, gender: 'male' as const }
    const d = new InvDraft(empty())
    const put = (i: number, code: string) => d.setBag(i, newItem(code, 1))
    put(0, 'ITEM_CH_BLADE_05_A')
    expect(equipItem(d, 0, undefined, who, lookup)).toMatchObject({ reason: 'requirements' })
    put(0, 'ITEM_CH_W_CLOTHES_01_BA_A_DEF')
    expect(equipItem(d, 0, undefined, who, lookup)).toMatchObject({ reason: 'requirements' })
    put(0, potion.code)
    expect(equipItem(d, 0, undefined, who, lookup)).toMatchObject({ reason: 'invalid_slot' })
    put(0, 'ITEM_CH_BLADE_02_A')
    expect(equipItem(d, 0, 'shield', who, lookup)).toMatchObject({ reason: 'invalid_slot' })
    expect(equipItem(d, 0, undefined, who, lookup)).toEqual({ ok: true, value: 'weapon' })
    put(0, 'ITEM_CH_SHIELD_01_A')
    expect(equipItem(d, 0, undefined, who, lookup).ok).toBe(true)
    // a two-handed weapon swaps with the blade and pushes the shield into a free slot
    put(0, 'ITEM_CH_SPEAR_01_A_DEF')
    expect(equipItem(d, 0, undefined, who, lookup).ok).toBe(true)
    expect(d.equip.weapon?.code).toBe('ITEM_CH_SPEAR_01_A_DEF')
    expect(d.equip.shield).toBeUndefined()
    expect(d.bag.map((i) => i?.code ?? null)).toEqual(['ITEM_CH_BLADE_02_A', 'ITEM_CH_SHIELD_01_A', null, null])
    expect(equipItem(d, 1, undefined, who, lookup)).toMatchObject({ reason: 'requirements' })
    // rings fill ring1 then ring2
    put(2, 'ITEM_CH_RING_01_A')
    put(3, 'ITEM_CH_RING_01_A')
    expect(equipItem(d, 2, undefined, who, lookup)).toEqual({ ok: true, value: 'ring1' })
    expect(equipItem(d, 3, undefined, who, lookup)).toEqual({ ok: true, value: 'ring2' })
    expect(unequipItem(d, 'ring2', 1)).toMatchObject({ reason: 'invalid_slot' })
    expect(unequipItem(d, 'ring2')).toEqual({ ok: true, value: 2 })
    expect(unequipItem(d, 'head')).toMatchObject({ reason: 'invalid_slot' })
  })

  it('refuses a two-handed weapon when the shield has nowhere to go', () => {
    const d = new InvDraft(empty(1))
    d.setEquip('weapon', newItem('ITEM_CH_BLADE_01_A_DEF', 1))
    d.setEquip('shield', newItem('ITEM_CH_SHIELD_01_A', 1))
    d.setBag(0, newItem('ITEM_CH_SPEAR_01_A_DEF', 1))
    expect(equipItem(d, 0, undefined, { level: 1, gender: 'male' }, lookup)).toMatchObject({ reason: 'inventory_full' })
  })
})

describe('inventory transactions (SQLite)', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'sro-inv-'))
    const store = openStore(dir)
    const acc = store.createAccount('inv', 'x')!
    const ch = store.createCharacter(acc, 'Hero', 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof ch === 'string') throw new Error(ch)
    return { store, id: ch.id }
  }

  it('writes only successful operations and rolls back a throw', () => {
    const { store, id } = setup()
    const potion = defs.get('ITEM_ETC_HP_POTION_01')!
    expect(store.inventoryTx(id, (d) => addItem(d, potion, 60)).result.ok).toBe(true)
    expect(store.loadInventory(id).bag.slice(0, 2).map((i) => i?.count)).toEqual([50, 10])
    // failure: the draft changed, nothing is written
    const r = store.inventoryTx(id, (d) => {
      d.setBag(5, newItem(potion.code, 1))
      return fail('invalid_slot')
    })
    expect(r.result.ok).toBe(false)
    expect(store.loadInventory(id).bag[5]).toBeNull()
    // a throw inside the transaction rolls back every write, gold included
    expect(() =>
      store.inventoryTx(
        id,
        (d) => {
          d.setGold(999)
          return addItem(d, potion, 10)
        },
        () => {
          throw new Error('boom')
        },
      ),
    ).toThrow('boom')
    const inv = store.loadInventory(id)
    expect(inv.gold).toBe(0)
    expect(inv.bag.slice(0, 2).map((i) => i?.count)).toEqual([50, 10])
    store.close()
  })

  it('never duplicates: 200 interleaved moves/splits keep the total', () => {
    const { store, id } = setup()
    const potion = defs.get('ITEM_ETC_HP_POTION_01')!
    store.inventoryTx(id, (d) => addItem(d, potion, 120))
    const r = seeded(9)
    for (let i = 0; i < 200; i++) {
      const from = Math.floor(r() * 6)
      const to = Math.floor(r() * 6)
      if (r() < 0.5) store.inventoryTx(id, (d) => moveItem(d, from, to, lookup))
      else store.inventoryTx(id, (d) => splitItem(d, from, to, 1 + Math.floor(r() * 20)))
    }
    const total = store.loadInventory(id).bag.reduce((s, i) => s + (i?.count ?? 0), 0)
    expect(total).toBe(120)
    // the UNIQUE constraints make a double-booked slot impossible even for a buggy caller
    expect(() => store.db.prepare("INSERT INTO items (character_id, bag_slot, code, count) VALUES (?, 0, 'X', 1)").run(id)).toThrow(/UNIQUE/)
    store.close()
  })

  it('gives the starter kit once', () => {
    const { store, id } = setup()
    expect(store.grantStarterKit(id, [])).toBe(false)
    expect(store.grantStarterKit(id, [{ code: 'ITEM_CH_BLADE_01_A_DEF', slot: 'weapon' }])).toBe(true)
    expect(store.grantStarterKit(id, [{ code: 'ITEM_CH_SWORD_01_A_DEF', slot: 'weapon' }])).toBe(false)
    expect(store.loadInventory(id).equip.weapon?.code).toBe('ITEM_CH_BLADE_01_A_DEF')
    expect(store.characterById(id)).toMatchObject({ strength: 20, intellect: 20, gold: 0, bag_size: 48, starter_kit: 1, hp: null })
    store.close()
  })
})

describe('towns', () => {
  it('reads towns.json leniently and moves the spawn to the town unless SPAWN_X/Z or the manifest set one', () => {
    const towns = parseTowns(
      JSON.stringify({
        schema: 1,
        kind: 'towns',
        entries: [
          { code: 'JANGAN', name: 'Jangan', world: 'jangan', spawn: { x: 96.9, y: 0, z: -136.9 }, safeArea: { x: 80, z: -200, halfX: 250, halfZ: 170 } },
          { code: 'BAD', world: 'jangan', spawn: { x: 'no' } },
          { code: 'NOSAFE', world: 'donwhang', spawn: { x: 1, z: 2 }, safeArea: { x: 1, z: 2, halfX: -1, halfZ: 5 } },
        ],
      }),
    )
    expect(towns.map((t) => t.code)).toEqual(['JANGAN', 'NOSAFE'])
    expect(towns[1].safeArea).toBeUndefined()
    expect(parseTowns('nope')).toEqual([])
    const data = new GameData({ towns })
    expect(data.inSafeArea('jangan', 80, -200)).toBe(true)
    expect(data.inSafeArea('jangan', 80, 0)).toBe(false)
    expect(data.inSafeArea('donwhang', 1, 2)).toBe(false)
    const base: WorldSetup = { spawn: { x: 96, y: 0, z: -96 }, spawnSource: 'centre of region 168,97', bounds: null, displayName: 'Jangan', regionOrigin: null, places: [{ name: 'jangan', x: 96, z: -96, group: 'town' }, { name: 'spawn', x: 96, z: -96, group: 'town' }, { name: 'gate', x: 1, z: 1, group: 'fields' }] }
    const moved = withTownSpawn(base, 'jangan', data.town('jangan'))
    expect(moved.spawn).toEqual({ x: 96.9, y: 0, z: -136.9 })
    expect(moved.places.map((p) => [p.name, p.x])).toEqual([['jangan', 96.9], ['spawn', 96.9], ['gate', 1]])
    expect(withTownSpawn({ ...base, spawnSource: 'manifest spawn' }, 'jangan', data.town('jangan')).spawn.x).toBe(96)
    expect(withTownSpawn({ ...base, spawnSource: 'SPAWN_X/SPAWN_Z' }, 'jangan', data.town('jangan')).spawn.x).toBe(96)
    expect(withTownSpawn(base, 'jangan', undefined)).toBe(base)
  })
})

describe('interest management (World)', () => {
  it('spawns within the view range, despawns only past the margin, and on removal', () => {
    const w = new World('jangan', 10, 10, null)
    w.viewRange = 50
    const sent: string[] = []
    const p = w.add({ characterId: 1, name: 'A', model: 'M', level: 1, weapon: 'bow', pos: [0, 0, 0], yaw: 0, send: (m) => sent.push(`${m.t}:${'id' in m ? m.id : 'entity' in m ? m.entity.id : ''}`) })
    const near = { kind: 'npc' as const, id: w.newId(), code: 'NPC_X', name: 'x', pos: [30, 0, 0] as Vec3, yaw: 0 }
    const far = { kind: 'npc' as const, id: w.newId(), code: 'NPC_Y', name: 'y', pos: [200, 0, 0] as Vec3, yaw: 0 }
    w.addEntity(near)
    w.addEntity(far)
    expect(sent).toEqual([`spawn:${near.id}`])
    // 55 m away: out of range (50) but inside the margin (+10): kept
    p.pos = [-25, 0, 0]
    w.updateInterest(1000)
    expect(sent).toHaveLength(1)
    p.pos = [-35, 0, 0]
    w.updateInterest(2000)
    expect(sent.at(-1)).toBe(`despawn:${near.id}`)
    p.pos = [160, 0, 0]
    w.updateInterest(3000)
    expect(sent.at(-1)).toBe(`spawn:${far.id}`)
    w.removeEntity(far.id)
    expect(sent.at(-1)).toBe(`despawn:${far.id}`)
    expect(p.known.size).toBe(0)
    expect(w.snapshotFor(p, 4000)).toEqual([])
  })
})

describe('nav fallback', () => {
  it('walks anywhere inside the bounds, refuses outside', () => {
    const nav = new FlatNav({ minX: 0, minZ: -10, maxX: 10, maxZ: 0 })
    expect(nav.canWalk(5, -5)).toBe(true)
    expect(nav.canWalk(11, -5)).toBe(false)
    expect(nav.moveStraight([1, 2, -1], [3, 0, -3])).toEqual([3, 2, -3])
    expect(nav.moveStraight([1, 2, -1], [30, 0, -3])).toBeNull()
    expect(nav.heightAt()).toBeNull()
    expect(new FlatNav(null).canWalk(1e9, NaN)).toBe(false)
    // the NavProvider surface of the fallback: no surfaces, flat heights, refusals outside the bounds
    expect(nav.kind).toBe('flat')
    expect(nav.locate(5, -5, 2)).toEqual({ x: 5, y: 2, z: -5, surface: null })
    expect(nav.locate(50, -5, 2)).toBeNull()
    expect(nav.place(5, -5, NaN)).toEqual({ x: 5, y: 0, z: -5, surface: null })
    expect(nav.walk({ x: 1, y: 2, z: -1, surface: null }, 3, -3)).toEqual({ end: { x: 3, y: 2, z: -3, surface: null }, blocked: false, legs: [] })
    expect(nav.walk({ x: 1, y: 2, z: -1, surface: null }, 30, -3)).toBeNull()
    expect(nav.surfaceKey(null)).toBeNull()
    expect(nav.restore('t', 1, 1)).toBeNull()
  })

  it('a World keeps y from a flat walk and the surface stays unknown', () => {
    const w = new World('jangan', 10, 10, { minX: 0, minZ: -10, maxX: 10, maxZ: 0 }, new FlatNav({ minX: 0, minZ: -10, maxX: 10, maxZ: 0 }))
    const p = w.add({ characterId: 1, name: 'A', model: 'M', level: 1, weapon: 'bow', pos: [1, 2, -1], yaw: 0, send: () => {} })
    w.moveTo(p, 5, -5, 1000)
    expect(p.move).toMatchObject({ from: [1, 2, -1], to: [5, 2, -5] })
    expect(w.livePoint(p, 1000 + 100_000)).toEqual({ x: 5, y: 2, z: -5, surface: null })
    expect(w.livePoint(p, 1000)).toEqual({ x: 1, y: 2, z: -1, surface: null })
  })
})
