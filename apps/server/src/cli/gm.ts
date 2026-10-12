import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROLES, type Role } from '@sro/shared'
import { dataDirFrom } from '../config.ts'
import { openStore, type Store } from '../db.ts'
import { liveWriter, sendToInbox, type RoleChange, type RoleChangeResult } from '../services/account.ts'

/**
 * GM role administration on DATA_DIR/game.db:  pnpm gm <grant|revoke|list|audit> ...
 * Safe while the server runs. A server with the DB writer (DB_WRITER, docs/SERVER_ARCHITECTURE.md §3.8) owns the file:
 * grant/revoke then go through its inbox (services/account.ts) and it applies them itself; otherwise the CLI writes the
 * file (SQLite WAL + busy_timeout) and the server notices within about a second (it polls PRAGMA data_version). Either
 * way a connected account gets the change at once:
 * the client receives `role`; a revoked GM loses invisibility and speed. GM commands also re-read
 * the role on every call, so a revoke can never be outrun.
 */

export const USAGE = `Usage: pnpm gm <command> [options]

  grant <username> [--role gm|admin]   give an account GM rights (default role: gm)
  revoke <username>                    make an account a normal player again
  list                                 accounts with the gm or admin role
  audit [--limit N]                    the most recent GM commands (default 20)

The database is DATA_DIR/game.db (default: <repo>/work/server/game.db). The server may be running.`

type Out = (line: string) => void

function fmtTime(ms: number | null): string {
  return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : 'never'
}

/**
 * grant / revoke on `store`: the only role change there is (test/role-policy.test.ts). Run by this CLI on the file, or —
 * when a server with the DB writer owns the file — by that server for this CLI's inbox request (services/account.ts).
 */
export function applyRoleChange(store: Store, c: RoleChange): RoleChangeResult {
  const account = store.accountByName(c.username)
  if (!account) return { code: 1, out: [], err: [`no account named ${c.username}`] }
  if (account.role === c.role) return { code: 0, out: [`${account.username} is already ${c.role}`], err: [] }
  store.setRole(account.id, c.role)
  store.audit({ accountId: account.id, characterId: null, command: `cli.${c.command}`, args: [account.username, c.role], result: `role ${account.role} -> ${c.role}`, ok: true })
  return { code: 0, out: [`${account.username}: ${account.role} -> ${c.role} (a running server applies it within about a second)`], err: [] }
}

/** Runs the CLI; returns the process exit code (a promise when a running server's inbox takes the change). */
export function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env, out: Out = console.log, err: Out = console.error): number | Promise<number> {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '-h' || a === '--help') {
      out(USAGE)
      return 0
    }
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a)
    if (m) {
      const value = m[2] ?? argv[++i]
      if (value === undefined) {
        err(`--${m[1]} needs a value`)
        return 2
      }
      flags.set(m[1], value)
    } else positional.push(a)
  }
  for (const k of flags.keys()) {
    if (k !== 'role' && k !== 'limit') {
      err(`unknown option --${k}\n\n${USAGE}`)
      return 2
    }
  }
  const [command, username, ...extra] = positional
  if (!command) {
    err(USAGE)
    return 2
  }
  if (!['grant', 'revoke', 'list', 'audit'].includes(command)) {
    err(`unknown command ${command}\n\n${USAGE}`)
    return 2
  }
  const needsName = command === 'grant' || command === 'revoke'
  if (extra.length > 0 || needsName !== (username !== undefined)) {
    err(USAGE)
    return 2
  }
  if (flags.has('role') && command !== 'grant') {
    err(command === 'revoke' ? 'revoke takes no --role (it always sets the role back to player)' : '--role is only for grant')
    return 2
  }
  if (flags.has('limit') && command !== 'audit') {
    err('--limit is only for audit')
    return 2
  }
  const role = (command === 'revoke' ? 'player' : (flags.get('role') ?? 'gm')) as Role
  if (command === 'grant' && (role === 'player' || !ROLES.includes(role))) {
    err('--role must be gm or admin')
    return 2
  }
  const limit = Number(flags.get('limit') ?? 20)
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    err('--limit must be a whole number from 1 to 10000')
    return 2
  }

  const dataDir = dataDirFrom(env)
  if ((command === 'grant' || command === 'revoke') && liveWriter(dataDir) !== null) {
    // the running server owns the file (DB writer): it applies the change itself
    return sendToInbox(dataDir, { command, username: username!, role }).then((r) => {
      if (!r) {
        err(`the running server (pid ${liveWriter(dataDir)}) did not answer within 10 s; if no server runs, delete ${resolve(dataDir, 'game.db.writer')}`)
        return 1
      }
      for (const l of r.out) out(l)
      for (const l of r.err) err(l)
      return r.code
    })
  }
  let store: ReturnType<typeof openStore>
  try {
    store = openStore(dataDir, { mustExist: true })
  } catch (e) {
    err(`cannot open ${resolve(dataDir, 'game.db')}: ${(e as Error).message}\nStart the server once, or set DATA_DIR.`)
    return 1
  }
  try {
    switch (command) {
      case 'grant':
      case 'revoke': {
        const r = applyRoleChange(store, { command, username: username!, role })
        for (const l of r.out) out(l)
        for (const l of r.err) err(l)
        return r.code
      }
      case 'list': {
        const rows = store.staff()
        if (rows.length === 0) out('no gm or admin accounts')
        for (const r of rows) out(`${r.username.padEnd(16)} ${r.role.padEnd(6)} last login ${fmtTime(r.last_login)}`)
        return 0
      }
      case 'audit': {
        const rows = store.recentAudit(limit).reverse()
        if (rows.length === 0) out('no GM commands yet')
        for (const r of rows) {
          const args = (JSON.parse(r.args) as string[]).join(' ')
          out(`${fmtTime(r.at)} ${r.username.padEnd(16)} ${r.ok ? 'ok  ' : 'FAIL'} ${r.command}${args ? ` ${args}` : ''} -> ${r.result.split('\n')[0]}`)
        }
        return 0
      }
      default:
        err(`unknown command ${command}\n\n${USAGE}`)
        return 2
    }
  } finally {
    store.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void Promise.resolve(runCli(process.argv.slice(2))).then((code) => {
    process.exitCode = code
  })
}
