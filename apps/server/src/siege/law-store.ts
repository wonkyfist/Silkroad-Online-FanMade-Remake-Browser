import type Database from 'better-sqlite3'
import type { OffenceRecord, WarrantRole, WarrantStatus } from '@sro/shared'

/**
 * Siege of Jangan, layer 5: the law's SQL (migration 19, docs/SIEGE.md §10.3): warrants (one per Wanted character and
 * breach) and law_records (per account: the offence level, the last offence, the last Thunder Keg planted). The keg
 * hits that make accomplices are read back from wall_log (cause `keg`, migration 17) after a restart.
 */

export interface WarrantRow {
  id: number
  account_id: number
  character_id: number
  reason: string
  role: WarrantRole
  wall: string | null
  offence: number
  bounty: number
  treason: number
  issued_at: number
  online_ms_left: number
  status: WarrantStatus
  closed_at: number | null
  captors: string
}

export interface NewWarrant {
  account: number
  character: number
  reason: 'wall'
  role: WarrantRole
  wall: string | null
  offence: number
  bounty: number
  treason: boolean
  issuedAt: number
  onlineMsLeft: number
}

const COLS = 'id, account_id, character_id, reason, role, wall, offence, bounty, treason, issued_at, online_ms_left, status, closed_at, captors'

export class LawStore {
  private readonly q

  constructor(private readonly db: Database.Database) {
    this.q = {
      issue: db.prepare<[number, number, string, string, string | null, number, number, number, number, number]>(
        `INSERT INTO warrants (account_id, character_id, reason, role, wall, offence, bounty, treason, issued_at, online_ms_left, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      ),
      openOf: db.prepare<[number], WarrantRow>(`SELECT ${COLS} FROM warrants WHERE status = 'open' AND character_id = ? ORDER BY id`),
      allOpen: db.prepare<[], WarrantRow>(`SELECT ${COLS} FROM warrants WHERE status = 'open' ORDER BY id`),
      recent: db.prepare<[number], WarrantRow>(`SELECT ${COLS} FROM warrants ORDER BY id DESC LIMIT ?`),
      ofCharacter: db.prepare<[number, number], WarrantRow>(`SELECT ${COLS} FROM warrants WHERE character_id = ? ORDER BY id DESC LIMIT ?`),
      left: db.prepare<[number, number]>('UPDATE warrants SET online_ms_left = ? WHERE id = ?'),
      close: db.prepare<[string, number, string, number, number]>("UPDATE warrants SET status = ?, closed_at = ?, captors = ?, online_ms_left = ? WHERE id = ? AND status = 'open'"),
      record: db.prepare<[number], { offences: number; last_offence_at: number | null; last_plant_at: number | null }>('SELECT offences, last_offence_at, last_plant_at FROM law_records WHERE account_id = ?'),
      saveRecord: db.prepare<[number, number, number | null]>(
        `INSERT INTO law_records (account_id, offences, last_offence_at) VALUES (?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET offences = excluded.offences, last_offence_at = excluded.last_offence_at`,
      ),
      plant: db.prepare<[number, number | null]>(
        `INSERT INTO law_records (account_id, offences, last_plant_at) VALUES (?, 0, ?)
         ON CONFLICT (account_id) DO UPDATE SET last_plant_at = excluded.last_plant_at`,
      ),
      kegHits: db.prepare<[string, number], { seg: string; at: number; character_id: number }>(
        "SELECT seg, at, character_id FROM wall_log WHERE world = ? AND cause = 'keg' AND character_id IS NOT NULL AND at >= ? ORDER BY id",
      ),
    }
  }

  issue(w: NewWarrant): number {
    return Number(this.q.issue.run(w.account, w.character, w.reason, w.role, w.wall, w.offence, w.bounty, w.treason ? 1 : 0, w.issuedAt, Math.max(0, Math.round(w.onlineMsLeft))).lastInsertRowid)
  }

  openOf(characterId: number): WarrantRow[] {
    return this.q.openOf.all(characterId)
  }

  allOpen(): WarrantRow[] {
    return this.q.allOpen.all()
  }

  recent(limit: number): WarrantRow[] {
    return this.q.recent.all(limit)
  }

  ofCharacter(characterId: number, limit: number): WarrantRow[] {
    return this.q.ofCharacter.all(characterId, limit)
  }

  saveLeft(id: number, leftMs: number): void {
    this.q.left.run(Math.max(0, Math.round(leftMs)), id)
  }

  /** Closes an open warrant; false when it was not open. */
  close(id: number, status: Exclude<WarrantStatus, 'open'>, at: number, leftMs: number, captors: unknown[] = []): boolean {
    return this.q.close.run(status, at, JSON.stringify(captors), Math.max(0, Math.round(leftMs)), id).changes > 0
  }

  record(accountId: number): (OffenceRecord & { lastPlantAt: number | null }) | null {
    const r = this.q.record.get(accountId)
    return r ? { offences: r.offences, lastAt: r.last_offence_at, lastPlantAt: r.last_plant_at } : null
  }

  saveRecord(accountId: number, rec: OffenceRecord): void {
    this.q.saveRecord.run(accountId, rec.offences, rec.lastAt)
  }

  setPlant(accountId: number, at: number | null): void {
    this.q.plant.run(accountId, at)
  }

  /** Keg hits on the walls since `since` (wall_log, cause `keg`). */
  kegHits(world: string, since: number): { seg: string; at: number; characterId: number }[] {
    try {
      return this.q.kegHits.all(world, since).map((r) => ({ seg: r.seg, at: r.at, characterId: r.character_id }))
    } catch {
      return []
    }
  }
}
