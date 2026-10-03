/**
 * End to end: the real server (temp DATA_DIR, real OUT_DIR) driven by two headless players that
 * use the game client's own network modules (apps/game/src/net: HttpApi, Session, webSocketWire;
 * Node 24's global WebSocket stands in for the browser's) and its content parser
 * (apps/game/src/content/catalog.ts). Every frame the client sends is checked with the server's
 * strict parseClientMessage. Skips when the data export (work/out/data/characters.json) is missing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_CHAT_LENGTH,
  PROTOCOL_VERSION,
  STARTER_WEAPONS,
  parseClientMessage,
  type ClientMessage,
  type EntityState,
  type ServerMessage,
  type StarterWeapon,
} from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCharactersJson, parseWeaponsJson } from '../../game/src/content/catalog.ts'
import { GameError, HttpApi } from '../../game/src/net/api.ts'
import { Session, type StatusEvent } from '../../game/src/net/session.ts'
import { webSocketWire, type Wire } from '../../game/src/net/wire.ts'
import { REPO_ROOT } from '../src/config.ts'
import { extractModels } from '../src/content.ts'
import { startTestServer, type TestServer } from './helpers.ts'

const OUT_DIR = process.env.OUT_DIR || join(REPO_ROOT, 'work/out')
const CHARACTERS = join(OUT_DIR, 'data/characters.json')
const WEAPONS = join(OUT_DIR, 'data/weapons.json')
const haveExport = existsSync(CHARACTERS) && existsSync(WEAPONS)

const SPEED = 40

type Msg<K extends ServerMessage['t']> = Extract<ServerMessage, { t: K }>

/** Every client frame the game sent during the run, and any the server's validator refused. */
const sent: ClientMessage[] = []
const refused: { msg: unknown; error: string }[] = []

/** The game's browser wire, with each outgoing message checked against the server validator. */
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

/** Resolves with the next message of type `t` matching `where` (register before triggering it). */
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

const near = (a: readonly number[], b: readonly number[], eps = 0.05) => Math.hypot(a[0] - b[0], a[2] - b[2]) < eps

describe.skipIf(!haveExport)('end to end with the game client modules', () => {
  let s: TestServer
  let api: HttpApi
  let wsUrl: string
  const sessions: Session[] = []
  const characters = haveExport ? JSON.parse(readFileSync(CHARACTERS, 'utf8')) : []
  const weapons = haveExport ? JSON.parse(readFileSync(WEAPONS, 'utf8')) : []

  const open = (token: string) => {
    const session = new Session(() => checkedWire(wsUrl), token)
    sessions.push(session)
    return session
  }

  beforeAll(async () => {
    s = await startTestServer({
      config: { outDir: OUT_DIR, moveSpeed: SPEED, tickHz: 20 },
      files: { 'dist/index.html': '<!doctype html><title>game</title>' },
    })
    api = new HttpApi(`${s.url}/api`)
    wsUrl = `${s.url.replace(/^http/, 'ws')}/ws`
  })

  afterAll(async () => {
    for (const x of sessions) x.close()
    await s?.stopAndClean()
  })

  it('game and server agree on the playable models and weapons from the data export', () => {
    const game = parseCharactersJson(characters).filter((c) => c.selectable && c.race === 'china').map((c) => c.code)
    const server = s.ctx.models.list()
    expect(s.ctx.models.source).toBe('data/characters.json')
    expect(new Set(game)).toEqual(new Set(server))
    expect(server).toEqual(extractModels(characters))
    expect(server).toHaveLength(26)
    expect(server.every((c) => c.startsWith('CHAR_CH_'))).toBe(true)
    // every selectable model has a converted glb the client can load
    for (const c of parseCharactersJson(characters).filter((x) => x.selectable)) {
      expect(existsSync(join(OUT_DIR, c.glb.replace(/^\/out\//, ''))), c.glb).toBe(true)
    }
    const w = parseWeaponsJson(weapons)
    expect(Object.keys(w).sort()).toEqual([...STARTER_WEAPONS].sort())
    for (const family of STARTER_WEAPONS) expect(existsSync(join(OUT_DIR, w[family]!.glb.replace(/^\/out\//, ''))), family).toBe(true)
  })

  it('serves the export and models to the browser', async () => {
    const res = await fetch(`${s.url}/out/data/characters.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const glb = await fetch(`${s.url}${characters[0].glb}`, { method: 'HEAD' })
    expect(glb.status).toBe(200)
    expect(glb.headers.get('content-type')).toBe('model/gltf-binary')
    if (existsSync(join(OUT_DIR, 'ui/index.json'))) expect((await fetch(`${s.url}/out/ui/index.json`)).status).toBe(200)
  })

  it('plays the whole flow with two players', async () => {
    const suffix = Date.now().toString(36).slice(-5)
    const userA = `alice_${suffix}`
    const userB = `bob_${suffix}`

    // ---- login screen: register (logged in by the reply), then a normal login -----------------
    const regA = await api.register({ username: userA, password: 'secret-A1' })
    expect(regA.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await expect(api.register({ username: userA.toUpperCase(), password: 'secret-A1' })).rejects.toMatchObject({ code: 'name_taken' })
    await expect(api.login({ username: userA, password: 'wrong-pass' })).rejects.toMatchObject({ code: 'unauthorized' })
    const loginA = await api.login({ username: userA, password: 'secret-A1' })
    const regB = await api.register({ username: userB, password: 'secret-B1' })

    // ---- server select ------------------------------------------------------------------------
    const servers = await api.servers()
    expect(servers).toEqual([expect.objectContaining({ id: 'jangan', name: 'Jangan', status: 'online', online: 0 })])

    // ---- hello / welcome ----------------------------------------------------------------------
    const a = open(loginA.token)
    const b = open(regB.token)
    const welcomeA = await a.connect()
    const welcomeB = await b.connect()
    expect(welcomeA).toMatchObject({ account: userA, slots: 4, server: { id: 'jangan' } })
    expect(welcomeB.account).toBe(userB)

    // ---- character select (empty) and creation ------------------------------------------------
    expect((await a.request({ t: 'charList' }, ['charList'])).characters).toEqual([])
    const nameA = `Ryu${suffix}`
    const nameB = `Mei${suffix}`
    expect(await a.request({ t: 'nameCheck', name: nameA }, ['nameCheck'])).toMatchObject({ name: nameA, available: true })
    expect((await a.request({ t: 'nameCheck', name: 'GM_Ryu' }, ['nameCheck'])).available).toBe(false)
    expect((await a.request({ t: 'nameCheck', name: '9lives' }, ['nameCheck'])).available).toBe(false)

    const male = characters.find((c: { gender: string }) => c.gender === 'male').code as string
    const female = characters.find((c: { code: string }) => c.code === 'CHAR_CH_WOMAN_FOX')?.code ?? characters.at(-1).code
    const weaponA = weapons[2].family as StarterWeapon
    const weaponB = weapons[4].family as StarterWeapon

    await expect(a.request({ t: 'charCreate', name: nameA, model: 'CHAR_EU_MAN_NOBLE', weapon: weaponA }, ['charCreated'])).rejects.toMatchObject({ code: 'bad_request' })
    await expect(a.request({ t: 'charCreate', name: nameA, model: 'MOB_CH_TIGER', weapon: weaponA }, ['charCreated'])).rejects.toMatchObject({ code: 'bad_request' })
    const createdA = (await a.request({ t: 'charCreate', name: nameA, model: male, weapon: weaponA }, ['charCreated'])).character
    expect(createdA).toMatchObject({ name: nameA, model: male, weapon: weaponA, level: 1, location: 'Jangan', lastPlayed: 0 })
    const spawn = s.ctx.setup.spawn
    expect(createdA.pos).toEqual([spawn.x, spawn.y, spawn.z])
    await expect(b.request({ t: 'charCreate', name: nameA.toLowerCase(), model: female, weapon: weaponB }, ['charCreated'])).rejects.toMatchObject({ code: 'name_taken' })
    const createdB = (await b.request({ t: 'charCreate', name: nameB, model: female, weapon: weaponB }, ['charCreated'])).character
    expect((await a.request({ t: 'nameCheck', name: nameB.toUpperCase() }, ['nameCheck'])).available).toBe(false)

    // ---- enter the world: each sees the other -------------------------------------------------
    const enterA = await a.request({ t: 'enterWorld', id: createdA.id }, ['worldEnter'])
    expect(enterA.self).toMatchObject({ name: nameA, model: male, weapon: weaponA, kind: 'player' })
    // the real export also places NPCs and monsters around the spawn: only players matter here
    const players = (list: EntityState[]) => list.filter((e) => e.kind === 'player')
    expect(players(enterA.entities)).toEqual([])
    expect(enterA.world).toMatchObject({ name: 'jangan', tickRate: 20 })
    const spawnSeenByA = expectMsg(a, 'spawn', (m) => m.entity.name === nameB)
    const enterB = await b.request({ t: 'enterWorld', id: createdB.id }, ['worldEnter'])
    expect(players(enterB.entities).map((e) => e.name)).toEqual([nameA])
    const bSeenByA = (await spawnSeenByA).entity
    expect(bSeenByA).toMatchObject({ id: enterB.self.id, model: female, weapon: weaponB })
    expect((await api.servers())[0].online).toBe(2)
    await expect(a.request({ t: 'enterWorld', id: createdA.id }, ['worldEnter'])).rejects.toMatchObject({ code: 'already_in_world' })

    // ---- click to move (the client only renders the server's move/stop) -----------------------
    const idA = enterA.self.id
    const [tx, tz] = s.ctx.world.clamp(spawn.x + 12.5, spawn.z - 4.25)
    const moveSeenByB = expectMsg(b, 'move', (m) => m.id === idA)
    const moveSeenByA = expectMsg(a, 'move', (m) => m.id === idA)
    const stopSeenByB = expectMsg(b, 'stop', (m) => m.id === idA)
    a.send({ t: 'moveTo', x: tx, z: tz })
    const [mvA, mvB] = await Promise.all([moveSeenByA, moveSeenByB])
    expect(mvB.move).toEqual(mvA.move)
    expect(mvB.move.speed).toBe(SPEED)
    expect(near(mvB.move.to, [tx, 0, tz])).toBe(true)
    const stop = await stopSeenByB
    expect(near(stop.pos, [tx, 0, tz])).toBe(true)
    expect(stop.yaw).toBeCloseTo(Math.atan2(tx - spawn.x, tz - spawn.z), 6)

    // ---- chat (as the chat box sends it: trimmed, sliced to MAX_CHAT_LENGTH) ---------------------
    const line = 'hello from Jangan '.repeat(10).trim().slice(0, MAX_CHAT_LENGTH)
    const chatSeenByB = expectMsg(b, 'chat', (m) => m.fromId === idA)
    const chatEcho = expectMsg(a, 'chat', (m) => m.fromId === idA)
    a.send({ t: 'chat', text: line })
    expect(await chatSeenByB).toMatchObject({ channel: 'local', from: nameA, text: line })
    expect((await chatEcho).text).toBe(line)

    // ---- leave the world, then re-enter at the saved position -----------------------------------
    const despawnSeenByB = expectMsg(b, 'despawn', (m) => m.id === idA)
    await a.request({ t: 'leaveWorld' }, ['worldLeft'])
    await despawnSeenByB
    const listed = (await a.request({ t: 'charList' }, ['charList'])).characters
    expect(listed).toHaveLength(1)
    expect(near(listed[0].pos, [tx, 0, tz])).toBe(true)
    expect(listed[0].lastPlayed).toBeGreaterThan(0)
    const respawnSeenByB = expectMsg(b, 'spawn', (m) => m.entity.name === nameA)
    const again = await a.request({ t: 'enterWorld', id: createdA.id }, ['worldEnter'])
    expect(near(again.self.pos, [tx, 0, tz])).toBe(true)
    expect(players(again.entities).map((e) => e.name)).toEqual([nameB])
    expect(near((await respawnSeenByB).entity.pos, [tx, 0, tz])).toBe(true)
    await a.request({ t: 'leaveWorld' }, ['worldLeft'])

    // ---- delete from character select ------------------------------------------------------------
    await expect(b.request({ t: 'charDelete', id: createdA.id }, ['charDeleted'])).rejects.toMatchObject({ code: 'already_in_world' })
    expect(await a.request({ t: 'charDelete', id: createdA.id }, ['charDeleted'])).toEqual({ t: 'charDeleted', id: createdA.id })
    expect((await a.request({ t: 'charList' }, ['charList'])).characters).toEqual([])
    expect((await a.request({ t: 'nameCheck', name: nameA }, ['nameCheck'])).available).toBe(true)

    // ---- the same account logging in elsewhere: the old session closes and does not reconnect ----
    const kicked = expectStatus(a, (ev) => ev.status === 'closed')
    const a2 = open(regA.token)
    await a2.connect()
    expect(await kicked).toMatchObject({ status: 'closed', reason: 'replaced' })
    await new Promise((r) => setTimeout(r, 700))
    expect(a.status).toBe('closed')
    expect(a2.status).toBe('online')

    // ---- logout revokes the token and ends its socket --------------------------------------------
    const loggedOut = expectStatus(a2, (ev) => ev.status === 'closed')
    await api.logout(regA.token)
    expect((await loggedOut).reason).toBe('unauthorized')
    const stale = open(regA.token)
    await expect(stale.connect()).rejects.toBeInstanceOf(GameError)

    // ---- B disconnects without leaving: its position is saved -----------------------------------
    b.close()
    await new Promise((r) => setTimeout(r, 100))
    expect((await api.servers())[0].online).toBe(0)
  })

  it('every message the client sent passed the server validator', () => {
    expect(refused).toEqual([])
    const types = new Set(sent.map((m) => m.t))
    for (const t of ['hello', 'ping', 'charList', 'nameCheck', 'charCreate', 'charDelete', 'enterWorld', 'moveTo', 'chat', 'leaveWorld']) {
      expect(types.has(t as ClientMessage['t']), t).toBe(true)
    }
  })
})

describe('client message construction', () => {
  it('each message shape the game screens build passes parseClientMessage', () => {
    // Mirrors the constructors in apps/game/src (session.ts, charselect.ts, charcreate.ts, world.ts, chat.ts).
    const typed = 'x 😀 你好 '.repeat(40).trim()
    const built: Partial<Record<ClientMessage['t'], ClientMessage>> = {
      hello: { t: 'hello', version: PROTOCOL_VERSION, token: 'A'.repeat(43) },
      ping: { t: 'ping', n: 1, clientTime: Date.now() },
      charList: { t: 'charList' },
      nameCheck: { t: 'nameCheck', name: '  Hero_1 '.trim() },
      charCreate: { t: 'charCreate', name: 'Hero_1', model: 'CHAR_CH_WOMAN_NECROMENCERB', weapon: 'glaive', height: 4, volume: 1, outfit: 'light' },
      charDelete: { t: 'charDelete', id: 12 },
      enterWorld: { t: 'enterWorld', id: 12 },
      moveTo: { t: 'moveTo', x: 6123.456789012345, z: -1234.5678901234567 },
      chat: { t: 'chat', text: typed.slice(0, MAX_CHAT_LENGTH) },
      leaveWorld: { t: 'leaveWorld' },
      gm: { t: 'gm', cmd: 'notice', args: [typed.slice(0, 100)] },
    }
    for (const [t, msg] of Object.entries(built)) {
      const r = parseClientMessage(JSON.stringify(msg))
      expect(r, t).toEqual({ ok: true, msg })
    }
  })
})
