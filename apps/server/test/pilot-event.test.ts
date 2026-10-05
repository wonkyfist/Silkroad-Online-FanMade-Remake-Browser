/**
 * Play the Boss, layer 3 (docs/PLAY_THE_BOSS.md §2, §3.8, §3.9, §6.3): the event a GM or an admin starts with a chosen
 * pilot. The offer (only the offered account, inside 30 s; decline and timeout end it), the hunt (she spawns or is taken
 * over, the fury off, her home the camp, the leash the circle), and its ends: the timer (survived), downs, her death
 * (the hunters' kill, associates stripped from the shares), a quit, a GM stop and a restart; the rewards (gold by
 * performance, the title on a win), the announcements (the pilot named only at the end) and the event's rows.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { GameContext } from '../src/game.ts'
import { routeAdminBoss } from '../src/pilot/admin.ts'
import type { Player } from '../src/world.ts'
import { CAMPS, TG, pilotHarness, type PilotHarness } from './pilot-harness.ts'

let H: PilotHarness | null = null
afterEach(() => {
  H?.cleanup()
  H = null
})

const MIN = 60_000

function setup(o: Parameters<typeof pilotHarness>[0] = {}) {
  H = pilotHarness(o)
  const pc = H.player(150, 150, 'Pixi')
  return { ...H, pc }
}

/** GM pick of Pixi and her accept; returns the event id. */
function startHunt(s: ReturnType<typeof setup>): number {
  const r = s.gm('Pixi')
  expect(r.ok, r.message).toBe(true)
  const offer = s.last(s.pc.inbox, 'pilotOffer')!
  s.req(s.pc.p, { t: 'pilotAnswer', event: offer.event, accept: true })
  expect(s.result(s.pc.inbox, 'pilotAnswer')).toMatchObject({ ok: true })
  return offer.event
}

const row = (s: ReturnType<typeof setup>, id: number) => s.pilot.store.get(id)!

describe('the offer (§2.2, §3.10)', () => {
  it('a GM pick offers the turn (30 s); everyone sees phase offer; another account, a wrong id or a late answer: no_event', () => {
    const s = setup()
    const other = s.player(10, 10, 'Other')
    expect(s.gm('Pixi').ok).toBe(true)
    const offer = s.last(s.pc.inbox, 'pilotOffer')!
    expect(offer).toMatchObject({ surviveMin: 15, downsTarget: 15, idleSec: 20 })
    expect(offer.expiresAt).toBe(s.h.now + 30_000)
    expect(s.last(other.inbox, 'huntEvent')!.event).toMatchObject({ id: offer.event, phase: 'offer', mob: TG, name: 'Tiger Girl' })
    expect(s.last(other.inbox, 'huntEvent')!.event.pilot).toBeUndefined()
    s.req(other.p, { t: 'pilotAnswer', event: offer.event, accept: true })
    expect(s.result(other.inbox, 'pilotAnswer')).toMatchObject({ ok: false, reason: 'no_event' })
    s.req(s.pc.p, { t: 'pilotAnswer', event: offer.event + 1, accept: true })
    expect(s.result(s.pc.inbox, 'pilotAnswer')).toMatchObject({ ok: false, reason: 'no_event' })
    // A second pick while one runs is refused.
    expect(s.gm('Other').ok).toBe(false)
    s.tick(30_100)
    expect(s.last(other.inbox, 'huntEvent')!.event).toMatchObject({ phase: 'ended', outcome: 'no_volunteers' })
    s.req(s.pc.p, { t: 'pilotAnswer', event: offer.event, accept: true })
    expect(s.result(s.pc.inbox, 'pilotAnswer')).toMatchObject({ ok: false, reason: 'no_event' })
    expect(row(s, offer.event)).toMatchObject({ phase: 'ended', outcome: 'no_volunteers', origin: 'gm' })
    expect(s.pilot.store.logOf(offer.event).map((l) => l.kind)).toEqual(['offer', 'timeout', 'end'])
  })

  it('decline ends it (no_volunteers); the pilot keeps its body', () => {
    const s = setup()
    expect(s.gm('pick', 'Pixi').ok).toBe(true)
    const offer = s.last(s.pc.inbox, 'pilotOffer')!
    s.req(s.pc.p, { t: 'pilotAnswer', event: offer.event, accept: false })
    expect(s.result(s.pc.inbox, 'pilotAnswer')).toMatchObject({ ok: true })
    expect(row(s, offer.event).outcome).toBe('no_volunteers')
    expect(s.pc.p.trance).toBeUndefined()
    expect(s.pilot.event).toBeNull()
  })
})

describe('the hunt (§2.2, §3.4)', () => {
  it('accept: she spawns (announced), her home is the camp, the leash the circle, the fury off; the pilot named nowhere yet', () => {
    const s = setup()
    const hunter = s.player(-100, 0, 'Hunter')
    const id = startHunt(s)
    const m = s.her()!
    expect(s.h.all(hunter.inbox, 'uniqueNotice').some((n) => n.event === 'appeared')).toBe(true)
    const camp = CAMPS.find((c) => c.id === s.g.uniques!.uniques[0].row.camp)!
    expect(m.home).toEqual([camp.x, camp.z])
    expect(m.leashRange).toBe(350)
    expect(m.pilot).toEqual({ player: s.pc.p.id, steering: 'player' })
    expect(s.pc.p.trance).toBe(true)
    const start = s.last(s.pc.inbox, 'pilotStart')!
    expect(start).toMatchObject({ event: id, mob: m.id, downsTarget: 15 })
    expect(start.huntEndsAt).toBe(s.h.now + 15 * MIN)
    const ev = s.last(hunter.inbox, 'huntEvent')!.event
    expect(ev).toMatchObject({ id, phase: 'hunt', downs: 0, downsTarget: 15, hunters: 0, steering: 'player', nextPingAt: s.h.now + 60_000 })
    expect(ev.pilot).toBeUndefined()
    expect(row(s, id)).toMatchObject({ phase: 'hunt', pilot_name: 'Pixi', camp: camp.id })
    // A late joiner gets the event.
    const late = s.player(-90, 0, 'Late')
    expect(s.last(late.inbox, 'huntEvent')!.event).toMatchObject({ id, phase: 'hunt' })
  })

  it('takeover: alive, she keeps her HP and her fight', () => {
    const s = setup()
    const m = s.spawn()
    m.hp = 30_000
    startHunt(s)
    expect(s.her()).toBe(m)
    expect(m.hp).toBe(30_000)
    expect(m.pilot?.player).toBe(s.pc.p.id)
  })

  it('no fury in the event (the timer replaces it); no refill at home', () => {
    const s = setup({ file: (f) => void (f.uniques[0].pilot!.defaults.win = { ...f.uniques[0].pilot!.defaults.win, surviveMin: 30 }) })
    startHunt(s)
    const m = s.her()!
    const hunter = s.player(m.pos[0] + 3, m.pos[2], 'Hunter')
    s.g.dealHits(hunter.p, m, [{ outcome: 'hit', damage: 100, hp: 0 }], {}, s.h.now)
    s.h.now += 11 * MIN
    s.tick(500)
    expect(m.damageMul).toBeUndefined()
    s.g.restored(m)
    expect(m.hp).toBeLessThan(m.maxHp)
  })
})

describe('how it ends (§2.3, §3.8, §3.9)', () => {
  it('survived: gold by steered minutes + the win bonus, the title; she roars and leaves 8 s later; her 3–6 h timer; the pilot named', () => {
    const s = setup()
    const hunter = s.player(-100, 0, 'Hunter')
    const id = startHunt(s)
    const m = s.her()!
    s.h.now += 15 * MIN
    s.tick(100)
    const end = s.last(s.pc.inbox, 'pilotEnd')!
    expect(end).toMatchObject({ event: id, reason: 'survived', gold: 5000 + 15 * 300 + 10_000, honor: 'tiger_spirit', downs: 0 })
    expect(s.pc.p.trance).toBeUndefined()
    expect(s.pc.p.viewFrom).toBeUndefined()
    expect(s.pc.p.gold).toBe(19_500)
    expect(s.h.world.state(s.pc.p).honor).toBe('tiger_spirit')
    expect(s.last(hunter.inbox, 'huntEvent')!.event).toMatchObject({ phase: 'ended', outcome: 'survived', pilot: 'Pixi' })
    // The result is huntEvent 'ended' (the client's banner and chat line); no server chat line of its own.
    expect(s.h.all(hunter.inbox, 'chat').some((c) => c.text.startsWith('[Hunt]'))).toBe(false)
    expect(m.ai).toBe('return')
    s.tick(8100)
    expect(s.her()).toBeUndefined()
    const u = s.g.uniques!.uniques[0]
    expect(u.row.phase).toBe('waiting')
    expect(u.row.due_at - s.h.now).toBeGreaterThanOrEqual(180 * MIN - 9000)
    expect(row(s, id)).toMatchObject({ phase: 'ended', outcome: 'survived', reward_gold: 19_500 })
    expect(s.pilot.store.honorOf(s.pc.p.characterId)).toBe('tiger_spirit')
  })

  it('downs: a hunter she kills after dealing ≥ 200 is a down; less, or the pilot\'s party: not; the target ends it', () => {
    const s = setup({ file: (f) => void (f.uniques[0].pilot!.defaults.win = { ...f.uniques[0].pilot!.defaults.win, downsTarget: 2 }) })
    const friend = s.player(140, 150, 'Friend')
    s.req(s.pc.p, { t: 'partyInvite', target: friend.p.id })
    s.req(friend.p, { t: 'partyRespond', inviter: s.pc.p.id, accept: true })
    expect(s.g.party.sameParty(s.pc.p, friend.p)).toBe(true)
    const id = startHunt(s)
    const m = s.her()!
    const at = (dx: number, name: string) => s.player(m.pos[0] + dx, m.pos[2], name, 1000)
    const kill = (p: Player) => s.g.dealHits(m, p, [{ outcome: 'hit', damage: 99_999, hp: 0 }], {}, s.h.now)
    const a = at(3, 'Alpha')
    const b = at(-3, 'Bravo')
    const c = at(4, 'Charlie')
    s.h.world.warp(friend.p, m.pos[0], 0, m.pos[2] + 3, s.h.now)
    const hit = (p: Player, d: number) => s.g.dealHits(p, m, [{ outcome: 'hit', damage: d, hp: 0 }], {}, s.h.now)
    hit(a.p, 250)
    hit(b.p, 100)
    hit(friend.p, 500)
    hit(c.p, 300)
    kill(a.p)
    kill(b.p)
    kill(friend.p)
    expect(s.pilot.event!.downs).toBe(1)
    expect(s.h.all(c.inbox, 'chat').some((l) => l.text === '[Hunt] Alpha was mauled by Tiger Girl! (1 / 2)')).toBe(true)
    // A respawned hunter must fight again before his next death counts.
    s.req(a.p, { t: 'respawn' })
    s.h.world.warp(a.p, m.pos[0] + 3, 0, m.pos[2], s.h.now)
    kill(a.p)
    expect(s.pilot.event!.downs).toBe(1)
    kill(c.p)
    s.tick(100)
    expect(s.last(s.pc.inbox, 'pilotEnd')).toMatchObject({ reason: 'downs', downs: 2, gold: 5000 + 2 * 500 + 10_000, honor: 'tiger_spirit' })
    // Alpha, Bravo and Charlie hit her; the friend (an associate) does not count.
    expect(row(s, id)).toMatchObject({ outcome: 'downs', downs: 2, hunters: 3 })
  })

  it("killed: the hunters win; the pilot's party gets nothing from her; gold without the bonus; the defeat notice", () => {
    const s = setup()
    const friend = s.player(140, 150, 'Friend')
    s.req(s.pc.p, { t: 'partyInvite', target: friend.p.id })
    s.req(friend.p, { t: 'partyRespond', inviter: s.pc.p.id, accept: true })
    const id = startHunt(s)
    const m = s.her()!
    const hunter = s.player(m.pos[0] + 3, m.pos[2], 'Hunter')
    s.h.world.warp(friend.p, m.pos[0] - 3, 0, m.pos[2], s.h.now)
    s.h.now += 4 * MIN
    s.moveTo(s.pc.p, m.pos[0], m.pos[2] + 1)
    s.tick(100)
    const hit = (p: Player, d: number) => s.g.dealHits(p, m, [{ outcome: 'hit', damage: d, hp: 0 }], {}, s.h.now)
    hit(friend.p, 100)
    hit(hunter.p, 1000)
    m.hp = 50
    const expBefore = friend.p.progress.exp
    hit(hunter.p, 100)
    expect(m.ai).toBe('dead')
    expect(friend.p.progress.exp).toBe(expBefore)
    expect(s.h.all(hunter.inbox, 'statsDelta').some((d) => (d.gain?.exp ?? 0) > 0)).toBe(true)
    expect(s.h.all(hunter.inbox, 'uniqueNotice').some((n) => n.event === 'defeated' && n.by === 'Hunter')).toBe(true)
    const end = s.last(s.pc.inbox, 'pilotEnd')!
    expect(end.reason).toBe('killed')
    expect(end.gold).toBe(5000 + 4 * 300)
    expect(end.honor).toBeUndefined()
    expect(row(s, id)).toMatchObject({ outcome: 'killed', flags: '[]' })
  })

  it('a death within the first 3 minutes is suspect: no reward, the event flagged', () => {
    const s = setup()
    const id = startHunt(s)
    const m = s.her()!
    const hunter = s.player(m.pos[0] + 3, m.pos[2], 'Hunter')
    m.hp = 50
    s.g.dealHits(hunter.p, m, [{ outcome: 'hit', damage: 100, hp: 0 }], {}, s.h.now)
    expect(s.last(s.pc.inbox, 'pilotEnd')).toMatchObject({ reason: 'killed' })
    expect(s.last(s.pc.inbox, 'pilotEnd')!.gold).toBeUndefined()
    expect(JSON.parse(row(s, id).flags)).toContain('suspect_early_death')
  })

  it('pilotQuit: her AI finishes the hunt; the pilot forfeits (pilotEnd quit, nothing at the end)', () => {
    const s = setup()
    const id = startHunt(s)
    const m = s.her()!
    s.req(s.pc.p, { t: 'pilotQuit' })
    expect(s.last(s.pc.inbox, 'pilotEnd')).toMatchObject({ event: id, reason: 'quit' })
    expect(s.pc.p.trance).toBeUndefined()
    expect(m.pilot).toEqual({ player: null, steering: 'ai' })
    expect(s.pilot.event?.phase).toBe('hunt')
    const n = s.h.all(s.pc.inbox, 'pilotEnd').length
    s.h.now += 15 * MIN
    s.tick(100)
    expect(s.h.all(s.pc.inbox, 'pilotEnd')).toHaveLength(n)
    expect(s.pc.p.gold).toBe(0)
    expect(row(s, id)).toMatchObject({ outcome: 'survived', reward_gold: 0 })
    expect(JSON.parse(row(s, id).flags)).toContain('pilot_left')
  })

  it('GM stop in the hunt: cancelled, she leaves silently, her normal timer; status before and after', () => {
    const s = setup()
    const hunter = s.player(-100, 0, 'Hunter')
    const id = startHunt(s)
    expect(s.gm('status').message).toMatch(/hunt( \(.*\))?, 15:00 left, downs 0 \/ 15/)
    expect(s.gm('stop').ok).toBe(true)
    expect(s.her()).toBeUndefined()
    expect(s.last(s.pc.inbox, 'pilotEnd')).toMatchObject({ reason: 'cancelled' })
    expect(s.last(hunter.inbox, 'huntEvent')!.event).toMatchObject({ id, phase: 'ended', outcome: 'cancelled' })
    expect(s.h.all(hunter.inbox, 'uniqueNotice').filter((n) => n.event === 'defeated')).toHaveLength(0)
    expect(s.gm('status').message).toMatch(/Nothing is running/)
    expect(s.gm('stop').ok).toBe(false)
  })

  it('a restart: events found open end with outcome restart, the turn refunded', () => {
    const s = setup()
    const id = s.pilot.store.create(TG, 'gm', 'hunt', s.h.now)
    s.pilot.recover(s.h.now)
    expect(row(s, id)).toMatchObject({ phase: 'ended', outcome: 'restart', refunded: 1 })
  })
})

describe('the admin routes (§6.3)', () => {
  it('GET boss, POST pick / stop, GET events and an event with its timeline; an unknown route 404', async () => {
    const s = setup()
    const ctx = { gameplay: s.g, world: s.h.world, data: s.h.data, store: s.h.store, config: s.h.config } as unknown as GameContext
    const actor = { accountId: 1, role: 'admin' as const, username: 'root' }
    const call = (method: string, sub: string, body?: unknown) => routeAdminBoss(ctx, { method, path: `/api/admin/boss${sub}`, query: new URLSearchParams(), body, actor })
    const view = await call('GET', '')
    expect(view.status).toBe(200)
    expect(view.body).toMatchObject({ current: null, attach: null, features: expect.arrayContaining(['pick', 'stop']), uniques: [{ code: TG, steerable: true, alive: false }] })
    expect((await call('POST', '/pick', { character: 'Nobody' })).status).toBe(404)
    const pick = await call('POST', '/pick', { character: 'Pixi' })
    expect(pick.status).toBe(200)
    expect((await call('POST', '/pick', { character: 'Pixi' })).status).toBe(409)
    expect(((await call('GET', '')).body as { current: { phase: string; pilotName: string } }).current).toMatchObject({ phase: 'offer', pilotName: 'Pixi' })
    expect((await call('POST', '/stop', {})).status).toBe(200)
    const list = await call('GET', '/events')
    const ev = (list.body as { events: { id: number; outcome: string }[] }).events[0]
    expect(ev.outcome).toBe('cancelled')
    const detail = await call('GET', `/events/${ev.id}`)
    expect((detail.body as { log: { kind: string }[] }).log.map((l) => l.kind)).toEqual(['offer', 'gm', 'end'])
    expect((await call('POST', '/nope', {})).status).toBe(404)
    expect((await call('GET', '', undefined)).status).toBe(200)
    expect((await routeAdminBoss(ctx, { method: 'GET', path: '/api/admin/boss', query: new URLSearchParams(), body: undefined, actor: { ...actor, role: 'gm' } })).status).toBe(403)
  })
})
