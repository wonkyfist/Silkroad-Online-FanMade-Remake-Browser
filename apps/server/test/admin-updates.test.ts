/**
 * The Updates page's API (docs/UPDATES.md §5, docs/ADMIN.md §3) on a real server over HTTP: admins only (no token
 * 401, a game token 401, a GM 403), the settings checked and audited, Check now, Update now refused with the reasons,
 * and a clear 409 on a server without an updater. The updater runs over a local git fixture.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AdminLoginResponse } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Updater } from '../src/updater/updater.ts'
import { UPDATE_DEFAULTS, saveUpdateSettings } from '../src/updater/settings.ts'
import { newAccount, startTestServer, type TestServer } from './helpers.ts'
import { ITEMS, LEVELS, MANGNYANG, contentFiles } from './fixtures.ts'
import { makeRepos, type Repos } from './updater-fixture.ts'

let s: TestServer
let repos: Repos
let ipN = 0

beforeAll(async () => {
  s = await startTestServer({
    config: { trustProxy: true },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [50, 0, -50], bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
      ...contentFiles({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS }),
    },
  })
  repos = makeRepos()
  const dataDir = join(s.root, 'updater-data')
  mkdirSync(dataDir, { recursive: true })
  saveUpdateSettings(dataDir, { ...UPDATE_DEFAULTS, repoUrl: repos.origin })
  s.ctx.updater = new Updater({
    root: repos.server, dataDir, supervised: false, allowLocalOrigin: true, minFreeBytes: 0, serverTz: 'UTC',
    log: () => {}, online: () => 0, broadcast: () => {}, backupDb: async () => {}, schemaVersion: () => s.ctx.store.schemaVersion, requestExit: () => {},
  })
})

afterAll(async () => {
  s.ctx.updater?.stop()
  await s.stopAndClean()
  repos.cleanup()
})

const ip = () => `10.77.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`

async function http(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(s.url + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Forwarded-For': ip() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

async function login(role: 'admin' | 'gm'): Promise<{ token: string; gameToken: string }> {
  const acc = await newAccount(s.url, role)
  s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role)
  const r = await http('POST', '/api/admin/login', undefined, { username: acc.username, password: 'password1' })
  return { token: (r.json as AdminLoginResponse | null)?.token ?? '', gameToken: acc.token }
}

const audit = (action: string) => s.ctx.store.db.prepare('SELECT * FROM admin_audit WHERE action = ? ORDER BY id').all(action) as { ok: number; before: string | null; after: string | null; detail: string }[]

describe('Updates API', () => {
  it('admins only', async () => {
    const gm = await login('gm')
    const admin = await login('admin')
    for (const [m, p] of [['GET', 'updates'], ['PUT', 'updates/settings'], ['POST', 'updates/check'], ['POST', 'updates/install'], ['POST', 'updates/cancel'], ['POST', 'updates/rollback']] as const) {
      expect((await http(m, `/api/admin/${p}`, undefined, m === 'GET' ? undefined : {})).status).toBe(401)
      expect((await http(m, `/api/admin/${p}`, admin.gameToken, m === 'GET' ? undefined : {})).status).toBe(401)
      // A GM cannot log in to the panel at all.
      expect(gm.token).toBe('')
    }
  })

  it('the view, the settings (checked, audited), a check and the refusals', async () => {
    const { token } = await login('admin')
    let r = await http('GET', '/api/admin/updates', token)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ install: 'git', supervised: false, settings: { mode: 'notify', intervalMin: 60 } })

    r = await http('PUT', '/api/admin/updates/settings', token, { values: { mode: 'sometimes', intervalMin: 1 } })
    expect(r.status).toBe(400)
    expect(r.json.message).toMatch(/mode must be/)
    r = await http('PUT', '/api/admin/updates/settings', token, { values: { repoUrl: 'http://example.com/a/b' } })
    expect(r.status).toBe(400)
    r = await http('PUT', '/api/admin/updates/settings', token, { values: { mode: 'auto', windowEnabled: true, windowStart: '22:00', windowEnd: '06:00' } })
    expect(r.status).toBe(200)
    expect(r.json.settings).toMatchObject({ mode: 'auto', windowEnabled: true, windowStart: '22:00' })
    const rows = audit('updates.settings')
    expect(rows.map((x) => x.ok)).toEqual([0, 0, 1])
    expect(JSON.parse(rows[2].before!).mode).toBe('notify')
    expect(JSON.parse(rows[2].after!).mode).toBe('auto')

    repos.commit('new', { 'n.txt': 'n' })
    r = await http('POST', '/api/admin/updates/check', token, {})
    expect(r.status).toBe(202)
    for (let i = 0; i < 100; i++) {
      r = await http('GET', '/api/admin/updates', token)
      if (!r.json.checking && r.json.lastCheck) break
      await new Promise((ok) => setTimeout(ok, 50))
    }
    expect(r.json).toMatchObject({ behind: 1, canUpdate: false, lastCheck: { ok: true } })
    expect(r.json.blockers.join(' ')).toMatch(/pnpm serve/)

    r = await http('POST', '/api/admin/updates/install', token, {})
    expect(r.status).toBe(409)
    expect(r.json.message).toMatch(/pnpm serve/)
    expect(audit('updates.install').at(-1)?.ok).toBe(0)
    expect((await http('POST', '/api/admin/updates/cancel', token, {})).status).toBe(409)
    expect((await http('POST', '/api/admin/updates/rollback', token, {})).status).toBe(409)
    expect((await http('POST', '/api/admin/updates/install', token, { force: true })).status).toBe(400)
  })

  it('a server without an updater says so', async () => {
    const { token } = await login('admin')
    const u = s.ctx.updater
    s.ctx.updater = undefined
    try {
      const r = await http('GET', '/api/admin/updates', token)
      expect(r.status).toBe(409)
      expect(r.json.message).toMatch(/updater does not run/)
    } finally {
      s.ctx.updater = u
    }
  })
})
