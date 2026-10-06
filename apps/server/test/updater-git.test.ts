/**
 * Self-updates (docs/UPDATES.md §2, §3) against local git fixtures (a bare repository plays GitHub): what kind of
 * install this is, the origin check, fetch / behind / ahead, the fast-forward and dirty-tree refusals, the changelog of
 * what is new, and the server's half of a run (countdown, backup, hand-over, cancel, the health self-check).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { commitsBetween, countBetween, fetchBranch, inspectRepo, isAncestor } from '../src/updater/git.ts'
import { readHistory, readState, setPhase } from '../src/updater/state.ts'
import { Updater, type UpdaterDeps } from '../src/updater/updater.ts'
import { saveUpdateSettings, UPDATE_DEFAULTS } from '../src/updater/settings.ts'
import { changelogEntry, git, makeRepos, type Repos } from './updater-fixture.ts'

const all: Repos[] = []
const repos = (initial?: Record<string, string>) => {
  const r = makeRepos(initial)
  all.push(r)
  return r
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
afterAll(() => {
  for (const r of all) r.cleanup()
})

describe('what kind of install', () => {
  it('a clone of the configured repository', async () => {
    const r = repos()
    const info = await inspectRepo(r.server, r.origin, 'main', true)
    expect(info).toMatchObject({ kind: 'git', branch: 'main', originOk: true, dirty: [] })
    expect(info.head?.commit).toBe(r.head())
    expect(info.head?.subject).toBe('initial')
  })

  it('another origin, no origin, another branch, a local change', async () => {
    const r = repos()
    expect((await inspectRepo(r.server, 'https://github.com/someone/else', 'main')).originOk).toBe(false)
    // A local path is never accepted outside tests.
    expect((await inspectRepo(r.server, r.origin, 'main')).originOk).toBe(false)
    expect((await inspectRepo(r.server, r.origin, 'stable', true)).note).toMatch(/branch is main, not stable/)
    writeFileSync(join(r.server, 'README.md'), 'changed\n')
    expect((await inspectRepo(r.server, r.origin, 'main', true)).dirty).toEqual(['README.md'])
    // Untracked files (the server's own data) do not count.
    r.git('checkout', '--', 'README.md')
    writeFileSync(join(r.server, 'notes.txt'), 'mine\n')
    expect((await inspectRepo(r.server, r.origin, 'main', true)).dirty).toEqual([])
    r.git('remote', 'remove', 'origin')
    expect((await inspectRepo(r.server, r.origin, 'main', true)).note).toMatch(/no "origin"/)
  })

  it('a ZIP (no .git) and a release of the deploy scripts (.deploy-sha)', async () => {
    const zip = mkdtempSync(join(tmpdir(), 'sro-upd-zip-'))
    try {
      expect((await inspectRepo(zip, 'https://github.com/a/b', 'main')).kind).toBe('zip')
      writeFileSync(join(zip, '.deploy-sha'), 'abc\n')
      expect((await inspectRepo(zip, 'https://github.com/a/b', 'main')).kind).toBe('deployed')
    } finally {
      rmSync(zip, { recursive: true, force: true })
    }
  })
})

describe('fetch and compare', () => {
  it('behind, ahead and the fast-forward', async () => {
    const r = repos()
    const a = r.head()
    const b = r.commit('second', { 'a.txt': '1' })
    const c = r.commit('third', { 'a.txt': '2' })
    expect(await fetchBranch(r.server, 'main')).toBe(c)
    expect(r.head()).toBe(a) // a fetch never moves HEAD
    expect(await countBetween(r.server, a, c)).toBe(2)
    expect(await countBetween(r.server, c, a)).toBe(0)
    expect(await isAncestor(r.server, a, c)).toBe(true)
    expect(await isAncestor(r.server, c, a)).toBe(false)
    expect((await commitsBetween(r.server, a, c)).map((x) => x.subject)).toEqual(['third', 'second'])
    expect(b).not.toBe(c)
  })

  it('a local commit makes the update not a fast-forward', async () => {
    const r = repos()
    const remote = r.commit('upstream', { 'u.txt': 'u' })
    writeFileSync(join(r.server, 'local.txt'), 'l')
    r.git('add', 'local.txt')
    git(r.server, 'commit', '-q', '-m', 'local')
    await fetchBranch(r.server, 'main')
    expect(await isAncestor(r.server, r.head(), remote)).toBe(false)
  })
})

/** An Updater over the fixture's server clone; `sent` collects the notices, `exits` the hand-overs. */
function updater(r: Repos, opts: Partial<Omit<UpdaterDeps, 'online'>> & { online?: number } = {}) {
  const { online: startOnline, ...o } = opts
  const dataDir = join(r.base, `data-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dataDir, { recursive: true })
  saveUpdateSettings(dataDir, { ...UPDATE_DEFAULTS, repoUrl: r.origin })
  const sent: string[] = []
  const logs: string[] = []
  let exits = 0
  let online = startOnline ?? 0
  const u = new Updater({
    root: r.server,
    dataDir,
    supervised: true,
    log: (l) => logs.push(l),
    online: () => online,
    broadcast: (t) => sent.push(t),
    backupDb: async (p) => writeFileSync(p, 'backup'),
    schemaVersion: () => 16,
    requestExit: () => exits++,
    allowLocalOrigin: true,
    minFreeBytes: 0,
    serverTz: 'UTC',
    ...o,
  })
  return { u, dataDir, sent, logs, exits: () => exits, setOnline: (n: number) => (online = n) }
}

describe('the server side of an update', () => {
  it('a check finds the new commits and the new "What\'s new" entries', async () => {
    const r = repos({ 'README.md': 'v1\n', 'content/changelog/2026-10-01-old.md': changelogEntry('2026-10-01-old', 'Old news', 'Old.', '2026-10-01T12:00'), 'content/changelog/img/.keep': '' })
    r.commit('winter', { 'content/changelog/2026-10-06-winter.md': changelogEntry('2026-10-06-winter', 'Winter is here', 'Snow and snowballs.') })
    r.commit('fix', { 'x.txt': 'x' })
    const { u } = updater(r)
    await u.check()
    const v = await u.view()
    expect(v.install).toBe('git')
    expect(v.lastCheck?.ok).toBe(true)
    expect(v.behind).toBe(2)
    expect(v.ahead).toBe(0)
    expect(v.commits.map((c) => c.subject)).toEqual(['fix', 'winter'])
    expect(v.changelog).toEqual([{ id: '2026-10-06-winter', title: 'Winter is here', date: '2026-10-06T12:00', summary: 'Snow and snowballs.' }])
    expect(v.canUpdate).toBe(true)
    expect(v.blockers).toEqual([])
  })

  it('refuses with the reasons: not supervised, local changes, up to date', async () => {
    const r = repos()
    const { u } = updater(r, { supervised: false })
    await u.check()
    let v = await u.view()
    expect(v.canUpdate).toBe(false)
    expect(v.blockers.join(' ')).toMatch(/Already up to date/)
    expect(v.blockers.join(' ')).toMatch(/pnpm serve/)
    r.commit('new', { 'n.txt': 'n' })
    writeFileSync(join(r.server, 'README.md'), 'local edit\n')
    await u.check()
    v = await u.view()
    expect(v.behind).toBe(1)
    expect(v.blockers.join(' ')).toMatch(/Local changes to tracked files \(README.md\)/)
    await expect(u.install('admin')).rejects.toThrow(/cannot start/)
  })

  it('a pull by hand after the check makes it stale: check again', async () => {
    const r = repos()
    r.commit('new', { 'n.txt': 'n' })
    const { u } = updater(r)
    await u.check()
    expect((await u.view()).canUpdate).toBe(true)
    r.git('merge', '-q', '--ff-only', 'origin/main')
    await u.refreshRepo(true)
    expect((await u.view()).blockers.join(' ')).toMatch(/changed since the last check: check again/)
    await u.check()
    expect((await u.view()).blockers).toEqual(['Already up to date.'])
  })

  it('another origin: the updater stays off (the developer\'s own clones)', async () => {
    const r = repos()
    const { u, dataDir } = updater(r)
    saveUpdateSettings(dataDir, { ...UPDATE_DEFAULTS }) // the public repository; origin is the fixture
    const u2 = new Updater({ ...u.deps, dataDir })
    await u2.check()
    const v = await u2.view()
    expect(v.install).toBe('disabled')
    expect(v.installNote).toMatch(/not https:\/\/github.com\/wonkyfist/)
    expect(v.lastCheck).toBeNull()
  })

  it('nobody online: backup and hand-over at once', async () => {
    const r = repos()
    const to = r.commit('new', { 'n.txt': 'n' })
    const { u, dataDir, exits, sent } = updater(r)
    await u.check()
    await u.install('alice')
    const s = readState(dataDir)!
    expect(s).toMatchObject({ phase: 'handoff', kind: 'update', from: r.head(), to, by: 'alice', schemaBefore: 16 })
    expect(s.backup).toMatch(/backups[\\/]pre-update-.*-to-.*\.db$/)
    expect(readFileSync(s.backup!, 'utf8')).toBe('backup')
    expect(exits()).toBe(1)
    expect(sent).toEqual([])
    // A second update cannot start while this one runs.
    await expect(u.install('bob')).rejects.toThrow(/in progress/)
  })

  it('players online: the countdown, then backup and hand-over; or a cancel', async () => {
    const r = repos()
    r.commit('new', { 'n.txt': 'n' })
    const { u, dataDir, exits, sent } = updater(r, { online: 2, countdownMs: 400 })
    await u.check()
    await u.install('alice')
    expect(readState(dataDir)?.phase).toBe('countdown')
    await sleep(50)
    expect(sent[0]).toMatch(/^Server update in 1 second: /)
    await sleep(700)
    expect(readState(dataDir)?.phase).toBe('handoff')
    expect(exits()).toBe(1)
    expect(sent.at(-1)).toMatch(/restarting for an update now/)

    const second = updater(r, { online: 1, countdownMs: 60_000 })
    // the first run is still at handoff in its own data folder; this one is separate
    await second.u.check()
    await second.u.install('bob')
    const run = second.u.cancel('bob')
    expect(run.result).toBe('cancelled')
    expect(readState(second.dataDir)).toBeNull()
    expect(second.sent.at(-1)).toMatch(/cancelled/)
    expect(second.exits()).toBe(0)
    second.u.stop()
  })

  it('a backup that fails calls the update off', async () => {
    const r = repos()
    r.commit('new', { 'n.txt': 'n' })
    const { u, dataDir, exits } = updater(r, { backupDb: async () => Promise.reject(new Error('disk full')) })
    await u.check()
    await u.install('alice')
    expect(readState(dataDir)).toBeNull()
    expect(readHistory(dataDir)[0]).toMatchObject({ result: 'failed', reason: 'database backup failed: disk full' })
    expect(exits()).toBe(0)
  })

  it('after a start: a run stopped in the countdown is closed; the new version reports healthy', async () => {
    const r = repos()
    r.commit('new', { 'n.txt': 'n' })
    const { u, dataDir } = updater(r, { online: 1, countdownMs: 60_000 })
    await u.check()
    await u.install('alice')
    u.stop() // the server died in the countdown
    const fresh = new Updater({ ...u.deps })
    expect(await fresh.onStarted('http://x', async () => ({ ok: true, schema: 16 }))).toBe('cancelled')
    expect(readHistory(dataDir)[0].result).toBe('cancelled')

    // The supervisor installed it and started the new version.
    const to = r.head(r.dev)
    r.git('merge', '-q', '--ff-only', 'origin/main')
    const s = (await (async () => {
      const { newRun, writeState } = await import('../src/updater/state.ts')
      const run = newRun({ kind: 'update', from: 'a'.repeat(40), to, by: 'alice', repoUrl: r.origin, branch: 'main', schemaBefore: 15, now: Date.now() })
      run.phase = 'starting'
      writeState(dataDir, run)
      return run
    })())
    expect(await fresh.onStarted('http://x', async () => ({ ok: true, schema: 99 }))).toBe('unhealthy')
    expect(readState(dataDir)?.phase).toBe('starting')
    expect(await fresh.onStarted('http://x', async () => ({ ok: true, schema: 16 }))).toBe('healthy')
    expect(readState(dataDir)).toMatchObject({ id: s.id, phase: 'healthy' })
  })

  it('the rollback of the last update is offered while it runs', async () => {
    const r = repos()
    const from = r.head()
    r.commit('new', { 'n.txt': 'n' })
    const { u, dataDir } = updater(r)
    await u.check()
    await u.install('alice')
    // what the supervisor does: merge, then the history entry
    r.git('merge', '-q', '--ff-only', 'origin/main')
    const { finishRun } = await import('../src/updater/state.ts')
    const s = readState(dataDir)!
    setPhase(dataDir, s, 'healthy', 'ok')
    finishRun(dataDir, s, 'updated', '')
    await u.refreshRepo(true)
    let v = await u.view()
    expect(v.rollback).toMatchObject({ to: from, restoresDatabase: false })
    // The schema moved with the update: the rollback restores the backup.
    const moved = new Updater({ ...u.deps, schemaVersion: () => 17 })
    await moved.refreshRepo(true)
    v = await moved.view()
    expect(v.rollback?.restoresDatabase).toBe(true)
    const rb = await moved.rollback('alice')
    expect(rb).toMatchObject({ kind: 'rollback', to: from, restore: s.backup })
    expect(existsSync(s.backup!)).toBe(true)
  })
})
