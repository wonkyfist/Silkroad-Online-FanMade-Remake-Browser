/**
 * Synthetic content fixtures in the exporter's format (packages/shared/src/content.ts). The numbers are made up
 * for fast, deterministic tests (e.g. a 20-HP Mangnyang); they are NOT retail values. Codes follow the client's
 * CodeName128 style so the same code paths run as with the real export.
 */
import {
  CONTENT_SCHEMA_VERSION,
  PROVENANCE_PORT,
  type ContentKind,
  type DropTable,
  type ItemDef,
  type LevelDef,
  type MobDef,
  type NestDef,
  type NpcDef,
  type ShopDef,
} from '@sro/shared'

export function wrap<T>(kind: ContentKind, entries: T[]): string {
  return JSON.stringify({ schema: CONTENT_SCHEMA_VERSION, kind, generatedAt: '2026-01-01T00:00:00Z', sources: ['test fixture'], entries })
}

export function mob(code: string, over: Partial<MobDef> = {}): MobDef {
  return {
    code,
    id: 1,
    name: code.replace(/^MOB_CH_/, '').toLowerCase(),
    typeId: [1, 2, 1, 1],
    rarity: 'normal',
    level: 1,
    hp: 20,
    mp: 0,
    physAttack: [4, 6],
    magAttack: [0, 0],
    physDefence: 2,
    magDefence: 2,
    hitRate: 20,
    parryRate: 10,
    attackRange: 1,
    attackIntervalMs: 2000,
    radius: 0.6,
    walkSpeed: 1.5,
    runSpeed: 4,
    aggressive: false,
    exp: 40,
    spExp: 30,
    scale: 100,
    model: null,
    ...over,
  }
}

export const MANGNYANG = mob('MOB_CH_MANGNYANG', { name: 'Mangnyang' })
/** A strong aggressive mob that kills a level-1 character in one hit and never goes down. */
export const TIGER = mob('MOB_CH_TIGER', {
  name: 'Tiger',
  level: 20,
  hp: 100_000,
  physAttack: [5000, 5000],
  physDefence: 1000,
  hitRate: 100_000,
  attackRange: 2,
  attackIntervalMs: 300,
  radius: 1,
  runSpeed: 12,
  aggressive: true,
  exp: 1000,
})
export const HIGH = mob('MOB_CH_DRAGON', { name: 'Dragon', level: 90 })

export function nest(id: number, mobCode: string, x: number, z: number, over: Partial<NestDef> = {}): NestDef {
  return {
    id,
    mob: mobCode,
    x,
    z,
    radius: 3,
    spawnRadius: 2,
    count: 1,
    respawnSec: [1, 1],
    championPct: 0,
    tactics: { id: 1, aggressive: false, sightRange: 10, leashRange: 25 },
    world: 'jangan',
    provenance: PROVENANCE_PORT,
    source: { file: 'spawns.json', zone: 'jangan_province', x: 0, z: 0 },
    ...over,
  }
}

export function item(code: string, over: Partial<ItemDef> = {}): ItemDef {
  return {
    code,
    id: 100,
    name: code,
    typeId: [3, 3, 1, 1],
    category: 'etc',
    degree: 0,
    reqLevel: 0,
    reqGender: 'any',
    race: 'any',
    maxStack: 1,
    price: 10,
    sellPrice: 2,
    model: null,
    icon: null,
    ...over,
  }
}

const weapon = (code: string, weaponType: ItemDef['weaponType'], over: Partial<ItemDef> = {}) =>
  item(code, { category: 'weapon', slot: 'weapon', weaponType, degree: 1, reqLevel: 1, race: 'china', typeId: [3, 1, 6, 2], range: 1.5, stats: { physAttack: [10, 14] }, ...over })
const garment = (code: string, slot: ItemDef['slot'], gender: 'male' | 'female', over: Partial<ItemDef> = {}) =>
  item(code, { category: 'armor', slot, armorType: 'garment', degree: 1, reqLevel: 1, reqGender: gender, race: 'china', stats: { physDefence: [2, 2], magDefence: [1, 1] }, ...over })

export const ITEMS: ItemDef[] = [
  weapon('ITEM_CH_SWORD_01_A_DEF', 'sword'),
  weapon('ITEM_CH_BLADE_01_A_DEF', 'blade'),
  weapon('ITEM_CH_SPEAR_01_A_DEF', 'spear', { twoHanded: true, range: 3 }),
  weapon('ITEM_CH_TBLADE_01_A_DEF', 'glaive', { twoHanded: true, range: 3 }),
  weapon('ITEM_CH_BOW_01_A_DEF', 'bow', { twoHanded: true, range: 15 }),
  weapon('ITEM_CH_BLADE_02_A', 'blade', { id: 200, degree: 1, stats: { physAttack: [40, 44] }, price: 500, sellPrice: 100 }),
  weapon('ITEM_CH_BLADE_05_A', 'blade', { id: 201, degree: 2, reqLevel: 15 }),
  item('ITEM_CH_SHIELD_01_A', { category: 'shield', slot: 'shield', reqLevel: 1, race: 'china', stats: { blockRate: [10, 10], physDefence: [3, 3] } }),
  garment('ITEM_CH_M_CLOTHES_01_BA_A_DEF', 'chest', 'male'),
  garment('ITEM_CH_M_CLOTHES_01_LA_A_DEF', 'legs', 'male'),
  garment('ITEM_CH_M_CLOTHES_01_FA_A_DEF', 'feet', 'male'),
  garment('ITEM_CH_W_CLOTHES_01_BA_A_DEF', 'chest', 'female'),
  garment('ITEM_CH_W_CLOTHES_01_LA_A_DEF', 'legs', 'female'),
  garment('ITEM_CH_W_CLOTHES_01_FA_A_DEF', 'feet', 'female'),
  garment('ITEM_CH_W_CLOTHES_02_HA_A', 'head', 'female', { id: 300 }),
  item('ITEM_CH_RING_01_A', { category: 'accessory', slot: 'ring', reqLevel: 1, race: 'china' }),
  item('ITEM_ETC_HP_POTION_01', { category: 'potion', maxStack: 50, price: 20, sellPrice: 5, use: { hp: 100, cooldownGroup: 'hp', cooldownMs: 1000 } }),
  item('ITEM_ETC_QUEST_01', { category: 'quest', canDrop: false, canSell: false }),
  item('ITEM_ETC_GOLD_01', { category: 'gold', maxStack: 1 }),
]

export const LEVELS: LevelDef[] = [
  { level: 1, exp: 30, masterySp: 1 },
  { level: 2, exp: 100, masterySp: 1 },
  { level: 3, exp: 200, masterySp: 2 },
  { level: 4, exp: 400, masterySp: 2 },
  { level: 5, exp: 800, masterySp: 3 },
]

export const DROPS: DropTable[] = [
  {
    mob: MANGNYANG.code,
    gold: { chance: 1, amount: [10, 20] },
    groups: [{ chance: 1, entries: [{ item: 'ITEM_CH_BLADE_02_A', weight: 1 }, { item: 'ITEM_UNKNOWN_X', weight: 1000 }] }],
    provenance: PROVENANCE_PORT,
  },
]

export const NPCS: NpcDef[] = [
  { code: 'NPC_CH_POTION', name: 'Potion Merchant', x: 45, z: -45, yaw: 0, world: 'jangan', shop: 'STORE_CH_POTION', model: null, provenance: 'client' },
  { code: 'NPC_CH_ELSEWHERE', name: 'Elsewhere', x: 45, z: -45, yaw: 0, world: 'donwhang', model: null, provenance: 'client' },
]

export const SHOPS: ShopDef[] = [
  { id: 'STORE_CH_POTION', npcs: ['NPC_CH_POTION'], tabs: [{ name: 'Potions', items: ['ITEM_ETC_HP_POTION_01', 'ITEM_CH_BLADE_02_A'] }], provenance: 'client' },
]

/** Files for startTestServer({ files }) under out/data/. */
export function contentFiles(parts: {
  mobs?: MobDef[]
  nests?: NestDef[]
  items?: ItemDef[]
  levels?: LevelDef[]
  drops?: DropTable[]
  npcs?: NpcDef[]
  shops?: ShopDef[]
}): Record<string, string> {
  const out: Record<string, string> = {}
  if (parts.mobs) out['out/data/mobs.json'] = wrap('mobs', parts.mobs)
  if (parts.nests) out['out/data/nests.json'] = wrap('nests', parts.nests)
  if (parts.items) out['out/data/items.json'] = wrap('items', parts.items)
  if (parts.levels) out['out/data/levels.json'] = JSON.stringify(parts.levels)
  if (parts.drops) out['out/data/drops.json'] = wrap('drops', parts.drops)
  if (parts.npcs) out['out/data/npcs.json'] = wrap('npcs', parts.npcs)
  if (parts.shops) out['out/data/shops.json'] = wrap('shops', parts.shops)
  return out
}

/** Deterministic PRNG (mulberry32). */
export function seeded(seed = 1): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
