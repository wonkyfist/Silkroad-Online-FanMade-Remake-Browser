/**
 * The procedural coast pass (docs/COAST.md §5.3 with the §3B "beaches everywhere" geometry): retail heights on the
 * coast lattice in, coast heights and surface classes out. A port of work/tmp/coast-beach/coast_beach.py, step for
 * step (work/tmp/coast-port/parity.ts compared it with the prototype's arrays on the retail heights); on top of it, the
 * fact-check fixes the config switches on (./config.ts): the inward-only S1 feather (G2), the shoulder that also
 * continues a falling slope (G11), the tomb regrade that continues the kept face (G12, with the face slope measured
 * over tombKeep.faceSampleM and allowed down to -maxFaceSlope), the hole rule at -100 m (G5), and the phase split
 * (sections above the config's phase are land edges, kept retail, with the fade on the sea side and the corner rule
 * C13).
 *
 * CST-C phase 1 departs from the prototype where the prototype was wrong (so the arrays no longer match it bit for
 * bit): the incoming slope is blurred over the ground outside the line only (inside, its sample point lands on the
 * lattice border); the 6 m smoothing is normalised over the ground the coast shapes, so the frozen heights never leak
 * across the line; where the export ring is retail filler (0 m), the ground right outside the line blends from the
 * line's height continued with the incoming slope (the prototype left steps of up to 10 m on the east and north-east
 * lines); behind the tomb the ring blends from the keep line, not the bounds line (no kink on the keep line); dry
 * playable ground is never sea; and the lattice-sized intermediates are Float32 (the pass holds dozens of them).
 * CST-C phase 2 (W, NW and Option A's corridor): the corridor is retail scenery and stays retail bit for bit (C12), as
 * the playable set does, its dry ground is never sea and never sand, and the ring next to it blends from its faces (the
 * distance past the bounds or the corridor, whichever is nearer); the prototype shaped the corridor like the ring.
 *
 * What it does, in order (metres; SL = sea level; s = distance past the bounds or corridor line):
 * 1. masks: retail data, retail water, filler (0 m), the playable set, the export ring (active regions, one vertex
 *    wider), the corridor, the kept set (retail that stays retail at the start), the height patches (S1);
 * 2. the section field (./sections.ts): c0, amp, beach width, dune, dry sand, flank grade, shelf depths, land edge;
 * 3. the flank envelope (§3B.3): the line height Hb and the incoming retail slope s_in at the nearest line point,
 *    blurred along the line (40 m at the line, 150 m by 200 m out); the tomb keep (§3B.4) replaces them north of
 *    the plaza with the keep line; the shoulder, the grade, the ridge noise, the toe;
 * 4. the waterline: the noisy section offset, pushed out to toe + beach width (./profile.ts waterlineOffset);
 * 5. land: retail (extended beyond the kept set), the beach profile, the hinterland rise, the envelope cap (smooth
 *    max at the toe), the flank fill that keeps retail relief only as gullies, the river-mouth keep;
 * 6. sea: the shelf depth with bed noise, joined to retail water beds near the kept set;
 * 7. retail water beds: inland ones keep their bed, a sea-coast beach band fills them;
 * 8. smoothing of the reshaped and synthetic ground; the blend into the retail ring (exact on the line, 40 m ramp);
 *    the playable set frozen except the patches; the corridor and the tomb keep bit for bit; the land edges back to
 *    retail;
 * 9. surface classes (sea, sand, wet sand, retail water) and the census numbers.
 *
 * Deterministic: integer-hash noise, no clock, no random input. Node-free.
 */
import type { CoastConfig } from './config.ts'
import { extrapolate, gblur, maskToFloat, percentile, slopeDeg, stdDev } from './grid.ts'
import { CELL_M, CELLS_PER_REGION, latticeShape, nearestOnRect, playLine, REGION_M, sdfRect, type LatticeShape, type RegionRect } from './lattice.ts'
import { fbm, hash2 } from './noise.ts'
import {
  beachHeight, clamp, envelope, flankFill, hinterlandRise, roundHalfEven, shelfDepth, smax, smoothstep, toeDistance,
  WATERLINE_RULE, waterlineOffset,
} from './profile.ts'
import { controlPoints, sectionField } from './sections.ts'

/** The noise frame's origin (region units): the prototype's metres are measured from region (168, 97)'s corner. */
export const NOISE_ORIGIN: readonly [number, number] = [168, 97]

/** Surface classes of the result (the prototype's `cls`). */
export const COAST_CLASS = { land: 0, sea: 1, sand: 2, wetSand: 3, retailWater: 6 } as const

// Constants of the prototype that coast.json does not expose (they shape the procedure, not the look).
/** Ridge noise on the flank: fades in over the first RIDGE_IN_M past the line, out over the last [80, 10] m before the
 *  toe, and only on flanks whose toe lies more than RIDGE_MIN_TOE_M out. */
const RIDGE_IN_M = 60
const RIDGE_OUT_M: readonly [number, number] = [80, 10]
const RIDGE_MIN_TOE_M = 100
/** The flank fill fades in where the envelope stands 0 .. FLANK_FADE_M above the hinterland. */
const FLANK_FADE_M = 15
/** Sea-bed noise: amplitude (m), wavelength (m), octaves, seed offset, ramp-in offshore (m). */
const BED_NOISE = { ampM: 1.2, wavelengthM: 60, octaves: 2, seedOffset: 55, rampM: 40 }
/** Coastline noise: 1,100 m 5 octaves (normalised to unit sigma over the domain) and 90 m 2 octaves. */
const N1 = { wavelengthM: 1100, octaves: 5, seedOffset: 0 }
const N2 = { wavelengthM: 90, octaves: 2, seedOffset: 101 }
/**
 * The height patches' shoreline (X2, look item 3: S1's waterline read ruler-straight): small bays (5 m at 60 m, two
 * octaves) and beach cusps (2 m at 22 m) on the waterline offset. Faded in over `fadeR` regions, `marginR` inside the
 * first whole region of the patch's x range and its east end (clear of the 6 m smoothing), and out north of the patch,
 * so no other section, region or authored layer changes (165_89's layer stays valid).
 */
const PATCH_SHORE = { bayAmpM: 5, bayWavelengthM: 60, cuspAmpM: 2, cuspWavelengthM: 22, seedOffset: 303, fadeR: 0.3, marginR: 0.1 }
/**
 * The inland sand edge (the patch's PATCH_SAND_M and every beach's BW + SAND_BEHIND_M behind the waterline) wanders by
 * up to ampM (m) on a 3-octave noise from wavelengthM down, plus a per-vertex dither of ±ditherM, so the 2 m paint grid
 * blends the sand and the grass into a ragged edge instead of a ruler line (X2, look items 1-2). A beach keeps at least
 * BW + SAND_BEHIND_M / 2.
 */
const SAND_WANDER = { ampM: 22, wavelengthM: 44, octaves: 3, seedOffset: 211, ditherM: 3 }
/** Retail beds near the kept set: the synthetic floor joins them over RETAIL_BED_FADE_M, sloping RETAIL_BED_DROP. */
const RETAIL_BED_FADE_M = 300
const RETAIL_BED_DROP = 0.06
const RETAIL_BED_BLUR_CELLS = 30
/** Extension of the kept ground: falls this much per metre, then blurred (cells). */
const EXTEND_DROP = 0.55
const EXTEND_BLUR_CELLS = 6
/** Patch weight blur (cells) and the swash width used for the classes. */
const PATCH_BLUR_CELLS = 3
/** Sand classes: slope limit (deg), band behind the beach (m), wet band (m); patch sand depth (m). */
const SAND_MAX_SLOPE_DEG = 24
const SAND_BEHIND_M = 12
const WET_BAND_M = 9
const PATCH_SAND_M = 48

export interface CoastPassInput {
  /** Retail heights (m) on the coast lattice (./lattice.ts layout); NaN where there is no retail data. */
  heights: Float64Array
  /** Retail water surface (m) per lattice vertex; NaN where there is no water block. */
  water: Float64Array
  /** mapinfo.mfo's active flag of a region. */
  active: (x: number, z: number) => boolean
  /** The playable rectangle (manifest stream.playable; regions, inclusive). */
  playable: RegionRect
  /** The exported regions' rectangle (regions, inclusive; inactive regions inside it are holes). */
  exportRect: RegionRect
}

export interface CoastMasks {
  /** Retail data present (after the hole rule). */
  have: Uint8Array
  /** Retail water above the ground. */
  wetR: Uint8Array
  kept: Uint8Array
  /** Inside an allowHeightPatches rectangle (and patchable). */
  patch: Uint8Array
  inPlay: Uint8Array
  inExp: Uint8Array
  inCorr: Uint8Array
  tombKeep: Uint8Array
  /** Retail water beds filled by a sea-coast beach band. */
  bandFill: Uint8Array
  waterSurface: Uint8Array
  /** Retail water at the sea level (a water block within 0.5 m of SL over the ground): ./banks.ts seeds from it. */
  waterLow: Uint8Array
  /** Under the sea after the pass (./drown.ts, coast.json drown); absent when nothing drowns. */
  drowned?: Uint8Array
  /** In-bounds retail sea-level water made open sea (./drown.ts, coast.json drown.openWater); absent when none. */
  opened?: Uint8Array
  /** The open water's smoothed bed (./drown.ts: drown.openWater's sea out of play): the river-mouth keep and the beach
   *  rule are over there (./checks.ts). */
  openBed?: Uint8Array
}

export interface CoastStats {
  seaLevel: number
  domain: [number, number, number, number]
  grid: [number, number]
  phase: number
  landFrac: number
  sandPx: number
  /** Counts below: "ring" = kept retail outside the bounds and the corridor, "band" = dry ground outside them within
   *  700 m of the waterline; both leave out land edges (landFade >= 0.5), which stay retail. */
  /** Playable vertices changed by more than 1 cm. */
  playChanged: number
  /** Of those, outside the patch rectangles themselves (G2: must be 0). */
  playChangedOutsidePatch: number
  ringLoweredOver2m: number
  ringLoweredMax: number
  ringRaisedOver2m: number
  ringRaisedMax: number
  ringVolumeRemovedMm3: number
  ringDryBecomesSea: number
  tombKeepVertices: number
  tombKeepBitIdentical: boolean
  steepOver45OutsideBounds: number
  maxSlopeOutsideBoundsDeg: number
  p999SlopeOutsideBoundsDeg: number
  minH: number
  maxH: number
}

export interface CoastResult {
  shape: LatticeShape
  /** Final heights (m). */
  h: Float64Array
  /** COAST_CLASS per vertex. */
  cls: Uint8Array
  /** Signed distance to the waterline (m; > 0 seaward). */
  u: Float32Array
  /** Distance past the bounds or corridor line (m; < 0 inside). */
  s: Float32Array
  /** 0 = sea coast, 1 = land edge (kept retail). */
  landFade: Float32Array
  /** Patch weight actually applied (0 outside the patches). */
  patchWeight: Float32Array
  slope: Float32Array
  /** 0 .. 1 near in-bounds sea-level water (the river-mouth keep, riverMouthKeepM): 1 keeps the retail bed and banks. */
  joinSoft: Float32Array
  /** The tomb keep line (§3B.4): per lattice column, the last kept row (the keep line), -1 outside the tomb columns. */
  tombKeepRow: Int32Array
  /** The frozen rectangle the pass ran with (regions, inclusive). */
  playable: RegionRect
  masks: CoastMasks
  stats: CoastStats
}

export function runCoastPass(input: CoastPassInput, cfg: CoastConfig): CoastResult {
  const l = latticeShape(cfg.domain)
  const { rows, cols, x0: X0, z1: Z1 } = l
  const N = rows * cols
  if (input.heights.length !== N || input.water.length !== N) {
    throw new Error(`coast pass: expected ${rows} x ${cols} lattice arrays, got ${input.heights.length} / ${input.water.length}`)
  }
  const SL = cfg.seaLevelM
  const seed = cfg.seed
  const [px0, px1, pz0, pz1] = playLine(input.playable)
  const corr = cfg.corridor
  const exp = input.exportRect
  const fl = cfg.flank
  const toCells = (m: number) => m / CELL_M
  const XR = (i: number) => X0 + (i % cols) / CELLS_PER_REGION
  const ZR = (i: number) => Z1 + 1 - Math.floor(i / cols) / CELLS_PER_REGION
  const XM = (i: number) => (XR(i) - NOISE_ORIGIN[0]) * REGION_M
  const ZM = (i: number) => (ZR(i) - NOISE_ORIGIN[1]) * REGION_M

  // ---------------------------------------------------------------- 1. masks
  const H = new Float64Array(N)
  const H0 = new Float64Array(N)
  const W = input.water
  const have = new Uint8Array(N)
  const wetR = new Uint8Array(N)
  const filler = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const v = input.heights[i]!
    H[i] = v < cfg.holeBelowM ? NaN : v
    const ok = !Number.isNaN(H[i]!)
    H0[i] = ok ? H[i]! : 0
    have[i] = ok ? 1 : 0
    wetR[i] = ok && !Number.isNaN(W[i]!) && W[i]! > H[i]! + 0.05 ? 1 : 0
    filler[i] = ok && Math.abs(H[i]!) < 1e-3 ? 1 : 0
  }
  const activeMemo = new Map<number, boolean>()
  const isActive = (x: number, z: number) => {
    const k = (z << 8) | x
    let a = activeMemo.get(k)
    if (a === undefined) activeMemo.set(k, (a = input.active(x, z)))
    return a
  }
  const inExp0 = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const rx = clamp(Math.floor(XR(i) - 1e-9), l.x0, l.x1)
    const rz = clamp(Math.floor(ZR(i) - 1e-9), l.z0, l.z1)
    inExp0[i] = rx >= exp.x0 && rx <= exp.x1 && rz >= exp.z0 && rz <= exp.z1 && isActive(rx, rz) ? 1 : 0
  }
  // one vertex wider (numpy roll: wraps at the lattice border, kept for parity)
  const inExp = new Uint8Array(N)
  for (let r = 0; r < rows; r++) {
    const up = ((r - 1 + rows) % rows) * cols
    const dn = ((r + 1) % rows) * cols
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      inExp[i] = inExp0[i]! | inExp0[up + c]! | inExp0[dn + c]! | inExp0[r * cols + ((c - 1 + cols) % cols)]! |
        inExp0[r * cols + ((c + 1) % cols)]!
    }
  }
  const inPlay = new Uint8Array(N)
  const inCorr = new Uint8Array(N)
  const kept = new Uint8Array(N)
  const patch = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const x = XR(i)
    const z = ZR(i)
    inPlay[i] = x >= px0 && x <= px1 && z >= pz0 && z <= pz1 ? 1 : 0
    inCorr[i] = corr && x <= corr.x[1] && z >= corr.z[0] && z <= corr.z[1] ? 1 : 0
    let k = have[i]! && (inExp[i]! || inPlay[i]!) && !filler[i]!
    k ||= !!(have[i]! && inCorr[i]! && !filler[i]! && !inExp[i]!)
    k ||= !!(inPlay[i]! && have[i]!)
    kept[i] = k ? 1 : 0
    for (const p of cfg.allowHeightPatches) {
      if (inPlay[i]! && z < p.z[1] && z >= p.z[0] && x > p.x[0] && x <= p.x[1] && have[i]! && H[i]! < p.maxHeightM && !wetR[i]!) patch[i] = 1
    }
  }
  const kp = new Uint8Array(N)
  for (let i = 0; i < N; i++) kp[i] = kept[i]! && !patch[i]! ? 1 : 0

  // distance past the line and the nearest line point
  // Float32 for the lattice-sized intermediates (the pass holds dozens of them; 2 mm at 5 km is plenty)
  const sPlay = new Float32Array(N)
  const sCorr = new Float32Array(N)
  const s = new Float32Array(N)
  let NX = new Float32Array(N)
  let NZ = new Float32Array(N)
  const onPlayLine = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const x = XR(i)
    const z = ZR(i)
    sPlay[i] = sdfRect(x, z, px0, px1, pz0, pz1)
    sCorr[i] = corr ? sdfRect(x, z, corr.x[0], corr.x[1], corr.z[0], corr.z[1]) : 1e9
    s[i] = Math.min(sPlay[i]!, sCorr[i]!)
    let [nx, nz] = nearestOnRect(x, z, px0, px1, pz0, pz1)
    onPlayLine[i] = 1
    if (corr && sCorr[i]! < sPlay[i]!) {
      const q = nearestOnRect(x, z, corr.x[0], corr.x[1], corr.z[0], corr.z[1])
      nx = q[0]
      nz = q[1]
      onPlayLine[i] = 0
    }
    NX[i] = nx
    NZ[i] = nz
  }

  // ---------------------------------------------------------------- 2. the section field
  const F = sectionField(l, NX, NZ, controlPoints(cfg, input.playable), cfg.sectionBlendM, cfg.landEdgeBlendM)
  const { c0: C0, amp: AMP, width: BW, dune: DH, dry: DRY, grade: G, d1: D1, d2: D2, d3: D3 } = F

  // ---------------------------------------------------------------- 3. the flank envelope
  let Hb: Float64Array = new Float64Array(N)
  let sIn: Float64Array = new Float64Array(N)
  const lineIdx = new Int32Array(N)
  const inSample = fl.inSampleM
  for (let i = 0; i < N; i++) {
    const ri = clamp(roundHalfEven((Z1 + 1 - NZ[i]!) * CELLS_PER_REGION), 0, rows - 1)
    const ci = clamp(roundHalfEven((NX[i]! - X0) * CELLS_PER_REGION), 0, cols - 1)
    lineIdx[i] = ri * cols + ci
    Hb[i] = H0[ri * cols + ci]!
    const dn = Math.max(s[i]!, 1e-6)
    const ox = (XR(i) - NX[i]!) / (dn / REGION_M)
    const oz = (ZR(i) - NZ[i]!) / (dn / REGION_M)
    const qr = clamp(roundHalfEven((Z1 + 1 - (NZ[i]! - (oz * inSample) / REGION_M)) * CELLS_PER_REGION), 0, rows - 1)
    const qc = clamp(roundHalfEven((NX[i]! - (ox * inSample) / REGION_M - X0) * CELLS_PER_REGION), 0, cols - 1)
    sIn[i] = clamp((Hb[i]! - H0[qr * cols + qc]!) / inSample, fl.inSlope[0], fl.inSlope[1])
  }
  NX = NZ = new Float32Array(0)

  // the Qin-Shi tomb keep (§3B.4): the ring north of the plaza keeps its retail crest (+ beyondCrestM) bit for bit
  const tk = cfg.tombKeep
  const lineZ = pz1
  const r0 = roundHalfEven((Z1 + 1 - lineZ) * CELLS_PER_REGION)
  const r1 = roundHalfEven((Z1 + 1 - (lineZ + 1)) * CELLS_PER_REGION)
  const keepRaw = new Float64Array(cols)
  const wpos = new Uint8Array(cols)
  for (let c = 0; c < cols; c++) {
    const x = X0 + c / CELLS_PER_REGION
    const wcol = smoothstep(tk.x[0], tk.x[0] + 0.5, x) * (1 - smoothstep(tk.x[1] - 0.5, tk.x[1], x))
    wpos[c] = wcol > 0 ? 1 : 0
    if (!wpos[c]) continue
    let best = -Infinity
    let arg = 0
    for (let r = r1; r <= r0; r++) {
      const v = H0[r * cols + c]!
      if (v > best) {
        best = v
        arg = r - r1
      }
    }
    keepRaw[c] = (r0 - (r1 + arg)) * CELL_M + tk.beyondCrestM
  }
  const keepCol = boxAlong(keepRaw, oddWidth(tk.crestSmoothM / CELL_M))
  for (let c = 0; c < cols; c++) if (!wpos[c]) keepCol[c] = 0
  const keepRow = (c: number) => clamp(roundHalfEven(r0 - keepCol[c]! / CELL_M), 0, rows - 1)
  const tombKeepRow = new Int32Array(cols).fill(-1)
  for (let c = 0; c < cols; c++) if (wpos[c]) tombKeepRow[c] = keepRow(c)
  const hkRaw = new Float64Array(cols)
  const skRaw = new Float64Array(cols)
  const faceSample = tk.faceSampleM ?? inSample
  const inRows = Math.round(faceSample / CELL_M)
  for (let c = 0; c < cols; c++) {
    const rk = keepRow(c)
    hkRaw[c] = H0[rk * cols + c]!
    // the kept face's slope arriving at the keep line from the plaza side (rows grow southward, toward the plaza)
    skRaw[c] = (H0[rk * cols + c]! - H0[Math.min(rk + inRows, rows - 1) * cols + c]!) / (inRows * CELL_M)
  }
  const lineW = oddWidth(tk.lineSmoothM / CELL_M)
  const hkCol = boxAlong(hkRaw, lineW)
  const skCol = boxAlong(skRaw, lineW)
  const tombKeep = new Uint8Array(N)
  const tw = new Uint8Array(N)
  const KEEP = new Float32Array(N)
  // the envelope's distance: past the line, or past the keep line behind the tomb
  const d = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const c = i % cols
    const x = XR(i)
    const tombCol = x >= tk.x[0] && x <= tk.x[1] && ZR(i) >= lineZ
    KEEP[i] = keepCol[c]!
    tombKeep[i] = tombCol && s[i]! <= KEEP[i]! && have[i]! ? 1 : 0
    tw[i] = tombCol && KEEP[i]! > 0 ? 1 : 0
    d[i] = Math.max(tw[i] ? s[i]! - KEEP[i]! : s[i]!, 0)
    if (tw[i]) {
      Hb[i] = hkCol[c]!
      sIn[i] = tk.continueFace ? clamp(skCol[c]!, tk.maxFaceSlope !== undefined ? -tk.maxFaceSlope : fl.inSlope[0], fl.inSlope[1]) : 0
    }
  }

  // blur along the line: lineBlurM[0] at the line, lineBlurM[1] by lineBlurM[2] out
  {
    const near = gblur(Hb, rows, cols, toCells(fl.lineBlurM[0]))
    const far = gblur(Hb, rows, cols, toCells(fl.lineBlurM[1]))
    for (let i = 0; i < N; i++) {
      const wfar = smoothstep(0, fl.lineBlurM[2], d[i]!)
      Hb[i] = near[i]! * (1 - wfar) + far[i]! * wfar
    }
  }
  {
    // Normalised over the vertices outside the line: inside it the incoming slope has no meaning (its sample point
    // lands on the lattice border), and blurring it in tilted the ground right outside the line.
    const out = new Float64Array(N)
    const wgt = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      if (!(s[i]! > 0)) continue
      out[i] = sIn[i]!
      wgt[i] = 1
    }
    const bs = gblur(out, rows, cols, toCells(fl.inSlopeBlurM))
    const bw = gblur(wgt, rows, cols, toCells(fl.inSlopeBlurM))
    for (let i = 0; i < N; i++) sIn[i] = bw[i]! > 1e-9 ? bs[i]! / bw[i]! : sIn[i]!
  }
  // kept for step 8: where the ring is filler, the ground outside the line continues the line with this slope
  const sInLine = Float32Array.from(sIn)
  const LS = fl.shoulderM
  const E = new Float32Array(N)
  let dToe = new Float32Array(N)
  const rn = fl.ridgeNoise
  for (let i = 0; i < N; i++) {
    const di = d[i]!
    E[i] = envelope(di, Hb[i]!, sIn[i]!, G[i]!, LS)
    dToe[i] = toeDistance(Hb[i]!, sIn[i]!, G[i]!, LS, SL, DH[i]!)
    if (dToe[i]! > RIDGE_MIN_TOE_M && di > 0) {
      const fade = smoothstep(0, RIDGE_IN_M, di) * (1 - smoothstep(dToe[i]! - RIDGE_OUT_M[0], dToe[i]! - RIDGE_OUT_M[1], di))
      if (fade > 0) E[i] = E[i]! + rn.ampM * fbm(XM(i), ZM(i), rn.wavelengthM, rn.octaves, seed + rn.seedOffset) * fade
    }
  }
  // release the line arrays before the waterline and land steps
  Hb = sIn = new Float64Array(0)

  // ---------------------------------------------------------------- 4. the waterline
  // the height patches' bays and cusps (PATCH_SHORE), a smooth weight so u stays continuous
  const patchShore = (i: number): number => {
    let w = 0
    for (const p of cfg.allowHeightPatches) {
      const x0 = Math.ceil(p.x[0]) + PATCH_SHORE.marginR
      const x1 = p.x[1] - PATCH_SHORE.marginR
      const wx = smoothstep(x0, x0 + PATCH_SHORE.fadeR, XR(i)) * (1 - smoothstep(x1 - PATCH_SHORE.fadeR, x1, XR(i)))
      w = Math.max(w, wx * (1 - smoothstep(p.z[1], p.z[1] + 2 * PATCH_SHORE.fadeR, ZR(i))))
    }
    if (w <= 0) return 0
    const bay = PATCH_SHORE.bayAmpM * fbm(XM(i), ZM(i), PATCH_SHORE.bayWavelengthM, 2, seed + PATCH_SHORE.seedOffset)
    const cusp = PATCH_SHORE.cuspAmpM * fbm(XM(i), ZM(i), PATCH_SHORE.cuspWavelengthM, 1, seed + PATCH_SHORE.seedOffset + 7)
    return w * (bay + cusp)
  }
  let n1 = new Float64Array(N)
  for (let i = 0; i < N; i++) n1[i] = fbm(XM(i), ZM(i), N1.wavelengthM, N1.octaves, seed + N1.seedOffset)
  const sd1 = stdDev(n1)
  const u = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    n1[i] = n1[i]! / sd1
    const n2 = fbm(XM(i), ZM(i), N2.wavelengthM, N2.octaves, seed + N2.seedOffset)
    const c = waterlineOffset({ c0: C0[i]!, amp: AMP[i]!, n1: n1[i]!, n2, keep: tw[i] ? KEEP[i]! : 0, toe: dToe[i]!, width: BW[i]! }, WATERLINE_RULE)
    u[i] = s[i]! - c - patchShore(i)
  }
  n1 = new Float64Array(0)
  dToe = new Float32Array(0)

  // ---------------------------------------------------------------- 5. land
  let distK: Float32Array
  const R = new Float64Array(N)
  {
    const ext = extrapolate(H0, kp, rows, cols, { drop: EXTEND_DROP })
    const Rext = gblur(ext.value, rows, cols, EXTEND_BLUR_CELLS)
    distK = Float32Array.from(ext.dist)
    for (let i = 0; i < N; i++) R[i] = kp[i] || patch[i] ? H[i]! : Rext[i]!
  }

  const nearJoin = new Uint8Array(N)
  const joinSoft = new Float32Array(N)
  {
    const jw = new Float64Array(N)
    for (let i = 0; i < N; i++) jw[i] = inPlay[i] && wetR[i] && Math.abs((Number.isNaN(W[i]!) ? 0 : W[i]!) - SL) < 0.2 ? 1 : 0
    const gj = gblur(jw, rows, cols, toCells(cfg.riverMouthKeepM) / 1.5)
    for (let i = 0; i < N; i++) {
      nearJoin[i] = gj[i]! > 0.02 ? 1 : 0
      joinSoft[i] = smoothstep(0.02, 0.2, gj[i]!)
    }
  }

  const hl = cfg.hinterland
  const land = new Float64Array(N)
  const cap = new Float32Array(N)
  const wf = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const v = Math.max(-u[i]!, 0)
    const prof = beachHeight(v, SL, { width: BW[i]!, dune: DH[i]!, dry: DRY[i]! })
    const rise = hinterlandRise(prof, v, BW[i]!, hl.riseSlope, hl.riseBehindM)
    cap[i] = smax(E[i]!, rise, fl.toeSmoothM)
    const relax = clamp((v - BW[i]! - hl.holdM) / hl.relaxM, 0, 1)
    const lo = prof * (1 - relax) + Math.min(prof, R[i]!) * relax
    land[i] = Math.min(Math.max(R[i]!, lo), cap[i]!)
    wf[i] = smoothstep(0, FLANK_FADE_M, E[i]! - rise) * (C0[i]! >= WATERLINE_RULE.flankFromC0M ? 1 : 0) * (s[i]! > 0 ? 1 : 0) * (1 - joinSoft[i]!)
  }
  {
    const Rs = gblur(R, rows, cols, toCells(fl.reliefBlurM))
    for (let i = 0; i < N; i++) {
      const ff = flankFill(cap[i]!, Rs[i]!, fl.reliefM)
      land[i] = land[i]! + wf[i]! * Math.max(ff - land[i]!, 0)
      if (tombKeep[i]) land[i] = H0[i]!
    }
  }

  // ---------------------------------------------------------------- 6. sea
  const sea = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const w = Math.max(u[i]!, 0)
    let depth = shelfDepth(w, [D1[i]!, D2[i]!, D3[i]!])
    depth = depth + BED_NOISE.ampM * fbm(XM(i), ZM(i), BED_NOISE.wavelengthM, BED_NOISE.octaves, seed + BED_NOISE.seedOffset) *
      clamp(w / BED_NOISE.rampM, 0, 1)
    sea[i] = SL - depth
  }
  {
    const keptWet = new Float64Array(N)
    for (let i = 0; i < N; i++) keptWet[i] = kept[i] && wetR[i] ? 1 : 0
    const wetNear = gblur(extrapolate(keptWet, kp, rows, cols, { drop: 0 }).value, rows, cols, RETAIL_BED_BLUR_CELLS)
    const Rw = gblur(extrapolate(H0, kp, rows, cols, { drop: RETAIL_BED_DROP }).value, rows, cols, RETAIL_BED_BLUR_CELLS)
    for (let i = 0; i < N; i++) {
      if (!(wetNear[i]! > 0.5 && !kept[i])) continue
      let fade = clamp(distK[i]! / RETAIL_BED_FADE_M, 0, 1)
      fade = fade * fade * (3 - 2 * fade)
      sea[i] = Math.min(Math.min(Rw[i]!, SL - 1) * (1 - fade) + sea[i]! * fade, SL - 0.5)
    }
  }

  // ---------------------------------------------------------------- 7. retail water beds
  let h = new Float64Array(N)
  const bandFill = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    h[i] = u[i]! < 0 ? land[i]! : sea[i]!
    bandFill[i] = C0[i]! >= WATERLINE_RULE.flankFromC0M && !inPlay[i] && s[i]! > 0 && u[i]! < 0 && !nearJoin[i] ? 1 : 0
    if (kept[i] && wetR[i] && u[i]! < 0 && !bandFill[i]) h[i] = H[i]!
    if (kept[i] && wetR[i] && u[i]! >= 0) h[i] = Math.min(H[i]!, sea[i]!)
    // the corridor is retail scenery (Option A's land bridge, look-only): its ground is never shaped, so the smoothing
    // and the blends below start from its retail heights (C12: the fade lies wholly on the sea side)
    if (inCorr[i] && have[i]) h[i] = H[i]!
  }

  // ---------------------------------------------------------------- 8. smoothing, blends, frozen set
  {
    // The blur is normalised over the ground the coast shapes (everything but the frozen playable set): the frozen
    // heights must not leak across the bounds line (where the export ring is retail filler they left a lip of up to
    // 10 m right outside it); the height patches blend into the frozen ground through their own weight instead.
    const outH = new Float64Array(N)
    const outW = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      if (inPlay[i] && !patch[i]) continue
      outH[i] = h[i]!
      outW[i] = 1
    }
    const bh = gblur(outH, rows, cols, toCells(fl.smoothM))
    const bw = gblur(outW, rows, cols, toCells(fl.smoothM))
    for (let i = 0; i < N; i++) {
      if (!((!kp[i] || (wf[i]! > 0.01 && !inPlay[i])) && !tombKeep[i])) continue
      if (bw[i]! > 1e-9) h[i] = bh[i]! / bw[i]!
    }
  }
  const pm = patchWeights(cfg, rows, cols, patch, inPlay, have)
  // the corner rule's ramp (C13), half its width in regions
  const cornerHalf = (cfg.cornerBlendM ?? 96) / 2 / REGION_M
  const landFade = new Float32Array(N)
  const hFinal = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    // behind the tomb the ring blends from the keep line instead (G12): the kept face carries on as retail and turns
    // into the regrade over blendM, so the keep line shows no kink; next to the corridor it blends from the corridor's
    // faces (s is the distance past the bounds or the corridor, whichever is nearer)
    const wp0 = smoothstep(0, fl.blendM, tw[i] ? sPlay[i]! - KEEP[i]! : s[i]!)
    // where the nearest line point is patched, the ring blends from the patched surface, not from retail (no groove)
    const wp = onPlayLine[i] ? wp0 + (1 - wp0) * pm.lineWeight(lineIdx[i]!) : wp0
    const nearCorr = corr && sCorr[i]! < sPlay[i]! && have[i] && !filler[i] && !kept[i]
    let v: number
    if (inPlay[i]) v = H[i]! * (1 - pm.w[i]!) + h[i]! * pm.w[i]!
    else if (kept[i]) v = H[i]! * (1 - wp) + h[i]! * wp
    else if (onPlayLine[i] && sPlay[i]! < fl.blendM && have[lineIdx[i]!]) {
      // Filler (or no retail) right outside the line: blend from the line's final height continued with the incoming
      // slope, as the kept ring blends from retail, so the line never shows a step.
      const li = lineIdx[i]!
      const line = H[li]! * (1 - pm.w[li]!) + h[li]! * pm.w[li]!
      v = (line + sInLine[i]! * sPlay[i]!) * (1 - wp) + h[i]! * wp
    } else if (nearCorr) {
      const wc = smoothstep(0, fl.blendM, sCorr[i]!)
      v = H[i]! * (1 - wc) + h[i]! * wc
    } else v = h[i]!
    if (tombKeep[i]) v = H0[i]!
    // the corridor stays retail bit for bit (C12; COAST §4: the Donwhang side is look-only retail land)
    if (inCorr[i] && have[i]) v = H[i]!
    if (!(have[i] || !inPlay[i])) v = h[i]!
    if (Number.isNaN(v)) v = h[i]!
    // land edges (sections above the phase): back to retail, the fade wholly on the sea side; C13 below cornerBelowZ
    let lf = inPlay[i] ? 0 : smoothstep(0, 0.5, F.land[i]!) * smoothstep(cfg.cornerBelowZ - cornerHalf, cfg.cornerBelowZ + cornerHalf, ZR(i))
    if (lf > 1 - 1e-6) lf = 1
    landFade[i] = lf
    if (lf > 0 && !tombKeep[i] && have[i]) v = lf >= 1 ? H[i]! : v + (H[i]! - v) * lf
    hFinal[i] = v
  }
  h = hFinal

  // ---------------------------------------------------------------- 9. classes and numbers
  const sandWander = (i: number): number =>
    SAND_WANDER.ampM * fbm(XM(i), ZM(i), SAND_WANDER.wavelengthM, SAND_WANDER.octaves, seed + SAND_WANDER.seedOffset) +
    SAND_WANDER.ditherM * hash2(i % cols, Math.floor(i / cols), seed + SAND_WANDER.seedOffset + 1)
  const slope = slopeDeg(h, rows, cols, CELL_M)
  const cls = new Uint8Array(N)
  const waterSurface = new Uint8Array(N)
  const waterLow = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const wLow = wetR[i] && W[i]! <= SL + 0.5
    waterLow[i] = wLow ? 1 : 0
    // X2: a height patch is sea only in front of its waterline; a hollow behind the dune below the sea level (the S1
    // meadow at +4.74 m) is land, not a lagoon over the grass (look items 1-2)
    let ws = (h[i]! < SL - 0.02 && (u[i]! >= 0 || !kept[i] || !!bandFill[i])) || (wLow && !bandFill[i])
    // dry playable ground is never sea, whatever its height (the bay mouth's low banks below +5 m): inside the bounds only
    // the retail sea-level water and the height patches can be
    if (inPlay[i] && !patch[i] && !wLow) ws = false
    // nor is the corridor's dry ground (retail scenery, like the playable set)
    if (inCorr[i] && !wLow) ws = false
    const edge = landFade[i]! >= 0.5
    if (edge && !inPlay[i]) ws = false
    waterSurface[i] = ws ? 1 : 0
    // X2: the inland sand edge wanders (SAND_WANDER) instead of following the waterline at a fixed distance
    const reach = Math.max(BW[i]!, PATCH_SAND_M) + SAND_BEHIND_M + SAND_WANDER.ampM + SAND_WANDER.ditherM
    const shaped = !edge && !(inPlay[i] && !patch[i]) && !inCorr[i] && !ws && u[i]! > -reach
    const wander = shaped ? sandWander(i) : 0
    const coastal = !edge && u[i]! > -(BW[i]! + SAND_BEHIND_M + Math.max(wander, -SAND_BEHIND_M / 2)) && !(inPlay[i] && !patch[i]) && !inCorr[i]
    let k: number = COAST_CLASS.land
    if (coastal && !ws && slope[i]! < SAND_MAX_SLOPE_DEG) k = u[i]! > -WET_BAND_M ? COAST_CLASS.wetSand : COAST_CLASS.sand
    if (patch[i] && !ws && u[i]! > -(PATCH_SAND_M + wander)) k = u[i]! > -WET_BAND_M ? COAST_CLASS.wetSand : COAST_CLASS.sand
    if (ws) k = COAST_CLASS.sea
    if (wetR[i] && kept[i] && W[i]! > SL + 0.5) k = COAST_CLASS.retailWater
    cls[i] = k
  }

  const masks: CoastMasks = { have, wetR, kept, patch, inPlay, inExp, inCorr, tombKeep, bandFill, waterSurface, waterLow }
  const stats = coastStats(cfg, l, h, H, slope, u, masks, cls, landFade)
  return {
    shape: l, h, cls, u, s, landFade, patchWeight: Float32Array.from(pm.w), slope: Float32Array.from(slope), joinSoft, tombKeepRow,
    playable: input.playable, masks, stats,
  }
}

/** Odd box width for a smoothing length in cells (the prototype's 25 for 50 m, 61 for 120 m). */
const oddWidth = (cells: number) => {
  const w = Math.round(cells)
  return w % 2 ? w : w + 1
}

/** Box average along a row with edge padding (np.convolve(np.pad(a, r, 'edge'), ones(w) / w, 'valid')). */
function boxAlong(a: Float64Array, width: number): Float64Array {
  const r = (width - 1) / 2
  const n = a.length
  const out = new Float64Array(n)
  const k = 1 / width
  for (let c = 0; c < n; c++) {
    let acc = 0
    for (let t = -r; t <= r; t++) acc += a[clamp(c + t, 0, n - 1)]! * k
    out[c] = acc
  }
  return out
}

/**
 * The height patches' weights. 'blur' is the prototype (a Gaussian of the patch mask, which leaks outside it, G2);
 * 'inward' falls to 0 only toward frozen playable ground, so no vertex outside the patch changes and the patch keeps
 * its full weight on the bounds line (no groove). `lineWeight` reads the weight at a line vertex for the ring blend.
 */
function patchWeights(cfg: CoastConfig, rows: number, cols: number, patch: Uint8Array, inPlay: Uint8Array, have: Uint8Array) {
  const N = rows * cols
  const inward = cfg.allowHeightPatches.some(p => p.feather === 'inward')
  const w = new Float64Array(N)
  if (!inward) {
    w.set(gblur(maskToFloat(patch), rows, cols, PATCH_BLUR_CELLS))
    return { w, lineWeight: (_i: number) => 0 }
  }
  const frozen = new Float64Array(N)
  for (let i = 0; i < N; i++) frozen[i] = inPlay[i] && have[i] && !patch[i] ? 1 : 0
  const f = gblur(frozen, rows, cols, PATCH_BLUR_CELLS)
  for (let i = 0; i < N; i++) if (patch[i]) w[i] = smoothstep(0, 1, clamp(1 - 2 * f[i]!, 0, 1))
  return { w, lineWeight: (i: number) => w[i]! }
}

function coastStats(
  cfg: CoastConfig, l: LatticeShape, h: Float64Array, H: Float64Array, slope: Float64Array, u: Float32Array, m: CoastMasks,
  cls: Uint8Array, landFade: Float32Array,
): CoastStats {
  const N = h.length
  const SL = cfg.seaLevelM
  let land = 0, sand = 0, playChanged = 0, outside = 0
  let lo2 = 0, loMax = -Infinity, hi2 = 0, hiMax = -Infinity, vol = 0, drySea = 0
  let tombN = 0, tombSame = true, steep = 0, maxSlope = 0, minH = Infinity, maxH = -Infinity
  const band = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const ws = m.waterSurface[i]!
    if (!ws) land++
    if (cls[i] === COAST_CLASS.sand || cls[i] === COAST_CLASS.wetSand) sand++
    const changed = m.have[i] && Math.abs(h[i]! - H[i]!) > 0.01
    if (m.inPlay[i] && changed) {
      playChanged++
      if (!m.patch[i]) outside++
    }
    const lowered = m.have[i] ? H[i]! - h[i]! : 0
    if (m.kept[i] && !m.inPlay[i] && !m.inCorr[i] && landFade[i]! < 0.5) {
      if (lowered > 2) lo2++
      if (lowered < -2) hi2++
      loMax = Math.max(loMax, lowered)
      hiMax = Math.max(hiMax, -lowered)
      vol += Math.max(lowered, 0)
      if (!m.wetR[i] && H[i]! > SL && ws) drySea++
    }
    if (m.tombKeep[i]) {
      tombN++
      if (h[i] !== H[i]) tombSame = false
    }
    // the sea-coast band outside the bounds (land edges are retail, not coast)
    const outPlay = !m.inPlay[i] && !m.inCorr[i] && landFade[i]! < 0.5
    if (outPlay && u[i]! > -700 && !ws && !m.tombKeep[i]) {
      band[i] = 1
      if (slope[i]! > 45) steep++
      maxSlope = Math.max(maxSlope, slope[i]!)
    }
    minH = Math.min(minH, h[i]!)
    maxH = Math.max(maxH, h[i]!)
  }
  return {
    seaLevel: SL, domain: [l.x0, l.x1, l.z0, l.z1], grid: [l.rows, l.cols], phase: cfg.phase,
    landFrac: land / N, sandPx: sand, playChanged, playChangedOutsidePatch: outside,
    ringLoweredOver2m: lo2, ringLoweredMax: loMax, ringRaisedOver2m: hi2, ringRaisedMax: hiMax,
    ringVolumeRemovedMm3: (vol * CELL_M * CELL_M) / 1e6, ringDryBecomesSea: drySea,
    tombKeepVertices: tombN, tombKeepBitIdentical: tombSame, steepOver45OutsideBounds: steep, maxSlopeOutsideBoundsDeg: maxSlope,
    p999SlopeOutsideBoundsDeg: percentile(slope, band, 99.9), minH, maxH,
  }
}
