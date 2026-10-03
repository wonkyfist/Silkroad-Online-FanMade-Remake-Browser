/**
 * The top-centre notice banner frame (docs/UI.md §2.4, §4.2): the `com_notice_*` pieces (40×8 corners, 4×8 edge
 * tiles) around a dark band, max 480 px wide, y = 96 in the HUD. `ui/notice.ts NoticeBanner` (GM notices) keeps its
 * queue; lanes that want the retail frame build on this.
 */
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { CONTROLS } from './skins.ts'

export const NOTICE_MAX_W = 480
export const NOTICE_Y = 96

export class Notice {
  readonly root: HTMLElement
  private readonly title: HTMLElement
  private readonly text: HTMLElement
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(art: Art, opts: { className?: string; kind?: 'notice' | 'warning' | 'quest' } = {}) {
    const kind = opts.kind ?? 'notice'
    const corner = kind === 'notice' ? CONTROLS.noticeCorner : `ifcommon/com_${kind}_corner`
    const edge = kind === 'notice' ? CONTROLS.noticeEdge : `ifcommon/com_${kind}_edge`
    this.title = el('div', 'kit-notice-title kit-t-caption')
    this.text = el('div', 'kit-notice-text kit-t-body')
    this.root = el('div', `kit-notice ${opts.className ?? ''}`.trim(), el('div', 'kit-notice-rim top'), el('div', 'kit-notice-rim bottom'), this.title, this.text)
    this.root.setAttribute('role', 'status')
    if (art.has(corner) && art.has(edge)) {
      this.root.style.setProperty('--corner', art.cssUrl(corner))
      this.root.style.setProperty('--edge', art.cssUrl(edge))
    } else this.root.classList.add('no-art')
    this.root.hidden = true
  }

  /** Shows `text` (and an optional title line); `ms` > 0 hides it again after that long. */
  show(text: string, opts: { title?: string; ms?: number } = {}): void {
    clearTimeout(this.timer)
    this.title.textContent = opts.title ?? ''
    this.title.hidden = !opts.title
    this.text.textContent = text
    this.root.hidden = false
    this.root.classList.remove('out')
    if (opts.ms && opts.ms > 0) this.timer = setTimeout(() => this.hide(), opts.ms)
  }

  hide(): void {
    clearTimeout(this.timer)
    this.root.hidden = true
  }
}
