/**
 * The job system, layers 2-3 on the server: the market and the trade transports (docs/JOBS.md §5, §6.2, §6.3, §6.5, §7,
 * §9.3-§9.5, §11).
 *
 * - the market: buy at the source with the transport in the ring, sell at a post at base × (1 + margin) × demand × (1 −
 *   tax), at the source for 0.9 × the buy price; drift (buys raise, sells lower; floor, cap) and its recovery; the day's
 *   news; stars by load value and the job level's cap; the hold's size; the hourly buy cap and the daily demand cap per
 *   account; job EXP from the profit; escorting Bounty Hunters' share (not from the same IP);
 * - transports: summon at a trader (gold, job level), follow the Trader, wait past 60 m, ride (hits land on it),
 *   monsters target a loaded one, lightning and tornadoes, death → 60 % as bags, the owner's party picks them back, the
 *   Trader's death (30 s), logout linger and restore; ambushes by stars;
 * - abuse: return scrolls, the suit off, leaving the job and dismissing while loaded; associates cannot rob; Thieves
 *   only in the suit and off the safe places; the self-robbery loss; GM `trade`, `transport`, `ambush`, `bag`; admin.
 */
import {
  JOB_SETTINGS_DEFAULTS,
  fenceNpc,
  installSiegeHunterContent,
  installSiegeLawContent,
  tradeBuyTotal,
  tradeMargin,
  tradeSellPrice,
  tradeSellTotal,
  tradeStars,
  traderSaleExp,
  hunterEscortExp,
  type AdminJobsView,
  type LightningStrike,
  type NpcDef,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { GameContext } from '../src/game.ts'
import { GameData } from '../src/gamedata.ts'
import { addGold, addItem } from '../src/inventory.ts'
import { routeAdminJobs } from '../src/jobs/jobs-admin.ts'
import { TRANSPORT_COMBAT, transportCombatVsPlayers, type LiveTransport } from '../src/jobs/transport.ts'
import type { KegWalls } from '../src/siege/keg.ts'
import type { Player } from '../src/world.ts'
import { item, mob } from './fixtures.ts'
import { SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const MIN = 60_000
const HOUR = 3_600_000

let cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const WALLS: KegWalls = { on: true, walls: { segments: [], sides: [] }, settings: { maxIp: 20_000 }, stageOf: () => 'intact', change: () => null }
const JODAESAN: NpcDef = { code: 'NPC_CH_SPECIAL', name: 'Specialty Trader Jodaesan', x: 176, z: -48, yaw: 0, world: 'jangan', model: null, provenance: 'client' }
const FANG = { x: -300, z: -200 }
/** The trade points moved into the ±500 m test world (the town's safe box is ±80 m around Jodaesan). */
const SPOTS: Record<string, [number, number]> = { jangan: [0, 3], 'south-beach': [100, 420], 'tomb-camp': [420, -100], 'ferry-landing': [-420, 100], 'sea-cliffs': [-200, 420] }
const BANDIT = mob('MOB_CH_BANDIT', { name: 'Bandit', level: 16, hp: 800, physAttack: [3000, 3000], hitRate: 1000, aggressive: true, walkSpeed: 2, runSpeed: 6 })
const RETURN_NOW = item('ITEM_ETC_SCROLL_RETURN_NOW', { category: 'scroll', maxStack: 50, use: { returnToTown: true } })
const DONKEY_SCROLL = item('ITEM_COS_T_DONKEY', { category: 'scroll', maxStack: 10, use: { summon: 'COS_T_DONKEY' } })
const SILK = 'ITEM_ETC_TRADE_CH_01'
const LEATHER = 'ITEM_ETC_TRADE_CH_07'

type Who = { p: Player; inbox: ServerMessage[] }

function harness(rng: () => number = () => 0.5) {
  const data = new GameData({
    mobs: [BANDIT],
    items: [...SKILL_ITEMS, RETURN_NOW, DONKEY_SCROLL],
    levels: SKILL_LEVELS,
    npcs: [JODAESAN],
    towns: [{ ...SAFE_TOWN, safeArea: { x: 0, z: 0, halfX: 80, halfZ: 80 } }],
  })
  installSiegeLawContent({ items: data.items, drops: data.drops, npcs: data.npcs }, 'jangan')
  installSiegeHunterContent({ items: data.items, shops: data.shops, npcs: data.npcs }, 'jangan')
  const h = skillHarness({ data, rng, config: { uniques: false } })
  cleanups.push(h.cleanup)
  const g = h.gameplay
  g.kegs.configure({ walls: WALLS })
  g.jobs.configure({ content: { den: { ...g.jobs.content.den, x: -400, z: 300 }, posts: g.jobs.content.posts.map((p) => ({ ...p, x: SPOTS[p.id]![0], z: SPOTS[p.id]![1] })) } })
  const tick = (ms: number) => h.runTo(h.now + ms)
  const jump = (ms: number) => {
    h.now = h.now + ms - 50
    h.runTo(h.now + 50)
  }
  const jod = g.placeNpc({ ...JODAESAN, x: 0, z: 3 }, h.now)!
  g.placeNpc({ ...fenceNpc('jangan'), ...FANG }, h.now)
  const post: Record<string, ReturnType<typeof g.placeNpc> & object> = { jangan: jod }
  for (const p of g.jobs.content.posts) {
    if (p.id === 'jangan') continue
    const def = data.npcs.find((n) => n.code === p.npc.code)!
    post[p.id] = g.placeNpc({ ...def, x: p.x, z: p.z }, h.now)!
  }
  const char = (pos: Vec3, o: { name?: string; level?: number; gold?: number } = {}): Who => {
    const r = h.hero({ pos, level: o.level ?? 20, ...(o.name ? { name: o.name } : {}) })
    r.p.maxHp = r.p.hp = 50_000
    const { draft } = h.store.inventoryTx(r.p.characterId, (d) => addGold(d, o.gold ?? 1_000_000))
    g.afterInventory(r.p, draft)
    return r
  }
  const goldOf = (p: Player) => h.store.loadInventory(p.characterId).gold
  const req = (r: Who, msg: Parameters<typeof h.req>[1]) => {
    h.req(r.p, msg)
    return h.result(r.inbox, msg.t)
  }
  const warp = (r: Who, x: number, z: number) => h.world.warp(r.p, x, 0, z, h.now)
  /** A Trader (GM join) of `level` in the suit at Jodaesan. */
  const trader = (o: { name?: string; level?: number } = {}) => {
    const r = char([1, 0, 1], o)
    expect(g.jobs.gm([r.p.name, 'join', 'trader'], h.now).ok).toBe(true)
    if (o.level && o.level > 1) g.jobs.gm([r.p.name, 'level', String(o.level)], h.now)
    r.p.lastCombatAt = 0
    expect(req(r, { t: 'jobMode', on: true })).toMatchObject({ ok: true })
    return r
  }
  /** Summons at the trader of `at` (walking there). */
  const summon = (r: Who, tier = 1, at = 'jangan') => {
    const n = post[at]!
    warp(r, n.pos[0] + 1, n.pos[2] - 1)
    r.p.lastCombatAt = 0
    return req(r, { t: 'tradeSummon', npc: n.id, tier })
  }
  const tr = (r: Who) => g.transports.of(r.p.characterId)!
  /** The Trader and the transport both at x/z (2 m apart: it stands still), the world's view refreshed. */
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
  const buy = (r: Who, good: string, crates: number, dest = 'ferry-landing', where = 'jangan') =>
    req(r, { t: 'tradeBuy', npc: post[where]!.id, good, crates, dest: dest as 'ferry-landing' })
  const sell = (r: Who, where: string, good?: string, crates?: number) =>
    req(r, { t: 'tradeSell', npc: post[where]!.id, ...(good ? { good } : {}), ...(crates ? { crates } : {}) })
  const thief = (pos: Vec3, name = 'Thea') => {
    const r = char(pos, { name })
    g.jobs.gm([name, 'join', 'thief'], h.now)
    g.jobs.gm([name, 'mode', 'on'], h.now)
    return r
  }
  return { h, g, data, tick, jump, char, goldOf, req, warp, trader, summon, tr, place, at, buy, sell, thief, post, jod }
}

const S = JOB_SETTINGS_DEFAULTS

describe('the market (§5.1-§5.3)', () => {
  it('a Trader buys silk at Jodaesan, walks it to the Ferry Landing and sells at the margin; job EXP from the profit', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    const g0 = x.goldOf(t.p)
    expect(x.summon(t)).toMatchObject({ ok: true })
    expect(g0 - x.goldOf(t.p)).toBe(2000)
    expect(x.h.all(t.inbox, 'transportState').at(-1)?.transport).toMatchObject({ tier: 1, name: 'Donkey', capacity: 30, hold: [], stars: 0 })
    x.req(t, { t: 'tradeMarket', npc: x.jod.id })
    const m = x.h.all(t.inbox, 'market').at(-1)!
    expect(m.post).toBe('jangan')
    expect(m.rows.find((r) => r.good === SILK)).toMatchObject({ buy: 800, demand: 1 })
    expect(m.rows.find((r) => r.good === 'ITEM_ETC_TRADE_WC_05')?.buy).toBeUndefined()
    const g1 = x.goldOf(t.p)
    expect(x.buy(t, SILK, 10)).toMatchObject({ ok: true })
    const cost = tradeBuyTotal(800, 1, 10, S.drift)
    expect(cost.gold).toBe(8036)
    expect(g1 - x.goldOf(t.p)).toBe(cost.gold)
    expect(x.tr(t)).toMatchObject({ crates: 10, stars: 1, dest: 'ferry-landing', from: 'jangan' })
    // the source's price drifted up
    expect(x.g.market.cell('jangan', SILK, x.h.now).buyMul).toBeCloseTo(1.01, 6)
    // at the Ferry Landing
    x.at(t, 'ferry-landing')
    const posts = x.g.jobs.content.posts
    const margin = tradeMargin(posts.find((p) => p.id === 'jangan')!, posts.find((p) => p.id === 'ferry-landing')!, S.trade)
    const want = tradeSellTotal(800, margin, 1, 10, { taxPct: S.trade.taxPct, drift: S.drift })
    const g2 = x.goldOf(t.p)
    x.g.market.setNews('south-beach', LEATHER, x.h.now) // not this good: no bonus
    expect(x.sell(t, 'ferry-landing')).toMatchObject({ ok: true })
    expect(x.goldOf(t.p) - g2).toBe(want.gold)
    expect(want.gold).toBeGreaterThan(cost.gold)
    expect(x.tr(t)).toMatchObject({ crates: 0, stars: 0, dest: null })
    const exp = traderSaleExp(want.gold - cost.gold, 1, S.exp)
    expect(exp).toBeGreaterThan(0)
    expect(x.g.jobs.view(t.p, x.h.now).exp).toBe(exp)
    // demand at the post fell by 10 × 0.2 %
    expect(x.g.market.cell('ferry-landing', SILK, x.h.now).demand).toBeCloseTo(0.98, 6)
    // the trade log
    const log = x.g.market.store.recent(10)
    expect(log.map((r) => r.kind)).toEqual(['sell', 'buy', 'summon'])
  })

  it('selling where it was bought pays 0.9 × the buy price; news sells at × 1.2; drift recovers by the hour', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.buy(t, SILK, 10)
    const mul = x.g.market.cell('jangan', SILK, x.h.now).buyMul
    const g0 = x.goldOf(t.p)
    expect(x.sell(t, 'jangan', SILK, 4)).toMatchObject({ ok: true })
    expect(x.goldOf(t.p) - g0).toBe(tradeSellPrice(800, null, 1, S.trade.taxPct, mul) * 4)
    // a loss: no job EXP
    expect(x.g.jobs.view(t.p, x.h.now).exp).toBe(0)
    // the news: × newsDemand on the price, not on the stored demand
    x.at(t, 'sea-cliffs')
    x.g.market.setNews('sea-cliffs', SILK, x.h.now)
    const posts = x.g.jobs.content.posts
    const margin = tradeMargin(posts.find((p) => p.id === 'jangan')!, posts.find((p) => p.id === 'sea-cliffs')!, S.trade)
    const g1 = x.goldOf(t.p)
    expect(x.sell(t, 'sea-cliffs', SILK, 6)).toMatchObject({ ok: true })
    expect(x.goldOf(t.p) - g1).toBe(tradeSellTotal(800, margin, 1, 6, { taxPct: 3, drift: S.drift }, Infinity, 1.2).gold)
    expect(x.g.market.cell('sea-cliffs', SILK, x.h.now).demand).toBeCloseTo(0.988, 6)
    // recovery: 3 % an hour toward 1
    x.jump(HOUR / 3)
    expect(x.g.market.cell('sea-cliffs', SILK, x.h.now).demand).toBeCloseTo(0.998, 3)
    x.jump(HOUR)
    expect(x.g.market.cell('sea-cliffs', SILK, x.h.now).demand).toBe(1)
    expect(x.g.market.cell('jangan', SILK, x.h.now).buyMul).toBe(1)
  })

  it('refusals: no suit, no transport, the wrong source, the destination, the hold, the stars cap, gold', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    expect(x.buy(t, SILK, 1)).toMatchObject({ ok: false, reason: 'not_found' }) // no transport
    x.summon(t)
    x.warp(t, 1, 1)
    expect(x.buy(t, 'ITEM_ETC_TRADE_WC_05', 1)).toMatchObject({ ok: false, reason: 'not_found' }) // pearls: the beach's
    expect(x.buy(t, SILK, 1, 'jangan')).toMatchObject({ ok: false, reason: 'wrong_place' })
    expect(x.buy(t, SILK, 31)).toMatchObject({ ok: false, reason: 'hold_full' })
    // level 1: at most 2 stars (< 60,000): 25 crates of tiger leather are 75,000+
    expect(x.buy(t, LEATHER, 25)).toMatchObject({ ok: false, reason: 'stars_cap' })
    expect(x.buy(t, LEATHER, 9)).toMatchObject({ ok: true })
    expect(x.tr(t).stars).toBe(tradeStars(x.tr(t).hold[0]!.cost, S.trade.starThresholds))
    expect(x.tr(t).stars).toBe(2)
    // out of the suit: refused (and the suit cannot come off while loaded)
    expect(x.req(t, { t: 'jobMode', on: false })).toMatchObject({ ok: false, reason: 'not_usable' })
    x.g.jobs.gm(['Tess', 'mode', 'off'], x.h.now)
    expect(x.buy(t, SILK, 1)).toMatchObject({ ok: false, reason: 'not_job_mode' })
    x.g.jobs.gm(['Tess', 'mode', 'on'], x.h.now)
    // the transport outside the ring
    x.tr(t).c.pos = [40, 0, 40]
    expect(x.buy(t, SILK, 1)).toMatchObject({ ok: false, reason: 'too_far' })
    // a non-Trader
    const plain = x.char([1, 0, 1])
    expect(x.req(plain, { t: 'tradeSummon', npc: x.jod.id, tier: 1 })).toMatchObject({ ok: false, reason: 'requirements' })
    // poor
    const poor = x.trader({ name: 'Poor' })
    const { draft } = x.h.store.inventoryTx(poor.p.characterId, (d) => addGold(d, -d.gold + 100))
    x.g.afterInventory(poor.p, draft)
    expect(x.summon(poor)).toMatchObject({ ok: false, reason: 'not_enough_gold' })
  })

  it('anti-abuse: the hourly buy cap per account; one account moves a demand at most drift.accountDayMax a day', () => {
    const x = harness()
    x.g.jobs.savePatch({ trade: { buyCapPerHour: 20 }, drift: { accountDayMax: 0.01 } }, null, x.h.now)
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.warp(t, 1, 1)
    expect(x.buy(t, SILK, 15)).toMatchObject({ ok: true })
    expect(x.buy(t, SILK, 6)).toMatchObject({ ok: false, reason: 'buy_cap' })
    expect(x.buy(t, SILK, 5)).toMatchObject({ ok: true })
    // 20 crates sold would move demand 4 %: the account moves it 1 % only
    x.at(t, 'tomb-camp')
    expect(x.sell(t, 'tomb-camp')).toMatchObject({ ok: true })
    expect(x.g.market.cell('tomb-camp', SILK, x.h.now).demand).toBeCloseTo(0.99, 6)
    x.at(t, 'jangan')
    expect(x.buy(t, SILK, 1)).toMatchObject({ ok: false, reason: 'buy_cap' })
    x.jump(HOUR + 1000)
    x.at(t, 'jangan')
    expect(x.buy(t, SILK, 5)).toMatchObject({ ok: true })
  })

  it('escorts: a Bounty Hunter in the party, in the suit, near, gets 40 % of the job EXP; never from the same IP', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    const hu = x.char([1, 0, 1], { name: 'Hugo' })
    x.g.jobs.gm(['Hugo', 'join', 'hunter'], x.h.now)
    x.g.jobs.gm(['Hugo', 'mode', 'on'], x.h.now)
    x.h.req(t.p, { t: 'partyInvite', target: hu.p.id })
    x.h.req(hu.p, { t: 'partyRespond', inviter: t.p.id, accept: true })
    x.summon(t)
    x.buy(t, SILK, 20)
    x.at(t, 'ferry-landing')
    x.warp(hu, x.post['ferry-landing']!.pos[0] + 10, x.post['ferry-landing']!.pos[2])
    expect(x.sell(t, 'ferry-landing', SILK, 10)).toMatchObject({ ok: true })
    const exp = x.g.jobs.view(t.p, x.h.now).exp
    expect(x.g.jobs.view(hu.p, x.h.now).exp).toBe(hunterEscortExp(exp, S.exp))
    // the same IP: nothing, and a law flag
    const ips = new Map<number, string>([
      [t.p.id, '203.0.113.9'],
      [hu.p.id, '203.0.113.9'],
    ])
    x.g.law.connect({ ipOf: (p) => ips.get(p.id) ?? null })
    const before = x.g.jobs.view(hu.p, x.h.now).exp
    expect(x.sell(t, 'ferry-landing', SILK, 10)).toMatchObject({ ok: true })
    expect(x.g.jobs.view(hu.p, x.h.now).exp).toBe(before)
    expect(x.g.law.store.flags(10).some((f) => f.rule === 'escort_same_ip')).toBe(true)
  })
})

describe('transports (§5.4)', () => {
  it('summon: by job level and tier, one at a time, not beside a horse; the scroll at a trade point', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    expect(x.summon(t, 2)).toMatchObject({ ok: false, reason: 'requirements' })
    expect(x.summon(t, 1)).toMatchObject({ ok: true })
    expect(x.summon(t, 1)).toMatchObject({ ok: false, reason: 'cos_active' })
    expect(x.h.world.state(x.tr(t).c)).toMatchObject({ kind: 'cos', model: 'COS_T_DONKEY', hp: 2500, maxHp: 2500 })
    expect(x.req(t, { t: 'transportDismiss' })).toMatchObject({ ok: true })
    expect(x.g.transports.of(t.p.characterId)).toBeNull()
    // the scroll: only at a trade point
    const { draft } = x.h.store.inventoryTx(t.p.characterId, (d) => addItem(d, DONKEY_SCROLL, 2))
    x.g.afterInventory(t.p, draft)
    const bag = x.h.store.loadInventory(t.p.characterId).bag.findIndex((i) => i?.code === DONKEY_SCROLL.code)
    x.warp(t, 300, 300)
    expect(x.req(t, { t: 'itemUse', bag })).toMatchObject({ ok: false, reason: 'wrong_place' })
    x.warp(t, 2, 2)
    expect(x.req(t, { t: 'itemUse', bag })).toMatchObject({ ok: true })
    expect(x.tr(t).def.name).toBe('Donkey')
    expect(x.h.store.loadInventory(t.p.characterId).bag[bag]?.count).toBe(1)
    // level 3: the Horse
    x.req(t, { t: 'transportDismiss' })
    x.g.jobs.gm(['Tess', 'level', '3'], x.h.now)
    expect(x.summon(t, 2)).toMatchObject({ ok: true })
    expect(x.tr(t)).toMatchObject({ capacity: 60 })
  })

  it('follows its Trader along the trail, waits past 60 m; the Trader rides it at its pace and hits land on it', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.buy(t, SILK, 5)
    x.place(t, 100, 100)
    x.h.world.moveTo(t.p, 100, 130, x.h.now)
    x.tick(15_000)
    const tp = x.h.world.positionAt(x.tr(t).c, x.h.now)
    const d = Math.hypot(tp[0] - 102, tp[2] - 130)
    expect(d).toBeLessThan(S.transport.gapM + 2)
    expect(x.h.all(t.inbox, 'move').some((m) => m.id === x.tr(t).c.id)).toBe(true)
    // too far: it waits
    x.warp(t, 100, 220)
    x.tick(2000)
    expect(x.tr(t).c.move).toBeNull()
    expect(x.h.all(t.inbox, 'chat').some((c) => /waits for you/.test(c.text))).toBe(true)
    // ride it
    x.place(t, 150, 150)
    x.warp(t, 151, 150)
    t.p.lastCombatAt = 0
    expect(x.req(t, { t: 'transportRide', on: true })).toMatchObject({ ok: true })
    expect(x.g.transports.ridden(t.p)).toBe(x.tr(t).c)
    expect(x.h.world.state(t.p).mount).toBe(x.tr(t).c.id)
    expect(x.req(t, { t: 'attack', target: t.p.id })).toMatchObject({ ok: false })
    // a monster's hit on the rider lands on the transport
    const m = x.h.dummy(152, 150, { physAttack: [100, 100], hitRate: 1000 })
    const hp = t.p.hp
    x.g.attack(m, t.p, x.h.now)
    expect(t.p.hp).toBe(hp)
    expect(x.tr(t).c.hp).toBeLessThan(2500)
    // its walk speed: mountSpeed = 4.0 / 5
    expect(x.req(t, { t: 'transportRide', on: false })).toMatchObject({ ok: true })
    expect(x.g.transports.ridden(t.p)).toBeNull()
  })

  it('stay here / follow (transportFollow): it stands still while staying, follows again when told; riding clears it', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.buy(t, SILK, 5)
    x.place(t, 100, 100)
    expect(x.req(t, { t: 'transportFollow', on: false })).toMatchObject({ ok: true })
    expect(x.g.transports.view(x.tr(t)).staying).toBe(true)
    expect(x.h.all(t.inbox, 'transportState').at(-1)?.transport?.staying).toBe(true)
    const at = x.h.world.positionAt(x.tr(t).c, x.h.now)
    x.h.world.moveTo(t.p, 100, 130, x.h.now)
    x.tick(15_000)
    const still = x.h.world.positionAt(x.tr(t).c, x.h.now)
    expect(Math.hypot(still[0] - at[0], still[2] - at[2])).toBeLessThan(0.01)
    expect(x.h.all(t.inbox, 'chat').some((c) => /waits for you/.test(c.text))).toBe(false)
    // follow again
    expect(x.req(t, { t: 'transportFollow', on: true })).toMatchObject({ ok: true })
    x.tick(15_000)
    const tp = x.h.world.positionAt(x.tr(t).c, x.h.now)
    expect(Math.hypot(tp[0] - 102, tp[2] - 130)).toBeLessThan(S.transport.gapM + 2)
    // ridden: no stay; boarding clears it
    expect(x.req(t, { t: 'transportFollow', on: false })).toMatchObject({ ok: true })
    x.warp(t, tp[0] + 1, tp[2])
    t.p.lastCombatAt = 0
    expect(x.req(t, { t: 'transportRide', on: true })).toMatchObject({ ok: true })
    expect(x.tr(t).staying).toBe(false)
    expect(x.req(t, { t: 'transportFollow', on: false })).toMatchObject({ ok: false, reason: 'mounted' })
    // without a transport
    const u = x.trader({ name: 'Uri' })
    expect(x.req(u, { t: 'transportFollow', on: true })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('monsters go for a loaded transport; it dies: 60 % of each good falls as bags, the rest is lost; the row goes', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.buy(t, SILK, 10)
    x.buy(t, LEATHER, 5)
    // the Trader in town, the transport waiting on the road, a bandit beside it
    x.place(t, 0, 150)
    x.warp(t, 0, 70)
    x.tick(1000)
    expect(x.tr(t).c.move).toBeNull()
    const c = x.tr(t).c
    const b = x.g.createMob(BANDIT, 'normal', 0, 153, 0, null, x.h.now, null, undefined, (m) => {
      m.sightRange = 10
    })
    x.tick(8000)
    expect(b.target === c.id || c.diedAt !== 0).toBe(true)
    x.tick(10_000)
    expect(c.diedAt).not.toBe(0)
    expect(x.g.transports.of(t.p.characterId)).toBeNull()
    const bags = [...x.g.transports.bags.values()]
    expect(bags.map((b) => [b.good, b.crates]).sort()).toEqual([
      [SILK, 6],
      [LEATHER, 3],
    ].sort())
    expect(x.g.market.store.transport(t.p.characterId)).toBeNull()
    expect(x.g.market.store.recent(1)[0]).toMatchObject({ kind: 'lost', crates: 15 })
    expect(x.h.all(t.inbox, 'transportState').at(-1)?.transport).toBeNull()
    // the owner sees the bags (in the suit), a plain player does not
    const plain = x.char([0, 0, 152])
    x.tick(1500)
    expect(x.h.all(t.inbox, 'bag').length).toBe(2)
    expect(x.h.all(plain.inbox, 'bag').length).toBe(0)
    // no transport: the owner carries them himself (layer 4: his own sack, jobs/robbery.ts)
    x.warp(t, bags[0]!.x, bags[0]!.z)
    expect(x.req(t, { t: 'bagPick', id: bags[0]!.id })).toMatchObject({ ok: true })
    // bags expire after thief.bagLifeMin (the bandit may kill her: what she carries falls again, with a new life)
    x.tick(S.thief.bagLifeMin * MIN + 2000)
    x.tick(S.thief.bagLifeMin * MIN + 2000)
    expect(x.g.transports.bags.size).toBe(0)
    expect(x.h.all(t.inbox, 'bagGone').length).toBeGreaterThanOrEqual(1)
  })

  it('lightning hits it as a player; a tornado scatters 20 %: the owner and his party pick the bags back, a stranger cannot', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.buy(t, SILK, 20)
    x.place(t, 200, 0)
    const c = x.tr(t).c
    const strike = { id: 7, kind: 'ground', pos: [200, 0, 0], radiusM: 6, at: x.h.now } as unknown as LightningStrike
    x.g.transports.strike(strike, x.h.now)
    expect(c.hp).toBeLessThan(2500)
    expect(x.h.all(t.inbox, 'combat').some((m) => m.target === c.id && m.cause === 'lightning')).toBe(true)
    // a strike in town does nothing
    x.place(t, 0, 0)
    const hp = c.hp
    x.g.transports.strike({ ...strike, pos: [0, 0, 0] } as LightningStrike, x.h.now)
    expect(c.hp).toBe(hp)
    // a tornado on the ground over it: 20 % of the crates fall along its path, once per tornado
    x.place(t, 200, 0)
    const tw = x.g.tornado as unknown as { state: unknown }
    tw.state = { id: 3, seed: 1, warnAt: x.h.now - 20_000, touchAt: x.h.now - 1000, endAt: x.h.now + 60_000, path: [[195, 0, 0], [260, 0, 0]], speedMs: 2, pullM: 30, coreM: 8, strength: 1 }
    x.g.transports.tick(x.h.now)
    x.g.transports.tick(x.h.now + 100)
    tw.state = null
    expect(x.tr(t).crates).toBe(16)
    expect(x.h.all(t.inbox, 'chat').some((c) => /tornado tears 4 crate/.test(c.text))).toBe(true)
    x.tick(1500)
    const [bag] = [...x.g.transports.bags.values()]
    expect(bag).toMatchObject({ good: SILK, crates: 4 })
    const stranger = x.trader({ name: 'Stan' })
    x.warp(stranger, bag!.x, bag!.z)
    x.tick(1500)
    expect(x.req(stranger, { t: 'bagPick', id: bag!.id })).toMatchObject({ ok: false, reason: 'not_owner' })
    // a party member puts it back into the owner's transport
    const mate = x.char([bag!.x, 0, bag!.z], { name: 'Mate' })
    x.g.jobs.gm(['Mate', 'join', 'hunter'], x.h.now)
    x.g.jobs.gm(['Mate', 'mode', 'on'], x.h.now)
    x.h.req(t.p, { t: 'partyInvite', target: mate.p.id })
    x.h.req(mate.p, { t: 'partyRespond', inviter: t.p.id, accept: true })
    x.tick(1500)
    expect(x.req(mate, { t: 'bagPick', id: bag!.id })).toMatchObject({ ok: true })
    expect(x.tr(t).crates).toBe(20)
    expect(x.g.transports.bags.size).toBe(0)
  })

  it("the Trader's death: the transport stays 30 s (a target), then drops its goods", () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.buy(t, SILK, 10)
    x.place(t, 200, 0)
    x.g.hazardHit(t.p, 1e9, 'lightning', x.h.now)
    expect(t.p.dead).toBe(true)
    x.tick(20_000)
    expect(x.tr(t)).not.toBeNull()
    expect(x.g.transports.mobTarget(x.tr(t).c.id)).toBeDefined()
    x.tick(11_000)
    expect(x.g.transports.of(t.p.characterId)).toBeNull()
    expect([...x.g.transports.bags.values()].map((b) => b.crates)).toEqual([6])
  })

  it('logout: an empty one goes; a loaded one lingers 60 s, then is saved and comes back at the next login', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.buy(t, SILK, 10, 'sea-cliffs')
    x.place(t, 200, 0)
    const id = x.tr(t).c.id
    const relog = (r: Who): Who => {
      x.h.world.settle(r.p, x.h.now)
      x.h.world.remove(r.p.id, x.h.now)
      x.g.forget(r.p)
      const inbox: ServerMessage[] = []
      const row = x.h.store.characterById(r.p.characterId)!
      const q = x.h.world.add({ ...x.g.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: r.p.level, weapon: row.weapon, pos: [...r.p.pos], yaw: 0, send: (m) => inbox.push(m) })
      x.h.world.snapshotFor(q, x.h.now)
      x.g.sendEnter(q, x.h.now)
      return { p: q, inbox }
    }
    x.h.world.settle(t.p, x.h.now)
    x.h.world.remove(t.p.id, x.h.now)
    x.g.forget(t.p)
    x.tick(30_000)
    expect(x.h.world.cos.has(id)).toBe(true) // lingering: a target
    x.tick(31_000)
    expect(x.h.world.cos.has(id)).toBe(false)
    expect(x.g.market.store.transport(t.p.characterId)).toMatchObject({ tier: 1, dest: 'sea-cliffs', stars: 1 })
    // back at the next login, where it stood, with its goods
    const row = x.h.store.characterById(t.p.characterId)!
    const inbox: ServerMessage[] = []
    const q = x.h.world.add({ ...x.g.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: 20, weapon: row.weapon, pos: [202, 0, 0], yaw: 0, send: (m) => inbox.push(m) })
    x.h.world.snapshotFor(q, x.h.now)
    x.g.sendEnter(q, x.h.now)
    const back = x.g.transports.of(row.id)!
    expect(back).toMatchObject({ crates: 10, dest: 'sea-cliffs', from: 'jangan' })
    expect(back.c.pos[0]).toBeCloseTo(200, 0)
    expect(inbox.some((m) => m.t === 'transportState' && m.transport?.hold[0]?.crates === 10)).toBe(true)
    // a relog inside the linger takes the same one over
    const r2 = relog({ p: q, inbox })
    expect(x.g.transports.of(row.id)!.c.id).toBe(back.c.id)
    expect(x.g.transports.of(row.id)!.lingerUntil).toBe(0)
    // empty: gone at the logout
    x.g.transports.unload(x.g.transports.of(row.id)!, SILK, 10, x.h.now)
    x.h.world.remove(r2.p.id, x.h.now)
    x.g.forget(r2.p)
    expect(x.g.transports.of(row.id)).toBeNull()
    expect(x.g.market.store.transport(row.id)).toBeNull()
  })
})

describe('ambushes by stars (§6.2)', () => {
  const run = (stars: number) => {
    const x = harness()
    const t = x.trader({ name: 'Tess', level: 7 })
    x.summon(t)
    expect(x.g.transports.gm(['Tess', 'load', String(stars), 'ferry-landing'], x.h.now).ok).toBe(true)
    const tr = x.tr(t)
    expect(tr.stars).toBe(stars)
    // leave Jangan: the plan; then along the road to the Ferry Landing (-420, 100)
    const along = (f: number) => {
      x.place(t, -420 * f, 3 + 97 * f)
      x.tick(100)
    }
    along(0.15)
    const planned = tr.ambushAt.length
    for (const f of [0.35, 0.5, 0.65, 0.85]) along(f)
    return { x, t, tr, planned }
  }

  it('none at ★, 1 at ★★★, 2 at ★★★★★ (rng 0.5); each group 3-5 bandits after the transport', () => {
    expect(run(1).planned).toBe(0)
    expect(run(2).planned).toBe(0)
    const three = run(3)
    expect(three.planned).toBe(1)
    expect(three.tr.ambushes).toBe(1)
    expect(three.x.g.transports.ambusherCount).toBe(4)
    const bandits = [...three.x.h.world.mobs.values()].filter((m) => m.def.code === 'MOB_CH_BANDIT')
    expect(bandits.every((m) => m.target === three.tr.c.id || m.ai !== 'idle')).toBe(true)
    expect(three.x.h.all(three.t.inbox, 'chat').some((c) => /Bandits leap out/.test(c.text))).toBe(true)
    const five = run(5)
    expect(five.planned).toBe(2)
    expect(five.tr.ambushes).toBe(2)
  })

  it('unkilled ambushers leave after ambush.lifeMin; GM ambush springs one now', () => {
    const { x, t } = run(3)
    expect(x.g.transports.gmAmbush(['Tess', '2'], x.h.now)).toMatchObject({ ok: true })
    expect(x.g.transports.ambusherCount).toBe(12)
    // the Trader rides off; the transport dies or the bandits time out
    x.g.transports.gm(['Tess', 'kill'], x.h.now)
    x.tick(S.ambush.lifeMin * MIN + 30_000)
    expect(x.g.transports.ambusherCount).toBeLessThan(12)
    void t
  })
})

describe('abuse (§7, §11)', () => {
  it('loaded: no return scroll, no suit off, no leaving the job, no dismissing', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.buy(t, SILK, 3)
    const { draft } = x.h.store.inventoryTx(t.p.characterId, (d) => addItem(d, RETURN_NOW, 1))
    x.g.afterInventory(t.p, draft)
    const bag = x.h.store.loadInventory(t.p.characterId).bag.findIndex((i) => i?.code === RETURN_NOW.code)
    expect(x.req(t, { t: 'itemUse', bag })).toMatchObject({ ok: false, reason: 'loaded' })
    expect(x.req(t, { t: 'transportDismiss' })).toMatchObject({ ok: false, reason: 'loaded' })
    expect(x.req(t, { t: 'jobMode', on: false })).toMatchObject({ ok: false, reason: 'not_usable' })
    x.g.jobs.gm(['Tess', 'mode', 'off'], x.h.now)
    expect(x.g.jobs.leaveProblem(t.p, x.h.now)).toMatchObject({ reason: 'not_usable' })
    // sold out: all of it is allowed again
    x.g.jobs.gm(['Tess', 'mode', 'on'], x.h.now)
    x.warp(t, 1, 1)
    expect(x.sell(t, 'jangan')).toMatchObject({ ok: true })
    expect(x.req(t, { t: 'itemUse', bag })).toMatchObject({ ok: true })
  })

  it('balance: Thieves roll against the tier\'s transport.thiefDefence, × transport.thiefMul; monsters keep the fixed defence; live settings', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess', level: 7 })
    x.summon(t)
    x.buy(t, SILK, 10)
    x.place(t, 200, 0)
    const c = x.tr(t).c
    const th = x.thief([201.5, 0, 1], 'Thea')
    x.tick(200)
    expect(x.g.transports.combatVsPlayers(c)).toMatchObject({ physDefence: S.transport.thiefDefence[0], magDefence: S.transport.thiefDefence[0] })
    expect(TRANSPORT_COMBAT.physDefence).toBe(60)
    const hp = c.hp
    expect(x.g.transports.hit(th.p, c, [{ outcome: 'hit', damage: 101, hp: 0 }], {}, x.h.now).dealt).toBe(Math.round(101 * S.transport.thiefMul))
    expect(c.hp).toBe(hp - Math.round(101 * S.transport.thiefMul))
    // a live change (the admin's Settings tab): × 1, and the Ironclad's armour
    x.g.jobs.savePatch({ transport: { thiefMul: 1, thiefDefence: [10, 15, 20, 80] } }, null, x.h.now)
    expect(x.g.transports.hit(th.p, c, [{ outcome: 'hit', damage: 101, hp: 0 }], {}, x.h.now).dealt).toBe(101)
    expect(x.g.transports.combatVsPlayers(c).physDefence).toBe(10)
    expect(transportCombatVsPlayers(4, [10, 15, 20, 80]).physDefence).toBe(80)
    expect(transportCombatVsPlayers(9, [10, 15, 20, 80]).physDefence).toBe(80)
    // a monster's hit is not scaled
    const m = x.h.dummy(202, 0, { physAttack: [100, 100], hitRate: 1000 })
    const before = c.hp
    expect(x.g.transports.hit(m, c, [{ outcome: 'hit', damage: 77, hp: 0 }], {}, x.h.now).dealt).toBe(77)
    expect(c.hp).toBe(before - 77)
  })

  it('Thieves rob a loaded transport on the road (× thiefMul, job EXP for the kill); never associates, outside the suit, empty ones or in a ring', () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    x.summon(t)
    x.buy(t, SILK, 10)
    x.place(t, 200, 0)
    const c = x.tr(t).c
    const th = x.thief([201.5, 0, 1], 'Thea')
    x.tick(200)
    expect(x.req(th, { t: 'attack', target: c.id })).toMatchObject({ ok: true })
    x.tick(3000)
    expect(c.hp).toBeLessThan(2500)
    // the suit stays on after hitting a caravan
    expect(x.req(th, { t: 'jobMode', on: false })).toMatchObject({ ok: false, reason: 'in_combat' })
    x.h.req(th.p, { t: 'stopAction' })
    // the same party: no robbing
    x.h.req(t.p, { t: 'partyInvite', target: th.p.id })
    x.h.req(th.p, { t: 'partyRespond', inviter: t.p.id, accept: true })
    expect(x.req(th, { t: 'attack', target: c.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    x.h.req(th.p, { t: 'partyLeave' })
    // and after the party: a recorded contact (law.contactDays)
    expect(x.req(th, { t: 'attack', target: c.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    // out of the suit, or another job: no
    const plain = x.char([201, 0, 2], { name: 'Plain' })
    x.tick(200)
    expect(x.req(plain, { t: 'attack', target: c.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    // the post's ring is safe
    const post = x.post['sea-cliffs']!
    x.place(t, post.pos[0] + 5, post.pos[2])
    x.warp(th, post.pos[0] + 6, post.pos[2])
    x.tick(200)
    expect(x.req(th, { t: 'attack', target: c.id })).toMatchObject({ ok: false, reason: 'safe_zone' })
    // on the road again, another Thief: the kill credits it (≥ 25 % of its HP: 200 × stars job EXP)
    x.place(t, 200, 0)
    const th2 = x.thief([201.5, 0, 1], 'Theo')
    x.tick(200)
    th2.p.combat.physAttack = [5000, 5000]
    expect(x.req(th2, { t: 'attack', target: c.id })).toMatchObject({ ok: true })
    x.tick(6000)
    expect(c.diedAt).not.toBe(0)
    expect(x.g.market.store.recent(1)[0]).toMatchObject({ kind: 'robbed', crates: 10 })
    expect(x.g.jobs.view(th2.p, x.h.now).exp).toBe(S.exp.thiefTransportKill * 1)
    // the first Thief's few hits were under 25 %: no credit
    expect(x.g.jobs.view(th.p, x.h.now).exp).toBe(0)
  })

  it('self-robbery never pays: what drops and what the den would pay is below the cost of the load', () => {
    for (const good of JOB_SETTINGS_DEFAULTS ? [800, 1000, 3000, 4000] : []) {
      for (const crates of [1, 10, 30, 120]) {
        const cost = good * crates
        const dropped = Math.floor((crates * S.thief.dropPct) / 100)
        expect(Math.floor((good * dropped * S.thief.denPct) / 100)).toBeLessThan(cost)
      }
    }
  })
})

describe('GM and admin (§9.5)', () => {
  it('GM trade / transport / ambush / bag; admin GET lists the market and transports, POST market; audited', async () => {
    const x = harness()
    const t = x.trader({ name: 'Tess' })
    const gm = (...a: string[]) => x.g.market.gm(a, x.h.now)
    expect(gm('price', 'ferry-landing', SILK, '0.8').ok).toBe(true)
    expect(x.g.market.cell('ferry-landing', SILK, x.h.now).demand).toBe(0.8)
    expect(gm('price', 'ferry-landing', SILK, '9').ok).toBe(false)
    expect(gm('news', 'sea-cliffs', 'white silk').message).toMatch(/White Silk sells well at Sea Cliffs/)
    expect(gm('reset').ok).toBe(true)
    expect(x.g.market.cell('ferry-landing', SILK, x.h.now).demand).toBe(1)
    expect(x.g.transports.gm(['Tess', 'spawn', '4'], x.h.now)).toMatchObject({ ok: true })
    expect(x.tr(t).def.name).toBe('Ironclad Trade Horse')
    expect(x.g.transports.gm(['Tess', 'load', '4'], x.h.now).message).toMatch(/4 stars/)
    expect(x.h.world.state(x.tr(t).c).stars).toBe(4)
    expect(x.g.transports.gm(['Tess'], x.h.now).message).toMatch(/Ironclad Trade Horse: 7000\/7000 HP/)
    expect(x.g.transports.gm(['Tess', 'kill'], x.h.now).ok).toBe(true)
    expect(x.g.transports.gmBag([]).message).toMatch(/Goods bags/)
    expect(x.g.transports.gmBag(['clear']).message).toMatch(/1 goods bag/)
    expect(x.g.transports.gmAmbush(['Tess'], x.h.now).ok).toBe(false)
    const ctx = { gameplay: x.g, world: x.h.world, data: x.h.data, store: x.h.store, config: x.h.config } as unknown as GameContext
    const actor = { accountId: x.h.store.characterById(t.p.characterId)!.account_id, role: 'admin' as const, username: 'root' }
    const call = async <T = Record<string, unknown>>(method: string, sub: string, body?: unknown) =>
      (await routeAdminJobs(ctx, { method, path: `/api/admin/jobs${sub}`, query: new URLSearchParams(''), body, actor })) as { status: number; body: T }
    x.summon(t)
    const v = (await call<AdminJobsView>('GET', '')).body
    expect(v.market?.rows.length).toBe(5 * 14)
    expect(v.transports).toEqual([expect.objectContaining({ name: 'Tess', tier: 1, live: true })])
    expect((await call('POST', '/market', { post: 'tomb-camp', good: SILK, demand: 0.75 })).status).toBe(200)
    expect(x.g.market.cell('tomb-camp', SILK, x.h.now).demand).toBe(0.75)
    expect((await call('POST', '/market', {})).status).toBe(400)
    expect((await call('POST', '/market', { reset: true })).status).toBe(200)
    const audit = x.h.store.db.prepare("SELECT args FROM gm_audit WHERE command = 'job'").all() as { args: string }[]
    expect(audit.some((a) => a.args.includes('market'))).toBe(true)
  })

  it('settings: the transport and ambush groups are bounded', () => {
    const x = harness()
    expect(x.g.jobs.saveSettings(0, { transport: { waitM: 9999 } }, null, x.h.now)).toMatchObject({ ok: false, status: 422 })
    expect(x.g.jobs.saveSettings(0, { ambush: { perStar: [0, 1, 1, 2, 3] } }, null, x.h.now)).toMatchObject({ ok: true })
    expect(x.g.jobs.settings.ambush.perStar).toEqual([0, 1, 1, 2, 3])
  })
})

/** Typed access for the tests (LiveTransport fields). */
export type { LiveTransport }
