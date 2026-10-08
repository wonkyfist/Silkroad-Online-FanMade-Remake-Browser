import type Database from 'better-sqlite3'

/**
 * The trade's SQL (docs/JOBS.md §9.3; migration 26): `market` (per trade point and good: the post's demand and the
 * source's buy multiplier as of `updated_at`), `market_account_day` (how far an account's sells moved demand that UTC
 * day), `transports` (one live or saved transport per character), `trade_log` (buys, sales, losses).
 */

export interface MarketDbRow {
  post: string
  good: string
  demand: number
  buy_mul: number
  updated_at: number
}

export interface TransportRow {
  character_id: number
  tier: number
  code: string
  hp: number
  hold: string
  dest: string | null
  origin: string | null
  stars: number
  x: number
  y: number
  z: number
  saved_at: number
}

/** Layer 7 adds `caravan` (a Silk Caravan run reward, docs/JOBS.md §8). Layer 4 adds: `stolen` (a Thief picked goods), `turnin` (a Hunter's recovery reward at Yun), `confiscated` (a capture). */
export type TradeLogKind = 'buy' | 'sell' | 'lost' | 'robbed' | 'recovered' | 'den' | 'summon' | 'stolen' | 'turnin' | 'confiscated' | 'caravan'

export interface TradeLogRow {
  id: number
  at: number
  character_id: number
  account_id: number | null
  kind: TradeLogKind
  post: string | null
  good: string | null
  crates: number
  gold: number
  stars: number
}

export class TradeStore {
  private readonly q

  constructor(db: Database.Database) {
    this.q = {
      markets: db.prepare<[], MarketDbRow>('SELECT post, good, demand, buy_mul, updated_at FROM market'),
      putMarket: db.prepare<[string, string, number, number, number]>(
        `INSERT INTO market (post, good, demand, buy_mul, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (post, good) DO UPDATE SET demand = excluded.demand, buy_mul = excluded.buy_mul, updated_at = excluded.updated_at`,
      ),
      clearMarket: db.prepare('DELETE FROM market'),
      moved: db.prepare<[number, number], { moved: number }>('SELECT moved FROM market_account_day WHERE account_id = ? AND day = ?'),
      addMoved: db.prepare<[number, number, number]>(
        `INSERT INTO market_account_day (account_id, day, moved) VALUES (?, ?, ?)
         ON CONFLICT (account_id, day) DO UPDATE SET moved = moved + excluded.moved`,
      ),
      pruneMoved: db.prepare<[number]>('DELETE FROM market_account_day WHERE day < ?'),
      transport: db.prepare<[number], TransportRow>('SELECT * FROM transports WHERE character_id = ?'),
      transports: db.prepare<[], TransportRow>('SELECT * FROM transports ORDER BY saved_at DESC LIMIT 500'),
      putTransport: db.prepare<[number, number, string, number, string, string | null, string | null, number, number, number, number, number]>(
        `INSERT INTO transports (character_id, tier, code, hp, hold, dest, origin, stars, x, y, z, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (character_id) DO UPDATE SET tier = excluded.tier, code = excluded.code, hp = excluded.hp, hold = excluded.hold,
           dest = excluded.dest, origin = excluded.origin, stars = excluded.stars, x = excluded.x, y = excluded.y, z = excluded.z, saved_at = excluded.saved_at`,
      ),
      delTransport: db.prepare<[number]>('DELETE FROM transports WHERE character_id = ?'),
      log: db.prepare<[number, number, number | null, string, string | null, string | null, number, number, number]>(
        'INSERT INTO trade_log (at, character_id, account_id, kind, post, good, crates, gold, stars) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      boughtSince: db.prepare<[number, number], { n: number | null }>("SELECT SUM(crates) AS n FROM trade_log WHERE account_id = ? AND kind = 'buy' AND at >= ?"),
      goldSince: db.prepare<[number, string, number], { n: number | null }>('SELECT SUM(gold) AS n FROM trade_log WHERE account_id = ? AND kind = ? AND at >= ?'),
      recent: db.prepare<[number], TradeLogRow>('SELECT * FROM trade_log ORDER BY id DESC LIMIT ?'),
    }
  }

  markets(): MarketDbRow[] {
    return this.q.markets.all()
  }

  putMarket(r: MarketDbRow): void {
    this.q.putMarket.run(r.post, r.good, r.demand, r.buy_mul, r.updated_at)
  }

  clearMarket(): void {
    this.q.clearMarket.run()
  }

  /** How far the account's sells moved demand on `day` (UTC day number). */
  moved(accountId: number, day: number): number {
    return this.q.moved.get(accountId, day)?.moved ?? 0
  }

  addMoved(accountId: number, day: number, moved: number): void {
    if (moved > 0) this.q.addMoved.run(accountId, day, moved)
    this.q.pruneMoved.run(day - 7)
  }

  transport(characterId: number): TransportRow | null {
    return this.q.transport.get(characterId) ?? null
  }

  transports(): TransportRow[] {
    return this.q.transports.all()
  }

  putTransport(r: TransportRow): void {
    this.q.putTransport.run(r.character_id, r.tier, r.code, Math.max(1, Math.round(r.hp)), r.hold, r.dest, r.origin, r.stars, r.x, r.y, r.z, r.saved_at)
  }

  deleteTransport(characterId: number): void {
    this.q.delTransport.run(characterId)
  }

  log(r: Omit<TradeLogRow, 'id'>): void {
    this.q.log.run(r.at, r.character_id, r.account_id, r.kind, r.post, r.good, Math.round(r.crates), Math.round(r.gold), r.stars)
  }

  /** Crates the account bought since `since` (the hourly buy cap). */
  boughtSince(accountId: number, since: number): number {
    return this.q.boughtSince.get(accountId, since)?.n ?? 0
  }

  /** Gold of the account's `kind` rows since `since` (the Hunters' daily cap counts turn-ins). */
  goldSince(accountId: number, kind: TradeLogKind, since: number): number {
    return this.q.goldSince.get(accountId, kind, since)?.n ?? 0
  }

  recent(limit: number): TradeLogRow[] {
    return this.q.recent.all(limit)
  }
}
