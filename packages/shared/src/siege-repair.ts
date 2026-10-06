/**
 * Siege of Jangan, layer 3: repair (docs/SIEGE.md §2.4, §2.5 looters, §7 items, §10.1). The pure rules and the authored
 * content the server and the client share.
 *
 * - **Master Mason Ko** (an authored NPC by the south gate, wearing the Blacksmith's model): a shop (the Mason's Kit, the
 *   Stone Block) and the `mason` service, where players donate gold or Stone Blocks to a segment or "where it is
 *   needed". 1 % = `goldPerPct` gold (2,000) or `blocksPerPct` Stone Blocks (2).
 * - **The builder queue**: a donation becomes queued work (ip) on segments (the "where it is needed" share goes to the
 *   worst segments first, `allocateDonation`); the builders apply at most `builderPctPerMin` (1 %) per minute to every
 *   segment at once until it is whole; work queued beyond a full repair waits for the next damage, the queue of one
 *   segment capped at `queueCapPct` (50 %). Never refunded.
 * - **The Mason's Kit**: used at the wall (within `kitRangeM`, either side), a `kitChannelS` (10 s) channel adds `kitPct`
 *   (1 %) and takes one kit; it repeats while the player has kits and the segment is damaged. Moving, acting, a warp,
 *   death or damage interrupts it. Allowed during a siege.
 * - **The Stone Block**: a donation material, from Stone Ghosts (8 %) and Ko's shop (1,200).
 * - **Looters**: outside a siege every open gap gets a small temporary nest of Bandits (`looterNest`).
 *
 * The content (`installSiegeContent`) is installed into the server's GameData by the repair module when the walls are
 * on, and into the client's content tables by the catalog, as the winter content is. Existing rows are never replaced.
 */
import type { DropTable, ItemDef, NestDef, NpcDef, ShopDef } from './content.ts'
import {
  WALL_DEFAULTS,
  type BreachZone,
  type WallRepairTerms,
  type WallSettings,
  type WallsExport,
  type WallsSegment,
  type WallsSideInfo,
} from './siege.ts'

// ---- content ---------------------------------------------------------------------------------------------------------

export const SIEGE_CODES = {
  /** Master Mason Ko (placeholder name, docs/SIEGE.md §16.2 q20). */
  mason: 'NPC_SIEGE_MASON_KO',
  /** The model he wears (the Blacksmith's). */
  masonBase: 'NPC_CH_SMITH',
  shop: 'STORE_SIEGE_MASON',
  kit: 'ITEM_SIEGE_MASON_KIT',
  block: 'ITEM_SIEGE_STONE_BLOCK',
  /** The looters at a gap. */
  looter: 'MOB_CH_BANDIT',
  /** Who drops Stone Blocks. */
  blockMob: 'MOB_CH_STONEGHOST',
} as const

/** The NPC dialog service of Master Mason Ko (protocol NpcService). */
export const MASON_SERVICE = 'mason'

/** Ko stands on the main street north of the south gate (east side, facing the road), 75 m inside the wall: outside every breach zone (50 m + inset), so looters at a gap never reach him (glTF m on jangan-fields). */
export const MASON_SPOT = { x: 128, z: -75, y: -3.26, yaw: Math.atan2(-1, 0) } as const

export const STONE_BLOCK_PRICE = 1200
/** Chance of a Stone Block per Stone Ghost kill (its own drop group). */
export const STONE_BLOCK_DROP = 0.08

/** Retail icons reused (the converted icon export, OUT/icons/...): a grey stone, and a tool bag. */
export const SIEGE_ICONS = {
  block: '/out/icons/item/etc/material_stone.png',
  kit: '/out/icons/item/etc/material_bag.png',
} as const

/** The Mason's Kit and the Stone Block (no retail rows: authored). */
export function siegeItems(kitPrice: number = WALL_DEFAULTS.kitPrice): ItemDef[] {
  const base = { id: 0, degree: 0, reqLevel: 0, reqGender: 'any', race: 'any', model: null, fieldSources: { all: 'authored (docs/SIEGE.md §7)' } } as const
  return [
    {
      ...base,
      code: SIEGE_CODES.kit,
      name: "Mason's Kit",
      typeId: [3, 3, 3, 1],
      category: 'etc',
      maxStack: 20,
      price: kitPrice,
      sellPrice: Math.floor(kitPrice / 4),
      use: { masonKit: true, cooldownGroup: 'masonKit', cooldownMs: 0 },
      icon: SIEGE_ICONS.kit,
    },
    {
      ...base,
      code: SIEGE_CODES.block,
      name: 'Stone Block',
      typeId: [3, 3, 3, 1],
      category: 'etc',
      maxStack: 50,
      price: STONE_BLOCK_PRICE,
      sellPrice: Math.floor(STONE_BLOCK_PRICE / 4),
      icon: SIEGE_ICONS.block,
    },
  ]
}

export function masonNpc(world: string): NpcDef {
  return {
    code: SIEGE_CODES.mason,
    name: 'Master Mason Ko',
    x: MASON_SPOT.x,
    z: MASON_SPOT.z,
    y: MASON_SPOT.y,
    yaw: MASON_SPOT.yaw,
    world,
    shop: SIEGE_CODES.shop,
    roles: [MASON_SERVICE],
    model: null,
    provenance: 'authored',
    greeting:
      "Every stone in these walls was set by a mason's hand, and every crack is a mason's shame. Bring me gold or good stone and my builders will mend whatever the storms and the bandits have broken. Or take a kit and lend a hand yourself.",
  }
}

export function masonShop(): ShopDef {
  return { id: SIEGE_CODES.shop, npcs: [SIEGE_CODES.mason], tabs: [{ name: 'Mason', items: [SIEGE_CODES.kit, SIEGE_CODES.block] }], provenance: 'authored' }
}

/** Whether a drop table already carries the Stone Block. */
const hasBlock = (t: DropTable) => t.groups.some((g) => g.entries.some((e) => e.item === SIEGE_CODES.block))

/**
 * Installs the siege content into content tables (server GameData, client ContentTables): the two items, Ko and his
 * shop, and the Stone Block group of the Stone Ghost's drops (when it has a table). Existing rows are never replaced.
 * Returns what was added.
 */
export function installSiegeContent(
  t: { items: Map<string, ItemDef>; shops: Map<string, ShopDef>; drops: Map<string, DropTable>; npcs: NpcDef[] | Map<string, NpcDef> },
  world: string,
  kitPrice?: number,
): { items: number; npc: boolean; shop: boolean; drops: number } {
  const n = { items: 0, npc: false, shop: false, drops: 0 }
  for (const it of siegeItems(kitPrice)) {
    if (t.items.has(it.code)) continue
    t.items.set(it.code, it)
    n.items++
  }
  if (!t.shops.has(SIEGE_CODES.shop)) {
    t.shops.set(SIEGE_CODES.shop, masonShop())
    n.shop = true
  }
  const npc = masonNpc(world)
  if (Array.isArray(t.npcs)) {
    if (!t.npcs.some((x) => x.code === npc.code)) {
      t.npcs.push(npc)
      n.npc = true
    }
  } else if (!t.npcs.has(npc.code)) {
    t.npcs.set(npc.code, npc)
    n.npc = true
  }
  const ghost = t.drops.get(SIEGE_CODES.blockMob)
  if (ghost && !hasBlock(ghost)) {
    t.drops.set(ghost.mob, { ...ghost, groups: [...ghost.groups, { chance: STONE_BLOCK_DROP, entries: [{ item: SIEGE_CODES.block, weight: 1 }] }] })
    n.drops++
  }
  return n
}

// ---- protocol (docs/SIEGE.md §10.1; GameplayRequests, one actionResult each) ----------------------------------------

export type WallClientMessage =
  /**
   * Donate at Master Mason Ko (NPC entity `npc`, within 8 m): `gold` and/or `blocks` (Stone Blocks) toward segment
   * `seg`, or "where it is needed" (absent). Only what the queue can take is charged (blocks first, then gold).
   */
  | { t: 'wallDonate'; npc: number; seg?: string; gold?: number; blocks?: number }
  /** Start a Mason's Kit channel at segment `seg` (within `kitRangeM`); the bag's kit `itemUse` does the same. */
  | { t: 'wallRepair'; seg: string }

export type WallRequest = WallClientMessage['t']
export const WALL_REQUESTS: readonly WallRequest[] = ['wallDonate', 'wallRepair']
export const WALL_RATE_LIMITS: Readonly<Record<WallRequest, { perSecond: number; burst: number }>> = {
  wallDonate: { perSecond: 1, burst: 3 },
  wallRepair: { perSecond: 1, burst: 3 },
}

/** Wire bound of a donation's Stone Blocks. */
export const MAX_DONATE_BLOCKS = 100_000

// ---- the numbers -----------------------------------------------------------------------------------------------------

type RepairNumbers = Pick<WallSettings, 'maxIp' | 'goldPerPct' | 'blocksPerPct' | 'queueCapPct' | 'builderPctPerMin' | 'kitPct' | 'kitChannelS' | 'kitPrice' | 'kitRangeM'>

/** What the client is told (`walls.repair`). */
export function repairTerms(s: RepairNumbers): WallRepairTerms {
  return { goldPerPct: s.goldPerPct, blocksPerPct: s.blocksPerPct, queueCapPct: s.queueCapPct, builderPctPerMin: s.builderPctPerMin, kitPct: s.kitPct, kitChannelS: s.kitChannelS, kitPrice: s.kitPrice, kitRangeM: s.kitRangeM }
}

/** The queue cap of one segment (ip). */
export const queueCapIp = (s: Pick<WallSettings, 'maxIp' | 'queueCapPct'>) => Math.round((s.queueCapPct / 100) * s.maxIp)

/** Work bought by `gold` (ip, rounded down). */
export const goldIp = (gold: number, s: Pick<WallSettings, 'maxIp' | 'goldPerPct'>) => Math.floor((gold * s.maxIp) / (100 * s.goldPerPct) + 1e-9)

/** The gold that buys `ip` of work (rounded up: never less than its worth). */
export const goldForIp = (ip: number, s: Pick<WallSettings, 'maxIp' | 'goldPerPct'>) => Math.ceil((ip * 100 * s.goldPerPct) / s.maxIp - 1e-9)

/** Work of `blocks` Stone Blocks (ip, rounded). */
export const blocksIp = (blocks: number, s: Pick<WallSettings, 'maxIp' | 'blocksPerPct'>) => Math.round((blocks * s.maxIp) / (100 * s.blocksPerPct))

/** The builders' work per step of `stepMs` on one segment (ip). */
export const builderStepIp = (stepMs: number, s: Pick<WallSettings, 'maxIp' | 'builderPctPerMin'>) => Math.round((s.builderPctPerMin / 100) * s.maxIp * (stepMs / 60_000))

/** One kit channel's work (ip). */
export const kitIp = (s: Pick<WallSettings, 'maxIp' | 'kitPct'>) => Math.round((s.kitPct / 100) * s.maxIp)

export interface DonationPlan {
  /** Stone Blocks taken and gold charged. */
  blocks: number
  gold: number
  /** The work they buy (ip). */
  ip: number
}

/**
 * What a donation of up to `gold` and `blocks` actually takes when the queue has room for `roomIp`: blocks first (whole
 * blocks; the last may round past the room by less than one), then gold for what is left (exactly, rounded up). Nothing
 * when there is no room.
 */
export function planDonation(gold: number, blocks: number, roomIp: number, s: Pick<WallSettings, 'maxIp' | 'goldPerPct' | 'blocksPerPct'>): DonationPlan {
  const out: DonationPlan = { blocks: 0, gold: 0, ip: 0 }
  let room = Math.max(0, Math.floor(roomIp))
  if (room <= 0) return out
  const perBlock = (s.maxIp / (100 * s.blocksPerPct))
  if (blocks > 0 && perBlock > 0) {
    out.blocks = Math.min(Math.floor(blocks), Math.ceil(room / perBlock - 1e-9))
    const ip = blocksIp(out.blocks, s)
    out.ip += ip
    room = Math.max(0, room - ip)
  }
  if (gold > 0 && room > 0) {
    const ip = Math.min(goldIp(gold, s), room)
    if (ip > 0) {
      out.gold = Math.min(Math.floor(gold), goldForIp(ip, s))
      out.ip += ip
    }
  }
  return out
}

/** A segment as the queue sees it. */
export interface QueueSeg {
  id: string
  ip: number
  queued: number
}

/** Room left in the queues (ip): one segment, or all of them (`target` null). */
export function queueRoom(segs: readonly QueueSeg[], target: string | null, s: Pick<WallSettings, 'maxIp' | 'queueCapPct'>): number {
  const cap = queueCapIp(s)
  let room = 0
  for (const g of segs) if (target === null || g.id === target) room += Math.max(0, cap - g.queued)
  return room
}

/**
 * Shares `ip` of donated work out over the queues: all of it to `target`, or (null) "where it is needed": water-filling
 * the segments by what they will stand at (ip + queued), the worst first, in steps of 1 % at most, each queue up to its
 * cap. Returns segment -> ip added (what does not fit is left out; planDonation sized it to fit).
 */
export function allocateDonation(segs: readonly QueueSeg[], ip: number, target: string | null, s: Pick<WallSettings, 'maxIp' | 'queueCapPct'>): Map<string, number> {
  const out = new Map<string, number>()
  let left = Math.max(0, Math.round(ip))
  if (left === 0) return out
  const cap = queueCapIp(s)
  if (target !== null) {
    const g = segs.find((x) => x.id === target)
    // planDonation lets the last Stone Block round a little past the cap: the target takes all of it
    if (g) out.set(g.id, left)
    return out
  }
  const work = segs.map((g) => ({ id: g.id, level: g.ip + g.queued, room: Math.max(0, cap - g.queued) })).filter((g) => g.room > 0)
  const chunk = Math.max(1, Math.round(s.maxIp / 100))
  while (left > 0 && work.length) {
    work.sort((a, b) => a.level - b.level || (a.id < b.id ? -1 : 1))
    const g = work[0]!
    // fill up to the next one's level, at most 1 %, at least 1 ip
    const next = work[1] ? Math.max(1, work[1].level - g.level) : chunk
    const n = Math.min(left, g.room, Math.min(chunk, next))
    out.set(g.id, (out.get(g.id) ?? 0) + n)
    g.level += n
    g.room -= n
    left -= n
    if (g.room <= 0) work.shift()
  }
  // a leftover (blocks rounding past every cap) goes to the worst segment
  if (left > 0 && segs.length) {
    const worst = [...segs].sort((a, b) => a.ip + a.queued - (b.ip + b.queued))[0]!
    out.set(worst.id, (out.get(worst.id) ?? 0) + left)
  }
  return out
}

// ---- the kit at the wall ---------------------------------------------------------------------------------------------

/**
 * Distance (m, XZ) from a point to a segment's body: the rectangle between its outer and inner faces over its span
 * (0 on or inside it). The kit works within `kitRangeM` of it, from either side.
 */
export function segmentDistance(side: Pick<WallsSideInfo, 'axis' | 'outer' | 'inner'>, seg: Pick<WallsSegment, 'from' | 'to'>, x: number, z: number): number {
  const along = side.axis === 'x' ? x : z
  const across = side.axis === 'x' ? z : x
  const lo = Math.min(side.outer, side.inner)
  const hi = Math.max(side.outer, side.inner)
  const da = along < seg.from ? seg.from - along : along > seg.to ? along - seg.to : 0
  const dc = across < lo ? lo - across : across > hi ? across - hi : 0
  return Math.hypot(da, dc)
}

/** The segment nearest to a point within `rangeM` (ties: the first), or null. */
export function nearestSegment(walls: Pick<WallsExport, 'segments' | 'sides'>, x: number, z: number, rangeM: number): { seg: WallsSegment; d: number } | null {
  let best: { seg: WallsSegment; d: number } | null = null
  for (const seg of walls.segments) {
    const side = walls.sides.find((s) => s.side === seg.side)
    if (!side) continue
    const d = segmentDistance(side, seg, x, z)
    if (d <= rangeM && (!best || d < best.d)) best = { seg, d }
  }
  return best
}

// ---- looters (docs/SIEGE.md §2.5) ------------------------------------------------------------------------------------

/** Looter nests' ids (never in the Spawner's list). */
export const LOOTER_NEST_BASE = 9_200_000

/**
 * The looters' nest at an open gap: centred on its breach zone (10 m inside the gap), spawning within 6 m, leashed to the
 * zone. `index` is the segment's index in walls.json.
 */
export function looterNest(zone: BreachZone, index: number, mob: { code: string; level: number; aggressive: boolean }, world: string, s: Pick<WallSettings, 'looters' | 'looterRespawnMin'>): NestDef {
  const respawn = Math.round(s.looterRespawnMin * 60)
  return {
    id: LOOTER_NEST_BASE + index,
    mob: mob.code,
    x: zone.x,
    z: zone.z,
    radius: 10,
    spawnRadius: 6,
    count: s.looters,
    respawnSec: [respawn, respawn],
    tactics: { id: 0, aggressive: true, sightRange: 14, leashRange: Math.max(15, zone.r) },
    world,
    provenance: 'authored',
    source: { file: 'siege-repair.ts looterNest', zone: `breach ${zone.seg}`, x: zone.x, z: zone.z },
    level: mob.level,
  }
}
