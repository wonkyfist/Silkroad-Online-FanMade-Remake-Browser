/**
 * Play the Boss, layer 4 (docs/PLAY_THE_BOSS.md §2.2, §2.4, §2.5, §3.9, §3.10, §4.5): the call for volunteers and the
 * draw. A call opens (GM start, the weekly schedule, a night the downtime delayed); every world player gets the call
 * with its own eligibility; volunteers (each reason refused, one entry per account, withdraw); the draw at the call's
 * end (weighted, offline / dead / no longer eligible skipped, a decline and a timeout draw the next, maxDraws, nobody:
 * her normal spawn); the hold on her spawn timer; a GM force-pick and a stop during the call; restarts mid-call and
 * mid-draw; the lottery blocks.
 */
import { mergePilotPatch, type PilotSettingsPatch, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { Player } from '../src/world.ts'
import { TG, pilotHarness, type PilotHarness } from './pilot-harness.ts'

let H: PilotHarness | null = null
afterEach(() => {
  H?.cleanup()
  H = null
})

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The harness with Pixi (level 20) and `patch` over the shipped defaults (no play time needed unless the patch says). */
function setup(patch: PilotSettingsPatch = {}, at?: number) {
  H = pilotHarness({
    file: (f) => {
      const p = f.uniques[0].pilot!
      p.defaults = mergePilotPatch(mergePilotPatch(p.defaults, { eligibility: { minPlayHours: 0 } }), patch)
    },
  })
  if (at !== undefined) H.h.now = at
  const pc = H.player(150, 150, 'Pixi')
  return { ...H, pc }
}
type S = ReturnType<typeof setup>

const conf = (s: S) => {
  const c = s.pilot.conf('')
  if (typeof c === 'string') throw new Error(c)
  return c
}
const accountOf = (s: S, p: Player) => s.h.store.characterById(p.characterId)!.account_id
const played = (s: S, p: Player, ms: number) => s.h.store.db.prepare('UPDATE characters SET played_ms = ? WHERE id = ?').run(ms, p.characterId)
const volunteer = (s: S, x: { p: Player; inbox: unknown[] }, on = true) => {
  s.req(x.p, { t: 'pilotVolunteer', on })
  return s.result(x.inbox as never, 'pilotVolunteer')
}
/** A past counted turn of `account` (hunt start `at`). */
const pastTurn = (s: S, account: number, at: number) => {
  const id = s.pilot.store.create(TG, 'gm', 'ended', at)
  s.pilot.store.update(id, { pilot_account: account, hunt_started_at: at, ended_at: at + 15 * MIN, outcome: 'survived' })
  return id
}
const offers = (s: S, x: { inbox: unknown[] }) => s.h.all(x.inbox as never, 'pilotOffer')

describe('the call (§2.2, §4.5)', () => {
  it('a GM start opens it for everyone: the draw time, the volunteers, level 20 only, each player its own eligibility', () => {
    const s = setup()
    const low = s.h.hero({ pos: [10, 0, 10] as Vec3, level: 10, name: 'Low' })
    const r = s.gm('start')
    expect(r.ok, r.message).toBe(true)
    const ev = s.last(s.pc.inbox, 'huntEvent')!.event
    expect(ev).toMatchObject({ phase: 'call', mob: TG, callEndsAt: s.h.now + 10 * MIN, volunteers: 0, minLevel: 20, you: { volunteered: false, eligible: true } })
    expect(ev.pilot).toBeUndefined()
    expect(s.last(low.inbox, 'huntEvent')!.event.you).toEqual({ volunteered: false, eligible: false, why: 'level' })
    expect(s.pilot.store.get(ev.id)).toMatchObject({ phase: 'call', origin: 'gm', call_ends_at: s.h.now + 10 * MIN })
    // One event at a time; a late joiner gets the call with its own part.
    expect(s.gm('start').ok).toBe(false)
    const late = s.player(20, 20, 'Late')
    expect(s.last(late.inbox, 'huntEvent')!.event).toMatchObject({ id: ev.id, phase: 'call', you: { eligible: true } })
    expect(s.gm('status').message).toMatch(/call for volunteers \(gm\), the draw in 10:00, 0 volunteers/)
    // `start <minutes>`: 1..60.
    expect(s.gm('stop').ok).toBe(true)
    expect(s.gm('start', '61').ok).toBe(false)
    const five = s.gm('start', '5')
    expect(five.ok, five.message).toBe(true)
    expect(s.pilot.event!.callEndsAt).toBe(s.h.now + 5 * MIN)
  })

  it('volunteers (§3.9, §3.10): eligible only, each reason refused, one entry per account, withdraw; nothing without a call', () => {
    const s = setup({ eligibility: { minPlayHours: 10 } })
    expect(volunteer(s, s.pc)).toMatchObject({ ok: false, reason: 'no_event' })
    const all = {
      fresh: s.player(10, 10, 'Fresh'),
      cool: s.player(12, 10, 'Cool'),
      rec: s.player(14, 10, 'Recent'),
      blk: s.player(16, 10, 'Blocked'),
      dead: s.player(18, 10, 'Dead', 1000),
    }
    for (const x of [s.pc, all.cool, all.rec, all.blk, all.dead]) played(s, x.p, 11 * HOUR)
    played(s, all.fresh.p, 9 * HOUR)
    pastTurn(s, accountOf(s, all.rec.p), s.h.now - 20 * DAY)
    pastTurn(s, accountOf(s, all.cool.p), s.h.now - 2 * DAY)
    expect(s.gm('block', 'Blocked', '2', 'spoiled', 'the', 'last', 'hunt').ok).toBe(true)
    s.g.dealHits(s.h.dummy(18, 11), all.dead.p, [{ outcome: 'hit', damage: 99_999, hp: 0 }], {}, s.h.now)
    expect(all.dead.p.dead).toBe(true)
    expect(s.gm('start').ok).toBe(true)
    const want: [keyof typeof all, string][] = [['fresh', 'playtime'], ['cool', 'cooldown'], ['rec', 'recent'], ['blk', 'blocked'], ['dead', 'dead']]
    for (const [k, why] of want) {
      expect(volunteer(s, all[k]), k).toMatchObject({ ok: false, reason: 'not_eligible' })
      expect(s.last(all[k].inbox, 'huntEvent')!.event.you, k).toEqual({ volunteered: false, eligible: false, why })
    }
    expect(volunteer(s, s.pc)).toMatchObject({ ok: true })
    expect(s.last(s.pc.inbox, 'huntEvent')!.event).toMatchObject({ volunteers: 1, you: { volunteered: true, eligible: true } })
    // A second character of the same account cannot add a second entry; the same one again changes nothing.
    const acc = accountOf(s, s.pc.p)
    const row = s.h.store.createCharacter(acc, 'PixiAlt', 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    s.h.store.saveProgress(row.id, { level: 20, exp: 0, sp: 0, spExp: 0, str: 39, int: 39, statPoints: 0 })
    played(s, { characterId: row.id } as Player, 11 * HOUR)
    const alt = s.h.hero({ characterId: row.id, pos: [150, 0, 152] })
    expect(volunteer(s, alt)).toMatchObject({ ok: false, reason: 'not_eligible', message: expect.stringMatching(/Another character of your account/) })
    expect(volunteer(s, s.pc)).toMatchObject({ ok: true })
    expect(s.pilot.store.volunteers(s.pilot.event!.id)).toHaveLength(1)
    // Withdraw: the entry is gone and the other character may take the account's place.
    expect(volunteer(s, s.pc, false)).toMatchObject({ ok: true })
    expect(s.last(s.pc.inbox, 'huntEvent')!.event).toMatchObject({ volunteers: 0, you: { volunteered: false } })
    expect(volunteer(s, alt)).toMatchObject({ ok: true })
    // The count reaches everyone within 2 s.
    s.tick(2100)
    expect(s.last(all.fresh.inbox, 'huntEvent')!.event.volunteers).toBe(1)
    expect(s.pilot.store.logOf(s.pilot.event!.id).map((l) => l.kind)).toEqual(['call', 'volunteer', 'withdraw', 'volunteer'])
  })

  it('blocks: GM block / unblock by character name (its account); an unknown name is an error', () => {
    const s = setup()
    const r = s.gm('block', 'Pixi', '3')
    expect(r.ok, r.message).toBe(true)
    expect(s.pilot.store.blockOf(accountOf(s, s.pc.p))).toMatchObject({ until: s.h.now + 3 * DAY, reason: '' })
    expect(s.gm('block', 'Nobody', '3').ok).toBe(false)
    expect(s.gm('block', 'Pixi').ok).toBe(false)
    expect(s.gm('block', 'Pixi', '0').ok).toBe(false)
    expect(s.gm('unblock', 'Pixi').ok).toBe(true)
    expect(s.gm('unblock', 'Pixi').ok).toBe(false)
    expect(s.pilot.store.blockOf(accountOf(s, s.pc.p))).toBeUndefined()
  })
})

describe('the draw (§2.2, §3.9)', () => {
  it('at the call end: a volunteer is offered the turn; a decline and a timeout draw the next; accept starts the hunt', () => {
    const s = setup()
    const a = s.player(10, 10, 'Alpha')
    const b = s.player(12, 10, 'Bravo')
    const watcher = s.player(14, 10, 'Watcher')
    expect(s.gm('start').ok).toBe(true)
    const id = s.pilot.event!.id
    for (const x of [s.pc, a, b]) expect(volunteer(s, x)).toMatchObject({ ok: true })
    s.h.now = s.pilot.event!.callEndsAt - 50
    s.tick(50)
    expect(s.last(watcher.inbox, 'huntEvent')!.event).toMatchObject({ id, phase: 'offer', volunteers: 3 })
    const who = () => [s.pc, a, b].filter((x) => offers(s, x).length > 0)
    expect(who()).toHaveLength(1)
    const first = who()[0]
    expect(offers(s, first)[0]).toMatchObject({ event: id, expiresAt: s.h.now + 30_000 })
    s.req(first.p, { t: 'pilotAnswer', event: id, accept: false })
    expect(who()).toHaveLength(2)
    const second = who().find((x) => x !== first)!
    s.tick(30_100)
    expect(who()).toHaveLength(3)
    const third = who().find((x) => x !== first && x !== second)!
    s.req(third.p, { t: 'pilotAnswer', event: id, accept: true })
    expect(s.result(third.inbox, 'pilotAnswer')).toMatchObject({ ok: true })
    expect(s.pilot.event).toMatchObject({ phase: 'hunt' })
    expect(s.last(third.inbox, 'pilotStart')).toMatchObject({ event: id })
    expect(third.p.trance).toBe(true)
    const draws = Object.fromEntries(s.pilot.store.volunteers(id).map((v) => [v.character_id, v.draw]))
    expect(draws).toEqual({ [first.p.characterId]: 'declined', [second.p.characterId]: 'timeout', [third.p.characterId]: 'accepted' })
    expect(s.pilot.store.logOf(id).map((l) => l.kind)).toEqual(['call', 'volunteer', 'volunteer', 'volunteer', 'draw', 'offer', 'decline', 'offer', 'timeout', 'offer', 'accept', 'spawn'])
    // The hunt banner does not name the pilot.
    expect(s.last(watcher.inbox, 'huntEvent')!.event).toMatchObject({ phase: 'hunt' })
    expect(s.last(watcher.inbox, 'huntEvent')!.event.pilot).toBeUndefined()
  })

  it('volunteers offline, dead or no longer eligible are skipped at the draw (their row says why)', () => {
    const s = setup()
    const gone = s.player(10, 10, 'Gone')
    const dead = s.player(12, 10, 'Dead', 1000)
    const blk = s.player(14, 10, 'Late')
    expect(s.gm('start').ok).toBe(true)
    const id = s.pilot.event!.id
    for (const x of [s.pc, gone, dead, blk]) expect(volunteer(s, x)).toMatchObject({ ok: true })
    s.h.world.remove(gone.p.id, s.h.now)
    s.g.forget(gone.p)
    s.g.dealHits(s.h.dummy(12, 11), dead.p, [{ outcome: 'hit', damage: 99_999, hp: 0 }], {}, s.h.now)
    expect(s.gm('block', 'Late', '1').ok).toBe(true)
    s.h.now = s.pilot.event!.callEndsAt
    s.tick(100)
    expect(offers(s, s.pc)).toHaveLength(1)
    const draws = Object.fromEntries(s.pilot.store.volunteers(id).map((v) => [v.character_id, v.draw]))
    expect(draws).toEqual({ [s.pc.p.characterId]: 'offered', [gone.p.characterId]: 'skipped:offline', [dead.p.characterId]: 'skipped:dead', [blk.p.characterId]: 'skipped:blocked' })
  })

  it('maxDraws reached: no_volunteers, and she appears as her normal AI self; the call held her timer meanwhile', () => {
    const s = setup({ call: { maxDraws: 1 } })
    const a = s.player(10, 10, 'Alpha')
    // Her timer runs out a minute into the call: the call holds it.
    expect(s.g.uniques!.gm(null, ['timer', 'tiger', '1'], s.h.now).ok).toBe(true)
    expect(s.gm('start').ok).toBe(true)
    const id = s.pilot.event!.id
    expect(s.g.uniques!.heldUntil(TG)).toBe(s.pilot.event!.callEndsAt + 1 * 30_000 + 60_000)
    for (const x of [s.pc, a]) expect(volunteer(s, x)).toMatchObject({ ok: true })
    s.tick(2 * MIN)
    expect(s.her()).toBeUndefined()
    s.h.now = s.pilot.event!.callEndsAt
    s.tick(100)
    const first = [s.pc, a].find((x) => offers(s, x).length > 0)!
    s.req(first.p, { t: 'pilotAnswer', event: id, accept: false })
    expect(s.pilot.event).toBeNull()
    expect(s.pilot.store.get(id)).toMatchObject({ phase: 'ended', outcome: 'no_volunteers' })
    expect(s.last(a.inbox, 'huntEvent')!.event).toMatchObject({ id, phase: 'ended', outcome: 'no_volunteers' })
    expect(s.pilot.store.volunteers(id).filter((v) => v.draw === null)).toHaveLength(1)
    const m = s.her()!
    expect(m).toBeDefined()
    expect(m.pilot).toBeUndefined()
    expect(s.h.all(a.inbox, 'uniqueNotice').some((n) => n.event === 'appeared')).toBe(true)
    expect(s.g.uniques!.heldUntil(TG)).toBe(0)
  })

  it('nobody volunteered: no_volunteers at the call end; she is taken over by nobody (alive stays alive)', () => {
    const s = setup()
    const m = s.spawn()
    expect(s.gm('start').ok).toBe(true)
    const id = s.pilot.event!.id
    s.h.now = s.pilot.event!.callEndsAt
    s.tick(100)
    expect(s.pilot.store.get(id)).toMatchObject({ outcome: 'no_volunteers' })
    expect(s.her()).toBe(m)
    expect(m.pilot).toBeUndefined()
  })

  it('a GM force-pick during the call closes it; a decline then draws from the volunteers', () => {
    const s = setup()
    const a = s.player(10, 10, 'Alpha')
    const b = s.player(12, 10, 'Bravo')
    expect(s.gm('start').ok).toBe(true)
    const id = s.pilot.event!.id
    expect(volunteer(s, a)).toMatchObject({ ok: true })
    const r = s.gm('Bravo')
    expect(r.ok, r.message).toBe(true)
    expect(s.pilot.event).toMatchObject({ id, phase: 'offer' })
    expect(offers(s, b)).toHaveLength(1)
    expect(s.pilot.store.get(id)!.phase).toBe('draw')
    // Volunteering is over once the call is closed.
    expect(volunteer(s, s.pc)).toMatchObject({ ok: false, reason: 'no_event' })
    s.req(b.p, { t: 'pilotAnswer', event: id, accept: false })
    expect(offers(s, a)).toHaveLength(1)
    expect(s.pilot.store.logOf(id).map((l) => l.kind)).toEqual(['call', 'volunteer', 'gm', 'offer', 'decline', 'offer'])
  })

  it('a GM stop during the call: cancelled, the hold released, no spawn', () => {
    const s = setup()
    const a = s.player(10, 10, 'Alpha')
    expect(s.gm('start').ok).toBe(true)
    const id = s.pilot.event!.id
    expect(s.gm('stop').ok).toBe(true)
    expect(s.pilot.store.get(id)).toMatchObject({ phase: 'ended', outcome: 'cancelled' })
    expect(s.last(a.inbox, 'huntEvent')!.event).toMatchObject({ id, phase: 'ended', outcome: 'cancelled' })
    expect(s.g.uniques!.heldUntil(TG)).toBe(0)
    expect(s.her()).toBeUndefined()
  })
})

describe('restarts (§2.4)', () => {
  /** A fresh process over the same database: nothing in memory, the boot pass reads the rows. */
  const reboot = (s: S) => {
    s.pilot.event = null
    s.g.uniques!.hold(TG, 0)
    s.pilot.recover(s.h.now)
  }

  it('mid-call: resumed with its volunteers and its end; with under 2 min left it ends 3 min after boot', () => {
    const s = setup()
    expect(s.gm('start').ok).toBe(true)
    const id = s.pilot.event!.id
    const ends = s.pilot.event!.callEndsAt
    expect(volunteer(s, s.pc)).toMatchObject({ ok: true })
    s.h.now += 2 * MIN
    reboot(s)
    expect(s.pilot.event).toMatchObject({ id, phase: 'call', callEndsAt: ends, volunteers: 1, fromCall: true })
    expect(s.g.uniques!.heldUntil(TG)).toBeGreaterThan(ends)
    s.h.now = ends - MIN
    reboot(s)
    expect(s.pilot.event!.callEndsAt).toBe(s.h.now + 3 * MIN)
    expect(s.pilot.store.get(id)!.call_ends_at).toBe(s.h.now + 3 * MIN)
    // A late joiner sees the resumed call as volunteered.
    expect(s.last(s.player(5, 5, 'Back').inbox, 'huntEvent')!.event).toMatchObject({ id, phase: 'call', volunteers: 1 })
    s.pilot.enter(s.pc.p, s.h.now)
    expect(s.last(s.pc.inbox, 'huntEvent')!.event.you).toMatchObject({ volunteered: true })
  })

  it('mid-draw: drawing again 3 min after boot; the open offer is drawable again, a decline stays a decline', () => {
    const s = setup()
    const a = s.player(10, 10, 'Alpha')
    const b = s.player(12, 10, 'Bravo')
    expect(s.gm('start').ok).toBe(true)
    const id = s.pilot.event!.id
    for (const x of [a, b]) expect(volunteer(s, x)).toMatchObject({ ok: true })
    s.h.now = s.pilot.event!.callEndsAt
    s.tick(100)
    const first = [a, b].find((x) => offers(s, x).length > 0)!
    const other = first === a ? b : a
    s.req(first.p, { t: 'pilotAnswer', event: id, accept: false })
    expect(offers(s, other)).toHaveLength(1)
    reboot(s)
    expect(s.pilot.event).toMatchObject({ id, phase: 'offer', offer: null, drawAt: s.h.now + 3 * MIN, draws: 1 })
    expect(s.pilot.store.volunteerOf(id, accountOf(s, other.p))!.draw).toBeNull()
    expect(s.pilot.store.volunteerOf(id, accountOf(s, first.p))!.draw).toBe('declined')
    s.tick(3 * MIN + 100)
    expect(offers(s, other)).toHaveLength(2)
    expect(offers(s, first)).toHaveLength(1)
  })

  it('a GM pick (no call) open at a restart ends with outcome restart, as in layer 3', () => {
    const s = setup()
    expect(s.gm('Pixi').ok).toBe(true)
    const id = s.pilot.event!.id
    reboot(s)
    expect(s.pilot.event).toBeNull()
    expect(s.pilot.store.get(id)).toMatchObject({ outcome: 'restart', refunded: 1 })
  })
})

describe('the weekly night (§2.2, §2.4, §6.2)', () => {
  // The test clock starts at 1970-01-01 00:16:40 UTC, a Thursday (weekday 4).
  const NIGHT: PilotSettingsPatch = { enabled: true, schedule: { slots: [{ weekday: 4, time: '00:30' }], tz: 'UTC' } }

  it('the call opens call.minutes before the slot; the draw is at the slot; the next night a week later', () => {
    const s = setup(NIGHT)
    s.tick(100)
    expect(s.pilot.event).toBeNull()
    expect(s.pilot.lottery.nextNight(conf(s))).toBe(30 * MIN)
    s.h.now = 20 * MIN - 100
    s.tick(100)
    expect(s.pilot.event).toMatchObject({ phase: 'call', origin: 'schedule', callEndsAt: 30 * MIN })
    expect(s.last(s.pc.inbox, 'huntEvent')!.event).toMatchObject({ phase: 'call', callEndsAt: 30 * MIN })
    expect(s.pilot.lottery.nextNight(conf(s))).toBe(30 * MIN + 7 * DAY)
    // A restart during that call does not open a second one.
    s.pilot.event = null
    s.pilot.recover(s.h.now)
    expect(s.pilot.event).toMatchObject({ phase: 'call', origin: 'schedule' })
    expect(s.pilot.store.list(Number.MAX_SAFE_INTEGER, 10)).toHaveLength(1)
  })

  it('a night due during a Siege of Jangan waits 30 min (docs/SIEGE.md §6.7), then opens', () => {
    const s = setup(NIGHT)
    s.tick(100)
    let siege: string | null = 'the Siege of Jangan is on (wave2)'
    s.g.siege.busyWhy = () => siege
    s.h.now = 20 * MIN - 100
    s.tick(100)
    expect(s.pilot.event).toBeNull()
    expect(s.h.logs.some((l) => /Night of the Tiger .* waits 30 min: the Siege of Jangan is on/.test(l))).toBe(true)
    s.tick(10 * MIN)
    expect(s.pilot.event).toBeNull()
    siege = null
    s.tick(21 * MIN)
    expect(s.pilot.event).toMatchObject({ phase: 'call', origin: 'schedule' })
    expect(s.pilot.event!.callEndsAt - s.pilot.event!.createdAt).toBe(10 * MIN)
  })

  it('off (enabled false) or no slots: no night; a GM start still works', () => {
    const s = setup({ ...NIGHT, enabled: false })
    s.h.now = 25 * MIN
    s.tick(100)
    expect(s.pilot.event).toBeNull()
    expect(s.pilot.lottery.nextNight(conf(s))).toBeNull()
    expect(s.gm('start').ok).toBe(true)
  })

  it('a call missed during the downtime: ≤ 30 min late it opens at boot with the time left (≥ 3 min); later it is skipped and logged', () => {
    let s = setup(NIGHT, 25 * MIN)
    s.tick(50)
    expect(s.pilot.event).toMatchObject({ phase: 'call', origin: 'schedule', callEndsAt: 30 * MIN })
    H!.cleanup()
    s = setup(NIGHT, 40 * MIN)
    s.tick(50)
    expect(s.pilot.event).toMatchObject({ phase: 'call', callEndsAt: 43 * MIN + 50 })
    H!.cleanup()
    s = setup(NIGHT, 51 * MIN)
    s.tick(50)
    expect(s.pilot.event).toBeNull()
    expect(s.h.logs.some((l) => /Night of the Tiger of 1970-01-01T00:30:00.000Z was missed/.test(l))).toBe(true)
    expect(s.pilot.lottery.nextNight(conf(s))).toBe(30 * MIN + 7 * DAY)
  })

  it('a night that finds her steered already (a GM attach session) is skipped and logged', () => {
    const s = setup(NIGHT)
    s.spawn()
    expect(s.gm('attach', 'Pixi').ok).toBe(true)
    s.h.now = 20 * MIN - 50
    s.tick(100)
    expect(s.pilot.event).toBeNull()
    expect(s.h.logs.some((l) => /Night of the Tiger of 1970-01-01T00:30:00.000Z is skipped: Pixi steers/.test(l))).toBe(true)
  })
})
