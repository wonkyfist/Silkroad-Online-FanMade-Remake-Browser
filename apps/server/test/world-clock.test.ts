import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOCK_EPOCH_DAYS, CLOCK_EPOCH_MS, clockAt, type Role } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { WORLD_CLOCK_FILE, WorldClock } from '../src/world-clock.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const NOW = Date.UTC(2026, 8, 28, 17, 3, 21)
const dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sro-clock-'))
  dirs.push(d)
  return d
}

function clockIn(dataDir: string, extra: { dayLengthMin?: number; dayNightSpeedup?: number; daySeasonDeg?: number } = {}, logs: string[] = []) {
  return WorldClock.load({ dataDir, log: (m) => logs.push(m), ...extra })
}

/** Game seconds between solar time `t` and hh:mm. */
function offBy(t: number, hh: number, mm: number): number {
  let d = (t - (hh * 60 + mm) / 1440) * 86_400
  if (d > 43_200) d -= 86_400
  if (d < -43_200) d += 86_400
  return Math.abs(d)
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('WorldClock (docs/SKY.md §2.2)', () => {
  it('without a saved state: the config clock anchored at the epoch', () => {
    const c = clockIn(tmp(), { dayLengthMin: 60, dayNightSpeedup: 0.2, daySeasonDeg: -5 })
    expect(c.state).toEqual({ anchorMs: CLOCK_EPOCH_MS, anchorDays: CLOCK_EPOCH_DAYS, dayMs: 3_600_000, running: true, nightSpeedup: 0.2, declination: -5 })
    expect(clockIn(tmp()).state.dayMs).toBe(7_200_000) // DAY_LENGTH_MIN default 120
    expect(c.now(CLOCK_EPOCH_MS + 3_600_000).days).toBeCloseTo(1.3, 9)
  })

  it('`time 06:00` lands within 1 game second, today; `time` alone changes nothing', () => {
    const c = clockIn(tmp())
    const before = clockAt(c.state, NOW)
    const r = c.gm(['06:00'], NOW)
    expect(r).toMatchObject({ ok: true, changed: true })
    const after = clockAt(c.state, NOW)
    expect(offBy(after.t, 6, 0)).toBeLessThan(1)
    expect(after.day).toBe(before.day)
    expect(r.data).toMatchObject({ day: after.day, clock: c.state })
    expect(r.message).toContain(`Day ${after.day}, 06:00`)
    for (const hm of ['18:30', '00:00', '23:59', '12:00']) {
      c.gm([hm], NOW + 1234)
      const [h, m] = hm.split(':').map(Number)
      expect(offBy(clockAt(c.state, NOW + 1234).t, h, m)).toBeLessThan(1)
    }
    const status = c.gm([], NOW)
    expect(status).toMatchObject({ ok: true, changed: false })
    expect(status.message).toMatch(/^Day \d+, \d\d:\d\d, 1 day = 120 min, running, night ×0.4, season \+12°$/)
  })

  it('length, freeze/resume and night keep the current t; day keeps the time of day', () => {
    const c = clockIn(tmp())
    c.gm(['14:32'], NOW)
    const t0 = clockAt(c.state, NOW).t
    expect(c.gm(['length', '30'], NOW).ok).toBe(true)
    expect(c.state.dayMs).toBe(1_800_000)
    expect(clockAt(c.state, NOW).t).toBeCloseTo(t0, 9)
    expect(c.gm(['freeze'], NOW).ok).toBe(true)
    expect(clockAt(c.state, NOW + 3_600_000).t).toBeCloseTo(t0, 9) // frozen
    expect(c.gm(['resume'], NOW + 3_600_000).ok).toBe(true)
    expect(clockAt(c.state, NOW + 3_600_000).t).toBeCloseTo(t0, 9)
    expect(c.gm(['night', '0.1'], NOW + 3_600_000).ok).toBe(true)
    expect(clockAt(c.state, NOW + 3_600_000).t).toBeCloseTo(t0, 9)
    expect(c.gm(['day', '40'], NOW + 3_600_000).ok).toBe(true)
    expect(clockAt(c.state, NOW + 3_600_000)).toMatchObject({ day: 40 })
    expect(clockAt(c.state, NOW + 3_600_000).t).toBeCloseTo(t0, 9)
    expect(c.gm(['season', '-20'], NOW).ok).toBe(true)
    expect(c.state.declination).toBe(-20)
  })

  it('refuses bad input without changing the clock', () => {
    const c = clockIn(tmp())
    const s = c.state
    for (const args of [['24:00'], ['7:60'], ['day', '-1'], ['day', '1.5'], ['length', '0'], ['length', '1441'], ['night', '0.7'], ['season', '30'], ['bogus'], ['freeze', 'now']]) {
      expect(c.gm(args, NOW)).toMatchObject({ ok: false, changed: false })
    }
    expect(c.state).toEqual(s)
  })

  it('the JSON survives a restart; `time reset` deletes it and returns to the defaults', () => {
    const dir = tmp()
    const logs: string[] = []
    const a = clockIn(dir, {}, logs)
    a.gm(['18:30'], NOW)
    a.gm(['length', '45'], NOW)
    expect(existsSync(join(dir, WORLD_CLOCK_FILE))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, WORLD_CLOCK_FILE), 'utf8'))).toEqual(a.state)
    const b = clockIn(dir, { dayLengthMin: 90 })
    expect(b.state).toEqual(a.state) // the saved clock wins over the config
    expect(b.gm(['reset'], NOW)).toMatchObject({ ok: true, changed: true })
    expect(existsSync(join(dir, WORLD_CLOCK_FILE))).toBe(false)
    expect(b.state.dayMs).toBe(5_400_000)
    expect(clockIn(dir).state.anchorMs).toBe(CLOCK_EPOCH_MS)
    // a damaged file is ignored (logged), not fatal
    writeFileSync(join(dir, WORLD_CLOCK_FILE), '{"anchorMs": -5}')
    expect(clockIn(dir, {}, logs).state.anchorMs).toBe(CLOCK_EPOCH_MS)
    expect(logs.some((l) => l.includes('ignoring'))).toBe(true)
  })

  it('reads DAY_LENGTH_MIN, DAY_NIGHT_SPEEDUP, DAY_SEASON_DEG and rejects out-of-range values', () => {
    const c = loadConfig({ DAY_LENGTH_MIN: '60', DAY_NIGHT_SPEEDUP: '0', DAY_SEASON_DEG: '-23.44' })
    expect([c.dayLengthMin, c.dayNightSpeedup, c.daySeasonDeg]).toEqual([60, 0, -23.44])
    expect(loadConfig({})).toMatchObject({ dayLengthMin: 120, dayNightSpeedup: 0.4, daySeasonDeg: 12 })
    expect(() => loadConfig({ DAY_LENGTH_MIN: '0' })).toThrow(/DAY_LENGTH_MIN/)
    expect(() => loadConfig({ DAY_NIGHT_SPEEDUP: '0.8' })).toThrow(/DAY_NIGHT_SPEEDUP/)
    expect(() => loadConfig({ DAY_SEASON_DEG: '30' })).toThrow(/DAY_SEASON_DEG/)
  })
})

describe('time over the wire', () => {
  let s: TestServer
  let counter = 0

  beforeAll(async () => {
    s = await startTestServer({ config: { dayLengthMin: 120 } })
  })

  afterAll(async () => {
    await s.stopAndClean()
  })

  async function lobby(role: Role = 'player') {
    const acc = await newAccount(s.url, role === 'player' ? 'clk' : 'clkgm')
    if (role !== 'player') s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role)
    return Client.login(s.url, acc.token)
  }

  async function player(role: Role = 'player') {
    const c = await lobby(role)
    c.send({ t: 'charCreate', name: `Clock${++counter}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    return { c, enter: await c.next('worldEnter') }
  }

  it('worldEnter carries the clock; `time 18:30` reaches players in the world but not lobby sockets', async () => {
    const gm = await player('gm')
    const p = await player()
    const idle = await lobby()
    expect(p.enter.world.clock).toEqual(s.ctx.gameplay.clock.state)
    gm.c.send({ t: 'gm', cmd: 'time', args: ['18:30'] })
    const res = await gm.c.next('gmResult')
    expect(res.ok).toBe(true)
    expect(res.message).toMatch(/18:30/)
    const [a, b] = [await gm.c.next('worldClock'), await p.c.next('worldClock')]
    expect(a.clock).toEqual(s.ctx.gameplay.clock.state)
    expect(b.clock).toEqual(a.clock)
    expect(offBy(clockAt(b.clock, Date.now()).t, 18, 30)).toBeLessThan(60) // at most a few real seconds later
    await idle.none('worldClock', 300)
    // `time` shows the same clock to two GMs; a status never sends worldClock
    const gm2 = await player('gm')
    gm.c.send({ t: 'chat', text: '/time' })
    gm2.c.send({ t: 'gm', cmd: 'time', args: [] })
    const [m1, m2] = [await gm.c.next('gmResult'), await gm2.c.next('gmResult')]
    expect(m1.ok && m2.ok).toBe(true)
    expect((m1.data as { clock: unknown }).clock).toEqual((m2.data as { clock: unknown }).clock)
    expect(m1.message.slice(0, 13)).toBe(m2.message.slice(0, 13)) // "Day n, hh:mm" (a minute may tick over in between)
    await p.c.none('worldClock', 200)
    // a player cannot run it
    p.c.send({ t: 'chat', text: '/time 06:00' })
    expect((await p.c.next('error')).code).toBe('forbidden')
    s.ctx.gameplay.clock.gm(['reset'])
    for (const c of [gm.c, gm2.c, p.c, idle]) c.close()
    await sleep(20)
  })
})
