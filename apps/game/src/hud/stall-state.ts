/**
 * The stall as the client knows it (docs/SYSTEMS_SOCIAL.md §4, §9.3; lane ST-C). No DOM here (unit-tested):
 *  - StallModel holds the one stall you own or visit, from the server's `stall` messages (full view on every change);
 *    the role follows `view.owner === selfId`;
 *  - `stallRows` is what the window draws per slot; `buyRequest` builds exactly the shown item (code, count, plus,
 *    durability) and price (the S1 / D47 guard: an owner who changed the listing meanwhile gets `stall_changed`, never
 *    a surprise price or a lower +N / broken copy);
 *  - price parsing (thousands separators, k / m / b suffixes, 0 and > 1 billion refused), the title / greeting
 *    code-point clamp, the nameplate sign from `EntityState.stall` / `entityUpdate.stall`, and the refusal lines.
 */
import {
  STALL_GREETING_MAX,
  STALL_PRICE_MAX,
  STALL_SLOTS,
  STALL_TITLE_MAX,
  STALL_VISITORS_MAX,
  type ActionFailReason,
  type ClientMessage,
  type EntityState,
  type GameplayRequest,
  type ItemDef,
  type ItemStack,
  type StallEndReason,
  type StallListing,
  type StallView,
} from '@sro/shared'
import { enStall } from '../i18n/en-stall.ts'
import type { StringKey } from '../i18n/index.ts'

export type StallRole = 'owner' | 'visitor'

/** Separators a typed price may carry (1,000,000 / 1 000 000 / 1'000'000 / 1_000_000). */
const SEPARATORS = /[,\s'_]/g
const SUFFIX: Readonly<Record<string, number>> = { k: 1e3, m: 1e6, b: 1e9 }

/**
 * A typed price in gold: digits with optional thousands separators, or a number with a k / m / b suffix ("250k",
 * "1.5m"). Null unless it is a whole number in 1..STALL_PRICE_MAX.
 */
export function parsePrice(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(SEPARATORS, '')
  if (!s) return null
  let n: number
  const m = /^(\d+(?:\.\d+)?)([kmb])$/.exec(s)
  if (m) n = Math.round(Number(m[1]) * SUFFIX[m[2]!]! * 1e6) / 1e6
  else if (/^\d+$/.test(s)) n = Number(s)
  else return null
  return Number.isSafeInteger(n) && n >= 1 && n <= STALL_PRICE_MAX ? n : null
}

/** 1234567 -> "1,234,567". */
/** Whether two listings show the same item (code, count, plus, durability) at the same price (S1, D47). */
export function sameListing(a: StallListing | null, b: StallListing | null): boolean {
  if (!a || !b) return a === b
  const x = a.stack
  const y = b.stack
  return x.code === y.code && x.count === y.count && (x.plus ?? 0) === (y.plus ?? 0) && x.durability === y.durability && a.price === b.price
}

/** The buyer's name for a listed stack: "Iron Blade +5", plus the broken marker at durability 0 (D47). */
export function buyItemLabel(name: string, stack: ItemStack, broken: string): string {
  const plus = stack.plus ? `${name} +${stack.plus}` : name
  return stack.durability === 0 ? `${plus} ${broken}` : plus
}

export function formatPrice(n: number): string {
  const v = Math.round(n)
  return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * The price field while typing: plain digits (and separators) are regrouped with commas; anything else (a suffix,
 * a decimal point) is left as typed so "1.5m" can be entered.
 */
export function formatPriceInput(raw: string): string {
  const s = raw.replace(SEPARATORS, '')
  if (!/^\d+$/.test(s)) return raw
  return formatPrice(Number(s.replace(/^0+(?=\d)/, '')))
}

/** The first `max` code points of `s` (the server counts code points, not UTF-16 units). */
export function clampCodePoints(s: string, max: number): string {
  const cps = [...s]
  return cps.length <= max ? s : cps.slice(0, max).join('')
}

export const cleanTitle = (s: string): string => clampCodePoints(s.trim(), STALL_TITLE_MAX)
export const cleanGreeting = (s: string): string => clampCodePoints(s.trim(), STALL_GREETING_MAX)

// ---- nameplate sign --------------------------------------------------------------------------------------

/** The stall sign of a spawned entity: its title, or null (no stall; only players have one). */
export function signOfState(s: Pick<EntityState, 'kind' | 'stall'>): string | null {
  return s.kind === 'player' && typeof s.stall === 'string' && s.stall !== '' ? s.stall : null
}

/** An entityUpdate's stall change: undefined = unchanged, null = closed (''), else the (new) title. */
export function signOfUpdate(msg: { stall?: string }): string | null | undefined {
  if (msg.stall === undefined) return undefined
  return msg.stall === '' ? null : msg.stall
}

// ---- the model ---------------------------------------------------------------------------------------------

export interface StallChange {
  /** A stall window should (now) show: the view went from none to one, or to another owner's. */
  opened: boolean
  /** The stall you owned or visited ended: why (null when it goes on, or when there was none). */
  ended: StallEndReason | 'gone' | null
  /** The role before the change (null = none). */
  was: StallRole | null
}

/** Where you run or visit a stall; `apply` takes each `stall` message. */
export class StallModel {
  view: StallView | null = null
  selfId: number | null = null

  get role(): StallRole | null {
    if (!this.view) return null
    return this.view.owner === this.selfId ? 'owner' : 'visitor'
  }

  get isOwner(): boolean {
    return this.role === 'owner'
  }

  get isVisitor(): boolean {
    return this.role === 'visitor'
  }

  /** True while the stall is open for buyers (else it is being modified). */
  get isOpen(): boolean {
    return this.view?.state === 'open'
  }

  /** The owner can change the goods only in `modify`. */
  get canEdit(): boolean {
    return this.isOwner && !this.isOpen
  }

  apply(msg: { stall: StallView | null; reason?: StallEndReason }): StallChange {
    const was = this.role
    const prevOwner = this.view?.owner ?? null
    this.view = msg.stall ? { ...msg.stall, items: normalizeItems(msg.stall.items) } : null
    if (!this.view) return { opened: false, ended: was ? (msg.reason ?? 'gone') : null, was }
    return { opened: prevOwner !== this.view.owner, ended: null, was }
  }

  /** Forget everything (world enter, disconnect). */
  reset(): void {
    this.view = null
  }

  listing(slot: number): StallListing | null {
    return this.view?.items[slot] ?? null
  }

  /** The bag slots the owner has on sale (locked in the bag while listed). */
  listedBags(): Set<number> {
    const out = new Set<number>()
    if (!this.isOwner) return out
    for (const l of this.view!.items) if (l && typeof l.bag === 'number') out.add(l.bag)
    return out
  }

  /** The stall slot listing bag slot `bag`, or -1. */
  slotOfBag(bag: number): number {
    if (!this.view) return -1
    return this.view.items.findIndex(l => l?.bag === bag)
  }

  /** The first empty stall slot, or -1. */
  freeSlot(): number {
    if (!this.view) return -1
    return this.view.items.findIndex(l => !l)
  }

  get listedCount(): number {
    return this.view ? this.view.items.filter(Boolean).length : 0
  }

  /** A visitor may buy listing `slot` now. */
  canBuy(slot: number): boolean {
    return this.isVisitor && this.isOpen && !!this.listing(slot)
  }

  /** The purchase of listing `slot` exactly as shown (null when it cannot be bought now). */
  buyRequest(slot: number): Extract<ClientMessage, { t: 'stallBuy' }> | null {
    const l = this.listing(slot)
    if (!l || !this.canBuy(slot)) return null
    const req: Extract<ClientMessage, { t: 'stallBuy' }> = { t: 'stallBuy', owner: this.view!.owner, slot, code: l.stack.code, count: l.stack.count, price: l.price }
    // D47: the +N and the durability the buyer saw (ItemStack convention: absent = 0 / full), checked by the server.
    if (l.stack.plus) req.plus = l.stack.plus
    if (l.stack.durability !== undefined) req.durability = l.stack.durability
    return req
  }

  /**
   * Why bag stack `stack` at `bag` cannot be listed now (a stall.* key), or null. `def` undefined is left to the
   * server (it refuses unknown items).
   */
  listProblem(bag: number, stack: ItemStack | null, def: ItemDef | undefined): StringKey | null {
    if (!this.isOwner) return null
    if (this.isOpen) return 'stall.modifyFirst'
    if (!stack) return null
    if (def?.canTrade === false) return 'stall.notTradable'
    if (this.slotOfBag(bag) >= 0) return 'stall.alreadyListed'
    if (this.freeSlot() < 0) return 'stall.slotsFull'
    return null
  }
}

function normalizeItems(items: readonly (StallListing | null)[]): (StallListing | null)[] {
  const out: (StallListing | null)[] = Array.from({ length: STALL_SLOTS }, (_, i) => items[i] ?? null)
  return out
}

// ---- what the window draws --------------------------------------------------------------------------------

export interface StallRow {
  slot: number
  stack: ItemStack | null
  price: number
  /** Formatted price ("12,500"), '' for an empty slot. */
  priceText: string
  /** The owner's own bag slot (owner view only). */
  bag: number | null
  /** A visitor can buy it now. */
  buyable: boolean
  /** The owner can change or take it back now. */
  editable: boolean
}

export function stallRows(model: StallModel): StallRow[] {
  const v = model.view
  return Array.from({ length: STALL_SLOTS }, (_, slot) => {
    const l = v?.items[slot] ?? null
    return {
      slot,
      stack: l?.stack ?? null,
      price: l?.price ?? 0,
      priceText: l ? formatPrice(l.price) : '',
      bag: l && typeof l.bag === 'number' ? l.bag : null,
      buyable: !!l && model.canBuy(slot),
      editable: !!l && model.canEdit,
    }
  })
}

/** "Visitors 3/8". */
export function visitorsText(v: StallView | null): { count: number; max: number } {
  return { count: Math.max(0, Math.min(STALL_VISITORS_MAX, v?.visitors ?? 0)), max: STALL_VISITORS_MAX }
}

// ---- refusal lines -------------------------------------------------------------------------------------------

const has = (k: string): k is StringKey => k in enStall

/**
 * The line for a refused stall request: `stall.fail.<request>.<reason>`, then `stall.fail.<reason>` (the stall's own
 * retail wording); null = none here, so the caller falls back to the server message or `action.fail.<reason>`.
 */
export function stallFailKey(re: GameplayRequest, reason: ActionFailReason | undefined): StringKey | null {
  if (!reason) return null
  const specific = `stall.fail.${re}.${reason}`
  if (has(specific)) return specific
  const general = `stall.fail.${reason}`
  return has(general) ? general : null
}

/** A server message beats our general line for these (e.g. "Too close to Guard Kim."). */
export const PREFER_SERVER_MESSAGE: ReadonlySet<ActionFailReason> = new Set(['wrong_place', 'invalid_count'])

/** The line shown when the stall you visit (or own) ends. */
export function endKey(reason: StallEndReason | 'gone', owner: boolean): StringKey {
  if (owner) return 'stall.ownClosed'
  return reason === 'too_far' ? 'stall.end.too_far' : reason === 'gone' ? 'stall.closed' : `stall.end.${reason}`
}
