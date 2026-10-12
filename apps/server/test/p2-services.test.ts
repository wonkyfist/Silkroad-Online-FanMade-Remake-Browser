/**
 * docs/SERVER_ARCHITECTURE.md phase P2: the internal bus (bus/transport.ts), the global services' host
 * (services/host.ts), the economy's transfer core (escrow, commit-then-ack holds, idempotency keys, restarts), the
 * directory, and the gm CLI's inbox while a server's DB writer owns the file.
 */
import { MessageChannel } from 'node:worker_threads'
import type { ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalBus, PortTransport } from '../src/bus/transport.ts'
import { runCli } from '../src/cli/gm.ts'
import { holdOutbound, isHeld } from '../src/services/hold.ts'
import { liveWriter } from '../src/services/account.ts'
import type { Player } from '../src/world.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { econHarness, joinAll, seedCharacters } from './p2-econ.ts'
import { seeded } from './fixtures.ts'

const servers: TestServer[] = []
const roots: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stopAndClean()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('the bus', () => {
  it('LocalBus: synchronous delivery in send order, requests, calls, errors', async () => {
    const bus = new LocalBus()
    const zone = bus.endpoint('zone:0')
    const svc = bus.endpoint('svc:test')
    const seen: string[] = []
    svc.on('note', (e) => seen.push(String(e.body)))
    svc.on('double', (e) => (e.body as number) * 2)
    svc.on('boom', () => {
      throw new Error('nope')
    })
    zone.send({ to: 'svc:test', k: 'note', body: 'a' })
    seen.push('between')
    zone.send({ to: 'svc:test', k: 'note', body: 'b' })
    expect(seen).toEqual(['a', 'between', 'b'])
    expect(zone.call('svc:test', 'double', 21)).toBe(42)
    await expect(zone.request({ to: 'svc:test', k: 'double', body: 4 })).resolves.toBe(8)
    await expect(zone.request({ to: 'svc:test', k: 'boom' })).rejects.toThrow('nope')
    expect(() => bus.endpoint('svc:test')).toThrow()
    const st = zone.stats()
    expect(st.sent).toBe(5)
    expect(st.errors).toBe(1)
    expect(st.queued).toBe(0)
  })

  it('PortTransport: requests across a MessageChannel, FIFO, timeouts, closing fails what is open', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = new PortTransport('zone:0', 'db', port1)
    const b = new PortTransport('db', 'zone:0', port2)
    const got: number[] = []
    b.on('n', (e) => got.push(e.body as number))
    b.on('echo', (e) => e.body)
    b.on('slow', () => new Promise((r) => setTimeout(() => r('late'), 200)))
    for (let i = 0; i < 50; i++) a.send({ to: 'db', k: 'n', body: i })
    await expect(a.request({ to: 'db', k: 'echo', body: { x: 1 } })).resolves.toEqual({ x: 1 })
    expect(got).toEqual(Array.from({ length: 50 }, (_, i) => i))
    await expect(a.request({ to: 'db', k: 'slow' }, 20)).rejects.toThrow('timed out')
    expect(a.stats().timeouts).toBe(1)
    const open = a.request({ to: 'db', k: 'slow' }, 0)
    expect(a.stats().queued).toBe(1)
    a.close()
    await expect(open).rejects.toThrow('closed')
    b.close()
  })
})

describe('commit-then-ack holds', () => {
  it('a held player gets everything later, in order; holds nest', () => {
    const got: string[] = []
    const p = { send: (m: ServerMessage) => got.push((m as { text: string }).text) } as unknown as Player
    p.send({ t: 'chat', channel: 'system', text: '1' })
    const r1 = holdOutbound(p)
    p.send({ t: 'chat', channel: 'system', text: '2' })
    const r2 = holdOutbound(p)
    p.send({ t: 'chat', channel: 'system', text: '3' })
    r1()
    r1()
    expect(got).toEqual(['1'])
    expect(isHeld(p)).toBe(true)
    r2()
    expect(got).toEqual(['1', '2', '3'])
    expect(isHeld(p)).toBe(false)
    p.send({ t: 'chat', channel: 'system', text: '4' })
    expect(got).toEqual(['1', '2', '3', '4'])
  })
})

function econ(on: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'sro-p2svc-'))
  roots.push(root)
  const h = econHarness({ root, writer: on, svcBus: on, seed: 4 })
  seedCharacters(h.store, 4, seeded(9))
  joinAll(h)
  return h
}

describe('the economy service', () => {
  it('a trade waits for its commit: escrow while pending, the result after the writer has it', async () => {
    const h = econ(true)
    const [a, b] = h.players
    const now = Date.now()
    h.req(a!, { t: 'tradeRequest', target: b!.p.id }, now)
    h.req(b!, { t: 'tradeRespond', from: a!.p.id, accept: true }, now)
    h.req(b!, { t: 'tradeGold', amount: 100 }, now)
    h.req(a!, { t: 'tradeLock' }, now)
    h.req(b!, { t: 'tradeLock' }, now)
    h.req(a!, { t: 'tradeAccept' }, now)
    h.req(b!, { t: 'tradeAccept' }, now)
    // in memory the gold moved; the clients have not heard it yet
    expect(h.gameplay.economy.inEscrow(a!.p.characterId)).toBe(true)
    expect(a!.inbox.some((m) => m.t === 'tradeEnd')).toBe(false)
    expect(h.gameplay.economy.stats().pending).toBe(1)
    const until = Date.now() + 5000
    while (!a!.inbox.some((m) => m.t === 'tradeEnd') && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
    expect(a!.inbox.find((m) => m.t === 'tradeEnd')).toMatchObject({ reason: 'done' })
    expect(b!.inbox.find((m) => m.t === 'tradeEnd')).toMatchObject({ reason: 'done' })
    expect(h.gameplay.economy.inEscrow(a!.p.characterId)).toBe(false)
    expect(h.store.writerStats()!.committed).toBe(h.store.writerStats()!.seq)
    h.store.close()
  })

  it('idempotency keys (SVC_BUS): a repeated transfer key answers the first outcome and runs nothing', () => {
    const h = econ(true)
    let runs = 0
    const [a, b] = h.players
    const first = h.gameplay.economy.transfer('test:1', [a!.p, b!.p], () => ++runs)
    const again = h.gameplay.economy.transfer('test:1', [a!.p, b!.p], () => ++runs)
    expect([first, again, runs]).toEqual([1, 1, 1])
    expect(h.gameplay.economy.stats().replays).toBe(1)
    h.store.close()
    const off = econ(false)
    off.gameplay.economy.transfer('test:1', [], () => ++runs)
    off.gameplay.economy.transfer('test:1', [], () => ++runs)
    expect(runs).toBe(3)
    off.store.close()
  })

  it('a restart mid-trade ends the open exchanges as failed; nothing moved', () => {
    const h = econ(true)
    const [a, b] = h.players
    const now = Date.now()
    const gold = (x: typeof a) => h.store.loadInventory(x!.p.characterId).gold
    const before = [gold(a), gold(b)]
    h.req(a!, { t: 'tradeRequest', target: b!.p.id }, now)
    h.req(b!, { t: 'tradeRespond', from: a!.p.id, accept: true }, now)
    h.req(b!, { t: 'tradeGold', amount: 100 }, now)
    h.req(a!, { t: 'tradeLock' }, now)
    h.req(b!, { t: 'tradeLock' }, now)
    h.req(a!, { t: 'tradeAccept' }, now)
    expect(h.gameplay.services!.restart('economy')).toBe(1)
    expect(h.gameplay.trade.isTrading(a!.p)).toBe(false)
    h.store.flush()
    expect(a!.inbox.at(-1)).toMatchObject({ t: 'tradeEnd', reason: 'failed', message: 'The exchange was interrupted.' })
    h.req(b!, { t: 'tradeAccept' }, now)
    expect(b!.inbox.at(-1)).toMatchObject({ t: 'actionResult', re: 'tradeAccept', ok: false })
    expect([gold(a), gold(b)]).toEqual(before)
    expect(h.gameplay.services!.stats().economy.restarts).toBe(1)
    h.store.close()
  })

  it('the item mall is a placeholder service; the directory finds characters', () => {
    const h = econ(true)
    expect(h.gameplay.services!.call('mall', 'catalog')).toEqual([])
    expect(h.gameplay.services!.call('mall', 'buy', { sku: 'x' })).toMatchObject({ ok: false })
    const x = h.players[2]!
    expect(h.world.byCharacter(x.p.characterId)).toBe(x.p)
    h.world.remove(x.p.id)
    expect(h.world.byCharacter(x.p.characterId)).toBeUndefined()
    h.store.close()
  })
})

describe('the gm CLI with a DB writer', () => {
  it('grant goes through the running server inbox: applied, journaled, the client told', async () => {
    const s = await startTestServer({ config: { dbWriter: true, svcBus: true, spawnMobs: false } })
    servers.push(s)
    expect(liveWriter(s.ctx.config.dataDir)).toBe(process.pid)
    const acc = await newAccount(s.url, 'inbox')
    const c = await Client.login(s.url, acc.token)
    const role = c.next('role', () => true, 8000)
    const out: string[] = []
    const code = await runCli(['grant', acc.username], { DATA_DIR: s.ctx.config.dataDir }, (l) => out.push(l), (l) => out.push(l))
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('player -> gm')
    expect(await role).toEqual({ t: 'role', role: 'gm' })
    expect(s.ctx.store.accountByName(acc.username)!.role).toBe('gm')
    // the change is the server's own write: on the file after the next commit
    expect(s.ctx.store.flush()).toBe(true)
    expect((s.ctx.store.writerStats()!).external).toBe(0)
    c.close()
  }, 30_000)
})
