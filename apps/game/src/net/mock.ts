/**
 * In-browser implementation of protocol v1 (?mock=1): accounts, characters and their progress (level, EXP,
 * inventory) persist in localStorage; the world is a flat plane with a few wandering bots, an NPC shop and
 * monster nests around the spawn. Every screen and every gameplay message can be exercised without the server.
 * Messages are JSON round-tripped (and checked with the shared validators) so serialization bugs show up here too.
 *
 * Gameplay (docs/PROTOCOL.md): server-side auto-attack with chase, aggressive and passive monsters that wander,
 * aggro, chase, leash home and regenerate; hit/miss/crit; EXP, SP and level-ups; loot with owner priority and
 * pickup; bag and equipment requests; potions and return scrolls; NPC shop; death and respawn in town. All
 * randomness comes from a seeded RNG, so a session plays out the same way for the same inputs.
 * GM: with `gmRole` set (?mock=1&gm=1) every account is staff and the GM commands of apps/server/src/gm.ts
 * (including spawn/item/kill/heal) work against this mock.
 */
import {
  ACCOUNT_NAME,
  armorClassesClash,
  CHARACTER_NAME,
  CHARACTER_RULES,
  CLOCK_EPOCH_DAYS,
  CLOCK_EPOCH_MS,
  CLOSE_CODE,
  DEFAULT_CLOCK,
  DEFAULT_HEIGHT,
  DEFAULT_VOLUME,
  equipSlotsFor,
  GAMEPLAY_REQUESTS,
  GM_MAX_ARGS,
  isStaff,
  ITEM_EXPIRE_MS,
  ITEM_OWNER_MS,
  MAX_CHARACTER_SLOTS,
  MAX_CHAT_LENGTH,
  NPC_INTERACT_RANGE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PICKUP_RANGE,
  PROTOCOL_VERSION,
  STARTER_WEAPONS,
  validateClientMessage,
  validateServerMessage,
  type ActionFailReason,
  type ApiLoginRequest,
  type ApiLoginResponse,
  type ApiRegisterRequest,
  type ApiRegisterResponse,
  type BagSlotUpdate,
  type CharacterSummary,
  type ClientMessage,
  type CombatHit,
  type EntityState,
  type EquipSlot,
  type EquipSlotUpdate,
  type GameplayRequest,
  type GmPlayerInfo,
  type MobDef,
  type MobVariant,
  type MoveState,
  type Role,
  type ServerInfo,
  type ServerMessage,
  type StarterOutfit,
  type StarterWeapon,
  type Vec3,
  type WeatherSync,
  type WorldClockState,
} from '@sro/shared'
import { starterEquipment, starterOutfitItems } from '@sro/appearance'
import { BUILTIN_NPCS } from '../content/builtin.ts'
import { weaponFamilyOf } from '../content/catalog.ts'
import { builtinTables, expToNext, fetchContentTables, type ContentTables } from '../content/gameplay.ts'
import { t } from '../i18n/index.ts'
import { GameError, type Api } from './api.ts'
import { sampleMove, yawOf } from './clock.ts'
import { DEFAULT_MOCK_EXTENSIONS } from './mock/index.ts'
import {
  addToBag,
  deriveStats,
  firstFree,
  isGold,
  LEVEL_CAP,
  randInt,
  rng,
  rollDrops,
  starterProgress,
  visibleEquip,
  type Progress,
} from './mock-rules.ts'
import type { Wire } from './wire.ts'

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface Account {
  password: string
  characters: CharacterSummary[]
}

interface Db {
  nextCharId: number
  accounts: Record<string, Account>
  /** Gameplay progress per character id. */
  progress?: Record<string, Progress>
}

type Action = { kind: 'attack'; target: number } | { kind: 'pickup'; id: number }

interface PlayerSim {
  conn: Conn
  charId: number
  female: boolean
  prog: Progress
  action: Action | null
  nextSwing: number
  lastCombat: number
  cooldowns: Map<string, number>
  /** Target position the current chase move aims at (re-chase when the target moved away from it). */
  chaseAim: Vec3 | null
  casting: { until: number } | null
}

interface NestSim {
  mob: string
  x: number
  z: number
  radius: number
  count: number
  respawnSec: [number, number]
  aggressive: boolean
  sight: number
  leash: number
  championPct: number
  alive: Set<number>
  /** Server times at which a dead mob's replacement spawns. */
  pending: number[]
}

interface MobSim {
  def: MobDef
  nest: NestSim | null
  home: Vec3
  mode: 'idle' | 'chase' | 'return' | 'dead'
  target: number | null
  nextSwing: number
  nextWander: number
  despawnAt: number
  chaseAim: Vec3 | null
  aggressive: boolean
  sight: number
  leash: number
  /** Variant multiplier for HP, damage and EXP. */
  mul: number
}

export interface SimEntity {
  state: EntityState
  bot: boolean
  nextThink: number
  /** GM speed multiplier. */
  speedMul?: number
  player?: PlayerSim
  mob?: MobSim
  item?: { code: string; count: number; plus?: number }
  npc?: { code: string }
}

export interface Conn {
  deliver(msg: ServerMessage): void
  kill?: () => void
  /** Server-side close with an application code (GM kick). */
  close?: (code: number, reason: string) => void
  role?: Role
  account?: string
  entityId?: number
  charId?: number
}

/** A mock connection (lane mocks: `conn.deliver(msg)`, `conn.entityId`). */
export type MockConn = Conn
/** A simulated entity (player, bot, mob, NPC, ground item). */
export type MockEntity = SimEntity

/** What a lane mock can reach inside the MockServer (docs/WAVE_PLAN.md §3.3). */
export interface MockContext {
  readonly content: ContentTables
  /** Mock server time (ms). */
  now(): number
  /** Sends the one `actionResult` a gameplay request gets. */
  result(conn: MockConn, re: GameplayRequest, ok: boolean, reason?: ActionFailReason, message?: string): void
  send(conn: MockConn, msg: ServerMessage): void
  /** To every in-world connection except `except` (only `only`, when given). */
  broadcast(msg: ServerMessage, except?: MockConn, only?: MockConn): void
  /** The wire state of an entity, at its current position. */
  snapshot(e: MockEntity): EntityState
  /** Horizontal distance (m) between two entities' current positions. */
  dist(a: MockEntity, b: MockEntity): number
  /** The connection's own player entity (undefined outside the world). */
  selfOf(conn: MockConn): MockEntity | undefined
  entity(id: number): MockEntity | undefined
  entities(): IterableIterator<MockEntity>
}

/**
 * A lane's optional mock support (net/mock/<lane>.ts, listed in net/mock/index.ts). `handle` sees every validated
 * message of a logged-in connection before the built-in handling; true = handled (a gameplay request must then send
 * its own actionResult). `tick` runs after each simulation tick; `enter` after a player's enter-world messages.
 */
export interface MockExtension {
  handle?(ctx: MockContext, conn: MockConn, msg: ClientMessage): boolean
  tick?(ctx: MockContext, now: number): void
  enter?(ctx: MockContext, conn: MockConn): void
}

const STORAGE_KEY = 'sro.mock.db'
const RUN_SPEED = 5.5
const BOT_SPEED = 2.2
/** Mock server clock runs ahead of the browser's so the client's offset handling is exercised. */
const CLOCK_SKEW_MS = 93_000
const SPAWN: Vec3 = [0, 0, 0]
const TICK_MS = 100
const PLAYER_RADIUS = 0.4
const CORPSE_MS = 5000
const REGEN_EVERY_MS = 2000
const OUT_OF_COMBAT_MS = 5000
const SAVE_EVERY_MS = 10_000
const BARE_HANDS_RANGE = 1
/** Shared cooldown of a potion group when the item data has none (the export has no cooldownMs yet). */
const POTION_COOLDOWN_MS = 1000
/** The export's return scroll casts for 30 s; the mock shortens it so testers are not left waiting. */
const MAX_RETURN_CAST_MS = 5000
const VARIANT_MUL: Partial<Record<MobVariant, number>> = { champion: 2, giant: 5, titan: 8, elite: 3, unique: 1, party: 4 }
const SWING_MS: Record<StarterWeapon, number> = { sword: 1200, blade: 1200, spear: 1400, glaive: 1400, bow: 1300 }

/** Monster nests around the mock spawn (authored; the export's nests.json is in the real Jangan frame). */
const MOCK_NESTS: Omit<NestSim, 'alive' | 'pending'>[] = [
  { mob: 'MOB_CH_MANGNYANG', x: 0, z: -24, radius: 7, count: 6, respawnSec: [6, 10], aggressive: false, sight: 8, leash: 22, championPct: 10 },
  { mob: 'MOB_CH_MANGNYANG', x: -22, z: -32, radius: 6, count: 5, respawnSec: [6, 10], aggressive: false, sight: 8, leash: 22, championPct: 20 },
  { mob: 'MOB_CH_TIGER', x: 24, z: -38, radius: 6, count: 4, respawnSec: [10, 15], aggressive: true, sight: 9, leash: 24, championPct: 10 },
]

/** Wave 9 (docs/SKY.md §2.2): the default server clock (120-minute days from the epoch), so offline play has day and night. */
const MOCK_CLOCK: WorldClockState = { anchorMs: CLOCK_EPOCH_MS, anchorDays: CLOCK_EPOCH_DAYS, ...DEFAULT_CLOCK }

/** Wave 9 (docs/WEATHER.md §4.1): offline weather is always clear (the client's `?weather=` override still works). */
function mockWeather(now: number): WeatherSync {
  return { start: now, dur: 0, from: 'clear', to: 'clear', intensity: 1, until: now + 3_600_000, windDir: 0.35, windMs: 2, wet: 0, puddle: 0, at: now, seed: 1 }
}

const MOCK_SERVER: ServerInfo = { id: 'mock', name: t('mock.serverMain'), status: 'online', online: 4, capacity: 500 }
const MOCK_SERVERS: ServerInfo[] = [
  MOCK_SERVER,
  { id: 'mock-maint', name: t('mock.serverMaint'), status: 'maintenance', online: 0, capacity: 500 },
]

const BOTS: { name: string; model: string; weapon: StarterWeapon; level: number; outfit: StarterOutfit; height: number; volume: number }[] = [
  { name: 'Xiao_Lin', model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'bow', level: 7, outfit: 'light', height: 1, volume: 2 },
  { name: 'WeiChen', model: 'CHAR_CH_MAN_WARRIOR', weapon: 'glaive', level: 12, outfit: 'heavy', height: 4, volume: 4 },
  { name: 'MeiHua', model: 'CHAR_CH_WOMAN_KISAENG', weapon: 'blade', level: 3, outfit: 'clothes', height: 2, volume: 0 },
]
const BOT_LINES = [t('mock.bot1'), t('mock.bot2'), t('mock.bot3'), t('mock.bot4'), t('mock.bot5')]

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

function defaultStore(): KeyValueStore {
  try {
    const ls = globalThis.localStorage
    if (ls) {
      ls.getItem(STORAGE_KEY)
      return ls
    }
  } catch {
    // Storage blocked: fall back to memory.
  }
  return memoryStore()
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return Math.abs(d)
}

const GAMEPLAY = new Set<string>(GAMEPLAY_REQUESTS)

export class MockServer implements Api {
  private readonly tokens = new Map<string, string>()
  private readonly conns = new Set<Conn>()
  private readonly entities = new Map<number, SimEntity>()
  private nests: NestSim[] = []
  private nextEntityId = 100
  private timer: ReturnType<typeof setInterval> | undefined
  private rand = rng(0x5eed)
  private nextRegen = 0
  private nextSave = 0
  /** Gameplay content: builtin stand-ins, replaced by the export (/out/data/) when the browser can fetch it. */
  content: ContentTables = builtinTables()
  /** GM mock (?mock=1&gm=1): the role every account gets; null = everyone is a player. */
  gmRole: Role | null = null
  /** The lane mocks' view of this server. */
  private readonly mockCtx: MockContext = this.makeContext()

  private makeContext(): MockContext {
    const server = this
    return {
      get content() {
        return server.content
      },
      now: () => server.now(),
      result: (conn, re, ok, reason, message) => server.result(conn, re, ok, reason, message),
      send: (conn, msg) => conn.deliver(msg),
      broadcast: (msg, except, only) => server.broadcast(msg, except, only),
      snapshot: e => server.snapshot(e),
      dist: (a, b) => server.dist(a, b),
      selfOf: conn => server.selfOf(conn),
      entity: id => server.entities.get(id),
      entities: () => server.entities.values(),
    }
  }

  constructor(
    private readonly store: KeyValueStore = defaultStore(),
    private readonly latencyMs = 120,
    readonly now: () => number = () => Date.now() + CLOCK_SKEW_MS,
    /** Lane mocks (net/mock/index.ts); optional, first to cut. */
    readonly extensions: readonly MockExtension[] = DEFAULT_MOCK_EXTENSIONS,
  ) {
    if (typeof window !== 'undefined' && typeof fetch === 'function') {
      fetchContentTables('/out/data/')
        .then(tables => {
          if (tables.exported.length) this.content = tables
        })
        .catch(() => {})
    }
  }

  // ---- persistence --------------------------------------------------------------------------

  private load(): Db {
    try {
      const raw = this.store.getItem(STORAGE_KEY)
      if (raw) {
        const db = JSON.parse(raw) as Db
        if (db && typeof db === 'object' && db.accounts) return db
      }
    } catch {
      // corrupt: start over
    }
    return { nextCharId: 1, accounts: {} }
  }

  private save(db: Db): void {
    try {
      this.store.setItem(STORAGE_KEY, JSON.stringify(db))
    } catch {
      // quota / blocked: the mock keeps working for this page
    }
  }

  private delay(): Promise<void> {
    return new Promise(r => setTimeout(r, this.latencyMs))
  }

  // ---- HTTP API ------------------------------------------------------------------------------

  async register(req: ApiRegisterRequest): Promise<ApiRegisterResponse> {
    await this.delay()
    const username = String(req.username ?? '').trim()
    const password = String(req.password ?? '')
    if (!ACCOUNT_NAME.test(username)) throw new GameError('bad_request', t('mock.badUsername'))
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      throw new GameError('bad_request', t('mock.badPassword', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }))
    }
    const db = this.load()
    const key = username.toLowerCase()
    if (db.accounts[key]) throw new GameError('name_taken', t('mock.usernameTaken'))
    db.accounts[key] = { password, characters: [] }
    this.save(db)
    return this.issue(key)
  }

  private issue(key: string): ApiLoginResponse {
    const token = `mock-${key}-${Math.random().toString(36).slice(2)}`
    this.tokens.set(token, key)
    return { token, expiresAt: Date.now() + 3600_000 }
  }

  async logout(token: string): Promise<void> {
    this.tokens.delete(token)
  }

  async login(req: ApiLoginRequest): Promise<ApiLoginResponse> {
    await this.delay()
    const key = String(req.username ?? '').trim().toLowerCase()
    const acc = this.load().accounts[key]
    if (!acc || acc.password !== req.password) throw new GameError('unauthorized', t('mock.wrongLogin'))
    return this.issue(key)
  }

  async servers(): Promise<ServerInfo[]> {
    await this.delay()
    const inWorld = this.players().length
    return clone(MOCK_SERVERS.map(s => (s.id === MOCK_SERVER.id ? { ...s, online: inWorld || s.online } : s)))
  }

  // ---- WebSocket -----------------------------------------------------------------------------

  /** A Wire connected to this mock (use as the Session's WireFactory). */
  wire(): Wire {
    let open = true
    const conn: Conn = {
      deliver: msg => {
        if (!open) return
        const copy = clone(msg)
        const checked = validateServerMessage(copy)
        if (!checked.ok) console.error(`[mock] invalid ${msg.t} (${checked.error})`, copy)
        setTimeout(() => open && wire.onMessage(copy), this.latencyMs / 2)
      },
    }
    const wire: Wire = {
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
      send: msg => {
        if (!open) return
        const copy = clone(msg)
        setTimeout(() => open && this.handle(conn, copy), this.latencyMs / 2)
      },
      close: () => {
        if (!open) return
        open = false
        this.disconnect(conn)
        setTimeout(() => wire.onClose({ clean: true, code: 1000, reason: 'client closed' }), 0)
      },
    }
    conn.close = (code, reason) => {
      if (!open) return
      open = false
      this.disconnect(conn)
      setTimeout(() => wire.onClose({ clean: false, code, reason }), this.latencyMs / 2)
    }
    conn.kill = () => {
      if (!open) return
      open = false
      this.disconnect(conn)
      setTimeout(() => wire.onClose({ clean: false, code: 1006, reason: 'mock network drop' }), 0)
    }
    this.conns.add(conn)
    setTimeout(() => open && wire.onOpen(), this.latencyMs)
    return wire
  }

  /** Test hook: drop every connection as if the network failed. */
  dropAll(): void {
    for (const c of [...this.conns]) c.kill?.()
  }

  /** Test hook: run one simulation tick now (tests drive time through the `now` constructor argument). */
  step(): void {
    this.tick()
  }

  /** Test hook: live entity states (players, mobs, NPCs, ground items). */
  snapshotEntities(): EntityState[] {
    return [...this.entities.values()].map(e => this.snapshot(e))
  }

  private disconnect(conn: Conn): void {
    this.conns.delete(conn)
    if (conn.entityId !== undefined) this.leaveWorld(conn)
  }

  private error(conn: Conn, code: Extract<ServerMessage, { t: 'error' }>['code'], message: string, re?: ClientMessage['t']): void {
    conn.deliver({ t: 'error', code, message, re })
  }

  private account(conn: Conn): Account | undefined {
    return conn.account ? this.load().accounts[conn.account] : undefined
  }

  private handle(conn: Conn, raw: ClientMessage): void {
    // Same strict frame check as the real server.
    const parsed = validateClientMessage(raw)
    if (!parsed.ok) {
      const re = typeof (raw as { t?: unknown })?.t === 'string' ? (raw.t as ClientMessage['t']) : undefined
      return this.error(conn, 'bad_request', parsed.error, re)
    }
    const msg = parsed.msg
    if (msg.t === 'ping') {
      conn.deliver({ t: 'pong', n: msg.n, clientTime: msg.clientTime, serverTime: this.now() })
      return
    }
    if (msg.t === 'hello') {
      if (msg.version !== PROTOCOL_VERSION) return this.error(conn, 'version_mismatch', t('mock.protocol', { version: PROTOCOL_VERSION }), 'hello')
      const account = this.tokens.get(msg.token)
      if (!account) return this.error(conn, 'unauthorized', t('mock.sessionExpired'), 'hello')
      conn.account = account
      conn.role = this.gmRole ?? 'player'
      conn.deliver({ t: 'welcome', account, server: clone(MOCK_SERVER), slots: MAX_CHARACTER_SLOTS, role: conn.role })
      return
    }
    if (!conn.account) return this.error(conn, 'unauthorized', t('mock.helloFirst'), msg.t)
    for (const x of this.extensions) if (x.handle && this.extension(() => x.handle!(this.mockCtx, conn, msg))) return
    if (GAMEPLAY.has(msg.t)) return this.gameplay(conn, msg)
    switch (msg.t) {
      case 'charList': {
        const acc = this.account(conn)
        const progress = this.load().progress ?? {}
        // What each character wears now (the summary keeps the creation outfit for older saves).
        const characters = (acc?.characters ?? []).map(c => {
          const prog = progress[String(c.id)]
          return prog ? { ...c, equip: visibleEquip(prog.inventory) } : c
        })
        conn.deliver({ t: 'charList', slots: MAX_CHARACTER_SLOTS, characters })
        return
      }
      case 'nameCheck': {
        const reason = this.nameProblem(msg.name)?.message
        conn.deliver({ t: 'nameCheck', name: msg.name, available: !reason, reason })
        return
      }
      case 'charCreate':
        return this.charCreate(conn, msg)
      case 'charDelete': {
        const db = this.load()
        const acc = db.accounts[conn.account]!
        const i = acc.characters.findIndex(c => c.id === msg.id)
        if (i < 0) return this.error(conn, 'not_found', t('mock.noCharacter'), 'charDelete')
        acc.characters.splice(i, 1)
        if (db.progress) delete db.progress[String(msg.id)]
        this.save(db)
        conn.deliver({ t: 'charDeleted', id: msg.id })
        return
      }
      case 'enterWorld':
        return this.enterWorld(conn, msg.id)
      case 'moveTo': {
        const e = this.selfOf(conn)
        if (!e) return this.error(conn, 'not_in_world', t('mock.notInWorld'), 'moveTo')
        if (e.player?.prog.dead) return
        this.cancelAction(e)
        this.startMove(e, [msg.x, e.state.pos[1], msg.z], RUN_SPEED * (e.speedMul ?? 1))
        return
      }
      case 'chat': {
        const e = this.selfOf(conn)
        if (!e) return this.error(conn, 'not_in_world', t('mock.notInWorld'), 'chat')
        const text = String(msg.text).slice(0, MAX_CHAT_LENGTH).trim()
        if (!text) return
        if (text.startsWith('/')) {
          const tokens = text.slice(1).trim().split(/\s+/).filter(Boolean)
          const cmd = (tokens.shift() ?? '').toLowerCase()
          const args = tokens.length > GM_MAX_ARGS ? [...tokens.slice(0, GM_MAX_ARGS - 1), tokens.slice(GM_MAX_ARGS - 1).join(' ')] : tokens
          return this.gm(conn, cmd, args, 'chat')
        }
        this.broadcast({ t: 'chat', channel: 'local', fromId: e.state.id, from: e.state.name, text })
        if (/^(hi|hello|hey)\b/i.test(text)) {
          const bot = [...this.entities.values()].find(b => b.bot)
          if (bot) setTimeout(() => this.broadcast({ t: 'chat', channel: 'local', fromId: bot.state.id, from: bot.state.name, text: t('mock.botHi', { name: e.state.name }) }), 900)
        }
        return
      }
      case 'gm':
        return this.gm(conn, msg.cmd, msg.args, 'gm')
      case 'leaveWorld':
        if (conn.entityId === undefined) return this.error(conn, 'not_in_world', t('mock.notInWorld'), 'leaveWorld')
        this.leaveWorld(conn)
        conn.deliver({ t: 'worldLeft' })
        return
    }
  }

  private selfOf(conn: Conn): SimEntity | undefined {
    return conn.entityId !== undefined ? this.entities.get(conn.entityId) : undefined
  }

  private players(): SimEntity[] {
    return [...this.entities.values()].filter(e => e.state.kind === 'player')
  }

  private nameProblem(name: string): { code: 'name_taken' | 'name_invalid'; message: string } | undefined {
    if (!CHARACTER_NAME.test(name)) return { code: 'name_invalid', message: t('mock.nameInvalid') }
    const lower = name.toLowerCase()
    const taken = { code: 'name_taken', message: t('mock.nameTaken') } as const
    if (BOTS.some(b => b.name.toLowerCase() === lower)) return taken
    for (const acc of Object.values(this.load().accounts)) {
      if (acc.characters.some(c => c.name.toLowerCase() === lower)) return taken
    }
    return undefined
  }

  private charCreate(conn: Conn, msg: Extract<ClientMessage, { t: 'charCreate' }>): void {
    const problem = this.nameProblem(msg.name)
    if (problem) return this.error(conn, problem.code, problem.message, 'charCreate')
    if (!/^CHAR_CH_(MAN|WOMAN)_[A-Z0-9_]+$/.test(msg.model)) return this.error(conn, 'bad_request', t('mock.unknownModel'), 'charCreate')
    if (!STARTER_WEAPONS.includes(msg.weapon)) return this.error(conn, 'bad_request', t('mock.unknownWeapon'), 'charCreate')
    const db = this.load()
    const acc = db.accounts[conn.account!]!
    if (acc.characters.length >= MAX_CHARACTER_SLOTS) return this.error(conn, 'slots_full', t('mock.slotsFull'), 'charCreate')
    const character: CharacterSummary = {
      id: db.nextCharId++,
      name: msg.name,
      model: msg.model,
      level: 1,
      weapon: msg.weapon,
      location: t('mock.worldName'),
      pos: [SPAWN[0] + (Math.random() - 0.5) * 4, SPAWN[1], SPAWN[2] + (Math.random() - 0.5) * 4],
      lastPlayed: 0,
      height: msg.height ?? DEFAULT_HEIGHT,
      volume: msg.volume ?? DEFAULT_VOLUME,
    }
    // The chosen starter set is worn from the start (Cloth row); the weapon is equipped by starterProgress.
    const female = /_WOMAN_/.test(msg.model)
    const prog = starterProgress(msg.weapon, female, 1, this.content)
    this.wearOutfit(prog, female, msg.outfit ?? 'clothes')
    db.progress ??= {}
    db.progress[String(character.id)] = prog
    character.equip = visibleEquip(prog.inventory)
    acc.characters.push(character)
    this.save(db)
    conn.deliver({ t: 'charCreated', character })
  }

  /** Equips a starter outfit (the garment set when the content tables lack the chosen one). */
  private wearOutfit(prog: Progress, female: boolean, outfit: StarterOutfit): void {
    const gender = female ? 'female' : 'male'
    const wanted = starterOutfitItems(gender, outfit)
    const garment = starterOutfitItems(gender, 'clothes')
    for (const slot of ['chest', 'legs', 'feet'] as const) {
      const code = [wanted[slot], garment[slot]].find(c => c && this.content.items.has(c))
      if (code) prog.inventory.equip[slot] = { code, count: 1 }
    }
  }

  private enterWorld(conn: Conn, id: number): void {
    if (conn.entityId !== undefined) return this.error(conn, 'already_in_world', t('mock.alreadyInWorld'), 'enterWorld')
    const db = this.load()
    const acc = db.accounts[conn.account!]!
    const ch = acc.characters.find(c => c.id === id)
    if (!ch) return this.error(conn, 'not_found', t('mock.noCharacter'), 'enterWorld')
    ch.lastPlayed = Date.now()
    const female = /_WOMAN_/.test(ch.model)
    db.progress ??= {}
    const prog = db.progress[String(ch.id)] ?? starterProgress(ch.weapon, female, ch.level, this.content)
    db.progress[String(ch.id)] = prog
    this.save(db)
    this.ensureWorld()
    const stats = deriveStats(prog, this.content)
    const now = this.now()
    const self: SimEntity = {
      bot: false,
      nextThink: Infinity,
      state: {
        id: this.nextEntityId++,
        kind: 'player',
        name: ch.name,
        model: ch.model,
        level: prog.level,
        weapon: ch.weapon,
        pos: [...ch.pos],
        yaw: Math.PI,
        hp: prog.hp,
        maxHp: stats.maxHp,
        equip: visibleEquip(prog.inventory),
        height: ch.height ?? DEFAULT_HEIGHT,
        volume: ch.volume ?? DEFAULT_VOLUME,
      },
      player: { conn, charId: ch.id, female, prog, action: null, nextSwing: now, lastCombat: 0, cooldowns: new Map(), chaseAim: null, casting: null },
    }
    if (prog.dead) self.state.state = 'dead'
    const others = [...this.entities.values()].map(e => this.snapshot(e))
    this.entities.set(self.state.id, self)
    conn.entityId = self.state.id
    conn.charId = ch.id
    conn.deliver({ t: 'worldEnter', self: this.snapshot(self), world: { name: 'jangan', serverTime: this.now(), tickRate: 1000 / TICK_MS, clock: { ...MOCK_CLOCK }, weather: mockWeather(this.now()) }, entities: others, role: conn.role ?? 'player' })
    conn.deliver({ t: 'stats', stats })
    conn.deliver({ t: 'inventory', inventory: clone(prog.inventory) })
    this.broadcast({ t: 'spawn', entity: this.snapshot(self) }, conn)
    this.broadcast({ t: 'chat', channel: 'system', text: t('mock.welcome', { name: ch.name }) }, undefined, conn)
    for (const x of this.extensions) if (x.enter) this.extension(() => x.enter!(this.mockCtx, conn))
    if (this.timer === undefined) this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  /** Runs a lane mock hook; a throwing hook counts as "not handled" and never breaks the mock. */
  private extension<T>(fn: () => T): T | false {
    try {
      return fn()
    } catch (err) {
      console.error('[mock] extension failed', err)
      return false
    }
  }

  /** Writes a player's position, level, weapon and progress to the store. */
  private persist(e: SimEntity): void {
    const ps = e.player
    const acc = ps?.conn.account
    if (!ps || !acc) return
    const db = this.load()
    const ch = db.accounts[acc]?.characters.find(c => c.id === ps.charId)
    if (!ch) return
    ch.pos = this.currentPos(e)
    ch.level = ps.prog.level
    const w = ps.prog.inventory.equip.weapon
    const family = w ? weaponFamilyOf(w.code, this.content.items.get(w.code)) : undefined
    if (family) ch.weapon = family
    db.progress ??= {}
    db.progress[String(ps.charId)] = ps.prog
    this.save(db)
  }

  private leaveWorld(conn: Conn): void {
    const id = conn.entityId
    if (id === undefined) return
    const e = this.entities.get(id)
    if (e) {
      this.cancelAction(e)
      this.persist(e)
    }
    this.entities.delete(id)
    conn.entityId = undefined
    conn.charId = undefined
    this.broadcast({ t: 'despawn', id }, conn)
    if (![...this.conns].some(c => c.entityId !== undefined)) {
      clearInterval(this.timer)
      this.timer = undefined
      this.entities.clear()
      this.nests = []
    }
  }

  /** Bots, the NPC and the monster nests (created when the first player enters). */
  private ensureWorld(): void {
    if ([...this.entities.values()].some(e => e.bot)) return
    BOTS.forEach(({ outfit, ...b }, i) => {
      const a = (i / BOTS.length) * Math.PI * 2
      const equip = starterEquipment(/_WOMAN_/.test(b.model) ? 'female' : 'male', outfit, b.weapon)
      const e: SimEntity = {
        bot: true,
        nextThink: this.now() + 1500 + i * 1200,
        state: { id: this.nextEntityId++, kind: 'player', ...b, equip, pos: [SPAWN[0] + Math.cos(a) * 6, SPAWN[1], SPAWN[2] + Math.sin(a) * 6], yaw: a },
      }
      this.entities.set(e.state.id, e)
    })
    // The mock world is a plane around (0, 0): NPCs stand where builtin.ts puts them, while name, model and shop
    // come from the export when it has the same code (its x/z are in the real Jangan frame, far from here).
    for (const placed of BUILTIN_NPCS) {
      const npc = this.content.npcs.get(placed.code) ?? placed
      const e: SimEntity = {
        bot: false,
        nextThink: Infinity,
        npc: { code: npc.code },
        state: { id: this.nextEntityId++, kind: 'npc', name: npc.name ?? npc.code, model: npc.code, level: 0, pos: [SPAWN[0] + placed.x, SPAWN[1], SPAWN[2] + placed.z], yaw: placed.yaw },
      }
      this.entities.set(e.state.id, e)
    }
    this.rand = rng(0x5eed)
    this.nests = MOCK_NESTS.filter(n => this.content.mobs.has(n.mob)).map(n => ({ ...n, alive: new Set<number>(), pending: [] }))
    for (const nest of this.nests) for (let i = 0; i < nest.count; i++) this.spawnNestMob(nest, false)
  }

  private currentPos(e: SimEntity): Vec3 {
    return e.state.move ? sampleMove(e.state.move, this.now()).pos : [...e.state.pos]
  }

  private snapshot(e: SimEntity): EntityState {
    const s = clone(e.state)
    s.pos = this.currentPos(e)
    return s
  }

  private startMove(e: SimEntity, to: Vec3, speed: number): void {
    const from = this.currentPos(e)
    const move: MoveState = { from, to, speed, startedAt: this.now() }
    e.state.pos = from
    e.state.move = move
    e.state.yaw = yawOf(to[0] - from[0], to[2] - from[2])
    this.broadcast({ t: 'move', id: e.state.id, move })
  }

  /** Ends any move at the current position (broadcast `stop`), optionally turning to `yaw`. */
  private halt(e: SimEntity, yaw = e.state.yaw): void {
    if (!e.state.move && angleDiff(yaw, e.state.yaw) < 0.15) return
    e.state.pos = this.currentPos(e)
    e.state.move = undefined
    e.state.yaw = yaw
    this.broadcast({ t: 'stop', id: e.state.id, pos: e.state.pos, yaw })
  }

  private dist(a: SimEntity, b: SimEntity): number {
    const p = this.currentPos(a)
    const q = this.currentPos(b)
    return Math.hypot(p[0] - q[0], p[2] - q[2])
  }

  /** Moves `mover` to stand within `reach` of `target`; re-issued only when the target moved away from the aim. */
  private chase(mover: SimEntity, target: SimEntity, reach: number, speed: number, holder: { chaseAim: Vec3 | null }): void {
    const tp = this.currentPos(target)
    const aim = holder.chaseAim
    if (mover.state.move && aim && Math.hypot(aim[0] - tp[0], aim[2] - tp[2]) < 0.8) return
    const mp = this.currentPos(mover)
    const dx = mp[0] - tp[0]
    const dz = mp[2] - tp[2]
    const len = Math.hypot(dx, dz) || 1
    const stand = Math.max(0.1, reach * 0.7)
    holder.chaseAim = tp
    this.startMove(mover, [tp[0] + (dx / len) * stand, mp[1], tp[2] + (dz / len) * stand], speed)
  }

  private face(mover: SimEntity, target: SimEntity, holder: { chaseAim: Vec3 | null }): void {
    const mp = this.currentPos(mover)
    const tp = this.currentPos(target)
    holder.chaseAim = null
    this.halt(mover, yawOf(tp[0] - mp[0], tp[2] - mp[2]))
  }

  // ---- simulation ----------------------------------------------------------------------------

  private tick(): void {
    const now = this.now()
    for (const e of this.entities.values()) {
      if (e.state.move && sampleMove(e.state.move, now).arrived) {
        e.state.pos = [...e.state.move.to]
        e.state.move = undefined
        this.broadcast({ t: 'stop', id: e.state.id, pos: e.state.pos, yaw: e.state.yaw })
      }
      if (e.bot && now >= e.nextThink) {
        e.nextThink = now + 3000 + Math.random() * 5000
        const a = Math.random() * Math.PI * 2
        const r = 3 + Math.random() * 14
        this.startMove(e, [SPAWN[0] + Math.cos(a) * r, SPAWN[1], SPAWN[2] + Math.sin(a) * r], BOT_SPEED)
        if (Math.random() < 0.12) {
          this.broadcast({ t: 'chat', channel: 'local', fromId: e.state.id, from: e.state.name, text: BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]! })
        }
      }
    }
    for (const e of [...this.entities.values()]) {
      if (!this.entities.has(e.state.id)) continue
      if (e.player) this.playerTick(e, now)
      else if (e.mob) this.mobTick(e, now)
      else if (e.item && e.state.expiresAt !== undefined && now >= e.state.expiresAt) this.removeEntity(e)
    }
    for (const nest of this.nests) {
      while (nest.pending.length && nest.pending[0]! <= now) {
        nest.pending.shift()
        this.spawnNestMob(nest, true)
      }
    }
    if (now >= this.nextRegen) {
      this.nextRegen = now + REGEN_EVERY_MS
      this.regen(now)
    }
    if (now >= this.nextSave) {
      this.nextSave = now + SAVE_EVERY_MS
      for (const e of this.entities.values()) if (e.player) this.persist(e)
    }
    for (const x of this.extensions) if (x.tick) this.extension(() => x.tick!(this.mockCtx, now))
  }

  private regen(now: number): void {
    for (const e of this.entities.values()) {
      if (e.player) {
        const p = e.player.prog
        if (p.dead || now - e.player.lastCombat < OUT_OF_COMBAT_MS) continue
        const s = deriveStats(p, this.content)
        if (p.hp >= s.maxHp && p.mp >= s.maxMp) continue
        p.hp = Math.min(s.maxHp, p.hp + Math.max(1, Math.round(s.maxHp * 0.04)))
        p.mp = Math.min(s.maxMp, p.mp + Math.max(1, Math.round(s.maxMp * 0.04)))
        e.state.hp = p.hp
        this.broadcast({ t: 'entityUpdate', id: e.state.id, hp: p.hp })
        e.player.conn.deliver({ t: 'statsDelta', stats: { hp: p.hp, mp: p.mp } })
      } else if (e.mob && e.mob.mode === 'idle' && (e.state.hp ?? 0) < (e.state.maxHp ?? 0)) {
        e.state.hp = Math.min(e.state.maxHp!, e.state.hp! + Math.max(1, Math.round(e.state.maxHp! * 0.1)))
        this.broadcast({ t: 'entityUpdate', id: e.state.id, hp: e.state.hp })
      }
    }
  }

  private weaponOf(ps: PlayerSim) {
    const w = ps.prog.inventory.equip.weapon
    return w ? this.content.items.get(w.code) : undefined
  }

  private playerTick(e: SimEntity, now: number): void {
    const ps = e.player!
    if (ps.prog.dead) return
    if (ps.casting && now >= ps.casting.until) {
      ps.casting = null
      this.cancelAction(e)
      this.warp(e, SPAWN[0] + (this.rand() - 0.5) * 3, SPAWN[2] + (this.rand() - 0.5) * 3)
      ps.conn.deliver({ t: 'chat', channel: 'system', text: t('mock.return') })
    }
    const a = ps.action
    if (!a) return
    if (a.kind === 'attack') {
      const target = this.entities.get(a.target)
      if (!target?.mob || target.mob.mode === 'dead') {
        ps.action = null
        return
      }
      const reach = (this.weaponOf(ps)?.range ?? BARE_HANDS_RANGE) + PLAYER_RADIUS + target.mob.def.radius
      if (this.dist(e, target) > reach) return this.chase(e, target, reach, RUN_SPEED * (e.speedMul ?? 1), ps)
      this.face(e, target, ps)
      if (now >= ps.nextSwing) {
        const w = this.weaponOf(ps)
        ps.nextSwing = now + (w?.weaponType ? SWING_MS[w.weaponType] : 1000)
        this.playerSwing(e, target, now)
      }
      return
    }
    const item = this.entities.get(a.id)
    if (!item?.item) {
      ps.action = null
      return this.result(ps.conn, 'pickup', false, 'not_found')
    }
    if (this.dist(e, item) > PICKUP_RANGE) return this.chase(e, item, PICKUP_RANGE, RUN_SPEED * (e.speedMul ?? 1), ps)
    ps.action = null
    this.halt(e)
    this.pickup(e, item, now)
  }

  private playerSwing(e: SimEntity, target: SimEntity, now: number): void {
    const ps = e.player!
    const mob = target.mob!
    const s = deriveStats(ps.prog, this.content)
    const family = this.weaponOf(ps)?.weaponType
    const count = family === 'sword' || family === 'blade' ? 2 : 1
    const hitChance = Math.max(0.5, Math.min(0.97, 0.85 + (s.hitRate - mob.def.parryRate) / 200))
    let hp = target.state.hp ?? 0
    const hits: CombatHit[] = []
    for (let i = 0; i < count && hp > 0; i++) {
      if (this.rand() > hitChance) {
        hits.push({ outcome: 'miss', damage: 0, hp })
        continue
      }
      const crit = this.rand() < 0.12
      const roll = randInt(this.rand, s.physAttack[0], s.physAttack[1]) * (count > 1 ? 0.6 : 1) - mob.def.physDefence * 0.5
      const damage = Math.max(1, Math.round(roll * (crit ? 2 : 1)))
      hp = Math.max(0, hp - damage)
      hits.push({ outcome: crit ? 'crit' : 'hit', damage, hp })
    }
    target.state.hp = hp
    ps.lastCombat = now
    const killed = hp <= 0
    this.broadcast(killed ? { t: 'combat', attacker: e.state.id, target: target.state.id, hits, killed: true } : { t: 'combat', attacker: e.state.id, target: target.state.id, hits })
    if (killed) return this.mobDies(target, e)
    // Every mob retaliates when hit (unless it is already walking home).
    if (mob.mode === 'idle' || (mob.mode === 'chase' && mob.target === null)) this.aggro(target, e, now)
  }

  private aggro(mobE: SimEntity, player: SimEntity, now: number): void {
    const m = mobE.mob!
    m.mode = 'chase'
    m.target = player.state.id
    m.chaseAim = null
    m.nextSwing = Math.max(m.nextSwing, now + 500)
  }

  private mobTick(e: SimEntity, now: number): void {
    const m = e.mob!
    switch (m.mode) {
      case 'dead':
        if (now >= m.despawnAt) this.removeEntity(e)
        return
      case 'idle': {
        if (m.aggressive) {
          const pos = this.currentPos(e)
          let best: SimEntity | null = null
          let bestD = m.sight
          for (const p of this.entities.values()) {
            if (!p.player || p.player.prog.dead || p.state.invisible) continue
            const q = this.currentPos(p)
            const d = Math.hypot(q[0] - pos[0], q[2] - pos[2])
            if (d < bestD) {
              best = p
              bestD = d
            }
          }
          if (best) return this.aggro(e, best, now)
        }
        if (!e.state.move && now >= m.nextWander) {
          m.nextWander = now + 4000 + this.rand() * 6000
          const r = m.nest ? m.nest.radius : 4
          const a = this.rand() * Math.PI * 2
          const d = this.rand() * r
          this.startMove(e, [m.home[0] + Math.cos(a) * d, m.home[1], m.home[2] + Math.sin(a) * d], m.def.walkSpeed)
        }
        return
      }
      case 'chase': {
        const target = m.target !== null ? this.entities.get(m.target) : undefined
        if (!target?.player || target.player.prog.dead || target.state.invisible) return this.goHome(e)
        const pos = this.currentPos(e)
        if (Math.hypot(pos[0] - m.home[0], pos[2] - m.home[2]) > m.leash) return this.goHome(e)
        const reach = m.def.attackRange + m.def.radius + PLAYER_RADIUS
        if (this.dist(e, target) > reach) return this.chase(e, target, reach, m.def.runSpeed, m)
        this.face(e, target, m)
        if (now >= m.nextSwing) {
          m.nextSwing = now + m.def.attackIntervalMs
          this.mobSwing(e, target, now)
        }
        return
      }
      case 'return': {
        const pos = this.currentPos(e)
        if (Math.hypot(pos[0] - m.home[0], pos[2] - m.home[2]) < 1) {
          m.mode = 'idle'
          m.nextWander = now + 2000
          if (e.state.hp !== e.state.maxHp) {
            e.state.hp = e.state.maxHp
            this.broadcast({ t: 'entityUpdate', id: e.state.id, hp: e.state.hp! })
          }
        } else if (!e.state.move) this.startMove(e, [...m.home], m.def.runSpeed)
      }
    }
  }

  private goHome(e: SimEntity): void {
    const m = e.mob!
    m.mode = 'return'
    m.target = null
    m.chaseAim = null
    this.startMove(e, [...m.home], m.def.runSpeed)
  }

  private mobSwing(e: SimEntity, target: SimEntity, now: number): void {
    const m = e.mob!
    const ps = target.player!
    const p = ps.prog
    const s = deriveStats(p, this.content)
    const hitChance = Math.max(0.4, Math.min(0.95, 0.8 + (m.def.hitRate - s.parryRate) / 200))
    let hit: CombatHit
    if (this.rand() > hitChance) {
      hit = { outcome: 'miss', damage: 0, hp: p.hp }
    } else {
      const crit = this.rand() < (m.def.critRate ?? 5) / 100
      const roll = (randInt(this.rand, m.def.physAttack[0], m.def.physAttack[1]) - s.physDefence * 0.4) * Math.sqrt(m.mul)
      const damage = Math.max(1, Math.round(roll * (crit ? 2 : 1)))
      p.hp = Math.max(0, p.hp - damage)
      hit = { outcome: crit ? 'crit' : 'hit', damage, hp: p.hp }
    }
    target.state.hp = p.hp
    ps.lastCombat = now
    const killed = p.hp <= 0
    this.broadcast(killed ? { t: 'combat', attacker: e.state.id, target: target.state.id, hits: [hit], killed: true } : { t: 'combat', attacker: e.state.id, target: target.state.id, hits: [hit] })
    ps.conn.deliver({ t: 'statsDelta', stats: { hp: p.hp } })
    if (killed) this.playerDies(target)
  }

  private playerDies(e: SimEntity): void {
    const ps = e.player!
    ps.prog.dead = true
    ps.prog.hp = 0
    ps.casting = null
    this.cancelAction(e)
    this.halt(e)
    e.state.hp = 0
    e.state.state = 'dead'
    this.broadcast({ t: 'entityUpdate', id: e.state.id, hp: 0, state: 'dead' })
    for (const o of this.entities.values()) if (o.mob && o.mob.mode === 'chase' && o.mob.target === e.state.id) this.goHome(o)
  }

  /** A mob dies: corpse, nest respawn timer, and (with a killer) EXP/SP and loot. */
  private mobDies(e: SimEntity, killer: SimEntity | null): void {
    const m = e.mob!
    const now = this.now()
    if (e.state.move) {
      e.state.pos = this.currentPos(e)
      e.state.move = undefined
      this.broadcast({ t: 'stop', id: e.state.id, pos: e.state.pos, yaw: e.state.yaw })
    }
    m.mode = 'dead'
    m.target = null
    m.despawnAt = now + CORPSE_MS
    e.state.hp = 0
    e.state.state = 'dead'
    this.broadcast({ t: 'entityUpdate', id: e.state.id, hp: 0, state: 'dead' })
    if (m.nest) {
      m.nest.alive.delete(e.state.id)
      m.nest.pending.push(now + randInt(this.rand, m.nest.respawnSec[0], m.nest.respawnSec[1]) * 1000)
      m.nest.pending.sort((a, b) => a - b)
    }
    if (!killer?.player) return
    this.grantExp(killer, e)
    const pos = this.currentPos(e)
    for (const drop of rollDrops(this.content.drops.get(m.def.code), this.rand, this.content, m.mul)) {
      const a = this.rand() * Math.PI * 2
      const r = 0.4 + this.rand() * 0.9
      this.spawnItem(drop.code, drop.count, [pos[0] + Math.cos(a) * r, pos[1], pos[2] + Math.sin(a) * r], killer.state.id, undefined, pos)
    }
  }

  private grantExp(e: SimEntity, mobE: SimEntity): void {
    const ps = e.player!
    const p = ps.prog
    const def = mobE.mob!.def
    const exp = p.level >= LEVEL_CAP ? 0 : Math.round(def.exp * mobE.mob!.mul)
    const spExp = Math.round((def.spExp ?? def.exp) * mobE.mob!.mul)
    p.exp += exp
    p.spExp += spExp
    p.sp += Math.floor(p.spExp / CHARACTER_RULES.spExpPerSp)
    p.spExp %= CHARACTER_RULES.spExpPerSp
    const before = p.level
    this.levelUpWhileEnough(p)
    const s = deriveStats(p, this.content)
    ps.conn.deliver({ t: 'statsDelta', stats: { exp: p.exp, expToNext: s.expToNext, sp: p.sp, spExp: p.spExp }, gain: { exp, spExp, from: mobE.state.id } })
    if (p.level !== before) this.announceLevel(e)
  }

  private levelUpWhileEnough(p: Progress): void {
    for (;;) {
      const need = expToNext(this.content, p.level, LEVEL_CAP)
      if (!need || p.exp < need) break
      p.exp -= need
      p.level++
      p.str++
      p.int++
      p.statPoints += CHARACTER_RULES.statPointsPerLevel
    }
    if (p.level >= LEVEL_CAP) p.exp = 0
  }

  /** After a level change: refill, levelUp + entityUpdate to viewers, full stats to the owner. */
  private announceLevel(e: SimEntity, effect = true): void {
    const ps = e.player!
    const p = ps.prog
    const s0 = deriveStats(p, this.content)
    p.hp = s0.maxHp
    p.mp = s0.maxMp
    const s = deriveStats(p, this.content)
    e.state.level = p.level
    e.state.hp = p.hp
    e.state.maxHp = s.maxHp
    if (effect) this.broadcast({ t: 'levelUp', id: e.state.id, level: p.level })
    this.broadcast({ t: 'entityUpdate', id: e.state.id, level: p.level, maxHp: s.maxHp, hp: p.hp })
    ps.conn.deliver({ t: 'stats', stats: s })
    this.persist(e)
  }

  private spawnNestMob(nest: NestSim, announce: boolean): void {
    const def = this.content.mobs.get(nest.mob)
    if (!def) return
    const a = this.rand() * Math.PI * 2
    const r = this.rand() * nest.radius
    const variant: MobVariant = def.variants?.includes('champion') && this.rand() * 100 < nest.championPct ? 'champion' : 'normal'
    const e = this.spawnMob(def, [SPAWN[0] + nest.x + Math.cos(a) * r, SPAWN[1], SPAWN[2] + nest.z + Math.sin(a) * r], nest, variant, announce)
    nest.alive.add(e.state.id)
  }

  private spawnMob(def: MobDef, pos: Vec3, nest: NestSim | null, variant: MobVariant, announce: boolean): SimEntity {
    const mul = variant === 'normal' ? 1 : VARIANT_MUL[variant] ?? 1
    const maxHp = Math.round(def.hp * mul)
    const e: SimEntity = {
      bot: false,
      nextThink: Infinity,
      mob: {
        def,
        nest,
        home: nest ? [SPAWN[0] + nest.x, SPAWN[1], SPAWN[2] + nest.z] : [...pos],
        mode: 'idle',
        target: null,
        nextSwing: 0,
        nextWander: this.now() + 1000 + this.rand() * 5000,
        despawnAt: 0,
        chaseAim: null,
        aggressive: nest ? nest.aggressive : def.aggressive,
        sight: nest?.sight ?? 8,
        leash: nest?.leash ?? 30,
        mul,
      },
      state: { id: this.nextEntityId++, kind: 'mob', name: def.name ?? def.code, model: def.code, level: def.level, pos, yaw: this.rand() * Math.PI * 2, hp: maxHp, maxHp },
    }
    if (variant !== 'normal') e.state.variant = variant
    this.entities.set(e.state.id, e)
    if (announce) this.broadcast({ t: 'spawn', entity: this.snapshot(e) })
    return e
  }

  /** `from`: the corpse a drop is thrown from (wave 7B droppedAt / dropFrom: the client tosses fresh drops). */
  private spawnItem(code: string, count: number, pos: Vec3, owner?: number, plus?: number, from?: Vec3): SimEntity {
    const now = this.now()
    const def = this.content.items.get(code)
    const e: SimEntity = {
      bot: false,
      nextThink: Infinity,
      item: { code, count, plus },
      state: { id: this.nextEntityId++, kind: 'item', name: def?.name ?? code, model: code, level: 0, pos, yaw: this.rand() * Math.PI * 2, count, expiresAt: now + ITEM_EXPIRE_MS },
    }
    if (plus) e.state.plus = plus
    if (from) {
      e.state.droppedAt = Math.max(0, Math.round(now))
      e.state.dropFrom = [from[0], from[1], from[2]]
    }
    if (owner !== undefined) {
      e.state.owner = owner
      e.state.ownerUntil = now + ITEM_OWNER_MS
    }
    this.entities.set(e.state.id, e)
    this.broadcast({ t: 'spawn', entity: this.snapshot(e) })
    return e
  }

  private removeEntity(e: SimEntity): void {
    this.entities.delete(e.state.id)
    this.broadcast({ t: 'despawn', id: e.state.id })
  }

  private pickup(e: SimEntity, item: SimEntity, now: number): void {
    const ps = e.player!
    const inv = ps.prog.inventory
    const it = item.item!
    if (item.state.owner !== undefined && item.state.owner !== e.state.id && now < (item.state.ownerUntil ?? 0)) return this.result(ps.conn, 'pickup', false, 'not_owner')
    if (isGold(it.code)) {
      inv.gold += it.count
      this.result(ps.conn, 'pickup', true)
      this.removeEntity(item)
      ps.conn.deliver({ t: 'inventoryUpdate', gold: inv.gold })
      return
    }
    const bag = addToBag(inv, this.content.items.get(it.code), it.code, it.count, it.plus)
    if (!bag) return this.result(ps.conn, 'pickup', false, 'inventory_full')
    this.result(ps.conn, 'pickup', true)
    this.removeEntity(item)
    ps.conn.deliver({ t: 'inventoryUpdate', bag })
  }

  /** Ends the current action; a pickup still walking gets its (only) actionResult now. */
  private cancelAction(e: SimEntity): void {
    const ps = e.player
    if (!ps?.action) return
    if (ps.action.kind === 'pickup') this.result(ps.conn, 'pickup', false, 'unreachable', t('mock.pickupCancelled'))
    ps.action = null
    ps.chaseAim = null
  }

  private result(conn: Conn, re: GameplayRequest, ok: boolean, reason?: ActionFailReason, message?: string): void {
    const msg: ServerMessage = { t: 'actionResult', re, ok }
    if (reason) msg.reason = reason
    if (message) msg.message = message
    conn.deliver(msg)
  }

  // ---- gameplay requests (docs/PROTOCOL.md sections 3-9) ---------------------------------------

  private gameplay(conn: Conn, msg: ClientMessage): void {
    const e = this.selfOf(conn)
    if (!e?.player) return this.error(conn, 'not_in_world', t('mock.notInWorld'), msg.t)
    const ps = e.player
    const p = ps.prog
    const inv = p.inventory
    const re = msg.t as GameplayRequest
    const ok = () => this.result(conn, re, true)
    const no = (reason: ActionFailReason) => this.result(conn, re, false, reason)
    const now = this.now()
    if (p.dead && msg.t !== 'respawn') return no('dead')
    const bagItem = (slot: number) => (slot < inv.bagSize ? inv.bag[slot] ?? null : null)
    const sendStats = () => {
      const s = deriveStats(p, this.content)
      e.state.maxHp = s.maxHp
      e.state.hp = p.hp
      conn.deliver({ t: 'stats', stats: s })
    }
    const appearance = () => {
      e.state.equip = visibleEquip(inv)
      const w = inv.equip.weapon
      const fam = w ? weaponFamilyOf(w.code, this.content.items.get(w.code)) : undefined
      if (fam) e.state.weapon = fam
      this.broadcast({ t: 'appearance', id: e.state.id, equip: e.state.equip })
    }
    switch (msg.t) {
      case 'attack': {
        const target = this.entities.get(msg.target)
        if (!target || (target.state.invisible && target.player)) return no('not_found')
        if (!target.mob) return no('invalid_target')
        if (target.mob.mode === 'dead') return no('target_dead')
        this.cancelAction(e)
        ps.action = { kind: 'attack', target: msg.target }
        ps.nextSwing = Math.max(ps.nextSwing, now)
        ok()
        this.playerTick(e, now)
        return
      }
      case 'stopAction':
        if (ps.action?.kind === 'attack' && e.state.move) this.halt(e)
        this.cancelAction(e)
        return ok()
      case 'useSkill':
        return no('not_implemented')
      case 'pickup': {
        const item = this.entities.get(msg.id)
        if (!item?.item) return no('not_found')
        if (item.state.owner !== undefined && item.state.owner !== e.state.id && now < (item.state.ownerUntil ?? 0)) return no('not_owner')
        if (!isGold(item.item.code)) {
          const probe = { ...inv, bag: inv.bag.map(s => (s ? { ...s } : null)) }
          if (!addToBag(probe, this.content.items.get(item.item.code), item.item.code, item.item.count, item.item.plus)) return no('inventory_full')
        }
        this.cancelAction(e)
        // Answered when the pickup happens (or fails / is cancelled), after walking there if needed.
        ps.action = { kind: 'pickup', id: msg.id }
        this.playerTick(e, now)
        return
      }
      case 'respawn': {
        if (!p.dead) return no('not_dead')
        p.dead = false
        const s = deriveStats(p, this.content)
        p.hp = s.maxHp
        p.mp = s.maxMp
        e.state.state = undefined
        e.state.hp = p.hp
        ok()
        this.warp(e, SPAWN[0] + (this.rand() - 0.5) * 3, SPAWN[2] + (this.rand() - 0.5) * 3)
        this.broadcast({ t: 'entityUpdate', id: e.state.id, state: 'alive', hp: p.hp, maxHp: s.maxHp })
        conn.deliver({ t: 'stats', stats: deriveStats(p, this.content) })
        this.persist(e)
        return
      }
      case 'statUp': {
        if (msg.points > p.statPoints) return no('no_points')
        p.statPoints -= msg.points
        if (msg.stat === 'str') p.str += msg.points
        else p.int += msg.points
        ok()
        sendStats()
        this.broadcast({ t: 'entityUpdate', id: e.state.id, hp: p.hp, maxHp: e.state.maxHp! }, conn)
        return
      }
      case 'itemMove': {
        const from = bagItem(msg.from)
        if (!from || msg.from === msg.to || msg.to >= inv.bagSize) return no('invalid_slot')
        const to = inv.bag[msg.to] ?? null
        const max = this.content.items.get(from.code)?.maxStack ?? 1
        if (to && to.code === from.code && (to.plus ?? 0) === (from.plus ?? 0) && max > 1 && to.count < max) {
          const n = Math.min(from.count, max - to.count)
          to.count += n
          from.count -= n
          if (from.count <= 0) inv.bag[msg.from] = null
        } else {
          inv.bag[msg.to] = from
          inv.bag[msg.from] = to
        }
        ok()
        conn.deliver({ t: 'inventoryUpdate', bag: [{ slot: msg.from, item: clone(inv.bag[msg.from] ?? null) }, { slot: msg.to, item: clone(inv.bag[msg.to] ?? null) }] })
        return
      }
      case 'itemSplit': {
        const from = bagItem(msg.from)
        if (!from || msg.from === msg.to || msg.to >= inv.bagSize || inv.bag[msg.to]) return no('invalid_slot')
        if (msg.count >= from.count) return no('invalid_count')
        from.count -= msg.count
        inv.bag[msg.to] = { ...from, count: msg.count }
        ok()
        conn.deliver({ t: 'inventoryUpdate', bag: [{ slot: msg.from, item: clone(from) }, { slot: msg.to, item: clone(inv.bag[msg.to]!) }] })
        return
      }
      case 'itemEquip': {
        const st = bagItem(msg.bag)
        const def = st ? this.content.items.get(st.code) : undefined
        if (!st || !def?.slot) return no('invalid_slot')
        const allowed = equipSlotsFor(def.slot)
        let slot: EquipSlot
        if (msg.slot) {
          if (!allowed.includes(msg.slot)) return no('invalid_slot')
          slot = msg.slot
        } else slot = allowed.find(s => !inv.equip[s]) ?? allowed[0]!
        if (def.reqLevel > p.level) return no('requirements')
        if (def.reqGender !== 'any' && (def.reqGender === 'female') !== ps.female) return no('requirements')
        if (def.race === 'europe') return no('requirements')
        const weapon = this.weaponOf(ps)
        if (def.slot === 'shield' && weapon?.twoHanded) return no('requirements')
        // The server's garment rule (armorClassesClash): the pieces left on must agree with the new one.
        const clash = (Object.entries(inv.equip) as [EquipSlot, { code: string } | undefined][]).some(([s, worn]) => {
          const type = s !== slot && worn ? this.content.items.get(worn.code)?.armorType : undefined
          return !!type && !!def.armorType && armorClassesClash(def.armorType, type)
        })
        if (clash) return no('armor_mix')
        const bagUpdates: BagSlotUpdate[] = []
        const equipUpdates: EquipSlotUpdate[] = []
        const shield = inv.equip.shield
        let shieldTo = -1
        if (def.slot === 'weapon' && def.twoHanded && shield) {
          // The vacated slot takes the old weapon; the shield needs another free slot.
          const prevWeapon = inv.equip.weapon
          for (let i = 0; i < inv.bagSize; i++) if (!inv.bag[i] && i !== msg.bag) { shieldTo = i; break }
          if (shieldTo < 0 && prevWeapon) return no('inventory_full')
          if (shieldTo < 0) shieldTo = msg.bag
        }
        const prev = inv.equip[slot]
        inv.equip[slot] = st
        inv.bag[msg.bag] = prev ?? null
        if (shieldTo >= 0 && shield) {
          inv.bag[shieldTo] = shield
          delete inv.equip.shield
          equipUpdates.push({ slot: 'shield', item: null })
          if (shieldTo !== msg.bag) bagUpdates.push({ slot: shieldTo, item: clone(shield) })
        }
        bagUpdates.unshift({ slot: msg.bag, item: clone(inv.bag[msg.bag] ?? null) })
        equipUpdates.unshift({ slot, item: clone(st) })
        ok()
        conn.deliver({ t: 'inventoryUpdate', bag: bagUpdates, equip: equipUpdates })
        appearance()
        sendStats()
        return
      }
      case 'itemUnequip': {
        const st = inv.equip[msg.slot]
        if (!st) return no('invalid_slot')
        const dest = msg.bag ?? firstFree(inv)
        if (msg.bag !== undefined && (msg.bag >= inv.bagSize || inv.bag[msg.bag])) return no('invalid_slot')
        if (dest < 0) return no('inventory_full')
        inv.bag[dest] = st
        delete inv.equip[msg.slot]
        ok()
        conn.deliver({ t: 'inventoryUpdate', bag: [{ slot: dest, item: clone(st) }], equip: [{ slot: msg.slot, item: null }] })
        appearance()
        sendStats()
        return
      }
      case 'itemUse': {
        const st = bagItem(msg.bag)
        const def = st ? this.content.items.get(st.code) : undefined
        if (!st) return no('invalid_slot')
        const use = def?.use
        if (!use) return no('not_usable')
        const group = use.cooldownGroup ?? st.code
        if (now < (ps.cooldowns.get(group) ?? 0)) return no('cooldown')
        const cooldownMs = use.cooldownMs ?? (use.cooldownGroup ? POTION_COOLDOWN_MS : 0)
        if (cooldownMs) ps.cooldowns.set(group, now + cooldownMs)
        st.count--
        if (st.count <= 0) inv.bag[msg.bag] = null
        ok()
        conn.deliver({ t: 'inventoryUpdate', bag: [{ slot: msg.bag, item: clone(inv.bag[msg.bag] ?? null) }] })
        if (use.returnToTown) {
          const castMs = Math.min(use.castMs ?? 0, MAX_RETURN_CAST_MS)
          ps.casting = { until: now + castMs }
          if (castMs > 0) conn.deliver({ t: 'chat', channel: 'system', text: t('mock.returnCast', { s: Math.round(castMs / 1000) }) })
          return
        }
        // The drinker and everyone in view see the item's effect (apps/server/src/item-use.ts; wave 7B FX-S / FX-C2).
        this.broadcast({ t: 'itemEffect', id: e.state.id, item: st.code })
        const s = deriveStats(p, this.content)
        p.hp = Math.min(s.maxHp, p.hp + (use.hp ?? 0) + Math.round(((use.hpPct ?? 0) * s.maxHp) / 100))
        p.mp = Math.min(s.maxMp, p.mp + (use.mp ?? 0) + Math.round(((use.mpPct ?? 0) * s.maxMp) / 100))
        e.state.hp = p.hp
        this.broadcast({ t: 'entityUpdate', id: e.state.id, hp: p.hp })
        conn.deliver({ t: 'statsDelta', stats: { hp: p.hp, mp: p.mp } })
        return
      }
      case 'itemDrop': {
        const st = bagItem(msg.bag)
        if (!st) return no('invalid_slot')
        if (this.content.items.get(st.code)?.canDrop === false) return no('not_usable')
        const count = msg.count ?? st.count
        if (count > st.count) return no('invalid_count')
        st.count -= count
        if (st.count <= 0) inv.bag[msg.bag] = null
        ok()
        conn.deliver({ t: 'inventoryUpdate', bag: [{ slot: msg.bag, item: clone(inv.bag[msg.bag] ?? null) }] })
        const pos = this.currentPos(e)
        const a = this.rand() * Math.PI * 2
        this.spawnItem(st.code, count, [pos[0] + Math.cos(a) * 0.6, pos[1], pos[2] + Math.sin(a) * 0.6], undefined, st.plus)
        return
      }
      case 'shopBuy':
      case 'shopSell': {
        const npcE = this.entities.get(msg.npc)
        if (!npcE?.npc) return no('not_found')
        if (this.dist(e, npcE) > NPC_INTERACT_RANGE) return no('too_far')
        const shopId = this.content.npcs.get(npcE.npc.code)?.shop
        const shop = shopId ? this.content.shops.get(shopId) : undefined
        if (msg.t === 'shopBuy') {
          if (!shop?.tabs.some(tab => tab.items.includes(msg.item))) return no('not_found')
          const def = this.content.items.get(msg.item)
          if (!def) return no('not_found')
          const cost = def.price * msg.count
          if (inv.gold < cost) return no('not_enough_gold')
          const bag = addToBag(inv, def, def.code, msg.count)
          if (!bag) return no('inventory_full')
          inv.gold -= cost
          ok()
          conn.deliver({ t: 'inventoryUpdate', bag, gold: inv.gold })
          conn.deliver({ t: 'statsDelta', stats: { gold: inv.gold } })
          return
        }
        const st = bagItem(msg.bag)
        if (!st) return no('invalid_slot')
        const def = this.content.items.get(st.code)
        if (def?.canSell === false) return no('not_usable')
        const count = msg.count ?? st.count
        if (count > st.count) return no('invalid_count')
        st.count -= count
        if (st.count <= 0) inv.bag[msg.bag] = null
        inv.gold += (def?.sellPrice ?? 0) * count
        ok()
        conn.deliver({ t: 'inventoryUpdate', bag: [{ slot: msg.bag, item: clone(inv.bag[msg.bag] ?? null) }], gold: inv.gold })
        conn.deliver({ t: 'statsDelta', stats: { gold: inv.gold } })
        return
      }
      case 'sit':
      case 'emote':
        // Wave 7B placeholders (docs/WAVE_PLAN2.md §5.1): a mock extension (x.handle) may answer them first.
        return no('not_implemented')
      case 'jump':
        // Wave 10 (docs/WAVE_PLAN6.md §3.2): net/mock/movement.ts answers it first.
        return no('not_implemented')
      case 'mountRide':
      case 'mountDismount':
      case 'mountDismiss':
      case 'repair':
      case 'alchemyReinforce':
      case 'alchemyCancel':
      case 'berserk':
      case 'tradeRequest':
      case 'tradeRespond':
      case 'tradeOffer':
      case 'tradeTake':
      case 'tradeGold':
      case 'tradeLock':
      case 'tradeAccept':
      case 'tradeCancel':
      case 'stallCreate':
      case 'stallItem':
      case 'stallItemRemove':
      case 'stallText':
      case 'stallOpen':
      case 'stallClose':
      case 'stallVisit':
      case 'stallLeave':
      case 'stallBuy':
      case 'guildCreate':
      case 'guildDisband':
      case 'guildInvite':
      case 'guildRespond':
      case 'guildLeave':
      case 'guildKick':
      case 'guildPerms':
      case 'guildTitle':
      case 'guildNotice':
      case 'guildMaster':
        // Wave 8 placeholders (docs/WAVE_PLAN2.md §6.1): the lanes' mock extensions (net/mock/*) may answer them first.
        return no('not_implemented')
      default:
        // Wave 3 requests (docs/WAVE_PLAN.md §2.1) until the lane mocks exist: still exactly one actionResult.
        return no('not_implemented')
    }
  }

  // ---- GM (mirrors apps/server/src/gm.ts; replies are the mock's own English) ----------------------

  private gm(conn: Conn, cmd: string, args: string[], re: 'gm' | 'chat'): void {
    if (!isStaff(conn.role)) return this.error(conn, 'forbidden', re === 'chat' ? t('mock.gm.slashForbidden') : t('mock.gm.forbidden'), re)
    const self = this.selfOf(conn)
    const reply = (ok: boolean, message: string, data?: unknown) =>
      conn.deliver(data === undefined ? { t: 'gmResult', ok, cmd, message } : { t: 'gmResult', ok, cmd, message, data })
    const worldOnly = ['tp', 'summon', 'speed', 'invis', 'spawn', 'item']
    if (worldOnly.includes(cmd) && !self) return reply(false, t('mock.gm.needWorld', { cmd }))
    const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1)
    const find = (raw: string) => {
      const name = raw.replace(/^@/, '').toLowerCase()
      return this.players().find(e => e.state.name.toLowerCase() === name)
    }
    switch (cmd) {
      case 'help':
        return reply(true, t('mock.gm.help', { cap: LEVEL_CAP }))
      case 'who': {
        const players = this.players().map(e => this.gmInfo(e)).sort((a, b) => a.name.localeCompare(b.name))
        const lines = players.map(p => t('mock.gm.whoLine', { name: p.name, level: p.level, x: fmt(p.pos[0]), z: fmt(p.pos[2]) }))
        return reply(true, [t('mock.gm.whoHead', { count: players.length }), ...lines].join('\n'), { players })
      }
      case 'where': {
        const e = args[0] ? find(args[0]) : self
        if (!e) return reply(false, t('mock.gm.noPlayer', { name: args[0] ?? '' }))
        const i = this.gmInfo(e)
        return reply(true, t('mock.gm.whoLine', { name: i.name, level: i.level, x: fmt(i.pos[0]), z: fmt(i.pos[2]) }), i)
      }
      case 'tp': {
        const me = self!
        const presets = [{ name: 'jangan', x: SPAWN[0], z: SPAWN[2] }, { name: 'spawn', x: SPAWN[0], z: SPAWN[2] }]
        if (args.length === 0) return reply(true, t('mock.gm.places', { list: presets.map(p => p.name).join(', ') }), { presets })
        if (args.length === 2 && args.every(a => a.trim() !== '' && Number.isFinite(Number(a)))) {
          this.cancelAction(me)
          const pos = this.warp(me, Number(args[0]), Number(args[1]))
          return reply(true, t('mock.gm.teleported', { x: fmt(pos[0]), z: fmt(pos[2]) }), { pos })
        }
        if (args.length !== 1) return reply(false, t('mock.gm.tpUsage'))
        const preset = args[0]!.startsWith('@') ? undefined : presets.find(p => p.name === args[0]!.toLowerCase())
        if (preset) {
          this.cancelAction(me)
          const pos = this.warp(me, preset.x, preset.z)
          return reply(true, t('mock.gm.teleportedTo', { name: preset.name, x: fmt(pos[0]), z: fmt(pos[2]) }), { pos, place: preset.name })
        }
        const target = find(args[0]!)
        if (!target) return reply(false, t('mock.gm.noPlace', { name: args[0]! }))
        if (target === me) return reply(false, t('mock.gm.already'))
        const tp = this.currentPos(target)
        this.cancelAction(me)
        const pos = this.warp(me, tp[0], tp[2])
        return reply(true, t('mock.gm.teleportedTo', { name: target.state.name, x: fmt(pos[0]), z: fmt(pos[2]) }), { pos, player: target.state.name })
      }
      case 'summon': {
        const me = self!
        const target = args.length === 1 ? find(args[0]!) : undefined
        if (!target) return reply(false, t('mock.gm.noPlayer', { name: args[0] ?? '' }))
        if (target === me) return reply(false, t('mock.gm.summonSelf'))
        const at = this.currentPos(me)
        this.cancelAction(target)
        const pos = this.warp(target, at[0] + Math.sin(me.state.yaw), at[2] + Math.cos(me.state.yaw))
        if (target.bot) target.nextThink = this.now() + 8000
        return reply(true, t('mock.gm.summoned', { name: target.state.name, x: fmt(pos[0]), z: fmt(pos[2]) }), { pos, player: target.state.name })
      }
      case 'kick': {
        const target = args[0] ? find(args[0]) : undefined
        if (!target) return reply(false, t('mock.gm.noPlayer', { name: args[0] ?? '' }))
        if (target === self) return reply(false, t('mock.gm.kickSelf'))
        const reason = args.slice(1).join(' ').trim()
        const owner = [...this.conns].find(c => c.entityId === target.state.id)
        if (owner) {
          owner.deliver({ t: 'chat', channel: 'system', text: reason ? t('net.kickedWhy', { reason }) : t('net.kicked') })
          owner.close?.(CLOSE_CODE.kicked, reason ? `kicked: ${reason}` : 'kicked')
        } else {
          this.entities.delete(target.state.id)
          this.broadcast({ t: 'despawn', id: target.state.id })
        }
        return reply(true, t('mock.gm.kicked', { name: target.state.name }), { player: target.state.name })
      }
      case 'notice': {
        const text = args.join(' ').trim()
        if (!text) return reply(false, t('mock.gm.noticeUsage'))
        const from = self?.state.name ?? conn.account
        for (const c of this.conns) c.deliver({ t: 'notice', text, from })
        return reply(true, t('mock.gm.noticeSent', { count: this.conns.size }), { recipients: this.conns.size })
      }
      case 'setlevel': {
        const level = Number(args[1])
        if (args.length !== 2 || !Number.isInteger(level) || level < 1 || level > LEVEL_CAP) return reply(false, t('mock.gm.levelUsage', { cap: LEVEL_CAP }))
        const target = find(args[0]!)
        if (!target) return reply(false, t('mock.gm.noPlayer', { name: args[0]! }))
        const db = this.load()
        for (const acc of Object.values(db.accounts)) for (const ch of acc.characters) if (ch.name.toLowerCase() === target.state.name.toLowerCase()) ch.level = level
        this.save(db)
        if (target.player) {
          const p = target.player.prog
          const d = level - p.level
          const up = d > 0
          p.level = level
          p.exp = 0
          p.str = Math.max(CHARACTER_RULES.baseStr, p.str + d)
          p.int = Math.max(CHARACTER_RULES.baseInt, p.int + d)
          p.statPoints = Math.max(0, p.statPoints + CHARACTER_RULES.statPointsPerLevel * d)
          this.announceLevel(target, up)
        } else {
          target.state.level = level
          this.broadcast({ t: 'entityUpdate', id: target.state.id, level })
        }
        return reply(true, t('mock.gm.levelSet', { name: target.state.name, level }), { player: target.state.name, level, online: true })
      }
      case 'speed': {
        const me = self!
        if (args.length === 0) return reply(true, t('mock.gm.speed', { speed: me.speedMul ?? 1 }), { speed: me.speedMul ?? 1 })
        const mul = Number(args[0])
        if (args.length !== 1 || !Number.isFinite(mul) || mul < 0.5 || mul > 5) return reply(false, t('mock.gm.speedUsage'))
        me.speedMul = mul
        if (me.state.move) this.startMove(me, me.state.move.to, RUN_SPEED * mul)
        return reply(true, t('mock.gm.speed', { speed: mul }), { speed: mul })
      }
      case 'invis': {
        const me = self!
        const a = (args[0] ?? '').toLowerCase()
        const on = args.length === 0 ? !me.state.invisible : a === 'on' ? true : a === 'off' ? false : null
        if (on === null) return reply(false, t('mock.gm.invisUsage'))
        me.state.invisible = on || undefined
        // Every mock viewer is staff in GM mode, so they all keep seeing the GM (faded).
        this.broadcast({ t: 'entityUpdate', id: me.state.id, invisible: on })
        return reply(true, on ? t('mock.gm.invisOn') : t('mock.gm.invisOff'), { invisible: on })
      }
      case 'heal': {
        const target = args[0] ? find(args[0]) : self
        if (!target) return reply(false, t('mock.gm.noPlayer', { name: args[0] ?? '' }))
        const ps = target.player
        if (ps) {
          const p = ps.prog
          const s = deriveStats(p, this.content)
          const wasDead = p.dead
          p.dead = false
          p.hp = s.maxHp
          p.mp = s.maxMp
          target.state.hp = p.hp
          target.state.maxHp = s.maxHp
          target.state.state = undefined
          this.broadcast(wasDead ? { t: 'entityUpdate', id: target.state.id, hp: p.hp, maxHp: s.maxHp, state: 'alive' } : { t: 'entityUpdate', id: target.state.id, hp: p.hp, maxHp: s.maxHp })
          ps.conn.deliver({ t: 'stats', stats: deriveStats(p, this.content) })
        }
        return reply(true, t('mock.gm.healed', { name: target.state.name }), { id: target.state.id })
      }
      case 'spawn': {
        const code = (args[0] ?? '').toUpperCase()
        const n = args[1] === undefined ? 1 : Number(args[1])
        if (!code || args.length > 2 || !Number.isInteger(n) || n < 1 || n > 50) return reply(false, t('mock.gm.spawnUsage'))
        const def = this.content.mobs.get(code)
        if (!def) return reply(false, t('mock.gm.unknownMob', { code }))
        const at = this.currentPos(self!)
        const ids: number[] = []
        for (let i = 0; i < n; i++) {
          const a = self!.state.yaw + ((i - (n - 1) / 2) * 0.5)
          const r = 3 + (i % 3)
          ids.push(this.spawnMob(def, [at[0] + Math.sin(a) * r, at[1], at[2] + Math.cos(a) * r], null, 'normal', true).state.id)
        }
        return reply(true, t('mock.gm.spawned', { count: n, name: def.name ?? code }), { ids })
      }
      case 'item': {
        const code = (args[0] ?? '').toUpperCase()
        const n = args[1] === undefined ? 1 : Number(args[1])
        if (!code || args.length > 2 || !Number.isInteger(n) || n < 1 || n > 1_000_000) return reply(false, t('mock.gm.itemUsage'))
        const ps = self!.player
        if (!ps) return reply(false, t('mock.gm.needWorld', { cmd }))
        const inv = ps.prog.inventory
        if (isGold(code)) {
          inv.gold += n
          ps.conn.deliver({ t: 'inventoryUpdate', gold: inv.gold })
          ps.conn.deliver({ t: 'statsDelta', stats: { gold: inv.gold } })
          return reply(true, t('mock.gm.goldGiven', { count: n }), { bag: [] })
        }
        const def = this.content.items.get(code)
        if (!def) return reply(false, t('mock.gm.unknownItem', { code }))
        const bag = addToBag(inv, def, code, n)
        if (!bag) return reply(false, t('mock.gm.bagFull'))
        ps.conn.deliver({ t: 'inventoryUpdate', bag })
        return reply(true, t('mock.gm.itemGiven', { count: n, name: def.name ?? code }), { bag })
      }
      case 'kill': {
        if (args.length > 1 || (args[0] !== undefined && !/^\d+$/.test(args[0]))) return reply(false, t('mock.gm.killUsage'))
        const action = self?.player?.action
        const id = args[0] !== undefined ? Number(args[0]) : action?.kind === 'attack' ? action.target : undefined
        if (id === undefined) return reply(false, t('mock.gm.noTarget'))
        const target = this.entities.get(id)
        if (!target) return reply(false, t('mock.gm.noTarget'))
        if (target.mob && target.mob.mode !== 'dead') {
          this.mobDies(target, null)
          return reply(true, t('mock.gm.killed', { name: target.state.name }), { id })
        }
        if (target.player && !target.player.prog.dead) {
          target.player.prog.hp = 0
          this.playerDies(target)
          return reply(true, t('mock.gm.killed', { name: target.state.name }), { id })
        }
        return reply(false, t('mock.gm.cannotKill', { name: target.state.name }))
      }
      default:
        return reply(false, t('mock.gm.unknown', { cmd }))
    }
  }

  private gmInfo(e: SimEntity): GmPlayerInfo {
    const owner = [...this.conns].find(c => c.entityId === e.state.id)
    return {
      id: e.state.id,
      name: e.state.name,
      account: owner?.account ?? 'bot',
      role: owner?.role ?? 'player',
      level: e.state.level,
      pos: this.currentPos(e),
      region: null,
      regionXZ: null,
      invisible: !!e.state.invisible,
      speed: e.speedMul ?? 1,
    }
  }

  private warp(e: SimEntity, x: number, z: number): Vec3 {
    const pos: Vec3 = [x, e.state.pos[1], z]
    e.state.move = undefined
    e.state.pos = pos
    this.broadcast({ t: 'warp', id: e.state.id, pos, yaw: e.state.yaw })
    return pos
  }

  private broadcast(msg: ServerMessage, except?: Conn, only?: Conn): void {
    for (const c of this.conns) {
      if (c === except || c.entityId === undefined) continue
      if (only && c !== only) continue
      c.deliver(msg)
    }
  }
}
