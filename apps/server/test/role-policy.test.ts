/**
 * OWNER-ONLY ROLE POLICY (user requirement): only the server owner can make an account a GM, and only
 * through the server-side CLI (`pnpm gm grant <user>`, run on the server machine). No in-game message,
 * GM command, HTTP endpoint or registration field may ever change a role. If this test fails, a path
 * that changes roles was added — remove it rather than loosening the test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parseClientMessage, type Role } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const SRC = join(import.meta.dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('role changes exist only in the owner CLI (static)', () => {
  const files = sourceFiles(SRC).map(p => ({ rel: relative(SRC, p).split(sep).join('/'), text: readFileSync(p, 'utf8') }))

  it('only db.ts contains SQL that writes accounts.role', () => {
    const writers = files.filter(f => /UPDATE\s+accounts\s+SET[^;'`]*\brole\b/i.test(f.text) || /INSERT\s+INTO\s+accounts\s*\([^)]*\brole\b/i.test(f.text))
    expect(writers.map(f => f.rel)).toEqual(['db.ts'])
  })

  it('only the CLI calls setRole', () => {
    const callers = files.filter(f => f.rel !== 'db.ts' && /\bsetRole\s*\(/.test(f.text))
    expect(callers.map(f => f.rel)).toEqual(['cli/gm.ts'])
  })
})

describe('no in-game path changes a role (dynamic)', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await startTestServer({ files: { 'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [10, 0, -10] }) } })
  })
  afterAll(async () => {
    await s.stopAndClean()
  })

  const roleOf = (username: string): Role => s.ctx.store.accountByName(username)!.role as Role

  async function inWorld(role: Role, prefix: string) {
    const acc = await newAccount(s.url, prefix)
    if (role !== 'player') s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role) // test setup = the owner's CLI
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `${prefix}${Math.floor(Math.random() * 1e6)}`.slice(0, 12), model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    return { acc, c }
  }

  it('registration ignores any role field', async () => {
    const username = `reg${Date.now() % 1e8}`
    const r = await api(s.url, '/api/register', { username, password: 'password1', role: 'admin', isGm: true })
    expect([201, 400]).toContain(r.status)
    if (r.status === 201) expect(roleOf(username)).toBe('player')
  })

  it('the protocol has no role-changing client message', () => {
    for (const msg of [{ t: 'role', role: 'gm' }, { t: 'setRole', role: 'admin' }, { t: 'grant', user: 'x' }, { t: 'hello', version: 1, token: 'x', role: 'admin' }]) {
      const parsed = parseClientMessage(JSON.stringify(msg)) as { ok?: boolean } | null | undefined
      const accepted = parsed && (parsed as { ok?: boolean }).ok !== false && !('error' in (parsed as object))
      if (accepted) expect(JSON.stringify(parsed)).not.toMatch(/"role"\s*:\s*"(gm|admin)"/)
    }
  })

  it('players, GMs and admins cannot grant or raise roles with any command', async () => {
    const victim = await inWorld('player', 'vic')
    const player = await inWorld('player', 'pla')
    const gm = await inWorld('gm', 'gmx')
    const admin = await inWorld('admin', 'adm')
    const attempts = ['grant', 'role', 'setrole', 'promote', 'admin', 'op', 'gm', 'owner', 'elevate']
    for (const who of [player, gm, admin]) {
      for (const cmd of attempts) {
        who.c.send({ t: 'gm', cmd, args: [victim.acc.username, 'admin'] })
        who.c.send({ t: 'gm', cmd, args: [who.acc.username, 'admin'] })
        who.c.send({ t: 'chat', text: `/${cmd} ${victim.acc.username} gm` })
        await sleep(15)
      }
    }
    await sleep(200)
    expect(roleOf(victim.acc.username)).toBe('player')
    expect(roleOf(player.acc.username)).toBe('player')
    expect(roleOf(gm.acc.username)).toBe('gm')
    expect(roleOf(admin.acc.username)).toBe('admin')
    for (const x of [victim, player, gm, admin]) if (!x.c.isClosed) x.c.close()
  })
})
