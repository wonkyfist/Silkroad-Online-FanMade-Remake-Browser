import { CLOSE_CODE, PROTOCOL_VERSION, type ClientMessage, type Role, type ServerInfo, type ServerMessage } from '@sro/shared'
import { t } from '../i18n/index.ts'
import { GameError } from './api.ts'
import { ServerClock } from './clock.ts'
import type { Wire, WireFactory } from './wire.ts'

export type SessionStatus = 'connecting' | 'online' | 'reconnecting' | 'closed'

export interface StatusEvent {
  status: SessionStatus
  /** True on the `online` that follows a successful reconnect: screens must re-sync their state. */
  resumed?: boolean
  /** Why the session closed: 'logout', 'unauthorized', 'lost', 'version_mismatch', ... */
  reason?: string
  message?: string
}

type Msg<K extends ServerMessage['t']> = Extract<ServerMessage, { t: K }>

const PING_INTERVAL_MS = 5000
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]

/** Close codes after which retrying with the same token is pointless (or would fight another login). */
const FATAL_CLOSE: Record<number, { reason: string; message: string }> = {
  [CLOSE_CODE.replaced]: { reason: 'replaced', message: t('net.replaced') },
  [CLOSE_CODE.unauthorized]: { reason: 'unauthorized', message: t('net.expired') },
  [CLOSE_CODE.versionMismatch]: { reason: 'version_mismatch', message: t('net.versionMismatch') },
  [CLOSE_CODE.abuse]: { reason: 'abuse', message: t('net.abuse') },
  [CLOSE_CODE.kicked]: { reason: 'kicked', message: t('net.kicked') },
}

/** The server's close reason for a GM kick is `kicked` or `kicked: <reason>`. */
export function kickMessage(closeReason: string): string {
  const why = closeReason.replace(/^kicked:?\s*/i, '').trim()
  return why ? t('net.kickedWhy', { reason: why }) : t('net.kicked')
}

/**
 * One logged-in game connection: `hello` handshake, typed send/receive, request helpers,
 * ping/pong clock sync, and automatic reconnect (re-sending `hello` with the same token).
 */
export class Session {
  account = ''
  server: ServerInfo | null = null
  slots = 4
  /** GM addition: this account's role (welcome / worldEnter / role; absent = player). */
  role: Role = 'player'
  readonly clock = new ServerClock()
  private statusValue: SessionStatus = 'connecting'
  private wire: Wire | null = null
  private readonly listeners = new Set<(msg: ServerMessage) => void>()
  private readonly statusListeners = new Set<(ev: StatusEvent) => void>()
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private pingN = 0
  private attempt = 0
  private everOnline = false
  private closed = false
  private closedReason: string | undefined

  constructor(private readonly factory: WireFactory, private readonly token: string) {}

  get status(): SessionStatus {
    return this.statusValue
  }

  /** Opens the socket and resolves on the first `welcome`. */
  connect(): Promise<Msg<'welcome'>> {
    return new Promise((resolve, reject) => {
      let settled = false
      const off = this.onStatus(ev => {
        if (settled) return
        if (ev.status === 'closed') {
          settled = true
          off()
          reject(new GameError((ev.reason as GameError['code']) ?? 'network', ev.message ?? t('net.failed')))
        }
      })
      const offMsg = this.on(msg => {
        if (settled || msg.t !== 'welcome') return
        settled = true
        off()
        offMsg()
        resolve(msg)
      })
      this.open()
    })
  }

  private open(): void {
    const wire = this.factory()
    this.wire = wire
    let welcomed = false
    wire.onOpen = () => wire.send({ t: 'hello', version: PROTOCOL_VERSION, token: this.token })
    wire.onMessage = msg => {
      if (wire !== this.wire) return
      if (msg.t === 'welcome') {
        welcomed = true
        this.account = msg.account
        this.server = msg.server
        this.slots = msg.slots
        this.role = msg.role ?? 'player'
        const resumed = this.everOnline
        this.everOnline = true
        this.attempt = 0
        this.startPing()
        this.setStatus({ status: 'online', resumed })
      } else if (msg.t === 'worldEnter') {
        this.role = msg.role ?? this.role
      } else if (msg.t === 'role') {
        this.role = msg.role
      } else if (msg.t === 'pong') {
        this.clock.pong(msg.clientTime, msg.serverTime)
      } else if (msg.t === 'error' && !welcomed && (msg.re === 'hello' || msg.re === undefined)) {
        // Handshake refused: do not retry with the same token.
        this.closed = true
        this.dropWire()
        this.setStatus({ status: 'closed', reason: msg.code, message: msg.message })
        return
      }
      for (const l of [...this.listeners]) l(msg)
    }
    wire.onClose = info => {
      if (wire !== this.wire) return
      this.stopPing()
      this.wire = null
      if (this.closed || info.clean) {
        this.setStatus({ status: 'closed', reason: this.closedReason ?? 'logout' })
        return
      }
      const fatal = FATAL_CLOSE[info.code]
      if (fatal) {
        this.closed = true
        // Our own wording wins over the server's raw close reason, except for a GM kick's reason (UX_GAPS R2).
        const message = info.code === CLOSE_CODE.kicked ? kickMessage(info.reason) : fatal.message
        this.setStatus({ status: 'closed', reason: fatal.reason, message })
        return
      }
      this.scheduleReconnect(info.reason)
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this.everOnline || this.attempt >= RECONNECT_DELAYS_MS.length) {
      this.closed = true
      this.setStatus({
        status: 'closed',
        reason: this.everOnline ? 'lost' : 'network',
        message: this.everOnline ? t('net.lostServer') : reason ? t('net.cannotConnectWhy', { reason }) : t('net.cannotConnect'),
      })
      return
    }
    const delay = RECONNECT_DELAYS_MS[this.attempt++]!
    this.setStatus({ status: 'reconnecting', message: t('net.reconnecting', { attempt: this.attempt }) })
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.open()
    }, delay)
  }

  private setStatus(ev: StatusEvent): void {
    this.statusValue = ev.status
    for (const l of [...this.statusListeners]) l(ev)
  }

  private startPing(): void {
    this.stopPing()
    // The ping carries the clock's own (monotonic) time, so the pong's round trip and offset use one clock (W9F F1).
    const ping = () => this.wire?.send({ t: 'ping', n: ++this.pingN, clientTime: this.clock.now() })
    ping()
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private dropWire(): void {
    this.stopPing()
    const w = this.wire
    this.wire = null
    w?.close()
  }

  on(handler: (msg: ServerMessage) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  onStatus(handler: (ev: StatusEvent) => void): () => void {
    this.statusListeners.add(handler)
    return () => this.statusListeners.delete(handler)
  }

  send(msg: ClientMessage): void {
    this.wire?.send(msg)
  }

  /**
   * Sends `msg` and resolves with the first reply whose type is in `expect`.
   * Rejects on an `error` that names this request (`re`), on timeout, or if the connection drops.
   */
  request<K extends ServerMessage['t']>(msg: ClientMessage, expect: K[], timeoutMs = 10000): Promise<Msg<K>> {
    return new Promise((resolve, reject) => {
      if (this.statusValue !== 'online') {
        reject(new GameError('network', t('net.notConnected')))
        return
      }
      const done = () => {
        clearTimeout(timer)
        off()
        offStatus()
      }
      const timer = setTimeout(() => {
        done()
        reject(new GameError('timeout', t('net.noReply', { request: msg.t })))
      }, timeoutMs)
      const off = this.on(reply => {
        if ((expect as string[]).includes(reply.t)) {
          done()
          resolve(reply as Msg<K>)
        } else if (reply.t === 'error' && reply.re === msg.t) {
          done()
          reject(new GameError(reply.code, reply.message))
        }
      })
      const offStatus = this.onStatus(ev => {
        if (ev.status === 'reconnecting' || ev.status === 'closed') {
          done()
          reject(new GameError('network', t('net.lost')))
        }
      })
      this.send(msg)
    })
  }

  close(reason = 'logout'): void {
    if (this.closed && !this.wire) return
    this.closed = true
    this.closedReason = reason
    clearTimeout(this.reconnectTimer)
    this.dropWire()
    if (this.statusValue !== 'closed') this.setStatus({ status: 'closed', reason })
  }
}
