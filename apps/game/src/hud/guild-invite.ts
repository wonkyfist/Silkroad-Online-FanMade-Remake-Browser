/**
 * The guild invitation popup of lane GU-C (docs/SYSTEMS_SOCIAL.md §9.4): "{from} invites you to join the {name} guild."
 * with Accept, Decline and a 30 s countdown (the party-invite.ts pattern: the kit `msgbox2_window_` dialog frame, the
 * retail `com_casting_gauge_skill` gauge). It does not block the game (no modal shade); the feature closes it on the
 * answer, on the server's 'expired' line, or when the countdown runs out. The DOM-free parts live in guild-state.ts.
 */
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, Listeners } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { Gauge } from '../ui/kit/gauge.ts'
import { inviteLine, inviteSecondsLeft, type PendingGuildInvite } from './guild-state.ts'

const CSS = `
.hud-guild-invite {
  position: absolute; left: calc(50% - 150px); top: 26%; width: 300px; height: 140px;
  pointer-events: auto; color: var(--c-text); z-index: 9000;
}
.hud-guild-invite[hidden] { display: none; }
.hud-guild-invite .hgi-title { position: absolute; left: 16px; right: 16px; top: 0; height: 30px; line-height: 30px; text-align: center; }
.hud-guild-invite .hgi-text { position: absolute; left: 18px; right: 18px; top: 38px; text-align: center; white-space: normal; }
.hud-guild-invite .hgi-gauge { position: absolute; left: 58px; top: 78px; }
.hud-guild-invite .hgi-timer { position: absolute; left: 0; right: 0; top: 87px; text-align: center; color: var(--c-level); font: 10px/12px var(--font-body); text-shadow: var(--t-outline); }
.hud-guild-invite .hgi-timer.low { color: var(--c-bad); }
.hud-guild-invite .hgi-buttons { position: absolute; left: 0; right: 0; bottom: 12px; display: flex; justify-content: center; gap: 8px; }
`

let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-guild-invite'
  style.textContent = CSS
  document.head.append(style)
}

export class GuildInvitePopup {
  readonly root: HTMLElement
  private readonly text: HTMLElement
  private readonly timer: HTMLElement
  private readonly gauge: Gauge
  private readonly ls = new Listeners()
  private current: PendingGuildInvite | null = null
  private shownSeconds = -1
  private totalSeconds = 1

  constructor(art: Art, parent: HTMLElement, private readonly answer: (accept: boolean) => void) {
    ensureStyles()
    this.text = el('div')
    this.timer = el('div', 'hgi-timer')
    this.gauge = new Gauge(art, 'cast', { color: 'var(--c-level)', className: 'hgi-gauge' })
    const accept = button(art, { label: t('guild.accept'), primary: true }, () => this.answer(true))
    const decline = button(art, { label: t('guild.decline') }, () => this.answer(false))
    const box = new Frame(art, 'dialog', { w: 300, h: 140, inset: [0, 0, 0, 0] })
    box.root.append(el('div', 'hgi-title kit-t-title', t('guild.invitedHeader')), el('div', 'hgi-text kit-t-body', this.text), this.gauge.root, this.timer, el('div', 'hgi-buttons', accept, decline))
    this.root = el('div', 'hud-guild-invite hud-block', box.root)
    this.root.hidden = true
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', t('guild.invitedHeader'))
    this.ls.on(this.root, 'pointerdown', ev => ev.stopPropagation())
    this.ls.on(this.root, 'contextmenu', ev => ev.preventDefault())
    parent.append(this.root)
  }

  get invite(): PendingGuildInvite | null {
    return this.current
  }

  show(inv: PendingGuildInvite, now: number): void {
    this.current = inv
    this.text.textContent = inviteLine(inv)
    this.shownSeconds = -1
    this.totalSeconds = Math.max(1, inviteSecondsLeft(inv, now))
    this.root.hidden = false
    this.tick(now)
  }

  /** Updates the countdown. */
  tick(now: number): void {
    if (!this.current) return
    const s = inviteSecondsLeft(this.current, now)
    if (s === this.shownSeconds) return
    this.shownSeconds = s
    this.timer.textContent = t('guild.inviteTimer', { seconds: s })
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
