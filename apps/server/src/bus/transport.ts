import type { MessagePort } from 'node:worker_threads'

/**
 * The internal bus (docs/SERVER_ARCHITECTURE.md §3.2, §3.7; phase P2). One Transport interface so the placement of a
 * service or a writer is configuration: `LocalBus` endpoints in one thread (synchronous delivery, the order of a
 * direct call), `PortTransport` over a MessagePort (worker threads: the DB writer), later a TCP transport (P4).
 * Guarantees: FIFO per (sender, receiver) pair only. A request carries an id and a timeout; economy requests also an
 * idempotency key. Erasable TypeScript with type-only imports: the DB writer thread loads it with Node's own type
 * stripping.
 */

export type Address = `gw:${number}` | `zone:${number}` | `job:${number}` | `svc:${string}` | 'db' | 'director'

export interface Envelope {
  to: Address
  from: Address
  /** Message kind (bus/messages.ts). */
  k: string
  /** Request id (a reply carries it as `re`). */
  id?: number
  re?: number
  /** Idempotency key (economy requests: a retry with the same key gets the first answer). */
  key?: string
  tick?: number
  body?: unknown
  bin?: ArrayBuffer
  /** A failed request's reply: the error text. */
  err?: string
}

export type Handler = (e: Envelope) => unknown

export interface TransportStats {
  /** Requests sent and not answered yet, and the age of the oldest (ms). */
  queued: number
  oldestMs: number
  sent: number
  recv: number
  sentPerS: number
  recvPerS: number
  requests: number
  timeouts: number
  errors: number
  /** Request round trips (ms) over the last 512. */
  p50Ms: number
  p95Ms: number
}

export interface Transport {
  readonly self: Address
  /** Fire and forget, FIFO per (self, to). */
  send(e: Omit<Envelope, 'from'>, transfer?: ArrayBuffer[]): void
  /** A request: the receiver's handler return value (or promise) is the answer. */
  request<T>(e: Omit<Envelope, 'from' | 'id'>, timeoutMs?: number): Promise<T>
  /** The handler of kind `k` (one per kind). */
  on(k: string, h: Handler): void
  stats(): TransportStats
  close(): void
}

const RTT_RING = 512

interface Pending {
  at: number
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** Counters and the request table every transport keeps. */
export class BusMeter {
  sent = 0
  recv = 0
  requests = 0
  timeouts = 0
  errors = 0
  private readonly rtt = new Float64Array(RTT_RING)
  private rttN = 0
  private last = { at: Date.now(), sent: 0, recv: 0 }
  private rate = { sentPerS: 0, recvPerS: 0 }
  readonly pending = new Map<number, Pending>()
  private nextId = 1

  open(timeoutMs: number, resolve: (v: unknown) => void, reject: (e: Error) => void, what: string): number {
    const id = this.nextId++
    this.requests++
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (!this.pending.delete(id)) return
            this.timeouts++
            reject(new Error(`bus: ${what} timed out after ${timeoutMs} ms`))
          }, timeoutMs)
        : null
    timer?.unref?.()
    this.pending.set(id, { at: performance.now(), resolve, reject, timer })
    return id
  }

  recordRtt(ms: number): void {
    this.rtt[this.rttN++ % RTT_RING] = ms
  }

  settle(e: Envelope): void {
    const p = e.re === undefined ? undefined : this.pending.get(e.re)
    if (!p) return
    this.pending.delete(e.re!)
    if (p.timer) clearTimeout(p.timer)
    this.recordRtt(performance.now() - p.at)
    if (e.err !== undefined) {
      this.errors++
      p.reject(new Error(e.err))
    } else p.resolve(e.body)
  }

  failAll(why: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(why))
    }
  }

  stats(): TransportStats {
    const now = Date.now()
    if (now - this.last.at >= 1000) {
      const dt = (now - this.last.at) / 1000
      this.rate = { sentPerS: Math.round(((this.sent - this.last.sent) / dt) * 10) / 10, recvPerS: Math.round(((this.recv - this.last.recv) / dt) * 10) / 10 }
      this.last = { at: now, sent: this.sent, recv: this.recv }
    }
    let oldest = Infinity
    for (const p of this.pending.values()) if (p.at < oldest) oldest = p.at
    const k = Math.min(this.rttN, RTT_RING)
    const s = Array.from(this.rtt.subarray(0, k)).sort((a, b) => a - b)
    const pct = (q: number) => (k ? Math.round(s[Math.min(k - 1, Math.floor(q * k))]! * 1000) / 1000 : 0)
    return {
      queued: this.pending.size,
      oldestMs: oldest === Infinity ? 0 : Math.round(performance.now() - oldest),
      sent: this.sent,
      recv: this.recv,
      ...this.rate,
      requests: this.requests,
      timeouts: this.timeouts,
      errors: this.errors,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
    }
  }
}

/** Runs a handler and turns its value (or promise, or throw) into the reply of request `e`. */
function answerWith(e: Envelope, h: Handler | undefined, reply: (r: Envelope) => void, self: Address): void {
  const done = (body: unknown) => reply({ to: e.from, from: self, k: e.k, re: e.id, body })
  const fail = (err: unknown) => reply({ to: e.from, from: self, k: e.k, re: e.id, err: (err as Error)?.message ?? String(err) })
  if (!h) return fail(`no handler for ${e.k} at ${self}`)
  let v: unknown
  try {
    v = h(e)
  } catch (err) {
    return fail(err)
  }
  if (v && typeof (v as Promise<unknown>).then === 'function') (v as Promise<unknown>).then(done, fail)
  else done(v)
}

/**
 * In-thread endpoints (the services in the core's main thread, phase P2). Delivery is synchronous: a send runs the
 * receiver's handler before it returns, so routing a call through the bus keeps the exact order of the direct call
 * (the equivalence tests rely on it). A request's promise still settles in a microtask, like any transport's.
 */
export class LocalBus {
  private readonly ends = new Map<Address, LocalTransport>()

  endpoint(self: Address): LocalTransport {
    if (this.ends.has(self)) throw new Error(`bus: ${self} is registered twice`)
    const t = new LocalTransport(self, this)
    this.ends.set(self, t)
    return t
  }

  /** The endpoint at `a` (throws when nobody is there). */
  peer(a: Address): LocalTransport {
    const t = this.ends.get(a)
    if (!t) throw new Error(`bus: nobody at ${a}`)
    return t
  }

  /** @internal */
  drop(self: Address): void {
    this.ends.delete(self)
  }

  addresses(): Address[] {
    return [...this.ends.keys()]
  }

  stats(): Record<string, TransportStats> {
    return Object.fromEntries([...this.ends].map(([a, t]) => [a, t.stats()]))
  }
}

export class LocalTransport implements Transport {
  private readonly handlers = new Map<string, Handler>()
  private readonly m = new BusMeter()

  readonly self: Address
  private readonly bus: LocalBus

  constructor(self: Address, bus: LocalBus) {
    this.self = self
    this.bus = bus
  }

  send(e: Omit<Envelope, 'from'>): void {
    this.m.sent++
    this.bus.peer(e.to).receive({ ...e, from: this.self } as Envelope)
  }

  /**
   * A synchronous request (in-thread only): the receiver's handler runs now and its value is returned. The zone-side
   * proxies use it where today's code reads a value at once; a remote placement turns those reads into cached state
   * the service pushes (docs/SERVER_ARCHITECTURE.md §3.6 "Zones see").
   */
  call<T>(to: Address, k: string, body?: unknown): T {
    this.m.sent++
    this.m.requests++
    const t0 = performance.now()
    const peer = this.bus.peer(to)
    const v = peer.handle({ to, from: this.self, k, body }) as T
    this.m.recordRtt(performance.now() - t0)
    return v
  }

  request<T>(e: Omit<Envelope, 'from' | 'id'>, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.m.open(timeoutMs, resolve as (v: unknown) => void, reject, `${e.k} to ${e.to}`)
      this.send({ ...e, id })
    })
  }

  on(k: string, h: Handler): void {
    this.handlers.set(k, h)
  }

  /** @internal Runs the handler of `e.k` (a synchronous call). */
  handle(e: Envelope): unknown {
    this.m.recv++
    const h = this.handlers.get(e.k)
    if (!h) throw new Error(`bus: no handler for ${e.k} at ${this.self}`)
    return h(e)
  }

  /** @internal */
  receive(e: Envelope): void {
    this.m.recv++
    if (e.re !== undefined) return this.m.settle(e)
    const h = this.handlers.get(e.k)
    if (e.id !== undefined) return answerWith(e, h, (r) => this.bus.peer(r.to).receive(r), this.self)
    if (!h) throw new Error(`bus: no handler for ${e.k} at ${this.self}`)
    h(e)
  }

  stats(): TransportStats {
    return this.m.stats()
  }

  close(): void {
    this.m.failAll(`bus: ${this.self} closed`)
    this.bus.drop(this.self)
  }
}

/**
 * A transport over a MessagePort (worker threads; the DB writer's link, phase P2). Messages are structured-cloned
 * envelopes (bulk data goes in `bin`, transferred). Each end makes one over its side of a MessageChannel.
 */
export class PortTransport implements Transport {
  private readonly handlers = new Map<string, Handler>()
  private readonly m = new BusMeter()
  private closed = false

  readonly self: Address
  readonly peer: Address
  readonly port: MessagePort

  constructor(self: Address, peer: Address, port: MessagePort) {
    this.self = self
    this.peer = peer
    this.port = port
    port.on('message', (e: Envelope) => this.receive(e))
  }

  send(e: Omit<Envelope, 'from'>, transfer?: ArrayBuffer[]): void {
    if (this.closed) return
    this.m.sent++
    this.port.postMessage({ ...e, from: this.self }, transfer ?? [])
  }

  request<T>(e: Omit<Envelope, 'from' | 'id'>, timeoutMs = 5000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`bus: ${this.self} closed`))
    return new Promise<T>((resolve, reject) => {
      const id = this.m.open(timeoutMs, resolve as (v: unknown) => void, reject, `${e.k} to ${e.to}`)
      this.send({ ...e, id })
    })
  }

  on(k: string, h: Handler): void {
    this.handlers.set(k, h)
  }

  /** Handles one envelope (the port's listener; also what a synchronous drain with receiveMessageOnPort calls). */
  receive(e: Envelope): void {
    this.m.recv++
    if (e.re !== undefined) return this.m.settle(e)
    const h = this.handlers.get(e.k)
    if (e.id !== undefined) return answerWith(e, h, (r) => this.send(r), this.self)
    h?.(e)
  }

  stats(): TransportStats {
    return this.m.stats()
  }

  /** Fails the open requests (the peer died) and keeps the port. */
  failPending(why: string): void {
    this.m.failAll(why)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.m.failAll(`bus: ${this.self} closed`)
    this.port.close()
  }
}
