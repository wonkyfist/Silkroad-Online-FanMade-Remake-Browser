import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { hostTimeZone, parseNewsFile, sortNews, type AdminUpdateChangelogEntry, type AdminUpdateSettings, type AdminUpdatesView, type UpdateInstallKind } from '@sro/shared'
import {
  changedFiles,
  commitInfo,
  commitsBetween,
  countBetween,
  fetchBranch,
  headCommit,
  inspectRepo,
  isAncestor,
  listFiles,
  lsRemote,
  showFile,
  webUrlOf,
  type CommitInfo,
  type RepoInfo,
} from './git.ts'
import { countdownPlan, decide, nextCheckAt, spokenDuration } from './schedule.ts'
import { loadUpdateSettings, saveUpdateSettings, settingsProblems } from './settings.ts'
import {
  SERVER_PHASES,
  finishRun,
  logLine,
  newRun,
  readHistory,
  readState,
  setPhase,
  skippedTarget,
  writeState,
  type HistoryRun,
  type UpdateStateFile,
} from './state.ts'

/**
 * The server's half of self-updates (docs/UPDATES.md): checks the configured repository on a timer (git fetch, never a
 * checkout), shows what is new on the admin panel's Updates page, and starts an update: a named database backup, a
 * countdown for the players, then it saves and exits with the restart code so the supervisor (pnpm serve, a separate
 * process running the code that is installed NOW) merges, installs, builds and starts the new version. After that
 * start, `onStarted` runs the health self-check the supervisor waits for.
 */

export interface UpdaterDeps {
  /** The repository's top folder (REPO_ROOT). */
  root: string
  dataDir: string
  /** Started by the supervisor (SRO_SUPERVISOR=1): only then can an update be installed. */
  supervised: boolean
  log(line: string): void
  /** Connections (in the world or the lobby): nobody = no countdown. */
  online(): number
  broadcast(text: string): void
  backupDb(path: string): Promise<void>
  /** Saves every player in the world (before the backup). */
  saveAll?: () => void
  schemaVersion(): number
  /** Saves everything and exits with RESTART_EXIT_CODE. */
  requestExit(): void
  /** Why the updater is off for this server (AUTO_UPDATE=off), or null. */
  disabled?: string | null
  /** Tests: a local path as the repository (a bare repo in a temp folder). */
  allowLocalOrigin?: boolean
  now?: () => number
  countdownMs?: number
  minFreeBytes?: number
  serverTz?: string
  tickMs?: number
}

/** Free space needed before a fetch (converted assets are large) and before an install. */
export const MIN_FREE_BYTES = 2 * 1024 ** 3
/** Pre-update database backups kept in DATA_DIR/backups (older ones are deleted). */
export const BACKUPS_KEPT = 5
const BACKUP_RE = /^pre-(update|rollback)-.*\.db$/

const short = (sha: string) => sha.slice(0, 7)
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')

export class UpdateError extends Error {
  readonly problems: string[]
  constructor(message: string, problems: string[] = []) {
    super(message)
    this.problems = problems
  }
}

export class Updater {
  readonly deps: UpdaterDeps
  private settings: AdminUpdateSettings
  private repo: RepoInfo | null = null
  private repoAt = 0
  private latest: CommitInfo | null = null
  /** HEAD when the last check compared it (a pull by hand since then makes the numbers stale). */
  private checkedHead: string | null = null
  private behind = 0
  private ahead = 0
  private commits: CommitInfo[] = []
  private changelog: AdminUpdateChangelogEntry[] = []
  private lastCheck: { at: number; ok: boolean; error: string | null } | null = null
  private checking: Promise<void> | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  private ticker: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private readonly startedAt: number

  constructor(deps: UpdaterDeps) {
    this.deps = deps
    this.settings = loadUpdateSettings(deps.dataDir, deps.allowLocalOrigin)
    this.startedAt = this.now()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get serverTz(): string {
    return this.deps.serverTz ?? hostTimeZone()
  }

  /** The timer: checks and automatic installs (decide()). */
  start(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => void this.tick(), this.deps.tickMs ?? 30_000)
    this.ticker.unref?.()
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  async tick(): Promise<'none' | 'check' | 'install'> {
    if (this.ticking) return 'none'
    this.ticking = true
    try {
      await this.refreshRepo()
      const install = this.installKind()
      const what = decide({
        settings: this.settings, serverTz: this.serverTz, now: this.now(), install, busy: this.checking !== null || readState(this.deps.dataDir) !== null,
        lastCheckAt: this.lastCheck?.at ?? null, behind: this.behind, canUpdate: this.blockers().length === 0, supervised: this.deps.supervised,
        latest: this.latest?.commit ?? null, skipped: skippedTarget(readHistory(this.deps.dataDir)), uptimeMs: this.now() - this.startedAt,
      })
      if (what === 'check') await this.check()
      else if (what === 'install') await this.install('auto-update').catch((e) => this.deps.log(`updater: automatic install did not start: ${(e as Error).message}`))
      return what
    } finally {
      this.ticking = false
    }
  }

  // ---- what this install is ---------------------------------------------------------------------------------------

  async refreshRepo(force = false): Promise<RepoInfo> {
    if (!force && this.repo && this.now() - this.repoAt < 10_000) return this.repo
    this.repo = await inspectRepo(this.deps.root, this.settings.repoUrl, this.settings.branch, this.deps.allowLocalOrigin)
    this.repoAt = this.now()
    return this.repo
  }

  installKind(): UpdateInstallKind {
    if (this.deps.disabled) return 'disabled'
    const r = this.repo
    if (!r) return 'disabled'
    if (r.kind === 'git' && !r.originOk) return 'disabled'
    return r.kind
  }

  private freeBytes(): number | null {
    try {
      const s = statfsSync(this.deps.root)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      return null
    }
  }

  private diskProblem(): string | null {
    const free = this.freeBytes()
    const need = this.deps.minFreeBytes ?? MIN_FREE_BYTES
    return free !== null && free < need ? `Only ${(free / 1024 ** 3).toFixed(1)} GB free on the server's disk; an update needs at least ${(need / 1024 ** 3).toFixed(1)} GB.` : null
  }

  /** Why "Update now" would not start (empty: it would). */
  blockers(): string[] {
    const out: string[] = []
    const r = this.repo
    const kind = this.installKind()
    if (kind !== 'git' || !r) return [this.deps.disabled ?? r?.note ?? 'The updater has not looked at this install yet.']
    if (r.branch !== this.settings.branch) out.push(r.note)
    if (r.dirty.length) out.push(`Local changes to tracked files (${r.dirty.slice(0, 5).join(', ')}${r.dirty.length > 5 ? ', ...' : ''}): commit, stash or undo them first.`)
    if (!this.deps.supervised) out.push('The server is not running under the update supervisor: start it with pnpm serve (docs/UPDATES.md).')
    if (!this.latest) out.push('Check for updates first.')
    else {
      if (this.ahead > 0) out.push(`This clone has ${this.ahead} commit(s) that are not on ${this.settings.branch} of the repository: an update would not be a fast-forward.`)
      else if (this.behind === 0) out.push('Already up to date.')
      if (r.head && this.checkedHead && r.head.commit !== this.checkedHead) out.push('The checked-out commit changed since the last check: check again.')
    }
    const disk = this.diskProblem()
    if (disk) out.push(disk)
    if (readState(this.deps.dataDir)) out.push('An update is in progress.')
    return out
  }

  // ---- checking ---------------------------------------------------------------------------------------------------

  /** Looks for a newer commit (git fetch; ls-remote for a ZIP install). Never throws; the result is in lastCheck. */
  check(): Promise<void> {
    if (this.checking) return this.checking
    this.checking = (async () => {
      const at = this.now()
      try {
        await this.refreshRepo(true)
        const kind = this.installKind()
        const { root } = this.deps
        const { repoUrl, branch } = this.settings
        if (kind === 'zip') {
          const sha = await lsRemote(repoUrl, branch, root)
          this.latest = sha ? { commit: sha, date: 0, author: '', subject: '' } : null
        } else if (kind === 'git') {
          const disk = this.diskProblem()
          if (disk) throw new Error(disk)
          const head = this.repo!.head?.commit
          if (!head) throw new Error('HEAD is not a commit')
          const sha = await fetchBranch(root, branch)
          this.latest = await commitInfo(root, sha)
          this.checkedHead = head
          this.behind = await countBetween(root, head, sha)
          this.ahead = await countBetween(root, sha, head)
          this.commits = this.behind ? await commitsBetween(root, head, sha, 50) : []
          this.changelog = this.behind && this.ahead === 0 ? await this.changelogBetween(head, sha) : []
        } else return
        const was = this.lastCheck
        this.lastCheck = { at, ok: true, error: null }
        if (this.behind > 0 && (!was || !was.ok || was.error !== null)) this.deps.log(`updater: ${this.behind} new commit(s) on ${branch} (latest ${short(this.latest?.commit ?? '')})`)
      } catch (e) {
        this.lastCheck = { at, ok: false, error: (e as Error).message.slice(0, 500) }
        this.deps.log(`updater: check failed: ${(e as Error).message}`)
      } finally {
        this.checking = null
      }
    })()
    return this.checking
  }

  /** The "What's new" entries (content/changelog/*.md) added or changed from `from` to `to`, newest first. */
  async changelogBetween(from: string, to: string): Promise<AdminUpdateChangelogEntry[]> {
    const { root } = this.deps
    const files = (await changedFiles(root, from, to, 'content/changelog')).filter((f) => /^content\/changelog\/[^/]+\.md$/.test(f)).slice(0, 30)
    if (files.length === 0) return []
    const images = new Set(await listFiles(root, to, 'content/changelog/img'))
    const out: AdminUpdateChangelogEntry[] = []
    for (const f of files) {
      const r = parseNewsFile(await showFile(root, to, f).catch(() => ''), basename(f, '.md'), images)
      if ('entry' in r && !r.entry.draft) out.push({ id: r.entry.id, title: r.entry.title, date: r.entry.date, summary: r.entry.summary })
    }
    return sortNews(out)
  }

  // ---- settings -----------------------------------------------------------------------------------------------------

  getSettings(): AdminUpdateSettings {
    return { ...this.settings }
  }

  saveSettings(values: Record<string, unknown>): { problems: string[] } | { before: AdminUpdateSettings; after: AdminUpdateSettings } {
    const problems = settingsProblems(values, this.deps.allowLocalOrigin)
    if (problems.length) return { problems }
    const before = { ...this.settings }
    const after = { ...this.settings, ...values } as AdminUpdateSettings
    for (const k of ['windowStart', 'windowEnd', 'windowTz', 'repoUrl', 'branch'] as const) after[k] = after[k].trim()
    saveUpdateSettings(this.deps.dataDir, after)
    this.settings = after
    if (before.repoUrl !== after.repoUrl || before.branch !== after.branch) {
      // Another repository or branch: what was found before no longer applies.
      this.latest = null
      this.checkedHead = null
      this.behind = this.ahead = 0
      this.commits = []
      this.changelog = []
      this.lastCheck = null
      this.repo = null
    }
    return { before, after }
  }

  // ---- updating ---------------------------------------------------------------------------------------------------

  /**
   * Starts an update to the commit the last check found: backup, countdown, hand-over. Throws UpdateError with the
   * blockers when it cannot. `by` is the admin (or 'auto-update').
   */
  async install(by: string): Promise<UpdateStateFile> {
    await this.refreshRepo(true)
    const blockers = this.blockers()
    if (blockers.length) throw new UpdateError(`The update cannot start: ${blockers.join(' ')}`, blockers)
    const from = this.repo!.head!.commit
    const to = this.latest!.commit
    if (from === to || !(await isAncestor(this.deps.root, from, to))) throw new UpdateError('The update is not a fast-forward of the checked-out commit.')
    const s = newRun({ kind: 'update', from, to, by, repoUrl: this.settings.repoUrl, branch: this.settings.branch, schemaBefore: this.deps.schemaVersion(), now: this.now() })
    logLine(s, `update ${short(from)} -> ${short(to)} (${this.behind} commit(s)) started by ${by}`, this.now())
    this.deps.log(`updater: update ${short(from)} -> ${short(to)} started by ${by}`)
    await this.proceed(s, 'update')
    return s
  }

  /** The last successful update can be undone: back to the commit before it (and its backup if the schema moved). */
  rollbackInfo(): { run: HistoryRun; restore: string | null; problem: string | null } | null {
    const last = readHistory(this.deps.dataDir).find((r) => r.result !== 'cancelled')
    if (!last || last.kind !== 'update' || last.result !== 'updated') return null
    const head = this.repo?.head?.commit
    if (!head || head !== last.to) return null
    const schemaMoved = last.schemaBefore !== null && last.schemaBefore !== this.deps.schemaVersion()
    const restore = schemaMoved ? last.backup : null
    const problem = schemaMoved && (!last.backup || !existsSync(last.backup)) ? `The database changed with this update and its backup (${last.backup ?? 'none'}) is gone, so it cannot be rolled back here.` : null
    return { run: last, restore, problem }
  }

  async rollback(by: string): Promise<UpdateStateFile> {
    await this.refreshRepo(true)
    const info = this.rollbackInfo()
    if (!info) throw new UpdateError('There is no update to roll back (only the last update, while it is the running version).')
    if (info.problem) throw new UpdateError(info.problem)
    const problems: string[] = []
    if (!this.deps.supervised) problems.push('The server is not running under the update supervisor: start it with pnpm serve.')
    if (this.repo?.dirty.length) problems.push('Local changes to tracked files: commit, stash or undo them first.')
    if (readState(this.deps.dataDir)) problems.push('An update is in progress.')
    if (problems.length) throw new UpdateError(problems.join(' '), problems)
    const from = this.repo!.head!.commit
    if (!(await isAncestor(this.deps.root, info.run.from, from))) throw new UpdateError('The previous commit is not an ancestor of the running one.')
    const s = newRun({ kind: 'rollback', from, to: info.run.from, by, repoUrl: this.settings.repoUrl, branch: this.settings.branch, schemaBefore: this.deps.schemaVersion(), now: this.now() })
    s.restore = info.restore
    logLine(s, `rollback ${short(from)} -> ${short(s.to)} started by ${by}${s.restore ? ` (restores ${basename(s.restore)})` : ''}`, this.now())
    this.deps.log(`updater: rollback ${short(from)} -> ${short(s.to)} started by ${by}`)
    await this.proceed(s, 'rollback')
    return s
  }

  /** Backup, then the countdown; its end hands over to the supervisor. */
  /** The countdown (none with nobody online); its end makes the backup and hands over. */
  private async proceed(s: UpdateStateFile, label: 'update' | 'rollback'): Promise<void> {
    const { dataDir } = this.deps
    const online = this.deps.online()
    const plan = countdownPlan(online, this.deps.countdownMs)
    s.countdownEndsAt = this.now() + plan.endMs
    setPhase(dataDir, s, 'countdown', plan.endMs ? `countdown ${spokenDuration(plan.endMs)} (${online} online)` : 'nobody online: no countdown', this.now())
    for (const n of plan.notices) {
      const t = setTimeout(() => {
        if (readState(dataDir)?.id === s.id) this.deps.broadcast(n.text)
      }, n.atMs)
      this.timers.push(t)
    }
    if (plan.endMs === 0) return this.backupAndHandoff(s.id, label)
    const end = setTimeout(() => void this.backupAndHandoff(s.id, label), plan.endMs)
    this.timers.push(end)
  }

  /**
   * Everyone saved, a named backup of the database (DATA_DIR/backups/pre-<update|rollback>-<time>-<from>-to-<to>.db,
   * taken last so a restore loses at most the seconds before the restart), then the hand-over: save and exit with the
   * restart code. A failed backup cancels the run (nothing was changed).
   */
  private async backupAndHandoff(id: string, label: 'update' | 'rollback'): Promise<void> {
    const { dataDir } = this.deps
    let s = readState(dataDir)
    if (!s || s.id !== id || s.phase !== 'countdown') return
    setPhase(dataDir, s, 'backup', 'saving everyone and backing up the database', this.now())
    try {
      this.deps.saveAll?.()
      const dir = join(dataDir, 'backups')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `pre-${label}-${stamp(this.now())}-${short(s.from)}-to-${short(s.to)}.db`)
      await this.deps.backupDb(path)
      s = readState(dataDir)
      if (!s || s.id !== id) {
        rmSync(path, { force: true })
        return
      }
      s.backup = path
      logLine(s, `database backup: ${basename(path)}`, this.now())
      this.pruneBackups(dir, [path, s.restore])
    } catch (e) {
      const cur = readState(dataDir)
      if (cur?.id === id) finishRun(dataDir, cur, 'failed', `database backup failed: ${(e as Error).message}`, this.now())
      if (this.deps.online() > 0) this.deps.broadcast('The server update was called off. Play on!')
      this.deps.log(`updater: database backup failed, update called off: ${(e as Error).message}`)
      return
    }
    setPhase(dataDir, s, 'handoff', 'restarting into the supervisor', this.now())
    if (this.deps.online() > 0) this.deps.broadcast('The server is restarting for an update now. See you in a few minutes!')
    this.deps.log(`updater: handing over to the supervisor (${s.kind} ${short(s.from)} -> ${short(s.to)})`)
    this.deps.requestExit()
  }

  private pruneBackups(dir: string, keep: (string | null)[]): void {
    try {
      const files = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort().reverse()
      for (const f of files.slice(BACKUPS_KEPT)) if (!keep.some((k) => k && basename(k) === f)) rmSync(join(dir, f), { force: true })
    } catch {
      // never fatal
    }
  }

  /** Stops an update that has not handed over yet. */
  cancel(by: string): HistoryRun {
    const s = readState(this.deps.dataDir)
    if (!s) throw new UpdateError('No update is in progress.')
    if (!SERVER_PHASES.includes(s.phase)) throw new UpdateError('The update is already being installed; it can no longer be cancelled.')
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    const told = s.phase === 'countdown' && (s.countdownEndsAt ?? 0) > s.startedAt
    const run = finishRun(this.deps.dataDir, s, 'cancelled', `cancelled by ${by}`, this.now())
    if (told) this.deps.broadcast('The server update was cancelled. Play on!')
    this.deps.log(`updater: update cancelled by ${by}`)
    return run
  }

  // ---- after a start ------------------------------------------------------------------------------------------------

  /**
   * Called once the server listens. A run interrupted in the server's own phases (backup, countdown: nothing changed
   * yet) is closed as cancelled. A run waiting for this start (phase starting: the supervisor just installed it) gets
   * the health self-check; on success the phase becomes healthy and the supervisor finishes the run.
   */
  async onStarted(url: string, fetchJson: (u: string) => Promise<unknown> = defaultFetchJson): Promise<'none' | 'cancelled' | 'healthy' | 'unhealthy'> {
    await this.refreshRepo(true).catch(() => null)
    const { dataDir } = this.deps
    const s = readState(dataDir)
    if (!s) return 'none'
    if (SERVER_PHASES.includes(s.phase)) {
      finishRun(dataDir, s, 'cancelled', 'the server stopped before the update was handed over (nothing was changed)', this.now())
      return 'cancelled'
    }
    if (s.phase !== 'starting') {
      if (!this.deps.supervised) this.deps.log(`updater: an update is half-way (${s.phase}); start the server with pnpm serve to finish or roll it back`)
      return 'none'
    }
    let problem: string | null = null
    try {
      const head = await headCommit(this.deps.root)
      if (head !== s.to) problem = `HEAD is ${short(head)}, not ${short(s.to)}`
      else {
        const h = (await fetchJson(`${url}/health`)) as { ok?: unknown; schema?: unknown } | null
        if (!h || h.ok !== true) problem = '/health did not answer ok'
        else if (h.schema !== this.deps.schemaVersion()) problem = `/health reports schema ${String(h.schema)}, expected ${this.deps.schemaVersion()}`
      }
    } catch (e) {
      problem = (e as Error).message
    }
    if (problem) {
      logLine(s, `health self-check failed: ${problem}`, this.now())
      writeState(dataDir, s, this.now())
      this.deps.log(`updater: health self-check failed: ${problem}`)
      return 'unhealthy'
    }
    setPhase(dataDir, s, 'healthy', `the new version is up and healthy (schema ${this.deps.schemaVersion()})`, this.now())
    this.deps.log(`updater: ${s.kind} to ${short(s.to)} is up and healthy`)
    return 'healthy'
  }

  // ---- the page -----------------------------------------------------------------------------------------------------

  async view(): Promise<AdminUpdatesView> {
    await this.refreshRepo().catch(() => null)
    const r = this.repo
    const install = this.installKind()
    const history = readHistory(this.deps.dataDir)
    const state = readState(this.deps.dataDir)
    const rb = this.rollbackInfo()
    const warnings: string[] = []
    if (r?.kind === 'git' && process.platform === 'win32' && r.longPaths !== true) warnings.push('Windows: long paths are off for this clone. Run git config core.longpaths true once in the server folder, or an update with deep asset paths may fail.')
    if (install === 'git' && !this.deps.supervised) warnings.push('Not started with pnpm serve: checks work, but nothing can be installed or restarted from here.')
    if (state && !this.deps.supervised && !SERVER_PHASES.includes(state.phase)) warnings.push(`An update stopped half-way (${state.phase}). Start the server with pnpm serve to finish it or roll it back.`)
    const disk = install === 'git' ? this.diskProblem() : null
    if (disk) warnings.push(disk)
    const blockers = install === 'git' ? this.blockers() : []
    const stateLog = state?.log ?? []
    return {
      install,
      installNote: install === 'disabled' ? (this.deps.disabled ?? r?.note ?? 'The updater is off.') : (r?.note ?? ''),
      webUrl: webUrlOf(this.settings.repoUrl),
      supervised: this.deps.supervised,
      current: r?.head ? { commit: r.head.commit, date: r.head.date, subject: r.head.subject } : null,
      latest: this.latest ? { commit: this.latest.commit, date: this.latest.date, subject: this.latest.subject } : null,
      behind: this.behind,
      ahead: this.ahead,
      canUpdate: install === 'git' && blockers.length === 0,
      blockers,
      warnings,
      commits: this.commits,
      changelog: this.changelog,
      settings: this.getSettings(),
      serverTz: this.serverTz,
      checking: this.checking !== null,
      lastCheck: this.lastCheck,
      nextCheckAt: nextCheckAt({ settings: this.settings, install, lastCheckAt: this.lastCheck?.at ?? null }, this.startedAt),
      skipped: skippedTarget(history),
      state: state
        ? { id: state.id, kind: state.kind, phase: state.phase, from: state.from, to: state.to, by: state.by, startedAt: state.startedAt, countdownEndsAt: state.countdownEndsAt, log: stateLog }
        : null,
      history: history.map(({ schemaBefore: _s, ...h }) => h),
      rollback: rb && !rb.problem ? { to: rb.run.from, at: rb.run.endedAt, restoresDatabase: rb.restore !== null } : null,
    }
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}
