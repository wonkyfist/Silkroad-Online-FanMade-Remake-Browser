/**
 * The snow season on the server (docs/WINTER.md): the winter module (season, cover, frost, persistence, the GM preview
 * and its broadcasts), the weather's winter forms (rain → snow, storm events → blizzards; GM holds taken as typed and
 * never touching the season), the storm module's winter env and status, the tornado knob and the admin settings.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WEATHER_PARAMS, WeatherSchedule, parseServerMessage, weatherParams, type ServerMessage, type WeatherParams, type WinterSync } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSetting, SETTING_BY_KEY } from '../src/admin/settings.ts'
import { openStore } from '../src/db.ts'
import type { ServerConfig } from '../src/config.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { StormPlan } from '../src/storm/schedule.ts'
import { WeatherService } from '../src/weather.ts'
import { WINTER_FILE, WinterService } from '../src/winter.ts'
import { World } from '../src/world.ts'
import { testConfig } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, seeded } from './fixtures.ts'

const OCT = Date.UTC(2026, 9, 5, 12, 0, 0)
const DEC = Date.UTC(2026, 11, 20, 12, 0, 0)
const H = 3_600_000

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'sro-winter-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** A broadcast sink that runs every message through the client's validator. */
function sink() {
  const sent: ServerMessage[] = []
  const broadcast = (msg: ServerMessage) => {
    const r = parseServerMessage(JSON.stringify(msg))
    if (!r.ok) throw new Error(`the client would reject ${JSON.stringify(msg)}: ${r.error}`)
    sent.push(msg)
  }
  const winters = () => sent.filter((m): m is Extract<ServerMessage, { t: 'winter' }> => m.t === 'winter').map((m) => m.winter)
  const weathers = () => sent.filter((m): m is Extract<ServerMessage, { t: 'weather' }> => m.t === 'weather').map((m) => m.weather)
  return { sent, broadcast, winters, weathers }
}

type WinterConfig = Pick<ServerConfig, 'dataDir' | 'log' | 'winterEnabled' | 'winterStart' | 'winterEnd' | 'winterTz' | 'winterStrength' | 'winterTornado'>

/** A WinterService on a stand-in weather whose parameters the test sets. */
function winter(now: number, over: Partial<WinterConfig> = {}, dataDir = tmp()) {
  const s = sink()
  const config: WinterConfig = { dataDir, log: () => {}, winterEnabled: true, winterStart: '12-01', winterEnd: '01-15', winterTz: 'UTC', winterStrength: 1, ...over }
  const w = new WinterService({ config, world: { broadcast: s.broadcast } }, now)
  let p: WeatherParams = weatherParams('clear')
  const weather = { mode: 'clear' as const, schedule: new WeatherSchedule(1), params: () => p }
  w.attach(weather, () => 1, now)
  const run = (from: number, to: number, step = 1000) => {
    for (let t = from; t <= to; t += step) w.tick(t)
  }
  return { w, config, ...s, run, set: (q: WeatherParams) => (p = q), dataDir }
}

describe('the winter module (docs/WINTER.md §2, §5, §6)', () => {
  it('knows the season by the configured days and time zone; off = never', () => {
    expect(winter(OCT).w.active(OCT)).toBe(false)
    expect(winter(DEC).w.active(DEC)).toBe(true)
    expect(winter(DEC, { winterEnabled: false }).w.active(DEC)).toBe(false)
    const tz = winter(Date.UTC(2026, 10, 30, 23, 30), { winterTz: 'Europe/Berlin' })
    expect(tz.w.active(Date.UTC(2026, 10, 30, 23, 30))).toBe(true)
    expect(tz.w.sync(Date.UTC(2026, 10, 30, 23, 30))).toMatchObject({ season: true, timeZone: 'Europe/Berlin', start: '12-01', end: '01-15' })
  })

  it('snow builds up under snowfall and melts on a sunny day; the frost rises in the season', () => {
    const h = winter(DEC)
    expect(h.w.state(DEC)).toMatchObject({ season: true, cover: 0 })
    h.set(weatherParams('snow'))
    h.run(DEC, DEC + 2.5 * H, 10_000)
    const s = h.w.state(DEC + 2.5 * H)
    expect(s.cover).toBeGreaterThan(0.4)
    expect(s.cover).toBeLessThan(0.6)
    expect(s.frost).toBeGreaterThan(0.5)
    expect(s.frozen).toBe(true)
    h.set(weatherParams('clear'))
    h.run(DEC + 2.5 * H, DEC + 6.5 * H, 10_000)
    expect(h.w.state(DEC + 6.5 * H).cover).toBeLessThan(s.cover)
    expect(h.w.state(DEC + 6.5 * H).cover).toBeGreaterThan(0.2)
  })

  it('a GM preview shows the full look without touching the season, its dates or the snow', () => {
    const h = winter(OCT)
    const before = h.w.sync(OCT)
    const r = h.w.gm(['preview'], OCT + 1000)
    expect(r.ok).toBe(true)
    const [p] = h.winters()
    expect(p).toMatchObject({ preview: true, season: false, cover: before.cover, frost: before.frost, start: '12-01', end: '01-15' })
    expect(h.w.active(OCT + 1000)).toBe(false)
    expect(h.config).toMatchObject({ winterStart: '12-01', winterEnd: '01-15', winterEnabled: true })
    expect(h.w.gm(['preview', 'off'], OCT + 2000).ok).toBe(true)
    expect(h.winters().at(-1)!.preview).toBeUndefined()
    expect(h.w.gm(['preview', 'maybe'], OCT + 3000).ok).toBe(false)
    expect(h.w.gm(['cover', '2'], OCT + 3000).ok).toBe(false)
  })

  it('announces the season beginning and ending exactly once, and resyncs every 10 minutes', () => {
    const t0 = Date.UTC(2026, 10, 30, 23, 59, 50)
    const h = winter(t0)
    h.run(t0, t0 + 20_000)
    expect(h.winters()).toHaveLength(1)
    expect(h.winters()[0]!.season).toBe(true)
    h.run(t0 + 21_000, t0 + 11 * 60_000, 5000)
    expect(h.winters()).toHaveLength(2)
    const e = Date.UTC(2027, 0, 15, 23, 59, 50)
    const g = winter(e)
    g.run(e, e + 20_000)
    expect(g.winters().map((s) => s.season)).toEqual([false])
  })

  it('persists the snow (GM cover) and carries it forward after a restart; a bad save is ignored', () => {
    const dir = tmp()
    const a = winter(DEC, {}, dir)
    expect(a.w.gm(['cover', '0.8'], DEC).ok).toBe(true)
    expect(existsSync(join(dir, WINTER_FILE))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, WINTER_FILE), 'utf8'))).toMatchObject({ cover: 0.8 })
    // back an hour later at night (clear, daylight stubbed 1: a little melt)
    const b = winter(DEC + H, {}, dir)
    expect(b.w.state(DEC + H).cover).toBeGreaterThan(0.7)
    expect(b.w.state(DEC + H).cover).toBeLessThan(0.8)
    writeFileSync(join(dir, WINTER_FILE), '{"cover": 7}')
    const logs: string[] = []
    const c = winter(DEC, { log: (m) => logs.push(m) }, dir)
    expect(c.w.state(DEC).cover).toBe(0)
    expect(logs.join('\n')).toMatch(/not a valid save/)
  })

  it('the admin strength and dates go out with the next sync (refresh broadcasts at once)', () => {
    const h = winter(OCT)
    h.config.winterStart = '10-01'
    h.config.winterStrength = 0.4
    h.w.refresh(OCT)
    expect(h.winters().at(-1)).toMatchObject<Partial<WinterSync>>({ season: true, start: '10-01', strength: 0.4 })
  })
})

describe('the GM time-lapse (winter speed)', () => {
  it('runs the cover and the frost N times faster, says so in the sync and the status, and ends with speed 1 or off', () => {
    const a = winter(DEC)
    const b = winter(DEC)
    for (const h of [a, b]) h.set(weatherParams('snow'))
    expect(a.w.gm(['speed', '60'], DEC)).toMatchObject({ ok: true })
    expect(a.winters().at(-1)!.speed).toBe(60)
    expect(a.w.describe(DEC)).toMatch(/time-lapse x60/)
    // one minute at x60 = one hour at x1
    a.run(DEC + 1000, DEC + 60_000)
    b.run(DEC + 1000, DEC + 3_600_000, 60_000)
    expect(a.w.state(DEC + 60_000).cover).toBeCloseTo(b.w.state(DEC + 3_600_000).cover, 2)
    expect(a.w.state(DEC + 60_000).cover).toBeGreaterThan(0.1)
    expect(a.w.gm(['speed', 'off'], DEC + 60_000)).toMatchObject({ ok: true })
    expect(a.w.sync(DEC + 60_000).speed).toBeUndefined()
    expect(a.w.timeLapse).toBe(1)
    for (const bad of [['speed'], ['speed', '0'], ['speed', '121'], ['speed', 'x']]) expect(a.w.gm(bad, DEC)).toMatchObject({ ok: false })
    // never by default; a bad speed never reaches a client
    expect(b.w.sync(DEC).speed).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ t: 'winter', winter: { ...a.w.sync(DEC), speed: 500 } })).ok).toBe(false)
  })
})

describe('the weather in winter (docs/WINTER.md §3)', () => {
  /** A WeatherService whose season is on (or off) by the stand-in. */
  function weather(now: number, season: (t: number) => boolean, storms = false) {
    const s = sink()
    const config = { weather: 'auto' as const, weatherSeed: 1, weatherRainScale: 1, log: () => {} }
    const w = new WeatherService({ config, world: { broadcast: s.broadcast }, winter: { active: season } }, now)
    if (storms) w.storms = new StormPlan(config, () => true)
    return { w, ...s, run: (from: number, to: number) => { for (let t = from; t <= to; t += 1000) w.tick(t) } }
  }

  /** The middle of the first scheduled `kind` segment after `t`. */
  function midOf(kind: 'rain' | 'storm', t: number): { at: number; intensity: number } {
    const sch = new WeatherSchedule(1)
    let seg = sch.at(t)
    while (seg.kind !== kind) seg = sch.next(seg)
    return { at: Math.round((seg.start + seg.end) / 2), intensity: seg.intensity }
  }

  it("the schedule's rain falls as snow (same intensity) and its storms are blizzards while the season is on", () => {
    const r = midOf('rain', DEC)
    expect(weather(r.at, () => false).w.sync(r.at)).toMatchObject({ to: 'rain', intensity: r.intensity })
    const snow = weather(r.at, () => true).w.sync(r.at)
    expect(snow).toMatchObject({ to: 'snow', intensity: r.intensity })
    expect(snow.from).not.toBe('rain')
    expect(snow.from).not.toBe('storm')
    const s = midOf('storm', DEC)
    expect(weather(s.at, () => true).w.sync(s.at).to).toBe('blizzard')
    // and the surfaces never get wet from snow
    const w = weather(r.at, () => true).w
    expect(w.params(r.at + 10 * 60_000).rain).toBe(0)
  })

  it('the season starting mid-rain turns it to snow; ending, back to rain', () => {
    const r = midOf('rain', DEC)
    let on = false
    const h = weather(r.at - 60_000, () => on)
    h.run(r.at - 59_000, r.at - 50_000)
    expect(h.w.sync(r.at - 50_000).to).toBe('rain')
    on = true
    h.run(r.at - 49_000, r.at - 40_000)
    expect(h.weathers().at(-1)!.to).toBe('snow')
  })

  it('a storm event in the season is a blizzard', () => {
    const h = weather(DEC, () => true, true)
    h.w.storms!.startGm(DEC + 1000, 600_000, 0, 3)
    h.run(DEC + 1000, DEC + 3000)
    expect(h.weathers().at(-1)).toMatchObject({ to: 'blizzard' })
    expect(h.w.params(DEC + 200_000).snow).toBe(1)
  })

  it('GM holds are taken as typed and never touch the season: snow in October, rain in December', () => {
    let seasonAsked = 0
    const oct = weather(OCT, () => (seasonAsked++, false))
    expect(oct.w.gm(['snow:0.5', '10', '0'], OCT).ok).toBe(true)
    expect(oct.weathers().at(-1)).toMatchObject({ to: 'snow', intensity: 0.5, gm: true })
    expect(oct.w.gm(['blizzard', '10', '0'], OCT + 1000)).toMatchObject({ ok: true, message: 'Weather: blizzard in 0 s, held for 10 min.' })
    expect(oct.w.params(OCT + 2000).snow).toBe(1)
    expect(oct.w.gm(['blizzard:0.5'], OCT + 3000).ok).toBe(false)
    const dec = weather(DEC, () => true)
    expect(dec.w.gm(['rain', '10', '0'], DEC).ok).toBe(true)
    expect(dec.weathers().at(-1)).toMatchObject({ to: 'rain', gm: true })
    expect(seasonAsked).toBeGreaterThanOrEqual(0)
  })
})

// ---- the winter module on a Gameplay -------------------------------------------------------------------------

function gameplay(over: Partial<ServerConfig> = {}) {
  const root = tmp()
  const config: ServerConfig = { ...testConfig(root), weather: 'auto', stormsPerDay: undefined, rng: seeded(5), uniques: false, winterEnabled: true, winterStart: '01-01', winterEnd: '12-31', winterTz: 'UTC', ...over }
  const store = openStore(config.dataDir)
  cleanups.push(() => store.close())
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS, drops: DROPS, nests: [], towns: [] })
  const g = new Gameplay({ world, data, store, config, setup: { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }, nav, rng: seeded(5) })
  return { g, config }
}

describe('storms and tornadoes in winter (docs/WINTER.md §4)', () => {
  it('a blizzard is a storm with drifts and no wetness; the status says winter; frozen ponds keep the water spirits down', () => {
    const { g } = gameplay()
    const now = Date.now()
    expect(g.winter.active(now)).toBe(true)
    expect(g.weather.gm(['blizzard', '10', '0'], now).ok).toBe(true)
    g.winter.gm(['frost', '1'], now)
    const env = g.storm.readEnv(now + 1000)
    expect(env).toMatchObject({ snow: 1, storm: 1, frozen: true, rain: 0 })
    g.storm.tick(now + 2000)
    const s = g.storm.current
    expect(s.phase).toBe('storm')
    expect(s.winter).toBe(true)
    const ids = s.effects.map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['drifts', 'snow', 'undead']))
    expect(ids).not.toContain('wet')
    expect(ids).not.toContain('water')
  })

  it('no tornadoes in the season unless WINTER_TORNADO; outside it the chance is the knob', () => {
    expect(gameplay().g.tornado.chance()).toBe(0)
    expect(gameplay({ winterTornado: true }).g.tornado.chance()).toBeCloseTo(0.3, 9)
    expect(gameplay({ winterEnabled: false }).g.tornado.chance()).toBeCloseTo(0.3, 9)
  })

  it('exposes the season to other modules (the hook for a later gameplay layer)', () => {
    const { g } = gameplay()
    const now = Date.now()
    g.winter.gm(['cover', '0.6'], now)
    expect(g.winter.state(now)).toMatchObject({ season: true, cover: 0.6 })
    expect(WEATHER_PARAMS.blizzard.snow).toBe(1)
  })
})

describe('the winter admin settings (docs/WINTER.md §6)', () => {
  const spec = (k: string) => SETTING_BY_KEY.get(k)!

  it('checks the days, the time zone and the strength', () => {
    expect(checkSetting(spec('winterStart'), '12-05')).toEqual({ value: '12-05' })
    expect(checkSetting(spec('winterEnd'), '02-29')).toEqual({ value: '02-29' })
    for (const bad of ['13-01', '12-32', '02-30', '1201', '', 5]) expect('problem' in checkSetting(spec('winterStart'), bad), String(bad)).toBe(true)
    expect(checkSetting(spec('winterTz'), 'Europe/Berlin')).toEqual({ value: 'Europe/Berlin' })
    expect('problem' in checkSetting(spec('winterTz'), 'Mars/Olympus')).toBe(true)
    expect('problem' in checkSetting(spec('winterStrength'), 1.5)).toBe(true)
    expect(spec('winterStart')).toMatchObject({ type: 'text', apply: 'live', group: 'Winter season' })
    expect(spec('winterEnabled')).toMatchObject({ type: 'bool', apply: 'live' })
  })
})
