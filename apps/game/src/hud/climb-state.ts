/**
 * The Climb's rewards on the client (docs/CLIMB.md §5.1, §7.3, §11): the last `climb` message (titles held and worn,
 * the Arts picked, the counters), for the character window's title line and the skill window's Arts row. One store per
 * page; world/features/climb.ts fills it and resets it when the world view goes.
 */
import type { ServerMessage } from '@sro/shared'

export type ClimbMessage = Extract<ServerMessage, { t: 'climb' }>

export interface ClimbView {
  titles: readonly string[]
  title: string | null
  arts: Readonly<Record<string, string>>
  progress: Readonly<Record<string, number>>
}

const EMPTY: ClimbView = { titles: [], title: null, arts: {}, progress: {} }

class ClimbState {
  private view: ClimbView = EMPTY
  /** A `climb` message arrived (the server runs the Climb). */
  known = false
  private readonly listeners = new Set<(v: ClimbView) => void>()

  get(): ClimbView {
    return this.view
  }

  set(msg: ClimbMessage): void {
    this.known = true
    this.view = { titles: [...msg.titles], title: msg.title, arts: { ...msg.arts }, progress: { ...msg.progress } }
    for (const fn of this.listeners) fn(this.view)
  }

  reset(): void {
    this.known = false
    this.view = EMPTY
    for (const fn of this.listeners) fn(this.view)
  }

  /** The title shown: the worn one, else the newest held, else null. */
  shown(): string | null {
    return this.view.title ?? this.view.titles[0] ?? null
  }

  subscribe(fn: (v: ClimbView) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export const climbState = new ClimbState()
