/**
 * Lightning that strikes (docs/WEATHER.md §2.7, docs/PROTOCOL.md "Weather"): the numbers and the pure maths the server
 * and the client share. The server places every strike (`strike` message) and lands it after a telegraph; the client
 * draws the bolt, the flash and the thunder from the same seed, so every player sees the same bolt in the same place.
 *
 * - Kinds: `ground`, `tree` (a tree top), `wall` (the walk of an outer wall), `tower`, `entity` (aimed at a player or a
 *   monster's spot) and `sky` (a flash inside the cloud: no ground contact, no damage, no telegraph).
 * - Return strokes: 2-4 within 0.3-0.5 s from the strike seed (`strikeStrokes`); the bolt's flicker and the sky flash
 *   both follow `strokeBrightness`.
 */
import { mulberry32 } from './weather.ts'

export const STRIKE_KINDS = ['ground', 'tree', 'wall', 'tower', 'entity', 'sky'] as const
export type StrikeKind = (typeof STRIKE_KINDS)[number]

/**
 * Damage without an attacker (`combat.cause`, attacker 0). Later steps of the storm series add their own: `arc` is a
 * storm-charged monster's hit arcing to a player nearby (docs/WEATHER.md §12.4).
 */
export const HAZARD_CAUSES = ['lightning', 'arc', 'tornado', 'keg'] as const
export type HazardCause = (typeof HAZARD_CAUSES)[number]

/** Who threw a strike (LightningStrike.source, additive): a tornado's bolts (docs/WEATHER.md §13). */
export const STRIKE_SOURCES = ['tornado'] as const
export type StrikeSource = (typeof STRIKE_SOURCES)[number]

/** Warning to landing, ms: every strike that can hurt is telegraphed this long before (seeded per strike). */
export const STRIKE_TELEGRAPH_MS = [1200, 1800] as const

/** Damage radius by kind (m): around the impact (ground, entity), the trunk's foot (tree), the impact (wall, tower). */
export const STRIKE_RADIUS_M: Readonly<Record<StrikeKind, number>> = { ground: 4, entity: 4, tree: 3.5, wall: 3, tower: 3, sky: 0 }

/** A body more than this far above or below the strike's ground point (m) is not in its radius (a bridge, a wall walk). */
export const STRIKE_VERTICAL_M = 3

/** Wire ranges of LightningStrike (validate.ts). */
export const STRIKE_LIMITS = { radiusM: 12, coord: 1_000_000 } as const

/** The bolt starts this far above the impact (m): the storm's cloud base. */
export const BOLT_CLOUD_M = 320

export interface Stroke {
  /** Seconds after the strike's `at`. */
  t: number
  /** Relative brightness of this return stroke (the first is 1). */
  peak: number
}

/** The return strokes of a strike: 2-4, the first at 0, the last 0.3-0.5 s later (seeded, the same on every client). */
export function strikeStrokes(seed: number): Stroke[] {
  const r = mulberry32((seed ^ 0x51ed270b) >>> 0)
  const n = 2 + Math.floor(r() * 3)
  const span = 0.3 + 0.2 * r()
  const out: Stroke[] = [{ t: 0, peak: 1 }]
  // n - 2 strokes inside (0.05, span - 0.05), kept 40 ms apart, then the last at `span`
  const inner: number[] = []
  for (let i = 0; i < n - 2; i++) inner.push(0.05 + (span - 0.1) * r())
  inner.sort((a, b) => a - b)
  let last = 0
  for (const t of inner) {
    const at = Math.max(t, last + 0.04)
    if (at > span - 0.04) break
    out.push({ t: at, peak: 0.55 + 0.35 * r() })
    last = at
  }
  out.push({ t: span, peak: 0.5 + 0.35 * r() })
  return out
}

/** Decay of one return stroke (s). */
const STROKE_DECAY_S = 0.035
/** The channel's glow between strokes (continuing current), relative to the first stroke. */
const CHANNEL_GLOW = 0.12

/**
 * The channel's brightness `tS` seconds after the strike (0 before it; about 1 at a stroke; the faint continuing-current
 * glow between strokes; gone ~0.15 s after the last).
 */
export function strokeBrightness(strokes: readonly Stroke[], tS: number): number {
  if (!(tS >= 0) || strokes.length === 0) return 0
  const end = strokes[strokes.length - 1]!.t
  if (tS > end + 0.25) return 0
  let b = tS <= end + 0.06 ? CHANNEL_GLOW * (tS > end ? 1 - (tS - end) / 0.06 : 1) : 0
  for (const s of strokes) if (tS >= s.t) b += s.peak * Math.exp(-(tS - s.t) / STROKE_DECAY_S)
  return Math.min(1.5, b)
}

/** The sky flash (WeatherFrame.flash, 0..3) of a strike `distM` from the viewer at peak: 3 close, about 1 at 2.5 km. */
export function strikeFlashPeak(distM: number): number {
  return 3 * Math.min(1, Math.max(0.3, 1.15 - Math.max(0, distM) / 3000))
}

/** The telegraph length of a strike (ms), from its seed. */
export function telegraphMs(seed: number): number {
  const r = mulberry32((seed ^ 0x7e1e9a4f) >>> 0)
  return Math.round(STRIKE_TELEGRAPH_MS[0] + (STRIKE_TELEGRAPH_MS[1] - STRIKE_TELEGRAPH_MS[0]) * r())
}
