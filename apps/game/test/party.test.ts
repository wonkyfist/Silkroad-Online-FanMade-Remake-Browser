/**
 * Lane PT-C, the party client (docs/QUESTS.md §4.5, §7 lane D): the party book and rows, the member menu, the
 * invitation, the event lines, the Invite button rule, party chat and the minimap pins. DOM-free: PartyController is
 * driven through a fake PartyIo, and every frame it sends must pass the shared validator.
 */
import { PARTY_EVENT_KINDS, PARTY_MAX, parseClientMessage, type ClientMessage, type PartyMember, type PartyState, type ServerMessage } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { inviteLines, pendingInvite, secondsLeft } from '../src/hud/party-invite.ts'
import { DEFAULT_PARTY_MODES, PartyBook, gauge, memberMenu, modesText, partyRows, PARTY_PIN, type PartyRow, type XZ } from '../src/hud/party.ts'
import { matchPrefix } from '../src/world/chat.ts'
import { PartyController, partyFailText, type PartyIo } from '../src/world/features/party.ts'

const member = (characterId: number, name: string, entity: number | null, extra: Partial<PartyMember> = {}): PartyMember => ({
  characterId, name, model: 'CHAR_CH_MAN_ADVENTURER', level: 10, entity, hp: 100, maxHp: 200, mp: 50, maxMp: 100, ...extra,
})

/** Me (char 1, entity 101), Mei (char 2, entity 102), Bo (char 3, offline). */
const party = (extra: Partial<PartyState> = {}): PartyState => ({
  id: 7,
  leader: 1,
  exp: 'share',
  items: 'free',
  members: [member(1, 'Hero', 101, { pos: [0, 0] }), member(2, 'MeiHua', 102, { pos: [10, 0] }), member(3, 'BoLin', null)],
  ...extra,
})

function fakeIo(selfId: number | null = 101, selfName = 'Hero') {
  const sent: ClientMessage[] = []
  const lines: string[] = []
  const errors: string[] = []
  const chatErrors: string[] = []
  const live = new Map<number, XZ>()
  let now = 1000
  let changes = 0
  const io: PartyIo = {
    send: msg => {
      if (!msg) return false
      sent.push(msg)
      return true
    },
    selfId: () => selfId,
    selfName: () => selfName,
    livePos: e => live.get(e) ?? null,
    line: text => lines.push(text),
    error: text => errors.push(text),
    chatError: text => chatErrors.push(text),
    now: () => now,
    changed: () => {
      changes++
    },
  }
  return {
    io, sent, lines, errors, chatErrors, live,
    get changes() {
      return changes
    },
    advance(ms: number) {
      now += ms
    },
    get now() {
      return now
    },
  }
}

const msg = (m: ServerMessage) => m
/** Every frame the client sends must be exactly what the server's parser accepts. */
const valid = (m: ClientMessage | undefined) => {
  expect(m).toBeDefined()
  expect(parseClientMessage(JSON.stringify(m))).toEqual({ ok: true, msg: m })
  return m
}

describe('PartyBook', () => {
  it('reports formed / modes / leader / ended changes and copies the state', () => {
    const book = new PartyBook()
    const p = party()
    expect(book.set(p)).toEqual({ formed: true, ended: false, modes: false, leader: false })
    p.members[0]!.hp = 1
    expect(book.member(1)?.hp).toBe(100)
    expect(book.set(party({ items: 'share' }))).toEqual({ formed: false, ended: false, modes: true, leader: false })
    expect(book.set(party({ items: 'share', leader: 2 }))).toEqual({ formed: false, ended: false, modes: false, leader: true })
    expect(book.set(null)).toEqual({ formed: false, ended: true, modes: false, leader: false })
    expect(book.inParty).toBe(false)
  })

  it('merges vitals: changed fields only, offline drops the position, unknown members are ignored', () => {
    const book = new PartyBook()
    book.set(party())
    expect(book.applyVitals([{ characterId: 2, hp: 100 }])).toBe(false)
    expect(book.applyVitals([{ characterId: 2, hp: 80, mp: 10, level: 11, pos: [20, 5] }, { characterId: 99, hp: 1 }])).toBe(true)
    expect(book.member(2)).toMatchObject({ hp: 80, mp: 10, level: 11, pos: [20, 5] })
    expect(book.applyVitals([{ characterId: 2, dead: true }])).toBe(true)
    expect(book.member(2)?.dead).toBe(true)
    expect(book.applyVitals([{ characterId: 2, dead: false }])).toBe(true)
    expect(book.member(2)?.dead).toBeUndefined()
    expect(book.applyVitals([{ characterId: 2, entity: null }])).toBe(true)
    expect(book.member(2)?.entity).toBeNull()
    expect(book.member(2)?.pos).toBeUndefined()
    expect(book.applyVitals([{ characterId: 3, entity: 130, pos: [1, 1] }])).toBe(true)
    expect(book.byEntity(130)?.name).toBe('BoLin')
  })

  it('knows the leader, mates and a full party', () => {
    const book = new PartyBook()
    book.set(party())
    expect(book.isLeader(101)).toBe(true)
    expect(book.isLeader(102)).toBe(false)
    expect(book.isMate(102, 101)).toBe(true)
    expect(book.isMate(101, 101)).toBe(false)
    expect(book.isMate(555, 101)).toBe(false)
    expect(book.full).toBe(false)
    book.set(party({ members: Array.from({ length: PARTY_MAX }, (_, i) => member(i + 1, `Member${i}`, 100 + i)) }))
    expect(book.full).toBe(true)
  })
})

describe('party rows and menu', () => {
  it('marks self, leader, offline, dead and out-of-range (60 m) members', () => {
    const p = party()
    p.members[1]!.pos = [59, 0]
    p.members.push(member(4, 'Far', 104, { pos: [61, 0] }), member(5, 'Down', 105, { hp: 0, pos: [1, 1] }))
    const rows = partyRows(p, 101, () => null)
    const by = new Map(rows.map(r => [r.name, r]))
    expect(by.get('Hero')).toMatchObject({ self: true, leader: true, far: false })
    expect(by.get('MeiHua')).toMatchObject({ self: false, leader: false, far: false, offline: false })
    expect(by.get('BoLin')).toMatchObject({ offline: true, far: false, dead: false })
    expect(by.get('Far')?.far).toBe(true)
    expect(by.get('Down')?.dead).toBe(true)
    // A live position in view wins over the last pos the server sent.
    const live = partyRows(p, 101, e => (e === 104 ? { x: 30, z: 0 } : null))
    expect(live.find(r => r.name === 'Far')?.far).toBe(false)
    expect(partyRows(null, 101, () => null)).toEqual([])
  })

  it('offers Target/Whisper, Make leader and Kick to the leader, Leave always last', () => {
    const rows = partyRows(party(), 101, () => null)
    const [me, mei, bo] = rows as [PartyRow, PartyRow, PartyRow]
    expect(memberMenu(me, true, false)).toEqual(['leave'])
    expect(memberMenu(mei, true, true)).toEqual(['target', 'whisper', 'leader', 'kick', 'leave'])
    expect(memberMenu(mei, false, false)).toEqual(['whisper', 'leave'])
    expect(memberMenu(bo, true, false)).toEqual(['kick', 'leave'])
  })

  it('formats the modes and gauges', () => {
    expect(modesText(DEFAULT_PARTY_MODES)).toBe('EXP: Shared · Items: Free-for-all')
    expect(gauge(50, 200)).toBe(0.25)
    expect(gauge(5, 0)).toBe(0)
    expect(gauge(300, 200)).toBe(1)
  })
})

describe('invitation popup model', () => {
  it('words the invite and counts down', () => {
    const inv = pendingInvite({ t: 'partyInvited', inviter: 102, name: 'MeiHua', level: 12, exp: 'share', items: 'free', expiresInMs: 30_000 }, 1000)
    expect(inviteLines(inv)).toEqual(['MeiHua (Lv 12) invites you to a party.', 'EXP: Shared. Items: Free-for-all.'])
    expect(secondsLeft(inv, 1000)).toBe(30)
    expect(secondsLeft(inv, 30_500)).toBe(1)
    expect(secondsLeft(inv, 40_000)).toBe(0)
  })
})

describe('PartyController', () => {
  it('builds the party from the server and words the lines', () => {
    const f = fakeIo()
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    c.handle(msg({ t: 'party', party: party() }))
    expect(c.book.inParty).toBe(true)
    expect(f.lines).toEqual(['You are now in a party. Start a chat line with # to talk to it.'])
    expect(c.leader).toBe(true)
    c.handle(msg({ t: 'party', party: party({ exp: 'free' }) }))
    expect(f.lines.at(-1)).toBe('Party distribution: EXP Individual, items Free-for-all.')
    const before = f.changes
    c.handle(msg({ t: 'partyVitals', members: [{ characterId: 2, hp: 5 }] }))
    expect(f.changes).toBe(before + 1)
    c.handle(msg({ t: 'partyVitals', members: [{ characterId: 2, hp: 5 }] }))
    expect(f.changes).toBe(before + 1)
    // A new world visit forgets the party until the server sends it again.
    c.handle(msg({ t: 'worldEnter' } as unknown as ServerMessage))
    expect(c.book.inParty).toBe(false)
  })

  it('shows every party event as a line, naming yourself as "you"', () => {
    const f = fakeIo()
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    for (const event of PARTY_EVENT_KINDS) c.handle(msg({ t: 'partyEvent', event, name: 'MeiHua' }))
    expect(f.lines).toHaveLength(PARTY_EVENT_KINDS.length)
    for (const l of f.lines) expect(l).not.toMatch(/^party\.|\{name\}/)
    expect(f.lines).toContain('MeiHua joined the party.')
    expect(f.lines).toContain('Your party invitation to MeiHua expired.')
    expect(f.lines).toContain('The party has been disbanded.')
    f.lines.length = 0
    for (const event of ['joined', 'kicked', 'leader'] as const) c.handle(msg({ t: 'partyEvent', event, name: 'Hero' }))
    expect(f.lines).toEqual(['You joined the party.', 'You were removed from the party.', 'You are now the party leader.'])
  })

  it('invitation: accept sends partyRespond with the inviter entity; it expires by time and by event', () => {
    const f = fakeIo()
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    const invited = msg({ t: 'partyInvited', inviter: 102, name: 'MeiHua', level: 12, exp: 'share', items: 'free', expiresInMs: 30_000 })
    c.handle(invited)
    expect(c.invite?.name).toBe('MeiHua')
    c.respond(true)
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyRespond', inviter: 102, accept: true })
    expect(c.invite).toBeNull()
    c.respond(true)
    expect(f.sent).toHaveLength(1)

    c.handle(invited)
    c.respond(false)
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyRespond', inviter: 102, accept: false })
    expect(f.lines.at(-1)).toBe('You declined the party invitation from MeiHua.')

    // Runs out locally, then the server's 'expired' line names the inviter.
    c.handle(invited)
    f.advance(29_999)
    c.tick(f.now)
    expect(c.invite).not.toBeNull()
    f.advance(1)
    c.tick(f.now)
    expect(c.invite).toBeNull()
    c.handle(msg({ t: 'partyEvent', event: 'expired', name: 'MeiHua' }))
    expect(f.lines.at(-1)).toBe('The party invitation from MeiHua expired.')

    // The server's 'expired' closes an open popup.
    c.handle(invited)
    c.handle(msg({ t: 'partyEvent', event: 'expired', name: 'MeiHua' }))
    expect(c.invite).toBeNull()
    expect(f.lines.at(-1)).toBe('The party invitation from MeiHua expired.')

    // A refused answer is shown.
    c.handle(msg({ t: 'actionResult', re: 'partyRespond', ok: false, reason: 'no_invite' }))
    expect(f.errors.at(-1)).toBe('That invitation has expired.')
  })

  it('Invite button: other players while solo, or as leader of a party with room', () => {
    const f = fakeIo()
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    expect(c.canInvite({ id: 102, kind: 'player' })).toBe(true)
    expect(c.canInvite({ id: 101, kind: 'player' })).toBe(false)
    expect(c.canInvite({ id: 500, kind: 'mob' })).toBe(false)
    expect(c.canInvite({ id: 501, kind: 'npc' })).toBe(false)
    c.handle(msg({ t: 'party', party: party() }))
    expect(c.canInvite({ id: 102, kind: 'player' })).toBe(false)
    expect(c.canInvite({ id: 200, kind: 'player' })).toBe(true)
    c.handle(msg({ t: 'party', party: party({ leader: 2 }) }))
    expect(c.canInvite({ id: 200, kind: 'player' })).toBe(false)
    c.handle(msg({ t: 'party', party: party({ members: Array.from({ length: PARTY_MAX }, (_, i) => member(i + 1, `Member${i}`, 101 + i)) }) }))
    expect(c.leader).toBe(true)
    expect(c.canInvite({ id: 300, kind: 'player' })).toBe(false)
    expect(new PartyController(fakeIo(null).io).canInvite({ id: 102, kind: 'player' })).toBe(false)
  })

  it('invites with the chosen modes only when starting a party, and reports the answer', () => {
    const f = fakeIo()
    const c = new PartyController(f.io, { exp: 'free', items: 'share' })
    c.inviteTarget({ id: 102, name: 'MeiHua' })
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyInvite', target: 102, exp: 'free', items: 'share' })
    c.handle(msg({ t: 'actionResult', re: 'partyInvite', ok: true }))
    expect(f.lines.at(-1)).toBe('Party invitation sent to MeiHua.')
    c.inviteTarget({ id: 103, name: 'BoLin' })
    c.handle(msg({ t: 'actionResult', re: 'partyInvite', ok: false, reason: 'in_party' }))
    expect(f.errors.at(-1)).toBe('That player is already in a party.')
    c.inviteTarget({ id: 104, name: 'Wen' })
    c.handle(msg({ t: 'actionResult', re: 'partyInvite', ok: false, reason: 'cooldown', message: 'Wen already has a party invitation.' }))
    expect(f.errors.at(-1)).toBe('Wen already has a party invitation.')
    c.handle(msg({ t: 'party', party: party() }))
    c.inviteTarget({ id: 105, name: 'Lan' })
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyInvite', target: 105 })
  })

  it('leave, kick, leader and settings send valid frames; only the leader changes the modes', () => {
    const f = fakeIo()
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    c.leave()
    expect(f.sent).toHaveLength(0)
    // Out of a party the modes are the ones a new party gets.
    c.setMode('items', 'share')
    expect(c.modes).toEqual({ exp: 'share', items: 'share' })
    expect(f.sent).toHaveLength(0)

    c.handle(msg({ t: 'party', party: party() }))
    c.setMode('exp', 'share')
    expect(f.sent).toHaveLength(0)
    c.setMode('exp', 'free')
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partySettings', exp: 'free' })
    c.kick(2)
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyKick', member: 2 })
    c.makeLeader(2)
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyLeader', member: 2 })
    c.leave()
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyLeave' })
    c.handle(msg({ t: 'party', party: null }))
    expect(f.lines.at(-1)).toBe('You left the party.')

    const g = fakeIo()
    const d = new PartyController(g.io, DEFAULT_PARTY_MODES)
    d.handle(msg({ t: 'party', party: party({ leader: 2 }) }))
    d.setMode('items', 'share')
    expect(g.sent).toHaveLength(0)
    expect(g.errors).toEqual(['Only the party leader can do that.'])
  })

  it('party chat: # lines go to the party channel, or explain that there is no party', () => {
    expect(matchPrefix(['#', '/w'], '#hello all')).toEqual({ prefix: '#', rest: 'hello all' })
    const f = fakeIo()
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    c.partyChat('hi')
    expect(f.sent).toHaveLength(0)
    expect(f.chatErrors).toEqual(['You are not in a party. Invite someone first.'])
    c.handle(msg({ t: 'party', party: party() }))
    c.partyChat('')
    expect(f.sent).toHaveLength(0)
    c.partyChat('pull the next pack')
    expect(valid(f.sent.at(-1))).toEqual({ t: 'chat', text: 'pull the next pack', channel: 'party' })
  })

  it('minimap pins: other online members, live position first, even beyond view range', () => {
    const f = fakeIo()
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    expect(c.markers()).toEqual([])
    const p = party()
    p.members.push(member(4, 'Scout', 104, { pos: [400, -250] }))
    c.handle(msg({ t: 'party', party: p }))
    f.live.set(102, { x: 12, z: 3 })
    const pins = c.markers()
    expect(pins.map(m => [m.x, m.z])).toEqual([[12, 3], [400, -250]])
    for (const m of pins) expect(m.icon).toBe(PARTY_PIN)
  })

  it('words refusals: server sentence, then the party reason, then the generic line', () => {
    expect(partyFailText('partyInvite', 'not_found')).toBe('That player is not nearby.')
    expect(partyFailText('partyInvite', 'dead')).toBe('You cannot do that while dead.')
    expect(partyFailText('partyInvite', 'in_party', 'Mei is already in a party.')).toBe('Mei is already in a party.')
    expect(partyFailText('partyRespond', undefined)).toBe('That did not work.')
  })
})
