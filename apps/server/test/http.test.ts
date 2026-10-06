import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashToken } from '../src/auth.ts'
import { api, rawGet, startTestServer, type TestServer } from './helpers.ts'

let s: TestServer

beforeAll(async () => {
  s = await startTestServer({
    config: { registerPerHour: 1000 },
    files: {
      'dist/index.html': '<!doctype html><title>game</title>',
      'dist/assets/app-123.js': 'console.log(1)',
      'out/index.json': '{"entries":[]}',
      'out/char/chinaman.glb': 'glTF-fake',
      'out/music/town.ogg': 'OggS',
      'out/tex/a.ktx2': 'KTX',
      'out/tex/a.png': 'PNG',
      'secret.txt': 'TOP SECRET',
      'out/.hidden': 'hidden',
    },
  })
})

afterAll(async () => {
  await s.stopAndClean()
})

describe('accounts API', () => {
  it('registers, rejects duplicates case-insensitively, and logs in', async () => {
    const r = await api(s.url, '/api/register', { username: 'Alice_1', password: 'hunter22' })
    expect(r.status).toBe(201)
    expect(r.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.json.expiresAt).toBeGreaterThan(Date.now() + 6.9 * 24 * 3600 * 1000)

    const dup = await api(s.url, '/api/register', { username: 'alice_1', password: 'whatever1' })
    expect(dup.status).toBe(409)
    expect(dup.json.error).toBe('name_taken')

    const ok = await api(s.url, '/api/login', { username: 'ALICE_1', password: 'hunter22' })
    expect(ok.status).toBe(200)
    expect(typeof ok.json.token).toBe('string')
    expect(ok.json.token).not.toBe(r.json.token)
  })

  it('rejects a bad password and an unknown user with the same answer', async () => {
    await api(s.url, '/api/register', { username: 'bobby', password: 'correct1' })
    const bad = await api(s.url, '/api/login', { username: 'bobby', password: 'wrong123' })
    expect(bad.status).toBe(401)
    expect(bad.json).toEqual({ error: 'unauthorized', message: 'wrong username or password' })
    const unknown = await api(s.url, '/api/login', { username: 'nobody', password: 'wrong123' })
    expect(unknown.status).toBe(401)
    expect(unknown.json).toEqual(bad.json)
  })

  it('validates usernames, passwords and bodies', async () => {
    for (const body of [
      { username: 'ab', password: 'password1' },
      { username: 'a'.repeat(17), password: 'password1' },
      { username: 'bad name', password: 'password1' },
      { username: 'good_name', password: '12345' },
      { username: 'good_name', password: 'x'.repeat(65) },
      { username: 'good_name', password: 'password1', extra: 1 },
      { username: 5, password: 'password1' },
      [],
    ]) {
      const r = await api(s.url, '/api/register', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json.error).toBe('bad_request')
    }
    const notJson = await api(s.url, '/api/register', '{nope')
    expect(notJson.status).toBe(400)
    const huge = await api(s.url, '/api/register', { username: 'big', password: 'x'.repeat(10_000) })
    expect(huge.status).toBe(413)
  })

  it('rate limits failed logins per IP+username', async () => {
    await api(s.url, '/api/register', { username: 'target', password: 'correct1' })
    for (let i = 0; i < 5; i++) expect((await api(s.url, '/api/login', { username: 'target', password: 'guess' + i })).status).toBe(401)
    const blocked = await api(s.url, '/api/login', { username: 'target', password: 'correct1' })
    expect(blocked.status).toBe(429)
    expect(blocked.json.error).toBe('rate_limited')
    // another username from the same IP is unaffected
    await api(s.url, '/api/register', { username: 'other', password: 'correct1' })
    expect((await api(s.url, '/api/login', { username: 'other', password: 'correct1' })).status).toBe(200)
  })

  it('lists one server and reports health', async () => {
    const r = await api(s.url, '/api/servers')
    expect(r.status).toBe(200)
    // wave 10 (docs/SCREENS.md §9): plus the clock anchor and the weather (apps/server/test/servers-clock.test.ts)
    expect(r.json).toEqual([{ id: 'jangan', name: 'Jangan', status: 'online', online: 0, capacity: 50, world: 'jangan', clock: expect.any(Object), weather: expect.any(Object), registration: 'open' }])
    const h = await api(s.url, '/health')
    expect(h.json.ok).toBe(true)
    expect(h.json.schema).toBe(17)
  })

  it('logout revokes the token', async () => {
    const r = await api(s.url, '/api/register', { username: 'leaver', password: 'password1' })
    expect(s.ctx.store.sessionAccount(hashToken(r.json.token))?.username).toBe('leaver')
    const res = await fetch(s.url + '/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${r.json.token}` } })
    expect(res.status).toBe(204)
    expect(s.ctx.store.sessionAccount(hashToken(r.json.token))).toBeUndefined()
  })

  it('404s unknown API routes', async () => {
    expect((await api(s.url, '/api/nope')).status).toBe(404)
  })
})

describe('static files', () => {
  it('serves the game and converted assets with MIME types', async () => {
    const index = await rawGet(s.url, '/')
    expect(index.status).toBe(200)
    expect(index.type).toMatch(/^text\/html/)
    expect((await rawGet(s.url, '/assets/app-123.js')).type).toMatch(/^text\/javascript/)
    const cases: [string, string][] = [
      ['/out/char/chinaman.glb', 'model/gltf-binary'],
      ['/out/index.json', 'application/json; charset=utf-8'],
      ['/out/music/town.ogg', 'audio/ogg'],
      ['/out/tex/a.ktx2', 'image/ktx2'],
      ['/out/tex/a.png', 'image/png'],
    ]
    for (const [path, type] of cases) {
      const r = await rawGet(s.url, path)
      expect(r.status, path).toBe(200)
      expect(r.type, path).toBe(type)
    }
  })

  it('falls back to index.html for client routes but not for missing files', async () => {
    const route = await rawGet(s.url, '/characters/select')
    expect(route.status).toBe(200)
    expect(route.body).toContain('<title>game</title>')
    expect((await rawGet(s.url, '/out/char/missing.glb')).status).toBe(404)
    expect((await rawGet(s.url, '/missing.js')).status).toBe(404)
  })

  it('blocks path traversal', async () => {
    const attempts = [
      '/out/../secret.txt',
      '/out/../../secret.txt',
      '/out/%2e%2e/secret.txt',
      '/out/..%2fsecret.txt',
      '/out/%2e%2e%2fsecret.txt',
      '/out/..%5csecret.txt',
      '/out/..\\secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/out/%00/index.json',
      '/out/.hidden',
      '/out/%E0%A4%A',
      '/out//etc/passwd',
      '/out/C:/Windows/win.ini',
      '/../data/game.db',
      '/out/../data/game.db',
    ]
    for (const path of attempts) {
      const r = await rawGet(s.url, path)
      expect(r.body, path).not.toContain('TOP SECRET')
      expect(r.body, path).not.toContain('hidden')
      expect(r.body, path).not.toContain('SQLite')
      expect([400, 404], `${path} -> ${r.status}`).toContain(r.status)
    }
  })

  it('refuses websocket upgrades on other paths', async () => {
    const { default: WebSocket } = await import('ws')
    const ws = new WebSocket(s.url.replace('http', 'ws') + '/notws')
    const err = await new Promise<unknown>((resolve) => {
      ws.on('error', resolve)
      ws.on('open', () => resolve(null))
    })
    expect(err).toBeInstanceOf(Error)
  })
})
