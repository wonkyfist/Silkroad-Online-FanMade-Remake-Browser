/**
 * The client's copy of its own inventory. It changes only through the server's `inventory` snapshot and
 * `inventoryUpdate` deltas (docs/PROTOCOL.md section 7): the windows never change it on their own, they send
 * intents and wait for the server's slot updates. No DOM here (unit-tested in test/hud.test.ts).
 */
import { EQUIP_SLOTS, MAX_BAG_SIZE, type BagSlotUpdate, type EquipSlot, type EquipSlotUpdate, type Inventory, type ItemStack, type ServerMessage } from '@sro/shared'

export type InventoryUpdate = Extract<ServerMessage, { t: 'inventoryUpdate' }>

/** What one snapshot or update changed; `gained` is the net increase per item code (pickups, GM items, buys). */
export interface InventoryChange {
  bag: number[]
  equip: EquipSlot[]
  gold: number
  gained: { code: string; count: number }[]
  snapshot: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function sameStack(a: ItemStack | null | undefined, b: ItemStack | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.code === b.code && a.count === b.count && (a.plus ?? 0) === (b.plus ?? 0) && a.durability === b.durability
}

function copy(s: ItemStack): ItemStack {
  const out: ItemStack = { code: s.code, count: s.count }
  if (s.plus !== undefined) out.plus = s.plus
  if (s.durability !== undefined) out.durability = s.durability
  return out
}

/** Reads an item stack leniently (the contract passes updates as `unknown`); null when it is not one. */
function readStack(v: unknown): ItemStack | null {
  if (!isRecord(v) || typeof v.code !== 'string' || typeof v.count !== 'number' || !Number.isFinite(v.count) || v.count < 1) return null
  const s: ItemStack = { code: v.code, count: Math.floor(v.count) }
  if (typeof v.plus === 'number') s.plus = v.plus
  if (typeof v.durability === 'number') s.durability = v.durability
  return s
}

/**
 * Normalises an `inventoryUpdate` (typed, or `unknown` from the world screen) into bag/equip/gold lists.
 * Entries that are not slot updates are skipped. Accepts the full message or only its fields.
 */
export function readInventoryUpdate(u: unknown): { bag: BagSlotUpdate[]; equip: EquipSlotUpdate[]; gold?: number } {
  const out: { bag: BagSlotUpdate[]; equip: EquipSlotUpdate[]; gold?: number } = { bag: [], equip: [] }
  if (!isRecord(u)) return out
  if (Array.isArray(u.bag)) {
    for (const e of u.bag) {
      if (!isRecord(e) || typeof e.slot !== 'number' || !Number.isInteger(e.slot) || e.slot < 0 || e.slot >= MAX_BAG_SIZE) continue
      if (e.item !== null && !readStack(e.item)) continue
      out.bag.push({ slot: e.slot, item: e.item === null ? null : readStack(e.item) })
    }
  }
  if (Array.isArray(u.equip)) {
    for (const e of u.equip) {
      if (!isRecord(e) || typeof e.slot !== 'string' || !(EQUIP_SLOTS as readonly string[]).includes(e.slot)) continue
      if (e.item !== null && !readStack(e.item)) continue
      out.equip.push({ slot: e.slot as EquipSlot, item: e.item === null ? null : readStack(e.item) })
    }
  }
  if (typeof u.gold === 'number' && Number.isFinite(u.gold) && u.gold >= 0) out.gold = u.gold
  return out
}

export class InventoryState {
  bagSize = 0
  bag: (ItemStack | null)[] = []
  equip: Partial<Record<EquipSlot, ItemStack>> = {}
  gold = 0
  /** False until the first snapshot. */
  known = false

  /** Full snapshot (`inventory`). */
  setSnapshot(inv: Inventory): InventoryChange {
    const before = this.known ? this.totals() : null
    const beforeGold = this.gold
    this.bagSize = Math.max(0, Math.min(MAX_BAG_SIZE, inv.bagSize))
    this.bag = Array.from({ length: this.bagSize }, (_, i) => {
      const s = inv.bag[i]
      return s ? copy(s) : null
    })
    this.equip = {}
    for (const slot of EQUIP_SLOTS) {
      const s = inv.equip[slot]
      if (s) this.equip[slot] = copy(s)
    }
    this.gold = inv.gold
    this.known = true
    return {
      bag: this.bag.map((_, i) => i),
      equip: [...EQUIP_SLOTS],
      gold: before ? this.gold - beforeGold : 0,
      gained: before ? diffGains(before, this.totals()) : [],
      snapshot: true,
    }
  }

  /** Delta (`inventoryUpdate`). Idempotent: applying the same update twice changes nothing the second time. */
  apply(update: unknown): InventoryChange {
    const u = readInventoryUpdate(update)
    const before = this.totals()
    const change: InventoryChange = { bag: [], equip: [], gold: 0, gained: [], snapshot: false }
    for (const { slot, item } of u.bag) {
      if (slot >= this.bagSize) {
        // A slot past the known size: the server's bag grew (or no snapshot yet). Extend with empties.
        while (this.bag.length <= slot) this.bag.push(null)
        this.bagSize = this.bag.length
      }
      if (sameStack(this.bag[slot], item)) continue
      this.bag[slot] = item ? copy(item) : null
      change.bag.push(slot)
    }
    for (const { slot, item } of u.equip) {
      if (sameStack(this.equip[slot], item)) continue
      if (item) this.equip[slot] = copy(item)
      else delete this.equip[slot]
      change.equip.push(slot)
    }
    if (u.gold !== undefined && u.gold !== this.gold) {
      change.gold = u.gold - this.gold
      this.gold = u.gold
    }
    change.gained = diffGains(before, this.totals())
    return change
  }

  item(slot: number): ItemStack | null {
    return this.bag[slot] ?? null
  }

  equipped(slot: EquipSlot): ItemStack | null {
    return this.equip[slot] ?? null
  }

  get used(): number {
    return this.bag.reduce((n, s) => n + (s ? 1 : 0), 0)
  }

  /** First empty bag slot, or -1. */
  freeSlot(): number {
    for (let i = 0; i < this.bagSize; i++) if (!this.bag[i]) return i
    return -1
  }

  /** Count per item code over bag and equipment. */
  totals(): Map<string, number> {
    const m = new Map<string, number>()
    const add = (s: ItemStack | null | undefined) => {
      if (s) m.set(s.code, (m.get(s.code) ?? 0) + s.count)
    }
    for (const s of this.bag) add(s)
    for (const s of Object.values(this.equip)) add(s)
    return m
  }
}

function diffGains(before: Map<string, number>, after: Map<string, number>): { code: string; count: number }[] {
  const out: { code: string; count: number }[] = []
  for (const [code, n] of after) {
    const d = n - (before.get(code) ?? 0)
    if (d > 0) out.push({ code, count: d })
  }
  return out
}
