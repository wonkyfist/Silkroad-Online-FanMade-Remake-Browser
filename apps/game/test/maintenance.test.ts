/**
 * Maintenance mode in the client (docs/ADMIN.md §8): the wire message, the countdown banner's text and life cycle (with
 * a stub document: there is no DOM in vitest), the login screen's message after the kick, and the server list letting
 * staff pick a server under maintenance.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_CODE, parseServerMessage } from '@sro/shared'
import { MaintenanceBanner, clockText, maintenanceBannerText } from '../src/ui/maintenance-banner.ts'
import { maintenanceMessage } from '../src/net/session.ts'
import { describeError } from '../src/screens/login.ts'
import { GameError } from '../src/net/api.ts'
import { t } from '../src/i18n/index.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('maintenance on the wire', () => {
  it('parses the banner message and the new error code; refuses a bad state', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'maintenance', state: 'countdown', endsIn: 5000, reason: 'Patch', back: 30 }))).toEqual({
      ok: true,
      msg: { t: 'maintenance', state: 'countdown', endsIn: 5000, reason: 'Patch', back: 30 },
    })
    expect(parseServerMessage(JSON.stringify({ t: 'maintenance', state: 'off' })).ok).toBe(true)
    expect(parseServerMessage(JSON.stringify({ t: 'maintenance', state: 'later' })).ok).toBe(false)
    expect(parseServerMessage(JSON.stringify({ t: 'maintenance', state: 'on', endsIn: -1 })).ok).toBe(false)
    expect(parseServerMessage(JSON.stringify({ t: 'error', code: 'maintenance', message: 'x', re: 'hello' })).ok).toBe(true)
    expect(CLOSE_CODE.maintenance).toBe(4012)
  })
})

describe('the countdown banner', () => {
  it('words the countdown, the reason, the downtime and the staff-only state', () => {
    expect(clockText(299_001)).toBe('5:00')
    expect(clockText(9_000)).toBe('0:09')
    expect(clockText(3_723_000)).toBe('1:02:03')
    expect(maintenanceBannerText({ state: 'off' }, 0)).toBeNull()
    expect(maintenanceBannerText({ state: 'countdown', reason: 'Patch', back: 30 }, 65_000)).toBe('Server maintenance in 1:05 · Patch · expected downtime about 30 min')
    expect(maintenanceBannerText({ state: 'countdown' }, 0)).toBe(t('maint.banner.now'))
    expect(maintenanceBannerText({ state: 'on', back: 120 }, 0)).toBe('Maintenance mode is ON (staff only) · expected downtime about 2 h')
  })

  it('ticks down every second, and leaves on off or with the session', () => {
    vi.useFakeTimers()
    const body: unknown[] = []
    const node = () => {
      const n = { className: '', textContent: '', title: '', setAttribute() {}, classList: { toggle() {} }, remove: () => body.splice(body.indexOf(n), 1), append() {} }
      return n
    }
    vi.stubGlobal('document', { createElement: node, body: { append: (n: unknown) => body.push(n) } })
    let now = 0
    const b = new MaintenanceBanner(() => now)
    b.update({ state: 'countdown', endsIn: 10_000 })
    expect(b.text).toBe('Server maintenance in 0:10')
    now = 3000
    vi.advanceTimersByTime(1000)
    expect(b.text).toBe('Server maintenance in 0:07')
    b.update({ state: 'off' })
    expect(b.text).toBe('')
    expect(body).toHaveLength(0)
    b.update({ state: 'on' })
    expect(b.text).toBe('Maintenance mode is ON (staff only)')
    b.hide()
    expect(body).toHaveLength(0)
  })
})

describe('the messages players see', () => {
  it('the kick: the server sentence, else our own', () => {
    expect(maintenanceMessage('The server is under maintenance. Expected back: in about 30 minutes.')).toBe('The server is under maintenance. Expected back: in about 30 minutes.')
    expect(maintenanceMessage('')).toBe(t('net.maintenance'))
    expect(maintenanceMessage('maintenance')).toBe(t('net.maintenance'))
  })

  it('a refused login or server pick shows the server text', () => {
    expect(describeError(new GameError('maintenance', 'The server is under maintenance. Please try again later.'))).toBe('The server is under maintenance. Please try again later.')
    expect(describeError(new GameError('maintenance', ''))).toBe(t('error.maintenance'))
  })

  it('the server list shows "Maintenance" and lets it be picked (staff get in; players get the reason)', async () => {
    const { pickable } = await import('../src/screens/servers.ts')
    expect(pickable({ status: 'maintenance' })).toBe(true)
    expect(pickable({ status: 'online' })).toBe(true)
    expect(pickable({ status: 'offline' })).toBe(false)
    expect(t('servers.maintenance')).toBe('Maintenance')
  })
})
