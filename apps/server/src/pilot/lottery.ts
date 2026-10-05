import type { PilotIneligible, PilotSettings } from '@sro/shared'

/**
 * Play the Boss, the lottery and the schedule (docs/PLAY_THE_BOSS.md §2.4, §3.9, §6.2): pure functions, so tests are
 * exact.
 *
 * - Eligibility (checked at volunteer and again at the draw): level ≥ `minLevel`, `played_ms` ≥ `minPlayHours`, not
 *   blocked, the account did not steer her within `cooldownDays` nor in the last `recentEvents` turns (a refunded turn
 *   does not count), alive, not busy (in a trance, a trade or a stall).
 * - The draw: weight `firstTimerWeight` for an account that never steered her, else 1, from the module's seeded stream.
 * - The schedule: weekly slots (weekday 0 = Sunday, 'HH:MM') in an IANA zone ('' = the server's own). A wall time a
 *   DST change skips (the spring gap) counts as that time plus the gap; a repeated one (the autumn fold) is the first.
 */

export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000

/** What eligibility needs to know about a character (from the world and the database). */
export interface EligibilityFacts {
  level: number
  playedMs: number
  dead: boolean
  busy: boolean
  /** ms the account's block ends (null = not blocked). */
  blockedUntil: number | null
  /** When the account last steered her (a counted turn), or null. */
  lastTurnAt: number | null
  /** The account steered her in one of the last `recentEvents` turns. */
  recent: boolean
}

/** Why a character cannot volunteer now, or null (eligible). The first reason in the client's order. */
export function ineligible(f: EligibilityFacts, s: PilotSettings['eligibility'], now: number): PilotIneligible | null {
  if (f.level < s.minLevel) return 'level'
  if (f.playedMs < s.minPlayHours * HOUR_MS) return 'playtime'
  if (s.cooldownDays > 0 && f.lastTurnAt !== null && now - f.lastTurnAt < s.cooldownDays * DAY_MS) return 'cooldown'
  if (f.recent) return 'recent'
  if (f.blockedUntil !== null && f.blockedUntil > now) return 'blocked'
  if (f.dead) return 'dead'
  if (f.busy) return 'busy'
  return null
}

/** The draw weight of an account: `firstTimerWeight` when it never steered her, else 1. */
export function drawWeight(everPiloted: boolean, s: PilotSettings['eligibility']): number {
  return everPiloted ? 1 : Math.max(1, s.firstTimerWeight)
}

/** One entry of `list` picked with probability weight / total (null when empty or all weights are 0). */
export function drawWeighted<T>(list: readonly T[], weight: (x: T) => number, rng: () => number): T | null {
  let total = 0
  for (const x of list) total += Math.max(0, weight(x))
  if (!(total > 0)) return null
  let r = rng() * total
  let last: T | null = null
  for (const x of list) {
    const wt = Math.max(0, weight(x))
    if (wt > 0) last = x
    r -= wt
    if (r < 0) return x
  }
  return last
}

// ---- time zones ------------------------------------------------------------------------------------------------

/** The zone a schedule uses: its own, or the server process's ('' or unknown). */
export function zoneOf(tz: string): string {
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch {
      // fall through to the server's zone
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

const formats = new Map<string, Intl.DateTimeFormat>()

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(tz, f)
  }
  return f
}

/** The wall clock of instant `at` in zone `tz`. */
export function wallClock(tz: string, at: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {}
  for (const p of format(tz).formatToParts(new Date(at))) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute, s: parts.second }
}

/** The zone's offset from UTC at instant `at` (ms; Berlin in summer: +2 h). */
export function zoneOffset(tz: string, at: number): number {
  const w = wallClock(tz, at)
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
  return asUtc - Math.floor(at / 1000) * 1000
}

/** The instant the wall clock in `tz` reads y-mo-d h:mi (a gap: the time plus the gap; a fold: the first). */
export function wallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const local = Date.UTC(y, mo - 1, d, h, mi)
  const before = zoneOffset(tz, local - DAY_MS)
  const after = zoneOffset(tz, local + DAY_MS)
  const fits = [before, after].map((o) => local - o).filter((t) => zoneOffset(tz, t) === local - t)
  if (fits.length) return Math.min(...fits)
  return local - before
}

// ---- the weekly schedule -----------------------------------------------------------------------------------------

export type Slot = PilotSettings['schedule']['slots'][number]

/** The first slot instant strictly after `after` (null without slots). */
export function nextSlotAt(slots: readonly Slot[], tz: string, after: number): number | null {
  if (slots.length === 0) return null
  const zone = zoneOf(tz)
  const w = wallClock(zone, after)
  let best: number | null = null
  // Eight local days cover a week plus the day a DST fold can repeat.
  for (let k = 0; k <= 8; k++) {
    const day = new Date(Date.UTC(w.y, w.mo - 1, w.d + k))
    const weekday = day.getUTCDay()
    for (const s of slots) {
      if (s.weekday !== weekday) continue
      const [hh, mm] = s.time.split(':').map(Number)
      const t = wallToUtc(zone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm)
      if (t > after && (best === null || t < best)) best = t
    }
  }
  return best
}

/** Every slot instant in (from, to], oldest first. */
export function slotsBetween(slots: readonly Slot[], tz: string, from: number, to: number): number[] {
  const out: number[] = []
  let at = from
  for (let i = 0; i < 1000; i++) {
    const t = nextSlotAt(slots, tz, at)
    if (t === null || t > to) break
    out.push(t)
    at = t
  }
  return out
}
