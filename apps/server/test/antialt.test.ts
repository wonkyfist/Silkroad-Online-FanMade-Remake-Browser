import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAdminStore } from '../src/admin/store.ts'
import { AntiAlt, type Attempt, type Refusal } from '../src/antialt/guard.ts'
import { RangeList, parseHostingFile, parseTorFile, type Lists } from '../src/antialt/lists.ts'
import { normalizeIp, parseCidrList, resolveClientIp, subnetOf } from '../src/antialt/net.ts'
import { checkPolicy, defaultPolicy, type AntiAltPolicy } from '../src/antialt/policy.ts'
import { checkWindow, waitText, windowMs } from '../src/antialt/window.ts'
import { REPO_ROOT } from '../src/config.ts'
import { openStore } from '../src/db.ts'

const H = 3_600_000
const D = 24 * H

describe('window maths', () => {
  it('turns windows into ms and words', () => {
    expect(windowMs({ amount: 2, unit: 'days' })).toBe(2 * D)
    expect(windowMs({ amount: 1, unit: 'weeks' })).toBe(7 * D)
    expect(windowMs({ amount: 30, unit: 'minutes' })).toBe(30 * 60_000)
    expect(waitText(90_000)).toBe('2 minutes')
    expect(waitText(5 * H)).toBe('5 hours')
    expect(waitText(2 * D)).toBe('2 days')
    expect(waitText(21 * D)).toBe('3 weeks')
  })

  it('slides: full until the oldest counted event leaves the window', () => {
    const now = 10 * D
    expect(checkWindow([now - 3 * H, now - 2 * H], 3, D, now)).toEqual({ ok: true })
    const full = checkWindow([now - 3 * H, now - 2 * H, now - 1 * H], 3, D, now)
    expect(full).toEqual({ ok: false, retryMs: 21 * H })
    // an event older than the window does not count
    expect(checkWindow([now - 25 * H, now - 2 * H, now - 1 * H], 3, D, now)).toEqual({ ok: true })
    expect(checkWindow([], 0, H, now)).toEqual({ ok: false, retryMs: H })
  })
})

describe('addresses and trusted proxies', () => {
  it('normalises and finds the subnet', () => {
    expect(normalizeIp('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(subnetOf('203.0.113.9')).toBe('203.0.113.0/24')
    expect(subnetOf('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2:0:0:0:0/64')
    expect(subnetOf('nonsense')).toBe('')
  })

  const trust = { trusted: parseCidrList('127.0.0.1/32, ::1/128').ranges, header: 'x-forwarded-for' as const }

  it('ignores forwarding headers from an untrusted peer (spoofing)', () => {
    expect(resolveClientIp('198.51.100.7', { 'x-forwarded-for': '1.2.3.4' }, trust)).toBe('198.51.100.7')
    expect(resolveClientIp('198.51.100.7', { 'cf-connecting-ip': '1.2.3.4' }, { ...trust, header: 'cf-connecting-ip' })).toBe('198.51.100.7')
    // TRUST_PROXY off: never read
    expect(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }, null)).toBe('127.0.0.1')
  })

  it('takes the nearest untrusted hop from a trusted proxy, not a value the client put first', () => {
    expect(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' }, trust)).toBe('203.0.113.5')
    // the client sent "X-Forwarded-For: 6.6.6.6"; the proxy appended the real address
    expect(resolveClientIp('::ffff:127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.5' }, trust)).toBe('203.0.113.5')
    expect(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '203.0.113.5, 127.0.0.1' }, trust)).toBe('203.0.113.5')
    expect(resolveClientIp('127.0.0.1', { 'x-forwarded-for': 'garbage' }, trust)).toBe('127.0.0.1')
    expect(resolveClientIp('127.0.0.1', { 'cf-connecting-ip': '203.0.113.8' }, { ...trust, header: 'cf-connecting-ip' })).toBe('203.0.113.8')
  })
})

describe('VPN / hosting lists', () => {
  it('matches CIDRs and ranges, both families', () => {
    const l = parseHostingFile('# c\n198.51.100.0/24\tTestHost\n203.0.113.10-203.0.113.20\tOther\n2001:db8::/32\tV6Host\n')
    expect(l.match('198.51.100.200')).toBe('TestHost')
    expect(l.match('203.0.113.15')).toBe('Other')
    expect(l.match('203.0.113.21')).toBeNull()
    expect(l.match('2001:db8:ffff::1')).toBe('V6Host')
    expect(l.match('8.8.8.8')).toBeNull()
    expect(parseTorFile('185.220.101.1\n').match('185.220.101.1')).toBe('Tor exit')
  })

  it('the bundled list knows a cloud address', () => {
    const l = parseHostingFile(readFileSync(join(REPO_ROOT, 'content/antialt/hosting-ranges.txt'), 'utf8'))
    expect(l.size).toBeGreaterThan(1000)
    expect(l.match('3.0.0.1')).not.toBeNull() // AWS
    expect(l.match('192.168.1.1')).toBeNull()
  })
})

describe('the guard', () => {
  let dir: string
  let store: ReturnType<typeof openStore>
  let aa: AntiAlt
  let logs: string[]
  const lists = (): Lists => ({ hosting: parseHostingFile('198.51.100.0/24\tTestHost\n'), tor: new RangeList([]) })
  const make = (registerPerHour = 10) => new AntiAlt(store.db, { lists: lists(), log: (m) => logs.push(m), registerPerHour })
  const set = (edit: (p: AntiAltPolicy) => void) => {
    const p = aa.policy()
    p.exemptLoopback = false
    edit(p)
    const r = aa.setPolicy(p)
    if ('problem' in r) throw new Error(r.problem)
  }
  let n = 0
  /** A whole registration: the check, then (when it passes) an account and the confirmation. */
  const register = async (a: Attempt, now: number): Promise<Refusal | number> => {
    const v = await aa.checkRegister(a, now)
    if (!('ticket' in v)) return v
    const id = store.createAccount(`user${++n}`, 'x', now)!
    aa.confirmRegister(v.ticket, id)
    return id
  }
  const DEV = 'device-aaaaaaaaaaaaaaaa'
  const FP = 'a'.repeat(64)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antialt-'))
    store = openStore(dir)
    openAdminStore(store)
    logs = []
    aa = make()
    // only the limit under test
    set((p) => {
      for (const l of [p.account.perIp, p.account.perSubnet, p.account.perDevice, p.character.perAccount, p.character.perDevice, p.character.perIp]) l.on = false
      p.account.deviceLifetime.on = false
    })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('moves the old "Registrations per IP per hour" into the per-IP limit once', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'antialt-old-'))
    const s2 = openStore(d2)
    const admin = openAdminStore(s2)
    admin.setSetting('registerPerHour', 7, 'test')
    const g = new AntiAlt(s2.db, { lists: lists(), log: () => {}, registerPerHour: 10 })
    expect(g.policy().account.perIp).toEqual({ on: true, count: 7, amount: 1, unit: 'hours' })
    expect(admin.settings().has('registerPerHour')).toBe(false)
    s2.close()
    rmSync(d2, { recursive: true, force: true })
  })

  it('accounts per IP per window, with a player message', async () => {
    set((p) => (p.account.perIp = { on: true, count: 2, amount: 1, unit: 'days' }))
    const t = 100 * D
    expect(typeof (await register({ ip: '203.0.113.5' }, t))).toBe('number')
    expect(typeof (await register({ ip: '203.0.113.5' }, t + H))).toBe('number')
    const r = (await register({ ip: '203.0.113.5' }, t + 2 * H)) as Refusal
    expect(r.status).toBe(429)
    expect(r.message).toBe('Too many accounts were made from your address. Try again in 22 hours.')
    expect(typeof (await register({ ip: '203.0.113.6' }, t + 2 * H))).toBe('number')
    expect(typeof (await register({ ip: '203.0.113.5' }, t + D + 1))).toBe('number')
    expect(aa.logRows()[0]).toMatchObject({ outcome: 'blocked', reason: 'account.perIp', ip: '203.0.113.5', subnet: '203.0.113.0/24' })
  })

  it('accounts per subnet', async () => {
    set((p) => (p.account.perSubnet = { on: true, count: 2, amount: 2, unit: 'days' }))
    const t = 100 * D
    await register({ ip: '203.0.113.1' }, t)
    await register({ ip: '203.0.113.2' }, t)
    const r = (await register({ ip: '203.0.113.3' }, t)) as Refusal
    expect(r.message).toBe('Too many accounts from this network, try again in 2 days.')
    expect(typeof (await register({ ip: '203.0.114.3' }, t))).toBe('number')
  })

  it('accounts per device, the lifetime cap, and the fingerprint as a soft signal', async () => {
    set((p) => (p.account.perDevice = { on: true, count: 1, amount: 1, unit: 'weeks' }))
    const t = 100 * D
    await register({ ip: '203.0.113.1', device: DEV, fp: FP }, t)
    expect(((await register({ ip: '198.18.0.1', device: DEV }, t)) as Refusal).reason).toBe('account.perDevice')
    // a cleared device ID with the same fingerprint from the same subnet counts as the same device ...
    expect(((await register({ ip: '203.0.113.2', device: 'other-device-bbbbbbbbbb', fp: FP }, t)) as Refusal).reason).toBe('account.perDevice')
    // ... but the fingerprint alone (another network) never blocks
    expect(typeof (await register({ ip: '192.0.2.1', device: 'third-device-cccccccccc', fp: FP }, t))).toBe('number')
    set((p) => {
      p.account.perDevice.on = false
      p.account.deviceLifetime = { on: true, count: 2 }
    })
    await register({ ip: '192.0.2.50', device: DEV }, t + 30 * D)
    expect(((await register({ ip: '192.0.2.51', device: DEV }, t + 300 * D)) as Refusal).reason).toBe('account.deviceLifetime')
    // only hashes are stored
    const devices = store.db.prepare('SELECT DISTINCT device FROM antialt_events').all() as { device: string }[]
    expect(devices.every((d) => !d.device.includes('device'))).toBe(true)
  })

  it('a failed registration gives its slot back', async () => {
    set((p) => (p.account.perIp = { on: true, count: 1, amount: 1, unit: 'hours' }))
    const v = await aa.checkRegister({ ip: '203.0.113.9' }, 1000)
    if (!('ticket' in v)) throw new Error('refused')
    expect('ticket' in (await aa.checkRegister({ ip: '203.0.113.9' }, 1000))).toBe(false) // the reservation counts
    aa.cancelRegister(v.ticket)
    expect('ticket' in (await aa.checkRegister({ ip: '203.0.113.9' }, 1000))).toBe(true)
  })

  it('hosting detection: flag only, then block', async () => {
    expect(typeof (await register({ ip: '198.51.100.4' }, 1000))).toBe('number')
    expect(aa.logRows()[0]).toMatchObject({ outcome: 'flagged', reason: 'detect.hosting', detail: 'TestHost' })
    set((p) => (p.detect.hosting = 'block_register'))
    const r = (await register({ ip: '198.51.100.4' }, 2000)) as Refusal
    expect(r).toMatchObject({ status: 403, reason: 'detect.hosting' })
    // block_register does not block login
    expect(await aa.checkLogin(1, { ip: '198.51.100.4' })).toBeNull()
    set((p) => (p.detect.hosting = 'block_login'))
    expect((await aa.checkLogin(1, { ip: '198.51.100.4' }))?.reason).toBe('detect.hosting')
  })

  it('the allowlist skips limits and detection; lift waives the counted events', async () => {
    set((p) => {
      p.account.perIp = { on: true, count: 1, amount: 1, unit: 'days' }
      p.detect.hosting = 'block_register'
    })
    await register({ ip: '203.0.113.5' }, 1000)
    const blocked = (await register({ ip: '203.0.113.5' }, 2000)) as Refusal
    expect(blocked.status).toBe(429)
    const row = aa.logRows()[0]
    expect(aa.lift(row.id, 'gm')).toMatchObject({ message: expect.stringContaining('no longer count') })
    expect(typeof (await register({ ip: '203.0.113.5' }, 3000))).toBe('number')
    expect(((await register({ ip: '198.51.100.9' }, 3000)) as Refusal).status).toBe(403)
    expect('row' in aa.addAllow('subnet', '198.51.100.0/24', 'our office', 'gm')).toBe(true)
    expect(typeof (await register({ ip: '198.51.100.9' }, 4000))).toBe('number')
    expect(typeof (await register({ ip: '198.51.100.9' }, 4000))).toBe('number') // the per-IP limit is skipped too
    expect(aa.addAllow('device', 'not-a-hash', '', 'gm')).toEqual({ problem: expect.any(String) })
  })

  it('character limits count deleted characters unless told not to', async () => {
    set((p) => (p.character.perAccount = { on: true, count: 2, amount: 1, unit: 'days' }))
    const acc = (await register({ ip: '203.0.113.5', device: DEV }, Date.now())) as number
    const mk = (name: string) => {
      const r = store.createCharacter(acc, name, 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 4)
      if (typeof r === 'string') throw new Error(r)
      aa.recordCharacter(acc, r.id, '203.0.113.5')
      return r.id
    }
    expect(aa.checkCharacter(acc, '203.0.113.5')).toBeNull()
    const a = mk('Alpha')
    mk('Bravo')
    expect(store.softDeleteCharacter(a, acc)).toBe(true)
    const r = aa.checkCharacter(acc, '203.0.113.5')
    expect(r?.reason).toBe('character.perAccount')
    expect(r?.message).toMatch(/^You can create 2 characters per 1 day\. Try again in \d+ hours\.$/)
    set((p) => (p.character.countDeleted = false))
    expect(aa.checkCharacter(acc, '203.0.113.5')).toBeNull()
    // per device: the device of the account's latest login
    set((p) => {
      p.character.perAccount.on = false
      p.character.perDevice = { on: true, count: 1, amount: 1, unit: 'hours' }
    })
    const other = (await register({ ip: '192.0.2.7', device: DEV }, Date.now())) as number
    expect(aa.checkCharacter(other, '192.0.2.7')?.reason).toBe('character.perDevice')
  })

  it('linked accounts share a device, IP, subnet or fingerprint', async () => {
    const a = (await register({ ip: '203.0.113.5', device: DEV, fp: FP }, 1000)) as number
    const b = (await register({ ip: '192.0.2.1', device: DEV }, 1000)) as number
    const c = (await register({ ip: '203.0.113.77' }, 1000)) as number
    await register({ ip: '8.8.8.8' }, 1000)
    const l = aa.linked(a)
    expect(l.map((r) => r.account_id)).toEqual([b, c])
    expect(l[0]).toMatchObject({ device: 1, ip: 0 })
    expect(l[1]).toMatchObject({ device: 0, subnet: 1 })
  })

  it('exempts this machine and checks the policy', async () => {
    set((p) => (p.account.perIp = { on: true, count: 0, amount: 1, unit: 'hours' }))
    expect(((await register({ ip: '127.0.0.1' }, 1000)) as Refusal).status).toBe(429)
    set((p) => (p.exemptLoopback = true))
    aa.setPolicy({ ...aa.policy(), exemptLoopback: true })
    expect(typeof (await register({ ip: '127.0.0.1' }, 1000))).toBe('number')
    expect(checkPolicy({ ...defaultPolicy(), extra: 1 })).toEqual({ problem: expect.stringContaining('unknown field extra') })
    expect(checkPolicy({ ...defaultPolicy(), account: { ...defaultPolicy().account, perIp: { on: true, count: 1, amount: 1, unit: 'years' } } })).toEqual({ problem: expect.stringContaining('unit') })
  })
})
