/**
 * The job system on the client, the DOM-free part (docs/JOBS.md §10, layer 5): the job page's lines (level, EXP,
 * limits, the next unlock), the licence windows' terms and status, the trade window's numbers (route estimates, the
 * most crates a purchase may take under gold, room and the stars cap, the stars a purchase would make), the sack's
 * summary, the bag prompt and the refusal text. The windows (hud/jobs-hud.ts) and the feature (world/features/jobs.ts)
 * only draw what these return; tests cover them (apps/game/test/jobs-hud.test.ts).
 *
 * The numbers are the shared defaults (JOB_SETTINGS_DEFAULTS, SIEGE_EVENT_DEFAULTS), as law.ts does for the siege: an
 * admin's live change reaches the client through the server's own refusals and prices, never through these estimates.
 */
import {
  JOB_SETTINGS_DEFAULTS,
  JOBS_CONTENT,
  SIEGE_EVENT_DEFAULTS,
  jobLevelExp,
  jobLevelName,
  jobNextExp,
  jobSide,
  maxStarsAt,
  suitTier,
  tradeBuyTotal,
  tradeMargin,
  tradeSellPrice,
  tradeStars,
  type ActionFailReason,
  type HunterView,
  type JobId,
  type JobSettings,
  type JobSide,
  type JobView,
  type MarketRow,
  type SackEntryView,
  type SackKind,
  type TradeBag,
  type TradePointId,
  type TradePost,
  type TransportDef,
  type TransportView,
} from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'
import { actionFailText } from './index.ts'
import { formatNumber } from './items.ts'

export const JOB_SETTINGS: Readonly<JobSettings> = JOB_SETTINGS_DEFAULTS
const HUNTER = SIEGE_EVENT_DEFAULTS.hunter

/** The job requests the job feature reports refusals of itself (the server's message first: it names the rule). */
export const JOB_UI_REQUESTS = ['jobJoin', 'jobLeave', 'jobMode', 'tradeMarket', 'tradeSummon', 'tradeBuy', 'tradeSell', 'transportRide', 'transportDismiss', 'transportFollow', 'bagPick', 'denSell', 'denBuy', 'yunTurnIn'] as const

/** A refused job request's line: the server's own text when it sent one, else the job reasons, else the generic one. */
export function jobFailText(reason: ActionFailReason | undefined, message?: string): string {
  if (message && message.trim()) return message
  return actionFailText(reason)
}

export const STAR = '★'
export const NO_STAR = '☆'

// ---- the world map's "Trade routes" layer ---------------------------------------------------------------------------

/** A crate's profit on a route at normal demand, after the tax (% of its base price): (1 + margin) × (1 − tax) − 1. */
export function routeProfitPct(a: Pick<TradePost, 'x' | 'z' | 'danger'>, b: Pick<TradePost, 'x' | 'z' | 'danger'>, s: Readonly<JobSettings> = JOB_SETTINGS): number {
  return Math.round(((1 + tradeMargin(a, b, s.trade)) * (1 - s.trade.taxPct / 100) - 1) * 100)
}

/** A road's colour by its danger 0-5 (green: safe, red: deadly). */
export const ROUTE_DANGER_COLORS: readonly string[] = ['#9be37a', '#c8e06a', '#f0d050', '#f5a442', '#f57a3a', '#ff4a36']

export interface RouteShape {
  x: number
  z: number
  color: string
  to?: { x: number; z: number }
  width?: number
  label?: string
  text?: true
}

/**
 * The "Trade routes" layer (docs/JOBS.md §5.1, §10): a road from Jangan to each trade post coloured by its danger with
 * the profit at its middle ("+31 %"), the posts with their names, and the Bandit Den.
 */
export function tradeRouteShapes(content: Pick<typeof JOBS_CONTENT, 'posts' | 'den'> = JOBS_CONTENT, s: Readonly<JobSettings> = JOB_SETTINGS): RouteShape[] {
  const hub = content.posts.find(p => p.id === 'jangan')
  const out: RouteShape[] = []
  if (hub) {
    for (const p of content.posts) {
      if (p === hub) continue
      const color = ROUTE_DANGER_COLORS[Math.max(0, Math.min(5, Math.round(p.danger)))]!
      out.push({ x: hub.x, z: hub.z, to: { x: p.x, z: p.z }, color, width: 2.5 })
      out.push({ x: (hub.x + p.x) / 2, z: (hub.z + p.z) / 2, color, text: true, label: t('jobs.map.profit', { pct: routeProfitPct(hub, p, s) }) })
    }
  }
  for (const p of content.posts) out.push({ x: p.x, z: p.z, color: '#ffcc4a', width: 4, label: t('jobs.map.post', { name: p.name }) })
  out.push({ x: content.den.x, z: content.den.z, color: '#ff4a36', width: 4, label: t('jobs.map.den') })
  return out
}

/** "★★★" (the filled stars only: the game fonts draw ☆ much like ★); `full`: "★★★☆☆", out of 5. */
export function starsText(n: number, full = false): string {
  const k = Math.max(0, Math.min(5, Math.floor(n)))
  return full ? STAR.repeat(k) + NO_STAR.repeat(5 - k) : STAR.repeat(k)
}

export function jobName(job: JobId): string {
  return t(`job.name.${job}` as StringKey)
}

export function sideName(side: JobSide): string {
  return t(`job.side.${side}` as StringKey)
}

/** The post (trade point) of a trader's NPC code; null for any other NPC. */
export function postOfNpc(code: string, posts: readonly TradePost[] = JOBS_CONTENT.posts): TradePost | null {
  return posts.find((p) => p.npc.code === code) ?? null
}

export function postById(id: TradePointId | null | undefined, posts: readonly TradePost[] = JOBS_CONTENT.posts): TradePost | null {
  return id ? (posts.find((p) => p.id === id) ?? null) : null
}

export function goodName(code: string): string {
  return JOBS_CONTENT.goods.find((g) => g.code === code)?.name ?? code
}

export function goodBase(code: string): number {
  return JOBS_CONTENT.goods.find((g) => g.code === code)?.base ?? 0
}

// ---- the job page --------------------------------------------------------------------------------------------------

/** The job EXP bar: from the level's start to the next level's (full at 7). */
export function jobExpBar(v: Pick<JobView, 'level' | 'exp'>, levels: readonly number[] = JOB_SETTINGS.jobs.levels): { frac: number; text: string } {
  const start = jobLevelExp(v.level, levels)
  const next = jobNextExp(v.level, levels)
  if (next === null) return { frac: 1, text: t('job.expMax', { exp: formatNumber(v.exp) }) }
  const span = Math.max(1, next - start)
  const cur = Math.max(0, v.exp - start)
  return { frac: Math.min(1, cur / span), text: t('job.exp', { cur: formatNumber(v.exp), need: formatNumber(next) }) }
}

/** The best transport a job level may summon (null below the Donkey's level). */
export function bestTransport(level: number, transports: readonly TransportDef[] = JOBS_CONTENT.transports): TransportDef | null {
  let best: TransportDef | null = null
  for (const d of transports) if (level >= d.jobLevel && (!best || d.tier > best.tier)) best = d
  return best
}

/** The job page's "limits" lines for a job at a level. */
export function jobLimits(job: JobId, level: number, s: Readonly<JobSettings> = JOB_SETTINGS): string[] {
  if (job === 'trader') {
    const cap = maxStarsAt(level, s.trade.maxStars)
    const tr = bestTransport(level)
    return [
      t('jobs.page.cap.stars', { stars: starsText(cap), n: cap }),
      ...(tr ? [t('jobs.page.cap.transport', { name: tr.name })] : []),
      t('jobs.page.cap.buy', { n: s.trade.buyCapPerHour }),
      t('jobs.page.cap.tax', { pct: s.trade.taxPct }),
    ]
  }
  if (job === 'hunter') return [t('jobs.page.cap.sense', { m: HUNTER.senseM }), t('jobs.page.cap.bounty', { n: formatNumber(HUNTER.dailyBountyCap) })]
  return [t('jobs.page.cap.den', { pct: s.thief.denPct }), t('jobs.page.cap.ping', { s: s.thief.pingSec, r: level >= 5 ? Math.round((s.thief.pingR * 2) / 3) : s.thief.pingR })]
}

/** "Next: level 4 Caravaneer at 15,000 job EXP" (or the top line). */
export function nextUnlockLine(job: JobId, level: number, levels: readonly number[] = JOB_SETTINGS.jobs.levels): string {
  const next = jobNextExp(level, levels)
  if (next === null) return t('jobs.page.top', { name: jobLevelName(job, level) })
  return t('jobs.page.next', { level: level + 1, name: jobLevelName(job, level + 1), exp: formatNumber(next) })
}

/** The job page's head lines. */
export function jobHead(v: JobView | null): { title: string; level: string; tier: string } {
  if (!v?.job) return { title: t('job.none'), level: '', tier: '' }
  const roman = ['I', 'II', 'III'][suitTier(v.level) - 1]!
  return { title: jobName(v.job), level: t('job.level', { level: v.level, name: jobLevelName(v.job, v.level) }), tier: t('job.suit.tier', { tier: roman }) }
}

// ---- licences ------------------------------------------------------------------------------------------------------

export interface LicenceTerms {
  gold: number
  level: number
  /** The Hunter's clean-record days (0: none). */
  cleanDays: number
  leaveDays: number
  sideDays: number
}

export function licenceTerms(job: JobId, s: Readonly<JobSettings> = JOB_SETTINGS): LicenceTerms {
  const hunter = job === 'hunter'
  return {
    gold: hunter ? HUNTER.licenceGold : s.jobs.licenceGold,
    level: hunter ? HUNTER.minLevel : s.jobs.minLevel,
    cleanDays: hunter ? HUNTER.cleanDays : 0,
    leaveDays: s.jobs.leaveWaitDays,
    sideDays: s.jobs.sideChangeDays,
  }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * A licence window's state for `job` at its NPC: the status line, a warning (other side, level, the account's wait),
 * which buttons show. `charLevel` is the character's level.
 */
export function licenceState(
  job: JobId,
  v: JobView | null,
  charLevel: number,
  now: number,
  hunter: HunterView | null = null,
): { status: string; warn: string; canJoin: boolean; canLeave: boolean; canSuit: boolean; suitOn: boolean } {
  const terms = licenceTerms(job)
  const mine = v?.job ?? null
  const base = { canJoin: false, canLeave: false, canSuit: false, suitOn: !!v?.mode }
  if (mine === job && v) {
    let status = t('jobs.lic.status.member', { job: jobName(job), level: v.level, name: jobLevelName(job, v.level), mode: t(v.mode ? 'jobs.lic.mode.on' : 'jobs.lic.mode.off') })
    if (job === 'hunter' && hunter) status += ` · ${t('jobs.lic.status.captures', { captures: hunter.captures })}`
    if (job === 'hunter' && hunter && !hunter.licensed && hunter.revokedUntil) return { ...base, status: t('jobs.lic.status.revoked', { date: day(hunter.revokedUntil) }), warn: '' }
    return { ...base, status, warn: '', canLeave: !v.mode, canSuit: true }
  }
  if (mine) return { ...base, status: t('jobs.lic.status.other', { job: jobName(mine) }), warn: '' }
  let warn = ''
  if (v?.side && v.side !== jobSide(job)) warn = t('jobs.lic.warn.side', { side: sideName(v.side) })
  else if (charLevel < terms.level) warn = t('jobs.lic.warn.level', { level: terms.level })
  else if (v?.joinAfter && v.joinAfter > now) warn = t('jobs.lic.warn.wait', { date: day(v.joinAfter) })
  return { ...base, status: t('jobs.lic.status.none'), warn, canJoin: true }
}

// ---- the trade window ---------------------------------------------------------------------------------------------

/** "▲" / "▼" / "" for a drifted multiplier (1 = normal). */
export function driftArrow(v: number): string {
  return v > 1.005 ? '▲' : v < 0.995 ? '▼' : ''
}

/** "+12 %" / "−3 %" of a value against a cost. */
export function pctText(gain: number, cost: number): string {
  if (!(cost > 0)) return ''
  const p = Math.round((gain / cost) * 100)
  return `${p >= 0 ? '+' : '−'}${Math.abs(p)} %`
}

export interface RouteEstimate {
  post: TradePost
  km: number
  danger: number
  margin: number
  /** Gold per crate there, at normal demand, after tax. */
  sell: number
  /** Gain per crate against the buy price paid. */
  profit: number
  /** Selling back where it is bought (0.9 × the buy price). */
  home: boolean
}

/**
 * What a crate of `good` (bought at its origin for `paid` a crate) fetches at every trade point, best first: the
 * margin by distance and danger, demand 1, the tax; at the origin itself 0.9 × the price paid.
 */
export function routeEstimates(good: string, paid: number, s: Readonly<JobSettings> = JOB_SETTINGS, posts: readonly TradePost[] = JOBS_CONTENT.posts): RouteEstimate[] {
  const g = JOBS_CONTENT.goods.find((x) => x.code === good)
  const from = postById(g?.origin, posts)
  if (!g || !from) return []
  const out: RouteEstimate[] = []
  for (const p of posts) {
    const home = p.id === from.id
    const margin = home ? 0 : tradeMargin(from, p, s.trade)
    const sell = home ? Math.floor(paid * 0.9) : tradeSellPrice(g.base, margin, 1, s.trade.taxPct)
    out.push({ post: p, km: Math.hypot(p.x - from.x, p.z - from.z) / 1000, danger: Math.max(p.danger, from.danger), margin, sell, profit: sell - paid, home })
  }
  return out.sort((a, b) => b.profit - a.profit)
}

/** One line of the routes list. */
export function routeLine(r: RouteEstimate, paid: number): string {
  if (r.home) return t('jobs.trade.routeHere', { post: r.post.name, sell: formatNumber(r.sell), profit: pctText(r.profit, paid) })
  return t('jobs.trade.route', { post: r.post.name, km: r.km.toFixed(2), danger: r.danger, margin: (r.margin * 100).toFixed(1), sell: formatNumber(r.sell), profit: pctText(r.profit, paid) })
}

/**
 * The most crates of a good a Trader may buy now: room in the hold, gold (crate by crate, the price rising with each),
 * and the stars cap of his job level on the load's value.
 */
export function maxBuyable(o: { base: number; mul: number; room: number; gold: number; holdValue: number; level: number }, s: Readonly<JobSettings> = JOB_SETTINGS): number {
  const cap = maxStarsAt(o.level, s.trade.maxStars)
  let n = 0
  while (n < o.room) {
    const cost = tradeBuyTotal(o.base, o.mul, n + 1, s.drift).gold
    if (cost > o.gold || tradeStars(o.holdValue + cost, s.trade.starThresholds) > cap) break
    n++
  }
  return n
}

/** A purchase's gold and the load's stars after it. */
export function buyPreview(base: number, mul: number, crates: number, holdValue: number, s: Readonly<JobSettings> = JOB_SETTINGS): { gold: number; stars: number } {
  const gold = tradeBuyTotal(base, mul, crates, s.drift).gold
  return { gold, stars: tradeStars(holdValue + gold, s.trade.starThresholds) }
}

/** The hold's crates of a good. */
export function heldOf(tr: TransportView | null, good: string): number {
  return tr?.hold.find((e) => e.good === good)?.crates ?? 0
}

/** What a market row shows. */
export function marketCells(row: MarketRow, held: number): { buy: string; sell: string; hold: string; demand: string; tip: string } {
  const arrow = driftArrow(row.demand)
  const demand = row.news ? t('jobs.trade.news', { mul: JOB_SETTINGS.trade.newsDemand.toFixed(2) }) : t('jobs.trade.demand', { pct: Math.round(row.demand * 100), arrow })
  const buyMul = row.buyMul !== undefined ? t('jobs.trade.buyMul', { pct: Math.round(row.buyMul * 100), arrow: driftArrow(row.buyMul) }) : ''
  return {
    buy: row.buy !== undefined ? formatNumber(row.buy) : t('jobs.trade.notSold'),
    sell: `${formatNumber(row.sell)}${arrow ? ` ${arrow}` : ''}${row.news ? ` ${STAR}` : ''}`,
    hold: held > 0 ? String(held) : '',
    demand,
    tip: [t('jobs.trade.rowTip', { name: row.name, base: formatNumber(goodBase(row.good)), origin: postById(row.origin)?.name ?? row.origin }), demand, buyMul].filter(Boolean).join('\n'),
  }
}

/** The transport's load line in the trade window and its frame. */
export function loadLine(tr: TransportView): string {
  const value = tr.hold.reduce((n, e) => n + e.cost, 0)
  const crates = tr.hold.reduce((n, e) => n + e.crates, 0)
  return t('jobs.trade.load', { name: tr.name, crates, cap: tr.capacity, value: formatNumber(value), stars: starsText(Math.max(1, tr.stars || (crates ? 1 : 0))) })
}

// ---- the transport frame --------------------------------------------------------------------------------------------

/** Following, waiting (farther than waitM), or ridden. */
export function transportFollow(tr: Pick<TransportView, 'ridden' | 'staying'>, dist: number | null, s: Readonly<JobSettings> = JOB_SETTINGS): string {
  if (tr.ridden) return t('jobs.tr.ridden')
  if (tr.staying) return t('jobs.tr.staying')
  return dist !== null && dist > s.transport.waitM ? t('jobs.tr.wait') : t('jobs.tr.follow')
}

// ---- the sack -----------------------------------------------------------------------------------------------------

export function sackTotals(entries: readonly SackEntryView[]): Record<SackKind, { crates: number; value: number }> {
  const out: Record<SackKind, { crates: number; value: number }> = { stolen: { crates: 0, value: 0 }, recovered: { crates: 0, value: 0 }, own: { crates: 0, value: 0 } }
  for (const e of entries) {
    out[e.kind].crates += e.crates
    out[e.kind].value += e.value
  }
  return out
}

/** The sack's lines on the job panel (one per kind carried). */
export function sackLines(entries: readonly SackEntryView[]): { kind: SackKind; text: string }[] {
  const tot = sackTotals(entries)
  const out: { kind: SackKind; text: string }[] = []
  if (tot.stolen.crates) out.push({ kind: 'stolen', text: t('jobs.sack.stolen', { crates: tot.stolen.crates, gold: formatNumber(tot.stolen.value) }) })
  if (tot.recovered.crates) out.push({ kind: 'recovered', text: t('jobs.sack.recovered', { crates: tot.recovered.crates, gold: formatNumber(tot.recovered.value) }) })
  if (tot.own.crates) out.push({ kind: 'own', text: t('jobs.sack.own', { crates: tot.own.crates }) })
  return out
}

// ---- bags -------------------------------------------------------------------------------------------------------------

/** The bags within `reach` m of (x, z), nearest first. */
export function bagsNear(bags: Iterable<TradeBag>, x: number, z: number, reach: number): (TradeBag & { d: number })[] {
  const out: (TradeBag & { d: number })[] = []
  for (const b of bags) {
    const d = Math.hypot(b.x - x, b.z - z)
    if (d <= reach) out.push({ ...b, d })
  }
  return out.sort((a, b) => a.d - b.d)
}

/** "12 crate(s) of White Silk (Aki) · 4:12". */
export function bagLine(b: TradeBag, now: number): string {
  const s = Math.max(0, Math.ceil((b.expiresAt - now) / 1000))
  return t('jobs.bag.prompt', { crates: b.crates, name: goodName(b.good), owner: b.owner, left: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` })
}

// ---- who may be attacked (the client's guess; the server decides) ------------------------------------------------------

/** Whether a click on a player should attack: job PvP (both suited, opposite sides) or an on-duty Hunter on a robber. */
export function jobFightable(me: { job?: { job: JobId } | null; hunterOnDuty?: boolean }, other: { job?: { job: JobId } | null; robber?: boolean }): boolean {
  if (me.hunterOnDuty && other.robber) return true
  if (!me.job || !other.job) return false
  return jobSide(me.job.job) !== jobSide(other.job.job)
}
