import type Database from 'better-sqlite3'
import type { SackKind } from '@sro/shared'

/**
 * The robbery's SQL (docs/JOBS.md §6.3, §6.4, §7; migration 27): `job_sacks` (goods carried outside a transport: stolen,
 * recovered, own) and `robbery_log` (robberies and Thief kills by Hunters, for the pair rules).
 */

export interface SackRow {
  kind: SackKind
  good: string
  crates: number
  cost: number
  owner_character: number
  owner_account: number | null
  batch: number
  mul: number
  picked_at: number
}

export class RobberyStore {
  private readonly q

  constructor(private readonly db: Database.Database) {
    this.q = {
      sack: db.prepare<[number], SackRow>('SELECT kind, good, crates, cost, owner_character, owner_account, batch, mul, picked_at FROM job_sacks WHERE character_id = ? ORDER BY id'),
      clear: db.prepare<[number]>('DELETE FROM job_sacks WHERE character_id = ?'),
      put: db.prepare<[number, string, string, number, number, number, number | null, number, number, number]>(
        'INSERT INTO job_sacks (character_id, kind, good, crates, cost, owner_character, owner_account, batch, mul, picked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      all: db.prepare<[number], SackRow & { character_id: number }>('SELECT character_id, kind, good, crates, cost, owner_character, owner_account, batch, mul, picked_at FROM job_sacks ORDER BY id DESC LIMIT ?'),
      log: db.prepare<[number, string, number, number | null, number, number | null, number]>(
        'INSERT INTO robbery_log (at, kind, actor_character, actor_account, victim_character, victim_account, batch) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      batches: db.prepare<[number, number, string, number, number], { n: number }>(
        'SELECT COUNT(DISTINCT batch) AS n FROM robbery_log WHERE actor_account = ? AND victim_account = ? AND kind = ? AND at >= ? AND batch <> ?',
      ),
      count: db.prepare<[number, number, string, number], { n: number }>('SELECT COUNT(*) AS n FROM robbery_log WHERE actor_account = ? AND victim_account = ? AND kind = ? AND at >= ?'),
      recent: db.prepare<[number], { id: number; at: number; kind: string; actor_character: number; actor_account: number | null; victim_character: number; victim_account: number | null; batch: number }>(
        'SELECT id, at, kind, actor_character, actor_account, victim_character, victim_account, batch FROM robbery_log ORDER BY id DESC LIMIT ?',
      ),
      seen: db.prepare<[number, number, number], { n: number }>("SELECT COUNT(*) AS n FROM robbery_log WHERE actor_account = ? AND batch = ? AND kind = 'rob' AND at >= ?"),
    }
  }

  sack(characterId: number): SackRow[] {
    return this.q.sack.all(characterId)
  }

  /** Rewrites a character's sack. */
  replace(characterId: number, rows: readonly SackRow[]): void {
    this.db.transaction(() => {
      this.q.clear.run(characterId)
      for (const r of rows) this.q.put.run(characterId, r.kind, r.good, Math.round(r.crates), Math.round(r.cost), r.owner_character, r.owner_account, r.batch, r.mul, r.picked_at)
    })()
  }

  all(limit: number): (SackRow & { character_id: number })[] {
    return this.q.all.all(limit)
  }

  log(at: number, kind: 'rob' | 'kill', actor: number, actorAccount: number | null, victim: number, victimAccount: number | null, batch: number): void {
    this.q.log.run(at, kind, actor, actorAccount, victim, victimAccount, batch)
  }

  /** Distinct robberies (batches other than `except`) of `victimAccount` by `actorAccount` since `since`. */
  priorRobberies(actorAccount: number, victimAccount: number, since: number, except: number): number {
    return this.q.batches.get(actorAccount, victimAccount, 'rob', since, except)?.n ?? 0
  }

  /** Whether this account already logged picking from robbery `batch` since `since`. */
  robbed(actorAccount: number, batch: number, since: number): boolean {
    return (this.q.seen.get(actorAccount, batch, since)?.n ?? 0) > 0
  }

  /** The latest robbery_log rows (layer 7's admin page). */
  recent(limit: number): { id: number; at: number; kind: string; actor_character: number; actor_account: number | null; victim_character: number; victim_account: number | null; batch: number }[] {
    return this.q.recent.all(limit)
  }

  kills(actorAccount: number, victimAccount: number, since: number): number {
    return this.q.count.get(actorAccount, victimAccount, 'kill', since)?.n ?? 0
  }
}
