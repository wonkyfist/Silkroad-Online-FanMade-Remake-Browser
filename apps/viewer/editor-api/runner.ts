/**
 * The editor API's side of Publish (docs/WORLD_EDITOR.md §6; lane WE-A): one job at a time (prepare, keep, discard,
 * undo), each in its own process (./publish-cli.ts under tsx), so the converter never runs inside the editor's Vite
 * server and a long convert never blocks a request. The job writes its record (`publish-<n>/record.json`); this
 * reads it back for `GET publish`. Node only; it imports nothing from the converter.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLISH_FORMAT, type PublishRecord, type PublishState } from './protocol.ts'

export type PublishJob = 'prepare' | 'keep' | 'discard' | 'undo'

export interface PublishRunnerOptions {
  repoRoot: string
  workRoot: string
  world: string
  /** Starts a job's process (tests replace it). */
  spawnJob?: (args: string[], cwd: string) => ChildProcess
  /** Process liveness (tests). */
  alive?: (pid: number) => boolean
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
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

export class PublishBusyError extends Error {}

export class PublishRunner {
  private job: { job: PublishJob; n: number; since: string; child: ChildProcess } | null = null
  private readonly editorDir: string

  constructor(private readonly opts: PublishRunnerOptions) {
    this.editorDir = join(opts.workRoot, 'editor', opts.world)
  }

  /** The publish numbers, ascending. */
  numbers(): number[] {
    if (!existsSync(this.editorDir)) return []
    return readdirSync(this.editorDir).map(d => /^publish-(\d+)$/.exec(d)?.[1]).filter((s): s is string => !!s).map(Number).sort((a, b) => a - b)
  }

  record(n: number): PublishRecord | null {
    const r = readJson<PublishRecord>(join(this.editorDir, `publish-${n}`, 'record.json'))
    return r?.format === PUBLISH_FORMAT ? r : null
  }

  /** The newest record; while a prepare runs before its record exists, a placeholder. */
  current(): PublishRecord | null {
    const n = this.numbers().at(-1)
    const rec = n ? this.record(n) : null
    // The prepare's process writes its record a moment after `publish/start` answers (tsx starting, the first save):
    // until then the newest record is the previous publish, or none for publish 1. Answer the job's own publish, so
    // the page follows that one and never stays on "Starting" (V-12).
    const job = this.job
    if (job?.job === 'prepare' && (!rec || rec.n < job.n)) {
      return {
        format: PUBLISH_FORMAT, version: 1, n: job.n, world: this.opts.world, phase: 'preparing', startedAt: job.since,
        steps: [], sentence: 'Publishing: starting…', changes: [], journalId: 0,
      }
    }
    // A record still "preparing" whose process is gone (killed, out of memory; this API's own job or a CLI run): failed
    if (rec?.phase === 'preparing' && !(job && job.n === rec.n) && rec.pid && !(this.opts.alive ?? pidAlive)(rec.pid)) {
      return this.failDead(rec, 'its process is gone')
    }
    return rec
  }

  /**
   * The prepare's process ended with its record still "preparing" (it died before it could write its end: killed, out
   * of memory): the record becomes failed, so the page stops following it and Deploy no longer counts it as open.
   */
  private failDead(rec: PublishRecord, why: string): PublishRecord {
    rec.phase = 'failed'
    rec.finishedAt = new Date().toISOString()
    rec.error = `The publish process stopped before it finished (${why}); see publish.log in work/editor/${this.opts.world}/.`
    rec.sentence = 'Publish could not finish. Nothing changed on the map.'
    for (const s of rec.steps) {
      if (s.status === 'run') s.status = 'fail'
      else if (s.status === 'wait') s.status = 'skip'
    }
    const file = join(this.editorDir, `publish-${rec.n}`, 'record.json')
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 1) + '\n')
      renameSync(`${file}.tmp`, file)
    } catch {
      // answered as failed anyway; the next read tries again
    }
    return rec
  }

  lastKept(): number | null {
    const idx = readJson<{ kept?: Array<{ n: number; undone?: string }> }>(join(this.editorDir, 'published.json'))
    return [...(idx?.kept ?? [])].reverse().find(k => !k.undone)?.n ?? null
  }

  get running(): boolean {
    return this.job !== null
  }

  state(): PublishState {
    let convertLock: string | null = null
    try {
      convertLock = readFileSync(join(this.opts.workRoot, 'out', '.convert.lock', 'owner'), 'utf8').trim() || '(starting)'
    } catch {
      convertLock = null
    }
    return {
      current: this.current(),
      lastKept: this.lastKept(),
      running: this.job ? { job: this.job.job, n: this.job.n, since: this.job.since } : null,
      convertLock,
    }
  }

  /** Starts a job; refuses while another runs. Resolves when the process has started (not when it ends). */
  start(job: PublishJob, n?: number): void {
    if (this.job) throw new PublishBusyError(`A ${this.job.job} is still running (publish ${this.job.n}); wait for it.`)
    const args = ['--import', 'tsx', 'apps/viewer/editor-api/publish-cli.ts', job, '--world', this.opts.world, ...(n !== undefined ? ['--n', String(n)] : [])]
    mkdirSync(this.editorDir, { recursive: true })
    const logFile = join(this.editorDir, 'publish.log')
    const since = new Date().toISOString()
    appendFileSync(logFile, `\n=== ${since} ${job} ${n ?? ''}\n`)
    // The job writes its log straight to the file (no pipe through this process): a Keep or an Undo the editor's
    // closing does not stop finishes its swap.
    const spawnJob = this.opts.spawnJob ?? ((a, cwd) => {
      const fd = openSync(logFile, 'a')
      try {
        return spawn(process.execPath, a, { cwd, stdio: ['ignore', fd, fd], windowsHide: true })
      } finally {
        closeSync(fd)
      }
    })
    const child = spawnJob(args, this.opts.repoRoot)
    const label = n ?? (this.numbers().at(-1) ?? 0) + 1
    this.job = { job, n: label, since, child }
    const write = (b: Buffer) => {
      try {
        appendFileSync(logFile, b)
      } catch {
        // the log is a convenience
      }
    }
    const done = (why?: string) => {
      if (this.job?.child !== child) return
      this.job = null
      // a prepare that died before it wrote its end (V-12: out of memory) leaves no "preparing" record behind
      const rec = job === 'prepare' ? this.record(label) : null
      if (rec?.phase === 'preparing') this.failDead(rec, why ?? 'it ended')
    }
    child.on('error', e => {
      write(Buffer.from(`\n${e.message}\n`))
      done(e.message)
    })
    child.on('close', (code: number | null, signal: string | null) => done(signal ? `stopped by ${signal}` : `exit code ${code}`))
  }

  /**
   * The editor closes: a prepare (staging only) is stopped, and the convert lock's stale rule frees its lock; a keep,
   * discard or undo is left to finish (stopping a swap half way would leave the live export half swapped).
   */
  stop(): void {
    if (this.job?.job === 'prepare') this.job.child.kill()
    this.job = null
  }
}
