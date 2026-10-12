import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads'
import { IntList, buildGrid, buildIndex, runSlice, type AoiLayout, type AoiParams } from './kernel.ts'

/**
 * The AoI job workers (docs/SERVER_ARCHITECTURE.md §3.5, phase P1b; AOI_JOBS=N, 0 = the pass stays on the tick thread).
 * World.interestPassJobs writes the pass's snapshot into shared memory (snapshot()), run() hands each worker a slice of
 * the viewers, computes the first slice itself and waits (Atomics.wait, bounded) for the rest: the pass ends in the same
 * tick with the same result, in about 1 / (N + 1) of the time. A worker that is late, busy or dead costs nothing but
 * speed: the tick thread computes its slice too (a "fallback"), and a dead worker is started again.
 */

const WORKER = new URL('./worker.ts', import.meta.url)
/** How long the tick thread waits for a worker's slice before computing it itself (ms). */
const WAIT_MS = 50

interface Slot {
  index: number
  worker: Worker | null
  port: MessagePort | null
  ready: boolean
  /** The last job generation handed to it (it is busy while its done mark is below this). */
  sent: number
  cpuMs: number
  ms: number
  jobs: number
  restarts: number
}

export interface AoiPoolStats {
  workers: number
  ready: number
  passes: number
  fallbacks: number
  restarts: number
  /** Per pass on the tick thread: building the snapshot, its own slice, waiting for the workers, applying (ms, mean). */
  snapshotMs: number
  ownMs: number
  waitMs: number
  applyMs: number
  /** The workers' CPU (thread time, ms) since start, and their mean slice time per job. */
  workerCpuMs: number
  workerSliceMs: number
}

export class AoiPool {
  private readonly slots: Slot[] = []
  private readonly ctl: SharedArrayBuffer
  private readonly done: Int32Array
  private gen = 0
  private I: Int32Array = new Int32Array(new SharedArrayBuffer(4 * 65536))
  private F: Float64Array = new Float64Array(new SharedArrayBuffer(8 * 16384))
  private closed = false
  private readonly own = new IntList(1 << 14)
  readonly stats = { passes: 0, fallbacks: 0, snapshotMs: 0, ownMs: 0, waitMs: 0, applyMs: 0 }

  constructor(
    readonly count: number,
    private readonly log: (line: string) => void,
  ) {
    this.ctl = new SharedArrayBuffer(4 * Math.max(1, count))
    this.done = new Int32Array(this.ctl)
    for (let i = 0; i < count; i++) {
      const s: Slot = { index: i, worker: null, port: null, ready: false, sent: 0, cpuMs: 0, ms: 0, jobs: 0, restarts: 0 }
      this.slots.push(s)
      this.spawn(s)
    }
  }

  private spawn(s: Slot): void {
    const { port1, port2 } = new MessageChannel()
    // no loader: the worker files are plain erasable TypeScript (Node's own type stripping), whatever the core runs with
    const w = new Worker(WORKER, { workerData: { slot: s.index, ctl: this.ctl, port: port2 }, transferList: [port2], execArgv: [] })
    s.worker = w
    s.port = port1
    s.ready = false
    Atomics.store(this.done, s.index, 0)
    s.sent = 0
    w.once('online', () => {
      if (s.worker === w) s.ready = true
    })
    w.on('error', (e) => this.log(`aoi worker ${s.index}: ${e.stack ?? e.message}`))
    w.once('exit', (code) => {
      if (s.worker !== w) return
      s.worker = null
      s.ready = false
      port1.close()
      s.port = null
      if (this.closed) return
      s.restarts++
      this.log(`aoi worker ${s.index}: exited (${code}); restarting`)
      setTimeout(() => {
        if (!this.closed && !s.worker) this.spawn(s)
      }, 1000).unref()
    })
    w.unref()
  }

  /** Shared arrays of at least these lengths for the next snapshot (grown, never shrunk). */
  arrays(iLen: number, fLen: number): { I: Int32Array; F: Float64Array } {
    if (this.I.length < iLen) this.I = new Int32Array(new SharedArrayBuffer(4 * Math.ceil(iLen * 1.5)))
    if (this.F.length < fLen) this.F = new Float64Array(new SharedArrayBuffer(8 * Math.ceil(fLen * 1.5)))
    return { I: this.I, F: this.F }
  }

  /**
   * One pass over the snapshot in arrays(): the viewers [0, P) in slices, the first on this thread. Returns the slices'
   * result lists in viewer order (aoi/kernel.ts runSlice records).
   */
  run(L: AoiLayout, p: AoiParams): Int32Array[] {
    const gen = ++this.gen
    const fallbacks0 = this.stats.fallbacks
    const free = this.slots.filter((s) => s.ready && s.worker && s.port && Atomics.load(this.done, s.index) >= s.sent)
    const parts = free.length + 1
    // the tick thread's own slice is a little smaller: it also builds the snapshot and applies the result
    const bounds: number[] = [0]
    const own = parts === 1 ? p.P : Math.floor(p.P / parts * 0.8)
    bounds.push(own)
    for (let k = 1; k < parts; k++) bounds.push(k === parts - 1 ? p.P : own + Math.floor(((p.P - own) * k) / (parts - 1)))
    const I = this.I
    const F = this.F
    for (let k = 1; k < parts; k++) {
      const s = free[k - 1]!
      s.sent = gen
      s.worker!.postMessage({ gen, I: I.buffer, F: F.buffer, L, p, from: bounds[k]!, to: bounds[k + 1]! })
    }
    const t0 = performance.now()
    const grid = buildGrid(F, L, p)
    const index = buildIndex(I, L, p)
    const out: Int32Array[] = new Array(parts)
    this.own.n = 0
    runSlice(I, F, L, p, grid, index, 0, bounds[1]!, this.own)
    out[0] = this.own.take()
    const t1 = performance.now()
    this.stats.ownMs += t1 - t0
    for (let k = 1; k < parts; k++) {
      const s = free[k - 1]!
      const deadline = performance.now() + WAIT_MS
      let got: Int32Array | null = null
      for (;;) {
        const mark = Atomics.load(this.done, s.index)
        if (mark >= gen) break
        const left = deadline - performance.now()
        if (left <= 0) break
        Atomics.wait(this.done, s.index, mark, left)
      }
      if (Atomics.load(this.done, s.index) >= gen && s.port) {
        // its result is on the port (posted before the mark); older ones (late jobs) are dropped
        for (;;) {
          const m = receiveMessageOnPort(s.port)
          if (!m) break
          const r = m.message as { gen: number; res: Int32Array | null; error: string | null; ms: number; cpuMs: number }
          s.cpuMs += r.cpuMs
          if (r.gen !== gen) continue
          s.ms += r.ms
          s.jobs++
          if (r.error) this.log(`aoi worker ${s.index}: ${r.error}`)
          got = r.res
        }
      }
      if (!got) {
        // late or failed: this thread does that slice (the worker's own answer, when it comes, is dropped)
        this.stats.fallbacks++
        const list = new IntList(1 << 12)
        runSlice(I, F, L, p, grid, index, bounds[k]!, bounds[k + 1]!, list)
        got = list.take()
      }
      out[k] = got
    }
    this.stats.waitMs += performance.now() - t1
    this.stats.passes++
    if (this.stats.fallbacks > fallbacks0) {
      // a late worker may still read this snapshot: the next one goes to fresh memory
      this.I = new Int32Array(new SharedArrayBuffer(this.I.byteLength))
      this.F = new Float64Array(new SharedArrayBuffer(this.F.byteLength))
    }
    return out
  }

  snapshot(): AoiPoolStats {
    const n = Math.max(1, this.stats.passes)
    const r = (v: number) => Math.round(v * 1000) / 1000
    const jobs = this.slots.reduce((a, s) => a + s.jobs, 0)
    return {
      workers: this.slots.length,
      ready: this.slots.filter((s) => s.ready).length,
      passes: this.stats.passes,
      fallbacks: this.stats.fallbacks,
      restarts: this.slots.reduce((a, s) => a + s.restarts, 0),
      snapshotMs: r(this.stats.snapshotMs / n),
      ownMs: r(this.stats.ownMs / n),
      waitMs: r(this.stats.waitMs / n),
      applyMs: r(this.stats.applyMs / n),
      workerCpuMs: Math.round(this.slots.reduce((a, s) => a + s.cpuMs, 0)),
      workerSliceMs: r(this.slots.reduce((a, s) => a + s.ms, 0) / Math.max(1, jobs)),
    }
  }

  /** Clears the per-pass means (the load test's measuring window). */
  reset(): void {
    for (const k of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[k] = 0
  }

  /** Whether any worker can take a slice now. */
  get ready(): boolean {
    return this.slots.some((s) => s.ready)
  }

  /** Test hook: ends worker `index` as a crash would. */
  crash(index: number): void {
    void this.slots[index]?.worker?.terminate()
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all(this.slots.map((s) => s.worker?.terminate()))
  }
}
