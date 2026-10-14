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
import { registerAntiAltAdmin } from './antialt/admin.ts'
import { AntiAlt, type Refusal } from './antialt/guard.ts'
import { loadLists } from './antialt/lists.ts'
import { parseCidrList, resolveClientIp, type ProxyTrust } from './antialt/net.ts'
import { CachedLookup, providerFromEnv, turnstileFromEnv } from './antialt/providers.ts'
import { FailureLimiter, HashBusyError, MAX_SESSIONS_PER_ACCOUNT, SESSION_TTL_MS, hashPassword, hashToken, newToken, verifyPassword } from './auth.ts'
import { REPO_ROOT, type ServerConfig } from './config.ts'
import { Connection, MAX_BUFFERED, wsConnection } from './connection.ts'
import { GatewayHub } from './gateway/hub.ts'
import { AoiPool } from './aoi/pool.ts'
import { CharacterModels, regionAt, resolveWorld, withAuthoredPlaces, withTownSpawn, type WorldSetup } from './content.ts'
import { checkPlaces } from './places.ts'
import { openStore, type Store } from './db.ts'
import { layerContentOverrides, layerRepoOverrides } from './editors/overrides.ts'
import { GM_API_PREFIX, handleGmApi } from './editors/quest-api.ts'
import { Gameplay } from './gameplay.ts'
import { claimWriterLock, serveInbox } from './services/account.ts'
import { applyRoleChange } from './cli/gm.ts'
import { holdStats } from './services/hold.ts'
import { routeChat } from './chat.ts'
import { GameData } from './gamedata.ts'
import { FlatNav, MeshNav, type NavProvider } from './nav.ts'
import { CLIMB_SP_VERSION, applyClimbContent, convertClimbCharacters, remapClimbNests, topUpClimbSp } from './climb.ts'
import { NewsStore } from './news.ts'
import { originAllowed } from './origin.ts'
import { NetStats, isLoopback } from './netstats.ts'
import { BodyHolds } from './resume.ts'
import { acceptedEncodings, serveFile } from './static.ts'
import type { Updater } from './updater/updater.ts'
import { World, type Player } from './world.ts'
import { PerformanceObserver } from 'node:perf_hooks'
import { memoryStage, type MemoryStage } from './netstats.ts'
import { PH, type PhaseTimers } from './phases.ts'

/** Hard WebSocket frame cap: larger frames close the socket (1009). Smaller-but-too-big get bad_request. */
export const WS_MAX_PAYLOAD = 4096
const MAX_BODY_BYTES = 4096
export const HEARTBEAT_MS = 30_000
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
  /** Account bans (the admin panel's table; GM ban/unban in gm-tools.ts). Absent in bare test contexts. */
  bans?: { ban(accountId: number, reason: string, by: string): unknown; unban(accountId: number): boolean }
  /** Registration & anti-alt (docs/ANTI_ALT.md): limits, detection, allowlist, linked accounts. Absent in bare test contexts. */
  antiAlt?: AntiAlt
  /** Message, byte, tick and disconnect counters (netstats.ts; GET /netstats with NET_STATS=1, loopback only). */
  net: NetStats
  /** Characters of dropped connections held in the world for a reconnect (resume.ts). */
  holds: BodyHolds
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
  /** docs/SERVER_ARCHITECTURE.md P1a: the gateway processes owning the client sockets (null: GATEWAYS=0, in this process). */
  gateways?: GatewayHub | null
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

/** The optional anti-alt fields of register / login (docs/ANTI_ALT.md §5); `captcha` only on register. */
const SIGNAL_FIELDS = new Set(['device', 'fp', 'captcha'])

function credentials(body: unknown): { username: string; password: string; device?: string; fp?: string; captcha?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'body must be an object')
  const o = body as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.some((k) => k !== 'username' && k !== 'password' && !SIGNAL_FIELDS.has(k))) throw new HttpError(400, 'bad_request', 'unexpected field')
  if (typeof o.username !== 'string' || typeof o.password !== 'string') {
    throw new HttpError(400, 'bad_request', 'username and password must be strings')
  }
  // a malformed signal is dropped (the guard treats it as absent), never an error: an old or odd browser still registers
  const opt = (k: string, max: number) => (typeof o[k] === 'string' && (o[k] as string).length <= max ? (o[k] as string) : undefined)
  return { username: o.username, password: o.password, device: opt('device', 64), fp: opt('fp', 64), captcha: opt('captcha', 2048) }
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
 * town spawn's walkable component). Inside the world bounds they are unreachable on foot from town (the Western
 * China side's, before it went under the sea and content/nests.override.json removed them; docs/COAST.md §4.1); the
 * rest lie beyond the export.
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

/** One startup stage's memory; with `node --expose-gc` collected first, so the split is not inflated by garbage. */
function memorySample(stage: string): MemoryStage {
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc === 'function') {
    gc()
    gc()
  }
  return memoryStage(stage)
}

/** "memory by stage: content +312 MB heap ..." (each stage against the one before it). */
function memoryLine(stages: MemoryStage[]): string {
  const d = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v)}`
  const parts = stages.slice(1).map((s, i) => `${s.stage} ${d(s.heapMb - stages[i]!.heapMb)} heap / ${d(s.externalMb - stages[i]!.externalMb)} external / ${d(s.rssMb - stages[i]!.rssMb)} rss`)
  const last = stages[stages.length - 1]!
  return `memory by startup stage (MB): ${parts.join(', ')}; now ${Math.round(last.rssMb)} rss, ${Math.round(last.heapMb)} heap, ${Math.round(last.externalMb)} external${typeof (globalThis as { gc?: unknown }).gc === 'function' ? '' : ' (no --expose-gc: rough)'}`
}

/** The clock and weather of the world service (P2: svc:world), for serverInfo. */
function worldNow(g: Gameplay): { clock: ReturnType<Gameplay['worldSync']>['clock']; weather: ReturnType<Gameplay['worldSync']>['weather'] } {
  const w = g.worldSync(Date.now())
  return { clock: w.clock, weather: w.weather }
}

/** GC pauses into the `gc` tick phase (perf_hooks 'gc' entries). */
function watchGc(timers: PhaseTimers): PerformanceObserver | null {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) timers.add(PH.gc, e.duration)
    })
    obs.observe({ entryTypes: ['gc'] })
    return obs
  } catch {
    return null
  }
}

export async function startServer(config: ServerConfig): Promise<GameServer> {
  // docs/SERVER_ARCHITECTURE.md F6 (P0): the memory split by startup stage (content, navmesh, modules, world)
  const memory = [memorySample('start')]
  // docs/SERVER_ARCHITECTURE.md §3.8 (P2, DB_WRITER): the database in memory, one writer thread for the file
  const wantWriter = config.dbWriter ?? /^(1|on|true|yes)$/i.test(process.env.SRO_TEST_DB_WRITER ?? '')
  const store = openStore(config.dataDir, { writer: wantWriter ? { log: config.log, onFatal: (why) => config.log(`DB WRITER DOWN: ${why}; the game keeps running from memory and retries`) } : false })
  // the gm CLI sends role changes to this server's inbox while it owns the file (services/account.ts)
  const releaseWriterLock = store.writer ? claimWriterLock(config.dataDir) : null
  if (store.writer) config.log(`db writer: DATA_DIR/game.db in memory (${store.writerStats()?.memDbMb ?? 0} MB), one writer thread with group commit (DB_WRITER)`)
  store.purgeSessions()
  // Admin panel (docs/ADMIN.md §5): its tables, and the settings saved in it applied before any module reads the config.
  const adminStore = openAdminStore(store, join(config.dataDir, 'game.db'))
  // docs/ANTI_ALT.md: before the settings load, so the old "Registrations per IP per hour" row moves into its policy first
  const lookupProvider = providerFromEnv(process.env)
  const antiAlt = new AntiAlt(store.db, {
    lists: loadLists(config.contentDir ?? join(REPO_ROOT, 'content'), config.log),
    log: config.log,
    lookup: lookupProvider ? new CachedLookup(lookupProvider, config.log) : null,
    captcha: turnstileFromEnv(process.env),
    registerPerHour: config.registerPerHour,
  })
  antiAlt.purge()
  registerAntiAltAdmin()
  const settings = SettingsState.load(config, adminStore)
  const data = GameData.load(config.outDir)
  for (const line of data.summary()) config.log(line)
  // The Climb (docs/CLIMB.md §20 L1): derived monsters, the degree-3 squeeze and the cap-25 curve join the export first,
  // so the repo overrides' `mob` patches can name derived codes; the area remap follows them (climb.ts).
  const climb = config.climb ? applyClimbContent(data, config.contentDir, config.log) : null
  // GM content overrides (DATA_DIR/content/{nests,npcs}.override.json) over the export, before anything is placed (lane ED-S).
  // Repo overrides (CONTENT_DIR/{nests,npcs}.override.json) first: they are part of the content the GM files layer over.
  layerRepoOverrides(data, config.contentDir, config.world, config.log)
  if (climb) {
    remapClimbNests(data, config.log)
    // Saved characters move to the cap-25 curve once (docs/CLIMB.md §9.3a; migration 21), and new ones start on it.
    if (climb.levels > 0) {
      convertClimbCharacters(store.db, (l) => climb.oldNeed[l - 1] ?? 0, (l) => data.levels[l - 1]?.exp ?? 0, config.log)
      // and once more for the cap-25 SP rate (CLIMB §5.3): the SP the old 400 SP-EXP per SP held back, then new rows skip it
      topUpClimbSp(store.db, (l) => data.levels[l - 1]?.exp ?? 0, config.log)
      store.setNewCharacterCurve(CLIMB_SP_VERSION)
    }
  }
  config.log(`level cap ${config.levelCap}${climb ? ' (the Climb on)' : config.climb === false ? ' (the Climb off: CLIMB=off)' : ''}`)
  layerContentOverrides(data, config.dataDir, config.world, config.log)
  // Admin item and drop overrides (DATA_DIR/content/{items,drops}.override.json; docs/ADMIN.md §5).
  layerAdminContent(data, config.dataDir, config.outDir, config.log)
  memory.push(memorySample('content'))
  const worldExport = config.worldExport ?? config.world
  const base = withTownSpawn(resolveWorld(config.outDir, worldExport, config.spawn, config.world), config.world, data.town(config.world))
  // GM teleport places: the manifest's, then CONTENT_DIR/places.json (docs/PLAYTEST.md "Teleport places").
  const setup = withAuthoredPlaces(base, config.contentDir, config.world, config.log)
  const nav = loadNav(config, setup.bounds)
  memory.push(memorySample('navmesh'))
  const world = new World(config.world, config.moveSpeed, config.tickHz, setup.bounds, nav)
  world.viewRange = config.viewRange
  if (config.maxVisiblePlayers !== undefined) world.maxVisiblePlayers = config.maxVisiblePlayers
  // docs/SERVER_ARCHITECTURE.md §4 P0: each change behind its own switch (absent = on)
  const switches = {
    tickTimers: config.tickTimers !== false,
    mobGrid: config.mobGrid !== false,
    watchers: config.watchers !== false,
    encodeOnce: config.encodeOnce !== false,
    aoiFast: config.aoiFast !== false,
  }
  world.mobGrid = switches.mobGrid
  world.useWatchers = switches.watchers
  world.encodeOnce = switches.encodeOnce
  world.aoiFast = switches.aoiFast
  // docs/SERVER_ARCHITECTURE.md P1b: the interest pass's per-viewer work on AOI_JOBS worker threads (needs AOI_FAST)
  const aoiPool = (config.aoiJobs ?? 0) > 0 && switches.aoiFast ? new AoiPool(config.aoiJobs!, config.log) : null
  world.aoiJobs = aoiPool
  // Only places a GM can stand on stay in the tp list (the rest are logged and skipped).
  setup.places = checkPlaces(setup.places, world, nav, [config.world.toLowerCase(), 'spawn'], config.log)
  let tickErrors = 0
  world.onError = (e) => {
    // Log the first few in full, then every 100th (a persistent fault must not flood the log at the tick rate).
    if (++tickErrors <= 5 || tickErrors % 100 === 0) config.log(`world tick failed (${tickErrors}): ${(e as Error).stack ?? e}`)
  }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: config.rng })
  memory.push(memorySample('modules'))
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
    bans: adminStore,
    antiAlt,
    net: new NetStats(config.tickHz, switches.tickTimers),
    holds: new BodyHolds(() => (config.resumeGraceS ?? 0) * 1000, config.log),
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
      ...worldNow(gameplay),
      // Admin panel switch (docs/ADMIN.md): the login screen hides Register while it is closed.
      registration: config.registrationOpen === false ? 'closed' : 'open',
      // docs/ANTI_ALT.md §6: the robot check's site key while it is on and configured
      ...(antiAlt.captchaSiteKey() ? { captchaSiteKey: antiAlt.captchaSiteKey()! } : {}),
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
      // P2: role changes the gm CLI handed to this server (DB_WRITER: the file is this server's alone)
      if (store.writer && serveInbox(config.dataDir, (c) => applyRoleChange(store, c), config.log) > 0) force = true
      const version = store.dataVersion()
      if (!force && version === dataVersion) return
      dataVersion = version
      for (const c of [...sockets.values()]) c.applyRole(store.accountRole(c.accountId))
    },
  }
  let dataVersion = store.dataVersion()
  // docs/SERVER_ARCHITECTURE.md §3.11 (P0): the tick timers, the outbound backlog, the switches in force
  world.timers = ctx.net.phases
  ctx.net.switches = switches
  ctx.net.probe = () => {
    let bufferedBytes = 0
    let maxBufferedBytes = 0
    for (const c of sockets.values()) {
      const b = c.buffered
      bufferedBytes += b
      if (b > maxBufferedBytes) maxBufferedBytes = b
    }
    return { sockets: sockets.size, bufferedBytes, maxBufferedBytes }
  }
  const gcWatch = switches.tickTimers ? watchGc(ctx.net.phases) : null
  // Play the Boss (docs/PLAY_THE_BOSS.md §3.9): the game socket's IP of a player (the same-IP associates).
  const ipOf = (p: Player): string | null => {
    for (const c of sockets.values()) if (c.player === p) return c.ip
    return null
  }
  gameplay.pilot?.connect({ ipOf })
  // docs/SERVER_ARCHITECTURE.md §3.6 (P2, SVC_BUS): the account and chat services find a connection by its account
  // (the directory: one socket per account)
  const services = gameplay.services
  if (services) {
    services.on('account', 'lobby', (b) => {
      const { account, msg } = b as { account: number; msg: Parameters<Connection['lobby']>[0] }
      sockets.get(account)?.lobby(msg)
    })
    services.on('chat', 'route', (b) => {
      const { account, msg, text } = b as { account: number; msg: Parameters<typeof routeChat>[1]; text: string }
      const c = sockets.get(account)
      return c ? routeChat(c, msg, text) : false
    })
  }
  // Siege of Jangan layer 5 (docs/SIEGE.md §8.6): the same-IP associates of wall-breakers.
  gameplay.law.connect({ ipOf })
  const adminApi = new AdminApi(ctx, adminStore, settings, startedAt)

  const loginFailures = new FailureLimiter(5, 15 * 60_000)
  const ipLoginFailures = new FailureLimiter(50, 15 * 60_000)

  // docs/ANTI_ALT.md §3.2: the forwarding header only from the trusted proxies (TRUST_PROXY + TRUSTED_PROXIES)
  const proxyTrust: ProxyTrust | null = (() => {
    if (!config.trustProxy) return null
    const { ranges, bad } = parseCidrList(config.trustedProxies ?? '127.0.0.1/32, ::1/128')
    if (bad.length) config.log(`TRUSTED_PROXIES: ignored ${bad.join(', ')} (not CIDRs)`)
    return { trusted: ranges, header: config.clientIpHeader ?? 'x-forwarded-for' }
  })()
  const clientIp = (req: IncomingMessage): string => resolveClientIp(req.socket.remoteAddress, req.headers, proxyTrust)
  const refused = (r: Refusal): never => {
    throw new HttpError(r.status, r.code, r.message)
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
      const { username, password, device, fp, captcha } = credentials(await readJson(req))
      if (!ACCOUNT_NAME.test(username)) throw new HttpError(400, 'bad_request', 'username must be 3-16 letters, digits or _')
      checkPasswordRule(password)
      // Cheap pre-check so a taken name does not cost a hash or a limit slot (the insert below still decides races).
      if (store.accountByName(username)) throw new HttpError(409, 'name_taken', 'username is taken')
      // docs/ANTI_ALT.md: the robot check, VPN/hosting detection and the account limits; a pass reserves a slot
      const verdict = await antiAlt.checkRegister({ ip, device, fp, captcha, account: username })
      if (!('ticket' in verdict)) return refused(verdict)
      let id: number | null = null
      try {
        id = store.createAccount(username, await hashPassword(password))
      } finally {
        if (id === null) antiAlt.cancelRegister(verdict.ticket)
      }
      if (id === null) throw new HttpError(409, 'name_taken', 'username is taken')
      antiAlt.confirmRegister(verdict.ticket, id)
      config.log(`account ${username} registered from ${ip}`)
      return sendJson(res, 201, issueSession(id))
    }
    if (path === '/api/login' && method === 'POST') {
      const { username, password, device, fp } = credentials(await readJson(req))
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
      // docs/ANTI_ALT.md §4: a detection set to block_login refuses players (never staff); the login is recorded
      if (account.role === 'player') {
        const refusal = await antiAlt.checkLogin(account.id, { ip, device, fp, account: account.username })
        if (refusal) refused(refusal)
      } else antiAlt.recordLogin(account.id, { ip, device, fp })
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
      // The load test (src/cli/netload.ts): counters for a local run only, never on a public port.
      if (rawPath === '/netstats' && process.env.NET_STATS === '1' && isLoopback(req.socket.remoteAddress)) {
        if ((req.url ?? '').includes('reset=1')) {
          ctx.net.reset()
          aoiPool?.reset()
          store.writer?.resetStats()
          gameplay.economy.resetStats()
          gameplay.services?.resetStats()
        }
        // the load test ends its server this way on Windows (no SIGINT there), so a --cpu-prof profile gets written
        if ((req.url ?? '').includes('exit=1')) setTimeout(() => process.exit(0), 200).unref()
        return sendJson(res, 200, ctx.net.snapshot())
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

  // docs/SERVER_ARCHITECTURE.md P1a: the client sockets in GATEWAYS gateway processes (0: in this process, below)
  const conns = new Map<number, Connection>()
  let hub: GatewayHub | null = null
  const socketsPerIp = new Map<string, number>()
  const ipDone = (ip: string): void => {
    const n = (socketsPerIp.get(ip) ?? 1) - 1
    if (n <= 0) socketsPerIp.delete(ip)
    else socketsPerIp.set(ip, n)
  }
  if ((config.gateways ?? 0) > 0) {
    hub = new GatewayHub(
      config.gateways!,
      { maxPayload: WS_MAX_PAYLOAD, heartbeatMs: HEARTBEAT_MS, maxBuffered: MAX_BUFFERED },
      {
        opened(id, sock, ip) {
          ctx.net.opened++
          ctx.net.open++
          conns.set(id, new Connection(sock, ctx, ip))
        },
        verdict(id, v) {
          conns.get(id)?.verdict(v)
        },
        closed(id, reason, ip, opened) {
          ipDone(ip)
          if (!opened) return
          ctx.net.open--
          const c = conns.get(id)
          conns.delete(id)
          c?.socketClosed(reason)
        },
        log: config.log,
      },
      () => world.timers,
    )
    try {
      await hub.start()
      config.log(`gateways: ${config.gateways} process(es) own the client sockets (GATEWAYS)`)
    } catch (e) {
      // never a server without sockets: the in-process path takes them
      config.log(`gateways: ${(e as Error).message}; client sockets stay in this process`)
      await hub.close(500)
      hub = null
    }
  }
  ctx.gateways = hub
  if (hub) {
    const h = hub
    ctx.net.probe = () => ({ sockets: sockets.size, ...h.queue() })
  }
  ctx.net.extra = () => ({
    ...(hub ? { gateways: hub.snapshot() } : {}),
    ...(aoiPool ? { aoiJobs: aoiPool.snapshot() } : {}),
    // P2: the DB writer's queue, latency and group commit; the services' requests; the transfers' commit-then-ack
    ...(store.writer ? { db: store.writerStats() } : {}),
    ...(gameplay.services ? { services: gameplay.services.stats() } : {}),
    economy: { ...gameplay.economy.stats(), held: holdStats.holds, heldMessages: holdStats.queued },
  })
  ctx.net.switches = { ...switches, gateways: hub !== null, aoiJobs: aoiPool !== null, dbWriter: store.writer !== null, svcBus: gameplay.services !== null }

  const http = createServer((req, res) => {
    void handle(req, res)
  })
  http.headersTimeout = 10_000
  http.requestTimeout = 30_000

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false })
  const alive = new WeakSet<WebSocket>()
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
    if (hub) {
      // P1a: the gateway completes the handshake and owns the socket from here
      socketsPerIp.set(ip, (socketsPerIp.get(ip) ?? 0) + 1)
      if (!hub.pass(req, socket, head, ip)) {
        ipDone(ip)
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      }
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      socketsPerIp.set(ip, (socketsPerIp.get(ip) ?? 0) + 1)
      ws.once('close', () => ipDone(ip))
      alive.add(ws)
      ws.on('pong', () => alive.add(ws))
      ctx.net.opened++
      ctx.net.open++
      ws.once('close', () => ctx.net.open--)
      wsConnection(ws, ctx, ip)
    })
  })

  config.log(`navigation: ${nav.source}`)
  config.log(gameplay.start())
  memory.push(memorySample('world'))
  ctx.net.memory = memory
  config.log(memoryLine(memory))
  const unplaced = unplacedNestsLine(gameplay, data, setup)
  if (unplaced) config.log(unplaced)
  world.onTickTimed = (ms) => ctx.net.tick(ms)
  world.start()
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        // No pong for a whole interval: the Connection logs it (its close handler sees this flag).
        ;(ws as WebSocket & { sroTimedOut?: boolean }).sroTimedOut = true
        ws.terminate()
        continue
      }
      alive.delete(ws)
      ws.ping()
    }
  }, HEARTBEAT_MS)
  const saver = setInterval(() => {
    const t0 = world.timers.now()
    try {
      ctx.persist([...world.players.values()])
    } catch (e) {
      config.log(`periodic save failed: ${(e as Error).message}`)
    }
    world.timers.lap(PH.save, t0)
  }, config.saveIntervalS * 1000)
  const purger = setInterval(() => {
    store.purgeSessions()
    adminStore.purgeSessions(Date.now(), ADMIN_IDLE_MS)
    antiAlt.purge()
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
        // docs/CLIMB.md §6.1 (F6): bodies lingering in a fight leave now (saved and removed)
        gameplay.penalty.flush()
        // docs/NETWORK_AUDIT.md N5: bodies held for a reconnect too
        ctx.holds.releaseAll()
        ctx.persist([...world.players.values()])
        // docs/SIEGE.md §5.3: the walls' unsaved integrity
        gameplay.walls.flush()
        for (const ws of wss.clients) ws.terminate()
        wss.close()
        // P1a: the gateways send what is queued (the notices and close frames above), close their sockets and exit
        if (hub) await hub.close()
        for (const c of [...conns.values()]) c.socketClosed('server shutdown')
        conns.clear()
        gcWatch?.disconnect()
        await aoiPool?.close()
        ctx.net.close()
        await new Promise<void>((resolve) => {
          http.close(() => resolve())
          http.closeAllConnections()
          // P1a: a server that handed sockets to child processes polls them in close() for their sockets (Node's net
          // "workers"); the gateways are gone already (hub.close above) and that poll may never answer: the listening
          // socket is closed by now, so do not wait for it
          if (hub) setImmediate(resolve)
        })
        store.close()
        releaseWriterLock?.()
      })()
      return closing
    },
  }
}
