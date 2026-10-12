/**
 * docs/SERVER_ARCHITECTURE.md phase P2: crash injection. Items and gold never duplicate or vanish, and nothing a client
 * was told is undone, whatever dies when:
 *
 * - the whole process, killed (SIGKILL) at random moments of a random economy run (trades with items and gold, stall
 *   purchases, storage moves and gold), five times in a row on the same database;
 * - the process, killed precisely mid-trade, mid-stall-buy, mid-storage-move and mid-gold-transfer: right after the
 *   operation's transaction ran in memory and before the writer committed it;
 * - the process, killed by its DB writer from inside a group commit (mid-transaction on the file);
 * - the DB writer thread alone (exits mid-group, or is terminated): restarted and resynced, the run goes on;
 * - the economy service, restarted mid-trade (both sides locked) again and again.
 *
 * After every death the database (opened afresh, as a restarted server would) passes SQLite's integrity check, holds
 * exactly the gold and items it started with (bags, equipment, storage), and contains every transfer the child
 * acknowledged (its result was released to the clients only after the commit) exactly once.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { openStore } from '../src/db.ts'
import type { WriterCrash } from '../src/db/protocol.ts'
import { seeded } from './fixtures.ts'
import { ledger, seedCharacters, type StepKind } from './p2-econ.ts'

const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const CHILD = fileURLToPath(new URL('./p2-crash-child.ts', import.meta.url))
const KINDS: StepKind[] = ['trade', 'tradeGold', 'stall', 'storage', 'storageGold', 'move']

interface Run {
  code: number | null
  signal: NodeJS.Signals | null
  acks: { kind: string; at: number }[]
  died: { kind: string; at: number } | null
  done: Record<string, unknown> | null
  stderr: string
}

function child(args: Record<string, unknown>, killAfterMs?: number): Promise<Run> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--import', TSX, CHILD, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    c.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      if (killAfterMs !== undefined && !timer && out.includes('READY')) timer = setTimeout(() => c.kill('SIGKILL'), killAfterMs)
    })
    c.stderr.on('data', (d: Buffer) => (err += d.toString()))
    c.on('error', reject)
    c.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer)
      const lines = out.split('\n')
      const acks = lines.filter((l) => l.startsWith('ACK ')).map((l) => ({ kind: l.split(' ')[1]!, at: Number(l.split(' ')[2]) }))
      const d = lines.find((l) => l.startsWith('DIE '))
      const done = lines.find((l) => l.startsWith('DONE '))
      resolve({
        code,
        signal,
        acks,
        died: d ? { kind: d.split(' ')[1]!, at: Number(d.split(' ')[2]) } : null,
        done: done ? (JSON.parse(done.slice(5)) as Record<string, unknown>) : null,
        stderr: err,
      })
    })
  })
}

const root = mkdtempSync(join(tmpdir(), 'sro-p2crash-'))
const file = join(root, 'data', 'game.db')
afterAll(() => rmSync(root, { recursive: true, force: true }))

let start: ReturnType<typeof ledger>
const acked = new Map<number, string>()
let nowBase = 1_800_000_000_000
const nextBase = () => (nowBase += 1_000_000_000)

/** The checks after every death: integrity, the same gold and items, every acknowledged transfer exactly once. */
function verify(r: Run, label: string): void {
  for (const a of r.acks) acked.set(a.at, a.kind)
  const db = new Database(file, { fileMustExist: true })
  try {
    expect(db.pragma('integrity_check', { simple: true }), label).toBe('ok')
    const logged = new Map<number, number>()
    for (const row of db.prepare('SELECT at FROM social_log').all() as { at: number }[]) logged.set(row.at, (logged.get(row.at) ?? 0) + 1)
    for (const [at, kind] of acked) expect(logged.get(at), `${label}: acknowledged ${kind} at ${at}`).toBe(1)
    // the transfer it died in was never acknowledged and is not on disk (the client was never told)
    if (r.died && (r.died.kind === 'trade' || r.died.kind === 'stall')) expect(logged.has(r.died.at), `${label}: the ${r.died.kind} it died in`).toBe(false)
  } finally {
    db.close()
  }
  const now = ledger(file)
  expect(now, `${label}: gold and items`).toEqual(start)
}

describe('P2: crash injection (no duplication, no loss)', () => {
  it('seeds the economy', () => {
    const s = openStore(join(root, 'data'), { writer: false })
    seedCharacters(s, 8, seeded(5))
    s.close()
    start = ledger(file)
    expect(start.gold).toBeGreaterThan(40_000)
    expect(Object.keys(start.items).length).toBe(3)
  })

  it('the process killed at random moments, five times', async () => {
    const rnd = seeded(99)
    let acks = 0
    for (let i = 0; i < 5; i++) {
      const r = await child({ root, seed: 100 + i, steps: 1_000_000, nowBase: nextBase(), kinds: KINDS }, 700 + Math.floor(rnd() * 1300))
      expect(r.signal ?? r.code, r.stderr).not.toBe(0)
      verify(r, `random kill ${i}`)
      acks += r.acks.length
    }
    expect(acks).toBeGreaterThan(5)
  }, 120_000)

  for (const [kind, n] of [['trade', 3], ['stall', 2], ['storage', 4], ['storageGold', 3]] as const) {
    it(`the process killed mid-${kind} (after its transaction in memory, before the commit)`, async () => {
      const r = await child({ root, seed: 200 + n, steps: 400, nowBase: nextBase(), kinds: KINDS, dieAt: { kind, n } })
      expect(r.died, r.stderr).toMatchObject({ kind })
      verify(r, `mid-${kind}`)
    }, 60_000)
  }

  for (const crash of [{ group: 3, afterOps: 2, mode: 'process' }, { group: 9, afterOps: 1, mode: 'process' }, { group: 20, afterOps: 7, mode: 'process' }] as WriterCrash[]) {
    it(`the process killed by its writer inside group commit ${crash.group} (statement ${crash.afterOps})`, async () => {
      const r = await child({ root, seed: 300 + crash.group, steps: 2000, nowBase: nextBase(), kinds: KINDS, crash })
      expect(r.done, 'it should have died').toBeNull()
      verify(r, `writer kill in group ${crash.group}`)
    }, 60_000)
  }

  it('the writer thread exits mid-group and is terminated later: restarted, resynced, nothing lost', async () => {
    const r = await child({ root, seed: 400, steps: 600, nowBase: nextBase(), kinds: KINDS, crash: { group: 4, afterOps: 3, mode: 'thread' }, killWriterAt: [300] })
    expect(r.code, r.stderr).toBe(0)
    const st = r.done!.writer as { restarts: number; resyncs: number; divergences: number; queued: number }
    expect(st.restarts, r.stderr).toBe(2)
    expect(st.resyncs).toBe(2)
    expect(st.divergences).toBe(0)
    verify(r, 'writer thread crash')
    expect(r.acks.length).toBeGreaterThan(10)
  }, 60_000)

  it('the economy service restarted mid-trade, again and again', async () => {
    const r = await child({ root, seed: 500, steps: 600, nowBase: nextBase(), kinds: ['trade', 'tradeGold', 'stall'], restartP: 0.4 })
    expect(r.code, r.stderr).toBe(0)
    expect(r.done!.restarts as number).toBeGreaterThan(20)
    verify(r, 'service restarts')
  }, 60_000)

  it('a clean run afterwards: the database works, every acknowledgement is there', async () => {
    const r = await child({ root, seed: 600, steps: 300, nowBase: nextBase(), kinds: KINDS })
    expect(r.code, r.stderr).toBe(0)
    verify(r, 'clean run')
    expect(acked.size).toBeGreaterThan(50)
    const kinds = [...acked.values()].reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})
    console.info(`P2 crash injection: ${acked.size} acknowledged transfers checked (${JSON.stringify(kinds)}); ledger ${start.gold} gold, ${JSON.stringify(start.items)}`)
  }, 60_000)
})
