import { createHmac, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DEVICE_ID_RE, FINGERPRINT_RE } from '@sro/shared'
import type { Store } from '../db.ts'
import type { Lists } from './lists.ts'
import { inRange, isLoopback, normalizeIp, parseCidr, subnetOf } from './net.ts'
import { ACTION_RANK, MODE_RANK, checkPolicy, defaultPolicy, type AntiAltPolicy, type DetectMode, type GuardAction, type Limit } from './policy.ts'
import type { Captcha, CachedLookup } from './providers.ts'
import { checkWindow, waitText, windowMs, windowText } from './window.ts'

/**
 * docs/ANTI_ALT.md: account and character registration limits, VPN / proxy / hosting detection, the allowlist and the
 * linked-accounts view. Tables: admin/store.ts migration 2 (antialt_*). Device IDs and fingerprints are kept only as
 * HMAC-SHA256 hashes under a random per-server salt (antialt_meta.salt), so the stored values match nothing elsewhere.
 */

type Db = Store['db']

/** What a client request brings: its address (already resolved through the trusted proxies) and the raw signals. */
export interface Attempt {
  ip: string
  device?: string
  fp?: string
  /** The account name tried or used (for the log). */
  account?: string
  captcha?: string
}

export interface Ids {
  ip: string
  subnet: string
  device: string
  fp: string
}

export interface Refusal {
  status: 403 | 429
  code: 'rate_limited' | 'forbidden'
  message: string
  reason: string
}

export interface LogRow {
  id: number
  at: number
  action: string
  outcome: 'blocked' | 'flagged'
  reason: string
  detail: string
  ip: string
  subnet: string
  device: string
  account: string
  lifted: 0 | 1
}

export interface AllowRow {
  id: number
  kind: 'ip' | 'subnet' | 'device'
  value: string
  note: string
  added_at: number
  added_by: string
}

export interface LinkedRow {
  account_id: number
  username: string
  device: 0 | 1
  ip: 0 | 1
  subnet: 0 | 1
  fp: 0 | 1
  last: number
}

type LogAction = 'register' | 'login' | 'character'
type EventKind = 'register' | 'login' | 'char'

const HASH_LEN = 32

export interface AntiAltOptions {
  lists: Lists
  log: (m: string) => void
  lookup?: CachedLookup | null
  captcha?: Captcha | null
  /** The old "Registrations per IP per hour" (REGISTER_LIMIT), the default of the per-IP limit. */
  registerPerHour: number
}

export class AntiAlt {
  private readonly salt: string
  private pol: AntiAltPolicy
  private allow: AllowRow[] = []
  private readonly stmts = new Map<string, Database.Statement<unknown[]>>()

  constructor(
    private readonly db: Db,
    readonly opts: AntiAltOptions,
  ) {
    const row = db.prepare('SELECT salt, policy FROM antialt_meta WHERE id = 1').get() as { salt: string; policy: string | null } | undefined
    if (!row) {
      // First start with this table: carry the old panel setting "Registrations per IP per hour" into the per-IP limit
      // (1 hour window) and drop the old row, so the settings page does not list it as unknown.
      const old = db.prepare("SELECT value FROM admin_settings WHERE key = 'registerPerHour'").get() as { value: string } | undefined
      const oldValue = old ? Number(JSON.parse(old.value)) : NaN
      const seed = Number.isInteger(oldValue) && oldValue >= 1 ? oldValue : opts.registerPerHour
      this.salt = randomBytes(32).toString('hex')
      this.pol = defaultPolicy(seed)
      db.transaction(() => {
        db.prepare('INSERT INTO antialt_meta (id, salt, policy) VALUES (1, ?, ?)').run(this.salt, JSON.stringify(this.pol))
        db.prepare("DELETE FROM admin_settings WHERE key = 'registerPerHour'").run()
      })()
      if (old) opts.log(`anti-alt: moved the saved "Registrations per IP per hour" (${seed}) into the per-IP limit`)
    } else {
      this.salt = row.salt
      const r = row.policy ? checkPolicy(safeJson(row.policy)) : null
      if (r && 'problem' in r) opts.log(`anti-alt: the saved policy is invalid (${r.problem}); using the defaults`)
      this.pol = r && 'policy' in r ? r.policy : defaultPolicy(opts.registerPerHour)
    }
    this.reloadAllow()
  }

  // ---- policy ----------------------------------------------------------------------------------

  policy(): AntiAltPolicy {
    return structuredClone(this.pol)
  }

  setPolicy(v: unknown): { problem: string } | { before: AntiAltPolicy; after: AntiAltPolicy } {
    const r = checkPolicy(v)
    if ('problem' in r) return r
    const before = this.pol
    this.pol = r.policy
    this.db.prepare('UPDATE antialt_meta SET policy = ? WHERE id = 1').run(JSON.stringify(this.pol))
    return { before, after: this.policy() }
  }

  /** The Turnstile site key for the client when the robot check is on and configured; else null. */
  captchaSiteKey(): string | null {
    return this.pol.captcha && this.opts.captcha ? this.opts.captcha.siteKey : null
  }

  // ---- identities --------------------------------------------------------------------------------

  hash(kind: 'd' | 'f', raw: string): string {
    return createHmac('sha256', this.salt).update(`${kind}:${raw}`).digest('hex').slice(0, HASH_LEN)
  }

  ids(a: Attempt): Ids {
    const ip = normalizeIp(a.ip) || a.ip
    return {
      ip,
      subnet: subnetOf(ip),
      device: a.device && DEVICE_ID_RE.test(a.device) ? this.hash('d', a.device) : '',
      fp: a.fp && FINGERPRINT_RE.test(a.fp) ? this.hash('f', a.fp) : '',
    }
  }

  private exempt(id: Ids): boolean {
    return this.pol.exemptLoopback && isLoopback(id.ip)
  }

  allowlisted(id: Ids): AllowRow | null {
    for (const e of this.allow) {
      if (e.kind === 'ip' && e.value === id.ip) return e
      if (e.kind === 'device' && id.device && e.value === id.device) return e
      if (e.kind === 'subnet') {
        const r = parseCidr(e.value)
        if (r && inRange(id.ip, r)) return e
      }
    }
    return null
  }

  // ---- detection -------------------------------------------------------------------------------

  private detections(ip: string, cachedOnly: boolean): Promise<{ check: keyof AntiAltPolicy['detect']; label: string }[]> | { check: keyof AntiAltPolicy['detect']; label: string }[] {
    const out: { check: keyof AntiAltPolicy['detect']; label: string }[] = []
    const d = this.pol.detect
    if (d.hosting !== 'off') {
      const m = this.opts.lists.hosting.match(ip)
      if (m) out.push({ check: 'hosting', label: m })
    }
    if (d.tor !== 'off' && this.opts.lists.tor.match(ip)) out.push({ check: 'tor', label: 'Tor exit' })
    const lookup = this.opts.lookup
    if (d.external === 'off' || !lookup) return out
    const add = (r: { proxy: boolean; kind: string } | null) => {
      if (r?.proxy) out.push({ check: 'external', label: `${lookup.provider.name}: ${r.kind}` })
      return out
    }
    return cachedOnly ? add(lookup.cached(ip)) : lookup.lookup(ip).then(add)
  }

  /** Applies the detections to an action: the first that blocks is the refusal; the rest are flagged in the log. */
  private judge(action: GuardAction, found: { check: keyof AntiAltPolicy['detect']; label: string }[], id: Ids, account: string): Refusal | null {
    for (const f of found) {
      const mode: DetectMode = this.pol.detect[f.check]
      if (MODE_RANK[mode] >= ACTION_RANK[action]) {
        const refusal: Refusal = { status: 403, code: 'forbidden', reason: `detect.${f.check}`, message: detectMessage(f.check, action) }
        this.writeLog(logAction(action), 'blocked', refusal.reason, f.label, id, account)
        return refusal
      }
    }
    for (const f of found) if (MODE_RANK[this.pol.detect[f.check]] >= MODE_RANK.flag) this.writeLog(logAction(action), 'flagged', `detect.${f.check}`, f.label, id, account)
    return null
  }

  // ---- counting --------------------------------------------------------------------------------

  private stmt(sql: string) {
    let s = this.stmts.get(sql)
    if (!s) this.stmts.set(sql, (s = this.db.prepare<unknown[]>(sql)))
    return s
  }

  /**
   * The times of the counted events of `kind` matching `scope` since `since`. 'device' matches the device hash, and
   * (fingerprintWithSubnet) the fingerprint hash from the same subnet: the soft signal never counts on its own.
   */
  private times(kind: EventKind, scope: 'ip' | 'subnet' | 'device' | 'account', id: Ids & { account?: number }, since: number, skipDeleted = false): number[] | null {
    const where: string[] = ['kind = @kind', 'waived = 0', 'at > @since']
    if (scope === 'ip') where.push('ip = @ip')
    else if (scope === 'subnet') {
      if (!id.subnet) return null
      where.push('subnet = @subnet')
    } else if (scope === 'account') where.push('account_id = @account')
    else {
      const any: string[] = []
      if (id.device) any.push('device = @device')
      if (this.pol.fingerprintWithSubnet && id.fp && id.subnet) any.push('(fp = @fp AND subnet = @subnet)')
      if (!any.length) return null
      where.push(`(${any.join(' OR ')})`)
    }
    if (skipDeleted) where.push('(character_id IS NULL OR NOT EXISTS (SELECT 1 FROM characters c WHERE c.id = character_id AND c.deleted_at IS NOT NULL))')
    const rows = this.stmt(`SELECT at FROM antialt_events WHERE ${where.join(' AND ')}`).all({
      kind,
      since,
      ip: id.ip,
      subnet: id.subnet,
      device: id.device,
      fp: id.fp,
      account: id.account ?? -1,
    }) as { at: number }[]
    return rows.map((r) => r.at)
  }

  private limit(l: Limit, kind: EventKind, scope: 'ip' | 'subnet' | 'device' | 'account', id: Ids & { account?: number }, now: number, skipDeleted = false): { retryMs: number } | null {
    if (!l.on) return null
    const ms = windowMs(l)
    const t = this.times(kind, scope, id, now - ms, skipDeleted)
    if (!t) return null
    const r = checkWindow(t, l.count, ms, now)
    return r.ok ? null : { retryMs: r.retryMs }
  }

  // ---- registration ----------------------------------------------------------------------------

  /**
   * Whether a registration may go ahead. The robot check and the detections run first (they may wait on the network);
   * then the limits are counted and, when they pass, a reservation is written in the same synchronous step, so parallel
   * requests cannot all pass one free slot. The caller confirms the ticket with the new account or cancels it.
   */
  async checkRegister(a: Attempt, now = Date.now()): Promise<Refusal | { ticket: number }> {
    const id = this.ids(a)
    const account = a.account ?? ''
    const reserve = () => ({ ticket: this.record('register', null, null, id, now) })
    if (this.exempt(id)) return reserve()
    const refuse = (status: 403 | 429, reason: string, message: string, detail = ''): Refusal => {
      this.writeLog('register', 'blocked', reason, detail, id, account, now)
      return { status, code: status === 429 ? 'rate_limited' : 'forbidden', reason, message }
    }
    const captcha = this.pol.captcha ? this.opts.captcha : null
    if (captcha && !(a.captcha && a.captcha.length <= 2048 && (await captcha.verify(a.captcha, id.ip)))) {
      return refuse(403, 'captcha', 'Please complete the robot check and try again.')
    }
    if (this.allowlisted(id)) return reserve()
    const found = await this.detections(id.ip, false)
    const blocked = this.judge('register', found, id, account)
    if (blocked) return blocked
    const p = this.pol.account
    const checks: [Limit, 'ip' | 'subnet' | 'device', string, (w: string, l: Limit) => string][] = [
      [p.perIp, 'ip', 'account.perIp', (w) => `Too many accounts were made from your address. Try again in ${w}.`],
      [p.perSubnet, 'subnet', 'account.perSubnet', (w) => `Too many accounts from this network, try again in ${w}.`],
      [p.perDevice, 'device', 'account.perDevice', (w) => `Too many accounts were made on this device. Try again in ${w}.`],
    ]
    for (const [l, scope, reason, msg] of checks) {
      const r = this.limit(l, 'register', scope, id, now)
      if (r) return refuse(429, reason, msg(waitText(r.retryMs), l), `${l.count} per ${windowText(l)}`)
    }
    const life = p.deviceLifetime
    if (life.on) {
      const t = this.times('register', 'device', id, 0)
      if (t && t.length >= life.count) {
        return refuse(429, 'account.deviceLifetime', 'This device has reached its account limit. Ask a GM if you need another account.', `${life.count} ever`)
      }
    }
    return reserve()
  }

  /** The registration made its account: the reservation becomes that account's record. */
  confirmRegister(ticket: number, accountId: number): void {
    this.stmt('UPDATE antialt_events SET account_id = ? WHERE id = ?').run(accountId, ticket)
  }

  /** The registration failed after the check (name taken, an error): the reservation goes. */
  cancelRegister(ticket: number): void {
    this.stmt("DELETE FROM antialt_events WHERE id = ? AND kind = 'register' AND account_id IS NULL").run(ticket)
  }

  // ---- login -----------------------------------------------------------------------------------

  /** After the right password: only the detections set to 'block_login' refuse; the login is recorded otherwise. */
  async checkLogin(accountId: number, a: Attempt, now = Date.now()): Promise<Refusal | null> {
    const id = this.ids(a)
    if (!this.exempt(id) && !this.allowlisted(id)) {
      const refusal = this.judge('login', await this.detections(id.ip, false), id, a.account ?? '')
      if (refusal) return refusal
    }
    this.record('login', accountId, null, id, now)
    return null
  }

  /** Records a login without any check (staff accounts). */
  recordLogin(accountId: number, a: Attempt, now = Date.now()): void {
    this.record('login', accountId, null, this.ids(a), now)
  }

  // ---- characters ------------------------------------------------------------------------------

  /** The device and fingerprint of the account's latest login or registration (the game socket brings none). */
  private lastIds(accountId: number, ip: string): Ids {
    const row = this.stmt("SELECT device, fp FROM antialt_events WHERE account_id = ? AND kind IN ('register', 'login') ORDER BY at DESC, id DESC LIMIT 1").get(accountId) as
      | { device: string; fp: string }
      | undefined
    const n = normalizeIp(ip) || ip
    return { ip: n, subnet: subnetOf(n), device: row?.device ?? '', fp: row?.fp ?? '' }
  }

  /** Whether the account may create a character now (synchronous: the external lookup only from its cache). */
  checkCharacter(accountId: number, ip: string, accountName = '', now = Date.now()): Refusal | null {
    const id = this.lastIds(accountId, ip)
    if (this.exempt(id) || this.allowlisted(id)) return null
    const blocked = this.judge('character', this.detections(id.ip, true) as { check: keyof AntiAltPolicy['detect']; label: string }[], id, accountName)
    if (blocked) return blocked
    const c = this.pol.character
    const skip = !c.countDeleted
    const checks: [Limit, 'account' | 'device' | 'ip', string, (w: string, l: Limit) => string][] = [
      [c.perAccount, 'account', 'character.perAccount', (w, l) => `You can create ${l.count} character${l.count === 1 ? '' : 's'} per ${windowText(l)}. Try again in ${w}.`],
      [c.perDevice, 'device', 'character.perDevice', (w) => `Too many characters were created on this device. Try again in ${w}.`],
      [c.perIp, 'ip', 'character.perIp', (w) => `Too many characters were created from this network. Try again in ${w}.`],
    ]
    for (const [l, scope, reason, msg] of checks) {
      const r = this.limit(l, 'char', scope, { ...id, account: accountId }, now, skip)
      if (r) {
        this.writeLog('character', 'blocked', reason, `${l.count} per ${windowText(l)}`, id, accountName, now)
        return { status: 429, code: 'rate_limited', reason, message: msg(waitText(r.retryMs), l) }
      }
    }
    return null
  }

  recordCharacter(accountId: number, characterId: number, ip: string, now = Date.now()): void {
    this.record('char', accountId, characterId, this.lastIds(accountId, ip), now)
  }

  private record(kind: EventKind, accountId: number | null, characterId: number | null, id: Ids, now: number): number {
    return Number(
      this.stmt('INSERT INTO antialt_events (at, kind, account_id, character_id, ip, subnet, device, fp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      now,
      kind,
      accountId,
      characterId,
      id.ip.slice(0, 64),
      id.subnet,
      id.device,
      id.fp,
    ).lastInsertRowid,
    )
  }

  // ---- log, allowlist, lift, linked accounts -----------------------------------------------------

  private writeLog(action: LogAction, outcome: 'blocked' | 'flagged', reason: string, detail: string, id: Ids, account: string, now = Date.now()): void {
    this.stmt('INSERT INTO antialt_log (at, action, outcome, reason, detail, ip, subnet, device, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      now,
      action,
      outcome,
      reason,
      detail.slice(0, 200),
      id.ip.slice(0, 64),
      id.subnet,
      id.device,
      account.slice(0, 32),
    )
    if (outcome === 'blocked') this.opts.log(`anti-alt: ${action} blocked (${reason}) from ${id.ip}${account ? ` (${account})` : ''}`)
  }

  logRows(limit = 200, outcome?: 'blocked' | 'flagged'): LogRow[] {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)))
    return (outcome
      ? this.stmt('SELECT * FROM antialt_log WHERE outcome = ? ORDER BY at DESC, id DESC LIMIT ?').all(outcome, n)
      : this.stmt('SELECT * FROM antialt_log ORDER BY at DESC, id DESC LIMIT ?').all(n)) as LogRow[]
  }

  private reloadAllow(): void {
    this.allow = this.db.prepare('SELECT * FROM antialt_allow ORDER BY id').all() as AllowRow[]
  }

  allowRows(): AllowRow[] {
    return this.allow.map((r) => ({ ...r }))
  }

  /** Adds an allowlist entry; the value is checked for its kind (an address, a CIDR, a 32-hex device hash). */
  addAllow(kind: string, raw: string, note: string, by: string, now = Date.now()): { problem: string } | { row: AllowRow } {
    let value = String(raw ?? '').trim()
    if (kind === 'ip') {
      value = normalizeIp(value)
      if (!value) return { problem: 'not an IP address' }
    } else if (kind === 'subnet') {
      const r = parseCidr(value)
      if (!r || !value.includes('/')) return { problem: 'not a subnet (CIDR such as 203.0.113.0/24)' }
    } else if (kind === 'device') {
      if (!new RegExp(`^[0-9a-f]{${HASH_LEN}}$`).test(value)) return { problem: `a device is its ${HASH_LEN}-character hash from the log` }
    } else return { problem: 'kind must be ip, subnet or device' }
    this.db.prepare('INSERT INTO antialt_allow (kind, value, note, added_at, added_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, value) DO UPDATE SET note = excluded.note').run(
      kind,
      value,
      String(note ?? '').slice(0, 200),
      now,
      by.slice(0, 32),
    )
    this.reloadAllow()
    return { row: this.allow.find((r) => r.kind === kind && r.value === value)! }
  }

  removeAllow(id: number): boolean {
    const n = this.db.prepare('DELETE FROM antialt_allow WHERE id = ?').run(id).changes
    this.reloadAllow()
    return n > 0
  }

  /**
   * Lifts the block of a log row: the events that made a limit full stop counting (waived), so the next try passes.
   * A detection block is lifted by allowlisting the address.
   */
  lift(logId: number, by: string, now = Date.now()): { problem: string } | { message: string } {
    const row = this.stmt('SELECT * FROM antialt_log WHERE id = ?').get(logId) as LogRow | undefined
    if (!row) return { problem: 'no such log entry' }
    if (row.outcome !== 'blocked') return { problem: 'only a blocked attempt can be lifted' }
    const waive = (kind: EventKind, col: 'ip' | 'subnet' | 'device', value: string) => {
      if (!value) return 0
      return this.db.prepare(`UPDATE antialt_events SET waived = 1 WHERE kind = ? AND ${col} = ? AND waived = 0`).run(kind, value).changes
    }
    let message: string
    const r = row.reason
    if (r === 'account.perIp') message = `${waive('register', 'ip', row.ip)} registrations from ${row.ip} no longer count.`
    else if (r === 'account.perSubnet') message = `${waive('register', 'subnet', row.subnet)} registrations from ${row.subnet} no longer count.`
    else if (r === 'account.perDevice' || r === 'account.deviceLifetime') message = `${waive('register', 'device', row.device)} registrations on that device no longer count.`
    else if (r === 'character.perIp') message = `${waive('char', 'ip', row.ip)} character creations from ${row.ip} no longer count.`
    else if (r === 'character.perDevice') message = `${waive('char', 'device', row.device)} character creations on that device no longer count.`
    else if (r === 'character.perAccount') {
      const acc = this.db.prepare('SELECT id FROM accounts WHERE username = ? COLLATE NOCASE').get(row.account) as { id: number } | undefined
      const n = acc ? this.db.prepare("UPDATE antialt_events SET waived = 1 WHERE kind = 'char' AND account_id = ? AND waived = 0").run(acc.id).changes : 0
      message = `${n} character creations of ${row.account || 'the account'} no longer count.`
    } else if (r.startsWith('detect.') || r === 'captcha') {
      if (!row.ip) return { problem: 'the entry has no address' }
      this.addAllow('ip', row.ip, `lifted log #${row.id} (${r})`, by, now)
      message = `${row.ip} is on the allowlist now.`
    } else return { problem: `cannot lift ${r}` }
    this.db.prepare('UPDATE antialt_log SET lifted = 1 WHERE id = ?').run(row.id)
    return { message }
  }

  /** Other accounts that share a device, IP, subnet or fingerprint with this one (strongest signal first). */
  linked(accountId: number, limit = 100): LinkedRow[] {
    const sql = `
      WITH mine AS (SELECT DISTINCT ip, subnet, device, fp FROM antialt_events WHERE account_id = @id)
      SELECT e.account_id, a.username,
        MAX(e.device != '' AND e.device IN (SELECT device FROM mine)) AS device,
        MAX(e.ip != '' AND e.ip IN (SELECT ip FROM mine)) AS ip,
        MAX(e.subnet != '' AND e.subnet IN (SELECT subnet FROM mine)) AS subnet,
        MAX(e.fp != '' AND e.fp IN (SELECT fp FROM mine)) AS fp,
        MAX(e.at) AS last
      FROM antialt_events e JOIN accounts a ON a.id = e.account_id
      WHERE e.account_id != @id AND (
        (e.device != '' AND e.device IN (SELECT device FROM mine)) OR (e.ip != '' AND e.ip IN (SELECT ip FROM mine)) OR
        (e.subnet != '' AND e.subnet IN (SELECT subnet FROM mine)) OR (e.fp != '' AND e.fp IN (SELECT fp FROM mine)))
      GROUP BY e.account_id
      ORDER BY device DESC, ip DESC, fp DESC, subnet DESC, last DESC
      LIMIT @limit`
    return this.stmt(sql).all({ id: accountId, limit: Math.max(1, Math.min(500, limit)) }) as LinkedRow[]
  }

  /** Drops log rows and login records older than the policy's log days (registrations and creations keep counting). */
  purge(now = Date.now()): number {
    const before = now - this.pol.logDays * 86_400_000
    const a = this.stmt('DELETE FROM antialt_log WHERE at < ?').run(before).changes
    const b = this.stmt("DELETE FROM antialt_events WHERE kind = 'login' AND at < ?").run(before).changes
    return a + b
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function logAction(a: GuardAction): LogAction {
  return a
}

function detectMessage(check: keyof AntiAltPolicy['detect'], action: GuardAction): string {
  const what = action === 'register' ? 'Creating accounts' : action === 'character' ? 'Creating characters' : 'Logging in'
  if (check === 'tor') return `${what} through Tor is not allowed on this server.`
  return `${what} through a VPN, proxy or hosting provider is not allowed on this server. Please turn it off and try again.`
}
