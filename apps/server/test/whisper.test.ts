/**
 * Whisper (docs/UX_GAPS.md §5.1, lane UX-B): the real server on an ephemeral port with three headless clients.
 * A whisper reaches only its recipient (and echoes to the sender), is never run as a GM command, shares the chat
 * budget, and refuses offline names, yourself and invisible GMs seen by non-staff.
 */
import type { Role, ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'

const MANIFEST = { 'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [10, 0, -10] }) }

let s: TestServer
let seq = 0

async function inWorld(role: Role = 'player'): Promise<{ c: Client; name: string; id: number }> {
  const acc = await newAccount(s.url, 'wsp')
  if (role !== 'player') s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role) // test setup = the owner's CLI
  const c = await Client.login(s.url, acc.token)
  const name = `Wh${Date.now() % 1e5}${++seq}`.slice(0, 12)
  c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ch = (await c.next('charCreated')).character
  c.send({ t: 'enterWorld', id: ch.id })
  const enter = await c.next('worldEnter')
  return { c, name, id: enter.self.id }
}

const whispers = (c: Client) => c.log.filter((m): m is Extract<ServerMessage, { t: 'chat' }> => m.t === 'chat' && m.channel === 'whisper')

beforeAll(async () => {
  s = await startTestServer({ files: MANIFEST })
})
afterAll(async () => {
  await s.stopAndClean()
})

describe('whisper', () => {
  it('reaches the recipient and echoes to the sender; a third player gets nothing', async () => {
    const a = await inWorld()
    const b = await inWorld()
    const c = await inWorld()
    a.c.send({ t: 'chat', text: 'hello there', to: b.name.toLowerCase() })
    const got = await b.c.next('chat', (m) => m.channel === 'whisper')
    expect(got).toEqual({ t: 'chat', channel: 'whisper', fromId: a.id, from: a.name, to: b.name, text: 'hello there' })
    const echo = await a.c.next('chat', (m) => m.channel === 'whisper')
    expect(echo).toEqual(got)
    await c.c.none('chat', 250)
    expect(whispers(c.c)).toEqual([])
    // Reply the other way (the client's /r builds the same message).
    b.c.send({ t: 'chat', text: 'yo', to: a.name })
    expect((await a.c.next('chat', (m) => m.channel === 'whisper')).from).toBe(b.name)
    for (const p of [a, b, c]) p.c.close()
  })

  it('refuses an offline name, yourself, and never shows the line publicly', async () => {
    const a = await inWorld()
    const b = await inWorld()
    a.c.send({ t: 'chat', text: 'anyone?', to: 'Nobodyhere' })
    const e = await a.c.next('error')
    expect(e).toMatchObject({ code: 'not_found', re: 'chat', message: 'Nobodyhere is not online.' })
    a.c.send({ t: 'chat', text: 'me', to: a.name })
    expect(await a.c.next('error')).toMatchObject({ code: 'bad_request', re: 'chat' })
    await b.c.none('chat', 250)
    a.c.close()
    b.c.close()
  })

  it('a whisper starting with / is delivered, not run as a GM command', async () => {
    const gm = await inWorld('gm')
    const b = await inWorld()
    gm.c.send({ t: 'chat', text: '/kill', to: b.name })
    expect((await b.c.next('chat', (m) => m.channel === 'whisper')).text).toBe('/kill')
    await gm.c.none('gmResult', 200)
    expect(gm.c.log.some((m) => m.t === 'gmResult')).toBe(false)
    gm.c.close()
    b.c.close()
  })

  it('shares the chat budget (burst 5) with local chat', async () => {
    const a = await inWorld()
    const b = await inWorld()
    for (let i = 0; i < 3; i++) a.c.send({ t: 'chat', text: `local ${i}` })
    for (let i = 0; i < 4; i++) a.c.send({ t: 'chat', text: `w ${i}`, to: b.name })
    const limited = await a.c.next('error', (m) => m.code === 'rate_limited')
    expect(limited.re).toBe('chat')
    await b.c.none('error', 100)
    expect(whispers(b.c).length).toBeLessThan(4)
    a.c.close()
    b.c.close()
  })

  it('an invisible GM is "not online" to players, but reachable by staff', async () => {
    const gm = await inWorld('gm')
    const other = await inWorld('admin')
    const p = await inWorld()
    gm.c.send({ t: 'chat', text: '/invis on' })
    await gm.c.next('gmResult')
    p.c.send({ t: 'chat', text: 'psst', to: gm.name })
    expect(await p.c.next('error')).toMatchObject({ code: 'not_found', re: 'chat' })
    other.c.send({ t: 'chat', text: 'psst', to: gm.name })
    expect((await gm.c.next('chat', (m) => m.channel === 'whisper')).from).toBe(other.name)
    // The invisible GM can still whisper players.
    gm.c.send({ t: 'chat', text: 'hi', to: p.name })
    expect((await p.c.next('chat', (m) => m.channel === 'whisper')).from).toBe(gm.name)
    for (const x of [gm, other, p]) x.c.close()
  })

  it('the party channel answers bad_request until wave 4', async () => {
    const a = await inWorld()
    a.c.send({ t: 'chat', text: 'party?', channel: 'party' })
    expect(await a.c.next('error')).toMatchObject({ code: 'bad_request', re: 'chat', message: 'You are not in a party.' })
    a.c.close()
  })
})
