import type { HuntEventView, PilotEligibilityView, PilotIneligible } from '@sro/shared'
import { fail, type Fail } from '../inventory.ts'
import type { Player } from '../world.ts'
import { DAY_MS, HOUR_MS, drawWeight, drawWeighted, ineligible, nextSlotAt, slotsBetween, type EligibilityFacts } from './lottery.ts'
import type { Pilot } from './service.ts'
import { HOLD_SLACK_MS, MISSED_GRACE_MS, RESUME_MIN_MS, RESUME_MS, type HuntEvent, type PilotConf } from './types.ts'
import type { PilotEventRow } from './store.ts'

/**
 * Play the Boss, layer 4 (docs/PLAY_THE_BOSS.md §2.2, §2.4, §3.9): the call for volunteers, the draw, the weekly
 * schedule and the lottery blocks.
 *
 * - **The call** (`open`): a scheduled night (`slot − call.minutes`), `/unique pilot start` or the admin's Start. It
 *   holds her spawn timer past the hunt start (Uniques.hold); world players get `huntEvent` phase 'call' with the draw
 *   time, the volunteers count (at most every 2 s) and their own `you` (volunteered, eligible, why).
 * - **Volunteers** (`pilotVolunteer {on}`): eligible characters (lottery.ts), one entry per account (pilot_volunteers).
 * - **The draw** (`next`, at `callEndsAt`): volunteers offline, dead or no longer eligible are skipped (their row says
 *   why); one is drawn by weight from the module's seeded stream and offered the turn (`acceptSec`); a decline, a
 *   timeout or a player who leaves draws the next one, up to `maxDraws`. Nobody left: `no_volunteers`, and she spawns
 *   as her normal AI self if she is not alive.
 * - **The schedule** (`schedule`): weekly slots in the server's zone (or `schedule.tz`); the call opens at
 *   slot − call.minutes. A call that should have opened while the server was down opens at boot when it is at most
 *   30 min late (with the time left, at least 3 min), else that night is skipped and logged.
 * - **Restarts** (`resume`): a call resumes (ending at least 3 min after boot when less than 2 min were left; its
 *   volunteers kept); a draw goes back to drawing 3 min after boot (an open offer is drawable again, a decline stays).
 */

/** The English line of each reason (the actionResult message; the client's banner uses `pilot.call.why.*`). */
export const WHY_TEXT: Readonly<Record<PilotIneligible, string>> = {
  level: 'Your level is too low to volunteer.',
  playtime: 'You need more play time to volunteer.',
  cooldown: 'You steered her recently: wait a few more days.',
  recent: 'You steered her in one of the last nights.',
  blocked: 'You cannot volunteer right now.',
  dead: 'Revive first to volunteer.',
  busy: 'Finish what you are doing to volunteer.',
}

/** A Night of the Tiger due during a Siege of Jangan waits this long, at most this many times (docs/SIEGE.md §6.7). */
export const SIEGE_WAIT_MS = 30 * 60_000
export const SIEGE_WAITS = 3

export class Lottery {
  private readonly scheds = new Map<string, { key: string; next: number | null; waits?: number; waitUntil?: number }>()
  private recentCache: { n: number; at: number; set: Set<number> } | null = null

  constructor(readonly s: Pilot) {}

  private get g() {
    return this.s.g
  }

  private get store() {
    return this.s.store
  }

  // ---- eligibility ---------------------------------------------------------------------------------------------

  /** In a trance (steering), a trade or a stall: the reason 'busy'. */
  busy(p: Player): boolean {
    return !!p.trance || this.s.turnOf(p) !== null || this.g.trade.isTrading(p) || this.g.stalls.stallOf(p) !== undefined
  }

  /** The accounts of the last `n` counted turns (cached for 2 s: the call re-checks every player that often). */
  private recent(n: number, now: number): Set<number> {
    const c = this.recentCache
    if (c && c.n === n && now - c.at < 2000 && now >= c.at) return c.set
    const set = this.store.recentPilots(n)
    this.recentCache = { n, at: now, set }
    return set
  }

  /** A turn ended or was refunded: the recent-turns cache is stale. */
  forgetRecent(): void {
    this.recentCache = null
  }

  facts(conf: PilotConf, characterId: number, now: number, p: Player | null): EligibilityFacts {
    const acc = this.s.accountOf(characterId)
    const row = this.g.store.characterById(characterId)
    const block = acc === null ? undefined : this.store.blockOf(acc)
    return {
      level: p?.level ?? row?.level ?? 0,
      playedMs: row?.played_ms ?? 0,
      dead: p ? p.dead : !!row?.dead,
      busy: p ? this.busy(p) : false,
      blockedUntil: block?.until ?? null,
      lastTurnAt: acc === null ? null : this.store.lastTurnAt(acc),
      recent: acc !== null && this.recent(conf.settings.eligibility.recentEvents, now).has(acc),
    }
  }

  why(conf: PilotConf, p: Player, now: number): PilotIneligible | null {
    return ineligible(this.facts(conf, p.characterId, now, p), conf.settings.eligibility, now)
  }

  /** The per-recipient part of the call's huntEvent. */
  you(ev: HuntEvent, p: Player, now: number): NonNullable<HuntEventView['you']> {
    const row = this.store.volunteerOf(ev.id, this.s.accountOf(p.characterId) ?? 0)
    const volunteered = row?.character_id === p.characterId
    const why = this.why(ev.conf, p, now)
    return why ? { volunteered, eligible: false, why } : { volunteered, eligible: true }
  }

  /** GET /api/admin/boss/eligibility: a character by name, online or not. null = no such character. */
  eligibilityOf(conf: PilotConf, name: string, now: number): PilotEligibilityView | null {
    const row = this.g.store.characterByName(name.replace(/^@/, ''))
    if (!row) return null
    const p = [...this.g.world.players.values()].find((q) => q.characterId === row.id) ?? null
    const f = this.facts(conf, row.id, now, p)
    const why = ineligible(f, conf.settings.eligibility, now)
    const out: PilotEligibilityView = {
      character: row.name,
      account: row.account_id,
      online: p !== null,
      level: f.level,
      eligible: why === null,
      playedHours: Math.round((f.playedMs / HOUR_MS) * 10) / 10,
      lastTurnAt: f.lastTurnAt,
      blockedUntil: f.blockedUntil !== null && f.blockedUntil > now ? f.blockedUntil : null,
      weight: drawWeight(f.lastTurnAt !== null, conf.settings.eligibility),
    }
    if (why) out.why = why
    return out
  }

  // ---- volunteers ------------------------------------------------------------------------------------------------

  /** `pilotVolunteer {on}` (§4.5): volunteer (eligible, one entry per account) or withdraw, during the call only. */
  volunteer(p: Player, on: boolean, now: number): Fail | true {
    const ev = this.s.event
    if (!ev || ev.phase !== 'call') return fail('no_event', 'There is no call for volunteers now.')
    const acc = this.s.accountOf(p.characterId) ?? 0
    if (!on) {
      if (this.store.withdraw(ev.id, acc, p.characterId)) {
        this.store.log(ev.id, 'withdraw', { name: p.name, character: p.characterId }, now)
        ev.volunteers = this.store.volunteerCount(ev.id)
      }
      this.s.sendEventTo(ev, p, now)
      this.s.broadcastEvent(ev, now)
      return true
    }
    const why = this.why(ev.conf, p, now)
    if (why) {
      this.s.sendEventTo(ev, p, now)
      return fail('not_eligible', WHY_TEXT[why])
    }
    const r = this.store.volunteer(ev.id, acc, p.characterId, now)
    if (r === 'other') return fail('not_eligible', 'Another character of your account has volunteered already.')
    if (r === 'added') {
      this.store.log(ev.id, 'volunteer', { name: p.name, character: p.characterId, account: acc }, now)
      ev.volunteers = this.store.volunteerCount(ev.id)
    }
    this.s.sendEventTo(ev, p, now)
    this.s.broadcastEvent(ev, now)
    return true
  }

  // ---- the call and the draw -------------------------------------------------------------------------------------

  /** Her spawn timer waits until the last possible offer of this event has run out. */
  hold(ev: HuntEvent): void {
    const c = ev.conf.settings.call
    this.s.uniques.hold(ev.conf.code, Math.max(ev.callEndsAt, ev.drawAt) + c.maxDraws * c.acceptSec * 1000 + HOLD_SLACK_MS)
  }

  /** A call opens now (§2.2); `endsAt` defaults to now + `minutes`. */
  open(conf: PilotConf, origin: HuntEvent['origin'], minutes: number, now: number, endsAt?: number): HuntEvent {
    const id = this.store.create(conf.code, origin, 'call', now)
    const ev = this.s.makeEvent(id, conf, origin, 'call', now)
    ev.fromCall = true
    ev.callEndsAt = Math.round(endsAt ?? now + minutes * 60_000)
    this.store.update(id, { call_ends_at: ev.callEndsAt })
    this.store.log(id, 'call', { origin, callEndsAt: ev.callEndsAt }, now)
    this.s.event = ev
    this.hold(ev)
    this.s.broadcastEvent(ev, now, true)
    this.g.config.log(`pilot: event ${id} (${origin}): the call for ${conf.name} opens; the draw in ${Math.round((ev.callEndsAt - now) / 1000)} s`)
    return ev
  }

  /** The call ends: the draw. */
  close(ev: HuntEvent, now: number): void {
    ev.phase = 'offer'
    ev.volunteers = this.store.volunteerCount(ev.id)
    this.store.update(ev.id, { phase: 'draw' })
    this.store.log(ev.id, 'draw', { volunteers: ev.volunteers }, now)
    this.next(ev, now)
  }

  /** Draws the next volunteer and offers the turn; nobody left (or `maxDraws` reached): no_volunteers. */
  next(ev: HuntEvent, now: number): void {
    ev.offer = null
    ev.drawAt = 0
    const e = ev.conf.settings
    if (ev.draws >= e.call.maxDraws) return this.s.noVolunteers(ev, now, 'max_draws')
    const online = new Map<number, Player>()
    for (const p of this.g.world.players.values()) online.set(p.characterId, p)
    const pool: { account: number; p: Player; weight: number }[] = []
    for (const r of this.store.volunteers(ev.id)) {
      if (r.draw !== null) continue
      const p = online.get(r.character_id)
      const why = p ? this.why(ev.conf, p, now) : 'offline'
      if (!p || why) {
        this.store.setDraw(ev.id, r.account_id, `skipped:${why}`)
        continue
      }
      pool.push({ account: r.account_id, p, weight: drawWeight(this.store.lastTurnAt(r.account_id) !== null, e.eligibility) })
    }
    const pick = drawWeighted(pool, (x) => x.weight, this.s.rng)
    if (!pick) return this.s.noVolunteers(ev, now, 'nobody left')
    ev.draws++
    this.store.setDraw(ev.id, pick.account, 'offered')
    this.s.offerTo(ev, pick.p, now, true)
  }

  // ---- the schedule --------------------------------------------------------------------------------------------

  /** The next scheduled night of `conf` (the slot: the draw, server ms), or null (off, no slots). */
  nextNight(conf: PilotConf): number | null {
    return this.scheds.get(conf.code)?.next ?? null
  }

  /**
   * The weekly schedule, every tick: the call of the next slot opens at slot − call.minutes. `boot`: the first pass
   * after a start also opens a call that is at most 30 min late (§2.4) and logs an older missed night.
   */
  schedule(conf: PilotConf, now: number, boot = false): void {
    const st = conf.settings
    const callMs = st.call.minutes * 60_000
    const key = JSON.stringify([st.enabled, st.schedule, st.call.minutes])
    let sc = this.scheds.get(conf.code)
    if (!sc || sc.key !== key) {
      sc = { key, next: st.enabled ? nextSlotAt(st.schedule.slots, st.schedule.tz, now + callMs - (boot ? MISSED_GRACE_MS : 0)) : null }
      this.scheds.set(conf.code, sc)
      if (boot && st.enabled) this.missed(conf, now)
    }
    if (sc.next === null) return
    const slot = sc.next
    const callAt = slot - callMs
    if (now < Math.max(callAt, sc.waitUntil ?? 0)) return
    // Siege of Jangan (docs/SIEGE.md §6.7): one big event at a time; a night due during a siege waits 30 min (3 times)
    const siege = this.g.siege?.busyWhy() ?? null
    if (siege && (sc.waits ?? 0) < SIEGE_WAITS) {
      sc.waits = (sc.waits ?? 0) + 1
      sc.waitUntil = now + SIEGE_WAIT_MS
      this.g.config.log(`pilot: the Night of the Tiger of ${new Date(slot).toISOString()} waits 30 min: ${siege}`)
      return
    }
    const waited = sc.waits ? (sc.waitUntil ?? callAt) : callAt
    sc.waits = 0
    sc.waitUntil = 0
    sc.next = nextSlotAt(st.schedule.slots, st.schedule.tz, slot)
    if (siege) {
      this.g.config.log(`pilot: the Night of the Tiger of ${new Date(slot).toISOString()} is skipped: ${siege}`)
      return
    }
    const late = now - waited
    const when = new Date(slot).toISOString()
    if (late > MISSED_GRACE_MS) {
      this.g.config.log(`pilot: the Night of the Tiger of ${when} is ${Math.round(late / 60_000)} min late (the server was down or the clock jumped); skipped`)
      return
    }
    // A call of this night exists already (resumed after a restart, or a GM / admin started one).
    if (this.store.createdSince(callAt - 60_000) > 0) return
    const why = this.s.busyWhy(conf)
    if (why) {
      this.g.config.log(`pilot: the Night of the Tiger of ${when} is skipped: ${why}`)
      return
    }
    this.open(conf, 'schedule', st.call.minutes, now, waited !== callAt ? now + callMs : late > 1000 ? Math.max(slot, now + RESUME_MS) : slot)
  }

  /** Boot: the newest night whose call should have opened more than 30 min ago and has no event is logged as skipped. */
  private missed(conf: PilotConf, now: number): void {
    const st = conf.settings
    const callMs = st.call.minutes * 60_000
    const past = slotsBetween(st.schedule.slots, st.schedule.tz, now - 7 * DAY_MS, now + callMs - MISSED_GRACE_MS)
    const last = past.at(-1)
    if (last !== undefined && this.store.createdSince(last - callMs - 60_000) === 0) {
      this.g.config.log(`pilot: the Night of the Tiger of ${new Date(last).toISOString()} was missed while the server was down; skipped`)
    }
  }

  // ---- restarts ---------------------------------------------------------------------------------------------------

  /** A call or a draw found open at boot resumes (§2.4). */
  resume(r: PilotEventRow, conf: PilotConf, now: number): HuntEvent {
    const origin = r.origin === 'schedule' || r.origin === 'admin' ? r.origin : 'gm'
    const ev = this.s.makeEvent(r.id, conf, origin, 'call', r.created_at)
    ev.fromCall = true
    ev.callEndsAt = r.call_ends_at ?? now
    if (r.phase === 'call') {
      if (ev.callEndsAt < now + RESUME_MIN_MS) ev.callEndsAt = now + RESUME_MS
      this.store.update(r.id, { call_ends_at: ev.callEndsAt })
      this.store.log(r.id, 'restart', { phase: 'call', callEndsAt: ev.callEndsAt }, now)
    } else {
      ev.phase = 'offer'
      ev.drawAt = now + RESUME_MS
      this.store.resetOffered(r.id)
      ev.draws = this.store.volunteers(r.id).filter((v) => v.draw === 'declined' || v.draw === 'timeout' || v.draw === 'left').length
      this.store.log(r.id, 'restart', { phase: 'draw', drawAt: ev.drawAt }, now)
    }
    ev.volunteers = this.store.volunteerCount(r.id)
    this.s.event = ev
    this.hold(ev)
    this.g.config.log(`pilot: event ${r.id} (${r.phase}) resumes after the restart: ${ev.phase === 'call' ? 'the draw' : 'drawing'} in ${Math.round((Math.max(ev.callEndsAt, ev.drawAt) - now) / 1000)} s, ${ev.volunteers} volunteers`)
    return ev
  }

  // ---- blocks -----------------------------------------------------------------------------------------------------

  /** An account by id ('#12' or '12'), character name or account username; null = none. */
  account(q: string): { id: number; label: string } | null {
    const s = q.trim().replace(/^@/, '')
    const num = /^#?(\d{1,12})$/.exec(s)
    if (num) {
      const a = this.g.store.accountById(Number(num[1]))
      return a ? { id: a.id, label: a.username } : null
    }
    const c = this.g.store.characterByName(s)
    if (c) return { id: c.account_id, label: c.name }
    const a = this.g.store.accountByName(s)
    return a ? { id: a.id, label: a.username } : null
  }

  /** `pilot block` / PUT blocks: the account cannot volunteer for `days`. */
  block(q: string, days: number, reason: string, by: number | null, now: number): { ok: true; message: string; account: number } | { ok: false; status: number; message: string } {
    const a = this.account(q)
    if (!a) return { ok: false, status: 404, message: `No character or account named ${q}.` }
    if (!(days > 0 && days <= 3650)) return { ok: false, status: 400, message: 'days must be more than 0 and at most 3650.' }
    const until = Math.round(now + days * DAY_MS)
    this.store.block(a.id, until, reason.slice(0, 200), by, now)
    this.g.config.log(`pilot: account ${a.id} (${a.label}) blocked from the lottery until ${new Date(until).toISOString()}`)
    return { ok: true, account: a.id, message: `${a.label}'s account cannot volunteer for ${days} day${days === 1 ? '' : 's'} (until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC).` }
  }

  unblock(q: string): { ok: true; message: string; account: number } | { ok: false; status: number; message: string } {
    const a = this.account(q)
    if (!a) return { ok: false, status: 404, message: `No character or account named ${q}.` }
    if (!this.store.unblock(a.id)) return { ok: false, status: 404, message: `${a.label}'s account is not blocked.` }
    return { ok: true, account: a.id, message: `${a.label}'s account may volunteer again.` }
  }
}
