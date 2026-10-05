/**
 * The "What's new" window (docs/CHANGELOG_WINDOW.md §3): the update notes in the classic window style. Two modes:
 * `unseen` (opened once after entering the world when there are entries this account has not seen: "1 of 3 new
 * updates", Close and Got it) and `all` (the News entry of the Esc menu or J: every entry, newest first, with a list
 * page). Bodies are rendered by shared/news.ts `newsHtml` (everything escaped; images only from the changelog image
 * store); a click on an image shows it enlarged over the whole screen. The window fits small screens on every open.
 */
import { formatNewsDate, newsHtml, newsImageUrl, type NewsEntry } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button, iconButton, type KitButton } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { layerViewport } from '../ui/kit/scale.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import { CONTROLS } from '../ui/kit/skins.ts'
import { Window } from '../ui/kit/window.ts'

export type NewsMode = 'unseen' | 'all'

/** Preferred and smallest outer size (native px of the HUD layer). */
export const NEWS_W = 720
export const NEWS_H = 660
const MIN_W = 300
const MIN_H = 300
/** Room kept around the window on a small screen. */
const MARGIN = 8

/** The window's size for a layer of vw × vh native px. */
export function newsWindowSize(vw: number, vh: number): [number, number] {
  return [Math.round(Math.max(MIN_W, Math.min(NEWS_W, vw - 2 * MARGIN))), Math.round(Math.max(MIN_H, Math.min(NEWS_H, vh - 2 * MARGIN)))]
}

/** The header's counter: "1 of 3 new updates" / "Update 2 of 12". */
export function newsCounter(mode: NewsMode, index: number, count: number): string {
  if (count === 0) return ''
  if (mode === 'unseen') return count === 1 ? t('news.oneNew') : t('news.counterNew', { n: index + 1, count })
  return t('news.counter', { n: index + 1, count })
}

export interface NewsWindowDeps {
  /** "Got it": everything shown is seen (the caller tells the server). */
  gotIt(newest: NewsEntry): void
}

export class NewsWindow extends Window {
  private entries: NewsEntry[] = []
  private unseen = new Set<string>()
  private mode: NewsMode = 'all'
  private index = 0
  private listing = false
  private readonly counter: HTMLElement
  private readonly prev: KitButton
  private readonly next: KitButton
  private readonly listBtn: KitButton
  private readonly gotBtn: KitButton
  private readonly closeBtn: KitButton
  private readonly frame: Frame
  private readonly scroll: ScrollArea
  private readonly content: HTMLElement
  private lightbox: HTMLElement | null = null

  constructor(art: Art, parent: HTMLElement, private readonly deps: NewsWindowDeps) {
    super(art, parent, { id: 'news', title: t('news.title'), width: NEWS_W, height: NEWS_H, at: [0.5, 0.35], className: 'hud-window news-window' })
    ensureNewsStyles()
    this.prev = iconButton(art, CONTROLS.sliderPrev, { title: t('news.prev'), fallbackText: '◀', className: 'news-nav' }, () => this.show(this.index - 1))
    this.next = iconButton(art, CONTROLS.sliderNext, { title: t('news.next'), fallbackText: '▶', className: 'news-nav' }, () => this.show(this.index + 1))
    this.counter = el('div', 'news-counter')
    this.listBtn = button(art, { label: t('news.all'), minWidth: 96 }, () => (this.listing ? this.show(this.index) : this.showList()))
    this.frame = new Frame(art, 'inner', { className: 'news-frame' })
    this.scroll = new ScrollArea(art, { className: 'news-scroll' })
    this.content = el('div', 'news-content')
    this.scroll.view.append(this.content)
    this.frame.body.append(this.scroll.root)
    this.closeBtn = button(art, { label: t('news.close'), minWidth: 80 }, () => this.close())
    this.gotBtn = button(art, { label: t('news.gotIt'), minWidth: 96, primary: true }, () => this.acknowledge())
    const head = el('div', 'news-head', this.prev, this.counter, this.next)
    const foot = el('div', 'news-foot', this.listBtn, el('div', 'news-spacer'), this.closeBtn, this.gotBtn)
    this.body.classList.add('news-body')
    this.body.append(head, this.frame.root, foot)
    // An image opens enlarged; a list row opens its entry.
    this.ls.on(this.content, 'click', ev => {
      const target = ev.target as HTMLElement
      const img = target.closest('img[data-news-img]') as HTMLImageElement | null
      if (img) {
        this.enlarge(img.src, img.alt)
        return
      }
      const row = target.closest('[data-news-index]') as HTMLElement | null
      if (row) this.show(Number(row.dataset.newsIndex))
    })
    this.ls.on(this.content, 'keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      const row = (ev.target as HTMLElement).closest('[data-news-index]') as HTMLElement | null
      if (!row) return
      ev.preventDefault()
      this.show(Number(row.dataset.newsIndex))
    })
    // A broken image shows its caption only.
    this.content.addEventListener('error', ev => {
      const img = ev.target as HTMLElement
      if (img.tagName === 'IMG') img.closest('figure')?.classList.add('broken')
    }, true)
  }

  get currentMode(): NewsMode {
    return this.mode
  }

  /** Opens on `entries` (newest first). `unseen`: the ids not seen yet (marked "New"). */
  present(mode: NewsMode, entries: readonly NewsEntry[], unseen: readonly string[], startAt = 0): void {
    this.mode = mode
    this.entries = [...entries]
    this.unseen = new Set(unseen)
    this.fit()
    if (!this.isOpen) this.open()
    this.raise()
    if (this.entries.length === 0) this.showEmpty()
    else this.show(startAt)
  }

  /** Every entry, after "Got it": nothing is new any more. */
  markAllSeen(): void {
    this.unseen.clear()
  }

  override close(): void {
    this.closeLightbox()
    super.close()
  }

  override dispose(): void {
    this.closeLightbox()
    this.scroll.dispose()
    super.dispose()
  }

  /** Fits the window to the layer (small screens), keeping it on screen. */
  private fit(): void {
    const [vw, vh] = layerViewport(this.root.parentElement)
    const [w, h] = newsWindowSize(vw, vh)
    this.resize(w, h)
    this.root.classList.toggle('news-narrow', w < 460)
  }

  private show(i: number): void {
    if (this.entries.length === 0) return
    this.listing = false
    this.index = Math.max(0, Math.min(this.entries.length - 1, i))
    const e = this.entries[this.index]
    const hero = e.hero ? `<figure class="nw-fig nw-hero"><img src="${escapeAttr(newsImageUrl(e.hero))}" alt="" decoding="async" data-news-img="${escapeAttr(e.hero)}"></figure>` : ''
    const isNew = this.unseen.has(e.id) ? `<span class="news-new">${escapeText(t('news.new'))}</span>` : ''
    // newsHtml escapes the body; title, summary and date are escaped here.
    this.content.innerHTML =
      `<div class="news-date">${escapeText(formatNewsDate(e.date))}${isNew}</div>` +
      `<h2 class="news-title">${escapeText(e.title)}</h2>` +
      (e.summary ? `<p class="news-summary">${escapeText(e.summary)}</p>` : '') +
      hero +
      `<div class="news-md">${newsHtml(e.body)}</div>`
    this.scroll.view.scrollTop = 0
    this.updateChrome()
  }

  private showList(): void {
    this.listing = true
    const rows = this.entries.map((e, i) => {
      const row = el('div', 'news-row')
      row.dataset.newsIndex = String(i)
      row.tabIndex = 0
      row.setAttribute('role', 'button')
      const date = el('div', 'news-row-date', formatNewsDate(e.date))
      if (this.unseen.has(e.id)) date.append(el('span', 'news-new', t('news.new')))
      row.append(date, el('div', 'news-row-title', e.title))
      if (e.summary) row.append(el('div', 'news-row-summary', e.summary))
      return row
    })
    this.content.replaceChildren(el('h2', 'news-title', t('news.allTitle')), ...rows)
    this.scroll.view.scrollTop = 0
    this.updateChrome()
  }

  private showEmpty(): void {
    this.listing = false
    this.content.replaceChildren(el('p', 'news-empty', t('news.empty')))
    this.updateChrome()
  }

  private updateChrome(): void {
    const n = this.entries.length
    const nav = !this.listing && n > 1
    this.prev.hidden = !nav
    this.next.hidden = !nav
    this.prev.setDisabled(this.index <= 0)
    this.next.setDisabled(this.index >= n - 1)
    this.counter.textContent = this.listing ? t('news.allCount', { count: n }) : newsCounter(this.mode, this.index, n)
    this.listBtn.setLabel(this.listing ? t('news.back') : t('news.all'))
    this.listBtn.hidden = n === 0 || (this.mode === 'unseen' && n <= 1 && !this.listing)
    this.gotBtn.hidden = this.mode !== 'unseen'
  }

  private acknowledge(): void {
    const newest = this.entries[0]
    if (newest) this.deps.gotIt(newest)
    this.unseen.clear()
    this.close()
  }

  /** The picture over the whole screen (outside the zoomed HUD layer); a click, Esc or Enter closes it. */
  private enlarge(src: string, alt: string): void {
    this.closeLightbox()
    const img = el('img', 'news-zoom-img')
    img.src = src
    img.alt = alt
    const box = el('div', 'news-zoom', img, alt ? el('div', 'news-zoom-cap', alt) : null)
    box.tabIndex = -1
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-label', alt || t('news.title'))
    // The HUD's Esc chain leaves [data-own-esc] alone: Esc closes the picture, not the window.
    box.dataset.ownEsc = ''
    box.addEventListener('click', () => this.closeLightbox())
    box.addEventListener('contextmenu', ev => ev.preventDefault())
    box.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        this.closeLightbox()
      }
    })
    document.body.append(box)
    this.lightbox = box
    box.focus({ preventScroll: true })
  }

  private closeLightbox(): void {
    if (!this.lightbox) return
    this.lightbox.remove()
    this.lightbox = null
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeText = (s: string): string => s.replace(/[&<>"']/g, c => ESC[c])
const escapeAttr = escapeText

const CSS = `
.news-window .news-body { display: flex; flex-direction: column; gap: 6px; }
.news-head { flex: none; display: flex; align-items: center; justify-content: center; gap: 8px; height: 24px; }
.news-head .kit-btn[hidden] { display: none; }
.news-counter { min-width: 150px; text-align: center; color: var(--c-heading); font: 12px/24px var(--font-title); text-shadow: var(--t-outline); white-space: nowrap; }
.news-frame { flex: 1 1 auto; min-height: 0; }
.news-scroll { position: absolute; inset: 0; }
.news-content { padding: 4px 10px 14px 6px; color: var(--c-text); font: 14px/20px var(--font-body); text-shadow: var(--t-shadow); user-select: text; overflow-wrap: anywhere; }
.news-date { display: flex; align-items: center; gap: 8px; color: var(--c-label); font: 12px/16px var(--font-body); }
.news-new { display: inline-block; padding: 0 6px; border: 1px solid #b8892f; border-radius: 3px; color: #ffd76a; background: rgba(120, 70, 0, 0.45); font: bold 10px/14px var(--font-body); letter-spacing: 0.5px; text-transform: uppercase; }
.news-title { margin: 4px 0 6px; color: var(--c-caption); font: bold 19px/24px var(--font-title); text-shadow: var(--t-outline); }
.news-summary { margin: 0 0 10px; color: #f3e3b8; font: 15px/21px var(--font-body); }
.news-md p { margin: 0 0 10px; }
.news-md .nw-h { margin: 16px 0 6px; color: var(--c-heading); font-family: var(--font-title); text-shadow: var(--t-outline); }
.news-md .nw-h1 { font-size: 17px; line-height: 22px; border-bottom: 1px solid rgba(214, 170, 92, 0.35); padding-bottom: 3px; }
.news-md .nw-h2 { font-size: 15px; line-height: 20px; }
.news-md .nw-h3 { font-size: 14px; line-height: 19px; color: var(--c-label); }
.news-md ul, .news-md ol { margin: 0 0 10px; padding-left: 22px; }
.news-md li { margin: 0 0 5px; }
.news-md li::marker { color: #d6aa5c; }
.news-md strong { color: #ffe9a8; }
.news-md em { color: #e8dcc0; }
.news-md code { padding: 0 3px; background: rgba(0, 0, 0, 0.45); border-radius: 2px; font: 13px/18px monospace; }
.news-md blockquote { margin: 0 0 10px; padding: 6px 10px; border-left: 3px solid #d6aa5c; background: rgba(0, 0, 0, 0.35); color: #f0e2bd; }
.news-md hr { border: 0; border-top: 1px solid rgba(214, 170, 92, 0.35); margin: 14px 0; }
.news-content .nw-fig { margin: 4px 0 12px; }
.news-content .nw-fig img { display: block; width: 100%; height: auto; border: 1px solid #6b5431; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6); cursor: zoom-in; background: rgba(0, 0, 0, 0.4); }
.news-content .nw-fig img:hover { border-color: #d6aa5c; }
.news-content .nw-fig figcaption { margin-top: 4px; color: var(--c-label); font: 12px/16px var(--font-body); }
.news-content .nw-fig.broken img { display: none; }
.news-content .nw-hero { margin-bottom: 12px; }
.news-md .nw-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.news-md .nw-row > .nw-fig { flex: 1 1 200px; min-width: 0; }
.news-row { padding: 8px 8px 9px; margin: 0 0 6px; border: 1px solid rgba(107, 84, 49, 0.8); background: rgba(0, 0, 0, 0.3); cursor: pointer; }
.news-row:hover, .news-row:focus-visible { border-color: #d6aa5c; background: rgba(60, 40, 10, 0.45); outline: none; }
.news-row-date { display: flex; align-items: center; gap: 8px; color: var(--c-label); font: 12px/16px var(--font-body); }
.news-row-title { color: var(--c-caption); font: bold 15px/20px var(--font-title); text-shadow: var(--t-outline); }
.news-row-summary { color: var(--c-text); font: 13px/18px var(--font-body); }
.news-empty { margin: 30px 0; text-align: center; color: var(--c-label); }
.news-foot { flex: none; display: flex; align-items: center; gap: 6px; height: 26px; }
.news-foot .kit-btn[hidden] { display: none; }
.news-spacer { flex: 1 1 auto; }
.news-narrow .news-content { font-size: 13px; line-height: 18px; }
.news-narrow .news-counter { min-width: 0; }
.news-zoom { position: fixed; inset: 0; z-index: 100000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 16px; box-sizing: border-box; background: rgba(0, 0, 0, 0.86); cursor: zoom-out; outline: none; }
.news-zoom-img { max-width: 100%; max-height: calc(100% - 40px); object-fit: contain; border: 1px solid #6b5431; box-shadow: 0 0 24px rgba(0, 0, 0, 0.8); }
.news-zoom-cap { max-width: 900px; color: #f0e2bd; font: 14px/19px var(--font-body, sans-serif); text-align: center; text-shadow: 0 1px 2px #000; }
`

let injected = false

/** Injects the window's stylesheet once. */
export function ensureNewsStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'news'
  style.textContent = CSS
  document.head.append(style)
}
