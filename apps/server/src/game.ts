import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import {
  ACCOUNT_NAME,
  CLOSE_CODE,
  NEWS_ID,
  NEWS_IMAGE_NAME,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  WORLD_FOLDER,
  codePointLength,
  type ApiError,
  type ApiLoginResponse,
  type ApiNewsList,
  type ApiNewsSeenRequest,
  type ApiNewsSeenResponse,
  type ErrorCode,
  type ServerInfo,
} from '@sro/shared'
import { WebSocketServer, type WebSocket } from 'ws'
import { ADMIN_IDLE_MS, AdminApi } from './admin/api.ts'
import { layerAdminContent, mergedItemsJson } from './admin/content.ts'
import { ADMIN_ICON_PATH, iconRoots } from './admin/icons.ts'
import { SettingsState } from './admin/settings.ts'
import { openAdminStore } from './admin/store.ts'
import { FailureLimiter, HashBusyError, MAX_SESSIONS_PER_ACCOUNT, SESSION_TTL_MS, hashPassword, hashToken, newToken, verifyPassword } from './auth.ts'
import type { ServerConfig } from './config.ts'
import { Connection } from './connection.ts'
import { CharacterModels, regionAt, resolveWorld, withAuthoredPlaces, withTownSpawn, type WorldSetup } from './content.ts'
import { checkPlaces } from './places.ts'
import { openStore, type Store } from './db.ts'
import { layerContentOverrides, layerRepoOverrides } from './editors/overrides.ts'
import { GM_API_PREFIX, handleGmApi } from './editors/quest-api.ts'
import { Gameplay } from './gameplay.ts'
import { GameData } from './gamedata.ts'
import { FlatNav, MeshNav, type NavProvider } from './nav.ts'
import { NewsStore } from './news.ts'
import { originAllowed } from './origin.ts'
import { acceptedEncodings, serveFile } from './static.ts'
import type { Updater } from './updater/updater.ts'
import { World, type Player } from './world.ts'

/** Hard WebSocket frame cap: larger frames close the socket (1009). Smaller-but-too-big get bad_request. */
export const WS_MAX_PAYLOAD = 4096
const MAX_BODY_BYTES = 4096
const HEARTBEAT_MS = 30_000
/** Open game sockets per client IP (friends behind one NAT each need one). */
const MAX_SOCKETS_PER_IP = 16

export interface GameContext {
  config: ServerConfig
  store: Store
  world: World
  setup: WorldSetup
  models: CharacterModels
  /** Gameplay content (OUT_DIR/data), rules and the monster simulation. */
  data: GameData
  nav: NavProvider
  gameplay: Gameplay
  /** One live socket per account. */
  sockets: Map<number, Connection>
  serverInfo(): ServerInfo
  /** Saves the authoritative positions (and HP/MP/death) of `players` at `now`. */
  persist(players: Player[], now?: number): void
  /**
   * Applies role changes made by another process (the gm CLI) to connected accounts. Runs every
   * config.rolePollMs, but only reads roles when SQLite's data_version says someone else wrote.
   */
  refreshRoles(force?: boolean): void
  /** The "What's new" entries (docs/CHANGELOG_WINDOW.md): repo files with the admin panel's layer over them. */
  news: NewsStore
  /**
   * Admin panel (docs/ADMIN.md §6): saves, closes and exits so a supervisor (systemd) starts the server again. Set by
   * main.ts only when such a supervisor exists; absent = the panel offers no Restart.
   */
  requestRestart?: () => void
  /** Self-updates (docs/UPDATES.md): set by main.ts; absent in tests and embedded servers (the Updates page says so). */
  updater?: Updater
}

export interface GameServer {
  ctx: GameContext
  http: Server
  port: number
  url: string
  close(): Promise<void>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(data)
}

/**
 * The admin panel's files (docs/ADMIN.md §4): own scripts and styles only, no framing. API calls and icons may go to other
 * game servers (the panel's server profiles, §2.1), whose own role checks and ALLOWED_ORIGINS decide; scripts never do.
 */
const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: http: https:; connect-src 'self' http: https:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

/** A prepared JSON document (the merged items.json) with its ETag, gzip when the client takes it. */
function sendMergedJson(req: IncomingMessage, res: ServerResponse, doc: { etag: string; json: Buffer; gz: Buffer }): void {
  const gzip = acceptedEncodings(req.headers['accept-encoding']).gzip
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ETag: gzip ? doc.etag.replace(/"$/, '-gz"') : doc.etag,
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
  }
  const inm = req.headers['if-none-match']
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === headers.ETag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  const body = gzip ? doc.gz : doc.json
  if (gzip) headers['Content-Encoding'] = 'gzip'
  headers['Content-Length'] = body.length
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : body)
}

function sendError(res: ServerResponse, status: number, code: ErrorCode, message: string): void {
  const body: ApiError = { error: code, message }
  sendJson(res, status, body)
}

/**
 * Reads a JSON body of at most `limit` bytes (default 4 KB; the GM editor routes pass GM_API_MAX_BODY_BYTES, 32 KB).
 * `emptyOk`: an empty body reads as undefined (the admin API's bodiless POSTs) instead of a 400.
 */
async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES, emptyOk = false): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new HttpError(413, 'bad_request', 'body too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'bad_request', 'body too large')
    chunks.push(chunk as Buffer)
  }
  if (emptyOk && size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_request', 'body must be JSON')
  }
}

function credentials(body: unknown): { username: string; password: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'body must be an object')
  const o = body as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.some((k) => k !== 'username' && k !== 'password')) throw new HttpError(400, 'bad_request', 'unexpected field')
  if (typeof o.username !== 'string' || typeof o.password !== 'string') {
    throw new HttpError(400, 'bad_request', 'username and password must be strings')
  }
  return { username: o.username, password: o.password }
}

function checkPasswordRule(password: string): void {
  const n = codePointLength(password)
  if (n < PASSWORD_MIN_LENGTH || n > PASSWORD_MAX_LENGTH) {
    throw new HttpError(400, 'bad_request', `password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`)
  }
}

/**
 * The world's navmesh (OUT_DIR/world/<WORLD>/, then OUT_OPT_DIR) or, without one (or with NAV=off), the flat world
 * bounds. A navmesh that fails to load is logged and the server keeps running flat.
 */
function loadNav(config: ServerConfig, bounds: WorldSetup['bounds']): NavProvider {
  if (config.nav === 'off') return new FlatNav(bounds)
  const dirs = [config.outDir, config.outOptDir ?? join(dirname(config.outDir), 'out-opt')]
  const { nav, problem } = MeshNav.load(dirs, config.worldExport ?? config.world)
  if (nav) return nav
  config.log(`navigation: no navmesh (${problem}); using the flat world bounds`)
  return new FlatNav(bounds)
}

/**
 * One startup line for the nests the placement rule refused ('outside the world': no open ground near them in the
 * town spawn's walkable component). Inside the world bounds they are unreachable on foot from town (e.g. the
 * Western China fields across the river on jangan-fields, docs/FIELDS.md §4.2); the rest lie beyond the export.
 */
export function unplacedNestsLine(gameplay: Gameplay, data: GameData, setup: WorldSetup): string | null {
  const byId = new Map(data.nests.map((n) => [n.id, n]))
  const refused = gameplay.spawner.skipped.flatMap((k) => (k.reason === 'outside the world' && byId.has(k.nest) ? [byId.get(k.nest)!] : []))
  if (refused.length === 0) return null
  const b = setup.bounds
  const inside = refused.filter((n) => b && n.x >= b.minX && n.x <= b.maxX && n.z >= b.minZ && n.z <= b.maxZ)
  const parts: string[] = []
  if (inside.length > 0) {
    const mobs = inside.reduce((sum, n) => sum + n.count, 0)
    const regions = inside.map((n) => regionAt(setup.regionOrigin, n.x, n.z)).filter((r) => r !== null)
    const span = regions.length
      ? `; regions ${Math.min(...regions.map((r) => r.rx))}-${Math.max(...regions.map((r) => r.rx))} x ${Math.min(...regions.map((r) => r.rz))}-${Math.max(...regions.map((r) => r.rz))}`
      : ''
    const zones = [...new Set(inside.map((n) => data.zoneName(n.x, n.z, setup.regionOrigin)).filter(Boolean))].sort()
    parts.push(`${inside.length} unreachable on foot from town (${mobs} monsters${span}${zones.length ? `: ${zones.join(', ')}` : ''})`)
  }
  if (refused.length > inside.length) parts.push(`${refused.length - inside.length} outside the world export`)
  return `nests not spawned: ${parts.join('; ')}`
}

export async function startServer(config: ServerConfig): Promise<GameServer> {
  const store = openStore(config.dataDir)
  store.purgeSessions()
  // Admin panel (docs/ADMIN.md §5): its tables, and the settings saved in it applied before any module reads the config.
  const adminStore = openAdminStore(store, join(config.dataDir, 'game.db'))
  const settings = SettingsState.load(config, adminStore)
  const data = GameData.load(config.outDir)
  for (const line of data.summary()) config.log(line)
  // GM content overrides (DATA_DIR/content/{nests,npcs}.override.json) over the export, before anything is placed (lane ED-S).
  // Repo overrides (CONTENT_DIR/{nests,npcs}.override.json) first: they are part of the content the GM files layer over.
  layerRepoOverrides(data, config.contentDir, config.world, config.log)
  layerContentOverrides(data, config.dataDir, config.world, config.log)
  // Admin item and drop overrides (DATA_DIR/content/{items,drops}.override.json; docs/ADMIN.md §5).
  layerAdminContent(data, config.dataDir, config.outDir, config.log)
  const worldExport = config.worldExport ?? config.world
  const base = withTownSpawn(resolveWorld(config.outDir, worldExport, config.spawn, config.world), config.world, data.town(config.world))
  // GM teleport places: the manifest's, then CONTENT_DIR/places.json (docs/PLAYTEST.md "Teleport places").
  const setup = withAuthoredPlaces(base, config.contentDir, config.world, config.log)
  const nav = loadNav(config, setup.bounds)
  const world = new World(config.world, config.moveSpeed, config.tickHz, setup.bounds, nav)
  world.viewRange = config.viewRange
  // Only places a GM can stand on stay in the tp list (the rest are logged and skipped).
  setup.places = checkPlaces(setup.places, world, nav, [config.world.toLowerCase(), 'spawn'], config.log)
  let tickErrors = 0
  world.onError = (e) => {
    // Log the first few in full, then every 100th (a persistent fault must not flood the log at the tick rate).
    if (++tickErrors <= 5 || tickErrors % 100 === 0) config.log(`world tick failed (${tickErrors}): ${(e as Error).stack ?? e}`)
  }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: config.rng })
  const models = new CharacterModels(config.outDir)
  const outOptDir = config.outOptDir ?? join(dirname(config.outDir), 'out-opt')
  const sockets = new Map<number, Connection>()
  const startedAt = Date.now()
  /** When each player in the world was last saved (played_ms accrues between saves). */
  const playedAt = new WeakMap<Player, number>()

  const ctx: GameContext = {
    config,
    store,
    world,
    setup,
    models,
    data,
    nav,
    gameplay,
    sockets,
    news: NewsStore.open(config),
    serverInfo: () => ({
      id: config.world,
      name: setup.displayName,
      status: 'online',
      online: world.online,
      capacity: config.capacity,
      // The export folder the client loads (docs/FIELDS.md §6.1); only a name the client's validator accepts.
      ...(WORLD_FOLDER.test(worldExport) ? { world: worldExport } : {}),
      // Wave 10 (docs/SCREENS.md §9, lane SCR-P): the running clock anchor and the current weather, so the character
      // screens' sky matches the world's. Feeds both GET /api/servers and the lobby's `welcome` (a snapshot, never
      // the `worldClock` / `weather` messages, which stay world-only).
      clock: gameplay.clock.state,
      weather: gameplay.weather.sync(Date.now()),
      // Admin panel switch (docs/ADMIN.md): the login screen hides Register while it is closed.
      registration: config.registrationOpen === false ? 'closed' : 'open',
    }),
    persist(players, now = Date.now()) {
      if (players.length === 0) return
      store.saveCharacters(
        players.map((p) => {
          const at = world.livePoint(p, now)
          // Play the Boss (docs/PLAY_THE_BOSS.md §5.3): the time since the last save counts as played (the enter-world
          // save starts the clock; a clock step or a stall never credits more than two save intervals).
          const last = playedAt.get(p)
          playedAt.set(p, now)
          const playedMs = last === undefined ? 0 : Math.max(0, Math.min(now - last, config.saveIntervalS * 2000 + 60_000))
          return {
            id: p.characterId, x: at.x, y: at.y, z: at.z, yaw: p.yaw, world: config.world, lastPlayed: now, hp: p.hp, mp: p.mp, dead: p.dead,
            surface: nav.surfaceKey(at.surface), playedMs,
          }
        }),
      )
    },
    refreshRoles(force = false) {
      const version = store.dataVersion()
      if (!force && version === dataVersion) return
      dataVersion = version
      for (const c of [...sockets.values()]) c.applyRole(store.accountRole(c.accountId))
    },
  }
  let dataVersion = store.dataVersion()
  // Play the Boss (docs/PLAY_THE_BOSS.md §3.9): the game socket's IP of a player (the same-IP associates).
  const ipOf = (p: Player): string | null => {
    for (const c of sockets.values()) if (c.player === p) return c.ip
    return null
  }
  gameplay.pilot?.connect({ ipOf })
  // Siege of Jangan layer 5 (docs/SIEGE.md §8.6): the same-IP associates of wall-breakers.
  gameplay.law.connect({ ipOf })
  const adminApi = new AdminApi(ctx, adminStore, settings, startedAt)

  const loginFailures = new FailureLimiter(5, 15 * 60_000)
  const ipLoginFailures = new FailureLimiter(50, 15 * 60_000)
  const registrations = new FailureLimiter(config.registerPerHour, 3600_000)

  const clientIp = (req: IncomingMessage): string => {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for']
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
      if (first) return first
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  const issueSession = (accountId: number): ApiLoginResponse => {
    const token = newToken()
    const expiresAt = Date.now() + SESSION_TTL_MS
    store.createSession(hashToken(token), accountId, expiresAt)
    store.trimSessions(accountId, MAX_SESSIONS_PER_ACCOUNT)
    return { token, expiresAt }
  }

  /** The account behind the request's Bearer token, or a 401. */
  const bearerAccount = (req: IncomingMessage) => {
    const m = /^Bearer\s+(\S{1,256})$/.exec(req.headers.authorization ?? '')
    const account = m ? store.sessionAccount(hashToken(m[1])) : undefined
    if (!account) throw new HttpError(401, 'unauthorized', 'missing or expired bearer token')
    return account
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET'
    if (config.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigin)
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      // PUT and DELETE: the GM quest editor (/api/gm/quests/:id, docs/QUESTS.md §5.4).
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      if (method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
    }
    const ip = clientIp(req)
    if (path === '/api/servers' && method === 'GET') return sendJson(res, 200, [ctx.serverInfo()])
    if (path === '/api/register' && method === 'POST') {
      // The admin panel's switch (docs/ADMIN.md): authoritative here, whatever the client shows.
      if (config.registrationOpen === false) throw new HttpError(403, 'forbidden', 'Registration is closed on this server.')
      if (registrations.blocked(ip)) throw new HttpError(429, 'rate_limited', 'too many registrations, try later')
      const { username, password } = credentials(await readJson(req))
      if (!ACCOUNT_NAME.test(username)) throw new HttpError(400, 'bad_request', 'username must be 3-16 letters, digits or _')
      checkPasswordRule(password)
      registrations.fail(ip)
      // Cheap pre-check so a taken name does not cost a hash (the insert below still decides races).
      if (store.accountByName(username)) throw new HttpError(409, 'name_taken', 'username is taken')
      const id = store.createAccount(username, await hashPassword(password))
      if (id === null) throw new HttpError(409, 'name_taken', 'username is taken')
      config.log(`account ${username} registered from ${ip}`)
      return sendJson(res, 201, issueSession(id))
    }
    if (path === '/api/login' && method === 'POST') {
      const { username, password } = credentials(await readJson(req))
      const key = `${ip}|${username.toLowerCase()}`
      if (loginFailures.blocked(key) || ipLoginFailures.blocked(ip)) {
        throw new HttpError(429, 'rate_limited', 'too many failed logins, try again later')
      }
      // Count the attempt before the slow hash, so a burst of parallel requests cannot all pass the
      // check above before any failure is recorded. A success takes it back.
      loginFailures.fail(key)
      ipLoginFailures.fail(ip)
      const valid = ACCOUNT_NAME.test(username) && codePointLength(password) <= PASSWORD_MAX_LENGTH
      const account = valid ? store.accountByName(username) : undefined
      let ok: boolean
      try {
        ok = await verifyPassword(valid ? password : '', account?.password_hash ?? null)
      } catch (e) {
        loginFailures.forgive(key)
        ipLoginFailures.forgive(ip)
        throw e
      }
      if (!ok || !account) throw new HttpError(401, 'unauthorized', 'wrong username or password')
      loginFailures.reset(key)
      ipLoginFailures.forgive(ip)
      // Admin panel bans (docs/ADMIN.md): the right password of a banned account gets the reason, no session.
      const ban = adminStore.banOf(account.id)
      if (ban) throw new HttpError(403, 'forbidden', `This account is banned${ban.reason ? `: ${ban.reason}` : '.'}`)
      store.touchLogin(account.id)
      return sendJson(res, 200, issueSession(account.id))
    }
    if (path === '/api/logout' && method === 'POST') {
      const auth = req.headers.authorization ?? ''
      const m = /^Bearer\s+(\S{1,256})$/.exec(auth)
      if (!m) throw new HttpError(401, 'unauthorized', 'missing bearer token')
      const tokenHash = hashToken(m[1])
      store.deleteSession(tokenHash)
      // A revoked token must not keep a live game socket.
      for (const c of [...sockets.values()]) {
        if (c.tokenHash === tokenHash) {
          c.error('unauthorized', 'logged out')
          c.close(CLOSE_CODE.unauthorized, 'logged out')
        }
      }
      res.writeHead(204)
      res.end()
      return
    }
    // The merged quest catalog for any logged-in account (docs/QUESTS.md §5.4; lane QS-S).
    if (path === '/api/quests' && method === 'GET') {
      const m = /^Bearer\s+(\S{1,256})$/.exec(req.headers.authorization ?? '')
      if (!m || !store.sessionAccount(hashToken(m[1]))) throw new HttpError(401, 'unauthorized', 'missing or expired bearer token')
      const catalog = gameplay.quests.book.catalog()
      const etag = `"q${catalog.rev}"`
      res.setHeader('ETag', etag)
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304)
        res.end()
        return
      }
      return sendJson(res, 200, catalog)
    }
    // "What's new" (docs/CHANGELOG_WINDOW.md): the entries for any logged-in account, its seen mark, and the images
    // (public, like the game's own files). The admin panel writes them (/api/admin/news).
    if (path.startsWith('/api/news/img/') && (method === 'GET' || method === 'HEAD')) {
      const name = path.slice('/api/news/img/'.length)
      if (NEWS_IMAGE_NAME.test(name)) {
        for (const root of ctx.news.imageDirs) if (await serveFile(req, res, root, `/${name}`, { cache: 'public, max-age=86400' })) return
      }
      throw new HttpError(404, 'not_found', 'no such image')
    }
    if (path === '/api/news' && method === 'GET') {
      const account = bearerAccount(req)
      const body: ApiNewsList = { entries: ctx.news.published(), unseen: ctx.news.unseenFor(store, account.id).map((e) => e.id) }
      return sendJson(res, 200, body)
    }
    if (path === '/api/news/seen' && method === 'POST') {
      const account = bearerAccount(req)
      const o = (await readJson(req)) as Partial<ApiNewsSeenRequest> | null
      if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some((k) => k !== 'id') || typeof o.id !== 'string' || !NEWS_ID.test(o.id)) {
        throw new HttpError(400, 'bad_request', 'body must be {"id": "<entry id>"}')
      }
      const unseen = ctx.news.markSeen(store, account.id, o.id)
      if (!unseen) throw new HttpError(404, 'not_found', 'no such entry')
      const body: ApiNewsSeenResponse = { unseen: unseen.map((e) => e.id) }
      return sendJson(res, 200, body)
    }
    // The GM quest editor (docs/QUESTS.md §5.4; lane ED-S): Bearer + editor role, 32 KB bodies, its own rate limit.
    if (path.startsWith(GM_API_PREFIX)) {
      const r = await handleGmApi(ctx, { method, path, authorization: req.headers.authorization, body: (limit) => readJson(req, limit) })
      return sendJson(res, r.status, r.body)
    }
    throw new HttpError(404, 'not_found', 'no such endpoint')
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawPath = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'
    try {
      // The admin panel's API (docs/ADMIN.md §3, §4): same-origin only and never any CORS headers (OPTIONS is a 404).
      if (rawPath === '/api/admin' || rawPath.startsWith('/api/admin/')) {
        if (!originAllowed(req, config.allowedOrigins)) throw new HttpError(403, 'unauthorized', 'origin not allowed')
        if (config.adminPanel === false) throw new HttpError(404, 'not_found', 'no such endpoint')
        // A panel served elsewhere (its server profiles, docs/ADMIN.md §2.1) may call this server only from an origin listed in
        // ALLOWED_ORIGINS (or a dev origin): those get CORS for Bearer requests, never cookies; same-origin needs none.
        const origin = req.headers.origin
        const cors = typeof origin === 'string' && config.allowedOrigins.includes(origin)
        if (cors) {
          res.setHeader('Access-Control-Allow-Origin', origin)
          res.setHeader('Vary', 'Origin')
        }
        if (method === 'OPTIONS') {
          if (!cors) throw new HttpError(404, 'not_found', 'no such endpoint')
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' })
          res.end()
          return
        }
        const r = await adminApi.handle({
          method,
          path: rawPath,
          query: new URL(req.url ?? '/', 'http://x').searchParams,
          authorization: req.headers.authorization,
          ip: clientIp(req),
          body: (limit) => readJson(req, limit, true),
        })
        if (r.status === 204 || r.body === undefined) {
          res.writeHead(r.status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
          res.end()
          return
        }
        return sendJson(res, r.status, r.body)
      }
      if (rawPath.startsWith('/api/')) {
        if (!originAllowed(req, config.allowedOrigins)) throw new HttpError(403, 'unauthorized', 'origin not allowed')
        return await api(req, res, rawPath)
      }
      // The admin panel's files (apps/admin/dist; docs/ADMIN.md §2), whether or not the game itself is served.
      if (config.adminPanel !== false && (rawPath === '/admin' || rawPath.startsWith('/admin/')) && (method === 'GET' || method === 'HEAD')) {
        if (rawPath === '/admin') {
          res.writeHead(301, { Location: '/admin/' })
          res.end()
          return
        }
        const dist = config.adminDist ?? join(dirname(config.gameDist), '..', 'admin', 'dist')
        res.setHeader('Content-Security-Policy', ADMIN_CSP)
        res.setHeader('Referrer-Policy', 'no-referrer')
        const sub = rawPath.slice('/admin'.length)
        // Item and monster rank icons for the panel (admin/icons.ts): converted PNGs only, from OUT_DIR, else OUT_OPT_DIR.
        if (sub.startsWith('/out/')) {
          const rel = sub.slice('/out/'.length)
          if (ADMIN_ICON_PATH.test(rel)) for (const root of iconRoots(ctx)) if (await serveFile(req, res, root, `/${rel}`, { cache: 'public, max-age=86400' })) return
          throw new HttpError(404, 'not_found', 'no such icon')
        }
        const hashed = sub.startsWith('/assets/')
        if (await serveFile(req, res, dist, sub, { index: true, cache: hashed ? 'public, max-age=31536000, immutable' : 'no-cache' })) return
        const last = sub.split('/').pop() ?? ''
        if (!last.includes('.') && !sub.includes('%') && !sub.includes('..')) {
          if (await serveFile(req, res, dist, '/index.html', { cache: 'no-cache' })) return
        }
        throw new HttpError(404, 'not_found', 'the admin panel is not built (pnpm --filter @sro/admin build)')
      }
      if (rawPath === '/health') {
        return sendJson(res, 200, {
          ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), online: world.online, schema: store.schemaVersion,
          nav: nav.kind, mobs: world.mobs.size, worstTickMs: Math.round(world.worstTickMs * 100) / 100,
        })
      }
      if (config.serveStatic && (method === 'GET' || method === 'HEAD')) {
        // items.json with the admin item overrides merged in, so the client shows what the server uses (docs/ADMIN.md §6).
        if (rawPath === '/out/data/items.json' || rawPath === '/out-opt/data/items.json') {
          const merged = mergedItemsJson(ctx)
          if (merged) return sendMergedJson(req, res, merged)
        }
        if (rawPath === '/out-opt' || rawPath.startsWith('/out-opt/')) {
          if (await serveFile(req, res, outOptDir, rawPath.slice(8))) return
          throw new HttpError(404, 'not_found', 'not found')
        }
        if (rawPath === '/out' || rawPath.startsWith('/out/')) {
          if (await serveFile(req, res, config.outDir, rawPath.slice(4))) return
          throw new HttpError(404, 'not_found', 'not found')
        }
        const hashed = rawPath.startsWith('/assets/')
        if (await serveFile(req, res, config.gameDist, rawPath, { index: true, cache: hashed ? 'public, max-age=31536000, immutable' : 'no-cache' })) return
        // SPA fallback for extension-less routes (never for paths that look like files or escape attempts).
        const last = rawPath.split('/').pop() ?? ''
        if (!last.includes('.') && !rawPath.includes('%') && !rawPath.includes('..')) {
          if (await serveFile(req, res, config.gameDist, '/index.html')) return
        }
      }
      throw new HttpError(404, 'not_found', 'not found')
    } catch (e) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (e instanceof HttpError) {
        // The rest of an oversized body is not worth reading: drop the connection after replying.
        if (e.status === 413) res.setHeader('Connection', 'close')
        return sendError(res, e.status, e.code, e.message)
      }
      if (e instanceof HashBusyError) {
        res.setHeader('Retry-After', '2')
        return sendError(res, 503, 'rate_limited', 'server busy, try again in a moment')
      }
      config.log(`http ${method} ${rawPath}: ${(e as Error).stack ?? e}`)
      sendError(res, 500, 'server_error', 'internal error')
    }
  }

  const http = createServer((req, res) => {
    void handle(req, res)
  })
  http.headersTimeout = 10_000
  http.requestTimeout = 30_000

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false })
  const alive = new WeakSet<WebSocket>()
  const socketsPerIp = new Map<string, number>()
  http.on('upgrade', (req, socket, head) => {
    // After 'upgrade' the socket has no error listener; a reset while we reject it must not crash the process.
    socket.on('error', () => socket.destroy())
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    if (!originAllowed(req, config.allowedOrigins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const ip = clientIp(req)
    if ((socketsPerIp.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      socketsPerIp.set(ip, (socketsPerIp.get(ip) ?? 0) + 1)
      ws.once('close', () => {
        const n = (socketsPerIp.get(ip) ?? 1) - 1
        if (n <= 0) socketsPerIp.delete(ip)
        else socketsPerIp.set(ip, n)
      })
      alive.add(ws)
      ws.on('pong', () => alive.add(ws))
      new Connection(ws, ctx, ip)
    })
  })

  config.log(`navigation: ${nav.source}`)
  config.log(gameplay.start())
  const unplaced = unplacedNestsLine(gameplay, data, setup)
  if (unplaced) config.log(unplaced)
  world.start()
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate()
        continue
      }
      alive.delete(ws)
      ws.ping()
    }
  }, HEARTBEAT_MS)
  const saver = setInterval(() => {
    try {
      ctx.persist([...world.players.values()])
    } catch (e) {
      config.log(`periodic save failed: ${(e as Error).message}`)
    }
  }, config.saveIntervalS * 1000)
  const purger = setInterval(() => {
    store.purgeSessions()
    adminStore.purgeSessions(Date.now(), ADMIN_IDLE_MS)
  }, 3600_000)
  const rolePoll = setInterval(() => {
    try {
      ctx.refreshRoles()
    } catch (e) {
      config.log(`role refresh failed: ${(e as Error).message}`)
    }
  }, config.rolePollMs)
  for (const t of [heartbeat, saver, purger, rolePoll]) t.unref()

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(config.port, config.host, () => {
      http.off('error', reject)
      resolve()
    })
  })
  const port = (http.address() as AddressInfo).port
  const modelCount = models.list().length
  config.log(`${modelCount} playable character models from ${models.source}`)
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host
  config.log(
    `listening on http://${host}:${port} (world ${config.world}${worldExport !== config.world ? ` from export ${worldExport}` : ''}, spawn ${setup.spawn.x.toFixed(1)},${setup.spawn.z.toFixed(1)} from ${setup.spawnSource}, static ${config.serveStatic ? 'on' : 'off'})`,
  )

  let closing: Promise<void> | null = null
  return {
    ctx,
    http,
    port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close() {
      closing ??= (async () => {
        clearInterval(heartbeat)
        clearInterval(saver)
        clearInterval(purger)
        clearInterval(rolePoll)
        world.stop()
        for (const c of [...sockets.values()]) {
          c.send({ t: 'chat', channel: 'system', text: 'The server is shutting down.' })
          c.close(CLOSE_CODE.shutdown, 'server shutting down')
        }
        ctx.persist([...world.players.values()])
        // docs/SIEGE.md §5.3: the walls' unsaved integrity
        gameplay.walls.flush()
        for (const ws of wss.clients) ws.terminate()
        wss.close()
        await new Promise<void>((resolve) => {
          http.close(() => resolve())
          http.closeAllConnections()
        })
        store.close()
      })()
      return closing
    },
  }
}
