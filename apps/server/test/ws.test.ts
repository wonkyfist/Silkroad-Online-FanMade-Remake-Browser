import { CLOSE_CODE, MAX_CHARACTER_SLOTS, PROTOCOL_VERSION } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const SPAWN: [number, number, number] = [100, 2, -50]
const BOUNDS = { minX: 0, minZ: -192, maxX: 192, maxZ: 0 }
const SPEED = 20

let s: TestServer

beforeAll(async () => {
  s = await startTestServer({
    config: { moveSpeed: SPEED, tickHz: 20, helloTimeoutMs: 300 },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: { min: [BOUNDS.minX, 0, BOUNDS.minZ], max: [BOUNDS.maxX, 0, BOUNDS.maxZ] } }),
    },
  })
})

afterAll(async () => {
  await s.stopAndClean()
})

let nameCounter = 0
const uniqueName = (prefix = 'Hero') => `${prefix}${++nameCounter}`

async function createChar(c: Client, name = uniqueName(), model = 'CHAR_CH_MAN_ADVENTURER') {
  c.send({ t: 'charCreate', name, model, weapon: 'blade' })
  return (await c.next('charCreated')).character
}

/** Fresh account + character, entered into the world. */
async function player(prefix = 'p') {
  const acc = await newAccount(s.url, prefix)
  const c = await Client.login(s.url, acc.token)
  const ch = await createChar(c)
  c.send({ t: 'enterWorld', id: ch.id })
  const enter = await c.next('worldEnter')
  return { c, ch, acc, enter }
}

async function leaveAll(...cs: Client[]) {
  for (const c of cs) {
    c.close()
    await c.closed
  }
  await sleep(20)
}

describe('hello', () => {
  it('welcomes a valid token', async () => {
    const acc = await newAccount(s.url)
    const c = await Client.connect(s.url)
    c.send({ t: 'hello', version: PROTOCOL_VERSION, token: acc.token })
    const w = await c.next('welcome')
    expect(w.account).toBe(acc.username)
    expect(w.slots).toBe(MAX_CHARACTER_SLOTS)
    expect(w.server.name).toBe('Jangan')
    await leaveAll(c)
  })

  it('rejects a bad token', async () => {
    const c = await Client.connect(s.url)
    c.send({ t: 'hello', version: PROTOCOL_VERSION, token: 'not-a-real-token' })
    expect((await c.next('error')).code).toBe('unauthorized')
    expect((await c.closed).code).toBe(CLOSE_CODE.unauthorized)
  })

  it('rejects the wrong protocol version', async () => {
    const acc = await newAccount(s.url)
    const c = await Client.connect(s.url)
    c.send({ t: 'hello', version: PROTOCOL_VERSION + 1, token: acc.token })
    expect((await c.next('error')).code).toBe('version_mismatch')
    expect((await c.closed).code).toBe(CLOSE_CODE.versionMismatch)
  })

  it('requires hello first and closes silent sockets', async () => {
    const c = await Client.connect(s.url)
    c.send({ t: 'charList' })
    expect((await c.next('error')).code).toBe('unauthorized')
    expect((await c.closed).code).toBe(CLOSE_CODE.unauthorized)

    const silent = await Client.connect(s.url)
    expect((await silent.closed).code).toBe(CLOSE_CODE.helloTimeout)
  })

  it('keeps one socket per account (a new login kicks the old one)', async () => {
    const watcher = await player('watch')
    const a = await player('kick')
    await watcher.c.next('spawn', (m) => m.entity.id === a.enter.self.id)
    const second = await Client.login(s.url, a.acc.token)
    expect((await a.c.next('error')).code).toBe('unauthorized')
    expect((await a.c.closed).code).toBe(CLOSE_CODE.replaced)
    await watcher.c.next('despawn', (m) => m.id === a.enter.self.id)
    second.send({ t: 'charList' })
    expect((await second.next('charList')).characters).toHaveLength(1)
    await leaveAll(second, watcher.c)
  })
})

describe('characters', () => {
  it('validates names, enforces case-insensitive uniqueness, slots, and soft delete frees the name', async () => {
    const a = await Client.login(s.url, (await newAccount(s.url)).token)
    const b = await Client.login(s.url, (await newAccount(s.url)).token)

    for (const bad of ['ab', '1abc', 'has space', 'a'.repeat(13), 'Admin', '']) {
      a.send({ t: 'nameCheck', name: bad })
      const r = await a.next('nameCheck')
      expect(r.available, bad).toBe(false)
      expect(r.reason).toBeTruthy()
      a.send({ t: 'charCreate', name: bad, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' })
      expect((await a.next('error')).code, bad).toBe('name_invalid')
    }

    a.send({ t: 'nameCheck', name: 'Mulan' })
    expect(await a.next('nameCheck')).toEqual({ t: 'nameCheck', name: 'Mulan', available: true })
    const mulan = await createChar(a, 'Mulan', 'CHAR_CH_WOMAN_ADVENTURER')
    expect(mulan).toMatchObject({ name: 'Mulan', model: 'CHAR_CH_WOMAN_ADVENTURER', level: 1, weapon: 'blade', location: 'Jangan', pos: SPAWN, lastPlayed: 0 })

    b.send({ t: 'nameCheck', name: 'MULAN' })
    expect((await b.next('nameCheck')).available).toBe(false)
    b.send({ t: 'charCreate', name: 'mulan', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'spear' })
    expect((await b.next('error')).code).toBe('name_taken')

    b.send({ t: 'charCreate', name: 'Valid', model: 'CHAR_EU_MAN_NOBLE', weapon: 'spear' })
    expect((await b.next('error')).code).toBe('bad_request')

    for (let i = 1; i < MAX_CHARACTER_SLOTS; i++) await createChar(a)
    a.send({ t: 'charCreate', name: uniqueName(), model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'bow' })
    expect((await a.next('error')).code).toBe('slots_full')
    a.send({ t: 'charList' })
    const list = await a.next('charList')
    expect(list.slots).toBe(MAX_CHARACTER_SLOTS)
    expect(list.characters.map((c) => c.name)).toContain('Mulan')
    expect(list.characters).toHaveLength(MAX_CHARACTER_SLOTS)

    // b cannot delete a's character
    b.send({ t: 'charDelete', id: mulan.id })
    expect((await b.next('error')).code).toBe('not_found')

    a.send({ t: 'charDelete', id: mulan.id })
    expect(await a.next('charDeleted')).toEqual({ t: 'charDeleted', id: mulan.id })
    a.send({ t: 'charList' })
    expect((await a.next('charList')).characters).toHaveLength(MAX_CHARACTER_SLOTS - 1)

    const again = await createChar(b, 'MuLan')
    expect(again.name).toBe('MuLan')
    // the deleted row is kept (soft delete)
    const row = s.ctx.store.db.prepare('SELECT deleted_at FROM characters WHERE id = ?').get(mulan.id) as { deleted_at: number }
    expect(row.deleted_at).toBeGreaterThan(0)
    await leaveAll(a, b)
  })
})

describe('world', () => {
  it('two players see each other spawn and despawn; new characters spawn at the spawn point', async () => {
    const a = await player('seeA')
    expect(a.enter.self.pos).toEqual(SPAWN)
    expect(a.enter.self.name).toBe(a.ch.name)
    expect(a.enter.world).toMatchObject({ name: 'jangan', tickRate: 20 })
    expect(Math.abs(a.enter.world.serverTime - Date.now())).toBeLessThan(1000)

    const b = await player('seeB')
    expect(b.enter.entities.map((e) => e.name)).toContain(a.ch.name)
    expect(b.enter.entities.map((e) => e.id)).not.toContain(b.enter.self.id)
    const spawn = await a.c.next('spawn', (m) => m.entity.id === b.enter.self.id)
    expect(spawn.entity).toMatchObject({ kind: 'player', name: b.ch.name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade', pos: SPAWN })

    const servers = await (await fetch(s.url + '/api/servers')).json()
    expect(servers[0].online).toBeGreaterThanOrEqual(2)

    b.c.send({ t: 'leaveWorld' })
    await b.c.next('worldLeft')
    await a.c.next('despawn', (m) => m.id === b.enter.self.id)

    // re-enter, then disconnect: despawn again
    b.c.send({ t: 'enterWorld', id: b.ch.id })
    const re = await b.c.next('worldEnter')
    await a.c.next('spawn', (m) => m.entity.id === re.self.id)
    b.c.close()
    await a.c.next('despawn', (m) => m.id === re.self.id)
    await leaveAll(a.c)
  })

  it('moveTo is authoritative: broadcast, interpolated position, stop on arrival, clamp to bounds', async () => {
    const a = await player('moveA')
    const b = await player('moveB')
    const id = a.enter.self.id

    const t0 = Date.now()
    a.c.send({ t: 'moveTo', x: 120, z: -50 })
    const mine = await a.c.next('move', (m) => m.id === id)
    const seen = await b.c.next('move', (m) => m.id === id)
    expect(seen).toEqual(mine)
    expect(mine.move.from).toEqual(SPAWN)
    expect(mine.move.to).toEqual([120, SPAWN[1], -50])
    expect(mine.move.speed).toBe(SPEED)
    expect(Math.abs(mine.move.startedAt - t0)).toBeLessThan(200)

    // redirect mid-way: the new move starts from the server's interpolated position
    await sleep(500)
    a.c.send({ t: 'moveTo', x: 100, z: -30 })
    const redirect = await b.c.next('move', (m) => m.id === id && m.move.to[2] === -30)
    const expected = SPAWN[0] + ((redirect.move.startedAt - mine.move.startedAt) / 1000) * SPEED
    expect(redirect.move.from[0]).toBeCloseTo(expected, 1)
    expect(redirect.move.from[0]).toBeGreaterThan(105)
    expect(redirect.move.from[0]).toBeLessThan(120)
    expect(redirect.move.from[2]).toBeCloseTo(-50, 5)
    // yaw faces the movement direction: atan2(dx, dz)
    const dx = 100 - redirect.move.from[0]
    const dz = -30 - redirect.move.from[2]

    const stop = await b.c.next('stop', (m) => m.id === id)
    expect(stop.pos).toEqual([100, SPAWN[1], -30])
    expect(stop.yaw).toBeCloseTo(Math.atan2(dx, dz), 5)
    const travel = Math.hypot(dx, dz) / SPEED
    expect(Date.now() - redirect.move.startedAt).toBeGreaterThanOrEqual(travel * 1000 - 5)

    // a late joiner sees an in-flight move in its snapshot
    a.c.send({ t: 'moveTo', x: 5000, z: 5000 })
    const clamped = await a.c.next('move', (m) => m.id === id && m.move.startedAt > redirect.move.startedAt)
    expect(clamped.move.to).toEqual([BOUNDS.maxX, SPAWN[1], BOUNDS.maxZ])
    const c = await player('moveC')
    const snap = c.enter.entities.find((e) => e.id === id)!
    expect(snap.move?.to).toEqual([BOUNDS.maxX, SPAWN[1], BOUNDS.maxZ])

    // moveTo outside the world is refused
    const acc = await newAccount(s.url)
    const lobby = await Client.login(s.url, acc.token)
    lobby.send({ t: 'moveTo', x: 1, z: 1 })
    expect((await lobby.next('error')).code).toBe('not_in_world')
    await leaveAll(a.c, b.c, c.c, lobby)
  })

  it('leave and re-enter restores the last position; disconnect saves mid-move', async () => {
    const a = await player('persist')
    a.c.send({ t: 'moveTo', x: 110, z: -40 })
    await a.c.next('stop')
    a.c.send({ t: 'leaveWorld' })
    await a.c.next('worldLeft')
    a.c.send({ t: 'charList' })
    const list = await a.c.next('charList')
    const saved = list.characters.find((c) => c.id === a.ch.id)!
    expect(saved.pos).toEqual([110, SPAWN[1], -40])
    expect(saved.lastPlayed).toBeGreaterThan(0)

    a.c.send({ t: 'enterWorld', id: a.ch.id })
    const back = await a.c.next('worldEnter')
    expect(back.self.pos).toEqual([110, SPAWN[1], -40])

    // walk 20 m (1 s) and drop the connection half-way
    a.c.send({ t: 'moveTo', x: 130, z: -40 })
    const m = await a.c.next('move')
    await sleep(500)
    a.c.close()
    await a.c.closed
    await sleep(50)
    const again = await Client.login(s.url, a.acc.token)
    again.send({ t: 'enterWorld', id: a.ch.id })
    const pos = (await again.next('worldEnter')).self.pos
    expect(pos[0]).toBeGreaterThan(115)
    expect(pos[0]).toBeLessThan(128)
    expect(pos[0]).toBeGreaterThanOrEqual(m.move.from[0])
    await leaveAll(again)
  })

  it('broadcasts local chat, strips control characters, and limits length and rate', async () => {
    const a = await player('chatA')
    const b = await player('chatB')
    a.c.send({ t: 'chat', text: 'hello\u0007 ‮world\u0000 ' })
    const got = await b.c.next('chat')
    expect(got).toEqual({ t: 'chat', channel: 'local', fromId: a.enter.self.id, from: a.ch.name, text: 'hello world' })
    expect((await a.c.next('chat')).text).toBe('hello world')

    a.c.send({ t: 'chat', text: 'x'.repeat(101) })
    expect((await a.c.next('error')).code).toBe('bad_request')
    a.c.send({ t: 'chat', text: '\u0001\u0002' })
    expect((await a.c.next('error')).code).toBe('bad_request')

    for (let i = 0; i < 8; i++) a.c.send({ t: 'chat', text: `spam ${i}` })
    expect((await a.c.next('error', (e) => e.re === 'chat')).code).toBe('rate_limited')
    await leaveAll(a.c, b.c)
  })

  it('answers ping with the server time', async () => {
    const a = await Client.login(s.url, (await newAccount(s.url)).token)
    a.send({ t: 'ping', n: 7, clientTime: 1234.5 })
    const pong = await a.next('pong')
    expect(pong.n).toBe(7)
    expect(pong.clientTime).toBe(1234.5)
    expect(Math.abs(pong.serverTime - Date.now())).toBeLessThan(1000)
    await leaveAll(a)
  })
})

describe('abuse', () => {
  it('rejects malformed, unknown and oversized frames', async () => {
    const a = await Client.login(s.url, (await newAccount(s.url)).token)
    const bad: unknown[] = [
      'not json',
      '[]',
      'null',
      { t: 'bogus' },
      { t: 'charList', extra: 1 },
      { t: 'moveTo', x: 'a', z: 1 },
      { t: 'moveTo', x: 1e9, z: 1 },
      { t: 'enterWorld', id: -1 },
      { t: 'enterWorld', id: 1.5 },
      { t: 'charCreate', name: 'Abc', model: '../../etc/passwd', weapon: 'blade' },
      { t: 'charCreate', name: 'Abc', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'gun' },
      { t: 'ping', n: 1 },
      JSON.stringify({ t: 'chat', text: 'x'.repeat(2000) }),
      Buffer.from([1, 2, 3]),
    ]
    for (const frame of bad) {
      a.send(frame)
      expect((await a.next('error')).code, String(typeof frame === 'string' ? frame.slice(0, 40) : JSON.stringify(frame))).toBe('bad_request')
    }
    expect(a.isClosed).toBe(false)
    // still usable
    a.send({ t: 'charList' })
    await a.next('charList')

    // above the transport limit the socket is closed outright
    a.send('x'.repeat(5000))
    expect((await a.closed).code).toBe(1009)
  })

  it('closes a socket that keeps sending garbage', async () => {
    const a = await Client.login(s.url, (await newAccount(s.url)).token)
    for (let i = 0; i < 25; i++) a.send('garbage')
    expect((await a.closed).code).toBe(CLOSE_CODE.abuse)
  })

  it('rate limits message floods', async () => {
    const a = await Client.login(s.url, (await newAccount(s.url)).token)
    for (let i = 0; i < 45; i++) a.send({ t: 'ping', n: i, clientTime: 0 })
    expect((await a.next('error')).code).toBe('rate_limited')
    await leaveAll(a)
  })
})
