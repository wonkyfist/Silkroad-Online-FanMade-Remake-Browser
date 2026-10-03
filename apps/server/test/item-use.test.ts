/**
 * Consumables (docs/SHOPS.md §4, §9 lane C; docs/WAVE_PLAN.md §4.5 and decision 9): potions and grains with per-group
 * cooldowns and itemCooldown, pills (kept until there is something to cure), and the return-scroll cast with its
 * interrupt rules. A synthetic world with a controlled clock (npc-harness.ts).
 */
import type { ServerMessage } from '@sro/shared'
import { parseServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMANDS } from '../src/gm.ts'
import type { GameContext } from '../src/game.ts'
import { MANGNYANG, TIGER } from './fixtures.ts'
import { HP_GRAIN, MP_POTION, PILL, RETURN_01, RETURN_03, RETURN_NOW, npcHarness, type NpcHarness } from './npc-harness.ts'

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})
function setup() {
  const h = npcHarness()
  harnesses.push(h)
  return h
}

const HP = 'ITEM_ETC_HP_POTION_01'
/** Far from town (0,0,0) and from every NPC. */
const FIELD: [number, number, number] = [200, 0, 200]
const types = (inbox: ServerMessage[], from = 0) => inbox.slice(from).map((m) => m.t)
const warped = (h: NpcHarness, inbox: ServerMessage[], id: number) => h.of(inbox, 'warp').filter((m) => m.id === id)

describe('potions', () => {
  it('an HP herb heals min(amount, missing), arms hp for 1000 ms: ok -> inventoryUpdate -> itemCooldown -> statsDelta', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const slot = h.give(p, HP, 3)
    p.hp = p.maxHp - 30
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'inventoryUpdate', 'itemCooldown', 'statsDelta', 'entityUpdate', 'itemEffect'])
    expect(h.of(inbox, 'itemCooldown')[0]).toEqual({ t: 'itemCooldown', group: 'hp', readyInMs: 1000, totalMs: 1000 })
    expect(p.hp).toBe(p.maxHp)
    expect(h.countOf(p, HP)).toBe(2)
    p.hp = 10
    h.advance(999)
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(h.countOf(p, HP)).toBe(2)
    h.advance(1)
    p.hp = 10 // (regeneration ran meanwhile)
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    expect(p.hp).toBe(110)
  })

  it('an MP potion is on its own group: usable in the same instant as an HP potion', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const hp = h.give(p, HP, 2)
    const mp = h.give(p, MP_POTION.code, 2)
    p.hp = 1
    p.mp = 1
    expect(h.req(p, inbox, { t: 'itemUse', bag: hp })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'itemUse', bag: mp })).toMatchObject({ ok: true })
    expect(p.mp).toBe(101)
    expect(h.of(inbox, 'itemCooldown').map((m) => m.group)).toEqual(['hp', 'mp'])
  })

  it('a grain heals 25 % of max HP and shares the hp group', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const grain = h.give(p, HP_GRAIN.code, 2)
    p.hp = 1
    expect(h.req(p, inbox, { t: 'itemUse', bag: grain })).toMatchObject({ ok: true })
    expect(p.hp).toBeCloseTo(1 + p.maxHp * 0.25)
    expect(h.req(p, inbox, { t: 'itemUse', bag: h.give(p, HP, 1) })).toMatchObject({ ok: false, reason: 'cooldown' })
  })

  it('works in combat and in town; not while dead; not from an empty or out-of-range slot; not for non-consumables', () => {
    const h = setup()
    const { p, inbox } = h.enter([1, 0, 1])
    const slot = h.give(p, HP, 5)
    p.lastCombatAt = h.now()
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'itemUse', bag: 47 })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(p, inbox, { t: 'itemUse', bag: 9999 })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(p, inbox, { t: 'itemUse', bag: h.give(p, 'ITEM_CH_BLADE_02_A') })).toMatchObject({ ok: false, reason: 'not_usable' })
    h.gameplay.gmKill(p, h.now())
    h.advance(2000)
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: false, reason: 'dead' })
    expect(h.countOf(p, HP)).toBe(4)
  })

  it('a pill answers not_usable while there is nothing to cure, and is kept', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const slot = h.give(p, PILL.code, 3)
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: false, reason: 'not_usable', message: 'nothing to cure' })
    expect(h.countOf(p, PILL.code)).toBe(3)
    expect(h.of(inbox, 'itemCooldown')).toHaveLength(0)
  })

  it('a pill cures through the skills engine when it has abnormal states, then arms cure', () => {
    const h = setup()
    const cured: number[] = []
    const skills = h.gameplay.skills as unknown as Record<string, unknown>
    skills.curable = (_p: unknown, level: number) => level >= 36
    skills.cure = (_p: unknown, level: number) => void cured.push(level)
    const { p, inbox } = h.enter(FIELD)
    const slot = h.give(p, PILL.code, 3)
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    expect(cured).toEqual([36])
    expect(h.countOf(p, PILL.code)).toBe(2)
    expect(h.of(inbox, 'itemCooldown').at(-1)).toMatchObject({ group: 'cure', readyInMs: 1000 })
  })
})

describe('return scrolls', () => {
  it('casts 30 s (viewers see it), takes one scroll at the end, then itemCastEnd done before the warp to town', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const viewer = h.enter([FIELD[0] + 5, 0, FIELD[2]])
    const slot = h.give(p, RETURN_01.code, 2)
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'itemCast'])
    expect(h.of(inbox, 'itemCast')[0]).toEqual({ t: 'itemCast', id: p.id, item: RETURN_01.code, castMs: 30_000 })
    expect(h.of(viewer.inbox, 'itemCast')).toEqual([{ t: 'itemCast', id: p.id, item: RETURN_01.code, castMs: 30_000 }])
    expect(h.gameplay.itemUses.casting(p)).toMatchObject({ item: RETURN_01.code })
    h.advance(29_900)
    expect(warped(h, inbox, p.id)).toHaveLength(0)
    expect(h.countOf(p, RETURN_01.code)).toBe(2)
    const end = inbox.length
    h.advance(100)
    expect(types(inbox, end).filter((t) => ['inventoryUpdate', 'itemCastEnd', 'warp'].includes(t))).toEqual(['inventoryUpdate', 'itemCastEnd', 'warp'])
    expect(h.of(inbox, 'itemCastEnd')).toEqual([{ t: 'itemCastEnd', id: p.id, item: RETURN_01.code, reason: 'done' }])
    expect(h.countOf(p, RETURN_01.code)).toBe(1)
    expect(p.pos[0]).toBe(0)
    expect(p.pos[2]).toBe(0)
    expect(h.gameplay.itemUses.casting(p)).toBeNull()
    expect(h.of(viewer.inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'done' })
  })

  it('used while walking or auto-attacking: the player stops first (after the actionResult), then the cast runs', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const slot = h.give(p, RETURN_03.code, 1)
    h.gameplay.onMoveTo(p, h.now())
    h.world.moveTo(p, FIELD[0] + 30, FIELD[2], h.now())
    h.advance(200)
    p.action = { kind: 'attack', target: 999, chaseAt: 0, chaseTo: null }
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'stop', 'itemCast'])
    expect(p.move).toBeNull()
    expect(p.action).toBeNull()
    h.advance(5000)
    expect(h.of(inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'done' })
  })

  it('works in combat (the old refusal is gone), and a mob hit does not interrupt it', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const slot = h.give(p, RETURN_03.code, 1)
    const mob = h.gameplay.createMob(MANGNYANG, 'normal', FIELD[0] + 1, FIELD[2], 0, null, h.now())
    p.lastCombatAt = h.now()
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    h.advance(1000)
    h.gameplay.attack(mob, p, h.now())
    expect(h.of(inbox, 'combat').some((m) => m.target === p.id)).toBe(true)
    h.advance(4000)
    expect(h.of(inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'done' })
    expect(warped(h, inbox, p.id)).toHaveLength(1)
    expect(h.countOf(p, RETURN_03.code)).toBe(0)
  })

  it('moving at 10 s interrupts it: no scroll taken, no warp', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const slot = h.give(p, RETURN_01.code, 1)
    h.req(p, inbox, { t: 'itemUse', bag: slot })
    h.advance(10_000)
    expect(h.gameplay.onMoveTo(p, h.now())).toBe(true)
    h.world.moveTo(p, FIELD[0] + 10, FIELD[2], h.now())
    expect(h.of(inbox, 'itemCastEnd')).toEqual([{ t: 'itemCastEnd', id: p.id, item: RETURN_01.code, reason: 'interrupted' }])
    h.advance(25_000)
    expect(warped(h, inbox, p.id)).toHaveLength(0)
    expect(h.countOf(p, RETURN_01.code)).toBe(1)
  })

  it('a knockback-style displacement (> 0.3 m) interrupts; a nudge within 0.3 m does not', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    h.req(p, inbox, { t: 'itemUse', bag: h.give(p, RETURN_01.code, 1) })
    p.pos = [FIELD[0] + 0.2, 0, FIELD[2]]
    h.advance(100)
    expect(h.of(inbox, 'itemCastEnd')).toHaveLength(0)
    p.pos = [FIELD[0] + 0.5, 0, FIELD[2]]
    h.advance(100)
    expect(h.of(inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })
  })

  it('stopAction cancels; death interrupts; a GM teleport interrupts', () => {
    const h = setup()
    const a = h.enter(FIELD)
    h.req(a.p, a.inbox, { t: 'itemUse', bag: h.give(a.p, RETURN_01.code, 1) })
    h.req(a.p, a.inbox, { t: 'stopAction' })
    expect(h.of(a.inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'cancelled' })

    const b = h.enter([FIELD[0], 0, FIELD[2] + 20])
    h.req(b.p, b.inbox, { t: 'itemUse', bag: h.give(b.p, RETURN_01.code, 1) })
    const tiger = h.gameplay.createMob(TIGER, 'normal', FIELD[0] + 1, FIELD[2] + 20, 0, null, h.now())
    h.gameplay.attack(tiger, b.p, h.now())
    expect(b.p.dead).toBe(true)
    expect(h.of(b.inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })
    expect(h.countOf(b.p, RETURN_01.code)).toBe(1)

    const c = h.enter([FIELD[0], 0, FIELD[2] - 20])
    h.req(c.p, c.inbox, { t: 'itemUse', bag: h.give(c.p, RETURN_01.code, 1) })
    const ctx = { world: h.world, gameplay: h.gameplay, data: h.data, setup: { spawn: { x: 0, y: 0, z: 0 } }, config: h.config } as unknown as GameContext
    const conn = { player: c.p, role: 'gm', account: 'gm', send: () => {} } as never
    expect(COMMANDS.tp.run({ ctx, conn, role: 'gm', args: ['50', '50'], self: c.p }).ok).toBe(true)
    expect(h.of(c.inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })
    h.advance(31_000)
    expect(h.countOf(c.p, RETURN_01.code)).toBe(1)
  })

  it('attacking, a pickup walk or talking to an NPC interrupts it', () => {
    const h = setup()
    const a = h.enter(FIELD)
    const mob = h.gameplay.createMob(MANGNYANG, 'normal', FIELD[0] + 3, FIELD[2], 0, null, h.now())
    h.world.snapshotFor(a.p, h.now())
    h.req(a.p, a.inbox, { t: 'itemUse', bag: h.give(a.p, RETURN_01.code, 1) })
    expect(h.req(a.p, a.inbox, { t: 'attack', target: mob.id })).toMatchObject({ ok: true })
    h.advance(100)
    expect(h.of(a.inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })

    const b = h.enter([FIELD[0], 0, FIELD[2] + 30])
    const loot = h.gameplay.spawnGroundItem(HP, 1, 0, [FIELD[0] + 10, 0, FIELD[2] + 30], null, h.now())
    h.req(b.p, b.inbox, { t: 'itemUse', bag: h.give(b.p, RETURN_01.code, 1) })
    expect(h.req(b.p, b.inbox, { t: 'pickup', id: loot.id })).toMatchObject({ ok: true })
    h.advance(100)
    expect(h.of(b.inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })

    const c = h.enter([15, 0, 0])
    h.req(c.p, c.inbox, { t: 'itemUse', bag: h.give(c.p, RETURN_01.code, 1) })
    h.req(c.p, c.inbox, { t: 'npcTalk', npc: h.npcByCode('NPC_CH_POTION').id })
    const ends = h.of(c.inbox, 'itemCastEnd')
    expect(ends.at(-1)).toMatchObject({ reason: 'interrupted' })
    // the end comes before the dialog
    expect(c.inbox.indexOf(ends.at(-1)!)).toBeLessThan(c.inbox.findIndex((m) => m.t === 'npcDialog'))
  })

  it('decision 9: a skill action makes a return use busy, and a skill during the cast interrupts it', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const slot = h.give(p, RETURN_01.code, 1)
    const skills = h.gameplay.skills as unknown as Record<string, unknown>
    let busy = true
    skills.busy = () => busy
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: false, reason: 'busy' })
    busy = false
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    h.advance(1000)
    busy = true // useSkill accepted: the skill action starts
    h.advance(50)
    expect(h.of(inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })
    // the walk into range of a skill target counts too
    busy = false
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: true })
    p.action = { kind: 'skill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: 1, chaseAt: 0, chaseTo: null }
    h.advance(50)
    expect(h.of(inbox, 'itemCastEnd').filter((m) => m.reason === 'interrupted')).toHaveLength(2)
    expect(h.req(p, inbox, { t: 'itemUse', bag: slot })).toMatchObject({ ok: false, reason: 'busy' })
    expect(h.countOf(p, RETURN_01.code)).toBe(1)
  })

  it('a second return use during a cast is busy; potions stay usable and do not interrupt', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const scrolls = h.give(p, RETURN_01.code, 2)
    const herbs = h.give(p, HP, 2)
    h.req(p, inbox, { t: 'itemUse', bag: scrolls })
    expect(h.req(p, inbox, { t: 'itemUse', bag: scrolls })).toMatchObject({ ok: false, reason: 'busy' })
    expect(h.req(p, inbox, { t: 'itemUse', bag: h.give(p, RETURN_03.code, 1) })).toMatchObject({ ok: false, reason: 'busy' })
    p.hp = 1
    expect(h.req(p, inbox, { t: 'itemUse', bag: herbs })).toMatchObject({ ok: true })
    h.advance(30_000)
    expect(h.of(inbox, 'itemCastEnd')).toEqual([{ t: 'itemCastEnd', id: p.id, item: RETURN_01.code, reason: 'done' }])
    expect(h.countOf(p, RETURN_01.code)).toBe(1)
  })

  it('selling the scroll stack mid-cast ends it cancelled at once: no warp', () => {
    const h = setup()
    const { p, inbox } = h.enter([15, 0, 0])
    const potion = h.npcByCode('NPC_CH_POTION')
    const slot = h.give(p, RETURN_01.code, 1)
    h.req(p, inbox, { t: 'itemUse', bag: slot })
    h.advance(1000)
    expect(h.req(p, inbox, { t: 'shopSell', npc: potion.id, bag: slot })).toMatchObject({ ok: true })
    expect(h.of(inbox, 'itemCastEnd')).toEqual([{ t: 'itemCastEnd', id: p.id, item: RETURN_01.code, reason: 'cancelled' }])
    h.advance(30_000)
    expect(warped(h, inbox, p.id)).toHaveLength(0)
    expect(p.gold).toBe(1500)
  })

  it('moving the scroll to another bag slot mid-cast is fine: completion takes it from wherever it is', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const slot = h.give(p, RETURN_01.code, 1)
    h.req(p, inbox, { t: 'itemUse', bag: slot })
    expect(h.req(p, inbox, { t: 'itemMove', from: slot, to: 40 })).toMatchObject({ ok: true })
    h.advance(30_000)
    expect(h.of(inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'done' })
    expect(h.bag(p)[40]).toBeNull()
  })

  it('a return item without a cast time works at once', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    h.req(p, inbox, { t: 'itemUse', bag: h.give(p, RETURN_NOW.code, 1) })
    expect(warped(h, inbox, p.id)).toHaveLength(1)
    expect(h.of(inbox, 'itemCast')).toHaveLength(0)
    expect(h.countOf(p, RETURN_NOW.code)).toBe(0)
  })

  it('the cast closes an open NPC dialog with warp at the end, and forget drops a cast silently', () => {
    const h = setup()
    const { p, inbox } = h.enter([15, 0, 0])
    h.req(p, inbox, { t: 'itemUse', bag: h.give(p, RETURN_03.code, 2) })
    // (talking would interrupt; a dialog opened before the cast stays open)
    h.gameplay.npcs.opened(p, h.npcByCode('NPC_CH_POTION'), h.now())
    h.advance(5000)
    const order = inbox.filter((m) => ['itemCastEnd', 'warp', 'npcDialogClose'].includes(m.t)).map((m) => m.t)
    expect(order).toEqual(['itemCastEnd', 'warp', 'npcDialogClose'])
    expect(h.of(inbox, 'npcDialogClose').at(-1)!.reason).toBe('warp')
    h.req(p, inbox, { t: 'itemUse', bag: h.bag(p).findIndex((i) => i?.code === RETURN_03.code) })
    const n = inbox.length
    h.gameplay.forget(p)
    expect(h.gameplay.itemUses.casting(p)).toBeNull()
    expect(inbox.length).toBe(n)
  })

  it('every frame passes the shared server parser', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    h.req(p, inbox, { t: 'itemUse', bag: h.give(p, HP, 1) })
    h.req(p, inbox, { t: 'itemUse', bag: h.give(p, RETURN_03.code, 1) })
    h.advance(6000)
    for (const m of inbox) expect(parseServerMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(true)
    for (const t of ['itemCooldown', 'itemCast', 'itemCastEnd'] as const) expect(h.of(inbox, t).length, t).toBeGreaterThan(0)
  })
})
