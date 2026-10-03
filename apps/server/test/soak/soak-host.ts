/**
 * The soak test's server process (apps/server/test/soak/soak.ts forks it; not a test file). It is src/main.ts with
 * instruments: the same loadConfig(process.env) + startServer, plus an IPC channel to the soak driver for
 *
 * - samples (`sample`): RSS, heap used (before and after a forced GC), event-loop lag, tick durations (mean / p99 /
 *   max since the last sample), entity counts, the size of every Map/Set held by the world, gameplay and its modules
 *   (a leak shows up as one that only grows), open handles by type (process.getActiveResourcesInfo()), DB file sizes;
 * - `positions`: every character in the world with its live position (the restart check);
 * - `shutdown`: the graceful shutdown of main.ts (save, close), then exit 0;
 * - reports: every log line (the driver classifies error-level ones), unhandled rejections, uncaught exceptions.
 *
 * Run it only through soak.ts (it needs process.send).
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { getHeapSpaceStatistics } from 'node:v8'
import { loadConfig } from '../../src/config.ts'
import { startServer } from '../../src/game.ts'

export type HostReport =
  | { t: 'ready'; port: number; url: string; pid: number }
  | { t: 'log'; line: string }
  | { t: 'fault'; kind: 'unhandledRejection' | 'uncaughtException'; message: string }
  | { t: 'sample'; sample: HostSample }
  | { t: 'positions'; players: { name: string; characterId: number; x: number; y: number; z: number; dead: boolean }[] }
  | { t: 'closed' }

export type HostCommand = { t: 'sample' } | { t: 'positions' } | { t: 'shutdown' }

export interface HostSample {
  at: number
  uptimeS: number
  rssMb: number
  heapUsedMb: number
  /** heapUsed right after a forced full GC (the leak signal: live objects only). */
  heapAfterGcMb: number
  /** V8 heap spaces after the GC (MB used): which one grows (old_space = live objects, code_space = JIT code). */
  spaces: Record<string, number>
  externalMb: number
  lagMeanMs: number
  lagP99Ms: number
  lagMaxMs: number
  ticks: number
  tickMeanMs: number
  tickP99Ms: number
  tickMaxMs: number
  /** Every tick duration since the last sample (the driver aggregates p99 over the whole run). */
  tickDurations: number[]
  entities: { players: number; mobs: number; items: number; npcs: number; sockets: number }
  /** Size of every Map/Set/array field of the world, gameplay and each gameplay module (leak hunting). */
  collections: Record<string, number>
  handles: Record<string, number>
  dbMb: number
  walMb: number
}

const send = (r: HostReport): void => {
  process.send?.(r)
}

process.on('unhandledRejection', (e) => send({ t: 'fault', kind: 'unhandledRejection', message: String((e as Error)?.stack ?? e) }))
process.on('uncaughtException', (e) => {
  send({ t: 'fault', kind: 'uncaughtException', message: String(e?.stack ?? e) })
  // Like an uninstrumented server: an uncaught exception ends the process (after the report is flushed).
  setTimeout(() => process.exit(70), 200)
})

const base = loadConfig(process.env)
const config = {
  ...base,
  log: (line: string) => {
    base.log(line)
    send({ t: 'log', line })
  },
}
const server = await startServer(config)
const { world, gameplay, sockets } = server.ctx

// Tick durations: the timer calls world.timedTick, so an own-property wrapper sees every real tick.
let durations: number[] = []
const timedTick = world.timedTick.bind(world)
world.timedTick = (now: number): number => {
  const ms = timedTick(now)
  durations.push(ms)
  return ms
}
const lag = monitorEventLoopDelay({ resolution: 5 })
lag.enable()

const mb = (n: number) => Math.round((n / 1048576) * 100) / 100
const fileMb = (f: string) => {
  try {
    return mb(statSync(f).size)
  } catch {
    return 0
  }
}

function collections(): Record<string, number> {
  const out: Record<string, number> = {}
  const owners: [string, object][] = [['world', world], ['gameplay', gameplay], ['spawner', gameplay.spawner], ...gameplay.modules.map((m) => [m.constructor.name, m] as [string, object])]
  const visit = (prefix: string, o: object, depth: number): void => {
    for (const [k, v] of Object.entries(o)) {
      if (v instanceof Map || v instanceof Set) out[`${prefix}.${k}`] = v.size
      else if (Array.isArray(v) && k !== 'modules') out[`${prefix}.${k}`] = v.length
      else if (depth > 0 && v && typeof v === 'object' && !ArrayBuffer.isView(v) && Object.getPrototypeOf(v) !== Object.prototype && !(v as { kind?: unknown }).kind) {
        // one level into helper objects (e.g. the skill engine's effects table), not into entities or config
        if (!owners.some(([, x]) => x === v)) visit(`${prefix}.${k}`, v as object, depth - 1)
      }
    }
  }
  for (const [name, o] of owners) visit(name, o, 1)
  return out
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0)

function sample(): HostSample {
  const ticks = durations
  durations = []
  const sorted = [...ticks].sort((a, b) => a - b)
  const mem = process.memoryUsage()
  const s: HostSample = {
    at: Date.now(),
    uptimeS: Math.round(process.uptime()),
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    heapAfterGcMb: 0,
    spaces: {},
    externalMb: mb(mem.external),
    lagMeanMs: Math.round((lag.mean / 1e6) * 100) / 100,
    lagP99Ms: Math.round((lag.percentile(99) / 1e6) * 100) / 100,
    lagMaxMs: Math.round((lag.max / 1e6) * 100) / 100,
    ticks: ticks.length,
    tickMeanMs: ticks.length ? Math.round((ticks.reduce((a, b) => a + b, 0) / ticks.length) * 1000) / 1000 : 0,
    tickP99Ms: Math.round(pct(sorted, 0.99) * 1000) / 1000,
    tickMaxMs: Math.round((sorted.at(-1) ?? 0) * 1000) / 1000,
    tickDurations: ticks.map((x) => Math.round(x * 1000) / 1000),
    entities: { players: world.players.size, mobs: world.mobs.size, items: world.items.size, npcs: world.npcs.size, sockets: sockets.size },
    collections: collections(),
    handles: {},
    dbMb: fileMb(join(config.dataDir, 'game.db')),
    walMb: fileMb(join(config.dataDir, 'game.db-wal')),
  }
  for (const h of process.getActiveResourcesInfo()) s.handles[h] = (s.handles[h] ?? 0) + 1
  lag.reset()
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc) {
    gc()
    s.heapAfterGcMb = mb(process.memoryUsage().heapUsed)
    for (const sp of getHeapSpaceStatistics()) s.spaces[sp.space_name] = mb(sp.space_used_size)
  }
  return s
}

let stopping = false
process.on('message', (raw) => {
  const cmd = raw as HostCommand
  if (cmd.t === 'sample') send({ t: 'sample', sample: sample() })
  else if (cmd.t === 'positions') {
    const now = Date.now()
    send({
      t: 'positions',
      players: [...world.players.values()].map((p) => {
        const at = world.livePoint(p, now)
        return { name: p.name, characterId: p.characterId, x: at.x, y: at.y, z: at.z, dead: p.dead }
      }),
    })
  } else if (cmd.t === 'shutdown' && !stopping) {
    // main.ts shutdown(): save and close, then exit.
    stopping = true
    config.log('soak: saving and shutting down')
    void server.close().then(
      () => {
        send({ t: 'closed' })
        setTimeout(() => process.exit(0), 50)
      },
      (e) => {
        send({ t: 'fault', kind: 'uncaughtException', message: `close failed: ${(e as Error)?.stack ?? e}` })
        setTimeout(() => process.exit(1), 50)
      },
    )
  }
})
process.on('disconnect', () => {
  // The driver died: do not linger.
  if (!stopping) void server.close().finally(() => process.exit(0))
})

send({ t: 'ready', port: server.port, url: server.url, pid: process.pid })
