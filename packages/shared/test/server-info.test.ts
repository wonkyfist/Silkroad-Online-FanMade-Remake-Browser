/**
 * Wave 10: `ServerInfo.clock?` / `ServerInfo.weather?` for the character screens' sky (docs/SCREENS.md §9,
 * docs/WAVE_PLAN6.md §3.2). The `welcome` validator must never lock a player out at server select: a malformed clock
 * or weather drops only that field (with a console warning), and older payloads without them still parse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOCK_EPOCH_DAYS,
  CLOCK_EPOCH_MS,
  DEFAULT_CLOCK,
  parseServerMessage,
  type ServerInfo,
  type ServerMessage,
  type WeatherSync,
  type WorldClockState,
} from '../src/index.ts'

const clock: WorldClockState = { anchorMs: CLOCK_EPOCH_MS, anchorDays: CLOCK_EPOCH_DAYS, ...DEFAULT_CLOCK }
const weather: WeatherSync = {
  start: 1_790_000_000_000, dur: 60_000, from: 'overcast', to: 'rain', intensity: 0.7, until: 1_790_000_900_000,
  windDir: 1.2, windMs: 6, wet: 0.4, puddle: 0.1, at: 1_790_000_000_500, seed: 4_000_000_000,
}
const base: ServerInfo = { id: 'jangan', name: 'Jangan', status: 'online', online: 1, capacity: 50, world: 'jangan-fields' }
const welcome = (server: Record<string, unknown>) => JSON.stringify({ t: 'welcome', account: 'bob', server, slots: 4 })

function parsedServer(server: Record<string, unknown>): ServerInfo {
  const r = parseServerMessage(welcome(server))
  if (!r.ok || r.msg.t !== 'welcome') throw new Error(`expected welcome, got ${r.ok ? r.msg.t : r.error}`)
  return r.msg.server
}

describe('ServerInfo clock and weather (docs/SCREENS.md §9)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('round-trips with both fields, with either one, and with none (older servers)', () => {
    const cases: ServerInfo[] = [
      { ...base, clock, weather },
      { ...base, clock },
      { ...base, weather },
      base,
      { id: 'j', name: 'J', status: 'maintenance', online: 0, capacity: 5 },
    ]
    for (const server of cases) {
      const m: ServerMessage = { t: 'welcome', account: 'bob', server, slots: 4 }
      expect(parseServerMessage(JSON.stringify(m)), JSON.stringify(server)).toEqual({ ok: true, msg: m })
    }
    const old = parsedServer({ ...base })
    expect('clock' in old).toBe(false)
    expect('weather' in old).toBe(false)
  })

  it('a bad clock drops only the clock: the welcome, the weather and every other field survive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad: unknown[] = [
      { ...clock, dayMs: 5 },
      { ...clock, nightSpeedup: 0.61 },
      { ...clock, declination: 24 },
      { ...clock, running: 1 },
      { ...clock, anchorMs: -1 },
      { ...clock, anchorDays: undefined },
      'noon',
      null,
      [1, 2],
    ]
    for (const c of bad) {
      const s = parsedServer({ ...base, clock: c, weather })
      expect(s.clock, JSON.stringify(c)).toBeUndefined()
      expect(s.weather).toEqual(weather)
      expect(s).toEqual({ ...base, weather })
    }
    expect(warn).toHaveBeenCalledTimes(bad.length)
    expect(String(warn.mock.calls[0]![0])).toContain('server.clock')
  })

  it('a bad weather drops only the weather', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const w of [{ ...weather, to: 'hail' }, { ...weather, wet: 2 }, { ...weather, seed: -1 }, 7]) {
      const s = parsedServer({ ...base, clock, weather: w })
      expect(s).toEqual({ ...base, clock })
    }
    expect(warn).toHaveBeenCalledTimes(4)
    expect(String(warn.mock.calls[0]![0])).toContain('server.weather')
  })

  it('both bad: the welcome still parses with the plain server info', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parsedServer({ ...base, clock: { ...clock, dayMs: 1 }, weather: { ...weather, from: 'hail' } })).toEqual(base)
  })

  it('the house rule still holds for the other fields: a bad required field or world rejects the welcome', () => {
    expect(parseServerMessage(welcome({ ...base, clock, online: -1 })).ok).toBe(false)
    expect(parseServerMessage(welcome({ ...base, clock, world: 'Bad World' })).ok).toBe(false)
    expect(parseServerMessage(welcome({ ...base, status: 'busy', clock })).ok).toBe(false)
  })

  it('unknown extra keys are dropped, as before', () => {
    expect(parsedServer({ ...base, clock, motd: 'hello' })).toEqual({ ...base, clock })
  })
})
