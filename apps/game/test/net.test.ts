import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '@sro/shared'
import { GameError } from '../src/net/api.ts'
import { sampleMove, ServerClock, yawOf } from '../src/net/clock.ts'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { Session, type StatusEvent } from '../src/net/session.ts'
import type { Wire } from '../src/net/wire.ts'

function memory(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

function waitFor<T extends ServerMessage['t']>(s: Session, t: T, ms = 2000): Promise<Extract<ServerMessage, { t: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), ms)
    const off = s.on(msg => {
      if (msg.t === t) {
        clearTimeout(timer)
        off()
        resolve(msg as Extract<ServerMessage, { t: T }>)
      }
    })
  })
}

function waitStatus(s: Session, pred: (ev: StatusEvent) => boolean, ms = 3000): Promise<StatusEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for status')), ms)
    const off = s.onStatus(ev => {
      if (pred(ev)) {
        clearTimeout(timer)
        off()
        resolve(ev)
      }
    })
  })
}

async function loggedIn(server: MockServer, name = 'alice'): Promise<Session> {
  await server.register({ username: name, password: 'secret' })
  const { token } = await server.login({ username: name, password: 'secret' })
  const s = new Session(() => server.wire(), token)
  await s.connect()
  return s
}

describe('ServerClock / sampleMove', () => {
  it('estimates the offset from the lowest-rtt pong', () => {
    let now = 1000
    const clock = new ServerClock(() => now)
    clock.seed(50_000)
    expect(clock.offset).toBe(49_000)
    now = 1100 // rtt 100: offset = 60_050 + 50 - 1100
    clock.pong(1000, 60_050)
    expect(clock.offset).toBe(59_000)
    now = 2400 // rtt 400: worse sample (its offset within what the round trip explains), ignored
    clock.pong(2000, 61_250)
    expect(clock.offset).toBe(59_000)
    expect(clock.serverNow()).toBe(2400 + 59_000)
    // W9F F1: an offset further off than any round trip explains is a clock step: the next pong corrects it.
    now = 3500 // rtt 100, the server clock stepped 10 s
    clock.pong(3400, 72_400)
    expect(clock.offset).toBe(72_400 + 50 - 3500)
  })

  it('interpolates a move linearly and clamps at the target', () => {
    const move = { from: [0, 0, 0] as [number, number, number], to: [3, 0, 4] as [number, number, number], speed: 5, startedAt: 10_000 }
    expect(sampleMove(move, 9_000).pos).toEqual([0, 0, 0])
    const half = sampleMove(move, 10_500)
    expect(half.pos[0]).toBeCloseTo(1.5)
    expect(half.pos[2]).toBeCloseTo(2)
    expect(half.arrived).toBe(false)
    expect(half.dir[0]).toBeCloseTo(0.6)
    const end = sampleMove(move, 12_000)
    expect(end.pos).toEqual([3, 0, 4])
    expect(end.arrived).toBe(true)
  })

  it('yaw 0 faces +Z, +pi/2 faces +X', () => {
    expect(yawOf(0, 1)).toBeCloseTo(0)
    expect(yawOf(1, 0)).toBeCloseTo(Math.PI / 2)
  })
})

describe('MockServer + Session (protocol v1)', () => {
  it('registers, logs in, rejects bad credentials', async () => {
    const server = new MockServer(memory(), 0)
    await server.register({ username: 'bob', password: 'pw1234' })
    await expect(server.register({ username: 'BOB', password: 'x123456' })).rejects.toMatchObject({ code: 'name_taken' })
    await expect(server.login({ username: 'bob', password: 'nope' })).rejects.toBeInstanceOf(GameError)
    const res = await server.login({ username: 'bob', password: 'pw1234' })
    expect(res.token).toMatch(/^mock-/)
    expect((await server.servers()).length).toBeGreaterThan(0)
  })

  it('refuses a bad token at hello', async () => {
    const server = new MockServer(memory(), 0)
    const s = new Session(() => server.wire(), 'bogus')
    await expect(s.connect()).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('creates, lists and deletes characters with name checks and slot limits', async () => {
    const server = new MockServer(memory(), 0)
    const s = await loggedIn(server)
    expect((await s.request({ t: 'charList' }, ['charList'])).characters).toEqual([])
    expect((await s.request({ t: 'nameCheck', name: '1bad' }, ['nameCheck'])).available).toBe(false)
    expect((await s.request({ t: 'nameCheck', name: 'Hero' }, ['nameCheck'])).available).toBe(true)
    const created = await s.request({ t: 'charCreate', name: 'Hero', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' }, ['charCreated'])
    expect(created.character).toMatchObject({ name: 'Hero', level: 1, weapon: 'blade', model: 'CHAR_CH_MAN_ADVENTURER' })
    await expect(s.request({ t: 'charCreate', name: 'hero', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'bow' }, ['charCreated'])).rejects.toMatchObject({ code: 'name_taken' })
    for (const n of ['Two', 'Three', 'Four']) await s.request({ t: 'charCreate', name: n, model: 'CHAR_CH_WOMAN_FOX', weapon: 'bow' }, ['charCreated'])
    await expect(s.request({ t: 'charCreate', name: 'Five', model: 'CHAR_CH_WOMAN_FOX', weapon: 'bow' }, ['charCreated'])).rejects.toMatchObject({ code: 'slots_full' })
    await s.request({ t: 'charDelete', id: created.character.id }, ['charDeleted'])
    expect((await s.request({ t: 'charList' }, ['charList'])).characters.map(c => c.name)).toEqual(['Two', 'Three', 'Four'])
    s.close()
  })

  it('enters the world, moves, chats, leaves', async () => {
    const server = new MockServer(memory(), 0)
    const s = await loggedIn(server)
    const { character } = await s.request({ t: 'charCreate', name: 'Walker', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'spear' }, ['charCreated'])
    const enter = await s.request({ t: 'enterWorld', id: character.id }, ['worldEnter'])
    expect(enter.self.name).toBe('Walker')
    expect(enter.entities.length).toBeGreaterThan(0)
    expect(enter.world.serverTime).toBeGreaterThan(Date.now())

    const moved = waitFor(s, 'move')
    s.send({ t: 'moveTo', x: 10, z: -5 })
    const m = await moved
    expect(m.id).toBe(enter.self.id)
    expect(m.move.to[0]).toBe(10)
    expect(m.move.to[2]).toBe(-5)
    expect(m.move.speed).toBeGreaterThan(0)

    const said = waitFor(s, 'chat')
    s.send({ t: 'chat', text: 'test message' })
    expect(await said).toMatchObject({ channel: 'local', fromId: enter.self.id, text: 'test message' })

    await s.request({ t: 'leaveWorld' }, ['worldLeft'])
    await expect(s.request({ t: 'moveTo', x: 0, z: 0 }, ['move'], 500)).rejects.toMatchObject({ code: 'not_in_world' })
    s.close()
  })

  it('does not reconnect after a fatal close code (replaced)', async () => {
    let opened = 0
    let wire: Wire | null = null
    const factory = (): Wire => {
      opened++
      const w: Wire = {
        onOpen: () => {},
        onMessage: () => {},
        onClose: () => {},
        send: msg => {
          if (msg.t === 'hello') setTimeout(() => w.onMessage({ t: 'welcome', account: 'a', server: { id: 's', name: 's', status: 'online', online: 1, capacity: 1 }, slots: 4 }), 0)
        },
        close: () => {},
      }
      setTimeout(() => w.onOpen(), 0)
      wire = w
      return w
    }
    const s = new Session(factory, 'tok')
    await s.connect()
    const closed = waitStatus(s, ev => ev.status === 'closed')
    wire!.onClose({ clean: false, code: 4000, reason: '' })
    expect(await closed).toMatchObject({ reason: 'replaced' })
    await new Promise(r => setTimeout(r, 700))
    expect(opened).toBe(1)
  })

  it('reconnects after a network drop and reports resumed', async () => {
    const server = new MockServer(memory(), 0)
    const s = await loggedIn(server)
    const reconnecting = waitStatus(s, ev => ev.status === 'reconnecting')
    const resumed = waitStatus(s, ev => ev.status === 'online' && !!ev.resumed)
    server.dropAll()
    await reconnecting
    await resumed
    expect((await s.request({ t: 'charList' }, ['charList'])).slots).toBe(4)
    s.close()
  })
})
