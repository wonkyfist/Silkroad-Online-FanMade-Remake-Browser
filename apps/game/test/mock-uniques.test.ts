/** The mock's unique notices (?mock=1&gm=1; docs/WAVE_PLAN7.md §3.1, lane W11-P), so U-H and TL-C run before U-S. */
import { describe, expect, it } from 'vitest'
import { parseClientMessage, parseServerMessage, type ServerMessage } from '@sro/shared'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { DEFAULT_MOCK_EXTENSIONS } from '../src/net/mock/index.ts'
import { movementMock } from '../src/net/mock/movement.ts'
import { MOCK_UNIQUE_DEFEAT_MS, uniquesMock } from '../src/net/mock/uniques.ts'
import { Session } from '../src/net/session.ts'
import type { Wire } from '../src/net/wire.ts'

type Ctx = Parameters<NonNullable<typeof uniquesMock.handle>>[0]
type Conn = Parameters<NonNullable<typeof uniquesMock.handle>>[1]

function rig(role: 'gm' | 'player' = 'gm') {
  const broadcast: ServerMessage[] = []
  const sent: ServerMessage[] = []
  let now = 5_000_000
  const ctx = {
    content: { mobs: new Map([['MOB_CH_TIGERWOMAN', { name: 'Tiger Girl' }]]) },
    now: () => now,
    selfOf: () => ({ state: { name: 'Mei' } }),
    send: (_c: unknown, m: ServerMessage) => sent.push(m),
    broadcast: (m: ServerMessage) => broadcast.push(m),
  } as unknown as Ctx
  const conn = { role } as Conn
  const chat = (text: string) => uniquesMock.handle!(ctx, conn, { t: 'chat', text })
  const tick = (t: number) => {
    now = t
    uniquesMock.tick!(ctx, t)
  }
  return { ctx, conn, chat, tick, broadcast, sent, now: () => now }
}

const valid = (m: ServerMessage) => {
  const r = parseServerMessage(JSON.stringify(m))
  if (!r.ok) throw new Error(r.error)
  expect(r.msg).toEqual(m)
}

describe('mock unique notices (unit)', () => {
  it('is registered once, before the jump mock (the jump mock stays 4th from the end)', () => {
    expect(DEFAULT_MOCK_EXTENSIONS.filter((x) => x === uniquesMock)).toHaveLength(1)
    expect(DEFAULT_MOCK_EXTENSIONS.indexOf(uniquesMock)).toBe(DEFAULT_MOCK_EXTENSIONS.indexOf(movementMock) - 1)
  })

  it('/unique spawn: appeared at once, defeated by the party 20 s later, every frame valid', () => {
    const { chat, tick, broadcast, sent, now } = rig()
    const t0 = now()
    expect(chat('/unique spawn tiger')).toBe(true)
    expect(broadcast).toEqual([{ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', area: 'North-Tiger Mt.' }])
    expect(sent).toMatchObject([{ t: 'gmResult', ok: true, cmd: 'unique' }])
    tick(t0 + MOCK_UNIQUE_DEFEAT_MS - 1)
    expect(broadcast).toHaveLength(1)
    tick(t0 + MOCK_UNIQUE_DEFEAT_MS)
    expect(broadcast[1]).toEqual({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei', party: true })
    tick(t0 + 3 * MOCK_UNIQUE_DEFEAT_MS)
    expect(broadcast).toHaveLength(2)
    broadcast.forEach(valid)
  })

  it('one alive: a second spawn is refused; /unique kill defeats at once (solo form)', () => {
    const { chat, tick, broadcast, sent, now } = rig()
    chat('/unique spawn')
    chat('/unique spawn Tiger Girl')
    expect(sent[1]).toMatchObject({ t: 'gmResult', ok: false })
    chat('/unique kill')
    expect(broadcast[1]).toEqual({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei', party: false })
    tick(now() + MOCK_UNIQUE_DEFEAT_MS)
    expect(broadcast).toHaveLength(2)
    chat('/unique kill')
    expect(sent.at(-1)).toMatchObject({ ok: false })
    broadcast.forEach(valid)
  })

  it('refuses players, unknown names; answers list and usage; ignores other chat', () => {
    const p = rig('player')
    expect(p.chat('/unique spawn')).toBe(true)
    expect(p.sent).toEqual([{ t: 'error', code: 'forbidden', message: 'GM commands need a GM account.', re: 'chat' }])
    expect(p.broadcast).toEqual([])
    const g = rig()
    g.chat('/unique spawn lord_yarkan')
    g.chat('/unique list')
    g.chat('/unique')
    expect(g.sent.map((m) => m.t === 'gmResult' && m.ok)).toEqual([false, true, false])
    expect(g.broadcast).toEqual([])
    expect(g.chat('/uniques')).toBe(false)
    expect(g.chat('hello /unique spawn')).toBe(false)
    expect(uniquesMock.handle!(g.ctx, g.conn, { t: 'chat', text: '/unique spawn', to: 'Bob' })).toBe(false)
    expect(uniquesMock.handle!(g.ctx, g.conn, { t: 'jump' })).toBe(false)
  })
})

function memory(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

/** The mock's wire, with both directions through the real parsers. */
function validating(inner: Wire): Wire {
  const w: Wire = {
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => {},
    send: (msg) => {
      const r = parseClientMessage(JSON.stringify(msg))
      if (!r.ok) throw new Error(`client frame rejected: ${r.error}`)
      inner.send(msg)
    },
    close: () => inner.close(),
  }
  inner.onOpen = () => w.onOpen()
  inner.onMessage = (msg) => {
    const r = parseServerMessage(JSON.stringify(msg))
    if (!r.ok) throw new Error(`server frame rejected: ${r.error} ${JSON.stringify(msg)}`)
    w.onMessage(r.msg)
  }
  inner.onClose = (info) => w.onClose(info)
  return w
}

describe('mock unique notices (MockServer)', () => {
  it('a GM spawn reaches players in the world, never the lobby, and the defeat follows on mock time', async () => {
    let clock = 1_900_000_000_000
    const server = new MockServer(memory(), 0, () => clock)
    server.gmRole = 'gm'
    const session = async (name: string, enter: boolean) => {
      await server.register({ username: name.toLowerCase(), password: 'secret' })
      const { token } = await server.login({ username: name.toLowerCase(), password: 'secret' })
      const s = new Session(() => validating(server.wire()), token)
      await s.connect()
      const got: ServerMessage[] = []
      s.on((m) => void (m.t === 'uniqueNotice' && got.push(m)))
      if (enter) {
        const { character } = await s.request({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' }, ['charCreated'])
        await s.request({ t: 'enterWorld', id: character.id }, ['worldEnter'])
      }
      return { s, got }
    }
    const gm = await session('Boss', true)
    const lobby = await session('Waiting', false)
    const res = await gm.s.request({ t: 'chat', text: '/unique spawn tiger' }, ['gmResult'])
    expect(res).toMatchObject({ ok: true, cmd: 'unique' })
    await new Promise((r) => setTimeout(r, 20))
    expect(gm.got).toEqual([{ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: expect.any(String), area: 'North-Tiger Mt.' }])
    clock += MOCK_UNIQUE_DEFEAT_MS
    const deadline = Date.now() + 2000
    while (gm.got.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(gm.got[1]).toMatchObject({ event: 'defeated', by: 'Boss', party: true })
    expect(lobby.got).toEqual([])
    gm.s.close()
    lobby.s.close()
  })
})
