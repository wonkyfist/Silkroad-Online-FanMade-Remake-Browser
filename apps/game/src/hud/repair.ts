/**
 * Repair at the Blacksmith and the Protector Trader (docs/SYSTEMS_COMBAT.md §3.3-3.4, docs/UI.md §4.6; lane DR).
 *
 * Retail puts **Repair** and **Repair all** in the shop window of a repairing NPC (`ifstore.txt`, decision D13): they
 * mount in the ShopWindow footer through M6 `addFooterButton` and show only while the NPC's `npcDialog.services`
 * include `'repair'`.
 * - **Repair** toggles the hammer cursor (M12 `setCursor('repair')`): clicking a bag or equipment item sends
 *   `repair {npc, items: [ref]}`; right click, Esc, or the button again ends it, and so does closing the shop.
 * - **Repair all** asks (M13 `MessageBox.confirm`) with the retail line and the total (a client-side preview from the
 *   catalog: ceil(repairCost × missing / max), the server's formula), then sends `repair {npc}`.
 * - Both are disabled with "No item needs repairing." while nothing is damaged.
 * The top of this file is DOM-free (durability states, prices, targets, refs): the slot decorator, the tooltip and the
 * warnings share it, and apps/game/test/repair.test.ts covers it.
 */
import { EQUIP_SLOTS, type ClientMessage, type EquipSlot, type ItemDef, type ItemStack, type RepairRef } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { Listeners } from '../ui/dom.ts'
import type { KitButton } from '../ui/kit/button.ts'
import { setCursor } from '../ui/kit/cursor.ts'
import { MessageBox } from '../ui/kit/dialog.ts'
import { formatNumber } from './items.ts'
import type { ShopWindow } from './shop.ts'

// ---- pure rules (the server's durability.ts, mirrored) ---------------------------------------------------------------

/** DUR_WARN_PCT default: at or below this share of max an item is "almost broken" (the red pulse). */
export const DUR_WARN_PCT = 10

export type DurabilityState = 'ok' | 'low' | 'broken'

type DurDef = Pick<ItemDef, 'stats'> | undefined | null
type RepairDef = Pick<ItemDef, 'stats' | 'canRepair' | 'repairCost'> | undefined | null

/** The top of the def's durability roll; null when the item never wears. */
export function maxDurability(def: DurDef): number | null {
  const max = def?.stats?.durability?.[1]
  return typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.round(max) : null
}

/** Current durability (absent = full), clamped to 0..max. */
export function curDurability(stack: Pick<ItemStack, 'durability'>, max: number): number {
  const d = stack.durability
  return d === undefined || d === null ? max : Math.max(0, Math.min(max, Math.round(d)))
}

/** ok / low (<= DUR_WARN_PCT of max) / broken (0); null for an item without durability. */
export function durabilityState(stack: Pick<ItemStack, 'durability'>, def: DurDef, warnPct = DUR_WARN_PCT): DurabilityState | null {
  const max = maxDurability(def)
  if (max === null) return null
  const cur = curDurability(stack, max)
  if (cur <= 0) return 'broken'
  return cur <= (max * warnPct) / 100 ? 'low' : 'ok'
}

export function isRepairable(def: RepairDef): boolean {
  return !!def && def.canRepair !== false && (def.repairCost ?? 0) > 0 && maxDurability(def) !== null
}

/** Repair price of one item: ceil(repairCost × missing / max); 0 when full or not repairable. */
export function repairPrice(def: RepairDef, stack: Pick<ItemStack, 'durability'>): number {
  if (!isRepairable(def)) return 0
  const max = maxDurability(def)!
  const missing = max - curDurability(stack, max)
  return missing > 0 ? Math.ceil(((def!.repairCost ?? 0) * missing) / max) : 0
}

export interface RepairTarget {
  ref: RepairRef
  code: string
  price: number
}

/** What the inventory needs repaired (worn items first, then the bag), each with its price. */
export interface InvView {
  bag: readonly (ItemStack | null)[]
  equip: Partial<Record<EquipSlot, ItemStack>>
}
export type DefLookup = (code: string) => ItemDef | undefined

export function repairTargets(inv: InvView, def: DefLookup): RepairTarget[] {
  const out: RepairTarget[] = []
  for (const slot of EQUIP_SLOTS) {
    const s = inv.equip[slot]
    const price = s ? repairPrice(def(s.code), s) : 0
    if (s && price > 0) out.push({ ref: { equip: slot }, code: s.code, price })
  }
  inv.bag.forEach((s, bag) => {
    const price = s ? repairPrice(def(s.code), s) : 0
    if (s && price > 0) out.push({ ref: { bag }, code: s.code, price })
  })
  return out
}

export function repairTotal(targets: readonly RepairTarget[]): number {
  return targets.reduce((sum, x) => sum + x.price, 0)
}

/** The repair ref of a slot element (`data-bag` / `data-equip` from hud/slots.ts SlotView); null for anything else. */
export function repairRefOf(e: { dataset: DOMStringMap } | null | undefined): RepairRef | null {
  if (!e) return null
  const bag = e.dataset.bag
  if (bag !== undefined && /^\d+$/.test(bag)) return { bag: Number(bag) }
  const equip = e.dataset.equip
  if (equip !== undefined && (EQUIP_SLOTS as readonly string[]).includes(equip)) return { equip: equip as EquipSlot }
  return null
}

export type HammerCheck = { ok: true; price: number } | { ok: false; why: 'empty' | 'unrepairable' | 'full' | 'gold' }

/** Whether a hammer click on `ref` is worth sending (the server decides; this only avoids pointless requests). */
export function hammerCheck(inv: InvView, def: DefLookup, ref: RepairRef, gold: number): HammerCheck {
  const s = 'equip' in ref ? inv.equip[ref.equip] : inv.bag[ref.bag]
  if (!s) return { ok: false, why: 'empty' }
  const d = def(s.code)
  if (!isRepairable(d)) return { ok: false, why: 'unrepairable' }
  const price = repairPrice(d, s)
  if (price <= 0) return { ok: false, why: 'full' }
  if (price > gold) return { ok: false, why: 'gold' }
  return { ok: true, price }
}

/** `repair {npc, items?}` (absent = repair all). */
export function repairIntent(npc: number, items?: readonly RepairRef[]): ClientMessage {
  return items ? { t: 'repair', npc, items: items.map(r => ({ ...r })) } : { t: 'repair', npc }
}

/** The footer buttons show for an NPC that offers repair. */
export const repairWhen = (services: readonly string[]): boolean => services.includes('repair')

export const REPAIR_BUTTON_ID = 'dr-repair'
export const REPAIR_ALL_BUTTON_ID = 'dr-repair-all'
const FOOTER_BUTTON_W: readonly [string, number][] = [[REPAIR_BUTTON_ID, 52], [REPAIR_ALL_BUTTON_ID, 70]]

// ---- the footer buttons and the hammer (DOM) ------------------------------------------------------------------------

export interface RepairHost {
  readonly art: Art
  inventory(): InvView
  def: DefLookup
  gold(): number
  /** The NPC of the open conversation (null when none). */
  npc(): number | null
  send(msg: ClientMessage): boolean
  toast(text: string, kind?: 'info' | 'error'): void
}

/**
 * Repair / Repair all on one ShopWindow, and the hammer mode. `refresh()` after inventory or gold changes;
 * `tick()` once a frame (ends the hammer when the shop closed); `dispose()` removes the buttons.
 */
export class RepairControls {
  private readonly ls = new Listeners()
  private readonly offs: (() => void)[] = []
  private hammer = false
  private asking = false

  constructor(readonly shop: ShopWindow, private readonly host: RepairHost) {
    this.offs.push(shop.addFooterButton({ id: REPAIR_BUTTON_ID, label: t('dur.repair'), when: repairWhen, onClick: () => this.toggleHammer() }))
    this.offs.push(shop.addFooterButton({ id: REPAIR_ALL_BUTTON_ID, label: t('dur.repairAll'), when: repairWhen, onClick: () => void this.repairAll() }))
    // The footer host is 126 px wide with a 4 px gap (hud/shop.ts): both buttons fit beside the gold row, uncut.
    for (const [id, w] of FOOTER_BUTTON_W) {
      const b = this.button(id)
      if (b) b.style.width = `${w}px`
    }
    this.refresh()
  }

  get hammerOn(): boolean {
    return this.hammer
  }

  private button(id: string): KitButton | null {
    return this.shop.root.querySelector<HTMLButtonElement>(`[data-footer="${id}"]`) as KitButton | null
  }

  /** Enables / disables the buttons from the inventory; the tooltip gives the total or "No item needs repairing." */
  refresh(): void {
    const targets = repairTargets(this.host.inventory(), this.host.def)
    const none = targets.length === 0
    const one = this.button(REPAIR_BUTTON_ID)
    const all = this.button(REPAIR_ALL_BUTTON_ID)
    one?.setDisabled?.(none)
    all?.setDisabled?.(none)
    if (one) one.title = none ? t('dur.nothing') : t('dur.repairHint')
    if (all) all.title = none ? t('dur.nothing') : t('dur.repairAllHint', { gold: formatNumber(repairTotal(targets)) })
    one?.classList.toggle('dr-active', this.hammer)
    if (none && this.hammer) this.stopHammer()
  }

  tick(): void {
    if (this.hammer && (!this.shop.isOpen || this.host.npc() === null)) this.stopHammer()
  }

  toggleHammer(): void {
    if (this.hammer) return this.stopHammer()
    if (repairTargets(this.host.inventory(), this.host.def).length === 0) return this.host.toast(t('dur.nothing'), 'error')
    this.hammer = true
    setCursor('repair')
    this.button(REPAIR_BUTTON_ID)?.classList.add('dr-active')
    this.host.toast(t('dur.hammerOn'))
    // Capture phase: the hammer click never starts a drag, a use or a move.
    this.ls.on(window, 'pointerdown', ev => this.onPointer(ev), { capture: true })
    this.ls.on(window, 'click', ev => this.swallow(ev), { capture: true })
    this.ls.on(window, 'contextmenu', ev => this.swallow(ev), { capture: true })
    this.ls.on(window, 'keydown', ev => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      this.stopHammer()
    }, { capture: true })
  }

  stopHammer(): void {
    this.ending = false
    this.swallowNext = false
    if (!this.hammer) return
    this.hammer = false
    this.ls.clear()
    setCursor('normal')
    this.button(REPAIR_BUTTON_ID)?.classList.remove('dr-active')
  }

  private swallowNext = false
  private ending = false

  private swallow(ev: Event): void {
    if (ev.type === 'contextmenu' && this.hammer) {
      // Never open a menu or use an item while the hammer is on.
      ev.preventDefault()
      ev.stopImmediatePropagation()
      if (this.ending) this.stopHammer()
      return
    }
    if (!this.swallowNext) return
    this.swallowNext = false
    ev.preventDefault()
    ev.stopImmediatePropagation()
  }

  private onPointer(ev: PointerEvent): void {
    const target = ev.target instanceof Element ? ev.target : null
    // The Repair button itself toggles through its own click.
    if (target?.closest(`[data-footer="${REPAIR_BUTTON_ID}"]`)) return
    if (ev.button === 2) {
      // Right click ends the hammer; its contextmenu is swallowed first (it would use a bag item).
      ev.preventDefault()
      ev.stopImmediatePropagation()
      this.swallowNext = true
      this.ending = true
      setTimeout(() => this.ending && this.stopHammer(), 600)
      return
    }
    if (ev.button !== 0) return
    const slot = target?.closest<HTMLElement>('[data-bag], [data-equip]') ?? null
    const ref = repairRefOf(slot)
    if (!ref) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    this.swallowNext = true
    this.repairOne(ref)
  }

  /** One hammer click on `ref`. */
  repairOne(ref: RepairRef): void {
    const npc = this.host.npc()
    if (npc === null) return this.stopHammer()
    const check = hammerCheck(this.host.inventory(), this.host.def, ref, this.host.gold())
    if (!check.ok) {
      if (check.why === 'empty') return
      const key = check.why === 'unrepairable' ? 'dur.unrepairable' : check.why === 'full' ? 'dur.itemFull' : 'dur.noGold'
      return this.host.toast(t(key), 'error')
    }
    this.host.send(repairIntent(npc, [ref]))
  }

  /** Repair all: the confirmation with the total, then `repair {npc}`. */
  async repairAll(): Promise<void> {
    if (this.asking) return
    this.stopHammer()
    const targets = repairTargets(this.host.inventory(), this.host.def)
    if (targets.length === 0) return this.host.toast(t('dur.nothing'), 'error')
    const total = repairTotal(targets)
    if (total > this.host.gold()) return this.host.toast(t('dur.noGold'), 'error')
    this.asking = true
    let yes = false
    try {
      yes = await MessageBox.confirm({
        art: this.host.art,
        title: t('dur.confirmTitle'),
        text: `${t('dur.confirmText')} ${t('dur.confirmCost', { gold: formatNumber(total) })}`,
        ok: t('dur.confirmOk'),
        cancel: t('kit.cancel'),
      })
    } finally {
      this.asking = false
    }
    const npc = this.host.npc()
    if (!yes || npc === null || !this.shop.isOpen) return
    this.host.send(repairIntent(npc))
  }

  dispose(): void {
    this.stopHammer()
    for (const off of this.offs.splice(0)) off()
  }
}
