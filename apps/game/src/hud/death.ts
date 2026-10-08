/**
 * Death overlay: the screen desaturates (body.hud-dead) and the resurrection box appears (docs/UI.md §4.6 message
 * boxes): the kit `msgbox2_window_` dialog frame with its title strip, the rebirth picture `messagebox/msgbox_rebirth`
 * and the rebirth button art `msgbox_rebirth_button` (176×24), with live English text. The button runs the caller's
 * respawn (it sends `respawn`); the overlay stays until the caller hides it, when the server has revived the character.
 * The Climb (docs/CLIMB.md §6.1): a line under the text tells what the death cost (`deathPenalty`) and counts the grace
 * window down.
 */
import type { DeathPenaltyOutcome } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button, type KitButton } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { FRAMES } from '../ui/kit/skins.ts'

export const DEATH_W = 300
export const DEATH_H = 230

export class DeathOverlay {
  readonly root: HTMLElement
  private readonly button: KitButton
  private onRespawn: (() => void) | null = null
  private readonly penaltyLine: HTMLElement
  private penalty: { outcome: DeathPenaltyOutcome; exp: number; pct: number; graceEnd: number } | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(art: Art) {
    const box = new Frame(art, 'dialog', { w: DEATH_W, h: DEATH_H, className: 'hud-death-box hud-block', inset: [0, 0, 0, 0] })
    const title = el('div', 'hud-death-title kit-t-title', t('hud.death.title'))
    title.style.height = title.style.lineHeight = `${FRAMES.dialog.title}px`
    const picture = el('div', 'hud-death-picture')
    if (art.has('messagebox/msgbox_rebirth')) picture.style.backgroundImage = art.cssUrl('messagebox/msgbox_rebirth')
    else picture.hidden = true
    this.button = button(art, { label: t('hud.death.respawn'), skin: { key: 'messagebox/msgbox_rebirth_button', w: 176, h: 24, slice: 8 }, width: 176, primary: true, className: 'hud-death-button' }, () => {
      if (this.button.isDisabled || !this.onRespawn) return
      this.button.setDisabled(true)
      this.button.setLabel(t('hud.death.waiting'))
      this.onRespawn()
    })
    this.penaltyLine = el('div', 'hud-death-penalty kit-t-body')
    box.root.append(title, picture, el('div', 'hud-death-body kit-t-body', t('hud.death.body')), this.penaltyLine, this.button)
    this.root = el('div', 'hud-death', box.root)
    this.root.hidden = true
  }

  get shown(): boolean {
    return !this.root.hidden
  }

  show(onRespawn: () => void): void {
    this.onRespawn = onRespawn
    this.button.setDisabled(false)
    this.button.setLabel(t('hud.death.respawn'))
    this.root.hidden = false
    document.body.classList.add('hud-dead')
  }

  /** The server's deathPenalty for this death (arrives just after the death; kept until hide). */
  setPenalty(outcome: DeathPenaltyOutcome, exp: number, pct: number, graceMs: number, fmt: (n: number) => string): void {
    if (outcome === 'refund') return
    this.penalty = { outcome, exp, pct, graceEnd: Date.now() + graceMs }
    this.fmt = fmt
    this.renderPenalty()
    if (this.timer === null && graceMs > 0) this.timer = setInterval(() => this.renderPenalty(), 1000)
  }

  private fmt: (n: number) => string = (n) => String(n)

  private renderPenalty(): void {
    const p = this.penalty
    if (!p) {
      this.penaltyLine.textContent = ''
      return
    }
    const left = Math.max(0, p.graceEnd - Date.now())
    const s = Math.ceil(left / 1000)
    const grace = left > 0 ? t('hud.death.grace', { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }) : ''
    const head = p.outcome === 'lost' ? t('hud.death.lost', { pct: p.pct, exp: this.fmt(p.exp) }) : p.outcome === 'grace' ? t('hud.death.spared') : t('hud.death.empty')
    this.penaltyLine.textContent = grace ? `${head} ${grace}` : head
    if (left <= 0 && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  hide(): void {
    this.penalty = null
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.penaltyLine.textContent = ''
    this.onRespawn = null
    this.root.hidden = true
    document.body.classList.remove('hud-dead')
  }

  /** The server refused the respawn (e.g. rate limited): let the player try again. */
  enable(): void {
    if (this.root.hidden) return
    this.button.setDisabled(false)
    this.button.setLabel(t('hud.death.respawn'))
  }

  dispose(): void {
    this.hide()
    this.root.remove()
  }
}
