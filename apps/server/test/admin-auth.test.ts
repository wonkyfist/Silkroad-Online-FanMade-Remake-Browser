/**
 * Admin panel, layer 1 (docs/ADMIN.md §3-§6): login and sessions, the role check on every route, accounts (create,
 * password, role, ban), the registration switch, settings persistence (live / after restart) and the audit log, the
 * route-group seam for Play the Boss (docs/PLAY_THE_BOSS.md §6.3) and the /admin/ files. A real server over HTTP.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOSE_CODE, type AdminLoginResponse } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_IDLE_MS } from '../src/admin/api.ts'
import { registerAdminRouteGroup } from '../src/admin/routes.ts'
import { startServer, type GameServer } from '../src/game.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'
import { ITEMS, LEVELS, MANGNYANG, contentFiles } from './fixtures.ts'

let s: TestServer
let server: GameServer
let ipN = 0
const logs: string[] = []

beforeAll(async () => {
  s = await startTestServer({
    logs,
    // TRUST_PROXY so each test logs in from its own X-Forwarded-For address (the login limits are per IP).
    config: { trustProxy: true },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [50, 0, -50], bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
      ...contentFiles({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS }),
    },
  })
  server = s
})

afterAll(async () => {
  await server.close()
  rmSync(s.root, { recursive: true, force: true })
})

const url = () => server.url
const freshIp = () => `10.9.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`

async function http(method: string, path: string, opts: { token?: string; body?: unknown; ip?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(url() + path, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Forwarded-For': opts.ip ?? '10.0.0.1',
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json, headers: res.headers }
}

function setRole(username: string, role: 'player' | 'gm' | 'admin'): number {
  const a = server.ctx.store.accountByName(username)!
  server.ctx.store.setRole(a.id, role)
  return a.id
}

async function adminLogin(username: string, password = 'password1', ip = freshIp()): Promise<{ status: number; json: any }> {
  return http('POST', '/api/admin/login', { body: { username, password }, ip })
}

/** A fresh admin account and its panel token. */
async function newAdmin(prefix = 'adm'): Promise<{ username: string; id: number; token: string; gameToken: string }> {
  const acc = await newAccount(url(), prefix)
  const id = setRole(acc.username, 'admin')
  const r = await adminLogin(acc.username)
  expect(r.status).toBe(200)
  return { username: acc.username, id, token: (r.json as AdminLoginResponse).token, gameToken: acc.token }
}

function auditRows(action: string) {
  return server.ctx.store.db.prepare('SELECT * FROM admin_audit WHERE action = ? ORDER BY id').all(action) as { username: string; ok: number; before: string | null; after: string | null; detail: string; target: string }[]
}

describe('login and sessions', () => {
  it('refuses a wrong password (401) and a non-admin with the right one (403), both audited', async () => {
    const p = await newAccount(url(), 'plain')
    expect((await adminLogin(p.username, 'wrongpass')).status).toBe(401)
    const r = await adminLogin(p.username)
    expect(r.status).toBe(403)
    expect(r.json).toMatchObject({ error: 'forbidden' })
    setRole(p.username, 'gm')
    expect((await adminLogin(p.username)).status).toBe(403)
    const rows = auditRows('login').filter((x) => x.username === p.username)
    expect(rows.map((x) => [x.ok, x.detail])).toEqual([[0, 'wrong username or password'], [0, 'refused: role player'], [0, 'refused: role gm']])
  })

  it('an admin logs in; the token opens the panel, a game token does not', async () => {
    const a = await newAdmin()
    const me = await http('GET', '/api/admin/me', { token: a.token })
    expect(me.status).toBe(200)
    expect(me.json.account).toEqual({ id: a.id, username: a.username })
    expect(me.headers.get('cache-control')).toBe('no-store')
    expect((await http('GET', '/api/admin/me', { token: a.gameToken })).status).toBe(401)
    expect(auditRows('login').some((x) => x.username === a.username && x.ok === 1)).toBe(true)
  })

  it('every route needs a session: no token is 401', async () => {
    for (const [m, p] of [['GET', '/api/admin/dashboard'], ['GET', '/api/admin/accounts'], ['POST', '/api/admin/accounts'], ['PUT', '/api/admin/settings'], ['POST', '/api/admin/notice'], ['GET', '/api/admin/items'], ['POST', '/api/admin/restart'], ['GET', '/api/admin/audit']]) {
      const r = await http(m, p, { body: m === 'GET' ? undefined : {} })
      expect([m, p, r.status]).toEqual([m, p, 401])
    }
    expect((await http('GET', '/api/admin/dashboard', { token: 'x'.repeat(40) })).status).toBe(401)
    expect((await http('GET', '/api/admin/nope', { token: 'x' })).status).toBe(404)
  })

  it('a demoted or banned admin is locked out on the next request, and the session is gone', async () => {
    const a = await newAdmin()
    expect((await http('GET', '/api/admin/dashboard', { token: a.token })).status).toBe(200)
    setRole(a.username, 'gm')
    expect((await http('GET', '/api/admin/dashboard', { token: a.token })).status).toBe(403)
    setRole(a.username, 'admin')
    expect((await http('GET', '/api/admin/dashboard', { token: a.token })).status).toBe(401)
  })

  it('logout ends the session; an idle session expires', async () => {
    const a = await newAdmin()
    expect((await http('POST', '/api/admin/logout', { token: a.token })).status).toBe(204)
    expect((await http('GET', '/api/admin/me', { token: a.token })).status).toBe(401)
    const b = await newAdmin()
    server.ctx.store.db.prepare('UPDATE admin_sessions SET last_seen = ? WHERE account_id = ?').run(Date.now() - ADMIN_IDLE_MS - 1000, b.id)
    const r = await http('GET', '/api/admin/me', { token: b.token })
    expect(r.status).toBe(401)
    expect(r.json.message).toMatch(/idle/)
  })

  it('rate-limits failed logins per name and address (429 even with the right password)', async () => {
    const a = await newAccount(url(), 'adm')
    setRole(a.username, 'admin')
    const ip = freshIp()
    for (let i = 0; i < 5; i++) expect((await adminLogin(a.username, 'wrongpass', ip)).status).toBe(401)
    expect((await adminLogin(a.username, 'password1', ip)).status).toBe(429)
    // another address is not blocked by those
    expect((await adminLogin(a.username, 'password1')).status).toBe(200)
  })

  it('no CORS: OPTIONS is a 404 without Access-Control headers; another origin is refused', async () => {
    const r = await http('OPTIONS', '/api/admin/login', { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } })
    expect(r.status).toBe(403)
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
    const same = await http('OPTIONS', '/api/admin/login')
    expect(same.status).toBe(404)
    expect(same.headers.get('access-control-allow-origin')).toBeNull()
    const a = await newAdmin()
    // fetch cannot set Origin: a raw request does
    const u = new URL(url())
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: '/api/admin/dashboard', method: 'GET', headers: { Authorization: `Bearer ${a.token}`, Origin: 'http://evil.example' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })
})

describe('server identity and other origins (server profiles)', () => {
  it('answers GET /api/admin/info without a session: name, LOCAL on a loopback address, the API version', async () => {
    const r = await http('GET', '/api/admin/info')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ admin: true, apiVersion: 1, world: 'jangan', environment: 'local', release: expect.any(String) })
    expect(r.json.token).toBeUndefined()
  })

  it('a panel on a listed origin (ALLOWED_ORIGINS) gets CORS for Bearer calls; others get none', async () => {
    const t = await startTestServer({ config: { allowedOrigins: ['http://panel.example:5182'], host: '0.0.0.0' } })
    try {
      const raw = (method: string, path: string, headers: Record<string, string>) =>
        new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
          const u = new URL(t.url)
          const req = request({ host: '127.0.0.1', port: u.port, path, method, headers }, (res) => {
            res.resume()
            resolve({ status: res.statusCode ?? 0, headers: res.headers })
          })
          req.on('error', reject)
          req.end()
        })
      const pre = await raw('OPTIONS', '/api/admin/dashboard', { Origin: 'http://panel.example:5182', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' })
      expect(pre.status).toBe(204)
      expect(pre.headers['access-control-allow-origin']).toBe('http://panel.example:5182')
      expect(String(pre.headers['access-control-allow-headers'])).toContain('Authorization')
      expect(pre.headers['access-control-allow-credentials']).toBeUndefined()
      const info = await raw('GET', '/api/admin/info', { Origin: 'http://panel.example:5182' })
      expect(info.status).toBe(200)
      expect(info.headers['access-control-allow-origin']).toBe('http://panel.example:5182')
      expect((await raw('GET', '/api/admin/dashboard', { Origin: 'http://panel.example:5182' })).status).toBe(401)
      expect((await raw('GET', '/api/admin/info', { Origin: 'http://other.example' })).status).toBe(403)
      // HOST 0.0.0.0 is not a loopback address: LIVE
      expect((await (await fetch(`${t.url}/api/admin/info`)).json()).environment).toBe('live')
    } finally {
      await t.stopAndClean()
    }
  })
})

describe('accounts', () => {
  it('creates accounts (validated, names unique) that can play; lists and searches them', async () => {
    const a = await newAdmin()
    const r = await http('POST', '/api/admin/accounts', { token: a.token, body: { username: 'Made_By_Admin', password: 'secret12' } })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ username: 'Made_By_Admin', role: 'player', banned: null, characters: 0, characterList: [] })
    expect((await http('POST', '/api/admin/accounts', { token: a.token, body: { username: 'made_by_admin', password: 'secret12' } })).status).toBe(409)
    expect((await http('POST', '/api/admin/accounts', { token: a.token, body: { username: 'x', password: 'secret12' } })).status).toBe(400)
    expect((await http('POST', '/api/admin/accounts', { token: a.token, body: { username: 'okname', password: '123' } })).status).toBe(400)
    expect((await http('POST', '/api/admin/accounts', { token: a.token, body: { username: 'okname', password: 'secret12', extra: 1 } })).status).toBe(400)
    expect((await http('POST', '/api/login', { body: { username: 'Made_By_Admin', password: 'secret12' } })).status).toBe(200)
    const list = await http('GET', '/api/admin/accounts?q=made_by&size=10', { token: a.token })
    expect(list.json).toMatchObject({ total: 1, page: 0, size: 10 })
    expect(list.json.rows[0]).toMatchObject({ username: 'Made_By_Admin', role: 'player' })
    const admins = await http('GET', '/api/admin/accounts?role=admin&size=200', { token: a.token })
    expect(admins.json.rows.every((x: { role: string }) => x.role === 'admin')).toBe(true)
    // LIKE wildcards in the search are literal
    expect((await http('GET', '/api/admin/accounts?q=%25', { token: a.token })).json.total).toBe(0)
    expect(auditRows('account.create').some((x) => x.ok === 1 && JSON.parse(x.after!).username === 'Made_By_Admin')).toBe(true)
  })

  it('resets a password: the old one fails, game sessions end and the player is disconnected', async () => {
    const a = await newAdmin()
    const p = await newAccount(url(), 'pw')
    const c = await Client.login(url(), p.token)
    const id = server.ctx.store.accountByName(p.username)!.id
    const r = await http('POST', `/api/admin/accounts/${id}/password`, { token: a.token, body: { password: 'brandnew1' } })
    expect(r.status).toBe(200)
    expect((await c.closed).code).toBe(CLOSE_CODE.kicked)
    expect((await http('POST', '/api/login', { body: { username: p.username, password: 'password1' }, ip: freshIp() })).status).toBe(401)
    expect((await http('POST', '/api/login', { body: { username: p.username, password: 'brandnew1' }, ip: freshIp() })).status).toBe(200)
    expect(server.ctx.store.sessionAccount((await import('../src/auth.ts')).hashToken(p.token))).toBeUndefined()
  })

  it('never changes a role (the owner-only role policy, test/role-policy.test.ts): no role route, no role on create', async () => {
    const a = await newAdmin()
    const p = await newAccount(url(), 'rl')
    const id = server.ctx.store.accountByName(p.username)!.id
    expect((await http('POST', `/api/admin/accounts/${id}/role`, { token: a.token, body: { role: 'gm' } })).status).toBe(404)
    expect((await http('POST', '/api/admin/accounts', { token: a.token, body: { username: 'wants_gm', password: 'secret12', role: 'gm' } })).status).toBe(400)
    expect(server.ctx.store.accountByName(p.username)!.role).toBe('player')
    expect(server.ctx.store.accountByName('wants_gm')).toBeUndefined()
  })

  it('bans with a reason (sessions end, the socket closes, login says why) and unbans', async () => {
    const a = await newAdmin()
    const p = await newAccount(url(), 'bn')
    const c = await Client.login(url(), p.token)
    const id = server.ctx.store.accountByName(p.username)!.id
    expect((await http('POST', `/api/admin/accounts/${id}/ban`, { token: a.token, body: { reason: '  ' } })).status).toBe(400)
    const r = await http('POST', `/api/admin/accounts/${id}/ban`, { token: a.token, body: { reason: 'Botting in the tomb' } })
    expect(r.json.banned).toMatchObject({ reason: 'Botting in the tomb', by: a.username })
    const closed = await c.closed
    expect(closed.code).toBe(CLOSE_CODE.kicked)
    expect(c.log.some((m) => m.t === 'chat' && m.text.includes('Botting in the tomb'))).toBe(true)
    const login = await http('POST', '/api/login', { body: { username: p.username, password: 'password1' }, ip: freshIp() })
    expect(login.status).toBe(403)
    expect(login.json.message).toBe('This account is banned: Botting in the tomb')
    expect((await http('GET', '/api/admin/accounts?banned=1&size=200', { token: a.token })).json.rows.map((x: { id: number }) => x.id)).toContain(id)
    expect((await http('POST', `/api/admin/accounts/${a.id}/ban`, { token: a.token, body: { reason: 'oops' } })).status).toBe(409)
    expect((await http('POST', `/api/admin/accounts/${id}/unban`, { token: a.token })).json.banned).toBeNull()
    expect((await http('POST', '/api/login', { body: { username: p.username, password: 'password1' }, ip: freshIp() })).status).toBe(200)
    expect(auditRows('account.unban').at(-1)).toMatchObject({ ok: 1, target: `account:${id}` })
  })
})

describe('registration switch', () => {
  it('closed: the server refuses /api/register and says so in ServerInfo; admins still create accounts', async () => {
    const a = await newAdmin()
    expect((await http('GET', '/api/servers')).json[0].registration).toBe('open')
    const put = await http('PUT', '/api/admin/settings', { token: a.token, body: { values: { registrationOpen: false } } })
    expect(put.status).toBe(200)
    expect(server.ctx.config.registrationOpen).toBe(false)
    expect((await http('GET', '/api/servers')).json[0].registration).toBe('closed')
    const reg = await http('POST', '/api/register', { body: { username: 'latecomer', password: 'password1' }, ip: freshIp() })
    expect(reg.status).toBe(403)
    expect(reg.json).toEqual({ error: 'forbidden', message: 'Registration is closed on this server.' })
    expect((await http('POST', '/api/admin/accounts', { token: a.token, body: { username: 'invited', password: 'password1' } })).status).toBe(201)
    // the welcome of a connected client carries it too
    const c = await Client.login(url(), (await http('POST', '/api/login', { body: { username: 'invited', password: 'password1' }, ip: freshIp() })).json.token)
    expect(c.log.find((m) => m.t === 'welcome')).toMatchObject({ server: { registration: 'closed' } })
    c.close()
    await http('PUT', '/api/admin/settings', { token: a.token, body: { values: { registrationOpen: true } } })
    expect((await http('POST', '/api/register', { body: { username: 'latecomer', password: 'password1' }, ip: freshIp() })).status).toBe(201)
  })
})

describe('settings', () => {
  it('lists every setting with its base, saved and running values', async () => {
    const a = await newAdmin()
    const r = await http('GET', '/api/admin/settings', { token: a.token })
    expect(r.status).toBe(200)
    const exp = r.json.settings.find((x: { key: string }) => x.key === 'expRate')
    expect(exp).toMatchObject({ env: 'EXP_RATE', type: 'number', apply: 'live', base: 1, running: 1, pending: false })
    expect(r.json.settings.find((x: { key: string }) => x.key === 'moveSpeed')).toMatchObject({ apply: 'restart', base: 5.5 })
    expect(r.json.settings.some((x: { key: string }) => x.key === 'port' || x.key === 'dataDir' || x.key === 'editorRole')).toBe(false)
    expect(r.json.restart).toBe(false)
  })

  it('validates all or nothing; applies live ones at once and keeps restart ones pending', async () => {
    const a = await newAdmin()
    const bad = await http('PUT', '/api/admin/settings', { token: a.token, body: { values: { expRate: 3, goldRate: -1 } } })
    expect(bad.status).toBe(400)
    expect(server.ctx.config.expRate ?? 1).toBe(1)
    expect((await http('PUT', '/api/admin/settings', { token: a.token, body: { values: { port: 80 } } })).status).toBe(400)
    expect((await http('PUT', '/api/admin/settings', { token: a.token, body: { values: { levelCap: 20.5 } } })).status).toBe(400)
    const r = await http('PUT', '/api/admin/settings', { token: a.token, body: { values: { expRate: 2.5, viewRange: 90, moveSpeed: 7, levelCap: 30 } } })
    expect(r.status).toBe(200)
    expect(server.ctx.config.expRate).toBe(2.5)
    expect(server.ctx.world.viewRange).toBe(90)
    expect(server.ctx.config.levelCap).toBe(30)
    expect(server.ctx.world.moveSpeed).toBe(5.5)
    const ms = r.json.settings.find((x: { key: string }) => x.key === 'moveSpeed')
    expect(ms).toMatchObject({ stored: 7, running: 5.5, pending: true })
    expect((await http('GET', '/api/admin/dashboard', { token: a.token })).json.server.pendingRestart).toEqual(['moveSpeed'])
    const row = auditRows('settings.put').at(-1)!
    expect(JSON.parse(row.after!)).toEqual({ expRate: 2.5, viewRange: 90, moveSpeed: 7, levelCap: 30 })
    expect(JSON.parse(row.before!)).toEqual({ expRate: null, viewRange: null, moveSpeed: null, levelCap: null })
  })

  it('survive a restart (restart ones apply then; the monster level limit follows the cap); null resets to the base', async () => {
    const config = { ...server.ctx.config, expRate: 1, viewRange: 120, moveSpeed: 5.5, levelCap: 20, mobLevelMax: 25, port: 0 }
    await server.close()
    server = await startServer(config)
    expect(server.ctx.config.expRate).toBe(2.5)
    expect(server.ctx.world.viewRange).toBe(90)
    expect(server.ctx.world.moveSpeed).toBe(7)
    expect(server.ctx.config.levelCap).toBe(30)
    expect(server.ctx.config.mobLevelMax).toBe(35)
    expect(logs.some((l) => /admin settings: .*expRate=2\.5/.test(l))).toBe(true)
    const a = await newAdmin()
    const view = await http('GET', '/api/admin/settings', { token: a.token })
    expect(view.json.settings.find((x: { key: string }) => x.key === 'moveSpeed')).toMatchObject({ base: 5.5, stored: 7, running: 7, pending: false })
    const r = await http('PUT', '/api/admin/settings', { token: a.token, body: { values: { expRate: null, viewRange: null, moveSpeed: null, levelCap: null } } })
    expect(server.ctx.config.expRate).toBe(1)
    expect(server.ctx.world.viewRange).toBe(120)
    expect(r.json.settings.find((x: { key: string }) => x.key === 'moveSpeed')).toMatchObject({ stored: null, running: 7, pending: true })
  })

  it('a saved value that no longer validates is skipped at start with a log line', async () => {
    server.ctx.store.db.prepare("INSERT OR REPLACE INTO admin_settings (key, value, updated_at, updated_by) VALUES ('goldRate', '\"lots\"', 0, 'x'), ('noSuchKnob', '1', 0, 'x')").run()
    const config = { ...server.ctx.config, port: 0 }
    await server.close()
    server = await startServer(config)
    expect(server.ctx.config.goldRate ?? 1).toBe(1)
    expect(logs.some((l) => /skipped saved goldRate/.test(l))).toBe(true)
    expect(logs.some((l) => /skipped unknown saved setting noSuchKnob/.test(l))).toBe(true)
    server.ctx.store.db.prepare("DELETE FROM admin_settings WHERE key IN ('goldRate', 'noSuchKnob')").run()
  })
})

describe('audit, restart and events', () => {
  it('lists audit rows newest first with filters, and the GM command log', async () => {
    const a = await newAdmin()
    await http('POST', '/api/admin/notice', { token: a.token, body: { text: 'Hello from the panel' } })
    const r = await http('GET', '/api/admin/audit?action=notice&size=5', { token: a.token })
    expect(r.json.rows[0]).toMatchObject({ action: 'notice', account: a.username, ok: true, after: { text: 'Hello from the panel' } })
    expect(r.json.rows.every((x: { action: string }) => x.action.startsWith('notice'))).toBe(true)
    const gm = await http('GET', '/api/admin/gm-audit?size=5', { token: a.token })
    expect(gm.status).toBe(200)
    expect(Array.isArray(gm.json.rows)).toBe(true)
  })

  it('restart is refused without a supervisor and works through requestRestart with one', async () => {
    const a = await newAdmin()
    expect((await http('POST', '/api/admin/restart', { token: a.token })).status).toBe(409)
    let called = 0
    server.ctx.requestRestart = () => called++
    expect((await http('GET', '/api/admin/dashboard', { token: a.token })).json.server.restart).toBe(true)
    expect((await http('POST', '/api/admin/restart', { token: a.token })).status).toBe(202)
    await new Promise((r) => setTimeout(r, 400))
    expect(called).toBe(1)
    delete server.ctx.requestRestart
  })

  it('a plugged-in route group gets the parsed body and the actor; the router authenticates and audits', async () => {
    const seen: unknown[] = []
    registerAdminRouteGroup({ prefix: 'boss', handle: (_ctx, req) => (seen.push(req), { status: req.method === 'GET' ? 200 : 422, body: { ok: req.method === 'GET', issues: [] } }) })
    expect(() => registerAdminRouteGroup({ prefix: 'accounts', handle: () => ({ status: 200, body: null }) })).toThrow()
    expect((await http('GET', '/api/admin/boss')).status).toBe(401)
    const a = await newAdmin()
    expect((await http('GET', '/api/admin/boss?x=1', { token: a.token })).json).toEqual({ ok: true, issues: [] })
    const put = await http('PUT', '/api/admin/boss/settings', { token: a.token, body: { code: 'MOB_CH_TIGERWOMAN', baseRev: 1, patch: { minLevel: 99 } } })
    expect(put.status).toBe(422)
    expect(seen[1]).toMatchObject({ method: 'PUT', path: '/api/admin/boss/settings', body: { code: 'MOB_CH_TIGERWOMAN', baseRev: 1 }, actor: { accountId: a.id, role: 'admin', username: a.username } })
    expect((seen[0] as { query: URLSearchParams }).query.get('x')).toBe('1')
    expect(auditRows('boss.put').at(-1)).toMatchObject({ ok: 0, target: 'boss/settings', detail: 'HTTP 422' })
    const events = await http('GET', '/api/admin/events', { token: a.token })
    expect(events.json.events[0]).toMatchObject({ id: 'play-the-boss', state: 'unavailable', routes: 'boss', spec: 'docs/PLAY_THE_BOSS.md' })
  })
})

describe('/admin/ files', () => {
  it('serves the built panel with a strict CSP (SPA routes too); ADMIN_PANEL=off hides panel and API', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'sro-admin-dist-'))
    mkdirSync(join(dist, 'assets'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Admin</title>')
    writeFileSync(join(dist, 'assets', 'index-AbCd1234.js'), 'console.log(1)')
    const t = await startTestServer({ config: { adminDist: dist, serveStatic: false } })
    try {
      const head = await fetch(`${t.url}/admin`, { redirect: 'manual' })
      expect(head.status).toBe(301)
      expect(head.headers.get('location')).toBe('/admin/')
      const index = await fetch(`${t.url}/admin/`)
      expect(await index.text()).toContain('<title>Admin</title>')
      expect(index.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(index.headers.get('x-frame-options')).toBe('DENY')
      expect(await (await fetch(`${t.url}/admin/accounts`)).text()).toContain('<title>Admin</title>')
      const js = await fetch(`${t.url}/admin/assets/index-AbCd1234.js`)
      expect(js.headers.get('cache-control')).toContain('immutable')
      expect((await fetch(`${t.url}/admin/assets/missing.js`)).status).toBe(404)
    } finally {
      await t.stopAndClean()
    }
    const off = await startTestServer({ config: { adminDist: dist, adminPanel: false } })
    try {
      expect((await fetch(`${off.url}/admin/`)).status).not.toBe(200)
      expect((await fetch(`${off.url}/api/admin/login`, { method: 'POST', body: '{}' })).status).toBe(404)
    } finally {
      await off.stopAndClean()
      rmSync(dist, { recursive: true, force: true })
    }
  })
})
