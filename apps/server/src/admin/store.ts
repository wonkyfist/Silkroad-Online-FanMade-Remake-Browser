import { statSync } from 'node:fs'
import type { AdminAuditRow, AdminBan, AdminGmAuditRow, Role } from '@sro/shared'
import type { Store } from '../db.ts'

/**
 * The admin panel's tables on game.db (docs/ADMIN.md §5): sessions, the audit log, the saved settings and account bans.
 * They sit outside the numbered gameplay migrations of db.ts (wave 14 owns migration 11): new tables only, created
 * with IF NOT EXISTS, with their own append-only version in `admin_meta`. An older server ignores them.
 */
const ADMIN_MIGRATIONS: string[] = [
  // 1
  `
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS admin_sessions_account ON admin_sessions(account_id);
  CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    account_id INTEGER,               -- NULL for a failed login of an unknown name
    username TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,             -- e.g. account.ban, settings.put, item.put
    target TEXT NOT NULL DEFAULT '',  -- e.g. account:12, character:5, item:ITEM_CH_SWORD_01_A
    before TEXT,                      -- JSON or NULL
    after TEXT,                       -- JSON or NULL
    ok INTEGER NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit(at);
  CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,              -- JSON
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_bans (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    banned_at INTEGER NOT NULL,
    banned_by TEXT NOT NULL
  );
  `,
]

export const ADMIN_SCHEMA_VERSION = ADMIN_MIGRATIONS.length

/** Most characters of a JSON before/after kept in an audit row. */
const AUDIT_JSON_MAX = 8000

export interface AdminAuditEntry {
  accountId: number | null
  username: string
  ip?: string
  action: string
  target?: string
  before?: unknown
  after?: unknown
  ok: boolean
  detail?: string
}

export interface AdminSessionRow {
  token_hash: string
  account_id: number
  created_at: number
  expires_at: number
  last_seen: number
}

interface AuditDbRow {
  id: number
  at: number
  account_id: number | null
  username: string
  ip: string
  action: string
  target: string
  before: string | null
  after: string | null
  ok: 0 | 1
  detail: string
}

export interface AccountListRow {
  id: number
  username: string
  role: Role
  created_at: number
  last_login: number | null
  reason: string | null
  banned_at: number | null
  banned_by: string | null
  chars: number
}

export interface CharacterListRow {
  id: number
  name: string
  account_id: number
  username: string
  level: number
  model: string
  last_played: number
}

/** `LIKE` pattern for a substring search (the user's text with %, _ and \ escaped). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

function json(v: unknown): string | null {
  if (v === undefined) return null
  const s = JSON.stringify(v)
  return s.length > AUDIT_JSON_MAX ? JSON.stringify({ truncated: s.slice(0, AUDIT_JSON_MAX) }) : s
}

function parse(s: string | null): unknown {
  if (s === null) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

export type AdminStore = ReturnType<typeof openAdminStore>

export function openAdminStore(store: Store, dbFile?: string) {
  const db = store.db
  db.exec('CREATE TABLE IF NOT EXISTS admin_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)')
  const current = (db.prepare('SELECT version FROM admin_meta WHERE id = 1').get() as { version: number } | undefined)?.version ?? 0
  if (current > ADMIN_MIGRATIONS.length) throw new Error(`admin tables v${current} are newer than this server (v${ADMIN_MIGRATIONS.length})`)
  for (let v = current; v < ADMIN_MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(ADMIN_MIGRATIONS[v])
      db.prepare('INSERT INTO admin_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(v + 1)
    })()
  }

  const q = {
    insertSession: db.prepare<[string, number, number, number, number, string]>(
      'INSERT INTO admin_sessions (token_hash, account_id, created_at, expires_at, last_seen, ip) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    session: db.prepare<[string, number], AdminSessionRow>('SELECT token_hash, account_id, created_at, expires_at, last_seen FROM admin_sessions WHERE token_hash = ? AND expires_at > ?'),
    touchSession: db.prepare<[number, string]>('UPDATE admin_sessions SET last_seen = ? WHERE token_hash = ?'),
    deleteSession: db.prepare<[string]>('DELETE FROM admin_sessions WHERE token_hash = ?'),
    deleteSessionsOf: db.prepare<[number]>('DELETE FROM admin_sessions WHERE account_id = ?'),
    purgeSessions: db.prepare<[number, number]>('DELETE FROM admin_sessions WHERE expires_at <= ? OR last_seen <= ?'),
    trimSessions: db.prepare<[number, number, number]>(
      `DELETE FROM admin_sessions WHERE account_id = ? AND token_hash NOT IN (
         SELECT token_hash FROM admin_sessions WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ),
    insertAudit: db.prepare<[number, number | null, string, string, string, string, string | null, string | null, number, string]>(
      'INSERT INTO admin_audit (at, account_id, username, ip, action, target, before, after, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    settings: db.prepare<[], { key: string; value: string; updated_at: number; updated_by: string }>('SELECT key, value, updated_at, updated_by FROM admin_settings ORDER BY key'),
    setSetting: db.prepare<[string, string, number, string]>(
      'INSERT INTO admin_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    ),
    deleteSetting: db.prepare<[string]>('DELETE FROM admin_settings WHERE key = ?'),
    ban: db.prepare<[number], { reason: string; banned_at: number; banned_by: string }>('SELECT reason, banned_at, banned_by FROM account_bans WHERE account_id = ?'),
    setBan: db.prepare<[number, string, number, string]>(
      'INSERT INTO account_bans (account_id, reason, banned_at, banned_by) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at, banned_by = excluded.banned_by',
    ),
    unban: db.prepare<[number]>('DELETE FROM account_bans WHERE account_id = ?'),
    setPassword: db.prepare<[string, number]>('UPDATE accounts SET password_hash = ? WHERE id = ?'),
    deleteGameSessionsOf: db.prepare<[number]>('DELETE FROM sessions WHERE account_id = ?'),
    accountRow: db.prepare<[number], AccountListRow>(
      `SELECT a.id, a.username, a.role, a.created_at, a.last_login, b.reason, b.banned_at, b.banned_by,
         (SELECT COUNT(*) FROM characters c WHERE c.account_id = a.id AND c.deleted_at IS NULL) AS chars
       FROM accounts a LEFT JOIN account_bans b ON b.account_id = a.id WHERE a.id = ?`,
    ),
    clearPosition: db.prepare<[number]>('UPDATE characters SET x = NULL, y = NULL, z = NULL, nav_surface = NULL WHERE id = ?'),
    masteries: db.prepare<[number], { code: string; level: number }>('SELECT code, level FROM char_masteries WHERE character_id = ? ORDER BY code'),
    skills: db.prepare<[number], { grp: string; level: number }>('SELECT grp, level FROM char_skills WHERE character_id = ? ORDER BY grp'),
    gmAuditCount: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM gm_audit'),
    gmAudit: db.prepare<[number, number], { id: number; at: number; username: string; command: string; args: string; result: string; ok: 0 | 1 }>(
      'SELECT g.id, g.at, a.username, g.command, g.args, g.result, g.ok FROM gm_audit g JOIN accounts a ON a.id = g.account_id ORDER BY g.id DESC LIMIT ? OFFSET ?',
    ),
  }

  function toAudit(r: AuditDbRow): AdminAuditRow {
    return {
      id: r.id,
      at: r.at,
      accountId: r.account_id,
      account: r.username,
      ip: r.ip,
      action: r.action,
      target: r.target,
      before: parse(r.before),
      after: parse(r.after),
      ok: r.ok === 1,
      detail: r.detail,
    }
  }

  return {
    /** Runs `fn` in one SQLite transaction (a throw rolls it back). */
    tx<T>(fn: () => T): T {
      return db.transaction(fn)()
    },
    // ---- sessions ----
    createSession(tokenHash: string, accountId: number, expiresAt: number, ip: string, now = Date.now()): void {
      q.insertSession.run(tokenHash, accountId, now, expiresAt, now, ip.slice(0, 64))
    },
    session: (tokenHash: string, now = Date.now()) => q.session.get(tokenHash, now),
    touchSession: (tokenHash: string, now = Date.now()) => q.touchSession.run(now, tokenHash),
    deleteSession: (tokenHash: string) => q.deleteSession.run(tokenHash).changes > 0,
    deleteSessionsOf: (accountId: number) => q.deleteSessionsOf.run(accountId).changes,
    /** Drops expired sessions and those idle since before `now - idleMs`. */
    purgeSessions: (now: number, idleMs: number) => q.purgeSessions.run(now, now - idleMs).changes,
    trimSessions: (accountId: number, keep: number) => q.trimSessions.run(accountId, accountId, keep).changes,

    // ---- audit ----
    audit(e: AdminAuditEntry, now = Date.now()): void {
      q.insertAudit.run(now, e.accountId, e.username.slice(0, 64), (e.ip ?? '').slice(0, 64), e.action.slice(0, 64), (e.target ?? '').slice(0, 200), json(e.before), json(e.after), e.ok ? 1 : 0, (e.detail ?? '').slice(0, 1000))
    },
    auditPage(f: { q?: string; action?: string }, page: number, size: number): { total: number; rows: AdminAuditRow[] } {
      const where: string[] = []
      const args: (string | number)[] = []
      if (f.q) {
        where.push("(username LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')")
        const p = likePattern(f.q)
        args.push(p, p, p)
      }
      if (f.action) {
        where.push("action LIKE ? ESCAPE '\\'")
        args.push(`${f.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM admin_audit ${w}`).get(...args) as { n: number }).n
      const rows = db.prepare(`SELECT * FROM admin_audit ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, page * size) as AuditDbRow[]
      return { total, rows: rows.map(toAudit) }
    },
    gmAuditPage(page: number, size: number): { total: number; rows: AdminGmAuditRow[] } {
      const total = q.gmAuditCount.get()!.n
      const rows = q.gmAudit.all(size, page * size).map((r) => {
        let args: string[] = []
        try {
          const a = JSON.parse(r.args) as unknown
          if (Array.isArray(a)) args = a.map(String)
        } catch {
          // keep []
        }
        return { id: r.id, at: r.at, account: r.username, command: r.command, args, result: r.result, ok: r.ok === 1 }
      })
      return { total, rows }
    },

    // ---- settings ----
    settings(): Map<string, { value: unknown; at: number; by: string }> {
      const out = new Map<string, { value: unknown; at: number; by: string }>()
      for (const r of q.settings.all()) out.set(r.key, { value: parse(r.value), at: r.updated_at, by: r.updated_by })
      return out
    },
    setSetting: (key: string, value: unknown, by: string, now = Date.now()) => q.setSetting.run(key, JSON.stringify(value), now, by),
    deleteSetting: (key: string) => q.deleteSetting.run(key).changes > 0,

    // ---- accounts ----
    banOf(accountId: number): AdminBan | null {
      const r = q.ban.get(accountId)
      return r ? { reason: r.reason, at: r.banned_at, by: r.banned_by } : null
    },
    ban: (accountId: number, reason: string, by: string, now = Date.now()) => q.setBan.run(accountId, reason, now, by),
    unban: (accountId: number) => q.unban.run(accountId).changes > 0,
    setPassword: (accountId: number, hash: string) => q.setPassword.run(hash, accountId).changes > 0,
    deleteGameSessionsOf: (accountId: number) => q.deleteGameSessionsOf.run(accountId).changes,
    accountRow: (id: number) => q.accountRow.get(id),
    accountsPage(f: { q?: string; role?: Role; banned?: boolean }, page: number, size: number): { total: number; rows: AccountListRow[] } {
      const where: string[] = []
      const args: (string | number)[] = []
      if (f.q) {
        where.push("a.username LIKE ? ESCAPE '\\'")
        args.push(likePattern(f.q))
      }
      if (f.role) {
        where.push('a.role = ?')
        args.push(f.role)
      }
      if (f.banned !== undefined) where.push(f.banned ? 'b.account_id IS NOT NULL' : 'b.account_id IS NULL')
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const from = 'FROM accounts a LEFT JOIN account_bans b ON b.account_id = a.id'
      const total = (db.prepare(`SELECT COUNT(*) AS n ${from} ${w}`).get(...args) as { n: number }).n
      const rows = db
        .prepare(
          `SELECT a.id, a.username, a.role, a.created_at, a.last_login, b.reason, b.banned_at, b.banned_by,
             (SELECT COUNT(*) FROM characters c WHERE c.account_id = a.id AND c.deleted_at IS NULL) AS chars
           ${from} ${w} ORDER BY a.username COLLATE NOCASE LIMIT ? OFFSET ?`,
        )
        .all(...args, size, page * size) as AccountListRow[]
      return { total, rows }
    },

    // ---- characters ----
    charactersPage(f: { q?: string; ids?: number[] }, page: number, size: number): { total: number; rows: CharacterListRow[] } {
      const where = ['c.deleted_at IS NULL']
      const args: (string | number)[] = []
      if (f.q) {
        where.push("(c.name LIKE ? ESCAPE '\\' OR a.username LIKE ? ESCAPE '\\')")
        const p = likePattern(f.q)
        args.push(p, p)
      }
      if (f.ids) {
        if (f.ids.length === 0) return { total: 0, rows: [] }
        where.push(`c.id IN (${f.ids.map(() => '?').join(', ')})`)
        args.push(...f.ids)
      }
      const from = `FROM characters c JOIN accounts a ON a.id = c.account_id WHERE ${where.join(' AND ')}`
      const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args) as { n: number }).n
      const rows = db
        .prepare(`SELECT c.id, c.name, c.account_id, a.username, c.level, c.model, c.last_played ${from} ORDER BY c.name COLLATE NOCASE LIMIT ? OFFSET ?`)
        .all(...args, size, page * size) as CharacterListRow[]
      return { total, rows }
    },
    clearPosition: (characterId: number) => q.clearPosition.run(characterId).changes > 0,
    masteries: (characterId: number) => q.masteries.all(characterId),
    skills: (characterId: number) => q.skills.all(characterId).map((r) => ({ group: r.grp, level: r.level })),

    /** game.db plus its WAL, in bytes (0 when unknown). */
    dbBytes(): number {
      if (!dbFile) return 0
      let n = 0
      for (const f of [dbFile, `${dbFile}-wal`]) {
        try {
          n += statSync(f).size
        } catch {
          // missing WAL
        }
      }
      return n
    },
  }
}
