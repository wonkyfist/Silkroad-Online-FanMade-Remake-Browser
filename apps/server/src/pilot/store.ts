import type Database from 'better-sqlite3'

/**
 * Play the Boss persistence (docs/PLAY_THE_BOSS.md §5.3, §5.4; migrations 12, 13 and 14 in db.ts): the events, their
 * log and the titles; layer 4's settings patch, the volunteers of each call and the lottery blocks. Every phase change
 * writes the event row and a log line; downs and steered time are saved each minute too.
 */

export interface PilotEventRow {
  id: number
  code: string
  origin: string
  phase: string
  created_at: number
  call_ends_at: number | null
  hunt_started_at: number | null
  hunt_ends_at: number | null
  ended_at: number | null
  outcome: string | null
  pilot_account: number | null
  pilot_character: number | null
  pilot_name: string | null
  camp: number | null
  downs: number
  hunters: number
  steered_ms: number
  reward_gold: number
  refunded: number
  flags: string
  stats: string
}

export interface PilotLogRow {
  id: number
  event_id: number
  at: number
  kind: string
  data: string
}

export interface PilotVolunteerRow {
  event_id: number
  account_id: number
  character_id: number
  at: number
  draw: string | null
}

export interface PilotBlockRow {
  account_id: number
  until: number
  reason: string
  by_account: number | null
  at: number
}

export interface PilotSettingsRow {
  code: string
  json: string
  rev: number
  updated_at: number
  updated_by: number | null
}

/** The columns an update may set. */
export type PilotEventPatch = Partial<Omit<PilotEventRow, 'id' | 'code' | 'origin' | 'created_at'>>

const PATCH_KEYS: readonly (keyof PilotEventPatch)[] = [
  'phase', 'call_ends_at', 'hunt_started_at', 'hunt_ends_at', 'ended_at', 'outcome', 'pilot_account', 'pilot_character', 'pilot_name', 'camp',
  'downs', 'hunters', 'steered_ms', 'reward_gold', 'refunded', 'flags', 'stats',
]

/** A turn that counts for the lottery's cooldown and recent-events rules: a pilot steered her and it was not refunded. */
const COUNTED = 'pilot_account IS NOT NULL AND hunt_started_at IS NOT NULL AND refunded = 0'

export class PilotStore {
  private readonly q

  constructor(readonly db: Database.Database) {
    this.q = {
      insert: db.prepare<[string, string, string, number]>('INSERT INTO pilot_events (code, origin, phase, created_at) VALUES (?, ?, ?, ?)'),
      get: db.prepare<[number], PilotEventRow>('SELECT * FROM pilot_events WHERE id = ?'),
      open: db.prepare<[], PilotEventRow>("SELECT * FROM pilot_events WHERE phase != 'ended' ORDER BY id"),
      list: db.prepare<[number, number], PilotEventRow>('SELECT * FROM pilot_events WHERE id < ? ORDER BY id DESC LIMIT ?'),
      createdSince: db.prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM pilot_events WHERE created_at >= ?'),
      log: db.prepare<[number, number, string, string]>('INSERT INTO pilot_log (event_id, at, kind, data) VALUES (?, ?, ?, ?)'),
      logOf: db.prepare<[number], PilotLogRow>('SELECT * FROM pilot_log WHERE event_id = ? ORDER BY id'),
      honor: db.prepare<[number, string, number]>('INSERT OR IGNORE INTO pilot_honors (character_id, code, at) VALUES (?, ?, ?)'),
      honors: db.prepare<[number], { code: string; at: number }>(/* the worn title (characters.title, the Climb: docs/CLIMB.md §7.3) first, then the newest */ 'SELECT code, at FROM pilot_honors WHERE character_id = ? ORDER BY (code IS (SELECT title FROM characters WHERE id = pilot_honors.character_id)) DESC, at DESC'),
      // layer 4
      settings: db.prepare<[string], PilotSettingsRow>('SELECT * FROM pilot_settings WHERE code = ?'),
      putSettings: db.prepare<[string, string, number, number, number | null]>(
        'INSERT INTO pilot_settings (code, json, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET json = excluded.json, rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      ),
      volunteer: db.prepare<[number, number, number, number]>('INSERT OR IGNORE INTO pilot_volunteers (event_id, account_id, character_id, at) VALUES (?, ?, ?, ?)'),
      volunteerOf: db.prepare<[number, number], PilotVolunteerRow>('SELECT * FROM pilot_volunteers WHERE event_id = ? AND account_id = ?'),
      withdraw: db.prepare<[number, number, number]>('DELETE FROM pilot_volunteers WHERE event_id = ? AND account_id = ? AND character_id = ? AND draw IS NULL'),
      volunteers: db.prepare<[number], PilotVolunteerRow>('SELECT * FROM pilot_volunteers WHERE event_id = ? ORDER BY at, account_id'),
      volunteerCount: db.prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM pilot_volunteers WHERE event_id = ?'),
      setDraw: db.prepare<[string | null, number, number]>('UPDATE pilot_volunteers SET draw = ? WHERE event_id = ? AND account_id = ?'),
      resetOffered: db.prepare<[number]>("UPDATE pilot_volunteers SET draw = NULL WHERE event_id = ? AND draw = 'offered'"),
      blocks: db.prepare<[], PilotBlockRow>('SELECT * FROM pilot_blocks ORDER BY until DESC'),
      blockOf: db.prepare<[number], PilotBlockRow>('SELECT * FROM pilot_blocks WHERE account_id = ?'),
      block: db.prepare<[number, number, string, number | null, number]>(
        'INSERT INTO pilot_blocks (account_id, until, reason, by_account, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, by_account = excluded.by_account, at = excluded.at',
      ),
      unblock: db.prepare<[number]>('DELETE FROM pilot_blocks WHERE account_id = ?'),
      lastTurn: db.prepare<[number], { at: number | null }>(`SELECT MAX(hunt_started_at) AS at FROM pilot_events WHERE ${COUNTED} AND pilot_account = ?`),
      recentPilots: db.prepare<[number], { pilot_account: number }>(`SELECT pilot_account FROM pilot_events WHERE ${COUNTED} ORDER BY id DESC LIMIT ?`),
    }
  }

  /** A new event row; returns its id. */
  create(code: string, origin: string, phase: string, now: number): number {
    return Number(this.q.insert.run(code, origin, phase, now).lastInsertRowid)
  }

  update(id: number, patch: PilotEventPatch): void {
    const keys = PATCH_KEYS.filter((k) => patch[k] !== undefined)
    if (keys.length === 0) return
    this.db.prepare(`UPDATE pilot_events SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...Object.fromEntries(keys.map((k) => [k, patch[k]])), id })
  }

  get(id: number): PilotEventRow | undefined {
    return this.q.get.get(id)
  }

  /** Events that never ended (a restart during them). */
  open(): PilotEventRow[] {
    return this.q.open.all()
  }

  /** Newest first, ids below `before`. */
  list(before: number, limit: number): PilotEventRow[] {
    return this.q.list.all(before, limit)
  }

  /** How many events were created at or after `at` (the scheduler's "this night was handled"). */
  createdSince(at: number): number {
    return this.q.createdSince.get(at)?.n ?? 0
  }

  log(eventId: number, kind: string, data: Record<string, unknown>, now: number): void {
    this.q.log.run(eventId, now, kind, JSON.stringify(data))
  }

  logOf(eventId: number): PilotLogRow[] {
    return this.q.logOf.all(eventId)
  }

  /** Grants a title once; true when it is new. */
  grantHonor(characterId: number, code: string, now: number): boolean {
    return this.q.honor.run(characterId, code, now).changes > 0
  }

  /** The newest title of a character, or null. */
  honorOf(characterId: number): string | null {
    return this.q.honors.get(characterId)?.code ?? null
  }

  // ---- layer 4: settings ----------------------------------------------------------------------------------------

  settingsOf(code: string): PilotSettingsRow | undefined {
    return this.q.settings.get(code)
  }

  saveSettings(code: string, json: string, rev: number, now: number, by: number | null): void {
    this.q.putSettings.run(code, json, rev, now, by)
  }

  // ---- layer 4: volunteers -----------------------------------------------------------------------------------------

  /** One entry per account: 'added', 'same' (this character already), or 'other' (another character of the account). */
  volunteer(eventId: number, accountId: number, characterId: number, now: number): 'added' | 'same' | 'other' {
    if (this.q.volunteer.run(eventId, accountId, characterId, now).changes > 0) return 'added'
    return this.q.volunteerOf.get(eventId, accountId)?.character_id === characterId ? 'same' : 'other'
  }

  volunteerOf(eventId: number, accountId: number): PilotVolunteerRow | undefined {
    return this.q.volunteerOf.get(eventId, accountId)
  }

  /** Withdraws this character's entry (not yet drawn); true when there was one. */
  withdraw(eventId: number, accountId: number, characterId: number): boolean {
    return this.q.withdraw.run(eventId, accountId, characterId).changes > 0
  }

  volunteers(eventId: number): PilotVolunteerRow[] {
    return this.q.volunteers.all(eventId)
  }

  volunteerCount(eventId: number): number {
    return this.q.volunteerCount.get(eventId)?.n ?? 0
  }

  setDraw(eventId: number, accountId: number, draw: string | null): void {
    this.q.setDraw.run(draw, eventId, accountId)
  }

  /** Offers are not persisted (§2.4): after a restart, an open offer is drawable again. */
  resetOffered(eventId: number): void {
    this.q.resetOffered.run(eventId)
  }

  // ---- layer 4: blocks and past turns ------------------------------------------------------------------------------

  blocks(): PilotBlockRow[] {
    return this.q.blocks.all()
  }

  blockOf(accountId: number): PilotBlockRow | undefined {
    return this.q.blockOf.get(accountId)
  }

  block(accountId: number, until: number, reason: string, by: number | null, now: number): void {
    this.q.block.run(accountId, until, reason, by, now)
  }

  unblock(accountId: number): boolean {
    return this.q.unblock.run(accountId).changes > 0
  }

  /** When the account last steered her (hunt start of a counted turn), or null. */
  lastTurnAt(accountId: number): number | null {
    return this.q.lastTurn.get(accountId)?.at ?? null
  }

  /** The pilots' accounts of the last `n` counted turns. */
  recentPilots(n: number): Set<number> {
    return n > 0 ? new Set(this.q.recentPilots.all(n).map((r) => r.pilot_account)) : new Set()
  }
}
