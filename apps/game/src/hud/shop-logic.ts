/**
 * Shop rules the client needs for display (docs/SHOPS.md §2, §3.2, §8.3): which tabs and goods an NPC's shop shows,
 * how many of a good the player can buy, what a sale pays, and the order of the NPC dialog's options. Presentation
 * only: the server applies the same cap filter and refuses anything it would not sell. No DOM (test/shop.test.ts).
 */
import { MAX_ITEM_COUNT, NPC_SERVICES, type ItemDef, type ItemStack, type NpcDef, type ShopDef } from '@sro/shared'
import type { StringKey } from '../i18n/index.ts'

export type Gender = 'male' | 'female'

/** One shop tab as shown: its goods after the cap filter; `index` is the tab's position in ShopDef.tabs. */
export interface ShopTabView {
  name: string
  items: string[]
  reqGender?: Gender
  index: number
}

/** The bag as these rules read it (InventoryState fits). */
export interface BagView {
  readonly bagSize: number
  item(i: number): ItemStack | null
}

type DefOf = (code: string) => ItemDef | undefined

/** The shop an NPC opens: NpcDef.shop first, else any shop that lists the NPC code (shops.json `npcs`). */
export function shopFor(code: string, npcs: ReadonlyMap<string, NpcDef>, shops: ReadonlyMap<string, ShopDef>): ShopDef | null {
  const id = npcs.get(code)?.shop
  const byId = id ? shops.get(id) : undefined
  if (byId) return byId
  for (const s of shops.values()) if (s.npcs.includes(code)) return s
  return null
}

/** True when some tab sells for one gender only (the armour trader): the window then offers a Male/Female switch. */
export function hasGenderTabs(shop: ShopDef): boolean {
  return shop.tabs.some(tab => tab.reqGender !== undefined)
}

/**
 * The tabs to show for `gender`: tabs of the other gender are left out, goods above the level cap are hidden
 * (docs/SHOPS.md §2.4: the server refuses them with not_found), and tabs left empty are dropped. Goods without an
 * ItemDef are kept: the server decides whether it sells them.
 */
export function visibleTabs(shop: ShopDef, gender: Gender, cap: number, def: DefOf): ShopTabView[] {
  const out: ShopTabView[] = []
  shop.tabs.forEach((tab, index) => {
    if (tab.reqGender && tab.reqGender !== gender) return
    const items = tab.items.filter(code => (def(code)?.reqLevel ?? 0) <= cap)
    if (!items.length) return
    const view: ShopTabView = { name: tab.name, items, index }
    if (tab.reqGender) view.reqGender = tab.reqGender
    out.push(view)
  })
  return out
}

/** Whether a stack can take more of `code` bought from a shop (the server's `stackable`: same code, no +N, full durability). */
function mergesWith(s: ItemStack, code: string, maxStack: number): boolean {
  return maxStack > 1 && s.code === code && !s.plus && s.durability === undefined && s.count < maxStack
}

/** How many of `code` the bag can still take: free slots x maxStack, plus the room left on stacks it merges into. */
export function bagRoom(bag: BagView, code: string, maxStack: number): number {
  const max = Math.max(1, maxStack)
  let room = 0
  for (let i = 0; i < bag.bagSize; i++) {
    const s = bag.item(i)
    if (!s) room += max
    else if (mergesWith(s, code, max)) room += max - s.count
  }
  return room
}

/** Why nothing can be bought, or how many at most (the count dialog's limit). */
export type BuyLimit = { ok: true; max: number } | { ok: false; reason: 'not_enough_gold' | 'inventory_full' }

/**
 * The most of `def` the player can buy now: min(bag room, gold / price, MAX_ITEM_COUNT) (docs/SHOPS.md §8.3).
 * Gold is checked first, as the server does.
 */
export function buyLimit(def: Pick<ItemDef, 'code' | 'price' | 'maxStack'>, gold: number, bag: BagView): BuyLimit {
  const price = Math.max(0, def.price)
  const byGold = price > 0 ? Math.floor(Math.max(0, gold) / price) : MAX_ITEM_COUNT
  if (byGold < 1) return { ok: false, reason: 'not_enough_gold' }
  const room = bagRoom(bag, def.code, def.maxStack)
  if (room < 1) return { ok: false, reason: 'inventory_full' }
  return { ok: true, max: Math.min(byGold, room, MAX_ITEM_COUNT) }
}

/** The most of `def` the player can afford and carry (0 when none). */
export function maxAffordable(def: Pick<ItemDef, 'code' | 'price' | 'maxStack'>, gold: number, bag: BagView): number {
  const r = buyLimit(def, gold, bag)
  return r.ok ? r.max : 0
}

/** Gold a sale of `count` pays: sellPrice x count, no durability or +N scaling (docs/SHOPS.md §2.6). */
export function sellValue(def: Pick<ItemDef, 'sellPrice'> | undefined, count: number): number {
  return Math.max(0, def?.sellPrice ?? 0) * Math.max(0, count)
}

/** Sales worth this much or more ask for a confirmation first (docs/SHOPS.md §8.3). */
export const SELL_CONFIRM_GOLD = 1000

/** Whether selling is refused before asking the server: canSell false or a quest item (the server says not_usable). */
export function unsellable(def: Pick<ItemDef, 'canSell' | 'category'> | undefined): boolean {
  return def?.canSell === false || def?.category === 'quest'
}

/** The option caption of each dialog service (M7: tolerant, so a wave-8 service needs no type change here). */
export const OPTION_KEY: Partial<Record<string, StringKey>> = {
  shop: 'npc.option.shop',
  storage: 'npc.option.storage',
  repair: 'npc.option.repair',
  quest: 'npc.option.quest',
  guild: 'npc.option.guild',
}

/** Services the dialog never lists (decision D13: the shop footer carries Repair / Repair all). */
export const HIDDEN_SERVICES: readonly string[] = ['repair']

type ServiceHandler = { fn: (ctx: unknown) => void; label?: StringKey }
const serviceHandlers = new Map<string, ServiceHandler>()

/**
 * M7 (decision D14): the handler of an extra NPC service (`'guild'` in wave 8). The dialog lists the service when the
 * server offers it and a handler is registered. Returns an unregister function.
 */
export function registerNpcServiceHandler(service: string, fn: (ctx: unknown) => void, label?: StringKey): () => void {
  const h: ServiceHandler = { fn, label }
  serviceHandlers.set(service, h)
  if (label) OPTION_KEY[service] ??= label
  return () => {
    if (serviceHandlers.get(service) === h) serviceHandlers.delete(service)
  }
}

/** The registered handler of an extra service, if any. */
export function npcServiceHandler(service: string): ((ctx: unknown) => void) | undefined {
  return serviceHandlers.get(service)?.fn
}

/**
 * The dialog's service options: shop, storage, quest in that fixed order, then the offered services that have a
 * registered handler (in the server's order), without duplicates. Hidden services (`repair`) are never listed.
 * "End conversation" always follows.
 */
export function dialogOptions(services: readonly string[]): string[] {
  const order = ['shop', 'storage', 'quest']
  const fixed = order.filter(s => services.includes(s) && (NPC_SERVICES as readonly string[]).includes(s))
  const extra = services.filter((s, i) => !order.includes(s) && !HIDDEN_SERVICES.includes(s) && serviceHandlers.has(s) && services.indexOf(s) === i)
  return [...fixed, ...extra]
}
/** The NPC greeting: NpcDef.greeting when exported and not blank, else null (the window shows the generic line). */
export function greetingOf(code: string, npcs: ReadonlyMap<string, NpcDef>, model?: string): string | null {
  const g = npcs.get(code)?.greeting ?? (model ? npcs.get(model)?.greeting : undefined)
  return g && g.trim() ? g.trim() : null
}
