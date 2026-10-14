/**
 * Stats audit (2026-10-14 on the cap-25 build; docs/SYSTEMS_COMBAT.md §4.2a): STR/INT through the retail reinforce
 * percents, pure STR / pure INT / hybrid at the cap with a D4 weapon, a D4 armour set and D4 accessories, broken pieces
 * and set bonuses, equipping and unequipping, and a buff on and off — all on the server and in the `stats` message.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyClimbItemLevels, climbRow, climbStd, type ItemDef, type ServerMessage, type SkillDef } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { damageRoll, maxHpFor, maxMpFor, playerCombatStats, type CombatStats } from '../src/formulas.ts'
import { GameData } from '../src/gamedata.ts'
import { DUMMY, SAFE_TOWN, SKILL_ITEMS, skillHarness } from './skills-fixtures.ts'

const DATA = join(REPO_ROOT, 'work/out/data')
const HAVE = ['items.json', 'skills.json'].every((f) => existsSync(join(DATA, f)))
const rows = <T>(f: string): T[] => JSON.parse(readFileSync(join(DATA, f), 'utf8')).entries as T[]
const ITEMS: Map<string, ItemDef> = HAVE ? new Map(rows<ItemDef>('items.json').map((i) => [i.code, i])) : new Map()
if (HAVE) applyClimbItemLevels(ITEMS)
const SKILLS: Map<string, SkillDef> = HAVE ? new Map(rows<SkillDef>('skills.json').map((s) => [s.code, s])) : new Map()

const L = 25
const ARMOUR = (cls: string) => ['HA', 'SA', 'BA', 'LA', 'AA', 'FA'].map((s) => `ITEM_CH_M_${cls}_04_${s}_A`)
const ACCESSORIES = ['ITEM_CH_RING_04_A', 'ITEM_CH_RING_04_A', 'ITEM_CH_EARRING_04_A', 'ITEM_CH_EARRING_04_A', 'ITEM_CH_NECKLACE_04_A']
const BLADE = 'ITEM_CH_BLADE_04_A'
const wornOf = (codes: string[]) => codes.map((code) => ({ def: ITEMS.get(code)!, stack: { code, count: 1 } }))
/** The level-25 Earth Ghost (climb.ts roster), the cap's standard pack monster. */
const GHOST: CombatStats = (() => {
  const r = climbRow('MOB_CL_EARTHGHOST_25')!
  const hit = climbStd.hit(r.level)
  return { level: r.level, physAttack: [...r.physAttack], magAttack: [...r.magAttack], physDefence: r.physDefence, magDefence: r.magDefence, physAbsorb: r.level, magAbsorb: r.level, hitRate: hit, parryRate: hit, blockRate: 0, critRate: 0, balance: 1 }
})()
const mid = () => 0.5
// Level 25: base 44 / 44 (20 + 24) and 72 free points.
const BUILDS = { str: { str: 116, int: 44, cls: 'HEAVY' }, int: { str: 44, int: 116, cls: 'CLOTHES' }, hybrid: { str: 80, int: 80, cls: 'LIGHT' } } as const
const build = (b: keyof typeof BUILDS) => playerCombatStats(L, BUILDS[b].str, BUILDS[b].int, wornOf([BLADE, ...ARMOUR(BUILDS[b].cls), ...ACCESSORIES]))
const hit = (c: CombatStats, code: string) => {
  const s = SKILLS.get(code)!
  const magic = s.damage!.physPct === 0
  return damageRoll(c, GHOST, magic ? s.damage!.magPct : s.damage!.physPct, false, mid, magic, { flat: s.damage!.flat }) * s.damage!.hits
}
/** The top Cold nuke and the top Bicheon skill a level-25 character can learn (mastery 25). */
const NUKE = 'SKILL_CH_COLD_GIGONGTA_B_01'
const WEAPON_TOP = 'SKILL_CH_SWORD_KNOCKDOWN_A_04'
const m = (r?: [number, number]) => (r ? (r[0] + r[1]) / 2 : 0)

describe.skipIf(!HAVE)('STR / INT at the cap (D4 blade, D4 set, D4 accessories)', () => {
  it('the weapon and every armour piece add their stats and their STR/INT reinforce', () => {
    const blade = ITEMS.get(BLADE)!
    expect(blade.reinforcePct?.magAttackMin).toBeDefined()
    // The weapon's own attack plus INT × its reinforce (≈ 0.79–0.89 a point on a D4 blade), not the flat 0.2 a point.
    const bare = playerCombatStats(L, 44, 116, wornOf([BLADE]))
    expect(bare.magAttack[0]).toBe(Math.round(blade.stats!.magAttack![0] + (116 * m(blade.reinforcePct!.magAttackMin)) / 100))
    expect(bare.magAttack[1]).toBe(Math.round(blade.stats!.magAttack![1] + (116 * m(blade.reinforcePct!.magAttackMax)) / 100))
    expect(bare.physAttack[0]).toBe(Math.round(blade.stats!.physAttack![0] + (44 * m(blade.reinforcePct!.physAttackMin)) / 100))
    const chest = playerCombatStats(L, 44, 116, wornOf([BLADE, 'ITEM_CH_M_CLOTHES_04_BA_A']))
    const c = ITEMS.get('ITEM_CH_M_CLOTHES_04_BA_A')!
    expect(chest.magDefence - bare.magDefence).toBe(Math.round(m(c.stats!.magDefence) + (116 * m(c.reinforcePct!.magDefence)) / 100))
    expect(chest.physDefence - bare.physDefence).toBe(Math.round(m(c.stats!.physDefence) + (44 * m(c.reinforcePct!.physDefence)) / 100))
    expect(chest.parryRate).toBeGreaterThan(bare.parryRate)
    // a shield reinforces too
    const shield = ITEMS.get('ITEM_CH_SHIELD_04_A')!
    const sw = playerCombatStats(L, 116, 44, wornOf(['ITEM_CH_SHIELD_04_A']))
    const none = playerCombatStats(L, 116, 44, [])
    expect(sw.physDefence - none.physDefence).toBe(Math.round(m(shield.stats!.physDefence) + (116 * m(shield.reinforcePct!.physDefence)) / 100))
    // bare hands keep 0.2 a point and no defence from STR/INT at all
    expect(none.physAttack).toEqual([3 + Math.round(116 * 0.2), 5 + Math.round(116 * 0.2)])
    expect([none.physDefence, none.magDefence]).toEqual([0, 0])
    const acc = playerCombatStats(L, 44, 116, wornOf([BLADE, ...ACCESSORIES]))
    expect(acc.physAbsorb).toBeGreaterThan(20)
  })

  it('a broken piece gives no stats and no reinforce (its set count: climb-rewards.test.ts)', () => {
    const set = wornOf(ARMOUR('HEAVY'))
    const whole = playerCombatStats(L, 116, 44, set)
    const broken = set.map((w, i) => (i === 2 ? { ...w, stack: { ...w.stack, durability: 0 } } : w))
    const less = playerCombatStats(L, 116, 44, broken)
    const c = ITEMS.get(set[2]!.stack.code)!
    expect(whole.physDefence - less.physDefence).toBe(Math.round(m(c.stats!.physDefence) + (116 * m(c.reinforcePct!.physDefence)) / 100))
  })

  it('pure STR, pure INT and hybrid: the split of attack and defence follows STR / INT', () => {
    const [s, i, h] = [build('str'), build('int'), build('hybrid')]
    expect([maxHpFor(L, 116), maxMpFor(L, 116), maxHpFor(L, 44)]).toEqual([Math.floor(1.02 ** 24 * 116 * 10), Math.floor(1.02 ** 24 * 116 * 10), Math.floor(1.02 ** 24 * 44 * 10)])
    expect(s.physAttack[0]).toBeGreaterThan(h.physAttack[0])
    expect(h.physAttack[0]).toBeGreaterThan(i.physAttack[0])
    expect(i.magAttack[0]).toBeGreaterThan(h.magAttack[0])
    expect(h.magAttack[0]).toBeGreaterThan(s.magAttack[0])
    expect(s.physDefence).toBeGreaterThan(h.physDefence)
    expect(h.physDefence).toBeGreaterThan(i.physDefence)
    expect(i.magDefence).toBeGreaterThan(h.magDefence)
    expect(h.magDefence).toBeGreaterThan(s.magDefence)
    // STR now buys real attack: pure STR's phys attack is more than the old flat 0.2 a point gave
    expect(s.physAttack[0] - ITEMS.get(BLADE)!.stats!.physAttack![0]).toBeGreaterThan(116 * 0.5)
    expect(h.balance).toBeCloseTo(80 / 128, 5)
    expect(h.magBalance).toBeCloseTo(80 / 128, 5)
  })

  it('the top nuke follows mag attack × INT balance, the top weapon skill phys attack × STR balance', () => {
    const [s, i, h] = [build('str'), build('int'), build('hybrid')]
    const nuke = [hit(s, NUKE), hit(i, NUKE), hit(h, NUKE)]
    const blow = [hit(s, WEAPON_TOP), hit(i, WEAPON_TOP), hit(h, WEAPON_TOP)]
    expect(nuke[1]).toBeGreaterThan(nuke[2])
    expect(nuke[2]).toBeGreaterThan(nuke[0])
    expect(blow[0]).toBeGreaterThan(blow[2])
    expect(blow[2]).toBeGreaterThan(blow[1])
    // against the old flat 0.2 attack a point (a blade without reinforce data falls back to it), the pure builds hit harder
    const { reinforcePct: _, ...flatBlade } = ITEMS.get(BLADE)!
    const old = (b: keyof typeof BUILDS) =>
      playerCombatStats(L, BUILDS[b].str, BUILDS[b].int, [{ def: flatBlade, stack: { code: BLADE, count: 1 } }, ...wornOf([...ARMOUR(BUILDS[b].cls), ...ACCESSORIES])])
    expect(nuke[1]).toBeGreaterThan(hit(old('int'), NUKE))
    expect(blow[0]).toBeGreaterThan(hit(old('str'), WEAPON_TOP))
  })
})

// ---- the live server: equip / unequip and a buff, in p.combat and in the `stats` message ----------------------------

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})
type Stats = Extract<ServerMessage, { t: 'stats' }>['stats']
const lastStats = (inbox: ServerMessage[]) => (inbox.filter((m) => m.t === 'stats').at(-1) as Extract<ServerMessage, { t: 'stats' }>).stats

describe.skipIf(!HAVE)('server: worn items and buffs change the stats and the stat window', () => {
  const D4 = [BLADE, ...ARMOUR('CLOTHES'), 'ITEM_CH_RING_04_A'].map((c) => ({ ...ITEMS.get(c)!, reqLevel: 1 }))
  const boot = () => {
    const data = new GameData({ mobs: [DUMMY], items: [...SKILL_ITEMS.filter((i) => !D4.some((d) => d.code === i.code)), ...D4], levels: Array.from({ length: 25 }, (_, i) => ({ level: i + 1, exp: 1000, masterySp: 1 })), towns: [SAFE_TOWN] })
    const h = skillHarness({ data })
    cleanup = h.cleanup
    return h
  }

  it('unequipping the chest and the weapon lowers the stats, equipping them back restores them (server = stats)', () => {
    const h = boot()
    const { p, inbox } = h.hero({ level: 25, wear: D4.map((d) => d.code) })
    p.progress.int = 116
    h.gameplay.refresh(p)
    const full = h.gameplay.stats(p)
    const same = (s: Stats) => expect([s.physAttack, s.magAttack, s.physDefence, s.magDefence, s.parryRate]).toEqual([p.combat.physAttack, p.combat.magAttack, p.combat.physDefence, p.combat.magDefence, p.combat.parryRate])
    h.req(p, { t: 'itemUnequip', slot: 'chest' })
    const noChest = lastStats(inbox)
    same(noChest)
    expect(noChest.magDefence).toBeLessThan(full.magDefence)
    expect(noChest.physDefence).toBeLessThan(full.physDefence)
    expect(noChest.parryRate).toBeLessThan(full.parryRate)
    h.req(p, { t: 'itemUnequip', slot: 'weapon' })
    const bare = lastStats(inbox)
    same(bare)
    expect(bare.magAttack[0]).toBeLessThan(full.magAttack[0] - 150)
    const bag = (code: string) => h.store.loadInventory(p.characterId).bag.findIndex((it) => it?.code === code)
    h.req(p, { t: 'itemEquip', bag: bag(BLADE) })
    h.req(p, { t: 'itemEquip', bag: bag('ITEM_CH_M_CLOTHES_04_BA_A') })
    const back = lastStats(inbox)
    same(back)
    expect([back.physAttack, back.magAttack, back.physDefence, back.magDefence, back.parryRate]).toEqual([full.physAttack, full.magAttack, full.physDefence, full.magDefence, full.parryRate])
  })

  it('a defence buff raises the stats while on and they return when it runs out', () => {
    const h = boot()
    const { p, inbox } = h.hero({ level: 10 })
    h.learn(p, ['SKILL_CH_COLD_GANGGI_A_01'])
    const pd = p.combat.physDefence
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_COLD_GANGGI_A_01' })
    h.runTo(h.now + 2100)
    expect(p.combat.physDefence).toBe(Math.round(pd * 1.1))
    expect(lastStats(inbox).physDefence).toBe(p.combat.physDefence)
    h.runTo(h.now + 300_000)
    expect(inbox.some((m) => m.t === 'effectRemove' && m.reason === 'expired')).toBe(true)
    expect(p.combat.physDefence).toBe(pd)
    expect(lastStats(inbox).physDefence).toBe(pd)
  })
})
