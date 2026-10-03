/**
 * A selectable list (docs/UI.md §5.1): rows on the 3-slice `com_bar01_` bar, the selected row on
 * `com_bar01select_` (orange outline), inside a ScrollArea. Over 200 rows only the visible window is built.
 * Keyboard: Up/Down move the selection, Enter activates.
 */
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { ScrollArea } from './scroll.ts'
import { CONTROLS } from './skins.ts'

export const VIRTUAL_FROM = 200
export const LIST_ROW_H = 24

/** The rows [from, to) to build for a scroll position (with `overscan` rows either side). */
export function visibleRange(scrollTop: number, viewH: number, rowH: number, count: number, overscan = 4): [number, number] {
  if (count <= 0 || rowH <= 0) return [0, 0]
  const from = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const to = Math.min(count, Math.ceil((scrollTop + Math.max(0, viewH)) / rowH) + overscan)
  return [from, Math.max(from, to)]
}

export interface ListOptions<T> {
  render: (item: T, index: number) => Node | string
  rowHeight?: number
  w?: number
  h?: number
  className?: string
  /** Draw rows on the bar art (default true). */
  bars?: boolean
}

export class List<T> {
  readonly root: HTMLElement
  readonly scroll: ScrollArea
  private readonly inner: HTMLElement
  private items: readonly T[] = []
  private sel = -1
  private readonly rowH: number
  onSelect: (item: T, index: number) => void = () => {}
  onActivate: (item: T, index: number) => void = () => {}

  constructor(art: Art, private readonly opts: ListOptions<T>) {
    this.rowH = opts.rowHeight ?? LIST_ROW_H
    this.scroll = new ScrollArea(art, { w: opts.w, h: opts.h, className: `kit-list ${opts.className ?? ''}` })
    this.root = this.scroll.root
    this.root.tabIndex = 0
    this.root.setAttribute('role', 'listbox')
    this.inner = el('div', 'kit-list-inner')
    this.scroll.view.append(this.inner)
    const bar = (prefix: string, name: string) => {
      const parts = ['left', 'mid', 'right'].map(p => prefix + p)
      if (parts.every(k => art.has(k))) parts.forEach((k, i) => this.root.style.setProperty(`--${name}-${['l', 'm', 'r'][i]}`, art.cssUrl(k)))
      else this.root.classList.add(`no-${name}`)
    }
    if (opts.bars !== false) {
      bar(CONTROLS.bar, 'bar')
      bar(CONTROLS.barSelect, 'sel')
    } else this.root.classList.add('plain')
    this.root.style.setProperty('--row-h', `${this.rowH}px`)
    this.scroll.view.addEventListener('scroll', () => this.items.length > VIRTUAL_FROM && this.paint(), { passive: true })
    this.root.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        ev.stopPropagation()
        this.select(Math.min(this.items.length - 1, Math.max(0, this.sel + (ev.key === 'ArrowDown' ? 1 : -1))), true)
      } else if (ev.key === 'Enter' && this.sel >= 0) {
        ev.stopPropagation()
        this.onActivate(this.items[this.sel]!, this.sel)
      }
    })
  }

  get selected(): number {
    return this.sel
  }

  get selectedItem(): T | undefined {
    return this.items[this.sel]
  }

  setItems(items: readonly T[], keepSelection = false): void {
    this.items = items
    if (!keepSelection || this.sel >= items.length) this.sel = -1
    this.inner.style.height = items.length > VIRTUAL_FROM ? `${items.length * this.rowH}px` : ''
    this.paint()
  }

  /** Selects row i (-1 = none); `notify` fires onSelect; the row is scrolled into view. */
  select(i: number, notify = false): void {
    this.sel = i >= 0 && i < this.items.length ? i : -1
    if (this.sel >= 0) {
      const top = this.sel * this.rowH
      const v = this.scroll.view
      if (top < v.scrollTop) v.scrollTop = top
      else if (top + this.rowH > v.scrollTop + v.clientHeight) v.scrollTop = top + this.rowH - v.clientHeight
    }
    this.paint()
    if (notify && this.sel >= 0) this.onSelect(this.items[this.sel]!, this.sel)
  }

  private paint(): void {
    const virtual = this.items.length > VIRTUAL_FROM
    const [from, to] = virtual ? visibleRange(this.scroll.view.scrollTop, this.scroll.view.clientHeight || 400, this.rowH, this.items.length) : [0, this.items.length]
    const rows: HTMLElement[] = []
    for (let i = from; i < to; i++) {
      const item = this.items[i]!
      const r = el('div', `kit-list-row ${i === this.sel ? 'selected' : ''}`.trim())
      r.setAttribute('role', 'option')
      r.setAttribute('aria-selected', String(i === this.sel))
      r.style.height = `${this.rowH}px`
      if (virtual) Object.assign(r.style, { position: 'absolute', left: '0', right: '0', top: `${i * this.rowH}px` })
      const content = this.opts.render(item, i)
      r.append(content)
      r.addEventListener('click', () => this.select(i, true))
      r.addEventListener('dblclick', () => this.onActivate(item, i))
      rows.push(r)
    }
    this.inner.classList.toggle('virtual', virtual)
    this.inner.replaceChildren(...rows)
    this.scroll.refresh()
  }
}
