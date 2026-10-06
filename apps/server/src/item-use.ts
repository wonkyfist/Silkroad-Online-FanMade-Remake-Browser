import { type GameplayRequest, type ItemCastEndReason, type ItemDef } from '@sro/shared'
import { POTION_COOLDOWN_MS } from './formulas.ts'
import type { Gameplay } from './gameplay.ts'
import { fail, takeFromBag, type InvDraft } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from './modules.ts'
import type { Player } from './world.ts'

/**
 * Consumables (docs/SHOPS.md §4, docs/WAVE_PLAN.md §4.5 and decision 9; lane NPC-S).
 *
 * - HP/MP potions and grains heal at once and arm their cooldown group ('hp', 'mp', 'vigor': separate groups, so an
 *   HP and an MP potion can be drunk in the same second) for `use.cooldownMs` (default POTION_COOLDOWN_MS); the own
 *   client gets `itemCooldown`. Allowed at any time while alive: in combat, in town, during a return cast.
 * - Universal pills cure abnormal states once the skills engine has them (`SkillEngine.curable/cure`, optional);
 *   until then they answer `not_usable` and are not consumed.
 * - A used potion, grain or pill shows its visual to every viewer (`itemEffect`, lane FX-S).
 * - Return scrolls are a timed cast (`itemCast` to every viewer). The scroll is taken only at completion, then the
 *   player warps to the town return point (`itemCastEnd done` comes before the warp). Moving, attacking, picking up,
 *   talking, a skill, a warp or death interrupt it (`interrupted`); stopAction cancels it (`cancelled`); damage and
 *   potions do not. A cast whose scroll left the bag (sold, dropped, stored) ends `cancelled` at once.
 */

/** Rule (docs/SHOPS.md §4.3): the caster may drift this far (knockback aside) before the cast counts as moved. */
const CAST_MOVE_TOLERANCE_M = 0.3
/** The protocol's bound on cooldown/cast times (validate.ts MAX_ACTION_MS). */
const MAX_WIRE_MS = 600_000

/** What ItemUses may ask the skills engine (lane SK-S); every member is optional and duck-typed. */
interface SkillHooks {
  /** A skill action (prepare, cast or action phase) is running for `p`. */
  busy?(p: Player, now?: number): boolean
  /** Whether `p` has an abnormal state a pill of `cureLevel` removes. */
  curable?(p: Player, cureLevel: number): boolean
  /** Removes those states (sending effectRemove 'cured'). */
  cure?(p: Player, cureLevel: number, now: number): void
}

interface Cast {
  item: string
  /** The bag slot the scroll was used from (completion prefers it, then the lowest slot holding the code). */
  bag: number
  castMs: number
  startX: number
  startZ: number
  endsAt: number
}

export class ItemUses implements GameplayModule {
  readonly name = 'itemUse'
  readonly handles: readonly GameplayRequest[] = ['itemUse']
  /** Return-scroll casts in progress, by player entity id. */
  private readonly casts = new Map<number, Cast>()
  /**
   * Winter (docs/WINTER.md §13): items another module uses itself (a warm drink, a gift box), asked in order after the
   * cooldown check and before the built-in kinds. A hook that takes the item answers exactly once and returns true.
   */
  readonly hooks: ((p: Player, def: ItemDef, bag: number, group: string, answer: Answer, now: number) => boolean)[] = []

  constructor(readonly g: Gameplay) {}

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t === 'itemUse') return this.use(p, msg.bag, answer, now)
    answer(fail('not_found'))
  }

  private get skillHooks(): SkillHooks {
    return this.g.skills as unknown as SkillHooks
  }

  /** Whether a skill action (or the walk into range for one) is running for `p`. */
  skillBusy(p: Player, now: number): boolean {
    return p.action?.kind === 'skill' || this.skillHooks.busy?.(p, now) === true
  }

  /** The return-scroll cast of `p`, if one is running. */
  casting(p: Player): { item: string; endsAt: number } | null {
    const c = this.casts.get(p.id)
    return c ? { item: c.item, endsAt: c.endsAt } : null
  }

  use(p: Player, bag: number, answer: Answer, now: number): void {
    const inv = this.g.store.loadInventory(p.characterId)
    const it = Number.isInteger(bag) && bag >= 0 && bag < inv.bagSize ? inv.bag[bag] : null
    if (!it) return answer(fail('invalid_slot'))
    const def = this.g.data.item(it.code)
    const use = def?.use
    if (!def || !use) return answer(fail('not_usable'))
    const group = use.cooldownGroup ?? def.code
    if ((p.cooldowns.get(group) ?? 0) > now) return answer(fail('cooldown'))
    for (const h of this.hooks) if (h(p, def, bag, group, answer, now)) return
    // Wave 8 (D52): horse summons and Recovery Kits belong to the mounts module.
    if (use.summon || use.target === 'mount') return this.g.mounts.useItem(p, def, bag, answer, now)
    if (use.returnToTown) return this.startReturn(p, def, bag, answer, now)
    if (def.category === 'pill' || def.cureLevel !== undefined) return this.pill(p, def, bag, group, answer, now)
    if (use.hp || use.mp || use.hpPct || use.mpPct) return this.potion(p, def, bag, group, answer, now)
    answer(fail('not_usable'))
  }

  /** Takes one of the item at `bag` and arms its cooldown group; the answer goes out after the commit. */
  consume(p: Player, def: ItemDef, bag: number, group: string, answer: Answer, now: number): InvDraft | null {
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => takeFromBag(d, bag, 1))
    if (!result.ok) {
      answer(result)
      return null
    }
    const cooldownMs = Math.min(MAX_WIRE_MS, Math.max(0, def.use?.cooldownMs ?? POTION_COOLDOWN_MS))
    if (cooldownMs > 0) p.cooldowns.set(group, now + cooldownMs)
    answer(true)
    this.g.afterInventory(p, draft)
    if (cooldownMs > 0) p.send({ t: 'itemCooldown', group, readyInMs: cooldownMs, totalMs: cooldownMs })
    return draft
  }

  private potion(p: Player, def: ItemDef, bag: number, group: string, answer: Answer, now: number): void {
    const use = def.use!
    if (!this.consume(p, def, bag, group, answer, now)) return
    const hp = Math.min(p.maxHp, p.hp + (use.hp ?? 0) + ((use.hpPct ?? 0) * p.maxHp) / 100)
    const mp = Math.min(p.maxMp, p.mp + (use.mp ?? 0) + ((use.mpPct ?? 0) * p.maxMp) / 100)
    if (hp !== p.hp || mp !== p.mp) this.g.setVitals(p, hp, mp)
    this.effect(p, def)
  }

  private pill(p: Player, def: ItemDef, bag: number, group: string, answer: Answer, now: number): void {
    const level = def.cureLevel ?? 0
    const s = this.skillHooks
    // Nothing to cure (or no abnormal states yet): refused, and the pill is kept (docs/SHOPS.md §4.2).
    if (!s.curable || !s.cure || !s.curable(p, level)) return answer(fail('not_usable', 'nothing to cure'))
    if (!this.consume(p, def, bag, group, answer, now)) return
    s.cure(p, level, now)
    this.effect(p, def)
  }

  /**
   * The consumable's visual for `p`'s viewers, the user included (docs/EFFECTS.md §3.7, P3 `itemEffect`): after a
   * successful potion, herb, grain, vigor or pill use. Return scrolls have itemCast instead.
   */
  private effect(p: Player, def: ItemDef): void {
    this.g.world.broadcastAbout(p, { t: 'itemEffect', id: p.id, item: def.code })
  }

  private startReturn(p: Player, def: ItemDef, bag: number, answer: Answer, now: number): void {
    if (this.casts.has(p.id) || this.skillBusy(p, now)) return answer(fail('busy'))
    const castMs = Math.min(MAX_WIRE_MS, Math.max(0, Math.round(def.use?.castMs ?? 0)))
    if (castMs === 0) {
      // No cast time in the data: the scroll works at once.
      const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => takeFromBag(d, bag, 1))
      if (!result.ok) return answer(result)
      answer(true)
      this.g.afterInventory(p, draft)
      return this.g.toTown(p)
    }
    // The cast replaces whatever the player was doing (auto-attack, a pickup or talk walk) and stands it still.
    answer(true)
    p.action = null
    this.g.world.halt(p, now)
    const [x, , z] = this.g.world.positionAt(p, now)
    this.casts.set(p.id, { item: def.code, bag, castMs, startX: x, startZ: z, endsAt: now + castMs })
    this.g.world.broadcastAbout(p, { t: 'itemCast', id: p.id, item: def.code, castMs })
  }

  /** Ends the cast of `p`, if any, telling every viewer why. */
  cancel(p: Player, reason: Exclude<ItemCastEndReason, 'done'>): void {
    const c = this.casts.get(p.id)
    if (!c) return
    this.casts.delete(p.id)
    this.g.world.broadcastAbout(p, { t: 'itemCastEnd', id: p.id, item: c.item, reason })
  }

  private complete(p: Player, c: Cast): void {
    this.casts.delete(p.id)
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      const at = d.bag[c.bag]?.code === c.item ? c.bag : d.bag.findIndex((i) => i?.code === c.item)
      return at < 0 ? fail('invalid_slot', 'the scroll is gone') : takeFromBag(d, at, 1)
    })
    if (!result.ok) {
      this.g.world.broadcastAbout(p, { t: 'itemCastEnd', id: p.id, item: c.item, reason: 'cancelled' })
      return
    }
    this.g.afterInventory(p, draft)
    this.g.world.broadcastAbout(p, { t: 'itemCastEnd', id: p.id, item: c.item, reason: 'done' })
    this.g.toTown(p)
  }

  /** Whether `p`'s bag still holds `code` (a sold, dropped or stored scroll ends the cast early). */
  private holds(p: Player, code: string): boolean {
    return this.g.store.loadInventory(p.characterId).bag.some((i) => i?.code === code)
  }

  // ---- hooks ----------------------------------------------------------------------------------------

  tickPlayer(p: Player, now: number): void {
    const c = this.casts.get(p.id)
    if (!c) return
    const [x, , z] = this.g.world.positionAt(p, now)
    const moved = p.move !== null || Math.hypot(x - c.startX, z - c.startZ) > CAST_MOVE_TOLERANCE_M
    if (moved || p.action !== null || this.skillBusy(p, now)) return this.cancel(p, 'interrupted')
    if (now >= c.endsAt) this.complete(p, c)
  }

  moved(p: Player): void {
    this.cancel(p, 'interrupted')
  }

  stopped(p: Player): void {
    this.cancel(p, 'cancelled')
  }

  playerDied(p: Player): void {
    this.cancel(p, 'interrupted')
  }

  warped(p: Player, _reason: WarpReason): void {
    // Our own completion clears the cast before its warp; any other warp (GM tp/summon, respawn) interrupts.
    this.cancel(p, 'interrupted')
  }

  inventoryChanged(p: Player): void {
    const c = this.casts.get(p.id)
    if (c && !this.holds(p, c.item)) this.cancel(p, 'cancelled')
  }

  forget(p: Player): void {
    this.casts.delete(p.id)
  }
}

