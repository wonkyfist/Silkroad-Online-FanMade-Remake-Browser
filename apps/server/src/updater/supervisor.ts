import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdatePhase } from '@sro/shared'
import { killTree, pnpmCommand, run, tail } from './exec.ts'
import { hasCommit, headCommit, inspectRepo, isAncestor, mergeFastForward, resetTo } from './git.ts'
import {
  RESTART_EXIT_CODE,
  SERVER_PHASES,
  acquireLock,
  finishRun,
  logLine,
  readState,
  releaseLock,
  setPhase,
  writeState,
  type UpdateStateFile,
} from './state.ts'

/**
 * The update supervisor (docs/UPDATES.md §4): `pnpm serve` runs the game server as a child and starts it again when it
 * exits with the restart code (75, the admin panel's Restart) or crashes (with a back-off). When the server hands over
 * an update (state phase 'handoff') it installs it while the server is down: git merge --ff-only to the checked
 * commit, pnpm install --frozen-lockfile, the game client and admin panel builds, then starts the new version and
 * waits for its health self-check. A failed step or a new version that does not come up healthy in time is rolled
 * back (the old commit, install and builds again, and the database backup only when the schema moved).
 *
 * The commands are fixed here, in the code that runs NOW (this process started before the update), never read from
 * the fetched commit. Node-only (no packages): it runs with plain `node`, so pnpm install can replace every package.
 */

export interface SupervisorOptions {
  root: string
  dataDir: string
  /** The game server (process.execPath --import tsx src/main.ts in apps/server). */
  server: { cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
  /** How to run pnpm with fixed arguments (tests: a stand-in). */
  pnpm?: (args: readonly string[]) => { cmd: string; args: string[]; shell: boolean }
  log?: (line: string) => void
  allowLocalOrigin?: boolean
  /** Waits after the 1st, 2nd, ... crash in a row. */
  backoffMs?: readonly number[]
  readSchema?: (dbPath: string) => Promise<number | null>
  /** Overrides the run's healthTimeoutS (tests). */
  healthTimeoutMs?: number
  healthPollMs?: number
  stepTimeoutMs?: number
}

export const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000, 60_000]
/** A server that ran this long before it crashed starts the back-off from the beginning. */
export const STABLE_MS = 60_000
/** On Ctrl+C or SIGTERM: the server has this long to save and exit before it is killed. */
export const STOP_GRACE_MS = 20_000

export type ExitDecision = 'stop' | 'restart' | 'apply' | 'rollback' | 'crash'

/**
 * What to do when the server exits. Stopping (Ctrl+C, SIGTERM): stop. A hand-over pending: install it (whatever the
 * code: the server was on its way out for it). The new version died before it was healthy: roll back. Exit 75: start
 * again. Exit 0: the server stopped on purpose (it got a signal of its own): stop. Anything else: a crash.
 */
export function exitDecision(code: number | null, phase: UpdatePhase | null, stopping: boolean): ExitDecision {
  if (stopping) return 'stop'
  if (phase === 'handoff') return 'apply'
  if (phase === 'starting') return 'rollback'
  if (code === RESTART_EXIT_CODE) return 'restart'
  if (code === 0) return 'stop'
  return 'crash'
}

/** The wait before the `crashes`-th restart in a row. */
export function crashDelay(crashes: number, backoff: readonly number[] = DEFAULT_BACKOFF_MS): number {
  return backoff[Math.min(Math.max(crashes, 1), backoff.length) - 1] ?? 0
}

/** PRAGMA user_version of a database file (node:sqlite; the file header as a fallback), or null. */
export async function readSchemaVersion(dbPath: string): Promise<number | null> {
  if (!existsSync(dbPath)) return null
  try {
    const spec = 'node:sqlite'
    const mod = (await import(spec)) as { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void } }
    const db = new mod.DatabaseSync(dbPath, { readOnly: true })
    try {
      const v = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      return Number.isInteger(v) ? v : null
    } finally {
      db.close()
    }
  } catch {
    // The header (bytes 60..63, big-endian) is only current when no write-ahead log is pending.
    if (existsSync(`${dbPath}-wal`)) return null
    try {
      const fd = openSync(dbPath, 'r')
      try {
        const b = Buffer.alloc(4)
        return readSync(fd, b, 0, 4, 60) === 4 ? b.readUInt32BE(0) : null
      } finally {
        closeSync(fd)
      }
    } catch {
      return null
    }
  }
}

class StepError extends Error {}

const short = (sha: string) => sha.slice(0, 7)

export class Supervisor {
  readonly opts: SupervisorOptions
  private stopping = false
  private child: ChildProcess | null = null
  private wake: (() => void) | null = null

  constructor(opts: SupervisorOptions) {
    this.opts = opts
  }

  private log(line: string): void {
    ;(this.opts.log ?? ((l: string) => console.log(`[supervisor] ${l}`)))(line)
  }

  /** Ctrl+C / SIGTERM: no more restarts; the server saves and exits (killed after STOP_GRACE_MS). */
  stop(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.stopping) return
    this.stopping = true
    this.log(`${signal}: stopping the server`)
    this.wake?.()
    const child = this.child
    if (!child || child.exitCode !== null) return
    // Windows delivers Ctrl+C to the whole console (the server got it too); elsewhere pass the signal on.
    if (process.platform !== 'win32') child.kill(signal)
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killTree(child.pid)
    }, STOP_GRACE_MS).unref()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms)
      function done() {
        clearTimeout(t)
        resolve()
      }
      this.wake = done
    })
  }

  private spawnServer(): { child: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
    const { cmd, args, cwd, env } = this.opts.server
    const child = spawn(cmd, args, { cwd, env: { ...(env ?? process.env), SRO_SUPERVISOR: '1' }, stdio: 'inherit', windowsHide: true })
    this.child = child
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('error', (e) => {
        this.log(`could not start the server: ${e.message}`)
        resolve({ code: null, signal: null })
      })
      child.on('exit', (code, signal) => resolve({ code, signal }))
    })
    return { child, exited }
  }

  /** Runs until stopped; returns the supervisor's exit code. */
  async run(): Promise<number> {
    const { dataDir } = this.opts
    mkdirSync(dataDir, { recursive: true })
    const lock = acquireLock(dataDir)
    if (!lock.ok) {
      this.log(`another supervisor (pid ${lock.pid}) already runs this server (${dataDir})`)
      return 1
    }
    try {
      await this.resume()
      let crashes = 0
      while (!this.stopping) {
        const st = readState(dataDir)
        const started = Date.now()
        const { child, exited } = this.spawnServer()
        if (st?.phase === 'starting') {
          const r = await this.waitHealthy(st, exited)
          if (r !== 'healthy') {
            if (r === 'timeout') killTree(child.pid)
            const { code } = await exited
            this.child = null
            if (this.stopping) break
            await this.rollback(readState(dataDir) ?? st, r === 'timeout' ? `the new version did not report healthy within ${Math.round(this.healthTimeout(st) / 1000)} s` : `the new version stopped (exit ${code ?? 'signal'}) before it was healthy`)
            continue
          }
          const done = readState(dataDir)
          if (done?.id === st.id) {
            finishRun(dataDir, done, done.kind === 'update' ? 'updated' : 'rolled-back', '')
            this.log(`${done.kind === 'update' ? 'update' : 'rollback'} to ${short(done.to)} finished`)
          }
        }
        const { code, signal } = await exited
        this.child = null
        const now = readState(dataDir)
        const d = exitDecision(code, now?.phase ?? null, this.stopping)
        if (d === 'stop') break
        if (d === 'apply') {
          crashes = 0
          await this.apply(now!)
          continue
        }
        if (d === 'rollback') {
          await this.rollback(now!, `the new version stopped (exit ${code ?? signal}) before it was healthy`)
          continue
        }
        if (d === 'restart') {
          crashes = 0
          this.log('restart requested: starting the server again')
          continue
        }
        if (Date.now() - started > STABLE_MS) crashes = 0
        crashes++
        const wait = crashDelay(crashes, this.opts.backoffMs)
        this.log(`the server exited (${code ?? signal}); starting it again in ${Math.round(wait / 100) / 10} s`)
        await this.sleep(wait)
      }
      return 0
    } finally {
      releaseLock(dataDir)
    }
  }

  /** A run left by a stop or a reboot: carry it on (each step can run again). */
  async resume(): Promise<void> {
    const s = readState(this.opts.dataDir)
    if (!s || SERVER_PHASES.includes(s.phase) || s.phase === 'starting') return
    this.log(`resuming the ${s.kind} to ${short(s.to)} (it stopped at ${s.phase})`)
    logLine(s, `resumed by the supervisor (stopped at ${s.phase})`)
    writeState(this.opts.dataDir, s)
    if (s.phase === 'healthy') finishRun(this.opts.dataDir, s, s.kind === 'update' ? 'updated' : 'rolled-back', '')
    else if (s.phase === 'rolling-back') await this.rollback(s, s.reason || 'resumed after a stop')
    else await this.apply(s)
  }

  private healthTimeout(s: UpdateStateFile): number {
    return this.opts.healthTimeoutMs ?? s.healthTimeoutS * 1000
  }

  /** Waits for the new server's self-check (phase healthy), its exit, or the timeout. */
  private async waitHealthy(s: UpdateStateFile, exited: Promise<unknown>): Promise<'healthy' | 'exited' | 'timeout'> {
    let gone = false
    void exited.then(() => (gone = true))
    const until = Date.now() + this.healthTimeout(s)
    const poll = this.opts.healthPollMs ?? 500
    while (Date.now() < until) {
      const cur = readState(this.opts.dataDir)
      if (cur?.id === s.id && cur.phase === 'healthy') return 'healthy'
      if (gone || this.stopping) return 'exited'
      await new Promise((r) => setTimeout(r, poll))
    }
    return 'timeout'
  }

  /** One fixed pnpm command (install / build), its output's tail in the run's log. */
  private async pnpmStep(s: UpdateStateFile, label: string, args: readonly string[], timeoutMs: number): Promise<void> {
    const c = (this.opts.pnpm ?? ((a) => pnpmCommand(a)))(args)
    logLine(s, `${label}: pnpm ${args.join(' ')}`)
    writeState(this.opts.dataDir, s)
    this.log(`${label}: pnpm ${args.join(' ')}`)
    const r = await run(c.cmd, c.args, { cwd: this.opts.root, shell: c.shell, timeoutMs: this.opts.stepTimeoutMs ?? timeoutMs, env: { ...process.env, CI: 'true' } })
    if (r.code !== 0) {
      for (const l of tail(r)) logLine(s, `  ${l}`)
      writeState(this.opts.dataDir, s)
      throw new StepError(`${label} failed (${r.timedOut ? 'timed out' : `exit ${r.code}`})`)
    }
  }

  /** pnpm install and both builds, as the checked-out code's lockfile and sources say. */
  private async installAndBuild(s: UpdateStateFile, rollingBack: boolean): Promise<void> {
    const phase = (p: UpdatePhase, text: string) => (rollingBack ? (logLine(s, text), writeState(this.opts.dataDir, s)) : setPhase(this.opts.dataDir, s, p, text))
    phase('installing', 'installing packages')
    await this.pnpmStep(s, 'install', ['install', '--frozen-lockfile'], 20 * 60_000)
    phase('building', 'building the game client and the admin panel')
    await this.pnpmStep(s, 'game client build', ['--filter', '@sro/game', 'build'], 20 * 60_000)
    await this.pnpmStep(s, 'admin panel build', ['--filter', '@sro/admin', 'build'], 10 * 60_000)
  }

  /**
   * Installs a handed-over run: checks the clone again, moves HEAD (merge --ff-only for an update, reset for a
   * rollback), install, builds, then phase 'starting' (the main loop starts the server and waits for its self-check).
   * A problem before HEAD moved ends the run as failed (the old version starts again, unchanged); after: rollback.
   */
  async apply(s: UpdateStateFile): Promise<void> {
    const { root, dataDir } = this.opts
    const fail = (reason: string) => {
      finishRun(dataDir, s, 'failed', reason)
      this.log(`${s.kind} to ${short(s.to)} not installed: ${reason}`)
    }
    let moved = false
    try {
      const info = await inspectRepo(root, s.repoUrl, s.branch, this.opts.allowLocalOrigin)
      if (info.kind !== 'git' || !info.originOk) return fail(info.note)
      const head = await headCommit(root)
      if (head === s.from) {
        if (info.branch !== s.branch) return fail(info.note)
        if (info.dirty.length) {
          // A merge that stopped half-way leaves changed files: put the old commit back.
          if (s.phase === 'merging') return await this.rollback(s, 'the merge was interrupted')
          return fail(`local changes to tracked files: ${info.dirty.slice(0, 5).join(', ')}`)
        }
        if (!(await hasCommit(root, s.to))) return fail(`commit ${short(s.to)} is not in this clone`)
        if (s.kind === 'update' && !(await isAncestor(root, s.from, s.to))) return fail('not a fast-forward')
        if (s.kind === 'rollback' && !(await isAncestor(root, s.to, s.from))) return fail(`${short(s.to)} is not an ancestor of ${short(s.from)}`)
        setPhase(dataDir, s, 'merging', s.kind === 'update' ? `git merge --ff-only ${short(s.to)}` : `git reset --keep ${short(s.to)}`)
        moved = true
        if (s.kind === 'update') await mergeFastForward(root, s.to)
        else await resetTo(root, s.to, (l) => logLine(s, l))
      } else if (head !== s.to) return fail(`HEAD moved to ${short(head)} (expected ${short(s.from)} or ${short(s.to)})`)
      moved = true
      await this.installAndBuild(s, false)
      if (s.kind === 'rollback' && s.restore) this.restoreDatabase(s, s.restore)
      setPhase(dataDir, s, 'starting', `starting ${short(s.to)}; waiting up to ${Math.round(this.healthTimeout(s) / 1000)} s for its health self-check`)
    } catch (e) {
      if (this.stopping) {
        logLine(s, `stopped during ${s.phase}: it carries on at the next start`)
        writeState(dataDir, s)
        return
      }
      const reason = (e as Error).message
      if (!moved) return fail(reason)
      await this.rollback(s, reason)
    }
  }

  /**
   * Puts the version from before the run back: HEAD to `from`, install and builds again, and the run's database backup
   * when the schema moved (a migration ran: the old server would refuse the database). Ends the run as rolled-back
   * (an update) or failed (a rollback that could not be installed).
   */
  async rollback(s: UpdateStateFile, reason: string): Promise<void> {
    const { root, dataDir } = this.opts
    s.reason = reason
    setPhase(dataDir, s, 'rolling-back', `rolling back to ${short(s.from)}: ${reason}`)
    this.log(`rolling back to ${short(s.from)}: ${reason}`)
    try {
      const head = await headCommit(root).catch(() => null)
      if (head !== s.from) await resetTo(root, s.from, (l) => logLine(s, l))
      await this.installAndBuild(s, true)
      const db = join(dataDir, 'game.db')
      const schema = await (this.opts.readSchema ?? readSchemaVersion)(db)
      if (s.schemaBefore !== null && schema !== null && schema !== s.schemaBefore) {
        if (s.backup && existsSync(s.backup)) this.restoreDatabase(s, s.backup)
        else logLine(s, `the database schema moved (${s.schemaBefore} -> ${schema}) but there is no backup to restore`)
      }
      finishRun(dataDir, s, s.kind === 'update' ? 'rolled-back' : 'failed', reason)
    } catch (e) {
      if (this.stopping) {
        logLine(s, 'stopped during the rollback: it carries on at the next start')
        writeState(dataDir, s)
        return
      }
      finishRun(dataDir, s, 'failed', `${reason}; the rollback failed too: ${(e as Error).message} (see docs/UPDATES.md, "Fixing a failed update by hand")`)
      this.log(`the rollback failed: ${(e as Error).message}`)
    }
  }

  /** The server is stopped: the current database is kept aside (failed-<run>.db), the backup takes its place. */
  private restoreDatabase(s: UpdateStateFile, backup: string): void {
    const { dataDir } = this.opts
    const db = join(dataDir, 'game.db')
    const aside = join(dataDir, 'backups', `failed-${s.id}.db`)
    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    for (const ext of ['', '-wal']) if (existsSync(`${db}${ext}`)) copyFileSync(`${db}${ext}`, `${aside}${ext}`)
    for (const ext of ['-wal', '-shm']) rmSync(`${db}${ext}`, { force: true })
    copyFileSync(backup, db)
    logLine(s, `database restored from ${backup} (the replaced one is kept as ${aside})`)
    writeState(dataDir, s)
    this.log(`database restored from ${backup}`)
  }
}
