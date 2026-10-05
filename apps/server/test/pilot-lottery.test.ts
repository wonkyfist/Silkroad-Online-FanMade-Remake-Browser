/**
 * Play the Boss, layer 4's pure parts (docs/PLAY_THE_BOSS.md §3.9, §2.4, §6.2; pilot/lottery.ts): each eligibility
 * reason in the client's order, the weighted draw on a seeded stream (first-timers ×3), and the weekly schedule in an
 * IANA zone: the next slot across the autumn and spring DST changes in two zones (Europe/Berlin, America/New_York), a
 * wall time the spring gap skips, the autumn fold, and the server's own zone for ''.
 */
import { PILOT_DEFAULTS, mulberry32 } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { DAY_MS, HOUR_MS, drawWeight, drawWeighted, ineligible, nextSlotAt, slotsBetween, wallClock, wallToUtc, zoneOf, zoneOffset, type EligibilityFacts } from '../src/pilot/lottery.ts'

const E = PILOT_DEFAULTS.eligibility
const NOW = Date.UTC(2026, 9, 5, 12)
const OK: EligibilityFacts = { level: 20, playedMs: 10 * HOUR_MS, dead: false, busy: false, blockedUntil: null, lastTurnAt: null, recent: false }

describe('eligibility (§3.9)', () => {
  it('level, play time, cooldown, recent turns, block, death, busy; each reason alone and in the client order', () => {
    expect(ineligible(OK, E, NOW)).toBeNull()
    expect(ineligible({ ...OK, level: 19 }, E, NOW)).toBe('level')
    expect(ineligible({ ...OK, playedMs: 10 * HOUR_MS - 1 }, E, NOW)).toBe('playtime')
    expect(ineligible({ ...OK, lastTurnAt: NOW - 13 * DAY_MS }, E, NOW)).toBe('cooldown')
    expect(ineligible({ ...OK, lastTurnAt: NOW - 14 * DAY_MS }, E, NOW)).toBeNull()
    expect(ineligible({ ...OK, recent: true }, E, NOW)).toBe('recent')
    expect(ineligible({ ...OK, blockedUntil: NOW + 1 }, E, NOW)).toBe('blocked')
    expect(ineligible({ ...OK, blockedUntil: NOW }, E, NOW)).toBeNull()
    expect(ineligible({ ...OK, dead: true }, E, NOW)).toBe('dead')
    expect(ineligible({ ...OK, busy: true }, E, NOW)).toBe('busy')
    // Several at once: the first in the client's order.
    expect(ineligible({ ...OK, level: 1, dead: true, blockedUntil: NOW + 1 }, E, NOW)).toBe('level')
    // The numbers are settings: no play time needed, no cooldown.
    expect(ineligible({ ...OK, playedMs: 0, lastTurnAt: NOW - 1 }, { ...E, minPlayHours: 0, cooldownDays: 0 }, NOW)).toBeNull()
  })

  it('the draw weight: firstTimerWeight for an account that never steered her, else 1', () => {
    expect(drawWeight(false, E)).toBe(3)
    expect(drawWeight(true, E)).toBe(1)
    expect(drawWeight(false, { ...E, firstTimerWeight: 1 })).toBe(1)
  })
})

describe('the draw (§3.9)', () => {
  it('is exact on a seeded stream and fair by weight: a first-timer is drawn about 3× as often', () => {
    const list = [{ id: 'first', w: 3 }, { id: 'old1', w: 1 }, { id: 'old2', w: 1 }]
    const a = mulberry32(42)
    const b = mulberry32(42)
    const runA = Array.from({ length: 20 }, () => drawWeighted(list, (x) => x.w, a)!.id)
    const runB = Array.from({ length: 20 }, () => drawWeighted(list, (x) => x.w, b)!.id)
    expect(runA).toEqual(runB)
    const rng = mulberry32(7)
    const n = { first: 0, old1: 0, old2: 0 } as Record<string, number>
    const N = 30_000
    for (let i = 0; i < N; i++) n[drawWeighted(list, (x) => x.w, rng)!.id]++
    expect(n.first / N).toBeCloseTo(0.6, 1)
    expect(n.old1 / N).toBeCloseTo(0.2, 1)
    expect(Math.abs(n.first / n.old1 - 3)).toBeLessThan(0.25)
  })

  it('an empty pool or all weights 0: nobody; the edges of the stream', () => {
    expect(drawWeighted([], () => 1, Math.random)).toBeNull()
    expect(drawWeighted([1, 2], () => 0, Math.random)).toBeNull()
    expect(drawWeighted(['a', 'b'], () => 1, () => 0)).toBe('a')
    expect(drawWeighted(['a', 'b'], () => 1, () => 0.999999)).toBe('b')
    expect(drawWeighted(['a', 'b', 'c'], (x) => (x === 'b' ? 0 : 1), () => 0.5)).toBe('c')
  })
})

describe('time zones', () => {
  it("'' (or an unknown zone) is the server's own zone; a known zone is kept", () => {
    const server = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(zoneOf('')).toBe(server)
    expect(zoneOf('Not/AZone')).toBe(server)
    expect(zoneOf('Europe/Berlin')).toBe('Europe/Berlin')
  })

  it('offsets and wall clocks of Berlin and New York on both sides of their 2026 changes', () => {
    expect(zoneOffset('Europe/Berlin', Date.UTC(2026, 6, 1))).toBe(2 * HOUR_MS)
    expect(zoneOffset('Europe/Berlin', Date.UTC(2026, 11, 1))).toBe(HOUR_MS)
    expect(zoneOffset('America/New_York', Date.UTC(2026, 6, 1))).toBe(-4 * HOUR_MS)
    expect(zoneOffset('America/New_York', Date.UTC(2026, 11, 1))).toBe(-5 * HOUR_MS)
    expect(wallClock('Europe/Berlin', Date.UTC(2026, 9, 24, 19))).toMatchObject({ y: 2026, mo: 10, d: 24, h: 21, mi: 0 })
    // The spring gap (Berlin, 29 March 2026, 02:00 → 03:00): 02:30 does not exist; it reads as 03:30 CEST.
    expect(wallToUtc('Europe/Berlin', 2026, 3, 29, 2, 30)).toBe(Date.UTC(2026, 2, 29, 1, 30))
    // The autumn fold (Berlin, 25 October 2026, 03:00 → 02:00): 02:30 happens twice; the first one counts.
    expect(wallToUtc('Europe/Berlin', 2026, 10, 25, 2, 30)).toBe(Date.UTC(2026, 9, 25, 0, 30))
    expect(wallToUtc('America/New_York', 2026, 3, 8, 2, 30)).toBe(Date.UTC(2026, 2, 8, 7, 30))
    expect(wallToUtc('America/New_York', 2026, 11, 1, 1, 30)).toBe(Date.UTC(2026, 10, 1, 5, 30))
  })
})

describe('the weekly schedule (§2.2, §6.2)', () => {
  const SAT_21 = [{ weekday: 6, time: '21:00' }]

  it('Saturday 21:00 in Berlin across the October change: 19:00 UTC, then a week and an hour later 20:00 UTC', () => {
    const first = nextSlotAt(SAT_21, 'Europe/Berlin', Date.UTC(2026, 9, 20))!
    expect(first).toBe(Date.UTC(2026, 9, 24, 19))
    const second = nextSlotAt(SAT_21, 'Europe/Berlin', first)!
    expect(second).toBe(Date.UTC(2026, 9, 31, 20))
    expect(second - first).toBe(7 * DAY_MS + HOUR_MS)
    // Back in spring (29 March): a week minus an hour.
    const spring = nextSlotAt(SAT_21, 'Europe/Berlin', Date.UTC(2026, 2, 22))!
    expect(spring).toBe(Date.UTC(2026, 2, 28, 20))
    expect(nextSlotAt(SAT_21, 'Europe/Berlin', spring)! - spring).toBe(7 * DAY_MS - HOUR_MS)
  })

  it('Saturday 21:00 in New York across the November change: 01:00 UTC Sunday, then 02:00 UTC', () => {
    const first = nextSlotAt(SAT_21, 'America/New_York', Date.UTC(2026, 9, 27))!
    expect(first).toBe(Date.UTC(2026, 10, 1, 1))
    expect(nextSlotAt(SAT_21, 'America/New_York', first)).toBe(Date.UTC(2026, 10, 8, 2))
  })

  it('a slot inside the spring gap runs at the shifted time; the autumn fold does not run it twice', () => {
    const SUN_0230 = [{ weekday: 0, time: '02:30' }]
    expect(nextSlotAt(SUN_0230, 'Europe/Berlin', Date.UTC(2026, 2, 28))).toBe(Date.UTC(2026, 2, 29, 1, 30))
    const fold = nextSlotAt(SUN_0230, 'Europe/Berlin', Date.UTC(2026, 9, 24))!
    expect(fold).toBe(Date.UTC(2026, 9, 25, 0, 30))
    // After the first 02:30 the next one is a week later, not the repeated hour.
    expect(nextSlotAt(SUN_0230, 'Europe/Berlin', fold)).toBe(Date.UTC(2026, 10, 1, 1, 30))
  })

  it('several slots: the earliest after the instant (strictly after); none = null; UTC and the server zone', () => {
    const slots = [{ weekday: 3, time: '20:00' }, { weekday: 6, time: '21:00' }, { weekday: 3, time: '18:30' }]
    const wed = Date.UTC(2026, 9, 7, 18, 30)
    expect(nextSlotAt(slots, 'UTC', Date.UTC(2026, 9, 5))).toBe(wed)
    expect(nextSlotAt(slots, 'UTC', wed)).toBe(Date.UTC(2026, 9, 7, 20))
    expect(nextSlotAt(slots, 'UTC', Date.UTC(2026, 9, 7, 20))).toBe(Date.UTC(2026, 9, 10, 21))
    expect(nextSlotAt([], 'UTC', NOW)).toBeNull()
    const server = nextSlotAt(SAT_21, '', NOW)!
    expect(server).toBe(nextSlotAt(SAT_21, zoneOf(''), NOW))
    const w = wallClock(zoneOf(''), server)
    expect([w.h, w.mi, new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]).toEqual([21, 0, 6])
  })

  it('slotsBetween lists every instant in (from, to]', () => {
    const list = slotsBetween([{ weekday: 6, time: '21:00' }], 'UTC', Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 31, 21))
    expect(list).toEqual([3, 10, 17, 24, 31].map((d) => Date.UTC(2026, 9, d, 21)))
  })
})
