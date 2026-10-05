/** Wave 3 protocol additions (docs/WAVE_PLAN.md §2.1, §4.1). */
import { describe, expect, it } from 'vitest'
import {
  ACTION_FAIL_REASONS,
  BUYBACK_SLOTS,
  CLIENT_RATE_LIMITS,
  GAMEPLAY_REQUESTS,
  HOTBAR_SLOTS,
  MOUSE_SLOT,
  MASTERY_CODES,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_EFFECTS_PER_ENTITY,
  MAX_GOLD,
  MAX_ITEM_COUNT,
  MAX_STORAGE_SIZE,
  NPC_APPROACH_RANGE,
  NPC_INTERACT_RANGE,
  SKILL_STATUS_KINDS,
  STORAGE_SIZE_DEFAULT,
  ZONES_FILE,
  checkContentFile,
  checkItemDef,
  checkNpcDef,
  checkZoneDef,
  parseClientMessage,
  parseServerMessage,
  utf8Length,
  type ClientMessage,
  type EffectState,
  type EntityState,
  type HotbarEntry,
  type ItemDef,
  type ServerMessage,
  type SkillDef,
  type ZoneDef,
} from '../src/index.ts'

const client = (v: unknown) => parseClientMessage(JSON.stringify(v))
const server = (v: unknown) => parseServerMessage(JSON.stringify(v))
const rejected = (v: unknown) => expect(client(v).ok, JSON.stringify(v)).toBe(false)

/** Every new client frame with all required keys (and, where listed, every optional key). */
const REQUIRED: ClientMessage[] = [
  { t: 'skillLearn', skill: 'SKILL_CH_SWORD_SMASH_A_02' },
  { t: 'masteryUp', mastery: 'BICHEON' },
  { t: 'buffCancel', skill: 'SKILL_CH_COLD_GIGONGTA_A_01' },
  { t: 'hotbarSet', slot: 0, entry: { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' } },
  { t: 'npcTalk', npc: 12 },
  { t: 'npcClose' },
  { t: 'storageOpen', npc: 12 },
  { t: 'storageDeposit', npc: 12, bag: 3 },
  { t: 'storageWithdraw', npc: 12, slot: 7 },
  { t: 'storageMove', npc: 12, from: 0, to: 179 },
  { t: 'storageGold', npc: 12, dir: 'deposit', amount: 500 },
  { t: 'shopBuyback', npc: 12, index: 0 },
]

const WITH_OPTIONAL: ClientMessage[] = [
  { t: 'hotbarSet', slot: HOTBAR_SLOTS - 1, entry: null },
  { t: 'hotbarSet', slot: 5, entry: { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' } },
  { t: 'storageDeposit', npc: 12, bag: 3, count: 20, to: MAX_STORAGE_SIZE - 1 },
  { t: 'storageDeposit', npc: 12, bag: 3, to: 0 },
  { t: 'storageWithdraw', npc: 12, slot: 7, count: MAX_ITEM_COUNT, bag: 47 },
  { t: 'storageWithdraw', npc: 12, slot: 7, bag: 0 },
  { t: 'storageGold', npc: 0, dir: 'withdraw', amount: MAX_GOLD },
  { t: 'shopBuyback', npc: 12, index: BUYBACK_SLOTS - 1 },
  ...MASTERY_CODES.map((mastery): ClientMessage => ({ t: 'masteryUp', mastery })),
]

/** Keys whose value is an enum (bad value -> rejected). */
const ENUM_KEYS = new Set(['mastery', 'dir'])

describe('wave 3 client messages', () => {
  it('accepts every new frame with exact keys, with and without optional keys', () => {
    for (const m of [...REQUIRED, ...WITH_OPTIONAL]) expect(client(m), JSON.stringify(m)).toEqual({ ok: true, msg: m })
  })

  it('rejects an extra key, a missing key, a fractional or negative number and a bad enum', () => {
    for (const m of [...REQUIRED, ...WITH_OPTIONAL]) {
      const o = m as unknown as Record<string, unknown>
      rejected({ ...o, extra: 1 })
      for (const k of Object.keys(REQUIRED.find((r) => r.t === m.t)!)) {
        if (k === 't') continue
        const { [k]: _, ...missing } = o
        rejected(missing)
      }
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'number') {
          rejected({ ...o, [k]: v + 0.5 })
          rejected({ ...o, [k]: -1 })
          rejected({ ...o, [k]: String(v) })
        }
        if (ENUM_KEYS.has(k)) rejected({ ...o, [k]: 'NOPE' })
      }
    }
  })

  it('bounds indexes, counts and codes', () => {
    const bad = [
      { t: 'skillLearn', skill: 'skill_lower' },
      { t: 'skillLearn', skill: '' },
      { t: 'skillLearn', skill: 'A'.repeat(129) },
      { t: 'masteryUp', mastery: 'bicheon' },
      { t: 'masteryUp', mastery: 'WARRIOR' },
      { t: 'buffCancel', skill: 'SKILL X' },
      // HOTBAR_SLOTS itself is MOUSE_SLOT (the mouse quick slot); one past it is refused.
      { t: 'hotbarSet', slot: MOUSE_SLOT + 1, entry: null },
      { t: 'hotbarSet', slot: 0 },
      { t: 'hotbarSet', slot: 0, entry: 'SKILL_X' },
      { t: 'hotbarSet', slot: 0, entry: [] },
      { t: 'hotbarSet', slot: 0, entry: { kind: 'macro', code: 'X' } },
      { t: 'hotbarSet', slot: 0, entry: { kind: 'skill', code: 'lower' } },
      { t: 'hotbarSet', slot: 0, entry: { kind: 'skill' } },
      { t: 'hotbarSet', slot: 0, entry: { code: 'X' } },
      { t: 'npcTalk', npc: Number.MAX_SAFE_INTEGER + 2 },
      { t: 'npcClose', npc: 1 },
      { t: 'storageDeposit', npc: 1, bag: 96 },
      { t: 'storageDeposit', npc: 1, bag: 0, count: 0 },
      { t: 'storageDeposit', npc: 1, bag: 0, count: MAX_ITEM_COUNT + 1 },
      { t: 'storageDeposit', npc: 1, bag: 0, to: MAX_STORAGE_SIZE },
      { t: 'storageWithdraw', npc: 1, slot: MAX_STORAGE_SIZE },
      { t: 'storageWithdraw', npc: 1, slot: 0, bag: 96 },
      { t: 'storageWithdraw', npc: 1, slot: 0, to: 3 },
      { t: 'storageMove', npc: 1, from: 0, to: MAX_STORAGE_SIZE },
      { t: 'storageGold', npc: 1, dir: 'deposit', amount: 0 },
      { t: 'storageGold', npc: 1, dir: 'deposit', amount: MAX_GOLD + 1 },
      { t: 'storageGold', npc: 1, dir: 'both', amount: 1 },
      { t: 'shopBuyback', npc: 1, index: BUYBACK_SLOTS },
    ]
    for (const m of bad) rejected(m)
  })

  it('hotbarSet entry is a strict {kind, code}', () => {
    rejected({ t: 'hotbarSet', slot: 0, entry: { kind: 'item', code: 'X', extra: 1 } })
    expect(client({ t: 'hotbarSet', slot: 0, entry: { kind: 'item', code: 'X' } }).ok).toBe(true)
  })

  it('chat takes an optional whisper recipient and channel', () => {
    const good: ClientMessage[] = [
      { t: 'chat', text: 'hi' },
      { t: 'chat', text: 'hi', to: 'Hero' },
      { t: 'chat', text: 'hi', to: 'Abc_123456789'.slice(0, 12) },
      { t: 'chat', text: 'hi', channel: 'local' },
      { t: 'chat', text: 'hi', channel: 'party' },
      { t: 'chat', text: 'hi', to: 'Hero', channel: 'local' },
    ]
    for (const m of good) expect(client(m), JSON.stringify(m)).toEqual({ ok: true, msg: m })
    for (const to of ['ab', '1abc', 'A'.repeat(13), 'He ro', '', 5, null]) rejected({ t: 'chat', text: 'hi', to })
    // 'guild' and 'stall' became send channels in wave 8 (docs/WAVE_PLAN2.md §3.2.2; packages/shared/test/wave8.test.ts).
    for (const channel of ['system', 'whisper', 'trade', '', 1]) rejected({ t: 'chat', text: 'hi', channel })
    rejected({ t: 'chat', text: 'hi', to: 'Hero', channel: 'party' })
    rejected({ t: 'chat', text: 'hi', from: 'Hero' })
  })

  it('every frame fits in one client message', () => {
    const biggest: ClientMessage[] = [
      { t: 'storageDeposit', npc: Number.MAX_SAFE_INTEGER, bag: 95, count: MAX_ITEM_COUNT, to: MAX_STORAGE_SIZE - 1 },
      { t: 'hotbarSet', slot: HOTBAR_SLOTS - 1, entry: { kind: 'skill', code: 'A'.repeat(128) } },
      { t: 'storageGold', npc: Number.MAX_SAFE_INTEGER, dir: 'withdraw', amount: MAX_GOLD },
      { t: 'chat', text: '😀'.repeat(100), to: 'A'.repeat(12), channel: 'local' },
    ]
    for (const m of biggest) {
      expect(client(m).ok, m.t).toBe(true)
      expect(utf8Length(JSON.stringify(m))).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES)
    }
  })

  it('every GameplayRequest has a CLIENT_RATE_LIMITS row, with the wave 3 budgets', () => {
    for (const r of GAMEPLAY_REQUESTS) {
      expect(CLIENT_RATE_LIMITS[r], r).toBeDefined()
      const p = client({ t: r })
      expect(p.ok ? '' : p.error, r).not.toBe('unknown message type')
    }
    expect(new Set(GAMEPLAY_REQUESTS).size).toBe(GAMEPLAY_REQUESTS.length)
    const budgets: Record<string, [number, number]> = {
      skillLearn: [5, 10], masteryUp: [5, 10], buffCancel: [5, 10], hotbarSet: [10, 20],
      npcTalk: [2, 5], npcClose: [5, 10], storageOpen: [2, 5],
      storageDeposit: [10, 20], storageWithdraw: [10, 20], storageMove: [10, 20],
      storageGold: [5, 10], shopBuyback: [5, 10],
      useSkill: [5, 10], itemUse: [5, 10], shopBuy: [5, 10], shopSell: [5, 10],
    }
    for (const [t, [perSecond, burst]] of Object.entries(budgets)) {
      expect(CLIENT_RATE_LIMITS[t as ClientMessage['t']], t).toEqual({ perSecond, burst })
    }
    expect(CLIENT_RATE_LIMITS.chat).toBeUndefined()
  })

  it('declares the wave 3 constants and refusal reasons', () => {
    expect([MAX_GOLD, HOTBAR_SLOTS, MAX_EFFECTS_PER_ENTITY, STORAGE_SIZE_DEFAULT, MAX_STORAGE_SIZE, BUYBACK_SLOTS, NPC_APPROACH_RANGE])
      .toEqual([9_999_999_999, 40, 32, 150, 180, 5, 3])
    expect(NPC_INTERACT_RANGE).toBe(8)
    for (const r of ['not_learned', 'not_enough_mp', 'wrong_weapon', 'no_ammo', 'cant_act', 'no_sp', 'mastery_cap', 'gold_limit', 'storage_full', 'busy', 'not_implemented']) {
      expect(ACTION_FAIL_REASONS, r).toContain(r)
    }
    expect(new Set(ACTION_FAIL_REASONS).size).toBe(ACTION_FAIL_REASONS.length)
  })
})

// ---- server -> client ----------------------------------------------------------------------------

const hotbar: (HotbarEntry | null)[] = Array.from({ length: HOTBAR_SLOTS }, (_, i) =>
  i === 0 ? { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' } : i === 9 ? { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' } : null)
const masteries = { BICHEON: 5, HEUKSAL: 0, PACHEON: 0, COLD: 3, LIGHTNING: 0, FIRE: 0, FORCE: 0 }
const effect: EffectState = { instance: 7, skill: 'SKILL_CH_COLD_GIGONGTA_A_01', level: 1, remainingMs: 395_798, source: 1 }
const stun: EffectState = { instance: 8, status: 'stun', level: 2, remainingMs: 5000 }
const potion = { code: 'ITEM_ETC_HP_POTION_01', count: 20 }
const player: EntityState = {
  id: 1, kind: 'player', name: 'Hero', model: 'CHAR_CH_MAN_ADVENTURER', level: 3, weapon: 'sword', pos: [1, 2, 3], yaw: 0,
  effects: [effect, stun], gm: true,
}

const SERVER: ServerMessage[] = [
  { t: 'skills', masteries, skills: ['SKILL_CH_SWORD_SMASH_A_02'], hotbar },
  { t: 'skills', masteries, skills: [], hotbar, cooldowns: [{ group: 'SKILL_CH_SWORD_SMASH_A', readyInMs: 1200 }] },
  { t: 'skillsUpdate' },
  {
    t: 'skillsUpdate', masteries: { BICHEON: 6 }, learned: ['SKILL_CH_SWORD_SMASH_A_03'],
    hotbar: [{ slot: 3, entry: { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_03' } }, { slot: 4, entry: null }],
  },
  { t: 'cast', id: 1, skill: 'SKILL_CH_SWORD_SMASH_A_01', instance: 3, prepareMs: 0, castMs: 411, actionMs: 900 },
  { t: 'cast', id: 1, skill: 'SKILL_CH_COLD_GIGONGTA_A_01', instance: 4, target: 1, instant: true, prepareMs: 0, castMs: 0, actionMs: 0 },
  { t: 'castEnd', id: 1, instance: 3, reason: 'interrupted' },
  { t: 'effectAdd', id: 1, effect },
  { t: 'effectAdd', id: 2, effect: stun },
  { t: 'effectRemove', id: 1, instance: 7 },
  { t: 'effectRemove', id: 1, instance: 7, reason: 'cancelled' },
  { t: 'npcDialog', npc: 12, code: 'NPC_CH_POTION', services: ['shop'] },
  { t: 'npcDialog', npc: 13, code: 'NPC_CH_WAREHOUSE_M', services: [] },
  { t: 'npcDialogClose', npc: 12, reason: 'too_far' },
  { t: 'storage', storage: { size: 3, slots: [potion, null, { code: 'ITEM_CH_SWORD_01_A', count: 1, plus: 2 }], gold: MAX_GOLD } },
  { t: 'storageUpdate' },
  { t: 'storageUpdate', slots: [{ slot: 179, item: potion }, { slot: 0, item: null }], gold: 10 },
  { t: 'buyback', entries: [] },
  { t: 'buyback', entries: [{ item: potion, price: 40 }] },
  { t: 'itemCooldown', group: 'hp', readyInMs: 1000, totalMs: 1000 },
  { t: 'itemCast', id: 1, item: 'ITEM_ETC_SCROLL_RETURN_01', castMs: 10_000 },
  { t: 'itemCastEnd', id: 1, item: 'ITEM_ETC_SCROLL_RETURN_01', reason: 'done' },
  { t: 'chat', channel: 'whisper', fromId: 1, from: 'Hero', to: 'Friend', text: 'psst' },
  { t: 'chat', channel: 'party', fromId: 1, from: 'Hero', text: 'go' },
  { t: 'chat', channel: 'system', text: 'hello' },
  { t: 'entityUpdate', id: 1, gm: false },
  { t: 'entityUpdate', id: 1, state: 'alive', hp: 10, maxHp: 100 },
  {
    t: 'combat', attacker: 1, target: 2, skill: 'SKILL_CH_SWORD_SMASH_A_01', instance: 3, at: 123_456, aoe: true, killed: false,
    hits: [{ outcome: 'hit', damage: 5, hp: 10, status: 'knockdown', down: true, pos: [1, 0, 2] }, { outcome: 'crit', damage: 9, hp: 1 }],
  },
  { t: 'spawn', entity: player },
  { t: 'actionResult', re: 'storageGold', ok: false, reason: 'gold_limit' },
  { t: 'actionResult', re: 'useSkill', ok: false, reason: 'not_enough_mp' },
]

describe('wave 3 server messages', () => {
  it('round-trips every new message and extension', () => {
    for (const m of SERVER) expect(server(m), JSON.stringify(m)).toEqual({ ok: true, msg: m })
  })

  it('drops unknown keys at every level', () => {
    const extra = { future: 1 }
    const cases: [unknown, ServerMessage][] = [
      [{ ...SERVER[0], ...extra, hotbar: hotbar.map((h) => (h ? { ...h, ...extra } : h)), masteries: { ...masteries, WARRIOR: 3 } }, SERVER[0]!],
      [{ t: 'effectAdd', id: 1, effect: { ...effect, ...extra }, ...extra }, { t: 'effectAdd', id: 1, effect }],
      [{ t: 'buyback', entries: [{ item: { ...potion, ...extra }, price: 40, ...extra }] }, { t: 'buyback', entries: [{ item: potion, price: 40 }] }],
      [{ t: 'npcDialog', npc: 1, code: 'NPC_X', services: ['storage'], greeting: 'hi' }, { t: 'npcDialog', npc: 1, code: 'NPC_X', services: ['storage'] }],
      [{ t: 'itemCast', id: 1, item: 'X', castMs: 5, ...extra }, { t: 'itemCast', id: 1, item: 'X', castMs: 5 }],
    ]
    for (const [raw, want] of cases) expect(server(raw), JSON.stringify(raw)).toEqual({ ok: true, msg: want })
  })

  it('fills masteries a skills snapshot omits with 0', () => {
    const r = server({ t: 'skills', masteries: { BICHEON: 4 }, skills: [], hotbar })
    expect(r.ok && r.msg.t === 'skills' && r.msg.masteries).toEqual({ ...Object.fromEntries(MASTERY_CODES.map((c) => [c, 0])), BICHEON: 4 })
  })

  it('keeps welcome.server.world and worldEnter.world.levelCap; rejects a malformed world', () => {
    const serverInfo = { id: 'jangan', name: 'Jangan', status: 'online', online: 1, capacity: 20 }
    const welcome = { t: 'welcome', account: 'a', server: { ...serverInfo, world: 'jangan-fields' }, slots: 4 }
    expect(server(welcome)).toEqual({ ok: true, msg: welcome })
    expect(server({ ...welcome, server: serverInfo })).toEqual({ ok: true, msg: { ...welcome, server: serverInfo } })
    for (const world of ['Jangan', 'jangan_fields', '../x', '', 'a'.repeat(65), 5, null]) {
      expect(server({ ...welcome, server: { ...serverInfo, world } }).ok, String(world)).toBe(false)
    }
    const enter = {
      t: 'worldEnter', self: player, entities: [], world: { name: 'jangan-fields', serverTime: 5, tickRate: 10, levelCap: 20 },
    }
    expect(server(enter)).toEqual({ ok: true, msg: enter })
    for (const levelCap of [0, 301, 1.5, '20']) expect(server({ ...enter, world: { ...enter.world, levelCap } }).ok, String(levelCap)).toBe(false)
  })

  it('rejects bad known fields', () => {
    const bad = [
      { t: 'skills', masteries, skills: [], hotbar: hotbar.slice(0, 39) },
      { t: 'skills', masteries, skills: [], hotbar: [...hotbar, null] },
      { t: 'skills', masteries: { ...masteries, BICHEON: 301 }, skills: [], hotbar },
      { t: 'skills', masteries: { ...masteries, BICHEON: -1 }, skills: [], hotbar },
      { t: 'skills', masteries, skills: Array(513).fill('SKILL_X'), hotbar },
      { t: 'skills', skills: [], hotbar },
      { t: 'skills', masteries, skills: [], hotbar: hotbar.map((h, i) => (i === 0 ? { kind: 'macro', code: 'X' } : h)) },
      { t: 'skillsUpdate', hotbar: [{ slot: MOUSE_SLOT + 1, entry: null }] },
      { t: 'cast', id: 1, skill: 'X', instance: 1, prepareMs: 0, castMs: 600_001, actionMs: 0 },
      { t: 'cast', id: 1, skill: 'X', instance: 1, prepareMs: -1, castMs: 0, actionMs: 0 },
      { t: 'cast', id: 1, skill: 'X', instance: 1, castMs: 0, actionMs: 0 },
      { t: 'castEnd', id: 1, instance: 1, reason: 'done' },
      { t: 'effectAdd', id: 1, effect: { ...effect, remainingMs: 86_400_001 } },
      { t: 'effectAdd', id: 1, effect: { ...effect, status: 'sleep' } },
      { t: 'effectAdd', id: 1, effect: { skill: 'X', remainingMs: 1 } },
      { t: 'effectRemove', id: 1, instance: 1, reason: 'gone' },
      { t: 'spawn', entity: { ...player, effects: Array.from({ length: MAX_EFFECTS_PER_ENTITY + 1 }, (_, i) => ({ instance: i, remainingMs: 0 })) } },
      { t: 'npcDialog', npc: 1, code: 'X', services: ['bank'] },
      { t: 'npcDialog', npc: 1, code: 'X', services: ['shop', 'storage', 'repair', 'quest', 'shop'] },
      { t: 'npcDialogClose', npc: 1, reason: 'bored' },
      { t: 'storage', storage: { size: 2, slots: [null], gold: 0 } },
      { t: 'storage', storage: { size: 181, slots: Array(181).fill(null), gold: 0 } },
      { t: 'storage', storage: { size: 0, slots: [], gold: MAX_GOLD + 1 } },
      { t: 'storageUpdate', slots: [{ slot: MAX_STORAGE_SIZE, item: null }] },
      { t: 'buyback', entries: Array(BUYBACK_SLOTS + 1).fill({ item: potion, price: 1 }) },
      { t: 'itemCooldown', group: 'hp', readyInMs: 600_001, totalMs: 1 },
      { t: 'itemCast', id: 1, item: 'X', castMs: 1.5 },
      { t: 'itemCastEnd', id: 1, item: 'X', reason: 'expired' },
      { t: 'chat', channel: 'trade', text: 'x' }, // 'guild' is a channel since wave 8
      { t: 'entityUpdate', id: 1, gm: 'yes' },
      { t: 'combat', attacker: 1, target: 2, hits: [{ outcome: 'hit', damage: 1, hp: 1, status: 'sleep' }] },
      { t: 'combat', attacker: 1, target: 2, hits: [{ outcome: 'hit', damage: 1, hp: 1, pos: [1, 2] }] },
    ]
    for (const m of bad) expect(server(m).ok, JSON.stringify(m).slice(0, 160)).toBe(false)
  })

  it('accepts exactly MAX_EFFECTS_PER_ENTITY effects and every status kind', () => {
    const effects = Array.from({ length: MAX_EFFECTS_PER_ENTITY }, (_, i): EffectState => ({ instance: i, remainingMs: 0 }))
    expect(server({ t: 'spawn', entity: { ...player, effects } }).ok).toBe(true)
    for (const status of SKILL_STATUS_KINDS) expect(server({ t: 'effectAdd', id: 1, effect: { instance: 1, status, remainingMs: 1 } }).ok).toBe(true)
  })

  it('keeps gm only when true on an entity', () => {
    const r = server({ t: 'spawn', entity: { ...player, gm: false } })
    expect(r.ok && r.msg.t === 'spawn' && 'gm' in r.msg.entity).toBe(false)
  })
})

// ---- content --------------------------------------------------------------------------------------

describe('wave 3 content', () => {
  const item: ItemDef = {
    code: 'ITEM_ETC_HP_POTION_01', id: 1, name: 'HP Recovery Herb', typeId: [3, 3, 1, 1], category: 'potion', degree: 0, reqLevel: 0,
    reqGender: 'any', race: 'any', maxStack: 50, price: 4, sellPrice: 1, model: null, icon: null,
    keepFee: 1, repairCost: 0, canRepair: false, canStore: true, cureLevel: 36,
  }

  it('checks the new optional item fields', () => {
    expect(checkItemDef(item)).toEqual([])
    expect(checkItemDef({ ...item, keepFee: -1 })).toHaveLength(1)
    expect(checkItemDef({ ...item, canStore: 'no' })).toHaveLength(1)
    expect(checkItemDef({ ...item, cureLevel: 'x', canRepair: 1 })).toHaveLength(2)
  })

  it('checks npc greetings', () => {
    const npc = { code: 'NPC_CH_POTION', name: 'Herbalist Yangyun', x: 0, z: 0, yaw: 0, world: 'jangan', model: null, provenance: 'client', greeting: 'Welcome!' }
    expect(checkNpcDef(npc)).toEqual([])
    expect(checkNpcDef({ ...npc, greeting: undefined })).toEqual([])
    expect(checkNpcDef({ ...npc, greeting: 'x'.repeat(2001) })).toHaveLength(1)
    expect(checkContentFile('npcs', { schema: 1, kind: 'npcs', generatedAt: '', sources: [], entries: [npc] })).toEqual([])
  })

  it('checks zones.json records', () => {
    expect(ZONES_FILE).toBe('zones.json')
    const zone: ZoneDef = { region: (97 << 8) | 168, rx: 168, rz: 97, name: 'Jangan', area: 'Town_Jangan', continent: 'CHINA', town: 'TOWN_JANGAN' }
    expect(checkZoneDef(zone)).toEqual([])
    expect(checkZoneDef({ ...zone, name: '', area: null, continent: null, town: undefined })).toEqual([])
    expect(checkZoneDef({ ...zone, region: 1 })).toHaveLength(1)
    expect(checkZoneDef({ ...zone, area: '????' })).toHaveLength(1)
    expect(checkZoneDef({ ...zone, name: 'x'.repeat(65) })).toHaveLength(1)
  })

  it('SkillDef carries the skills.json extras as optional fields', () => {
    const s: SkillDef = {
      code: 'SKILL_CH_SWORD_SMASH_A_01', id: 1, name: 'Strike Smash', mastery: 'BICHEON', masteryLevel: 1, skillLevel: 1, sp: 0, mp: 8,
      category: 'melee', castMs: 411, actionMs: 900, cooldownMs: 3000, range: 0, weapons: ['sword', 'blade'], icon: null,
      group: 'SKILL_CH_SWORD_SMASH_A', kind: 'attack', targets: { required: true, groups: ['enemy_mob', 'enemy_player'] },
      ui: { tab: 'weapon', page: 0, column: 0, row: 0 }, hitCues: [{ phase: 'SHOT', event: 1 }],
      statuses: [{ status: 'knockdown', level: 19, chancePct: 50 }], params: [{ tag: 'att', args: [5, 110, 0, 0, 0] }],
    }
    expect(s.kind).toBe('attack')
  })
})
