/**
 * Siege of Jangan, layer 5 HUD pieces (docs/SIEGE.md §9.3): the Wanted panel (your own warrant: the bounty, the online
 * time left before it lapses, treason), the keg prompt (Plant a Thunder Keg here, at the outer foot of the wall) and
 * Old Fang's window (craft a keg). DOM only: the state comes from world/features/law.ts; the text helpers here are
 * DOM-free (`wantedLines`, `lawNoticeText`, `wantedLabel`). The panels use Play the Boss's look (`pl-panel`).
 *
 * The Wanted panel sits on the left under the character's frame (top 118, left 8), out of the siege panel's column
 * (right) and the banners (top centre); the plant prompt sits over the hotbar, above the Defuse prompt's spot.
 */
import { wallName, type ServerMessage, type WantedView } from '@sro/shared'
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
export function wantedLines(w: WantedView, leftMs: number): { head: string; bounty: string; lapse: string; note: string } {
  const notes = [t('law.panel.offence', { n: w.offence })]
  if (w.role === 'accomplice') notes.push(t('law.panel.accomplice'))
  if (w.treason) notes.push(t('law.panel.treason'))
  return {
    head: t('law.panel.head'),
    bounty: t('law.panel.bounty', { bounty: formatNumber(w.bounty) }),
    lapse: t('law.panel.lapse', { time: fmtLeft(leftMs) }),
    note: notes.join(' · '),
  }
}

// ---- styles ----------------------------------------------------------------------------------------------------------

const CSS = `
.law-wanted { position: absolute; left: 8px; top: 118px; width: 250px; box-sizing: border-box; padding: 4px 9px 6px; pointer-events: none;
  background: linear-gradient(rgba(48, 6, 4, 0.9), rgba(18, 2, 2, 0.9)); border: 1px solid rgba(230, 70, 50, 0.8);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85), 0 0 12px rgba(255, 40, 20, 0.35); border-radius: 3px; text-shadow: 0 0 2px #000, 0 1px 1px #000; }
.law-wanted[hidden] { display: none; }
.law-wanted-head { font: 15px/19px var(--font-title); letter-spacing: 0.24em; color: #ff4a36; text-transform: uppercase; }
.law-wanted-bounty { font: 13px/17px var(--font-body); color: #ffd953; font-variant-numeric: tabular-nums; }
.law-wanted-lapse { font: 11px/15px var(--font-body); color: #f2dccb; font-variant-numeric: tabular-nums; }
.law-wanted-note { font: 10px/13px var(--font-body); color: #ff9c8a; }

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

  constructor() {
    ensureLawStyles()
    this.head = el('div', 'law-wanted-head')
    this.bounty = el('div', 'law-wanted-bounty')
    this.lapse = el('div', 'law-wanted-lapse')
    this.note = el('div', 'law-wanted-note')
    this.root = el('div', 'law-wanted', this.head, this.bounty, this.lapse, this.note)
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
