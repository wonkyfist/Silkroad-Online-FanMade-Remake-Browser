/**
 * Server maintenance mode (docs/ADMIN.md §8): an admin starts a countdown (or "now") from the admin panel or the GM
 * command `maintenance`; every player hears it (centre screen + chat) at fixed steps and sees a small countdown banner;
 * at zero every non-staff connection is saved and closed back to the login screen, and until an admin ends it only
 * admins and GMs may log in or enter the world. The state survives a restart (DATA_DIR/maintenance.json).
 *
 * Self-contained: nothing here depends on any other game system, so it ports to any branch as is.
 */

/** Off, counting down to the kick, or on (only staff inside). */
export type MaintenanceState = 'off' | 'countdown' | 'on'

/** The countdown presets of the admin panel, in minutes (0 = now). Any whole minute up to the max is accepted too. */
export const MAINTENANCE_PRESETS_MIN = [0, 1, 5, 10, 15, 30] as const
/** Longest countdown, in minutes. */
export const MAINTENANCE_COUNTDOWN_MAX_MIN = 180
/** Longest expected duration ("back in ~N min"), in minutes. */
export const MAINTENANCE_DURATION_MAX_MIN = 24 * 60
/** Longest reason / message shown to players. */
export const MAINTENANCE_REASON_MAX = 160
/**
 * The announcement steps: seconds before the kick at which everyone hears it again (centre screen + chat). The start
 * itself is announced too; a step at or above the countdown's own length is skipped.
 */
export const MAINTENANCE_STEPS_S = [1800, 900, 600, 300, 180, 120, 60, 30, 10] as const

/**
 * The client's banner state (ServerMessage `maintenance`): sent to every connection when the state changes, and to a
 * connection right after its `welcome` while maintenance is counting down or on. `endsIn`: ms to the kick (countdown).
 * `back`: the expected duration in minutes, counted from the kick. `reason`: the admin's message.
 */
export interface MaintenanceSync {
  state: MaintenanceState
  endsIn?: number
  reason?: string
  back?: number
}

/** The admin panel's view (GET /api/admin/maintenance). Times are epoch ms of the server. */
export interface AdminMaintenanceView {
  state: MaintenanceState
  /** Server time when this answer was made (the panel's clock offset). */
  now: number
  /** Countdown: when it was started and when everyone is disconnected. */
  startedAt: number | null
  deadline: number | null
  /** On: since when. */
  since: number | null
  /** Who started it (the account name) and from where ('panel' | 'gm' | 'restart'). */
  by: string | null
  via: string | null
  reason: string
  /** Expected duration in minutes (0 = not given), and the expected end (epoch ms) once known. */
  durationMin: number
  backAt: number | null
  /** Connections that would be disconnected / that stay (staff), right now. */
  players: number
  staff: number
  presetsMin: readonly number[]
  limits: { countdownMaxMin: number; durationMaxMin: number; reasonMax: number }
}

/** "5 minutes", "1 minute", "30 seconds", "1 second": a countdown step in words. */
export function maintenanceIn(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s >= 60 && s % 60 === 0) {
    const m = s / 60
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  if (s > 90) {
    const m = Math.round(s / 60)
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  return `${s} second${s === 1 ? '' : 's'}`
}

/** "about 25 minutes" / "about 2 hours" / "any moment now": the time left until the expected end, in words. */
export function maintenanceBackIn(backAt: number | null, now: number): string | null {
  if (backAt === null) return null
  const min = Math.ceil((backAt - now) / 60_000)
  if (min <= 0) return 'any moment now'
  if (min < 90) return `in about ${min} minute${min === 1 ? '' : 's'}`
  const h = Math.round(min / 60)
  return `in about ${h} hour${h === 1 ? '' : 's'}`
}

/**
 * The refusal players get while maintenance is on (login, server pick, enter world; the close reason of the kick):
 * "The server is under maintenance. Expected back: in about 25 minutes." `withReason` adds the admin's message.
 */
export function maintenanceRefusal(backAt: number | null, now: number, reason = '', withReason = true): string {
  const back = maintenanceBackIn(backAt, now)
  const why = withReason && reason ? ` (${reason})` : ''
  return `The server is under maintenance${why}. ${back ? `Expected back: ${back}.` : 'Please try again later.'}`
}
