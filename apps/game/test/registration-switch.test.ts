/**
 * Admin panel registration switch (docs/ADMIN.md): `ServerInfo.registration` on the wire. It round-trips, older servers
 * leave it out, and a bad value drops only that field (never the whole welcome). The client's rule
 * (apps/game/src/net/api.ts registrationOpen): closed only when every server says closed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseServerMessage, type ServerInfo } from '@sro/shared'
import { registrationOpen } from '../src/net/api.ts'

const base: ServerInfo = { id: 'jangan', name: 'Jangan', status: 'online', online: 1, capacity: 50 }

function parsed(server: Record<string, unknown>): ServerInfo {
  const r = parseServerMessage(JSON.stringify({ t: 'welcome', account: 'bob', server, slots: 4 }))
  if (!r.ok || r.msg.t !== 'welcome') throw new Error(`expected welcome, got ${r.ok ? r.msg.t : r.error}`)
  return r.msg.server
}

describe('ServerInfo.registration', () => {
  afterEach(() => vi.restoreAllMocks())

  it('round-trips open and closed; absent stays absent', () => {
    expect(parsed({ ...base, registration: 'closed' })).toEqual({ ...base, registration: 'closed' })
    expect(parsed({ ...base, registration: 'open' })).toEqual({ ...base, registration: 'open' })
    expect(parsed({ ...base })).toEqual(base)
  })

  it('a bad value drops only that field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parsed({ ...base, registration: 'invite-only' })).toEqual(base)
    expect(warn).toHaveBeenCalled()
  })

  it('the login screen hides Register only when every server is closed', () => {
    expect(registrationOpen([])).toBe(true)
    expect(registrationOpen([base])).toBe(true)
    expect(registrationOpen([{ ...base, registration: 'closed' }])).toBe(false)
    expect(registrationOpen([{ ...base, registration: 'closed' }, { ...base, id: 'b', registration: 'open' }])).toBe(true)
  })
})
