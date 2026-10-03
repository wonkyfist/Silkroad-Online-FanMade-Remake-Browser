/**
 * A scrolling area with the retail vertical bar (docs/UI.md §2.4, `ifverticalscroll.txt`): native overflow
 * scrolling (wheel, touch, keyboard) with the native scrollbar hidden, and the retail bar beside it (up arrow,
 * `com_scroll_bar` track, `com_scroll_button` thumb, down arrow) driven from `scrollTop`. The bar hides when the
 * content fits. Pointer maths use the track's on-screen rect, so it is right at any zoom.
 */
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { iconButton } from './button.ts'
import { CONTROLS } from './skins.ts'

export const SCROLL_BAR_W = 16
export const THUMB_MIN = 16
/** px per arrow click. */
export const SCROLL_STEP = 24

export interface ThumbGeometry {
  top: number
  size: number
  /** Content fits: no bar. */
  hidden: boolean
}

/** Thumb position and size in a track of trackH px for a view of clientH over content of scrollH. */
export function thumbGeometry(scrollTop: number, scrollH: number, clientH: number, trackH: number, minThumb = THUMB_MIN): ThumbGeometry {
  if (!(scrollH > clientH + 0.5) || !(trackH > 0)) return { top: 0, size: trackH, hidden: true }
  const size = Math.max(minThumb, Math.min(trackH, Math.round((trackH * clientH) / scrollH)))
  const range = scrollH - clientH
  const t = Math.min(1, Math.max(0, scrollTop / range))
  return { top: Math.round((trackH - size) * t), size, hidden: false }
}

/** scrollTop for a thumb dragged to `thumbTop` (track px). */
export function scrollForThumb(thumbTop: number, thumbSize: number, trackH: number, scrollH: number, clientH: number): number {
  const free = trackH - thumbSize
  if (!(free > 0)) return 0
  return (Math.min(free, Math.max(0, thumbTop)) / free) * Math.max(0, scrollH - clientH)
}

export class ScrollArea {
  readonly root: HTMLElement
  /** The scrolling element: put content here. */
  readonly view: HTMLElement
  private readonly bar: HTMLElement
  private readonly track: HTMLElement
  private readonly thumb: HTMLElement
  private geometry: ThumbGeometry = { top: 0, size: 0, hidden: true }
  private readonly observer: ResizeObserver | null = null
  private raf = 0

  constructor(art: Art, opts: { w?: number; h?: number; className?: string } = {}) {
    this.root = el('div', `kit-scroll ${opts.className ?? ''}`.trim())
    if (opts.w) this.root.style.width = `${opts.w}px`
    if (opts.h) this.root.style.height = `${opts.h}px`
    this.view = el('div', 'kit-scroll-view')
    const up = iconButton(art, CONTROLS.scrollUp, { w: 16, h: 16, fallbackText: '▲', sfx: 'none', className: 'kit-scroll-up' }, () => this.by(-SCROLL_STEP))
    const down = iconButton(art, CONTROLS.scrollDown, { w: 16, h: 16, fallbackText: '▼', sfx: 'none', className: 'kit-scroll-down' }, () => this.by(SCROLL_STEP))
    this.thumb = el('div', 'kit-scroll-thumb')
    if (art.has(CONTROLS.scrollThumb)) {
      this.thumb.style.setProperty('--img', art.cssUrl(CONTROLS.scrollThumb))
      this.thumb.style.setProperty('--img-press', art.cssUrl(art.has(`${CONTROLS.scrollThumb}_press`) ? `${CONTROLS.scrollThumb}_press` : CONTROLS.scrollThumb))
    } else this.thumb.classList.add('no-art')
    this.track = el('div', 'kit-scroll-track', this.thumb)
    if (art.has(CONTROLS.scrollTrack)) this.track.style.backgroundImage = art.cssUrl(CONTROLS.scrollTrack)
    else this.track.classList.add('no-art')
    this.bar = el('div', 'kit-scroll-bar', up, this.track, down)
    this.root.append(this.view, this.bar)
    this.view.addEventListener('scroll', () => this.refresh(), { passive: true })
    this.track.addEventListener('pointerdown', ev => this.onTrack(ev))
    this.thumb.addEventListener('pointerdown', ev => this.onThumb(ev))
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.schedule())
      this.observer.observe(this.view)
    }
    if (typeof MutationObserver !== 'undefined') new MutationObserver(() => this.schedule()).observe(this.view, { childList: true, subtree: true, characterData: true })
  }

  /** Re-reads the sizes (call after content changes if observers are unavailable). */
  refresh(): void {
    // From the area's height (the bar is display:none while the content fits): minus the two 16-px arrows.
    const trackH = Math.max(0, this.root.clientHeight - 32)
    this.geometry = thumbGeometry(this.view.scrollTop, this.view.scrollHeight, this.view.clientHeight, trackH)
    this.root.classList.toggle('fits', this.geometry.hidden)
    this.thumb.style.top = `${this.geometry.top}px`
    this.thumb.style.height = `${this.geometry.size}px`
  }

  by(dy: number): void {
    this.view.scrollTop += dy
  }

  toBottom(): void {
    this.view.scrollTop = this.view.scrollHeight
  }

  dispose(): void {
    this.observer?.disconnect()
    cancelAnimationFrame(this.raf)
    this.root.remove()
  }

  private schedule(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.refresh()
    })
  }

  /** A click on the track pages toward the pointer. */
  private onTrack(ev: PointerEvent): void {
    if (ev.target !== this.track || ev.button !== 0) return
    const r = this.thumb.getBoundingClientRect()
    this.by(ev.clientY < r.top ? -this.view.clientHeight : this.view.clientHeight)
  }

  private onThumb(ev: PointerEvent): void {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    const track = this.track.getBoundingClientRect()
    // Screen px per track px: the track's on-screen height over its layout height (any zoom).
    const k = this.track.clientHeight > 0 ? track.height / this.track.clientHeight : 1
    const start = { y: ev.clientY, top: this.geometry.top }
    this.thumb.setPointerCapture(ev.pointerId)
    this.thumb.classList.add('pressed')
    const move = (e: PointerEvent) => {
      const top = start.top + (e.clientY - start.y) / k
      this.view.scrollTop = scrollForThumb(top, this.geometry.size, Math.max(0, this.root.clientHeight - 32), this.view.scrollHeight, this.view.clientHeight)
    }
    const up = () => {
      this.thumb.classList.remove('pressed')
      this.thumb.removeEventListener('pointermove', move)
      this.thumb.removeEventListener('pointerup', up)
      this.thumb.removeEventListener('pointercancel', up)
    }
    this.thumb.addEventListener('pointermove', move)
    this.thumb.addEventListener('pointerup', up)
    this.thumb.addEventListener('pointercancel', up)
  }
}
