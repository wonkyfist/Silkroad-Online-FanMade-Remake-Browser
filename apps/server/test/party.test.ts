/**
 * Party server units (docs/QUESTS.md §4 and §7 lane D; lane PT-S): invite / respond / leave / kick / leader / settings
 * and their reasons, the offline grace, invite expiry, vitals, the §4.2 EXP share (the worked example 10/10/12 +
 * Yeoha 235 -> 88/88/106), quest credit, share-mode round-robin loot, the free-mode party owner window and the
 * share-mode gold split, and sameParty.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PARTY_INVITE_MS, PARTY_MAX, PARTY_OFFLINE_GRACE_MS, parseServerMessage, type ClientMessage, type GameplayRequest, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { levelShares, partyPool, splitGold } from '../src/party.ts'
import { World, type Mob, type Player } from '../src/world.ts'
import { testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, mob, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const YEOHA = mob('MOB_CH_YEOHA', { name: 'Yeoha', level: 11, exp: 235, spExp: 100, hp: 500 })

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

interface P {
  p: Player
  inbox: ServerMessage[]
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'sro-party-'))
  const config = { ...testConfig(root), rng: seeded(3) }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG, YEOHA], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: NPCS, shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(3) })
  const party = gameplay.party
  let n = 0
  const charIds: number[] = []
  /** A new character in the world (every player knows every other: interest is not under test). */
  const enter = (pos: Vec3 = [0, 0, 0], level = 1): P => {
    const acc = store.createAccount(`ptacc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Member${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    charIds.push(row.id)
    return rejoin(row.id, pos, level)
  }
  /** (Re-)enters an existing character: a new entity, as after a relog. */
  const rejoin = (characterId: number, pos: Vec3 = [0, 0, 0], level = 1): P => {
    const row = store.characterById(characterId)!
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    p.level = level
    p.progress = { ...p.progress, level }
    for (const q of world.players.values()) {
      q.known.add(p.id)
      p.known.add(q.id)
    }
    return { p, inbox }
  }
  const leave = (x: P) => {
    world.remove(x.p.id)
    gameplay.forget(x.p)
  }
  const req = (x: P, msg: ClientMessage, now = Date.now()) => {
    const before = x.inbox.length
    gameplay.request(x.p, msg as Extract<ClientMessage, { t: GameplayRequest }>, now)
    const res = x.inbox.slice(before).filter((m): m is Msg<'actionResult'> => m.t === 'actionResult')
    expect(res.length, msg.t).toBe(1)
    return res[0]
  }
  /** a invites b and b accepts. */
  const form = (a: P, b: P, opts: { exp?: 'free' | 'share'; items?: 'free' | 'share' } = {}) => {
    expect(req(a, { t: 'partyInvite', target: b.p.id, ...opts })).toMatchObject({ ok: true })
    expect(req(b, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: true })
  }
  const mobAt = (pos: Vec3, def = YEOHA): Mob => gameplay.createMob(def, 'normal', pos[0], pos[2], pos[1], null, Date.now())
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, world, gameplay, party, enter, rejoin, leave, req, form, mobAt }
}

const of = <T extends ServerMessage['t']>(x: P, t: T) => x.inbox.filter((m): m is Msg<T> => m.t === t)
const lastParty = (x: P) => of(x, 'party').at(-1)?.party
const events = (x: P) => of(x, 'partyEvent').map((e) => `${e.event}:${e.name}`)
const wire = (m: unknown) => {
  const r = parseServerMessage(JSON.stringify(m))
  if (!r.ok) throw new Error(r.error)
  return r.msg
}

describe('the §4.2 formula', () => {
  it('pool = E × (1 + 0.1 × (n − 1)); level-weighted: 10/10/12 on a 235-EXP Yeoha -> 88/88/106', () => {
    expect(partyPool(235, 3)).toBeCloseTo(282)
    expect(partyPool(100, 8)).toBeCloseTo(170)
    expect(partyPool(100, 1)).toBe(100)
    expect(levelShares(partyPool(235, 3), [10, 10, 12])).toEqual([88, 88, 106])
  })

  it('splitGold: equal floor shares, the picker keeps the remainder', () => {
    expect(splitGold(100, 3)).toEqual({ share: 33, keep: 34 })
    expect(splitGold(10, 1)).toEqual({ share: 0, keep: 10 })
    expect(splitGold(2, 3)).toEqual({ share: 0, keep: 2 })
  })
})

describe('invite and respond', () => {
  it('invite -> partyInvited; accept -> both get the party (inviter leads, default modes share/free); the frames parse', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    expect(h.req(a, { t: 'partyInvite', target: b.p.id })).toMatchObject({ ok: true })
    const inv = of(b, 'partyInvited')[0]
    expect(inv).toEqual({ t: 'partyInvited', inviter: a.p.id, name: a.p.name, level: 1, exp: 'share', items: 'free', expiresInMs: PARTY_INVITE_MS })
    expect(wire(inv)).toEqual(inv)
    expect(h.req(b, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: true })
    for (const x of [a, b]) {
      const st = lastParty(x)!
      expect(st).toMatchObject({ leader: a.p.characterId, exp: 'share', items: 'free' })
      expect(st.members.map((m) => [m.characterId, m.entity])).toEqual([
        [a.p.characterId, a.p.id],
        [b.p.characterId, b.p.id],
      ])
      expect(st.members[0]).toMatchObject({ name: a.p.name, model: a.p.model, level: 1, hp: a.p.maxHp, maxHp: a.p.maxHp, pos: [0, 0] })
      expect(wire({ t: 'party', party: st })).toEqual({ t: 'party', party: st })
      expect(events(x)).toContain(`joined:${b.p.name}`)
    }
    expect(h.party.sameParty(a.p, b.p)).toBe(true)
  })

  it('invite modes are used when the invite creates the party', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    h.form(a, b, { exp: 'free', items: 'share' })
    expect(lastParty(a)).toMatchObject({ exp: 'free', items: 'share' })
  })

  it('invite reasons: yourself, unknown, not a player, in a party, already invited, not the leader, full', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const c = h.enter()
    expect(h.req(a, { t: 'partyInvite', target: a.p.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(a, { t: 'partyInvite', target: 99_999 })).toMatchObject({ ok: false, reason: 'not_found' })
    const m = h.mobAt([1, 0, 1], MANGNYANG)
    a.p.known.add(m.id)
    expect(h.req(a, { t: 'partyInvite', target: m.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    b.p.known.delete(c.p.id)
    expect(h.req(b, { t: 'partyInvite', target: c.p.id })).toMatchObject({ ok: false, reason: 'not_found' })
    b.p.known.add(c.p.id)
    expect(h.req(a, { t: 'partyInvite', target: c.p.id })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'partyInvite', target: c.p.id })).toMatchObject({ ok: false, reason: 'cooldown' })
    h.form(a, b)
    expect(h.req(c, { t: 'partyInvite', target: b.p.id })).toMatchObject({ ok: false, reason: 'in_party' })
    const d = h.enter()
    expect(h.req(b, { t: 'partyInvite', target: d.p.id })).toMatchObject({ ok: false, reason: 'not_leader' })
    // fill the party to PARTY_MAX
    h.req(c, { t: 'partyRespond', inviter: a.p.id, accept: true })
    const more: P[] = []
    while (h.party.partyOf(a.p)!.members.length < PARTY_MAX) {
      const x = h.enter()
      h.form(a, x)
      more.push(x)
    }
    expect(h.req(a, { t: 'partyInvite', target: d.p.id })).toMatchObject({ ok: false, reason: 'party_full' })
  })

  it('respond: no_invite, a wrong inviter, decline -> declined to the inviter; a dead player may answer', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    expect(h.req(b, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
    h.req(a, { t: 'partyInvite', target: b.p.id })
    expect(h.req(b, { t: 'partyRespond', inviter: b.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
    h.gameplay.gmKill(b.p)
    expect(h.req(b, { t: 'partyRespond', inviter: a.p.id, accept: false })).toMatchObject({ ok: true })
    expect(events(a)).toEqual([`declined:${b.p.name}`])
    expect(h.party.partyOf(a.p)).toBeUndefined()
    expect(h.req(b, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
    // a dead player cannot invite
    expect(h.req(b, { t: 'partyInvite', target: a.p.id })).toMatchObject({ ok: false, reason: 'dead' })
  })

  it('an invite expires after 30 s: both sides get expired, the answer is no_invite', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const t0 = Date.now()
    h.req(a, { t: 'partyInvite', target: b.p.id }, t0)
    h.party.tick(t0 + PARTY_INVITE_MS - 1)
    expect(events(a)).toEqual([])
    h.party.tick(t0 + PARTY_INVITE_MS)
    expect(events(a)).toEqual([`expired:${b.p.name}`])
    expect(events(b)).toEqual([`expired:${a.p.name}`])
    expect(h.req(b, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
  })

  it('a leader invites a third member into the existing party (its modes)', () => {
    const h = harness()
    const [a, b, c] = [h.enter(), h.enter(), h.enter()]
    h.form(a, b, { items: 'share' })
    expect(h.req(a, { t: 'partyInvite', target: c.p.id, items: 'free' })).toMatchObject({ ok: true })
    expect(of(c, 'partyInvited')[0]).toMatchObject({ items: 'share' })
    h.req(c, { t: 'partyRespond', inviter: a.p.id, accept: true })
    expect(lastParty(b)!.members.map((m) => m.name)).toEqual([a.p.name, b.p.name, c.p.name])
  })
})

describe('leave, kick, leader, settings', () => {
  it('a leaving leader passes the lead to the earliest-joined online member; the last two -> disbanded', () => {
    const h = harness()
    const [a, b, c] = [h.enter(), h.enter(), h.enter()]
    h.form(a, b)
    h.form(a, c)
    expect(h.req(a, { t: 'partyLeave' })).toMatchObject({ ok: true })
    expect(lastParty(a)).toBeNull()
    expect(lastParty(b)).toMatchObject({ leader: b.p.characterId })
    expect(lastParty(b)!.members).toHaveLength(2)
    expect(events(c).slice(-2)).toEqual([`left:${a.p.name}`, `leader:${b.p.name}`])
    expect(h.req(c, { t: 'partyLeave' })).toMatchObject({ ok: true })
    expect(events(b).slice(-2)).toEqual([`left:${c.p.name}`, `disbanded:${c.p.name}`])
    expect(lastParty(b)).toBeNull()
    expect(h.party.parties.size).toBe(0)
    expect(h.req(b, { t: 'partyLeave' })).toMatchObject({ ok: false, reason: 'not_in_party' })
  })

  it('the lead skips offline members', () => {
    const h = harness()
    const [a, b, c] = [h.enter(), h.enter(), h.enter()]
    h.form(a, b)
    h.form(a, c)
    h.leave(b)
    h.req(a, { t: 'partyLeave' })
    expect(lastParty(c)).toMatchObject({ leader: c.p.characterId })
  })

  it('kick: leader only, not yourself, a member; the kicked member gets kicked + null', () => {
    const h = harness()
    const [a, b, c, d] = [h.enter(), h.enter(), h.enter(), h.enter()]
    expect(h.req(a, { t: 'partyKick', member: b.p.characterId })).toMatchObject({ ok: false, reason: 'not_in_party' })
    h.form(a, b)
    h.form(a, c)
    expect(h.req(b, { t: 'partyKick', member: c.p.characterId })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(h.req(a, { t: 'partyKick', member: a.p.characterId })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(a, { t: 'partyKick', member: d.p.characterId })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.req(a, { t: 'partyKick', member: c.p.characterId })).toMatchObject({ ok: true })
    expect(events(c).slice(-1)).toEqual([`kicked:${c.p.name}`])
    expect(lastParty(c)).toBeNull()
    expect(events(b).slice(-1)).toEqual([`kicked:${c.p.name}`])
    expect(lastParty(b)!.members.map((m) => m.characterId)).toEqual([a.p.characterId, b.p.characterId])
  })

  it('leader transfer: leader only, a member, online; settings: leader only, both modes', () => {
    const h = harness()
    const [a, b, c] = [h.enter(), h.enter(), h.enter()]
    expect(h.req(a, { t: 'partySettings', exp: 'free' })).toMatchObject({ ok: false, reason: 'not_in_party' })
    h.form(a, b)
    h.form(a, c)
    expect(h.req(b, { t: 'partyLeader', member: c.p.characterId })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(h.req(a, { t: 'partyLeader', member: a.p.characterId })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(a, { t: 'partyLeader', member: 424_242 })).toMatchObject({ ok: false, reason: 'not_found' })
    h.leave(c)
    expect(h.req(a, { t: 'partyLeader', member: c.p.characterId })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(a, { t: 'partyLeader', member: b.p.characterId })).toMatchObject({ ok: true })
    expect(lastParty(a)).toMatchObject({ leader: b.p.characterId })
    expect(events(a).slice(-1)).toEqual([`leader:${b.p.name}`])
    expect(h.req(a, { t: 'partySettings', exp: 'free' })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(h.req(b, { t: 'partySettings', exp: 'free', items: 'share' })).toMatchObject({ ok: true })
    expect(lastParty(a)).toMatchObject({ exp: 'free', items: 'share' })
    expect(events(a).slice(-1)).toEqual([`settings:${b.p.name}`])
  })
})

describe('offline grace', () => {
  it('a disconnect marks the member offline; entering again within 120 s keeps it; after 120 s it is removed', () => {
    const h = harness()
    const [a, b, c] = [h.enter(), h.enter(), h.enter()]
    h.form(a, b)
    h.form(a, c)
    const t0 = Date.now()
    h.leave(b)
    expect(events(a).slice(-1)).toEqual([`offline:${b.p.name}`])
    const st = lastParty(a)!
    expect(st.members[1]).toMatchObject({ characterId: b.p.characterId, entity: null })
    expect(st.members[1].pos).toBeUndefined()
    expect(wire({ t: 'party', party: st })).toBeTruthy()
    // back within the grace: a new entity, the party comes with the enter sequence
    const b2 = h.rejoin(b.p.characterId)
    h.gameplay.sendEnter(b2.p)
    expect(b2.inbox.map((m) => m.t).slice(-1)).toEqual(['party'])
    expect(lastParty(b2)!.members[1]).toMatchObject({ characterId: b.p.characterId, entity: b2.p.id })
    expect(events(a).slice(-1)).toEqual([`online:${b.p.name}`])
    expect(events(b2)).toEqual([])
    // gone for good: removed after the grace
    h.leave(c)
    h.party.tick(t0 + PARTY_OFFLINE_GRACE_MS - 1000)
    expect(lastParty(a)!.members).toHaveLength(3)
    h.party.tick(Date.now() + PARTY_OFFLINE_GRACE_MS)
    expect(lastParty(a)!.members.map((m) => m.characterId)).toEqual([a.p.characterId, b.p.characterId])
    expect(h.party.partyOf(c.p.characterId)).toBeUndefined()
  })

  it('an offline leader keeps the lead until removed; a party whose other member expires is disbanded', () => {
    const h = harness()
    const [a, b] = [h.enter(), h.enter()]
    h.form(a, b)
    h.leave(a)
    expect(lastParty(b)).toMatchObject({ leader: a.p.characterId })
    h.party.tick(Date.now() + PARTY_OFFLINE_GRACE_MS + 1)
    expect(events(b).slice(-2)).toEqual([`left:${a.p.name}`, `disbanded:${a.p.name}`])
    expect(lastParty(b)).toBeNull()
    expect(h.party.parties.size).toBe(0)
  })

  it('leaving the world ends pending invites both ways', () => {
    const h = harness()
    const [a, b] = [h.enter(), h.enter()]
    h.req(a, { t: 'partyInvite', target: b.p.id })
    h.leave(a)
    expect(events(b)).toEqual([`expired:${a.p.name}`])
    expect(h.party.invites.size).toBe(0)
  })
})

describe('vitals', () => {
  it('changed HP/MP/dead go out at most every 500 ms; positions at 1 Hz; the frames parse', () => {
    const h = harness()
    const [a, b] = [h.enter(), h.enter()]
    h.form(a, b)
    const t0 = Date.now() + 10_000
    h.party.tick(t0)
    expect(of(a, 'partyVitals')).toEqual([])
    b.p.hp = 50
    h.party.tick(t0 + 100)
    expect(of(a, 'partyVitals')).toEqual([])
    h.party.tick(t0 + 500)
    const v = of(a, 'partyVitals')
    expect(v).toEqual([{ t: 'partyVitals', members: [{ characterId: b.p.characterId, hp: 50 }] }])
    expect(of(b, 'partyVitals')).toEqual(v)
    expect(wire(v[0])).toEqual(v[0])
    // a move shows at the next 1 Hz step
    b.p.pos = [20, 0, 5]
    h.party.tick(t0 + 1000)
    expect(of(a, 'partyVitals').at(-1)).toEqual({ t: 'partyVitals', members: [{ characterId: b.p.characterId, pos: [20, 5] }] })
    h.gameplay.gmKill(b.p)
    h.party.tick(t0 + 1500)
    expect(of(a, 'partyVitals').at(-1)).toEqual({ t: 'partyVitals', members: [{ characterId: b.p.characterId, hp: 0, dead: true }] })
  })
})

describe('kills (§4.2, §4.3)', () => {
  it('no party involved -> null (the solo rule)', () => {
    const h = harness()
    const a = h.enter()
    const m = h.mobAt([1, 0, 1])
    m.damage.set(a.p.id, 100)
    expect(h.party.killShares(m, Date.now())).toBeNull()
  })

  it('share mode: the worked example 10/10/12 on a Yeoha (235 EXP) -> 88/88/106; every eligible member gets credit', () => {
    const h = harness()
    const a = h.enter([0, 0, 0], 10)
    const b = h.enter([30, 0, 0], 10)
    const c = h.enter([0, 0, 40], 12)
    const far = h.enter([200, 0, 0], 12)
    h.form(a, b)
    h.form(a, c)
    h.form(a, far)
    const m = h.mobAt([1, 0, 1])
    m.damage.set(a.p.id, 500)
    const k = h.party.killShares(m, Date.now())!
    expect(k.shares.get(a.p.id)!.exp).toBe(88)
    expect(k.shares.get(b.p.id)!.exp).toBe(88)
    expect(k.shares.get(c.p.id)!.exp).toBe(106)
    expect(k.shares.has(far.p.id)).toBe(false)
    // SP-EXP the same way: 100 × 1.2 = 120 -> 37.5/37.5/45
    expect([a, b, c].map((x) => k.shares.get(x.p.id)!.spExp)).toEqual([38, 38, 45])
    expect([...k.credit].sort()).toEqual([a.p.id, b.p.id, c.p.id].sort())
  })

  it('share mode: a dead member and an offline member get nothing; a far damage dealer stays eligible', () => {
    const h = harness()
    const [a, b, c] = [h.enter([0, 0, 0], 5), h.enter([100, 0, 0], 5), h.enter([0, 0, 0], 5)]
    const d = h.enter([0, 0, 0], 5)
    h.form(a, b)
    h.form(a, c)
    h.form(a, d)
    h.gameplay.gmKill(c.p)
    h.leave(d)
    const m = h.mobAt([1, 0, 1])
    m.damage.set(a.p.id, 10)
    m.damage.set(b.p.id, 10) // b hit it from range, then walked 100 m away
    const k = h.party.killShares(m, Date.now())!
    expect([...k.shares.keys()].sort()).toEqual([a.p.id, b.p.id].sort())
    expect(k.shares.get(a.p.id)!.exp).toBe(Math.round((235 * 1.1) / 2))
    expect(k.credit.has(c.p.id)).toBe(false)
  })

  it('free mode splits by damage like the solo rule, with party credit for members in range; mixed with a solo player', () => {
    const h = harness()
    const [a, b, solo] = [h.enter(), h.enter([10, 0, 0]), h.enter()]
    h.form(a, b, { exp: 'free' })
    const m = h.mobAt([1, 0, 1])
    m.damage.set(a.p.id, 30)
    m.damage.set(solo.p.id, 70)
    const k = h.party.killShares(m, Date.now())!
    expect(k.shares.get(a.p.id)).toEqual({ exp: Math.round((235 * 30) / 100), spExp: 30 })
    expect(k.shares.get(solo.p.id)).toEqual({ exp: Math.round((235 * 70) / 100), spExp: 70 })
    expect(k.shares.has(b.p.id)).toBe(false)
    expect([...k.credit].sort()).toEqual([a.p.id, b.p.id, solo.p.id].sort())
    // the solo player did the most damage: its loot, no party window
    expect(k.lootOwners.next()).toEqual({ player: solo.p, party: null })
  })

  it('free mode loot: the top dealer of the top group, with ownerParty; members share the owner window', () => {
    const h = harness()
    const [a, b, other] = [h.enter(), h.enter(), h.enter()]
    h.form(a, b)
    const party = h.party.partyOf(a.p)!
    const m = h.mobAt([1, 0, 1])
    m.damage.set(a.p.id, 10)
    m.damage.set(b.p.id, 30)
    const k = h.party.killShares(m, Date.now())!
    expect(k.lootOwners.next()).toEqual({ player: b.p, party: party.id })
    const item = h.gameplay.spawnGroundItem('ITEM_CH_BLADE_02_A', 1, 0, [0, 0, 0], b.p, Date.now(), null, party.id)
    for (const x of [a, b, other]) x.p.known.add(item.id)
    expect(h.req(other, { t: 'pickup', id: item.id })).toMatchObject({ ok: false, reason: 'not_owner' })
    expect(h.req(a, { t: 'pickup', id: item.id })).toMatchObject({ ok: true })
    expect(h.store.loadInventory(a.p.characterId).bag.some((i) => i?.code === 'ITEM_CH_BLADE_02_A')).toBe(true)
  })

  it('share mode loot: round robin over the eligible members in join order, carried from kill to kill; only the owner may take it', () => {
    const h = harness()
    const [a, b, c] = [h.enter(), h.enter(), h.enter()]
    const away = h.enter([300, 0, 0])
    h.form(a, b, { items: 'share' })
    h.form(a, away)
    h.form(a, c)
    const party = h.party.partyOf(a.p)!
    const kill = () => {
      const m = h.mobAt([1, 0, 1])
      m.damage.set(a.p.id, 10)
      return h.party.killShares(m, Date.now())!
    }
    const k1 = kill()
    const owners1 = [k1.lootOwners.next(), k1.lootOwners.next()].map((o) => o.player?.name)
    const k2 = kill()
    const owners2 = [k2.lootOwners.next(), k2.lootOwners.next()].map((o) => o.player?.name)
    expect([...owners1, ...owners2]).toEqual([a.p.name, b.p.name, c.p.name, a.p.name])
    expect(k2.lootOwners.next()).toEqual({ player: b.p, party: party.id })
    // the round-robin owner alone may take an item (share mode)
    const item = h.gameplay.spawnGroundItem('ITEM_CH_BLADE_02_A', 1, 0, [0, 0, 0], c.p, Date.now(), null, party.id)
    for (const x of [a, b, c]) x.p.known.add(item.id)
    expect(h.req(a, { t: 'pickup', id: item.id })).toMatchObject({ ok: false, reason: 'not_owner' })
    expect(h.req(c, { t: 'pickup', id: item.id })).toMatchObject({ ok: true })
  })

  it('share mode gold: split evenly among the members within 60 m of the picker; the picker keeps the remainder', () => {
    const h = harness()
    const [a, b, c] = [h.enter(), h.enter([20, 0, 0]), h.enter()]
    const away = h.enter([200, 0, 0])
    h.form(a, b, { items: 'share' })
    h.form(a, c)
    h.form(a, away)
    h.gameplay.gmKill(c.p) // dead members get no share
    const party = h.party.partyOf(a.p)!
    const gold = h.gameplay.spawnGroundItem('ITEM_ETC_GOLD_01', 101, 0, [0, 0, 0], b.p, Date.now(), null, party.id)
    a.p.known.add(gold.id)
    // gold of the party may be taken by any member, even in share mode
    expect(h.req(a, { t: 'pickup', id: gold.id })).toMatchObject({ ok: true })
    expect(h.store.loadInventory(a.p.characterId).gold).toBe(51)
    expect(h.store.loadInventory(b.p.characterId).gold).toBe(50)
    expect(h.store.loadInventory(c.p.characterId).gold).toBe(0)
    expect(h.store.loadInventory(away.p.characterId).gold).toBe(0)
    expect(b.p.gold).toBe(50)
    expect(of(b, 'statsDelta').at(-1)).toEqual({ t: 'statsDelta', stats: { gold: 50 } })
    // free mode: no split
    h.req(a, { t: 'partySettings', items: 'free' })
    const g2 = h.gameplay.spawnGroundItem('ITEM_ETC_GOLD_01', 40, 0, [0, 0, 0], a.p, Date.now(), null, party.id)
    a.p.known.add(g2.id)
    h.req(a, { t: 'pickup', id: g2.id })
    expect(h.store.loadInventory(a.p.characterId).gold).toBe(91)
    expect(h.store.loadInventory(b.p.characterId).gold).toBe(50)
  })

  it('through mobDied: every eligible member gets its statsDelta gain and the quest credit fan-out', () => {
    const h = harness()
    const [a, b] = [h.enter([0, 0, 0], 1), h.enter([5, 0, 0], 1)]
    h.form(a, b)
    const credited: number[][] = []
    const quests = h.gameplay.quests as unknown as { mobDied?: (m: Mob, now: number, credit: ReadonlySet<number>) => void }
    const prev = quests.mobDied
    quests.mobDied = (_m, _now, credit) => {
      credited.push([...credit].sort())
    }
    try {
      const m = h.mobAt([1, 0, 1], MANGNYANG)
      m.damage.set(a.p.id, 20)
      m.hp = 0
      h.gameplay.mobDied(m, Date.now(), true)
    } finally {
      quests.mobDied = prev
    }
    // Mangnyang: 40 EXP / 30 SP-EXP; pool ×1.1 split 1:1 -> 22 / 17 (16.5 rounds up) each
    for (const x of [a, b]) expect(of(x, 'statsDelta').find((d) => d.gain)?.gain).toMatchObject({ exp: 22, spExp: 17 })
    expect(credited).toEqual([[a.p.id, b.p.id].sort()])
  })
})

describe('sameParty', () => {
  it('true only for two members of one party', () => {
    const h = harness()
    const [a, b, c] = [h.enter(), h.enter(), h.enter()]
    expect(h.party.sameParty(a.p, b.p)).toBe(false)
    h.form(a, b)
    expect(h.party.sameParty(a.p, b.p)).toBe(true)
    expect(h.party.sameParty(a.p, c.p)).toBe(false)
    expect(h.party.sameParty(c.p, c.p)).toBe(false)
  })
})
