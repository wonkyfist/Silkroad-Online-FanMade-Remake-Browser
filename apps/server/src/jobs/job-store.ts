import type Database from 'better-sqlite3'
import type { JobId, JobSide } from '@sro/shared'

/**
 * The job system's SQL (docs/JOBS.md §9.3; migrations 19 and 25): `char_jobs` (one row per character since layer 1: the
 * job, `job_exp`, `on_duty` = job mode; the Hunter's `rank` = job level − 1, `points` = captures, `revoked_until`),
 * `account_jobs` (one side per account, when it changed, when a character of the account last left a job) and
 * `job_settings` (the admin panel's sparse patch).
 */

export interface JobRow {
  character_id: number
  job: JobId
  rank: number
  points: number
  licensed_at: number
  revoked_until: number | null
  on_duty: number
  job_exp: number
}

export interface AccountJobRow {
  account_id: number
  side: JobSide
  side_changed_at: number
  left_at: number | null
}

const COLS = 'character_id, job, rank, points, licensed_at, revoked_until, on_duty, job_exp'

export class JobStore {
  private readonly q

  constructor(db: Database.Database) {
    this.q = {
      job: db.prepare<[number], JobRow>(`SELECT ${COLS} FROM char_jobs WHERE character_id = ? ORDER BY licensed_at LIMIT 1`),
      all: db.prepare<[], JobRow>(`SELECT ${COLS} FROM char_jobs ORDER BY job, job_exp DESC, character_id`),
      ofAccount: db.prepare<[number], { character_id: number; job: JobId }>(
        'SELECT j.character_id, j.job FROM char_jobs j JOIN characters c ON c.id = j.character_id WHERE c.account_id = ? AND c.deleted_at IS NULL',
      ),
      join: db.prepare<[number, string, number]>(
        `INSERT INTO char_jobs (character_id, job, rank, points, licensed_at, revoked_until, on_duty, job_exp) VALUES (?, ?, 0, 0, ?, NULL, 0, 0)`,
      ),
      leave: db.prepare<[number]>('DELETE FROM char_jobs WHERE character_id = ?'),
      mode: db.prepare<[number, number]>('UPDATE char_jobs SET on_duty = ? WHERE character_id = ?'),
      revoke: db.prepare<[number | null, number]>('UPDATE char_jobs SET revoked_until = ? WHERE character_id = ?'),
      exp: db.prepare<[number, number, number]>('UPDATE char_jobs SET job_exp = ?, rank = ? WHERE character_id = ?'),
      account: db.prepare<[number], AccountJobRow>('SELECT account_id, side, side_changed_at, left_at FROM account_jobs WHERE account_id = ?'),
      accounts: db.prepare<[], AccountJobRow>('SELECT account_id, side, side_changed_at, left_at FROM account_jobs ORDER BY account_id LIMIT 500'),
      putAccount: db.prepare<[number, string, number, number | null]>(
        `INSERT INTO account_jobs (account_id, side, side_changed_at, left_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET side = excluded.side, side_changed_at = excluded.side_changed_at, left_at = excluded.left_at`,
      ),
      settings: db.prepare<[string], { json: string; rev: number }>('SELECT json, rev FROM job_settings WHERE code = ?'),
      saveSettings: db.prepare<[string, string, number, number, number | null]>(
        `INSERT INTO job_settings (code, json, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (code) DO UPDATE SET json = excluded.json, rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ),
    }
  }

  /** The character's job (one per character). */
  job(characterId: number): JobRow | null {
    return this.q.job.get(characterId) ?? null
  }

  all(): JobRow[] {
    return this.q.all.all()
  }

  /** The jobs of an account's live characters. */
  jobsOfAccount(accountId: number): { character_id: number; job: JobId }[] {
    return this.q.ofAccount.all(accountId)
  }

  join(characterId: number, job: JobId, now: number): void {
    this.q.join.run(characterId, job, now)
  }

  /** Leaves the job: the row (level, EXP, captures, the suit) is gone. */
  leave(characterId: number): boolean {
    return this.q.leave.run(characterId).changes > 0
  }

  setMode(characterId: number, on: boolean): void {
    this.q.mode.run(on ? 1 : 0, characterId)
  }

  /** The licence revoked until `until` (null: restored); layer 7's admin action for every job. */
  setRevoked(characterId: number, until: number | null): void {
    this.q.revoke.run(until, characterId)
  }

  /** Job EXP and the rank column (the Hunter badge: job level − 1). */
  setExp(characterId: number, exp: number, rank: number): void {
    this.q.exp.run(Math.max(0, Math.round(exp)), rank, characterId)
  }

  account(accountId: number): AccountJobRow | null {
    return this.q.account.get(accountId) ?? null
  }

  accounts(): AccountJobRow[] {
    return this.q.accounts.all()
  }

  putAccount(r: AccountJobRow): void {
    this.q.putAccount.run(r.account_id, r.side, r.side_changed_at, r.left_at)
  }

  settingsOf(code: string): { json: string; rev: number } | undefined {
    return this.q.settings.get(code)
  }

  saveSettings(code: string, json: string, rev: number, now: number, by: number | null): void {
    this.q.saveSettings.run(code, json, rev, now, by)
  }
}
