/**
 * The one client cooldown clock (docs/WAVE_PLAN.md decision 8). Keys are `skill:<group>` (skills.json `group`, from
 * `skills.cooldowns` / the skill engine) and `item:<cooldownGroup>` (from `itemCooldown`). The hotbar, the bag slots
 * and the skill window all read it. Times are local milliseconds on `performance.now()` (see `cooldownNow`); convert
 * the server's `readyInMs` with `setIn`. Presentation only: the server refuses early uses on its own.
 */

export interface CooldownEntry {
  readyAt: number
  totalMs: number
}

export type CooldownListener = (key: string, entry: CooldownEntry | null) => void

/** `skill:<group>`. */
export const skillCooldownKey = (group: string): string => `skill:${group}`
/** `item:<cooldownGroup>`. */
export const itemCooldownKey = (group: string): string => `item:${group}`

/** The clock every CooldownClock time is on. */
export function cooldownNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export class CooldownClock {
  private readonly entries = new Map<string, CooldownEntry>()
  private readonly listeners = new Set<CooldownListener>()

  constructor(private readonly now: () => number = cooldownNow) {}

  /** Starts (or replaces) a cooldown ending at `readyAtMs` that lasts `totalMs` in all. */
  set(key: string, readyAtMs: number, totalMs: number): void {
    if (!Number.isFinite(readyAtMs) || !Number.isFinite(totalMs)) return
    const entry = { readyAt: readyAtMs, totalMs: Math.max(0, totalMs) }
    this.entries.set(key, entry)
    this.emit(key, entry)
  }

  /** `set` from a relative "ready in" time (the wire's `readyInMs`). */
  setIn(key: string, readyInMs: number, totalMs = readyInMs): void {
    this.set(key, this.now() + Math.max(0, readyInMs), totalMs)
  }

  get(key: string): CooldownEntry | null {
    const e = this.entries.get(key)
    return e ? { ...e } : null
  }

  /** Milliseconds left at `now` (0 when ready or unknown). */
  remaining(key: string, now: number = this.now()): number {
    const e = this.entries.get(key)
    return e ? Math.max(0, e.readyAt - now) : 0
  }

  /** Clears one key, or every key. */
  clear(key?: string): void {
    const keys = key === undefined ? [...this.entries.keys()] : this.entries.has(key) ? [key] : []
    for (const k of keys) {
      this.entries.delete(k)
      this.emit(k, null)
    }
  }

  /** Called on every set/clear with the key and its new entry (null when cleared). Returns an unsubscribe. */
  onChange(fn: CooldownListener): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit(key: string, entry: CooldownEntry | null): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(key, entry ? { ...entry } : null)
      } catch (err) {
        console.error('[cooldowns] listener failed', err)
      }
    }
  }
}
