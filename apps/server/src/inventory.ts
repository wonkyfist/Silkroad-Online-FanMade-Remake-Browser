import {
  EQUIP_SLOTS,
  MAX_GOLD,
  equipSlotsFor,
  type ActionFailReason,
  type BagSlotUpdate,
  type EquipSlot,
  type EquipSlotUpdate,
  type Inventory,
  type ItemDef,
  type ItemStack,
} from '@sro/shared'

/**
 * Inventory rules (docs/PROTOCOL.md §7), as pure functions over a draft. The database layer (db.ts
 * `inventoryTx`) loads the character's rows, runs one of these inside a SQLite transaction and writes back
 * only the touched slots, so every request is all-or-nothing and requests are strictly serialised (the
 * server is one process and better-sqlite3 is synchronous): an item can never be in two places.
 */

export interface InvItem {
  code: string
  count: number
  plus: number
  /** null = full durability. */
  durability: number | null
}

export interface InvState {
  bagSize: number
  bag: (InvItem | null)[]
  equip: Partial<Record<EquipSlot, InvItem>>
  gold: number
}

export type Fail = { ok: false; reason: ActionFailReason; message?: string }
export type Result<T = undefined> = { ok: true; value: T } | Fail

export const fail = (reason: ActionFailReason, message?: string): Fail => (message ? { ok: false, reason, message } : { ok: false, reason })
export const done = <T>(value: T): Result<T> => ({ ok: true, value })

export type Defs = (code: string) => ItemDef | undefined

/** Visible equipment (drawn on the character): everything but accessories. */
export const VISIBLE_SLOTS: readonly EquipSlot[] = ['head', 'shoulders', 'chest', 'legs', 'hands', 'feet', 'weapon', 'shield']

/** Most gold a character can hold (@sro/shared protocol.ts; re-exported for older imports). */
export { MAX_GOLD }

export function toStack(i: InvItem): ItemStack {
  const s: ItemStack = { code: i.code, count: i.count }
  if (i.plus) s.plus = i.plus
  if (i.durability !== null) s.durability = i.durability
  return s
}

export function toInventory(s: InvState): Inventory {
  const equip: Partial<Record<EquipSlot, ItemStack>> = {}
  for (const slot of EQUIP_SLOTS) {
    const it = s.equip[slot]
    if (it) equip[slot] = toStack(it)
  }
  return { bagSize: s.bagSize, bag: s.bag.map((i) => (i ? toStack(i) : null)), equip, gold: s.gold }
}

export function newItem(code: string, count: number, plus = 0): InvItem {
  return { code, count, plus, durability: null }
}

/** A mutable copy of an inventory that records which slots changed. */
export class InvDraft {
  readonly bagSize: number
  readonly bag: (InvItem | null)[]
  readonly equip: Partial<Record<EquipSlot, InvItem>>
  gold: number
  readonly touchedBag = new Set<number>()
  readonly touchedEquip = new Set<EquipSlot>()
  goldChanged = false

  constructor(base: InvState) {
    this.bagSize = base.bagSize
    this.bag = Array.from({ length: base.bagSize }, (_, i) => (base.bag[i] ? { ...base.bag[i]! } : null))
    this.equip = {}
    for (const slot of EQUIP_SLOTS) if (base.equip[slot]) this.equip[slot] = { ...base.equip[slot]! }
    this.gold = base.gold
  }

  inBag(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.bagSize
  }

  setBag(i: number, item: InvItem | null): void {
    this.bag[i] = item
    this.touchedBag.add(i)
  }

  setEquip(slot: EquipSlot, item: InvItem | null): void {
    if (item) this.equip[slot] = item
    else delete this.equip[slot]
    this.touchedEquip.add(slot)
  }

  setGold(gold: number): void {
    this.gold = gold
    this.goldChanged = true
  }

  firstFree(except: number[] = []): number {
    for (let i = 0; i < this.bagSize; i++) if (!this.bag[i] && !except.includes(i)) return i
    return -1
  }

  state(): InvState {
    return { bagSize: this.bagSize, bag: this.bag, equip: this.equip, gold: this.gold }
  }

  /** inventoryUpdate payload of the touched slots. */
  updates(): { bag?: BagSlotUpdate[]; equip?: EquipSlotUpdate[]; gold?: number } {
    const out: { bag?: BagSlotUpdate[]; equip?: EquipSlotUpdate[]; gold?: number } = {}
    if (this.touchedBag.size) out.bag = [...this.touchedBag].sort((a, b) => a - b).map((slot) => ({ slot, item: this.bag[slot] ? toStack(this.bag[slot]!) : null }))
    if (this.touchedEquip.size) out.equip = [...this.touchedEquip].map((slot) => ({ slot, item: this.equip[slot] ? toStack(this.equip[slot]!) : null }))
    if (this.goldChanged) out.gold = this.gold
    return out
  }

  get changed(): boolean {
    return this.touchedBag.size > 0 || this.touchedEquip.size > 0 || this.goldChanged
  }
}

/** Whether `a` and `b` merge into one stack (same code and plus, full durability, maxStack > 1). */
export function stackable(a: InvItem, b: InvItem, def: ItemDef | undefined): boolean {
  return !!def && def.maxStack > 1 && a.code === b.code && a.plus === b.plus && a.durability === null && b.durability === null
}

/** Adds `count` of an item: tops up existing stacks first, then fills empty slots. All or nothing. */
export function addItem(d: InvDraft, def: ItemDef, count: number, plus = 0): Result<number[]> {
  if (!Number.isInteger(count) || count < 1) return fail('invalid_count')
  const max = Math.max(1, def.maxStack)
  let left = count
  const plan: [number, number][] = []
  if (max > 1) {
    for (let i = 0; i < d.bagSize && left > 0; i++) {
      const it = d.bag[i]
      if (it && it.code === def.code && it.plus === plus && it.durability === null && it.count < max) {
        const n = Math.min(left, max - it.count)
        plan.push([i, it.count + n])
        left -= n
      }
    }
  }
  const empties: number[] = []
  for (let i = 0; i < d.bagSize && left > 0; i++) {
    if (!d.bag[i]) {
      const n = Math.min(left, max)
      empties.push(i)
      plan.push([i, n])
      left -= n
    }
  }
  if (left > 0) return fail('inventory_full')
  for (const [i, n] of plan) {
    const cur = d.bag[i]
    d.setBag(i, cur ? { ...cur, count: n } : newItem(def.code, n, plus))
  }
  return done(plan.map(([i]) => i))
}

/** Whether `count` of an item would fit (without changing anything). */
export function fits(base: InvState, def: ItemDef, count: number, plus = 0, durability: number | null = null): boolean {
  return putBack(new InvDraft(base), def, { code: def.code, count, plus, durability }).ok
}

/**
 * Puts a stack back into the bag exactly as it was (buyback, a dropped item picked up again): a full-durability
 * stackable merges like any stack; anything else (a worn item, an unstackable one) keeps its own plus and durability
 * in the first free slot.
 */
export function putBack(d: InvDraft, def: ItemDef, item: InvItem): Result<unknown> {
  if (def.maxStack > 1 && item.durability === null) return addItem(d, def, item.count, item.plus)
  if (!Number.isInteger(item.count) || item.count < 1) return fail('invalid_count')
  const free = d.firstFree()
  if (free < 0) return fail('inventory_full')
  d.setBag(free, { ...newItem(item.code, item.count, item.plus), durability: item.durability })
  return done(free)
}

/** Removes `count` from bag slot `i` and returns what was taken. */
export function takeFromBag(d: InvDraft, i: number, count?: number): Result<InvItem> {
  if (!d.inBag(i)) return fail('invalid_slot')
  const it = d.bag[i]
  if (!it) return fail('invalid_slot', 'that slot is empty')
  const n = count ?? it.count
  if (!Number.isInteger(n) || n < 1 || n > it.count) return fail('invalid_count')
  d.setBag(i, n === it.count ? null : { ...it, count: it.count - n })
  return done({ ...it, count: n })
}

export function moveItem(d: InvDraft, from: number, to: number, defs: Defs): Result {
  if (!d.inBag(from) || !d.inBag(to) || from === to) return fail('invalid_slot')
  const a = d.bag[from]
  if (!a) return fail('invalid_slot', 'that slot is empty')
  const b = d.bag[to]
  if (!b) {
    d.setBag(to, a)
    d.setBag(from, null)
    return done(undefined)
  }
  const def = defs(a.code)
  if (stackable(a, b, def) && b.count < def!.maxStack) {
    const n = Math.min(a.count, def!.maxStack - b.count)
    d.setBag(to, { ...b, count: b.count + n })
    d.setBag(from, n === a.count ? null : { ...a, count: a.count - n })
    return done(undefined)
  }
  d.setBag(to, a)
  d.setBag(from, b)
  return done(undefined)
}

export function splitItem(d: InvDraft, from: number, to: number, count: number): Result {
  if (!d.inBag(from) || !d.inBag(to) || from === to) return fail('invalid_slot')
  const a = d.bag[from]
  if (!a) return fail('invalid_slot', 'that slot is empty')
  if (d.bag[to]) return fail('invalid_slot', 'the target slot is not empty')
  if (!Number.isInteger(count) || count < 1 || count >= a.count) return fail('invalid_count')
  d.setBag(from, { ...a, count: a.count - count })
  d.setBag(to, { ...a, count })
  return done(undefined)
}

export interface Wearer {
  level: number
  gender: 'male' | 'female'
}

/** Why `def` cannot be worn by `who` (level, gender, race), or null. */
export function wearProblem(def: ItemDef, who: Wearer): string | null {
  if (def.reqLevel > who.level) return `needs level ${def.reqLevel}`
  if (def.reqGender !== 'any' && def.reqGender !== who.gender) return `for ${def.reqGender} characters only`
  if (def.race === 'europe') return 'European equipment'
  return null
}

/**
 * Equips the bag item at `bag` into `slot` (default: its own slot; rings: the first free ring). Whatever was in
 * the slot swaps back into `bag`. A two-handed weapon also moves a worn shield to a free bag slot; a shield is
 * refused while a two-handed weapon is worn. Returns the equip slot used.
 */
export function equipItem(d: InvDraft, bag: number, slot: EquipSlot | undefined, who: Wearer, defs: Defs): Result<EquipSlot> {
  if (!d.inBag(bag)) return fail('invalid_slot')
  const it = d.bag[bag]
  if (!it) return fail('invalid_slot', 'that slot is empty')
  const def = defs(it.code)
  if (!def || !def.slot) return fail('invalid_slot', 'not equipment')
  // Wave 8 (docs/SYSTEMS_COMBAT.md §3.2, D48): a broken item cannot be worn (unequipping is always allowed).
  if (it.durability === 0) return fail('broken', 'Cannot equip a broken item.')
  const allowed = equipSlotsFor(def.slot)
  let target: EquipSlot
  if (slot !== undefined) {
    if (!allowed.includes(slot)) return fail('invalid_slot', `goes in ${allowed.join(' or ')}`)
    target = slot
  } else target = allowed.find((s) => !d.equip[s]) ?? allowed[0]
  const problem = wearProblem(def, who)
  if (problem) return fail('requirements', problem)
  const weaponDef = d.equip.weapon ? defs(d.equip.weapon.code) : undefined
  if (target === 'shield' && weaponDef?.twoHanded) return fail('requirements', 'a two-handed weapon is worn')
  const old = d.equip[target] ?? null
  d.setBag(bag, old)
  d.setEquip(target, it)
  if (target === 'weapon' && def.twoHanded && d.equip.shield) {
    const free = d.firstFree()
    if (free < 0) return fail('inventory_full', 'no room for the shield')
    d.setBag(free, d.equip.shield)
    d.setEquip('shield', null)
  }
  return done(target)
}

/** Unequips `slot` into bag slot `bag` (must be empty) or the first free slot. */
export function unequipItem(d: InvDraft, slot: EquipSlot, bag?: number): Result<number> {
  const it = d.equip[slot]
  if (!it) return fail('invalid_slot', 'nothing is worn there')
  let to: number
  if (bag !== undefined) {
    if (!d.inBag(bag) || d.bag[bag]) return fail('invalid_slot', 'the target slot is not empty')
    to = bag
  } else {
    to = d.firstFree()
    if (to < 0) return fail('inventory_full')
  }
  d.setBag(to, it)
  d.setEquip(slot, null)
  return done(to)
}

/**
 * Adds (or, negative, takes) gold. Below 0 fails `not_enough_gold`. Above MAX_GOLD the default clamps (loot and GM
 * gold: losing the overflow is harmless); `strict` fails `gold_limit` and changes nothing (sales, storage withdrawals;
 * docs/SHOPS.md §6).
 */
export function addGold(d: InvDraft, amount: number, opts: { strict?: boolean } = {}): Result {
  const next = d.gold + amount
  if (next < 0) return fail('not_enough_gold')
  if (opts.strict && next > MAX_GOLD) return fail('gold_limit')
  d.setGold(Math.min(MAX_GOLD, next))
  return done(undefined)
}
