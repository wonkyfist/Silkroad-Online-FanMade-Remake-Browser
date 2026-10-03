/**
 * Gameplay rules of the mock server (?mock=1): character progress, derived stats, bag operations and loot
 * rolls. The formulas are authored stand-ins (the real ones are server code, research report section 4.5);
 * they only need to feel right and be deterministic under a seeded RNG. No DOM, no timers.
 */
import {
  CHARACTER_RULES,
  DEFAULT_LEVEL_CAP,
  GOLD_ITEM_CODES,
  type BagSlotUpdate,
  type DropTable,
  type EquipSlot,
  type Inventory,
  type ItemDef,
  type ItemStack,
  type PlayerStats,
  type StarterWeapon,
} from '@sro/shared'
import { STARTER_WEAPON_ITEMS } from '../content/builtin.ts'
import { expToNext, type ContentTables } from '../content/gameplay.ts'

export const LEVEL_CAP = DEFAULT_LEVEL_CAP

/** Deterministic PRNG (mulberry32): the mock plays out the same way for the same inputs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randInt(r: () => number, min: number, max: number): number {
  return Math.floor(min + r() * (max - min + 1))
}

/** Saved per character by the mock (localStorage). */
export interface Progress {
  level: number
  exp: number
  sp: number
  spExp: number
  str: number
  int: number
  statPoints: number
  hp: number
  mp: number
  dead: boolean
  inventory: Inventory
}

const VISIBLE: EquipSlot[] = ['weapon', 'shield', 'head', 'shoulders', 'chest', 'legs', 'hands', 'feet']

export function emptyInventory(): Inventory {
  return { bagSize: CHARACTER_RULES.bagSize, bag: Array.from({ length: CHARACTER_RULES.bagSize }, () => null), equip: {}, gold: 0 }
}

/** A new character: level 1 (or `level`), starter weapon equipped, potions, a few things to equip. */
export function starterProgress(weapon: StarterWeapon, female: boolean, level: number, tables: ContentTables): Progress {
  const inv = emptyInventory()
  inv.equip.weapon = { code: STARTER_WEAPON_ITEMS[weapon], count: 1 }
  inv.gold = 250
  const g = female ? 'W' : 'M'
  const other: StarterWeapon = weapon === 'sword' ? 'blade' : 'sword'
  const give: [string, number][] = [
    ['ITEM_ETC_HP_POTION_01', 20],
    ['ITEM_ETC_MP_POTION_01', 10],
    ['ITEM_ETC_SCROLL_RETURN_01', 3],
    [`ITEM_CH_${g}_CLOTHES_01_BA_A_DEF`, 1],
    [`ITEM_CH_${g}_CLOTHES_01_LA_A_DEF`, 1],
    [STARTER_WEAPON_ITEMS[other], 1],
    ['ITEM_CH_SHIELD_01_A_DEF', 1],
    ['ITEM_CH_RING_01_A_DEF', 1],
  ]
  give.forEach(([code, count], i) => {
    if (tables.items.has(code)) inv.bag[i] = { code, count }
  })
  const lv = Math.max(1, Math.min(LEVEL_CAP, level))
  const p: Progress = {
    level: lv,
    exp: 0,
    sp: 0,
    spExp: 0,
    str: CHARACTER_RULES.baseStr + lv - 1,
    int: CHARACTER_RULES.baseInt + lv - 1,
    statPoints: CHARACTER_RULES.statPointsPerLevel * (lv - 1),
    hp: 0,
    mp: 0,
    dead: false,
    inventory: inv,
  }
  const s = deriveStats(p, tables)
  p.hp = s.maxHp
  p.mp = s.maxMp
  return p
}

const avg = (r: [number, number] | undefined) => (r ? (r[0] + r[1]) / 2 : 0)

/** Full PlayerStats from progress + equipment (hp/mp clamped into the new maxima). */
export function deriveStats(p: Progress, tables: ContentTables): PlayerStats {
  const eq = p.inventory.equip
  let def = 0
  let mdef = 0
  let parry = 0
  let hit = 0
  for (const s of Object.values(eq)) {
    const d = s ? tables.items.get(s.code) : undefined
    if (!d?.stats || d.slot === 'weapon') continue
    def += avg(d.stats.physDefence)
    mdef += avg(d.stats.magDefence)
    parry += avg(d.stats.parryRate)
  }
  const w = eq.weapon ? tables.items.get(eq.weapon.code) : undefined
  const watk = w?.stats?.physAttack ?? [2, 4]
  const plus = eq.weapon?.plus ?? 0
  hit += avg(w?.stats?.hitRate)
  const f = 1.02 ** (p.level - 1)
  const maxHp = Math.round(f * p.str * 10)
  const maxMp = Math.round(f * p.int * 10)
  p.hp = Math.min(p.hp, maxHp)
  p.mp = Math.min(p.mp, maxMp)
  return {
    level: p.level,
    exp: p.exp,
    expToNext: expToNext(tables, p.level, LEVEL_CAP),
    sp: p.sp,
    spExp: p.spExp,
    hp: p.hp,
    maxHp,
    mp: p.mp,
    maxMp,
    str: p.str,
    int: p.int,
    statPoints: p.statPoints,
    gold: p.inventory.gold,
    physAttack: [Math.round(watk[0] * (1 + plus * 0.1) + p.str * 0.45), Math.round(watk[1] * (1 + plus * 0.1) + p.str * 0.6)],
    magAttack: [Math.round(p.int * 0.45), Math.round(p.int * 0.6)],
    physDefence: Math.round(p.str * 0.25 + def),
    magDefence: Math.round(p.int * 0.25 + mdef),
    hitRate: Math.round(p.level * 3 + 15 + hit),
    parryRate: Math.round(p.level * 2 + 8 + parry),
    // Wave 8 (docs/WAVE_PLAN2.md D33): the server always sends the Berserk points in a full `stats`.
    hwan: 0,
  }
}

/** Visible equipment codes (appearance / EntityState.equip). */
export function visibleEquip(inv: Inventory): Partial<Record<EquipSlot, string>> {
  const out: Partial<Record<EquipSlot, string>> = {}
  for (const s of VISIBLE) {
    const it = inv.equip[s]
    if (it) out[s] = it.code
  }
  return out
}

export function firstFree(inv: Inventory): number {
  for (let i = 0; i < inv.bagSize; i++) if (!inv.bag[i]) return i
  return -1
}

/**
 * Adds `count` of `code` to the bag, merging into stacks first, then free slots. All or nothing: returns the
 * changed slots, or null (bag untouched) when it does not fit.
 */
export function addToBag(inv: Inventory, def: ItemDef | undefined, code: string, count: number, plus?: number): BagSlotUpdate[] | null {
  const max = Math.max(1, def?.maxStack ?? 1)
  const bag = inv.bag.map(s => (s ? { ...s } : null))
  const touched = new Set<number>()
  let left = count
  if (max > 1) {
    for (let i = 0; i < inv.bagSize && left > 0; i++) {
      const s = bag[i]
      if (!s || s.code !== code || (s.plus ?? 0) !== (plus ?? 0) || s.count >= max) continue
      const n = Math.min(left, max - s.count)
      s.count += n
      left -= n
      touched.add(i)
    }
  }
  for (let i = 0; i < inv.bagSize && left > 0; i++) {
    if (bag[i]) continue
    const n = Math.min(left, max)
    const s: ItemStack = { code, count: n }
    if (plus) s.plus = plus
    bag[i] = s
    left -= n
    touched.add(i)
  }
  if (left > 0) return null
  inv.bag = bag
  return [...touched].sort((a, b) => a - b).map(slot => ({ slot, item: bag[slot] ? { ...bag[slot]! } : null }))
}

export function goldCode(amount: number): string {
  return amount < 100 ? GOLD_ITEM_CODES[0] : amount < 1000 ? GOLD_ITEM_CODES[1] : GOLD_ITEM_CODES[2]
}

export function isGold(code: string): boolean {
  return (GOLD_ITEM_CODES as readonly string[]).includes(code)
}

/** One kill's loot: gold (as a gold item code with the amount as count) and item groups. */
export function rollDrops(table: DropTable | undefined, r: () => number, tables: ContentTables, mul = 1): { code: string; count: number }[] {
  if (!table) return []
  const out: { code: string; count: number }[] = []
  if (table.gold && r() < table.gold.chance) {
    const amount = Math.max(1, Math.round(randInt(r, table.gold.amount[0], table.gold.amount[1]) * mul))
    out.push({ code: goldCode(amount), count: amount })
  }
  for (const g of table.groups) {
    if (r() >= g.chance) continue
    const entries = g.entries.filter(e => tables.items.has(e.item) && e.weight > 0)
    const total = entries.reduce((s, e) => s + e.weight, 0)
    let pick = r() * total
    for (const e of entries) {
      pick -= e.weight
      if (pick <= 0) {
        out.push({ code: e.item, count: e.count ? randInt(r, e.count[0], e.count[1]) : 1 })
        break
      }
    }
  }
  return out
}
