/**
 * The update supervisor (docs/UPDATES.md §4) with local git fixtures and stand-ins: the "server" is a small script
 * committed in the fixture repository (so each version behaves differently) and "pnpm" is a node one-liner that logs
 * its arguments. Covers the restart codes and the crash back-off, a full update through the hand-over, the rollback of
 * a version that fails to build, dies or never reports healthy (with the database restore when the schema moved), a
 * run resumed after a stop in the middle, and the refusals before anything changes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Supervisor, crashDelay, exitDecision, type SupervisorOptions } from '../src/updater/supervisor.ts'
import { RESTART_EXIT_CODE, newRun, readHistory, readState, writeState, type UpdateStateFile } from '../src/updater/state.ts'
import { makeRepos, type Repos } from './updater-fixture.ts'

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

describe('exit codes', () => {
  it('what the supervisor does when the server exits', () => {
    expect(exitDecision(RESTART_EXIT_CODE, null, false)).toBe('restart')
    expect(exitDecision(0, null, false)).toBe('stop')
    expect(exitDecision(1, null, false)).toBe('crash')
    expect(exitDecision(null, null, false)).toBe('crash')
    expect(exitDecision(RESTART_EXIT_CODE, 'handoff', false)).toBe('apply')
    expect(exitDecision(1, 'handoff', false)).toBe('apply')
    expect(exitDecision(1, 'starting', false)).toBe('rollback')
    expect(exitDecision(RESTART_EXIT_CODE, 'handoff', true)).toBe('stop')
    expect(exitDecision(1, null, true)).toBe('stop')
  })

  it('the crash back-off grows and stays at its last step', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((n) => crashDelay(n))).toEqual([1000, 2000, 5000, 10_000, 30_000, 60_000, 60_000, 60_000])
  })

  it('restarts on 75, after a crash, and stops on a clean exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sro-sup-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const count = join(dir, 'count.txt')
    writeFileSync(
      join(dir, 'server.mjs'),
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const f = ${JSON.stringify(count)}
const n = (existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0) + 1
writeFileSync(f, String(n))
if (process.env.SRO_SUPERVISOR !== '1') process.exit(9)
process.exit(n === 1 ? 75 : n === 2 ? 3 : 0)
`,
    )
    const logs: string[] = []
    const sup = new Supervisor({ root: dir, dataDir: join(dir, 'data'), server: { cmd: process.execPath, args: [join(dir, 'server.mjs')], cwd: dir }, backoffMs: [10], log: (l) => logs.push(l) })
    expect(await sup.run()).toBe(0)
    expect(readFileSync(count, 'utf8')).toBe('3')
    expect(logs.join('\n')).toMatch(/restart requested/)
    expect(logs.join('\n')).toMatch(/exited \(3\)/)
    // The lock is released.
    expect(existsSync(join(dir, 'data', 'updates', 'supervisor.lock'))).toBe(false)
  })
})

/** A server script version: `mode` decides what it does when it starts. */
function serverScript(mode: 'handoff-or-stop' | 'healthy' | 'die' | 'hang'): string {
  return `import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const data = process.env.UPD_DATA
const statePath = join(data, 'updates', 'state.json')
appendFileSync(process.env.MARK, ${JSON.stringify(mode)} + '\\n')
const mode = ${JSON.stringify(mode)}
if (mode === 'handoff-or-stop') {
  const h = process.env.HANDOFF
  if (existsSync(h)) {
    mkdirSync(join(data, 'updates'), { recursive: true })
    renameSync(h, statePath)
    process.exit(75)
  }
}
if (mode === 'healthy' || mode === 'handoff-or-stop') {
  if (!existsSync(statePath)) process.exit(0)
  const s = JSON.parse(readFileSync(statePath, 'utf8'))
  if (s.phase === 'starting') {
    s.phase = 'healthy'
    writeFileSync(statePath + '.x', JSON.stringify(s))
    renameSync(statePath + '.x', statePath)
  }
  setTimeout(() => process.exit(0), 300)
}
if (mode === 'die') process.exit(1)
if (mode === 'hang') setInterval(() => {}, 1000)
`
}

interface Rig {
  r: Repos
  dataDir: string
  mark: string
  pnpmLog: string
  handoff: string
  a: string
  sup(o?: Partial<SupervisorOptions>): Supervisor
  run(kind: 'update' | 'rollback', from: string, to: string, phase?: UpdateStateFile['phase'], schemaBefore?: number | null): UpdateStateFile
  marks(): string[]
  pnpmCalls(): string[]
}

function rig(): Rig {
  const r = makeRepos({ 'server.mjs': serverScript('handoff-or-stop'), 'README.md': 'v1\n' })
  cleanups.push(() => r.cleanup())
  const dataDir = join(r.base, 'data')
  mkdirSync(dataDir, { recursive: true })
  const mark = join(r.base, 'marks.txt')
  const pnpmLog = join(r.base, 'pnpm.txt')
  const handoff = join(r.base, 'HANDOFF.json')
  // pnpm stand-in: logs its arguments; a build fails while the checked-out version has a FAILBUILD file.
  const pnpm = (args: readonly string[]) => ({
    cmd: process.execPath,
    args: ['-e', `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(pnpmLog)}, ${JSON.stringify(args.join(' '))} + '\\n'); process.exit(${args.includes('build')} && fs.existsSync('FAILBUILD') ? 1 : 0)`],
    shell: false,
  })
  return {
    r,
    dataDir,
    mark,
    pnpmLog,
    handoff,
    a: r.head(),
    sup: (o = {}) =>
      new Supervisor({
        root: r.server, dataDir, pnpm, allowLocalOrigin: true, backoffMs: [10], healthPollMs: 50, log: () => {},
        server: { cmd: process.execPath, args: ['server.mjs'], cwd: r.server, env: { ...process.env, UPD_DATA: dataDir, MARK: mark, HANDOFF: handoff } },
        readSchema: async () => 16,
        ...o,
      }),
    run(kind, from, to, phase = 'handoff', schemaBefore = 16) {
      const s = newRun({ kind, from, to, by: 'alice', repoUrl: r.origin, branch: 'main', schemaBefore, now: Date.now() })
      s.phase = phase
      const backup = join(dataDir, 'backups', `pre-${kind}-test.db`)
      mkdirSync(join(dataDir, 'backups'), { recursive: true })
      writeFileSync(backup, 'BACKUP')
      s.backup = backup
      return s
    },
    marks: () => (existsSync(mark) ? readFileSync(mark, 'utf8').trim().split('\n') : []),
    pnpmCalls: () => (existsSync(pnpmLog) ? readFileSync(pnpmLog, 'utf8').trim().split('\n') : []),
  }
}

/** Pushes a new version with a server script that behaves as `mode` and fetches it into the server clone. */
function newVersion(x: Rig, mode: Parameters<typeof serverScript>[0], extra: Record<string, string> = {}): string {
  const b = x.r.commit(`version ${mode}`, { 'server.mjs': serverScript(mode), ...extra })
  x.r.git('fetch', '-q', 'origin')
  return b
}

describe('an update', () => {
  it('the hand-over: merge, install, build, start, healthy', async () => {
    const x = rig()
    const b = newVersion(x, 'healthy')
    writeFileSync(x.handoff, JSON.stringify(x.run('update', x.a, b)))
    expect(await x.sup().run()).toBe(0)
    expect(x.r.head()).toBe(b)
    expect(x.marks()).toEqual(['handoff-or-stop', 'healthy'])
    expect(x.pnpmCalls()).toEqual(['install --frozen-lockfile', '--filter @sro/game build', '--filter @sro/admin build'])
    expect(readState(x.dataDir)).toBeNull()
    const h = readHistory(x.dataDir)[0]
    expect(h).toMatchObject({ kind: 'update', result: 'updated', from: x.a, to: b })
    expect(h.log.join('\n')).toMatch(/git merge --ff-only/)
  })

  it('a build that fails: back to the old commit, which starts again', async () => {
    const x = rig()
    const b = newVersion(x, 'healthy', { FAILBUILD: '1' })
    writeState(x.dataDir, x.run('update', x.a, b))
    expect(await x.sup().run()).toBe(0)
    expect(x.r.head()).toBe(x.a)
    expect(x.marks()).toEqual(['handoff-or-stop'])
    // install + game build (failed) in the new version, then install + both builds of the old one
    expect(x.pnpmCalls()).toEqual(['install --frozen-lockfile', '--filter @sro/game build', 'install --frozen-lockfile', '--filter @sro/game build', '--filter @sro/admin build'])
    expect(readHistory(x.dataDir)[0]).toMatchObject({ result: 'rolled-back', reason: 'game client build failed (exit 1)' })
  })

  it('a new version that dies: rollback; the backup comes back because a migration ran', async () => {
    const x = rig()
    const b = newVersion(x, 'die')
    const s = x.run('update', x.a, b, 'handoff', 16)
    writeState(x.dataDir, s)
    writeFileSync(join(x.dataDir, 'game.db'), 'MIGRATED')
    writeFileSync(join(x.dataDir, 'game.db-wal'), 'WAL')
    expect(await x.sup({ readSchema: async () => 17 }).run()).toBe(0)
    expect(x.r.head()).toBe(x.a)
    expect(x.marks()).toEqual(['die', 'handoff-or-stop'])
    expect(readFileSync(join(x.dataDir, 'game.db'), 'utf8')).toBe('BACKUP')
    expect(existsSync(join(x.dataDir, 'game.db-wal'))).toBe(false)
    expect(readFileSync(join(x.dataDir, 'backups', `failed-${s.id}.db`), 'utf8')).toBe('MIGRATED')
    const h = readHistory(x.dataDir)[0]
    expect(h).toMatchObject({ result: 'rolled-back' })
    expect(h.reason).toMatch(/stopped \(exit 1\) before it was healthy/)
    expect(h.log.join('\n')).toMatch(/database restored/)
  })

  it('a new version that never reports healthy: killed after the timeout, rolled back, the database kept (no migration)', async () => {
    const x = rig()
    const b = newVersion(x, 'hang')
    writeState(x.dataDir, x.run('update', x.a, b))
    writeFileSync(join(x.dataDir, 'game.db'), 'LIVE')
    expect(await x.sup({ healthTimeoutMs: 1500 }).run()).toBe(0)
    expect(x.r.head()).toBe(x.a)
    expect(readFileSync(join(x.dataDir, 'game.db'), 'utf8')).toBe('LIVE')
    expect(readHistory(x.dataDir)[0].reason).toMatch(/did not report healthy within 2 s/)
  })

  it('local changes or a moved HEAD: nothing is installed, the old version starts', async () => {
    const x = rig()
    const b = newVersion(x, 'healthy')
    writeFileSync(join(x.r.server, 'README.md'), 'edited by the owner\n')
    writeState(x.dataDir, x.run('update', x.a, b))
    expect(await x.sup().run()).toBe(0)
    expect(x.r.head()).toBe(x.a)
    expect(readFileSync(join(x.r.server, 'README.md'), 'utf8')).toBe('edited by the owner\n')
    expect(readHistory(x.dataDir)[0]).toMatchObject({ result: 'failed', reason: 'local changes to tracked files: README.md' })
    expect(x.pnpmCalls()).toEqual([])
  })

  it('a run resumed after a stop in the middle: install and build again, then start', async () => {
    const x = rig()
    const b = newVersion(x, 'healthy')
    x.r.git('merge', '-q', '--ff-only', b) // the merge had happened
    writeState(x.dataDir, x.run('update', x.a, b, 'installing'))
    expect(await x.sup().run()).toBe(0)
    expect(x.r.head()).toBe(b)
    expect(readHistory(x.dataDir)[0]).toMatchObject({ result: 'updated' })
    expect(readHistory(x.dataDir)[0].log.join('\n')).toMatch(/resumed by the supervisor \(stopped at installing\)/)
  })

  it('a run resumed before its merge: merges', async () => {
    const x = rig()
    const b = newVersion(x, 'healthy')
    writeState(x.dataDir, x.run('update', x.a, b, 'merging'))
    expect(await x.sup().run()).toBe(0)
    expect(x.r.head()).toBe(b)
    expect(readHistory(x.dataDir)[0].result).toBe('updated')
  })

  it('a rollback run: back to the old commit and its backup', async () => {
    const x = rig()
    const b = newVersion(x, 'healthy')
    x.r.git('merge', '-q', '--ff-only', b)
    // The old version's script reports healthy too (its own self-check).
    const s = x.run('rollback', b, x.a, 'handoff', 17)
    s.restore = s.backup
    writeState(x.dataDir, s)
    writeFileSync(join(x.dataDir, 'game.db'), 'NEW')
    const sup = x.sup({ healthTimeoutMs: 1500 })
    expect(await sup.run()).toBe(0)
    expect(x.r.head()).toBe(x.a)
    expect(readFileSync(join(x.dataDir, 'game.db'), 'utf8')).toBe('BACKUP')
    expect(readHistory(x.dataDir)[0]).toMatchObject({ kind: 'rollback', result: 'rolled-back', from: s.from, to: x.a })
  })
})
