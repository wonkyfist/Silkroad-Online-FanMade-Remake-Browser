/**
 * GAME's sky-clock feature (docs/WAVE_PLAN3.md §6.15, docs/SKY.md §2.2): the clock from `worldEnter` / `worldClock`
 * reaches World.setClock on a mock session; the preview rollout keeps the frozen noon until the player opts in; an
 * older server without a clock gets a local one from noon; the HUD clock text.
 */
import { DEFAULT_CLOCK, clockAt, type ServerMessage, type WorldClockState } from '@sro/shared'
import { describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../src/settings.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { clockText, localNoonClock, skyClockFeature } from '../src/world/features/sky-clock.ts'

const NOW = Date.UTC(2026, 8, 28, 12)
const CLOCK: WorldClockState = { anchorMs: NOW - 3_600_000, anchorDays: 12.3, ...DEFAULT_CLOCK }

function fakeWorld() {
  const w = {
    timeOfDay: 0.5,
    worldClock: null as WorldClockState | null,
    setClock: vi.fn((c: WorldClockState | null) => {
      w.worldClock = c
      if (c) w.timeOfDay = clockAt(c, NOW).t
    }),
    setTimeOfDay: vi.fn((t: number) => {
      w.worldClock = null
      w.timeOfDay = t
    }),
  }
  return w
}

function setup(rollout: 'preview' | 'on', modern = false) {
  const world = fakeWorld()
  let loaded = false
  const ctx = {
    session: {},
    serverNow: () => NOW,
    world: () => (loaded ? { world } : null),
    minimap: () => null,
  } as unknown as WorldFeatureContext
  const store = new SettingsStore(null)
  if (modern) store.set({ graphics: { modern: true } })
  const f = skyClockFeature(ctx, { store, rollout })
  return { world, f, store, load: () => (loaded = true) }
}

const enter = (clock?: WorldClockState) => ({ t: 'worldEnter', world: clock ? { clock } : {} }) as unknown as ServerMessage

describe('skyClockFeature', () => {
  it('a bare context (the feature list) gets no hooks', () => {
    expect(skyClockFeature({} as WorldFeatureContext)).toEqual({})
  })

  it("'on': worldEnter's clock reaches the world once it loads, and a worldClock replaces it", () => {
    const { world, f, load } = setup('on')
    f.onMessage!(enter(CLOCK))
    f.onFrame!(NOW, 0.016)
    expect(world.setClock).not.toHaveBeenCalled() // no world yet
    load()
    f.onFrame!(NOW, 0.016)
    expect(world.setClock).toHaveBeenCalledTimes(1)
    expect(world.setClock.mock.calls[0]![0]).toBe(CLOCK)
    f.onFrame!(NOW, 0.016)
    expect(world.setClock).toHaveBeenCalledTimes(1) // not every frame
    const moved = { ...CLOCK, anchorDays: 20.75 }
    f.onMessage!({ t: 'worldClock', clock: moved } as ServerMessage)
    expect(world.setClock).toHaveBeenLastCalledWith(moved, expect.any(Function))
    f.dispose!()
  })

  it("'preview': the frozen noon until the player opts in, and back to it after", () => {
    const { world, f, store, load } = setup('preview')
    load()
    f.onMessage!(enter(CLOCK))
    f.onFrame!(NOW, 0.016)
    expect(world.setClock).not.toHaveBeenCalled()
    expect(world.setTimeOfDay).not.toHaveBeenCalled() // the load itself is at noon
    store.set({ graphics: { modern: true } })
    expect(world.setClock).toHaveBeenLastCalledWith(CLOCK, expect.any(Function))
    expect(world.timeOfDay).not.toBe(0.5)
    store.set({ graphics: { modern: false } })
    expect(world.setTimeOfDay).toHaveBeenLastCalledWith(0.5)
    expect(world.worldClock).toBeNull()
    f.dispose!()
  })

  it("'on': the Low guard's combination (Low + classic sky + weather off) keeps the frozen noon; the Weather row starts the time", () => {
    const { world, f, store, load } = setup('on')
    store.set({ graphics: { preset: 'low', sky: 'classic', weather: 'off' } })
    load()
    f.onMessage!(enter(CLOCK))
    f.onFrame!(NOW, 0.016)
    expect(world.setClock).not.toHaveBeenCalled()
    expect(world.timeOfDay).toBe(0.5)
    store.set({ graphics: { weather: 'low' } })
    expect(world.setClock).toHaveBeenLastCalledWith(CLOCK, expect.any(Function))
    expect(world.timeOfDay).not.toBe(0.5)
    // Back to weather off: noon again, as the pre-release Low had it.
    store.set({ graphics: { weather: 'off' } })
    expect(world.setTimeOfDay).toHaveBeenLastCalledWith(0.5)
    expect(world.worldClock).toBeNull()
    f.dispose!()
  })

  it('an older server without a clock: a local one from noon (with the new look)', () => {
    const { world, f, load } = setup('preview', true)
    load()
    f.onMessage!(enter())
    const c = world.setClock.mock.calls[0]![0] as WorldClockState
    expect(c).toEqual(localNoonClock(NOW))
    expect(clockAt(c, NOW).t).toBeCloseTo(0.5, 6)
    expect(c.running).toBe(true)
    f.dispose!()
  })

  it('formats the HUD clock', () => {
    expect(clockText(0)).toBe('00:00')
    expect(clockText(0.5)).toBe('12:00')
    expect(clockText(0.75 + 0.5 / 1440)).toBe('18:00')
    expect(clockText(1.25)).toBe('06:00')
    expect(clockText(0.999999)).toBe('23:59')
    expect(clockText(NaN)).toBe('12:00')
  })
})
