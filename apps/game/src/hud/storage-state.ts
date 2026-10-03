/**
 * The client's copy of the account storage (docs/SHOPS.md §5), fed only by the server's `storage` snapshot and
 * `storageUpdate` deltas, like InventoryState for the bag. Also the drag rules between the bag and the storage
 * window, and the gold amount parser. No DOM (test/storage.test.ts).
 */
import { MAX_GOLD, MAX_STORAGE_SIZE, type AccountStorage, type ClientMessage, type ItemDef, type ItemStack, type StorageSlotUpdate } from '@sro/shared'
import { intent } from './intents.ts'
import type { BagView } from './shop-logic.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function readStack(v: unknown): ItemStack | null {
  if (!isRecord(v) || typeof v.code !== 'string' || typeof v.count !== 'number' || !Number.isFinite(v.count) || v.count < 1) return null
  const s: ItemStack = { code: v.code, count: Math.floor(v.count) }
  if (typeof v.plus === 'number') s.plus = v.plus
  if (typeof v.durability === 'number') s.durability = v.durability
  return s
}

function sameStack(a: ItemStack | null, b: ItemStack | null): boolean {
  if (!a || !b) return !a && !b
  return a.code === b.code && a.count === b.count && (a.plus ?? 0) === (b.plus ?? 0) && a.durability === b.durability
}

/** What a snapshot or update changed. */
export interface StorageChange {
  slots: number[]
  gold: boolean
  snapshot: boolean
}

export class StorageState {
  private slots: (ItemStack | null)[] = []
  private goldValue = 0
  /** False until the first `storage` snapshot of this visit. */
  known = false

  get size(): number {
    return this.slots.length
  }

  get gold(): number {
    return this.goldValue
  }

  /** Filled slots. */
  get used(): number {
    let n = 0
    for (const s of this.slots) if (s) n++
    return n
  }

  item(i: number): ItemStack | null {
    return this.slots[i] ?? null
  }

  /** The full `storage` snapshot. Malformed slots read as empty; the size is clamped to the protocol's 1..180. */
  setSnapshot(st: AccountStorage): StorageChange {
    const size = Math.max(0, Math.min(MAX_STORAGE_SIZE, Math.floor(Number(st.size) || 0)))
    this.slots = Array.from({ length: size }, (_, i) => readStack(st.slots?.[i]))
    this.goldValue = Math.max(0, Number(st.gold) || 0)
    this.known = true
    return { slots: this.slots.map((_, i) => i), gold: true, snapshot: true }
  }

  /**
   * A `storageUpdate`. Idempotent: applying the same update twice changes nothing the second time. Slots outside the
   * known size are ignored (the snapshot decides the size).
   */
  apply(u: { slots?: readonly StorageSlotUpdate[]; gold?: number }): StorageChange {
    const change: StorageChange = { slots: [], gold: false, snapshot: false }
    for (const e of u.slots ?? []) {
      if (!isRecord(e) || typeof e.slot !== 'number' || !Number.isInteger(e.slot) || e.slot < 0 || e.slot >= this.slots.length) continue
      const next = e.item === null ? null : readStack(e.item)
      if (e.item !== null && !next) continue
      if (sameStack(this.slots[e.slot] ?? null, next)) continue
      this.slots[e.slot] = next
      change.slots.push(e.slot)
    }
    if (typeof u.gold === 'number' && Number.isFinite(u.gold) && u.gold >= 0 && u.gold !== this.goldValue) {
      this.goldValue = u.gold
      change.gold = true
    }
    return change
  }

  /** Forgets everything (the window closed; the next storageOpen sends a fresh snapshot). */
  clear(): void {
    this.slots = []
    this.goldValue = 0
    this.known = false
  }
}

/** A slot in either container. */
export type StorageRef = { kind: 'bag'; slot: number } | { kind: 'storage'; slot: number }

/**
 * Whether more of `code` can merge into `s` (the server's `stackable`: same code, no +N, full durability) and the
 * stack still has room. A full stack falls through to "the server picks", which the server can serve.
 */
function mergeable(s: ItemStack, code: string, maxStack: number): boolean {
  return maxStack > 1 && s.code === code && !s.plus && s.durability === undefined && s.count < maxStack
}

/**
 * The intent for a drag between the bag and the storage window of storage keeper `npc`:
 *  - bag -> storage: storageDeposit, into the dropped slot when it is empty or holds the same stackable item (else
 *    the server picks: merge, then the first empty slot);
 *  - storage -> bag: storageWithdraw, likewise into the dropped bag slot when it can take it;
 *  - storage -> storage: storageMove (the server moves, merges or swaps);
 *  - bag -> bag is the HUD's own itemMove: null here.
 * `to.slot` < 0 means "dropped on the window, not on a slot". `count` omitted = the whole stack.
 */
export function storageDropIntent(
  npc: number,
  storage: StorageState,
  bag: BagView,
  from: StorageRef,
  to: StorageRef,
  def: (code: string) => Pick<ItemDef, 'maxStack'> | undefined,
  count?: number,
): ClientMessage | null {
  if (from.kind === 'bag') {
    const stack = bag.item(from.slot)
    if (!stack || to.kind !== 'storage') return null
    const there = to.slot >= 0 && to.slot < storage.size ? storage.item(to.slot) : null
    const slot = to.slot >= 0 && to.slot < storage.size && (!there || mergeable(there, stack.code, def(stack.code)?.maxStack ?? 1)) ? to.slot : undefined
    return intent.storageDeposit(npc, from.slot, count, slot)
  }
  const stack = storage.item(from.slot)
  if (!stack) return null
  if (to.kind === 'storage') return to.slot >= 0 && to.slot !== from.slot ? intent.storageMove(npc, from.slot, to.slot) : null
  const there = to.slot >= 0 && to.slot < bag.bagSize ? bag.item(to.slot) : null
  const slot = to.slot >= 0 && to.slot < bag.bagSize && (!there || mergeable(there, stack.code, def(stack.code)?.maxStack ?? 1)) ? to.slot : undefined
  return intent.storageWithdraw(npc, from.slot, count, slot)
}

/** The storage fee for depositing `count` (ItemDef.keepFee x count; 0 until the export writes keepFee). */
export function storageFee(def: Pick<ItemDef, 'keepFee'> | undefined, count: number): number {
  return Math.max(0, def?.keepFee ?? 0) * Math.max(0, count)
}

/**
 * Parses a typed gold amount ("1,500" and "1500" both work): a whole number in 1..min(max, MAX_GOLD), else null.
 */
export function parseGold(raw: string, max: number): number | null {
  const s = raw.trim().replace(/[,\s]/g, '')
  if (!/^\d{1,13}$/.test(s)) return null
  const n = Number(s)
  const limit = Math.min(Math.floor(max), MAX_GOLD)
  return Number.isSafeInteger(n) && n >= 1 && n <= limit ? n : null
}
