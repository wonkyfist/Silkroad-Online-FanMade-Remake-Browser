/**
 * The item cast bar (docs/SHOPS.md §4.3): a centred progress bar with the item name and the seconds left while the
 * own character reads a return scroll (`itemCast` ... `itemCastEnd`). Presentation only: the server decides when the
 * cast ends and whether it succeeds. `castProgress` is the DOM-free part (test/storage.test.ts).
 */
import type { ItemCastEndReason } from '@sro/shared'
import { t } from '../i18n/index.ts'
import { el } from '../ui/dom.ts'
import { kitArt } from '../ui/kit/host.ts'
import { ensureNpcStyles } from './npc-ui.ts'

/** Progress of a cast started at `startedAt` (ms, any clock) lasting `castMs`, at `now` on the same clock. */
export function castProgress(startedAt: number, castMs: number, now: number): { fraction: number; secondsLeft: number } {
  if (!(castMs > 0)) return { fraction: 1, secondsLeft: 0 }
  const f = Math.min(1, Math.max(0, (now - startedAt) / castMs))
  return { fraction: f, secondsLeft: Math.max(0, (castMs - (now - startedAt)) / 1000) }
}

/** "12.3 s" above 10 s shows whole seconds, below one decimal (the retail bar counts down the same way). */
export function formatSecondsLeft(s: number): string {
  return s >= 10 ? t('cast.seconds', { s: Math.ceil(s) }) : t('cast.seconds', { s: (Math.ceil(s * 10) / 10).toFixed(1) })
}

const FADE_MS = 700

export class ItemCastBar {
  readonly root: HTMLElement
  private readonly label: HTMLElement
  private readonly left: HTMLElement
  private readonly fill: HTMLElement
  private cast: { item: string; startedAt: number; castMs: number } | null = null
  private hideTimer: ReturnType<typeof setTimeout> | null = null

  constructor(parent: HTMLElement, private readonly now: () => number = () => performance.now()) {
    ensureNpcStyles()
    this.label = el('span', 'npc-cast-label')
    this.left = el('span', 'npc-cast-left')
    this.fill = el('div', 'npc-cast-fill')
    this.root = el('div', 'npc-cast', el('div', 'npc-cast-head', this.label, this.left), el('div', 'npc-cast-track', this.fill))
    // UI-H: the retail casting window and its return-scroll gauge (hud/npc-ui.ts .npc-cast block).
    const art = kitArt()
    if (art.has('ifcommon/com_casting_window')) this.root.style.setProperty('--cast-window', art.cssUrl('ifcommon/com_casting_window'))
    if (art.has('ifcommon/com_casting_gauge_return')) this.root.style.setProperty('--cast-gauge', art.cssUrl('ifcommon/com_casting_gauge_return'))
    this.root.hidden = true
    parent.append(this.root)
  }

  get active(): boolean {
    return this.cast !== null
  }

  /** The item code being cast (null when idle). */
  get item(): string | null {
    return this.cast?.item ?? null
  }

  /** Starts (or restarts) the bar: `name` is the item's display name. */
  start(item: string, name: string, castMs: number): void {
    this.clearTimer()
    this.cast = { item, startedAt: this.now(), castMs: Math.max(0, castMs) }
    this.label.textContent = t('cast.using', { name })
    this.root.classList.remove('fading', 'stopped')
    this.root.hidden = false
    this.update()
  }

  /** Ends the bar: `done` fills it, `cancelled` / `interrupted` turn it red; both fade out. */
  end(reason: ItemCastEndReason): void {
    if (!this.cast) return
    this.cast = null
    if (reason === 'done') {
      this.fill.style.width = '100%'
      this.left.textContent = ''
    } else {
      this.root.classList.add('stopped')
      this.left.textContent = t('cast.stopped')
    }
    this.root.classList.add('fading')
    this.clearTimer()
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (!this.cast) this.root.hidden = true
    }, FADE_MS)
  }

  /** Hides at once (world left, death). */
  reset(): void {
    this.cast = null
    this.clearTimer()
    this.root.hidden = true
  }

  /** Per frame while casting. */
  update(): void {
    const c = this.cast
    if (!c) return
    const p = castProgress(c.startedAt, c.castMs, this.now())
    this.fill.style.width = `${(p.fraction * 100).toFixed(2)}%`
    this.left.textContent = formatSecondsLeft(p.secondsLeft)
  }

  dispose(): void {
    this.clearTimer()
    this.root.remove()
  }

  private clearTimer(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
  }
}
