/**
 * The black-output watchdog (gpu-watchdog.ts) and the graphics-mode plumbing around it: the 3D view must never stay
 * black without the game doing something (the 2026-10-05 incident). The judging is pure; the watchdog only samples
 * every few seconds during normal play and acts once.
 */
import { Observable } from '@babylonjs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSoftwareAdapter } from '../src/engine.ts'
import {
  BlackWatchdog,
  FAST_INTERVAL_MS,
  GRACE_MS,
  LIT_SUN_DEG,
  SAMPLE_SIZE,
  SLOW_INTERVAL_MS,
  STRIKES_TO_ACT,
  classifySample,
  judgeSample,
  referenceFor,
  type SampleClass,
  type WatchState,
} from '../src/gpu-watchdog.ts'
import { en } from '../src/i18n/en.ts'
import { enGpu } from '../src/i18n/en-gpu.ts'
import { GRAPHICS_BACKENDS, defaultSettings, normalizeSettings } from '../src/settings.ts'

const N = SAMPLE_SIZE * SAMPLE_SIZE
function pixels(fill: (i: number) => [number, number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(N * 4)
  for (let i = 0; i < N; i++) out.set(fill(i), i * 4)
  return out
}
const EMPTY = pixels(() => [0, 0, 0, 0])
const BLACK = pixels(() => [0, 0, 0, 255])
const NIGHT = pixels(i => (i === 40 ? [6, 8, 20, 255] : [1, 1, 2, 255]))
const DAY = pixels(i => (i < 32 ? [150, 180, 220, 255] : [90, 80, 60, 255]))

describe('classifySample', () => {
  it('tells drawn, opaque black, empty and unreadable apart', () => {
    expect(classifySample(DAY)).toBe('ok')
    // One faint star or lamp is enough: night scenes are drawn.
    expect(classifySample(NIGHT)).toBe('ok')
    expect(classifySample(BLACK)).toBe('black')
    expect(classifySample(EMPTY)).toBe('empty')
    expect(classifySample(null)).toBe('unreadable')
    expect(classifySample(new Uint8ClampedArray(0))).toBe('unreadable')
  })
})

describe('referenceFor and judgeSample', () => {
  const play: WatchState = { playing: true, hidden: false, sinceArmMs: GRACE_MS + 1, sunElevationDeg: 40 }

  it('judges nothing while loading, hidden or in the grace time after the world appears', () => {
    expect(referenceFor({ ...play, playing: false })).toBe('none')
    expect(referenceFor({ ...play, hidden: true })).toBe('none')
    expect(referenceFor({ ...play, sinceArmMs: GRACE_MS - 1 })).toBe('none')
    expect(referenceFor(play)).toBe('lit')
    expect(referenceFor({ ...play, sunElevationDeg: LIT_SUN_DEG - 1 })).toBe('dark')
    expect(referenceFor({ ...play, sunElevationDeg: null })).toBe('dark')
    for (const s of ['ok', 'black', 'empty', 'unreadable'] as SampleClass[]) expect(judgeSample(s, 'none', 2)).toEqual({ verdict: 'skip', strikes: 2 })
  })

  it('an empty canvas strikes day and night; opaque black only while the sun is up', () => {
    expect(judgeSample('empty', 'dark', 0)).toEqual({ verdict: 'suspect', strikes: 1 })
    expect(judgeSample('empty', 'lit', 0)).toEqual({ verdict: 'suspect', strikes: 1 })
    // Night, a cave, a fade to black: opaque black is a possible picture there.
    expect(judgeSample('black', 'dark', 1)).toEqual({ verdict: 'skip', strikes: 1 })
    expect(judgeSample('black', 'lit', 0)).toEqual({ verdict: 'suspect', strikes: 1 })
    expect(judgeSample('black', 'lit', STRIKES_TO_ACT - 1)).toEqual({ verdict: 'act', strikes: STRIKES_TO_ACT })
    // A good sample resets; an unreadable one proves nothing either way.
    expect(judgeSample('ok', 'lit', 2)).toEqual({ verdict: 'ok', strikes: 0 })
    expect(judgeSample('unreadable', 'lit', 2)).toEqual({ verdict: 'skip', strikes: 2 })
  })
})

describe('BlackWatchdog', () => {
  let now = 0
  let hidden = false
  let data: Uint8ClampedArray | null = DAY
  let sun: number | null = 40
  const sampler = vi.fn(() => data)

  function make() {
    const engine = { onEndFrameObservable: new Observable<unknown>(), getRenderingCanvas: () => ({ width: 1280, height: 720 }) as HTMLCanvasElement, isDisposed: false }
    const onBlack = vi.fn<(detail: string) => void>()
    const dog = new BlackWatchdog({ engine: engine as never, onBlack, sampler, now: () => now, hidden: () => hidden })
    /** Runs frames every 100 ms for `ms`. */
    const run = (ms: number) => {
      for (const end = now + ms; now < end; ) {
        now += 100
        engine.onEndFrameObservable.notifyObservers(null)
      }
    }
    /** Runs frames until `k` more samples were taken. */
    const samples = (k: number) => {
      const want = sampler.mock.calls.length + k
      for (let i = 0; i < 10_000 && sampler.mock.calls.length < want; i++) run(100)
    }
    return { engine, dog, onBlack, run, samples }
  }

  beforeEach(() => {
    now = 1000
    hidden = false
    data = DAY
    sun = 40
    sampler.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('costs nothing off the world, samples after the grace, then slows down; never reads while hidden', () => {
    const { dog, run, engine } = make()
    run(60_000)
    expect(sampler).not.toHaveBeenCalled()
    dog.play({ sunElevationDeg: () => sun })
    run(GRACE_MS - 200)
    expect(sampler).not.toHaveBeenCalled()
    run(400)
    expect(sampler).toHaveBeenCalledTimes(1)
    // The fast pace after the world appears, then one sample per SLOW_INTERVAL_MS.
    run(FAST_INTERVAL_MS * 5)
    const fast = sampler.mock.calls.length
    expect(fast).toBeGreaterThanOrEqual(5)
    run(SLOW_INTERVAL_MS * 4)
    expect(sampler.mock.calls.length - fast).toBeLessThanOrEqual(5)
    hidden = true
    const before = sampler.mock.calls.length
    run(SLOW_INTERVAL_MS * 3)
    expect(sampler.mock.calls.length).toBe(before)
    dog.play(null)
    hidden = false
    run(SLOW_INTERVAL_MS * 3)
    expect(sampler.mock.calls.length).toBe(before)
    dog.dispose()
    expect(engine.onEndFrameObservable.observers.length).toBe(0)
  })

  it('an empty canvas acts once after STRIKES_TO_ACT samples, then stops for good', () => {
    const { dog, run, onBlack, engine } = make()
    data = EMPTY
    sun = -20
    dog.play({ sunElevationDeg: () => sun })
    run(GRACE_MS + FAST_INTERVAL_MS * (STRIKES_TO_ACT + 1))
    expect(onBlack).toHaveBeenCalledTimes(1)
    expect(onBlack.mock.calls[0]![0]).toContain(`${STRIKES_TO_ACT} empty samples`)
    expect(dog.done).toBe(true)
    expect(engine.onEndFrameObservable.observers.length).toBe(0)
    dog.arm()
    dog.play({ sunElevationDeg: () => sun })
    run(60_000)
    expect(onBlack).toHaveBeenCalledTimes(1)
  })

  it('night, a fade or a loading screen never act; one good sample resets the count', () => {
    const { dog, run, onBlack, samples } = make()
    // Opaque black at night (or in a dark place): never.
    data = BLACK
    sun = -10
    dog.play({ sunElevationDeg: () => sun })
    run(SLOW_INTERVAL_MS * 10)
    expect(onBlack).not.toHaveBeenCalled()
    // Daylight black, but a good frame between the bad ones: the count starts over.
    sun = 40
    dog.arm()
    samples(STRIKES_TO_ACT - 1)
    data = DAY
    samples(1)
    data = BLACK
    samples(STRIKES_TO_ACT - 1)
    expect(onBlack).not.toHaveBeenCalled()
    expect(dog.log.slice(-STRIKES_TO_ACT).map(e => e.verdict)).toEqual(['ok', ...Array<string>(STRIKES_TO_ACT - 1).fill('suspect')])
    // Leaving the world (loading, a teleport) and coming back: the grace again, then the count.
    dog.play(null)
    run(SLOW_INTERVAL_MS)
    dog.play({ sunElevationDeg: () => sun })
    run(GRACE_MS - 200)
    expect(onBlack).not.toHaveBeenCalled()
    run(FAST_INTERVAL_MS * (STRIKES_TO_ACT + 1))
    expect(onBlack).toHaveBeenCalledTimes(1)
    dog.dispose()
  })

  it('unreadable samples (a failed readback) prove nothing', () => {
    const { dog, run, onBlack } = make()
    data = null
    dog.play({ sunElevationDeg: () => sun })
    run(SLOW_INTERVAL_MS * 10)
    expect(onBlack).not.toHaveBeenCalled()
    expect(dog.log.every(e => e.verdict === 'skip')).toBe(true)
    dog.dispose()
  })
})

describe('the graphics mode setting and the software adapter check', () => {
  it('persists auto / webgpu / webgl2 and defaults to auto', () => {
    expect(GRAPHICS_BACKENDS).toEqual(['auto', 'webgpu', 'webgl2'])
    expect(defaultSettings().graphics.backend).toBe('auto')
    expect(normalizeSettings({ v: 1, graphics: { backend: 'webgl2' } }).graphics.backend).toBe('webgl2')
    expect(normalizeSettings({ v: 1, graphics: { backend: 'vulkan' } }).graphics.backend).toBe('auto')
    expect(normalizeSettings({ v: 1, graphics: {} }).graphics.backend).toBe('auto')
  })

  it('a fallback or software WebGPU adapter counts as software; a real GPU does not', () => {
    expect(isSoftwareAdapter(null)).toBe(false)
    expect(isSoftwareAdapter({ features: [], info: { vendor: 'amd', architecture: 'rdna-4' } })).toBe(false)
    expect(isSoftwareAdapter({ features: [], info: { isFallbackAdapter: true } })).toBe(true)
    expect(isSoftwareAdapter({ features: [], isFallbackAdapter: true })).toBe(true)
    expect(isSoftwareAdapter({ features: [], info: { vendor: 'google', architecture: 'swiftshader' } })).toBe(true)
    expect(isSoftwareAdapter({ features: [], info: { vendor: 'microsoft', description: 'Microsoft Basic Render Driver' } })).toBe(true)
  })

  it('every string the recovery and the help use is in the English table', () => {
    const keys = [
      'gpu.blackWebgl', 'gpu.blackRestored', 'gpu.modeApplied', 'gpu.reloaded', 'gpu.reloadingWebgl', 'gpu.stopped', 'gpu.reload',
      'gpu.help.title', 'gpu.help.intro', 'gpu.help.detected', 'gpu.help.fixBrowser', 'gpu.help.fixGpuProcess',
      'gpu.help.fixCompatibility', 'gpu.help.compatibility', 'gpu.help.close', 'gpu.help.link', 'menu.blackScreen',
      'options.backend', 'options.backend.auto', 'options.backend.webgpu', 'options.backend.webgl2', 'options.backend.ask',
      'options.backend.reloadNow', 'options.backend.later', 'options.backend.pending', 'options.backend.fallback',
    ]
    const table = en as Record<string, string>
    for (const k of keys) {
      expect(enGpu, k).toHaveProperty([k])
      expect(table[k], k).toBe((enGpu as Record<string, string>)[k])
    }
    expect(table['gpu.help.fixGpuProcess']).toContain('Shift+Esc')
    expect(table['gpu.help.fixGpuProcess']).toContain('GPU Process')
    expect(table['gpu.help.fixBrowser']).toContain('Edge')
  })
})
