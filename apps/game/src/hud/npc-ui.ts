/**
 * Pieces shared by the NPC dialog, shop and storage windows: the `NpcWindow` base (a kit mframe window whose body is
 * laid out in retail window px), their CSS (injected once), the shop tab strip, lattice grids of item slots that are
 * not bag slots, a small item drag for goods and stored items, the gold row, the count / gold amount dialog (the kit
 * MessageBox, retail msgbox2), and reading the HUD's own bag drag when it is released over our windows.
 */
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place, type Rect } from '../ui/dom.ts'
import { button, iconButton, type KitButton } from '../ui/kit/button.ts'
import { MessageBox } from '../ui/kit/dialog.ts'
import { Frame } from '../ui/kit/frame.ts'
import { CONTROLS } from '../ui/kit/skins.ts'
import { Window } from '../ui/kit/window.ts'
import type { ItemCatalog } from './items.ts'
import { SlotView } from './slots.ts'

/** The title strip of an mframe window: bodies of NPC windows start under it. */
export const TITLE_H = 36

/**
 * An NPC-service window (dialog, shop, storage) on the kit window: `mframe` chrome, the old `.hud-window` /
 * `.hud-window-<id>` classes (drop targets and CSS use them), and `at(rect)` to place a child at retail window px.
 */
export class NpcWindow extends Window {
  constructor(art: Art, parent: HTMLElement, opts: { id: string; title: string; width: number; height: number; at: [number, number] }) {
    super(art, parent, { ...opts, frame: 'main', inset: [TITLE_H, 0, 0, 0] })
    this.root.classList.add('hud-window', `hud-window-${opts.id}`, 'npc-window')
    this.titleStrip.classList.add('hud-window-title')
    this.body.classList.add('hud-window-body')
  }

  /** Places `e` at a retail rect of the window (x, y from the window's top-left). */
  protected at<T extends HTMLElement>(e: T, rect: Rect): T {
    return place(e, this.r(rect))
  }

  /** A retail window rect in body px (the body starts under the title strip). */
  protected r([x, y, w, h]: Rect): Rect {
    return [x, y - TITLE_H, w, h]
  }
}

const CSS = `
.npc-window .hud-window-body { overflow: visible; }
/* NPC talk box (if_npcwindow.txt / if_npctalk.txt) */
.npc-talk-scroll .kit-scroll-view { padding: 3px 4px 6px 3px; box-sizing: border-box; }
.npc-greeting { color: var(--c-text); font: 12px/17px var(--font-body); text-shadow: var(--t-shadow); white-space: pre-wrap; user-select: text; margin-bottom: 10px; }
.npc-greeting:empty { display: none; }
.npc-options { display: flex; flex-direction: column; gap: 2px; }
.npc-option {
  display: flex; align-items: center; gap: 8px; flex: none; min-height: 20px; margin: 0; padding: 1px 4px; border: 0; background: transparent;
  color: var(--c-label); font: 12px/18px var(--font-body); text-align: left; cursor: inherit; text-shadow: var(--t-shadow); text-decoration: underline; text-underline-offset: 3px;
}
.npc-option::before { content: ''; width: 12px; height: 12px; flex: none; background: var(--npc-diamond, none) no-repeat 0 0 / 100% 100%; }
.npc-option:hover, .npc-option:focus-visible { color: var(--c-highlight); outline: none; }
.npc-option.end { color: #b9ad8f; }
.hud-window-npc-dialog.quest-mode .npc-talk-scroll { visibility: hidden; }

/* shop and storage (ifstore.txt, ifstorageroom.txt) */
.npc-tabs { display: flex; gap: 1px; align-items: flex-end; }
.npc-tabs .kit-tab { flex: 0 1 auto; min-width: 56px; }
.npc-grid { display: grid; grid-auto-rows: 36px; align-content: start; }
.npc-grid > .kit-slot[hidden] { display: none; }
.npc-empty { text-align: center; color: var(--c-label); font: 11px/15px var(--font-body); text-shadow: var(--t-shadow); pointer-events: none; }
.npc-empty[hidden] { display: none; }
.hud-slot.npc-selected::before { content: ''; position: absolute; left: 1px; top: 1px; width: 34px; height: 34px; box-shadow: inset 0 0 0 1px var(--c-level); pointer-events: none; z-index: 1; }
.npc-spin { display: flex; align-items: center; justify-content: space-between; }
.npc-spin[hidden] { display: none; }
.npc-spin-text { flex: 1; text-align: center; font: 11px/16px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); }
.npc-tile { background-repeat: repeat; }
.npc-info { display: flex; flex-direction: column; justify-content: center; padding: 0 6px; box-sizing: border-box; }
.npc-info-name { color: var(--c-text); font: 12px/15px var(--font-body); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.npc-info-price { color: var(--c-level); font: 11px/14px var(--font-body); text-shadow: var(--t-outline); white-space: nowrap; }
.npc-info-price.bad { color: var(--c-bad); }
.npc-redeem { background: no-repeat 0 0 / 100% 100%; }
.npc-redeem-label { color: var(--c-label); font: 11px/16px var(--font-body); text-shadow: var(--t-outline); text-align: center; }
.npc-row { display: flex; align-items: center; gap: 4px; }
.npc-grow { flex: 1; }
.npc-footer { display: flex; gap: 4px; justify-content: center; align-items: center; }
.npc-goldrow { display: flex; align-items: center; gap: 6px; padding: 0 10px 0 6px; box-sizing: border-box; background: no-repeat 0 0 / 100% 100%; }
.npc-goldrow.no-art { background: rgba(0, 0, 0, 0.5); box-shadow: inset 0 0 0 1px var(--c-rim); }
.npc-label { color: var(--c-label); font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); white-space: nowrap; }
.npc-gold { margin-left: auto; color: var(--c-text); font: 12px/14px var(--font-body); text-shadow: var(--t-outline); font-variant-numeric: tabular-nums; }
.npc-hint { text-align: center; color: #a89d82; font: 10px/12px var(--font-body); text-shadow: var(--t-shadow); }
/* UI-H: the retail casting bar GDR_DELAY_GAUGE_BOARD (ifdelayinfo.txt): com_casting_window 192x36 at x = (W-192)/2,
   y = H-162 (416,606 at 1024x768); name (0,7,167,12) centred, gauge (6,27,184,8) com_casting_gauge_return. */
.npc-cast {
  position: absolute; left: calc(50% - 96px); top: calc(100% - 162px); width: 192px; height: 36px;
  pointer-events: none; background: var(--cast-window, rgba(0, 0, 0, 0.6)) no-repeat 0 0 / 100% 100%; transition: opacity 0.5s ease;
}
.npc-cast[hidden] { display: none; }
.npc-cast.fading { opacity: 0; }
.npc-cast-head { position: absolute; left: 6px; top: 6px; width: 180px; height: 14px; display: flex; justify-content: center; gap: 8px; color: var(--c-text); font: 12px/14px var(--font-body); text-shadow: var(--t-outline, 0 1px 1px #000); white-space: nowrap; }
.npc-cast-left { color: var(--c-level); font-variant-numeric: tabular-nums; }
.npc-cast-left:empty { display: none; }
.npc-cast-track { position: absolute; left: 6px; top: 27px; width: 184px; height: 8px; overflow: hidden; }
.npc-cast-fill { width: 0; height: 100%; background: var(--cast-gauge, linear-gradient(#ffe9a0, #d09a2c 55%, #8a5d12)) no-repeat 0 0 / 184px 8px; }
.npc-cast.stopped .npc-cast-fill { filter: hue-rotate(-40deg) saturate(1.6) brightness(0.8); }
`

let injected = false
export function ensureNpcStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-npc'
  style.textContent = CSS
  document.head.append(style)
}

/** Lattice cells behind a grid of `cols` columns (the four com_lattice quarters, as the inventory). */
export function slotGrid(art: Art, cols: number): HTMLElement {
  const g = el('div', 'npc-grid kit-slot-grid lattice')
  g.style.gridTemplateColumns = `repeat(${cols}, 36px)`
  const lattice = ['left_up', 'right_up', 'left_down', 'right_down'].map(p => `ifcommon/lattice_window/com_lattice_${p}`)
  if (lattice.every(k => art.has(k))) {
    const [lu, ru, ld, rd] = lattice.map(k => art.cssUrl(k))
    g.style.setProperty('--lattice-lu', lu!)
    g.style.setProperty('--lattice-ru', ru!)
    g.style.setProperty('--lattice-ld', ld!)
    g.style.setProperty('--lattice-rd', rd!)
    g.classList.add('has-lattice')
  }
  return g
}

/** The lattice quarter class of cell `i` in a page of `cols` columns. */
export function latticeClass(i: number, cols: number): string {
  return `q-${Math.floor(i / cols) % 2 ? 'd' : 'u'}${(i % cols) % 2 ? 'r' : 'l'}`
}

/** The lattice frame of a slot page: `int_window_` box, the lattice outline and the grid (ifstore.txt rects). */
export function latticeBox(art: Art, frame: Rect, outline: Rect): HTMLElement[] {
  return [new Frame(art, 'inner', { at: frame, className: 'npc-lattice-frame' }).root, new Frame(art, 'lattice', { at: outline }).root]
}

/** The retail page spin (`ifspincontrol.txt`: arrows at 0 and 34, text between; 50×16). */
export function pageSpin(art: Art, onStep: (d: -1 | 1) => void): { root: HTMLElement; set(page: number, pages: number): void } {
  const text = el('span', 'npc-spin-text kit-num')
  const prev = iconButton(art, CONTROLS.spinPrev, { title: t('inv.page.prev'), fallbackText: '<', w: 16, h: 16 }, () => onStep(-1))
  const next = iconButton(art, CONTROLS.spinNext, { title: t('inv.page.next'), fallbackText: '>', w: 16, h: 16 }, () => onStep(1))
  const root = el('div', 'npc-spin', prev, text, next)
  return {
    root,
    set(page, pages) {
      text.textContent = `${page + 1}/${Math.max(1, pages)}`
      prev.setDisabled(page <= 0)
      next.setDisabled(page >= pages - 1)
    },
  }
}

/**
 * An item slot that is not a bag slot: the SlotView drawing without `data-bag`, so the HUD's drag never mistakes it
 * for one; `data-<kind>` carries its index instead.
 */
export function itemSlot(items: ItemCatalog, kind: 'shop' | 'storage', index: number): SlotView {
  const v = new SlotView(items, { kind: 'bag', slot: index }, `npc-slot npc-slot-${kind}`)
  delete v.root.dataset.bag
  v.root.dataset[kind] = String(index)
  return v
}

/** The coin + label + amount strip (`store/str_slot_01` 236×24, or the inventory's downbox). */
export function goldRow(art: Art, label: string, bg = 'store/str_slot_01'): { root: HTMLElement; amount: HTMLElement; coin: KitButton } {
  const root = el('div', 'npc-goldrow')
  const key = art.has(bg) ? bg : 'inventory/int_window_downbox'
  if (art.has(key)) root.style.backgroundImage = art.cssUrl(key)
  else root.classList.add('no-art')
  const coin = iconButton(art, CONTROLS.money, { title: label, fallbackText: 'G', w: 20, h: 20, sfx: 'none' })
  const amount = el('span', 'npc-gold')
  root.append(coin, el('span', 'npc-label', label), amount)
  return { root, amount, coin }
}

/** A kit action button (`com_button`, grows to its label). */
export function smallButton(art: Art, label: string, w = 76): KitButton {
  return button(art, { label, minWidth: w })
}

// ---- where a drag was released -----------------------------------------------------------------------

export type DropTarget =
  | { kind: 'bag'; slot: number }
  | { kind: 'storage'; slot: number }
  | { kind: 'inventory' }
  | { kind: 'shop' }
  | { kind: 'storageWindow' }
  | { kind: 'window' }
  | { kind: 'outside' }

export function dropTargetAt(x: number, y: number): DropTarget {
  const hit = document.elementFromPoint(x, y) as HTMLElement | null
  if (!hit) return { kind: 'outside' }
  const bag = hit.closest<HTMLElement>('[data-bag]')
  if (bag?.dataset.bag !== undefined) return { kind: 'bag', slot: Number(bag.dataset.bag) }
  const st = hit.closest<HTMLElement>('[data-storage]')
  if (st?.dataset.storage !== undefined) return { kind: 'storage', slot: Number(st.dataset.storage) }
  if (hit.closest('.main-page-inventory')) return { kind: 'inventory' }
  if (hit.closest('.hud-window-npc-shop')) return { kind: 'shop' }
  if (hit.closest('.hud-window-npc-storage')) return { kind: 'storageWindow' }
  if (hit.closest('.hud-window, .hud-block, .kit-window')) return { kind: 'window' }
  return { kind: 'outside' }
}

/**
 * The bag slot the HUD's own drag is carrying, read at pointerup over one of our windows (element listeners run
 * before the HUD's window listener, and the HUD ignores releases over a window that has no bag slot there).
 */
export function hudBagDrag(): number | null {
  if (!document.body.classList.contains('hud-dragging')) return null
  const src = document.querySelector<HTMLElement>('.hud-slot.dragging[data-bag]')
  const n = src ? Number(src.dataset.bag) : NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

const DRAG_START_PX = 4

/** Pointer drag of goods and stored items: the same ghost and cursor as the HUD's bag drag. */
export class ItemDrag<T> {
  private active: { view: SlotView; payload: T; ghost: HTMLElement | null; sx: number; sy: number; id: number } | null = null
  private readonly offs: (() => void)[] = []
  onStart: (() => void) | null = null

  constructor(private readonly onDrop: (payload: T, target: DropTarget, ev: PointerEvent) => void) {
    const move = (ev: PointerEvent) => this.move(ev)
    const up = (ev: PointerEvent) => this.up(ev)
    const cancel = () => this.cancel()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('blur', cancel)
    this.offs.push(
      () => window.removeEventListener('pointermove', move),
      () => window.removeEventListener('pointerup', up),
      () => window.removeEventListener('blur', cancel),
    )
  }

  get dragging(): boolean {
    return !!this.active?.ghost
  }

  begin(view: SlotView, ev: PointerEvent, payload: T): void {
    if (ev.button !== 0 || !view.stack) return
    ev.preventDefault()
    this.cancel()
    this.active = { view, payload, ghost: null, sx: ev.clientX, sy: ev.clientY, id: ev.pointerId }
  }

  private move(ev: PointerEvent): void {
    const a = this.active
    if (!a || ev.pointerId !== a.id) return
    if (!a.ghost) {
      if (Math.hypot(ev.clientX - a.sx, ev.clientY - a.sy) < DRAG_START_PX) return
      a.ghost = a.view.ghost()
      document.body.append(a.ghost)
      a.view.root.classList.add('dragging')
      a.view.slot.setState('dragging', true)
      document.body.classList.add('hud-dragging')
      this.onStart?.()
    }
    a.ghost.style.left = `${ev.clientX}px`
    a.ghost.style.top = `${ev.clientY}px`
  }

  private up(ev: PointerEvent): void {
    const a = this.active
    if (!a || ev.pointerId !== a.id) return
    const started = !!a.ghost
    this.cancel()
    if (started) this.onDrop(a.payload, dropTargetAt(ev.clientX, ev.clientY), ev)
  }

  cancel(): void {
    const a = this.active
    this.active = null
    if (!a) return
    a.ghost?.remove()
    a.view.root.classList.remove('dragging')
    a.view.slot.setState('dragging', false)
    if (a.ghost) document.body.classList.remove('hud-dragging')
  }

  dispose(): void {
    this.cancel()
    for (const off of this.offs.splice(0)) off()
  }
}

// ---- count / gold amount dialog -------------------------------------------------------------------------

export interface AmountRequest {
  title: string
  body: string
  ok: string
  /** Largest amount allowed (1 = a plain confirmation without a field). */
  max: number
  initial: number
  /** Parses the typed text: a whole number in 1..max, or null. */
  parse(raw: string, max: number): number | null
  onOk(amount: number): void
}

/**
 * The amount / confirm dialog: the kit MessageBox (retail `msgbox2_window_`; the count box is the retail
 * MsgBoxDivideCount). Enter confirms and Esc cancels. Returns a function that closes it (as a cancel).
 */
export function amountDialog(art: Art, _parent: HTMLElement, req: AmountRequest): () => void {
  let open = true
  const done = (n: number | null) => {
    if (!open) return
    open = false
    if (n !== null) req.onOk(n)
  }
  const before = document.body.lastElementChild
  if (req.max > 1) void MessageBox.count({ title: req.title, text: req.body, max: req.max, initial: req.initial, ok: req.ok, art }).then(done)
  else void MessageBox.confirm({ title: req.title, text: req.body, ok: req.ok, cancel: t('hud.dialog.cancel'), art }).then(yes => done(yes ? 1 : null))
  // The box's shade is appended to <body> synchronously; closing it from outside sends it an Esc.
  const shade = document.body.lastElementChild !== before ? (document.body.lastElementChild as HTMLElement | null) : null
  return () => {
    if (!open) return
    open = false
    shade?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }
}
