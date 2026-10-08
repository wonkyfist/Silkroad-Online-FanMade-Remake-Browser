/**
 * The winter gameplay layer (docs/WINTER.md §13): body warmth, snowball fights, the winter monsters (snow spirits and the
 * Ice Yeti) and holiday gift boxes. Everything here runs only while the snow season is on (or a GM previews it).
 *
 * This file holds what the server and the client share: the one table of default numbers (WINTER_PLAY; the admin panel's
 * "Winter gameplay" settings override some of them), the pure rules (warmth levels and rates, the snowball flight, the
 * yeti's frost cone), the authored winter content (derived from retail monsters and items the export already has, so no
 * retail data is committed: a snow spirit is a recoloured Water Ghost, the yeti a giant white Big-Eyed Ghost) and the wire
 * types.
 * Environment-neutral: no node:*, no DOM.
 */
import type { DropTable, ItemDef, ItemStack, MobDef, NestDef, Range, ShopDef } from './content.ts'
import { validTimeZone } from './pilot.ts'
import type { Vec3 } from './protocol.ts'
import { localMonthDay, parseMonthDay, type SeasonDates } from './winter.ts'

// ---- the table ----------------------------------------------------------------------------------------------------

/** Every number of the winter gameplay (defaults; `ServerConfig` winter-play knobs override the ones the panel shows). */
export const WINTER_PLAY = {
  /** The whole layer (WINTER_PLAY, on by default; it still needs the season or a GM preview). */
  enabled: true,
  warmth: {
    max: 100,
    /** Outdoors in the season, by day, without snowfall: points lost per minute (100 → 0 in about 17 min). */
    lossPerMin: 6,
    /** At full night the loss is this many times faster (scaled by the night 0..1). */
    nightMul: 1.5,
    /** Falling snow: up to this many times faster (scaled by the snowfall rate). */
    snowMul: 1.5,
    /** A blizzard (snow with a storm level from BLIZZARD_STORM): this many times faster (replaces snowMul). */
    blizzardMul: 2.5,
    /** Inside a town's safe area: points gained per second (no loss, no penalty ever). */
    townGainPerS: 3,
    /** Levels: chilly below this, cold below `cold`, freezing at 0. */
    chilly: 50,
    cold: 25,
    /** HP/MP regeneration multiplier per level (freezing: none, so the drain below is felt; potions still work). */
    regenMul: { warm: 1, chilly: 0.75, cold: 0.5, freezing: 0 },
    /** Run speed lost per level (percent). */
    slowPct: { warm: 0, chilly: 0, cold: 8, freezing: 12 },
    /** Freezing: lose this percent of max HP every drainEveryMs, never below drainFloorPct of max HP (cold never kills). */
    drainPct: 1,
    drainEveryMs: 5000,
    drainFloorPct: 10,
    /** The `warmth` message: on a level or source change, a step of this many points, else every sendEveryMs while it moves. */
    sendStep: 5,
    sendEveryMs: 10_000,
  },
  /** Ginger Tea (NPC_CH_POTION's winter tab): warmth at once, then a glow that halves the loss for a while. */
  tea: { warmth: 40, glowMs: 180_000, glowLossMul: 0.5, price: 60, cooldownMs: 10_000 },
  snowball: {
    /** Snow cover needed to scoop a snowball (0..1, before the admin strength). */
    cover: 0.35,
    rangeM: 20,
    cooldownMs: 1200,
    /** Flight speed (m/s) along the ground; the flight time is dist / speed + 0.15 s. */
    speedMs: 14,
    /** A target that moved farther than this from where it stood at the throw dodged it. */
    dodgeM: 2.5,
    /** A ground throw splats on anyone within this of the landing point. */
    hitRadiusM: 1.2,
    /** A hit player runs slower by this for slowMs (never damage). */
    slowPct: 30,
    slowMs: 1500,
    /** A hit monster takes this much damage (and turns on the thrower); 0 = an aggro pull only. */
    mobDamage: 1,
    /** Rows of the winter scoreboard. */
    boardSize: 10,
  },
  spirits: {
    /** Snow spirits per field x this (0 = none). */
    countScale: 1,
    respawnSec: [45, 90] as Range,
    /** After the season, idle spirits leave a few per pass (every 5 s). */
    despawnPerPass: 4,
  },
  yeti: {
    firstSpawnMin: [10, 30] as Range,
    /** Respawn after a kill, minutes (rolled ± respawnSpread). */
    respawnMin: 120,
    respawnSpread: 0.25,
    /** × the spec's 30,000 HP (the Climb: 2.6 = 78,000 at level 25 against the cap tier, docs/CLIMB.md D53; YETI_HP_MUL). */
    hpMul: 2.6,
    corpseSec: 8,
    /** A kit move is considered this often during a fight (ms). */
    kitEveryMs: 2500,
    roarRadiusM: 120,
    enrageHpPct: 30,
    enrageDamageMul: 1.3,
    /** Snow spirits she calls with her first roar below half HP. */
    adds: 2,
  },
  gifts: {
    /** Chance (percent) that a monster killed in the season drops a gift box. */
    dropPct: 3,
    /** Gift boxes the Ice Yeti drops. */
    yetiCount: 4,
    /** Rewards per box (common and good tier). */
    rolls: 2,
    /** Chance (percent) of one extra rare reward per box. */
    rarePct: 4,
  },
} as const

/** The storm level (StormEnv.storm) from which snowfall counts as a blizzard for the warmth. */
export const BLIZZARD_STORM = 0.5

// ---- warmth -------------------------------------------------------------------------------------------------------

export const WARMTH_LEVELS = ['warm', 'chilly', 'cold', 'freezing'] as const
export type WarmthLevel = (typeof WARMTH_LEVELS)[number]

/** Why the warmth rises now: a fire nearby, a town, or the glow of a warm drink (only slows the loss). */
export const WARMTH_SOURCES = ['fire', 'town', 'tea'] as const
export type WarmthSource = (typeof WARMTH_SOURCES)[number]

export interface WarmthTuning {
  chilly: number
  cold: number
}

export function warmthLevel(value: number, t: WarmthTuning = WINTER_PLAY.warmth): WarmthLevel {
  if (!(value > 0)) return 'freezing'
  if (value < t.cold) return 'cold'
  if (value < t.chilly) return 'chilly'
  return 'warm'
}

/** What the cold reads of the weather and the clock. */
export interface ColdEnv {
  /** Night 0..1 (1 = full night). */
  night: number
  /** Snowfall 0..1. */
  snow: number
  /** Storm level 0..1 (StormEnv.storm). */
  storm: number
}

export interface LossTuning {
  lossPerMin: number
  nightMul: number
  snowMul: number
  blizzardMul: number
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0)

/** Whether the weather is a blizzard for the warmth: snow falling in a storm. */
export function coldBlizzard(env: ColdEnv): boolean {
  return env.snow > 0.02 && env.storm >= BLIZZARD_STORM
}

/** Warmth lost per second outdoors (> 0): the base loss, faster at night and in snow, much faster in a blizzard. */
export function warmthLossPerS(env: ColdEnv, t: LossTuning = WINTER_PLAY.warmth): number {
  const night = 1 + clamp01(env.night) * (t.nightMul - 1)
  const sky = coldBlizzard(env) ? t.blizzardMul : 1 + clamp01(env.snow) * (t.snowMul - 1)
  return (Math.max(0, t.lossPerMin) / 60) * night * sky
}

/** The fires that warm (radius and gain per second); campfires are the winter's own, braziers and lamps the world's. */
export const FIRE_KINDS = {
  campfire: { radiusM: 8, gainPerS: 6 },
  brazier: { radiusM: 6, gainPerS: 5 },
  lamp: { radiusM: 3.5, gainPerS: 2 },
} as const
export type FireKind = keyof typeof FIRE_KINDS

/**
 * World placements that are fires (the manifest `source` path, Data.pk2 backslashes): Jangan's gate fires and braziers
 * (`cj_enter_fire`, `cj_brazier_etc01`), the Dunhuang ruins' fire towers, and the lamps and shop lights (weaker).
 */
export const FIRE_SOURCES: readonly { kind: FireKind; match: RegExp }[] = [
  { kind: 'brazier', match: /brazier|_fire\d*\.bsr$|firetower/i },
  { kind: 'lamp', match: /cj_field_lamp|cj_lamp\d+|cj_pal_lamp|_light\d*(_n)?\.bsr$/i },
]

/** The fire kind of a placement source path, or null. */
export function fireKindOf(source: string): FireKind | null {
  for (const f of FIRE_SOURCES) if (f.match.test(source)) return f.kind
  return null
}

/** One fire on the map (glTF metres). */
export interface FireSpot {
  kind: FireKind
  x: number
  y: number
  z: number
}

// ---- snowballs ----------------------------------------------------------------------------------------------------

/** Flight time of a snowball thrown `distM` far (ms). */
export function snowballFlightMs(distM: number, speedMs: number = WINTER_PLAY.snowball.speedMs): number {
  return Math.round(150 + (Math.max(0, distM) / Math.max(1, speedMs)) * 1000)
}

/** The arc's apex above the straight line (m): a lob for long throws, a flat toss for short ones. */
export function snowballPeakM(distM: number): number {
  return Math.min(6, 0.6 + Math.max(0, distM) * 0.12)
}

/** A point of the arc at f 0..1 (a parabola over the straight line from `from` to `to`). */
export function snowballArc(from: Vec3, to: Vec3, peakM: number, f: number): Vec3 {
  const k = clamp01(f)
  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k + 4 * peakM * k * (1 - k), from[2] + (to[2] - from[2]) * k]
}

// ---- the Ice Yeti's kit -------------------------------------------------------------------------------------------

export const YETI_SKILLS = ['slam', 'breath', 'barrage', 'roar'] as const
export type YetiSkill = (typeof YETI_SKILLS)[number]

/**
 * Her moves besides the basic swings. `castMs` is the telegraph (she stands still, the ground shows where it lands);
 * `pct` is the share of her attack per hit; `chill` takes warmth; `slowPct`/`slowMs` slow a player hit.
 */
export const YETI_KIT = {
  slam: { castMs: 1100, radiusM: 6, pct: 160, cooldownMs: 12_000, slowPct: 40, slowMs: 3000, chill: 0 },
  breath: { castMs: 900, radiusM: 10, angleDeg: 70, pct: 120, cooldownMs: 15_000, slowPct: 30, slowMs: 4000, chill: 25 },
  barrage: { castMs: 700, radiusM: 22, count: 5, pct: 45, cooldownMs: 18_000, hitRadiusM: 1.6, slowPct: 20, slowMs: 1500, chill: 5 },
  roar: { castMs: 600, radiusM: 16, pct: 0, cooldownMs: 25_000, slowPct: 25, slowMs: 2500, chill: 20 },
} as const

/** Whether (x, z) lies in the cone from `o` facing `yaw` (yawTowards convention) of `radiusM` and full angle `angleDeg`. */
export function inCone(o: { x: number; z: number }, yaw: number, p: { x: number; z: number }, radiusM: number, angleDeg: number): boolean {
  const dx = p.x - o.x
  const dz = p.z - o.z
  const d = Math.hypot(dx, dz)
  if (d > radiusM) return false
  if (d < 0.5) return true
  const dot = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / d
  return dot >= Math.cos(((angleDeg / 2) * Math.PI) / 180)
}

// ---- content ------------------------------------------------------------------------------------------------------

export const WINTER_CODES = {
  sprite: 'MOB_WINTER_SNOW_SPRITE',
  spirit: 'MOB_WINTER_SNOW_SPIRIT',
  yeti: 'MOB_WINTER_ICE_YETI',
  tea: 'ITEM_WINTER_GINGER_TEA',
  gift: 'ITEM_WINTER_GIFT_BOX',
  shop: 'STORE_CH_POTION',
} as const

/** Whether a mob code is one of the winter monsters (the client draws them in ice). */
export function isWinterMob(code: string): boolean {
  return code === WINTER_CODES.sprite || code === WINTER_CODES.spirit || code === WINTER_CODES.yeti
}

/** The world these spawns, lairs and campfires belong to. */
export const WINTER_WORLD = 'jangan'

/** A winter monster: the retail monster it is made from and what it changes. */
export interface WinterMobSpec {
  code: string
  base: string
  name: string
  rarity: MobDef['rarity']
  level: number
  hp: number
  physAttack: Range
  physDefence: number
  magDefence: number
  hitRate: number
  parryRate: number
  /** Percent (100 = the base model's size). */
  scale: number
  radius: number
  walkSpeed: number
  runSpeed: number
  attackRange: number
  attackIntervalMs: number
  aggressive: boolean
  exp: number
}

export const WINTER_MOBS: readonly WinterMobSpec[] = [
  // a Water Ghost Slave frozen to ice: the soft one near the southern fields
  { code: WINTER_CODES.sprite, base: 'MOB_CH_WATERGHOST_CLON', name: 'Snow Sprite', rarity: 'normal', level: 5, hp: 140, physAttack: [30, 36], physDefence: 10, magDefence: 18, hitRate: 33, parryRate: 33, scale: 115, radius: 0.6, walkSpeed: 1.4, runSpeed: 5.5, attackRange: 0.6, attackIntervalMs: 1600, aggressive: false, exp: 110 },
  // a Water Ghost turned to ice and drifting snow: it comes for you
  { code: WINTER_CODES.spirit, base: 'MOB_CH_WATERGHOST', name: 'Snow Spirit', rarity: 'normal', level: 9, hp: 230, physAttack: [58, 66], physDefence: 18, magDefence: 34, hitRate: 42, parryRate: 42, scale: 110, radius: 0.6, walkSpeed: 1.5, runSpeed: 5.5, attackRange: 1.6, attackIntervalMs: 2000, aggressive: true, exp: 220 },
  // a Big-Eyed Ghost (the hulking ape) grown huge under white fur: the world boss of the snowy mountains. The Climb
  // (docs/CLIMB.md §2.6, D44): level 25 (was 20), attack × 1.15 and defences, hit and parry by the standard curve's 20 → 25
  // shift; her HP is 30,000 × YETI_HP_MUL (2.6 = 78,000; attack 189-240: CLIMB D53, degree 4 at the cap); the EXP pool 90,000 (≈ 10 % of the level-24 bar each in a 4-party)
  { code: WINTER_CODES.yeti, base: 'MOB_CH_BIGEYEGHOST', name: 'Ice Yeti', rarity: 'unique', level: 25, hp: 30_000, physAttack: [189, 240], physDefence: 70, magDefence: 101, hitRate: 75, parryRate: 50, scale: 330, radius: 2.6, walkSpeed: 1.6, runSpeed: 6.5, attackRange: 2.5, attackIntervalMs: 2800, aggressive: true, exp: 90_000 },
]

/** The MobDef of a winter monster: the base's model and skills (when the export has it) with the spec's numbers. */
export function deriveWinterMob(spec: WinterMobSpec, base: MobDef | undefined): MobDef {
  const def: MobDef = {
    code: spec.code,
    id: 0,
    name: spec.name,
    typeId: base?.typeId ?? [1, 2, 1, 1],
    rarity: spec.rarity,
    level: spec.level,
    hp: spec.hp,
    mp: 0,
    physAttack: [...spec.physAttack],
    magAttack: [0, 0],
    physDefence: spec.physDefence,
    magDefence: spec.magDefence,
    physAbsorb: base?.physAbsorb ?? 5,
    magAbsorb: base?.magAbsorb ?? 5,
    hitRate: spec.hitRate,
    parryRate: spec.parryRate,
    blockRate: 0,
    critRate: 2,
    attackRange: spec.attackRange,
    attackIntervalMs: spec.attackIntervalMs,
    radius: spec.radius,
    walkSpeed: spec.walkSpeed,
    runSpeed: spec.runSpeed,
    aggressive: spec.aggressive,
    exp: spec.exp,
    scale: spec.scale,
    model: base?.model ? { ...base.model } : null,
    fieldSources: { model: `winter: ${spec.base}`, stats: 'authored (docs/WINTER.md §13)' },
  }
  if (base?.skills) def.skills = [...base.skills]
  return def
}

/** Ginger Tea and the Holiday Gift Box (no retail rows: the client draws their icons). */
export function winterItems(): ItemDef[] {
  const tea = WINTER_PLAY.tea
  return [
    {
      code: WINTER_CODES.tea,
      id: 0,
      name: 'Ginger Tea',
      typeId: [3, 3, 1, 1],
      category: 'potion',
      degree: 0,
      reqLevel: 0,
      reqGender: 'any',
      race: 'any',
      maxStack: 50,
      price: tea.price,
      sellPrice: Math.round(tea.price / 4),
      use: { warmth: tea.warmth, warmthGlowMs: tea.glowMs, cooldownGroup: 'warmth', cooldownMs: tea.cooldownMs },
      model: null,
      icon: null,
      fieldSources: { all: 'authored (docs/WINTER.md §13)' },
    },
    {
      code: WINTER_CODES.gift,
      id: 0,
      name: 'Holiday Gift Box',
      typeId: [3, 3, 3, 1],
      category: 'etc',
      degree: 0,
      reqLevel: 0,
      reqGender: 'any',
      race: 'any',
      maxStack: 50,
      price: 0,
      sellPrice: 10,
      use: { gift: true, cooldownGroup: 'gift', cooldownMs: 400 },
      model: null,
      icon: null,
      fieldSources: { all: 'authored (docs/WINTER.md §13)' },
    },
  ]
}

/** The snow spirits' fields (glTF metres on jangan-fields): season-only nests, ids from WINTER_NEST_BASE. */
export const WINTER_NEST_BASE = 9_100_000

export interface WinterFieldSpec {
  mob: string
  x: number
  y: number
  z: number
  count: number
}

export const WINTER_FIELDS: readonly WinterFieldSpec[] = [
  // south of Jangan, among the Big-Eyed Ghosts
  { mob: WINTER_CODES.sprite, x: 168, y: 1, z: 437, count: 5 },
  { mob: WINTER_CODES.sprite, x: 387, y: 0, z: 198, count: 5 },
  { mob: WINTER_CODES.sprite, x: -76, y: 8, z: 504, count: 5 },
  { mob: WINTER_CODES.sprite, x: 49, y: 1, z: 386, count: 4 },
  // the north-west water meadows, where the Water Ghosts drift
  { mob: WINTER_CODES.spirit, x: -295, y: 6, z: -472, count: 5 },
  { mob: WINTER_CODES.spirit, x: -96, y: 6, z: -570, count: 5 },
  { mob: WINTER_CODES.spirit, x: -273, y: 5, z: -690, count: 5 },
]

/** A winter field as a NestDef (the AI's home, roam and tactics; never in the Spawner's list). */
export function winterNest(f: WinterFieldSpec, i: number, mob: MobDef): NestDef {
  return {
    id: WINTER_NEST_BASE + i + 1,
    mob: f.mob,
    x: f.x,
    z: f.z,
    y: f.y,
    radius: 30,
    spawnRadius: 25,
    count: f.count,
    respawnSec: [...WINTER_PLAY.spirits.respawnSec],
    tactics: { id: 0, aggressive: mob.aggressive, sightRange: 12, leashRange: 45 },
    world: WINTER_WORLD,
    provenance: 'authored',
    source: { file: 'winter-play.ts WINTER_FIELDS', zone: 'winter', x: f.x, z: f.z, y: f.y },
    level: mob.level,
  }
}

/** The Ice Yeti's lairs in the snowy north-western mountains (the Yeoha hills); one is rolled per spawn. */
export const YETI_LAIRS: readonly { x: number; y: number; z: number }[] = [
  { x: -899, y: 82, z: -233 },
  { x: -907, y: 84, z: 82 },
  { x: -824, y: 71, z: -125 },
]

/** The lair as a NestDef (her home, leash and roam). */
export function yetiNest(i: number, mob: MobDef): NestDef {
  const l = YETI_LAIRS[i % YETI_LAIRS.length]!
  return {
    id: WINTER_NEST_BASE + 900 + i,
    mob: mob.code,
    x: l.x,
    z: l.z,
    y: l.y,
    radius: 20,
    spawnRadius: 8,
    count: 1,
    respawnSec: [0, 0],
    tactics: { id: 0, aggressive: true, sightRange: 16, leashRange: 50 },
    world: WINTER_WORLD,
    provenance: 'authored',
    source: { file: 'winter-play.ts YETI_LAIRS', zone: 'winter', x: l.x, z: l.z, y: l.y },
    level: mob.level,
  }
}

/** The winter's own campfires (season-only, drawn by the client): by the spirit fields, the lairs and the roads. */
export const WINTER_CAMPFIRES: readonly { x: number; y: number; z: number }[] = [
  { x: 150, y: 1, z: 412 },
  { x: 372, y: 0, z: 214 },
  { x: -60, y: 8, z: 480 },
  { x: -280, y: 6, z: -452 },
  { x: -110, y: 6, z: -548 },
  { x: -870, y: 80, z: -205 },
  { x: -880, y: 82, z: 60 },
  { x: 98, y: -3, z: 40 },
]

/** The winter tab of the potion shop (shown and sold only in the season). */
export const WINTER_SHOP_TAB = { name: 'Winter', items: [WINTER_CODES.tea] as string[] }

/** Whether `shop` carries the winter tab now. */
export function hasWinterTab(shop: ShopDef): boolean {
  return shop.tabs.some((t) => t.name === WINTER_SHOP_TAB.name && t.items.includes(WINTER_CODES.tea))
}

/** Adds (on) or removes (off) the winter tab of the potion shop in a shop table; returns whether it changed. */
export function setWinterShopTab(shops: Map<string, ShopDef>, on: boolean): boolean {
  const shop = shops.get(WINTER_CODES.shop)
  if (!shop || hasWinterTab(shop) === on) return false
  shop.tabs = on ? [...shop.tabs, { name: WINTER_SHOP_TAB.name, items: [...WINTER_SHOP_TAB.items] }] : shop.tabs.filter((t) => !(t.name === WINTER_SHOP_TAB.name && t.items.includes(WINTER_CODES.tea)))
  return true
}

/** The snow spirits' drops: their base ghost's table (gold, potions), when the export has one. */
export function winterDrops(drops: ReadonlyMap<string, DropTable>): DropTable[] {
  const out: DropTable[] = []
  for (const s of WINTER_MOBS) {
    if (s.rarity === 'unique') continue
    const base = drops.get(s.base)
    if (base) out.push({ ...base, mob: s.code, provenance: 'authored' })
  }
  return out
}

/**
 * Installs the winter content into content tables (server GameData, client ContentTables): the derived monsters, the
 * two items and the spirits' drops. Existing rows are never replaced. Returns what was added.
 */
export function installWinterContent(t: { mobs: Map<string, MobDef>; items: Map<string, ItemDef>; drops: Map<string, DropTable> }): { mobs: number; items: number; drops: number } {
  const n = { mobs: 0, items: 0, drops: 0 }
  for (const s of WINTER_MOBS) {
    if (t.mobs.has(s.code)) continue
    t.mobs.set(s.code, deriveWinterMob(s, t.mobs.get(s.base)))
    n.mobs++
  }
  for (const it of winterItems()) {
    if (t.items.has(it.code)) continue
    t.items.set(it.code, it)
    n.items++
  }
  for (const d of winterDrops(t.drops)) {
    if (t.drops.has(d.mob)) continue
    t.drops.set(d.mob, d)
    n.drops++
  }
  return n
}

// ---- gift boxes ---------------------------------------------------------------------------------------------------

export type GiftTier = 'common' | 'good' | 'rare'

export interface GiftEntry {
  tier: GiftTier
  weight: number
  /** An item and its count, or a gold amount. */
  item?: string
  count?: Range
  gold?: Range
}

/** What a box can hold (weights within a tier; the rare tier is its own roll, GIFT rarePct). */
export const GIFT_TABLE: readonly GiftEntry[] = [
  { tier: 'common', weight: 18, item: 'ITEM_ETC_HP_POTION_02', count: [3, 6] },
  { tier: 'common', weight: 18, item: 'ITEM_ETC_MP_POTION_02', count: [3, 6] },
  { tier: 'common', weight: 10, item: 'ITEM_ETC_ALL_POTION_01', count: [2, 4] },
  { tier: 'common', weight: 12, item: WINTER_CODES.tea, count: [2, 4] },
  { tier: 'common', weight: 20, gold: [300, 1500] },
  { tier: 'good', weight: 8, item: 'ITEM_ETC_HP_POTION_03', count: [3, 5] },
  { tier: 'good', weight: 6, item: 'ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01', count: [1, 2] },
  { tier: 'good', weight: 4, item: 'ITEM_ETC_SCROLL_RETURN_01', count: [1, 1] },
  { tier: 'good', weight: 4, gold: [2000, 6000] },
  { tier: 'rare', weight: 3, item: 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', count: [1, 1] },
  { tier: 'rare', weight: 3, item: 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ARMOR_A', count: [1, 1] },
  { tier: 'rare', weight: 2, item: 'ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03', count: [1, 2] },
  { tier: 'rare', weight: 2, gold: [20_000, 50_000] },
]

/** A gift item the server does not know becomes gold instead (so a box is never empty). */
export const GIFT_FALLBACK_GOLD: Range = [200, 800]

export interface GiftRoll {
  items: { code: string; count: number }[]
  gold: number
  rare: boolean
}

function pick(list: readonly GiftEntry[], rng: () => number): GiftEntry | undefined {
  const total = list.reduce((s, e) => s + Math.max(0, e.weight), 0)
  if (total <= 0) return undefined
  let r = rng() * total
  return list.find((e) => (r -= Math.max(0, e.weight)) < 0) ?? list[list.length - 1]
}

const within = (r: Range, rng: () => number) => Math.round(r[0] + rng() * (r[1] - r[0]))

/**
 * Opens one box: `rolls` rewards from the common and good tiers by weight, plus one rare reward with `rarePct` percent.
 * Items of one code merge; unknown items become GIFT_FALLBACK_GOLD.
 */
export function rollGift(rng: () => number, known: (code: string) => boolean, o: { rolls?: number; rarePct?: number; table?: readonly GiftEntry[] } = {}): GiftRoll {
  const table = o.table ?? GIFT_TABLE
  const out: GiftRoll = { items: [], gold: 0, rare: false }
  const add = (e: GiftEntry | undefined) => {
    if (!e) return
    if (e.gold) out.gold += within(e.gold, rng)
    else if (e.item && known(e.item)) {
      const count = Math.max(1, within(e.count ?? [1, 1], rng))
      const have = out.items.find((x) => x.code === e.item)
      if (have) have.count += count
      else out.items.push({ code: e.item, count })
    } else out.gold += within(GIFT_FALLBACK_GOLD, rng)
  }
  const plain = table.filter((e) => e.tier !== 'rare')
  for (let i = 0; i < Math.max(1, Math.round(o.rolls ?? WINTER_PLAY.gifts.rolls)); i++) add(pick(plain, rng))
  if (rng() * 100 < (o.rarePct ?? WINTER_PLAY.gifts.rarePct)) {
    out.rare = true
    add(pick(table.filter((e) => e.tier === 'rare'), rng))
  }
  return out
}

// ---- the season label -----------------------------------------------------------------------------------------------

const years = new Map<string, Intl.DateTimeFormat>()

/** The winter a time belongs to, named by its years ("2026-27"): the scoreboard's season. */
export function winterSeasonKey(ms: number, d: SeasonDates): string {
  const tz = validTimeZone(d.timeZone) ? d.timeZone : 'UTC'
  let f = years.get(tz)
  if (!f) years.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' })))
  const y = Number(f.formatToParts(new Date(ms)).find((p) => p.type === 'year')?.value ?? new Date(ms).getUTCFullYear())
  const s = parseMonthDay(d.start) ?? 1201
  const e = parseMonthDay(d.end) ?? 115
  const md = localMonthDay(ms, tz)
  // a season wrapping the new year starts in the year before for the days up to its end
  const first = s > e && md <= e ? y - 1 : y
  return s > e ? `${first}-${String((first + 1) % 100).padStart(2, '0')}` : String(first)
}

// ---- the wire -------------------------------------------------------------------------------------------------------

/** The own warmth (`warmth` message). The client carries `value` forward at `rate` per second from server ms `at`. */
export interface WarmthState {
  /** 0..max. */
  value: number
  max: number
  /** Points per second now (negative = cooling). */
  rate: number
  level: WarmthLevel
  at: number
  /** Why it rises (or falls slower). */
  source?: WarmthSource
  /** Inside a town's safe area: no loss and never a penalty. */
  safe?: true
  /** HP the cold just took (freezing). */
  drained?: number
}

/** The layer's state for one player (`winterPlay`): on or off, snowballs possible, the campfires to draw. */
export interface WinterPlayState {
  on: boolean
  /** The snow is deep enough to scoop snowballs. */
  snowballs: boolean
  /** The winter's campfires (glTF metres) while on. */
  fires?: Vec3[]
  /** The scoreboard's season label ("2026-27"). */
  season?: string
}

export interface WinterBoardRow {
  name: string
  hits: number
}

export interface WinterBoard {
  season: string
  top: WinterBoardRow[]
  me: { hits: number; thrown: number; hitBy: number; rank?: number }
}

export type WinterClientMessage =
  /** Throw a snowball at entity `target`, or at the ground point x/z (exactly one of the two). One actionResult. */
  | { t: 'snowball'; target?: number; x?: number; z?: number }
  /** Ask for the winter scoreboard (answered with `winterBoard`). One actionResult. */
  | { t: 'winterBoard' }

export type WinterServerMessage =
  | { t: 'warmth'; warmth: WarmthState }
  | { t: 'winterPlay'; play: WinterPlayState }
  /**
   * A snowball in flight: thrown by entity `from` (a player, or the Ice Yeti's barrage with `big`) at server ms `at` from
   * `fromPos`, landing at `to` after `ms` with its apex `peakM` above the line; `target` = the entity it was thrown at.
   */
  | { t: 'snowball'; id: number; from: number; fromPos: Vec3; to: Vec3; at: number; ms: number; peakM: number; target?: number; big?: true }
  /**
   * It landed at `pos`: `hit` = the entity it splatted (a player is slowed `slowMs`, never hurt), absent = the ground.
   * `score` (the thrower's own copy only): the thrower's hits this season.
   */
  | { t: 'snowballSplat'; id: number; pos: Vec3; hit?: number; slowMs?: number; score?: number }
  | { t: 'winterBoard'; board: WinterBoard }
  /** A gift box opened: what was inside (`rare` = the rare reward came out). */
  | { t: 'giftOpened'; item: string; rewards: ItemStack[]; gold?: number; rare?: boolean }
  /**
   * The Ice Yeti (entity `id`) winds up `skill`: it lands at server ms `at` (after `castMs`) around `pos` within
   * `radiusM`; `yaw` faces the breath (a cone of `angleDeg`).
   */
  | { t: 'yetiSkill'; id: number; skill: YetiSkill; at: number; castMs: number; pos: Vec3; yaw: number; radiusM: number; angleDeg?: number }

/** Wire bounds (validate.ts). */
export const WINTER_PLAY_LIMITS = {
  warmth: 1000,
  rate: 1000,
  flightMs: 10_000,
  peakM: 50,
  board: 20,
  rewards: 8,
  castMs: 10_000,
  radiusM: 200,
  fires: 64,
} as const
