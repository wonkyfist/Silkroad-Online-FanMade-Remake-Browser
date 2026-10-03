/**
 * Lane GU-C, the guild client (docs/SYSTEMS_SOCIAL.md §9.4, §10.8; docs/WAVE_PLAN2.md §6.5): the member sort (online,
 * grade, level), the Vice Master rule, the command buttons per rank and rights, `guildMember` upserts and
 * `guildMemberRemoved`, the event lines and the login notice, the invitation, the `@`, `/g`, `/guild`, `/join`
 * prefixes, the "Display guild names" toggle, the notice editor's UTF-8 cap, and the offline mock. DOM-free:
 * GuildController is driven through a fake GuildIo, and every frame it sends must pass the shared validator.
 */
import {
  GUILD_EVENT_KINDS,
  GUILD_NOTICE_MAX,
  GUILD_NOTICE_TITLE_MAX,
  GUILD_PERMS,
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
  utf8Length,
  type ClientMessage,
  type EntityState,
  type GuildMember,
  type GuildState,
  type ServerMessage,
} from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { t } from '../src/i18n/index.ts'
import {
  canHandOver,
  canKick,
  clampNotice,
  GuildBook,
  GuildController,
  guildBadgeText,
  guildFailText,
  guildIntent,
  guildRights,
  gradeLabel,
  gradeOf,
  gradeText,
  inviteSecondsLeft,
  lastSeenText,
  loadShowGuild,
  nextSort,
  NOTICE_FRAME_BYTES,
  noticeFits,
  noticeFrameBytes,
  noticeRoom,
  saveShowGuild,
  SHOW_GUILD_KEY,
  sortMembers,
  type GuildIo,
} from '../src/hud/guild-state.ts'
import { en } from '../src/i18n/en.ts'
import type { MockConn, MockContext, MockEntity } from '../src/net/mock.ts'
import { guildMock } from '../src/net/mock/guild.ts'
import { matchPrefix } from '../src/world/chat.ts'
import { applyGuildBadge } from '../src/world/features/guild.ts'

const HOUR = 3_600_000

const member = (characterId: number, name: string, extra: Partial<GuildMember> = {}): GuildMember => ({
  characterId, name, model: 'CHAR_CH_MAN_ADVENTURER', level: 10, rank: 'member', perms: [], title: '', online: true, lastSeen: 0, joinedAt: 0, ...extra,
})

/** Hero (1, master), MeiHua (2, all rights), BoLin (3, kick), Chen (4, offline), Dan (5). */
const guild = (extra: Partial<GuildState> = {}): GuildState => ({
  id: 9,
  name: 'Moonlight',
  master: 1,
  createdAt: 1_700_000_000_000,
  notice: { title: 'Hunt tonight', text: 'West gate at 20:00.', at: 1_700_000_100_000 },
  maxMembers: 50,
  members: [
    member(1, 'Hero', { rank: 'master', level: 12 }),
    member(2, 'MeiHua', { perms: [...GUILD_PERMS], level: 9 }),
    member(3, 'BoLin', { perms: ['kick'], level: 14 }),
    member(4, 'Chen', { online: false, level: 20, lastSeen: 1_700_000_000_000 }),
    member(5, 'Dan', { level: 14 }),
  ],
  ...extra,
})

function fakeIo(selfName: string | null = 'Hero') {
  const sent: ClientMessage[] = []
  const lines: string[] = []
  const system: string[] = []
  const errors: string[] = []
  const chatErrors: string[] = []
  let now = 1000
  let changes = 0
  let name = selfName
  const io: GuildIo = {
    send: msg => {
      if (!msg) return false
      sent.push(msg)
      return true
    },
    selfName: () => name,
    line: text => lines.push(text),
    system: text => system.push(text),
    error: text => errors.push(text),
    chatError: text => chatErrors.push(text),
    now: () => now,
    changed: () => {
      changes++
    },
  }
  return {
    io, sent, lines, system, errors, chatErrors,
    get changes() {
      return changes
    },
    advance(ms: number) {
      now += ms
    },
    set name(v: string | null) {
      name = v
    },
  }
}

const worldEnter = (social?: { guildCreateGold: number; guildCreateLevel: number }): ServerMessage =>
  ({ t: 'worldEnter', self: { id: 101, name: 'Hero' }, world: social ? { social } : {}, entities: [] }) as unknown as ServerMessage

/** Every frame the client sends must be exactly what the server's parser accepts. */
const valid = (m: ClientMessage | null | undefined) => {
  expect(m).toBeTruthy()
  expect(parseClientMessage(JSON.stringify(m))).toEqual({ ok: true, msg: m })
  return m!
}

describe('grades and rights', () => {
  it('shows a member with all four rights as Vice Master, and a title instead of the grade', () => {
    const g = guild()
    expect(g.members.map(gradeOf)).toEqual(['master', 'vice', 'member', 'member', 'member'])
    expect(gradeLabel(g.members[0]!)).toBe(t('guild.master'))
    expect(gradeLabel(g.members[1]!)).toBe(t('guild.vice'))
    expect(gradeLabel(member(9, 'X', { perms: ['invite', 'kick', 'notice'] }))).toBe(t('guild.member'))
    expect(gradeText(member(9, 'X', { title: 'Scout' }))).toBe('Scout')
  })

  it('shows the command buttons by rank and rights', () => {
    const book = new GuildBook()
    book.set(guild())
    const master = guildRights(book, book.me('Hero'))
    expect(master).toEqual({ invite: true, grant: true, kick: true, leave: false, title: true, handOver: true, notice: true })
    const vice = guildRights(book, book.me('meihua'))
    expect(vice).toEqual({ invite: true, grant: false, kick: true, leave: true, title: true, handOver: false, notice: true })
    const plain = guildRights(book, book.me('Dan'))
    expect(plain).toEqual({ invite: false, grant: false, kick: false, leave: true, title: false, handOver: false, notice: false })
    // A master alone may leave (it disbands); nobody in no guild gets anything.
    book.set(guild({ members: [member(1, 'Hero', { rank: 'master' })] }))
    expect(guildRights(book, book.me('Hero'))).toMatchObject({ leave: true, grant: false, kick: false, handOver: false })
    book.set(null)
    expect(Object.values(guildRights(book, undefined)).some(Boolean)).toBe(false)
  })

  it('applies the kick rule: never the master or yourself; kick holders cannot kick each other', () => {
    const g = guild()
    const [hero, mei, bo, , dan] = g.members
    expect(canKick(hero, mei)).toBe(true)
    expect(canKick(hero, hero)).toBe(false)
    expect(canKick(mei, hero)).toBe(false)
    expect(canKick(mei, bo)).toBe(false) // both hold kick
    expect(canKick(mei, dan)).toBe(true)
    expect(canKick(dan, bo)).toBe(false)
    expect(canHandOver(hero, dan)).toBe(true)
    expect(canHandOver(mei, dan)).toBe(false)
    expect(canHandOver(hero, hero)).toBe(false)
  })
})

describe('member list', () => {
  it('sorts online first, then grade, then level, then name', () => {
    const rows = sortMembers(guild().members).map(m => m.name)
    expect(rows).toEqual(['Hero', 'MeiHua', 'BoLin', 'Dan', 'Chen'])
  })

  it('sorts by a column and reverses on a second click', () => {
    let sort = nextSort({ key: 'default', reverse: false }, 'level')
    expect(sortMembers(guild().members, sort).map(m => m.level)).toEqual([20, 14, 14, 12, 9])
    sort = nextSort(sort, 'level')
    expect(sort).toEqual({ key: 'level', reverse: true })
    expect(sortMembers(guild().members, sort).map(m => m.level)[0]).toBe(9)
    expect(sortMembers(guild().members, nextSort(sort, 'name')).map(m => m.name)).toEqual(['BoLin', 'Chen', 'Dan', 'Hero', 'MeiHua'])
  })

  it('writes how long ago an offline member was seen', () => {
    const now = 10 * 86_400_000
    expect(lastSeenText(0, now)).toBe(t('guild.ago.never'))
    expect(lastSeenText(now - 30_000, now)).toBe(t('guild.ago.now'))
    expect(lastSeenText(now - 5 * 60_000, now)).toBe(t('guild.ago.min', { n: 5 }))
    expect(lastSeenText(now - 3 * HOUR, now)).toBe(t('guild.ago.hour', { n: 3 }))
    expect(lastSeenText(now - 2 * 86_400_000 - HOUR, now)).toBe(t('guild.ago.day', { n: 2 }))
  })
})

describe('GuildBook', () => {
  it('upserts guildMember rows, removes guildMemberRemoved ones and follows a mastership change', () => {
    const book = new GuildBook()
    expect(book.upsert(member(7, 'Eve'))).toBeNull() // in no guild: ignored
    expect(book.members).toEqual([])
    const src = guild()
    book.set(src)
    src.members[0]!.level = 99 // the book keeps its own copy
    expect(book.byId(1)!.level).toBe(12)
    expect(book.upsert(member(7, 'Eve'))).toBeNull()
    expect(book.members).toHaveLength(6)
    const prev = book.upsert(member(4, 'Chen', { online: true, level: 21 }))
    expect(prev).toMatchObject({ online: false, level: 20 })
    expect(book.byId(4)).toMatchObject({ online: true, level: 21 })
    expect(book.onlineCount).toBe(6)
    book.upsert(member(2, 'MeiHua', { rank: 'master' }))
    expect(book.state!.master).toBe(2)
    expect(book.master()!.name).toBe('MeiHua')
    expect(book.remove(7)!.name).toBe('Eve')
    expect(book.remove(7)).toBeNull()
    expect(book.members).toHaveLength(5)
    expect(book.full).toBe(false)
    book.set(guild({ maxMembers: 5 }))
    expect(book.full).toBe(true)
  })
})

describe('GuildController', () => {
  it('shows the notice once at login, keeps the create terms and hides nothing it does not know', () => {
    const f = fakeIo()
    const c = new GuildController(f.io)
    c.handle(worldEnter({ guildCreateGold: 25_000, guildCreateLevel: 15 }))
    expect(c.terms).toEqual({ gold: 25_000, level: 15 })
    c.handle({ t: 'guild', guild: guild() })
    expect(f.system).toEqual([t('guild.post', { title: 'Hunt tonight' })])
    c.handle({ t: 'guild', guild: guild() })
    expect(f.system).toHaveLength(1)
    expect(c.book.inGuild).toBe(true)
    expect(c.me?.rank).toBe('master')
    c.handle(worldEnter())
    expect(c.terms).toEqual({ gold: 10_000, level: 10 })
    expect(c.book.inGuild).toBe(false)
  })

  it('writes a line for every event kind, naming yourself differently', () => {
    const f = fakeIo()
    const c = new GuildController(f.io)
    c.handle(worldEnter())
    c.handle({ t: 'guild', guild: guild() })
    for (const event of GUILD_EVENT_KINDS) c.handle({ t: 'guildEvent', event, name: 'MeiHua' })
    // 'left' and 'online'/'offline' for yourself print nothing; everything else a line.
    expect(f.lines.length).toBe(GUILD_EVENT_KINDS.length)
    expect(f.lines).toContain(t('guild.joined', { name: 'MeiHua' }))
    expect(f.lines).toContain(t('guild.noticeBy', { name: 'MeiHua' }))
    f.lines.length = 0
    c.handle({ t: 'guildEvent', event: 'kicked', name: 'Hero' })
    c.handle({ t: 'guildEvent', event: 'master', name: 'Hero' })
    c.handle({ t: 'guildEvent', event: 'left', name: 'Hero' })
    c.handle({ t: 'guildEvent', event: 'online', name: 'Hero' })
    expect(f.lines).toEqual([t('guild.kickedSelf'), t('guild.masterSelf')])
    for (const line of [...f.lines]) expect(line).not.toContain('{')
  })

  it('shows an invitation, answers it (also by /join) and lets it expire', () => {
    const f = fakeIo('Dan')
    const c = new GuildController(f.io)
    c.handle(worldEnter())
    c.joinCommand()
    expect(f.chatErrors).toEqual([t('guild.noInvite')])
    c.handle({ t: 'guildInvited', guild: 9, name: 'Moonlight', from: 'Hero', expiresInMs: 30_000 })
    expect(c.invite).toMatchObject({ guild: 9, name: 'Moonlight', from: 'Hero' })
    expect(inviteSecondsLeft(c.invite!, 1000)).toBe(30)
    c.joinCommand()
    expect(valid(f.sent.at(-1))).toEqual({ t: 'guildRespond', guild: 9, accept: true })
    expect(c.invite).toBeNull()
    // The joiner's 'joined' line comes before its `guild` state: it names the guild from the invitation.
    c.handle({ t: 'guildEvent', event: 'joined', name: 'Dan' })
    expect(f.lines.at(-1)).toBe(t('guild.joinedSelf', { name: 'Moonlight' }))

    // Decline, then the popup's own timeout and the server's 'expired' line (to the invitee it names the guild).
    const g = fakeIo('Dan')
    const d = new GuildController(g.io)
    d.handle(worldEnter())
    d.handle({ t: 'guildInvited', guild: 9, name: 'Moonlight', from: 'Hero', expiresInMs: 30_000 })
    d.respond(false)
    expect(valid(g.sent.at(-1))).toEqual({ t: 'guildRespond', guild: 9, accept: false })
    expect(g.lines).toEqual([t('guild.inviteDeclinedSelf', { name: 'Moonlight' })])
    d.handle({ t: 'guildInvited', guild: 9, name: 'Moonlight', from: 'Hero', expiresInMs: 30_000 })
    g.advance(30_000)
    d.tick(31_000)
    expect(d.invite).toBeNull()
    d.handle({ t: 'guildEvent', event: 'expired', name: 'Moonlight' })
    expect(g.lines.at(-1)).toBe(t('guild.inviteExpiredSelf'))
    // To the inviter it names the invitee.
    d.handle({ t: 'guildEvent', event: 'expired', name: 'Mei' })
    expect(g.lines.at(-1)).toBe(t('guild.expired', { name: 'Mei' }))
  })

  it('sends valid frames for every command and refuses bad input before sending', () => {
    const f = fakeIo()
    const c = new GuildController(f.io)
    c.handle(worldEnter())
    // Not in a guild yet: no invite.
    expect(c.inviteName('MeiHua')).toBe(false)
    expect(f.errors.at(-1)).toBe(t('action.fail.not_in_guild'))
    expect(c.create(55, 'x')).toBe(false)
    expect(f.errors.at(-1)).toBe(t('guild.nameRule'))
    expect(c.create(55, ' Moon7 ')).toBe(true)
    expect(valid(f.sent.at(-1))).toEqual({ t: 'guildCreate', npc: 55, name: 'Moon7' })
    c.handle({ t: 'guild', guild: guild() })
    expect(c.inviteName('bad name')).toBe(false)
    expect(c.inviteName('MeiHua')).toBe(true)
    valid(f.sent.at(-1))
    c.handle({ t: 'actionResult', re: 'guildInvite', ok: true })
    expect(f.lines.at(-1)).toBe(t('guild.inviteSent', { name: 'MeiHua' }))
    expect(c.kick(5)).toBe(true)
    valid(f.sent.at(-1))
    expect(c.setTitle(5, '  Scout ')).toBe(true)
    expect(valid(f.sent.at(-1))).toEqual({ t: 'guildTitle', member: 5, title: 'Scout' })
    expect(c.setTitle(5, 'x'.repeat(13))).toBe(false)
    expect(c.handOver(2)).toBe(true)
    valid(f.sent.at(-1))
    expect(c.setNotice('Hi', 'All welcome')).toBe(true)
    valid(f.sent.at(-1))
    expect(c.disband(55)).toBe(true)
    valid(f.sent.at(-1))
    expect(c.leave()).toBe(true)
    valid(f.sent.at(-1))
    c.handle({ t: 'actionResult', re: 'guildLeave', ok: true })
    expect(f.lines.at(-1)).toBe(t('guild.leftSelf'))
  })

  it('sends one guildPerms per changed member, never for the master', () => {
    const f = fakeIo()
    const c = new GuildController(f.io)
    c.handle(worldEnter())
    c.handle({ t: 'guild', guild: guild() })
    const n = c.applyPerms(new Map([
      [1, ['invite']], // the master: skipped
      [2, ['notice', 'invite', 'kick', 'title']], // unchanged (order does not matter)
      [3, ['kick', 'invite', 'kick']], // changed, deduplicated
      [5, []], // unchanged
    ]))
    expect(n).toBe(1)
    expect(valid(f.sent.at(-1))).toEqual({ t: 'guildPerms', member: 3, perms: ['invite', 'kick'] })
  })

  it('names refusals from the guild table, the reason table or the server', () => {
    expect(guildFailText('guildCreate', 'requirements', undefined, { level: 15 })).toBe(t('guild.fail.create.requirements', { level: 15 }))
    expect(guildFailText('guildCreate', 'not_enough_gold', undefined, { gold: 25_000 })).toContain('25,000')
    expect(guildFailText('guildInvite', 'in_guild')).toBe(t('guild.fail.invite.in_guild'))
    expect(guildFailText('guildTitle', 'no_permission')).toBe(t('action.fail.no_permission'))
    expect(guildFailText('guildLeave', 'no_permission', 'Server says so.')).toBe('Server says so.')
    expect(guildFailText('guildNotice', undefined)).toBe(t('action.fail.generic'))
    const f = fakeIo()
    const c = new GuildController(f.io)
    c.handle({ t: 'actionResult', re: 'guildKick', ok: false, reason: 'invalid_target' })
    c.handle({ t: 'actionResult', re: 'partyKick', ok: false, reason: 'not_found' }) // not ours
    expect(f.errors).toEqual([t('guild.fail.kick.invalid_target')])
  })

  it('has a string for every key it uses', () => {
    const table = en as Record<string, string>
    for (const k of Object.keys(table).filter(k => k.startsWith('guild.'))) expect(table[k]).toBeTruthy()
    for (const k of ['keys.window.guild', 'guild.option.showNames', 'guild.invitedHeader', 'guild.inviteAction']) expect(table[k]).toBeTruthy()
  })
})

describe('chat prefixes', () => {
  const PREFIXES = ['@', '/g', '/guild', '/join', '#', '/w', '/trade']

  it('routes @ and /g to guild chat, /guild to an invite, /join to the answer, and leaves /guilds to the GM path', () => {
    expect(matchPrefix(PREFIXES, '@hello all')).toEqual({ prefix: '@', rest: 'hello all' })
    expect(matchPrefix(PREFIXES, '/g hello')).toEqual({ prefix: '/g', rest: 'hello' })
    expect(matchPrefix(PREFIXES, '/guild Bob')).toEqual({ prefix: '/guild', rest: 'Bob' })
    expect(matchPrefix(PREFIXES, '/join')).toEqual({ prefix: '/join', rest: '' })
    expect(matchPrefix(PREFIXES, '/guilds info Moonlight')).toBeNull()
    expect(matchPrefix(PREFIXES, '/go')).toBeNull()
  })

  it('sends guild chat only while in a guild', () => {
    const f = fakeIo()
    const c = new GuildController(f.io)
    c.handle(worldEnter())
    c.chat('hello')
    expect(f.sent).toEqual([])
    expect(f.chatErrors).toEqual([t('guild.chatNoGuild')])
    c.handle({ t: 'guild', guild: guild() })
    c.chat('hello')
    c.chat('')
    expect(f.sent).toHaveLength(1)
    expect(valid(f.sent[0])).toEqual({ t: 'chat', text: 'hello', channel: 'guild' })
  })
})

describe('Display guild names', () => {
  it('hides the badge when off, and remembers the choice per browser', () => {
    expect(guildBadgeText('Moonlight', true)).toBe('Moonlight')
    expect(guildBadgeText('Moonlight', false)).toBeNull()
    expect(guildBadgeText(undefined, true)).toBeNull()
    expect(guildBadgeText('', true)).toBeNull()
    const store = new Map<string, string>()
    const g = globalThis as { localStorage?: unknown }
    const before = g.localStorage
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    try {
      expect(loadShowGuild()).toBe(true)
      saveShowGuild(false)
      expect(store.get(SHOW_GUILD_KEY)).toBe('0')
      expect(loadShowGuild()).toBe(false)
      saveShowGuild(true)
      expect(loadShowGuild()).toBe(true)
      g.localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
      expect(loadShowGuild()).toBe(true)
      expect(() => saveShowGuild(false)).not.toThrow()
    } finally {
      g.localStorage = before
    }
  })

  it('sets the guild-line badge on a name tag and clears it', () => {
    const calls: [string, string | null, string | undefined][] = []
    const label = { querySelector: () => null, firstElementChild: null, prepend: () => {} }
    const view = { setBadge: (k: string, text: string | null, cls?: string) => void calls.push([k, text, cls]), label: label as unknown as HTMLElement }
    applyGuildBadge(view, 'Moonlight')
    applyGuildBadge(view, guildBadgeText('Moonlight', false))
    expect(calls).toEqual([['guild', 'Moonlight', 'guild-line'], ['guild', null, 'guild-line']])
  })
})

describe('notice editor', () => {
  it('keeps the whole guildNotice frame under 900 UTF-8 bytes, also with astral characters', () => {
    const astral = '😀'.repeat(GUILD_NOTICE_MAX)
    const title = '😀'.repeat(GUILD_NOTICE_TITLE_MAX)
    expect(noticeFits(title, astral)).toBe(false)
    const c = clampNotice(title + 'extra', astral)
    expect([...c.title]).toHaveLength(GUILD_NOTICE_TITLE_MAX)
    expect(noticeFrameBytes(c.title, c.text)).toBeLessThanOrEqual(NOTICE_FRAME_BYTES)
    expect(noticeFits(c.title, c.text)).toBe(true)
    // Whole code points only: no lone surrogate.
    expect(c.text).toBe('😀'.repeat([...c.text].length))
    expect(noticeRoom(c.title, c.text)).toBeLessThan(4)
    const msg = valid(guildIntent.notice(c.title, c.text))
    expect(utf8Length(JSON.stringify(msg))).toBeLessThanOrEqual(MAX_CLIENT_MESSAGE_BYTES)
    // Plain ASCII up to the code-point limit always fits.
    const ascii = clampNotice('Title', 'a'.repeat(400))
    expect(ascii.text).toHaveLength(GUILD_NOTICE_MAX)
    expect(noticeRoom('Title', ascii.text)).toBe(0)
    expect(guildIntent.notice('x'.repeat(GUILD_NOTICE_TITLE_MAX + 1), '')).toBeNull()
  })
})

describe('guild intents', () => {
  it('builds only frames the server accepts', () => {
    valid(guildIntent.create(0, 'Ab'))
    expect(guildIntent.create(1, '1abc')).toBeNull()
    expect(guildIntent.create(-1, 'Abc')).toBeNull()
    valid(guildIntent.disband(3))
    valid(guildIntent.invite('Mei_Hua'))
    expect(guildIntent.invite('ab')).toBeNull()
    valid(guildIntent.respond(4, true))
    expect(guildIntent.respond(0, true)).toBeNull()
    valid(guildIntent.leave())
    valid(guildIntent.kick(1))
    expect(guildIntent.kick(0)).toBeNull()
    expect(valid(guildIntent.perms(2, ['title', 'invite', 'title']))).toEqual({ t: 'guildPerms', member: 2, perms: ['invite', 'title'] })
    valid(guildIntent.title(2, ''))
    valid(guildIntent.master(2))
  })
})

// ---- the offline mock ---------------------------------------------------------------------------------------------

function mockWorld() {
  let now = 5_000_000
  const out = new Map<MockConn, ServerMessage[]>()
  const all: ServerMessage[] = []
  const ents = new Map<number, MockEntity>()
  const add = (id: number, name: string, kind: EntityState['kind'], extra: Partial<MockEntity> = {}) => {
    const e = { state: { id, kind, name, model: 'CHAR_CH_MAN_ADVENTURER', level: 10, pos: [0, 0, 0], yaw: 0 } as unknown as EntityState, bot: false, nextThink: 0, ...extra } as MockEntity
    ents.set(id, e)
    return e
  }
  const hero = add(1, 'Hero', 'player')
  const mei = add(2, 'MeiHua', 'player')
  add(3, 'Xiao_Lin', 'player', { bot: true })
  add(50, 'Leebaek', 'npc', { npc: { code: 'NPC_CH_GENARAL_SP' } })
  const conn = (e: MockEntity): MockConn => {
    const c: MockConn = { deliver: m => out.get(c)!.push(m), entityId: e.state.id, charId: e.state.id + 1000 }
    out.set(c, [])
    return c
  }
  const hc = conn(hero)
  const mc = conn(mei)
  const ctx = {
    content: null as never,
    now: () => now,
    result: (c: MockConn, re: ClientMessage['t'], ok: boolean, reason?: string) => c.deliver({ t: 'actionResult', re, ok, ...(reason ? { reason } : {}) } as ServerMessage),
    send: (c: MockConn, m: ServerMessage) => c.deliver(m),
    broadcast: (m: ServerMessage) => void all.push(m),
    snapshot: (e: MockEntity) => e.state,
    dist: () => 3,
    selfOf: (c: MockConn) => ents.get(c.entityId!),
    entity: (id: number) => ents.get(id),
    entities: () => ents.values(),
  } as unknown as MockContext
  const send = (c: MockConn, m: ClientMessage) => guildMock.handle!(ctx, c, m)
  const last = (c: MockConn, re: string) => [...out.get(c)!].reverse().find(m => m.t === 'actionResult' && m.re === re) as Extract<ServerMessage, { t: 'actionResult' }>
  return { ctx, hc, mc, out, all, send, last, advance: (ms: number) => (now += ms), get now() { return now } }
}

describe('guild mock', () => {
  it('creates at the Guild Manager, invites a player and a bot, routes guild chat and applies the kick rule', () => {
    const w = mockWorld()
    guildMock.enter!(w.ctx, w.hc)
    guildMock.enter!(w.ctx, w.mc)
    w.send(w.hc, { t: 'guildCreate', npc: 2, name: 'Moon' })
    expect(w.last(w.hc, 'guildCreate')).toMatchObject({ ok: false, reason: 'not_found' })
    w.send(w.hc, { t: 'guildCreate', npc: 50, name: 'Moon' })
    expect(w.last(w.hc, 'guildCreate').ok).toBe(true)
    expect(w.out.get(w.hc)!.find(m => m.t === 'guild')).toMatchObject({ guild: { name: 'Moon', members: [{ name: 'Hero', rank: 'master' }] } })
    expect(w.all).toContainEqual({ t: 'entityUpdate', id: 1, guild: 'Moon' })

    w.send(w.hc, { t: 'guildInvite', name: 'MeiHua' })
    const invited = w.out.get(w.mc)!.find(m => m.t === 'guildInvited')
    expect(invited).toMatchObject({ name: 'Moon', from: 'Hero' })
    w.send(w.mc, { t: 'guildRespond', guild: (invited as { guild: number }).guild, accept: true })
    expect(w.out.get(w.hc)!).toContainEqual({ t: 'guildEvent', event: 'joined', name: 'MeiHua' })

    w.send(w.hc, { t: 'guildInvite', name: 'Xiao_Lin' })
    w.advance(1500)
    guildMock.tick!(w.ctx, w.now)
    expect(w.out.get(w.hc)!).toContainEqual({ t: 'guildEvent', event: 'joined', name: 'Xiao_Lin' })

    w.send(w.mc, { t: 'chat', text: 'hi guild', channel: 'guild' })
    expect(w.out.get(w.hc)!).toContainEqual({ t: 'chat', channel: 'guild', fromId: 2, from: 'MeiHua', text: 'hi guild' })

    w.send(w.mc, { t: 'guildKick', member: 1001 })
    expect(w.last(w.mc, 'guildKick')).toMatchObject({ ok: false, reason: 'invalid_target' })
    w.send(w.hc, { t: 'guildLeave' })
    expect(w.last(w.hc, 'guildLeave')).toMatchObject({ ok: false, reason: 'no_permission' })
    w.send(w.hc, { t: 'guildKick', member: 1002 })
    expect(w.last(w.hc, 'guildKick').ok).toBe(true)
    expect(w.out.get(w.mc)!.at(-1)).toMatchObject({ t: 'guild', guild: null })
  })
})
