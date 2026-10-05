/**
 * The Main window (docs/UI.md §4.6, `GDR_MAINPOPUP` 388×408): one mframe window whose pages are tabs chosen from the
 * retail side strip `mainpopup/main_systab_02` (48×326 at (−42, 55)) with the `main_sysbutton_*` buttons (28×28 at
 * (−36, 78 + 42·k)). Pages are registered by id; the key of the tab already shown closes the window.
 * The page area starts at (13, 38) (or (13, 63) for pages with their own tab row), per `ifmainpopup.txt`.
 * UI-W builds hud/main-window.ts on this: Character, Inventory, Skill, Party, Quest.
 */
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { iconButton, type KitButton } from './button.ts'
import { CONTROLS } from './skins.ts'
import { Window, type WindowOptions } from './window.ts'

export const MAIN_W = 388
export const MAIN_H = 408
export const MAIN_TAB_ORDER = ['character', 'inventory', 'skill', 'action', 'party', 'quest', 'apprenticeship'] as const
/** Button slot k of the side strip (window px). */
export function mainTabRect(k: number): [number, number, number, number] {
  return [-36, 78 + 42 * k, 28, 28]
}

export interface MainTab {
  id: string
  /** Tooltip / aria label (live text). */
  title: string
  /** Art key of the side button (e.g. `mainpopup/main_sysbutton_inventory`); default from the id. */
  icon?: string
  /** The window title while this tab is shown (default: `title`). */
  windowTitle?: string
  /** Side strip slot (default: the retail order, else after it). */
  slot?: number
  page: HTMLElement
  onShow?(): void
  onHide?(): void
}

export class MainWindow extends Window {
  private readonly strip: HTMLElement
  private readonly tabs = new Map<string, { tab: MainTab; button: KitButton }>()
  private currentTab: string | null = null
  onTabChange: (id: string) => void = () => {}

  constructor(art: Art, parent: HTMLElement, opts: Partial<WindowOptions> & { id?: string; title: string }) {
    super(art, parent, { id: 'main', width: MAIN_W, height: MAIN_H, at: [0.5, 0.35], ...opts, className: `kit-main-window ${opts.className ?? ''}`, inset: opts.inset ?? [38, 11, 14, 13] })
    this.strip = el('div', 'kit-main-strip')
    if (art.has(CONTROLS.mainTabStrip)) this.strip.style.backgroundImage = art.cssUrl(CONTROLS.mainTabStrip)
    else this.strip.classList.add('no-art')
    this.root.append(this.strip)
  }

  /** Registers a page; returns an unregister function. */
  addTab(tab: MainTab): () => void {
    this.removeTab(tab.id)
    const slot = tab.slot ?? nextSlot(tab.id, [...this.tabs.values()].map(x => x.tab.slot ?? -1))
    tab.slot = slot
    const key = tab.icon ?? `mainpopup/main_sysbutton_${tab.id}`
    const button = iconButton(this.art, key, { w: 28, h: 28, title: tab.title, fallbackText: tab.title.slice(0, 1), className: 'kit-main-tab' }, () => this.show(tab.id))
    const [x, y] = mainTabRect(slot)
    Object.assign(button.style, { left: `${x}px`, top: `${y}px` })
    button.dataset.tab = tab.id
    button.setAttribute('role', 'tab')
    tab.page.classList.add('kit-main-page')
    tab.page.hidden = true
    this.body.append(tab.page)
    this.root.append(button)
    this.tabs.set(tab.id, { tab, button })
    return () => this.removeTab(tab.id)
  }

  get tab(): string | null {
    return this.currentTab
  }

  hasTab(id: string): boolean {
    return this.tabs.has(id)
  }

  /** Opens the window on `id`. */
  show(id: string): void {
    const next = this.tabs.get(id)
    if (!next) return
    if (this.currentTab !== id) {
      const cur = this.currentTab ? this.tabs.get(this.currentTab) : undefined
      if (cur) {
        cur.tab.page.hidden = true
        cur.button.classList.remove('on')
        cur.tab.onHide?.()
      }
      this.currentTab = id
      next.tab.page.hidden = false
      next.button.classList.add('on')
      this.setTitle(next.tab.windowTitle ?? next.tab.title)
      // Open before onShow: a page renders only while the window shows it (isShowing), so a closed window opened
      // straight onto a tab (K for Skills) would otherwise draw an empty page until the tab is clicked again.
      this.open()
      next.tab.onShow?.()
      this.onTabChange(id)
    }
    this.open()
    this.raise()
  }

  /** The key of a tab: opens it, or closes the window when that tab is already shown. */
  toggleTab(id: string): void {
    if (this.isOpen && this.currentTab === id) this.close()
    else this.show(id)
  }

  /** True when the window is open on `id`. */
  isShowing(id: string): boolean {
    return this.isOpen && this.currentTab === id
  }

  private removeTab(id: string): void {
    const x = this.tabs.get(id)
    if (!x) return
    x.button.remove()
    x.tab.page.remove()
    this.tabs.delete(id)
    if (this.currentTab === id) {
      this.currentTab = null
      const first = this.tabs.keys().next()
      if (!first.done && this.isOpen) this.show(first.value)
      else if (this.isOpen) this.close()
    }
  }
}

/**
 * The side-strip slot for a tab id: its retail slot when free, else the first free slot after the retail strip.
 * The seven retail slots stay reserved for their own tabs (Action and Apprenticeship have none yet), so a tab without
 * a retail slot never takes one that a retail tab will need.
 */
export function nextSlot(id: string, taken: readonly number[]): number {
  const retail = (MAIN_TAB_ORDER as readonly string[]).indexOf(id)
  if (retail >= 0 && !taken.includes(retail)) return retail
  let k = MAIN_TAB_ORDER.length
  while (taken.includes(k)) k++
  return k
}
