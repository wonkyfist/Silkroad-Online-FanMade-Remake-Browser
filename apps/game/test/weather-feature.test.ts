/**
 * WX-C (docs/WAVE_PLAN3.md §6.9, docs/WEATHER.md §10 WX-C): the client weather feature and the weather audio. The
 * WeatherClient mirror (late joiner mid-transition, a mid-transition change without a jump, the GM wind override, the
 * surface integration, the zone climate, flash and thunder timing, `reduceFlashing`), the `auto` level mapping through
 * the effective settings (iGPU → low), the feature on a fake world and scene, and WeatherAudio on a fake host (rain
 * gain, the two-voice bed, muffling under shelter, birds muted, thunder). Node only: no engine, no AudioContext.
 */
import { describe, expect, it, vi } from 'vitest'
import { SPEED_OF_SOUND, WEATHER_PARAMS, blendWeather, flashAt, stepSurface, weatherParams, zoneClimate, type ServerMessage, type SoundCue, type WeatherSync } from '@sro/shared'
import { AmbientPlayer, type AmbientOutput } from '../src/audio/ambient.ts'
import type { AudioBackend, SoundBuffer, StartOptions, Vec3Like, VoiceHandle } from '../src/audio/backend.ts'
import { GameAudio } from '../src/audio/index.ts'
import { AudioSettings, type StorageLike } from '../src/audio/settings.ts'
import { WEATHER_AUDIO, WeatherAudio, rainGain, strongWindGain, thunderGain, type WeatherAudioHost } from '../src/audio/weather.ts'
import { registeredOptionRows } from '../src/hud/options.ts'
import { SettingsStore, isIntegratedGpu, normalizeSettings, weatherLevelFor, type Settings } from '../src/settings.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import {
  CHARACTER_LIGHTS,
  FLASH_MIN_GAP_MS,
  REDUCED_FLASH,
  THUNDER_STALE_MS,
  WeatherClient,
  characterLightIntensities,
  gustNoise,
  panToward,
  parseWeatherOverride,
  shelteredAt,
  weatherFeature,
} from '../src/world/features/weather.ts'

const T0 = Date.UTC(2026, 8, 28, 12)

function sync(over: Partial<WeatherSync> = {}): WeatherSync {
  return { start: T0, dur: 120_000, from: 'overcast', to: 'rain', intensity: 1, until: T0 + 900_000, windDir: 0.35, windMs: WEATHER_PARAMS.rain.windMs, wet: 0, puddle: 0, at: T0, seed: 7, ...over }
}

describe('WeatherClient: the server state mirrored', () => {
  it('a late joiner mid-transition gets the blended rain of the sync as is', () => {
    const c = new WeatherClient(null, T0)
    const s = sync()
    const now = T0 + 100_000 // k past the 0.55 rain lag
    c.enter(s, now)
    const f = c.frame(now, 0.016)
    const want = blendWeather(s, now)
    expect(f.rain).toBeCloseTo(want.rain, 6)
    expect(f.rain).toBeGreaterThan(0.05)
    expect(f.cloud).toBeCloseTo(want.cloud, 6)
    expect(f.fog).toBeCloseTo(want.fog, 6)
    // an older server (no weather field): clear
    const old = new WeatherClient(null, T0)
    old.enter(undefined, T0)
    const g = old.frame(T0, 0.016)
    expect(g.rain).toBe(0)
    expect(g.cloud).toBeCloseTo(WEATHER_PARAMS.clear.cloud, 6)
  })

  it('a weather message mid-transition blends from the current vector: no jump, and reaches `to` on time', () => {
    const c = new WeatherClient(null, T0)
    c.enter(sync({ from: 'clear', to: 'overcast', dur: 120_000 }), T0)
    const mid = T0 + 60_000
    const before = c.frame(mid, 0.016)
    // the server changes its mind at mid: → storm, from its nearest name ('cloudy'), starting now
    const s2 = sync({ start: mid, dur: 60_000, from: 'cloudy', to: 'storm' })
    c.message(s2, mid)
    const after = c.frame(mid, 0.016)
    for (const k of ['cloud', 'cloudDark', 'rain', 'fog', 'sun', 'desat'] as const) expect(after[k], k).toBeCloseTo(before[k], 6)
    // blending from P['cloudy'] instead would jump
    expect(Math.abs(blendWeather(s2, mid).sun - before.sun)).toBeGreaterThan(0.1)
    const end = c.frame(mid + 60_000, 0.016)
    expect(end.cloud).toBeCloseTo(WEATHER_PARAMS.storm.cloud, 6)
    expect(end.rain).toBeCloseTo(WEATHER_PARAMS.storm.rain, 6)
  })

  it('a resync of the same transition keeps the curve; a message whose start is in the past ends when the server does', () => {
    const c = new WeatherClient(null, T0)
    const s = sync({ from: 'clear', to: 'overcast' })
    c.enter(s, T0)
    const a = c.frame(T0 + 30_000, 0.016)
    c.message({ ...s, wet: 0, at: T0 + 30_000 }, T0 + 30_000)
    const b = c.frame(T0 + 30_000, 0.016)
    expect(b.cloud).toBeCloseTo(a.cloud, 9)
    expect(b.cloud).toBeCloseTo(blendWeather(s, T0 + 30_000).cloud, 9)
    // a change the client hears late (start 20 s ago, 60 s long): still at P[to] by start + dur
    const late = sync({ start: T0 + 10_000, dur: 60_000, from: 'overcast', to: 'fog' })
    c.message(late, T0 + 30_000)
    expect(c.frame(T0 + 70_000, 0.016).fog).toBeCloseTo(WEATHER_PARAMS.fog.fog, 6)
  })

  it("integrates the surface with the server's stepSurface from `at`, and takes the GM wind override", () => {
    const c = new WeatherClient(null, T0)
    const s = sync({ from: 'storm', to: 'storm', dur: 0, wet: 0.2, puddle: 0.05, at: T0 - 30_000, windMs: 21 })
    c.enter(s, T0)
    const want = stepSurface({ wet: 0.2, puddle: 0.05 }, weatherParams('storm'), 30)
    const f = c.frame(T0, 0)
    expect(f.wet).toBeCloseTo(want.wet, 6)
    expect(f.puddle).toBeCloseTo(want.puddle, 6)
    expect(f.windMs).toBe(21)
    expect(c.params(T0).windMs).toBe(21)
    // no override: P[to].windMs
    const d = new WeatherClient(null, T0)
    d.enter(sync({ from: 'storm', to: 'storm', dur: 0, windMs: WEATHER_PARAMS.storm.windMs }), T0)
    expect(d.params(T0).windMs).toBe(WEATHER_PARAMS.storm.windMs)
    // 60 s of frames later the surface is wetter, never above 1
    let g = d.frame(T0, 0)
    for (let i = 1; i <= 3600; i++) g = d.frame(T0 + i * 16, 0.016)
    expect(g.wet).toBeGreaterThan(0.5)
    expect(g.wet).toBeLessThanOrEqual(1)
  })

  it('the surface follows the server clock, not the frame times (I9A: a slow entry fell ~10 s behind)', () => {
    const s = sync({ from: 'storm', to: 'storm', dur: 0, at: T0 })
    const want = stepSurface({ wet: 0, puddle: 0 }, weatherParams('storm'), 60)
    // 60 s in twenty 3 s frames (each clamped to 1 s of frame time), and in 16 ms frames: the same surface (within the
    // Euler step difference of 1 s against 0.25 s steps)
    const slow = new WeatherClient(null, T0)
    slow.enter(s, T0)
    let f = slow.frame(T0, 0)
    for (let i = 1; i <= 20; i++) f = slow.frame(T0 + i * 3000, 3)
    const fast = new WeatherClient(null, T0)
    fast.enter(s, T0)
    let g = fast.frame(T0, 0)
    for (let i = 1; i <= 3750; i++) g = fast.frame(T0 + i * 16, 0.016)
    expect(f.wet).toBeCloseTo(want.wet, 2)
    expect(f.puddle).toBeCloseTo(want.puddle, 2)
    expect(g.wet).toBeCloseTo(want.wet, 2)
    expect(g.puddle).toBeCloseTo(want.puddle, 2)
    // a late joiner entering now agrees with both
    const late = new WeatherClient(null, T0 + 60_000)
    late.enter(s, T0 + 60_000)
    expect(late.frame(T0 + 60_000, 0).puddle).toBeCloseTo(want.puddle, 6)
  })

  it('zone climate: the swamp adds fog, rain and a wet floor, blended over ~10 s', () => {
    const c = new WeatherClient(null, T0)
    c.enter(sync({ from: 'rain', to: 'rain', dur: 0, intensity: 0.5 }), T0)
    const swamp = zoneClimate('Swamp area')
    const neutral = c.frame(T0, 0.016)
    const first = c.frame(T0 + 16, 0.016, swamp)
    expect(first.fog - neutral.fog).toBeLessThan(0.01) // no snap at a border
    let f = first
    for (let i = 2; i <= 15 * 60; i++) f = c.frame(T0 + i * 16, 1 / 60, swamp)
    expect(f.fog).toBeCloseTo(Math.min(1, WEATHER_PARAMS.rain.fog + swamp.fogAdd), 2)
    expect(f.rain).toBeCloseTo(Math.min(1, weatherParams('rain', 0.5).rain * swamp.rainMul), 2)
    expect(f.wet).toBeGreaterThanOrEqual(swamp.wetFloor - 0.01)
  })

  it('gusts vary around the mean wind within the gust amplitude, the same on every client', () => {
    const c = new WeatherClient(null, T0)
    c.enter(sync({ from: 'storm', to: 'storm', dur: 0 }), T0)
    const p = weatherParams('storm')
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < 600; i++) {
      const f = c.frame(T0 + i * 100, 0.1)
      lo = Math.min(lo, f.gustMs)
      hi = Math.max(hi, f.gustMs)
      expect(f.gustMs).toBeGreaterThanOrEqual(p.windMs * (1 - p.gust) - 1e-9)
      expect(f.gustMs).toBeLessThanOrEqual(p.windMs * (1 + p.gust) + 1e-9)
    }
    expect(hi - lo).toBeGreaterThan(p.windMs * 0.3)
    expect(gustNoise(7, 1234.5)).toBe(gustNoise(7, 1234.5))
    expect(gustNoise(7, 1234.5)).not.toBe(gustNoise(8, 1234.5))
  })

  it('lightning: the flash at `at`, the thunder distM / 343 s later, stale thunder dropped, flashes ≥ 2 s apart', () => {
    const c = new WeatherClient(null, T0)
    c.enter(sync({ from: 'storm', to: 'storm', dur: 0 }), T0)
    const at = T0 + 1000
    expect(c.strike(at, 1715, Math.PI / 2)).toBe(true)
    const f = c.frame(at + 10, 0.01)
    expect(f.flash).toBeCloseTo(flashAt({ at }, at + 10), 6)
    expect(f.flash).toBeGreaterThan(1)
    expect(f.flashX).toBeCloseTo(0, 6)
    expect(f.flashZ).toBeCloseTo(-1, 6) // bearing π/2 = −Z (north)
    const due = at + (1715 / SPEED_OF_SOUND) * 1000 // 5 s
    expect(c.takeThunder(due - 1)).toEqual([])
    expect(c.takeThunder(due)).toEqual([{ distM: 1715, bearing: Math.PI / 2 }])
    expect(c.takeThunder(due + 10)).toEqual([])
    // a second strike within 2 s: no flash, but its thunder
    expect(c.strike(at + FLASH_MIN_GAP_MS - 1, 343, 0)).toBe(false)
    expect(c.takeThunder(at + FLASH_MIN_GAP_MS - 1 + 1000)).toHaveLength(1)
    // a thunder heard too late (hidden tab) is skipped
    c.strike(at + 10_000, 343, 0)
    expect(c.takeThunder(at + 11_000 + THUNDER_STALE_MS + 1)).toEqual([])
    expect(c.frame(at + 20_000, 0.01).flash).toBe(0)
  })

  it('reduceFlashing scales the flash to a quarter before anything sees it', () => {
    const a = new WeatherClient(null, T0)
    const b = new WeatherClient(null, T0)
    for (const c of [a, b]) {
      c.enter(sync({ from: 'storm', to: 'storm', dur: 0 }), T0)
      c.strike(T0, 500, 1)
    }
    const full = a.frame(T0 + 20, 0.02, undefined, false).flash
    const reduced = b.frame(T0 + 20, 0.02, undefined, true).flash
    expect(full).toBeGreaterThan(0)
    expect(reduced).toBeCloseTo(full * REDUCED_FLASH, 9)
  })

  it('?weather= holds a state (soaked) until the first weather message, which blends from it', () => {
    expect(parseWeatherOverride('?weather=storm')).toEqual({ kind: 'storm', intensity: 1 })
    expect(parseWeatherOverride('?weather=rain:0.6')).toEqual({ kind: 'rain', intensity: 0.6 })
    expect(parseWeatherOverride('?weather=rain:0.1')).toEqual({ kind: 'rain', intensity: 0.4 })
    expect(parseWeatherOverride('?weather=hail')).toBeNull()
    expect(parseWeatherOverride('')).toBeNull()
    const c = new WeatherClient({ kind: 'storm', intensity: 1 }, T0)
    c.enter(sync({ from: 'clear', to: 'clear', dur: 0 }), T0) // the mock's clear worldEnter does not end it
    const f = c.frame(T0, 0.016)
    expect(c.isOverridden).toBe(true)
    expect(f.rain).toBe(1)
    expect(f.wet).toBeGreaterThan(0.8)
    expect(f.puddle).toBeGreaterThan(0.1)
    c.message(sync({ start: T0, dur: 60_000, from: 'storm', to: 'clear' }), T0)
    expect(c.isOverridden).toBe(false)
    expect(c.frame(T0, 0).rain).toBeCloseTo(1, 6)
  })

  it('helpers: pan toward a bearing, shelter test, character lights', () => {
    // looking north (−Z): east (+X, bearing 0) is to the right
    expect(panToward(0, 0, -1)).toBeLessThan(0) // Babylon LH: looking along −Z, +X is on the left
    expect(panToward(0, 0, 1)).toBeCloseTo(0.8, 6) // looking along +Z, +X is on the right
    expect(panToward(0, 0, 0)).toBe(0)
    const map = { valid: true, topAt: (x: number) => (x < 0 ? 12 : null) }
    const w = { weather: { shelter: map } } as unknown as Parameters<typeof shelteredAt>[0]
    expect(shelteredAt(w, -1, 8, 0)).toBe(true)
    expect(shelteredAt(w, -1, 10.5, 0)).toBe(false)
    expect(shelteredAt(w, 1, 8, 0)).toBe(false)
    expect(shelteredAt(null, 0, 0, 0)).toBe(false)
    expect(characterLightIntensities(WEATHER_PARAMS.clear)).toEqual({ sun: CHARACTER_LIGHTS.sun, hemi: CHARACTER_LIGHTS.hemi })
    const storm = characterLightIntensities(WEATHER_PARAMS.storm)
    expect(storm.sun).toBeCloseTo(1.2 * 0.15, 9)
    expect(storm.hemi).toBeCloseTo(0.7 * (1 - 0.2 * 0.85), 9)
  })
})

describe('weather level through the effective settings', () => {
  const s = (patch: { preset?: Settings['graphics']['preset']; weather?: string }) =>
    normalizeSettings({ v: 1, graphics: { preset: patch.preset ?? 'medium', weather: patch.weather ?? 'auto', modern: true } })

  it('auto follows the preset; a fixed level stays; a bad saved value normalises to auto', () => {
    expect(weatherLevelFor(s({ preset: 'low' }))).toBe('low')
    expect(weatherLevelFor(s({ preset: 'medium' }))).toBe('medium')
    expect(weatherLevelFor(s({ preset: 'high' }))).toBe('high')
    expect(weatherLevelFor(s({ preset: 'ultra' }))).toBe('ultra')
    expect(weatherLevelFor(s({ preset: 'high', weather: 'off' }))).toBe('off')
    expect(weatherLevelFor(s({ preset: 'low', weather: 'ultra' }))).toBe('ultra')
    expect(s({ weather: 'monsoon' }).graphics.weather).toBe('auto')
    expect(weatherLevelFor(normalizeSettings({ graphics: { modern: true } }))).toBe('medium')
    // GAME's preview gate (rollout.ts): without the new look the level is off, whatever the setting says.
    expect(weatherLevelFor(normalizeSettings(null), null, undefined, 'preview')).toBe('off')
    expect(weatherLevelFor(normalizeSettings(null), null, undefined, 'on')).toBe('medium')
  })

  it('an integrated GPU runs auto at low (a fixed choice is kept)', () => {
    const iris = { vendor: 'intel', architecture: 'gen-12lp', isFallbackAdapter: false }
    const arc = { vendor: 'intel', architecture: 'arc-alchemist', isFallbackAdapter: false }
    const amd = { vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false }
    expect(isIntegratedGpu(iris)).toBe(true)
    expect(isIntegratedGpu({ vendor: '', architecture: 'xe-lpg' })).toBe(true)
    expect(isIntegratedGpu({ vendor: 'google', architecture: '', isFallbackAdapter: true })).toBe(true)
    expect(isIntegratedGpu(arc)).toBe(false)
    expect(isIntegratedGpu(amd)).toBe(false)
    expect(isIntegratedGpu(null)).toBe(false)
    expect(weatherLevelFor(s({ preset: 'medium' }), iris)).toBe('low')
    expect(weatherLevelFor(s({ preset: 'high' }), iris)).toBe('low')
    expect(weatherLevelFor(s({ preset: 'high' }), amd)).toBe('high')
    expect(weatherLevelFor(s({ preset: 'high', weather: 'medium' }), iris)).toBe('medium')
  })
})

// ---- the feature on a fake world ------------------------------------------------------------------------

/** A settings store with the new look on (GAME's preview gate, rollout.ts, sends a clear frame otherwise). */
function modernStore(): SettingsStore {
  const store = new SettingsStore(null)
  store.set({ graphics: { modern: true } })
  return store
}

function fakeWorld(mode: 'classic' | 'pbr' = 'classic', sky: 'classic' | 'modern' = 'classic') {
  return {
    render: { mode, gpu: { vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false } },
    skyStyle: sky,
    weather: { shelter: null as null | { valid: boolean; topAt(x: number, z: number): number | null } },
    setWeather: vi.fn(),
    setWeatherLevel: vi.fn(),
  }
}

function fakeCtx(world: ReturnType<typeof fakeWorld> | null) {
  let now = T0
  const lights = { sun: { intensity: 1.2 }, hemi: { intensity: 0.7 } }
  const weatherAudio = { update: vi.fn(), thunder: vi.fn(), prepareThunder: vi.fn(), stop: vi.fn() }
  const decorators: unknown[] = []
  const ctx = {
    app: { audio: { weather: weatherAudio } },
    scene: { getLightByName: (n: string) => (lights as Record<string, { intensity: number }>)[n] ?? null },
    camera: { target: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 5, z: -10 } },
    serverNow: () => now,
    selfId: () => null,
    view: () => undefined,
    world: () => (world ? { world } : null),
    addMaterialDecorator: (fn: unknown) => {
      decorators.push(fn)
      return () => decorators.splice(decorators.indexOf(fn), 1)
    },
  } as unknown as WorldFeatureContext
  return { ctx, lights, weatherAudio, decorators, setNow: (t: number) => (now = t) }
}

describe('weatherFeature', () => {
  it('feeds the world a frame each frame, sets the level from the effective settings and follows changes', () => {
    const world = fakeWorld()
    const { ctx, weatherAudio, setNow } = fakeCtx(world)
    const store = modernStore()
    store.set({ graphics: { preset: 'high' } })
    const f = weatherFeature(ctx, { store, search: '', zoneAt: () => null })
    f.onMessage!({ t: 'worldEnter', world: { weather: sync({ from: 'storm', to: 'storm', dur: 0 }) } } as unknown as ServerMessage)
    f.onFrame!(T0, 0.016)
    expect(world.setWeatherLevel).toHaveBeenCalledWith('high')
    expect(world.setWeather).toHaveBeenCalledTimes(1)
    expect(world.setWeather.mock.calls[0]![0].rain).toBe(1)
    expect(weatherAudio.update).toHaveBeenCalledWith(expect.objectContaining({ rain: 1 }), false)
    store.set({ graphics: { weather: 'off' } })
    expect(world.setWeatherLevel).toHaveBeenLastCalledWith('off')
    store.set({ graphics: { preset: 'low', weather: 'auto' } })
    expect(world.setWeatherLevel).toHaveBeenLastCalledWith('low')
    // lightning: flash now, thunder at distM / 343 s
    f.onMessage!({ t: 'lightning', at: T0 + 100, distM: 686, bearing: 0 } as ServerMessage)
    expect(weatherAudio.prepareThunder).toHaveBeenCalledWith(686)
    setNow(T0 + 120)
    f.onFrame!(T0 + 120, 0.016)
    expect(world.setWeather.mock.calls.at(-1)![0].flash).toBeGreaterThan(0.5)
    expect(weatherAudio.thunder).not.toHaveBeenCalled()
    f.onFrame!(T0 + 2100, 0.016)
    expect(weatherAudio.thunder).toHaveBeenCalledWith(686, expect.any(Number))
    f.dispose!()
    expect(weatherAudio.stop).toHaveBeenCalled()
  })

  it('reduceFlashing from the settings reaches the frame', () => {
    const world = fakeWorld()
    const { ctx } = fakeCtx(world)
    const store = modernStore()
    store.set({ ui: { reduceFlashing: true } })
    const f = weatherFeature(ctx, { store, search: '', zoneAt: () => null })
    f.onMessage!({ t: 'worldEnter', world: { weather: sync({ from: 'storm', to: 'storm', dur: 0 }) } } as unknown as ServerMessage)
    f.onMessage!({ t: 'lightning', at: T0, distM: 900, bearing: 0 } as ServerMessage)
    f.onFrame!(T0 + 20, 0.016)
    expect(world.setWeather.mock.calls[0]![0].flash).toBeCloseTo(flashAt({ at: T0 }, T0 + 20) * REDUCED_FLASH, 9)
    f.dispose!()
  })

  it('scales the Classic character lights only on the Classic path with the classic sky, and restores them', () => {
    const world = fakeWorld('classic', 'classic')
    const { ctx, lights } = fakeCtx(world)
    const f = weatherFeature(ctx, { store: modernStore(), search: '?weather=storm', zoneAt: () => null })
    f.onFrame!(T0, 0.016)
    expect(lights.sun.intensity).toBeCloseTo(1.2 * WEATHER_PARAMS.storm.sun, 9)
    expect(lights.hemi.intensity).toBeCloseTo(0.7 * (1 - 0.2 * WEATHER_PARAMS.storm.cloudDark), 9)
    world.skyStyle = 'modern'
    f.onFrame!(T0 + 16, 0.016)
    expect(lights.sun.intensity).toBe(CHARACTER_LIGHTS.sun)
    expect(lights.hemi.intensity).toBe(CHARACTER_LIGHTS.hemi)
    world.skyStyle = 'classic'
    f.onFrame!(T0 + 32, 0.016)
    f.dispose!()
    expect(lights.sun.intensity).toBe(CHARACTER_LIGHTS.sun)
    // PBR path: never touched
    const pbr = fakeWorld('pbr', 'classic')
    const p = fakeCtx(pbr)
    const g = weatherFeature(p.ctx, { store: modernStore(), search: '?weather=storm', zoneAt: () => null })
    g.onFrame!(T0, 0.016)
    expect(p.lights.sun.intensity).toBe(1.2)
    g.dispose!()
  })

  it('registers its two option rows and removes them on dispose', () => {
    const { ctx } = fakeCtx(fakeWorld())
    const f = weatherFeature(ctx, { store: modernStore(), search: '', zoneAt: () => null })
    const g = registeredOptionRows('graphics').find(r => r.id === 'graphics.weather')
    const i = registeredOptionRows('interface').find(r => r.id === 'ui.reduceFlashing')
    expect(g?.kind).toBe('choice')
    expect(g && g.kind === 'choice' ? g.choices.map(c => c.value) : []).toEqual(['auto', 'off', 'low', 'medium', 'high', 'ultra'])
    expect(g && g.kind === 'choice' ? g.patch('low') : null).toEqual({ graphics: { weather: 'low' } })
    expect(i && i.kind === 'toggle' ? i.patch(true) : null).toEqual({ ui: { reduceFlashing: true } })
    f.dispose!()
    expect(registeredOptionRows('graphics').some(r => r.id === 'graphics.weather')).toBe(false)
    expect(registeredOptionRows('interface').some(r => r.id === 'ui.reduceFlashing')).toBe(false)
  })

  it('the actor wetness decorator: only on the Classic path', () => {
    const classic = fakeCtx(fakeWorld('classic'))
    const f = weatherFeature(classic.ctx, { store: modernStore(), search: '', zoneAt: () => null })
    f.onFrame!(T0, 0.016)
    expect(classic.decorators).toHaveLength(1)
    f.dispose!()
    expect(classic.decorators).toHaveLength(0)
    const pbr = fakeCtx(fakeWorld('pbr'))
    const g = weatherFeature(pbr.ctx, { store: modernStore(), search: '', zoneAt: () => null })
    g.onFrame!(T0, 0.016)
    expect(pbr.decorators).toHaveLength(0)
    g.dispose!()
  })

  it('runs without a world (flat fallback) and tells the audio when the listener is sheltered', () => {
    const none = fakeCtx(null)
    const f = weatherFeature(none.ctx, { store: modernStore(), search: '?weather=rain', zoneAt: () => null })
    expect(() => f.onFrame!(T0, 0.016)).not.toThrow()
    expect(none.weatherAudio.update).toHaveBeenCalledWith(expect.objectContaining({ rain: WEATHER_PARAMS.rain.rain }), false)
    f.dispose!()
    const world = fakeWorld()
    world.weather.shelter = { valid: true, topAt: () => 6 }
    const roofed = fakeCtx(world)
    const g = weatherFeature(roofed.ctx, { store: modernStore(), search: '?weather=rain', zoneAt: () => null })
    g.onFrame!(T0, 0.016)
    expect(roofed.weatherAudio.update).toHaveBeenLastCalledWith(expect.anything(), true)
    g.dispose!()
  })
})

// ---- WeatherAudio on a fake host --------------------------------------------------------------------------

interface FakeVoice {
  file: string
  opts: StartOptions
  gain: number
  hz: number
  stopped: boolean
}

function fakeHost() {
  let t = 0
  const voices: FakeVoice[] = []
  const shots: { file: string; gain: number; pan: number }[] = []
  const muted: boolean[] = []
  const retained = new Map<string, number>()
  const cues: Record<string, SoundCue> = {
    'weather.rain': { files: ['etc/rain1'], gain: 1, category: 'ambient' },
    'weather.thunder.near': { files: ['etc/lightning1'], gain: 1, category: 'ambient' },
    'weather.thunder.mid': { files: ['etc/lightning2'], gain: 1, category: 'ambient' },
    'weather.thunder.far': { files: ['etc/lightning3'], gain: 1, category: 'ambient' },
    'weather.wind.strong': { files: ['env/donhwang_wind04'], gain: 1, category: 'ambient' },
    'weather.wind.gust': { files: ['env/dd_wind_01', 'env/dd_wind_02'], gain: 1, category: 'ambient' },
  }
  const host: WeatherAudioHost = {
    ready: () => true,
    now: () => t,
    cue: n => cues[n],
    buffer: () => ({ duration: 2.3, bytes: 1 }),
    start: (_b, opts) => {
      const v: FakeVoice = { file: '', opts, gain: opts.gain, hz: 20000, stopped: false }
      voices.push(v)
      const h: VoiceHandle = {
        stop: () => void (v.stopped = true),
        setPosition: () => {},
        setGain: g => void (v.gain = g),
        setLowpass: hz => void (v.hz = hz),
      }
      return h
    },
    retain: f => void retained.set(f, (retained.get(f) ?? 0) + 1),
    release: f => void retained.set(f, (retained.get(f) ?? 0) - 1),
    oneShot: (file, gain, pan) => void shots.push({ file, gain, pan }),
    muteBirds: on => void muted.push(on),
    rng: () => 0.5,
  }
  return { host, voices, shots, muted, retained, advance: (s: number) => (t += s) }
}

const live = (vs: FakeVoice[]) => vs.filter(v => !v.stopped)

describe('WeatherAudio', () => {
  it('the rain bed follows the rain: two detuned voices 1.1 s apart, gain 0.8 × rain, stops when dry', () => {
    const h = fakeHost()
    const a = new WeatherAudio(h.host)
    a.update({ rain: 0, windMs: 2, gustMs: 2 }, false)
    expect(h.voices).toHaveLength(0)
    a.update({ rain: 0.5, windMs: 6, gustMs: 6 }, false)
    expect(live(h.voices)).toHaveLength(1)
    expect(h.voices[0]!.opts).toMatchObject({ bus: 'ambient', loop: true, rate: WEATHER_AUDIO.rain.rates[0], filter: true })
    h.advance(1.2)
    a.update({ rain: 0.5, windMs: 6, gustMs: 6 }, false)
    expect(live(h.voices)).toHaveLength(2)
    expect(h.voices[1]!.opts.rate).toBe(WEATHER_AUDIO.rain.rates[1])
    const total = () => Math.hypot(...live(h.voices).map(v => v.gain))
    expect(total()).toBeCloseTo(rainGain(0.5, false), 6)
    a.update({ rain: 1, windMs: 6, gustMs: 6 }, false)
    expect(total()).toBeCloseTo(0.8, 6)
    a.update({ rain: 0, windMs: 2, gustMs: 2 }, false)
    expect(live(h.voices)).toHaveLength(0)
    expect(h.retained.get('etc/rain1')).toBe(0)
  })

  it('muffles the rain under shelter (−6 dB, 900 Hz low-pass) and opens again outside', () => {
    const h = fakeHost()
    const a = new WeatherAudio(h.host)
    a.update({ rain: 1, windMs: 6, gustMs: 6 }, false)
    expect(h.voices[0]!.hz).toBe(20000)
    a.update({ rain: 1, windMs: 6, gustMs: 6 }, true)
    expect(h.voices[0]!.hz).toBe(WEATHER_AUDIO.rain.shelterHz)
    expect(h.voices[0]!.gain * Math.SQRT2).toBeCloseTo(rainGain(1, true), 6)
    expect(rainGain(1, true)).toBeCloseTo(0.4, 9)
    a.update({ rain: 1, windMs: 6, gustMs: 6 }, false)
    expect(h.voices[0]!.hz).toBe(20000)
  })

  it('mutes the birds in rain or strong wind, with hysteresis, and lets them sing again on stop', () => {
    const h = fakeHost()
    const a = new WeatherAudio(h.host)
    a.update({ rain: 0.1, windMs: 4, gustMs: 4 }, false)
    expect(h.muted).toEqual([])
    a.update({ rain: 0.3, windMs: 4, gustMs: 4 }, false)
    expect(h.muted).toEqual([true])
    a.update({ rain: 0.22, windMs: 4, gustMs: 4 }, false) // between the thresholds: stays muted
    expect(h.muted).toEqual([true])
    a.update({ rain: 0.1, windMs: 4, gustMs: 4 }, false)
    expect(h.muted).toEqual([true, false])
    a.update({ rain: 0, windMs: 11, gustMs: 11 }, false)
    expect(h.muted).toEqual([true, false, true])
    a.stop()
    expect(h.muted.at(-1)).toBe(false)
  })

  it('strong wind: the bed fades in with the gusts and gust one-shots come every few seconds', () => {
    const h = fakeHost()
    const a = new WeatherAudio(h.host)
    expect(strongWindGain(4)).toBe(0)
    expect(strongWindGain(15)).toBe(1)
    a.update({ rain: 0, windMs: 13, gustMs: 16 }, false)
    // W9F A5: a steady file in two detuned voices (like the rain), lifted by the bed gain; uncorrelated voices add in power.
    const bed = h.voices.find(v => v.opts.rate === WEATHER_AUDIO.wind.rates[0] && !v.opts.filter)
    expect(bed?.gain).toBeCloseTo(WEATHER_AUDIO.wind.bedGain / Math.SQRT2, 6)
    expect(bed?.opts.offset).toBeGreaterThanOrEqual(0) // W9F A1: a random point of the file, not its opening
    for (let i = 0; i < 300; i++) {
      h.advance(0.1)
      a.update({ rain: 0, windMs: 13, gustMs: 16 }, false)
    }
    expect(h.shots.length).toBeGreaterThanOrEqual(2) // 30 s at one every 5-12 s
    expect(h.shots.every(s => s.file.startsWith('env/dd_wind'))).toBe(true)
  })

  it('thunder: the cue by distance, the gain by distance, panned', () => {
    const h = fakeHost()
    const a = new WeatherAudio(h.host)
    a.thunder(400, 0.5)
    a.thunder(1500)
    a.thunder(2800, -3)
    expect(h.shots.map(s => s.file)).toEqual(['etc/lightning1', 'etc/lightning2', 'etc/lightning3'])
    expect(h.shots[0]!.gain).toBe(1)
    expect(h.shots[1]!.gain).toBeCloseTo(thunderGain(1500), 9)
    expect(thunderGain(3000)).toBe(0.25)
    expect(h.shots[2]!.pan).toBe(-1)
  })

  it('GameAudio owns one; its bird mute reaches the area ambience', () => {
    class NullBackend implements AudioBackend {
      readonly ready = false
      now() {
        return 0
      }
      async decode(): Promise<SoundBuffer> {
        return { duration: 1, bytes: 1 }
      }
      start(_b: SoundBuffer, _o: StartOptions): VoiceHandle | null {
        return null
      }
      setBusGain() {}
      setListener(_p: Vec3Like, _f: Vec3Like) {}
      suspend() {}
      resume() {}
    }
    const mem = new Map<string, string>()
    const storage: StorageLike = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) }
    const audio = new GameAudio({ backend: new NullBackend(), settings: new AudioSettings(storage) })
    expect(audio.weather).toBeInstanceOf(WeatherAudio)
    audio.weather.update({ rain: 1, windMs: 13, gustMs: 14 }, false)
    expect(audio.ambient.oneShotsMuted).toBe(true)
    audio.dispose()
    expect(audio.ambient.oneShotsMuted).toBe(false)
  })
})

describe('AmbientPlayer.mute', () => {
  it('skips the one-shots while muted but keeps their schedule', () => {
    let now = 0
    const shots: string[] = []
    const out: AmbientOutput = { now: () => now, loop: () => ({ stop() {} }), oneShot: file => void shots.push(file) }
    const p = new AmbientPlayer(out, () => 0)
    p.setArea('T', { source: '', kind: 'town', music: '', day: [{ file: 'env/day_bird01', loop: false, everyS: [10, 20] }], night: [], regions: [] })
    p.mute('weather', true)
    now = 11
    p.tick()
    expect(shots).toEqual([])
    expect(p.schedule()[0]!.at).toBe(21)
    p.mute('weather', false)
    now = 21
    p.tick()
    expect(shots).toEqual(['env/day_bird01'])
  })
})
