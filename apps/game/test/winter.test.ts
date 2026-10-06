/**
 * The snow season on the client (docs/WINTER.md §8): the winter mirror (enter, messages, the preview, the strength,
 * the easing, the integration under the weather), the weather feature's frame carrying the snow (also without the new
 * look), footprints, breath, and the winter sounds (the howl recipe, its level, the snow steps, the muffle).
 */
import { describe, expect, it, vi } from 'vitest'
import { weatherParams, type ServerMessage, type WinterSync } from '@sro/shared'
import { HOWL_S, WINTER_SYNTH, howlGain, howlPcm, muffleGain, snowSurface, SNOW_STEP_COVER } from '../src/audio/winter.ts'
import { SettingsStore, normalizeSettings } from '../src/settings.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { weatherFeature } from '../src/world/features/weather.ts'
import { BREATH_EVERY_S, BREATH_FROST_MIN, BreathClock } from '../src/world/winter/breath.ts'
import { EASE_TAU_S, WinterClient, parseWinterOverride } from '../src/world/winter/client.ts'
import { PRINT_COVER_MIN, PRINT_FADE_S, PRINT_MAX, PRINT_STRIDE_M, PrintTrail } from '../src/world/winter/prints.ts'

const T0 = Date.UTC(2026, 11, 20, 12)
const W: WinterSync = { season: true, cover: 0.5, frost: 1, at: T0, strength: 1, start: '12-01', end: '01-15', timeZone: 'UTC' }
const clear = weatherParams('clear')

describe('WinterClient (docs/WINTER.md §8)', () => {
  it('snaps to the enter state, then eases toward each message (no pop), within ~3 time constants', () => {
    const c = new WinterClient()
    c.enter(W, T0)
    expect(c.frame(T0, 0.016, clear, 0)).toMatchObject({ cover: 0.5, frost: 1, season: true })
    c.message({ ...W, cover: 1, at: T0 + 1000 })
    const a = c.frame(T0 + 1000, 0.1, clear, 0)
    expect(a.cover).toBeGreaterThan(0.5)
    expect(a.cover).toBeLessThan(0.55)
    let f = a
    for (let i = 0; i < 3 * EASE_TAU_S * 10; i++) f = c.frame(T0 + 1000 + i * 100, 0.1, clear, 0)
    expect(f.cover).toBeGreaterThan(0.94)
  })

  it('carries the snow forward under the weather the player sees (snowing builds it up, a sunny day melts it)', () => {
    const c = new WinterClient()
    c.enter({ ...W, cover: 0 }, T0)
    c.frame(T0, 0, clear, 1)
    const snow = weatherParams('blizzard')
    let f = c.frame(T0 + 3_600_000, 1, snow, 0)
    for (let i = 1; i <= 20; i++) f = c.frame(T0 + 3_600_000 + i * 1000, 1, snow, 0)
    expect(c.raw.cover).toBeGreaterThan(0.3)
    expect(f.cover).toBeGreaterThan(0.2)
    const before = c.raw.cover
    c.frame(T0 + 6 * 3_600_000, 1, clear, 1)
    expect(c.raw.cover).toBeLessThan(before)
  })

  it('a GM preview draws the full look (× the strength) without touching the state; its end eases back', () => {
    const c = new WinterClient()
    c.enter({ ...W, season: false, cover: 0, frost: 0 }, T0)
    c.frame(T0, 0, clear, 1)
    c.message({ ...W, season: false, cover: 0, frost: 0, preview: true, strength: 0.6, at: T0 })
    let f = c.frame(T0, 0.1, clear, 1)
    for (let i = 0; i < 200; i++) f = c.frame(T0, 0.1, clear, 1)
    expect(f).toMatchObject({ season: true })
    expect(f.cover).toBeCloseTo(0.6, 2)
    expect(f.frost).toBeCloseTo(1, 2)
    expect(c.raw).toEqual({ cover: 0, frost: 0 })
    c.message({ ...W, season: false, cover: 0, frost: 0, strength: 0.6, at: T0 })
    const g = c.frame(T0, 0.1, clear, 1)
    expect(g.cover).toBeGreaterThan(0.5)
    expect(g.season).toBe(false)
  })

  it('an older server (no winter) is no snow; ?winter= holds a look offline until the first message', () => {
    const c = new WinterClient()
    c.enter(undefined, T0)
    expect(c.frame(T0, 0.016, clear, 1)).toEqual({ cover: 0, frost: 0, season: false })
    expect(parseWinterOverride('?winter=0.8')).toBe(0.8)
    expect(parseWinterOverride('?winter=x')).toBeNull()
    expect(parseWinterOverride('')).toBeNull()
    const o = new WinterClient(1)
    expect(o.frame(T0, 0.016, clear, 1)).toEqual({ cover: 1, frost: 1, season: true })
  })
})

describe('the weather feature carries the snow in the frame (docs/WINTER.md §8)', () => {
  function harness(look: 'modern' | 'classic') {
    const world = { render: { mode: 'classic', gpu: null }, skyStyle: 'classic', weather: { shelter: null }, setWeather: vi.fn(), setWeatherLevel: vi.fn() }
    const ctx = {
      app: { audio: { weather: { update: vi.fn(), thunder: vi.fn(), prepareThunder: vi.fn(), stop: vi.fn() } } },
      scene: { getLightByName: () => null },
      camera: { target: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 5, z: -10 } },
      serverNow: () => T0,
      selfId: () => null,
      view: () => undefined,
      world: () => ({ world }),
    } as unknown as WorldFeatureContext
    const store = new SettingsStore({ getItem: () => null, setItem: () => {} })
    store.set(normalizeSettings({}))
    if (look === 'modern') store.set({ graphics: { modern: true, preset: 'high' } } as never)
    else store.set({ graphics: { modern: true, preset: 'low', sky: 'classic', weather: 'off' } } as never)
    const f = weatherFeature(ctx, { store, search: '', zoneAt: () => null })
    return { f, world }
  }

  it('cover and frost from the server state; the snowfall from the weather', () => {
    const { f, world } = harness('modern')
    const weather = { start: T0, dur: 0, from: 'snow', to: 'snow', intensity: 1, until: T0 + 3_600_000, windDir: 0, windMs: 3, wet: 0, puddle: 0, at: T0, seed: 1 }
    f.onMessage!({ t: 'worldEnter', world: { weather, winter: W } } as unknown as ServerMessage)
    f.onFrame!(T0, 0.016)
    const frame = world.setWeather.mock.calls.at(-1)![0]
    expect(frame.cover).toBeCloseTo(0.5, 3)
    expect(frame.frost).toBe(1)
    expect(frame.snow).toBeCloseTo(0.6, 6)
    expect(frame.rain).toBe(0)
    f.dispose!()
  })

  it('the snow lies even in the Low guard combination (a clear sky there, but the season is content)', () => {
    const { f, world } = harness('classic')
    f.onMessage!({ t: 'worldEnter', world: { winter: W } } as unknown as ServerMessage)
    f.onFrame!(T0, 0.016)
    const frame = world.setWeather.mock.calls.at(-1)![0]
    expect(frame.cover).toBeCloseTo(0.5, 3)
    expect(frame.frost).toBe(1)
    expect(frame.snow ?? 0).toBe(0)
    f.dispose!()
  })
})

describe('footprints (docs/WINTER.md §8.1)', () => {
  const walk = (t: PrintTrail, cover: number, steps: number, stepM = 0.3, id = 1) => {
    for (let i = 0; i <= steps; i++) t.step(0.1, [{ id, x: 0, y: 2, z: i * stepM }], cover, PRINT_FADE_S)
  }

  it('a print every stride, left and right in turn, turned along the path, on the ground height', () => {
    const t = new PrintTrail()
    walk(t, 1, 30)
    expect(t.prints.length).toBeGreaterThan(9)
    const [a, b] = t.prints
    expect(Math.sign(a!.x)).toBe(-Math.sign(b!.x))
    expect(a!.yaw).toBeCloseTo(0, 6)
    expect(a!.y).toBe(2)
  })

  it('none on thin snow, none across a teleport, they fade, and the oldest go past the cap', () => {
    const thin = new PrintTrail()
    walk(thin, PRINT_COVER_MIN - 0.01, 30)
    expect(thin.prints).toEqual([])
    const tp = new PrintTrail()
    tp.step(0.1, [{ id: 1, x: 0, y: 0, z: 0 }], 1, PRINT_FADE_S)
    tp.step(0.1, [{ id: 1, x: 0, y: 0, z: 50 }], 1, PRINT_FADE_S)
    expect(tp.prints).toEqual([])
    const f = new PrintTrail()
    walk(f, 1, 10)
    const n = f.prints.length
    expect(n).toBeGreaterThan(0)
    expect(f.fade(f.prints[0]!, PRINT_FADE_S)).toBeGreaterThan(0.9)
    f.step(PRINT_FADE_S + 1, [], 1, PRINT_FADE_S)
    expect(f.prints).toEqual([])
    const many = new PrintTrail()
    for (let i = 0; i < PRINT_MAX * 2; i++) many.step(0.01, [{ id: 1, x: 0, y: 0, z: i * PRINT_STRIDE_M * 1.01 }], 1, 1e9)
    expect(many.prints.length).toBe(PRINT_MAX)
  })
})

describe('breath (docs/WINTER.md §8.2)', () => {
  it('each person breathes out about every BREATH_EVERY_S, the crowd out of step', () => {
    const c = new BreathClock()
    const people = [1, 2, 3].map(id => ({ id, x: 0, y: 0, z: 0, yaw: 0 }))
    const times = new Map<number, number[]>()
    for (let i = 0; i < 400; i++) for (const b of c.step(0.05, people)) times.set(b.id, [...(times.get(b.id) ?? []), i * 0.05])
    for (const [, t] of times) {
      expect(t.length).toBeGreaterThanOrEqual(4)
      const gaps = t.slice(1).map((x, i) => x - t[i]!)
      for (const g of gaps) {
        expect(g).toBeGreaterThan(BREATH_EVERY_S * 0.6)
        expect(g).toBeLessThan(BREATH_EVERY_S * 1.4)
      }
    }
    expect(new Set([...times.values()].map(t => t[0]!.toFixed(2))).size).toBeGreaterThan(1)
    expect(BREATH_FROST_MIN).toBeGreaterThan(0)
  })
})

describe('winter sounds (docs/WINTER.md §8.3)', () => {
  it('the howl: seeded and deterministic, HOWL_S long, normalized, with soft ends; two different segments', () => {
    const a = howlPcm(311)
    expect(a.samples.length).toBe(Math.round(HOWL_S * a.rate))
    expect(howlPcm(311).samples).toEqual(a.samples)
    let peak = 0
    for (const v of a.samples) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeLessThanOrEqual(0.86)
    expect(peak).toBeGreaterThan(0.5)
    expect(Math.abs(a.samples[0]!)).toBeLessThan(0.01)
    expect(Math.abs(a.samples.at(-1)!)).toBeLessThan(0.01)
    expect(Object.keys(WINTER_SYNTH)).toEqual(['synth/winter_howl_a', 'synth/winter_howl_b'])
    expect(howlPcm(733).samples).not.toEqual(a.samples)
  })

  it('howls only in a blizzard, louder in the wind, softer under a roof', () => {
    expect(howlGain(0.6, 3)).toBe(0)
    expect(howlGain(1, 14)).toBeGreaterThan(0.8)
    expect(howlGain(1, 14, true)).toBeCloseTo(howlGain(1, 14) / 2, 9)
    expect(howlGain(0, 20)).toBe(0)
  })

  it('snow steps on snowy ground; wood floors and water keep theirs; the ambience is muffled under snow', () => {
    expect(snowSurface('Grass', 1)).toBe('Snow')
    expect(snowSurface('Stone', SNOW_STEP_COVER)).toBe('Snow')
    expect(snowSurface('Stone', SNOW_STEP_COVER - 0.01)).toBe('Stone')
    expect(snowSurface('Wood', 1)).toBe('Wood')
    expect(snowSurface('Water', 1)).toBe('Water')
    expect(muffleGain(0, 0)).toBe(1)
    expect(muffleGain(1, 1)).toBeLessThan(0.7)
  })
})
