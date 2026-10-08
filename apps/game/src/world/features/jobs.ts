/**
 * The job system on the client, layer 5 (docs/JOBS.md §10): the player-facing loop of Traders, Bounty Hunters and
 * Thieves. The looks (suits, the job line on the plate, the transports' goods) are job-looks.ts'; this feature wires
 * the windows and controls of hud/jobs-hud.ts to the server's messages and requests.
 *
 * - **Licences** at their NPCs: Jodaesan (`trader`), Captain Yun (`hunter`: today's Bounty Hunter licence and duty, now
 *   the job's window, with recovered goods to turn in), Old Fang (`thief`): join, leave (asks first), the suit.
 * - **The Job tab** of the Main window and the **job panel** in the left column (under law.ts' panels): job, level,
 *   EXP, the suit toggle (`jobMode`), the sack (stolen / recovered / own crates) and the ROBBER warning.
 * - **The trade window** (`market` service: Jodaesan and the four post traders): `tradeMarket` on open, `market` rows,
 *   buy (a count box capped by room, gold and the stars cap), sell one good or all, summon a transport by tier, dismiss.
 * - **The transport frame** on the player frame's pet area: HP (live from the entity), load, stars, destination,
 *   following / waiting / staying, Ride / Step down (`transportRide`), Follow / Stay here (`transportFollow`), Dismiss. A click on the own transport rides it; a Thief in
 *   the suit clicking someone's loaded transport attacks it.
 * - **Bags** (`bag` / `bagGone`): a prompt over the hotbar for the nearest one within 25 m (walks there, then
 *   `bagPick`); brown dots on the minimap.
 * - **The Bandit Den** (`den`: Seopok): the stolen goods, `denSell`, the return scroll (`denBuy`).
 * - **PvP clicks**: a player of the other side in the suit (both suited), or a robber for an on-duty Bounty Hunter.
 * - **Labels**: ROBBER (EntityState.robber / entityUpdate.robber) for job-mode viewers.
 * - **Maps**: the four trade posts (and the Bandit Den for Thieves) on the minimap; the world map's "Trade routes" layer
 *   (a toggle on the map: the roads from Jangan coloured by danger with the profit per crate, the posts, the den); the own
 *   transport; caravan pings (Thieves, orange circles for a minute); robber pings and robbers in sense (Bounty Hunters).
 * - **Notices**: job level ups, the robbery warrant opening and closing, the transport's fall; refusals as toasts with
 *   the server's own text.
 * - Debug: `window.__sroJobUi` (state, open windows, talk to an NPC by code, buy / sell, GM).
 */
import {
  JOB_CODES,
  JOBS_CONTENT,
  SIEGE_EVENT_DEFAULTS,
  isTransportCos,
  jobLevelName,
  type HunterView,
  type JobId,
  type JobView,
  type MarketRow,
  type SackEntryView,
  type ServerMessage,
  type TradeBag,
  type TradePointId,
  type TransportView,
} from '@sro/shared'
import { BagPrompt, DenWindow, JobPage, JobPanel, LicenceWindow, TradeWindow, TransportFrame } from '../../hud/jobs-hud.ts'
import { JOB_UI_REQUESTS, bagsNear, buyPreview, goodBase, heldOf, jobFailText, jobFightable, maxBuyable, postOfNpc, sackTotals, starsText, tradeRouteShapes } from '../../hud/jobs-logic.ts'
import { registerNpcService, type NpcTalkContext } from '../../hud/npc-dialog.ts'
import { inWorld } from '../../hud/unique-notice.ts'
import { t } from '../../i18n/index.ts'
import { MessageBox } from '../../ui/kit/dialog.ts'
import { addWorldMapOverlay, type MapOverlayShape } from '../map/worldmap.ts'
import type { HudMarker, HudMinimap } from '../jangan/minimap.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

const HUD_EVERY_S = 0.25
/** Bags this close get the prompt (m). */
const BAG_PROMPT_M = 25
/** bagPick reach on the server is 4 m: ask from a little closer. */
const BAG_REACH_M = 3.5
const PING_MS = 60_000
const HURT_TOAST_MS = 10_000
const POST_COLOR = '#ffcc4a'
const DEN_COLOR = '#ff4a36'
const CARAVAN_COLOR = 'rgba(255, 150, 40, 0.9)'
const ROBBER_COLOR = '#ff7a2a'
const BAG_COLOR = '#c08a3a'
const OWN_TR_COLOR = '#fff3a8'
const SENSE_M = SIEGE_EVENT_DEFAULTS.hunter.senseM

type LicenceJob = JobId

export function jobsFeature(ctx: WorldFeatureContext): WorldFeature {
  if (!ctx.session) return {}
  const { app } = ctx
  let job: JobView | null = null
  let jobAt = 0
  let sack: SackEntryView[] = []
  let transport: TransportView | null = null
  let hunter: HunterView | null = null
  let robber = false
  const markets = new Map<TradePointId, MarketRow[]>()
  const bags = new Map<number, TradeBag>()
  const caravans = new Map<number, { x: number; z: number; r: number; stars: number; at: number }>()
  const robberPings = new Map<number, { x: number; z: number; r: number; name: string; at: number }>()
  let talk: NpcTalkContext | null = null
  const licences = new Map<LicenceJob, LicenceWindow>()
  let trade: TradeWindow | null = null
  let den: DenWindow | null = null
  let pendingPick: { id: number; until: number } | null = null
  let lastHurt = 0
  let lastTrHp = -1
  let hudT = 0
  let minimap: HudMinimap | null = null
  let offMarkers: (() => void) | null = null
  const offs: (() => void)[] = []

  const self = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const charLevel = () => ctx.hud.stats?.level ?? self()?.state.level ?? 1
  const gold = () => ctx.hud.inventory.gold
  const now = () => ctx.serverNow()
  const toast = (text: string, kind: 'info' | 'error' = 'info') => ctx.hud.toast(text, kind)
  const notice = (text: string, ms = 6000) => app.notices.show(text, { kind: 'unique', title: t('jobs.notice.title'), live: inWorld, ms })
  const lockLeft = () => Math.max(0, (job?.lockUntil ?? 0) - now())
  const trView = () => (transport ? ctx.view(transport.id) : undefined)
  const scrollPrice = () => ctx.hud.items.def(JOB_CODES.denScroll)?.price ?? 0
  const mode = () => !!job?.mode

  // ---- the pieces --------------------------------------------------------------------------------------------------
  const page = new JobPage(app.art, ctx.hud.layer)
  const panel = new JobPanel(app.art)
  const frame = new TransportFrame(app.art)
  const bagPrompt = new BagPrompt(app.art, BAG_REACH_M)
  const lawCol = ctx.hud.layer.querySelector<HTMLElement>('.law-col')
  if (lawCol) lawCol.append(panel.root)
  else {
    Object.assign(panel.root.style, { position: 'absolute', left: '8px', top: '118px' })
    ctx.hud.layer.append(panel.root)
  }
  ctx.hud.layer.append(bagPrompt.root)

  const suit = (on: boolean) => ctx.send({ t: 'jobMode', on })
  page.onSuit = suit
  panel.onSuit = suit
  panel.onOpenPage = () => page.open()
  frame.onRide = (on) => ctx.send({ t: 'transportRide', on })
  frame.onFollow = (on) => ctx.send({ t: 'transportFollow', on })
  const dismiss = () => {
    if (!transport) return
    void MessageBox.confirm({ title: t('jobs.tr.dismiss'), text: t('jobs.tr.dismissConfirm', { name: transport.name }), art: app.art }).then((ok) => {
      if (ok) ctx.send({ t: 'transportDismiss' })
    })
  }
  frame.onDismiss = dismiss
  bagPrompt.onPick = (b) => pick(b.id)

  const placeFrame = () => {
    const host = ctx.hud.playerFrame?.petHost ?? null
    const want = transport ? host : null
    if (want && frame.root.parentElement !== want) want.append(frame.root)
    else if (!want && frame.root.parentElement) frame.root.remove()
  }

  // ---- bags --------------------------------------------------------------------------------------------------------
  const pick = (id: number) => {
    const b = bags.get(id)
    const me = self()
    if (!b || !me) return
    if (Math.hypot(b.x - me.pos.x, b.z - me.pos.z) <= BAG_REACH_M) {
      pendingPick = null
      ctx.send({ t: 'bagPick', id })
      return
    }
    pendingPick = { id, until: performance.now() + 20_000 }
    ctx.send({ t: 'moveTo', x: b.x, z: b.z })
  }

  // ---- windows -------------------------------------------------------------------------------------------------------
  const backToDialog = (w: { close(): void }) => {
    w.close()
    talk?.dialog.showServices()
  }
  const licence = (j: LicenceJob): LicenceWindow => {
    let w = licences.get(j)
    if (w) return w
    w = new LicenceWindow(app.art, ctx.hud.layer, j)
    const win = w
    w.onJoin = () => {
      if (talk) ctx.send({ t: 'jobJoin', npc: talk.npc, job: j })
    }
    w.onSuit = suit
    w.onLeave = () => {
      if (!talk || !job?.job) return
      const npc = talk.npc
      void MessageBox.confirm({
        title: t('jobs.lic.leaveTitle'),
        text: t('jobs.lic.leaveConfirm', { job: t(`job.name.${job.job}` as 'job.name.trader'), name: jobLevelName(job.job, job.level), days: 3 }),
        art: app.art,
      }).then((ok) => {
        if (ok) ctx.send({ t: 'jobLeave', npc })
      })
    }
    w.onTurnIn = () => {
      if (talk) ctx.send({ t: 'yunTurnIn', npc: talk.npc })
    }
    w.onBack = () => backToDialog(win)
    licences.set(j, w)
    return w
  }
  const showLicence = (j: LicenceJob) => licence(j).show(job, charLevel(), gold(), now(), hunter, sack)

  const tradeCtx = (post: (typeof JOBS_CONTENT.posts)[number]) => ({
    post,
    rows: markets.get(post.id) ?? [],
    transport,
    job,
    gold: gold(),
    ownCrates: sackTotals(sack).own.crates,
  })
  const tradeWindow = (): TradeWindow => {
    if (trade) return trade
    const w = new TradeWindow(app.art, ctx.hud.layer, (code) => ctx.hud.items.icon(code))
    w.onBack = () => backToDialog(w)
    w.onRefresh = () => {
      if (talk) ctx.send({ t: 'tradeMarket', npc: talk.npc })
    }
    w.onSummon = (tier) => {
      if (talk) ctx.send({ t: 'tradeSummon', npc: talk.npc, tier })
    }
    w.onDismiss = dismiss
    w.onBuy = (good, dest, row) => buyAsk(good, dest, row)
    w.onSell = (good, row) => sellAsk(good, row)
    trade = w
    return w
  }
  const buyAsk = (good: string, dest: TradePointId, row: MarketRow) => {
    if (!talk) return
    const npc = talk.npc
    const tr = transport
    const holdValue = tr ? tr.hold.reduce((n, e) => n + e.cost, 0) : 0
    const room = tr ? tr.capacity - tr.hold.reduce((n, e) => n + e.crates, 0) : 0
    const max = maxBuyable({ base: goodBase(good), mul: row.buyMul ?? 1, room, gold: gold(), holdValue, level: job?.level ?? 1 })
    // nothing fits: let the server say which rule (room, gold, stars)
    if (max <= 0) return void ctx.send({ t: 'tradeBuy', npc, good, crates: 1, dest })
    const destName = JOBS_CONTENT.posts.find((p) => p.id === dest)?.name ?? dest
    const pv = buyPreview(goodBase(good), row.buyMul ?? 1, max, holdValue)
    void MessageBox.count({
      title: t('jobs.trade.buyTitle', { name: row.name }),
      text: `${t('jobs.trade.buyBody', { name: row.name, dest: destName, max })}\n${t('jobs.trade.preview', { n: max, gold: pv.gold.toLocaleString('en-US'), stars: starsText(pv.stars) })}`,
      max,
      initial: max,
      art: app.art,
    }).then((n) => {
      if (n && n > 0) ctx.send({ t: 'tradeBuy', npc, good, crates: n, dest })
    })
  }
  const sellAsk = (good: string | null, row: MarketRow | null) => {
    if (!talk) return
    const npc = talk.npc
    if (!good || !row) return void ctx.send({ t: 'tradeSell', npc })
    const max = heldOf(transport, good)
    if (max <= 1) return void ctx.send({ t: 'tradeSell', npc, good, crates: max || 1 })
    void MessageBox.count({ title: t('jobs.trade.sellTitle', { name: row.name }), text: t('jobs.trade.sellBody', { name: row.name, max }), max, initial: max, art: app.art }).then((n) => {
      if (n && n > 0) ctx.send({ t: 'tradeSell', npc, good, crates: n })
    })
  }
  const openTrade = (c: NpcTalkContext) => {
    const post = postOfNpc(c.code)
    if (!post) return
    ctx.send({ t: 'tradeMarket', npc: c.npc })
    tradeWindow().show(tradeCtx(post))
  }
  const refreshTrade = () => {
    if (trade?.isOpen && trade.post) trade.update(tradeCtx(trade.post))
  }

  const denWindow = (): DenWindow => {
    if (den) return den
    const w = new DenWindow(app.art, ctx.hud.layer)
    w.onBack = () => backToDialog(w)
    w.onSell = () => {
      if (talk) ctx.send({ t: 'denSell', npc: talk.npc })
    }
    w.onScroll = () => {
      if (!talk) return
      const npc = talk.npc
      const price = Math.max(1, scrollPrice())
      const max = Math.max(1, Math.min(10, Math.floor(gold() / price)))
      void MessageBox.count({ title: t('jobs.den.scrollTitle'), text: t('jobs.den.scrollBody', { gold: price.toLocaleString('en-US') }), max, initial: 1, art: app.art }).then((n) => {
        if (n && n > 0) ctx.send({ t: 'denBuy', npc, count: n })
      })
    }
    den = w
    return w
  }

  offs.push(
    registerNpcService('trader', (c) => ((talk = c), showLicence('trader')), 'npc.option.trader'),
    registerNpcService('thief', (c) => ((talk = c), showLicence('thief')), 'npc.option.thief'),
    // Captain Yun: the Bounty Hunter job's window (it replaces the siege's Yun window: same licence, same duty)
    registerNpcService('hunter', (c) => ((talk = c), showLicence('hunter')), 'npc.option.hunter'),
    registerNpcService('market', (c) => ((talk = c), openTrade(c)), 'npc.option.market'),
    registerNpcService('den', (c) => ((talk = c), denWindow().show(job, sack, scrollPrice())), 'npc.option.den'),
  )

  const refreshWindows = () => {
    for (const w of licences.values()) if (w.isOpen) w.update(job, charLevel(), gold(), now(), hunter, sack)
    refreshTrade()
    if (den?.isOpen) den.update(job, sack, scrollPrice())
  }

  // ---- labels: ROBBER ------------------------------------------------------------------------------------------------
  offs.push(
    ctx.addAttachment((v) => {
      if (v.kind !== 'player') return null
      let shown = ''
      const apply = () => {
        const see = mode() || !!hunter?.onDuty || v.isSelf
        const on = see && v.state.robber === true
        const key = String(on)
        if (key === shown) return
        shown = key
        v.setLabelLine('robber', on ? t('jobs.robber.label') : null)
      }
      return { loaded: apply, update: apply, dispose() {} }
    }),
  )

  // ---- maps --------------------------------------------------------------------------------------------------------
  const isThief = () => job?.job === 'thief'
  const prune = () => {
    const at = performance.now()
    for (const [id, p] of caravans) if (at - p.at > PING_MS) caravans.delete(id)
    for (const [id, p] of robberPings) if (at - p.at > PING_MS) robberPings.delete(id)
    const n = now()
    for (const [id, b] of bags) if (b.expiresAt < n) bags.delete(id)
  }
  function* markers(): Iterable<HudMarker> {
    for (const p of JOBS_CONTENT.posts) yield { x: p.x, z: p.z, color: POST_COLOR, size: 4 }
    if (isThief()) yield { x: JOBS_CONTENT.den.x, z: JOBS_CONTENT.den.z, color: DEN_COLOR, size: 4 }
    for (const b of bags.values()) yield { x: b.x, z: b.z, color: BAG_COLOR, size: 3 }
    const tv = trView()
    if (tv) yield { x: tv.pos.x, z: tv.pos.z, color: OWN_TR_COLOR, size: 3.5 }
    if (isThief() && mode()) for (const c of caravans.values()) yield { x: c.x, z: c.z, color: CARAVAN_COLOR, radius: c.r }
    if (hunter?.onDuty) {
      for (const p of robberPings.values()) yield { x: p.x, z: p.z, color: 'rgba(255, 122, 42, 0.85)', radius: p.r }
      const me = self()
      if (me) {
        for (const v of ctx.views()) {
          if (v.kind !== 'player' || v === me || v.state.robber !== true) continue
          if (Math.hypot(v.pos.x - me.pos.x, v.pos.z - me.pos.z) <= SENSE_M) yield { x: v.pos.x, z: v.pos.z, color: ROBBER_COLOR, size: 4 }
        }
      }
    }
  }
  offs.push(() => offMarkers?.())
  offs.push(
    // the "Trade routes" layer (toggled on the map): the roads from Jangan with their profit and danger, the posts, the den
    addWorldMapOverlay(() => tradeRouteShapes(), { id: 'trade-routes', label: () => t('jobs.map.layer') }),
    addWorldMapOverlay(function* (): Iterable<MapOverlayShape> {
      const tv = trView()
      if (tv && transport) yield { x: tv.pos.x, z: tv.pos.z, color: OWN_TR_COLOR, width: 3.5, label: transport.name }
      if (isThief() && mode()) for (const c of caravans.values()) yield { x: c.x, z: c.z, color: CARAVAN_COLOR, radius: c.r, label: t('jobs.map.caravan', { stars: starsText(c.stars) }) }
      if (hunter?.onDuty) for (const p of robberPings.values()) yield { x: p.x, z: p.z, color: ROBBER_COLOR, radius: p.r, label: t('jobs.map.robber', { name: p.name }) }
    }),
  )

  // ---- the HUD refresh -------------------------------------------------------------------------------------------------
  const refresh = () => {
    prune()
    const me = self()
    page.set(job, charLevel(), lockLeft())
    panel.set(job, sack, robber, !!hunter?.licensed)
    placeFrame()
    const tv = trView()
    const dist = tv && me ? Math.hypot(tv.pos.x - me.pos.x, tv.pos.z - me.pos.z) : null
    const hp = tv && tv.maxHp > 0 ? tv.hp : null
    if (transport && hp !== null) {
      if (lastTrHp >= 0 && hp < lastTrHp && performance.now() - lastHurt > HURT_TOAST_MS) {
        lastHurt = performance.now()
        toast(t('jobs.notice.hurt', { name: transport.name }), 'error')
      }
      lastTrHp = hp
    }
    frame.set(transport, hp, dist, transport ? (app.catalog?.cos?.(JOBS_CONTENT.transports.find((d) => d.tier === transport!.tier)?.cos ?? '')?.icon ?? null) : null)
    bagPrompt.set(me && !me.dead ? bagsNear(bags.values(), me.pos.x, me.pos.z, BAG_PROMPT_M) : [], now())
  }

  // ---- debug ---------------------------------------------------------------------------------------------------------
  const talkTo = (code: string) => {
    for (const v of ctx.views()) if (v.kind === 'npc' && (v.state.npc ?? v.state.model) === code) return ctx.send({ t: 'npcTalk', npc: v.id })
    return false
  }
  const debug = {
    state: () => ({ job, sack, transport, hunter, robber, markets: Object.fromEntries(markets), bags: [...bags.values()], caravans: [...caravans.values()], robberPings: [...robberPings.values()], talk: talk ? { npc: talk.npc, code: talk.code } : null }),
    /** Talks to an NPC in view by code: the server walks there and opens the dialog. */
    talk: talkTo,
    /** Chooses a service option of the open dialog by service id (as a click on its line would). */
    option: (service: string) => {
      if (!talk) return false
      const handlers: Record<string, () => void> = {
        trader: () => showLicence('trader'),
        thief: () => showLicence('thief'),
        hunter: () => showLicence('hunter'),
        market: () => talk && openTrade(talk),
        den: () => den === null || !den.isOpen ? denWindow().show(job, sack, scrollPrice()) : undefined,
      }
      handlers[service]?.()
      return true
    },
    page: () => page.open(),
    dest: (id: TradePointId) => trade?.setDest(id),
    select: (good: string) => trade?.select(good),
    buy: (good: string, crates: number, dest: TradePointId) => (talk ? ctx.send({ t: 'tradeBuy', npc: talk.npc, good, crates, dest }) : false),
    sell: (good?: string) => (talk ? ctx.send(good ? { t: 'tradeSell', npc: talk.npc, good } : { t: 'tradeSell', npc: talk.npc }) : false),
    pick: (id?: number) => {
      const me = self()
      const b = id !== undefined ? bags.get(id) : me ? bagsNear(bags.values(), me.pos.x, me.pos.z, 1e9)[0] : undefined
      if (b) pick(b.id)
      return b?.id ?? null
    },
    /** Selects entity `id` and attacks it, as a click would. */
    attack: (id: number) => {
      const v = ctx.view(id)
      if (!v) return false
      ctx.setTarget(v)
      return ctx.send({ t: 'attack', target: id })
    },
    views: () => [...ctx.views()].filter((v) => v.kind === 'player' || v.kind === 'cos').map((v) => ({ id: v.id, kind: v.kind, name: v.displayName(), model: v.state.model, stars: v.state.stars, robber: v.state.robber, job: v.state.job, hp: v.hp, x: v.pos.x, z: v.pos.z })),
    gm: (cmd: string, ...args: string[]) => ctx.send({ t: 'gm', cmd, args }),
  }
  if (typeof window !== 'undefined') (window as unknown as { __sroJobUi?: unknown }).__sroJobUi = debug
  offs.push(() => {
    const w = typeof window !== 'undefined' ? (window as unknown as { __sroJobUi?: unknown }) : null
    if (w && w.__sroJobUi === debug) delete w.__sroJobUi
  })

  const requests = new Set<string>(JOB_UI_REQUESTS)
  const closeAll = () => {
    for (const w of licences.values()) w.close()
    trade?.close()
    den?.close()
  }

  return {
    onMessage(msg: ServerMessage) {
      switch (msg.t) {
        case 'jobState': {
          const { t: _t, ...v } = msg
          const before = job
          job = v
          jobAt = performance.now()
          if (before?.job && before.job === v.job && v.level > before.level && v.job) notice(t('jobs.notice.level', { level: v.level, name: jobLevelName(v.job, v.level) }))
          refresh()
          refreshWindows()
          break
        }
        case 'jobSack':
          sack = msg.entries
          refresh()
          refreshWindows()
          break
        case 'market':
          markets.set(msg.post, msg.rows)
          refreshTrade()
          break
        case 'transportState': {
          const was = transport
          transport = msg.transport
          if (!transport) lastTrHp = -1
          if (was && !transport && was.hold.length > 0) notice(t('jobs.notice.transportDead', { name: was.name }))
          refresh()
          refreshTrade()
          break
        }
        case 'bag': {
          const { t: _t, ...b } = msg
          bags.set(b.id, b)
          break
        }
        case 'bagGone':
          bags.delete(msg.id)
          if (pendingPick?.id === msg.id) pendingPick = null
          break
        case 'caravanPing':
          if (!caravans.size) notice(t('jobs.notice.caravan', { stars: starsText(msg.stars) }), 4000)
          caravans.set(msg.id, { x: msg.x, z: msg.z, r: msg.r, stars: msg.stars, at: performance.now() })
          break
        case 'wantedPing':
          if (msg.robbery) robberPings.set(msg.id, { x: msg.x, z: msg.z, r: msg.r, name: msg.name, at: performance.now() })
          break
        case 'lawState': {
          hunter = msg.hunter ?? null
          const was = robber
          robber = !!msg.wanted?.robbery
          if (robber && !was) notice(t('jobs.notice.robber'), 8000)
          else if (!robber && was) notice(t('jobs.notice.robberEnd'))
          refreshWindows()
          break
        }
        case 'entityUpdate': {
          const v = ctx.view(msg.id)
          if (!v) break
          if (msg.robber !== undefined) {
            if (msg.robber) v.state.robber = true
            else delete v.state.robber
          }
          if (msg.stars !== undefined) {
            if (msg.stars > 0) v.state.stars = msg.stars
            else delete v.state.stars
          }
          break
        }
        case 'actionResult':
          if (!msg.ok && requests.has(msg.re) && msg.reason !== 'rate_limited') toast(jobFailText(msg.reason, msg.message), 'error')
          break
        case 'inventory':
        case 'inventoryUpdate':
          refreshWindows()
          break
        case 'npcDialogClose':
          if (talk && msg.npc === talk.npc) {
            closeAll()
            talk = null
          }
          break
        case 'worldLeft':
          job = null
          sack = []
          transport = null
          hunter = null
          robber = false
          bags.clear()
          caravans.clear()
          robberPings.clear()
          markets.clear()
          closeAll()
          break
      }
    },

    clickEntity(v) {
      const me = self()
      if (!me || me.dead) return false
      if (v.kind === 'cos' && isTransportCos(v.state.model)) {
        if (transport && v.id === transport.id) {
          ctx.send({ t: 'transportRide', on: !transport.ridden })
          return true
        }
        ctx.setTarget(v)
        if (isThief() && mode() && (v.state.stars ?? 0) > 0 && !v.dead) ctx.send({ t: 'attack', target: v.id })
        return true
      }
      if (v.kind !== 'player' || v.id === me.id || v.dead) return false
      const mine = { job: mode() && job?.job ? { job: job.job } : null, hunterOnDuty: !!hunter?.onDuty }
      if (!jobFightable(mine, { job: v.state.job ?? null, robber: v.state.robber === true })) return false
      ctx.setTarget(v)
      ctx.send({ t: 'attack', target: v.id })
      return true
    },

    escape() {
      for (const w of [...licences.values(), trade, den]) {
        if (w?.isOpen) {
          w.close()
          return true
        }
      }
      return false
    },

    onFrame(_now, dt) {
      const m = ctx.minimap()
      if (m && m !== minimap) {
        offMarkers?.()
        minimap = m
        offMarkers = m.addMarkerSource(markers)
      }
      if (pendingPick) {
        const b = bags.get(pendingPick.id)
        const me = self()
        if (!b || performance.now() > pendingPick.until) pendingPick = null
        else if (me && Math.hypot(b.x - me.pos.x, b.z - me.pos.z) <= BAG_REACH_M) {
          ctx.send({ t: 'bagPick', id: b.id })
          pendingPick = null
        }
      }
      hudT -= dt
      if (hudT > 0) return
      hudT = HUD_EVERY_S
      void jobAt
      refresh()
    },

    dispose() {
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch (err) {
          console.warn('[jobs] dispose step failed', err)
        }
      }
      panel.root.remove()
      frame.root.remove()
      bagPrompt.root.remove()
      page.dispose()
      for (const w of licences.values()) w.dispose()
      licences.clear()
      trade?.dispose()
      trade = null
      den?.dispose()
      den = null
    },
  }
}
