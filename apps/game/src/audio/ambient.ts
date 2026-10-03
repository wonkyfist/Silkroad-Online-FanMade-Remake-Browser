/**
 * Area ambience (docs/SOUND.md §5.10): a looped bed (day_wind) plus one-shots (birds, gusts) each repeated every
 * everyS[0]..everyS[1] seconds, per effectenvsnd.txt. Times are on the audio clock, so the schedule freezes with a
 * suspended context (hidden tab). Pure scheduling behind AmbientOutput; GameAudio supplies the WebAudio side. The
 * weather mutes the one-shots in rain (`mute`, docs/WEATHER.md §7.5).
 *
 * Wave 10 (GRASS_LIFE §5.3, lane GL-O): a flock of the wildlife that flushes (World.life.onFlush) plays one of the
 * area's day bird one-shots at the flock, once per flush (`flush`); silent while the one-shots are muted (rain, wind).
 */
import type { AmbientLayer, AreaSound } from '@sro/shared'
import type { Rng } from './cues.ts'

/** Cross-fade of the loop layer between areas (seconds). */
export const AMBIENT_FADE_S = 1.5

export interface AmbientLoopHandle {
  stop(fadeS: number): void
}

export interface AmbientOutput {
  /** Audio clock, seconds. */
  now(): number
  /** Starts a looped file faded in over `fadeS`; null when it cannot play (not loaded, no audio). */
  loop(file: string, fadeS: number): AmbientLoopHandle | null
  /** A one-shot at `gain` 0..1 panned -1..1 (non-spatial). */
  oneShot(file: string, gain: number, pan: number): void
  /** A one-shot at a world position (glTF metres); without it a flush plays non-spatial. */
  oneShotAt?(file: string, gain: number, pos: { x: number; y: number; z: number }): void
}

/** The retail day bird one-shots (SOUND §5.10): a flush picks from these when the area names none. */
export const FLUSH_BIRD_FILES: readonly string[] = ['env/day_bird01', 'env/day_bird02', 'env/day_bird03', 'env/day_bird04', 'env/day_bird05']
/** Two flushes closer than this (audio clock, s) share one sound: two flocks taking off together are one burst. */
export const FLUSH_GAP_S = 0.5
const BIRD_FILE = /(^|\/)day_bird\d+$/

interface Pending {
  layer: AmbientLayer
  at: number
}

export class AmbientPlayer {
  private areaId: string | null = null
  private loopFile: string | null = null
  private loopHandle: AmbientLoopHandle | null = null
  private pending: Pending[] = []
  /** Why the one-shots (birds, gusts of the area) are silent: the weather mutes them in rain and strong wind. */
  private readonly muted = new Set<string>()
  /** The area's day bird one-shots (a flush plays one of them). */
  private birds: readonly string[] = []
  private lastFlush = -Infinity

  constructor(private readonly out: AmbientOutput, private readonly rng: Rng = Math.random) {}

  get area(): string | null {
    return this.areaId
  }

  /** Switches to an area (null = silence, e.g. leaving the world). The same loop file carries on without a seam. */
  setArea(id: string | null, area: AreaSound | null, time: 'day' | 'night' = 'day'): void {
    if (id === this.areaId && area) return
    this.areaId = area ? id : null
    const birds = area ? area.day.filter(l => !l.loop && BIRD_FILE.test(l.file)).map(l => l.file) : []
    this.birds = birds.length ? birds : area ? FLUSH_BIRD_FILES : []
    const layers = area ? area[time] : []
    const loop = layers.find(l => l.loop) ?? null
    if (loop?.file !== this.loopFile || !this.loopHandle) {
      this.loopHandle?.stop(AMBIENT_FADE_S)
      this.loopHandle = null
      this.loopFile = loop?.file ?? null
      if (loop) this.startLoop()
    }
    const now = this.out.now()
    this.pending = layers.filter(l => !l.loop).map(layer => ({ layer, at: now + this.delay(layer) }))
  }

  /** Plays due one-shots and reschedules them; retries a loop that could not start yet (still loading). */
  tick(): void {
    if (this.loopFile && !this.loopHandle) this.startLoop()
    if (!this.pending.length) return
    const now = this.out.now()
    const silent = this.muted.size > 0
    for (const p of this.pending) {
      if (p.at > now) continue
      // muted: the one-shot is skipped but keeps its schedule, so the birds come back on their own timing
      if (!silent) this.out.oneShot(p.layer.file, 0.5 + 0.5 * this.rng(), (this.rng() * 2 - 1) * 0.6)
      p.at = now + this.delay(p.layer)
    }
  }

  /**
   * Mutes (or unmutes) the one-shots for `reason` (docs/WEATHER.md §7.5: 'weather' while it rains or blows hard). The
   * loop bed keeps playing. They stay silent while any reason holds.
   */
  mute(reason: string, on: boolean): void {
    if (on) this.muted.add(reason)
    else this.muted.delete(reason)
  }

  /**
   * A flock flushed at `pos` (World.life.onFlush): one bird one-shot there, at most one per flush. Nothing while muted
   * (rain, strong wind), outside an area (no world) or within FLUSH_GAP_S of the last flush sound. True when it played.
   */
  flush(pos: { x: number; y: number; z: number }): boolean {
    if (this.muted.size > 0 || !this.areaId || !this.birds.length) return false
    const now = this.out.now()
    if (now - this.lastFlush < FLUSH_GAP_S) return false
    this.lastFlush = now
    const file = this.birds[Math.min(this.birds.length - 1, Math.floor(this.rng() * this.birds.length))]!
    const gain = 0.7 + 0.3 * this.rng()
    if (this.out.oneShotAt) this.out.oneShotAt(file, gain, pos)
    else this.out.oneShot(file, gain, 0)
    return true
  }

  /** True while any reason mutes the one-shots. */
  get oneShotsMuted(): boolean {
    return this.muted.size > 0
  }

  /** Stops everything at once (screen teardown). */
  stop(): void {
    this.loopHandle?.stop(0.2)
    this.loopHandle = null
    this.loopFile = null
    this.pending = []
    this.areaId = null
    this.birds = []
  }

  /** Next time (from now) of the one-shots, for tests and debugging. */
  schedule(): readonly { file: string; at: number }[] {
    return this.pending.map(p => ({ file: p.layer.file, at: p.at }))
  }

  private startLoop(): void {
    if (!this.loopFile) return
    this.loopHandle = this.out.loop(this.loopFile, AMBIENT_FADE_S)
  }

  private delay(layer: AmbientLayer): number {
    const [a, b] = layer.everyS
    return a + (Math.max(a, b) - a) * this.rng()
  }
}
