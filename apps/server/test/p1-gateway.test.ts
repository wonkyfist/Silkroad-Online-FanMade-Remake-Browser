/**
 * docs/SERVER_ARCHITECTURE.md phase P1a: the client sockets in gateway processes (GATEWAYS=1) change no message. The same
 * scripted clients run against a server with the sockets in-process (GATEWAYS=0) and one with a gateway: every client's
 * whole message stream (lobby, bad frames, budgets, the world, chat, a strike-out) and its close code are the same. Then
 * the gateway's own duties: a crashed gateway is restarted and its players come back through the reconnect grace; a
 * shutdown reaches the clients through it; the frame codec round-trips.
 */
import { CLOSE_CODE, PROTOCOL_VERSION, type ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { FT, FrameReader, OutBatch, frame, readOut } from '../src/gateway/protocol.ts'
import { Client, api, sleep, startTestServer, type TestServer } from './helpers.ts'

const servers: TestServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stopAndClean()
})

async function server(gateways: number, logs?: string[]): Promise<TestServer> {
  const s = await startTestServer({ config: { gateways, helloTimeoutMs: 400, spawnMobs: false, resumeGraceS: 15 }, logs })
  servers.push(s)
  return s
}

async function account(base: string, username: string): Promise<string> {
  const r = await api(base, '/api/register', { username, password: 'password123' })
  if (r.status !== 201) throw new Error(JSON.stringify(r.json))
  return r.json.token as string
}

/** A message with the clock-dependent fields taken out (server time, the sky's clock and weather). */
function norm(m: ServerMessage): unknown {
  return JSON.parse(JSON.stringify(m), (k, v) => (k === 'serverTime' || k === 'clientTime' || k === 'clock' || k === 'weather' || k === 'winter' || k === 'lastPlayed' || k === 'server' ? undefined : v))
}

const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(10)
  }
}

/** The script: two players and a stranger, every answer awaited so the order of each stream is fixed by the script. */
async function script(s: TestServer): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  // a stranger that never says hello: refused at once
  const x = await Client.connect(s.url)
  x.send({ t: 'charList' })
  out.strangerClose = (await x.closed).code
  out.stranger = x.log.map(norm)
  // one that says nothing: the hello timeout
  const quiet = await Client.connect(s.url)
  out.quietClose = (await quiet.closed).code

  const a = await Client.login(s.url, await account(s.url, 'alpha'))
  const b = await Client.login(s.url, await account(s.url, 'bravo'))
  a.send({ t: 'charList' })
  await a.next('charList')
  a.send({ t: 'nameCheck', name: 'Hero' })
  await a.next('nameCheck')
  a.send({ t: 'charCreate', name: 'HeroA', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ca = (await a.next('charCreated')).character
  // the lobby budget (charList 2/s, burst 5): the 6th..10th are refused
  for (let i = 0; i < 10; i++) a.send({ t: 'charList' })
  await until(() => a.log.filter((m) => m.t === 'charList' || (m.t === 'error' && m.re === 'charList')).length >= 11)
  // bad frames: not JSON, binary, an unknown type, a known type with a stray key
  a.send('{')
  a.ws.send(Buffer.from([1, 2, 3]), { binary: true })
  a.send({ t: 'nope' })
  a.send({ t: 'ping', n: 1, clientTime: 5, extra: 1 })
  a.send({ t: 'ping', n: 2, clientTime: 6 })
  await a.next('pong')
  b.send({ t: 'charCreate', name: 'HeroB', model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'spear' })
  const cb = (await b.next('charCreated')).character
  a.send({ t: 'enterWorld', id: ca.id })
  await a.next('worldEnter')
  b.send({ t: 'enterWorld', id: cb.id })
  await b.next('worldEnter')
  await a.next('spawn', (m) => m.entity.name === 'HeroB')
  a.send({ t: 'chat', text: 'hello there' })
  await b.next('chat', (m) => m.text === 'hello there')
  // not staff: a gm frame is refused (and a strike)
  a.send({ t: 'gm', cmd: 'tp', args: ['spawn'] })
  await a.next('error', (m) => m.re === 'gm')
  // b floods: 150 frames at once; past the burst each one is a strike, the 20th closes the socket (4008)
  for (let i = 0; i < 150; i++) b.send({ t: 'ping', n: 100 + i, clientTime: 0 })
  out.floodClose = (await b.closed).code
  await a.next('despawn')
  a.send({ t: 'leaveWorld' })
  await a.next('worldLeft')
  a.close()
  out.aClose = (await a.closed).code
  out.a = a.log.map(norm)
  out.b = b.log.map(norm)
  return out
}

describe('P1a: gateway processes change no message (same script, GATEWAYS=0 vs 1)', () => {
  it('every client stream and close code is identical', async () => {
    const off = await script(await server(0))
    const s1 = await server(1)
    expect(s1.ctx.gateways?.snapshot().ready).toBe(1)
    const on = await script(s1)
    expect(on).toEqual(off)
    // the script really covered the cases
    expect(off.strangerClose).toBe(CLOSE_CODE.unauthorized)
    expect(off.quietClose).toBe(CLOSE_CODE.helloTimeout)
    expect(off.floodClose).toBe(CLOSE_CODE.abuse)
    const errs = (off.a as { t: string; code?: string }[]).filter((m) => m.t === 'error').map((m) => m.code)
    expect(errs).toEqual(expect.arrayContaining(['rate_limited', 'bad_request']))
    expect(errs.filter((c) => c === 'bad_request').length).toBeGreaterThanOrEqual(4)
    // the core counted the same frames as before (the gateway forwards every verdict); the gateway's own counters
    // arrive once a second
    await until(() => (s1.ctx.gateways!.snapshot().list[0]?.inFrames ?? 0) > 150, 5000)
    const net = s1.ctx.net.snapshot() as unknown as { in: Record<string, { n: number }>; gateways: { list: { inFrames: number; outFrames: number }[] } }
    expect(net.in.invalid?.n).toBeGreaterThanOrEqual(3)
    expect(net.gateways.list[0]!.inFrames).toBeGreaterThan(150)
    expect(net.gateways.list[0]!.outFrames).toBeGreaterThan(20)
  }, 60_000)
})

describe('P1a: gateway failures', () => {
  it('a crashed gateway restarts; its players are held for the grace and resume', async () => {
    const logs: string[] = []
    const s = await server(1, logs)
    const token = await account(s.url, 'charlie')
    const c = await Client.login(s.url, token)
    c.send({ t: 'charCreate', name: 'HeroC', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const enter = await c.next('worldEnter')
    const hub = s.ctx.gateways!
    expect(hub.crash(0)).toBeGreaterThan(0)
    const closed = await c.closed
    expect(closed.code).toBe(1006)
    // the world kept the character (a dropped socket, not a logout)
    await until(() => s.ctx.holds.isHeld(ch.id))
    expect(logs.some((l) => l.includes('socket error gateway exit'))).toBe(true)
    await until(() => hub.snapshot().ready === 1 && hub.snapshot().restarts === 1, 10_000)
    const c2 = await Client.login(s.url, token)
    c2.send({ t: 'enterWorld', id: ch.id })
    const again = await c2.next('worldEnter')
    expect(again.self.pos).toEqual(enter.self.pos)
    expect(logs.some((l) => l.includes('HeroC reconnected: resumed'))).toBe(true)
    c2.close()
  }, 30_000)

  it('a shutdown reaches the clients through the gateway (notice, then 4009)', async () => {
    const s = await startTestServer({ config: { gateways: 1, spawnMobs: false } })
    const c = await Client.login(s.url, await account(s.url, 'delta'))
    c.send({ t: 'charCreate', name: 'HeroD', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    const t0 = Date.now()
    await s.stopAndClean()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect((await c.closed).code).toBe(CLOSE_CODE.shutdown)
    expect(c.log.some((m) => m.t === 'chat' && m.text === 'The server is shutting down.')).toBe(true)
  }, 30_000)

  it('version mismatch and bad tokens close with their codes through the gateway', async () => {
    const s = await server(1)
    const c = await Client.connect(s.url)
    c.send({ t: 'hello', version: PROTOCOL_VERSION + 1, token: 'x' })
    expect((await c.closed).code).toBe(CLOSE_CODE.versionMismatch)
    const d = await Client.connect(s.url)
    d.send({ t: 'hello', version: PROTOCOL_VERSION, token: 'not-a-token' })
    expect((await d.closed).code).toBe(CLOSE_CODE.unauthorized)
  }, 30_000)
})

describe('P1a: the core <-> gateway frames', () => {
  it('an OUT batch keeps every record and its order; one payload per run of recipients', () => {
    const b = new OutBatch()
    const p1 = Buffer.from('{"t":"a"}')
    const p2 = Buffer.from('{"t":"bé"}')
    b.msg(1, p1)
    b.msg(2, p1)
    b.msg(3, p1)
    b.msg(1, p2)
    b.close(2, 4011, 'not reading')
    b.msg(1, p1)
    const f = b.take()
    expect(b.empty).toBe(true)
    const got: unknown[] = []
    new FrameReader((type, body) => {
      expect(type).toBe(FT.out)
      readOut(body, (payload, conns) => got.push([payload.toString(), [...conns]]), (conn, code, reason) => got.push(['close', conn, code, reason]))
    }).push(f)
    expect(got).toEqual([['{"t":"a"}', [1, 2, 3]], ['{"t":"bé"}', [1]], ['close', 2, 4011, 'not reading'], ['{"t":"a"}', [1]]])
  })

  it('the reader reassembles frames split anywhere', () => {
    const frames = [frame(FT.in, Buffer.from('[["o",1]]')), frame(FT.ready), frame(FT.stats, Buffer.alloc(70_000, 65))]
    const all = Buffer.concat(frames)
    for (const cut of [1, 3, 4, 5, 9, 17, 4000]) {
      const seen: [number, number][] = []
      const r = new FrameReader((type, body) => seen.push([type, body.length]))
      for (let o = 0; o < all.length; o += cut) r.push(all.subarray(o, o + cut))
      expect(seen).toEqual([[FT.in, 9], [FT.ready, 0], [FT.stats, 70_000]])
    }
  })
})
