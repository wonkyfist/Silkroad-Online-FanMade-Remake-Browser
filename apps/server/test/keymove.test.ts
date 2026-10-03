/**
 * MV-WASD (docs/MOVEMENT.md §13): walking with the keys reuses `moveTo` (no protocol change). The client
 * (apps/game world/features/keymove.ts) sends, while a key is held, a target LOOKAHEAD (1 s of walking) ahead of its
 * predicted point: at once on a turn, else a keep-alive every 250 ms, through a bucket of 3 that refills at 10/s, and
 * on release its own stop point (the turn burst here is the steady 10/s). This pins what the server does with that
 * stream:
 * - over real WebSockets (the strict validator, the 20/s message budget): a 3 s walk with a turn, a jump while running
 *   and pings is accepted with no error, a friend sees one continuous walk (each move starts on the last one's line
 *   at its start time, no stop until the release) and the walker stops exactly on the release point;
 * - the budget still refuses a flood (`rate_limited`), so a broken client cannot spam moves;
 * - on a navmesh-like validator the stream never crosses a blocked edge: every step is clipped by the server.
 */
import type { MoveState, ServerMessage, Vec3 } from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DROPS, ITEMS, LEVELS, MANGNYANG, contentFiles } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { npcHarness, type NpcHarness } from './npc-harness.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** The client's cadence (world/features/keymove.ts): kept here as numbers, the server owns no client code. */
const LOOKAHEAD_S = 1
const MIN_SEND_MS = 100
const KEEPALIVE_MS = 250
const SPEED = 5.5

/** Where a move is at server time `t` (the clients' sampleMove). */
function at(m: MoveState, t: number): Vec3 {
  const dx = m.to[0] - m.from[0]
  const dz = m.to[2] - m.from[2]
  const d = Math.hypot(dx, dz)
  const f = d > 0 ? Math.min(1, (Math.max(0, t - m.startedAt) / 1000) * m.speed / d) : 1
  return [m.from[0] + dx * f, m.from[1], m.from[2] + dz * f]
}

describe('a key walk over the wire', () => {
  const SPAWN: [number, number, number] = [50, 0, -50]
  let t: TestServer

  beforeAll(async () => {
    t = await startTestServer({
      config: { moveSpeed: SPEED, tickHz: 20, viewRange: 60, spawnMobs: false },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({ mobs: [MANGNYANG], nests: [], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: [], shops: [] }),
      },
    })
  })
  afterAll(async () => {
    await t.stopAndClean()
  })

  let n = 0
  async function player() {
    const acc = await newAccount(t.url, 'wasd')
    const c = await Client.login(t.url, acc.token)
    c.send({ t: 'charCreate', name: `Walker${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const enter = await c.next('worldEnter')
    return { c, id: enter.self.id, pos: enter.self.pos }
  }

  it('the stream is accepted within the budget; a friend sees one continuous walk; it stops on the release point', async () => {
    const a = await player()
    const b = await player()
    await a.c.next('spawn', (m) => m.entity.id === b.id)
    // The client side, simulated on the wall clock: the predicted point walks at SPEED from the start.
    const start = a.pos
    let dir = { x: 1, z: 0 }
    let p = { x: start[0], z: start[2] }
    let last = Date.now()
    let sentAt = -Infinity
    let sentDir = { x: 0, z: 0 }
    const t0 = Date.now()
    let sends = 0
    let pinged = 0
    let jumped = false
    while (Date.now() - t0 < 3000) {
      await sleep(15)
      const now = Date.now()
      p = { x: p.x + dir.x * SPEED * ((now - last) / 1000), z: p.z + dir.z * SPEED * ((now - last) / 1000) }
      last = now
      const el = now - t0
      // A camera drag from 1.0 s to 1.6 s: 90° to the left (-z, away from the bounds edge at z = 0).
      if (el > 1000 && el < 1600) {
        const a2 = (-Math.PI / 2) * Math.min(1, (el - 1000) / 600)
        dir = { x: Math.cos(a2), z: Math.sin(a2) }
      }
      const turned = Math.acos(Math.max(-1, Math.min(1, dir.x * sentDir.x + dir.z * sentDir.z))) >= (4 * Math.PI) / 180
      if (now - sentAt >= MIN_SEND_MS && (turned || now - sentAt >= KEEPALIVE_MS)) {
        a.c.send({ t: 'moveTo', x: Math.round((p.x + dir.x * SPEED * LOOKAHEAD_S) * 100) / 100, z: Math.round((p.z + dir.z * SPEED * LOOKAHEAD_S) * 100) / 100 })
        sentAt = now
        sentDir = dir
        sends++
      }
      if (el > 2000 && !jumped) {
        a.c.send({ t: 'jump' })
        jumped = true
      }
      if (el > pinged * 1000) {
        a.c.send({ t: 'ping', n: pinged, clientTime: now })
        pinged++
      }
    }
    // Release: the stop point (the client's run-on is a few cm along its walk).
    await sleep(Math.max(0, MIN_SEND_MS - (Date.now() - sentAt)))
    const stop = { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 }
    a.c.send({ t: 'moveTo', x: stop.x, z: stop.z })
    const own = await a.c.next('stop', (m) => m.id === a.id && Math.hypot(m.pos[0] - stop.x, m.pos[2] - stop.z) < 0.01, 3000)
    await sleep(200)

    // Within the budget: no error at all, still connected, the jump accepted while running.
    expect(sends).toBeGreaterThanOrEqual(14)
    expect(sends).toBeLessThanOrEqual(31)
    expect(a.c.log.filter((m) => m.t === 'error')).toEqual([])
    expect(a.c.isClosed).toBe(false)
    expect(a.c.log.some((m) => m.t === 'actionResult' && m.re === 'jump' && m.ok)).toBe(true)
    expect(a.c.log.filter((m) => m.t === 'pong').length).toBe(pinged)
    // The friend: one move per send, no stop before the release, each move starting on the previous one's line.
    const seen = b.c.log.filter((m): m is Msg<'move'> | Msg<'stop'> => (m.t === 'move' || m.t === 'stop') && m.id === a.id)
    const moves = seen.filter((m): m is Msg<'move'> => m.t === 'move')
    expect(moves.length).toBe(sends + 1)
    expect(seen.findIndex((m) => m.t === 'stop')).toBe(seen.length - 1)
    for (let i = 1; i < moves.length; i++) {
      const prev = moves[i - 1]!.move
      const next = moves[i]!.move
      const there = at(prev, next.startedAt)
      expect(Math.hypot(there[0] - next.from[0], there[2] - next.from[2])).toBeLessThan(0.02)
      expect(next.speed).toBe(SPEED)
    }
    // Every keep-alive target was still ahead when the next one came (the walk never ran out: no stutter).
    for (let i = 1; i < moves.length - 1; i++) {
      const prev = moves[i - 1]!.move
      const reach = prev.startedAt + (Math.hypot(prev.to[0] - prev.from[0], prev.to[2] - prev.from[2]) / prev.speed) * 1000
      expect(reach).toBeGreaterThan(moves[i]!.move.startedAt)
    }
    // It stopped on the release point, which the friend sees too.
    expect(own.pos[0]).toBeCloseTo(stop.x, 2)
    expect(own.pos[2]).toBeCloseTo(stop.z, 2)
    expect((seen.at(-1) as Msg<'stop'>).pos).toEqual(own.pos)
    a.c.close()
    b.c.close()
    await Promise.all([a.c.closed, b.c.closed])
  })

  it('the message budget still refuses a flood of moves (rate_limited), never the client cadence', async () => {
    const a = await player()
    for (let i = 0; i < 60; i++) a.c.send({ t: 'moveTo', x: SPAWN[0] + (i % 2), z: SPAWN[2] })
    const err = await a.c.next('error', (m) => m.code === 'rate_limited')
    expect(err.message).toMatch(/too many/)
    expect(a.c.isClosed).toBe(false)
    a.c.close()
    await a.c.closed
  })
})

describe('a key walk against blocked edges (server validation)', () => {
  const harnesses: NpcHarness[] = []
  afterEach(() => {
    while (harnesses.length) harnesses.pop()!.close()
  })

  it('every step of the stream is clipped at the wall: the walker never passes it, and stops on it', () => {
    // A wall at x = 210 (the validator clips every straight walk 2 cm before it, like the navmesh's blocking edges).
    const WALL = 210
    const h = npcHarness({
      validator: (from, to) => {
        if (to[0] <= WALL - 0.02 || from[0] >= WALL) return to
        const f = (WALL - 0.02 - from[0]) / (to[0] - from[0])
        return [from[0] + (to[0] - from[0]) * f, to[1], from[2] + (to[2] - from[2]) * f]
      },
    })
    harnesses.push(h)
    const e = h.enter([200, 0, 200])
    // W + D at 45° toward the wall for 4 s: a keep-alive every 250 ms, 4.1 m ahead of the predicted point.
    const dir = { x: Math.SQRT1_2, z: Math.SQRT1_2 }
    let p = { x: 200, z: 200 }
    let worst = -Infinity
    for (let i = 0; i < 16; i++) {
      const look = 5 * LOOKAHEAD_S
      expect(h.gameplay.onMoveTo(e.p, h.now())).toBe(true)
      h.world.moveTo(e.p, p.x + dir.x * look, p.z + dir.z * look, h.now())
      for (let k = 0; k < 5; k++) {
        h.advance(50)
        worst = Math.max(worst, h.world.positionAt(e.p, h.now())[0])
      }
      p = { x: Math.min(WALL - 0.02, p.x + dir.x * 5 * 0.25), z: p.z + dir.z * 5 * 0.25 }
    }
    expect(worst).toBeLessThan(WALL)
    expect(worst).toBeGreaterThan(WALL - 0.05)
    const moves = e.inbox.filter((m): m is Msg<'move'> => m.t === 'move' && m.id === e.p.id)
    expect(moves.length).toBeGreaterThan(0)
    for (const m of moves) expect(m.move.to[0]).toBeLessThan(WALL)
  })
})
