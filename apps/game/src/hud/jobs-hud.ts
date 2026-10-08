/**
 * The job system's windows and controls (docs/JOBS.md §10, layer 5), in the 2009 look of the kit: DOM only, the numbers
 * come from hud/jobs-logic.ts and the state from world/features/jobs.ts.
 *
 * - **JobPage**: the Main window's "Job" tab (side strip button `equip_slot_job_button`): the retail `chr_job_window`
 *   head (job icon, name, level name, the `com_job_gauge_<job>` EXP bar), side, job mode with the suit toggle, the
 *   suit tier, the limits of the level, the next unlock.
 * - **LicenceWindow**: Jodaesan (Trader), Captain Yun (Bounty Hunter; today's licence and duty, plus recovered goods),
 *   Old Fang (Thief): the job's text, cost and rules, the side warning, join / leave / suit / turn in.
 * - **TradeWindow**: a trade point's market (Jodaesan and the four post traders): goods with buy / sell prices, demand
 *   and drift arrows, the hold, the estimate at the chosen destination, the routes of the selected good, the load and
 *   its stars against the level's cap, summon and dismiss, buy / sell / sell all.
 * - **TransportFrame**: the own transport on the player frame's pet area (`wa_pet` look): HP, load, stars, follow
 *   state, Ride / Step down / Dismiss.
 * - **JobPanel**: the left column under the character frame: job, level, EXP, suit toggle, the sack, ROBBER.
 * - **DenWindow**: Seopok at the Bandit Den: the stolen goods and their payout, sell, the return scroll.
 * - **BagPrompt**: goods bags in reach, over the hotbar: Pick up / Go there.
 */
import { JOBS_CONTENT, jobLevelName, maxStarsAt, type HunterView, type JobId, type JobView, type MarketRow, type SackEntryView, type TradeBag, type TradePointId, type TradePost, type TransportView } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button, type KitButton } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { Icon } from '../ui/kit/icon.ts'
import { formatNumber } from './items.ts'
import {
  bagLine,
  buyPreview,
  heldOf,
  jobExpBar,
  jobHead,
  jobLimits,
  jobName,
  licenceState,
  licenceTerms,
  loadLine,
  marketCells,
  nextUnlockLine,
  routeEstimates,
  routeLine,
  sackLines,
  sackTotals,
  sideName,
  starsText,
  transportFollow,
  JOB_SETTINGS,
} from './jobs-logic.ts'
import { ensureNpcStyles, NpcWindow } from './npc-ui.ts'
import { mainWindowFor } from './main-window.ts'
import { ensurePilotStyles } from './pilot-style.ts'

const JOB_ICON: Record<JobId, string> = { trader: 'ifcommon/com_job_merchant', hunter: 'ifcommon/com_job_hunter', thief: 'ifcommon/com_job_thief' }
const JOB_GAUGE: Record<JobId, string> = { trader: 'ifcommon/com_job_gauge_merchant', hunter: 'ifcommon/com_job_gauge_hunter', thief: 'ifcommon/com_job_gauge_thief' }
const JOB_COLOR: Record<JobId, string> = { trader: '#e8b84a', hunter: '#7ab8ff', thief: '#ff5a46' }

const CSS = `
.job-text { color: var(--c-text); font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); white-space: pre-wrap; }
.job-note { color: #b9ad8f; font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); }
.job-status { color: #ffd953; font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); }
.job-warn { color: #ff8a70; font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); }
.job-warn:empty { display: none; }
.job-buttons { display: flex; justify-content: center; gap: 6px; flex-wrap: wrap; }
.job-ico { width: 16px; height: 16px; background: no-repeat 0 0 / 100% 100%; display: inline-block; vertical-align: -3px; }
.job-bar { position: relative; height: 8px; background: rgba(0, 0, 0, 0.75); box-shadow: inset 0 0 0 1px rgba(150, 130, 90, 0.6); overflow: hidden; }
.job-bar-fill { position: absolute; left: 1px; top: 1px; bottom: 1px; background-repeat: repeat-x; background-size: auto 100%; }
.job-bar-text { position: absolute; inset: -4px 0 0 0; text-align: center; font: 10px/14px var(--font-body); color: #fff; text-shadow: var(--t-outline); }

/* the Job tab of the Main window (364x356) */
.job-page { position: absolute; inset: 0; }
.job-page-head { position: absolute; left: 0; top: 0; width: 364px; height: 96px; background: no-repeat 0 0 / 364px 96px; }
.job-page-head.no-art { background: rgba(0, 0, 0, 0.45); box-shadow: inset 0 0 0 1px var(--c-rim); }
.job-page-title { position: absolute; left: 50px; top: 12px; width: 300px; font: 15px/19px var(--font-title); letter-spacing: 0.06em; color: var(--job-c, #e8e2cf); text-shadow: var(--t-outline); }
.job-page-level { position: absolute; left: 50px; top: 33px; width: 300px; font: 12px/15px var(--font-body); color: #ffd953; text-shadow: var(--t-outline); }
.job-page-tier { position: absolute; right: 18px; top: 14px; font: 11px/14px var(--font-body); color: #c8bc9a; text-shadow: var(--t-outline); }
.job-page-icon { position: absolute; left: 14px; top: 12px; width: 30px; height: 30px; background: no-repeat 0 0 / 100% 100%; }
.job-page-bar { position: absolute; left: 18px; top: 62px; width: 326px; height: 10px; }
.job-page-rows { position: absolute; left: 14px; top: 104px; width: 336px; display: flex; flex-direction: column; gap: 4px; }
.job-page-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.job-page-sec { margin-top: 6px; color: var(--c-label); font: 12px/15px var(--font-title); letter-spacing: 0.04em; text-shadow: var(--t-shadow); border-bottom: 1px solid rgba(156, 131, 80, 0.45); }
.job-page-li { color: #e6dcc2; font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); padding-left: 10px; position: relative; }
.job-page-li::before { content: '·'; position: absolute; left: 2px; color: #b9ad8f; }

/* the trade window */
.job-trade-head { display: flex; align-items: center; gap: 4px; font: 11px/16px var(--font-body); color: var(--c-label); text-shadow: var(--t-shadow); border-bottom: 1px solid rgba(156, 131, 80, 0.55); }
.job-trade-rows { position: absolute; inset: 0; overflow-y: auto; }
.job-trade-row { display: flex; align-items: center; gap: 4px; height: 26px; padding: 0 2px; cursor: pointer; font: 12px/16px var(--font-body); color: var(--c-text); text-shadow: var(--t-shadow); }
.job-trade-row:nth-child(odd) { background: rgba(255, 255, 255, 0.03); }
.job-trade-row:hover { background: rgba(255, 220, 140, 0.08); }
.job-trade-row.sel { background: rgba(255, 210, 110, 0.16); box-shadow: inset 0 0 0 1px rgba(255, 210, 110, 0.5); }
.job-trade-row.news .job-c-sell { color: #ffd953; }
.job-c-icon { width: 22px; flex: none; }
.job-c-name { width: 126px; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.job-c-buy, .job-c-sell, .job-c-hold, .job-c-est { text-align: right; font-variant-numeric: tabular-nums; flex: none; }
.job-c-buy { width: 64px; }
.job-c-sell { width: 78px; }
.job-c-hold { width: 38px; color: #9fdc8a; }
.job-c-est { width: 96px; color: #c8e0ff; }
.job-c-est.loss { color: #ff8a70; }
.job-c-act { margin-left: auto; display: flex; gap: 2px; }
.job-trade-row .up { color: #8fe07a; }
.job-trade-row .down { color: #ff8a70; }
.job-dest { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font: 11px/16px var(--font-body); color: var(--c-label); text-shadow: var(--t-shadow); }
.job-dest .kit-btn.on { filter: brightness(1.35) sepia(0.5); box-shadow: 0 0 0 1px #ffd953; }
.job-routes { display: flex; flex-direction: column; gap: 1px; font: 11px/14px var(--font-body); color: #e6dcc2; text-shadow: var(--t-shadow); }
.job-routes .best { color: #9fdc8a; }
.job-routes .loss { color: #ff8a70; }
.job-load { font: 12px/16px var(--font-body); color: #ffd953; text-shadow: var(--t-shadow); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.job-load.over { color: #ff8a70; }

/* the left column panel */
.job-panel { position: relative; width: 250px; box-sizing: border-box; padding: 4px 9px 7px; pointer-events: auto; border-radius: 3px; text-shadow: 0 0 2px #000, 0 1px 1px #000;
  background: linear-gradient(rgba(40, 30, 12, 0.9), rgba(16, 12, 4, 0.9)); border: 1px solid rgba(var(--job-rgb, 232, 184, 74), 0.75); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85), 0 0 10px rgba(var(--job-rgb, 232, 184, 74), 0.25); }
.job-panel[hidden] { display: none; }
.job-panel-head { display: flex; align-items: center; gap: 5px; font: 12px/19px var(--font-title); letter-spacing: 0.08em; color: var(--job-c, #e8b84a); text-transform: uppercase; }
.job-panel.off .job-panel-head { color: #a8a090; }
.job-panel-level { font: 11px/15px var(--font-body); color: #f0e6cc; }
.job-panel-sack { font: 11px/14px var(--font-body); color: #f2dccb; }
.job-panel-sack.stolen { color: #ffb0a0; }
.job-panel-sack.recovered { color: #9cc4f0; }
.job-panel-robber { font: 11px/14px var(--font-body); color: #ff5a46; font-weight: bold; }
.job-panel-robber[hidden] { display: none; }
.job-panel-buttons { display: flex; gap: 6px; margin-top: 4px; }

/* the transport frame, under the pet area */
.job-tr { position: absolute; left: 0; top: 0; width: 236px; height: 42px; background: rgba(12, 10, 8, 0.82); border: 1px solid var(--c-rim, #8a7550); border-radius: 20px 4px 4px 20px; box-sizing: border-box; pointer-events: auto; }
.job-tr-face { position: absolute; left: 4px; top: 3px; width: 32px; height: 32px; border-radius: 50%; overflow: hidden; }
.job-tr-name { position: absolute; left: 42px; top: 4px; width: 62px; font: 11px/13px var(--font-body); color: #fff3a8; text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.job-tr-stars { position: absolute; left: 104px; top: 4px; font: 10px/13px var(--font-body); color: #ffd953; text-shadow: var(--t-outline); letter-spacing: -1px; }
.job-tr-hp { position: absolute; left: 42px; top: 21px; width: 186px; height: 6px; background: rgba(0, 0, 0, 0.7); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.9); }
.job-tr-hp-fill { height: 100%; background: linear-gradient(#ff8a6a, #c0301a); }
.job-tr.low .job-tr-hp-fill { animation: job-blink 0.6s steps(2) infinite; }
@keyframes job-blink { 50% { opacity: 0.35; } }
.job-tr-sub { position: absolute; left: 42px; top: 28px; width: 190px; font: 10px/12px var(--font-body); color: #d8ccb0; text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.job-tr-buttons { position: absolute; right: 3px; top: 1px; display: flex; gap: 2px; transform: scale(0.85); transform-origin: right top; }

/* bag prompt */
.job-bag { position: absolute; left: 50%; bottom: 240px; transform: translateX(-50%); padding: 6px 12px 8px; text-align: center; pointer-events: auto; }
.job-bag[hidden] { display: none; }
.job-bag-line { font: 12px/16px var(--font-body); color: #ffd953; margin-bottom: 4px; }
.job-bag-more { font: 10px/13px var(--font-body); color: #c8bc9a; margin-bottom: 4px; }
.job-bag-more:empty { display: none; }

.job-den-list { display: flex; flex-direction: column; gap: 2px; font: 12px/16px var(--font-body); color: #f2dccb; text-shadow: var(--t-shadow); }
.entity-label .label-line-robber { color: #ff7a2a; font-weight: bold; letter-spacing: 0.1em; text-shadow: 1px 0 1px #000, -1px 0 1px #000, 0 1px 1px #000, 0 -1px 1px #000, 0 0 6px rgba(255, 90, 10, 0.6); }
`

let injected = false
export function ensureJobStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  ensureNpcStyles()
  ensurePilotStyles()
  const s = document.createElement('style')
  s.dataset.sro = 'jobs'
  s.textContent = CSS
  document.head.append(s)
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

/** A thin EXP bar of the job's gauge art (tiled), with the text over it. */
class JobBar {
  readonly root: HTMLElement
  private readonly fill: HTMLElement
  private readonly text: HTMLElement
  private job: JobId | null = null
  constructor(private readonly art: Art, className = '') {
    this.fill = el('div', 'job-bar-fill')
    this.text = el('div', 'job-bar-text')
    this.root = el('div', `job-bar ${className}`.trim(), this.fill, this.text)
  }
  set(job: JobId, frac: number, text: string): void {
    if (job !== this.job) {
      this.job = job
      const key = JOB_GAUGE[job]
      this.fill.style.backgroundImage = this.art.has(key) ? this.art.cssUrl(key) : ''
      this.fill.style.backgroundColor = this.art.has(key) ? '' : JOB_COLOR[job]
    }
    this.fill.style.width = `calc(${(Math.max(0, Math.min(1, frac)) * 100).toFixed(2)}% - 2px)`
    this.text.textContent = text
  }
}

const jobIcon = (art: Art, job: JobId, cls = 'job-ico'): HTMLElement => {
  const e = el('span', cls)
  if (art.has(JOB_ICON[job])) e.style.backgroundImage = art.cssUrl(JOB_ICON[job])
  else e.style.background = JOB_COLOR[job]
  return e
}

/** An NPC window whose children placed at retail px are appended to its body too. */
class JobNpcWindow extends NpcWindow {
  protected put<T extends HTMLElement>(e: T, rect: [number, number, number, number]): T {
    this.body.append(this.at(e, rect))
    return e
  }
}

// ---- the Job tab of the Main window ------------------------------------------------------------------------------

export class JobPage {
  readonly body: HTMLElement
  private readonly head: HTMLElement
  private readonly icon: HTMLElement
  private readonly title: HTMLElement
  private readonly level: HTMLElement
  private readonly tier: HTMLElement
  private readonly bar: JobBar
  private readonly rows: HTMLElement
  private readonly suit: KitButton
  private readonly unregister: () => void
  private readonly main: ReturnType<typeof mainWindowFor>
  private view: JobView | null = null
  private lockLeft = 0
  onSuit: ((on: boolean) => void) | null = null

  constructor(private readonly art: Art, layer: HTMLElement) {
    ensureJobStyles()
    this.head = el('div', 'job-page-head')
    if (art.has('character/chr_job_window')) this.head.style.backgroundImage = art.cssUrl('character/chr_job_window')
    else this.head.classList.add('no-art')
    this.icon = el('div', 'job-page-icon')
    this.title = el('div', 'job-page-title')
    this.level = el('div', 'job-page-level')
    this.tier = el('div', 'job-page-tier')
    this.bar = new JobBar(art, 'job-page-bar')
    this.head.append(this.icon, this.title, this.level, this.tier, this.bar.root)
    this.rows = el('div', 'job-page-rows')
    this.suit = button(art, { label: t('jobs.page.suitOn'), minWidth: 120 }, () => this.onSuit?.(!this.view?.mode))
    this.body = el('div', 'job-page hud-main-page main-page-job', this.head, this.rows)
    this.main = mainWindowFor(art, layer)
    this.unregister = this.main.addTab({ id: 'job', title: t('jobs.page.title'), icon: 'equipment/equip_slot_job_button', page: this.body, onShow: () => this.render() })
  }

  get isOpen(): boolean {
    return this.main.isShowing('job')
  }

  open(): void {
    this.main.show('job')
  }

  set(v: JobView | null, charLevel: number, lockLeftMs: number): void {
    this.view = v
    this.lockLeft = lockLeftMs
    void charLevel
    if (this.isOpen) this.render()
  }

  render(): void {
    const v = this.view
    const h = jobHead(v)
    this.title.textContent = h.title
    this.level.textContent = h.level
    this.tier.textContent = h.tier
    const rows: HTMLElement[] = []
    if (!v?.job) {
      this.icon.style.backgroundImage = ''
      this.bar.root.hidden = true
      rows.push(el('div', 'job-text', t('jobs.page.none', { level: licenceTerms('trader').level })))
      if (v?.joinAfter && v.joinAfter > Date.now()) rows.push(el('div', 'job-warn', t('jobs.page.joinAfter', { date: new Date(v.joinAfter).toISOString().slice(0, 10) })))
      this.rows.replaceChildren(...rows)
      return
    }
    const job = v.job
    this.head.style.setProperty('--job-c', JOB_COLOR[job])
    if (this.art.has(JOB_ICON[job])) this.icon.style.backgroundImage = this.art.cssUrl(JOB_ICON[job])
    this.bar.root.hidden = false
    const exp = jobExpBar(v)
    this.bar.set(job, exp.frac, exp.text)
    if (v.side) rows.push(el('div', 'job-note', t('jobs.page.side', { side: sideName(v.side) })))
    rows.push(el('div', 'job-page-sec', t('jobs.page.mode')))
    this.suit.setLabel(t(v.mode ? 'jobs.page.suitOff' : 'jobs.page.suitOn'))
    this.suit.setDisabled(v.mode && this.lockLeft > 0)
    const modeLine = el('div', 'job-note', this.lockLeft > 0 && v.mode ? t('jobs.page.lock', { time: `${Math.ceil(this.lockLeft / 1000)} s` }) : t(v.mode ? 'jobs.page.modeOn' : 'jobs.page.modeOff'))
    rows.push(el('div', 'job-page-row', modeLine, this.suit))
    rows.push(el('div', 'job-page-sec', t('jobs.page.caps')))
    for (const l of jobLimits(job, v.level)) rows.push(el('div', 'job-page-li', l))
    rows.push(el('div', 'job-note', nextUnlockLine(job, v.level)))
    this.rows.replaceChildren(...rows)
  }

  dispose(): void {
    this.unregister()
  }
}

// ---- licence windows ---------------------------------------------------------------------------------------------

export const LIC_W = 430
export const LIC_H = 400

export class LicenceWindow extends JobNpcWindow {
  private readonly text: HTMLElement
  private readonly cost: HTMLElement
  private readonly side: HTMLElement
  private readonly rules: HTMLElement
  private readonly status: HTMLElement
  private readonly warn: HTMLElement
  private readonly recovered: HTMLElement
  private readonly joinBtn: KitButton
  private readonly leaveBtn: KitButton
  private readonly suitBtn: KitButton
  private readonly turnInBtn: KitButton
  private suitOn = false
  onJoin: (() => void) | null = null
  onLeave: (() => void) | null = null
  onSuit: ((on: boolean) => void) | null = null
  onTurnIn: (() => void) | null = null
  onBack: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement, readonly job: JobId) {
    ensureJobStyles()
    super(art, parent, { id: `job-lic-${job}`, title: t(`jobs.lic.title.${job}` as 'jobs.lic.title.trader'), width: LIC_W, height: LIC_H, at: [0.36, 0.22] })
    const talk = new Frame(art, 'talk', { at: this.r([11, 46, 408, 124]), inset: [8, 10, 8, 10] })
    this.text = el('div', 'job-text')
    talk.body.append(this.text)
    this.cost = this.put(el('div', 'job-note'), [20, 172, 390, 28])
    this.side = this.put(el('div', 'job-note'), [20, 200, 390, 56])
    this.rules = this.put(el('div', 'job-note'), [20, 258, 390, 30])
    this.status = this.put(el('div', 'job-status'), [20, 290, 390, 18])
    this.warn = this.put(el('div', 'job-warn'), [20, 308, 390, 16])
    this.recovered = this.put(el('div', 'job-note'), [20, 324, 390, 16])
    this.joinBtn = button(art, { label: t('jobs.lic.join'), primary: true, minWidth: 110 }, () => this.onJoin?.())
    this.suitBtn = button(art, { label: t('jobs.lic.suitOn'), primary: true, minWidth: 80 }, () => this.onSuit?.(!this.suitOn))
    this.turnInBtn = button(art, { label: t('jobs.lic.turnIn'), minWidth: 110 }, () => this.onTurnIn?.())
    this.leaveBtn = button(art, { label: t('jobs.lic.leaveBtn'), minWidth: 90 }, () => this.onLeave?.())
    const back = button(art, { label: t('jobs.lic.back'), minWidth: 70 }, () => this.onBack?.())
    this.put(el('div', 'job-buttons', this.joinBtn, this.suitBtn, this.turnInBtn, this.leaveBtn, back), [11, 356, 408, 28])
    this.body.append(talk.root)
    const terms = licenceTerms(job)
    this.text.textContent = t(`jobs.lic.text.${job}` as 'jobs.lic.text.trader', { pct: JOB_SETTINGS.thief.denPct })
    this.cost.textContent = t('jobs.lic.cost', { gold: formatNumber(terms.gold), level: terms.level, clean: terms.cleanDays ? t('jobs.lic.clean', { days: terms.cleanDays }) : '' })
    this.side.textContent = `${t('jobs.lic.side', { side: sideName(job === 'thief' ? 'outlaw' : 'law'), days: terms.sideDays })} ${t('jobs.lic.leave', { days: terms.leaveDays })}`
    this.rules.textContent = t(`jobs.lic.rules.${job}` as 'jobs.lic.rules.trader', { min: 2 })
  }

  show(v: JobView | null, charLevel: number, gold: number, now: number, hunter: HunterView | null, sack: readonly SackEntryView[]): void {
    this.update(v, charLevel, gold, now, hunter, sack)
    this.open()
    this.raise()
  }

  update(v: JobView | null, charLevel: number, gold: number, now: number, hunter: HunterView | null, sack: readonly SackEntryView[]): void {
    const s = licenceState(this.job, v, charLevel, now, hunter)
    this.suitOn = s.suitOn
    this.status.textContent = s.status
    this.warn.textContent = s.warn
    this.joinBtn.hidden = !s.canJoin
    this.joinBtn.setDisabled(gold < licenceTerms(this.job).gold || !!s.warn)
    this.suitBtn.hidden = !s.canSuit
    this.suitBtn.setLabel(t(s.suitOn ? 'jobs.lic.suitOff' : 'jobs.lic.suitOn'))
    this.leaveBtn.hidden = !(v?.job === this.job)
    this.leaveBtn.setDisabled(!s.canLeave)
    const rec = sackTotals(sack).recovered
    this.turnInBtn.hidden = this.job !== 'hunter' || rec.crates === 0
    this.recovered.textContent = this.job === 'hunter' && v?.job === 'hunter' ? (rec.crates ? t('jobs.lic.recovered', { crates: rec.crates, gold: formatNumber(rec.value) }) : t('jobs.lic.recoveredNone')) : ''
  }
}

// ---- the trade window ----------------------------------------------------------------------------------------------

export const TRADE_W = 600
export const TRADE_H = 532

export interface TradeContext {
  post: TradePost
  rows: readonly MarketRow[]
  transport: TransportView | null
  job: JobView | null
  gold: number
  /** Own crates on the back (sellable here by the owner). */
  ownCrates: number
}

export class TradeWindow extends JobNpcWindow {
  private readonly info: HTMLElement
  private readonly loadEl: HTMLElement
  private readonly cap: HTMLElement
  private readonly summonRow: HTMLElement
  private readonly destRow: HTMLElement
  private readonly list: HTMLElement
  private readonly estHead: HTMLElement
  private readonly routes: HTMLElement
  private readonly goldEl: HTMLElement
  private readonly sellAll: KitButton
  private readonly sellSack: KitButton
  private readonly dismissBtn: KitButton
  private ctx: TradeContext | null = null
  private dest: TradePointId | null = null
  private selected: string | null = null
  onBuy: ((good: string, dest: TradePointId, row: MarketRow) => void) | null = null
  onSell: ((good: string | null, row: MarketRow | null) => void) | null = null
  onSummon: ((tier: number) => void) | null = null
  onDismiss: (() => void) | null = null
  onRefresh: (() => void) | null = null
  onBack: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement, private readonly iconOf: (code: string) => string | null) {
    ensureJobStyles()
    super(art, parent, { id: 'job-trade', title: t('jobs.trade.title', { post: '' }), width: TRADE_W, height: TRADE_H, at: [0.3, 0.18] })
    const top = new Frame(art, 'inner', { at: this.r([11, 44, 578, 92]), inset: [5, 8, 5, 8] })
    this.info = el('div', 'job-note')
    this.loadEl = el('div', 'job-load')
    this.cap = el('div', 'job-note')
    this.summonRow = el('div', 'job-buttons')
    this.summonRow.style.justifyContent = 'flex-start'
    top.body.append(this.info, this.loadEl, this.cap, this.summonRow)
    this.destRow = this.put(el('div', 'job-dest'), [14, 140, 572, 24])
    this.destRow.title = t('jobs.trade.destTip')
    this.estHead = el('span', 'job-c-est')
    this.put(
      el(
        'div',
        'job-trade-head',
        el('span', 'job-c-icon'),
        el('span', 'job-c-name', t('jobs.trade.col.good')),
        el('span', 'job-c-buy', t('jobs.trade.col.buy')),
        el('span', 'job-c-sell', t('jobs.trade.col.sell')),
        el('span', 'job-c-hold', t('jobs.trade.col.hold')),
        this.estHead,
      ),
      [14, 168, 572, 18],
    )
    const listBox = new Frame(art, 'inner', { at: this.r([11, 188, 578, 196]), inset: [3, 3, 3, 3] })
    this.list = el('div', 'job-trade-rows')
    listBox.body.append(this.list)
    const routeBox = new Frame(art, 'inner', { at: this.r([11, 388, 578, 100]), inset: [4, 8, 4, 8] })
    this.routes = el('div', 'job-routes')
    routeBox.body.append(this.routes)
    this.goldEl = el('span', 'job-status')
    this.sellAll = button(art, { label: t('jobs.trade.sellAll'), minWidth: 100 }, () => this.onSell?.(null, null))
    this.sellSack = button(art, { label: t('jobs.trade.sellSack'), minWidth: 100 }, () => this.onSell?.(null, null))
    this.dismissBtn = button(art, { label: t('jobs.tr.dismiss'), minWidth: 70, title: t('jobs.tr.dismissTip') }, () => this.onDismiss?.())
    const refresh = button(art, { label: t('jobs.trade.refresh'), minWidth: 70 }, () => this.onRefresh?.())
    const back = button(art, { label: t('jobs.trade.back'), minWidth: 60 }, () => this.onBack?.())
    const foot = el('div', 'job-buttons', this.goldEl, this.sellAll, this.sellSack, this.dismissBtn, refresh, back)
    foot.style.alignItems = 'center'
    this.put(foot, [11, 494, 578, 28])
    this.body.append(top.root, listBox.root, routeBox.root)
  }

  get post(): TradePost | null {
    return this.ctx?.post ?? null
  }

  get destination(): TradePointId | null {
    return this.dest
  }

  /** Chooses the destination (the routes and estimates follow). */
  setDest(id: TradePointId): void {
    this.dest = id
    if (this.ctx) this.render()
  }

  select(good: string | null): void {
    this.selected = good
    if (this.ctx) this.render()
  }

  show(c: TradeContext): void {
    this.update(c)
    this.open()
    this.raise()
  }

  update(c: TradeContext): void {
    const postChanged = this.ctx?.post.id !== c.post.id
    this.ctx = c
    if (postChanged || !this.dest || this.dest === c.post.id) {
      // the load's declared destination, else the nearest road out (from Jangan the South Beach, from a post Jangan)
      const fromLoad = c.transport?.dest && c.transport.dest !== c.post.id ? c.transport.dest : null
      this.dest = fromLoad ?? (c.post.id === 'jangan' ? 'south-beach' : 'jangan')
    }
    if (postChanged || !c.rows.some((r) => r.good === this.selected)) this.selected = c.rows.find((r) => r.buy !== undefined)?.good ?? c.rows[0]?.good ?? null
    this.render()
  }

  private render(): void {
    const c = this.ctx
    if (!c) return
    this.setTitle(t('jobs.trade.title', { post: c.post.name }))
    const job = c.job
    const trader = job?.job === 'trader'
    const level = trader ? job.level : 1
    this.info.textContent = !trader ? t('jobs.trade.notTrader') : !job.mode ? t('jobs.trade.notMode') : `${c.post.npc.name} · ${c.post.name}`
    const tr = c.transport
    const holdValue = tr ? tr.hold.reduce((n, e) => n + e.cost, 0) : 0
    const cap = maxStarsAt(level, JOB_SETTINGS.trade.maxStars)
    if (tr) {
      this.loadEl.textContent = `${loadLine(tr)}${tr.dest ? ` · ${t('jobs.trade.loadDest', { dest: JOBS_CONTENT.posts.find((p) => p.id === tr.dest)?.name ?? tr.dest })}` : ''}`
      this.loadEl.classList.toggle('over', tr.stars > cap)
    } else {
      this.loadEl.textContent = t('jobs.trade.none')
      this.loadEl.classList.remove('over')
    }
    this.cap.textContent = trader ? t('jobs.trade.starsCap', { stars: starsText(cap) }) : ''
    // summon buttons (no transport) — the tiers the level allows enabled
    const summons: HTMLElement[] = []
    if (!tr && trader) {
      for (const d of JOBS_CONTENT.transports) {
        const ok = level >= d.jobLevel
        const b = button(this.art, { label: ok ? t('jobs.trade.summon', { name: d.name, gold: formatNumber(d.price) }) : t('jobs.trade.summonLocked', { name: d.name, level: d.jobLevel }), minWidth: 96, skin: 'small' }, () => this.onSummon?.(d.tier))
        b.title = t('jobs.trade.summonTip', { name: d.name, hold: d.hold, hp: formatNumber(d.hp), speed: d.speed, level: d.jobLevel })
        b.setDisabled(!ok || !job.mode || c.gold < d.price)
        summons.push(b)
      }
    }
    this.summonRow.replaceChildren(...summons)
    this.summonRow.hidden = summons.length === 0
    // destinations
    const dests: HTMLElement[] = [el('span', '', t('jobs.trade.dest'))]
    for (const p of JOBS_CONTENT.posts) {
      if (p.id === c.post.id) continue
      const b = button(this.art, { label: p.name, minWidth: 70, skin: 'small' }, () => this.setDest(p.id))
      b.classList.toggle('on', p.id === this.dest)
      dests.push(b)
    }
    this.destRow.replaceChildren(...dests)
    const dest = JOBS_CONTENT.posts.find((p) => p.id === this.dest) ?? null
    this.estHead.textContent = dest ? t('jobs.trade.col.est', { dest: dest.name }) : ''
    // goods
    const room = tr ? tr.capacity - tr.hold.reduce((n, e) => n + e.crates, 0) : 0
    const rows = c.rows.map((row) => {
      const held = heldOf(tr, row.good)
      const cells = marketCells(row, held)
      const unit = row.buy ?? (held > 0 ? (tr?.hold.find((e) => e.good === row.good)?.cost ?? 0) / held : 0)
      const est = dest && unit > 0 ? routeEstimates(row.good, unit).find((r) => r.post.id === dest.id) : undefined
      const estEl = el('span', `job-c-est${est && est.profit < 0 ? ' loss' : ''}`, est ? `${formatNumber(est.sell)} (${est.profit >= 0 ? '+' : ''}${formatNumber(est.profit)})` : '')
      const sellEl = el('span', 'job-c-sell', cells.sell)
      if (row.demand > 1.005) sellEl.classList.add('up')
      else if (row.demand < 0.995) sellEl.classList.add('down')
      const act = el('span', 'job-c-act')
      if (row.buy !== undefined) {
        const b = button(this.art, { label: t('jobs.trade.buyBtn'), minWidth: 44, skin: 'small' }, (ev) => {
          ev.stopPropagation()
          if (this.dest) this.onBuy?.(row.good, this.dest, row)
        })
        b.setDisabled(!trader || !job?.mode || !tr || room <= 0 || c.gold < row.buy)
        if (tr && trader) b.title = t('jobs.trade.preview', { n: 1, gold: formatNumber(row.buy), stars: starsText(buyPreview(goodBaseOf(row), row.buyMul ?? 1, 1, holdValue).stars) })
        act.append(b)
      }
      if (held > 0) {
        const s = button(this.art, { label: t('jobs.trade.sellBtn'), minWidth: 44, skin: 'small' }, (ev) => {
          ev.stopPropagation()
          this.onSell?.(row.good, row)
        })
        s.setDisabled(!trader || !job?.mode)
        act.append(s)
      }
      const icon = el('span', 'job-c-icon', Icon(this.iconOf(row.good), { size: 20, name: row.name }))
      const r = el(
        'div',
        `job-trade-row${row.good === this.selected ? ' sel' : ''}${row.news ? ' news' : ''}`,
        icon,
        el('span', 'job-c-name', row.name),
        el('span', 'job-c-buy', cells.buy),
        sellEl,
        el('span', 'job-c-hold', cells.hold),
        estEl,
        act,
      )
      r.title = cells.tip
      r.dataset.good = row.good
      r.addEventListener('click', () => this.select(row.good))
      return r
    })
    this.list.replaceChildren(...rows)
    // routes of the selected good
    const sel = c.rows.find((r) => r.good === this.selected)
    const lines: HTMLElement[] = []
    if (sel) {
      const held = heldOf(tr, sel.good)
      const paid = sel.buy ?? (held > 0 ? Math.round((tr?.hold.find((e) => e.good === sel.good)?.cost ?? 0) / held) : goodBaseOf(sel))
      const est = routeEstimates(sel.good, paid)
      lines.push(el('div', 'job-note', `${t('jobs.trade.routes', { good: sel.name })} · ${t('jobs.trade.estNote', { pct: JOB_SETTINGS.trade.taxPct })}`))
      est.forEach((r, i) => lines.push(el('div', r.profit < 0 ? 'loss' : i === 0 ? 'best' : '', routeLine(r, paid))))
    } else lines.push(el('div', 'job-note', t('jobs.trade.routeNone')))
    this.routes.replaceChildren(...lines)
    this.goldEl.textContent = `${formatNumber(c.gold)} G`
    const anyHeld = !!tr && tr.hold.length > 0
    this.sellAll.hidden = !anyHeld
    this.sellAll.setDisabled(!trader || !job?.mode)
    this.sellSack.hidden = anyHeld || c.ownCrates === 0
    this.dismissBtn.hidden = !tr
    this.dismissBtn.setDisabled(!!tr && tr.hold.length > 0)
  }
}

function goodBaseOf(row: MarketRow): number {
  return JOBS_CONTENT.goods.find((g) => g.code === row.good)?.base ?? row.buy ?? row.sell
}

// ---- the transport frame ----------------------------------------------------------------------------------------------

export class TransportFrame {
  readonly root: HTMLElement
  private readonly face: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly stars: HTMLElement
  private readonly hpFill: HTMLElement
  private readonly hp: HTMLElement
  private readonly sub: HTMLElement
  private readonly ride: KitButton
  private readonly dismiss: KitButton
  private readonly stay: KitButton
  private tr: TransportView | null = null
  private icon: string | null | undefined = undefined
  onRide: ((on: boolean) => void) | null = null
  /** Follow (true) or stay here (false). */
  onFollow: ((on: boolean) => void) | null = null
  onDismiss: (() => void) | null = null

  constructor(art: Art) {
    ensureJobStyles()
    this.face = el('div', 'job-tr-face')
    this.nameEl = el('div', 'job-tr-name')
    this.stars = el('div', 'job-tr-stars')
    this.hpFill = el('div', 'job-tr-hp-fill')
    this.hp = el('div', 'job-tr-hp', this.hpFill)
    this.sub = el('div', 'job-tr-sub')
    this.ride = button(art, { label: t('jobs.tr.ride'), skin: 'tiny', title: t('jobs.tr.rideTip') }, () => this.onRide?.(!this.tr?.ridden))
    this.dismiss = button(art, { label: t('jobs.tr.dismiss'), skin: 'tiny', title: t('jobs.tr.dismissTip') }, () => this.onDismiss?.())
    this.stay = button(art, { label: t('jobs.tr.stay'), skin: 'tiny', title: t('jobs.tr.stayTip') }, () => this.onFollow?.(!!this.tr?.staying))
    this.root = el('div', 'job-tr', this.face, this.nameEl, this.stars, this.hp, this.sub, el('div', 'job-tr-buttons', this.ride, this.stay, this.dismiss))
    this.root.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    this.root.hidden = true
  }

  /** `hp`: the live HP (entity updates) when known; `dist`: metres to it (null: unknown). */
  set(tr: TransportView | null, hp: number | null, dist: number | null, icon: string | null): void {
    this.tr = tr
    if (!tr) {
      this.root.hidden = true
      return
    }
    this.root.hidden = false
    if (this.icon !== icon) {
      this.icon = icon
      this.face.replaceChildren(Icon(icon, { size: 32, name: tr.name }))
    }
    const crates = tr.hold.reduce((n, e) => n + e.crates, 0)
    const cur = Math.max(0, hp ?? tr.hp)
    this.nameEl.textContent = tr.name
    this.stars.textContent = crates ? starsText(Math.max(1, tr.stars)) : ''
    this.hpFill.style.width = `${Math.min(100, (cur / Math.max(1, tr.maxHp)) * 100).toFixed(1)}%`
    this.hp.title = t('jobs.tr.hp', { hp: formatNumber(cur), max: formatNumber(tr.maxHp) })
    this.root.classList.toggle('low', cur / Math.max(1, tr.maxHp) < 0.25)
    const dest = tr.dest ? JOBS_CONTENT.posts.find((p) => p.id === tr.dest)?.name ?? tr.dest : null
    this.sub.textContent = [crates ? t('jobs.tr.load', { crates, cap: tr.capacity }) : t('jobs.tr.empty'), dest && crates ? t('jobs.tr.to', { dest }) : '', transportFollow(tr, dist)].filter(Boolean).join(' · ')
    this.root.title = t('jobs.tr.tip', { name: tr.name, stars: starsText(tr.stars), hold: tr.hold.map((e) => `${e.crates} × ${JOBS_CONTENT.goods.find((g) => g.code === e.good)?.name ?? e.good}`).join(', ') || t('jobs.tr.empty'), dest: dest ?? '–' })
    this.ride.setLabel(t(tr.ridden ? 'jobs.tr.down' : 'jobs.tr.ride'))
    this.stay.setLabel(t(tr.staying ? 'jobs.tr.followBtn' : 'jobs.tr.stay'))
    this.stay.title = t(tr.staying ? 'jobs.tr.followTip' : 'jobs.tr.stayTip')
    this.stay.hidden = tr.ridden
    this.dismiss.setDisabled(crates > 0)
    this.dismiss.hidden = crates > 0
  }

  get visible(): boolean {
    return !this.root.hidden
  }
}

// ---- the left-column job panel ------------------------------------------------------------------------------------

export class JobPanel {
  readonly root: HTMLElement
  private readonly head: HTMLElement
  private readonly level: HTMLElement
  private readonly bar: JobBar
  private readonly sack: HTMLElement
  private readonly robber: HTMLElement
  private readonly suit: KitButton
  private readonly jobBtn: KitButton
  private on = false
  onSuit: ((on: boolean) => void) | null = null
  onOpenPage: (() => void) | null = null

  constructor(private readonly art: Art) {
    ensureJobStyles()
    this.head = el('div', 'job-panel-head')
    this.level = el('div', 'job-panel-level')
    this.bar = new JobBar(art)
    this.sack = el('div')
    this.robber = el('div', 'job-panel-robber', t('jobs.sack.robber'))
    this.suit = button(art, { label: t('jobs.panel.suitOn'), minWidth: 80, skin: 'small' }, () => this.onSuit?.(!this.on))
    this.jobBtn = button(art, { label: t('jobs.page.title'), minWidth: 50, skin: 'small' }, () => this.onOpenPage?.())
    this.root = el('div', 'job-panel', this.head, this.level, this.bar.root, this.sack, this.robber, el('div', 'job-panel-buttons', this.suit, this.jobBtn))
    this.root.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    this.root.hidden = true
  }

  /** `hunterPanel`: the law's Bounty Hunter panel already shows the duty toggle (this one then shows only the sack). */
  set(v: JobView | null, sack: readonly SackEntryView[], robber: boolean, hunterPanel: boolean): void {
    const lines = sackLines(sack)
    const showJob = !!v?.job && !(v.job === 'hunter' && hunterPanel)
    if (!v?.job || (!showJob && lines.length === 0)) {
      this.root.hidden = true
      return
    }
    this.root.hidden = false
    const job = v.job
    this.on = v.mode
    this.root.style.setProperty('--job-c', JOB_COLOR[job])
    this.root.style.setProperty('--job-rgb', rgb(JOB_COLOR[job]))
    this.root.classList.toggle('off', !v.mode)
    this.head.replaceChildren(jobIcon(this.art, job), el('span', '', `${jobName(job)} · ${t(v.mode ? 'jobs.lic.mode.on' : 'jobs.lic.mode.off')}`))
    this.level.textContent = t('job.levelShort', { level: v.level, name: jobLevelName(job, v.level) })
    const exp = jobExpBar(v)
    this.bar.set(job, exp.frac, exp.text)
    for (const e of [this.head, this.level, this.bar.root, this.suit, this.jobBtn]) e.hidden = !showJob
    this.sack.replaceChildren(...lines.map((l) => el('div', `job-panel-sack ${l.kind}`, l.text)))
    this.robber.hidden = !robber
    this.suit.setLabel(t(v.mode ? 'jobs.panel.suitOff' : 'jobs.panel.suitOn'))
  }
}

// ---- the Bandit Den ---------------------------------------------------------------------------------------------------

export const DEN_W = 420
export const DEN_H = 360

export class DenWindow extends JobNpcWindow {
  private readonly text: HTMLElement
  private readonly list: HTMLElement
  private readonly total: HTMLElement
  private readonly warn: HTMLElement
  private readonly sellBtn: KitButton
  private readonly scrollBtn: KitButton
  onSell: (() => void) | null = null
  onScroll: (() => void) | null = null
  onBack: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement) {
    ensureJobStyles()
    super(art, parent, { id: 'job-den', title: t('jobs.den.title'), width: DEN_W, height: DEN_H, at: [0.38, 0.24] })
    const talk = new Frame(art, 'talk', { at: this.r([11, 46, 398, 92]), inset: [8, 10, 8, 10] })
    this.text = el('div', 'job-text', t('jobs.den.text', { pct: JOB_SETTINGS.thief.denPct, ring: JOB_SETTINGS.mode.safeRingM }))
    talk.body.append(this.text)
    const box = new Frame(art, 'inner', { at: this.r([11, 144, 398, 124]), inset: [5, 8, 5, 8] })
    this.list = el('div', 'job-den-list')
    box.body.append(this.list)
    this.total = this.put(el('div', 'job-status'), [20, 272, 380, 16])
    this.warn = this.put(el('div', 'job-warn'), [20, 290, 380, 16])
    this.sellBtn = button(art, { label: t('jobs.den.sell'), primary: true, minWidth: 120 }, () => this.onSell?.())
    this.scrollBtn = button(art, { label: t('jobs.den.scroll', { gold: '?' }), minWidth: 120 }, () => this.onScroll?.())
    const back = button(art, { label: t('jobs.lic.back'), minWidth: 70 }, () => this.onBack?.())
    this.put(el('div', 'job-buttons', this.sellBtn, this.scrollBtn, back), [11, 314, 398, 28])
    this.body.append(talk.root, box.root)
  }

  show(v: JobView | null, sack: readonly SackEntryView[], scrollPrice: number): void {
    this.update(v, sack, scrollPrice)
    this.open()
    this.raise()
  }

  update(v: JobView | null, sack: readonly SackEntryView[], scrollPrice: number): void {
    const stolen = sack.filter((e) => e.kind === 'stolen')
    this.list.replaceChildren(
      ...(stolen.length
        ? stolen.map((e) => el('div', '', t('jobs.den.line', { crates: e.crates, name: JOBS_CONTENT.goods.find((g) => g.code === e.good)?.name ?? e.good, owner: e.owner, gold: formatNumber(e.value) })))
        : [el('div', 'job-note', t('jobs.den.none'))]),
    )
    const tot = sackTotals(sack).stolen
    this.total.textContent = tot.crates ? t('jobs.den.total', { gold: formatNumber(tot.value) }) : ''
    const thief = v?.job === 'thief'
    this.warn.textContent = thief ? '' : t('jobs.den.notThief')
    this.sellBtn.setDisabled(!thief || tot.crates === 0)
    this.scrollBtn.setLabel(t('jobs.den.scroll', { gold: formatNumber(scrollPrice) }))
    this.scrollBtn.title = t('jobs.den.scrollTip', { level: 3 })
    this.scrollBtn.setDisabled(!thief || (v?.level ?? 0) < 3)
  }
}

// ---- the bag prompt ----------------------------------------------------------------------------------------------------

export class BagPrompt {
  readonly root: HTMLElement
  private readonly line: HTMLElement
  private readonly more: HTMLElement
  private readonly pick: KitButton
  private bag: (TradeBag & { d: number }) | null = null
  onPick: ((bag: TradeBag & { d: number }) => void) | null = null

  constructor(art: Art, readonly reachM: number) {
    ensureJobStyles()
    this.line = el('div', 'job-bag-line')
    this.more = el('div', 'job-bag-more')
    this.pick = button(art, { label: t('jobs.bag.pick'), primary: true, minWidth: 110 }, () => {
      if (this.bag) this.onPick?.(this.bag)
    })
    this.root = el('div', 'job-bag pl-panel', this.line, this.more, this.pick)
    this.root.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    this.root.hidden = true
  }

  set(near: readonly (TradeBag & { d: number })[], now: number): void {
    const b = near[0] ?? null
    this.bag = b
    this.root.hidden = !b
    if (!b) return
    this.line.textContent = bagLine(b, now)
    this.more.textContent = near.length > 1 ? t('jobs.bag.more', { n: near.length - 1 }) : ''
    this.pick.setLabel(t(b.d <= this.reachM ? 'jobs.bag.pick' : 'jobs.bag.walk'))
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }
}

