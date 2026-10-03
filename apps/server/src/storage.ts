import { MAX_GOLD, type AccountStorage, type ItemDef, type StorageSlotUpdate } from '@sro/shared'
import { addGold, done, fail, stackable, takeFromBag, toStack, type Defs, type InvDraft, type InvItem, type Result } from './inventory.ts'

/**
 * Account storage rules (docs/SHOPS.md §5, §6), as pure functions over a bag draft and a storage draft, like
 * inventory.ts. storage-db.ts loads both inside one SQLite transaction, runs one of these and writes back only the
 * touched slots when it succeeded, so an item leaves one table exactly when it enters the other.
 *
 * - Deposits take a bag index only (never an equipped item) and cost `keepFee x count` bag gold (x STORAGE_FEE).
 * - Withdrawals, moves inside storage and gold transfers are free.
 * - Both directions stack with the bag's `stackable` rule. With no target slot: top up stacks, then the first empty
 *   slot, all or nothing. With a target slot: an empty slot takes the stack, a mergeable stack takes what fits (the
 *   rest stays where it was), anything else is refused (no swaps between bag and storage).
 */

export interface StorageState {
  size: number
  slots: (InvItem | null)[]
  gold: number
}

/** A mutable copy of an account's storage that records which slots changed. */
export class StorageDraft {
  readonly size: number
  readonly slots: (InvItem | null)[]
  gold: number
  readonly touched = new Set<number>()
  goldChanged = false

  constructor(base: StorageState) {
    this.size = base.size
    this.slots = Array.from({ length: base.size }, (_, i) => (base.slots[i] ? { ...base.slots[i]! } : null))
    this.gold = base.gold
  }

  inStorage(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.size
  }

  setSlot(i: number, item: InvItem | null): void {
    this.slots[i] = item
    this.touched.add(i)
  }

  setGold(gold: number): void {
    this.gold = gold
    this.goldChanged = true
  }

  /** storageUpdate payload of the touched slots (and the gold when it changed). */
  updates(): { slots?: StorageSlotUpdate[]; gold?: number } {
    const out: { slots?: StorageSlotUpdate[]; gold?: number } = {}
    if (this.touched.size) out.slots = [...this.touched].sort((a, b) => a - b).map((slot) => ({ slot, item: this.slots[slot] ? toStack(this.slots[slot]!) : null }))
    if (this.goldChanged) out.gold = this.gold
    return out
  }

  get changed(): boolean {
    return this.touched.size > 0 || this.goldChanged
  }
}

export function toAccountStorage(s: StorageState): AccountStorage {
  return { size: s.size, slots: Array.from({ length: s.size }, (_, i) => (s.slots[i] ? toStack(s.slots[i]!) : null)), gold: s.gold }
}

/** What the deposit fee is for `count` of an item (`rate` = STORAGE_FEE: 1 = keepFee x count, 0 = free). */
export function storageFee(def: ItemDef, count: number, rate: number): number {
  const fee = Math.round((def.keepFee ?? 0) * count * rate)
  return Number.isFinite(fee) && fee > 0 ? fee : 0
}

/** Why an item may not go into storage (quest items, authored `canStore: false`), or null. */
export function storeProblem(def: ItemDef | undefined): string | null {
  if (!def) return 'unknown item'
  if (def.category === 'quest' || def.canStore === false) return 'this item cannot be stored'
  return null
}

/**
 * Where `item` goes in `slots`: tops up mergeable stacks first, then fills empty slots (in maxStack chunks).
 * Returns the new contents per slot, or null when it does not all fit.
 */
function planAdd(slots: readonly (InvItem | null)[], item: InvItem, def: ItemDef | undefined): [number, InvItem][] | null {
  const max = def && def.maxStack > 1 ? def.maxStack : 0
  let left = item.count
  const plan: [number, InvItem][] = []
  if (max > 0) {
    for (let i = 0; i < slots.length && left > 0; i++) {
      const it = slots[i]
      if (it && stackable(item, it, def) && it.count < max) {
        const n = Math.min(left, max - it.count)
        plan.push([i, { ...it, count: it.count + n }])
        left -= n
      }
    }
  }
  for (let i = 0; i < slots.length && left > 0; i++) {
    if (!slots[i]) {
      const n = max > 0 ? Math.min(left, max) : left
      plan.push([i, { ...item, count: n }])
      left -= n
    }
  }
  return left > 0 ? null : plan
}

/** Puts `item` into the chosen slot: empty, or a mergeable stack with room (what does not fit is left out). */
function planInto(slots: readonly (InvItem | null)[], at: number, item: InvItem, def: ItemDef | undefined): Result<{ plan: [number, InvItem][]; moved: number }> {
  const cur = slots[at]
  if (!cur) return done({ plan: [[at, item]], moved: item.count })
  if (!stackable(item, cur, def)) return fail('invalid_slot', 'the target slot is not empty')
  const room = def!.maxStack - cur.count
  if (room <= 0) return fail('invalid_slot', 'that stack is full')
  const moved = Math.min(item.count, room)
  return done({ plan: [[at, { ...cur, count: cur.count + moved }]], moved })
}

export interface Deposited {
  moved: number
  fee: number
}

/** Bag slot `bag` -> storage (`count` default: the whole stack; `to` default: merge, then the first empty slot). */
export function deposit(inv: InvDraft, st: StorageDraft, bag: number, count: number | undefined, to: number | undefined, defs: Defs, feeRate: number): Result<Deposited> {
  if (!inv.inBag(bag)) return fail('invalid_slot')
  const it = inv.bag[bag]
  if (!it) return fail('invalid_slot', 'that slot is empty')
  const def = defs(it.code)
  const problem = storeProblem(def)
  if (problem) return fail('not_usable', problem)
  const n = count ?? it.count
  if (!Number.isInteger(n) || n < 1 || n > it.count) return fail('invalid_count')
  const moving: InvItem = { ...it, count: n }
  let plan: [number, InvItem][]
  let moved = n
  if (to !== undefined) {
    if (!st.inStorage(to)) return fail('invalid_slot')
    const r = planInto(st.slots, to, moving, def)
    if (!r.ok) return r
    ;({ plan, moved } = r.value)
  } else {
    const p = planAdd(st.slots, moving, def)
    if (!p) return fail('storage_full')
    plan = p
  }
  const fee = storageFee(def!, moved, feeRate)
  if (fee > 0) {
    const paid = addGold(inv, -fee)
    if (!paid.ok) return fail('not_enough_gold', `the storage fee is ${fee} gold`)
  }
  const taken = takeFromBag(inv, bag, moved)
  if (!taken.ok) return taken
  for (const [i, x] of plan) st.setSlot(i, x)
  return done({ moved, fee })
}

/** Storage slot `slot` -> bag (`count` default: the whole stack; `bag` default: merge, then the first empty bag slot). */
export function withdraw(inv: InvDraft, st: StorageDraft, slot: number, count: number | undefined, bag: number | undefined, defs: Defs): Result<number> {
  if (!st.inStorage(slot)) return fail('invalid_slot')
  const it = st.slots[slot]
  if (!it) return fail('invalid_slot', 'that storage slot is empty')
  const n = count ?? it.count
  if (!Number.isInteger(n) || n < 1 || n > it.count) return fail('invalid_count')
  const def = defs(it.code)
  const moving: InvItem = { ...it, count: n }
  let plan: [number, InvItem][]
  let moved = n
  if (bag !== undefined) {
    if (!inv.inBag(bag)) return fail('invalid_slot')
    const r = planInto(inv.bag, bag, moving, def)
    if (!r.ok) return r
    ;({ plan, moved } = r.value)
  } else {
    const p = planAdd(inv.bag, moving, def)
    if (!p) return fail('inventory_full')
    plan = p
  }
  st.setSlot(slot, moved === it.count ? null : { ...it, count: it.count - moved })
  for (const [i, x] of plan) inv.setBag(i, x)
  return done(moved)
}

/** Storage slot -> storage slot: move into an empty slot, merge into a stack with room, or swap (like itemMove). */
export function moveStored(st: StorageDraft, from: number, to: number, defs: Defs): Result {
  if (!st.inStorage(from) || !st.inStorage(to) || from === to) return fail('invalid_slot')
  const a = st.slots[from]
  if (!a) return fail('invalid_slot', 'that storage slot is empty')
  const b = st.slots[to]
  if (!b) {
    st.setSlot(to, a)
    st.setSlot(from, null)
    return done(undefined)
  }
  const def = defs(a.code)
  if (stackable(a, b, def) && b.count < def!.maxStack) {
    const n = Math.min(a.count, def!.maxStack - b.count)
    st.setSlot(to, { ...b, count: b.count + n })
    st.setSlot(from, n === a.count ? null : { ...a, count: a.count - n })
    return done(undefined)
  }
  st.setSlot(to, a)
  st.setSlot(from, b)
  return done(undefined)
}

/** Bag gold -> storage gold. */
export function goldIn(inv: InvDraft, st: StorageDraft, amount: number): Result {
  if (!Number.isInteger(amount) || amount < 1) return fail('invalid_count')
  if (inv.gold < amount) return fail('not_enough_gold')
  if (st.gold + amount > MAX_GOLD) return fail('gold_limit', 'storage cannot hold that much gold')
  const paid = addGold(inv, -amount)
  if (!paid.ok) return paid
  st.setGold(st.gold + amount)
  return done(undefined)
}

/** Storage gold -> bag gold (strict: never past MAX_GOLD). */
export function goldOut(inv: InvDraft, st: StorageDraft, amount: number): Result {
  if (!Number.isInteger(amount) || amount < 1) return fail('invalid_count')
  if (st.gold < amount) return fail('not_enough_gold', 'not that much gold in storage')
  const got = addGold(inv, amount, { strict: true })
  if (!got.ok) return got
  st.setGold(st.gold - amount)
  return done(undefined)
}
