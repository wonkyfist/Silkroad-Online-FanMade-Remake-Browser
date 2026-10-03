/**
 * V-12: the frame-time watchdog tells a frame rate capped by the display or the browser (a 30 Hz screen, a battery
 * saver, a throttled window: steady 31–35 ms frames with little work in them) from a game that is really slow
 * (settings.ts FrameWatchdog + WATCHDOG_CAP, world/frame-pace.ts FramePace).
 */
import { describe, expect, it } from 'vitest'
import { FrameWatchdog, WATCHDOG, WATCHDOG_CAP, type FrameCost } from '../src/settings.ts'
import { FramePace, PACE } from '../src/world/frame-pace.ts'

/** A deterministic jitter in [-1, 1]. */
const jitter = (i: number) => Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 4.1414) * 0.5

/** Feeds `seconds` of rAF frames at `periodMs` (± `jitterMs`) with `cpuMs` of work each; returns the end time. */
function feed(p: FramePace, from: number, seconds: number, periodMs: number, cpuMs = 2, jitterMs = 0): number {
  let t = from
  for (let i = 0; t < from + seconds * 1000; i++) {
    p.begin(t)
    p.end(t + cpuMs)
    t += periodMs + jitter(i) * jitterMs
  }
  return t
}

function cost(p: FramePace, gpu: { ms: number | null; measurable: boolean } = { ms: null, measurable: false }): FrameCost {
  return { paceMs: () => p.paceMs(), cpuMs: () => p.cpuMs(), gpuMs: () => gpu.ms, gpuMeasurable: () => gpu.measurable }
}

/** Runs the watchdog over `ms` of frames 31–35 ms (or `frame(i)`), past the grace; the number of trips. */
function run(w: FrameWatchdog, c: FrameCost | null, ms: number, frame: (i: number) => number = i => 33 + jitter(i) * 2, onFrame?: (now: number) => void): number {
  let trips = 0
  let now = 0
  w.reset(-WATCHDOG.graceMs)
  for (let i = 0; now < ms; i++) {
    const f = frame(i)
    now += f
    onFrame?.(now)
    if (w.sample(f, now, false, c)) trips++
  }
  return trips
}

describe('the frame pace (V-12)', () => {
  it('reads the display\'s own pace from the best second lately, and each frame\'s CPU work', () => {
    const p = new FramePace()
    expect(p.paceMs()).toBeNull()
    expect(p.cpuMs()).toBeNull()
    // a 60 Hz screen on a light screen (the login), then a heavy world at 25 fps: the pace stays the display's
    let t = feed(p, 0, 5, 1000 / 60, 3, 0.4)
    expect(p.paceMs()).toBeCloseTo(16.7, 0)
    t = feed(p, t, 20, 40, 30)
    expect(p.paceMs()).toBeCloseTo(16.7, 0)
    expect(p.cpuMs()).toBeCloseTo(30, 0)
    // a hidden tab (no frames for a minute) changes nothing
    t = feed(p, t + 60_000, 2, 40, 30)
    expect(p.paceMs()).toBeCloseTo(16.7, 0)
    // a 30 Hz screen never reads below ~33 ms (rAF never runs faster than the display)
    const slow = new FramePace()
    feed(slow, 0, 30, 1000 / 30, 4, 1.5)
    expect(slow.paceMs()!).toBeGreaterThan(31)
    // the pace is remembered PACE.memoryMs: a window moved to a slower screen is learned
    t = feed(p, t, PACE.memoryMs / 1000 + 5, 1000 / 30, 4)
    expect(p.paceMs()!).toBeGreaterThan(31)
  })
})

describe('the watchdog on a capped display (V-12)', () => {
  it('a 30 Hz screen (steady 31–35 ms frames) never drops the preset', () => {
    const p = new FramePace()
    feed(p, 0, 20, 1000 / 30, 6, 1.5) // the login and character screens at the display's 30 Hz
    const w = new FrameWatchdog()
    expect(run(w, cost(p), 300_000)).toBe(0)
    expect(w.hold).toBe('pace')
    // the same frames without the pace (the old watchdog) drop it: the V-12 bug
    expect(run(new FrameWatchdog(), null, 300_000)).toBeGreaterThan(0)
  })

  it('a 30 Hz screen with a really slow game (50 ms frames) still drops it', () => {
    const p = new FramePace()
    feed(p, 0, 20, 1000 / 30, 6, 1.5)
    expect(run(new FrameWatchdog(), cost(p), 30_000, i => 50 + jitter(i) * 3)).toBe(1)
  })

  it('a 60 Hz screen at 30 fps is slow: it drops (no GPU time to clear it)', () => {
    const p = new FramePace()
    feed(p, 0, 20, 1000 / 60, 3, 0.3)
    expect(run(new FrameWatchdog(), cost(p), 30_000)).toBe(1)
  })

  it('a browser that throttles a 60 Hz screen to 30 Hz (a pane, a battery saver): the GPU probe clears it', () => {
    const p = new FramePace()
    feed(p, 0, 20, 1000 / 60, 3, 0.3) // learned 16.7 ms before the throttle
    feed(p, 20_000, 5, 33.3, 4) // the world's CPU work: 4 ms a frame
    const gpu = { ms: null as number | null, measurable: true }
    const w = new FrameWatchdog()
    let asked = 0
    // the caller turns the GPU timer on when asked; it reads after a second
    const trips = run(w, cost(p, gpu), 120_000, undefined, now => {
      if (w.wantsGpu && gpu.ms === null) {
        asked++
        gpu.ms = 9
      }
      void now
    })
    expect(asked).toBe(1)
    expect(trips).toBe(0)
    expect(w.hold).toBe('work')
    // GPU-bound at 30 fps (the GPU takes 30 ms): a real drop
    const busy = new FrameWatchdog()
    expect(run(busy, cost(p, { ms: 30, measurable: true }), 30_000)).toBe(1)
  })

  it('waits at most probeMs for the GPU time, then judges as before', () => {
    const p = new FramePace()
    feed(p, 0, 20, 1000 / 60, 3, 0.3)
    const w = new FrameWatchdog()
    let tripAt = -1
    let wantedAt = -1
    let now = 0
    w.reset(-WATCHDOG.graceMs)
    const c = cost(p, { ms: null, measurable: true })
    for (let i = 0; now < 30_000 && tripAt < 0; i++) {
      const f = 33 + jitter(i) * 2
      now += f
      if (w.sample(f, now, false, c)) tripAt = now
      if (w.wantsGpu && wantedAt < 0) wantedAt = now
    }
    expect(wantedAt).toBeGreaterThan(0)
    expect(tripAt - wantedAt).toBeGreaterThanOrEqual(WATCHDOG_CAP.probeMs)
    expect(tripAt - wantedAt).toBeLessThan(WATCHDOG_CAP.probeMs + 1500)
    expect(w.wantsGpu).toBe(false)
  })
})
