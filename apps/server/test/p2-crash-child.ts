/**
 * The crash-injection child of p2-crash.test.ts (docs/SERVER_ARCHITECTURE.md phase P2). Runs the economy harness
 * (p2-econ.ts) with the DB writer and the services on, over DATA_DIR = <root>/data, and random economy steps until it
 * is killed or has run `steps`. On the way it can kill itself at a precise point, kill or crash its writer, or restart
 * the economy service mid-trade. Prints (synchronously, so a kill cannot lose a printed line):
 *   ACK <kind> <at>   a trade or stall purchase whose result the clients were given (after its commit; at = social_log.at)
 *   DIE <kind> <at>   it kills itself now, right after that operation's transaction in memory (before its commit)
 *   DONE <json>       it closed the store (everything committed) and exits 0
 * Run: node --import tsx p2-crash-child.ts '<json args>'
 */
import { writeSync } from 'node:fs'
import { seeded } from './fixtures.ts'
import { econHarness, joinAll, step, type StepKind } from './p2-econ.ts'
import type { WriterCrash } from '../src/db/protocol.ts'

interface Args {
  root: string
  seed: number
  steps: number
  nowBase: number
  kinds: StepKind[]
  crash?: WriterCrash
  /** Statements per group commit at most (small: many groups, so a crash in group n is reached whatever the timing). */
  maxGroupOps?: number
  /** Kill this process right after the n-th (1-based) operation of `kind` ran in memory. */
  dieAt?: { kind: 'trade' | 'stall' | 'storage' | 'storageGold'; n: number }
  /** Restart the economy service before a tradeAccept with this probability (mid-trade). */
  restartP?: number
  /** Kill the writer thread after these steps (it is restarted and resynced). */
  killWriterAt?: number[]
}

const args = JSON.parse(process.argv[2]!) as Args
const out = (line: string) => writeSync(1, `${line}\n`)
const h = econHarness({ root: args.root, writer: { crash: args.crash ?? null, maxGroupOps: args.maxGroupOps ?? 500, log: (l) => writeSync(2, `${l}\n`) }, svcBus: true, seed: args.seed })
joinAll(h)
let now = args.nowBase
const counts: Record<string, number> = {}
const die = (kind: string, at: number) => {
  out(`DIE ${kind} ${at}`)
  process.kill(process.pid, 'SIGKILL')
}

// every transfer: acknowledged when its commit lets the parties hear the result (the economy's own commit-then-ack)
const transfer = h.gameplay.economy.transfer.bind(h.gameplay.economy)
h.gameplay.economy.transfer = <T>(key: string, parties: Parameters<typeof transfer>[1], run: () => T): T => {
  const at = now
  const kind = key.split(':')[0]!
  const v = transfer(key, parties, run)
  const logged = h.store.db.prepare('SELECT COUNT(*) AS n FROM social_log WHERE at = ?').get(at) as { n: number }
  if (logged.n > 0) {
    counts[kind] = (counts[kind] ?? 0) + 1
    if (args.dieAt?.kind === kind && counts[kind] === args.dieAt.n) die(kind, at)
    h.store.afterCommit(() => out(`ACK ${kind} ${at}`))
  }
  return v
}
// storage moves and gold: single-account transactions
const tables = h.gameplay.storage.tables
const storageTx = tables.storageTx.bind(tables)
tables.storageTx = ((characterId: number, accountId: number, fn: Parameters<typeof storageTx>[2]) => {
  const r = storageTx(characterId, accountId, fn)
  if (r.result.ok) {
    const kind = r.inv.goldChanged && !r.inv.touchedBag.size ? 'storageGold' : 'storage'
    counts[kind] = (counts[kind] ?? 0) + 1
    if (args.dieAt?.kind === kind && counts[kind] === args.dieAt.n) die(kind, now)
  }
  return r
}) as typeof tables.storageTx
// the economy service crashes mid-trade (both locked, maybe one accepted)
const rng = seeded(args.seed)
const chaos = seeded(args.seed + 1)
const req = h.req
let restarts = 0
h.req = (x, msg, at) => {
  if (msg.t === 'tradeAccept' && args.restartP && chaos() < args.restartP) {
    restarts += h.gameplay.services!.restart('economy') >= 0 ? 1 : 0
  }
  return req(x, msg, at)
}

async function main(): Promise<void> {
  await h.store.writer!.whenReady()
  out('READY')
  for (let i = 0; i < args.steps; i++) {
    now += 50
    step(h, rng, now, args.kinds)
    if (args.killWriterAt?.includes(i)) await h.store.writer!.killWriter()
    // let the event loop turn: the journal goes to the writer, the acks come back
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 1))
  }
  const stats = { writer: h.store.writerStats(), economy: h.gameplay.economy.stats(), restarts, counts }
  h.store.close()
  out(`DONE ${JSON.stringify(stats)}`)
  process.exit(0)
}

void main()
