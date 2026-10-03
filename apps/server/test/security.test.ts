import { request } from 'node:http'
import { CLOSE_CODE, PROTOCOL_VERSION } from '@sro/shared'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FailureLimiter, MAX_SESSIONS_PER_ACCOUNT, hashPassword, hashToken, verifyPassword } from '../src/auth.ts'
import { DEV_ORIGINS, loadConfig } from '../src/config.ts'
import { isReservedName } from '../src/connection.ts'
import { Client, api, newAccount, rawGet, startTestServer, type TestServer } from './helpers.ts'

let s: TestServer

beforeAll(async () => {
  s = await startTestServer({
    config: { allowedOrigins: [...DEV_ORIGINS] },
    files: {
      'secret.txt': 'TOP SECRET',
      'out/index.json': '[]',
      'dist/index.html': '<!doctype html><title>game</title>',
    },
  })
})

afterAll(async () => {
  await s.stopAndClean()
})

/** POST JSON with arbitrary headers (fetch forbids setting Origin/Host). */
function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const u = new URL(s.url)
  const data = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
        })
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

function openWs(headers: Record<string, string> = {}): Promise<{ ok: boolean; status?: number; ws: WebSocket }> {
  const ws = new WebSocket(s.url.replace(/^http/, 'ws') + '/ws', { headers })
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ ok: true, ws }))
    ws.on('unexpected-response', (_req, res) => {
      resolve({ ok: false, status: res.statusCode, ws })
      res.resume()
    })
    ws.on('error', () => resolve({ ok: false, ws }))
  })
}

describe('passwords', () => {
  it('verifies hashes made with older (stored) parameters', async () => {
    const { scryptSync, randomBytes } = await import('node:crypto')
    const salt = randomBytes(16)
    const key = scryptSync('secret1', salt, 64, { N: 16384, r: 8, p: 1 })
    const legacy = `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`
    expect(await verifyPassword('secret1', legacy)).toBe(true)
    expect(await verifyPassword('secret2', legacy)).toBe(false)
  })

  it('rejects malformed or absurd stored hashes without throwing', async () => {
    for (const bad of ['', 'plain', 'scrypt$1$1$1$AA==$AA==', 'scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==', 'bcrypt$x']) {
      expect(await verifyPassword('secret1', bad), bad).toBe(false)
    }
  })

  it('normalizes passwords to NFC', async () => {
    const h = await hashPassword('café123')
    expect(await verifyPassword('café123', h)).toBe(true)
  })

  it('limiter forgive takes back one attempt', () => {
    const f = new FailureLimiter(2, 1000)
    f.fail('k', 0)
    f.fail('k', 0)
    expect(f.blocked('k', 1)).toBe(true)
    f.forgive('k')
    expect(f.blocked('k', 1)).toBe(false)
  })
})

describe('names', () => {
  it('reserves staff-looking character names', () => {
    for (const n of ['GM', 'gm_bob', 'Gm1', 'Admin', 'ADMIN_x', 'admin01', 'System', 'sys_op', 'Moderator', 'staff_1', 'Joymax']) {
      expect(isReservedName(n), n).toBe(true)
    }
    for (const n of ['Gmork', 'Adminton', 'Systemic', 'Hero', 'Modest']) expect(isReservedName(n), n).toBe(false)
  })
})

describe('origin policy', () => {
  it('config lists the Vite origins and validates ALLOWED_ORIGINS', () => {
    const c = loadConfig({ ALLOWED_ORIGINS: 'http://100.64.0.5:7000, https://game.example/' })
    expect(c.allowedOrigins).toEqual(expect.arrayContaining(['http://localhost:5180', 'http://127.0.0.1:5181', 'http://100.64.0.5:7000', 'https://game.example']))
    expect(() => loadConfig({ ALLOWED_ORIGINS: 'not a url' })).toThrow(/ALLOWED_ORIGINS/)
  })

  it('/api accepts no Origin, the same origin and the dev origins, and refuses others', async () => {
    const body = { username: 'nobody_here', password: 'whatever1' }
    const host = new URL(s.url).host
    expect((await post('/api/login', body)).status).toBe(401)
    expect((await post('/api/login', body, { Origin: `http://${host}` })).status).toBe(401)
    expect((await post('/api/login', body, { Origin: 'http://localhost:5180' })).status).toBe(401)
    for (const origin of ['https://evil.example', 'null', 'http://localhost:5999', 'http://127.0.0.1:1', 'file://', 'garbage']) {
      const r = await post('/api/login', body, { Origin: origin })
      expect(r.status, origin).toBe(403)
      expect(r.json).toEqual({ error: 'unauthorized', message: 'origin not allowed' })
    }
    const r = await post('/api/register', { username: 'csrfvictim', password: 'password1' }, { Origin: 'https://evil.example' })
    expect(r.status).toBe(403)
    expect(s.ctx.store.accountByName('csrfvictim')).toBeUndefined()
  })

  it('/ws refuses foreign origins before the upgrade', async () => {
    const bad = await openWs({ Origin: 'https://evil.example' })
    expect(bad.ok).toBe(false)
    expect(bad.status).toBe(403)
    for (const origin of [undefined, 'http://localhost:5180', `http://${new URL(s.url).host}`]) {
      const good = await openWs(origin ? { Origin: origin } : {})
      expect(good.ok, origin).toBe(true)
      good.ws.close()
    }
  })
})

describe('sessions', () => {
  it('parallel wrong-password bursts cannot exceed the login limit', async () => {
    await api(s.url, '/api/register', { username: 'burst', password: 'correct1' })
    const results = await Promise.all(Array.from({ length: 20 }, () => api(s.url, '/api/login', { username: 'burst', password: 'wrong000' })))
    const tried = results.filter((r) => r.status === 401).length
    expect(tried).toBeLessThanOrEqual(5)
    expect(results.filter((r) => r.status === 429).length).toBe(20 - tried)
  })

  it('a successful login does not count against the per-IP limit', async () => {
    await api(s.url, '/api/register', { username: 'frequent', password: 'correct1' })
    for (let i = 0; i < 8; i++) expect((await api(s.url, '/api/login', { username: 'frequent', password: 'correct1' })).status).toBe(200)
  })

  it('keeps at most MAX_SESSIONS_PER_ACCOUNT sessions, revoking the oldest', async () => {
    const first = await api(s.url, '/api/register', { username: 'manylogins', password: 'correct1' })
    const tokens = [first.json.token as string]
    for (let i = 0; i < MAX_SESSIONS_PER_ACCOUNT; i++) {
      tokens.push((await api(s.url, '/api/login', { username: 'manylogins', password: 'correct1' })).json.token)
    }
    expect(s.ctx.store.sessionAccount(hashToken(tokens[0]))).toBeUndefined()
    expect(s.ctx.store.sessionAccount(hashToken(tokens.at(-1)!))?.username).toBe('manylogins')
    const n = s.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.username = ?').get('manylogins') as { n: number }
    expect(n.n).toBe(MAX_SESSIONS_PER_ACCOUNT)
  })

  it('logout closes the live socket of that token', async () => {
    const acc = await newAccount(s.url, 'logout')
    const c = await Client.login(s.url, acc.token)
    const res = await fetch(s.url + '/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${acc.token}` } })
    expect(res.status).toBe(204)
    expect((await c.next('error')).code).toBe('unauthorized')
    expect((await c.closed).code).toBe(CLOSE_CODE.unauthorized)
    // and the token no longer works
    const again = await Client.connect(s.url)
    again.send({ t: 'hello', version: PROTOCOL_VERSION, token: acc.token })
    expect((await again.next('error')).code).toBe('unauthorized')
  })

  it('tokens are 256-bit base64url and only their hash is stored', async () => {
    const r = await api(s.url, '/api/register', { username: 'tokencheck', password: 'correct1' })
    expect(r.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const rows = s.ctx.store.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]
    expect(rows.some((x) => x.token_hash === r.json.token)).toBe(false)
    expect(rows.some((x) => x.token_hash === hashToken(r.json.token))).toBe(true)
  })

  it('usernames with unicode, whitespace or case tricks are refused or collide', async () => {
    await api(s.url, '/api/register', { username: 'Alice', password: 'correct1' })
    for (const u of ['alice', 'ALICE']) expect((await api(s.url, '/api/register', { username: u, password: 'correct1' })).status).toBe(409)
    for (const u of ['alice ', ' alice', 'al ice', 'alice\n', 'аlice', 'Ａlice', 'alice​', 'álice', '']) {
      expect((await api(s.url, '/api/register', { username: u, password: 'correct1' })).status, JSON.stringify(u)).toBe(400)
    }
    // login is case-insensitive on the account name
    expect((await api(s.url, '/api/login', { username: 'ALICE', password: 'correct1' })).status).toBe(200)
  })
})

describe('http hardening', () => {
  it('refuses absolute, UNC and encoded paths', async () => {
    const attempts = [
      '/out/%2Fsecret.txt',
      '/out/%2F%2E%2E%2Fsecret.txt',
      '/out/%5C%5C127.0.0.1%5Cc%24%5Csecret.txt',
      '/out/C%3A%5CWindows%5Cwin.ini',
      '/out/%252e%252e/secret.txt',
      '/out/..%c0%af..%c0%afsecret.txt',
      '/out/index.json%00.png',
      '/out/index.json::$DATA',
    ]
    for (const path of attempts) {
      const r = await rawGet(s.url, path)
      expect(r.body, path).not.toContain('TOP SECRET')
      expect([400, 404], `${path} -> ${r.status}`).toContain(r.status)
    }
  })

  it('does not leak internals on bad JSON or huge bodies', async () => {
    const bad = await api(s.url, '/api/login', '{"username": ')
    expect(bad).toEqual({ status: 400, json: { error: 'bad_request', message: 'body must be JSON' } })
    const huge = await api(s.url, '/api/login', JSON.stringify({ username: 'x'.repeat(10_000), password: 'y' }))
    expect(huge.status).toBe(413)
    expect(JSON.stringify(huge.json)).not.toMatch(/at |\\|node_modules|stack/)
  })

  it('sends anti-framing headers on static files', async () => {
    const res = await fetch(s.url + '/')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
