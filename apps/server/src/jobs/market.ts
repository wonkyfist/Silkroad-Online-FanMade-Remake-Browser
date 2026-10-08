import {
  JOB_CODES,
  TRADE_POINT_IDS,
  driftRecover,
  holdValue,
  hunterEscortExp,
  maxStarsAt,
  tradeBuyPrice,
  tradeBuyTotal,
  tradeMargin,
  tradeSellPrice,
  tradeSellTotal,
  tradeStars,
  traderSaleExp,
  type GameplayRequest,
  type JobRequest,
  type MarketRow,
  type TradeGood,
  type TradePointId,
  type TradePost,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, fail, type Fail } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from '../modules.ts'
import type { Npc, Player } from '../world.ts'
import { TradeStore, type TradeLogKind } from './trade-store.ts'

/**
 * The job system, layer 2: the market (docs/JOBS.md §5.1-§5.3, §7, §9). A GameplayModule named `market`, after `jobs`.
 *
 * - **Where**: Specialty Trader Jodaesan in Jangan and the four post traders (the `market` NPC service, while the jobs
 *   are on and the posts stand). `tradeMarket {npc}` answers `market {post, rows}`: every good's sell price here (and the
 *   buy price where it is bought), the post's demand, today's news.
 * - **Buying** (`tradeBuy {npc, good, crates, dest}`): a Trader in the suit, at the good's source, with the own transport
 *   inside the post's ring (`transport.ringM`); the crates go into its hold. Refused: `not_job_mode`, `hold_full`,
 *   `stars_cap` (the load's value above the job level's stars, §3.2), `buy_cap` (`trade.buyCapPerHour` crates per
 *   account and hour), not enough gold. Each crate raises the source's buy multiplier by `drift.buyImpact` (cap). The
 *   destination is declared (the ambushes wait on that road, transport.ts).
 * - **Selling** (`tradeSell {npc, good?, crates?}`): at any trade point, from the hold: base × (1 + margin(origin,
 *   post)) × demand × (1 − tax); where the good was bought: its buy price × 0.9. Each crate lowers the post's demand by
 *   `drift.sellImpact` (floor), at most `drift.accountDayMax` per account and UTC day; drift recovers toward 1 at
 *   `drift.recoverPerHour`. A sale with a profit gives job EXP (profit ÷ `exp.traderProfitDiv` × the stars' multiplier)
 *   and escorting Bounty Hunters (in the party, in the suit, within ESCORT_M, another account and IP; at most 2) their
 *   share. Gold never comes from anywhere else: no profit, no EXP.
 * - **The day's news**: one good at one trade point sells at demand × `trade.newsDemand`, rolled at the first look of a
 *   UTC day (job_settings row `market_news`; GM `market news`).
 * - `trade_log` keeps every buy and sale (the buy cap reads it); GM `market` (§9.5 `trade`: `trade` is a client chat prefix); the admin's market routes (jobs-admin.ts).
 */

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** An escorting Hunter stands this close to the Trader at the sale (m, §3.1). */
export const ESCORT_M = 50
const MAX_ESCORTS = 2
const NEWS_CODE = 'market_news'

interface Cell {
  demand: number
  buyMul: number
  at: number
}

export class MarketService implements GameplayModule {
  readonly name = 'market'
  readonly handles: readonly GameplayRequest[] = ['tradeMarket', 'tradeBuy', 'tradeSell'] satisfies readonly JobRequest[]
  private storeCache: TradeStore | null = null
  private cells: Map<string, Cell> | null = null
  private newsCache: { day: number; post: TradePointId; good: string } | null = null

  constructor(private readonly g: Gameplay) {}

  get store(): TradeStore {
    return (this.storeCache ??= new TradeStore(this.g.store.db))
  }

  private get jobs() {
    return this.g.jobs
  }

  // ---- content --------------------------------------------------------------------------------------------------------

  post(id: TradePointId): TradePost | undefined {
    return this.jobs.content.posts.find((p) => p.id === id)
  }

  /** The trade point whose trader is NPC `code`. */
  postOfNpc(code: string): TradePost | undefined {
    return this.jobs.content.posts.find((p) => p.npc.code === code)
  }

  good(code: string): TradeGood | undefined {
    return this.jobs.content.goods.find((x) => x.code === code)
  }

  /** Whether NPC `code` keeps a market (Jodaesan and the post traders, while the jobs are on and the posts stand). */
  offers(code: string): boolean {
    return this.jobs.placed && this.jobs.settings.jobs.enabled && (code === JOB_CODES.traderNpc || this.postOfNpc(code) !== undefined)
  }

  // ---- the market state ------------------------------------------------------------------------------------------------

  private load(): Map<string, Cell> {
    if (this.cells) return this.cells
    const m = new Map<string, Cell>()
    try {
      for (const r of this.store.markets()) m.set(`${r.post}|${r.good}`, { demand: r.demand, buyMul: r.buy_mul, at: r.updated_at })
    } catch {
      // an old schema in a test: everything at 1
    }
    return (this.cells = m)
  }

  /** The post's demand for `good` and the source's buy multiplier, recovered up to `now`. */
  cell(post: TradePointId, good: string, now: number): Cell {
    const c = this.load().get(`${post}|${good}`)
    if (!c) return { demand: 1, buyMul: 1, at: now }
    const h = Math.max(0, now - c.at) / HOUR_MS
    const d = this.jobs.settings.drift
    return { demand: driftRecover(c.demand, h, d), buyMul: driftRecover(c.buyMul, h, d), at: now }
  }

  setCell(post: TradePointId, good: string, c: { demand: number; buyMul: number }, now: number): void {
    const cell = { demand: c.demand, buyMul: c.buyMul, at: now }
    this.load().set(`${post}|${good}`, cell)
    try {
      this.store.putMarket({ post, good, demand: cell.demand, buy_mul: cell.buyMul, updated_at: now })
    } catch (e) {
      this.g.config.log(`market: could not save ${post} ${good}: ${(e as Error).message}`)
    }
  }

  /** Every price back to normal (GM / admin). */
  reset(now: number): void {
    this.cells = new Map()
    this.store.clearMarket()
    void now
  }

  /** Today's market news (rolled once per UTC day; null without goods). */
  news(now: number): { post: TradePointId; good: string } | null {
    const day = Math.floor(now / DAY_MS)
    if (this.newsCache?.day === day) return this.newsCache
    try {
      const row = this.jobs.store.settingsOf(NEWS_CODE)
      const v = row ? (JSON.parse(row.json) as { day?: number; post?: TradePointId; good?: string }) : null
      if (v && v.day === day && v.post && v.good && this.post(v.post) && this.good(v.good)) {
        this.newsCache = { day, post: v.post, good: v.good }
        return this.newsCache
      }
    } catch {
      // no table yet
    }
    const posts = this.jobs.content.posts
    if (posts.length === 0) return null
    const post = posts[Math.floor(this.g.rng() * posts.length)]!
    const goods = this.jobs.content.goods.filter((x) => x.origin !== post.id)
    if (goods.length === 0) return null
    const good = goods[Math.floor(this.g.rng() * goods.length)]!
    return this.setNews(post.id, good.code, now)
  }

  setNews(post: TradePointId, good: string, now: number): { day: number; post: TradePointId; good: string } {
    const day = Math.floor(now / DAY_MS)
    this.newsCache = { day, post, good }
    try {
      this.jobs.store.saveSettings(NEWS_CODE, JSON.stringify(this.newsCache), 1, now, null)
    } catch {
      // no table yet: the news lives until the restart
    }
    return this.newsCache
  }

  /** The demand bonus of `good` at `post` today. */
  private bonus(post: TradePointId, good: string, now: number): number {
    const n = this.news(now)
    return (n && n.post === post && n.good === good ? this.jobs.settings.trade.newsDemand : 1) * this.g.caravan.demandAt(post, now)
  }

  /** The gold of one crate of `g` sold at `post` now (null: the margin is the source's 0.9). */
  sellPrice(g: TradeGood, post: TradePointId, now: number): number {
    const t = this.jobs.settings.trade
    const c = this.cell(post, g.code, now)
    if (g.origin === post) return tradeSellPrice(g.base, null, 1, t.taxPct, this.cell(post, g.code, now).buyMul)
    const from = this.post(g.origin)
    const at = this.post(post)
    if (!from || !at) return 0
    return tradeSellPrice(g.base, tradeMargin(from, at, t), c.demand * this.bonus(post, g.code, now), t.taxPct)
  }

  rows(post: TradePointId, now: number): MarketRow[] {
    const n = this.news(now)
    return this.jobs.content.goods.map((x) => {
      const c = this.cell(post, x.code, now)
      const r: MarketRow = { good: x.code, name: x.name, origin: x.origin, sell: this.sellPrice(x, post, now), demand: round3(c.demand) }
      if (x.origin === post) {
        r.buy = tradeBuyPrice(x.base, c.buyMul)
        r.buyMul = round3(c.buyMul)
      }
      if (n && n.post === post && n.good === x.code) r.news = true
      return r
    })
  }

  sendMarket(p: Player, post: TradePointId, now: number): void {
    p.send({ t: 'market', post, rows: this.rows(post, now) })
  }

  // ---- requests ------------------------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'tradeMarket': {
        const at = this.at(p, msg.npc, now)
        if ('reason' in at) return answer(at)
        answer(true)
        return this.sendMarket(p, at.post.id, now)
      }
      case 'tradeBuy':
        return answer(this.buy(p, msg.npc, msg.good, msg.crates, msg.dest, now))
      case 'tradeSell':
        return answer(this.sell(p, msg.npc, msg.good, msg.crates, now))
      default:
        return answer(fail('not_found'))
    }
  }

  /** The trade point of NPC entity `npcId` that `p` stands at. */
  at(p: Player, npcId: number, now: number): { npc: Npc; post: TradePost } | Fail {
    const npc = this.g.npcs.requireService(p, npcId, 'market', now)
    if (!npc.ok) return npc as Fail
    const post = this.postOfNpc(npc.value.code)
    if (!post) return fail('not_found')
    return { npc: npc.value, post }
  }

  /** A Trader in the suit with the own transport inside the ring of `npc`. */
  private trader(p: Player, npc: Npc, now: number, ownGoods = false): Fail | null {
    if (this.jobs.jobOf(p.characterId) !== 'trader') return fail('requirements', 'Only Traders trade here (the licence: Specialty Trader Jodaesan in Jangan).')
    if (!this.jobs.inMode(p.characterId)) return fail('not_job_mode', 'Put on your Trader suit first.')
    const t = this.g.transports.of(p.characterId)
    // layer 4: crates picked up without a transport are sold from the Trader's own sack
    if (!t && ownGoods) return null
    if (!t) return fail('not_found', 'Summon a trade transport first: the goods travel in its hold.')
    if (this.g.world.distance(t.c, npc, now) > this.jobs.settings.transport.ringM) return fail('too_far', 'Bring your transport closer to the trader.')
    return null
  }

  buy(p: Player, npcId: number, code: string, crates: number, dest: TradePointId, now: number): true | Fail {
    const at = this.at(p, npcId, now)
    if ('reason' in at) return at
    const why = this.trader(p, at.npc, now)
    if (why) return why
    const good = this.good(code)
    if (!good || good.origin !== at.post.id) return fail('not_found', `${good?.name ?? 'That good'} is not sold here.`)
    if (!TRADE_POINT_IDS.includes(dest) || !this.post(dest) || dest === at.post.id) return fail('wrong_place', 'Name another trade point as the destination.')
    const s = this.jobs.settings
    const t = this.g.transports.of(p.characterId)!
    const room = t.capacity - t.crates
    if (crates > room) return fail('hold_full', room > 0 ? `Your ${t.def.name} has room for ${room} more crate(s).` : `Your ${t.def.name} is full.`)
    const acc = this.g.law.accountOf(p.characterId)
    if (acc !== null && s.trade.buyCapPerHour >= 0) {
      const bought = this.store.boughtSince(acc, now - HOUR_MS)
      if (bought + crates > s.trade.buyCapPerHour) {
        return fail('buy_cap', `Your account bought ${bought} crates this hour: at most ${s.trade.buyCapPerHour} an hour.`)
      }
    }
    const cell = this.cell(at.post.id, good.code, now)
    const cost = tradeBuyTotal(good.base, cell.buyMul, crates, s.drift)
    const level = this.jobs.levelOf(p.characterId)
    const stars = tradeStars(holdValue(t.hold) + cost.gold, s.trade.starThresholds)
    const cap = maxStarsAt(level, s.trade.maxStars)
    if (stars > cap) return fail('stars_cap', `A load that big is ${stars} stars: at job level ${level} you may carry ${cap}.`)
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) =>
      d.gold < cost.gold ? fail('not_enough_gold', `${crates} crate(s) cost ${cost.gold.toLocaleString('en-US')} gold.`) : addGold(d, -cost.gold),
    )
    if (!result.ok) return result as Fail
    this.g.afterInventory(p, draft)
    this.setCell(at.post.id, good.code, { demand: cell.demand, buyMul: cost.mul }, now)
    this.g.transports.load(t, good.code, crates, cost.gold, dest, at.post.id, now)
    this.log(p.characterId, 'buy', at.post.id, good.code, crates, cost.gold, t.stars, now)
    this.sendMarket(p, at.post.id, now)
    return true
  }

  sell(p: Player, npcId: number, code: string | undefined, crates: number | undefined, now: number): true | Fail {
    const at = this.at(p, npcId, now)
    if ('reason' in at) return at
    const own = this.g.transports.of(p.characterId) ? [] : this.g.robbery.entries(p.characterId, 'own')
    const why = this.trader(p, at.npc, now, own.length > 0)
    if (why) return why
    const t = this.g.transports.of(p.characterId)
    const entries = (t ? t.hold : own).filter((e) => code === undefined || e.good === code)
    if (entries.length === 0) return fail('not_found', code ? 'There is none of that in your hold.' : 'Your hold is empty.')
    const s = this.jobs.settings
    const post = at.post.id
    const acc = this.g.law.accountOf(p.characterId)
    const day = Math.floor(now / DAY_MS)
    let room = acc === null ? Infinity : Math.max(0, s.drift.accountDayMax - this.store.moved(acc, day))
    const sales: { good: string; crates: number; gold: number; cost: number; demand: number; buyMul: number }[] = []
    for (const e of entries) {
      const g = this.good(e.good)
      const n = Math.min(e.crates, crates ?? e.crates)
      if (!g || n <= 0) continue
      const cell = this.cell(post, g.code, now)
      const cost = n >= e.crates ? e.cost : Math.round((e.cost * n) / e.crates)
      if (g.origin === post) {
        sales.push({ good: g.code, crates: n, gold: tradeSellPrice(g.base, null, 1, s.trade.taxPct, cell.buyMul) * n, cost, demand: cell.demand, buyMul: cell.buyMul })
        continue
      }
      const from = this.post(g.origin)
      const to = this.post(post)
      if (!from || !to) continue
      const r = tradeSellTotal(g.base, tradeMargin(from, to, s.trade), cell.demand, n, { taxPct: s.trade.taxPct, drift: s.drift }, room, this.bonus(post, g.code, now))
      room -= r.moved
      sales.push({ good: g.code, crates: n, gold: r.gold, cost, demand: r.demand, buyMul: cell.buyMul })
    }
    if (sales.length === 0) return fail('not_found')
    const gold = sales.reduce((n, x) => n + x.gold, 0)
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => addGold(d, gold, { strict: true }))
    if (!result.ok) return result as Fail
    this.g.afterInventory(p, draft)
    const starsBefore = t?.stars ?? 1
    const fromBefore = t?.from ?? null
    let moved = 0
    for (const x of sales) {
      const before = this.cell(post, x.good, now)
      moved += Math.max(0, before.demand - x.demand)
      this.setCell(post, x.good, { demand: x.demand, buyMul: x.buyMul }, now)
      if (t) this.g.transports.unload(t, x.good, x.crates, now)
      else this.g.robbery.takeOwn(p.characterId, x.good, x.crates)
      this.log(p.characterId, 'sell', post, x.good, x.crates, x.gold, starsBefore, now)
    }
    if (acc !== null && moved > 0) this.store.addMoved(acc, day, moved)
    const cost = sales.reduce((n, x) => n + x.cost, 0)
    const profit = gold - cost
    // docs/JOBS.md §8: the Silk Caravan's job EXP multiplier
    const exp = Math.floor(traderSaleExp(profit, starsBefore, s.exp) * this.g.caravan.mul('exp', now))
    if (exp > 0) this.jobs.addExp(p.characterId, exp, now, `sale at ${post}`)
    const escorts = exp > 0 ? this.escorts(p, exp, now) : []
    const crateN = sales.reduce((n, x) => n + x.crates, 0)
    if (t) this.g.caravan.completedRun(p, fromBefore, post, profit, now)
    p.send({
      t: 'chat',
      channel: 'system',
      text: `${at.post.npc.name} pays ${gold.toLocaleString('en-US')} gold for ${crateN} crate(s) (${profit >= 0 ? 'profit' : 'loss'} ${Math.abs(profit).toLocaleString('en-US')}${exp > 0 ? `, +${exp} job EXP` : ''}${escorts.length ? `; escorted by ${escorts.join(', ')}` : ''}).`,
    })
    this.g.config.log(`market: ${p.name} sold ${crateN} crates at ${post} for ${gold} (profit ${profit}, ${starsBefore} stars)`)
    this.sendMarket(p, post, now)
    return true
  }

  /**
   * The escorting Bounty Hunters of a sale (§3.1, §7): in the Trader's party, in the suit, within ESCORT_M, another
   * account and another IP; at most MAX_ESCORTS. Each gets `exp.hunterEscortPct` of the Trader's job EXP (EXP only, no
   * gold). A same-IP escort gets nothing and leaves a `law_flags` row `escort_same_ip`.
   */
  escorts(p: Player, traderExp: number, now: number): string[] {
    const party = this.g.party.partyOf(p.characterId)
    if (!party) return []
    const acc = this.g.law.accountOf(p.characterId)
    const ip = this.g.law.ipOf(p)
    const here = this.g.world.positionAt(p, now)
    const out: string[] = []
    for (const m of party.members) {
      if (out.length >= MAX_ESCORTS) break
      if (m.characterId === p.characterId) continue
      const h = this.g.jobs.playerOf(m.characterId)
      if (!h || h.dead || this.jobs.jobOf(h.characterId) !== 'hunter' || !this.jobs.inMode(h.characterId)) continue
      const at = this.g.world.positionAt(h, now)
      if (Math.hypot(at[0] - here[0], at[2] - here[2]) > ESCORT_M) continue
      const hAcc = this.g.law.accountOf(h.characterId)
      if (acc !== null && hAcc === acc) continue
      if (ip !== null && this.g.law.ipOf(h) === ip) {
        try {
          this.g.law.store.flag({ at: now, wanted_character: p.characterId, wanted_account: acc ?? 0, hunter_character: h.characterId, hunter_account: hAcc, rule: 'escort_same_ip', withheld: 0 })
        } catch {
          // no law tables in a test
        }
        continue
      }
      this.jobs.addExp(h.characterId, Math.floor(hunterEscortExp(traderExp, this.jobs.settings.exp) * this.g.caravan.mul('escort', now)), now, `escorted ${p.name}`)
      out.push(h.name)
    }
    return out
  }

  log(characterId: number, kind: TradeLogKind, post: string | null, good: string | null, crates: number, gold: number, stars: number, now: number): void {
    try {
      this.store.log({ at: now, character_id: characterId, account_id: this.g.law.accountOf(characterId), kind, post, good, crates, gold, stars })
    } catch (e) {
      this.g.config.log(`market: trade_log failed: ${(e as Error).message}`)
    }
  }

  // ---- GM and admin (§9.5) ----------------------------------------------------------------------------------------------

  /** `market [status|price <post> <good> <demand>|buy <good> <mul>|reset|news <post> <good>]`. */
  gm(args: readonly string[], now: number): GmResult {
    const v = (args[0] ?? 'status').toLowerCase()
    const postOf = (s: string | undefined) => TRADE_POINT_IDS.find((x) => x === s?.toLowerCase())
    const goodOf = (s: string | undefined) => this.jobs.content.goods.find((x) => x.code === s?.toUpperCase() || x.name.toLowerCase() === s?.toLowerCase())
    if (v === 'status') {
      const n = this.news(now)
      const moved = [...this.load().keys()].length
      return { ok: true, message: `Market: ${moved} drifted price(s); news: ${n ? `${this.good(n.good)?.name} at ${this.post(n.post)?.name}` : 'none'}.` }
    }
    if (v === 'reset') {
      this.reset(now)
      return { ok: true, message: 'Every price is back to normal.' }
    }
    if (v === 'price' || v === 'buy') {
      const post = postOf(args[1])
      const good = goodOf(args[2])
      const x = Number(args[3])
      const d = this.jobs.settings.drift
      if (!post || !good || !Number.isFinite(x) || x < d.floor || x > d.cap + 1) return { ok: false, message: `Usage: ${TRADE_USAGE} (demand ${d.floor}-${d.cap + 1})` }
      const c = this.cell(post, good.code, now)
      this.setCell(post, good.code, v === 'price' ? { demand: x, buyMul: c.buyMul } : { demand: c.demand, buyMul: x }, now)
      return { ok: true, message: `${good.name} at ${this.post(post)?.name}: ${v === 'price' ? 'demand' : 'buy multiplier'} ${x}.` }
    }
    if (v === 'news') {
      const post = postOf(args[1])
      const good = goodOf(args[2])
      if (!post || !good) return { ok: false, message: `Usage: ${TRADE_USAGE}` }
      this.setNews(post, good.code, now)
      return { ok: true, message: `Today's news: ${good.name} sells well at ${this.post(post)?.name}.` }
    }
    return { ok: false, message: `Usage: ${TRADE_USAGE}` }
  }

  /** The admin view's market part. */
  adminMarket(now: number): { rows: { post: TradePointId; good: string; demand: number; buyMul: number }[]; news: { post: TradePointId; good: string } | null } {
    const rows: { post: TradePointId; good: string; demand: number; buyMul: number }[] = []
    for (const p of this.jobs.content.posts) {
      for (const x of this.jobs.content.goods) {
        const c = this.cell(p.id, x.code, now)
        rows.push({ post: p.id, good: x.code, demand: round3(c.demand), buyMul: round3(c.buyMul) })
      }
    }
    const n = this.news(now)
    return { rows, news: n ? { post: n.post, good: n.good } : null }
  }
}

export const TRADE_USAGE = 'market [status|price <post> <good> <demand>|buy <post> <good> <mul>|reset|news <post> <good>]'

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
