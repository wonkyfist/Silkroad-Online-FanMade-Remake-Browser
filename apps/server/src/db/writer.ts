/**
 * The DB writer thread (docs/SERVER_ARCHITECTURE.md §3.8, phase P2; DB_WRITER=1): the only connection that writes
 * DATA_DIR/game.db. It replays the tick thread's journal (db/mirror.ts) in sequence order with group commit: every
 * entry that arrived while it was busy goes into one BEGIN IMMEDIATE … COMMIT (≤ maxGroupOps statements), so a crash
 * leaves the file at the end of a whole group — a prefix of the memory database's history, never half an entry.
 * After each commit it publishes the committed sequence (Atomics, for synchronous drains) and acks it.
 *
 * A replayed statement that fails or changes another number of rows than in memory is a divergence: the group is
 * rolled back, the tick thread is told, and it answers with a resync (a snapshot of the memory database that replaces
 * the file's rows in one transaction). Erasable TypeScript, loaded with Node's own type stripping.
 */
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { receiveMessageOnPort, workerData } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import Database from 'better-sqlite3'
import type { Envelope } from '../bus/transport.ts'
import type { Entry, Op, WriterAck, WriterBatch, WriterDiverged, WriterInit, WriterResync } from './protocol.ts'

const init = workerData as WriterInit
const port = init.port as MessagePort
const ctl = new BigInt64Array(init.ctl)

function openFile(): Database.Database {
  const d = new Database(init.file, { fileMustExist: true })
  d.pragma('journal_mode = WAL')
  d.pragma('synchronous = NORMAL')
  d.pragma('foreign_keys = ON')
  d.pragma('busy_timeout = 5000')
  return d
}

let db = openFile()
const sqls = new Map<number, string>()
const stmts = new Map<number, Database.Statement>()
let acc: Entry[] = []
/** After a divergence: batches are dropped until the resync arrives (the snapshot covers them). */
let awaitingResync = false
let groups = 0
let lastDataVersion = dataVersion()
let external = 0
let walAt = 0
let closed = false

function dataVersion(): number {
  return db.pragma('data_version', { simple: true }) as number
}

const threadCpu = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage
function cpuMs(): number | undefined {
  if (typeof threadCpu !== 'function') return undefined
  const t = threadCpu.call(process)
  return Math.round((t.user + t.system) / 1000)
}

function send(k: string, body: unknown): void {
  const e: Envelope = { to: 'zone:0', from: 'db', k, body }
  port.postMessage(e)
}

class Divergence extends Error {}

function stmt(id: number): Database.Statement {
  let st = stmts.get(id)
  if (!st) {
    const sql = sqls.get(id)
    if (sql === undefined) throw new Divergence(`unknown statement ${id}`)
    st = db.prepare(sql)
    stmts.set(id, st)
  }
  return st
}

function apply(op: Op): void {
  if (op[0] < 0) {
    db.exec(op[1] as string)
    return
  }
  const st = stmt(op[0])
  const params = op[1] as unknown[]
  if (st.reader) {
    st.all(...params)
    return
  }
  const r = st.run(...params)
  if (op[2] >= 0 && r.changes !== op[2]) throw new Divergence(`statement ${op[0]} changed ${r.changes} rows, ${op[2]} in memory: ${sqls.get(op[0])}`)
}

/** Test hook (WriterInit.crash): dies inside the first group from `group` on that reaches `afterOps` statements. */
function maybeCrash(group: number, ops: number): void {
  const c = init.crash
  if (!c || group < c.group || c.afterOps !== ops) return
  if (c.mode === 'process') process.kill(process.pid, 'SIGKILL')
  process.exit(1)
}

/** Commits every accumulated entry (several groups when they hold more than maxGroupOps statements). */
function commitAcc(): void {
  if (acc.length === 0 || closed) return
  const dv = dataVersion()
  if (dv !== lastDataVersion) {
    external++
    lastDataVersion = dv
  }
  let i = 0
  while (i < acc.length) {
    const t0 = performance.now()
    const start = i
    let ops = 0
    const group = groups + 1
    db.exec('BEGIN IMMEDIATE')
    try {
      for (; i < acc.length && (i === start || ops < init.maxGroupOps); i++) {
        for (const op of acc[i]!.ops) {
          apply(op)
          ops++
          maybeCrash(group, ops)
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      if (db.inTransaction) db.exec('ROLLBACK')
      const d: WriterDiverged = { seq: acc[Math.min(i, acc.length - 1)]!.s, error: (e as Error)?.message ?? String(e) }
      acc = []
      awaitingResync = true
      send('diverged', d)
      return
    }
    groups++
    const upTo = acc[i - 1]!.s
    let walBytes = -1
    const now = Date.now()
    if (now - walAt >= 1000) {
      walAt = now
      try {
        walBytes = statSync(`${init.file}-wal`).size
      } catch {
        walBytes = 0
      }
    }
    const ack: WriterAck = { upTo, entries: i - start, ops, groups, commitMs: performance.now() - t0, walBytes, external, cpuMs: walBytes >= 0 ? cpuMs() : undefined }
    external = 0
    // the ack first: a tick thread woken by the notify takes it from the port at once (flushSync)
    send('ack', ack)
    Atomics.store(ctl, 0, BigInt(upTo))
    Atomics.notify(ctl, 0)
  }
  acc = []
  lastDataVersion = dataVersion()
}

/**
 * Replaces every table's rows by the snapshot's (one transaction: a crash keeps the old content or the new, never a
 * mix). Tables the file lacks are created from the snapshot's schema first.
 */
function resync(snapshot: Uint8Array, seq: number): void {
  const t0 = performance.now()
  const tmp = `${init.file}.resync`
  writeFileSync(tmp, snapshot)
  db.pragma('foreign_keys = OFF')
  db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS snap`)
  try {
    const schema = db.prepare("SELECT type, name, sql FROM snap.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC").all() as { type: string; name: string; sql: string }[]
    const have = new Set((db.prepare('SELECT name FROM main.sqlite_master').all() as { name: string }[]).map((r) => r.name))
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const s of schema) if (!have.has(s.name) && (s.type === 'table' || s.type === 'index')) db.exec(s.sql)
      for (const s of schema) {
        if (s.type !== 'table') continue
        const q = `"${s.name.replace(/"/g, '""')}"`
        db.exec(`DELETE FROM main.${q}`)
        db.exec(`INSERT INTO main.${q} SELECT * FROM snap.${q}`)
      }
      if (db.prepare("SELECT 1 FROM snap.sqlite_master WHERE name = 'sqlite_sequence'").get()) {
        db.exec('DELETE FROM main.sqlite_sequence')
        db.exec('INSERT INTO main.sqlite_sequence SELECT * FROM snap.sqlite_sequence')
      }
      db.exec('COMMIT')
    } catch (e) {
      if (db.inTransaction) db.exec('ROLLBACK')
      throw e
    }
  } finally {
    db.exec('DETACH DATABASE snap')
    db.pragma('foreign_keys = ON')
    rmSync(tmp, { force: true })
  }
  stmts.clear()
  awaitingResync = false
  lastDataVersion = dataVersion()
  const ack: WriterAck = { upTo: seq, entries: 0, ops: 0, groups, commitMs: 0, walBytes: -1, external: 0, resynced: true, resyncMs: performance.now() - t0 }
  send('ack', ack)
  Atomics.store(ctl, 0, BigInt(seq))
  Atomics.notify(ctl, 0)
}

function close(): void {
  commitAcc()
  closed = true
  db.close()
  Atomics.store(ctl, 1, 1n)
  Atomics.notify(ctl, 1)
  port.close()
}

function handle(e: Envelope): void {
  if (closed) return
  switch (e.k) {
    case 'batch': {
      const b = e.body as WriterBatch
      for (const [id, sql] of b.defs) sqls.set(id, sql)
      if (!awaitingResync) for (const en of b.entries) acc.push(en)
      return
    }
    case 'resync': {
      // the snapshot covers every entry sent before it
      acc = []
      try {
        resync(new Uint8Array(e.bin!), (e.body as WriterResync).seq)
      } catch (err) {
        send('fatal', { error: `resync failed: ${(err as Error)?.stack ?? err}` })
      }
      return
    }
    case 'close':
      return close()
  }
}

port.on('message', (e: Envelope) => {
  handle(e)
  // group commit: everything already queued joins this group
  for (let m = receiveMessageOnPort(port); m && !closed; m = receiveMessageOnPort(port)) handle(m.message as Envelope)
  try {
    commitAcc()
  } catch (err) {
    send('fatal', { error: (err as Error)?.stack ?? String(err) })
  }
})
send('ready', { file: init.file })
