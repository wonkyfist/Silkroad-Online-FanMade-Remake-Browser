/**
 * The core <-> gateway byte stream (docs/SERVER_ARCHITECTURE.md §3.3, phase P1a). Two pipes per gateway process (the
 * child's fd 4 core -> gateway, fd 5 gateway -> core: one direction each, as a Windows pipe's pending read blocks writes
 * on the same handle) carry length-prefixed frames, FIFO in each direction:
 *
 *   frame  = u32 LE length of the rest, u8 type, body
 *   OUT    (core -> gateway) records until the end of the body, in the order the core sent them:
 *            u8 1 (message), u32 len, len bytes of UTF-8 JSON, u32 n, n x u32 connection id    (one payload, n recipients)
 *            u8 2 (close),   u32 connection id, u16 close code, u16 len, len bytes of UTF-8 reason
 *   SHUTDOWN (core -> gateway) no body: close every socket, then exit
 *   IN     (gateway -> core) UTF-8 JSON array of events, in arrival order: [GwEvent, ...]
 *   STATS  (gateway -> core) UTF-8 JSON GatewayStats, once a second
 *   READY  (gateway -> core) no body: the gateway takes sockets
 *
 * The sockets themselves travel on the child's IPC channel (subprocess.send(msg, socket)), the same way `cluster` hands
 * connections to its workers; everything after the hand-off uses this stream. Text frames only: the client protocol is
 * unchanged (JSON, PROTOCOL_VERSION as is).
 */
import type { Verdict } from './gate.ts'

export const FT = { out: 1, shutdown: 2, in: 10, stats: 11, ready: 12 } as const
export const REC_MSG = 1
export const REC_CLOSE = 2

/** Gateway -> core events: opened (handshake done), closed (with Connection.closeReason), one frame's verdict. */
export type GwEvent = ['o', number] | ['c', number, string] | ['v', number, Verdict]

/** What the core sends with a socket on the IPC channel. */
export interface SocketHandoff {
  k: 'socket'
  conn: number
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  /** Bytes the HTTP parser read past the upgrade request (base64). */
  head: string
}

/** The core's settings for a gateway (IPC, before the first socket). */
export interface GatewayInit {
  k: 'init'
  id: number
  maxPayload: number
  heartbeatMs: number
  maxBuffered: number
}

/** A gateway's counters (cumulative since it started, except `loop`: the last second). */
export interface GatewayStats {
  id: number
  pid: number
  conns: number
  cpuUserMs: number
  cpuSystemMs: number
  rssMb: number
  heapMb: number
  bufferedBytes: number
  maxBufferedBytes: number
  /** Time in socket writes (OUT batches: fan-out, ws framing, writev) and in inbound frames (decode, validate). */
  outMs: number
  inMs: number
  outBatches: number
  outFrames: number
  outBytes: number
  inFrames: number
  slowCloses: number
  loop: { p50Ms: number; p99Ms: number; maxMs: number }
}

export function frame(type: number, body?: Buffer): Buffer {
  const len = body ? body.length : 0
  const out = Buffer.allocUnsafe(5 + len)
  out.writeUInt32LE(1 + len, 0)
  out.writeUInt8(type, 4)
  if (body) body.copy(out, 5)
  return out
}

/** Splits a byte stream into frames (`on(type, body)`); bodies are views into the received chunks (no copy when whole). */
export class FrameReader {
  private chunks: Buffer[] = []
  private size = 0

  constructor(private readonly on: (type: number, body: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    for (;;) {
      if (this.size < 4) return
      // the length prefix split over chunks: join them once (then the head chunk holds it)
      if (this.chunks[0]!.length < 4) this.chunks = [Buffer.concat(this.chunks)]
      const len = this.chunks[0]!.readUInt32LE(0)
      if (this.size < 4 + len) return
      const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks)
      const type = all.readUInt8(4)
      const body = all.subarray(5, 4 + len)
      const rest = all.subarray(4 + len)
      this.chunks = rest.length ? [rest] : []
      this.size = rest.length
      this.on(type, body)
    }
  }
}

/** One OUT frame being built (core side): consecutive sends of the same payload Buffer become one record. */
export class OutBatch {
  private ops: ({ buf: Buffer; conns: number[] } | { conn: number; code: number; reason: Buffer })[] = []
  private last: { buf: Buffer; conns: number[] } | null = null
  private bytes = 0

  get empty(): boolean {
    return this.ops.length === 0
  }

  msg(conn: number, buf: Buffer): void {
    const l = this.last
    if (l && l.buf === buf) {
      l.conns.push(conn)
      this.bytes += 4
      return
    }
    const rec = { buf, conns: [conn] }
    this.ops.push(rec)
    this.last = rec
    this.bytes += 1 + 4 + buf.length + 4 + 4
  }

  close(conn: number, code: number, reason: string): void {
    const r = Buffer.from(reason.slice(0, 120), 'utf8')
    this.ops.push({ conn, code, reason: r })
    this.last = null
    this.bytes += 1 + 4 + 2 + 2 + r.length
  }

  /** The OUT frame, and the batch empties. */
  take(): Buffer {
    const out = Buffer.allocUnsafe(5 + this.bytes)
    out.writeUInt32LE(1 + this.bytes, 0)
    out.writeUInt8(FT.out, 4)
    let o = 5
    for (const op of this.ops) {
      if ('buf' in op) {
        out.writeUInt8(REC_MSG, o)
        out.writeUInt32LE(op.buf.length, o + 1)
        op.buf.copy(out, o + 5)
        o += 5 + op.buf.length
        out.writeUInt32LE(op.conns.length, o)
        o += 4
        for (const c of op.conns) {
          out.writeUInt32LE(c, o)
          o += 4
        }
      } else {
        out.writeUInt8(REC_CLOSE, o)
        out.writeUInt32LE(op.conn, o + 1)
        out.writeUInt16LE(op.code, o + 5)
        out.writeUInt16LE(op.reason.length, o + 7)
        op.reason.copy(out, o + 9)
        o += 9 + op.reason.length
      }
    }
    this.ops = []
    this.last = null
    this.bytes = 0
    return out
  }
}

/** Reads an OUT body: `msg(payload, conns)` / `close(conn, code, reason)` in record order. */
export function readOut(body: Buffer, msg: (payload: Buffer, conns: Uint32Array | number[]) => void, close: (conn: number, code: number, reason: string) => void): void {
  let o = 0
  while (o < body.length) {
    const kind = body.readUInt8(o)
    if (kind === REC_MSG) {
      const len = body.readUInt32LE(o + 1)
      const payload = body.subarray(o + 5, o + 5 + len)
      o += 5 + len
      const n = body.readUInt32LE(o)
      o += 4
      const conns: number[] = new Array(n)
      for (let i = 0; i < n; i++) conns[i] = body.readUInt32LE(o + 4 * i)
      o += 4 * n
      msg(payload, conns)
    } else if (kind === REC_CLOSE) {
      const conn = body.readUInt32LE(o + 1)
      const code = body.readUInt16LE(o + 5)
      const len = body.readUInt16LE(o + 7)
      const reason = body.toString('utf8', o + 9, o + 9 + len)
      o += 9 + len
      close(conn, code, reason)
    } else throw new Error(`OUT record ${kind} at ${o}`)
  }
}
