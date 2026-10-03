/**
 * The frame pace (V-12): what the frame-time watchdog (settings.ts `FrameWatchdog`) needs to tell a display or a
 * browser that caps the frame rate (a 30 Hz screen, a battery saver, a throttled pane: steady 31–35 ms frames with
 * little work in them) from a game that is really slow.
 *
 * - The display's own pace: the best sustained frame period seen lately (the median of each second's rAF intervals,
 *   the lowest of the last PACE.memoryMs), fed from the app's render loop on every screen (the login and character
 *   screens are light, so on a 60 Hz screen it reads 16.7 ms there). rAF never runs faster than the display, so on a
 *   30 Hz screen it can never read less than ~33 ms: frames at that pace are vsync, not slowness.
 * - The CPU work of a frame: the render loop's own time (the world's per-frame logic and `scene.render()`'s draw
 *   submission), p90 of the last PACE.cpuFrames frames.
 *
 * Pure apart from the module's one instance (`framePace`); the times are page milliseconds (performance.now()).
 */

export const PACE = {
  /** One cadence sample per this long (its median interval). */
  bucketMs: 1000,
  /** A second with fewer frames (a hidden tab, a load) says nothing about the display. */
  minBucketFrames: 8,
  /** How long the best cadence is remembered (a window moved to a slower screen is learned within this). */
  memoryMs: 10 * 60_000,
  /** The CPU work window (frames). */
  cpuFrames: 120,
} as const

export class FramePace {
  private last = NaN
  private bucketStart = NaN
  private bucket: number[] = []
  private readonly seconds: Array<{ t: number; ms: number }> = []
  private readonly cpu = new Float64Array(PACE.cpuFrames)
  private cpuCount = 0
  private cpuAt = 0
  private workStart = NaN

  /** A frame (one rAF callback) begins at `now`. */
  begin(now: number): void {
    this.workStart = now
    const dt = now - this.last
    this.last = now
    if (!(this.bucketStart <= now) || now - this.bucketStart > PACE.bucketMs * 3) {
      // the first frame, or a long gap (a hidden tab): start a fresh second
      this.bucketStart = now
      this.bucket.length = 0
      return
    }
    if (dt > 0 && dt < PACE.bucketMs) this.bucket.push(dt)
    if (now - this.bucketStart < PACE.bucketMs) return
    if (this.bucket.length >= PACE.minBucketFrames) {
      const sorted = this.bucket.sort((a, b) => a - b)
      this.seconds.push({ t: now, ms: sorted[sorted.length >> 1]! })
    }
    this.bucket.length = 0
    this.bucketStart = now
    let drop = 0
    while (drop < this.seconds.length && now - this.seconds[drop]!.t > PACE.memoryMs) drop++
    if (drop) this.seconds.splice(0, drop)
  }

  /** The frame's work ended at `now` (after `scene.render()`). */
  end(now: number): void {
    const ms = now - this.workStart
    if (!(ms >= 0)) return
    this.cpu[this.cpuAt] = ms
    this.cpuAt = (this.cpuAt + 1) % PACE.cpuFrames
    this.cpuCount = Math.min(PACE.cpuFrames, this.cpuCount + 1)
  }

  /** The display's (or the browser's) own frame period in ms: the best second lately; null until one was seen. */
  paceMs(): number | null {
    let best = Infinity
    for (const s of this.seconds) if (s.ms < best) best = s.ms
    return Number.isFinite(best) ? best : null
  }

  /** The CPU work of a frame (ms, p90 of the recent frames); null before a full window. */
  cpuMs(): number | null {
    if (this.cpuCount < PACE.cpuFrames / 2) return null
    const v = Array.from(this.cpu.subarray(0, this.cpuCount)).sort((a, b) => a - b)
    return v[Math.min(v.length - 1, Math.floor(v.length * 0.9))]!
  }

  /** Forget everything (tests). */
  reset(): void {
    this.last = NaN
    this.bucketStart = NaN
    this.bucket.length = 0
    this.seconds.length = 0
    this.cpuCount = 0
    this.cpuAt = 0
    this.workStart = NaN
  }
}

/** The page's frame pace, fed by the app's render loop (app.ts) on every screen. */
export const framePace = new FramePace()
