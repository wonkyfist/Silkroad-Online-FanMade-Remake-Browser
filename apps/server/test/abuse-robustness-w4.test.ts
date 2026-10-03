/**
 * Adversarial robustness hunt, waves 4-5 (lens "robustness"): the wave-4 client messages fuzzed over a real socket
 * (missing / extra / wrong-typed keys, huge and odd unicode strings, prototype names), in-parser-valid but nonsensical
 * requests, disconnects in the middle of a party invite and a quest editor save, relog resume of quests and parties,
 * module bookkeeping after many join/leave cycles, and odd content ids reaching the quest engine.
 *
 * Two setups: an in-process Gameplay harness (synthetic content, like quests.test.ts / party.test.ts) and a real server
 * on synthetic content (like editors-e2e.test.ts) for the socket and HTTP parts. Every server frame is checked against
 * the client's strict parser (the game client silently drops a frame that fails it, net/wire.ts).
 *
 * Tests named "BUG:" describe the correct behaviour and fail against the current code; the rest are regression guards
 * for attacks the code already refuses.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseServerMessage,
  validateQuestFile,
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
import { Gameplay, type GameplayMessage } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { QuestBook } from '../src/quests/book.ts'
import { questRefs } from '../src/quests/engine.ts'
import { World, type Npc, type Player } from '../src/world.ts'
import { ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, contentFiles, mob, nest, seeded } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, testConfig, type TestServer } from './helpers.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const MANG = MANGNYANG.code
const HERB = 'ITEM_ETC_HP_POTION_01'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** Every frame must pass the client's strict parser (net/wire.ts drops the ones that do not). */
function badFrames(inbox: readonly ServerMessage[]): string[] {
  const out: string[] = []
  for (const m of inbox) {
    const r = parseServerMessage(JSON.stringify(m))
    if (!r.ok) out.push(`${r.error}: ${JSON.stringify(m)}`)
  }
  return out
}

// ---- in-process harness (synthetic content) --------------------------------------------------------------------

const QNPCS: NpcDef[] = ['NPC_T_GATE', 'NPC_T_CHIEF'].map((code) => ({ code, name: code.slice(6), x: 0, z: 0, yaw: 0, world: 'jangan', model: null, provenance: 'client' }))
const AT: Record<string, [number, number]> = { NPC_T_GATE: [0, 0], NPC_T_CHIEF: [30, 0] }
const dialog = { offer: 'Hello {name}.', progress: 'Well?', complete: 'Thanks.' }
const Q = (over: Partial<QuestDef> & Pick<QuestDef, 'id' | 'objectives'>): QuestDef => ({
  title: over.id, kind: 'side', level: 1, giver: 'NPC_T_CHIEF', turnIn: 'NPC_T_CHIEF', summary: 'Test quest.', rewards: { exp: 10, sp: 1, gold: 10 }, dialog, ...over,
})

/** An objective id that is also an Object.prototype property name (OBJECTIVE_ID allows it: lower case, a letter first). */
const PROTO_ID = 'constructor'

const BOSS = mob('MOB_CH_BOSS', { name: 'Boss', level: 5, hp: 1000, rarity: 'unique', exp: 500 })
const SHRINE: [number, number] = [-100, 0]

const QFILE: QuestFile = {
  schema: 1, kind: 'quests', id: 'w4robust', title: 'Robustness line', world: 'jangan',
  items: [{ code: 'QITEM_BELL', name: 'Bell' }],
  locations: [{ id: 'LOC_SHRINE', name: 'Shrine', x: SHRINE[0], z: SHRINE[1], radius: 10 }],
  quests: [
    Q({
      id: 'T_ENC', giveOnAccept: [{ item: 'QITEM_BELL', count: 1 }],
      objectives: [
        { id: 'bell', type: 'useItem', item: 'QITEM_BELL', location: 'LOC_SHRINE', consume: false, text: 'It rings.', encounter: { mob: BOSS.code, count: 1, hpMul: 0.5, despawnSec: 600, cooldownSec: 30 } },
        { id: 'boss', type: 'kill', mobs: [BOSS.code], count: 1, after: 'bell' },
      ],
    }),
    Q({ id: 'T_CTOR', objectives: [{ id: PROTO_ID, type: 'kill', mobs: [MANG], count: 2 }] }),
    Q({
      id: 'T_KILL',
      objectives: [{ id: 'pests', type: 'kill', mobs: [MANG], count: 1 }],
      rewards: { exp: 10, sp: 1, gold: 10, choice: [{ item: 'ITEM_CH_BLADE_02_A' }, { item: HERB, count: 2 }] },
    }),
    Q({ id: 'T_TALK', giver: 'NPC_T_GATE', turnIn: 'NPC_T_GATE', objectives: [{ id: 'chief', type: 'talk', npc: 'NPC_T_CHIEF', text: 'Hm.' }] }),
  ],
}

function harness(file: QuestFile = QFILE) {
  const root = mkdtempSync(join(tmpdir(), 'sro-w4robust-'))
  const config = { ...testConfig(root), rng: seeded(5) }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG, BOSS], items: ITEMS, levels: LEVELS, npcs: [...NPCS, ...QNPCS], shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(5) })
  const book = QuestBook.fromFiles([{ name: 'w4robust.json', json: file }], { refs: questRefs(gameplay) })
  gameplay.quests.setContent(book)
  const npcs = new Map<string, Npc>()
  for (const [code, [x, z]] of Object.entries(AT)) {
    const n: Npc = { kind: 'npc', id: world.newId(), code, name: code, pos: [x, 0, z], yaw: 0 }
    world.addEntity(n)
    npcs.set(code, n)
  }
  let seq = 0
  interface P { p: Player; inbox: ServerMessage[] }
  const rejoin = (characterId: number, pos: Vec3 = [0, 0, 0]): P => {
    const row = store.characterById(characterId)!
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(row), characterId, name: row.name, model: row.model, level: row.level, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    for (const npc of npcs.values()) p.known.add(npc.id)
    for (const q of world.players.values()) {
      q.known.add(p.id)
      p.known.add(q.id)
    }
    gameplay.sendEnter(p)
    return { p, inbox }
  }
  const enter = (pos: Vec3 = [0, 0, 0]): P => {
    const acc = store.createAccount(`w4r${++seq}`, 'x')!
    const row = store.createCharacter(acc, `Robust${seq}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    return rejoin(row.id, pos)
  }
  const leave = (x: P) => {
    world.remove(x.p.id)
    gameplay.forget(x.p)
  }
  const req = (x: P, msg: ClientMessage, now = Date.now()): Msg<'actionResult'> => {
    const before = x.inbox.length
    gameplay.request(x.p, msg as GameplayMessage & Extract<ClientMessage, { t: GameplayRequest }>, now)
    const res = x.inbox.slice(before).filter((m): m is Msg<'actionResult'> => m.t === 'actionResult')
    expect(res.length, `${msg.t} answers once`).toBe(1)
    expect(res[0].re).toBe(msg.t)
    return res[0]
  }
  const at = (p: Player, code: string) => {
    const [x, z] = AT[code]
    world.warp(p, x + 1, 0, z)
  }
  const kill = (killers: Player[]) => {
    const m = gameplay.createMob(data.mob(MANG)!, 'normal', 200, 200, 0, null, Date.now())
    for (const k of killers) m.damage.set(k.id, 10)
    gameplay.mobDied(m, Date.now(), true)
  }
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, world, gameplay, engine: gameplay.quests, party: gameplay.party, npcs, enter, rejoin, leave, req, at, kill }
}

describe('quest engine: content ids that are Object.prototype names', () => {
  it('precondition: the shared validator accepts the objective id "constructor" (so the GM quest editor can save it)', () => {
    const r = validateQuestFile(QFILE)
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(r.file?.quests.map((q) => q.id)).toContain('T_CTOR')
  })

  it('BUG: an objective with id "constructor" counts kills (0 -> 1 -> 2, then ready) and every frame passes the client parser, also after a relog', () => {
    const h = harness()
    const a = h.enter()
    h.at(a.p, 'NPC_T_CHIEF')
    expect(h.req(a, { t: 'questAccept', npc: h.npcs.get('NPC_T_CHIEF')!.id, quest: 'T_CTOR' })).toMatchObject({ ok: true })
    h.kill([a.p])
    h.kill([a.p])
    const q = h.engine.logOf(a.p).active.get('T_CTOR')!
    // Correct: plain numbers on the objective, the quest ready after its 2 kills.
    expect({ count: q.counts[PROTO_ID], status: q.status }).toEqual({ count: 2, status: 'ready' })
    expect(badFrames(a.inbox)).toEqual([])
    // A relog re-reads the log from the database: the whole `quests` snapshot must still parse on the client.
    h.leave(a)
    const again = h.rejoin(a.p.characterId)
    const snap = again.inbox.find((m) => m.t === 'quests')
    expect(snap).toBeDefined()
    expect(badFrames(again.inbox)).toEqual([])
  })
})

describe('quest encounters: the summoned mob leaving the world by a GM kill', () => {
  it('BUG: after a GM /kill of the summoned boss the encounter is over (no live encounter, no encounterUntil) and the bell summons again', () => {
    const h = harness()
    const a = h.enter()
    h.at(a.p, 'NPC_T_CHIEF')
    expect(h.req(a, { t: 'questAccept', npc: h.npcs.get('NPC_T_CHIEF')!.id, quest: 'T_ENC' })).toMatchObject({ ok: true })
    h.world.warp(a.p, SHRINE[0] + 1, 0, SHRINE[1])
    expect(h.req(a, { t: 'questUseItem', quest: 'T_ENC', objective: 'bell' })).toMatchObject({ ok: true })
    const [enc] = h.engine.encounters.all()
    expect(enc.mobs.size).toBe(1)
    const boss = h.world.mobs.get([...enc.mobs][0])!
    // A GM helps a stuck player (or cleans up) with `/kill`: gm.ts -> Gameplay.gmKill -> mobDied(rewards = false).
    h.gameplay.gmKill(boss)
    expect(boss.ai).toBe('dead')
    // Correct: nothing is summoned any more, so the encounter has ended (its mob is dead and will vanish with the corpse) ...
    expect(h.engine.encounters.all()).toEqual([])
    expect(h.engine.progress(a.p, h.engine.logOf(a.p).active.get('T_ENC')!).encounterUntil).toBeUndefined()
    // ... and the bell can summon her again (the kill objective is still open), instead of "It is already here." for 600 s.
    expect(h.req(a, { t: 'questUseItem', quest: 'T_ENC', objective: 'bell' })).toMatchObject({ ok: true })
  })
})

describe('in-parser-valid but nonsensical wave-4 requests (harness)', () => {
  it('each gets exactly one refusal and no exception: unknown ids, prototype names, other entities, huge ids', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([3, 0, 0])
    h.at(a.p, 'NPC_T_CHIEF')
    const chief = h.npcs.get('NPC_T_CHIEF')!.id
    const cases: ClientMessage[] = [
      { t: 'questAccept', npc: chief, quest: 'NOPE' },
      { t: 'questAccept', npc: a.p.id, quest: 'T_KILL' },
      { t: 'questAccept', npc: b.p.id, quest: 'T_KILL' },
      { t: 'questAccept', npc: Number.MAX_SAFE_INTEGER, quest: 'T_KILL' },
      { t: 'questAccept', npc: chief, quest: 'T_TALK' },
      { t: 'questTurnIn', npc: chief, quest: 'T_KILL', choice: 3 },
      { t: 'questTalk', npc: chief, quest: 'T_KILL', objective: 'constructor' },
      { t: 'questTalk', npc: chief, quest: 'CONSTRUCTOR', objective: 'pests' },
      { t: 'questUseItem', quest: 'T_KILL', objective: 'constructor' },
      { t: 'questAbandon', quest: 'CONSTRUCTOR' },
      { t: 'partyInvite', target: a.p.id },
      { t: 'partyInvite', target: chief },
      { t: 'partyInvite', target: Number.MAX_SAFE_INTEGER },
      { t: 'partyRespond', inviter: b.p.id, accept: true },
      { t: 'partyKick', member: Number.MAX_SAFE_INTEGER },
      { t: 'partyLeader', member: a.p.characterId },
      { t: 'partySettings', exp: 'free' },
      { t: 'partyLeave' },
    ]
    for (const msg of cases) expect(h.req(a, msg), JSON.stringify(msg)).toMatchObject({ ok: false })
    // the real quest still works afterwards; a turn-in with the choice out of range is refused, then pays
    expect(h.req(a, { t: 'questAccept', npc: chief, quest: 'T_KILL' })).toMatchObject({ ok: true })
    h.kill([a.p])
    expect(h.req(a, { t: 'questTurnIn', npc: chief, quest: 'T_KILL', choice: 2 })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(a, { t: 'questTurnIn', npc: chief, quest: 'T_KILL', choice: 1 })).toMatchObject({ ok: true })
    expect(badFrames(a.inbox)).toEqual([])
    expect(badFrames(b.inbox)).toEqual([])
  })
})

describe('party: disconnects in the middle of an invite, relog, and bookkeeping after many cycles (harness)', () => {
  it('an inviter who leaves ends the invite on both sides; a late accept gets no_invite; nothing is left behind', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter([2, 0, 0])
    expect(h.req(a, { t: 'partyInvite', target: b.p.id })).toMatchObject({ ok: true })
    expect(b.inbox.some((m) => m.t === 'partyInvited')).toBe(true)
    h.leave(a)
    expect(b.inbox.filter((m): m is Msg<'partyEvent'> => m.t === 'partyEvent').map((e) => e.event)).toContain('expired')
    expect(h.req(b, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: false, reason: 'no_invite' })
    expect(h.party.invites.size).toBe(0)
    expect(h.party.parties.size).toBe(0)
    // the invitee leaving ends it too
    const c = h.rejoin(a.p.characterId)
    expect(h.req(c, { t: 'partyInvite', target: b.p.id })).toMatchObject({ ok: true })
    h.leave(b)
    expect(c.inbox.filter((m): m is Msg<'partyEvent'> => m.t === 'partyEvent').map((e) => e.event)).toContain('expired')
    expect(h.party.invites.size).toBe(0)
    expect(badFrames([...b.inbox, ...c.inbox])).toEqual([])
  })

  it('a relog inside the grace resumes the party (state last, new entity); 200 form/leave/relog cycles leave no parties, invites or quest logs behind', () => {
    const h = harness()
    let a = h.enter()
    let b = h.enter([2, 0, 0])
    const aChar = a.p.characterId
    const bChar = b.p.characterId
    for (let i = 0; i < 200; i++) {
      expect(h.req(a, { t: 'partyInvite', target: b.p.id }), `cycle ${i}`).toMatchObject({ ok: true })
      expect(h.req(b, { t: 'partyRespond', inviter: a.p.id, accept: true })).toMatchObject({ ok: true })
      h.leave(b)
      b = h.rejoin(bChar, [2, 0, 0])
      const party = b.inbox.filter((m): m is Msg<'party'> => m.t === 'party').at(-1)!
      expect(party.party?.members.find((m) => m.characterId === bChar)?.entity).toBe(b.p.id)
      const tail = b.inbox.filter((m) => ['worldEnter', 'stats', 'inventory', 'skills', 'quests', 'party'].includes(m.t)).at(-1)
      expect(tail?.t).toBe('party')
      expect(h.req(i % 2 ? a : b, { t: 'partyLeave' })).toMatchObject({ ok: true })
      if (i % 50 === 49) {
        h.leave(a)
        a = h.rejoin(aChar)
      }
      a.inbox.length = 0
      b.inbox.length = 0
    }
    expect(h.party.parties.size).toBe(0)
    expect(h.party.byChar.size).toBe(0)
    expect(h.party.invites.size).toBe(0)
    h.leave(a)
    h.leave(b)
    const logs = (h.engine as unknown as { logs: Map<number, unknown> }).logs
    expect(logs.size).toBe(0)
  })
})

// ---- real server (synthetic content) -----------------------------------------------------------------------------

const SPAWN: [number, number, number] = [50, 0, -50]
const BOUNDS = { min: [0, 0, -400], max: [400, 0, 0] }
const QUEST = {
  id: 'TQ_001', title: 'Pests', kind: 'side', level: 1, giver: 'NPC_CH_POTION', turnIn: 'NPC_CH_POTION', summary: 'Thin out the mangnyang.',
  objectives: [{ id: 'mang', type: 'kill', mobs: [MANG], count: 8 }],
  rewards: { exp: 100, sp: 1, gold: 10 },
  dialog: { offer: 'Kill eight.', progress: 'Keep at it.', complete: 'Thanks.' },
}
const QUEST_FILE = { schema: 1, kind: 'quests', id: 'test', title: 'Test line', world: 'jangan', items: [], locations: [], quests: [QUEST] }

/** A PUT whose headers go out now and whose body is sent later (a slow upload, or one cut off by a disconnect). */
function slowPut(base: string, path: string, token: string, body: unknown) {
  const text = JSON.stringify(body)
  const u = new URL(base + path)
  const req = request({
    method: 'PUT', host: u.hostname, port: Number(u.port), path: u.pathname,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
  })
  const res = new Promise<{ status: number; json: any }>((resolve, reject) => {
    req.on('response', (r) => {
      let data = ''
      r.setEncoding('utf8')
      r.on('data', (c: string) => (data += c))
      r.on('end', () => resolve({ status: r.statusCode ?? 0, json: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
  })
  res.catch(() => {})
  req.flushHeaders()
  return {
    send: () => {
      req.end(text)
      return res
    },
    abort: () => req.destroy(),
    res,
  }
}

describe('real server: quest editor HTTP, socket fuzz of every wave-4 client message', () => {
  let s: TestServer
  let contentDir: string
  const logs: string[] = []
  let n = 0

  beforeAll(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'sro-w4robust-content-'))
    mkdirSync(join(contentDir, 'quests'), { recursive: true })
    writeFileSync(join(contentDir, 'quests', 'test.json'), JSON.stringify(QUEST_FILE))
    s = await startTestServer({
      logs,
      config: { moveSpeed: 30, tickHz: 20, viewRange: 80, rng: seeded(13), mobLevelMax: 25, contentDir },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: BOUNDS }),
        ...contentFiles({ mobs: [MANGNYANG], nests: [nest(8, MANG, 300, -300, { count: 2 })], items: ITEMS, levels: LEVELS, npcs: NPCS, shops: SHOPS }),
      },
    })
  }, 60_000)

  afterAll(async () => {
    await s?.stopAndClean()
    rmSync(contentDir, { recursive: true, force: true })
  })

  const overridePath = (id: string) => join(s.ctx.config.dataDir, 'content', 'quests', `${id}.json`)
  const gmAccount = async () => {
    const acc = await newAccount(s.url, 'w4gm')
    const id = s.ctx.store.accountByName(acc.username)!.id
    s.ctx.store.setRole(id, 'gm')
    return { ...acc, id }
  }
  const hero = async () => {
    const acc = await newAccount(s.url, 'w4fz')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Fuzz${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const w = await c.next('worldEnter')
    await c.next('quests')
    return { c, id: w.self.id, characterId: ch.id }
  }

  it('BUG: a PUT whose body arrives after another save is checked against the quest as it is then (409 on a stale baseRev), not as it was when its headers came', async () => {
    const g = await gmAccount()
    const path = '/api/gm/quests/TQ_001'
    const first = slowPut(s.url, path, g.token, { quest: { ...QUEST, title: 'Edit A' }, baseRev: 0 })
    const second = slowPut(s.url, path, g.token, { quest: { ...QUEST, title: 'Edit B' }, baseRev: 0 })
    await sleep(250) // both requests are past the route/auth step, waiting for their bodies
    const a = await first.send()
    expect(a.status).toBe(200)
    expect(a.json).toMatchObject({ ok: true, rev: 1 })
    const b = await second.send()
    // Correct: B was based on rev 0, but the quest is at rev 1 now -> 409 and A's edit stays.
    expect(b.status).toBe(409)
    const saved = JSON.parse(readFileSync(overridePath('TQ_001'), 'utf8'))
    expect(saved.quests[0].title).toBe('Edit A')
  })

  it('BUG: a GM whose role is revoked while the PUT body is still uploading gets 403 and nothing is written (the role is re-read on every call)', async () => {
    const g = await gmAccount()
    const quest = { ...QUEST, id: 'TQ_REVOKED', title: 'Written after the revoke' }
    const put = slowPut(s.url, '/api/gm/quests/TQ_REVOKED', g.token, { quest })
    await sleep(250)
    s.ctx.store.setRole(g.id, 'player') // `pnpm gm revoke` while the upload is in flight
    const r = await put.send()
    expect(r.status).toBe(403)
    expect(existsSync(overridePath('TQ_REVOKED'))).toBe(false)
  })

  it('a PUT cut off mid-body (client disconnect) writes nothing and the server keeps answering', async () => {
    const g = await gmAccount()
    const quest = { ...QUEST, id: 'TQ_CUT', title: 'Never finished' }
    const put = slowPut(s.url, '/api/gm/quests/TQ_CUT', g.token, { quest })
    await sleep(150)
    put.abort()
    await sleep(150)
    expect(existsSync(overridePath('TQ_CUT'))).toBe(false)
    const list = await fetch(`${s.url}/api/gm/quests`, { headers: { Authorization: `Bearer ${g.token}` } })
    expect(list.status).toBe(200)
    expect(logs.filter((l) => /unhandled|TypeError|ReferenceError/.test(l))).toEqual([])
  })

  it('odd PUT bodies get 4xx, never 500: deep nesting, non-objects, bidi/control/lone-surrogate text is cleaned', async () => {
    const g = await gmAccount()
    const call = async (body: string) => {
      const r = await fetch(`${s.url}/api/gm/quests/TQ_ODD`, { method: 'PUT', headers: { Authorization: `Bearer ${g.token}`, 'Content-Type': 'application/json' }, body })
      return { status: r.status, json: await r.json().catch(() => null) }
    }
    const deep = `{"quest":${'['.repeat(10_000)}${']'.repeat(10_000)}}`
    expect((await call(deep)).status).toBe(400)
    expect((await call('[]')).status).toBe(400)
    expect((await call('"quest"')).status).toBe(400)
    expect((await call('{"quest":{"__proto__":{"id":"TQ_ODD"}}}')).status).toBe(422)
    const title = 'Evil‮txt.exe\u0000\u0007 \uD800 title'
    const ok = await call(JSON.stringify({ quest: { ...QUEST, id: 'TQ_ODD', title } }))
    expect(ok.status).toBe(200)
    const saved = JSON.parse(readFileSync(overridePath('TQ_ODD'), 'utf8'))
    expect(saved.quests[0].title).not.toMatch(/[‮\u0000\u0007]/)
    // the player catalog still serves (and parses) after the odd save
    const cat = await fetch(`${s.url}/api/quests`, { headers: { Authorization: `Bearer ${g.token}` } })
    expect(cat.status).toBe(200)
  })

  it('every wave-4 client type with missing / wrong-typed / huge / unicode / prototype keys gets bad_request, and the socket survives', async () => {
    const huge = 'Q'.repeat(3_900) // just under the 4 KB frame cap
    const frames: string[] = [
      JSON.stringify({ t: 'questAccept', npc: 1 }),
      JSON.stringify({ t: 'questAccept', npc: 1, quest: 5 }),
      JSON.stringify({ t: 'questAccept', npc: 1, quest: huge }),
      JSON.stringify({ t: 'questAccept', npc: -1, quest: 'TQ_001' }),
      JSON.stringify({ t: 'questAccept', npc: 1.5, quest: 'TQ_001' }),
      JSON.stringify({ t: 'questAccept', npc: '1', quest: 'TQ_001' }),
      JSON.stringify({ t: 'questAccept', npc: 1, quest: 'TQ_001\u0000' }),
      JSON.stringify({ t: 'questAccept', npc: 1, quest: 'TQ_ÄÖ' }),
      JSON.stringify({ t: 'questAccept', npc: 1, quest: null }),
      JSON.stringify({ t: 'questTurnIn', npc: 1, quest: 'TQ_001', choice: -1 }),
      JSON.stringify({ t: 'questTurnIn', npc: 1, quest: 'TQ_001', choice: 1.5 }),
      JSON.stringify({ t: 'questTurnIn', npc: 1, quest: 'TQ_001', choice: 99 }),
      JSON.stringify({ t: 'questTurnIn', npc: 1, quest: 'TQ_001', choice: '0' }),
      JSON.stringify({ t: 'questAbandon', quest: [] }),
      JSON.stringify({ t: 'questAbandon' }),
      JSON.stringify({ t: 'questTalk', npc: 1, quest: 'TQ_001', objective: 'Constructor' }),
      JSON.stringify({ t: 'questTalk', npc: 1, quest: 'TQ_001', objective: 'a'.repeat(25) }),
      JSON.stringify({ t: 'questTalk', npc: 1, quest: 'TQ_001' }),
      JSON.stringify({ t: 'questUseItem', quest: 'TQ_001', objective: '__proto__' }),
      JSON.stringify({ t: 'questUseItem', quest: {}, objective: 'mang' }),
      JSON.stringify({ t: 'partyInvite', target: -1 }),
      JSON.stringify({ t: 'partyInvite', target: 2 ** 60 }),
      JSON.stringify({ t: 'partyInvite', target: 1, exp: 'SHARE' }),
      JSON.stringify({ t: 'partyInvite', target: 1, items: null }),
      JSON.stringify({ t: 'partyRespond', inviter: 1, accept: 'true' }),
      JSON.stringify({ t: 'partyRespond', accept: true }),
      JSON.stringify({ t: 'partyRespond', inviter: 1, accept: 1 }),
      '{"t":"partyLeave","__proto__":{"x":1}}',
      JSON.stringify({ t: 'partyLeave', member: 1 }),
      JSON.stringify({ t: 'partyKick', member: 0 }),
      JSON.stringify({ t: 'partyKick', member: '5' }),
      JSON.stringify({ t: 'partyLeader', member: null }),
      JSON.stringify({ t: 'partySettings' }),
      JSON.stringify({ t: 'partySettings', exp: 'bogus' }),
      JSON.stringify({ t: 'chat', text: 'hi', channel: 'PARTY' }),
      JSON.stringify({ t: 'chat', text: 'hi', channel: 'party', to: 'Someone' }),
    ]
    // At most 12 bad frames per connection (MAX_STRIKES is 20): a real flood still closes the socket, as it should.
    for (let i = 0; i < frames.length; i += 12) {
      const h = await hero()
      for (const f of frames.slice(i, i + 12)) {
        h.c.send(f)
        const e = await h.c.next('error', () => true, 2000)
        expect(e.code, f.slice(0, 120)).toBe('bad_request')
      }
      h.c.send({ t: 'ping', n: 7, clientTime: 1 })
      expect(await h.c.next('pong', (m) => m.n === 7)).toMatchObject({ n: 7 })
      expect(h.c.isClosed).toBe(false)
      h.c.close()
      await h.c.closed
    }
    // A frame over WS_MAX_PAYLOAD (4 KB) is cut by ws itself: close 1009, nothing reaches the handlers.
    const big = await hero()
    big.c.send(JSON.stringify({ t: 'questAccept', npc: 1, quest: 'Q'.repeat(20_000) }))
    expect((await big.c.closed).code).toBe(1009)
    expect(logs.filter((l) => l.startsWith('error handling'))).toEqual([])
  }, 60_000)

  it('valid but nonsensical wave-4 frames over the socket get an actionResult refusal (never server_error), and party chat keeps its unicode', async () => {
    const a = await hero()
    const b = await hero()
    const npc = [...s.ctx.world.npcs.values()].find((x) => x.code === 'NPC_CH_POTION')!
    const act = async (msg: Record<string, unknown> & { t: string }) => {
      a.c.send(msg)
      return a.c.next('actionResult', (m) => m.re === msg.t, 3000)
    }
    const weird: (Record<string, unknown> & { t: string })[] = [
      { t: 'questAccept', npc: a.id, quest: 'TQ_001' },
      { t: 'questAccept', npc: npc.id, quest: 'CONSTRUCTOR' },
      { t: 'questTalk', npc: npc.id, quest: 'TQ_001', objective: 'constructor' },
      { t: 'questUseItem', quest: 'ZZ', objective: 'constructor' },
      { t: 'questTurnIn', npc: 0, quest: 'A1', choice: 3 },
      { t: 'questAbandon', quest: 'TQ_001' },
      { t: 'partyInvite', target: a.id },
      { t: 'partyInvite', target: npc.id },
      { t: 'partyRespond', inviter: 0, accept: true },
      { t: 'partyKick', member: Number.MAX_SAFE_INTEGER },
      { t: 'partyLeader', member: a.characterId },
      { t: 'partySettings', exp: 'free' },
      { t: 'partyLeave' },
    ]
    for (const m of weird) expect(await act(m), JSON.stringify(m)).toMatchObject({ ok: false })
    a.c.send({ t: 'partyInvite', target: b.id })
    const inv = await b.c.next('partyInvited', () => true, 3000)
    b.c.send({ t: 'partyRespond', inviter: inv.inviter, accept: true })
    await b.c.next('party', (m) => m.party !== null && m.party.members.length === 2, 3000)
    const text = 'héllo \u{1F409} 龍 ‮evil'
    a.c.send({ t: 'chat', text, channel: 'party' })
    const line = await b.c.next('chat', (m) => m.channel === 'party', 3000)
    expect(line.text).toContain('\u{1F409} 龍')
    expect(line.text).not.toContain('‮')
    expect(logs.filter((l) => l.startsWith('error handling'))).toEqual([])
    a.c.close()
    b.c.close()
    await Promise.all([a.c.closed, b.c.closed])
  }, 30_000)
})
