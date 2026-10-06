/**
 * Siege of Jangan, layer 5: player kegs and Wanted (docs/SIEGE.md §7, §8.1, §8.5, §8.6, §10). The pure rules, the
 * authored content and the protocol the server, the client and the admin panel share.
 *
 * - **The Thunder Keg**: crafted by **Old Fang the Fence** (an authored NPC at a bandit-side camp ≈ 600 m west of town,
 *   outside the safe area) for `keg.gold` (50,000) gold and `keg.saltpeter` (3) Saltpeter. Character-bound (no trade,
 *   stall, storage, drop or sale), at most `keg.carry` (2) carried. Planted from the bag (`itemUse`) at a segment's
 *   outer foot (`kegSpot`: within `keg.faceM` of the outer face, never over a gatehouse or a corner tower, never in a
 *   safe area): a `plantSec` cast, then a `fuseSec` fuse anyone but the planter's associates may defuse; the blast takes
 *   `damagePct` of the segment. Level ≥ 18, ≥ 10 h played, one plant per **account** per 30 min.
 * - **Saltpeter**: Bandits and Bandit Archers drop it (2 %), siege monsters too (2 %).
 * - **Wanted**: the planter whose blast takes a segment through 0 is the wall-breaker; everyone else whose keg hit that
 *   segment in the last `accompliceWindowMin` (10) minutes is an accomplice (half the bounty and the sentence). Bounty
 *   = bountyBase × min(offence, bountyCapMul); kegs during a siege are treason (× treasonMul). The warrant lapses after
 *   `wantedOnlineHours` (2) of the Wanted's **online** time; the offence still counts. Bounties are paid by the server
 *   (the capture: layer 6).
 * - **The offence record** is per **account** (alts share it); one level is forgiven per `forgiveDays` (30) clean days.
 */
import type { DropTable, ItemDef, NpcDef } from './content.ts'
import type { SiegeEventSettings } from './siege-event.ts'
import type { WallsExport, WallsSegment, WallsSideInfo } from './siege.ts'

// ---- content -----------------------------------------------------------------------------------------------------------

export const LAW_CODES = {
  keg: 'ITEM_SIEGE_THUNDER_KEG',
  saltpeter: 'ITEM_SIEGE_SALTPETER',
  /** Old Fang the Fence (placeholder name, docs/SIEGE.md §16.2 q20). */
  fence: 'NPC_SIEGE_OLD_FANG',
  /** The model he wears (the Casino Guardian's: a heavy-set tough). */
  fenceBase: 'NPC_CH_BIGMAN',
  /** Who drops Saltpeter. */
  saltpeterMobs: ['MOB_CH_BANDIT', 'MOB_CH_BANDITARCHER'],
} as const

/** The NPC dialog service of Old Fang (protocol NpcService): craft a Thunder Keg. */
export const FENCE_SERVICE = 'fence'

/** Old Fang's camp by the west road, ≈ 600 m west of the town centre, outside the safe area (glTF m on jangan-fields). */
export const FENCE_SPOT = { x: -520, z: -232, yaw: Math.atan2(1, 0) } as const

/** Chance of Saltpeter per kill (Bandits, Bandit Archers, siege monsters). */
export const SALTPETER_DROP = 0.02

/** Retail icons reused: a red firework bomb (the keg), white powder (Saltpeter). */
export const LAW_ICONS = {
  keg: '/out/icons/item/etc/firework_bomb_r.png',
  saltpeter: '/out/icons/item/etc/etc_powder_white.png',
} as const

export function thunderKegItem(): ItemDef {
  return {
    code: LAW_CODES.keg,
    id: 0,
    name: 'Thunder Keg',
    typeId: [3, 3, 3, 1],
    category: 'etc',
    degree: 0,
    reqLevel: 0,
    reqGender: 'any',
    race: 'any',
    maxStack: 1,
    price: 0,
    sellPrice: 0,
    canSell: false,
    canTrade: false,
    canDrop: false,
    canStore: false,
    model: null,
    use: { thunderKeg: true, cooldownGroup: 'thunderKeg', cooldownMs: 0 },
    icon: LAW_ICONS.keg,
    fieldSources: { all: 'authored (docs/SIEGE.md §7)' },
  }
}

export function saltpeterItem(): ItemDef {
  return {
    code: LAW_CODES.saltpeter,
    id: 0,
    name: 'Saltpeter',
    typeId: [3, 3, 3, 1],
    category: 'etc',
    degree: 0,
    reqLevel: 0,
    reqGender: 'any',
    race: 'any',
    maxStack: 50,
    price: 0,
    sellPrice: 40,
    model: null,
    icon: LAW_ICONS.saltpeter,
    fieldSources: { all: 'authored (docs/SIEGE.md §7)' },
  }
}

export function fenceNpc(world: string): NpcDef {
  return {
    code: LAW_CODES.fence,
    name: 'Old Fang the Fence',
    x: FENCE_SPOT.x,
    z: FENCE_SPOT.z,
    yaw: FENCE_SPOT.yaw,
    world,
    roles: [FENCE_SERVICE],
    model: null,
    provenance: 'authored',
    greeting:
      "Walls, walls, walls. A town that hides behind stone has forgotten how to fight. Bring me gold and saltpeter and I'll pack you a keg that opens any wall in Jangan. What you do with it is your business... and the garrison's, once they hear the bang.",
  }
}

const hasSaltpeter = (t: DropTable) => t.groups.some((g) => g.entries.some((e) => e.item === LAW_CODES.saltpeter))

/**
 * Installs the layer-5 content into content tables (server GameData, client ContentTables): the Thunder Keg, Saltpeter,
 * Old Fang, and the Saltpeter group of the Bandits' drops (when they have tables). Existing rows are never replaced.
 */
export function installSiegeLawContent(
  t: { items: Map<string, ItemDef>; drops?: Map<string, DropTable>; npcs: NpcDef[] | Map<string, NpcDef> },
  world: string,
): { items: number; npc: boolean; drops: number } {
  const n = { items: 0, npc: false, drops: 0 }
  for (const it of [thunderKegItem(), saltpeterItem()]) {
    if (t.items.has(it.code)) continue
    t.items.set(it.code, it)
    n.items++
  }
  const npc = fenceNpc(world)
  if (Array.isArray(t.npcs)) {
    if (!t.npcs.some((x) => x.code === npc.code)) {
      t.npcs.push(npc)
      n.npc = true
    }
  } else if (!t.npcs.has(npc.code)) {
    t.npcs.set(npc.code, npc)
    n.npc = true
  }
  for (const mob of LAW_CODES.saltpeterMobs) {
    const d = t.drops?.get(mob)
    if (!d || hasSaltpeter(d)) continue
    t.drops!.set(mob, { ...d, groups: [...d.groups, { chance: SALTPETER_DROP, entries: [{ item: LAW_CODES.saltpeter, weight: 1 }] }] })
    n.drops++
  }
  return n
}

// ---- where a keg may go (docs/SIEGE.md §7, §8.6) ---------------------------------------------------------------------------

export type KegSpot =
  | { ok: true; seg: WallsSegment; side: WallsSideInfo; /** Metres outside the outer face (≥ -1). */ out: number }
  /** `gate`: at a gatehouse or a corner tower (indestructible); `inside`: on the town side of the wall; `far`: away from it. */
  | { ok: false; why: 'gate' | 'inside' | 'far' }

/** A keg may sit up to this far inside the outer face (the foot of the wall). */
const FOOT_SLACK_M = 1.5

/**
 * Where a keg planted at (x, z) would go: the segment whose outer foot it stands at (within `faceM` of the outer face,
 * outside the wall, along the segment's span), else why not. Over a gatehouse or a corner (the `fixed` spans) it is
 * `gate`; inside the wall (or on the inner face) `inside`.
 */
export function kegSpot(walls: Pick<WallsExport, 'segments' | 'sides'>, x: number, z: number, faceM: number): KegSpot {
  let why: 'gate' | 'inside' | 'far' = 'far'
  for (const side of walls.sides) {
    const along = side.axis === 'x' ? x : z
    const across = side.axis === 'x' ? z : x
    // metres outside the outer face (negative: in the wall or behind it)
    const out = (across - side.outer) * side.out
    const thick = Math.abs(side.outer - side.inner)
    if (out > faceM || out < -(thick + faceM)) continue
    if (out < -FOOT_SLACK_M) {
      const onSpan = walls.segments.some((s) => s.side === side.side && along >= s.from && along <= s.to) || side.fixed.some((f) => along >= f.from && along <= f.to)
      if (onSpan && why === 'far') why = 'inside'
      continue
    }
    const seg = walls.segments.find((s) => s.side === side.side && along >= s.from && along <= s.to)
    if (seg) return { ok: true, seg, side, out }
    if (side.fixed.some((f) => along >= f.from - 1 && along <= f.to + 1)) why = 'gate'
  }
  return { ok: false, why }
}

// ---- the law (docs/SIEGE.md §8.1, §8.5) -----------------------------------------------------------------------------------

export type WarrantRole = 'breaker' | 'accomplice'
export type WarrantStatus = 'open' | 'captured' | 'lapsed' | 'pardoned'
export const WARRANT_STATUSES: readonly WarrantStatus[] = ['open', 'captured', 'lapsed', 'pardoned']

/** Sentences by offence (hours; the 5th and later: the cap). Used by the jail (layer 6). */
export const SENTENCES_H = [2, 4, 8, 16, 24] as const
export const SENTENCE_CAP_H = 24
/** An accomplice serves at least this long (hours). */
export const ACCOMPLICE_MIN_H = 1
const DAY_MS = 86_400_000

/** An account's offence record (law_records). */
export interface OffenceRecord {
  offences: number
  lastAt: number | null
}

/** The offence level now: one level forgiven per `forgiveDays` clean days since the last offence (never below 0). */
export function offenceLevel(rec: OffenceRecord | null | undefined, now: number, forgiveDays: number): number {
  if (!rec || rec.offences <= 0) return 0
  if (rec.lastAt === null) return rec.offences
  const clean = Math.floor(Math.max(0, now - rec.lastAt) / (forgiveDays * DAY_MS))
  return Math.max(0, rec.offences - clean)
}

/** The record after a new offence at `now`: the forgiven level + 1. */
export function addOffence(rec: OffenceRecord | null | undefined, now: number, forgiveDays: number): OffenceRecord {
  return { offences: offenceLevel(rec, now, forgiveDays) + 1, lastAt: now }
}

/** The bounty of a warrant: bountyBase × min(offence, bountyCapMul); an accomplice half; treason × treasonMul. */
export function wantedBounty(offence: number, role: WarrantRole, treason: boolean, law: Pick<SiegeEventSettings['law'], 'bountyBase' | 'bountyCapMul' | 'treasonMul'>): number {
  const level = Math.max(1, Math.min(Math.floor(offence), law.bountyCapMul))
  let b = law.bountyBase * level
  if (role === 'accomplice') b /= 2
  if (treason) b *= law.treasonMul
  return Math.round(b)
}

/** The sentence of a warrant (ms; layer 6 jails it): 2 / 4 / 8 / 16 / 24 h by offence; accomplice half (≥ 1 h); treason × mul, capped at 24 h. */
export function sentenceMs(offence: number, role: WarrantRole, treason: boolean, law: Pick<SiegeEventSettings['law'], 'treasonMul'>): number {
  const i = Math.max(1, Math.min(Math.floor(offence), SENTENCES_H.length)) - 1
  let h: number = SENTENCES_H[i]!
  if (role === 'accomplice') h = Math.max(ACCOMPLICE_MIN_H, h / 2)
  if (treason) h *= law.treasonMul
  return Math.round(Math.min(SENTENCE_CAP_H, h) * 3_600_000)
}

/** A warrant's online time before it lapses (ms). */
export const wantedOnlineMs = (law: Pick<SiegeEventSettings['law'], 'wantedOnlineHours'>) => Math.round(law.wantedOnlineHours * 3_600_000)

// ---- protocol (docs/SIEGE.md §10; additive) --------------------------------------------------------------------------------

export type LawNoticeEvent = 'plant' | 'wanted' | 'defused' | 'lapsed' | 'pardoned' | 'captured'
export const LAW_NOTICE_EVENTS: readonly LawNoticeEvent[] = ['plant', 'wanted', 'defused', 'lapsed', 'pardoned', 'captured']

/** What the Wanted player sees of their own warrant(s) (`lawState`). */
export interface WantedView {
  /** The bounty on the head (all open warrants). */
  bounty: number
  /** Online time left before the (last) warrant lapses (ms). */
  lapseMs: number
  offence: number
  role: WarrantRole
  treason?: true
}

export type LawServerMessage =
  /**
   * A moment of the law, to every world player: `plant` (someone plants a Thunder Keg at `wall`; no name), `wanted`
   * (`name` breached `wall`; `bounty`; `accomplices` named; `treason` during a siege), `defused` (`name` defused the
   * keg at `wall`), `lapsed` / `pardoned` / `captured` (`name`'s warrant ended).
   */
  | { t: 'lawNotice'; event: LawNoticeEvent; wall?: string; name?: string; bounty?: number; treason?: true; accomplices?: string[] }
  /** The own law state, on enter-world and on every change: absent `wanted` = not Wanted. */
  | { t: 'lawState'; wanted?: WantedView; offences: number }

export type LawClientMessage =
  /** Craft a Thunder Keg at Old Fang (NPC entity `npc`, his `fence` service). */
  { t: 'kegCraft'; npc: number }
export type LawRequest = LawClientMessage['t']
export const LAW_REQUESTS: readonly LawRequest[] = ['kegCraft']
export const LAW_RATE_LIMITS: Readonly<Record<LawRequest, { perSecond: number; burst: number }>> = {
  kegCraft: { perSecond: 1, burst: 3 },
}

export type LawFailReason = 'keg_limit'
export const LAW_FAIL_REASONS: readonly LawFailReason[] = ['keg_limit']

/** Wire limits (validate.ts). */
export const LAW_LIMITS = { bounty: 1_000_000_000, accomplices: 20, lapseMs: 400 * 3_600_000, offences: 1000 } as const
