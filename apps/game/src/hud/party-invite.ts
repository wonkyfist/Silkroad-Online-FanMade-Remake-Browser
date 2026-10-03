/**
 * The party invitation popup (docs/QUESTS.md §4.5; lane PT-C): "{name} (Lv {level}) invites you to a party. EXP: {exp}.
 * Items: {items}." with Accept, Decline and a countdown. It does not block the game (no modal shade); the feature closes
 * it on the answer, on `partyEvent 'expired'`, or when the countdown runs out.
 *
 * `PendingInvite` and the text helpers are DOM-free (tests); InvitePopup is the DOM part.
 */
import type { PartyExpMode, PartyItemMode, ServerMessage } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, Listeners } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { Gauge } from '../ui/kit/gauge.ts'
import { ensurePartyStyles, modeLabel } from './party.ts'

export type PartyInvitedMessage = Extract<ServerMessage, { t: 'partyInvited' }>

export interface PendingInvite {
  /** The inviter's entity id (answer with partyRespond {inviter}). */
  inviter: number
  name: string
  level: number
  exp: PartyExpMode
  items: PartyItemMode
  /** Local ms (performance.now clock of the caller) when the server drops it. */
  expiresAt: number
}

export function pendingInvite(msg: PartyInvitedMessage, now: number): PendingInvite {
  return { inviter: msg.inviter, name: msg.name, level: msg.level, exp: msg.exp, items: msg.items, expiresAt: now + Math.max(0, msg.expiresInMs) }
}

/** Whole seconds left (rounded up), never below 0. */
export function secondsLeft(inv: PendingInvite, now: number): number {
  return Math.max(0, Math.ceil((inv.expiresAt - now) / 1000))
}

/** The popup's two lines. */
export function inviteLines(inv: PendingInvite): [string, string] {
  return [
    t('party.invited', { name: inv.name, level: inv.level }),
    t('party.invitedModes', { exp: modeLabel('exp', inv.exp), items: modeLabel('items', inv.items) }),
  ]
}

const CSS = `
.hud-party-invite {
  position: absolute; left: calc(50% - 150px); top: 22%; width: 300px; height: 150px;
  pointer-events: auto; color: var(--c-text); z-index: 9000;
}
.hud-party-invite[hidden] { display: none; }
.hud-party-invite .hpi-title { position: absolute; left: 16px; right: 16px; top: 0; height: 30px; line-height: 30px; text-align: center; }
.hud-party-invite .hpi-text { position: absolute; left: 18px; right: 18px; top: 40px; text-align: center; }
.hud-party-invite .hpi-text .name { color: var(--c-party-name); }
.hud-party-invite .hpi-modes { color: var(--c-label); font-size: 11px; }
.hud-party-invite .hpi-gauge { position: absolute; left: 58px; top: 88px; }
.hud-party-invite .hpi-timer { position: absolute; left: 0; right: 0; top: 97px; text-align: center; color: var(--c-level); font: 10px/12px var(--font-body); text-shadow: var(--t-outline); }
.hud-party-invite .hpi-timer.low { color: var(--c-bad); }
.hud-party-invite .hpi-buttons { position: absolute; left: 0; right: 0; bottom: 14px; display: flex; justify-content: center; gap: 8px; }
`

let injected = false
function ensureStyles(): void {
  ensurePartyStyles()
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-party-invite'
  style.textContent = CSS
  document.head.append(style)
}

/**
 * The popup (docs/UI.md §4.6 message boxes): the kit `msgbox2_window_` dialog with its title strip, the invitation
 * lines, the countdown on the retail `com_casting_gauge_skill` gauge, and Accept / Decline.
 */
export class InvitePopup {
  readonly root: HTMLElement
  private readonly text: HTMLElement
  private readonly modes: HTMLElement
  private readonly timer: HTMLElement
  private readonly gauge: Gauge
  private readonly ls = new Listeners()
  private current: PendingInvite | null = null
  private shownSeconds = -1
  private totalSeconds = 1

  constructor(art: Art, parent: HTMLElement, private readonly answer: (accept: boolean) => void) {
    ensureStyles()
    this.text = el('div')
    this.modes = el('div', 'hpi-modes')
    this.timer = el('div', 'hpi-timer')
    this.gauge = new Gauge(art, 'cast', { color: 'var(--c-level)', className: 'hpi-gauge' })
    const accept = button(art, { label: t('party.accept'), primary: true }, () => this.answer(true))
    const decline = button(art, { label: t('party.decline') }, () => this.answer(false))
    const box = new Frame(art, 'dialog', { w: 300, h: 150, inset: [0, 0, 0, 0] })
    box.root.append(el('div', 'hpi-title kit-t-title', t('party.inviteHeader')), el('div', 'hpi-text kit-t-body', this.text, this.modes), this.gauge.root, this.timer, el('div', 'hpi-buttons', accept, decline))
    this.root = el('div', 'hud-party-invite hud-block', box.root)
    this.root.hidden = true
    this.ls.on(this.root, 'pointerdown', ev => ev.stopPropagation())
    this.ls.on(this.root, 'contextmenu', ev => ev.preventDefault())
    parent.append(this.root)
  }

  get invite(): PendingInvite | null {
    return this.current
  }

  show(inv: PendingInvite, now: number): void {
    this.current = inv
    const [line, modes] = inviteLines(inv)
    this.text.textContent = line
    this.modes.textContent = modes
    this.shownSeconds = -1
    this.totalSeconds = Math.max(1, secondsLeft(inv, now))
    this.root.hidden = false
    this.tick(now)
  }

  /** Updates the countdown. */
  tick(now: number): void {
    if (!this.current) return
    const s = secondsLeft(this.current, now)
    if (s === this.shownSeconds) return
    this.shownSeconds = s
    this.timer.textContent = t('party.inviteTimer', { seconds: s })
    this.timer.classList.toggle('low', s <= 5)
    this.gauge.set(s, this.totalSeconds)
  }

  hide(): void {
    this.current = null
    this.root.hidden = true
  }

  dispose(): void {
    this.ls.clear()
    this.root.remove()
  }
}
