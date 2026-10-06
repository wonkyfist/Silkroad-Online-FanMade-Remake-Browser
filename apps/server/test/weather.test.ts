import { LIGHTNING_MIN_GAP_MS, WeatherSchedule, parseServerMessage, type Role, type ServerMessage, type WeatherSync } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, type WeatherMode } from '../src/config.ts'
import { WeatherService } from '../src/weather.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0)

/** A WeatherService on a stand-in host that records (and client-validates) every broadcast. */
function service(weather: WeatherMode = 'auto', now = T0, seed = 1) {
  const sent: ServerMessage[] = []
  const logs: string[] = []
  const host = {
    config: { weather, weatherSeed: seed, weatherRainScale: 1, log: (m: string) => logs.push(m) },
    world: {
      broadcast(msg: ServerMessage) {
        const r = parseServerMessage(JSON.stringify(msg))
        if (!r.ok) throw new Error(`the client would reject ${JSON.stringify(msg)}: ${r.error}`)
        sent.push(msg)
      },
    },
  }
  const w = new WeatherService(host, now)
  const of = <T extends ServerMessage['t']>(t: T) => sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[]
  /** Ticks once a second over [from, to]. */
  const run = (from: number, to: number) => {
    for (let t = from; t <= to; t += 1000) w.tick(t)
  }
  return { w, sent, of, run, logs }
}

describe('WeatherService (docs/WEATHER.md §2–§4)', () => {
  it('joins the schedule where it is and broadcasts a schedule change exactly once', () => {
    // the end of the current run of one state (same state and intensity), from the schedule itself
    const sch = new WeatherSchedule(1)
    let seg = sch.at(T0)
    while (sch.next(seg).kind === seg.kind && sch.next(seg).intensity === seg.intensity) seg = sch.next(seg)
    const end = seg.end
    const next = sch.next(seg)
    const { w, of, run } = service('auto', end - 5000)
    expect(w.sync(end - 5000)).toMatchObject({ to: seg.kind, until: end })
    run(end - 4000, end + 30_000)
    const changes = of('weather')
    expect(changes).toHaveLength(1)
    expect(changes[0].weather).toMatchObject({ from: seg.kind, to: next.kind, start: end, intensity: next.intensity, seed: next.seed })
    expect(changes[0].weather.gm).toBeUndefined()
  })

  it('`weather storm 5 0` holds a storm at once (gm: true); the hold ends by itself; `weather auto` clears it', () => {
    const { w, of, run } = service('auto', T0)
    const r = w.gm(['storm', '5', '0'], T0 + 1000)
    expect(r.ok).toBe(true)
    expect(r.message).toBe('Weather: storm in 0 s, held for 5 min.')
    const [held] = of('weather')
    expect(held.weather).toMatchObject({ to: 'storm', gm: true, dur: 0, start: T0 + 1000, until: T0 + 1000 + 300_000 })
    expect(r.data).toMatchObject({ to: 'storm', gm: true })
    run(T0 + 2000, T0 + 290_000)
    expect(of('weather')).toHaveLength(1) // no repeats while held
    run(T0 + 291_000, T0 + 310_000)
    const after = of('weather')
    expect(after).toHaveLength(2)
    expect(after[1].weather.gm).toBeUndefined()
    expect(after[1].weather.from).toBe('storm')
    // hold rain:0.6, then auto
    expect(w.gm(['rain:0.6'], T0 + 400_000)).toMatchObject({ ok: true, message: 'Weather: rain:0.6 in 60 s, held for 30 min.' })
    expect(of('weather')[2].weather).toMatchObject({ to: 'rain', intensity: 0.6, gm: true, dur: 60_000 })
    const back = w.gm(['auto'], T0 + 410_000)
    expect(back.ok).toBe(true)
    const last = of('weather')[3].weather
    expect(last.gm).toBeUndefined()
    expect(last.dur).toBe(60_000)
    expect(last.to).toBe(new WeatherSchedule(1).at(T0 + 410_000).kind)
  })

  it('`weather strike` sends one lightning; strikes are at least 4 s apart, scheduled or forced', () => {
    const { w, of, run } = service('auto', T0)
    expect(w.gm(['strike', '800'], T0).ok).toBe(true)
    expect(of('lightning')).toEqual([{ t: 'lightning', at: T0, distM: 800, bearing: expect.any(Number) }])
    expect(w.gm(['strike'], T0 + 2000)).toMatchObject({ ok: false })
    expect(w.gm(['strike', '50'], T0 + 9000)).toMatchObject({ ok: false })
    expect(of('lightning')).toHaveLength(1)
    // a held storm rolls about 5 a minute
    w.gm(['storm', '30', '0'], T0 + 10_000)
    run(T0 + 11_000, T0 + 11_000 + 10 * 60_000)
    const strikes = of('lightning')
    expect(strikes.length).toBeGreaterThan(15)
    expect(strikes.length).toBeLessThan(80)
    for (let i = 1; i < strikes.length; i++) expect(strikes[i].at - strikes[i - 1].at).toBeGreaterThanOrEqual(LIGHTNING_MIN_GAP_MS)
    for (const s of strikes.slice(1)) {
      expect(s.distM).toBeGreaterThanOrEqual(300)
      expect(s.distM).toBeLessThanOrEqual(3000)
    }
    // clear weather: none
    w.gm(['clear', '30', '0'], T0 + 20 * 60_000)
    const n = of('lightning').length
    run(T0 + 20 * 60_000 + 1000, T0 + 30 * 60_000)
    expect(of('lightning')).toHaveLength(n)
  })

  it('surfaces soak in a storm and dry after; `weather wet` sets them (puddle ≤ wet + 0.1); `weather wind` overrides', () => {
    const { w, of, run } = service('clear', T0)
    expect(w.sync(T0)).toMatchObject({ to: 'clear', wet: 0, puddle: 0 })
    w.gm(['storm', '10', '0'], T0)
    run(T0 + 1000, T0 + 180_000)
    expect(w.sync(T0 + 180_000).wet).toBeGreaterThan(0.95)
    expect(w.sync(T0 + 180_000).puddle).toBeGreaterThan(0.5)
    w.gm(['auto'], T0 + 181_000) // back to WEATHER=clear
    run(T0 + 182_000, T0 + 181_000 + 20 * 60_000)
    expect(w.sync(T0 + 181_000 + 20 * 60_000)).toMatchObject({ wet: 0, puddle: 0 })
    expect(w.gm(['wet', '0.2', '0.9'], T0 + 1_500_000).ok).toBe(true)
    expect(of('weather').at(-1)!.weather).toMatchObject({ wet: 0.2, puddle: 0.3, at: T0 + 1_500_000 })
    expect(w.gm(['wind', '12', '90'], T0 + 1_501_000).ok).toBe(true)
    expect(of('weather').at(-1)!.weather).toMatchObject({ windMs: 12, windDir: Math.PI / 2 })
    expect(w.params(T0 + 1_502_000).windMs).toBe(12)
    for (const bad of [['wind', '31'], ['wind', '5', '360'], ['wet', '1.5'], ['wet', '0.5', '-1'], ['hail'], ['clear:0.5'], ['blizzard:0.5'], ['rain:0.2'], ['rain', '0'], ['rain', '5', '601'], ['storm', 'x']]) {
      expect(w.gm(bad, T0 + 1_503_000).ok, bad.join(' ')).toBe(false)
    }
    // the status line
    const st = w.gm([], T0 + 1_504_000)
    expect(st.ok).toBe(true)
    expect(st.message).toMatch(/^Weather: clear; fixed \(WEATHER=clear\); wet 0\.\d+, puddles 0\.\d+; wind 12 m\/s toward 90° \(GM\)\.$/)
  })

  it('resends the state every 10 minutes', () => {
    const { of, run } = service('overcast', T0)
    run(T0, T0 + 25 * 60_000)
    expect(of('weather').map((m) => m.weather.at - T0)).toEqual([600_000, 1_200_000])
  })

  it('WEATHER=off: always clear, never a message, GM changes refused', () => {
    const { w, sent, run } = service('off', T0)
    run(T0, T0 + 30 * 60_000)
    expect(w.gm(['storm'], T0).ok).toBe(false)
    expect(w.gm(['strike'], T0).ok).toBe(false)
    expect(w.gm([], T0).ok).toBe(true)
    expect(sent).toEqual([])
    expect(w.sync(T0 + 1000)).toMatchObject({ from: 'clear', to: 'clear', wet: 0, puddle: 0 })
  })

  it('a restart lands on the same weather and a warmed-up surface', () => {
    const a = service('auto', T0).w.sync(T0)
    const b = service('auto', T0).w.sync(T0)
    expect(b).toEqual(a)
    expect(service('rain', T0).w.sync(T0).wet).toBeGreaterThan(0.9) // 90 minutes of rain before the start
  })

  it('reads WEATHER, WEATHER_SEED and WEATHER_RAIN_SCALE', () => {
    expect(loadConfig({})).toMatchObject({ weather: 'auto', weatherSeed: 1, weatherRainScale: 1 })
    expect(loadConfig({ WEATHER: 'Off', WEATHER_SEED: '4294967295', WEATHER_RAIN_SCALE: '2' })).toMatchObject({ weather: 'off', weatherSeed: 4294967295, weatherRainScale: 2 })
    expect(loadConfig({ WEATHER: 'storm' }).weather).toBe('storm')
    expect(() => loadConfig({ WEATHER: 'hail' })).toThrow(/WEATHER/)
    expect(() => loadConfig({ WEATHER_RAIN_SCALE: '4' })).toThrow(/WEATHER_RAIN_SCALE/)
    expect(() => loadConfig({ WEATHER_SEED: '-1' })).toThrow(/WEATHER_SEED/)
  })
})

describe('weather over the wire', () => {
  let counter = 0

  async function player(s: TestServer, role: Role = 'player') {
    const acc = await newAccount(s.url, role === 'player' ? 'wx' : 'wxgm')
    if (role !== 'player') s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role)
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Rain${++counter}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    return { c, enter: await c.next('worldEnter') }
  }

  describe('WEATHER=auto', () => {
    let s: TestServer
    beforeAll(async () => {
      s = await startTestServer({ config: { weather: 'auto' } })
    })
    afterAll(async () => {
      await s.stopAndClean()
    })

    it('worldEnter carries the weather; `/weather rain` reaches everyone; a strike reaches everyone', async () => {
      const gm = await player(s, 'gm')
      const p = await player(s)
      const w: WeatherSync = p.enter.world.weather!
      expect(w.to).toBe(new WeatherSchedule(1).at(Date.now()).kind)
      gm.c.send({ t: 'chat', text: '/weather rain' })
      const res = await gm.c.next('gmResult')
      expect(res).toMatchObject({ ok: true, cmd: 'weather', message: 'Weather: rain in 60 s, held for 30 min.' })
      for (const c of [gm.c, p.c]) expect((await c.next('weather', (m) => m.weather.gm === true)).weather).toMatchObject({ to: 'rain', gm: true, dur: 60_000 })
      // a late joiner gets the held state
      const late = await player(s)
      expect(late.enter.world.weather).toMatchObject({ to: 'rain', gm: true })
      gm.c.send({ t: 'gm', cmd: 'weather', args: ['strike', '1200'] })
      expect((await gm.c.next('gmResult')).ok).toBe(true)
      for (const c of [gm.c, p.c, late.c]) expect(await c.next('lightning')).toMatchObject({ distM: 1200 })
      // players cannot
      p.c.send({ t: 'chat', text: '/weather storm' })
      expect((await p.c.next('error')).code).toBe('forbidden')
      s.ctx.gameplay.weather.gm(['auto'])
      for (const c of [gm.c, p.c, late.c]) c.close()
      await sleep(20)
    })
  })

  describe('WEATHER=off', () => {
    let s: TestServer
    beforeAll(async () => {
      s = await startTestServer({ config: { weather: 'off' } })
    })
    afterAll(async () => {
      await s.stopAndClean()
    })

    it('sends a clear enter sync and nothing after it', async () => {
      const gm = await player(s, 'gm')
      expect(gm.enter.world.weather).toMatchObject({ from: 'clear', to: 'clear', wet: 0 })
      gm.c.send({ t: 'gm', cmd: 'weather', args: ['storm'] })
      expect(await gm.c.next('gmResult')).toMatchObject({ ok: false, message: 'Weather is off on this server (WEATHER=off).' })
      await gm.c.none('weather', 1500)
      await gm.c.none('lightning', 0)
      gm.c.close()
      await sleep(20)
    })
  })
})
