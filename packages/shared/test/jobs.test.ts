/**
 * The job system, layers 0-1, pure rules (docs/JOBS.md §2-§5, §9): sides, level names, suit codes, job levels and the
 * Hunter migration, the PvP rule's job rows (exhaustively), stars, margins (§5.1's table), drift, the den and the
 * self-robbery loss, job EXP, joining, the settings, content/jobs/jobs.json, the protocol.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HUNTER_RANKS,
  JOB_IDS,
  JOB_LEVEL_NAMES,
  JOB_SETTINGS_DEFAULTS,
  JOBS_CONTENT,
  checkJobSettings,
  checkJobsContent,
  demandAfterSell,
  denPayout,
  droppedCrates,
  driftRecover,
  buyMulAfterBuy,
  hunterEscortExp,
  hunterRankOfLevel,
  hunterRankToJob,
  hunterThiefExp,
  installJobsContent,
  isTransportCos,
  jobLevelExp,
  jobLevelName,
  jobLevelOf,
  jobNextExp,
  jobSide,
  jobSuitCode,
  jobSuitCodes,
  joinRefusal,
  maxStarsAt,
  mergeJobSettings,
  pruneJobPatch,
  pvpAllowed,
  suitTier,
  thiefDenExp,
  thiefTransportExp,
  tradeMargin,
  tradeSellPrice,
  tradeStars,
  traderSaleExp,
  parseClientMessage,
  parseServerMessage,
  type JobId,
  type JoinInput,
  type NpcDef,
  type PvpSide,
} from '../src/index.ts'

const S = JOB_SETTINGS_DEFAULTS
const LV = S.jobs.levels
const DAY = 86_400_000

describe('jobs, sides, names, suits (§2, §3.3)', () => {
  it('Trader and Hunter are the law, the Thief the outlaws; seven level names each; the Hunter keeps the Bounty Hunter ranks', () => {
    expect(JOB_IDS.map(jobSide)).toEqual(['law', 'law', 'outlaw'])
    for (const j of JOB_IDS) expect(JOB_LEVEL_NAMES[j]).toHaveLength(7)
    expect(JOB_LEVEL_NAMES.hunter.slice(0, 6)).toEqual(['Recruit', 'Tracker', 'Bloodhound', 'Manhunter', 'Bounty Sergeant', 'Bounty Captain'])
    expect(jobLevelName('hunter', 3)).toBe('Bloodhound')
    expect(jobLevelName('thief', 99)).toBe('King of the Road')
  })
  it('suit tiers I 1-2, II 3-5, III 6-7; the retail codes of each body', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(suitTier)).toEqual([1, 1, 2, 2, 2, 3, 3])
    expect(jobSuitCode('trader', 1, 'm')).toBe('ITEM_CH_M_TRADE_TRADER_02')
    expect(jobSuitCode('trader', 1, 'f')).toBe('ITEM_CH_F_TRADE_TRADER_02')
    expect(jobSuitCode('hunter', 2, 'f')).toBe('ITEM_CH_W_TRADE_HUNTER_04_01')
    expect(jobSuitCode('thief', 2, 'm')).toBe('ITEM_CH_M_TRADE_THIEF_02')
    expect(jobSuitCode('thief', 3, 'f')).toBe('ITEM_CH_F_TRADE_THIEF_03')
    expect(jobSuitCodes()).toHaveLength(16)
    for (const c of jobSuitCodes()) expect(c).toMatch(/^ITEM_CH_[MWF]_TRADE_(TRADER|HUNTER|THIEF)_0[2-5](_01)?$/)
    expect(isTransportCos('COS_T_DONKEY')).toBe(true)
    expect(isTransportCos('COS_C_HORSE1')).toBe(false)
  })
})

describe('job levels and the Hunter migration (§2.3, §3.2)', () => {
  it('levels 1-7 by the thresholds; next EXP; level 7 has none', () => {
    expect([0, 1999, 2000, 5999, 6000, 15_000, 35_000, 69_999, 70_000, 130_000, 9e8].map((e) => jobLevelOf(e, LV))).toEqual([1, 1, 2, 2, 3, 4, 5, 5, 6, 7, 7])
    expect(jobLevelExp(4, LV)).toBe(15_000)
    expect(jobNextExp(1, LV)).toBe(2000)
    expect(jobNextExp(7, LV)).toBeNull()
  })
  it('rank r becomes level r + 1 at its threshold; the rank is the level − 1 again', () => {
    for (let r = 0; r <= 5; r++) {
      const j = hunterRankToJob(r, LV)
      expect(j.level).toBe(r + 1)
      expect(jobLevelOf(j.exp, LV)).toBe(r + 1)
      expect(hunterRankOfLevel(j.level)).toBe(r)
    }
    expect(hunterRankToJob(9, LV).level).toBe(7)
  })
  it('the wall-capture EXP (2,000): 1, 3, 10, 25, 60 captures reach at least ranks 1-5 (nobody falls behind the old ranks)', () => {
    for (const [i, n] of HUNTER_RANKS.entries()) expect(hunterRankOfLevel(jobLevelOf(n * S.exp.hunterWallCapture, LV))).toBeGreaterThanOrEqual(i + 1)
    // the first two ranks exactly as before; the upper ones come sooner (8, 18, 35 captures)
    expect([1, 2, 3, 7, 8, 17, 18, 34, 35].map((n) => hunterRankOfLevel(jobLevelOf(n * S.exp.hunterWallCapture, LV)))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5])
  })
})

describe('the PvP rule with the job rows (§4), exhaustively', () => {
  const jobs: (JobId | null)[] = [null, 'trader', 'hunter', 'thief']
  const side = (job: JobId | null, mode: boolean, safe: boolean, o: Partial<PvpSide> = {}): PvpSide => ({
    hunter: job === 'hunter' && mode,
    wanted: false,
    jailed: false,
    pardoned: false,
    inStockade: false,
    job,
    jobMode: mode,
    inJobSafe: safe,
    ...o,
  })
  it('in job mode, law against outlaw outside the safe places; nobody else; never associates', () => {
    let allowed = 0
    for (const ja of jobs)
      for (const jb of jobs)
        for (const ma of [false, true])
          for (const mb of [false, true])
            for (const sa of [false, true])
              for (const sb of [false, true])
                for (const assoc of [false, true]) {
                  const ok = pvpAllowed(side(ja, ma, sa), side(jb, mb, sb), assoc)
                  const want = !assoc && !!ja && !!jb && ma && mb && !sa && !sb && jobSide(ja) !== jobSide(jb)
                  expect(ok, `${ja}/${ma}/${sa} vs ${jb}/${mb}/${sb} assoc ${assoc}`).toBe(want)
                  if (ok) allowed++
                }
    // trader×thief, hunter×thief, both ways
    expect(allowed).toBe(4)
  })
  it('the Wanted row still works anywhere but the stockade; the jailed and the stockade stop the job war too', () => {
    const hunterInTown = side('hunter', true, true)
    const wanted = side(null, false, true, { wanted: true })
    expect(pvpAllowed(hunterInTown, wanted, false)).toBe(true)
    expect(pvpAllowed(side('thief', true, false), side('trader', true, false, { jailed: true }), false)).toBe(false)
    expect(pvpAllowed(side('thief', true, false, { inStockade: true }), side('hunter', true, false), false)).toBe(false)
    // a PvpSide without the job fields (the siege's own callers) is today's rule
    expect(pvpAllowed({ hunter: false, wanted: false, jailed: false, pardoned: false, inStockade: false }, { hunter: false, wanted: false, jailed: false, pardoned: false, inStockade: false }, false)).toBe(false)
  })
})

describe('trade rules (§5, §6.4)', () => {
  const post = (id: string) => JOBS_CONTENT.posts.find((p) => p.id === id)!
  it('the margins of §5.1 from Jodaesan: +8 %, +11 %, +21 %, +24 %', () => {
    const j = post('jangan')
    const m = (id: string) => Math.round(tradeMargin(j, post(id), S.trade) * 100)
    expect([m('south-beach'), m('tomb-camp'), m('ferry-landing'), m('sea-cliffs')]).toEqual([8, 11, 21, 24])
    expect(tradeMargin(j, j, S.trade)).toBe(0)
  })
  it('stars by load value, capped by the job level', () => {
    expect([0, 24_999, 25_000, 60_000, 120_000, 200_000, 1e7].map((v) => tradeStars(v, S.trade.starThresholds))).toEqual([1, 1, 2, 3, 4, 5, 5])
    expect([1, 2, 3, 4, 5, 6, 7].map((l) => maxStarsAt(l, S.trade.maxStars))).toEqual([2, 2, 3, 3, 4, 5, 5])
  })
  it('sell price, drift (impact, floor, cap, recovery)', () => {
    expect(tradeSellPrice(1000, 0.21, 1, 3)).toBe(Math.floor(1000 * 1.21 * 0.97))
    expect(tradeSellPrice(1000, null, 1, 3, 1.1)).toBe(990)
    expect(demandAfterSell(1, 10, S.drift)).toBeCloseTo(0.98)
    expect(demandAfterSell(0.71, 100, S.drift)).toBe(0.7)
    expect(buyMulAfterBuy(1.29, 100, S.drift)).toBe(1.3)
    expect(driftRecover(0.7, 5, S.drift)).toBeCloseTo(0.85)
    expect(driftRecover(1.3, 100, S.drift)).toBe(1)
  })
  it('robbing your own caravan always loses money: 60 % drop × 60 % of base at the den', () => {
    for (const good of JOBS_CONTENT.goods) {
      for (const crates of [1, 10, 30, 120]) {
        const paid = good.base * crates
        const back = denPayout(good.base, droppedCrates(crates, S.thief.dropPct), S.thief.denPct)
        expect(back).toBeLessThanOrEqual(paid * 0.36 + 1e-9)
      }
    }
  })
})

describe('job EXP (§3.1)', () => {
  it('per source', () => {
    expect(traderSaleExp(10_000, 1, S.exp)).toBe(1000)
    expect(traderSaleExp(10_000, 5, S.exp)).toBe(1500)
    expect(traderSaleExp(0, 5, S.exp)).toBe(0)
    expect(traderSaleExp(-50, 1, S.exp)).toBe(0)
    expect(hunterEscortExp(1500, S.exp)).toBe(600)
    expect(hunterThiefExp(3, false, S.exp)).toBe(900)
    expect(hunterThiefExp(3, true, S.exp)).toBe(1800)
    expect(thiefDenExp(8000, S.exp)).toBe(1000)
    expect(thiefTransportExp(4, S.exp)).toBe(800)
  })
})

describe('joining (§2.1)', () => {
  const now = 100 * DAY
  const base: JoinInput = { job: 'trader', level: 20, current: null, wanted: false, jailed: false, accountSide: null, sideChangedAt: null, leftAt: null, otherJobs: [], now }
  it('level 15, one job, not Wanted or jailed', () => {
    expect(joinRefusal(base, S.jobs)).toBeNull()
    expect(joinRefusal({ ...base, level: 14 }, S.jobs)).toBe('level')
    expect(joinRefusal({ ...base, current: 'thief' }, S.jobs)).toBe('has_job')
    expect(joinRefusal({ ...base, wanted: true }, S.jobs)).toBe('wanted')
    expect(joinRefusal({ ...base, jailed: true }, S.jobs)).toBe('jailed')
    expect(joinRefusal(base, { ...S.jobs, enabled: false })).toBe('disabled')
  })
  it('one side per account: no Thief beside a Trader or Hunter alt (and back); Trader and Hunter alts are fine', () => {
    expect(joinRefusal({ ...base, job: 'thief', otherJobs: ['trader'] }, S.jobs)).toBe('wrong_side')
    expect(joinRefusal({ ...base, job: 'thief', otherJobs: ['hunter'] }, S.jobs)).toBe('wrong_side')
    expect(joinRefusal({ ...base, job: 'hunter', otherJobs: ['thief'] }, S.jobs)).toBe('wrong_side')
    expect(joinRefusal({ ...base, job: 'hunter', otherJobs: ['trader', 'hunter'], accountSide: 'law' }, S.jobs)).toBeNull()
  })
  it('a side change waits 7 days after the last; a job waits 3 days after any of the account left one', () => {
    expect(joinRefusal({ ...base, job: 'thief', accountSide: 'law', sideChangedAt: now - 6 * DAY }, S.jobs)).toBe('side_wait')
    expect(joinRefusal({ ...base, job: 'thief', accountSide: 'law', sideChangedAt: now - 7 * DAY }, S.jobs)).toBeNull()
    expect(joinRefusal({ ...base, accountSide: 'law', sideChangedAt: now - DAY }, S.jobs)).toBeNull()
    expect(joinRefusal({ ...base, leftAt: now - 2 * DAY }, S.jobs)).toBe('leave_wait')
    expect(joinRefusal({ ...base, leftAt: now - 3 * DAY }, S.jobs)).toBeNull()
  })
})

describe('settings and content (§9.1)', () => {
  it('the defaults pass; bad values, lists and unknown keys do not; prune drops defaults', () => {
    expect(checkJobSettings({ jobs: { minLevel: 20, levels: [0, 1, 2, 3, 4, 5, 6] }, mode: { offLockMin: 5 } })).toEqual([])
    expect(checkJobSettings({ jobs: { minLevel: 0 } }).map((i) => i.path)).toEqual(['jobs.minLevel'])
    expect(checkJobSettings({ jobs: { levels: [0, 5, 4, 6, 7, 8, 9] } }).map((i) => i.path)).toEqual(['jobs.levels'])
    expect(checkJobSettings({ jobs: { levels: [1, 2, 3, 4, 5, 6, 7] } }).map((i) => i.path)).toEqual(['jobs.levels'])
    expect(checkJobSettings({ jobs: { enabled: 'yes' } }).map((i) => i.path)).toEqual(['jobs.enabled'])
    expect(checkJobSettings({ nope: { a: 1 } }).map((i) => i.path)).toEqual(['nope'])
    expect(checkJobSettings({ jobs: { nope: 1 } }).map((i) => i.path)).toEqual(['jobs.nope'])
    expect(mergeJobSettings(S, { jobs: { minLevel: 20 } }).jobs).toMatchObject({ minLevel: 20, licenceGold: 10_000 })
    expect(pruneJobPatch({ jobs: { minLevel: 15, licenceGold: 5 } }, S)).toEqual({ jobs: { licenceGold: 5 } })
  })
  it('content/jobs/jobs.json is valid and is the built-in content', () => {
    const file = JSON.parse(readFileSync(new URL('../../../content/jobs/jobs.json', import.meta.url), 'utf8')) as unknown
    expect(checkJobsContent(file)).toEqual([])
    expect(file).toEqual(JSON.parse(JSON.stringify(JOBS_CONTENT)))
    expect(checkJobsContent({ ...JOBS_CONTENT, goods: [{ code: 'ITEM_X', origin: 'nowhere', base: 0 }] })).toHaveLength(3)
  })
  it('the four post traders install once (Jodaesan is the export\'s)', () => {
    const npcs: NpcDef[] = []
    expect(installJobsContent({ npcs }, 'jangan').npcs).toBe(4)
    expect(installJobsContent({ npcs }, 'jangan').npcs).toBe(0)
    expect(npcs.map((n) => n.name)).toEqual(['Pearl Diver Haeun', 'Quartermaster Gong', 'Ferry Master Wol', 'Salvager Mok'])
  })
})

describe('protocol (§9.4)', () => {
  const c = (v: unknown) => parseClientMessage(JSON.stringify(v))
  const sv = (v: unknown) => parseServerMessage(JSON.stringify(v))
  it('jobJoin, jobLeave, jobMode; jobState; the badge on entities', () => {
    expect(c({ t: 'jobJoin', npc: 5, job: 'thief' })).toEqual({ ok: true, msg: { t: 'jobJoin', npc: 5, job: 'thief' } })
    expect(c({ t: 'jobJoin', npc: 5, job: 'pirate' }).ok).toBe(false)
    expect(c({ t: 'jobLeave', npc: 5 })).toEqual({ ok: true, msg: { t: 'jobLeave', npc: 5 } })
    expect(c({ t: 'jobMode', on: true })).toEqual({ ok: true, msg: { t: 'jobMode', on: true } })
    expect(c({ t: 'jobMode', on: true, extra: 1 }).ok).toBe(false)
    const st = { t: 'jobState', job: 'hunter', level: 3, exp: 6000, next: 15_000, mode: true, side: 'law', lockUntil: 5 }
    expect(sv(st)).toEqual({ ok: true, msg: st })
    expect(sv({ t: 'jobState', job: null, level: 0, exp: 0, mode: false, side: null })).toMatchObject({ ok: true, msg: { job: null, side: null } })
    expect(sv({ t: 'entityUpdate', id: 3, job: null, hunter: 6 })).toMatchObject({ ok: true, msg: { job: null, hunter: 6 } })
    expect(sv({ t: 'entityUpdate', id: 3, job: { job: 'thief', level: 2 } })).toMatchObject({ ok: true, msg: { job: { job: 'thief', level: 2 } } })
    expect(sv({ t: 'entityUpdate', id: 3, job: { job: 'thief', level: 9 } }).ok).toBe(false)
  })
})
