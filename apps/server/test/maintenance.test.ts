/**
 * Maintenance mode (docs/ADMIN.md §8; src/maintenance.ts): the countdown and its announcements, the kick at zero (staff
 * stay, a GM demoted meanwhile does not), cancel / end and their refusals, several admins, the persisted state across a
 * restart, and the admin route group and GM command around it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_CODE, MAINTENANCE_REASON_MAX, maintenanceBackIn, maintenanceIn, maintenanceRefusal, parseServerMessage, type Role, type ServerMessage } from '@sro/shared'
import { MAINTENANCE_FILE, Maintenance, clipUtf8, type MaintConn, type MaintHost } from '../src/maintenance.ts'
import { routeAdminMaintenance } from '../src/admin/maintenance-admin.ts'
import type { GameContext } from '../src/game.ts'
import { TOOL_COMMANDS } from '../src/gm-tools.ts'

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0)

class FakeConn implements MaintConn {
  readonly got: ServerMessage[] = []
  closed: { code: number; reason: string } | null = null
  constructor(
    private readonly host: FakeHost,
    readonly accountId: number,
    readonly account: string,
    public role: Role,
    readonly player: { name: string } | null,
  ) {}
  send(msg: ServerMessage): void {
    if (this.closed) return
    // every frame must pass the client's validator
    const parsed = parseServerMessage(JSON.stringify(msg))
    if (!parsed.ok) throw new Error(`invalid frame ${parsed.error}: ${JSON.stringify(msg)}`)
    this.got.push(msg)
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
    this.host.sockets.delete(this.accountId)
  }
  notices(): string[] {
    return this.got.filter((m) => m.t === 'notice').map((m) => (m as { text: string }).text)
  }
  chats(): string[] {
    return this.got.filter((m) => m.t === 'chat').map((m) => (m as { text: string }).text)
  }
  syncs(): ServerMessage[] {
    return this.got.filter((m) => m.t === 'maintenance')
  }
}

class FakeHost implements MaintHost {
  readonly sockets = new Map<number, FakeConn>()
  readonly roles = new Map<number, Role>()
  readonly logs: string[] = []
  held = 0
  accountRole(id: number): Role {
    return this.roles.get(id) ?? 'player'
  }
  releaseHeld(): number {
    const n = this.held
    this.held = 0
    return n
  }
  log(line: string): void {
    this.logs.push(line)
  }
  add(id: number, role: Role, inWorld = true): FakeConn {
    const c = new FakeConn(this, id, `acct${id}`, role, inWorld ? { name: `Char${id}` } : null)
    this.sockets.set(id, c)
    this.roles.set(id, role)
    return c
  }
}

let dir = ''
beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  dir = mkdtempSync(join(tmpdir(), 'sro-maint-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const host = new FakeHost()
  const m = new Maintenance(host, dir)
  return { host, m }
}

describe('maintenance texts', () => {
  it('words the countdown steps and the expected end', () => {
    expect(maintenanceIn(600_000)).toBe('10 minutes')
    expect(maintenanceIn(60_000)).toBe('1 minute')
    expect(maintenanceIn(30_000)).toBe('30 seconds')
    expect(maintenanceIn(1000)).toBe('1 second')
    expect(maintenanceBackIn(null, T0)).toBeNull()
    expect(maintenanceBackIn(T0 + 25 * 60_000, T0)).toBe('in about 25 minutes')
    expect(maintenanceBackIn(T0 + 3 * 3600_000, T0)).toBe('in about 3 hours')
    expect(maintenanceBackIn(T0 - 1, T0)).toBe('any moment now')
    expect(maintenanceRefusal(T0 + 30 * 60_000, T0, 'Patch')).toBe('The server is under maintenance (Patch). Expected back: in about 30 minutes.')
    expect(maintenanceRefusal(null, T0)).toBe('The server is under maintenance. Please try again later.')
    expect(Buffer.byteLength(clipUtf8('é'.repeat(100)))).toBeLessThanOrEqual(120)
  })
})

describe('maintenance countdown', () => {
  it('announces at the start and the steps, then kicks every player at zero; staff stay', () => {
    const { host, m } = setup()
    const player = host.add(1, 'player')
    const lobby = host.add(2, 'player', false) // in character select (or loading)
    const gm = host.add(3, 'gm')
    const admin = host.add(4, 'admin')
    host.held = 2
    const r = m.start({ delayS: 600, reason: 'Winter update', durationMin: 30, by: 'root', via: 'panel' })
    expect(r.ok).toBe(true)
    expect(m.state).toBe('countdown')
    expect(player.notices()[0]).toMatch(/^Server maintenance in 10 minutes: Winter update\. Expected downtime: about 30 minutes\./)
    expect(player.chats()[0]).toMatch(/^\[Maintenance\] Server maintenance in 10 minutes/)
    // the lobby hears it centre screen, but has no chat
    expect(lobby.notices()).toHaveLength(1)
    expect(lobby.chats()).toHaveLength(0)
    expect(player.syncs()[0]).toEqual({ t: 'maintenance', state: 'countdown', endsIn: 600_000, reason: 'Winter update', back: 30 })
    // the steps under 10 minutes: 5, 3, 2, 1 min, 30 s, 10 s
    vi.advanceTimersByTime(600_000 - 1)
    expect(player.notices().map((n) => /in (.*?):/.exec(n)?.[1])).toEqual(['10 minutes', '5 minutes', '3 minutes', '2 minutes', '1 minute', '30 seconds', '10 seconds'])
    expect(player.closed).toBeNull()
    vi.advanceTimersByTime(1)
    expect(m.state).toBe('on')
    for (const c of [player, lobby]) {
      expect(c.closed?.code).toBe(CLOSE_CODE.maintenance)
      expect(c.closed?.reason).toBe('The server is under maintenance. Expected back: in about 30 minutes.')
      expect(c.chats().at(-1)).toBe('[Maintenance] The server is under maintenance (Winter update). Expected back: in about 30 minutes.')
    }
    expect(gm.closed).toBeNull()
    expect(admin.closed).toBeNull()
    expect(gm.syncs().at(-1)).toEqual({ t: 'maintenance', state: 'on', reason: 'Winter update', back: 30 })
    expect(gm.notices().at(-1)).toMatch(/Maintenance mode is ON\. 2 player connection/)
    expect(host.held).toBe(0)
    expect(host.logs.some((l) => /2 connection\(s\) disconnected, 2 held character\(s\) saved/.test(l))).toBe(true)
  })

  it('a short countdown skips the longer steps; "now" kicks at once', () => {
    const { host, m } = setup()
    const p = host.add(1, 'player')
    m.start({ delayS: 60, by: 'root', via: 'gm' })
    vi.advanceTimersByTime(60_000)
    expect(p.notices().map((n) => /in (.*?)\./.exec(n)?.[1])).toEqual(['1 minute', '30 seconds', '10 seconds'])
    expect(p.closed?.code).toBe(CLOSE_CODE.maintenance)
    const { host: h2, m: m2 } = setup()
    rmSync(join(dir, MAINTENANCE_FILE), { force: true })
    const q = h2.add(5, 'player')
    const r = m2.start({ delayS: 0, by: 'root', via: 'panel' })
    expect(r).toMatchObject({ ok: true })
    expect((r as { message: string }).message).toMatch(/1 player connection/)
    expect(q.closed?.code).toBe(CLOSE_CODE.maintenance)
    expect(q.closed?.reason).toBe('The server is under maintenance. Please try again later.')
  })

  it('re-reads the role at zero: a GM demoted during the countdown is disconnected too', () => {
    const { host, m } = setup()
    const gm = host.add(3, 'gm')
    m.start({ delayS: 60, by: 'root', via: 'panel' })
    host.roles.set(3, 'player') // revoked in the database, not yet seen by the connection
    vi.advanceTimersByTime(60_000)
    expect(gm.closed?.code).toBe(CLOSE_CODE.maintenance)
  })

  it('a GM demoted while it is on is disconnected when the change is seen', () => {
    const { host, m } = setup()
    const gm = host.add(3, 'gm')
    m.start({ delayS: 0, by: 'root', via: 'panel' })
    expect(gm.closed).toBeNull()
    m.roleChanged(gm)
    expect(gm.closed).toBeNull()
    gm.role = 'player'
    m.roleChanged(gm)
    expect(gm.closed?.code).toBe(CLOSE_CODE.maintenance)
  })

  it('cancel at 1 s before zero: nobody is kicked and everyone is told; cancel after zero is refused', () => {
    const { host, m } = setup()
    const p = host.add(1, 'player')
    m.start({ delayS: 300, by: 'root', via: 'panel' })
    vi.advanceTimersByTime(299_000)
    const r = m.cancel('ops', 'panel')
    expect(r.ok).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(p.closed).toBeNull()
    expect(m.state).toBe('off')
    expect(p.notices().at(-1)).toMatch(/was cancelled/)
    expect(p.syncs().at(-1)).toEqual({ t: 'maintenance', state: 'off' })
    expect(existsSync(join(dir, MAINTENANCE_FILE))).toBe(false)
    expect(m.cancel('ops', 'panel')).toMatchObject({ ok: false, status: 409 })
    m.start({ delayS: 1, by: 'root', via: 'panel' })
    vi.advanceTimersByTime(1000)
    expect(m.cancel('ops', 'panel')).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/end it instead/) })
  })

  it('several admins: a second start is refused, any admin may cancel or end', () => {
    const { host, m } = setup()
    host.add(9, 'admin')
    expect(m.start({ delayS: 600, by: 'alice', via: 'panel' }).ok).toBe(true)
    expect(m.start({ delayS: 60, by: 'bob', via: 'gm' })).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/by alice/) })
    expect(m.end('bob', 'gm')).toMatchObject({ ok: false, status: 409 })
    expect(m.cancel('bob', 'gm').ok).toBe(true)
    expect(m.start({ delayS: 0, by: 'bob', via: 'gm' }).ok).toBe(true)
    expect(m.start({ delayS: 0, by: 'alice', via: 'panel' })).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/already on/) })
    expect(m.end('alice', 'panel').ok).toBe(true)
    expect(m.end('alice', 'panel')).toMatchObject({ ok: false, status: 409 })
  })

  it('end: online again, "Maintenance is over" unless silent', () => {
    const { host, m } = setup()
    const admin = host.add(4, 'admin')
    m.start({ delayS: 0, by: 'root', via: 'panel' })
    expect(m.refusal('player')).toMatch(/under maintenance/)
    expect(m.refusal('gm')).toBeNull()
    expect(m.refusal('admin')).toBeNull()
    m.end('root', 'panel')
    expect(m.refusal('player')).toBeNull()
    expect(admin.notices().at(-1)).toBe('Server maintenance is over. Welcome back!')
    m.start({ delayS: 0, by: 'root', via: 'panel' })
    const n = admin.notices().length
    m.end('root', 'panel', true)
    expect(admin.notices()).toHaveLength(n)
    expect(admin.syncs().at(-1)).toEqual({ t: 'maintenance', state: 'off' })
  })

  it('checks its input', () => {
    const { m } = setup()
    expect(m.start({ delayS: -1, by: 'a', via: 'panel' })).toMatchObject({ ok: false, status: 400 })
    expect(m.start({ delayS: 181 * 60, by: 'a', via: 'panel' })).toMatchObject({ ok: false, status: 400 })
    expect(m.start({ delayS: 1.5, by: 'a', via: 'panel' })).toMatchObject({ ok: false, status: 400 })
    expect(m.start({ delayS: 60, durationMin: -5, by: 'a', via: 'panel' })).toMatchObject({ ok: false, status: 400 })
    expect(m.start({ delayS: 60, reason: 'x'.repeat(MAINTENANCE_REASON_MAX + 1), by: 'a', via: 'panel' })).toMatchObject({ ok: false, status: 400 })
    expect(m.state).toBe('off')
    expect(m.start({ delayS: 60, reason: ' a\u0000b‮ c ', by: 'a', via: 'panel' }).ok).toBe(true)
    expect(m.record?.reason).toBe('a b c')
  })

  it('greets a late joiner with the banner state', () => {
    const { host, m } = setup()
    const late = new FakeConn(host, 7, 'late', 'player', null)
    m.greet(late)
    expect(late.got).toEqual([])
    m.start({ delayS: 120, by: 'root', via: 'panel' })
    vi.advanceTimersByTime(20_000)
    m.greet(late)
    expect(late.got).toEqual([{ t: 'maintenance', state: 'countdown', endsIn: 100_000 }])
  })
})

describe('maintenance across a restart', () => {
  it('stays on after a restart until ended', () => {
    const { m } = setup()
    m.start({ delayS: 0, reason: 'Deploy', durationMin: 20, by: 'root', via: 'panel' })
    m.dispose()
    const saved = JSON.parse(readFileSync(join(dir, MAINTENANCE_FILE), 'utf8'))
    expect(saved).toMatchObject({ state: 'on', by: 'root', reason: 'Deploy', durationMin: 20 })
    const again = setup()
    again.m.load()
    expect(again.m.on).toBe(true)
    expect(again.m.refusal('player')).toBe('The server is under maintenance (Deploy). Expected back: in about 20 minutes.')
    again.m.end('root', 'panel')
    const third = setup()
    third.m.load()
    expect(third.m.state).toBe('off')
  })

  it('a countdown resumes where it was; one that ran out while down comes back on', () => {
    const { m } = setup()
    m.start({ delayS: 600, by: 'root', via: 'panel' })
    m.dispose()
    vi.setSystemTime(T0 + 200_000)
    const resumed = setup()
    resumed.m.load()
    const p = resumed.host.add(1, 'player')
    expect(resumed.m.state).toBe('countdown')
    vi.advanceTimersByTime(400_000)
    expect(resumed.m.state).toBe('on')
    expect(p.closed?.code).toBe(CLOSE_CODE.maintenance)
    expect(p.notices().map((n) => /in (.*?)\./.exec(n)?.[1])).toEqual(['5 minutes', '3 minutes', '2 minutes', '1 minute', '30 seconds', '10 seconds'])
    resumed.m.end('root', 'panel', true)
    resumed.m.start({ delayS: 60, by: 'root', via: 'panel' })
    resumed.m.dispose()
    vi.setSystemTime(Date.now() + 3600_000)
    const late = setup()
    late.m.load()
    expect(late.m.on).toBe(true)
  })

  it('a damaged file keeps it off', () => {
    writeFileSync(join(dir, MAINTENANCE_FILE), '{"state": "on"')
    const { host, m } = setup()
    m.load()
    expect(m.state).toBe('off')
    writeFileSync(join(dir, MAINTENANCE_FILE), '{"state": "nope"}')
    m.load()
    expect(m.state).toBe('off')
    expect(host.logs.join('\n')).toMatch(/unreadable[\s\S]*malformed/)
  })
})

describe('maintenance admin routes and GM command', () => {
  function ctxWith(m: Maintenance) {
    const audits: { command: string; args: string[]; ok: boolean; result: string }[] = []
    const ctx = { maintenance: m, store: { audit: (e: (typeof audits)[number]) => audits.push(e) } } as unknown as GameContext
    const call = (method: string, sub: string, body?: unknown, role: Role = 'admin') =>
      routeAdminMaintenance(ctx, { method, path: `/api/admin/maintenance${sub}`, query: new URLSearchParams(), body, actor: { accountId: 1, role, username: 'root' } }) as { status: number; body: any }
    return { ctx, call, audits }
  }

  it('admins only; checks bodies; a gm_audit row per write', () => {
    const { host, m } = setup()
    host.add(1, 'player')
    host.add(2, 'gm')
    const { call, audits } = ctxWith(m)
    expect(call('GET', '', undefined, 'gm').status).toBe(403)
    expect(call('POST', '/start', { minutes: 5 }, 'gm').status).toBe(403)
    const v = call('GET', '')
    expect(v.status).toBe(200)
    expect(v.body).toMatchObject({ state: 'off', players: 1, staff: 1, presetsMin: [0, 1, 5, 10, 15, 30] })
    expect(call('POST', '/start', { minutes: 2.5 }).status).toBe(400)
    expect(call('POST', '/start', { minutes: 5, durationMin: 'soon' }).status).toBe(400)
    expect(call('POST', '/start', { minutes: 5, extra: 1 }).status).toBe(400)
    expect(call('POST', '/start', [1]).status).toBe(400)
    expect(call('POST', '/nope', {}).status).toBe(404)
    const s = call('POST', '/start', { minutes: 5, reason: 'Patch', durationMin: 15 })
    expect(s.status).toBe(200)
    expect(s.body.view).toMatchObject({ state: 'countdown', deadline: T0 + 300_000, by: 'root', via: 'panel', reason: 'Patch', durationMin: 15 })
    expect(call('POST', '/start', { minutes: 1 }).status).toBe(409)
    expect(call('POST', '/end', {}).status).toBe(409)
    expect(call('POST', '/cancel', {}).status).toBe(200)
    expect(call('POST', '/start', { minutes: 0 }).status).toBe(200)
    expect(call('GET', '').body).toMatchObject({ state: 'on', since: T0, players: 0 })
    expect(call('POST', '/end', { silent: 'yes' }).status).toBe(400)
    expect(call('POST', '/end', { silent: true }).status).toBe(200)
    expect(audits.map((a) => [a.command, a.args[0], a.ok])).toEqual([
      ['maintenance', 'start', true], ['maintenance', 'start', false], ['maintenance', 'end', false], ['maintenance', 'cancel', true],
      ['maintenance', 'start', true], ['maintenance', 'end', true],
    ])
  })

  it('the GM command: admin rank only, start / status / cancel / end', () => {
    const { host, m } = setup()
    const p = host.add(1, 'player')
    const { ctx } = ctxWith(m)
    const run = (role: Role, ...args: string[]) => TOOL_COMMANDS.maintenance!.run({ ctx, conn: { account: 'boss' } as never, role, args, self: null })
    expect(run('gm', 'start', '5')).toMatchObject({ ok: false, message: expect.stringMatching(/admins only/) })
    expect(m.state).toBe('off')
    expect(run('admin', 'start', 'soon').ok).toBe(false)
    expect(run('admin', 'start', '5', '~45 Moving to a new machine').ok).toBe(true)
    expect(m.record).toMatchObject({ durationMin: 45, reason: 'Moving to a new machine', by: 'boss', via: 'gm' })
    expect(run('admin', 'status').message).toMatch(/starts in 300 s/)
    expect(run('admin', 'cancel').ok).toBe(true)
    expect(run('admin', 'start', 'now').ok).toBe(true)
    expect(p.closed?.code).toBe(CLOSE_CODE.maintenance)
    expect(run('admin').message).toMatch(/Maintenance is ON/)
    expect(run('admin', 'end', 'silent').ok).toBe(true)
    expect(run('admin', 'bogus').ok).toBe(false)
  })
})
