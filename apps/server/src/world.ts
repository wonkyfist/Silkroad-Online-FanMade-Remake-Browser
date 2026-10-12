import {
  DEFAULT_HEIGHT,
  DEFAULT_VOLUME,
  MAX_COORD,
  yawTowards,
  type EntityState,
  type EquipSlot,
  type ItemStack,
  type MobDef,
  type MobVariant,
  type MoveState,
  type NestDef,
  type PartyItemMode,
  type ServerMessage,
  type StarterWeapon,
  type Vec3,
  type CharLook,
} from '@sro/shared'
import type { NavLeg, NavSurface } from '@sro/nav'
import type { Bounds } from './content.ts'
import { PLAYER_BASE, maxHpFor, maxMpFor, playerCombatStats, type CombatStats } from './formulas.ts'
import { VISIBLE_SLOTS } from './inventory.ts'
import { FlatNav, ValidatorNav, legsLength, pointOnLegs, type NavPoint, type NavProvider } from './nav.ts'
import type { Progress } from './progression.ts'
import { gmTag } from './gm-tag.ts'
import type { SiegeMob } from './siege/army.ts'
import { PlayerGrid, cellKey } from './cells.ts'
import { Encoded } from './encode.ts'
import { KnownSet, type Watchers } from './known.ts'
import { PH, PhaseTimers } from './phases.ts'

/**
 * Authoritative world simulation: every entity (players, mobs, NPCs, ground items), straight-line moves, the
 * tick loop and interest management. Gameplay rules (combat, AI, loot) live in gameplay.ts and ai.ts and run
 * inside this world's tick through `onTick`. Positions are world metres (glTF space, Y up); only x/z are
 * authoritative.
 *
 * Interest management: a player receives an entity (spawn, then its move/stop/combat/... messages) while it is
 * within `viewRange` metres, and a despawn once it is farther than viewRange + VIEW_HYSTERESIS_M (or gone).
 * Each player's `known` set is exactly what its client has spawned.
 */

/** Anything that moves in straight lines. */
export interface Mover {
  /** Runtime entity id, unique across all kinds. */
  id: number
  pos: Vec3
  yaw: number
  move: MoveState | null
  /** Navmesh surface under `pos` (docs/NAVIGATION.md §5.1); null/absent: unknown or a flat world. */
  surface?: NavSurface | null
  /** The current move on the navmesh: its straight pieces per surface and the surface it ends on. */
  path?: MovePath | null
}

/** A move's walk on the navmesh (NavWalk legs), kept so a stop mid-way knows its surface and exact height. */
export interface MovePath {
  legs: NavLeg[]
  /** Total XZ length of the legs (metres). */
  length: number
  end: NavSurface | null
}

/** What a player is doing on its own (auto-attack, walking to pick something up, to talk to an NPC or to cast). */
export type PlayerAction =
  | { kind: 'attack'; target: number; chaseAt: number; chaseTo: [number, number] | null }
  | { kind: 'pickup'; item: number; chaseAt: number; chaseTo: [number, number] | null }
  /** Walking to an NPC (npc.ts runs it from its tickPlayer hook; docs/SHOPS.md §3.1). */
  | { kind: 'talk'; npc: number; chaseAt: number; chaseTo: [number, number] | null }
  /** Walking into range of a skill target (skills/engine.ts runs it; docs/SKILLS.md §10.1). */
  | { kind: 'skill'; skill: string; target: number; chaseAt: number; chaseTo: [number, number] | null }
  /** Wave 8: walking to the own parked horse `cos` to ride it (mounts.ts runs it from its tickPlayer hook). */
  | { kind: 'board'; cos: number; chaseAt: number; chaseTo: [number, number] | null }

export interface Player extends Mover {
  kind: 'player'
  characterId: number
  name: string
  model: string
  level: number
  weapon: StarterWeapon
  /**
   * Delivers a message to this player's client. `enc` (broadcasts, docs/SERVER_ARCHITECTURE.md P0 encode-once): the
   * message already encoded for every recipient; a connection uses it when it gets that very message object.
   */
  send: (msg: ServerMessage, enc?: Encoded) => void
  /** GM or admin: sees invisible players. */
  staff: boolean
  /** GM `invis on`: only staff viewers (and the player itself) receive this entity. Runtime only. */
  invisible: boolean
  /** GM `speed`: multiplies the world move speed for this player. Runtime only. */
  speedMul: number
  /** Entity ids this player's client has spawned (interest management). */
  known: Set<number>
  /**
   * Crowd cap (docs/NETWORK_AUDIT.md R1): the player ids this viewer may see while more than maxVisiblePlayers are in
   * range (chosen by the last interest pass); null = no cap in force (every player in range is shown).
   */
  crowd?: Set<number> | null
  /** Players this one fought (hit or was hit by) and when (ms): always visible to each other for FOE_MEMORY_MS. */
  foes?: Map<number, number>
  // ---- gameplay ----
  gender: 'male' | 'female'
  radius: number
  progress: Progress
  gold: number
  hp: number
  maxHp: number
  mp: number
  maxMp: number
  dead: boolean
  /** Worn items (mirror of the database, refreshed after every equipment change). */
  equip: Partial<Record<EquipSlot, ItemStack>>
  /** Derived combat stats (recomputed on level/stat/equipment changes). */
  combat: CombatStats & { range: number; weapon: string }
  action: PlayerAction | null
  /** Earliest time of the next basic attack (survives re-issued attack requests). */
  nextSwingAt: number
  /** Last time this player dealt or took damage. */
  lastCombatAt: number
  /** Last time a monster's hit landed on this player (the Climb's combat linger, climb/penalty.ts). Runtime only. */
  lastMobHitAt?: number
  nextRegenAt: number
  /** Item cooldown group -> time it ends. */
  cooldowns: Map<string, number>
  /** Character creation Height/Volume choices (0..4, default 2). */
  height: number
  volume: number
  /** The look every client draws this player with (look.ts, docs/CHARACTERS.md §16.8); absent = clients use the default. */
  look?: CharLook
  /**
   * Play the Boss (docs/PLAY_THE_BOSS.md §3.1): the entity whose position this player's interest is centred on (the boss
   * it steers); absent, or gone from the world, = its own position. Runtime only.
   */
  viewFrom?: number
  /** Play the Boss: the body rests in a trance while its player steers a boss (never a target, locked by a gate). */
  trance?: true
}

export type NewPlayer = Pick<Player, 'characterId' | 'name' | 'model' | 'level' | 'weapon' | 'pos' | 'yaw' | 'send'> &
  Partial<Pick<Player, 'staff' | 'gender' | 'progress' | 'gold' | 'hp' | 'mp' | 'dead' | 'equip' | 'combat' | 'surface' | 'height' | 'volume' | 'look'>>

export type MobAiState = 'idle' | 'chase' | 'return' | 'dead'

export interface Mob extends Mover {
  kind: 'mob'
  def: MobDef
  variant: MobVariant
  name: string
  level: number
  hp: number
  maxHp: number
  radius: number
  combat: CombatStats
  /** Home point (nest centre, or where a GM spawned it) and how far it roams. */
  home: [number, number]
  roamRadius: number
  sightRange: number
  leashRange: number
  aggressive: boolean
  /** The nest it belongs to (null: GM-spawned, never respawns). */
  nest: NestDef | null
  ai: MobAiState
  target: number | null
  /** Player id -> damage dealt to this mob (EXP share, retaliation). */
  damage: Map<number, number>
  nextSwingAt: number
  /** Next time an idle mob may pick a wander point / a chasing mob may re-plan. */
  nextThinkAt: number
  lastCombatAt: number
  nextRegenAt: number
  diedAt: number
  /** Quest encounter mob (docs/QUESTS.md §1.6; lane QS-S): no nest, and not counted against GM_SPAWN_TOTAL_MAX. */
  encounter?: MobEncounter
  /** Multipliers given to createMob (encounters): HP and attack apply at creation, EXP at the kill (killExp). */
  tuning?: MobTuning
  /**
   * Wave 11 (docs/UNIQUES.md §3.6): a live outgoing-damage multiplier (absent = 1), read on every swing where the hit's
   * percent is scaled (mob-skills.ts next to MOB_DAMAGE_RATE, and the basic attack). The uniques module sets it
   * (enrage, fury) and resets it.
   */
  damageMul?: number
  /** Wave 11 (docs/UNIQUES.md D-U21): how long the corpse stays, ms (absent = formulas.ts CORPSE_MS, 3 s). */
  corpseMs?: number
  /**
   * Play the Boss (docs/PLAY_THE_BOSS.md §3.1, §3.4): set for the whole event. `player` = the pilot's entity id (null once
   * the pilot left); `steering` 'player' = Gameplay.tick runs no AI for her. While set: no regen, no refill at home.
   */
  pilot?: { player: number | null; steering: 'player' | 'ai' }
  /** Play the Boss, Stalk (§3.5): non-staff viewers other than her pilot see her only within this many metres. */
  veil?: number
  /** Winter (docs/WINTER.md §13.3): the Ice Yeti winds up a move until this server ms; Gameplay.tick runs no AI for her. */
  holdUntil?: number
  /**
   * Siege of Jangan, layer 4 (docs/SIEGE.md §6.3; siege/army.ts): a siege monster. The army drives it (march, assault,
   * the way in, flight); Gameplay.tick runs its AI only while `mode` is 'engage'. Its walks stop at the gate wards.
   */
  siege?: SiegeMob
}

/** A live quest encounter (docs/QUESTS.md §1.6): who summoned it and when it leaves unkilled. */
export interface MobEncounter {
  quest: string
  /** Character ids of the owner group (the party, or the player alone). */
  owners: Set<number>
  despawnAt: number
}

/** Per-mob multipliers on top of VARIANT_RULES (QuestEncounter hpMul/attackMul/expMul). Absent = 1. */
export interface MobTuning {
  hpMul?: number
  attackMul?: number
  expMul?: number
}

export interface GroundItem {
  kind: 'item'
  id: number
  code: string
  name: string
  count: number
  plus: number
  /** A dropped worn item keeps its durability through the pickup (null: full, and every mob drop). */
  durability: number | null
  pos: Vec3
  yaw: number
  /** Entity id of the player with loot priority (EntityState.owner), or null. */
  owner: number | null
  /** Character id of that player: priority survives a relog (the entity id changes). */
  ownerChar: number | null
  ownerUntil: number
  expiresAt: number
  /** Party id whose members share the owner window (docs/QUESTS.md §4.3; lane PT-S). Absent or null: none. */
  ownerParty?: number | null
  /**
   * That party's Items mode when the item dropped: the pickup rights are fixed then (docs/QUESTS.md §4.3), so a later
   * mode switch by the leader neither unlocks another member's round-robin item nor splits free-mode gold.
   */
  ownerPartyItems?: PartyItemMode
}

export interface Npc {
  kind: 'npc'
  id: number
  /** The NPC's identity (quest giver/turn-in, dialogs): an npcs.json code or an authored NPCX_* code. */
  code: string
  /** The NPC whose model it wears, when that differs from `code` (authored NPCs, docs/QUESTS.md §5.3; lane ED-S). */
  model?: string
  name: string
  pos: Vec3
  yaw: number
}

/**
 * Wave 8 (docs/SYSTEMS_COMBAT.md §1.3): a horse. It is never an item and never tradable. A ridden horse shares its
 * rider's MoveState (`move` = the rider's; `pos` copied on stop and warp), so interest management and `positionAt`
 * stay right mid-move; the horse itself is never sent `move`s. mounts.ts creates and drives it.
 */
export interface Cos extends Mover {
  kind: 'cos'
  /** CosDef code, e.g. COS_C_HORSE1 (EntityState.model). */
  code: string
  name: string
  level: number
  /** Entity id of the owning player (EntityState.owner, D31). */
  owner: number
  /** Character id of the owner (the saved char_mount row). */
  ownerChar: number
  hp: number
  maxHp: number
  /** Body radius (CosDef.radius, metres). */
  radius: number
  /** Entity id of the rider; null = parked. */
  rider: number | null
  /** Server ms the horse died (0 = alive). */
  diedAt: number
}

export type Entity = Player | Mob | GroundItem | Npc | Cos

/**
 * Decorator (decision 43): an NPC wearing another NPC's model sends `model: <base>` plus its identity as `npc`
 * (EntityState.npc; the client's NPC identity is `state.npc ?? state.model`). Plain NPCs are unchanged.
 */
export function npcTag(e: Entity, s: EntityState): void {
  if (e.kind !== 'npc' || !e.model || e.model === e.code) return
  s.model = e.model
  s.npc = e.code
}

/** Decorator (docs/QUESTS.md §4.3): a drop whose owner window belongs to a party carries `ownerParty`. */
export function ownerPartyTag(e: Entity, s: EntityState): void {
  if (e.kind === 'item' && e.ownerParty !== undefined && e.ownerParty !== null) s.ownerParty = e.ownerParty
}

/**
 * Legacy navmesh hook: given the authoritative start and the (bounds-clamped) requested target, return
 * the point the entity may actually walk to in a straight line, or null to refuse the move. The World also
 * takes a full NavProvider (nav.ts), which game.ts passes.
 */
export type MoveValidator = (from: Vec3, to: Vec3) => Vec3 | null

export const allowStraightLine: MoveValidator = (_from, to) => to

/** Moves shorter than this are treated as "stop here". */
const MIN_MOVE_M = 0.01
/** Default view distance (metres). */
/**
 * Positions and headings of the hot movement messages (move, stop, warp) go out rounded: cm and 1/1000 rad (docs/
 * NETWORK_AUDIT.md N2). A full double prints 17 digits; at 500 players in one town these messages are ~95 % of the
 * bytes sent. The server keeps its exact values; the client's view differs by at most 5 mm.
 */
export function wirePos(v: readonly number[]): Vec3 {
  return [Math.round(v[0]! * 100) / 100, Math.round(v[1]! * 100) / 100, Math.round(v[2]! * 100) / 100]
}
export function wireYaw(y: number): number {
  return Math.round(y * 1000) / 1000
}

/** Crowd cap default (MAX_VISIBLE_PLAYERS): the nearest this many players are shown when more are in range. */
export const MAX_VISIBLE_PLAYERS = 100
/** A player already shown counts as this much nearer (m) when the crowd is re-picked, so the edge does not flicker. */
export const CROWD_SWAP_M = 30
/** At most this many shown players are swapped for nearer ones per viewer per interest pass (free slots fill at once). */
export const CROWD_SWAPS_PER_PASS = 1
/**
 * A viewer's crowd is re-picked every this many interest passes (1 s at INTEREST_MS 200), staggered by viewer id, not
 * every pass: picking is the costly part of a crowded pass. Must-see players show at once regardless (crowded()).
 */
export const CROWD_REPICK_PASSES = 5
/** A player fight keeps both sides visible to each other this long after the last hit (ms). */
export const FOE_MEMORY_MS = 15_000

export const DEFAULT_VIEW_RANGE = 120
/** An entity is despawned only once it is this much farther than the view range (no flicker at the edge). */
export const VIEW_HYSTERESIS_M = 10
/** Radians: smaller turns of a standing entity are not broadcast. */
const TURN_EPS = 0.15
/** Interest is recomputed at most this often (and at once for teleports, spawns and removals). */
const INTEREST_MS = 200
/** Navmesh worlds clamp targets this far inside the world bounds (metres), off the region border itself. */
const BOUNDS_INSET_M = 0.01
/** A teleport into a wall or a house lands on the nearest open ground within this distance (metres). */
export const WARP_SEARCH_M = 10

/** A crowd-pick candidate (pickCrowdCells): its distance (shown ones CROWD_SWAP_M nearer) and its candidate order. */
export interface CrowdPick {
  id: number
  d: number
  shown: boolean
  pos: number
}

/**
 * The first `k` of `list` (in candidate order) sorted by distance, as the stable `list.slice().sort(by d).slice(0, k)`
 * gives them (equal distances keep their order), without sorting all of it when k is small.
 */
export function firstSorted(list: CrowdPick[], k: number): CrowdPick[] {
  if (k <= 0) return []
  if (k > 16 || k * 4 >= list.length) return list.slice().sort((x, y) => x.d - y.d).slice(0, k)
  const out: CrowdPick[] = []
  for (const x of list) {
    // not nearer than the k-th so far: a stable sort puts it after that one
    if (out.length === k && x.d >= out[k - 1]!.d) continue
    let j = out.length
    while (j > 0 && out[j - 1]!.d > x.d) j--
    out.splice(j, 0, x)
    if (out.length > k) out.pop()
  }
  return out
}

/** One cell of an AOI_FAST interest pass: its entities with their ids and positions side by side. */
interface AoiCell {
  ents: Entity[]
  ids: number[]
  xs: number[]
  zs: number[]
  /** Whether each entity is a player (the crowd cap's candidates). */
  pl: boolean[]
}

export class World {
  readonly players = new Map<number, Player>()
  readonly mobs = new Map<number, Mob>()
  readonly items = new Map<number, GroundItem>()
  readonly npcs = new Map<number, Npc>()
  /** Wave 8: horses (mounts.ts). */
  readonly cos = new Map<number, Cos>()
  /** Gameplay tick (gameplay.ts). Runs after moves settle, before interest updates. */
  onTick: ((now: number) => void) | null = null
  /**
   * Reports an exception thrown by a timer-driven tick (game.ts logs it). The tick is caught so one bad
   * entity or a failed save (e.g. SQLITE_BUSY while the gm CLI writes) cannot crash the whole server.
   */
  onError: (e: unknown) => void = () => {}
  /**
   * EntityState decorations (docs/WAVE_PLAN.md decision 37): each runs at the end of state(), in order, and may add
   * optional fields (skills: `effects`, UX-B: `gm`, ...). Lanes register theirs from their own module.
   */
  readonly decorators: ((e: Entity, s: EntityState) => void)[] = [gmTag, npcTag, ownerPartyTag]
  /** Siege of Jangan, layer 4 (siege/event.ts): clips a siege monster's walk at the gate wards (null: no ward in the way). */
  mobWalkClip: ((m: Mob, ax: number, az: number, bx: number, bz: number) => [number, number] | null) | null = null
  viewRange = DEFAULT_VIEW_RANGE
  /** Crowd cap (0 = off): see Player.crowd. */
  maxVisiblePlayers = MAX_VISIBLE_PLAYERS
  /** CROWD_REPICK_PASSES (tests set 1). */
  crowdRepickPasses = CROWD_REPICK_PASSES
  /**
   * Gameplay's "always show" rule on top of the built-in one (targets, foes): party and guild members (gameplay.ts).
   */
  alsoMustSee: ((viewer: Player, other: Player) => boolean) | null = null
  private nextEntityId = 1
  private timer: NodeJS.Timeout | null = null
  private interestAt = 0
  /** Where entities may stand and walk (a MoveValidator is wrapped as a flat provider). */
  readonly nav: NavProvider
  /** Slowest tick so far (ms) and ticks run, for the performance log. */
  worstTickMs = 0
  ticks = 0
  /** Each tick's duration (ms), for the metrics (netstats.ts). */
  onTickTimed: ((ms: number) => void) | null = null
  /** Per-phase tick timers (phases.ts; game.ts installs NetStats' own). The default records nothing. */
  timers: PhaseTimers = PhaseTimers.off
  // ---- P0 switches (docs/SERVER_ARCHITECTURE.md §4 P0): each on by default; off runs the old path ----
  /** MOB_GRID: the monster pass's player grid (playersNear, the wake check). Off: every player is scanned. */
  mobGrid = true
  /** WATCHERS: broadcasts go to the watcher index (known.ts). Off: every player is scanned. */
  useWatchers = true
  /** ENCODE_ONCE: a broadcast is encoded once for all its recipients (encode.ts). Off: once per recipient. */
  encodeOnce = true
  /** AOI_FAST: the interest pass's quick path (the same spawns and despawns). Off: the old pass. */
  aoiFast = true
  /** The watcher index (known.ts): entity id -> the players whose client has it. */
  private readonly watchers: Watchers = new Map()
  /** Players added by add() and not removed yet: the index is complete while this equals players.size. */
  private indexed = 0
  /** Bumped whenever a player's position jumps (warp, add, remove): the monster pass's grid is rebuilt then. */
  private playerEpoch = 0
  /** The monster pass's player grid and its `now` (beginPlayerScan .. endPlayerScan); null outside the pass. */
  private scan: PlayerGrid | null = null
  private scanNow: number | null = null

  constructor(
    readonly name: string,
    readonly moveSpeed: number,
    readonly tickHz: number,
    readonly bounds: Bounds | null,
    nav: NavProvider | MoveValidator = allowStraightLine,
  ) {
    this.nav = typeof nav === 'function' ? (nav === allowStraightLine ? new FlatNav(null) : new ValidatorNav(nav)) : nav
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.timedTick(Date.now())
      } catch (e) {
        this.onError(e)
      }
    }, 1000 / this.tickHz)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** tick() with its duration recorded in worstTickMs. */
  timedTick(now: number): number {
    const t0 = performance.now()
    let ms = 0
    try {
      this.tick(now)
    } finally {
      ms = performance.now() - t0
      this.ticks++
      if (ms > this.worstTickMs) this.worstTickMs = ms
      this.timers.interval()
      this.onTickTimed?.(ms)
    }
    return ms
  }

  get online(): number {
    return this.players.size
  }

  newId(): number {
    return this.nextEntityId++
  }

  entity(id: number): Entity | undefined {
    return this.players.get(id) ?? this.mobs.get(id) ?? this.items.get(id) ?? this.npcs.get(id) ?? this.cos.get(id)
  }

  add(p: NewPlayer): Player {
    const progress = p.progress ?? { level: p.level, exp: 0, sp: 0, spExp: 0, str: 20, int: 20, statPoints: 0 }
    const maxHp = maxHpFor(progress.level, progress.str)
    const maxMp = maxMpFor(progress.level, progress.int)
    const player: Player = {
      kind: 'player',
      characterId: p.characterId,
      name: p.name,
      model: p.model,
      level: progress.level,
      weapon: p.weapon,
      pos: [...p.pos],
      yaw: p.yaw,
      send: p.send,
      staff: p.staff ?? false,
      id: this.newId(),
      move: null,
      invisible: false,
      speedMul: 1,
      known: new KnownSet(),
      gender: p.gender ?? 'male',
      radius: PLAYER_BASE.radius,
      progress,
      gold: p.gold ?? 0,
      maxHp,
      maxMp,
      hp: Math.min(maxHp, p.hp ?? maxHp),
      mp: Math.min(maxMp, p.mp ?? maxMp),
      dead: p.dead ?? false,
      equip: p.equip ?? {},
      combat: p.combat ?? playerCombatStats(progress.level, progress.str, progress.int, []),
      action: null,
      nextSwingAt: 0,
      lastCombatAt: 0,
      nextRegenAt: 0,
      cooldowns: new Map(),
      surface: p.surface ?? null,
      path: null,
      height: p.height ?? DEFAULT_HEIGHT,
      volume: p.volume ?? DEFAULT_VOLUME,
      ...(p.look ? { look: p.look } : {}),
    }
    if (player.dead) player.hp = 0
    const now = Date.now()
    for (const v of this.players.values()) this.reveal(v, player, now)
    this.players.set(player.id, player)
    ;(player.known as KnownSet).attach(player, this.watchers)
    this.indexed++
    this.playerEpoch++
    return player
  }

  /** Whether the watcher index answers broadcasts (WATCHERS on, and every player in the world came through add()). */
  private watching(): boolean {
    return this.useWatchers && this.indexed === this.players.size
  }

  /**
   * The players whose client has entity `id` (docs/SERVER_ARCHITECTURE.md P0: the inverse of Player.known), for modules
   * that send about an entity with their own rules (e.g. by distance). Without the index: a scan of every player.
   */
  watchersOf(id: number): Iterable<Player> {
    if (!this.watching()) return [...this.players.values()].filter((p) => p.known.has(id))
    const s = this.watchers.get(id)
    return s ? [...s].filter((p) => p.known.has(id)) : []
  }

  /** Adds a mob, NPC, ground item or horse (id already taken from newId) and spawns it for players in range. */
  addEntity(e: Mob | GroundItem | Npc | Cos, now = Date.now()): void {
    if (e.kind === 'mob') this.mobs.set(e.id, e)
    else if (e.kind === 'item') this.items.set(e.id, e)
    else if (e.kind === 'cos') this.cos.set(e.id, e)
    else this.npcs.set(e.id, e)
    for (const v of this.players.values()) this.reveal(v, e, now)
  }

  /** Removes a mob, NPC, ground item or horse and despawns it for everyone who has it. */
  removeEntity(id: number): Entity | null {
    const e = this.mobs.get(id) ?? this.items.get(id) ?? this.npcs.get(id) ?? this.cos.get(id)
    if (!e) return null
    this.mobs.delete(id)
    this.items.delete(id)
    this.npcs.delete(id)
    this.cos.delete(id)
    this.despawnAll(id)
    return e
  }

  /** Despawns entity `id` for every player but `except` whose client has it (each forgets it). */
  private despawnAll(id: number, except?: Player): void {
    if (!this.watching()) {
      for (const v of this.players.values()) {
        if (v !== except && v.known.delete(id)) v.send({ t: 'despawn', id })
      }
      return
    }
    const ws = this.watchers.get(id)
    if (!ws) return
    const msg: ServerMessage = { t: 'despawn', id }
    const enc = this.encodeOnce ? new Encoded(msg) : undefined
    // a copy: forgetting the entity takes each viewer out of this very set
    for (const v of [...ws]) if (v !== except && v.known.delete(id)) v.send(msg, enc)
  }

  /**
   * Whether `viewer` may see `subject` at all (itself; invisible GMs only for staff). Distance is separate.
   * An invisible GM's horse hides with it (it carries the GM's entity id as owner/rider).
   */
  canSee(viewer: Player, subject: Entity): boolean {
    if (subject.kind === 'cos') {
      const o = this.players.get(subject.owner)
      return !o || !o.invisible || viewer.staff || viewer.id === o.id
    }
    if (subject.kind !== 'player') return true
    return viewer.id === subject.id || !subject.invisible || viewer.staff
  }

  /** Re-checks who sees the horses `p` owns (after its invisibility or a viewer's staff flag changed). */
  private refreshOwnedCos(p: Player, now: number): void {
    for (const c of this.cos.values()) if (c.owner === p.id) this.refreshAround(c, now)
  }

  /**
   * Sends `msg` (about `subject`) to every player whose client has `subject` (and to `subject` itself). P0: through the
   * watcher index (each recipient's own message order is unchanged) with one encoding for all of them.
   */
  broadcastAbout(subject: Entity, msg: ServerMessage): void {
    const enc = this.encodeOnce ? new Encoded(msg) : undefined
    if (!this.watching()) {
      for (const p of this.players.values()) if (p.id === subject.id || p.known.has(subject.id)) p.send(msg, enc)
      return
    }
    const self = this.players.get(subject.id)
    if (self) self.send(msg, enc)
    const ws = this.watchers.get(subject.id)
    if (ws) for (const p of ws) if (p !== self && p.known.has(subject.id)) p.send(msg, enc)
  }

  /** Sends to every player whose client has `a` or `b` (combat between two entities), each once. */
  broadcastAboutEither(a: Entity, b: Entity, msg: ServerMessage): void {
    const enc = this.encodeOnce ? new Encoded(msg) : undefined
    if (!this.watching()) {
      for (const p of this.players.values()) {
        if (p.id === a.id || p.id === b.id || p.known.has(a.id) || p.known.has(b.id)) p.send(msg, enc)
      }
      return
    }
    const pa = this.players.get(a.id)
    const pb = b.id === a.id ? undefined : this.players.get(b.id)
    if (pa) pa.send(msg, enc)
    if (pb) pb.send(msg, enc)
    const wa = this.watchers.get(a.id)
    if (wa) for (const p of wa) if (p !== pa && p !== pb && p.known.has(a.id)) p.send(msg, enc)
    if (b.id === a.id) return
    const wb = this.watchers.get(b.id)
    // whoever has `a` too got it above
    if (wb) for (const p of wb) if (p !== pa && p !== pb && !p.known.has(a.id) && p.known.has(b.id)) p.send(msg, enc)
  }

  /** Online player by character name (case-insensitive). */
  byName(name: string): Player | null {
    const n = name.toLowerCase()
    for (const p of this.players.values()) if (p.name.toLowerCase() === n) return p
    return null
  }

  /**
   * Instantly relocates `p` (GM teleport/summon, respawn): cancels its move, clamps x/z to the world bounds
   * and sends `warp` to everyone who has it (itself included), then refreshes what it sees and who sees it.
   * The position has no retained surface, so it is placed on the navmesh near `y` (docs/NAVIGATION.md §5.2):
   * open ground within 10 m (x/z may shift, y becomes the surface height). `at` skips that (an already placed
   * point, e.g. the resolved town spawn). A flat world keeps x/y/z as given.
   */
  warp(p: Player | Mob, x: number, y: number, z: number, now = Date.now(), at?: NavPoint | null): Vec3 {
    if (![x, y, z].every(Number.isFinite)) throw new Error(`warp to a non-finite position ${x},${y},${z}`)
    const [cx, cz] = this.clamp(x, z)
    const placed = at ?? (this.nav.kind === 'mesh' ? this.nav.place(cx, cz, y, WARP_SEARCH_M) : null)
    p.move = null
    p.path = null
    p.pos = placed ? [placed.x, placed.y, placed.z] : [cx, y, cz]
    p.surface = placed?.surface ?? null
    if (p.kind === 'player') this.playerEpoch++
    this.broadcastAbout(p, { t: 'warp', id: p.id, pos: wirePos(p.pos), yaw: wireYaw(p.yaw) })
    this.refreshAround(p, now)
    return [...p.pos]
  }

  /**
   * A teleport target on the navmesh: open ground at (or within WARP_SEARCH_M of) the bounds-clamped x/z, on the
   * surface nearest yHint (+Infinity: the highest). null in a flat world or where there is none (warp then keeps x/y/z).
   */
  placeFor(x: number, z: number, yHint: number): NavPoint | null {
    if (this.nav.kind !== 'mesh') return null
    const [cx, cz] = this.clamp(x, z)
    return this.nav.place(cx, cz, yHint, WARP_SEARCH_M)
  }

  /**
   * GM invisibility. Viewers that lose sight get `despawn`, viewers that regain it get `spawn`,
   * and viewers that see it either way (the player, staff) get `entityUpdate {invisible}`.
   */
  setInvisible(p: Player, invisible: boolean, now = Date.now()): void {
    if (p.invisible === invisible) return
    this.settle(p, now)
    p.invisible = invisible
    for (const v of this.players.values()) {
      if (v.id === p.id) {
        v.send({ t: 'entityUpdate', id: p.id, invisible })
        continue
      }
      const saw = v.known.has(p.id)
      const sees = this.canSee(v, p) && this.inRange(v, p, now, saw)
      if (saw && !sees) {
        v.known.delete(p.id)
        v.send({ t: 'despawn', id: p.id })
      } else if (!saw && sees) {
        v.known.add(p.id)
        v.send({ t: 'spawn', entity: this.state(p) })
      } else if (sees) v.send({ t: 'entityUpdate', id: p.id, invisible })
    }
    // The horse despawns and respawns together with its GM (after the GM itself, so a respawned rider exists first).
    this.refreshOwnedCos(p, now)
  }

  /** A player's staff flag changed (role granted/revoked): spawn or despawn invisible players for it. */
  setStaff(viewer: Player, staff: boolean, now = Date.now()): void {
    if (viewer.staff === staff) return
    viewer.staff = staff
    for (const q of this.players.values()) {
      if (q.id === viewer.id) continue
      const saw = viewer.known.has(q.id)
      const sees = this.canSee(viewer, q) && this.inRange(viewer, q, now, saw)
      if (saw && !sees) {
        viewer.known.delete(q.id)
        viewer.send({ t: 'despawn', id: q.id })
      } else if (!saw && sees) {
        viewer.known.add(q.id)
        viewer.send({ t: 'spawn', entity: this.state(q) })
      }
    }
    // Horses of invisible GMs follow the same rule (canSee).
    for (const c of this.cos.values()) {
      const saw = viewer.known.has(c.id)
      const sees = this.canSee(viewer, c) && this.inRange(viewer, c, now, saw)
      if (saw && !sees) {
        viewer.known.delete(c.id)
        viewer.send({ t: 'despawn', id: c.id })
      } else if (!saw && sees) {
        viewer.known.add(c.id)
        viewer.send({ t: 'spawn', entity: this.state(c) })
      }
    }
    // The [GM] name tag (gm-tag.ts) follows the role: the player and everyone who has it.
    this.broadcastAbout(viewer, { t: 'entityUpdate', id: viewer.id, gm: staff })
  }

  /** GM speed: restarts a move in progress so the new speed applies from now. */
  setSpeed(p: Player, mul: number, now = Date.now()): void {
    p.speedMul = mul
    const m = p.move
    if (m && this.arrivalTime(m) > now) this.moveTo(p, m.to[0], m.to[2], now)
  }

  /** Removes the player (settling any move at `now`) and tells everyone who had it. */
  remove(id: number, now = Date.now()): Player | null {
    const p = this.players.get(id)
    if (!p) return null
    this.settle(p, now)
    this.despawnAll(id, p)
    this.players.delete(id)
    // P0: it stops receiving broadcasts (its own `known` keeps what it had)
    if (p.known instanceof KnownSet && p.known.attached) {
      p.known.detach()
      this.indexed--
    }
    this.playerEpoch++
    return p
  }

  /** Other players; with `viewer`, only those `viewer` may see (any distance). */
  others(id: number, viewer?: Player): Player[] {
    return [...this.players.values()].filter((p) => p.id !== id && (!viewer || this.canSee(viewer, p)))
  }

  /** Everything in `p`'s view range, marked as known (for worldEnter.entities). */
  snapshotFor(p: Player, now = Date.now()): EntityState[] {
    const out: EntityState[] = []
    this.pickCrowd(p, this.players.values(), now)
    for (const e of this.allEntities()) {
      if (e.id === p.id || !this.canSee(p, e) || !this.inRange(p, e, now, false) || this.crowded(p, e, now)) continue
      p.known.add(e.id)
      out.push(this.state(e))
    }
    return out
  }

  broadcast(msg: ServerMessage, exceptId?: number): void {
    const enc = this.encodeOnce ? new Encoded(msg) : undefined
    for (const p of this.players.values()) if (p.id !== exceptId) p.send(msg, enc)
  }

  *allEntities(): Iterable<Entity> {
    yield* this.players.values()
    yield* this.mobs.values()
    yield* this.items.values()
    yield* this.npcs.values()
    yield* this.cos.values()
  }

  /** What clients see of an entity (spawn, worldEnter), with the decorators applied. */
  state(e: Entity): EntityState {
    const s = this.baseState(e)
    for (const d of this.decorators) {
      try {
        d(e, s)
      } catch (err) {
        this.onError(err)
      }
    }
    return s
  }

  private baseState(e: Entity): EntityState {
    if (e.kind === 'player') {
      const s: EntityState = {
        id: e.id,
        kind: 'player',
        name: e.name,
        model: e.model,
        level: e.level,
        weapon: e.weapon,
        pos: [...e.pos],
        yaw: e.yaw,
        hp: Math.round(e.hp),
        maxHp: e.maxHp,
      }
      if (e.move) s.move = { ...e.move, from: [...e.move.from], to: [...e.move.to] }
      if (e.invisible) s.invisible = true
      if (e.dead) s.state = 'dead'
      // Always sent, empty included: a player wearing nothing visible must not be drawn with the starter weapon (the
      // client falls back to `weapon` only when `equip` is absent, an older server) nor stand in its grip.
      s.equip = visibleEquip(e)
      const plus = visibleEquipPlus(e.equip)
      if (Object.keys(plus).length > 0) s.equipPlus = plus
      s.height = e.height
      s.volume = e.volume
      if (e.look) s.look = e.look
      return s
    }
    if (e.kind === 'mob') {
      const s: EntityState = { id: e.id, kind: 'mob', name: e.name, model: e.def.code, level: e.level, pos: [...e.pos], yaw: e.yaw, hp: Math.round(e.hp), maxHp: e.maxHp }
      if (e.move) s.move = { ...e.move, from: [...e.move.from], to: [...e.move.to] }
      if (e.ai === 'dead') s.state = 'dead'
      if (e.variant !== 'normal') s.variant = e.variant
      return s
    }
    if (e.kind === 'item') {
      const s: EntityState = { id: e.id, kind: 'item', name: e.name, model: e.code, level: 0, pos: [...e.pos], yaw: e.yaw, count: e.count, expiresAt: e.expiresAt }
      if (e.plus) s.plus = e.plus
      if (e.owner !== null) {
        s.owner = e.owner
        s.ownerUntil = e.ownerUntil
      }
      return s
    }
    if (e.kind === 'cos') {
      // D31: `owner` = the owning player's entity id (ownerUntil is never set on a cos); hp/maxHp = the horse's HP.
      const s: EntityState = { id: e.id, kind: 'cos', name: e.name, model: e.code, level: e.level, pos: [...e.pos], yaw: e.yaw, hp: Math.round(e.hp), maxHp: e.maxHp, owner: e.owner }
      if (e.move) s.move = { ...e.move, from: [...e.move.from], to: [...e.move.to] }
      if (e.rider !== null) s.rider = e.rider
      if (e.hp <= 0) s.state = 'dead'
      return s
    }
    return { id: e.id, kind: 'npc', name: e.name, model: e.code, level: 0, pos: [...e.pos], yaw: e.yaw }
  }

  /** Authoritative position at `now` (interpolated along the current move). */
  positionAt(p: { pos: Vec3; move?: MoveState | null }, now: number): Vec3 {
    const m = p.move
    if (!m) return [...p.pos]
    const dx = m.to[0] - m.from[0]
    const dz = m.to[2] - m.from[2]
    const dist = Math.hypot(dx, dz)
    const travelled = Math.max(0, ((now - m.startedAt) / 1000) * m.speed)
    if (dist <= 0 || travelled >= dist) return [...m.to]
    const f = travelled / dist
    return [m.from[0] + dx * f, m.from[1] + (m.to[1] - m.from[1]) * f, m.from[2] + dz * f]
  }

  /** x/z distance between two entities at `now`. */
  distance(a: Entity, b: Entity, now: number): number {
    const pa = this.positionAt(a, now)
    const pb = this.positionAt(b, now)
    return Math.hypot(pa[0] - pb[0], pa[2] - pb[2])
  }

  /**
   * Exact position at `now` with the surface under it: along the move's navmesh legs (height from the leg's surface),
   * the move's end once arrived, or `pos` when standing. positionAt() is the cheap x/z interpolation of the same move.
   */
  livePoint(p: Mover, now: number): NavPoint {
    const m = p.move
    if (!m) return { x: p.pos[0], y: p.pos[1], z: p.pos[2], surface: p.surface ?? null }
    const dist = Math.hypot(m.to[0] - m.from[0], m.to[2] - m.from[2])
    const travelled = Math.max(0, ((now - m.startedAt) / 1000) * m.speed)
    if (dist <= 0 || travelled >= dist) return { x: m.to[0], y: m.to[1], z: m.to[2], surface: p.path ? p.path.end : (p.surface ?? null) }
    const path = p.path
    if (path && path.legs.length > 0) {
      const q = pointOnLegs(this.nav, path.legs, (travelled / dist) * path.length)
      if (q && Number.isFinite(q.y)) return q
    }
    const [x, y, z] = this.positionAt(p, now)
    return { x, y, z, surface: path ? null : (p.surface ?? null) }
  }

  /** Stands `p` at a live point (no broadcast): position, surface, no move. */
  private standAt(p: Mover, q: NavPoint): void {
    p.pos = [q.x, q.y, q.z]
    p.surface = q.surface
    p.move = null
    p.path = null
  }

  /** Pins the entity to its interpolated position without broadcasting. */
  settle(p: Mover, now: number): void {
    if (!p.move) return
    const q = this.livePoint(p, now)
    if (this.arrivalTime(p.move) <= now) this.standAt(p, q)
    else {
      // Still moving (the move stays the source of truth): pos/surface follow the live point.
      p.pos = [q.x, q.y, q.z]
      p.surface = q.surface
    }
  }

  /** Clamps x/z to the world bounds (or to +-MAX_COORD, the protocol's moveTo range, without bounds). */
  clamp(x: number, z: number): [number, number] {
    const b = this.bounds
    if (!b) return [Math.min(MAX_COORD, Math.max(-MAX_COORD, x)), Math.min(MAX_COORD, Math.max(-MAX_COORD, z))]
    // On a navmesh the bounds are region borders: stay a centimetre inside, never on the unloaded side's edge.
    const e = this.nav.kind === 'mesh' ? BOUNDS_INSET_M : 0
    return [Math.min(b.maxX - e, Math.max(b.minX + e, x)), Math.min(b.maxZ - e, Math.max(b.minZ + e, z))]
  }

  /** Starts a straight-line player move from the current authoritative position. */
  moveTo(p: Player, x: number, z: number, now = Date.now()): void {
    this.moveEntity(p, x, z, this.moveSpeed * p.speedMul, now)
  }

  /**
   * Starts a straight-line move of any mover at `speed` m/s (clamped, then validated by the navmesh hook).
   * Returns false when the entity ends up standing still (refused or zero-length move).
   */
  moveEntity(p: Player | Mob | Cos, x: number, z: number, speed: number, now = Date.now()): boolean {
    return this.walkEntity(p, x, z, speed, now) !== null
  }

  /**
   * moveEntity with the walk's details: the straight walk from the live point (and its surface) toward the
   * bounds-clamped target, stopping at the first blocking edge (docs/NAVIGATION.md §6). null when the entity ends up
   * standing (refused, blocked at once, or a zero-length move); otherwise whether the walk was clipped.
   */
  walkEntity(p: Player | Mob | Cos, x: number, z: number, speed: number, now = Date.now()): { blocked: boolean } | null {
    const start = this.livePoint(p, now)
    const from: Vec3 = [start.x, start.y, start.z]
    let [cx, cz] = this.clamp(x, z)
    // Siege of Jangan (docs/SIEGE.md §4.3): a siege monster's walk stops at a warded gate.
    if (p.kind === 'mob' && p.siege && this.mobWalkClip) {
      const c = this.mobWalkClip(p, start.x, start.z, cx, cz)
      if (c) [cx, cz] = c
    }
    const walk = this.nav.walk(start, cx, cz)
    const end = walk?.end
    if (!walk || !end || Math.hypot(end.x - from[0], end.z - from[2]) < MIN_MOVE_M) {
      const wasMoving = p.move !== null
      this.standAt(p, start)
      if (wasMoving) this.broadcastAbout(p, { t: 'stop', id: p.id, pos: wirePos(from), yaw: wireYaw(p.yaw) })
      return null
    }
    p.pos = from
    p.surface = start.surface
    p.yaw = yawTowards(end.x - from[0], end.z - from[2])
    // y is authoritative from the surface on a navmesh; a flat world keeps the height it had.
    const toY = this.nav.kind === 'mesh' && Number.isFinite(end.y) ? end.y : from[1]
    p.move = { from, to: [end.x, toY, end.z], speed, startedAt: now }
    p.path = walk.legs.length > 0 ? { legs: walk.legs, length: legsLength(walk.legs), end: end.surface } : end.surface ? { legs: [], length: 0, end: end.surface } : null
    this.broadcastAbout(p, { t: 'move', id: p.id, move: { ...p.move, from: wirePos(from), to: wirePos(p.move.to) } })
    return { blocked: walk.blocked }
  }

  /**
   * Stops a mover where it is now, optionally turning it (e.g. to face an attack target). A standing entity is
   * re-announced only when it turns by more than TURN_EPS (so fighting a slowly moving target does not flood
   * `stop` messages every tick).
   */
  halt(p: Player | Mob | Cos, now: number, yaw?: number): void {
    const moving = p.move !== null
    if (moving) this.standAt(p, this.livePoint(p, now))
    const diff = yaw === undefined ? 0 : Math.abs(Math.atan2(Math.sin(yaw - p.yaw), Math.cos(yaw - p.yaw)))
    if (yaw !== undefined && (moving || diff > TURN_EPS)) p.yaw = yaw
    if (moving || diff > TURN_EPS) this.broadcastAbout(p, { t: 'stop', id: p.id, pos: wirePos(p.pos), yaw: wireYaw(p.yaw) })
  }

  arrivalTime(m: MoveState): number {
    const dist = Math.hypot(m.to[0] - m.from[0], m.to[2] - m.from[2])
    return m.startedAt + (dist / m.speed) * 1000
  }

  /** Finishes arrived moves (broadcasting `stop`), runs gameplay, then updates interest. */
  tick(now: number): void {
    const T = this.timers
    const t0 = T.now()
    for (const p of this.players.values()) this.arrive(p, now)
    for (const m of this.mobs.values()) this.arrive(m, now)
    // a walking trade transport (docs/JOBS.md §5.4); a ridden horse shares its rider's move and is never sent one
    for (const c of this.cos.values()) if (c.rider === null) this.arrive(c, now)
    T.lap(PH.arrive, t0)
    // gameplay times its own phases
    this.onTick?.(now)
    if (now - this.interestAt >= INTEREST_MS || now < this.interestAt) this.updateInterest(now)
  }

  private arrive(p: Player | Mob | Cos, now: number): void {
    if (!p.move || this.arrivalTime(p.move) > now) return
    this.standAt(p, { x: p.move.to[0], y: p.move.to[1], z: p.move.to[2], surface: p.path ? p.path.end : (p.surface ?? null) })
    this.broadcastAbout(p, { t: 'stop', id: p.id, pos: wirePos(p.pos), yaw: wireYaw(p.yaw) })
  }

  // ---- interest management ------------------------------------------------------------------------

  /** Whether `e` is in `viewer`'s view range (with the despawn margin when the viewer already has it). */
  inRange(viewer: Player, e: Entity, now: number, known: boolean): boolean {
    let r = this.viewRange + (known ? VIEW_HYSTERESIS_M : 0)
    // Play the Boss, Stalk: a veiled boss only shows within `veil` m (no hysteresis), except to staff and her pilot.
    if (e.kind === 'mob' && e.veil !== undefined && !viewer.staff && e.pilot?.player !== viewer.id) r = Math.min(r, e.veil)
    const anchor = this.viewAnchor(viewer)
    const a = this.posCache?.get(anchor) ?? this.positionAt(anchor, now)
    const b = this.posCache?.get(e) ?? this.positionAt(e, now)
    const dx = a[0] - b[0]
    const dz = a[2] - b[2]
    return dx * dx + dz * dz <= r * r
  }

  /** Where `viewer`'s interest is centred: the entity it views from (Play the Boss: the boss it steers), else itself. */
  viewAnchor(viewer: Player): Mover {
    const id = viewer.viewFrom
    return id === undefined ? viewer : (this.mobs.get(id) ?? viewer)
  }

  /** Spawns `e` for `viewer` if it may see it and it is in range. */
  private reveal(viewer: Player, e: Entity, now: number): void {
    if (viewer.id === e.id || viewer.known.has(e.id) || !this.canSee(viewer, e) || !this.inRange(viewer, e, now, false) || this.crowded(viewer, e, now)) return
    viewer.known.add(e.id)
    viewer.send({ t: 'spawn', entity: this.state(e) })
  }

  /** Brings one viewer's known set in line with what it should see. */
  private refreshViewer(v: Player, candidates: Iterable<Entity>, now: number): void {
    for (const e of candidates) this.reveal(v, e, now)
    for (const id of [...v.known]) {
      const e = this.entity(id)
      if (!e || !this.canSee(v, e) || !this.inRange(v, e, now, true) || this.crowded(v, e, now)) {
        v.known.delete(id)
        v.send({ t: 'despawn', id })
      }
    }
  }

  /** After a teleport: what `p` sees (if a player) and who sees `p`. */
  refreshAround(p: Entity, now: number): void {
    if (p.kind === 'player') {
      // a warp into a crowd: pick its crowd there first (not every player of the town at once)
      this.pickCrowd(p, this.players.values(), now)
      this.refreshViewer(p, this.allEntities(), now)
    }
    for (const v of this.players.values()) {
      if (v.id === p.id) continue
      if (v.known.has(p.id)) {
        if (!this.canSee(v, p) || !this.inRange(v, p, now, true)) {
          v.known.delete(p.id)
          v.send({ t: 'despawn', id: p.id })
        }
      } else this.reveal(v, p, now)
    }
  }

  /**
   * Each entity's position during one updateInterest pass (computed once, not once per viewer pair: at 500 players in
   * one town that was ~half a million positionAt calls per pass). Null outside the pass.
   */
  private posCache: Map<Entity | Mover, Vec3> | null = null
  /** Interest passes run (the crowd re-pick stagger). */
  private interestPasses = 0

  /** Recomputes every player's view, using a uniform grid so the cost grows with nearby entities only. */
  updateInterest(now: number): void {
    this.interestAt = now
    if (this.players.size === 0) return
    const T = this.timers
    const t0 = T.now()
    this.crowdMs = 0
    this.posCache = new Map()
    if (this.aoiFast && this.alsoMustSeeKeys) this.passKeys = new Map()
    try {
      this.interestPass(now, this.posCache)
    } finally {
      this.posCache = null
      this.passKeys = null
      this.keysViewer = null
      this.keysOfViewer = null
      if (T.enabled) {
        T.add(PH.crowd, this.crowdMs)
        T.add(PH.interest, T.now() - t0 - this.crowdMs)
      }
    }
  }

  /** Time spent in crowd picks during the current interest pass (ms; the `crowd` phase). */
  private crowdMs = 0

  private interestPass(now: number, cache: Map<Entity | Mover, Vec3>): void {
    if (this.aoiFast) return this.interestPassFast(now, cache)
    this.interestPasses++
    const cell = Math.max(16, this.viewRange)
    const grid = new Map<string, Entity[]>()
    const key = (cx: number, cz: number) => `${cx},${cz}`
    for (const e of this.allEntities()) {
      const at = this.positionAt(e, now)
      cache.set(e, at)
      const [x, , z] = at
      const k = key(Math.floor(x / cell), Math.floor(z / cell))
      const list = grid.get(k)
      if (list) list.push(e)
      else grid.set(k, [e])
    }
    for (const v of this.players.values()) {
      const [x, , z] = this.positionAt(this.viewAnchor(v), now)
      const cx = Math.floor(x / cell)
      const cz = Math.floor(z / cell)
      const near: Entity[] = []
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) near.push(...(grid.get(key(cx + i, cz + j)) ?? []))
      if (v.crowd === undefined || (this.interestPasses + v.id) % this.crowdRepickPasses === 0) {
        const c0 = this.timers.now()
        this.pickCrowd(v, near, now)
        this.crowdMs += this.timers.now() - c0
      }
      this.refreshViewer(v, near, now)
    }
  }

  /**
   * AOI_FAST (docs/SERVER_ARCHITECTURE.md P0): interestPass with the same spawns and despawns, sent in the same order,
   * minus its overhead: numeric cell keys and per-cell id/position arrays (no Map lookup per candidate), no per-viewer
   * copy of the candidates (the crowd re-pick reads the cells too: pickCrowdCells), the viewer's anchor looked up once,
   * the despawn check without copying the known set, and alsoMustSee by per-player keys (mustSee, alsoMustSeeKeys).
   */
  private interestPassFast(now: number, cache: Map<Entity | Mover, Vec3>): void {
    this.interestPasses++
    const cell = Math.max(16, this.viewRange)
    const grid = new Map<number, AoiCell>()
    for (const e of this.allEntities()) {
      const at = this.positionAt(e, now)
      cache.set(e, at)
      const k = cellKey(Math.floor(at[0] / cell), Math.floor(at[2] / cell))
      let c = grid.get(k)
      if (!c) grid.set(k, (c = { ents: [], ids: [], xs: [], zs: [], pl: [] }))
      c.ents.push(e)
      c.ids.push(e.id)
      c.pl.push(e.kind === 'player')
      c.xs.push(at[0])
      c.zs.push(at[2])
    }
    const cells: AoiCell[] = []
    const gone: number[] = []
    const view = this.viewRange
    for (const v of this.players.values()) {
      const anchor = this.viewAnchor(v)
      const a = cache.get(anchor) ?? this.positionAt(anchor, now)
      const ax = a[0]
      const az = a[2]
      const cx = Math.floor(ax / cell)
      const cz = Math.floor(az / cell)
      cells.length = 0
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const c = grid.get(cellKey(cx + i, cz + j))
          if (c) cells.push(c)
        }
      }
      if (v.crowd === undefined || (this.interestPasses + v.id) % this.crowdRepickPasses === 0) {
        const c0 = this.timers.now()
        this.pickCrowdCells(v, cells, a, now)
        this.crowdMs += this.timers.now() - c0
      }
      // reveal(), inlined: in view range (no hysteresis) of the anchor, visible, not hidden by the crowd cap. The same
      // pure conditions, the crowd cap first: in a crowd most candidates are players it hides (one Set lookup, not three).
      const vid = v.id
      const known = v.known
      const crowd = v.crowd
      for (const c of cells) {
        const { ents, ids, xs, zs, pl } = c
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]!
          if (id === vid) continue
          const e = ents[i]!
          if (crowd && pl[i] && !crowd.has(id) && !this.mustSee(v, e as Player, now)) continue
          if (known.has(id) || !this.canSee(v, e)) continue
          let r = view
          if (e.kind === 'mob' && e.veil !== undefined && !v.staff && e.pilot?.player !== vid) r = Math.min(r, e.veil)
          const dx = ax - xs[i]!
          const dz = az - zs[i]!
          if (!(dx * dx + dz * dz <= r * r)) continue
          known.add(id)
          v.send({ t: 'spawn', entity: this.state(e) })
        }
      }
      // refreshViewer()'s despawn half: gone, invisible, out of range (with hysteresis) or crowded out
      gone.length = 0
      for (const id of known) {
        const e = this.entity(id)
        if (!e || !this.canSee(v, e)) {
          gone.push(id)
          continue
        }
        let r = this.viewRange + VIEW_HYSTERESIS_M
        if (e.kind === 'mob' && e.veil !== undefined && !v.staff && e.pilot?.player !== v.id) r = Math.min(r, e.veil)
        const b = cache.get(e) ?? this.positionAt(e, now)
        const dx = a[0] - b[0]
        const dz = a[2] - b[2]
        if (!(dx * dx + dz * dz <= r * r) || this.crowded(v, e, now)) gone.push(id)
      }
      for (const id of gone) {
        known.delete(id)
        v.send({ t: 'despawn', id })
      }
    }
  }

  // ---- crowd cap (docs/NETWORK_AUDIT.md R1) ----

  /** Whether `e` is a player hidden from `viewer` by the crowd cap. */
  private crowded(viewer: Player, e: Entity, now: number): boolean {
    return e.kind === 'player' && !!viewer.crowd && !viewer.crowd.has(e.id) && !this.mustSee(viewer, e, now)
  }

  /**
   * Players a viewer always sees, however crowded: its attack/skill target and whoever targets it, players it fought
   * (hit or was hit by) within FOE_MEMORY_MS — PvP cape fights and Bounty Hunter vs Wanted alike — and gameplay's
   * own rule (alsoMustSee: party and guild members).
   */
  mustSee(viewer: Player, other: Player, now: number): boolean {
    const va = viewer.action
    if (va && (va.kind === 'attack' || va.kind === 'skill') && va.target === other.id) return true
    const oa = other.action
    if (oa && (oa.kind === 'attack' || oa.kind === 'skill') && oa.target === viewer.id) return true
    const t = viewer.foes?.get(other.id)
    if (t !== undefined && now - t < FOE_MEMORY_MS) return true
    if (this.passKeys) return this.sameKeys(viewer, other)
    return this.alsoMustSee?.(viewer, other) ?? false
  }

  /**
   * AOI_FAST: alsoMustSee in a form an interest pass evaluates once per player instead of once per pair (500 players in
   * one town are 250,000 pairs a pass): keys such that alsoMustSee(v, o) holds exactly when some key of v is set (not
   * null or undefined) and the same (===) as o's key at that index (gameplay.ts: the party, the guild). Absent: the pass
   * calls alsoMustSee.
   */
  alsoMustSeeKeys: ((p: Player) => readonly unknown[]) | null = null
  /** An AOI_FAST pass's memo of alsoMustSeeKeys (null: no key set; the map itself is null outside the pass). */
  private passKeys: Map<Player, readonly unknown[] | null> | null = null
  private keysViewer: Player | null = null
  private keysOfViewer: readonly unknown[] | null = null

  /** alsoMustSee through the pass's keys (a player with no key set, no party and no guild, matches nobody). */
  private sameKeys(viewer: Player, other: Player): boolean {
    let kv: readonly unknown[] | null
    if (viewer === this.keysViewer) kv = this.keysOfViewer
    else {
      kv = this.passKeysOf(viewer)
      this.keysViewer = viewer
      this.keysOfViewer = kv
    }
    if (kv === null) return false
    const ko = this.passKeysOf(other)
    if (ko === null) return false
    for (let i = 0; i < kv.length; i++) if (kv[i] != null && kv[i] === ko[i]) return true
    return false
  }

  private passKeysOf(p: Player): readonly unknown[] | null {
    const memo = this.passKeys!
    let k = memo.get(p)
    if (k === undefined) {
      const keys = this.alsoMustSeeKeys!(p)
      k = keys.some((x) => x != null) ? keys : null
      memo.set(p, k)
    }
    return k
  }

  /** A player-vs-player hit: both stay visible to each other for FOE_MEMORY_MS. */
  noteFoes(a: Player, b: Player, now: number): void {
    ;(a.foes ??= new Map()).set(b.id, now)
    ;(b.foes ??= new Map()).set(a.id, now)
    for (const p of [a, b]) if (p.foes!.size > 32) for (const [id, at] of p.foes!) if (now - at >= FOE_MEMORY_MS) p.foes!.delete(id)
  }

  /**
   * Picks `viewer.crowd` from the players among `candidates`: null while at most maxVisiblePlayers are in view range,
   * else the must-see ones plus the nearest others up to the cap, where a player already shown counts CROWD_SWAP_M
   * nearer (hysteresis: a newcomer has to be clearly closer to take its place).
   */
  pickCrowd(viewer: Player, candidates: Iterable<Entity>, now: number): void {
    const max = this.maxVisiblePlayers
    viewer.crowd = null
    if (max <= 0) return
    const anchor = this.viewAnchor(viewer)
    const a = this.posCache?.get(anchor) ?? this.positionAt(anchor, now)
    const r = this.viewRange + VIEW_HYSTERESIS_M
    const rest: { id: number; d: number }[] = []
    const keep = new Set<number>()
    for (const e of candidates) {
      if (e.kind !== 'player' || e.id === viewer.id || !this.canSee(viewer, e)) continue
      const b = this.posCache?.get(e) ?? this.positionAt(e, now)
      const d = Math.hypot(a[0] - b[0], a[2] - b[2])
      if (d > r) continue
      if (this.mustSee(viewer, e, now)) keep.add(e.id)
      else rest.push({ id: e.id, d: viewer.known.has(e.id) ? d - CROWD_SWAP_M : d })
    }
    if (keep.size + rest.length <= max) return
    // shown players stay while they fit; free slots go to the nearest newcomers; then at most CROWD_SWAPS_PER_PASS
    // shown players (the farthest) give way to clearly nearer newcomers (shown ones count CROWD_SWAP_M nearer)
    const shown = rest.filter((x) => viewer.known.has(x.id)).sort((x, y) => x.d - y.d)
    const fresh = rest.filter((x) => !viewer.known.has(x.id)).sort((x, y) => x.d - y.d)
    const slots = Math.max(0, max - keep.size)
    const take = shown.slice(0, slots)
    let f = 0
    while (take.length < slots && f < fresh.length) take.push(fresh[f++]!)
    for (let swaps = 0; swaps < CROWD_SWAPS_PER_PASS && f < fresh.length; swaps++) {
      // the farthest shown player still taken
      let worst = -1
      for (let i = 0; i < take.length; i++) if (viewer.known.has(take[i]!.id) && (worst < 0 || take[i]!.d > take[worst]!.d)) worst = i
      if (worst < 0 || fresh[f]!.d >= take[worst]!.d) break
      take[worst] = fresh[f++]!
    }
    for (const x of take) keep.add(x.id)
    viewer.crowd = keep
  }

  /**
   * AOI_FAST: pickCrowd over an interest pass's cells (`a`: the viewer's anchor position of the pass), the same crowd:
   * positions from the cell arrays instead of the pass's map, each candidate's `known` looked up once, and no full
   * sorts where pickCrowd only reads the head of one. pickCrowd takes the `slots` nearest shown players (all of them
   * when they fit: no sort needed, the set is the same), fills up with the nearest newcomers and swaps the farthest
   * shown one (the first of equals in its stable order) for a clearly nearer newcomer; a viewer whose crowd is settled
   * needs only the few nearest newcomers (firstSorted), not all of them sorted.
   */
  private pickCrowdCells(viewer: Player, cells: readonly AoiCell[], a: Vec3, now: number): void {
    const max = this.maxVisiblePlayers
    viewer.crowd = null
    if (max <= 0) return
    const r = this.viewRange + VIEW_HYSTERESIS_M
    const known = viewer.known
    const vid = viewer.id
    const shownAll: CrowdPick[] = []
    const freshAll: CrowdPick[] = []
    let n = 0
    const keep = new Set<number>()
    for (const c of cells) {
      const { ents, ids, xs, zs, pl } = c
      for (let i = 0; i < ids.length; i++) {
        if (!pl[i] || ids[i] === vid) continue
        const e = ents[i] as Player
        if (!this.canSee(viewer, e)) continue
        const d = Math.hypot(a[0] - xs[i]!, a[2] - zs[i]!)
        if (d > r) continue
        if (this.mustSee(viewer, e, now)) keep.add(e.id)
        else if (known.has(e.id)) shownAll.push({ id: e.id, d: d - CROWD_SWAP_M, shown: true, pos: n++ })
        else freshAll.push({ id: e.id, d, shown: false, pos: n++ })
      }
    }
    if (keep.size + n <= max) return
    const slots = Math.max(0, max - keep.size)
    const take = shownAll.length <= slots ? shownAll : firstSorted(shownAll, slots)
    const fresh = firstSorted(freshAll, slots - take.length + CROWD_SWAPS_PER_PASS)
    let f = 0
    while (take.length < slots && f < fresh.length) take.push(fresh[f++]!)
    for (let swaps = 0; swaps < CROWD_SWAPS_PER_PASS && f < fresh.length; swaps++) {
      // the farthest shown player taken; of equals the first in pickCrowd's stable order (the earliest candidate)
      let worst = -1
      for (let i = 0; i < take.length; i++) {
        const x = take[i]!
        if (x.shown && (worst < 0 || x.d > take[worst]!.d || (x.d === take[worst]!.d && x.pos < take[worst]!.pos))) worst = i
      }
      if (worst < 0 || fresh[f]!.d >= take[worst]!.d) break
      take[worst] = fresh[f++]!
    }
    for (const x of take) keep.add(x.id)
    viewer.crowd = keep
  }

  /**
   * Local chat (docs/NETWORK_AUDIT.md R5): to every player within viewRange of the speaker (the crowd cap does not
   * apply: you hear the players you may not be shown). The speaker always gets its own line.
   */
  sayLocal(speaker: Player, msg: ServerMessage, now = Date.now()): void {
    // A full scan on live positions: chat arrives between ticks, where no pass grid holds (0.2 % of the CPU at 500).
    const enc = this.encodeOnce ? new Encoded(msg) : undefined
    const at = this.positionAt(speaker, now)
    const r2 = this.viewRange * this.viewRange
    for (const p of this.players.values()) {
      if (p.id === speaker.id) {
        p.send(msg, enc)
        continue
      }
      const anchor = this.viewAnchor(p)
      const q = this.positionAt(anchor, now)
      if ((q[0] - at[0]) ** 2 + (q[2] - at[2]) ** 2 <= r2) p.send(msg, enc)
    }
  }

  /**
   * Players within `range` metres of a point (alive or not), in world.players order. Inside the monster pass
   * (beginPlayerScan .. endPlayerScan, same `now`) the pass's player grid picks the candidates (docs/SERVER_ARCHITECTURE.md
   * P0, F1: no more every-monster-scans-every-player); the exact test on the live position is the same either way.
   */
  playersNear(x: number, z: number, range: number, now: number): Player[] {
    const out: Player[] = []
    if (this.scanNow === now) {
      let g = this.scan
      // a teleport, a login or a logout since the grid was built: build it again
      if (!g || g.epoch !== this.playerEpoch || g.count !== this.players.size) g = this.scan = this.playerGrid(now)
      for (const p of g.candidates(x, z, range)) {
        const q = this.positionAt(p, now)
        if ((q[0] - x) ** 2 + (q[2] - z) ** 2 <= range * range) out.push(p)
      }
      return out
    }
    for (const p of this.players.values()) {
      const q = this.positionAt(p, now)
      if ((q[0] - x) ** 2 + (q[2] - z) ** 2 <= range * range) out.push(p)
    }
    return out
  }

  /**
   * Starts the monster pass at `now` (Gameplay.tick): builds the player grid that playersNear and the wake check use
   * until endPlayerScan. null with MOB_GRID off (full scans, the old path).
   */
  beginPlayerScan(now: number): PlayerGrid | null {
    if (!this.mobGrid) {
      this.endPlayerScan()
      return null
    }
    this.scanNow = now
    return (this.scan = this.playerGrid(now))
  }

  endPlayerScan(): void {
    this.scanNow = null
    this.scan = null
  }

  private playerGrid(now: number): PlayerGrid {
    return new PlayerGrid(this.players.values(), this.players.size, (p) => this.positionAt(p, now), now, this.playerEpoch)
  }
}

/** Item codes a player shows (weapon, shield, armour) for EntityState.equip / appearance. */
export function visibleEquip(p: Player): Partial<Record<EquipSlot, string>> {
  const out: Partial<Record<EquipSlot, string>> = {}
  for (const slot of VISIBLE_SLOTS) {
    const it = p.equip[slot]
    if (it) out[slot] = it.code
  }
  return out
}

/**
 * The +N of the visible slots that have one (EntityState.equipPlus, appearance `plus`, CharacterSummary.equipPlus):
 * what the weapon glow draws (apps/game/src/three/weapon-glow.ts). Slots at +0 are left out.
 */
export function visibleEquipPlus(equip: Partial<Record<EquipSlot, Pick<ItemStack, 'plus'> | null | undefined>>): Partial<Record<EquipSlot, number>> {
  const out: Partial<Record<EquipSlot, number>> = {}
  for (const slot of VISIBLE_SLOTS) {
    const plus = equip[slot]?.plus ?? 0
    if (plus > 0) out[slot] = plus
  }
  return out
}
