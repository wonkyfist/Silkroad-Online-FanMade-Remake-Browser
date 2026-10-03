import type { AnimationGroup, Observer } from '@babylonjs/core'
import type { AnimEvent, Sidecar, SidecarAnimation } from './types.ts'

const stripName = (s: string) => s.toLowerCase().replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.[a-z0-9]+$/, '')

function sidecarName(a: SidecarAnimation): string | undefined {
  return a.name ?? a.clip ?? a.file
}

/** Finds the sidecar animation for a clip: exact name, then case-insensitive, then without folder/extension. */
export function findSidecarAnimation(sidecar: Sidecar | undefined, clipName: string): SidecarAnimation | undefined {
  const anims = sidecar?.animations
  if (!Array.isArray(anims)) return undefined
  const named = anims.filter(a => typeof sidecarName(a) === 'string')
  return named.find(a => sidecarName(a) === clipName)
    ?? named.find(a => sidecarName(a)!.toLowerCase() === clipName.toLowerCase())
    ?? named.find(a => stripName(sidecarName(a)!) === stripName(clipName))
}

export function clipEvents(sidecar: Sidecar | undefined, clipName: string): AnimEvent[] {
  const events = findSidecarAnimation(sidecar, clipName)?.events
  if (!Array.isArray(events)) return []
  return events.filter(e => typeof e?.timeMs === 'number' && Number.isFinite(e.timeMs))
}

/**
 * Drives the selected AnimationGroup: select, play/pause, loop, speed and scrubbing in seconds.
 * Partial (overlay) clips only animate a few joints, so they run on top of the last full clip
 * (the "base", STAND1 by default). Babylon applies animatables in start order, so the overlay,
 * started after the base, wins on the joints it animates.
 */
export class AnimationController {
  current: AnimationGroup | null = null
  private base: AnimationGroup | null = null
  private loopValue = true
  private speedValue = 1
  private lastFrame = 0
  private endObserver: Observer<AnimationGroup> | null = null

  constructor(
    readonly groups: readonly AnimationGroup[],
    private readonly isPartial: (name: string) => boolean = () => false,
  ) {}

  /** The full clip currently playing underneath an overlay, if any. */
  get baseName(): string | null {
    return this.current && this.base && this.current !== this.base ? this.base.name : null
  }

  private defaultBase(): AnimationGroup | null {
    const full = this.groups.filter(g => !this.isPartial(g.name))
    return full.find(g => g.name === 'STAND1') ?? full.find(g => /stand/i.test(g.name)) ?? full[0] ?? null
  }

  get loop(): boolean {
    return this.loopValue
  }

  set loop(value: boolean) {
    this.loopValue = value
    if (this.current) this.current.loopAnimation = value
  }

  get speed(): number {
    return this.speedValue
  }

  set speed(value: number) {
    this.speedValue = value
    if (this.current) this.current.speedRatio = value
  }

  get fps(): number {
    return this.current?.targetedAnimations[0]?.animation.framePerSecond ?? 60
  }

  /** Clip length in seconds, independent of the speed ratio. */
  get duration(): number {
    const g = this.current
    return g ? Math.max(0, (g.to - g.from) / this.fps) : 0
  }

  get isPlaying(): boolean {
    return !!this.current?.isPlaying
  }

  get frame(): number {
    const g = this.current
    if (!g) return 0
    if (g.isStarted && g.animatables.length) this.lastFrame = g.getCurrentFrame()
    return Math.min(g.to, Math.max(g.from, this.lastFrame))
  }

  /** Seconds since the start of the clip. */
  get time(): number {
    const g = this.current
    return g ? (this.frame - g.from) / this.fps : 0
  }

  select(nameOrGroup: string | AnimationGroup | null, autoplay = true): AnimationGroup | null {
    const next = typeof nameOrGroup === 'string'
      ? this.groups.find(g => g.name === nameOrGroup) ?? this.groups.find(g => g.name.toLowerCase() === nameOrGroup.toLowerCase()) ?? null
      : nameOrGroup
    const overlay = !!next && this.isPartial(next.name)
    const base = overlay ? (this.base && this.base !== next ? this.base : this.defaultBase()) : next
    this.stopAll(overlay ? base : null)
    this.current = next
    if (!next) return null
    this.base = base
    if (overlay && base && !(base.isStarted && base.animatables.length)) {
      base.start(true, this.speedValue, base.from, base.to)
    }
    this.lastFrame = next.from
    this.endObserver = next.onAnimationGroupEndObservable.add(() => {
      this.lastFrame = next.to
    })
    next.start(this.loopValue, this.speedValue, next.from, next.to)
    if (!autoplay) {
      next.pause()
      next.goToFrame(next.from)
    }
    return next
  }

  play(): void {
    const g = this.current
    if (!g) return
    if (g.isStarted && g.animatables.length) {
      if (!g.isPlaying) g.play(this.loopValue)
      return
    }
    // Stopped at the end of a non-looping run: start over.
    g.start(this.loopValue, this.speedValue, g.from, g.to)
  }

  pause(): void {
    this.current?.pause()
  }

  togglePlay(): void {
    if (this.isPlaying) this.pause()
    else this.play()
  }

  /** Pauses and jumps to `seconds` from the clip start. */
  scrub(seconds: number): void {
    const g = this.current
    if (!g) return
    const frame = Math.min(g.to, Math.max(g.from, g.from + seconds * this.fps))
    if (!g.isStarted || !g.animatables.length) g.start(this.loopValue, this.speedValue, g.from, g.to)
    if (g.isPlaying) g.pause()
    g.goToFrame(frame)
    this.lastFrame = frame
  }

  /** Stops every group except `keep` (the base under a new overlay). */
  stopAll(keep: AnimationGroup | null = null): void {
    if (this.current && this.endObserver) this.current.onAnimationGroupEndObservable.remove(this.endObserver)
    this.endObserver = null
    for (const g of this.groups) if (g.isStarted && g !== keep) g.stop(true)
    this.current = null
    if (!keep) this.base = null
  }

  dispose(): void {
    this.stopAll()
  }
}
