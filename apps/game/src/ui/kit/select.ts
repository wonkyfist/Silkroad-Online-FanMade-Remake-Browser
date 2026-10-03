/**
 * A drop-down select (docs/UI.md §5.1, look [unknown]): a field showing the value with a drop arrow; a click opens a
 * popup List under it (above it near the screen bottom). Esc, a choice or a press elsewhere closes it.
 */
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { List } from './list.ts'
import { nineSlice } from './nine.ts'

export interface SelectChoice<V> {
  value: V
  label: string
}

const ROW = 20
const MAX_ROWS = 8

export class Select<V extends string | number> {
  readonly root: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly text: HTMLElement
  private readonly pop: HTMLElement
  private readonly list: List<SelectChoice<V>>
  private current: V
  private offOutside: (() => void) | null = null
  onChange: (value: V) => void = () => {}

  constructor(art: Art, private readonly choices: readonly SelectChoice<V>[], opts: { value?: V; w?: number; label?: string; className?: string } = {}) {
    const w = opts.w ?? 120
    this.current = opts.value ?? choices[0]!.value
    this.text = el('span', 'kit-select-text kit-t-value')
    this.button = el('button', 'kit-select-button', this.text, el('span', 'kit-select-arrow', '▼'))
    this.button.type = 'button'
    if (opts.label) this.button.setAttribute('aria-label', opts.label)
    this.button.setAttribute('aria-haspopup', 'listbox')
    nineSlice(this.button, art, 'field')
    this.list = new List<SelectChoice<V>>(art, { render: c => el('span', 'kit-t-value', c.label), rowHeight: ROW, w, h: Math.min(MAX_ROWS, choices.length) * ROW + 8 })
    this.list.setItems(choices)
    this.list.onSelect = c => this.pick(c.value)
    this.pop = el('div', 'kit-select-pop', this.list.root)
    nineSlice(this.pop, art, 'tooltip', { fill: null })
    this.pop.hidden = true
    this.root = el('div', `kit-select ${opts.className ?? ''}`.trim(), this.button, this.pop)
    this.root.style.width = `${w}px`
    this.button.addEventListener('click', () => (this.pop.hidden ? this.openPop() : this.closePop()))
    this.root.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !this.pop.hidden) {
        ev.stopPropagation()
        this.closePop()
        this.button.focus()
      }
    })
    this.paint()
  }

  get value(): V {
    return this.current
  }

  set value(v: V) {
    this.current = v
    this.paint()
  }

  get isOpen(): boolean {
    return !this.pop.hidden
  }

  private pick(v: V): void {
    this.closePop()
    if (v === this.current) return
    this.current = v
    this.paint()
    this.onChange(v)
  }

  private paint(): void {
    this.text.textContent = this.choices.find(c => c.value === this.current)?.label ?? String(this.current)
  }

  private openPop(): void {
    this.pop.hidden = false
    // The HUD's Esc rule (close the top window) leaves this Esc to the Select while its popup is open.
    this.root.dataset.ownEsc = ''
    this.list.select(this.choices.findIndex(c => c.value === this.current))
    const r = this.root.getBoundingClientRect()
    const p = this.pop.getBoundingClientRect()
    this.pop.classList.toggle('up', r.bottom + p.height > window.innerHeight - 4)
    // preventScroll: the popup is a few px wider than the field, so a plain focus() scrolled the Options page's
    // scroll view (overflow-x hidden is still scrollable by script) sideways to bring its right edge into view.
    this.list.root.focus({ preventScroll: true })
    const outside = (ev: PointerEvent) => {
      if (!this.root.contains(ev.target as Node | null)) this.closePop()
    }
    setTimeout(() => {
      if (this.pop.hidden) return
      window.addEventListener('pointerdown', outside, true)
      this.offOutside = () => window.removeEventListener('pointerdown', outside, true)
    }, 0)
  }

  private closePop(): void {
    this.pop.hidden = true
    delete this.root.dataset.ownEsc
    this.offOutside?.()
    this.offOutside = null
  }

  dispose(): void {
    this.closePop()
    this.root.remove()
  }
}
