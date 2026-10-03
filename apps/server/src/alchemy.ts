import { EQUIP_SLOTS, type EquipSlot, type GameplayRequest, type ItemDef } from '@sro/shared'
import { knob } from './config.ts'
import type { Gameplay } from './gameplay.ts'
import type { GmResult } from './gm.ts'
import { done, fail, takeFromBag, type Fail, type InvItem } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from './modules.ts'
import type { Mob, Player } from './world.ts'

/**
 * Alchemy (+N enhancement; docs/SYSTEMS_COMBAT.md §4; docs/WAVE_PLAN2.md D40, D44, D45, D48, D51; lane AL).
 *
 * - `alchemyReinforce {item, elixir, powder?}` (bag indexes) checks the three items, answers ok, stands the player
 *   still and starts a server-timed fuse (`alchemyStart`, ALCHEMY_FUSE_MS). Nothing is consumed yet.
 * - At the end of the fuse, in one inventory transaction: the three slots are re-checked (same codes, same plus), the
 *   elixir and one powder are taken, the roll decides, the plus is set. Then `inventoryUpdate`, `alchemyResult`, and
 *   from ALCHEMY_ANNOUNCE_FROM a server-wide system line. Success: plus + 1. Failure: plus 0 (and, only with
 *   ALCHEMY_DESTROY on, from +5 a 10 % chance the item is destroyed).
 * - Cancels (nothing changes, `alchemyResult cancelled`): alchemyCancel, a move, an attack, a skill, NPC talk, a
 *   pickup, a return-scroll cast, death, a warp. Logout drops the fuse silently.
 * - D44 soft lock: while a fuse is pending, `gate` refuses the trade/stall openers and every bag-changing request of
 *   the list below with `busy`, so a trade or stall opened mid-fuse is refused up front instead of failing late.
 * - D51: `extraDrops` is the authored elixir drop of a kill (ELIXIR_DROP_PCT x DROP_RATE, mobs from ELIXIR_DROP_MIN_LEVEL).
 * - GM `plus <equip slot | bag index> <0..12>` sets the plus of one of your items.
 *
 * `mounted` (D43) and `trading` / `stalling` (D45) come from the other modules' gates.
 */

export const PLUS_USAGE = 'plus <equip slot | bag index> <0..12>'

/** The GM command's ceiling (the wire allows 0..255; retail items stop at +12). */
export const GM_MAX_PLUS = 12

/** D44: requests refused with `busy` while a fuse is pending. */
export const FUSE_LOCKED: ReadonlySet<GameplayRequest> = new Set<GameplayRequest>([
  'tradeRequest', 'tradeRespond', 'stallCreate',
  'itemMove', 'itemSplit', 'itemEquip', 'itemUnequip', 'itemDrop',
  'shopSell', 'storageDeposit', 'repair',
])

/** Requests (and moveTo) that cancel a pending fuse and go through (docs/SYSTEMS_COMBAT.md §4.4). */
export const FUSE_CANCELLERS: ReadonlySet<GameplayRequest | 'moveTo'> = new Set<GameplayRequest | 'moveTo'>(['moveTo', 'attack', 'useSkill', 'npcTalk', 'pickup'])

/** Retail (ALCHEMY_DESTROY = 1): a failure from this plus may destroy the item, with DESTROY_CHANCE. */
export const DESTROY_FROM_PLUS = 5
export const DESTROY_CHANCE = 0.1

/** The authored elixir drop: which elixir, by weight (docs/SYSTEMS_COMBAT.md §4.5). */
export const ELIXIR_DROP_WEIGHTS: readonly (readonly [string, number])[] = [
  ['ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', 40],
  ['ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ARMOR_A', 40],
  ['ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_SHIELD_A', 10],
  ['ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ACCESSARY_A', 10],
]

const REINFORCEABLE: ReadonlySet<ItemDef['category']> = new Set<ItemDef['category']>(['weapon', 'shield', 'armor', 'accessory'])

/** Weapons, shields, armour and accessories: the equipment an elixir can enhance. */
export function isReinforceable(def: ItemDef | undefined): def is ItemDef {
  return !!def && !!def.slot && REINFORCEABLE.has(def.category)
}

export function isElixir(def: ItemDef | undefined): boolean {
  return !!def && def.category === 'alchemy' && def.reinforce?.kind === 'elixir'
}

export function isPowder(def: ItemDef | undefined): boolean {
  return !!def && def.category === 'alchemy' && def.reinforce?.kind === 'powder'
}

/** Whether elixir `elixir` fits equipment `item` (its TypeID3 is one of the elixir's targets). */
export function elixirFits(elixir: ItemDef, item: ItemDef): boolean {
  return isElixir(elixir) && (elixir.reinforce!.targets ?? []).includes(item.typeId[2])
}

/** Whether Lucky Powder `powder` matches equipment `item`'s degree (the powder's own Param1 degree, never ItemDef.degree). */
export function powderFits(powder: ItemDef, item: ItemDef): boolean {
  return isPowder(powder) && powder.reinforce!.degree === item.degree
}

/**
 * Success chance in percent of enhancing `item` from `plus` to `plus + 1` (docs/SYSTEMS_COMBAT.md §4.3):
 * min(100, (elixir[N] + matching powder[N]) x rate), N = plus + 1. A powder of another degree adds nothing.
 */
export function successChance(item: ItemDef, plus: number, elixir: ItemDef, powder: ItemDef | null | undefined, rate: number): number {
  const i = Math.max(0, Math.floor(plus))
  const e = isElixir(elixir) ? (elixir.reinforce!.rates[i] ?? 0) : 0
  const p = powder && powderFits(powder, item) ? (powder.reinforce!.rates[i] ?? 0) : 0
  const r = Number.isFinite(rate) ? Math.max(0, rate) : 1
  return Math.min(100, Math.max(0, (e + p) * r))
}

interface Held {
  slot: number
  code: string
}

interface Finish {
  success: boolean
  destroyed: boolean
  plus: number
  def: ItemDef
}

interface Fuse {
  item: Held & { plus: number }
  elixir: Held
  powder: Held | null
  endsAt: number
}

export class Alchemy implements GameplayModule {
  readonly name = 'alchemy'
  readonly handles: readonly GameplayRequest[] = ['alchemyReinforce', 'alchemyCancel']
  readonly whileDead: readonly GameplayRequest[] = ['alchemyCancel']
  /** Pending fuses, by player entity id. */
  private readonly fuses = new Map<number, Fuse>()

  constructor(readonly g: Gameplay) {}

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t === 'alchemyCancel') {
      // Idempotent: a cancel that crosses the result on the wire is not an error.
      answer(true)
      return this.cancel(p)
    }
    if (msg.t === 'alchemyReinforce') return this.reinforce(p, msg.item, msg.elixir, msg.powder, answer, now)
    answer(fail('not_found'))
  }

  /** The pending fuse of `p` (tests, other modules). */
  fusing(p: Player): { item: number; endsAt: number } | null {
    const f = this.fuses.get(p.id)
    return f ? { item: f.item.slot, endsAt: f.endsAt } : null
  }

  private rate(): number {
    return knob(this.g.config, 'alchemyRate')
  }

  private maxPlus(): number {
    return knob(this.g.config, 'alchemyMaxPlus')
  }

  /** The checks of §4.4 step 1 on the current bag (null = ok). */
  private check(bag: readonly (InvItem | null)[], item: number, elixir: number, powder: number | undefined): Fail | null {
    const slots = powder === undefined ? [item, elixir] : [item, elixir, powder]
    if (new Set(slots).size !== slots.length) return fail('invalid_slot')
    const it = bag[item]
    if (!it) return fail('invalid_slot', 'Put the equipment to enhance in the alchemy window first.')
    const def = this.g.data.item(it.code)
    if (!isReinforceable(def)) return fail('not_usable', 'Items that are not equipments can not be reinforced.')
    if (it.durability === 0) return fail('broken', 'A broken item cannot be enhanced. Repair it first.')
    const el = bag[elixir]
    if (!el) return fail('invalid_slot', 'Cannot reinforce without Elixir.')
    const elDef = this.g.data.item(el.code)
    if (!isElixir(elDef)) return fail('not_usable', 'Cannot reinforce without Elixir.')
    if (!elixirFits(elDef!, def)) return fail('alchemy_mismatch', "Cannot use an Elixir that is different from the equipment's type.")
    if (powder !== undefined) {
      const pw = bag[powder]
      if (!pw) return fail('invalid_slot', 'The Lucky Powder slot is empty.')
      const pwDef = this.g.data.item(pw.code)
      if (!isPowder(pwDef)) return fail('not_usable', 'Only a Lucky Powder goes in that slot.')
      if (!powderFits(pwDef!, def)) return fail('alchemy_mismatch', 'The level of the Lucky Powder and the equipment is different.')
    }
    if (it.plus >= this.maxPlus()) return fail('max_plus')
    return null
  }

  private reinforce(p: Player, item: number, elixir: number, powder: number | undefined, answer: Answer, now: number): void {
    if (this.fuses.has(p.id) || this.g.itemUses.skillBusy(p, now) || this.g.itemUses.casting(p)) return answer(fail('busy'))
    const inv = this.g.store.loadInventory(p.characterId)
    const inBag = (i: number | undefined) => i === undefined || (Number.isInteger(i) && i >= 0 && i < inv.bagSize)
    if (!inBag(item) || !inBag(elixir) || !inBag(powder)) return answer(fail('invalid_slot'))
    const refused = this.check(inv.bag, item, elixir, powder)
    if (refused) return answer(refused)
    const it = inv.bag[item]!
    const fuseMs = Math.max(0, Math.round(knob(this.g.config, 'alchemyFuseMs')))
    const f: Fuse = {
      item: { slot: item, code: it.code, plus: it.plus },
      elixir: { slot: elixir, code: inv.bag[elixir]!.code },
      powder: powder === undefined ? null : { slot: powder, code: inv.bag[powder]!.code },
      endsAt: now + fuseMs,
    }
    answer(true)
    // The fuse replaces whatever the player was doing (auto-attack, a pickup or talk walk) and stands it still.
    p.action = null
    if (p.move) this.g.world.halt(p, now)
    this.fuses.set(p.id, f)
    p.send({ t: 'alchemyStart', item, readyInMs: fuseMs })
    if (fuseMs === 0) this.complete(p, f, now)
  }

  /** Ends the fuse of `p`, if any, with `alchemyResult cancelled` (nothing changes). */
  cancel(p: Player): void {
    const f = this.fuses.get(p.id)
    if (!f) return
    this.fuses.delete(p.id)
    p.send({ t: 'alchemyResult', item: f.item.slot, code: f.item.code, outcome: 'cancelled', plus: f.item.plus })
  }

  private complete(p: Player, f: Fuse, _now: number): void {
    this.fuses.delete(p.id)
    const rng = this.g.rng
    const destroy = knob(this.g.config, 'alchemyDestroy') === 1
    const { result, draft } = this.g.store.inventoryTx<Finish>(p.characterId, (d) => {
      const it = d.bag[f.item.slot]
      if (!it || it.code !== f.item.code || it.plus !== f.item.plus) return fail('invalid_slot', 'the equipment changed')
      if (d.bag[f.elixir.slot]?.code !== f.elixir.code) return fail('invalid_slot', 'the elixir is gone')
      if (f.powder && d.bag[f.powder.slot]?.code !== f.powder.code) return fail('invalid_slot', 'the powder is gone')
      // The rules may have changed under the fuse (a GM edit, a repair): the same checks as the start.
      const refused = this.check(d.bag, f.item.slot, f.elixir.slot, f.powder?.slot)
      if (refused) return refused
      const def = this.g.data.item(it.code)!
      const chance = successChance(def, it.plus, this.g.data.item(f.elixir.code)!, f.powder ? this.g.data.item(f.powder.code) : null, this.rate())
      const took = takeFromBag(d, f.elixir.slot, 1)
      if (!took.ok) return took
      if (f.powder) {
        const tp = takeFromBag(d, f.powder.slot, 1)
        if (!tp.ok) return tp
      }
      const success = rng() * 100 < chance
      if (success) {
        d.setBag(f.item.slot, { ...it, plus: it.plus + 1 })
        return done({ success, destroyed: false, plus: it.plus + 1, def })
      }
      const destroyed = destroy && it.plus >= DESTROY_FROM_PLUS && rng() < DESTROY_CHANCE
      d.setBag(f.item.slot, destroyed ? null : { ...it, plus: 0 })
      return done({ success, destroyed, plus: 0, def })
    })
    if (!result.ok) {
      p.send({ t: 'alchemyResult', item: f.item.slot, code: f.item.code, outcome: 'cancelled', plus: f.item.plus })
      return
    }
    this.g.afterInventory(p, draft)
    const r = result.value
    // The client writes the result line (live i18n); a destroyed item shows as its slot emptied before the result.
    p.send({ t: 'alchemyResult', item: f.item.slot, code: f.item.code, outcome: r.success ? 'success' : 'fail', plus: r.plus })
    const from = knob(this.g.config, 'alchemyAnnounceFrom')
    if (r.success && from > 0 && r.plus >= from) {
      const text = `${p.name} enhanced ${r.def.name ?? r.def.code} to +${r.plus}!`
      for (const q of this.g.world.players.values()) q.send({ t: 'chat', channel: 'system', text })
    }
  }

  // ---- gate (D44) -------------------------------------------------------------------------------------

  gate(p: Player, t: GameplayRequest | 'moveTo', _now: number): Fail | null {
    if (!this.fuses.has(p.id)) return null
    if (FUSE_LOCKED.has(t as GameplayRequest)) return fail('busy', 'Not while the alchemy fuse is running.')
    if (FUSE_CANCELLERS.has(t)) this.cancel(p)
    return null
  }

  // ---- hooks ----------------------------------------------------------------------------------------

  tickPlayer(p: Player, now: number): void {
    const f = this.fuses.get(p.id)
    if (!f) return
    if (p.action !== null || p.move !== null || this.g.itemUses.skillBusy(p, now) || this.g.itemUses.casting(p)) return this.cancel(p)
    if (now >= f.endsAt) this.complete(p, f, now)
  }

  moved(p: Player): void {
    this.cancel(p)
  }

  playerDied(p: Player): void {
    this.cancel(p)
  }

  warped(p: Player, _reason: WarpReason): void {
    this.cancel(p)
  }

  inventoryChanged(p: Player): void {
    const f = this.fuses.get(p.id)
    if (!f) return
    // A fuse whose items left their slots ends at once (a quest turn-in, a GM edit): the finish would refuse anyway.
    const bag = this.g.store.loadInventory(p.characterId).bag
    const same = (h: Held) => bag[h.slot]?.code === h.code
    if (!same(f.item) || bag[f.item.slot]!.plus !== f.item.plus || !same(f.elixir) || (f.powder && !same(f.powder))) this.cancel(p)
  }

  forget(p: Player): void {
    this.fuses.delete(p.id)
  }

  // ---- loot (D51) -----------------------------------------------------------------------------------

  /** Extra loot of a kill (the authored elixir drop), in rollDrops' shape. */
  extraDrops(m: Mob): { code: string; count: number; gold?: boolean }[] {
    const pct = knob(this.g.config, 'elixirDropPct')
    if (!(pct > 0) || m.level < knob(this.g.config, 'elixirDropMinLevel')) return []
    const chance = Math.min(1, (pct / 100) * (this.g.config.dropRate ?? 1))
    const rng = this.g.rng
    if (!(rng() < chance)) return []
    const pool = ELIXIR_DROP_WEIGHTS.filter(([code]) => this.g.data.items.has(code))
    const total = pool.reduce((s, [, w]) => s + w, 0)
    if (total <= 0) return []
    let roll = rng() * total
    for (const [code, w] of pool) {
      roll -= w
      if (roll < 0) return [{ code, count: 1 }]
    }
    return [{ code: pool[pool.length - 1]![0], count: 1 }]
  }

  // ---- GM -------------------------------------------------------------------------------------------

  /** GM `plus <equip slot | bag index> <0..12>`: sets the plus of one of your items. */
  gm(self: Player, args: string[]): GmResult {
    const usage = { ok: false, message: `Usage: ${PLUS_USAGE}` }
    if (args.length !== 2) return usage
    const [where, raw] = args as [string, string]
    if (!/^\d{1,2}$/.test(raw)) return usage
    const plus = Number(raw)
    if (plus > GM_MAX_PLUS) return usage
    const equip = (EQUIP_SLOTS as readonly string[]).includes(where) ? (where as EquipSlot) : null
    const bag = equip ? null : /^\d{1,3}$/.test(where) ? Number(where) : NaN
    if (!equip && !Number.isInteger(bag)) return usage
    let name = ''
    const { result, draft } = this.g.store.inventoryTx(self.characterId, (d) => {
      const it = equip ? d.equip[equip] : d.inBag(bag!) ? d.bag[bag!] : null
      if (!it) return fail('invalid_slot')
      const def = this.g.data.item(it.code)
      if (!isReinforceable(def)) return fail('not_usable')
      name = def.name ?? def.code
      if (equip) d.setEquip(equip, { ...it, plus })
      else d.setBag(bag!, { ...it, plus })
      return done(undefined)
    })
    if (!result.ok) return { ok: false, message: result.reason === 'not_usable' ? 'Only equipment can have a plus.' : `Nothing there (${where}).` }
    this.g.afterInventory(self, draft)
    return { ok: true, message: `${name} is now +${plus}.` }
  }
}
