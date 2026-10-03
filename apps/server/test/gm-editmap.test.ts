/**
 * Wave 12 (docs/WORLD_EDITOR.md §2.2, D5, F12; docs/WAVE_PLAN8.md D10, lane W12-G): `/editmap` prints the local World
 * Editor's tokenless fly-to link on this PC's dev server, and the host-PC sentence on any other server (the live one).
 */
import type { Role } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COMMANDS, EDITMAP_REMOTE, EDITOR_PAGE_URL, editmapReply, editorIsLocal } from '../src/gm.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const SPAWN: [number, number, number] = [100.4, 2, -50.6]
const FILES = {
  'out/world/jangan/manifest.json': JSON.stringify({
    name: 'jangan',
    spawn: SPAWN,
    space: { originRegion: { x: 168, z: 97 } },
    bounds: { min: [0, 0, -192], max: [192, 0, 0] },
  }),
}

const DEV = { host: '127.0.0.1', trustProxy: false, serveStatic: false }
/** The mini PC (deploy/remote/install.sh): NODE_ENV=production, HOST = the Tailscale address, the build served. */
const LIVE = { host: '100.64.0.10', trustProxy: false, serveStatic: true }

describe('editorIsLocal', () => {
  it('only a loopback dev server without a proxy or a served build is the editor PC', () => {
    expect(editorIsLocal(DEV)).toBe(true)
    for (const host of ['localhost', '::1', '[::1]', '127.0.0.2', ' LOCALHOST ']) expect(editorIsLocal({ ...DEV, host }), host).toBe(true)
    expect(editorIsLocal(LIVE)).toBe(false)
    for (const host of ['0.0.0.0', '192.168.1.20', '100.64.0.10', '::', 'example.com', '127.0.0.1.evil', '']) expect(editorIsLocal({ ...DEV, host }), host).toBe(false)
    expect(editorIsLocal({ ...DEV, trustProxy: true })).toBe(false)
    expect(editorIsLocal({ ...DEV, serveStatic: true })).toBe(false)
  })
})

describe('editmapReply', () => {
  it('on the dev server: the fly-to link at the position (whole metres), without a token', () => {
    const r = editmapReply(DEV, [100.4, 2, -50.6])
    expect(r.ok).toBe(true)
    expect(r.message).toBe(`Open the World Editor at your position: ${EDITOR_PAGE_URL}?at=100,-51`)
    expect(r.message).toBe('Open the World Editor at your position: http://127.0.0.1:5185/editor.html?at=100,-51')
    expect(r.message).not.toMatch(/token/i)
    expect(r.data).toEqual({ local: true, url: 'http://127.0.0.1:5185/editor.html?at=100,-51' })
    // From the lobby: the page without a position.
    expect(editmapReply(DEV, null).message).toBe(`Open the World Editor: ${EDITOR_PAGE_URL}`)
  })

  it('on a non-local server: the host-PC sentence, never a link', () => {
    for (const cfg of [LIVE, { ...DEV, serveStatic: true }, { ...DEV, host: '0.0.0.0' }]) {
      for (const pos of [[1, 2, 3], null]) {
        const r = editmapReply(cfg, pos)
        expect(r).toEqual({ ok: true, message: 'The World Editor runs on the host PC.', data: { local: false } })
        expect(r.message).toBe(EDITMAP_REMOTE)
        expect(r.message).not.toContain('http')
      }
    }
  })

  it('is a listed GM command needing no character (works from the lobby)', () => {
    expect(COMMANDS.editmap?.world).toBeUndefined()
    expect(COMMANDS.editmap?.usage).toBe('editmap')
  })
})

describe('/editmap over the wire', () => {
  let local: TestServer
  let live: TestServer
  let n = 0

  beforeAll(async () => {
    local = await startTestServer({ config: { serveStatic: false }, files: FILES })
    // testConfig serves the build (serveStatic: true) like the live server.
    live = await startTestServer({ files: FILES })
  })

  afterAll(async () => {
    await local.stopAndClean()
    await live.stopAndClean()
  })

  async function enter(s: TestServer, role: Role) {
    const acc = await newAccount(s.url, role === 'player' ? 'em' : 'emgm')
    if (role !== 'player') s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role)
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: `Mapper${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    return c
  }

  async function leave(c: Client) {
    c.close()
    await c.closed
    await sleep(20)
  }

  it('a GM on the dev server gets the link at their position; the slash line works in chat', async () => {
    const c = await enter(local, 'gm')
    c.send({ t: 'gm', cmd: 'editmap', args: [] })
    const r = await c.next('gmResult')
    expect(r.ok).toBe(true)
    expect(r.message).toBe('Open the World Editor at your position: http://127.0.0.1:5185/editor.html?at=100,-51')
    c.send({ t: 'chat', text: '/editmap' })
    expect((await c.next('gmResult')).message).toContain('editor.html?at=100,-51')
    await leave(c)
  })

  it('a GM on a non-local server gets the host-PC sentence', async () => {
    const c = await enter(live, 'gm')
    c.send({ t: 'gm', cmd: 'editmap', args: [] })
    const r = await c.next('gmResult')
    expect(r.ok).toBe(true)
    expect(r.message).toBe('The World Editor runs on the host PC.')
    await leave(c)
  })

  it('a player is refused like every GM command', async () => {
    const c = await enter(local, 'player')
    c.send({ t: 'gm', cmd: 'editmap', args: [] })
    const e = await c.next('error')
    expect(e.code).toBe('forbidden')
    await leave(c)
  })
})
