/**
 * The Main window's Inventory tab (hotkey I; docs/UI.md §4.6): the bag panel on the left and the equipment panel on
 * the right, as retail `ifmainpopup.txt` lays them out (bag `GDR_INVENTORY` (13,63,176,333), equipment
 * `GDR_EQUIPMENT` (198,41,178,355)). The bag is `ifinventory.txt`: `int_window_` frame 176×308, lattice outline
 * (15,10,146,290), a 4 × 8 lattice at (18,13) (32 slots per page, the spin above it pages through bigger bags), the
 * `int_window_downbox` money strip at (0,305) with `com_moneybutton` (12,310) and the gold.
 * New items (docs/UX_GAPS.md W5): a slot whose item arrived (more of that item than before: a pickup, a buy, a reward)
 * glows until the pointer passes over it. Moving or splitting stacks inside the bag never marks anything.
 * Wave-8 mount point M8: `markSlots(key, slots)` OR-s lock marks (trade, stall) into the slots' blocked state on
 * every render.
 */
import type { ItemStack } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place } from '../ui/dom.ts'
import { iconButton } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { CONTROLS } from '../ui/kit/skins.ts'
import type { InventoryState } from './inventory-state.ts'
import { formatNumber, type ItemCatalog } from './items.ts'
import { ensureMainStyles, MainPage } from './main-window.ts'
import { SlotView } from './slots.ts'

export const INV_COLS = 4
export const INV_ROWS = 8
/** Bag slots per lattice page (retail 4 × 8). */
export const BAG_PAGE = INV_COLS * INV_ROWS
/** The bag panel and the equipment panel in page coordinates (the page origin is window (13, 38)). */
export const BAG_AT: readonly [number, number] = [0, 25]
export const EQUIP_AT: readonly [number, number] = [185, 3]

/** Total count per item code over a bag (W5). */
export function bagTotals(stacks: readonly (ItemStack | null)[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of stacks) if (s) out.set(s.code, (out.get(s.code) ?? 0) + s.count)
  return out
}

/**
 * Bag slots that hold newly arrived items (W5): among the changed `slots`, those whose item code has a larger total
 * than before and whose stack is new or grew. `before`/`after` are the whole bag; the totals default to the bag's and
 * should include the equipment (so taking a sword off does not count as a new sword).
 */
export function freshSlots(
  before: readonly (ItemStack | null)[],
  after: readonly (ItemStack | null)[],
  slots: readonly number[],
  was: ReadonlyMap<string, number> = bagTotals(before),
  now: ReadonlyMap<string, number> = bagTotals(after),
): number[] {
  const out: number[] = []
  for (const i of slots) {
    const a = after[i]
    if (!a || (now.get(a.code) ?? 0) <= (was.get(a.code) ?? 0)) continue
    const b = before[i]
    if (!b || b.code !== a.code || a.count > b.count) out.push(i)
  }
  return out
}

/** Number of lattice pages for a bag of `size` slots (at least 1). */
export function bagPages(size: number): number {
  return Math.max(1, Math.ceil(size / BAG_PAGE))
}

/** The lattice page that shows bag slot `i`. */
export function pageOfSlot(i: number): number {
  return Math.floor(Math.max(0, i) / BAG_PAGE)
}

/**
 * Bag lock marks (M8, decision D16): named sets of bag slots (a trade offer, a stall) that are drawn blocked on every
 * render until their owner clears them with an empty set. DOM-free.
 */
export class BagMarks {
  private readonly sets = new Map<string, ReadonlySet<number>>()

  /** Replaces the marks of `key`; an empty set clears them. Returns true when anything changed. */
  set(key: string, slots: ReadonlySet<number>): boolean {
    const had = this.sets.get(key)
    if (!slots.size) return this.sets.delete(key)
    if (had && had.size === slots.size && [...slots].every(s => had.has(s))) return false
    this.sets.set(key, new Set(slots))
    return true
  }

  has(slot: number): boolean {
    for (const s of this.sets.values()) if (s.has(slot)) return true
    return false
  }

  /** Every marked slot (for redraws after a change). */
  all(): number[] {
    const out = new Set<number>()
    for (const s of this.sets.values()) for (const i of s) out.add(i)
    return [...out]
  }
}

export interface SlotEvents {
  down(view: SlotView, ev: PointerEvent): void
  context(view: SlotView, ev: MouseEvent): void
  hover(view: SlotView, ev: PointerEvent | null): void
}

export class InventoryWindow extends MainPage {
  private readonly grid: HTMLElement
  private readonly goldText: HTMLElement
  private readonly usedText: HTMLElement
  private readonly pageText: HTMLElement
  private readonly spin: HTMLElement
  private readonly waiting: HTMLElement
  /** The equipment panel's host (the CharacterWindow's panel is mounted here). */
  readonly equipHost: HTMLElement
  private slots: SlotView[] = []
  private page = 0
  /** What each slot showed last (W5 compares against it). */
  private shown: (ItemStack | null)[] = []
  /** Slots with newly arrived items (W5), glowing until hovered. */
  private readonly fresh = new Set<number>()
  /** Item totals over bag and equipment when the slots were last drawn (W5). */
  private totals = new Map<string, number>()
  /** Lock marks of other features (M8). */
  readonly marks = new BagMarks()
  /** Whether the player can use a stack (hud/items.ts canUse); false tints the slot. Set by the HUD. */
  usable: (stack: ItemStack) => boolean = () => true

  constructor(art: Art, parent: HTMLElement, private readonly items: ItemCatalog, private readonly inv: InventoryState, private readonly events: SlotEvents) {
    super(art, parent, { id: 'inventory', tab: 'inventory', title: t('hud.inv.title') })
    ensureMainStyles()
    // ---- bag panel (ifinventory.txt) ---------------------------------------------------------------------
    const bag = place(el('div', 'inv-bag'), [BAG_AT[0], BAG_AT[1], 176, 333])
    const frame = new Frame(art, 'inner', { at: [0, 0, 176, 308], className: 'inv-bag-frame' })
    const outline = new Frame(art, 'lattice', { at: [15, 10, 146, 290], className: 'inv-lattice-outline' })
    this.grid = place(el('div', 'kit-slot-grid lattice inv-grid'), [18, 13, INV_COLS * 36, INV_ROWS * 36])
    this.grid.style.gridTemplateColumns = `repeat(${INV_COLS}, 36px)`
    const lattice = ['left_up', 'right_up', 'left_down', 'right_down'].map(p => `ifcommon/lattice_window/com_lattice_${p}`)
    if (lattice.every(k => art.has(k))) {
      const [lu, ru, ld, rd] = lattice.map(k => art.cssUrl(k))
      this.grid.style.setProperty('--lattice-lu', lu!)
      this.grid.style.setProperty('--lattice-ru', ru!)
      this.grid.style.setProperty('--lattice-ld', ld!)
      this.grid.style.setProperty('--lattice-rd', rd!)
      this.grid.classList.add('has-lattice')
    }
    this.waiting = place(el('div', 'inv-waiting kit-t-value', t('hud.inv.loading')), [18, 130, 144, 40])
    const money = place(el('div', 'inv-money'), [0, 305, 176, 28])
    if (art.has('inventory/int_window_downbox')) money.style.backgroundImage = art.cssUrl('inventory/int_window_downbox')
    else money.classList.add('no-art')
    const coin = iconButton(art, CONTROLS.money, { title: t('hud.inv.gold'), fallbackText: 'G', w: 20, h: 20, sfx: 'none', className: 'inv-coin' })
    place(coin, [12, 5, 20, 20])
    this.goldText = place(el('span', 'inv-gold kit-t-value kit-num'), [36, 8, 102, 14])
    const goldLabel = place(el('span', 'inv-gold-label kit-t-label', t('hud.inv.gold')), [143, 8, 30, 14])
    money.append(coin, this.goldText, goldLabel)
    money.title = t('hud.inv.gold')
    bag.append(frame.root, outline.root, this.grid, this.waiting, money)

    // ---- header strip: page spin and slot use -------------------------------------------------------------
    const prev = iconButton(art, CONTROLS.spinPrev, { title: t('inv.page.prev'), fallbackText: '<', w: 16, h: 16 }, () => this.setPage(this.page - 1))
    const next = iconButton(art, CONTROLS.spinNext, { title: t('inv.page.next'), fallbackText: '>', w: 16, h: 16 }, () => this.setPage(this.page + 1))
    this.pageText = el('span', 'inv-page kit-t-value kit-num')
    this.spin = place(el('div', 'inv-spin', prev, this.pageText, next), [4, 5, 60, 16])
    this.usedText = place(el('span', 'inv-used kit-t-label kit-num'), [70, 5, 104, 16])
    this.usedText.title = `${t('inv.used')}\n${t('hud.inv.hint')}`

    this.equipHost = place(el('div', 'inv-equip'), [EQUIP_AT[0], EQUIP_AT[1], 178, 355])
    this.body.append(this.spin, this.usedText, bag, this.equipHost)
    this.ls.on(this.body, 'wheel', ev => {
      if (bagPages(this.inv.bagSize) < 2 || !(ev.target instanceof Node) || !this.grid.contains(ev.target)) return
      ev.preventDefault()
      this.setPage(this.page + Math.sign(ev.deltaY))
    }, { passive: false })
    this.render()
  }

  /** Shows lattice page `p` (clamped). */
  setPage(p: number): void {
    const pages = bagPages(this.inv.bagSize)
    const next = Math.max(0, Math.min(pages - 1, p))
    if (next === this.page) return this.renderPage()
    this.page = next
    this.renderPage()
  }

  get currentPage(): number {
    return this.page
  }

  /** Rebuilds the slot views when the bag size changed, else redraws all slots. */
  render(): void {
    const size = this.inv.bagSize
    this.waiting.hidden = this.inv.known
    if (this.slots.length !== size) {
      this.grid.replaceChildren()
      this.slots = []
      for (let i = 0; i < size; i++) {
        const v = new SlotView(this.items, { kind: 'bag', slot: i }, 'hud-bag-slot', this.art)
        const k = i % BAG_PAGE
        v.root.classList.add(`q-${Math.floor(k / INV_COLS) % 2 ? 'd' : 'u'}${k % 2 ? 'r' : 'l'}`)
        this.hook(v)
        this.slots.push(v)
        this.grid.append(v.root)
      }
    }
    for (let i = 0; i < size; i++) this.setSlot(i)
    this.totals = this.inv.totals()
    this.renderPage()
    this.renderMoney()
  }

  /** Redraws the given bag slots only. */
  update(slots: number[]): void {
    if (this.slots.length !== this.inv.bagSize) return this.render()
    const totals = this.inv.totals()
    if (this.inv.known) {
      const after = this.shown.map((s, i) => (slots.includes(i) ? this.inv.item(i) : s))
      for (const i of freshSlots(this.shown, after, slots, this.totals, totals)) this.fresh.add(i)
    }
    this.totals = totals
    for (const i of slots) this.setSlot(i)
    this.renderPage()
    this.renderMoney()
  }

  /** M8: lock marks of `key` (an empty set clears them); redraws the affected slots. */
  markSlots(key: string, slots: ReadonlySet<number>): void {
    const before = this.marks.all()
    if (!this.marks.set(key, slots)) return
    for (const i of new Set([...before, ...this.marks.all()])) this.setSlot(i)
  }

  renderMoney(gold = this.inv.gold): void {
    this.goldText.textContent = formatNumber(gold)
    this.usedText.textContent = t('hud.inv.slots', { used: this.inv.used, size: this.inv.bagSize })
  }

  private renderPage(): void {
    const pages = bagPages(this.inv.bagSize)
    if (this.page >= pages) this.page = pages - 1
    const from = this.page * BAG_PAGE
    this.slots.forEach((v, i) => (v.root.hidden = i < from || i >= from + BAG_PAGE))
    this.spin.hidden = pages < 2
    this.pageText.textContent = `${this.page + 1}/${pages}`
    // A page with new items glows on its spin (so a pickup on page 2 is not missed).
    const freshElsewhere = [...this.fresh].some(i => pageOfSlot(i) !== this.page)
    this.spin.classList.toggle('fresh', freshElsewhere)
  }

  private setSlot(i: number): void {
    const stack = this.inv.item(i)
    this.shown[i] = stack ? { ...stack } : null
    if (!stack) this.fresh.delete(i)
    const v = this.slots[i]
    if (!v) return
    v.set(stack, !!stack && (!this.usable(stack) || this.marks.has(i)))
    v.root.classList.toggle('locked', this.marks.has(i))
    v.slot.setState('new', this.fresh.has(i))
  }

  /** The pointer passed over a slot: its new-item glow ends (W5). */
  private seen(i: number): void {
    if (!this.fresh.delete(i)) return
    this.slots[i]?.slot.setState('new', false)
    this.renderPage()
  }

  slot(i: number): SlotView | undefined {
    return this.slots[i]
  }

  stack(i: number): ItemStack | null {
    return this.inv.item(i)
  }

  private hook(v: SlotView): void {
    this.ls.on(v.root, 'pointerdown', ev => this.events.down(v, ev))
    this.ls.on(v.root, 'contextmenu', ev => {
      ev.preventDefault()
      this.events.context(v, ev)
    })
    this.ls.on(v.root, 'pointerenter', ev => {
      if (v.ref.kind === 'bag') this.seen(v.ref.slot)
      this.events.hover(v, ev)
    })
    this.ls.on(v.root, 'pointermove', ev => this.events.hover(v, ev))
    this.ls.on(v.root, 'pointerleave', () => this.events.hover(v, null))
  }
}
