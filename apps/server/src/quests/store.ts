import type { QuestStatus } from '@sro/shared'
import type { Store } from '../db.ts'

/**
 * Quest persistence (docs/QUESTS.md §1.4; lane QS-S) on the migration-7 tables `quest_state`, `quest_done` and
 * `quest_items` (the SQL is inline in db.ts, like every migration). Statements run against `store.db.prepare`, like
 * skills/store.ts and storage-db.ts. This file imports db.ts types only, so db.ts never depends on it at load time.
 *
 * Quest items (QITEM_*) live only in `quest_items`: they belong to one active quest and vanish with it (decision 4).
 */

/** One stored active quest. */
export interface StoredQuest {
  quest: string
  status: QuestStatus
  /** QuestDef.rev the counts were made for. */
  rev: number
  /** Objective id -> count. */
  counts: Record<string, number>
  acceptedAt: number
}

export interface DoneRecord {
  times: number
  lastAt: number
}

export interface QuestSave {
  active: StoredQuest[]
  done: Map<string, DoneRecord>
  /** quest -> quest item code -> count. */
  items: Map<string, Map<string, number>>
}

/** Parses a stored counts column; anything unreadable is an empty record (counts are rebuilt from content anyway). */
export function parseCounts(text: string): Record<string, number> {
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
    const out: Record<string, number> = {}
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out[k] = n
    return out
  } catch {
    return {}
  }
}

export class QuestStore {
  private readonly q

  constructor(readonly store: Store) {
    const db = store.db
    this.q = {
      states: db.prepare<[number], { quest: string; status: QuestStatus; rev: number; counts: string; accepted_at: number }>(
        'SELECT quest, status, rev, counts, accepted_at FROM quest_state WHERE character_id = ? ORDER BY accepted_at, quest',
      ),
      done: db.prepare<[number], { quest: string; times: number; last_at: number }>('SELECT quest, times, last_at FROM quest_done WHERE character_id = ?'),
      items: db.prepare<[number], { quest: string; code: string; count: number }>('SELECT quest, code, count FROM quest_items WHERE character_id = ?'),
      insertState: db.prepare<[number, string, QuestStatus, number, string, number]>(
        'INSERT INTO quest_state (character_id, quest, status, rev, counts, accepted_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      saveState: db.prepare<[QuestStatus, number, string, number, string]>(
        'UPDATE quest_state SET status = ?, rev = ?, counts = ? WHERE character_id = ? AND quest = ?',
      ),
      deleteState: db.prepare<[number, string]>('DELETE FROM quest_state WHERE character_id = ? AND quest = ?'),
      setItem: db.prepare<[number, string, string, number]>(
        'INSERT INTO quest_items (character_id, quest, code, count) VALUES (?, ?, ?, ?) ON CONFLICT (character_id, quest, code) DO UPDATE SET count = excluded.count',
      ),
      deleteItem: db.prepare<[number, string, string]>('DELETE FROM quest_items WHERE character_id = ? AND quest = ? AND code = ?'),
      deleteItems: db.prepare<[number, string]>('DELETE FROM quest_items WHERE character_id = ? AND quest = ?'),
      upsertDone: db.prepare<[number, string, number]>(
        'INSERT INTO quest_done (character_id, quest, times, last_at) VALUES (?, ?, 1, ?) ON CONFLICT (character_id, quest) DO UPDATE SET times = times + 1, last_at = excluded.last_at',
      ),
      deleteDone: db.prepare<[number, string]>('DELETE FROM quest_done WHERE character_id = ? AND quest = ?'),
    }
  }

  /** The character's quest log: active states, completions and the quest bag. */
  load(characterId: number): QuestSave {
    const active = this.q.states.all(characterId).map((r) => ({ quest: r.quest, status: r.status, rev: r.rev, counts: parseCounts(r.counts), acceptedAt: r.accepted_at }))
    const done = new Map<string, DoneRecord>()
    for (const r of this.q.done.all(characterId)) done.set(r.quest, { times: r.times, lastAt: r.last_at })
    const items = new Map<string, Map<string, number>>()
    for (const r of this.q.items.all(characterId)) {
      let bag = items.get(r.quest)
      if (!bag) items.set(r.quest, (bag = new Map()))
      bag.set(r.code, r.count)
    }
    return { active, done, items }
  }

  /** A new active quest with its accept grants (replacing any leftover state of the same quest), in one transaction. */
  accept(characterId: number, s: StoredQuest, items: ReadonlyMap<string, number>): void {
    this.store.db.transaction(() => {
      this.q.deleteState.run(characterId, s.quest)
      this.q.deleteItems.run(characterId, s.quest)
      this.q.insertState.run(characterId, s.quest, s.status, s.rev, JSON.stringify(s.counts), s.acceptedAt)
      for (const [code, n] of items) if (n > 0) this.q.setItem.run(characterId, s.quest, code, n)
    })()
  }

  /** Counts, status and rev of an active quest (one small UPDATE; the tick loop is single-threaded). */
  saveCounts(characterId: number, quest: string, counts: Record<string, number>, status: QuestStatus, rev: number): void {
    this.q.saveState.run(status, rev, JSON.stringify(counts), characterId, quest)
  }

  /** Sets the count of one quest item of an active quest (0 removes it). */
  setItem(characterId: number, quest: string, code: string, count: number): void {
    if (count > 0) this.q.setItem.run(characterId, quest, code, count)
    else this.q.deleteItem.run(characterId, quest, code)
  }

  /** Counts and quest items of an active quest together (a hand-in, a quest item used, a content re-map). */
  saveQuest(characterId: number, quest: string, counts: Record<string, number>, status: QuestStatus, rev: number, items: ReadonlyMap<string, number>): void {
    this.store.db.transaction(() => {
      this.q.saveState.run(status, rev, JSON.stringify(counts), characterId, quest)
      this.q.deleteItems.run(characterId, quest)
      for (const [code, n] of items) if (n > 0) this.q.setItem.run(characterId, quest, code, n)
    })()
  }

  /** Abandon: the state and the quest's quest items go. */
  removeQuest(characterId: number, quest: string): void {
    this.store.db.transaction(() => {
      this.q.deleteState.run(characterId, quest)
      this.q.deleteItems.run(characterId, quest)
    })()
  }

  /**
   * The turn-in's database part: deletes the state and the quest items and records the completion (times + 1). No
   * transaction of its own: rewards.ts calls it inside `store.inventoryTx`'s `extra`.
   */
  turnIn(characterId: number, quest: string, now: number): void {
    this.q.deleteState.run(characterId, quest)
    this.q.deleteItems.run(characterId, quest)
    this.q.upsertDone.run(characterId, quest, now)
  }

  /** Forgets a completion (tests and GM tools; a quest can then be taken again). */
  forgetDone(characterId: number, quest: string): void {
    this.q.deleteDone.run(characterId, quest)
  }
}
