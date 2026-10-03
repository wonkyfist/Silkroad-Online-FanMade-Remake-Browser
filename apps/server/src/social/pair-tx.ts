import type { Store } from '../db.ts'
import { InvDraft, toStack, type InvItem, type Result } from '../inventory.ts'

/**
 * Two-character transaction (docs/SYSTEMS_SOCIAL.md §2.4; lane TR-S, used by ST-S for stall purchases).
 *
 * One SQLite transaction over two characters' inventories: loads both (store.loadInventory), lets `fn` change both
 * drafts, writes both (store.writeDraft) and runs `extra` (the social_log insert) only when fn succeeded. A throw
 * rolls everything back. better-sqlite3 is synchronous and the server is one process, so no other request runs in
 * between. Unlike store.inventoryTx, `extra` gets fn's value. `a === b` throws (a caller bug, never a player path).
 */
export function pairTx<T>(
  store: Store,
  a: number,
  b: number,
  fn: (da: InvDraft, db: InvDraft) => Result<T>,
  extra?: (value: T) => void,
): { result: Result<T>; da: InvDraft; db: InvDraft } {
  if (a === b) throw new Error(`pairTx: both sides are character ${a}`)
  const out = {} as { result: Result<T>; da: InvDraft; db: InvDraft }
  store.db.transaction(() => {
    out.da = new InvDraft(store.loadInventory(a))
    out.db = new InvDraft(store.loadInventory(b))
    out.result = fn(out.da, out.db)
    if (out.result.ok) {
      if (out.da.changed) store.writeDraft(a, out.da)
      if (out.db.changed) store.writeDraft(b, out.db)
      extra?.(out.result.value)
    }
  })()
  return out
}

/** One `social_log` row (docs/SYSTEMS_SOCIAL.md §7): a = trade requester / stall buyer, b = trade accepter / stall owner. */
export interface SocialLogRow {
  kind: 'trade' | 'stall'
  aChar: number
  bChar: number
  /** Gold each side gave. */
  aGold: number
  bGold: number
  /** What each side gave. */
  aItems: readonly InvItem[]
  bItems: readonly InvItem[]
}

type LogArgs = [at: number, kind: string, aChar: number, bChar: number, aGold: number, bGold: number, aItems: string, bItems: string]
const logStatements = new WeakMap<Store['db'], { run(...args: LogArgs): unknown }>()

/**
 * Writes one `social_log` row (GM audits; never read by gameplay). Call it from pairTx's `extra`, so the row is in the
 * same transaction as the swap: a failed or rolled-back commit leaves no row.
 */
export function logSocial(store: Store, row: SocialLogRow, at = Date.now()): void {
  let st = logStatements.get(store.db)
  if (!st) {
    st = store.db.prepare<LogArgs>('INSERT INTO social_log (at, kind, a_char, b_char, a_gold, b_gold, a_items, b_items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    logStatements.set(store.db, st)
  }
  st.run(at, row.kind, row.aChar, row.bChar, row.aGold, row.bGold, JSON.stringify(row.aItems.map(toStack)), JSON.stringify(row.bItems.map(toStack)))
}
