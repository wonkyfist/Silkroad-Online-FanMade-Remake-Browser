import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  ACCOUNT_NAME,
  ADMIN_API_PREFIX,
  ADMIN_API_VERSION,
  ADMIN_BODY_MAX_BYTES,
  ADMIN_CONTENT_BODY_MAX_BYTES,
  ADMIN_KICK_REASON_MAX,
  ADMIN_NOTICE_MAX,
  PASSWORD_MAX_LENGTH,
  codePointLength,
  type AdminDashboard,
  type AdminInfo,
  type AdminLoginResponse,
  type AdminMe,
  type AdminSettingsView,
  type ApiError,
  type Role,
} from '@sro/shared'
import { FailureLimiter, HashBusyError, TokenBucket, hashToken, newToken, verifyPassword } from '../auth.ts'
import { REPO_ROOT } from '../config.ts'
import { cleanChat } from '../connection.ts'
import type { GameContext } from '../game.ts'
import * as accounts from './accounts.ts'
import { onlineCharacter, type AdminCall } from './call.ts'
import * as characters from './characters.ts'
import * as content from './content.ts'
import { AdminError, bad, body, conflict, idOf, isObj, notFound, paging, search, segment, str } from './http.ts'
import { adminEvents, adminRouteGroup } from './routes.ts'
import type { SettingsState } from './settings.ts'
import type { AdminStore } from './store.ts'
import * as world from './world.ts'

/**
 * The admin panel's HTTP API, `/api/admin/*` (docs/ADMIN.md §3, §4). game.ts hands every request under the prefix to
 * `AdminApi.handle` (after its same-origin check) and writes the answer. Every route but `login` needs an admin session
 * (Bearer); the account's role and ban are re-read on every request. Writes add an admin_audit row.
 */

/** Admin session lifetime, idle timeout and the most sessions per account (docs/ADMIN.md §4). */
export const ADMIN_SESSION_TTL_MS = 12 * 3600_000
export const ADMIN_IDLE_MS = 2 * 3600_000
export const ADMIN_MAX_SESSIONS = 5
/** last_seen is written at most this often per session. */
const TOUCH_MS = 30_000
/** Requests per second per admin account (burst). */
export const ADMIN_RATE = { perSecond: 20, burst: 60 } as const

export interface AdminHttpRequest {
  method: string
  /** URL path without the query, starting with /api/admin/. */
  path: string
  query: URLSearchParams
  authorization: string | undefined
  ip: string
  /** Reads the JSON body of at most `limit` bytes (game.ts readJson; its 400/413 errors propagate). */
  body: (limit: number) => Promise<unknown>
  now?: number
}

export interface AdminHttpResponse {
  status: number
  body?: unknown
}

type Handler = (c: AdminCall, m: string[]) => unknown | Promise<unknown>
interface Route {
  method: string
  re: RegExp
  run: Handler
  /** Answer status when the handler returns (default 200). */
  status?: number
}

const ID = '(\\d{1,15})'
const CODE = '([^/]{1,128})'

function routes(api: AdminApi): Route[] {
  const r = (method: string, path: string, run: Handler, status?: number): Route => ({ method, re: new RegExp(`^${ADMIN_API_PREFIX}${path}$`), run, ...(status ? { status } : {}) })
  return [
    r('GET', 'me', (c) => api.me(c)),
    r('POST', 'logout', (c) => api.logout(c), 204),
    r('GET', 'dashboard', (c) => api.dashboard(c)),
    r('POST', `players/${ID}/kick`, (c, m) => api.kickCharacter(c, idOf(m[1]))),
    r('POST', `players/${ID}/town`, (c, m) => characters.sendToTown(c, idOf(m[1]))),
    r('POST', 'notice', (c) => api.notice(c)),
    r('POST', 'restart', (c) => api.restart(c), 202),
    // accounts
    r('GET', 'accounts', (c) => accounts.listAccounts(c)),
    r('POST', 'accounts', (c) => accounts.createAccount(c), 201),
    r('GET', `accounts/${ID}`, (c, m) => accounts.accountDetail(c, idOf(m[1]))),
    r('POST', `accounts/${ID}/password`, (c, m) => accounts.resetPassword(c, idOf(m[1]))),
    r('POST', `accounts/${ID}/ban`, (c, m) => accounts.ban(c, idOf(m[1]))),
    r('POST', `accounts/${ID}/unban`, (c, m) => accounts.unban(c, idOf(m[1]))),
    r('POST', `accounts/${ID}/kick`, (c, m) => accounts.kick(c, idOf(m[1]))),
    r('POST', `accounts/${ID}/storage`, (c, m) => characters.giveStorageItem(c, idOf(m[1]))),
    r('POST', `accounts/${ID}/storage/remove`, (c, m) => characters.removeStorageItem(c, idOf(m[1]))),
    r('POST', `accounts/${ID}/storage/gold`, (c, m) => characters.setStorageGold(c, idOf(m[1]))),
    // characters
    r('GET', 'characters', (c) => characters.listCharacters(c)),
    r('GET', `characters/${ID}`, (c, m) => characters.characterDetail(c, idOf(m[1]))),
    r('POST', `characters/${ID}/progress`, (c, m) => characters.setProgress(c, idOf(m[1]))),
    r('POST', `characters/${ID}/gold`, (c, m) => characters.setGold(c, idOf(m[1]))),
    r('POST', `characters/${ID}/town`, (c, m) => characters.sendToTown(c, idOf(m[1]))),
    r('POST', `characters/${ID}/items`, (c, m) => characters.giveItem(c, idOf(m[1]))),
    r('POST', `characters/${ID}/items/remove`, (c, m) => characters.removeItem(c, idOf(m[1]))),
    // settings and audit
    r('GET', 'settings', (c) => api.settingsView(c)),
    r('PUT', 'settings', (c) => api.putSettings(c)),
    r('GET', 'audit', (c) => {
      const { page, size } = paging(c.query)
      return { page, size, ...c.store.auditPage({ q: search(c.query), action: search(c.query, 'action') }, page, size) }
    }),
    r('GET', 'gm-audit', (c) => {
      const { page, size } = paging(c.query)
      return { page, size, ...c.store.gmAuditPage(page, size) }
    }),
    // items, drops, pickers
    r('GET', 'items', (c) => content.listItems(c)),
    r('GET', `items/${CODE}`, (c, m) => content.itemDetail(c, segment(m[1]))),
    r('PUT', `items/${CODE}`, (c, m) => content.putItem(c, segment(m[1]))),
    r('DELETE', `items/${CODE}`, (c, m) => content.deleteItem(c, segment(m[1]))),
    r('GET', 'drops', (c) => content.listDrops(c)),
    r('GET', `drops/${CODE}`, (c, m) => content.dropDetail(c, segment(m[1]))),
    r('PUT', `drops/${CODE}`, (c, m) => content.putDrop(c, segment(m[1]))),
    r('DELETE', `drops/${CODE}`, (c, m) => content.deleteDrop(c, segment(m[1]))),
    r('GET', 'mobs', (c) => content.listMobs(c)),
    r('GET', 'shops', (c) => content.listShops(c)),
    // the GM editors
    r('GET', 'nests', (c) => world.listNests(c)),
    r('POST', 'nests', (c) => world.addNest(c), 201),
    r('POST', 'nests/undo', (c) => world.undoNests(c)),
    r('POST', `nests/${ID}`, (c, m) => world.setNest(c, idOf(m[1]))),
    r('POST', `nests/${ID}/move`, (c, m) => world.moveNest(c, idOf(m[1]))),
    r('POST', `nests/${ID}/remove`, (c, m) => world.removeNest(c, idOf(m[1]))),
    r('POST', `nests/${ID}/restore`, (c, m) => world.restoreNest(c, idOf(m[1]))),
    r('GET', 'npcs', (c) => world.listNpcs(c)),
    r('POST', 'npcs', (c) => world.addNpc(c), 201),
    r('POST', 'npcs/undo', (c) => world.undoNpcs(c)),
    r('POST', `npcs/${CODE}`, (c, m) => world.setNpc(c, segment(m[1]))),
    r('POST', `npcs/${CODE}/move`, (c, m) => world.moveNpc(c, segment(m[1]))),
    r('POST', `npcs/${CODE}/remove`, (c, m) => world.removeNpc(c, segment(m[1]))),
    r('POST', `npcs/${CODE}/restore`, (c, m) => world.restoreNpc(c, segment(m[1]))),
    r('GET', 'quests', (c) => world.listQuests(c)),
    r('GET', `quests/${CODE}`, (c, m) => world.questDetail(c, segment(m[1]))),
    r('PUT', `quests/${CODE}`, (c, m) => world.questEdit(c, 'PUT', segment(m[1]))),
    r('DELETE', `quests/${CODE}`, (c, m) => world.questEdit(c, 'DELETE', segment(m[1]))),
    r('POST', `quests/${CODE}/(disable|enable)`, (c, m) => world.questEdit(c, m[2] as 'disable' | 'enable', segment(m[1]))),
    // events
    r('GET', 'uniques', (c) => world.uniquesView(c)),
    r('POST', `uniques/${CODE}/(spawn|kill|despawn|timer)`, (c, m) => world.uniqueAction(c, segment(m[1]), m[2] as 'spawn' | 'kill' | 'despawn' | 'timer')),
    r('GET', 'events', (c) => ({ events: adminEvents(c.ctx) })),
  ]
}

interface Authed {
  account: { id: number; username: string; role: Role }
  tokenHash: string
  expiresAt: number
}

export class AdminApi {
  private readonly table: Route[]
  private readonly loginFailures = new FailureLimiter(5, 15 * 60_000)
  private readonly ipLoginFailures = new FailureLimiter(20, 15 * 60_000)
  private readonly buckets = new Map<number, TokenBucket>()
  private tickSample: { at: number; ticks: number } | null = null
  private readonly release: { name: string; commit: string | null }

  constructor(
    readonly ctx: GameContext,
    readonly store: AdminStore,
    readonly settings: SettingsState,
    readonly startedAt: number,
  ) {
    this.table = routes(this)
    const shaFile = join(REPO_ROOT, '.deploy-sha')
    const commit = existsSync(shaFile) ? readFileSync(shaFile, 'utf8').trim().slice(0, 64) || null : null
    this.release = { name: commit ? basename(REPO_ROOT) : 'dev', commit }
  }

  /** Answers one /api/admin/* request. Throws only what game.ts itself handles (body read errors, internal errors). */
  async handle(req: AdminHttpRequest): Promise<AdminHttpResponse> {
    const now = req.now ?? Date.now()
    try {
      if (req.path === `${ADMIN_API_PREFIX}login`) {
        if (req.method !== 'POST') throw notFound('no such endpoint')
        return { status: 200, body: await this.login(req, now) }
      }
      // Which server this is, before any login (the panel's server profiles, docs/ADMIN.md §2.1).
      if (req.path === `${ADMIN_API_PREFIX}info` && req.method === 'GET') return { status: 200, body: this.info() }
      const group = /^\/api\/admin\/([a-z0-9-]{1,32})(?:\/|$)/.exec(req.path)
      const plugin = group ? adminRouteGroup(group[1]) : undefined
      let route: Route | undefined
      let m: RegExpExecArray | null = null
      if (!plugin) {
        for (const rt of this.table) {
          if (rt.method !== req.method) continue
          m = rt.re.exec(req.path)
          if (m) {
            route = rt
            break
          }
        }
        if (!route) throw notFound('no such endpoint')
      }
      const auth = this.authenticate(req.authorization, now)
      let bucket = this.buckets.get(auth.account.id)
      if (!bucket) this.buckets.set(auth.account.id, (bucket = new TokenBucket(ADMIN_RATE.perSecond, ADMIN_RATE.burst)))
      if (!bucket.take(now)) throw new AdminError(429, 'rate_limited', 'too many requests, slow down')
      const call = this.call(req, auth, now)
      if (plugin) return await this.runGroup(plugin, req, call, auth)
      const out = await route!.run(call, [...m!])
      const status = route!.status ?? 200
      return status === 204 ? { status } : { status, body: out }
    } catch (e) {
      if (e instanceof AdminError) return { status: e.status, body: { ...e.extra, error: e.code, message: e.message } satisfies ApiError }
      if (e instanceof HashBusyError) return { status: 503, body: { error: 'rate_limited', message: 'server busy, try again in a moment' } satisfies ApiError }
      throw e
    }
  }

  /** The session behind a Bearer token, its account an admin right now and not banned; else 401 / 403. */
  private authenticate(authorization: string | undefined, now: number): Authed {
    const m = /^Bearer\s+(\S{1,256})$/.exec(authorization ?? '')
    if (!m) throw new AdminError(401, 'unauthorized', 'missing bearer token')
    const tokenHash = hashToken(m[1])
    const s = this.store.session(tokenHash, now)
    if (!s) throw new AdminError(401, 'unauthorized', 'session expired or invalid')
    if (now - s.last_seen > ADMIN_IDLE_MS) {
      this.store.deleteSession(tokenHash)
      throw new AdminError(401, 'unauthorized', 'session expired (idle)')
    }
    const account = this.ctx.store.accountById(s.account_id)
    if (!account || account.role !== 'admin' || this.store.banOf(account.id)) {
      this.store.deleteSession(tokenHash)
      throw new AdminError(403, 'forbidden', 'admin accounts only')
    }
    if (now - s.last_seen > TOUCH_MS) this.store.touchSession(tokenHash, now)
    return { account: { id: account.id, username: account.username, role: account.role }, tokenHash, expiresAt: s.expires_at }
  }

  private call(req: AdminHttpRequest, auth: Authed, now: number): AdminCall {
    const audit: AdminCall['audit'] = (action, target, before, after, ok = true, detail = '') =>
      this.store.audit({ accountId: auth.account.id, username: auth.account.username, ip: req.ip, action, target, before, after, ok, detail }, now)
    return {
      ctx: this.ctx,
      store: this.store,
      settings: this.settings,
      admin: { id: auth.account.id, username: auth.account.username },
      tokenHash: auth.tokenHash,
      ip: req.ip,
      now,
      query: req.query,
      audit,
      body: async (limit = ADMIN_BODY_MAX_BYTES) => {
        const declared = req.method === 'GET' ? undefined : await req.body(limit)
        // The body may arrive long after the headers: the session and the role are checked again as they are now.
        const again = this.authenticate(req.authorization, Date.now())
        if (again.account.id !== auth.account.id) throw new AdminError(401, 'unauthorized', 'session changed')
        return declared
      },
    }
  }

  /** A plugged-in route group (docs/ADMIN.md §3.1): parsed body, the actor, an admin_audit row per write. */
  private async runGroup(group: NonNullable<ReturnType<typeof adminRouteGroup>>, req: AdminHttpRequest, call: AdminCall, auth: Authed): Promise<AdminHttpResponse> {
    const parsed = req.method === 'GET' || req.method === 'HEAD' ? undefined : await call.body(group.maxBody ?? ADMIN_CONTENT_BODY_MAX_BYTES)
    const res = await group.handle(this.ctx, { method: req.method, path: req.path, query: req.query, body: parsed, actor: { accountId: auth.account.id, role: auth.account.role, username: auth.account.username } })
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const action = `${group.prefix}.${req.method.toLowerCase()}`
      call.audit(action, req.path.slice(ADMIN_API_PREFIX.length), undefined, parsed, res.status < 400, `HTTP ${res.status}`)
    }
    return { status: res.status, body: res.body }
  }

  // ---- session -----------------------------------------------------------------------------------------------

  private async login(req: AdminHttpRequest, now: number): Promise<AdminLoginResponse> {
    const o = body(await req.body(ADMIN_BODY_MAX_BYTES), ['username', 'password'])
    if (typeof o.username !== 'string' || typeof o.password !== 'string') throw bad('username and password must be strings')
    const username = o.username
    const key = `${req.ip}|${username.toLowerCase().slice(0, 64)}`
    const audit = (accountId: number | null, ok: boolean, detail: string) =>
      this.store.audit({ accountId, username: username.slice(0, 32), ip: req.ip, action: 'login', target: '', ok, detail }, now)
    if (this.loginFailures.blocked(key, now) || this.ipLoginFailures.blocked(req.ip, now)) {
      throw new AdminError(429, 'rate_limited', 'too many failed logins, try again later')
    }
    // Counted before the slow hash (a burst of parallel requests cannot all pass the check above); a success takes it back.
    this.loginFailures.fail(key, now)
    this.ipLoginFailures.fail(req.ip, now)
    const valid = ACCOUNT_NAME.test(username) && codePointLength(o.password) <= PASSWORD_MAX_LENGTH
    const account = valid ? this.ctx.store.accountByName(username) : undefined
    let ok: boolean
    try {
      ok = await verifyPassword(valid ? o.password : '', account?.password_hash ?? null)
    } catch (e) {
      this.loginFailures.forgive(key)
      this.ipLoginFailures.forgive(req.ip)
      throw e
    }
    if (!ok || !account) {
      audit(account?.id ?? null, false, 'wrong username or password')
      throw new AdminError(401, 'unauthorized', 'wrong username or password')
    }
    // The role and the ban as stored right now; a refusal keeps the counted attempt.
    const role = this.ctx.store.accountRole(account.id)
    if (role !== 'admin') {
      audit(account.id, false, `refused: role ${role}`)
      throw new AdminError(403, 'forbidden', 'admin accounts only')
    }
    if (this.store.banOf(account.id)) {
      audit(account.id, false, 'refused: banned')
      throw new AdminError(403, 'forbidden', 'this account is banned')
    }
    this.loginFailures.reset(key)
    this.ipLoginFailures.forgive(req.ip)
    const token = newToken()
    const expiresAt = now + ADMIN_SESSION_TTL_MS
    this.store.purgeSessions(now, ADMIN_IDLE_MS)
    this.store.createSession(hashToken(token), account.id, expiresAt, req.ip, now)
    this.store.trimSessions(account.id, ADMIN_MAX_SESSIONS)
    audit(account.id, true, 'ok')
    this.ctx.config.log(`admin panel: ${account.username} logged in from ${req.ip}`)
    return { token, expiresAt, account: { id: account.id, username: account.username } }
  }

  /** 'local' when the server listens on a loopback address only (a development server); every other server is 'live'. */
  environment(): 'live' | 'local' {
    const host = this.ctx.config.host.trim().toLowerCase()
    return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ? 'local' : 'live'
  }

  info(): AdminInfo {
    return {
      admin: true,
      apiVersion: ADMIN_API_VERSION,
      name: this.ctx.setup.displayName,
      world: this.ctx.config.world,
      environment: this.environment(),
      release: this.release.name,
      commit: this.release.commit,
    }
  }

  me(c: AdminCall): AdminMe {
    const s = this.store.session(c.tokenHash, c.now)
    return { account: c.admin, expiresAt: s?.expires_at ?? c.now }
  }

  logout(c: AdminCall): void {
    this.store.deleteSession(c.tokenHash)
    c.audit('logout', '', undefined, undefined, true)
  }

  // ---- dashboard ------------------------------------------------------------------------------------------------

  dashboard(c: AdminCall): AdminDashboard {
    const { ctx } = c
    const w = ctx.world
    const now = c.now
    let tickRate: number | null = null
    if (this.tickSample && now - this.tickSample.at >= 1000) tickRate = Math.round(((w.ticks - this.tickSample.ticks) * 1000 * 10) / (now - this.tickSample.at)) / 10
    if (!this.tickSample || now - this.tickSample.at >= 1000) this.tickSample = { at: now, ticks: w.ticks }
    const players: AdminDashboard['players'] = []
    const lobby: AdminDashboard['lobby'] = []
    for (const conn of ctx.sockets.values()) {
      const p = conn.player
      if (!p) {
        lobby.push({ accountId: conn.accountId, account: conn.account, role: conn.role })
        continue
      }
      const at = w.livePoint(p, now)
      players.push({
        characterId: p.characterId, accountId: conn.accountId, account: conn.account, role: conn.role, name: p.name, level: p.level,
        x: Math.round(at.x * 10) / 10, z: Math.round(at.z * 10) / 10, zone: ctx.data.zoneName(at.x, at.z, ctx.setup.regionOrigin), dead: p.dead, invisible: p.invisible,
      })
    }
    players.sort((a, b) => a.name.localeCompare(b.name))
    lobby.sort((a, b) => a.account.localeCompare(b.account))
    return {
      server: {
        name: ctx.setup.displayName,
        environment: this.environment(),
        world: ctx.config.world,
        worldExport: ctx.config.worldExport ?? ctx.config.world,
        release: this.release.name,
        commit: this.release.commit,
        node: process.version,
        startedAt: this.startedAt,
        uptimeS: Math.round((now - this.startedAt) / 1000),
        online: w.online,
        lobby: lobby.length,
        capacity: ctx.config.capacity,
        schema: ctx.store.schemaVersion,
        dbBytes: this.store.dbBytes(),
        nav: ctx.nav.kind,
        mobs: w.mobs.size,
        tickHz: w.tickHz,
        ticks: w.ticks,
        tickRate,
        worstTickMs: Math.round(w.worstTickMs * 100) / 100,
        registration: ctx.config.registrationOpen === false ? 'closed' : 'open',
        restart: typeof ctx.requestRestart === 'function',
        pendingRestart: this.settings.pending(),
      },
      players,
      lobby,
    }
  }

  async kickCharacter(c: AdminCall, characterId: number): Promise<{ kicked: boolean }> {
    const o = body((await c.body()) ?? {}, ['reason'])
    const reason = cleanChat(str(o, 'reason', ADMIN_KICK_REASON_MAX, true) ?? '')
    const live = onlineCharacter(c.ctx, characterId)
    if (!live) throw conflict('That character is not online.')
    if (live.conn.accountId === c.admin.id) throw conflict('You cannot kick yourself.')
    accounts.kickAccount(c.ctx, live.conn.accountId, `You were disconnected by an administrator${reason ? `: ${reason}` : '.'}`, `kicked${reason ? `: ${reason}` : ''}`)
    c.audit('player.kick', `character:${characterId}`, undefined, { reason }, true, live.player.name)
    return { kicked: true }
  }

  async notice(c: AdminCall): Promise<{ recipients: number }> {
    const o = body(await c.body(), ['text'])
    const text = cleanChat(str(o, 'text', ADMIN_NOTICE_MAX * 2))
    if (!text) throw bad('the notice is empty')
    if (codePointLength(text) > ADMIN_NOTICE_MAX) throw bad(`a notice is at most ${ADMIN_NOTICE_MAX} characters`)
    let n = 0
    for (const conn of c.ctx.sockets.values()) {
      conn.send({ t: 'notice', text, from: c.admin.username })
      n++
    }
    c.ctx.config.log(`notice by admin ${c.admin.username}: ${text}`)
    c.audit('notice', '', undefined, { text }, true, `${n} recipients`)
    return { recipients: n }
  }

  async restart(c: AdminCall): Promise<{ restarting: true }> {
    body((await c.body()) ?? {}, [])
    const restart = this.ctx.requestRestart
    if (typeof restart !== 'function') throw conflict('This server has no supervisor to start it again; restart it by hand.')
    c.audit('server.restart', '', undefined, undefined, true, `${this.ctx.world.online} players online`)
    this.ctx.config.log(`admin ${c.admin.username}: restart requested`)
    // Answer first; the shutdown (save, close sockets) starts a moment later.
    setTimeout(restart, 250).unref?.()
    return { restarting: true }
  }

  // ---- settings ---------------------------------------------------------------------------------------------------

  settingsView(_c: AdminCall): AdminSettingsView {
    return { settings: this.settings.view(), restart: typeof this.ctx.requestRestart === 'function' }
  }

  async putSettings(c: AdminCall): Promise<AdminSettingsView> {
    const o = body(await c.body(), ['values'])
    if (!isObj(o.values) || Object.keys(o.values).length === 0) throw bad('values must be an object of settings')
    if (Object.keys(o.values).length > 100) throw bad('too many settings at once')
    const r = this.settings.put(this.ctx, o.values, c.admin.username)
    if ('problems' in r) {
      c.audit('settings.put', 'settings', undefined, o.values, false, r.problems.join('; ').slice(0, 500))
      throw bad(r.problems.join('; '))
    }
    c.audit('settings.put', 'settings', r.before, r.after)
    this.ctx.config.log(`admin ${c.admin.username}: settings ${Object.entries(r.after).map(([k, v]) => `${k}=${v === null ? '(reset)' : String(v)}`).join(', ')}`)
    return this.settingsView(c)
  }
}
