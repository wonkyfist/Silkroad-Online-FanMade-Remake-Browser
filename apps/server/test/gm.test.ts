import { CLOSE_CODE, type Role } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/gm.ts'
import { parseSlash } from '../src/gm.ts'
import type { AuditRow } from '../src/db.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const SPAWN: [number, number, number] = [100, 2, -50]
const SPEED = 20
const LEVEL_CAP = 20

let s: TestServer

beforeAll(async () => {
  s = await startTestServer({
    config: { moveSpeed: SPEED, tickHz: 20, levelCap: LEVEL_CAP },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({
        name: 'jangan',
        spawn: SPAWN,
        space: { originRegion: { x: 168, z: 97 } },
        bounds: { min: [0, 0, -192], max: [192, 0, 0] },
        places: { 'West Gate': [10, 0, -20], broken: 'nope' },
      }),
    },
  })
})

afterAll(async () => {
  await s.stopAndClean()
})

let nameCounter = 0

/** Fresh account (with `role`) + character, entered into the world. */
async function player(role: Role = 'player', prefix = role === 'player' ? 'pl' : role) {
  const acc = await newAccount(s.url, prefix)
  if (role !== 'player') s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, role)
  const c = await Client.login(s.url, acc.token)
  const name = `${role === 'player' ? 'Hero' : 'Keeper'}${++nameCounter}`
  c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ch = (await c.next('charCreated')).character
  c.send({ t: 'enterWorld', id: ch.id })
  const enter = await c.next('worldEnter')
  return { c, ch, acc, enter, id: enter.self.id, name }
}

async function gm(c: Client, cmd: string, ...args: string[]) {
  c.send({ t: 'gm', cmd, args })
  return c.next('gmResult')
}

function lastAudit(): AuditRow {
  return s.ctx.store.recentAudit(1)[0]
}

async function leaveAll(...cs: Client[]) {
  for (const c of cs) {
    if (c.isClosed) continue
    c.close()
    await c.closed
  }
  await sleep(20)
}

describe('roles', () => {
  it('welcome and worldEnter carry the role', async () => {
    const p = await player()
    expect(p.enter.role).toBe('player')
    const g = await player('gm')
    expect(g.enter.role).toBe('gm')
    const acc = await newAccount(s.url, 'adm')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'admin')
    const a = await Client.connect(s.url)
    a.send({ t: 'hello', version: 1, token: acc.token })
    expect((await a.next('welcome')).role).toBe('admin')
    await leaveAll(p.c, g.c, a)
  })
})

describe('authorization', () => {
  it('rejects players (gm message and slash chat) and audits the denial', async () => {
    const p = await player()
    const watcher = await player()
    p.c.send({ t: 'gm', cmd: 'who', args: [] })
    const e = await p.c.next('error')
    expect(e).toMatchObject({ code: 'forbidden', re: 'gm' })
    expect(lastAudit()).toMatchObject({ username: p.acc.username, command: 'who', args: '[]', ok: 0, result: 'denied: not a Game Master', character_id: p.ch.id })

    p.c.send({ t: 'chat', text: '/tp 1 2' })
    expect(await p.c.next('error')).toMatchObject({ code: 'forbidden', re: 'chat' })
    expect(lastAudit()).toMatchObject({ command: 'tp', args: '["1","2"]', ok: 0 })
    await watcher.c.none('chat')
    await p.c.none('chat', 0)
    await leaveAll(p.c, watcher.c)
  })

  it('answers unknown commands helpfully and audits them', async () => {
    const g = await player('gm')
    const r = await gm(g.c, 'fly', 'high')
    expect(r).toMatchObject({ ok: false, cmd: 'fly' })
    expect(r.message).toMatch(/Unknown command "fly".*help/)
    expect(lastAudit()).toMatchObject({ command: 'fly', args: '["high"]', ok: 0 })
    const h = await gm(g.c, 'help')
    expect(h.ok).toBe(true)
    const names = (h.data as { commands: { name: string }[] }).commands.map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['help', 'who', 'where', 'tp', 'summon', 'kick', 'notice', 'setlevel', 'speed', 'invis', 'heal', 'spawn', 'item', 'kill']))
    expect(h.message).toContain('tp <x> <z>')
    await leaveAll(g.c)
  })

  it('gameplay commands refuse bad arguments (no content loaded here)', async () => {
    const g = await player('gm')
    expect(await gm(g.c, 'heal')).toMatchObject({ ok: true, data: { id: g.id } })
    expect((await gm(g.c, 'spawn', 'x')).message).toBe('No monster X.')
    expect((await gm(g.c, 'item', 'x')).message).toBe('No item X.')
    expect((await gm(g.c, 'kill')).ok).toBe(false)
    expect((await gm(g.c, 'kill', '99999')).message).toBe('No monster or player with id 99999.')
    for (const bad of [['spawn'], ['spawn', 'MOB_X', '0'], ['spawn', 'MOB_X', '51'], ['item', 'bad code!'], ['item', 'ITEM_X', '1.5']]) {
      expect((await gm(g.c, bad[0], ...bad.slice(1))).message, bad.join(' ')).toMatch(/^Usage/)
    }
    await leaveAll(g.c)
  })

  it('world commands need a character in the world; lobby commands work', async () => {
    const acc = await newAccount(s.url, 'lobbygm')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    expect(await gm(c, 'tp', '1', '2')).toMatchObject({ ok: false, message: 'tp needs your character in the world.' })
    expect((await gm(c, 'who')).ok).toBe(true)
    expect(lastAudit()).toMatchObject({ command: 'who', ok: 1, character_id: null })
    await leaveAll(c)
  })
})

describe('commands', () => {
  it('who and where report position and region', async () => {
    const g = await player('gm')
    const p = await player()
    const who = await gm(g.c, 'who')
    const players = (who.data as { players: { name: string; region: number; regionXZ: number[]; role: string; pos: number[] }[] }).players
    const me = players.find((x) => x.name === g.name)!
    expect(me).toMatchObject({ role: 'gm', region: (97 << 8) | 168, regionXZ: [168, 97] })
    expect(players.map((x) => x.name)).toContain(p.name)
    expect(who.message).toContain(p.name)
    expect(who.message).toMatch(/region 168x97 \(25000\)/)

    const where = await gm(g.c, 'where', p.name.toLowerCase())
    expect(where.data).toMatchObject({ name: p.name, pos: SPAWN, account: p.acc.username })
    expect((await gm(g.c, 'where')).data).toMatchObject({ name: g.name })
    expect((await gm(g.c, 'where', 'Nobody')).ok).toBe(false)
    await leaveAll(g.c, p.c)
  })

  it('tp to coordinates broadcasts warp and clamps to the world bounds', async () => {
    const g = await player('gm')
    const w = await player()
    await w.c.next('spawn', (m) => m.entity.id === g.id).catch(() => undefined)
    // start a move first: the warp must cancel it
    g.c.send({ t: 'moveTo', x: 150, z: -150 })
    await w.c.next('move', (m) => m.id === g.id)
    const r = await gm(g.c, 'tp', '120', '-60.5')
    expect(r).toMatchObject({ ok: true, data: { pos: [120, SPAWN[1], -60.5] } })
    expect(await w.c.next('warp', (m) => m.id === g.id)).toMatchObject({ pos: [120, SPAWN[1], -60.5] })
    expect(await g.c.next('warp', (m) => m.id === g.id)).toMatchObject({ pos: [120, SPAWN[1], -60.5] })
    await w.c.none('stop', 100)
    expect(s.ctx.world.players.get(g.id)!.move).toBeNull()

    const far = await gm(g.c, 'tp', '9999', '-9999')
    expect(far.data).toMatchObject({ pos: [192, SPAWN[1], -192] })
    expect(far.message).toContain('clamped')
    expect(lastAudit()).toMatchObject({ command: 'tp', args: '["9999","-9999"]', ok: 1 })
    await leaveAll(g.c, w.c)
  })

  it('tp to presets and players; tp alone lists places', async () => {
    const g = await player('gm')
    const p = await player()
    const list = await gm(g.c, 'tp')
    expect((list.data as { presets: { name: string }[] }).presets.map((x) => x.name)).toEqual(['jangan', 'spawn', 'west_gate'])
    expect((await gm(g.c, 'tp', 'west_gate')).data).toMatchObject({ pos: [10, SPAWN[1], -20], place: 'west_gate' })
    expect((await gm(g.c, 'tp', 'Jangan')).data).toMatchObject({ pos: SPAWN, place: 'jangan' })
    await gm(g.c, 'tp', '50', '-150')
    p.c.send({ t: 'moveTo', x: 30, z: -30 })
    await p.c.next('move')
    await sleep(100)
    const r = await gm(g.c, 'tp', `@${p.name}`)
    expect(r.ok).toBe(true)
    const pos = (r.data as { pos: number[] }).pos
    const truth = s.ctx.world.positionAt(s.ctx.world.players.get(p.id)!, Date.now())
    expect(Math.hypot(pos[0] - truth[0], pos[2] - truth[2])).toBeLessThan(5)
    expect((await gm(g.c, 'tp', 'nowhere')).message).toMatch(/No place or online player named nowhere/)
    await leaveAll(g.c, p.c)
  })

  it('summon moves the target next to the GM', async () => {
    const g = await player('gm')
    const p = await player()
    await gm(g.c, 'tp', '40', '-40')
    const r = await gm(g.c, 'summon', p.name)
    expect(r.ok).toBe(true)
    const warp = await p.c.next('warp', (m) => m.id === p.id)
    expect(Math.hypot(warp.pos[0] - 40, warp.pos[2] + 40)).toBeCloseTo(1, 5)
    await g.c.next('warp', (m) => m.id === p.id)
    expect((await p.c.next('chat', (m) => m.channel === 'system')).text).toContain('summoned')
    expect((await gm(g.c, 'summon', g.name)).ok).toBe(false)
    await leaveAll(g.c, p.c)
  })

  it('kick closes the target socket with CLOSE_CODE.kicked; a gm cannot kick an admin', async () => {
    const g = await player('gm')
    const p = await player()
    const w = await player()
    const r = await gm(g.c, 'kick', p.name, 'please', 'behave')
    expect(r).toMatchObject({ ok: true })
    expect((await p.c.next('chat', (m) => m.channel === 'system')).text).toBe('You were disconnected by a Game Master: please behave')
    const closed = await p.c.closed
    expect(closed.code).toBe(CLOSE_CODE.kicked)
    expect(closed.reason).toBe('kicked: please behave')
    await w.c.next('despawn', (m) => m.id === p.id)
    expect(lastAudit()).toMatchObject({ command: 'kick', args: JSON.stringify([p.name, 'please', 'behave']), ok: 1 })

    const a = await player('admin')
    expect(await gm(g.c, 'kick', a.name)).toMatchObject({ ok: false, message: `${a.name} outranks you.` })
    expect(a.c.isClosed).toBe(false)
    // an admin may kick a gm
    expect((await gm(a.c, 'kick', g.name)).ok).toBe(true)
    expect((await g.c.closed).code).toBe(CLOSE_CODE.kicked)
    await leaveAll(a.c, w.c)
  })

  it('notice reaches everyone, including sockets in the lobby', async () => {
    const g = await player('gm')
    const p = await player()
    const lobby = await Client.login(s.url, (await newAccount(s.url, 'lob')).token)
    const r = await gm(g.c, 'notice', 'Server restart in 5 minutes')
    expect(r.ok).toBe(true)
    for (const c of [g.c, p.c, lobby]) expect(await c.next('notice')).toEqual({ t: 'notice', text: 'Server restart in 5 minutes', from: g.name })
    expect((await gm(g.c, 'notice')).ok).toBe(false)
    await leaveAll(g.c, p.c, lobby)
  })

  it('setlevel persists and propagates (online and offline)', async () => {
    const g = await player('gm')
    const p = await player()
    const r = await gm(g.c, 'setlevel', p.name, '12')
    expect(r).toMatchObject({ ok: true, data: { level: 12, online: true } })
    expect(await p.c.next('entityUpdate', (m) => m.id === p.id)).toMatchObject({ t: 'entityUpdate', id: p.id, level: 12 })
    expect(await g.c.next('entityUpdate', (m) => m.id === p.id)).toMatchObject({ level: 12 })
    expect(s.ctx.store.characterByName(p.name)!.level).toBe(12)

    for (const bad of ['0', String(LEVEL_CAP + 1), '2.5', 'ten']) expect((await gm(g.c, 'setlevel', p.name, bad)).ok, bad).toBe(false)

    // offline: leave, set, re-enter
    p.c.send({ t: 'leaveWorld' })
    await p.c.next('worldLeft')
    expect(await gm(g.c, 'setlevel', p.name, String(LEVEL_CAP))).toMatchObject({ ok: true, data: { online: false } })
    p.c.send({ t: 'enterWorld', id: p.ch.id })
    expect((await p.c.next('worldEnter')).self.level).toBe(LEVEL_CAP)
    expect((await gm(g.c, 'setlevel', 'NoSuchHero', '3')).ok).toBe(false)

    // a gm cannot change an admin's character (online or offline); an admin can change a gm's
    const a = await player('admin')
    expect(await gm(g.c, 'setlevel', a.name, '9')).toMatchObject({ ok: false, message: `${a.name} outranks you.` })
    a.c.send({ t: 'leaveWorld' })
    await a.c.next('worldLeft')
    expect(await gm(g.c, 'setlevel', a.name, '9')).toMatchObject({ ok: false, message: `${a.name} outranks you.` })
    expect(s.ctx.store.characterByName(a.name)!.level).toBe(1)
    expect((await gm(a.c, 'setlevel', g.name, '9')).ok).toBe(true)
    await leaveAll(g.c, p.c, a.c)
  })

  it('invis hides the GM from players but not from other GMs, and re-shows', async () => {
    const g = await player('gm')
    const other = await player('gm')
    const p = await player()
    expect(await gm(g.c, 'invis', 'on')).toMatchObject({ ok: true, data: { invisible: true } })
    expect(await p.c.next('despawn', (m) => m.id === g.id)).toEqual({ t: 'despawn', id: g.id })
    expect(await other.c.next('entityUpdate', (m) => m.id === g.id)).toEqual({ t: 'entityUpdate', id: g.id, invisible: true })
    expect(await g.c.next('entityUpdate', (m) => m.id === g.id)).toMatchObject({ invisible: true })

    // moves of an invisible GM reach GMs only
    g.c.send({ t: 'moveTo', x: 60, z: -60 })
    await other.c.next('move', (m) => m.id === g.id)
    await g.c.next('move', (m) => m.id === g.id)
    await p.c.none('move', 150)

    // a player entering now does not get the GM; a GM entering gets it flagged invisible
    const late = await player()
    expect(late.enter.entities.map((e) => e.id)).not.toContain(g.id)
    const lateGm = await player('gm')
    expect(lateGm.enter.entities.find((e) => e.id === g.id)).toMatchObject({ invisible: true })
    const who = await gm(lateGm.c, 'who')
    expect((who.data as { players: { name: string; invisible: boolean }[] }).players.find((x) => x.name === g.name)!.invisible).toBe(true)

    expect((await gm(g.c, 'invis', 'maybe')).ok).toBe(false)
    expect(await gm(g.c, 'invis', 'off')).toMatchObject({ ok: true, data: { invisible: false } })
    const back = await p.c.next('spawn', (m) => m.entity.id === g.id)
    expect(back.entity.invisible).toBeUndefined()
    await late.c.next('spawn', (m) => m.entity.id === g.id)
    expect(await other.c.next('entityUpdate', (m) => m.id === g.id)).toMatchObject({ invisible: false })

    // leaving while invisible despawns only for those who could see it
    await gm(g.c, 'invis', 'on')
    await p.c.next('despawn', (m) => m.id === g.id)
    g.c.send({ t: 'leaveWorld' })
    await other.c.next('despawn', (m) => m.id === g.id)
    await p.c.none('despawn', 100)
    await leaveAll(g.c, other.c, p.c, late.c, lateGm.c)
  })

  it('speed changes move timing', async () => {
    const g = await player('gm')
    const p = await player()
    expect(await gm(g.c, 'speed', '2')).toMatchObject({ ok: true, data: { speed: 2 } })
    await gm(g.c, 'tp', '100', '-50')
    g.c.send({ t: 'moveTo', x: 100, z: -90 })
    const m = await p.c.next('move', (x) => x.id === g.id)
    expect(m.move.speed).toBe(SPEED * 2)
    // 40 m at 40 m/s: arrives after about 1 s (normal speed would need 2 s)
    const t0 = Date.now()
    await p.c.next('stop', (x) => x.id === g.id, 1800)
    expect(Date.now() - t0).toBeLessThan(1500)

    // changing speed mid-move re-issues the move from the current position
    g.c.send({ t: 'moveTo', x: 100, z: -10 })
    await p.c.next('move', (x) => x.id === g.id && x.move.speed === SPEED * 2)
    await gm(g.c, 'speed', '0.5')
    expect((await p.c.next('move', (x) => x.id === g.id)).move.speed).toBe(SPEED * 0.5)

    for (const bad of ['0.4', '5.1', 'fast']) expect((await gm(g.c, 'speed', bad)).ok, bad).toBe(false)
    // player moves are unaffected
    p.c.send({ t: 'moveTo', x: 10, z: -10 })
    expect((await g.c.next('move', (x) => x.id === p.id)).move.speed).toBe(SPEED)
    await leaveAll(g.c, p.c)
  })
})

describe('slash commands in chat', () => {
  it('runs GM commands typed in chat and never broadcasts them', async () => {
    const g = await player('gm')
    const p = await player()
    g.c.send({ t: 'chat', text: '/notice hello   everyone' })
    expect(await g.c.next('gmResult')).toMatchObject({ ok: true, cmd: 'notice' })
    expect((await p.c.next('notice')).text).toBe('hello everyone')
    g.c.send({ t: 'chat', text: '/TP 100 -100' })
    expect(await g.c.next('gmResult')).toMatchObject({ ok: true, cmd: 'tp', data: { pos: [100, SPAWN[1], -100] } })
    await p.c.next('warp', (m) => m.id === g.id)
    g.c.send({ t: 'chat', text: '/' })
    expect(await g.c.next('gmResult')).toMatchObject({ ok: false })
    await p.c.none('chat', 100)
    await g.c.none('chat', 0)
    // ordinary chat still works
    g.c.send({ t: 'chat', text: 'hi' })
    expect((await p.c.next('chat')).text).toBe('hi')
    await leaveAll(g.c, p.c)
  })

  it('parseSlash keeps at most 8 args (the last one takes the rest)', () => {
    expect(parseSlash('/tp 1 2')).toEqual({ cmd: 'tp', args: ['1', '2'] })
    expect(parseSlash('/Notice  a b c d e f g h i j')).toEqual({ cmd: 'notice', args: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h i j'] })
    expect(parseSlash('/')).toEqual({ cmd: '', args: [] })
  })
})

describe('role changes while connected', () => {
  it('pnpm gm grant/revoke apply to a connected account within the poll interval', async () => {
    const p = await player()
    const w = await player()
    const quiet = () => undefined
    expect(runCli(['grant', p.acc.username], { DATA_DIR: s.ctx.config.dataDir }, quiet, quiet)).toBe(0)
    expect(await p.c.next('role')).toEqual({ t: 'role', role: 'gm' })
    expect((await gm(p.c, 'invis', 'on')).ok).toBe(true)
    await w.c.next('despawn', (m) => m.id === p.id)
    await gm(p.c, 'speed', '3')

    expect(runCli(['revoke', p.acc.username], { DATA_DIR: s.ctx.config.dataDir }, quiet, quiet)).toBe(0)
    expect(await p.c.next('role')).toEqual({ t: 'role', role: 'player' })
    // demoted: visible again, normal speed
    expect((await w.c.next('spawn', (m) => m.entity.id === p.id)).entity.invisible).toBeUndefined()
    const live = s.ctx.world.players.get(p.id)!
    expect(live.speedMul).toBe(1)
    expect(live.staff).toBe(false)
    p.c.send({ t: 'gm', cmd: 'who', args: [] })
    expect((await p.c.next('error')).code).toBe('forbidden')
    await leaveAll(p.c, w.c)
  })

  it('a revoke takes effect on the next command even before the poll', async () => {
    const g = await player('gm')
    s.ctx.store.setRole(s.ctx.store.accountByName(g.acc.username)!.id, 'player')
    g.c.send({ t: 'gm', cmd: 'who', args: [] })
    expect((await g.c.next('error')).code).toBe('forbidden')
    await leaveAll(g.c)
  })
})
