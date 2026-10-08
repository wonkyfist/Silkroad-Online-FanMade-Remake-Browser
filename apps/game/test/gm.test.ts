import { describe, expect, it } from 'vitest'
import { parseClientMessage, parseServerMessage, type ClientMessage, type ServerMessage } from '@sro/shared'
import { commandText } from '../src/gm/window.ts'
import {
  fmtCoord,
  gm,
  gmMessage,
  groupPlaces,
  isGmWindowCommand,
  parseCoord,
  playerName,
  readPlayerInfo,
  readPlayers,
  readPresets,
  readSelfFlags,
  splitWords,
  type GmBuild,
} from '../src/gm/commands.ts'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { kickMessage, Session, type StatusEvent } from '../src/net/session.ts'
import type { Wire } from '../src/net/wire.ts'

function memory(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

/** The build must succeed and survive the server's own frame parser unchanged. */
function valid(build: GmBuild): Extract<ClientMessage, { t: 'gm' }> {
  if (!build.ok) throw new Error(`expected a message, got error: ${build.error}`)
  const parsed = parseClientMessage(JSON.stringify(build.msg))
  if (!parsed.ok) throw new Error(`${JSON.stringify(build.msg)} rejected: ${parsed.error}`)
  expect(parsed.msg).toEqual(build.msg)
  return build.msg
}

function invalid(build: GmBuild): string {
  if (build.ok) throw new Error(`expected an error, got ${JSON.stringify(build.msg)}`)
  expect(build.error.trim()).not.toBe('')
  return build.error
}

describe('GM command construction (every message passes parseClientMessage)', () => {
  it('builds the window and chat commands', () => {
    expect(valid(gm.help())).toEqual({ t: 'gm', cmd: 'help', args: [] })
    expect(valid(gm.who())).toEqual({ t: 'gm', cmd: 'who', args: [] })
    expect(valid(gm.where())).toEqual({ t: 'gm', cmd: 'where', args: [] })
    expect(valid(gm.where('@Bob_1')).args).toEqual(['Bob_1'])
    expect(valid(gm.places())).toEqual({ t: 'gm', cmd: 'tp', args: [] })
    expect(valid(gm.tpTo(12.345, -99.99)).args).toEqual(['12.3', '-100.0'])
    expect(valid(gm.tpTo(-0.01, 1_000_000)).args).toEqual(['0.0', '1000000.0'])
    expect(valid(gm.tpFields(' 12 ', '-3.5')).args).toEqual(['12.0', '-3.5'])
    expect(valid(gm.tpFields('.5', '+7')).args).toEqual(['0.5', '7.0'])
    expect(valid(gm.tpPlace('Jangan')).args).toEqual(['jangan'])
    expect(valid(gm.tpPlace('west_gate')).args).toEqual(['west_gate'])
    expect(valid(gm.tpPlayer('Xiao_Lin')).args).toEqual(['@Xiao_Lin'])
    expect(valid(gm.tpPlayer('@Xiao_Lin')).args).toEqual(['@Xiao_Lin'])
    expect(valid(gm.summon('WeiChen'))).toEqual({ t: 'gm', cmd: 'summon', args: ['WeiChen'] })
    expect(valid(gm.kick('MeiHua')).args).toEqual(['MeiHua'])
    expect(valid(gm.kick('MeiHua', '  spamming   the\tchat ')).args).toEqual(['MeiHua', 'spamming the chat'])
    expect(valid(gm.kick('MeiHua', 'r'.repeat(100))).args[1]).toHaveLength(100)
    expect(valid(gm.setLevel('Hero', 20)).args).toEqual(['Hero', '20'])
    expect(valid(gm.setLevel('Hero', 1)).args).toEqual(['Hero', '1'])
    expect(valid(gm.setLevel('Hero', 30, 30)).args).toEqual(['Hero', '30'])
    expect(valid(gm.speed(0.5)).args).toEqual(['0.5'])
    expect(valid(gm.speed(5)).args).toEqual(['5'])
    expect(valid(gm.speed(2.25)).args).toEqual(['2.25'])
    expect(valid(gm.invis(true)).args).toEqual(['on'])
    expect(valid(gm.invis(false)).args).toEqual(['off'])
  })

  it('splits notices into args the server joins back unchanged', () => {
    const short = valid(gm.notice('  Server restart in   5 minutes!  '))
    expect(short.args.join(' ')).toBe('Server restart in 5 minutes!')

    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ').slice(0, 300).trim()
    const long = valid(gm.notice(words))
    expect(long.args.length).toBeGreaterThan(1)
    expect(long.args.join(' ')).toBe(words)
    for (const a of long.args) expect([...a].length).toBeLessThanOrEqual(100)

    // Unbroken text is cut into 100-code-point pieces (the server inserts a space at each cut).
    const blob = valid(gm.notice('x'.repeat(300)))
    expect(blob.args).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(100)])

    // 300 three-byte characters still fit in one frame.
    const cjk = valid(gm.notice('長'.repeat(300)))
    expect(cjk.args.join('')).toBe('長'.repeat(300))

    // 300 four-byte characters would exceed MAX_CLIENT_MESSAGE_BYTES: refused, never sent.
    invalid(gm.notice('😀'.repeat(300)))
  })

  it('refuses bad input with an English message instead of sending it', () => {
    invalid(gm.notice(''))
    invalid(gm.notice('   '))
    invalid(gm.notice('a'.repeat(301)))
    invalid(gm.tpFields('abc', '1'))
    invalid(gm.tpFields('1', ''))
    invalid(gm.tpFields('1e3', '2'))
    invalid(gm.tpTo(Number.NaN, 0))
    invalid(gm.tpTo(0, 2_000_000))
    invalid(gm.tpPlace(''))
    invalid(gm.tpPlace('two words'))
    invalid(gm.tpPlace('@Bob'))
    invalid(gm.tpPlayer('x'))
    invalid(gm.summon('1abc'))
    invalid(gm.kick('has space'))
    invalid(gm.kick('Bob', 'r'.repeat(101)))
    invalid(gm.setLevel('Hero', 0))
    invalid(gm.setLevel('Hero', 26)) // the default cap is 25 (docs/CLIMB.md)
    invalid(gm.setLevel('Hero', 1.5))
    invalid(gm.setLevel('Hero', Number.NaN))
    invalid(gm.setLevel('', 5))
    invalid(gm.speed(0.4))
    invalid(gm.speed(5.1))
    invalid(gm.speed(Number.POSITIVE_INFINITY))
    invalid(gmMessage('Who'))
    invalid(gmMessage('who', Array.from({ length: 9 }, () => 'a')))
    invalid(gmMessage('who', ['a'.repeat(101)]))
  })

  it('has small helpers the window relies on', () => {
    expect(playerName(' @Bob ')).toBe('Bob')
    expect(playerName('ab')).toBeNull()
    expect(parseCoord('-12.5')).toBe(-12.5)
    expect(parseCoord('12,5')).toBeNull()
    expect(fmtCoord(-0.04)).toBe('0.0')
    expect(isGmWindowCommand('/gm')).toBe(true)
    expect(isGmWindowCommand(' /GM ')).toBe(true)
    expect(isGmWindowCommand('/gm who')).toBe(false)
    expect(splitWords('a b c', 3)).toEqual(['a b', 'c'])
    expect(commandText({ t: 'gm', cmd: 'tp', args: ['1.0', '2.0'] })).toBe('/tp 1.0 2.0')
    expect(kickMessage('kicked')).toBe('You were disconnected by a Game Master.')
    expect(kickMessage('kicked: spam')).toBe('You were disconnected by a Game Master: spam')
  })

  it('groups the teleport places (Town, Fields, Coast, Bosses, Other) and searches names and aliases', () => {
    const presets = [
      { name: 'jangan', x: 0, z: 0 },
      { name: 'spawn', x: 0, z: 0 },
      { name: 'tiger-camp-1', x: 0, z: 0, group: 'bosses' },
      { name: 'plaza', x: 0, z: 0, group: 'town' },
      { name: 'north-tiger-mt', x: 0, z: 0, group: 'fields' },
      { name: 'jangan-south-beach', x: 0, z: 0, group: 'coast', aliases: ['beach-south'] },
      { name: 'west_gate', x: 0, z: 0 },
      { name: 'odd', x: 0, z: 0, group: 'dungeon' },
    ]
    const names = (q?: string) => groupPlaces(presets, q).map(g => [g.group, g.places.map(p => p.name)])
    expect(names()).toEqual([
      ['town', ['jangan', 'spawn', 'plaza']],
      ['fields', ['north-tiger-mt']],
      ['coast', ['jangan-south-beach']],
      ['bosses', ['tiger-camp-1']],
      ['other', ['west_gate', 'odd']],
    ])
    expect(names('TIGER')).toEqual([['fields', ['north-tiger-mt']], ['bosses', ['tiger-camp-1']]])
    expect(names('beach south')).toEqual([['coast', ['jangan-south-beach']]])
    expect(names('west gate')).toEqual([['other', ['west_gate']]])
    expect(names('nothing here')).toEqual([])
  })

  it('tp npc sends the words after npc; an empty name is refused', () => {
    expect(valid(gm.tpNpc('  Storage-keeper   Wangu '))).toEqual({ t: 'gm', cmd: 'tp', args: ['npc', 'Storage-keeper Wangu'] })
    expect(commandText(valid(gm.tpNpc('smith')))).toBe('/tp npc smith')
    invalid(gm.tpNpc('   '))
  })

  it('reads gmResult data tolerantly', () => {
    const info = { id: 7, name: 'Bob', account: 'bob', role: 'gm', level: 3, pos: [1, 2, 3], region: 25000, regionXZ: [168, 97], invisible: true, speed: 2 }
    expect(readPlayerInfo(info)).toEqual(info)
    expect(readPlayerInfo({ id: 1, name: 'X', pos: [0, 0, 0], role: 'boss' })).toMatchObject({ role: 'player', level: 1, region: null, speed: 1 })
    expect(readPlayers({ players: [info, { junk: true }, null] })).toHaveLength(1)
    expect(readPlayers('nope')).toBeNull()
    expect(readPresets({ presets: [{ name: 'jangan', x: 1, z: 2 }, { name: 3 }] })).toEqual([{ name: 'jangan', x: 1, z: 2 }])
    expect(readPresets(undefined)).toBeNull()
    expect(readPresets({ presets: [{ name: 'jangan-south-beach', x: 1, z: 2, group: 'coast', aliases: ['beach-south', 7] }, { name: 'a', x: 0, z: 0, group: 5 }] })).toEqual([
      { name: 'jangan-south-beach', x: 1, z: 2, group: 'coast', aliases: ['beach-south'] },
      { name: 'a', x: 0, z: 0 },
    ])
    expect(readSelfFlags({ speed: 3, invisible: false })).toEqual({ speed: 3, invisible: false })
    expect(readSelfFlags(null)).toEqual({})
  })
})

// ---- end to end against the mock server, with every frame checked by the shared validators ----------

/** Wraps a Wire so that every client frame must pass parseClientMessage and every server frame parseServerMessage. */
function validating(inner: Wire, sent: ClientMessage[]): Wire {
  const w: Wire = {
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => {},
    send: msg => {
      const r = parseClientMessage(JSON.stringify(msg))
      if (!r.ok) throw new Error(`client frame rejected: ${r.error} ${JSON.stringify(msg)}`)
      sent.push(msg)
      inner.send(msg)
    },
    close: () => inner.close(),
  }
  inner.onOpen = () => w.onOpen()
  inner.onMessage = msg => {
    const r = parseServerMessage(JSON.stringify(msg))
    if (!r.ok) throw new Error(`server frame rejected: ${r.error} ${JSON.stringify(msg)}`)
    w.onMessage(r.msg)
  }
  inner.onClose = info => w.onClose(info)
  return w
}

function waitFor<T extends ServerMessage['t']>(s: Session, t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 2000): Promise<Extract<ServerMessage, { t: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), ms)
    const off = s.on(msg => {
      if (msg.t === t && pred(msg as Extract<ServerMessage, { t: T }>)) {
        clearTimeout(timer)
        off()
        resolve(msg as Extract<ServerMessage, { t: T }>)
      }
    })
  })
}

function waitStatus(s: Session, pred: (ev: StatusEvent) => boolean, ms = 3000): Promise<StatusEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for status')), ms)
    const off = s.onStatus(ev => {
      if (pred(ev)) {
        clearTimeout(timer)
        off()
        resolve(ev)
      }
    })
  })
}

async function inWorld(server: MockServer, name: string, sent: ClientMessage[] = []) {
  await server.register({ username: name.toLowerCase(), password: 'secret' })
  const { token } = await server.login({ username: name.toLowerCase(), password: 'secret' })
  const s = new Session(() => validating(server.wire(), sent), token)
  const welcome = await s.connect()
  const { character } = await s.request({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' }, ['charCreated'])
  const enter = await s.request({ t: 'enterWorld', id: character.id }, ['worldEnter'])
  return { s, welcome, enter }
}

const run = (s: Session, build: GmBuild) => s.request(valid(build), ['gmResult'])

describe('GM flows (mock server, ?mock=1&gm=1)', () => {
  it('tracks the role and refuses GM commands for players', async () => {
    const server = new MockServer(memory(), 0)
    const { s, welcome, enter } = await inWorld(server, 'Plain')
    expect(welcome.role).toBe('player')
    expect(enter.role).toBe('player')
    expect(s.role).toBe('player')
    await expect(run(s, gm.who())).rejects.toMatchObject({ code: 'forbidden' })
    const err = waitFor(s, 'error')
    s.send({ t: 'chat', text: '/who' })
    expect(await err).toMatchObject({ code: 'forbidden', re: 'chat' })
    s.close()
  })

  it('runs every window command as a GM', async () => {
    const server = new MockServer(memory(), 0)
    server.gmRole = 'admin'
    const sent: ClientMessage[] = []
    const { s, enter } = await inWorld(server, 'Boss', sent)
    expect(s.role).toBe('admin')
    const me = enter.self.id

    const who = await run(s, gm.who())
    const players = readPlayers(who.data)!
    expect(players.map(p => p.name)).toEqual(expect.arrayContaining(['Boss', 'Xiao_Lin', 'WeiChen', 'MeiHua']))

    expect(readPresets((await run(s, gm.places())).data)!.map(p => p.name)).toContain('jangan')

    const warped = waitFor(s, 'warp', m => m.id === me)
    expect((await run(s, gm.tpFields('120', '-40'))).ok).toBe(true)
    expect((await warped).pos).toEqual([120, 0, -40])

    const home = waitFor(s, 'warp', m => m.id === me)
    await run(s, gm.tpPlace('jangan'))
    expect((await home).pos[0]).toBe(0)

    expect((await run(s, gm.tpPlayer('WeiChen'))).ok).toBe(true)
    const summoned = waitFor(s, 'warp', m => m.id !== me)
    expect((await run(s, gm.summon('Xiao_Lin'))).ok).toBe(true)
    await summoned

    const levelled = waitFor(s, 'entityUpdate', m => m.level === 9)
    expect((await run(s, gm.setLevel('MeiHua', 9))).ok).toBe(true)
    await levelled

    expect(readSelfFlags((await run(s, gm.speed(3))).data)).toEqual({ speed: 3 })
    const moved = waitFor(s, 'move', m => m.id === me)
    s.send({ t: 'moveTo', x: 130, z: 0 })
    expect((await moved).move.speed).toBeCloseTo(5.5 * 3)

    const ghost = waitFor(s, 'entityUpdate', m => m.id === me && m.invisible === true)
    expect(readSelfFlags((await run(s, gm.invis(true))).data)).toEqual({ invisible: true })
    await ghost
    expect(readPlayers((await run(s, gm.who())).data)!.find(p => p.id === me)).toMatchObject({ invisible: true, speed: 3 })

    const notice = waitFor(s, 'notice')
    await run(s, gm.notice('Server restart in 5 minutes'))
    expect(await notice).toMatchObject({ text: 'Server restart in 5 minutes', from: 'Boss' })

    const gone = waitFor(s, 'despawn')
    expect((await run(s, gm.kick('MeiHua', 'afk'))).ok).toBe(true)
    await gone

    expect((await run(s, gmMessage('spawn'))).ok).toBe(false)

    // Slash lines typed in chat are chat frames; the reply is a gmResult, never a chat broadcast.
    const slash = waitFor(s, 'gmResult')
    s.send({ t: 'chat', text: '/speed 1' })
    expect(await slash).toMatchObject({ ok: true, cmd: 'speed' })

    expect(sent.filter(m => m.t === 'gm').length).toBeGreaterThanOrEqual(12)
    s.close()
  })

  it('a kicked session closes for good with the reason', async () => {
    const server = new MockServer(memory(), 0)
    server.gmRole = 'admin'
    const a = await inWorld(server, 'Kicker')
    const b = await inWorld(server, 'Kicked')
    const closed = waitStatus(b.s, ev => ev.status === 'closed')
    expect((await run(a.s, gm.kick('Kicked', 'testing'))).ok).toBe(true)
    expect(await closed).toMatchObject({ reason: 'kicked', message: 'You were disconnected by a Game Master: testing' })
    await new Promise(r => setTimeout(r, 50))
    expect(b.s.status).toBe('closed')
    a.s.close()
  })
})
