/**
 * The "What's new" window, server side (docs/CHANGELOG_WINDOW.md): the loader (repo files + the admin panel's layer),
 * the order and the unseen rule per account, the seen mark, the player API (read with any session; images public),
 * the welcome's `news` count, the admin API (admins only write) and migration 15. A real server, real sockets.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { NEWS_UNSEEN_MAX, type AdminLoginResponse, type AdminNewsView, type ApiNewsList } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, migrate, openStore } from '../src/db.ts'
import { NewsStore, imageMatchesName } from '../src/news.ts'
import { Client, newAccount, rawGet, startTestServer, type TestServer } from './helpers.ts'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

function file(id: string, date: string, extra = '', body = 'Body.'): string {
  return `---\nid: ${id}\ndate: ${date}\ntitle: Title of ${id}\nsummary: About ${id}.\n${extra}---\n${body}\n`
}

function writeRepo(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const f = join(root, rel)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, content)
  }
}

describe('NewsStore (repo files + the panel layer)', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sro-news-'))
    writeRepo(root, {
      'content/changelog/2026-10-01-a.md': file('2026-10-01-a', '2026-10-01', 'hero: a.jpg\n', '![x](img/a.jpg)'),
      'content/changelog/2026-10-05-b.md': file('2026-10-05-b', '2026-10-05T15:00'),
      'content/changelog/2026-10-05-c.md': file('2026-10-05-c', '2026-10-05T22:00'),
      'content/changelog/README.md': '# how to write entries',
      'content/changelog/2026-10-06-broken.md': 'no front matter',
      'content/changelog/2026-10-07-missing-image.md': file('2026-10-07-missing-image', '2026-10-07', '', '![x](img/nope.jpg)'),
      'content/changelog/img/a.jpg': JPEG,
      // the panel: an edit of b, a new entry, a draft
      'data/content/changelog/2026-10-05-b.md': file('2026-10-05-b', '2026-10-05T15:00', '', 'Edited.').replace('Title of', 'Edited title of'),
      'data/content/changelog/2026-10-08-d.md': file('2026-10-08-d', '2026-10-08'),
      'data/content/changelog/2026-10-09-draft.md': file('2026-10-09-draft', '2026-10-09', 'draft: true\n'),
      'data/content/changelog/img/p.png': PNG,
    })
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('layers the panel over the repo, orders newest first, hides drafts and skips bad files with a problem', () => {
    const logs: string[] = []
    const news = NewsStore.open({ contentDir: join(root, 'content'), dataDir: join(root, 'data'), log: (m) => logs.push(m) })
    expect(news.all().map((e) => [e.id, e.source])).toEqual([
      ['2026-10-09-draft', 'panel'],
      ['2026-10-08-d', 'panel'],
      ['2026-10-05-c', 'repo'],
      ['2026-10-05-b', 'edited'],
      ['2026-10-01-a', 'repo'],
    ])
    expect(news.published().map((e) => e.id)).toEqual(['2026-10-08-d', '2026-10-05-c', '2026-10-05-b', '2026-10-01-a'])
    expect(news.get('2026-10-05-b')).toMatchObject({ title: 'Edited title of 2026-10-05-b', body: 'Edited.' })
    expect(news.images()).toEqual(['a.jpg', 'p.png'])
    expect(news.problems.map((p) => p.split(':')[0])).toEqual(['repo 2026-10-06-broken.md', 'repo 2026-10-07-missing-image.md'])
    expect(logs).toHaveLength(2)
    // revert: the edited entry goes back to the repo file; a panel-only entry is gone
    const copy = mkdtempSync(join(tmpdir(), 'sro-news-copy-'))
    try {
      const n2 = new NewsStore(join(root, 'content/changelog'), join(copy, 'changelog'))
      n2.save({ ...n2.get('2026-10-05-b')!, title: 'Mine' })
      expect(n2.get('2026-10-05-b')).toMatchObject({ title: 'Mine', source: 'edited' })
      expect(n2.revert('2026-10-05-b')).toBe(true)
      expect(n2.get('2026-10-05-b')).toMatchObject({ title: 'Title of 2026-10-05-b', source: 'repo' })
      expect(n2.revert('2026-10-05-b')).toBe(false)
      expect(n2.saveImage('x.jpg', PNG)).toHaveProperty('error')
      expect(n2.saveImage('../x.jpg', JPEG)).toHaveProperty('error')
      expect(n2.saveImage('x.jpg', JPEG)).toEqual({ ok: true })
      expect(existsSync(join(copy, 'changelog/img/x.jpg'))).toBe(true)
      expect(n2.images()).toContain('x.jpg')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('checks image signatures against the extension', () => {
    expect(imageMatchesName('a.jpg', JPEG)).toBe(true)
    expect(imageMatchesName('a.jpeg', JPEG)).toBe(true)
    expect(imageMatchesName('a.png', JPEG)).toBe(false)
    expect(imageMatchesName('a.png', PNG)).toBe(true)
    expect(imageMatchesName('a.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(true)
    expect(imageMatchesName('a.jpg', Buffer.from('<svg onload=alert(1)>'))).toBe(false)
  })
})

describe('the player API, the welcome count and the admin API', () => {
  let s: TestServer
  let contentDir: string
  let adminToken = ''

  beforeAll(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'sro-news-content-'))
    const today = new Date().toISOString().slice(0, 10)
    writeRepo(contentDir, {
      'changelog/2020-01-01-ancient.md': file('2020-01-01-ancient', '2020-01-01'),
      [`changelog/${today}-one.md`]: file(`${today}-one`, `${today}T01:00`, 'hero: one.jpg\n'),
      [`changelog/${today}-two.md`]: file(`${today}-two`, `${today}T02:00`),
      'changelog/img/one.jpg': JPEG,
    })
    s = await startTestServer({ config: { contentDir } })
    const acc = await newAccount(s.url, 'newsadmin')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'admin')
    const r = await fetch(`${s.url}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: acc.username, password: 'password1' }) })
    adminToken = ((await r.json()) as AdminLoginResponse).token
  })
  afterAll(async () => {
    await s.stopAndClean()
    rmSync(contentDir, { recursive: true, force: true })
  })

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(s.url + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
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

  it('GET /api/news needs a session; a new account sees only the entries from its creation day', async () => {
    expect((await call('GET', '/api/news')).status).toBe(401)
    expect((await call('GET', '/api/news', 'not-a-token')).status).toBe(401)
    const p = await newAccount(s.url, 'reader')
    const r = await call('GET', '/api/news', p.token)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const list = r.json as ApiNewsList
    const today = new Date().toISOString().slice(0, 10)
    expect(list.entries.map((e) => e.id)).toEqual([`${today}-two`, `${today}-one`, '2020-01-01-ancient'])
    expect(list.unseen).toEqual([`${today}-two`, `${today}-one`])
  })

  it('an older account sees every entry since; seen is per account, never moves back, and the welcome counts it', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const a = await newAccount(s.url, 'veteran')
    const b = await newAccount(s.url, 'other')
    const idA = s.ctx.store.accountByName(a.username)!.id
    s.ctx.store.db.prepare('UPDATE accounts SET created_at = 0 WHERE id = ?').run(idA)
    expect((await call('GET', '/api/news', a.token)).json.unseen).toEqual([`${today}-two`, `${today}-one`, '2020-01-01-ancient'])

    const c1 = await Client.login(s.url, a.token)
    expect(c1.log.find((m) => m.t === 'welcome')).toMatchObject({ news: 3 })
    c1.close()

    expect((await call('POST', '/api/news/seen', a.token, { id: `${today}-one` })).json).toEqual({ unseen: [`${today}-two`] })
    // an older id does not move the mark back
    expect((await call('POST', '/api/news/seen', a.token, { id: '2020-01-01-ancient' })).json).toEqual({ unseen: [`${today}-two`] })
    expect((await call('POST', '/api/news/seen', a.token, { id: `${today}-two` })).json).toEqual({ unseen: [] })
    expect(s.ctx.store.newsMark(idA)?.mark).toEqual({ date: `${today}T02:00`, id: `${today}-two` })
    const c2 = await Client.login(s.url, a.token)
    expect(c2.log.find((m) => m.t === 'welcome')).not.toHaveProperty('news')
    c2.close()
    // the other account is untouched
    expect((await call('GET', '/api/news', b.token)).json.unseen).toHaveLength(2)

    expect((await call('POST', '/api/news/seen', a.token, { id: 'no-such-entry' })).status).toBe(404)
    expect((await call('POST', '/api/news/seen', a.token, { id: '../x' })).status).toBe(400)
    expect((await call('POST', '/api/news/seen', a.token, { id: `${today}-two`, more: 1 })).status).toBe(400)
    expect((await call('POST', '/api/news/seen', undefined, { id: `${today}-two` })).status).toBe(401)
  })

  it('serves images publicly with a cache header, and nothing else', async () => {
    const r = await fetch(`${s.url}/api/news/img/one.jpg`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    expect(r.headers.get('cache-control')).toBe('public, max-age=86400')
    expect(Buffer.from(await r.arrayBuffer())).toEqual(JPEG)
    expect((await fetch(`${s.url}/api/news/img/missing.jpg`)).status).toBe(404)
    expect((await fetch(`${s.url}/api/news/img/ONE.JPG`)).status).toBe(404)
    for (const p of ['/api/news/img/../2020-01-01-ancient.md', '/api/news/img/..%2F2020-01-01-ancient.md', '/api/news/img/%2e%2e/x.jpg', '/api/news/img/']) {
      expect((await rawGet(s.url, p)).status, p).toBe(404)
    }
  })

  it('admin API: only admin sessions; save, upload, revert; players see the result', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const p = await newAccount(s.url, 'notadmin')
    // a game session is not an admin session, and a non-admin cannot log in to the panel
    expect((await call('GET', '/api/admin/news', p.token)).status).toBe(401)
    expect((await call('PUT', `/api/admin/news/${today}-three`, p.token, { date: today, title: 'x', summary: '', body: 'x' })).status).toBe(401)
    expect((await call('POST', '/api/admin/login', undefined, { username: p.username, password: 'password1' })).status).toBe(403)
    expect((await call('PUT', `/api/admin/news/${today}-three`, undefined, { date: today, title: 'x', summary: '', body: 'x' })).status).toBe(401)

    const view = (await call('GET', '/api/admin/news', adminToken)).json as AdminNewsView
    expect(view.entries.map((e) => [e.id, e.source])).toEqual([[`${today}-two`, 'repo'], [`${today}-one`, 'repo'], ['2020-01-01-ancient', 'repo']])
    expect(view.images).toEqual(['one.jpg'])

    // an image upload (base64), checked against its name
    expect((await call('POST', '/api/admin/news-images', adminToken, { name: 'shot.png', data: JPEG.toString('base64') })).status).toBe(400)
    expect((await call('POST', '/api/admin/news-images', adminToken, { name: '../shot.jpg', data: JPEG.toString('base64') })).status).toBe(400)
    const up = await call('POST', '/api/admin/news-images', adminToken, { name: 'shot.jpg', data: JPEG.toString('base64') })
    expect(up.status).toBe(201)
    expect(up.json.images).toEqual(['one.jpg', 'shot.jpg'])
    expect(existsSync(join(s.root, 'data/content/changelog/img/shot.jpg'))).toBe(true)

    // a new entry; problems come back as issues
    const bad = await call('PUT', `/api/admin/news/${today}-three`, adminToken, { date: 'soon', title: '', summary: '', body: '![x](http://evil/x.jpg)' })
    expect(bad.status).toBe(400)
    expect(bad.json.issues.length).toBeGreaterThanOrEqual(3)
    expect((await call('PUT', `/api/admin/news/${today}-three`, adminToken, { date: today, title: 'x', summary: '', body: '![x](img/none.jpg)' })).status).toBe(400)
    const put = await call('PUT', `/api/admin/news/${today}-three`, adminToken, { date: `${today}T03:00`, title: 'Three', summary: 'S', hero: 'shot.jpg', body: '## Hi\n\n![x](img/shot.jpg)' })
    expect(put.status).toBe(200)
    expect(put.json).toMatchObject({ id: `${today}-three`, source: 'panel', hero: 'shot.jpg' })
    expect(readFileSync(join(s.root, `data/content/changelog/${today}-three.md`), 'utf8')).toContain('title: Three')
    const list = (await call('GET', '/api/news', p.token)).json as ApiNewsList
    expect(list.entries[0].id).toBe(`${today}-three`)
    expect(list.unseen[0]).toBe(`${today}-three`)

    // a draft is hidden from players
    await call('PUT', `/api/admin/news/${today}-three`, adminToken, { date: `${today}T03:00`, title: 'Three', summary: 'S', draft: true, body: 'x' })
    expect(((await call('GET', '/api/news', p.token)).json as ApiNewsList).entries.map((e) => e.id)).not.toContain(`${today}-three`)

    // edit a repo entry, then revert it
    await call('PUT', `/api/admin/news/${today}-one`, adminToken, { date: `${today}T01:00`, title: 'Changed', summary: '', body: 'x' })
    expect((await call('GET', `/api/admin/news/${today}-one`, adminToken)).json).toMatchObject({ title: 'Changed', source: 'edited' })
    expect((await call('DELETE', `/api/admin/news/${today}-one`, adminToken)).json).toMatchObject({ reverted: true, entry: { title: `Title of ${today}-one`, source: 'repo' } })
    expect((await call('DELETE', `/api/admin/news/${today}-one`, adminToken)).status).toBe(404)
    expect((await call('DELETE', `/api/admin/news/${today}-three`, adminToken)).json).toEqual({ reverted: true, entry: null })

    const audit = s.ctx.store.db.prepare("SELECT action, ok FROM admin_audit WHERE action LIKE 'news.%' ORDER BY id").all() as { action: string; ok: number }[]
    expect(audit.filter((a) => a.ok === 1).map((a) => a.action)).toEqual(['news.image', 'news.put', 'news.put', 'news.put', 'news.delete', 'news.delete'])
  })

  it('the unseen list is capped', async () => {
    for (let i = 0; i < NEWS_UNSEEN_MAX + 2; i++) s.ctx.news.save({ id: `cap-${i}`, date: `2099-01-0${i + 1}`, title: `Cap ${i}`, summary: '', body: 'x' })
    const p = await newAccount(s.url, 'capped')
    expect(((await call('GET', '/api/news', p.token)).json as ApiNewsList).unseen).toHaveLength(NEWS_UNSEEN_MAX)
  })
})

describe('migration 15', () => {
  it('adds the seen mark to accounts of a v14 database, keeping them', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-migrate-news-'))
    try {
      const v14 = new Database(join(root, 'game.db'))
      expect(migrate(v14, 14)).toBe(14)
      v14.exec("INSERT INTO accounts (id, username, password_hash, created_at) VALUES (4, 'old', 'x', 123)")
      expect(() => v14.prepare('SELECT news_seen_date FROM accounts').all()).toThrow()
      v14.close()
      const store = openStore(root)
      try {
        expect(SCHEMA_VERSION).toBe(19)
        expect(store.schemaVersion).toBe(19)
        expect(store.newsMark(4)).toEqual({ createdAt: 123, mark: null })
        expect(store.newsMark(99)).toBeNull()
        expect(store.setNewsMark(4, { date: '2026-10-05', id: 'x' })).toBe(true)
        expect(store.newsMark(4)).toEqual({ createdAt: 123, mark: { date: '2026-10-05', id: 'x' } })
      } finally {
        store.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
