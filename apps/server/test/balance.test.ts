/**
 * Balance fixes and rate knobs (docs/BALANCE.md §6-§7):
 * - mobs whose only attack is magical (Tomb Stone Ghost, Tomb Stone: mobs.json physAttack [0, 0]) swing with their magic
 *   attack; rolled as a physical hit they always did 1 damage;
 * - magical damage (imbues, force attacks) is scaled by the INT balance, physical damage by the STR balance
 *   (research report §4.5 "Physical / magical balance");
 * - EXP_RATE / SP_RATE multiply kill EXP / SP-EXP, GOLD_RATE dropped gold, DROP_RATE each item group's chance.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DropTable, ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, type ServerConfig } from '../src/config.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { attacksMagically, damageRoll, imbueDamage, mobCombatStats, playerCombatStats, type CombatStats } from '../src/formulas.ts'
import { Gameplay, rollDrops } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { World } from '../src/world.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, mob, seeded } from './fixtures.ts'
import { testConfig } from './helpers.ts'

/** The retail Tomb Stone Ghost's attack numbers (mobs.json): no physical attack, a 10 m force attack. */
const TOMB = mob('MOB_CH_TOMBSTONE_CLON', { name: 'Tomb Stone Ghost', level: 8, hp: 204, physAttack: [0, 0], magAttack: [74, 83], hitRate: 41, parryRate: 41, attackRange: 10, exp: 5, spExp: 100 })

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function harness(over: Partial<ServerConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-balance-'))
  const config = { ...testConfig(root), rng: seeded(3), ...over }
  const store = openStore(config.dataDir)
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG, TOMB], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: [], shops: [], towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(3) })
  const acc = store.createAccount('balanceacc', 'x')!
  const row = store.createCharacter(acc, 'Balancer', 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
  if (typeof row === 'string') throw new Error(row)
  const inbox: ServerMessage[] = []
  const p = world.add({ ...gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos: [0, 0, 0], yaw: 0, send: (m) => inbox.push(m) })
  return { gameplay, p, inbox }
}

describe('mobs with only a magical attack', () => {
  it('attacksMagically picks exactly the mobs without a physical attack', () => {
    expect(attacksMagically(mobCombatStats(TOMB, 'normal'))).toBe(true)
    expect(attacksMagically(mobCombatStats(MANGNYANG, 'normal'))).toBe(false)
    expect(attacksMagically(mobCombatStats(mob('MOB_T_BOTH', { physAttack: [5, 6], magAttack: [9, 10] }), 'normal'))).toBe(false)
    expect(attacksMagically(mobCombatStats(mob('MOB_T_NONE', { physAttack: [0, 0], magAttack: [0, 0] }), 'normal'))).toBe(false)
  })

  it('a Tomb Stone Ghost hurts: its swings roll its magic attack against the magic defence, not the 1-damage floor', () => {
    const { gameplay, p } = harness()
    const now = Date.now()
    const m = gameplay.createMob(TOMB, 'normal', 1, 0, 0, null, now)
    const dealt: number[] = []
    for (let i = 0; i < 40; i++) {
      p.hp = 100_000
      gameplay.attack(m, p, now + i)
      dealt.push(100_000 - p.hp)
    }
    const landed = dealt.filter((d) => d > 0)
    expect(landed.length).toBeGreaterThan(20)
    // 74-83 magic attack against a level-1 character's ~3-4 magic defence: every landed hit does tens of damage (the
    // old physical roll of a [0, 0] attack gave exactly 1).
    for (const d of landed) expect(d).toBeGreaterThanOrEqual(30)
  })
})

describe('magical damage uses the INT balance', () => {
  const stats = (over: Partial<CombatStats> = {}): CombatStats => ({
    level: 10, physAttack: [100, 100], magAttack: [100, 100], physDefence: 0, magDefence: 0, physAbsorb: 0, magAbsorb: 0,
    hitRate: 50, parryRate: 50, blockRate: 0, critRate: 0, balance: 1, ...over,
  })
  const fixed = () => 0.5

  it('playerCombatStats: balance from STR, magBalance from INT (stat / (4 lvl + 28))', () => {
    const c = playerCombatStats(10, 60, 20, [])
    expect(c.balance).toBeCloseTo(60 / 68)
    expect(c.magBalance).toBeCloseTo(20 / 68)
  })

  it('magical hits and imbues scale with magBalance, physical hits with balance', () => {
    const full = damageRoll(stats(), stats(), 100, false, fixed, true)
    expect(damageRoll(stats({ magBalance: 0.5 }), stats(), 100, false, fixed, true)).toBe(full / 2)
    expect(imbueDamage(stats({ magBalance: 0.5 }), stats(), 100, [0, 0], fixed)).toBe(full / 2)
    // Physical damage ignores magBalance; a stats object without magBalance (mobs) keeps using balance.
    expect(damageRoll(stats({ magBalance: 0.5 }), stats(), 100, false, fixed)).toBe(full)
    expect(damageRoll(stats({ balance: 0.5 }), stats(), 100, false, fixed, true)).toBe(full / 2)
  })

  it('an all-STR character imbues for its INT balance, not its STR balance', () => {
    const str = playerCombatStats(10, 56, 29, [])
    const target = stats({ level: 10 })
    const got = imbueDamage(str, target, 100, [0, 0], fixed)
    const asInt = damageRoll({ ...str, balance: str.magBalance! }, target, 100, false, fixed, true)
    expect(got).toBe(asInt)
    expect(got).toBeLessThan(damageRoll({ ...str, magBalance: str.balance }, target, 100, false, fixed, true))
  })
})

describe('rate knobs', () => {
  it('config: EXP_RATE, SP_RATE, DROP_RATE and GOLD_RATE default to 1 and are validated', () => {
    expect(loadConfig({ WORLD_EXPORT: 'jangan' })).toMatchObject({ expRate: 1, spRate: 1, dropRate: 1, goldRate: 1 })
    expect(loadConfig({ WORLD_EXPORT: 'jangan', EXP_RATE: '3', SP_RATE: '2.5', DROP_RATE: '2', GOLD_RATE: '4' })).toMatchObject({ expRate: 3, spRate: 2.5, dropRate: 2, goldRate: 4 })
    for (const key of ['EXP_RATE', 'SP_RATE', 'DROP_RATE', 'GOLD_RATE']) {
      expect(() => loadConfig({ WORLD_EXPORT: 'jangan', [key]: '-1' })).toThrow(key)
      expect(() => loadConfig({ WORLD_EXPORT: 'jangan', [key]: 'fast' })).toThrow(key)
      expect(() => loadConfig({ WORLD_EXPORT: 'jangan', [key]: '1001' })).toThrow(key)
    }
  })

  const table: DropTable = {
    mob: 'MOB_T',
    gold: { chance: 1, amount: [10, 20] },
    groups: [
      { chance: 0.25, entries: [{ item: 'ITEM_A', weight: 1 }] },
      { chance: 0.8, entries: [{ item: 'ITEM_B', weight: 1 }] },
    ],
    provenance: 'authored',
  }
  const known = () => true

  it('rollDrops: GOLD_RATE multiplies the gold amount, DROP_RATE each group chance (at most 100 %)', () => {
    const at = (v: number) => () => v
    expect(rollDrops(table, at(0.4), known)).toEqual([{ code: 'ITEM_ETC_GOLD_01', count: 14, gold: true }, { code: 'ITEM_B', count: 1 }])
    expect(rollDrops(table, at(0.4), known, { gold: 3 })[0]).toEqual({ code: 'ITEM_ETC_GOLD_01', count: 42, gold: true })
    // 0.4 misses the 25 % group; DROP_RATE 2 makes it 50 %.
    expect(rollDrops(table, at(0.4), known, { drop: 2 }).map((d) => d.code)).toEqual(['ITEM_ETC_GOLD_01', 'ITEM_A', 'ITEM_B'])
    // 0.95 misses the 80 % group; at DROP_RATE 2 it is capped at 100 % and always drops.
    expect(rollDrops(table, at(0.95), known).map((d) => d.code)).toEqual(['ITEM_ETC_GOLD_01'])
    expect(rollDrops(table, at(0.95), known, { drop: 2 }).map((d) => d.code)).toEqual(['ITEM_ETC_GOLD_01', 'ITEM_B'])
    // GOLD_RATE 0 drops no gold at all.
    expect(rollDrops(table, at(0.4), known, { gold: 0 }).some((d) => d.gold)).toBe(false)
  })

  it('EXP_RATE and SP_RATE multiply the kill reward in mobDied; defaults leave it unchanged', () => {
    const now = Date.now()
    const plain = harness()
    const m1 = plain.gameplay.createMob(TOMB, 'normal', 1, 0, 0, null, now)
    m1.damage.set(plain.p.id, 50)
    plain.gameplay.mobDied(m1, now, true)
    expect(plain.p.progress).toMatchObject({ exp: 5, spExp: 100 })

    const rated = harness({ expRate: 3, spRate: 2 })
    const m2 = rated.gameplay.createMob(TOMB, 'normal', 1, 0, 0, null, now)
    m2.damage.set(rated.p.id, 50)
    rated.gameplay.mobDied(m2, now, true)
    expect(rated.p.progress).toMatchObject({ exp: 15, spExp: 200 })
    const gain = rated.inbox.find((m): m is Extract<ServerMessage, { t: 'statsDelta' }> => m.t === 'statsDelta' && m.gain !== undefined)
    expect(gain?.gain).toMatchObject({ exp: 15, spExp: 200, from: m2.id })
  })
})
