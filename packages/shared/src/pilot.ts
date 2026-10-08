/**
 * Play the Boss (docs/PLAY_THE_BOSS.md): a player steers a unique (Tiger Girl) while everyone else hunts her. The
 * protocol additions (§5.1, §5.2), the content block of content/uniques.json (`UniqueDef.pilot`, §5.5) and the settings
 * schema (§6.2). Environment-neutral. Kept out of protocol.ts on purpose (§5.2): protocol.ts only spreads the unions and
 * the lists below into its own.
 *
 * This module imports nothing at runtime (protocol.ts imports it), so it never sees a half-built protocol module.
 */

// ---- client -> server (§5.1): GameplayRequests, one actionResult each ------------------------------------------

export type PilotRequest = 'pilotVolunteer' | 'pilotAnswer' | 'pilotAct' | 'pilotTaunt' | 'pilotQuit'
export const PILOT_REQUESTS: readonly PilotRequest[] = ['pilotVolunteer', 'pilotAnswer', 'pilotAct', 'pilotTaunt', 'pilotQuit']

export type PilotClientMessage =
  /** Layer 4 (the call): volunteer for the turn, or withdraw. Accepted while dead. */
  | { t: 'pilotVolunteer'; on: boolean }
  /** The offered player's answer to `pilotOffer` (its `event`), inside the offer's window. */
  | { t: 'pilotAnswer'; event: number; accept: boolean }
  /**
   * The pilot uses kit ability `ability` (PilotKitView.id): on entity `target` (a hunter the pilot sees), or on the
   * ground point x/z (Pounce). `repeat` (Claw on a hunter): auto-claw until another order. moveTo and stopAction stay
   * as they are on the wire; the server steers her while you pilot.
   */
  | { t: 'pilotAct'; ability: string; target?: number; x?: number; z?: number; repeat?: boolean }
  /** One of the fixed taunt lines (0..PILOT_TAUNT_MAX; the client's i18n `pilot.taunt.<line>`); never free text. */
  | { t: 'pilotTaunt'; line: number }
  /** The pilot leaves the hunt: her own AI finishes it, the reward is forfeit. */
  | { t: 'pilotQuit' }

/** Per-type budgets (CLIENT_RATE_LIMITS). */
export const PILOT_RATE_LIMITS: Readonly<Record<PilotRequest, { perSecond: number; burst: number }>> = {
  pilotVolunteer: { perSecond: 1, burst: 3 },
  pilotAnswer: { perSecond: 1, burst: 3 },
  pilotAct: { perSecond: 5, burst: 10 },
  pilotTaunt: { perSecond: 1, burst: 2 },
  pilotQuit: { perSecond: 1, burst: 2 },
}

/** `pilotAct.ability`. */
export const PILOT_ABILITY = /^[a-z]{1,16}$/
/** Highest taunt line the wire accepts (the kit ships PILOT_TAUNT_LINES of them). */
export const PILOT_TAUNT_MAX = 15
export const PILOT_TAUNT_LINES = 8

/** ActionFailReason additions (§5.1). */
export type PilotFailReason =
  /** Your character is in a trance (you steer the boss): it cannot do this now. */
  | 'piloting'
  | 'not_eligible'
  /** No event, or you are not its live pilot / offered player. */
  | 'no_event'
  /** The ability's charges for this hunt are used up. */
  | 'no_charges'
export const PILOT_FAIL_REASONS: readonly PilotFailReason[] = ['piloting', 'not_eligible', 'no_event', 'no_charges']

// ---- server -> client (§5.2) -------------------------------------------------------------------------------------

export type HuntPhase = 'call' | 'offer' | 'hunt' | 'ended'
export const HUNT_PHASES: readonly HuntPhase[] = ['call', 'offer', 'hunt', 'ended']
export type HuntOutcome = 'killed' | 'survived' | 'downs' | 'no_volunteers' | 'cancelled' | 'restart'
export const HUNT_OUTCOMES: readonly HuntOutcome[] = ['killed', 'survived', 'downs', 'no_volunteers', 'cancelled', 'restart']
export type PilotIneligible = 'level' | 'playtime' | 'cooldown' | 'recent' | 'blocked' | 'dead' | 'busy'
export const PILOT_INELIGIBLE: readonly PilotIneligible[] = ['level', 'playtime', 'cooldown', 'recent', 'blocked', 'dead', 'busy']
export type PilotEndReason = 'killed' | 'survived' | 'downs' | 'quit' | 'cancelled'
export const PILOT_END_REASONS: readonly PilotEndReason[] = ['killed', 'survived', 'downs', 'quit', 'cancelled']
export type PilotSteering = 'player' | 'ai'
export const PILOT_STEERINGS: readonly PilotSteering[] = ['player', 'ai']
/** What an ability aims at: a hunter, a hunter or a ground point (Pounce), or nothing (around her). */
export type PilotTargetKind = 'entity' | 'point' | 'none'
export const PILOT_TARGET_KINDS: readonly PilotTargetKind[] = ['entity', 'point', 'none']

/** The event's public state (world sockets; on every change and on enter-world). */
export interface HuntEventView {
  id: number
  /** The unique's mob code (MOB_CH_TIGERWOMAN) and English name. */
  mob: string
  name: string
  phase: HuntPhase
  /** call (layer 4): when the draw happens, how many volunteered (also while drawing: the event came from a call). */
  callEndsAt?: number
  volunteers?: number
  /** call (layer 4): the level a volunteer needs (the banner's "level 25 only"; the Climb: 25, was 20). */
  minLevel?: number
  /** call (layer 4), per recipient. */
  you?: { volunteered: boolean; eligible: boolean; why?: PilotIneligible }
  /** hunt: the survival deadline (server ms), downs so far and the target, distinct hunters who hit her, her area. */
  huntEndsAt?: number
  downs?: number
  downsTarget?: number
  hunters?: number
  area?: string
  steering?: PilotSteering
  /** hunt: when the next sighting (huntPing) goes out, server ms (the banner's "next sighting in 0:42"). */
  nextPingAt?: number
  /** ended only. */
  outcome?: HuntOutcome
  /** The pilot's character name: only once the event has ended (§2.2: anonymous during the hunt). */
  pilot?: string
}

/** One kit slot as the pilot's HUD shows it. Names and descriptions are client i18n (`pilot.ability.<id>.*`). */
export interface PilotKitView {
  id: string
  /** Hotbar key 1..9. */
  slot: number
  /** The clip type a server-built ability plays (`cast.clip`); '' for a retail row (the client resolves the row). */
  clip: string
  rangeM: number
  cooldownMs: number
  /** Uses per hunt (absent = unlimited). */
  charges?: number
  target: PilotTargetKind
}

export type PilotServerMessage =
  | { t: 'huntEvent'; event: HuntEventView }
  /** The drawn (or GM-picked) player only: accept with pilotAnswer before `expiresAt` (server ms). */
  | { t: 'pilotOffer'; event: number; expiresAt: number; surviveMin: number; downsTarget: number; idleSec: number }
  /**
   * The pilot: control starts. `mob` = her entity id (the client's controlled view); `event` 0 = a GM `attach` session
   * (no event rules: `huntEndsAt` and `downsTarget` 0). `area` = the hunt circle; `place` = where the body rests.
   */
  | {
      t: 'pilotStart'
      event: number
      mob: number
      kit: PilotKitView[]
      huntEndsAt: number
      downsTarget: number
      area: { x: number; z: number; r: number }
      taunts: number
      senseM: number
      place: string
    }
  /** The pilot, on change. `ready`: ability id -> server ms it is ready again; `charges`: uses left. */
  | {
      t: 'pilotState'
      steering: PilotSteering
      /** Server ms her AI takes over when no input comes (present while that is near). */
      idleWarnAt?: number
      hunting: number
      downs: number
      charges: Record<string, number>
      ready: Record<string, number>
      enraged?: boolean
      /** Server ms Stalk ends (present while she stalks). */
      stalkUntil?: number
    }
  /** The pilot: the turn is over. `gold` paid, `honor` (a title code) granted; `downs` and `steeredMs` for the result. */
  | { t: 'pilotEnd'; event: number; reason: PilotEndReason; gold?: number; honor?: string; downs?: number; steeredMs?: number }
  /** Hunters (every world player but the pilot): a rough sighting, a circle of `r` m that contains her. */
  | { t: 'huntPing'; event: number; x: number; z: number; r: number; at: number }
  /** Hunters near fresh tracks who do not see her: her footprints, [x, z, server ms]. */
  | { t: 'huntTrail'; points: [number, number, number][] }
  /** Hunters 120–400 m away: her roar from `bearing` (radians, as WeatherSync.windDir), `distM` away. */
  | { t: 'huntRoar'; bearing: number; distM: number; at: number }
  /** Her viewers: entity `id` (her) taunts with line `line`. */
  | { t: 'huntTaunt'; id: number; line: number }

/** Most kit slots / footprints per huntTrail on the wire. */
export const PILOT_KIT_MAX = 9
export const HUNT_TRAIL_MAX = 64

// ---- content: content/uniques.json `pilot` block (§5.5) ---------------------------------------------------------

/** A retail monster-skill row of hers (Claw, Sweep, Curse): run through MobSkills.use unchanged. */
export interface PilotRowAbility {
  id: string
  slot: number
  row: string
  kind?: undefined
}

/** Pounce: a straight navmesh leap at `speedMs` to a hunter or a ground point <= `rangeM`; on landing `hit`. */
export interface PilotLeapAbility {
  id: string
  slot: number
  kind: 'leap'
  rangeM: number
  speedMs: number
  cooldownMs: number
  clip: string
  hit: { row: string; mul: number; radiusM: number; status: 'knockdown' | 'stun' | 'knockback' }
}

/** Fear Roar: hunters within `radiusM` are knocked back `pushM` and cannot act for `lockMs`. */
export interface PilotFearAbility {
  id: string
  slot: number
  kind: 'fear'
  radiusM: number
  pushM: number
  lockMs: number
  cooldownMs: number
  clip: string
}

/** Call the Pack: `count` of `mob` beside her, joining her summons; `charges` uses per hunt. */
export interface PilotPackAbility {
  id: string
  slot: number
  kind: 'pack'
  mob: string
  count: number
  charges: number
  cooldownMs: number
  clip: string
}

/** Stalk: hunters see her only within `revealM`; her speed x `speedMul`; ends on any act or damage, or after `maxMs`. */
export interface PilotStalkAbility {
  id: string
  slot: number
  kind: 'stalk'
  revealM: number
  maxMs: number
  speedMul: number
  cooldownMs: number
  /** 'anywhere' (outside towns) until the converter's grass cover mask exists (§3.5, §9 Q4). */
  cover: 'anywhere'
}

export type PilotAbilityDef = PilotRowAbility | PilotLeapAbility | PilotFearAbility | PilotPackAbility | PilotStalkAbility

export interface PilotDef {
  /** A place name (content/places.json / the manifest) where the pilot's body rests in a trance. */
  trancePlace: string
  kit: PilotAbilityDef[]
  /** The default of every setting (§6.1): a patch over PILOT_DEFAULTS, checked with checkPilotSettings. */
  defaults: PilotSettingsPatch
}

// ---- settings (§6.2) ---------------------------------------------------------------------------------------------

export interface PilotSettings {
  /** Scheduled nights on (GM / admin starts always work). Layer 4. */
  enabled: boolean
  schedule: { slots: { weekday: number; time: string }[]; tz: string }
  call: { minutes: number; acceptSec: number; maxDraws: number }
  eligibility: { minLevel: number; minPlayHours: number; cooldownDays: number; recentEvents: number; firstTimerWeight: number }
  win: { surviveMin: number; downsTarget: number; downMinLevel: number; downMinDamage: number }
  hunt: { radiusM: number; pingSec: number; pingRadiusM: number; idleSec: number; speedMul: number; senseM: number }
  scaling: { on: boolean; baseHunters: number; exponent: number; capHunters: number; windowSec: number; minDamage: number }
  rewards: { baseGold: number; perDownGold: number; perMinuteGold: number; winGold: number; title: string | null; cosmetic: string | null }
  guards: { associateDamagePct: number; earlyDeathMin: number; tauntCooldownSec: number }
}

/** A sparse patch: any group, any field of it. */
export type PilotSettingsPatch = { [G in keyof PilotSettings]?: PilotSettings[G] extends object ? Partial<PilotSettings[G]> : PilotSettings[G] }

export const PILOT_DEFAULTS: PilotSettings = {
  enabled: false,
  schedule: { slots: [{ weekday: 6, time: '21:00' }], tz: '' },
  call: { minutes: 10, acceptSec: 30, maxDraws: 5 },
  eligibility: { minLevel: 25, minPlayHours: 10, cooldownDays: 14, recentEvents: 3, firstTimerWeight: 3 },
  win: { surviveMin: 15, downsTarget: 15, downMinLevel: 20, downMinDamage: 200 },
  hunt: { radiusM: 350, pingSec: 60, pingRadiusM: 60, idleSec: 20, speedMul: 1, senseM: 60 },
  scaling: { on: true, baseHunters: 4, exponent: 0.9, capHunters: 40, windowSec: 60, minDamage: 200 },
  rewards: { baseGold: 5000, perDownGold: 500, perMinuteGold: 300, winGold: 10_000, title: 'tiger_spirit', cosmetic: null },
  guards: { associateDamagePct: 25, earlyDeathMin: 3, tauntCooldownSec: 4 },
}

/** Numeric bounds by `group.field` (inclusive). `levelCap` bounds use 300 here; the server clips to its own cap. */
export const PILOT_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  'call.minutes': [1, 60],
  'call.acceptSec': [10, 120],
  'call.maxDraws': [1, 20],
  'eligibility.minLevel': [1, 300],
  'eligibility.minPlayHours': [0, 500],
  'eligibility.cooldownDays': [0, 90],
  'eligibility.recentEvents': [0, 20],
  'eligibility.firstTimerWeight': [1, 10],
  'win.surviveMin': [3, 60],
  'win.downsTarget': [1, 200],
  'win.downMinLevel': [1, 300],
  'win.downMinDamage': [0, 10_000],
  'hunt.radiusM': [100, 1000],
  'hunt.pingSec': [15, 300],
  'hunt.pingRadiusM': [20, 200],
  'hunt.idleSec': [10, 120],
  'hunt.speedMul': [0.8, 1.5],
  'hunt.senseM': [20, 120],
  'scaling.baseHunters': [1, 20],
  'scaling.exponent': [0.5, 1],
  'scaling.capHunters': [4, 200],
  'scaling.windowSec': [15, 300],
  'scaling.minDamage': [0, 10_000],
  'rewards.baseGold': [0, 1_000_000],
  'rewards.perDownGold': [0, 1_000_000],
  'rewards.perMinuteGold': [0, 1_000_000],
  'rewards.winGold': [0, 1_000_000],
  'guards.associateDamagePct': [0, 100],
  'guards.earlyDeathMin': [0, 15],
  'guards.tauntCooldownSec': [1, 60],
}

/** Title / cosmetic codes (EntityState.honor; client i18n `pilot.honor.<code>`). */
export const PILOT_HONOR = /^[a-z0-9_]{1,32}$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export interface PilotSettingsIssue {
  path: string
  message: string
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Checks a settings patch (or, `full`, a whole PilotSettings): unknown groups or fields, wrong types, numbers outside
 * PILOT_BOUNDS, bad schedule slots, bad title codes. Returns the issues (empty = fine).
 */
export function checkPilotSettings(v: unknown, full = false, where = ''): PilotSettingsIssue[] {
  const out: PilotSettingsIssue[] = []
  const at = (p: string) => (where ? `${where}.${p}` : p)
  if (!isRec(v)) return [{ path: where || '.', message: 'expected an object' }]
  for (const [g, def] of Object.entries(PILOT_DEFAULTS) as [keyof PilotSettings, unknown][]) {
    const val = v[g]
    if (val === undefined) {
      if (full) out.push({ path: at(g), message: 'missing' })
      continue
    }
    if (g === 'enabled') {
      if (typeof val !== 'boolean') out.push({ path: at(g), message: 'expected a boolean' })
      continue
    }
    if (!isRec(val)) {
      out.push({ path: at(g), message: 'expected an object' })
      continue
    }
    for (const k of Object.keys(val)) if (!(k in (def as object))) out.push({ path: at(`${g}.${k}`), message: 'unknown field' })
    for (const [k, d] of Object.entries(def as Record<string, unknown>)) {
      const x = val[k]
      const p = at(`${g}.${k}`)
      if (x === undefined) {
        if (full) out.push({ path: p, message: 'missing' })
        continue
      }
      const bound = PILOT_BOUNDS[`${g}.${k}`]
      if (bound) {
        if (typeof x !== 'number' || !Number.isFinite(x)) out.push({ path: p, message: 'expected a number' })
        else if (x < bound[0] || x > bound[1]) out.push({ path: p, message: `expected ${bound[0]}..${bound[1]}` })
      } else if (typeof d === 'boolean') {
        if (typeof x !== 'boolean') out.push({ path: p, message: 'expected a boolean' })
      } else if (g === 'rewards') {
        if (x !== null && (typeof x !== 'string' || !PILOT_HONOR.test(x))) out.push({ path: p, message: 'expected null or a code (a-z, 0-9, _)' })
      } else if (g === 'schedule' && k === 'tz') {
        if (typeof x !== 'string' || x.length > 64 || (x !== '' && !validTimeZone(x))) out.push({ path: p, message: "expected an IANA time zone ('' = the server's)" })
      } else if (g === 'schedule' && k === 'slots') {
        if (!Array.isArray(x) || x.length > 7) out.push({ path: p, message: 'expected at most 7 slots' })
        else x.forEach((s, i) => {
          if (!isRec(s) || !Number.isInteger(s.weekday) || (s.weekday as number) < 0 || (s.weekday as number) > 6 || typeof s.time !== 'string' || !HHMM.test(s.time)) {
            out.push({ path: `${p}[${i}]`, message: "expected {weekday: 0..6, time: 'HH:MM'}" })
          }
        })
      }
    }
  }
  for (const k of Object.keys(v)) if (!(k in PILOT_DEFAULTS)) out.push({ path: at(k), message: 'unknown group' })
  return out
}

/** PILOT_DEFAULTS with `patches` applied in order (each a checked PilotSettingsPatch). A fresh object. */
export function mergePilotSettings(...patches: (PilotSettingsPatch | null | undefined)[]): PilotSettings {
  const out = structuredClone(PILOT_DEFAULTS)
  for (const patch of patches) {
    if (!patch) continue
    for (const [g, val] of Object.entries(patch)) {
      if (val === undefined) continue
      if (g === 'enabled') out.enabled = val as boolean
      else if (isRec(val)) Object.assign((out as unknown as Record<string, Record<string, unknown>>)[g], structuredClone(val))
    }
  }
  return out
}

/** Whether `tz` is an IANA time zone this runtime knows (Intl). */
export function validTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Every editable setting as a path: 'enabled' and 'group.field' (the admin panel's fields, the reset paths). */
export const PILOT_SETTING_PATHS: readonly string[] = Object.entries(PILOT_DEFAULTS).flatMap(([g, v]) => (isRec(v) ? Object.keys(v).map((k) => `${g}.${k}`) : [g]))

/** `delta` laid over the stored patch `base` (per field; `schedule.slots` as a whole). A fresh object. */
export function mergePilotPatch(base: PilotSettingsPatch, delta: PilotSettingsPatch): PilotSettingsPatch {
  const out = structuredClone(base) as Record<string, unknown>
  for (const [g, val] of Object.entries(delta)) {
    if (val === undefined) continue
    if (!isRec(val)) out[g] = structuredClone(val)
    else out[g] = { ...(isRec(out[g]) ? out[g] : {}), ...structuredClone(val) }
  }
  return out as PilotSettingsPatch
}

/** The patch without `paths` (a group name drops the whole group; 'enabled' the switch). A fresh object. */
export function unsetPilotPaths(patch: PilotSettingsPatch, paths: readonly string[]): PilotSettingsPatch {
  const out = structuredClone(patch) as Record<string, unknown>
  for (const path of paths) {
    const [g, k] = path.split('.')
    if (k === undefined) delete out[g]
    else if (isRec(out[g])) {
      delete (out[g] as Record<string, unknown>)[k]
      if (Object.keys(out[g] as object).length === 0) delete out[g]
    }
  }
  return out as PilotSettingsPatch
}

/** The patch without the fields equal to `defaults` (so a stored patch only says what differs). A fresh object. */
export function prunePilotPatch(patch: PilotSettingsPatch, defaults: PilotSettings): PilotSettingsPatch {
  const out: Record<string, unknown> = {}
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  for (const [g, val] of Object.entries(patch)) {
    const d = (defaults as unknown as Record<string, unknown>)[g]
    if (!isRec(val)) {
      if (!same(val, d)) out[g] = structuredClone(val)
      continue
    }
    const kept = Object.fromEntries(Object.entries(val).filter(([k, x]) => x !== undefined && !same(x, (d as Record<string, unknown>)[k])))
    if (Object.keys(kept).length) out[g] = structuredClone(kept)
  }
  return out as PilotSettingsPatch
}

/**
 * Rules across fields of the effective settings: the level fields within the server's `levelCap`, the scaling's cap at
 * least its base. Returns the issues (empty = fine).
 */
export function checkPilotEffective(s: PilotSettings, levelCap = 300): PilotSettingsIssue[] {
  const out: PilotSettingsIssue[] = []
  if (s.eligibility.minLevel > levelCap) out.push({ path: 'eligibility.minLevel', message: `expected at most the level cap (${levelCap})` })
  if (s.win.downMinLevel > levelCap) out.push({ path: 'win.downMinLevel', message: `expected at most the level cap (${levelCap})` })
  if (s.scaling.capHunters < s.scaling.baseHunters) out.push({ path: 'scaling.capHunters', message: `expected at least baseHunters (${s.scaling.baseHunters})` })
  return out
}

// ---- scaling (§3.7, layer 5) -------------------------------------------------------------------------------------

/** Her max HP is recomputed this often; a fall is at most PILOT_SCALE_FALL of it per step. */
export const PILOT_SCALE_EVERY_MS = 5000
export const PILOT_SCALE_FALL = 0.1
/** A band summon's wave never grows past this many mobs. */
export const PILOT_SUMMON_WAVE_MAX = 6

/** s = (clamp(N, baseHunters, capHunters) / baseHunters)^exponent; 1 with scaling off. */
export function pilotScaleFactor(hunters: number, s: PilotSettings['scaling']): number {
  if (!s.on) return 1
  const base = Math.max(1, s.baseHunters)
  const n = Math.min(Math.max(hunters, base), Math.max(base, s.capHunters))
  return (n / base) ** s.exponent
}

/** round(baseMaxHp × s): 59,872 × s for Tiger Girl (level 25; 47,898 before the Climb). */
export function pilotScaledMaxHp(baseMaxHp: number, factor: number): number {
  return Math.max(1, Math.round(baseMaxHp * Math.max(1, factor)))
}

/** The next max HP toward `target`: up at once, down by at most PILOT_SCALE_FALL of `current` per step. */
export function pilotNextMaxHp(current: number, target: number): number {
  return target >= current ? target : Math.max(target, Math.round(current * (1 - PILOT_SCALE_FALL)))
}

/** Her HP after max HP `from` → `to`, keeping its fraction (alive stays ≥ 1, full stays full). */
export function pilotKeepFraction(hp: number, from: number, to: number): number {
  if (hp <= 0) return hp
  if (hp >= from) return to
  return Math.min(to, Math.max(1, Math.round((hp / Math.max(1, from)) * to)))
}

/**
 * Band summons at factor s: perWave = clamp(round(perWave₀ √s), perWave₀, 6), maxAlive keeps its ratio to perWave
 * (Tiger Girl: 2 / 4 → 3 / 6 → 4 / 8 → 6 / 12). The Pack is not scaled.
 */
export function pilotScaledSummons(base: { perWave: number; maxAlive: number }, factor: number): { perWave: number; maxAlive: number } {
  const w0 = Math.max(1, base.perWave)
  const perWave = Math.min(Math.max(w0, PILOT_SUMMON_WAVE_MAX), Math.max(w0, Math.round(w0 * Math.sqrt(Math.max(1, factor)))))
  return { perWave, maxAlive: Math.max(base.maxAlive, Math.round((base.maxAlive / w0) * perWave)) }
}

/** What checkPilotDef can resolve (the server passes its tables; absent = not checked). */
export interface PilotDefRefs {
  mob?: (code: string) => boolean
  skill?: (code: string) => boolean
}

/**
 * The `pilot` block of a unique (§5.5): the trance place, the kit (unique ids and slots 1..9, the retail rows, the new
 * kinds' numbers) and the defaults (checkPilotSettings). Returns problems as `<where>.<path>: <message>`.
 */
export function checkPilotDef(v: unknown, where: string, refs: PilotDefRefs = {}): string[] {
  const out: string[] = []
  if (!isRec(v)) return [`${where}: expected an object`]
  if (typeof v.trancePlace !== 'string' || !v.trancePlace) out.push(`${where}.trancePlace: expected a place name`)
  if (!Array.isArray(v.kit) || v.kit.length === 0 || v.kit.length > PILOT_KIT_MAX) out.push(`${where}.kit: expected 1..${PILOT_KIT_MAX} abilities`)
  else {
    const ids = new Set<unknown>()
    const slots = new Set<unknown>()
    v.kit.forEach((a, i) => {
      const w = `${where}.kit[${i}]`
      if (!isRec(a)) return void out.push(`${w}: expected an object`)
      if (typeof a.id !== 'string' || !PILOT_ABILITY.test(a.id)) out.push(`${w}.id: expected a-z, 1..16 letters`)
      else if (ids.has(a.id)) out.push(`${w}.id: listed twice`)
      ids.add(a.id)
      if (!Number.isInteger(a.slot) || (a.slot as number) < 1 || (a.slot as number) > PILOT_KIT_MAX) out.push(`${w}.slot: expected 1..${PILOT_KIT_MAX}`)
      else if (slots.has(a.slot)) out.push(`${w}.slot: taken twice`)
      slots.add(a.slot)
      const num = (k: string, min: number, max = Infinity) => {
        const x = a[k]
        if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) out.push(`${w}.${k}: expected ${min}..${max}`)
      }
      const clip = () => {
        if (typeof a.clip !== 'string' || !/^[A-Z0-9_]{1,32}$/.test(a.clip)) out.push(`${w}.clip: expected a clip type (ATTACK1, FIND, ...)`)
      }
      const row = (k: string, o: Record<string, unknown> = a) => {
        if (typeof o[k] !== 'string' || !/^[A-Z0-9_]{1,128}$/.test(o[k] as string)) out.push(`${w}.${k}: expected a skill row code`)
        else if (refs.skill && !refs.skill(o[k] as string)) out.push(`${w}.${k}: unknown skill row ${o[k] as string}`)
      }
      if (a.kind === undefined) return row('row')
      switch (a.kind) {
        case 'leap': {
          num('rangeM', 1, 60)
          num('speedMs', 1, 60)
          num('cooldownMs', 0, 600_000)
          clip()
          const h = a.hit
          if (!isRec(h)) return void out.push(`${w}.hit: expected an object`)
          row('row', h)
          if (typeof h.mul !== 'number' || !(h.mul >= 0) || h.mul > 10) out.push(`${w}.hit.mul: expected 0..10`)
          if (typeof h.radiusM !== 'number' || !(h.radiusM > 0) || h.radiusM > 30) out.push(`${w}.hit.radiusM: expected 0..30`)
          if (h.status !== 'knockdown' && h.status !== 'stun' && h.status !== 'knockback') out.push(`${w}.hit.status: expected knockdown, stun or knockback`)
          return
        }
        case 'fear':
          num('radiusM', 1, 60)
          num('pushM', 0, 30)
          num('lockMs', 0, 10_000)
          num('cooldownMs', 0, 600_000)
          return clip()
        case 'pack':
          if (typeof a.mob !== 'string' || !/^[A-Z0-9_]{1,128}$/.test(a.mob)) out.push(`${w}.mob: expected a mob code`)
          else if (refs.mob && !refs.mob(a.mob)) out.push(`${w}.mob: unknown mob ${a.mob}`)
          num('count', 1, 10)
          num('charges', 1, 20)
          num('cooldownMs', 0, 600_000)
          return clip()
        case 'stalk':
          num('revealM', 1, 120)
          num('maxMs', 1000, 600_000)
          num('speedMul', 0.1, 1)
          num('cooldownMs', 0, 600_000)
          if (a.cover !== 'anywhere') out.push(`${w}.cover: expected 'anywhere'`)
          return
        default:
          out.push(`${w}.kind: expected leap, fear, pack or stalk (or a retail row without a kind)`)
      }
    })
  }
  if (v.defaults !== undefined) for (const i of checkPilotSettings(v.defaults, false)) out.push(`${where}.defaults.${i.path}: ${i.message}`)
  else out.push(`${where}.defaults: expected an object (a patch over the code defaults)`)
  return out
}

// ---- the admin panel's contract (§6.3; GET/POST /api/admin/boss/*) ------------------------------------------------

/** One event in the log list. */
export interface PilotEventSummary {
  id: number
  code: string
  origin: string
  phase: string
  createdAt: number
  huntStartedAt: number | null
  huntEndsAt: number | null
  endedAt: number | null
  outcome: string | null
  pilot: string | null
  camp: number | null
  downs: number
  hunters: number
  steeredMs: number
  rewardGold: number
  refunded: boolean
  flags: string[]
}

/** One line of an event's timeline (pilot_log). */
export interface PilotLogLine {
  at: number
  kind: string
  data: Record<string, unknown>
}

/** One volunteer of an event (GET /api/admin/boss/events/:id), in draw order. */
export interface PilotVolunteerView {
  name: string
  character: number
  account: number
  at: number
  /** null = never drawn; 'offered', 'accepted', 'declined', 'timeout', 'left', 'skipped:<why>'. */
  draw: string | null
}

/** A lottery block (GET /api/admin/boss/blocks). */
export interface PilotBlockView {
  account: number
  username: string | null
  /** The account's characters (names), for the panel. */
  characters: string[]
  until: number
  reason: string
  by: number | null
  byName: string | null
  at: number
}

/** GET /api/admin/boss/eligibility?character=<name>. */
export interface PilotEligibilityView {
  character: string
  account: number
  online: boolean
  level: number
  eligible: boolean
  why?: PilotIneligible
  playedHours: number
  /** When the account last steered her (a refunded turn does not count), or null. */
  lastTurnAt: number | null
  blockedUntil: number | null
  /** The draw weight (firstTimerWeight for an account that never steered her, else 1). */
  weight: number
}

/** GET /api/admin/boss. */
export interface AdminBossView {
  uniques: { code: string; name: string; alive: boolean; hpPct: number | null; steerable: boolean }[]
  /** The running event (its public view plus what only the panel sees), or null. */
  current:
    | (HuntEventView & {
        pilotName: string | null
        flags: string[]
        hpPct: number | null
        offerExpiresAt: number | null
        huntStartedAt: number | null
        /** Layer 4: who started it ('schedule', 'gm', 'admin'); while a draw waits (after a restart), when it runs. */
        origin?: string
        drawAt?: number
        /** Layer 5: her max HP now and the hunters it counts (N of §3.7). */
        maxHp?: number | null
        scaleHunters?: number
      })
    | null
  /** A GM attach session (no event rules), or null. */
  attach: { pilot: string; steering: PilotSteering; hpPct: number | null } | null
  /** The next scheduled night (the draw, server ms), or null (the schedule is off or has no slots). */
  nextNight: number | null
  /** Layer 4: the schedule in effect: the zone it uses (resolved), whether it is on, when the next call opens. */
  schedule?: { tz: string; enabled: boolean; nextCallAt: number | null }
  settings: {
    defaults: PilotSettings
    effective: PilotSettings
    rev: number
    bounds: Readonly<Record<string, readonly [number, number]>>
    /** Layer 4: the stored patch over the defaults (what the panel changed). */
    patch?: PilotSettingsPatch
    /** The server's level cap (the bound of the level fields). */
    levelCap?: number
  }
  /** What this server can do ('pick', 'stop'; layer 4: 'call', 'schedule', 'settings', 'blocks', 'eligibility'; layer 5: 'scaling'). */
  features: string[]
}
