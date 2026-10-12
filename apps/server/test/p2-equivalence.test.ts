/**
 * docs/SERVER_ARCHITECTURE.md phase P2: the DB writer thread (DB_WRITER) and the global services behind the bus
 * (SVC_BUS) change no message and no stored row.
 *
 * 1. Economy lockstep: two Gameplay harnesses, one with both switches off (the synchronous store, direct module calls),
 *    one with both on (the in-memory database + writer thread, the services, escrow, commit-then-ack), run the same 600
 *    random economy steps — trades with items and gold, stall purchases, storage deposits / withdrawals / gold, bag
 *    moves, shop buys and sales — at the same clock: every player's message stream is identical, and so is every table
 *    of the two database files at the end.
 * 2. Server script: the same scripted clients (lobby, world, local chat, whispers, a party and its chat, leaving) against
 *    a real server with the switches off and on: the same streams and the same stored characters.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seeded } from './fixtures.ts'
import { Client, api, sleep, startTestServer, type TestServer } from './helpers.ts'
import { dumpDb, econHarness, joinAll, ledger, seedCharacters, step, type StepKind } from './p2-econ.ts'

const roots: string[] = []
const servers: TestServer[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const s of servers.splice(0)) await s.stopAndClean()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const ALL: readonly StepKind[] = ['trade', 'tradeGold', 'stall', 'storage', 'storageGold', 'move', 'shop']

describe('P2: the economy, switches off vs on, in lockstep', () => {
  it('600 random steps: the same message streams and the same database', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_790_000_000_000 })
    const run = (on: boolean) => {
      const root = mkdtempSync(join(tmpdir(), `sro-p2eq-${on ? 'on' : 'off'}-`))
      roots.push(root)
      const h = econHarness({ root, writer: on, svcBus: on, seed: 11 })
      seedCharacters(h.store, 8, seeded(5))
      joinAll(h)
      return h
    }
    const off = run(false)
    const on = run(true)
    expect(off.store.writer).toBeNull()
    expect(on.store.writer).not.toBeNull()
    expect(on.gameplay.services).not.toBeNull()
    const ra = seeded(77)
    const rb = seeded(77)
    const kinds: Record<string, number> = {}
    for (let i = 0; i < 600; i++) {
      const now = 1_790_000_000_000 + i * 50
      vi.setSystemTime(now)
      const a = step(off, ra, now, ALL)
      const b = step(on, rb, now, ALL)
      expect(b.kind).toBe(a.kind)
      kinds[a.kind] = (kinds[a.kind] ?? 0) + 1
      // the writer catches up now and then (the held answers flow); the streams must not depend on when
      if (i % 37 === 0) on.store.flush()
    }
    expect(on.store.flush()).toBe(true)
    for (let i = 0; i < off.players.length; i++) {
      expect(on.players[i]!.inbox.length, `player ${i}`).toBe(off.players[i]!.inbox.length)
      expect(on.players[i]!.inbox, `player ${i}`).toEqual(off.players[i]!.inbox)
    }
    // the steps really moved things: trades and stall sales logged, transfers held until their commit
    const types = new Set(off.players.flatMap((x) => x.inbox.map((m) => m.t)))
    for (const t of ['tradeEnd', 'stallSold', 'storageUpdate', 'inventoryUpdate'] as ServerMessage['t'][]) expect(types.has(t), t).toBe(true)
    const eco = on.gameplay.economy.stats()
    expect(eco.transfers).toBeGreaterThan(100)
    expect(eco.pending).toBe(0)
    expect(eco.escrowed).toBe(0)
    const svc = on.gameplay.services!.stats()
    expect(svc.economy.requests).toBeGreaterThan(1000)
    expect(on.store.writerStats()!.divergences).toBe(0)
    const offFile = join(off.config.dataDir, 'game.db')
    const onFile = join(on.config.dataDir, 'game.db')
    off.store.close()
    on.store.close()
    expect(dumpDb(onFile)).toEqual(dumpDb(offFile))
    const l = ledger(offFile)
    expect(dumpDb(offFile).social_log!.length).toBeGreaterThan(50)
    expect(l.characters).toBe(8)
    expect(Object.keys(kinds).sort()).toEqual([...ALL].sort())
  }, 120_000)
})

async function account(base: string, username: string): Promise<string> {
  const r = await api(base, '/api/register', { username, password: 'password123' })
  if (r.status !== 201) throw new Error(JSON.stringify(r.json))
  return r.json.token as string
}

/** A message with the clock-dependent fields taken out (server time, the sky's clock and weather). */
function norm(m: ServerMessage): unknown {
  return JSON.parse(JSON.stringify(m), (k, v) => (k === 'serverTime' || k === 'clientTime' || k === 'clock' || k === 'weather' || k === 'winter' || k === 'lastPlayed' || k === 'server' || k === 'expiresInMs' ? undefined : v))
}

/** The script: two players; every answer awaited so the order of each stream is fixed by the script. */
async function script(s: TestServer): Promise<Record<string, unknown>> {
  const a = await Client.login(s.url, await account(s.url, 'alpha'))
  const b = await Client.login(s.url, await account(s.url, 'bravo'))
  a.send({ t: 'charList' })
  await a.next('charList')
  a.send({ t: 'nameCheck', name: 'Hero' })
  await a.next('nameCheck')
  a.send({ t: 'charCreate', name: 'HeroA', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ca = (await a.next('charCreated')).character
  a.send({ t: 'charCreate', name: 'Spare', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const spare = (await a.next('charCreated')).character
  a.send({ t: 'charDelete', id: spare.id })
  await a.next('charDeleted')
  a.send({ t: 'charDelete', id: 99_999 })
  await a.next('error', (m) => m.re === 'charDelete')
  b.send({ t: 'charCreate', name: 'HeroB', model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'spear' })
  const cb = (await b.next('charCreated')).character
  a.send({ t: 'enterWorld', id: ca.id })
  const ea = await a.next('worldEnter')
  b.send({ t: 'enterWorld', id: cb.id })
  await b.next('worldEnter')
  const bId = (await a.next('spawn', (m) => m.entity.name === 'HeroB')).entity.id
  a.send({ t: 'chat', text: 'hello there' })
  await b.next('chat', (m) => m.text === 'hello there')
  a.send({ t: 'chat', text: 'psst', to: 'heroB' })
  await b.next('chat', (m) => m.channel === 'whisper')
  await a.next('chat', (m) => m.channel === 'whisper')
  a.send({ t: 'chat', text: 'anyone?', to: 'Nobody' })
  await a.next('error', (m) => m.re === 'chat')
  a.send({ t: 'chat', text: 'party?', channel: 'party' })
  await a.next('error', (m) => m.re === 'chat')
  a.send({ t: 'partyInvite', target: bId })
  await a.next('actionResult', (m) => m.re === 'partyInvite')
  await b.next('partyInvited')
  b.send({ t: 'partyRespond', inviter: ea.self.id, accept: true })
  await b.next('actionResult', (m) => m.re === 'partyRespond')
  await a.next('party')
  a.send({ t: 'chat', text: 'welcome', channel: 'party' })
  await b.next('chat', (m) => m.channel === 'party')
  b.send({ t: 'partyLeave' })
  await b.next('actionResult', (m) => m.re === 'partyLeave')
  a.send({ t: 'leaveWorld' })
  await a.next('worldLeft')
  b.send({ t: 'leaveWorld' })
  await b.next('worldLeft')
  a.send({ t: 'charList' })
  await a.next('charList', (m) => m.characters.length === 1)
  await sleep(50)
  return { a: a.log.map(norm), b: b.log.map(norm) }
}

describe('P2: a real server, switches off vs on', () => {
  it('the same streams and the same stored characters', async () => {
    const start = async (on: boolean) => {
      const s = await startTestServer({ config: { dbWriter: on, svcBus: on, spawnMobs: false } })
      servers.push(s)
      return s
    }
    const off = await start(false)
    const on = await start(true)
    expect(on.ctx.store.writer).not.toBeNull()
    expect(on.ctx.gameplay.services).not.toBeNull()
    const so = await script(off)
    const sn = await script(on)
    expect(sn).toEqual(so)
    // the account and chat services answered the lobby and the routed lines
    const st = on.ctx.gameplay.services!.stats()
    expect(st.account.requests).toBeGreaterThanOrEqual(6)
    expect(st.chat.requests).toBeGreaterThanOrEqual(3)
    expect(st.party.requests).toBeGreaterThanOrEqual(3)
    expect(st.world.requests).toBeGreaterThanOrEqual(2)
    const net = on.ctx.net.snapshot() as unknown as { switches: Record<string, boolean>; db: { seq: number }; services: unknown }
    expect(net.switches.dbWriter).toBe(true)
    expect(net.switches.svcBus).toBe(true)
    expect(net.db.seq).toBeGreaterThan(5)
    // the stored characters, minus the clocks and session hashes
    const omit = { '*': ['created_at', 'last_login', 'last_played', 'expires_at', 'token_hash', 'password_hash', 'at', 'joined_at', 'played_ms', 'deleted_at'] }
    const files = [join(off.root, 'data', 'game.db'), join(on.root, 'data', 'game.db')]
    off.ctx.store.flush()
    on.ctx.store.flush()
    const [a, b] = files.map((f) => dumpDb(f, omit))
    for (const t of ['accounts', 'characters', 'items', 'char_skills', 'char_masteries', 'char_hotbar', 'quest_state']) expect(b![t], t).toEqual(a![t])
  }, 60_000)
})
