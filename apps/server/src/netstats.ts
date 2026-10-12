import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { encodeStats } from './encode.ts'
import { PhaseTimers, type PhaseSnapshot } from './phases.ts'
import type { DbWriterStats } from './db/mirror.ts'
import type { EconomyStats } from './services/economy.ts'
import type { ServiceStats } from './services/host.ts'

/**
 * Network and tick metrics (docs/NETWORK_AUDIT.md §Measure): message counts and bytes by type in each direction, the
 * tick-time distribution, connections and disconnect reasons. Always collected (a few map increments per message);
 * read by GET /netstats, which the server answers only with NET_STATS=1 and only to loopback (the load test,
 * src/cli/netload.ts), and by the admin dashboard's performance tile (docs/SERVER_ARCHITECTURE.md §3.11, P0): the
 * per-phase tick timers (phases.ts), messages per second, the outbound backlog and the event-loop delay.
 */

/** Ticks kept for the percentiles (60 s at 20 Hz). */
const TICK_RING = 1200
/** Rate samples (one per second at most) kept; rates are taken over the last RATE_WINDOW of them. */
const RATE_RING = 64
const RATE_WINDOW = 10

export interface TypeCount {
  n: number
  bytes: number
}

/** Messages per second over the last ~10 s (encodes: JSON encodes made; with encode-once fewer than `outPerS`). */
export interface NetRates {
  inPerS: number
  outPerS: number
  outKBps: number
  encodesPerS: number
}

/** The outbound backlog: bytes written to the sockets but not yet sent (ws bufferedAmount), in total and the worst one. */
export interface NetQueue {
  sockets: number
  bufferedBytes: number
  maxBufferedBytes: number
}

/** One startup stage's memory (docs/SERVER_ARCHITECTURE.md F6: the split between content, navmesh and modules). */
export interface MemoryStage {
  stage: string
  rssMb: number
  heapMb: number
  /** Memory outside the JS heap: buffers and typed arrays (the navmesh's arrays live here). */
  externalMb: number
}

export interface NetStatsSnapshot {
  at: number
  uptimeS: number
  in: Record<string, TypeCount>
  out: Record<string, TypeCount>
  inTotal: TypeCount
  outTotal: TypeCount
  /** Server-side drops of outbound messages (backpressure). */
  dropped: Record<string, number>
  /** `max`: since start or the last reset; `windowMax`: over the ticks kept (TICK_RING). */
  tick: { n: number; p50: number; p95: number; p99: number; max: number; windowMax: number; budgetMs: number }
  connections: { opened: number; open: number }
  disconnects: Record<string, number>
  /** cpu*: the whole core process (every thread); mainThreadCpuMs: the tick thread alone (P1: the AoI workers are the rest). */
  process: { rssMb: number; heapMb: number; cpuUserMs: number; cpuSystemMs: number; mainThreadCpuMs?: number }
  /** P0: the per-phase split of the tick intervals in the window (absent: TICK_TIMERS=off). */
  phases?: PhaseSnapshot
  rates?: NetRates
  queue?: NetQueue
  /** Event-loop delay (perf_hooks.monitorEventLoopDelay) over the window, ms. */
  loop?: { p50Ms: number; p99Ms: number; maxMs: number }
  /** The P0 switches (TICK_TIMERS, MOB_GRID, WATCHERS, ENCODE_ONCE, AOI_FAST): which paths ran. */
  switches?: Record<string, boolean>
  /** The startup memory split (main.ts / game.ts stages). */
  memory?: MemoryStage[]
  /** P2 (game.ts `extra`): the DB writer (DB_WRITER), the services (SVC_BUS), the transfers. */
  db?: DbWriterStats | null
  services?: Record<string, ServiceStats>
  economy?: EconomyStats & { held: number; heldMessages: number }
}

export class NetStats {
  private readonly inT = new Map<string, TypeCount>()
  private readonly outT = new Map<string, TypeCount>()
  private readonly drops = new Map<string, number>()
  private readonly closes = new Map<string, number>()
  private readonly ticks = new Float64Array(TICK_RING)
  private tickN = 0
  private tickMax = 0
  opened = 0
  open = 0
  readonly started = Date.now()
  /** The per-phase tick timers (World.timers); disabled when TICK_TIMERS=off. */
  readonly phases: PhaseTimers
  /** Monotonic totals for the rates (never reset). */
  private inN = 0
  private outN = 0
  private outBytes = 0
  private readonly rateRing: { at: number; inN: number; outN: number; outBytes: number; encodes: number }[] = []
  private loopDelay: IntervalHistogram | null = null
  /** Set by game.ts: the sockets' outbound backlog right now. */
  probe: (() => NetQueue) | null = null
  /** Set by game.ts: the P0 switches in force. */
  switches: Record<string, boolean> | null = null
  /** Set at startup: the memory split. */
  memory: MemoryStage[] = []
  /** Set by game.ts: more sections of the snapshot (P1: `gateways`, `aoiJobs`). */
  extra: (() => Record<string, unknown>) | null = null

  constructor(
    readonly tickHz = 20,
    timers = true,
  ) {
    this.phases = new PhaseTimers(timers)
    if (timers) {
      this.loopDelay = monitorEventLoopDelay({ resolution: 10 })
      this.loopDelay.enable()
    }
  }

  private static add(m: Map<string, TypeCount>, t: string, bytes: number): void {
    const c = m.get(t)
    if (c) {
      c.n++
      c.bytes += bytes
    } else m.set(t, { n: 1, bytes })
  }

  recvd(t: string, bytes: number): void {
    NetStats.add(this.inT, t, bytes)
    this.inN++
  }

  sent(t: string, bytes: number): void {
    NetStats.add(this.outT, t, bytes)
    this.outN++
    this.outBytes += bytes
  }

  dropped(t: string): void {
    this.drops.set(t, (this.drops.get(t) ?? 0) + 1)
  }

  tick(ms: number, now = Date.now()): void {
    this.ticks[this.tickN % TICK_RING] = ms
    this.tickN++
    if (ms > this.tickMax) this.tickMax = ms
    const last = this.rateRing[this.rateRing.length - 1]
    if (!last || now - last.at >= 1000) {
      this.rateRing.push({ at: now, inN: this.inN, outN: this.outN, outBytes: this.outBytes, encodes: encodeStats.n })
      if (this.rateRing.length > RATE_RING) this.rateRing.shift()
    }
  }

  /** One disconnect; `reason` is short and low-cardinality ('client 1001', 'not reading', 'heartbeat timeout'). */
  closed(reason: string): void {
    this.closes.set(reason, (this.closes.get(reason) ?? 0) + 1)
  }

  /** Clears the counters (the load test's phases), keeping open connections. */
  reset(): void {
    this.inT.clear()
    this.outT.clear()
    this.drops.clear()
    this.closes.clear()
    this.tickN = 0
    this.tickMax = 0
    this.opened = 0
    this.phases.reset()
    this.loopDelay?.reset()
  }

  /** Messages per second over the last RATE_WINDOW samples (null before two samples exist). */
  rates(): NetRates | null {
    const r = this.rateRing
    if (r.length < 2) return null
    const b = r[r.length - 1]!
    const a = r[Math.max(0, r.length - 1 - RATE_WINDOW)]!
    const dt = (b.at - a.at) / 1000
    if (dt <= 0) return null
    const per = (x: number) => Math.round((x / dt) * 10) / 10
    return { inPerS: per(b.inN - a.inN), outPerS: per(b.outN - a.outN), outKBps: Math.round((b.outBytes - a.outBytes) / dt / 102.4) / 10, encodesPerS: per(b.encodes - a.encodes) }
  }

  /** Event-loop delay over the window (ms), null when the timers are off. */
  loop(): NetStatsSnapshot['loop'] | null {
    const h = this.loopDelay
    if (!h || h.count === 0) return null
    const ms = (ns: number) => Math.round(ns / 1e4) / 100
    return { p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) }
  }

  snapshot(now = Date.now()): NetStatsSnapshot {
    const sum = (m: Map<string, TypeCount>): TypeCount => {
      let n = 0
      let bytes = 0
      for (const c of m.values()) {
        n += c.n
        bytes += c.bytes
      }
      return { n, bytes }
    }
    const k = Math.min(this.tickN, TICK_RING)
    const sorted = Array.from(this.ticks.subarray(0, k)).sort((a, b) => a - b)
    const pct = (p: number) => (k ? Math.round(sorted[Math.min(k - 1, Math.floor(p * k))]! * 100) / 100 : 0)
    const mem = process.memoryUsage()
    const cpu = process.cpuUsage()
    const rates = this.rates()
    const loop = this.loop()
    return {
      at: now,
      uptimeS: Math.round((now - this.started) / 1000),
      in: Object.fromEntries(this.inT),
      out: Object.fromEntries(this.outT),
      inTotal: sum(this.inT),
      outTotal: sum(this.outT),
      dropped: Object.fromEntries(this.drops),
      tick: { n: this.tickN, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: Math.round(this.tickMax * 100) / 100, windowMax: k ? Math.round(sorted[k - 1]! * 100) / 100 : 0, budgetMs: 1000 / this.tickHz },
      connections: { opened: this.opened, open: this.open },
      disconnects: Object.fromEntries(this.closes),
      process: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000), ...threadCpu() },
      ...(this.phases.enabled ? { phases: this.phases.snapshot() } : {}),
      ...(rates ? { rates } : {}),
      ...(this.probe ? { queue: this.probe() } : {}),
      ...(loop ? { loop } : {}),
      ...(this.switches ? { switches: this.switches } : {}),
      ...(this.memory.length ? { memory: this.memory } : {}),
      ...(this.extra ? this.extra() : {}),
    }
  }

  /** Stops the event-loop delay monitor (server close). */
  close(): void {
    this.loopDelay?.disable()
  }
}

/** The calling thread's own CPU (process.threadCpuUsage, Node 23.9+), when there is such an API. */
function threadCpu(): { mainThreadCpuMs?: number } {
  const f = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage
  if (typeof f !== 'function') return {}
  const t = f.call(process)
  return { mainThreadCpuMs: Math.round((t.user + t.system) / 1000) }
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  return a === '::1' || a.startsWith('127.')
}

/** process.memoryUsage() as a MemoryStage. */
export function memoryStage(stage: string): MemoryStage {
  const m = process.memoryUsage()
  const mb = (b: number) => Math.round(b / 104857.6) / 10
  return { stage, rssMb: mb(m.rss), heapMb: mb(m.heapUsed), externalMb: mb(m.external) }
}
