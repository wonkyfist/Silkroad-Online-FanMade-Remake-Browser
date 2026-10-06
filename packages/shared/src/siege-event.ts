/**
 * Siege of Jangan, layer 4: the siege event (docs/SIEGE.md §4.3, §6, §10, §11). The pure rules, the authored content
 * and the protocol the server, the client and the admin panel share.
 *
 * - **Phases**: idle → `warning` (10 min) → `wave1` → `wave2` → `wave3` (the Bandit Warlord) → `ended`. A wave starts
 *   at its time (`waveGapMin` after the last) or when 80 % of the siege mobs alive at the last wave's start are dead.
 *   Outcomes: `won` (the Warlord killed), `lost_bell` (the Town Bell destroyed), `lost_time` (`durationMin` after wave
 *   1 with the Warlord alive), `cancelled` (GM / admin), `restart` (a wave phase found at boot).
 * - **Lanes** (content/siege/jangan.json `siege`): per approach (W road, S fields, E road, N fields) a muster ≥ 350 m
 *   out and, per target segment, the outer legs to a staging point in front of it and the inner legs from the gap's
 *   rally point to the Town Bell. Monsters walk the straight legs (no pathfinding); the server checks every leg against
 *   the nav at start and drops a lane whose leg is blocked (`checkSiegeLanes` for the shape, siege/lanes.ts for the nav).
 * - **Wards**: during a siege the three gates are warded against siege monsters (`wardLines`, `clipWalk`): a siege
 *   mob's walk that crosses the gate's line stops there. Players pass.
 * - **Scaling**: s = clamp(N / scaleDiv, 1, scaleCap)^scaleExp with N the defenders (level ≥ 10 within 600 m of the
 *   town); raiders, archers and sappers × s; rams and the Warlord do not multiply; the Warlord's HP × s^0.9.
 * - **Rewards**: contribution points (damage to siege mobs, sappers stopped, kegs defused, kit repairs, donations, Bell
 *   repairs); won: gold, Siege Seals, the "Defender of Jangan" title to the top 3 and to anyone ≥ 300 points; lost: a
 *   quarter of the gold. Under `minPoints` nothing.
 */
import type { DropTable, ItemDef, MobDef } from './content.ts'
import type { Vec3 } from './protocol.ts'
import { WALL_SEGMENT_ID, type WallsExport, type WallsSideInfo } from './siege.ts'
import { SIEGE_ICONS } from './siege-repair.ts'

// ---- phases, roles, views ----------------------------------------------------------------------------------------------

export type SiegePhase = 'warning' | 'wave1' | 'wave2' | 'wave3' | 'ended'
export const SIEGE_PHASES: readonly SiegePhase[] = ['warning', 'wave1', 'wave2', 'wave3', 'ended']
export type SiegeOutcome = 'won' | 'lost_bell' | 'lost_time' | 'cancelled' | 'restart'
export const SIEGE_OUTCOMES: readonly SiegeOutcome[] = ['won', 'lost_bell', 'lost_time', 'cancelled', 'restart']
export type SiegeApproach = 'W' | 'S' | 'E' | 'N'
export const SIEGE_APPROACHES: readonly SiegeApproach[] = ['W', 'S', 'E', 'N']
/** What a siege mob is (EntityState.siege): the client hangs a keg on a sapper, draws the Bell, flags the army. */
export type SiegeRole = 'raider' | 'archer' | 'sapper' | 'ram' | 'warlord' | 'bell'
export const SIEGE_ROLES: readonly SiegeRole[] = ['raider', 'archer', 'sapper', 'ram', 'warlord', 'bell']

/** The wave a phase is (0 = the warning or the end). */
export function waveOf(phase: SiegePhase): 0 | 1 | 2 | 3 {
  return phase === 'wave1' ? 1 : phase === 'wave2' ? 2 : phase === 'wave3' ? 3 : 0
}

/** The event as every player sees it (`siegeEvent`, docs/SIEGE.md §10.2). */
export interface SiegeView {
  id: number
  phase: SiegePhase
  /** The warning: when wave 1 comes; a wave: when the next one comes (absent in wave 3). Server ms. */
  nextAt?: number
  /** From wave 1: the deadline (`lost_time` with the Warlord alive). */
  endsAt?: number
  approaches: SiegeApproach[]
  /** Town Bell HP, % (one decimal); absent before the Bell stands. */
  bellPct?: number
  /** Defenders counted at the last wave start (N of the scaling). */
  defenders?: number
  /** The Warlord's HP, % (wave 3, while he lives). */
  warlordPct?: number
  /** Siege monsters alive now. */
  foes?: number
  /** Segments breached during this siege. */
  breaches?: number
  outcome?: SiegeOutcome
}

/** One line of the result: a defender and their points. */
export interface SiegeTopLine {
  name: string
  points: number
}

/** A defender's result (`siegeReward`, sent to everyone who earned points, at the end). */
export interface SiegeRewardView {
  event: number
  outcome: SiegeOutcome
  points: number
  /** 1-based place among the defenders; 0 = under `minPoints` (nothing paid). */
  rank: number
  of: number
  gold: number
  seals: number
  /** A title granted now (`jangan_defender`). */
  title?: string
  top: SiegeTopLine[]
  /** What the points came from. */
  parts: Partial<Record<SiegeContribKind, number>>
}

export type SiegeNoticeEvent = 'phase' | 'breach' | 'plant' | 'defused' | 'blast'
export const SIEGE_NOTICE_EVENTS: readonly SiegeNoticeEvent[] = ['phase', 'breach', 'plant', 'defused', 'blast']

/** Server -> client (protocol v1, additive; docs/SIEGE.md §10.2). An older client ignores them. */
export type SiegeServerMessage =
  /** The event, to every world player on a change (phase, bell, foes: at most once a second) and on enter-world. */
  | { t: 'siegeEvent'; view: SiegeView }
  /**
   * A moment to announce (world players): `phase` with the phase (and the outcome when ended), `breach` / `plant` /
   * `defused` / `blast` with the wall segment; `name` = the defender who defused.
   */
  | { t: 'siegeNotice'; event: SiegeNoticeEvent; phase?: SiegePhase; outcome?: SiegeOutcome; wall?: string; name?: string; approaches?: SiegeApproach[] }
  /** The defender's own result, at the end. */
  | { t: 'siegeReward'; reward: SiegeRewardView }
  /**
   * A keg at the foot of the wall (a sapper's; layer 5 adds the players'), to every world player: a burning fuse until
   * `fuseEndsAt`. `defuse`: a defender is defusing it (who, until when).
   */
  | { t: 'keg'; id: number; seg: string; x: number; y: number; z: number; fuseEndsAt: number; sapper?: true; defuse?: { by: number; endsAt: number } }
  /** The keg is gone: it blew, was defused, or the siege ended. */
  | { t: 'kegEnd'; id: number; how: 'blast' | 'defused' | 'cancelled' }

/** Client -> server (GameplayRequests, one actionResult each). */
export type SiegeClientMessage =
  /** Defuse keg `id`: a 3 s channel within 3 m; moving or taking damage stops it. */
  { t: 'kegDefuse'; id: number }
export type SiegeRequest = SiegeClientMessage['t']
export const SIEGE_REQUESTS: readonly SiegeRequest[] = ['kegDefuse']
export const SIEGE_RATE_LIMITS: Readonly<Record<SiegeRequest, { perSecond: number; burst: number }>> = {
  kegDefuse: { perSecond: 2, burst: 4 },
}

/** Wire limits (validate.ts). */
export const SIEGE_LIMITS = { top: 10, coord: 1_000_000, maxPoints: 1_000_000_000 } as const

/** The title of a won siege (EntityState.honor; client i18n `pilot.honor.jangan_defender`). */
export const SIEGE_HONOR = 'jangan_defender'

// ---- content -------------------------------------------------------------------------------------------------------------

export const SIEGE_EVENT_CODES = {
  raider: 'MOB_CH_BANDIT',
  raiderBeast: 'MOB_CH_TIGER',
  archer: 'MOB_CH_BANDITARCHER',
  sapper: 'MOB_SIEGE_SAPPER',
  ram: 'MOB_SIEGE_STONE_RAM',
  warlord: 'MOB_SIEGE_WARLORD',
  bell: 'MOB_SIEGE_TOWN_BELL',
  seal: 'ITEM_SIEGE_SEAL',
} as const

/** Authored siege monsters, each made from a retail one (its model, skills) with the numbers changed. */
export interface SiegeMobSpec {
  code: string
  base: string
  name: string
  rarity: MobDef['rarity']
  /** Multiplies the base's HP (the Warlord's own HP comes from the settings at spawn). */
  hpMul: number
  speedMul: number
  /** % of the base model's size. */
  scale: number
}

export const SIEGE_MOBS: readonly SiegeMobSpec[] = [
  // a Bandit with a keg on his back: weaker and slower than his brothers
  { code: SIEGE_EVENT_CODES.sapper, base: 'MOB_CH_BANDIT', name: 'Bandit Sapper', rarity: 'normal', hpMul: 0.6, speedMul: 0.8, scale: 100 },
  // a Stone Ghost giant driven against the stone
  { code: SIEGE_EVENT_CODES.ram, base: 'MOB_CH_STONEGHOST', name: 'Stone Ram', rarity: 'normal', hpMul: 1.5, speedMul: 1, scale: 100 },
  // the Bandit Warlord: not a world unique (no timer), only the siege spawns him
  { code: SIEGE_EVENT_CODES.warlord, base: 'MOB_CH_BANDIT', name: 'Bandit Warlord', rarity: 'unique', hpMul: 1, speedMul: 1, scale: 160 },
]

/** The MobDef of a siege monster: the base's model and skills with the spec's changes. */
export function deriveSiegeMob(spec: SiegeMobSpec, base: MobDef | undefined): MobDef {
  const b = base
  const def: MobDef = {
    code: spec.code,
    id: 0,
    name: spec.name,
    typeId: b?.typeId ?? [1, 2, 1, 1],
    rarity: spec.rarity,
    level: b?.level ?? 16,
    hp: Math.max(1, Math.round((b?.hp ?? 700) * spec.hpMul)),
    mp: 0,
    physAttack: b ? [...b.physAttack] : [100, 120],
    magAttack: b ? [...b.magAttack] : [0, 0],
    physDefence: b?.physDefence ?? 40,
    magDefence: b?.magDefence ?? 40,
    physAbsorb: b?.physAbsorb ?? 5,
    magAbsorb: b?.magAbsorb ?? 5,
    hitRate: b?.hitRate ?? 50,
    parryRate: b?.parryRate ?? 30,
    blockRate: 0,
    critRate: 2,
    attackRange: b?.attackRange ?? 0.6,
    attackIntervalMs: b?.attackIntervalMs ?? 1800,
    radius: (b?.radius ?? 0.6) * (spec.scale / 100),
    walkSpeed: (b?.walkSpeed ?? 1.5) * spec.speedMul,
    runSpeed: (b?.runSpeed ?? 5.5) * spec.speedMul,
    aggressive: true,
    exp: b?.exp ?? 100,
    scale: Math.round((b?.scale ?? 100) * (spec.scale / 100)),
    model: b?.model ? { ...b.model } : null,
    fieldSources: { model: `siege: ${spec.base}`, stats: 'authored (docs/SIEGE.md §6.5)' },
  }
  if (b?.skills) def.skills = [...b.skills]
  if (b?.variants) def.variants = [...b.variants]
  return def
}

/** The Town Bell: a structure the army attacks (no model of its own: the client draws it). */
export function townBellMob(hp: number): MobDef {
  return {
    code: SIEGE_EVENT_CODES.bell,
    id: 0,
    name: 'Town Bell',
    typeId: [1, 2, 1, 1],
    rarity: 'normal',
    level: 1,
    hp,
    mp: 0,
    physAttack: [0, 0],
    magAttack: [0, 0],
    physDefence: 40,
    magDefence: 40,
    physAbsorb: 0,
    magAbsorb: 0,
    hitRate: 0,
    parryRate: 0,
    blockRate: 0,
    critRate: 0,
    attackRange: 0,
    attackIntervalMs: 60_000,
    radius: 1.6,
    walkSpeed: 0,
    runSpeed: 0,
    aggressive: false,
    exp: 0,
    // the client draws the bell in its frame (≈ 5 m); the scale puts its label and pick over it
    scale: 260,
    model: null,
    fieldSources: { all: 'authored (docs/SIEGE.md §6.3: the Town Bell)' },
  }
}

/** The Siege Seal (the reward currency; no retail row). */
export function siegeSealItem(): ItemDef {
  return {
    code: SIEGE_EVENT_CODES.seal,
    id: 0,
    name: 'Siege Seal',
    typeId: [3, 3, 3, 1],
    category: 'etc',
    degree: 0,
    reqLevel: 0,
    reqGender: 'any',
    race: 'any',
    maxStack: 100,
    price: 0,
    sellPrice: 0,
    canSell: false,
    canTrade: false,
    model: null,
    icon: SIEGE_ICONS.seal,
    fieldSources: { all: 'authored (docs/SIEGE.md §6.6)' },
  }
}

/**
 * Installs the siege event's content into content tables (server GameData, client ContentTables): the sapper, the ram,
 * the Warlord, the Town Bell and the Siege Seal. The siege monsters drop nothing (no drop tables). Existing rows are
 * never replaced. Returns how many rows were added.
 */
export function installSiegeEventContent(t: { mobs: Map<string, MobDef>; items: Map<string, ItemDef>; drops?: Map<string, DropTable> }, bellHp = SIEGE_EVENT_DEFAULTS.bell.hp): { mobs: number; items: number } {
  const n = { mobs: 0, items: 0 }
  for (const s of SIEGE_MOBS) {
    if (t.mobs.has(s.code)) continue
    t.mobs.set(s.code, deriveSiegeMob(s, t.mobs.get(s.base)))
    n.mobs++
  }
  if (!t.mobs.has(SIEGE_EVENT_CODES.bell)) {
    t.mobs.set(SIEGE_EVENT_CODES.bell, townBellMob(bellHp))
    n.mobs++
  }
  const seal = siegeSealItem()
  if (!t.items.has(seal.code)) {
    t.items.set(seal.code, seal)
    n.items++
  }
  return n
}

// ---- settings (docs/SIEGE.md §11.2: the siege, army, bell and rewards groups) ------------------------------------------

export interface SiegeSlot {
  /** 0 = Sunday. */
  weekday: number
  /** 'HH:MM' in the schedule's zone. */
  time: string
}

export interface SiegeEventSettings {
  /** The weekly schedule on (GM and admin starts always work). */
  enabled: boolean
  /** Weekly slots: the warning starts at the slot; '' tz = the server's own zone. */
  schedule: { slots: SiegeSlot[]; tz: string }
  timing: {
    warningMin: number
    waveGapMin: number
    /** From wave 1 to `lost_time`. */
    durationMin: number
    /** The next wave comes early once this % of the last wave's monsters are dead. */
    earlyPct: number
    /** A scheduled siege with fewer eligible players online (level ≥ 10) is skipped. */
    minPlayers: number
    /** Approaches per siege (of 4). */
    approaches: number
    /** A scheduled siege that meets a Night of the Tiger waits this long (then once more, then it is skipped). */
    tigerWaitMin: number
  }
  waves: {
    w1Raiders: number
    w1Sappers: number
    w2Raiders: number
    w2Archers: number
    w2Sappers: number
    w2Rams: number
    w3Elite: number
    w3Rams: number
  }
  army: {
    /** March speed (m/s; sappers × 0.8). */
    marchSpeed: number
    raiderIp: number
    ramIp: number
    ramEverySec: number
    sapperIp: number
    warlordIp: number
    warlordHp: number
    scaleDiv: number
    scaleCap: number
    scaleExp: number
    expMul: number
    /** A defender this close to a marching or assaulting monster draws it into a fight (m). */
    engageM: number
    /** How far a monster chases from where it broke off (m). */
    leashM: number
    plantSec: number
    fuseSec: number
    defuseSec: number
    /** No more siege monsters alive than this (the load cap; extra spawns are dropped). */
    maxMobs: number
  }
  bell: {
    hp: number
    /** One repair hit heals this % of the Bell (at most every 2 s per defender). */
    repairPct: number
    /** The ground around the Bell is no longer safe during a wave (m). */
    zoneM: number
  }
  rewards: {
    goldPerPoint: number
    goldCap: number
    pointsPerSeal: number
    sealCap: number
    lossShare: number
    titleTop: number
    titlePoints: number
    minPoints: number
  }
}

export const SIEGE_EVENT_DEFAULTS: Readonly<SiegeEventSettings> = Object.freeze({
  enabled: false,
  schedule: { slots: [{ weekday: 0, time: '20:00' }], tz: '' },
  timing: { warningMin: 10, waveGapMin: 8, durationMin: 35, earlyPct: 80, minPlayers: 5, approaches: 2, tigerWaitMin: 30 },
  waves: { w1Raiders: 12, w1Sappers: 2, w2Raiders: 14, w2Archers: 6, w2Sappers: 3, w2Rams: 2, w3Elite: 10, w3Rams: 2 },
  army: {
    marchSpeed: 3,
    raiderIp: 40,
    ramIp: 300,
    ramEverySec: 3,
    sapperIp: 5000,
    warlordIp: 600,
    warlordHp: 60_000,
    scaleDiv: 5,
    scaleCap: 6,
    scaleExp: 0.8,
    expMul: 0.5,
    engageM: 15,
    leashM: 40,
    plantSec: 8,
    fuseSec: 12,
    defuseSec: 3,
    maxMobs: 220,
  },
  bell: { hp: 30_000, repairPct: 0.5, zoneM: 60 },
  rewards: { goldPerPoint: 50, goldCap: 30_000, pointsPerSeal: 50, sealCap: 10, lossShare: 0.25, titleTop: 3, titlePoints: 300, minPoints: 20 },
}) as SiegeEventSettings

export type SiegeEventPatch = {
  enabled?: boolean
  schedule?: Partial<SiegeEventSettings['schedule']>
} & { [G in Exclude<keyof SiegeEventSettings, 'enabled' | 'schedule'>]?: Partial<SiegeEventSettings[G]> }

/** Inclusive bounds of every number ('group.field'). */
export const SIEGE_EVENT_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  'timing.warningMin': [1, 30],
  'timing.waveGapMin': [3, 30],
  'timing.durationMin': [15, 90],
  'timing.earlyPct': [10, 100],
  'timing.minPlayers': [0, 100],
  'timing.approaches': [1, 4],
  'timing.tigerWaitMin': [5, 120],
  'waves.w1Raiders': [0, 60],
  'waves.w1Sappers': [0, 10],
  'waves.w2Raiders': [0, 60],
  'waves.w2Archers': [0, 30],
  'waves.w2Sappers': [0, 10],
  'waves.w2Rams': [0, 6],
  'waves.w3Elite': [0, 40],
  'waves.w3Rams': [0, 6],
  'army.marchSpeed': [0.5, 8],
  'army.raiderIp': [0, 2000],
  'army.ramIp': [0, 5000],
  'army.ramEverySec': [1, 30],
  'army.sapperIp': [0, 20_000],
  'army.warlordIp': [0, 5000],
  'army.warlordHp': [1000, 2_000_000],
  'army.scaleDiv': [1, 50],
  'army.scaleCap': [1, 20],
  'army.scaleExp': [0, 2],
  'army.expMul': [0, 2],
  'army.engageM': [3, 40],
  'army.leashM': [10, 120],
  'army.plantSec': [1, 60],
  'army.fuseSec': [3, 120],
  'army.defuseSec': [1, 30],
  'army.maxMobs': [20, 600],
  'bell.hp': [1000, 500_000],
  'bell.repairPct': [0, 10],
  'bell.zoneM': [0, 200],
  'rewards.goldPerPoint': [0, 1_000_000],
  'rewards.goldCap': [0, 1_000_000],
  'rewards.pointsPerSeal': [1, 1_000_000],
  'rewards.sealCap': [0, 1_000_000],
  'rewards.lossShare': [0, 1],
  'rewards.titleTop': [0, 100],
  'rewards.titlePoints': [0, 1_000_000],
  'rewards.minPoints': [0, 1_000_000],
}

/** Every editable path: 'enabled', 'schedule.slots', 'schedule.tz' and the numbers. */
export const SIEGE_SETTING_PATHS: readonly string[] = ['enabled', 'schedule.slots', 'schedule.tz', ...Object.keys(SIEGE_EVENT_BOUNDS)]

export interface SiegeSettingsIssue {
  path: string
  message: string
}

const SLOT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Problems of a sparse patch: unknown keys, wrong types, numbers out of bounds, bad slots. */
export function checkSiegeEventSettings(v: unknown): SiegeSettingsIssue[] {
  const out: SiegeSettingsIssue[] = []
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [{ path: '', message: 'settings must be an object' }]
  for (const [g, raw] of Object.entries(v as Record<string, unknown>)) {
    if (g === 'enabled') {
      if (typeof raw !== 'boolean') out.push({ path: 'enabled', message: 'expected true or false' })
      continue
    }
    const known = SIEGE_SETTING_PATHS.some((p) => p.startsWith(`${g}.`))
    if (!known) {
      out.push({ path: g, message: 'unknown setting' })
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out.push({ path: g, message: 'expected an object' })
      continue
    }
    for (const [k, x] of Object.entries(raw as Record<string, unknown>)) {
      const path = `${g}.${k}`
      if (path === 'schedule.tz') {
        if (typeof x !== 'string' || x.length > 64 || !/^[A-Za-z0-9_+\-/]*$/.test(x)) out.push({ path, message: "expected a time zone name ('' = the server's)" })
        continue
      }
      if (path === 'schedule.slots') {
        if (!Array.isArray(x) || x.length > 7) {
          out.push({ path, message: 'expected up to 7 slots' })
          continue
        }
        x.forEach((sl, i) => {
          const s = sl as Partial<SiegeSlot> | null
          if (!s || typeof s !== 'object' || !Number.isInteger(s.weekday) || (s.weekday as number) < 0 || (s.weekday as number) > 6 || typeof s.time !== 'string' || !SLOT_TIME.test(s.time)) {
            out.push({ path: `${path}[${i}]`, message: 'a slot is {weekday 0-6, time HH:MM}' })
          }
        })
        continue
      }
      const b = SIEGE_EVENT_BOUNDS[path]
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
export function mergeSiegeEventSettings(defaults: Readonly<SiegeEventSettings>, patch: SiegeEventPatch = {}): SiegeEventSettings {
  const s = structuredClone(defaults) as SiegeEventSettings
  const p = patch as Record<string, unknown>
  if (typeof p.enabled === 'boolean') s.enabled = p.enabled
  for (const g of Object.keys(s) as (keyof SiegeEventSettings)[]) {
    if (g === 'enabled') continue
    const grp = p[g]
    if (!grp || typeof grp !== 'object') continue
    for (const [k, x] of Object.entries(grp as Record<string, unknown>)) {
      if (k in (s[g] as object)) (s[g] as unknown as Record<string, unknown>)[k] = structuredClone(x)
    }
  }
  return s
}

/** `patch` laid over `base` (both sparse). */
export function mergeSiegePatch(base: SiegeEventPatch, delta: SiegeEventPatch): SiegeEventPatch {
  const out = structuredClone(base) as Record<string, unknown>
  for (const [g, v] of Object.entries(delta as Record<string, unknown>)) {
    if (g === 'enabled') out.enabled = v
    else if (v && typeof v === 'object') out[g] = { ...((out[g] as object) ?? {}), ...structuredClone(v as object) }
  }
  return out as SiegeEventPatch
}

/** The patch without what equals the defaults (and without empty groups). */
export function pruneSiegePatch(patch: SiegeEventPatch, defaults: Readonly<SiegeEventSettings>): SiegeEventPatch {
  const out: Record<string, unknown> = {}
  const p = patch as Record<string, unknown>
  if (typeof p.enabled === 'boolean' && p.enabled !== defaults.enabled) out.enabled = p.enabled
  for (const [g, v] of Object.entries(p)) {
    if (g === 'enabled' || !v || typeof v !== 'object') continue
    const d = (defaults as unknown as Record<string, Record<string, unknown>>)[g]
    if (!d) continue
    const grp: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (JSON.stringify(x) !== JSON.stringify(d[k])) grp[k] = x
    if (Object.keys(grp).length) out[g] = grp
  }
  return out as SiegeEventPatch
}

/** The patch with `paths` ('group.field', or a whole group, or 'enabled') removed. */
export function unsetSiegePaths(patch: SiegeEventPatch, paths: readonly string[]): SiegeEventPatch {
  const out = structuredClone(patch) as Record<string, Record<string, unknown> | boolean>
  for (const path of paths) {
    const [g, k] = path.split('.') as [string, string | undefined]
    if (k === undefined) delete out[g]
    else if (out[g] && typeof out[g] === 'object') {
      delete (out[g] as Record<string, unknown>)[k]
      if (Object.keys(out[g] as object).length === 0) delete out[g]
    }
  }
  return out as SiegeEventPatch
}

// ---- scaling (docs/SIEGE.md §6.4) ---------------------------------------------------------------------------------------

/** s = clamp(N / scaleDiv, 1, scaleCap)^scaleExp. */
export function siegeScale(defenders: number, a: Pick<SiegeEventSettings['army'], 'scaleDiv' | 'scaleCap' | 'scaleExp'>): number {
  const n = Number.isFinite(defenders) ? Math.max(0, defenders) : 0
  return Math.min(Math.max(n / a.scaleDiv, 1), Math.max(1, a.scaleCap)) ** a.scaleExp
}

/** A scaled count (rounded; 0 stays 0). */
export const scaledCount = (n: number, s: number): number => Math.max(0, Math.round(n * s))

/** The Warlord's HP: warlordHp × s^0.9. */
export function warlordHp(s: number, a: Pick<SiegeEventSettings['army'], 'warlordHp'>): number {
  return Math.round(a.warlordHp * s ** 0.9)
}

export interface WaveRoster {
  raiders: number
  archers: number
  sappers: number
  rams: number
  /** Champion raiders (wave 3). */
  elite: number
  /** The Warlord leads this wave (wave 3, one approach). */
  warlord: boolean
}

/** One approach's share of wave `wave` at scale `s` (`lead`: the approach the Warlord takes). */
export function waveRoster(wave: 1 | 2 | 3, s: number, w: SiegeEventSettings['waves'], lead = false): WaveRoster {
  if (wave === 1) return { raiders: scaledCount(w.w1Raiders, s), archers: 0, sappers: scaledCount(w.w1Sappers, s), rams: 0, elite: 0, warlord: false }
  if (wave === 2) return { raiders: scaledCount(w.w2Raiders, s), archers: scaledCount(w.w2Archers, s), sappers: scaledCount(w.w2Sappers, s), rams: w.w2Rams, elite: 0, warlord: false }
  return { raiders: 0, archers: 0, sappers: 0, rams: w.w3Rams, elite: scaledCount(w.w3Elite, s), warlord: lead }
}

/** A defender (N): a living player of level ≥ 10 within 600 m of the town centre. */
export const DEFENDER_MIN_LEVEL = 10
export const DEFENDER_RANGE_M = 600

// ---- contribution and rewards (docs/SIEGE.md §6.6) ------------------------------------------------------------------------

export type SiegeContribKind = 'damage' | 'sapper' | 'defuse' | 'kit' | 'donation' | 'bell'
export const SIEGE_CONTRIB_KINDS: readonly SiegeContribKind[] = ['damage', 'sapper', 'defuse', 'kit', 'donation', 'bell']

/** Points per unit of each contribution. */
export const SIEGE_POINTS = {
  /** per 100 damage to siege monsters */
  damagePer: 100,
  sapper: 20,
  defuse: 30,
  /** per 1 % of a segment repaired with a kit */
  kitPerPct: 10,
  /** per 2,000 gold donated, at most donationCap per siege */
  donationPer: 2000,
  donation: 5,
  donationCap: 50,
  bell: 15,
} as const

export interface SiegeReward {
  gold: number
  seals: number
  title: boolean
}

/**
 * What a defender with `points` earns at `rank` (1-based among everyone with points): won: goldPerPoint × points (≤
 * goldCap), points / pointsPerSeal Seals (≤ sealCap), the title for the top `titleTop` and for anyone ≥ titlePoints;
 * lost (any other outcome but cancelled / restart): lossShare of the gold, nothing else. Under minPoints: nothing.
 */
export function siegeReward(points: number, rank: number, outcome: SiegeOutcome, r: SiegeEventSettings['rewards']): SiegeReward {
  const none = { gold: 0, seals: 0, title: false }
  if (!(points >= r.minPoints) || points <= 0 || outcome === 'cancelled' || outcome === 'restart') return none
  const gold = Math.min(r.goldCap, Math.floor(points * r.goldPerPoint))
  if (outcome !== 'won') return { gold: Math.floor(gold * r.lossShare), seals: 0, title: false }
  return { gold, seals: Math.min(r.sealCap, Math.floor(points / r.pointsPerSeal)), title: (rank >= 1 && rank <= r.titleTop) || points >= r.titlePoints }
}

// ---- lanes and wards (docs/SIEGE.md §4.3, §6.3) -------------------------------------------------------------------------

export type XZ = [number, number]

export interface SiegeLane {
  /** Waypoints from the muster to the staging point in front of the segment (the last one), outside the walls. */
  outer: XZ[]
  /** Waypoints from the gap's rally point (walls.json) to the Bell (neither included). */
  inner: XZ[]
}

export interface SiegeApproachDef {
  /** "the west road". */
  name: string
  muster: XZ
  /** Target segment -> its lane. */
  lanes: Record<string, SiegeLane>
}

export interface SiegeLanesContent {
  /** The Town Bell on the plaza (glTF m). */
  bell: XZ
  approaches: Partial<Record<SiegeApproach, SiegeApproachDef>>
}

const isXZ = (p: unknown): p is XZ => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))

/** Problems of content/siege/jangan.json `siege` (shape only; the server walks every leg at start). */
export function checkSiegeLanes(v: unknown): string[] {
  const out: string[] = []
  const c = v as Partial<SiegeLanesContent> | null
  if (!c || typeof c !== 'object') return ['siege must be an object']
  if (!isXZ(c.bell)) out.push('siege.bell must be [x, z]')
  if (!c.approaches || typeof c.approaches !== 'object') return [...out, 'siege.approaches must be an object']
  for (const [k, a] of Object.entries(c.approaches)) {
    if (!SIEGE_APPROACHES.includes(k as SiegeApproach)) {
      out.push(`siege.approaches.${k}: unknown approach (W, S, E, N)`)
      continue
    }
    if (!a || typeof a.name !== 'string' || !isXZ(a.muster) || !a.lanes || typeof a.lanes !== 'object') {
      out.push(`siege.approaches.${k}: needs name, muster [x, z] and lanes`)
      continue
    }
    for (const [seg, l] of Object.entries(a.lanes)) {
      if (!WALL_SEGMENT_ID.test(seg)) out.push(`siege.approaches.${k}.lanes: ${seg} is not a segment id`)
      if (!l || !Array.isArray(l.outer) || l.outer.length === 0 || !l.outer.every(isXZ)) out.push(`siege.approaches.${k}.lanes.${seg}.outer must be a non-empty list of [x, z]`)
      if (!l || !Array.isArray(l.inner) || !l.inner.every(isXZ)) out.push(`siege.approaches.${k}.lanes.${seg}.inner must be a list of [x, z]`)
    }
  }
  return out
}

/** A gate's ward: a line across the gatehouse on the wall's centre line (the gatehouse's span along the wall). */
export interface WardLine {
  gate: string
  a: XZ
  b: XZ
}

/** The ward lines of the export's gatehouses (`fixed` spans whose id ends in `-gate`). */
export function wardLines(walls: Pick<WallsExport, 'sides'>): WardLine[] {
  const out: WardLine[] = []
  for (const side of walls.sides as WallsSideInfo[]) {
    for (const f of side.fixed) {
      if (!f.id.endsWith('-gate')) continue
      out.push(side.axis === 'x' ? { gate: f.id, a: [f.from, side.line], b: [f.to, side.line] } : { gate: f.id, a: [side.line, f.from], b: [side.line, f.to] })
    }
  }
  return out
}

/** The fraction t in [0, 1] along a→b where it first crosses a ward line, or null. */
export function wardCrossing(ax: number, az: number, bx: number, bz: number, lines: readonly WardLine[]): number | null {
  let best: number | null = null
  const rx = bx - ax
  const rz = bz - az
  for (const l of lines) {
    const sx = l.b[0] - l.a[0]
    const sz = l.b[1] - l.a[1]
    const den = rx * sz - rz * sx
    if (Math.abs(den) < 1e-9) continue
    const qx = l.a[0] - ax
    const qz = l.a[1] - az
    const t = (qx * sz - qz * sx) / den
    const u = (qx * rz - qz * rx) / den
    if (t < 0 || t > 1 || u < 0 || u > 1) continue
    if (best === null || t < best) best = t
  }
  return best
}

/**
 * A siege mob's walk a→b clipped at the first ward line it crosses, `backM` short of it (a walk that starts on the line
 * stays put). null: no ward in the way.
 */
export function clipWalk(ax: number, az: number, bx: number, bz: number, lines: readonly WardLine[], backM = 0.75): XZ | null {
  const t = wardCrossing(ax, az, bx, bz, lines)
  if (t === null) return null
  const len = Math.hypot(bx - ax, bz - az)
  const f = len > 0 ? Math.max(0, t - backM / len) : 0
  return [ax + (bx - ax) * f, az + (bz - az) * f]
}

/** The point `d` m from `p` toward the outside of `side` (across the wall's axis). */
export function outward(side: Pick<WallsSideInfo, 'axis' | 'out'>, p: XZ, d: number): XZ {
  return side.axis === 'x' ? [p[0], p[1] + side.out * d] : [p[0] + side.out * d, p[1]]
}

/** Shortest distance (m) from a point to the segment a→b. */
export function distToLeg(p: XZ, a: XZ, b: XZ): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t))
}

/** Seeded pick of `n` approaches of the four (mulberry32-style stream `rng`), in the fixed W, S, E, N order. */
export function pickApproaches(available: readonly SiegeApproach[], n: number, rng: () => number): SiegeApproach[] {
  const pool = [...available]
  const out: SiegeApproach[] = []
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length) % pool.length, 1)[0]!)
  return SIEGE_APPROACHES.filter((a) => out.includes(a))
}

/** "the west road and the south fields". */
export function approachList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// ---- the admin panel (docs/SIEGE.md §11.3, §11.4) ----------------------------------------------------------------------

export interface AdminSiegeWall {
  id: string
  stage: string
  pct: number
  queued: number
}

export interface AdminSiegeCurrent extends SiegeView {
  origin: string
  createdAt: number
  wave1At: number | null
  bellHp: number | null
  bellMaxHp: number | null
  warlordHp: number | null
  warlordMaxHp: number | null
  scale: number
  contributors: number
}

/** The walls' plan for the admin diagram (glTF m along each side's axis; null without walls.json). */
export interface AdminSiegeGeometry {
  sides: { side: string; axis: 'x' | 'z'; line: number }[]
  segs: { id: string; from: number; to: number }[]
  fixed: { id: string; side: string; from: number; to: number }[]
  bell: XZ
}

export interface AdminSiegeView {
  walls: AdminSiegeWall[]
  geometry: AdminSiegeGeometry | null
  current: AdminSiegeCurrent | null
  /** The next scheduled siege (its warning), null when off or no slots. */
  next: number | null
  /** A scheduled siege is waiting for a Night of the Tiger to end, until then. */
  waitingUntil: number | null
  schedule: { tz: string; enabled: boolean }
  settings: { defaults: SiegeEventSettings; effective: SiegeEventSettings; patch: SiegeEventPatch; rev: number; bounds: Readonly<Record<string, readonly [number, number]>> }
  /** Approaches and their usable target segments (lanes that passed the start check). */
  lanes: { approach: SiegeApproach; name: string; segments: string[]; dropped: string[] }[]
  problems: string[]
}

export interface SiegeEventSummary {
  id: number
  origin: string
  phase: string
  createdAt: number
  wave1At: number | null
  endedAt: number | null
  outcome: string | null
  approaches: string[]
  defenders: number
  breaches: number
  top: SiegeTopLine[]
}

export interface SiegeLogLine {
  at: number
  kind: string
  data: Record<string, unknown>
}

export interface SiegeContribView {
  name: string
  character: number
  points: number
  gold: number
  seals: number
}

/** Where a keg ends up on the ground, for the client's prop (unused on the server). */
export type SiegeKegAt = Vec3
