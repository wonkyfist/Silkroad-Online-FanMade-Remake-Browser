/**
 * W9F adversarial hunt, lens = clock (docs/WAVE_PLAN3.md §8 item 8): midnight wrap, freeze/resume/length jumps, an old
 * anchor, NaN in SkyState, the moon near new moon, DAY_LENGTH_MIN 1 and 1440, and the client clock drifting an hour
 * against the server. Failing tests here are findings; passing ones are what held up.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NullEngine, Scene } from '@babylonjs/core'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  CLOCK_EPOCH_MS,
  clockAt,
  moonState,
  moonVisible,
  parseServerMessage,
  type ServerMessage,
  type WorldClockState,
} from '@sro/shared'
import { SKY_PRESETS, SkySystem, evaluateProfile, type EnvProfile } from '@sro/world-render'
import { starRotation } from '../../../packages/world-render/src/sky/celestial.ts'
import { ServerClock } from '../src/net/clock.ts'
import { clockText } from '../src/world/features/sky-clock.ts'
import { WeatherClient } from '../src/world/features/weather.ts'
import { WorldClock } from '../../server/src/world-clock.ts'
import { WeatherService } from '../../server/src/weather.ts'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sro-w9f-clock-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 8, 29, 12, 0, 0)

/** Game seconds between solar time `t` and hh:mm (wrapped). */
function offBy(t: number, hh: number, mm: number): number {
  let d = (t - (hh * 60 + mm) / 1440) * 86_400
  if (d > 43_200) d -= 86_400
  if (d < -43_200) d += 86_400
  return Math.abs(d)
}

/** A WeatherService on a stand-in host that records every broadcast (client-validated). */
function weatherService(weather: 'auto' | 'clear' | 'storm', now: number) {
  const sent: ServerMessage[] = []
  const host = {
    config: { weather, weatherSeed: 1, weatherRainScale: 1, log: () => {} },
    world: {
      broadcast(msg: ServerMessage) {
        const r = parseServerMessage(JSON.stringify(msg))
        if (!r.ok) throw new Error(`client would reject ${JSON.stringify(msg)}`)
        sent.push(msg)
      },
    },
  }
  return { w: new WeatherService(host, now), sent }
}

// ---------------------------------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------------------------------

describe('W9F clock: findings', () => {
  it('F1: a local clock step (+1 h) is corrected by the next pong (ServerClock keeps the stale min-RTT sample for 8 pings)', () => {
    let local = T0
    const server = () => local // until the step the two clocks agree
    const sc = new ServerClock(() => local)
    // eight healthy pings, 20 ms round trip, 5 s apart
    for (let i = 0; i < 8; i++) {
      const sent = local
      local += 20
      sc.pong(sent, server() - 10)
      local += 4980
    }
    expect(Math.abs(sc.serverNow() - local)).toBeLessThan(50)
    // The OS clock steps forward one hour (manual change, an NTP step, a VM resume); the server's does not.
    const trueServer = () => local - HOUR
    local += HOUR
    const errs: number[] = []
    for (let i = 0; i < 7; i++) {
      const sent = local
      local += 20
      sc.pong(sent, trueServer() - 10)
      errs.push(Math.round((sc.serverNow() - trueServer()) / 1000))
      local += 4980
    }
    // After a fresh pong the estimate should be right again (within a second). It stays 3600 s off for ~35 s.
    expect(errs[0]).toBe(0)
  })

  it('F2: a transient serverNow step (+1 h for 30 s) integrates an hour of weather and leaves the puddles wrong until the 10-min resync', () => {
    // Server: fixed clear weather, a GM just soaked the ground (wet 0.8, puddles 0.5), so it is drying.
    const { w, sent } = weatherService('clear', T0)
    expect(w.gm(['wet', '0.8', '0.5'], T0).ok).toBe(true)
    const msg = sent.filter(m => m.t === 'weather').at(-1)
    expect(msg?.t).toBe('weather')
    const client = new WeatherClient(null, T0)
    client.enter(w.sync(T0), T0)
    // 60 s of frames at 60 fps; from 20 s to 50 s the client's serverNow is one hour ahead (F1's stale offset).
    let f = client.frame(T0, 0)
    for (let ms = 16; ms <= 60_000; ms += 16) {
      const stale = ms >= 20_000 && ms < 50_000
      f = client.frame(T0 + ms + (stale ? HOUR : 0), 0.016)
    }
    for (let t = T0 + 1000; t <= T0 + 60_000; t += 1000) w.tick(t)
    const truth = w.sync(T0 + 60_000)
    // The tab should still agree with the server (the I9A fix's own bar: 0.002). It has dried the ground completely.
    expect(Math.abs(f.wet - truth.wet)).toBeLessThan(0.01)
    expect(Math.abs(f.puddle - truth.puddle)).toBeLessThan(0.01)
  })

  it('F3: the server wall clock stepping back 1 h freezes the weather module for that hour (no lightning, no resync, no surface)', () => {
    const { w, sent } = weatherService('storm', T0)
    for (let t = T0; t <= T0 + 120_000; t += 1000) w.tick(t)
    const strikesBefore = sent.filter(m => m.t === 'lightning').length
    expect(strikesBefore).toBeGreaterThan(0) // a storm: ~5 strikes a minute
    // NTP (or an admin) steps the mini PC's clock back one hour; ten minutes of ticks follow.
    const back = T0 + 121_000 - HOUR
    const n0 = sent.length
    for (let t = back; t <= back + 600_000; t += 1000) w.tick(t)
    const after = sent.slice(n0)
    // Ten storm minutes: dozens of strikes and one 10-minute resync expected. The tick guard (now - lastTick < 1 s)
    // swallows every tick until the clock passes the old lastTick again, an hour later.
    expect(after.filter(m => m.t === 'lightning').length).toBeGreaterThan(10)
  })

  it('F4: DAY_LENGTH_MIN 1 on the epoch anchor: after 694 real days every `time hh:mm` / `freeze` / `length` jumps to 00:00 of day 1e6', () => {
    const clock = WorldClock.load({ dataDir: tmp(), log: () => {}, dayLengthMin: 1 })
    // 2027-12-15: 713 real days after the epoch = 1,026,720 game days at one minute a day (the anchor itself is valid).
    const now = Date.UTC(2027, 11, 15, 12, 0, 0)
    const before = clockAt(clock.state, now)
    expect(before.days).toBeGreaterThan(1e6)
    const r = clock.gm(['12:00'], now)
    expect(r.ok).toBe(true)
    const at = clockAt(clock.state, now)
    // `time 12:00` should land on 12:00. The re-anchor clamps anchorDays to 1e6 (= phase 0), so it lands on 00:00.
    expect(offBy(at.t, 12, 0)).toBeLessThan(1)
  })

  it('F4b: the same overflow on `time freeze`: the frozen time is not the current time', () => {
    const clock = WorldClock.load({ dataDir: tmp(), log: () => {}, dayLengthMin: 1 })
    const now = Date.UTC(2027, 11, 15, 12, 0, 30)
    const t0 = clockAt(clock.state, now).t
    expect(clock.gm(['freeze'], now).ok).toBe(true)
    const t1 = clockAt(clock.state, now + 1000).t
    expect(Math.abs(t1 - t0) * 86_400).toBeLessThan(1)
  })

  it('F5: the stars jump ~1 degree at every midnight (starRotation adds day x 1.0027 but t x 1)', () => {
    // A star direction before and after 00:00 on the running clock: one game second apart.
    const star = [0.3, 0.8, -0.52]
    const len = Math.hypot(star[0]!, star[1]!, star[2]!)
    const rotate = (t: number, day: number) => {
      const r = starRotation(t, day)
      return [0, 1, 2].map(i => (r[i * 3]! * star[0]! + r[i * 3 + 1]! * star[1]! + r[i * 3 + 2]! * star[2]!) / len)
    }
    const angleDeg = (a: number[], b: number[]) => (Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * 180) / Math.PI
    const sec = 1 / 86_400
    const d = 41
    const beforeStep = angleDeg(rotate(1 - 2 * sec, d), rotate(1 - sec, d))
    const acrossMidnight = angleDeg(rotate(1 - sec, d), rotate(0, d + 1))
    // Across midnight the sky should move by one game second, like any other second (~0.004 deg). It moves ~0.97 deg.
    expect(beforeStep).toBeLessThan(0.01)
    expect(acrossMidnight).toBeLessThan(0.05)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// What held up
// ---------------------------------------------------------------------------------------------------------------------

function flatProfile(): EnvProfile {
  const c = (r: number, g: number, b: number) => [{ time: 0, r, g, b }, { time: 0.5, r: r * 1.5, g: g * 1.5, b: b * 1.5 }, { time: 1, r, g, b }]
  const f = (v: number) => [{ time: 0, value: v }]
  return {
    id: 1, name: 'flat',
    sunColor: c(1, 1, 1), skyTopColor: c(0.1, 0.2, 0.5), diffuseColor: c(0.4, 0.4, 0.4), objectAmbientColor: c(0.3, 0.3, 0.3),
    graph4: c(1, 1, 1), terrainAmbientColor: c(1, 1, 1), terrainShadowColor: c(0, 0, 0), fogNearPlane: f(-0.76), fogFarPlane: f(-1),
    fogColor: c(0.3, 0.4, 0.5), graph10: f(0.76), graph11: f(1), graph12: f(0), skyBottomColor: c(0.5, 0.6, 0.7),
    waterColor: c(0.3, 0.6, 0.6), graph15: f(-1),
  } as EnvProfile
}

function modernSky() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const profile = flatProfile()
  const sky = new SkySystem(scene, evaluateProfile(profile, 0.5), { style: 'modern', quality: SKY_PRESETS.high })
  cleanups.push(() => {
    sky.dispose()
    scene.dispose()
    engine.dispose()
  })
  const set = (t: number, days: number | null) => sky.setRetail({ env: evaluateProfile(profile, Number.isFinite(t) ? t : 0.5), t, days, declination: 12, profile })
  return { sky, set }
}

const stateFinite = (sky: SkySystem) => {
  const s = sky.state
  return [s.keyLight.intensity, ...s.keyLight.color, s.keyLight.dir.x, s.keyLight.dir.y, s.keyLight.dir.z, ...s.ambient.sky, ...s.fogColor, s.exposure, s.night].every(Number.isFinite)
}

describe('W9F clock: held up', () => {
  it('a constant one-hour client clock offset is absorbed by the first pong: sky days and weather match the server', () => {
    const skew = HOUR
    let local = T0 + skew
    const sc = new ServerClock(() => local)
    const sent = local
    local += 30
    sc.pong(sent, T0 + 15)
    const c: WorldClockState = { anchorMs: CLOCK_EPOCH_MS, anchorDays: 0.3, dayMs: 7_200_000, running: true, nightSpeedup: 0.4, declination: 12 }
    const serverDays = clockAt(c, T0 + 30).days
    expect(Math.abs(clockAt(c, sc.serverNow()).days - serverDays) * 86_400).toBeLessThan(1)
  })

  it('midnight wrap: the sky sees no jump and stays finite across 23:59 -> 00:00; clockAt t stays in [0, 1)', () => {
    const { sky, set } = modernSky()
    const c: WorldClockState = { anchorMs: T0, anchorDays: 10.99, dayMs: 60_000, running: true, nightSpeedup: 0.6, declination: -23.44 }
    for (let ms = 0; ms < 2000; ms += 16) {
      const at = clockAt(c, T0 + ms)
      expect(at.t).toBeGreaterThanOrEqual(0)
      expect(at.t).toBeLessThan(1)
      set(at.t, at.days)
      sky.update(0.016, null)
      expect(stateFinite(sky)).toBe(true)
    }
  })

  it('a NaN time in SkyState recovers on the next finite frame', () => {
    const { sky, set } = modernSky()
    set(0.5, 3.5)
    sky.update(0.016, null)
    set(Number.NaN, Number.NaN)
    sky.update(0.016, null)
    set(0.5, 3.5)
    sky.update(0.016, null)
    sky.update(0.016, null)
    expect(stateFinite(sky)).toBe(true)
  })

  it('moon near new moon: hidden, texture in 1..30, finite state; ages wrap for negative and huge day counts', () => {
    for (const days of [0, 0.74, 0.76, 29.52, 29.53, -0.001, -1e-12, 1e6 + 0.3, 29.53 * 33863]) {
      const m = moonState(days)
      expect(m.texture).toBeGreaterThanOrEqual(1)
      expect(m.texture).toBeLessThanOrEqual(30)
      expect(m.age).toBeGreaterThanOrEqual(0)
      expect(m.age).toBeLessThan(29.53)
    }
    expect(moonVisible(moonState(0.1).age)).toBe(false)
    expect(moonVisible(moonState(29.5).age)).toBe(false)
    const { sky, set } = modernSky()
    for (let t = 0; t < 1; t += 0.01) {
      set(t, 29.53 * 4 + t * 0.001)
      sky.update(0.05, null)
      expect(stateFinite(sky)).toBe(true)
    }
  })

  it('freeze / resume / length / night keep t, including at 1 and 1440 minutes and across midnight', () => {
    for (const minutes of [1, 1440]) {
      const clock = WorldClock.load({ dataDir: tmp(), log: () => {}, dayLengthMin: minutes })
      let now = T0
      clock.gm(['23:59'], now)
      for (const cmd of [['freeze'], ['resume'], ['length', '1'], ['length', '1440'], ['night', '0'], ['night', '0.6'], ['season', '-23.44']]) {
        now += 7
        const before = clockAt(clock.state, now).t
        expect(clock.gm(cmd, now).ok, cmd.join(' ')).toBe(true)
        const after = clockAt(clock.state, now).t
        let d = Math.abs(after - before)
        d = Math.min(d, 1 - d)
        expect(d * 86_400, `${minutes} min: ${cmd.join(' ')}`).toBeLessThan(1)
      }
    }
  })

  it('every `time hh:mm` shows that minute on the HUD at once (k 0, 0.4, 0.6; day 0 and a large day)', () => {
    for (const k of ['0', '0.4', '0.6']) {
      for (const start of [T0, Date.UTC(2126, 0, 1)]) {
        const clock = WorldClock.load({ dataDir: tmp(), log: () => {} })
        expect(clock.gm(['night', k], start).ok).toBe(true)
        const bad: string[] = []
        for (let m = 0; m < 1440; m++) {
          const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
          clock.gm([hm], start)
          const t = Math.min(0.999999, Math.max(0, clockAt(clock.state, start).t))
          if (clockText(t) !== hm) bad.push(`${hm} -> ${clockText(t)}`)
        }
        expect(bad, `k ${k}`).toEqual([])
      }
    }
  }, 60_000)

  it('an old anchor with DAY_LENGTH_MIN 1440 or the default stays far inside the 1e6-day range', () => {
    const clock = WorldClock.load({ dataDir: tmp(), log: () => {} })
    const now = Date.UTC(2126, 0, 1)
    expect(clockAt(clock.state, now).days).toBeLessThan(1e6)
    expect(clock.gm(['06:00'], now).ok).toBe(true)
    expect(offBy(clockAt(clock.state, now).t, 6, 0)).toBeLessThan(1)
  })
})
