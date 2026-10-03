/**
 * Mock unique notices (docs/WAVE_PLAN7.md §3.1, docs/UNIQUES.md §3.3, lane W11-P) for ?mock=1&gm=1, so the notice
 * lane (U-H) and the town's alarm (TL-C) can run before the server's uniques module (U-S) lands. A GM types in chat:
 * - `/unique spawn [name]`: every in-world player gets `uniqueNotice {event: 'appeared'}` now and, 20 s of mock time
 *   later, `{event: 'defeated', by: <the GM>, party: true}` (one alive: a second spawn while she lives is refused);
 * - `/unique kill [name]`: the defeat notice at once (solo form);
 * - `/unique list`: the state, as a gmResult.
 * Only Tiger Girl is known. The lobby never gets a notice (`broadcast` reaches in-world connections only). Optional and
 * first to cut: the real server is the truth.
 */
import { isStaff, type ServerMessage } from '@sro/shared'
import type { MockConn, MockContext, MockExtension } from '../mock.ts'

/** Mock time between the appear and the scripted defeat. */
export const MOCK_UNIQUE_DEFEAT_MS = 20_000
const CODE = 'MOB_CH_TIGERWOMAN'
/** The mock's camp zone name (the real server reads GameData.zoneName at the camp). */
const AREA = 'North-Tiger Mt.'

interface State {
  alive: boolean
  /** Mock ms of the scripted defeat, 0 = none. */
  defeatAt: number
  by: string
}

const states = new WeakMap<MockContext, State>()

function stateOf(ctx: MockContext): State {
  let s = states.get(ctx)
  if (!s) states.set(ctx, (s = { alive: false, defeatAt: 0, by: '' }))
  return s
}

function nameOf(ctx: MockContext): string {
  return ctx.content.mobs.get(CODE)?.name ?? 'Tiger Girl'
}

/** True when `arg` names Tiger Girl ('tiger', 'tigergirl', 'Tiger Girl', the code), or is absent. */
function known(ctx: MockContext, arg: string): boolean {
  const a = arg.toLowerCase().replace(/[\s_]/g, '')
  return a === '' || a === 'tiger' || a === 'tigergirl' || a === CODE.toLowerCase().replace(/_/g, '') || a === nameOf(ctx).toLowerCase().replace(/\s/g, '')
}

type UniqueNotice = Extract<ServerMessage, { t: 'uniqueNotice' }>

function notice(ctx: MockContext, event: UniqueNotice['event'], by?: string, party?: boolean): UniqueNotice {
  if (event === 'appeared') return { t: 'uniqueNotice', event, mob: CODE, name: nameOf(ctx), area: AREA }
  const m: UniqueNotice = { t: 'uniqueNotice', event, mob: CODE, name: nameOf(ctx) }
  if (by) m.by = by
  if (by && party !== undefined) m.party = party
  return m
}

function command(ctx: MockContext, conn: MockConn, text: string): void {
  const [, sub = '', ...rest] = text.trim().split(/\s+/)
  const reply = (ok: boolean, message: string) => ctx.send(conn, { t: 'gmResult', ok, cmd: 'unique', message })
  if (!isStaff(conn.role)) return ctx.send(conn, { t: 'error', code: 'forbidden', message: 'GM commands need a GM account.', re: 'chat' })
  const s = stateOf(ctx)
  const arg = rest.join(' ')
  const me = ctx.selfOf(conn)?.state.name ?? conn.account ?? 'GM'
  switch (sub.toLowerCase()) {
    case 'list':
      return reply(true, `${nameOf(ctx)} (${CODE}): ${s.alive ? `alive at ${AREA}` : 'waiting'}.`)
    case 'spawn':
      if (!known(ctx, arg)) return reply(false, `No unique called ${arg}.`)
      if (s.alive) return reply(false, `${nameOf(ctx)} is already alive.`)
      s.alive = true
      s.defeatAt = ctx.now() + MOCK_UNIQUE_DEFEAT_MS
      s.by = me
      ctx.broadcast(notice(ctx, 'appeared'))
      return reply(true, `${nameOf(ctx)} spawned (mock); defeated by your party in ${MOCK_UNIQUE_DEFEAT_MS / 1000} s.`)
    case 'kill':
      if (!known(ctx, arg)) return reply(false, `No unique called ${arg}.`)
      if (!s.alive) return reply(false, `${nameOf(ctx)} is not alive.`)
      s.alive = false
      s.defeatAt = 0
      ctx.broadcast(notice(ctx, 'defeated', me, false))
      return reply(true, `${nameOf(ctx)} killed (mock).`)
    default:
      return reply(false, 'usage: unique list | spawn [name] | kill [name] (mock)')
  }
}

export const uniquesMock: MockExtension = {
  handle(ctx, conn, msg): boolean {
    if (msg.t !== 'chat' || msg.to !== undefined || !/^\/unique(\s|$)/i.test(msg.text.trim())) return false
    command(ctx, conn, msg.text)
    return true
  },
  tick(ctx, now): void {
    const s = states.get(ctx)
    if (!s?.alive || s.defeatAt === 0 || now < s.defeatAt) return
    s.alive = false
    s.defeatAt = 0
    ctx.broadcast(notice(ctx, 'defeated', s.by, true))
  },
}
