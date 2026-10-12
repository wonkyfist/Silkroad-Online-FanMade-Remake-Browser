import { performance } from 'node:perf_hooks'

/**
 * Built-in per-phase tick timers (docs/SERVER_ARCHITECTURE.md §3.11, phase P0): always-on `performance.now()` counters
 * around each part of a server tick and the work between ticks, so every step is measured the same way without a
 * profiler. One sample per phase per tick interval (the tick itself plus the inbound and socket-flush work since the
 * previous tick); the last RING samples feed the averages and percentiles of GET /netstats and the admin dashboard.
 * About 30 clock reads per tick, plus two per inbound message and per socket flush: noise next to the work they time.
 *
 * Phases (exclusive, so they add up to the busy time):
 *   arrive   World.tick: moves that arrived (`stop` broadcasts)
 *   players  Gameplay.tick: every player's actions, module tickPlayer hooks, regen
 *   mobs     Gameplay.tick: the monster pass (wake check, AI, corpses, regen)
 *   items    ground items expiring
 *   spawner  nest respawns
 *   modules  the modules' tick hooks (per module in `modules`)
 *   interest the AoI pass (spawn/despawn), crowd picks excluded
 *   crowd    the crowd cap's picks (World.pickCrowd)
 *   inbound  client frames between ticks (parse, validate, budgets, the request itself)
 *   flush    the end-of-turn socket writes (uncork -> writev)
 *   save     the periodic character save
 *   gc       garbage collection pauses (perf_hooks 'gc' entries)
 */
export const PHASES = ['arrive', 'players', 'mobs', 'items', 'spawner', 'modules', 'interest', 'crowd', 'inbound', 'flush', 'save', 'gc'] as const
export type PhaseName = (typeof PHASES)[number]

/** Phase indexes for the hot paths: `timers.lap(PH.mobs, t0)`. */
export const PH = Object.freeze(Object.fromEntries(PHASES.map((p, i) => [p, i]))) as { readonly [K in PhaseName]: number }

/** Tick intervals kept (2 min at 10 Hz). */
const RING = 1200

export interface PhaseStat {
  /** Mean ms per tick interval. */
  avgMs: number
  p95Ms: number
  maxMs: number
}

export interface PhaseSnapshot {
  /** Tick intervals in the window. */
  intervals: number
  phases: Record<PhaseName, PhaseStat>
  /** Mean ms per tick interval of all phases together. */
  busyMs: number
  /** The modules' tick hooks, heaviest first: mean and worst ms per call. */
  modules: { name: string; avgMs: number; maxMs: number }[]
}

const round = (v: number) => Math.round(v * 1000) / 1000

export class PhaseTimers {
  /** A shared switched-off instance (World's default: tests and tools that never read them pay nothing). */
  static readonly off = new PhaseTimers(false)

  /** TICK_TIMERS=off: now() returns 0 and nothing is recorded. */
  enabled: boolean
  private readonly cur = new Float64Array(PHASES.length)
  private ring: Float32Array[] | null = null
  private n = 0
  private readonly mods = new Map<string, { ms: number; calls: number; max: number }>()

  constructor(enabled = true) {
    this.enabled = enabled
  }

  /** A start time for lap()/end() (0 when off). */
  now(): number {
    return this.enabled ? performance.now() : 0
  }

  /** Adds the time since `t0` to `phase` and returns the current time (the next phase's start). */
  lap(phase: number, t0: number): number {
    if (!this.enabled) return 0
    const t = performance.now()
    this.cur[phase]! += t - t0
    return t
  }

  /** Adds `ms` to `phase` (work timed elsewhere, e.g. a GC pause). */
  add(phase: number, ms: number): void {
    if (this.enabled) this.cur[phase]! += ms
  }

  /** One module tick hook call took `ms` (also counted in the `modules` phase). */
  module(name: string, ms: number): void {
    if (!this.enabled) return
    this.cur[PH.modules]! += ms
    const m = this.mods.get(name)
    if (!m) this.mods.set(name, { ms, calls: 1, max: ms })
    else {
      m.ms += ms
      m.calls++
      if (ms > m.max) m.max = ms
    }
  }

  /** Closes one tick interval (World.timedTick, after each tick): this interval's phase times become one sample. */
  interval(): void {
    if (!this.enabled) return
    const ring = (this.ring ??= PHASES.map(() => new Float32Array(RING)))
    const i = this.n % RING
    for (let k = 0; k < PHASES.length; k++) {
      ring[k]![i] = this.cur[k]!
      this.cur[k] = 0
    }
    this.n++
  }

  /** Clears the window (the load test's phases). */
  reset(): void {
    this.n = 0
    this.cur.fill(0)
    this.mods.clear()
  }

  snapshot(): PhaseSnapshot {
    const k = Math.min(this.n, RING)
    const phases = {} as Record<PhaseName, PhaseStat>
    let busy = 0
    for (let p = 0; p < PHASES.length; p++) {
      const a = this.ring && k > 0 ? Array.from(this.ring[p]!.subarray(0, k)).sort((x, y) => x - y) : []
      let sum = 0
      for (const v of a) sum += v
      const avg = k ? sum / k : 0
      busy += avg
      phases[PHASES[p]!] = { avgMs: round(avg), p95Ms: round(k ? a[Math.min(k - 1, Math.floor(0.95 * k))]! : 0), maxMs: round(k ? a[k - 1]! : 0) }
    }
    const modules = [...this.mods].map(([name, m]) => ({ name, avgMs: round(m.ms / Math.max(1, m.calls)), maxMs: round(m.max) })).sort((x, y) => y.avgMs - x.avgMs)
    return { intervals: k, phases, busyMs: round(busy), modules }
  }
}
