import type { Store } from '../db.ts'
import type { Player } from '../world.ts'
import { holdOutbound } from './hold.ts'

/**
 * The economy service's transfer core (docs/SERVER_ARCHITECTURE.md §3.6, §3.8; phase P2): the single place where
 * items and gold move between characters (trade, stall purchase; later guild storage, market, the item mall, GM
 * grants). Rules that keep anything from being duplicated or lost:
 *
 * - **One owner per balance**: a character's bag and gold change only inside a database transaction on the game's
 *   store (DB_WRITER: the in-memory copy whose journal the writer replays in order).
 * - **One transaction per transfer**: both sides' drafts, re-read inside it, and the log row (social/pair-tx.ts).
 * - **Escrow**: from the start of the transfer until its commit the parties are escrowed (`inEscrow`), and everything
 *   the server sends them waits (services/hold.ts).
 * - **Commit-then-ack**: the parties' streams flow again only when the writer has the transaction on disk, so a client
 *   never sees a result that a crash could undo.
 * - **Idempotency** (SVC_BUS): a transfer key seen before returns the first outcome without running again (a zone's
 *   retry over the bus in P3 cannot pay twice).
 */

const KEY_TTL_MS = 10 * 60_000
const KEY_MAX = 10_000
const LAT_RING = 1024

export interface EconomyStats {
  transfers: number
  /** Repeated keys answered from the first outcome. */
  replays: number
  /** Transfers waiting for their commit now, and the escrowed characters. */
  pending: number
  escrowed: number
  /** Start of a transfer → its parties' streams flow again (ms), over the last LAT_RING. */
  ackP50Ms: number
  ackP95Ms: number
  ackMaxMs: number
  /** Service restarts (open sessions ended). */
  restarts: number
}

export class Economy {
  private readonly keys = new Map<string, { at: number; value: unknown }>()
  private readonly escrow = new Map<number, number>()
  private readonly lat = new Float64Array(LAT_RING)
  private latN = 0
  private latMax = 0
  private readonly counts = { transfers: 0, replays: 0, pending: 0, restarts: 0 }
  /** SVC_BUS: idempotency keys kept (off: every call runs, the path before P2). */
  idempotent = false
  /** What a restart ends (the trade sessions; set by Gameplay). */
  onRestart: (() => number) | null = null

  constructor(private readonly store: Store) {}

  /** Whether character `id` is inside a transfer that is not committed yet. */
  inEscrow(id: number): boolean {
    return this.escrow.has(id)
  }

  /**
   * Runs one transfer between `parties`: `run` makes the database transaction (synchronously, e.g. pairTx) and may
   * send its results to the parties; they reach the clients once the transaction is on disk. `key`: the transfer's
   * idempotency key (a trade session id, a stall purchase).
   */
  transfer<T>(key: string, parties: readonly Player[], run: () => T): T {
    if (this.idempotent) {
      const seen = this.keys.get(key)
      if (seen) {
        this.counts.replays++
        return seen.value as T
      }
    }
    const t0 = performance.now()
    const releases = this.store.writer ? parties.map((p) => holdOutbound(p)) : []
    for (const p of parties) this.escrow.set(p.characterId, (this.escrow.get(p.characterId) ?? 0) + 1)
    this.counts.transfers++
    this.counts.pending++
    let value: T
    try {
      value = run()
    } finally {
      this.store.afterCommit(() => {
        this.counts.pending--
        for (const p of parties) {
          const n = (this.escrow.get(p.characterId) ?? 1) - 1
          if (n > 0) this.escrow.set(p.characterId, n)
          else this.escrow.delete(p.characterId)
        }
        for (const r of releases) r()
        const ms = performance.now() - t0
        this.lat[this.latN++ % LAT_RING] = ms
        if (ms > this.latMax) this.latMax = ms
      })
    }
    if (this.idempotent) this.remember(key, value)
    return value
  }

  private remember(key: string, value: unknown): void {
    const now = Date.now()
    this.keys.set(key, { at: now, value })
    if (this.keys.size > KEY_MAX) {
      for (const [k, v] of this.keys) {
        if (this.keys.size <= KEY_MAX / 2 && now - v.at < KEY_TTL_MS) break
        this.keys.delete(k)
      }
    }
  }

  /**
   * A crash of the service (docs/SERVER_ARCHITECTURE.md §3.10 "Service crash"): open sessions end (`onRestart`), the
   * idempotency keys are forgotten. Transfers already in the store complete (their commit releases their escrow), so
   * nothing a party was told can be undone and nothing half-done remains. Returns the sessions ended.
   */
  restart(): number {
    this.counts.restarts++
    this.keys.clear()
    return this.onRestart?.() ?? 0
  }

  stats(): EconomyStats {
    const k = Math.min(this.latN, LAT_RING)
    const s = Array.from(this.lat.subarray(0, k)).sort((a, b) => a - b)
    const pct = (q: number) => (k ? Math.round(s[Math.min(k - 1, Math.floor(q * k))]! * 100) / 100 : 0)
    return {
      transfers: this.counts.transfers,
      replays: this.counts.replays,
      pending: this.counts.pending,
      escrowed: this.escrow.size,
      ackP50Ms: pct(0.5),
      ackP95Ms: pct(0.95),
      ackMaxMs: Math.round(this.latMax * 100) / 100,
      restarts: this.counts.restarts,
    }
  }

  resetStats(): void {
    this.latN = 0
    this.latMax = 0
  }
}
