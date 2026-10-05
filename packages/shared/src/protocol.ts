/**
 * Game protocol v1: browser client <-> authoritative server.
 *
 * Transport: JSON text frames over one WebSocket (`/ws`). Accounts use a small HTTP JSON API
 * (see `Api*` types) that returns a session token; the socket's first frame is `hello` with that token.
 * Positions are world metres in the frame of the converted world manifest
 * (glTF space: right-handed, Y up; see docs/CONVENTIONS.md "World space").
 * The server is authoritative for x/z. y is presentation only (the client snaps to the ground).
 *
 * Content is referenced by the client's CodeName128 ids (e.g. CHAR_CH_MAN_ADVENTURER), never by file paths,
 * so the art can be replaced later without touching gameplay or saved data.
 */

import type { EquipSlot, ItemStack, MobVariant } from './content.ts'
import type { QuestDef, QuestFile, QuestIssue, QuestItemDef, QuestLocation } from './quests.ts'
import type { WorldClockState } from './world-clock.ts'
import type { WeatherKind, WeatherParams } from './weather.ts'
import type { HazardCause, StrikeKind, StrikeSource } from './lightning.ts'
import type { StormEffect, StormPhase } from './storm.ts'
// Play the Boss (docs/PLAY_THE_BOSS.md §5): its messages, requests and fail reasons live in pilot.ts.
import { PILOT_FAIL_REASONS, PILOT_RATE_LIMITS, PILOT_REQUESTS, type PilotClientMessage, type PilotFailReason, type PilotRequest, type PilotServerMessage } from './pilot.ts'

// Wave 9 (docs/WAVE_PLAN3.md §3.2): the clock and weather types live in their own modules.
export type { WorldClockState } from './world-clock.ts'
export type { WeatherKind } from './weather.ts'

export const PROTOCOL_VERSION = 1

export type Vec3 = [number, number, number]

/** Chinese starter weapon families offered at character creation (vSRO). */
export type StarterWeapon = 'sword' | 'blade' | 'spear' | 'glaive' | 'bow'

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'version_mismatch'
  | 'name_taken'
  | 'name_invalid'
  | 'slots_full'
  | 'not_found'
  | 'not_in_world'
  | 'already_in_world'
  | 'rate_limited'
  | 'server_error'
  /** GM addition: a non-GM account sent `gm` or typed a slash command in chat. */
  | 'forbidden'

/**
 * GM addition. Account role, stored in accounts.role and changed with `pnpm gm grant|revoke`.
 * 'gm' and 'admin' may run GM commands; an admin also outranks a gm (a gm cannot kick or summon an admin).
 */
export type Role = 'player' | 'gm' | 'admin'

// ---- HTTP API --------------------------------------------------------------------------------

/** POST /api/register */
export interface ApiRegisterRequest {
  username: string
  password: string
}

/** POST /api/login */
export interface ApiLoginRequest {
  username: string
  password: string
}

export interface ApiLoginResponse {
  token: string
  /** ms since epoch */
  expiresAt: number
}

export interface ApiError {
  error: ErrorCode
  message: string
}

/** GET /api/servers — shown on the server-select screen. */
export interface ServerInfo {
  id: string
  name: string
  status: 'online' | 'maintenance' | 'offline'
  online: number
  capacity: number
  /**
   * Fields addition (docs/FIELDS.md §6.1): the world export folder under /out(-opt)/world/ this server simulates,
   * e.g. 'jangan-fields' (lower-case letters, digits and '-', at most 64). Absent (older servers) = 'jangan'.
   */
  world?: string
  /**
   * Wave 10 (docs/SCREENS.md §9, docs/WAVE_PLAN6.md §3.2): the lobby's world clock, so the character screens' sky
   * matches the world's. Absent (older servers, the mock) = the stage's own fallback time. A malformed value is
   * dropped on its own by the validator, never the whole `welcome`.
   */
  clock?: WorldClockState
  /** Wave 10 (docs/SCREENS.md §9): the lobby's weather; absent = clear. Dropped on its own when malformed. */
  weather?: WeatherSync
  /**
   * Admin addition (docs/ADMIN.md): whether POST /api/register accepts new accounts (the admin panel's switch). The
   * login screen hides Register when it is 'closed'. Absent (older servers, the mock) = 'open'.
   */
  registration?: 'open' | 'closed'
}

// ---- data shared by several messages ------------------------------------------------------------

export interface CharacterSummary {
  id: number
  name: string
  /** CodeName128 of the character model, e.g. CHAR_CH_MAN_ADVENTURER */
  model: string
  level: number
  weapon: StarterWeapon
  /** Human-readable location, e.g. "Jangan" */
  location: string
  pos: Vec3
  /** ms since epoch; 0 = never entered the world */
  lastPlayed: number
  /** Appearance addition: Height choice 0..4 (default 2), see heightScale(). */
  height?: number
  /** Appearance addition: Volume (build) choice 0..4 (default 2); per-bone, see docs/CHARACTER_SCALE.md. */
  volume?: number
  /** Appearance addition: item codes worn in visible slots, so character select can dress the character. */
  equip?: Partial<Record<EquipSlot, string>>
  /** Weapon glow addition: the enhancement (+N, 1..255) of the visible slots in `equip` that have one; absent = all +0. */
  equipPlus?: Partial<Record<EquipSlot, number>>
}

export interface MoveState {
  from: Vec3
  to: Vec3
  /** metres per second */
  speed: number
  /** server time (ms) at which the move started; client converts using the `pong` clock offset */
  startedAt: number
}

export interface EntityState {
  /** Runtime entity id (not the character id). Unique across all kinds while the entity exists. */
  id: number
  /** Gameplay addition: 'mob' | 'npc' | 'item' (see EntityKind). Older servers send only 'player'. */
  kind: EntityKind
  /** Players: character name. Mobs/NPCs/items: English display name (or the code when the name is missing). */
  name: string
  /**
   * CodeName128 content id. Players: the character model (CHAR_CH_*). Mobs: the MobDef code (MOB_*).
   * NPCs: the NpcDef code (NPC_*). Items: the ItemDef code (ITEM_*, gold piles ITEM_ETC_GOLD_0x).
   */
  model: string
  /** 0 for NPCs and ground items. */
  level: number
  /** Players only (always present for kind 'player'). */
  weapon?: StarterWeapon
  pos: Vec3
  /** radians about +Y */
  yaw: number
  move?: MoveState
  /**
   * GM addition: present (true) only while a GM is invisible. Only GM/admin viewers (and the GM
   * itself) ever receive an invisible entity; clients should draw it semi-transparent.
   */
  invisible?: boolean
  // ---- gameplay additions (all optional; absent on older servers) ----
  /** Players and mobs: current and maximum HP. */
  hp?: number
  maxHp?: number
  /** Players and mobs; absent = 'alive'. A dead mob stays as a corpse briefly, then despawns. */
  state?: LifeState
  /** Mobs: spawn variant; absent = 'normal'. */
  variant?: MobVariant
  /** Items: stack size (gold piles: the amount of gold). */
  count?: number
  /** Items: enhancement level (+N). */
  plus?: number
  /**
   * Items: entity id of the player who alone may pick it up until `ownerUntil`; absent = anyone.
   * Wave 8 (D31): on a 'cos' (horse), the owning player's entity id (no `ownerUntil`).
   */
  owner?: number
  /** Items: server time (ms) the ownership ends. */
  ownerUntil?: number
  /** Items: server time (ms) the item disappears. */
  expiresAt?: number
  /** Players: item codes worn in visible slots (weapon, shield, armour), for drawing. */
  equip?: Partial<Record<EquipSlot, string>>
  /** Players (weapon glow addition): the +N (1..255) of the visible slots in `equip` that have one; absent = all +0. */
  equipPlus?: Partial<Record<EquipSlot, number>>
  /** Players: Height choice 0..4 (default 2). Render scale = heightScale(height). */
  height?: number
  /** Players: Volume (build) choice 0..4 (default 2). */
  volume?: number
  // ---- wave 3 additions (docs/WAVE_PLAN.md §2.1) ----
  /** Players and mobs: active buffs, debuffs, statuses, imbues and toggles (at most MAX_EFFECTS_PER_ENTITY), so late joiners see them. */
  effects?: EffectState[]
  /** Players: present (true) while the account is gm/admin. Display only (the [GM] tag, docs/UX_GAPS.md §5.2). */
  gm?: true
  // ---- wave 4 additions (docs/WAVE_PLAN.md §2.2) ----
  /**
   * NPCs: the authored NPC identity (NPCX_*, docs/QUESTS.md §5.3) when it differs from `model` (then the base look).
   * NPC identity on the client = `npc ?? model` (quest givers, dialogs).
   */
  npc?: string
  /** Items: id of the party whose members share the owner window (docs/QUESTS.md §4.3). */
  ownerParty?: number
  // ---- wave 7B additions (docs/WAVE_PLAN2.md §3.1, docs/EFFECTS.md §4) ----
  /** Items: server ms (an integer) the item reached the ground; fresh drops play the toss (docs/EFFECTS.md §3.6). */
  droppedAt?: number
  /** Items: where it was thrown from (the corpse point); absent for player drops. */
  dropFrom?: Vec3
  /** Players: 'sit' while sitting; absent = standing. */
  posture?: 'sit'
  // ---- wave 8 additions (docs/WAVE_PLAN2.md §3.2) ----
  /** Players: entity id of the horse being ridden; absent = on foot. */
  mount?: number
  /**
   * Cos: entity id of its rider; absent = parked. For kind 'cos', `owner` = the owning player's entity id and
   * `hp`/`maxHp` = the horse's HP (docs/WAVE_PLAN2.md D31).
   */
  rider?: number
  /** Players: Berserk time left at send time (ms, 1..600000); absent = not berserk. */
  berserkMs?: number
  /** Players: the stall title (0..STALL_TITLE_MAX code points); present = a stall exists. */
  stall?: string
  /** Players: the guild name (0..GUILD_TITLE_MAX code points on the wire; GUILD_NAME for real names); absent = none. */
  guild?: string
  // ---- Play the Boss additions (docs/PLAY_THE_BOSS.md §5.2) ----
  /** Players: the body rests in a trance while its player steers a boss (drawn sitting, "In a trance"). */
  trance?: true
  /** Mobs: a player steers it now (the label line "steered by a player"). */
  piloted?: true
  /** Players: a title code (PILOT_HONOR; client i18n `pilot.honor.<code>`), e.g. 'tiger_spirit'. */
  honor?: string
  // ---- storm additions (docs/WEATHER.md §12) ----
  /** Mobs: storm-charged (it survived a lightning strike): the blue electric glow, until the storm ends or it dies. */
  charged?: true
}

export interface WorldInfo {
  /** Manifest name under /out/world/<name>/manifest.json */
  name: string
  serverTime: number
  /** Server simulation rate (Hz). */
  tickRate: number
  /** Wave 3 addition: the server's level cap (config LEVEL_CAP, 1..300); absent = DEFAULT_LEVEL_CAP. */
  levelCap?: number
  /** Wave 8: the server's ALCHEMY_RATE (success-chance multiplier, 0..10), for the alchemy window's preview. */
  alchemyRate?: number
  /** Wave 8: ALCHEMY_MAX_PLUS (1..12). */
  alchemyMaxPlus?: number
  /** Wave 8: guild creation cost and level (config GUILD_CREATE_GOLD / GUILD_CREATE_LEVEL), for the create prompt. */
  social?: { guildCreateGold: number; guildCreateLevel: number }
  /** Wave 9: the world clock anchor (docs/SKY.md §2.2); absent = the client runs a local clock from noon. */
  clock?: WorldClockState
  /** Wave 9: the current weather for late joiners (docs/WEATHER.md §4.1); absent = clear. */
  weather?: WeatherSync
}

/**
 * Wave 9 (docs/WEATHER.md §4.1, docs/WAVE_PLAN3.md §3.2): the server's weather. Clients blend `from` → `to` over
 * `start .. start + dur` (weather.ts blendWeather) and integrate `wet`/`puddle` forward from `at` (stepSurface).
 */
export interface WeatherSync {
  /** Server ms when the current transition began (may be in the past). */
  start: number
  /** Transition length, ms (0..600000). */
  dur: number
  from: WeatherKind
  to: WeatherKind
  /** Rain intensity of `to` (0.4..1; only for 'rain'; 1 otherwise). */
  intensity: number
  /** Server ms until which `to` is expected to hold (a hint for the HUD / GM; the next `weather` message decides). */
  until: number
  /** Direction the wind blows toward (radians 0..2π in the glTF XZ plane: 0 = +X east, π/2 = −Z north). */
  windDir: number
  /** Mean wind speed, m/s (0..30). */
  windMs: number
  /** Surface wetness and puddle level (0..1) at server ms `at`. */
  wet: number
  puddle: number
  at: number
  /** u32 seed of this segment (client gust noise; the server rolls lightning from it). */
  seed: number
  /** Present when a GM holds the weather. */
  gm?: true
  /**
   * W9F P1 (additive): the parameter vector the transition started from (the server's blend at the moment of the
   * change), sent while the transition runs. A late joiner blends from it; absent (an older server, or no transition
   * running): P[from] at intensity 1.
   */
  fromVec?: WeatherParams
}

/**
 * What storms do right now (docs/WEATHER.md §12; the `storm` message): the phase, the forecast or storm times, and
 * every active effect (the weather icon's tooltip lists them).
 */
export interface StormStatus {
  phase: StormPhase
  /** forecast: server ms the storm is due to break. */
  startsAt?: number
  /** forecast / storm of a storm event: server ms it is due to end. */
  endsAt?: number
  effects: StormEffect[]
}

/** A placed lightning strike (docs/WEATHER.md §2.7; the `strike` message). */
export interface LightningStrike {
  /** Strike id (1..2³²-1, increasing). */
  id: number
  /** Server ms the bolt lands. */
  at: number
  /** Server ms the telegraph began (the crackle and the glow on the spot); absent for a harmless `sky` flash. */
  warnAt?: number
  kind: StrikeKind
  /** Where the bolt ends (glTF metres): the ground, a tree top, the wall walk, a tower top; `sky`: a point in the cloud. */
  pos: Vec3
  /** Height (m) of the ground under the strike: a tree's or a tower's foot. Absent: `pos[1]`. */
  groundY?: number
  /** Damage radius (m) around the strike's ground point; 0 = harmless (a sky flash, a safe area). */
  radiusM: number
  /** u32: the bolt's shape and its return strokes, the same on every client. */
  seed: number
  /** The entity the strike was aimed at (kind `entity`): its spot when the telegraph began. */
  target?: number
  /** Additive (docs/WEATHER.md §13): thrown by a tornado (the client draws an arc from the funnel); absent: the storm's. */
  source?: StrikeSource
}

/**
 * A lightning tornado (docs/WEATHER.md §13; the `tornado` message): its timeline and the path it walks, so every client
 * places it with `tornadoAt` (tornado.ts) without a message per step.
 */
export interface TornadoState {
  /** Tornado id (1..2³²-1). */
  id: number
  /** u32: the funnel's look (noise, debris), the same on every client. */
  seed: number
  /** Server ms the warning began (the wall cloud lowers). */
  warnAt: number
  /** Server ms it touches down and starts walking `path`. */
  touchAt: number
  /** Server ms its walk ends (it then lifts over LIFT_MS). */
  endAt: number
  /** Server ms it began to lift early (the storm passed, a GM); absent: it lifts at `endAt`. */
  liftAt?: number
  /** Waypoints on the ground (glTF metres), walked from the first at `speedMs` from `touchAt`. */
  path: Vec3[]
  speedMs: number
  /** Pull and catch radii (m). */
  pullM: number
  coreM: number
  /** TORNADO_STRENGTH 0..2 (the funnel's size and fury on the client). */
  strength: number
  /** The area's name at touchdown (the announcement), as GameData.zoneName gives it. */
  area?: string
  /** Spawned by a GM (`storm tornado`). */
  gm?: boolean
}

/** What moved a body without its say (docs/WEATHER.md §13; the `displace` message). */
export type DisplaceKind = 'pull' | 'throw'

// ---- client -> server ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: 'hello'; version: number; token: string }
  | { t: 'charList' }
  | { t: 'nameCheck'; name: string }
  | { t: 'charCreate'; name: string; model: string; weapon: StarterWeapon; height?: number; volume?: number; outfit?: StarterOutfit }
  | { t: 'charDelete'; id: number }
  | { t: 'enterWorld'; id: number }
  | { t: 'moveTo'; x: number; z: number }
  /**
   * Wave 3: `to` whispers a character by name (CHARACTER_NAME rule); `channel` picks the channel (absent = 'local';
   * 'party' goes to your party, `error bad_request` when you are in none). Wave 8: 'guild' goes to your guild's online
   * members, 'stall' to the stall you own or visit (`error bad_request` when you have none). `to` together with any
   * channel other than 'local' is rejected (docs/WAVE_PLAN2.md D32).
   */
  | { t: 'chat'; text: string; to?: string; channel?: ChatSendChannel }
  | { t: 'leaveWorld' }
  | { t: 'ping'; n: number; clientTime: number }
  /**
   * GM addition: run a Game Master command (lobby or world). `cmd` matches GM_COMMAND, at most
   * GM_MAX_ARGS args of at most GM_MAX_ARG_LENGTH code points each. GM/admin accounts get `gmResult`;
   * anyone else gets `error forbidden`. Every call (allowed or not) is written to the gm_audit table.
   * Commands: help, who, where [player], tp <x> <z> | tp <preset> | tp <player> (tp alone lists presets),
   * summon <player>, kick <player> [reason...], notice <text...>, setlevel <player> <1..cap>,
   * speed <0.5..5>, invis <on|off>, heal, spawn, item, kill. Multi-word text (notice, kick reason)
   * may be one arg or several (joined with spaces).
   * The same commands can be typed in chat as `/cmd args` (`/tp 100 -100`); such lines are never broadcast.
   * Gameplay GM commands (docs/PROTOCOL.md "GM"): spawn <mob code> [n], item <item code> [n],
   * kill [entity id] (default: your current attack target), heal [player].
   * Wave 9 (docs/PROTOCOL.md "Wave 9"): time [hh:mm | day n | length min | freeze | resume | night k | season deg |
   * reset], weather [state[:intensity] [minutes] [transitionS] | auto | wind m/s [deg] | wet 0..1 [puddle] | strike [distM]].
   */
  | { t: 'gm'; cmd: string; args: string[] }
  // ---- gameplay additions (docs/PROTOCOL.md). Intents only: the server decides every outcome. ----
  /** Auto-attack an entity (mob; players when PvP exists). The server walks into range and repeats until stopped. */
  | { t: 'attack'; target: number }
  /** Stop auto-attack / the current action. `moveTo` also stops it. */
  | { t: 'stopAction' }
  /** Use a skill row (docs/SKILLS.md §10.1); `target` = entity id when the skill needs one. Using a toggle that is on turns it off. */
  | { t: 'useSkill'; skill: string; target?: number }
  /** Pick up a ground item (walks there first when out of reach). */
  | { t: 'pickup'; id: number }
  /** While dead: come back to life at the town return point (full HP/MP). */
  | { t: 'respawn' }
  /** Spend free stat points on STR or INT. */
  | { t: 'statUp'; stat: 'str' | 'int'; points: number }
  /** Move a bag stack to another bag slot: an empty slot moves, the same item merges, anything else swaps. */
  | { t: 'itemMove'; from: number; to: number }
  /** Move `count` of a bag stack into an empty bag slot. */
  | { t: 'itemSplit'; from: number; to: number; count: number }
  /** Equip the bag item at `bag`; `slot` picks ring1/ring2 (default: the item's own slot, first free ring). */
  | { t: 'itemEquip'; bag: number; slot?: EquipSlot }
  /** Unequip into bag slot `bag` (default: the first free bag slot). */
  | { t: 'itemUnequip'; slot: EquipSlot; bag?: number }
  /** Use (consume) the bag item at `bag`, e.g. a potion. */
  | { t: 'itemUse'; bag: number }
  /** Drop `count` (default: all) of the bag stack at `bag` on the ground at your feet. */
  | { t: 'itemDrop'; bag: number; count?: number }
  /** Buy `count` of `item` from the shop of NPC entity `npc` (must be within NPC_INTERACT_RANGE). */
  | { t: 'shopBuy'; npc: number; item: string; count: number }
  /** Sell `count` (default: all) of the bag stack at `bag` to NPC entity `npc`. */
  | { t: 'shopSell'; npc: number; bag: number; count?: number }
  // ---- wave 3: skills (docs/SKILLS.md §10.2) ----
  /** Learn the next row of a skill line (`..._02` after `_01`). */
  | { t: 'skillLearn'; skill: string }
  /** Raise a mastery by one level (costs LevelDef.masterySp). */
  | { t: 'masteryUp'; mastery: MasteryCode }
  /** Cancel an own buff or toggle of skill row `skill` (right-click on the buff icon). */
  | { t: 'buffCancel'; skill: string }
  /** Set (entry) or clear (null) hotbar slot 0..HOTBAR_SLOTS-1. Item entries hold a consumable's code. Saved per character. */
  | { t: 'hotbarSet'; slot: number; entry: HotbarEntry | null }
  // ---- wave 3: NPC dialogs, shops, storage (docs/SHOPS.md §7) ----
  /** Talk to NPC entity `npc` (walks to NPC_APPROACH_RANGE first when farther than NPC_INTERACT_RANGE). */
  | { t: 'npcTalk'; npc: number }
  /** Close the open NPC dialog (and its shop/storage windows). */
  | { t: 'npcClose' }
  /** Open the storage of storage keeper `npc`: answered by `storage`. */
  | { t: 'storageOpen'; npc: number }
  /** Bag -> storage. `count` default: all; `to` default: merge, then the first empty slot. Fee: ItemDef.keepFee x count. */
  | { t: 'storageDeposit'; npc: number; bag: number; count?: number; to?: number }
  /** Storage -> bag. `count` default: all; `bag` default: merge, then the first empty bag slot. */
  | { t: 'storageWithdraw'; npc: number; slot: number; count?: number; bag?: number }
  /** Storage slot -> storage slot: move / merge / swap, like itemMove. */
  | { t: 'storageMove'; npc: number; from: number; to: number }
  /** Move gold between the bag and storage. */
  | { t: 'storageGold'; npc: number; dir: StorageGoldDir; amount: number }
  /**
   * Buy back entry `index` of the `buyback` list (0 = oldest). `code`, when sent, must be that entry's item code
   * (else `not_found`): a second press sent before the new list arrives cannot buy back the next entry instead.
   */
  | { t: 'shopBuyback'; npc: number; index: number; code?: string }
  // ---- wave 4: quests (docs/QUESTS.md §1, §6.2). Every one is answered by exactly one actionResult. ----
  /** Accept quest `quest` from NPC entity `npc` (its identity must be the quest's giver; within NPC_INTERACT_RANGE). */
  | { t: 'questAccept'; npc: number; quest: string }
  /** Turn in a ready quest at NPC entity `npc` (the quest's turnIn). `choice` = index into rewards.choice (required when it has entries). */
  | { t: 'questTurnIn'; npc: number; quest: string; choice?: number }
  /** Drop an active quest and its quest items. */
  | { t: 'questAbandon'; quest: string }
  /** Complete a talk/deliver objective at that NPC (deliver hands the items over). */
  | { t: 'questTalk'; npc: number; quest: string; objective: string }
  /** Use the quest item of a useItem objective at your position. */
  | { t: 'questUseItem'; quest: string; objective: string }
  // ---- wave 4: party (docs/QUESTS.md §4). `exp`/`items` set the modes when this invite creates the party. ----
  /** Invite player entity `target`. */
  | { t: 'partyInvite'; target: number; exp?: PartyExpMode; items?: PartyItemMode }
  /** Answer the pending invite; `inviter` = the inviter's entity id from partyInvited. */
  | { t: 'partyRespond'; inviter: number; accept: boolean }
  | { t: 'partyLeave' }
  /** Leader only: remove member `member` (characterId). */
  | { t: 'partyKick'; member: number }
  /** Leader only: hand the lead to member `member` (characterId, online). */
  | { t: 'partyLeader'; member: number }
  /** Leader only: change the modes (at least one key). */
  | { t: 'partySettings'; exp?: PartyExpMode; items?: PartyItemMode }
  // ---- wave 7B: posture and emotes (docs/WAVE_PLAN2.md §3.1). Both are GameplayRequests: one actionResult each. ----
  /**
   * Sit down (`on: true`) or stand up. Refused with 'dead', or 'busy' while moving, acting, casting a skill or an item,
   * or within 5 s of combat. `on: false` while standing is ok (idempotent).
   */
  | { t: 'sit'; on: boolean }
  /** Play an emote (viewers get the server `emote`). Refused with 'dead', or 'busy' while moving or casting. Stands a sitter up first. */
  | { t: 'emote'; emote: EmoteKind }
  // ---- wave 8: combat and items (docs/WAVE_PLAN2.md §3.2.3, docs/SYSTEMS_COMBAT.md §7.2). One actionResult each. ----
  /** Mount your own parked horse (cos entity id); the server walks you to it first when it is farther than 2 m. */
  | { t: 'mountRide'; cos: number }
  /** Get off the horse; it stays parked where it stands. Refused 'not_mounted', or 'moving' while moving. */
  | { t: 'mountDismount' }
  /** Dismiss your horse, ridden or parked (also `/unsummon`). */
  | { t: 'mountDismiss' }
  /** Repair at a repairing NPC `npc`: `items` (1..16 refs, each {equip} xor {bag}); absent = repair everything damaged. */
  | { t: 'repair'; npc: number; items?: RepairRef[] }
  /** Enhance the bag item at `item` with the elixir at `elixir` and, optionally, a Lucky Powder at `powder` (all distinct bag slots). */
  | { t: 'alchemyReinforce'; item: number; elixir: number; powder?: number }
  /** Cancel the running fuse (`alchemyResult {outcome: 'cancelled'}`). */
  | { t: 'alchemyCancel' }
  /** Enter Berserk with a full gauge (PlayerStats.hwan === HWAN_MAX). */
  | { t: 'berserk' }
  // ---- wave 8: trade (docs/SYSTEMS_SOCIAL.md §3.4) ----
  /** Ask player entity `target` for an exchange. */
  | { t: 'tradeRequest'; target: number }
  /** Answer the pending request of player entity `from` (from `tradeRequested`). */
  | { t: 'tradeRespond'; from: number; accept: boolean }
  /** Offer `count` (default: the whole stack) of the bag stack at `bag`. */
  | { t: 'tradeOffer'; bag: number; count?: number }
  /** Take back your own trade slot 0..TRADE_SLOTS-1. */
  | { t: 'tradeTake'; slot: number }
  /** Set your offered gold (the new amount, not a delta; 0..MAX_GOLD). */
  | { t: 'tradeGold'; amount: number }
  | { t: 'tradeLock' }
  | { t: 'tradeAccept' }
  | { t: 'tradeCancel' }
  // ---- wave 8: stalls (docs/SYSTEMS_SOCIAL.md §4.2) ----
  /** Open a stall (in 'modify' state) with `title` (0..STALL_TITLE_MAX code points; '' = the default title). */
  | { t: 'stallCreate'; title: string }
  /** List `count` of the bag stack at `bag` in stall slot 0..STALL_SLOTS-1 for `price` (1..STALL_PRICE_MAX) gold. */
  | { t: 'stallItem'; slot: number; bag: number; count: number; price: number }
  | { t: 'stallItemRemove'; slot: number }
  /** Change the stall title and/or greeting (at least one key). */
  | { t: 'stallText'; title?: string; greeting?: string }
  /** Open the stall for buyers (true) or go back to 'modify' (false). */
  | { t: 'stallOpen'; open: boolean }
  | { t: 'stallClose' }
  /** Visit the stall of player entity `owner`. */
  | { t: 'stallVisit'; owner: number }
  | { t: 'stallLeave' }
  /**
   * Buy listing `slot` of `owner`'s stall. The item the buyer saw (`code`, `count`, `plus`, `durability`, as in the
   * listing's ItemStack: plus absent = 0, durability absent = full) and `price` must match, else 'stall_changed' (S1, D47).
   */
  | { t: 'stallBuy'; owner: number; slot: number; code: string; count: number; plus?: number; durability?: number; price: number }
  // ---- wave 8: guilds (docs/SYSTEMS_SOCIAL.md §5.4) ----
  /** Create guild `name` (GUILD_NAME, else 'bad_name') at a Guild Manager NPC entity `npc`. */
  | { t: 'guildCreate'; npc: number; name: string }
  /** Master only, at a Guild Manager. */
  | { t: 'guildDisband'; npc: number }
  /** Invite the online character `name` (CHARACTER_NAME). */
  | { t: 'guildInvite'; name: string }
  /** Answer the pending invite of guild `guild` (from `guildInvited`). */
  | { t: 'guildRespond'; guild: number; accept: boolean }
  | { t: 'guildLeave' }
  /** Remove member `member` (characterId). */
  | { t: 'guildKick'; member: number }
  /** Master only: replace the rights of member `member` (unique GUILD_PERMS entries). */
  | { t: 'guildPerms'; member: number; perms: GuildPerm[] }
  /** Set member `member`'s title (0..GUILD_TITLE_MAX code points; '' clears it). */
  | { t: 'guildTitle'; member: number; title: string }
  /** Set the guild notice (0..GUILD_NOTICE_TITLE_MAX / 0..GUILD_NOTICE_MAX code points). */
  | { t: 'guildNotice'; title: string; text: string }
  /** Master only: hand the mastership to member `member` (characterId). */
  | { t: 'guildMaster'; member: number }
  // ---- wave 10: the jump (docs/MOVEMENT.md §4.2, §5; docs/WAVE_PLAN6.md §3.2). A GameplayRequest: one actionResult. ----
  /**
   * Jump in place (Space): viewers (the jumper too) get the server `jump`. Cosmetic: it never changes the position or
   * the move. Refused 'dead', 'mounted', 'stalling', 'cant_act' (stun, freeze, knockdown), 'busy' (a skill action or a
   * return-scroll cast) or 'cooldown' (JUMP_COOLDOWN_MS, accepted JUMP_COOLDOWN_SLACK_MS early). Allowed while moving,
   * in combat and in a trade. Stands a sitter up first.
   */
  | { t: 'jump' }
  // ---- Play the Boss (docs/PLAY_THE_BOSS.md §5.1; pilot.ts). GameplayRequests: one actionResult each. ----
  | PilotClientMessage

// ---- server -> client ---------------------------------------------------------------------------

export type ServerMessage =
  /**
   * `role` is a GM addition (absent from older servers = 'player'). `news` (docs/CHANGELOG_WINDOW.md): how many
   * "What's new" entries this account has not seen (absent = 0 or an older server); the client fetches them with
   * `GET /api/news` and shows them once it is in the world.
   */
  | { t: 'welcome'; account: string; server: ServerInfo; slots: number; role?: Role; news?: number }
  | { t: 'error'; code: ErrorCode; message: string; re?: ClientMessage['t'] }
  | { t: 'charList'; slots: number; characters: CharacterSummary[] }
  | { t: 'nameCheck'; name: string; available: boolean; reason?: string }
  | { t: 'charCreated'; character: CharacterSummary }
  | { t: 'charDeleted'; id: number }
  /** `role` is a GM addition (absent from older servers = 'player'). */
  | { t: 'worldEnter'; self: EntityState; world: WorldInfo; entities: EntityState[]; role?: Role }
  | { t: 'worldLeft' }
  | { t: 'spawn'; entity: EntityState }
  | { t: 'despawn'; id: number }
  | { t: 'move'; id: number; move: MoveState }
  | { t: 'stop'; id: number; pos: Vec3; yaw: number }
  /** Wave 3: channels 'whisper' (`to` = the recipient's name; echoed to the sender) and 'party' added. */
  | { t: 'chat'; channel: ChatChannel; fromId?: number; from?: string; to?: string; text: string }
  | { t: 'pong'; n: number; clientTime: number; serverTime: number }
  /**
   * GM addition: answer to a `gm` message or a slash command typed in chat. `cmd` echoes the
   * command (lower-cased). `message` is human-readable English (clients print it as a system line
   * and in the GM window); `data` carries structured results, e.g.
   * who: { players: GmPlayerInfo[] }, where: GmPlayerInfo, tp (no args): { presets: GmPreset[] },
   * help: { commands: { name, usage, about }[] }.
   */
  | { t: 'gmResult'; ok: boolean; cmd: string; message: string; data?: unknown }
  /** GM addition: server-wide announcement (GM `notice`), sent to every connected socket, lobby included. Show prominently. */
  | { t: 'notice'; text: string; from?: string }
  /**
   * GM addition: instant relocation of an entity (teleport, summon). Any move in progress is over;
   * the client snaps the entity to `pos` (y is a hint, snap to the ground) and cancels interpolation.
   * Sent to everyone who can see the entity, including its own client.
   */
  | { t: 'warp'; id: number; pos: Vec3; yaw: number }
  /**
   * GM addition: partial update of an entity already spawned on the client. Only the present fields
   * changed. `invisible` goes only to viewers that still see the entity (the GM itself and other GMs);
   * everyone else receives `despawn` when a GM turns invisible and `spawn` when it reappears.
   */
  | {
      t: 'entityUpdate'
      id: number
      level?: number
      name?: string
      invisible?: boolean
      /** Gameplay additions: HP changes outside combat (regen, potions, heal), death and revival. */
      hp?: number
      maxHp?: number
      state?: LifeState
      /** Wave 3: the [GM] tag (players); false clears it (role revoked by the owner CLI). */
      gm?: boolean
      /** Wave 7B: players sat down ('sit') or stood up ('stand' = EntityState.posture cleared). */
      posture?: Posture
      /** Wave 8: a player mounted horse `mount`; null = dismounted. */
      mount?: number | null
      /** Wave 8: a horse got rider `rider`; null = parked. */
      rider?: number | null
      /** Wave 8: Berserk started (time left, ms) or ended (0). */
      berserkMs?: number
      /** Wave 8: the stall title changed or a stall opened; '' = closed. */
      stall?: string
      /** Wave 8: the guild name changed; '' = none. */
      guild?: string
      /** Play the Boss: the body went into a trance (true) or woke up (false). */
      trance?: boolean
      /** Play the Boss: a player steers this mob now (true) or her own AI does again (false). */
      piloted?: boolean
      /** Play the Boss: a title was granted ('' = none). */
      honor?: string
      /** Storm (docs/WEATHER.md §12): the mob became storm-charged (true) or lost it (false). */
      charged?: boolean
    }
  /**
   * GM addition: this account's role changed while connected (`pnpm gm grant|revoke`; the server
   * notices within about a second). Show or hide the GM window accordingly.
   */
  | { t: 'role'; role: Role }
  // ---- gameplay additions (docs/PROTOCOL.md) ----
  /**
   * Answer to every gameplay request (attack .. shopSell, respawn, useSkill). `re` names the request.
   * ok = accepted (its effects arrive as their own messages); !ok = nothing changed, `reason` says why.
   */
  | { t: 'actionResult'; re: GameplayRequest; ok: boolean; reason?: ActionFailReason; message?: string }
  /**
   * One attack landing (sent to everyone who sees the attacker or the target). The attacker faces the target
   * and plays an attack clip; the client shows hit i at the i-th hit event of that clip. `hp` is the target's
   * HP after each hit; `killed` = the last hit killed it (the target's `state` is then 'dead').
   */
  /**
   * Wave 3: `skill` = the skill row code (basic attacks: the weapon's *_BASE_01 row); `instance` links the hits to
   * a `cast`; `at` = server ms the hits land (projectiles); `aoe` = a secondary target of an area skill.
   */
  | {
      t: 'combat'
      attacker: number
      target: number
      skill?: string
      hits: CombatHit[]
      killed?: boolean
      instance?: number
      at?: number
      aoe?: true
      /**
       * Lightning (docs/WEATHER.md §2.7, additive): damage without an attacker. `attacker` is then 0 (no entity), and
       * `strike` names the `strike` it came from. An older client drops both fields and shows the hits as usual.
       */
      cause?: HazardCause
      strike?: number
    }
  /** Own character's full stats: after worldEnter, after a level-up, after respawn. */
  | { t: 'stats'; stats: PlayerStats }
  /** Own character's changed stats (only the present fields). `gain` explains an EXP/SP increase. */
  | { t: 'statsDelta'; stats: Partial<PlayerStats>; gain?: StatGain }
  /** Someone visible (you included) reached a new level; play the level-up effect. */
  | { t: 'levelUp'; id: number; level: number }
  /** Own inventory, in full: after worldEnter and whenever the client may be out of sync. */
  | { t: 'inventory'; inventory: Inventory }
  /** Changed bag/equipment slots (item null = now empty) and the new gold total if it changed. */
  | { t: 'inventoryUpdate'; bag?: BagSlotUpdate[]; equip?: EquipSlotUpdate[]; gold?: number }
  /**
   * An entity's visible equipment changed (weapon/armour codes for drawing), sent to viewers. `plus` (weapon glow
   * addition): the +N of the slots that have one, as EntityState.equipPlus; absent = all +0. A change of +N alone
   * (alchemy, GM `plus`) is announced too.
   */
  | { t: 'appearance'; id: number; equip: Partial<Record<EquipSlot, string>>; plus?: Partial<Record<EquipSlot, number>> }
  // ---- wave 3: skills (docs/SKILLS.md §10.2) ----
  /**
   * Own skills, in full: enter-world after `inventory`. `skills` = the highest learned row per skill group;
   * `hotbar.length === HOTBAR_SLOTS`; `cooldowns` = skill groups still cooling down; `mouse` = the mouse quick slot
   * (MOUSE_SLOT; absent = empty, and from servers before it existed).
   */
  | {
      t: 'skills'
      masteries: Record<MasteryCode, number>
      skills: string[]
      hotbar: (HotbarEntry | null)[]
      cooldowns?: SkillCooldown[]
      mouse?: HotbarEntry
    }
  /** Changed masteries (new levels), newly learned rows (each replaces its group's lower row), changed hotbar slots. */
  | {
      t: 'skillsUpdate'
      masteries?: Partial<Record<MasteryCode, number>>
      learned?: string[]
      hotbar?: { slot: number; entry: HotbarEntry | null }[]
    }
  /** A skill action began (everyone who sees the caster `id`). Phases: prepare, then cast (release), then action. */
  | {
      t: 'cast'
      id: number
      skill: string
      instance: number
      target?: number
      instant?: boolean
      prepareMs: number
      castMs: number
      actionMs: number
      /**
       * Play the Boss (docs/PLAY_THE_BOSS.md §3.5): the clip type (ATTACK1, FIND, HELP, ...) of a server-built ability
       * whose `skill` (PILOT_*) no catalog knows; the client plays that clip.
       */
      clip?: string
    }
  /** A skill action closed early; a normal end needs no message. */
  | { t: 'castEnd'; id: number; instance: number; reason: CastEndReason }
  /** An effect started on entity `id` (viewers of the carrier). */
  | { t: 'effectAdd'; id: number; effect: EffectState }
  /** An effect of entity `id` ended. */
  | { t: 'effectRemove'; id: number; instance: number; reason?: EffectRemoveReason }
  // ---- wave 3: NPC dialogs, shops, storage, consumables (docs/SHOPS.md §7) ----
  /**
   * An NPC dialog opened (after npcTalk ok, once in range). The greeting comes from npcs.json (NpcDef.greeting); `lines`
   * (wave 11, docs/UNIQUES.md §3.10) are the quest files' conditional lines that hold now, shown after it (absent = none).
   */
  | { t: 'npcDialog'; npc: number; code: string; services: NpcService[]; lines?: string[] }
  /** The server closed the dialog (walked away, died, warped, NPC gone, or replaced by another npcTalk). */
  | { t: 'npcDialogClose'; npc: number; reason: NpcCloseReason }
  /** Account storage snapshot (after storageOpen ok). */
  | { t: 'storage'; storage: AccountStorage }
  /** Changed storage slots and the new storage gold if it changed (the bag side is the usual inventoryUpdate). */
  | { t: 'storageUpdate'; slots?: StorageSlotUpdate[]; gold?: number }
  /** This character's buyback list, in full (oldest first): after shopSell / shopBuyback, and after a shop NPC's npcDialog. */
  | { t: 'buyback'; entries: BuybackEntry[] }
  /** An item cooldown group was armed (own client only), e.g. { group: 'hp', readyInMs: 1000, totalMs: 1000 }. */
  | { t: 'itemCooldown'; group: string; readyInMs: number; totalMs: number }
  /** Someone started a timed item use (return scroll); viewers of `id`, the user included. */
  | { t: 'itemCast'; id: number; item: string; castMs: number }
  /** A timed item use ended; 'done' comes before the resulting warp. */
  | { t: 'itemCastEnd'; id: number; item: string; reason: ItemCastEndReason }
  // ---- wave 4: quests (docs/QUESTS.md §6.2) ----
  /** Own quest log, in full: enter-world after `skills`. `rev` = the quest catalog revision (GET /api/quests). */
  | { t: 'quests'; active: QuestProgress[]; done: QuestDoneEntry[]; rev: number }
  /** One quest changed. progress null = no longer active (completed/abandoned); `done` set on completion. */
  | { t: 'questUpdate'; quest: string; event: QuestEvent; progress: QuestProgress | null; done?: QuestDoneEntry; objective?: string }
  /** Authored content changed (GM editors): refetch /api/quests ('quests'), or expect spawn/despawn ('nests', 'npcs'). */
  | { t: 'contentChanged'; kind: ContentChangeKind; rev: number }
  // ---- wave 4: party (docs/QUESTS.md §4) ----
  /** Someone invited you; answer with partyRespond {inviter} before `expiresInMs`. `inviter` = their entity id. */
  | { t: 'partyInvited'; inviter: number; name: string; level: number; exp: PartyExpMode; items: PartyItemMode; expiresInMs: number }
  /** Full party state on any membership/leader/mode change (and enter-world when in one); null = you are not in a party. */
  | { t: 'party'; party: PartyState | null }
  /** Changed member vitals, at most every 500 ms (positions at 1 Hz). */
  | { t: 'partyVitals'; members: PartyVitals[] }
  /** A party event to show as a line ('joined' {name}, 'expired' invite to {name}, ...). */
  | { t: 'partyEvent'; event: PartyEventKind; name: string }
  // ---- wave 7B (docs/WAVE_PLAN2.md §3.1, docs/EFFECTS.md §4) ----
  /**
   * A consumable's visual for viewers of `id` (the user included), after a successful potion, herb, pill, vigor or
   * (wave 8) horse Recovery Kit use. `id` is the entity the effect plays on; `item` the ItemDef code (ITEM_*).
   * Not sent for return scrolls (itemCast covers them).
   */
  | { t: 'itemEffect'; id: number; item: string }
  /** An emote of `id`, to its viewers (the sender included). Reuses the client `t`, as `chat` does. */
  | { t: 'emote'; id: number; emote: EmoteKind }
  // ---- wave 8 (docs/WAVE_PLAN2.md §3.2.4). cast / castEnd / combat may also come from a mob id (mob skills). ----
  /** The fuse of bag item `item` started; the result arrives in `readyInMs` (0..30000). */
  | { t: 'alchemyStart'; item: number; readyInMs: number }
  /** The fuse ended: the item's code and its plus now (0..255). */
  | { t: 'alchemyResult'; item: number; code: string; outcome: AlchemyOutcome; plus: number }
  /** Player entity `from` asks you for an exchange; answer with tradeRespond before `expiresInMs`. */
  | { t: 'tradeRequested'; from: number; name: string; level: number; expiresInMs: number }
  /** The full exchange state, to both sides after every change. */
  | { t: 'trade'; trade: TradeState }
  /** The exchange (or the request) ended; `name` = the other player, `message` = why a commit failed. */
  | { t: 'tradeEnd'; reason: TradeEndReason; name?: string; message?: string }
  /** The stall you own or visit, in full after every change; null = you left it or it closed (`reason`). */
  | { t: 'stall'; stall: StallView | null; reason?: StallEndReason }
  /** Owner only: listing `slot` was bought. */
  | { t: 'stallSold'; slot: number; buyer: string; code: string; count: number; price: number }
  /** `from` invites you into guild `name` (id `guild`); answer with guildRespond before `expiresInMs`. */
  | { t: 'guildInvited'; guild: number; name: string; from: string; expiresInMs: number }
  /** Your guild, in full (enter-world when in one, and structural changes); null = you are in none. */
  | { t: 'guild'; guild: GuildState | null }
  /** One member added or changed (online/offline, level, perms, title, rank). */
  | { t: 'guildMember'; member: GuildMember }
  | { t: 'guildMemberRemoved'; characterId: number }
  /** A guild event to show as a line ('joined' {name}, 'notice', ...). */
  | { t: 'guildEvent'; event: GuildEventKind; name: string }
  // ---- wave 9 (docs/WAVE_PLAN3.md §3.2, §3.3) ----
  /** The world clock changed (a GM `time` command); to players in the world only, never periodic. */
  | { t: 'worldClock'; clock: WorldClockState }
  /** The weather changed (schedule or GM), a GM wind/wet override, or the 10-minute resync. */
  | { t: 'weather'; weather: WeatherSync }
  /** A lightning strike at server ms `at`, `distM` 100..3000 m away toward `bearing` (radians 0..2π, like windDir). */
  | {
      t: 'lightning'
      at: number
      distM: number
      bearing: number
      /**
       * Additive (docs/WEATHER.md §2.7): the id of the placed `strike` this flash belongs to, sent to each player with
       * its own distance and bearing, so an older client still flashes and thunders; a newer one draws the `strike`.
       */
      strike?: number
    }
  /**
   * A placed lightning strike (docs/WEATHER.md §2.7), to every player in the world when its telegraph starts (`sky`:
   * when it flashes). The bolt lands at `strike.at`; its damage arrives as `combat` messages with `cause: 'lightning'`.
   */
  | { t: 'strike'; strike: LightningStrike }
  /**
   * Storms (docs/WEATHER.md §12): the storm status, to a player entering the world and to every player in it when the
   * phase or an effect changes (at most once a second). An older client ignores it.
   */
  | { t: 'storm'; storm: StormStatus }
  /**
   * A storm-charged monster's hit arced (docs/WEATHER.md §12.4): from entity `from` (the player it hit) to entity `to`
   * (a player nearby) at server ms `at`, to the viewers of either. The damage arrives as `combat` with `cause: 'arc'`.
   */
  | { t: 'stormArc'; from: number; to: number; at: number; mob?: number }
  /**
   * A lightning tornado (docs/WEATHER.md §13): its state, to every player in the world when it is announced (the warning)
   * or changes (it lifts early), and to a player entering while one is up. An older client ignores it.
   */
  | { t: 'tornado'; tornado: TornadoState }
  /** The tornado `id` is gone (lifted away, or a GM removed it) at server ms `at`. */
  | { t: 'tornadoEnd'; id: number; at: number }
  /**
   * Entity `id` was moved without its say (docs/WEATHER.md §13), to its viewers right after the `move` that carries it
   * (an older client still sees a plain move): `pull` a drift toward a tornado (no walking clip), `throw` a flight from
   * `from` to `to` over `ms` from server ms `at` with its apex `peakM` above the line (spinning). The `stop` at the end
   * comes as usual.
   */
  | { t: 'displace'; id: number; kind: DisplaceKind; from: Vec3; to: Vec3; at: number; ms: number; peakM?: number; tornado?: number }
  // ---- wave 10 (docs/MOVEMENT.md §5, docs/WAVE_PLAN6.md §3.2) ----
  /**
   * Entity `id` jumped at server ms `at`; viewers (the jumper included) play JUMP, or JUMP_RUN while moving. Reuses the
   * client `t`, as `emote` does. A viewer receiving it later than JUMP_LATE_DROP_MS after `at` plays nothing.
   */
  | { t: 'jump'; id: number; at: number }
  // ---- wave 11 (docs/WAVE_PLAN7.md §3.1, docs/UNIQUES.md §3.3, §5.1) ----
  /**
   * A unique monster (a world boss) appeared or was defeated. World sockets only, every player in the world, at the
   * moment it happens; never in the lobby or on the character screens, and no late replay on login. The client builds
   * the sentence from i18n keys: `name` is the mob's English name (shown when the client has no name for `mob`),
   * `area` the zone name at the camp printed as is ("North-Tiger Mt."; absent when the camp has none). On `defeated`
   * only: `by` = the loot-owner group's top-damage member, `party` = that group is a party ("Mei's party has defeated
   * Tiger Girl!"); both absent on a kill nobody owns. The town reacts to `appeared` (a cosmetic 60 s alarm).
   */
  | { t: 'uniqueNotice'; event: UniqueNoticeEvent; mob: string; name: string; area?: string; by?: string; party?: boolean; roar?: boolean; at?: number }
  // ---- Play the Boss (docs/PLAY_THE_BOSS.md §5.2; pilot.ts) ----
  | PilotServerMessage

/**
 * `uniqueNotice.event` (wave 11). `roar` (H11-NL-5): on an appearance, true for the players within the unique's
 * `announce.roarRadiusM` of where she appeared; they also hear her own roar once (docs/UNIQUES.md §3.3). `at` (H11-DET-1):
 * server ms when she appeared, so every client starts the town's cosmetic alarm on the same second (absent: older
 * servers; the client uses its receipt).
 */
export type UniqueNoticeEvent = 'appeared' | 'defeated'
export const UNIQUE_NOTICE_EVENTS: readonly UniqueNoticeEvent[] = ['appeared', 'defeated']

/** Character name rule (SRO-like): 3–12 chars, letters/digits/underscore, must start with a letter. */
export const CHARACTER_NAME = /^[A-Za-z][A-Za-z0-9_]{2,11}$/
export const MAX_CHARACTER_SLOTS = 4
export const MAX_CHAT_LENGTH = 100

// ---- additions (additive, protocol v1) ----------------------------------------------------------

/** POST /api/register responds 201 with the same body as login (the new account is logged in). */
export type ApiRegisterResponse = ApiLoginResponse

/** GET /api/servers */
export type ApiServersResponse = ServerInfo[]

/** Account name rule: 3–16 chars, letters/digits/underscore. Matched case-insensitively for uniqueness. */
export const ACCOUNT_NAME = /^[A-Za-z0-9_]{3,16}$/
export const PASSWORD_MIN_LENGTH = 6
export const PASSWORD_MAX_LENGTH = 64

export const STARTER_WEAPONS: readonly StarterWeapon[] = ['sword', 'blade', 'spear', 'glaive', 'bow']

/** Largest client frame the server accepts (UTF-8 bytes); larger frames get `error bad_request`. */
export const MAX_CLIENT_MESSAGE_BYTES = 1024

/**
 * WebSocket close codes the server uses (4000–4999 are application codes).
 * A kicked/refused socket first receives an `error` frame explaining why, when possible.
 */
export const CLOSE_CODE = {
  /** The same account logged in from another connection. */
  replaced: 4000,
  /** hello token invalid or expired. */
  unauthorized: 4001,
  /** hello.version !== PROTOCOL_VERSION. */
  versionMismatch: 4002,
  /** No valid hello within 5 s. */
  helloTimeout: 4003,
  /** Too many malformed or rate-limited frames. */
  abuse: 4008,
  /** Server is shutting down. */
  shutdown: 4009,
  /** GM addition: kicked by a Game Master (`kick`); the socket first gets a system `chat` line with the reason. */
  kicked: 4010,
} as const

// ---- GM (Game Master) additions (additive, protocol v1) -----------------------------------------

export const ROLES: readonly Role[] = ['player', 'gm', 'admin']
/** gm.cmd rule (after lower-casing, for slash commands typed in chat). */
export const GM_COMMAND = /^[a-z]{1,16}$/
export const GM_MAX_ARGS = 8
/** Code points per gm arg. */
export const GM_MAX_ARG_LENGTH = 100
/** Highest level `setlevel` accepts unless the server sets LEVEL_CAP. */
export const DEFAULT_LEVEL_CAP = 20

/** True for roles allowed to run GM commands. */
export function isStaff(role: Role | undefined): boolean {
  return role === 'gm' || role === 'admin'
}

/** One online player in gmResult data (`who`, `where`). */
export interface GmPlayerInfo {
  /** runtime entity id */
  id: number
  name: string
  account: string
  role: Role
  level: number
  pos: Vec3
  /** Silkroad region id (z << 8 | x), or null when the world manifest gives no region origin. */
  region: number | null
  /** Region grid coordinates [x, z], or null. */
  regionXZ: [number, number] | null
  invisible: boolean
  /** Runtime move-speed multiplier (GM `speed`). */
  speed: number
}

/**
 * A named teleport target (`tp <name>`): the world spawn, the places the world manifest lists and the server's
 * content/places.json (docs/PLAYTEST.md "Teleport places").
 */
export interface GmPreset {
  name: string
  x: number
  z: number
  /** The GM window's group: town, fields, coast, bosses or other (older servers send none). */
  group?: string
  /** Other names `tp` accepts for it. */
  aliases?: string[]
}

/**
 * Yaw convention: radians about +Y; yaw 0 faces +Z (glTF front), so a move along (dx, dz)
 * has yaw = atan2(dx, dz).
 */
export function yawTowards(dx: number, dz: number): number {
  return Math.atan2(dx, dz)
}

/**
 * The 26 Chinese player models of vSRO 1.188 (refobjchar ids 1907-1932). A model the data export
 * does not explicitly flag as selectable is offered at character creation only if it is listed here.
 */
export const PLAYER_MODELS_CH: readonly string[] = [
  'CHAR_CH_MAN_ADVENTURER', 'CHAR_CH_MAN_BOGY', 'CHAR_CH_MAN_FIGHTER', 'CHAR_CH_MAN_MERCHANT', 'CHAR_CH_MAN_MONK',
  'CHAR_CH_MAN_MONKEY', 'CHAR_CH_MAN_NECROMANCER', 'CHAR_CH_MAN_NOBLEBOY', 'CHAR_CH_MAN_PERFORMER', 'CHAR_CH_MAN_PRIEST',
  'CHAR_CH_MAN_SCHOLAR', 'CHAR_CH_MAN_TATTOO', 'CHAR_CH_MAN_WARRIOR',
  'CHAR_CH_WOMAN_ADVENTURER', 'CHAR_CH_WOMAN_ASSASSIN', 'CHAR_CH_WOMAN_BOGY', 'CHAR_CH_WOMAN_FIGHTER', 'CHAR_CH_WOMAN_FOX',
  'CHAR_CH_WOMAN_KANGSI', 'CHAR_CH_WOMAN_KISAENG', 'CHAR_CH_WOMAN_MERCHANT', 'CHAR_CH_WOMAN_NECROMENCERB',
  'CHAR_CH_WOMAN_NECROMENCERW', 'CHAR_CH_WOMAN_NOBLEGIRL', 'CHAR_CH_WOMAN_SCHOLAR', 'CHAR_CH_WOMAN_WARRIOR',
]

// ---- gameplay additions (additive, protocol v1; docs/PROTOCOL.md) ----------------------------------

/** Entity kinds. Older servers send only 'player'. Wave 8: 'cos' (a horse; docs/SYSTEMS_COMBAT.md §1). */
export type EntityKind = 'player' | 'mob' | 'npc' | 'item' | 'cos'
export const ENTITY_KINDS: readonly EntityKind[] = ['player', 'mob', 'npc', 'item', 'cos']

export type LifeState = 'alive' | 'dead'
export const LIFE_STATES: readonly LifeState[] = ['alive', 'dead']

/** Client requests answered by `actionResult`. */
export type GameplayRequest =
  | 'attack' | 'stopAction' | 'useSkill' | 'pickup' | 'respawn' | 'statUp'
  | 'itemMove' | 'itemSplit' | 'itemEquip' | 'itemUnequip' | 'itemUse' | 'itemDrop'
  | 'shopBuy' | 'shopSell'
  // wave 3
  | 'skillLearn' | 'masteryUp' | 'buffCancel' | 'hotbarSet'
  | 'npcTalk' | 'npcClose' | 'storageOpen' | 'storageDeposit' | 'storageWithdraw' | 'storageMove' | 'storageGold' | 'shopBuyback'
  // wave 4
  | 'questAccept' | 'questTurnIn' | 'questAbandon' | 'questTalk' | 'questUseItem'
  | 'partyInvite' | 'partyRespond' | 'partyLeave' | 'partyKick' | 'partyLeader' | 'partySettings'
  // wave 7B
  | 'sit' | 'emote'
  // wave 8: combat and items
  | 'mountRide' | 'mountDismount' | 'mountDismiss' | 'repair' | 'alchemyReinforce' | 'alchemyCancel' | 'berserk'
  // wave 8: trade, stalls, guilds
  | 'tradeRequest' | 'tradeRespond' | 'tradeOffer' | 'tradeTake' | 'tradeGold' | 'tradeLock' | 'tradeAccept' | 'tradeCancel'
  | 'stallCreate' | 'stallItem' | 'stallItemRemove' | 'stallText' | 'stallOpen' | 'stallClose' | 'stallVisit' | 'stallLeave' | 'stallBuy'
  | 'guildCreate' | 'guildDisband' | 'guildInvite' | 'guildRespond' | 'guildLeave' | 'guildKick' | 'guildPerms' | 'guildTitle'
  | 'guildNotice' | 'guildMaster'
  // wave 10: the jump (docs/MOVEMENT.md §5)
  | 'jump'
  // Play the Boss (docs/PLAY_THE_BOSS.md §5.1)
  | PilotRequest

/** Wave 8 combat and item requests (docs/SYSTEMS_COMBAT.md §7.2). */
export const COMBAT_W8_REQUESTS: readonly GameplayRequest[] = ['mountRide', 'mountDismount', 'mountDismiss', 'repair', 'alchemyReinforce', 'alchemyCancel', 'berserk']
export const TRADE_REQUESTS: readonly GameplayRequest[] = ['tradeRequest', 'tradeRespond', 'tradeOffer', 'tradeTake', 'tradeGold', 'tradeLock', 'tradeAccept', 'tradeCancel']
export const STALL_REQUESTS: readonly GameplayRequest[] = ['stallCreate', 'stallItem', 'stallItemRemove', 'stallText', 'stallOpen', 'stallClose', 'stallVisit', 'stallLeave', 'stallBuy']
export const GUILD_REQUESTS: readonly GameplayRequest[] = [
  'guildCreate', 'guildDisband', 'guildInvite', 'guildRespond', 'guildLeave', 'guildKick', 'guildPerms', 'guildTitle', 'guildNotice', 'guildMaster',
]

export const GAMEPLAY_REQUESTS: readonly GameplayRequest[] = [
  'attack', 'stopAction', 'useSkill', 'pickup', 'respawn', 'statUp',
  'itemMove', 'itemSplit', 'itemEquip', 'itemUnequip', 'itemUse', 'itemDrop',
  'shopBuy', 'shopSell',
  'skillLearn', 'masteryUp', 'buffCancel', 'hotbarSet',
  'npcTalk', 'npcClose', 'storageOpen', 'storageDeposit', 'storageWithdraw', 'storageMove', 'storageGold', 'shopBuyback',
  'questAccept', 'questTurnIn', 'questAbandon', 'questTalk', 'questUseItem',
  'partyInvite', 'partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings',
  'sit', 'emote',
  ...COMBAT_W8_REQUESTS,
  ...TRADE_REQUESTS,
  ...STALL_REQUESTS,
  ...GUILD_REQUESTS,
  'jump',
  ...PILOT_REQUESTS,
]

/** Why a gameplay request was refused. Clients show a short localized line per reason. */
export type ActionFailReason =
  /** The target/item/NPC/slot content does not exist (or is not visible to you). */
  | 'not_found'
  /** Target cannot be attacked (NPC, yourself, a player without PvP, an invisible GM). */
  | 'invalid_target'
  /** Already dead. */
  | 'target_dead'
  /** You are dead (only `respawn` is accepted). */
  | 'dead'
  /** `respawn` while alive. */
  | 'not_dead'
  /** Out of interaction range (shops); attack and pickup walk into range instead. */
  | 'too_far'
  /** Unreachable (no path / outside the world). */
  | 'unreachable'
  /** Ground item owned by someone else for now. */
  | 'not_owner'
  /** No free bag slot / stack full. */
  | 'inventory_full'
  /** Slot index or equip slot does not fit the request (empty source, wrong slot kind, occupied target...). */
  | 'invalid_slot'
  /** Count out of range for the stack. */
  | 'invalid_count'
  /** Level, gender, race or two-handed/shield rule not met. */
  | 'requirements'
  /** A garment piece with protector or armour pieces worn, or the other way round (content.ts armorClassesClash). */
  | 'armor_mix'
  /** Item cannot be used / sold / dropped. */
  | 'not_usable'
  /** Cooldown still running (e.g. potions). */
  | 'cooldown'
  /** Not enough free stat points. */
  | 'no_points'
  | 'not_enough_gold'
  /** In a safe zone (town) where this is not allowed (e.g. attacking). */
  | 'safe_zone'
  /** Declared but not built yet. Kept for older clients; useSkill no longer returns it once skills run. */
  | 'not_implemented'
  /** Per-type rate limit (CLIENT_RATE_LIMITS). */
  | 'rate_limited'
  // ---- wave 3: skills (docs/SKILLS.md §10.2) ----
  /** The skill row (or its line) is not learned. */
  | 'not_learned'
  | 'not_enough_mp'
  /** The equipped weapon (or shield) does not fit the skill. */
  | 'wrong_weapon'
  /** No ammunition in the bag (bow skills when SKILL_AMMO is on). */
  | 'no_ammo'
  /** Stunned, frozen, knocked down or otherwise unable to act. */
  | 'cant_act'
  /** Not enough skill points. */
  | 'no_sp'
  /** Mastery or skill level cap reached (mastery total, or the character level). */
  | 'mastery_cap'
  // ---- wave 3: shops, storage, consumables (docs/SHOPS.md §7) ----
  /** Gold would pass MAX_GOLD (sale, storage withdrawal). */
  | 'gold_limit'
  /** No room in storage. */
  | 'storage_full'
  /** Another timed action is running (item cast, skill action). */
  | 'busy'
  // ---- wave 4: quests (docs/QUESTS.md §6.3) ----
  /** MAX_ACTIVE_QUESTS quests are active already. */
  | 'quest_log_full'
  /** The quest is active already. */
  | 'quest_active'
  /** Done, and not repeatable (repeatables not yet reset answer 'cooldown'). */
  | 'quest_done'
  /** Not ready to turn in, or the items to hand over are missing. */
  | 'not_complete'
  /** The quest has a reward choice and none was sent. */
  | 'choice_required'
  /** Not inside the objective's location. */
  | 'wrong_place'
  // ---- wave 4: party (docs/QUESTS.md §4.1) ----
  | 'not_in_party'
  | 'not_leader'
  | 'party_full'
  /** The target (or you) is in a party already. */
  | 'in_party'
  /** No pending invite from that player (expired or never sent). */
  | 'no_invite'
  // ---- wave 8: combat and items (docs/SYSTEMS_COMBAT.md §7.4) ----
  /** Not allowed while riding a horse. */
  | 'mounted'
  | 'not_mounted'
  /** Dismount while moving. */
  | 'moving'
  /** Too soon after combat (horse summon/ride: COS_COMBAT_LOCK_MS; stalls and sitting: 5 s). */
  | 'in_combat'
  /** A horse is already summoned. */
  | 'cos_active'
  /** A broken weapon or item (durability 0). */
  | 'broken'
  | 'nothing_to_repair'
  /** The elixir or Lucky Powder does not fit the equipment. */
  | 'alchemy_mismatch'
  /** The item is at ALCHEMY_MAX_PLUS. */
  | 'max_plus'
  /** The Berserk gauge is not full. */
  | 'berserk_not_ready'
  /** Already in Berserk (or: not allowed while in Berserk). */
  | 'berserk_active'
  // ---- wave 8: trade, stalls, guilds (docs/SYSTEMS_SOCIAL.md §2.2) ----
  /** You (or the other player) have an exchange open. */
  | 'trading'
  /** You run a stall (the inventory is locked), or the other player does. */
  | 'stalling'
  /** The listing differs from what the buyer saw (code, count or price). */
  | 'stall_changed'
  | 'stall_full'
  /** No such stall, or it is being modified. */
  | 'stall_closed'
  | 'not_in_guild'
  /** You, or the invitee, are in a guild already. */
  | 'in_guild'
  | 'no_permission'
  | 'guild_full'
  /** A live guild has that name (a separate union from ErrorCode 'name_taken'). */
  | 'name_taken'
  /** The guild name fails GUILD_NAME, or is reserved. */
  | 'bad_name'
  // ---- Play the Boss (docs/PLAY_THE_BOSS.md §5.1) ----
  | PilotFailReason

export const ACTION_FAIL_REASONS: readonly ActionFailReason[] = [
  'not_found', 'invalid_target', 'target_dead', 'dead', 'not_dead', 'too_far', 'unreachable', 'not_owner',
  'inventory_full', 'invalid_slot', 'invalid_count', 'requirements', 'not_usable', 'cooldown', 'no_points',
  'not_enough_gold', 'safe_zone', 'not_implemented', 'rate_limited',
  'not_learned', 'not_enough_mp', 'wrong_weapon', 'no_ammo', 'cant_act', 'no_sp', 'mastery_cap',
  'gold_limit', 'storage_full', 'busy',
  'quest_log_full', 'quest_active', 'quest_done', 'not_complete', 'choice_required', 'wrong_place',
  'not_in_party', 'not_leader', 'party_full', 'in_party', 'no_invite',
  'mounted', 'not_mounted', 'moving', 'in_combat', 'cos_active', 'broken', 'nothing_to_repair', 'alchemy_mismatch', 'max_plus',
  'berserk_not_ready', 'berserk_active',
  'trading', 'stalling', 'stall_changed', 'stall_full', 'stall_closed', 'not_in_guild', 'in_guild', 'no_permission', 'guild_full',
  'name_taken', 'bad_name',
  'armor_mix',
  ...PILOT_FAIL_REASONS,
]

export type HitOutcome = 'hit' | 'crit' | 'miss' | 'block'
export const HIT_OUTCOMES: readonly HitOutcome[] = ['hit', 'crit', 'miss', 'block']

/** One hit of an attack. `damage` is 0 for miss/block; `hp` is the target's HP after this hit. */
export interface CombatHit {
  outcome: HitOutcome
  damage: number
  hp: number
  /** Wave 3: abnormal state or crowd control this hit applied. */
  status?: SkillStatusKind
  /** Wave 3: this hit knocked the target down. */
  down?: true
  /** Wave 3: knockback landing point of the target. */
  pos?: Vec3
  /** Wave 8: the attacker was in Berserk (the HWAN hit effect and sound). */
  hwan?: true
}

/** Own character's stats (derived values computed by the server from level, STR/INT and equipment). */
export interface PlayerStats {
  level: number
  /** EXP into the current level, and the EXP needed for the next (levels.json `exp`); 0 at the level cap. */
  exp: number
  expToNext: number
  /** Skill points, and SP-EXP towards the next point (CHARACTER_RULES.spExpPerSp). */
  sp: number
  spExp: number
  hp: number
  maxHp: number
  mp: number
  maxMp: number
  str: number
  int: number
  /** Free stat points (statUp). */
  statPoints: number
  gold: number
  physAttack: [number, number]
  magAttack: [number, number]
  physDefence: number
  magDefence: number
  hitRate: number
  parryRate: number
  /**
   * Wave 8: Berserk points 0..HWAN_MAX. Wave-8 servers always send it in a full `stats` (docs/WAVE_PLAN2.md D33);
   * absent (older servers) = 0. The parsers keep it (PLAYER_STAT_OPTIONAL_KEYS).
   */
  hwan?: number
}

/**
 * Optional PlayerStats keys: parsed and kept when present, never required. `hwan` is kept out of PLAYER_STAT_KEYS so
 * a full `stats` from an older server still parses (D33's "the server always sends it" is Gameplay.stats' rule).
 */
export const PLAYER_STAT_OPTIONAL_KEYS: readonly (keyof PlayerStats)[] = ['hwan']

export const PLAYER_STAT_KEYS: readonly (keyof PlayerStats)[] = [
  'level', 'exp', 'expToNext', 'sp', 'spExp', 'hp', 'maxHp', 'mp', 'maxMp', 'str', 'int', 'statPoints', 'gold',
  'physAttack', 'magAttack', 'physDefence', 'magDefence', 'hitRate', 'parryRate',
]

/** Why EXP/SP went up (floating "+EXP" text). */
export interface StatGain {
  exp: number
  spExp: number
  /** Entity id of the killed mob, if any. */
  from?: number
  /** Wave 4: the EXP came from turning in this quest (quest id). */
  quest?: string
}

/** Own inventory. `bag.length === bagSize`; null = empty slot. */
export interface Inventory {
  bagSize: number
  bag: (ItemStack | null)[]
  equip: Partial<Record<EquipSlot, ItemStack>>
  gold: number
}

export interface BagSlotUpdate {
  slot: number
  item: ItemStack | null
}

export interface EquipSlotUpdate {
  slot: EquipSlot
  item: ItemStack | null
}

/** Bag slots a character can have (CHARACTER_RULES.bagSize is the default 48). */
export const MAX_BAG_SIZE = 96
/** Largest stack/count any request may name. */
export const MAX_ITEM_COUNT = 10_000
/** Most stat points one statUp may spend. */
export const MAX_STAT_POINTS_PER_REQUEST = 1000
/** Most hits one combat message carries. */
export const MAX_COMBAT_HITS = 16
/** Metres: a player picks up a ground item within this distance (else walks there first). */
export const PICKUP_RANGE = 2
/** Metres: shops and other NPC services work within this distance (centre to centre). */
export const NPC_INTERACT_RANGE = 8
/** Ground items: owner-only window and lifetime, ms (server defaults; the entity carries the real times). */
export const ITEM_OWNER_MS = 30_000
export const ITEM_EXPIRE_MS = 120_000

/**
 * Per-connection rate limits the server enforces per request type, on top of the global 20 msg/s budget.
 * Beyond it the request is answered with actionResult reason 'rate_limited' and counts as a strike.
 */
export const CLIENT_RATE_LIMITS: Readonly<Partial<Record<ClientMessage['t'], { perSecond: number; burst: number }>>> = {
  attack: { perSecond: 5, burst: 10 },
  stopAction: { perSecond: 5, burst: 10 },
  useSkill: { perSecond: 5, burst: 10 },
  pickup: { perSecond: 5, burst: 10 },
  respawn: { perSecond: 1, burst: 3 },
  statUp: { perSecond: 5, burst: 20 },
  itemMove: { perSecond: 10, burst: 20 },
  itemSplit: { perSecond: 10, burst: 20 },
  itemEquip: { perSecond: 5, burst: 10 },
  itemUnequip: { perSecond: 5, burst: 10 },
  itemUse: { perSecond: 5, burst: 10 },
  itemDrop: { perSecond: 5, burst: 10 },
  shopBuy: { perSecond: 5, burst: 10 },
  shopSell: { perSecond: 5, burst: 10 },
  // wave 3 (docs/WAVE_PLAN.md §2.1)
  skillLearn: { perSecond: 5, burst: 10 },
  masteryUp: { perSecond: 5, burst: 10 },
  buffCancel: { perSecond: 5, burst: 10 },
  hotbarSet: { perSecond: 10, burst: 20 },
  npcTalk: { perSecond: 2, burst: 5 },
  npcClose: { perSecond: 5, burst: 10 },
  storageOpen: { perSecond: 2, burst: 5 },
  storageDeposit: { perSecond: 10, burst: 20 },
  storageWithdraw: { perSecond: 10, burst: 20 },
  storageMove: { perSecond: 10, burst: 20 },
  storageGold: { perSecond: 5, burst: 10 },
  shopBuyback: { perSecond: 5, burst: 10 },
  // wave 4 (docs/WAVE_PLAN.md §2.2)
  questAccept: { perSecond: 5, burst: 10 },
  questTurnIn: { perSecond: 5, burst: 10 },
  questTalk: { perSecond: 5, burst: 10 },
  questAbandon: { perSecond: 2, burst: 5 },
  questUseItem: { perSecond: 2, burst: 5 },
  partyInvite: { perSecond: 1, burst: 3 },
  partyLeave: { perSecond: 1, burst: 3 },
  partyRespond: { perSecond: 2, burst: 5 },
  partyKick: { perSecond: 2, burst: 5 },
  partyLeader: { perSecond: 2, burst: 5 },
  partySettings: { perSecond: 2, burst: 5 },
  // wave 7B (docs/WAVE_PLAN2.md §3.5)
  sit: { perSecond: 2, burst: 4 },
  emote: { perSecond: 1, burst: 3 },
  // wave 8 (docs/WAVE_PLAN2.md §3.5); guild and stall chat pay the chat budget
  mountRide: { perSecond: 2, burst: 5 },
  mountDismount: { perSecond: 2, burst: 5 },
  mountDismiss: { perSecond: 2, burst: 5 },
  repair: { perSecond: 2, burst: 5 },
  alchemyReinforce: { perSecond: 2, burst: 5 },
  alchemyCancel: { perSecond: 2, burst: 5 },
  berserk: { perSecond: 2, burst: 5 },
  tradeRequest: { perSecond: 1, burst: 3 },
  stallCreate: { perSecond: 1, burst: 3 },
  stallClose: { perSecond: 1, burst: 3 },
  guildCreate: { perSecond: 1, burst: 3 },
  guildDisband: { perSecond: 1, burst: 3 },
  guildInvite: { perSecond: 1, burst: 3 },
  guildLeave: { perSecond: 1, burst: 3 },
  guildNotice: { perSecond: 1, burst: 3 },
  guildMaster: { perSecond: 1, burst: 3 },
  tradeRespond: { perSecond: 2, burst: 5 },
  tradeLock: { perSecond: 2, burst: 5 },
  tradeAccept: { perSecond: 2, burst: 5 },
  tradeCancel: { perSecond: 2, burst: 5 },
  stallText: { perSecond: 2, burst: 5 },
  stallOpen: { perSecond: 2, burst: 5 },
  stallVisit: { perSecond: 2, burst: 5 },
  stallLeave: { perSecond: 2, burst: 5 },
  guildRespond: { perSecond: 2, burst: 5 },
  guildKick: { perSecond: 2, burst: 5 },
  guildPerms: { perSecond: 2, burst: 5 },
  guildTitle: { perSecond: 2, burst: 5 },
  tradeGold: { perSecond: 5, burst: 10 },
  stallBuy: { perSecond: 5, burst: 10 },
  tradeOffer: { perSecond: 10, burst: 20 },
  tradeTake: { perSecond: 10, burst: 20 },
  stallItem: { perSecond: 10, burst: 20 },
  stallItemRemove: { perSecond: 10, burst: 20 },
  // wave 10 (docs/MOVEMENT.md §4.2): over budget = 'rate_limited'; the 1 s cooldown and the client gate are tighter
  jump: { perSecond: 2, burst: 3 },
  // Play the Boss (docs/PLAY_THE_BOSS.md §5.1)
  ...PILOT_RATE_LIMITS,
}

/** Narrows an entity to a player (which always carries `weapon`). */
export function isPlayerEntity(e: EntityState): e is EntityState & { kind: 'player'; weapon: StarterWeapon } {
  return e.kind === 'player' && e.weapon !== undefined
}

/** Starter clothing choice at creation (original "Cloth" row): garment, protector or armour default set. */
export type StarterOutfit = 'clothes' | 'light' | 'heavy'
export const STARTER_OUTFITS: readonly StarterOutfit[] = ['clothes', 'light', 'heavy']

/** Character creation Height/Volume choices (original client: 5 steps each, default the middle). */
export const APPEARANCE_STEPS = 5
export const DEFAULT_HEIGHT = 2
export const DEFAULT_VOLUME = 2
/** Uniform render scale for a Height choice h (0..4): 0.94, 0.97, 1.00, 1.03, 1.06. docs/CHARACTER_SCALE.md */
export function heightScale(h: number | undefined): number {
  const v = Math.min(APPEARANCE_STEPS - 1, Math.max(0, Math.round(h ?? DEFAULT_HEIGHT)))
  return 0.94 + 0.03 * v
}

// ---- wave 3 additions (additive, protocol v1; docs/WAVE_PLAN.md §2.1) -----------------------------

/** Most gold a character (bag) or an account storage can hold. (Moved from apps/server/src/inventory.ts.) */
export const MAX_GOLD = 9_999_999_999
/** Hotbar slots: 4 pages x 10 (keys 1-0, pages F1-F4). */
export const HOTBAR_SLOTS = 40
/**
 * The mouse quick slot (retail GDR_TMPQS_0, the underbar's "M" frame), used only by the middle mouse button: `hotbarSet`
 * and `skillsUpdate.hotbar` address it as this slot number; the `skills` snapshot carries it as `mouse`.
 */
export const MOUSE_SLOT = HOTBAR_SLOTS
/** Most effects one entity carries on the wire (EntityState.effects). */
export const MAX_EFFECTS_PER_ENTITY = 32
/** Storage slots of a new account, and the most the protocol allows. */
export const STORAGE_SIZE_DEFAULT = 150
export const MAX_STORAGE_SIZE = 180
/** Recent sales kept for buyback per character. */
export const BUYBACK_SLOTS = 5
/** Wave 11 (lane U-Q): at most this many conditional greeting lines in one npcDialog, each at most this long. */
export const MAX_NPC_DIALOG_LINES = 8
export const MAX_NPC_DIALOG_LINE = 300

/** Metres: npcTalk walks the player to this distance before the dialog opens (services work up to NPC_INTERACT_RANGE). */
export const NPC_APPROACH_RANGE = 3

/** The seven Chinese masteries (masteries.json `code`). */
export type MasteryCode = 'BICHEON' | 'HEUKSAL' | 'PACHEON' | 'COLD' | 'LIGHTNING' | 'FIRE' | 'FORCE'
export const MASTERY_CODES: readonly MasteryCode[] = ['BICHEON', 'HEUKSAL', 'PACHEON', 'COLD', 'LIGHTNING', 'FIRE', 'FORCE']

// ---- skills (docs/SKILLS.md §10.2) ----

/** One hotbar slot: a skill row code, or a consumable item code (pressing it uses the lowest bag slot holding it). */
export interface HotbarEntry {
  kind: 'skill' | 'item'
  code: string
}

/** Abnormal states and crowd control (the skills.json `statuses[].status` values). */
export type SkillStatusKind = 'freeze' | 'frostbite' | 'shock' | 'burn' | 'poison' | 'zombie' | 'darkness' | 'stun' | 'knockdown' | 'knockback'
export const SKILL_STATUS_KINDS: readonly SkillStatusKind[] = ['freeze', 'frostbite', 'shock', 'burn', 'poison', 'zombie', 'darkness', 'stun', 'knockdown', 'knockback']

/** One effect on an entity: a buff, debuff, imbue or toggle (`skill`), or an abnormal state / crowd control (`status`). */
export interface EffectState {
  /** Unique per carrier while the effect lasts (effectRemove names it). */
  instance: number
  /** Source skill row code (icon, ACT_L effects). */
  skill?: string
  status?: SkillStatusKind
  level?: number
  /** Time left, 0..86,400,000 ms; 0 = until cancelled (toggles). Passives are never sent. */
  remainingMs: number
  /** Caster entity id. */
  source?: number
}

export type CastEndReason = 'interrupted' | 'cancelled' | 'target_lost'
export const CAST_END_REASONS: readonly CastEndReason[] = ['interrupted', 'cancelled', 'target_lost']

export type EffectRemoveReason = 'expired' | 'replaced' | 'cancelled' | 'cured' | 'death'
export const EFFECT_REMOVE_REASONS: readonly EffectRemoveReason[] = ['expired', 'replaced', 'cancelled', 'cured', 'death']

/** A skill group still cooling down (skills.json `group`). */
export interface SkillCooldown {
  group: string
  readyInMs: number
}

// ---- NPC / shop / storage / consumables (docs/SHOPS.md §7) ----

/**
 * What an NPC dialog offers; the server decides per NPC. Wave 8: 'repair' (NpcDef.roles; the client shows it as the
 * shop window's Repair buttons, not as a dialog option) and 'guild' (GUILD_MANAGER_NPCS).
 */
export type NpcService = 'shop' | 'storage' | 'repair' | 'quest' | 'guild'
export const NPC_SERVICES: readonly NpcService[] = ['shop', 'storage', 'repair', 'quest', 'guild']

/** Why a dialog closed without the client asking ('closed' = replaced by another npcTalk). */
export type NpcCloseReason = 'closed' | 'too_far' | 'dead' | 'warp' | 'gone'
export const NPC_CLOSE_REASONS: readonly NpcCloseReason[] = ['closed', 'too_far', 'dead', 'warp', 'gone']

export type ItemCastEndReason = 'done' | 'cancelled' | 'interrupted'
export const ITEM_CAST_END_REASONS: readonly ItemCastEndReason[] = ['done', 'cancelled', 'interrupted']

export type StorageGoldDir = 'deposit' | 'withdraw'
export const STORAGE_GOLD_DIRS: readonly StorageGoldDir[] = ['deposit', 'withdraw']

/**
 * Account storage, in full (after storageOpen). `slots.length === size`; null = empty.
 * Not named `Storage`: that would shadow the DOM `Storage` type (localStorage) in client modules.
 */
export interface AccountStorage {
  size: number
  slots: (ItemStack | null)[]
  gold: number
}

export interface StorageSlotUpdate {
  slot: number
  item: ItemStack | null
}

/** One recent sale that can be bought back, oldest first. `price` = what the sale paid. */
export interface BuybackEntry {
  item: ItemStack
  price: number
}

// ---- chat (whisper + party channel; docs/WAVE_PLAN.md decision 28) ----

/** Server chat channels. Wave 8: 'guild', 'stall'. */
export type ChatChannel = 'local' | 'system' | 'whisper' | 'party' | 'guild' | 'stall'
export const CHAT_CHANNELS: readonly ChatChannel[] = ['local', 'system', 'whisper', 'party', 'guild', 'stall']
/** Channels a client may name in `chat.channel` (absent = 'local'). Wave 8: 'guild', 'stall'. */
export type ChatSendChannel = 'local' | 'party' | 'guild' | 'stall'
export const CHAT_SEND_CHANNELS: readonly ChatSendChannel[] = ['local', 'party', 'guild', 'stall']

// ---- wave 4 additions (additive, protocol v1; docs/WAVE_PLAN.md §2.2, docs/QUESTS.md §6.2) ------------

// ---- quests (content types and their validator: quests.ts) ----

export type QuestStatus = 'active' | 'ready'
export const QUEST_STATUSES: readonly QuestStatus[] = ['active', 'ready']

/** One active quest of the own log. */
export interface QuestProgress {
  quest: string
  /** QuestDef.rev the counts were made for. */
  rev: number
  status: QuestStatus
  /** objective id -> count (collect: quest items held; talk/reach/useItem: 0 or 1). */
  counts: Record<string, number>
  /** This quest's quest items. */
  items: { code: string; count: number }[]
  acceptedAt: number
  /** Server ms an encounter of this quest despawns, while one lives. */
  encounterUntil?: number
}

export interface QuestDoneEntry {
  quest: string
  times: number
  lastAt: number
  /** Repeatables: server ms it can be taken again. */
  availableAt?: number
}

export type QuestEvent = 'accepted' | 'progress' | 'objective' | 'ready' | 'completed' | 'abandoned' | 'changed'
export const QUEST_EVENTS: readonly QuestEvent[] = ['accepted', 'progress', 'objective', 'ready', 'completed', 'abandoned', 'changed']

export type ContentChangeKind = 'quests' | 'nests' | 'npcs'
export const CONTENT_CHANGE_KINDS: readonly ContentChangeKind[] = ['quests', 'nests', 'npcs']

// ---- party ----

export type PartyMode = 'free' | 'share'
export type PartyExpMode = PartyMode
export type PartyItemMode = PartyMode
export const PARTY_MODES: readonly PartyMode[] = ['free', 'share']
export const PARTY_MAX = 8
/** Metres (XZ) from a kill within which party members share EXP, quest credit and 'share' loot. */
export const PARTY_SHARE_RANGE = 60
export const PARTY_INVITE_MS = 30_000
/** A disconnected member stays in the party this long (entering the world again keeps it). */
export const PARTY_OFFLINE_GRACE_MS = 120_000

export interface PartyMember {
  characterId: number
  name: string
  model: string
  level: number
  /** Runtime entity id, null while offline. */
  entity: number | null
  hp: number
  maxHp: number
  mp: number
  maxMp: number
  dead?: boolean
  /** [x, z] metres; absent while offline. */
  pos?: [number, number]
}

export interface PartyState {
  id: number
  /** characterId of the leader. */
  leader: number
  exp: PartyExpMode
  items: PartyItemMode
  members: PartyMember[]
}

/** Changed fields of one member (characterId always present). */
export interface PartyVitals {
  characterId: number
  entity?: number | null
  level?: number
  hp?: number
  maxHp?: number
  mp?: number
  maxMp?: number
  dead?: boolean
  pos?: [number, number]
}

export type PartyEventKind = 'joined' | 'left' | 'kicked' | 'leader' | 'declined' | 'expired' | 'disbanded' | 'offline' | 'online' | 'settings'
export const PARTY_EVENT_KINDS: readonly PartyEventKind[] = ['joined', 'left', 'kicked', 'leader', 'declined', 'expired', 'disbanded', 'offline', 'online', 'settings']

// ---- GM editor data (gmResult.data of the `nest` / `npc` commands; docs/QUESTS.md §5.2, §5.3) ----

/** Where a nest or NPC comes from: the export, the export with a GM patch, or GM-authored. */
export type ContentSource = 'export' | 'patched' | 'authored'

export interface GmNestInfo {
  id: number
  mob: string
  mobName: string
  level: number
  x: number
  z: number
  radius: number
  spawnRadius: number
  count: number
  alive: number
  respawnSec: [number, number]
  aggressive: boolean
  enabled: boolean
  source: ContentSource
}

export interface GmNpcInfo {
  code: string
  base: string
  name: string
  x: number
  z: number
  yaw: number
  entity: number | null
  shop?: string
  hidden?: boolean
  source: ContentSource
}

// ---- HTTP: quest catalog and quest editor (docs/QUESTS.md §5.4) ----

/** GET /api/quests (Bearer; ETag "q<rev>"): the merged quest files (repo + overrides). */
export interface ApiQuestCatalog {
  rev: number
  files: QuestFile[]
}

/** GET /api/gm/quests (staff). */
export interface ApiGmQuestList {
  rev: number
  quests: { id: string; title: string; file: string; source: 'repo' | 'override'; rev: number; disabled: boolean; issues: QuestIssue[] }[]
}

/** Body of POST /api/gm/quests/validate and PUT /api/gm/quests/:id (at most GM_API_MAX_BODY_BYTES). */
export interface ApiGmQuestPut {
  quest: QuestDef
  items?: QuestItemDef[]
  locations?: QuestLocation[]
  /** The rev the edit started from; a stale one is answered 409. */
  baseRev?: number
}

/** Answer of the quest editor routes (422 with issues when invalid, 409 when baseRev is stale). */
export interface ApiGmQuestResult {
  ok: boolean
  rev: number
  issues: QuestIssue[]
}

/** Largest body the /api/gm/* routes accept (every other route keeps its 4096-byte limit). */
export const GM_API_MAX_BODY_BYTES = 32 * 1024
/** Per-account budget of the /api/gm/* routes. */
export const GM_API_RATE_LIMIT = { perSecond: 2, burst: 10 } as const

// ---- wave 7B additions (additive, protocol v1; docs/WAVE_PLAN2.md §3.1, docs/EFFECTS.md §4) ----------------

/**
 * Emotes of the Action window (retail UIIT_CTL_EMOT_*). Clips (docs/WAVE_PLAN2.md D36): hi EMOTION01, greeting 02
 * (the fist salute), rush 03, joy 04, no 05, yes 06, laugh 07.
 */
export type EmoteKind = 'hi' | 'laugh' | 'greeting' | 'yes' | 'rush' | 'joy' | 'no'
export const EMOTE_KINDS: readonly EmoteKind[] = ['hi', 'laugh', 'greeting', 'yes', 'rush', 'joy', 'no']

/** A player's posture on the wire (entityUpdate.posture); EntityState.posture carries only 'sit'. */
export type Posture = 'sit' | 'stand'
export const POSTURES: readonly Posture[] = ['sit', 'stand']

// ---- wave 8 additions (additive, protocol v1; docs/WAVE_PLAN2.md §3.2) --------------------------------------

// ---- combat and items (docs/SYSTEMS_COMBAT.md §7) ----

/** A repair target: one equipment slot or one bag index (exactly one key). */
export type RepairRef = { equip: EquipSlot } | { bag: number }
/** Most refs one `repair` may name. */
export const REPAIR_REFS_MAX = 16
export type AlchemyOutcome = 'success' | 'fail' | 'cancelled'
export const ALCHEMY_OUTCOMES: readonly AlchemyOutcome[] = ['success', 'fail', 'cancelled']
/** Longest alchemy fuse the wire accepts (alchemyStart.readyInMs; config ALCHEMY_FUSE_MS 0..30000). */
export const ALCHEMY_FUSE_MAX_MS = 30_000
/** Berserk gauge size (PlayerStats.hwan 0..HWAN_MAX). */
export const HWAN_MAX = 5
/** Longest Berserk the wire accepts (EntityState.berserkMs; config HWAN_DURATION_MS 1000..600000). */
export const BERSERK_MAX_MS = 600_000

// ---- social: trade, stalls, guilds (docs/SYSTEMS_SOCIAL.md §2.1) ----

/** Exchange slots per side [confirmed ifexchange.txt]. */
export const TRADE_SLOTS = 12
/** Metres: request, accept, lock and accept need the partner within this distance. */
export const TRADE_RANGE = 10
/** Metres: an open exchange ends beyond this. */
export const TRADE_BREAK_RANGE = 15
export const TRADE_REQUEST_MS = 30_000
export const STALL_SLOTS = 10
export const STALL_VISITORS_MAX = 8
/** Metres: visit and buy. */
export const STALL_RANGE = 10
/** Metres: a visitor farther than this leaves. */
export const STALL_BREAK_RANGE = 15
export const STALL_PRICE_MAX = 1_000_000_000
/** Code points. */
export const STALL_TITLE_MAX = 32
export const STALL_GREETING_MAX = 80
/** Metres from any NPC entity. */
export const STALL_NPC_CLEARANCE = 3
/** Metres from another stall owner. */
export const STALL_SPACING = 1.5
/** Guild names: 2..12 ASCII letters and digits, starting with a letter. */
export const GUILD_NAME = /^[A-Za-z][A-Za-z0-9]{1,11}$/
/** Code points. */
export const GUILD_TITLE_MAX = 12
export const GUILD_NOTICE_TITLE_MAX = 32
/** Code points; keeps guildNotice under the 1024-byte frame. */
export const GUILD_NOTICE_MAX = 240
export const GUILD_INVITE_MS = 30_000
/** Parser bound of GuildState.members; the live cap is config GUILD_MAX_MEMBERS. */
export const GUILD_MEMBERS_MAX = 100
/** NPC identities that run the guild services [confirmed npcs.json: Leebaek]. */
export const GUILD_MANAGER_NPCS: readonly string[] = ['NPC_CH_GENARAL_SP']

export type GuildRank = 'master' | 'member'
export const GUILD_RANKS: readonly GuildRank[] = ['master', 'member']
/** Retail rights columns Join / Withdraw / Notice / Name (Storage is out of scope). */
export type GuildPerm = 'invite' | 'kick' | 'notice' | 'title'
export const GUILD_PERMS: readonly GuildPerm[] = ['invite', 'kick', 'notice', 'title']

/** One offered stack; `bag` only on your own side (to dim that bag slot). */
export interface TradeItem {
  stack: ItemStack
  bag?: number
}
/** One side of an exchange; `items.length === TRADE_SLOTS`. */
export interface TradeSide {
  items: (TradeItem | null)[]
  gold: number
  locked: boolean
  accepted: boolean
}
export interface TradeState {
  /** The partner's entity id, name and level. */
  partner: number
  name: string
  level: number
  mine: TradeSide
  theirs: TradeSide
}
export type TradeEndReason = 'done' | 'cancelled' | 'declined' | 'expired' | 'moved' | 'too_far' | 'dead' | 'left' | 'failed'
export const TRADE_END_REASONS: readonly TradeEndReason[] = ['done', 'cancelled', 'declined', 'expired', 'moved', 'too_far', 'dead', 'left', 'failed']

/** One listing; `bag` only in the owner's own view. */
export interface StallListing {
  stack: ItemStack
  price: number
  bag?: number
}
export type StallMode = 'modify' | 'open'
export const STALL_MODES: readonly StallMode[] = ['modify', 'open']
export interface StallView {
  /** Owner entity id and name. */
  owner: number
  name: string
  title: string
  greeting: string
  state: StallMode
  /** length STALL_SLOTS */
  items: (StallListing | null)[]
  /** 0..STALL_VISITORS_MAX */
  visitors: number
}
export type StallEndReason = 'closed' | 'left' | 'too_far'
export const STALL_END_REASONS: readonly StallEndReason[] = ['closed', 'left', 'too_far']

export interface GuildMember {
  characterId: number
  name: string
  model: string
  level: number
  rank: GuildRank
  perms: GuildPerm[]
  title: string
  online: boolean
  /** characters.last_played (ms); 0 = never. */
  lastSeen: number
  joinedAt: number
}
export interface GuildState {
  id: number
  name: string
  /** characterId of the master. */
  master: number
  createdAt: number
  notice: { title: string; text: string; at: number }
  maxMembers: number
  /** 1..GUILD_MEMBERS_MAX */
  members: GuildMember[]
}
export type GuildEventKind = 'created' | 'joined' | 'left' | 'kicked' | 'master' | 'disbanded' | 'declined' | 'expired'
  | 'online' | 'offline' | 'notice' | 'perms' | 'title'
export const GUILD_EVENT_KINDS: readonly GuildEventKind[] = [
  'created', 'joined', 'left', 'kicked', 'master', 'disbanded', 'declined', 'expired', 'online', 'offline', 'notice', 'perms', 'title',
]
