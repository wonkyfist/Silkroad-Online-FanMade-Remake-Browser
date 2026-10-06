import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdminUpdateRun, AdminUpdateState, UpdatePhase, UpdateResult } from '@sro/shared'

/**
 * The state of an update in progress and the history of past runs (docs/UPDATES.md §4), as JSON files in
 * DATA_DIR/updates/ so the server and the supervisor (two processes, one of them maybe restarted after a reboot) see the
 * same thing, and a database restore never rewinds them. Writes are atomic (a temp file renamed over the old one).
 * Node-only (type imports are erased): the supervisor runs this file with plain `node`.
 *
 * Phases, in order: countdown -> backup (the server; the backup comes last so it holds everything up to the restart)
 * -> handoff (the server saves and exits with the restart code) -> merging ->
 * installing -> building -> starting (the supervisor) -> healthy (the new server's self-check) -> done (history).
 * Any failure after merging -> rolling-back -> history 'rolled-back'.
 */

/**
 * Exit code of a restart the server asks for (EX_TEMPFAIL): the admin panel's Restart and the hand-over of an update.
 * systemd's Restart=on-failure and the supervisor (pnpm serve) both start the server again on it.
 */
export const RESTART_EXIT_CODE = 75

export interface UpdateStateFile extends AdminUpdateState {
  v: 1
  repoUrl: string
  branch: string
  /** PRAGMA user_version before the run (a rollback restores the backup only when it changed). */
  schemaBefore: number | null
  /** The database backup taken at the start of this run. */
  backup: string | null
  /** A rollback run: the backup to put back once the old code is in place (null: the schema did not change). */
  restore: string | null
  /** How long the new version has to report healthy. */
  healthTimeoutS: number
  reason: string
  updatedAt: number
}

export interface HistoryRun extends AdminUpdateRun {
  schemaBefore: number | null
}

/** Phases the server drives; a server that starts and finds one of these was interrupted before it changed anything. */
export const SERVER_PHASES: readonly UpdatePhase[] = ['backup', 'countdown']
/** Phases the supervisor drives (resumed when it starts again). */
export const SUPERVISOR_PHASES: readonly UpdatePhase[] = ['handoff', 'merging', 'installing', 'building', 'starting', 'healthy', 'rolling-back']

export const LOG_MAX = 400
export const HISTORY_MAX = 30
export const DEFAULT_HEALTH_TIMEOUT_S = 180

export const updatesDir = (dataDir: string): string => join(dataDir, 'updates')
const statePath = (dataDir: string) => join(updatesDir(dataDir), 'state.json')
const historyPath = (dataDir: string) => join(updatesDir(dataDir), 'history.json')
const lockPath = (dataDir: string) => join(updatesDir(dataDir), 'supervisor.lock')

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    // A torn or hand-edited file: kept aside, never fatal.
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      // leave it
    }
    return null
  }
}

/** Writes JSON atomically (Windows: the rename may meet a reader for a moment; retried). */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path)
      return
    } catch (e) {
      if (i >= 20) throw e
      const until = Date.now() + 25
      while (Date.now() < until) {
        // brief spin: a reader holds the file
      }
    }
  }
}

export function readState(dataDir: string): UpdateStateFile | null {
  const s = readJson<UpdateStateFile>(statePath(dataDir))
  return s && s.v === 1 && typeof s.phase === 'string' && typeof s.id === 'string' ? s : null
}

export function writeState(dataDir: string, s: UpdateStateFile, now = Date.now()): void {
  s.updatedAt = now
  writeJsonAtomic(statePath(dataDir), s)
}

export function clearState(dataDir: string): void {
  rmSync(statePath(dataDir), { force: true })
}

/** Adds a timestamped line to the run's log (the last LOG_MAX are kept). */
export function logLine(s: UpdateStateFile, text: string, now = Date.now()): void {
  s.log.push(`${new Date(now).toISOString().slice(0, 19).replace('T', ' ')} ${text}`)
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX)
}

/** Sets the phase, logs it and saves. */
export function setPhase(dataDir: string, s: UpdateStateFile, phase: UpdatePhase, text: string, now = Date.now()): void {
  s.phase = phase
  logLine(s, text, now)
  writeState(dataDir, s, now)
}

export function newRun(o: { kind: 'update' | 'rollback'; from: string; to: string; by: string; repoUrl: string; branch: string; schemaBefore: number | null; now: number; healthTimeoutS?: number }): UpdateStateFile {
  return {
    v: 1,
    id: `${new Date(o.now).toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${o.to.slice(0, 7)}`,
    kind: o.kind,
    phase: 'countdown',
    from: o.from,
    to: o.to,
    by: o.by,
    startedAt: o.now,
    countdownEndsAt: null,
    log: [],
    repoUrl: o.repoUrl,
    branch: o.branch,
    schemaBefore: o.schemaBefore,
    backup: null,
    restore: null,
    healthTimeoutS: o.healthTimeoutS ?? DEFAULT_HEALTH_TIMEOUT_S,
    reason: '',
    updatedAt: o.now,
  }
}

export function readHistory(dataDir: string): HistoryRun[] {
  const h = readJson<HistoryRun[]>(historyPath(dataDir))
  return Array.isArray(h) ? h : []
}

/** Ends the run: a history entry (newest first) and no state left. */
export function finishRun(dataDir: string, s: UpdateStateFile, result: UpdateResult, reason: string, now = Date.now()): HistoryRun {
  logLine(s, `${result}${reason ? `: ${reason}` : ''}`, now)
  const run: HistoryRun = {
    id: s.id, kind: s.kind, from: s.from, to: s.to, by: s.by, startedAt: s.startedAt, endedAt: now, result, reason,
    backup: s.backup, log: s.log.slice(-150), schemaBefore: s.schemaBefore,
  }
  writeJsonAtomic(historyPath(dataDir), [run, ...readHistory(dataDir)].slice(0, HISTORY_MAX))
  clearState(dataDir)
  return run
}

/**
 * The commit the automatic mode leaves alone: the target of the last run when it failed or was rolled back, or the
 * commit an admin rolled back from. A newer commit on GitHub (a fix) is installed as usual.
 */
export function skippedTarget(history: readonly HistoryRun[]): string | null {
  const last = history.find((r) => r.result !== 'cancelled')
  if (!last) return null
  if (last.kind === 'update' && (last.result === 'failed' || last.result === 'rolled-back')) return last.to
  if (last.kind === 'rollback' && last.result === 'rolled-back') return last.from
  return null
}

/** True when `pid` is a running process. */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** One supervisor per data folder: the lock holds its pid. A lock of a dead process is taken over. */
export function acquireLock(dataDir: string, pid = process.pid): { ok: true } | { ok: false; pid: number } {
  const p = lockPath(dataDir)
  const held = readJson<{ pid: number }>(p)
  if (held && held.pid !== pid && alive(held.pid)) return { ok: false, pid: held.pid }
  writeJsonAtomic(p, { pid, at: Date.now() })
  return { ok: true }
}

export function releaseLock(dataDir: string, pid = process.pid): void {
  const held = readJson<{ pid: number }>(lockPath(dataDir))
  if (held?.pid === pid) rmSync(lockPath(dataDir), { force: true })
}

/** The supervisor holding the lock is running (the server's "supervised" check also needs SRO_SUPERVISOR). */
export function supervisorRunning(dataDir: string): boolean {
  const held = readJson<{ pid: number }>(lockPath(dataDir))
  return !!held && alive(held.pid)
}
