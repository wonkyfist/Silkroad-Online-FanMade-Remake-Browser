/**
 * Arrows and weapon rules (docs/SKILLS.md §1.4): bows shoot arrows worn in the shield slot (1 per basic shot, per the
 * row's `cnsm` for skills), refuse without them, refill from the bag; two-handed weapons and shields; the one-time
 * grant to bow characters made before arrows counted; the knockback push.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { STARTER_ARROWS, STARTER_ARROW_CODE, type ItemDef, type ServerMessage } from '@sro/shared'
import { GameData } from '../src/gamedata.ts'
import { InvDraft, equipItem, newItem, takeArrows, type InvState } from '../src/inventory.ts'
import { KNOCKBACK_M } from '../src/skills/engine.ts'
import { SkillBook } from '../src/skills/book.ts'
import type { Player } from '../src/world.ts'
import { item } from './fixtures.ts'
import { DUMMY, MASTERIES, SAFE_TOWN, SKILLS, SKILL_ITEMS, SKILL_LEVELS, skill, skillHarness } from './skills-fixtures.ts'

const ARROW = 'ITEM_ETC_AMMO_ARROW_01'
const STARTER = item(STARTER_ARROW_CODE, { category: 'ammo', typeId: [3, 3, 4, 1], maxStack: 250, price: 1, sellPrice: 0, canTrade: false, canDrop: false })
const ITEMS: ItemDef[] = [...SKILL_ITEMS, STARTER]
const BOW_SKILL = 'SKILL_CH_BOW_CRITICAL_A_01'
const KB = skill('SKILL_CH_SPEAR_KB_TEST_01', {
  kind: 'attack',
  mastery: 'HEUKSAL',
  masteryLevel: 1,
  mp: 10,
  castMs: 300,
  actionMs: 500,
  cooldownMs: 5000,
  weapons: ['spear', 'glaive'],
  damage: { physPct: 100, magPct: 0, flat: [1, 1], hits: 1 },
  targets: { required: true, groups: ['enemy_mob', 'enemy_player'] },
  statuses: [{ status: 'knockback', level: 35, chancePct: 100 }],
})

let h: ReturnType<typeof skillHarness>
afterEach(() => h?.cleanup())

function setup(o: { ammo?: boolean; starter?: boolean } = {}) {
  const data = new GameData({ mobs: [DUMMY], items: o.starter ? ITEMS : SKILL_ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN] })
  h = skillHarness({ skillAmmo: o.ammo === false ? 0 : 1, data, book: new SkillBook([...SKILLS, KB], MASTERIES) })
  return h
}

/** Puts `worn` arrows in the shield slot and `bag` more in the bag (0 = none), then tells the player. */
function arm(p: Player, worn: number, bag = 0) {
  const { draft } = h.store.inventoryTx(p.characterId, (d) => {
    d.setEquip('shield', worn > 0 ? newItem(ARROW, worn) : null)
    if (bag > 0) d.setBag(d.firstFree(), newItem(ARROW, bag))
    return { ok: true, value: null }
  })
  h.gameplay.afterInventory(p, draft)
}

const worn = (p: Player) => h.store.loadInventory(p.characterId).equip.shield?.count ?? 0
const bagArrows = (p: Player) => h.store.loadInventory(p.characterId).bag.reduce((n, it) => n + (it?.code === ARROW ? it.count : 0), 0)
const shots = (inbox: ServerMessage[], p: Player) => inbox.filter((m) => m.t === 'combat' && m.attacker === p.id).length

describe('arrows', () => {
  it('each bow basic shot takes one worn arrow; the slot count goes to the client', () => {
    setup()
    const { p, inbox } = h.hero({ weapon: 'bow', level: 10 })
    arm(p, 20)
    const m = h.dummy(0, 5)
    h.req(p, { t: 'attack', target: m.id })
    h.runTo(h.now + 3000)
    const n = shots(inbox, p)
    expect(n).toBeGreaterThan(1)
    expect(worn(p)).toBe(20 - n)
    expect(p.equip.shield?.count).toBe(20 - n)
    expect(inbox.some((x) => x.t === 'inventoryUpdate' && x.equip?.some((e) => e.slot === 'shield' && e.item?.count === 20 - n))).toBe(true)
  })

  it('a bow skill takes its row arrows (cnsm: 1 per cast)', () => {
    setup()
    const { p, inbox } = h.hero({ weapon: 'bow', level: 10 })
    h.learn(p, [BOW_SKILL])
    arm(p, 10)
    const m = h.dummy(0, 5)
    h.req(p, { t: 'useSkill', skill: BOW_SKILL, target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    h.runTo(h.now + 1500)
    const n = shots(inbox, p)
    expect(n).toBeGreaterThanOrEqual(1)
    expect(worn(p)).toBe(10 - n)
  })

  it('no arrows: the attack and the bow skill are refused ("No arrows equipped")', () => {
    setup()
    const { p, inbox } = h.hero({ weapon: 'bow', level: 10 })
    h.learn(p, [BOW_SKILL])
    const m = h.dummy(0, 5)
    h.req(p, { t: 'attack', target: m.id })
    expect(h.result(inbox, 'attack')).toMatchObject({ ok: false, reason: 'no_ammo', message: 'No arrows equipped.' })
    h.req(p, { t: 'useSkill', skill: BOW_SKILL, target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'no_ammo' })
    h.runTo(h.now + 1500)
    expect(shots(inbox, p)).toBe(0)
  })

  it('the last worn arrow refills the slot from a bag stack; a run-out stops the attack with the line', () => {
    setup()
    const { p, inbox } = h.hero({ weapon: 'bow', level: 10 })
    arm(p, 1, 2)
    const m = h.dummy(0, 5)
    h.req(p, { t: 'attack', target: m.id })
    h.runTo(h.now + 1000)
    // the first shot emptied the slot: the bag stack moved in
    expect(bagArrows(p)).toBe(0)
    expect(worn(p)).toBe(3 - shots(inbox, p))
    h.runTo(h.now + 5000)
    expect(shots(inbox, p)).toBe(3)
    expect(worn(p)).toBe(0)
    expect(p.action).toBeNull()
    expect(h.all(inbox, 'chat').some((c) => c.text === 'No arrows equipped.')).toBe(true)
  })

  it('with SKILL_AMMO=0 bows shoot without arrows', () => {
    setup({ ammo: false })
    const { p, inbox } = h.hero({ weapon: 'bow', level: 10 })
    const m = h.dummy(0, 5)
    h.req(p, { t: 'attack', target: m.id })
    h.runTo(h.now + 2000)
    expect(shots(inbox, p)).toBeGreaterThan(0)
  })

  it('a new bow character starts with a stack of starter arrows in the left hand', () => {
    setup({ starter: true })
    const { p } = h.hero({ weapon: 'bow' })
    expect(p.equip.shield).toMatchObject({ code: STARTER_ARROW_CODE, count: STARTER_ARROWS })
    const { p: s } = h.hero({ weapon: 'sword' })
    expect(s.equip.shield?.code).not.toBe(STARTER_ARROW_CODE)
  })

  it('a bow character made before arrows counted gets one stack, once', () => {
    setup({ starter: true })
    const { id } = h.hero({ weapon: 'bow' })
    const { id: sw } = h.hero({ weapon: 'sword' })
    // new rows are marked; migration 30 sets every older row to 0
    expect(h.store.arrowsGranted(id)).toBe(true)
    expect(h.gameplay.grantArrowsOnce(id)).toBe(false)
    h.store.db.prepare('UPDATE characters SET arrows_granted = 0').run()
    h.store.inventoryTx(id, (d) => {
      d.setEquip('shield', null)
      return { ok: true, value: null }
    })
    expect(h.gameplay.grantArrowsOnce(id)).toBe(true)
    expect(h.store.loadInventory(id).equip.shield).toMatchObject({ code: STARTER_ARROW_CODE, count: STARTER_ARROWS })
    expect(h.gameplay.grantArrowsOnce(id)).toBe(false)
    expect(h.store.loadInventory(id).equip.shield?.count).toBe(STARTER_ARROWS)
    expect(h.store.loadInventory(id).bag.some((it) => it?.code === STARTER_ARROW_CODE)).toBe(false)
    // a sword character is marked without arrows
    expect(h.gameplay.grantArrowsOnce(sw)).toBe(false)
    expect(h.store.arrowsGranted(sw)).toBe(true)
  })
})

describe('weapon rules (inventory.ts equipItem)', () => {
  const defs = (code: string) => ITEMS.find((i) => i.code === code)
  const who = { level: 10, gender: 'male' as const }
  const draft = (equip: InvState['equip'], bag: (string | [string, number] | null)[]) =>
    new InvDraft({ bagSize: 8, bag: Array.from({ length: 8 }, (_, i) => { const b = bag[i]; return b ? (typeof b === 'string' ? newItem(b, 1) : newItem(b[0], b[1])) : null }), equip, gold: 0 })
  const BOW = 'ITEM_CH_BOW_01_A_DEF'
  const SWORD = 'ITEM_CH_SWORD_01_A_DEF'
  const SPEAR = 'ITEM_CH_SPEAR_01_A_DEF'
  const SHIELD = 'ITEM_CH_SHIELD_01_A'

  it('a shield is refused with a two-handed weapon; a sword or blade takes one', () => {
    for (const w of [BOW, SPEAR, 'ITEM_CH_TBLADE_01_A_DEF']) {
      const d = draft({ weapon: newItem(w, 1) }, [SHIELD])
      expect(equipItem(d, 0, undefined, who, defs)).toMatchObject({ ok: false, reason: 'requirements' })
    }
    for (const w of [SWORD, 'ITEM_CH_BLADE_01_A_DEF']) {
      const d = draft({ weapon: newItem(w, 1) }, [SHIELD])
      expect(equipItem(d, 0, undefined, who, defs)).toMatchObject({ ok: true, value: 'shield' })
    }
  })

  it('a two-handed weapon sends the worn shield to the bag', () => {
    const d = draft({ weapon: newItem(SWORD, 1), shield: newItem(SHIELD, 1) }, [SPEAR])
    expect(equipItem(d, 0, undefined, who, defs)).toMatchObject({ ok: true })
    expect(d.equip.weapon?.code).toBe(SPEAR)
    expect(d.equip.shield).toBeUndefined()
    expect(d.bag.filter(Boolean).map((i) => i!.code).sort()).toEqual([SHIELD, SWORD].sort())
  })

  it('arrows go in the shield slot with a bow only, stack there, and leave with another weapon', () => {
    expect(equipItem(draft({ weapon: newItem(SWORD, 1) }, [[ARROW, 10]]), 0, undefined, who, defs)).toMatchObject({ ok: false, message: 'Arrows need a bow.' })
    const d = draft({ weapon: newItem(BOW, 1), shield: newItem(ARROW, 245) }, [[ARROW, 10]])
    expect(equipItem(d, 0, undefined, who, defs)).toMatchObject({ ok: true, value: 'shield' })
    expect(d.equip.shield?.count).toBe(250)
    expect(d.bag[0]?.count).toBe(5)
    // a sword sends the arrows to the bag
    const s = draft({ weapon: newItem(BOW, 1), shield: newItem(ARROW, 50) }, [SWORD])
    expect(equipItem(s, 0, undefined, who, defs)).toMatchObject({ ok: true })
    expect(s.equip.shield).toBeUndefined()
    expect(s.bag.some((i) => i?.code === ARROW && i.count === 50)).toBe(true)
  })

  it('a bow loads arrows from the bag; takeArrows refuses an empty hand', () => {
    const d = draft({ weapon: newItem(SWORD, 1) }, [BOW, null, [ARROW, 30]])
    expect(equipItem(d, 0, undefined, who, defs)).toMatchObject({ ok: true })
    expect(d.equip.shield).toMatchObject({ code: ARROW, count: 30 })
    expect(takeArrows(draft({ weapon: newItem(BOW, 1) }, []), 1, defs)).toMatchObject({ ok: false, reason: 'no_ammo' })
  })
})

describe('knockback', () => {
  const spear = () => {
    const { p, inbox } = h.hero({ weapon: 'spear', level: 10, pos: [490, 0, 0] })
    h.gameplay.skills.gmSet(p, Object.fromEntries(MASTERIES.map((m) => [m.code, 10])), [[KB.group!, 1]], h.now)
    return { p, inbox }
  }

  it('Ghost Spear - Prince pushes the target back KNOCKBACK_M and tells the viewers (displace push)', () => {
    setup()
    const { p, inbox } = spear()
    const m = h.dummy(492, 0)
    h.req(p, { t: 'useSkill', skill: KB.code, target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    // read before the knockback hold (1 s) ends: the test dummy cannot walk and warps home after it
    h.runTo(h.now + 700)
    const push = inbox.find((x) => x.t === 'displace' && x.id === m.id)
    expect(push).toMatchObject({ kind: 'push' })
    const at = h.world.positionAt(m, h.now)
    expect(at[0]).toBeCloseTo(492 + KNOCKBACK_M, 1)
  })

  it('the push is clamped (world edge / navmesh)', () => {
    setup()
    const { p, inbox } = spear()
    // the bounds end at x = 500: a target at 498.5 can only go 1.5 m
    const m = h.dummy(498.5, 0)
    p.pos = [496.5, 0, 0]
    h.req(p, { t: 'useSkill', skill: KB.code, target: m.id })
    // read before the knockback hold (1 s) ends: the test dummy cannot walk and warps home after it
    h.runTo(h.now + 700)
    const at = h.world.positionAt(m, h.now)
    expect(at[0]).toBeLessThanOrEqual(500)
    expect(at[0]).toBeGreaterThan(498.5)
    expect(at[0] - 498.5).toBeLessThan(KNOCKBACK_M)
  })
})
