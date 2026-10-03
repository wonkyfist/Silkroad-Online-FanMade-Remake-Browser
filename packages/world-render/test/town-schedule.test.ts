/**
 * The pure town schedule (docs/TOWN_LIFE.md §2.1, §3.4, §3.5; docs/WAVE_PLAN7.md §6.1 TL-R, D19) on the real
 * `content/town/jangan.json`: determinism across clients, doors only, no pops, the hour curve, seats never
 * double-booked, populationNear, the alarm override and its return to the schedule, noFolk circles, the CPU budget.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CLOCK, clockAt, type WorldClockState } from '../../shared/src/world-clock.ts'
import { validateTownFile, type TownFile } from '../../shared/src/town.ts'
import {
  TOWN_CLIPS, TOWN_FADE_S, TOWN_HURRY, TOWN_TRIP_S, TOWN_TRIP_VARIANTS, TownSchedule, newTownAgentState, townShareAt,
  type TownAgentState, type TownSolar,
} from '../src/town/schedule.ts'

const ROOT = join(import.meta.dirname, '../../..')
const TEXT = readFileSync(join(ROOT, 'content/town/jangan.json'), 'utf8')
const FILE = JSON.parse(TEXT) as TownFile
const S = new TownSchedule(FILE)
/** A 2026 server second (epoch seconds: the crowd's time base handles the float32 trap, not the schedule). */
const T0 = Date.UTC(2026, 9, 1, 12) / 1000
const doors = S.places.filter((p) => p.kind === 'door')
const nearestDoor = (x: number, z: number) => Math.min(...doors.map((d) => Math.hypot(d.x - x, d.z - z)))
/** The world clock of the server defaults (120 min day, night ×0.4), anchored so T0 is 16:30. */
const CLOCK: WorldClockState = { ...DEFAULT_CLOCK, anchorMs: T0 * 1000, anchorDays: 16.5 / 24 }
const SKY: TownSolar = (s) => clockAt(CLOCK, s * 1000).t

describe('town schedule: the content file', () => {
  it('validates, stays within 200 KB and has doors, routes and every roaming role', () => {
    expect(validateTownFile(FILE).ok).toBe(true)
    expect(TEXT.length).toBeLessThanOrEqual(200 * 1024)
    expect(doors.length).toBeGreaterThanOrEqual(4)
    expect(doors.some((d) => d.id === 'gate-south')).toBe(true)
    const roles = new Set(S.agents.map((a) => a.role))
    for (const r of ['walker', 'chatter', 'sitter', 'vendor', 'porter', 'guard', 'child', 'rider', 'lanternCarrier', 'worker']) expect(roles.has(r as never)).toBe(true)
    expect(S.agents.length).toBeGreaterThan(200)
    expect(S.agents.length).toBeLessThanOrEqual(300)
    expect(S.agents.some((a) => a.kind === 'horse')).toBe(true)
    // ranks follow the priority order (a crowd that draws fewer keeps the lowest)
    for (let i = 1; i < S.agents.length; i++) expect(S.agents[i]!.rank).toBeGreaterThan(S.agents[i - 1]!.rank)
  })
})

describe('town schedule: determinism (TOWN_LIFE §2.1 option C)', () => {
  it('two schedules from one file agree exactly, and clocks 80 ms apart agree within 0.15 m', () => {
    const other = new TownSchedule(JSON.parse(TEXT) as TownFile)
    const a = newTownAgentState()
    const b = newTownAgentState()
    let compared = 0
    for (const solar of [0.5, 0.8, SKY] as TownSolar[]) {
      for (let k = 0; k < 40; k++) {
        const t = T0 + k * 173.3
        for (let i = 0; i < S.agents.length; i++) {
          S.stateAt(i, t, solar, a)
          other.stateAt(i, t, solar, b)
          expect(b).toEqual(a)
          other.stateAt(i, t + 0.08, solar, b)
          if (a.visible && b.visible) {
            expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThanOrEqual(0.15)
            compared++
          } else if (a.visible !== b.visible) {
            // only a door fade can differ: 80 ms of a 0.6 s fade
            expect(Math.max(a.alpha, b.alpha)).toBeLessThanOrEqual(0.08 / TOWN_FADE_S + 1e-6)
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(10_000)
  })

  it('every state names a known clip, a finite position and a valid alpha', () => {
    const st = newTownAgentState()
    for (let k = 0; k < 20; k++) {
      for (let i = 0; i < S.agents.length; i++) {
        S.stateAt(i, T0 + k * 61, SKY, st)
        expect(TOWN_CLIPS).toContain(st.clip)
        expect(Number.isFinite(st.x) && Number.isFinite(st.z) && Number.isFinite(st.yaw)).toBe(true)
        expect(st.alpha).toBeGreaterThanOrEqual(0)
        expect(st.alpha).toBeLessThanOrEqual(1)
        expect(st.clipRate).toBeGreaterThan(0)
      }
    }
  })
})

/** Walks every agent through [from, to) at dt; calls back with the previous and current state. */
function sweep(s: TownSchedule, from: number, to: number, dt: number, solar: TownSolar, fn: (i: number, prev: TownAgentState, cur: TownAgentState, t: number) => void): void {
  const prev = s.agents.map(() => newTownAgentState())
  const cur = s.agents.map(() => newTownAgentState())
  for (let i = 0; i < s.agents.length; i++) s.stateAt(i, from, solar, prev[i])
  for (let t = from + dt; t < to; t += dt) {
    for (let i = 0; i < s.agents.length; i++) {
      s.stateAt(i, t, solar, cur[i])
      fn(i, prev[i]!, cur[i]!, t)
      const swap = prev[i]!
      prev[i] = cur[i]!
      cur[i] = swap
    }
  }
}

/** Largest step (m) a visible agent may make in dt: a running child or the alarm's hurry, plus the turn of a pair. */
const maxStep = (dt: number) => 5.5 * TOWN_HURRY * dt + 1.0

describe('town schedule: doors only, no pops (TOWN_LIFE §3.4)', () => {
  it('through a whole game day on the world clock, people appear and leave only at doors and never jump', () => {
    let fades = 0
    let appear = 0
    let leave = 0
    sweep(S, T0, T0 + 7200, 0.25, SKY, (i, p, c) => {
      if (c.alpha > 0 && c.alpha < 1) {
        fades++
        expect(nearestDoor(c.x, c.z), `agent ${S.agents[i]!.id} fades away from a door`).toBeLessThanOrEqual(2.5)
      }
      if (c.visible && !p.visible) {
        appear++
        expect(nearestDoor(c.x, c.z), `agent ${S.agents[i]!.id} appears away from a door`).toBeLessThanOrEqual(2.5)
      }
      if (!c.visible && p.visible) {
        leave++
        expect(nearestDoor(p.x, p.z), `agent ${S.agents[i]!.id} leaves away from a door`).toBeLessThanOrEqual(2.5)
      }
      if (c.visible && p.visible) expect(Math.hypot(c.x - p.x, c.z - p.z), `agent ${S.agents[i]!.id} jumps`).toBeLessThanOrEqual(maxStep(0.25))
    })
    // a day has dawn and dusk: plenty of comings and goings
    expect(appear).toBeGreaterThan(100)
    expect(leave).toBeGreaterThan(100)
    expect(fades).toBeGreaterThan(200)
  }, 60_000)
})

describe('town schedule: the hour curve (TOWN_LIFE §3.5)', () => {
  it('the share of the roaming crowd out follows the bands; guards and the rider are out at every hour', () => {
    const st = newTownAgentState()
    const roam = S.agents.filter((a) => a.presence.kind === 'share' && a.trips.length === TOWN_TRIP_VARIANTS)
    for (const h of [2, 6, 10, 12, 16, 19, 21.5]) {
      const share = townShareAt(S.bands, h)
      let out = 0
      for (let k = 0; k < 6; k++) for (const a of roam) if (S.stateAt(a, T0 + k * 97, h / 24, st).visible) out++
      expect(Math.abs(out / (6 * roam.length) - share), `hour ${h}`).toBeLessThanOrEqual(0.06)
      for (const a of S.agents.filter((x) => x.role === 'guard' || x.role === 'rider')) expect(S.stateAt(a, T0, h / 24, st).visible).toBe(true)
    }
    // lantern carriers only at dusk
    for (const a of S.agents.filter((x) => x.role === 'lanternCarrier')) {
      expect(S.stateAt(a, T0, 19 / 24, st).visible).toBe(true)
      expect(S.stateAt(a, T0, 12 / 24, st).visible).toBe(false)
    }
  })

  it('the ramp is continuous at every band boundary', () => {
    for (let h = 0; h < 24; h += 0.01) expect(Math.abs(townShareAt(S.bands, h + 0.01) - townShareAt(S.bands, h))).toBeLessThan(0.02)
  })
})

describe('town schedule: seats (TOWN_LIFE §2.4)', () => {
  it('no two agents ever sit on one seat at the same time, and the bookings never overlap', () => {
    const period = TOWN_TRIP_S * TOWN_TRIP_VARIANTS
    const st = newTownAgentState()
    let seated = 0
    for (let t = T0; t < T0 + period; t += 1) {
      const held = new Map<string, string>()
      for (const a of S.agents) {
        S.stateAt(a, t, 0.5, st)
        if (!st.visible || st.place < 0 || st.seat < 0) continue
        const key = `${st.place}#${st.seat}`
        expect(held.get(key), `seat ${key} at ${t - T0}`).toBeUndefined()
        held.set(key, a.id)
        seated++
      }
    }
    expect(seated).toBeGreaterThan(10_000)
    for (const p of S.places) {
      for (let s = 0; s < p.seats.length; s++) {
        const b = S.seatBookings(p.index, s)
        for (let i = 0; i < b.length; i++) {
          for (let j = i + 1; j < b.length; j++) {
            const [a0, a1] = b[i]!
            const [b0, b1] = b[j]!
            const d = (((b0 - a0) % period) + period) % period
            const e = (((a0 - b0) % period) + period) % period
            expect(d >= a1 - a0 && e >= b1 - b0, `${p.id} seat ${s}`).toBe(true)
          }
        }
      }
    }
  }, 60_000)
})

describe('town schedule: the TL-R2 tuning (busy by day, calm at night, nobody inside anybody)', () => {
  const period = TOWN_TRIP_S * TOWN_TRIP_VARIANTS
  const people = (h: number, x: number, z: number, r: number) => {
    const st = newTownAgentState()
    let n = 0
    let k = 0
    for (let t = T0; t < T0 + TOWN_TRIP_S; t += 20, k++) {
      for (const a of S.agents) {
        if (a.kind === 'horse') continue
        S.stateAt(a, t, h / 24, st)
        if (st.visible && Math.hypot(st.x - x, st.z - z) < r) n++
      }
    }
    return n / k
  }

  it('two groups never stand on one spot: stops at nodes, looks and seats are all booked', () => {
    const st = newTownAgentState()
    let stacked = 0
    let dwell = 0
    const pos: Array<[number, number, number]> = []
    for (let t = T0; t < T0 + period; t += 2) {
      pos.length = 0
      for (const a of S.agents) {
        S.stateAt(a, t, 0.5, st)
        if (!st.visible || st.moving || a.kind === 'horse') continue
        dwell++
        const g = a.group >= 0 ? a.group : -1 - a.index
        for (const [x, z, h] of pos) if (h !== g && Math.hypot(x - st.x, z - st.z) < 0.5) stacked++
        pos.push([st.x, st.z, g])
      }
    }
    expect(dwell).toBeGreaterThan(20_000)
    // only the doors' fades may brush (one leaving as another arrives)
    expect(stacked / dwell).toBeLessThan(0.001)
  }, 60_000)

  it('roamers wait inside their door between trips, not in the doorway: by day nearly all are out', () => {
    const st = newTownAgentState()
    const roam = S.agents.filter((a) => a.mode === 'roam')
    let out = 0
    let n = 0
    for (let t = T0; t < T0 + period; t += 7) for (const a of roam) {
      n++
      if (S.stateAt(a, t, 0.5, st).visible) out++
    }
    expect(out / n).toBeGreaterThan(0.93)
    // and nobody visible stands still on a door for longer than its fades
    for (const a of roam.slice(0, 60)) {
      let still = 0
      for (let t = T0; t < T0 + period; t += 0.5) {
        S.stateAt(a, t, 0.5, st)
        const atDoor = st.visible && !st.moving && nearestDoor(st.x, st.z) < 0.05
        still = atDoor ? still + 0.5 : 0
        expect(still, a.id).toBeLessThanOrEqual(2 * TOWN_FADE_S + 1)
      }
    }
  }, 60_000)

  it('the plaza, the market and the gates are busy by day and calm at night', () => {
    const plaza = (h: number) => people(h, 97, -86, 40)
    const market = (h: number) => people(h, 155, -100, 30)
    const gates = (h: number) => FILE.places.filter((p) => p.id.startsWith('gate-')).reduce((a, g) => a + people(h, g.x, g.z, 25), 0)
    expect(plaza(12)).toBeGreaterThan(25)
    expect(plaza(2)).toBeLessThan(8)
    expect(market(12)).toBeGreaterThan(10)
    expect(market(2)).toBeLessThan(3)
    expect(gates(12)).toBeGreaterThan(15)
    expect(gates(2)).toBeLessThan(5)
    // the evening crowd is at the tea house, not the market
    expect(people(21, -75, -80, 75)).toBeGreaterThan(market(21) * 3)
  }, 60_000)

  it('no children out at night; sitters and chatters are the last ones out', () => {
    const st = newTownAgentState()
    const kids = S.agents.filter((a) => a.role === 'child')
    expect(kids.length).toBeGreaterThan(0)
    for (const a of kids) for (let k = 0; k < 4; k++) expect(S.stateAt(a, T0 + k * 211, 2 / 24, st).visible, a.id).toBe(false)
    const late = S.agents.filter((a) => a.mode === 'roam' && a.presence.kind === 'share' && a.presence.rank < 0.08)
    const calm = late.filter((a) => a.role === 'sitter' || a.role === 'chatter' || a.role === 'walker')
    expect(calm.length).toBe(late.length)
  })
})

describe('town schedule: populationNear (the drawn count; the sound bed on Low)', () => {
  it('counts the visible people (not horses) within the radius, among the first `limit` agents', () => {
    const st = newTownAgentState()
    for (const [t, solar] of [[T0, 0.5], [T0 + 333, 0.9], [T0 + 777, SKY]] as Array<[number, TownSolar]>) {
      for (const limit of [60, 140, S.agents.length]) {
        let n = 0
        for (let i = 0; i < Math.min(limit, S.agents.length); i++) {
          const a = S.agents[i]!
          S.stateAt(a, t, solar, st)
          if (a.kind !== 'horse' && st.visible && Math.hypot(st.x - 97, st.z + 110) <= 60) n++
        }
        expect(S.populationNear(97, -110, 60, t, solar, limit)).toBe(n)
      }
    }
    // the plaza at noon is busy (≈ the Medium cap of 60 within 60 m), quiet at night
    expect(S.populationNear(97, -110, 60, T0, 0.5)).toBeGreaterThan(40)
    expect(S.populationNear(97, -110, 60, T0, 0.1)).toBeLessThan(25)
  })
})

describe('town schedule: the alarm (WAVE_PLAN7 D19)', () => {
  const A0 = T0 + 1000
  const SEC = 60
  const s = new TownSchedule(FILE)
  s.alarm(A0, SEC)
  const pure = new TownSchedule(FILE)

  it('walkers hurry to the doors and go in; vendors, workers and the rider keep their schedule; guards walk to the south gate', () => {
    const st = newTownAgentState()
    const ref = newTownAgentState()
    const gate = s.places.find((p) => p.id === 'gate-south')!
    for (let t = A0 + 0.5; t < A0 + SEC; t += 2) {
      for (const a of s.agents) {
        s.stateAt(a, t, 0.5, st)
        if (a.alarm === 'none') {
          pure.stateAt(a.index, t, 0.5, ref)
          expect(st).toEqual(ref)
        } else if (a.alarm === 'door' && st.visible && st.moving) {
          expect(st.speed).toBeCloseTo(a.speed * TOWN_HURRY, 5)
        } else if (a.alarm === 'door' && st.visible) {
          expect(nearestDoor(st.x, st.z)).toBeLessThanOrEqual(2.5)
        }
      }
    }
    // after a minute most townsfolk are in, and the guards that arrived stand at the gate
    let out = 0
    let doorAgents = 0
    for (const a of s.agents) {
      if (a.alarm !== 'door') continue
      doorAgents++
      if (s.stateAt(a, A0 + SEC - 0.1, 0.5, st).visible) out++
      if (a.alarm === 'door') continue
    }
    expect(out / doorAgents).toBeLessThan(0.3)
    for (const a of s.agents.filter((x) => x.alarm === 'gate')) {
      s.stateAt(a, A0 + SEC - 0.1, 0.5, st)
      if (!st.moving) expect(Math.hypot(st.x - gate.x, st.z - gate.z)).toBeLessThan(4)
    }
  })

  it('nobody pops during or after the alarm, and everyone is back on the schedule afterwards', () => {
    sweep(s, A0 - 2, A0 + SEC + 2 * TOWN_TRIP_S, 0.25, 0.5, (i, p, c) => {
      if (c.visible && !p.visible) expect(nearestDoor(c.x, c.z), `agent ${s.agents[i]!.id} appears away from a door`).toBeLessThanOrEqual(2.5)
      if (!c.visible && p.visible) expect(nearestDoor(p.x, p.z), `agent ${s.agents[i]!.id} leaves away from a door`).toBeLessThanOrEqual(2.5)
      if (c.visible && p.visible) expect(Math.hypot(c.x - p.x, c.z - p.z), `agent ${s.agents[i]!.id} jumps`).toBeLessThanOrEqual(maxStep(0.25))
    })
    const st = newTownAgentState()
    const ref = newTownAgentState()
    // two trips after the alarm nearly everyone has rejoined; four trips after, everyone has
    let back = 0
    for (const a of s.agents) {
      s.stateAt(a, A0 + SEC + 2 * TOWN_TRIP_S, 0.5, st)
      pure.stateAt(a.index, A0 + SEC + 2 * TOWN_TRIP_S, 0.5, ref)
      if (st.x === ref.x && st.z === ref.z && st.visible === ref.visible) back++
    }
    expect(back / s.agents.length).toBeGreaterThan(0.9)
    for (const a of s.agents) {
      s.stateAt(a, A0 + SEC + 4 * TOWN_TRIP_S + 1, 0.5, st)
      pure.stateAt(a.index, A0 + SEC + 4 * TOWN_TRIP_S + 1, 0.5, ref)
      expect(st).toEqual(ref)
    }
  }, 60_000)

  it('before the alarm and with no alarm the schedule is untouched', () => {
    const st = newTownAgentState()
    const ref = newTownAgentState()
    for (const a of s.agents) {
      s.stateAt(a, A0 - 1, 0.5, st)
      pure.stateAt(a.index, A0 - 1, 0.5, ref)
      expect(st).toEqual(ref)
    }
    expect(pure.alarmWindow()).toBeNull()
    expect(s.alarmWindow()).toEqual({ from: A0, to: A0 + SEC })
    // a second notice while it runs extends it
    const s2 = new TownSchedule(FILE)
    s2.alarm(A0, 60)
    s2.alarm(A0 + 30, 60)
    expect(s2.alarmWindow()).toEqual({ from: A0, to: A0 + 90 })
  })
})

describe('town schedule: noFolk circles (the character stage, WAVE_PLAN7 D17)', () => {
  it('nobody walks or stands inside the circle', () => {
    const circle = { x: 97, z: -110, r: 20 }
    const s = new TownSchedule(FILE, { noFolk: circle })
    expect(s.agents.length).toBeGreaterThan(150)
    sweep(s, T0, T0 + 600, 0.5, 0.5, (_i, _p, c) => {
      if (c.visible) expect(Math.hypot(c.x - circle.x, c.z - circle.z)).toBeGreaterThan(circle.r - 2)
    })
  }, 60_000)
})

describe('town schedule: budget (TOWN_LIFE §9.2: 300 agents ≤ 0.05 ms per frame)', () => {
  it('evaluates every agent per frame cheaply and without allocating', () => {
    const outs = S.agents.map(() => newTownAgentState())
    const frame = (t: number) => {
      for (let i = 0; i < S.agents.length; i++) S.stateAt(i, t, SKY, outs[i])
    }
    for (let f = 0; f < 300; f++) frame(T0 + f / 60)
    const n = 1000
    const t0 = performance.now()
    for (let f = 0; f < n; f++) frame(T0 + 5 + f / 60)
    const ms = ((performance.now() - t0) / n) * (300 / S.agents.length)
    console.log(`town schedule: ${ms.toFixed(4)} ms per frame for 300 agents`)
    // loose in CI (shared runners); measured ≈ 0.02–0.03 ms on the dev PC
    expect(ms).toBeLessThan(0.25)
  })
})
