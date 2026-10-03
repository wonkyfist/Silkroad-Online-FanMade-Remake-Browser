/**
 * Tab strips (docs/UI.md §5.1): retail on/off art (the tab textures have `_on` / `_off` / `_disable`, no `_focus`),
 * live labels, never narrower than the skin; a longer label grows the tab (its ends keep their size). `flex` is the
 * 3-slice `com_new_tab_*` that fits any label; `icon` tabs are pictures (`skill/skl_*_tab_{on,off}`).
 */
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { fitWidth, textWidth } from './measure.ts'

/** The tab label font (11 px English font, see tokens.ts .kit-tab). */
const TAB_FONT = "11px 'SRO English', Georgia, serif"
import { TABS, type TabName, type TabSkin } from './skins.ts'

export interface TabSpec<Id extends string> {
  id: Id
  label?: string
  /** For the `icon` skin: the art key without `_on` / `_off`. */
  icon?: string
  title?: string
}

const CAP_PARTS = ['left', 'mid', 'right'] as const

export class TabBar<Id extends string> {
  readonly root: HTMLElement
  onChange: (id: Id) => void = () => {}
  private current: Id
  private readonly buttons = new Map<Id, HTMLButtonElement>()

  constructor(private readonly art: Art, readonly skin: TabName, tabs: readonly TabSpec<Id>[], opts: { vertical?: boolean; className?: string } = {}) {
    this.root = el('div', `kit-tabs kit-tabs-${skin} ${opts.vertical ? 'vertical' : ''} ${opts.className ?? ''}`.trim())
    this.root.setAttribute('role', 'tablist')
    for (const tab of tabs) {
      const b = this.makeTab(tab)
      b.addEventListener('click', ev => {
        if (b.classList.contains('disabled')) {
          ev.stopImmediatePropagation()
          return
        }
        if (this.current === tab.id) return
        this.value = tab.id
        this.onChange(tab.id)
      })
      this.buttons.set(tab.id, b)
      this.root.append(b)
    }
    this.current = tabs[0]!.id
    this.paint()
  }

  get value(): Id {
    return this.current
  }

  set value(id: Id) {
    if (!this.buttons.has(id)) return
    this.current = id
    this.paint()
  }

  tab(id: Id): HTMLButtonElement | undefined {
    return this.buttons.get(id)
  }

  setHidden(id: Id, hidden: boolean): void {
    const b = this.buttons.get(id)
    if (b) b.hidden = hidden
  }

  setDisabled(id: Id, disabled: boolean): void {
    const b = this.buttons.get(id)
    if (!b) return
    b.classList.toggle('disabled', disabled)
    if (disabled) b.setAttribute('aria-disabled', 'true')
    else b.removeAttribute('aria-disabled')
  }

  setLabel(id: Id, label: string): void {
    const b = this.buttons.get(id)
    const span = b?.querySelector<HTMLElement>('.kit-tab-label')
    if (!b || !span) return
    span.textContent = label
    this.size(b, label)
  }

  private makeTab(tab: TabSpec<Id>): HTMLButtonElement {
    const b = el('button', 'kit-tab')
    b.type = 'button'
    b.dataset.tab = tab.id
    b.setAttribute('role', 'tab')
    if (tab.title) b.title = tab.title
    const art = this.art
    if (this.skin === 'icon') {
      const key = tab.icon ?? ''
      const size = art.size(`${key}_off`) ?? art.size(`${key}_on`) ?? [60, 24]
      b.style.width = `${size[0]}px`
      b.style.height = `${size[1]}px`
      if (art.has(`${key}_on`) && art.has(`${key}_off`)) {
        b.style.setProperty('--on', art.cssUrl(`${key}_on`))
        b.style.setProperty('--off', art.cssUrl(`${key}_off`))
        if (art.has(`${key}_disable`)) b.style.setProperty('--disable', art.cssUrl(`${key}_disable`))
      } else {
        b.classList.add('no-art')
        b.append(el('span', 'kit-tab-label', tab.label ?? tab.title ?? tab.id))
      }
      return b
    }
    const skin: TabSkin = TABS[this.skin]
    b.style.height = `${skin.h}px`
    if (skin.caps) {
      b.classList.add('kit-tab-3')
      b.style.setProperty('--caps', `${skin.caps}px`)
      const ok = CAP_PARTS.every(p => art.has(skin.on + p) && art.has(skin.off + p))
      if (ok) for (const state of ['on', 'off'] as const) for (const p of CAP_PARTS) b.style.setProperty(`--${state}-${p}`, art.cssUrl(skin[state] + p))
      else b.classList.add('no-art')
    } else if (art.has(skin.on) && art.has(skin.off)) {
      b.style.setProperty('--on', art.cssUrl(skin.on))
      b.style.setProperty('--off', art.cssUrl(skin.off))
      if (art.has(`${skin.off.replace(/_off$/, '')}_disable`)) b.style.setProperty('--disable', art.cssUrl(`${skin.off.replace(/_off$/, '')}_disable`))
    } else {
      b.classList.add('no-art')
    }
    b.append(el('span', 'kit-tab-label', tab.label ?? ''))
    this.size(b, tab.label ?? '')
    return b
  }

  private size(b: HTMLButtonElement, label: string): void {
    if (this.skin === 'icon') return
    const skin: TabSkin = TABS[this.skin]
    // 3-slice tabs pad the label by their caps (the caps are the tab's padding), others by the label padding.
    b.style.width = `${skin.caps ? fitWidth(skin.caps * 2, textWidth(label, TAB_FONT), skin.caps + 4) : fitWidth(skin.w ?? 24, textWidth(label, TAB_FONT))}px`
  }

  private paint(): void {
    for (const [id, b] of this.buttons) {
      const on = id === this.current
      b.classList.toggle('on', on)
      b.setAttribute('aria-selected', String(on))
    }
  }
}
