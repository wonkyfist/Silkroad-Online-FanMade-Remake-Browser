import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import {
  ACCOUNT_NAME,
  CLOSE_CODE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  WORLD_FOLDER,
  codePointLength,
  type ApiError,
  type ApiLoginResponse,
  type ErrorCode,
  type ServerInfo,
} from '@sro/shared'
import { WebSocketServer, type WebSocket } from 'ws'
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
import { originAllowed } from './origin.ts'
import { serveFile } from './static.ts'
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

function sendError(res: ServerResponse, status: number, code: ErrorCode, message: string): void {
  const body: ApiError = { error: code, message }
  sendJson(res, status, body)
}

/** Reads a JSON body of at most `limit` bytes (default 4 KB; the GM editor routes pass GM_API_MAX_BODY_BYTES, 32 KB). */
async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new HttpError(413, 'bad_request', 'body too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'bad_request', 'body too large')
    chunks.push(chunk as Buffer)
  }
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
  const data = GameData.load(config.outDir)
  for (const line of data.summary()) config.log(line)
  // GM content overrides (DATA_DIR/content/{nests,npcs}.override.json) over the export, before anything is placed (lane ED-S).
  // Repo overrides (CONTENT_DIR/{nests,npcs}.override.json) first: they are part of the content the GM files layer over.
  layerRepoOverrides(data, config.contentDir, config.world, config.log)
  layerContentOverrides(data, config.dataDir, config.world, config.log)
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
    }),
    persist(players, now = Date.now()) {
      if (players.length === 0) return
      store.saveCharacters(
        players.map((p) => {
          const at = world.livePoint(p, now)
          return {
            id: p.characterId, x: at.x, y: at.y, z: at.z, yaw: p.yaw, world: config.world, lastPlayed: now, hp: p.hp, mp: p.mp, dead: p.dead,
            surface: nav.surfaceKey(at.surface),
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
      if (rawPath.startsWith('/api/')) {
        if (!originAllowed(req, config.allowedOrigins)) throw new HttpError(403, 'unauthorized', 'origin not allowed')
        return await api(req, res, rawPath)
      }
      if (rawPath === '/health') {
        return sendJson(res, 200, {
          ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), online: world.online, schema: store.schemaVersion,
          nav: nav.kind, mobs: world.mobs.size, worstTickMs: Math.round(world.worstTickMs * 100) / 100,
        })
      }
      if (config.serveStatic && (method === 'GET' || method === 'HEAD')) {
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
  const purger = setInterval(() => store.purgeSessions(), 3600_000)
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
