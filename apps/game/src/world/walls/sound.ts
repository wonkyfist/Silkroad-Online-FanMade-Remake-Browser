/**
 * Siege of Jangan, layer 2: the walls' sounds (docs/SIEGE.md §9.4), 3D and distance-attenuated.
 *
 * - A wall moment (`wallFx`) plays its cue steps (look.ts `wallSounds`: a chip, a crack with a falling stone, a breach's
 *   blast, crash, falling stone and the town's alarm bell, a collapse's longer crash) at the moment's point.
 * - Hammer strokes every 2-4 s from a segment while it is being repaired (layer 3's `repairing`).
 * - The cues are packages/shared/src/sound.ts SIEGE_CUES (one file at random), played only when the export has the file.
 * - Big sounds carry far: each cue has its own long roll-off (look.ts `wallSoundGain`, up to 750 m for a breach, 900 m for
 *   the bell). The backend's panner rolls off fast (3 m reference), so the voice is placed on the line to the source at
 *   the distance where the panner gives that gain (town.ts `pannerDistanceFor`, as the town bell), and passes the
 *   voice policy's near cull as a non-own priority-1 sound. Steps are timed by `update(dt)` (no timers).
 */
import { SIEGE_CUES, type WallFxKind } from '@sro/shared'
import type { Vec3Like } from '../../audio/backend.ts'
import { HAMMER_EVERY_S, WALL_SOUND_RANGE, wallSoundGain, wallSounds } from './look.ts'

/** What WallAudio needs of GameAudio (tests pass a stand-in). */
export interface WallAudioHost {
  /** The exported files (SoundIndex.files) or null before the index loaded. */
  files(): Readonly<Record<string, unknown>> | null
  /** The listener's head (null: no listener yet). */
  listener(): Vec3Like | null
  play(file: string, o: { pos: Vec3Like; gain: number; bus: 'sfx' | 'ambient'; follow?: () => Vec3Like | null }): void
  preload(files: readonly string[]): void
  /** The panner distance giving gain g for a source d metres away (town.ts pannerDistanceFor). */
  pannerDistanceFor(g: number, d: number): number
  random(): number
}

interface Pending {
  cue: string
  at: number
  gain: number
  x: number
  y: number
  z: number
}

/** Steps waiting at most (a breach is 5 steps; several moments may overlap). */
const MAX_PENDING = 32

export class WallAudio {
  private t = 0
  private readonly pending: Pending[] = []
  private readonly hammers = new Map<string, { x: number; y: number; z: number; next: number }>()
  /** Counts for tests and debug. */
  readonly played: Record<string, number> = {}
  private preloaded = false

  constructor(private readonly host: WallAudioHost) {}

  /** Loads every siege file the export has (once, when the walls come into view). */
  preload(): void {
    if (this.preloaded) return
    const files = this.host.files()
    if (!files) return
    this.preloaded = true
    const ids = new Set<string>()
    for (const c of Object.values(SIEGE_CUES)) for (const f of c.files) if (files[f]) ids.add(f)
    this.host.preload([...ids])
  }

  /** A wall moment at (x, y, z). */
  moment(kind: WallFxKind, x: number, y: number, z: number): void {
    for (const s of wallSounds(kind)) {
      if (this.pending.length >= MAX_PENDING) this.pending.shift()
      this.pending.push({ cue: s.cue, at: this.t + s.at, gain: s.gain, x, y, z })
    }
    this.flush()
  }

  /** Repair under way at a segment (point: its middle), or stopped (null). */
  setRepairing(id: string, at: { x: number; y: number; z: number } | null): void {
    if (!at) {
      this.hammers.delete(id)
      return
    }
    const h = this.hammers.get(id)
    if (h) {
      h.x = at.x
      h.y = at.y
      h.z = at.z
    } else this.hammers.set(id, { ...at, next: this.t + this.host.random() * HAMMER_EVERY_S[0] })
  }

  update(dt: number): void {
    this.t += Math.max(0, dt)
    this.flush()
    for (const h of this.hammers.values()) {
      if (this.t < h.next) continue
      h.next = this.t + HAMMER_EVERY_S[0] + this.host.random() * (HAMMER_EVERY_S[1] - HAMMER_EVERY_S[0])
      this.cue('siege.repair', 1, h.x, h.y, h.z)
    }
  }

  private flush(): void {
    for (let i = 0; i < this.pending.length; ) {
      const p = this.pending[i]!
      if (p.at > this.t) {
        i++
        continue
      }
      this.pending.splice(i, 1)
      this.cue(p.cue, p.gain, p.x, p.y, p.z)
    }
  }

  /** Plays one cue at a point with its own roll-off; false when nothing was played (out of range, not exported). */
  cue(cue: string, gain: number, x: number, y: number, z: number): boolean {
    const c = SIEGE_CUES[cue]
    const files = this.host.files()
    const head = this.host.listener()
    if (!c || !files || !head) return false
    const choices = c.files.filter((f) => files[f])
    if (!choices.length) return false
    const dx = x - head.x, dy = y - head.y, dz = z - head.z
    const d = Math.hypot(dx, dy, dz)
    const g = wallSoundGain(cue, d)
    if (g <= 0.005) return false
    const file = choices[Math.floor(this.host.random() * choices.length) % choices.length]!
    const k = d > 1e-6 ? this.host.pannerDistanceFor(g, d) / d : 0
    const pos = { x: head.x + dx * k, y: head.y + dy * k, z: head.z + dz * k }
    this.host.play(file, { pos, gain: gain * c.gain, bus: c.category === 'ambient' ? 'ambient' : 'sfx' })
    this.played[cue] = (this.played[cue] ?? 0) + 1
    return true
  }

  get pendingCount(): number {
    return this.pending.length
  }

  get hammering(): number {
    return this.hammers.size
  }

  clear(): void {
    this.pending.length = 0
    this.hammers.clear()
  }
}

/** The farthest any wall cue carries (m): beyond this, nothing is scheduled to be heard. */
export const WALL_SOUND_MAX_M = Math.max(...Object.values(WALL_SOUND_RANGE).map((r) => r.range))
