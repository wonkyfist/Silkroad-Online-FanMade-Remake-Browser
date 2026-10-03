/**
 * The pure geography of "beaches everywhere" (docs/COAST.md §3B): scalar functions of one lattice vertex, ported from
 * work/tmp/coast-beach/coast_beach.py. The array pass (./pass.ts) evaluates them per vertex with the section
 * parameters blended along the coast (./sections.ts); the tests check their shape on their own.
 *
 * Units: metres. SL = sea level. `v` = metres inland of the waterline, `w` = metres seaward of it, `d` = metres past
 * the bounds (or corridor) line.
 */

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

/** Linear ramp from y0 at x0 to y1 at x1, clamped outside (the prototype's `ramp`). */
export function ramp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  return y0 + (y1 - y0) * clamp((x - x0) / Math.max(x1 - x0, 1e-6), 0, 1)
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Polynomial smooth maximum with blend width k (>= max(a, b); equal to it when |a - b| >= k). */
export function smax(a: number, b: number, k: number): number {
  const h = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1)
  return b + (a - b) * h + k * h * (1 - h)
}

/** Beach kind parameters (§3B.2), as blended per vertex. */
export interface BeachParams {
  /** Beach width, waterline -> dune crest or flank toe (m). */
  width: number
  /** Dune or backshore crest above SL (m). */
  dune: number
  /** Top of the dry sand above SL (m). */
  dry: number
  /** Flank grade behind the beach (m/m). */
  grade: number
  /** Shelf depth below SL at the three `SHELF_BREAKS_M` distances offshore (m). */
  depth: [number, number, number]
}

/** The swash band: wet sand from the waterline to SWASH_WIDTH_M inland, rising to SL + SWASH_HEIGHT_M. */
export const SWASH_WIDTH_M = 8
export const SWASH_HEIGHT_M = 0.6
/** Offshore distances (m) where the shelf reaches depth[0], depth[1], depth[2]. */
export const SHELF_BREAKS_M: readonly [number, number, number] = [120, 300, 700]

/**
 * Land-side beach height at v metres inland of the waterline: wet sand (0 .. 8 m, to SL + 0.6), dry sand (8 m .. half
 * the width, to SL + dry), then the dune or backshore (to SL + dune at the full width), flat beyond.
 */
export function beachHeight(v: number, sl: number, p: Pick<BeachParams, 'width' | 'dune' | 'dry'>): number {
  return sl + ramp(v, 0, SWASH_WIDTH_M, 0, SWASH_HEIGHT_M) + ramp(v, SWASH_WIDTH_M, p.width * 0.5, 0, p.dry - SWASH_HEIGHT_M) +
    ramp(v, p.width * 0.5, p.width, 0, p.dune - p.dry)
}

/** Shelf depth below SL at w metres offshore (piecewise linear through SHELF_BREAKS_M), without the bed noise. */
export function shelfDepth(w: number, depth: readonly [number, number, number]): number {
  const [b0, b1, b2] = SHELF_BREAKS_M
  return ramp(w, 0, b0, 0, depth[0]) + ramp(w, b0, b1, 0, depth[1] - depth[0]) + ramp(w, b1, b2, 0, depth[2] - depth[1])
}

/**
 * The flank envelope E(d) (§3B.3): starts at the bounds-line height `hb` with the incoming retail slope `sIn`, turns
 * over a rounded shoulder of length `shoulder` to the grade -g, then falls straight at -g. Continuous in value and
 * slope at d = shoulder.
 */
export function envelope(d: number, hb: number, sIn: number, g: number, shoulder: number): number {
  if (d < shoulder) return hb + sIn * d - ((sIn + g) * d * d) / (2 * shoulder)
  return hb + ((sIn - g) * shoulder) / 2 - g * (d - shoulder)
}

/** Distance past the line where the envelope reaches the dune crest (SL + dune): the flank's toe (>= 0). */
export function toeDistance(hb: number, sIn: number, g: number, shoulder: number, sl: number, dune: number): number {
  return Math.max(shoulder + (hb + ((sIn - g) * shoulder) / 2 - sl - dune) / g, 0)
}

/**
 * Hinterland behind a beach: the profile rises gently (riseSlope m/m) from riseBehindM behind the crest. This is the
 * cap for low ground; the envelope takes over where it is higher (smooth max, so the toe is concave).
 */
export function hinterlandRise(prof: number, v: number, width: number, riseSlope: number, riseBehindM: number): number {
  return prof + riseSlope * Math.max(v - width - riseBehindM, 0)
}

/**
 * On the lowered flank, retail relief under the envelope survives only as gullies of at most `relief` metres:
 * cap - relief * tanh(max(cap - retailBlurred, 0) / relief).
 */
export function flankFill(cap: number, retailBlurred: number, relief: number): number {
  return cap - relief * Math.tanh(Math.max(cap - retailBlurred, 0) / relief)
}

/**
 * The waterline offset past the line (m), §3B.1: the noisy section offset, pushed out to the flank's toe plus the beach
 * width where a mountain needs the room, never nearer than `minOffset` on sections whose c0 is at least `flankFromC0`;
 * sections that lie inside the bounds (S1, S2) are clamped to `insideClamp`.
 */
export function waterlineOffset(o: {
  c0: number
  amp: number
  n1: number
  n2: number
  keep: number
  toe: number
  width: number
}, w: WaterlineRule): number {
  const cNoise = o.c0 + o.amp * w.n1Amp * o.n1 + w.n2AmpM * o.n2
  if (o.c0 >= w.flankFromC0M) {
    const cFlank = o.keep + o.toe + o.width * (1 + w.flankWidthNoise * o.n1) + w.flankN2AmpM * o.n2
    return Math.max(Math.max(cNoise, cFlank), w.minOffsetM)
  }
  if (o.c0 < w.insideC0[1] && o.c0 > w.insideC0[0]) return clamp(cNoise, w.insideClampM[0], w.insideClampM[1])
  return cNoise
}

export interface WaterlineRule {
  /** Amplitude factor on the section's amp for the 1,100 m noise (unit sigma). */
  n1Amp: number
  /** Amplitude (m) of the 90 m noise. */
  n2AmpM: number
  /** Beach width varies by this fraction with the 1,100 m noise on flank sections. */
  flankWidthNoise: number
  /** Amplitude (m) of the 90 m noise on the flank waterline. */
  flankN2AmpM: number
  minOffsetM: number
  flankFromC0M: number
  /** Open interval of c0 where the inside clamp applies (S1, S2). */
  insideC0: [number, number]
  insideClampM: [number, number]
}

export const WATERLINE_RULE: WaterlineRule = {
  n1Amp: 0.8,
  n2AmpM: 4,
  flankWidthNoise: 0.15,
  flankN2AmpM: 3,
  minOffsetM: 18,
  flankFromC0M: 25,
  insideC0: [-150, -5],
  insideClampM: [-105, -12],
}

/**
 * Flank paint weights by slope (beaches fact-check G7; WAVE_PLAN6 D28): grass tiles up to grassMaxDeg, a blend to rock
 * over grassMaxDeg .. rockFromDeg, rock above. Returns the rock weight (0 = grass, 1 = rock).
 */
export function flankRockWeight(slopeDeg: number, grassMaxDeg: number, rockFromDeg: number): number {
  return smoothstep(grassMaxDeg, rockFromDeg, slopeDeg)
}

/** Round half to even (numpy's np.round and Python's round), so lattice indices match the prototype on ties. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}
