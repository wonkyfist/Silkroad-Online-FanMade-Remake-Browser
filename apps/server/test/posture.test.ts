/**
 * Wave 7B server effects (docs/WAVE_PLAN2.md §5.8, docs/EFFECTS.md §6.3; lane FX-S): the drop toss fields
 * (`droppedAt`, `dropFrom`), the consumable visual (`itemEffect`) and the posture module (`sit`, `emote`, standing up).
 * Most of it runs in the synthetic NPC world with a controlled clock (npc-harness.ts); the last block goes over real
 * WebSockets so every frame passes the strict validator and the emote budget is the real CLIENT_RATE_LIMITS one.
 */
import { CLIENT_RATE_LIMITS, type ServerMessage } from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GameData } from '../src/gamedata.ts'
import { SIT_COMBAT_MS } from '../src/posture.ts'
import type { Mob, Player } from '../src/world.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, contentFiles } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { MP_POTION, NPC_DEFS, NPC_ITEMS, RETURN_01, SHOP_DEFS, npcHarness, type Msg, type NpcHarness } from './npc-harness.ts'

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})
function setup(withDrops = false) {
  const data = withDrops ? new GameData({ mobs: [MANGNYANG], items: NPC_ITEMS, levels: LEVELS, drops: DROPS, npcs: NPC_DEFS, shops: SHOP_DEFS, towns: [] }) : undefined
  const h = npcHarness(data ? { data } : {})
  harnesses.push(h)
  return h
}

/** Far from town (0,0,0) and from every NPC. */
const FIELD: [number, number, number] = [200, 0, 200]
/** Beside FIELD: sees and is seen. */
const NEAR: [number, number, number] = [203, 0, 200]
/** Out of everyone's view (view range 120 m). */
const FAR: [number, number, number] = [-300, 0, -300]

const postures = (h: NpcHarness, inbox: ServerMessage[], id: number) =>
  h.of(inbox, 'entityUpdate').filter((m) => m.id === id && m.posture !== undefined).map((m) => m.posture)

/** A player at FIELD, a viewer beside it (both know each other) and a stranger far away. */
function trio(h: NpcHarness) {
  const a = h.enter(FIELD)
  const b = h.enter(NEAR)
  const far = h.enter(FAR)
  h.advance(250) // interest update: a learns about b too
  expect(a.p.known.has(b.p.id) && b.p.known.has(a.p.id)).toBe(true)
  expect(far.p.known.has(a.p.id)).toBe(false)
  return { a, b, far }
}

function spawnMob(h: NpcHarness, at: [number, number, number]): Mob {
  return h.gameplay.createMob(MANGNYANG, 'normal', at[0], at[2], at[1], null, h.now())
}

function sitDown(h: NpcHarness, p: Player, inbox: ServerMessage[]) {
  expect(h.req(p, inbox, { t: 'sit', on: true })).toEqual({ t: 'actionResult', re: 'sit', ok: true })
  expect(h.gameplay.posture.isSitting(p)).toBe(true)
}

describe('drops: droppedAt and dropFrom (P1)', () => {
  it('loot carries the kill tick and the corpse point, in its spawn frame and in later snapshots', () => {
    const h = setup(true)
    const { p, inbox } = h.enter(FIELD)
    const m = spawnMob(h, [206, 0, 204])
    p.known.add(m.id)
    h.advance(100)
    const killAt = h.now()
    const from = inbox.length
    h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: 9999, hp: 0 }], {}, killAt)
    const loot = [...h.world.items.values()]
    expect(loot.length).toBeGreaterThanOrEqual(2) // gold + the blade (DROPS: both at chance 1)
    for (const it of loot) {
      const s = h.world.state(it)
      expect(s.droppedAt).toBe(killAt)
      expect(s.dropFrom).toEqual([206, 0, 204])
      expect(s.pos).not.toEqual([206, 0, 204]) // landed around the corpse, not on it
    }
    h.advance(250) // the viewer's interest update sends the spawns
    const spawns = h.of(inbox.slice(from), 'spawn').filter((x) => x.entity.kind === 'item')
    expect(spawns).toHaveLength(loot.length)
    for (const s of spawns) expect(s.entity).toMatchObject({ droppedAt: killAt, dropFrom: [206, 0, 204] })
    // Seen later (enter-view), the fields are the same: the client decides freshness from droppedAt.
    const late = h.enter([207, 0, 200])
    const snap = h.world.snapshotFor(late.p, h.now()).filter((e) => e.kind === 'item')
    expect(snap.every((e) => e.droppedAt === killAt)).toBe(true)
  })

  it("a player's own drop has droppedAt and no dropFrom; droppedAt is always an integer", () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const slot = h.give(p, 'ITEM_ETC_HP_POTION_01', 2)
    expect(h.req(p, inbox, { t: 'itemDrop', bag: slot })).toMatchObject({ ok: true })
    const [it] = [...h.world.items.values()]
    const s = h.world.state(it)
    expect(s.droppedAt).toBe(h.now())
    expect(s.dropFrom).toBeUndefined()
    const odd = h.gameplay.spawnGroundItem('ITEM_ETC_HP_POTION_01', 1, 0, [201, 0, 200], null, 1_234_567.6, null, null, [200, 0.5, 200])
    expect(h.world.state(odd)).toMatchObject({ droppedAt: 1_234_568, dropFrom: [200, 0.5, 200] })
  })
})

describe('itemEffect (P3)', () => {
  it('a potion, a grain or a pill reaches the user and its viewers, never a stranger out of view', () => {
    const h = setup()
    const { a, b, far } = trio(h)
    const hp = h.give(a.p, 'ITEM_ETC_HP_POTION_01', 2)
    a.p.hp = 1
    const fromA = a.inbox.length
    const fromB = b.inbox.length
    const fromFar = far.inbox.length
    expect(h.req(a.p, a.inbox, { t: 'itemUse', bag: hp })).toMatchObject({ ok: true })
    const want = { t: 'itemEffect', id: a.p.id, item: 'ITEM_ETC_HP_POTION_01' }
    expect(h.of(a.inbox.slice(fromA), 'itemEffect')).toEqual([want])
    expect(h.of(b.inbox.slice(fromB), 'itemEffect')).toEqual([want])
    expect(h.of(far.inbox.slice(fromFar), 'itemEffect')).toEqual([])
    // An MP potion at full MP still shows (the potion was drunk).
    const mp = h.give(a.p, MP_POTION.code, 1)
    expect(h.req(a.p, a.inbox, { t: 'itemUse', bag: mp })).toMatchObject({ ok: true })
    expect(h.of(b.inbox, 'itemEffect').map((m) => m.item)).toEqual(['ITEM_ETC_HP_POTION_01', MP_POTION.code])
  })

  it('refused uses and return scrolls send none', () => {
    const h = setup()
    const { a, b } = trio(h)
    const hp = h.give(a.p, 'ITEM_ETC_HP_POTION_01', 2)
    expect(h.req(a.p, a.inbox, { t: 'itemUse', bag: hp })).toMatchObject({ ok: true })
    expect(h.req(a.p, a.inbox, { t: 'itemUse', bag: hp })).toMatchObject({ ok: false, reason: 'cooldown' })
    const scroll = h.give(a.p, RETURN_01.code, 1)
    expect(h.req(a.p, a.inbox, { t: 'itemUse', bag: scroll })).toMatchObject({ ok: true })
    expect(h.of(b.inbox, 'itemCast')).toHaveLength(1)
    expect(h.of(b.inbox, 'itemEffect')).toHaveLength(1)
  })
})

describe('sit (P4)', () => {
  it('sitting is told to the sitter and its viewers, kept in the EntityState, and idempotent both ways', () => {
    const h = setup()
    const { a, b, far } = trio(h)
    expect(h.gameplay.routes.get('sit')).toBe(h.gameplay.posture)
    expect(h.gameplay.routes.get('emote')).toBe(h.gameplay.posture)
    // Standing up while standing: ok, and nothing is broadcast.
    expect(h.req(a.p, a.inbox, { t: 'sit', on: false })).toMatchObject({ ok: true })
    expect(postures(h, b.inbox, a.p.id)).toEqual([])
    sitDown(h, a.p, a.inbox)
    expect(postures(h, a.inbox, a.p.id)).toEqual(['sit'])
    expect(postures(h, b.inbox, a.p.id)).toEqual(['sit'])
    expect(postures(h, far.inbox, a.p.id)).toEqual([])
    expect(h.req(a.p, a.inbox, { t: 'sit', on: true })).toMatchObject({ ok: true })
    expect(postures(h, b.inbox, a.p.id)).toEqual(['sit'])
    expect(h.world.state(a.p).posture).toBe('sit')
    const late = h.enter([204, 0, 201])
    expect(h.world.snapshotFor(late.p, h.now()).find((e) => e.id === a.p.id)?.posture).toBe('sit')
    // Sitting still is not an action: nothing stands the sitter up over time.
    h.advance(3000)
    expect(h.gameplay.posture.isSitting(a.p)).toBe(true)
    expect(h.req(a.p, a.inbox, { t: 'sit', on: false })).toMatchObject({ ok: true })
    expect(postures(h, b.inbox, a.p.id)).toEqual(['sit', 'stand'])
    expect(h.world.state(a.p).posture).toBeUndefined()
  })

  it("refused while moving, acting, reading a scroll, within 5 s of combat ('busy') and while dead", () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    h.world.moveEntity(p, 230, 200, h.world.moveSpeed, h.now())
    expect(h.req(p, inbox, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'busy' })
    h.advance(10_000)
    expect(p.move).toBeNull()
    p.action = { kind: 'talk', npc: 1, chaseAt: 0, chaseTo: null }
    expect(h.req(p, inbox, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'busy' })
    p.action = null
    const scroll = h.give(p, RETURN_01.code, 1)
    expect(h.req(p, inbox, { t: 'itemUse', bag: scroll })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'busy' })
    expect(h.req(p, inbox, { t: 'stopAction' })).toMatchObject({ ok: true })
    p.lastCombatAt = h.now() - (SIT_COMBAT_MS - 1)
    expect(h.req(p, inbox, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'in_combat' })
    p.lastCombatAt = h.now() - SIT_COMBAT_MS
    p.dead = true
    expect(h.req(p, inbox, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'dead' })
    p.dead = false
    expect(h.req(p, inbox, { t: 'sit', on: true })).toMatchObject({ ok: true })
    expect(h.gameplay.posture.isSitting(p)).toBe(true)
  })

  it('moveTo, stopAction and a warp stand the sitter up (entityUpdate posture stand)', () => {
    const h = setup()
    const { a, b } = trio(h)
    sitDown(h, a.p, a.inbox)
    expect(h.gameplay.onMoveTo(a.p, h.now())).toBe(true)
    expect(postures(h, b.inbox, a.p.id)).toEqual(['sit', 'stand'])
    expect(postures(h, a.inbox, a.p.id)).toEqual(['sit', 'stand'])
    sitDown(h, a.p, a.inbox)
    expect(h.req(a.p, a.inbox, { t: 'stopAction' })).toMatchObject({ ok: true })
    expect(postures(h, b.inbox, a.p.id)).toEqual(['sit', 'stand', 'sit', 'stand'])
    sitDown(h, a.p, a.inbox)
    h.gameplay.toTown(a.p)
    expect(h.gameplay.posture.isSitting(a.p)).toBe(false)
    expect(postures(h, a.inbox, a.p.id).at(-1)).toBe('stand')
  })

  it('an accepted attack, pickup or npcTalk stands up; a refused one does not', () => {
    const h = setup()
    const { p, inbox } = h.enter([18, 0, 0]) // beside the potion merchant (20, 0)
    const m = spawnMob(h, [16, 0, 0])
    p.known.add(m.id)
    sitDown(h, p, inbox)
    expect(h.req(p, inbox, { t: 'attack', target: 999_999 })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.gameplay.posture.isSitting(p)).toBe(true)
    expect(h.req(p, inbox, { t: 'attack', target: m.id })).toMatchObject({ ok: true })
    expect(postures(h, inbox, p.id)).toEqual(['sit', 'stand'])
    // npcTalk right beside the NPC opens the dialog without a walk (no action): still stands up.
    p.action = null
    p.lastCombatAt = 0
    sitDown(h, p, inbox)
    expect(h.req(p, inbox, { t: 'npcTalk', npc: h.npcByCode('NPC_CH_POTION').id })).toMatchObject({ ok: true })
    expect(h.gameplay.posture.isSitting(p)).toBe(false)
    // A pickup in reach (no walk either).
    sitDown(h, p, inbox)
    const it = h.gameplay.spawnGroundItem('ITEM_ETC_HP_POTION_01', 1, 0, [18.5, 0, 0], null, h.now())
    p.known.add(it.id)
    expect(h.req(p, inbox, { t: 'pickup', id: it.id })).toMatchObject({ ok: true })
    expect(h.gameplay.posture.isSitting(p)).toBe(false)
    expect(postures(h, inbox, p.id)).toEqual(['sit', 'stand', 'sit', 'stand', 'sit', 'stand'])
  })

  it('damage taken stands the sitter up on the next tick; death stands it up after the dead state', () => {
    const h = setup()
    const { a, b } = trio(h)
    const m = spawnMob(h, [201, 0, 201])
    sitDown(h, a.p, a.inbox)
    h.gameplay.dealHits(m, a.p, [{ outcome: 'hit', damage: 5, hp: 0 }], {}, h.now())
    expect(h.gameplay.posture.isSitting(a.p)).toBe(true)
    h.advance(50)
    expect(h.gameplay.posture.isSitting(a.p)).toBe(false)
    expect(postures(h, b.inbox, a.p.id)).toEqual(['sit', 'stand'])
    // Sitting again needs 5 s out of combat.
    expect(h.req(a.p, a.inbox, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'in_combat' })
    h.advance(SIT_COMBAT_MS)
    sitDown(h, a.p, a.inbox)
    const from = b.inbox.length
    h.gameplay.gmKill(a.p, h.now())
    const seen = b.inbox.slice(from).filter((x): x is Msg<'entityUpdate'> => x.t === 'entityUpdate' && x.id === a.p.id)
    expect(seen.map((x) => x.state ?? x.posture)).toEqual(['dead', 'stand'])
    expect(h.world.state(a.p).posture).toBeUndefined()
  })
})

describe('emote (P4)', () => {
  it('plays for the sender and its viewers only; a sitter stands up first', () => {
    const h = setup()
    const { a, b, far } = trio(h)
    expect(h.req(a.p, a.inbox, { t: 'emote', emote: 'hi' })).toEqual({ t: 'actionResult', re: 'emote', ok: true })
    const want = { t: 'emote', id: a.p.id, emote: 'hi' }
    expect(h.of(a.inbox, 'emote')).toEqual([want])
    expect(h.of(b.inbox, 'emote')).toEqual([want])
    expect(h.of(far.inbox, 'emote')).toEqual([])
    sitDown(h, a.p, a.inbox)
    const from = b.inbox.length
    expect(h.req(a.p, a.inbox, { t: 'emote', emote: 'joy' })).toMatchObject({ ok: true })
    const after = b.inbox.slice(from).filter((x) => x.t === 'emote' || (x.t === 'entityUpdate' && x.posture))
    expect(after).toEqual([{ t: 'entityUpdate', id: a.p.id, posture: 'stand' }, { t: 'emote', id: a.p.id, emote: 'joy' }])
  })

  it("refused while moving or reading a scroll ('busy') and while dead; allowed during auto-attack", () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    h.world.moveEntity(p, 230, 200, h.world.moveSpeed, h.now())
    expect(h.req(p, inbox, { t: 'emote', emote: 'no' })).toMatchObject({ ok: false, reason: 'busy' })
    h.advance(10_000)
    const scroll = h.give(p, RETURN_01.code, 1)
    expect(h.req(p, inbox, { t: 'itemUse', bag: scroll })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'emote', emote: 'no' })).toMatchObject({ ok: false, reason: 'busy' })
    expect(h.req(p, inbox, { t: 'stopAction' })).toMatchObject({ ok: true })
    p.action = { kind: 'attack', target: 999_999, chaseAt: 0, chaseTo: null }
    expect(h.req(p, inbox, { t: 'emote', emote: 'yes' })).toMatchObject({ ok: true })
    p.dead = true
    expect(h.req(p, inbox, { t: 'emote', emote: 'yes' })).toMatchObject({ ok: false, reason: 'dead' })
    expect(h.of(inbox, 'emote')).toHaveLength(1)
  })
})

// ---- over real WebSockets: the strict validator on every frame, and the per-type budget --------------------------

describe('over the wire', () => {
  const SPAWN: [number, number, number] = [50, 0, -50]
  let s: TestServer

  beforeAll(async () => {
    s = await startTestServer({
      config: { moveSpeed: 30, tickHz: 20, viewRange: 60, spawnMobs: false },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({ mobs: [MANGNYANG], nests: [], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: [], shops: [] }),
      },
    })
  })
  afterAll(async () => {
    await s.stopAndClean()
  })

  let n = 0
  async function player() {
    const acc = await newAccount(s.url, 'pz')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Sitter${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const enter = await c.next('worldEnter')
    return { c, id: enter.self.id, enter }
  }
  async function act(c: Client, msg: Record<string, unknown> & { t: string }) {
    c.send(msg)
    return c.next('actionResult', (m) => m.re === msg.t)
  }

  it('sit, posture in spawn frames, emotes within their budget (1/s, burst 3), and a tossed drop, all valid frames', async () => {
    expect(CLIENT_RATE_LIMITS.emote).toEqual({ perSecond: 1, burst: 3 })
    const a = await player()
    expect(await act(a.c, { t: 'sit', on: true })).toMatchObject({ ok: true })
    expect(await a.c.next('entityUpdate', (m) => m.id === a.id && m.posture === 'sit')).toBeTruthy()
    // A player entering later sees the sitter sitting (worldEnter snapshot), and the sitter gets its spawn plain.
    const b = await player()
    expect(b.enter.entities.find((e) => e.id === a.id)?.posture).toBe('sit')
    expect((await a.c.next('spawn', (m) => m.entity.id === b.id)).entity.posture).toBeUndefined()
    // Five emotes back to back: three pass, the rest are refused rate_limited (not a strike).
    for (let i = 0; i < 5; i++) a.c.send({ t: 'emote', emote: 'laugh' })
    await sleep(150)
    const answers = a.c.queue.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === 'emote')
    expect(answers).toHaveLength(5)
    expect(answers.filter((x) => x.ok)).toHaveLength(3)
    expect(answers.filter((x) => x.reason === 'rate_limited')).toHaveLength(2)
    expect(a.c.isClosed).toBe(false)
    await b.c.next('emote', (m) => m.id === a.id && m.emote === 'laugh')
    // A loot toss with a fractional server time still sends an integer droppedAt (the validator would drop the spawn).
    const at = s.ctx.world.players.get(a.id)!.pos
    const it = s.ctx.gameplay.spawnGroundItem('ITEM_ETC_HP_POTION_01', 1, 0, [at[0] + 1, at[1], at[2]], null, Date.now() + 0.25, null, null, [at[0], at[1], at[2]])
    const spawn = await a.c.next('spawn', (m) => m.entity.id === it.id)
    expect(Number.isInteger(spawn.entity.droppedAt)).toBe(true)
    expect(spawn.entity.dropFrom).toEqual([at[0], at[1], at[2]])
    a.c.close()
    b.c.close()
    await Promise.all([a.c.closed, b.c.closed])
  })
})
