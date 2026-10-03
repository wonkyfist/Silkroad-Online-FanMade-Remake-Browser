/**
 * Adversarial hunt, lens "party" (waves 4/5): parties, their kill/loot rules, the quest encounter's owner group, and the
 * GM content editors (nest / npc / content commands, /api/gm/quests).
 *
 * Tests named "BUG:" reproduce a real defect: they FAIL on the current code and their assertions describe the correct
 * behaviour. Every other test pins an attack the code already refuses (a regression guard).
 *
 * Two harnesses:
 * - a unit harness (real Gameplay + PartyManager + QuestEngine on FlatNav, synthetic content), like party.test.ts;
 * - a real server with synthetic content over WebSockets and HTTP, like editors-e2e.test.ts.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ClientMessage,
  type GameplayRequest,
  type NpcDef,
  type QuestDef,
  type QuestFile,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { AUTHORED_NEST_ID_MIN } from '../src/editors/overrides.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { QuestBook } from '../src/quests/book.ts'
import { questRefs } from '../src/quests/engine.ts'
import { World, type Mob, type Npc, type Player } from '../src/world.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, TIGER, contentFiles, mob, nest, seeded } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, testConfig, type TestServer } from './helpers.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

// ---- unit harness: party + quests on synthetic content ---------------------------------------------------------

const YEOHA = mob('MOB_CH_YEOHA', { name: 'Yeoha', level: 11, exp: 235, spExp: 100, hp: 500 })
const BOSS = mob('MOB_CH_BOSS', { name: 'Boss', level: 5, hp: 1000, rarity: 'unique', exp: 5000 })
const CHIEF: NpcDef = { code: 'NPC_T_CHIEF', name: 'Chief', x: 30, z: 0, yaw: 0, world: 'jangan', model: null, provenance: 'client' }

/** A JG_025-shaped finale: a party quest whose Binding Bell summons a unique at the shrine. */
const BELL_QUEST: QuestDef = {
  id: 'T_BELL',
  title: 'The Bell',
  kind: 'main',
  level: 1,
  giver: 'NPC_T_CHIEF',
  turnIn: 'NPC_T_CHIEF',
  summary: 'Ring the bell at the shrine and defeat what comes.',
  party: true,
  giveOnAccept: [{ item: 'QITEM_BELL', count: 1 }],
  objectives: [
    { id: 'bell', type: 'useItem', item: 'QITEM_BELL', location: 'LOC_SHRINE', consume: false, text: 'It rings.', encounter: { mob: BOSS.code, count: 1, hpMul: 0.05, expMul: 0.1, despawnSec: 600, cooldownSec: 120 } },
    { id: 'boss', type: 'kill', mobs: [BOSS.code], count: 1, after: 'bell' },
    { id: 'seal', type: 'collect', item: 'QITEM_SEAL', count: 1, after: 'bell', from: [{ mob: BOSS.code, chance: 1 }] },
  ],
  rewards: { exp: 10, sp: 1, gold: 10 },
  dialog: { offer: 'Ring it.', progress: 'Well?', complete: 'Thanks.' },
}
const QFILE: QuestFile = {
  schema: 1, kind: 'quests', id: 'abuse', title: 'Abuse line', world: 'jangan',
  items: [{ code: 'QITEM_BELL', name: 'Bell' }, { code: 'QITEM_SEAL', name: 'Seal' }],
  locations: [{ id: 'LOC_SHRINE', name: 'Shrine', x: -100, z: 0, radius: 10 }],
  quests: [BELL_QUEST],
}

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

interface P {
  p: Player
  inbox: ServerMessage[]
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'sro-abuse-party-'))
  const config = { ...testConfig(root), rng: seeded(5) }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG, YEOHA, BOSS], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: [...NPCS, CHIEF], shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(5) })
  const book = QuestBook.fromFiles([{ name: 'abuse.json', json: QFILE }], { refs: questRefs(gameplay) })
  expect(book.files.flatMap((f) => f.issues).filter((i) => i.severity === 'error')).toEqual([])
  gameplay.quests.setContent(book)
  const chief: Npc = { kind: 'npc', id: world.newId(), code: CHIEF.code, name: 'Chief', pos: [30, 0, 0], yaw: 0 }
  world.addEntity(chief)
  const party = gameplay.party
  let n = 0
  const enter = (pos: Vec3 = [0, 0, 0], level = 1): P => {
    const acc = store.createAccount(`abpacc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Abuser${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    p.level = level
    p.progress = { ...p.progress, level }
    p.known.add(chief.id)
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
  const form = (a: P, b: P, opts: { exp?: 'free' | 'share'; items?: 'free' | 'share' } = {}) => {
    expect(req(a, { t: 'partyInvite', target: b.p.id, ...opts })).toMatchObject({ ok: true })
    expect(req(b, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: true })
  }
  const accept = (x: P, quest = 'T_BELL') => {
    world.warp(x.p, 31, 0, 0)
    return req(x, { t: 'questAccept', npc: chief.id, quest })
  }
  const mobAt = (pos: Vec3, def = YEOHA): Mob => gameplay.createMob(def, 'normal', pos[0], pos[2], pos[1], null, Date.now())
  const encounterMobs = () => [...world.mobs.values()].filter((m) => m.encounter && m.ai !== 'dead')
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, world, gameplay, party, enter, leave, req, form, accept, mobAt, encounterMobs, engine: gameplay.quests }
}

const of = <T extends ServerMessage['t']>(x: P, t: T) => x.inbox.filter((m): m is Msg<T> => m.t === t)

describe('party lens: quest encounter owner group', () => {
  it('BUG: after an outsider (or anyone the ringer is not credited with) kills the summoned unique, the ringer may re-summon it at once, forever (unlimited unique farm)', () => {
    const h = harness()
    const ringer = h.enter()
    const farmer = h.enter([-95, 0, 0], 5) // not in the ringer's party, has no quest
    expect(h.accept(ringer)).toMatchObject({ ok: true })
    h.world.warp(ringer.p, -100, 0, 3)
    const t0 = Date.now()
    const ring = (now: number) => h.req(ringer, { t: 'questUseItem', quest: 'T_BELL', objective: 'bell' }, now)
    expect(ring(t0)).toMatchObject({ ok: true })
    const [boss] = h.encounterMobs()
    expect(boss).toBeDefined()
    // the farmer alone damages and kills it: loot and EXP are the farmer's; the ringer gets no credit
    boss.damage.set(farmer.p.id, 50)
    h.gameplay.mobDied(boss, t0 + 5_000, true)
    expect(h.engine.logOf(ringer.p).active.get('T_BELL')!.counts.boss).toBe(0)
    const farmerGain = of(farmer, 'statsDelta').filter((m) => m.gain).at(-1)?.gain?.exp ?? 0
    expect(farmerGain).toBeGreaterThan(0)
    // Correct: an encounter that ended (killed by anyone) cannot be summoned again straight away: the owners wait the
    // encounter's cooldownSec (120 s) like after an unkilled despawn. Today the bell answers ok and a second unique
    // appears, and this repeats without limit (each kill = a unique's EXP and drops for the farmer).
    const again = ring(t0 + 6_000)
    expect(again, 'the bell must refuse a re-summon right after the encounter was killed').toMatchObject({ ok: false })
    expect(h.encounterMobs()).toHaveLength(0)
  })

  it('BUG: abandon + re-accept wipes the encounter cooldown after an unkilled despawn (the bell summons again at once)', () => {
    const h = harness()
    const ringer = h.enter()
    expect(h.accept(ringer)).toMatchObject({ ok: true })
    h.world.warp(ringer.p, -100, 0, 3)
    const t0 = Date.now()
    const ring = (now: number) => h.req(ringer, { t: 'questUseItem', quest: 'T_BELL', objective: 'bell' }, now)
    expect(ring(t0)).toMatchObject({ ok: true })
    // unkilled: it despawns after 600 s and the owners must wait cooldownSec (120 s)
    h.engine.tick(t0 + 600_000)
    expect(h.encounterMobs()).toHaveLength(0)
    expect(ring(t0 + 601_000)).toMatchObject({ ok: false, reason: 'cooldown' })
    // abandon and take the quest again (giveOnAccept hands out a new bell)
    expect(h.req(ringer, { t: 'questAbandon', quest: 'T_BELL' })).toMatchObject({ ok: true })
    expect(h.accept(ringer)).toMatchObject({ ok: true })
    h.world.warp(ringer.p, -100, 0, 3)
    // Correct: the cooldown belongs to the character, not to the quest instance; abandoning must not reset it.
    expect(ring(t0 + 602_000), 'abandon must not clear the encounter cooldown').toMatchObject({ ok: false, reason: 'cooldown' })
    expect(h.encounterMobs()).toHaveLength(0)
  })

  it('refused: a party member cannot summon a second copy while the group encounter lives, even after leaving the party', () => {
    const h = harness()
    const [a, b] = [h.enter(), h.enter()]
    h.form(a, b)
    for (const x of [a, b]) expect(h.accept(x)).toMatchObject({ ok: true })
    h.world.warp(a.p, -100, 0, 0)
    h.world.warp(b.p, -98, 0, 2)
    expect(h.req(a, { t: 'questUseItem', quest: 'T_BELL', objective: 'bell' })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'partyLeave' })).toMatchObject({ ok: true })
    // b's bell objective was completed by the party use; the live encounter still lists b as an owner
    expect(h.req(b, { t: 'questUseItem', quest: 'T_BELL', objective: 'bell' })).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(h.encounterMobs()).toHaveLength(1)
  })
})

describe('party lens: invites and leader-only actions', () => {
  it('refused: self invite, in_party target, a second pending invite, a forged or stale inviter, non-leader kick/leader/settings/invite', () => {
    const h = harness()
    const [a, b, c, d] = [h.enter(), h.enter(), h.enter(), h.enter()]
    expect(h.req(a, { t: 'partyInvite', target: a.p.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(h.req(a, { t: 'partyInvite', target: c.p.id })).toMatchObject({ ok: true })
    // c already holds a's invite: d cannot stack a second popup on c
    expect(h.req(d, { t: 'partyInvite', target: c.p.id })).toMatchObject({ ok: false, reason: 'cooldown' })
    // a forged inviter id (d's entity) does not accept a's invite
    expect(h.req(c, { t: 'partyRespond', inviter: d.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
    expect(h.party.partyOf(c.p)).toBeUndefined()
    h.form(a, b)
    // c's pending invite is from the leader a: still valid
    expect(h.req(c, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: true })
    expect(h.req(d, { t: 'partyInvite', target: a.p.id })).toMatchObject({ ok: false, reason: 'in_party' })
    // leader-only actions by a member
    expect(h.req(b, { t: 'partyKick', member: c.p.characterId })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(h.req(b, { t: 'partyLeader', member: b.p.characterId })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(h.req(b, { t: 'partySettings', items: 'share' })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(h.req(b, { t: 'partyInvite', target: d.p.id })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(h.party.partyOf(a.p)!.items).toBe('free')
    expect(h.party.partyOf(a.p)!.members.map((m) => m.characterId)).toEqual([a.p.characterId, b.p.characterId, c.p.characterId])
  })

  it('refused: accepting an invite whose inviter left the world, and one whose inviter is no longer the leader', () => {
    const h = harness()
    const [a, b, c, d] = [h.enter(), h.enter(), h.enter(), h.enter()]
    expect(h.req(a, { t: 'partyInvite', target: c.p.id })).toMatchObject({ ok: true })
    h.leave(a)
    expect(h.req(c, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
    // b (solo) invites d, then joins c's party as a plain member: the old invite cannot pull d into c's party
    expect(h.req(b, { t: 'partyInvite', target: d.p.id })).toMatchObject({ ok: true })
    h.form(c, b)
    expect(h.req(d, { t: 'partyRespond', inviter: b.p.id, accept: true })).toMatchObject({ ok: false, reason: 'not_leader' })
    expect(h.party.partyOf(d.p)).toBeUndefined()
  })
})

describe('party lens: EXP share, loot and gold', () => {
  it('share mode: dead members and idle members beyond 60 m of the corpse get nothing (no far-away leech)', () => {
    const h = harness()
    const a = h.enter([0, 0, 0], 10)
    const dead = h.enter([2, 0, 0], 10)
    const far = h.enter([62, 0, 0], 1)
    h.form(a, dead)
    h.form(a, far)
    h.gameplay.gmKill(dead.p)
    const m = h.mobAt([1, 0, 1])
    m.damage.set(a.p.id, 100)
    const k = h.party.killShares(m, Date.now())!
    expect([...k.shares.keys()]).toEqual([a.p.id])
    expect(k.shares.get(a.p.id)!.exp).toBe(235)
    expect(k.credit.has(dead.p.id)).toBe(false)
    expect(k.credit.has(far.p.id)).toBe(false)
  })

  it('a kicked member loses the party owner window at once (free mode), and its party chat is refused', () => {
    const h = harness()
    const [a, b] = [h.enter(), h.enter()]
    const c = h.enter()
    h.form(a, b)
    h.form(a, c)
    const party = h.party.partyOf(a.p)!
    const item = h.gameplay.spawnGroundItem('ITEM_CH_BLADE_02_A', 1, 0, [0, 0, 0], a.p, Date.now(), null, party.id)
    for (const x of [a, b, c]) x.p.known.add(item.id)
    expect(h.req(a, { t: 'partyKick', member: b.p.characterId })).toMatchObject({ ok: true })
    expect(h.req(b, { t: 'pickup', id: item.id })).toMatchObject({ ok: false, reason: 'not_owner' })
    expect(h.party.chat(b.p, 'still here?')).toBe(false)
    expect(of(c, 'chat').filter((l) => l.channel === 'party')).toEqual([])
  })

  it('gold split conserves the amount for odd sums (no rounding duplication)', () => {
    const h = harness()
    const [a, b, c] = [h.enter(), h.enter([5, 0, 0]), h.enter([0, 0, 5])]
    h.form(a, b, { items: 'share' })
    h.form(a, c)
    const party = h.party.partyOf(a.p)!
    let total = 0
    for (const amount of [1, 2, 7, 100, 101, 9_999]) {
      const gold = h.gameplay.spawnGroundItem('ITEM_ETC_GOLD_01', amount, 0, [0, 0, 0], a.p, Date.now(), null, party.id)
      a.p.known.add(gold.id)
      expect(h.req(a, { t: 'pickup', id: gold.id })).toMatchObject({ ok: true })
      total += amount
      const sum = [a, b, c].reduce((s, x) => s + h.store.loadInventory(x.p.characterId).gold, 0)
      expect(sum, `after a ${amount} gold pickup`).toBe(total)
    }
  })

  it('BUG: the leader can take a share-mode (round-robin) item assigned to another member by flipping Items to free-for-all', () => {
    const h = harness()
    const [a, b] = [h.enter(), h.enter([3, 0, 0])]
    h.form(a, b, { items: 'share' })
    const party = h.party.partyOf(a.p)!
    // a kill hands out drops round robin: the first drop is a's, the second b's
    const m = h.mobAt([1, 0, 1])
    m.damage.set(a.p.id, 10)
    const k = h.party.killShares(m, Date.now())!
    expect(k.lootOwners.next().player).toBe(a.p)
    const owner = k.lootOwners.next()
    expect(owner).toEqual({ player: b.p, party: party.id })
    const item = h.gameplay.spawnGroundItem('ITEM_CH_BLADE_02_A', 1, 0, [1, 0, 1], owner.player, Date.now(), null, owner.party)
    for (const x of [a, b]) x.p.known.add(item.id)
    expect(h.req(a, { t: 'pickup', id: item.id })).toMatchObject({ ok: false, reason: 'not_owner' })
    // the leader switches the item mode after the drop...
    expect(h.req(a, { t: 'partySettings', items: 'free' })).toMatchObject({ ok: true })
    // Correct: pickup rights are fixed when the item drops (QUESTS §4.3: "only that member may pick it up for 30 s").
    // Today mayLoot() reads the party's CURRENT mode, so the leader takes b's item.
    expect(h.req(a, { t: 'pickup', id: item.id }), "a mode change must not unlock another member's round-robin item").toMatchObject({ ok: false, reason: 'not_owner' })
    expect(h.store.loadInventory(a.p.characterId).bag.some((i) => i?.code === 'ITEM_CH_BLADE_02_A')).toBe(false)
  })
})

// ---- real server: GM editors ------------------------------------------------------------------------------

const SPAWN: [number, number, number] = [50, 0, -50]
const BOUNDS = { min: [0, 0, -400], max: [400, 0, 0] }

describe('party lens: GM editors on a real server', () => {
  let s: TestServer
  let contentDir: string
  let n = 0

  beforeAll(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'sro-abuse-content-'))
    mkdirSync(join(contentDir, 'quests'), { recursive: true })
    writeFileSync(
      join(contentDir, 'quests', 'test.json'),
      JSON.stringify({
        schema: 1, kind: 'quests', id: 'test', title: 'Test line', world: 'jangan', items: [], locations: [],
        quests: [{
          id: 'TQ_001', title: 'Pests', kind: 'side', level: 1, giver: 'NPC_CH_POTION', turnIn: 'NPC_CH_POTION', summary: 'Thin them out.',
          objectives: [{ id: 'mang', type: 'kill', mobs: ['MOB_CH_MANGNYANG'], count: 8 }],
          rewards: { exp: 100, sp: 1, gold: 10 }, dialog: { offer: 'Kill eight.', progress: 'Keep at it.', complete: 'Thanks.' },
        }],
      }),
    )
    s = await startTestServer({
      config: { moveSpeed: 30, tickHz: 20, viewRange: 80, rng: seeded(13), mobLevelMax: 25, contentDir },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: BOUNDS }),
        ...contentFiles({ mobs: [MANGNYANG, TIGER], nests: [nest(7, MANGNYANG.code, 300, -300, { count: 2 })], items: ITEMS, levels: LEVELS, npcs: NPCS, shops: SHOPS }),
      },
    })
  }, 60_000)

  afterAll(async () => {
    await s?.stopAndClean()
    rmSync(contentDir, { recursive: true, force: true })
  })

  async function player(role?: 'gm' | 'admin') {
    const acc = await newAccount(s.url, role ? 'abgm' : 'abpl')
    if (role) s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role)
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Abuse${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    return { c, acc }
  }
  async function gm(c: Client, cmd: string, ...args: string[]): Promise<Msg<'gmResult'>> {
    c.send({ t: 'gm', cmd, args })
    return c.next('gmResult', (m) => m.cmd === cmd, 5000)
  }
  async function http(method: string, path: string, token?: string, body?: string): Promise<{ status: number; json: any }> {
    const res = await fetch(s.url + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body,
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: res.status, json }
  }
  const authoredAlive = () => [...s.ctx.world.mobs.values()].filter((m) => m.nest !== null && m.nest.id >= AUTHORED_NEST_ID_MIN && m.ai !== 'dead').length

  it('refused: a plain player gets forbidden + a denied audit row for nest/npc/content, over gm frames; nothing is written', async () => {
    const { c } = await player()
    for (const [cmd, args] of [['nest', ['add', 'MOB_CH_MANGNYANG', '50', '30']], ['npc', ['add', 'NPC_CH_POTION', 'Evil', 'Twin']], ['content', ['reload', 'all']]] as const) {
      c.send({ t: 'gm', cmd, args })
      const r = await c.next('error', (m) => m.re === 'gm', 5000)
      expect(r.code, `${cmd} as a player`).toBe('forbidden')
    }
    expect(s.ctx.store.recentAudit(50).filter((r) => ['nest', 'npc', 'content'].includes(r.command) && r.ok === 0).length).toBeGreaterThanOrEqual(3)
    expect(authoredAlive()).toBe(0)
    expect(readdirSync(join(s.root, 'data')).includes('content') ? readdirSync(join(s.root, 'data', 'content')).filter((f) => f.endsWith('override.json')) : []).toEqual([])
    c.close()
  })

  it('refused: /api/gm/quests as a player (403 + audit), traversal ids (400), 33 KB bodies (413), junk JSON (400), deep nesting and __proto__ (422); the server stays up', async () => {
    const pl = await player()
    const g = await player('gm')
    expect((await http('PUT', '/api/gm/quests/TQ_001', pl.acc.token, JSON.stringify({ quest: { id: 'TQ_001' } }))).status).toBe(403)
    expect(s.ctx.store.recentAudit(20).some((r) => r.command === 'questput' && r.ok === 0)).toBe(true)
    for (const bad of ['%2E%2E%2F%2E%2E%2Fnests.override', '..%5C..%5Cx', 'tq_001', 'A', `A${'B'.repeat(64)}`]) {
      const r = await http('PUT', `/api/gm/quests/${bad}`, g.acc.token, '{}')
      expect([400, 404], bad).toContain(r.status)
    }
    expect((await http('PUT', '/api/gm/quests/TQ_001', g.acc.token, `{"quest":{"id":"TQ_001","summary":"${'x'.repeat(33 * 1024)}"}}`)).status).toBe(413)
    expect((await http('PUT', '/api/gm/quests/TQ_001', g.acc.token, '{"quest": {')).status).toBe(400)
    const deep = `{"quest":{"id":"TQ_001","objectives":${'['.repeat(12_000)}${']'.repeat(12_000)}}}`
    expect((await http('PUT', '/api/gm/quests/TQ_001', g.acc.token, deep)).status).toBe(422)
    const proto = '{"quest":{"id":"TQ_001","__proto__":{"disabled":true},"title":"x"}}'
    expect((await http('PUT', '/api/gm/quests/TQ_001', g.acc.token, proto)).status).toBe(422)
    // nothing was written outside the quest override dir and the repo quest is intact
    expect(s.ctx.gameplay.quests.book.quest('TQ_001')!.objectives[0]).toMatchObject({ count: 8 })
    expect((await http('GET', '/health')).status).toBe(200)
    pl.c.close()
    g.c.close()
  })

  it('BUG: authored nests have no server-wide monster cap: a GM (or a stolen GM session) can persist thousands of monsters with /nest add, unlike /spawn (300 alive)', async () => {
    const { c } = await player('gm')
    const results: boolean[] = []
    // 21 adds of 50 = 1,050 monsters, all persisted in nests.override.json and respawned after every restart; the
    // record limit (OVERRIDE_RECORDS_MAX 2000 x NEST_COUNT_MAX 50) would allow 100,000 on the N100 host.
    for (let i = 0; i < 21; i++) {
      const r = await gm(c, 'nest', 'add', 'MOB_CH_MANGNYANG', '50', '30')
      results.push(r.ok)
      if (!r.ok) break
      await sleep(30)
    }
    const alive = authoredAlive()
    // Correct: `nest add` / `nest set count` refuse a change that takes the live authored-nest total over a cap (at most
    // 1,000 here; /spawn's GM_SPAWN_TOTAL_MAX is 300). Today every add succeeds.
    expect(results.includes(false), `every one of ${results.length} adds succeeded (${alive} authored monsters alive)`).toBe(true)
    expect(alive).toBeLessThanOrEqual(1000)
    // clean up for the other tests (paced under the GM command budget, 5/s: the adds above used up its burst)
    for (let i = 0; i < results.filter(Boolean).length; i++) {
      await sleep(250)
      expect((await gm(c, 'nest', 'undo')).ok).toBe(true)
    }
    expect(authoredAlive()).toBe(0)
    c.close()
  }, 60_000)
})
