import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { PortTransport, type Envelope } from '../bus/transport.ts'
import type { Entry, Op, WriterAck, WriterBatch, WriterCrash, WriterDiverged, WriterInit } from './protocol.ts'

/**
 * The tick thread's side of the DB writer (docs/SERVER_ARCHITECTURE.md §3.8, phase P2; DB_WRITER=1).
 *
 * The game keeps the whole database in memory: at start the file is migrated, checkpointed and loaded into an
 * in-memory SQLite database (`mem`), and every module's statements run there — synchronous, as before, and without
 * any disk work on the tick thread. Every write that commits in memory is journaled: the statement, its parameters
 * and the rows it changed, grouped per outermost transaction (one `Entry`, sequence-numbered). At the end of each
 * event-loop turn the turn's entries go to the writer thread (db/writer.ts) over a MessagePort, which replays them on
 * the file in order with group commit. Because the same statements run in the same order on the same content, the
 * file follows the memory database exactly, a whole group at a time: after a crash it holds a prefix of the history —
 * every transfer whole or absent, nothing twice.
 *
 * Commit-then-ack: `afterCommit(cb)` runs cb once everything journaled so far is on disk (at once without a writer).
 * Barriers: `flushSync()` waits (Atomics) until the writer has committed everything (shutdown, tests, backups).
 * A writer thread that dies is started again and resynced from a snapshot of the memory database (nothing is lost;
 * the memory database is the authority while the process lives). Three deaths within a minute are fatal (`onFatal`).
 */

const WRITER = new URL('./writer.ts', import.meta.url)
/** After a fatal writer error: the next attempt (a new writer if needed, then a resync), ms. */
const RETRY_MS = 10_000
/** Latencies kept for the percentiles (journal → commit, ms). */
const LAT_RING = 2048

export interface DbWriterOptions {
  log?: (line: string) => void
  /** Statements per group (one BEGIN … COMMIT) at most. */
  maxGroupOps?: number
  /** Test hook: the writer dies inside a group (protocol.ts WriterCrash). Only for the first writer. */
  crash?: WriterCrash | null
  /** The writer cannot be kept alive (repeated deaths, a failed resync). Default: log. */
  onFatal?: (why: string) => void
}

export interface DbWriterStats {
  /** Entries journaled and not committed yet, their statements, and the oldest one's age (ms). */
  queued: number
  /** The most entries waiting at once, and the oldest age seen (ms), since the last stats reset. */
  maxQueued: number
  maxOldestMs: number
  queuedOps: number
  oldestMs: number
  seq: number
  committed: number
  entries: number
  ops: number
  groups: number
  /** Journal → commit latency (ms) over the last LAT_RING entries. */
  latencyP50Ms: number
  latencyP95Ms: number
  latencyMaxMs: number
  /** BEGIN … COMMIT time per group (ms) over the last groups. */
  commitP50Ms: number
  commitP95Ms: number
  /** Mean entries and statements per group. */
  groupEntries: number
  groupOps: number
  walMb: number
  memDbMb: number
  restarts: number
  /** Writer failures it could not repair at once (retried every RETRY_MS). */
  fatal: number
  resyncs: number
  divergences: number
  /** Commits by another program on the file (they never reach the memory database: use the gm inbox). */
  external: number
  up: boolean
  writerCpuMs: number
}

type Ctl = BigInt64Array

export class DbMirror {
  readonly mem: Database.Database
  readonly file: string
  private seq = 0
  private committed = 0
  /** The open transaction's statements (null outside one). */
  private cur: Op[] | null = null
  private depth = 0
  private outbox: Entry[] = []
  private outboxOps = 0
  /** Sent, not committed: [seq, journaled at, statements]. */
  private inflight: [number, number, number][] = []
  private inflightOps = 0
  private defs: [number, string][] = []
  private readonly sqlIds = new Map<string, number>()
  private readonly waiters: { seq: number; cb: () => void }[] = []
  private scheduled = false
  private worker: Worker | null = null
  private link: PortTransport | null = null
  private readonly ctlBuf = new SharedArrayBuffer(16)
  private readonly ctl: Ctl = new BigInt64Array(this.ctlBuf)
  private closing = false
  private deaths: number[] = []
  private readonly lat = new Float64Array(LAT_RING)
  private latN = 0
  private latMax = 0
  private readonly commitMs = new Float64Array(256)
  private commitN = 0
  private readonly totals = { entries: 0, ops: 0, groups: 0, restarts: 0, resyncs: 0, divergences: 0, external: 0, walBytes: 0, writerCpuMs: 0, fatal: 0 }
  private retry: ReturnType<typeof setTimeout> | null = null
  private isReady = false
  private readonly peak = { queued: 0, oldestMs: 0 }
  private readyWaiters: (() => void)[] = []
  private readonly opts: DbWriterOptions
  /** afterCommit callbacks registered inside a transaction: they wait for its entry. */
  private txWaiters: (() => void)[] = []
  /** CPU of the writers before the current one (ms). */
  private cpuBase = 0

  private constructor(mem: Database.Database, file: string, opts: DbWriterOptions) {
    this.mem = mem
    this.file = file
    this.opts = opts
    this.wrap()
    this.spawn(opts.crash ?? null)
  }

  /**
   * Loads the (migrated) file database into memory and starts the writer. `fileDb` is closed: from now on only the
   * writer thread opens the file for writing.
   */
  static open(fileDb: Database.Database, file: string, opts: DbWriterOptions = {}): DbMirror {
    fileDb.pragma('wal_checkpoint(TRUNCATE)')
    const buf = fileDb.serialize()
    fileDb.close()
    // bytes 18-19: file format versions (2 = WAL); an in-memory database cannot be in WAL mode
    buf[18] = 1
    buf[19] = 1
    const mem = new Database(buf)
    mem.pragma('foreign_keys = ON')
    return new DbMirror(mem, file, opts)
  }

  // ---- capture -------------------------------------------------------------------------------------------

  private sqlId(sql: string): number {
    let id = this.sqlIds.get(sql)
    if (id === undefined) {
      id = this.sqlIds.size + 1
      this.sqlIds.set(sql, id)
      this.defs.push([id, sql])
    }
    return id
  }

  private record(op: Op): void {
    if (this.cur) this.cur.push(op)
    else this.push([op])
  }

  private push(ops: Op[]): void {
    this.seq++
    this.outbox.push({ s: this.seq, t: Date.now(), ops })
    this.outboxOps += ops.length
    if (!this.scheduled) {
      this.scheduled = true
      setImmediate(() => this.flush())
    }
  }

  /** Wraps the memory database's prepare / exec / transaction so every committed write is journaled. */
  private wrap(): void {
    const mem = this.mem as unknown as Record<string, unknown>
    const prepare = this.mem.prepare.bind(this.mem)
    const exec = this.mem.exec.bind(this.mem)
    const transaction = this.mem.transaction.bind(this.mem)
    mem.prepare = (sql: string) => {
      const st = prepare(sql)
      if (!st.readonly) this.capture(st, sql)
      return st
    }
    mem.exec = (sql: string) => {
      const r = exec(sql)
      this.record([-1, sql, -1])
      return r
    }
    mem.transaction = (fn: (...a: unknown[]) => unknown) => {
      const t = transaction(fn) as unknown as Record<string, (...a: unknown[]) => unknown> & ((...a: unknown[]) => unknown)
      const self = this
      const wrapped = (v: (...a: unknown[]) => unknown) =>
        function (this: unknown, ...args: unknown[]) {
          return self.runTx(v, this, args)
        }
      const out = wrapped(t) as unknown as Record<string, unknown>
      for (const k of ['default', 'deferred', 'immediate', 'exclusive']) if (typeof t[k] === 'function') out[k] = wrapped(t[k]!)
      out.database = this.mem
      return out
    }
  }

  private capture(st: Database.Statement, sql: string): void {
    const id = this.sqlId(sql)
    const s = st as unknown as Record<string, (...a: unknown[]) => unknown>
    for (const m of ['run', 'get', 'all'] as const) {
      const orig = s[m]!
      s[m] = (...args: unknown[]) => {
        const r = orig.apply(st, args)
        const params = args.map((a) => (a && typeof a === 'object' && !ArrayBuffer.isView(a) ? { ...(a as object) } : a))
        this.record([id, params, m === 'run' ? (r as Database.RunResult).changes : -1])
        return r
      }
    }
    s.bind = () => {
      throw new Error('DB_WRITER: bound statements are not journaled; pass the parameters to run()')
    }
  }

  private runTx(v: (...a: unknown[]) => unknown, thisArg: unknown, args: unknown[]): unknown {
    if (this.depth === 0) this.cur = []
    const mark = this.cur!.length
    this.depth++
    try {
      return v.apply(thisArg, args)
    } catch (e) {
      // this level rolled back (a savepoint, or the whole transaction)
      this.cur!.length = mark
      throw e
    } finally {
      this.depth--
      if (this.depth === 0) {
        const ops = this.cur!
        this.cur = null
        if (ops.length) this.push(ops)
        if (this.txWaiters.length) {
          const ws = this.txWaiters
          this.txWaiters = []
          for (const cb of ws) this.afterCommit(cb)
        }
      }
    }
  }

  // ---- the writer ----------------------------------------------------------------------------------------

  private spawn(crash: WriterCrash | null): void {
    this.isReady = false
    const { port1, port2 } = new MessageChannel()
    const init: WriterInit = { file: this.file, port: port2, ctl: this.ctlBuf, maxGroupOps: this.opts.maxGroupOps ?? 500, crash }
    // no loader: the writer is plain erasable TypeScript (Node's own type stripping), whatever the core runs with
    const w = new Worker(WRITER, { workerData: init, transferList: [port2], execArgv: [] })
    const link = new PortTransport('zone:0', 'db', port1)
    link.on('ack', (e) => this.onAck(e.body as WriterAck))
    link.on('diverged', (e) => this.onDiverged(e.body as WriterDiverged))
    link.on('fatal', (e) => this.fatal(`writer: ${(e.body as { error: string }).error}`))
    link.on('ready', () => {
      if (this.worker !== w) return
      const r = this.readyWaiters
      this.readyWaiters = []
      this.isReady = true
      for (const f of r) f()
    })
    w.on('error', (e) => this.log(`db writer: ${(e as Error)?.stack ?? e}`))
    w.on('exit', (code) => {
      if (this.worker !== w) return
      this.worker = null
      this.link?.failPending('db writer exited')
      if (this.closing) return
      this.log(`db writer: exited (code ${code}); restarting and resyncing from memory`)
      const now = Date.now()
      this.deaths = this.deaths.filter((t) => now - t < 60_000)
      this.deaths.push(now)
      if (this.deaths.length >= 3) return this.fatal('the writer died 3 times within a minute')
      this.totals.restarts++
      this.cpuBase = this.totals.writerCpuMs
      this.spawn(null)
      this.resync()
    })
    w.unref()
    port1.unref()
    this.worker = w
    this.link = link
  }

  private log(line: string): void {
    ;(this.opts.log ?? console.error)(line)
  }

  private fatal(why: string): void {
    this.log(`db writer: FATAL ${why}`)
    this.totals.fatal++
    this.opts.onFatal?.(why)
    // the memory database still has everything: try again in a while (a full disk freed, a lock gone)
    if (this.closing || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.closing) return
      this.deaths = []
      if (!this.worker) this.spawn(null)
      this.resync()
    }, RETRY_MS)
    this.retry.unref()
  }

  /** Sends the turn's entries to the writer. */
  flush(): void {
    this.scheduled = false
    if (this.outbox.length === 0 || !this.link) return
    const batch: WriterBatch = { defs: this.defs, entries: this.outbox }
    for (const e of this.outbox) this.inflight.push([e.s, e.t, e.ops.length])
    this.inflightOps += this.outboxOps
    this.defs = []
    this.outbox = []
    this.outboxOps = 0
    this.link.send({ to: 'db', k: 'batch', body: batch })
    const q = this.inflight.length
    if (q > this.peak.queued) this.peak.queued = q
    const age = Date.now() - this.inflight[0]![1]
    if (age > this.peak.oldestMs) this.peak.oldestMs = age
  }

  /** Replaces the file's content by a snapshot of the memory database (after a writer death or a divergence). */
  private resync(): void {
    if (!this.link) return
    // the snapshot holds every entry so far: drop the queue (its statement texts still go along for later ones)
    const seq = this.seq
    const snap = this.mem.serialize()
    this.outbox = []
    this.outboxOps = 0
    this.inflight = []
    this.inflightOps = 0
    this.totals.resyncs++
    this.defs = []
    // every statement text again (a new writer starts without any)
    this.link.send({ to: 'db', k: 'batch', body: { defs: [...this.sqlIds].map(([sql, id]) => [id, sql] as [number, string]), entries: [] } satisfies WriterBatch })
    const bin = snap.buffer.slice(snap.byteOffset, snap.byteOffset + snap.byteLength) as ArrayBuffer
    this.link.send({ to: 'db', k: 'resync', body: { seq }, bin }, [bin])
  }

  private onAck(a: WriterAck): void {
    const now = Date.now()
    if (a.resynced) this.log(`db writer: resynced from memory at entry ${a.upTo} (${a.resyncMs?.toFixed(0)} ms)`)
    this.committed = Math.max(this.committed, a.upTo)
    this.totals.groups += a.resynced ? 0 : 1
    this.totals.entries += a.entries
    this.totals.ops += a.ops
    this.totals.external += a.external
    if (a.external) this.log(`db writer: ${a.external} commit(s) by another program on ${this.file}; the running server does not see them (gm CLI: it uses the inbox)`)
    if (a.walBytes >= 0) this.totals.walBytes = a.walBytes
    if (a.cpuMs !== undefined) this.totals.writerCpuMs = this.cpuBase + a.cpuMs
    if (!a.resynced) this.commitMs[this.commitN++ % this.commitMs.length] = a.commitMs
    let i = 0
    while (i < this.inflight.length && this.inflight[i]![0] <= a.upTo) {
      const [, t, n] = this.inflight[i]!
      const ms = now - t
      this.lat[this.latN++ % LAT_RING] = ms
      if (ms > this.latMax) this.latMax = ms
      this.inflightOps -= n
      i++
    }
    if (i) this.inflight.splice(0, i)
    this.release()
  }

  private onDiverged(d: WriterDiverged): void {
    this.totals.divergences++
    this.log(`db writer: divergence at entry ${d.seq} (${d.error}); resyncing the file from memory`)
    this.resync()
  }

  /** Runs the commit waiters whose entries are on disk. */
  private release(): void {
    while (this.waiters.length && this.waiters[0]!.seq <= this.committed) {
      const w = this.waiters.shift()!
      try {
        w.cb()
      } catch (e) {
        this.log(`db writer: commit callback failed: ${(e as Error)?.stack ?? e}`)
      }
    }
  }

  // ---- API -----------------------------------------------------------------------------------------------

  /** Resolves once the current writer thread runs (its first message). */
  whenReady(): Promise<void> {
    if (this.isReady) return Promise.resolve()
    // the writer and its port do not hold the process open (unref): this wait does
    const keep = setInterval(() => {}, 1000)
    return new Promise((r) =>
      this.readyWaiters.push(() => {
        clearInterval(keep)
        r()
      }),
    )
  }

  /** The last journaled entry. */
  get journaled(): number {
    return this.seq
  }

  /** The last entry on disk. */
  get durable(): number {
    return this.committed
  }

  /** Runs `cb` once every write journaled so far is committed to the file (at once when nothing is pending). */
  afterCommit(cb: () => void): void {
    if (this.cur !== null) {
      this.txWaiters.push(cb)
      return
    }
    if (this.committed >= this.seq) {
      cb()
      return
    }
    this.waiters.push({ seq: this.seq, cb })
  }

  /** Waits (blocking, Atomics) until the writer has committed everything journaled; false on a timeout. */
  flushSync(timeoutMs = 10_000): boolean {
    this.flush()
    const target = BigInt(this.seq)
    const end = performance.now() + timeoutMs
    for (;;) {
      const cur = Atomics.load(this.ctl, 0)
      if (cur >= target) break
      const left = end - performance.now()
      if (left <= 0 || !this.worker) break
      Atomics.wait(this.ctl, 0, cur, Math.min(left, 100))
    }
    // the acks are queued on the port: take them now (commit waiters, stats)
    const port = this.link?.port
    if (port) for (let m = receiveMessageOnPort(port); m; m = receiveMessageOnPort(port)) this.link!.receive(m.message as Envelope)
    return Atomics.load(this.ctl, 0) >= target
  }

  /** Commits everything, stops the writer and closes the memory database. */
  close(timeoutMs = 10_000): void {
    if (this.closing) return
    if (this.retry) clearTimeout(this.retry)
    const ok = this.flushSync(timeoutMs)
    this.closing = true
    if (!ok) this.log(`db writer: close: ${this.seq - Number(Atomics.load(this.ctl, 0))} entr(ies) not committed`)
    if (this.worker && this.link) {
      this.link.send({ to: 'db', k: 'close' })
      const end = performance.now() + 5000
      while (Atomics.load(this.ctl, 1) === 0n && performance.now() < end) Atomics.wait(this.ctl, 1, 0n, 100)
      this.link.close()
    }
    this.mem.close()
  }

  /** Kills the writer thread (tests: the restart and resync path). */
  killWriter(): Promise<number> | null {
    return this.worker?.terminate() ?? null
  }

  stats(): DbWriterStats {
    const now = Date.now()
    const oldest = this.inflight.length ? this.inflight[0]![1] : this.outbox.length ? this.outbox[0]!.t : now
    const k = Math.min(this.latN, LAT_RING)
    const s = Array.from(this.lat.subarray(0, k)).sort((a, b) => a - b)
    const pct = (a: number[], q: number) => (a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(q * a.length))]! * 100) / 100 : 0)
    const cn = Math.min(this.commitN, this.commitMs.length)
    const c = Array.from(this.commitMs.subarray(0, cn)).sort((a, b) => a - b)
    const t = this.totals
    let memBytes = 0
    try {
      const pages = this.mem.pragma('page_count', { simple: true }) as number
      const size = this.mem.pragma('page_size', { simple: true }) as number
      memBytes = pages * size
    } catch {
      memBytes = 0
    }
    return {
      queued: this.inflight.length + this.outbox.length,
      maxQueued: Math.max(this.peak.queued, this.inflight.length + this.outbox.length),
      maxOldestMs: Math.max(this.peak.oldestMs, now - oldest),
      queuedOps: this.inflightOps + this.outboxOps,
      oldestMs: now - oldest,
      seq: this.seq,
      committed: this.committed,
      entries: t.entries,
      ops: t.ops,
      groups: t.groups,
      latencyP50Ms: pct(s, 0.5),
      latencyP95Ms: pct(s, 0.95),
      latencyMaxMs: this.latMax,
      commitP50Ms: pct(c, 0.5),
      commitP95Ms: pct(c, 0.95),
      groupEntries: t.groups ? Math.round((t.entries / t.groups) * 10) / 10 : 0,
      groupOps: t.groups ? Math.round((t.ops / t.groups) * 10) / 10 : 0,
      walMb: Math.round(t.walBytes / 104857.6) / 10,
      memDbMb: Math.round(memBytes / 104857.6) / 10,
      restarts: t.restarts,
      fatal: t.fatal,
      resyncs: t.resyncs,
      divergences: t.divergences,
      external: t.external,
      up: this.worker !== null,
      writerCpuMs: t.writerCpuMs,
    }
  }

  /** Clears the latency windows (the load test's phases). */
  resetStats(): void {
    this.peak.queued = 0
    this.peak.oldestMs = 0
    this.latN = 0
    this.latMax = 0
    this.commitN = 0
  }
}
