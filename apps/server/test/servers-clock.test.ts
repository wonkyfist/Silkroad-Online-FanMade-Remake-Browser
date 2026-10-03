// Wave 10, lane SCR-P (docs/SCREENS.md §9, §12.6; docs/WAVE_PLAN6.md §3.2): ServerInfo carries the lobby's world clock
// and weather, on both GET /api/servers and the lobby socket's `welcome`; the lobby still never gets the world-only
// `worldClock` / `weather` messages; a malformed clock in `welcome` drops only the clock and the login still succeeds.
import { clockAt, validateServerMessage, type ServerInfo, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client, api, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

type Welcome = Extract<ServerMessage, { t: 'welcome' }>

function welcomeOf(c: Client): Welcome {
  const w = c.log.find((m) => m.t === 'welcome')
  if (!w) throw new Error('no welcome')
  return w as Welcome
}

/** Game seconds between solar time `t` and hh:mm. */
function offBy(t: number, hh: number, mm: number): number {
  let d = (t - (hh * 60 + mm) / 1440) * 86_400
  if (d > 43_200) d -= 86_400
  if (d < -43_200) d += 86_400
  return Math.abs(d)
}

describe('ServerInfo clock and weather (docs/SCREENS.md §9)', () => {
  let s: TestServer
  let counter = 0

  beforeAll(async () => {
    s = await startTestServer({ config: { dayLengthMin: 120, weather: 'auto' } })
  })

  afterAll(async () => {
    s.ctx.gameplay.clock.gm(['reset'])
    await s.stopAndClean()
  })

  async function lobby(prefix = 'svc') {
    const acc = await newAccount(s.url, prefix)
    return Client.login(s.url, acc.token)
  }

  it('GET /api/servers carries the running clock anchor and the current weather, and they validate', async () => {
    const r = await api(s.url, '/api/servers')
    expect(r.status).toBe(200)
    const [info] = r.json as ServerInfo[]
    expect(info).toMatchObject({ id: 'jangan', status: 'online' })
    expect(info.clock).toEqual(s.ctx.gameplay.clock.state)
    expect(info.clock!.running).toBe(true)
    const now = s.ctx.gameplay.weather.sync()
    expect(info.weather).toMatchObject({ to: now.to, from: now.from, intensity: now.intensity, seed: now.seed, start: now.start })
    expect(info.weather!.at).toBeLessThanOrEqual(Date.now())
    // The same object passes the client's strict `welcome` validator with both fields kept.
    const v = validateServerMessage({ t: 'welcome', account: 'x', server: info, slots: 4 })
    expect(v.ok).toBe(true)
    if (v.ok && v.msg.t === 'welcome') {
      expect(v.msg.server.clock).toEqual(info.clock)
      expect(v.msg.server.weather).toEqual(info.weather)
    }
  })

  it('welcome.server carries the clock and weather; a GM change shows on the next welcome, never as a lobby message', async () => {
    const idle = await lobby()
    const w = welcomeOf(idle)
    expect(w.server.clock).toEqual(s.ctx.gameplay.clock.state)
    expect(w.server.weather).toBeDefined()
    expect(w.server.weather!.to).toBe(s.ctx.gameplay.weather.sync().to)

    // A GM (on the server, as the gm CLI or a world GM would) sets the time and holds rain.
    expect(s.ctx.gameplay.clock.gm(['18:30']).ok).toBe(true)
    expect(s.ctx.gameplay.weather.gm(['rain:0.8', '10', '0']).ok).toBe(true)

    // The idle lobby socket is not told (no worldClock, no weather): cosmetic, it sees it at the next welcome.
    await idle.none('worldClock', 250)
    await idle.none('weather', 1)

    const fresh = await lobby()
    const w2 = welcomeOf(fresh)
    expect(w2.server.clock).toEqual(s.ctx.gameplay.clock.state)
    expect(w2.server.clock).not.toEqual(w.server.clock)
    expect(offBy(clockAt(w2.server.clock!, Date.now()).t, 18, 30)).toBeLessThan(60)
    expect(w2.server.weather).toMatchObject({ to: 'rain', intensity: 0.8, gm: true })
    const listed = (await api(s.url, '/api/servers')).json as ServerInfo[]
    expect(listed[0].clock).toEqual(w2.server.clock)
    expect(listed[0].weather).toMatchObject({ to: 'rain', gm: true })

    s.ctx.gameplay.clock.gm(['reset'])
    s.ctx.gameplay.weather.gm(['auto'])
    for (const c of [idle, fresh]) c.close()
    await sleep(20)
  })

  it('a malformed clock in welcome drops only the clock; the login still succeeds', async () => {
    const real = s.ctx.serverInfo
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    s.ctx.serverInfo = () => ({ ...real(), clock: { ...s.ctx.gameplay.clock.state, dayMs: -5, running: 'yes' as unknown as boolean } })
    try {
      const c = await lobby('bad')
      const w = welcomeOf(c)
      expect(w.server.clock).toBeUndefined()
      expect(w.server.weather).toBeDefined()
      expect(w.server).toMatchObject({ id: 'jangan', status: 'online' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('server.clock'))
      // The lobby still works after it: create a character and enter the world, whose worldEnter keeps its own clock.
      c.send({ t: 'charCreate', name: `Svc${++counter}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
      const ch = (await c.next('charCreated')).character
      c.send({ t: 'enterWorld', id: ch.id })
      const enter = await c.next('worldEnter')
      expect(enter.world.clock).toEqual(s.ctx.gameplay.clock.state)
      c.close()
      // A malformed weather drops only the weather.
      warn.mockClear()
      s.ctx.serverInfo = () => ({ ...real(), weather: { ...s.ctx.gameplay.weather.sync(), to: 'hail' as never } })
      const c2 = await lobby('bad')
      const w2 = welcomeOf(c2)
      expect(w2.server.weather).toBeUndefined()
      expect(w2.server.clock).toEqual(s.ctx.gameplay.clock.state)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('server.weather'))
      c2.close()
    } finally {
      s.ctx.serverInfo = real
      warn.mockRestore()
    }
    await sleep(20)
  })
})

describe('ServerInfo with WEATHER=off', () => {
  let s: TestServer

  beforeAll(async () => {
    s = await startTestServer({ config: { weather: 'off' } })
  })

  afterAll(async () => {
    await s.stopAndClean()
  })

  it('still carries the clock, and the weather is clear', async () => {
    const acc = await newAccount(s.url, 'off')
    const c = await Client.login(s.url, acc.token)
    const w = welcomeOf(c)
    expect(w.server.clock).toEqual(s.ctx.gameplay.clock.state)
    expect(w.server.weather).toMatchObject({ from: 'clear', to: 'clear' })
    c.close()
    await sleep(20)
  })
})
