/**
 * The job system, layers 2-3, pure rules (docs/JOBS.md §5.2-§5.4, §6.2, §6.3, §9.1, §9.4): the hold (add, take, spill),
 * buying and selling crate by crate with drift (cap, floor, the account's daily room, the news bonus), recovery, stars
 * and the job level's cap, ambush counts, points and rosters, transport tiers, the settings groups, the protocol.
 */
import { describe, expect, it } from 'vitest'
import {
  JOB_SETTINGS_DEFAULTS,
  JOBS_CONTENT,
  ambushCount,
  ambushPoints,
  ambushRoster,
  checkJobSettings,
  denPayout,
  driftRecover,
  holdAdd,
  holdCrates,
  holdSpill,
  holdTake,
  holdValue,
  maxStarsAt,
  parseClientMessage,
  parseServerMessage,
  tradeBuyTotal,
  tradeMargin,
  tradeSellPrice,
  tradeSellTotal,
  tradeStars,
  transportTierAt,
} from '../src/index.ts'

const S = JOB_SETTINGS_DEFAULTS
const SILK = 'ITEM_ETC_TRADE_CH_01'
const PEARL = 'ITEM_ETC_TRADE_WC_05'

describe('the hold (§5.4, §6.3)', () => {
  it('adds per good, takes with a proportional cost, spills dropPct per good (rounded down)', () => {
    let h = holdAdd([], SILK, 10, 8036)
    h = holdAdd(h, PEARL, 3, 6000)
    h = holdAdd(h, SILK, 5, 4100)
    expect(h).toEqual([
      { good: SILK, crates: 15, cost: 12_136 },
      { good: PEARL, crates: 3, cost: 6000 },
    ])
    expect(holdCrates(h)).toBe(18)
    expect(holdValue(h)).toBe(18_136)
    const t = holdTake(h, SILK, 5)
    expect(t).toMatchObject({ crates: 5, cost: Math.round(12_136 / 3) })
    expect(holdTake(t.hold, SILK, 99)).toMatchObject({ crates: 10, cost: 12_136 - Math.round(12_136 / 3), hold: [{ good: PEARL, crates: 3, cost: 6000 }] })
    expect(holdTake(h, 'nope', 1)).toMatchObject({ crates: 0, cost: 0 })
    const sp = holdSpill(h, 60)
    expect(sp.spilled).toEqual([
      { good: SILK, crates: 9, cost: Math.round((12_136 * 9) / 15) },
      { good: PEARL, crates: 1, cost: 2000 },
    ])
    expect(holdCrates(sp.kept)).toBe(8)
    expect(holdValue(sp.kept) + holdValue(sp.spilled)).toBe(holdValue(h))
    // the tornado's 20 %: 3 pearls drop none
    expect(holdSpill(h, 20).spilled).toEqual([{ good: SILK, crates: 3, cost: Math.round((12_136 * 3) / 15) }])
  })
})

describe('prices and drift (§5.2)', () => {
  it('buying raises the price crate by crate up to the cap; selling lowers demand to the floor; the account room stops it', () => {
    expect(tradeBuyTotal(800, 1, 10, S.drift)).toEqual({ gold: 8036, mul: expect.closeTo(1.01, 9) })
    expect(tradeBuyTotal(1000, 1.3, 5, S.drift)).toEqual({ gold: 6500, mul: 1.3 })
    const t = { taxPct: 3, drift: S.drift }
    const r = tradeSellTotal(1000, 0.2, 1, 10, t)
    let want = 0
    for (let i = 0; i < 10; i++) want += tradeSellPrice(1000, 0.2, 1 - 0.002 * i, 3)
    expect(r.gold).toBe(want)
    expect(r.demand).toBeCloseTo(0.98, 9)
    expect(r.moved).toBeCloseTo(0.02, 9)
    expect(tradeSellTotal(1000, 0.2, 0.7, 5, t)).toMatchObject({ demand: 0.7, moved: 0 })
    // the account may move it 0.004 more today: two crates' worth
    expect(tradeSellTotal(1000, 0.2, 1, 10, t, 0.004).demand).toBeCloseTo(0.996, 9)
    // the news multiplies the price, not the stored demand
    const n = tradeSellTotal(1000, 0.2, 1, 1, t, Infinity, 1.2)
    expect(n.gold).toBe(tradeSellPrice(1000, 0.2, 1.2, 3))
    expect(n.demand).toBeCloseTo(0.998, 9)
    // the source pays 0.9 of its buy price
    expect(tradeSellPrice(1000, null, 1, 3, 1.1)).toBe(990)
  })

  it('drift recovers 3 % an hour toward 1, from either side', () => {
    expect(driftRecover(0.7, 5, S.drift)).toBeCloseTo(0.85, 9)
    expect(driftRecover(0.7, 20, S.drift)).toBe(1)
    expect(driftRecover(1.3, 2, S.drift)).toBeCloseTo(1.24, 9)
    expect(driftRecover(1.3, 99, S.drift)).toBe(1)
  })

  it("§5.1's margins from Jangan: +8 % beach, +11 % tomb, +21 % ferry, +24 % cliffs (within 1 %)", () => {
    const at = (id: string) => JOBS_CONTENT.posts.find((p) => p.id === id)!
    const j = at('jangan')
    expect(tradeMargin(j, at('south-beach'), S.trade)).toBeCloseTo(0.08, 1)
    expect(tradeMargin(j, at('tomb-camp'), S.trade)).toBeCloseTo(0.11, 1)
    expect(tradeMargin(j, at('ferry-landing'), S.trade)).toBeCloseTo(0.21, 1)
    expect(tradeMargin(j, at('sea-cliffs'), S.trade)).toBeCloseTo(0.24, 1)
  })
})

describe('stars, tiers, ambushes (§3.2, §5.3, §6.2)', () => {
  it('stars by load value; the job level caps them; transport tiers by job level', () => {
    expect([0, 24_999, 25_000, 60_000, 119_999, 120_000, 200_000, 9e9].map((v) => tradeStars(v, S.trade.starThresholds))).toEqual([1, 1, 2, 3, 3, 4, 5, 5])
    expect([1, 2, 3, 4, 5, 6, 7].map((l) => maxStarsAt(l, S.trade.maxStars))).toEqual([2, 2, 3, 3, 4, 5, 5])
    expect([1, 2, 3, 4, 5, 6, 7].map((l) => transportTierAt(l, JOBS_CONTENT.transports))).toEqual([1, 1, 2, 2, 3, 3, 4])
  })

  it('ambush groups per stars: ★ none, ★★ 0-1, ★★★ 1, ★★★★ 1-2, ★★★★★ 2-3; points between 30 % and 80 %, rising', () => {
    const lo = () => 0
    const hi = () => 0.999
    expect([1, 2, 3, 4, 5].map((s) => ambushCount(s, S.ambush.perStar, hi))).toEqual([0, 0, 1, 1, 2])
    expect([1, 2, 3, 4, 5].map((s) => ambushCount(s, S.ambush.perStar, lo))).toEqual([0, 1, 1, 2, 3])
    let k = 0
    const seq = () => [0.9, 0.1, 0.5][k++ % 3]!
    const pts = ambushPoints(3, S.ambush, seq)
    expect(pts).toEqual([0.35, 0.55, 0.75].map((x) => expect.closeTo(x, 9)))
    expect(ambushPoints(0, S.ambush, seq)).toEqual([])
  })

  it('rosters: the B5 Bandits near Jangan, B7 or B8 far (by danger), the retail Bandits last', () => {
    expect(ambushRoster(false, 5)[0]).toBe('MOB_CL_BANDIT_16')
    expect(ambushRoster(true, 4)[0]).toBe('MOB_CL_HYUNGNO_23')
    expect(ambushRoster(true, 5)[0]).toBe('MOB_CL_EARTHGHOST_25')
    for (const far of [false, true]) expect(ambushRoster(far, 5).at(-1)).toBe('MOB_CH_BANDITARCHER')
  })

  it('self-robbery: what drops (60 %) at the den (60 % of base) is far below the load', () => {
    for (const g of JOBS_CONTENT.goods) {
      for (const n of [1, 30, 120]) expect(denPayout(g.base, Math.floor((n * S.thief.dropPct) / 100), S.thief.denPct)).toBeLessThanOrEqual(g.base * n * 0.36)
    }
  })
})

describe('settings and protocol (§9.1, §9.4)', () => {
  it('the transport and ambush groups are checked', () => {
    expect(checkJobSettings({ transport: { leashM: 25, waitM: 60 } })).toEqual([])
    expect(checkJobSettings({ transport: { waitM: 1 } })).toHaveLength(1)
    expect(checkJobSettings({ ambush: { perStar: [0, 1, 0, 1, 1] } })).toHaveLength(1)
    expect(checkJobSettings({ ambush: { perStar: [0, 0.5, 1, 1.5, 2.5], groupMax: 8 } })).toEqual([])
  })

  it('tradeMarket, tradeSummon, tradeBuy, tradeSell, transportRide, transportDismiss, bagPick', () => {
    const c = (v: unknown) => parseClientMessage(JSON.stringify(v))
    expect(c({ t: 'tradeMarket', npc: 4 })).toEqual({ ok: true, msg: { t: 'tradeMarket', npc: 4 } })
    expect(c({ t: 'tradeSummon', npc: 4, tier: 2 })).toMatchObject({ ok: true })
    expect(c({ t: 'tradeSummon', npc: 4, tier: 5 }).ok).toBe(false)
    expect(c({ t: 'tradeBuy', npc: 4, good: SILK, crates: 10, dest: 'sea-cliffs' })).toMatchObject({ ok: true })
    expect(c({ t: 'tradeBuy', npc: 4, good: 'ITEM_ETC_GOLD_01', crates: 10, dest: 'sea-cliffs' }).ok).toBe(false)
    expect(c({ t: 'tradeBuy', npc: 4, good: SILK, crates: 0, dest: 'sea-cliffs' }).ok).toBe(false)
    expect(c({ t: 'tradeBuy', npc: 4, good: SILK, crates: 1, dest: 'atlantis' }).ok).toBe(false)
    expect(c({ t: 'tradeSell', npc: 4 })).toEqual({ ok: true, msg: { t: 'tradeSell', npc: 4 } })
    expect(c({ t: 'tradeSell', npc: 4, good: SILK, crates: 3 })).toEqual({ ok: true, msg: { t: 'tradeSell', npc: 4, good: SILK, crates: 3 } })
    expect(c({ t: 'transportRide', on: true })).toMatchObject({ ok: true })
    expect(c({ t: 'transportDismiss' })).toMatchObject({ ok: true })
    expect(c({ t: 'transportFollow', on: false })).toMatchObject({ ok: true })
    expect(c({ t: 'transportFollow' })).toMatchObject({ ok: false })
    expect(c({ t: 'bagPick', id: 9 })).toMatchObject({ ok: true })
    expect(c({ t: 'bagPick', id: 9, x: 1 }).ok).toBe(false)
  })

  it('market, transportState, bag, bagGone; stars on transports', () => {
    const sv = (v: unknown) => parseServerMessage(JSON.stringify(v))
    const m = { t: 'market', post: 'jangan', rows: [{ good: SILK, name: 'White Silk', origin: 'jangan', buy: 808, sell: 727, demand: 1, buyMul: 1.01, news: true }] }
    expect(sv(m)).toEqual({ ok: true, msg: m })
    const tr = { t: 'transportState', transport: { id: 5, tier: 1, name: 'Donkey', hp: 2500, maxHp: 2500, capacity: 30, hold: [{ good: SILK, crates: 10, cost: 8036 }], stars: 1, dest: 'sea-cliffs', from: 'jangan', ridden: false } }
    expect(sv(tr)).toEqual({ ok: true, msg: tr })
    expect(sv({ t: 'transportState', transport: null })).toEqual({ ok: true, msg: { t: 'transportState', transport: null } })
    // stay here: the flag survives the client's parser (only when true)
    expect(sv({ ...tr, transport: { ...tr.transport, staying: true } })).toMatchObject({ ok: true, msg: { transport: { staying: true } } })
    expect((sv({ ...tr, transport: { ...tr.transport, staying: false } }) as { msg: { transport: object } }).msg.transport).not.toHaveProperty('staying')
    const bag = { t: 'bag', id: 9, x: 1, z: 2, good: SILK, crates: 6, owner: 'Tess', expiresAt: 5 }
    expect(sv(bag)).toEqual({ ok: true, msg: bag })
    expect(sv({ t: 'bagGone', id: 9 })).toEqual({ ok: true, msg: { t: 'bagGone', id: 9 } })
    expect(sv({ t: 'entityUpdate', id: 3, stars: 0 })).toMatchObject({ ok: true, msg: { stars: 0 } })
    expect(sv({ t: 'entityUpdate', id: 3, stars: 6 }).ok).toBe(false)
    expect(sv({ t: 'actionResult', re: 'tradeBuy', ok: false, reason: 'stars_cap' })).toMatchObject({ ok: true })
  })
})
