import type { AdminUpdateSettings, UpdateInstallKind } from '@sro/shared'

/**
 * The pure rules of self-updates (docs/UPDATES.md §3): when to check, when the automatic mode installs, the install
 * window and the countdown players hear. No I/O; updater.ts feeds them.
 */

export const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 'HH:MM' as minutes after midnight, or null. */
export function parseHhMm(s: string): number | null {
  const m = HHMM_RE.exec(s)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Minutes after midnight of `now` in time zone `tz` (an invalid zone: UTC). */
export function minutesOfDay(now: number, tz: string): number {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return (get('hour') % 24) * 60 + get('minute')
}

/**
 * Whether `now` is inside the install window: from the start (inclusive) to the end (exclusive) in the window's time
 * zone, wrapping midnight when the start is later than the end (22:00-06:00). Equal start and end: the whole day. No
 * window: always.
 */
export function inWindow(now: number, s: Pick<AdminUpdateSettings, 'windowEnabled' | 'windowStart' | 'windowEnd' | 'windowTz'>, serverTz: string): boolean {
  if (!s.windowEnabled) return true
  const a = parseHhMm(s.windowStart)
  const b = parseHhMm(s.windowEnd)
  if (a === null || b === null || a === b) return true
  const m = minutesOfDay(now, s.windowTz || serverTz)
  return a < b ? m >= a && m < b : m >= a || m < b
}

export interface DecideInput {
  settings: Pick<AdminUpdateSettings, 'mode' | 'intervalMin' | 'windowEnabled' | 'windowStart' | 'windowEnd' | 'windowTz'>
  serverTz: string
  now: number
  install: UpdateInstallKind
  /** An update is in progress, or a check is running. */
  busy: boolean
  lastCheckAt: number | null
  /** Commits on the remote that HEAD lacks, from the last check. */
  behind: number
  /** The clone is clean, on the branch, a fast-forward away, the disk has room (from the last check). */
  canUpdate: boolean
  supervised: boolean
  latest: string | null
  skipped: string | null
  /** The server started this long ago (no automatic install in the first minutes after a start). */
  uptimeMs: number
}

/** First check this long after a start (the server settles first). */
export const FIRST_CHECK_DELAY_MS = 60_000
/** No automatic install sooner than this after a start (a boot loop never becomes an update loop). */
export const MIN_UPTIME_FOR_INSTALL_MS = 5 * 60_000

/** What the updater's timer does now. */
export function decide(i: DecideInput): 'none' | 'check' | 'install' {
  if (i.settings.mode === 'off' || i.busy) return 'none'
  if (i.install !== 'git' && i.install !== 'zip') return 'none'
  const due = i.lastCheckAt === null ? i.uptimeMs >= FIRST_CHECK_DELAY_MS : i.now - i.lastCheckAt >= i.settings.intervalMin * 60_000
  if (due) return 'check'
  if (
    i.settings.mode === 'auto' && i.install === 'git' && i.supervised && i.canUpdate && i.behind > 0 && i.latest !== null && i.latest !== i.skipped &&
    i.uptimeMs >= MIN_UPTIME_FOR_INSTALL_MS && inWindow(i.now, i.settings, i.serverTz)
  ) return 'install'
  return 'none'
}

/** When the next check is due (null: the mode never checks). */
export function nextCheckAt(i: Pick<DecideInput, 'settings' | 'install' | 'lastCheckAt'>, startedAt: number): number | null {
  if (i.settings.mode === 'off' || (i.install !== 'git' && i.install !== 'zip')) return null
  return i.lastCheckAt === null ? startedAt + FIRST_CHECK_DELAY_MS : i.lastCheckAt + i.settings.intervalMin * 60_000
}

/** The countdown players get: 5 minutes, then reminders at 1 minute and 10 seconds. */
export const COUNTDOWN_MS = 5 * 60_000
const REMINDERS_MS = [5 * 60_000, 60_000, 10_000]

/** "5 minutes", "1 minute", "10 seconds". */
export function spokenDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s >= 60 && s % 60 === 0) return s === 60 ? '1 minute' : `${s / 60} minutes`
  if (s > 60) return `${Math.ceil(s / 60)} minutes`
  return s === 1 ? '1 second' : `${s} seconds`
}

export function countdownText(msLeft: number): string {
  return `Server update in ${spokenDuration(msLeft)}: the server restarts to install the latest version. Your progress is saved; log in again in a few minutes.`
}

/**
 * The notices of a countdown of `totalMs` with `online` players: each at `atMs` after the start. Nobody online: no
 * countdown at all (the update starts at once). A shorter countdown starts with its own length.
 */
export function countdownPlan(online: number, totalMs = COUNTDOWN_MS): { endMs: number; notices: { atMs: number; text: string }[] } {
  if (online <= 0 || totalMs <= 0) return { endMs: 0, notices: [] }
  const notices = [{ atMs: 0, text: countdownText(totalMs) }]
  for (const left of REMINDERS_MS) if (left < totalMs) notices.push({ atMs: totalMs - left, text: countdownText(left) })
  return { endMs: totalMs, notices }
}
