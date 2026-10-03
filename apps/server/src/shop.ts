import { BUYBACK_SLOTS, type BuybackEntry, type GameplayRequest, type ItemDef } from '@sro/shared'
import type { Gameplay } from './gameplay.ts'
import { addGold, addItem, fail, putBack, takeFromBag, toStack, type InvItem } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from './modules.ts'
import type { Player } from './world.ts'

/**
 * NPC shops (docs/SHOPS.md §2, §6; lane NPC-S): shopBuy, shopSell and shopBuyback.
 *
 * Every request re-checks the NPC (live, has a shop, within NPC_INTERACT_RANGE; NpcDialogs.requireService) and runs
 * inside one inventory transaction, so it is all-or-nothing and requests never interleave (one process, synchronous
 * SQLite). Rules:
 * - buy: the good is in that NPC's shop and `reqLevel <= config.levelCap` (else `not_found`); `count <= maxStack x
 *   bagSize` (else `invalid_count`); `price x count` gold (`not_enough_gold`); all or nothing (`inventory_full`).
 * - sell: bag slots only (equipped items cannot be sold); `canSell === false` or quest items -> `not_usable`; pays
 *   `sellPrice x count`, and a sale that would pass MAX_GOLD fails `gold_limit` with nothing changed.
 * - buyback: the last BUYBACK_SLOTS sales of each character, in memory only (cleared when it leaves the world), at
 *   exactly the price the sale paid; the exact stack (code, count, plus, durability) comes back.
 */
export class Shops implements GameplayModule {
  readonly name = 'shops'
  readonly handles: readonly GameplayRequest[] = ['shopBuy', 'shopSell', 'shopBuyback']
  /** Recent sales per character id, oldest first. */
  private readonly sold = new Map<number, { item: InvItem; price: number }[]>()
  /** Buyable goods per NPC code (the level-cap filter applied), built on first use. */
  private readonly goodsCache = new Map<string, ReadonlyMap<string, ItemDef>>()

  constructor(readonly g: Gameplay) {}

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'shopBuy':
        return this.buy(p, msg.npc, msg.item, msg.count, answer, now)
      case 'shopSell':
        return this.sell(p, msg.npc, msg.bag, msg.count, answer, now)
      case 'shopBuyback':
        return this.buyback(p, msg.npc, msg.index, msg.code, answer, now)
      default:
        return answer(fail('not_found'))
    }
  }

  /**
   * What the shop of NPC `code` sells: every good with an item definition whose required level is within the server's
   * level cap (docs/SHOPS.md §2.4: the level-21 chests stay hidden at cap 20). Empty for an NPC without a shop.
   */
  goods(code: string): ReadonlyMap<string, ItemDef> {
    let out = this.goodsCache.get(code)
    if (!out) {
      const map = new Map<string, ItemDef>()
      for (const tab of this.g.data.shopOf(code)?.tabs ?? []) {
        for (const c of tab.items) {
          const def = this.g.data.item(c)
          if (def && def.reqLevel <= this.g.config.levelCap) map.set(c, def)
        }
      }
      this.goodsCache.set(code, (out = map))
    }
    return out
  }

  /** Drops the cached goods of NPC `code` (the NPC editor changed its shop link). */
  forgetGoods(code: string): void {
    this.goodsCache.delete(code)
  }

  buy(p: Player, npcId: number, code: string, count: number, answer: Answer, now: number): void {
    const npc = this.g.npcs.requireService(p, npcId, 'shop', now)
    if (!npc.ok) return answer(npc)
    const def = this.goods(npc.value.code).get(code)
    if (!def) return answer(fail('not_found'))
    const cost = def.price * count
    if (!Number.isSafeInteger(cost) || cost < 0) return answer(fail('invalid_count'))
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      // More than a full bag of this good can never fit (replaces the old hard-coded 48 slots).
      if (!Number.isInteger(count) || count < 1 || count > Math.max(1, def.maxStack) * d.bagSize) return fail('invalid_count')
      const g = addGold(d, -cost)
      return g.ok ? addItem(d, def, count) : g
    })
    if (!result.ok) return answer(result)
    answer(true)
    this.g.afterInventory(p, draft)
  }

  sell(p: Player, npcId: number, bag: number, count: number | undefined, answer: Answer, now: number): void {
    const npc = this.g.npcs.requireService(p, npcId, 'shop', now)
    if (!npc.ok) return answer(npc)
    const out: { sale?: { item: InvItem; price: number } } = {}
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      const it = d.inBag(bag) ? d.bag[bag] : null
      if (!it) return fail('invalid_slot')
      const def = this.g.data.item(it.code)
      if (!def || def.canSell === false || def.category === 'quest') return fail('not_usable')
      const taken = takeFromBag(d, bag, count)
      if (!taken.ok) return taken
      const price = Math.max(0, def.sellPrice) * taken.value.count
      if (!Number.isSafeInteger(price)) return fail('invalid_count')
      const g = addGold(d, price, { strict: true })
      if (!g.ok) return g
      out.sale = { item: taken.value, price }
      return g
    })
    if (!result.ok || !out.sale) return answer(result.ok ? fail('invalid_slot') : result)
    answer(true)
    this.remember(p, out.sale)
    this.g.afterInventory(p, draft)
    this.sendBuyback(p)
  }

  buyback(p: Player, npcId: number, index: number, code: string | undefined, answer: Answer, now: number): void {
    const npc = this.g.npcs.requireService(p, npcId, 'shop', now)
    if (!npc.ok) return answer(npc)
    const list = this.sold.get(p.characterId) ?? []
    const entry = Number.isInteger(index) ? list[index] : undefined
    if (!entry) return answer(fail('not_found'))
    // The client names the item it meant: a stale index (a double press before the new list) buys nothing.
    if (code !== undefined && entry.item.code !== code) return answer(fail('not_found', 'The buyback list has changed.'))
    const def = this.g.data.item(entry.item.code)
    if (!def) return answer(fail('not_found'))
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      const g = addGold(d, -entry.price)
      return g.ok ? putBack(d, def, entry.item) : g
    })
    if (!result.ok) return answer(result)
    // Removed in the same synchronous call as the purchase, so the same entry can never be bought back twice.
    list.splice(list.indexOf(entry), 1)
    answer(true)
    this.g.afterInventory(p, draft)
    this.sendBuyback(p)
  }

  private remember(p: Player, sale: { item: InvItem; price: number }): void {
    let list = this.sold.get(p.characterId)
    if (!list) this.sold.set(p.characterId, (list = []))
    list.push(sale)
    while (list.length > BUYBACK_SLOTS) list.shift()
  }

  /** This character's buyback entries, oldest first. */
  entries(p: Player): BuybackEntry[] {
    return (this.sold.get(p.characterId) ?? []).map((e) => ({ item: toStack(e.item), price: e.price }))
  }

  /** Sends the full buyback list (after a sale, a buyback, and when a shop dialog opens). */
  sendBuyback(p: Player): void {
    p.send({ t: 'buyback', entries: this.entries(p) })
  }

  forget(p: Player): void {
    this.sold.delete(p.characterId)
  }
}
