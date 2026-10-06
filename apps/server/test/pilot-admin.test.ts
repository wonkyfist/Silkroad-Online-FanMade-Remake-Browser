/**
 * Play the Boss in the admin panel, layer 4 (docs/PLAY_THE_BOSS.md §6): the settings store (defaults ⊕ a sparse patch,
 * the bounds and the cross-field rules as 422 with their issues, a stale rev 409, a per-field reset, applied at once,
 * kept across a reload, bad stored values dropped), the routes Start / Pick / Stop, the event detail with its volunteers
 * in draw order, the blocks, the eligibility check, the schedule in the GET, and the role on every endpoint.
 */
import { PILOT_BOUNDS, mergePilotPatch, type AdminBossView, type PilotBlockView, type PilotEligibilityView, type PilotSettingsPatch, type PilotVolunteerView } from '@sro/shared'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, migrate, openStore } from '../src/db.ts'
import type { GameContext } from '../src/game.ts'
import { routeAdminBoss } from '../src/pilot/admin.ts'
import { loadPatch } from '../src/pilot/settings.ts'
import { PilotStore } from '../src/pilot/store.ts'
import { TG, pilotHarness, type PilotHarness } from './pilot-harness.ts'

let H: PilotHarness | null = null
afterEach(() => {
  H?.cleanup()
  H = null
})

const MIN = 60_000
const DAY = 24 * 60 * MIN

function setup(patch: PilotSettingsPatch = {}) {
  H = pilotHarness({ file: (f) => void (f.uniques[0].pilot!.defaults = mergePilotPatch(mergePilotPatch(f.uniques[0].pilot!.defaults, { eligibility: { minPlayHours: 0 } }), patch)) })
  const pc = H.player(150, 150, 'Pixi')
  const s = H
  const ctx = { gameplay: s.g, world: s.h.world, data: s.h.data, store: s.h.store, config: s.h.config } as unknown as GameContext
  const actor = { accountId: s.h.store.characterById(pc.p.characterId)!.account_id, role: 'admin' as const, username: 'root' }
  const call = async <T = Record<string, unknown>>(method: string, sub: string, body?: unknown, query = '', role: 'admin' | 'gm' | 'player' = 'admin') => {
    const r = await routeAdminBoss(ctx, { method, path: `/api/admin/boss${sub}`, query: new URLSearchParams(query), body, actor: { ...actor, role } })
    return r as { status: number; body: T }
  }
  return { ...s, pc, call, actor }
}

describe('settings (§6.1, §6.2)', () => {
  it('GET: the defaults, the stored patch, the effective numbers, the rev, the bounds, the level cap', async () => {
    const s = setup()
    const v = (await s.call<AdminBossView>('GET', '')).body
    expect(v.settings).toMatchObject({ rev: 0, patch: {}, bounds: PILOT_BOUNDS, levelCap: s.h.config.levelCap })
    expect(v.settings.defaults.win).toEqual({ surviveMin: 15, downsTarget: 15, downMinLevel: 15, downMinDamage: 200 })
    expect(v.settings.effective).toEqual(v.settings.defaults)
    expect(v.features).toEqual(expect.arrayContaining(['pick', 'stop', 'call', 'schedule', 'settings', 'blocks', 'eligibility', 'scaling']))
  })

  it('PUT: applied at once and stored; only what differs from the defaults is kept; a stale rev 409', async () => {
    const s = setup()
    const r = await s.call<{ effective: AdminBossView['settings']['effective']; patch: PilotSettingsPatch; rev: number }>('PUT', '/settings', { baseRev: 0, patch: { win: { downsTarget: 10, surviveMin: 15 }, call: { minutes: 5 }, enabled: true } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.rev).toBe(1)
    expect(r.body.patch).toEqual({ win: { downsTarget: 10 }, call: { minutes: 5 }, enabled: true })
    expect(r.body.effective.win).toMatchObject({ downsTarget: 10, surviveMin: 15 })
    const conf = s.pilot.conf('')
    if (typeof conf === 'string') throw new Error(conf)
    expect(conf.settings.win.downsTarget).toBe(10)
    expect(s.pilot.store.settingsOf(TG)).toMatchObject({ rev: 1, updated_by: s.actor.accountId })
    // A GM start uses the new call length.
    expect(s.gm('start').ok).toBe(true)
    expect(s.pilot.event!.callEndsAt).toBe(s.h.now + 5 * MIN)
    expect(s.gm('stop').ok).toBe(true)
    // A save from a stale page.
    const stale = await s.call('PUT', '/settings', { baseRev: 0, patch: { win: { downsTarget: 12 } } })
    expect(stale.status).toBe(409)
    expect(conf.settings.win.downsTarget).toBe(10)
    // A second save merges into the patch (the slots as a whole).
    const r2 = await s.call<{ patch: PilotSettingsPatch; rev: number }>('PUT', '/settings', { baseRev: 1, patch: { schedule: { slots: [{ weekday: 5, time: '20:30' }, { weekday: 6, time: '21:00' }] } } })
    expect(r2.status).toBe(200)
    expect(r2.body.patch).toEqual({ win: { downsTarget: 10 }, call: { minutes: 5 }, enabled: true, schedule: { slots: [{ weekday: 5, time: '20:30' }, { weekday: 6, time: '21:00' }] } })
    // A reload (a new conf over the same database) reads the stored patch.
    expect(loadPatch(s.pilot.store, conf, s.h.config.levelCap, () => {})).toEqual({ patch: r2.body.patch, rev: 2 })
  })

  it('422 with the issues: out of bounds, unknown fields, bad slots, an unknown zone, past the level cap, a cap under the base', async () => {
    const s = setup()
    const bad = async (patch: unknown) => {
      const r = await s.call<{ issues: { path: string; message: string }[] }>('PUT', '/settings', { baseRev: 0, patch })
      expect(r.status, JSON.stringify(patch)).toBe(422)
      return r.body.issues.map((i) => i.path)
    }
    expect(await bad({ hunt: { radiusM: 50 } })).toEqual(['hunt.radiusM'])
    expect(await bad({ call: { minutes: 0, acceptSec: 121, maxDraws: 21 } })).toEqual(['call.minutes', 'call.acceptSec', 'call.maxDraws'])
    expect(await bad({ win: { surviveMin: 2, downsTarget: 201 } })).toEqual(['win.surviveMin', 'win.downsTarget'])
    expect(await bad({ win: { nope: 1 } })).toEqual(['win.nope'])
    expect(await bad({ schedule: { slots: [{ weekday: 7, time: '21:00' }, { weekday: 1, time: '25:00' }] } })).toEqual(['schedule.slots[0]', 'schedule.slots[1]'])
    expect(await bad({ schedule: { tz: 'Mars/Olympus_Mons' } })).toEqual(['schedule.tz'])
    expect(await bad({ eligibility: { minLevel: s.h.config.levelCap + 1 } })).toEqual(['eligibility.minLevel'])
    expect(await bad({ scaling: { baseHunters: 10, capHunters: 8 } })).toEqual(['scaling.capHunters'])
    expect(await bad({ rewards: { title: 'Not A Code' } })).toEqual(['rewards.title'])
    expect((await s.call('PUT', '/settings', { patch: {} })).status).toBe(400)
    expect(s.pilot.store.settingsOf(TG)).toBeUndefined()
    // A zone the runtime knows is fine.
    expect((await s.call('PUT', '/settings', { baseRev: 0, patch: { schedule: { tz: 'Europe/Berlin' } } })).status).toBe(200)
  })

  it('reset: one field, a group, or everything back to the defaults', async () => {
    const s = setup()
    await s.call('PUT', '/settings', { baseRev: 0, patch: { win: { downsTarget: 10, surviveMin: 20 }, hunt: { radiusM: 400 }, enabled: true } })
    const one = await s.call<{ patch: PilotSettingsPatch; rev: number }>('POST', '/settings/reset', { paths: ['win.downsTarget'] })
    expect(one.body).toMatchObject({ rev: 2, patch: { win: { surviveMin: 20 }, hunt: { radiusM: 400 }, enabled: true } })
    const group = await s.call<{ patch: PilotSettingsPatch }>('POST', '/settings/reset', { paths: ['hunt', 'enabled'] })
    expect(group.body.patch).toEqual({ win: { surviveMin: 20 } })
    expect((await s.call('POST', '/settings/reset', { paths: ['win.nope'] })).status).toBe(422)
    expect((await s.call('POST', '/settings/reset', { baseRev: 1 })).status).toBe(409)
    const all = await s.call<{ patch: PilotSettingsPatch; rev: number }>('POST', '/settings/reset', {})
    expect(all.body).toMatchObject({ patch: {}, rev: 4 })
  })

  it('a stored value now out of bounds (a hand edit, tighter bounds) is dropped at load, the rest kept', () => {
    const s = setup()
    s.pilot.store.saveSettings(TG, JSON.stringify({ win: { downsTarget: 9999, surviveMin: 20 } }), 3, s.h.now, null)
    const logs: string[] = []
    const conf = s.pilot.conf('')
    if (typeof conf === 'string') throw new Error(conf)
    expect(loadPatch(s.pilot.store, conf, s.h.config.levelCap, (l) => logs.push(l))).toEqual({ patch: { win: { surviveMin: 20 } }, rev: 3 })
    expect(logs[0]).toMatch(/win.downsTarget/)
  })
})

describe('the routes (§6.3)', () => {
  it('Start / Pick / Stop; GET shows the call, the offer, the hunt; 409 while one runs', async () => {
    const s = setup()
    const a = s.player(10, 10, 'Alpha')
    expect((await s.call('POST', '/start', { callMinutes: 0 })).status).toBe(400)
    expect((await s.call('POST', '/start', { callMinutes: 61 })).status).toBe(400)
    const st = await s.call<{ event: { id: number; phase: string; callEndsAt: number } }>('POST', '/start', { callMinutes: 3 })
    expect(st.status).toBe(200)
    expect(st.body.event).toMatchObject({ phase: 'call', callEndsAt: s.h.now + 3 * MIN })
    expect((await s.call('POST', '/start', {})).status).toBe(409)
    s.req(a.p, { t: 'pilotVolunteer', on: true })
    const v = (await s.call<AdminBossView>('GET', '')).body
    expect(v.current).toMatchObject({ phase: 'call', origin: 'admin', volunteers: 1, callEndsAt: s.h.now + 3 * MIN })
    // Pick closes the call.
    expect((await s.call('POST', '/pick', { character: 'Pixi' })).status).toBe(200)
    expect((await s.call<AdminBossView>('GET', '')).body.current).toMatchObject({ phase: 'offer', pilotName: 'Pixi', origin: 'admin' })
    expect((await s.call('POST', '/pick', { character: 'Alpha' })).status).toBe(409)
    s.req(s.pc.p, { t: 'pilotAnswer', event: st.body.event.id, accept: true })
    const hunt = (await s.call<AdminBossView>('GET', '')).body.current!
    expect(hunt).toMatchObject({ phase: 'hunt', pilotName: 'Pixi', steering: 'player', maxHp: 47_898, scaleHunters: 0 })
    expect((await s.call('POST', '/stop', { reason: 'test' })).status).toBe(200)
    expect((await s.call('POST', '/stop', {})).status).toBe(409)
    // The trail: every write is in gm_audit (command pilot).
    const audit = s.h.store.db.prepare("SELECT args FROM gm_audit WHERE command = 'pilot' ORDER BY id").all() as { args: string }[]
    expect(audit.map((r) => JSON.parse(r.args)[0])).toEqual(['start', 'start', 'pick', 'pick', 'stop', 'stop'])
  })

  it('an event in detail: the timeline and the volunteers in draw order', async () => {
    const s = setup()
    const a = s.player(10, 10, 'Alpha')
    const b = s.player(12, 10, 'Bravo')
    const c = s.player(14, 10, 'Charlie')
    expect((await s.call('POST', '/start', {})).status).toBe(200)
    const id = s.pilot.event!.id
    for (const x of [a, b, c]) s.req(x.p, { t: 'pilotVolunteer', on: true })
    s.h.now = s.pilot.event!.callEndsAt - 50
    s.tick(50)
    const order: string[] = []
    for (let i = 0; i < 2; i++) {
      const o = [a, b, c].find((x) => s.h.all(x.inbox, 'pilotOffer').length > 0 && !order.includes(x.p.name))!
      order.push(o.p.name)
      s.req(o.p, { t: 'pilotAnswer', event: id, accept: false })
    }
    const d = await s.call<{ volunteers: PilotVolunteerView[]; log: { kind: string }[] }>('GET', `/events/${id}`)
    expect(d.status).toBe(200)
    expect(d.body.volunteers.map((v) => v.name).slice(0, 2)).toEqual(order)
    expect(d.body.volunteers.map((v) => v.draw)).toEqual(['declined', 'declined', 'offered'])
    expect(d.body.log.map((l) => l.kind)).toContain('draw')
    expect((await s.call('GET', '/events/999999')).status).toBe(404)
  })

  it('blocks: PUT / GET / DELETE by character name, account name or #id; bad days 400; unknown 404', async () => {
    const s = setup()
    const acc = s.h.store.characterById(s.pc.p.characterId)!.account_id
    const put = await s.call<{ blocks: PilotBlockView[] }>('PUT', '/blocks/Pixi', { days: 7, reason: 'feeding downs' })
    expect(put.status).toBe(200)
    expect(put.body.blocks).toEqual([{ account: acc, username: expect.any(String), characters: ['Pixi'], until: s.h.now + 7 * DAY, reason: 'feeding downs', by: s.actor.accountId, byName: expect.any(String), at: s.h.now }])
    expect((await s.call<{ blocks: PilotBlockView[] }>('GET', '/blocks')).body.blocks).toHaveLength(1)
    expect((await s.call('PUT', `/blocks/%23${acc}`, { days: 1 })).status).toBe(200)
    expect(s.pilot.store.blockOf(acc)!.until).toBe(s.h.now + DAY)
    expect((await s.call('PUT', '/blocks/Pixi', { days: 0 })).status).toBe(400)
    expect((await s.call('PUT', '/blocks/Pixi', { days: 'x' })).status).toBe(400)
    expect((await s.call('PUT', '/blocks/Nobody', { days: 1 })).status).toBe(404)
    const del = await s.call<{ blocks: PilotBlockView[] }>('DELETE', '/blocks/Pixi')
    expect(del.status).toBe(200)
    expect(del.body.blocks).toEqual([])
    expect((await s.call('DELETE', '/blocks/Pixi')).status).toBe(404)
  })

  it('eligibility: the reasons for a name, online or not; the weight; unknown 404', async () => {
    const s = setup({ eligibility: { minPlayHours: 10 } })
    const e = await s.call<PilotEligibilityView>('GET', '/eligibility', undefined, 'character=Pixi')
    expect(e.body).toMatchObject({ character: 'Pixi', online: true, level: 20, eligible: false, why: 'playtime', playedHours: 0, lastTurnAt: null, blockedUntil: null, weight: 3 })
    s.h.store.db.prepare('UPDATE characters SET played_ms = ? WHERE id = ?').run(12 * 3_600_000, s.pc.p.characterId)
    expect((await s.call<PilotEligibilityView>('GET', '/eligibility', undefined, 'character=pixi')).body).toMatchObject({ eligible: true, playedHours: 12 })
    expect((await s.call('GET', '/eligibility', undefined, 'character=Nobody')).status).toBe(404)
    expect((await s.call('GET', '/eligibility', undefined, 'character=')).status).toBe(400)
  })

  it('the schedule in the GET: the zone it uses, on/off, the next night and its call', async () => {
    const s = setup({ enabled: true, schedule: { slots: [{ weekday: 4, time: '00:30' }], tz: 'UTC' } })
    s.tick(50)
    const v = (await s.call<AdminBossView>('GET', '')).body
    expect(v.schedule).toEqual({ tz: 'UTC', enabled: true, nextCallAt: 20 * MIN })
    expect(v.nextNight).toBe(30 * MIN)
    const off = await s.call<{ rev: number }>('PUT', '/settings', { baseRev: 0, patch: { enabled: false } })
    expect(off.status).toBe(200)
    s.tick(50)
    expect((await s.call<AdminBossView>('GET', '')).body).toMatchObject({ nextNight: null, schedule: { enabled: false, nextCallAt: null } })
  })

  it('every endpoint needs the admin role (403 for a GM or a player), whatever the body', async () => {
    const s = setup()
    const routes: [string, string, unknown?, string?][] = [
      ['GET', ''], ['PUT', '/settings', { baseRev: 0, patch: { enabled: true } }], ['POST', '/settings/reset', {}], ['POST', '/start', {}], ['POST', '/pick', { character: 'Pixi' }],
      ['POST', '/stop', {}], ['GET', '/events'], ['GET', '/events/1'], ['GET', '/blocks'], ['PUT', '/blocks/Pixi', { days: 1 }], ['DELETE', '/blocks/Pixi'],
      ['GET', '/eligibility', undefined, 'character=Pixi'],
    ]
    for (const role of ['gm', 'player'] as const) {
      for (const [m, p, b, q] of routes) expect((await s.call(m, p, b, q ?? '', role)).status, `${role} ${m} ${p}`).toBe(403)
    }
    expect(s.pilot.event).toBeNull()
    expect(s.pilot.store.settingsOf(TG)).toBeUndefined()
    expect(s.pilot.store.blocks()).toEqual([])
  })
})

describe('migration 14 (§5.4: settings, volunteers, blocks)', () => {
  const cols = (db: Database.Database, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number; pk: number }[]).map((c) => [c.name, c.notnull, c.pk])

  it('applies on a 13-version database, keeps its events, and the new tables take their rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-migrate-pilot4-'))
    try {
      const v13 = new Database(join(root, 'game.db'))
      expect(migrate(v13, 13)).toBe(13)
      v13.exec(`INSERT INTO pilot_events (id, code, origin, phase, created_at, pilot_account, hunt_started_at, outcome) VALUES (7, 'MOB_CH_TIGERWOMAN', 'gm', 'ended', 1, 3, 2, 'survived');`)
      expect(() => v13.prepare('SELECT * FROM pilot_settings').all()).toThrow()
      v13.close()
      const store = openStore(root)
      try {
        expect(SCHEMA_VERSION).toBe(18)
        expect(store.schemaVersion).toBe(18)
        expect(cols(store.db, 'pilot_settings')).toEqual([['code', 0, 1], ['json', 1, 0], ['rev', 1, 0], ['updated_at', 1, 0], ['updated_by', 0, 0]])
        expect(cols(store.db, 'pilot_volunteers')).toEqual([['event_id', 1, 1], ['account_id', 1, 2], ['character_id', 1, 0], ['at', 1, 0], ['draw', 0, 0]])
        expect(cols(store.db, 'pilot_blocks')).toEqual([['account_id', 0, 1], ['until', 1, 0], ['reason', 1, 0], ['by_account', 0, 0], ['at', 1, 0]])
        const ps = new PilotStore(store.db)
        expect(ps.get(7)).toMatchObject({ outcome: 'survived', pilot_account: 3 })
        expect(ps.lastTurnAt(3)).toBe(2)
        expect(ps.volunteer(7, 3, 30, 5)).toBe('added')
        expect(ps.volunteer(7, 3, 30, 6)).toBe('same')
        expect(ps.volunteer(7, 3, 31, 6)).toBe('other')
        ps.block(3, 99, 'r', null, 5)
        expect(ps.blockOf(3)).toEqual({ account_id: 3, until: 99, reason: 'r', by_account: null, at: 5 })
        ps.saveSettings('MOB_CH_TIGERWOMAN', '{}', 1, 5, null)
        expect(ps.settingsOf('MOB_CH_TIGERWOMAN')).toMatchObject({ rev: 1, json: '{}' })
        // The volunteers leave with their event.
        store.db.pragma('foreign_keys = ON')
        store.db.prepare('DELETE FROM pilot_events WHERE id = 7').run()
        expect(ps.volunteers(7)).toEqual([])
      } finally {
        store.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
