/**
 * The retail Main window of the HUD (docs/UI.md §4.6, `GDR_MAINPOPUP` 388×408): Character (C), Inventory (I),
 * Skill (K), Party (P) and Quest (Q) are tabs of one mframe window with the retail side button strip. One Main window
 * exists per HUD layer; the page classes (InventoryWindow, CharacterWindow, SkillWindow, PartyWindow, QuestLogWindow)
 * extend `MainPage`, which keeps the old window API (`open`, `close`, `toggle`, `isOpen`, `z`, `onClose`, `dispose`)
 * by mapping it onto "the Main window on this tab". The key of the tab already shown closes the window.
 * Pages are laid out in native px of the page area (13, 38) … (377, 394) of the window, per `ifmainpopup.txt`.
 */
import type { Art } from '../ui/art.ts'
import { el, Listeners } from '../ui/dom.ts'
import { MainWindow } from '../ui/kit/main-window.ts'

/** The page area of the Main window (window px): `GDR_PLAYERINFO` and the other pages start at (13, 38). */
export const MAIN_PAGE_ORIGIN: readonly [number, number] = [13, 38]
export const MAIN_PAGE_SIZE: readonly [number, number] = [364, 356]

export type MainTabId = 'character' | 'inventory' | 'skill' | 'party' | 'quest'

const mains = new WeakMap<HTMLElement, MainWindow>()

/** The Main window of a HUD layer (created on first use; the HUD disposes it with `disposeMainWindow`). */
export function mainWindowFor(art: Art, layer: HTMLElement): MainWindow {
  let w = mains.get(layer)
  if (!w) {
    w = new MainWindow(art, layer, { id: 'main', title: '', className: 'hud-main-window hud-window' })
    const main = w
    // Retail shows seven side buttons. Action and Apprenticeship have no tab page, so their slots stay empty
    // (UI.md §4.6: hidden until they exist; MENU → Action opens its own window) and nextSlot() keeps them free.
    main.onClose = () => pageOf(main)?.hidden()
    mains.set(layer, main)
  }
  return w
}

export function disposeMainWindow(layer: HTMLElement): void {
  const w = mains.get(layer)
  if (!w) return
  mains.delete(layer)
  w.dispose()
}

const pages = new WeakMap<MainWindow, Map<string, MainPage>>()

function pageOf(main: MainWindow): MainPage | undefined {
  const id = main.tab
  return id ? pages.get(main)?.get(id) : undefined
}

export interface MainPageOptions {
  /** Class hook `hud-window-<id>` (kept from the separate-window days, for CSS and queries). */
  id: string
  tab: MainTabId
  /** Tooltip of the side button and the window title while the tab is shown. */
  title: string
}

/**
 * A tab page of the Main window with the old window API. `body` is the page element (native px, 364×356 from the
 * page origin); `root` is the Main window's root (for `.contains` checks).
 */
export class MainPage {
  readonly main: MainWindow
  readonly body: HTMLElement
  protected readonly ls = new Listeners()
  onClose: (() => void) | null = null
  private readonly unregister: () => void
  private pageShown = false

  constructor(protected readonly art: Art, parent: HTMLElement, protected readonly pageOpts: MainPageOptions) {
    this.main = mainWindowFor(art, parent)
    this.body = el('div', `hud-main-page hud-window-${pageOpts.id} main-page-${pageOpts.tab}`)
    this.body.dataset.page = pageOpts.tab
    let map = pages.get(this.main)
    if (!map) pages.set(this.main, (map = new Map()))
    map.set(pageOpts.tab, this)
    this.unregister = this.main.addTab({
      id: pageOpts.tab,
      title: pageOpts.title,
      page: this.body,
      onShow: () => {
        this.pageShown = true
        this.onOpen()
      },
      onHide: () => this.hidden(),
    })
    this.ls.on(this.body, 'contextmenu', ev => ev.preventDefault())
  }

  get root(): HTMLElement {
    return this.main.root
  }

  get isOpen(): boolean {
    return this.main.isShowing(this.pageOpts.tab)
  }

  /** Stacking order of the Main window when this page is shown (0 otherwise). */
  get z(): number {
    return this.isOpen ? this.main.z : 0
  }

  open(): void {
    if (this.isOpen) {
      this.main.raise()
      return
    }
    this.main.show(this.pageOpts.tab)
    // show() skips onShow when this tab was already current (the window was closed on it): open the page here.
    if (!this.pageShown) {
      this.pageShown = true
      this.onOpen()
    }
  }

  close(): void {
    if (this.isOpen) this.main.close()
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  raise(): void {
    this.main.raise()
  }

  setTitle(text: string): void {
    if (this.isOpen) this.main.setTitle(text)
  }

  /** The page became visible (tab shown or the window opened on it). */
  protected onOpen(): void {}

  /** The page stopped being visible (another tab, or the window closed). */
  protected onHide(): void {}

  /** @internal Called by the Main window when this page is hidden. */
  hidden(): void {
    if (!this.pageShown) return
    this.pageShown = false
    this.onHide()
    this.onClose?.()
  }

  dispose(): void {
    this.hidden()
    this.ls.clear()
    pages.get(this.main)?.delete(this.pageOpts.tab)
    this.unregister()
  }
}

// ---- styles of the Main window pages (native px, inside the zoomed HUD layer) ----------------------------------

const CSS = `
.hud-main-page { color: var(--c-text); font: 12px/15px var(--font-body); }
.kit-btn[hidden], .kit-toggle[hidden] { display: none; }
/* item_number digits are 8-px cells with a 5-px glyph: retail packs them 6 px apart. */
.hud-slot .kit-digit + .kit-digit { margin-left: -2px; }
.hud-main-page .no-art { background-color: rgba(0, 0, 0, 0.35); }

/* Inventory tab: bag (ifinventory.txt) and equipment (ifequipment.txt) */
.inv-bag, .inv-equip { position: absolute; }
.inv-grid { display: grid; grid-auto-rows: 36px; align-content: start; }
.inv-grid > .kit-slot[hidden] { display: none; }
.inv-grid .kit-slot.locked .kit-slot-icon::after { content: ''; position: absolute; inset: 0; box-shadow: inset 0 0 0 1px var(--c-warn); }
.inv-waiting { text-align: center; color: var(--c-label); }
.inv-waiting[hidden] { display: none; }
.inv-money { background: no-repeat 0 0 / 100% 100%; }
.inv-money.no-art { background: rgba(0, 0, 0, 0.5); box-shadow: inset 0 0 0 1px var(--c-rim); }
.inv-gold { text-align: right; white-space: nowrap; overflow: hidden; }
.inv-gold-label { white-space: nowrap; }
.inv-spin { display: flex; align-items: center; gap: 2px; }
.inv-spin[hidden] { display: none; }
.inv-page { min-width: 24px; text-align: center; font-size: 11px; }
.inv-spin.fresh .inv-page { color: var(--c-level); animation: kit-slot-new 1.2s ease-in-out infinite alternate; }
.inv-used { text-align: right; line-height: 16px; font-size: 11px; }
.eq-panel { position: absolute; inset: 0; }
.eq-sil { background: no-repeat 0 0 / 100% 100%; pointer-events: none; }
.eq-sil.no-art { box-shadow: inset 0 0 0 1px var(--c-rim); }
.eq-figure svg { width: 100%; height: 100%; fill: rgba(243, 213, 138, 0.06); stroke: rgba(243, 213, 138, 0.22); stroke-width: 1.2; }
.eq-name, .eq-level { text-align: center; }

/* Character tab (ifplayerinfo.txt) */
.chr-sheet .kit-section-caption { color: var(--c-heading); }
.chr-deco { background: no-repeat 0 0 / 100% 100%; pointer-events: none; }
.chr-deco.chr-tile, .chr-deco.chr-strip { background-repeat: repeat; background-size: auto; }
.chr-deco.no-art { background: none; }
.chr-label, .chr-value { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chr-right { text-align: right; }
.chr-exp-cur { color: #b2eb60; }
.chr-exp-next { color: #a5b78c; }
.chr-exp-pct { text-align: center; color: var(--c-label); }
.chr-points-label, .chr-points { color: var(--c-level); }
.chr-points.has-points { text-shadow: 0 0 4px rgba(255, 200, 80, 0.9), var(--t-outline); }
.chr-gauge .kit-gauge-text { font: bold 10px/12px var(--font-body); }
.chr-gauge-label { text-align: right; }

/* Party tab (ifparty.txt, ifpartyslot.txt) */
.pt-list { display: flex; flex-direction: column; }
.pt-list[hidden], .pt-none[hidden] { display: none; }
.pt-none { text-align: center; }
.pt-none-hint { margin-top: 8px; color: var(--c-label); font: 11px/15px var(--font-body); text-shadow: var(--t-shadow); }
.main-page-party .hud-party-wrow {
  position: relative; flex: none; width: 360px; height: 36px; margin-bottom: -3px; padding: 0; border: 0; border-radius: 0; box-shadow: none;
  background: var(--pt-slot, rgba(0, 0, 0, 0.4)) no-repeat 0 0 / 100% 100%; cursor: pointer;
}
.main-page-party .hud-party-wrow::before { content: ''; position: absolute; left: 2px; top: 4px; width: 28px; height: 28px; background: var(--pt-face, none) no-repeat 0 0 / 100% 100%; }
.main-page-party .hud-party-wrow:hover { filter: brightness(1.15); }
.main-page-party .hud-party-wrow.targeted { box-shadow: inset 0 0 0 1px var(--c-level); }
.main-page-party .hud-party-wrow .top { position: absolute; left: 44px; top: 4px; width: 250px; height: 15px; display: flex; gap: 4px; align-items: center; font: 12px/15px var(--font-body); color: var(--c-party-name); text-shadow: var(--t-outline); }
.main-page-party .hud-party-wrow.self .top { color: var(--c-caption); }
.main-page-party .hud-party-wrow .lv { order: 3; color: var(--c-party-name); font-size: 11px; }
.main-page-party .hud-party-wrow .name { order: 2; flex: 0 1 auto; max-width: 150px; }
.main-page-party .hud-party-wrow .crown { order: 1; }
.main-page-party .hud-party-wrow .state { order: 4; color: var(--c-bad); font-size: 11px; }
.main-page-party .hud-party-wrow .bar { position: absolute; left: 43px; width: 136px; height: 4px; margin: 0; border: 0; background: rgba(0, 0, 0, 0.6); }
.main-page-party .hud-party-wrow .bar.hp { top: 22px; }
.main-page-party .hud-party-wrow .bar.mp { top: 26px; }
.main-page-party .hud-party-wrow .bar i { background: var(--pt-hp, linear-gradient(#e0473a, #9c1e16)) no-repeat 0 0 / 136px 4px; }
.main-page-party .hud-party-wrow .bar.mp i { background: var(--pt-mp, linear-gradient(#4a9ef0, #1a4ea8)) no-repeat 0 0 / 136px 4px; }
.pt-board { background: no-repeat 0 0 / 100% 100%; }
.pt-board.no-art { background: rgba(0, 0, 0, 0.45); }
.pt-mode { display: flex; align-items: center; gap: 5px; margin: 0; padding: 0; border: 0; background: none; font: 12px/17px var(--font-body); text-shadow: var(--t-outline); white-space: nowrap; cursor: inherit; text-align: left; }
.pt-mode-items { color: #a79b7a; }
.pt-mode-exp { color: var(--c-label); }
.pt-mode:not(:disabled):hover { color: var(--c-highlight); }
.pt-mode:disabled { cursor: default; }
.pt-diamond { flex: none; width: 8px; height: 8px; background: no-repeat 0 0 / 100% 100%; }
.pt-mode:focus-visible { outline: 1px solid var(--c-level); outline-offset: 1px; }
`

let stylesInjected = false

/** Injects the Main window pages' stylesheet once. */
export function ensureMainStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-main-window'
  style.textContent = CSS
  document.head.append(style)
}
