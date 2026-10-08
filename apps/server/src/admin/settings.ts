import { CLIMB_PENALTY, DEFAULT_LEVEL_CAP, MAX_GOLD, MONTH_DAY_RE, RARE_PCT_MAX, RARITY_DEFAULTS, STORM_TABLE, WALL_DEFAULTS, WINTER_DEFAULTS, WINTER_PLAY, hostTimeZone, parseMonthDay, validTimeZone, type AdminSettingDef, type AdminSettingState, type AdminSettingValue } from '@sro/shared'
import { MOB_SKILL_DAMAGE_MODES, W8_DEFAULTS, type ServerConfig } from '../config.ts'
import type { GameContext } from '../game.ts'
import type { AdminStore } from './store.ts'

/**
 * The runtime settings the admin panel may change (docs/ADMIN.md §5, §6): the config.ts knobs that are safe to change
 * while players are on, with their bounds (those of loadConfig) and whether they apply live or after a restart.
 * Precedence: built-in default < environment < panel (admin_settings rows).
 */

type Key = keyof ServerConfig & string

export interface SettingSpec extends AdminSettingDef {
  key: Key
  /** The config holds 0/1 for this boolean (MOB_SUMMONS, STALL_TOWN_ONLY, ...). */
  numeric01?: boolean
  /** Built-in default when the config field is absent. */
  fallback: AdminSettingValue
  /** Extra work after a live change (beyond writing the config field). */
  onLive?: (ctx: GameContext) => void
  /** 'text': the server's own check of a value (beyond `pattern`), with the problem to show. */
  check?: (v: string) => string | null
}

const forgetAllShopGoods = (ctx: GameContext): void => {
  for (const s of ctx.data.shops.values()) for (const n of s.npcs) ctx.gameplay.shops.forgetGoods(n)
  for (const code of ctx.data.npcShop.keys()) ctx.gameplay.shops.forgetGoods(code)
}

const W8 = W8_DEFAULTS
const int = (key: Key, env: string, label: string, group: string, min: number, max: number, fallback: number, apply: 'live' | 'restart', note?: string): SettingSpec =>
  ({ key, env, label, group, type: 'int', min, max, fallback, apply, ...(note ? { note } : {}) })
const num = (key: Key, env: string, label: string, group: string, min: number, max: number, fallback: number, apply: 'live' | 'restart', note?: string): SettingSpec =>
  ({ key, env, label, group, type: 'number', min, max, fallback, apply, ...(note ? { note } : {}) })
const bool = (key: Key, env: string, label: string, group: string, fallback: boolean, apply: 'live' | 'restart', note?: string, numeric01 = false): SettingSpec =>
  ({ key, env, label, group, type: 'bool', fallback, apply, ...(note ? { note } : {}), ...(numeric01 ? { numeric01 } : {}) })

const text = (key: Key, env: string, label: string, group: string, fallback: string, apply: 'live' | 'restart', o: { pattern?: string; placeholder?: string; check?: (v: string) => string | null; note?: string }): SettingSpec =>
  ({ key, env, label, group, type: 'text', fallback, apply, ...(o.pattern ? { pattern: o.pattern } : {}), ...(o.placeholder ? { placeholder: o.placeholder } : {}), ...(o.check ? { check: o.check } : {}), ...(o.note ? { note: o.note } : {}) })

/** docs/WINTER.md §6: a winter knob changed: the season is re-evaluated and every player hears it at once. */
const winterLive = (ctx: GameContext): void => ctx.gameplay.winter.refresh()
const dayCheck = (v: string): string | null => (parseMonthDay(v) === null ? 'must be a day of the year as MM-DD (12-01)' : null)

const ACCESS = 'Access'
const RATES = 'Progression and rates'
const CLIMB_G = 'The Climb: death penalty and monster roles'
const WORLD = 'World and monsters'
const COMBAT = 'Combat and items'
const SOCIAL = 'Guilds and stalls'
const RARE = 'Rare weapons'
const STORMS = 'Weather and storms'
const WINTER = 'Winter season'
const WINTER_GAME = 'Winter gameplay'
/** docs/WINTER.md §13: a winter-gameplay knob changed: the layer re-evaluates at once (on/off, snowballs, shop tab). */
const winterPlayLive = (ctx: GameContext): void => ctx.gameplay.winterPlay.refresh()
const SIEGE = 'Siege of Jangan: wall repair'
/** docs/SIEGE.md §11.2: a repair number changed: the kit's price follows, every client gets the new numbers. */
const wallLive = (ctx: GameContext): void => ctx.gameplay.wallRepair.refresh()
const W = WALL_DEFAULTS

export const SETTINGS: readonly SettingSpec[] = [
  bool('registrationOpen', 'REGISTRATION', 'Registration open', ACCESS, true, 'live', 'Off: the server refuses new accounts and the login screen hides Register. Admins can still create accounts here.'),
  int('capacity', 'CAPACITY', 'Capacity (players in the world)', ACCESS, 1, 10000, 50, 'live'),
  int('registerPerHour', 'REGISTER_LIMIT', 'Registrations per IP per hour', ACCESS, 1, 100000, 10, 'restart'),

  {
    ...int('levelCap', 'LEVEL_CAP', 'Level cap', RATES, 1, 300, DEFAULT_LEVEL_CAP, 'live', 'EXP, shops, quests and setlevel follow at once; players see the new cap after re-entering the world; unique gear pools and the default monster level limit at the next restart. The EXP per level is content/climb/levels.json (the Climb curve, levels 1-25).'),
    onLive: forgetAllShopGoods,
  },
  bool('climb', 'CLIMB', 'The Climb (re-levelled monsters, cap-25 EXP curve, level rule)', RATES, true, 'restart', 'docs/CLIMB.md: the monsters of every band at their new levels, the EXP curve of content/climb/levels.json, and a kill 2+ levels below you paying less (−15 % a level). Off: retail monsters and curve. Saved characters were moved to the curve once at the first start with it on; turning it off later does not move them back.'),
  bool('climbRoles', 'CLIMB_ROLES', 'Monster roles (packs, archers, healers, runners)', CLIMB_G, true, 'live', 'docs/CLIMB.md §2.3: the re-levelled monsters call nest-mates (packs), keep their distance from melee (archers, healers), heal hurt allies (healers; a stun cancels the cast) and run for help at low HP (runners). Needs The Climb on.'),
  bool('deathPenalty', 'DEATH_PENALTY', 'Death penalty (EXP lost to monster deaths)', CLIMB_G, true, 'live', 'docs/CLIMB.md §6: a death to a monster or boss takes a random share of the EXP bar (never a level). Never for PvP (Bounty Hunters, Wanted), siege monsters, Play the Boss, lightning or GM kills. Needs The Climb on.'),
  int('penaltyFromLevel', 'PENALTY_FROM_LEVEL', 'Death penalty from level', CLIMB_G, 1, 300, CLIMB_PENALTY.fromLevel, 'live', 'Nothing is taken at the level cap (no bar is kept there).'),
  int('penaltyMinPct', 'PENALTY_MIN_PCT', 'Death penalty: least EXP lost (% of the bar)', CLIMB_G, 0, 100, CLIMB_PENALTY.minPct, 'live'),
  int('penaltyMaxPct', 'PENALTY_MAX_PCT', 'Death penalty: most EXP lost (% of the bar)', CLIMB_G, 0, 100, CLIMB_PENALTY.maxPct, 'live', 'Never more than the EXP in the bar: a death never takes a level.'),
  num('penaltyGraceMin', 'PENALTY_GRACE_MIN', 'Death penalty grace (minutes)', CLIMB_G, 0, 1440, CLIMB_PENALTY.graceMin, 'live', 'A death within this long of a death that took EXP costs nothing (the grace never restarts on a free death).'),
  int('penaltyGraceHighFrom', 'PENALTY_GRACE_HIGH_FROM', 'Longer grace from level', CLIMB_G, 1, 300, CLIMB_PENALTY.graceHighFrom, 'live', 'D51: the bars of 21-24 are big, so the grace is longer there.'),
  num('penaltyGraceHighMin', 'PENALTY_GRACE_HIGH_MIN', 'Longer grace (minutes)', CLIMB_G, 0, 1440, CLIMB_PENALTY.graceHighMin, 'live'),
  num('penaltyLingerS', 'PENALTY_LINGER_S', 'Combat logout linger (seconds)', CLIMB_G, 0, 60, CLIMB_PENALTY.lingerS, 'live', 'A player at penalty levels who leaves (closes the tab, loses the connection) within this long of monster damage stays in the world this long, still a target. 0 = off.'),
  num('expRate', 'EXP_RATE', 'EXP rate', RATES, 0, 1000, 1, 'live', 'Kill EXP x this. Quest EXP is not rated.'),
  num('spRate', 'SP_RATE', 'SP rate', RATES, 0, 1000, 1, 'live', 'Kill SP-EXP x this. Keep it equal to the EXP rate for the usual SP curve.'),
  num('goldRate', 'GOLD_RATE', 'Gold drop rate', RATES, 0, 1000, 1, 'live', 'Dropped gold x this.'),
  num('dropRate', 'DROP_RATE', 'Item drop rate', RATES, 0, 1000, 1, 'live', 'The chance of every item group of a drop table x this (each stops at 100 %).'),
  int('questDailyResetHour', 'QUEST_DAILY_RESET_HOUR', 'Daily quest reset hour', RATES, 0, 23, 4, 'live'),
  bool('questCapExpToSpExp', 'QUEST_CAP_EXP_TO_SPEXP', 'Quest EXP becomes SP-EXP at the cap', RATES, true, 'live'),

  {
    ...int('viewRange', 'VIEW_RANGE', 'View range (m)', WORLD, 20, 2000, 120, 'live'),
    onLive: (ctx) => {
      ctx.world.viewRange = ctx.config.viewRange
    },
  },
  num('giantPct', 'GIANT_PCT', 'Giant chance (%)', WORLD, 0, 100, 1, 'live'),
  bool('spawnMobs', 'SPAWN_MOBS', 'Nest monsters', WORLD, true, 'restart'),
  int('mobLevelMax', 'MOB_LEVEL_MAX', 'Highest monster level spawned (0 = all)', WORLD, 0, 1000, DEFAULT_LEVEL_CAP + 5, 'restart'),
  num('nestCountScale', 'NEST_COUNT_SCALE', 'Monsters per nest (scale)', WORLD, 0.1, 1, 1, 'restart'),
  bool('uniques', 'UNIQUES', 'Unique monsters as world bosses', WORLD, true, 'restart'),
  num('moveSpeed', 'MOVE_SPEED', 'Run speed (m/s)', WORLD, 0.1, 100, 5.5, 'restart'),

  { key: 'mobSkillDamage', env: 'MOB_SKILL_DAMAGE', label: 'Monster skill damage mode', group: COMBAT, type: 'enum', options: [...MOB_SKILL_DAMAGE_MODES], fallback: W8.mobSkillDamage, apply: 'live' },
  num('mobDamageRate', 'MOB_DAMAGE_RATE', 'Monster skill damage rate', COMBAT, 0, 10, W8.mobDamageRate, 'live'),
  bool('mobSummons', 'MOB_SUMMONS', 'Monsters summon helpers', COMBAT, false, 'live', undefined, true),
  int('mobSummonCap', 'MOB_SUMMON_CAP', 'Summons alive per caster', COMBAT, 0, 30, W8.mobSummonCap, 'live'),
  num('durWeaponLossPct', 'DUR_WEAPON_LOSS_PCT', 'Weapon durability loss (% per hit)', COMBAT, 0, 100, W8.durWeaponLossPct, 'live'),
  num('durArmorLossPct', 'DUR_ARMOR_LOSS_PCT', 'Armour durability loss (% per hit)', COMBAT, 0, 100, W8.durArmorLossPct, 'live'),
  num('durShieldLossPct', 'DUR_SHIELD_LOSS_PCT', 'Shield durability loss (% per hit)', COMBAT, 0, 100, W8.durShieldLossPct, 'live'),
  num('durWarnPct', 'DUR_WARN_PCT', 'Low durability warning (%)', COMBAT, 0, 100, W8.durWarnPct, 'live'),
  num('alchemyRate', 'ALCHEMY_RATE', 'Alchemy success multiplier', COMBAT, 0, 10, W8.alchemyRate, 'live', 'Shown in the client after re-entering the world.'),
  int('alchemyMaxPlus', 'ALCHEMY_MAX_PLUS', 'Highest alchemy plus', COMBAT, 1, 12, W8.alchemyMaxPlus, 'live', 'Shown in the client after re-entering the world.'),
  int('alchemyFuseMs', 'ALCHEMY_FUSE_MS', 'Alchemy fuse time (ms)', COMBAT, 0, 30000, W8.alchemyFuseMs, 'live'),
  bool('alchemyDestroy', 'ALCHEMY_DESTROY', 'Failures from +5 may destroy the item', COMBAT, false, 'live', undefined, true),
  int('alchemyAnnounceFrom', 'ALCHEMY_ANNOUNCE_FROM', 'Announce alchemy from + (0 = off)', COMBAT, 0, 12, W8.alchemyAnnounceFrom, 'live'),
  num('elixirDropPct', 'ELIXIR_DROP_PCT', 'Elixir drop chance (%)', COMBAT, 0, 100, W8.elixirDropPct, 'live'),
  int('elixirDropMinLevel', 'ELIXIR_DROP_MIN_LEVEL', 'Elixirs drop from monster level', COMBAT, 1, 120, W8.elixirDropMinLevel, 'live'),
  num('hwanKillPct', 'HWAN_KILL_PCT', 'Berserk point chance per kill (%)', COMBAT, 0, 100, W8.hwanKillPct, 'live'),
  int('hwanDurationMs', 'HWAN_DURATION_MS', 'Berserk duration (ms)', COMBAT, 1000, 600000, W8.hwanDurationMs, 'live'),
  num('storageFee', 'STORAGE_FEE', 'Storage fee multiplier (0 = free)', COMBAT, 0, 1000, 1, 'live'),
  bool('skillAmmo', 'SKILL_AMMO', 'Bow skills use arrows', COMBAT, false, 'live', undefined, true),
  int('cosCombatLockMs', 'COS_COMBAT_LOCK_MS', 'Horse lockout after combat (ms)', COMBAT, 0, 600000, W8.cosCombatLockMs, 'live'),

  // docs/RARITY.md §4: an ordinary weapon drop may come as a Seal of Star / Moon / Sun (one roll, the rarest first)
  num('rareStarPct', 'RARE_STAR_PCT', 'Seal of Star chance (% of weapon drops)', RARE, 0, RARE_PCT_MAX, RARITY_DEFAULTS.starPct, 'live', 'Each ordinary weapon a monster drops comes as its Seal of Star weapon this often (docs/RARITY.md §4.2: Star 1.5, Moon 0.4, Sun 0.1 = 2 % in all; at most 2 each). Uniques keep their own loot, at the same rates.'),
  num('rareMoonPct', 'RARE_MOON_PCT', 'Seal of Moon chance (% of weapon drops)', RARE, 0, RARE_PCT_MAX, RARITY_DEFAULTS.moonPct, 'live'),
  num('rareSunPct', 'RARE_SUN_PCT', 'Seal of Sun chance (% of weapon drops)', RARE, 0, RARE_PCT_MAX, RARITY_DEFAULTS.sunPct, 'live'),
  int('rareTopMinLevel', 'RARE_TOP_MIN_LEVEL', 'Cap-tier (degree-4) Moon and Sun only from monster level (0 = any)', RARE, 0, 300, RARITY_DEFAULTS.topMinLevel, 'live', 'docs/CLIMB.md §4.1, D53: below this level a Moon or Sun roll on a weapon of the cap tier (degree 4) comes as a Seal of Star; lower degrees keep the normal rates. 25 = only the level-25 monsters of the Sea Cliffs and the level-25 bosses.'),
  int('rareMidMinLevel', 'RARE_MID_MIN_LEVEL', 'Degree-3 Moon and Sun only from monster level (0 = any)', RARE, 0, 300, RARITY_DEFAULTS.midMinLevel, 'live', 'docs/CLIMB.md D54: below this level a Moon or Sun roll on a degree-3 weapon comes as a Seal of Star.'),
  int('rareAnnounceFrom', 'RARE_ANNOUNCE_FROM', 'Announce rare drops from (1 Star, 2 Moon, 3 Sun, 0 off)', RARE, 0, 3, RARITY_DEFAULTS.announceFrom, 'live', 'Every player in the world sees who found it.'),

  int('guildCreateLevel', 'GUILD_CREATE_LEVEL', 'Guild creation level', SOCIAL, 1, 300, W8.guildCreateLevel, 'live', 'Shown in the client after re-entering the world.'),
  int('guildCreateGold', 'GUILD_CREATE_GOLD', 'Guild creation cost (gold)', SOCIAL, 0, MAX_GOLD, W8.guildCreateGold, 'live', 'Shown in the client after re-entering the world.'),
  int('guildMaxMembers', 'GUILD_MAX_MEMBERS', 'Guild member cap', SOCIAL, 2, 100, W8.guildMaxMembers, 'live'),
  num('guildRejoinHours', 'GUILD_REJOIN_HOURS', 'Guild rejoin penalty (hours)', SOCIAL, 0, 720, W8.guildRejoinHours, 'live'),
  num('guildRecreateDays', 'GUILD_RECREATE_DAYS', 'Guild recreate penalty (days)', SOCIAL, 0, 60, W8.guildRecreateDays, 'live'),
  bool('stallTownOnly', 'STALL_TOWN_ONLY', 'Stalls only in town', SOCIAL, true, 'live', undefined, true),

  // docs/WEATHER.md §12: storm events (the schedule is re-derived from these at once; a storm in progress keeps its times)
  num('stormsPerDay', 'STORMS_PER_DAY', 'Storms per day', STORMS, 0, 24, STORM_TABLE.perDay, 'live', 'Storm events per real day, spread over the day (a fraction is the chance of one more; 0 = no storms except GM storms). Only with WEATHER=auto.'),
  num('stormMinMin', 'STORM_MIN_MIN', 'Shortest storm (minutes)', STORMS, 1, 120, STORM_TABLE.minMin, 'live'),
  num('stormMaxMin', 'STORM_MAX_MIN', 'Longest storm (minutes)', STORMS, 1, 120, STORM_TABLE.maxMin, 'live'),
  num('stormForecastMin', 'STORM_FORECAST_MIN', 'Storm forecast (minutes before)', STORMS, 0, 10, STORM_TABLE.forecastMin, 'live', 'The sky darkens, the wind rises and players are warned this long before a storm breaks.'),
  num('stormStrength', 'STORM_STRENGTH', 'Storm effect strength', STORMS, 0, 2, STORM_TABLE.strength, 'live', 'Scales every storm and rain effect on monsters and players (0 = none, 1 = the defaults, 2 = twice as strong).'),
  // docs/WEATHER.md §13: the lightning tornado
  num('tornadoChance', 'TORNADO_CHANCE', 'Tornado chance per storm', STORMS, 0, 1, STORM_TABLE.tornadoChance, 'live', 'Chance (0..1) that a storm brings one lightning tornado somewhere in the fields near a player (0 = only GM tornadoes: storm tornado).'),
  num('tornadoStrength', 'TORNADO_STRENGTH', 'Tornado strength', STORMS, 0, 2, STORM_TABLE.tornadoStrength, 'live', "Scales the tornado's pull, throw distance, damage and lightning (0 = it only looks)."),
  bool('tornadoLethal', 'TORNADO_LETHAL', 'Tornado can kill', STORMS, STORM_TABLE.tornadoLethal, 'live', 'On (default): a throw can kill a body already low on HP (each throw about 22 % of max HP, at most 55 % per tornado, so a healthy player survives). Off: never below 1 HP. Its lightning never kills.'),
  // docs/WINTER.md §6: the snow season (applied live; every player in the world hears the change at once)
  { ...bool('winterEnabled', 'WINTER', 'Snow season on', WINTER, WINTER_DEFAULTS.enabled, 'live', 'Off: no snow season (rain stays rain all year). GMs can still make it snow with weather snow / weather blizzard.'), onLive: winterLive },
  { ...text('winterStart', 'WINTER_START', 'Season starts (MM-DD)', WINTER, WINTER_DEFAULTS.start, 'live', { pattern: MONTH_DAY_RE.source, placeholder: '12-01', check: dayCheck, note: 'The first day of the snow season, in the time zone below. The first snowfall settles over hours; nothing turns white at midnight.' }), onLive: winterLive },
  { ...text('winterEnd', 'WINTER_END', 'Season ends (MM-DD, inclusive)', WINTER, WINTER_DEFAULTS.end, 'live', { pattern: MONTH_DAY_RE.source, placeholder: '01-15', check: dayCheck, note: 'The last day of the season (a start after the end wraps the new year). The snow melts over a few hours after it.' }), onLive: winterLive },
  { ...text('winterTz', 'WINTER_TZ', 'Season time zone', WINTER, hostTimeZone(), 'live', { placeholder: 'Europe/Berlin', check: (v) => (validTimeZone(v) ? null : 'must be an IANA time zone like Europe/Berlin or UTC'), note: "Default: the server's own time zone." }), onLive: winterLive },
  { ...num('winterStrength', 'WINTER_STRENGTH', 'Snow strength', WINTER, 0, 1, WINTER_DEFAULTS.strength, 'live', 'How white a full snow cover looks (0 = snow falls but never lies, 1 = the full winter look).'), onLive: winterLive },
  bool('winterTornado', 'WINTER_TORNADO', 'Tornadoes in blizzards', WINTER, WINTER_DEFAULTS.tornado, 'live', 'Off (default): during the snow season storms are blizzards without tornadoes.'),
  // docs/WINTER.md §13: the winter gameplay layer (only in the snow season, or while a GM previews it; applied live)
  { ...bool('winterPlay', 'WINTER_PLAY', 'Winter gameplay on', WINTER_GAME, WINTER_PLAY.enabled, 'live', 'Body warmth, snowball fights, snow spirits, the Ice Yeti and gift boxes during the snow season. Off: the season only changes the look.'), onLive: winterPlayLive },
  num('warmthLossPerMin', 'WARMTH_LOSS_PER_MIN', 'Warmth lost per minute outdoors', WINTER_GAME, 0, 60, WINTER_PLAY.warmth.lossPerMin, 'live', 'By day without snowfall (out of 100). Night x1.5, snowfall up to x1.5, a blizzard x the next setting. 0 = the cold never bites. Towns never chill.'),
  num('warmthBlizzardMul', 'WARMTH_BLIZZARD_MUL', 'Blizzard chill multiplier', WINTER_GAME, 1, 10, WINTER_PLAY.warmth.blizzardMul, 'live'),
  num('warmthFireMul', 'WARMTH_FIRE_MUL', 'Fire warming multiplier', WINTER_GAME, 0, 5, 1, 'live', 'Campfires warm 6 points/s within 8 m, braziers 5 within 6 m, lamps 2 within 3.5 m (x this). Towns warm 3 points/s.'),
  num('coldDrainPct', 'COLD_DRAIN_PCT', 'Freezing HP drain (% of max HP per 5 s)', WINTER_GAME, 0, 10, WINTER_PLAY.warmth.drainPct, 'live', 'Only at 0 warmth, never below 10 % of max HP: the cold alone never kills. 0 = no drain.'),
  num('snowballCover', 'SNOWBALL_COVER', 'Snow cover needed for snowballs', WINTER_GAME, 0, 1, WINTER_PLAY.snowball.cover, 'live', '0..1 (the snow on the ground). Below it nobody can scoop a snowball.'),
  num('snowballSlowPct', 'SNOWBALL_SLOW_PCT', 'Snowball slow (%)', WINTER_GAME, 0, 90, WINTER_PLAY.snowball.slowPct, 'live', 'A hit player runs this much slower for 1.5 s. Snowballs never hurt players.'),
  num('snowSpiritScale', 'SNOW_SPIRIT_SCALE', 'Snow spirits per field (scale)', WINTER_GAME, 0, 3, WINTER_PLAY.spirits.countScale, 'live', '7 fields of 4-5 spirits at 1. 0 = no snow spirits.'),
  num('yetiRespawnMin', 'YETI_RESPAWN_MIN', 'Ice Yeti respawn (minutes)', WINTER_GAME, 5, 1440, WINTER_PLAY.yeti.respawnMin, 'live', 'Rolled within 25 % either way after a kill. A timer already running keeps its time.'),
  num('yetiHpMul', 'YETI_HP_MUL', 'Ice Yeti HP multiplier', WINTER_GAME, 0.05, 10, WINTER_PLAY.yeti.hpMul, 'live', '30,000 HP at 1 (the default 2.6 = 78,000, her level-25 numbers against degree-4 gear: docs/CLIMB.md §2.6, D53). Applies to her next spawn.'),
  num('giftDropPct', 'GIFT_DROP_PCT', 'Gift box chance per kill (%)', WINTER_GAME, 0, 100, WINTER_PLAY.gifts.dropPct, 'live', 'Any monster killed during the season.'),
  int('giftYetiCount', 'GIFT_YETI_COUNT', 'Gift boxes from the Ice Yeti', WINTER_GAME, 0, 20, WINTER_PLAY.gifts.yetiCount, 'live'),
  num('giftRarePct', 'GIFT_RARE_PCT', 'Rare gift reward chance (%)', WINTER_GAME, 0, 100, WINTER_PLAY.gifts.rarePct, 'live', 'Per box, on top of its two rewards: an elixir, Lucky Powders or a pile of gold.'),

  // docs/SIEGE.md §2.4, §2.5, §11.2 (layer 3): unset = content/siege/jangan.json's numbers
  { ...num('wallNaturalPctPer10Min', 'WALL_NATURAL_PCT', 'Natural wall repair (% per 10 min)', SIEGE, 0, 10, W.naturalPctPer10Min, 'live', 'Every damaged segment mends this much on its own every 10 minutes (not during a siege). Rubble to closed takes about 9 h at 1.'), onLive: wallLive },
  { ...int('wallGoldPerPct', 'WALL_GOLD_PER_PCT', 'Donation: gold per 1 %', SIEGE, 100, 100_000, W.goldPerPct, 'live', "What Master Mason Ko asks for 1 % of a segment's repair. Donations are never refunded."), onLive: wallLive },
  { ...int('wallBlocksPerPct', 'WALL_BLOCKS_PER_PCT', 'Donation: Stone Blocks per 1 %', SIEGE, 1, 20, W.blocksPerPct, 'live'), onLive: wallLive },
  { ...num('wallBuilderPctPerMin', 'WALL_BUILDER_PCT_PER_MIN', "Ko's builders (% per minute per segment)", SIEGE, 0, 10, W.builderPctPerMin, 'live', 'Donated work is applied at this rate to every damaged segment at once. 0 = the builders rest (donations wait).'), onLive: wallLive },
  { ...num('wallQueueCapPct', 'WALL_QUEUE_CAP_PCT', 'Donated work queued per segment (max %)', SIEGE, 0, 150, W.queueCapPct, 'live', 'Work beyond a full repair waits for the next damage, up to this. A rubble segment needs 150 % to be whole.'), onLive: wallLive },
  { ...num('wallKitPct', 'WALL_KIT_PCT', "Mason's Kit: % per channel", SIEGE, 0, 10, W.kitPct, 'live'), onLive: wallLive },
  { ...int('wallKitChannelS', 'WALL_KIT_CHANNEL_S', "Mason's Kit: channel (seconds)", SIEGE, 2, 60, W.kitChannelS, 'live', 'One kit per channel; moving, fighting, a warp or taking damage interrupts it.'), onLive: wallLive },
  { ...int('wallKitPrice', 'WALL_KIT_PRICE', "Mason's Kit: price at Ko's shop", SIEGE, 0, 100_000, W.kitPrice, 'live'), onLive: wallLive },
  { ...int('wallLooters', 'WALL_LOOTERS', 'Looters per open gap', SIEGE, 0, 10, W.looters, 'live', 'Bandits that move into every breach outside a siege; they leave when it is repaired. 0 = none.'), onLive: wallLive },
  { ...num('wallLooterRespawnMin', 'WALL_LOOTER_RESPAWN_MIN', 'Looter respawn (minutes)', SIEGE, 1, 60, W.looterRespawnMin, 'live'), onLive: wallLive },
]

export const SETTING_BY_KEY: ReadonlyMap<string, SettingSpec> = new Map(SETTINGS.map((s) => [s.key, s]))

/** The panel value of `spec` in `config` (numeric 0/1 fields as booleans; absent = the built-in default). */
export function readSetting(config: ServerConfig, spec: SettingSpec): AdminSettingValue {
  const raw = (config as unknown as Record<string, unknown>)[spec.key]
  if (raw === undefined || raw === null) return spec.fallback
  if (spec.numeric01) return raw === 1 || raw === true
  return raw as AdminSettingValue
}

function writeSetting(config: ServerConfig, spec: SettingSpec, v: AdminSettingValue): void {
  ;(config as unknown as Record<string, unknown>)[spec.key] = spec.numeric01 ? (v ? 1 : 0) : v
}

/** A clean value for `spec`, or the problem. */
export function checkSetting(spec: SettingSpec, v: unknown): { value: AdminSettingValue } | { problem: string } {
  switch (spec.type) {
    case 'bool':
      return typeof v === 'boolean' ? { value: v } : { problem: `${spec.key} must be true or false` }
    case 'enum':
      return typeof v === 'string' && spec.options!.includes(v) ? { value: v } : { problem: `${spec.key} must be one of ${spec.options!.join(', ')}` }
    case 'text': {
      if (typeof v !== 'string' || v.length === 0 || v.length > 64) return { problem: `${spec.key} must be a short text` }
      const s = v.trim()
      if (spec.pattern && !new RegExp(spec.pattern).test(s)) return { problem: `${spec.key} must look like ${spec.placeholder ?? spec.pattern}` }
      const problem = spec.check?.(s) ?? null
      return problem ? { problem: `${spec.key} ${problem}` } : { value: s }
    }
    case 'int':
    case 'number': {
      const ok = typeof v === 'number' && Number.isFinite(v) && v >= spec.min! && v <= spec.max! && (spec.type === 'number' || Number.isInteger(v))
      return ok ? { value: v } : { problem: `${spec.key} must be ${spec.type === 'int' ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max}` }
    }
  }
}

const same = (a: AdminSettingValue | null, b: AdminSettingValue | null): boolean => a === b

/**
 * The settings of one running server: the base values (environment / default, captured before the panel's values are
 * applied) and the values the process started with, so the panel can tell "saved, waits for a restart" apart.
 */
export class SettingsState {
  private readonly base = new Map<string, AdminSettingValue>()
  /** Values of the restart settings as this process uses them. */
  private readonly started = new Map<string, AdminSettingValue>()

  private constructor(
    readonly config: ServerConfig,
    readonly store: AdminStore,
  ) {}

  /**
   * Startup (game.ts, before any module reads the config): captures the base values, then applies the saved panel
   * values. A saved value that no longer validates (or an unknown key) is skipped with a log line, never fatal.
   */
  static load(config: ServerConfig, store: AdminStore): SettingsState {
    const st = new SettingsState(config, store)
    for (const spec of SETTINGS) st.base.set(spec.key, readSetting(config, spec))
    const saved = store.settings()
    const applied: string[] = []
    for (const [key, row] of saved) {
      const spec = SETTING_BY_KEY.get(key)
      if (!spec) {
        config.log(`admin settings: skipped unknown saved setting ${key}`)
        continue
      }
      const r = checkSetting(spec, row.value)
      if ('problem' in r) {
        config.log(`admin settings: skipped saved ${key}: ${r.problem}`)
        continue
      }
      writeSetting(config, spec, r.value)
      applied.push(`${key}=${String(r.value)}`)
    }
    // MOB_LEVEL_MAX defaults to LEVEL_CAP + 5: a panel level cap moves it too unless it was set on its own.
    const baseCap = st.base.get('levelCap') as number
    if (saved.has('levelCap') && !saved.has('mobLevelMax') && config.mobLevelMax === baseCap + 5) config.mobLevelMax = config.levelCap + 5
    for (const spec of SETTINGS) st.started.set(spec.key, readSetting(config, spec))
    if (applied.length) config.log(`admin settings: ${applied.join(', ')}`)
    return st
  }

  baseOf(spec: SettingSpec): AdminSettingValue {
    return this.base.get(spec.key) ?? spec.fallback
  }

  /** What the next start uses: the saved value, else the base. */
  nextOf(spec: SettingSpec, saved = this.store.settings()): AdminSettingValue {
    const row = saved.get(spec.key)
    if (row) {
      const r = checkSetting(spec, row.value)
      if ('value' in r) return r.value
    }
    return this.baseOf(spec)
  }

  view(): AdminSettingState[] {
    const saved = this.store.settings()
    return SETTINGS.map((spec) => {
      const { fallback: _f, onLive: _o, numeric01: _n, check: _c, ...def } = spec
      const row = saved.get(spec.key)
      const stored = row && 'value' in checkSetting(spec, row.value) ? (row.value as AdminSettingValue) : null
      const running = spec.apply === 'live' ? readSetting(this.config, spec) : (this.started.get(spec.key) ?? readSetting(this.config, spec))
      return { ...def, base: this.baseOf(spec), stored, running, pending: spec.apply === 'restart' && !same(this.nextOf(spec, saved), running) }
    })
  }

  /** Keys of restart settings whose saved value is not running yet. */
  pending(): string[] {
    return this.view()
      .filter((s) => s.pending)
      .map((s) => s.key)
  }

  /**
   * Saves (or, for null, deletes) the given values, all or nothing, and applies the live ones. Returns the problems
   * (nothing saved) or the before/after values of what changed.
   */
  put(ctx: GameContext, values: Record<string, unknown>, by: string): { problems: string[] } | { before: Record<string, unknown>; after: Record<string, unknown> } {
    const problems: string[] = []
    const plan: { spec: SettingSpec; value: AdminSettingValue | null }[] = []
    for (const [key, raw] of Object.entries(values)) {
      const spec = SETTING_BY_KEY.get(key)
      if (!spec) {
        problems.push(`unknown setting ${key}`)
        continue
      }
      if (raw === null) {
        plan.push({ spec, value: null })
        continue
      }
      const r = checkSetting(spec, raw)
      if ('problem' in r) problems.push(r.problem)
      else plan.push({ spec, value: r.value })
    }
    if (problems.length > 0) return { problems }
    const saved = this.store.settings()
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    const live: SettingSpec[] = []
    this.store.tx(() => {
      for (const { spec, value } of plan) {
        before[spec.key] = saved.get(spec.key)?.value ?? null
        after[spec.key] = value
        if (value === null) this.store.deleteSetting(spec.key)
        else this.store.setSetting(spec.key, value, by)
      }
    })
    for (const { spec, value } of plan) {
      if (spec.apply !== 'live') continue
      writeSetting(this.config, spec, value ?? this.baseOf(spec))
      live.push(spec)
    }
    for (const spec of live) spec.onLive?.(ctx)
    return { before, after }
  }
}
