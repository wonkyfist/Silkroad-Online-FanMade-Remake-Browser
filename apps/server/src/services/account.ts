import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Role } from '@sro/shared'
import type { Store } from '../db.ts'

/**
 * The account service's role changes (docs/SERVER_ARCHITECTURE.md §3.6, P2). With DB_WRITER the running server keeps
 * the database in memory and is the only writer of DATA_DIR/game.db, so the gm CLI must not write the file behind its
 * back: while a server with the writer runs (DATA_DIR/game.db.writer names its pid), `pnpm gm grant|revoke` drops a
 * request into DATA_DIR/gm-inbox/ and the server applies it (within rolePollMs, about a second) through its own store —
 * journaled like every write — and answers in the same folder. Without such a server the CLI writes the file itself,
 * as before.
 */

export const WRITER_LOCK = 'game.db.writer'
export const GM_INBOX = 'gm-inbox'

export interface RoleChange {
  command: 'grant' | 'revoke'
  username: string
  role: Role
}

export interface RoleChangeResult {
  code: number
  out: string[]
  err: string[]
}

/** grant / revoke on `store` (the CLI's own path, and the server's for an inbox request). */
export function applyRoleChange(store: Store, c: RoleChange): RoleChangeResult {
  const account = store.accountByName(c.username)
  if (!account) return { code: 1, out: [], err: [`no account named ${c.username}`] }
  if (account.role === c.role) return { code: 0, out: [`${account.username} is already ${c.role}`], err: [] }
  store.setRole(account.id, c.role)
  store.audit({ accountId: account.id, characterId: null, command: `cli.${c.command}`, args: [account.username, c.role], result: `role ${account.role} -> ${c.role}`, ok: true })
  return { code: 0, out: [`${account.username}: ${account.role} -> ${c.role} (a running server applies it within about a second)`], err: [] }
}

/** Marks DATA_DIR as written by this process's DB writer (removed by the returned function). */
export function claimWriterLock(dataDir: string): () => void {
  const file = join(dataDir, WRITER_LOCK)
  writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }))
  return () => {
    try {
      const cur = JSON.parse(readFileSync(file, 'utf8')) as { pid: number }
      if (cur.pid === process.pid) rmSync(file, { force: true })
    } catch {
      /* gone already */
    }
  }
}

/** The pid of a live server whose DB writer owns DATA_DIR/game.db, or null. */
export function liveWriter(dataDir: string): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(join(dataDir, WRITER_LOCK), 'utf8')) as { pid: number }
    if (!Number.isInteger(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/** The CLI side: hands `c` to the running server and waits for its answer (null on a timeout). */
export async function sendToInbox(dataDir: string, c: RoleChange, timeoutMs = 10_000): Promise<RoleChangeResult | null> {
  const dir = join(dataDir, GM_INBOX)
  mkdirSync(dir, { recursive: true })
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  // written aside, then renamed: the server never reads half a request
  writeFileSync(join(dir, `${id}.tmp`), JSON.stringify(c))
  renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.req.json`))
  const res = join(dir, `${id}.res.json`)
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (existsSync(res)) {
      try {
        const r = JSON.parse(readFileSync(res, 'utf8')) as RoleChangeResult
        rmSync(res, { force: true })
        return r
      } catch {
        /* still being written */
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  rmSync(join(dir, `${id}.req.json`), { force: true })
  return null
}

/** The server side: applies every waiting request (rolePoll). Returns how many it applied. */
export function serveInbox(dataDir: string, store: Store, log: (line: string) => void): number {
  const dir = join(dataDir, GM_INBOX)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.req.json')).sort()
  } catch {
    return 0
  }
  let n = 0
  for (const name of names) {
    const id = name.slice(0, -'.req.json'.length)
    let r: RoleChangeResult
    try {
      const c = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RoleChange
      if ((c.command !== 'grant' && c.command !== 'revoke') || typeof c.username !== 'string' || !['player', 'gm', 'admin'].includes(c.role)) throw new Error('bad request')
      r = applyRoleChange(store, c)
      log(`gm inbox: ${c.command} ${c.username} ${c.role}: ${(r.out[0] ?? r.err[0]) || 'done'}`)
    } catch (e) {
      r = { code: 1, out: [], err: [`the server could not apply it: ${(e as Error).message}`] }
    }
    rmSync(join(dir, name), { force: true })
    writeFileSync(join(dir, `${id}.tmp-res`), JSON.stringify(r))
    renameSync(join(dir, `${id}.tmp-res`), join(dir, `${id}.res.json`))
    n++
  }
  return n
}
