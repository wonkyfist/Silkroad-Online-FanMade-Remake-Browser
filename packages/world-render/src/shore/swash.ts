/**
 * Portions ported from Tidewater (github.com/dgreenheck/tidewater, `ShoreWaves.js` at `4811ba4`), MIT licence, Copyright (c)
 * 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.
 *
 * Shore v1's numbers (docs/COAST.md §8.8, §12.5): the swash cycle of `ShoreWaves.js`' `shoreSwashRunup` (an uprush over
 * 40 % of the period that decelerates, a backwash over 55 % that starts slowly and speeds up, a thin film that never
 * uncovers the waterline), the Gerstner shore swell (Green's law shoaling, breaking at H = 0.78 d) and the run-up
 * height. Written from COAST §8.8's description of those functions (the upstream source was not re-read for this lane).
 * These are the CPU reference of the shaders in shore/chunks.ts and coast/chunks.ts (the same constants and formulas)
 * and the source of the shore's uniforms (shore/index.ts); test/shore-swash.test.ts checks them.
 */

/** The uprush takes this share of the wave period, the backwash the next 55 %; the rest is the resting film. */
export const UPRUSH_SHARE = 0.4
export const BACKWASH_SHARE = 0.55
/** The uprush decelerates as `1 − (1 − s)^1.5`; the backwash speeds up as `1 − s^1.6`. */
export const UPRUSH_EXP = 1.5
export const BACKWASH_EXP = 1.6
/** The minimum film above the sea level (m): the waterline is never uncovered. */
export const MIN_FILM_M = 0.03
/** The nominal beach slope (horizontal per vertical) that turns the run-up into a reach up the sand (COAST §3.2). */
export const NOMINAL_SLOPE = 13
/** Mean land slope (rise per run from the shoreline) where the swash sheet stops (rock, steep banks). */
export const ROCK_SLOPE: readonly [number, number] = [0.2, 0.35]
/** Breaking: H > γ · d (Tidewater's γ). */
export const BREAK_GAMMA = 0.78
/** Green's law H ∝ d^−¼ is referenced to this depth (m): the shore swell has its incoming height there. */
export const GREEN_REF_DEPTH_M = 4
/** The shallowest depth the shoaling formulas use (m). */
export const MIN_DEPTH_M = 0.05
/** The shore swell lives within this distance of the shoreline (m; the field's signed distance reaches ±63.75 m). */
export const SWELL_ZONE_M: readonly [number, number] = [44, 60]
/** Gravity (m/s²). */
export const G_ACCEL = 9.81
/** The cycle counter wraps here (cycles): small enough for float32 in the shaders, a whole number of waves. */
export const PHASE_WRAP = 256
/** The wet sand's receding sheen fades over this (s). */
export const SHEEN_FADE_S = 2.5
/** The damp band below the maximum run-up: its wetness, and where it starts to fade (× R_max). */
export const DAMP_WETNESS = 0.4
export const DAMP_FADE_START = 0.45
/** Covered sand below the sea level is only this wet (the sea's absorption darkens it already). */
export const UNDERWATER_WETNESS = 0.5
/**
 * P-LOOK (wave 10 polish): beach cusps. A wave's run-up also varies along the shore at this scale (m), down to
 * (1 − CUSP_SHARE) of its lobe, differently from wave to wave, so the swash front and the line it leaves on the sand
 * are scalloped instead of a ruler-straight contour (the sheet in shore/chunks.ts and the wet band in coast/chunks.ts).
 */
export const CUSP_M = 4.5
export const CUSP_SHARE = 0.3
/**
 * P-LOOK: the wet band's ragged edge. The height its edges test (the film edge, the reach line, the damp band's fade)
 * is jittered by ± WET_EDGE_JITTER_M at three fine scales (m; weights 0.5, 0.3, 0.2), so the dark sand ends in an
 * irregular line like the lace beside it; and the film edge and the reach line are feathered over WET_FEATHER_M of
 * height (one-sided, inward).
 */
export const WET_EDGE_JITTER_M = 0.05
export const WET_EDGE_SCALES_M: readonly [number, number, number] = [2.6, 0.9, 0.37]
export const WET_FEATHER_M = 0.025

/** The run-up's share of its maximum at cycle phase `s` (0..1, 0 = the bore reaches the shoreline). */
export function swashCycle(s: number): number {
  const p = s - Math.floor(s)
  if (p < UPRUSH_SHARE) return 1 - (1 - p / UPRUSH_SHARE) ** UPRUSH_EXP
  if (p < UPRUSH_SHARE + BACKWASH_SHARE) return 1 - ((p - UPRUSH_SHARE) / BACKWASH_SHARE) ** BACKWASH_EXP
  return 0
}

/** The swash sheet's height above the sea level (m) at phase `s` for a wave whose run-up is `runupM`. */
export function swashHeight(s: number, runupM: number): number {
  return MIN_FILM_M + Math.max(0, runupM - MIN_FILM_M) * swashCycle(s)
}

/**
 * The maximum vertical run-up (m) for a significant wave height: COAST §8.8's `0.15 + 0.25 Hs`, ≤ 0.8 m. (The look
 * check on S1 tried Tidewater's ≈ wave height, `0.2 + 0.45 Hs`: on S1's 1:25 sand that floods the whole 13 m beach
 * up to the grass on every wave, so COAST's value stands: a 5–8 m reach on a clear day.)
 */
export function maxRunup(hs: number): number {
  return Math.min(0.8, Math.max(0.15, 0.15 + 0.25 * Math.max(0, hs)))
}

/** The shore swell's incoming height (crest to trough, m) at the reference depth, from the sea state's Hs. */
export function shoreSwellHeight(hs: number, storm: number): number {
  return Math.min(1.6, Math.max(0.25, 0.3 + 0.5 * Math.max(0, hs))) * (1 + 0.3 * Math.min(1, Math.max(0, storm)))
}

/** Shallow-water celerity (m/s). */
export function celerity(depthM: number): number {
  return Math.sqrt(G_ACCEL * Math.max(depthM, MIN_DEPTH_M))
}

/** The travel time (s) from a point `distanceM` off the shoreline at depth `depthM` to the shoreline: exact on a planar slope. */
export function travelTime(distanceM: number, depthM: number): number {
  return (2 * Math.max(0, distanceM)) / celerity(depthM)
}

/** The shoaled height (m) at a depth by Green's law, before breaking. */
export function greenHeight(h0: number, depthM: number): number {
  return h0 * (GREEN_REF_DEPTH_M / Math.max(depthM, MIN_DEPTH_M)) ** 0.25
}

/** The height after breaking (m): Green's law until H = γ d, then the bore's γ d. */
export function shoreHeight(h0: number, depthM: number): number {
  return Math.min(greenHeight(h0, depthM), BREAK_GAMMA * Math.max(depthM, 0))
}

/** The depth (m) where a wave of incoming height `h0` breaks (H = γ d). */
export function breakDepth(h0: number): number {
  // h0 (dr / d)^¼ = γ d  →  d^(5/4) = h0 dr^¼ / γ
  return ((h0 * GREEN_REF_DEPTH_M ** 0.25) / BREAK_GAMMA) ** 0.8
}

/** Whether a wave of height `h0` has broken at a depth (0 … 1, the shaders' smooth version). */
export function brokenAt(h0: number, depthM: number): number {
  const r = greenHeight(h0, depthM) / Math.max(BREAK_GAMMA * Math.max(depthM, 0), 1e-3)
  return smoothstep(0.85, 1, r)
}

/** The swash front's height above the sea level (m) on a beach of slope `1 : slope` at a moment: where the sand equals the run-up. */
export function frontDistance(s: number, runupM: number, slope = NOMINAL_SLOPE): number {
  return swashHeight(s, runupM) * slope
}

/** The analytic bead (COAST §8.8, refresh R4): foam where the swash film `SL + R(t) − h_sand` is thinner than this (m). */
export const BEAD_FILM_M = 0.03

/** The bead's weight (0..1) for a film thickness (m): 1 at the front, 0 wherever the film is BEAD_FILM_M or thicker. */
export function bead(filmM: number): number {
  return filmM < -0.005 ? 0 : 1 - smoothstep(0, BEAD_FILM_M, filmM)
}

/** Mean land slope over which the swash sheet still runs (1 = full sheet, 0 = rock: only the minimum film). */
export function sheetWeight(meanSlope: number): number {
  return 1 - smoothstep(ROCK_SLOPE[0], ROCK_SLOPE[1], meanSlope)
}

/**
 * The terrain's coast wetness (0..1) at a height `h` above the sea level (the CPU twin of `sroCoastWet`): the damp
 * band below the maximum run-up, the covered sand, and the receding sheen where the backwash uncovered it in the last
 * seconds. `s` is the cycle phase there and `waveRunupM` this wave's run-up there (≤ `maxRunupM`: the lobe and the
 * cusp included). `jitterM` is the ragged edge's height jitter there (`wetEdgeJitter`; 0 = the smooth contours). The film
 * edge and the reach line are feathered inward over WET_FEATHER_M, so the result is 0 at and above `maxRunupM` (with no
 * jitter) and 1 under a film of at least WET_FEATHER_M.
 */
export function coastWetness(h: number, s: number, waveRunupM: number, maxRunupM: number, periodS: number, jitterM = 0): number {
  const he = h + jitterM
  if (he >= maxRunupM) return 0
  const damp = DAMP_WETNESS * (1 - smoothstep(DAMP_FADE_START * maxRunupM, maxRunupM, he))
  const p = s - Math.floor(s)
  const now = swashHeight(p, waveRunupM)
  // When the backwash uncovered height he: R(su) = he on the falling limb; the sheen fades out toward the reach.
  const q = Math.min(1, Math.max(0, (he - MIN_FILM_M) / Math.max(waveRunupM - MIN_FILM_M, 1e-4)))
  const su = UPRUSH_SHARE + BACKWASH_SHARE * (1 - q) ** (1 / BACKWASH_EXP)
  const since = ((p < UPRUSH_SHARE ? p + 1 : p) - su) * periodS
  const sheen = since >= 0 ? Math.exp(-since / SHEEN_FADE_S) * (1 - smoothstep(waveRunupM - WET_FEATHER_M, waveRunupM, he)) : 0
  const base = Math.max(damp, sheen)
  const cover = smoothstep(0, WET_FEATHER_M, now - he)
  return base * (1 - cover) + (he < 0 ? UNDERWATER_WETNESS : 1) * cover
}

/** A wave's cusp factor along the shore (1 − CUSP_SHARE … 1): scalloped fronts that differ from wave to wave. */
export function cusp(x: number, z: number, wave: number): number {
  const o = hash12(wave, 3.1) * 89
  return 1 - CUSP_SHARE * noise2(x / CUSP_M + o, z / CUSP_M - o * 0.73)
}

/** The wet band's ragged-edge height jitter (m, ± WET_EDGE_JITTER_M) at glTF (x, z). */
export function wetEdgeJitter(x: number, z: number): number {
  const [a, b, c] = WET_EDGE_SCALES_M
  return WET_EDGE_JITTER_M * 2 * (0.5 * noise2(x / a + 2.9, z / a + 8.1) + 0.3 * noise2(x / b, z / b) + 0.2 * noise2(x / c + 5.3, z / c + 1.7) - 0.5)
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The shader's hash (Dave Hoskins' hash12): the same arithmetic in shore/chunks.ts and coast/chunks.ts. */
export function hash12(x: number, y: number): number {
  const fr = (v: number) => v - Math.floor(v)
  let a = fr(x * 0.1031), b = fr(y * 0.1031), c = fr(x * 0.1031)
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33)
  // dot(p3, p3.yzx + 33.33) with p3 = (a, b, c): a (b + 33.33) + b (c + 33.33) + c (a + 33.33)
  a += d
  b += d
  c += d
  return fr((a + b) * c)
}

/** The shaders' value noise (0..1) on a unit lattice. */
export function noise2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  const a = hash12(ix, iy), b = hash12(ix + 1, iy), c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** The along-shore phase offset (cycles) at glTF (x, z): crests bend and the swash runs up at different moments. */
export function phaseOffset(x: number, z: number): number {
  return 0.6 * (noise2(x / 90, z / 90) - 0.5) + 0.25 * (noise2(x / 37 + 17.3, z / 37 + 5.1) - 0.5)
}

/** A wave's run-up share along the shore (0.6 … 1): lobed fronts that differ from wave to wave. */
export function lobe(x: number, z: number, wave: number): number {
  const o = hash12(wave, 7.7) * 97
  return 0.6 + 0.4 * noise2(x / 14 + o, z / 14 + o * 0.61)
}
