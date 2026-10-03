/** Wave 8 protocol additions: combat and items, trade, stalls, guilds (docs/WAVE_PLAN2.md §3.2, §3.3, §3.5, §6.1). */
import { describe, expect, it } from 'vitest'
import {
  ACTION_FAIL_REASONS,
  CHAT_CHANNELS,
  CHAT_SEND_CHANNELS,
  CLIENT_RATE_LIMITS,
  CONTENT_FILES,
  ENTITY_KINDS,
  GAMEPLAY_REQUESTS,
  GUILD_MANAGER_NPCS,
  GUILD_NAME,
  GUILD_NOTICE_MAX,
  GUILD_NOTICE_TITLE_MAX,
  GUILD_PERMS,
  GUILD_TITLE_MAX,
  HWAN_MAX,
  MAX_BAG_SIZE,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_GOLD,
  MAX_ITEM_COUNT,
  NPC_SERVICES,
  PLAYER_STAT_KEYS,
  STALL_GREETING_MAX,
  STALL_PRICE_MAX,
  STALL_SLOTS,
  STALL_TITLE_MAX,
  STALL_VISITORS_MAX,
  TRADE_SLOTS,
  checkContentFile,
  checkCosDef,
  checkItemDef,
  parseClientMessage,
  parseServerMessage,
  utf8Length,
  type ClientMessage,
  type CosDef,
  type EntityState,
  type GameplayRequest,
  type GuildMember,
  type GuildState,
  type PlayerStats,
  type ServerMessage,
  type StallView,
  type TradeSide,
  type TradeState,
} from '../src/index.ts'

const client = (v: unknown) => parseClientMessage(JSON.stringify(v))
const server = (v: unknown) => parseServerMessage(JSON.stringify(v))
const accepted = (v: ClientMessage) => expect(client(v), JSON.stringify(v)).toEqual({ ok: true, msg: v })
const rejected = (v: unknown) => expect(client(v).ok, JSON.stringify(v)).toBe(false)
const serverOk = (v: ServerMessage) => expect(server(v), JSON.stringify(v).slice(0, 200)).toEqual({ ok: true, msg: v })
const serverBad = (v: unknown) => expect(server(v).ok, JSON.stringify(v).slice(0, 200)).toBe(false)
/** An astral code point: 1 code point, 2 UTF-16 units, 4 UTF-8 bytes. */
const ASTRAL = '\u{1F600}'
const MAX = Number.MAX_SAFE_INTEGER

/** Every wave-8 client frame with all required keys (and, in a second row, the optional ones). */
const FRAMES: ClientMessage[] = [
  { t: 'mountRide', cos: 12 },
  { t: 'mountDismount' },
  { t: 'mountDismiss' },
  { t: 'repair', npc: 3 },
  { t: 'repair', npc: 3, items: [{ equip: 'weapon' }, { bag: 4 }] },
  { t: 'alchemyReinforce', item: 0, elixir: 1 },
  { t: 'alchemyReinforce', item: 0, elixir: 1, powder: 2 },
  { t: 'alchemyCancel' },
  { t: 'berserk' },
  { t: 'tradeRequest', target: 7 },
  { t: 'tradeRespond', from: 7, accept: true },
  { t: 'tradeRespond', from: 7, accept: false },
  { t: 'tradeOffer', bag: 5 },
  { t: 'tradeOffer', bag: 5, count: 3 },
  { t: 'tradeTake', slot: 0 },
  { t: 'tradeGold', amount: 0 },
  { t: 'tradeLock' },
  { t: 'tradeAccept' },
  { t: 'tradeCancel' },
  { t: 'stallCreate', title: '' },
  { t: 'stallCreate', title: 'Cheap potions' },
  { t: 'stallItem', slot: 0, bag: 3, count: 1, price: 100 },
  { t: 'stallItemRemove', slot: 9 },
  { t: 'stallText', title: 'New title' },
  { t: 'stallText', greeting: 'Welcome!' },
  { t: 'stallText', title: 'T', greeting: '' },
  { t: 'stallOpen', open: true },
  { t: 'stallClose' },
  { t: 'stallVisit', owner: 9 },
  { t: 'stallLeave' },
  { t: 'stallBuy', owner: 9, slot: 2, code: 'ITEM_ETC_HP_POTION_01', count: 5, price: 250 },
  { t: 'guildCreate', npc: 4, name: 'Tigers2' },
  { t: 'guildDisband', npc: 4 },
  { t: 'guildInvite', name: 'Hero_1' },
  { t: 'guildRespond', guild: 1, accept: true },
  { t: 'guildLeave' },
  { t: 'guildKick', member: 22 },
  { t: 'guildPerms', member: 22, perms: [] },
  { t: 'guildPerms', member: 22, perms: ['invite', 'kick', 'notice', 'title'] },
  { t: 'guildTitle', member: 22, title: '' },
  { t: 'guildNotice', title: 'Hunt', text: 'Tonight at 8.' },
  { t: 'guildMaster', member: 22 },
]

const WAVE8_REQUESTS: GameplayRequest[] = [
  'mountRide', 'mountDismount', 'mountDismiss', 'repair', 'alchemyReinforce', 'alchemyCancel', 'berserk',
  'tradeRequest', 'tradeRespond', 'tradeOffer', 'tradeTake', 'tradeGold', 'tradeLock', 'tradeAccept', 'tradeCancel',
  'stallCreate', 'stallItem', 'stallItemRemove', 'stallText', 'stallOpen', 'stallClose', 'stallVisit', 'stallLeave', 'stallBuy',
  'guildCreate', 'guildDisband', 'guildInvite', 'guildRespond', 'guildLeave', 'guildKick', 'guildPerms', 'guildTitle', 'guildNotice', 'guildMaster',
]

describe('wave 8 client frames', () => {
  it('every new frame round-trips with its exact keys, and an extra key is rejected', () => {
    for (const f of FRAMES) {
      accepted(f)
      rejected({ ...f, extra: 1 })
    }
    expect(new Set(FRAMES.map((f) => f.t))).toEqual(new Set(WAVE8_REQUESTS))
  })

  it('a missing required key is rejected', () => {
    for (const f of FRAMES) {
      for (const k of Object.keys(f)) {
        if (k === 't') continue
        const optional = (f.t === 'repair' && k === 'items') || (f.t === 'alchemyReinforce' && k === 'powder') || (f.t === 'tradeOffer' && k === 'count') || f.t === 'stallText'
        if (optional) continue
        const { [k]: _, ...rest } = f as unknown as Record<string, unknown>
        rejected(rest)
      }
    }
  })

  it('ids: cos, npc, target, from and owner 0..MAX_ID; member and guild 1..MAX_ID; integers only', () => {
    for (const [t, k] of [['mountRide', 'cos'], ['repair', 'npc'], ['tradeRequest', 'target'], ['stallVisit', 'owner'], ['guildDisband', 'npc']] as const) {
      accepted({ t, [k]: 0 } as ClientMessage)
      accepted({ t, [k]: MAX } as ClientMessage)
      rejected({ t, [k]: -1 })
      rejected({ t, [k]: MAX + 2 })
      rejected({ t, [k]: 1.5 })
      rejected({ t, [k]: '1' })
    }
    accepted({ t: 'tradeRespond', from: 0, accept: true })
    rejected({ t: 'tradeRespond', from: -1, accept: true })
    for (const t of ['guildKick', 'guildMaster'] as const) {
      accepted({ t, member: 1 })
      accepted({ t, member: MAX })
      rejected({ t, member: 0 })
      rejected({ t, member: MAX + 2 })
    }
    accepted({ t: 'guildRespond', guild: 1, accept: false })
    rejected({ t: 'guildRespond', guild: 0, accept: false })
    rejected({ t: 'guildRespond', guild: 1, accept: 'yes' })
  })

  it('bag indexes 0..MAX_BAG_SIZE-1; counts 1..MAX_ITEM_COUNT; gold 0..MAX_GOLD', () => {
    accepted({ t: 'tradeOffer', bag: MAX_BAG_SIZE - 1 })
    rejected({ t: 'tradeOffer', bag: MAX_BAG_SIZE })
    rejected({ t: 'tradeOffer', bag: -1 })
    accepted({ t: 'tradeOffer', bag: 0, count: 1 })
    accepted({ t: 'tradeOffer', bag: 0, count: MAX_ITEM_COUNT })
    rejected({ t: 'tradeOffer', bag: 0, count: 0 })
    rejected({ t: 'tradeOffer', bag: 0, count: MAX_ITEM_COUNT + 1 })
    accepted({ t: 'tradeGold', amount: MAX_GOLD })
    rejected({ t: 'tradeGold', amount: MAX_GOLD + 1 })
    rejected({ t: 'tradeGold', amount: -1 })
    accepted({ t: 'alchemyReinforce', item: MAX_BAG_SIZE - 1, elixir: 0, powder: 1 })
    rejected({ t: 'alchemyReinforce', item: MAX_BAG_SIZE, elixir: 0 })
    rejected({ t: 'alchemyReinforce', item: 0, elixir: 1, powder: MAX_BAG_SIZE })
  })

  it('trade and stall slots, stall prices and counts', () => {
    accepted({ t: 'tradeTake', slot: TRADE_SLOTS - 1 })
    rejected({ t: 'tradeTake', slot: TRADE_SLOTS })
    rejected({ t: 'tradeTake', slot: -1 })
    accepted({ t: 'stallItemRemove', slot: STALL_SLOTS - 1 })
    rejected({ t: 'stallItemRemove', slot: STALL_SLOTS })
    const item = { t: 'stallItem', slot: 0, bag: 0, count: 1, price: 1 } as const
    accepted(item)
    accepted({ ...item, price: STALL_PRICE_MAX, count: MAX_ITEM_COUNT })
    rejected({ ...item, price: 0 })
    rejected({ ...item, price: STALL_PRICE_MAX + 1 })
    rejected({ ...item, count: 0 })
    rejected({ ...item, slot: STALL_SLOTS })
    const buy = { t: 'stallBuy', owner: 1, slot: 0, code: 'ITEM_X', count: 1, price: 1 } as const
    accepted(buy)
    rejected({ ...buy, price: 0 })
    rejected({ ...buy, price: STALL_PRICE_MAX + 1 })
    rejected({ ...buy, count: MAX_ITEM_COUNT + 1 })
    rejected({ ...buy, code: 'item x' })
    rejected({ ...buy, code: '' })
    rejected({ ...buy, code: 'A'.repeat(129) })
    accepted({ ...buy, code: 'A'.repeat(128) })
  })

  it('code-point limits count astral characters once', () => {
    const cases: [string, number, (s: string) => Record<string, unknown>][] = [
      ['stallCreate.title', STALL_TITLE_MAX, (s) => ({ t: 'stallCreate', title: s })],
      ['stallText.title', STALL_TITLE_MAX, (s) => ({ t: 'stallText', title: s })],
      ['stallText.greeting', STALL_GREETING_MAX, (s) => ({ t: 'stallText', greeting: s })],
      ['guildTitle.title', GUILD_TITLE_MAX, (s) => ({ t: 'guildTitle', member: 1, title: s })],
      ['guildNotice.title', GUILD_NOTICE_TITLE_MAX, (s) => ({ t: 'guildNotice', title: s, text: '' })],
      ['guildNotice.text', GUILD_NOTICE_MAX, (s) => ({ t: 'guildNotice', title: '', text: s })],
    ]
    for (const [what, max, frame] of cases) {
      const fits = frame('x'.repeat(max))
      const over = frame('x'.repeat(max + 1))
      expect(client(fits).ok, what).toBe(true)
      expect(client(over).ok, what).toBe(false)
      // `max` astral code points are within the limit (2*max UTF-16 units), max + 1 are not.
      const astral = frame(ASTRAL.repeat(max))
      if (utf8Length(JSON.stringify(astral)) <= MAX_CLIENT_MESSAGE_BYTES) expect(client(astral).ok, `${what} astral`).toBe(true)
      expect(client(frame(ASTRAL.repeat(max + 1))).ok, `${what} astral + 1`).toBe(false)
    }
    // A full astral notice is over the 1024-byte frame limit (docs/SYSTEMS_SOCIAL.md §2.5): bad_request, not a crash.
    const huge = { t: 'guildNotice', title: ASTRAL.repeat(GUILD_NOTICE_TITLE_MAX), text: ASTRAL.repeat(GUILD_NOTICE_MAX) }
    expect(utf8Length(JSON.stringify(huge))).toBeGreaterThan(MAX_CLIENT_MESSAGE_BYTES)
    expect(client(huge).ok).toBe(false)
  })

  it('RepairRef is strictly {equip} xor {bag}; 1..16 refs', () => {
    accepted({ t: 'repair', npc: 1, items: [{ equip: 'ring2' }] })
    accepted({ t: 'repair', npc: 1, items: Array.from({ length: 16 }, (_, i) => ({ bag: i })) })
    rejected({ t: 'repair', npc: 1, items: [] })
    rejected({ t: 'repair', npc: 1, items: Array.from({ length: 17 }, (_, i) => ({ bag: i })) })
    rejected({ t: 'repair', npc: 1, items: [{ equip: 'weapon', bag: 1 }] })
    rejected({ t: 'repair', npc: 1, items: [{}] })
    rejected({ t: 'repair', npc: 1, items: [{ slot: 1 }] })
    rejected({ t: 'repair', npc: 1, items: [{ equip: 'ring' }] })
    rejected({ t: 'repair', npc: 1, items: [{ bag: MAX_BAG_SIZE }] })
    rejected({ t: 'repair', npc: 1, items: [null] })
    rejected({ t: 'repair', npc: 1, items: { bag: 1 } })
  })

  it('alchemyReinforce needs three different bag slots', () => {
    rejected({ t: 'alchemyReinforce', item: 1, elixir: 1 })
    rejected({ t: 'alchemyReinforce', item: 1, elixir: 2, powder: 1 })
    rejected({ t: 'alchemyReinforce', item: 1, elixir: 2, powder: 2 })
  })

  it('guildPerms: unique GUILD_PERMS entries only', () => {
    rejected({ t: 'guildPerms', member: 1, perms: ['invite', 'invite'] })
    rejected({ t: 'guildPerms', member: 1, perms: ['storage'] })
    rejected({ t: 'guildPerms', member: 1, perms: 'invite' })
    rejected({ t: 'guildPerms', member: 1, perms: [...GUILD_PERMS, 'invite'] })
  })

  it('stallText needs at least one of title and greeting', () => {
    rejected({ t: 'stallText' })
  })

  it('guildInvite takes a character name; guildCreate leaves the guild-name rule to the server (bad_name)', () => {
    for (const name of ['ab', '1abc', 'A'.repeat(13), 'He ro', '', 5]) rejected({ t: 'guildInvite', name })
    accepted({ t: 'guildCreate', npc: 1, name: 'bad name!' })
    rejected({ t: 'guildCreate', npc: 1, name: '' })
    rejected({ t: 'guildCreate', npc: 1, name: 'x'.repeat(33) })
  })

  it("chat: 'guild' and 'stall' channels; a whisper with any channel but 'local' is rejected (D32)", () => {
    for (const channel of CHAT_SEND_CHANNELS) accepted({ t: 'chat', text: 'hi', channel })
    expect([...CHAT_SEND_CHANNELS]).toEqual(['local', 'party', 'guild', 'stall'])
    accepted({ t: 'chat', text: 'hi', to: 'Hero', channel: 'local' })
    for (const channel of ['party', 'guild', 'stall']) rejected({ t: 'chat', text: 'hi', to: 'Hero', channel })
    for (const channel of ['system', 'whisper', 'trade']) rejected({ t: 'chat', text: 'hi', channel })
  })

  it('every GameplayRequest has a rate-limit row; the wave-8 budgets match §3.5', () => {
    for (const r of GAMEPLAY_REQUESTS) expect(CLIENT_RATE_LIMITS[r], r).toBeDefined()
    for (const r of WAVE8_REQUESTS) expect(GAMEPLAY_REQUESTS, r).toContain(r)
    expect(new Set(GAMEPLAY_REQUESTS).size).toBe(GAMEPLAY_REQUESTS.length)
    const budgets: [readonly GameplayRequest[], number, number][] = [
      [['mountRide', 'mountDismount', 'mountDismiss', 'repair', 'alchemyReinforce', 'alchemyCancel', 'berserk'], 2, 5],
      [['tradeRequest', 'stallCreate', 'stallClose', 'guildCreate', 'guildDisband', 'guildInvite', 'guildLeave', 'guildNotice', 'guildMaster'], 1, 3],
      [['tradeRespond', 'tradeLock', 'tradeAccept', 'tradeCancel', 'stallText', 'stallOpen', 'stallVisit', 'stallLeave', 'guildRespond', 'guildKick', 'guildPerms', 'guildTitle'], 2, 5],
      [['tradeGold', 'stallBuy'], 5, 10],
      [['tradeOffer', 'tradeTake', 'stallItem', 'stallItemRemove'], 10, 20],
    ]
    const covered = new Set<string>()
    for (const [types, perSecond, burst] of budgets) {
      for (const t of types) {
        expect(CLIENT_RATE_LIMITS[t], t).toEqual({ perSecond, burst })
        covered.add(t)
      }
    }
    expect(covered).toEqual(new Set(WAVE8_REQUESTS))
  })

  it('declares the 22 new refusal reasons once each (busy stays single, D10)', () => {
    const reasons = [
      'mounted', 'not_mounted', 'moving', 'in_combat', 'cos_active', 'broken', 'nothing_to_repair', 'alchemy_mismatch', 'max_plus',
      'berserk_not_ready', 'berserk_active',
      'trading', 'stalling', 'stall_changed', 'stall_full', 'stall_closed', 'not_in_guild', 'in_guild', 'no_permission', 'guild_full',
      'name_taken', 'bad_name',
    ]
    expect(reasons).toHaveLength(22)
    for (const r of reasons) expect(ACTION_FAIL_REASONS, r).toContain(r)
    expect(new Set(ACTION_FAIL_REASONS).size).toBe(ACTION_FAIL_REASONS.length)
    expect(ACTION_FAIL_REASONS.filter((r) => r === 'busy')).toHaveLength(1)
    for (const r of reasons) serverOk({ t: 'actionResult', re: 'repair', ok: false, reason: r as (typeof ACTION_FAIL_REASONS)[number] })
  })

  it('the biggest wave-8 frames fit in one client frame', () => {
    const biggest: ClientMessage[] = [
      { t: 'stallBuy', owner: MAX, slot: STALL_SLOTS - 1, code: 'A'.repeat(128), count: MAX_ITEM_COUNT, price: STALL_PRICE_MAX },
      { t: 'repair', npc: MAX, items: Array.from({ length: 16 }, () => ({ equip: 'shoulders' as const })) },
      { t: 'guildNotice', title: 'x'.repeat(GUILD_NOTICE_TITLE_MAX), text: 'x'.repeat(GUILD_NOTICE_MAX) },
      { t: 'stallText', title: 'x'.repeat(STALL_TITLE_MAX), greeting: 'x'.repeat(STALL_GREETING_MAX) },
    ]
    for (const m of biggest) {
      expect(utf8Length(JSON.stringify(m)), m.t).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES)
      accepted(m)
    }
  })
})

describe('wave 8 constants', () => {
  it('GUILD_NAME: 2..12 ASCII letters and digits, a letter first (docs/SYSTEMS_SOCIAL.md §10.1)', () => {
    for (const ok of ['Ab', 'Tigers2', 'A12345678901']) expect(GUILD_NAME.test(ok), ok).toBe(true)
    for (const bad of ['1ab', 'a', 'abc_def', 'A'.repeat(13), 'Tigèrs', 'Ab c', '', 'Ab\n']) expect(GUILD_NAME.test(bad), bad).toBe(false)
  })

  it('enum additions', () => {
    expect(ENTITY_KINDS).toContain('cos')
    expect(NPC_SERVICES).toContain('guild')
    expect(NPC_SERVICES).toContain('repair')
    expect(CHAT_CHANNELS).toEqual(expect.arrayContaining(['guild', 'stall']))
    expect(GUILD_MANAGER_NPCS).toEqual(['NPC_CH_GENARAL_SP'])
    expect([TRADE_SLOTS, STALL_SLOTS, STALL_VISITORS_MAX, HWAN_MAX]).toEqual([12, 10, 8, 5])
    expect(CONTENT_FILES.cos).toBe('cos.json')
    // D33: hwan is kept but not required (older servers), so it is not in PLAYER_STAT_KEYS.
    expect(PLAYER_STAT_KEYS).not.toContain('hwan')
  })
})

// ---- server -> client ----------------------------------------------------------------------------

const stack = (code = 'ITEM_CH_SWORD_01_A', extra: object = {}) => ({ code, count: 1, ...extra })
const side = (items: TradeSide['items'] = Array.from({ length: TRADE_SLOTS }, () => null)): TradeSide => ({ items, gold: 0, locked: false, accepted: false })
const tradeState: TradeState = {
  partner: 5,
  name: 'Mei',
  level: 12,
  mine: side([{ stack: stack('ITEM_CH_SWORD_01_A', { plus: 3, durability: 10 }), bag: 4 }, ...Array.from({ length: TRADE_SLOTS - 1 }, () => null)]),
  theirs: { ...side(), gold: 500, locked: true, accepted: true },
}
const stallView: StallView = {
  owner: 9,
  name: 'Mei',
  title: 'Cheap potions',
  greeting: '',
  state: 'open',
  items: [{ stack: stack('ITEM_ETC_HP_POTION_01', { count: 20 }), price: 30, bag: 2 }, ...Array.from({ length: STALL_SLOTS - 1 }, () => null)],
  visitors: 3,
}
const member: GuildMember = {
  characterId: 22, name: 'Mei', model: 'CHAR_CH_WOMAN_ADVENTURER', level: 12, rank: 'master', perms: ['invite', 'kick'],
  title: '', online: true, lastSeen: 0, joinedAt: 1_700_000_000_000,
}
const guildState: GuildState = {
  id: 1, name: 'Tigers', master: 22, createdAt: 1_700_000_000_000, notice: { title: 'Hunt', text: 'Tonight.', at: 5 }, maxMembers: 50, members: [member],
}
const stats: PlayerStats = {
  level: 5, exp: 100, expToNext: 2938, sp: 12, spExp: 150, hp: 300, maxHp: 320, mp: 280, maxMp: 300, str: 24, int: 24,
  statPoints: 12, gold: 1500, physAttack: [10, 14], magAttack: [8, 12], physDefence: 12, magDefence: 9, hitRate: 30, parryRate: 28,
}

describe('wave 8 server frames', () => {
  it('every new message parses', () => {
    const good: ServerMessage[] = [
      { t: 'alchemyStart', item: 3, readyInMs: 3000 },
      { t: 'alchemyStart', item: 3, readyInMs: 0 },
      { t: 'alchemyResult', item: 3, code: 'ITEM_CH_SWORD_01_A', outcome: 'success', plus: 4 },
      { t: 'alchemyResult', item: 3, code: 'ITEM_CH_SWORD_01_A', outcome: 'cancelled', plus: 0 },
      { t: 'tradeRequested', from: 5, name: 'Mei', level: 12, expiresInMs: 30000 },
      { t: 'trade', trade: tradeState },
      { t: 'tradeEnd', reason: 'done', name: 'Mei' },
      { t: 'tradeEnd', reason: 'failed', message: "Mei's inventory is full." },
      { t: 'stall', stall: stallView },
      { t: 'stall', stall: null, reason: 'closed' },
      { t: 'stall', stall: { ...stallView, state: 'modify', items: Array.from({ length: STALL_SLOTS }, () => null), visitors: 0 } },
      { t: 'stallSold', slot: 0, buyer: 'Hero', code: 'ITEM_ETC_HP_POTION_01', count: 5, price: 150 },
      { t: 'guildInvited', guild: 1, name: 'Tigers', from: 'Mei', expiresInMs: 30000 },
      { t: 'guild', guild: guildState },
      { t: 'guild', guild: null },
      { t: 'guildMember', member: { ...member, online: false, lastSeen: 99 } },
      { t: 'guildMemberRemoved', characterId: 22 },
      { t: 'guildEvent', event: 'joined', name: 'Hero' },
      { t: 'chat', channel: 'guild', fromId: 3, from: 'Mei', text: 'hi' },
      { t: 'chat', channel: 'stall', fromId: 3, from: 'Mei', text: 'hi' },
      { t: 'npcDialog', npc: 1, code: 'NPC_CH_GENARAL_SP', services: ['guild'] },
      { t: 'npcDialog', npc: 1, code: 'NPC_CH_SMITH', services: ['shop', 'repair'] },
      { t: 'actionResult', re: 'guildMaster', ok: true },
    ]
    for (const m of good) serverOk(m)
  })

  it('rejects malformed frames: wrong items lengths, missing keys, out-of-range values', () => {
    const bad: unknown[] = [
      { t: 'trade' },
      { t: 'trade', trade: null },
      { t: 'trade', trade: { ...tradeState, mine: side(Array.from({ length: TRADE_SLOTS - 1 }, () => null)) } },
      { t: 'trade', trade: { ...tradeState, theirs: side(Array.from({ length: TRADE_SLOTS + 1 }, () => null)) } },
      { t: 'trade', trade: { ...tradeState, mine: { ...side(), gold: MAX_GOLD + 1 } } },
      { t: 'tradeEnd', reason: 'bored' },
      { t: 'stall' },
      { t: 'stall', stall: { ...stallView, items: stallView.items.slice(1) } },
      { t: 'stall', stall: { ...stallView, visitors: STALL_VISITORS_MAX + 1 } },
      { t: 'stall', stall: { ...stallView, state: 'closed' } },
      { t: 'stall', stall: { ...stallView, title: 'x'.repeat(STALL_TITLE_MAX + 1) } },
      { t: 'stall', stall: { ...stallView, items: [{ stack: stack(), price: 0 }, ...stallView.items.slice(1)] } },
      { t: 'stall', stall: null, reason: 'bored' },
      { t: 'stallSold', slot: STALL_SLOTS, buyer: 'Hero', code: 'X', count: 1, price: 1 },
      { t: 'guild' },
      { t: 'guild', guild: { ...guildState, members: [] } },
      { t: 'guild', guild: { ...guildState, members: [{ ...member, perms: ['invite', 'invite'] }] } },
      { t: 'guild', guild: { ...guildState, members: [{ ...member, rank: 'vice' }] } },
      { t: 'guild', guild: { ...guildState, notice: { title: '', text: 'x'.repeat(GUILD_NOTICE_MAX + 1), at: 0 } } },
      { t: 'guildMember', member: { ...member, title: 'x'.repeat(GUILD_TITLE_MAX + 1) } },
      { t: 'guildEvent', event: 'party', name: 'x' },
      { t: 'alchemyStart', item: 3, readyInMs: 30001 },
      { t: 'alchemyStart', item: MAX_BAG_SIZE, readyInMs: 0 },
      { t: 'alchemyResult', item: 3, code: 'X', outcome: 'broke', plus: 0 },
      { t: 'alchemyResult', item: 3, code: 'X', outcome: 'fail', plus: 256 },
      { t: 'npcDialog', npc: 1, code: 'X', services: ['guild', 'guild'] },
    ]
    for (const m of bad) serverBad(m)
  })

  it("keeps null (dismounted, parked), '' (no stall, no guild) and 0 (Berserk ended) on entityUpdate", () => {
    const updates: ServerMessage[] = [
      { t: 'entityUpdate', id: 1, mount: 7 },
      { t: 'entityUpdate', id: 1, mount: null },
      { t: 'entityUpdate', id: 7, rider: 1 },
      { t: 'entityUpdate', id: 7, rider: null },
      { t: 'entityUpdate', id: 1, berserkMs: 60000 },
      { t: 'entityUpdate', id: 1, berserkMs: 0 },
      { t: 'entityUpdate', id: 1, stall: 'Cheap potions' },
      { t: 'entityUpdate', id: 1, stall: '' },
      { t: 'entityUpdate', id: 1, guild: 'Tigers' },
      { t: 'entityUpdate', id: 1, guild: '' },
    ]
    for (const m of updates) serverOk(m)
    serverBad({ t: 'entityUpdate', id: 1, berserkMs: 600001 })
    serverBad({ t: 'entityUpdate', id: 1, mount: 'x' })
    serverBad({ t: 'entityUpdate', id: 1, stall: 'x'.repeat(STALL_TITLE_MAX + 1) })
    serverBad({ t: 'entityUpdate', id: 1, guild: 'x'.repeat(GUILD_TITLE_MAX + 1) })
  })

  it("accepts EntityKind 'cos' and the wave-8 EntityState fields", () => {
    const horse: EntityState = { id: 7, kind: 'cos', name: 'Red Horse', model: 'COS_C_HORSE1', level: 1, pos: [1, 0, 2], yaw: 0, hp: 800, maxHp: 800, owner: 1, rider: 1 }
    const rider: EntityState = {
      id: 1, kind: 'player', name: 'Hero_1', model: 'CHAR_CH_MAN_ADVENTURER', level: 12, weapon: 'sword', pos: [1, 0, 2], yaw: 0,
      mount: 7, berserkMs: 42000, stall: 'Cheap potions', guild: 'Tigers',
    }
    for (const entity of [horse, rider]) serverOk({ t: 'spawn', entity })
    for (const extra of [{ berserkMs: 0 }, { berserkMs: 600001 }, { mount: -1 }, { stall: 'x'.repeat(STALL_TITLE_MAX + 1) }, { guild: 'x'.repeat(GUILD_TITLE_MAX + 1) }]) {
      serverBad({ t: 'spawn', entity: { ...rider, ...extra } })
    }
  })

  it('stats.hwan and CombatHit.hwan are kept (D33)', () => {
    serverOk({ t: 'stats', stats: { ...stats, hwan: 5 } })
    serverOk({ t: 'stats', stats: { ...stats, hwan: 0 } })
    serverOk({ t: 'statsDelta', stats: { hwan: 3 } })
    // A full stats from an older server (no hwan) still parses; the wave-8 server always sends it (Gameplay.stats).
    serverOk({ t: 'stats', stats })
    serverBad({ t: 'stats', stats: { ...stats, hwan: HWAN_MAX + 1 } })
    serverBad({ t: 'statsDelta', stats: { hwan: 1.5 } })
    serverOk({ t: 'combat', attacker: 1, target: 2, hits: [{ outcome: 'crit', damage: 80, hp: 10, hwan: true }] })
    const dropped = server({ t: 'combat', attacker: 1, target: 2, hits: [{ outcome: 'hit', damage: 8, hp: 10, hwan: false }] })
    expect(dropped.ok && dropped.msg.t === 'combat' && 'hwan' in dropped.msg.hits[0]!).toBe(false)
  })

  it('worldInfo keeps alchemyRate, alchemyMaxPlus and social', () => {
    const world = { name: 'jangan-fields', serverTime: 5, tickRate: 10, levelCap: 20, alchemyRate: 1.5, alchemyMaxPlus: 10, social: { guildCreateGold: 10000, guildCreateLevel: 10 } }
    const self: EntityState = { id: 1, kind: 'player', name: 'Hero_1', model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'sword', pos: [0, 0, 0], yaw: 0 }
    serverOk({ t: 'worldEnter', self, world, entities: [] })
    serverBad({ t: 'worldEnter', self, world: { ...world, alchemyMaxPlus: 13 }, entities: [] })
    serverBad({ t: 'worldEnter', self, world: { ...world, social: { guildCreateGold: -1, guildCreateLevel: 10 } }, entities: [] })
    serverBad({ t: 'worldEnter', self, world: { ...world, social: 5 }, entities: [] })
  })
})

describe('wave 8 content (docs/WAVE_PLAN2.md §3.3)', () => {
  const sword = {
    code: 'ITEM_CH_SWORD_01_A', id: 3633, name: 'Copper Sword', typeId: [3, 1, 6, 2], category: 'weapon', slot: 'weapon', degree: 1, reqLevel: 1,
    reqGender: 'any', race: 'china', maxStack: 1, price: 890, sellPrice: 222, model: null, icon: null,
  }
  it('ItemDef: perPlus, reinforce, canTrade, the alchemy category and the mount uses pass the check', () => {
    expect(checkItemDef({ ...sword, perPlus: { physAttack: 2.4, magAttack: 4.1 }, canTrade: false })).toEqual([])
    const elixir = { ...sword, code: 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', category: 'alchemy', slot: undefined, reinforce: { kind: 'elixir', targets: [6], rates: [25, 20, 15, 10, 10, 10, 10, 10, 10, 5, 5, 5] } }
    expect(checkItemDef(elixir)).toEqual([])
    expect(checkItemDef({ ...elixir, reinforce: { kind: 'powder', degree: 1, rates: [50, 30] } })).toEqual([])
    expect(checkItemDef({ ...sword, category: 'etc', slot: undefined, use: { summon: 'COS_C_HORSE1' } })).toEqual([])
    expect(checkItemDef({ ...sword, category: 'potion', slot: undefined, use: { hp: 100, target: 'mount' } })).toEqual([])
    expect(checkItemDef({ ...sword, perPlus: { luck: 1 } })).not.toEqual([])
    expect(checkItemDef({ ...sword, perPlus: { physAttack: 'x' } })).not.toEqual([])
    expect(checkItemDef({ ...sword, canTrade: 0 })).not.toEqual([])
    expect(checkItemDef({ ...sword, reinforce: { kind: 'gem', rates: [] } })).not.toEqual([])
    expect(checkItemDef({ ...sword, use: { target: 'self' } })).not.toEqual([])
  })

  it('CosDef and cos.json', () => {
    const horse: CosDef = {
      code: 'COS_C_HORSE1', id: 1906, name: 'Red Horse', level: 1, hp: 800, walkSpeed: 4.5, runSpeed: 9, radius: 1.2,
      physAbsorb: 0, magAbsorb: 0, parryRate: 0, hitRate: 0, model: null, icon: '/out/icon/cos/cos_c_horse1.png',
    }
    expect(checkCosDef(horse)).toEqual([])
    expect(checkCosDef({ ...horse, hp: 0 })).not.toEqual([])
    expect(checkCosDef({ ...horse, code: 'cos horse' })).not.toEqual([])
    const file = { schema: 1, kind: 'cos', generatedAt: '2026-09-28T00:00:00Z', sources: [], entries: [horse] }
    expect(checkContentFile('cos', file)).toEqual([])
    expect(checkContentFile('cos', { ...file, kind: 'items' })).not.toEqual([])
  })
})
