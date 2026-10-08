/**
 * items.json: ItemDef records from itemdata (client, authoritative). Scope (docs/DATA.md "Items"):
 *  - Chinese equipment (weapons, shields, garment/protector/armour sets for both genders, accessories) of degree
 *    <= maxDegree (4: the Climb's top tier, docs/CLIMB.md §4.1.2): the ordinary _A/_B/_C grades and the creation
 *    defaults (*_DEF). Seal items (_RARE): every degree's weapon seals (docs/RARITY.md §2: Seal of Star / Moon / Sun,
 *    the rare weapons) and, of the other equipment, degrees RARE_ITEM_DEGREES (wave 11, docs/UNIQUES.md §3.4: the
 *    unique's Seal of Star drop; the Climb: the cap tier's seals too). Normal drop tables skip
 *    every seal (./drops.ts); the server makes rare weapons from ordinary weapon drops (docs/RARITY.md §4).
 *  - Consumables: HP/MP/vigor potions and grains, universal pills, return scrolls, arrows, and the gold piles.
 *  - Wave 8 (docs/SYSTEMS_COMBAT.md §1.1, §4.1, by code): the Red Horse, the three horse Recovery Kits, the four _A
 *    elixirs and the 1st-4th Lucky Powders (the degree limit alone would let powders _05.._09 through; the 4th matches
 *    degree 4, docs/CLIMB.md §4.1.2).
 */
import {
  CH_WEAPON_TID4,
  COUNTRY_CHINA,
  COUNTRY_EUROPE,
  GENDER_FEMALE,
  GENDER_MALE,
  itemStatColumns,
  type ItemDataRow,
  type StatRange,
} from '@sro/formats'
import type { ArmorType, ItemCategory, ItemDef, ItemReinforce, ItemSlotKind, ItemStats, ItemUse, PerPlusStat, Range, WeaponType } from '../../../shared/src/content.ts'
import { textOf } from './client-source.ts'
import { iconUrl, modelRef, modelSource, type OutExists } from './models.ts'

export const MAX_ITEM_DEGREE = 4

/** Potion and pill cooldown per group: the server rule POTION_COOLDOWN_MS; the client data has no column for it. */
export const ITEM_USE_COOLDOWN_MS = 1000

const EQUIP_CODE =
  /^ITEM_CH_(SWORD|BLADE|SPEAR|TBLADE|BOW|SHIELD|EARRING|NECKLACE|RING)_\d\d_[ABC](_DEF|_RARE)?$|^ITEM_CH_[MW]_(CLOTHES|LIGHT|HEAVY)_\d\d_[A-Z]{2}_[ABC](_DEF|_RARE)?$/
/**
 * The degrees whose non-weapon seal rows (_RARE) are exported (wave 11, W11-CV, docs/WAVE_PLAN7.md §4.5: degree 3; the
 * Climb's cap tier, docs/CLIMB.md §4.1.2: degree 4). Weapon seals: every degree.
 */
export const RARE_ITEM_DEGREES: readonly number[] = [3, 4]
const CONSUMABLE_CODE =
  /^ITEM_ETC_(HP|MP|ALL)_S?POTION_\d\d$|^ITEM_ETC_CURE_ALL_\d\d$|^ITEM_ETC_SCROLL_RETURN_0[1-3]$|^ITEM_ETC_AMMO_ARROW_01(_DEF)?$|^ITEM_ETC_GOLD_0[1-3]$/
/** Wave 8 (docs/SYSTEMS_COMBAT.md §8 EXP work 1): horse, Recovery Kits, _A elixirs, Lucky Powders 1st-4th (4th: CLIMB §4.1.2). */
const SYSTEMS_CODE =
  /^ITEM_COS_C_HORSE1$|^ITEM_ETC_COS_HP_POTION_0[1-3]$|^ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_(WEAPON|SHIELD|ARMOR|ACCESSARY)_A$|^ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_0[1-4]$/

/** Rows the export includes (before the degree limit). */
export function isExportedItem(r: ItemDataRow, maxDegree = MAX_ITEM_DEGREE): boolean {
  if (!r.service || r.cashItem !== 0) return false
  if (EQUIP_CODE.test(r.codeName)) {
    // docs/RARITY.md §2: weapon seals (TypeID 3/1/6/x) at every degree, the other seals at RARE_ITEM_DEGREES only.
    if (/_RARE$/.test(r.codeName) && !RARE_ITEM_DEGREES.includes(r.degree) && r.typeId[2] !== 6) return false
    return r.typeId[0] === 3 && r.typeId[1] === 1 && r.country === COUNTRY_CHINA && r.degree >= 1 && r.degree <= maxDegree
  }
  if (CONSUMABLE_CODE.test(r.codeName) || SYSTEMS_CODE.test(r.codeName)) return r.typeId[0] === 3 && r.typeId[1] === 3 && r.degree <= maxDegree
  return false
}

/**
 * The four _A elixirs name icon item\etc\archemy_reinforce_recipe_a.ddj, which Media.pk2 does not have; the per-kind
 * _b icon stands in (docs/SYSTEMS_COMBAT.md §4.1, decision). Returns the AssocFileIcon128 to export and, when it was
 * replaced, the note for fieldSources.icon.
 */
export function itemIconSource(r: ItemDataRow, hasIcon?: (assocFileIcon: string) => boolean): { icon?: string; note?: string } {
  const icon = r.assocFileIcon
  const kind = /^ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_(WEAPON|SHIELD|ARMOR|ACCESSARY)_A$/.exec(r.codeName)?.[1]
  if (!icon || !kind || !/archemy_reinforce_recipe_a\.ddj$/i.test(icon)) return icon ? { icon } : {}
  // The client ships no archemy_reinforce_recipe_a.ddj [confirmed pnpm sro ls Media icon/item/etc]: without a probe, fall back.
  if (hasIcon?.(icon)) return { icon }
  const fallback = icon.replace(/archemy_reinforce_recipe_a\.ddj$/i, `archemy_reinforce_recipe_${kind.toLowerCase()}_b.ddj`)
  if (hasIcon && !hasIcon(fallback)) return { icon }
  return { icon: fallback, note: `fallback: ${icon} is not in Media.pk2; the ${kind.toLowerCase()} _b icon stands in` }
}

/** Big-endian bytes of a packed itemdata Param (0x19140F0A -> [25, 20, 15, 10]). */
const beBytes = (v: number): number[] => [24, 16, 8, 0].map(sh => (v >>> sh) & 0xff)

/**
 * Alchemy materials (TypeID 3/3/10/x, docs/SYSTEMS_COMBAT.md §4.1, §4.3): elixirs (TypeID4 1) fit the equipment
 * TypeID3 values packed in Param1 (zero bytes dropped); powders (TypeID4 2) carry their degree in Param1. rates[i] is
 * the percent for target plus i + 1: Param2-4, four bytes each, big-endian.
 */
export function itemReinforce(typeId4: number, params: readonly number[]): ItemReinforce | undefined {
  const rates = [params[1], params[2], params[3]].flatMap(v => beBytes(v ?? 0))
  if (typeId4 === 1) return { kind: 'elixir', targets: beBytes(params[0] ?? 0).filter(b => b !== 0), rates }
  if (typeId4 === 2) return { kind: 'powder', degree: params[0] ?? 0, rates }
  return undefined
}

const WEAPON_BY_TID4 = new Map<number, WeaponType>(Object.entries(CH_WEAPON_TID4).map(([k, v]) => [v, k as WeaponType]))
const ARMOR_BY_TID3: Readonly<Record<number, ArmorType>> = { 1: 'garment', 2: 'protector', 3: 'armor' }
const ARMOR_SLOT_BY_TID4: Readonly<Record<number, ItemSlotKind>> = { 1: 'head', 2: 'shoulders', 3: 'chest', 4: 'legs', 5: 'hands', 6: 'feet' }
const ACCESSORY_SLOT_BY_TID4: Readonly<Record<number, ItemSlotKind>> = { 1: 'earring', 2: 'necklace', 3: 'ring' }
const CONSUMABLE_BY_TID3: Readonly<Record<number, ItemCategory>> = { 1: 'potion', 2: 'pill', 3: 'scroll', 4: 'ammo', 5: 'gold' }
/** 4: the horse Recovery Kits (3/3/1/4), their own cooldown group (docs/SYSTEMS_COMBAT.md §8 EXP work 1). */
const POTION_GROUP_BY_TID4: Readonly<Record<number, string>> = { 1: 'hp', 2: 'mp', 3: 'vigor', 4: 'cos_hp' }
/** Potion TypeID4 whose effect lands on the user's horse. */
const MOUNT_POTION_TID4 = 4

export function classifyItem(r: ItemDataRow): { category: ItemCategory; slot?: ItemSlotKind; weaponType?: WeaponType; armorType?: ArmorType } {
  const [t1, t2, t3, t4] = r.typeId
  if (t1 === 3 && t2 === 1) {
    if (t3 >= 1 && t3 <= 3) return { category: 'armor', slot: ARMOR_SLOT_BY_TID4[t4]!, armorType: ARMOR_BY_TID3[t3]! }
    if (t3 === 4) return { category: 'shield', slot: 'shield' }
    if (t3 === 5) return { category: 'accessory', slot: ACCESSORY_SLOT_BY_TID4[t4]! }
    if (t3 === 6 && WEAPON_BY_TID4.has(t4)) return { category: 'weapon', slot: 'weapon', weaponType: WEAPON_BY_TID4.get(t4)! }
  }
  if (t1 === 3 && t2 === 3 && CONSUMABLE_BY_TID3[t3]) return { category: CONSUMABLE_BY_TID3[t3]! }
  if (t1 === 3 && t2 === 3 && t3 === 10) return { category: 'alchemy' }
  return { category: 'etc' }
}

const round1 = (v: number) => Math.round(v * 10) / 10 + 0
const nonZero = (r: StatRange) => r[0] !== 0 || r[1] !== 0
const range = (r: StatRange): Range => [round1(r[0]), round1(r[1])]

export interface ItemContext {
  strings: ReadonlyMap<string, string>
  exists: OutExists
  /** Weapon TypeID4 -> basic-attack skill code (skills.ts). */
  basicAttacks: ReadonlyMap<number, string>
  /** Does Media.pk2 have the icon (AssocFileIcon128)? Absent = assume yes. */
  hasIcon?: (assocFileIcon: string) => boolean
}

/**
 * One ItemDef. Attack ranges: itemdata stores the rolled minimum ([95, 96]) and maximum ([97, 98]) separately;
 * physAttack/magAttack are [mean of the min roll, mean of the max roll] (a typical item), and `rolls` keeps the
 * raw bounds. Every other stat is the [lower, upper] roll of one value.
 */
export function buildItemDef(r: ItemDataRow, ctx: ItemContext): ItemDef & Record<string, unknown> {
  const cls = classifyItem(r)
  const s = itemStatColumns(r)
  const reqLevel = r.reqLevels.find(q => q.type === 1)?.level ?? 0
  const iconSrc = itemIconSource(r, ctx.hasIcon)
  const def: ItemDef & Record<string, unknown> = {
    code: r.codeName,
    id: r.id,
    name: textOf(ctx.strings, r.nameStrId),
    typeId: r.typeId,
    category: cls.category,
    degree: r.degree,
    reqLevel,
    reqGender: r.reqGender === GENDER_MALE ? 'male' : r.reqGender === GENDER_FEMALE ? 'female' : 'any',
    race: r.country === COUNTRY_CHINA ? 'china' : r.country === COUNTRY_EUROPE ? 'europe' : 'any',
    maxStack: Math.max(1, r.maxStack),
    price: r.price,
    sellPrice: r.sellPrice,
    model: modelRef(r.assocFileObj, ctx.exists),
    icon: iconSrc.icon && ctx.hasIcon && !ctx.hasIcon(iconSrc.icon) ? null : iconUrl(iconSrc.icon),
  }
  if (cls.slot) def.slot = cls.slot
  if (cls.weaponType) def.weaponType = cls.weaponType
  if (cls.armorType) def.armorType = cls.armorType
  const fieldSources: Record<string, string> = {}
  if (iconSrc.note) fieldSources.icon = iconSrc.note
  if (cls.category === 'weapon') {
    def.twoHanded = r.twoHanded
    def.range = round1(r.range * 0.1)
    const basic = ctx.basicAttacks.get(r.typeId[3])
    if (basic) def.basicAttack = basic
  }
  if (cls.category === 'weapon' || cls.category === 'shield' || cls.category === 'armor' || cls.category === 'accessory') {
    const stats: ItemStats = {}
    const mean = (x: StatRange) => round1((x[0] + x[1]) / 2)
    if (nonZero(s.physAttackMin) || nonZero(s.physAttackMax)) stats.physAttack = [mean(s.physAttackMin), mean(s.physAttackMax)]
    if (nonZero(s.magAttackMin) || nonZero(s.magAttackMax)) stats.magAttack = [mean(s.magAttackMin), mean(s.magAttackMax)]
    const set = (k: keyof ItemStats, v: StatRange) => {
      if (nonZero(v)) stats[k] = range(v)
    }
    set('physDefence', s.physDefence)
    set('magDefence', s.magDefence)
    set('parryRate', s.parryRate)
    set('blockRate', s.blockRate)
    set('physAbsorb', s.physAbsorb)
    set('magAbsorb', s.magAbsorb)
    set('durability', s.durability)
    set('hitRate', s.hitRate)
    set('critRate', s.critRate)
    def.stats = stats
    if (stats.physAttack || stats.magAttack) {
      fieldSources['stats.physAttack'] = 'client itemdata cols 95-98: [mean of min roll, mean of max roll]; raw bounds in rolls'
      def.rolls = {
        physAttackMin: range(s.physAttackMin),
        physAttackMax: range(s.physAttackMax),
        magAttackMin: range(s.magAttackMin),
        magAttackMax: range(s.magAttackMax),
      }
    }
    const perPlus: Partial<Record<PerPlusStat, number>> = {}
    const inc = (k: PerPlusStat, v: number) => {
      if (v !== 0) perPlus[k] = Math.round(v * 100) / 100
    }
    inc('physAttack', s.physAttackInc)
    inc('magAttack', s.magAttackInc)
    inc('physDefence', s.physDefenceInc)
    inc('magDefence', s.magDefenceInc)
    inc('parryRate', s.parryRateInc)
    inc('physAbsorb', s.physAbsorbInc)
    inc('magAbsorb', s.magAbsorbInc)
    inc('hitRate', s.hitRateInc)
    if (Object.keys(perPlus).length) def.perPlus = perPlus
    const reinforce: Record<string, Range> = {}
    const pct = (k: string, v: StatRange) => {
      if (nonZero(v)) reinforce[k] = [round1(v[0] / 10), round1(v[1] / 10)]
    }
    pct('physAttackMin', s.physAttackReinforceMin)
    pct('physAttackMax', s.physAttackReinforceMax)
    pct('magAttackMin', s.magAttackReinforceMin)
    pct('magAttackMax', s.magAttackReinforceMax)
    pct('physDefence', s.physDefenceReinforce)
    pct('magDefence', s.magDefenceReinforce)
    if (Object.keys(reinforce).length) def.reinforcePct = reinforce
    if (s.reqStr || s.reqInt) def.reqStats = { str: s.reqStr, int: s.reqInt }
  }
  const p = s.params.map(x => x.value)
  if (cls.category === 'potion') {
    const use: ItemUse = {}
    if (p[0]! > 0) use.hp = p[0]!
    if (p[1]! > 0) use.hpPct = p[1]!
    if (p[2]! > 0) use.mp = p[2]!
    if (p[3]! > 0) use.mpPct = p[3]!
    const group = POTION_GROUP_BY_TID4[r.typeId[3]]
    if (group) use.cooldownGroup = group
    use.cooldownMs = ITEM_USE_COOLDOWN_MS
    fieldSources['use.cooldownMs'] = 'rule: POTION_COOLDOWN_MS (no client column)'
    if (r.typeId[3] === MOUNT_POTION_TID4) {
      use.target = 'mount'
      fieldSources['use.target'] = 'client itemdata TypeID 3/3/1/4 (COS recovery kit): the user\'s horse'
    }
    def.use = use
  } else if (cls.category === 'scroll' && /^COS_/.test(s.params[0]?.desc ?? '')) {
    // Horse items (3/3/3/2): Param1 is 0 and its Desc (col 119) names the COS summoned.
    def.use = { summon: s.params[0]!.desc! }
    fieldSources['use.summon'] = 'client itemdata Param1 Desc (col 119): the characterdata COS code'
  } else if (cls.category === 'alchemy') {
    const reinforce = itemReinforce(r.typeId[3], p)
    if (reinforce) {
      def.reinforce = reinforce
      fieldSources.reinforce = reinforce.kind === 'elixir'
        ? 'client itemdata Param1 bytes (equipment TypeID3, zeros dropped); Param2-4 big-endian bytes = rates for +1..+12'
        : 'client itemdata Param1 (degree; not ItemDef.degree = ceil(class / 3)); Param2-4 big-endian bytes = rates for +1..+12'
    }
  } else if (cls.category === 'pill') {
    def.use = { cooldownGroup: 'cure', cooldownMs: ITEM_USE_COOLDOWN_MS }
    fieldSources['use.cooldownMs'] = 'rule: POTION_COOLDOWN_MS (no client column)'
    def.cureLevel = p[0]!
  } else if (cls.category === 'scroll' && s.params[2]?.desc === 'RESURRECT') {
    def.use = { returnToTown: true, castMs: p[0]! }
    fieldSources['use.castMs'] = 'client itemdata Param1 (30000 / 15000 / 5000 for the three return scrolls)'
  } else if (cls.category === 'gold') {
    def.goldPileFrom = p[0]!
    fieldSources.goldPileFrom = 'client itemdata Param1: smallest amount shown with this pile model'
  }
  // _RefObjCommon CanTrade (col 16; D23: 0 on the creation defaults *_DEF), CanSell (col 17) and CanDrop (col 20).
  if (r.cells[16]?.trim() === '0') def.canTrade = false
  if (r.cells[17]?.trim() === '0') def.canSell = false
  if (r.cells[20]?.trim() === '0') def.canDrop = false
  // docs/SHOPS.md §7.5: CanRepair (col 22), Cost_Repair (col 27), KeepingFee (col 30).
  const int = (col: number) => {
    const v = Number(r.cells[col]?.trim())
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0
  }
  def.canRepair = r.cells[22]?.trim() === '1'
  const repairCost = int(27)
  if (repairCost) def.repairCost = repairCost
  const keepFee = int(30)
  if (keepFee) def.keepFee = keepFee
  if (r.assocFileDrop && r.assocFileDrop !== r.assocFileObj) def.dropModel = modelRef(r.assocFileDrop, ctx.exists)
  const src = modelSource(r.assocFileObj)
  if (src && !def.model) fieldSources.model = `not converted: ${src}`
  if (Object.keys(fieldSources).length) def.fieldSources = fieldSources
  return def
}

export function buildItems(rows: readonly ItemDataRow[], ctx: ItemContext, maxDegree = MAX_ITEM_DEGREE): ItemDef[] {
  const seen = new Set<string>()
  const out: ItemDef[] = []
  for (const r of rows) {
    if (!isExportedItem(r, maxDegree) || seen.has(r.codeName)) continue
    seen.add(r.codeName)
    out.push(buildItemDef(r, ctx))
  }
  return out.sort((a, b) => a.id - b.id)
}
