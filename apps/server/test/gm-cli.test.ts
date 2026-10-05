import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/gm.ts'
import { openStore } from '../src/db.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sro-gm-cli-'))
  const store = openStore(dir)
  store.createAccount('Alice', 'x')
  store.createAccount('bob', 'x')
  store.close()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function cli(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = runCli(argv, { DATA_DIR: dir }, (l) => out.push(l), (l) => err.push(l))
  return { code, out: out.join('\n'), err: err.join('\n') }
}

function role(username: string): string {
  const db = new Database(join(dir, 'game.db'), { readonly: true })
  try {
    return (db.prepare('SELECT role FROM accounts WHERE username = ?').get(username) as { role: string }).role
  } finally {
    db.close()
  }
}

describe('pnpm gm', () => {
  it('new accounts are players; grant (default gm), grant --role admin, revoke', () => {
    expect(role('alice')).toBe('player')
    expect(cli('list')).toMatchObject({ code: 0, out: 'no gm or admin accounts' })

    const g = cli('grant', 'alice')
    expect(g.code).toBe(0)
    expect(g.out).toContain('Alice: player -> gm')
    expect(role('Alice')).toBe('gm')
    expect(cli('grant', 'alice')).toMatchObject({ code: 0, out: 'Alice is already gm' })

    expect(cli('grant', 'BOB', '--role', 'admin').code).toBe(0)
    expect(cli('grant', 'alice', '--role=admin').code).toBe(0)
    expect(role('alice')).toBe('admin')

    const list = cli('list')
    expect(list.code).toBe(0)
    expect(list.out.split('\n')).toHaveLength(2)
    expect(list.out).toMatch(/^Alice\s+admin\s+last login never/m)
    expect(list.out).toMatch(/^bob\s+admin/m)

    expect(cli('revoke', 'alice').code).toBe(0)
    expect(role('alice')).toBe('player')
    expect(cli('list').out).not.toContain('Alice')
  })

  it('writes role changes to the audit log', () => {
    cli('grant', 'alice')
    cli('revoke', 'alice')
    const a = cli('audit', '--limit', '5')
    expect(a.code).toBe(0)
    const lines = a.out.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/Alice\s+ok\s+cli\.grant Alice gm -> role player -> gm/)
    expect(lines[1]).toMatch(/cli\.revoke Alice player -> role gm -> player/)
  })

  it('rejects bad input', () => {
    expect(cli('grant', 'nobody').code).toBe(1)
    expect(cli('grant', 'alice', '--role', 'god').code).toBe(2)
    expect(cli('grant', 'alice', '--role', 'player').code).toBe(2)
    expect(cli('revoke', 'alice', '--role', 'gm').code).toBe(2)
    expect(cli('grant').code).toBe(2)
    expect(cli('grant', 'alice', 'extra').code).toBe(2)
    expect(cli('fly').code).toBe(2)
    expect(cli().code).toBe(2)
    expect(cli('grant', 'alice', '--color', 'red').code).toBe(2)
    expect(cli('audit', '--limit', '0').code).toBe(2)
    expect(cli('--help')).toMatchObject({ code: 0 })
    expect(role('alice')).toBe('player')
  })

  it('refuses to create a database that does not exist', () => {
    const missing = join(dir, 'nope')
    const err: string[] = []
    expect(runCli(['list'], { DATA_DIR: missing }, () => undefined, (l) => err.push(l))).toBe(1)
    expect(err.join('\n')).toContain('Start the server once')
  })

  it('works while another connection (the server) holds the database open', () => {
    const server = openStore(dir)
    try {
      const before = server.dataVersion()
      expect(cli('grant', 'bob').code).toBe(0)
      expect(server.dataVersion()).not.toBe(before)
      expect(server.accountRole(server.accountByName('bob')!.id)).toBe('gm')
    } finally {
      server.close()
    }
  })
})

describe('migration v2', () => {
  it('adds accounts.role (checked) and gm_audit to a v1 database', () => {
    const file = join(dir, 'game.db')
    rmSync(file)
    // a v1 database as the previous server wrote it
    const v1 = new Database(file)
    v1.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_login INTEGER);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE characters (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL, weapon TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, exp INTEGER NOT NULL DEFAULT 0, x REAL, y REAL, z REAL, yaw REAL NOT NULL DEFAULT 0, world TEXT NOT NULL, created_at INTEGER NOT NULL, last_played INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
      INSERT INTO accounts (username, password_hash, created_at) VALUES ('old', 'x', 1);
      PRAGMA user_version = 1;`)
    v1.close()
    const store = openStore(dir)
    try {
      // v1 -> latest (v3 adds character stats and items on top of v2)
      expect(store.schemaVersion).toBe(14)
      expect(store.accountByName('old')!.role).toBe('player')
      expect(() => store.db.prepare("UPDATE accounts SET role = 'god'").run()).toThrow(/CHECK/)
      const cols = (store.db.prepare('PRAGMA table_info(gm_audit)').all() as { name: string }[]).map((c) => c.name)
      expect(cols).toEqual(['id', 'at', 'account_id', 'character_id', 'command', 'args', 'result', 'ok'])
    } finally {
      store.close()
    }
  })
})
