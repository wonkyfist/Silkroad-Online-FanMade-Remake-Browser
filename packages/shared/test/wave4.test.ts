/** Wave 4 protocol additions and quest content (docs/WAVE_PLAN.md §2.2, docs/QUESTS.md §6). */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACTION_FAIL_REASONS,
  CLIENT_RATE_LIMITS,
  CONTENT_CHANGE_KINDS,
  GAMEPLAY_REQUESTS,
  MAX_ACTIVE_QUESTS,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_QUEST_OBJECTIVES,
  MAX_QUEST_TEXT,
  MAX_REWARD_CHOICES,
  PARTY_EVENT_KINDS,
  PARTY_INVITE_MS,
  PARTY_MAX,
  PARTY_MODES,
  PARTY_OFFLINE_GRACE_MS,
  PARTY_SHARE_RANGE,
  QUEST_EVENTS,
  QUEST_FILE_SCHEMA,
  armorClassToken,
  expandRewardCode,
  genderOfModel,
  objectiveGoal,
  parseClientMessage,
  parseServerMessage,
  questRewardExp,
  rewardCodeVariants,
  utf8Length,
  validateQuestDef,
  validateQuestFile,
  type ClientMessage,
  type EntityState,
  type PartyState,
  type QuestDef,
  type QuestFile,
  type QuestIssue,
  type QuestProgress,
  type QuestRefs,
  type ServerMessage,
} from '../src/index.ts'

const client = (v: unknown) => parseClientMessage(JSON.stringify(v))
const server = (v: unknown) => parseServerMessage(JSON.stringify(v))
const rejected = (v: unknown) => expect(client(v).ok, JSON.stringify(v)).toBe(false)

// ---- client -> server ----------------------------------------------------------------------------

const REQUIRED: ClientMessage[] = [
  { t: 'questAccept', npc: 12, quest: 'JG_001' },
  { t: 'questTurnIn', npc: 12, quest: 'JG_001' },
  { t: 'questAbandon', quest: 'JG_002' },
  { t: 'questTalk', npc: 12, quest: 'JG_004', objective: 'bun' },
  { t: 'questUseItem', quest: 'JG_025', objective: 'bell' },
  { t: 'partyInvite', target: 7 },
  { t: 'partyRespond', inviter: 7, accept: true },
  { t: 'partyLeave' },
  { t: 'partyKick', member: 3 },
  { t: 'partyLeader', member: 3 },
]

const WITH_OPTIONAL: ClientMessage[] = [
  { t: 'questTurnIn', npc: 12, quest: 'JG_003', choice: 0 },
  { t: 'questTurnIn', npc: 0, quest: 'JG_025', choice: MAX_REWARD_CHOICES - 1 },
  { t: 'partyInvite', target: 7, exp: 'share' },
  { t: 'partyInvite', target: 7, items: 'share' },
  { t: 'partyInvite', target: 0, exp: 'free', items: 'free' },
  { t: 'partyRespond', inviter: 7, accept: false },
  { t: 'partySettings', exp: 'free' },
  { t: 'partySettings', items: 'share' },
  { t: 'partySettings', exp: 'share', items: 'free' },
  { t: 'questAbandon', quest: 'A'.repeat(64) },
  { t: 'questTalk', npc: 1, quest: 'JG_S01', objective: 'a'.repeat(24) },
]

/** Keys whose value is an enum (bad value -> rejected). */
const ENUM_KEYS = new Set(['exp', 'items'])

describe('wave 4 client messages', () => {
  it('accepts every new frame with exact keys, with and without optional keys', () => {
    for (const m of [...REQUIRED, ...WITH_OPTIONAL]) expect(client(m), JSON.stringify(m)).toEqual({ ok: true, msg: m })
  })

  it('rejects an extra key, a missing key, a fractional or negative number and a bad enum', () => {
    for (const m of [...REQUIRED, ...WITH_OPTIONAL]) {
      const o = m as unknown as Record<string, unknown>
      rejected({ ...o, extra: 1 })
      const required = REQUIRED.find((r) => r.t === m.t)
      for (const k of Object.keys(required ?? {})) {
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

  it('bounds ids, choices and members', () => {
    const bad = [
      { t: 'questAccept', npc: 1, quest: 'jg_001' },
      { t: 'questAccept', npc: 1, quest: '1G_001' },
      { t: 'questAccept', npc: 1, quest: 'J' },
      { t: 'questAccept', npc: 1, quest: 'A'.repeat(65) },
      { t: 'questAccept', npc: 1, quest: 'JG 001' },
      { t: 'questAccept', npc: 1, quest: 5 },
      { t: 'questAccept', npc: Number.MAX_SAFE_INTEGER + 2, quest: 'JG_001' },
      { t: 'questTurnIn', npc: 1, quest: 'JG_001', choice: MAX_REWARD_CHOICES },
      { t: 'questTurnIn', npc: 1, quest: 'JG_001', choice: null },
      { t: 'questTalk', npc: 1, quest: 'JG_001', objective: 'Bun' },
      { t: 'questTalk', npc: 1, quest: 'JG_001', objective: '1bun' },
      { t: 'questTalk', npc: 1, quest: 'JG_001', objective: 'a'.repeat(25) },
      { t: 'questTalk', npc: 1, quest: 'JG_001', objective: '' },
      { t: 'questUseItem', quest: 'JG_025', objective: 'bell', npc: 1 },
      { t: 'questAbandon', quest: 'JG_001', npc: 1 },
      { t: 'partyInvite', target: 1, exp: 'Share' },
      { t: 'partyInvite', target: 1, items: 'round_robin' },
      { t: 'partyRespond', inviter: 1, accept: 'yes' },
      { t: 'partyRespond', inviter: 1, accept: 1 },
      { t: 'partyKick', member: 0 },
      { t: 'partyLeader', member: 0 },
      { t: 'partyKick', member: Number.MAX_SAFE_INTEGER + 2 },
      { t: 'partySettings' },
      { t: 'partySettings', exp: null },
      { t: 'partyLeave', member: 1 },
    ]
    for (const m of bad) rejected(m)
  })

  it('every frame fits in one client message', () => {
    const biggest: ClientMessage[] = [
      { t: 'questTalk', npc: Number.MAX_SAFE_INTEGER, quest: 'A'.repeat(64), objective: 'a'.repeat(24) },
      { t: 'questTurnIn', npc: Number.MAX_SAFE_INTEGER, quest: 'A'.repeat(64), choice: MAX_REWARD_CHOICES - 1 },
      { t: 'partyInvite', target: Number.MAX_SAFE_INTEGER, exp: 'share', items: 'share' },
    ]
    for (const m of biggest) {
      expect(client(m).ok, m.t).toBe(true)
      expect(utf8Length(JSON.stringify(m))).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES)
    }
  })

  it('every wave 4 request is a GameplayRequest with the planned budget', () => {
    const budgets: Record<string, [number, number]> = {
      questAccept: [5, 10], questTurnIn: [5, 10], questTalk: [5, 10],
      questAbandon: [2, 5], questUseItem: [2, 5],
      partyInvite: [1, 3], partyLeave: [1, 3],
      partyRespond: [2, 5], partyKick: [2, 5], partyLeader: [2, 5], partySettings: [2, 5],
    }
    for (const [t, [perSecond, burst]] of Object.entries(budgets)) {
      expect(GAMEPLAY_REQUESTS, t).toContain(t)
      expect(CLIENT_RATE_LIMITS[t as ClientMessage['t']], t).toEqual({ perSecond, burst })
    }
    for (const r of GAMEPLAY_REQUESTS) expect(CLIENT_RATE_LIMITS[r], r).toBeDefined()
    expect(new Set(GAMEPLAY_REQUESTS).size).toBe(GAMEPLAY_REQUESTS.length)
  })

  it('declares the wave 4 constants and refusal reasons', () => {
    expect([PARTY_MAX, PARTY_SHARE_RANGE, PARTY_INVITE_MS, PARTY_OFFLINE_GRACE_MS]).toEqual([8, 60, 30_000, 120_000])
    expect([MAX_ACTIVE_QUESTS, MAX_QUEST_OBJECTIVES, MAX_REWARD_CHOICES, MAX_QUEST_TEXT]).toEqual([10, 8, 8, 1200])
    expect(PARTY_MODES).toEqual(['free', 'share'])
    expect(CONTENT_CHANGE_KINDS).toEqual(['quests', 'nests', 'npcs'])
    const reasons = [
      'quest_log_full', 'quest_active', 'quest_done', 'not_complete', 'choice_required', 'wrong_place',
      'not_in_party', 'not_leader', 'party_full', 'in_party', 'no_invite',
    ]
    for (const r of reasons) expect(ACTION_FAIL_REASONS, r).toContain(r)
    expect(new Set(ACTION_FAIL_REASONS).size).toBe(ACTION_FAIL_REASONS.length)
  })
})

// ---- server -> client ----------------------------------------------------------------------------

const progress: QuestProgress = {
  quest: 'JG_003', rev: 2, status: 'active', counts: { hides: 3 }, items: [{ code: 'QITEM_MANGYANG_HIDE', count: 3 }], acceptedAt: 1_700_000_000_000,
}
const party: PartyState = {
  id: 1, leader: 10, exp: 'share', items: 'free',
  members: [
    { characterId: 10, name: 'Hero', model: 'CHAR_CH_MAN_ADVENTURER', level: 10, entity: 5, hp: 100, maxHp: 120, mp: 50, maxMp: 60, pos: [1.5, -2] },
    { characterId: 11, name: 'Friend', model: 'CHAR_CH_WOMAN_ADVENTURER', level: 12, entity: null, hp: 0, maxHp: 150, mp: 0, maxMp: 90, dead: true },
  ],
}
const npcEntity: EntityState = { id: 40, kind: 'npc', name: 'Old Guard', model: 'NPC_CH_SOLDIER_EM2', npc: 'NPCX_1', level: 0, pos: [0, 0, 0], yaw: 0 }
const itemEntity: EntityState = { id: 41, kind: 'item', name: 'Coins', model: 'ITEM_ETC_GOLD_01', level: 0, pos: [0, 0, 0], yaw: 0, count: 5, owner: 5, ownerParty: 1 }

const SERVER: ServerMessage[] = [
  { t: 'quests', active: [], done: [], rev: 0 },
  {
    t: 'quests', rev: 7,
    active: [progress, { ...progress, quest: 'JG_025', status: 'ready', counts: {}, items: [], encounterUntil: 1_700_000_600_000 }],
    done: [{ quest: 'JG_001', times: 1, lastAt: 5 }, { quest: 'JG_R01', times: 3, lastAt: 6, availableAt: 90_000 }],
  },
  { t: 'questUpdate', quest: 'JG_003', event: 'progress', progress, objective: 'hides' },
  { t: 'questUpdate', quest: 'JG_003', event: 'completed', progress: null, done: { quest: 'JG_003', times: 1, lastAt: 9 } },
  { t: 'questUpdate', quest: 'JG_002', event: 'abandoned', progress: null },
  { t: 'contentChanged', kind: 'quests', rev: 3 },
  { t: 'contentChanged', kind: 'nests', rev: 0 },
  { t: 'partyInvited', inviter: 5, name: 'Hero', level: 10, exp: 'share', items: 'free', expiresInMs: PARTY_INVITE_MS },
  { t: 'party', party },
  { t: 'party', party: null },
  { t: 'partyVitals', members: [{ characterId: 10, hp: 90 }, { characterId: 11, entity: null, dead: false, pos: [3, 4] }, { characterId: 12, entity: 9, level: 13, maxHp: 1, mp: 2, maxMp: 3 }] },
  { t: 'partyEvent', event: 'joined', name: 'Friend' },
  { t: 'partyEvent', event: 'disbanded', name: '' },
  { t: 'spawn', entity: npcEntity },
  { t: 'spawn', entity: itemEntity },
  { t: 'statsDelta', stats: { exp: 60 }, gain: { exp: 60, spExp: 400, quest: 'JG_001' } },
  { t: 'actionResult', re: 'questTurnIn', ok: false, reason: 'choice_required' },
  { t: 'actionResult', re: 'partyKick', ok: false, reason: 'not_leader' },
  { t: 'chat', channel: 'party', fromId: 5, from: 'Hero', text: 'hi' },
]

describe('wave 4 server messages', () => {
  it('round-trips every new message and extension', () => {
    for (const m of SERVER) expect(server(m), JSON.stringify(m)).toEqual({ ok: true, msg: m })
  })

  it('knows every event kind', () => {
    for (const event of QUEST_EVENTS) expect(server({ t: 'questUpdate', quest: 'JG_001', event, progress: null }).ok, event).toBe(true)
    for (const event of PARTY_EVENT_KINDS) expect(server({ t: 'partyEvent', event, name: 'X' }).ok, event).toBe(true)
    for (const kind of CONTENT_CHANGE_KINDS) expect(server({ t: 'contentChanged', kind, rev: 1 }).ok, kind).toBe(true)
  })

  it('drops unknown keys at every level', () => {
    const extra = { future: 1 }
    const cases: [unknown, ServerMessage][] = [
      [
        { t: 'quests', rev: 1, active: [{ ...progress, ...extra, items: [{ code: 'QITEM_MANGYANG_HIDE', count: 3, ...extra }] }], done: [{ quest: 'JG_001', times: 1, lastAt: 5, ...extra }], ...extra },
        { t: 'quests', rev: 1, active: [progress], done: [{ quest: 'JG_001', times: 1, lastAt: 5 }] },
      ],
      [
        { t: 'party', party: { ...party, ...extra, members: party.members.map((m) => ({ ...m, ...extra })) } },
        { t: 'party', party },
      ],
      [{ t: 'partyVitals', members: [{ characterId: 10, hp: 1, ...extra }] }, { t: 'partyVitals', members: [{ characterId: 10, hp: 1 }] }],
      [{ t: 'contentChanged', kind: 'npcs', rev: 2, ...extra }, { t: 'contentChanged', kind: 'npcs', rev: 2 }],
    ]
    for (const [raw, want] of cases) expect(server(raw), JSON.stringify(raw)).toEqual({ ok: true, msg: want })
  })

  it('rejects bad known fields', () => {
    const bad = [
      { t: 'quests', active: [], done: [] },
      { t: 'quests', active: [{ ...progress, status: 'done' }], done: [], rev: 1 },
      { t: 'quests', active: [{ ...progress, counts: { hides: -1 } }], done: [], rev: 1 },
      { t: 'quests', active: [{ ...progress, counts: { hides: 1.5 } }], done: [], rev: 1 },
      { t: 'quests', active: [{ ...progress, counts: { Hides: 1 } }], done: [], rev: 1 },
      { t: 'quests', active: [{ ...progress, counts: [] }], done: [], rev: 1 },
      { t: 'quests', active: [{ ...progress, items: [{ code: 'Q', count: 0 }] }], done: [], rev: 1 },
      { t: 'quests', active: [], done: [{ quest: 'JG_001', times: 0, lastAt: 1 }], rev: 1 },
      { t: 'questUpdate', quest: 'JG_001', event: 'accepted' },
      { t: 'questUpdate', quest: 'JG_001', event: 'failed', progress: null },
      { t: 'questUpdate', quest: '', event: 'accepted', progress: null },
      { t: 'contentChanged', kind: 'items', rev: 1 },
      { t: 'contentChanged', kind: 'quests', rev: -1 },
      { t: 'partyInvited', inviter: 5, name: 'Hero', level: 10, exp: 'all', items: 'free', expiresInMs: 1 },
      { t: 'partyInvited', inviter: 5, name: 'Hero', level: 10, exp: 'free', items: 'free' },
      { t: 'party' },
      { t: 'party', party: { ...party, members: [] } },
      { t: 'party', party: { ...party, members: Array(PARTY_MAX + 1).fill(party.members[0]) } },
      { t: 'party', party: { ...party, exp: 'equal' } },
      { t: 'party', party: { ...party, members: [{ ...party.members[0], entity: undefined }] } },
      { t: 'party', party: { ...party, members: [{ ...party.members[0], pos: [1, 2, 3] }] } },
      { t: 'partyVitals', members: [{ hp: 1 }] },
      { t: 'partyVitals', members: Array(PARTY_MAX + 1).fill({ characterId: 1 }) },
      { t: 'partyEvent', event: 'exploded', name: 'X' },
      { t: 'spawn', entity: { ...npcEntity, npc: '' } },
      { t: 'spawn', entity: { ...itemEntity, ownerParty: -1 } },
      { t: 'statsDelta', stats: {}, gain: { exp: 1, spExp: 0, quest: 5 } },
    ]
    for (const m of bad) expect(server(m).ok, JSON.stringify(m).slice(0, 160)).toBe(false)
  })
})

// ---- quest content -------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const jangan: unknown = JSON.parse(readFileSync(resolve(repo, 'content/quests/jangan.json'), 'utf8'))
const dataDir = resolve(repo, 'work/out/data')
const hasData = ['mobs.json', 'items.json', 'npcs.json'].every((f) => existsSync(resolve(dataDir, f)))

const errors = (issues: QuestIssue[]) => issues.filter((i) => i.severity === 'error')

function baseQuest(over: Partial<QuestDef> = {}): QuestDef {
  return {
    id: 'TQ_001', title: 'Test', kind: 'main', level: 1, giver: 'NPC_A', turnIn: 'NPC_A', summary: 'Do it.',
    objectives: [{ id: 'kill', type: 'kill', mobs: ['MOB_A'], count: 3 }],
    rewards: { exp: 10, sp: 1, gold: 5 },
    dialog: { offer: 'o', progress: 'p', complete: 'c' },
    ...over,
  }
}

function baseFile(quests: QuestDef[] = [baseQuest()]): QuestFile {
  return {
    schema: QUEST_FILE_SCHEMA, kind: 'quests', id: 'test', title: 'Test line', world: 'jangan',
    items: [{ code: 'QITEM_A', name: 'Thing' }, { code: 'QITEM_B', name: 'Other', maxStack: 5 }],
    locations: [{ id: 'LOC_A', name: 'Place', x: 1, z: 2, radius: 30 }],
    quests,
  }
}

const refs: QuestRefs = {
  mobs: new Set(['MOB_A', 'MOB_UNIQUE']),
  items: new Set(['ITEM_POTION', 'ITEM_CH_M_CLOTHES_01', 'ITEM_CH_W_CLOTHES_01', 'ITEM_CH_M_LIGHT_01', 'ITEM_CH_W_LIGHT_01', 'ITEM_CH_M_HEAVY_01', 'ITEM_CH_W_HEAVY_01', 'ITEM_BIG']),
  npcs: new Set(['NPC_A', 'NPC_B']),
  levelCap: 20,
  mobInfo: (c) => (c === 'MOB_A' ? { level: 9, unique: false } : c === 'MOB_UNIQUE' ? { level: 20, unique: true } : undefined),
  itemReqLevel: (c) => (c === 'ITEM_BIG' ? 15 : 1),
}

/** Validates a file with one quest and returns the error paths. */
function questErrors(q: Partial<QuestDef> | Record<string, unknown>, withRefs = false): string[] {
  const { issues } = validateQuestFile(baseFile([{ ...baseQuest(), ...q } as QuestDef]), withRefs ? refs : undefined)
  return errors(issues).map((i) => i.path)
}

describe('quest files', () => {
  it('content/quests/jangan.json passes the structural checks with 0 errors and survives as a clean copy', () => {
    const { file, issues } = validateQuestFile(jangan)
    expect(errors(issues), JSON.stringify(errors(issues).slice(0, 5))).toEqual([])
    expect(file).not.toBeNull()
    expect(file!.quests).toHaveLength(35) // 34 + JG_S05 (PACE, Fengil's shop tip)
    expect(file!.items).toHaveLength(21)
    expect(file!.locations).toHaveLength(17)
    expect(file).toEqual(jangan)
  })

  it.skipIf(!hasData)('content/quests/jangan.json passes the reference checks against work/out/data', () => {
    const load = (f: string) => (JSON.parse(readFileSync(resolve(dataDir, f), 'utf8')) as { entries: Record<string, unknown>[] }).entries
    const mobs = new Map(load('mobs.json').map((m) => [m.code as string, m]))
    const items = new Map(load('items.json').map((m) => [m.code as string, m]))
    const real: QuestRefs = {
      mobs: new Set(mobs.keys()), items: new Set(items.keys()), npcs: new Set(load('npcs.json').map((n) => n.code as string)), levelCap: 20,
      mobInfo: (c) => { const m = mobs.get(c); return m && { level: m.level as number, unique: m.rarity === 'unique' } },
      itemReqLevel: (c) => items.get(c)?.reqLevel as number | undefined,
    }
    const { file, issues } = validateQuestFile(jangan, real)
    expect(errors(issues), JSON.stringify(errors(issues).slice(0, 5))).toEqual([])
    expect(file!.quests).toHaveLength(35) // 34 + JG_S05 (PACE, Fengil's shop tip)
  })

  it('accepts a minimal valid file with no issues', () => {
    const { file, issues } = validateQuestFile(baseFile([baseQuest({ giveOnAccept: [{ item: 'QITEM_A', count: 1 }], objectives: [{ id: 'use', type: 'useItem', item: 'QITEM_A', location: 'LOC_A' }] })]), refs)
    expect(issues.filter((i) => !i.message.includes('not used'))).toEqual([])
    expect(file!.quests).toHaveLength(1)
  })

  it('rejects a broken envelope with file null', () => {
    for (const bad of [null, [], 'x', { ...baseFile(), schema: 2 }, { ...baseFile(), kind: 'nests' }, { ...baseFile(), quests: {} }, { ...baseFile(), world: 'Jangan Fields' }, { ...baseFile(), id: '' }]) {
      const r = validateQuestFile(bad)
      expect(r.file, JSON.stringify(bad)?.slice(0, 80)).toBeNull()
      expect(errors(r.issues).length).toBeGreaterThan(0)
    }
  })

  it('drops only the broken quest and reports its path', () => {
    const { file, issues } = validateQuestFile(baseFile([baseQuest(), baseQuest({ id: 'TQ_002', level: 0 })]))
    expect(file!.quests.map((q) => q.id)).toEqual(['TQ_001'])
    expect(errors(issues)).toEqual([{ path: 'quests[1].level', message: expect.any(String), severity: 'error' }])
  })

  it('checks ids, bounds and uniqueness', () => {
    expect(questErrors({ id: 'jg_1' })).toEqual(['quests[0].id'])
    expect(questErrors({ kind: 'daily' as never })).toEqual(['quests[0].kind'])
    expect(questErrors({ title: 'x'.repeat(61) })).toEqual(['quests[0].title'])
    expect(questErrors({ title: '   ' })).toEqual(['quests[0].title'])
    expect(questErrors({ level: 1, maxLevel: 0 })).toContain('quests[0].maxLevel')
    expect(questErrors({ level: 21 }, true)).toEqual(['quests[0].level'])
    expect(questErrors({ giver: 'npc a' })).toEqual(['quests[0].giver'])
    expect(questErrors({ dialog: { offer: 'x'.repeat(MAX_QUEST_TEXT + 1), progress: 'p', complete: 'c' } })).toEqual(['quests[0].dialog.offer'])
    expect(questErrors({ dialog: { offer: 'o', progress: 'p' } as never })).toEqual(['quests[0].dialog.complete'])
    expect(questErrors({ objectives: Array.from({ length: MAX_QUEST_OBJECTIVES + 1 }, (_, i) => ({ id: `k${i}`, type: 'kill' as const, mobs: ['MOB_A'], count: 1 })) })).toEqual(['quests[0].objectives'])
    expect(questErrors({ objectives: [{ id: 'a', type: 'kill', mobs: ['MOB_A'], count: 1 }, { id: 'a', type: 'kill', mobs: ['MOB_A'], count: 1 }] })).toEqual(['quests[0].objectives[1].id'])
    expect(questErrors({ objectives: [{ id: 'a', type: 'kill', mobs: [], count: 1 }] })).toEqual(['quests[0].objectives[0].mobs'])
    expect(questErrors({ objectives: [{ id: 'a', type: 'kill', mobs: ['MOB_A', 'MOB_A'], count: 1 }] })).toEqual(['quests[0].objectives[0].mobs[1]'])
    expect(questErrors({ objectives: [{ id: 'a', type: 'kill', mobs: ['MOB_A'], count: 0 }] })).toEqual(['quests[0].objectives[0].count'])
    expect(questErrors({ objectives: [{ id: 'a', type: 'dance' }] } as never)).toEqual(['quests[0].objectives[0].type'])
    const dup = validateQuestFile(baseFile([baseQuest(), baseQuest()]))
    expect(errors(dup.issues).map((i) => i.path)).toEqual(['quests[1].id'])
    const dupItem = validateQuestFile({ ...baseFile(), items: [{ code: 'QITEM_A', name: 'a' }, { code: 'QITEM_A', name: 'b' }] })
    expect(errors(dupItem.issues).map((i) => i.path)).toEqual(['items[1].code'])
    const loc = validateQuestFile({ ...baseFile(), locations: [{ id: 'LOC_A', name: 'x', x: 0, z: 0, radius: 4 }] })
    expect(errors(loc.issues).map((i) => i.path)).toContain('locations[0].radius')
  })

  it('resolves references inside the file set (and external ids)', () => {
    expect(questErrors({ objectives: [{ id: 'r', type: 'reach', location: 'LOC_NOPE' }] })).toEqual(['quests[0].objectives[0].location'])
    expect(questErrors({ objectives: [{ id: 'k', type: 'kill', mobs: ['MOB_A'], count: 1, hint: 'LOC_NOPE' }] })).toEqual(['quests[0].objectives[0].hint'])
    expect(questErrors({ requires: { quests: ['TQ_404'] } })).toEqual(['quests[0].requires.quests[0]'])
    expect(questErrors({ requires: { quests: ['TQ_001'] } })).toEqual(['quests[0].requires.quests[0]'])
    expect(questErrors({ objectives: [{ id: 'c', type: 'collect', item: 'QITEM_NOPE', count: 1, from: [{ mob: 'MOB_A', chance: 0.5 }] }] })).toEqual(['quests[0].objectives[0].item'])
    const override = baseFile([baseQuest({ requires: { quests: ['JG_001'] }, objectives: [{ id: 'r', type: 'reach', location: 'LOC_TIGER_SHRINE' }] })])
    expect(errors(validateQuestFile(override).issues).length).toBe(2)
    expect(validateQuestFile(override, undefined, { quests: new Set(['JG_001']), locations: new Set(['LOC_TIGER_SHRINE']) }).issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('gates `after` on an earlier objective', () => {
    const later: QuestDef['objectives'] = [
      { id: 'b', type: 'kill', mobs: ['MOB_A'], count: 1, after: 'a' },
      { id: 'a', type: 'reach', location: 'LOC_A' },
    ]
    expect(questErrors({ objectives: later })).toEqual(['quests[0].objectives[0].after'])
    expect(questErrors({ objectives: [later[1]!, later[0]!] })).toEqual([])
    expect(questErrors({ objectives: [{ id: 'a', type: 'reach', location: 'LOC_A', after: 'a' }] })).toEqual(['quests[0].objectives[0].after'])
  })

  it('finds requires cycles', () => {
    const { file, issues } = validateQuestFile(baseFile([
      baseQuest({ id: 'TQ_001', requires: { quests: ['TQ_003'] } }),
      baseQuest({ id: 'TQ_002', requires: { quests: ['TQ_001'] } }),
      baseQuest({ id: 'TQ_003', requires: { quests: ['TQ_002'] } }),
      baseQuest({ id: 'TQ_004', requires: { quests: ['TQ_003'] } }),
    ]))
    expect(errors(issues).map((i) => i.path).sort()).toEqual(['quests[0].requires', 'quests[1].requires', 'quests[2].requires'])
    expect(file!.quests.map((q) => q.id)).toEqual(['TQ_004'])
  })

  it('requires giveOnAccept for the quest items a deliver or useItem needs', () => {
    expect(questErrors({ objectives: [{ id: 'u', type: 'useItem', item: 'QITEM_A', location: 'LOC_A' }] })).toEqual(['quests[0].objectives[0].item'])
    expect(questErrors({ objectives: [{ id: 'd', type: 'deliver', npc: 'NPC_B', item: 'QITEM_A', count: 2, text: 't' }], giveOnAccept: [{ item: 'QITEM_A', count: 1 }] })).toEqual(['quests[0].objectives[0].item'])
    expect(questErrors({ objectives: [{ id: 'd', type: 'deliver', npc: 'NPC_B', item: 'QITEM_A', count: 2, text: 't' }], giveOnAccept: [{ item: 'QITEM_A', count: 2 }] })).toEqual([])
    expect(questErrors({
      objectives: [
        { id: 'c', type: 'collect', item: 'QITEM_A', count: 3, from: [{ mob: 'MOB_A', chance: 1 }] },
        { id: 'd', type: 'deliver', npc: 'NPC_B', item: 'QITEM_A', count: 3, text: 't', after: 'c' },
      ],
    })).toEqual([])
    expect(questErrors({ objectives: [{ id: 'd', type: 'deliver', npc: 'NPC_B', item: 'ITEM_POTION', count: 5, text: 't' }] }, true)).toEqual([])
    expect(questErrors({ objectives: [{ id: 'h', type: 'have', item: 'QITEM_A', count: 1 }] })).toEqual(['quests[0].objectives[0].item'])
    expect(questErrors({ giveOnAccept: [{ item: 'QITEM_B', count: 6 }] })).toEqual(['quests[0].giveOnAccept[0].count'])
    expect(questErrors({ objectives: [{ id: 'c', type: 'collect', item: 'QITEM_A', count: 1, from: [{ mob: 'MOB_A', chance: 0 }] }] })).toEqual(['quests[0].objectives[0].from[0].chance'])
    expect(questErrors({ objectives: [{ id: 'c', type: 'collect', item: 'QITEM_A', count: 1, from: [{ mob: 'MOB_A', chance: 1.5 }] }] })).toEqual(['quests[0].objectives[0].from[0].chance'])
  })

  it('checks repeat rules', () => {
    expect(questErrors({ kind: 'repeatable' })).toEqual(['quests[0].repeat'])
    expect(questErrors({ kind: 'repeatable', repeat: { reset: 'daily' } })).toEqual([])
    expect(questErrors({ kind: 'repeatable', repeat: { cooldownSec: 3600 } })).toEqual([])
    expect(questErrors({ kind: 'repeatable', repeat: { cooldownSec: 1 } })).toEqual(['quests[0].repeat.cooldownSec'])
    expect(questErrors({ kind: 'repeatable', repeat: { reset: 'weekly' } as never })).toEqual(['quests[0].repeat.reset'])
    expect(questErrors({ kind: 'main', repeat: { reset: 'daily' } })).toEqual(['quests[0].repeat'])
  })

  it('checks encounters', () => {
    const use = (encounter: Record<string, unknown>) => questErrors({
      giveOnAccept: [{ item: 'QITEM_A', count: 1 }],
      objectives: [{ id: 'u', type: 'useItem', item: 'QITEM_A', location: 'LOC_A', encounter } as never],
    }, true)
    expect(use({ mob: 'MOB_UNIQUE', count: 1, hpMul: 0.05, expMul: 0.1, attackMul: 0.8, despawnSec: 600, cooldownSec: 120 })).toEqual([])
    expect(use({ mob: 'MOB_NOPE', count: 1, despawnSec: 600 })).toEqual(['quests[0].objectives[0].encounter.mob'])
    expect(use({ mob: 'MOB_A', count: 11, despawnSec: 600 })).toEqual(['quests[0].objectives[0].encounter.count'])
    expect(use({ mob: 'MOB_A', count: 1, hpMul: 0, despawnSec: 600 })).toEqual(['quests[0].objectives[0].encounter.hpMul'])
    expect(use({ mob: 'MOB_A', count: 1 })).toEqual(['quests[0].objectives[0].encounter.despawnSec'])
  })

  it('checks reward codes, tokens and choices', () => {
    expect(questErrors({ rewards: { exp: 1, sp: 0, gold: 0, items: [{ item: 'ITEM_CH_{G}_{ARMOR}_01' }] } }, true)).toEqual([])
    expect(questErrors({ rewards: { exp: 1, sp: 0, gold: 0, items: [{ item: 'ITEM_CH_{G}_{ARMOR}_02' }] } }, true)).toEqual(['quests[0].rewards.items[0].item'])
    expect(questErrors({ rewards: { exp: 1, sp: 0, gold: 0, items: [{ item: 'ITEM_{RACE}_01' }] } })).toEqual(['quests[0].rewards.items[0].item'])
    expect(questErrors({ rewards: { exp: 1, sp: 0, gold: 0, items: [{ item: 'QITEM_A' }] } })).toEqual(['quests[0].rewards.items[0].item'])
    expect(questErrors({ rewards: { exp: 1, sp: 0, gold: 0, choice: Array(MAX_REWARD_CHOICES + 1).fill({ item: 'ITEM_POTION' }) } })).toEqual(['quests[0].rewards.choice'])
    expect(questErrors({ rewards: { exp: -1, sp: 0, gold: 0 } })).toEqual(['quests[0].rewards.exp'])
    expect(questErrors({ rewards: { exp: 0, sp: 0, gold: 0, expPctOfLevel: 101 } })).toEqual(['quests[0].rewards.expPctOfLevel'])
    expect(questErrors({ rewards: { exp: 0, sp: 0, gold: 0, items: [{ item: 'ITEM_POTION', count: 0 }] } })).toEqual(['quests[0].rewards.items[0].count'])
  })

  it('checks export references with refs (authored NPCs only warn)', () => {
    expect(questErrors({ giver: 'NPC_NOPE' }, true)).toEqual(['quests[0].giver'])
    expect(questErrors({ objectives: [{ id: 'k', type: 'kill', mobs: ['MOB_NOPE'], count: 1 }] }, true)).toEqual(['quests[0].objectives[0].mobs[0]'])
    expect(questErrors({ objectives: [{ id: 'h', type: 'have', item: 'ITEM_NOPE', count: 1 }] }, true)).toEqual(['quests[0].objectives[0].item'])
    const { file, issues } = validateQuestFile(baseFile([baseQuest({ giver: 'NPCX_7' })]), refs)
    expect(errors(issues)).toEqual([])
    expect(issues.some((i) => i.path === 'quests[0].giver' && i.severity === 'warning')).toBe(true)
    expect(file!.quests).toHaveLength(1)
  })

  it('warns about the content rules (mob level, reward level, prerequisite level, unused items, unknown keys)', () => {
    const warnings = (q: Partial<QuestDef> | Record<string, unknown>) =>
      validateQuestFile(baseFile([{ ...baseQuest(), ...q } as QuestDef]), refs).issues.filter((i) => i.severity === 'warning' && !i.message.includes('not used')).map((i) => i.path)
    expect(warnings({ level: 5 })).toEqual(['quests[0].objectives[0].mobs'])
    expect(warnings({ level: 6 })).toEqual([])
    expect(warnings({ level: 6, kind: 'repeatable', repeat: { reset: 'daily' }, maxLevel: 9 })).toEqual([])
    expect(warnings({ level: 6, objectives: [{ id: 'k', type: 'kill', mobs: ['MOB_UNIQUE'], count: 1 }] })).toEqual([])
    expect(warnings({ level: 6, rewards: { exp: 1, sp: 0, gold: 0, choice: [{ item: 'ITEM_BIG' }, { item: 'ITEM_POTION' }] } })).toEqual(['quests[0].rewards.choice[0].item'])
    expect(warnings({ level: 6, rewards: { exp: 1, sp: 0, gold: 0, choice: [{ item: 'ITEM_POTION' }] } })).toEqual(['quests[0].rewards.choice'])
    expect(warnings({ level: 6, colour: 'red' })).toEqual(['quests[0].colour'])
    const pre = validateQuestFile(baseFile([baseQuest({ level: 9 }), baseQuest({ id: 'TQ_002', level: 6, requires: { quests: ['TQ_001'] } })]), refs)
    expect(pre.issues.filter((i) => i.severity === 'warning' && i.path.endsWith('requires')).map((i) => i.path)).toEqual(['quests[1].requires'])
    expect(validateQuestFile(baseFile(), refs).issues.filter((i) => i.message.includes('not used')).map((i) => i.path)).toEqual(['items[0].code', 'items[1].code'])
  })

  it('strips control and bidi characters from text, keeping newlines, and drops unknown keys from the copy', () => {
    const { file, issues } = validateQuestFile(baseFile([{ ...baseQuest({ title: 'Evil‮ title\u0007', dialog: { offer: 'a\nb\r\n', progress: 'p', complete: 'c' } }), extra: 1 } as QuestDef]))
    expect(errors(issues)).toEqual([])
    expect(file!.quests[0]!.title).toBe('Evil title')
    expect(file!.quests[0]!.dialog.offer).toBe('a\nb\n')
    expect('extra' in file!.quests[0]!).toBe(false)
  })

  it('validateQuestDef checks one quest against a scope, with paths relative to the quest', () => {
    const scope = { items: new Set(['QITEM_A']), locations: new Set(['LOC_A']), quests: new Set(['TQ_000']) }
    expect(errors(validateQuestDef(baseQuest({ requires: { quests: ['TQ_000'] } }), scope, refs))).toEqual([])
    expect(errors(validateQuestDef(baseQuest({ requires: { quests: ['TQ_404'] } }), scope)).map((i) => i.path)).toEqual(['requires.quests[0]'])
    expect(errors(validateQuestDef({ ...baseQuest(), objectives: [{ id: 'r', type: 'reach', location: 'LOC_B' }] }, scope)).map((i) => i.path)).toEqual(['objectives[0].location'])
    expect(errors(validateQuestDef(null, scope)).map((i) => i.path)).toEqual([''])
    expect(errors(validateQuestDef({ ...baseQuest(), objectives: [{ id: 'c', type: 'collect', item: 'QITEM_A', count: 100, from: [{ mob: 'MOB_A', chance: 1 }] }] }, scope)).map((i) => i.path)).toEqual(['objectives[0].count'])
    expect(validateQuestDef({ ...baseQuest(), objectives: [{ id: 'c', type: 'collect', item: 'QITEM_A', count: 100, from: [{ mob: 'MOB_A', chance: 1 }] }] }, scope, undefined, new Map([['QITEM_A', 200]]))).toEqual([])
  })

  it('never throws on junk', () => {
    const junk: unknown[] = [undefined, 0, true, { quests: [null, 1, 'x', [], { objectives: 'x', rewards: [], dialog: 1 }] }, { ...baseFile(), quests: [{ objectives: [null, { type: 'useItem', encounter: 5 }] }] }]
    for (const j of junk) expect(() => validateQuestFile(j, refs)).not.toThrow()
    expect(() => validateQuestDef({ objectives: [{ type: 'collect', from: [null, 5] }], rewards: { items: [null, { item: 5 }] } }, { items: new Set(), locations: new Set(), quests: new Set() })).not.toThrow()
  })
})

describe('quest helpers', () => {
  it('expands reward codes per character', () => {
    expect(expandRewardCode('ITEM_CH_{G}_{ARMOR}_02_BA_A', { gender: 'female', armor: 'LIGHT' })).toBe('ITEM_CH_W_LIGHT_02_BA_A')
    expect(expandRewardCode('ITEM_CH_{G}_{ARMOR}_02_BA_A', { gender: 'male', armor: 'HEAVY' })).toBe('ITEM_CH_M_HEAVY_02_BA_A')
    expect(expandRewardCode('ITEM_CH_RING_01_A', { gender: 'female', armor: 'CLOTHES' })).toBe('ITEM_CH_RING_01_A')
    expect(rewardCodeVariants('ITEM_CH_{G}_{ARMOR}_01_AA_B').sort()).toEqual([
      'ITEM_CH_M_CLOTHES_01_AA_B', 'ITEM_CH_M_HEAVY_01_AA_B', 'ITEM_CH_M_LIGHT_01_AA_B',
      'ITEM_CH_W_CLOTHES_01_AA_B', 'ITEM_CH_W_HEAVY_01_AA_B', 'ITEM_CH_W_LIGHT_01_AA_B',
    ])
    expect(rewardCodeVariants('ITEM_{G}_X')).toEqual(['ITEM_M_X', 'ITEM_W_X'])
    expect(rewardCodeVariants('ITEM_X')).toEqual(['ITEM_X'])
  })

  it('derives {G} and {ARMOR} from the character', () => {
    expect(genderOfModel('CHAR_CH_WOMAN_ADVENTURER')).toBe('female')
    expect(genderOfModel('CHAR_CH_MAN_WARRIOR')).toBe('male')
    expect(armorClassToken('protector')).toBe('LIGHT')
    expect(armorClassToken('armor', 'clothes')).toBe('HEAVY')
    expect(armorClassToken('garment', 'heavy')).toBe('CLOTHES')
    expect(armorClassToken(undefined, 'heavy')).toBe('HEAVY')
    expect(armorClassToken(undefined, 'light')).toBe('LIGHT')
    expect(armorClassToken(undefined)).toBe('CLOTHES')
  })

  it('computes turn-in EXP from the reward and the level table', () => {
    const levels = [118, 470, 1058]
    const expToNext = (l: number) => levels[l - 1] ?? 0
    expect(questRewardExp({ exp: 60, sp: 1, gold: 0 }, 1, expToNext)).toBe(60)
    expect(questRewardExp({ exp: 0, expPctOfLevel: 5, sp: 2, gold: 0 }, 3, expToNext)).toBe(52)
    expect(questRewardExp({ exp: 10, expPctOfLevel: 50, sp: 0, gold: 0 }, 2, expToNext)).toBe(245)
    expect(questRewardExp({ exp: 0, expPctOfLevel: 5, sp: 0, gold: 0 }, 99, expToNext)).toBe(0)
  })

  it('gives each objective type its goal', () => {
    const { file } = validateQuestFile(jangan)
    const byType = new Map(file!.quests.flatMap((q) => q.objectives).map((o) => [o.type, objectiveGoal(o)]))
    expect(byType.get('reach')).toBe(1)
    expect(byType.get('useItem')).toBe(1)
    expect(byType.get('talk')).toBe(1)
    expect(objectiveGoal({ id: 'k', type: 'kill', mobs: ['X'], count: 8 })).toBe(8)
  })
})
