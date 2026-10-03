/**
 * The exchange request popup of lane TR-C (docs/SYSTEMS_SOCIAL.md §9.2): "{name} (Lv {level}) applied for an exchange.
 * Will you accept it?" with Accept, Decline and a countdown (the party-invite.ts pattern). It does not block the game
 * (no modal shade); the feature closes it on the answer, when the exchange opens or ends, or when the countdown runs
 * out. The DOM-free parts (`PendingTrade`, the text) live in trade-state.ts.
 */
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, Listeners } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { Gauge } from '../ui/kit/gauge.ts'
import { requestLine, tradeSecondsLeft, type PendingTrade } from './trade-state.ts'

const CSS = `
.hud-trade-request {
  position: absolute; left: calc(50% - 150px); top: 30%; width: 300px; height: 140px;
  pointer-events: auto; color: var(--c-text); z-index: 9000;
}
.hud-trade-request[hidden] { display: none; }
.hud-trade-request .htr-title { position: absolute; left: 16px; right: 16px; top: 0; height: 30px; line-height: 30px; text-align: center; }
.hud-trade-request .htr-text { position: absolute; left: 18px; right: 18px; top: 38px; text-align: center; }
.hud-trade-request .htr-gauge { position: absolute; left: 58px; top: 78px; }
.hud-trade-request .htr-timer { position: absolute; left: 0; right: 0; top: 87px; text-align: center; color: var(--c-level); font: 10px/12px var(--font-body); text-shadow: var(--t-outline); }
.hud-trade-request .htr-timer.low { color: var(--c-bad); }
.hud-trade-request .htr-buttons { position: absolute; left: 0; right: 0; bottom: 12px; display: flex; justify-content: center; gap: 8px; }
`

let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-trade-request'
  style.textContent = CSS
  document.head.append(style)
}

/** The popup: the kit `msgbox2_window_` dialog frame, the request line, the countdown gauge, Accept / Decline. */
export class TradeRequestPopup {
  readonly root: HTMLElement
  private readonly text: HTMLElement
  private readonly timer: HTMLElement
  private readonly gauge: Gauge
  private readonly ls = new Listeners()
  private current: PendingTrade | null = null
  private shownSeconds = -1
  private totalSeconds = 1

  constructor(art: Art, parent: HTMLElement, private readonly answer: (accept: boolean) => void) {
    ensureStyles()
    this.text = el('div')
    this.timer = el('div', 'htr-timer')
    this.gauge = new Gauge(art, 'cast', { color: 'var(--c-level)', className: 'htr-gauge' })
    const accept = button(art, { label: t('trade.accept'), primary: true }, () => this.answer(true))
    const decline = button(art, { label: t('trade.decline') }, () => this.answer(false))
    const box = new Frame(art, 'dialog', { w: 300, h: 140, inset: [0, 0, 0, 0] })
    box.root.append(el('div', 'htr-title kit-t-title', t('trade.requestHeader')), el('div', 'htr-text kit-t-body', this.text), this.gauge.root, this.timer, el('div', 'htr-buttons', accept, decline))
    this.root = el('div', 'hud-trade-request hud-block', box.root)
    this.root.hidden = true
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', t('trade.requestHeader'))
    this.ls.on(this.root, 'pointerdown', ev => ev.stopPropagation())
    this.ls.on(this.root, 'contextmenu', ev => ev.preventDefault())
    parent.append(this.root)
  }

  get request(): PendingTrade | null {
    return this.current
  }

  show(req: PendingTrade, now: number): void {
    this.current = req
    this.text.textContent = requestLine(req)
    this.shownSeconds = -1
    this.totalSeconds = Math.max(1, tradeSecondsLeft(req, now))
    this.root.hidden = false
    this.tick(now)
  }

  /** Updates the countdown. */
  tick(now: number): void {
    if (!this.current) return
    const s = tradeSecondsLeft(this.current, now)
    if (s === this.shownSeconds) return
    this.shownSeconds = s
    this.timer.textContent = t('trade.timer', { seconds: s })
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
