/**
 * The DB writer's messages (docs/SERVER_ARCHITECTURE.md §3.8, phase P2): the tick thread (db/mirror.ts) journals every
 * committed write of its in-memory database as ordered entries; the writer thread (db/writer.ts) replays them on the
 * file with group commit. Types only (erasable: the writer loads it with Node's own type stripping).
 */

/**
 * One captured statement: [statement id, its parameters, the changes it made in memory (-1 = not checked)], or
 * [-1, sql, -1] for a `db.exec`. The writer compares `changes` on replay: a difference is a divergence.
 */
export type Op = [stmt: number, params: unknown[], changes: number] | [stmt: -1, sql: string, changes: -1]

/** One atomic unit: the writes of one outermost transaction (or one autocommit statement), in order. */
export interface Entry {
  /** Journal sequence (1, 2, … per process). */
  s: number
  /** Date.now() when it was journaled (the latency to its commit). */
  t: number
  ops: Op[]
}

/** k 'batch': the entries of one event-loop turn, plus the statements first used in it. */
export interface WriterBatch {
  defs: [id: number, sql: string][]
  entries: Entry[]
}

/** k 'resync': replace the file's content by this snapshot of the memory database (bin), taken after entry `seq`. */
export interface WriterResync {
  seq: number
}

/** The writer's answer to every commit (k 'ack'). */
export interface WriterAck {
  /** Every entry up to this sequence is committed. */
  upTo: number
  entries: number
  ops: number
  groups: number
  /** Time spent in BEGIN … COMMIT (ms). */
  commitMs: number
  /** Size of the -wal file (bytes; sampled at most once a second, -1 = not sampled). */
  walBytes: number
  /** Commits by another connection seen since the last ack (an external writer: the gm CLI, a tool). */
  external: number
  /** The writer thread's CPU since it started (ms; process.threadCpuUsage). */
  cpuMs?: number
  /** Whether this ack ends a resync (the snapshot is the file now). */
  resynced?: boolean
  /** Time the resync took (ms). */
  resyncMs?: number
}

/** k 'diverged': a replayed statement failed or changed another number of rows; the group was rolled back. */
export interface WriterDiverged {
  seq: number
  error: string
}

/** Test hook: the writer dies inside the first group from the n-th on (1-based) that reaches `afterOps` statements. */
export interface WriterCrash {
  group: number
  afterOps: number
  /** 'thread': the writer thread exits (the process lives on); 'process': the whole process is killed. */
  mode: 'thread' | 'process'
}

export interface WriterInit {
  file: string
  port: unknown
  /** BigInt64Array [committed seq, closed flag] for synchronous waits (Atomics). */
  ctl: SharedArrayBuffer
  /** Statements per group at most (one BEGIN … COMMIT). */
  maxGroupOps: number
  crash?: WriterCrash | null
}
