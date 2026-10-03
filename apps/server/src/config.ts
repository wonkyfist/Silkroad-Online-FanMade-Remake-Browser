import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LEVEL_CAP, MAX_GOLD, WEATHER_KINDS, WORLD_FOLDER, type Role, type WeatherKind } from '@sro/shared'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Roles that EDITOR_ROLE may name (the GM content editors need at least this role). */
export type EditorRole = Extract<Role, 'gm' | 'admin'>
export const EDITOR_ROLES: readonly EditorRole[] = ['gm', 'admin']

export interface ServerConfig {
  port: number
  host: string
  dataDir: string
  outDir: string
  /**
   * Optimized assets (packages/convert/src/tools/optimize-out.ts, docs/ASSETS.md), served at /out-opt/ (OUT_OPT_DIR,
   * default <repo>/work/out-opt). Optional so older callers keep working; unset = OUT_DIR's sibling out-opt.
   */
  outOptDir?: string
  gameDist: string
  world: string
  /** metres per second */
  moveSpeed: number
  tickHz: number
  /** Explicit spawn override (world metres); null = resolve from the world manifest. */
  spawn: { x: number; z: number } | null
  /** Serve apps/game/dist at / and work/out at /out/. */
  serveStatic: boolean
  /** Access-Control-Allow-Origin for /api/* ('' = no CORS headers). Also an allowed origin. */
  corsOrigin: string
  /**
   * Browser origins allowed to call /api and open /ws besides the server's own origin
   * (the Vite dev/preview origins by default, plus ALLOWED_ORIGINS, comma-separated).
   */
  allowedOrigins: string[]
  capacity: number
  /** Registrations allowed per IP per hour. */
  registerPerHour: number
  /** Seconds between periodic position saves. */
  saveIntervalS: number
  helloTimeoutMs: number
  /** Trust X-Forwarded-For for rate limiting (only behind a reverse proxy you control). */
  trustProxy: boolean
  /** Highest level GM `setlevel` accepts (LEVEL_CAP, default 20). */
  levelCap: number
  /** How often (ms) the server checks the database for role changes made by `pnpm gm` while it runs. */
  rolePollMs: number
  /** Interest radius in metres: clients receive entities within this distance (VIEW_RANGE, default 120). */
  viewRange: number
  /** Nests whose monster is above this level stay empty (MOB_LEVEL_MAX, default LEVEL_CAP + 5; 0 = all). */
  mobLevelMax: number
  /** Spawn nest monsters at all (SPAWN_MOBS, default on). */
  spawnMobs: boolean
  /** Percent chance a nest mob that has a giant variant spawns as a giant (GIANT_PCT, default 1). */
  giantPct: number
  /**
   * Navigation (NAV): 'auto' uses the world's navmesh (manifest `nav` file) when it exists, else the flat world
   * bounds; 'off' always uses the flat bounds. Optional (default 'auto').
   */
  nav?: 'auto' | 'off'
  // ---- wave 3 (docs/WAVE_PLAN.md §2.4); optional so older callers keep working, absent = the default ----
  /**
   * World export folder under /out(-opt)/world/ (WORLD_EXPORT, default WORLD; docs/FIELDS.md), e.g. 'jangan-fields'.
   * The world id (`world`) stays the same; this names only the exported files and ServerInfo.world.
   */
  worldExport?: string
  /** Multiplies every nest's monster count (NEST_COUNT_SCALE, default 1, clamped 0.1..1). */
  nestCountScale?: number
  /** Storage deposit fee on (STORAGE_FEE, default 1 = keepFee x count; 0 = free; docs/SHOPS.md §5.1). */
  storageFee?: number
  /** Bow skills and bow basic attacks take 1 arrow (SKILL_AMMO, default 0 = off; docs/WAVE_PLAN.md decision 12). */
  skillAmmo?: number
  /** Multiplies dropped gold amounts (GOLD_RATE, default 1, 0..1000; applied in rollDrops). Quest gold is unchanged. */
  goldRate?: number
  // ---- rates (docs/BALANCE.md §7); optional like wave 3's, absent = 1 ----
  /** Multiplies kill EXP (EXP_RATE, default 1, 0..1000; applied in Gameplay.mobDied to every share). Quest EXP is unchanged. */
  expRate?: number
  /** Multiplies kill SP-EXP (SP_RATE, default 1, 0..1000; applied beside EXP_RATE). Quest SP is unchanged. */
  spRate?: number
  /**
   * Multiplies the chance of every item group of a drop table (DROP_RATE, default 1, 0..1000; a chance stops at 100 %;
   * applied in rollDrops). Gold (GOLD_RATE) and quest item drops (their objective's own chance) are unchanged.
   */
  dropRate?: number
  // ---- wave 4 (docs/WAVE_PLAN.md §2.4, docs/QUESTS.md §1.7, §5); optional like wave 3's, absent = the default ----
  /** Authored content in the repo (CONTENT_DIR, default <repo>/content): quests/*.json. GM overrides live in DATA_DIR/content. */
  contentDir?: string
  /** Server-local hour (0-23) at which daily repeatable quests become available again (QUEST_DAILY_RESET_HOUR, default 4). */
  questDailyResetHour?: number
  /** At the level cap, quest EXP is granted as SP-EXP instead of being lost (QUEST_CAP_EXP_TO_SPEXP, default 1 = on). */
  questCapExpToSpExp?: boolean
  /**
   * Lowest role that may use the GM content editors (EDITOR_ROLE, 'gm' or 'admin', default 'gm'; decision 48). The
   * editors only read the role through the usual checks; they never change one.
   */
  editorRole?: EditorRole
  // ---- wave 8 (docs/WAVE_PLAN2.md §2.4); optional like wave 3's, absent = the default ----
  /** Horse summon/ride lockout after combat, ms (COS_COMBAT_LOCK_MS, default 20000, 0..600000). */
  cosCombatLockMs?: number
  /** A parked horse is dismissed when its owner is farther than this, metres (COS_PARK_RANGE_M, default 60, 5..500). */
  cosParkRangeM?: number
  /** Monster skill damage scale (MOB_SKILL_DAMAGE: relative / retail / flat, default relative; docs/SYSTEMS_COMBAT.md §2.6). */
  mobSkillDamage?: MobSkillDamage
  /** Multiplies monster skill damage after the mode (MOB_DAMAGE_RATE, default 1, 0..10). */
  mobDamageRate?: number
  /** Monster SUMMON rows fire (MOB_SUMMONS, default 0 = off, 0..1) and the most summons alive per caster (MOB_SUMMON_CAP, 6, 0..30). */
  mobSummons?: number
  mobSummonCap?: number
  /** Percent chances a landed hit costs 1 durability (DUR_*_LOSS_PCT, defaults 5 / 5 / 10, 0..100). */
  durWeaponLossPct?: number
  durArmorLossPct?: number
  durShieldLossPct?: number
  /** Low-durability warning threshold, percent of max (DUR_WARN_PCT, default 10, 0..100). */
  durWarnPct?: number
  /** Alchemy success multiplier (ALCHEMY_RATE, default 1.5, 0..10; the chance is clamped to 100 %). */
  alchemyRate?: number
  /** Highest plus alchemy reaches (ALCHEMY_MAX_PLUS, default 10, 1..12). */
  alchemyMaxPlus?: number
  /** Fuse time, ms (ALCHEMY_FUSE_MS, default 3000, 0..30000). */
  alchemyFuseMs?: number
  /** 1 = retail: from +5 a failure may destroy the item (ALCHEMY_DESTROY, default 0, 0..1). */
  alchemyDestroy?: number
  /** Announce successes from this plus (ALCHEMY_ANNOUNCE_FROM, default 7, 0..12; 0 = off). */
  alchemyAnnounceFrom?: number
  /** Authored elixir drop: percent per kill (ELIXIR_DROP_PCT, default 0.8, 0..100) of mobs from this level (ELIXIR_DROP_MIN_LEVEL, 5, 1..120). */
  elixirDropPct?: number
  elixirDropMinLevel?: number
  /** Berserk: percent chance a normal kill gives a point (HWAN_KILL_PCT, default 12, 0..100) and its duration (HWAN_DURATION_MS, 60000, 1000..600000). */
  hwanKillPct?: number
  hwanDurationMs?: number
  /** Guild creation level and cost (GUILD_CREATE_LEVEL, default 10, 1..300; GUILD_CREATE_GOLD, 10000, 0..MAX_GOLD). */
  guildCreateLevel?: number
  guildCreateGold?: number
  /** Member cap (GUILD_MAX_MEMBERS, default 50, 2..100). */
  guildMaxMembers?: number
  /** Penalties: rejoin after leaving (GUILD_REJOIN_HOURS, 0..720) and recreate after disbanding (GUILD_RECREATE_DAYS, 0..60); default 0 = off. */
  guildRejoinHours?: number
  guildRecreateDays?: number
  /** Stalls only inside a town's safe area (STALL_TOWN_ONLY, default 1, 0..1). */
  stallTownOnly?: number
  // ---- wave 9 (docs/WAVE_PLAN3.md §3.6); optional like wave 3's, absent = the default ----
  /** Real minutes per game day (DAY_LENGTH_MIN, default 120, 1..1440; docs/SKY.md §2). */
  dayLengthMin?: number
  /** Night speed-up k (DAY_NIGHT_SPEEDUP, default 0.4, 0..0.6): how much faster the night passes. */
  dayNightSpeedup?: number
  /** Sun declination, degrees (DAY_SEASON_DEG, default 12, -23.44..23.44): the season. */
  daySeasonDeg?: number
  /** Weather mode (WEATHER, default auto): 'auto' (the seeded schedule), 'off' (always clear) or a fixed state. */
  weather?: WeatherMode
  /** Weather schedule seed (WEATHER_SEED, default 1, u32). */
  weatherSeed?: number
  /** Multiplies the `→ rain` and `→ storm` schedule weights (WEATHER_RAIN_SCALE, default 1, 0..3). */
  weatherRainScale?: number
  // ---- wave 11 (docs/WAVE_PLAN7.md §3.4); optional like wave 3's, absent = the default ----
  /**
   * Unique monsters are world bosses run by the uniques module (UNIQUES, on (default) | off; docs/UNIQUES.md §3.2): the
   * Spawner refuses every nest with a `uniqueGroup` and the module owns those groups. off = the wave-10 behaviour (the
   * unique groups spawn as plain nest mobs). Read as `config.uniques ?? true`.
   */
  uniques?: boolean
  /** Random source of gameplay rolls (tests pass a seeded one). */
  rng?: () => number
  log: (msg: string) => void
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const v = Number(raw)
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${key} must be a number in [${min}, ${max}], got ${raw}`)
  return v
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(raw)
}

/**
 * Defaults of the wave-8 knobs (docs/WAVE_PLAN2.md §2.4). The ServerConfig fields are optional (test configs leave them
 * out), so modules read `config.x ?? W8_DEFAULTS.x`.
 */
export const W8_DEFAULTS = {
  cosCombatLockMs: 20000,
  cosParkRangeM: 60,
  mobSkillDamage: 'relative',
  mobDamageRate: 1,
  mobSummons: 0,
  mobSummonCap: 6,
  durWeaponLossPct: 5,
  durArmorLossPct: 5,
  durShieldLossPct: 10,
  durWarnPct: 10,
  alchemyRate: 1.5,
  alchemyMaxPlus: 10,
  alchemyFuseMs: 3000,
  alchemyDestroy: 0,
  alchemyAnnounceFrom: 7,
  elixirDropPct: 0.8,
  elixirDropMinLevel: 5,
  hwanKillPct: 12,
  hwanDurationMs: 60000,
  guildCreateLevel: 10,
  guildCreateGold: 10000,
  guildMaxMembers: 50,
  guildRejoinHours: 0,
  guildRecreateDays: 0,
  stallTownOnly: 1,
} as const satisfies Required<Pick<ServerConfig, W8Knob>>

type W8Knob =
  | 'cosCombatLockMs' | 'cosParkRangeM' | 'mobSkillDamage' | 'mobDamageRate' | 'mobSummons' | 'mobSummonCap'
  | 'durWeaponLossPct' | 'durArmorLossPct' | 'durShieldLossPct' | 'durWarnPct'
  | 'alchemyRate' | 'alchemyMaxPlus' | 'alchemyFuseMs' | 'alchemyDestroy' | 'alchemyAnnounceFrom' | 'elixirDropPct' | 'elixirDropMinLevel'
  | 'hwanKillPct' | 'hwanDurationMs'
  | 'guildCreateLevel' | 'guildCreateGold' | 'guildMaxMembers' | 'guildRejoinHours' | 'guildRecreateDays' | 'stallTownOnly'

/** A wave-8 knob of `config`, or its default. */
export function knob<K extends W8Knob>(config: ServerConfig, k: K): NonNullable<ServerConfig[K]> {
  return (config[k] ?? W8_DEFAULTS[k]) as NonNullable<ServerConfig[K]>
}

/** MOB_SKILL_DAMAGE modes (docs/SYSTEMS_COMBAT.md §2.6). */
export type MobSkillDamage = 'relative' | 'retail' | 'flat'
export const MOB_SKILL_DAMAGE_MODES: readonly MobSkillDamage[] = ['relative', 'retail', 'flat']

function mobSkillDamage(raw: string | undefined): MobSkillDamage {
  if (raw === undefined || raw === '') return W8_DEFAULTS.mobSkillDamage
  const v = raw.trim().toLowerCase()
  if (!(MOB_SKILL_DAMAGE_MODES as readonly string[]).includes(v)) throw new Error(`MOB_SKILL_DAMAGE must be relative, retail or flat, got ${raw}`)
  return v as MobSkillDamage
}

/** WEATHER modes (docs/WEATHER.md §2.3): the schedule, always clear, or one fixed state. */
export type WeatherMode = 'auto' | 'off' | WeatherKind

/** Defaults of the wave-9 knobs (docs/WAVE_PLAN3.md §3.6); read as `config.x ?? W9_DEFAULTS.x`. */
export const W9_DEFAULTS = {
  dayLengthMin: 120,
  dayNightSpeedup: 0.4,
  daySeasonDeg: 12,
  weather: 'auto',
  weatherSeed: 1,
  weatherRainScale: 1,
} as const satisfies Required<Pick<ServerConfig, 'dayLengthMin' | 'dayNightSpeedup' | 'daySeasonDeg' | 'weather' | 'weatherSeed' | 'weatherRainScale'>>

function weatherMode(raw: string | undefined): WeatherMode {
  if (raw === undefined || raw === '') return W9_DEFAULTS.weather
  const v = raw.trim().toLowerCase()
  if (v === 'auto' || v === 'off' || (WEATHER_KINDS as readonly string[]).includes(v)) return v as WeatherMode
  throw new Error(`WEATHER must be auto, off or one of ${WEATHER_KINDS.join(', ')}, got ${raw}`)
}

/** Vite dev (5180) and preview (5181) servers, which proxy /api and /ws to this server. */
export const DEV_ORIGINS = ['localhost', '127.0.0.1', '[::1]'].flatMap((h) => [`http://${h}:5180`, `http://${h}:5181`])

function allowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const out = new Set(DEV_ORIGINS)
  const extra = [...(env.ALLOWED_ORIGINS ?? '').split(','), env.CORS_ORIGIN ?? '']
  for (const raw of extra) {
    const v = raw.trim()
    if (!v) continue
    let origin = 'null'
    try {
      origin = new URL(v).origin
    } catch {
      // reported below
    }
    if (origin === 'null') throw new Error(`ALLOWED_ORIGINS/CORS_ORIGIN entries must be http(s) origins like http://host:port, got ${v}`)
    out.add(origin)
  }
  return [...out]
}

/**
 * DATA_DIR or <repo>/work/server. A relative DATA_DIR is resolved against the directory pnpm was
 * started from (INIT_CWD), not apps/server. Shared with the gm CLI.
 */
export function dataDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.DATA_DIR) return resolve(REPO_ROOT, 'work/server')
  return resolve(env.INIT_CWD || process.cwd(), env.DATA_DIR)
}

function onOff(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  if (/^(on|1|true|yes)$/i.test(raw.trim())) return true
  if (/^(off|0|false|no)$/i.test(raw.trim())) return false
  throw new Error(`${key} must be on or off, got ${raw}`)
}

function navMode(raw: string | undefined): 'auto' | 'off' {
  if (raw === undefined || raw === '' || /^(auto|1|on|true|yes)$/i.test(raw)) return 'auto'
  if (/^(off|0|false|no|flat)$/i.test(raw)) return 'off'
  throw new Error(`NAV must be auto or off, got ${raw}`)
}

function editorRole(raw: string | undefined): EditorRole {
  if (raw === undefined || raw === '') return 'gm'
  const v = raw.trim().toLowerCase()
  if (!(EDITOR_ROLES as readonly string[]).includes(v)) throw new Error(`EDITOR_ROLE must be gm or admin, got ${raw}`)
  return v as EditorRole
}

/** The streamed fields around Jangan (docs/FIELDS.md): the default export of the 'jangan' world once it exists. */
export const FIELDS_EXPORT = 'jangan-fields'

/**
 * WORLD_EXPORT when it is not set (W3-I, docs/WAVE_PLAN.md §4.15): the fields for the 'jangan' world when
 * OUT_DIR/world/jangan-fields/ holds its manifest, else the world id itself (the 3 x 3 town export). An explicit
 * WORLD_EXPORT always wins (`WORLD_EXPORT=jangan` plays the small town map).
 */
export function defaultWorldExport(world: string, outDir: string): string {
  return world === 'jangan' && existsSync(join(outDir, 'world', FIELDS_EXPORT, 'manifest.json')) ? FIELDS_EXPORT : world
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production'
  const world = env.WORLD || 'jangan'
  if (!/^[a-z0-9_-]{1,64}$/i.test(world)) throw new Error(`WORLD must be a simple name, got ${world}`)
  const hasSpawn = (env.SPAWN_X ?? '') !== '' || (env.SPAWN_Z ?? '') !== ''
  const levelCap = Math.floor(num(env, 'LEVEL_CAP', DEFAULT_LEVEL_CAP, 1, 1000))
  const outDir = resolve(env.OUT_DIR || resolve(REPO_ROOT, 'work/out'))
  const worldExport = env.WORLD_EXPORT || defaultWorldExport(world, outDir)
  // The client accepts only WORLD_FOLDER names in ServerInfo.world (lower case, digits and '-').
  if (env.WORLD_EXPORT && !WORLD_FOLDER.test(worldExport)) throw new Error(`WORLD_EXPORT must be a folder name of a-z, 0-9 and -, got ${worldExport}`)
  return {
    port: num(env, 'PORT', 7000, 0, 65535),
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    dataDir: dataDirFrom(env),
    outDir,
    outOptDir: resolve(env.OUT_OPT_DIR || resolve(REPO_ROOT, 'work/out-opt')),
    gameDist: resolve(env.GAME_DIST || resolve(REPO_ROOT, 'apps/game/dist')),
    world,
    moveSpeed: num(env, 'MOVE_SPEED', 5.5, 0.1, 100),
    tickHz: num(env, 'TICK_HZ', 10, 1, 60),
    spawn: hasSpawn ? { x: num(env, 'SPAWN_X', 0, -1e6, 1e6), z: num(env, 'SPAWN_Z', 0, -1e6, 1e6) } : null,
    serveStatic: bool(env, 'SERVE_STATIC', production),
    corsOrigin: env.CORS_ORIGIN ?? '',
    allowedOrigins: allowedOrigins(env),
    capacity: num(env, 'CAPACITY', 50, 1, 10000),
    registerPerHour: num(env, 'REGISTER_LIMIT', 10, 1, 100000),
    saveIntervalS: num(env, 'SAVE_INTERVAL', 30, 1, 3600),
    helloTimeoutMs: 5000,
    trustProxy: bool(env, 'TRUST_PROXY', false),
    levelCap,
    rolePollMs: 1000,
    viewRange: num(env, 'VIEW_RANGE', 120, 20, 2000),
    mobLevelMax: Math.floor(num(env, 'MOB_LEVEL_MAX', levelCap + 5, 0, 1000)),
    spawnMobs: bool(env, 'SPAWN_MOBS', true),
    giantPct: num(env, 'GIANT_PCT', 1, 0, 100),
    nav: navMode(env.NAV),
    worldExport,
    nestCountScale: Math.min(1, Math.max(0.1, num(env, 'NEST_COUNT_SCALE', 1, 0, 1000))),
    storageFee: num(env, 'STORAGE_FEE', 1, 0, 1000),
    skillAmmo: num(env, 'SKILL_AMMO', 0, 0, 1),
    goldRate: num(env, 'GOLD_RATE', 1, 0, 1000),
    expRate: num(env, 'EXP_RATE', 1, 0, 1000),
    spRate: num(env, 'SP_RATE', 1, 0, 1000),
    dropRate: num(env, 'DROP_RATE', 1, 0, 1000),
    contentDir: resolve(env.CONTENT_DIR || resolve(REPO_ROOT, 'content')),
    questDailyResetHour: Math.floor(num(env, 'QUEST_DAILY_RESET_HOUR', 4, 0, 23)),
    questCapExpToSpExp: bool(env, 'QUEST_CAP_EXP_TO_SPEXP', true),
    editorRole: editorRole(env.EDITOR_ROLE),
    // wave 8 (docs/WAVE_PLAN2.md §2.4)
    cosCombatLockMs: num(env, 'COS_COMBAT_LOCK_MS', W8_DEFAULTS.cosCombatLockMs, 0, 600000),
    cosParkRangeM: num(env, 'COS_PARK_RANGE_M', W8_DEFAULTS.cosParkRangeM, 5, 500),
    mobSkillDamage: mobSkillDamage(env.MOB_SKILL_DAMAGE),
    mobDamageRate: num(env, 'MOB_DAMAGE_RATE', W8_DEFAULTS.mobDamageRate, 0, 10),
    mobSummons: Math.floor(num(env, 'MOB_SUMMONS', W8_DEFAULTS.mobSummons, 0, 1)),
    mobSummonCap: Math.floor(num(env, 'MOB_SUMMON_CAP', W8_DEFAULTS.mobSummonCap, 0, 30)),
    durWeaponLossPct: num(env, 'DUR_WEAPON_LOSS_PCT', W8_DEFAULTS.durWeaponLossPct, 0, 100),
    durArmorLossPct: num(env, 'DUR_ARMOR_LOSS_PCT', W8_DEFAULTS.durArmorLossPct, 0, 100),
    durShieldLossPct: num(env, 'DUR_SHIELD_LOSS_PCT', W8_DEFAULTS.durShieldLossPct, 0, 100),
    durWarnPct: num(env, 'DUR_WARN_PCT', W8_DEFAULTS.durWarnPct, 0, 100),
    alchemyRate: num(env, 'ALCHEMY_RATE', W8_DEFAULTS.alchemyRate, 0, 10),
    alchemyMaxPlus: Math.floor(num(env, 'ALCHEMY_MAX_PLUS', W8_DEFAULTS.alchemyMaxPlus, 1, 12)),
    alchemyFuseMs: num(env, 'ALCHEMY_FUSE_MS', W8_DEFAULTS.alchemyFuseMs, 0, 30000),
    alchemyDestroy: Math.floor(num(env, 'ALCHEMY_DESTROY', W8_DEFAULTS.alchemyDestroy, 0, 1)),
    alchemyAnnounceFrom: Math.floor(num(env, 'ALCHEMY_ANNOUNCE_FROM', W8_DEFAULTS.alchemyAnnounceFrom, 0, 12)),
    elixirDropPct: num(env, 'ELIXIR_DROP_PCT', W8_DEFAULTS.elixirDropPct, 0, 100),
    elixirDropMinLevel: Math.floor(num(env, 'ELIXIR_DROP_MIN_LEVEL', W8_DEFAULTS.elixirDropMinLevel, 1, 120)),
    hwanKillPct: num(env, 'HWAN_KILL_PCT', W8_DEFAULTS.hwanKillPct, 0, 100),
    hwanDurationMs: num(env, 'HWAN_DURATION_MS', W8_DEFAULTS.hwanDurationMs, 1000, 600000),
    guildCreateLevel: Math.floor(num(env, 'GUILD_CREATE_LEVEL', W8_DEFAULTS.guildCreateLevel, 1, 300)),
    guildCreateGold: Math.floor(num(env, 'GUILD_CREATE_GOLD', W8_DEFAULTS.guildCreateGold, 0, MAX_GOLD)),
    guildMaxMembers: Math.floor(num(env, 'GUILD_MAX_MEMBERS', W8_DEFAULTS.guildMaxMembers, 2, 100)),
    guildRejoinHours: num(env, 'GUILD_REJOIN_HOURS', W8_DEFAULTS.guildRejoinHours, 0, 720),
    guildRecreateDays: num(env, 'GUILD_RECREATE_DAYS', W8_DEFAULTS.guildRecreateDays, 0, 60),
    stallTownOnly: Math.floor(num(env, 'STALL_TOWN_ONLY', W8_DEFAULTS.stallTownOnly, 0, 1)),
    // wave 9 (docs/WAVE_PLAN3.md §3.6)
    dayLengthMin: num(env, 'DAY_LENGTH_MIN', W9_DEFAULTS.dayLengthMin, 1, 1440),
    dayNightSpeedup: num(env, 'DAY_NIGHT_SPEEDUP', W9_DEFAULTS.dayNightSpeedup, 0, 0.6),
    daySeasonDeg: num(env, 'DAY_SEASON_DEG', W9_DEFAULTS.daySeasonDeg, -23.44, 23.44),
    weather: weatherMode(env.WEATHER),
    weatherSeed: Math.floor(num(env, 'WEATHER_SEED', W9_DEFAULTS.weatherSeed, 0, 0xffffffff)),
    weatherRainScale: num(env, 'WEATHER_RAIN_SCALE', W9_DEFAULTS.weatherRainScale, 0, 3),
    // wave 11 (docs/WAVE_PLAN7.md §3.4)
    uniques: onOff(env, 'UNIQUES', true),
    log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
  }
}
