/**
 * Black-output watchdog (the 2026-10-05 incident, second part): the 3D view black with no lost device and no error.
 * Now and then, during normal play in the world, the frame the engine just drew is read back as an 8×8 downscale
 * (`drawImage(canvas)` into a tiny 2D canvas, from the engine's onEndFrameObservable: the same task as the render, so
 * the WebGPU current texture and the WebGL drawing buffer are still valid) and judged (`judgeSample`). Several failed
 * samples in a row hand over to gpu-loss.ts `blackOutput`: WebGL2 once per tab session, then the help (gpu-help.ts).
 *
 * What it can detect: a canvas the engine leaves empty (every sample fully transparent: nothing was drawn, the
 * swap-chain texture is dead, or the browser's snapshot of the canvas comes back empty) at any time of day, and a
 * canvas that is pure black while the sun is up (a world frame always has sky or lit ground; `LIT_SUN_DEG`).
 * What it cannot: a canvas whose pixels are right but never reach the screen. The readback sees the canvas, not the
 * composited screen; when Chrome's compositor drops a correctly drawn WebGPU or WebGL canvas (seen after a GPU-process
 * crash, with software compositing) every sample is fine and nothing on the page can tell. That case is covered only by
 * the player: Esc → "Screen black?" and the login screen's link open the same help. Pure black at night or in a dark
 * place is not counted either (it could be the scene), nor anything while loading, in the grace after the world appears
 * (a teleport, a graphics rebuild, the tab shown again) or while the tab is hidden (no frames, no samples).
 *
 * Cost: one time comparison per frame; a sample (one small readback) every FAST_INTERVAL_MS for FAST_SAMPLES samples
 * after the world appears, after a suspect sample, a teleport or the tab coming back, then every SLOW_INTERVAL_MS.
 * Nothing is drawn, nothing changes on screen. Debugging: `__sroBlackWatch.probe()` samples the next frame and logs it.
 */
import type { AbstractEngine, Observer } from '@babylonjs/core'

/** The readback's size (SAMPLE_SIZE² pixels spread over the whole canvas). */
export const SAMPLE_SIZE = 8
/** A channel at or below this (of 255) counts as black. */
export const BLACK_MAX = 3
/** The sun this high (degrees) or more: a world frame cannot be pure black. */
export const LIT_SUN_DEG = 8
/** No judging this long after the world appears, a teleport, a graphics rebuild or the tab coming back. */
export const GRACE_MS = 2500
export const FAST_INTERVAL_MS = 2000
export const FAST_SAMPLES = 5
export const SLOW_INTERVAL_MS = 15_000
/** Failed samples in a row before the watchdog acts (about 6 s at the fast pace). */
export const STRIKES_TO_ACT = 3

/** One readback: something drawn, opaque black, nothing at all (transparent), or no pixels (the read failed). */
export type SampleClass = 'ok' | 'black' | 'empty' | 'unreadable'

/** Classifies RGBA bytes (getImageData's, unpremultiplied); null or too short is 'unreadable'. */
export function classifySample(rgba: ArrayLike<number> | null | undefined): SampleClass {
  if (!rgba || rgba.length < 4) return 'unreadable'
  let alpha = false
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i]! > BLACK_MAX || rgba[i + 1]! > BLACK_MAX || rgba[i + 2]! > BLACK_MAX) return 'ok'
    if (rgba[i + 3]! > 0) alpha = true
  }
  return alpha ? 'black' : 'empty'
}

/** What the game is doing when a sample is due. */
export interface WatchState {
  /** The world screen in normal play (loaded; false while loading, on other screens). */
  playing: boolean
  /** document.hidden. */
  hidden: boolean
  /** Time since the last arm (the world appeared, a teleport, a graphics rebuild, the tab shown again). */
  sinceArmMs: number
  /** The sun's elevation in degrees; null when the world does not know it (the flat fallback). */
  sunElevationDeg: number | null
}

/**
 * What a frame must show now: 'lit' (the sun is up: not even opaque black is possible), 'dark' (night or unknown: only
 * an empty canvas is wrong), 'none' (not judged: not playing, hidden, in the grace time).
 */
export type Reference = 'lit' | 'dark' | 'none'

export function referenceFor(s: WatchState): Reference {
  if (!s.playing || s.hidden || s.sinceArmMs < GRACE_MS) return 'none'
  return s.sunElevationDeg !== null && s.sunElevationDeg >= LIT_SUN_DEG ? 'lit' : 'dark'
}

/** 'ok' (healthy: strikes reset), 'skip' (no evidence either way), 'suspect' (a strike), 'act' (enough strikes). */
export type Verdict = 'ok' | 'skip' | 'suspect' | 'act'

/** Judges one sample against the reference; `strikes` are the failed samples in a row before it. Pure. */
export function judgeSample(sample: SampleClass, ref: Reference, strikes: number): { verdict: Verdict; strikes: number } {
  if (ref === 'none' || sample === 'unreadable') return { verdict: 'skip', strikes }
  if (sample === 'ok') return { verdict: 'ok', strikes: 0 }
  // Opaque black is a possible picture at night or in the dark; an empty canvas never is (every world frame is opaque).
  if (sample === 'black' && ref !== 'lit') return { verdict: 'skip', strikes }
  const n = strikes + 1
  return { verdict: n >= STRIKES_TO_ACT ? 'act' : 'suspect', strikes: n }
}

/** Reads a canvas as SAMPLE_SIZE² RGBA bytes; null when the read fails. */
export type Sampler = (canvas: HTMLCanvasElement) => Uint8ClampedArray | null

/** The 2D-canvas readback: one tiny canvas, made on first use, released by `dispose`. */
export class CanvasSampler {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null

  readonly sample: Sampler = src => {
    try {
      if (!src.width || !src.height) return null
      if (!this.ctx) {
        this.canvas = document.createElement('canvas')
        this.canvas.width = this.canvas.height = SAMPLE_SIZE
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: true })
        if (!this.ctx) return null
      }
      this.ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      this.ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      return this.ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
    } catch {
      return null
    }
  }

  dispose(): void {
    if (this.canvas) this.canvas.width = this.canvas.height = 0
    this.canvas = null
    this.ctx = null
  }
}

/** What the world screen tells the watchdog while it is in normal play. */
export interface WatchSource {
  sunElevationDeg(): number | null
}

export interface BlackWatchdogDeps {
  engine: Pick<AbstractEngine, 'onEndFrameObservable' | 'getRenderingCanvas' | 'isDisposed'>
  /** Enough failed samples (gpu-loss.ts blackOutput); called once, then the watchdog stops. */
  onBlack(detail: string): void
  sampler?: Sampler
  now?: () => number
  hidden?: () => boolean
}

export interface WatchLogEntry {
  at: number
  sample: SampleClass
  ref: Reference
  verdict: Verdict
}

/** Samples the drawn frame now and then (see the header) and calls `onBlack` once when it stays black. */
export class BlackWatchdog {
  private source: WatchSource | null = null
  private armedAt = 0
  private dueAt = Infinity
  private fastLeft = 0
  private strikes = 0
  private finished = false
  private probeNext = false
  private observer: Pick<Observer<unknown>, 'remove'> | null
  private readonly now: () => number
  private readonly hidden: () => boolean
  private readonly own: CanvasSampler | null
  private readonly sampler: Sampler
  /** The last samples, newest last (debugging). */
  readonly log: WatchLogEntry[] = []

  constructor(private readonly deps: BlackWatchdogDeps) {
    this.now = deps.now ?? (() => performance.now())
    this.hidden = deps.hidden ?? (() => typeof document !== 'undefined' && document.hidden)
    this.own = deps.sampler ? null : new CanvasSampler()
    this.sampler = deps.sampler ?? this.own!.sample
    this.observer = deps.engine.onEndFrameObservable.add(() => this.frame())
  }

  /** True once it acted (it never acts twice). */
  get done(): boolean {
    return this.finished
  }

  /** The world is in normal play (`source`) or not (null: loading, another screen). */
  play(source: WatchSource | null): void {
    this.source = source
    this.strikes = 0
    if (source) this.arm()
    else this.dueAt = Infinity
  }

  /** Starts the grace time and the fast pace again (a teleport, a graphics rebuild, the tab shown again). */
  arm(): void {
    if (!this.source || this.finished) return
    this.armedAt = this.now()
    this.fastLeft = FAST_SAMPLES
    this.dueAt = this.armedAt + GRACE_MS
  }

  /** Console: samples the next drawn frame and logs what it saw (ignores the schedule, never acts). */
  probe(): void {
    this.probeNext = true
  }

  private frame(): void {
    if (this.probeNext) {
      this.probeNext = false
      const canvas = this.deps.engine.getRenderingCanvas()
      const data = canvas ? this.sampler(canvas) : null
      console.info(`[gpu-watch] probe: ${classifySample(data)}`, data ? Array.from(data.slice(0, 16)) : null)
    }
    if (this.finished) return
    const now = this.now()
    if (now < this.dueAt) return
    const source = this.source
    if (!source) {
      this.dueAt = Infinity
      return
    }
    let sun: number | null = null
    try {
      sun = source.sunElevationDeg()
    } catch {
      sun = null
    }
    const ref = referenceFor({ playing: true, hidden: this.hidden(), sinceArmMs: now - this.armedAt, sunElevationDeg: sun })
    if (ref === 'none') {
      this.dueAt = Math.max(now + FAST_INTERVAL_MS, this.armedAt + GRACE_MS)
      return
    }
    const canvas = this.deps.engine.getRenderingCanvas()
    const sample = classifySample(canvas ? this.sampler(canvas) : null)
    const j = judgeSample(sample, ref, this.strikes)
    this.strikes = j.strikes
    this.log.push({ at: now, sample, ref, verdict: j.verdict })
    if (this.log.length > 20) this.log.shift()
    if (j.verdict === 'act') {
      this.finished = true
      this.dueAt = Infinity
      this.detach()
      this.deps.onBlack(`${j.strikes} ${sample} samples in a row (sun ${sun === null ? 'unknown' : `${sun.toFixed(0)}°`})`)
      return
    }
    if (j.verdict === 'suspect') {
      console.warn(`[gpu-watch] the drawn frame is ${sample} (${j.strikes}/${STRIKES_TO_ACT})`)
      this.fastLeft = Math.max(this.fastLeft, STRIKES_TO_ACT)
    }
    const fast = this.fastLeft > 0
    if (fast) this.fastLeft--
    this.dueAt = now + (fast ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS)
  }

  private detach(): void {
    this.observer?.remove()
    this.observer = null
    this.own?.dispose()
  }

  dispose(): void {
    this.finished = true
    this.source = null
    this.dueAt = Infinity
    this.detach()
  }
}

let active: BlackWatchdog | null = null
let offVisibility: (() => void) | null = null

/** main.ts: the game's watchdog on `engine`, acting through `onBlack` (gpu-loss.ts blackOutput). */
export function installBlackWatchdog(engine: BlackWatchdogDeps['engine'], onBlack: (detail: string) => void): BlackWatchdog {
  active?.dispose()
  offVisibility?.()
  const dog = new BlackWatchdog({ engine, onBlack })
  active = dog
  if (typeof document !== 'undefined') {
    const onVisible = () => {
      if (!document.hidden) dog.arm()
    }
    document.addEventListener('visibilitychange', onVisible)
    offVisibility = () => document.removeEventListener('visibilitychange', onVisible)
  }
  ;(globalThis as { __sroBlackWatch?: BlackWatchdog }).__sroBlackWatch = dog
  return dog
}

/** The world screen: in normal play with `source` (the sun), or not (null). No-op without a watchdog. */
export function watchWorld(source: WatchSource | null): void {
  active?.play(source)
}

/** The world screen: a teleport or a graphics rebuild just finished (the grace time starts again). */
export function watchArm(): void {
  active?.arm()
}
