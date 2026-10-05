/**
 * Lightning's client timeline (docs/WEATHER.md §7.3b), pure: what a strike shows at a given server time, and what each
 * graphics tier draws. fx.ts draws it; the feature (world/features/lightning.ts) feeds it the `strike` messages.
 *
 * - Telegraph: from `warnAt` to `at`, rising (telegraphLevel). Always shown, at every tier and with the weather off:
 *   it is the fair warning of a strike that can hurt.
 * - Bolt: `strokeBrightness` of the strike's return strokes from `at` (2-4 within 0.3-0.5 s); forks only in the first.
 * - Aftermath by kind: a scorch (ground, wall walk, tree foot), dirt, sparks and steam rings when wet (ground), stone
 *   chips and falling dust (wall, tower), a burning tree (fire, embers, smoke for FIRE_MS; the trunk charred and split).
 * - Tiers (from the weather level, Options → Graphics → Weather): off = the flash (weather feature) and the telegraph;
 *   low = + the bolt and the scorch; medium = everything; high/ultra = everything with more particles.
 */
import { strikeStrokes, strokeBrightness, type LightningStrike, type Stroke } from '@sro/shared'

export type LightningTier = 'off' | 'low' | 'medium' | 'high'

export interface TierFeatures {
  bolt: boolean
  scorch: boolean
  /** Sparks, dirt, steam, chips, dust. */
  bursts: boolean
  /** The burning tree, the charred trunk. */
  fire: boolean
  /** The telegraph's static arcs (the glow ring shows at every tier). */
  staticArcs: boolean
  /** Particle counts × this. */
  particles: number
}

export const TIER_FEATURES: Readonly<Record<LightningTier, Readonly<TierFeatures>>> = {
  off: { bolt: false, scorch: false, bursts: false, fire: false, staticArcs: false, particles: 0 },
  low: { bolt: true, scorch: true, bursts: false, fire: false, staticArcs: true, particles: 0 },
  medium: { bolt: true, scorch: true, bursts: true, fire: true, staticArcs: true, particles: 1 },
  high: { bolt: true, scorch: true, bursts: true, fire: true, staticArcs: true, particles: 1.6 },
}

/** The tier of a weather level (settings.ts weatherLevelFor). */
export function tierFor(level: string | null | undefined): LightningTier {
  if (level === 'low') return 'low'
  if (level === 'medium') return 'medium'
  if (level === 'high' || level === 'ultra') return 'high'
  return 'off'
}

/** How long a burning tree burns (ms), and its smoke lingers after. */
export const FIRE_MS = 60_000
export const SMOKE_TAIL_MS = 20_000
/** A scorch mark stays this long (ms), fading over the last SCORCH_FADE_MS. */
export const SCORCH_MS = 150_000
export const SCORCH_FADE_MS = 40_000
/** The split in a struck trunk glows this long (ms). */
export const SPLIT_GLOW_MS = 25_000
/** The bolt shows until this long after its last stroke (s). */
export const BOLT_TAIL_S = 0.25
/** Forks show only this long into the first stroke (s). */
export const FORK_S = 0.09

/** 0 outside the telegraph; rising 0.35 → 1 from `warnAt` to `at`. */
export function telegraphLevel(s: Pick<LightningStrike, 'warnAt' | 'at'>, now: number): number {
  if (s.warnAt === undefined || now < s.warnAt || now >= s.at) return 0
  const k = (now - s.warnAt) / Math.max(1, s.at - s.warnAt)
  return 0.35 + 0.65 * k
}

const strokeCache = new Map<number, Stroke[]>()

/** The strokes of a seed (cached: a strike asks every frame). */
export function strokesOf(seed: number): Stroke[] {
  let s = strokeCache.get(seed)
  if (!s) {
    if (strokeCache.size > 32) strokeCache.clear()
    strokeCache.set(seed, (s = strikeStrokes(seed)))
  }
  return s
}

/** The bolt's brightness at `now` (0 = not drawn) and whether its forks show. */
export function boltState(s: Pick<LightningStrike, 'at' | 'seed'>, now: number): { glow: number; forks: boolean } {
  const t = (now - s.at) / 1000
  if (t < 0) return { glow: 0, forks: false }
  const strokes = strokesOf(s.seed)
  if (t > strokes[strokes.length - 1]!.t + BOLT_TAIL_S) return { glow: 0, forks: false }
  return { glow: strokeBrightness(strokes, t), forks: t < FORK_S }
}

/** Whether the strike's bolt is over (its effects stay). */
export function boltDone(s: Pick<LightningStrike, 'at' | 'seed'>, now: number): boolean {
  const strokes = strokesOf(s.seed)
  return (now - s.at) / 1000 > strokes[strokes.length - 1]!.t + BOLT_TAIL_S
}

/** A burning tree `ageMs` after the strike: fire, embers and smoke 0..1. */
export function fireLevels(ageMs: number): { fire: number; embers: number; smoke: number } {
  if (ageMs < 0 || ageMs > FIRE_MS + SMOKE_TAIL_MS) return { fire: 0, embers: 0, smoke: 0 }
  const k = ageMs / FIRE_MS
  // flares up over 1.5 s, burns, dies down over the last 40 %
  const fire = ageMs > FIRE_MS ? 0 : Math.min(1, ageMs / 1500) * (k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4))
  const embers = ageMs > FIRE_MS * 0.85 ? 0 : fire
  const smoke = ageMs < 800 ? ageMs / 800 : ageMs < FIRE_MS ? 0.6 + 0.4 * fire : Math.max(0, 1 - (ageMs - FIRE_MS) / SMOKE_TAIL_MS) * 0.6
  return { fire, embers, smoke }
}

/** A scorch mark's opacity `ageMs` after the strike. */
export function scorchAlpha(ageMs: number): number {
  if (ageMs < 0 || ageMs >= SCORCH_MS) return 0
  const fade = SCORCH_MS - SCORCH_FADE_MS
  return ageMs < fade ? 1 : 1 - (ageMs - fade) / SCORCH_FADE_MS
}
