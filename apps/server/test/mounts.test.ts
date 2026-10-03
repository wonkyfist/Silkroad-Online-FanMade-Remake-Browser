/**
 * Horses (docs/SYSTEMS_COMBAT.md §1.3, §8 MR-S; docs/WAVE_PLAN2.md D43, D49, D52): summon from the Red Horse item,
 * ride, dismount, dismiss, the hit redirect, horse death, parked-horse rules, speed and radius, persistence, Recovery
 * Kits, the mounts gate and GM `/horse`. A synthetic flat world with a controlled clock (npc-harness.ts, world speed
 * 5 m/s); the Red Horse numbers are the retail ones (cos.json).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTENT_SCHEMA_VERSION, type CosDef, type GameplayRequest, type ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { CORPSE_MS, PLAYER_BASE } from '../src/formulas.ts'
import { GameData } from '../src/gamedata.ts'
import { MOUNTED_REFUSED, loadCosDefs } from '../src/mounts.ts'
import type { Cos, Player } from '../src/world.ts'
import { LEVELS, MANGNYANG, item } from './fixtures.ts'
import { NPC_DEFS, NPC_ITEMS, SHOP_DEFS, npcHarness, type NpcHarness } from './npc-harness.ts'

const RED: CosDef = {
  code: 'COS_C_HORSE1',
  id: 2191,
  name: 'Red Horse',
  level: 20,
  hp: 983,
  walkSpeed: 4.5,
  runSpeed: 9,
  radius: 1.2,
  physAbsorb: 20,
  magAbsorb: 20,
  parryRate: 65,
  hitRate: 65,
  model: null,
  icon: null,
}
const HORSE = item('ITEM_COS_C_HORSE1', { category: 'scroll', maxStack: 50, reqLevel: 10, price: 1200, sellPrice: 360, use: { summon: 'COS_C_HORSE1' } })
const KIT = item('ITEM_ETC_COS_HP_POTION_01', { category: 'potion', maxStack: 50, price: 190, use: { hp: 360, cooldownGroup: 'cos_hp', cooldownMs: 1000, target: 'mount' } })
const GHOST_HORSE = item('ITEM_COS_GHOST', { category: 'scroll', maxStack: 50, use: { summon: 'COS_NOT_EXPORTED' } })

/** Far from town (0,0,0) and from every NPC. */
const FIELD: [number, number, number] = [200, 0, 200]
const LOCK_MS = 20_000

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})

function setup() {
  const data = new GameData({ mobs: [MANGNYANG], items: [...NPC_ITEMS, HORSE, KIT, GHOST_HORSE], levels: LEVELS, drops: [], npcs: NPC_DEFS, shops: SHOP_DEFS, towns: [] })
  const h = npcHarness({ data })
  harnesses.push(h)
  h.gameplay.mounts.defs.set(RED.code, RED)
  const g = h.gameplay
  /** A level-10 character at `pos` with one Red Horse (bag slot `horse`), out of combat. */
  const rider = (pos: [number, number, number] = FIELD, level = 10) => {
    const e = h.enter(pos)
    e.p.progress = { ...e.p.progress, level }
    const horse = h.give(e.p, HORSE.code, 2)
    return { ...e, horse }
  }
  const horseOf = (p: Player): Cos => {
    const c = g.mounts.horseOf(p)
    if (!c) throw new Error('no horse')
    return c
  }
  const summon = (p: Player, inbox: ServerMessage[], bag: number) => {
    expect(h.req(p, inbox, { t: 'itemUse', bag })).toMatchObject({ ok: true })
    return horseOf(p)
  }
  const saved = (p: Player) => h.store.db.prepare('SELECT code, hp, mounted FROM char_mount WHERE character_id = ?').get(p.characterId) as { code: string; hp: number; mounted: number } | undefined
  const mob = (pos: [number, number, number]) => g.createMob(MANGNYANG, 'normal', pos[0], pos[2], pos[1], null, h.now())
  const hit = (a: Parameters<typeof g.dealHits>[0], t: Player, damage: number, extra: Parameters<typeof g.dealHits>[3] = {}) =>
    g.dealHits(a, t, [{ outcome: 'hit', damage, hp: 0 }], extra, h.now())
  return { h, g, rider, horseOf, summon, saved, mob, hit }
}

const types = (inbox: ServerMessage[], from = 0) => inbox.slice(from).map((m) => m.t)

describe('summon', () => {
  it('consumes one Red Horse and mounts at once: ok -> inventoryUpdate -> spawn {cos} -> the entityUpdate pair', () => {
    const { h, g, rider, horseOf } = setup()
    const { p, inbox, horse } = rider()
    const viewer = h.enter([FIELD[0] + 5, 0, FIELD[2]])
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: true })
    const c = horseOf(p)
    expect(types(inbox, from)).toEqual(['actionResult', 'inventoryUpdate', 'spawn', 'entityUpdate', 'entityUpdate'])
    expect(h.of(inbox, 'spawn').at(-1)!.entity).toMatchObject({ id: c.id, kind: 'cos', model: 'COS_C_HORSE1', name: 'Red Horse', level: 20, hp: 983, maxHp: 983, owner: p.id })
    expect(h.of(inbox, 'entityUpdate').slice(-2)).toEqual([
      { t: 'entityUpdate', id: p.id, mount: c.id },
      { t: 'entityUpdate', id: c.id, rider: p.id },
    ])
    expect(h.countOf(p, HORSE.code)).toBe(1)
    expect(c).toMatchObject({ owner: p.id, ownerChar: p.characterId, rider: p.id, hp: 983 })
    // Anyone who sees the rider later gets EntityState.mount / rider.
    expect(g.world.state(p).mount).toBe(c.id)
    expect(g.world.state(c).rider).toBe(p.id)
    expect(viewer.inbox.some((m) => m.t === 'entityUpdate' && m.id === p.id && m.mount === c.id)).toBe(true)
    // Speed x1.8 (9 / 5) and the horse's radius.
    expect(p.speedMul).toBeCloseTo(1.8)
    expect(p.radius).toBe(1.2)
  })

  it('level 9 -> requirements; the item is kept', () => {
    const { h, g, rider } = setup()
    const { p, inbox, horse } = rider(FIELD, 9)
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: false, reason: 'requirements' })
    expect(h.countOf(p, HORSE.code)).toBe(2)
    expect(g.mounts.horseOf(p)).toBeNull()
  })

  it('within 20 s of combat -> in_combat; at 20 s it works', () => {
    const { h, g, rider } = setup()
    const { p, inbox, horse } = rider()
    p.lastCombatAt = h.now()
    h.advance(LOCK_MS - 50)
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: false, reason: 'in_combat' })
    expect(h.countOf(p, HORSE.code)).toBe(2)
    h.advance(50)
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: true })
    expect(g.mounts.ridden(p)).not.toBeNull()
  })

  it('a second summon -> cos_active, ridden or parked', () => {
    const { h, rider, summon } = setup()
    const { p, inbox, horse } = rider()
    summon(p, inbox, horse)
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: false, reason: 'cos_active' })
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: false, reason: 'cos_active' })
    expect(h.countOf(p, HORSE.code)).toBe(1)
  })

  it('berserk -> berserk_active for summon and ride (D49)', () => {
    const { h, g, rider, summon } = setup()
    const { p, inbox, horse } = rider()
    const berserk = g.berserk as unknown as { active?: (q: Player) => boolean }
    const before = berserk.active
    berserk.active = (q) => q.id === p.id
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: false, reason: 'berserk_active' })
    berserk.active = () => false
    const c = summon(p, inbox, horse)
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    berserk.active = (q) => q.id === p.id
    expect(h.req(p, inbox, { t: 'mountRide', cos: c.id })).toMatchObject({ ok: false, reason: 'berserk_active' })
    berserk.active = before
  })

  it('busy during a return-scroll cast; an unknown CosDef is not_usable and keeps the item', () => {
    const { h, g, rider } = setup()
    const { p, inbox, horse } = rider()
    const ghost = h.give(p, GHOST_HORSE.code, 1)
    expect(h.req(p, inbox, { t: 'itemUse', bag: ghost })).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(h.countOf(p, GHOST_HORSE.code)).toBe(1)
    const scroll = h.give(p, 'ITEM_ETC_SCROLL_RETURN_01', 1)
    expect(h.req(p, inbox, { t: 'itemUse', bag: scroll })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: false, reason: 'busy' })
    expect(g.mounts.horseOf(p)).toBeNull()
  })
})

describe('mounted', () => {
  it('attack and useSkill -> mounted', () => {
    const { h, rider, summon, mob } = setup()
    const { p, inbox, horse } = rider()
    summon(p, inbox, horse)
    const m = mob([FIELD[0] + 3, 0, FIELD[2]])
    h.advance(250)
    expect(h.req(p, inbox, { t: 'attack', target: m.id })).toMatchObject({ ok: false, reason: 'mounted' })
    expect(h.req(p, inbox, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })).toMatchObject({ ok: false, reason: 'mounted' })
  })

  it('the gate refuses sit, emote, stallCreate, alchemyReinforce and berserk while mounted, not on foot; trade is allowed (D43)', () => {
    const { h, g, rider, summon } = setup()
    const { p, inbox, horse } = rider()
    // wave 10 (docs/MOVEMENT.md §4.3): + jump
    expect(MOUNTED_REFUSED).toEqual(['sit', 'emote', 'stallCreate', 'alchemyReinforce', 'berserk', 'jump'])
    for (const t of MOUNTED_REFUSED) expect(g.mounts.gate(p, t, h.now())).toBeNull()
    summon(p, inbox, horse)
    for (const t of MOUNTED_REFUSED) expect(g.mounts.gate(p, t, h.now())).toMatchObject({ ok: false, reason: 'mounted' })
    for (const t of ['tradeRequest', 'tradeRespond', 'pickup', 'shopBuy', 'storageOpen', 'npcTalk', 'itemUse', 'mountDismiss'] as GameplayRequest[]) {
      expect(g.mounts.gate(p, t, h.now())).toBeNull()
    }
    expect(g.mounts.gate(p, 'moveTo', h.now())).toBeNull()
    // Through Gameplay.request: the gate answers before the owning module.
    expect(h.req(p, inbox, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'mounted' })
    expect(h.req(p, inbox, { t: 'emote', emote: 'hi' })).toMatchObject({ ok: false, reason: 'mounted' })
    expect(h.req(p, inbox, { t: 'stallCreate', title: 'Cheap' })).toMatchObject({ ok: false, reason: 'mounted' })
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: 0, elixir: 1 })).toMatchObject({ ok: false, reason: 'mounted' })
    expect(h.req(p, inbox, { t: 'berserk' })).toMatchObject({ ok: false, reason: 'mounted' })
  })

  it('moves 1.8x as fast: a 9 m ride takes 1 s at world speed 5', () => {
    const { h, g, rider, summon, horseOf } = setup()
    const { p, inbox, horse } = rider()
    summon(p, inbox, horse)
    g.onMoveTo(p, h.now())
    g.world.moveTo(p, FIELD[0] + 9, FIELD[2], h.now())
    expect(g.world.arrivalTime(p.move!) - h.now()).toBeCloseTo(1000)
    // The horse shares the move (interest management and positionAt stay right mid-move).
    h.advance(500)
    const c = horseOf(p)
    expect(c.move).toBe(p.move)
    expect(g.world.positionAt(c, h.now())[0]).toBeCloseTo(FIELD[0] + 4.5)
    h.advance(500)
    expect(p.pos[0]).toBeCloseTo(FIELD[0] + 9)
    h.advance(50)
    expect(c.pos[0]).toBeCloseTo(FIELD[0] + 9)
    expect(c.move).toBeNull()
  })

  it('a mob hit on a mounted player lowers the horse, not the player; a poison tick (extra.dot) hits the rider', () => {
    const { h, rider, summon, mob, hit } = setup()
    const { p, inbox, horse } = rider()
    const c = summon(p, inbox, horse)
    const m = mob([FIELD[0] + 2, 0, FIELD[2]])
    h.advance(250)
    const hp = p.hp
    const from = inbox.length
    const r = hit(m, p, 100)
    expect(r).toMatchObject({ dealt: 100, killed: false })
    expect(c.hp).toBe(883)
    expect(p.hp).toBe(hp)
    expect(h.of(inbox.slice(from), 'combat')).toEqual([{ t: 'combat', attacker: m.id, target: c.id, hits: [{ outcome: 'hit', damage: 100, hp: 883 }] }])
    // The rider is in combat (the 20 s boarding lockout counts from the hit).
    expect(p.lastCombatAt).toBe(h.now())
    hit(m, p, 7, { dot: true })
    expect(p.hp).toBe(hp - 7)
    expect(c.hp).toBe(883)
  })

  it('the horse dies at 0: the rider lands on its feet, the corpse leaves after CORPSE_MS, the saved row is deleted', () => {
    const { h, g, rider, summon, mob, hit, saved } = setup()
    const { p, inbox, horse } = rider()
    const c = summon(p, inbox, horse)
    expect(saved(p)).toEqual({ code: 'COS_C_HORSE1', hp: 983, mounted: 1 })
    const m = mob([FIELD[0] + 2, 0, FIELD[2]])
    h.advance(250)
    const from = inbox.length
    expect(hit(m, p, 5000)).toMatchObject({ dealt: 983, killed: true })
    expect(types(inbox, from)).toEqual(['combat', 'entityUpdate', 'entityUpdate', 'entityUpdate', 'chat'])
    expect(inbox.slice(from + 1, from + 4)).toEqual([
      { t: 'entityUpdate', id: c.id, hp: 0, state: 'dead' },
      { t: 'entityUpdate', id: p.id, mount: null },
      { t: 'entityUpdate', id: c.id, rider: null },
    ])
    expect(h.of(inbox, 'chat').at(-1)).toMatchObject({ channel: 'system', text: 'Your horse has died.' })
    expect(g.mounts.horseOf(p)).toBeNull()
    expect(g.mounts.ridden(p)).toBeNull()
    expect(p.speedMul).toBeCloseTo(1)
    expect(p.radius).toBe(PLAYER_BASE.radius)
    expect(saved(p)).toBeUndefined()
    // The next hit lands on the player.
    const hp = p.hp
    hit(m, p, 5)
    expect(p.hp).toBe(hp - 5)
    expect(g.world.cos.has(c.id)).toBe(true)
    h.advance(CORPSE_MS)
    expect(g.world.cos.has(c.id)).toBe(false)
    expect(inbox.some((x) => x.t === 'despawn' && x.id === c.id)).toBe(true)
    // A new horse can be summoned (after the combat lockout).
    h.advance(LOCK_MS)
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: true })
  })

  it('a DoT death of the rider sets it down; the parked horse is dismissed at the respawn warp', () => {
    const { h, g, rider, summon, mob, hit, saved } = setup()
    const { p, inbox, horse } = rider()
    const c = summon(p, inbox, horse)
    const m = mob([FIELD[0] + 2, 0, FIELD[2]])
    hit(m, p, p.hp + 10, { dot: true })
    expect(p.dead).toBe(true)
    expect(c.rider).toBeNull()
    expect(g.mounts.horseOf(p)).toBe(c)
    expect(h.req(p, inbox, { t: 'respawn' })).toMatchObject({ ok: true })
    expect(g.mounts.horseOf(p)).toBeNull()
    expect(g.world.cos.has(c.id)).toBe(false)
    expect(saved(p)).toBeUndefined()
  })
})

describe('dismount, ride, dismiss', () => {
  it('mountDismount while moving -> moving; stopped: ok -> stop 1.2 m to the left -> the entityUpdate pair with null', () => {
    const { h, g, rider, summon, saved } = setup()
    const { p, inbox, horse } = rider()
    const c = summon(p, inbox, horse)
    g.world.moveTo(p, FIELD[0], FIELD[2] + 20, h.now())
    h.advance(100)
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: false, reason: 'moving' })
    h.advance(3000)
    expect(p.move).toBeNull()
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'stop', 'entityUpdate', 'entityUpdate'])
    expect(inbox.slice(from + 2)).toEqual([
      { t: 'entityUpdate', id: p.id, mount: null },
      { t: 'entityUpdate', id: c.id, rider: null },
    ])
    // Facing +z (yaw 0): the left is +x.
    expect(c.pos[0]).toBeCloseTo(FIELD[0])
    expect(c.pos[2]).toBeCloseTo(FIELD[2] + 20)
    expect(p.pos[0]).toBeCloseTo(FIELD[0] + 1.2)
    expect(p.pos[2]).toBeCloseTo(FIELD[2] + 20)
    expect(p.speedMul).toBeCloseTo(1)
    expect(p.radius).toBe(PLAYER_BASE.radius)
    expect(saved(p)).toMatchObject({ mounted: 0 })
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: false, reason: 'not_mounted' })
    // On foot: attacks and the gated requests work again.
    expect(g.mounts.refuse(p, 'attack')).toBeNull()
    expect(h.req(p, inbox, { t: 'emote', emote: 'hi' })).toMatchObject({ ok: true })
  })

  it('mountRide within 2 m boards at once; farther it walks there first (the board action)', () => {
    const { h, g, rider, summon } = setup()
    const { p, inbox, horse } = rider()
    const c = summon(p, inbox, horse)
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    let from = inbox.length
    expect(h.req(p, inbox, { t: 'mountRide', cos: c.id })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'stop', 'entityUpdate', 'entityUpdate'])
    expect(g.mounts.ridden(p)).toBe(c)
    expect(p.pos).toEqual(c.pos)
    expect(h.req(p, inbox, { t: 'mountRide', cos: c.id })).toMatchObject({ ok: false, reason: 'mounted' })
    // Park it, walk 10 m away, ride again: the server walks back, then mounts.
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    g.world.moveTo(p, FIELD[0] + 10, FIELD[2], h.now())
    h.advance(3000)
    from = inbox.length
    expect(h.req(p, inbox, { t: 'mountRide', cos: c.id })).toMatchObject({ ok: true })
    expect(g.mounts.ridden(p)).toBeNull()
    expect(p.action).toMatchObject({ kind: 'board', cos: c.id })
    h.advance(3000)
    expect(g.mounts.ridden(p)).toBe(c)
    // actionResult -> move -> stop (arrival within 2 m) -> stop (onto the saddle) -> the pair (regen lines aside).
    const seq = inbox.slice(from).filter((m) => m.t !== 'statsDelta' && !(m.t === 'entityUpdate' && m.hp !== undefined))
    expect(seq.map((m) => m.t)).toEqual(['actionResult', 'move', 'stop', 'stop', 'entityUpdate', 'entityUpdate'])
    expect(seq.at(-3)).toMatchObject({ t: 'stop', id: p.id, pos: c.pos })
    expect(p.action).toBeNull()
  })

  it('mountRide: not_found for another player\'s horse or a bad id; in_combat inside the lockout', () => {
    const { h, g, rider, summon } = setup()
    const a = rider()
    const b = rider([FIELD[0] + 3, 0, FIELD[2]])
    const ca = summon(a.p, a.inbox, a.horse)
    expect(h.req(a.p, a.inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    h.advance(250)
    expect(h.req(b.p, b.inbox, { t: 'mountRide', cos: ca.id })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(a.p, a.inbox, { t: 'mountRide', cos: 99999 })).toMatchObject({ ok: false, reason: 'not_found' })
    a.p.lastCombatAt = h.now()
    expect(h.req(a.p, a.inbox, { t: 'mountRide', cos: ca.id })).toMatchObject({ ok: false, reason: 'in_combat' })
    expect(g.mounts.ridden(a.p)).toBeNull()
  })

  it('mountDismiss removes the horse (ridden or parked) and its row; also while dead; not_found without one', () => {
    const { h, g, rider, summon, saved } = setup()
    const { p, inbox, horse } = rider()
    expect(h.req(p, inbox, { t: 'mountDismiss' })).toMatchObject({ ok: false, reason: 'not_found' })
    const c = summon(p, inbox, horse)
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'mountDismiss' })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'entityUpdate', 'despawn'])
    expect(g.world.cos.has(c.id)).toBe(false)
    expect(p.speedMul).toBeCloseTo(1)
    expect(saved(p)).toBeUndefined()
    const c2 = summon(p, inbox, horse)
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    g.gmKill(p, h.now())
    expect(h.req(p, inbox, { t: 'mountDismiss' })).toMatchObject({ ok: true })
    expect(g.world.cos.has(c2.id)).toBe(false)
  })
})

describe('parked horses', () => {
  it('are dismissed once the owner is farther than 60 m (59 m is fine)', () => {
    const { h, g, rider, summon, saved } = setup()
    const { p, inbox, horse } = rider()
    const c = summon(p, inbox, horse)
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    const x0 = c.pos[0]
    g.world.warp(p, x0 + 59, 0, c.pos[2], h.now())
    h.advance(100)
    expect(g.world.cos.has(c.id)).toBe(true)
    g.world.warp(p, x0 + 61, 0, c.pos[2], h.now())
    h.advance(100)
    expect(g.world.cos.has(c.id)).toBe(false)
    expect(g.mounts.horseOf(p)).toBeNull()
    expect(saved(p)).toBeUndefined()
    expect(h.of(inbox, 'chat').at(-1)).toMatchObject({ channel: 'system', text: 'Your horse went home.' })
  })

  it('a warp takes a ridden horse along and dismisses a parked one', () => {
    const { h, g, rider, summon } = setup()
    const { p, inbox, horse } = rider()
    const c = summon(p, inbox, horse)
    g.world.warp(p, 400, 0, 400, h.now())
    g.warped(p, 'gm', h.now())
    expect(c.pos).toEqual(p.pos)
    expect(p.known.has(c.id)).toBe(true)
    expect(g.mounts.ridden(p)).toBe(c)
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    g.world.warp(p, 402, 0, 400, h.now())
    g.warped(p, 'gm', h.now())
    expect(g.world.cos.has(c.id)).toBe(false)
  })
})

describe('persistence', () => {
  /** What connection.ts does on leave and on enter (World.remove -> forget; add -> snapshot -> sendEnter). */
  const relog = (h: NpcHarness, p: Player) => {
    h.world.settle(p, h.now())
    h.world.remove(p.id, h.now())
    h.gameplay.forget(p)
    const inbox: ServerMessage[] = []
    const row = h.store.characterById(p.characterId)!
    const q = h.world.add({ ...h.gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: p.level, weapon: row.weapon, pos: [...p.pos], yaw: 0, send: (m) => inbox.push(m) })
    q.progress = { ...q.progress, level: p.progress.level }
    h.world.snapshotFor(q, h.now())
    h.gameplay.sendEnter(q, h.now())
    return { p: q, inbox }
  }

  it('relog restores a mounted horse with the saved HP: spawn {cos} + the entityUpdate pair after the modules before it', () => {
    const { h, g, rider, summon, mob, hit, saved } = setup()
    const { p, inbox, horse } = rider()
    const c = summon(p, inbox, horse)
    hit(mob([FIELD[0] + 2, 0, FIELD[2]]), p, 300)
    // Damage is saved at most every 5 s (and on logout).
    expect(saved(p)).toMatchObject({ hp: 983 })
    h.advance(5000)
    expect(saved(p)).toMatchObject({ hp: 683, mounted: 1 })
    hit(mob([FIELD[0] + 2, 0, FIELD[2]]), p, 83)
    const q = relog(h, p)
    expect(g.world.cos.has(c.id)).toBe(false)
    const c2 = g.mounts.ridden(q.p)!
    expect(c2).not.toBeNull()
    expect(c2.hp).toBe(600)
    const spawnAt = q.inbox.findIndex((m) => m.t === 'spawn' && m.entity.id === c2.id)
    expect(spawnAt).toBeGreaterThan(q.inbox.findIndex((m) => m.t === 'inventory'))
    expect(q.inbox.slice(spawnAt + 1, spawnAt + 3)).toEqual([
      { t: 'entityUpdate', id: q.p.id, mount: c2.id },
      { t: 'entityUpdate', id: c2.id, rider: q.p.id },
    ])
    expect(q.p.speedMul).toBeCloseTo(1.8)
    // The lockout does not apply to a restored horse.
    expect(saved(q.p)).toEqual({ code: 'COS_C_HORSE1', hp: 600, mounted: 1 })
  })

  it('a logout while parked dismisses the horse; a saved parked row (a crash) comes back parked', () => {
    const { h, g, rider, summon, saved } = setup()
    const { p, inbox, horse } = rider()
    summon(p, inbox, horse)
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    const q = relog(h, p)
    expect(saved(q.p)).toBeUndefined()
    expect(g.mounts.horseOf(q.p)).toBeNull()
    h.store.db.prepare('INSERT INTO char_mount (character_id, code, hp, mounted) VALUES (?, ?, ?, 0)').run(q.p.characterId, 'COS_C_HORSE1', 500)
    const r = relog(h, q.p)
    const c = g.mounts.horseOf(r.p)!
    expect(c).toMatchObject({ rider: null, hp: 500 })
    expect(r.inbox.some((m) => m.t === 'spawn' && m.entity.id === c.id && m.entity.rider === undefined)).toBe(true)
  })

  it('a saved horse whose code cos.json lacks keeps its row and spawns nothing', () => {
    const { h, g, rider, saved } = setup()
    const { p } = rider()
    h.store.db.prepare('INSERT INTO char_mount (character_id, code, hp, mounted) VALUES (?, ?, ?, 1)').run(p.characterId, 'COS_GONE', 10)
    const q = relog(h, p)
    expect(g.mounts.horseOf(q.p)).toBeNull()
    expect(saved(q.p)).toMatchObject({ code: 'COS_GONE' })
  })
})

describe('Recovery Kits', () => {
  it('heal the horse 360: ok -> inventoryUpdate -> itemCooldown -> entityUpdate {cos.hp} -> itemEffect {id: cos} (D52)', () => {
    const { h, rider, summon, mob, hit, saved } = setup()
    const { p, inbox, horse } = rider()
    const kit = h.give(p, KIT.code, 3)
    expect(h.req(p, inbox, { t: 'itemUse', bag: kit })).toMatchObject({ ok: false, reason: 'not_usable', message: 'You have no horse.' })
    expect(h.countOf(p, KIT.code)).toBe(3)
    const c = summon(p, inbox, horse)
    hit(mob([FIELD[0] + 2, 0, FIELD[2]]), p, 500)
    const hp = p.hp
    const from = inbox.length
    expect(h.req(p, inbox, { t: 'itemUse', bag: kit })).toMatchObject({ ok: true })
    expect(types(inbox, from)).toEqual(['actionResult', 'inventoryUpdate', 'itemCooldown', 'entityUpdate', 'itemEffect'])
    expect(inbox.slice(from + 2)).toEqual([
      { t: 'itemCooldown', group: 'cos_hp', readyInMs: 1000, totalMs: 1000 },
      { t: 'entityUpdate', id: c.id, hp: 843 },
      { t: 'itemEffect', id: c.id, item: KIT.code },
    ])
    expect(c.hp).toBe(843)
    expect(p.hp).toBe(hp)
    expect(saved(p)).toMatchObject({ hp: 843 })
    expect(h.req(p, inbox, { t: 'itemUse', bag: kit })).toMatchObject({ ok: false, reason: 'cooldown' })
    h.advance(1000)
    expect(h.req(p, inbox, { t: 'itemUse', bag: kit })).toMatchObject({ ok: true })
    expect(c.hp).toBe(983)
    expect(h.countOf(p, KIT.code)).toBe(1)
  })

  it('reach a parked horse within 30 m, not farther', () => {
    const { h, g, rider, summon, mob, hit } = setup()
    const { p, inbox, horse } = rider()
    const c = summon(p, inbox, horse)
    hit(mob([FIELD[0] + 2, 0, FIELD[2]]), p, 500)
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: true })
    const kit = h.give(p, KIT.code, 2)
    g.world.warp(p, c.pos[0] + 31, 0, c.pos[2], h.now())
    expect(h.req(p, inbox, { t: 'itemUse', bag: kit })).toMatchObject({ ok: false, reason: 'too_far' })
    g.world.warp(p, c.pos[0] + 29, 0, c.pos[2], h.now())
    expect(h.req(p, inbox, { t: 'itemUse', bag: kit })).toMatchObject({ ok: true })
    expect(c.hp).toBe(843)
  })
})

describe('GM /horse and cos.json', () => {
  it('/horse summons and mounts without an item or level; /horse off dismisses', () => {
    const { h, g, rider } = setup()
    const { p } = rider(FIELD, 1)
    p.lastCombatAt = h.now()
    expect(g.mounts.gm(p, [])).toMatchObject({ ok: true })
    const c = g.mounts.ridden(p)!
    expect(c.code).toBe('COS_C_HORSE1')
    expect(h.countOf(p, HORSE.code)).toBe(2)
    expect(g.mounts.gm(p, ['cos_c_horse1'])).toMatchObject({ ok: true })
    expect(g.world.cos.has(c.id)).toBe(false)
    expect(g.mounts.gm(p, ['COS_NOPE'])).toMatchObject({ ok: false })
    expect(g.mounts.gm(p, ['off'])).toMatchObject({ ok: true })
    expect(g.mounts.horseOf(p)).toBeNull()
    expect(g.mounts.gm(p, ['off'])).toMatchObject({ ok: false })
  })

  it('loadCosDefs reads OUT_DIR/data/cos.json and skips bad records', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-cos-'))
    try {
      mkdirSync(join(root, 'data'))
      writeFileSync(join(root, 'data', 'cos.json'), JSON.stringify({ schema: CONTENT_SCHEMA_VERSION, kind: 'cos', entries: [RED, { code: 'bad' }] }))
      const logs: string[] = []
      const defs = loadCosDefs(root, (m) => logs.push(m))
      expect([...defs.keys()]).toEqual(['COS_C_HORSE1'])
      expect(logs).toEqual(['content cos.json: 1 loaded, 1 skipped'])
      expect(loadCosDefs(join(root, 'missing'), (m) => logs.push(m)).size).toBe(0)
      expect(logs.at(-1)).toBe('content cos.json: missing (no horses)')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
