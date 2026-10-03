/**
 * Banks of the in-bounds sea-level water (W10R hunt CST-H1 / CST-H2; docs/COAST.md §13's berms). Node-free.
 *
 * A retail water block at the sea level inside the bounds (the bay, the S2 river, the east shelf) draws its own +5 m
 * plane, which ends at the block's edge. Where the ground beyond that edge is dry and below the sea level, the plane
 * ends in mid-air over a trench: a water wall. Two places make such ground:
 * - outside the bounds, the kept export ring right past the line, which the line blend holds near its retail height
 *   and the pass's hollow rule keeps dry because it lies landward of the beach's waterline (175_100, 170_103, the S2
 *   mouth);
 * - inside the S1 height patch, whose inward feather keeps the retail ground (0 m, a -27 m channel) next to the river.
 *
 * `settleBanks` floods (4-connected) from the in-bounds sea-level water through that dry ground below the sea level
 * (outside the bounds, or inside a height patch) and makes it water surface (class sea), so the ocean continues the
 * +5 m plane right from the block's edge (a fill would leave the 2 m cell between the block's edge vertex, the retail
 * bed, and the bank dry). Where it does not join the sea mask (an enclosed pocket the ocean would not draw, or coast
 * water the flood crosses that the sea mask misses) it is shaped into a bank instead (P-DATA, the polish pass: the
 * flat SL + BANK_FILL_M shelf with a 5.5 m wall down to the in-bounds floor at 175_99 / 175_100 read as a dyke): a
 * smooth (harmonic) surface between the pocket's surroundings, held at SL + BANK_FILL_M or above only where it meets
 * the in-bounds sea-level water's blocks (their plane must end buried), so it rises out of the water there and out of
 * the dry in-bounds floor elsewhere, up to the dune behind it, with no shelf and no wall. Outside the bounds
 * ./source.ts gives a ring block over the bank a water block at SL where all of its ground stands at or above SL
 * (TECH's C10 rule: the in-bounds plane continues into the berm, buried, so no slot opens between the block's edge
 * vertex and the bank); the bank's low parts beside a dry floor get none. Inside the bounds,
 * ./navgen.ts closes a height patch's sea more than knee-deep (C7), so the channel is not walkable. The frozen playable
 * set, the corridor (C12), land edges and the tomb keep are never touched. Runs on the merged result (after the
 * authored layers), before the paint and the sea mask (./hook.ts); checks.waterWalls reports what is left.
 */
import { MAPM_BLOCK_TILES } from '@sro/formats'
import type { CoastConfig } from './config.ts'
import { seaMasks } from './field.ts'
import { CELL_M } from './lattice.ts'
import { slopeDeg } from './grid.ts'
import { COAST_CLASS, type CoastResult } from './pass.ts'

/** A bank stands at least this far above the sea level (m) where it meets the in-bounds sea-level water: a water plane
 *  at SL meets dry ground, and the water block ./source.ts adds over it stays buried without depth fighting. */
export const BANK_FILL_M = 0.5
/** The bank's relaxation: successive over-relaxation factor and the iteration cap (it stops once it moves < 1 mm). */
const BANK_SOR = 1.8
const BANK_ITERATIONS = 4000
/** The bank also re-shapes this many lattice cells (2 m) of the dry ring ground around the pocket: it runs up the dune's
 *  inner face instead of leaving a flat at the pocket's rim (which lies at the sea level). Raise only. */
const BANK_BLEND_CELLS = 10
/** The blend band keeps off the lattice cells this close to the playable set (its line keeps the retail slope). */
const BANK_LINE_CELLS = 2
/** Ground counts as below the sea level from this far under it: all of it, so the fill leaves no vertex within the
 *  pass's 2 cm sea margin (step 9) under a block ./source.ts gives water at SL (no depth fighting). */
const BELOW_M = 0

export interface BankStats {
  /** Vertices that became water surface (they join the sea). */
  watered: number
  /** Of `watered`, inside a height patch. */
  wateredInPatch: number
  /** Vertices shaped into a bank (pockets that do not join the sea). */
  filled: number
  /** Bank vertices held at SL + BANK_FILL_M or above (beside the in-bounds sea-level water, and the rest of each MAPM
   *  block that holds such a vertex: `blockHolds`). */
  heldAboveSea: number
  /** The bank's lowest and highest ground (m), rounded to cm; null without a bank. */
  rangeM: [number, number] | null
}

export interface Banks {
  stats: BankStats
  /** Per lattice vertex: 1 where the ground was filled (./source.ts gives the ring blocks over it water at SL). */
  filled: Uint8Array
}

/**
 * `slPlane` (optional): per lattice vertex, 1 inside an in-bounds retail water block at the sea level, whether or not
 * the ground there stands above the water (./hook.ts derives it from the retail water); default `masks.waterLow`.
 */
export function settleBanks(r: CoastResult, cfg: Pick<CoastConfig, 'seaLevelM'>, slPlane?: Uint8Array): Banks {
  const { rows, cols } = r.shape
  const N = rows * cols
  const m = r.masks
  const SL = cfg.seaLevelM
  const stats: BankStats = { watered: 0, wateredInPatch: 0, filled: 0, heldAboveSea: 0, rangeM: null }
  const filled = new Uint8Array(N)
  // ground the coast shapes (outside the bounds, or a height patch) below the sea level; dry, or already the coast's
  // own water surface (not retail water), which the flood crosses so it finds the pockets the sea mask misses
  const candidate = (j: number) => {
    if (m.tombKeep[j] || m.wetR[j] || r.cls[j] === COAST_CLASS.retailWater || !(r.h[j]! < SL - BELOW_M)) return false
    if (m.patch[j]) return true
    return !m.inPlay[j] && !m.inCorr[j] && r.landFade[j]! < 0.5
  }
  // 1 = dry ground the flood reached, 2 = coast water it crossed, 3 = a seed
  const reach = new Uint8Array(N)
  const stack = new Int32Array(N)
  let top = 0
  for (let i = 0; i < N; i++) {
    if (m.inPlay[i] && m.waterLow[i]) {
      reach[i] = 3
      stack[top++] = i
    }
  }
  let found = 0
  while (top > 0) {
    const i = stack[--top]!
    const c = i % cols
    const visit = (j: number) => {
      if (reach[j] || !candidate(j)) return
      reach[j] = m.waterSurface[j] ? 2 : 1
      if (reach[j] === 1) found++
      stack[top++] = j
    }
    if (c > 0) visit(i - 1)
    if (c < cols - 1) visit(i + 1)
    if (i >= cols) visit(i - cols)
    if (i < N - cols) visit(i + cols)
  }

  const was = new Uint8Array(found ? N : 0)
  for (let i = 0; i < N && found; i++) {
    if (reach[i] !== 1) continue
    was[i] = r.cls[i]!
    m.waterSurface[i] = 1
    r.cls[i] = COAST_CLASS.sea
  }
  // pockets the sea mask does not reach would stay undrawn (no water block, no ocean): shape them into a bank instead
  const sea = seaMasks(r).sea
  for (let i = 0; i < N; i++) {
    const k = reach[i]!
    if (k !== 1 && k !== 2) continue
    if (sea[i]) {
      if (k === 1) {
        stats.watered++
        if (m.patch[i]) stats.wateredInPatch++
      }
      continue
    }
    m.waterSurface[i] = 0
    r.cls[i] = k === 1 ? was[i]! : COAST_CLASS.land
    filled[i] = 1
    stats.filled++
  }
  if (stats.filled) {
    shapeBank(r, filled, slPlane ?? m.waterLow, SL, stats, sea)
    r.slope = Float32Array.from(slopeDeg(r.h, rows, cols, CELL_M))
  }
  return { stats, filled }
}

/**
 * The bank over `filled`: a harmonic surface (each vertex the mean of its four neighbours) over the pocket and a
 * BANK_BLEND_CELLS band of the dry ring ground around it (so it runs up the dune's inner face instead of meeting it in
 * a flat at the pocket's rim, which lies at the sea level), with the rest of the ground around as its boundary and water
 * read at its surface. The vertices beside an in-bounds sea-level water block (8-neighbours of `slPlane` inside the
 * bounds) are held at SL + BANK_FILL_M or above, so that block's plane always ends buried; so is every vertex of a
 * MAPM water block (16 x 16 cells) of the bank beside it (`blockHolds`). Nothing is lowered. Projected Gauss-Seidel
 * with over-relaxation.
 */
function shapeBank(r: CoastResult, filled: Uint8Array, slPlane: Uint8Array, SL: number, stats: BankStats, sea: Uint8Array): void {
  const { rows, cols } = r.shape
  const N = rows * cols
  const m = r.masks
  const floor = SL + BANK_FILL_M
  const near = (i: number): number[] => {
    const c = i % cols
    return [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i >= cols ? i - cols : -1, i < N - cols ? i + cols : -1].filter(j => j >= 0)
  }
  // the pocket (1) and the blend band (2): dry ring ground the coast shapes, within BANK_BLEND_CELLS of the pocket
  const set = new Uint8Array(N)
  let front: number[] = []
  for (let i = 0; i < N; i++) {
    if (!filled[i]) continue
    set[i] = 1
    front.push(i)
  }
  // never the two cells next to the frozen playable set: the line keeps its retail slope there (checks.lineCreases)
  const nearPlay = (j: number) => {
    const c = j % cols
    for (let dz = -BANK_LINE_CELLS; dz <= BANK_LINE_CELLS; dz++) {
      for (let dx = -BANK_LINE_CELLS; dx <= BANK_LINE_CELLS; dx++) {
        const k = j + dz * cols + dx
        if (c + dx >= 0 && c + dx < cols && k >= 0 && k < N && m.inPlay[k]) return true
      }
    }
    return false
  }
  const bandOk = (j: number) => !m.inPlay[j] && !m.inCorr[j] && !m.tombKeep[j] && !m.waterSurface[j] && !m.wetR[j] &&
    r.landFade[j]! < 0.5 && r.h[j]! >= SL && !nearPlay(j)
  for (let d = 0; d < BANK_BLEND_CELLS; d++) {
    const next: number[] = []
    for (const i of front) {
      for (const j of near(i)) {
        if (set[j] || !bandOk(j)) continue
        set[j] = 2
        next.push(j)
      }
    }
    front = next
  }
  const ids: number[] = []
  for (let i = 0; i < N; i++) if (set[i]) ids.push(i)
  const was = Float64Array.from(ids, i => r.h[i]!)
  const held = Uint8Array.from(ids, i => {
    if (set[i] !== 1) return 0
    const c = i % cols
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = i + dz * cols + dx
        if (c + dx >= 0 && c + dx < cols && j >= 0 && j < N && m.inPlay[j] && slPlane[j]) return 1
      }
    }
    return 0
  })
  const blocks = blockHolds(r, set, held, ids, sea, SL)
  ids.forEach((i, n) => {
    if (blocks[i]) held[n] = 1
  })
  for (const v of held) stats.heldAboveSea += v
  // the boundary: the ground around, water at its surface
  const edge = (j: number) => (m.waterSurface[j] || m.wetR[j] ? Math.max(r.h[j]!, SL) : r.h[j]!)
  const fixed = ids.map(i => near(i).map(j => (set[j] ? -1 : edge(j))))
  const links = ids.map(i => near(i))
  for (const i of ids) if (set[i] === 1) r.h[i] = floor
  for (let it = 0; it < BANK_ITERATIONS; it++) {
    let moved = 0
    for (let n = 0; n < ids.length; n++) {
      const i = ids[n]!
      const nb = links[n]!
      const fx = fixed[n]!
      if (!nb.length) continue
      let sum = 0
      for (let k = 0; k < nb.length; k++) sum += fx[k]! >= -0.5 && !set[nb[k]!] ? fx[k]! : r.h[nb[k]!]!
      let v = r.h[i]! + BANK_SOR * (sum / nb.length - r.h[i]!)
      if (held[n]) v = Math.max(v, floor)
      moved = Math.max(moved, Math.abs(v - r.h[i]!))
      r.h[i] = v
    }
    if (moved < 1e-3) break
  }
  let lo = Infinity
  let hi = -Infinity
  ids.forEach((i, n) => {
    r.h[i] = Math.max(r.h[i]!, was[n]!)
    if (set[i] !== 1) return
    lo = Math.min(lo, r.h[i]!)
    hi = Math.max(hi, r.h[i]!)
  })
  stats.rangeM = [Math.round(lo * 100) / 100, Math.round(hi * 100) / 100]
}

/**
 * Polish gate (abuse-w10r-coast-spec finding 1 on the re-converted export): ./source.ts gives a ring block of the bank
 * its buried water at SL only when every bank vertex of the block stands BANK_FILL_M above SL and its other vertices
 * at or above SL (the in-bounds water's own vertices aside), and that block is what covers the slot between the
 * in-bounds plane's edge vertex (the retail bed at the line) and the bank's first vertex 2 m out. Holding only the
 * plane's neighbours left the rest of such a block on the ramp down to the dry floor, so the block stayed dry and the
 * plane ended over the slot (175.0 x 100.0-100.5, up to 2.8 m). Here every pocket vertex of a MAPM block (16 x 16
 * cells, the lattice is region-aligned) that holds a plane neighbour is held too, when the block can qualify at all:
 * none of its vertices is sea, and each is in-bounds sea-level water, pocket (held now) or other ground at or above SL.
 * The ramp then starts at that block's edge.
 */
function blockHolds(r: CoastResult, set: Uint8Array, held: Uint8Array, ids: number[], sea: Uint8Array, SL: number): Uint8Array {
  const { rows, cols } = r.shape
  const m = r.masks
  const out = new Uint8Array(rows * cols)
  const B = MAPM_BLOCK_TILES
  const seeds = new Set<number>()
  ids.forEach((i, n) => {
    if (!held[n]) return
    const row = Math.floor(i / cols)
    const col = i % cols
    // a vertex on a block edge belongs to every block that shares it
    for (const br of new Set([Math.floor(row / B), Math.ceil(row / B) - 1])) {
      for (const bc of new Set([Math.floor(col / B), Math.ceil(col / B) - 1])) if (br >= 0 && bc >= 0) seeds.add(br * 1e5 + bc)
    }
  })
  for (const key of seeds) {
    const br = Math.floor(key / 1e5)
    const bc = key % 1e5
    const r0 = br * B
    const c0 = bc * B
    if (r0 + B >= rows || c0 + B >= cols) continue
    let ok = true
    for (let vr = 0; vr <= B && ok; vr++) {
      for (let vc = 0; vc <= B; vc++) {
        const j = (r0 + vr) * cols + c0 + vc
        if (sea[j] || !(set[j] === 1 || (m.inPlay[j] && m.waterLow[j]) || r.h[j]! >= SL)) {
          ok = false
          break
        }
      }
    }
    if (!ok) continue
    for (let vr = 0; vr <= B; vr++) {
      for (let vc = 0; vc <= B; vc++) {
        const j = (r0 + vr) * cols + c0 + vc
        if (set[j] === 1) out[j] = 1
      }
    }
  }
  return out
}
