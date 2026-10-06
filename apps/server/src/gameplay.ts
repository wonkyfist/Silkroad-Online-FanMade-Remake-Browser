import {
  EQUIP_SLOTS,
  GOLD_ITEM_CODES,
  clockAt,
  nightness,
  sunDirection,
  ITEM_EXPIRE_MS,
  ITEM_OWNER_MS,
  MAX_COMBAT_HITS,
  PICKUP_RANGE,
  variantScale,
  yawTowards,
  type CombatHit,
  type DropTable,
  type EntityState,
  type EquipSlot,
  type GameplayRequest,
  type HazardCause,
  type ItemDef,
  type ItemStack,
  type MobDef,
  type MobVariant,
  type NestDef,
  type PlayerStats,
  type ServerMessage,
  type StarterOutfit,
  type StarterWeapon,
  type StatGain,
  type Vec3,
} from '@sro/shared'
import { mobAggressive, retaliate, thinkMob, type AiHost } from './ai.ts'
import { Alchemy } from './alchemy.ts'
import { Berserk } from './berserk.ts'
import type { ServerConfig } from './config.ts'
import type { WorldSetup } from './content.ts'
import type { CharacterRow, Store } from './db.ts'
import { Durability } from './durability.ts'
import { CORPSE_MS, REGEN, RIDDEN_CORPSE_MS, VARIANT_RULES, attacksMagically, maxHpFor, maxMpFor, mobCombatStats, playerCombatStats, rollSkillHit, type CombatStats, type Rng } from './formulas.ts'
import { genderOf, type GameData } from './gamedata.ts'
import { ItemUses } from './item-use.ts'
import {
  addGold,
  addItem,
  equipItem,
  fail,
  fits,
  moveItem,
  putBack,
  splitItem,
  takeFromBag,
  toInventory,
  toStack,
  unequipItem,
  type Fail,
  type InvDraft,
  type InvState,
  type Result,
} from './inventory.ts'
import { MobSkills } from './mob-skills.ts'
import { askGates, buildRoutes, fanOut, type Answer, type GameplayMessage, type GameplayModule, type KillOwner, type ModuleHook, type WarpReason } from './modules.ts'
import { Mounts } from './mounts.ts'
import type { NavPoint, NavProvider } from './nav.ts'
import { HIDDEN_NPCS, NpcDialogs } from './npc.ts'
import { PartyManager } from './party.ts'
import { Posture } from './posture.ts'
import { gainExp, setLevel as applySetLevel, type Progress, type SetLevelChange } from './progression.ts'
import { QuestEngine } from './quests/engine.ts'
import { Repairs } from './repair.ts'
import { Shops } from './shop.ts'
import { SkillEngine } from './skills/engine.ts'
import { GuildService } from './social/guild.ts'
import { StallService } from './social/stall.ts'
import { TradeService } from './social/trade.ts'
import { Spawner, type NestRuntime } from './spawner.ts'
import { StorageService } from './storage-db.ts'
import { WeatherService } from './weather.ts'
import { WinterService } from './winter.ts'
import { LightningService } from './lightning/service.ts'
import { StormService } from './storm/service.ts'
import { TornadoService } from './storm/tornado.ts'
import { WallService } from './siege/walls.ts'
import { WallRepair } from './siege/repair.ts'
import { WallLooters } from './siege/looters.ts'
import { SiegeService } from './siege/event.ts'
import { ThunderKegs } from './siege/keg.ts'
import { LawService } from './siege/law.ts'
import { MovementService } from './movement.ts'
import { WinterPlay } from './winter-play/service.ts'
import { Uniques } from './uniques.ts'
import { Pilot } from './pilot/service.ts'
import { WorldClock } from './world-clock.ts'
import { visibleEquip, visibleEquipPlus, WARP_SEARCH_M, type Cos, type Entity, type GroundItem, type Mob, type MobTuning, type NewPlayer, type Npc, type Player, type World } from './world.ts'

/**
 * Gameplay rules on top of the world simulation (docs/PROTOCOL.md §3-§8): combat (player auto-attack and mob
 * attacks share one path), deaths and rewards, loot, inventory/equipment/shop requests, regeneration, the nest
 * spawner and the GM gameplay commands. Runs inside World.tick (one authoritative simulation); the monster AI
 * itself is ai.ts, driven through the AiHost implemented here.
 */

export type { GameplayMessage } from './modules.ts'

/**
 * What Gameplay.dealHits' caller says about the hits: the skill row, cast instance, landing time and area flag of the
 * `combat` message, and (wave 8) `dot` for a burn/poison tick (SkillEngine.tickEffect), which the horse redirect and
 * durability wear skip (docs/SYSTEMS_COMBAT.md §1.3, §3.2).
 */
export interface HitExtra {
  skill?: string
  instance?: number
  at?: number
  aoe?: boolean
  dot?: true
}

/** Requests Gameplay answers itself; every other GameplayRequest is routed to the module that handles it. */
export const CORE_REQUESTS: readonly GameplayRequest[] = ['attack', 'stopAction', 'pickup', 'statUp', 'itemMove', 'itemSplit', 'itemEquip', 'itemUnequip', 'itemDrop', 'respawn']

export interface GameplayDeps {
  world: World
  data: GameData
  store: Store
  config: ServerConfig
  setup: WorldSetup
  nav: NavProvider
  rng?: Rng
}

/** Rule: how often a chasing player re-plans its run to a moving target. */
const PLAYER_REPLAN_MS = 250
/** Mobs farther than this from every player skip their idle AI (they cannot be seen anyway). */
const DORMANT_MARGIN_M = 30
/** Nest centres and spawn points: open ground is searched at most this far out (metres; rings of 1 m). */
const NEST_SEARCH_M = 20
/** Spawn candidates tried at random inside a nest's spawn radius before the ring search. */
const NEST_SPAWN_TRIES = 8
/** GM-spawned mobs: roam, sight and leash (metres). */
const GM_MOB_ROAM = 5
const GM_MOB_SIGHT = 15
const GM_MOB_LEASH = 40

/** Gold pile model by amount (client items ITEM_ETC_GOLD_01..03: small, medium, large). */
export function goldCode(amount: number): string {
  return amount < 1000 ? GOLD_ITEM_CODES[0] : amount < 10_000 ? GOLD_ITEM_CODES[1] : GOLD_ITEM_CODES[2]
}

export function isGoldCode(code: string): boolean {
  return (GOLD_ITEM_CODES as readonly string[]).includes(code)
}

/**
 * A ground item with its toss (docs/EFFECTS.md §3.6, P1): the server ms it reached the ground and, for loot, the corpse
 * point it was thrown from. Kept beside world.ts's GroundItem; `dropTag` puts them on the EntityState.
 */
export type TossedItem = GroundItem & { droppedAt?: number; dropFrom?: Vec3 }

/** Decorator (docs/WAVE_PLAN2.md §3.1): `droppedAt` (an integer, as the validator requires) and `dropFrom` of a drop. */
export function dropTag(e: Entity, s: EntityState): void {
  if (e.kind !== 'item') return
  const t = e as TossedItem
  if (t.droppedAt !== undefined) s.droppedAt = t.droppedAt
  if (t.dropFrom) s.dropFrom = [...t.dropFrom]
}

/** One rolled drop of a kill. `plus` (wave 11, a unique's loot; docs/UNIQUES.md §3.4) reaches the ground item; absent = 0. */
export interface RolledDrop {
  code: string
  count: number
  gold?: boolean
  plus?: number
}

/**
 * Rolls a drop table (docs/PROTOCOL.md §6): gold, then each group once, then one entry by weight. `rates` are the
 * GOLD_RATE (gold amount) and DROP_RATE (each item group's chance, at most 1) knobs; absent = 1.
 */
export function rollDrops(table: DropTable | undefined, rng: Rng, known: (code: string) => boolean, rates: { gold?: number; drop?: number } = {}): RolledDrop[] {
  if (!table) return []
  const out: RolledDrop[] = []
  if (table.gold && rng() < table.gold.chance) {
    const [lo, hi] = table.gold.amount
    const amount = Math.round(Math.round(lo + rng() * (hi - lo)) * (rates.gold ?? 1))
    if (amount > 0) out.push({ code: goldCode(amount), count: amount, gold: true })
  }
  const dropRate = rates.drop ?? 1
  for (const g of table.groups) {
    if (rng() >= Math.min(1, g.chance * dropRate)) continue
    const entries = g.entries.filter((e) => e.weight > 0 && known(e.item))
    const total = entries.reduce((s, e) => s + e.weight, 0)
    if (total <= 0) continue
    let r = rng() * total
    const pick = entries.find((e) => (r -= e.weight) < 0) ?? entries[entries.length - 1]
    const [lo, hi] = pick.count ?? [1, 1]
    out.push({ code: pick.item, count: Math.max(1, Math.round(lo + rng() * (hi - lo))) })
  }
  return out
}

/** EXP/SP-EXP per player from a kill: each player's share of the damage done by players still here. */
export function shareRewards(damage: Map<number, number>, present: (id: number) => boolean, exp: number, spExp: number): Map<number, { exp: number; spExp: number }> {
  const out = new Map<number, { exp: number; spExp: number }>()
  let total = 0
  for (const [id, d] of damage) if (present(id) && d > 0) total += d
  if (total <= 0) return out
  for (const [id, d] of damage) {
    if (!present(id) || d <= 0) continue
    out.set(id, { exp: Math.round((exp * d) / total), spExp: Math.round((spExp * d) / total) })
  }
  return out
}

/** EXP and SP-EXP a kill is worth: MobDef.exp x VARIANT_RULES[variant].exp x tuning.expMul (docs/QUESTS.md §4.2). */
export function killExp(m: Mob): { exp: number; spExp: number } {
  const mul = VARIANT_RULES[m.variant].exp * (m.tuning?.expMul ?? 1)
  return { exp: m.def.exp * mul, spExp: (m.def.spExp ?? m.def.exp) * mul }
}

/** Who may pick up one dropped item during the owner window (docs/QUESTS.md §4.3). */
export interface LootOwner {
  player: Player | null
  /** Party id whose members share the window (GroundItem.ownerParty), or null. */
  party: number | null
}

/** Loot owners of a kill: `next()` is called once per dropped item, in drop order (share mode: round robin). */
export interface LootPlan {
  next(): LootOwner
}

/**
 * The outcome of a kill (docs/WAVE_PLAN.md decision 41): EXP/SP-EXP per player entity id, the players credited for
 * quest kill objectives (decision 40), and who owns the loot. PartyManager.killShares builds it for kills that
 * involve a party; soloShares otherwise.
 */
export interface KillShares {
  shares: Map<number, { exp: number; spExp: number }>
  /** Player entity ids that get quest kill credit (the modules' mobDied hook). */
  credit: Set<number>
  lootOwners: LootPlan
  /**
   * Wave 11 (docs/UNIQUES.md §3.3): the group that owns the loot (the most damage), named by its top-damage member and,
   * for a party, the party id. Absent = no owner (Gameplay hands { player: null, party: null } to the modules).
   */
  lootGroup?: { player: Player | null; party: number | null }
}

/**
 * The solo rule (the wave-3 behaviour): EXP shared by damage among players still in the world (shareRewards); credit =
 * those of them that are alive (decision 40); every drop belongs to the top damage dealer still in the world.
 */
export function soloShares(m: Mob, playerOf: (id: number) => Player | undefined): KillShares {
  const { exp, spExp } = killExp(m)
  const shares = shareRewards(m.damage, (id) => playerOf(id) !== undefined, exp, spExp)
  const credit = new Set<number>()
  for (const id of shares.keys()) if (!playerOf(id)?.dead) credit.add(id)
  let owner: Player | null = null
  let best = 0
  for (const [id, d] of m.damage) {
    const p = playerOf(id)
    if (p && d > best) {
      owner = p
      best = d
    }
  }
  return { shares, credit, lootOwners: { next: () => ({ player: owner, party: null }) }, lootGroup: { player: owner, party: null } }
}

export class Gameplay implements AiHost {
  readonly world: World
  readonly data: GameData
  readonly store: Store
  readonly config: ServerConfig
  readonly setup: WorldSetup
  readonly nav: NavProvider
  readonly spawner: Spawner
  readonly rng: Rng
  now = Date.now()
  // ---- modules (docs/WAVE_PLAN.md §3.1) ----
  readonly skills: SkillEngine
  readonly npcs: NpcDialogs
  readonly shops: Shops
  readonly storage: StorageService
  readonly itemUses: ItemUses
  // wave 4 (docs/WAVE_PLAN.md §5.1 W4-FS): lanes QS-S and PT-S fill them
  readonly quests: QuestEngine
  readonly party: PartyManager
  // wave 7B (docs/WAVE_PLAN2.md §5.8 FX-S): sit and emotes
  readonly posture: Posture
  // wave 8 (docs/WAVE_PLAN2.md §2.5, §6.1 W8-F): stubs the lanes fill
  readonly mobSkills: MobSkills
  readonly mounts: Mounts
  readonly durability: Durability
  readonly repairs: Repairs
  readonly alchemy: Alchemy
  readonly berserk: Berserk
  readonly trade: TradeService
  readonly stalls: StallService
  readonly guilds: GuildService
  // wave 9 (docs/WAVE_PLAN3.md §6.1 W9A-P): the world clock (not a module: GM `time`, worldEnter) and the weather
  readonly clock: WorldClock
  readonly weather: WeatherService
  /** Lightning that strikes (docs/WEATHER.md §2.7): places, telegraphs and lands the weather's strikes. */
  readonly lightning: LightningService
  /**
   * Storms change everything (docs/WEATHER.md §12): storm events and their forecast, and the weather's hooks into the AI
   * (AiHost.storm), combat (dealHits, hazardHit, skill elements), spawns (Spawner countMul), mud and loot.
   */
  readonly storm: StormService
  /** The lightning tornado (docs/WEATHER.md §13): a rare storm event that pulls, throws and strikes, never kills. */
  readonly tornado: TornadoService
  /**
   * Siege of Jangan, the walls (docs/SIEGE.md §2, §4, §5; siege/walls.ts): 33 segments that crack, breach and fall to
   * rubble, with the nav and the safe area following. Inert without a mesh nav and the export's siege/walls.json.
   */
  readonly walls: WallService
  /**
   * Siege of Jangan layer 3 (docs/SIEGE.md §2.4, §2.5; siege/repair.ts, siege/looters.ts): Master Mason Ko, donations
   * and the builders, the Mason's Kit; looters at the open gaps. Inert while the walls are.
   */
  readonly wallRepair: WallRepair
  readonly wallLooters: WallLooters
  /**
   * Siege of Jangan layer 4 (docs/SIEGE.md §6; siege/event.ts, army.ts, lanes.ts): the siege event, its army, the Town
   * Bell, sapper kegs, rewards and schedule. Inert while the walls are, or without lanes that walk.
   */
  readonly siege: SiegeService
  /**
   * Siege of Jangan layer 5 (docs/SIEGE.md §7, §8; siege/keg.ts, law.ts): the players' Thunder Keg (Old Fang, Saltpeter,
   * plant, defuse, blast) and the law (warrants, the WANTED label, the online-time lapse, the per-account record).
   */
  readonly kegs: ThunderKegs
  readonly law: LawService
  /**
   * The snow season (docs/WINTER.md): the season's dates, the snow cover and the frost; the weather asks it whether rain
   * falls as snow. Other modules read `winter.state(now)`.
   */
  readonly winter: WinterService
  // wave 10 (docs/WAVE_PLAN6.md §3; lane MV-P): the jump
  readonly movement: MovementService
  /**
   * The winter gameplay layer (docs/WINTER.md §13; winter-play/): body warmth, snowball fights, snow spirits, the Ice
   * Yeti and gift boxes, only in the snow season (or a GM preview). Its five modules are registered right after it.
   */
  readonly winterPlay: WinterPlay
  /**
   * Wave 11 (docs/UNIQUES.md §3; WAVE_PLAN7 §4.2): unique monsters as world bosses (uniques.ts, lane U-S). null when
   * UNIQUES=off: the Spawner then keeps the unique groups as plain nests (the wave-10 behaviour).
   */
  readonly uniques: Uniques | null
  /**
   * Play the Boss (docs/PLAY_THE_BOSS.md; pilot/): a player steers a unique while everyone else hunts her. Registered
   * after `uniques` when UNIQUES=on (inert until a unique of this world has a `pilot` block); null otherwise.
   */
  readonly pilot: Pilot | null
  /** Every module, in registration order (enter-world order, hook order). */
  readonly modules: readonly GameplayModule[]
  /** Request type -> the module that answers it (built from `handles`; a duplicate throws). */
  readonly routes: ReadonlyMap<GameplayRequest, GameplayModule>

  constructor(d: GameplayDeps) {
    this.world = d.world
    this.data = d.data
    this.store = d.store
    this.config = d.config
    this.setup = d.setup
    this.nav = d.nav
    this.rng = d.rng ?? Math.random
    // Wave 11: UNIQUES=on (the default) gives the unique groups to the uniques module; the Spawner refuses their nests.
    const uniquesOn = d.config.uniques ?? true
    this.spawner = new Spawner(
      d.config.spawnMobs ? d.data.nests : [],
      (code) => d.data.mob(code),
      { world: d.config.world, mobLevelMax: d.config.mobLevelMax, rng: this.rng, countScale: d.config.nestCountScale, skipUniqueGroups: uniquesOn, countMul: (n) => this.storm?.countMul(n) ?? 1 },
      (x, z, nest) => this.nav.place(x, z, nest.y ?? NaN, Math.min(NEST_SEARCH_M, Math.max(nest.radius, nest.spawnRadius))) !== null,
    )
    this.skills = new SkillEngine(this)
    this.npcs = new NpcDialogs(this)
    this.shops = new Shops(this)
    this.storage = new StorageService(this)
    this.itemUses = new ItemUses(this)
    this.quests = new QuestEngine(this)
    this.party = new PartyManager(this)
    this.posture = new Posture(this)
    this.mobSkills = new MobSkills(this)
    this.mounts = new Mounts(this)
    this.durability = new Durability(this)
    this.repairs = new Repairs(this)
    this.alchemy = new Alchemy(this)
    this.berserk = new Berserk(this)
    this.trade = new TradeService(this)
    this.stalls = new StallService(this)
    this.guilds = new GuildService(this)
    this.clock = WorldClock.load(d.config)
    // docs/WINTER.md: the season before the weather (a server started in December joins its snow), the snow after it
    this.winter = new WinterService(this)
    this.weather = new WeatherService(this)
    this.winter.attach(this.weather, (now) => this.daylight(now))
    this.lightning = new LightningService(this)
    this.weather.strikes = this.lightning
    this.storm = new StormService(this)
    this.tornado = new TornadoService(this)
    this.walls = new WallService(this)
    this.wallRepair = new WallRepair(this, this.walls)
    this.wallLooters = new WallLooters(this, this.walls)
    this.wallRepair.looters = this.wallLooters
    this.movement = new MovementService(this)
    this.winterPlay = new WinterPlay(this)
    this.uniques = uniquesOn ? new Uniques(this) : null
    this.pilot = this.uniques ? new Pilot(this, this.uniques) : null
    this.siege = new SiegeService(this, this.walls)
    this.kegs = new ThunderKegs(this, this.walls)
    this.law = new LawService(this)
    // Wave 11: a per-mob summon policy (a unique's own summon switch, clip, cap and variants; mob-skills.ts).
    this.mobSkills.summonPolicy = (m) => this.uniques?.summonPolicy(m) ?? null
    if (!this.world.decorators.includes(dropTag)) this.world.decorators.push(dropTag)
    // The NPC dialog offers the 'quest' service when the quest engine has a topic for the player (decision 1).
    this.npcs.topics = (p, code) => this.quests.hasTopics(p, code)
    this.npcs.lines = (p, code) => this.quests.dialogLines(p, code)
    // Registration order = enter-world, hook and gate order (docs/WAVE_PLAN2.md §2.5, D35).
    this.modules = [
      this.skills, this.npcs, this.shops, this.storage, this.itemUses, this.quests, this.party,
      this.posture,
      this.mobSkills, this.mounts, this.durability, this.repairs, this.alchemy, this.berserk,
      this.trade, this.stalls, this.guilds,
      this.weather,
      // docs/WINTER.md: the snow cover follows the weather of this tick
      this.winter,
      this.lightning,
      // docs/WEATHER.md §12: after the lightning (its onStrike hears the landings first)
      this.storm,
      // docs/WEATHER.md §13: after the storm (it reads the storm event)
      this.tornado,
      // docs/SIEGE.md §5.1: the walls, after the lightning and the tornado (their hooks wear the walls)
      this.walls,
      // docs/SIEGE.md §2.4, §2.5: repair and looters, after the walls
      this.wallRepair,
      this.wallLooters,
      // docs/SIEGE.md §6: the siege event, after the walls, repair and looters it reads
      this.siege,
      // docs/SIEGE.md §7, §8: the players' Thunder Kegs and the law (Wanted), after the siege (treason, kegDefuse)
      this.kegs,
      this.law,
      this.movement,
      // docs/WINTER.md §13: the winter gameplay layer (after the winter, weather and storm modules it reads)
      this.winterPlay,
      ...this.winterPlay.parts,
      // wave 11 (docs/WAVE_PLAN7.md §4.2): the uniques module, when UNIQUES=on
      ...(this.uniques ? [this.uniques] : []),
      // Play the Boss (docs/PLAY_THE_BOSS.md §3.1): after uniques
      ...(this.pilot ? [this.pilot] : []),
    ]
    this.routes = buildRoutes(this.modules, CORE_REQUESTS)
    this.world.onTick = (now) => this.tick(now)
  }

  /** Runs `hook` on every module (a throwing module is logged and skipped). */
  private hook<K extends ModuleHook>(name: K, ...args: Parameters<NonNullable<GameplayModule[K]>>): void {
    fanOut(this.modules, name, args, (e, where) => this.config.log(`gameplay module ${where} failed: ${(e as Error)?.stack ?? e}`))
  }

  /**
   * The modules' veto on request `t` of `p` (docs/WAVE_PLAN2.md §4.2): every module but `own` (the one that handles
   * `t`; null for core requests and moveTo), in registration order; the first Fail wins; a throwing gate allows.
   */
  private gateFor(p: Player, t: GameplayRequest | 'moveTo', own: GameplayModule | null | undefined, now: number): Fail | null {
    return askGates(this.modules, own, p, t, now, (e, where) => this.config.log(`gameplay module ${where} failed: ${(e as Error)?.stack ?? e}`))
  }

  /** A player was warped outside toTown (GM tp/summon): tells the modules (e.g. NPC dialogs close with 'warp'). */
  warped(p: Player, reason: WarpReason, now = Date.now()): void {
    this.hook('warped', p, reason, now)
  }

  /** Places NPCs and fills every nest. Returns a log line. */
  /** Daylight 0..1 at server ms `now` from the world clock (1 by day, 0 from 6° below the horizon; docs/WINTER.md §2). */
  daylight(now: number): number {
    const c = this.clock.state
    return 1 - nightness(sunDirection(clockAt(c, now).t, c.declination)[1])
  }

  start(now = Date.now()): string {
    this.now = now
    let npcs = 0
    for (const n of this.data.npcs) {
      if (n.world !== this.config.world || HIDDEN_NPCS.includes(n.code)) continue
      if (this.placeNpc(n, now)) npcs++
    }
    const mobs = this.spawner.fill((nest) => this.spawnNestMob(nest, now))
    // Wave 11: the uniques module loads its saved timers (uniques table) and schedules its spawns.
    const uniques = this.uniques?.start(now) ?? null
    if (uniques) this.config.log(uniques)
    const skipped = this.spawner.skipped.length
    return `world content: ${npcs} NPCs, ${this.spawner.nests.length} nests (${skipped} skipped), ${mobs} monsters spawned`
  }

  /**
   * Adds one NPC entity (start, and the GM NPC editor; docs/QUESTS.md §5.3). NPCs stand where the client puts them; only
   * their height comes from the navmesh (surface nearest npcpos y). An authored NPCX_* wears its base NPC's model
   * (GameData.npcModel). null when there is no ground there.
   */
  placeNpc(n: GameData['npcs'][number], now = Date.now()): Npc | null {
    const at = this.nav.locate(n.x, n.z, n.y ?? Infinity) ?? this.nav.place(n.x, n.z, n.y ?? NaN, 5)
    if (!at) return null
    const npc: Npc = { kind: 'npc', id: this.world.newId(), code: n.code, name: n.name ?? n.code, pos: [at.x, at.y, at.z], yaw: n.yaw ?? 0 }
    const model = this.data.npcModel.get(n.code)
    if (model && model !== n.code) npc.model = model
    this.world.addEntity(npc, now)
    return npc
  }

  /** Removes the NPC entity whose identity is `code` (open dialogs close with 'gone' on the next tick). */
  removeNpc(code: string): boolean {
    let removed = false
    for (const npc of [...this.world.npcs.values()]) {
      if (npc.code !== code) continue
      this.world.removeEntity(npc.id)
      removed = true
    }
    return removed
  }

  /** GM spawn editor: spawns the mobs `nest` is missing now. */
  fillNest(nest: NestRuntime, now = Date.now()): number {
    this.now = now
    return this.spawner.fillNest(nest, (n) => this.spawnNestMob(n, now))
  }

  /** GM spawn editor: nest mobs leave the world at once (no corpse, no loot, no respawn timer). */
  despawnNestMobs(ids: Iterable<number>): void {
    for (const id of ids) {
      this.spawner.forget(id)
      if (this.world.mobs.has(id)) this.world.removeEntity(id)
    }
  }

  // ---- AiHost ---------------------------------------------------------------------------------------

  positionOf(e: Mob | Player): Vec3 {
    return this.world.positionAt(e, this.now)
  }

  /** Mobs leave alone the dead, invisible GMs and anyone inside a town's safe area. */
  target(id: number): Player | undefined {
    const p = this.world.players.get(id)
    return p && this.attackable(p) ? p : undefined
  }

  playersNear(x: number, z: number, range: number): Player[] {
    return this.world.playersNear(x, z, range, this.now).filter((p) => this.attackable(p))
  }

  private attackable(p: Player): boolean {
    // Play the Boss: a body in a trance is never a target (docs/PLAY_THE_BOSS.md §3.3).
    if (p.dead || p.invisible || p.trance) return false
    const [x, , z] = this.world.positionAt(p, this.now)
    return !this.data.inSafeArea(this.config.world, x, z)
  }

  canWalk(x: number, z: number): boolean {
    return this.nav.canWalk(x, z)
  }

  clear(m: Mob, x: number, z: number): boolean {
    if (this.nav.kind !== 'mesh') return true
    const w = this.nav.walk(this.world.livePoint(m, this.now), x, z)
    return w !== null && !w.blocked
  }

  warpHome(m: Mob): void {
    const home = this.nav.place(m.home[0], m.home[1], m.nest?.y ?? m.pos[1], Math.min(NEST_SEARCH_M, m.roamRadius))
    if (home) this.world.warp(m, home.x, home.y, home.z, this.now, home)
  }

  move(m: Mob, x: number, z: number, speed: number): boolean {
    if (speed <= 0) return false
    return this.world.moveEntity(m, x, z, speed, this.now)
  }

  halt(m: Mob, yaw?: number): void {
    this.world.halt(m, this.now, yaw)
  }

  swing(m: Mob, target: Player): void {
    // Wave 8: the monster-skill pick (mob-skills.ts); the stub keeps today's one basic attack.
    this.mobSkills.swing(m, target, this.now)
  }

  /** Wave 8 (docs/SYSTEMS_COMBAT.md §2.2): a mob's ranged special instead of a chase (mob-skills.ts). */
  ranged(m: Mob, target: Player, dist: number): boolean {
    return this.mobSkills.ranged(m, target, dist, this.now)
  }

  restored(m: Mob): void {
    // Play the Boss (docs/PLAY_THE_BOSS.md §3.4): during the event no refill and no reset at home.
    if (m.pilot) return
    // docs/SIEGE.md §6.3: a siege monster back from a chase is not healed.
    if (m.siege) return
    // H11-FURY-1: the AI got her home (a leash reset); the uniques module resets her fight here, whatever else this
    // tick does to her afterwards (a projectile or DoT landing before its tick would hide the reset from a poll).
    this.uniques?.homeReached(m)
    if (m.hp >= m.maxHp) return
    m.hp = m.maxHp
    this.world.broadcastAbout(m, { t: 'entityUpdate', id: m.id, hp: m.hp, maxHp: m.maxHp })
  }

  // ---- entities ---------------------------------------------------------------------------------------

  /**
   * A new mob in the world. `tuning` (quest encounters, docs/QUESTS.md §1.6) multiplies its HP and attack here and
   * its kill EXP in killExp; the Mob keeps it. `init` (Siege of Jangan) finishes the mob before anyone sees it (its
   * spawn message carries what init set).
   */
  createMob(def: MobDef, variant: MobVariant, x: number, z: number, y: number, nest: NestDef | null, now: number, surface: NavPoint['surface'] = null, tuning?: MobTuning, init?: (m: Mob) => void): Mob {
    const maxHp = Math.max(1, Math.round(def.hp * VARIANT_RULES[variant].hp * (tuning?.hpMul ?? 1)))
    const tactics = nest?.tactics
    const combat = mobCombatStats(def, variant, tuning?.attackMul ?? 1)
    const mob: Mob = {
      kind: 'mob',
      id: this.world.newId(),
      def,
      variant,
      name: def.name ?? def.code,
      level: def.level,
      hp: maxHp,
      maxHp,
      // A giant's body is as big as the client draws it (@sro/shared VARIANT_SCALE), so melee reaches its edge.
      radius: Math.max(0.2, def.radius * variantScale(variant)),
      combat,
      pos: [x, y, z],
      yaw: this.rng() * Math.PI * 2,
      move: null,
      surface,
      path: null,
      home: nest ? [nest.x, nest.z] : [x, z],
      roamRadius: nest ? nest.radius : GM_MOB_ROAM,
      sightRange: tactics?.sightRange ?? GM_MOB_SIGHT,
      leashRange: Math.max(tactics?.leashRange ?? GM_MOB_LEASH, (nest?.radius ?? GM_MOB_ROAM) + 10),
      aggressive: mobAggressive(def, variant, tactics),
      nest,
      ai: 'idle',
      target: null,
      damage: new Map(),
      nextSwingAt: 0,
      nextThinkAt: now + this.rng() * 5000,
      lastCombatAt: 0,
      nextRegenAt: 0,
      diedAt: 0,
    }
    if (tuning) mob.tuning = tuning
    // H11-CU-1: a ridden mob's death (the composite's DIE1) must play out before the corpse goes.
    if (def.ride) mob.corpseMs = RIDDEN_CORPSE_MS
    init?.(mob)
    this.world.addEntity(mob, now)
    return mob
  }

  /**
   * Where a nest mob appears: a random point of the spawn circle on open ground (never inside or under a house, never
   * on closed terrain), with the navmesh height nearest the nest's y; failing that, the open ground nearest the nest
   * centre within its radius. null: nowhere (the spawner retries later).
   */
  nestSpawnPoint(def: NestDef): NavPoint | null {
    const hint = def.y ?? NaN
    for (let i = 0; i < NEST_SPAWN_TRIES; i++) {
      const a = this.rng() * Math.PI * 2
      const r = Math.sqrt(this.rng()) * def.spawnRadius
      const p = this.nav.place(def.x + Math.sin(a) * r, def.z + Math.cos(a) * r, hint)
      if (p) return p
    }
    return this.nav.place(def.x, def.z, hint, Math.min(NEST_SEARCH_M, Math.max(def.spawnRadius, def.radius)))
  }

  private spawnNestMob(nest: NestRuntime, now: number): number | null {
    const { def, mob } = nest
    const at = this.nestSpawnPoint(def)
    if (!at) return null
    let variant: MobVariant = mob.rarity === 'unique' ? 'unique' : 'normal'
    if (variant === 'normal') {
      const roll = this.rng() * 100
      if ((mob.variants ?? []).includes('giant') && roll < this.config.giantPct) variant = 'giant'
      else if (roll < this.config.giantPct + (def.championPct ?? 0)) variant = 'champion'
    }
    const y = this.nav.kind === 'mesh' ? at.y : (def.y ?? 0)
    return this.createMob(mob, variant, at.x, at.z, y, def, now, at.surface).id
  }

  /**
   * A new ground item at `at`. `from`: where it was thrown from (the corpse point of loot; absent for a player's drop).
   * Every item carries `droppedAt` = `now` (fresh ones play the toss on the client; docs/EFFECTS.md §3.6).
   */
  spawnGroundItem(code: string, count: number, plus: number, at: Vec3, owner: Player | null, now: number, durability: number | null = null, ownerParty: number | null = null, from?: Vec3): GroundItem {
    const def = this.data.item(code)
    const gold = isGoldCode(code)
    const item: TossedItem = {
      kind: 'item',
      id: this.world.newId(),
      code,
      name: gold ? `${count} Gold` : (def?.name ?? code),
      count,
      plus,
      durability,
      pos: [...at],
      yaw: this.rng() * Math.PI * 2,
      owner: owner?.id ?? null,
      ownerChar: owner?.characterId ?? null,
      ownerUntil: owner === null ? 0 : now + ITEM_OWNER_MS,
      expiresAt: now + ITEM_EXPIRE_MS,
      droppedAt: Math.max(0, Math.round(now)),
    }
    if (from) item.dropFrom = [...from]
    if (ownerParty !== null && owner !== null) {
      item.ownerParty = ownerParty
      item.ownerPartyItems = this.party.parties.get(ownerParty)?.items ?? 'free'
    }
    this.world.addEntity(item, now)
    return item
  }

  // ---- player lifecycle -------------------------------------------------------------------------------

  /** Everything world.add needs from a saved character, including its worn items. */
  playerInit(row: CharacterRow): Partial<NewPlayer> & Pick<NewPlayer, 'gender' | 'progress'> {
    const progress: Progress = {
      level: row.level,
      exp: row.exp,
      sp: row.sp,
      spExp: row.sp_exp,
      str: row.strength,
      int: row.intellect,
      statPoints: row.stat_points,
    }
    const equip = this.equipOf(this.store.loadInventory(row.id))
    return {
      gender: genderOf(row.model),
      progress,
      gold: row.gold,
      hp: row.hp ?? undefined,
      mp: row.mp ?? undefined,
      dead: row.dead === 1,
      equip,
      combat: this.combatFor(progress, equip),
    }
  }

  private equipOf(inv: InvState): Partial<Record<EquipSlot, ItemStack>> {
    const equip: Partial<Record<EquipSlot, ItemStack>> = {}
    for (const slot of EQUIP_SLOTS) {
      const it = inv.equip[slot]
      if (it) equip[slot] = toStack(it)
    }
    return equip
  }

  private combatFor(p: Progress, equip: Partial<Record<EquipSlot, ItemStack>>) {
    const worn: { def: ItemDef; stack: ItemStack }[] = []
    for (const stack of Object.values(equip)) {
      const def = stack && this.data.item(stack.code)
      if (def && stack) worn.push({ def, stack })
    }
    return playerCombatStats(p.level, p.str, p.int, worn)
  }

  /**
   * Starter kit (docs/PROTOCOL.md §4): the chosen starter weapon and the default set of the chosen outfit for the
   * gender (clothes: ITEM_CH_M_CLOTHES_01_*_A_DEF, light: ..._LIGHT_01_..., heavy: ..._HEAVY_01_...), equipped.
   * Given once; when items.json is missing it waits for the first entry after it appears.
   */
  grantStarterKit(characterId: number, weapon: StarterWeapon, model: string, outfit: StarterOutfit = 'clothes'): boolean {
    const items: { code: string; slot: EquipSlot }[] = []
    const w = this.data.starterWeapon(weapon)
    if (w) items.push({ code: w.code, slot: 'weapon' })
    for (const g of this.data.starterOutfit(genderOf(model), outfit)) {
      const slot = g.slot === 'ring' ? 'ring1' : g.slot!
      if (!items.some((i) => i.slot === slot)) items.push({ code: g.code, slot })
    }
    return this.store.grantStarterKit(characterId, items)
  }

  /** Recomputes derived stats after a level/stat/equipment change. Returns whether max HP/MP changed. */
  refresh(p: Player): boolean {
    // Skill mods (passives, buffs; docs/SKILLS.md §10.1) are the last step of the derived stats.
    const mods = this.skills.modsFor(p)
    const maxHp = maxHpFor(p.progress.level, p.progress.str) + mods.maxHp
    const maxMp = maxMpFor(p.progress.level, p.progress.int) + mods.maxMp
    const changed = maxHp !== p.maxHp || maxMp !== p.maxMp
    p.level = p.progress.level
    p.maxHp = maxHp
    p.maxMp = maxMp
    p.hp = Math.min(p.hp, maxHp)
    p.mp = Math.min(p.mp, maxMp)
    p.combat = this.skills.applyStats(p, this.combatFor(p.progress, p.equip), mods)
    return changed
  }

  stats(p: Player): PlayerStats {
    const c = p.combat
    return {
      level: p.progress.level,
      exp: p.progress.exp,
      expToNext: this.data.expToNext(p.progress.level, this.config.levelCap),
      sp: p.progress.sp,
      spExp: p.progress.spExp,
      hp: Math.round(p.hp),
      maxHp: p.maxHp,
      mp: Math.round(p.mp),
      maxMp: p.maxMp,
      str: p.progress.str,
      int: p.progress.int,
      statPoints: p.progress.statPoints,
      gold: p.gold,
      physAttack: [...c.physAttack],
      magAttack: [...c.magAttack],
      physDefence: c.physDefence,
      magDefence: c.magDefence,
      hitRate: c.hitRate,
      parryRate: c.parryRate,
      // Wave 8 (D33, D34): always sent; the Berserk module reads the saved points through its cache.
      hwan: this.berserk.points(p),
    }
  }

  /** After worldEnter: stats, then inventory, then each module's own (skills, ...) (docs/PROTOCOL.md "Enter-world sequence"). */
  sendEnter(p: Player, now = Date.now()): void {
    p.send({ t: 'stats', stats: this.stats(p) })
    p.send({ t: 'inventory', inventory: toInventory(this.store.loadInventory(p.characterId)) })
    this.hook('enter', p, now)
  }

  /** The player leaves the world: mobs and modules forget it. */
  forget(p: Player): void {
    for (const m of this.world.mobs.values()) {
      m.damage.delete(p.id)
      if (m.target === p.id) m.target = null
    }
    this.hook('forget', p)
  }

  /** A client `moveTo`: cancels the current action (auto-attack, pickup walk). */
  onMoveTo(p: Player, now = Date.now()): boolean {
    if (p.dead) return false
    // Wave 8: a gated moveTo (a stall owner, ...) is dropped without a message and the position stays.
    if (this.gateFor(p, 'moveTo', null, now)) return false
    p.action = null
    this.hook('moved', p, now)
    return true
  }

  // ---- requests ------------------------------------------------------------------------------------------

  /** Handles one gameplay request; sends exactly one actionResult (before any effect of the request). */
  request(p: Player, msg: GameplayMessage, now = Date.now()): void {
    this.now = now
    let answered = false
    const answer: Answer = (r) => {
      if (answered) return
      answered = true
      const ok = r === true || r.ok
      const res: ServerMessage =
        ok
          ? { t: 'actionResult', re: msg.t, ok: true }
          : r.message
            ? { t: 'actionResult', re: msg.t, ok: false, reason: r.reason, message: r.message }
            : { t: 'actionResult', re: msg.t, ok: false, reason: r.reason }
      p.send(res)
      // An accepted attack, useSkill, pickup or npcTalk stands a sitter up (posture.ts), right after its actionResult
      // and before the request's own effects (a cast, a pickup, a dialog), so viewers get 'stand' before the action.
      if (ok) this.posture.afterRequest(p, msg.t)
    }
    try {
      if (msg.t === 'respawn') return this.respawn(p, answer)
      const mod = this.routes.get(msg.t)
      if (p.dead && !mod?.whileDead?.includes(msg.t)) return answer(fail('dead'))
      // Wave 8 (docs/SYSTEMS_SOCIAL.md §2.3): the modules' veto (trade/stall locks, mounts, the alchemy soft lock).
      const veto = this.gateFor(p, msg.t, mod, now)
      if (veto) return answer(veto)
      if (mod) return mod.request!(p, msg, answer, now)
      switch (msg.t) {
        case 'attack':
          return this.attackRequest(p, msg.target, answer)
        case 'stopAction':
          p.action = null
          if (p.move) this.world.halt(p, now)
          answer(true)
          return this.hook('stopped', p, now)
        case 'pickup':
          return this.pickupRequest(p, msg.id, answer)
        case 'statUp':
          return this.statUp(p, msg.stat, msg.points, answer)
        case 'itemMove':
          return this.invOp(p, (d) => moveItem(d, msg.from, msg.to, (c) => this.data.item(c)), answer)
        case 'itemSplit':
          return this.invOp(p, (d) => splitItem(d, msg.from, msg.to, msg.count), answer)
        case 'itemEquip':
          return this.invOp(p, (d) => equipItem(d, msg.bag, msg.slot, { level: p.progress.level, gender: p.gender }, (c) => this.data.item(c)), answer)
        case 'itemUnequip':
          return this.invOp(p, (d) => unequipItem(d, msg.slot, msg.bag), answer)
        case 'itemDrop':
          return this.itemDrop(p, msg.bag, msg.count, answer)
      }
    } finally {
      if (!answered) answer(fail('not_found'))
    }
  }

  private attackRequest(p: Player, targetId: number, answer: (r: Result<unknown> | true) => void): void {
    // Wave 8: 'mounted' (mounts.ts), 'broken' weapon (durability.ts).
    const refused = this.mounts.refuse(p, 'attack') ?? this.durability.refuse(p, 'attack')
    if (refused) return answer(refused)
    const e = this.world.entity(targetId)
    if (!e || !p.known.has(targetId)) return answer(fail('not_found'))
    if (e.kind !== 'mob') return answer(fail('invalid_target', e.kind === 'player' ? 'no PvP' : undefined))
    if (e.ai === 'dead') return answer(fail('target_dead'))
    const [x, , z] = this.world.positionAt(p, this.now)
    if (this.data.inSafeArea(this.config.world, x, z)) return answer(fail('safe_zone', 'no fighting in town'))
    p.action = { kind: 'attack', target: e.id, chaseAt: 0, chaseTo: null }
    answer(true)
  }

  private pickupRequest(p: Player, id: number, answer: (r: Result<unknown> | true) => void): void {
    const item = this.world.items.get(id)
    if (!item || !p.known.has(id)) return answer(fail('not_found'))
    const problem = this.pickupProblem(p, item)
    if (problem) return answer(problem)
    if (this.world.distance(p, item, this.now) <= PICKUP_RANGE) {
      const r = this.pickUp(p, item, answer)
      if (!r.ok) answer(r)
      return
    }
    p.action = { kind: 'pickup', item: id, chaseAt: 0, chaseTo: null }
    answer(true)
  }

  private pickupProblem(p: Player, item: GroundItem): Result<unknown> | null {
    // Party members share an item's owner window (docs/QUESTS.md §4.3; PartyManager.mayLoot).
    if (item.ownerChar !== null && item.ownerChar !== p.characterId && this.now < item.ownerUntil && !this.party.mayLoot(p, item)) return fail('not_owner')
    if (isGoldCode(item.code)) return null
    const def = this.data.item(item.code)
    if (!def) return fail('not_found')
    if (!fits(this.store.loadInventory(p.characterId), def, item.count, item.plus, item.durability)) return fail('inventory_full')
    return null
  }

  /** Takes a ground item into the bag (or gold). `answer` runs after the commit, before the effects. */
  private pickUp(p: Player, item: GroundItem, answer?: (r: true) => void): Result<unknown> {
    const problem = this.pickupProblem(p, item)
    if (problem) return problem
    const gold = isGoldCode(item.code)
    // Share-mode party gold is split among the members near the picker (docs/QUESTS.md §4.3).
    const split = gold ? this.party.goldSplit(p, item, this.now) : null
    const def = this.data.item(item.code)
    const { result, draft } = this.store.inventoryTx(p.characterId, (d) => (gold ? addGold(d, split?.keep ?? item.count) : putBack(d, def!, { code: item.code, count: item.count, plus: item.plus, durability: item.durability })))
    if (!result.ok) return result
    answer?.(true)
    this.world.removeEntity(item.id)
    this.afterInventory(p, draft)
    split?.pay()
    return result
  }

  private statUp(p: Player, stat: 'str' | 'int', points: number, answer: (r: Result<unknown> | true) => void): void {
    if (points > p.progress.statPoints) return answer(fail('no_points'))
    const next = { ...p.progress, statPoints: p.progress.statPoints - points }
    if (stat === 'str') next.str += points
    else next.int += points
    this.store.saveProgress(p.characterId, next)
    p.progress = next
    answer(true)
    const changed = this.refresh(p)
    p.send({ t: 'stats', stats: this.stats(p) })
    if (changed) this.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, hp: Math.round(p.hp), maxHp: p.maxHp })
  }

  /** Runs a pure inventory operation for `p` and sends its effects. */
  invOp(p: Player, fn: (d: InvDraft) => Result<unknown>, answer: Answer): void {
    const { result, draft } = this.store.inventoryTx(p.characterId, fn)
    if (!result.ok) return answer(result)
    answer(true)
    this.afterInventory(p, draft)
  }

  /** Sends inventoryUpdate and, when equipment or gold changed, the appearance/stat consequences; then the modules' inventoryChanged. */
  afterInventory(p: Player, d: InvDraft): void {
    const up = d.updates()
    if (up.bag || up.equip || up.gold !== undefined) p.send({ t: 'inventoryUpdate', ...up })
    if (d.goldChanged) {
      p.gold = d.gold
      p.send({ t: 'statsDelta', stats: { gold: p.gold } })
    }
    if (d.touchedEquip.size > 0) {
      // The codes and the +N (the weapon glow) of what the player shows: a change of either is announced.
      const look = () => JSON.stringify([visibleEquip(p), visibleEquipPlus(p.equip)])
      const before = look()
      p.equip = this.equipOf(d.state())
      const changed = this.refresh(p)
      if (look() !== before) {
        const plus = visibleEquipPlus(p.equip)
        this.world.broadcastAbout(p, { t: 'appearance', id: p.id, equip: visibleEquip(p), ...(Object.keys(plus).length > 0 ? { plus } : {}) })
      }
      p.send({ t: 'stats', stats: this.stats(p) })
      if (changed) this.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, hp: Math.round(p.hp), maxHp: p.maxHp })
    }
    this.hook('inventoryChanged', p)
  }

  private itemDrop(p: Player, bag: number, count: number | undefined, answer: (r: Result<unknown> | true) => void): void {
    const inv = this.store.loadInventory(p.characterId)
    const it = bag < inv.bagSize ? inv.bag[bag] : null
    if (!it) return answer(fail('invalid_slot'))
    if (this.data.item(it.code)?.canDrop === false) return answer(fail('not_usable'))
    const { result, draft } = this.store.inventoryTx(p.characterId, (d) => takeFromBag(d, bag, count))
    if (!result.ok) return answer(result)
    answer(true)
    this.afterInventory(p, draft)
    const at = this.world.livePoint(p, this.now)
    const dropped = result.value
    this.spawnGroundItem(dropped.code, dropped.count, dropped.plus, [at.x, at.y, at.z], null, this.now, dropped.durability)
  }

  private respawn(p: Player, answer: (r: Result<unknown> | true) => void): void {
    if (!p.dead) return answer(fail('not_dead'))
    p.dead = false
    p.hp = p.maxHp
    p.mp = p.maxMp
    p.action = null
    answer(true)
    this.toTown(p)
    this.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, state: 'alive', hp: p.hp, maxHp: p.maxHp })
    p.send({ t: 'stats', stats: this.stats(p) })
  }

  /**
   * The town return point on the navmesh: the world spawn (until return points exist), located once with the
   * manifest spawn's height as the hint (docs/NAVIGATION.md §5.2: a terrain height would drop players under the
   * plaza). null in a flat world.
   */
  townPoint(): NavPoint | null {
    if (this.town === undefined) {
      const s = this.setup.spawn
      this.town = this.nav.kind === 'mesh' ? this.nav.place(s.x, s.z, this.setup.spawnHintY ?? s.y, WARP_SEARCH_M) : null
    }
    return this.town
  }

  private town: NavPoint | null | undefined = undefined

  /** Town return point: the world spawn until return points exist. The modules then get warped(p, 'town'). */
  toTown(p: Player): void {
    const s = this.setup.spawn
    p.action = null
    const at = this.townPoint()
    this.world.warp(p, at?.x ?? s.x, at?.y ?? s.y, at?.z ?? s.z, this.now, at)
    this.hook('warped', p, 'town', this.now)
  }

  /** Sets HP/MP, sends statsDelta to the player and the HP (when its rounded value changed) to its viewers. */
  setVitals(p: Player, hp: number, mp: number): void {
    const hpChanged = Math.round(hp) !== Math.round(p.hp)
    p.hp = hp
    p.mp = mp
    p.send({ t: 'statsDelta', stats: { hp: Math.round(p.hp), mp: Math.round(p.mp) } })
    if (hpChanged) this.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, hp: Math.round(p.hp) })
  }

  // ---- combat --------------------------------------------------------------------------------------------

  /** One basic attack (all its hits) from `a` on `t`; applies damage and handles the death. */
  attack(a: Player | Mob, t: Player | Mob, now: number): void {
    if (t.kind === 'player' ? t.dead : t.ai === 'dead') return
    // Players: the weapon's basic-attack row, imbue and statuses (skills/engine.ts; docs/WAVE_PLAN.md decision 10).
    if (a.kind === 'player') return this.skills.basicAttack(a, t, now)
    const att: CombatStats = a.combat
    const def: CombatStats = t.combat
    // Wave 11: Mob.damageMul (a unique's enrage / fury) scales the basic attack like mob-skills.ts scales a row.
    const h = rollSkillHit(att, def, { pct: 100 * (a.damageMul ?? 1), magic: attacksMagically(att) }, this.rng)
    this.dealHits(a, t, [{ outcome: h.outcome, damage: h.damage, hp: 0 }], {}, now)
  }

  /**
   * Applies rolled hits of `a` on `t` and sends them as one `combat` (docs/WAVE_PLAN.md decision 15): basic attacks,
   * skills, imbue bounces, DoT ticks and mob attacks all come here, so retaliation, the damage share, deaths and
   * rewards stay one path. Each hit's damage is capped at the HP left (a player's shields absorb first); hits after
   * the killing one are dropped. Returns the hits as applied.
   */
  dealHits(a: Player | Mob, target: Player | Mob | Cos, rolled: CombatHit[], extra: HitExtra, now: number): { dealt: number; killed: boolean; hits: CombatHit[] } {
    // Storms (docs/WEATHER.md §12.2): the wind spreads ranged attacks; undead and charged monsters hit harder.
    rolled = this.storm.shapeHits(a, target, rolled, extra)
    // Wave 8 (docs/SYSTEMS_COMBAT.md §1.3): a mounted player's hits land on its horse (not DoT ticks); mounts.ts
    // applies hits on a horse itself.
    const to = this.mounts.redirect(target, extra, now)
    if (to.kind === 'cos') return this.mounts.hitCos(a, to, rolled, extra, now)
    const t: Player | Mob = to
    const msg = (hits: CombatHit[], killed: boolean): ServerMessage => {
      const m: ServerMessage = { t: 'combat', attacker: a.id, target: t.id, hits }
      if (extra.skill !== undefined) m.skill = extra.skill
      if (extra.instance !== undefined) m.instance = extra.instance
      if (extra.at !== undefined) m.at = extra.at
      if (extra.aoe) m.aoe = true
      if (killed) m.killed = true
      return m
    }
    if (t.kind === 'player' ? t.dead : t.ai === 'dead') return { dealt: 0, killed: false, hits: [] }
    // Play the Boss (docs/PLAY_THE_BOSS.md §3.3): a body in a trance cannot be hurt (no message: nothing landed).
    if (t.kind === 'player' && t.trance) return { dealt: 0, killed: false, hits: [] }
    // Siege of Jangan (docs/SIEGE.md §6.3, §6.6): a defender's hit on the Town Bell repairs it (no damage, no message).
    if (this.siege.bellHit(a, t, now)) return { dealt: 0, killed: false, hits: [] }
    if (t.kind === 'mob' && t.ai === 'return') {
      // Rule (anti leash-kiting): a mob running home after giving up evades every hit; it is restored at home.
      a.lastCombatAt = now
      this.world.broadcastAboutEither(a, t, msg([{ outcome: 'miss', damage: 0, hp: Math.round(t.hp) }], false))
      return { dealt: 0, killed: false, hits: [] }
    }
    const hits: CombatHit[] = []
    let dealt = 0
    // Wave 8 (BZ): a berserk player's direct hits carry CombatHit.hwan (the client's HWAN spark and sounds).
    const hwan = !extra.dot && this.hwanHits(a)
    for (const h of rolled.slice(0, MAX_COMBAT_HITS)) {
      let damage = Math.max(0, h.damage)
      if (damage > 0 && t.kind === 'player') damage = this.skills.absorb(t, damage, now)
      damage = Math.min(damage, Math.ceil(t.hp))
      t.hp = Math.max(0, t.hp - damage)
      dealt += damage
      hits.push(hwan ? { ...h, damage, hp: Math.round(t.hp), hwan: true } : { ...h, damage, hp: Math.round(t.hp) })
      if (t.hp <= 0) break
    }
    if (hits.length === 0) return { dealt: 0, killed: false, hits }
    a.lastCombatAt = now
    t.lastCombatAt = now
    const killed = t.hp <= 0
    this.world.broadcastAboutEither(a, t, msg(hits, killed))
    // Wave 8 (docs/SYSTEMS_COMBAT.md §3.2): durability wear of the landed hits (skips extra.dot).
    this.durability.afterHits(a, t, hits, extra, now)
    // Play the Boss: damage to or from the boss and her summons (downs, Stalk, the fight flag; pilot/service.ts).
    this.pilot?.onHits(a, t, dealt, now)
    // Siege of Jangan (docs/SIEGE.md §6.6): damage to siege monsters is a defender's contribution.
    this.siege.onHits(a, t, dealt, now)
    // Storms (docs/WEATHER.md §12.4): a charged monster's hit arcs to a player nearby.
    this.storm.afterHits(a, t, dealt, now)
    if (t.kind === 'mob') {
      // An invisible GM is not a target (AiHost.target): the mob keeps its credit but does not turn on it.
      if (a.kind === 'player') retaliate(t, a.id, dealt, !a.invisible)
      if (killed) this.mobDied(t, now, true)
    } else {
      if (dealt > 0) t.send({ t: 'statsDelta', stats: { hp: Math.round(t.hp) } })
      if (killed) this.playerDied(t, now, a)
    }
    return { dealt, killed, hits }
  }

  /**
   * Damage without an attacker (lightning, docs/WEATHER.md §2.7; later hazards of the storm series): dealHits' path
   * minus what needs an attacker (retaliation, the damage share, durability, the horse redirect, Berserk). A player's
   * shields absorb first, the HP is capped, one `combat` goes to the target's viewers with attacker 0 and `cause`,
   * and a death runs the usual playerDied / mobDied: a monster's EXP, loot and quest credit go to the players already in
   * its damage map (one nobody fought dies without loot, like a GM kill). A trance body is never hit.
   * `nonLethal` (a tornado and its bolts, docs/WEATHER.md §13): the HP never drops below 1, whatever the modifiers.
   */
  hazardHit(t: Player | Mob, damage: number, cause: HazardCause, now: number, strike?: number, nonLethal = false): { dealt: number; killed: boolean } {
    if (t.kind === 'player' ? t.dead || t.trance : t.ai === 'dead') return { dealt: 0, killed: false }
    // Storms (docs/WEATHER.md §12.2): a wet player takes more from lightning.
    let dealt = Math.max(0, Math.round(damage * this.storm.hazardMul(t, cause)))
    if (dealt > 0 && t.kind === 'player') dealt = this.skills.absorb(t, dealt, now)
    dealt = Math.min(dealt, nonLethal ? Math.max(0, Math.ceil(t.hp) - 1) : Math.ceil(t.hp))
    t.hp = Math.max(0, t.hp - dealt)
    t.lastCombatAt = now
    const killed = t.hp <= 0
    const msg: ServerMessage = { t: 'combat', attacker: 0, target: t.id, hits: [{ outcome: 'hit', damage: dealt, hp: Math.round(t.hp) }], cause }
    if (strike !== undefined) msg.strike = strike
    if (killed) msg.killed = true
    this.world.broadcastAbout(t, msg)
    if (t.kind === 'mob') {
      if (killed) this.mobDied(t, now, t.damage.size > 0)
    } else {
      if (dealt > 0) t.send({ t: 'statsDelta', stats: { hp: Math.round(t.hp) } })
      if (killed) this.playerDied(t, now)
    }
    return { dealt, killed }
  }

  /** Whether `a`'s hits carry `CombatHit.hwan`: a player in Berserk (wave 8). */
  hwanHits(a: Player | Mob): boolean {
    return a.kind === 'player' && this.berserk.active(a)
  }

  /** A mob died: corpse, rewards (unless a GM killed it), loot, and the nest's replacement timer. */
  mobDied(m: Mob, now: number, rewards: boolean): void {
    m.ai = 'dead'
    m.hp = 0
    m.diedAt = now
    m.target = null
    if (m.move) {
      const at = this.world.livePoint(m, now)
      m.pos = [at.x, at.y, at.z]
      m.surface = at.surface
      m.move = null
      m.path = null
    }
    this.world.broadcastAbout(m, { t: 'entityUpdate', id: m.id, hp: 0, state: 'dead' })
    this.spawner.died(m.id, now)
    if (!rewards) {
      // A GM kill: no EXP, loot or quest credit, but a quest encounter still ends (no cooldown), so its owners are not
      // told "It is already here." about a dead mob until the despawn.
      if (m.encounter) this.quests.encounterMobGone(m, now, false)
      return
    }
    // Play the Boss (docs/PLAY_THE_BOSS.md §3.9): the pilot's associates leave her damage map before anything is shared.
    this.pilot?.beforeShares(m, now)
    // Decision 41: the party decides shares, credit and loot owners for kills it is part of; otherwise the solo rule.
    const { shares, credit, lootOwners, lootGroup } = this.party.killShares(m, now) ?? soloShares(m, (id) => this.world.players.get(id))
    // Wave 11 (docs/UNIQUES.md §3.3): the loot-owner group, with the damage map as it is before the clear below.
    const owner: KillOwner = { player: lootGroup?.player ?? null, party: lootGroup?.party ?? null, damage: new Map(m.damage) }
    // EXP_RATE / SP_RATE (docs/BALANCE.md §7): every share of a kill, solo or party; quest rewards are not rated.
    const expRate = this.config.expRate ?? 1
    const spRate = this.config.spRate ?? 1
    for (const [id, gain] of shares) {
      const p = this.world.players.get(id)
      if (p) this.reward(p, Math.round(gain.exp * expRate), Math.round(gain.spExp * spRate), m.id)
    }
    // Wave 11 (docs/UNIQUES.md §3.4): a module may replace a mob's whole loot (a unique's own table, plus levels and
    // elixirs included); null keeps the normal table and the authored elixir drop.
    // Wave 8 (D51): the authored elixir drop joins the loot loop below (droppedAt / dropFrom like any drop).
    // docs/WINTER.md §13.4: the Ice Yeti's own loot replaces the table like a unique's.
    // docs/SIEGE.md §6.5: siege monsters drop nothing (a siege is not a farm).
    const unique = this.uniques?.drops(m, now) ?? this.winterPlay.yeti.drops(m) ?? this.siege.drops(m) ?? null
    // Storms (docs/WEATHER.md §12.4): a charged monster drops more, and its gear may come +1.
    const bonus = this.storm.lootBonus(m)
    const drops: RolledDrop[] = unique ?? this.storm.plusLoot(m, [
      ...rollDrops(this.data.drops.get(m.def.code), this.rng, (c) => this.data.items.has(c), { gold: (this.config.goldRate ?? 1) * bonus.gold, drop: (this.config.dropRate ?? 1) * bonus.drop }),
      ...this.alchemy.extraDrops(m),
      // docs/WINTER.md §13.5: a holiday gift box in the season
      ...this.winterPlay.gifts.extraDrops(m),
    ])
    const corpse = this.world.livePoint(m, now)
    const from: Vec3 = [corpse.x, corpse.y, corpse.z]
    drops.forEach((drop, i) => {
      const a = (i / Math.max(1, drops.length)) * Math.PI * 2 + this.rng()
      // H11-NL-6 (docs/UNIQUES.md §3.4): a unique's loot lands in a 2.5–4 m ring, clear of her body and the long corpse.
      const r = unique ? 2.5 + this.rng() * 1.5 : drops.length === 1 ? 0.5 : 1 + this.rng() * 0.5
      const to = lootOwners.next()
      this.spawnGroundItem(drop.code, drop.count, drop.plus ?? 0, this.dropPoint(corpse, a, r), to.player, now, null, to.party, from)
    })
    m.damage.clear()
    // Quest kill credit: the quest engine's mobDied hook consumes it (decision 40); wave 11: the loot-owner group too.
    this.hook('mobDied', m, now, credit, owner)
  }

  /**
   * Where loot lands: `r` metres from the corpse in direction `a`, reached by a straight walk on the corpse's surface
   * (so it stays on the plaza / bridge and short of walls), with that surface's height.
   */
  private dropPoint(from: NavPoint, a: number, r: number): Vec3 {
    const [x, z] = this.world.clamp(from.x + Math.sin(a) * r, from.z + Math.cos(a) * r)
    const w = this.nav.kind === 'mesh' ? this.nav.walk(from, x, z) : null
    if (w && Number.isFinite(w.end.y)) return [w.end.x, w.end.y, w.end.z]
    return [x, from.y, z]
  }

  /** EXP/SP-EXP for a player; level-ups refill HP/MP and are announced. computeReward + save + applyProgress (decision 42). */
  reward(p: Player, exp: number, spExp: number, from?: number): void {
    const { next, levels } = this.computeReward(p, exp, spExp)
    this.store.saveProgress(p.characterId, next)
    const gain: StatGain = from === undefined ? { exp: Math.round(exp), spExp: Math.round(spExp) } : { exp: Math.round(exp), spExp: Math.round(spExp), from }
    this.applyProgress(p, next, levels, gain)
  }

  /**
   * The player's progress after gaining `exp`/`spExp` (a copy: nothing is saved or sent) and the levels gained. A quest
   * turn-in saves `next` inside its inventory transaction and calls applyProgress after the commit (docs/QUESTS.md §1.3).
   */
  computeReward(p: Player, exp: number, spExp: number): { next: Progress; levels: number } {
    const next = { ...p.progress }
    const levels = gainExp(next, exp, spExp, this.config.levelCap, (l) => this.data.expToNext(l, this.config.levelCap))
    return { next, levels }
  }

  /**
   * Makes the already saved progress `next` the player's and announces it: statsDelta with `gain` and, on a level-up
   * (`levels` > 0), the HP/MP refill, levelUp, entityUpdate and stats.
   */
  applyProgress(p: Player, next: Progress, levels: number, gain: StatGain): void {
    const before = p.progress.level
    p.progress = next
    if (levels === 0) {
      p.send({ t: 'statsDelta', stats: { exp: next.exp, sp: next.sp, spExp: next.spExp }, gain })
      return
    }
    this.refresh(p)
    // A dead player can still get its share of a kill made by others: it levels up but stays dead (0 HP).
    if (!p.dead) {
      p.hp = p.maxHp
      p.mp = p.maxMp
    }
    p.send({ t: 'statsDelta', stats: { exp: next.exp, sp: next.sp, spExp: next.spExp }, gain })
    this.world.broadcastAbout(p, { t: 'levelUp', id: p.id, level: p.level })
    this.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, level: p.level, hp: Math.round(p.hp), maxHp: p.maxHp })
    p.send({ t: 'stats', stats: this.stats(p) })
    this.config.log(`${p.name} reached level ${p.level} (from ${before})`)
  }

  /** `killer`: the attacker of the killing hit (Play the Boss downs); absent for a GM kill. */
  playerDied(p: Player, now: number, killer?: Player | Mob): void {
    p.dead = true
    p.hp = 0
    p.action = null
    this.world.halt(p, now)
    this.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, hp: 0, state: 'dead' })
    for (const m of this.world.mobs.values()) if (m.target === p.id) m.target = null
    this.hook('playerDied', p, now, killer)
  }

  // ---- tick ----------------------------------------------------------------------------------------------

  tick(now: number): void {
    this.now = now
    for (const p of this.world.players.values()) this.tickPlayer(p, now)
    const active = [...this.world.players.values()].filter((p) => !p.dead).map((p) => this.world.positionAt(p, now))
    const wake = (this.world.viewRange + DORMANT_MARGIN_M) ** 2
    for (const m of [...this.world.mobs.values()]) {
      if (m.ai === 'dead') {
        // Wave 11 (docs/UNIQUES.md D-U21): a unique's corpse stays longer (Mob.corpseMs).
        if (now - m.diedAt >= (m.corpseMs ?? CORPSE_MS)) this.world.removeEntity(m.id)
        continue
      }
      // Siege of Jangan (docs/SIEGE.md §6.3): the army drives its monsters; their own AI runs only in a fight.
      if (m.siege && m.siege.mode !== 'engage') continue
      if (m.ai === 'idle') {
        const pos = this.world.positionAt(m, now)
        if (!active.some((q) => (q[0] - pos[0]) ** 2 + (q[2] - pos[2]) ** 2 <= wake)) {
          this.regenMob(m, now)
          continue
        }
      }
      // Stunned, frozen or knocked-down mobs do nothing until the status ends (skills/effects.ts); a mob inside a
      // monster skill's cast or action window stands still (wave 8, mob-skills.ts).
      if (this.skills.held(m, now) || this.mobSkills.busy(m, now)) continue
      // Storms (docs/WEATHER.md §12.3): a beast panicked by thunder runs off, deaf to everything, until it calms down.
      if (this.storm.panicking(m, now)) continue
      // Play the Boss (docs/PLAY_THE_BOSS.md §3.2): a player steers her; her AI only runs while it has her back.
      if (m.pilot?.steering === 'player') continue
      // docs/WINTER.md §13.4: the Ice Yeti stands still while she winds up a move.
      if (m.holdUntil !== undefined && now < m.holdUntil) continue
      thinkMob(m, this)
      if (m.ai === 'idle') this.regenMob(m, now)
    }
    for (const it of [...this.world.items.values()]) if (now >= it.expiresAt) this.world.removeEntity(it.id)
    if (this.config.spawnMobs) this.spawner.tick(now, (nest) => this.spawnNestMob(nest, now))
    this.hook('tick', now)
  }

  private regenMob(m: Mob, now: number): void {
    // Play the Boss (docs/PLAY_THE_BOSS.md §3.4): hiding never heals the boss during the event.
    // docs/SIEGE.md §6.3: siege monsters (and the Town Bell) never regenerate.
    if (m.pilot || m.siege || m.hp >= m.maxHp || now - m.lastCombatAt < REGEN.outOfCombatMs || now < m.nextRegenAt) return
    m.nextRegenAt = now + REGEN.intervalMs
    m.hp = Math.min(m.maxHp, m.hp + Math.max(1, Math.round(m.maxHp * REGEN.mobPct)))
    this.world.broadcastAbout(m, { t: 'entityUpdate', id: m.id, hp: m.hp })
  }

  private tickPlayer(p: Player, now: number): void {
    if (p.dead) return
    this.tickAction(p, now)
    this.hook('tickPlayer', p, now)
    this.regenPlayer(p, now)
  }

  /** The built-in player actions: auto-attack and the pickup walk. */
  private tickAction(p: Player, now: number): void {
    const a = p.action
    // A running skill action (or a stun) holds the attack and pickup walks until it ends (skills/engine.ts).
    if ((a?.kind === 'attack' || a?.kind === 'pickup') && (this.skills.busy(p, now) || this.skills.held(p, now))) return
    if (a?.kind === 'attack') {
      const t = this.world.mobs.get(a.target)
      if (!t || t.ai === 'dead' || !p.known.has(t.id)) {
        p.action = null
      } else {
        const reach = p.combat.range + p.radius + t.radius
        if (this.approach(p, t, reach, a, now)) {
          const pp = this.world.positionAt(p, now)
          const tp = this.world.positionAt(t, now)
          if (this.data.inSafeArea(this.config.world, pp[0], pp[2])) {
            // No fighting from inside a town (mobs cannot hit back there): the attack ends.
            p.action = null
            p.send({ t: 'chat', channel: 'system', text: 'You cannot fight inside a town.' })
            return
          }
          this.world.halt(p, now, yawTowards(tp[0] - pp[0], tp[2] - pp[2]))
          if (now >= p.nextSwingAt) {
            // Wave 8: an auto-attack started before the weapon broke (or before mounting) stops here.
            const refused = this.mounts.refuse(p, 'attack') ?? this.durability.refuse(p, 'attack')
            if (refused) {
              p.action = null
              if (refused.message) p.send({ t: 'chat', channel: 'system', text: refused.message })
              return
            }
            p.nextSwingAt = now + this.skills.basicFor(p).intervalMs
            this.attack(p, t, now)
          }
        }
      }
    } else if (a?.kind === 'pickup') {
      const it = this.world.items.get(a.item)
      if (!it) p.action = null
      else if (this.approach(p, it, PICKUP_RANGE, a, now)) {
        p.action = null
        this.world.halt(p, now)
        const r = this.pickUp(p, it)
        if (!r.ok) p.send({ t: 'chat', channel: 'system', text: `Could not pick up ${it.name}: ${r.reason.replace(/_/g, ' ')}.` })
      }
    }
  }

  /**
   * Walks `p` towards `t` until within `reach` (re-planning as the target moves). Returns true when in reach.
   * An unreachable target ends the action (`p.action = null`).
   */
  approach(p: Player, t: Mob | Player | GroundItem | Npc, reach: number, a: { chaseAt: number; chaseTo: [number, number] | null }, now: number): boolean {
    const pp = this.world.positionAt(p, now)
    const tp = this.world.positionAt(t, now)
    const d = Math.hypot(tp[0] - pp[0], tp[2] - pp[2])
    if (d <= reach) return true
    const stale = !p.move || !a.chaseTo || Math.hypot(a.chaseTo[0] - tp[0], a.chaseTo[1] - tp[2]) > 1
    if (stale && now >= a.chaseAt) {
      a.chaseAt = now + PLAYER_REPLAN_MS
      a.chaseTo = [tp[0], tp[2]]
      const stand = Math.max(0, reach * 0.8)
      const x = tp[0] + ((pp[0] - tp[0]) / d) * stand
      const z = tp[2] + ((pp[2] - tp[2]) / d) * stand
      if (!this.world.moveEntity(p, x, z, this.world.moveSpeed * p.speedMul, now)) p.action = null
    }
    return false
  }

  private regenPlayer(p: Player, now: number): void {
    if ((p.hp >= p.maxHp && p.mp >= p.maxMp) || now - p.lastCombatAt < REGEN.outOfCombatMs || now < p.nextRegenAt) return
    p.nextRegenAt = now + REGEN.intervalMs
    // docs/WINTER.md §13.1: the cold slows the regeneration (1 when warm, outside the season and in towns)
    const mul = this.winterPlay.regenMul(p)
    const hp = Math.min(p.maxHp, p.hp + Math.max(1, p.maxHp * REGEN.playerPct) * mul)
    const mp = Math.min(p.maxMp, p.mp + Math.max(1, p.maxMp * REGEN.playerPct) * mul)
    this.setVitals(p, hp, mp)
  }

  // ---- GM ------------------------------------------------------------------------------------------------

  /** GM spawn: `n` mobs of `code` around `near` (not tied to a nest; they never respawn). */
  gmSpawn(near: Player, def: MobDef, n: number, now = Date.now()): number[] {
    this.now = now
    const at = this.world.livePoint(near, now)
    const ids: number[] = []
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2
      const r = 2 + this.rng() * 3
      const [x, z] = this.world.clamp(at.x + Math.sin(a) * r, at.z + Math.cos(a) * r)
      // Around the GM on its own level (a straight walk from the GM, so never through a wall); flat: as is.
      const w = this.nav.kind === 'mesh' ? this.nav.walk(at, x, z) : null
      const p = w && Number.isFinite(w.end.y) ? w.end : { x, y: at.y, z, surface: at.surface }
      const variant: MobVariant = def.rarity === 'unique' ? 'unique' : 'normal'
      ids.push(this.createMob(def, variant, p.x, p.z, p.y, null, now, p.surface).id)
    }
    return ids
  }

  /** GM item: puts `n` of an item into the player's bag (gold codes add gold). */
  gmItem(p: Player, def: ItemDef | null, code: string, n: number): Result<{ bag: { slot: number; item: ItemStack | null }[]; gold?: number }> {
    const gold = isGoldCode(code)
    const { result, draft } = this.store.inventoryTx(p.characterId, (d) => (gold ? addGold(d, n) : def ? addItem(d, def, n) : fail('not_found')))
    if (!result.ok) return result
    this.afterInventory(p, draft)
    const up = draft.updates()
    return { ok: true, value: gold ? { bag: [], gold: draft.gold } : { bag: up.bag ?? [] } }
  }

  /** GM kill: a mob dies without loot or EXP; a player dies. */
  gmKill(target: Mob | Player, now = Date.now()): void {
    this.now = now
    if (target.kind === 'mob') {
      if (target.ai === 'dead') return
      target.damage.clear()
      this.mobDied(target, now, false)
    } else if (!target.dead) {
      target.hp = 0
      target.send({ t: 'statsDelta', stats: { hp: 0 } })
      this.playerDied(target, now)
    }
  }

  /** GM heal: full HP/MP, reviving a dead player where it stands. */
  gmHeal(p: Player): void {
    const wasDead = p.dead
    p.dead = false
    p.hp = p.maxHp
    p.mp = p.maxMp
    this.world.broadcastAbout(p, wasDead ? { t: 'entityUpdate', id: p.id, state: 'alive', hp: p.hp, maxHp: p.maxHp } : { t: 'entityUpdate', id: p.id, hp: p.hp, maxHp: p.maxHp })
    p.send({ t: 'stats', stats: this.stats(p) })
  }

  /** GM setlevel on an online player: growth and typical SP for the difference (progression.ts setLevel), stats, broadcast. */
  gmSetLevel(p: Player, level: number): SetLevelChange {
    const next = { ...p.progress }
    const change = applySetLevel(next, level, (l) => this.data.expToNext(l, this.config.levelCap))
    this.store.saveProgress(p.characterId, next)
    p.progress = next
    this.refresh(p)
    if (!p.dead) {
      p.hp = p.maxHp
      p.mp = p.maxMp
    }
    this.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, level, hp: Math.round(p.hp), maxHp: p.maxHp })
    p.send({ t: 'stats', stats: this.stats(p) })
    return change
  }
}
