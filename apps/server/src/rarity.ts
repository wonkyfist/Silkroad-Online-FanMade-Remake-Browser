/**
 * Rare weapons (docs/RARITY.md §4): an ordinary weapon a monster drops may come as its family's Seal of Star, Moon or
 * Sun row (RARE_STAR_PCT / RARE_MOON_PCT / RARE_SUN_PCT, live), and a drop of rank RARE_ANNOUNCE_FROM and up is
 * announced to every player in the world (`rareNotice`). The seal is decided here, on the server, when the loot is
 * rolled; no request can turn a regular item into a seal (alchemy, repair, trade and the stall keep the code).
 */
import { CLIMB_TOP_DEGREE, RARITY, RARITY_DEFAULTS, RARITY_TIERS, rareCodeOf, rarityOf, rollRarity, type ItemDef, type RarityRates, type RarityTier } from '@sro/shared'
import type { ServerConfig } from './config.ts'
import type { Gameplay, RolledDrop } from './gameplay.ts'
import type { GmResult } from './gm.ts'
import { addItem } from './inventory.ts'
import type { Player } from './world.ts'

export const RARITY_USAGE = 'rarity [rates] | rarity give <star|moon|sun> [weapon or shield code | shield] | rarity drop <star|moon|sun> [weapon or shield code | shield]'

/** The live rates of `config` (absent = RARITY_DEFAULTS). */
export function rarityRates(config: Pick<ServerConfig, 'rareStarPct' | 'rareMoonPct' | 'rareSunPct'>): RarityRates {
  return {
    starPct: config.rareStarPct ?? RARITY_DEFAULTS.starPct,
    moonPct: config.rareMoonPct ?? RARITY_DEFAULTS.moonPct,
    sunPct: config.rareSunPct ?? RARITY_DEFAULTS.sunPct,
  }
}

/** An ordinary (regular grade) weapon: the rows a seal can come from. Seals, `_DEF` rows and other items never. */
export function isRegularWeapon(def: ItemDef | undefined): def is ItemDef {
  return !!def && def.category === 'weapon' && rarityOf(def.code) === null && /_[ABC]$/.test(def.code)
}

/**
 * The seal codes of a roll: every ordinary weapon of `drops` whose family has the rolled seal row becomes that row (the
 * count and plus stay). Other drops, and weapons whose seal is not in the catalog, are unchanged. Returns a new list.
 * The Climb (docs/CLIMB.md §4.1, D41, D53): with `top`, a weapon of the cap tier (degree `top.degree` and up, default
 * CLIMB_TOP_DEGREE) rolled Moon or Sun by a monster below `top.minLevel` comes as Seal of Star instead (Moon and Sun of
 * the cap tier are the level-25 hunt); D54: the degree below it (degree 3) likewise below `top.midMinLevel` (21);
 * lower degrees keep RARITY's rates.
 */
export function rollRareDrops(drops: readonly RolledDrop[], rng: () => number, rates: RarityRates, item: (code: string) => ItemDef | undefined, top?: { mobLevel: number; minLevel: number; degree?: number; midMinLevel?: number }): RolledDrop[] {
  return drops.map((d) => {
    const def = item(d.code)
    if (d.gold || !isRegularWeapon(def)) return d
    let tier = rollRarity(rng, rates)
    const topDeg = top?.degree ?? CLIMB_TOP_DEGREE
    if (top && top.minLevel > 0 && top.mobLevel < top.minLevel && def.degree >= topDeg && (tier === 'moon' || tier === 'sun')) tier = 'star'
    const mid = top?.midMinLevel ?? 0
    if (top && mid > 0 && top.mobLevel < mid && def.degree === topDeg - 1 && (tier === 'moon' || tier === 'sun')) tier = 'star'
    const code = tier ? rareCodeOf(d.code, tier) : null
    return code && item(code) ? { ...d, code } : d
  })
}

/** The sentence of a rare drop (the server log and the GM echo; the client builds its own from `rareNotice`). */
export function rareNoticeText(by: string, name: string, tier: RarityTier): string {
  return `${by} found a ${RARITY[tier].name} weapon: ${name}!`
}

export class Rarity {
  private capDegree: number | null = null
  constructor(private readonly g: Gameplay) {}

  /** The cap tier (docs/CLIMB.md D53): the highest degree of the catalog's regular weapons (degree 4 with the D4 export). */
  get topDegree(): number {
    if (this.capDegree === null) {
      let d = 0
      for (const it of this.g.data.items.values()) if (isRegularWeapon(it) && it.degree > d) d = it.degree
      this.capDegree = d || CLIMB_TOP_DEGREE
    }
    return this.capDegree
  }

  get rates(): RarityRates {
    return rarityRates(this.g.config)
  }

  /** The loot of a normal kill (by a monster of `mobLevel`) with its rare weapons rolled. */
  roll(drops: readonly RolledDrop[], mobLevel = Infinity): RolledDrop[] {
    const minLevel = this.g.config.rareTopMinLevel ?? RARITY_DEFAULTS.topMinLevel
    return rollRareDrops(drops, this.g.rng, this.rates, (c) => this.g.data.item(c), { mobLevel, minLevel, degree: this.topDegree, midMinLevel: this.g.config.rareMidMinLevel ?? RARITY_DEFAULTS.midMinLevel })
  }

  /** A ground item `code` was dropped for `owner`: every player hears a seal of rank RARE_ANNOUNCE_FROM and up. */
  dropped(code: string, owner: Player | null): void {
    const tier = rarityOf(code)
    if (!tier || !owner) return
    const from = this.g.config.rareAnnounceFrom ?? RARITY_DEFAULTS.announceFrom
    if (from <= 0 || RARITY[tier].rank < from) return
    const name = this.g.data.item(code)?.name ?? code
    for (const q of this.g.world.players.values()) q.send({ t: 'rareNotice', by: owner.name, item: code, name, tier })
    this.g.config.log(`rarity: ${rareNoticeText(owner.name, name, tier)}`)
  }

  /** GM `rarity`: the rates; `give` a seal of your weapon (or of a code) into your bag; `drop` one at your feet. */
  gm(self: Player, args: string[]): GmResult {
    const usage: GmResult = { ok: false, message: `Usage: ${RARITY_USAGE}` }
    const [verb = 'rates', tierArg, codeArg] = args
    if (verb === 'rates' && args.length <= 1) {
      const r = this.rates
      const from = this.g.config.rareAnnounceFrom ?? RARITY_DEFAULTS.announceFrom
      const announce = from > 0 ? `announced from ${RARITY[RARITY_TIERS[from - 1]!].name}` : 'not announced'
      const top = this.g.config.rareTopMinLevel ?? RARITY_DEFAULTS.topMinLevel
      const topLine = top > 0 ? ` Degree-${this.topDegree} (the cap tier) Moon and Sun only from level-${top} monsters (below: Star).` : ''
      return { ok: true, message: `Weapon drops: Seal of Star ${r.starPct} %, Moon ${r.moonPct} %, Sun ${r.sunPct} %; ${announce}.${topLine}`, data: { ...r, announceFrom: from, topMinLevel: top, topDegree: this.topDegree } }
    }
    if ((verb !== 'give' && verb !== 'drop') || args.length > 3) return usage
    const tier = (RARITY_TIERS as readonly string[]).includes(tierArg ?? '') ? (tierArg as RarityTier) : null
    if (!tier) return usage
    // `shield` (or no code with only a shield worn) names the worn shield; seal shields exist from degree 3 (RARITY.md §2).
    const equip = this.g.store.loadInventory(self.characterId).equip
    const base = codeArg?.toLowerCase() === 'shield' ? equip.shield?.code : codeArg?.toUpperCase() ?? equip.weapon?.code ?? equip.shield?.code
    if (!base) return { ok: false, message: 'Wear a weapon or shield, or name one (rarity give sun ITEM_CH_SWORD_03_A, rarity drop moon shield).' }
    const gear = this.g.data.item(base)
    const regularShield = !!gear && gear.category === 'shield' && rarityOf(gear.code) === null && /_[ABC]$/.test(gear.code)
    const regular = regularShield || isRegularWeapon(gear)
    const code = rarityOf(base) || regular ? rareCodeOf(base, tier) : null
    const def = code ? this.g.data.item(code) : undefined
    if (!def) return { ok: false, message: `${base} has no ${RARITY[tier].name} row.` }
    if (verb === 'drop') {
      const at = self.pos
      this.g.spawnGroundItem(def.code, 1, 0, [at[0] + 1, at[1], at[2]], self, Date.now())
      this.dropped(def.code, self)
      return { ok: true, message: `Dropped ${RARITY[tier].name} ${def.name ?? def.code} at your feet.` }
    }
    const { result, draft } = this.g.store.inventoryTx(self.characterId, (d) => addItem(d, def, 1))
    if (!result.ok) return { ok: false, message: result.reason === 'inventory_full' ? 'Your bag is full.' : `Cannot add ${def.code}: ${result.reason}.` }
    this.g.afterInventory(self, draft)
    return { ok: true, message: `Added ${RARITY[tier].name} ${def.name ?? def.code} (${def.code}).` }
  }
}
