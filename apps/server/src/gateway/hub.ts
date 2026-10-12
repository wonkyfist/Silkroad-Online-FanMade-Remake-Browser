import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ConnSocket } from '../connection.ts'
import { PH, type PhaseTimers } from '../phases.ts'
import { FT, FrameReader, OutBatch, frame, type GatewayInit, type GatewayStats, type GwEvent, type SocketHandoff } from './protocol.ts'

/**
 * The core's side of the gateway processes (docs/SERVER_ARCHITECTURE.md §3.3, phase P1a; GATEWAYS=N, 0 = the sockets
 * stay in this process). It starts N gateway processes (gateway/main.ts), hands each new WebSocket upgrade (after the
 * origin check and the per-IP cap, game.ts) to the least loaded one, and gives the core a ConnSocket per connection
 * (RemoteSocket): sends become records of one OUT batch per gateway and event-loop turn (one payload, many recipients:
 * encode-once's Buffer), closes ride in the same ordered stream. The gateways answer with the frames' verdicts in order
 * (Connection.verdict), opens and closes.
 *
 * A gateway that dies is restarted; its connections end as a dropped socket ("socket error gateway exit"), so their
 * characters are held for the 15 s reconnect grace (resume.ts) and the clients come back through the resume path. The
 * world itself never lived in the gateway: nothing of it is lost.
 */

const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url))
/** The gateways run TypeScript through tsx, like the core (an absolute URL: any working directory resolves it). */
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
/** Restart back-off after a gateway crash (doubles up to the max; reset after a minute up). */
const RESTART_MIN_MS = 250
const RESTART_MAX_MS = 5000

export interface HubEvents {
  /** The handshake is done: the core creates its Connection now (`sock` carries it). */
  opened(id: number, sock: RemoteSocket, ip: string): void
  /** One frame's verdict, in the client's order. */
  verdict(id: number, v: Extract<GwEvent, ['v', number, unknown]>[2]): void
  /** The socket ended (`opened` true when the core had a Connection for it). */
  closed(id: number, reason: string, ip: string, opened: boolean): void
  log(line: string): void
}

/** A connection whose socket a gateway owns. */
export class RemoteSocket implements ConnSocket {
  open = true
  readonly buffered = 0

  constructor(
    private readonly link: GatewayLink,
    readonly id: number,
  ) {}

  write(frame: Buffer | string): void {
    if (!this.open) return
    this.link.batch.msg(this.id, typeof frame === 'string' ? Buffer.from(frame) : frame)
    this.link.hub.schedule()
  }

  close(code: number, reason: string): void {
    if (!this.open) return
    this.open = false
    this.link.batch.close(this.id, code, reason)
    this.link.hub.schedule()
  }
}

interface Entry {
  id: number
  link: GatewayLink
  ip: string
  sock: RemoteSocket | null
}

class GatewayLink {
  child: ChildProcess | null = null
  pipe: Duplex | null = null
  ready = false
  /** Connections handed to it (handshake pending included). */
  readonly entries = new Map<number, Entry>()
  batch = new OutBatch()
  stats: GatewayStats | null = null
  restarts = 0
  startedAt = 0
  backoff = RESTART_MIN_MS
  /** CPU of its earlier lives (cumulative counters restart with the process). */
  cpuBefore = { user: 0, system: 0 }
  /** start()'s wait for the first READY. */
  onReady: (() => void) | null = null

  constructor(
    readonly hub: GatewayHub,
    readonly index: number,
  ) {}
}

export class GatewayHub {
  private readonly links: GatewayLink[] = []
  private nextId = 1
  private scheduled = false
  private closing = false
  private readonly entries = new Map<number, Entry>()

  constructor(
    readonly count: number,
    private readonly init: Omit<GatewayInit, 'k' | 'id'>,
    private readonly ev: HubEvents,
    private readonly timers: () => PhaseTimers,
  ) {
    for (let i = 0; i < count; i++) this.links.push(new GatewayLink(this, i))
  }

  /** Starts every gateway; resolves when all are ready, rejects if none is within `timeoutMs`. */
  async start(timeoutMs = 20_000): Promise<void> {
    const ready = this.links.map((l) => new Promise<void>((res) => this.spawn(l, res)))
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all(ready),
      new Promise<void>((res, rej) => {
        timer = setTimeout(() => (this.links.some((l) => l.ready) ? res() : rej(new Error(`no gateway process ready in ${timeoutMs} ms`))), timeoutMs)
      }),
    ])
    clearTimeout(timer)
  }

  private spawn(l: GatewayLink, onReady?: () => void): void {
    const child = fork(ENTRY, [String(l.index)], {
      execArgv: ['--import', TSX],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe', 'pipe'],
      serialization: 'json',
    })
    l.child = child
    l.ready = false
    l.startedAt = Date.now()
    // fd 4: our frames to it; fd 5: its frames to us (gateway/protocol.ts)
    const pipe = child.stdio[4] as Duplex
    l.pipe = pipe
    const back = (child.stdio as unknown as Duplex[])[5]!
    const reader = new FrameReader((type, body) => this.onFrame(l, type, body))
    back.on('data', (d: Buffer) => reader.push(d))
    back.on('error', () => {})
    pipe.on('error', () => {})
    child.on('error', (e) => this.ev.log(`gateway ${l.index}: ${e.message}`))
    child.once('exit', (code, signal) => this.onExit(l, child, code, signal))
    const m: GatewayInit = { k: 'init', id: l.index, ...this.init }
    l.onReady = onReady ?? null
    child.send(m)
  }

  private onFrame(l: GatewayLink, type: number, body: Buffer): void {
    if (type === FT.in) {
      const T = this.timers()
      const t0 = T.now()
      const events = JSON.parse(body.toString('utf8')) as GwEvent[]
      for (const e of events) {
        try {
          this.onEvent(l, e)
        } catch (err) {
          this.ev.log(`gateway ${l.index} event ${e[0]}: ${(err as Error).stack ?? err}`)
        }
      }
      T.lap(PH.inbound, t0)
    } else if (type === FT.stats) {
      l.stats = JSON.parse(body.toString('utf8')) as GatewayStats
    } else if (type === FT.ready) {
      l.ready = true
      this.ev.log(`gateway ${l.index}: ready (pid ${l.child?.pid})`)
      const once = l.onReady
      l.onReady = null
      once?.()
    }
  }

  private onEvent(l: GatewayLink, e: GwEvent): void {
    const entry = this.entries.get(e[1])
    if (!entry || entry.link !== l) return
    if (e[0] === 'v') {
      if (entry.sock) this.ev.verdict(entry.id, e[2])
    } else if (e[0] === 'o') {
      if (entry.sock) return
      entry.sock = new RemoteSocket(l, entry.id)
      this.ev.opened(entry.id, entry.sock, entry.ip)
    } else if (e[0] === 'c') this.drop(entry, e[2])
  }

  private drop(entry: Entry, reason: string): void {
    this.entries.delete(entry.id)
    entry.link.entries.delete(entry.id)
    if (entry.sock) entry.sock.open = false
    this.ev.closed(entry.id, reason, entry.ip, entry.sock !== null)
  }

  private onExit(l: GatewayLink, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (l.child !== child) return
    if (l.stats) {
      l.cpuBefore.user += l.stats.cpuUserMs
      l.cpuBefore.system += l.stats.cpuSystemMs
    }
    l.child = null
    l.pipe = null
    l.ready = false
    l.stats = null
    l.batch = new OutBatch()
    // its sockets died with it: each connection ends as a dropped socket (held for the reconnect grace)
    const dropped = l.entries.size
    for (const entry of [...l.entries.values()]) this.drop(entry, 'socket error gateway exit')
    if (this.closing) return
    this.ev.log(`gateway ${l.index}: exited (${signal ?? code}); ${dropped} connections dropped; restarting in ${l.backoff} ms`)
    l.restarts++
    const wait = Date.now() - l.startedAt > 60_000 ? RESTART_MIN_MS : l.backoff
    l.backoff = Math.min(RESTART_MAX_MS, wait * 2)
    setTimeout(() => {
      if (!this.closing) this.spawn(l)
    }, wait).unref()
  }

  /**
   * Hands an upgrade request's socket to the least loaded ready gateway, which completes the WebSocket handshake.
   * false: no gateway is ready (the caller answers 503).
   */
  pass(req: IncomingMessage, socket: Duplex, head: Buffer, ip: string): boolean {
    let best: GatewayLink | null = null
    for (const l of this.links) if (l.ready && l.child && (!best || l.entries.size < best.entries.size)) best = l
    if (!best || this.closing) return false
    const id = this.nextId++
    const entry: Entry = { id, link: best, ip, sock: null }
    this.entries.set(id, entry)
    best.entries.set(id, entry)
    const m: SocketHandoff = { k: 'socket', conn: id, method: req.method ?? 'GET', url: req.url ?? '/ws', headers: req.headers, head: head.toString('base64') }
    ;(socket as Socket).pause()
    const link = best
    best.child!.send(m, socket as Socket, { keepOpen: false }, (err) => {
      if (!err) return
      socket.destroy()
      const e = this.entries.get(id)
      if (e && e.link === link && !e.sock) this.drop(e, 'socket error handoff failed')
    })
    return true
  }

  /** One flush of every gateway's batch at the end of this event-loop turn (the `flush` phase). */
  schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => this.flush())
  }

  flush(): void {
    this.scheduled = false
    const T = this.timers()
    const t0 = T.now()
    for (const l of this.links) {
      if (l.batch.empty) continue
      const buf = l.batch.take()
      if (l.pipe && l.child) l.pipe.write(buf)
    }
    T.lap(PH.flush, t0)
  }

  /** Graceful stop: the last batches (shutdown notices, close frames), then every gateway closes its sockets and exits. */
  async close(timeoutMs = 3000): Promise<void> {
    this.flush()
    this.closing = true
    const exits: Promise<void>[] = []
    for (const l of this.links) {
      const child = l.child
      if (!child || !l.pipe) continue
      exits.push(
        new Promise<void>((res) => {
          const t = setTimeout(() => {
            child.kill()
            res()
          }, timeoutMs)
          child.once('exit', () => {
            clearTimeout(t)
            res()
          })
        }),
      )
      l.pipe.write(frame(FT.shutdown))
    }
    await Promise.all(exits)
  }

  /** Every gateway's latest counters, with the CPU of earlier lives added (GET /netstats, the admin dashboard). */
  snapshot(): { count: number; ready: number; restarts: number; connections: number; list: (GatewayStats & { index: number; ready: boolean; restarts: number })[] } {
    const list = this.links.map((l) => {
      const s = l.stats ?? ({ id: l.index, pid: l.child?.pid ?? 0, conns: 0, cpuUserMs: 0, cpuSystemMs: 0, rssMb: 0, heapMb: 0, bufferedBytes: 0, maxBufferedBytes: 0, outMs: 0, inMs: 0, outBatches: 0, outFrames: 0, outBytes: 0, inFrames: 0, slowCloses: 0, loop: { p50Ms: 0, p99Ms: 0, maxMs: 0 } } satisfies GatewayStats)
      return { ...s, cpuUserMs: s.cpuUserMs + l.cpuBefore.user, cpuSystemMs: s.cpuSystemMs + l.cpuBefore.system, index: l.index, ready: l.ready, restarts: l.restarts }
    })
    return { count: this.links.length, ready: this.links.filter((l) => l.ready).length, restarts: this.links.reduce((a, l) => a + l.restarts, 0), connections: this.entries.size, list }
  }

  /** The gateways' outbound backlog (netstats `queue`). */
  queue(): { bufferedBytes: number; maxBufferedBytes: number } {
    let bufferedBytes = 0
    let maxBufferedBytes = 0
    for (const l of this.links) {
      bufferedBytes += l.stats?.bufferedBytes ?? 0
      maxBufferedBytes = Math.max(maxBufferedBytes, l.stats?.maxBufferedBytes ?? 0)
    }
    return { bufferedBytes, maxBufferedBytes }
  }

  /** Test hook (chaos): kills gateway `index`'s process as a crash would. */
  crash(index: number): number | undefined {
    const c = this.links[index]?.child
    c?.kill('SIGKILL')
    return c?.pid
  }
}
