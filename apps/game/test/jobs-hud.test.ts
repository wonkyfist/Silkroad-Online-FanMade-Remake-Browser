/**
 * The job system's client core (docs/JOBS.md §10, layer 5): the DOM-free logic behind the job page, the licence
 * windows, the trade window, the transport frame, the sack, bags and PvP clicks (hud/jobs-logic.ts).
 */
import { JOBS_CONTENT, JOB_SETTINGS_DEFAULTS, tradeBuyTotal, tradeStars, type JobView, type TransportView } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import {
  bagLine,
  bagsNear,
  bestTransport,
  buyPreview,
  driftArrow,
  jobExpBar,
  jobFailText,
  jobFightable,
  jobHead,
  jobLimits,
  licenceState,
  licenceTerms,
  loadLine,
  marketCells,
  maxBuyable,
  nextUnlockLine,
  pctText,
  postOfNpc,
  routeEstimates,
  sackLines,
  sackTotals,
  starsText,
  transportFollow,
  routeProfitPct,
  tradeRouteShapes,
  ROUTE_DANGER_COLORS,
} from '../src/hud/jobs-logic.ts'
import { POST_PROPS, bagCrates, postPropAt } from '../src/world/jobs/trade-world.ts'
import { addWorldMapOverlay, setWorldMapLayer, worldMapLayerOn, worldMapLayers } from '../src/world/map/worldmap.ts'

const view = (o: Partial<JobView> = {}): JobView => ({ job: 'trader', level: 1, exp: 0, mode: false, side: 'law', ...o })
const NOW = Date.UTC(2026, 9, 8)

describe('job page', () => {
  it('head, EXP bar, limits, next unlock', () => {
    expect(jobHead(view({ level: 3 }))).toEqual({ title: 'Trader', level: 'Job level 3 · Merchant', tier: 'Suit tier II' })
    expect(jobHead(null).title).toBe('No job')
    const bar = jobExpBar(view({ level: 2, exp: 4000 }))
    expect(bar.frac).toBeCloseTo(0.5)
    expect(bar.text).toBe('4,000 / 6,000 job EXP')
    expect(jobExpBar(view({ level: 7, exp: 140_000 }))).toEqual({ frac: 1, text: '140,000 job EXP · the highest level' })
    expect(jobLimits('trader', 1)).toEqual(['Loads up to ★★ (2 stars) at your level', 'Transports up to the Donkey', 'At most 300 crates bought an hour (account)', 'Market tax 3 % on every sale'])
    expect(jobLimits('thief', 5)[1]).toBe('Caravan pings within 400 m every 60 s (80 m circles)')
    expect(jobLimits('hunter', 1)[0]).toBe('Wanted and robbers show within 120 m')
    expect(nextUnlockLine('thief', 2)).toBe('Next: level 3 Footpad at 6,000 job EXP')
    expect(nextUnlockLine('hunter', 7)).toBe('The highest job level: Warden of the Roads.')
    expect(bestTransport(4)?.name).toBe('Horse')
    expect(bestTransport(7)?.name).toBe('Ironclad Trade Horse')
  })
})

describe('licence windows', () => {
  it('terms: the Hunter keeps the siege licence', () => {
    expect(licenceTerms('trader')).toMatchObject({ gold: 10_000, level: 15, cleanDays: 0, leaveDays: 3, sideDays: 7 })
    expect(licenceTerms('hunter')).toMatchObject({ level: 15, cleanDays: 30 })
  })

  it('status, warnings, buttons', () => {
    const none = licenceState('thief', view({ job: null, side: null }), 20, NOW)
    expect(none).toMatchObject({ status: 'You hold no job.', warn: '', canJoin: true, canLeave: false })
    expect(licenceState('thief', view({ job: null, side: 'law' }), 20, NOW).warn).toMatch(/^Warning: your account is on the side of the law/)
    expect(licenceState('trader', view({ job: null, side: null }), 12, NOW).warn).toBe('You need character level 15.')
    expect(licenceState('trader', view({ job: null, side: null, joinAfter: NOW + 86_400_000 }), 20, NOW).warn).toBe('Your account may take a job again on 2026-10-09.')
    expect(licenceState('trader', view({ job: 'thief', side: 'outlaw' }), 20, NOW)).toMatchObject({ status: 'You are a Thief: leave that job first (at its NPC).', canJoin: false })
    const member = licenceState('trader', view({ level: 2, mode: true }), 20, NOW)
    expect(member).toMatchObject({ status: 'Trader · job level 2 (Hawker) · suit on', canLeave: false, canSuit: true, suitOn: true })
    expect(licenceState('trader', view({ level: 2 }), 20, NOW).canLeave).toBe(true)
    const yun = licenceState('hunter', view({ job: 'hunter', level: 3 }), 20, NOW, { licensed: true, onDuty: false, rank: 2, captures: 4 })
    expect(yun.status).toBe('Bounty Hunter · job level 3 (Bloodhound) · suit off · 4 captures')
    expect(licenceState('hunter', view({ job: 'hunter' }), 20, NOW, { licensed: false, onDuty: false, rank: 0, captures: 0, revokedUntil: NOW + 3 * 86_400_000 }).status).toBe('Your licence is revoked until 2026-10-11.')
  })
})

describe('the trade window', () => {
  it('route estimates from Jangan: margins by distance and danger, the tax, the home price', () => {
    const r = routeEstimates('ITEM_ETC_TRADE_CH_01', 800)
    expect(r.map((x) => x.post.id)).toEqual(['sea-cliffs', 'ferry-landing', 'tomb-camp', 'south-beach', 'jangan'])
    const beach = r.find((x) => x.post.id === 'south-beach')!
    expect(beach.margin).toBeGreaterThan(0.07)
    expect(beach.margin).toBeLessThan(0.09)
    expect(beach.sell).toBe(Math.floor(800 * (1 + beach.margin) * 0.97))
    const home = r.find((x) => x.home)!
    expect(home.sell).toBe(720)
    expect(home.profit).toBe(-80)
    expect(pctText(home.profit, 800)).toBe('−10 %')
    // a post's good: the margin runs from its own post
    expect(routeEstimates('ITEM_ETC_TRADE_WC_07', 4000)[0]!.post.id).not.toBe('sea-cliffs')
  })

  it('the most crates a purchase may take: room, gold, the stars cap', () => {
    const s = JOB_SETTINGS_DEFAULTS
    // level 1: two stars at most, i.e. a load under 60,000
    const n = maxBuyable({ base: 3000, mul: 1, room: 30, gold: 1e9, holdValue: 0, level: 1 })
    expect(tradeStars(tradeBuyTotal(3000, 1, n, s.drift).gold, s.trade.starThresholds)).toBeLessThanOrEqual(2)
    expect(tradeStars(tradeBuyTotal(3000, 1, n + 1, s.drift).gold, s.trade.starThresholds)).toBe(3)
    expect(maxBuyable({ base: 800, mul: 1, room: 5, gold: 1e9, holdValue: 0, level: 1 })).toBe(5)
    expect(maxBuyable({ base: 800, mul: 1, room: 30, gold: 2000, holdValue: 0, level: 1 })).toBe(2)
    expect(maxBuyable({ base: 800, mul: 1, room: 30, gold: 1e9, holdValue: 59_500, level: 1 })).toBe(0)
    expect(buyPreview(1000, 1, 25, 0)).toEqual({ gold: tradeBuyTotal(1000, 1, 25, s.drift).gold, stars: 2 })
  })

  it('market cells: prices, drift arrows, news, the hold', () => {
    expect(driftArrow(1.1)).toBe('▲')
    expect(driftArrow(0.9)).toBe('▼')
    expect(driftArrow(1)).toBe('')
    const c = marketCells({ good: 'ITEM_ETC_TRADE_CH_01', name: 'White Silk', origin: 'jangan', buy: 812, sell: 720, demand: 0.94, buyMul: 1.02 }, 12)
    expect(c).toMatchObject({ buy: '812', sell: '720 ▼', hold: '12', demand: 'Demand 94 % ▼' })
    expect(c.tip).toContain('Price 102 % of base ▲')
    const news = marketCells({ good: 'ITEM_ETC_TRADE_WC_05', name: 'Brown Pearl', origin: 'south-beach', sell: 2600, demand: 1, news: true }, 0)
    expect(news).toMatchObject({ buy: '–', sell: '2,600 ★', hold: '', demand: 'News: wanted here today (×1.20)' })
  })

  it('posts by NPC, the load line', () => {
    expect(postOfNpc('NPC_CH_SPECIAL')?.id).toBe('jangan')
    expect(postOfNpc('NPC_JOB_POST_MOK')?.id).toBe('sea-cliffs')
    expect(postOfNpc('NPC_CH_SPECIAL2')).toBeNull()
    const tr: TransportView = { id: 9, tier: 1, name: 'Donkey', hp: 2500, maxHp: 2500, capacity: 30, hold: [{ good: 'ITEM_ETC_TRADE_CH_01', crates: 20, cost: 16_400 }], stars: 1, dest: 'south-beach', from: 'jangan', ridden: false }
    expect(loadLine(tr)).toBe('Donkey: 20 / 30 crates · value 16,400 · ★')
    expect(transportFollow(tr, 10)).toBe('Following')
    expect(transportFollow(tr, 80)).toBe('Waiting: come back')
    expect(transportFollow({ ridden: true }, 0)).toBe('Ridden')
    // stay here: shown as staying wherever the Trader is; riding wins
    expect(transportFollow({ ridden: false, staying: true }, 80)).toBe('Staying here')
    expect(transportFollow({ ridden: true, staying: true }, 0)).toBe('Ridden')
    expect(starsText(3, true)).toBe('★★★☆☆')
    expect(starsText(3)).toBe('★★★')
  })
})

describe('sacks, bags, fights, refusals', () => {
  it('the sack lines', () => {
    const entries = [
      { kind: 'stolen' as const, good: 'ITEM_ETC_TRADE_CH_01', crates: 6, owner: 'Aki', value: 2880 },
      { kind: 'stolen' as const, good: 'ITEM_ETC_TRADE_CH_02', crates: 2, owner: 'Aki', value: 1200 },
      { kind: 'recovered' as const, good: 'ITEM_ETC_TRADE_CH_01', crates: 3, owner: 'Mei', value: 360 },
    ]
    expect(sackTotals(entries).stolen).toEqual({ crates: 8, value: 4080 })
    expect(sackLines(entries)).toEqual([
      { kind: 'stolen', text: 'Stolen goods: 8 crate(s) · 4,080 at the den' },
      { kind: 'recovered', text: 'Recovered goods: 3 crate(s) · 360 reward at Captain Yun' },
    ])
    expect(sackLines([])).toEqual([])
  })

  it('bags near, nearest first, with the time left', () => {
    const b = (id: number, x: number) => ({ id, x, z: 0, good: 'ITEM_ETC_TRADE_CH_05', crates: 4, owner: 'Aki', expiresAt: NOW + 125_000 })
    const near = bagsNear([b(1, 10), b(2, 3), b(3, 40)], 0, 0, 25)
    expect(near.map((x) => x.id)).toEqual([2, 1])
    expect(bagLine(near[0]!, NOW)).toBe('4 crate(s) of Tiger Eye Stone (Aki) · 2:05')
  })

  it('who a click attacks', () => {
    expect(jobFightable({ job: { job: 'thief' } }, { job: { job: 'trader' } })).toBe(true)
    expect(jobFightable({ job: { job: 'hunter' } }, { job: { job: 'trader' } })).toBe(false)
    expect(jobFightable({ job: null }, { job: { job: 'thief' } })).toBe(false)
    expect(jobFightable({ job: null, hunterOnDuty: true }, { job: null, robber: true })).toBe(true)
  })

  it('refusals: the server text first, then the job reasons', () => {
    expect(jobFailText('stars_cap', 'A load that big is 3 stars: at job level 1 you may carry 2.')).toBe('A load that big is 3 stars: at job level 1 you may carry 2.')
    expect(jobFailText('stars_cap')).toBe('A load that big is above your job level.')
    expect(jobFailText('not_job_mode')).toBe('Put on your job suit first.')
    expect(jobFailText('loaded', '  ')).toBe('Not with a loaded transport.')
  })

  it('the world map\'s Trade routes layer: a road per post from Jangan by danger with the profit, the posts, the den; toggled', () => {
    const shapes = tradeRouteShapes()
    const roads = shapes.filter((s) => s.to)
    expect(roads).toHaveLength(4)
    const hub = JOBS_CONTENT.posts.find((p) => p.id === 'jangan')!
    for (const p of JOBS_CONTENT.posts.filter((p) => p.id !== 'jangan')) {
      const pct = routeProfitPct(hub, p)
      expect(pct).toBeGreaterThan(0)
      expect(shapes.some((s) => s.text && s.label === `+${pct} %`)).toBe(true)
      expect(roads.find((r) => r.to!.x === p.x)!.color).toBe(ROUTE_DANGER_COLORS[p.danger])
    }
    // the farther and deadlier, the better it pays
    const far = JOBS_CONTENT.posts.find((p) => p.id === 'sea-cliffs')!
    const near = JOBS_CONTENT.posts.find((p) => p.id === 'south-beach')!
    expect(routeProfitPct(hub, far)).toBeGreaterThan(routeProfitPct(hub, near))
    expect(shapes.filter((s) => s.label?.includes('trade post'))).toHaveLength(5)
    expect(shapes.some((s) => s.label === 'Bandit Den' && s.x === JOBS_CONTENT.den.x)).toBe(true)
    // a layer: listed once, on by default, toggled
    const off = addWorldMapOverlay(() => shapes, { id: 'trade-routes', label: () => 'Trade routes' })
    const off2 = addWorldMapOverlay(() => [], { id: 'trade-routes', label: () => 'Trade routes' })
    expect(worldMapLayers().map((l) => l.id)).toEqual(['trade-routes'])
    expect(worldMapLayerOn('trade-routes')).toBe(true)
    setWorldMapLayer('trade-routes', false)
    expect(worldMapLayerOn('trade-routes')).toBe(false)
    setWorldMapLayer('trade-routes', true)
    off()
    off2()
    expect(worldMapLayers()).toEqual([])
  })

  it('the trade posts\' corners and the bags on the ground', () => {
    // the four posts out on the island (Jodaesan stands in the town market)
    expect(Object.keys(POST_PROPS).sort()).toEqual(['ferry-landing', 'sea-cliffs', 'south-beach', 'tomb-camp'])
    for (const list of Object.values(POST_PROPS)) {
      expect(list!.some((p) => p.glb === 'crate')).toBe(true)
      // never on the trader's own spot (he stays clickable)
      for (const p of list!) expect(Math.hypot(p.f, p.r)).toBeGreaterThan(1)
    }
    // the frame: forward along the facing (protocol yaw = atan2(dx, dz)), right a quarter turn clockwise
    const post = { x: 100, z: 200, yaw: 0 }
    expect(postPropAt(post, { f: 2, r: 0, yaw: 0 })).toMatchObject({ x: 100, z: 202 })
    const r = postPropAt(post, { f: 0, r: 3, yaw: 0.5 })
    expect(r.x).toBeCloseTo(97)
    expect(r.z).toBeCloseTo(200)
    expect(r.yaw).toBe(0.5)
    expect(postPropAt({ x: 0, z: 0, yaw: Math.PI / 2 }, { f: 1, r: 0, yaw: 0 }).x).toBeCloseTo(1)
    expect([1, 3, 4, 11, 12, 60].map(bagCrates)).toEqual([1, 1, 2, 2, 3, 3])
  })

  it('the content the windows read is complete', () => {
    expect(JOBS_CONTENT.posts).toHaveLength(5)
    for (const g of JOBS_CONTENT.goods) expect(routeEstimates(g.code, g.base).length).toBe(5)
  })
})
