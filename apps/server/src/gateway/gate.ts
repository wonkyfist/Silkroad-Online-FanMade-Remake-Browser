import { parseClientMessage, type ClientMessage } from '@sro/shared'
import { TokenBucket } from '../auth.ts'

/**
 * The front of a client connection (docs/SERVER_ARCHITECTURE.md §3.3, phase P1a): the per-connection flood ceiling,
 * binary refusal, decode + validate (validate.ts, exact key sets) and the silent per-type budgets. It turns one socket
 * frame into a Verdict. The in-process Connection (GATEWAYS=0) and a gateway process run this same code; the verdict then
 * goes to Connection.verdict, in the frame's order, which answers it exactly as before (errors, strikes, the request).
 * So the replies stay in the order the client sent its frames, whichever process decoded them.
 */

/**
 * Per-connection flood ceiling over all message types (docs/NETWORK_AUDIT.md N3). Every type also has its own budget
 * (CLIENT_RATE_LIMITS, MESSAGE_RATE_LIMITS below), so this only catches a client sending everything at once: a player
 * walking with the keys (moveTo 10/s), fighting, chatting and pinging stays far below it. An earlier 20/s shared
 * budget let one stream (flight input at 20/s) starve every other message and strike the socket closed.
 */
export const MSG_RATE = 60
export const MSG_BURST = 120

/**
 * Budgets of the non-gameplay messages (gameplay requests use CLIENT_RATE_LIMITS). Over its budget a message is dropped
 * without a strike: moveTo (the WASD stream is 10/s, burst 3; a click walk resends every 250 ms) and ping silently,
 * the lobby requests with error rate_limited. Chat and gm keep their own buckets.
 */
export const MESSAGE_RATE_LIMITS: Readonly<Partial<Record<ClientMessage['t'], { perSecond: number; burst: number }>>> = {
  moveTo: { perSecond: 15, burst: 15 },
  ping: { perSecond: 2, burst: 4 },
  charList: { perSecond: 2, burst: 5 },
  nameCheck: { perSecond: 5, burst: 10 },
  charCreate: { perSecond: 5, burst: 20 },
  charDelete: { perSecond: 2, burst: 10 },
  enterWorld: { perSecond: 1, burst: 3 },
  leaveWorld: { perSecond: 1, burst: 3 },
}
/** Over budget, these are dropped without any answer (the client sends them on a timer; an answer would be noise). */
export const SILENT_DROP: ReadonlySet<string> = new Set<string>(['moveTo', 'ping'])

/** What one client frame is, for Connection.verdict. `len`: the frame's UTF-8 text length (NetStats). */
export type Verdict =
  /** Over the flood ceiling: error rate_limited + a strike. */
  | { k: 'flood' }
  /** A binary frame: error bad_request + a strike. */
  | { k: 'binary' }
  /** Not a valid client message: counted as `invalid`, error bad_request + a strike. */
  | { k: 'invalid'; len: number; error: string }
  /** Over its own MESSAGE_RATE_LIMITS budget: counted; error rate_limited unless SILENT_DROP. */
  | { k: 'limited'; t: ClientMessage['t']; len: number }
  /** A valid message within its budgets: counted and handled. */
  | { k: 'msg'; len: number; msg: ClientMessage }

/** A frame's text (ws hands a Buffer, a Buffer[] of fragments or an ArrayBuffer). */
export function frameText(data: unknown): string {
  return Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
}

/** Connection.closeReason of a socket the client (or the heartbeat) closed: "client 1001", "heartbeat timeout". */
export function socketCloseReason(code: number, reason: Buffer, timedOut: boolean): string {
  return timedOut ? 'heartbeat timeout' : `client ${code}${reason.length ? ' ' + reason.toString('utf8').slice(0, 60) : ''}`
}

/** Connection.closeReason of a socket error: "socket error ECONNRESET". */
export function socketErrorReason(e: Error): string {
  return `socket error ${(e as NodeJS.ErrnoException).code ?? e.message}`
}

export class FrameGate {
  private readonly bucket = new TokenBucket(MSG_RATE, MSG_BURST)
  private readonly budgets = new Map<ClientMessage['t'], TokenBucket>()

  /** One frame (in arrival order). */
  check(data: unknown, isBinary: boolean): Verdict {
    if (!this.bucket.take()) return { k: 'flood' }
    if (isBinary) return { k: 'binary' }
    const text = frameText(data)
    const parsed = parseClientMessage(text)
    if (!parsed.ok) return { k: 'invalid', len: text.length, error: parsed.error }
    const t = parsed.msg.t
    const limit = MESSAGE_RATE_LIMITS[t]
    if (limit) {
      let b = this.budgets.get(t)
      if (!b) this.budgets.set(t, (b = new TokenBucket(limit.perSecond, limit.burst)))
      if (!b.take()) return { k: 'limited', t, len: text.length }
    }
    return { k: 'msg', len: text.length, msg: parsed.msg }
  }
}
