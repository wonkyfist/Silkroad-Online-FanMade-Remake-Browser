/**
 * Durability wear and broken items (docs/SYSTEMS_COMBAT.md §3.2; lane DR): the weapon wears on landed hits dealt, armour
 * on landed hits taken, the shield on blocks; misses, zero-damage hits and DoT ticks cost nothing; never below 0; one
 * write per call that lost points; the warning and broken lines; at 0 the weapon's stats are gone, `attack` and weapon
 * skills are refused with `broken` while force skills still work, a running auto-attack stops at its next swing, and a
 * broken item cannot be equipped. Plus the GM `dur` command. Synthetic skills world (skills-fixtures.ts).
 */
import type { ItemDef, ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerConfig } from '../src/config.ts'
import { BROKEN_WEAPON_TEXT, curDurability, maxDurability, warnAt } from '../src/durability.ts'
import { GameData } from '../src/gamedata.ts'
import type { Player } from '../src/world.ts'
import { DUMMY, SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const SWORD = 'ITEM_CH_SWORD_01_A_DEF'
const SHIELD = 'ITEM_CH_SHIELD_01_A'
const CHEST = 'ITEM_CH_M_CLOTHES_01_BA_A_DEF'
const LEGS = 'ITEM_CH_M_CLOTHES_01_LA_A_DEF'
const RING = 'ITEM_CH_RING_01_A'

/** The skill fixtures' items with Copper-Sword-like rolls on everything worn but accessories. */
const DUR_ITEMS: ItemDef[] = SKILL_ITEMS.map((i) =>
  i.category === 'weapon' || i.category === 'shield' || i.category === 'armor'
    ? { ...i, canRepair: true, repairCost: 198, stats: { ...i.stats, durability: [62, 76] } }
    : i,
)

type H = ReturnType<typeof skillHarness>
const harnesses: H[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup()
  vi.restoreAllMocks()
})
function setup(knobs: Partial<ServerConfig> = {}) {
  const h = skillHarness({ data: new GameData({ mobs: [DUMMY], items: DUR_ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN] }) })
  Object.assign(h.config, knobs)
  harnesses.push(h)
  return h
}

const ALL_LOSS = { durWeaponLossPct: 100, durArmorLossPct: 100, durShieldLossPct: 100 }
const NO_LOSS = { durWeaponLossPct: 0, durArmorLossPct: 0, durShieldLossPct: 0 }

const dur = (h: H, p: Player, slot: 'weapon' | 'shield' | 'chest' | 'legs') => h.store.loadInventory(p.characterId).equip[slot]?.durability
const lines = (inbox: ServerMessage[]) => inbox.flatMap((m) => (m.t === 'chat' && m.channel === 'system' ? [m.text] : []))
const hit = (damage = 5) => ({ outcome: 'hit' as const, damage, hp: 0 })

describe('durability helpers', () => {
  it('max is the top of the roll; absent = full; the warning line at 10 %', () => {
    const sword = DUR_ITEMS.find((i) => i.code === SWORD)!
    expect(maxDurability(sword)).toBe(76)
    expect(maxDurability(DUR_ITEMS.find((i) => i.code === RING))).toBeNull()
    expect(curDurability({}, 76)).toBe(76)
    expect(curDurability({ durability: null }, 76)).toBe(76)
    expect(curDurability({ durability: -3 }, 76)).toBe(0)
    expect(warnAt(76, 10)).toBeCloseTo(7.6)
  })
})

describe('wear (Durability.afterHits)', () => {
  it('at 100 % the weapon loses 1 per landed hit, several hits in one write, never below 0; a miss costs nothing', () => {
    const h = setup(ALL_LOSS)
    const m = h.dummy(3, 0)
    const { p, inbox } = h.hero()
    const tx = vi.spyOn(h.store, 'inventoryTx')
    h.gameplay.dealHits(p, m, [hit()], {}, h.now)
    expect(dur(h, p, 'weapon')).toBe(75)
    h.gameplay.dealHits(p, m, [hit(), { outcome: 'crit', damage: 9, hp: 0 }, { outcome: 'miss', damage: 0, hp: 0 }], {}, h.now)
    expect(dur(h, p, 'weapon')).toBe(73)
    expect(tx).toHaveBeenCalledTimes(2)
    const up = inbox.filter((x) => x.t === 'inventoryUpdate').at(-1)
    expect(up).toEqual({ t: 'inventoryUpdate', equip: [{ slot: 'weapon', item: { code: SWORD, count: 1, durability: 73 } }] })
    h.gameplay.dealHits(p, m, [{ outcome: 'miss', damage: 0, hp: 0 }], {}, h.now)
    expect(dur(h, p, 'weapon')).toBe(73)
    expect(tx).toHaveBeenCalledTimes(2)
    // Down to 0 and no further.
    h.gameplay.durability.gm(p, ['weapon', '1'])
    h.gameplay.dealHits(p, m, [hit(), hit(), hit()], {}, h.now)
    expect(dur(h, p, 'weapon')).toBe(0)
    h.gameplay.dealHits(p, m, [hit()], {}, h.now)
    expect(dur(h, p, 'weapon')).toBe(0)
  })

  it('at 0 % nothing is ever written (no DB traffic per hit)', () => {
    const h = setup(NO_LOSS)
    const m = h.dummy(3, 0)
    const { p } = h.hero({ wear: [SHIELD] })
    const tx = vi.spyOn(h.store, 'inventoryTx')
    for (let i = 0; i < 200; i++) {
      h.gameplay.dealHits(p, m, [hit()], {}, h.now)
      h.gameplay.dealHits(m, p, [hit(1), { outcome: 'block', damage: 0, hp: 0 }], {}, h.now)
      p.hp = p.maxHp
    }
    expect(tx).not.toHaveBeenCalled()
    expect(dur(h, p, 'weapon')).toBeNull()
  })

  it('the default 5 % costs about one point in twenty landed hits', () => {
    const h = setup()
    let seed = 42
    ;(h.gameplay as { rng: () => number }).rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const m = h.dummy(3, 0)
    const { p } = h.hero()
    h.gameplay.durability.gm(p, ['weapon', '76'])
    for (let i = 0; i < 400; i++) h.gameplay.dealHits(p, m, [hit()], {}, h.now)
    const lost = 76 - (dur(h, p, 'weapon') ?? 76)
    expect(lost).toBeGreaterThan(8)
    expect(lost).toBeLessThan(35)
  })

  it('armour wears on landed damaging hits taken; a zero-damage hit and a DoT tick wear nothing; a block wears the shield', () => {
    const h = setup(ALL_LOSS)
    const m = h.dummy(3, 0)
    const { p } = h.hero({ wear: [SHIELD] })
    const armour = () => (['chest', 'legs'] as const).map((s) => dur(h, p, s) ?? 76).reduce((a, b) => a + b, 0)
    const start = armour()
    h.gameplay.dealHits(m, p, [hit(3)], { dot: true }, h.now)
    expect(armour()).toBe(start)
    h.gameplay.dealHits(m, p, [hit(0)], {}, h.now)
    expect(armour()).toBe(start)
    h.gameplay.dealHits(m, p, [hit(3), hit(3)], {}, h.now)
    expect(armour()).toBe(start - 2)
    expect(dur(h, p, 'shield')).toBeNull()
    h.gameplay.dealHits(m, p, [{ outcome: 'block', damage: 0, hp: 0 }], {}, h.now)
    expect(dur(h, p, 'shield')).toBe(75)
    // A mob's hits never wear the player's weapon, and a player's weapon does not wear on a DoT tick it dealt.
    expect(dur(h, p, 'weapon')).toBeNull()
    h.gameplay.dealHits(p, m, [hit()], { dot: true }, h.now)
    expect(dur(h, p, 'weapon')).toBeNull()
  })

  it('warns once at 10 % ("almost broken"), then at 0 sends stats and "is broken"', () => {
    const h = setup(ALL_LOSS)
    const m = h.dummy(3, 0)
    const { p, inbox } = h.hero()
    const name = h.data.item(SWORD)!.name
    h.gameplay.durability.gm(p, ['weapon', '9'])
    h.gameplay.dealHits(p, m, [hit()], {}, h.now) // 8: above 7.6
    expect(lines(inbox).filter((l) => l.includes('almost'))).toEqual([])
    h.gameplay.dealHits(p, m, [hit()], {}, h.now) // 7: crosses
    h.gameplay.dealHits(p, m, [hit()], {}, h.now) // 6: no repeat
    expect(lines(inbox).filter((l) => l.includes('almost'))).toEqual([`Your ${name} is almost broken.`])
    const attack = p.combat.physAttack[1]
    const from = inbox.length
    h.gameplay.durability.gm(p, ['weapon', '1'])
    const from2 = inbox.length
    h.gameplay.dealHits(p, m, [hit()], {}, h.now)
    expect(inbox.slice(from2).map((x) => x.t)).toEqual(['combat', 'inventoryUpdate', 'stats', 'chat'])
    expect(lines(inbox.slice(from))).toContain(`Your ${name} is broken.`)
    expect(p.combat.physAttack[1]).toBeLessThan(attack)
    const stats = inbox.filter((x): x is Extract<ServerMessage, { t: 'stats' }> => x.t === 'stats').at(-1)!
    expect(stats.stats.physAttack[1]).toBe(p.combat.physAttack[1])
  })
})

describe('a broken weapon (Durability.refuse)', () => {
  it('attack → broken; a weapon skill → broken; a force skill still works', () => {
    const h = setup(NO_LOSS)
    const m = h.dummy(3, 0)
    const { p, inbox } = h.hero({ level: 10, sp: 100 })
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01', 'SKILL_CH_WATER_HEAL_A_01'])
    expect(h.gameplay.durability.gm(p, ['weapon', '0'])).toMatchObject({ ok: true })
    h.req(p, { t: 'attack', target: m.id })
    expect(h.result(inbox, 'attack')).toMatchObject({ ok: false, reason: 'broken', message: BROKEN_WEAPON_TEXT })
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'broken' })
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_WATER_HEAL_A_01', target: p.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    // Repaired (GM): attacking works again.
    h.gameplay.durability.gm(p, ['weapon', '76'])
    h.req(p, { t: 'attack', target: m.id })
    expect(h.result(inbox, 'attack')).toMatchObject({ ok: true })
  })

  it('an auto-attack already running stops at its next swing with the system line', () => {
    const h = setup(NO_LOSS)
    const m = h.dummy(1.5, 0)
    const { p, inbox } = h.hero()
    h.req(p, { t: 'attack', target: m.id })
    expect(h.result(inbox, 'attack')).toMatchObject({ ok: true })
    h.runTo(h.now + 3000)
    const swings = inbox.filter((x) => x.t === 'combat' && x.attacker === p.id).length
    expect(swings).toBeGreaterThan(0)
    h.gameplay.durability.gm(p, ['weapon', '0'])
    h.runTo(h.now + 5000)
    expect(p.action).toBeNull()
    expect(inbox.filter((x) => x.t === 'combat' && x.attacker === p.id).length).toBe(swings)
    expect(lines(inbox)).toContain(BROKEN_WEAPON_TEXT)
  })

  it('equipping a broken item → broken; unequipping is always allowed', () => {
    const h = setup()
    const { p, inbox } = h.hero()
    h.store.inventoryTx(p.characterId, (d) => {
      d.setBag(3, { code: SHIELD, count: 1, plus: 0, durability: 0 })
      return { ok: true, value: undefined }
    })
    h.req(p, { t: 'itemEquip', bag: 3, slot: 'shield' })
    expect(h.result(inbox, 'itemEquip')).toMatchObject({ ok: false, reason: 'broken' })
    h.gameplay.durability.gm(p, ['weapon', '0'])
    h.req(p, { t: 'itemUnequip', slot: 'weapon' })
    expect(h.result(inbox, 'itemUnequip')).toMatchObject({ ok: true })
  })
})

describe('GM dur', () => {
  it('sets one slot or all worn items; the max or more means full; bad input is refused', () => {
    const h = setup()
    const { p, inbox } = h.hero({ wear: [SHIELD, RING] })
    expect(h.gameplay.durability.gm(p, ['weapon', '5'])).toMatchObject({ ok: true })
    expect(dur(h, p, 'weapon')).toBe(5)
    expect(inbox.filter((x) => x.t === 'inventoryUpdate').at(-1)).toMatchObject({ equip: [{ slot: 'weapon', item: { durability: 5 } }] })
    expect(h.gameplay.durability.gm(p, ['all', '0'])).toMatchObject({ ok: true })
    expect(dur(h, p, 'weapon')).toBe(0)
    expect(dur(h, p, 'shield')).toBe(0)
    expect(dur(h, p, 'chest')).toBe(0)
    expect(h.store.loadInventory(p.characterId).equip.ring1?.durability).toBeNull()
    expect(h.gameplay.durability.gm(p, ['all', '999'])).toMatchObject({ ok: true })
    expect(dur(h, p, 'weapon')).toBeNull()
    expect(h.gameplay.durability.gm(p, ['ring1', '3'])).toMatchObject({ ok: false })
    expect(h.gameplay.durability.gm(p, ['elbow', '3'])).toMatchObject({ ok: false })
    expect(h.gameplay.durability.gm(p, ['weapon', '-1'])).toMatchObject({ ok: false })
    expect(h.gameplay.durability.gm(p, ['weapon'])).toMatchObject({ ok: false })
  })
})
