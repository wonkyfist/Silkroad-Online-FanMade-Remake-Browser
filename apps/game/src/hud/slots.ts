/**
 * Item slots shared by the Main window's Inventory tab, the shop and the storage: the kit Slot (docs/UI.md §4.9: the
 * icon or a coloured square with the name's initials, `item_number` stack digits, the +N / magic / rare sign, the
 * `com_item_select` hover), the SRO tooltip (kit Tooltip, `frame_tooltip_` rim), and pointer drag-and-drop between
 * slots (ghost icon, dimmed source, glowing drop target). A drop only sends an intent; the slots redraw when the
 * server's inventoryUpdate arrives.
 * Wave-8 mount point M9 (decision D12): `registerSlotDecorator(fn)` adds signs (durability, magic, rare) to every
 * item slot render; the built-in sign is `plus` from the stack.
 */
import { rarityOf, type EquipSlot, type ItemDef, type ItemStack } from '@sro/shared'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { kitArt } from '../ui/kit/host.ts'
import { mergeSigns, Slot, type SlotSigns } from '../ui/kit/slot.ts'
import { Tooltip as KitTooltip, type KitTooltipLine } from '../ui/kit/tooltip.ts'
import { cooldownNow } from './cooldowns.ts'
import type { SlotRef } from './intents.ts'
import { isRareCode, type ItemCatalog } from './items.ts'

/**
 * Cooldown sweep (docs/WAVE_PLAN.md decision 19): a dark conic overlay that clears clockwise, driven by one CSS
 * animation (no per-frame work); `--hud-cd` is a registered number so the gradient can animate. Unusable items
 * (`set(stack, true)`) get a red tint; UX-A may restyle `.hud-slot.blocked`.
 */
const SLOT_CSS = `
@property --hud-cd { syntax: '<number>'; inherits: false; initial-value: 0; }
@keyframes hud-cd-sweep { from { --hud-cd: 0; } to { --hud-cd: 1; } }
.hud-slot-cd {
  position: absolute; left: 2px; top: 2px; width: 32px; height: 32px; pointer-events: none;
  background: conic-gradient(transparent 0turn calc(var(--hud-cd) * 1turn), rgba(0, 0, 0, 0.62) calc(var(--hud-cd) * 1turn) 1turn);
  animation-name: hud-cd-sweep; animation-timing-function: linear; animation-fill-mode: forwards;
}
.hud-slot-cd[hidden] { display: none; }
`
let slotCssInjected = false
function ensureSlotStyles(): void {
  if (slotCssInjected || typeof document === 'undefined') return
  slotCssInjected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-slots'
  style.textContent = SLOT_CSS
  document.head.append(style)
}

/**
 * The cooldown sweep on any 36 px slot element (item slots, the hotbar, the skill window): `set(readyAt, totalMs)`
 * on the CooldownClock's time; the `cooling` class is on `root` while it runs.
 */
export class CooldownSweep {
  private cd: HTMLElement | null = null

  constructor(private readonly root: HTMLElement, private readonly before: HTMLElement | null = null) {}

  set(readyAt: number, totalMs: number): void {
    const now = cooldownNow()
    const left = readyAt - now
    if (!(totalMs > 0) || !(left > 0)) {
      if (this.cd) this.cd.hidden = true
      this.root.classList.remove('cooling')
      return
    }
    ensureSlotStyles()
    // A fresh element restarts the CSS animation.
    const cd = el('div', 'hud-slot-cd')
    const total = Math.max(totalMs, left)
    cd.style.animationDuration = `${total.toFixed(0)}ms`
    cd.style.animationDelay = `${(left - total).toFixed(0)}ms`
    cd.addEventListener('animationend', () => {
      if (this.cd !== cd) return
      cd.hidden = true
      this.root.classList.remove('cooling')
    })
    if (this.cd) this.cd.replaceWith(cd)
    else if (this.before && this.before.parentElement === this.root) this.root.insertBefore(cd, this.before)
    else this.root.append(cd)
    this.cd = cd
    this.root.classList.add('cooling')
  }
}

/**
 * Drop targets outside the item slots (the hotbar, SK-C): asked first when an item drag ends; true = consumed.
 * Returns an unregister function.
 */
export type SlotDropTarget = (from: SlotRef, x: number, y: number) => boolean
const dropTargets = new Set<SlotDropTarget>()
export function addSlotDropTarget(fn: SlotDropTarget): () => void {
  dropTargets.add(fn)
  return () => void dropTargets.delete(fn)
}

// ---- M9: slot decorators ---------------------------------------------------------------------------------

/** A sign source applied to every item slot render (bag, equipment, storage, shop, hotbar items). */
export type SlotDecorator = (stack: ItemStack, def: ItemDef | undefined) => Partial<SlotSigns> | null | undefined
const decorators: SlotDecorator[] = []

/** Registers a slot decorator (wave-8 durability, alchemy); returns an unregister function. */
export function registerSlotDecorator(fn: SlotDecorator): () => void {
  decorators.push(fn)
  return () => {
    const i = decorators.indexOf(fn)
    if (i >= 0) decorators.splice(i, 1)
  }
}

/** The signs a stack shows: `plus` from the stack, then each decorator's partial (later wins). A throwing decorator is skipped. */
export function slotSigns(stack: ItemStack, def: ItemDef | undefined): SlotSigns {
  const parts: (Partial<SlotSigns> | null | undefined)[] = [{ plus: stack.plus ?? 0, rare: isRareCode(stack.code), rarity: rarityOf(stack.code) ?? undefined }]
  for (const fn of decorators) {
    try {
      parts.push(fn(stack, def))
    } catch (err) {
      console.error('[hud] slot decorator failed', err)
    }
  }
  return mergeSigns(...parts)
}

/** An item slot view: the kit Slot plus the slot's reference (`data-bag` / `data-equip`) for drag and drop. */
export class SlotView {
  readonly root: HTMLElement
  readonly slot: Slot
  stack: ItemStack | null = null

  constructor(private readonly items: ItemCatalog, readonly ref: SlotRef, className = '', art: Art = kitArt()) {
    this.slot = new Slot(art, items, { className: `hud-slot ${className}`.trim() })
    this.root = this.slot.root
    if (ref.kind === 'bag') this.root.dataset.bag = String(ref.slot)
    else this.root.dataset.equip = ref.slot
  }

  /**
   * Shows a cooldown sweep ending at `readyAt` (CooldownClock time, `performance.now()` ms) out of `totalMs`.
   * A time already past (or `totalMs` <= 0) clears it.
   */
  setCooldown(readyAt: number, totalMs: number): void {
    this.slot.setCooldown(readyAt, totalMs)
  }

  /** `blocked`: the player cannot use this item (level, gender, race); drawn with the red wash. */
  set(stack: ItemStack | null, blocked = false): void {
    this.stack = stack
    this.slot.set(stack, blocked)
    if (stack) this.slot.setSigns(slotSigns(stack, this.items.def(stack.code)))
  }

  /** A copy of the icon for the drag ghost. */
  ghost(): HTMLElement {
    const g = this.slot.ghost()
    g.classList.add('hud-drag-ghost')
    return g
  }
}

/**
 * The one floating tooltip (kit Tooltip: `frame_tooltip_` rim, zooms with the HUD, flips at the screen edges).
 * Showing the same lines again only moves it, so hover handlers may call `show` on every pointer move.
 */
export class Tooltip extends KitTooltip {
  private lastKey = ''

  constructor(art: Art) {
    super(art, { delayMs: 120 })
  }

  override show(lines: readonly KitTooltipLine[], x: number, y: number): void {
    const key = lines.map(l => `${l.cls}\u0001${l.text}`).join('\u0002')
    if (key === this.lastKey && this.visible) {
      this.move(x, y)
      return
    }
    this.lastKey = key
    super.show(lines, x, y)
  }

  override hide(): void {
    this.lastKey = ''
    super.hide()
  }
}

export interface DragHost {
  /** Released over another slot (or the same one). */
  onDrop(from: SlotRef, to: SlotRef, ev: PointerEvent): void
  /** Released outside every HUD window. */
  onDropOutside(from: SlotRef, ev: PointerEvent): void
}

const DRAG_START_PX = 4
const WINDOW_SELECTOR = '.hud-window, .hud-block, .kit-window'

/** Reads the slot under a point: `[data-bag]` / `[data-equip]` elements. */
export function slotAt(x: number, y: number): SlotRef | 'window' | null {
  const hit = document.elementFromPoint(x, y) as HTMLElement | null
  if (!hit) return null
  const slot = hit.closest<HTMLElement>('[data-bag], [data-equip]')
  if (slot?.dataset.bag !== undefined) return { kind: 'bag', slot: Number(slot.dataset.bag) }
  if (slot?.dataset.equip !== undefined) return { kind: 'equip', slot: slot.dataset.equip as EquipSlot }
  if (hit.closest(WINDOW_SELECTOR)) return 'window'
  return null
}

/**
 * Pointer drag of filled slots. The source slot dims, a ghost icon follows the cursor, the slot under it glows, and
 * the release point decides: another slot -> onDrop; outside every window -> onDropOutside; over a window but no
 * slot -> nothing.
 */
export class DragController {
  private active: { view: SlotView; ghost: HTMLElement | null; sx: number; sy: number; id: number } | null = null
  private over: HTMLElement | null = null
  private readonly offs: (() => void)[] = []
  onStart: (() => void) | null = null

  constructor(private readonly host: DragHost) {
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

  /** Call from a slot's pointerdown. */
  begin(view: SlotView, ev: PointerEvent): void {
    if (ev.button !== 0 || !view.stack) return
    ev.preventDefault()
    this.cancel()
    this.active = { view, ghost: null, sx: ev.clientX, sy: ev.clientY, id: ev.pointerId }
  }

  private move(ev: PointerEvent): void {
    const a = this.active
    if (!a || ev.pointerId !== a.id) return
    if (!a.ghost) {
      if (Math.hypot(ev.clientX - a.sx, ev.clientY - a.sy) < DRAG_START_PX) return
      a.ghost = a.view.ghost()
      document.body.append(a.ghost)
      a.view.slot.setState('dragging', true)
      a.view.root.classList.add('dragging')
      document.body.classList.add('hud-dragging')
      this.onStart?.()
    }
    a.ghost.style.left = `${ev.clientX}px`
    a.ghost.style.top = `${ev.clientY}px`
    this.hover(ev.clientX, ev.clientY, a.view.root)
  }

  /** The slot under the ghost glows (valid target). */
  private hover(x: number, y: number, source: HTMLElement): void {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null
    const slot = hit?.closest<HTMLElement>('[data-bag], [data-equip]') ?? null
    const next = slot && slot !== source ? slot : null
    if (next === this.over) return
    this.over?.classList.remove('drop-ok')
    this.over = next
    next?.classList.add('drop-ok')
  }

  private up(ev: PointerEvent): void {
    const a = this.active
    if (!a || ev.pointerId !== a.id) return
    const started = !!a.ghost
    this.cancel()
    if (!started) return
    for (const t of [...dropTargets]) {
      try {
        if (t(a.view.ref, ev.clientX, ev.clientY)) return
      } catch (err) {
        console.error('[hud] drop target failed', err)
      }
    }
    const target = slotAt(ev.clientX, ev.clientY)
    if (target === 'window') return
    if (target === null) this.host.onDropOutside(a.view.ref, ev)
    else this.host.onDrop(a.view.ref, target, ev)
  }

  cancel(): void {
    const a = this.active
    this.active = null
    this.over?.classList.remove('drop-ok')
    this.over = null
    if (!a) return
    a.ghost?.remove()
    a.view.slot.setState('dragging', false)
    a.view.root.classList.remove('dragging')
    document.body.classList.remove('hud-dragging')
  }

  dispose(): void {
    this.cancel()
    for (const off of this.offs.splice(0)) off()
  }
}
