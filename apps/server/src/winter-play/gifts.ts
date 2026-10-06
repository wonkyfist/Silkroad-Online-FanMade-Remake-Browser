import { WINTER_CODES, WINTER_PLAY, rollGift, type ItemDef, type ItemStack } from '@sro/shared'
import type { Gameplay, RolledDrop } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, addItem, fail, takeFromBag } from '../inventory.ts'
import type { Answer, GameplayModule } from '../modules.ts'
import type { Mob, Player } from '../world.ts'
import type { WinterPlay } from './service.ts'

/**
 * Holiday gift boxes and the warm drink (docs/WINTER.md §13.5). A GameplayModule named `gifts`:
 *
 * - **Drops**: while the winter layer is on, any monster killed (not by a GM) drops a Holiday Gift Box with
 *   GIFT_DROP_PCT (x DROP_RATE); the Ice Yeti drops GIFT_YETI_COUNT of them with her own loot (yeti.ts).
 * - **Opening** (`itemUse` on the box, any time, also after the season): one box out, its rewards in, all in one
 *   inventory transaction (a full bag refuses and keeps the box). winter-play.ts rollGift: two rewards from the common
 *   and good tiers (potions, Ginger Tea, gold, a Lucky Powder, a Return Scroll) and with GIFT_RARE_PCT a rare one (an
 *   elixir, Lucky Powders (3rd) or a pile of gold). The opener gets `giftOpened` (the reward toast).
 * - **Ginger Tea** (`itemUse`): in the season, warmth at once and a glow (warmth.ts drink); out of it, refused and kept.
 */
export const GIFT_USAGE = 'gift [count [player]]'

export class GiftService implements GameplayModule {
  readonly name = 'gifts'

  constructor(
    private readonly g: Gameplay,
    private readonly play: WinterPlay,
  ) {
    g.itemUses.hooks.push((p, def, bag, group, answer, now) => this.use(p, def, bag, group, answer, now))
  }

  /** ItemUses hook: the gift box and the warm drink; false for any other item. */
  private use(p: Player, def: ItemDef, bag: number, group: string, answer: Answer, now: number): boolean {
    if (def.use?.gift) {
      this.open(p, def, bag, group, answer, now)
      return true
    }
    if (def.use?.warmth !== undefined) {
      if (!this.play.isOn) {
        answer(fail('not_usable', 'Ginger Tea only warms you in the snow season.'))
        return true
      }
      if (!this.g.itemUses.consume(p, def, bag, group, answer, now)) return true
      this.play.warmth.drink(p, def, now)
      this.g.world.broadcastAbout(p, { t: 'itemEffect', id: p.id, item: def.code })
      return true
    }
    return false
  }

  /** Opens one box: takes it and adds the rolled rewards in one transaction. */
  open(p: Player, def: ItemDef, bag: number, group: string, answer: Answer, now: number): void {
    const roll = rollGift(this.g.rng, (c) => this.g.data.items.has(c), { rarePct: this.play.knobs().giftRarePct })
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      const it = d.inBag(bag) ? d.bag[bag] : null
      if (!it || it.code !== def.code) return fail('invalid_slot')
      const taken = takeFromBag(d, bag, 1)
      if (!taken.ok) return taken
      for (const r of roll.items) {
        const rd = this.g.data.item(r.code)
        if (!rd) continue
        const added = addItem(d, rd, r.count)
        if (!added.ok) return added
      }
      if (roll.gold > 0) {
        const g = addGold(d, roll.gold)
        if (!g.ok) return g
      }
      return taken
    })
    if (!result.ok) return answer(result)
    const cooldownMs = Math.max(0, def.use?.cooldownMs ?? 0)
    if (cooldownMs > 0) p.cooldowns.set(group, now + cooldownMs)
    answer(true)
    this.g.afterInventory(p, draft)
    const rewards: ItemStack[] = roll.items.map((r) => ({ code: r.code, count: r.count }))
    p.send({ t: 'giftOpened', item: def.code, rewards: rewards.slice(0, 8), ...(roll.gold > 0 ? { gold: roll.gold } : {}), ...(roll.rare ? { rare: true as const } : {}) })
    this.play.snowballs.bump(p.characterId, now, { gifts: 1 })
    if (roll.rare) this.g.config.log(`winter: ${p.name} opened a gift box with a rare reward`)
  }

  /** A season kill's extra drop: a gift box with GIFT_DROP_PCT (not the yeti: her loot has its own). */
  extraDrops(m: Mob): RolledDrop[] {
    if (!this.play.isOn || m.id === this.play.yeti.id || !this.g.data.items.has(WINTER_CODES.gift)) return []
    const pct = this.play.knobs().giftDropPct * (this.g.config.dropRate ?? 1)
    return this.g.rng() * 100 < pct ? [{ code: WINTER_CODES.gift, count: 1 }] : []
  }

  /** GM `gift`: puts gift boxes in a bag (yours, or a player's). */
  gm(self: Player | null, args: string[]): GmResult {
    const n = args[0] === undefined ? 1 : Number(args[0])
    const who = args[1] ? this.g.world.byName(args[1]) : self
    if (!Number.isInteger(n) || n < 1 || n > 50 || args.length > 2) return { ok: false, message: `Usage: ${GIFT_USAGE}` }
    if (!who) return { ok: false, message: args[1] ? `No player named ${args[1]} in the world.` : 'Only in the world.' }
    const def = this.g.data.item(WINTER_CODES.gift)
    if (!def) return { ok: false, message: 'No gift boxes on this server (the winter content is not installed).' }
    const r = this.g.gmItem(who, def, def.code, n)
    if (!r.ok) return { ok: false, message: `Could not give the boxes: ${r.reason.replace(/_/g, ' ')}.` }
    return { ok: true, message: `${n} Holiday Gift Box${n === 1 ? '' : 'es'} to ${who.name} (right-click to open; opening works any time).` }
  }

  /** The table in force, for the GM line and the docs. */
  static describe(): string {
    const g = WINTER_PLAY.gifts
    return `${g.rolls} rewards per box, a rare one with ${g.rarePct} %`
  }
}
