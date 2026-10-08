/**
 * The job system, layer 4 (docs/JOBS.md §6.1, §6.4, §7): the pure robbery rules and the additive protocol; plus the
 * Climb's `climb` message, which the checker had no entry for.
 */
import { describe, expect, it } from 'vitest'
import {
  JOB_REQUESTS,
  JOB_SETTINGS_DEFAULTS,
  NPC_SERVICES,
  SIEGE_EVENT_DEFAULTS,
  WARRANT_STATUSES,
  caravanPingR,
  denPayout,
  parseClientMessage,
  parseServerMessage,
  recoveryReward,
  robberyPairMul,
  robberySentenceMs,
} from '../src/index.ts'

const SILK = 'ITEM_ETC_TRADE_CH_01'
const S = JOB_SETTINGS_DEFAULTS
const LAW = SIEGE_EVENT_DEFAULTS.law

describe('robbery rules (§6.4, §7)', () => {
  it('the pair rule: full, half, nothing (law.repeatPct 50, law.repeatMax 3)', () => {
    expect([0, 1, 2, 3, 9].map((n) => robberyPairMul(n, LAW.repeatPct, LAW.repeatMax))).toEqual([1, 0.5, 0, 0, 0])
    expect(robberyPairMul(1, 25, 5)).toBe(0.75)
    expect(robberyPairMul(3, 25, 5)).toBeCloseTo(0.421875, 6)
    expect(robberyPairMul(4, 25, 5)).toBe(0)
    expect(robberyPairMul(1, 50, 1)).toBe(0)
    expect(robberyPairMul(0, 50, 1)).toBe(1)
  })

  it('the robbery ladder 15 / 30 / 60 / 120 min, capped at the last', () => {
    expect([1, 2, 3, 4, 5, 9].map((l) => robberySentenceMs(l, S.robbery.sentencesMin) / 60_000)).toEqual([15, 30, 60, 120, 120, 120])
    expect(robberySentenceMs(0, S.robbery.sentencesMin)).toBe(15 * 60_000)
    expect(robberySentenceMs(1, [])).toBe(0)
  })

  it('recovery reward = 25 % of the den value; the den never pays back the load (self-robbery loses)', () => {
    const den = denPayout(800, 6, S.thief.denPct)
    expect(den).toBe(2880)
    expect(recoveryReward(den, S.robbery.recoveryPct)).toBe(720)
    expect(recoveryReward(-5, 25)).toBe(0)
    // a robbed load and everything a Thief and a Hunter alt could get back stay below its cost
    for (const [base, crates] of [[800, 10], [3000, 30], [4000, 120]] as const) {
      const dropped = Math.floor((crates * S.thief.dropPct) / 100)
      const d = denPayout(base, dropped, S.thief.denPct)
      expect(d + recoveryReward(d, S.robbery.recoveryPct)).toBeLessThan(base * crates)
    }
  })

  it('caravan pings: 120 m circles, 80 m from job level 5', () => {
    expect(caravanPingR(1, S.thief.pingR)).toBe(120)
    expect(caravanPingR(4, S.thief.pingR)).toBe(120)
    expect(caravanPingR(5, S.thief.pingR)).toBe(80)
  })
})

describe('protocol (additive)', () => {
  it('denSell, denBuy, yunTurnIn; the den service; the new warrant statuses', () => {
    const c = (v: unknown) => parseClientMessage(JSON.stringify(v))
    expect(JOB_REQUESTS).toEqual(expect.arrayContaining(['denSell', 'denBuy', 'yunTurnIn']))
    expect(NPC_SERVICES).toContain('den')
    expect(WARRANT_STATUSES).toEqual(expect.arrayContaining(['sold', 'dropped']))
    expect(c({ t: 'denSell', npc: 4 })).toEqual({ ok: true, msg: { t: 'denSell', npc: 4 } })
    expect(c({ t: 'denBuy', npc: 4, count: 3 })).toEqual({ ok: true, msg: { t: 'denBuy', npc: 4, count: 3 } })
    expect(c({ t: 'denBuy', npc: 4, count: 0 }).ok).toBe(false)
    expect(c({ t: 'denBuy', npc: 4, count: 51 }).ok).toBe(false)
    expect(c({ t: 'yunTurnIn', npc: 4 })).toEqual({ ok: true, msg: { t: 'yunTurnIn', npc: 4 } })
    expect(c({ t: 'yunTurnIn', npc: 4, gold: 9 }).ok).toBe(false)
  })

  it('jobSack, caravanPing, robber on entities, robbery on lawState and wantedPing', () => {
    const sv = (v: unknown) => parseServerMessage(JSON.stringify(v))
    const sack = { t: 'jobSack', entries: [{ kind: 'stolen', good: SILK, crates: 6, owner: 'Tess', value: 2880 }] }
    expect(sv(sack)).toEqual({ ok: true, msg: sack })
    expect(sv({ t: 'jobSack', entries: [] })).toEqual({ ok: true, msg: { t: 'jobSack', entries: [] } })
    expect(sv({ t: 'jobSack', entries: [{ ...sack.entries[0], kind: 'bag' }] }).ok).toBe(false)
    const ping = { t: 'caravanPing', id: 5, x: 1, z: 2, r: 120, stars: 3, at: 9 }
    expect(sv(ping)).toEqual({ ok: true, msg: ping })
    expect(sv({ ...ping, stars: 0 }).ok).toBe(false)
    expect(sv({ t: 'entityUpdate', id: 3, robber: true })).toEqual({ ok: true, msg: { t: 'entityUpdate', id: 3, robber: true } })
    const ls = { t: 'lawState', offences: 0, wanted: { bounty: 720, lapseMs: 1000, offence: 1, role: 'breaker', robbery: true } }
    expect(sv(ls)).toEqual({ ok: true, msg: ls })
    const wp = { t: 'wantedPing', id: 3, name: 'Thea', x: 1, z: 2, r: 150, at: 5, robbery: true }
    expect(sv(wp)).toEqual({ ok: true, msg: wp })
  })

  it('climb: titles, the worn title, Arts and counters (the checker had no entry for it)', () => {
    const sv = (v: unknown) => parseServerMessage(JSON.stringify(v))
    const m = { t: 'climb', titles: ['pioneer', 'tiger_slayer'], title: null, arts: { 'BICHEON:1': 'edge' }, progress: { tiger_girl: 3 } }
    expect(sv(m)).toEqual({ ok: true, msg: m })
    expect(sv({ ...m, title: 'pioneer' })).toMatchObject({ ok: true, msg: { title: 'pioneer' } })
    expect(sv({ ...m, titles: ['Not A Code'] }).ok).toBe(false)
    expect(sv({ ...m, progress: { x: -1 } }).ok).toBe(false)
    expect(sv({ ...m, arts: [] }).ok).toBe(false)
    expect(sv({ ...m, arts: 'x' }).ok).toBe(false)
  })
})
