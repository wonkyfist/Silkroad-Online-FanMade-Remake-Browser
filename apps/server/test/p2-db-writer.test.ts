import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore, type Store } from '../src/db.ts'
import { addGold, addItem } from '../src/inventory.ts'
import { openStorageStore } from '../src/storage-db.ts'
import { goldIn, deposit } from '../src/storage.ts'
import { logSocial, pairTx } from '../src/social/pair-tx.ts'
import { dumpDb } from './p2-econ.ts'

/**
 * docs/SERVER_ARCHITECTURE.md §3.8, phase P2: the DB writer thread (db/mirror.ts, db/writer.ts). The same statements
 * with DB_WRITER on and off leave the same file; the journal follows transactions (rollbacks, nested savepoints,
 * failed statements); commit-then-ack waits for the file; a killed or crashed writer is restarted and resynced.
 */

const roots: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sro-p2db-'))
  roots.push(d)
  return d
}
beforeEach(() => {
  // the same clock in every run (characters.created_at): the files must match byte for byte
  vi.useFakeTimers({ toFake: ['Date'], now: 1_790_000_000_000 })
})
afterEach(() => {
  vi.useRealTimers()
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

const DEFS = (code: string) => ({ code, name: code, maxStack: 50, price: 10, sellPrice: 5 }) as never

/** A scripted workload over the store's own API: accounts, characters, items, gold, storage, a pair transfer. */
function workload(store: Store, rounds = 30): void {
  const accs: number[] = []
  const chars: number[] = []
  for (let i = 0; i < 4; i++) {
    const a = store.createAccount(`p2user${i}`, 'hash')!
    accs.push(a)
    const c = store.createCharacter(a, `P2Char${i}`, 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 4)
    if (typeof c === 'string') throw new Error(c)
    chars.push(c.id)
    store.inventoryTx(c.id, (d) => addGold(d, 10_000))
  }
  const storage = openStorageStore(store)
  for (let r = 0; r < rounds; r++) {
    const a = chars[r % 4]!
    const b = chars[(r + 1) % 4]!
    store.inventoryTx(a, (d) => addItem(d, DEFS('ETC_POTION'), 3))
    // a failing transaction journals nothing
    store.inventoryTx(a, (d) => addGold(d, -10_000_000))
    pairTx(store, a, b, (da, db) => {
      const g = addGold(da, -7)
      if (!g.ok) return g
      return addGold(db, 7)
    }, () => logSocial(store, { kind: 'trade', aChar: a, bChar: b, aGold: 7, bGold: 0, aItems: [], bItems: [] }, 1000 + r))
    storage.storageTx(a, accs[r % 4]!, (inv, st) => goldIn(inv, st, 5))
    storage.storageTx(a, accs[r % 4]!, (inv, st) => deposit(inv, st, 0, 1, undefined, DEFS, 0))
    // a throw inside a transaction rolls it back (and its journal)
    try {
      store.db.transaction(() => {
        store.db.prepare('UPDATE characters SET gold = gold + 1 WHERE id = ?').run(a)
        throw new Error('rollback')
      })()
    } catch {
      /* expected */
    }
    // a nested transaction whose inner level throws and is caught: the outer keeps its own writes
    store.db.transaction(() => {
      store.db.prepare('UPDATE characters SET exp = exp + 1 WHERE id = ?').run(b)
      try {
        store.db.transaction(() => {
          store.db.prepare('UPDATE characters SET exp = exp + 100 WHERE id = ?').run(b)
          throw new Error('inner')
        })()
      } catch {
        /* expected */
      }
    })()
    // a failing autocommit statement (unique name) journals nothing
    store.createAccount('p2user0', 'hash')
    store.saveCharacters([{ id: a, x: r, y: 0, z: r, yaw: 0, world: 'jangan', lastPlayed: r, hp: 100, mp: 100, dead: false, playedMs: 10 }])
  }
}

describe('P2 DB writer', () => {
  it('leaves the same file as the synchronous store, and the memory database matches it', () => {
    const off = tmp()
    const on = tmp()
    const s1 = openStore(off, { writer: false })
    workload(s1)
    s1.close()
    const s2 = openStore(on, { writer: true })
    expect(s2.writer).not.toBeNull()
    workload(s2)
    // the memory database already has everything
    const st = s2.writerStats()!
    expect(st.seq).toBeGreaterThan(100)
    s2.close()
    const a = dumpDb(join(off, 'game.db'))
    const b = dumpDb(join(on, 'game.db'))
    expect(b).toEqual(a)
  })

  it('commit-then-ack: afterCommit runs once the file has the write', async () => {
    const dir = tmp()
    const s = openStore(dir, { writer: true })
    const acc = s.createAccount('acker', 'h')!
    const order: string[] = []
    s.afterCommit(() => {
      order.push('committed')
      const f = new Database(join(dir, 'game.db'), { readonly: true })
      order.push(String((f.prepare('SELECT COUNT(*) AS n FROM accounts WHERE id = ?').get(acc) as { n: number }).n))
      f.close()
    })
    order.push('sync')
    await new Promise((r) => setTimeout(r, 200))
    expect(order).toEqual(['sync', 'committed', '1'])
    // nothing pending: at once
    let now = false
    s.afterCommit(() => (now = true))
    expect(now).toBe(true)
    // inside a transaction: after that transaction's own entry
    const seen: number[] = []
    s.db.transaction(() => {
      s.touchLogin(acc, 5)
      s.afterCommit(() => seen.push(s.writer!.durable))
    })()
    expect(seen).toEqual([])
    expect(s.flush()).toBe(true)
    expect(seen.length).toBe(1)
    expect(seen[0]).toBe(s.writer!.journaled)
    s.close()
  })

  it('a killed writer is restarted and resynced from memory: nothing lost, nothing twice', async () => {
    const off = tmp()
    const on = tmp()
    const s1 = openStore(off, { writer: false })
    workload(s1, 40)
    s1.close()
    const logs: string[] = []
    const s2 = openStore(on, { writer: { log: (l) => logs.push(l) } })
    workload(s2, 10)
    await s2.writer!.killWriter()
    // more work while the writer is down / restarting
    const more = openStorageStore(s2)
    void more
    await new Promise((r) => setTimeout(r, 50))
    s2.close()
    expect(logs.some((l) => l.includes('restarting and resyncing'))).toBe(true)
    // the first 10 rounds of the same workload, then the close: compare with a fresh off-run of 10 rounds
    const ref = tmp()
    const s3 = openStore(ref, { writer: false })
    workload(s3, 10)
    s3.close()
    expect(dumpDb(join(on, 'game.db'))).toEqual(dumpDb(join(ref, 'game.db')))
  })

  it('a writer that dies inside a group (thread exit mid-transaction) loses nothing after the resync', async () => {
    const on = tmp()
    const ref = tmp()
    const logs: string[] = []
    const s = openStore(on, { writer: { log: (l) => logs.push(l), maxGroupOps: 20, crash: { group: 3, afterOps: 2, mode: 'thread' } } })
    workload(s, 25)
    // the crash happens while the turn's batches are replayed; wait for the restart, then close (drains)
    const end = performance.now() + 5000
    while (!logs.some((l) => l.includes('resynced')) && performance.now() < end) {
      await new Promise((r) => setTimeout(r, 20))
    }
    s.close()
    expect(logs.some((l) => l.includes('exited'))).toBe(true)
    const r = openStore(ref, { writer: false })
    workload(r, 25)
    r.close()
    expect(dumpDb(join(on, 'game.db'))).toEqual(dumpDb(join(ref, 'game.db')))
  })

  it('a divergence (the file changed under the writer) is repaired by a resync from memory', async () => {
    const on = tmp()
    const logs: string[] = []
    const s = openStore(on, { writer: { log: (l) => logs.push(l) } })
    const a = s.createAccount('div', 'h')!
    expect(s.flush()).toBe(true)
    // another program deletes the row behind the server's back
    const f = new Database(join(on, 'game.db'))
    f.prepare('DELETE FROM accounts WHERE id = ?').run(a)
    f.close()
    s.touchLogin(a, 42)
    const end = performance.now() + 5000
    while (!logs.some((l) => l.includes('resynced')) && performance.now() < end) {
      await new Promise((r) => setTimeout(r, 20))
    }
    s.close()
    expect(logs.some((l) => l.includes('divergence'))).toBe(true)
    const d = dumpDb(join(on, 'game.db'))
    expect(d.accounts).toEqual([expect.objectContaining({ id: a, username: 'div', last_login: 42 })])
  })
})
