/** The mock's jump answer (?mock=1; docs/WAVE_PLAN6.md §3.2, lane W10-P), so MV-C can run before MV-P lands. */
import { describe, expect, it } from 'vitest'
import { JUMP_COOLDOWN_MS, JUMP_COOLDOWN_SLACK_MS, type ServerMessage } from '@sro/shared'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { fxMock } from '../src/net/mock/fx.ts'
import { DEFAULT_MOCK_EXTENSIONS } from '../src/net/mock/index.ts'
import { movementMock } from '../src/net/mock/movement.ts'
import { Session } from '../src/net/session.ts'
import { intents } from '../src/world/intents.ts'

type Ctx = Parameters<NonNullable<typeof movementMock.handle>>[0]
type Conn = Parameters<NonNullable<typeof movementMock.handle>>[1]

function rig() {
  const sent: unknown[] = []
  const results: [string, boolean, string?][] = []
  let now = 1_000_000
  const self = {
    state: { id: 42, pos: [0, 0, 0] } as { id: number; pos: number[]; move?: unknown; mount?: number; stall?: string },
    player: { prog: { dead: false }, action: null as unknown, casting: null as unknown, lastCombat: 0, cooldowns: new Map<string, number>() },
  }
  const ctx = {
    now: () => now,
    selfOf: () => self,
    entity: (id: number) => (id === 42 ? self : undefined),
    result: (_c: unknown, re: string, ok: boolean, reason?: string) => results.push(reason ? [re, ok, reason] : [re, ok]),
    broadcast: (m: unknown) => sent.push(m),
  } as unknown as Ctx
  const conn = {} as Conn
  const jump = () => movementMock.handle!(ctx, conn, { t: 'jump' })
  return { sent, results, self, ctx, conn, jump, at: (t: number) => (now = t) }
}

describe('mock jump (?mock=1)', () => {
  it('is registered once, after the posture mock and before the wave-8 trade, stall and guild mocks', () => {
    expect(DEFAULT_MOCK_EXTENSIONS.filter((x) => x === movementMock)).toHaveLength(1)
    const i = DEFAULT_MOCK_EXTENSIONS.indexOf(movementMock)
    expect(i).toBeGreaterThan(DEFAULT_MOCK_EXTENSIONS.indexOf(fxMock))
    expect(DEFAULT_MOCK_EXTENSIONS.length - i).toBe(4)
  })

  it('no other default mock claims a jump (the trade mock lets it through: allowed in a trade)', () => {
    const { ctx, conn } = rig()
    for (const m of DEFAULT_MOCK_EXTENSIONS) {
      if (m === movementMock || !m.handle) continue
      let claimed = false
      try {
        claimed = m.handle(ctx, conn, { t: 'jump' })
      } catch {
        // a lane mock that needs more of the context than this rig has never looked at a jump anyway
      }
      expect(claimed).toBe(false)
    }
  })

  it('answers once and tells every viewer (the jumper too) jump {id, at}; the move is untouched', () => {
    const { sent, results, self, jump } = rig()
    const move = { from: [0, 0, 0], to: [10, 0, 0], speed: 5.5, startedAt: 999_000 }
    self.state.move = move
    expect(jump()).toBe(true)
    expect(results).toEqual([['jump', true]])
    expect(sent).toEqual([{ t: 'jump', id: 42, at: 1_000_000 }])
    expect(self.state.move).toBe(move)
    expect(self.state.pos).toEqual([0, 0, 0])
  })

  it('ignores every other message', () => {
    const { results, sent, ctx, conn } = rig()
    expect(movementMock.handle!(ctx, conn, { t: 'emote', emote: 'hi' })).toBe(false)
    expect(movementMock.handle!(ctx, conn, { t: 'sit', on: true })).toBe(false)
    expect(results).toEqual([])
    expect(sent).toEqual([])
  })

  it('the cooldown: refused before 1 s minus the slack, accepted from there', () => {
    const { results, sent, jump, at } = rig()
    jump()
    at(1_000_000 + JUMP_COOLDOWN_MS - JUMP_COOLDOWN_SLACK_MS - 1)
    jump()
    at(1_000_000 + JUMP_COOLDOWN_MS - JUMP_COOLDOWN_SLACK_MS)
    jump()
    expect(results).toEqual([['jump', true], ['jump', false, 'cooldown'], ['jump', true]])
    expect(sent).toHaveLength(2)
  })

  it('refuses dead, mounted, a stall owner and a return-scroll cast, and sends no jump', () => {
    const { results, sent, self, jump } = rig()
    self.player.prog.dead = true
    jump()
    self.player.prog.dead = false
    self.state.mount = 77
    jump()
    self.state.mount = undefined
    self.state.stall = 'Cheap potions'
    jump()
    self.state.stall = undefined
    self.player.casting = { until: 2_000_000 }
    jump()
    expect(results).toEqual([['jump', false, 'dead'], ['jump', false, 'mounted'], ['jump', false, 'stalling'], ['jump', false, 'busy']])
    expect(sent).toEqual([])
  })

  it('stands a sitter up first, then jumps', () => {
    const { sent, ctx, conn, jump } = rig()
    fxMock.handle!(ctx, conn, { t: 'sit', on: true })
    expect(fxMock.handle!(ctx, conn, { t: 'jump' })).toBe(false) // the posture mock leaves the jump to movementMock
    jump()
    expect(sent).toEqual([
      { t: 'entityUpdate', id: 42, posture: 'sit' },
      { t: 'entityUpdate', id: 42, posture: 'stand' },
      { t: 'jump', id: 42, at: 1_000_000 },
    ])
  })
})

describe('mock jump through the MockServer (validated frames both ways)', () => {
  const memory = (): KeyValueStore => {
    const m = new Map<string, string>()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
  }
  const flush = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('Space in the world: ok + jump {id, at} to the jumper, then cooldown', async () => {
    let now = 2_000_000_000
    const server = new MockServer(memory(), 0, () => now)
    await server.register({ username: 'jumper', password: 'mock-only' })
    const { token } = await server.login({ username: 'jumper', password: 'mock-only' })
    const s = new Session(() => server.wire(), token)
    const log: ServerMessage[] = []
    s.on((m) => log.push(m))
    await s.connect()
    const { character } = await s.request({ t: 'charCreate', name: 'Jumper', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' }, ['charCreated'])
    const enter = await s.request(intents.enterWorld(character.id), ['worldEnter'])
    const me = enter.self.id
    const from = log.length
    s.send({ t: 'jump' })
    await flush()
    s.send({ t: 'jump' })
    await flush()
    const got = log.slice(from).filter((m) => (m.t === 'actionResult' && m.re === 'jump') || m.t === 'jump')
    expect(got.map((m) => (m.t === 'actionResult' ? [m.re, m.ok, m.reason] : [m.t, m.id]))).toEqual([
      ['jump', true, undefined],
      ['jump', me],
      ['jump', false, 'cooldown'],
    ])
    const jump = got[1] as Extract<ServerMessage, { t: 'jump' }>
    expect(Math.abs(jump.at - now)).toBeLessThan(200_000) // server ms (the mock's clock runs skewed ahead)
    now += JUMP_COOLDOWN_MS
    s.send({ t: 'jump' })
    await flush()
    expect(log.filter((m) => m.t === 'jump')).toHaveLength(2)
    s.close()
  })
})
