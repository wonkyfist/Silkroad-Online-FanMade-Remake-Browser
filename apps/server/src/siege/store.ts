import type Database from 'better-sqlite3'
import type { WallStage } from '@sro/shared'

/**
 * Siege of Jangan, the walls' SQL (migration 17, docs/SIEGE.md §5.3, §10.3): one row per segment and world
 * (`wall_segments`) and the damage / repair log (`wall_log`).
 */

export interface WallRow {
  id: string
  ip: number
  stage: WallStage
  queued: number
  last_cause: string | null
  updated_at: number
}

export interface WallLogRow {
  seg: string
  at: number
  cause: string
  delta: number
  stage: WallStage
  character_id: number | null
  data: string
}

export class WallStore {
  private readonly q

  constructor(db: Database.Database, private readonly world: string) {
    this.q = {
      all: db.prepare<[string], WallRow>('SELECT id, ip, stage, queued, last_cause, updated_at FROM wall_segments WHERE world = ?'),
      put: db.prepare(
        `INSERT INTO wall_segments (world, id, ip, stage, queued, last_cause, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (world, id) DO UPDATE SET ip = excluded.ip, stage = excluded.stage, queued = excluded.queued,
         last_cause = excluded.last_cause, updated_at = excluded.updated_at`,
      ),
      log: db.prepare('INSERT INTO wall_log (world, seg, at, cause, delta, stage, character_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      recent: db.prepare<[string, string, number], WallLogRow>('SELECT seg, at, cause, delta, stage, character_id, data FROM wall_log WHERE world = ? AND seg = ? ORDER BY id DESC LIMIT ?'),
    }
  }

  load(): WallRow[] {
    return this.q.all.all(this.world)
  }

  save(r: WallRow): void {
    this.q.put.run(this.world, r.id, r.ip, r.stage, r.queued, r.last_cause, r.updated_at)
  }

  log(seg: string, at: number, cause: string, delta: number, stage: WallStage, characterId: number | null = null, data: Record<string, unknown> = {}): void {
    this.q.log.run(this.world, seg, at, cause, delta, stage, characterId, JSON.stringify(data))
  }

  /** The newest log rows of a segment (GM status). */
  recent(seg: string, n = 5): WallLogRow[] {
    return this.q.recent.all(this.world, seg, n)
  }
}
