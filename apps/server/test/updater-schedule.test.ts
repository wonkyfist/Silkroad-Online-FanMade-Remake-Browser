/**
 * Self-updates (docs/UPDATES.md §3): the install window (quiet hours, time zones, midnight), the mode logic (when to
 * check, when to install), the countdown players hear, the settings checks and the run state files.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { COUNTDOWN_MS, FIRST_CHECK_DELAY_MS, MIN_UPTIME_FOR_INSTALL_MS, countdownPlan, countdownText, decide, inWindow, minutesOfDay, nextCheckAt, spokenDuration, type DecideInput } from '../src/updater/schedule.ts'
import { UPDATE_DEFAULTS, loadUpdateSettings, saveUpdateSettings, settingsProblems } from '../src/updater/settings.ts'
import { acquireLock, finishRun, newRun, readHistory, readState, releaseLock, setPhase, skippedTarget, writeState } from '../src/updater/state.ts'
import { normalizeRepoUrl, repoUrlProblem } from '../src/updater/git.ts'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sro-upd-state-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** 2026-10-06 at hh:mm UTC. */
const utc = (hh: number, mm = 0) => Date.UTC(2026, 9, 6, hh, mm)

describe('install window', () => {
  const win = (start: string, end: string, tz = 'UTC') => ({ windowEnabled: true, windowStart: start, windowEnd: end, windowTz: tz })

  it('minutesOfDay follows the time zone', () => {
    expect(minutesOfDay(utc(3, 30), 'UTC')).toBe(210)
    expect(minutesOfDay(utc(3, 30), 'Europe/Berlin')).toBe(330) // CEST, UTC+2
    expect(minutesOfDay(utc(3, 30), 'America/New_York')).toBe(23 * 60 + 30) // EDT, UTC-4, the day before
    expect(minutesOfDay(utc(3, 30), 'Not/AZone')).toBe(210) // invalid: UTC
  })

  it('a same-day window: start inclusive, end exclusive', () => {
    expect(inWindow(utc(3, 59), win('04:00', '06:00'), 'UTC')).toBe(false)
    expect(inWindow(utc(4, 0), win('04:00', '06:00'), 'UTC')).toBe(true)
    expect(inWindow(utc(5, 59), win('04:00', '06:00'), 'UTC')).toBe(true)
    expect(inWindow(utc(6, 0), win('04:00', '06:00'), 'UTC')).toBe(false)
  })

  it('a window over midnight', () => {
    expect(inWindow(utc(23), win('22:00', '06:00'), 'UTC')).toBe(true)
    expect(inWindow(utc(2), win('22:00', '06:00'), 'UTC')).toBe(true)
    expect(inWindow(utc(12), win('22:00', '06:00'), 'UTC')).toBe(false)
  })

  it("the window's own zone, else the server's", () => {
    // 02:30 UTC is 04:30 in Berlin
    expect(inWindow(utc(2, 30), win('04:00', '06:00', 'Europe/Berlin'), 'UTC')).toBe(true)
    expect(inWindow(utc(2, 30), win('04:00', '06:00', ''), 'Europe/Berlin')).toBe(true)
    expect(inWindow(utc(2, 30), win('04:00', '06:00', ''), 'UTC')).toBe(false)
  })

  it('off, or start = end: any time', () => {
    expect(inWindow(utc(12), { ...win('04:00', '06:00'), windowEnabled: false }, 'UTC')).toBe(true)
    expect(inWindow(utc(12), win('04:00', '04:00'), 'UTC')).toBe(true)
  })
})

describe('mode logic', () => {
  const base = (o: Partial<DecideInput> & { mode?: DecideInput['settings']['mode'] } = {}): DecideInput => ({
    settings: { ...UPDATE_DEFAULTS, mode: o.mode ?? 'auto' },
    serverTz: 'UTC',
    now: utc(12),
    install: 'git',
    busy: false,
    lastCheckAt: utc(11, 30),
    behind: 2,
    canUpdate: true,
    supervised: true,
    latest: 'b'.repeat(40),
    skipped: null,
    uptimeMs: 3600_000,
    ...o,
  })

  it('off never does anything; notify checks but never installs', () => {
    expect(decide(base({ mode: 'off', lastCheckAt: null }))).toBe('none')
    expect(decide(base({ mode: 'notify', lastCheckAt: utc(10) }))).toBe('check')
    expect(decide(base({ mode: 'notify' }))).toBe('none')
  })

  it('checks once the interval has passed, the first time a minute after a start', () => {
    expect(decide(base({ lastCheckAt: utc(11), behind: 0 }))).toBe('check')
    expect(decide(base({ lastCheckAt: utc(11, 1), behind: 0 }))).toBe('none')
    expect(decide(base({ lastCheckAt: null, uptimeMs: FIRST_CHECK_DELAY_MS - 1 }))).toBe('none')
    expect(decide(base({ lastCheckAt: null, uptimeMs: FIRST_CHECK_DELAY_MS }))).toBe('check')
  })

  it('auto installs only when everything allows it', () => {
    expect(decide(base())).toBe('install')
    expect(decide(base({ behind: 0 }))).toBe('none')
    expect(decide(base({ canUpdate: false }))).toBe('none')
    expect(decide(base({ supervised: false }))).toBe('none')
    expect(decide(base({ busy: true }))).toBe('none')
    expect(decide(base({ skipped: 'b'.repeat(40) }))).toBe('none')
    expect(decide(base({ skipped: 'c'.repeat(40) }))).toBe('install')
    expect(decide(base({ uptimeMs: MIN_UPTIME_FOR_INSTALL_MS - 1 }))).toBe('none')
    expect(decide(base({ install: 'zip' }))).toBe('none')
    expect(decide(base({ install: 'deployed', lastCheckAt: null }))).toBe('none')
    expect(decide(base({ install: 'disabled', lastCheckAt: null }))).toBe('none')
  })

  it('auto waits for the install window', () => {
    const s = { ...UPDATE_DEFAULTS, mode: 'auto' as const, windowEnabled: true, windowStart: '03:00', windowEnd: '05:00' }
    expect(decide({ ...base(), settings: s, now: utc(12), lastCheckAt: utc(11, 30) })).toBe('none')
    expect(decide({ ...base(), settings: s, now: utc(4), lastCheckAt: utc(3, 30) })).toBe('install')
  })

  it('the next check', () => {
    expect(nextCheckAt({ settings: { ...UPDATE_DEFAULTS, intervalMin: 60 }, install: 'git', lastCheckAt: utc(11) }, 0)).toBe(utc(12))
    expect(nextCheckAt({ settings: { ...UPDATE_DEFAULTS }, install: 'git', lastCheckAt: null }, 1000)).toBe(1000 + FIRST_CHECK_DELAY_MS)
    expect(nextCheckAt({ settings: { ...UPDATE_DEFAULTS, mode: 'off' }, install: 'git', lastCheckAt: null }, 0)).toBeNull()
    expect(nextCheckAt({ settings: { ...UPDATE_DEFAULTS }, install: 'deployed', lastCheckAt: null }, 0)).toBeNull()
  })
})

describe('countdown', () => {
  it('5 minutes, then 1 minute and 10 seconds', () => {
    const p = countdownPlan(3)
    expect(p.endMs).toBe(COUNTDOWN_MS)
    expect(p.notices.map((n) => n.atMs)).toEqual([0, 4 * 60_000, COUNTDOWN_MS - 10_000])
    expect(p.notices[0].text).toContain('in 5 minutes')
    expect(p.notices[1].text).toContain('in 1 minute:')
    expect(p.notices[2].text).toContain('in 10 seconds')
  })

  it('nobody online: no countdown', () => {
    expect(countdownPlan(0)).toEqual({ endMs: 0, notices: [] })
  })

  it('a shorter countdown starts with its own length', () => {
    const p = countdownPlan(1, 30_000)
    expect(p.notices.map((n) => [n.atMs, spokenDuration(30_000 - n.atMs)])).toEqual([[0, '30 seconds'], [20_000, '10 seconds']])
  })

  it('spoken durations', () => {
    expect(spokenDuration(300_000)).toBe('5 minutes')
    expect(spokenDuration(60_000)).toBe('1 minute')
    expect(spokenDuration(90_000)).toBe('2 minutes')
    expect(spokenDuration(1000)).toBe('1 second')
    expect(countdownText(10_000)).toMatch(/^Server update in 10 seconds: .*saved/)
  })
})

describe('settings', () => {
  it('checks every field', () => {
    expect(settingsProblems({ mode: 'auto', intervalMin: 60, windowEnabled: true, windowStart: '22:00', windowEnd: '06:00', windowTz: 'Europe/Berlin', repoUrl: 'https://github.com/a/b', branch: 'main' })).toEqual([])
    expect(settingsProblems({ mode: 'sometimes' })).toHaveLength(1)
    expect(settingsProblems({ intervalMin: 5 })).toHaveLength(1)
    expect(settingsProblems({ intervalMin: 60.5 })).toHaveLength(1)
    expect(settingsProblems({ windowStart: '24:00' })).toHaveLength(1)
    expect(settingsProblems({ windowTz: 'Mars/Olympus' })).toHaveLength(1)
    expect(settingsProblems({ branch: '../x' })).toHaveLength(1)
    expect(settingsProblems({ nope: 1 })).toEqual(['unknown setting nope'])
  })

  it('only https repository URLs (a local path only in tests)', () => {
    expect(repoUrlProblem('https://github.com/wonkyfist/Silkroad-Online-FanMade-Remake-Browser')).toBeNull()
    expect(repoUrlProblem('https://github.com/a/b.git')).toBeNull()
    expect(repoUrlProblem('http://github.com/a/b')).toMatch(/https/)
    expect(repoUrlProblem('git@github.com:a/b.git')).not.toBeNull()
    expect(repoUrlProblem('file:///tmp/x')).not.toBeNull()
    expect(repoUrlProblem('https://user:pw@github.com/a/b')).toMatch(/password/)
    expect(repoUrlProblem('https://github.com/a/b?x=1')).not.toBeNull()
    expect(repoUrlProblem('https://github.com/a')).not.toBeNull()
    expect(repoUrlProblem('C:/temp/origin.git')).not.toBeNull()
    expect(repoUrlProblem('C:/temp/origin.git', true)).toBeNull()
  })

  it('compares URLs the way git users write them', () => {
    const want = normalizeRepoUrl('https://github.com/Owner/Repo')
    expect(normalizeRepoUrl('https://GitHub.com/Owner/Repo.git')).toBe(want)
    expect(normalizeRepoUrl('https://github.com/Owner/Repo/')).toBe(want)
    expect(normalizeRepoUrl('https://github.com/Owner/Other')).not.toBe(want)
    expect(normalizeRepoUrl('git@github.com:Owner/Repo.git')).toBeNull()
  })

  it('saved settings over the defaults; a broken value falls back', () => {
    const d = tmp()
    expect(loadUpdateSettings(d)).toEqual(UPDATE_DEFAULTS)
    expect(UPDATE_DEFAULTS.mode).toBe('notify')
    saveUpdateSettings(d, { ...UPDATE_DEFAULTS, mode: 'auto', intervalMin: 3 })
    const s = loadUpdateSettings(d)
    expect(s.mode).toBe('auto')
    expect(s.intervalMin).toBe(UPDATE_DEFAULTS.intervalMin)
  })
})

describe('run state', () => {
  const run = (d: string, kind: 'update' | 'rollback' = 'update') => newRun({ kind, from: 'a'.repeat(40), to: 'b'.repeat(40), by: 'admin', repoUrl: 'https://github.com/a/b', branch: 'main', schemaBefore: 16, now: utc(12) })

  it('survives a restart of either process (a file), and ends in the history', () => {
    const d = tmp()
    const s = run(d)
    setPhase(d, s, 'installing', 'installing packages')
    const again = readState(d)!
    expect(again.phase).toBe('installing')
    expect(again.log.at(-1)).toMatch(/installing packages$/)
    finishRun(d, again, 'updated', '')
    expect(readState(d)).toBeNull()
    expect(readHistory(d)[0]).toMatchObject({ result: 'updated', from: 'a'.repeat(40), schemaBefore: 16 })
  })

  it('a torn state file is set aside, never fatal', async () => {
    const d = tmp()
    const s = run(d)
    writeState(d, s)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(d, 'updates', 'state.json'), '{"v":1,"phase":')
    expect(readState(d)).toBeNull()
  })

  it('the automatic mode skips a target that failed or was rolled back', () => {
    const h = (kind: 'update' | 'rollback', result: 'updated' | 'rolled-back' | 'failed' | 'cancelled') => ({ ...run(''), kind, result, endedAt: 0, reason: '', schemaBefore: 1 })
    expect(skippedTarget([])).toBeNull()
    expect(skippedTarget([h('update', 'updated')])).toBeNull()
    expect(skippedTarget([h('update', 'rolled-back')])).toBe('b'.repeat(40))
    expect(skippedTarget([h('update', 'failed')])).toBe('b'.repeat(40))
    expect(skippedTarget([h('update', 'cancelled'), h('update', 'failed')])).toBe('b'.repeat(40))
    expect(skippedTarget([h('rollback', 'rolled-back')])).toBe('a'.repeat(40))
  })

  it('one supervisor per data folder', () => {
    const d = tmp()
    expect(acquireLock(d, process.pid)).toEqual({ ok: true })
    // Another live process (our parent) cannot take it; a dead one's lock is taken over.
    expect(acquireLock(d, process.ppid)).toEqual({ ok: false, pid: process.pid })
    releaseLock(d, process.pid)
    expect(acquireLock(d, process.ppid)).toEqual({ ok: true })
    expect(acquireLock(d, process.pid)).toEqual({ ok: false, pid: process.ppid })
    releaseLock(d, process.ppid)
  })
})
