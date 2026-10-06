/**
 * The admin panel's Updates page (docs/UPDATES.md): the self-hosted server follows the public GitHub repository. These
 * are the shapes of GET /api/admin/updates and its settings; the logic lives in apps/server/src/updater/.
 */

/** off: never looks; notify: checks and shows what is new; auto: also installs (inside the install window). */
export type UpdateMode = 'off' | 'notify' | 'auto'
export const UPDATE_MODES: readonly UpdateMode[] = ['off', 'notify', 'auto']

/** What kind of install this is: only a git clone of the configured repository can update itself. */
export type UpdateInstallKind = 'git' | 'zip' | 'deployed' | 'disabled'

export interface AdminUpdateSettings {
  mode: UpdateMode
  /** Minutes between checks (15..1440). */
  intervalMin: number
  /** Automatic installs only inside the window (the start, inclusive, to the end, exclusive; it may wrap midnight). */
  windowEnabled: boolean
  /** HH:MM */
  windowStart: string
  /** HH:MM */
  windowEnd: string
  /** IANA time zone of the window; '' = the server's own. */
  windowTz: string
  /** https URL of the repository `origin` must point at. */
  repoUrl: string
  branch: string
}

export type UpdatePhase =
  | 'backup'
  | 'countdown'
  | 'handoff'
  | 'merging'
  | 'installing'
  | 'building'
  | 'starting'
  | 'healthy'
  | 'rolling-back'

export type UpdateResult = 'updated' | 'rolled-back' | 'failed' | 'cancelled'

export interface AdminUpdateCommit {
  commit: string
  date: number
  author: string
  subject: string
}

export interface AdminUpdateChangelogEntry {
  id: string
  title: string
  date: string
  summary: string
}

export interface AdminUpdateRun {
  id: string
  kind: 'update' | 'rollback'
  from: string
  to: string
  by: string
  startedAt: number
  endedAt: number
  result: UpdateResult
  reason: string
  backup: string | null
  log: string[]
}

export interface AdminUpdateState {
  id: string
  kind: 'update' | 'rollback'
  phase: UpdatePhase
  from: string
  to: string
  by: string
  startedAt: number
  /** ms epoch the countdown ends (phase countdown). */
  countdownEndsAt: number | null
  log: string[]
}

export interface AdminUpdatesView {
  install: UpdateInstallKind
  /** Why the install is what it is (shown under the heading). */
  installNote: string
  /** The repository page on the web (for the ZIP install's link). */
  webUrl: string
  /** Running under the update supervisor (pnpm serve): installs and restarts are possible. */
  supervised: boolean
  current: { commit: string; date: number; subject: string } | null
  latest: { commit: string; date: number; subject: string } | null
  behind: number
  ahead: number
  /** "Update now" would start; otherwise `blockers` says why not. */
  canUpdate: boolean
  blockers: string[]
  warnings: string[]
  commits: AdminUpdateCommit[]
  changelog: AdminUpdateChangelogEntry[]
  settings: AdminUpdateSettings
  /** The server's own time zone (the window's default). */
  serverTz: string
  checking: boolean
  lastCheck: { at: number; ok: boolean; error: string | null } | null
  nextCheckAt: number | null
  /** A target the automatic mode skips (it failed, or an admin rolled it back); "Update now" still installs it. */
  skipped: string | null
  state: AdminUpdateState | null
  history: AdminUpdateRun[]
  /** The last update can be rolled back to the commit before it. */
  rollback: { to: string; at: number; restoresDatabase: boolean } | null
}
