/**
 * The drowned area (docs/COAST.md §4.1, coast.json `drown`): land the user wants gone from the world and its maps, so
 * Jangan is an island in the open sea. Runs on the pass result after the authored layers (./hook.ts), before the banks,
 * the paint and the sea masks, so everything downstream reads it as open sea outside the bounds: the terrain, the
 * coast field, the navigation (the ring rule), C9's placement drops, the minimap tiles and the world map.
 *
 * - The area: coast.json `drown.regions` (whole regions; a vertex drowns when every domain region sharing it does, so a
 *   kept neighbour stays bit for bit) and `drown.areas` (continuous rectangles); in `drown.soft` regions (border regions
 *   the island's own coast runs through) only the water and the dry land that is not part of a big landmass drown, so
 *   the island keeps its natural shore there; then every dry island the area cuts off from the rest that is smaller than
 *   `islandMaxKm2` (a sliver of a cliff past a region line).
 * - The ground: the sea floor deepens from depthM[0] at the nearest kept dry land to depthM[1] over shelfM, with a little
 *   bed noise; from the nearest kept dry ground it ramps down, at rampDeg to the sea level and at UNDERWATER_DEG below
 *   it (at least rampMinM wide), and next to kept water (the strait, the bay, the pass's sea) that water's bed carries
 *   on over WET_JOIN_M, so the kept regions meet it without a step; the old beds and banks leave no trace.
 * - The masks: outside the playable set, the corridor and the patches, no retail water, no land fade; classes from the new
 *   height (sea below SL, wet sand and sand on gentle ground just above it).
 * - `drown.openWater`: the in-bounds retail water at the sea level there (the old strait, Jangan Bay), in whole 32 m
 *   blocks, is open sea too (`masks.opened`): out of play, no retail plane, the bed as it is.
 * - The minimap's teal: every sea vertex outside the bounds takes its distance to the nearest dry ground as `s`, so the
 *   shallow-to-deep falloff starts at the real shore everywhere, never at the bounds line.
 *
 * Deterministic (integer-hash noise). Node-free.
 */
import type { CoastConfig, Rect } from './config.ts'
import { gblur, slopeDeg } from './grid.ts'
import { CELL_M, CELLS_PER_REGION, REGION_M, type RegionRect } from './lattice.ts'
import { fbm } from './noise.ts'
import { COAST_CLASS, NOISE_ORIGIN, type CoastResult } from './pass.ts'
import { clamp, smoothstep } from './profile.ts'

/** Sea below SL - this (the pass's rule), wet sand up to SL + WET_ABOVE_M, sand on ground gentler than SAND_MAX_DEG. */
const SEA_BELOW_M = 0.02
const WET_ABOVE_M = 0.6
const SAND_MAX_DEG = 24
/** Bed noise: amplitude (m), wavelength (m), octaves, seed offset; faded in over the first BED_NOISE.inM from land. */
const BED_NOISE = { ampM: 0.8, wavelengthM: 80, octaves: 2, seedOffset: 77, inM: 60 }
/** The kept water's bed and line distance are smoothed over this (m, Gaussian sigma) before the drowned area reads them;
 *  over the first NEAR_M from the kept edge its own vertex counts (no step). The kept bed carries on WET_JOIN_M out. */
const KEPT_SMOOTH_M = 60
const NEAR_M = 10
const WET_JOIN_M = 60
/** The drowned ground is smoothed over this (m, Gaussian sigma) from 3 sigma off the kept edge. */
const BED_SMOOTH_M = 16
/** The open water's bed is smoothed over this (m, Gaussian sigma), fully from OPEN_BED_FROM_M off the shore. */
const OPEN_BED_SMOOTH_M = 90
const OPEN_BED_FROM_M = 80
/** Water blocks are 16 lattice cells (32 m) square, aligned with the regions: an opened block is opened whole. */
const BLOCK_CELLS = 16
/** Under the water the ramp falls no steeper than this (degrees): a gentle shelf, no shaded streaks on the map. */
const UNDERWATER_DEG = 6
/** The ramp's width wanders by this share (noise wavelength m, seed offset), so a cut along a region line does not leave
 *  a ruler-straight waterline. */
const RAMP_WANDER = { share: 0.35, wavelengthM: 70, octaves: 3, seedOffset: 91 }
/** A region counts as drowned (no names, no places, the ring's navigation) when at least this share of it is. */
export const DROWNED_REGION_SHARE = 0.5

export interface DrownStats {
  vertices: number
  /** In-bounds retail water made open sea (drown.openWater). */
  openedVertices: number
  /** Dry islands the area cut off that drowned with it. */
  islands: number
  islandVertices: number
  /** Regions at least DROWNED_REGION_SHARE drowned ('x,z'). */
  regions: string[]
}

const inRect = (r: Rect, x: number, z: number) => x >= r.x[0] && x <= r.x[1] && z >= r.z[0] && z <= r.z[1]

/** Whether coast.json drowns region (x, z) (a drown.regions rectangle holds it, or a drown.areas one its centre). */
export function configDrowns(cfg: Pick<CoastConfig, 'drown'>, x: number, z: number): boolean {
  const d = cfg.drown
  if (!d) return false
  return d.regions.some(r => inRect(r, x, z)) || d.areas.some(a => inRect(a, x + 0.5, z + 0.5))
}

/** The drowned area's vertex mask from the config alone (regions and areas, before the island rule): 1 drowned, 3 in a
 *  soft region (./drownArea decides), 0 kept. */
export function drownMask(r: Pick<CoastResult, 'shape'>, cfg: Pick<CoastConfig, 'drown'>): Uint8Array {
  const l = r.shape
  const out = new Uint8Array(l.rows * l.cols)
  const d = cfg.drown
  if (!d) return out
  const eps = 1e-9
  const regionIn = (x: number, z: number) => d.regions.some(q => inRect(q, x, z))
  const softIn = (x: number, z: number) => (d.soft ?? []).some(q => inRect(q, x, z))
  for (let row = 0; row < l.rows; row++) {
    const z = l.z1 + 1 - row / CELLS_PER_REGION
    const zs = [clamp(Math.floor(z - eps), l.z0, l.z1), clamp(Math.floor(z + eps), l.z0, l.z1)]
    for (let c = 0; c < l.cols; c++) {
      const x = l.x0 + c / CELLS_PER_REGION
      const xs = [clamp(Math.floor(x - eps), l.x0, l.x1), clamp(Math.floor(x + eps), l.x0, l.x1)]
      let hit = d.areas.some(a => inRect(a, x, z))
      if (!hit && d.regions.length) hit = xs.every(a => zs.every(b => regionIn(a, b)))
      if (hit) out[row * l.cols + c] = 1
      // soft: every region sharing the vertex is soft or drowned, at least one soft
      else if (xs.every(a => zs.every(b => regionIn(a, b) || softIn(a, b)))) out[row * l.cols + c] = 3
    }
  }
  return out
}

/**
 * Drowns coast.json's `drown` area on the pass result in place (see the header); null when the config has none.
 * Sets result.masks.drowned and recomputes result.slope.
 */
export function drownArea(r: CoastResult, cfg: CoastConfig): DrownStats | null {
  const d = cfg.drown
  if (!d) return null
  const { rows, cols } = r.shape
  const N = rows * cols
  const SL = cfg.seaLevelM
  const m = r.masks
  const D = drownMask(r, cfg)
  const dry = (i: number) => r.cls[i] !== COAST_CLASS.sea && r.cls[i] !== COAST_CLASS.retailWater

  // in a soft region, ground below the sea level is water too: next to the new sea it would flood
  const dryS = (i: number) => dry(i) && !(D[i] === 3 && r.h[i]! < SL)
  // dry components (4-connected, soft vertices included): one touching the area (or holding soft ground) and smaller
  // than islandMaxKm2 drowns; a bigger one keeps its soft ground. Soft water drowns.
  const maxVerts = (d.islandMaxKm2 * 1e6) / (CELL_M * CELL_M)
  const seen = new Uint8Array(N)
  const queue = new Int32Array(N)
  let islands = 0
  let islandVertices = 0
  for (let s = 0; s < N; s++) {
    if (seen[s] || D[s] === 1 || !dryS(s)) continue
    let head = 0
    let tail = 0
    queue[tail++] = s
    seen[s] = 1
    let touches = false
    while (head < tail) {
      const i = queue[head++]!
      const c = i % cols
      const nb = [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i >= cols ? i - cols : -1, i < N - cols ? i + cols : -1]
      if (D[i] === 3) touches = true
      for (const j of nb) {
        if (j < 0) continue
        if (D[j] === 1 || (D[j] === 3 && !dryS(j))) {
          touches = true
          continue
        }
        if (seen[j] || !dryS(j)) continue
        seen[j] = 1
        queue[tail++] = j
      }
    }
    if (touches && tail < maxVerts) {
      islands++
      islandVertices += tail
      for (let k = 0; k < tail; k++) D[queue[k]!] = 2
    } else for (let k = 0; k < tail; k++) if (D[queue[k]!] === 3) D[queue[k]!] = 0
  }
  for (let i = 0; i < N; i++) if (D[i] === 3) D[i] = 4

  // nearest kept vertex (any) and nearest kept dry vertex, by vector propagation (8 neighbours, two passes)
  const near = nearestSource(D, rows, cols, () => true)
  const nearDry = nearestSource(D, rows, cols, i => dry(i))
  const dist = (i: number, src: number) => {
    if (src < 0) return Infinity
    const dc = (i % cols) - (src % cols)
    const dr = Math.floor(i / cols) - Math.floor(src / cols)
    return Math.hypot(dc, dr) * CELL_M
  }

  const [d0, d1] = d.depthM
  const tan = Math.tan((d.rampDeg * Math.PI) / 180)
  const tanUnder = Math.tan((UNDERWATER_DEG * Math.PI) / 180)
  const X0 = r.shape.x0
  const Z1 = r.shape.z1
  const h = r.h

  // The kept water's bed seen from the drowned area, smoothed (a normalized Gaussian of the kept wet vertices): the
  // nearest kept vertex alone jumps between neighbours (one bed, then another) and leaves wedges.
  const wet = new Float64Array(N)
  const wetH = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    if (D[i]) continue
    if (!dry(i)) {
      wet[i] = 1
      wetH[i] = h[i]!
    }
  }
  const sigma = KEPT_SMOOTH_M / CELL_M
  const wW = gblur(wet, rows, cols, sigma)
  const hW = gblur(wetH, rows, cols, sigma)
  const nearWet = nearestSource(D, rows, cols, i => !dry(i))

  let vertices = 0
  for (let i = 0; i < N; i++) {
    if (!D[i]) continue
    vertices++
    const srcD = nearDry[i]!
    const dl = dist(i, srcD)
    const xm = (X0 + (i % cols) / CELLS_PER_REGION - NOISE_ORIGIN[0]) * REGION_M
    const zm = (Z1 + 1 - Math.floor(i / cols) / CELLS_PER_REGION - NOISE_ORIGIN[1]) * REGION_M
    const reach = Number.isFinite(dl) ? dl : d.shelfM
    const floor = SL - (d0 + (d1 - d0) * smoothstep(0, d.shelfM, reach)) +
      BED_NOISE.ampM * fbm(xm, zm, BED_NOISE.wavelengthM, BED_NOISE.octaves, cfg.seed + BED_NOISE.seedOffset) * smoothstep(0, BED_NOISE.inM, reach)
    // from the nearest kept dry ground down to the floor: rampDeg to the sea level, UNDERWATER_DEG below it
    let v = floor
    if (srcD >= 0) {
      const hl = h[srcD]!
      const wander = 1 + RAMP_WANDER.share * fbm(xm, zm, RAMP_WANDER.wavelengthM, RAMP_WANDER.octaves, cfg.seed + RAMP_WANDER.seedOffset)
      // above the sea level a slope that ends level at the waterline (a strip of beach), then the shelf below it
      const top = Math.max(0, hl - SL)
      const Ra = top > 0 ? Math.max(d.rampMinM, top / tan) * wander : 0
      const from = Math.min(hl, SL)
      const Ru = Math.max(d.rampMinM, Math.max(0, from - floor) / tanUnder) * wander
      v = dl < Ra ? hl - top * smoothstep(0, Ra, dl) : from + (floor - from) * smoothstep(0, Ru, dl - Ra)
    }
    // next to kept water (the strait, the bay, the pass's own sea) its bed carries on, then gives way to the above
    const srcW = nearWet[i]!
    const dw = dist(i, srcW)
    if (srcW >= 0 && dw < WET_JOIN_M) {
      const w = wW[i]!
      const hw = w > 1e-6 ? h[srcW]! + (hW[i]! / w - h[srcW]!) * smoothstep(0, NEAR_M, dw) : h[srcW]!
      v = hw + (v - hw) * smoothstep(0, WET_JOIN_M, dw)
    }
    h[i] = v
  }

  // The distance fields crease where two nearest kept vertices meet (a ridge of the floor, a dark line on the map's
  // hill shade): the drowned ground away from the kept edge is smoothed over BED_SMOOTH_M.
  const inD = new Float64Array(N)
  const hD = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    if (!D[i]) continue
    inD[i] = 1
    hD[i] = h[i]!
  }
  const wD = gblur(inD, rows, cols, BED_SMOOTH_M / CELL_M)
  const bD = gblur(hD, rows, cols, BED_SMOOTH_M / CELL_M)
  for (let i = 0; i < N; i++) {
    if (!D[i] || !(wD[i]! > 1e-6)) continue
    const t = smoothstep(NEAR_M, NEAR_M + 3 * BED_SMOOTH_M, dist(i, near[i]!))
    h[i] = h[i]! + (bD[i]! / wD[i]! - h[i]!) * t
  }

  // masks and classes
  const slope = slopeDeg(h, rows, cols, CELL_M)
  r.slope = Float32Array.from(slope)
  const drowned = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (!D[i]) continue
    drowned[i] = 1
    const v = h[i]!
    const sea = v < SL - SEA_BELOW_M
    r.cls[i] = sea ? COAST_CLASS.sea : slope[i]! < SAND_MAX_DEG ? (v < SL + WET_ABOVE_M ? COAST_CLASS.wetSand : COAST_CLASS.sand) : COAST_CLASS.land
    r.u[i] = (SL - v) * 6
    r.landFade[i] = 0
    r.patchWeight[i] = 0
    r.joinSoft[i] = 0
    m.inPlay[i] = 0
    m.kept[i] = 0
    m.patch[i] = 0
    m.inCorr[i] = 0
    m.tombKeep[i] = 0
    m.wetR[i] = 0
    m.bandFill[i] = 0
    m.waterLow[i] = 0
    m.waterSurface[i] = sea ? 1 : 0
  }
  m.drowned = drowned

  // The opened water (drown.openWater): the in-bounds retail sea-level water of the old strait and the bay, whole
  // blocks of it, is open sea from here on (no retail plane: the ocean draws it; the bed stays retail).
  const opened = new Uint8Array(N)
  let openedVertices = 0
  if (d.openWater?.length) {
    const inOpen = (i: number) => {
      const x = X0 + (i % cols) / CELLS_PER_REGION
      const z = Z1 + 1 - Math.floor(i / cols) / CELLS_PER_REGION
      return d.openWater!.some(a => inRect(a, x, z))
    }
    const waterAt = (i: number) => !D[i] && m.inPlay[i] && m.waterLow[i] && r.cls[i] === COAST_CLASS.sea
    const blocks = new Set<number>()
    const bcols = Math.ceil(cols / BLOCK_CELLS)
    for (let i = 0; i < N; i++) {
      if (!waterAt(i) || !inOpen(i)) continue
      blocks.add(Math.floor(Math.floor(i / cols) / BLOCK_CELLS) * bcols + Math.floor((i % cols) / BLOCK_CELLS))
    }
    for (let i = 0; i < N; i++) {
      if (!waterAt(i)) continue
      const row = Math.floor(i / cols)
      const c = i % cols
      // a vertex on a block line belongs to both blocks
      const rs = [Math.floor(row / BLOCK_CELLS), Math.floor(Math.max(0, row - 1) / BLOCK_CELLS)]
      const cs = [Math.floor(c / BLOCK_CELLS), Math.floor(Math.max(0, c - 1) / BLOCK_CELLS)]
      if (!rs.some(a => cs.some(b => blocks.has(a * bcols + b)))) continue
      opened[i] = 1
      openedVertices++
      m.inPlay[i] = 0
      m.wetR[i] = 0
      m.waterLow[i] = 0
    }
  }
  if (openedVertices) m.opened = opened

  // The open water's bed (the opened retail water and the sea round it inside drown.openWater) is smoothed away from
  // the shore: the old lake bed's holes and the pass's shelf meet in one gentle basin, no blotches on the map.
  if (d.openWater?.length) {
    const inOpen = (i: number) => {
      const x = X0 + (i % cols) / CELLS_PER_REGION
      const z = Z1 + 1 - Math.floor(i / cols) / CELLS_PER_REGION
      return d.openWater!.some(a => inRect(a, x, z))
    }
    const q = new Uint8Array(N)
    const qw = new Float64Array(N)
    const qh = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      if (!m.waterSurface[i] || m.inPlay[i] || !(inOpen(i) || D[i])) continue
      q[i] = 1
      qw[i] = 1
      qh[i] = h[i]!
    }
    const toShore = nearestSource(q, rows, cols, i => !m.waterSurface[i])
    const w = gblur(qw, rows, cols, OPEN_BED_SMOOTH_M / CELL_M)
    const b = gblur(qh, rows, cols, OPEN_BED_SMOOTH_M / CELL_M)
    for (let i = 0; i < N; i++) {
      if (!q[i] || !(w[i]! > 1e-6)) continue
      const t = smoothstep(NEAR_M, OPEN_BED_FROM_M, dist(i, toShore[i]!))
      h[i] = h[i]! + (b[i]! / w[i]! - h[i]!) * t
    }
    m.openBed = q
    r.slope = Float32Array.from(slopeDeg(h, rows, cols, CELL_M))
  }

  // The minimap's teal (./minimap.ts SEA_LINE_BLEND_M) falls off from the real shore only: every sea vertex outside the
  // bounds measures its distance to the nearest dry ground, not to the bounds line (the drowned corridor's faces and the
  // bounds line across the old strait are open sea now).
  const land = (i: number) => !m.waterSurface[i]
  const sea = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (m.waterSurface[i] && !m.inPlay[i]) sea[i] = 1
  const shore = nearestSource(sea, rows, cols, land)
  for (let i = 0; i < N; i++) if (sea[i]) r.s[i] = Math.min(dist(i, shore[i]!), d.shelfM)

  return { vertices, openedVertices, islands, islandVertices, regions: [...drownedRegions(r)].map(k => `${k & 0xff},${k >> 8}`) }
}

/** Regions (z << 8 | x) at least DROWNED_REGION_SHARE drowned (empty without a drowned mask). */
export function drownedRegions(r: Pick<CoastResult, 'shape' | 'masks'>): Set<number> {
  const out = new Set<number>()
  const D = r.masks.drowned
  if (!D) return out
  const l = r.shape
  const G = CELLS_PER_REGION + 1
  for (let z = l.z0; z <= l.z1; z++) {
    for (let x = l.x0; x <= l.x1; x++) {
      const row0 = (l.z1 - z) * CELLS_PER_REGION
      const col0 = (x - l.x0) * CELLS_PER_REGION
      let n = 0
      for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) n += D[(row0 + i) * l.cols + col0 + j]!
      if (n >= DROWNED_REGION_SHARE * G * G) out.add((z << 8) | x)
    }
  }
  return out
}

/**
 * The island's rectangle (regions, inclusive): every region with dry ground (not sea, not drowned), grown by `margin`
 * regions and kept inside `within` (the coast domain). The world map covers it (docs/COAST.md §11).
 */
export function islandRect(r: Pick<CoastResult, 'shape' | 'masks' | 'cls'>, within: RegionRect, margin = 1): RegionRect | null {
  const l = r.shape
  const D = r.masks.drowned
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (let row = 0; row < l.rows - 1; row++) {
    for (let c = 0; c < l.cols - 1; c++) {
      const i = row * l.cols + c
      const k = r.cls[i]
      if (k === COAST_CLASS.sea || D?.[i]) continue
      // a vertex on a region line counts for the region west of it (south of it): the dry region, not its neighbour
      const x = l.x0 + Math.max(0, Math.floor((c - 0.5) / CELLS_PER_REGION))
      const z = l.z1 - Math.floor(row / CELLS_PER_REGION)
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (z < z0) z0 = z
      if (z > z1) z1 = z
    }
  }
  if (!Number.isFinite(x0)) return null
  return {
    x0: Math.max(within.x0, x0 - margin), x1: Math.min(within.x1, x1 + margin),
    z0: Math.max(within.z0, z0 - margin), z1: Math.min(within.z1, z1 + margin),
  }
}

/**
 * For every masked vertex (mask != 0), the index of the nearest unmasked vertex passing `source`, or -1 (8-neighbour
 * vector propagation: a forward and a backward raster pass, exact enough for ramps and depth).
 */
function nearestSource(mask: Uint8Array, rows: number, cols: number, source: (i: number) => boolean): Int32Array {
  const N = rows * cols
  const src = new Int32Array(N).fill(-1)
  const d2 = new Float64Array(N).fill(Infinity)
  for (let i = 0; i < N; i++) {
    if (!mask[i] && source(i)) {
      src[i] = i
      d2[i] = 0
    }
  }
  const relax = (i: number, j: number) => {
    const s = src[j]!
    if (s < 0) return
    const dc = (i % cols) - (s % cols)
    const dr = Math.floor(i / cols) - Math.floor(s / cols)
    const v = dc * dc + dr * dr
    if (v < d2[i]!) {
      d2[i] = v
      src[i] = s
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < cols; c++) {
        const i = row * cols + c
        if (d2[i] === 0) continue
        if (c > 0) relax(i, i - 1)
        if (row > 0) {
          relax(i, i - cols)
          if (c > 0) relax(i, i - cols - 1)
          if (c < cols - 1) relax(i, i - cols + 1)
        }
      }
    }
    for (let row = rows - 1; row >= 0; row--) {
      for (let c = cols - 1; c >= 0; c--) {
        const i = row * cols + c
        if (d2[i] === 0) continue
        if (c < cols - 1) relax(i, i + 1)
        if (row < rows - 1) {
          relax(i, i + cols)
          if (c < cols - 1) relax(i, i + cols + 1)
          if (c > 0) relax(i, i + cols - 1)
        }
      }
    }
  }
  return src
}
