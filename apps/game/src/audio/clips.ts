/**
 * Clip sounds in sync with animations (docs/SOUND.md §5.7). Babylon clips from animation packs are shared between
 * actors, so no animation events are attached; instead each audible actor is polled once per frame for its clip
 * cursors (CharacterActor.clipCursors) and this driver works out which clip tracks were crossed since the last poll.
 * Pure: no Babylon, no WebAudio.
 */
import type { ClipTrack } from '@sro/shared'

/** Where one animation layer is, in clip time (speed-independent). */
export interface ClipCursor {
  /** Clip (sidecar animation) name, e.g. 'ATTACK1_sword_base_01'. */
  name: string
  /** From the clip start, 0..durationMs. */
  ms: number
  durationMs: number
  /** Bumped on every start of this layer's group: a restart is not a loop wrap. */
  run: number
  /** DIE1 of an entity that arrived dead (jumps to the end): fires nothing. */
  silent?: true
}

/** The full clip on top (action, else base, else DIE1 when dead) and the partial overlay (DAMAGE1). */
export interface ClipCursors {
  top: ClipCursor | null
  overlay: ClipCursor | null
}

interface LayerState {
  name: string
  run: number
  lastMs: number
  silent: boolean
}

/** Polls further apart than this many clip lengths fire nothing (the tab was hidden or the frame stalled). */
const JUMP_CLIPS = 1.5

export class ClipSoundDriver {
  private layers: [LayerState | null, LayerState | null] = [null, null]
  private lastAt: number | null = null

  /** `tracksOf(clip)`: the clip's sound tracks sorted by ms (undefined = none, or not loaded yet). */
  constructor(private readonly tracksOf: (clip: string) => readonly ClipTrack[] | undefined) {}

  /**
   * Advances to `cursors` at wall time `nowMs` and returns the tracks crossed since the previous call, in order.
   * `fire` false only syncs (an actor coming back into hearing range must not replay what it skipped).
   */
  update(cursors: ClipCursors | null | undefined, nowMs: number, fire = true): ClipTrack[] {
    const gap = this.lastAt === null ? 0 : nowMs - this.lastAt
    this.lastAt = nowMs
    const out: ClipTrack[] = []
    this.layers[0] = this.step(this.layers[0], cursors?.top ?? null, gap, fire, out)
    this.layers[1] = this.step(this.layers[1], cursors?.overlay ?? null, gap, fire, out)
    return out
  }

  /** Forgets every layer (the next update fires from the clip start, as for a new clip). */
  reset(): void {
    this.layers = [null, null]
    this.lastAt = null
  }

  private step(prev: LayerState | null, cur: ClipCursor | null, gap: number, fire: boolean, out: ClipTrack[]): LayerState | null {
    if (!cur) return null
    const ms = Math.max(0, cur.ms)
    const next: LayerState = { name: cur.name, run: cur.run, lastMs: ms, silent: !!cur.silent }
    const tracks = fire && !cur.silent ? this.tracksOf(cur.name) : undefined
    if (!tracks?.length) return next
    const dur = Math.max(1, cur.durationMs)
    if (!prev || prev.name !== cur.name || prev.run !== cur.run) {
      // A new clip or a restart: everything from its start up to now.
      if (gap <= JUMP_CLIPS * dur || !prev) pushRange(tracks, -1, ms, out)
      return next
    }
    if (gap > JUMP_CLIPS * dur) return next
    if (ms < prev.lastMs) {
      // A loop wrapped: the tail of the last pass, then the head of this one.
      pushRange(tracks, prev.lastMs, dur, out)
      pushRange(tracks, -1, ms, out)
    } else {
      pushRange(tracks, prev.lastMs, ms, out)
    }
    return next
  }
}

/** Tracks with from < t.ms <= to (from -1 includes a track at 0). */
function pushRange(tracks: readonly ClipTrack[], from: number, to: number, out: ClipTrack[]): void {
  for (const t of tracks) if (t.ms > from && t.ms <= to) out.push(t)
}
