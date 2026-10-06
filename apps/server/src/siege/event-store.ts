import type Database from 'better-sqlite3'

/**
 * Siege of Jangan, layer 4: the siege's SQL (migration 18, docs/SIEGE.md §10.3): one row per siege (`siege_events`),
 * its timeline (`siege_log`), the defenders' points and pay (`siege_contrib`), and the admin panel's settings patch
 * (`siege_settings`).
 */

export interface SiegeEventRow {
  id: number
  origin: string
  phase: string
  created_at: number
  wave1_at: number | null
  ended_at: number | null
  outcome: string | null
  approaches: string
  defenders: number
  breaches: number
  stats: string
}

export interface SiegeLogRow {
  at: number
  kind: string
  data: string
}

export interface SiegeContribRow {
  character_id: number
  points: number
  gold: number
  seals: number
}

export type SiegeEventPatchRow = Partial<Pick<SiegeEventRow, 'phase' | 'wave1_at' | 'ended_at' | 'outcome' | 'approaches' | 'defenders' | 'breaches' | 'stats'>>

const COLS = 'id, origin, phase, created_at, wave1_at, ended_at, outcome, approaches, defenders, breaches, stats'

export class SiegeStore {
  private readonly q

  constructor(private readonly db: Database.Database) {
    this.q = {
      create: db.prepare<[string, string, number, number | null, string, string]>('INSERT INTO siege_events (origin, phase, created_at, wave1_at, approaches, stats) VALUES (?, ?, ?, ?, ?, ?)'),
      get: db.prepare<[number], SiegeEventRow>(`SELECT ${COLS} FROM siege_events WHERE id = ?`),
      open: db.prepare<[], SiegeEventRow>(`SELECT ${COLS} FROM siege_events WHERE phase != 'ended' ORDER BY id`),
      list: db.prepare<[number, number], SiegeEventRow>(`SELECT ${COLS} FROM siege_events WHERE id < ? ORDER BY id DESC LIMIT ?`),
      since: db.prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM siege_events WHERE created_at >= ?'),
      log: db.prepare<[number, number, string, string]>('INSERT INTO siege_log (event_id, at, kind, data) VALUES (?, ?, ?, ?)'),
      logOf: db.prepare<[number], SiegeLogRow>('SELECT at, kind, data FROM siege_log WHERE event_id = ? ORDER BY id'),
      contrib: db.prepare<[number, number, number, number, number]>(
        `INSERT INTO siege_contrib (event_id, character_id, points, gold, seals) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (event_id, character_id) DO UPDATE SET points = excluded.points, gold = excluded.gold, seals = excluded.seals`,
      ),
      contribOf: db.prepare<[number], SiegeContribRow>('SELECT character_id, points, gold, seals FROM siege_contrib WHERE event_id = ? ORDER BY points DESC'),
      settings: db.prepare<[string], { json: string; rev: number }>('SELECT json, rev FROM siege_settings WHERE code = ?'),
      saveSettings: db.prepare<[string, string, number, number, number | null]>(
        `INSERT INTO siege_settings (code, json, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (code) DO UPDATE SET json = excluded.json, rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ),
      honor: db.prepare<[number, string, number]>('INSERT OR IGNORE INTO pilot_honors (character_id, code, at) VALUES (?, ?, ?)'),
    }
  }

  create(origin: string, phase: string, now: number, wave1At: number | null, approaches: string[], stats: Record<string, unknown> = {}): number {
    return Number(this.q.create.run(origin, phase, now, wave1At, JSON.stringify(approaches), JSON.stringify(stats)).lastInsertRowid)
  }

  get(id: number): SiegeEventRow | undefined {
    return this.q.get.get(id)
  }

  /** Rows not ended (a restart finds them). */
  open(): SiegeEventRow[] {
    return this.q.open.all()
  }

  list(before = Number.MAX_SAFE_INTEGER, limit = 50): SiegeEventRow[] {
    return this.q.list.all(before, limit)
  }

  createdSince(at: number): number {
    return this.q.since.get(at)?.n ?? 0
  }

  update(id: number, p: SiegeEventPatchRow): void {
    const keys = Object.keys(p) as (keyof SiegeEventPatchRow)[]
    if (!keys.length) return
    this.db.prepare(`UPDATE siege_events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => p[k] ?? null), id)
  }

  log(id: number, kind: string, data: Record<string, unknown>, now: number): void {
    this.q.log.run(id, now, kind, JSON.stringify(data))
  }

  logOf(id: number): SiegeLogRow[] {
    return this.q.logOf.all(id)
  }

  saveContrib(id: number, characterId: number, points: number, gold: number, seals: number): void {
    this.q.contrib.run(id, characterId, points, gold, seals)
  }

  contribOf(id: number): SiegeContribRow[] {
    return this.q.contribOf.all(id)
  }

  settingsOf(code: string): { json: string; rev: number } | undefined {
    return this.q.settings.get(code)
  }

  saveSettings(code: string, json: string, rev: number, now: number, by: number | null): void {
    this.q.saveSettings.run(code, json, rev, now, by)
  }

  /** The title in the shared titles table (migration 13's pilot_honors). True when newly granted. */
  grantHonor(characterId: number, code: string, now: number): boolean {
    return this.q.honor.run(characterId, code, now).changes > 0
  }
}
