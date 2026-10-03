import type { EquipSlot, GameplayRequest, RepairRef } from '@sro/shared'
import { isRepairable, repairPrice } from './durability.ts'
import type { Gameplay } from './gameplay.ts'
import { done, fail, type InvDraft, type InvItem, type Result } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from './modules.ts'
import type { Player } from './world.ts'

/**
 * Repair at the Blacksmith and the Protector Trader (docs/SYSTEMS_COMBAT.md §3.3; lane DR). NPCs with the 'repair' role
 * offer the service (npc.ts has()); either one repairs every repairable item.
 *
 * `repair {npc, items?}`: `items` absent = repair all (every bag and equipment item below its max); otherwise 1..16
 * refs, each `{equip}` or `{bag}` (a ref named twice counts once). Validation, in order: the service within reach
 * (`not_found` / `too_far`; dead is refused before this module), each listed ref holds an item (`invalid_slot`) that
 * can be repaired (`not_usable`), something is damaged (`nothing_to_repair`), gold covers the total
 * (`not_enough_gold`). All or nothing, in one inventoryTx: every damaged item back to full (`null`) and the gold taken.
 * Then `actionResult ok` → `inventoryUpdate {bag?, equip?, gold}` → `stats` when a worn item changed.
 * Price per item: `ceil(repairCost × missing / max)` (durability.ts repairPrice).
 */

export const UNREPAIRABLE_TEXT = 'The selected item is unrepairable.'
export const REPAIR_GOLD_TEXT = 'Cannot repair due to insufficient gold'

type Slot = { kind: 'equip'; slot: EquipSlot } | { kind: 'bag'; slot: number }

export interface RepairPlan {
  items: { at: Slot; code: string; price: number }[]
  total: number
}

export class Repairs implements GameplayModule {
  readonly name = 'repairs'
  readonly handles: readonly GameplayRequest[] = ['repair']

  constructor(readonly g: Gameplay) {}

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t !== 'repair') return answer(fail('not_found'))
    const npc = this.g.npcs.requireService(p, msg.npc, 'repair', now)
    if (!npc.ok) return answer(npc)
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      const plan = this.plan(d, msg.items)
      if (!plan.ok) return plan
      if (plan.value.total > d.gold) return fail('not_enough_gold', REPAIR_GOLD_TEXT)
      for (const { at } of plan.value.items) {
        if (at.kind === 'equip') d.setEquip(at.slot, { ...d.equip[at.slot]!, durability: null })
        else d.setBag(at.slot, { ...d.bag[at.slot]!, durability: null })
      }
      d.setGold(d.gold - plan.value.total)
      return plan
    })
    if (!result.ok) return answer(result)
    answer(true)
    this.g.afterInventory(p, draft)
  }

  /** What a repair of `refs` (absent = all) would fix in `d`, and its price; a Fail per the validation order. */
  plan(d: Pick<InvDraft, 'bag' | 'equip' | 'inBag' | 'bagSize'>, refs: readonly RepairRef[] | undefined): Result<RepairPlan> {
    const items: RepairPlan['items'] = []
    const seen = new Set<string>()
    const consider = (at: Slot, it: InvItem, explicit: boolean): Result<undefined> => {
      const def = this.g.data.item(it.code)
      if (!isRepairable(def)) return explicit ? fail('not_usable', UNREPAIRABLE_TEXT) : done(undefined)
      const price = repairPrice(def!, it)
      if (price > 0) items.push({ at, code: it.code, price })
      return done(undefined)
    }
    if (refs === undefined) {
      for (const [slot, it] of Object.entries(d.equip) as [EquipSlot, InvItem | undefined][]) if (it) consider({ kind: 'equip', slot }, it, false)
      for (let i = 0; i < d.bagSize; i++) {
        const it = d.bag[i]
        if (it) consider({ kind: 'bag', slot: i }, it, false)
      }
    } else {
      for (const ref of refs) {
        const at: Slot = 'equip' in ref ? { kind: 'equip', slot: ref.equip } : { kind: 'bag', slot: ref.bag }
        const key = `${at.kind}:${at.slot}`
        if (seen.has(key)) continue
        seen.add(key)
        const it = at.kind === 'equip' ? d.equip[at.slot] : d.inBag(at.slot) ? d.bag[at.slot] : null
        if (!it) return fail('invalid_slot')
        const r = consider(at, it, true)
        if (!r.ok) return r
      }
    }
    if (items.length === 0) return fail('nothing_to_repair')
    return done({ items, total: items.reduce((s, i) => s + i.price, 0) })
  }
}
