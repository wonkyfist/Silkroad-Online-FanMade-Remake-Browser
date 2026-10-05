/**
 * Forming a party the retail way (docs/UI.md §4.6 Party tab; retail `ifparty.txt`, `ifsetpartymode.txt`, the
 * `UIIT_STT_CHAT_COMMAND_PARTY_*` commands): the party setting box before an invitation that starts a party, the
 * window's Invite / Settings / Leave buttons, and `/party name`, `/LeaveTheParty`, `/BanishFromParty name`.
 * DOM-free: PartyController with a fake PartyIo; every frame it sends must pass the shared validator.
 */
import { PARTY_MAX, parseClientMessage, type ClientMessage, type PartyMember, type PartyState, type ServerMessage } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PARTY_MODES, modesFromChoice, partySetupGroups, partyWindowButtons, rowTitle, type PartyModes, type PartyRow } from '../src/hud/party.ts'
import { choiceHints } from '../src/ui/kit/dialog.ts'
import { matchPrefix } from '../src/world/chat.ts'
import { PARTY_INVITE_COMMANDS, PARTY_KICK_COMMAND, PARTY_LEAVE_COMMAND, PartyController, type PartyIo, type PartyTarget } from '../src/world/features/party.ts'

const member = (characterId: number, name: string, entity: number | null): PartyMember => ({
  characterId, name, model: 'CHAR_CH_MAN_ADVENTURER', level: 10, entity, hp: 100, maxHp: 200, mp: 50, maxMp: 100,
})
/** Me (char 1, entity 101, leader by default), MeiHua (char 2, entity 102). */
const party = (extra: Partial<PartyState> = {}): PartyState => ({
  id: 7, leader: 1, exp: 'share', items: 'free', members: [member(1, 'Hero', 101), member(2, 'MeiHua', 102)], ...extra,
})
const msg = (m: ServerMessage) => m
const valid = (m: ClientMessage | undefined) => {
  expect(m).toBeDefined()
  expect(parseClientMessage(JSON.stringify(m))).toEqual({ ok: true, msg: m })
  return m
}

/** A fake io whose setting box answers `answer` (null = cancelled) and records what it was opened with. */
function fakeIo(answer: PartyModes | null = null, players: PartyTarget[] = [], target: PartyTarget | null = null) {
  const sent: ClientMessage[] = []
  const errors: string[] = []
  const chatErrors: string[] = []
  const boxes: { current: PartyModes; purpose: unknown }[] = []
  const io: PartyIo = {
    send: m => {
      if (!m) return false
      sent.push(m)
      return true
    },
    selfId: () => 101,
    selfName: () => 'Hero',
    livePos: () => null,
    line: () => {},
    error: text => errors.push(text),
    chatError: text => chatErrors.push(text),
    now: () => 0,
    changed: () => {},
    chooseModes: async (current, purpose) => {
      boxes.push({ current: { ...current }, purpose })
      return answer
    },
    findPlayer: name => players.find(p => p.name.toLowerCase() === name.toLowerCase()) ?? null,
    targetPlayer: () => target,
  }
  return { io, sent, errors, chatErrors, boxes }
}

const settle = () => new Promise(r => setTimeout(r, 0))

describe('the party setting box (retail ifsetpartymode)', () => {
  it('EXP on the left, items on the right, each Individual|Free-for-all / Shared, starting from the modes', () => {
    const [exp, items] = partySetupGroups({ exp: 'free', items: 'share' })
    expect(exp.caption).toBe('EXP')
    expect(exp.value).toBe('free')
    expect(exp.choices.map(c => c.label)).toEqual(['Individual', 'Shared'])
    expect(items.caption).toBe('Items')
    expect(items.value).toBe('share')
    expect(items.choices.map(c => c.label)).toEqual(['Free-for-all', 'Shared'])
    expect(choiceHints([exp, items], ['free', 'share'])).toEqual(['Each member earns EXP from their own damage.', 'Drops go to members in turn, gold is split at pickup.'])
    expect(modesFromChoice(['share', 'free'])).toEqual({ exp: 'share', items: 'free' })
    expect(modesFromChoice([])).toEqual(DEFAULT_PARTY_MODES)
  })

  it('an invitation that starts a party asks first; it carries the chosen modes, which are remembered', async () => {
    const f = fakeIo({ exp: 'free', items: 'share' })
    const c = new PartyController(f.io, { exp: 'share', items: 'free' })
    expect(await c.inviteTarget({ id: 102, name: 'MeiHua' })).toBe(true)
    expect(f.boxes).toEqual([{ current: { exp: 'share', items: 'free' }, purpose: { invite: 'MeiHua' } }])
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyInvite', target: 102, exp: 'free', items: 'share' })
    expect(c.modes).toEqual({ exp: 'free', items: 'share' })
  })

  it('cancelling the box sends nothing; in a party the leader invites without the box', async () => {
    const f = fakeIo(null)
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    expect(await c.inviteTarget({ id: 102, name: 'MeiHua' })).toBe(false)
    expect(f.sent).toEqual([])
    c.handle(msg({ t: 'party', party: party() }))
    expect(await c.inviteTarget({ id: 103, name: 'BoLin' })).toBe(true)
    expect(f.boxes).toHaveLength(1)
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyInvite', target: 103 })
  })

  it('a second Invite while the box is open does not open another one', async () => {
    const f = fakeIo({ exp: 'share', items: 'share' })
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    const first = c.inviteTarget({ id: 102, name: 'MeiHua' })
    expect(await c.inviteTarget({ id: 103, name: 'BoLin' })).toBe(false)
    expect(await first).toBe(true)
    expect(f.boxes).toHaveLength(1)
    expect(f.sent).toHaveLength(1)
  })

  it('Settings: out of a party it sets the next party modes; the leader sends one partySettings with what changed; a member is told', async () => {
    const f = fakeIo({ exp: 'free', items: 'share' })
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    await c.openSettings()
    expect(f.boxes.at(-1)).toEqual({ current: DEFAULT_PARTY_MODES, purpose: 'settings' })
    expect(c.modes).toEqual({ exp: 'free', items: 'share' })
    expect(f.sent).toEqual([])

    c.handle(msg({ t: 'party', party: party({ exp: 'share', items: 'free' }) }))
    await c.openSettings()
    expect(f.boxes.at(-1)!.current).toEqual({ exp: 'share', items: 'free' })
    expect(f.sent).toHaveLength(1)
    expect(valid(f.sent[0])).toEqual({ t: 'partySettings', exp: 'free', items: 'share' })

    // nothing changed: nothing sent
    const g = fakeIo({ exp: 'share', items: 'free' })
    const d = new PartyController(g.io, DEFAULT_PARTY_MODES)
    d.handle(msg({ t: 'party', party: party() }))
    await d.openSettings()
    expect(g.sent).toEqual([])

    const h = fakeIo({ exp: 'free', items: 'free' })
    const e = new PartyController(h.io, DEFAULT_PARTY_MODES)
    e.handle(msg({ t: 'party', party: party({ leader: 2 }) }))
    await e.openSettings()
    expect(h.boxes).toEqual([])
    expect(h.errors).toEqual(['Only the party leader can change these.'])
  })
})

describe('the Party window buttons (retail Invite / Set / Party Match slots)', () => {
  it('out of a party: Invite and Settings, Leave greyed', () => {
    const b = partyWindowButtons({ inParty: false, leader: false })
    expect(b.invite.enabled).toBe(true)
    expect(b.settings).toEqual({ enabled: true, title: 'Choose how your next party shares EXP and items.' })
    expect(b.leave.enabled).toBe(false)
  })

  it('a member: Invite and Settings greyed with the reason, Leave on; the leader of a full party: Invite greyed', () => {
    const m = partyWindowButtons({ inParty: true, leader: false, invite: 'notLeader' })
    expect(m.invite).toEqual({ enabled: false, title: 'Only the party leader can invite.' })
    expect(m.settings).toEqual({ enabled: false, title: 'Only the party leader can change these.' })
    expect(m.leave.enabled).toBe(true)
    const full = partyWindowButtons({ inParty: true, leader: true, invite: 'full' })
    expect(full.invite).toEqual({ enabled: false, title: 'The party is full.' })
    expect(full.settings.enabled).toBe(true)
  })

  it('member rows say what a click and a right-click do', () => {
    const row: PartyRow = { characterId: 2, name: 'MeiHua', level: 10, entity: 102, leader: false, self: false, offline: false, dead: false, far: false, hp: 1, maxHp: 2, mp: 1, maxMp: 2 }
    expect(rowTitle(row).split('\n').at(-1)).toBe('Click to target. Right-click: whisper, make leader, kick.')
    expect(rowTitle({ ...row, self: true }).split('\n').at(-1)).toBe('Right-click to leave the party.')
  })
})

describe('the retail chat commands', () => {
  it('/party and /InviteToParty match case-insensitively, need a space before the name, and leave /partyX alone', () => {
    const all = [...PARTY_INVITE_COMMANDS, PARTY_LEAVE_COMMAND, PARTY_KICK_COMMAND, '/p']
    expect(matchPrefix(all, '/party MeiHua')).toEqual({ prefix: '/party', rest: 'MeiHua' })
    expect(matchPrefix(all, '/InviteToParty MeiHua')).toEqual({ prefix: '/invitetoparty', rest: 'MeiHua' })
    expect(matchPrefix(all, '/LeaveTheParty')).toEqual({ prefix: '/leavetheparty', rest: '' })
    expect(matchPrefix(all, '/BanishFromParty MeiHua')).toEqual({ prefix: '/banishfromparty', rest: 'MeiHua' })
    expect(matchPrefix(all, '/partyx')?.prefix).not.toBe('/party')
  })

  it('/party name invites the player in view; without a name, the current target', async () => {
    const mei: PartyTarget = { id: 102, name: 'MeiHua', kind: 'player' }
    const bo: PartyTarget = { id: 103, name: 'BoLin', kind: 'player' }
    const f = fakeIo({ exp: 'share', items: 'free' }, [mei], bo)
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    c.inviteCommand('meihua')
    await settle()
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyInvite', target: 102, exp: 'share', items: 'free' })
    c.inviteCommand('')
    await settle()
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyInvite', target: 103, exp: 'share', items: 'free' })
  })

  it('/party explains: nobody by that name, no target, yourself, already a member, not the leader, full', async () => {
    const mei: PartyTarget = { id: 102, name: 'MeiHua', kind: 'player' }
    const me: PartyTarget = { id: 101, name: 'Hero', kind: 'player' }
    const wen: PartyTarget = { id: 300, name: 'Wen', kind: 'player' }
    const f = fakeIo({ exp: 'share', items: 'free' }, [mei, me, wen])
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    c.inviteCommand('Nobody')
    c.inviteCommand('')
    c.inviteCommand('Hero')
    c.handle(msg({ t: 'party', party: party() }))
    c.inviteCommand('MeiHua')
    c.handle(msg({ t: 'party', party: party({ members: Array.from({ length: PARTY_MAX }, (_, i) => member(i + 1, `M${i}`, 101 + i)) }) }))
    c.inviteCommand('Wen')
    c.handle(msg({ t: 'party', party: party({ leader: 2 }) }))
    c.inviteCommand('Wen')
    await settle()
    expect(f.chatErrors).toEqual([
      'There is no player named Nobody nearby.',
      'Type /party and a player name, or select a player first.',
      'You cannot invite yourself.',
      'MeiHua is already in your party.',
      'The party is full.',
      'Only the party leader can invite.',
    ])
    expect(f.sent).toEqual([])
  })

  it('/BanishFromParty name kicks a member (leader only); /LeaveTheParty leaves', () => {
    const f = fakeIo()
    const c = new PartyController(f.io, DEFAULT_PARTY_MODES)
    c.leaveCommand()
    c.kickCommand('MeiHua')
    c.handle(msg({ t: 'party', party: party() }))
    c.kickCommand('')
    c.kickCommand('Nobody')
    c.kickCommand('meihua')
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyKick', member: 2 })
    c.leaveCommand()
    expect(valid(f.sent.at(-1))).toEqual({ t: 'partyLeave' })
    expect(f.chatErrors).toEqual(['You are not in a party.', 'You are not in a party.', 'Type /banishfromparty and a member name.', 'Nobody is not in your party.'])

    const g = fakeIo()
    const d = new PartyController(g.io, DEFAULT_PARTY_MODES)
    d.handle(msg({ t: 'party', party: party({ leader: 2 }) }))
    d.kickCommand('MeiHua')
    expect(g.sent).toEqual([])
    expect(g.chatErrors).toEqual(['Only the party leader can do that.'])
  })
})
