/**
 * Party end to end (docs/QUESTS.md §7 lane D; lane PT-S): the real server on an ephemeral port with headless clients.
 * Invite -> accept -> both get `party`; a kill in share mode gives both members EXP; `#`-style party chat
 * (`chat {channel: 'party'}`) reaches only the members; a disconnect shows the member offline and a relog brings the
 * party back in the enter sequence; leaving clears the party.
 */
import type { ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, contentFiles, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const SPAWN = [10, 0, -10]
let s: TestServer
let seq = 0

beforeAll(async () => {
  s = await startTestServer({
    config: { rng: seeded(11), spawnMobs: false },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN }),
      ...contentFiles({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS, drops: DROPS }),
    },
  })
})
afterAll(async () => {
  await s.stopAndClean()
})

async function inWorld(token?: string, charId?: number) {
  const acc = token ? { token } : await newAccount(s.url, 'pty')
  const c = await Client.login(s.url, acc.token)
  let id = charId
  let name = ''
  if (id === undefined) {
    name = `Pt${Date.now() % 1e5}${++seq}`.slice(0, 12)
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    id = ch.id
  }
  c.send({ t: 'enterWorld', id })
  const enter = await c.next('worldEnter')
  return { c, token: acc.token, charId: id, name: enter.self.name ?? name, id: enter.self.id }
}

async function act(c: Client, msg: Record<string, unknown> & { t: string }): Promise<Msg<'actionResult'>> {
  c.send(msg)
  return c.next('actionResult', (m) => m.re === msg.t)
}

const partyLines = (c: Client) => c.log.filter((m): m is Msg<'chat'> => m.t === 'chat' && m.channel === 'party')

describe('party end to end', () => {
  it('invite -> accept -> party; share-mode kill EXP for both; party chat to members only; offline, relog, leave', async () => {
    const a = await inWorld()
    const b = await inWorld()
    const x = await inWorld()
    // wait until each sees the others (interest runs on the tick)
    await a.c.next('spawn', (m) => m.entity.id === b.id).catch(() => undefined)

    // not in a party: party chat is refused
    a.c.send({ t: 'chat', text: 'anyone?', channel: 'party' })
    expect(await a.c.next('error', (m) => m.re === 'chat')).toMatchObject({ code: 'bad_request', message: 'You are not in a party.' })

    expect(await act(a.c, { t: 'partyInvite', target: b.id })).toMatchObject({ ok: true })
    const inv = await b.c.next('partyInvited')
    expect(inv).toMatchObject({ inviter: a.id, name: a.name, exp: 'share', items: 'free' })
    expect(await act(b.c, { t: 'partyRespond', inviter: a.id, accept: true })).toMatchObject({ ok: true })
    for (const p of [a, b]) {
      const st = (await p.c.next('party')).party!
      expect(st.leader).toBe(a.charId)
      expect(st.members.map((m) => m.entity)).toEqual([a.id, b.id])
      expect(await p.c.next('partyEvent')).toEqual({ t: 'partyEvent', event: 'joined', name: b.name })
    }

    // a kill in share mode: both get EXP (Mangnyang 40 EXP, 2 members: pool 44 -> 22 each)
    const m = s.ctx.gameplay.createMob(MANGNYANG, 'normal', SPAWN[0] + 2, SPAWN[2], 0, null, Date.now())
    await a.c.next('spawn', (e) => e.entity.id === m.id)
    expect(await act(a.c, { t: 'attack', target: m.id })).toMatchObject({ ok: true })
    const ga = await a.c.next('statsDelta', (d) => d.gain?.from === m.id, 15_000)
    const gb = await b.c.next('statsDelta', (d) => d.gain?.from === m.id, 5000)
    expect(ga.gain).toMatchObject({ exp: 22 })
    expect(gb.gain).toMatchObject({ exp: 22 })
    expect(x.c.log.some((d) => d.t === 'statsDelta' && d.gain?.from === m.id)).toBe(false)

    // vitals reach the members
    await b.c.next('partyVitals', () => true, 3000).catch(() => undefined)

    // party chat: members only (the sender included), never local
    a.c.send({ t: 'chat', text: 'hello party', channel: 'party' })
    const line = await b.c.next('chat', (l) => l.channel === 'party')
    expect(line).toEqual({ t: 'chat', channel: 'party', fromId: a.id, from: a.name, text: 'hello party' })
    expect(await a.c.next('chat', (l) => l.channel === 'party')).toEqual(line)
    await x.c.none('chat', 250)
    expect(partyLines(x.c)).toEqual([])
    // a party line starting with / is chat, not a command
    b.c.send({ t: 'chat', text: '/kill', channel: 'party' })
    expect((await a.c.next('chat', (l) => l.channel === 'party')).text).toBe('/kill')

    // b disconnects: offline for a; b relogs: the party comes back at the end of the enter sequence
    b.c.close()
    await b.c.closed
    expect(await a.c.next('partyEvent', (e) => e.event === 'offline')).toMatchObject({ name: b.name })
    const off = await a.c.next('party', (p) => p.party?.members[1]?.entity === null)
    expect(off.party!.members[1].characterId).toBe(b.charId)
    const b2 = await inWorld(b.token, b.charId)
    const back = await b2.c.next('party')
    expect(back.party!.members.map((mm) => mm.entity)).toEqual([a.id, b2.id])
    expect(await a.c.next('partyEvent', (e) => e.event === 'online')).toMatchObject({ name: b.name })

    // leave: the party of two is disbanded
    expect(await act(b2.c, { t: 'partyLeave' })).toMatchObject({ ok: true })
    expect(await b2.c.next('party', (p) => p.party === null)).toEqual({ t: 'party', party: null })
    expect(await a.c.next('partyEvent', (e) => e.event === 'disbanded')).toMatchObject({ event: 'disbanded' })
    expect(await a.c.next('party', (p) => p.party === null)).toEqual({ t: 'party', party: null })
    expect(s.ctx.gameplay.party.parties.size).toBe(0)

    for (const p of [a, b2, x]) p.c.close()
    await sleep(30)
  }, 30_000)

  it('abuse: non-leader kick -> not_leader; extra keys are rejected by the validator', async () => {
    const a = await inWorld()
    const b = await inWorld()
    const c = await inWorld()
    await a.c.next('spawn', (m) => m.entity.id === c.id).catch(() => undefined)
    expect(await act(a.c, { t: 'partyInvite', target: b.id })).toMatchObject({ ok: true })
    await b.c.next('partyInvited')
    expect(await act(b.c, { t: 'partyRespond', inviter: a.id, accept: true })).toMatchObject({ ok: true })
    expect(await act(b.c, { t: 'partyKick', member: a.charId })).toMatchObject({ ok: false, reason: 'not_leader' })
    b.c.send({ t: 'partyLeave', extra: 1 })
    expect(await b.c.next('error')).toMatchObject({ code: 'bad_request' })
    expect(s.ctx.gameplay.party.partyOf(b.charId)).toBeDefined()
    for (const p of [a, b, c]) p.c.close()
    await sleep(30)
  })
})
