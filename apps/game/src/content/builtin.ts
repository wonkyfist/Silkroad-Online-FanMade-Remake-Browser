/**
 * Authored stand-in content for the mock server (?mock=1) and for the client when the data export
 * (/out/data/mobs.json, items.json, ...) is not there yet. Codes are real CodeName128 ids so the same
 * records are found once the export exists; every number here is our own (fieldSources say so), not
 * client data. Environment-neutral (no DOM, no fetch).
 */
import {
  CHARACTER_RULES,
  type DropTable,
  type ItemDef,
  type ItemSlotKind,
  type LevelDef,
  type MobDef,
  type NpcDef,
  type ShopDef,
  type StarterWeapon,
} from '@sro/shared'

const AUTHORED = 'authored: mock content (apps/game/src/content/builtin.ts)'

function mob(m: Omit<MobDef, 'typeId' | 'mp' | 'magAttack' | 'magDefence' | 'model' | 'fieldSources'>): MobDef {
  return { ...m, typeId: [1, 2, 1, 1], mp: 0, magAttack: [0, 0], magDefence: Math.round(m.physDefence / 2), model: null, fieldSources: { '*': AUTHORED } }
}

export const BUILTIN_MOBS: MobDef[] = [
  mob({
    code: 'MOB_CH_MANGNYANG', id: 1, name: 'Mangnyang', rarity: 'normal', level: 1, hp: 60,
    physAttack: [3, 6], physDefence: 2, hitRate: 20, parryRate: 5, critRate: 5,
    attackRange: 0.6, attackIntervalMs: 2200, radius: 0.5, walkSpeed: 1.6, runSpeed: 4.5,
    aggressive: false, exp: 26, scale: 100, variants: ['normal', 'champion'],
  }),
  mob({
    code: 'MOB_CH_TIGER', id: 2, name: 'Tiger', rarity: 'normal', level: 4, hp: 240,
    physAttack: [9, 15], physDefence: 6, hitRate: 35, parryRate: 10, critRate: 5,
    attackRange: 0.8, attackIntervalMs: 2600, radius: 0.8, walkSpeed: 2, runSpeed: 5,
    aggressive: true, exp: 95, scale: 100, variants: ['normal', 'champion'],
  }),
  mob({
    code: 'MOB_CH_TIGERWOMAN', id: 3, name: 'Tiger Girl', rarity: 'unique', level: 8, hp: 3000,
    physAttack: [20, 32], physDefence: 20, hitRate: 60, parryRate: 20, critRate: 10,
    attackRange: 1, attackIntervalMs: 3000, radius: 0.7, walkSpeed: 2, runSpeed: 5.5,
    aggressive: true, exp: 2000, scale: 100,
  }),
]

type ItemInit = Pick<ItemDef, 'code' | 'name' | 'category'> & Partial<ItemDef>

function item(i: ItemInit): ItemDef {
  return {
    id: 0,
    typeId: [3, 3, 3, 1],
    degree: 1,
    reqLevel: 0,
    reqGender: 'any',
    race: 'china',
    maxStack: 1,
    price: 10,
    sellPrice: 2,
    model: null,
    icon: null,
    fieldSources: { '*': AUTHORED },
    ...i,
  }
}

const WEAPON_ROWS: { family: StarterWeapon; tag: string; name: string; range: number; twoHanded: boolean; atk: [number, number] }[] = [
  { family: 'sword', tag: 'SWORD', name: 'Sword', range: 1.6, twoHanded: false, atk: [7, 12] },
  { family: 'blade', tag: 'BLADE', name: 'Blade', range: 1.6, twoHanded: false, atk: [8, 13] },
  { family: 'spear', tag: 'SPEAR', name: 'Spear', range: 2.4, twoHanded: true, atk: [10, 17] },
  { family: 'glaive', tag: 'TBLADE', name: 'Glaive', range: 2.4, twoHanded: true, atk: [11, 16] },
  { family: 'bow', tag: 'BOW', name: 'Bow', range: 16, twoHanded: true, atk: [8, 15] },
]

/** The `*_DEF` starter item of each starter weapon family (docs/PROTOCOL.md section 4). */
export const STARTER_WEAPON_ITEMS: Record<StarterWeapon, string> = {
  sword: 'ITEM_CH_SWORD_01_A_DEF',
  blade: 'ITEM_CH_BLADE_01_A_DEF',
  spear: 'ITEM_CH_SPEAR_01_A_DEF',
  glaive: 'ITEM_CH_TBLADE_01_A_DEF',
  bow: 'ITEM_CH_BOW_01_A_DEF',
}

const weapons: ItemDef[] = WEAPON_ROWS.flatMap(w => [
  item({
    code: `ITEM_CH_${w.tag}_01_A_DEF`, name: `Old ${w.name}`, category: 'weapon', slot: 'weapon', weaponType: w.family,
    twoHanded: w.twoHanded, range: w.range, stats: { physAttack: w.atk, durability: [20, 20] }, price: 0, sellPrice: 1, canSell: false,
    typeId: [3, 1, 6, 1],
  }),
  item({
    code: `ITEM_CH_${w.tag}_01_A`, name: `Iron ${w.name}`, category: 'weapon', slot: 'weapon', weaponType: w.family, reqLevel: 3,
    twoHanded: w.twoHanded, range: w.range, stats: { physAttack: [w.atk[0] + 4, w.atk[1] + 6], hitRate: [5, 5], durability: [40, 40] },
    price: 300, sellPrice: 60, typeId: [3, 1, 6, 2],
  }),
])

const ARMOR_SLOTS: { tag: string; slot: ItemSlotKind; name: string; def: number }[] = [
  { tag: 'HA', slot: 'head', name: 'Cap', def: 2 },
  { tag: 'SA', slot: 'shoulders', name: 'Shoulder Guard', def: 2 },
  { tag: 'BA', slot: 'chest', name: 'Robe', def: 4 },
  { tag: 'LA', slot: 'legs', name: 'Trousers', def: 3 },
  { tag: 'AA', slot: 'hands', name: 'Gloves', def: 1 },
  { tag: 'FA', slot: 'feet', name: 'Shoes', def: 2 },
]

const armour: ItemDef[] = (['M', 'W'] as const).flatMap(g =>
  ARMOR_SLOTS.map(a =>
    item({
      code: `ITEM_CH_${g}_CLOTHES_01_${a.tag}_A_DEF`,
      name: `${g === 'M' ? "Men's" : "Women's"} Cloth ${a.name}`,
      category: 'armor',
      slot: a.slot,
      armorType: 'garment',
      reqGender: g === 'M' ? 'male' : 'female',
      stats: { physDefence: [a.def, a.def], magDefence: [a.def, a.def], parryRate: [1, 1], durability: [30, 30] },
      price: 40 * a.def,
      sellPrice: 8 * a.def,
      typeId: [3, 1, 1, 1],
    }),
  ),
)

const misc: ItemDef[] = [
  item({
    code: 'ITEM_CH_SHIELD_01_A_DEF', name: 'Wooden Shield', category: 'shield', slot: 'shield',
    stats: { physDefence: [5, 5], blockRate: [10, 10], durability: [30, 30] }, price: 80, sellPrice: 16, typeId: [3, 1, 4, 1],
  }),
  item({
    code: 'ITEM_CH_RING_01_A_DEF', name: 'Copper Ring', category: 'accessory', slot: 'ring',
    stats: { magDefence: [2, 2] }, price: 120, sellPrice: 24, typeId: [3, 1, 12, 3],
  }),
  item({
    code: 'ITEM_ETC_HP_POTION_01', name: 'HP Recovery Herb', category: 'potion', maxStack: 50, price: 4, sellPrice: 1,
    use: { hp: 80, cooldownGroup: 'hp', cooldownMs: 1000 }, typeId: [3, 3, 1, 1],
  }),
  item({
    code: 'ITEM_ETC_MP_POTION_01', name: 'MP Recovery Herb', category: 'potion', maxStack: 50, price: 4, sellPrice: 1,
    use: { mp: 80, cooldownGroup: 'mp', cooldownMs: 1000 }, typeId: [3, 3, 1, 2],
  }),
  item({
    code: 'ITEM_ETC_SCROLL_RETURN_01', name: 'Return Scroll', category: 'scroll', maxStack: 10, price: 60, sellPrice: 12,
    use: { returnToTown: true, castMs: 2000, cooldownGroup: 'return', cooldownMs: 2000 }, typeId: [3, 3, 3, 1],
  }),
  item({ code: 'ITEM_ETC_GOLD_01', name: 'Gold', category: 'gold', maxStack: 1, price: 0, sellPrice: 0, canDrop: false, canSell: false, typeId: [3, 3, 5, 0] }),
  item({ code: 'ITEM_ETC_GOLD_02', name: 'Gold', category: 'gold', maxStack: 1, price: 0, sellPrice: 0, canDrop: false, canSell: false, typeId: [3, 3, 5, 0] }),
  item({ code: 'ITEM_ETC_GOLD_03', name: 'Gold', category: 'gold', maxStack: 1, price: 0, sellPrice: 0, canDrop: false, canSell: false, typeId: [3, 3, 5, 0] }),
]

export const BUILTIN_ITEMS: ItemDef[] = [...weapons, ...armour, ...misc].map((it, i) => ({ ...it, id: i + 1 }))

const commonLoot = [
  { item: 'ITEM_ETC_HP_POTION_01', weight: 6, count: [1, 2] as [number, number] },
  { item: 'ITEM_ETC_MP_POTION_01', weight: 4, count: [1, 2] as [number, number] },
]
const gearLoot = [
  ...ARMOR_SLOTS.flatMap(a => [
    { item: `ITEM_CH_M_CLOTHES_01_${a.tag}_A_DEF`, weight: 2 },
    { item: `ITEM_CH_W_CLOTHES_01_${a.tag}_A_DEF`, weight: 2 },
  ]),
  ...WEAPON_ROWS.map(w => ({ item: `ITEM_CH_${w.tag}_01_A`, weight: 1 })),
  { item: 'ITEM_CH_SHIELD_01_A_DEF', weight: 1 },
  { item: 'ITEM_CH_RING_01_A_DEF', weight: 1 },
]

export const BUILTIN_DROPS: DropTable[] = [
  { mob: 'MOB_CH_MANGNYANG', gold: { chance: 0.7, amount: [4, 18] }, groups: [{ chance: 0.35, entries: commonLoot }, { chance: 0.08, entries: gearLoot }], provenance: 'authored' },
  { mob: 'MOB_CH_TIGER', gold: { chance: 0.85, amount: [20, 60] }, groups: [{ chance: 0.5, entries: commonLoot }, { chance: 0.2, entries: gearLoot }], provenance: 'authored' },
  {
    mob: 'MOB_CH_TIGERWOMAN',
    gold: { chance: 1, amount: [800, 1500] },
    groups: [{ chance: 1, entries: commonLoot }, { chance: 1, entries: gearLoot }, { chance: 1, entries: gearLoot }],
    provenance: 'authored',
  },
]

export const BUILTIN_SHOPS: ShopDef[] = [
  {
    id: 'STORE_CH_POTION',
    npcs: ['NPC_CH_POTION'],
    tabs: [{ name: 'Potions', items: ['ITEM_ETC_HP_POTION_01', 'ITEM_ETC_MP_POTION_01', 'ITEM_ETC_SCROLL_RETURN_01'] }],
    provenance: 'authored',
  },
]

/** Placed relative to the mock world's spawn (0, 0). */
export const BUILTIN_NPCS: NpcDef[] = [
  { code: 'NPC_CH_POTION', name: 'Potion Merchant', x: 4, z: 3, yaw: -2.2, world: 'jangan', shop: 'STORE_CH_POTION', model: null, provenance: 'authored' },
]

/** EXP per level when levels.json is missing (authored curve; the export is authoritative). */
export function builtinLevels(cap = 120): LevelDef[] {
  const out: LevelDef[] = []
  for (let level = 1; level <= cap; level++) out.push({ level, exp: Math.round(118 * level * level * (1 + Math.max(0, level - 5) * 0.08)), masterySp: Math.ceil(level / 2) })
  return out
}

export const BASE_STATS = { str: CHARACTER_RULES.baseStr, int: CHARACTER_RULES.baseInt }
