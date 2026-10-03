/**
 * The window registry of the underbar (docs/UI.md §4.5; the registry is UX-A's, the view is UI-H's). Lanes register a
 * window toggle; the underbar shows it two ways:
 *   - Character, Inventory and Skill (ids 'character' / 'inventory' / 'skills') as the round `ub_new_*` buttons of the
 *     underbar's right panel, pressed while their window is open;
 *   - every entry as a row of the MENU popup (the `ub_new_menu` tab): `ub_new_menu_button` rows with a 20×20
 *     `ub_new_icon_*` icon (MenuBarEntry.icon, else a default per id) and live text, in an `ub_new_wnd_` frame.
 * A row without a registered entry does not exist, so an empty registry shows an empty panel and no popup rows.
 * The pressed look follows the windows even when they open by key (a light poll, the registry holds a handful of
 * entries). Order used so far: Character 10, Inventory 20 (UX-A), Skill 30, Quest 40, Party 50 (their lanes),
 * Options 90 (UX-A).
 */
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { iconButton, type KitButton } from '../ui/kit/button.ts'
import { nineSlice } from '../ui/kit/nine.ts'
import { ensureHudStyles } from './hud-style.ts'
import { menuIcon, PANEL_BUTTONS, PANEL_ENTRIES } from './underbar-layout.ts'

export interface MenuBarEntry {
  id: string
  /** Art key of the old menu-bar button (kept for callers; the underbar draws its own art). */
  art: string
  /** Caption (tooltip and MENU row text). */
  label: StringKey
  toggle(): void
  isOpen(): boolean
  /** Ascending; default 50. Ties keep registration order. */
  order?: number
  /** The key that toggles the same window, shown in the tooltip ('I', 'C'). */
  hotkey?: string
  /** M5: the MENU popup icon (an `underbar/ub_new_icon_*` key); default from the id (underbar-layout MENU_ICONS). */
  icon?: string
}

/** The entries in display order (order, then registration). */
export function sortEntries<T>(list: readonly T[], order: (x: T) => number | undefined): T[] {
  return list.map((e, i) => ({ e, i })).sort((a, b) => (order(a.e) ?? 50) - (order(b.e) ?? 50) || a.i - b.i).map(x => x.e)
}

/** The MENU popup rows for a set of entries: sorted, each with its resolved icon (pure, for tests). */
export function menuRows(entries: readonly MenuBarEntry[]): { id: string; label: StringKey; icon: string; hotkey?: string }[] {
  return sortEntries(entries, e => e.order).map(e => ({ id: e.id, label: e.label, icon: menuIcon(e.id, e.icon), ...(e.hotkey ? { hotkey: e.hotkey } : {}) }))
}

interface Item {
  entry: MenuBarEntry
  row: HTMLButtonElement
  round: KitButton | null
}

export class MenuBar {
  /** The MENU popup (hidden until the tab opens it). The underbar mounts it above its MENU tab. */
  readonly root: HTMLElement
  /** The right panel's round buttons (Character, Inventory, Skill), placed by the underbar. */
  readonly panel: HTMLElement
  /** The MENU tab (`ub_new_menu`, the art has "MENU ▲" baked in, which is English). */
  readonly tab: KitButton
  private readonly rows: HTMLElement
  private items: Item[] = []
  private readonly timer: ReturnType<typeof setInterval> | undefined
  private readonly onDocDown = (ev: PointerEvent) => {
    const tgt = ev.target as Node | null
    if (!this.isMenuOpen || !tgt) return
    if (this.root.contains(tgt) || this.tab.contains(tgt)) return
    this.closeMenu()
  }

  constructor(private readonly art: Art) {
    ensureHudStyles()
    this.rows = el('div', 'uh-menu-rows')
    this.root = el('div', 'uh-menu hud-block', this.rows)
    nineSlice(this.root, art, 'menu', { fill: null })
    this.root.hidden = true
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.panel = el('div', 'uh-panel')
    this.tab = iconButton(art, 'underbar/ub_new_menu', { title: t('uh.menu'), fallbackText: t('uh.menu'), className: 'uh-menu-tab' }, () => this.toggleMenu())
    this.tab.setAttribute('aria-haspopup', 'menu')
    this.tab.addEventListener('pointerdown', ev => ev.stopPropagation())
    if (typeof document !== 'undefined') document.addEventListener('pointerdown', this.onDocDown, true)
    this.timer = typeof window === 'undefined' ? undefined : setInterval(() => this.refresh(), 250)
  }

  get isMenuOpen(): boolean {
    return !this.root.hidden
  }

  toggleMenu(): void {
    if (this.isMenuOpen) this.closeMenu()
    else this.openMenu()
  }

  openMenu(): void {
    if (!this.items.length) return
    this.refresh()
    this.root.hidden = false
    this.tab.classList.add('is-press')
  }

  closeMenu(): void {
    this.root.hidden = true
    this.tab.classList.remove('is-press')
  }

  /** Adds (or replaces, by id) an entry. Returns an unregister function. */
  register(entry: MenuBarEntry): () => void {
    this.remove(entry.id)
    const caption = t(entry.label)
    const title = entry.hotkey ? t('menubar.hotkey', { label: caption, key: entry.hotkey }) : caption
    const run = () => {
      try {
        entry.toggle()
      } catch (err) {
        console.error(`[menubar] ${entry.id} failed`, err)
      }
      this.refresh()
    }
    // MENU popup row: icon + text + hotkey.
    const icon = el('span', 'uh-menu-icon')
    const iconKey = menuIcon(entry.id, entry.icon)
    if (this.art.has(iconKey)) icon.style.backgroundImage = this.art.cssUrl(iconKey)
    const row = el('button', 'uh-menu-row', icon, el('span', 'uh-menu-label', caption), el('span', 'uh-menu-key', entry.hotkey ?? '')) as HTMLButtonElement
    row.type = 'button'
    row.title = title
    row.dataset.menu = entry.id
    row.dataset.sfx = 'click'
    if (this.art.has('underbar/ub_new_menu_button_focus')) {
      row.style.setProperty('--img-focus', this.art.cssUrl('underbar/ub_new_menu_button_focus'))
      row.style.setProperty('--img-press', this.art.cssUrl('underbar/ub_new_menu_button_press'))
    } else row.classList.add('no-art')
    row.addEventListener('click', () => {
      this.closeMenu()
      run()
    })
    // Right-panel round button (Character / Inventory / Skill).
    const slot = PANEL_ENTRIES.findIndex(p => p.id === entry.id)
    let round: KitButton | null = null
    if (slot >= 0) {
      const p = PANEL_ENTRIES[slot]!
      round = iconButton(this.art, p.art, { title, fallbackText: caption.charAt(0), className: 'uh-round' }, run)
      round.dataset.menu = entry.id
      round.setAttribute('aria-label', caption)
      const r = PANEL_BUTTONS[slot]!
      Object.assign(round.style, { left: `${r.x}px`, top: `${r.y}px` })
    }
    const item: Item = { entry, row, round }
    this.items = sortEntries([...this.items, item], x => x.entry.order)
    this.rows.replaceChildren(...this.items.map(x => x.row))
    this.panel.replaceChildren(...this.items.flatMap(x => (x.round ? [x.round] : [])))
    this.refresh()
    return () => {
      if (this.items.some(x => x.row === row)) this.remove(entry.id)
    }
  }

  /** Re-reads every entry's `isOpen()` (also polled). */
  refresh(): void {
    this.tab.setDisabled(this.items.length === 0)
    if (!this.items.length && this.isMenuOpen) this.closeMenu()
    for (const { entry, row, round } of this.items) {
      let open = false
      try {
        open = entry.isOpen()
      } catch {
        open = false
      }
      row.classList.toggle('on', open)
      round?.classList.toggle('is-press', open)
    }
  }

  /** The registered ids in order (for tests and the key help). */
  get ids(): string[] {
    return this.items.map(x => x.entry.id)
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    if (typeof document !== 'undefined') document.removeEventListener('pointerdown', this.onDocDown, true)
    this.items = []
    this.root.remove()
    this.panel.remove()
    this.tab.remove()
  }

  private remove(id: string): void {
    const i = this.items.findIndex(x => x.entry.id === id)
    if (i < 0) return
    const it = this.items[i]!
    it.row.remove()
    it.round?.remove()
    this.items.splice(i, 1)
    this.refresh()
  }
}
