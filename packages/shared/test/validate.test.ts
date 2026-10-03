import { describe, expect, it } from 'vitest'
import {
  CLOSE_CODE,
  heightScale,
  GM_MAX_ARGS,
  GM_MAX_ARG_LENGTH,
  MAX_CHAT_LENGTH,
  ROLES,
  isStaff,
  MAX_CLIENT_MESSAGE_BYTES,
  codePointLength,
  parseClientMessage,
  parseServerMessage,
  utf8Length,
  validateClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '../src/index.ts'

const ok = (v: unknown) => parseClientMessage(JSON.stringify(v))

describe('parseClientMessage', () => {
  it('accepts every well-formed message type', () => {
    const good: ClientMessage[] = [
      { t: 'hello', version: 1, token: 'abc_DEF-123' },
      { t: 'charList' },
      { t: 'nameCheck', name: 'Hero' },
      { t: 'charCreate', name: 'Hero', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'glaive' },
      { t: 'charDelete', id: 3 },
      { t: 'enterWorld', id: 3 },
      { t: 'moveTo', x: -12.5, z: 1e5 },
      { t: 'chat', text: '你好 😀' },
      { t: 'leaveWorld' },
      { t: 'ping', n: 0, clientTime: 1234.567 },
    ]
    for (const m of good) expect(ok(m), m.t).toEqual({ ok: true, msg: m })
  })

  it('rejects malformed JSON and non-objects', () => {
    for (const s of ['', 'nope', '{', '[]', 'null', '1', '"hello"']) expect(parseClientMessage(s).ok, s).toBe(false)
  })

  it('rejects unknown types, missing and extra fields', () => {
    const bad = [
      { t: 'bogus' },
      { t: 'toString' },
      { t: '__proto__' },
      { type: 'charList' },
      { t: 'hello', version: 1 },
      { t: 'charList', x: 1 },
      { t: 'moveTo', x: 1, z: 2, y: 3 },
    ]
    for (const m of bad) expect(ok(m).ok, JSON.stringify(m)).toBe(false)
    expect(parseClientMessage('{"t":"charList","__proto__":{"x":1}}').ok).toBe(false)
  })

  it('checks field types and limits', () => {
    const bad = [
      { t: 'hello', version: '1', token: 'x' },
      { t: 'hello', version: 1.5, token: 'x' },
      { t: 'hello', version: 1, token: '' },
      { t: 'hello', version: 1, token: 'x'.repeat(257) },
      { t: 'nameCheck', name: 5 },
      { t: 'nameCheck', name: 'x'.repeat(33) },
      { t: 'charCreate', name: 'Hero', model: 'char_ch_man', weapon: 'blade' },
      { t: 'charCreate', name: 'Hero', model: 'res/char/china/chinaman.bsr', weapon: 'blade' },
      { t: 'charCreate', name: 'Hero', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'axe' },
      { t: 'charDelete', id: 0 },
      { t: 'charDelete', id: '1' },
      { t: 'enterWorld', id: 2 ** 60 },
      { t: 'moveTo', x: null, z: 0 },
      { t: 'moveTo', x: 0, z: 1e7 },
      { t: 'chat', text: '' },
      { t: 'chat', text: 'x'.repeat(MAX_CHAT_LENGTH + 1) },
      { t: 'ping', n: -1, clientTime: 0 },
      { t: 'ping', n: 1, clientTime: '0' },
    ]
    for (const m of bad) expect(ok(m).ok, JSON.stringify(m)).toBe(false)
    // NaN/Infinity cannot be expressed in JSON but can reach validateClientMessage directly
    expect(validateClientMessage({ t: 'moveTo', x: NaN, z: 0 }).ok).toBe(false)
    expect(validateClientMessage({ t: 'moveTo', x: Infinity, z: 0 }).ok).toBe(false)
  })

  it('counts chat length in code points', () => {
    expect(ok({ t: 'chat', text: '😀'.repeat(MAX_CHAT_LENGTH) }).ok).toBe(true)
    expect(ok({ t: 'chat', text: '😀'.repeat(MAX_CHAT_LENGTH + 1) }).ok).toBe(false)
  })

  it('rejects frames over the byte limit', () => {
    const pad = 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES)
    const r = parseClientMessage(`{"t":"charList","pad":"${pad}"}`)
    expect(r).toEqual({ ok: false, error: `frame larger than ${MAX_CLIENT_MESSAGE_BYTES} bytes` })
    // multi-byte characters count as bytes, not UTF-16 units
    const wide = JSON.stringify({ t: 'nameCheck', name: '你'.repeat(10) }) + ' '.repeat(MAX_CLIENT_MESSAGE_BYTES - 50)
    expect(wide.length).toBeLessThanOrEqual(MAX_CLIENT_MESSAGE_BYTES)
    expect(parseClientMessage(wide).ok).toBe(false)
  })

  it('utf8Length and codePointLength', () => {
    expect(utf8Length('aé你😀')).toBe(1 + 2 + 3 + 4)
    expect(utf8Length('aé你😀')).toBe(new TextEncoder().encode('aé你😀').length)
    expect(codePointLength('a😀')).toBe(2)
  })
})

describe('parseServerMessage', () => {
  const entity = { id: 1, kind: 'player', name: 'Hero', model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', pos: [1, 2, 3], yaw: 0.5 }
  const move = { from: [0, 0, 0], to: [1, 0, 1], speed: 5.5, startedAt: 1000 }
  const character = { id: 1, name: 'Hero', model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'bow', location: 'Jangan', pos: [0, 0, 0], lastPlayed: 0 }

  it('accepts every well-formed message type', () => {
    const good: ServerMessage[] = [
      { t: 'welcome', account: 'bob', server: { id: 'jangan', name: 'Jangan', status: 'online', online: 1, capacity: 50 }, slots: 4 },
      { t: 'error', code: 'name_taken', message: 'taken', re: 'charCreate' },
      { t: 'error', code: 'bad_request', message: 'x' },
      { t: 'charList', slots: 4, characters: [character as never] },
      { t: 'nameCheck', name: 'Hero', available: false, reason: 'taken' },
      { t: 'charCreated', character: character as never },
      { t: 'charDeleted', id: 1 },
      { t: 'worldEnter', self: { ...entity, move } as never, world: { name: 'jangan', serverTime: 5, tickRate: 10 }, entities: [entity as never] },
      { t: 'worldLeft' },
      { t: 'spawn', entity: entity as never },
      { t: 'despawn', id: 1 },
      { t: 'move', id: 1, move: move as never },
      { t: 'stop', id: 1, pos: [1, 2, 3], yaw: -1 },
      { t: 'chat', channel: 'local', fromId: 1, from: 'Hero', text: 'hi' },
      { t: 'chat', channel: 'system', text: 'bye' },
      { t: 'pong', n: 1, clientTime: 2, serverTime: 3 },
    ]
    for (const m of good) expect(parseServerMessage(JSON.stringify(m)), m.t).toEqual({ ok: true, msg: m })
  })

  it('ignores unknown extra keys but rejects bad known ones', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'despawn', id: 1, future: true }))).toEqual({ ok: true, msg: { t: 'despawn', id: 1 } })
    const bad = [
      { t: 'nope' },
      { t: 'despawn' },
      { t: 'stop', id: 1, pos: [1, 2], yaw: 0 },
      { t: 'move', id: 1, move: { ...move, speed: 'fast' } },
      { t: 'spawn', entity: { ...entity, kind: 'monster' } },
      { t: 'error', code: 'whatever', message: 'x' },
      { t: 'chat', channel: 'world', text: 'x' },
      { t: 'charList', slots: 4, characters: {} },
    ]
    for (const m of bad) expect(parseServerMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(false)
    expect(parseServerMessage('not json').ok).toBe(false)
  })
})

describe('GM additions', () => {
  it('accepts well-formed gm messages', () => {
    const good: ClientMessage[] = [
      { t: 'gm', cmd: 'who', args: [] },
      { t: 'gm', cmd: 'tp', args: ['100', '-100'] },
      { t: 'gm', cmd: 'notice', args: ['x'.repeat(GM_MAX_ARG_LENGTH)] },
      { t: 'gm', cmd: 'a'.repeat(16), args: Array.from({ length: GM_MAX_ARGS }, () => '你好') },
    ]
    for (const m of good) expect(ok(m), JSON.stringify(m)).toEqual({ ok: true, msg: m })
    expect(ok({ t: 'gm', cmd: 'notice', args: ['😀'.repeat(GM_MAX_ARG_LENGTH)] }).ok).toBe(true)
  })

  it('enforces the gm limits', () => {
    const bad = [
      { t: 'gm', cmd: '', args: [] },
      { t: 'gm', cmd: 'a'.repeat(17), args: [] },
      { t: 'gm', cmd: 'TP', args: [] },
      { t: 'gm', cmd: 'tp2', args: [] },
      { t: 'gm', cmd: '/tp', args: [] },
      { t: 'gm', cmd: 'tp', args: Array.from({ length: GM_MAX_ARGS + 1 }, () => '1') },
      { t: 'gm', cmd: 'tp', args: ['x'.repeat(GM_MAX_ARG_LENGTH + 1)] },
      { t: 'gm', cmd: 'tp', args: [1, 2] },
      { t: 'gm', cmd: 'tp', args: '1 2' },
      { t: 'gm', cmd: 'tp', args: [null] },
      { t: 'gm', cmd: 'tp' },
      { t: 'gm', args: [] },
      { t: 'gm', cmd: 'tp', args: [], extra: 1 },
    ]
    for (const m of bad) expect(ok(m).ok, JSON.stringify(m)).toBe(false)
  })

  it('parses the GM server messages and the role fields', () => {
    const entity = { id: 1, kind: 'player', name: 'Hero', model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', pos: [1, 2, 3], yaw: 0.5 }
    const good: ServerMessage[] = [
      { t: 'welcome', account: 'bob', server: { id: 'jangan', name: 'Jangan', status: 'online', online: 1, capacity: 50 }, slots: 4, role: 'gm' },
      { t: 'worldEnter', self: { ...entity, invisible: true } as never, world: { name: 'jangan', serverTime: 5, tickRate: 10 }, entities: [], role: 'admin' },
      { t: 'spawn', entity: { ...entity, invisible: true } as never },
      { t: 'gmResult', ok: true, cmd: 'who', message: '1 player online', data: { players: [{ name: 'Hero' }] } },
      { t: 'gmResult', ok: false, cmd: 'fly', message: 'Unknown command' },
      { t: 'notice', text: 'Restart in 5 minutes', from: 'Keeper' },
      { t: 'notice', text: 'hi' },
      { t: 'warp', id: 3, pos: [1, 2, 3], yaw: 0 },
      { t: 'entityUpdate', id: 3, level: 12 },
      { t: 'entityUpdate', id: 3, invisible: false, name: 'Hero' },
      { t: 'role', role: 'player' },
      { t: 'error', code: 'forbidden', message: 'Game Master commands only.', re: 'gm' },
    ]
    for (const m of good) expect(parseServerMessage(JSON.stringify(m)), m.t).toEqual({ ok: true, msg: m })
    const bad = [
      { t: 'welcome', account: 'bob', server: { id: 'j', name: 'J', status: 'online', online: 1, capacity: 50 }, slots: 4, role: 'god' },
      { t: 'gmResult', ok: 'yes', cmd: 'who', message: '' },
      { t: 'gmResult', ok: true, cmd: 'who' },
      { t: 'notice', text: '' },
      { t: 'warp', id: 3, pos: [1, 2], yaw: 0 },
      { t: 'entityUpdate', id: 3, level: 'high' },
      { t: 'entityUpdate', id: 3, invisible: 1 },
      { t: 'role', role: 'root' },
      { t: 'spawn', entity: { ...entity, invisible: 'yes' } },
    ]
    for (const m of bad) expect(parseServerMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(false)
  })

  it('role helpers', () => {
    expect(ROLES).toEqual(['player', 'gm', 'admin'])
    expect([isStaff('player'), isStaff('gm'), isStaff('admin'), isStaff(undefined)]).toEqual([false, true, true, false])
    expect(CLOSE_CODE.kicked).toBe(4010)
  })
})

describe('appearance additions', () => {
  it('charCreate accepts optional height/volume 0..4 and rejects out-of-range values', () => {
    const base = { t: 'charCreate', name: 'Ryu', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' }
    const ok = parseClientMessage(JSON.stringify({ ...base, height: 4, volume: 0 }))
    expect(ok).toMatchObject({ ok: true, msg: { t: 'charCreate', height: 4, volume: 0 } })
    const plain = parseClientMessage(JSON.stringify(base))
    expect(plain.ok && plain.msg).not.toHaveProperty('height')
    expect(parseClientMessage(JSON.stringify({ ...base, height: 5 })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ ...base, volume: 1.5 })).ok).toBe(false)
  })
  it('charCreate outfit is one of STARTER_OUTFITS; unknown keys still fail', () => {
    const base = { t: 'charCreate', name: 'Ryu', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' }
    for (const outfit of ['clothes', 'light', 'heavy']) {
      expect(parseClientMessage(JSON.stringify({ ...base, outfit }))).toMatchObject({ ok: true, msg: { outfit } })
    }
    for (const outfit of ['robe', 'HEAVY', '', 1, null]) expect(parseClientMessage(JSON.stringify({ ...base, outfit })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ ...base, height: '2' })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ ...base, scale: 34 })).ok).toBe(false)
  })
  it('the character list, worldEnter and spawn carry height/volume/equip (server -> client)', () => {
    const summary = { id: 1, name: 'Ryu', model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', location: 'Jangan', pos: [96.9, -3.26, -136.9], lastPlayed: 0 }
    const list = parseServerMessage(JSON.stringify({ t: 'charList', slots: 4, characters: [{ ...summary, height: 4, volume: 0, equip: { weapon: 'ITEM_CH_BLADE_01_A_DEF', chest: 'ITEM_CH_M_HEAVY_01_BA_A_DEF' } }] }))
    expect(list).toMatchObject({ ok: true, msg: { characters: [{ height: 4, volume: 0, equip: { chest: 'ITEM_CH_M_HEAVY_01_BA_A_DEF' } }] } })
    expect(parseServerMessage(JSON.stringify({ t: 'charList', slots: 4, characters: [{ ...summary, height: 7 }] })).ok).toBe(false)
    const entity = { id: 5, kind: 'player', name: 'Ryu', model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', pos: [0, -3.26, 0], yaw: 0, height: 0, volume: 4 }
    expect(parseServerMessage(JSON.stringify({ t: 'spawn', entity }))).toMatchObject({ ok: true, msg: { entity: { height: 0, volume: 4 } } })
    expect(parseServerMessage(JSON.stringify({ t: 'spawn', entity: { ...entity, volume: -1 } })).ok).toBe(false)
  })
  it('heightScale follows 0.94 + 0.03h with the default at 1.00', () => {
    expect([0, 1, 2, 3, 4].map(heightScale).map(v => +v.toFixed(2))).toEqual([0.94, 0.97, 1, 1.03, 1.06])
    expect(heightScale(undefined)).toBeCloseTo(1)
    expect(heightScale(9)).toBeCloseTo(1.06)
  })
})
