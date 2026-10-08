/**
 * The job system: Trader, (Bounty) Hunter, Thief on Jangan island (docs/JOBS.md). Layer 0 and 1: the content (the
 * retail trade goods, job suits, trade transports, the four trade posts and the Bandit Den), the settings, the pure rules
 * (job levels and EXP, suit tiers, stars, margins, price drift, the den's payout, who may join) and the protocol the
 * server, the client and the admin panel share. The trade, transports and robbery (layers 2-4) build on these rules.
 *
 * - **Three jobs, one per character, one side per account** (§2.1): Trader and Hunter are the `law` side, Thief the
 *   `outlaw` side. Join at level `jobs.minLevel` (15), not Wanted, not jailed; the Trader licence at Specialty Trader
 *   Jodaesan, the Hunter's at Captain Yun (today's Bounty Hunter licence, siege settings `hunter.*`), the Thief's at Old
 *   Fang the Fence. Leaving loses the job level and EXP and starts a `jobs.leaveWaitDays` wait for the account.
 * - **Job mode = the job suit on** (§2.2): the `on_duty` column of `char_jobs` for every job (the Hunter's duty).
 * - **Job EXP** is separate from character EXP (§3.1); levels 1-7 by `jobs.levels`; a Hunter's rank (the badge, the
 *   ranks of SIEGE.md) is its job level − 1.
 */
import type { NpcDef } from './content.ts'

// ---- jobs and sides --------------------------------------------------------------------------------------------------------

export type JobId = 'trader' | 'hunter' | 'thief'
export const JOB_IDS: readonly JobId[] = ['trader', 'hunter', 'thief']
export type JobSide = 'law' | 'outlaw'
export const JOB_SIDES: readonly JobSide[] = ['law', 'outlaw']

/** Trader and Hunter are one alliance (the law), the Thief the other (§2.1). */
export function jobSide(job: JobId): JobSide {
  return job === 'thief' ? 'outlaw' : 'law'
}

export const JOB_MAX_LEVEL = 7

/** Player-facing names (§2.3: the Hunter job keeps "Bounty Hunter"; one string to make it retail's "Hunter"). */
export const JOB_NAMES: Readonly<Record<JobId, string>> = { trader: 'Trader', hunter: 'Bounty Hunter', thief: 'Thief' }

/**
 * The job-level names 1-7 (§3.2). The Hunter's are today's Bounty Hunter ranks 0-5 (Recruit … Bounty Captain, the rename
 * of 755e8ef) shifted by one, plus level 7.
 */
export const JOB_LEVEL_NAMES: Readonly<Record<JobId, readonly string[]>> = {
  trader: ['Peddler', 'Hawker', 'Merchant', 'Caravaneer', 'Trade Master', 'Merchant Prince', 'Silk Lord'],
  hunter: ['Recruit', 'Tracker', 'Bloodhound', 'Manhunter', 'Bounty Sergeant', 'Bounty Captain', 'Warden of the Roads'],
  thief: ['Pickpocket', 'Cutpurse', 'Footpad', 'Highwayman', 'Brigand', 'Bandit Chief', 'King of the Road'],
}

export function jobLevelName(job: JobId, level: number): string {
  const names = JOB_LEVEL_NAMES[job]
  return names[Math.min(names.length, Math.max(1, Math.floor(level))) - 1]!
}

// ---- content codes -------------------------------------------------------------------------------------------------------

export const JOB_CODES = {
  /** Specialty Trader Jodaesan in the town market (retail NPC): the Trader licence (§2.1), later the market. */
  traderNpc: 'NPC_CH_SPECIAL',
  /** Captain Yun (siege-hunter.ts HUNTER_CODES.yun): the Hunter licence. */
  hunterNpc: 'NPC_SIEGE_CAPTAIN_YUN',
  /** Old Fang the Fence (siege-law.ts LAW_CODES.fence): the Thief licence. */
  thiefNpc: 'NPC_SIEGE_OLD_FANG',
  /** Specialty Trader Seopok, the Bandit Den (retail NPC in the Bandit's Mountain Stronghold). */
  denNpc: 'NPC_CH_SPECIAL2',
  denScroll: 'ITEM_ETC_SCROLL_RETURN_THIEFDEN_01',
  /** The goods bag on the ground (retail drop model of the trade goods). */
  bagModel: 'res/item/etc/drop_trade.bsr',
} as const

/** The NPC dialog services of the licences (protocol NpcService; the Hunter's is siege-hunter.ts `hunter`). */
export const JOB_SERVICE: Readonly<Record<JobId, 'trader' | 'hunter' | 'thief'>> = { trader: 'trader', hunter: 'hunter', thief: 'thief' }
/** NPC code -> the job it licenses. */
export const JOB_LICENCE_NPC: Readonly<Record<JobId, string>> = { trader: JOB_CODES.traderNpc, hunter: JOB_CODES.hunterNpc, thief: JOB_CODES.thiefNpc }

// ---- suits (§3.3) ----------------------------------------------------------------------------------------------------------

export type SuitTier = 1 | 2 | 3

/** The suit tier of a job level: I at 1-2, II at 3-5, III at 6-7. */
export function suitTier(level: number): SuitTier {
  return level >= 6 ? 3 : level >= 3 ? 2 : 1
}

/**
 * The retail suit item of a job, tier and body [confirmed itemdata: the man's rows are ITEM_CH_M_TRADE_<JOB>_*, the
 * woman's basic and premium ITEM_CH_F_TRADE_<JOB>_02 / _03 and her simple clothes ITEM_CH_W_TRADE_<JOB>_04_01]: tier I
 * the basic `_02` (White flag, Identity card, Black suit), tier II the simple clothes `_04_01` (the Thief has none: `_02`),
 * tier III the premium `_03` (Red flag, Special Identity card, Black devil suit). The `_04` / `_05` rows are retail stat
 * variants of `_02`'s model and are not used (no stat suits, §3.3).
 */
export function jobSuitCode(job: JobId, tier: SuitTier, body: 'm' | 'f'): string {
  const J = job.toUpperCase()
  if (tier === 2 && job !== 'thief') return `ITEM_CH_${body === 'm' ? 'M' : 'W'}_TRADE_${J}_04_01`
  return `ITEM_CH_${body === 'm' ? 'M' : 'F'}_TRADE_${J}_${tier === 3 ? '03' : '02'}`
}

/** Every suit item a body may wear (the export's list). */
export function jobSuitCodes(): string[] {
  const out: string[] = []
  for (const job of JOB_IDS) for (const tier of [1, 2, 3] as const) for (const body of ['m', 'f'] as const) out.push(jobSuitCode(job, tier, body))
  return [...new Set(out)]
}

// ---- the island's trade map (§5) ---------------------------------------------------------------------------------------------

export type TradePointId = 'jangan' | 'south-beach' | 'tomb-camp' | 'ferry-landing' | 'sea-cliffs'
export const TRADE_POINT_IDS: readonly TradePointId[] = ['jangan', 'south-beach', 'tomb-camp', 'ferry-landing', 'sea-cliffs']

export interface TradeGood {
  /** The retail item (ITEM_ETC_TRADE_CH_0N / WC_0N). */
  code: string
  name: string
  /** Where it is bought. */
  origin: TradePointId
  /** Base price per crate (gold). */
  base: number
}

export interface TradePost {
  id: TradePointId
  name: string
  /** The post's trader (an authored NPC; Jangan's is the retail Jodaesan). */
  npc: { code: string; name: string; base: string; greeting: string }
  /** The NPC's spot (glTF m; the places row `place`). */
  x: number
  z: number
  yaw: number
  /** content/places.json row (GM teleports). */
  place: string
  /** Road danger 0-5 (the margin's danger term). */
  danger: number
}

export interface TransportDef {
  tier: 1 | 2 | 3 | 4
  /** characterdata COS row (cos.json). */
  cos: string
  /** The summon scroll (items.json). */
  item: string
  name: string
  /** The job level that may summon it. */
  jobLevel: number
  hold: number
  hp: number
  speed: number
  /** The scroll's price at the trader (single use). */
  price: number
}

export interface JobsContent {
  schema: 1
  kind: 'jobs'
  goods: TradeGood[]
  posts: TradePost[]
  den: { npc: string; place: string; x: number; z: number }
  transports: TransportDef[]
}

/** content/jobs/jobs.json as built in (the server reads the file when CONTENT_DIR has it; the two must agree). */
export const JOBS_CONTENT: Readonly<JobsContent> = Object.freeze({
  schema: 1,
  kind: 'jobs',
  goods: [
    { code: 'ITEM_ETC_TRADE_CH_01', name: 'White Silk', origin: 'jangan', base: 800 },
    { code: 'ITEM_ETC_TRADE_CH_02', name: 'Red Silk', origin: 'jangan', base: 1000 },
    { code: 'ITEM_ETC_TRADE_CH_03', name: 'Blue Celadon Vase', origin: 'jangan', base: 1500 },
    { code: 'ITEM_ETC_TRADE_CH_04', name: 'Wolju Celadon Vase', origin: 'jangan', base: 1900 },
    { code: 'ITEM_ETC_TRADE_CH_05', name: 'Tiger Eye Stone', origin: 'jangan', base: 2400 },
    { code: 'ITEM_ETC_TRADE_CH_06', name: 'Poplar Tree', origin: 'jangan', base: 600 },
    { code: 'ITEM_ETC_TRADE_CH_07', name: 'High Class Tiger Leather', origin: 'jangan', base: 3000 },
    { code: 'ITEM_ETC_TRADE_WC_05', name: 'Brown Pearl', origin: 'south-beach', base: 2000 },
    { code: 'ITEM_ETC_TRADE_WC_01', name: 'Leather', origin: 'ferry-landing', base: 700 },
    { code: 'ITEM_ETC_TRADE_WC_02', name: 'Footstall', origin: 'ferry-landing', base: 900 },
    { code: 'ITEM_ETC_TRADE_WC_03', name: 'Saddle', origin: 'ferry-landing', base: 1400 },
    { code: 'ITEM_ETC_TRADE_WC_04', name: 'Horseshoe', origin: 'ferry-landing', base: 1100 },
    { code: 'ITEM_ETC_TRADE_WC_06', name: 'Silver Bar', origin: 'sea-cliffs', base: 2600 },
    { code: 'ITEM_ETC_TRADE_WC_07', name: 'Gold Bar', origin: 'sea-cliffs', base: 4000 },
  ],
  posts: [
    {
      id: 'jangan',
      name: 'Jangan',
      npc: { code: 'NPC_CH_SPECIAL', name: 'Specialty Trader Jodaesan', base: 'NPC_CH_SPECIAL', greeting: '' },
      x: 176,
      z: -48,
      yaw: -1.571,
      place: 'jangan',
      danger: 0,
    },
    {
      id: 'south-beach',
      name: 'South Beach',
      npc: {
        code: 'NPC_JOB_POST_HAEUN',
        name: 'Pearl Diver Haeun',
        base: 'NPC_CH_SPECIAL',
        greeting: 'Pearls from the shallows, salt from the sea. Bring me Jangan silk and I will pay you better than the market does.',
      },
      x: 470,
      z: 1240,
      yaw: Math.atan2(0, -1),
      place: 'trade-south-beach',
      danger: 1,
    },
    {
      id: 'tomb-camp',
      name: 'Tomb Camp',
      npc: {
        code: 'NPC_JOB_POST_GONG',
        name: 'Quartermaster Gong',
        base: 'NPC_CH_SOLDIER_SO1',
        greeting: 'The diggers at the tomb eat, drink and wear out their boots. Whatever you haul up the road, the camp buys.',
      },
      x: 840,
      z: -990,
      yaw: Math.atan2(-1, 0),
      place: 'trade-tomb-camp',
      danger: 2,
    },
    {
      id: 'ferry-landing',
      name: 'Ferry Landing',
      npc: {
        code: 'NPC_JOB_POST_WOL',
        name: 'Ferry Master Wol',
        base: 'NPC_CH_FERRY',
        greeting: 'No boats cross any more, but the landing still trades. Leather and saddlery from the old Western stock, for Jangan goods.',
      },
      x: -2249,
      z: 338.9,
      yaw: Math.atan2(1, 0),
      place: 'trade-ferry-landing',
      danger: 4,
    },
    {
      id: 'sea-cliffs',
      name: 'Sea Cliffs',
      npc: {
        code: 'NPC_JOB_POST_MOK',
        name: 'Salvager Mok',
        base: 'NPC_CH_FERRY2',
        greeting: 'The sea gives back what it takes: silver, gold, the odd crate. Haul your goods up here alive and I pay the best price on the island.',
      },
      x: -2030,
      z: 990,
      yaw: Math.atan2(1, 0),
      place: 'trade-sea-cliffs',
      danger: 5,
    },
  ],
  den: { npc: 'NPC_CH_SPECIAL2', place: 'bandit-den', x: -1495, z: 808 },
  transports: [
    { tier: 1, cos: 'COS_T_DONKEY', item: 'ITEM_COS_T_DONKEY', name: 'Donkey', jobLevel: 1, hold: 30, hp: 2500, speed: 4.0, price: 2000 },
    { tier: 2, cos: 'COS_T_HORSE1', item: 'ITEM_COS_T_HORSE1', name: 'Horse', jobLevel: 3, hold: 60, hp: 3800, speed: 4.5, price: 5000 },
    { tier: 3, cos: 'COS_T_HORSE2', item: 'ITEM_COS_T_HORSE2', name: 'Thoroughbred', jobLevel: 5, hold: 90, hp: 5000, speed: 4.8, price: 9000 },
    { tier: 4, cos: 'COS_T_DHORSE1', item: 'ITEM_COS_T_DHORSE1', name: 'Ironclad Trade Horse', jobLevel: 7, hold: 120, hp: 7000, speed: 4.5, price: 14000 },
  ],
} satisfies JobsContent)

/** Whether `code` is a trade transport's COS (mounts.ts refuses them as horses; layer 3 summons them). */
export function isTransportCos(code: string): boolean {
  return /^COS_T_/.test(code)
}

/** Problems of a jobs.json value (unknown kinds, codes, posts, numbers). */
export function checkJobsContent(v: unknown): string[] {
  const out: string[] = []
  const o = v as Partial<JobsContent> | null
  if (!o || typeof o !== 'object') return ['jobs content must be an object']
  if (o.schema !== 1 || o.kind !== 'jobs') out.push('schema 1, kind "jobs" expected')
  const pos = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0
  const coord = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100_000
  const posts = Array.isArray(o.posts) ? o.posts : []
  if (!Array.isArray(o.posts) || posts.length === 0) out.push('posts: expected a list')
  const ids = new Set<string>()
  for (const [i, p] of posts.entries()) {
    if (!p || !TRADE_POINT_IDS.includes(p.id)) out.push(`posts[${i}]: id must be one of ${TRADE_POINT_IDS.join(', ')}`)
    else if (ids.has(p.id)) out.push(`posts[${i}]: duplicate id ${p.id}`)
    else ids.add(p.id)
    if (!p?.npc || typeof p.npc.code !== 'string' || !/^NPC_[A-Z0-9_]+$/.test(p.npc.code) || typeof p.npc.name !== 'string' || typeof p.npc.base !== 'string') out.push(`posts[${i}]: npc {code, name, base} expected`)
    if (!coord(p?.x) || !coord(p?.z) || !coord(p?.yaw)) out.push(`posts[${i}]: x, z, yaw expected`)
    if (typeof p?.danger !== 'number' || p.danger < 0 || p.danger > 5) out.push(`posts[${i}]: danger 0-5 expected`)
    if (typeof p?.place !== 'string' || !p.place) out.push(`posts[${i}]: place expected`)
  }
  if (!ids.has('jangan')) out.push('posts: Jangan is missing')
  const goods = Array.isArray(o.goods) ? o.goods : []
  if (!Array.isArray(o.goods) || goods.length === 0) out.push('goods: expected a list')
  const codes = new Set<string>()
  for (const [i, g] of goods.entries()) {
    if (!g || typeof g.code !== 'string' || !/^ITEM_ETC_TRADE_(CH|WC)_0[1-7]$/.test(g.code)) out.push(`goods[${i}]: code must be a retail trade good`)
    else if (codes.has(g.code)) out.push(`goods[${i}]: duplicate ${g.code}`)
    else codes.add(g.code)
    if (!g || !ids.has(g.origin)) out.push(`goods[${i}]: origin must be a post`)
    if (!pos(g?.base)) out.push(`goods[${i}]: base > 0 expected`)
  }
  const tr = Array.isArray(o.transports) ? o.transports : []
  if (tr.length !== 4) out.push('transports: four tiers expected')
  for (const [i, t] of tr.entries()) {
    if (!t || t.tier !== i + 1) out.push(`transports[${i}]: tier ${i + 1} expected`)
    if (!t || !isTransportCos(t.cos) || typeof t.item !== 'string' || !/^ITEM_COS_T_/.test(t.item)) out.push(`transports[${i}]: cos COS_T_* and item ITEM_COS_T_* expected`)
    for (const k of ['jobLevel', 'hold', 'hp', 'speed', 'price'] as const) if (!pos(t?.[k])) out.push(`transports[${i}]: ${k} > 0 expected`)
    if (t && (t.jobLevel < 1 || t.jobLevel > JOB_MAX_LEVEL)) out.push(`transports[${i}]: jobLevel 1-${JOB_MAX_LEVEL}`)
  }
  if (!o.den || typeof o.den.npc !== 'string' || !coord(o.den.x) || !coord(o.den.z)) out.push('den: {npc, place, x, z} expected')
  return out
}

/** The post NPCs as NpcDefs (Jangan's Jodaesan is exported, not authored). */
export function jobPostNpcs(c: Pick<JobsContent, 'posts'>, world: string): { npc: NpcDef; base: string }[] {
  return c.posts
    .filter((p) => p.id !== 'jangan')
    .map((p) => ({
      base: p.npc.base,
      npc: { code: p.npc.code, name: p.npc.name, x: p.x, z: p.z, yaw: p.yaw, world, roles: [], model: null, provenance: 'authored', greeting: p.npc.greeting },
    }))
}

/**
 * Installs the jobs' authored NPCs (the four post traders) into content tables (server GameData, client ContentTables).
 * Existing rows are never replaced.
 */
export function installJobsContent(t: { npcs: NpcDef[] | Map<string, NpcDef> }, world: string, c: Pick<JobsContent, 'posts'> = JOBS_CONTENT): { npcs: number } {
  let n = 0
  for (const { npc } of jobPostNpcs(c, world)) {
    if (Array.isArray(t.npcs)) {
      if (t.npcs.some((x) => x.code === npc.code)) continue
      t.npcs.push(npc)
    } else {
      if (t.npcs.has(npc.code)) continue
      t.npcs.set(npc.code, npc)
    }
    n++
  }
  return { npcs: n }
}

// ---- settings (§9.1) -------------------------------------------------------------------------------------------------------

export interface JobSettings {
  jobs: {
    /** The job system on this server (off: no joining, no job mode, no job PvP; the Bounty Hunters keep working). */
    enabled: boolean
    minLevel: number
    /** The Trader and Thief licences (the Hunter's is the siege's `hunter.licenceGold`). */
    licenceGold: number
    leaveWaitDays: number
    sideChangeDays: number
    /** Job EXP to reach levels 1-7 (levels[0] = 0). */
    levels: number[]
  }
  mode: {
    /** Job mode off is refused this long after a PvP hit (Traders and Thieves; Hunters: `hunter.offDutyLockMin`). */
    offLockMin: number
    /** The safe rings of the trade posts and the den (m). */
    safeRingM: number
    /** A Thief puts the suit on within this of Old Fang or the den (m). */
    thiefDressM: number
  }
  trade: {
    taxPct: number
    buyCapPerHour: number
    /** Load value (bought price) for 2-5 stars. */
    starThresholds: number[]
    /** The highest stars per job level 1-7. */
    maxStars: number[]
    marginBase: number
    marginKm: number
    marginDanger: number
    newsDemand: number
  }
  drift: { sellImpact: number; buyImpact: number; floor: number; cap: number; recoverPerHour: number; accountDayMax: number }
  thief: { dropPct: number; denPct: number; bagLifeMin: number; pingSec: number; pingR: number; pingMinStars: number }
  /**
   * `hunterMul`: an on-duty Bounty Hunter's hits on a robber (an open robbery warrant) × this instead of `hunter.pvpMul`
   * (the subdue in ≈ 20-40 s at the same level; §6.4, the balance in "Polish status").
   */
  robbery: { warrantOnlineMin: number; sentencesMin: number[]; forgiveDays: number; recoveryPct: number; pairWindowH: number; hunterMul: number }
  exp: {
    traderProfitDiv: number
    /** × per stars 1-5. */
    traderStarMul: number[]
    hunterEscortPct: number
    hunterThiefKill: number
    hunterWallCapture: number
    thiefDenDiv: number
    thiefTransportKill: number
  }
  storm: { tornadoScatterPct: number; snowSpeedPct: number }
  /**
   * Layer 7 (§8): the weekly Silk Caravan, off by default. For `durationMin` from a slot one far post pays demand ×
   * `demand`, Trader sales give job EXP × `expMul`, escorts × `escortMul`, ambushes × `ambushMul`, the den pays ×
   * `denMul`, and each completed run (a profitable sale away from where the load was bought) pays `rewardGold`, at most
   * `rewardRuns` per character per event. Never during a siege or a Night of the Tiger: a slot waits `busyWaitMin`,
   * then it is skipped.
   */
  event: {
    enabled: boolean
    durationMin: number
    /** Weekly slots (weekday 0 = Sunday, time HH:MM in `tz`; '' = the server's zone). */
    slots: { weekday: number; time: string }[]
    tz: string
    demand: number
    expMul: number
    escortMul: number
    ambushMul: number
    denMul: number
    rewardGold: number
    rewardRuns: number
    busyWaitMin: number
  }
  /** Layer 3 (§5.4, §6.3, §7): the trade transports. */
  transport: {
    /** It follows its Trader's trail within this (m); farther it walks straight at the Trader. */
    leashM: number
    /** Farther than this from its Trader it stops and waits (m). */
    waitM: number
    /** A loaded transport stays in the world this long after its Trader logs out (s), then is saved. */
    lingerS: number
    /** After its Trader died it stays this long (a target), then drops its goods (s). */
    ownerDeathS: number
    /** It is summoned, loaded and unloaded within this of a trade post's trader (m). */
    ringM: number
    /** It keeps this far behind its Trader (m). */
    gapM: number
    /**
     * Its physical and magical defence against players (Thieves' attacks and skills), per tier 1-4 (Donkey, Horse,
     * Thoroughbred, Ironclad Trade Horse: the armoured one). Monsters keep the fixed defence (TRANSPORT_COMBAT).
     */
    thiefDefence: number[]
    /** A Thief's damage on a transport × this (instead of `hunter.pvpMul`). */
    thiefMul: number
  }
  /** Layer 3 (§6.2): bandit ambushes on the road by the load's stars. */
  ambush: {
    /** Expected groups per stars 1-5 (the integer part always, the fraction by chance). */
    perStar: number[]
    groupMin: number
    groupMax: number
    /** Where on the straight road (percent of the distance to the declared destination). */
    fromPct: number
    toPct: number
    /** They spawn this far off the road (m). */
    offRoadM: number
    /** Past this distance from Jangan the far bands' rosters are used (km). */
    farKm: number
    /** Unkilled ambushers leave after this (min). */
    lifeMin: number
  }
}

export const JOB_SETTINGS_DEFAULTS: Readonly<JobSettings> = Object.freeze({
  jobs: { enabled: true, minLevel: 15, licenceGold: 10_000, leaveWaitDays: 3, sideChangeDays: 7, levels: [0, 2000, 6000, 15_000, 35_000, 70_000, 130_000] },
  mode: { offLockMin: 2, safeRingM: 12, thiefDressM: 20 },
  trade: { taxPct: 3, buyCapPerHour: 300, starThresholds: [25_000, 60_000, 120_000, 200_000], maxStars: [2, 2, 3, 3, 4, 5, 5], marginBase: 0.02, marginKm: 0.02, marginDanger: 0.035, newsDemand: 1.2 },
  drift: { sellImpact: 0.002, buyImpact: 0.001, floor: 0.7, cap: 1.3, recoverPerHour: 0.03, accountDayMax: 0.3 },
  thief: { dropPct: 60, denPct: 60, bagLifeMin: 5, pingSec: 60, pingR: 120, pingMinStars: 3 },
  robbery: { warrantOnlineMin: 30, sentencesMin: [15, 30, 60, 120], forgiveDays: 7, recoveryPct: 25, pairWindowH: 24, hunterMul: 3 },
  exp: { traderProfitDiv: 10, traderStarMul: [1, 1.1, 1.2, 1.35, 1.5], hunterEscortPct: 40, hunterThiefKill: 300, hunterWallCapture: 2000, thiefDenDiv: 8, thiefTransportKill: 200 },
  storm: { tornadoScatterPct: 20, snowSpeedPct: -10 },
  event: { enabled: false, durationMin: 60, slots: [{ weekday: 6, time: '20:00' }], tz: '', demand: 1.4, expMul: 1.25, escortMul: 1.5, ambushMul: 1.5, denMul: 1.2, rewardGold: 5000, rewardRuns: 3, busyWaitMin: 30 },
  transport: { leashM: 25, waitM: 60, lingerS: 60, ownerDeathS: 30, ringM: 20, gapM: 3, thiefDefence: [15, 15, 20, 45], thiefMul: 0.5 },
  ambush: { perStar: [0, 0.5, 1, 1.5, 2.5], groupMin: 3, groupMax: 5, fromPct: 30, toPct: 80, offRoadM: 30, farKm: 1.6, lifeMin: 5 },
} satisfies JobSettings)

export type JobSettingsPatch = { [G in keyof JobSettings]?: Partial<JobSettings[G]> }

/** Inclusive bounds of every number ('group.field'). */
export const JOB_SETTINGS_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  'jobs.minLevel': [1, 200],
  'jobs.licenceGold': [0, 100_000_000],
  'jobs.leaveWaitDays': [0, 90],
  'jobs.sideChangeDays': [0, 365],
  'mode.offLockMin': [0, 60],
  'mode.safeRingM': [0, 60],
  'mode.thiefDressM': [2, 100],
  'trade.taxPct': [0, 50],
  'trade.buyCapPerHour': [0, 100_000],
  'trade.marginBase': [0, 1],
  'trade.marginKm': [0, 1],
  'trade.marginDanger': [0, 1],
  'trade.newsDemand': [1, 3],
  'drift.sellImpact': [0, 0.1],
  'drift.buyImpact': [0, 0.1],
  'drift.floor': [0.1, 1],
  'drift.cap': [1, 5],
  'drift.recoverPerHour': [0, 1],
  'drift.accountDayMax': [0, 1],
  'thief.dropPct': [0, 100],
  'thief.denPct': [0, 100],
  'thief.bagLifeMin': [1, 60],
  'thief.pingSec': [5, 600],
  'thief.pingR': [10, 500],
  'thief.pingMinStars': [1, 5],
  'robbery.warrantOnlineMin': [1, 600],
  'robbery.forgiveDays': [1, 365],
  'robbery.recoveryPct': [0, 100],
  'robbery.pairWindowH': [0, 720],
  'robbery.hunterMul': [0, 20],
  'exp.traderProfitDiv': [1, 1000],
  'exp.hunterEscortPct': [0, 100],
  'exp.hunterThiefKill': [0, 1_000_000],
  'exp.hunterWallCapture': [0, 1_000_000],
  'exp.thiefDenDiv': [1, 1000],
  'exp.thiefTransportKill': [0, 1_000_000],
  'storm.tornadoScatterPct': [0, 100],
  'storm.snowSpeedPct': [-90, 0],
  'event.durationMin': [5, 600],
  'event.demand': [1, 3],
  'event.expMul': [1, 5],
  'event.escortMul': [1, 5],
  'event.ambushMul': [0, 5],
  'event.denMul': [0.5, 3],
  'event.rewardGold': [0, 1_000_000],
  'event.rewardRuns': [0, 50],
  'event.busyWaitMin': [0, 180],
  'transport.leashM': [2, 200],
  'transport.waitM': [5, 500],
  'transport.lingerS': [0, 3600],
  'transport.ownerDeathS': [0, 3600],
  'transport.ringM': [2, 100],
  'transport.gapM': [0.5, 20],
  'transport.thiefMul': [0, 10],
  'ambush.groupMin': [1, 20],
  'ambush.groupMax': [1, 20],
  'ambush.fromPct': [0, 100],
  'ambush.toPct': [0, 100],
  'ambush.offRoadM': [0, 200],
  'ambush.farKm': [0, 10],
  'ambush.lifeMin': [1, 120],
}

/** Number lists ('group.field' -> length, element bounds, non-decreasing). */
export const JOB_SETTINGS_LISTS: Readonly<Record<string, { length: number; min: number; max: number; rising: boolean }>> = {
  'jobs.levels': { length: JOB_MAX_LEVEL, min: 0, max: 100_000_000, rising: true },
  'trade.starThresholds': { length: 4, min: 1, max: 100_000_000, rising: true },
  'trade.maxStars': { length: JOB_MAX_LEVEL, min: 1, max: 5, rising: true },
  'robbery.sentencesMin': { length: 4, min: 0, max: 24 * 60, rising: true },
  'exp.traderStarMul': { length: 5, min: 0, max: 10, rising: true },
  'ambush.perStar': { length: 5, min: 0, max: 10, rising: true },
  'transport.thiefDefence': { length: 4, min: 0, max: 1000, rising: false },
}

export const JOB_SETTINGS_FLAGS: readonly string[] = ['jobs.enabled', 'event.enabled']

/** The Silk Caravan's schedule (§8): slots and a time zone, checked apart from the numbers. */
export const JOB_SETTINGS_SCHEDULE: readonly string[] = ['event.slots', 'event.tz']
const JOB_SLOT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export const JOB_SETTING_PATHS: readonly string[] = [...JOB_SETTINGS_FLAGS, ...JOB_SETTINGS_SCHEDULE, ...Object.keys(JOB_SETTINGS_BOUNDS), ...Object.keys(JOB_SETTINGS_LISTS)]

/** Problems of a sparse patch: unknown keys, wrong types, numbers out of bounds, bad lists. */
export function checkJobSettings(v: unknown): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = []
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [{ path: '', message: 'settings must be an object' }]
  for (const [g, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!JOB_SETTING_PATHS.some((p) => p.startsWith(`${g}.`))) {
      out.push({ path: g, message: 'unknown setting' })
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out.push({ path: g, message: 'expected an object' })
      continue
    }
    for (const [k, x] of Object.entries(raw as Record<string, unknown>)) {
      const path = `${g}.${k}`
      if (JOB_SETTINGS_FLAGS.includes(path)) {
        if (typeof x !== 'boolean') out.push({ path, message: 'expected true or false' })
        continue
      }
      if (path === 'event.tz') {
        if (typeof x !== 'string' || x.length > 64 || !/^[A-Za-z0-9_+\-/]*$/.test(x)) out.push({ path, message: "expected a time zone name ('' = the server's)" })
        continue
      }
      if (path === 'event.slots') {
        if (!Array.isArray(x) || x.length > 7) {
          out.push({ path, message: 'expected up to 7 slots' })
          continue
        }
        x.forEach((sl, i) => {
          const o = sl as { weekday?: unknown; time?: unknown } | null
          if (!o || typeof o !== 'object' || !Number.isInteger(o.weekday) || (o.weekday as number) < 0 || (o.weekday as number) > 6 || typeof o.time !== 'string' || !JOB_SLOT_TIME.test(o.time)) {
            out.push({ path: `${path}[${i}]`, message: 'a slot is {weekday 0-6, time HH:MM}' })
          }
        })
        continue
      }
      const list = JOB_SETTINGS_LISTS[path]
      if (list) {
        const ok =
          Array.isArray(x) &&
          x.length === list.length &&
          x.every((n, i) => typeof n === 'number' && Number.isFinite(n) && n >= list.min && n <= list.max && (!list.rising || i === 0 || n >= (x[i - 1] as number)))
        if (!ok) out.push({ path, message: `expected ${list.length} numbers in ${list.min}..${list.max}${list.rising ? ', never falling' : ''}` })
        else if (path === 'jobs.levels' && x[0] !== 0) out.push({ path, message: 'level 1 starts at 0 EXP' })
        continue
      }
      const b = JOB_SETTINGS_BOUNDS[path]
      if (!b) {
        out.push({ path, message: 'unknown setting' })
        continue
      }
      if (typeof x !== 'number' || !Number.isFinite(x) || x < b[0] || x > b[1]) out.push({ path, message: `expected a number in ${b[0]}..${b[1]}` })
    }
  }
  return out
}

/** defaults ⊕ patch (a checked patch; unknown keys ignored). */
export function mergeJobSettings(defaults: Readonly<JobSettings>, patch: JobSettingsPatch = {}): JobSettings {
  const s = structuredClone(defaults) as JobSettings
  for (const g of Object.keys(s) as (keyof JobSettings)[]) {
    const grp = (patch as Record<string, unknown>)[g]
    if (!grp || typeof grp !== 'object') continue
    for (const [k, x] of Object.entries(grp as Record<string, unknown>)) if (k in s[g]) (s[g] as unknown as Record<string, unknown>)[k] = structuredClone(x)
  }
  return s
}

/** `delta` laid over `base` (both sparse). */
export function mergeJobPatch(base: JobSettingsPatch, delta: JobSettingsPatch): JobSettingsPatch {
  const out = structuredClone(base) as Record<string, object>
  for (const [g, v] of Object.entries(delta)) if (v && typeof v === 'object') out[g] = { ...(out[g] ?? {}), ...structuredClone(v) }
  return out as JobSettingsPatch
}

/** The patch without what equals the defaults (and without empty groups). */
export function pruneJobPatch(patch: JobSettingsPatch, defaults: Readonly<JobSettings>): JobSettingsPatch {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [g, v] of Object.entries(patch)) {
    const d = (defaults as unknown as Record<string, Record<string, unknown>>)[g]
    if (!d || !v || typeof v !== 'object') continue
    const grp: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (JSON.stringify(x) !== JSON.stringify(d[k])) grp[k] = x
    if (Object.keys(grp).length) out[g] = grp
  }
  return out as JobSettingsPatch
}

/** The patch with `paths` ('group.field', or a whole group) removed. */
export function unsetJobPaths(patch: JobSettingsPatch, paths: readonly string[]): JobSettingsPatch {
  const out = structuredClone(patch) as Record<string, Record<string, unknown>>
  for (const path of paths) {
    const [g, k] = path.split('.') as [string, string | undefined]
    if (k === undefined) delete out[g]
    else if (out[g]) {
      delete out[g][k]
      if (Object.keys(out[g]).length === 0) delete out[g]
    }
  }
  return out as JobSettingsPatch
}

// ---- job levels and EXP (§3) ----------------------------------------------------------------------------------------------------

/** The job level (1-7) of `exp` job EXP. */
export function jobLevelOf(exp: number, levels: readonly number[]): number {
  let lv = 1
  for (let i = 1; i < Math.min(levels.length, JOB_MAX_LEVEL); i++) if (exp >= levels[i]!) lv = i + 1
  return lv
}

/** The job EXP a level starts at. */
export function jobLevelExp(level: number, levels: readonly number[]): number {
  const i = Math.min(JOB_MAX_LEVEL, Math.max(1, Math.floor(level))) - 1
  return levels[i] ?? 0
}

/** The EXP the next level starts at (null at the top). */
export function jobNextExp(level: number, levels: readonly number[]): number | null {
  return level >= JOB_MAX_LEVEL ? null : (levels[level] ?? null)
}

/**
 * Today's Bounty Hunter → the Hunter job (§2.3): rank r (0-5, by captures) becomes job level r + 1 with the EXP of that
 * level's threshold. Ranks are exactly the job level − 1 from then on (2,000 job EXP per wall capture: ranks 1 and 2 at
 * 1 and 3 captures as before, ranks 3-5 sooner, at 8, 18, 35 instead of 10, 25, 60).
 */
export function hunterRankToJob(rank: number, levels: readonly number[]): { level: number; exp: number } {
  const level = Math.min(JOB_MAX_LEVEL, Math.max(0, Math.floor(rank)) + 1)
  return { level, exp: jobLevelExp(level, levels) }
}

/** The Hunter badge's rank (EntityState.hunter) of a job level. */
export function hunterRankOfLevel(level: number): number {
  return Math.max(0, Math.min(JOB_MAX_LEVEL, level) - 1)
}

/** The stars of a load of this bought value (1-5). */
export function tradeStars(value: number, thresholds: readonly number[]): number {
  let s = 1
  for (const t of thresholds) if (value >= t) s++
  return Math.min(5, s)
}

/** The highest stars a job level may buy. */
export function maxStarsAt(level: number, maxStars: readonly number[]): number {
  return maxStars[Math.min(JOB_MAX_LEVEL, Math.max(1, level)) - 1] ?? 1
}

/** A Trader's job EXP of a sale (profit ÷ div × the stars' multiplier; nothing without a profit). */
export function traderSaleExp(profit: number, stars: number, e: Pick<JobSettings['exp'], 'traderProfitDiv' | 'traderStarMul'>): number {
  if (!(profit > 0)) return 0
  return Math.floor((profit / e.traderProfitDiv) * (e.traderStarMul[Math.min(5, Math.max(1, stars)) - 1] ?? 1))
}

/** An escorting Hunter's share of the Trader's job EXP. */
export function hunterEscortExp(traderExp: number, e: Pick<JobSettings['exp'], 'hunterEscortPct'>): number {
  return Math.floor((Math.max(0, traderExp) * e.hunterEscortPct) / 100)
}

/** A Thief in job mode killed or captured by a Hunter (a robbery capture × 2). */
export function hunterThiefExp(thiefLevel: number, robbery: boolean, e: Pick<JobSettings['exp'], 'hunterThiefKill'>): number {
  return e.hunterThiefKill * Math.max(1, Math.floor(thiefLevel)) * (robbery ? 2 : 1)
}

export function thiefDenExp(payout: number, e: Pick<JobSettings['exp'], 'thiefDenDiv'>): number {
  return Math.floor(Math.max(0, payout) / e.thiefDenDiv)
}

export function thiefTransportExp(stars: number, e: Pick<JobSettings['exp'], 'thiefTransportKill'>): number {
  return e.thiefTransportKill * Math.min(5, Math.max(1, Math.floor(stars)))
}

// ---- trade rules (§5.1, §5.2, §6.4) -------------------------------------------------------------------------------------------

/** The straight distance between two trade points (km). */
export function tradeKm(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z) / 1000
}

/** The margin between two trade points: base + km × marginKm + the road's danger (the higher end) × marginDanger. */
export function tradeMargin(a: Pick<TradePost, 'x' | 'z' | 'danger'>, b: Pick<TradePost, 'x' | 'z' | 'danger'>, t: Pick<JobSettings['trade'], 'marginBase' | 'marginKm' | 'marginDanger'>): number {
  if (a.x === b.x && a.z === b.z) return 0
  return t.marginBase + tradeKm(a, b) * t.marginKm + Math.max(a.danger, b.danger) * t.marginDanger
}

/**
 * A crate's sell price: base × (1 + margin) × demand × (1 − tax). Selling where it was bought pays base × buy_mul × 0.9
 * (§5.2; the caller passes margin = null).
 */
export function tradeSellPrice(base: number, margin: number | null, demand: number, taxPct: number, buyMul = 1): number {
  if (margin === null) return Math.floor(base * buyMul * 0.9)
  return Math.floor(base * (1 + margin) * demand * (1 - taxPct / 100))
}

/** A post's demand after `crates` sold there (−sellImpact each, floor). */
export function demandAfterSell(demand: number, crates: number, d: Pick<JobSettings['drift'], 'sellImpact' | 'floor'>): number {
  return Math.max(d.floor, demand - d.sellImpact * Math.max(0, crates))
}

/** A source's buy multiplier after `crates` bought (+buyImpact each, cap). */
export function buyMulAfterBuy(mul: number, crates: number, d: Pick<JobSettings['drift'], 'buyImpact' | 'cap'>): number {
  return Math.min(d.cap, mul + d.buyImpact * Math.max(0, crates))
}

/** A drifted value after `hours`: back toward 1.00 by recoverPerHour per hour. */
export function driftRecover(v: number, hours: number, d: Pick<JobSettings['drift'], 'recoverPerHour'>): number {
  const step = d.recoverPerHour * Math.max(0, hours)
  return v < 1 ? Math.min(1, v + step) : Math.max(1, v - step)
}

/** The den's payout for stolen crates: denPct of the base price (no margin, no drift). */
export function denPayout(base: number, crates: number, denPct: number): number {
  return Math.floor((base * Math.max(0, crates) * denPct) / 100)
}

// ---- robbery and the law (layer 4: §6.1, §6.4, §7) ---------------------------------------------------------------------------

/** A Thief in the suit senses loaded transports this far (m, §6.1). */
export const CARAVAN_SENSE_M = 400
/** A caravan ping's centre lies within this of the transport (m). */
export const CARAVAN_PING_OFFSET_M = 60
/** A Thief of this job level gets the tighter caravan circle (§3.2: "transport ping 160 m" → 80 m circles at 120 default). */
export const CARAVAN_SHARP_LEVEL = 5

/** The caravan ping's radius for a Thief of `level` (§6.1: level 5 shrinks it to two thirds). */
export function caravanPingR(level: number, pingR: number): number {
  return level >= CARAVAN_SHARP_LEVEL ? Math.round((pingR * 2) / 3) : pingR
}

/**
 * The pair rule (§7): what the den pays for a robbery of the same Trader account by the same Thief account after `prior`
 * earlier robberies (distinct ones) within `robbery.pairWindowH`: the first in full, then × (1 − repeatPct %) each, and
 * nothing (no job EXP either) from the `repeatMax`-th on (the siege's `law.repeatPct` / `law.repeatMax`).
 */
export function robberyPairMul(prior: number, repeatPct: number, repeatMax: number): number {
  const n = Math.max(0, Math.floor(prior))
  if (n === 0) return 1
  if (n + 1 >= Math.max(1, repeatMax)) return 0
  return (1 - Math.min(100, Math.max(0, repeatPct)) / 100) ** n
}

/** The robbery ladder (§6.4): the sentence of the account's robbery level (1 = the first; past the list: its last), ms. */
export function robberySentenceMs(level: number, sentencesMin: readonly number[]): number {
  if (sentencesMin.length === 0) return 0
  const i = Math.min(sentencesMin.length, Math.max(1, Math.floor(level))) - 1
  return Math.round(sentencesMin[i]! * 60_000)
}

/** The Hunters' recovery reward (§6.4): `recoveryPct` % of the den value. */
export function recoveryReward(denValue: number, recoveryPct: number): number {
  return Math.floor((Math.max(0, denValue) * Math.max(0, recoveryPct)) / 100)
}

/** The crates a dead transport drops (dropPct, rounded down per good). */
export function droppedCrates(crates: number, dropPct: number): number {
  return Math.floor((Math.max(0, crates) * dropPct) / 100)
}

// ---- the market and the hold (layers 2-3: §5.2-§5.4, §6.2, §6.3) -----------------------------------------------------------

/** One good in a transport's hold: crates and what they cost (gold, all of them). */
export interface HoldEntry {
  good: string
  crates: number
  cost: number
}

/** Crates in a hold. */
export function holdCrates(hold: readonly HoldEntry[]): number {
  return hold.reduce((n, e) => n + e.crates, 0)
}

/** The load's value (what the goods cost: the stars' measure, §5.3). */
export function holdValue(hold: readonly HoldEntry[]): number {
  return hold.reduce((n, e) => n + e.cost, 0)
}

/** A hold with `crates` of `good` added at `cost` (merged per good). */
export function holdAdd(hold: readonly HoldEntry[], good: string, crates: number, cost: number): HoldEntry[] {
  const out = hold.map((e) => ({ ...e }))
  const e = out.find((x) => x.good === good)
  if (e) {
    e.crates += crates
    e.cost += cost
  } else if (crates > 0) out.push({ good, crates, cost })
  return out
}

/**
 * Takes `crates` of `good` out of a hold: the cost leaves in proportion (rounded; the last crate takes the rest). Returns
 * the new hold and the cost of what was taken.
 */
export function holdTake(hold: readonly HoldEntry[], good: string, crates: number): { hold: HoldEntry[]; cost: number; crates: number } {
  const out = hold.map((e) => ({ ...e }))
  const i = out.findIndex((x) => x.good === good)
  if (i < 0 || crates <= 0) return { hold: out, cost: 0, crates: 0 }
  const e = out[i]!
  const n = Math.min(e.crates, Math.floor(crates))
  const cost = n >= e.crates ? e.cost : Math.round((e.cost * n) / e.crates)
  e.crates -= n
  e.cost -= cost
  if (e.crates <= 0) out.splice(i, 1)
  return { hold: out, cost, crates: n }
}

/**
 * What falls from a hold (§6.3, §6.5): `pct` of each good's crates (rounded down per good) with their share of the cost.
 * `kept` is the rest (a dead transport's are destroyed; a tornado's stay in the hold).
 */
export function holdSpill(hold: readonly HoldEntry[], pct: number): { spilled: HoldEntry[]; kept: HoldEntry[] } {
  let kept = hold.map((e) => ({ ...e }))
  const spilled: HoldEntry[] = []
  for (const e of hold) {
    const n = droppedCrates(e.crates, pct)
    if (n <= 0) continue
    const t = holdTake(kept, e.good, n)
    kept = t.hold
    spilled.push({ good: e.good, crates: t.crates, cost: t.cost })
  }
  return { spilled, kept }
}

/** A source's price of one crate now (base × its buy multiplier). */
export function tradeBuyPrice(base: number, buyMul: number): number {
  return Math.max(1, Math.round(base * buyMul))
}

/** The gold of buying `crates` one by one from buy multiplier `mul` (each crate raises it, §5.2), and the multiplier after. */
export function tradeBuyTotal(base: number, mul: number, crates: number, d: Pick<JobSettings['drift'], 'buyImpact' | 'cap'>): { gold: number; mul: number } {
  let gold = 0
  let m = mul
  for (let i = 0; i < crates; i++) {
    gold += tradeBuyPrice(base, m)
    m = buyMulAfterBuy(m, 1, d)
  }
  return { gold, mul: m }
}

/**
 * The gold of selling `crates` one by one at a post (each crate lowers the demand, §5.2) and the demand after. `room`
 * is how much more this account may move the demand today (`drift.accountDayMax`): past it the demand stays.
 * `bonus` multiplies the demand the price reads (the day's market news), not the stored demand.
 */
export function tradeSellTotal(
  base: number,
  margin: number,
  demand: number,
  crates: number,
  s: { taxPct: number; drift: Pick<JobSettings['drift'], 'sellImpact' | 'floor'> },
  room = Infinity,
  bonus = 1,
): { gold: number; demand: number; moved: number } {
  let gold = 0
  let d = demand
  let moved = 0
  for (let i = 0; i < crates; i++) {
    gold += tradeSellPrice(base, margin, d * bonus, s.taxPct)
    const next = demandAfterSell(d, 1, s.drift)
    const step = Math.min(d - next, Math.max(0, room - moved))
    d -= step
    moved += step
  }
  return { gold, demand: d, moved }
}

/** The ambush groups of a run of `stars` (§5.3, §6.2): the integer part of perStar always, the fraction by chance. */
export function ambushCount(stars: number, perStar: readonly number[], rng: () => number): number {
  const e = perStar[Math.min(5, Math.max(1, Math.floor(stars))) - 1] ?? 0
  const whole = Math.floor(e)
  return whole + (rng() < e - whole ? 1 : 0)
}

/** Where on the road the ambushes wait: fractions of the distance between fromPct and toPct, rising. */
export function ambushPoints(n: number, a: Pick<JobSettings['ambush'], 'fromPct' | 'toPct'>, rng: () => number): number[] {
  const lo = Math.min(a.fromPct, a.toPct) / 100
  const hi = Math.max(a.fromPct, a.toPct) / 100
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(lo + (hi - lo) * rng())
  return out.sort((x, y) => x - y)
}

/**
 * The bandits of an ambush by the road's danger (§6.2), best first: the B5 Bandits and Bandit Archers near Jangan, the B7
 * or B8 rows past `ambush.farKm` (the Climb's monsters, with their roles; the retail Bandits where the Climb is off).
 */
export function ambushRoster(far: boolean, danger: number): string[] {
  const near = ['MOB_CL_BANDIT_16', 'MOB_CL_BOWMAN_15', 'MOB_CL_BANDITSUB_15', 'MOB_CL_ARCHER_18']
  const b7 = ['MOB_CL_HYUNGNO_23', 'MOB_CL_CHAKJI_20', 'MOB_CL_CHAKJIWORKER_19']
  const b8 = ['MOB_CL_EARTHGHOST_25', 'MOB_CL_POWDER_24', 'MOB_CL_HYUNGNOSHAMAN_24']
  const retail = ['MOB_CH_BANDIT', 'MOB_CH_BANDITARCHER']
  if (!far) return [...near, ...retail]
  return [...(danger >= 5 ? b8 : b7), ...near, ...retail]
}

/** The transport tier a job level may summon at most (§3.2). */
export function transportTierAt(level: number, transports: readonly Pick<TransportDef, 'tier' | 'jobLevel'>[]): number {
  let t = 0
  for (const d of transports) if (level >= d.jobLevel && d.tier > t) t = d.tier
  return t
}

// ---- joining (§2.1) ---------------------------------------------------------------------------------------------------------------

export type JoinRefusal = 'disabled' | 'level' | 'has_job' | 'wanted' | 'jailed' | 'wrong_side' | 'side_wait' | 'leave_wait'

export interface JoinInput {
  job: JobId
  level: number
  /** The character's job now (null: none). */
  current: JobId | null
  wanted: boolean
  jailed: boolean
  /** The account's side (null: never chose). */
  accountSide: JobSide | null
  /** When the account's side last changed (ms). */
  sideChangedAt: number | null
  /** When a character of the account last left a job (ms). */
  leftAt: number | null
  /** Jobs held by the account's other characters. */
  otherJobs: readonly JobId[]
  now: number
}

const DAY = 86_400_000

/**
 * Why a character may not join `job` (null: may). One job per character; one side per account: joining on the other
 * side is refused while any other character of the account holds a job of the old side, and within `sideChangeDays`
 * of the last change; a `leaveWaitDays` wait after any of the account's characters left a job.
 */
export function joinRefusal(i: JoinInput, s: Pick<JobSettings['jobs'], 'enabled' | 'minLevel' | 'leaveWaitDays' | 'sideChangeDays'>, minLevel = s.minLevel): JoinRefusal | null {
  if (!s.enabled) return 'disabled'
  if (i.current !== null) return 'has_job'
  if (i.level < minLevel) return 'level'
  if (i.wanted) return 'wanted'
  if (i.jailed) return 'jailed'
  const side = jobSide(i.job)
  if (i.otherJobs.some((j) => jobSide(j) !== side)) return 'wrong_side'
  if (i.accountSide !== null && i.accountSide !== side && i.sideChangedAt !== null && i.now - i.sideChangedAt < s.sideChangeDays * DAY) return 'side_wait'
  if (i.leftAt !== null && i.now - i.leftAt < s.leaveWaitDays * DAY) return 'leave_wait'
  return null
}

// ---- PvP (§4) ---------------------------------------------------------------------------------------------------------------------

/** The job rows of `pvpAllowed` (siege-hunter.ts): both in job mode, on opposite sides, neither in a job-safe place. */
export function jobPvp(a: { job?: JobId | null; jobMode?: boolean; inJobSafe?: boolean }, b: { job?: JobId | null; jobMode?: boolean; inJobSafe?: boolean }): boolean {
  if (!a.job || !b.job || !a.jobMode || !b.jobMode || a.inJobSafe || b.inJobSafe) return false
  return jobSide(a.job) !== jobSide(b.job)
}

// ---- protocol (§9.4; additive) ----------------------------------------------------------------------------------------------------

/** EntityState.job / entityUpdate.job: a player in job mode (the label line, the suit tier = suitTier(level)). */
export interface JobBadge {
  job: JobId
  level: number
}

/** A character's own job (`jobState`). */
export interface JobView {
  /** null: no job. */
  job: JobId | null
  level: number
  exp: number
  /** EXP the next level starts at (absent at 7 or without a job). */
  next?: number
  mode: boolean
  /** The account's side (null: none chosen). */
  side: JobSide | null
  /** Job mode off is refused until then (ms epoch; after a PvP hit). */
  lockUntil?: number
  /** No joining before then (ms epoch; after a character of the account left a job). */
  joinAfter?: number
}

/** One good at a trade point (`market`): its price to buy here (its source only) and to sell here now. */
export interface MarketRow {
  good: string
  name: string
  origin: TradePointId
  /** Gold per crate to buy here (absent: not sold here). */
  buy?: number
  /** Gold per crate for the next crate sold here (from a load bought at the origin). */
  sell: number
  /** The post's demand for it now (1 = normal; the price drifts with supply, §5.2). */
  demand: number
  /** The source's buy multiplier now (1 = normal; present where it is bought). */
  buyMul?: number
  /** Today's market news: this good sells here at `trade.newsDemand`. */
  news?: true
}

/** The own trade transport (`transportState`, §9.4). */
export interface TransportView {
  id: number
  tier: number
  name: string
  hp: number
  maxHp: number
  /** Crates it carries at most. */
  capacity: number
  hold: HoldEntry[]
  stars: number
  /** The declared destination (where the ambushes wait), null before the first purchase. */
  dest: TradePointId | null
  /** Where the load was bought. */
  from: TradePointId | null
  /** The Trader rides it. */
  ridden: boolean
  /** Told to stay where it stands (`transportFollow {on: false}`); absent or false: it follows. */
  staying?: boolean
}

/** Goods on the ground (`bag`): a dead transport's, a tornado's (§6.3, §6.5). Sent to job-mode players and the owner. */
export interface TradeBag {
  id: number
  x: number
  z: number
  good: string
  crates: number
  /** The owning Trader's character name. */
  owner: string
  expiresAt: number
}

/**
 * Layer 4 (§6.3, §6.4): goods a character carries outside a transport. `stolen`: a Thief's (bound; sold only at the den,
 * confiscated at a capture); `recovered`: a Bounty Hunter's (turned in to Captain Yun); `own`: a Trader's own crates picked
 * up without a transport (sold by him only at a trade point). Never in the bag: no trade, stall, storage or drop.
 */
export type SackKind = 'stolen' | 'recovered' | 'own'
export const SACK_KINDS: readonly SackKind[] = ['stolen', 'recovered', 'own']

/** One line of the own sack (`jobSack`). */
export interface SackEntryView {
  kind: SackKind
  good: string
  crates: number
  /** The robbed (owning) Trader's name. */
  owner: string
  /** Gold it is worth now: the den's payout (stolen), Yun's reward (recovered), what it cost (own). */
  value: number
}

/** The NPC dialog service of Specialty Trader Seopok at the Bandit Den (protocol NpcService). */
export const DEN_SERVICE = 'den'

export type JobServerMessage =
  | ({ t: 'jobState' } & JobView)
  /** Layer 4: the own sack (after every change and at enter-world when not empty; empty list = nothing carried). */
  | { t: 'jobSack'; entries: SackEntryView[] }
  /**
   * Layer 4 (§6.1): to a Thief in the suit every `thief.pingSec`: a loaded transport `id` of `stars` is somewhere in the
   * circle (x, z, r); the centre lies within CARAVAN_PING_OFFSET_M of it.
   */
  | { t: 'caravanPing'; id: number; x: number; z: number; r: number; stars: number; at: number }
  /** A trade point's market (the answer to `tradeMarket`, and after a purchase or a sale there). */
  | { t: 'market'; post: TradePointId; rows: MarketRow[] }
  /** The own transport (null: none). */
  | { t: 'transportState'; transport: TransportView | null }
  | ({ t: 'bag' } & TradeBag)
  | { t: 'bagGone'; id: number }

export type JobClientMessage =
  /** Take the licence of `job` at its NPC (entity `npc`): Jodaesan the Trader's, Yun the Hunter's, Old Fang the Thief's. */
  | { t: 'jobJoin'; npc: number; job: JobId }
  /** Leave the job at its NPC. */
  | { t: 'jobLeave'; npc: number }
  /** The suit on (job mode) or off; `hunterDuty` is its alias for Hunters. */
  | { t: 'jobMode'; on: boolean }
  /** Layer 2: the market of a trade point's trader (entity `npc`: Jodaesan or a post's trader). */
  | { t: 'tradeMarket'; npc: number }
  /** Layer 3: summon a transport of `tier` at a trade point (its price in gold: the single-use summon). */
  | { t: 'tradeSummon'; npc: number; tier: number }
  /** Layer 2: buy `crates` of `good` into the own transport, declaring the destination `dest`. */
  | { t: 'tradeBuy'; npc: number; good: string; crates: number; dest: TradePointId }
  /** Layer 2: sell from the own transport (every good when `good` is absent; all its crates when `crates` is). */
  | { t: 'tradeSell'; npc: number; good?: string; crates?: number }
  /** Layer 3: ride the own transport (at its walk speed) or step down. */
  | { t: 'transportRide'; on: boolean }
  /** Layer 3: send the own (empty) transport away. */
  | { t: 'transportDismiss' }
  /** The own transport follows its Trader again (`on`) or stays where it stands (`!on`). */
  | { t: 'transportFollow'; on: boolean }
  /** Layer 3: pick up a goods bag (the owner and his party: back into the transport). */
  | { t: 'bagPick'; id: number }
  /** Layer 4: sell every stolen crate to Specialty Trader Seopok at the Bandit Den (NPC entity `npc`, his `den` service). */
  | { t: 'denSell'; npc: number }
  /** Layer 4: buy `count` Bandit Den Return Scrolls from Seopok (Thieves of job level 3 and up). */
  | { t: 'denBuy'; npc: number; count: number }
  /** Layer 4: turn the recovered goods in to Captain Yun (NPC entity `npc`) for the recovery reward. */
  | { t: 'yunTurnIn'; npc: number }
export type JobRequest = JobClientMessage['t']
export const JOB_REQUESTS: readonly JobRequest[] = [
  'jobJoin', 'jobLeave', 'jobMode', 'tradeMarket', 'tradeSummon', 'tradeBuy', 'tradeSell', 'transportRide', 'transportDismiss', 'bagPick',
  'denSell', 'denBuy', 'yunTurnIn', 'transportFollow',
]
export const JOB_RATE_LIMITS: Readonly<Record<JobRequest, { perSecond: number; burst: number }>> = {
  jobJoin: { perSecond: 1, burst: 3 },
  jobLeave: { perSecond: 1, burst: 3 },
  jobMode: { perSecond: 1, burst: 3 },
  tradeMarket: { perSecond: 2, burst: 4 },
  tradeSummon: { perSecond: 1, burst: 2 },
  tradeBuy: { perSecond: 3, burst: 6 },
  tradeSell: { perSecond: 3, burst: 6 },
  transportRide: { perSecond: 1, burst: 3 },
  transportDismiss: { perSecond: 1, burst: 2 },
  transportFollow: { perSecond: 2, burst: 4 },
  bagPick: { perSecond: 4, burst: 8 },
  denSell: { perSecond: 1, burst: 3 },
  denBuy: { perSecond: 1, burst: 3 },
  yunTurnIn: { perSecond: 1, burst: 3 },
}

/**
 * Why a trade request was refused (§9.4): not in the suit, the account's side, the load's stars above the job level's
 * cap, the hold full, refused while loaded (return scrolls, the suit off, dismissing), the per-account buy cap.
 */
export type JobFailReason = 'not_job_mode' | 'wrong_side' | 'stars_cap' | 'hold_full' | 'loaded' | 'buy_cap'
export const JOB_FAIL_REASONS: readonly JobFailReason[] = ['not_job_mode', 'wrong_side', 'stars_cap', 'hold_full', 'loaded', 'buy_cap']

/** Wire limits (validate.ts). */
export const JOB_LIMITS = { level: JOB_MAX_LEVEL, exp: 1_000_000_000, crates: 1000, gold: 1_000_000_000, tier: 4, stars: 5, goods: 32, scrolls: 50, pingR: 1000 } as const

/** A trade good's code on the wire. */
export const TRADE_GOOD_CODE = /^ITEM_ETC_TRADE_(CH|WC)_0[1-7]$/

// ---- admin (§9.5) ------------------------------------------------------------------------------------------------------------------

/** GET /api/admin/jobs. */
export interface AdminJobsView {
  enabled: boolean
  members: { characterId: number; name: string; job: JobId; level: number; exp: number; mode: boolean; online: boolean; revokedUntil: number | null }[]
  /** Members per job. */
  counts: Record<JobId, number>
  accounts: { accountId: number; side: JobSide; sideChangedAt: number; leftAt: number | null }[]
  settings: { defaults: JobSettings; effective: JobSettings; patch: JobSettingsPatch; rev: number; bounds: Record<string, readonly [number, number]> }
  content: { posts: { id: TradePointId; name: string; npc: string; x: number; z: number; danger: number }[]; goods: number; transports: string[]; source: string }
  /** Layer 2: every post's demand and every source's buy multiplier now; today's news. */
  market?: { rows: { post: TradePointId; good: string; demand: number; buyMul: number }[]; news: { post: TradePointId; good: string } | null }
  /** Layer 3: the transports in the world (and saved ones of offline Traders). */
  transports?: { characterId: number; name: string; tier: number; hp: number; maxHp: number; crates: number; value: number; stars: number; dest: TradePointId | null; x: number; z: number; live: boolean }[]
  /** Layer 4: goods carried outside transports (stolen, recovered, own), per character and good. */
  sacks?: { characterId: number; name: string; kind: SackKind; good: string; crates: number; owner: string; value: number }[]
  /** Layer 7: per member, the account and its side, the character level (the admin's filters). */
  memberInfo?: { characterId: number; accountId: number; account: string; side: JobSide | null; charLevel: number }[]
  /** Layer 7: the latest trade_log rows, newest first. */
  trades?: { id: number; at: number; name: string; kind: string; post: string | null; good: string | null; crates: number; gold: number; stars: number }[]
  /** Layer 7: the latest robbery_log rows (picks from robbed goods, Hunters' kills of Thieves), newest first. */
  robberies?: { id: number; at: number; kind: string; actor: string; actorAccount: number | null; victim: string; victimAccount: number | null; batch: number }[]
  /** Layer 7: open robbery warrants. */
  robbers?: { warrant: number; characterId: number; name: string; bounty: number; issuedAt: number; onlineLeftMs: number; online: boolean }[]
  /** Layer 7: withheld job rewards (law_flags of the job rules, §7), newest first. */
  flags?: { id: number; at: number; rule: string; actor: string; actorId: number; actorAccount: number | null; victim: string; victimId: number; victimAccount: number; withheld: number }[]
  /** Layer 7: the Silk Caravan (§8). */
  event?: CaravanView
}

/** Law flags written by the job system (§7), listed on the admin's Jobs & Trade page. */
export const JOB_FLAG_RULES: readonly string[] = ['robbery_pair', 'robbery_contact', 'recovery_contact', 'thief_kill_pair', 'escort_same_ip']

/** The Silk Caravan now (§8; GET /api/admin/jobs `event`, GM `caravan status`). */
export interface CaravanView {
  enabled: boolean
  running: { id: number; startedAt: number; endsAt: number; post: TradePointId; origin: CaravanOrigin; runs: number; rewarded: number } | null
  /** The next scheduled slot (ms), null when off or without slots. */
  nextAt: number | null
  /** A due slot waiting for a siege or a Night of the Tiger to end, until (ms). */
  waitUntil: number | null
  /** The zone the slots are read in. */
  zone: string
  /** The posts the event may boost (the far ones). */
  posts: TradePointId[]
  history: CaravanLogEntry[]
}

export type CaravanOrigin = 'schedule' | 'gm' | 'admin'

export interface CaravanLogEntry {
  id: number
  at: number
  endedAt: number | null
  post: TradePointId | null
  origin: CaravanOrigin
  outcome: 'running' | 'ended' | 'stopped' | 'interrupted' | 'skipped' | 'restart'
  runs: number
  rewarded: number
  why?: string
}
