/**
 * Quests end to end over real WebSockets (docs/QUESTS.md §7 lane B): a real server with synthetic content (fixtures)
 * and a quest file in a temp CONTENT_DIR. enter -> `quests` after skills; GET /api/quests (Bearer, ETag); the NPC
 * dialog offers 'quest'; accept -> report -> turn in; accept a kill quest -> GM spawn + attack -> questUpdate progress
 * ... ready -> turn in with a choice -> statsDelta.gain.quest; the log survives a relog. Every frame the clients get
 * passes the shared strict parser (helpers.ts Client throws otherwise).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NpcDef, QuestFile, ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { ITEMS, LEVELS, MANGNYANG, contentFiles, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const SPAWN: [number, number, number] = [50, 0, -50]
const BOUNDS = { min: [0, 0, -400], max: [400, 0, 0] }
const NPC = (code: string, x: number, z: number): NpcDef => ({ code, name: code.slice(6), x, z, yaw: 0, world: 'jangan', model: null, provenance: 'client' })
const NPCS = [NPC('NPC_T_GATE', 52, -50), NPC('NPC_T_CHIEF', 90, -50)]
const dialog = { offer: 'Hello {name}.', progress: 'Well?', complete: 'Thanks.' }
const FILE: QuestFile = {
  schema: 1, kind: 'quests', id: 'e2e', title: 'E2E line', world: 'jangan', items: [], locations: [],
  quests: [
    {
      id: 'T_001', title: 'Report', kind: 'main', level: 1, giver: 'NPC_T_GATE', turnIn: 'NPC_T_CHIEF', summary: 'Report to the chief.',
      objectives: [], rewards: { exp: 20, sp: 1, gold: 100, items: [{ item: 'ITEM_ETC_HP_POTION_01', count: 5 }] }, dialog,
    },
    {
      id: 'T_002', title: 'Pests', kind: 'main', level: 1, giver: 'NPC_T_CHIEF', turnIn: 'NPC_T_CHIEF', requires: { quests: ['T_001'] }, summary: 'Kill two pests.',
      objectives: [{ id: 'pests', type: 'kill', mobs: [MANGNYANG.code], count: 2 }],
      rewards: { exp: 30, sp: 1, gold: 50, choice: [{ item: 'ITEM_CH_BLADE_02_A' }, { item: 'ITEM_CH_SHIELD_01_A' }] }, dialog,
    },
  ],
}

let s: TestServer
let contentDir: string
const logs: string[] = []

beforeAll(async () => {
  contentDir = mkdtempSync(join(tmpdir(), 'sro-quest-content-'))
  mkdirSync(join(contentDir, 'quests'))
  writeFileSync(join(contentDir, 'quests', 'e2e.json'), JSON.stringify(FILE))
  s = await startTestServer({
    logs,
    config: { moveSpeed: 30, tickHz: 20, viewRange: 120, rng: seeded(5), contentDir },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: BOUNDS }),
      ...contentFiles({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS, npcs: NPCS }),
    },
  })
})

afterAll(async () => {
  await s.stopAndClean()
  rmSync(contentDir, { recursive: true, force: true })
})

async function act(c: Client, msg: Record<string, unknown> & { t: string }, timeoutMs = 3000): Promise<Msg<'actionResult'>> {
  c.send(msg)
  return c.next('actionResult', (m) => m.re === msg.t, timeoutMs)
}

async function gm(c: Client, cmd: string, ...args: string[]) {
  c.send({ t: 'gm', cmd, args })
  const r = await c.next('gmResult', (m) => m.cmd === cmd)
  expect(r.ok, `${cmd}: ${r.message}`).toBe(true)
  return r
}

async function enter(c: Client, id: number) {
  const from = c.log.length
  c.send({ t: 'enterWorld', id })
  const w = await c.next('worldEnter')
  const quests = await c.next('quests')
  const order = c.log.slice(from).map((m) => m.t).filter((t) => ['worldEnter', 'stats', 'inventory', 'skills', 'quests'].includes(t))
  return { w, quests, order }
}

const npcId = (c: Client, code: string) => {
  const spawn = c.log.flatMap((m) => (m.t === 'spawn' ? [m.entity] : m.t === 'worldEnter' ? m.entities : [])).find((e) => e.kind === 'npc' && (e.npc ?? e.model) === code)
  if (!spawn) throw new Error(`no ${code} spawned`)
  return spawn.id
}

describe('quests over the wire', () => {
  it('logs the quest content load', () => {
    expect(logs.some((l) => /content quests: 2 quests, 0 quest items, 0 locations from 1 files; 0 errors/.test(l))).toBe(true)
  })

  it('GET /api/quests: Bearer only, the merged catalog, ETag and 304', async () => {
    expect((await fetch(`${s.url}/api/quests`)).status).toBe(401)
    expect((await fetch(`${s.url}/api/quests`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    const acc = await newAccount(s.url, 'qcat')
    const res = await fetch(`${s.url}/api/quests`, { headers: { Authorization: `Bearer ${acc.token}` } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rev: number; files: QuestFile[] }
    expect(body.files.map((f) => f.id)).toEqual(['e2e'])
    expect(body.files[0].quests.map((q) => q.id)).toEqual(['T_001', 'T_002'])
    const etag = res.headers.get('etag')
    expect(etag).toBe(`"q${body.rev}"`)
    const again = await fetch(`${s.url}/api/quests`, { headers: { Authorization: `Bearer ${acc.token}`, 'If-None-Match': etag! } })
    expect(again.status).toBe(304)
  })

  it('enter -> quests; accept at the giver, report to the chief; kill quest via GM spawn + attack; turn in with a choice; relog', async () => {
    const acc = await newAccount(s.url, 'qe2e')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: 'Questor', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    const first = await enter(c, ch.id)
    expect(first.order).toEqual(['worldEnter', 'stats', 'inventory', 'skills', 'quests'])
    expect(first.quests).toMatchObject({ active: [], done: [], rev: s.ctx.gameplay.quests.book.rev })
    await sleep(100)
    const gate = npcId(c, 'NPC_T_GATE')
    const chief = npcId(c, 'NPC_T_CHIEF')

    // the dialog offers 'quest' at the giver
    expect(await act(c, { t: 'npcTalk', npc: gate })).toMatchObject({ ok: true })
    expect((await c.next('npcDialog')).services).toContain('quest')
    expect(await act(c, { t: 'questAccept', npc: gate, quest: 'T_001' })).toMatchObject({ ok: true })
    expect(await c.next('questUpdate', (m) => m.quest === 'T_001')).toMatchObject({ event: 'accepted', progress: { status: 'ready' } })
    // too far from the chief, then there
    expect(await act(c, { t: 'questTurnIn', npc: chief, quest: 'T_001' })).toMatchObject({ ok: false, reason: 'too_far' })
    await gm(c, 'tp', '88', '-50')
    expect(await act(c, { t: 'questTurnIn', npc: chief, quest: 'T_001' })).toMatchObject({ ok: true })
    expect(await c.next('questUpdate', (m) => m.quest === 'T_001')).toMatchObject({ event: 'completed', progress: null, done: { quest: 'T_001', times: 1 } })
    expect((await c.next('inventoryUpdate')).bag).toEqual([{ slot: 0, item: { code: 'ITEM_ETC_HP_POTION_01', count: 5 } }])
    expect((await c.next('statsDelta', (m) => !!m.gain)).gain).toEqual({ exp: 20, spExp: 400, quest: 'T_001' })

    // the kill quest
    expect(await act(c, { t: 'questAccept', npc: chief, quest: 'T_002' })).toMatchObject({ ok: true })
    await c.next('questUpdate', (m) => m.event === 'accepted')
    for (let i = 1; i <= 2; i++) {
      const r = await gm(c, 'spawn', MANGNYANG.code, '1')
      const mob = (r.data as { ids: number[] }).ids[0]
      expect(await act(c, { t: 'attack', target: mob })).toMatchObject({ ok: true })
      const up = await c.next('questUpdate', (m) => m.quest === 'T_002' && m.event !== 'accepted', 10_000)
      expect(up.progress!.counts.pests).toBe(i)
      expect(up.event).toBe(i === 2 ? 'ready' : 'progress')
    }
    expect(await act(c, { t: 'questTurnIn', npc: chief, quest: 'T_002' })).toMatchObject({ ok: false, reason: 'choice_required' })
    expect(await act(c, { t: 'questTurnIn', npc: chief, quest: 'T_002', choice: 1 })).toMatchObject({ ok: true })
    await c.next('questUpdate', (m) => m.quest === 'T_002' && m.event === 'completed')
    const inv = await c.next('inventoryUpdate', (m) => !!m.bag?.some((b) => b.item?.code === 'ITEM_CH_SHIELD_01_A'))
    expect(inv.bag!.some((b) => b.item?.code === 'ITEM_CH_SHIELD_01_A')).toBe(true)
    expect((await c.next('statsDelta', (m) => m.gain?.quest === 'T_002')).gain).toMatchObject({ exp: 30, spExp: 400 })

    // relog: the log comes back from the database
    c.send({ t: 'leaveWorld' })
    await c.next('worldLeft')
    const again = await enter(c, ch.id)
    expect(again.quests.active).toEqual([])
    expect(again.quests.done.map((d) => [d.quest, d.times]).sort()).toEqual([['T_001', 1], ['T_002', 1]])
    c.close()
    await c.closed
  }, 30_000)
})
