/**
 * The convert lock (wave 12, docs/WORLD_EDITOR.md F15, D52; docs/WAVE_PLAN8.md §4.4, D26): one writer of `work/out/`
 * at a time. A full convert (`pnpm sro convert-region`, `pnpm sro convert`), the incremental convert (WE-I's
 * tools/convert-region.ts) and the editor's Publish (WE-A) take `work/out/.convert.lock` first; Publish waits while a
 * lane's convert runs.
 *
 * The lock is a directory (mkdir is atomic) holding an `owner` file: "<label> pid=<pid> host=<host> <ISO time>". Only
 * its creator removes it (`release`). A lock whose owner process is gone on this host (a killed convert) is stale and
 * is taken over, with a log line; a live owner is waited for (`waitMs`), then the call fails naming the owner.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

export const CONVERT_LOCK_DIR = '.convert.lock'
const OWNER_FILE = 'owner'

/** `<workDir>/out/.convert.lock`. */
export const convertLockPath = (workDir: string): string => join(workDir, 'out', CONVERT_LOCK_DIR)

export interface ConvertLock {
  readonly dir: string
  readonly owner: string
  /** Removes the lock if this process still owns it (idempotent). */
  release(): void
}

export interface ConvertLockOptions {
  /** How long to wait for a live owner (default 0: fail at once). */
  waitMs?: number
  /** Poll interval while waiting (default 2 s). */
  pollMs?: number
  log?: (line: string) => void
}

const readOwner = (dir: string): string | null => {
  try {
    return readFileSync(join(dir, OWNER_FILE), 'utf8').trim()
  } catch {
    return null
  }
}

/** True when the owner line names a process on this host that no longer runs. */
export function isStaleOwner(owner: string | null, host = hostname(), alive: (pid: number) => boolean = pidAlive): boolean {
  if (!owner) return false
  const pid = Number(/\bpid=(\d+)\b/.exec(owner)?.[1])
  const h = /\bhost=(\S+)/.exec(owner)?.[1]
  return Number.isInteger(pid) && pid > 0 && h === host && !alive(pid)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** One attempt: the lock, or the current owner's line when another holds it. */
export function tryConvertLock(dir: string, label: string, log: (line: string) => void = () => {}): ConvertLock | { heldBy: string } {
  mkdirSync(dirname(dir), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const held = readOwner(dir)
      if (attempt === 0 && isStaleOwner(held)) {
        log(`convert lock: taking over a stale lock (${held})`)
        rmSync(dir, { recursive: true, force: true })
        continue
      }
      return { heldBy: held ?? '(no owner file yet)' }
    }
    const owner = `${label.replace(/\s+/g, '_')} pid=${process.pid} host=${hostname()} ${new Date().toISOString()}`
    writeFileSync(join(dir, OWNER_FILE), owner + '\n')
    let released = false
    return {
      dir,
      owner,
      release: () => {
        if (released) return
        released = true
        if (readOwner(dir) === owner) rmSync(dir, { recursive: true, force: true })
      },
    }
  }
  return { heldBy: readOwner(dir) ?? '(unknown)' }
}

/** Takes the lock, waiting up to `waitMs` for a live owner; throws naming the owner when it cannot. */
export async function acquireConvertLock(dir: string, label: string, opts: ConvertLockOptions = {}): Promise<ConvertLock> {
  const log = opts.log ?? (() => {})
  const until = Date.now() + (opts.waitMs ?? 0)
  const poll = opts.pollMs ?? 2000
  let said = ''
  for (;;) {
    const r = tryConvertLock(dir, label, log)
    if (!('heldBy' in r)) return r
    if (Date.now() >= until) throw new Error(`convert lock ${dir} is held by ${r.heldBy}; try again when it is done`)
    if (said !== r.heldBy) log(`convert lock: waiting for ${r.heldBy}`)
    said = r.heldBy
    await new Promise(res => setTimeout(res, Math.min(poll, Math.max(0, until - Date.now()))))
  }
}

/** Runs `fn` under the lock and releases it afterwards (also on an error). */
export async function withConvertLock<T>(dir: string, label: string, fn: () => Promise<T>, opts: ConvertLockOptions = {}): Promise<T> {
  const lock = await acquireConvertLock(dir, label, opts)
  try {
    return await fn()
  } finally {
    lock.release()
  }
}
