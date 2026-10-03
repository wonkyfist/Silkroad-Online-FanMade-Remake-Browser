/**
 * Gameplay intents the HUD sends (docs/PROTOCOL.md sections 4, 5 and 7), and the drag-and-drop rules that pick
 * them. Every builder returns a message that passes the server's strict validator (parseClientMessage), or null
 * when there is nothing sensible to send. Nothing here changes local state: the server's `inventoryUpdate` /
 * `stats` decide what the windows show. No DOM (unit-tested in test/hud.test.ts).
 */
import {
  BUYBACK_SLOTS,
  CODE_NAME,
  HOTBAR_SLOTS,
  MASTERY_CODES,
  MAX_BAG_SIZE,
  MAX_GOLD,
  MAX_ITEM_COUNT,
  MAX_STAT_POINTS_PER_REQUEST,
  MAX_STORAGE_SIZE,
  PARTY_MODES,
  STORAGE_GOLD_DIRS,
  type ClientMessage,
  type EquipSlot,
  type HotbarEntry,
  type MasteryCode,
  type PartyExpMode,
  type PartyItemMode,
  type StorageGoldDir,
} from '@sro/shared'
import type { InventoryState } from './inventory-state.ts'
import type { ItemCatalog } from './items.ts'

type Msg<K extends ClientMessage['t']> = Extract<ClientMessage, { t: K }>

const bagIndex = (i: number) => Number.isInteger(i) && i >= 0 && i < MAX_BAG_SIZE
const itemCount = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_ITEM_COUNT
const entityId = (n: number) => Number.isSafeInteger(n) && n >= 0
const storageIndex = (i: number) => Number.isInteger(i) && i >= 0 && i < MAX_STORAGE_SIZE
const code = (s: string) => typeof s === 'string' && CODE_NAME.test(s)
const memberId = (n: number) => Number.isSafeInteger(n) && n >= 1
const partyMode = (m: unknown): m is PartyExpMode => PARTY_MODES.includes(m as PartyExpMode)

export const intent = {
  itemMove(from: number, to: number): Msg<'itemMove'> | null {
    return bagIndex(from) && bagIndex(to) && from !== to ? { t: 'itemMove', from, to } : null
  },
  itemSplit(from: number, to: number, count: number): Msg<'itemSplit'> | null {
    return bagIndex(from) && bagIndex(to) && from !== to && itemCount(count) ? { t: 'itemSplit', from, to, count } : null
  },
  itemEquip(bag: number, slot?: EquipSlot): Msg<'itemEquip'> | null {
    if (!bagIndex(bag)) return null
    return slot ? { t: 'itemEquip', bag, slot } : { t: 'itemEquip', bag }
  },
  itemUnequip(slot: EquipSlot, bag?: number): Msg<'itemUnequip'> | null {
    if (bag !== undefined && !bagIndex(bag)) return null
    return bag === undefined ? { t: 'itemUnequip', slot } : { t: 'itemUnequip', slot, bag }
  },
  itemUse(bag: number): Msg<'itemUse'> | null {
    return bagIndex(bag) ? { t: 'itemUse', bag } : null
  },
  /** `count` omitted = the whole stack. */
  itemDrop(bag: number, count?: number): Msg<'itemDrop'> | null {
    if (!bagIndex(bag)) return null
    if (count === undefined) return { t: 'itemDrop', bag }
    return itemCount(count) ? { t: 'itemDrop', bag, count } : null
  },
  statUp(stat: 'str' | 'int', points: number): Msg<'statUp'> | null {
    return Number.isInteger(points) && points >= 1 && points <= MAX_STAT_POINTS_PER_REQUEST ? { t: 'statUp', stat, points } : null
  },
  respawn(): Msg<'respawn'> {
    return { t: 'respawn' }
  },

  // ---- wave 3 (docs/WAVE_PLAN.md §2.1): skills ----------------------------------------------------
  /** `skill`: the skills.json row code to learn (the next level of its group). */
  skillLearn(skill: string): Msg<'skillLearn'> | null {
    return code(skill) ? { t: 'skillLearn', skill } : null
  },
  masteryUp(mastery: MasteryCode): Msg<'masteryUp'> | null {
    return MASTERY_CODES.includes(mastery) ? { t: 'masteryUp', mastery } : null
  },
  buffCancel(skill: string): Msg<'buffCancel'> | null {
    return code(skill) ? { t: 'buffCancel', skill } : null
  },
  /** `entry` null clears the slot. */
  hotbarSet(slot: number, entry: HotbarEntry | null): Msg<'hotbarSet'> | null {
    if (!Number.isInteger(slot) || slot < 0 || slot >= HOTBAR_SLOTS) return null
    if (entry === null) return { t: 'hotbarSet', slot, entry: null }
    if ((entry.kind !== 'skill' && entry.kind !== 'item') || !code(entry.code)) return null
    return { t: 'hotbarSet', slot, entry: { kind: entry.kind, code: entry.code } }
  },
  useSkill(skill: string, target?: number): Msg<'useSkill'> | null {
    if (!code(skill)) return null
    if (target === undefined) return { t: 'useSkill', skill }
    return entityId(target) ? { t: 'useSkill', skill, target } : null
  },

  // ---- NPC dialog, storage, shops (docs/SHOPS.md) -------------------------------------------------
  npcClose(): Msg<'npcClose'> {
    return { t: 'npcClose' }
  },
  storageOpen(npc: number): Msg<'storageOpen'> | null {
    return entityId(npc) ? { t: 'storageOpen', npc } : null
  },
  /** `count` omitted = the whole stack; `to` omitted = the server picks the storage slot. */
  storageDeposit(npc: number, bag: number, count?: number, to?: number): Msg<'storageDeposit'> | null {
    if (!entityId(npc) || !bagIndex(bag)) return null
    const m: Msg<'storageDeposit'> = { t: 'storageDeposit', npc, bag }
    if (count !== undefined) {
      if (!itemCount(count)) return null
      m.count = count
    }
    if (to !== undefined) {
      if (!storageIndex(to)) return null
      m.to = to
    }
    return m
  },
  /** `count` omitted = the whole stack; `bag` omitted = the server picks the bag slot. */
  storageWithdraw(npc: number, slot: number, count?: number, bag?: number): Msg<'storageWithdraw'> | null {
    if (!entityId(npc) || !storageIndex(slot)) return null
    const m: Msg<'storageWithdraw'> = { t: 'storageWithdraw', npc, slot }
    if (count !== undefined) {
      if (!itemCount(count)) return null
      m.count = count
    }
    if (bag !== undefined) {
      if (!bagIndex(bag)) return null
      m.bag = bag
    }
    return m
  },
  storageMove(npc: number, from: number, to: number): Msg<'storageMove'> | null {
    return entityId(npc) && storageIndex(from) && storageIndex(to) && from !== to ? { t: 'storageMove', npc, from, to } : null
  },
  storageGold(npc: number, dir: StorageGoldDir, amount: number): Msg<'storageGold'> | null {
    return entityId(npc) && STORAGE_GOLD_DIRS.includes(dir) && Number.isSafeInteger(amount) && amount >= 1 && amount <= MAX_GOLD ? { t: 'storageGold', npc, dir, amount } : null
  },
  shopBuy(npc: number, item: string, count: number): Msg<'shopBuy'> | null {
    return entityId(npc) && code(item) && itemCount(count) ? { t: 'shopBuy', npc, item, count } : null
  },
  /** `count` omitted = the whole stack. */
  shopSell(npc: number, bag: number, count?: number): Msg<'shopSell'> | null {
    if (!entityId(npc) || !bagIndex(bag)) return null
    if (count === undefined) return { t: 'shopSell', npc, bag }
    return itemCount(count) ? { t: 'shopSell', npc, bag, count } : null
  },
  /** `item`: the entry's item code, so the server refuses the press if the list has changed under it. */
  shopBuyback(npc: number, index: number, item?: string): Msg<'shopBuyback'> | null {
    if (!entityId(npc) || !Number.isInteger(index) || index < 0 || index >= BUYBACK_SLOTS) return null
    if (item === undefined) return { t: 'shopBuyback', npc, index }
    return code(item) ? { t: 'shopBuyback', npc, index, code: item } : null
  },

  // ---- wave 4 (docs/WAVE_PLAN.md §2.2, docs/QUESTS.md §4): party. Quest builders live in quests/intents.ts ------
  /** Invite the player entity `target`; `exp` / `items` set the new party's modes (ignored when we already lead one). */
  partyInvite(target: number, exp?: PartyExpMode, items?: PartyItemMode): Msg<'partyInvite'> | null {
    if (!entityId(target)) return null
    const m: Msg<'partyInvite'> = { t: 'partyInvite', target }
    if (exp !== undefined) {
      if (!partyMode(exp)) return null
      m.exp = exp
    }
    if (items !== undefined) {
      if (!partyMode(items)) return null
      m.items = items
    }
    return m
  },
  /** `inviter`: the entity id from `partyInvited`. */
  partyRespond(inviter: number, accept: boolean): Msg<'partyRespond'> | null {
    return entityId(inviter) && typeof accept === 'boolean' ? { t: 'partyRespond', inviter, accept } : null
  },
  partyLeave(): Msg<'partyLeave'> {
    return { t: 'partyLeave' }
  },
  /** `member`: the characterId from `PartyMember` (not an entity id; members may be offline). */
  partyKick(member: number): Msg<'partyKick'> | null {
    return memberId(member) ? { t: 'partyKick', member } : null
  },
  /** Hand the lead to `member` (a characterId). */
  partyLeader(member: number): Msg<'partyLeader'> | null {
    return memberId(member) ? { t: 'partyLeader', member } : null
  },
  /** Leader only; at least one of the two modes, else null. */
  partySettings(s: { exp?: PartyExpMode; items?: PartyItemMode }): Msg<'partySettings'> | null {
    if (s.exp === undefined && s.items === undefined) return null
    const m: Msg<'partySettings'> = { t: 'partySettings' }
    if (s.exp !== undefined) {
      if (!partyMode(s.exp)) return null
      m.exp = s.exp
    }
    if (s.items !== undefined) {
      if (!partyMode(s.items)) return null
      m.items = s.items
    }
    return m
  },
}

/** Where a dragged item came from / was released. */
export type SlotRef = { kind: 'bag'; slot: number } | { kind: 'equip'; slot: EquipSlot }

/**
 * The intent for a drag from `from` to `to`:
 *  - bag -> bag: itemMove (the server moves, merges or swaps); with `split` and a stack > 1 into an empty
 *    slot the caller asks for a count first (returns 'split');
 *  - bag -> equip: itemEquip with that slot (refused locally only when the item data says it cannot fit);
 *  - equip -> bag: itemUnequip into that bag slot when it is empty, else into the first free slot;
 *  - equip -> equip: only ring1 <-> ring2 would make sense, and the protocol has no such move: nothing.
 */
export function dragIntent(
  inv: InventoryState,
  items: ItemCatalog,
  from: SlotRef,
  to: SlotRef,
  opts: { split?: boolean } = {},
): ClientMessage | 'split' | 'nofit' | null {
  if (from.kind === 'bag') {
    const stack = inv.item(from.slot)
    if (!stack) return null
    if (to.kind === 'bag') {
      if (to.slot === from.slot) return null
      if (opts.split && stack.count > 1 && !inv.item(to.slot)) return 'split'
      return intent.itemMove(from.slot, to.slot)
    }
    if (!items.fits(stack.code, to.slot)) return 'nofit'
    return intent.itemEquip(from.slot, to.slot)
  }
  if (!inv.equipped(from.slot)) return null
  if (to.kind === 'bag') return intent.itemUnequip(from.slot, inv.item(to.slot) ? undefined : to.slot)
  return null
}

/** Right click on a bag item: equipment is equipped, anything else is used. */
export function useIntent(inv: InventoryState, items: ItemCatalog, bag: number): ClientMessage | null {
  const stack = inv.item(bag)
  if (!stack) return null
  return items.isEquipment(stack.code) ? intent.itemEquip(bag) : intent.itemUse(bag)
}

/** Parses a typed count for drop/split dialogs: a whole number in 1..max, else null. */
export function parseCount(raw: string, max: number): number | null {
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= Math.min(max, MAX_ITEM_COUNT) ? n : null
}
