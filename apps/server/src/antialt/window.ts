/**
 * docs/ANTI_ALT.md §2: a limit is "at most `count` in a window of `amount` `unit`s" (a sliding window). These helpers turn
 * the panel's window into milliseconds, say when the oldest counted event leaves it, and write a wait for players.
 */

export const WINDOW_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const
export type WindowUnit = (typeof WINDOW_UNITS)[number]

const UNIT_MS: Record<WindowUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 }

export interface Window {
  amount: number
  unit: WindowUnit
}

export function windowMs(w: Window): number {
  return Math.max(0, w.amount) * UNIT_MS[w.unit]
}

/** "1 hour", "2 days", "1 week". */
export function windowText(w: Window): string {
  const one = w.unit.slice(0, -1)
  return `${w.amount} ${w.amount === 1 ? one : w.unit}`
}

/**
 * The outcome of a count against a limit. `times` are the counted events' times (any order); the window ends at `now`.
 * Allowed while fewer than `count` fall inside; else `retryMs` is how long until the oldest that keeps it full leaves.
 */
export function checkWindow(times: readonly number[], count: number, ms: number, now: number): { ok: true } | { ok: false; retryMs: number } {
  const inside = times.filter((t) => t > now - ms).sort((a, b) => a - b)
  if (inside.length < count) return { ok: true }
  // count may be 0 (nothing allowed): wait the whole window
  if (count <= 0) return { ok: false, retryMs: ms }
  const freeing = inside[inside.length - count]
  return { ok: false, retryMs: Math.max(1000, freeing + ms - now) }
}

/**
 * A wait for players: minutes (rounded up) below 2 hours, hours below 2 days, days below 2 weeks, else weeks (rounded):
 * "5 minutes", "3 hours", "2 days", "2 weeks".
 */
export function waitText(ms: number): string {
  const say = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`
  if (ms < 2 * UNIT_MS.hours) return say(Math.max(1, Math.ceil(ms / UNIT_MS.minutes)), 'minute')
  if (ms < 2 * UNIT_MS.days) return say(Math.round(ms / UNIT_MS.hours), 'hour')
  if (ms < 2 * UNIT_MS.weeks) return say(Math.round(ms / UNIT_MS.days), 'day')
  return say(Math.round(ms / UNIT_MS.weeks), 'week')
}
