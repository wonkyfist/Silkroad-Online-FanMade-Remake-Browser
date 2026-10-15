import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOSE_CODE,
  MAINTENANCE_COUNTDOWN_MAX_MIN,
  MAINTENANCE_DURATION_MAX_MIN,
  MAINTENANCE_PRESETS_MIN,
  MAINTENANCE_REASON_MAX,
  MAINTENANCE_STEPS_S,
  codePointLength,
  isStaff,
  maintenanceBackIn,
  maintenanceIn,
  maintenanceRefusal,
  type AdminMaintenanceView,
  type MaintenanceState,
  type MaintenanceSync,
  type Role,
  type ServerMessage,
} from '@sro/shared'

/**
 * Server maintenance mode (docs/ADMIN.md §8). One per server (GameContext.maintenance): the admin panel's Maintenance
 * card (admin/maintenance-admin.ts) and the GM command `maintenance` (gm-tools.ts) call start / cancel / end; the
 * connection asks `refusal` at hello and enterWorld, game.ts at /api/login and /api/register, and serverInfo shows
 * 'maintenance' while it is on.
 *
 * - start: a countdown (0 = now). Everyone hears it at once and at MAINTENANCE_STEPS_S (centre screen + system chat),
 *   and every socket gets the banner state (`maintenance`).
 * - at zero: every connection whose account is not staff (the role re-read from the database now) gets a chat line
 *   and is closed with CLOSE_CODE.maintenance: the ordinary disconnect path (Connection.dispose -> leaveWorld: the
 *   character is settled and saved, trades / stalls and the rest end through the modules' `forget`), never held for a
 *   reconnect; bodies already held for a reconnect (resume.ts) are released (saved and removed) too. Staff stay.
 * - while on: non-staff are refused at login, at hello (the server pick) and at enterWorld; a GM demoted meanwhile is
 *   disconnected as soon as the role change is seen (Connection.applyRole -> roleChanged).
 * - end: back online; whoever is connected hears "Maintenance is over" (unless silent).
 *
 * The state is written to DATA_DIR/maintenance.json on every change (atomically: a temp file renamed over it), so a
 * restart or deploy during maintenance keeps it on; a countdown whose deadline passed while the server was down comes
 * back on.
 */

/** What this module needs of a connection (connection.ts Connection). */
export interface MaintConn {
  accountId: number
  account: string
  role: Role
  player: { name: string } | null
  send(msg: ServerMessage): void
  close(code: number, reason: string): void
}

/** What this module needs of the game (game.ts GameContext). */
export interface MaintHost {
  sockets: Map<number, MaintConn>
  /** The account's role as stored right now. */
  accountRole(accountId: number): Role
  /** Saves and removes the bodies held for a reconnect (resume.ts) whose character is not staff. Returns how many. */
  releaseHeld(): number
  log(line: string): void
}

/** The persisted state (DATA_DIR/maintenance.json). */
export interface MaintRecord {
  state: Exclude<MaintenanceState, 'off'>
  startedAt: number
  deadline: number
  since: number | null
  by: string
  via: string
  reason: string
  durationMin: number
}

export type MaintResult = { ok: true; message: string } | { ok: false; status: number; message: string }

export const MAINTENANCE_FILE = 'maintenance.json'

/** WebSocket close reasons are limited to 123 bytes: the text cut at a character boundary under `max` bytes. */
export function clipUtf8(text: string, max = 120): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return text
  return buf.subarray(0, max).toString('utf8').replace(/�+$/, '')
}

/** A reason typed by an admin: control characters out, trimmed, at most MAINTENANCE_REASON_MAX characters (null = too long). */
export function cleanReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') return null
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()
  return codePointLength(text) > MAINTENANCE_REASON_MAX ? null : text
}

function isRecord(v: unknown): v is MaintRecord {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
  return (o.state === 'countdown' || o.state === 'on') && n(o.startedAt) && n(o.deadline) && (o.since === null || n(o.since)) &&
    typeof o.by === 'string' && typeof o.via === 'string' && typeof o.reason === 'string' && n(o.durationMin)
}

export class Maintenance {
  private rec: MaintRecord | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The steps (seconds before the kick) still to announce in this countdown. */
  private steps: number[] = []
  private readonly file: string

  constructor(
    private readonly host: MaintHost,
    dataDir: string | null,
    private readonly clock: () => number = Date.now,
  ) {
    this.file = dataDir ? join(dataDir, MAINTENANCE_FILE) : ''
  }

  get state(): MaintenanceState {
    return this.rec?.state ?? 'off'
  }

  /** Maintenance is on: only staff inside. */
  get on(): boolean {
    return this.rec?.state === 'on'
  }

  get record(): Readonly<MaintRecord> | null {
    return this.rec
  }

  /** The expected end (epoch ms), once the duration is known. */
  backAt(): number | null {
    const r = this.rec
    if (!r || r.durationMin <= 0) return null
    return (r.since ?? r.deadline) + r.durationMin * 60_000
  }

  /** Restores the saved state (server start). A countdown that ran out meanwhile comes back on. */
  load(): void {
    if (!this.file || !existsSync(this.file)) return
    let saved: unknown
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (e) {
      this.host.log(`maintenance: ${MAINTENANCE_FILE} unreadable (${(e as Error).message}); keeping it off`)
      return
    }
    if (!isRecord(saved)) {
      this.host.log(`maintenance: ${MAINTENANCE_FILE} malformed; keeping it off`)
      return
    }
    const now = this.clock()
    this.rec = { ...saved, reason: cleanReason(saved.reason) ?? '' }
    if (saved.state === 'countdown' && saved.deadline > now) {
      this.host.log(`maintenance: countdown restored (${maintenanceIn(saved.deadline - now)} left, by ${saved.by})`)
      this.steps = MAINTENANCE_STEPS_S.filter((s) => s * 1000 < saved.deadline - now)
      this.schedule()
      return
    }
    if (saved.state === 'countdown') {
      this.rec.state = 'on'
      this.rec.since = now
      this.save()
    }
    this.host.log(`maintenance: ON (since ${new Date(this.rec.since ?? now).toISOString()}, by ${this.rec.by}); only staff may log in`)
  }

  /**
   * Starts maintenance: a countdown of `delayS` seconds (0 = now). Refused while one is counting down or on (another
   * admin started it: cancel or end it first).
   */
  start(o: { delayS: number; reason?: string; durationMin?: number; by: string; via: string }): MaintResult {
    const now = this.clock()
    if (this.rec) {
      const r = this.rec
      return r.state === 'on'
        ? { ok: false, status: 409, message: `Maintenance is already on (since ${new Date(r.since ?? now).toISOString()}, by ${r.by}). End it first.` }
        : { ok: false, status: 409, message: `A maintenance countdown is already running (${maintenanceIn(r.deadline - now)} left, by ${r.by}). Cancel it first.` }
    }
    if (!Number.isInteger(o.delayS) || o.delayS < 0 || o.delayS > MAINTENANCE_COUNTDOWN_MAX_MIN * 60) {
      return { ok: false, status: 400, message: `The countdown is 0 to ${MAINTENANCE_COUNTDOWN_MAX_MIN} minutes.` }
    }
    const durationMin = o.durationMin ?? 0
    if (!Number.isInteger(durationMin) || durationMin < 0 || durationMin > MAINTENANCE_DURATION_MAX_MIN) {
      return { ok: false, status: 400, message: `The expected duration is 0 to ${MAINTENANCE_DURATION_MAX_MIN} minutes.` }
    }
    const reason = cleanReason(o.reason)
    if (reason === null) return { ok: false, status: 400, message: `The message is at most ${MAINTENANCE_REASON_MAX} characters.` }
    this.rec = { state: 'countdown', startedAt: now, deadline: now + o.delayS * 1000, since: null, by: o.by, via: o.via, reason, durationMin }
    this.host.log(`maintenance: ${o.by} (${o.via}) started a ${maintenanceIn(o.delayS * 1000)} countdown${reason ? `: ${reason}` : ''}${durationMin ? `; expected ${durationMin} min` : ''}`)
    if (o.delayS === 0) {
      this.goOn()
      return { ok: true, message: `Maintenance is on now. ${this.lastKick} player connection(s) were disconnected.` }
    }
    this.steps = MAINTENANCE_STEPS_S.filter((s) => s < o.delayS)
    this.save()
    this.announce(`Server maintenance in ${maintenanceIn(o.delayS * 1000)}${this.tail()}`)
    this.syncAll()
    this.schedule()
    return { ok: true, message: `Maintenance starts in ${maintenanceIn(o.delayS * 1000)}; everyone was told.` }
  }

  /** Cancels a countdown (before zero). */
  cancel(by: string, via: string): MaintResult {
    const r = this.rec
    if (!r) return { ok: false, status: 409, message: 'No maintenance is scheduled.' }
    if (r.state === 'on') return { ok: false, status: 409, message: 'Maintenance is already on; end it instead.' }
    this.clear()
    this.rec = null
    this.save()
    this.host.log(`maintenance: countdown cancelled by ${by} (${via})`)
    this.announce('The scheduled server maintenance was cancelled. Carry on!')
    this.syncAll()
    return { ok: true, message: 'The maintenance countdown was cancelled; everyone was told.' }
  }

  /** Ends maintenance: the server is online again. `silent`: no "Maintenance is over" message. */
  end(by: string, via: string, silent = false): MaintResult {
    const r = this.rec
    if (!r) return { ok: false, status: 409, message: 'Maintenance is not on.' }
    if (r.state === 'countdown') return { ok: false, status: 409, message: 'Maintenance has not started yet; cancel the countdown instead.' }
    this.clear()
    this.rec = null
    this.save()
    this.host.log(`maintenance: ended by ${by} (${via}); players may log in again`)
    if (!silent) this.announce('Server maintenance is over. Welcome back!')
    this.syncAll()
    return { ok: true, message: 'Maintenance is over; the server is online again.' }
  }

  /**
   * The refusal text for an account of `role` (null = let it in): while maintenance is on, everyone but staff.
   * `withReason`: the admin's message in brackets (not in the close reason, which is short).
   */
  refusal(role: Role, withReason = true): string | null {
    if (!this.on || isStaff(role)) return null
    return maintenanceRefusal(this.backAt(), this.clock(), this.rec?.reason ?? '', withReason)
  }

  /** After a `welcome`: the banner state while maintenance counts down or is on. */
  greet(c: MaintConn): void {
    if (this.rec) c.send(this.sync())
  }

  /** A connection's role changed (Connection.applyRole): a demoted GM leaves while maintenance is on. */
  roleChanged(c: MaintConn): void {
    if (this.on && !isStaff(c.role)) this.kick(c)
  }

  /** The admin panel's view. */
  view(): AdminMaintenanceView {
    const now = this.clock()
    const r = this.rec
    let players = 0
    let staff = 0
    for (const c of this.host.sockets.values()) {
      if (isStaff(c.role)) staff++
      else players++
    }
    return {
      state: this.state,
      now,
      startedAt: r?.startedAt ?? null,
      deadline: r?.state === 'countdown' ? r.deadline : null,
      since: r?.since ?? null,
      by: r?.by ?? null,
      via: r?.via ?? null,
      reason: r?.reason ?? '',
      durationMin: r?.durationMin ?? 0,
      backAt: this.backAt(),
      players,
      staff,
      presetsMin: MAINTENANCE_PRESETS_MIN,
      limits: { countdownMaxMin: MAINTENANCE_COUNTDOWN_MAX_MIN, durationMaxMin: MAINTENANCE_DURATION_MAX_MIN, reasonMax: MAINTENANCE_REASON_MAX },
    }
  }

  /** Server shutdown: the timers stop (the saved state stays). */
  dispose(): void {
    this.clear()
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  /** Connections disconnected by the last goOn (for the start-now answer). */
  private lastKick = 0

  private tail(): string {
    const r = this.rec!
    const back = r.durationMin > 0 ? ` Expected downtime: about ${r.durationMin < 90 ? `${r.durationMin} minute${r.durationMin === 1 ? '' : 's'}` : `${Math.round(r.durationMin / 60)} hours`}.` : ''
    return `${r.reason ? `: ${r.reason}` : ''}.${back} Please find a safe place and log out; you will be disconnected when it starts.`
  }

  /** The next wake-up: the next announcement step or the deadline. */
  private schedule(): void {
    this.clear()
    const r = this.rec
    if (!r || r.state !== 'countdown') return
    const now = this.clock()
    const next = this.steps.length ? Math.max(r.deadline - this.steps[0]! * 1000, now) : r.deadline
    this.timer = setTimeout(() => this.wake(), Math.max(0, next - now))
    this.timer.unref?.()
  }

  private wake(): void {
    this.timer = null
    const r = this.rec
    if (!r || r.state !== 'countdown') return
    const now = this.clock()
    if (now >= r.deadline) {
      this.goOn()
      return
    }
    // every step that is due (a late timer announces once, the nearest)
    let due: number | null = null
    while (this.steps.length && r.deadline - this.steps[0]! * 1000 <= now) due = this.steps.shift()!
    if (due !== null) {
      this.announce(`Server maintenance in ${maintenanceIn(due * 1000)}${this.tail()}`)
      this.syncAll()
    }
    this.schedule()
  }

  /** Zero: maintenance is on; every non-staff connection is disconnected (saved like a logout). */
  private goOn(): void {
    const r = this.rec!
    const now = this.clock()
    this.clear()
    r.state = 'on'
    r.since = now
    this.save()
    let kicked = 0
    for (const c of [...this.host.sockets.values()]) {
      // the role as stored now: a GM demoted a moment ago is not let off
      const role = this.host.accountRole(c.accountId)
      if (isStaff(role)) continue
      c.role = role
      this.kick(c)
      kicked++
    }
    const held = this.host.releaseHeld()
    this.lastKick = kicked
    this.host.log(`maintenance: ON; ${kicked} connection(s) disconnected${held ? `, ${held} held character(s) saved and removed` : ''}; only staff may log in`)
    for (const c of this.host.sockets.values()) {
      c.send({ t: 'notice', text: `Maintenance mode is ON. ${kicked} player connection(s) were disconnected; only staff may log in.`, from: 'Server' })
      if (c.player) c.send({ t: 'chat', channel: 'system', text: `[Maintenance] Maintenance mode is on (${kicked} player connection(s) disconnected).` })
    }
    this.syncAll()
  }

  private kick(c: MaintConn): void {
    const now = this.clock()
    c.send({ t: 'chat', channel: 'system', text: `[Maintenance] ${maintenanceRefusal(this.backAt(), now, this.rec?.reason ?? '')}` })
    // the close reason is what the login screen shows (short: no admin message, which the chat line carried)
    c.close(CLOSE_CODE.maintenance, clipUtf8(maintenanceRefusal(this.backAt(), now, '', false)))
  }

  private sync(): ServerMessage {
    const r = this.rec
    if (!r) return { t: 'maintenance', state: 'off' }
    const m: MaintenanceSync = { state: r.state }
    if (r.state === 'countdown') m.endsIn = Math.max(0, r.deadline - this.clock())
    if (r.reason) m.reason = r.reason
    if (r.durationMin > 0) m.back = r.durationMin
    return { t: 'maintenance', ...m }
  }

  private syncAll(): void {
    const m = this.sync()
    for (const c of this.host.sockets.values()) c.send(m)
  }

  /** Centre screen to every socket (lobby included), plus a system chat line in the world. */
  private announce(text: string): void {
    for (const c of this.host.sockets.values()) {
      c.send({ t: 'notice', text, from: 'Server' })
      if (c.player) c.send({ t: 'chat', channel: 'system', text: `[Maintenance] ${text}` })
    }
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private save(): void {
    if (!this.file) return
    try {
      if (!this.rec) {
        rmSync(this.file, { force: true })
        return
      }
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.rec, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      // the state still holds in memory; only a restart would lose it
      this.host.log(`maintenance: could not save ${MAINTENANCE_FILE}: ${(e as Error).message}`)
    }
  }
}

/** "in about 25 minutes" for the GM command's status line. */
export function backText(m: Maintenance, now = Date.now()): string {
  return maintenanceBackIn(m.backAt(), now) ?? 'no expected end given'
}
