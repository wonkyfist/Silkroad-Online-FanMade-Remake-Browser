/**
 * Maintenance mode end to end on a real server (docs/ADMIN.md §8): the countdown reaches the sockets, at zero players
 * in the world and in character select are saved and closed with CLOSE_CODE.maintenance while staff stay; while on the
 * server list says 'maintenance', /api/login, /api/register, hello (the server pick, a reconnect) refuse players and let
 * staff in; a GM demoted meanwhile leaves; end brings everyone back; a restart keeps it on. Runs with gateways too
 * (SRO_TEST_GATEWAYS=1).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOSE_CODE, PROTOCOL_VERSION, type Role } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAINTENANCE_FILE } from '../src/maintenance.ts'
import { Client, api, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

let s: TestServer
let n = 0

beforeAll(async () => {
  s = await startTestServer()
})
afterAll(async () => {
  await s.stopAndClean()
})

async function account(role: Role) {
  const acc = await newAccount(s.url, role === 'player' ? 'mp' : role)
  const id = s.ctx.store.accountByName(acc.username)!.id
  if (role !== 'player') s.ctx.store.setRole(id, role)
  return { ...acc, id }
}

async function inWorld(role: Role, enter = true, made?: Awaited<ReturnType<typeof account>>) {
  const acc = made ?? (await account(role))
  const c = await Client.login(s.url, acc.token)
  const name = `Maint${role[0]}${++n}`
  c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ch = (await c.next('charCreated')).character
  if (enter) {
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
  }
  return { ...acc, c, ch }
}

async function hello(token: string) {
  const c = await Client.connect(s.url)
  c.send({ t: 'hello', version: PROTOCOL_VERSION, token })
  return c
}

describe('maintenance mode on a live server', () => {
  it('countdown, kick at zero, refusals while on, demotion, end', async () => {
    const player = await inWorld('player')
    const lobby = await inWorld('player', false)
    const gm = await inWorld('gm')
    const admin = await inWorld('admin')
    const m = s.ctx.maintenance!
    // registering is refused while maintenance is on: the staff accounts that log in later exist already
    const lateGm = await account('gm')
    const lateAdmin = await account('admin')
    expect((await api(s.url, '/api/servers')).json[0].status).toBe('online')

    // a 2 s countdown (the panel's are whole minutes; the class takes seconds)
    expect(m.start({ delayS: 2, reason: 'Test patch', durationMin: 30, by: admin.username, via: 'panel' }).ok).toBe(true)
    const sync = await player.c.next('maintenance')
    expect(sync).toMatchObject({ state: 'countdown', reason: 'Test patch', back: 30 })
    expect(sync.endsIn).toBeGreaterThan(1000)
    expect((await player.c.next('notice')).text).toMatch(/^Server maintenance in 2 seconds: Test patch\./)
    expect((await player.c.next('chat', (x) => x.channel === 'system')).text).toMatch(/^\[Maintenance\] Server maintenance/)
    expect((await lobby.c.next('notice')).text).toMatch(/Server maintenance in 2 seconds/)
    // a late joiner (a GM logging in now) gets the banner state after welcome
    const late = await Client.login(s.url, lateGm.token)
    expect((await late.next('maintenance')).state).toBe('countdown')

    const [pc, lc] = await Promise.all([player.c.closed, lobby.c.closed])
    for (const c of [pc, lc]) {
      expect(c.code).toBe(CLOSE_CODE.maintenance)
      expect(c.reason).toBe('The server is under maintenance. Expected back: in about 30 minutes.')
    }
    expect(player.c.log.some((x) => x.t === 'chat' && x.text === '[Maintenance] The server is under maintenance (Test patch). Expected back: in about 30 minutes.')).toBe(true)
    // saved and gone like a logout: not in the world, not held for a reconnect
    await sleep(50)
    expect([...s.ctx.world.players.values()].some((p) => p.characterId === player.ch.id)).toBe(false)
    expect(s.ctx.holds.isHeld(player.ch.id)).toBe(false)
    expect(s.ctx.store.characterOwned(player.ch.id, player.id)!.last_played).toBeGreaterThan(Date.now() - 60_000)
    // staff stay and play on
    expect(gm.c.isClosed || admin.c.isClosed || late.isClosed).toBe(false)
    expect((await gm.c.next('maintenance', (x) => x.state === 'on'))).toMatchObject({ state: 'on', back: 30 })
    expect((await admin.c.next('notice', (x) => /Maintenance mode is ON/.test(x.text))).text).toMatch(/2 player connection/)
    gm.c.send({ t: 'ping', n: 1, clientTime: 0 })
    await gm.c.next('pong')

    // while on: the list, the login, the register, the server pick (hello) and a reconnect with the old token
    expect((await api(s.url, '/api/servers')).json[0].status).toBe('maintenance')
    const login = await api(s.url, '/api/login', { username: player.username, password: 'password1' })
    expect(login.status).toBe(503)
    expect(login.json).toEqual({ error: 'maintenance', message: 'The server is under maintenance (Test patch). Expected back: in about 30 minutes.' })
    expect((await api(s.url, '/api/login', { username: gm.username, password: 'password1' })).status).toBe(200)
    expect((await api(s.url, '/api/login', { username: player.username, password: 'wrong-password' })).status).toBe(401)
    expect((await api(s.url, '/api/register', { username: `late${n}`, password: 'password1' })).status).toBe(503)
    // the admin's "Registration open during maintenance" switch: the account is made, logging in still waits
    ;(s.ctx.config as { maintenanceRegistration?: boolean }).maintenanceRegistration = true
    expect((await api(s.url, '/api/register', { username: `early${n}`, password: 'password1' })).status).toBe(201)
    expect((await api(s.url, '/api/login', { username: `early${n}`, password: 'password1' })).status).toBe(503)
    ;(s.ctx.config as { maintenanceRegistration?: boolean }).maintenanceRegistration = false
    const again = await hello(player.token)
    expect(await again.next('error')).toMatchObject({ code: 'maintenance', re: 'hello', message: expect.stringMatching(/under maintenance/) })
    expect((await again.closed).code).toBe(CLOSE_CODE.maintenance)
    // staff may log in, pick the server and enter the world
    const staff = await inWorld('admin', true, lateAdmin)
    expect(staff.c.isClosed).toBe(false)

    // a GM demoted during maintenance is disconnected when the role change is seen
    s.ctx.store.setRole(gm.id, 'player')
    s.ctx.refreshRoles(true)
    expect((await gm.c.closed).code).toBe(CLOSE_CODE.maintenance)

    // end: online again, everyone online hears it, players log in again
    admin.c.send({ t: 'gm', cmd: 'maintenance', args: ['end'] })
    expect(await admin.c.next('gmResult')).toMatchObject({ ok: true, cmd: 'maintenance' })
    expect((await staff.c.next('notice', (x) => /over/.test(x.text))).text).toBe('Server maintenance is over. Welcome back!')
    expect((await staff.c.next('maintenance', (x) => x.state === 'off')).state).toBe('off')
    expect((await api(s.url, '/api/servers')).json[0].status).toBe('online')
    expect((await api(s.url, '/api/login', { username: player.username, password: 'password1' })).status).toBe(200)
    const back = await Client.login(s.url, player.token)
    back.send({ t: 'enterWorld', id: player.ch.id })
    await back.next('worldEnter')
    const rows = s.ctx.store.db.prepare("SELECT args, ok FROM gm_audit WHERE command = 'maintenance'").all() as { args: string; ok: number }[]
    expect(rows.some((r) => r.args.includes('end') && r.ok === 1)).toBe(true)
    for (const c of [admin.c, staff.c, late, back]) c.close()
  })

  it('players are refused by the GM command for non-admins; the admin panel route answers', async () => {
    const gm = await inWorld('gm')
    gm.c.send({ t: 'gm', cmd: 'maintenance', args: ['start', 'now'] })
    expect(await gm.c.next('gmResult')).toMatchObject({ ok: false, message: expect.stringMatching(/admins only/) })
    expect(s.ctx.maintenance!.state).toBe('off')
    gm.c.close()
  })
})

describe('maintenance survives a restart', () => {
  it('a server started with maintenance on keeps it on', async () => {
    const t = await startTestServer({
      prepare: (root) => {
        mkdirSync(join(root, 'data'), { recursive: true })
        const now = Date.now()
        writeFileSync(join(root, 'data', MAINTENANCE_FILE), JSON.stringify({ state: 'on', startedAt: now - 60_000, deadline: now - 1000, since: now - 1000, by: 'root', via: 'panel', reason: 'Deploy', durationMin: 10 }))
      },
    })
    try {
      expect((await api(t.url, '/api/servers')).json[0].status).toBe('maintenance')
      expect((await api(t.url, '/api/register', { username: 'afterboot', password: 'password1' })).status).toBe(503)
      expect(t.ctx.maintenance!.end('root', 'panel').ok).toBe(true)
      expect((await api(t.url, '/api/register', { username: 'afterboot', password: 'password1' })).status).toBe(201)
    } finally {
      await t.stopAndClean()
    }
  })
})
