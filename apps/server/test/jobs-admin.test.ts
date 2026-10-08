/**
 * The job system, layer 7 on the server (docs/JOBS.md §8, §9.5): the admin "Jobs & Trade" routes and the Silk Caravan.
 *
 * - admin routes: admin role only (a GM and a player get 403), GET adds the members' accounts, trades, robberies, open
 *   robbery warrants, job law flags and the event; member actions (level, revoke / restore for every job, the waits
 *   cleared), transports (heal, kill), robbery (confiscate, jail); every write is a gm_audit row;
 * - the Silk Caravan: off by default; settings (slots, tz, bounds); admin and GM start / stop / status; the
 *   announcement; the boosted post's demand, Trader EXP, the reward per completed run (capped), more ambushes, the den
 *   multiplier; the weekly slot starts it and it ends by itself; a siege or a Night of the Tiger delays then skips a
 *   slot, refuses a manual start and interrupts a running event; a restart resumes it.
 */
import {
  JOB_SETTINGS_DEFAULTS,
  checkJobSettings,
  fenceNpc,
  installSiegeHunterContent,
  installSiegeLawContent,
  tradeMargin,
  tradeSellTotal,
  traderSaleExp,
  type AdminEventInfo,
  type AdminJobsView,
  type NpcDef,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { adminEvents } from '../src/admin/routes.ts'
import type { GameContext } from '../src/game.ts'
import { GameData } from '../src/gamedata.ts'
import { addGold } from '../src/inventory.ts'
import { CaravanService } from '../src/jobs/caravan.ts'
import { routeAdminJobs } from '../src/jobs/jobs-admin.ts'
import type { KegWalls } from '../src/siege/keg.ts'
import type { Player } from '../src/world.ts'
import { mob } from './fixtures.ts'
import { SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const MIN = 60_000

let cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const WALLS: KegWalls = { on: true, walls: { segments: [], sides: [] }, settings: { maxIp: 20_000 }, stageOf: () => 'intact', change: () => null }
const JODAESAN: NpcDef = { code: 'NPC_CH_SPECIAL', name: 'Specialty Trader Jodaesan', x: 176, z: -48, yaw: 0, world: 'jangan', model: null, provenance: 'client' }
const SPOTS: Record<string, [number, number]> = { jangan: [0, 3], 'south-beach': [100, 420], 'tomb-camp': [420, -100], 'ferry-landing': [-420, 100], 'sea-cliffs': [-200, 420] }
const BANDIT = mob('MOB_CH_BANDIT', { name: 'Bandit', level: 16, hp: 800, physAttack: [3000, 3000], hitRate: 1000, aggressive: true, walkSpeed: 2, runSpeed: 6 })
const SILK = 'ITEM_ETC_TRADE_CH_01'
const S = JOB_SETTINGS_DEFAULTS

type Who = { p: Player; inbox: ServerMessage[] }

function harness() {
  const data = new GameData({ mobs: [BANDIT], items: [...SKILL_ITEMS], levels: SKILL_LEVELS, npcs: [JODAESAN], towns: [{ ...SAFE_TOWN, safeArea: { x: 0, z: 0, halfX: 80, halfZ: 80 } }] })
  installSiegeLawContent({ items: data.items, drops: data.drops, npcs: data.npcs }, 'jangan')
  installSiegeHunterContent({ items: data.items, shops: data.shops, npcs: data.npcs }, 'jangan')
  const h = skillHarness({ data, rng: () => 0.5, config: { uniques: false } })
  cleanups.push(h.cleanup)
  const g = h.gameplay
  g.kegs.configure({ walls: WALLS })
  g.jobs.configure({ content: { den: { ...g.jobs.content.den, x: -400, z: 300 }, posts: g.jobs.content.posts.map((p) => ({ ...p, x: SPOTS[p.id]![0], z: SPOTS[p.id]![1] })) } })
  const tick = (ms: number) => h.runTo(h.now + ms)
  const jod = g.placeNpc({ ...JODAESAN, x: 0, z: 3 }, h.now)!
  g.placeNpc({ ...fenceNpc('jangan'), x: -300, z: -200 }, h.now)
  const post: Record<string, ReturnType<typeof g.placeNpc> & object> = { jangan: jod }
  for (const p of g.jobs.content.posts) {
    if (p.id === 'jangan') continue
    const def = data.npcs.find((n) => n.code === p.npc.code)!
    post[p.id] = g.placeNpc({ ...def, x: p.x, z: p.z }, h.now)!
  }
  const char = (pos: Vec3, name: string): Who => {
    const r = h.hero({ pos, level: 20, name })
    r.p.maxHp = r.p.hp = 50_000
    const { draft } = h.store.inventoryTx(r.p.characterId, (d) => addGold(d, 1_000_000))
    g.afterInventory(r.p, draft)
    return r
  }
  const goldOf = (p: Player) => h.store.loadInventory(p.characterId).gold
  const req = (r: Who, msg: Parameters<typeof h.req>[1]) => {
    h.req(r.p, msg)
    return h.result(r.inbox, msg.t)
  }
  const warp = (r: Who, x: number, z: number) => h.world.warp(r.p, x, 0, z, h.now)
  const trader = (name: string, level = 1) => {
    const r = char([1, 0, 1], name)
    expect(g.jobs.gm([name, 'join', 'trader'], h.now).ok).toBe(true)
    if (level > 1) g.jobs.gm([name, 'level', String(level)], h.now)
    r.p.lastCombatAt = 0
    expect(req(r, { t: 'jobMode', on: true })).toMatchObject({ ok: true })
    return r
  }
  const summon = (r: Who) => {
    warp(r, 1, 2)
    r.p.lastCombatAt = 0
    return req(r, { t: 'tradeSummon', npc: jod.id, tier: 1 })
  }
  const tr = (r: Who) => g.transports.of(r.p.characterId)!
  const place = (r: Who, x: number, z: number) => {
    const t = tr(r)
    warp(r, x + 2, z)
    t.c.pos = [x, 0, z]
    t.c.move = null
    t.trail = []
    h.world.refreshAround(t.c, h.now)
    h.world.refreshAround(r.p, h.now)
  }
  const at = (r: Who, id: string) => {
    const n = post[id]!
    place(r, n.pos[0] + 3, n.pos[2] + 3)
    warp(r, n.pos[0] + 1, n.pos[2] + 1)
  }
  const buy = (r: Who, crates: number, dest = 'ferry-landing') => req(r, { t: 'tradeBuy', npc: jod.id, good: SILK, crates, dest: dest as 'ferry-landing' })
  const sell = (r: Who, where: string) => req(r, { t: 'tradeSell', npc: post[where]!.id })
  const ctx = { gameplay: g, world: h.world, data: h.data, store: h.store, config: h.config } as unknown as GameContext
  const call = async <T = Record<string, unknown>>(method: string, sub: string, body?: unknown, role: 'admin' | 'gm' | 'player' = 'admin') =>
    (await routeAdminJobs(ctx, { method, path: `/api/admin/jobs${sub}`, query: new URLSearchParams(''), body, actor: { accountId: 1, role, username: 'root' } })) as { status: number; body: T & { message?: string } }
  const audits = () => h.store.db.prepare("SELECT args, ok FROM gm_audit WHERE command = 'job'").all() as { args: string; ok: number }[]
  return { h, g, tick, char, goldOf, req, trader, summon, tr, place, at, buy, sell, call, ctx, audits, post }
}

/** A weekly slot `ahead` ms from `now`, in UTC. */
function slotAt(now: number, ahead: number): { weekday: number; time: string } {
  const d = new Date(now + ahead)
  return { weekday: d.getUTCDay(), time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` }
}

describe('admin routes (§9.5, layer 7)', () => {
  it('admin only: a GM or a player gets 403 on reads and writes', async () => {
    const x = harness()
    for (const role of ['gm', 'player'] as const) {
      expect((await x.call('GET', '', undefined, role)).status).toBe(403)
      expect((await x.call('POST', '/event/start', {}, role)).status).toBe(403)
      expect((await x.call('POST', '/member', { character: 'Nobody', resetWaits: true }, role)).status).toBe(403)
    }
    expect(x.g.caravan.running).toBeNull()
    expect((await x.call('GET', '/nope')).status).toBe(404)
  })

  it('GET lists members with accounts, trades, robberies, warrants, job flags and the event', async () => {
    const x = harness()
    const t = x.trader('Tess', 3)
    x.summon(t)
    x.buy(t, 10)
    x.g.law.store.flag({ at: x.h.now, wanted_character: t.p.characterId, wanted_account: 7, hunter_character: t.p.characterId, hunter_account: 8, rule: 'robbery_pair', withheld: 500 })
    x.g.law.store.flag({ at: x.h.now, wanted_character: t.p.characterId, wanted_account: 7, hunter_character: t.p.characterId, hunter_account: 8, rule: 'pair', withheld: 1 })
    const v = (await x.call<AdminJobsView>('GET', '')).body
    expect(v.members).toEqual([expect.objectContaining({ name: 'Tess', job: 'trader', level: 3 })])
    expect(v.memberInfo).toEqual([expect.objectContaining({ characterId: t.p.characterId, side: 'law', charLevel: 20 })])
    expect(v.memberInfo![0]!.account.length).toBeGreaterThan(0)
    expect(v.trades!.map((r) => r.kind)).toEqual(['buy', 'summon'])
    expect(v.trades![0]).toMatchObject({ name: 'Tess', good: SILK, crates: 10 })
    expect(v.robberies).toEqual([])
    expect(v.robbers).toEqual([])
    // only the job rules (the siege's capture rules stay on the Law tab)
    expect(v.flags).toEqual([expect.objectContaining({ rule: 'robbery_pair', withheld: 500, actorAccount: 8, victimAccount: 7 })])
    expect(v.event).toMatchObject({ enabled: false, running: null, nextAt: null, history: [] })
    expect(v.event!.posts.sort()).toEqual(['ferry-landing', 'sea-cliffs'])
    // the Events page lists the Silk Caravan with this route group
    const ev = adminEvents(x.ctx).find((e: AdminEventInfo) => e.id === 'silk-caravan')
    expect(ev).toMatchObject({ routes: 'jobs', state: 'idle', nextAt: null })
  })

  it('member actions: level, revoke and restore a Trader (the suit comes off and stays off), clear the waits; a Hunter through the siege', async () => {
    const x = harness()
    const t = x.trader('Tess')
    expect((await x.call('POST', '/member', { character: 'Tess', level: 5 })).status).toBe(200)
    expect(x.g.jobs.levelOf(t.p.characterId)).toBe(5)
    expect((await x.call('POST', '/member', { character: 'Tess', level: 5, revoke: 3 })).status).toBe(400)
    expect((await x.call('POST', '/member', { character: 'Tess', revoke: -1 })).status).toBe(400)
    const r = await x.call('POST', '/member', { character: t.p.characterId, revoke: 3 })
    expect(r.status).toBe(200)
    expect(r.body.message).toMatch(/revoked until/)
    expect(x.g.jobs.inMode(t.p.characterId)).toBe(false)
    t.p.lastCombatAt = 0
    expect(x.req(t, { t: 'jobMode', on: true })).toMatchObject({ ok: false, message: expect.stringMatching(/revoked/) })
    let v = (await x.call<AdminJobsView>('GET', '')).body
    expect(v.members[0]!.revokedUntil).toBeGreaterThan(x.h.now)
    expect((await x.call('POST', '/member', { character: 'Tess', restore: true })).status).toBe(200)
    expect(x.req(t, { t: 'jobMode', on: true })).toMatchObject({ ok: true })
    // waits: leave sets the account's wait; resetWaits clears it
    x.g.jobs.gm(['Tess', 'mode', 'off'], x.h.now)
    expect((await x.call('POST', '/member', { character: 'Tess', leave: true })).status).toBe(200)
    x.g.jobs.store.putAccount({ ...x.g.jobs.store.account(x.h.store.characterById(t.p.characterId)!.account_id)!, left_at: x.h.now })
    expect((await x.call('POST', '/member', { character: 'Tess', resetWaits: true })).status).toBe(200)
    v = (await x.call<AdminJobsView>('GET', '')).body
    expect(v.accounts[0]).toMatchObject({ leftAt: null, sideChangedAt: 0 })
    // a Bounty Hunter: the siege's revoke
    const hb = x.char([2, 0, 2], 'Hank')
    x.g.jobs.gm(['Hank', 'join', 'hunter'], x.h.now)
    expect((await x.call('POST', '/member', { character: 'Hank', revoke: 1 })).body.message).toMatch(/Bounty Hunter licence is revoked/)
    expect(x.g.hunters.licensed(hb.p.characterId, x.h.now)).toBe(false)
    expect((await x.call('POST', '/member', { character: 'Hank', restore: true })).status).toBe(200)
    expect(x.g.hunters.licensed(hb.p.characterId, x.h.now)).toBe(true)
    expect((await x.call('POST', '/member', { character: 'Nobody', restore: true })).status).toBe(400)
    const a = x.audits().map((r) => r.args)
    expect(a.some((s) => s.includes('revoke'))).toBe(true)
    expect(a.some((s) => s.includes('reset-waits'))).toBe(true)
    expect(a.some((s) => s.includes('restore'))).toBe(true)
  })

  it('transport heal / kill and robbery confiscate / jail through the routes; bad actions refused', async () => {
    const x = harness()
    const t = x.trader('Tess')
    x.summon(t)
    x.buy(t, 10)
    x.tr(t).c.hp = 100
    expect((await x.call('POST', '/transport', { character: 'Tess', action: 'heal' })).status).toBe(200)
    expect(x.tr(t).c.hp).toBe(x.tr(t).c.maxHp)
    expect((await x.call('POST', '/transport', { character: 'Tess', action: 'explode' })).status).toBe(400)
    expect((await x.call('POST', '/transport', { character: 'Tess', action: 'kill' })).status).toBe(200)
    expect(x.g.transports.of(t.p.characterId)).toBeFalsy()
    const th = x.char([300, 0, 300], 'Thea')
    x.g.jobs.gm(['Thea', 'join', 'thief'], x.h.now)
    x.g.robbery.gm(['Thea', 'give', SILK, '5', 'stolen'], x.h.now)
    let v = (await x.call<AdminJobsView>('GET', '')).body
    expect(v.robbers).toEqual([expect.objectContaining({ name: 'Thea' })])
    expect(v.sacks).toEqual([expect.objectContaining({ name: 'Thea', kind: 'stolen', crates: 5 })])
    expect((await x.call('POST', '/robbery', { character: 'Thea', action: 'clear' })).status).toBe(200)
    v = (await x.call<AdminJobsView>('GET', '')).body
    expect(v.robbers).toEqual([])
    expect(v.sacks).toEqual([])
    expect((await x.call('POST', '/robbery', { character: 'Thea', action: 'jail', minutes: 0 })).status).toBe(400)
    expect((await x.call('POST', '/robbery', { character: 'Thea', action: 'jail', minutes: 15 })).status).toBe(200)
    expect(x.g.jail.jailedNow(th.p)).toBe(true)
    expect((await x.call('POST', '/robbery', { character: 'Thea', action: 'steal' })).status).toBe(400)
    expect(x.audits().filter((r) => r.args.includes('transport') || r.args.includes('robbery')).length).toBeGreaterThanOrEqual(4)
  })
})

describe('the Silk Caravan (§8)', () => {
  it('settings: off by default; slots and tz checked; bounds', () => {
    expect(S.event).toMatchObject({ enabled: false, durationMin: 60, slots: [{ weekday: 6, time: '20:00' }], demand: 1.4 })
    expect(checkJobSettings({ event: { slots: [{ weekday: 7, time: '20:00' }] } })).toEqual([expect.objectContaining({ path: 'event.slots[0]' })])
    expect(checkJobSettings({ event: { slots: [{ weekday: 1, time: '25:00' }] } })).toHaveLength(1)
    expect(checkJobSettings({ event: { slots: new Array(8).fill({ weekday: 1, time: '10:00' }) } })).toHaveLength(1)
    expect(checkJobSettings({ event: { tz: 'Europe/Berlin; drop' } })).toHaveLength(1)
    expect(checkJobSettings({ event: { tz: 'Europe/Berlin', slots: [], demand: 2, rewardGold: 0 } })).toEqual([])
    expect(checkJobSettings({ event: { demand: 9 } })).toEqual([expect.objectContaining({ path: 'event.demand' })])
  })

  it('admin start: the announcement, the boosted far post, more Trader EXP, a capped reward per completed run; admin stop', async () => {
    const x = harness()
    const t = x.trader('Tess', 3)
    expect(x.g.jobs.saveSettings(0, { event: { rewardRuns: 1 } }, null, x.h.now)).toMatchObject({ ok: true })
    expect((await x.call('POST', '/event/start', { minutes: 0 })).status).toBe(400)
    expect((await x.call('POST', '/event/start', { post: 'atlantis' })).status).toBe(409)
    const r = await x.call<{ event: AdminJobsView['event'] }>('POST', '/event/start', { minutes: 30, post: 'ferry-landing' })
    expect(r.status).toBe(200)
    expect(r.body.event!.running).toMatchObject({ post: 'ferry-landing', origin: 'admin', endsAt: x.h.now + 30 * MIN })
    expect(x.h.all(t.inbox, 'notice').at(-1)).toMatchObject({ from: 'Silk Caravan', text: expect.stringMatching(/Silk Caravan sets out/) })
    expect((await x.call('POST', '/event/start', {})).status).toBe(409)
    // a run to the boosted post: demand × 1.4, EXP × 1.25, the reward
    x.summon(t)
    const g0 = x.goldOf(t.p)
    x.buy(t, 10)
    const cost = g0 - x.goldOf(t.p)
    const exp0 = x.g.jobs.view(t.p, x.h.now).exp
    x.at(t, 'ferry-landing')
    const posts = x.g.jobs.content.posts
    const margin = tradeMargin(posts.find((p) => p.id === 'jangan')!, posts.find((p) => p.id === 'ferry-landing')!, S.trade)
    const want = tradeSellTotal(800, margin, 1, 10, { taxPct: S.trade.taxPct, drift: S.drift }, Infinity, S.event.demand)
    const g1 = x.goldOf(t.p)
    expect(x.sell(t, 'ferry-landing')).toMatchObject({ ok: true })
    expect(x.goldOf(t.p) - g1).toBe(want.gold + S.event.rewardGold)
    expect(x.g.jobs.view(t.p, x.h.now).exp - exp0).toBe(Math.floor(traderSaleExp(want.gold - cost, 1, S.exp) * S.event.expMul))
    expect(x.g.market.store.recent(5).map((l) => l.kind)).toContain('caravan')
    expect(x.g.caravan.running).toMatchObject({ runs: 1, rewarded: S.event.rewardGold })
    // a second run: counted, but the reward is capped at rewardRuns (1)
    x.at(t, 'jangan')
    x.buy(t, 10, 'south-beach')
    x.at(t, 'south-beach')
    const g2 = x.goldOf(t.p)
    expect(x.sell(t, 'south-beach')).toMatchObject({ ok: true })
    const plain = tradeSellTotal(800 * 1, tradeMargin(posts.find((p) => p.id === 'jangan')!, posts.find((p) => p.id === 'south-beach')!, S.trade), 1, 10, { taxPct: S.trade.taxPct, drift: S.drift })
    expect(x.goldOf(t.p) - g2).toBeLessThanOrEqual(plain.gold + 5)
    expect(x.g.caravan.running).toMatchObject({ runs: 2, rewarded: S.event.rewardGold })
    // the multipliers while it runs
    expect(x.g.caravan.mul('den', x.h.now)).toBe(S.event.denMul)
    expect(x.g.caravan.mul('escort', x.h.now)).toBe(S.event.escortMul)
    expect(x.g.caravan.demandAt('sea-cliffs', x.h.now)).toBe(1)
    // stop
    const s = await x.call<{ event: AdminJobsView['event'] }>('POST', '/event/stop', {})
    expect(s.status).toBe(200)
    expect(s.body.event!.running).toBeNull()
    expect(s.body.event!.history[0]).toMatchObject({ outcome: 'stopped', runs: 2, rewarded: S.event.rewardGold, post: 'ferry-landing' })
    expect(x.g.caravan.mul('den', x.h.now)).toBe(1)
    expect((await x.call('POST', '/event/stop', {})).status).toBe(409)
    expect(x.audits().filter((a) => a.args.includes('caravan')).length).toBe(5) // the 400 (bad minutes) is refused before any action
  })

  it('more ambushes while it runs (★★★★★: 4 groups instead of 2 at rng 0.5)', () => {
    const run = (on: boolean) => {
      const x = harness()
      const t = x.trader('Tess', 7)
      x.summon(t)
      if (on) expect(x.g.caravan.gm(['start'], x.h.now).ok).toBe(true)
      expect(x.g.transports.gm(['Tess', 'load', '5', 'ferry-landing'], x.h.now).ok).toBe(true)
      x.place(t, -420 * 0.15, 3 + 97 * 0.15)
      x.tick(100)
      return x.tr(t).ambushAt.length
    }
    expect(run(false)).toBe(2)
    expect(run(true)).toBe(4)
  })

  it('GM caravan start / status / stop; it ends by itself and says so', () => {
    const x = harness()
    const p = x.char([1, 0, 1], 'Pia')
    expect(x.g.caravan.gm(['status'], x.h.now).message).toMatch(/No Silk Caravan running; the weekly schedule is off/)
    expect(x.g.caravan.gm(['start', '10', 'sea-cliffs'], x.h.now)).toMatchObject({ ok: true, message: expect.stringMatching(/Sea Cliffs/) })
    expect(x.g.caravan.gm(['status'], x.h.now).message).toMatch(/Silk Caravan #1 \(gm\)/)
    expect(x.g.caravan.demandAt('sea-cliffs', x.h.now)).toBe(S.event.demand)
    x.tick(10 * MIN + 1000)
    expect(x.g.caravan.running).toBeNull()
    expect(x.h.all(p.inbox, 'notice').at(-1)?.text).toMatch(/Silk Caravan is over/)
    expect(x.g.caravan.view(x.h.now).history[0]).toMatchObject({ outcome: 'ended', origin: 'gm' })
    expect(x.g.caravan.gm(['stop'], x.h.now).ok).toBe(false)
    expect(x.g.caravan.gm(['dance'], x.h.now).ok).toBe(false)
  })

  it('the weekly slot starts it; a siege delays the slot then skips it, refuses a start and interrupts a running event', () => {
    const x = harness()
    const siege = x.g.siege as unknown as { busyWhy: () => string | null }
    expect(x.g.jobs.saveSettings(0, { event: { enabled: true, tz: 'UTC', slots: [slotAt(x.h.now, 5 * MIN)], busyWaitMin: 10 } }, null, x.h.now)).toMatchObject({ ok: true })
    x.tick(1000)
    const next = x.g.caravan.view(x.h.now).nextAt!
    expect(next).toBeGreaterThan(x.h.now)
    expect(next - x.h.now).toBeLessThanOrEqual(5 * MIN)
    x.tick(next - x.h.now + 1000)
    expect(x.g.caravan.running).toMatchObject({ origin: 'schedule' })
    // a siege starts: the event is interrupted
    siege.busyWhy = () => 'the Siege of Jangan is on (wave1)'
    x.tick(1000)
    expect(x.g.caravan.running).toBeNull()
    expect(x.g.caravan.view(x.h.now).history[0]).toMatchObject({ outcome: 'interrupted', why: expect.stringMatching(/Siege/) })
    expect(x.g.caravan.gm(['start'], x.h.now)).toMatchObject({ ok: false, message: expect.stringMatching(/Siege/) })
    // next week's slot during a siege: waits busyWaitMin, then skipped
    const slot2 = x.g.caravan.view(x.h.now).nextAt!
    expect(slot2 - next).toBe(7 * 24 * 60 * MIN)
    x.h.now = slot2 - 50
    x.tick(1000)
    expect(x.g.caravan.view(x.h.now).waitUntil).toBe(slot2 + 10 * MIN)
    x.tick(10 * MIN)
    expect(x.g.caravan.running).toBeNull()
    expect(x.g.caravan.view(x.h.now).history[0]).toMatchObject({ outcome: 'skipped', why: expect.stringMatching(/Siege/) })
    expect(x.g.caravan.view(x.h.now).nextAt).toBe(slot2 + 7 * 24 * 60 * MIN)
  })

  it('a restart resumes a running event (job_settings row caravan_event)', () => {
    const x = harness()
    expect(x.g.caravan.gm(['start', '30'], x.h.now).ok).toBe(true)
    const id = x.g.caravan.running!.id
    const again = new CaravanService(x.g)
    expect(again.running).toMatchObject({ id })
    expect(again.active(x.h.now + 10 * MIN)).toBe(true)
    expect(again.active(x.h.now + 31 * MIN)).toBe(false)
  })
})
