/**
 * The admin panel's HTTP API (docs/ADMIN.md): request and answer bodies of `/api/admin/*`, shared by the game server
 * (apps/server/src/admin) and the panel (apps/admin). Every route but `login` takes `Authorization: Bearer <token>`
 * of an admin session; errors are `ApiError`.
 */

import type { DropTable, EquipSlot, ItemDef, ItemStats } from './content.ts'
import type { GmNestInfo, GmNpcInfo, Role } from './protocol.ts'
import type { QuestIssue } from './quests.ts'

export const ADMIN_API_PREFIX = '/api/admin/'
/** Largest body of most admin routes; the item, drop and quest editors take ADMIN_CONTENT_BODY_MAX_BYTES. */
export const ADMIN_BODY_MAX_BYTES = 4096
export const ADMIN_CONTENT_BODY_MAX_BYTES = 32 * 1024
export const ADMIN_PAGE_SIZE_MAX = 200
export const ADMIN_BAN_REASON_MAX = 200
export const ADMIN_KICK_REASON_MAX = 100
export const ADMIN_NOTICE_MAX = 300

// ---- server identity (no session needed) -------------------------------------------------------------------

/** Version of this API; the panel refuses servers that answer an older one (or none: no admin API at all). */
export const ADMIN_API_VERSION = 1

/**
 * GET /api/admin/info, without a session: which server this is, so the panel's server profiles can show it before
 * logging in (docs/ADMIN.md §2.1). 'local' = bound to a loopback address (a dev server); anything else is 'live'.
 */
export interface AdminInfo {
  admin: true
  apiVersion: number
  name: string
  world: string
  environment: 'live' | 'local'
  release: string
  commit: string | null
}

// ---- session -----------------------------------------------------------------------------------------------

export interface AdminSelf {
  id: number
  username: string
}

/** POST /api/admin/login {username, password} */
export interface AdminLoginResponse {
  token: string
  /** ms since epoch (absolute; an idle session ends earlier, see docs/ADMIN.md §4). */
  expiresAt: number
  account: AdminSelf
}

/** GET /api/admin/me */
export interface AdminMe {
  account: AdminSelf
  expiresAt: number
}

export interface AdminPage<T> {
  total: number
  /** 0-based. */
  page: number
  size: number
  rows: T[]
}

// ---- dashboard ---------------------------------------------------------------------------------------------

export interface AdminServerInfo {
  name: string
  environment: 'live' | 'local'
  /** World id (WORLD) and the export folder the server plays (WORLD_EXPORT). */
  world: string
  worldExport: string
  /** Release folder name (deploy) or 'dev'; commit from the deploy's .deploy-sha when present. */
  release: string
  commit: string | null
  node: string
  startedAt: number
  uptimeS: number
  /** Players in the world, sockets in the lobby, CAPACITY. */
  online: number
  lobby: number
  capacity: number
  /** Gameplay schema version (PRAGMA user_version) and game.db + WAL size in bytes. */
  schema: number
  dbBytes: number
  nav: string
  mobs: number
  tickHz: number
  ticks: number
  /** Ticks per second measured since the previous dashboard poll (null on the first). */
  tickRate: number | null
  worstTickMs: number
  registration: 'open' | 'closed'
  /** A supervisor (systemd) restarts the server when it exits: the Restart button works. */
  restart: boolean
  /** Settings saved in the panel that wait for a restart. */
  pendingRestart: string[]
}

export interface AdminOnlinePlayer {
  characterId: number
  accountId: number
  account: string
  role: Role
  name: string
  level: number
  x: number
  z: number
  zone: string
  dead: boolean
  invisible: boolean
}

export interface AdminDashboard {
  server: AdminServerInfo
  players: AdminOnlinePlayer[]
  /** Connected accounts without a character in the world. */
  lobby: { accountId: number; account: string; role: Role }[]
}

// ---- accounts and characters -------------------------------------------------------------------------------

export interface AdminBan {
  reason: string
  at: number
  by: string
}

export interface AdminAccountRow {
  id: number
  username: string
  role: Role
  createdAt: number
  lastLogin: number | null
  online: boolean
  banned: AdminBan | null
  characters: number
}

export interface AdminCharacterRow {
  id: number
  name: string
  accountId: number
  account: string
  level: number
  model: string
  online: boolean
  lastPlayed: number
}

/** One item in a bag, equipment or storage slot. */
export interface AdminItemSlot {
  /** Bag or storage index, or the equipment slot. */
  slot: number | EquipSlot
  code: string
  name: string | null
  count: number
  plus: number
  durability: number | null
  icon: string | null
}

export interface AdminStorage {
  size: number
  gold: number
  /** Non-empty slots only. */
  items: AdminItemSlot[]
}

export interface AdminAccountDetail extends AdminAccountRow {
  characterList: AdminCharacterRow[]
  storage: AdminStorage
}

export interface AdminCharacterDetail extends AdminCharacterRow {
  role: Role
  progress: { level: number; exp: number; expToNext: number; sp: number; spExp: number; str: number; int: number; statPoints: number }
  gold: number
  hp: number | null
  mp: number | null
  dead: boolean
  /** null = never entered the world (or sent to town while offline): it spawns in town. */
  position: { x: number; y: number; z: number; zone: string } | null
  bag: { size: number; items: AdminItemSlot[] }
  equip: AdminItemSlot[]
  storage: AdminStorage
  masteries: { code: string; level: number }[]
  skills: { group: string; level: number }[]
  levelCap: number
  maxPlus: number
}

/** POST /api/admin/characters/:id/progress (every field optional; at least one). */
export interface AdminProgressPut {
  level?: number
  exp?: number
  sp?: number
  spExp?: number
}

/** POST .../items and .../storage: put `count` of an item (+`plus` on equipment). */
export interface AdminItemGive {
  code: string
  count: number
  plus?: number
}

/** POST .../items/remove and .../storage/remove: a whole slot, or `count` of a stack. */
export interface AdminItemRemove {
  where: 'bag' | 'equip' | 'storage'
  slot: number | EquipSlot
  count?: number
}

// ---- settings ----------------------------------------------------------------------------------------------

export type AdminSettingValue = number | boolean | string

export interface AdminSettingDef {
  /** The ServerConfig field, e.g. 'levelCap'. */
  key: string
  /** The environment variable that sets it outside the panel. */
  env: string
  label: string
  group: string
  /** 'text' (winter addition): a short string, checked by the server (and `pattern`, a regular expression, in the panel). */
  type: 'int' | 'number' | 'bool' | 'enum' | 'text'
  min?: number
  max?: number
  options?: string[]
  /** 'text': the panel's input pattern (an anchored regular expression source) and placeholder. */
  pattern?: string
  placeholder?: string
  /** 'live' = takes effect at once; 'restart' = saved, used from the next start. */
  apply: 'live' | 'restart'
  note?: string
}

export interface AdminSettingState extends AdminSettingDef {
  /** Environment value, else the built-in default (what applies without a panel value). */
  base: AdminSettingValue
  /** The panel's saved value, or null. */
  stored: AdminSettingValue | null
  /** What the running server uses now. */
  running: AdminSettingValue
  /** A restart setting whose next value differs from the running one. */
  pending: boolean
}

export interface AdminSettingsView {
  settings: AdminSettingState[]
  restart: boolean
}

/** PUT /api/admin/settings: null resets a key to its base value. */
export interface AdminSettingsPut {
  values: Record<string, AdminSettingValue | null>
}

// ---- audit -------------------------------------------------------------------------------------------------

export interface AdminAuditRow {
  id: number
  at: number
  accountId: number | null
  account: string
  ip: string
  action: string
  target: string
  before: unknown
  after: unknown
  ok: boolean
  detail: string
}

export interface AdminGmAuditRow {
  id: number
  at: number
  account: string
  command: string
  args: string[]
  result: string
  ok: boolean
}

// ---- items and drops ----------------------------------------------------------------------------------------

/** The item fields the override layer may change (docs/ADMIN.md §5). */
export interface AdminItemPatch {
  name?: string
  price?: number
  sellPrice?: number
  reqLevel?: number
  maxStack?: number
  degree?: number
  keepFee?: number
  repairCost?: number
  canSell?: boolean
  canDrop?: boolean
  canTrade?: boolean
  canStore?: boolean
  stats?: Partial<ItemStats>
  use?: { hp?: number; mp?: number; hpPct?: number; mpPct?: number; cooldownMs?: number }
}

export const ADMIN_ITEM_NUMBER_FIELDS = ['price', 'sellPrice', 'reqLevel', 'maxStack', 'degree', 'keepFee', 'repairCost'] as const
export const ADMIN_ITEM_FLAG_FIELDS = ['canSell', 'canDrop', 'canTrade', 'canStore'] as const
export const ADMIN_ITEM_STAT_FIELDS = ['physAttack', 'magAttack', 'physDefence', 'magDefence', 'parryRate', 'blockRate', 'physAbsorb', 'magAbsorb', 'durability', 'hitRate', 'critRate'] as const
export const ADMIN_ITEM_USE_FIELDS = ['hp', 'mp', 'hpPct', 'mpPct', 'cooldownMs'] as const

export interface AdminItemRow {
  code: string
  name: string | null
  category: string
  slot: string | null
  degree: number
  reqLevel: number
  /** The Climb (docs/CLIMB.md §4.1.2): the client's level when the gear re-spacing moved it; null = unmoved. */
  retailReqLevel?: number | null
  price: number
  icon: string | null
  overridden: boolean
}

export interface AdminItemDetail {
  base: ItemDef
  effective: ItemDef
  /** The icon URL (/admin/out/...; null when none was converted). */
  icon: string | null
  patch: AdminItemPatch | null
  rev: number
}

export interface AdminDropRow {
  mob: string
  mobName: string | null
  /** The monster rank's target window icon (retail has no per-monster portrait). */
  icon: string | null
  level: number | null
  groups: number
  items: number
  gold: boolean
  overridden: boolean
}

export interface AdminDropDetail {
  mob: string
  mobName: string | null
  level: number | null
  base: DropTable | null
  effective: DropTable | null
  overridden: boolean
  rev: number
  /** e.g. a world boss whose loot comes from content/uniques.json instead of this table. */
  note: string | null
  icon: string | null
  /** Name and icon of every item the base and effective tables name. */
  items: Record<string, { name: string | null; icon: string | null }>
}

export interface AdminMobRow {
  code: string
  name: string | null
  level: number
  rarity: string
  icon: string | null
}

// ---- world content (the GM editors) ----------------------------------------------------------------------------

export type AdminNestRow = GmNestInfo & { removed?: boolean; icon?: string | null }

export interface AdminNestAdd {
  mob: string
  x: number
  z: number
  count?: number
  radius?: number
  /** [min, max] seconds. */
  respawnSec?: [number, number]
}

/** POST /api/admin/nests/:id: the fields to change (the GM `nest set` fields). */
export interface AdminNestSet {
  mob?: string
  count?: number
  radius?: number
  spawnRadius?: number
  respawnSec?: [number, number]
  aggressive?: boolean
  championPct?: number
  enabled?: boolean
}

export type AdminNpcRow = GmNpcInfo

export interface AdminNpcAdd {
  base: string
  name: string
  x: number
  z: number
  /** Radians (the client's yaw); absent = 0. */
  yaw?: number
}

/** POST /api/admin/npcs/:code */
export interface AdminNpcSet {
  name?: string
  /** A shops.json id, or null for no shop. */
  shop?: string | null
}

export interface AdminQuestRow {
  id: string
  title: string
  file: string
  source: 'repo' | 'override'
  rev: number
  disabled: boolean
  issues: QuestIssue[]
}

export interface AdminQuestDetail extends AdminQuestRow {
  quest: Record<string, unknown>
}

// ---- events --------------------------------------------------------------------------------------------------

export interface AdminUniqueRow {
  code: string
  name: string | null
  icon: string | null
  phase: 'alive' | 'waiting'
  /** Alive: the entity, camp, area and HP percent. */
  id: number | null
  camp: number | null
  area: string
  hpPct: number | null
  /** Waiting: the next spawn time (ms epoch, 0 = not scheduled). */
  dueAt: number | null
  lastKiller: string | null
  lastKilledAt: number | null
  spawns: number
  camps: number[]
}

export interface AdminUniquesView {
  enabled: boolean
  uniques: AdminUniqueRow[]
}

/**
 * A scheduled event the panel can drive (docs/ADMIN.md §1): settings, start / stop and a log. Play the Boss
 * (docs/PLAY_THE_BOSS.md) registers here once it is built; until then it is listed as 'unavailable'.
 */
export interface AdminEventInfo {
  id: string
  name: string
  about: string
  state: 'unavailable' | 'idle' | 'scheduled' | 'running'
  /** The design doc of the event. */
  spec: string | null
  /**
   * The admin route group serving the event (`/api/admin/<routes>/*`, registered with registerAdminRouteGroup) and the
   * panel sub-page that drives it; null while the event is not built.
   */
  routes: string | null
  /** Next scheduled start (ms epoch) or null. */
  nextAt: number | null
  settings: AdminSettingState[]
  log: { at: number; text: string }[]
}
