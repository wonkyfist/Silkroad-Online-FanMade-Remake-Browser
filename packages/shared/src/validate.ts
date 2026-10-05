/**
 * Runtime validators for protocol v1 frames (see protocol.ts). Environment-neutral.
 *
 * Client -> server parsing is strict: exact key sets, bounded strings and numbers. Anything else
 * is rejected so the server never touches unchecked input.
 * Server -> client parsing checks every field the client relies on but ignores unknown extra keys,
 * so an additive protocol change does not break an older client.
 */

import {
  ACTION_FAIL_REASONS,
  APPEARANCE_STEPS,
  BUYBACK_SLOTS,
  CAST_END_REASONS,
  CHARACTER_NAME,
  CHAT_CHANNELS,
  CHAT_SEND_CHANNELS,
  CONTENT_CHANGE_KINDS,
  EFFECT_REMOVE_REASONS,
  EMOTE_KINDS,
  HOTBAR_SLOTS,
  ITEM_CAST_END_REASONS,
  MASTERY_CODES,
  MAX_EFFECTS_PER_ENTITY,
  MAX_GOLD,
  MAX_STORAGE_SIZE,
  MOUSE_SLOT,
  NPC_CLOSE_REASONS,
  NPC_SERVICES,
  PARTY_EVENT_KINDS,
  PARTY_MAX,
  PARTY_MODES,
  QUEST_EVENTS,
  QUEST_STATUSES,
  SKILL_STATUS_KINDS,
  STORAGE_GOLD_DIRS,
  STARTER_OUTFITS,
  UNIQUE_NOTICE_EVENTS,
  ENTITY_KINDS,
  GAMEPLAY_REQUESTS,
  GM_COMMAND,
  GM_MAX_ARGS,
  GM_MAX_ARG_LENGTH,
  HIT_OUTCOMES,
  LIFE_STATES,
  MAX_BAG_SIZE,
  MAX_CHAT_LENGTH,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_COMBAT_HITS,
  MAX_ITEM_COUNT,
  MAX_NPC_DIALOG_LINE,
  MAX_NPC_DIALOG_LINES,
  MAX_STAT_POINTS_PER_REQUEST,
  PLAYER_STAT_KEYS,
  POSTURES,
  ROLES,
  STARTER_WEAPONS,
  // wave 8
  ALCHEMY_FUSE_MAX_MS,
  ALCHEMY_OUTCOMES,
  BERSERK_MAX_MS,
  GUILD_EVENT_KINDS,
  GUILD_MEMBERS_MAX,
  GUILD_NOTICE_MAX,
  GUILD_NOTICE_TITLE_MAX,
  GUILD_PERMS,
  GUILD_RANKS,
  GUILD_TITLE_MAX,
  HWAN_MAX,
  PLAYER_STAT_OPTIONAL_KEYS,
  REPAIR_REFS_MAX,
  STALL_END_REASONS,
  STALL_GREETING_MAX,
  STALL_MODES,
  STALL_PRICE_MAX,
  STALL_SLOTS,
  STALL_TITLE_MAX,
  STALL_VISITORS_MAX,
  TRADE_END_REASONS,
  TRADE_SLOTS,
  type GuildMember,
  type GuildPerm,
  type GuildState,
  type RepairRef,
  type StallListing,
  type StallView,
  type TradeItem,
  type TradeSide,
  type TradeState,
  type AccountStorage,
  type BagSlotUpdate,
  type BuybackEntry,
  type CharacterSummary,
  type ClientMessage,
  type CombatHit,
  type EffectState,
  type EntityState,
  type HotbarEntry,
  type MasteryCode,
  type PartyMember,
  type PartyState,
  type PartyVitals,
  type QuestDoneEntry,
  type QuestProgress,
  type SkillCooldown,
  type StorageSlotUpdate,
  type EquipSlotUpdate,
  type ErrorCode,
  type Inventory,
  type LightningStrike,
  type StormStatus,
  type TornadoState,
  type MoveState,
  type PlayerStats,
  type Role,
  type ServerInfo,
  type ServerMessage,
  type StarterWeapon,
  type StatGain,
  type Vec3,
  type WeatherSync,
  type WorldClockState,
  type WorldInfo,
} from './protocol.ts'
import { EQUIP_SLOTS, MOB_VARIANTS, type EquipSlot, type ItemStack } from './content.ts'
import { CLOCK_LIMITS } from './world-clock.ts'
import { LIGHTNING_GM_DIST_M, RAIN_INTENSITY_MIN, WEATHER_KINDS, WEATHER_LIMITS, type WeatherParams } from './weather.ts'
import { HAZARD_CAUSES, STRIKE_KINDS, STRIKE_LIMITS, STRIKE_SOURCES } from './lightning.ts'
import { STORM_EFFECT_IDS, STORM_LIMITS, STORM_PHASES, type StormEffect } from './storm.ts'
import { TORNADO_LIMITS } from './tornado.ts'
import { MAX_QUEST_BAG_CODES, MAX_QUEST_OBJECTIVES, MAX_REWARD_CHOICES, OBJECTIVE_ID, QUEST_ID } from './quests.ts'
import {
  HUNT_OUTCOMES,
  HUNT_PHASES,
  HUNT_TRAIL_MAX,
  PILOT_ABILITY,
  PILOT_END_REASONS,
  PILOT_HONOR,
  PILOT_INELIGIBLE,
  PILOT_KIT_MAX,
  PILOT_STEERINGS,
  PILOT_TARGET_KINDS,
  PILOT_TAUNT_MAX,
  type HuntEventView,
  type PilotKitView,
  type PilotServerMessage,
} from './pilot.ts'

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string }

/** Largest |x| / |z| accepted in a moveTo (world metres). */
export const MAX_COORD = 1_000_000
/** Longest hello token accepted (base64url of 32 bytes is 43 chars). */
export const MAX_TOKEN_LENGTH = 256
/** Longest name accepted by nameCheck/charCreate before the name rule is applied. */
export const MAX_NAME_INPUT = 32
/** CodeName128 ids: upper-case letters, digits, underscore. */
export const CODE_NAME = /^[A-Z0-9_]{1,128}$/

const CLIENT_KEYS: Record<ClientMessage['t'], readonly string[]> = {
  hello: ['t', 'version', 'token'],
  charList: ['t'],
  nameCheck: ['t', 'name'],
  charCreate: ['t', 'name', 'model', 'weapon'],
  charDelete: ['t', 'id'],
  enterWorld: ['t', 'id'],
  moveTo: ['t', 'x', 'z'],
  chat: ['t', 'text'],
  leaveWorld: ['t'],
  ping: ['t', 'n', 'clientTime'],
  gm: ['t', 'cmd', 'args'],
  attack: ['t', 'target'],
  stopAction: ['t'],
  useSkill: ['t', 'skill'],
  pickup: ['t', 'id'],
  respawn: ['t'],
  statUp: ['t', 'stat', 'points'],
  itemMove: ['t', 'from', 'to'],
  itemSplit: ['t', 'from', 'to', 'count'],
  itemEquip: ['t', 'bag'],
  itemUnequip: ['t', 'slot'],
  itemUse: ['t', 'bag'],
  itemDrop: ['t', 'bag'],
  shopBuy: ['t', 'npc', 'item', 'count'],
  shopSell: ['t', 'npc', 'bag'],
  // wave 3 (docs/WAVE_PLAN.md §2.1)
  skillLearn: ['t', 'skill'],
  masteryUp: ['t', 'mastery'],
  buffCancel: ['t', 'skill'],
  hotbarSet: ['t', 'slot', 'entry'],
  npcTalk: ['t', 'npc'],
  npcClose: ['t'],
  storageOpen: ['t', 'npc'],
  storageDeposit: ['t', 'npc', 'bag'],
  storageWithdraw: ['t', 'npc', 'slot'],
  storageMove: ['t', 'npc', 'from', 'to'],
  storageGold: ['t', 'npc', 'dir', 'amount'],
  shopBuyback: ['t', 'npc', 'index'],
  // wave 4 (docs/WAVE_PLAN.md §2.2, docs/QUESTS.md §6.3)
  questAccept: ['t', 'npc', 'quest'],
  questTurnIn: ['t', 'npc', 'quest'],
  questAbandon: ['t', 'quest'],
  questTalk: ['t', 'npc', 'quest', 'objective'],
  questUseItem: ['t', 'quest', 'objective'],
  partyInvite: ['t', 'target'],
  partyRespond: ['t', 'inviter', 'accept'],
  partyLeave: ['t'],
  partyKick: ['t', 'member'],
  partyLeader: ['t', 'member'],
  partySettings: ['t'],
  // wave 7B (docs/WAVE_PLAN2.md §3.1)
  sit: ['t', 'on'],
  emote: ['t', 'emote'],
  // wave 8 (docs/WAVE_PLAN2.md §3.2.3)
  mountRide: ['t', 'cos'],
  mountDismount: ['t'],
  mountDismiss: ['t'],
  repair: ['t', 'npc'],
  alchemyReinforce: ['t', 'item', 'elixir'],
  alchemyCancel: ['t'],
  berserk: ['t'],
  tradeRequest: ['t', 'target'],
  tradeRespond: ['t', 'from', 'accept'],
  tradeOffer: ['t', 'bag'],
  tradeTake: ['t', 'slot'],
  tradeGold: ['t', 'amount'],
  tradeLock: ['t'],
  tradeAccept: ['t'],
  tradeCancel: ['t'],
  stallCreate: ['t', 'title'],
  stallItem: ['t', 'slot', 'bag', 'count', 'price'],
  stallItemRemove: ['t', 'slot'],
  stallText: ['t'],
  stallOpen: ['t', 'open'],
  stallClose: ['t'],
  stallVisit: ['t', 'owner'],
  stallLeave: ['t'],
  stallBuy: ['t', 'owner', 'slot', 'code', 'count', 'price'],
  guildCreate: ['t', 'npc', 'name'],
  guildDisband: ['t', 'npc'],
  guildInvite: ['t', 'name'],
  guildRespond: ['t', 'guild', 'accept'],
  guildLeave: ['t'],
  guildKick: ['t', 'member'],
  guildPerms: ['t', 'member', 'perms'],
  guildTitle: ['t', 'member', 'title'],
  guildNotice: ['t', 'title', 'text'],
  guildMaster: ['t', 'member'],
  // wave 10 (docs/MOVEMENT.md §5): no fields
  jump: ['t'],
  // Play the Boss (docs/PLAY_THE_BOSS.md §5.1)
  pilotVolunteer: ['t', 'on'],
  pilotAnswer: ['t', 'event', 'accept'],
  pilotAct: ['t', 'ability'],
  pilotTaunt: ['t', 'line'],
  pilotQuit: ['t'],
}

/** Keys a client message may omit. */
const CLIENT_OPTIONAL_KEYS: Partial<Record<ClientMessage['t'], readonly string[]>> = {
  charCreate: ['height', 'volume', 'outfit'],
  chat: ['to', 'channel'],
  useSkill: ['target'],
  itemEquip: ['slot'],
  itemUnequip: ['bag'],
  itemDrop: ['count'],
  shopSell: ['count'],
  storageDeposit: ['count', 'to'],
  storageWithdraw: ['count', 'bag'],
  shopBuyback: ['code'],
  questTurnIn: ['choice'],
  partyInvite: ['exp', 'items'],
  partySettings: ['exp', 'items'],
  // wave 8
  repair: ['items'],
  alchemyReinforce: ['powder'],
  tradeOffer: ['count'],
  stallText: ['title', 'greeting'],
  stallBuy: ['plus', 'durability'],
  // Play the Boss
  pilotAct: ['target', 'x', 'z', 'repeat'],
}

const MAX_ID = Number.MAX_SAFE_INTEGER

const ERROR_CODES: readonly ErrorCode[] = [
  'bad_request', 'unauthorized', 'version_mismatch', 'name_taken', 'name_invalid', 'slots_full',
  'not_found', 'not_in_world', 'already_in_world', 'rate_limited', 'server_error', 'forbidden',
]

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function has(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k)
}

/** UTF-8 byte length without TextEncoder allocation. */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

/** Length in code points (what a player perceives as characters, roughly). */
export function codePointLength(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

function str(o: Record<string, unknown>, k: string, max: number, min = 0): string {
  const v = o[k]
  if (typeof v !== 'string') fail(`${k} must be a string`)
  if (v.length < min) fail(`${k} too short`)
  if (codePointLength(v) > max) fail(`${k} too long`)
  return v
}

function num(o: Record<string, unknown>, k: string, min: number, max: number): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${k} must be a finite number`)
  if (v < min || v > max) fail(`${k} out of range`)
  return v
}

function int(o: Record<string, unknown>, k: string, min: number, max: number): number {
  const v = num(o, k, min, max)
  if (!Number.isInteger(v)) fail(`${k} must be an integer`)
  return v
}

/** gm.args: an array of at most GM_MAX_ARGS strings, each at most GM_MAX_ARG_LENGTH code points. */
function gmArgs(o: Record<string, unknown>, k: string): string[] {
  const v = o[k]
  if (!Array.isArray(v)) fail(`${k} must be an array`)
  if (v.length > GM_MAX_ARGS) fail(`at most ${GM_MAX_ARGS} ${k}`)
  return v.map((a, i) => {
    if (typeof a !== 'string') fail(`${k}[${i}] must be a string`)
    if (codePointLength(a) > GM_MAX_ARG_LENGTH) fail(`${k}[${i}] too long`)
    return a
  })
}

function weapon(o: Record<string, unknown>, k: string): StarterWeapon {
  const v = o[k]
  if (typeof v !== 'string' || !(STARTER_WEAPONS as readonly string[]).includes(v)) fail(`${k} must be a starter weapon`)
  return v as StarterWeapon
}

// ---- client -> server ---------------------------------------------------------------------------

/** Validate an already-decoded value as a ClientMessage (strict). */
export function validateClientMessage(value: unknown): ParseResult<ClientMessage> {
  try {
    return { ok: true, msg: clientMessage(value) }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message }
    throw e
  }
}

/** Parse one text frame from a client. Rejects frames over MAX_CLIENT_MESSAGE_BYTES. */
export function parseClientMessage(json: string): ParseResult<ClientMessage> {
  if (typeof json !== 'string') return { ok: false, error: 'frame must be text' }
  if (json.length > MAX_CLIENT_MESSAGE_BYTES || utf8Length(json) > MAX_CLIENT_MESSAGE_BYTES) {
    return { ok: false, error: `frame larger than ${MAX_CLIENT_MESSAGE_BYTES} bytes` }
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  return validateClientMessage(value)
}

function clientMessage(v: unknown): ClientMessage {
  if (!isRecord(v)) fail('message must be an object')
  const t = v.t
  if (typeof t !== 'string' || !has(CLIENT_KEYS, t)) fail('unknown message type')
  const required = CLIENT_KEYS[t as ClientMessage['t']]
  const optional = CLIENT_OPTIONAL_KEYS[t as ClientMessage['t']] ?? []
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) fail(`unexpected field ${k}`)
  for (const k of required) if (!has(v, k)) fail(`missing field ${k}`)
  switch (t as ClientMessage['t']) {
    case 'hello':
      return { t: 'hello', version: int(v, 'version', 0, 65535), token: str(v, 'token', MAX_TOKEN_LENGTH, 1) }
    case 'charList':
      return { t: 'charList' }
    case 'nameCheck':
      return { t: 'nameCheck', name: str(v, 'name', MAX_NAME_INPUT) }
    case 'charCreate': {
      const name = str(v, 'name', MAX_NAME_INPUT)
      const model = str(v, 'model', 128, 1)
      if (!CODE_NAME.test(model)) fail('model must be a CodeName128 id')
      const created: Extract<ClientMessage, { t: 'charCreate' }> = { t: 'charCreate', name, model, weapon: weapon(v, 'weapon') }
      if (v.height !== undefined) created.height = int(v, 'height', 0, APPEARANCE_STEPS - 1)
      if (v.volume !== undefined) created.volume = int(v, 'volume', 0, APPEARANCE_STEPS - 1)
      if (v.outfit !== undefined) created.outfit = oneOf(v, 'outfit', STARTER_OUTFITS)
      return created
    }
    case 'charDelete':
      return { t: 'charDelete', id: int(v, 'id', 1, Number.MAX_SAFE_INTEGER) }
    case 'enterWorld':
      return { t: 'enterWorld', id: int(v, 'id', 1, Number.MAX_SAFE_INTEGER) }
    case 'moveTo':
      return { t: 'moveTo', x: num(v, 'x', -MAX_COORD, MAX_COORD), z: num(v, 'z', -MAX_COORD, MAX_COORD) }
    case 'chat': {
      const m: Extract<ClientMessage, { t: 'chat' }> = { t: 'chat', text: str(v, 'text', MAX_CHAT_LENGTH, 1) }
      if (has(v, 'to')) {
        const to = str(v, 'to', 12, 3)
        if (!CHARACTER_NAME.test(to)) fail('to must be a character name')
        m.to = to
      }
      if (has(v, 'channel')) m.channel = oneOf(v, 'channel', CHAT_SEND_CHANNELS)
      // D32 (docs/WAVE_PLAN2.md): a whisper goes to one character, never to a party, guild or stall channel.
      if (m.to !== undefined && m.channel !== undefined && m.channel !== 'local') fail(`a whisper cannot go to the ${m.channel} channel`)
      return m
    }
    case 'leaveWorld':
      return { t: 'leaveWorld' }
    case 'ping':
      return { t: 'ping', n: int(v, 'n', 0, Number.MAX_SAFE_INTEGER), clientTime: num(v, 'clientTime', -Number.MAX_VALUE, Number.MAX_VALUE) }
    case 'gm': {
      const cmd = str(v, 'cmd', 16, 1)
      if (!GM_COMMAND.test(cmd)) fail('cmd must be 1-16 lower-case letters')
      return { t: 'gm', cmd, args: gmArgs(v, 'args') }
    }
    case 'attack':
      return { t: 'attack', target: int(v, 'target', 0, MAX_ID) }
    case 'stopAction':
      return { t: 'stopAction' }
    case 'useSkill': {
      const m: ClientMessage = { t: 'useSkill', skill: codeName(v, 'skill') }
      if (has(v, 'target')) m.target = int(v, 'target', 0, MAX_ID)
      return m
    }
    case 'pickup':
      return { t: 'pickup', id: int(v, 'id', 0, MAX_ID) }
    case 'respawn':
      return { t: 'respawn' }
    case 'statUp':
      return { t: 'statUp', stat: oneOf(v, 'stat', ['str', 'int'] as const), points: int(v, 'points', 1, MAX_STAT_POINTS_PER_REQUEST) }
    case 'itemMove':
      return { t: 'itemMove', from: bagSlot(v, 'from'), to: bagSlot(v, 'to') }
    case 'itemSplit':
      return { t: 'itemSplit', from: bagSlot(v, 'from'), to: bagSlot(v, 'to'), count: itemCount(v, 'count') }
    case 'itemEquip': {
      const m: ClientMessage = { t: 'itemEquip', bag: bagSlot(v, 'bag') }
      if (has(v, 'slot')) m.slot = oneOf<EquipSlot>(v, 'slot', EQUIP_SLOTS)
      return m
    }
    case 'itemUnequip': {
      const m: ClientMessage = { t: 'itemUnequip', slot: oneOf<EquipSlot>(v, 'slot', EQUIP_SLOTS) }
      if (has(v, 'bag')) m.bag = bagSlot(v, 'bag')
      return m
    }
    case 'itemUse':
      return { t: 'itemUse', bag: bagSlot(v, 'bag') }
    case 'itemDrop': {
      const m: ClientMessage = { t: 'itemDrop', bag: bagSlot(v, 'bag') }
      if (has(v, 'count')) m.count = itemCount(v, 'count')
      return m
    }
    case 'shopBuy':
      return { t: 'shopBuy', npc: int(v, 'npc', 0, MAX_ID), item: codeName(v, 'item'), count: itemCount(v, 'count') }
    case 'shopSell': {
      const m: ClientMessage = { t: 'shopSell', npc: int(v, 'npc', 0, MAX_ID), bag: bagSlot(v, 'bag') }
      if (has(v, 'count')) m.count = itemCount(v, 'count')
      return m
    }
    case 'skillLearn':
      return { t: 'skillLearn', skill: codeName(v, 'skill') }
    case 'masteryUp':
      return { t: 'masteryUp', mastery: oneOf(v, 'mastery', MASTERY_CODES) }
    case 'buffCancel':
      return { t: 'buffCancel', skill: codeName(v, 'skill') }
    case 'hotbarSet':
      // Slots 0..HOTBAR_SLOTS-1 are the bar; MOUSE_SLOT (= HOTBAR_SLOTS) is the mouse quick slot.
      return { t: 'hotbarSet', slot: int(v, 'slot', 0, MOUSE_SLOT), entry: v.entry === null ? null : clientHotbarEntry(v.entry) }
    case 'npcTalk':
      return { t: 'npcTalk', npc: npcId(v) }
    case 'npcClose':
      return { t: 'npcClose' }
    case 'storageOpen':
      return { t: 'storageOpen', npc: npcId(v) }
    case 'storageDeposit': {
      const m: ClientMessage = { t: 'storageDeposit', npc: npcId(v), bag: bagSlot(v, 'bag') }
      if (has(v, 'count')) m.count = itemCount(v, 'count')
      if (has(v, 'to')) m.to = storageSlot(v, 'to')
      return m
    }
    case 'storageWithdraw': {
      const m: ClientMessage = { t: 'storageWithdraw', npc: npcId(v), slot: storageSlot(v, 'slot') }
      if (has(v, 'count')) m.count = itemCount(v, 'count')
      if (has(v, 'bag')) m.bag = bagSlot(v, 'bag')
      return m
    }
    case 'storageMove':
      return { t: 'storageMove', npc: npcId(v), from: storageSlot(v, 'from'), to: storageSlot(v, 'to') }
    case 'storageGold':
      return { t: 'storageGold', npc: npcId(v), dir: oneOf(v, 'dir', STORAGE_GOLD_DIRS), amount: int(v, 'amount', 1, MAX_GOLD) }
    case 'shopBuyback': {
      const m: ClientMessage = { t: 'shopBuyback', npc: npcId(v), index: int(v, 'index', 0, BUYBACK_SLOTS - 1) }
      if (has(v, 'code')) m.code = codeName(v, 'code')
      return m
    }
    case 'questAccept':
      return { t: 'questAccept', npc: npcId(v), quest: questId(v) }
    case 'questTurnIn': {
      const m: ClientMessage = { t: 'questTurnIn', npc: npcId(v), quest: questId(v) }
      if (has(v, 'choice')) m.choice = int(v, 'choice', 0, MAX_REWARD_CHOICES - 1)
      return m
    }
    case 'questAbandon':
      return { t: 'questAbandon', quest: questId(v) }
    case 'questTalk':
      return { t: 'questTalk', npc: npcId(v), quest: questId(v), objective: objectiveId(v) }
    case 'questUseItem':
      return { t: 'questUseItem', quest: questId(v), objective: objectiveId(v) }
    case 'partyInvite': {
      const m: ClientMessage = { t: 'partyInvite', target: int(v, 'target', 0, MAX_ID) }
      if (has(v, 'exp')) m.exp = oneOf(v, 'exp', PARTY_MODES)
      if (has(v, 'items')) m.items = oneOf(v, 'items', PARTY_MODES)
      return m
    }
    case 'partyRespond':
      return { t: 'partyRespond', inviter: int(v, 'inviter', 0, MAX_ID), accept: bool(v, 'accept') }
    case 'partyLeave':
      return { t: 'partyLeave' }
    case 'partyKick':
      return { t: 'partyKick', member: int(v, 'member', 1, MAX_ID) }
    case 'partyLeader':
      return { t: 'partyLeader', member: int(v, 'member', 1, MAX_ID) }
    case 'partySettings': {
      if (!has(v, 'exp') && !has(v, 'items')) fail('partySettings needs exp or items')
      const m: ClientMessage = { t: 'partySettings' }
      if (has(v, 'exp')) m.exp = oneOf(v, 'exp', PARTY_MODES)
      if (has(v, 'items')) m.items = oneOf(v, 'items', PARTY_MODES)
      return m
    }
    case 'sit':
      return { t: 'sit', on: bool(v, 'on') }
    case 'emote':
      return { t: 'emote', emote: oneOf(v, 'emote', EMOTE_KINDS) }
    // ---- wave 10: the jump (docs/MOVEMENT.md §5); no fields ----
    case 'jump':
      return { t: 'jump' }
    // ---- Play the Boss (docs/PLAY_THE_BOSS.md §5.1) ----
    case 'pilotVolunteer':
      return { t: 'pilotVolunteer', on: bool(v, 'on') }
    case 'pilotAnswer':
      return { t: 'pilotAnswer', event: int(v, 'event', 1, MAX_ID), accept: bool(v, 'accept') }
    case 'pilotAct': {
      const ability = str(v, 'ability', 16, 1)
      if (!PILOT_ABILITY.test(ability)) fail('ability must be 1-16 letters a-z')
      const m: Extract<ClientMessage, { t: 'pilotAct' }> = { t: 'pilotAct', ability }
      if (has(v, 'target')) m.target = int(v, 'target', 0, MAX_ID)
      if (has(v, 'x') !== has(v, 'z')) fail('x and z go together')
      if (has(v, 'x')) {
        m.x = num(v, 'x', -MAX_COORD, MAX_COORD)
        m.z = num(v, 'z', -MAX_COORD, MAX_COORD)
      }
      if (has(v, 'repeat')) m.repeat = bool(v, 'repeat')
      return m
    }
    case 'pilotTaunt':
      return { t: 'pilotTaunt', line: int(v, 'line', 0, PILOT_TAUNT_MAX) }
    case 'pilotQuit':
      return { t: 'pilotQuit' }
    // ---- wave 8: combat and items (docs/SYSTEMS_COMBAT.md §7.2) ----
    case 'mountRide':
      return { t: 'mountRide', cos: int(v, 'cos', 0, MAX_ID) }
    case 'mountDismount':
      return { t: 'mountDismount' }
    case 'mountDismiss':
      return { t: 'mountDismiss' }
    case 'repair': {
      const m: ClientMessage = { t: 'repair', npc: npcId(v) }
      if (has(v, 'items')) {
        const items = v.items
        if (!Array.isArray(items) || items.length < 1 || items.length > REPAIR_REFS_MAX) fail(`items must be an array of 1-${REPAIR_REFS_MAX} refs`)
        m.items = items.map(repairRef)
      }
      return m
    }
    case 'alchemyReinforce': {
      const m: ClientMessage = { t: 'alchemyReinforce', item: bagSlot(v, 'item'), elixir: bagSlot(v, 'elixir') }
      if (has(v, 'powder')) m.powder = bagSlot(v, 'powder')
      const slots = [m.item, m.elixir, ...(m.powder === undefined ? [] : [m.powder])]
      if (new Set(slots).size !== slots.length) fail('item, elixir and powder must be different bag slots')
      return m
    }
    case 'alchemyCancel':
      return { t: 'alchemyCancel' }
    case 'berserk':
      return { t: 'berserk' }
    // ---- wave 8: trade (docs/SYSTEMS_SOCIAL.md §3.4) ----
    case 'tradeRequest':
      return { t: 'tradeRequest', target: int(v, 'target', 0, MAX_ID) }
    case 'tradeRespond':
      return { t: 'tradeRespond', from: int(v, 'from', 0, MAX_ID), accept: bool(v, 'accept') }
    case 'tradeOffer': {
      const m: ClientMessage = { t: 'tradeOffer', bag: bagSlot(v, 'bag') }
      if (has(v, 'count')) m.count = itemCount(v, 'count')
      return m
    }
    case 'tradeTake':
      return { t: 'tradeTake', slot: int(v, 'slot', 0, TRADE_SLOTS - 1) }
    case 'tradeGold':
      return { t: 'tradeGold', amount: int(v, 'amount', 0, MAX_GOLD) }
    case 'tradeLock':
      return { t: 'tradeLock' }
    case 'tradeAccept':
      return { t: 'tradeAccept' }
    case 'tradeCancel':
      return { t: 'tradeCancel' }
    // ---- wave 8: stalls (docs/SYSTEMS_SOCIAL.md §4.2) ----
    case 'stallCreate':
      return { t: 'stallCreate', title: str(v, 'title', STALL_TITLE_MAX) }
    case 'stallItem':
      return { t: 'stallItem', slot: stallSlot(v), bag: bagSlot(v, 'bag'), count: itemCount(v, 'count'), price: stallPrice(v) }
    case 'stallItemRemove':
      return { t: 'stallItemRemove', slot: stallSlot(v) }
    case 'stallText': {
      if (!has(v, 'title') && !has(v, 'greeting')) fail('stallText needs title or greeting')
      const m: ClientMessage = { t: 'stallText' }
      if (has(v, 'title')) m.title = str(v, 'title', STALL_TITLE_MAX)
      if (has(v, 'greeting')) m.greeting = str(v, 'greeting', STALL_GREETING_MAX)
      return m
    }
    case 'stallOpen':
      return { t: 'stallOpen', open: bool(v, 'open') }
    case 'stallClose':
      return { t: 'stallClose' }
    case 'stallVisit':
      return { t: 'stallVisit', owner: int(v, 'owner', 0, MAX_ID) }
    case 'stallLeave':
      return { t: 'stallLeave' }
    case 'stallBuy': {
      const buy: Extract<ClientMessage, { t: 'stallBuy' }> = {
        t: 'stallBuy',
        owner: int(v, 'owner', 0, MAX_ID),
        slot: stallSlot(v),
        code: codeName(v, 'code'),
        count: itemCount(v, 'count'),
        price: stallPrice(v),
      }
      // The listing's stack as the buyer saw it (ItemStack convention: absent plus = 0, absent durability = full).
      if (v.plus !== undefined) buy.plus = int(v, 'plus', 0, 255)
      if (v.durability !== undefined) buy.durability = num(v, 'durability', 0, BIG)
      return buy
    }
    // ---- wave 8: guilds (docs/SYSTEMS_SOCIAL.md §5.4) ----
    case 'guildCreate':
      // The name rule (GUILD_NAME, reserved names) is the server's: it answers 'bad_name'.
      return { t: 'guildCreate', npc: npcId(v), name: str(v, 'name', MAX_NAME_INPUT, 1) }
    case 'guildDisband':
      return { t: 'guildDisband', npc: npcId(v) }
    case 'guildInvite': {
      const name = str(v, 'name', 12, 3)
      if (!CHARACTER_NAME.test(name)) fail('name must be a character name')
      return { t: 'guildInvite', name }
    }
    case 'guildRespond':
      return { t: 'guildRespond', guild: int(v, 'guild', 1, MAX_ID), accept: bool(v, 'accept') }
    case 'guildLeave':
      return { t: 'guildLeave' }
    case 'guildKick':
      return { t: 'guildKick', member: memberId(v) }
    case 'guildPerms':
      return { t: 'guildPerms', member: memberId(v), perms: guildPerms(v, 'perms') }
    case 'guildTitle':
      return { t: 'guildTitle', member: memberId(v), title: str(v, 'title', GUILD_TITLE_MAX) }
    case 'guildNotice':
      return { t: 'guildNotice', title: str(v, 'title', GUILD_NOTICE_TITLE_MAX), text: str(v, 'text', GUILD_NOTICE_MAX) }
    case 'guildMaster':
      return { t: 'guildMaster', member: memberId(v) }
  }
}

/** RepairRef: a strict {equip: EquipSlot} or {bag: bag index}, never both. */
function repairRef(r: unknown): RepairRef {
  if (!isRecord(r)) fail('each repair ref must be {equip} or {bag}')
  const keys = Object.keys(r)
  if (keys.length !== 1) fail('a repair ref has exactly one key, equip or bag')
  if (has(r, 'equip')) return { equip: oneOf<EquipSlot>(r, 'equip', EQUIP_SLOTS) }
  if (has(r, 'bag')) return { bag: bagSlot(r, 'bag') }
  fail('a repair ref has exactly one key, equip or bag')
}

function stallSlot(o: Record<string, unknown>): number {
  return int(o, 'slot', 0, STALL_SLOTS - 1)
}

function stallPrice(o: Record<string, unknown>): number {
  return int(o, 'price', 1, STALL_PRICE_MAX)
}

/** A guild member's characterId. */
function memberId(o: Record<string, unknown>): number {
  return int(o, 'member', 1, MAX_ID)
}

/** Guild rights: unique entries of GUILD_PERMS (client and server frames). */
function guildPerms(o: Record<string, unknown>, k: string): GuildPerm[] {
  const v = o[k]
  if (!Array.isArray(v) || v.length > GUILD_PERMS.length) fail(`${k} must be an array of at most ${GUILD_PERMS.length} rights`)
  const out = v.map((x) => oneOf({ perm: x }, 'perm', GUILD_PERMS))
  if (new Set(out).size !== out.length) fail(`${k} has duplicate entries`)
  return out
}

/** Quest id (QUEST_ID, at most 64 characters). */
function questId(o: Record<string, unknown>, k = 'quest'): string {
  const s = str(o, k, 64, 1)
  if (!QUEST_ID.test(s)) fail(`${k} must be a quest id`)
  return s
}

/** Objective id (OBJECTIVE_ID: lower-case, at most 24 characters). */
function objectiveId(o: Record<string, unknown>, k = 'objective'): string {
  const s = str(o, k, 24, 1)
  if (!OBJECTIVE_ID.test(s)) fail(`${k} must be an objective id`)
  return s
}

/** hotbarSet.entry: a strict {kind, code} object (null is handled by the caller). */
function clientHotbarEntry(e: unknown): HotbarEntry {
  if (!isRecord(e)) fail('entry must be null or {kind, code}')
  for (const k of Object.keys(e)) if (k !== 'kind' && k !== 'code') fail(`unexpected field entry.${k}`)
  if (!has(e, 'kind') || !has(e, 'code')) fail('entry needs kind and code')
  return { kind: oneOf(e, 'kind', HOTBAR_KINDS), code: codeName(e, 'code') }
}

const HOTBAR_KINDS = ['skill', 'item'] as const

function npcId(o: Record<string, unknown>): number {
  return int(o, 'npc', 0, MAX_ID)
}

function storageSlot(o: Record<string, unknown>, k: string): number {
  return int(o, k, 0, MAX_STORAGE_SIZE - 1)
}

function codeName(o: Record<string, unknown>, k: string): string {
  const s = str(o, k, 128, 1)
  if (!CODE_NAME.test(s)) fail(`${k} must be a CodeName128 id`)
  return s
}

function bagSlot(o: Record<string, unknown>, k: string): number {
  return int(o, k, 0, MAX_BAG_SIZE - 1)
}

function itemCount(o: Record<string, unknown>, k: string): number {
  return int(o, k, 1, MAX_ITEM_COUNT)
}

// ---- server -> client ---------------------------------------------------------------------------

/** Validate an already-decoded value as a ServerMessage (unknown extra keys are dropped). */
export function validateServerMessage(value: unknown): ParseResult<ServerMessage> {
  try {
    return { ok: true, msg: serverMessage(value) }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message }
    throw e
  }
}

/** Parse one text frame from the server. */
export function parseServerMessage(json: string): ParseResult<ServerMessage> {
  if (typeof json !== 'string') return { ok: false, error: 'frame must be text' }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  return validateServerMessage(value)
}

const BIG = Number.MAX_VALUE

function rec(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) fail(`${what} must be an object`)
  return v
}

function vec3(o: Record<string, unknown>, k: string): Vec3 {
  const v = o[k]
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    fail(`${k} must be a Vec3`)
  }
  return [v[0], v[1], v[2]]
}

function bool(o: Record<string, unknown>, k: string): boolean {
  if (typeof o[k] !== 'boolean') fail(`${k} must be a boolean`)
  return o[k] as boolean
}

function oneOf<T extends string>(o: Record<string, unknown>, k: string, values: readonly T[]): T {
  const v = o[k]
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) fail(`${k} has an unknown value`)
  return v as T
}

function serverInfo(v: unknown): ServerInfo {
  const o = rec(v, 'server')
  const s: ServerInfo = {
    id: str(o, 'id', 64, 1),
    name: str(o, 'name', 64, 1),
    status: oneOf(o, 'status', ['online', 'maintenance', 'offline'] as const),
    online: int(o, 'online', 0, BIG),
    capacity: int(o, 'capacity', 0, BIG),
    ...(o.world !== undefined ? { world: worldFolder(o, 'world') } : {}),
  }
  // wave 10 (docs/SCREENS.md §9): a bad clock or weather drops only that field, never the whole welcome (or login)
  if (o.clock !== undefined) optionalField('server.clock', () => (s.clock = clockState(o.clock)))
  if (o.weather !== undefined) optionalField('server.weather', () => (s.weather = weatherSync(o.weather)))
  // admin addition (docs/ADMIN.md): a bad value drops only this field
  if (o.registration !== undefined) optionalField('server.registration', () => (s.registration = oneOf(o, 'registration', ['open', 'closed'] as const)))
  return s
}

/** World export folder name (ServerInfo.world): lower-case letters, digits and '-', 1..64 chars. */
export const WORLD_FOLDER = /^[a-z0-9-]{1,64}$/

function worldFolder(o: Record<string, unknown>, k: string): string {
  const s = str(o, k, 64, 1)
  if (!WORLD_FOLDER.test(s)) fail(`${k} must be a world folder name`)
  return s
}

function character(v: unknown): CharacterSummary {
  const o = rec(v, 'character')
  return {
    id: int(o, 'id', 1, Number.MAX_SAFE_INTEGER),
    name: str(o, 'name', 64, 1),
    model: str(o, 'model', 128, 1),
    level: int(o, 'level', 0, BIG),
    weapon: weapon(o, 'weapon'),
    location: str(o, 'location', 128),
    pos: vec3(o, 'pos'),
    lastPlayed: num(o, 'lastPlayed', 0, BIG),
    ...(o.height !== undefined ? { height: int(o, 'height', 0, APPEARANCE_STEPS - 1) } : {}),
    ...(o.volume !== undefined ? { volume: int(o, 'volume', 0, APPEARANCE_STEPS - 1) } : {}),
    ...(o.equip !== undefined ? { equip: equipCodes(o.equip) } : {}),
    ...(o.equipPlus !== undefined ? { equipPlus: equipPlus(o.equipPlus) } : {}),
  }
}

function moveState(v: unknown): MoveState {
  const o = rec(v, 'move')
  return { from: vec3(o, 'from'), to: vec3(o, 'to'), speed: num(o, 'speed', 0, BIG), startedAt: num(o, 'startedAt', 0, BIG) }
}

function entity(v: unknown): EntityState {
  const o = rec(v, 'entity')
  const kind = oneOf(o, 'kind', ENTITY_KINDS)
  const e: EntityState = {
    id: int(o, 'id', 0, Number.MAX_SAFE_INTEGER),
    kind,
    name: str(o, 'name', 64, 1),
    model: str(o, 'model', 128, 1),
    level: int(o, 'level', 0, BIG),
    pos: vec3(o, 'pos'),
    yaw: num(o, 'yaw', -BIG, BIG),
  }
  // A player always carries its weapon family; other kinds may omit it.
  if (kind === 'player' || o.weapon !== undefined) e.weapon = weapon(o, 'weapon')
  if (o.move !== undefined) e.move = moveState(o.move)
  if (o.invisible !== undefined) e.invisible = bool(o, 'invisible')
  if (o.hp !== undefined) e.hp = int(o, 'hp', 0, BIG)
  if (o.maxHp !== undefined) e.maxHp = int(o, 'maxHp', 0, BIG)
  if (o.state !== undefined) e.state = oneOf(o, 'state', LIFE_STATES)
  if (o.variant !== undefined) e.variant = oneOf(o, 'variant', MOB_VARIANTS)
  if (o.count !== undefined) e.count = int(o, 'count', 0, BIG)
  if (o.plus !== undefined) e.plus = int(o, 'plus', 0, 255)
  if (o.owner !== undefined) e.owner = int(o, 'owner', 0, Number.MAX_SAFE_INTEGER)
  if (o.ownerUntil !== undefined) e.ownerUntil = num(o, 'ownerUntil', 0, BIG)
  if (o.expiresAt !== undefined) e.expiresAt = num(o, 'expiresAt', 0, BIG)
  if (o.equip !== undefined) e.equip = equipCodes(o.equip)
  if (o.equipPlus !== undefined) e.equipPlus = equipPlus(o.equipPlus)
  if (o.height !== undefined) e.height = int(o, 'height', 0, APPEARANCE_STEPS - 1)
  if (o.volume !== undefined) e.volume = int(o, 'volume', 0, APPEARANCE_STEPS - 1)
  if (o.effects !== undefined) e.effects = boundedList(o, 'effects', MAX_EFFECTS_PER_ENTITY, effectState)
  if (o.gm !== undefined && bool(o, 'gm')) e.gm = true
  if (o.npc !== undefined) e.npc = str(o, 'npc', 128, 1)
  if (o.ownerParty !== undefined) e.ownerParty = int(o, 'ownerParty', 0, MAX_ID)
  // wave 7B
  if (o.droppedAt !== undefined) e.droppedAt = int(o, 'droppedAt', 0, BIG)
  if (o.dropFrom !== undefined) e.dropFrom = vec3(o, 'dropFrom')
  if (o.posture !== undefined) e.posture = oneOf(o, 'posture', SEATED)
  // wave 8
  if (o.mount !== undefined) e.mount = int(o, 'mount', 0, MAX_ID)
  if (o.rider !== undefined) e.rider = int(o, 'rider', 0, MAX_ID)
  if (o.berserkMs !== undefined) e.berserkMs = int(o, 'berserkMs', 1, BERSERK_MAX_MS)
  if (o.stall !== undefined) e.stall = str(o, 'stall', STALL_TITLE_MAX)
  if (o.guild !== undefined) e.guild = str(o, 'guild', GUILD_TITLE_MAX)
  // Play the Boss (docs/PLAY_THE_BOSS.md §5.2)
  if (o.trance !== undefined && bool(o, 'trance')) e.trance = true
  if (o.piloted !== undefined && bool(o, 'piloted')) e.piloted = true
  if (o.honor !== undefined) e.honor = honorCode(o, 'honor')
  // storms (docs/WEATHER.md §12)
  if (o.charged !== undefined && bool(o, 'charged')) e.charged = true
  return e
}

/** EntityState.honor / entityUpdate.honor: a title code ('' only on entityUpdate = cleared). */
function honorCode(o: Record<string, unknown>, k: string, empty = false): string {
  const s = str(o, k, 32, empty ? 0 : 1)
  if (s !== '' && !PILOT_HONOR.test(s)) fail(`${k} must be a title code`)
  return s
}

/** EntityState.posture: only 'sit' (standing = absent). */
const SEATED = ['sit'] as const

/** Effect lifetimes the client accepts: up to a day. */
const MAX_EFFECT_MS = 86_400_000
/** Cast phases, cooldowns and item casts: up to 10 minutes. */
const MAX_ACTION_MS = 600_000
/** Most skill codes in skills.skills / skillsUpdate.learned, and cooldown entries. */
const MAX_SKILL_CODES = 512
/** Highest mastery level the wire accepts. */
const MAX_MASTERY_LEVEL = 300

function effectState(v: unknown): EffectState {
  const o = rec(v, 'effect')
  const e: EffectState = { instance: int(o, 'instance', 0, MAX_ID), remainingMs: int(o, 'remainingMs', 0, MAX_EFFECT_MS) }
  if (o.skill !== undefined) e.skill = str(o, 'skill', 128, 1)
  if (o.status !== undefined) e.status = oneOf(o, 'status', SKILL_STATUS_KINDS)
  if (o.level !== undefined) e.level = int(o, 'level', 0, BIG)
  if (o.source !== undefined) e.source = int(o, 'source', 0, MAX_ID)
  return e
}

function hotbarEntry(v: unknown): HotbarEntry | null {
  if (v === null) return null
  const o = rec(v, 'hotbar entry')
  return { kind: oneOf(o, 'kind', HOTBAR_KINDS), code: str(o, 'code', 128, 1) }
}

function hotbarSlotUpdate(v: unknown): { slot: number; entry: HotbarEntry | null } {
  const o = rec(v, 'hotbar update')
  return { slot: int(o, 'slot', 0, MOUSE_SLOT), entry: hotbarEntry(o.entry) }
}

/** Every MasteryCode (missing = 0) or, when partial, only the present ones. Unknown keys are dropped. */
function masteryLevels(v: unknown, partial: boolean): Partial<Record<MasteryCode, number>> {
  const o = rec(v, 'masteries')
  const out: Partial<Record<MasteryCode, number>> = {}
  for (const c of MASTERY_CODES) {
    if (o[c] !== undefined) out[c] = int(o, c, 0, MAX_MASTERY_LEVEL)
    else if (!partial) out[c] = 0
  }
  return out
}

function skillCooldown(v: unknown): SkillCooldown {
  const o = rec(v, 'cooldown')
  return { group: str(o, 'group', 128, 1), readyInMs: int(o, 'readyInMs', 0, MAX_ACTION_MS) }
}

function codeString(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) fail('expected a code string')
  return v
}

function storageUpdate(v: unknown): StorageSlotUpdate {
  const o = rec(v, 'storage update')
  return { slot: int(o, 'slot', 0, MAX_STORAGE_SIZE - 1), item: itemOrNull(o.item, 'item') }
}

function accountStorage(v: unknown): AccountStorage {
  const o = rec(v, 'storage')
  const size = int(o, 'size', 0, MAX_STORAGE_SIZE)
  const slots = boundedList(o, 'slots', MAX_STORAGE_SIZE, (x) => itemOrNull(x, 'storage item'))
  if (slots.length !== size) fail('slots length must equal size')
  return { size, slots, gold: int(o, 'gold', 0, MAX_GOLD) }
}

function buybackEntry(v: unknown): BuybackEntry {
  const o = rec(v, 'buyback entry')
  return { item: itemStack(o.item, 'item'), price: int(o, 'price', 0, BIG) }
}

/** { [EquipSlot]: item code }; unknown slots are dropped. */
function equipCodes(v: unknown): Partial<Record<EquipSlot, string>> {
  const o = rec(v, 'equip')
  const out: Partial<Record<EquipSlot, string>> = {}
  for (const s of EQUIP_SLOTS) if (o[s] !== undefined) out[s] = str(o, s, 128, 1)
  return out
}

/** EntityState.equipPlus / appearance `plus` / CharacterSummary.equipPlus: +N per equip slot (0 is dropped). */
function equipPlus(v: unknown): Partial<Record<EquipSlot, number>> {
  const o = rec(v, 'equip plus')
  const out: Partial<Record<EquipSlot, number>> = {}
  for (const s of EQUIP_SLOTS) {
    if (o[s] === undefined) continue
    const n = int(o, s, 0, 255)
    if (n > 0) out[s] = n
  }
  return out
}

function itemStack(v: unknown, what: string): ItemStack {
  const o = rec(v, what)
  const s: ItemStack = { code: str(o, 'code', 128, 1), count: int(o, 'count', 1, BIG) }
  if (o.plus !== undefined) s.plus = int(o, 'plus', 0, 255)
  if (o.durability !== undefined) s.durability = num(o, 'durability', 0, BIG)
  return s
}

function itemOrNull(v: unknown, what: string): ItemStack | null {
  return v === null ? null : itemStack(v, what)
}

function range2(o: Record<string, unknown>, k: string): [number, number] {
  const v = o[k]
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) fail(`${k} must be [min, max]`)
  return [v[0], v[1]]
}

const RANGE_STATS = new Set<keyof PlayerStats>(['physAttack', 'magAttack'])

/** Full PlayerStats, or (partial) only the keys present. Unknown keys are dropped. */
function playerStats(v: unknown, partial: boolean): Partial<PlayerStats> {
  const o = rec(v, 'stats')
  const out: Record<string, unknown> = {}
  for (const k of PLAYER_STAT_KEYS) {
    if (o[k] === undefined) {
      if (!partial) fail(`missing stat ${k}`)
      continue
    }
    out[k] = RANGE_STATS.has(k) ? range2(o, k) : num(o, k, 0, BIG)
  }
  // Wave 8 (D33): kept when present (full or partial), never required.
  for (const k of PLAYER_STAT_OPTIONAL_KEYS) if (o[k] !== undefined) out[k] = int(o, k, 0, HWAN_MAX)
  return out as Partial<PlayerStats>
}

function combatHit(v: unknown): CombatHit {
  const o = rec(v, 'hit')
  const h: CombatHit = { outcome: oneOf(o, 'outcome', HIT_OUTCOMES), damage: int(o, 'damage', 0, BIG), hp: int(o, 'hp', 0, BIG) }
  if (o.status !== undefined) h.status = oneOf(o, 'status', SKILL_STATUS_KINDS)
  if (o.down !== undefined && bool(o, 'down')) h.down = true
  if (o.pos !== undefined) h.pos = vec3(o, 'pos')
  if (o.hwan !== undefined && bool(o, 'hwan')) h.hwan = true
  return h
}

function statGain(v: unknown): StatGain {
  const o = rec(v, 'gain')
  const g: StatGain = { exp: num(o, 'exp', 0, BIG), spExp: num(o, 'spExp', 0, BIG) }
  if (o.from !== undefined) g.from = int(o, 'from', 0, Number.MAX_SAFE_INTEGER)
  if (o.quest !== undefined) g.quest = str(o, 'quest', 64, 1)
  return g
}

// ---- wave 4: quests and party ----

/** Most active quests / done entries a `quests` snapshot may carry (the server caps active at MAX_ACTIVE_QUESTS). */
const MAX_WIRE_ACTIVE_QUESTS = 64
const MAX_WIRE_DONE_QUESTS = 4096

function questProgress(v: unknown): QuestProgress {
  const o = rec(v, 'quest progress')
  const co = rec(o.counts, 'counts')
  const keys = Object.keys(co)
  if (keys.length > MAX_QUEST_OBJECTIVES) fail(`counts must have at most ${MAX_QUEST_OBJECTIVES} entries`)
  const counts: Record<string, number> = {}
  for (const k of keys) {
    if (!OBJECTIVE_ID.test(k)) fail('counts keys must be objective ids')
    counts[k] = int(co, k, 0, BIG)
  }
  const q: QuestProgress = {
    quest: str(o, 'quest', 64, 1),
    rev: int(o, 'rev', 0, MAX_ID),
    status: oneOf(o, 'status', QUEST_STATUSES),
    counts,
    items: boundedList(o, 'items', MAX_QUEST_BAG_CODES, questBagItem),
    acceptedAt: num(o, 'acceptedAt', 0, BIG),
  }
  if (o.encounterUntil !== undefined) q.encounterUntil = num(o, 'encounterUntil', 0, BIG)
  return q
}

function questBagItem(v: unknown): { code: string; count: number } {
  const o = rec(v, 'quest item')
  return { code: str(o, 'code', 128, 1), count: int(o, 'count', 1, BIG) }
}

function questDone(v: unknown): QuestDoneEntry {
  const o = rec(v, 'quest done')
  const d: QuestDoneEntry = { quest: str(o, 'quest', 64, 1), times: int(o, 'times', 1, BIG), lastAt: num(o, 'lastAt', 0, BIG) }
  if (o.availableAt !== undefined) d.availableAt = num(o, 'availableAt', 0, BIG)
  return d
}

function xz(o: Record<string, unknown>, k: string): [number, number] {
  const v = o[k]
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) fail(`${k} must be [x, z]`)
  return [v[0], v[1]]
}

function entityOrNull(o: Record<string, unknown>, k: string): number | null {
  return o[k] === null ? null : int(o, k, 0, MAX_ID)
}

function partyMember(v: unknown): PartyMember {
  const o = rec(v, 'party member')
  const m: PartyMember = {
    characterId: int(o, 'characterId', 1, MAX_ID),
    name: str(o, 'name', 64, 1),
    model: str(o, 'model', 128, 1),
    level: int(o, 'level', 0, BIG),
    entity: entityOrNull(o, 'entity'),
    hp: int(o, 'hp', 0, BIG),
    maxHp: int(o, 'maxHp', 0, BIG),
    mp: int(o, 'mp', 0, BIG),
    maxMp: int(o, 'maxMp', 0, BIG),
  }
  if (o.dead !== undefined) m.dead = bool(o, 'dead')
  if (o.pos !== undefined) m.pos = xz(o, 'pos')
  return m
}

function partyState(v: unknown): PartyState | null {
  if (v === null) return null
  const o = rec(v, 'party')
  const members = boundedList(o, 'members', PARTY_MAX, partyMember)
  if (members.length < 1) fail('a party has at least one member')
  return {
    id: int(o, 'id', 0, MAX_ID),
    leader: int(o, 'leader', 1, MAX_ID),
    exp: oneOf(o, 'exp', PARTY_MODES),
    items: oneOf(o, 'items', PARTY_MODES),
    members,
  }
}

function partyVitals(v: unknown): PartyVitals {
  const o = rec(v, 'party vitals')
  const m: PartyVitals = { characterId: int(o, 'characterId', 1, MAX_ID) }
  if (o.entity !== undefined) m.entity = entityOrNull(o, 'entity')
  if (o.level !== undefined) m.level = int(o, 'level', 0, BIG)
  if (o.hp !== undefined) m.hp = int(o, 'hp', 0, BIG)
  if (o.maxHp !== undefined) m.maxHp = int(o, 'maxHp', 0, BIG)
  if (o.mp !== undefined) m.mp = int(o, 'mp', 0, BIG)
  if (o.maxMp !== undefined) m.maxMp = int(o, 'maxMp', 0, BIG)
  if (o.dead !== undefined) m.dead = bool(o, 'dead')
  if (o.pos !== undefined) m.pos = xz(o, 'pos')
  return m
}

function inventory(v: unknown): Inventory {
  const o = rec(v, 'inventory')
  const bagSize = int(o, 'bagSize', 0, MAX_BAG_SIZE)
  const bag = list(o, 'bag', (x) => itemOrNull(x, 'bag item'))
  if (bag.length !== bagSize) fail('bag length must equal bagSize')
  const eo = rec(o.equip, 'equip')
  const equip: Partial<Record<EquipSlot, ItemStack>> = {}
  for (const s of EQUIP_SLOTS) if (eo[s] !== undefined && eo[s] !== null) equip[s] = itemStack(eo[s], s)
  return { bagSize, bag, equip, gold: int(o, 'gold', 0, BIG) }
}

function bagUpdate(v: unknown): BagSlotUpdate {
  const o = rec(v, 'bag update')
  return { slot: int(o, 'slot', 0, MAX_BAG_SIZE - 1), item: itemOrNull(o.item, 'item') }
}

function equipUpdate(v: unknown): EquipSlotUpdate {
  const o = rec(v, 'equip update')
  return { slot: oneOf<EquipSlot>(o, 'slot', EQUIP_SLOTS), item: itemOrNull(o.item, 'item') }
}

function worldInfo(v: unknown): WorldInfo {
  const o = rec(v, 'world')
  const w: WorldInfo = { name: str(o, 'name', 64, 1), serverTime: num(o, 'serverTime', 0, BIG), tickRate: num(o, 'tickRate', 0, BIG) }
  if (o.levelCap !== undefined) w.levelCap = int(o, 'levelCap', 1, 300)
  // wave 8 (docs/WAVE_PLAN2.md §3.2.2)
  if (o.alchemyRate !== undefined) w.alchemyRate = num(o, 'alchemyRate', 0, 1000)
  if (o.alchemyMaxPlus !== undefined) w.alchemyMaxPlus = int(o, 'alchemyMaxPlus', 1, 12)
  if (o.social !== undefined) {
    const s = rec(o.social, 'social')
    w.social = { guildCreateGold: int(s, 'guildCreateGold', 0, MAX_GOLD), guildCreateLevel: int(s, 'guildCreateLevel', 1, 300) }
  }
  // wave 9 (docs/WAVE_PLAN3.md §3.4): a bad clock or weather drops only that field, never the whole worldEnter
  if (o.clock !== undefined) optionalField('world.clock', () => (w.clock = clockState(o.clock)))
  if (o.weather !== undefined) optionalField('world.weather', () => (w.weather = weatherSync(o.weather)))
  return w
}

/** A placed lightning strike (docs/WEATHER.md §2.7): every field checked, unknown keys dropped. */
function lightningStrike(v: unknown): LightningStrike {
  const o = rec(v, 'strike')
  const pos = vec3(o, 'pos')
  if (pos.some((c) => Math.abs(c) > STRIKE_LIMITS.coord)) fail('pos out of range')
  const s: LightningStrike = {
    id: int(o, 'id', 1, 0xffffffff),
    at: num(o, 'at', 0, BIG),
    kind: oneOf(o, 'kind', STRIKE_KINDS),
    pos,
    radiusM: num(o, 'radiusM', 0, STRIKE_LIMITS.radiusM),
    seed: int(o, 'seed', 0, 0xffffffff),
  }
  if (o.warnAt !== undefined) {
    s.warnAt = num(o, 'warnAt', 0, BIG)
    if (s.warnAt > s.at) fail('warnAt after at')
  }
  if (o.groundY !== undefined) s.groundY = num(o, 'groundY', -STRIKE_LIMITS.coord, STRIKE_LIMITS.coord)
  if (o.target !== undefined) s.target = int(o, 'target', 1, MAX_ID)
  if (o.source !== undefined) s.source = oneOf(o, 'source', STRIKE_SOURCES)
  return s
}

/** A world point of the tornado messages: finite and inside TORNADO_LIMITS.coord. */
function tornadoPoint(o: Record<string, unknown>, k: string): Vec3 {
  const p = vec3(o, k)
  if (p.some((c) => Math.abs(c) > TORNADO_LIMITS.coord)) fail(`${k} out of range`)
  return p
}

/** A lightning tornado (docs/WEATHER.md §13): times in order, a path of 1..TORNADO_LIMITS.path points. */
function tornadoState(v: unknown): TornadoState {
  const o = rec(v, 'tornado')
  const path = boundedList(o, 'path', TORNADO_LIMITS.path, (p) => {
    if (!Array.isArray(p) || p.length !== 3) fail('path point must be a Vec3')
    return tornadoPoint({ p }, 'p')
  })
  if (path.length === 0) fail('path is empty')
  const s: TornadoState = {
    id: int(o, 'id', 1, 0xffffffff),
    seed: int(o, 'seed', 0, 0xffffffff),
    warnAt: num(o, 'warnAt', 0, BIG),
    touchAt: num(o, 'touchAt', 0, BIG),
    endAt: num(o, 'endAt', 0, BIG),
    path,
    speedMs: num(o, 'speedMs', 0, TORNADO_LIMITS.speedMs),
    pullM: num(o, 'pullM', 0, TORNADO_LIMITS.radiusM),
    coreM: num(o, 'coreM', 0, TORNADO_LIMITS.radiusM),
    strength: num(o, 'strength', 0, TORNADO_LIMITS.strength),
  }
  if (s.warnAt > s.touchAt || s.touchAt > s.endAt) fail('tornado times out of order')
  if (o.liftAt !== undefined) s.liftAt = num(o, 'liftAt', 0, BIG)
  if (o.area !== undefined) s.area = str(o, 'area', 64)
  if (o.gm !== undefined && bool(o, 'gm')) s.gm = true
  return s
}

/** The storm status (docs/WEATHER.md §12): unknown effect ids fail the message (the list is closed, like the phases). */
function stormStatus(v: unknown): StormStatus {
  const o = rec(v, 'storm')
  const s: StormStatus = {
    phase: oneOf(o, 'phase', STORM_PHASES),
    effects: boundedList(o, 'effects', STORM_LIMITS.effects, (e): StormEffect => {
      const r = rec(e, 'effect')
      const x: StormEffect = { id: oneOf(r, 'id', STORM_EFFECT_IDS) }
      if (r.pct !== undefined) x.pct = int(r, 'pct', -STORM_LIMITS.pct, STORM_LIMITS.pct)
      return x
    }),
  }
  if (o.startsAt !== undefined) s.startsAt = num(o, 'startsAt', 0, BIG)
  if (o.endsAt !== undefined) s.endsAt = num(o, 'endsAt', 0, BIG)
  return s
}

/** Runs one optional sub-parse; an invalid value is dropped with a console warning instead of failing the message. */
function optionalField(what: string, parse: () => void): void {
  try {
    parse()
  } catch (e) {
    if (!(e instanceof Invalid)) throw e
    console.warn(`protocol: dropped ${what}: ${e.message}`)
  }
}

// ---- wave 9: clock and weather (docs/WAVE_PLAN3.md §3.4) ----

const TAU = Math.PI * 2

function clockState(v: unknown): WorldClockState {
  const o = rec(v, 'clock')
  return {
    anchorMs: int(o, 'anchorMs', 0, MAX_ID),
    anchorDays: num(o, 'anchorDays', CLOCK_LIMITS.anchorDays[0], CLOCK_LIMITS.anchorDays[1]),
    dayMs: int(o, 'dayMs', CLOCK_LIMITS.dayMs[0], CLOCK_LIMITS.dayMs[1]),
    running: bool(o, 'running'),
    nightSpeedup: num(o, 'nightSpeedup', CLOCK_LIMITS.nightSpeedup[0], CLOCK_LIMITS.nightSpeedup[1]),
    declination: num(o, 'declination', CLOCK_LIMITS.declination[0], CLOCK_LIMITS.declination[1]),
  }
}

function weatherSync(v: unknown): WeatherSync {
  const o = rec(v, 'weather')
  const w: WeatherSync = {
    start: num(o, 'start', 0, BIG),
    dur: num(o, 'dur', 0, WEATHER_LIMITS.durMs),
    from: oneOf(o, 'from', WEATHER_KINDS),
    to: oneOf(o, 'to', WEATHER_KINDS),
    intensity: num(o, 'intensity', RAIN_INTENSITY_MIN, 1),
    until: num(o, 'until', 0, BIG),
    windDir: num(o, 'windDir', 0, TAU),
    windMs: num(o, 'windMs', 0, WEATHER_LIMITS.windMs),
    wet: num(o, 'wet', 0, 1),
    puddle: num(o, 'puddle', 0, 1),
    at: num(o, 'at', 0, BIG),
    seed: int(o, 'seed', 0, 0xffffffff),
  }
  if (o.gm !== undefined && bool(o, 'gm')) w.gm = true
  if (o.fromVec !== undefined) {
    // Additive (W9F P1): a malformed start vector is dropped on its own; the client then blends from P[from].
    try {
      w.fromVec = weatherVec(o.fromVec)
    } catch {
      // ignored
    }
  }
  return w
}

/** A weather parameter vector (WeatherSync.fromVec): every field 0..1, wind in m/s, lightning per minute. */
function weatherVec(v: unknown): WeatherParams {
  const o = rec(v, 'fromVec')
  const unit = (k: string) => num(o, k, 0, 1)
  return {
    cloud: unit('cloud'),
    cloudDark: unit('cloudDark'),
    cirrus: unit('cirrus'),
    rain: unit('rain'),
    windMs: num(o, 'windMs', 0, WEATHER_LIMITS.windMs),
    gust: unit('gust'),
    fog: unit('fog'),
    sun: unit('sun'),
    desat: unit('desat'),
    lightning: num(o, 'lightning', 0, 60),
  }
}

// ---- wave 8: trade, stalls, guilds ----

/** An array of exactly `n` entries (checked before any entry is parsed). */
function exactList<T>(o: Record<string, unknown>, k: string, n: number, item: (v: unknown) => T): T[] {
  const v = o[k]
  if (!Array.isArray(v) || v.length !== n) fail(`${k} must have exactly ${n} entries`)
  return v.map(item)
}

function tradeItem(v: unknown): TradeItem | null {
  if (v === null) return null
  const o = rec(v, 'trade item')
  const t: TradeItem = { stack: itemStack(o.stack, 'stack') }
  if (o.bag !== undefined) t.bag = int(o, 'bag', 0, MAX_BAG_SIZE - 1)
  return t
}

function tradeSide(v: unknown): TradeSide {
  const o = rec(v, 'trade side')
  return {
    items: exactList(o, 'items', TRADE_SLOTS, tradeItem),
    gold: int(o, 'gold', 0, MAX_GOLD),
    locked: bool(o, 'locked'),
    accepted: bool(o, 'accepted'),
  }
}

function tradeState(v: unknown): TradeState {
  const o = rec(v, 'trade')
  return {
    partner: int(o, 'partner', 0, MAX_ID),
    name: str(o, 'name', 64, 1),
    level: int(o, 'level', 0, BIG),
    mine: tradeSide(o.mine),
    theirs: tradeSide(o.theirs),
  }
}

function stallListing(v: unknown): StallListing | null {
  if (v === null) return null
  const o = rec(v, 'stall listing')
  const l: StallListing = { stack: itemStack(o.stack, 'stack'), price: int(o, 'price', 1, STALL_PRICE_MAX) }
  if (o.bag !== undefined) l.bag = int(o, 'bag', 0, MAX_BAG_SIZE - 1)
  return l
}

function stallView(v: unknown): StallView | null {
  if (v === null) return null
  const o = rec(v, 'stall')
  return {
    owner: int(o, 'owner', 0, MAX_ID),
    name: str(o, 'name', 64, 1),
    title: str(o, 'title', STALL_TITLE_MAX),
    greeting: str(o, 'greeting', STALL_GREETING_MAX),
    state: oneOf(o, 'state', STALL_MODES),
    items: exactList(o, 'items', STALL_SLOTS, stallListing),
    visitors: int(o, 'visitors', 0, STALL_VISITORS_MAX),
  }
}

function guildMember(v: unknown): GuildMember {
  const o = rec(v, 'guild member')
  return {
    characterId: int(o, 'characterId', 1, MAX_ID),
    name: str(o, 'name', 64, 1),
    model: str(o, 'model', 128, 1),
    level: int(o, 'level', 0, BIG),
    rank: oneOf(o, 'rank', GUILD_RANKS),
    perms: guildPerms(o, 'perms'),
    title: str(o, 'title', GUILD_TITLE_MAX),
    online: bool(o, 'online'),
    lastSeen: num(o, 'lastSeen', 0, BIG),
    joinedAt: num(o, 'joinedAt', 0, BIG),
  }
}

function guildState(v: unknown): GuildState | null {
  if (v === null) return null
  const o = rec(v, 'guild')
  const members = boundedList(o, 'members', GUILD_MEMBERS_MAX, guildMember)
  if (members.length < 1) fail('a guild has at least one member')
  const n = rec(o.notice, 'notice')
  return {
    id: int(o, 'id', 1, MAX_ID),
    name: str(o, 'name', 64, 1),
    master: int(o, 'master', 1, MAX_ID),
    createdAt: num(o, 'createdAt', 0, BIG),
    notice: { title: str(n, 'title', GUILD_NOTICE_TITLE_MAX), text: str(n, 'text', GUILD_NOTICE_MAX), at: num(n, 'at', 0, BIG) },
    maxMembers: int(o, 'maxMembers', 1, GUILD_MEMBERS_MAX),
    members,
  }
}

function list<T>(o: Record<string, unknown>, k: string, item: (v: unknown) => T): T[] {
  const v = o[k]
  if (!Array.isArray(v)) fail(`${k} must be an array`)
  return v.map(item)
}

/** list() with at most `max` entries (checked before any entry is parsed). */
function boundedList<T>(o: Record<string, unknown>, k: string, max: number, item: (v: unknown) => T): T[] {
  const v = o[k]
  if (Array.isArray(v) && v.length > max) fail(`${k} must have at most ${max} entries`)
  return list(o, k, item)
}

function serverMessage(v: unknown): ServerMessage {
  const o = rec(v, 'message')
  switch (o.t) {
    case 'welcome': {
      const m: ServerMessage = { t: 'welcome', account: str(o, 'account', 64, 1), server: serverInfo(o.server), slots: int(o, 'slots', 0, BIG) }
      if (o.role !== undefined) m.role = oneOf<Role>(o, 'role', ROLES)
      return m
    }
    case 'error': {
      const m: ServerMessage = { t: 'error', code: oneOf(o, 'code', ERROR_CODES), message: str(o, 'message', 1000) }
      if (o.re !== undefined) m.re = oneOf(o, 're', Object.keys(CLIENT_KEYS) as ClientMessage['t'][])
      return m
    }
    case 'charList':
      return { t: 'charList', slots: int(o, 'slots', 0, BIG), characters: list(o, 'characters', character) }
    case 'nameCheck': {
      const m: ServerMessage = { t: 'nameCheck', name: str(o, 'name', 64), available: bool(o, 'available') }
      if (o.reason !== undefined) m.reason = str(o, 'reason', 200)
      return m
    }
    case 'charCreated':
      return { t: 'charCreated', character: character(o.character) }
    case 'charDeleted':
      return { t: 'charDeleted', id: int(o, 'id', 1, Number.MAX_SAFE_INTEGER) }
    case 'worldEnter': {
      const m: ServerMessage = { t: 'worldEnter', self: entity(o.self), world: worldInfo(o.world), entities: list(o, 'entities', entity) }
      if (o.role !== undefined) m.role = oneOf<Role>(o, 'role', ROLES)
      return m
    }
    case 'worldLeft':
      return { t: 'worldLeft' }
    case 'spawn':
      return { t: 'spawn', entity: entity(o.entity) }
    case 'despawn':
      return { t: 'despawn', id: int(o, 'id', 0, Number.MAX_SAFE_INTEGER) }
    case 'move':
      return { t: 'move', id: int(o, 'id', 0, Number.MAX_SAFE_INTEGER), move: moveState(o.move) }
    case 'stop':
      return { t: 'stop', id: int(o, 'id', 0, Number.MAX_SAFE_INTEGER), pos: vec3(o, 'pos'), yaw: num(o, 'yaw', -BIG, BIG) }
    case 'chat': {
      const m: ServerMessage = { t: 'chat', channel: oneOf(o, 'channel', CHAT_CHANNELS), text: str(o, 'text', 1000) }
      if (o.fromId !== undefined) m.fromId = int(o, 'fromId', 0, Number.MAX_SAFE_INTEGER)
      if (o.from !== undefined) m.from = str(o, 'from', 64)
      if (o.to !== undefined) m.to = str(o, 'to', 64)
      return m
    }
    case 'pong':
      return { t: 'pong', n: int(o, 'n', 0, Number.MAX_SAFE_INTEGER), clientTime: num(o, 'clientTime', -BIG, BIG), serverTime: num(o, 'serverTime', 0, BIG) }
    case 'gmResult': {
      const m: ServerMessage = { t: 'gmResult', ok: bool(o, 'ok'), cmd: str(o, 'cmd', 64), message: str(o, 'message', 8000) }
      if (o.data !== undefined) m.data = o.data
      return m
    }
    case 'notice': {
      const m: ServerMessage = { t: 'notice', text: str(o, 'text', 1000, 1) }
      if (o.from !== undefined) m.from = str(o, 'from', 64)
      return m
    }
    case 'warp':
      return { t: 'warp', id: int(o, 'id', 0, Number.MAX_SAFE_INTEGER), pos: vec3(o, 'pos'), yaw: num(o, 'yaw', -BIG, BIG) }
    case 'entityUpdate': {
      const m: ServerMessage = { t: 'entityUpdate', id: int(o, 'id', 0, Number.MAX_SAFE_INTEGER) }
      if (o.level !== undefined) m.level = int(o, 'level', 0, BIG)
      if (o.name !== undefined) m.name = str(o, 'name', 64, 1)
      if (o.invisible !== undefined) m.invisible = bool(o, 'invisible')
      if (o.hp !== undefined) m.hp = int(o, 'hp', 0, BIG)
      if (o.maxHp !== undefined) m.maxHp = int(o, 'maxHp', 0, BIG)
      if (o.state !== undefined) m.state = oneOf(o, 'state', LIFE_STATES)
      if (o.gm !== undefined) m.gm = bool(o, 'gm')
      if (o.posture !== undefined) m.posture = oneOf(o, 'posture', POSTURES)
      // wave 8: null = dismounted / parked, 0 = Berserk ended, '' = no stall / no guild
      if (o.mount !== undefined) m.mount = entityOrNull(o, 'mount')
      if (o.rider !== undefined) m.rider = entityOrNull(o, 'rider')
      if (o.berserkMs !== undefined) m.berserkMs = int(o, 'berserkMs', 0, BERSERK_MAX_MS)
      if (o.stall !== undefined) m.stall = str(o, 'stall', STALL_TITLE_MAX)
      if (o.guild !== undefined) m.guild = str(o, 'guild', GUILD_TITLE_MAX)
      // Play the Boss
      if (o.trance !== undefined) m.trance = bool(o, 'trance')
      if (o.piloted !== undefined) m.piloted = bool(o, 'piloted')
      if (o.honor !== undefined) m.honor = honorCode(o, 'honor', true)
      // storms (docs/WEATHER.md §12)
      if (o.charged !== undefined) m.charged = bool(o, 'charged')
      return m
    }
    case 'role':
      return { t: 'role', role: oneOf<Role>(o, 'role', ROLES) }
    case 'actionResult': {
      const m: ServerMessage = { t: 'actionResult', re: oneOf(o, 're', GAMEPLAY_REQUESTS), ok: bool(o, 'ok') }
      if (o.reason !== undefined) m.reason = oneOf(o, 'reason', ACTION_FAIL_REASONS)
      if (o.message !== undefined) m.message = str(o, 'message', 1000)
      return m
    }
    case 'combat': {
      const hits = list(o, 'hits', combatHit)
      if (hits.length < 1 || hits.length > MAX_COMBAT_HITS) fail(`hits must have 1-${MAX_COMBAT_HITS} entries`)
      const m: ServerMessage = { t: 'combat', attacker: int(o, 'attacker', 0, MAX_ID), target: int(o, 'target', 0, MAX_ID), hits }
      if (o.skill !== undefined) m.skill = str(o, 'skill', 128, 1)
      if (o.killed !== undefined) m.killed = bool(o, 'killed')
      if (o.instance !== undefined) m.instance = int(o, 'instance', 0, MAX_ID)
      if (o.at !== undefined) m.at = num(o, 'at', 0, BIG)
      if (o.aoe !== undefined && bool(o, 'aoe')) m.aoe = true
      // Lightning (docs/WEATHER.md §2.7): damage without an attacker (attacker 0)
      if (o.cause !== undefined) m.cause = oneOf(o, 'cause', HAZARD_CAUSES)
      if (o.strike !== undefined) m.strike = int(o, 'strike', 1, 0xffffffff)
      return m
    }
    case 'stats':
      return { t: 'stats', stats: playerStats(o.stats, false) as PlayerStats }
    case 'statsDelta': {
      const m: ServerMessage = { t: 'statsDelta', stats: playerStats(o.stats, true) }
      if (o.gain !== undefined) m.gain = statGain(o.gain)
      return m
    }
    case 'levelUp':
      return { t: 'levelUp', id: int(o, 'id', 0, MAX_ID), level: int(o, 'level', 0, BIG) }
    case 'inventory':
      return { t: 'inventory', inventory: inventory(o.inventory) }
    case 'inventoryUpdate': {
      const m: ServerMessage = { t: 'inventoryUpdate' }
      if (o.bag !== undefined) m.bag = list(o, 'bag', bagUpdate)
      if (o.equip !== undefined) m.equip = list(o, 'equip', equipUpdate)
      if (o.gold !== undefined) m.gold = int(o, 'gold', 0, BIG)
      return m
    }
    case 'appearance':
      return { t: 'appearance', id: int(o, 'id', 0, MAX_ID), equip: equipCodes(o.equip), ...(o.plus !== undefined ? { plus: equipPlus(o.plus) } : {}) }
    // ---- wave 3 ----
    case 'skills': {
      const hotbar = boundedList(o, 'hotbar', HOTBAR_SLOTS, hotbarEntry)
      if (hotbar.length !== HOTBAR_SLOTS) fail(`hotbar must have ${HOTBAR_SLOTS} entries`)
      const m: ServerMessage = {
        t: 'skills',
        masteries: masteryLevels(o.masteries, false) as Record<MasteryCode, number>,
        skills: boundedList(o, 'skills', MAX_SKILL_CODES, codeString),
        hotbar,
      }
      if (o.cooldowns !== undefined) m.cooldowns = boundedList(o, 'cooldowns', MAX_SKILL_CODES, skillCooldown)
      if (o.mouse !== undefined) {
        const mouse = hotbarEntry(o.mouse)
        if (mouse) m.mouse = mouse
      }
      return m
    }
    case 'skillsUpdate': {
      const m: ServerMessage = { t: 'skillsUpdate' }
      if (o.masteries !== undefined) m.masteries = masteryLevels(o.masteries, true)
      if (o.learned !== undefined) m.learned = boundedList(o, 'learned', MAX_SKILL_CODES, codeString)
      if (o.hotbar !== undefined) m.hotbar = boundedList(o, 'hotbar', MOUSE_SLOT + 1, hotbarSlotUpdate)
      return m
    }
    case 'cast': {
      const m: ServerMessage = {
        t: 'cast',
        id: int(o, 'id', 0, MAX_ID),
        skill: str(o, 'skill', 128, 1),
        instance: int(o, 'instance', 0, MAX_ID),
        prepareMs: int(o, 'prepareMs', 0, MAX_ACTION_MS),
        castMs: int(o, 'castMs', 0, MAX_ACTION_MS),
        actionMs: int(o, 'actionMs', 0, MAX_ACTION_MS),
      }
      if (o.target !== undefined) m.target = int(o, 'target', 0, MAX_ID)
      if (o.instant !== undefined) m.instant = bool(o, 'instant')
      // Play the Boss: the clip type of a server-built ability
      if (o.clip !== undefined) {
        const clip = str(o, 'clip', 32, 1)
        if (!/^[A-Z0-9_]{1,32}$/.test(clip)) fail('clip must be a clip type')
        m.clip = clip
      }
      return m
    }
    case 'castEnd':
      return { t: 'castEnd', id: int(o, 'id', 0, MAX_ID), instance: int(o, 'instance', 0, MAX_ID), reason: oneOf(o, 'reason', CAST_END_REASONS) }
    case 'effectAdd':
      return { t: 'effectAdd', id: int(o, 'id', 0, MAX_ID), effect: effectState(o.effect) }
    case 'effectRemove': {
      const m: ServerMessage = { t: 'effectRemove', id: int(o, 'id', 0, MAX_ID), instance: int(o, 'instance', 0, MAX_ID) }
      if (o.reason !== undefined) m.reason = oneOf(o, 'reason', EFFECT_REMOVE_REASONS)
      return m
    }
    case 'npcDialog': {
      const services = boundedList(o, 'services', NPC_SERVICES.length, (x) => oneOf({ service: x }, 'service', NPC_SERVICES))
      if (new Set(services).size !== services.length) fail('services has duplicate entries')
      const m: ServerMessage = { t: 'npcDialog', npc: int(o, 'npc', 0, MAX_ID), code: str(o, 'code', 128, 1), services }
      if (o.lines !== undefined) m.lines = boundedList(o, 'lines', MAX_NPC_DIALOG_LINES, (x) => str({ line: x }, 'line', MAX_NPC_DIALOG_LINE, 1))
      return m
    }
    case 'npcDialogClose':
      return { t: 'npcDialogClose', npc: int(o, 'npc', 0, MAX_ID), reason: oneOf(o, 'reason', NPC_CLOSE_REASONS) }
    case 'storage':
      return { t: 'storage', storage: accountStorage(o.storage) }
    case 'storageUpdate': {
      const m: ServerMessage = { t: 'storageUpdate' }
      if (o.slots !== undefined) m.slots = boundedList(o, 'slots', MAX_STORAGE_SIZE, storageUpdate)
      if (o.gold !== undefined) m.gold = int(o, 'gold', 0, MAX_GOLD)
      return m
    }
    case 'buyback':
      return { t: 'buyback', entries: boundedList(o, 'entries', BUYBACK_SLOTS, buybackEntry) }
    case 'itemCooldown':
      return {
        t: 'itemCooldown',
        group: str(o, 'group', 128, 1),
        readyInMs: int(o, 'readyInMs', 0, MAX_ACTION_MS),
        totalMs: int(o, 'totalMs', 0, MAX_ACTION_MS),
      }
    case 'itemCast':
      return { t: 'itemCast', id: int(o, 'id', 0, MAX_ID), item: str(o, 'item', 128, 1), castMs: int(o, 'castMs', 0, MAX_ACTION_MS) }
    case 'itemCastEnd':
      return { t: 'itemCastEnd', id: int(o, 'id', 0, MAX_ID), item: str(o, 'item', 128, 1), reason: oneOf(o, 'reason', ITEM_CAST_END_REASONS) }
    // ---- wave 4 ----
    case 'quests':
      return {
        t: 'quests',
        active: boundedList(o, 'active', MAX_WIRE_ACTIVE_QUESTS, questProgress),
        done: boundedList(o, 'done', MAX_WIRE_DONE_QUESTS, questDone),
        rev: int(o, 'rev', 0, MAX_ID),
      }
    case 'questUpdate': {
      if (!has(o, 'progress')) fail('missing field progress')
      const m: ServerMessage = {
        t: 'questUpdate',
        quest: str(o, 'quest', 64, 1),
        event: oneOf(o, 'event', QUEST_EVENTS),
        progress: o.progress === null ? null : questProgress(o.progress),
      }
      if (o.done !== undefined) m.done = questDone(o.done)
      if (o.objective !== undefined) m.objective = str(o, 'objective', 24, 1)
      return m
    }
    case 'contentChanged':
      return { t: 'contentChanged', kind: oneOf(o, 'kind', CONTENT_CHANGE_KINDS), rev: int(o, 'rev', 0, MAX_ID) }
    case 'partyInvited':
      return {
        t: 'partyInvited',
        inviter: int(o, 'inviter', 0, MAX_ID),
        name: str(o, 'name', 64, 1),
        level: int(o, 'level', 0, BIG),
        exp: oneOf(o, 'exp', PARTY_MODES),
        items: oneOf(o, 'items', PARTY_MODES),
        expiresInMs: int(o, 'expiresInMs', 0, MAX_ACTION_MS),
      }
    case 'party':
      if (!has(o, 'party')) fail('missing field party')
      return { t: 'party', party: partyState(o.party) }
    case 'partyVitals':
      return { t: 'partyVitals', members: boundedList(o, 'members', PARTY_MAX, partyVitals) }
    case 'partyEvent':
      return { t: 'partyEvent', event: oneOf(o, 'event', PARTY_EVENT_KINDS), name: str(o, 'name', 64) }
    // ---- wave 7B ----
    case 'itemEffect':
      return { t: 'itemEffect', id: int(o, 'id', 0, MAX_ID), item: str(o, 'item', 128, 1) }
    case 'emote':
      return { t: 'emote', id: int(o, 'id', 0, MAX_ID), emote: oneOf(o, 'emote', EMOTE_KINDS) }
    // ---- wave 8 ----
    case 'alchemyStart':
      return { t: 'alchemyStart', item: int(o, 'item', 0, MAX_BAG_SIZE - 1), readyInMs: int(o, 'readyInMs', 0, ALCHEMY_FUSE_MAX_MS) }
    case 'alchemyResult':
      return {
        t: 'alchemyResult',
        item: int(o, 'item', 0, MAX_BAG_SIZE - 1),
        code: str(o, 'code', 128, 1),
        outcome: oneOf(o, 'outcome', ALCHEMY_OUTCOMES),
        plus: int(o, 'plus', 0, 255),
      }
    case 'tradeRequested':
      return {
        t: 'tradeRequested',
        from: int(o, 'from', 0, MAX_ID),
        name: str(o, 'name', 64, 1),
        level: int(o, 'level', 0, BIG),
        expiresInMs: int(o, 'expiresInMs', 0, MAX_ACTION_MS),
      }
    case 'trade':
      if (!has(o, 'trade')) fail('missing field trade')
      return { t: 'trade', trade: tradeState(o.trade) }
    case 'tradeEnd': {
      const m: ServerMessage = { t: 'tradeEnd', reason: oneOf(o, 'reason', TRADE_END_REASONS) }
      if (o.name !== undefined) m.name = str(o, 'name', 64)
      if (o.message !== undefined) m.message = str(o, 'message', 1000)
      return m
    }
    case 'stall': {
      if (!has(o, 'stall')) fail('missing field stall')
      const m: ServerMessage = { t: 'stall', stall: stallView(o.stall) }
      if (o.reason !== undefined) m.reason = oneOf(o, 'reason', STALL_END_REASONS)
      return m
    }
    case 'stallSold':
      return {
        t: 'stallSold',
        slot: int(o, 'slot', 0, STALL_SLOTS - 1),
        buyer: str(o, 'buyer', 64, 1),
        code: str(o, 'code', 128, 1),
        count: int(o, 'count', 1, BIG),
        price: int(o, 'price', 1, STALL_PRICE_MAX),
      }
    case 'guildInvited':
      return {
        t: 'guildInvited',
        guild: int(o, 'guild', 1, MAX_ID),
        name: str(o, 'name', 64, 1),
        from: str(o, 'from', 64, 1),
        expiresInMs: int(o, 'expiresInMs', 0, MAX_ACTION_MS),
      }
    case 'guild':
      if (!has(o, 'guild')) fail('missing field guild')
      return { t: 'guild', guild: guildState(o.guild) }
    case 'guildMember':
      return { t: 'guildMember', member: guildMember(o.member) }
    case 'guildMemberRemoved':
      return { t: 'guildMemberRemoved', characterId: int(o, 'characterId', 1, MAX_ID) }
    case 'guildEvent':
      return { t: 'guildEvent', event: oneOf(o, 'event', GUILD_EVENT_KINDS), name: str(o, 'name', 64) }
    // wave 9 (docs/WAVE_PLAN3.md §3.4): a malformed frame is rejected, so the client keeps its old state
    case 'worldClock':
      return { t: 'worldClock', clock: clockState(o.clock) }
    case 'weather':
      return { t: 'weather', weather: weatherSync(o.weather) }
    case 'lightning': {
      const m: ServerMessage = {
        t: 'lightning',
        at: num(o, 'at', 0, BIG),
        distM: num(o, 'distM', LIGHTNING_GM_DIST_M[0], LIGHTNING_GM_DIST_M[1]),
        bearing: num(o, 'bearing', 0, TAU),
      }
      if (o.strike !== undefined) m.strike = int(o, 'strike', 1, 0xffffffff)
      return m
    }
    case 'strike':
      return { t: 'strike', strike: lightningStrike(o.strike) }
    // storms (docs/WEATHER.md §12)
    case 'storm':
      return { t: 'storm', storm: stormStatus(o.storm) }
    case 'stormArc': {
      const m: ServerMessage = { t: 'stormArc', from: int(o, 'from', 1, MAX_ID), to: int(o, 'to', 1, MAX_ID), at: num(o, 'at', 0, BIG) }
      if (o.mob !== undefined) m.mob = int(o, 'mob', 1, MAX_ID)
      return m
    }
    // the lightning tornado (docs/WEATHER.md §13)
    case 'tornado':
      return { t: 'tornado', tornado: tornadoState(o.tornado) }
    case 'tornadoEnd':
      return { t: 'tornadoEnd', id: int(o, 'id', 1, 0xffffffff), at: num(o, 'at', 0, BIG) }
    case 'displace': {
      const m: Extract<ServerMessage, { t: 'displace' }> = {
        t: 'displace',
        id: int(o, 'id', 1, MAX_ID),
        kind: oneOf(o, 'kind', ['pull', 'throw'] as const),
        from: tornadoPoint(o, 'from'),
        to: tornadoPoint(o, 'to'),
        at: num(o, 'at', 0, BIG),
        ms: num(o, 'ms', 1, TORNADO_LIMITS.displaceMs),
      }
      if (o.peakM !== undefined) m.peakM = num(o, 'peakM', 0, TORNADO_LIMITS.peakM)
      if (o.tornado !== undefined) m.tornado = int(o, 'tornado', 1, 0xffffffff)
      return m
    }
    // wave 10 (docs/MOVEMENT.md §5)
    case 'jump':
      return { t: 'jump', id: int(o, 'id', 0, MAX_ID), at: num(o, 'at', 0, BIG) }
    case 'uniqueNotice': {
      // wave 11 (docs/WAVE_PLAN7.md §3.1): `by` and `party` only on `defeated`
      const m: Extract<ServerMessage, { t: 'uniqueNotice' }> = {
        t: 'uniqueNotice',
        event: oneOf(o, 'event', UNIQUE_NOTICE_EVENTS),
        mob: str(o, 'mob', 128, 1),
        name: str(o, 'name', 64, 1),
      }
      if (o.area !== undefined) m.area = str(o, 'area', 64)
      if (m.event === 'appeared' && (o.by !== undefined || o.party !== undefined)) fail('by and party are only for defeated')
      if (o.by !== undefined) m.by = str(o, 'by', 64, 1)
      if (o.party !== undefined) m.party = bool(o, 'party')
      // H11-NL-5: `roar` only on `appeared`
      if (o.roar !== undefined) {
        if (m.event !== 'appeared') fail('roar is only for appeared')
        m.roar = bool(o, 'roar')
      }
      // H11-DET-1: the server's stamp (ms)
      if (o.at !== undefined) m.at = num(o, 'at', 0, BIG)
      return m
    }
    // Play the Boss (docs/PLAY_THE_BOSS.md §5.2)
    case 'huntEvent':
    case 'pilotOffer':
    case 'pilotStart':
    case 'pilotState':
    case 'pilotEnd':
    case 'huntPing':
    case 'huntTrail':
    case 'huntRoar':
    case 'huntTaunt':
      return pilotMessage(o)
    default:
      fail('unknown message type')
  }
}

// ---- Play the Boss (docs/PLAY_THE_BOSS.md §5.2) -----------------------------------------------------------------

/** Ability ids -> server ms / counts (pilotState.ready / charges). */
function abilityMap(o: Record<string, unknown>, k: string, max: number): Record<string, number> {
  const r = rec(o[k], k)
  const keys = Object.keys(r)
  if (keys.length > PILOT_KIT_MAX) fail(`${k} has too many abilities`)
  const out: Record<string, number> = {}
  for (const id of keys) {
    if (!PILOT_ABILITY.test(id)) fail(`${k}: bad ability id`)
    out[id] = num(r, id, 0, max)
  }
  return out
}

function huntEventView(v: unknown): HuntEventView {
  const o = rec(v, 'event')
  const e: HuntEventView = { id: int(o, 'id', 0, MAX_ID), mob: str(o, 'mob', 128, 1), name: str(o, 'name', 64, 1), phase: oneOf(o, 'phase', HUNT_PHASES) }
  if (o.callEndsAt !== undefined) e.callEndsAt = num(o, 'callEndsAt', 0, BIG)
  if (o.volunteers !== undefined) e.volunteers = int(o, 'volunteers', 0, BIG)
  if (o.minLevel !== undefined) e.minLevel = int(o, 'minLevel', 0, 1000)
  if (o.you !== undefined) {
    const y = rec(o.you, 'you')
    e.you = { volunteered: bool(y, 'volunteered'), eligible: bool(y, 'eligible') }
    if (y.why !== undefined) e.you.why = oneOf(y, 'why', PILOT_INELIGIBLE)
  }
  if (o.huntEndsAt !== undefined) e.huntEndsAt = num(o, 'huntEndsAt', 0, BIG)
  if (o.downs !== undefined) e.downs = int(o, 'downs', 0, BIG)
  if (o.downsTarget !== undefined) e.downsTarget = int(o, 'downsTarget', 0, BIG)
  if (o.hunters !== undefined) e.hunters = int(o, 'hunters', 0, BIG)
  if (o.area !== undefined) e.area = str(o, 'area', 64)
  if (o.steering !== undefined) e.steering = oneOf(o, 'steering', PILOT_STEERINGS)
  if (o.nextPingAt !== undefined) e.nextPingAt = num(o, 'nextPingAt', 0, BIG)
  if (o.outcome !== undefined) e.outcome = oneOf(o, 'outcome', HUNT_OUTCOMES)
  if (o.pilot !== undefined) e.pilot = str(o, 'pilot', 64, 1)
  return e
}

function pilotKitView(v: unknown): PilotKitView {
  const o = rec(v, 'kit')
  const id = str(o, 'id', 16, 1)
  if (!PILOT_ABILITY.test(id)) fail('kit id must be 1-16 letters a-z')
  const k: PilotKitView = {
    id,
    slot: int(o, 'slot', 1, PILOT_KIT_MAX),
    clip: str(o, 'clip', 32),
    rangeM: num(o, 'rangeM', 0, 1000),
    cooldownMs: int(o, 'cooldownMs', 0, MAX_ACTION_MS),
    target: oneOf(o, 'target', PILOT_TARGET_KINDS),
  }
  if (o.charges !== undefined) k.charges = int(o, 'charges', 0, 100)
  return k
}

function pilotMessage(o: Record<string, unknown>): PilotServerMessage {
  switch (o.t) {
    case 'huntEvent':
      return { t: 'huntEvent', event: huntEventView(o.event) }
    case 'pilotOffer':
      return {
        t: 'pilotOffer',
        event: int(o, 'event', 1, MAX_ID),
        expiresAt: num(o, 'expiresAt', 0, BIG),
        surviveMin: num(o, 'surviveMin', 0, 1000),
        downsTarget: int(o, 'downsTarget', 0, BIG),
        idleSec: num(o, 'idleSec', 0, 1000),
      }
    case 'pilotStart': {
      const area = rec(o.area, 'area')
      return {
        t: 'pilotStart',
        event: int(o, 'event', 0, MAX_ID),
        mob: int(o, 'mob', 0, MAX_ID),
        kit: boundedList(o, 'kit', PILOT_KIT_MAX, pilotKitView),
        huntEndsAt: num(o, 'huntEndsAt', 0, BIG),
        downsTarget: int(o, 'downsTarget', 0, BIG),
        area: { x: num(area, 'x', -BIG, BIG), z: num(area, 'z', -BIG, BIG), r: num(area, 'r', 0, BIG) },
        taunts: int(o, 'taunts', 0, PILOT_TAUNT_MAX + 1),
        senseM: num(o, 'senseM', 0, 1000),
        place: str(o, 'place', 64),
      }
    }
    case 'pilotState': {
      const m: Extract<PilotServerMessage, { t: 'pilotState' }> = {
        t: 'pilotState',
        steering: oneOf(o, 'steering', PILOT_STEERINGS),
        hunting: int(o, 'hunting', 0, BIG),
        downs: int(o, 'downs', 0, BIG),
        charges: abilityMap(o, 'charges', 100),
        ready: abilityMap(o, 'ready', BIG),
      }
      if (o.idleWarnAt !== undefined) m.idleWarnAt = num(o, 'idleWarnAt', 0, BIG)
      if (o.enraged !== undefined) m.enraged = bool(o, 'enraged')
      if (o.stalkUntil !== undefined) m.stalkUntil = num(o, 'stalkUntil', 0, BIG)
      return m
    }
    case 'pilotEnd': {
      const m: Extract<PilotServerMessage, { t: 'pilotEnd' }> = { t: 'pilotEnd', event: int(o, 'event', 0, MAX_ID), reason: oneOf(o, 'reason', PILOT_END_REASONS) }
      if (o.gold !== undefined) m.gold = int(o, 'gold', 0, MAX_GOLD)
      if (o.honor !== undefined) m.honor = honorCode(o, 'honor')
      if (o.downs !== undefined) m.downs = int(o, 'downs', 0, BIG)
      if (o.steeredMs !== undefined) m.steeredMs = int(o, 'steeredMs', 0, BIG)
      return m
    }
    case 'huntPing':
      return { t: 'huntPing', event: int(o, 'event', 0, MAX_ID), x: num(o, 'x', -BIG, BIG), z: num(o, 'z', -BIG, BIG), r: num(o, 'r', 0, 10_000), at: num(o, 'at', 0, BIG) }
    case 'huntTrail':
      return {
        t: 'huntTrail',
        points: boundedList(o, 'points', HUNT_TRAIL_MAX, (p) => {
          if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) fail('trail points are [x, z, at]')
          return [p[0], p[1], p[2]] as [number, number, number]
        }),
      }
    case 'huntRoar':
      return { t: 'huntRoar', bearing: num(o, 'bearing', -TAU, TAU), distM: num(o, 'distM', 0, 100_000), at: num(o, 'at', 0, BIG) }
    case 'huntTaunt':
      return { t: 'huntTaunt', id: int(o, 'id', 0, MAX_ID), line: int(o, 'line', 0, PILOT_TAUNT_MAX) }
    default:
      fail('unknown message type')
  }
}
