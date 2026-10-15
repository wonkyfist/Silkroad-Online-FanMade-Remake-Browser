/**
 * Maintenance mode's countdown banner (docs/ADMIN.md §8): a small strip at the top centre while the server counts down
 * to maintenance ("Server maintenance in 4:59 · reason · expected downtime about 30 min"), and a staff-only "Maintenance
 * mode is ON" while it is on. Driven by the server's `maintenance` message (on every screen with a session: lobby and
 * world); it never takes clicks. The announcements themselves arrive as `notice` + chat lines.
 */
import type { MaintenanceSync } from '@sro/shared'
import { t } from '../i18n/index.ts'
import { el } from './dom.ts'

/** 4:59, 0:09, 1:02:03. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** The banner's text for `sync` with `leftMs` to go (countdown), or null when there is nothing to show. */
export function maintenanceBannerText(sync: MaintenanceSync, leftMs: number): string | null {
  if (sync.state === 'off') return null
  const parts: string[] = []
  if (sync.state === 'on') parts.push(t('maint.banner.on'))
  else parts.push(leftMs > 0 ? t('maint.banner.countdown', { time: clockText(leftMs) }) : t('maint.banner.now'))
  if (sync.reason) parts.push(t('maint.banner.reason', { reason: sync.reason }))
  if (sync.back && sync.back > 0) parts.push(sync.back < 90 ? t('maint.banner.back', { min: sync.back }) : t('maint.banner.backHours', { hours: Math.round(sync.back / 60) }))
  return parts.join(' · ')
}

export class MaintenanceBanner {
  private node: HTMLElement | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private sync: MaintenanceSync = { state: 'off' }
  /** performance.now() of the kick (countdown). */
  private endsAt = 0

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** A `maintenance` message from the server. */
  update(sync: MaintenanceSync): void {
    this.sync = sync
    this.endsAt = this.now() + (sync.endsIn ?? 0)
    if (sync.state === 'off') return this.hide()
    this.render()
    if (sync.state === 'countdown' && this.timer === undefined) this.timer = setInterval(() => this.render(), 1000)
    if (sync.state !== 'countdown') this.stopTimer()
  }

  /** The text on screen ('' when hidden; tests). */
  get text(): string {
    return this.node?.textContent ?? ''
  }

  /** The session ended (logout, kick): the banner leaves with it. */
  hide(): void {
    this.sync = { state: 'off' }
    this.stopTimer()
    this.node?.remove()
    this.node = null
  }

  private render(): void {
    const text = maintenanceBannerText(this.sync, this.endsAt - this.now())
    if (!text) return this.hide()
    if (!this.node) {
      this.node = el('div', 'maint-banner')
      this.node.setAttribute('role', 'status')
      this.node.title = t('maint.title')
      document.body.append(this.node)
    }
    this.node.classList.toggle('on', this.sync.state === 'on')
    this.node.textContent = text
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}
