/**
 * Storms change everything (docs/WEATHER.md §12): the storm-gameplay effects table and the pure maths the server and
 * the client share. The server reads the weather (rain, storm level, wind, surface wetness, night) into a StormEnv once
 * a second and every hook (monster sight, leash and speed, element and hit modifiers, spawn counts, mud, loot) asks the
 * functions below, so one table holds every number. The client shows the same effect list (`storm` message) under the
 * weather icon by the minimap.
 *
 * - **Rain** (rain rate ≥ `rainMin`): players are wet; monster sight drops with the rain (×0.6 in a downpour); fire
 *   force is weaker, lightning and cold force stronger; a soaked ground (wetness ≥ `mudWetMin`) slows running.
 * - **Storm** (storm level ≥ `stormLevelMin`; the level is the blended lightning rate over the storm's): undead are
 *   faster and hit harder, water spirits spawn in larger numbers, small animals hide, tigers and wolves hunt in bigger
 *   packs, bandits pull back to their camps, a strike near a beast panics it, a monster that survives a strike is
 *   charged. Strong wind spreads ranged attacks; at night the storm also blinds (fog, sight).
 * - `strength` (STORM_STRENGTH, 0..2) scales every multiplier's distance from 1 (0 = no effect, 2 = twice as strong).
 *
 * Uniques and the Play the Boss body are never affected (stormMobKind 'other'); safe areas have no mud.
 */
import type { WeatherParams } from './weather.ts'
import { WEATHER_PARAMS } from './weather.ts'

/** Every number of storm gameplay; the defaults (docs/WEATHER.md §12.6 has the table). */
const DEFAULTS = {
  // ---- frequency (defaults of the STORMS_PER_DAY, STORM_MIN_MIN, STORM_MAX_MIN, STORM_FORECAST_MIN, STORM_STRENGTH knobs)
  /** Storm events per real day (0 = none; a fraction is the chance of one more). */
  perDay: 3,
  /** Length of a storm, minutes (uniform in [min, max]). */
  minMin: 10,
  maxMin: 20,
  /** The forecast (darkening sky, rising wind, the warning) begins this long before the storm breaks, minutes. */
  forecastMin: 5,
  /** Effect strength: every multiplier's distance from 1 is scaled by this. */
  strength: 1,
  /** Mean wind during the forecast, m/s (overcast is 5, a storm 13). */
  forecastWindMs: 9,
  // ---- thresholds
  /** Rain rate (0..1) from which the rain effects apply (light rain at 0.4 intensity is 0.22). */
  rainMin: 0.2,
  /** Storm level (blended lightning rate / the storm's) from which the storm effects apply. */
  stormLevelMin: 0.5,
  // ---- rain (the multiplier at rain rate 1; linear in the rain rate above rainMin)
  /** Monster sight (aggro detection radius) at rain 1. */
  sightRainMul: 0.6,
  /** Fire force damage at rain 1. */
  fireRainMul: 0.75,
  /** Lightning force damage at rain 1. */
  lightningRainMul: 1.25,
  /** Cold force damage at rain 1. */
  coldRainMul: 1.15,
  /** Wet players take this much more from lightning (strikes, charged arcs). */
  wetShockMul: 1.2,
  /** Mud: surface wetness from which running is slowed, and by how much (percent). */
  mudWetMin: 0.6,
  mudSlowPct: 10,
  // ---- wind
  /** Ranged attacks (bows, ranged physical skills) start to miss from this wind (m/s) ... */
  windFromMs: 8,
  /** ... up to `windMissMax` extra miss chance at this wind. */
  windFullMs: 13,
  windMissMax: 0.2,
  // ---- night in a storm (scaled by how dark the night is, 0..1)
  /** Monster sight at night in a storm. */
  nightSightMul: 0.75,
  /** Extra fog at night in a storm (client visibility; WeatherFrame.fog). */
  nightFogAdd: 0.3,
  // ---- storm monsters
  /** Undead and ghosts: chase speed and damage. */
  undeadSpeedMul: 1.25,
  undeadDamageMul: 1.25,
  /** Monsters per nest: water spirits, small animals (they hide), tigers and wolves. */
  waterCountMul: 1.6,
  critterCountMul: 0.4,
  predatorCountMul: 1.5,
  /** A tiger or wolf that starts a chase calls the idle pack-mates of its nest within this (m). */
  packCallM: 18,
  /** Bandits: leash and roam radius (they pull back to their camp). */
  banditLeashMul: 0.5,
  banditRoamMul: 0.4,
  // ---- thunder panic (a strike lands near a beast)
  panicRadiusM: 30,
  panicMs: [3000, 5000] as readonly [number, number],
  panicFleeM: [10, 16] as readonly [number, number],
  // ---- storm-charged monsters (a monster that survives a strike, for the rest of the storm)
  chargedDamageMul: 1.3,
  /** Each hit of a charged monster arcs to the nearest other player within this of its target (m) ... */
  chargedArcM: 7,
  /** ... for this share of the hit's damage ... */
  chargedArcPct: 0.3,
  /** ... at most once per this (ms) per monster. */
  chargedArcCooldownMs: 2500,
  /** Its loot: item group chances × this, gold × this, and this chance of +1 on each piece of gear. */
  chargedDropMul: 2,
  chargedGoldMul: 1.5,
  chargedPlusChance: 0.35,
  // ---- the lightning tornado (docs/WEATHER.md §13; the rest of its numbers: TORNADO_TABLE in tornado.ts)
  /** Chance that a storm event brings one tornado (TORNADO_CHANCE knob; 0 = only GM tornadoes). */
  tornadoChance: 0.3,
  /** Its pull, throw, damage and bolts are scaled by this (TORNADO_STRENGTH knob, 0..2; 0 = it only looks). */
  tornadoStrength: 1,
  // ---- the server's bookkeeping
  /** How often the nest counts are reconciled with the storm (ms), and how many extras leave per nest per pass. */
  reconcileMs: 5000,
  despawnPerPass: 2,
} as const

type Widen<T> = T extends number ? number : T extends readonly [number, number] ? readonly [number, number] : T
/** The table's shape (a test or a later knob may pass its own numbers). */
export type StormTable = { readonly [K in keyof typeof DEFAULTS]: Widen<(typeof DEFAULTS)[K]> }

export const STORM_TABLE: StormTable = DEFAULTS

/** The weather as storm gameplay reads it (the server, once a second). */
export interface StormEnv {
  /** Rain rate 0..1 (blended). */
  rain: number
  /** Storm level 0..1: the blended lightning rate over the storm's. */
  storm: number
  /** Mean wind, m/s. */
  windMs: number
  /** Surface wetness 0..1. */
  wet: number
  /** How dark the night is 0..1 (0 by day). */
  night: number
  /** STORM_STRENGTH 0..2. */
  strength: number
}

export const CALM_ENV: Readonly<StormEnv> = { rain: 0, storm: 0, windMs: 0, wet: 0, night: 0, strength: 1 }

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** A multiplier at full effect, scaled by the strength: 1 + (mul − 1) × strength (never below 0). */
export function strong(mul: number, strength: number): number {
  return Math.max(0, 1 + (mul - 1) * strength)
}

/** A multiplier that applies by degree `k` (0..1): 1 + (mul − 1) × k × strength. */
function partly(mul: number, k: number, strength: number): number {
  return strong(1 + (mul - 1) * clamp01(k), strength)
}

/** The storm level of a blended parameter vector: lightning / the storm's lightning, 0..1. */
export function stormLevel(p: Pick<WeatherParams, 'lightning'>): number {
  return clamp01(p.lightning / WEATHER_PARAMS.storm.lightning)
}

/** How dark it is from the sun's height (sunDirection's up component): 0 by day, 1 from 6° below the horizon. */
export function nightness(sunUp: number): number {
  const t = clamp01((0.05 - sunUp) / 0.155)
  return t * t * (3 - 2 * t)
}

export function raining(env: StormEnv, t: StormTable = STORM_TABLE): boolean {
  return env.rain >= t.rainMin
}

export function storming(env: StormEnv, t: StormTable = STORM_TABLE): boolean {
  return env.storm >= t.stormLevelMin
}

/** Rain's degree 0..1 above the threshold (0 below it): the rain rate itself, so a downpour is 1. */
function rainK(env: StormEnv, t: StormTable): number {
  return raining(env, t) ? clamp01(env.rain) : 0
}

/** Night-in-a-storm degree 0..1. */
function nightK(env: StormEnv, t: StormTable): number {
  return storming(env, t) ? clamp01(env.night) : 0
}

// ---- monsters ----------------------------------------------------------------------------------------------

/** How a monster reacts to storms (stormMobKind). */
export const STORM_MOB_KINDS = ['undead', 'water', 'critter', 'predator', 'bandit', 'other'] as const
export type StormMobKind = (typeof STORM_MOB_KINDS)[number]

/**
 * Monster codes to storm kinds, first match wins (the part after MOB_<region>_). Editable like the table; anything
 * unmatched is 'other' (no storm behaviour beyond the rain's sight).
 */
export const STORM_MOB_PATTERNS: readonly (readonly [StormMobKind, RegExp])[] = [
  ['critter', /^MOB_[A-Z]+_(MANGNYANG|GYO|GHOSTBUG|DEVILBUG|RABBIT|SQUIRREL|DEER|BIRD|RAT)(_|$)/],
  ['water', /^MOB_[A-Z]+_WATERGHOST(_|$)/],
  ['undead', /^MOB_[A-Z]+_([A-Z]*GHOST|TOMBSTONE|YEOHA|HYUNGNO|SKELETON|ZOMBIE|MUMMY)(_|$)/],
  ['predator', /^MOB_[A-Z]+_((WHITE)?TIGER|WOLF|[A-Z]*WOLF)(_CLON)?$/],
  ['bandit', /^MOB_[A-Z]+_(BANDIT|BANDITARCHER|THIEF)(_|$)/],
]

/** The storm kind of a monster: uniques (and anything unmatched) are 'other'. */
export function stormMobKind(code: string, unique = false): StormMobKind {
  if (unique) return 'other'
  for (const [kind, re] of STORM_MOB_PATTERNS) if (re.test(code)) return kind
  return 'other'
}

/** Beasts panic at thunder: small animals and the big cats / wolves (not the undead, not people). */
export function panics(kind: StormMobKind): boolean {
  return kind === 'critter' || kind === 'predator'
}

/** Monster sight (aggro detection radius) multiplier: the rain, then the night in a storm. */
export function sightMul(env: StormEnv, t: StormTable = STORM_TABLE): number {
  return partly(t.sightRainMul, rainK(env, t), env.strength) * partly(t.nightSightMul, nightK(env, t), env.strength)
}

/** Chase speed multiplier of a monster of `kind`. */
export function mobSpeedMul(env: StormEnv, kind: StormMobKind, t: StormTable = STORM_TABLE): number {
  return kind === 'undead' && storming(env, t) ? strong(t.undeadSpeedMul, env.strength) : 1
}

/** Outgoing damage multiplier of a monster of `kind` (a charged monster's own bonus multiplies on top). */
export function mobDamageMul(env: StormEnv, kind: StormMobKind, t: StormTable = STORM_TABLE): number {
  return kind === 'undead' && storming(env, t) ? strong(t.undeadDamageMul, env.strength) : 1
}

/** Leash and roam multipliers of a monster of `kind` (bandits pull back). */
export function mobRangeMul(env: StormEnv, kind: StormMobKind, t: StormTable = STORM_TABLE): { leash: number; roam: number } {
  if (kind !== 'bandit' || !storming(env, t)) return { leash: 1, roam: 1 }
  return { leash: strong(t.banditLeashMul, env.strength), roam: strong(t.banditRoamMul, env.strength) }
}

/** Monsters per nest multiplier of `kind`. */
export function nestCountMul(env: StormEnv, kind: StormMobKind, t: StormTable = STORM_TABLE): number {
  if (!storming(env, t)) return 1
  if (kind === 'water') return strong(t.waterCountMul, env.strength)
  if (kind === 'critter') return strong(t.critterCountMul, env.strength)
  if (kind === 'predator') return strong(t.predatorCountMul, env.strength)
  return 1
}

// ---- players ------------------------------------------------------------------------------------------------

/** Force elements: the Chinese force masteries (skills.json `mastery`). */
export type StormElement = 'fire' | 'lightning' | 'cold'

/** The element of a skill mastery code (FIRE, LIGHTNING, COLD), else null. */
export function elementOf(mastery: string | null | undefined): StormElement | null {
  return mastery === 'FIRE' ? 'fire' : mastery === 'LIGHTNING' ? 'lightning' : mastery === 'COLD' ? 'cold' : null
}

/** Damage multiplier of an element in the rain. */
export function elementMul(env: StormEnv, element: StormElement | null, t: StormTable = STORM_TABLE): number {
  if (!element) return 1
  const mul = element === 'fire' ? t.fireRainMul : element === 'lightning' ? t.lightningRainMul : t.coldRainMul
  return partly(mul, rainK(env, t), env.strength)
}

/** Whether players are wet (out in the rain). */
export function wet(env: StormEnv, t: StormTable = STORM_TABLE): boolean {
  return raining(env, t)
}

/** Lightning damage multiplier on a wet player. */
export function shockMul(env: StormEnv, t: StormTable = STORM_TABLE): number {
  return wet(env, t) ? strong(t.wetShockMul, env.strength) : 1
}

/** Mud: the run speed penalty in percent (0 = none) on a soaked ground. */
export function mudSlowPct(env: StormEnv, t: StormTable = STORM_TABLE): number {
  return env.wet >= t.mudWetMin ? Math.min(90, t.mudSlowPct * env.strength) : 0
}

/** Extra miss chance (0..1) of a ranged attack in the wind. */
export function windMiss(env: StormEnv, t: StormTable = STORM_TABLE): number {
  const k = clamp01((env.windMs - t.windFromMs) / Math.max(0.01, t.windFullMs - t.windFromMs))
  return Math.min(0.9, k * t.windMissMax * env.strength)
}

/** Extra fog (client) at night in a storm, 0..1. */
export function nightFogAdd(env: Pick<StormEnv, 'storm' | 'night' | 'strength'>, t: StormTable = STORM_TABLE): number {
  const k = env.storm >= t.stormLevelMin ? clamp01(env.night) : 0
  return clamp01(t.nightFogAdd * k * env.strength)
}

// ---- the status the client shows (the `storm` message) ------------------------------------------------------

/** calm: nothing; rain: the rain effects; forecast: a storm is coming (startsAt); storm: the storm effects too. */
export const STORM_PHASES = ['calm', 'rain', 'forecast', 'storm'] as const
export type StormPhase = (typeof STORM_PHASES)[number]

/** One active effect; the client's tooltip line is i18n `storm.effect.<id>` with {pct}. */
export const STORM_EFFECT_IDS = [
  'wet',
  'sight',
  'fire',
  'lightning',
  'cold',
  'mud',
  'wind',
  'night',
  'undead',
  'water',
  'critters',
  'packs',
  'bandits',
  'panic',
  'charged',
] as const
export type StormEffectId = (typeof STORM_EFFECT_IDS)[number]

export interface StormEffect {
  id: StormEffectId
  /** The change in percent (signed, a whole number), where the effect has one. */
  pct?: number
}

/** Wire ranges of StormStatus (validate.ts). */
export const STORM_LIMITS = { effects: STORM_EFFECT_IDS.length, pct: 1000 } as const

/** Percent change of a multiplier, rounded to 5. */
function pctOf(mul: number): number {
  return Math.round(((mul - 1) * 100) / 5) * 5
}

/** The phase of `env` (a forecast event in progress turns calm or rain into 'forecast'). */
export function stormPhase(env: StormEnv, forecast: boolean, t: StormTable = STORM_TABLE): StormPhase {
  if (storming(env, t)) return 'storm'
  if (forecast) return 'forecast'
  return raining(env, t) ? 'rain' : 'calm'
}

/** Every effect active under `env`, in STORM_EFFECT_IDS order (what the tooltip lists). */
export function stormEffects(env: StormEnv, t: StormTable = STORM_TABLE): StormEffect[] {
  const out: StormEffect[] = []
  const push = (id: StormEffectId, pct?: number) => {
    if (pct === undefined) out.push({ id })
    else if (pct !== 0) out.push({ id, pct: Math.max(-STORM_LIMITS.pct, Math.min(STORM_LIMITS.pct, pct)) })
  }
  if (env.strength <= 0) return out
  const rain = raining(env, t)
  const storm = storming(env, t)
  if (rain) push('wet', pctOf(strong(t.wetShockMul, env.strength)))
  const sight = sightMul(env, t)
  if (sight < 1) push('sight', pctOf(sight))
  if (rain) {
    push('fire', pctOf(elementMul(env, 'fire', t)))
    push('lightning', pctOf(elementMul(env, 'lightning', t)))
    push('cold', pctOf(elementMul(env, 'cold', t)))
  }
  const mud = mudSlowPct(env, t)
  if (mud > 0) push('mud', -Math.round(mud))
  const wind = windMiss(env, t)
  if (wind > 0.005) push('wind', Math.max(1, Math.round(wind * 100)))
  if (storm && env.night > 0.05) push('night', pctOf(partly(t.nightSightMul, nightK(env, t), env.strength)))
  if (storm) {
    push('undead', pctOf(strong(t.undeadDamageMul, env.strength)))
    push('water', pctOf(strong(t.waterCountMul, env.strength)))
    push('critters', pctOf(strong(t.critterCountMul, env.strength)))
    push('packs', pctOf(strong(t.predatorCountMul, env.strength)))
    push('bandits', pctOf(strong(t.banditLeashMul, env.strength)))
    push('panic')
    push('charged', pctOf(strong(t.chargedDamageMul, env.strength)))
  }
  return out
}
