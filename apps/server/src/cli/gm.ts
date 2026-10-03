import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROLES, type Role } from '@sro/shared'
import { dataDirFrom } from '../config.ts'
import { openStore } from '../db.ts'

/**
 * GM role administration on DATA_DIR/game.db:  pnpm gm <grant|revoke|list|audit> ...
 * Safe while the server runs (SQLite WAL + busy_timeout). A running server notices the change within
 * about a second (it polls PRAGMA data_version) and applies it to a connected account at once:
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

/** Runs the CLI; returns the process exit code. */
export function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env, out: Out = console.log, err: Out = console.error): number {
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
        const account = store.accountByName(username!)
        if (!account) {
          err(`no account named ${username}`)
          return 1
        }
        if (account.role === role) {
          out(`${account.username} is already ${role}`)
          return 0
        }
        store.setRole(account.id, role)
        store.audit({ accountId: account.id, characterId: null, command: `cli.${command}`, args: [account.username, role], result: `role ${account.role} -> ${role}`, ok: true })
        out(`${account.username}: ${account.role} -> ${role} (a running server applies it within about a second)`)
        return 0
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
  process.exitCode = runCli(process.argv.slice(2))
}
