/**
 * A gateway process (docs/SERVER_ARCHITECTURE.md §3.3, phase P1a): owns client WebSockets the core hands it (after the
 * core's origin check and per-IP cap), completes their handshake, runs the heartbeat, decodes and validates every frame
 * (gateway/gate.ts: flood ceiling, exact-key parse, silent budgets) and fans the core's out-batches out to the sockets
 * (one payload, many recipients; corked per batch; MAX_BUFFERED backpressure closes a client that stopped reading).
 * Everything with a rule behind it (hello/auth, strikes, answered budgets, every request) stays in the core, which
 * receives the verdicts in frame order. Started by gateway/hub.ts with `fork`; exits when the core goes away.
 */
import { Socket } from 'node:net'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { WebSocketServer, type WebSocket } from 'ws'
import { CLOSE_CODE } from '@sro/shared'
import { FrameGate, socketCloseReason, socketErrorReason } from './gate.ts'
import { FT, FrameReader, frame, readOut, type GatewayInit, type GatewayStats, type GwEvent, type SocketHandoff } from './protocol.ts'

interface CorkableSocket {
  cork(): void
  uncork(): void
}

interface Conn {
  id: number
  ws: WebSocket
  gate: FrameGate
  alive: boolean
  timedOut: boolean
  /** Why this gateway closed it (slow), reported instead of the close event's own reason. */
  reason: string | null
}

const TEXT_FRAME = { binary: false } as const
/** fd 4: the core's frames to us; fd 5: ours to the core (one direction each: a Windows pipe read blocks its writes). */
const input = new Socket({ fd: 4, readable: true, writable: false })
const pipe = new Socket({ fd: 5, readable: false, writable: true })
let init: GatewayInit | null = null
let wss: WebSocketServer | null = null
const conns = new Map<number, Conn>()
let events: GwEvent[] = []
let shuttingDown = false
const st = { outMs: 0, inMs: 0, outBatches: 0, outFrames: 0, outBytes: 0, inFrames: 0, slowCloses: 0 }
const loop = monitorEventLoopDelay({ resolution: 10 })
loop.enable()

function emit(e: GwEvent): void {
  events.push(e)
  if (events.length === 1) setImmediate(flushEvents)
}

function flushEvents(): void {
  if (events.length === 0) return
  const body = Buffer.from(JSON.stringify(events))
  events = []
  pipe.write(frame(FT.in, body))
}

function closed(c: Conn, reason: string): void {
  if (conns.get(c.id) !== c) return
  conns.delete(c.id)
  emit(['c', c.id, c.reason ?? reason])
}

function accept(m: SocketHandoff, socket: Socket): void {
  if (!init || !wss || shuttingDown) {
    socket.destroy()
    emit(['c', m.conn, 'socket error gateway closing'])
    return
  }
  let done = false
  socket.once('close', () => {
    if (!done) emit(['c', m.conn, 'socket error handshake failed'])
  })
  socket.on('error', () => socket.destroy())
  const req = { method: m.method, url: m.url, headers: m.headers } as unknown as import('node:http').IncomingMessage
  wss.handleUpgrade(req, socket, Buffer.from(m.head, 'base64'), (ws) => {
    done = true
    const c: Conn = { id: m.conn, ws, gate: new FrameGate(), alive: true, timedOut: false, reason: null }
    conns.set(c.id, c)
    emit(['o', c.id])
    ws.on('pong', () => {
      c.alive = true
    })
    ws.on('message', (data, isBinary) => {
      const t0 = performance.now()
      st.inFrames++
      emit(['v', c.id, c.gate.check(data, isBinary)])
      st.inMs += performance.now() - t0
    })
    ws.on('close', (code: number, reason: Buffer) => closed(c, socketCloseReason(code, reason, c.timedOut)))
    ws.on('error', (e: Error) => closed(c, socketErrorReason(e)))
  })
}

/** One OUT frame: every record in order; each socket corked for the whole batch (one writev each). */
function out(body: Buffer): void {
  const t0 = performance.now()
  st.outBatches++
  const corked: CorkableSocket[] = []
  const max = init!.maxBuffered
  readOut(
    body,
    (payload, ids) => {
      for (let i = 0; i < ids.length; i++) {
        const c = conns.get(ids[i]!)
        if (!c || c.ws.readyState !== c.ws.OPEN) continue
        if (c.ws.bufferedAmount > max) {
          // Connection.send's rule, here where the backlog is: the client stopped reading
          st.slowCloses++
          c.reason = `server ${CLOSE_CODE.slow} not reading`
          try {
            c.ws.close(CLOSE_CODE.slow, 'not reading')
          } catch {
            c.ws.terminate()
          }
          continue
        }
        const s = (c.ws as WebSocket & { _socket?: CorkableSocket & { writableCorked?: number } })._socket
        if (s && !(s as { sroCorked?: boolean }).sroCorked) {
          ;(s as { sroCorked?: boolean }).sroCorked = true
          s.cork()
          corked.push(s)
        }
        c.ws.send(payload, TEXT_FRAME)
        st.outFrames++
        st.outBytes += payload.length
      }
    },
    (id, code, reason) => {
      const c = conns.get(id)
      if (!c) return
      // the core closed it (its side is disposed already); the close event still reports the socket's end (per-IP count)
      try {
        c.ws.close(code, reason)
      } catch {
        c.ws.terminate()
      }
    },
  )
  for (const s of corked) {
    ;(s as { sroCorked?: boolean }).sroCorked = false
    try {
      s.uncork()
    } catch {
      // closed meanwhile
    }
  }
  st.outMs += performance.now() - t0
}

function stats(): GatewayStats {
  let bufferedBytes = 0
  let maxBufferedBytes = 0
  for (const c of conns.values()) {
    const b = c.ws.bufferedAmount
    bufferedBytes += b
    if (b > maxBufferedBytes) maxBufferedBytes = b
  }
  const cpu = process.cpuUsage()
  const mem = process.memoryUsage()
  const ms = (ns: number) => Math.round(ns / 1e4) / 100
  const l = loop.count > 0 ? { p50Ms: ms(loop.percentile(50)), p99Ms: ms(loop.percentile(99)), maxMs: ms(loop.max) } : { p50Ms: 0, p99Ms: 0, maxMs: 0 }
  loop.reset()
  return {
    id: init?.id ?? -1, pid: process.pid, conns: conns.size, cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000),
    rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), bufferedBytes, maxBufferedBytes,
    outMs: Math.round(st.outMs * 100) / 100, inMs: Math.round(st.inMs * 100) / 100, outBatches: st.outBatches, outFrames: st.outFrames, outBytes: st.outBytes,
    inFrames: st.inFrames, slowCloses: st.slowCloses, loop: l,
  }
}

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  flushEvents()
  // the close frames written just before go out first; then every socket ends and the process with it
  setTimeout(() => {
    for (const c of conns.values()) c.ws.terminate()
    wss?.close()
    pipe.end(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  }, 100).unref()
}

const reader = new FrameReader((type, body) => {
  if (type === FT.out) out(body)
  else if (type === FT.shutdown) shutdown()
})
input.on('data', (d: Buffer) => reader.push(d))
input.on('error', () => process.exit(1))
input.on('close', () => process.exit(0))
pipe.on('error', () => process.exit(1))

process.on('message', (m: GatewayInit | SocketHandoff, handle?: unknown) => {
  if (m.k === 'init') {
    init = m
    wss = new WebSocketServer({ noServer: true, maxPayload: m.maxPayload, perMessageDeflate: false })
    // the heartbeat (game.ts HEARTBEAT_MS): no pong for a whole interval ends the socket (reason "heartbeat timeout")
    setInterval(() => {
      for (const c of conns.values()) {
        if (!c.alive) {
          c.timedOut = true
          c.ws.terminate()
          continue
        }
        c.alive = false
        c.ws.ping()
      }
    }, m.heartbeatMs).unref()
    setInterval(() => pipe.write(frame(FT.stats, Buffer.from(JSON.stringify(stats())))), 1000).unref()
    pipe.write(frame(FT.ready))
    return
  }
  if (m.k !== 'socket') return
  if (handle instanceof Socket) accept(m, handle)
  else emit(['c', m.conn, 'socket error handoff failed'])
})
// the core is gone (crash or exit): so are we; the clients reconnect to the next core
process.on('disconnect', () => process.exit(0))
// a Ctrl+C or a SIGTERM to the whole group: the core runs the shutdown (saves, notices, then SHUTDOWN to us)
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
