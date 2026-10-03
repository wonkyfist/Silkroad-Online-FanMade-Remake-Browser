/**
 * One editor at a time (docs/WORLD_EDITOR.md §2.2, D4): two levels.
 * - The process lock `work/editor/editor.lock` ("pid=<pid> host=<host> port=<port> <ISO time>"): the API takes it when
 *   it starts and drops it when it stops. A second editor process (another port) finds it held by a live process and
 *   serves read-only; a lock left by a process that is gone on this host is stale and taken over.
 *   The owner line's time is refreshed while the editor runs (LOCK_REFRESH_MS): a lock whose time is older than
 *   LOCK_STALE_MS is stale even when its pid is alive again (Windows reuses pids, e.g. after a reboot; H-12 DL-8).
 *   A stale lock (a killed or crashed editor, DL-5) is taken over under an atomic takeover directory, with a message
 *   (the terminal, and the first tab once); a read-only editor keeps looking and takes over once the other is gone.
 * - The tab lease, in memory: the first tab to open the session writes; a second tab is read-only with a plain
 *   message until the first one stops sending heartbeats (LEASE_TTL_MS) or the user takes over (`force`). A claim that
 *   presents the live lease (a reload, or a duplicated tab that copied sessionStorage) gets a NEW id and the old one
 *   stops working, so two pages never write with one lease (H-12 DL-1). A late heartbeat of the holder renews the
 *   lease as long as nobody else claimed it meanwhile (a hidden tab's throttled timers, a sleeping PC; H-12 DL-2).
 */
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { LEASE_TTL_MS } from './protocol.ts'

export interface EditorLock {
  readonly file: string
  /** True when this process holds the lock (writes allowed). */
  readonly held: boolean
  /** The owner line of the lock: ours, or the other editor's. */
  readonly owner: string
  /** The stale owner line this process took over (a killed or crashed editor: DL-5), or null. */
  readonly tookOver: string | null
  release(): void
}

const readOwner = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** How often a running editor re-stamps its lock line's time. */
export const LOCK_REFRESH_MS = 30_000
/** A lock line whose time is older than this belongs to an editor that no longer runs (its pid may be reused). */
export const LOCK_STALE_MS = 5 * 60_000

const ownerTime = (owner: string): number => {
  const iso = /\s(\d{4}-\d\d-\d\dT[\d:.]+Z)\s*$/.exec(owner)?.[1]
  return iso ? Date.parse(iso) : NaN
}

/**
 * True when the owner line names a process on this host that no longer runs, or whose line was not refreshed for
 * LOCK_STALE_MS (the pid now belongs to another program).
 */
export function isStaleEditorOwner(owner: string | null, host = hostname(), alive: (pid: number) => boolean = pidAlive, now = Date.now()): boolean {
  if (!owner) return true
  const pid = Number(/\bpid=(\d+)\b/.exec(owner)?.[1])
  const h = /\bhost=(\S+)/.exec(owner)?.[1]
  if (!(Number.isInteger(pid) && pid > 0 && h === host)) return false
  if (!alive(pid)) return true
  const t = ownerTime(owner)
  return Number.isFinite(t) && now - t > LOCK_STALE_MS
}

const isOwnProcess = (owner: string | null) =>
  !!owner && Number(/\bpid=(\d+)\b/.exec(owner)?.[1]) === process.pid && /\bhost=(\S+)/.exec(owner)?.[1] === hostname()

/** A takeover in progress (its directory) older than this was left by a process that died half way: it is cleared. */
export const TAKEOVER_STALE_MS = 10_000

export interface TakeLockOptions {
  /**
   * A read-only editor (another one held the lock) looks again this often and takes the lock over once that editor
   * is gone (killed, crashed: its lock is stale); 0 never looks again. Default LOCK_REFRESH_MS.
   */
  watchMs?: number
  /** Called when a watching read-only editor took the lock over (it may write now). */
  onTakeOver?: (staleOwner: string) => void
  /** Where the takeover note goes (the editor's terminal). */
  log?: (line: string) => void
}

/** The plain sentence of a takeover (the terminal and the page's banner). */
export function takeOverSentence(staleOwner: string): string {
  const pid = /\bpid=(\d+)\b/.exec(staleOwner)?.[1]
  const t = ownerTime(staleOwner)
  const when = Number.isFinite(t) ? ` (last seen ${new Date(t).toLocaleString()})` : ''
  return `The last World Editor${pid ? ` (process ${pid})` : ''} did not close cleanly${when}; this one took over its lock. Everything it saved is here.`
}

/**
 * Takes `work/editor/editor.lock`, or reports the live owner (then `held` is false: serve read-only, and look again
 * every `watchMs`). A stale lock (a dead pid on this host, or a line not refreshed for LOCK_STALE_MS: a killed editor,
 * DL-5) is taken over under a takeover directory (`<file>.takeover`, made atomically), so two editors starting at
 * once never both remove it and both write; the stale owner line is kept in `tookOver` for the message.
 */
export function takeEditorLock(file: string, port: number, alive?: (pid: number) => boolean, opts: TakeLockOptions = {}): EditorLock {
  mkdirSync(dirname(file), { recursive: true })
  const stamp = () => `pid=${process.pid} host=${hostname()} port=${port} ${new Date().toISOString()}`
  const gate = `${file}.takeover`
  let owner = stamp()
  let held = false
  let tookOver: string | null = null
  let released = false
  let refresh: ReturnType<typeof setInterval> | null = null
  let watch: ReturnType<typeof setInterval> | null = null

  /** Removes the stale lock `seen` under the takeover directory; false when another process is taking it over. */
  const clearStale = (seen: string | null): boolean => {
    try {
      mkdirSync(gate)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let age = 0
      try {
        age = Date.now() - statSync(gate).mtimeMs
      } catch {
        return false
      }
      if (age < TAKEOVER_STALE_MS) return false
      // left by a process that died during its takeover
      rmSync(gate, { recursive: true, force: true })
      try {
        mkdirSync(gate)
      } catch {
        return false
      }
    }
    try {
      // under the gate: the lock must still be the very line found stale (another editor may have taken it meanwhile)
      if (readOwner(file) !== seen) return false
      rmSync(file, { force: true })
      return true
    } finally {
      rmSync(gate, { recursive: true, force: true })
    }
  }

  /** One try to own the file; true when this process holds it now. */
  const attempt = (): boolean => {
    for (let i = 0; i < 2; i++) {
      let fd: number
      try {
        fd = openSync(file, 'wx')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const seen = readOwner(file)
        if (i > 0) return false
        // this very process (Vite restarts its server in-process when the config changes): take it over quietly
        if (isOwnProcess(seen)) {
          rmSync(file, { force: true })
          continue
        }
        if (isStaleEditorOwner(seen, hostname(), alive)) {
          if (!clearStale(seen)) return false
          if (seen) tookOver = seen
          continue
        }
        return false
      }
      owner = stamp()
      writeSync(fd, owner + '\n')
      closeSync(fd)
      return true
    }
    return false
  }

  const startRefresh = () => {
    // keep the line's time fresh while this editor runs (a reused pid alone never keeps the lock: DL-8)
    refresh = setInterval(() => {
      if (released || readOwner(file) !== owner) return
      const next = stamp()
      try {
        writeFileSync(file, next + '\n')
        owner = next
      } catch {
        // a held file (indexer, antivirus): try again at the next refresh
      }
    }, LOCK_REFRESH_MS)
    refresh.unref?.()
  }

  const log = opts.log ?? (l => console.warn(l))
  held = attempt()
  if (held) {
    startRefresh()
    if (tookOver) log(`[editor] ${takeOverSentence(tookOver)} (${file})`)
  } else {
    const watchMs = opts.watchMs ?? LOCK_REFRESH_MS
    if (watchMs > 0) {
      watch = setInterval(() => {
        if (released || held) return
        let ok = false
        try {
          ok = attempt()
        } catch {
          ok = false
        }
        if (!ok) return
        held = true
        clearInterval(watch!)
        watch = null
        startRefresh()
        const stale = tookOver ?? '(unknown)'
        log(`[editor] ${takeOverSentence(stale)} (${file})`)
        opts.onTakeOver?.(stale)
      }, watchMs)
      watch.unref?.()
    }
  }

  return {
    file,
    get held() {
      return held && !released
    },
    get owner() {
      return held ? owner : readOwner(file) ?? '(unknown)'
    },
    get tookOver() {
      return tookOver
    },
    release: () => {
      if (released) return
      released = true
      if (refresh) clearInterval(refresh)
      if (watch) clearInterval(watch)
      if (held && readOwner(file) === owner) rmSync(file, { force: true })
    },
  }
}

export interface LeaseClaim {
  granted: boolean
  lease?: string
  /** When refused: how long the holder has held it (ms). */
  heldForMs?: number
}

/** The writer lease of the editor's tabs. */
export class LeaseManager {
  private current: { id: string; since: number; seen: number } | null = null
  private readonly ttl: number
  private readonly now: () => number

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttl = opts.ttlMs ?? LEASE_TTL_MS
    this.now = opts.now ?? Date.now
  }

  private live(): boolean {
    return this.current !== null && this.now() - this.current.seen <= this.ttl
  }

  /**
   * Claims the lease: granted to the page that presents the current lease (a reload, or a duplicate of the tab),
   * to anyone when it lapsed, and to `force` (take over). Every grant issues a NEW id: the page that held the old one
   * (the original of a duplicated tab) gets 409 at its next beat or save and goes read-only (DL-1).
   */
  claim(previous?: string, force = false): LeaseClaim {
    const t = this.now()
    const holder = !!this.current && previous === this.current.id
    if (!holder && this.live() && !force) return { granted: false, heldForMs: t - this.current!.since }
    const since = holder ? this.current!.since : t
    this.current = { id: randomBytes(18).toString('base64url'), since, seen: t }
    return { granted: true, lease: this.current.id }
  }

  /**
   * A heartbeat: true while `lease` is the current lease (and renews it), even after a gap longer than the TTL as
   * long as nobody else claimed it meanwhile (a hidden tab's throttled timers, a sleeping PC: DL-2).
   */
  beat(lease: string | undefined): boolean {
    if (!lease || !this.current || this.current.id !== lease) return false
    this.current.seen = this.now()
    return true
  }

  /** How long since the holder's last sign of life (ms); Infinity with no holder. */
  idleMs(): number {
    return this.current ? this.now() - this.current.seen : Infinity
  }

  /** True while some tab holds a live lease (an editor tab is open). */
  held(): boolean {
    return this.live()
  }

  /** True when `lease` may write now (also renews it). */
  check(lease: string | undefined): boolean {
    return this.beat(lease)
  }
}
