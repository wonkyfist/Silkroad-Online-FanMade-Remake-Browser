/** Wave 7B protocol additions: posture, emotes, consumable and drop visuals (docs/WAVE_PLAN2.md §3.1, docs/EFFECTS.md §4). */
import { describe, expect, it } from 'vitest'
import {
  ACTION_FAIL_REASONS,
  CLIENT_RATE_LIMITS,
  EMOTE_KINDS,
  GAMEPLAY_REQUESTS,
  POSTURES,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type EntityState,
  type ServerMessage,
} from '../src/index.ts'

const client = (v: unknown) => parseClientMessage(JSON.stringify(v))
const server = (v: unknown) => parseServerMessage(JSON.stringify(v))
const rejected = (v: unknown) => expect(client(v).ok, JSON.stringify(v)).toBe(false)

describe('wave 7B client frames', () => {
  it('accepts sit and every emote with their exact keys', () => {
    const frames: ClientMessage[] = [
      { t: 'sit', on: true },
      { t: 'sit', on: false },
      ...EMOTE_KINDS.map((emote): ClientMessage => ({ t: 'emote', emote })),
    ]
    for (const f of frames) expect(client(f), JSON.stringify(f)).toEqual({ ok: true, msg: f })
  })

  it('rejects extra keys, missing keys, bad emotes and a non-boolean on', () => {
    rejected({ t: 'sit', on: true, x: 1 })
    rejected({ t: 'sit' })
    rejected({ t: 'sit', on: 1 })
    rejected({ t: 'sit', on: 'true' })
    rejected({ t: 'sit', on: null })
    rejected({ t: 'emote', emote: 'hi', target: 5 })
    rejected({ t: 'emote' })
    rejected({ t: 'emote', emote: 'bow' })
    rejected({ t: 'emote', emote: 'HI' })
    rejected({ t: 'emote', emote: 3 })
  })

  it('the emote list matches decision D36 (seven Action-window emotes)', () => {
    expect([...EMOTE_KINDS]).toEqual(['hi', 'laugh', 'greeting', 'yes', 'rush', 'joy', 'no'])
    expect([...POSTURES]).toEqual(['sit', 'stand'])
  })

  it('sit and emote are GameplayRequests with a rate-limit row each (every request has one)', () => {
    expect(GAMEPLAY_REQUESTS).toContain('sit')
    expect(GAMEPLAY_REQUESTS).toContain('emote')
    expect(CLIENT_RATE_LIMITS.sit).toEqual({ perSecond: 2, burst: 4 })
    expect(CLIENT_RATE_LIMITS.emote).toEqual({ perSecond: 1, burst: 3 })
    for (const r of GAMEPLAY_REQUESTS) expect(CLIENT_RATE_LIMITS[r], r).toBeDefined()
    expect(new Set(GAMEPLAY_REQUESTS).size).toBe(GAMEPLAY_REQUESTS.length)
    // 'busy' already exists (decision D10) and is not added twice.
    expect(ACTION_FAIL_REASONS.filter((r) => r === 'busy')).toHaveLength(1)
  })

  it('actionResult answers for sit and emote parse', () => {
    for (const re of ['sit', 'emote'] as const) {
      const m: ServerMessage = { t: 'actionResult', re, ok: false, reason: 'busy' }
      expect(server(m)).toEqual({ ok: true, msg: m })
    }
  })
})

describe('wave 7B server frames', () => {
  it('itemEffect and emote round-trip', () => {
    const frames: ServerMessage[] = [
      { t: 'itemEffect', id: 7, item: 'ITEM_ETC_HP_POTION_01' },
      ...EMOTE_KINDS.map((emote): ServerMessage => ({ t: 'emote', id: 9, emote })),
    ]
    for (const f of frames) expect(server(f), JSON.stringify(f)).toEqual({ ok: true, msg: f })
    // Unknown extra keys are dropped, as for every server frame.
    expect(server({ t: 'emote', id: 9, emote: 'joy', extra: 1 })).toEqual({ ok: true, msg: { t: 'emote', id: 9, emote: 'joy' } })
  })

  it('rejects malformed itemEffect and emote frames', () => {
    expect(server({ t: 'itemEffect', id: 7 }).ok).toBe(false)
    expect(server({ t: 'itemEffect', id: -1, item: 'ITEM_X' }).ok).toBe(false)
    expect(server({ t: 'itemEffect', id: 7, item: '' }).ok).toBe(false)
    expect(server({ t: 'emote', id: 9, emote: 'dance' }).ok).toBe(false)
    expect(server({ t: 'emote', emote: 'hi' }).ok).toBe(false)
  })

  it('keeps EntityState.droppedAt, dropFrom and posture', () => {
    const item: EntityState = {
      id: 40, kind: 'item', name: 'Gold', model: 'ITEM_ETC_GOLD_01', level: 0, pos: [1, 0, 2], yaw: 0,
      count: 12, droppedAt: 1_700_000_000_123, dropFrom: [1.5, 0.2, 2.5],
    }
    const sitter: EntityState = { id: 41, kind: 'player', name: 'Hero_1', model: 'CHAR_CH_MAN_ADVENTURER', level: 5, weapon: 'sword', pos: [0, 0, 0], yaw: 1, posture: 'sit' }
    for (const entity of [item, sitter]) expect(server({ t: 'spawn', entity })).toEqual({ ok: true, msg: { t: 'spawn', entity } })
    const enter = server({ t: 'worldEnter', self: sitter, world: { name: 'jangan-fields', serverTime: 5, tickRate: 10 }, entities: [item] })
    expect(enter.ok && enter.msg.t === 'worldEnter' && enter.msg.self.posture === 'sit' && enter.msg.entities[0]!.dropFrom).toEqual([1.5, 0.2, 2.5])
  })

  it('rejects bad droppedAt, dropFrom and posture values', () => {
    const base = { id: 40, kind: 'item', name: 'Gold', model: 'ITEM_ETC_GOLD_01', level: 0, pos: [1, 0, 2], yaw: 0 }
    for (const extra of [
      { droppedAt: -1 },
      { droppedAt: 1.5 },
      { droppedAt: '5' },
      { dropFrom: [1, 2] },
      { dropFrom: [1, 2, 'x'] },
      { posture: 'stand' },
      { posture: 'lie' },
    ]) {
      expect(server({ t: 'spawn', entity: { ...base, ...extra } }).ok, JSON.stringify(extra)).toBe(false)
    }
  })

  it("keeps entityUpdate.posture 'sit' and 'stand', rejects anything else", () => {
    for (const posture of ['sit', 'stand'] as const) {
      const m: ServerMessage = { t: 'entityUpdate', id: 3, posture }
      expect(server(m)).toEqual({ ok: true, msg: m })
    }
    expect(server({ t: 'entityUpdate', id: 3, posture: 'lie' }).ok).toBe(false)
    expect(server({ t: 'entityUpdate', id: 3, posture: true }).ok).toBe(false)
  })
})
