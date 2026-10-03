import { EQUIP_SLOTS, type CombatHit, type EquipSlot, type GameplayRequest, type ItemDef, type SkillDef } from '@sro/shared'
import { knob } from './config.ts'
import type { Gameplay, HitExtra } from './gameplay.ts'
import type { GmResult } from './gm.ts'
import { fail, type Fail, type InvItem } from './inventory.ts'
import type { GameplayModule } from './modules.ts'
import type { Cos, Mob, Player } from './world.ts'

/**
 * Durability wear (docs/SYSTEMS_COMBAT.md §3.2; lane DR). Repair requests are repair.ts.
 *
 * - Instance durability is `ItemStack.durability` (absent / null = full); max is the top of the def's roll
 *   (`stats.durability[1]`). Items without `stats.durability` never wear.
 * - Wear, from Gameplay.dealHits after the hits are applied (never for DoT ticks, `extra.dot`; hits a ridden horse takes
 *   never get here): each landed player hit on a mob (`hit`/`crit`) has DUR_WEAPON_LOSS_PCT to cost the weapon 1; each
 *   landed hit on a player (`hit`/`crit`, damage > 0) has DUR_ARMOR_LOSS_PCT to cost one random worn armour piece 1;
 *   each `block` has DUR_SHIELD_LOSS_PCT to cost the shield 1. Death costs nothing.
 * - Write path: one inventoryTx per call that lost points (so one write per point lost at most, never per hit), then
 *   `inventoryUpdate {equip}`; reaching 0 also sends `stats` (the recompute: a broken item gives no stats) and the
 *   system line "Your X is broken."; falling to <= DUR_WARN_PCT of max for the first time sends "Your X is almost
 *   broken." (the client plays ui.eqbreak / ui.eqdanger from the equip update).
 * - `refuse` (`broken`) in Gameplay.attackRequest, Gameplay.tickAction (before the auto-attack swing) and
 *   SkillEngine.plan: a broken weapon refuses attacks and every row that needs a weapon; force skills that need none
 *   still work. The other broken-item rules: inventory.ts equipItem (`broken`) and formulas.ts playerCombatStats.
 */

export const DUR_USAGE = 'dur <equip slot | all> <durability>'

/** Armour pieces that wear on hits taken (the shield wears on blocks, accessories never). */
export const ARMOR_SLOTS: readonly EquipSlot[] = ['head', 'shoulders', 'chest', 'legs', 'hands', 'feet']

/** "Cannot attack because the weapon is broken" (UIIT_SKILL_USE_FAIL_BROKEN_WEAPON). */
export const BROKEN_WEAPON_TEXT = 'Cannot attack because the weapon is broken'

/** The top of the def's durability roll (the max of every instance); null when the item never wears. */
export function maxDurability(def: Pick<ItemDef, 'stats'> | undefined | null): number | null {
  const max = def?.stats?.durability?.[1]
  return typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.round(max) : null
}

/** Current durability of a stack (absent / null = full), clamped to 0..max. */
export function curDurability(stack: { durability?: number | null }, max: number): number {
  const d = stack.durability
  return d === undefined || d === null ? max : Math.max(0, Math.min(max, Math.round(d)))
}

/** Whether an item can be repaired at all (weapons, shields, armour: a roll, CanRepair and a Cost_Repair). */
export function isRepairable(def: Pick<ItemDef, 'stats' | 'canRepair' | 'repairCost'> | undefined | null): boolean {
  return !!def && def.canRepair !== false && (def.repairCost ?? 0) > 0 && maxDurability(def) !== null
}

/** Repair price of one item (docs/SYSTEMS_COMBAT.md §3.3, a decision): ceil(repairCost x missing / max). */
export function repairPrice(def: Pick<ItemDef, 'stats' | 'repairCost'>, stack: { durability?: number | null }): number {
  const max = maxDurability(def)
  if (max === null) return 0
  const missing = max - curDurability(stack, max)
  return missing > 0 ? Math.ceil(((def.repairCost ?? 0) * missing) / max) : 0
}

/** The DUR_WARN_PCT threshold of an item (at or below it the item is "almost broken"). */
export function warnAt(max: number, pct: number): number {
  return (max * pct) / 100
}

const landed = (h: CombatHit) => h.outcome === 'hit' || h.outcome === 'crit'

export class Durability implements GameplayModule {
  readonly name = 'durability'
  readonly handles: readonly GameplayRequest[] = []

  constructor(readonly g: Gameplay) {}

  /** Wear after `a` landed `hits` on `t` (weapon, armour and shield rolls). */
  afterHits(a: Player | Mob, t: Player | Mob | Cos, hits: readonly CombatHit[], extra: HitExtra, now: number): void {
    if (extra.dot || hits.length === 0) return
    const cfg = this.g.config
    const rng = this.g.rng
    const roll = (pct: number) => pct > 0 && (pct >= 100 || rng() * 100 < pct)
    if (a.kind === 'player' && t.kind === 'mob' && !a.dead) {
      const pct = knob(cfg, 'durWeaponLossPct')
      let lost = 0
      for (const h of hits) if (landed(h) && roll(pct)) lost++
      if (lost > 0) this.wear(a, { weapon: lost }, now)
    }
    if (t.kind === 'player') {
      const armorPct = knob(cfg, 'durArmorLossPct')
      const shieldPct = knob(cfg, 'durShieldLossPct')
      const loss: Partial<Record<EquipSlot, number>> = {}
      for (const h of hits) {
        if (landed(h) && h.damage > 0 && roll(armorPct)) {
          const pieces = ARMOR_SLOTS.filter((s) => this.wearable(t, s, loss[s] ?? 0))
          const slot = pieces.length ? pieces[Math.min(pieces.length - 1, Math.floor(rng() * pieces.length))]! : null
          if (slot) loss[slot] = (loss[slot] ?? 0) + 1
        } else if (h.outcome === 'block' && roll(shieldPct)) loss.shield = (loss.shield ?? 0) + 1
      }
      if (Object.keys(loss).length) this.wear(t, loss, now)
    }
  }

  /** Whether `p`'s item in `slot` has durability left after `pending` more points. */
  private wearable(p: Player, slot: EquipSlot, pending: number): boolean {
    const stack = p.equip[slot]
    const max = stack ? maxDurability(this.g.data.item(stack.code)) : null
    return !!stack && max !== null && curDurability(stack, max) - pending > 0
  }

  /**
   * Takes durability off worn items (points per slot) in one transaction, then tells the player: `inventoryUpdate`,
   * `stats` when an item broke, and the system lines.
   */
  wear(p: Player, loss: Partial<Record<EquipSlot, number>>, _now: number): void {
    const lines: string[] = []
    let broke = false
    const warnPct = knob(this.g.config, 'durWarnPct')
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      for (const [slot, n] of Object.entries(loss) as [EquipSlot, number][]) {
        const it = d.equip[slot]
        const def = it ? this.g.data.item(it.code) : undefined
        const max = maxDurability(def)
        if (!it || !def || max === null || !(n > 0)) continue
        const before = curDurability(it, max)
        if (before <= 0) continue
        const after = Math.max(0, before - n)
        d.setEquip(slot, { ...it, durability: after })
        if (after === 0) {
          broke = true
          lines.push(`Your ${def.name} is broken.`)
        } else if (before > warnAt(max, warnPct) && after <= warnAt(max, warnPct)) lines.push(`Your ${def.name} is almost broken.`)
      }
      return { ok: true, value: undefined }
    })
    if (!result.ok || !draft.changed) return
    const up = draft.updates()
    for (const e of up.equip ?? []) {
      if (e.item) p.equip[e.slot] = e.item
      else delete p.equip[e.slot]
    }
    if (up.equip) p.send({ t: 'inventoryUpdate', equip: up.equip })
    if (broke) {
      this.g.refresh(p)
      p.send({ t: 'stats', stats: this.g.stats(p) })
    }
    for (const text of lines) p.send({ t: 'chat', channel: 'system', text })
  }

  /** Whether `p`'s equipped weapon is broken (durability 0). */
  weaponBroken(p: Player): boolean {
    return p.equip.weapon?.durability === 0
  }

  /** `broken` when `p`'s weapon is broken and the attack (or skill row) needs it, else null. */
  refuse(p: Player, what: 'attack' | SkillDef): Fail | null {
    if (!this.weaponBroken(p)) return null
    if (what === 'attack' || what.basicAttack || what.weapons.length > 0) return fail('broken', BROKEN_WEAPON_TEXT)
    return null
  }

  /** GM `dur <slot | all> <n>`: sets the durability of own worn items (0 = broken; the max or more = full). */
  gm(self: Player, args: string[]): GmResult {
    const [which, raw] = args
    const n = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
    if (!which || !Number.isSafeInteger(n)) return { ok: false, message: `Usage: ${DUR_USAGE}` }
    const key = which.toLowerCase()
    const all = key === 'all'
    if (!all && !(EQUIP_SLOTS as readonly string[]).includes(key)) return { ok: false, message: `Unknown equipment slot "${which}". Slots: all, ${EQUIP_SLOTS.join(', ')}.` }
    const done: string[] = []
    const { result, draft } = this.g.store.inventoryTx(self.characterId, (d) => {
      for (const slot of all ? EQUIP_SLOTS : [key as EquipSlot]) {
        const it = d.equip[slot]
        const def = it ? this.g.data.item(it.code) : undefined
        const max = maxDurability(def)
        if (!it || !def || max === null) continue
        const next: InvItem = { ...it, durability: n >= max ? null : n }
        if (next.durability === it.durability) continue
        d.setEquip(slot, next)
        done.push(`${slot} ${def.name} ${Math.min(n, max)}/${max}`)
      }
      return done.length ? { ok: true, value: undefined } : fail('nothing_to_repair')
    })
    if (!result.ok) return { ok: false, message: all ? 'No worn item with durability to change.' : `Nothing to change in the ${key} slot (empty, no durability, or already ${n}).` }
    this.g.afterInventory(self, draft)
    return { ok: true, message: `Durability set: ${done.join('; ')}.` }
  }
}
