import { LocalBus, type Envelope, type LocalTransport, type TransportStats } from '../bus/transport.ts'
import { fail, type Result } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from '../modules.ts'
import type { Player } from '../world.ts'

/**
 * The global services (docs/SERVER_ARCHITECTURE.md §3.6, phase P2; SVC_BUS=1). Each service is the single owner of
 * its state and requests and sits at its own bus address (`svc:<name>`); the zone (World + Gameplay) reaches it only
 * through the bus. In P2 every service lives in the core's main thread on a LocalBus (synchronous delivery: the
 * same order as the direct calls of SVC_BUS=0, which the equivalence test checks); the bodies are plain data (ids, client
 * messages, results), so a service can move to its own thread or machine behind a PortTransport later (P3/P4), where
 * the zone keeps cached copies of the fields it reads synchronously (`partyId`, `guildId`, `wanted`, the clock…).
 *
 * Owners: `account` (lobby: character list/create/look/delete, name checks; sessions; roles, the gm CLI's inbox),
 * `chat` (party, guild, stall and whisper channels; local chat stays in the zone), `party`, `guild`, `economy` (trade,
 * stalls, shops, storage, the market; transfers: services/economy.ts), `law` (jobs, the law, Hunters, the jail),
 * `world` (clock, weather, winter, lightning, storms, tornadoes, the siege, caravan and unique schedules), `mall` (the
 * item mall: a placeholder API).
 */

export const SERVICES = ['account', 'chat', 'party', 'guild', 'economy', 'law', 'world', 'mall'] as const
export type ServiceName = (typeof SERVICES)[number]

/** The gameplay modules each service owns (their requests go through the bus to it). */
export const SERVICE_MODULES: Readonly<Record<ServiceName, readonly string[]>> = {
  account: [],
  chat: [],
  party: ['party'],
  guild: ['guilds'],
  economy: ['trade', 'stalls', 'shops', 'storage', 'market'],
  law: ['law', 'hunters', 'jail', 'jobs'],
  world: ['weather', 'winter', 'lightning', 'storm', 'tornado', 'siege', 'caravan', 'uniques'],
  mall: [],
}

const RING = 512

interface Meter {
  requests: number
  errors: number
  ms: Float64Array
  n: number
  max: number
  restarts: number
}

export interface ServiceStats {
  /** Requests and calls handled, failures (a throw), handling time (ms) p50 / p95 / max over the last RING. */
  requests: number
  errors: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  restarts: number
  /** The service endpoint's bus counters (queue depth and oldest age: 0 in one thread). */
  bus: TransportStats
}

/** A request body on the bus: the player by entity id, the module by name, the client message. */
interface ReqBody {
  rid: number
  pid: number
  mod: string
  msg: GameplayMessage
  now: number
}

export class ServiceHost {
  readonly bus = new LocalBus()
  readonly zone: LocalTransport
  private readonly ends = new Map<ServiceName, LocalTransport>()
  private readonly owner = new Map<GameplayModule, ServiceName>()
  private readonly modules = new Map<string, GameplayModule>()
  private readonly answers = new Map<number, Answer>()
  private readonly meters = new Map<ServiceName, Meter>()
  private readonly restarters = new Map<ServiceName, () => number>()
  private nextRid = 1

  constructor(
    private readonly playerById: (id: number) => Player | undefined,
    modules: readonly GameplayModule[],
  ) {
    this.zone = this.bus.endpoint('zone:0')
    this.zone.on('answer', (e) => {
      const { rid, r } = e.body as { rid: number; r: true | Result<unknown> }
      const a = this.answers.get(rid)
      if (!a) return
      this.answers.delete(rid)
      a(r as Parameters<Answer>[0])
    })
    for (const name of SERVICES) {
      const t = this.bus.endpoint(`svc:${name}`)
      this.ends.set(name, t)
      this.meters.set(name, { requests: 0, errors: 0, ms: new Float64Array(RING), n: 0, max: 0, restarts: 0 })
      t.on('request', (e) => this.serve(name, t, e))
    }
    for (const m of modules) {
      this.modules.set(m.name, m)
      for (const name of SERVICES) if (SERVICE_MODULES[name].includes(m.name)) this.owner.set(m, name)
    }
    // the item mall: a placeholder until it sells anything (services/economy.ts will make its purchases transfers)
    this.on('mall', 'catalog', () => [])
    this.on('mall', 'buy', () => fail('not_found', 'The item mall is not open yet.'))
  }

  /** The service that owns module `m`'s requests, if any. */
  ownerOf(m: GameplayModule | undefined): ServiceName | undefined {
    return m ? this.owner.get(m) : undefined
  }

  /** Registers handler `k` of service `name` (its value answers calls). */
  on(name: ServiceName, k: string, h: (body: unknown, e: Envelope) => unknown): void {
    const t = this.ends.get(name)!
    const m = this.meters.get(name)!
    t.on(k, (e) => this.timed(m, () => h(e.body, e)))
  }

  /** What a service's restart does (docs/SERVER_ARCHITECTURE.md §3.10): returns how many sessions it ended. */
  onRestart(name: ServiceName, fn: () => number): void {
    this.restarters.set(name, fn)
  }

  /** A synchronous call of service `name` (in one thread; a remote service is reached by request/answer instead). */
  call<T>(name: ServiceName, k: string, body?: unknown): T {
    return this.zone.call<T>(`svc:${name}`, k, body)
  }

  /**
   * A gameplay request for a module service `svc` owns: one `request` envelope to the service, which runs the module
   * and sends one `answer` envelope back (the actionResult). In one thread both are delivered before this returns.
   */
  request(svc: ServiceName, mod: GameplayModule, p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    const rid = this.nextRid++
    this.answers.set(rid, answer)
    const body: ReqBody = { rid, pid: p.id, mod: mod.name, msg, now }
    this.zone.send({ to: `svc:${svc}`, k: 'request', body })
  }

  private serve(name: ServiceName, t: LocalTransport, e: Envelope): void {
    const b = e.body as ReqBody
    const reply = (r: true | Result<unknown>) => t.send({ to: e.from, k: 'answer', body: { rid: b.rid, r } })
    const p = this.playerById(b.pid)
    const m = this.modules.get(b.mod)
    if (!p || !m?.request) return reply(fail('not_found'))
    this.timed(this.meters.get(name)!, () => m.request!(p, b.msg, reply as Answer, b.now))
  }

  private timed<T>(m: Meter, fn: () => T): T {
    const t0 = performance.now()
    m.requests++
    try {
      return fn()
    } catch (e) {
      m.errors++
      throw e
    } finally {
      const ms = performance.now() - t0
      m.ms[m.n++ % RING] = ms
      if (ms > m.max) m.max = ms
    }
  }

  /** Simulates a crash of service `name` (tests, chaos runs): its restart hook ends what it held. Returns that count. */
  restart(name: ServiceName): number {
    this.meters.get(name)!.restarts++
    return this.restarters.get(name)?.() ?? 0
  }

  stats(): Record<ServiceName, ServiceStats> {
    const out = {} as Record<ServiceName, ServiceStats>
    for (const name of SERVICES) {
      const m = this.meters.get(name)!
      const k = Math.min(m.n, RING)
      const s = Array.from(m.ms.subarray(0, k)).sort((a, b) => a - b)
      const pct = (q: number) => (k ? Math.round(s[Math.min(k - 1, Math.floor(q * k))]! * 1000) / 1000 : 0)
      out[name] = { requests: m.requests, errors: m.errors, p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: Math.round(m.max * 1000) / 1000, restarts: m.restarts, bus: this.ends.get(name)!.stats() }
    }
    return out
  }

  resetStats(): void {
    for (const m of this.meters.values()) {
      m.n = 0
      m.max = 0
    }
  }
}
