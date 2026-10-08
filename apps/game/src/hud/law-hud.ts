/**
 * Siege of Jangan, layer 5 HUD pieces (docs/SIEGE.md §9.3): the Wanted panel (your own warrant: the bounty, the online
 * time left before it lapses, treason), the keg prompt (Plant a Thunder Keg here, at the outer foot of the wall) and
 * Old Fang's window (craft a keg). DOM only: the state comes from world/features/law.ts; the text helpers here are
 * DOM-free (`wantedLines`, `lawNoticeText`, `wantedLabel`). The panels use Play the Boss's look (`pl-panel`).
 *
 * The Wanted panel sits on the left under the character's frame (top 118, left 8), out of the siege panel's column
 * (right) and the banners (top centre); the plant prompt sits over the hotbar, above the Defuse prompt's spot.
 */
import { wallName, type HunterView, type JailView, type ServerMessage, type WantedView } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { formatNumber } from './items.ts'
import { ensureNpcStyles, NpcWindow } from './npc-ui.ts'
import { ensurePilotStyles } from './pilot-style.ts'

// ---- text (DOM-free) -------------------------------------------------------------------------------------------------

/** h:mm:ss (or m:ss) of a duration. */
export function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** The label line over a Wanted character: "WANTED · 40,000". */
export function wantedLabel(bounty: number): string {
  return t('law.label', { bounty: formatNumber(bounty) })
}

/** "the West wall (W3)" with a capital T at a sentence start. */
const wallText = (id: string | undefined) => (id ? wallName(id) : t('law.someWall'))

/** The banner text of a law notice. */
export function lawNoticeText(m: Extract<ServerMessage, { t: 'lawNotice' }>): string {
  const wall = wallText(m.wall)
  const name = m.name ?? '?'
  const bounty = formatNumber(m.bounty ?? 0)
  switch (m.event) {
    case 'plant':
      return t('law.notice.plant', { wall })
    case 'wanted': {
      const head = t(m.treason ? 'law.notice.wantedTreason' : 'law.notice.wanted', { name, wall, bounty })
      return m.accomplices?.length ? `${head} ${t('law.notice.accomplices', { list: m.accomplices.join(', ') })}` : head
    }
    case 'defused':
      return t('law.notice.defused', { name, wall })
    case 'lapsed':
      return t('law.notice.lapsed', { name })
    case 'pardoned':
      return t('law.notice.pardoned', { name })
    case 'captured':
      return t('law.notice.captured', { name, bounty })
  }
}

/** The Wanted panel's lines for warrant `w` with `leftMs` of online time left. */
export function wantedLines(w: WantedView, leftMs: number): { head: string; bounty: string; lapse: string; note: string; warn: string } {
  const notes = [t('law.panel.offence', { n: w.offence })]
  if (w.role === 'accomplice') notes.push(t('law.panel.accomplice'))
  if (w.treason) notes.push(t('law.panel.treason'))
  return {
    // docs/JOBS.md §6.4: a robbery warrant reads ROBBER (WANTED stays the walls')
    head: w.robbery ? t('jobs.robber.label') : t('law.panel.head'),
    bounty: t('law.panel.bounty', { bounty: formatNumber(w.bounty) }),
    lapse: t('law.panel.lapse', { time: fmtLeft(leftMs) }),
    note: notes.join(' · '),
    warn: t('law.panel.hunters'),
  }
}

// ---- styles ----------------------------------------------------------------------------------------------------------

const CSS = `
.law-col { position: absolute; left: 8px; top: 118px; width: 250px; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
.law-wanted { position: relative; width: 250px; box-sizing: border-box; padding: 4px 9px 6px; pointer-events: none;
  background: linear-gradient(rgba(48, 6, 4, 0.9), rgba(18, 2, 2, 0.9)); border: 1px solid rgba(230, 70, 50, 0.8);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85), 0 0 12px rgba(255, 40, 20, 0.35); border-radius: 3px; text-shadow: 0 0 2px #000, 0 1px 1px #000; }
.law-wanted[hidden] { display: none; }
.law-wanted-head { font: 15px/19px var(--font-title); letter-spacing: 0.24em; color: #ff4a36; text-transform: uppercase; }
.law-wanted-bounty { font: 13px/17px var(--font-body); color: #ffd953; font-variant-numeric: tabular-nums; }
.law-wanted-lapse { font: 11px/15px var(--font-body); color: #f2dccb; font-variant-numeric: tabular-nums; }
.law-wanted-note { font: 10px/13px var(--font-body); color: #ff9c8a; }
.law-wanted-warn { font: 10px/13px var(--font-body); color: #ffd0c4; font-style: italic; }

.law-plant { position: absolute; left: 50%; bottom: 196px; transform: translateX(-50%); padding: 6px 12px 8px; text-align: center; pointer-events: auto; }
.law-plant[hidden] { display: none; }
.law-plant-line { font: 12px/16px var(--font-body); color: #ffd953; margin-bottom: 2px; }
.law-plant-hint { font: 10px/13px var(--font-body); color: #ff9c8a; margin-bottom: 5px; }

.law-fence-text { color: var(--c-text); font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); white-space: pre-wrap; }
.law-fence-note { color: #b9ad8f; font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); }
.law-fence-buttons { display: flex; justify-content: center; gap: 8px; }

.entity-label .label-line-wanted { color: #ff5a46; font-weight: bold; letter-spacing: 0.08em; text-shadow: 1px 0 1px #000, -1px 0 1px #000, 0 1px 1px #000, 0 -1px 1px #000, 0 0 6px rgba(255, 30, 10, 0.55); }
`

let injected = false
export function ensureLawStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  ensurePilotStyles()
  const s = document.createElement('style')
  s.dataset.sro = 'law'
  s.textContent = CSS
  document.head.append(s)
}

// ---- the Wanted panel ------------------------------------------------------------------------------------------------

export class WantedPanel {
  readonly root: HTMLElement
  private readonly head: HTMLElement
  private readonly bounty: HTMLElement
  private readonly lapse: HTMLElement
  private readonly note: HTMLElement
  private readonly warn: HTMLElement

  constructor() {
    ensureLawStyles()
    this.head = el('div', 'law-wanted-head')
    this.bounty = el('div', 'law-wanted-bounty')
    this.lapse = el('div', 'law-wanted-lapse')
    this.note = el('div', 'law-wanted-note')
    this.warn = el('div', 'law-wanted-warn')
    this.root = el('div', 'law-wanted', this.head, this.bounty, this.lapse, this.note, this.warn)
    this.root.hidden = true
  }

  set(w: WantedView | null, leftMs: number): void {
    if (!w) {
      this.root.hidden = true
      return
    }
    const l = wantedLines(w, leftMs)
    this.root.hidden = false
    this.head.textContent = l.head
    this.bounty.textContent = l.bounty
    this.lapse.textContent = l.lapse
    this.note.textContent = l.note
    this.warn.textContent = l.warn
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }
}

// ---- the plant prompt --------------------------------------------------------------------------------------------------

export class PlantPrompt {
  readonly root: HTMLElement
  private readonly line: HTMLElement

  constructor(art: Art, onPlant: () => void) {
    ensureLawStyles()
    this.line = el('div', 'law-plant-line')
    const hint = el('div', 'law-plant-hint', t('law.plantHint'))
    this.root = el('div', 'law-plant pl-panel', this.line, hint, button(art, { label: t('law.plantButton'), primary: true, minWidth: 140 }, onPlant))
    this.root.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    this.root.hidden = true
  }

  /** Hidden (null) or the segment a keg would go to. */
  set(seg: string | null): void {
    this.root.hidden = seg === null
    if (seg) this.line.textContent = t('law.plant', { wall: wallName(seg) })
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }
}

// ---- Old Fang's window -------------------------------------------------------------------------------------------------

export interface FenceTerms {
  gold: number
  saltpeter: number
  carry: number
  fuseSec: number
  damagePct: number
  minLevel: number
  minPlayHours: number
  cooldownMin: number
}

export const FENCE_W = 386
export const FENCE_H = 300

export class FenceWindow extends NpcWindow {
  private readonly text: HTMLElement
  private readonly carry: HTMLElement
  private readonly rules: HTMLElement
  private readonly craftBtn: ReturnType<typeof button>
  onCraft: (() => void) | null = null
  onBack: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement) {
    ensureNpcStyles()
    ensureLawStyles()
    super(art, parent, { id: 'fence', title: t('fence.title'), width: FENCE_W, height: FENCE_H, at: [0.36, 0.24] })
    const talk = new Frame(art, 'talk', { at: this.r([11, 46, 364, 140]), inset: [8, 10, 8, 10] })
    this.text = el('div', 'law-fence-text')
    talk.body.append(this.text)
    this.carry = this.at(el('div', 'law-fence-note'), [20, 194, 346, 16])
    this.rules = this.at(el('div', 'law-fence-note'), [20, 212, 346, 30])
    this.craftBtn = button(art, { label: t('fence.craft'), primary: true, minWidth: 110 }, () => this.onCraft?.())
    const back = button(art, { label: t('fence.back'), minWidth: 90 }, () => this.onBack?.())
    const buttons = this.at(el('div', 'law-fence-buttons', this.craftBtn, back), [11, 256, 364, 28])
    this.body.append(talk.root, this.carry, this.rules, buttons)
  }

  show(terms: FenceTerms, have: { gold: number; saltpeter: number; kegs: number }): void {
    this.update(terms, have)
    this.open()
    this.raise()
  }

  update(terms: FenceTerms, have: { gold: number; saltpeter: number; kegs: number }): void {
    this.text.textContent = t('fence.text', { gold: formatNumber(terms.gold), saltpeter: terms.saltpeter, fuse: terms.fuseSec, pct: terms.damagePct })
    this.carry.textContent = t('fence.carry', { gold: formatNumber(have.gold), saltpeter: have.saltpeter, kegs: have.kegs, max: terms.carry })
    this.rules.textContent = t('fence.rules', { level: terms.minLevel, hours: terms.minPlayHours, min: terms.cooldownMin })
    const can = have.gold >= terms.gold && have.saltpeter >= terms.saltpeter && have.kegs < terms.carry
    this.craftBtn.setDisabled(!can)
  }
}

// ---- layer 6: Hunters and the jail (docs/SIEGE.md §8.2-§8.5, §9.3) ---------------------------------------------------

/** "Tracker" for rank 1 (0: a recruit). */
export function hunterRankName(rank: number): string {
  return t(`hunter.rank.${Math.max(0, Math.min(6, Math.floor(rank)))}` as 'hunter.rank.0')
}

/** The badge line over an on-duty Bounty Hunter: "BOUNTY HUNTER · Tracker". */
export function hunterLabel(rank: number): string {
  return t('hunter.label', { rank: hunterRankName(rank) })
}

/** The prisoner's panel lines. */
export function jailLines(j: JailView, leftMs: number, choreMin: number): { head: string; left: string; note: string; chores: string } {
  return {
    head: t('jail.panel.head'),
    left: t('jail.panel.left', { time: fmtLeft(leftMs) }),
    note: t('jail.panel.offence', { n: j.offence, clock: t(j.clock === 'online' ? 'jail.panel.clock.online' : 'jail.panel.clock.real') }),
    chores: j.choresLeft <= 0 ? t('jail.panel.choresDone', { n: j.chores }) : j.chores === 0 ? t('jail.panel.choresNone', { min: choreMin }) : t('jail.panel.chores', { n: j.chores, min: j.chores * choreMin }),
  }
}

/** The capture banner for the captor or the prisoner. */
export function captureText(m: Extract<ServerMessage, { t: 'lawCapture' }>): string {
  if (m.prisoner) return t('law.capture.prisoner', { captors: m.captors?.length ? m.captors.join(', ') : '?', time: fmtLeft(m.sentenceMs) })
  if (m.rule && m.rule !== 'daily_cap' && m.rule !== 'repeat' && m.gold === 0) return t(`law.capture.rule.${m.rule}` as 'law.capture.rule.pair', { name: m.name })
  if (m.rule === 'repeat' || m.rule === 'daily_cap') return `${t('law.capture.captor', { name: m.name, gold: formatNumber(m.gold), bounty: formatNumber(m.bounty) })} ${t(`law.capture.rule.${m.rule}` as 'law.capture.rule.repeat', { name: m.name })}`
  return t('law.capture.captor', { name: m.name, gold: formatNumber(m.gold), bounty: formatNumber(m.bounty) })
}

const CSS6 = `
.law-hunter, .law-jail { position: relative; width: 250px; box-sizing: border-box; padding: 4px 9px 7px; pointer-events: auto; border-radius: 3px; text-shadow: 0 0 2px #000, 0 1px 1px #000; }
.law-hunter { background: linear-gradient(rgba(6, 22, 48, 0.9), rgba(2, 8, 20, 0.9)); border: 1px solid rgba(90, 160, 255, 0.75); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85), 0 0 12px rgba(60, 140, 255, 0.3); }
.law-jail { background: linear-gradient(rgba(34, 30, 24, 0.92), rgba(14, 12, 10, 0.92)); border: 1px solid rgba(190, 170, 130, 0.75); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85), 0 0 10px rgba(0, 0, 0, 0.5); }
.law-hunter[hidden], .law-jail[hidden] { display: none; }
.law-hunter-head { font: 12px/19px var(--font-title); letter-spacing: 0.1em; color: #7ab8ff; text-transform: uppercase; }
.law-hunter.off .law-hunter-head { color: #9aa8bc; }
.law-hunter-line { font: 12px/16px var(--font-body); color: #dfe9f7; }
.law-hunter-note { font: 10px/13px var(--font-body); color: #9cc4f0; }
.law-hunter-buttons, .law-jail-buttons { display: flex; gap: 6px; margin-top: 5px; }
.law-jail-head { font: 14px/19px var(--font-title); letter-spacing: 0.18em; color: #e8d6a8; text-transform: uppercase; }
.law-jail-left { font: 17px/22px var(--font-body); color: #fff1cc; font-variant-numeric: tabular-nums; }
.law-jail-note { font: 10px/13px var(--font-body); color: #c8b994; }
.law-jail-chores { font: 11px/15px var(--font-body); color: #e6dcc2; }
.law-jail-hint { font: 10px/13px var(--font-body); color: #a99c7c; font-style: italic; margin-top: 3px; }
.law-jail-hint[hidden] { display: none; }
.law-jail-bar { height: 6px; margin-top: 5px; background: rgba(0, 0, 0, 0.6); border: 1px solid rgba(190, 170, 130, 0.6); }
.law-jail-bar[hidden] { display: none; }
.law-jail-fill { height: 100%; background: linear-gradient(90deg, #a07a3a, #f0d08a); transform-origin: left; }
.law-yun-text { color: var(--c-text); font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); white-space: pre-wrap; }
.law-yun-note { color: #b9ad8f; font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); }
.law-yun-status { color: #9cc4f0; font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); }
.entity-label .label-line-hunter { color: #7ab8ff; font-weight: bold; letter-spacing: 0.04em; text-shadow: 1px 0 1px #000, -1px 0 1px #000, 0 1px 1px #000, 0 -1px 1px #000, 0 0 6px rgba(40, 120, 255, 0.55); }
.entity-label .label-line-jailed { color: #d8c8a0; letter-spacing: 0.12em; text-shadow: 1px 0 1px #000, -1px 0 1px #000, 0 1px 1px #000, 0 -1px 1px #000; }
`

let injected6 = false
function ensureHunterStyles(): void {
  ensureLawStyles()
  if (injected6 || typeof document === 'undefined') return
  injected6 = true
  const s = document.createElement('style')
  s.dataset.sro = 'law-hunter'
  s.textContent = CSS6
  document.head.append(s)
}

/** The left column under the character frame that holds the Wanted, Hunter and Stockade panels. */
export function lawColumn(...panels: HTMLElement[]): HTMLElement {
  ensureHunterStyles()
  return el('div', 'law-col', ...panels)
}

/** The Hunter's own panel: duty, rank and captures, the Wanted online, the Net. */
export class HunterPanel {
  readonly root: HTMLElement
  private readonly head: HTMLElement
  private readonly rank: HTMLElement
  private readonly note: HTMLElement
  private readonly duty: ReturnType<typeof button>
  private readonly net: ReturnType<typeof button>
  onDuty: ((on: boolean) => void) | null = null
  onNet: (() => void) | null = null
  private on = false

  constructor(art: Art) {
    ensureHunterStyles()
    this.head = el('div', 'law-hunter-head')
    this.rank = el('div', 'law-hunter-line')
    this.note = el('div', 'law-hunter-note')
    this.duty = button(art, { label: t('hunter.duty.on'), minWidth: 100 }, () => this.onDuty?.(!this.on))
    this.net = button(art, { label: t('hunter.panel.net'), minWidth: 90 }, () => this.onNet?.())
    this.root = el('div', 'law-hunter', this.head, this.rank, this.note, el('div', 'law-hunter-buttons', this.duty, this.net))
    this.root.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    this.root.hidden = true
  }

  /** `wanted`: Wanted players the client knows of; `net`: whether a Net can fly now (null: none), its wait, Nets carried. */
  set(h: HunterView | null, now: number, wanted: number, net: { can: boolean; waitMs: number; have: number } | null): void {
    if (!h || !h.licensed) {
      this.root.hidden = true
      return
    }
    this.root.hidden = false
    this.on = h.onDuty
    this.root.classList.toggle('off', !h.onDuty)
    this.head.textContent = t(h.onDuty ? 'hunter.panel.head' : 'hunter.panel.offHead')
    this.rank.textContent = t('hunter.panel.rank', { rank: hunterRankName(h.rank), captures: h.captures })
    const lock = h.lockUntil !== undefined ? h.lockUntil - now : 0
    this.note.textContent = h.onDuty && lock > 0 ? t('hunter.panel.lock', { time: fmtLeft(lock) }) : wanted > 0 ? t('hunter.panel.wanted', { n: wanted }) : t('hunter.panel.none')
    this.duty.setLabel(t(h.onDuty ? 'hunter.duty.off' : 'hunter.duty.on'))
    this.duty.setDisabled(h.onDuty && lock > 0)
    this.net.hidden = !h.onDuty || !net || net.have <= 0
    if (net) {
      this.net.setLabel(net.waitMs > 0 ? t('hunter.panel.netWait', { time: fmtLeft(net.waitMs) }) : `${t('hunter.panel.net')} (${net.have})`)
      this.net.setDisabled(!net.can || net.waitMs > 0)
    }
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }
}

/** The prisoner's panel: "Garrison Stockade · 1:47:33 left · offence 2", the chores and their button. */
export class JailPanel {
  readonly root: HTMLElement
  private readonly head: HTMLElement
  private readonly left: HTMLElement
  private readonly note: HTMLElement
  private readonly chores: HTMLElement
  private readonly hint: HTMLElement
  private readonly bar: HTMLElement
  private readonly fill: HTMLElement
  private readonly btn: ReturnType<typeof button>
  onChore: (() => void) | null = null

  constructor(art: Art) {
    ensureHunterStyles()
    this.head = el('div', 'law-jail-head')
    this.left = el('div', 'law-jail-left')
    this.note = el('div', 'law-jail-note')
    this.chores = el('div', 'law-jail-chores')
    this.hint = el('div', 'law-jail-hint')
    this.fill = el('div', 'law-jail-fill')
    this.bar = el('div', 'law-jail-bar', this.fill)
    this.btn = button(art, { label: t('jail.panel.break'), primary: true, minWidth: 110 }, () => this.onChore?.())
    this.root = el('div', 'law-jail', this.head, this.left, this.note, this.chores, this.bar, el('div', 'law-jail-buttons', this.btn), this.hint)
    this.root.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    this.root.hidden = true
  }

  /** `chore`: the running chore's progress 0..1 (null: none); `atPile`: standing at the rock pile. */
  set(j: JailView | null, leftMs: number, choreMin: number, chore: number | null, atPile: boolean): void {
    if (!j) {
      this.root.hidden = true
      return
    }
    const l = jailLines(j, leftMs, choreMin)
    this.root.hidden = false
    this.head.textContent = l.head
    this.left.textContent = l.left
    this.note.textContent = l.note
    this.chores.textContent = l.chores
    this.bar.hidden = chore === null
    if (chore !== null) this.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, chore))})`
    this.btn.hidden = chore !== null || j.choresLeft <= 0
    this.btn.setDisabled(!atPile)
    this.hint.textContent = chore !== null ? t('jail.panel.breaking') : j.choresLeft > 0 && !atPile ? t('jail.panel.goPile') : ''
    this.hint.hidden = !this.hint.textContent
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }
}

export interface YunTerms {
  licenceGold: number
  minLevel: number
  cleanDays: number
  offDutyLockMin: number
  bountyBase: number
}

export const YUN_W = 400
export const YUN_H = 316

/** Captain Yun's window: the licence, the duty. */
export class YunWindow extends NpcWindow {
  private readonly text: HTMLElement
  private readonly status: HTMLElement
  private readonly rules: HTMLElement
  private readonly buyBtn: ReturnType<typeof button>
  private readonly dutyBtn: ReturnType<typeof button>
  private hunter: HunterView | null = null
  onBuy: (() => void) | null = null
  onDuty: ((on: boolean) => void) | null = null
  onBack: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement) {
    ensureNpcStyles()
    ensureHunterStyles()
    super(art, parent, { id: 'yun', title: t('yun.title'), width: YUN_W, height: YUN_H, at: [0.36, 0.22] })
    const talk = new Frame(art, 'talk', { at: this.r([11, 46, 378, 150]), inset: [8, 10, 8, 10] })
    this.text = el('div', 'law-yun-text')
    talk.body.append(this.text)
    this.status = this.at(el('div', 'law-yun-status'), [20, 204, 360, 18])
    this.rules = this.at(el('div', 'law-yun-note'), [20, 224, 360, 44])
    this.buyBtn = button(art, { label: t('yun.buy'), primary: true, minWidth: 120 }, () => this.onBuy?.())
    this.dutyBtn = button(art, { label: t('yun.dutyOn'), primary: true, minWidth: 110 }, () => this.onDuty?.(!(this.hunter?.onDuty ?? false)))
    const back = button(art, { label: t('yun.back'), minWidth: 90 }, () => this.onBack?.())
    const buttons = this.at(el('div', 'law-fence-buttons', this.buyBtn, this.dutyBtn, back), [11, 274, 378, 28])
    this.body.append(talk.root, this.status, this.rules, buttons)
  }

  show(terms: YunTerms, hunter: HunterView | null, gold: number, now: number): void {
    this.update(terms, hunter, gold, now)
    this.open()
    this.raise()
  }

  update(terms: YunTerms, hunter: HunterView | null, gold: number, now: number): void {
    this.hunter = hunter
    this.text.textContent = t('yun.text', { bounty: formatNumber(terms.bountyBase), gold: formatNumber(terms.licenceGold), level: terms.minLevel, days: terms.cleanDays })
    this.rules.textContent = t('yun.rules', { min: terms.offDutyLockMin })
    if (!hunter) this.status.textContent = t('yun.status.none')
    else if (!hunter.licensed) this.status.textContent = t('yun.status.revoked', { date: new Date(hunter.revokedUntil ?? now).toISOString().slice(0, 10) })
    else this.status.textContent = t('yun.status.licensed', { rank: hunterRankName(hunter.rank), captures: hunter.captures, duty: t(hunter.onDuty ? 'hunter.onDuty' : 'hunter.offDuty') })
    this.buyBtn.hidden = !!hunter
    this.buyBtn.setDisabled(gold < terms.licenceGold)
    this.dutyBtn.hidden = !hunter?.licensed
    this.dutyBtn.setLabel(t(hunter?.onDuty ? 'yun.dutyOff' : 'yun.dutyOn'))
  }
}

export const WARDEN_W = 380
export const WARDEN_H = 270

/** Warden Bae's window: the prisoner's sentence and the rules, or who sits inside. */
export class WardenWindow extends NpcWindow {
  private readonly text: HTMLElement
  private readonly rules: HTMLElement
  onBack: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement) {
    ensureNpcStyles()
    ensureHunterStyles()
    super(art, parent, { id: 'warden', title: t('warden.title'), width: WARDEN_W, height: WARDEN_H, at: [0.38, 0.26] })
    const talk = new Frame(art, 'talk', { at: this.r([11, 46, 358, 140]), inset: [8, 10, 8, 10] })
    this.text = el('div', 'law-yun-text')
    talk.body.append(this.text)
    this.rules = this.at(el('div', 'law-yun-note'), [20, 194, 340, 30])
    const back = button(art, { label: t('warden.back'), minWidth: 90 }, () => this.onBack?.())
    const buttons = this.at(el('div', 'law-fence-buttons', back), [11, 228, 358, 28])
    this.body.append(talk.root, this.rules, buttons)
  }

  show(jail: JailView | null, leftMs: number, inside: string[]): void {
    this.update(jail, leftMs, inside)
    this.open()
    this.raise()
  }

  update(jail: JailView | null, leftMs: number, inside: string[]): void {
    this.text.textContent = jail
      ? t('warden.prisoner', { sentence: fmtLeft(jail.sentenceMs), n: jail.offence, left: fmtLeft(leftMs) })
      : inside.length
        ? t('warden.visitor.some', { list: inside.join(', ') })
        : t('warden.visitor.none')
    this.rules.textContent = t('warden.rules')
  }
}
