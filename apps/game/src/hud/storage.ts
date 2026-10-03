/**
 * The storage window of the storage keeper (docs/SHOPS.md §5, §8.3; docs/UI.md §4.6, retail `ifstorageroom.txt`,
 * `mframe` 254×317 grown by one button row): the `sframe_wnd_` "Stored items" panel (9,38,236,241) with a 6 × 5
 * lattice at (21,71) and the page spin at (102,254) through the account's 150 slots, the stored gold on
 * `store/str_slot_01` (9,283,236,24) with `com_moneybutton` (78,286), and Deposit / Withdraw under it. It draws only
 * what the server's `storage` / `storageUpdate` said (StorageState); every move is an intent.
 *
 * Deposit: drag a bag item onto the window (onto a slot to choose it), or right click it in the bag while the storage
 * is open. Withdraw: drag a stored item onto the bag, or right click it. Shift while dropping (or right clicking a
 * stored item) asks how many of a stack to move. Storage -> storage moves, merges or swaps.
 */
import type { ItemStack, StorageGoldDir } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { type KitButton } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { Section } from '../ui/kit/section.ts'
import { formatNumber, type ItemCatalog, type TooltipLine } from './items.ts'
import { dropTargetAt, ensureNpcStyles, goldRow, hudBagDrag, itemSlot, ItemDrag, latticeClass, NpcWindow, pageSpin, slotGrid, smallButton } from './npc-ui.ts'
import type { BagView } from './shop-logic.ts'
import type { SlotView, Tooltip } from './slots.ts'
import { storageFee, type StorageChange, type StorageRef, type StorageState } from './storage-state.ts'

/** What the storage window needs from the feature. */
export interface StorageHost {
  readonly items: ItemCatalog
  readonly tooltip: Tooltip
  readonly state: StorageState
  readonly bag: BagView
  bagGold(): number
  level(): number | null
  /** A drop between the bag and the storage (`to.slot` -1 = the window, not a slot); `split` asks for a count. */
  move(from: StorageRef, to: StorageRef, split: boolean): void
  /** Right click on stored item `slot`. */
  withdraw(slot: number, split: boolean): void
  /** The gold buttons (the feature asks for the amount). */
  gold(dir: StorageGoldDir): void
}

const COLS = 6
const ROWS = 5
const PAGE = COLS * ROWS
export const STORAGE_W = 254
export const STORAGE_H = 345

/** Storage pages for `size` slots (at least 1). */
export function storagePages(size: number): number {
  return Math.max(1, Math.ceil(size / PAGE))
}

export class StorageWindow extends NpcWindow {
  private readonly section: Section
  private readonly grid: HTMLElement
  private readonly waiting: HTMLElement
  private readonly spin: ReturnType<typeof pageSpin>
  private readonly storedGold: HTMLElement
  private readonly bagGold: HTMLElement
  private readonly depositButton: KitButton
  private readonly withdrawButton: KitButton
  private readonly drag: ItemDrag<number>
  private slots: SlotView[] = []
  private page = 0
  private quiet = false
  /** The player closed the storage (close button): the conversation ends. */
  onEnd: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement, private readonly host: StorageHost) {
    ensureNpcStyles()
    super(art, parent, { id: 'npc-storage', title: t('storage.title'), width: STORAGE_W, height: STORAGE_H, at: [0.22, 0.35] })
    this.section = new Section(art, { at: this.r([9, 38, 236, 241]), caption: t('storage.items'), className: 'storage-panel' })
    const outline = new Frame(art, 'lattice', { at: this.r([18, 68, 218, 182]) })
    this.grid = this.at(slotGrid(art, COLS), [21, 71, COLS * 36, ROWS * 36])
    this.waiting = this.at(el('div', 'npc-empty', t('storage.loading')), [21, 140, 216, 30])
    this.spin = pageSpin(art, d => this.setPage(this.page + d))
    this.at(this.spin.root, [102, 254, 50, 16])
    const stored = goldRow(art, t('storage.gold'))
    this.at(stored.root, [9, 283, 236, 24])
    this.storedGold = stored.amount
    this.bagGold = this.at(el('div', 'npc-label storage-bag-gold'), [12, 314, 80, 16])
    this.depositButton = smallButton(art, t('storage.deposit'), 76)
    this.withdrawButton = smallButton(art, t('storage.withdraw'), 76)
    const row = this.at(el('div', 'npc-footer', this.depositButton, this.withdrawButton), [90, 310, 156, 24])
    this.body.append(this.section.root, outline.root, this.grid, this.waiting, this.spin.root, stored.root, this.bagGold, row)
    this.body.title = ''
    this.section.root.title = t('storage.hint')

    this.drag = new ItemDrag((slot, target, ev) => {
      if (target.kind === 'bag') this.host.move({ kind: 'storage', slot }, { kind: 'bag', slot: target.slot }, ev.shiftKey)
      else if (target.kind === 'inventory') this.host.move({ kind: 'storage', slot }, { kind: 'bag', slot: -1 }, ev.shiftKey)
      else if (target.kind === 'storage') this.host.move({ kind: 'storage', slot }, { kind: 'storage', slot: target.slot }, false)
    })
    this.drag.onStart = () => this.host.tooltip.hide()
    this.ls.on(this.depositButton, 'click', () => this.host.gold('deposit'))
    this.ls.on(this.withdrawButton, 'click', () => this.host.gold('withdraw'))
    this.ls.on(stored.coin, 'click', () => this.host.gold('deposit'))
    // A bag item dragged by the HUD and released over the storage: deposit it (into the slot under the pointer).
    this.ls.on(this.root, 'pointerup', ev => {
      const bag = hudBagDrag()
      if (bag === null) return
      const target = dropTargetAt(ev.clientX, ev.clientY)
      this.host.move({ kind: 'bag', slot: bag }, { kind: 'storage', slot: target.kind === 'storage' ? target.slot : -1 }, ev.shiftKey)
    })
    this.ls.on(this.grid, 'wheel', ev => {
      if (storagePages(this.host.state.size) < 2) return
      ev.preventDefault()
      this.setPage(this.page + Math.sign(ev.deltaY))
    }, { passive: false })
    this.onClose = () => {
      this.host.tooltip.hide()
      this.drag.cancel()
      if (!this.quiet) this.onEnd?.()
    }
    this.render()
  }

  /** Opens for storage keeper `npcName` (the grid fills when the snapshot arrives). */
  show(npcName: string): void {
    this.setTitle(t('storage.titleNpc', { name: npcName }))
    this.render()
    this.open()
    this.raise()
  }

  /** Hides without ending the conversation. */
  hide(): void {
    this.quiet = true
    try {
      this.close()
    } finally {
      this.quiet = false
    }
  }

  /** Redraws the changed slots (all of them for a snapshot or a size change) and the gold lines. */
  render(change?: StorageChange): void {
    const st = this.host.state
    this.waiting.hidden = st.known
    if (!change || change.snapshot || this.slots.length !== st.size) {
      this.grid.replaceChildren()
      this.slots = []
      for (let i = 0; i < st.size; i++) {
        const v = itemSlot(this.host.items, 'storage', i)
        v.root.classList.add(latticeClass(i % PAGE, COLS))
        this.hook(v, i)
        this.slots.push(v)
        this.grid.append(v.root)
      }
      this.slots.forEach((v, i) => v.set(st.item(i)))
    } else {
      for (const i of change.slots) this.slots[i]?.set(st.item(i))
    }
    this.section.setCaption(st.known ? `${t('storage.items')}  ${t('storage.used', { used: st.used, size: st.size })}` : t('storage.items'))
    this.renderPage()
    this.renderGold()
  }

  renderGold(): void {
    const st = this.host.state
    this.storedGold.textContent = st.known ? formatNumber(st.gold) : '-'
    this.bagGold.textContent = t('storage.bagGold', { gold: formatNumber(this.host.bagGold()) })
    this.depositButton.setDisabled(!st.known || this.host.bagGold() < 1)
    this.withdrawButton.setDisabled(!st.known || st.gold < 1)
  }

  override dispose(): void {
    this.drag.dispose()
    super.dispose()
  }

  private setPage(p: number): void {
    const next = Math.max(0, Math.min(storagePages(this.host.state.size) - 1, p))
    if (next === this.page) return
    this.page = next
    this.host.tooltip.hide()
    this.renderPage()
  }

  private renderPage(): void {
    const pages = storagePages(this.host.state.size)
    if (this.page >= pages) this.page = pages - 1
    const from = this.page * PAGE
    this.slots.forEach((v, i) => (v.root.hidden = i < from || i >= from + PAGE))
    this.spin.root.hidden = pages < 2
    this.spin.set(this.page, pages)
  }

  private hook(v: SlotView, i: number): void {
    this.ls.on(v.root, 'pointerdown', ev => {
      if (ev.button === 0 && v.stack) this.drag.begin(v, ev, i)
    })
    this.ls.on(v.root, 'contextmenu', ev => {
      ev.preventDefault()
      this.host.tooltip.hide()
      if (v.stack) this.host.withdraw(i, ev.shiftKey)
    })
    const hover = (ev: PointerEvent | null) => {
      if (!ev || !v.stack || this.drag.dragging) return this.host.tooltip.hide()
      this.host.tooltip.show(this.tooltip(v.stack), ev.clientX, ev.clientY)
    }
    this.ls.on(v.root, 'pointerenter', ev => hover(ev))
    this.ls.on(v.root, 'pointermove', ev => hover(ev))
    this.ls.on(v.root, 'pointerleave', () => hover(null))
  }

  private tooltip(stack: ItemStack): TooltipLine[] {
    const level = this.host.level()
    const lines = this.host.items.tooltip(stack, { player: level === null ? null : { level } }).filter(l => l.cls !== 'hint')
    const fee = storageFee(this.host.items.def(stack.code), 1)
    if (fee > 0) lines.push({ text: t('storage.fee', { gold: formatNumber(fee) }), cls: 'desc' })
    lines.push({ text: t('storage.hintStored'), cls: 'hint' })
    return lines
  }
}
