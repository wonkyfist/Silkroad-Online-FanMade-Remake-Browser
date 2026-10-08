/**
 * Siege of Jangan, layer 6: Hunters and the jail (docs/SIEGE.md §8.2-§8.6, §10, §11.2). The pure rules, the authored
 * content and the protocol the server, the client and the admin panel share.
 *
 * - **The Hunter licence** from **Captain Yun** (an authored NPC by the west gate): level ≥ `hunter.minLevel` (15),
 *   `hunter.licenceGold` (10,000) gold, not Wanted, no offence on the account in the last `hunter.cleanDays` (30) days.
 *   Permanent unless revoked (a GM; a Hunter who breaks a wall loses it for `hunter.revokeDays`). The licence is the
 *   `hunter` row of `char_jobs` (migration 19); `points` counts the captures.
 * - **On duty** (toggle at Yun or the HUD): only in a safe area and out of combat; off duty is refused for
 *   `hunter.offDutyLockMin` after the last PvP hit. An on-duty Hunter wears the blue Hunter badge (EntityState.hunter =
 *   the rank), gets `wantedPing`s and may fight the Wanted.
 * - **The PvP rule** (`pvpAllowed`): an on-duty Hunter and a Wanted player (not associates of each other) may fight each
 *   other anywhere but the stockade, the safe area included; nobody else. Damage between players × `hunter.pvpMul`.
 * - **Capture**: a Wanted brought to 0 HP by a Hunter is subdued (HP 1, a short bound pose), then warped into the
 *   **Garrison Stockade**. The bounty is shared by the Hunters (not associates of the Wanted) who dealt ≥
 *   `law.captureMinPct` of the Wanted's max HP in the last `law.captureWindowSec`, by damage (`captureShares`); the same
 *   Hunter account and the same Wanted account within `law.pairCooldownDays` get no gold and no capture credit; the
 *   other anti-collusion rules (recent contacts, lookouts, repeat captures, the daily cap, the keg-price cap) are the
 *   server's (law.ts `capture`, docs/SIEGE.md §8.6).
 * - **The Garrison Stockade** (`STOCKADE`, the open ground north of the west camp, inside the safe area): prisoners are
 *   clamped inside, may walk, sit, chat and break rocks (`jailChore`, −`law.choreMin` per chore, at most
 *   `law.choresCapPct` of the sentence); the clock is `law.sentenceClock` ('real': offline counts; 'online').
 * - **Ranks** 1-5 by captures (1, 3, 10, 25, 60); 0 below the first ("Recruit").
 */
import type { ItemDef, NpcDef, ShopDef } from './content.ts'
import type { SiegeEventSettings } from './siege-event.ts'
import { jobPvp, type JobId } from './jobs.ts'

// ---- content -----------------------------------------------------------------------------------------------------------

export const HUNTER_CODES = {
  /** Captain Yun of the garrison (placeholder name, docs/SIEGE.md §16.2 q20): the licence, the duty, the Net. */
  yun: 'NPC_SIEGE_CAPTAIN_YUN',
  /** The model he wears (Hunter Associate Gwakwi's: an officer in the garrison's armour). */
  yunBase: 'NPC_CH_GENARAL_SW',
  /** Warden Bae at the stockade's gate. */
  warden: 'NPC_SIEGE_WARDEN_BAE',
  wardenBase: 'NPC_CH_SOLDIER_WE2',
  net: 'ITEM_SIEGE_HUNTER_NET',
  shop: 'SHOP_SIEGE_CAPTAIN_YUN',
} as const

/** The NPC dialog services (protocol NpcService): Captain Yun's licence and duty, Warden Bae's word on the sentence. */
export const HUNTER_SERVICE = 'hunter'
export const WARDEN_SERVICE = 'warden'

/** Captain Yun by the west gate, inside, beside the gate soldiers (glTF m on jangan-fields; facing the gate). */
export const YUN_SPOT = { x: -145, z: -207, yaw: Math.atan2(-1, 0) } as const

/**
 * The Garrison Stockade (glTF m on jangan-fields; north = −z): 30 × 22 m of open terrain north of the west camp, inside
 * the safe area. `gate` is the opening in the south fence (toward the camp), `cell` where a prisoner is put, `pile` the
 * rocks of the chores, `release` where a freed prisoner stands (outside the gate).
 */
export const STOCKADE = {
  x0: -165,
  x1: -135,
  z0: -318,
  z1: -296,
  gate: { x: -150, z: -296 },
  cell: { x: -150, z: -307 },
  pile: { x: -159, z: -313 },
  release: { x: -150, z: -291 },
} as const
/** Warden Bae stands just outside the gate. */
export const WARDEN_SPOT = { x: -146, z: -293.5, yaw: Math.atan2(0, -1) } as const
/** A prisoner's moves are clamped this far inside the fence (m). */
export const STOCKADE_INSET_M = 1
/** The chore is done within this reach of the rock pile (m). */
export const PILE_REACH_M = 4

export const HUNTER_ICONS = { net: '/out/icons/item/etc/etc_net_yellow.png' } as const

/** Captures for ranks 1-5 (docs/SIEGE.md §8.2); since the job system the rank is the Hunter job level − 1 (docs/JOBS.md §2.3). */
export const HUNTER_RANKS = [1, 3, 10, 25, 60] as const

/** A Hunter's rank by captures: 0 (a recruit) below the first, else 1-5. */
export function hunterRank(captures: number): number {
  let r = 0
  for (const need of HUNTER_RANKS) if (captures >= need) r++
  return r
}

export function hunterNetItem(price = 8000): ItemDef {
  return {
    code: HUNTER_CODES.net,
    id: 0,
    name: "Bounty Hunter's Net",
    typeId: [3, 3, 3, 1],
    category: 'etc',
    degree: 0,
    reqLevel: 0,
    reqGender: 'any',
    race: 'any',
    maxStack: 10,
    price,
    sellPrice: Math.round(price / 4),
    model: null,
    icon: HUNTER_ICONS.net,
    fieldSources: { all: 'authored (docs/SIEGE.md §7)' },
  }
}

export function yunNpc(world: string): NpcDef {
  return {
    code: HUNTER_CODES.yun,
    name: 'Captain Yun',
    x: YUN_SPOT.x,
    z: YUN_SPOT.z,
    yaw: YUN_SPOT.yaw,
    world,
    shop: HUNTER_CODES.shop,
    roles: [HUNTER_SERVICE],
    model: null,
    provenance: 'authored',
    greeting:
      'Someone blows a hole in our walls and expects to stroll away? Not while I hold this gate. The garrison pays for every wall-breaker brought in alive. Take a Bounty Hunter\'s licence, go on duty, and bring them to the Stockade.',
  }
}

export function wardenNpc(world: string): NpcDef {
  return {
    code: HUNTER_CODES.warden,
    name: 'Warden Bae',
    x: WARDEN_SPOT.x,
    z: WARDEN_SPOT.z,
    yaw: WARDEN_SPOT.yaw,
    world,
    roles: [WARDEN_SERVICE],
    model: null,
    provenance: 'authored',
    greeting: "The Garrison Stockade. Those inside broke the town's walls; they sit here until their time is served. Break rocks if you want it shorter.",
  }
}

export function yunShop(): ShopDef {
  return { id: HUNTER_CODES.shop, npcs: [HUNTER_CODES.yun], tabs: [{ name: 'Bounty Hunter', items: [HUNTER_CODES.net] }], provenance: 'authored' }
}

/**
 * Installs the layer-6 content into content tables (server GameData, client ContentTables): the Hunter's Net, Captain
 * Yun and his shop, Warden Bae. Existing rows are never replaced.
 */
export function installSiegeHunterContent(
  t: { items: Map<string, ItemDef>; shops?: Map<string, ShopDef>; npcs: NpcDef[] | Map<string, NpcDef> },
  world: string,
  netPrice?: number,
): { items: number; npcs: number; shop: boolean } {
  const n = { items: 0, npcs: 0, shop: false }
  const net = hunterNetItem(netPrice)
  if (!t.items.has(net.code)) {
    t.items.set(net.code, net)
    n.items++
  }
  if (t.shops && !t.shops.has(HUNTER_CODES.shop)) {
    t.shops.set(HUNTER_CODES.shop, yunShop())
    n.shop = true
  }
  for (const npc of [yunNpc(world), wardenNpc(world)]) {
    if (Array.isArray(t.npcs)) {
      if (t.npcs.some((x) => x.code === npc.code)) continue
      t.npcs.push(npc)
    } else {
      if (t.npcs.has(npc.code)) continue
      t.npcs.set(npc.code, npc)
    }
    n.npcs++
  }
  return n
}

// ---- the stockade ---------------------------------------------------------------------------------------------------------

/** Whether (x, z) is inside the stockade (`inset` m inside the fence). */
export function inStockade(x: number, z: number, inset = 0): boolean {
  return x >= STOCKADE.x0 + inset && x <= STOCKADE.x1 - inset && z >= STOCKADE.z0 + inset && z <= STOCKADE.z1 - inset
}

/** (x, z) clamped into the stockade, `inset` m inside the fence. */
export function clampToStockade(x: number, z: number, inset = STOCKADE_INSET_M): [number, number] {
  return [Math.min(STOCKADE.x1 - inset, Math.max(STOCKADE.x0 + inset, x)), Math.min(STOCKADE.z1 - inset, Math.max(STOCKADE.z0 + inset, z))]
}

export type SentenceClock = 'real' | 'online'
export const SENTENCE_CLOCKS: readonly SentenceClock[] = ['real', 'online']

/** A jail term (jail_terms): the sentence is endsAt − startsAt; `servedMs` counts online time (the online clock). */
export interface JailTermLike {
  startsAt: number
  endsAt: number
  servedMs: number
  chores: number
}

/** The time the chores took off (ms): `choreMin` each, at most `choresCapPct` of the sentence. */
export function choreCreditMs(t: JailTermLike, law: Pick<SiegeEventSettings['law'], 'choreMin' | 'choresCapPct'>): number {
  const sentence = Math.max(0, t.endsAt - t.startsAt)
  return Math.min(t.chores * law.choreMin * 60_000, Math.floor((sentence * law.choresCapPct) / 100))
}

/** The chores that still count (the cap reached: none). */
export function choresLeft(t: JailTermLike, law: Pick<SiegeEventSettings['law'], 'choreMin' | 'choresCapPct'>): number {
  const sentence = Math.max(0, t.endsAt - t.startsAt)
  const max = Math.floor(Math.floor((sentence * law.choresCapPct) / 100) / Math.max(1, law.choreMin * 60_000))
  return Math.max(0, max - t.chores)
}

/**
 * The time left of a term at `now` (ms): 'real' runs from the start, offline included; 'online' counts `servedMs` (the
 * caller adds the live session). Chores come off either way.
 */
export function jailLeftMs(t: JailTermLike, now: number, clock: SentenceClock, law: Pick<SiegeEventSettings['law'], 'choreMin' | 'choresCapPct'>): number {
  const credit = choreCreditMs(t, law)
  if (clock === 'online') return Math.max(0, t.endsAt - t.startsAt - credit - t.servedMs)
  return Math.max(0, t.endsAt - credit - now)
}

// ---- PvP (docs/SIEGE.md §8.3) -----------------------------------------------------------------------------------------------

/** One side of a fight as the PvP rule sees it. */
export interface PvpSide {
  /** An on-duty Hunter. */
  hunter: boolean
  wanted: boolean
  /** Jailed, or being subdued. */
  jailed: boolean
  /** Just released (no Hunter target for `law.pardonMin`). */
  pardoned: boolean
  /** Standing in the stockade (no fighting there). */
  inStockade: boolean
  // ---- the job system (docs/JOBS.md §4; absent = no job) ----
  /** The character's job (a Hunter in job mode is also `hunter`). */
  job?: JobId | null
  /** The job suit is on (job mode). */
  jobMode?: boolean
  /** In a place safe from the job war: a safe area (town), the stockade, a trade post's or the den's ring. */
  inJobSafe?: boolean
}

/**
 * Whether `a` may attack `b` (docs/SIEGE.md §8.3): an on-duty Hunter a Wanted, a Wanted an on-duty Hunter, never
 * associates (party, guild, the same account, the same IP), never in the stockade, never the jailed or the pardoned.
 * The job war (docs/JOBS.md §4): two players in job mode on opposite sides (a Trader or a Hunter against a Thief),
 * neither in a job-safe place (towns stay safe for it; the Wanted row keeps its "no sanctuary"). Everyone else: no PvP.
 */
export function pvpAllowed(a: PvpSide, b: PvpSide, associates: boolean): boolean {
  if (associates || a.jailed || b.jailed || a.inStockade || b.inStockade) return false
  if (a.hunter && b.wanted && !b.pardoned) return true
  if (a.wanted && b.hunter && !a.pardoned) return true
  return jobPvp(a, b)
}

// ---- capture (docs/SIEGE.md §8.4) -------------------------------------------------------------------------------------------

export interface PvpHit {
  /** The Hunter's character. */
  characterId: number
  damage: number
  at: number
}

/**
 * The bounty's shares: per Hunter, the damage dealt in the last `windowMs`, for those with ≥ `minPct` of `maxHp`; the
 * share is the damage. The capturing hit's Hunter always counts (at least its damage).
 */
export function captureShares(hits: readonly PvpHit[], maxHp: number, now: number, windowMs: number, minPct: number, captor: number | null): { characterId: number; share: number }[] {
  const sum = new Map<number, number>()
  for (const h of hits) if (now - h.at <= windowMs && h.damage > 0) sum.set(h.characterId, (sum.get(h.characterId) ?? 0) + h.damage)
  const min = (maxHp * minPct) / 100
  const out = [...sum].filter(([c, d]) => d >= min || c === captor).map(([characterId, share]) => ({ characterId, share }))
  if (captor !== null && !out.some((s) => s.characterId === captor)) out.push({ characterId: captor, share: 1 })
  return out.sort((a, b) => b.share - a.share)
}

// ---- protocol (docs/SIEGE.md §10; additive) ----------------------------------------------------------------------------------

/** A Hunter's own state (`lawState.hunter`). */
export interface HunterView {
  licensed: boolean
  onDuty: boolean
  rank: number
  captures: number
  /** The licence is revoked until then (ms epoch). */
  revokedUntil?: number
  /** Off duty is refused until then (ms epoch; after a PvP hit). */
  lockUntil?: number
  /** The Hunter's Net is ready again then (ms epoch). */
  netAt?: number
}

/** A prisoner's own state (`lawState.jail`). */
export interface JailView {
  /** Time left now (ms). */
  leftMs: number
  sentenceMs: number
  offence: number
  chores: number
  /** Chores that still shorten the sentence. */
  choresLeft: number
  clock: SentenceClock
  /** A chore runs until then (ms epoch). */
  choreEndsAt?: number
}

/**
 * Why a capture reward was withheld (docs/SIEGE.md §8.6, the anti-collusion rules): an associate of the Wanted, an
 * account that met theirs recently (trade, stall, party), a lookout at their keg, the 7-day pair, a Wanted caught too
 * often this week, the Hunter's daily bounty cap.
 */
export type CaptureRule = 'associate' | 'contact' | 'lookout' | 'pair' | 'repeat' | 'daily_cap'
export const CAPTURE_RULES: readonly CaptureRule[] = ['associate', 'contact', 'lookout', 'pair', 'repeat', 'daily_cap']

export type HunterServerMessage =
  /**
   * To on-duty Hunters every `hunter.pingSec`: Wanted player `id` is somewhere in the circle (x, z, r); the centre lies
   * within `pingOffsetM` of them.
   */
  | { t: 'wantedPing'; id: number; name: string; x: number; z: number; r: number; at: number; /** docs/JOBS.md §6.4: a robber (robbery warrant only). */ robbery?: true }
  /**
   * A capture, to the captors and the prisoner: `name` (the Wanted) was caught; `gold` what this captor was paid;
   * `rule` the anti-collusion rule that withheld (part of) it (`pair` also sets `pair`); `uncounted`: no capture credit
   * (captures, rank); `sentenceMs` what the prisoner serves.
   */
  | { t: 'lawCapture'; name: string; bounty: number; gold: number; sentenceMs: number; prisoner?: true; pair?: true; captors?: string[]; rule?: CaptureRule; uncounted?: true }

export type HunterClientMessage =
  /** Buy the Hunter's licence at Captain Yun (NPC entity `npc`). */
  | { t: 'hunterLicence'; npc: number }
  /** Go on (or off) duty. */
  | { t: 'hunterDuty'; on: boolean }
  /** Throw a Hunter's Net at Wanted player `target`. */
  | { t: 'hunterNet'; target: number }
  /** Break a rock at the stockade's pile (a prisoner's chore). */
  | { t: 'jailChore' }
export type HunterRequest = HunterClientMessage['t']
export const HUNTER_REQUESTS: readonly HunterRequest[] = ['hunterLicence', 'hunterDuty', 'hunterNet', 'jailChore']
export const HUNTER_RATE_LIMITS: Readonly<Record<HunterRequest, { perSecond: number; burst: number }>> = {
  hunterLicence: { perSecond: 1, burst: 3 },
  hunterDuty: { perSecond: 1, burst: 3 },
  hunterNet: { perSecond: 1, burst: 3 },
  jailChore: { perSecond: 1, burst: 3 },
}

export type HunterFailReason = 'jailed' | 'not_hunter'
export const HUNTER_FAIL_REASONS: readonly HunterFailReason[] = ['jailed', 'not_hunter']

/** Wire limits (validate.ts). */
export const HUNTER_LIMITS = { rank: 6, captures: 1_000_000, sentenceMs: 400 * 3_600_000, chores: 10_000, pingR: 1000, captors: 20 } as const

// ---- the admin panel's Law tab (docs/SIEGE.md §11.3, §11.4) ---------------------------------------------------------------

/** GET /api/admin/siege/law. */
export interface AdminLawView {
  clock: SentenceClock
  /** Open warrants. */
  wanted: { warrant: number; characterId: number; name: string; role: 'breaker' | 'accomplice'; wall: string | null; offence: number; bounty: number; treason: boolean; issuedAt: number; onlineLeftMs: number; online: boolean }[]
  /** Prisoners (the time left on the clock in use). */
  jailed: { characterId: number; name: string; startsAt: number; endsAt: number; leftMs: number; chores: number; online: boolean }[]
  /** Offence records per account (the level now, forgiveness applied). */
  records: { accountId: number; characters: string[]; level: number; recorded: number; lastOffenceAt: number | null; lastPlantAt: number | null }[]
  hunters: { characterId: number; name: string; rank: number; captures: number; onDuty: boolean; revokedUntil: number | null; online: boolean }[]
  /** Capture rewards withheld by the anti-collusion rules, newest first (suspected collusion). */
  flags: { at: number; wanted: string; wantedAccount: number; hunter: string; hunterAccount: number | null; rule: CaptureRule; withheld: number }[]
  /** The latest warrants of any status. */
  recent: { warrant: number; name: string; status: string; role: string; wall: string | null; offence: number; bounty: number; issuedAt: number; closedAt: number | null; captors: string[] }[]
}
