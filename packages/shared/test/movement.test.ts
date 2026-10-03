/** Wave 10: the jump's shared constants and protocol frames (docs/MOVEMENT.md §5, §8.2; docs/WAVE_PLAN6.md §3, §4.3). */
import { describe, expect, it } from 'vitest'
import {
  ACTION_FAIL_REASONS,
  CLIENT_RATE_LIMITS,
  GAMEPLAY_REQUESTS,
  JUMP_COOLDOWN_KEY,
  JUMP_COOLDOWN_MS,
  JUMP_COOLDOWN_SLACK_MS,
  JUMP_ECHO_WINDOW_MS,
  JUMP_LATE_DROP_MS,
  JUMP_MAX_SEEK_MS,
  parseClientMessage,
  parseServerMessage,
  validateServerMessage,
  type ActionFailReason,
  type ClientMessage,
  type ServerMessage,
} from '../src/index.ts'

const client = (v: unknown) => parseClientMessage(JSON.stringify(v))
const server = (v: unknown) => parseServerMessage(JSON.stringify(v))
const rejectedClient = (v: unknown) => expect(client(v).ok, JSON.stringify(v)).toBe(false)
const rejectedServer = (v: unknown) => expect(server(v).ok, JSON.stringify(v)).toBe(false)

describe('jump constants (docs/MOVEMENT.md §5)', () => {
  it('are the spec values', () => {
    expect(JUMP_COOLDOWN_MS).toBe(1000)
    expect(JUMP_LATE_DROP_MS).toBe(600)
    expect(JUMP_ECHO_WINDOW_MS).toBe(600)
    expect(JUMP_MAX_SEEK_MS).toBe(200)
    expect(JUMP_COOLDOWN_SLACK_MS).toBe(150)
    expect(JUMP_COOLDOWN_KEY).toBe('move.jump')
  })

  it('are positive integers and consistent with each other', () => {
    for (const v of [JUMP_COOLDOWN_MS, JUMP_LATE_DROP_MS, JUMP_ECHO_WINDOW_MS, JUMP_MAX_SEEK_MS, JUMP_COOLDOWN_SLACK_MS]) {
      expect(Number.isInteger(v) && v > 0, String(v)).toBe(true)
    }
    // a late viewer may skip the crouch, never the whole jump: the seek cap stays inside the late-drop window
    expect(JUMP_MAX_SEEK_MS).toBeLessThan(JUMP_LATE_DROP_MS)
    // the slack only forgives jitter: the effective cooldown stays well above zero and below the full cooldown
    expect(JUMP_COOLDOWN_SLACK_MS).toBeLessThan(JUMP_COOLDOWN_MS / 2)
    // the echo window never outlives the cooldown, so a real second jump is never taken for the first one's echo
    expect(JUMP_ECHO_WINDOW_MS).toBeLessThanOrEqual(JUMP_COOLDOWN_MS - JUMP_COOLDOWN_SLACK_MS)
  })

  it('the rate limit is 2/s, burst 3, and cannot beat the cooldown by much', () => {
    expect(CLIENT_RATE_LIMITS.jump).toEqual({ perSecond: 2, burst: 3 })
    expect(1000 / CLIENT_RATE_LIMITS.jump!.perSecond).toBeLessThanOrEqual(JUMP_COOLDOWN_MS - JUMP_COOLDOWN_SLACK_MS)
  })
})

describe('the client jump (a GameplayRequest)', () => {
  it('accepts { t: "jump" } with no fields', () => {
    const f: ClientMessage = { t: 'jump' }
    expect(client(f)).toEqual({ ok: true, msg: f })
  })

  it('rejects any extra key (strict)', () => {
    rejectedClient({ t: 'jump', yaw: 1 })
    rejectedClient({ t: 'jump', at: 5 })
    rejectedClient({ t: 'jump', id: 1 })
  })

  it('is a GameplayRequest with a rate-limit row, listed once', () => {
    expect(GAMEPLAY_REQUESTS).toContain('jump')
    expect(GAMEPLAY_REQUESTS.filter((r) => r === 'jump')).toHaveLength(1)
    expect(new Set(GAMEPLAY_REQUESTS).size).toBe(GAMEPLAY_REQUESTS.length)
    for (const r of GAMEPLAY_REQUESTS) expect(CLIENT_RATE_LIMITS[r], r).toBeDefined()
  })

  it('reuses existing fail reasons only (no trading: the jump is allowed in a trade)', () => {
    for (const r of ['dead', 'cant_act', 'busy', 'cooldown', 'mounted', 'stalling', 'rate_limited'] as ActionFailReason[]) {
      expect(ACTION_FAIL_REASONS, r).toContain(r)
    }
  })

  it('actionResult answers for jump parse, accepted and refused', () => {
    const msgs: ServerMessage[] = [
      { t: 'actionResult', re: 'jump', ok: true },
      { t: 'actionResult', re: 'jump', ok: false, reason: 'cooldown' },
      { t: 'actionResult', re: 'jump', ok: false, reason: 'mounted' },
      { t: 'actionResult', re: 'jump', ok: false, reason: 'busy', message: 'casting' },
    ]
    for (const m of msgs) expect(server(m), JSON.stringify(m)).toEqual({ ok: true, msg: m })
  })
})

describe('the server jump', () => {
  it('accepts an integer id and a finite at', () => {
    const msgs: ServerMessage[] = [
      { t: 'jump', id: 42, at: 1_790_000_000_000 },
      { t: 'jump', id: 0, at: 0 },
      { t: 'jump', id: 7, at: 1_790_000_000_000.5 },
    ]
    for (const m of msgs) expect(server(m), JSON.stringify(m)).toEqual({ ok: true, msg: m })
  })

  it('drops unknown extra keys, as every server frame does', () => {
    expect(server({ t: 'jump', id: 3, at: 10, run: true })).toEqual({ ok: true, msg: { t: 'jump', id: 3, at: 10 } })
  })

  it('rejects a NaN or infinite at, a non-integer or negative id, and missing fields', () => {
    // JSON has no NaN or Infinity, so check the decoded-value path too
    for (const at of [NaN, Infinity, -Infinity]) expect(validateServerMessage({ t: 'jump', id: 1, at }).ok, String(at)).toBe(false)
    expect(validateServerMessage({ t: 'jump', id: NaN, at: 10 }).ok).toBe(false)
    rejectedServer({ t: 'jump', id: 1, at: 'NaN' })
    rejectedServer({ t: 'jump', id: 1, at: null })
    rejectedServer({ t: 'jump', id: 1.5, at: 10 })
    rejectedServer({ t: 'jump', id: -1, at: 10 })
    rejectedServer({ t: 'jump', id: '1', at: 10 })
    rejectedServer({ t: 'jump', at: 10 })
    rejectedServer({ t: 'jump', id: 1 })
    rejectedServer({ t: 'jump', id: 1, at: -5 })
  })
})
