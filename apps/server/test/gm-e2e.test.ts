/**
 * GM end to end: the real server (temp DATA_DIR and world manifest) driven by two headless clients
 * built from the game's own modules (apps/game/src/net: HttpApi, Session, webSocketWire; the GM
 * window's message builders in apps/game/src/gm/commands.ts). The GM role is granted and revoked
 * through the `pnpm gm` CLI code path (runCli) while both clients are connected. Every frame the
 * clients send is checked with the server's strict parseClientMessage; every frame they receive
 * passes parseServerMessage inside webSocketWire (an invalid one would be dropped and the test
 * would time out).
 */
import { CLOSE_CODE, parseClientMessage, type ClientMessage, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gm, type GmBuild } from '../../game/src/gm/commands.ts'
import { HttpApi } from '../../game/src/net/api.ts'
import { Session, type StatusEvent } from '../../game/src/net/session.ts'
import { webSocketWire, type Wire } from '../../game/src/net/wire.ts'
import { runCli } from '../src/cli/gm.ts'
import type { AuditRow } from '../src/db.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const SPAWN: [number, number, number] = [100, 2, -50]
const BOUNDS = { min: [0, 0, -192], max: [192, 0, 0] }
const MODEL = 'CHAR_CH_MAN_ADVENTURER'

type Msg<K extends ServerMessage['t']> = Extract<ServerMessage, { t: K }>

const sent: ClientMessage[] = []
const refused: { msg: unknown; error: string }[] = []

function checkedWire(url: string): Wire {
  const wire = webSocketWire(url)
  const send = wire.send.bind(wire)
  wire.send = (msg) => {
    const parsed = parseClientMessage(JSON.stringify(msg))
    if (parsed.ok) sent.push(msg)
    else refused.push({ msg, error: parsed.error })
    send(msg)
  }
  return wire
}

/** Every message a session receives, in order (for "never received" checks). */
function record(s: Session): ServerMessage[] {
  const log: ServerMessage[] = []
  s.on((m) => log.push(m))
  return log
}

function expectMsg<K extends ServerMessage['t']>(s: Session, t: K, where: (m: Msg<K>) => boolean = () => true, timeoutMs = 4000): Promise<Msg<K>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timed out waiting for ${t}`))
    }, timeoutMs)
    const off = s.on((m) => {
      if (m.t === t && where(m as Msg<K>)) {
        clearTimeout(timer)
        off()
        resolve(m as Msg<K>)
      }
    })
  })
}

function expectStatus(s: Session, where: (ev: StatusEvent) => boolean, timeoutMs = 4000): Promise<StatusEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error('timed out waiting for a status change'))
    }, timeoutMs)
    const off = s.onStatus((ev) => {
      if (where(ev)) {
        clearTimeout(timer)
        off()
        resolve(ev)
      }
    })
  })
}

/** Sends a GM window build and resolves with its gmResult (rejects on `error`). */
async function run(s: Session, build: GmBuild): Promise<Msg<'gmResult'>> {
  if (!build.ok) throw new Error(`the GM window refused to build: ${build.error}`)
  await sleep(120) // a person at the GM window, not a script: stays inside the server's command budget
  return s.request(build.msg, ['gmResult'])
}

const near = (a: readonly number[], b: readonly number[], eps = 0.05) => Math.hypot(a[0] - b[0], a[2] - b[2]) < eps

describe('GM end to end with the game client modules', () => {
  let s: TestServer
  let api: HttpApi
  let wsUrl: string
  let cliEnv: NodeJS.ProcessEnv
  const sessions: Session[] = []
  const cli = (...argv: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = runCli(argv, cliEnv, (l) => out.push(l), (l) => err.push(l))
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const open = (token: string) => {
    const session = new Session(() => checkedWire(wsUrl), token)
    sessions.push(session)
    return session
  }
  const audits = (accountId: number): AuditRow[] => s.ctx.store.recentAudit(1000).filter((r) => r.account_id === accountId).reverse()

  beforeAll(async () => {
    s = await startTestServer({
      // GM features, not interest management: everyone stays in view across the whole test world.
      config: { moveSpeed: 20, tickHz: 20, levelCap: 20, rolePollMs: 50, viewRange: 1000 },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, space: { originRegion: { x: 168, z: 97 } }, bounds: BOUNDS }),
      },
    })
    api = new HttpApi(`${s.url}/api`)
    wsUrl = `${s.url.replace(/^http/, 'ws')}/ws`
    cliEnv = { DATA_DIR: s.ctx.config.dataDir }
  })

  afterAll(async () => {
    for (const x of sessions) x.close()
    await s?.stopAndClean()
  })

  it('grant, teleport, summon, notice, setlevel, invisibility, kick, revoke', async () => {
    const suffix = Date.now().toString(36).slice(-5)
    const gmUser = `keeper_${suffix}`
    const plUser = `guest_${suffix}`
    const gmToken = (await api.register({ username: gmUser, password: 'secret-G1' })).token
    const plToken = (await api.register({ username: plUser, password: 'secret-P1' })).token
    const g = open(gmToken)
    const p = open(plToken)
    const gLog = record(g)
    const pLog = record(p)
    expect((await g.connect()).role).toBe('player')
    expect((await p.connect()).role).toBe('player')
    const gmAccount = s.ctx.store.accountByName(gmUser)!.id
    const plAccount = s.ctx.store.accountByName(plUser)!.id

    const gName = `Keeper${suffix}`
    const pName = `Guest${suffix}`
    const gChar = (await g.request({ t: 'charCreate', name: gName, model: MODEL, weapon: 'blade' }, ['charCreated'])).character
    const pChar = (await p.request({ t: 'charCreate', name: pName, model: MODEL, weapon: 'spear' }, ['charCreated'])).character
    const gEnter = await g.request({ t: 'enterWorld', id: gChar.id }, ['worldEnter'])
    const pEnter = await p.request({ t: 'enterWorld', id: pChar.id }, ['worldEnter'])
    expect(gEnter.role).toBe('player')
    const gId = gEnter.self.id
    const pId = pEnter.self.id

    // ---- before the grant: the GM window's frames and slash chat are refused and audited ------------
    await expect(run(g, gm.who())).rejects.toMatchObject({ code: 'forbidden' })
    const slashRefused = expectMsg(g, 'error', (m) => m.re === 'chat')
    g.send({ t: 'chat', text: '/notice free gold at the gate' })
    expect(await slashRefused).toMatchObject({ code: 'forbidden', message: 'Unknown command. Slash commands are for Game Masters.' })
    expect(audits(gmAccount).map((r) => [r.command, r.ok, r.result])).toEqual([
      ['who', 0, 'denied: not a Game Master'],
      ['notice', 0, 'denied: not a Game Master'],
    ])

    // ---- pnpm gm grant: the connected client learns its new role within the role poll ---------------
    const roleMsg = expectMsg(g, 'role')
    expect(cli('grant', gmUser)).toMatchObject({ code: 0 })
    expect(await roleMsg).toEqual({ t: 'role', role: 'gm' })
    expect(g.role).toBe('gm')
    expect(cli('list').out).toContain(gmUser)

    // ---- who ------------------------------------------------------------------------------------------
    const who = await run(g, gm.who())
    expect(who.ok).toBe(true)
    expect((who.data as { players: { name: string; role: string }[] }).players.map((x) => [x.name, x.role]).sort()).toEqual(
      [[gName, 'gm'], [pName, 'player']].sort(),
    )

    // ---- tp to coordinates (the Teleport tab's X/Z fields): both clients get the warp ---------------
    const warpSeenByP = expectMsg(p, 'warp', (m) => m.id === gId)
    const warpSelf = expectMsg(g, 'warp', (m) => m.id === gId)
    const tp = await run(g, gm.tpFields('40', '-60'))
    expect(tp).toMatchObject({ ok: true, cmd: 'tp' })
    expect(near((await warpSeenByP).pos, [40, 0, -60])).toBe(true)
    expect(near((await warpSelf).pos, [40, 0, -60])).toBe(true)
    // outside the world bounds: clamped, never NaN
    const clampWarp = expectMsg(p, 'warp', (m) => m.id === gId)
    expect((await run(g, gm.tpTo(999_999, -999_999))).message).toContain('clamped')
    const clamped = (await clampWarp).pos
    expect(clamped.every(Number.isFinite)).toBe(true)
    expect([clamped[0], clamped[2]]).toEqual([192, -192])
    // the raw server accepts no NaN/Infinity/huge text either (the builder already refuses them)
    for (const bad of [['NaN', '0'], ['Infinity', '1'], ['1e400', '2'], ['0x', '1']]) {
      const r = await g.request({ t: 'gm', cmd: 'tp', args: bad }, ['gmResult'])
      expect(r.ok, bad.join(' ')).toBe(false)
    }
    expect(s.ctx.world.players.get(gId)!.pos.every(Number.isFinite)).toBe(true)
    // back home by place name (the Jangan button)
    const home = expectMsg(p, 'warp', (m) => m.id === gId)
    await run(g, gm.tpPlace('jangan'))
    expect(near((await home).pos, SPAWN)).toBe(true)

    // ---- summon: the player lands 1 m in front of the GM, told by a system line --------------------
    const pWarp = expectMsg(p, 'warp', (m) => m.id === pId)
    const pWarpSeenByG = expectMsg(g, 'warp', (m) => m.id === pId)
    const summonedLine = expectMsg(p, 'chat', (m) => m.channel === 'system' && m.text === 'You were summoned by a Game Master.')
    expect((await run(g, gm.summon(pName))).ok).toBe(true)
    const landed = (await pWarp).pos
    expect(Math.hypot(landed[0] - SPAWN[0], landed[2] - SPAWN[2])).toBeCloseTo(1, 3)
    expect((await pWarpSeenByG).pos).toEqual(landed)
    await summonedLine
    // the summoned player walks on from there (the server's position, not the client's)
    const walk = expectMsg(p, 'move', (m) => m.id === pId)
    p.send({ t: 'moveTo', x: landed[0] + 3, z: landed[2] })
    expect(near((await walk).move.from, landed)).toBe(true)

    // ---- notice: sanitized (control and bidi characters dropped) and shown to everyone --------------
    const noticeText = 'Server restart in 5 minutes. ‮Please log out safely.'
    const nP = expectMsg(p, 'notice')
    const nG = expectMsg(g, 'notice')
    expect((await run(g, gm.notice(noticeText))).message).toBe('Notice sent to 2 connections.')
    const shown = await nP
    expect(shown).toEqual({ t: 'notice', text: 'Server restart in 5 minutes. Please log out safely.', from: gName })
    expect(await nG).toEqual(shown)
    // too long for a notice: the window refuses, and the raw server refuses 301 characters too
    expect(gm.notice('x'.repeat(301)).ok).toBe(false)
    const long = await g.request({ t: 'gm', cmd: 'notice', args: ['x'.repeat(100), 'y'.repeat(100), 'z'.repeat(100)] }, ['gmResult'])
    expect(long).toMatchObject({ ok: false, message: 'A notice is at most 300 characters.' })

    // ---- setlevel: both clients get entityUpdate; saved in the database -----------------------------
    const lvP = expectMsg(p, 'entityUpdate', (m) => m.id === pId)
    const lvG = expectMsg(g, 'entityUpdate', (m) => m.id === pId)
    expect((await run(g, gm.setLevel(pName, 7))).ok).toBe(true)
    expect(await lvP).toMatchObject({ t: 'entityUpdate', id: pId, level: 7 })
    expect(await lvG).toMatchObject({ t: 'entityUpdate', id: pId, level: 7 })
    expect(s.ctx.store.characterByName(pName)!.level).toBe(7)
    expect((await g.request({ t: 'gm', cmd: 'setlevel', args: [pName, '21'] }, ['gmResult'])).ok).toBe(false)

    // ---- invisible: the player gets despawn and no moves; the GM sees itself flagged -----------------
    const gone = expectMsg(p, 'despawn', (m) => m.id === gId)
    const flagged = expectMsg(g, 'entityUpdate', (m) => m.id === gId)
    await run(g, gm.invis(true))
    await gone
    expect(await flagged).toEqual({ t: 'entityUpdate', id: gId, invisible: true })
    const before = pLog.length
    const gMove = expectMsg(g, 'move', (m) => m.id === gId)
    g.send({ t: 'moveTo', x: SPAWN[0] - 5, z: SPAWN[2] })
    await gMove
    await sleep(400)
    expect(pLog.slice(before).filter((m) => 'id' in m && m.id === gId)).toEqual([])
    const back = expectMsg(p, 'spawn', (m) => m.entity.id === gId)
    await run(g, gm.invis(false))
    expect((await back).entity).toMatchObject({ id: gId, name: gName })
    expect((await back).entity.invisible).toBeUndefined()

    // ---- the player cannot use any of it: gm frames and slash lines are refused and audited ---------
    await expect(run(p, gm.summon(gName))).rejects.toMatchObject({ code: 'forbidden' })
    await expect(run(p, gm.kick(gName))).rejects.toMatchObject({ code: 'forbidden' })
    const pSlash = expectMsg(p, 'error', (m) => m.re === 'chat')
    p.send({ t: 'chat', text: '/tp 0 0' })
    expect((await pSlash).code).toBe('forbidden')
    expect(audits(plAccount).map((r) => [r.command, r.ok])).toEqual([
      ['summon', 0],
      ['kick', 0],
      ['tp', 0],
    ])
    // none of the refused slash lines reached anyone's chat
    for (const log of [gLog, pLog]) expect(log.filter((m) => m.t === 'chat' && m.channel === 'local')).toEqual([])

    // ---- kick: the player gets the reason, the session closes for good, the GM sees the despawn -----
    const kickedLine = expectMsg(p, 'chat', (m) => m.channel === 'system')
    const closed = expectStatus(p, (ev) => ev.status === 'closed')
    const despawn = expectMsg(g, 'despawn', (m) => m.id === pId)
    expect(await run(g, gm.kick(pName, 'testing the kick'))).toMatchObject({ ok: true, message: `Kicked ${pName} (testing the kick).` })
    expect((await kickedLine).text).toBe('You were disconnected by a Game Master: testing the kick')
    expect(await closed).toMatchObject({ status: 'closed', reason: 'kicked', message: 'You were disconnected by a Game Master: testing the kick' })
    await despawn
    await sleep(700)
    expect(p.status).toBe('closed')
    expect(s.ctx.sockets.has(plAccount)).toBe(false)
    // the kicked character was saved where the summon put it (plus its walk), not somewhere odd
    const saved = s.ctx.store.characterByName(pName)!
    expect([saved.x, saved.z].every((v) => Number.isFinite(v))).toBe(true)

    // ---- audit: every allowed and denied call is on record ------------------------------------------
    const rows = audits(gmAccount)
    expect(rows.filter((r) => r.ok === 0 && r.result === 'denied: not a Game Master')).toHaveLength(2)
    for (const c of ['who', 'tp', 'summon', 'notice', 'setlevel', 'invis', 'kick']) {
      expect(rows.some((r) => r.command === c && r.ok === 1), c).toBe(true)
    }
    expect(rows.some((r) => r.command === 'cli.grant')).toBe(true)
    const printed = cli('audit', '--limit', '100').out
    expect(printed).toMatch(new RegExp(`${gmUser}\\s+FAIL who`))
    expect(printed).toMatch(new RegExp(`${gmUser}\\s+ok\\s+kick ${pName} testing the kick`))

    // ---- pnpm gm revoke: role message, and the very next command is refused -------------------------
    const revoked = expectMsg(g, 'role')
    expect(cli('revoke', gmUser)).toMatchObject({ code: 0 })
    expect(await revoked).toEqual({ t: 'role', role: 'player' })
    expect(g.role).toBe('player')
    await expect(run(g, gm.who())).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a non-GM spamming raw gm frames is struck off; everyone is rate limited', async () => {
    const acc = await newAccount(s.url, 'spam')
    const c = await Client.login(s.url, acc.token)
    for (let i = 0; i < 25; i++) c.send({ t: 'gm', cmd: 'notice', args: ['free gold'] })
    expect((await c.closed).code).toBe(CLOSE_CODE.abuse)
    const accountId = s.ctx.store.accountByName(acc.username)!.id
    const rows = s.ctx.store.recentAudit(1000).filter((r) => r.account_id === accountId)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(20)
    expect(rows.every((r) => r.ok === 0)).toBe(true)

    // a GM has a command budget too
    const staff = await newAccount(s.url, 'burst')
    s.ctx.store.setRole(s.ctx.store.accountByName(staff.username)!.id, 'gm')
    const g = await Client.login(s.url, staff.token)
    for (let i = 0; i < 24; i++) g.send({ t: 'gm', cmd: 'who', args: [] })
    const limited = await g.next('error', (m) => m.code === 'rate_limited')
    expect(limited.re).toBe('gm')
    g.close()
    // hello first still applies: an unauthenticated gm frame closes the socket
    const raw = await Client.connect(s.url)
    raw.send({ t: 'gm', cmd: 'who', args: [] })
    expect((await raw.closed).code).toBe(CLOSE_CODE.unauthorized)
    // clients cannot send server messages (a self-made warp), nor an upper-case or oversized gm frame
    const other = await newAccount(s.url, 'forge')
    const f = await Client.login(s.url, other.token)
    for (const msg of [
      { t: 'warp', id: 1, pos: [0, 0, 0], yaw: 0 },
      { t: 'gm', cmd: 'TP', args: [] },
      { t: 'gm', cmd: 'tp', args: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
      { t: 'gm', cmd: 'notice', args: ['x'.repeat(101)] },
      { t: 'gm', cmd: 'setlevel', args: ['a', 5] },
      { t: 'gm', cmd: 'who', args: [], role: 'admin' },
    ]) {
      f.send(msg)
      expect((await f.next('error')).code, JSON.stringify(msg).slice(0, 60)).toBe('bad_request')
    }
    const forgeId = s.ctx.store.accountByName(other.username)!.id
    expect(s.ctx.store.recentAudit(1000).filter((r) => r.account_id === forgeId)).toEqual([])
    expect(s.ctx.store.accountRole(forgeId)).toBe('player')
    f.close()
  })

  it('every GM window frame passed the server validator', () => {
    expect(refused).toEqual([])
    expect(sent.some((m) => m.t === 'gm')).toBe(true)
  })
})
