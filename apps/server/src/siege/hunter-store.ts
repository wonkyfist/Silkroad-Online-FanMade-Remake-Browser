import type Database from 'better-sqlite3'

/**
 * Siege of Jangan, layer 6: the Hunters' and the jail's SQL over migration 19's tables (docs/SIEGE.md §10.3):
 * `char_jobs` (job `hunter`: the licence, `points` = captures, `revoked_until`, `on_duty`) and `jail_terms` (one row
 * per prisoner while the sentence runs; deleted at the release). The 7-day pair rule reads the captured warrants'
 * `captors` (JSON `[{character, account, gold, pair?}]`).
 */

export interface HunterRow {
  character_id: number
  rank: number
  points: number
  licensed_at: number
  revoked_until: number | null
  on_duty: number
}

export interface JailRow {
  character_id: number
  account_id: number
  warrant_id: number | null
  starts_at: number
  ends_at: number
  served_ms: number
  chores: number
}

export const HUNTER_JOB = 'hunter'

export class HunterStore {
  private readonly q

  constructor(private readonly db: Database.Database) {
    this.q = {
      hunter: db.prepare<[number], HunterRow>(`SELECT character_id, rank, points, licensed_at, revoked_until, on_duty FROM char_jobs WHERE character_id = ? AND job = '${HUNTER_JOB}'`),
      hunters: db.prepare<[], HunterRow>(`SELECT character_id, rank, points, licensed_at, revoked_until, on_duty FROM char_jobs WHERE job = '${HUNTER_JOB}' ORDER BY points DESC, character_id`),
      license: db.prepare<[number, number]>(
        `INSERT INTO char_jobs (character_id, job, rank, points, licensed_at, revoked_until, on_duty) VALUES (?, '${HUNTER_JOB}', 0, 0, ?, NULL, 0)
         ON CONFLICT (character_id, job) DO UPDATE SET revoked_until = NULL`,
      ),
      revoke: db.prepare<[number | null, number]>(`UPDATE char_jobs SET revoked_until = ?, on_duty = 0 WHERE character_id = ? AND job = '${HUNTER_JOB}'`),
      duty: db.prepare<[number, number]>(`UPDATE char_jobs SET on_duty = ? WHERE character_id = ? AND job = '${HUNTER_JOB}'`),
      capture: db.prepare<[number, number]>(`UPDATE char_jobs SET points = points + 1, rank = ? WHERE character_id = ? AND job = '${HUNTER_JOB}'`),
      term: db.prepare<[number], JailRow>('SELECT character_id, account_id, warrant_id, starts_at, ends_at, served_ms, chores FROM jail_terms WHERE character_id = ?'),
      terms: db.prepare<[], JailRow>('SELECT character_id, account_id, warrant_id, starts_at, ends_at, served_ms, chores FROM jail_terms ORDER BY ends_at'),
      putTerm: db.prepare<[number, number, number | null, number, number, number, number]>(
        `INSERT INTO jail_terms (character_id, account_id, warrant_id, starts_at, ends_at, served_ms, chores) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (character_id) DO UPDATE SET account_id = excluded.account_id, warrant_id = excluded.warrant_id, starts_at = excluded.starts_at,
           ends_at = excluded.ends_at, served_ms = excluded.served_ms, chores = excluded.chores`,
      ),
      saveTerm: db.prepare<[number, number, number, number]>('UPDATE jail_terms SET served_ms = ?, chores = ?, ends_at = ? WHERE character_id = ?'),
      dropTerm: db.prepare<[number]>('DELETE FROM jail_terms WHERE character_id = ?'),
      capturedOf: db.prepare<[number, number], { captors: string; closed_at: number }>(
        "SELECT captors, closed_at FROM warrants WHERE account_id = ? AND status = 'captured' AND closed_at >= ? ORDER BY id",
      ),
      capturedAll: db.prepare<[number], { captors: string; closed_at: number }>("SELECT captors, closed_at FROM warrants WHERE status = 'captured' AND closed_at >= ? ORDER BY id"),
      records: db.prepare<[], { account_id: number; offences: number; last_offence_at: number | null; last_plant_at: number | null }>(
        'SELECT account_id, offences, last_offence_at, last_plant_at FROM law_records WHERE offences > 0 OR last_plant_at IS NOT NULL ORDER BY last_offence_at DESC LIMIT 200',
      ),
    }
  }

  hunter(characterId: number): HunterRow | null {
    return this.q.hunter.get(characterId) ?? null
  }

  hunters(): HunterRow[] {
    return this.q.hunters.all()
  }

  /** Buys (or restores) the licence; captures and rank are kept. */
  license(characterId: number, now: number): void {
    this.q.license.run(characterId, now)
  }

  /** Revokes until `until` (null: restores), off duty. */
  revoke(characterId: number, until: number | null): void {
    this.q.revoke.run(until, characterId)
  }

  setDuty(characterId: number, on: boolean): void {
    this.q.duty.run(on ? 1 : 0, characterId)
  }

  /** One capture more; `rank` is the new rank. */
  addCapture(characterId: number, rank: number): void {
    this.q.capture.run(rank, characterId)
  }

  term(characterId: number): JailRow | null {
    return this.q.term.get(characterId) ?? null
  }

  terms(): JailRow[] {
    return this.q.terms.all()
  }

  putTerm(t: JailRow): void {
    this.q.putTerm.run(t.character_id, t.account_id, t.warrant_id, t.starts_at, t.ends_at, Math.max(0, Math.round(t.served_ms)), t.chores)
  }

  saveTerm(characterId: number, servedMs: number, chores: number, endsAt: number): void {
    this.q.saveTerm.run(Math.max(0, Math.round(servedMs)), chores, endsAt, characterId)
  }

  dropTerm(characterId: number): boolean {
    return this.q.dropTerm.run(characterId).changes > 0
  }

  /** The captured warrants of a Wanted account since `since`: their captors (character, account, gold). */
  capturesOf(accountId: number, since: number): Capture[] {
    return captures(this.q.capturedOf.all(accountId, since))
  }

  /** Every capture since `since` (all Wanted accounts; the daily bounty cap). */
  capturesSince(since: number): Capture[] {
    return captures(this.q.capturedAll.all(since))
  }

  /** The offence records (the admin's Law tab). */
  records(): { account_id: number; offences: number; last_offence_at: number | null; last_plant_at: number | null }[] {
    return this.q.records.all()
  }
}

/** A capture's captors as warrants.captors records them (layer 6: account, gold, credit, the withholding rule). */
export interface Captor {
  character: number
  account?: number | null
  gold: number
  pair?: boolean
  credit?: boolean
  rule?: string
}

export interface Capture {
  at: number
  captors: Captor[]
}

/** Captured warrants grouped into captures (the warrants of one capture close at the same instant). */
function captures(rows: { captors: string; closed_at: number }[]): Capture[] {
  const out: Capture[] = []
  for (const r of rows) {
    if (out.some((c) => c.at === r.closed_at)) continue
    out.push({ at: r.closed_at, captors: parseCaptors(r.captors) })
  }
  return out
}

function parseCaptors(s: string): Captor[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((c): c is Captor => typeof c === 'object' && c !== null && typeof (c as { character?: unknown }).character === 'number') : []
  } catch {
    return []
  }
}
