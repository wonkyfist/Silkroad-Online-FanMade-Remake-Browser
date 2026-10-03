/**
 * W9F adversarial hunt, lens = protocol (worldClock / weather / lightning). The real server modules
 * (apps/server/src/weather.ts, world-clock.ts) talk to the real client mirror (WeatherClient) through the client's own
 * parser, as the wire does. The `it`s under "problems" fail on ef535d4 and each names a real defect; the rest pin what
 * held up.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { clockAt, parseServerMessage, type ServerMessage, type WeatherSync } from '@sro/shared'
import { WeatherService } from '../../server/src/weather.ts'
import { WorldClock } from '../../server/src/world-clock.ts'
import { WeatherClient } from '../src/world/features/weather.ts'

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0)

/** A WeatherService whose broadcasts go through the client's own parser (as the wire does). */
function service(mode: 'auto' | 'off' = 'auto', now = T0) {
  const sent: ServerMessage[] = []
  const host = {
    config: { weather: mode, weatherSeed: 1, weatherRainScale: 1, log: () => {} },
    world: {
      broadcast(msg: ServerMessage) {
        const r = parseServerMessage(JSON.stringify(msg))
        if (!r.ok) throw new Error(`the client would reject ${JSON.stringify(msg)}: ${r.error}`)
        sent.push(r.msg)
      },
    },
  }
  return { w: new WeatherService(host, now), sent }
}

/** A client that was in the world all along: every broadcast reaches it at its server time. */
function follower(w: WeatherService, sent: ServerMessage[], now: number) {
  const c = new WeatherClient(null, now)
  c.enter(w.sync(now), now)
  let seen = sent.length
  const pump = (t: number) => {
    for (; seen < sent.length; seen++) {
      const m = sent[seen]!
      if (m.t === 'weather') c.message(m.weather, t)
    }
  }
  return { c, pump }
}

function tmpClock() {
  const dir = mkdtempSync(join(tmpdir(), 'w9f-proto-'))
  const cfg = { dataDir: dir, log: () => {}, dayLengthMin: 120, dayNightSpeedup: 0.4, daySeasonDeg: 12 }
  return { dir, cfg, clock: WorldClock.load(cfg), done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('W9F protocol: problems', () => {
  it('P1a: a late joiner during a transition away from light rain renders the same rain as the players already there', () => {
    const { w, sent } = service()
    const early = follower(w, sent, T0)
    // a GM holds light rain (rain:0.4, reached at once), then clears it over 120 s
    w.gm(['rain:0.4', '30', '0'], T0)
    early.pump(T0)
    for (let t = T0; t <= T0 + 600_000; t += 1000) {
      w.tick(t)
      early.pump(t)
    }
    const t1 = T0 + 600_000
    w.gm(['clear', '30', '120'], t1)
    early.pump(t1)
    // a friend logs in 20 s into the transition
    const tj = t1 + 20_000
    const late = new WeatherClient(null, tj)
    late.enter(w.sync(tj), tj)
    const server = w.params(tj).rain
    expect(early.c.params(tj).rain).toBeCloseTo(server, 6) // the players already there agree with the server
    // The late joiner blends from P[rain] at intensity 1 (WeatherSync carries no start vector / from-intensity):
    // 0.51 against 0.20 on everyone else's screen (and in the rain audio), for the whole transition.
    expect(late.params(tj).rain).toBeCloseTo(server, 2)
  })

  it('P1b: a late joiner after a change that started mid-transition sees the same sky as the others', () => {
    const { w, sent } = service()
    w.gm(['clear', '30', '0'], T0)
    for (let t = T0; t <= T0 + 60_000; t += 1000) w.tick(t)
    const t1 = T0 + 60_000
    const early = follower(w, sent, t1)
    w.gm(['storm', '30', '60'], t1)
    early.pump(t1)
    // the GM changes their mind 40 s into the storm transition: `from` is only nearestWeather(current) ('rain')
    const t2 = t1 + 40_000
    w.gm(['clear', '30', '120'], t2)
    early.pump(t2)
    const tj = t2 + 10_000
    const late = new WeatherClient(null, tj)
    late.enter(w.sync(tj), tj)
    const s = w.params(tj)
    const e = early.c.params(tj)
    const l = late.params(tj)
    expect(e.cloud).toBeCloseTo(s.cloud, 6)
    expect(e.windMs).toBeCloseTo(s.windMs, 6)
    // late joiner: cloud 0.93 vs 0.75, sun 0.26 vs 0.38, wind 5.9 vs 10.0 m/s, rain 0.55 vs 0.38
    expect(Math.abs(l.cloud - s.cloud)).toBeLessThan(0.02)
    expect(Math.abs(l.sun - s.sun)).toBeLessThan(0.02)
    expect(Math.abs(l.windMs - s.windMs)).toBeLessThan(0.5)
  })

  it('P2: a tab that got no frames through a transition (hidden, a load stall) keeps its puddles with the server', () => {
    const { w, sent } = service()
    w.gm(['clear', '60', '0'], T0)
    for (let t = T0; t <= T0 + 30_000; t += 1000) w.tick(t)
    const t0 = T0 + 30_000
    const hidden = follower(w, sent, t0)
    const shown = follower(w, sent, t0)
    const t1 = T0 + 31_000
    w.gm(['storm', '60', '120'], t1) // clear -> storm over 120 s (the rain lags in from k = 0.55)
    hidden.pump(t1)
    shown.pump(t1)
    hidden.c.frame(t1, 0.016)
    const tz = t1 + 120_000
    for (let t = t1; t <= tz; t += 250) {
      if ((t - t1) % 1000 === 0) w.tick(t)
      // the WebSocket still delivers while the tab is hidden; only the frames stop
      hidden.pump(t)
      shown.pump(t)
      shown.c.frame(t, 0.25)
    }
    const s = w.sync(tz)
    expect(shown.c.lastFrame!.puddle).toBeCloseTo(s.puddle, 2) // a client with frames agrees (0.130 vs 0.132)
    // The first frame back integrates all 120 s with the END params (full storm rain), though the server's rain only
    // began ~66 s in: puddles 0.50 against the server's 0.13 (wet 0.95 vs 0.60), until the next resync (<= 10 min).
    const back = hidden.c.frame(tz, 1)
    expect(Math.abs(back.puddle - s.puddle)).toBeLessThan(0.02)
    expect(Math.abs(back.wet - s.wet)).toBeLessThan(0.02)
  })

  it('P3: `time 18:00` after the clock ran past day 1e6 lands at 18:00 (or is refused), never silently at midnight', () => {
    const t = tmpClock()
    try {
      expect(t.clock.gm(['day', '999999'], T0).ok).toBe(true) // the largest day the GM may type
      const later = T0 + 2 * 3_600_000 // two real hours = one game day at the default length: day 1000000
      const r = t.clock.gm(['18:00'], later)
      const { t: solar } = clockAt(t.clock.state, later)
      // On ef535d4: ok, "Clock set: Day 1000000, 00:00". anchored() clamps anchorDays to 1e6, so the out-of-range
      // check after it never fires and the time of day is thrown away (freeze/resume/length/night do the same).
      if (r.ok) expect(Math.abs(solar - 0.75) * 1440).toBeLessThan(1)
      else expect(r.message).toMatch(/range/)
    } finally {
      t.done()
    }
  })
})

describe('W9F protocol: what held up', () => {
  const clock = { anchorMs: T0, anchorDays: 3.3, dayMs: 7_200_000, running: true, nightSpeedup: 0.4, declination: 12 }
  const weather: WeatherSync = { start: T0, dur: 60_000, from: 'clear', to: 'rain', intensity: 0.6, until: T0 + 1e6, windDir: 1, windMs: 6, wet: 0.2, puddle: 0.1, at: T0, seed: 5 }
  const enter = (world: Record<string, unknown>) =>
    JSON.stringify({
      t: 'worldEnter',
      self: { id: 1, kind: 'mob', name: 'Mangnyang', model: 'MOB_CH_MANGNYANG', level: 1, pos: [0, 0, 0], yaw: 0 },
      world: { name: 'jangan', serverTime: 1, tickRate: 10, ...world },
      entities: [],
    })

  it('both wave-9 fields malformed at once (null, array, wrong types) still leave a worldEnter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const [c, w] of [
        [null, null],
        [[], []],
        [{ ...clock, anchorMs: 1.5 }, { ...weather, gm: null }],
        [{ ...clock, running: 'yes' }, { ...weather, windDir: 6.3 }],
      ]) {
        const r = parseServerMessage(enter({ clock: c, weather: w, levelCap: 20 }))
        expect(r.ok).toBe(true)
        if (!r.ok || r.msg.t !== 'worldEnter') continue
        expect(r.msg.world.clock).toBeUndefined()
        expect(r.msg.world.weather).toBeUndefined()
        expect(r.msg.world.levelCap).toBe(20)
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('every GM weather edge the server accepts is one the client accepts (GM spam, then a day of ticks); strikes >= 4 s apart', () => {
    const { w, sent } = service()
    const cmds = [['rain:0.4', '1', '0'], ['wind', '30', '359.9999999'], ['storm', '1440', '600'], ['wet', '1', '1'], ['strike', '100'], ['strike', '3000'], ['rain:0.40499'], ['fog'], ['auto'], ['wind', '0', '0']]
    let t = T0
    for (let i = 0; i < 200; i++) {
      w.gm(cmds[i % cmds.length]!, t) // the service's broadcast throws if the client would reject a frame
      t += 1500
      w.tick(t)
    }
    for (const end = t + 86_400_000; t <= end; t += 1000) w.tick(t)
    const strikes = sent.filter((m) => m.t === 'lightning') as Extract<ServerMessage, { t: 'lightning' }>[]
    expect(strikes.length).toBeGreaterThan(10)
    for (let i = 1; i < strikes.length; i++) expect(strikes[i]!.at - strikes[i - 1]!.at).toBeGreaterThanOrEqual(4000)
  })

  it('WEATHER=off: GM changes refused and nothing broadcast over a day', () => {
    const { w, sent } = service('off')
    for (const a of [['storm'], ['strike'], ['wet', '1'], ['wind', '5'], ['auto']]) expect(w.gm(a, T0).ok).toBe(false)
    expect(w.gm([], T0).ok).toBe(true)
    for (let t = T0; t <= T0 + 86_400_000; t += 1000) w.tick(t)
    expect(sent).toEqual([])
    expect(w.sync(T0 + 86_400_000)).toMatchObject({ from: 'clear', to: 'clear', wet: 0, puddle: 0 })
  })

  it('a GM clock change survives a restart and wins over new DAY_* keys; a weather hold ends (as documented)', () => {
    const t = tmpClock()
    try {
      expect(t.clock.gm(['freeze'], T0).ok).toBe(true)
      const again = WorldClock.load({ ...t.cfg, dayLengthMin: 60, dayNightSpeedup: 0, daySeasonDeg: 0 })
      expect(again.state).toEqual(t.clock.state)
      expect(again.state.running).toBe(false)
      expect(again.gm(['reset'], T0).ok).toBe(true)
      expect(WorldClock.load(t.cfg).state.running).toBe(true)
    } finally {
      t.done()
    }
    const a = service('auto', T0)
    a.w.gm(['storm', '1440', '0'], T0)
    expect(a.w.sync(T0).gm).toBe(true)
    const b = service('auto', T0 + 60_000)
    expect(b.w.sync(T0 + 60_000).gm).toBeUndefined()
  })
})
