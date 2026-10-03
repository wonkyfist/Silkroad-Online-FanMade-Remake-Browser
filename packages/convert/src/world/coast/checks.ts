/**
 * The coast's geometry checks (docs/COAST.md §12.13 tests 1-5, with the beaches fact-check's G6, G7, G11 and G12;
 * WAVE_PLAN6 §6.1 CST-C). The converter writes their numbers into manifest.report.coast and the tests assert them.
 * Node-free.
 *
 * - slope census: land outside the bounds on sea sides, more than 100 m past the line, steeper than 45° / 50°; every
 *   vertex over 50° must lie in a listed hotspot (coast.json `hotspots`, the Blender hand-pass list, §3B.7);
 * - the bounds line (and in phase 2 the corridor's two faces, Option A's land bridge): along every dry sea-side line
 *   vertex the final surface adds no crease the retail did not have (the change of slope across the line, over one
 *   lattice cell on each side, may exceed retail's own by at most 0.15), and no new bench (a run of more than 20 m
 *   flatter than 0.1 m/m, more than BENCH_ABOVE_SEA_M above the sea level, within 10-60 m of the line where the ground
 *   falls toward the line from inside at more than 0.3 m/m, that retail did not have);
 * - the tomb keep line: the same crease measure across the keep line, against the kept retail face continued;
 * - sand: every shore vertex of the sea mask outside the bounds has sand (paint 407, 412 or 70) within 12 m, except at
 *   river mouths (the retail banks are kept), at the Jangan Bay mouth, and on or within LAND_EDGE_EXEMPT_M of a land
 *   edge (the phase split: a land edge keeps its retail banks until its own phase makes it a beach) or of the corridor
 *   (retail scenery: where retail sea-level water meets its faces, the banks are the corridor's own);
 * - flank paint: at least 80 % of the moved flank below paint.grassMaxDeg shows a grass tile;
 * - river mouths: retail water within riverMouthKeepM of in-bounds sea-level water keeps its bed (never filled);
 * - water walls (W10R CST-H1/H2, ./banks.ts): no in-bounds retail water at the sea level borders ground the coast shapes
 *   (outside the bounds, or a height patch) that is dry, outside the sea mask and more than WALL_BELOW_M under SL.
 */
import { MAPM_TEXTURE_ID_MASK } from '@sro/formats'
import type { CoastConfig } from './config.ts'
import type { SeaMasks } from './field.ts'
import { CELL_M, CELLS_PER_REGION, playLine } from './lattice.ts'
import { SEABED_BELOW_M } from './paint.ts'
import { COAST_CLASS, type CoastResult } from './pass.ts'

/** Crease tolerance across a line (m/m), §12.13 test 2. */
export const CREASE_TOL = 0.15
/** Slope census limit beyond CENSUS_BEYOND_M (degrees), §12.13 test 1. */
export const CENSUS_MAX_DEG = 50
export const CENSUS_BEYOND_M = 100
/** Sand must lie within this distance of every sea shore (m), §12.13 test 3. */
export const SAND_WITHIN_M = 12
/** The tiles that count as sand for test 3 (dry, pebble and wet sand). */
/** The palette entries that count as sand for the §12.13 sand rule (their tiles come from coast.json's palette). */
export const SAND_PALETTE_NAMES: readonly string[] = ['sand', 'sand-pebble', 'wet-sand']

/** The sand tiles of a config's palette. */
export function sandTiles(cfg: CoastConfig): number[] {
  return cfg.paint.palette.filter(p => SAND_PALETTE_NAMES.includes(p.name)).map(p => p.tile)
}
/** Shore vertices this close to a land edge keep its retail banks (m). */
export const LAND_EDGE_EXEMPT_M = 16
/** Minimum grass share of the moved flank below grassMaxDeg, §12.13 test 3b. */
export const FLANK_GRASS_SHARE = 0.8

export type LineSide = 'north' | 'south' | 'east' | 'west' | 'corridor-south' | 'corridor-north'

export interface LineVertex {
  i: number
  col: number
  row: number
  /** Outward step in lattice columns and rows. */
  dc: number
  dr: number
  side: LineSide
  /** Region units. */
  x: number
  z: number
}

const xOf = (r: CoastResult, col: number) => r.shape.x0 + col / CELLS_PER_REGION
const zOf = (r: CoastResult, row: number) => r.shape.z1 + 1 - row / CELLS_PER_REGION

/** The hotspot a point (region units) lies in, or null. */
export function hotspotAt(cfg: CoastConfig, x: number, z: number): string | null {
  for (const h of cfg.hotspots) if (x >= h.x[0] && x <= h.x[1] && z >= h.z[0] && z <= h.z[1]) return h.name
  return null
}

/**
 * Vertices of the playable line whose ground 40 m outward is a sea side (landFade < 0.5, and not the corridor, which is
 * retail land), plus, with Option A's corridor (`corridor`, coast.json), the last corridor row along its two faces west
 * of the playable line.
 */
export function seaLineVertices(r: CoastResult, corridor: CoastConfig['corridor'] = null): LineVertex[] {
  const { rows, cols, x0, z1 } = r.shape
  const [px0, px1, pz0, pz1] = playLine(r.playable)
  const colOf = (x: number) => Math.round((x - x0) * CELLS_PER_REGION)
  const rowOf = (z: number) => Math.round((z1 + 1 - z) * CELLS_PER_REGION)
  const out: LineVertex[] = []
  const probe = Math.round(40 / CELL_M)
  const add = (col: number, row: number, dc: number, dr: number, side: LineSide) => {
    const oc = col + dc * probe
    const or = row + dr * probe
    if (oc < 0 || or < 0 || oc >= cols || or >= rows) return
    if (!(r.landFade[or * cols + oc]! < 0.5) || r.masks.inCorr[or * cols + oc]) return
    out.push({ i: row * cols + col, col, row, dc, dr, side, x: xOf(r, col), z: zOf(r, row) })
  }
  for (let c = colOf(px0); c <= colOf(px1); c++) {
    add(c, rowOf(pz0), 0, 1, 'south')
    add(c, rowOf(pz1), 0, -1, 'north')
  }
  for (let rr = rowOf(pz1); rr <= rowOf(pz0); rr++) {
    add(colOf(px0), rr, -1, 0, 'west')
    add(colOf(px1), rr, 1, 0, 'east')
  }
  if (corridor) {
    // the last rows inside the corridor (z >= z0 and z <= z1), up to the playable line's column (exclusive)
    const rowS = Math.floor((z1 + 1 - corridor.z[0]) * CELLS_PER_REGION + 1e-9)
    const rowN = Math.ceil((z1 + 1 - corridor.z[1]) * CELLS_PER_REGION - 1e-9)
    const cEnd = Math.min(colOf(px0), Math.floor((corridor.x[1] - x0) * CELLS_PER_REGION + 1e-9) + 1)
    for (let c = Math.max(0, Math.ceil((corridor.x[0] - x0) * CELLS_PER_REGION)); c < cEnd; c++) {
      if (rowS >= 0 && rowS < rows) add(c, rowS, 0, 1, 'corridor-south')
      if (rowN >= 0 && rowN < rows) add(c, rowN, 0, -1, 'corridor-north')
    }
  }
  return out
}

/** Change of slope across a vertex along (dc, dr) over k cells on each side (m/m); NaN where a value is missing. */
function crease(a: ArrayLike<number>, cols: number, i: number, dc: number, dr: number, k: number): number {
  const o = (dr * cols + dc) * k
  const h0 = a[i]!
  return Math.abs((a[i + o]! - h0) - (h0 - a[i - o]!)) / (k * CELL_M)
}

export interface CreaseFinding {
  x: number
  z: number
  side: string
  /** The final surface's crease minus retail's own (m/m). */
  added: number
  hotspot: string | null
}

/** Creases the coast adds along the playable line (sea sides), §12.13 test 2. `retail`: the retail heights. */
export function lineCreases(r: CoastResult, retail: Float64Array, cfg: CoastConfig, k = 1): { checked: number; findings: CreaseFinding[] } {
  const cols = r.shape.cols
  const findings: CreaseFinding[] = []
  let checked = 0
  for (const v of seaLineVertices(r, cfg.corridor)) {
    // on dry ground only: an under-water step (the retail lake bed at the bay mouth) is no edge anyone sees
    if (r.masks.wetR[v.i] || r.h[v.i]! < cfg.seaLevelM) continue
    const f = crease(r.h, cols, v.i, v.dc, v.dr, k)
    if (!Number.isFinite(f)) continue
    const own = crease(retail, cols, v.i, v.dc, v.dr, k)
    const added = f - (Number.isFinite(own) ? own : 0)
    checked++
    if (added > CREASE_TOL) findings.push({ x: v.x, z: v.z, side: v.side, added, hotspot: hotspotAt(cfg, v.x, v.z) })
  }
  return { checked, findings }
}

/** Creases along the tomb keep line (§3B.4, G12): the regrade against the kept retail face continued. */
export function keepLineCreases(r: CoastResult, retail: Float64Array, cfg: CoastConfig, k = 1): { checked: number; findings: CreaseFinding[] } {
  const { rows, cols } = r.shape
  const findings: CreaseFinding[] = []
  let checked = 0
  for (let c = 0; c < cols; c++) {
    const row = r.tombKeepRow[c]!
    if (row < k || row + k >= rows) continue
    const i = row * cols + c
    if (r.landFade[i]! >= 0.5) continue
    const f = crease(r.h, cols, i, 0, -1, k)
    const own = crease(retail, cols, i, 0, -1, k)
    if (!Number.isFinite(f)) continue
    checked++
    const added = f - (Number.isFinite(own) ? own : 0)
    const x = xOf(r, c)
    const z = zOf(r, row)
    if (added > CREASE_TOL) findings.push({ x, z, side: 'tomb-keep', added, hotspot: hotspotAt(cfg, x, z) })
  }
  return { checked, findings }
}

/**
 * A flat counts as a bench only this far above the sea level (m): lower, it is the beach itself (the highest dune is
 * SL + 5 m, the wide kind) or the sea bed, which a face falling straight to the shore (the corridor's faces, the N2 cove)
 * is meant to meet.
 */
export const BENCH_ABOVE_SEA_M = 6

/** Whether a bench (a run longer than 20 m flatter than 0.1, above the beach) lies 10-60 m out where the ground falls to
 *  the line. */
function benchAt(a: ArrayLike<number>, cols: number, v: LineVertex, seaLevelM: number): boolean {
  const step = v.dr * cols + v.dc
  const h = (t: number) => a[v.i + step * t]!
  const in20 = Math.round(20 / CELL_M)
  if (!((h(0) - h(-in20)) / 20 < -0.3)) return false
  let run = 0
  let best = 0
  for (let t = Math.round(10 / CELL_M); t <= Math.round(60 / CELL_M); t++) {
    const sl = (h(t + 1) - h(t - 1)) / (2 * CELL_M)
    if (Math.abs(sl) < 0.1 && h(t) > seaLevelM + BENCH_ABOVE_SEA_M) best = Math.max(best, (run += CELL_M))
    else run = 0
  }
  return best > 20
}

/** Benches the coast adds outside the line (G11): benches of the final surface where retail had none. */
export function newBenches(r: CoastResult, retail: Float64Array, cfg: CoastConfig): { checked: number; retailBenches: number; findings: CreaseFinding[] } {
  const cols = r.shape.cols
  const rows = r.shape.rows
  const reach = Math.round(62 / CELL_M)
  const findings: CreaseFinding[] = []
  let checked = 0
  let retailBenches = 0
  for (const v of seaLineVertices(r, cfg.corridor)) {
    const endC = v.col + v.dc * reach
    const endR = v.row + v.dr * reach
    const backC = v.col - v.dc * reach
    const backR = v.row - v.dr * reach
    if (endC < 0 || endR < 0 || endC >= cols || endR >= rows || backC < 0 || backR < 0 || backC >= cols || backR >= rows) continue
    checked++
    const own = benchAt(retail, cols, v, cfg.seaLevelM)
    if (own) retailBenches++
    if (!own && benchAt(r.h, cols, v, cfg.seaLevelM)) findings.push({ x: v.x, z: v.z, side: v.side, added: 0, hotspot: hotspotAt(cfg, v.x, v.z) })
  }
  return { checked, retailBenches, findings }
}

export interface SlopeCensus {
  /** Land vertices counted (outside the bounds on sea sides, past CENSUS_BEYOND_M). */
  land: number
  over45: number
  over50: number
  /** Per hotspot: vertices over CENSUS_MAX_DEG. */
  byHotspot: Record<string, number>
  /** Vertices over CENSUS_MAX_DEG outside every hotspot (the test wants none), and the first 200 of them. */
  outside: number
  samples: Array<{ x: number; z: number; deg: number }>
}

/** §12.13 test 1 (G6: on the merged result, with the hotspot allowance). */
export function slopeCensus(r: CoastResult, cfg: CoastConfig): SlopeCensus {
  const { cols } = r.shape
  const m = r.masks
  const out: SlopeCensus = { land: 0, over45: 0, over50: 0, byHotspot: {}, outside: 0, samples: [] }
  for (let i = 0; i < r.h.length; i++) {
    if (r.landFade[i]! >= 0.5 || m.tombKeep[i] || m.inPlay[i] || m.inCorr[i] || r.s[i]! <= CENSUS_BEYOND_M) continue
    if (r.cls[i] === COAST_CLASS.sea || r.cls[i] === COAST_CLASS.retailWater) continue
    out.land++
    const deg = r.slope[i]!
    if (deg > 45) out.over45++
    if (deg <= CENSUS_MAX_DEG) continue
    out.over50++
    const col = i % cols
    const x = xOf(r, col)
    const z = zOf(r, (i - col) / cols)
    const hs = hotspotAt(cfg, x, z)
    if (hs) out.byHotspot[hs] = (out.byHotspot[hs] ?? 0) + 1
    else if (out.outside++ < 200) out.samples.push({ x, z, deg })
  }
  return out
}

/** Whether a lattice vertex lies in the mouth of Jangan Bay (the baymouth section's stretch of the north ring). */
function inBayMouth(r: CoastResult, cfg: CoastConfig, x: number, z: number): boolean {
  const [, , , pz1] = playLine(r.playable)
  if (z < pz1) return false
  return cfg.sections.some(s => s.kind === 'baymouth' && s.side === 'north' && x >= s.from && x <= s.to + 1)
}

export interface SandCoverage {
  shore: number
  exempt: number
  /** Shore vertices with no sand within SAND_WITHIN_M (outside hotspots). */
  gaps: Array<{ x: number; z: number }>
  gapsInHotspots: number
}

/** §12.13 test 3: sand within 12 m of every sea shore outside the bounds. `words`: the painted texture words. */
export function sandCoverage(r: CoastResult, cfg: CoastConfig, masks: SeaMasks, words: Uint16Array): SandCoverage {
  const { rows, cols } = r.shape
  const N = rows * cols
  const sand = new Uint8Array(N)
  const ws = r.masks.waterSurface
  // X2: the wet-sand tile is the sea bed's since X2, so sand counts on dry ground and in the shallows the paint gives
  // the wet sand (no deeper than SEABED_BELOW_M), as when the wet sand had a tile of its own
  const tiles = sandTiles(cfg)
  const shallowM = cfg.seaLevelM - SEABED_BELOW_M
  for (let i = 0; i < N; i++) if ((!ws[i] || r.h[i]! >= shallowM) && tiles.includes(words[i]! & MAPM_TEXTURE_ID_MASK)) sand[i] = 1
  const rad = Math.floor(SAND_WITHIN_M / CELL_M)
  const out: SandCoverage = { shore: 0, exempt: 0, gaps: [], gapsInHotspots: 0 }
  for (let row = 1; row < rows - 1; row++) {
    for (let col = 1; col < cols - 1; col++) {
      const i = row * cols + col
      if (!masks.ocean[i] || r.masks.inPlay[i] || r.masks.inCorr[i]) continue
      if (ws[i - 1] && ws[i + 1] && ws[i - cols] && ws[i + cols]) continue
      out.shore++
      const x = xOf(r, col)
      const z = zOf(r, row)
      if (r.landFade[i]! >= 0.5 || r.joinSoft[i]! > 0.02 || inBayMouth(r, cfg, x, z) || nearLandEdge(r, row, col)) {
        out.exempt++
        continue
      }
      let found = false
      for (let dr = -rad; dr <= rad && !found; dr++) {
        const rr = row + dr
        if (rr < 0 || rr >= rows) continue
        for (let dc = -rad; dc <= rad; dc++) {
          const cc = col + dc
          if (cc < 0 || cc >= cols || dr * dr + dc * dc > rad * rad) continue
          if (sand[rr * cols + cc]) {
            found = true
            break
          }
        }
      }
      if (found) continue
      if (hotspotAt(cfg, x, z)) out.gapsInHotspots++
      else if (out.gaps.length < 200) out.gaps.push({ x, z })
    }
  }
  return out
}

/** Whether a land-edge vertex (landFade >= 0.5) or a corridor vertex lies within LAND_EDGE_EXEMPT_M of (row, col). */
function nearLandEdge(r: CoastResult, row: number, col: number): boolean {
  const { rows, cols } = r.shape
  const rad = Math.round(LAND_EDGE_EXEMPT_M / CELL_M)
  for (let dr = -rad; dr <= rad; dr++) {
    const rr = row + dr
    if (rr < 0 || rr >= rows) continue
    for (let dc = -rad; dc <= rad; dc++) {
      const cc = col + dc
      if (cc < 0 || cc >= cols || dr * dr + dc * dc > rad * rad) continue
      if (r.landFade[rr * cols + cc]! >= 0.5 || r.masks.inCorr[rr * cols + cc]) return true
    }
  }
  return false
}

/** §12.13 test 3b (G7): the grass share of the moved flank below grassMaxDeg. */
export function flankGrassShare(
  r: CoastResult, cfg: CoastConfig, retail: Float64Array, words: Uint16Array, isGrass: (tile: number) => boolean,
): { flank: number; grass: number; share: number } {
  const m = r.masks
  let flank = 0
  let grass = 0
  for (let i = 0; i < r.h.length; i++) {
    if (r.landFade[i]! >= 0.5 || m.tombKeep[i] || m.inPlay[i] || m.inCorr[i] || r.s[i]! <= 0) continue
    if (r.cls[i] !== COAST_CLASS.land || m.waterSurface[i]) continue
    const H = retail[i]!
    const moved = !m.have[i] || Number.isNaN(H) || Math.abs(r.h[i]! - H) > cfg.placements.dropMovedM
    if (!moved || r.slope[i]! >= cfg.paint.grassMaxDeg) continue
    flank++
    if (isGrass(words[i]! & MAPM_TEXTURE_ID_MASK)) grass++
  }
  return { flank, grass, share: flank ? grass / flank : 1 }
}

/** §12.13 test 5: retail water outside the bounds within the river-mouth keep is never filled. */
export function riverMouthFills(r: CoastResult, retail: Float64Array): { checked: number; filled: Array<{ x: number; z: number; byM: number }> } {
  const { cols } = r.shape
  const m = r.masks
  const filled: Array<{ x: number; z: number; byM: number }> = []
  let checked = 0
  for (let i = 0; i < r.h.length; i++) {
    if (m.inPlay[i] || !m.wetR[i] || !m.kept[i] || r.joinSoft[i]! < 0.5) continue
    checked++
    const by = r.h[i]! - retail[i]!
    if (by > 0.01 && filled.length < 200) {
      const col = i % cols
      filled.push({ x: xOf(r, col), z: zOf(r, (i - col) / cols), byM: by })
    }
  }
  return { checked, filled }
}

/** A water wall: the dry ground beside a sea-level water plane lies this far (m) or more under the sea level. */
export const WALL_BELOW_M = 0.5

/**
 * Water walls (see the header): lattice vertices beside in-bounds retail water at the sea level (4-neighbours of a
 * waterLow vertex) on ground the coast shapes that is neither water nor sea and lies more than WALL_BELOW_M under SL.
 * The hunt's version (packages/world-render/test/abuse-w10r-coast-spec.test.ts) probes the export through the client's
 * coast field.
 */
export function waterWalls(r: CoastResult, cfg: Pick<CoastConfig, 'seaLevelM'>, masks: SeaMasks): { checked: number; walls: Array<{ x: number; z: number; belowM: number }> } {
  const { rows, cols } = r.shape
  const m = r.masks
  const SL = cfg.seaLevelM
  const walls: Array<{ x: number; z: number; belowM: number }> = []
  const seen = new Uint8Array(rows * cols)
  let checked = 0
  for (let i = 0; i < rows * cols; i++) {
    if (!m.inPlay[i] || !m.waterLow[i]) continue
    const c = i % cols
    for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
      if (j < 0 || j >= rows * cols || seen[j]) continue
      if ((m.inPlay[j] && !m.patch[j]) || m.inCorr[j] || r.landFade[j]! >= 0.5 || m.tombKeep[j]) continue
      seen[j] = 1
      checked++
      if (m.wetR[j] || masks.sea[j] || !(r.h[j]! < SL - WALL_BELOW_M)) continue
      const col = j % cols
      walls.push({ x: xOf(r, col), z: zOf(r, (j - col) / cols), belowM: Math.round((SL - r.h[j]!) * 10) / 10 })
    }
  }
  return { checked, walls }
}
