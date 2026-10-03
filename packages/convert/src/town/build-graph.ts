/**
 * `pnpm sro town-graph`: the town's route graph and places (docs/TOWN_LIFE.md §2.4, §3; docs/WAVE_PLAN7.md D14, §6.1
 * TL-R). Lane TL-R.
 *
 * From the export's navigation (`work/out/world/<world>/nav.bin` + manifest) and its placements:
 *
 * 1. **The walkable grid**: a 1 m grid over the town box; a cell is walkable when the navmesh has a surface there in the
 *    town spawn's walkable component (so roofs, house footprints and closed terrain are out) and no solid object
 *    footprint covers it (the server's "inside a building" rule, apps/server nav.ts SolidIndex). A chamfer distance
 *    transform gives each cell its clearance.
 * 2. **Nodes** every ≈ 8 m: walkable cells with ≥ 1.2 m clearance, the widest first (street centres, the plaza).
 * 3. **Edges** between nodes ≤ 13 m apart whose straight segment lies on the navmesh: `checkTownSegment` walks it with
 *    `@sro/nav` at 0.5 m steps (every step located in the home component, not under a solid footprint, a height step
 *    ≤ 0.6 m) and keeps 0.4 m from every nav edge (8 probes per step, each a real `moveStraight`). A relative-
 *    neighbourhood pruning keeps the graph sparse; the largest connected part is kept. Last (after the places' links),
 *    every edge whose linear height leaves the visible walkable surface by more than 0.25 m (a stair's head or foot, a
 *    kerb, a ramp onto a terrace) is split by nodes on the ground (`splitSlopeEdges`): walkers keep their feet on it.
 * 4. **Places**: doors (the town gates, and the most open frontage of each house), stalls (`cj_streetstall` and the
 *    dressing file's stall props), tea tables (`cj_table_chair`, `cj_table01` with their bench seats), statue plinth
 *    seats (`c_sta_01`), the dragon fountain's rim, the east pond's edge, chat rings in the open squares, the smith's
 *    anvil, the stable and the gates' guard posts; each linked to a node by a checked segment (node → point, node →
 *    every seat).
 * 5. **Folk**: districts, fixed agents (a vendor per stall, the smith's apprentice, elders at tea), routes (guard
 *    patrols, the rider, the dusk lantern carriers) from authored waypoints, snapped to nodes and joined by graph paths.
 *
 * The authored parts (hour curve, lines, population and role shares) are kept from an existing `content/town/
 * jangan.json` (a human pass survives a rebuild); the rest is regenerated, reproducibly (no randomness). Wave 12
 * (WE-T): so is the World Editor's `manual` overlay (shared/src/town-manual.ts: nodes, edges and seats added, moved
 * or removed by hand, by position), applied after the regeneration with every edge it touches checked on the navmesh.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { decodeNavData } from '@sro/nav'
import {
  TOWN_FILE_SCHEMA, TOWN_SEAT_MAX_DIST_M, validateTownFile, type TownDistrict, type TownDressingFile, type TownEdge,
  type TownFile, type TownFixedAgent, type TownLines, type TownNode, type TownPlace, type TownPlaceKind, type TownRoute,
  type TownSchedule, type TownSeat,
} from '../../../shared/src/town.ts'
import { applyTownManual, townManualEmpty } from '../../../shared/src/town-manual.ts'
import { REPO_ROOT, type SroConfig } from '../node-io.ts'
import { TOWN_UID_BASE } from '../world/town/dressing.ts'
import {
  TOWN_EDGE_CLEAR_M, TOWN_EDGE_HEIGHT_TOL_M, TOWN_EDGE_STEP_M, TownNav, checkTownEdge, dressingRowsWith, rowObstacle, townWater,
  type DressingRow,
} from './town-nav.ts'

// wave 12 (WE-T): the navigation half lives in ./town-nav.ts (the editor page runs it too)
export {
  SolidFootprints, TOWN_DRESSING_FALLBACK, TOWN_EDGE_CLEAR_M, TOWN_EDGE_DY_M, TOWN_EDGE_HEIGHT_TOL_M, TOWN_EDGE_STEP_M,
  TownNav, checkTownEdge, dressingRowsWith, rowObstacle, townBaseName, townEdgeSlopeGap, townWater,
  type DressingRow, type TownBounds, type TownObstacle,
} from './town-nav.ts'

export const TOWN_GRAPH_USAGE = `pnpm sro town-graph [--world jangan-fields] [--out content/town/jangan.json] [--dry-run] [--debug file.json]
  The town's route graph and places from the navmesh and the retail POIs (docs/TOWN_LIFE.md §2.4)`

// ---- numbers -------------------------------------------------------------------------------------------------------

const GRID_M = 1
const NODE_CLEAR_M = 1.2
const NODE_SPACING_M = 10
const EDGE_MAX_M = 16
/** A chat ring's centre keeps this far from every graph edge (m): walkers pass beside a conversation, not through it. */
const CHAT_LINE_CLEAR_M = 2.4
/** A chat ring's standing spots keep within this of its centre's height (m): talkers on one level, not across a step. */
const CHAT_RING_DY_M = 0.2

// ---- config --------------------------------------------------------------------------------------------------------

export interface TownGraphConfig {
  world: string
  town: string
  seed: number
  /** The town box (glTF metres). */
  box: { x0: number; x1: number; z0: number; z1: number }
  /** A point in the town's walkable component (the spawn). */
  home: { x: number; z: number }
  /** Gate doors: an authored point just inside each gate (snapped to the open ground). */
  gates: Array<{ id: string; x: number; z: number; yaw: number }>
  /** Collision mesh keys of houses (doors are found on their most open side). */
  buildingKey: RegExp
  /** Keys that are never houses even when they match (walls, stairs, bridges…). */
  notBuildingKey: RegExp
  districts: TownDistrict[]
  /** Retail NPC positions: places keep 2 m from them. */
  npcs: Array<{ x: number; z: number }>
  /** Players' arrival point: chat rings and stalls keep 10 m from it (player stalls go there). */
  spawn: { x: number; z: number }
  fountain: { x: number; z: number; maxR: number } | null
  pond: { x: number; z: number; maxR: number } | null
  smith: { x: number; z: number } | null
  stable: { x: number; z: number } | null
  /** Patrol and route waypoints (snapped to nodes and joined by graph paths). */
  routes: Array<{ id: string; role: TownRoute['role']; count: number; points: Array<[number, number]>; hours?: [number, number]; pairs?: boolean }>
  /**
   * Chat rings: how many, spacing (m), the clearance they need (m); `districts` first puts at least that many in a
   * district (the busiest squares are not the most open ground), then the most open ground anywhere takes the rest.
   */
  chat: { count: number; spacing: number; clear: number; districts?: Record<string, number> }
}

/** Jangan (docs/TOWN_LIFE.md §1, §2.4): the walled town of regions 166–169 × 96–99. */
export const JANGAN_GRAPH: TownGraphConfig = {
  world: 'jangan-fields',
  town: 'jangan',
  seed: 0x7a1e,
  box: { x0: -160, x1: 330, z0: -376, z1: 2 },
  home: { x: 96.9, z: -136.9 },
  gates: [
    // just inside the south, west and east gates (the gate soldiers' pairs, npcs.json SO, WE, EA)
    { id: 'gate-south', x: 98.4, z: -11, yaw: Math.PI },
    { id: 'gate-west', x: -150, z: -190, yaw: -Math.PI / 2 },
    { id: 'gate-east', x: 323, z: -182, yaw: Math.PI / 2 },
  ],
  buildingKey: /\/(cj_(acce|armo|etc|weapon|weap|stab|luxury|luxu|resta0[13]|pub0[135]|adult0[234]|mili_main|pal_(guard|side|south|sub|main)_buil|rich\d+_buil|monstad_martbuil)|cj5_tem_(main|sleep))[^/]*\.bms$/,
  notBuildingKey: /(dam|stair|brg|bridge|tower|lamp|light|door|gate|sign|tent|chimn|status|longwall)/,
  districts: [
    // `evening`: where the evening and night crowd goes (TL-R2: the tea house fills, the market and the smithy empty)
    { id: 'plaza', x: 97, z: -110, radius: 65, weight: 3, evening: 1.2 },
    { id: 'market', x: 168, z: -105, radius: 55, weight: 2, evening: 0.15 },
    { id: 'tea', x: -75, z: -80, radius: 75, weight: 1.6, evening: 3.2 },
    { id: 'smith', x: 25, z: -125, radius: 45, weight: 1, evening: 0.2 },
    { id: 'stable', x: 30, z: -50, radius: 35, weight: 0.5, evening: 0.2 },
    { id: 'avenue', x: 97, z: -260, radius: 70, weight: 0.8, evening: 0.7 },
    { id: 'temple', x: 255, z: -270, radius: 60, weight: 0.5, evening: 0.4 },
    { id: 'rich', x: 295, z: -100, radius: 50, weight: 0.4, evening: 0.4 },
    { id: 'camp', x: -90, z: -280, radius: 75, weight: 0.5, evening: 0.6 },
    // the three gates' squares (TL-R2: travellers coming and going keep them busy by day)
    { id: 'gate-south', x: 98, z: -26, radius: 26, weight: 0.9, evening: 0.3 },
    { id: 'gate-west', x: -136, z: -190, radius: 24, weight: 0.8, evening: 0.15 },
    { id: 'gate-east', x: 308, z: -182, radius: 24, weight: 0.8, evening: 0.15 },
  ],
  npcs: [],
  spawn: { x: 96.9, z: -136.9 },
  fountain: { x: 98, z: -86.5, maxR: 18 },
  pond: { x: 230, z: -228, maxR: 22 },
  smith: { x: 33.3, z: -140.7 },
  stable: { x: 32.9, z: -45.1 },
  routes: [
    { id: 'patrol-plaza', role: 'guard', count: 1, pairs: true, points: [[70, -95], [125, -95], [125, -130], [70, -130]] },
    { id: 'patrol-avenue', role: 'guard', count: 1, pairs: true, points: [[98, -15], [98, -60], [97, -150], [97, -185], [97, -150], [98, -60]] },
    { id: 'patrol-market', role: 'guard', count: 1, pairs: true, points: [[140, -90], [190, -90], [190, -135], [140, -135]] },
    { id: 'patrol-west', role: 'guard', count: 1, pairs: true, points: [[40, -100], [-30, -100], [-120, -80], [-140, -190], [-30, -170]] },
    { id: 'rider-avenue', role: 'rider', count: 1, points: [[98, -15], [97, -150], [97, -185], [97, -150]] },
    { id: 'lanterns', role: 'lanternCarrier', count: 2, hours: [18, 20], points: [[98, -20], [98, -70], [97, -140], [97, -180], [97, -140], [98, -70]] },
  ],
  chat: { count: 22, spacing: 16, clear: 3, districts: { plaza: 4, market: 3, 'gate-south': 1, 'gate-west': 1, 'gate-east': 1 } },
}

// ---- the walkable town ---------------------------------------------------------------------------------------------

/**
 * The dressing's props and banners, with bounds from our prop sidecars (`content/town/props/<name>.json`), the
 * export's models, or a fallback box. Every row stays a keep-out whether or not the export places it yet (the dressing
 * has no collision in nav.bin); a placement of the same model within 0.5 m (the re-convert placed it) gives its height.
 */
export function dressingRows(dressing: TownDressingFile | null, manifest: ExportManifest, propsDir = join(REPO_ROOT, 'content', 'town', 'props')): DressingRow[] {
  return dressingRowsWith(dressing, manifest, (name) => {
    const side = join(propsDir, `${name}.json`)
    if (!existsSync(side)) return null
    const j = JSON.parse(readFileSync(side, 'utf8')) as { boundsMin?: [number, number, number]; boundsMax?: [number, number, number] }
    return j.boundsMin && j.boundsMax ? { min: j.boundsMin, max: j.boundsMax } : null
  })
}

/** Loads an export's navigation (manifest + nav.bin) as a TownNav. */
export function loadTownNav(worldDir: string, cfg: Pick<TownGraphConfig, 'home'>): { nav: TownNav; manifest: ExportManifest } {
  const manifest = JSON.parse(readFileSync(join(worldDir, 'manifest.json'), 'utf8')) as ExportManifest
  const file = manifest.nav?.file
  if (!file) throw new Error(`${worldDir}/manifest.json has no nav`)
  const bytes = readFileSync(join(worldDir, file))
  const data = decodeNavData(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  const nav = new TownNav(data, manifest.space.originRegion, cfg.home)
  nav.water = townWater(manifest)
  return { nav, manifest }
}

/** The parts of manifest.json the script reads. */
export interface ExportManifest {
  space: { originRegion: { x: number; z: number } }
  regions?: Array<{ x: number; z: number; blocks: Array<{ bx: number; bz: number; water: { kind: string; heightM: number } | null }> }>
  nav?: { file: string }
  models: Array<{ index: number; source: string; boundsMin: [number, number, number]; boundsMax: [number, number, number] }>
  placements: Array<{ source: string; models: number[]; position: [number, number, number]; rotation: [number, number, number, number]; uid: number }>
}

// ---- the grid ------------------------------------------------------------------------------------------------------

export class TownGrid {
  readonly w: number
  readonly h: number
  /** Ground height, NaN where not walkable. */
  readonly y: Float32Array
  /** Clearance (m) to the nearest non-walkable cell (chamfer). */
  readonly clear: Float32Array
  /** Solid footprint index under the cell (-1 none). */
  readonly solid: Int32Array

  constructor(readonly nav: TownNav, readonly box: TownGraphConfig['box']) {
    this.w = Math.ceil((box.x1 - box.x0) / GRID_M)
    this.h = Math.ceil((box.z1 - box.z0) / GRID_M)
    const n = this.w * this.h
    this.y = new Float32Array(n).fill(NaN)
    this.clear = new Float32Array(n)
    this.solid = new Int32Array(n).fill(-1)
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const x = this.cx(i)
        const z = this.cz(j)
        const p = nav.g.locateIn(x, z, Infinity, nav.home)
        const top = nav.g.locate(x, z, Infinity)
        const s = nav.solids.at(x, z, p?.y ?? top?.y ?? 0)
        this.solid[j * this.w + i] = s
        if (p && s < 0 && !nav.wet(x, z, p.y) && nav.obstacleAt(x, z) < 0) this.y[j * this.w + i] = p.y
      }
    }
    // chamfer distance transform (3-4 weights), in cells
    const INF = 1e9
    const d = new Float32Array(n)
    for (let k = 0; k < n; k++) d[k] = Number.isNaN(this.y[k]!) ? 0 : INF
    const w = this.w
    const a = 1, b = Math.SQRT2
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i
        if (d[k] === 0) continue
        let v = d[k]!
        if (i > 0) v = Math.min(v, d[k - 1]! + a)
        else v = Math.min(v, a)
        if (j > 0) {
          v = Math.min(v, d[k - w]! + a)
          if (i > 0) v = Math.min(v, d[k - w - 1]! + b)
          if (i < w - 1) v = Math.min(v, d[k - w + 1]! + b)
        } else v = Math.min(v, a)
        d[k] = v
      }
    }
    for (let j = this.h - 1; j >= 0; j--) {
      for (let i = w - 1; i >= 0; i--) {
        const k = j * w + i
        if (d[k] === 0) continue
        let v = d[k]!
        if (i < w - 1) v = Math.min(v, d[k + 1]! + a)
        else v = Math.min(v, a)
        if (j < this.h - 1) {
          v = Math.min(v, d[k + w]! + a)
          if (i < w - 1) v = Math.min(v, d[k + w + 1]! + b)
          if (i > 0) v = Math.min(v, d[k + w - 1]! + b)
        } else v = Math.min(v, a)
        d[k] = v
      }
    }
    for (let k = 0; k < n; k++) this.clear[k] = d[k]! === 0 ? 0 : (d[k]! - 0.5) * GRID_M
  }

  cx(i: number): number {
    return this.box.x0 + (i + 0.5) * GRID_M
  }
  cz(j: number): number {
    return this.box.z0 + (j + 0.5) * GRID_M
  }
  cell(x: number, z: number): number {
    const i = Math.floor((x - this.box.x0) / GRID_M)
    const j = Math.floor((z - this.box.z0) / GRID_M)
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i
  }
  clearAt(x: number, z: number): number {
    const c = this.cell(x, z)
    return c < 0 ? 0 : this.clear[c]!
  }
  /** The walkable cell nearest (x, z) with clearance ≥ minClear within maxR, or null. */
  snap(x: number, z: number, minClear: number, maxR = 12, avoid?: (x: number, z: number) => boolean): { x: number; z: number; y: number } | null {
    let best: { x: number; z: number; y: number } | null = null
    let bd = Infinity
    const r = Math.ceil(maxR / GRID_M)
    const c0 = this.cell(x, z)
    if (c0 < 0) return null
    const i0 = c0 % this.w
    const j0 = Math.floor(c0 / this.w)
    for (let j = Math.max(0, j0 - r); j <= Math.min(this.h - 1, j0 + r); j++) {
      for (let i = Math.max(0, i0 - r); i <= Math.min(this.w - 1, i0 + r); i++) {
        const k = j * this.w + i
        if (this.clear[k]! < minClear) continue
        const px = this.cx(i)
        const pz = this.cz(j)
        if (avoid?.(px, pz)) continue
        const d = Math.hypot(px - x, pz - z)
        if (d < bd && d <= maxR) {
          bd = d
          best = { x: px, z: pz, y: this.y[k]! }
        }
      }
    }
    return best
  }
}

// ---- the graph -----------------------------------------------------------------------------------------------------

export interface BuiltGraph {
  nodes: TownNode[]
  edges: TownEdge[]
  report: string[]
}

/** Nodes every ≈ 8 m on the widest cells, edges checked on the navmesh, RNG-pruned, the largest part kept. */
export function buildNodesAndEdges(grid: TownGrid, nav: TownNav): BuiltGraph {
  const report: string[] = []
  // candidates: widest first, ties by position (reproducible)
  const cand: number[] = []
  for (let k = 0; k < grid.clear.length; k++) if (grid.clear[k]! >= NODE_CLEAR_M) cand.push(k)
  cand.sort((a, b) => grid.clear[b]! - grid.clear[a]! || a - b)
  const hash = new Map<number, number[]>()
  const hkey = (x: number, z: number) => Math.floor(x / NODE_SPACING_M) * 4096 + Math.floor(z / NODE_SPACING_M)
  const pts: Array<{ x: number; z: number; y: number }> = []
  for (const k of cand) {
    const x = grid.cx(k % grid.w)
    const z = grid.cz(Math.floor(k / grid.w))
    let ok = true
    const gx = Math.floor(x / NODE_SPACING_M)
    const gz = Math.floor(z / NODE_SPACING_M)
    for (let dz = -1; dz <= 1 && ok; dz++) {
      for (let dx = -1; dx <= 1 && ok; dx++) {
        for (const p of hash.get((gx + dx) * 4096 + gz + dz) ?? []) {
          if (Math.hypot(pts[p]!.x - x, pts[p]!.z - z) < NODE_SPACING_M) {
            ok = false
            break
          }
        }
      }
    }
    if (!ok) continue
    const p = nav.ground(x, z, grid.y[k]!)
    if (!p || !nav.clear(p, Math.min(1, NODE_CLEAR_M - 0.1))) continue
    const i = pts.length
    pts.push({ x, z, y: p.y })
    const key = hkey(x, z)
    const list = hash.get(key)
    if (list) list.push(i)
    else hash.set(key, [i])
  }
  report.push(`nodes: ${pts.length} candidates placed (spacing ${NODE_SPACING_M} m, clearance >= ${NODE_CLEAR_M} m)`)
  // candidate edges: cheap grid clearance first (every 0.5 m sample >= 0.5 m clear on the grid)
  const pairs: Array<[number, number, number]> = []
  for (let a = 0; a < pts.length; a++) {
    const pa = pts[a]!
    const gx = Math.floor(pa.x / NODE_SPACING_M)
    const gz = Math.floor(pa.z / NODE_SPACING_M)
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (const b of hash.get((gx + dx) * 4096 + gz + dz) ?? []) {
          if (b <= a) continue
          const pb = pts[b]!
          const d = Math.hypot(pb.x - pa.x, pb.z - pa.z)
          if (d > EDGE_MAX_M) continue
          let ok = true
          const steps = Math.ceil(d / TOWN_EDGE_STEP_M)
          for (let s = 0; s <= steps && ok; s++) {
            const f = s / steps
            if (grid.clearAt(pa.x + (pb.x - pa.x) * f, pa.z + (pb.z - pa.z) * f) < 0.5) ok = false
          }
          if (ok) pairs.push([a, b, d])
        }
      }
    }
  }
  // relative-neighbourhood pruning: drop a-b when some c is closer to both (and a-c, c-b are candidates)
  const cset = new Set(pairs.map(([a, b]) => a * 100000 + b))
  const has = (a: number, b: number) => cset.has(Math.min(a, b) * 100000 + Math.max(a, b))
  const nbr = new Map<number, number[]>()
  for (const [a, b] of pairs) {
    ;(nbr.get(a) ?? nbr.set(a, []).get(a)!).push(b)
    ;(nbr.get(b) ?? nbr.set(b, []).get(b)!).push(a)
  }
  const kept: Array<[number, number]> = []
  for (const [a, b, d] of pairs) {
    let drop = false
    for (const c of nbr.get(a) ?? []) {
      if (c === b) continue
      const dac = Math.hypot(pts[a]!.x - pts[c]!.x, pts[a]!.z - pts[c]!.z)
      const dbc = Math.hypot(pts[b]!.x - pts[c]!.x, pts[b]!.z - pts[c]!.z)
      if (dac < d && dbc < d && has(b, c)) {
        drop = true
        break
      }
    }
    if (!drop) kept.push([a, b])
  }
  // the exact check on the navmesh
  const good: Array<[number, number]> = []
  let refused = 0
  for (const [a, b] of kept) {
    const pa = pts[a]!
    const pb = pts[b]!
    if (nav.checkSegment(pa.x, pa.z, pa.y, pb.x, pb.z, pb.y) === null) good.push([a, b])
    else refused++
  }
  report.push(`edges: ${pairs.length} candidates, ${kept.length} after pruning, ${refused} refused by the navmesh check`)
  // the largest connected part
  const parent = pts.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  for (const [a, b] of good) parent[find(a)] = find(b)
  const size = new Map<number, number>()
  for (let i = 0; i < pts.length; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1)
  let root = -1
  let best = 0
  for (const [r, s] of size) if (s > best) {
    best = s
    root = r
  }
  const keepIdx = pts.map((_, i) => i).filter((i) => find(i) === root)
  // ids by position (north to south, west to east): stable across rebuilds of the same export
  keepIdx.sort((i, j) => pts[i]!.z - pts[j]!.z || pts[i]!.x - pts[j]!.x)
  const id = new Map<number, string>()
  keepIdx.forEach((i, n) => id.set(i, `n${n}`))
  const nodes: TownNode[] = keepIdx.map((i) => ({ id: id.get(i)!, x: r2(pts[i]!.x), z: r2(pts[i]!.z), y: r2(pts[i]!.y) }))
  const edges: TownEdge[] = good.filter(([a, b]) => id.has(a) && id.has(b)).map(([a, b]) => ({ a: id.get(a)!, b: id.get(b)! }))
  edges.sort((e, f) => Number(e.a.slice(1)) - Number(f.a.slice(1)) || Number(e.b.slice(1)) - Number(f.b.slice(1)))
  report.push(`graph: ${nodes.length} nodes, ${edges.length} edges (largest connected part of ${pts.length})`)
  return { nodes, edges, report }
}

/**
 * Feet on the ground (TOWN_LIFE §3.4): the client draws a walker's height linearly between two nodes (schedule.ts walk
 * legs), so an edge that crosses a slope break (a stair's head or foot, a ramp onto a terrace) is split where that line
 * leaves the walkable surface by more than TOWN_EDGE_HEIGHT_TOL_M: a node on the ground at the worst sample, again on
 * each half, down to TOWN_EDGE_SPLIT_MIN_M. The new nodes (`s<k>`) lie on the checked segment, so both halves pass the
 * same check; the edge is replaced in place by its chain.
 */
const TOWN_EDGE_SPLIT_STEP_M = 0.25
const TOWN_EDGE_SPLIT_MIN_M = 0.25

export function splitSlopeEdges(nav: TownNav, g: { nodes: TownNode[]; edges: TownEdge[] }): string[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const edges: TownEdge[] = []
  let made = 0
  let split = 0
  let kept = 0
  let worstLeft = 0
  const unsplit: TownEdge[] = []
  for (const e of g.edges) {
    const a = byId.get(e.a)
    const b = byId.get(e.b)
    if (!a || !b || a.y === undefined || b.y === undefined) {
      edges.push(e)
      continue
    }
    // the ground profile along a -> b (each sample located from the previous one, as the walk does)
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    const steps = Math.max(1, Math.ceil(len / TOWN_EDGE_SPLIT_STEP_M))
    const gy = new Float64Array(steps + 1)
    let prev = a.y
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      const p = nav.surfaceAt(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f, prev)
      gy[i] = p ? p.y : prev
      if (p) prev = p.y
    }
    gy[0] = a.y
    gy[steps] = b.y
    const minGap = Math.max(1, Math.round(TOWN_EDGE_SPLIT_MIN_M / (len / steps)))
    const cuts: number[] = []
    const cut = (i0: number, i1: number) => {
      let worst = 0
      let at = -1
      for (let i = i0 + 1; i < i1; i++) {
        const lin = gy[i0]! + ((gy[i1]! - gy[i0]!) * (i - i0)) / (i1 - i0)
        const d = Math.abs(lin - gy[i]!)
        if (d > worst) {
          worst = d
          at = i
        }
      }
      if (worst <= TOWN_EDGE_HEIGHT_TOL_M) return
      if (at - i0 < minGap || i1 - at < minGap) {
        worstLeft = Math.max(worstLeft, worst)
        return
      }
      cut(i0, at)
      cuts.push(at)
      cut(at, i1)
    }
    cut(0, steps)
    if (!cuts.length) {
      edges.push(e)
      continue
    }
    // each node at its sample, or the nearest one beside it (within 1 m) whose rounded point keeps the edges' clearance
    const chain: TownNode[] = []
    let lo = 0
    for (const [c, i] of cuts.entries()) {
      const hi = cuts[c + 1] ?? steps
      let n: TownNode | null = null
      for (const j of [i, i - 1, i + 1, i - 2, i + 2, i - 3, i + 3, i - 4, i + 4]) {
        if (j <= lo || j >= hi) continue
        const f = j / steps
        const x = r2(a.x + (b.x - a.x) * f)
        const z = r2(a.z + (b.z - a.z) * f)
        const p = nav.surfaceAt(x, z, gy[j]!)
        if (!p || Math.abs(p.y - gy[j]!) > 0.05 || !nav.clear(p, TOWN_EDGE_CLEAR_M)) continue
        n = { id: '', x, z, y: r2(p.y) }
        lo = j
        break
      }
      if (!n) {
        chain.length = 0
        break
      }
      chain.push(n)
    }
    const ends = [a, ...chain, b]
    if (!chain.length || ends.slice(1).some((n, k) => nav.checkSegment(ends[k]!.x, ends[k]!.z, ends[k]!.y!, n.x, n.z, n.y!) !== null)) {
      // no split keeps the clearance: the edge goes when the graph keeps a and b connected without it
      unsplit.push(e)
      edges.push(e)
      continue
    }
    split++
    let from = a
    for (const n of chain) {
      n.id = `s${made++}`
      g.nodes.push(n)
      edges.push({ a: from.id, b: n.id })
      from = n
    }
    edges.push({ a: from.id, b: b.id })
  }
  let dropped = 0
  for (const e of unsplit) {
    const rest = edges.filter((f) => f !== e)
    if (connected(rest, e.a, e.b)) {
      edges.splice(edges.indexOf(e), 1)
      dropped++
    } else kept++
  }
  g.edges.length = 0
  g.edges.push(...edges)
  return [`slope breaks: ${split} edges split by ${made} nodes (the drawn height keeps within ${TOWN_EDGE_HEIGHT_TOL_M} m of the ground${worstLeft > 0 ? `; ${worstLeft.toFixed(2)} m left on segments under ${TOWN_EDGE_SPLIT_MIN_M} m` : ''}${dropped ? `; ${dropped} dropped and ${kept} kept whole: no split point keeps the clearance` : kept ? `; ${kept} kept whole: no split point keeps the clearance` : ''})`]
}

/** Whether `a` reaches `b` over `edges`. */
function connected(edges: readonly TownEdge[], a: string, b: string): boolean {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    ;(adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e.b)
    ;(adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e.a)
  }
  const seen = new Set([a])
  const todo = [a]
  while (todo.length) {
    const v = todo.pop()!
    if (v === b) return true
    for (const w of adj.get(v) ?? []) if (!seen.has(w)) {
      seen.add(w)
      todo.push(w)
    }
  }
  return false
}

function r2(v: number): number {
  return Math.round(v * 100) / 100
}

// ---- places --------------------------------------------------------------------------------------------------------

/** Rotates a model-space glTF vector by a placement's quaternion (x, y, z, w). */
function rotate(q: readonly number[], v: [number, number, number]): [number, number, number] {
  const [x, y, z, w] = q as [number, number, number, number]
  const [vx, vy, vz] = v
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)]
}

function baseName(source: string): string {
  return source.split(/[\\/]/).pop()!.replace(/\.(bsr|cpd)$/i, '').toLowerCase()
}

export interface PlaceContext {
  grid: TownGrid
  nav: TownNav
  /** The graph's nodes; POI nodes are appended (and listed in extraNodes, their edges in extraEdges). */
  nodes: TownNode[]
  extraNodes: TownNode[]
  extraEdges: TownEdge[]
  /** The graph's edges (chat rings keep off them); empty in fixtures that only place POIs. */
  edges?: TownEdge[]
  cfg: TownGraphConfig
  manifest: ExportManifest
  dressing: TownDressingFile | null
  /** The dressing rows (their index = their keep-out circle in nav.obstacles). */
  rows: DressingRow[]
}

/**
 * The nearest node whose straight segment to (x, z) passes the check (seats and doors: a 0.25 m clearance). When none
 * does, a POI node is added on the open ground near the place (≥ 0.8 m clear), joined to up to two graph nodes by
 * checked edges (the full 0.4 m clearance), as TOWN_LIFE §2.4's "snaps the POIs" asks.
 */
function linkNode(ctx: PlaceContext, x: number, z: number, y: number, clear = 0.25, maxD = 16, ignore = -1): TownNode | null {
  const nearest = (px: number, pz: number, r: number, k: number) => ctx.nodes
    .map((n) => ({ n, d: Math.hypot(n.x - px, n.z - pz) }))
    .filter((e) => e.d <= r)
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
  for (const { n } of nearest(x, z, maxD, 6)) if (ctx.nav.checkSegment(n.x, n.z, n.y ?? Infinity, x, z, y, clear, ignore) === null) return n
  // a POI node: the most open cells within 6 m first
  const { grid, nav } = ctx
  const cands: Array<{ x: number; z: number; y: number; c: number }> = []
  for (let dz = -6; dz <= 6; dz++) {
    for (let dx = -6; dx <= 6; dx++) {
      const k = grid.cell(x + dx, z + dz)
      if (k < 0 || grid.clear[k]! < 0.8 || Math.hypot(dx, dz) > 6) continue
      cands.push({ x: grid.cx(k % grid.w), z: grid.cz(Math.floor(k / grid.w)), y: grid.y[k]!, c: grid.clear[k]! })
    }
  }
  cands.sort((a, b) => b.c - a.c || a.x - b.x || a.z - b.z)
  for (const c of cands.slice(0, 8)) {
    if (nav.checkSegment(c.x, c.z, c.y, x, z, y, clear, ignore) !== null) continue
    const links = nearest(c.x, c.z, EDGE_MAX_M + 4, 8).filter(({ n }) => nav.checkSegment(n.x, n.z, n.y ?? Infinity, c.x, c.z, c.y) === null).slice(0, 2)
    if (!links.length) continue
    const node: TownNode = { id: `p${ctx.extraNodes.length}`, x: r2(c.x), z: r2(c.z), y: r2(c.y) }
    ctx.extraNodes.push(node)
    ctx.nodes.push(node)
    for (const { n } of links) ctx.extraEdges.push({ a: n.id, b: node.id })
    return node
  }
  return null
}

/**
 * Seats must be reachable from the node except their last `stop` m (1.2: a bench inside its own footprint; a dressing
 * prop's own keep-out circle is ignored).
 */
function seatLinked(ctx: PlaceContext, node: TownNode, s: { x: number; z: number }, ignore = -1, stop = 1.2): boolean {
  const d = Math.hypot(s.x - node.x, s.z - node.z)
  if (d < stop + 0.1) return true
  const f = (d - stop) / d
  const ex = node.x + (s.x - node.x) * f
  const ez = node.z + (s.z - node.z) * f
  return ctx.nav.checkSegment(node.x, node.z, node.y ?? Infinity, ex, ez, NaN, 0.2, ignore) === null
}

export function buildPlaces(ctx: PlaceContext): { places: TownPlace[]; report: string[] } {
  const { grid, nav, cfg, manifest } = ctx
  const report: string[] = []
  const places: TownPlace[] = []
  const nearNpc = (x: number, z: number, r = 2) => cfg.npcs.some((n) => Math.hypot(n.x - x, n.z - z) < r)
  const taken = (x: number, z: number, r: number) => places.some((p) => Math.hypot(p.x - x, p.z - z) < r)
  const district = (x: number, z: number) => {
    let best: TownDistrict | null = null
    for (const d of cfg.districts) {
      const dd = Math.hypot(d.x - x, d.z - z)
      if (dd <= d.radius && (!best || dd < Math.hypot(best.x - x, best.z - z))) best = d
    }
    return best?.id
  }
  const inBox = (x: number, z: number) => x >= cfg.box.x0 && x <= cfg.box.x1 && z >= cfg.box.z0 && z <= cfg.box.z1
  /** The walkable surface's height at (x, z) nearest `hint` in the home component (NaN when none): a seat's own ground. */
  const groundY = (x: number, z: number, hint: number) => nav.surfaceAt(x, z, hint)?.y ?? NaN
  const misses = new Map<string, number>()
  const miss = (kind: string, why: string) => misses.set(`${kind}: ${why}`, (misses.get(`${kind}: ${why}`) ?? 0) + 1)
  const add = (p: Omit<TownPlace, 'node' | 'district'>, opts: { clear?: number; seatLink?: boolean; owner?: number } = {}): boolean => {
    const node = linkNode(ctx, p.x, p.z, p.y ?? NaN, opts.clear ?? 0.25, 16, opts.owner ?? -1)
    if (!node) {
      miss(p.kind, 'no node links to it')
      return false
    }
    if (p.seats) {
      p.seats = p.seats.filter((s) => Math.hypot(s.x - p.x, s.z - p.z) <= TOWN_SEAT_MAX_DIST_M && (opts.seatLink === false || seatLinked(ctx, node, s, opts.owner ?? -1)))
      if (!p.seats.length) {
        miss(p.kind, 'no seat links to its node')
        return false
      }
    }
    const d = district(p.x, p.z)
    places.push({ ...p, node: node.id, ...(d ? { district: d } : {}) })
    return true
  }
  const r3 = (s: TownSeat): TownSeat => ({ x: r2(s.x), z: r2(s.z), ...(s.y !== undefined && Number.isFinite(s.y) ? { y: r2(s.y) } : {}), yaw: r2(s.yaw), pose: s.pose })

  // gates
  for (const gte of cfg.gates) {
    const s = grid.snap(gte.x, gte.z, 1.2, 10)
    if (!s) {
      report.push(`door ${gte.id}: no open ground near (${gte.x}, ${gte.z})`)
      continue
    }
    if (!add({ id: gte.id, kind: 'door', x: r2(s.x), z: r2(s.z), y: r2(s.y), yaw: gte.yaw })) report.push(`door ${gte.id}: no node`)
    else {
      // a guard post by each gate (the patrols stop there)
      const post = grid.snap(s.x + Math.sin(gte.yaw) * 6, s.z + Math.cos(gte.yaw) * 6, 1.2, 6)
      if (post) add({ id: `post-${gte.id.slice(5)}`, kind: 'guardPost', x: r2(post.x), z: r2(post.z), y: r2(post.y), yaw: gte.yaw })
    }
  }

  // house doors: the most open walkable cell along each house's footprint (its street front)
  const houses = new Map<number, { key: string; cells: number[] }>()
  for (let k = 0; k < grid.solid.length; k++) {
    const s = grid.solid[k]!
    if (s < 0) continue
    const key = nav.solids.key[s]!
    if (!cfg.buildingKey.test(key) || cfg.notBuildingKey.test(baseName(key))) continue
    const h = houses.get(s) ?? { key, cells: [] }
    h.cells.push(k)
    houses.set(s, h)
  }
  let doorN = 0
  for (const [, h] of [...houses].sort((a, b) => a[0] - b[0])) {
    if (h.cells.length < 20) continue
    let cx = 0
    let cz = 0
    for (const k of h.cells) {
      cx += grid.cx(k % grid.w)
      cz += grid.cz(Math.floor(k / grid.w))
    }
    cx /= h.cells.length
    cz /= h.cells.length
    const ring = new Set<number>()
    for (const k of h.cells) {
      const i = k % grid.w
      const j = Math.floor(k / grid.w)
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const ii = i + di
          const jj = j + dj
          if (ii < 0 || jj < 0 || ii >= grid.w || jj >= grid.h) continue
          const kk = jj * grid.w + ii
          if (grid.clear[kk]! >= 1.0) ring.add(kk)
        }
      }
    }
    const cands = [...ring]
      .map((k) => ({ k, x: grid.cx(k % grid.w), z: grid.cz(Math.floor(k / grid.w)), c: grid.clear[k]! }))
      .filter((c) => inBox(c.x, c.z) && !nearNpc(c.x, c.z, 3) && Math.hypot(c.x - cfg.spawn.x, c.z - cfg.spawn.z) > 8)
      .sort((a, b) => b.c - a.c || a.k - b.k)
    const want = h.cells.length > 600 ? 2 : 1
    const chosen: typeof cands = []
    for (const c of cands) {
      if (chosen.length >= want) break
      if (chosen.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 15)) continue
      if (taken(c.x, c.z, 4)) continue
      const yaw = Math.atan2(c.x - cx, c.z - cz)
      if (add({ id: `door-${doorN}`, kind: 'door', x: r2(c.x), z: r2(c.z), y: r2(grid.y[c.k]!), yaw: r2(yaw) })) {
        chosen.push(c)
        doorN++
      }
    }
  }
  report.push(`doors: ${places.filter((p) => p.kind === 'door').length} (${cfg.gates.length} gates, ${houses.size} houses)`)

  // placements of the export (+ the dressing's props)
  type Placed = { name: string; x: number; z: number; y: number; q: number[]; min: [number, number, number]; max: [number, number, number]; owner: number }
  const placed: Placed[] = []
  for (const p of manifest.placements) {
    const m = manifest.models[p.models[0] ?? -1]
    // the dressing's own placements (uids from TOWN_UID_BASE) come in below as its rows, with their keep-out circles
    if (!m || p.uid >= TOWN_UID_BASE) continue
    const [x, y, z] = p.position
    if (!inBox(x, z)) continue
    placed.push({ name: baseName(p.source), x, z, y, q: p.rotation, min: m.boundsMin, max: m.boundsMax, owner: -1 })
  }
  // the dressing's rows (placed by the export or not yet), with their keep-out circles; a row's footprint is no walkable
  // cell, so its height is the export's, else the nearest walkable cell's
  ctx.rows.forEach((r, i) => {
    const q = [0, Math.sin(r.yaw / 2), 0, Math.cos(r.yaw / 2)]
    const y = r.y ?? grid.snap(r.x, r.z, 0.3, 4)?.y ?? 0
    placed.push({ name: r.name, x: r.x, z: r.z, y, q, min: r.min, max: r.max, owner: i })
  })
  const world = (pl: Placed, lx: number, lz: number) => {
    const v = rotate(pl.q, [lx, 0, lz])
    return { x: pl.x + v[0], z: pl.z + v[2] }
  }
  const yawOf = (pl: Placed, lx: number, lz: number) => {
    const v = rotate(pl.q, [lx, 0, lz])
    return Math.atan2(v[0], v[2])
  }

  // stalls: the vendor stands on the front (a dressing stall) or the most open side, facing out; customers 1.4 m further out
  const GOODS = ['fruit', 'silk', 'buns', 'tea', 'iron', 'herbs', 'pottery', 'spice']
  let stallN = 0
  for (const pl of placed.filter((p) => /^(cj_streetstall|w_etc0[23]|w_cd_store01|thief_vill_object08_01)$/.test(p.name))) {
    // a dressing stall's side spots lie in its own keep-out circle: the customers' spot steps out of it, and on past the
    // goods the dressing sets out in front (other keep-outs) to open ground
    const outOf = (x: number, z: number, dx: number, dz: number): { x: number; z: number } => {
      if (pl.owner < 0) return { x, z }
      const ob = nav.obstacles[pl.owner]!
      let k = 0
      while (k < 4 && (Math.hypot(x + dx * k - ob.x, z + dz * k - ob.z) < ob.r + 0.2 || grid.clearAt(x + dx * k, z + dz * k) < 0.8)) k += 0.25
      return { x: x + dx * k, z: z + dz * k }
    }
    const hx = (pl.max[0] - pl.min[0]) / 2
    const hz = (pl.max[2] - pl.min[2]) / 2
    const mx = (pl.max[0] + pl.min[0]) / 2
    const mz = (pl.max[2] + pl.min[2]) / 2
    const sides: Array<[number, number, number, number]> = [[mx, mz + hz + 0.6, 0, 1], [mx, mz - hz - 0.6, 0, -1], [mx + hx + 0.6, mz, 1, 0], [mx - hx - 0.6, mz, -1, 0]]
    const opts = sides
      .map(([lx, lz, dx, dz]) => {
        const w = world(pl, lx, lz)
        const o1 = world(pl, lx + dx * 1.4, lz + dz * 1.4)
        const out = outOf(o1.x, o1.z, (o1.x - w.x) / 1.4, (o1.z - w.z) / 1.4)
        return { w, out, yaw: yawOf(pl, dx, dz), c: grid.clearAt(out.x, out.z) + grid.clearAt(w.x, w.z), front: dz > 0 ? 1 : 0 }
      })
      .filter((o) => (pl.owner >= 0 || grid.clearAt(o.w.x, o.w.z) >= 0.4) && grid.clearAt(o.out.x, o.out.z) >= 0.8)
      // a dressing stall serves from its front (local +z, where the dressing sets out its goods); a retail one from its
      // most open side
      .sort((a, b) => (pl.owner >= 0 ? b.front - a.front : 0) || b.c - a.c)
    const o = opts[0]
    if (!o) {
      miss('stall', `no open side (${pl.name} at ${pl.x.toFixed(1)}, ${pl.z.toFixed(1)})`)
      continue
    }
    if (Math.hypot(o.out.x - cfg.spawn.x, o.out.z - cfg.spawn.z) < 10 || nearNpc(o.w.x, o.w.z)) {
      miss('stall', `near the spawn or an NPC (${pl.name} at ${pl.x.toFixed(1)}, ${pl.z.toFixed(1)})`)
      continue
    }
    const cell = grid.cell(o.out.x, o.out.z)
    // a dressing stall's vendor stands at its own front, inside its keep-out circle and between its goods: the schedule
    // walks him in through the customers' spot (TOWN_LIFE §3.3), so his seat needs no link of its own to the node
    const seat: TownSeat = { x: o.w.x, z: o.w.z, y: grid.y[grid.cell(o.w.x, o.w.z)]!, yaw: o.yaw, pose: 'stand' }
    if (add({ id: `stall-${stallN}`, kind: 'stall', x: r2(o.out.x), z: r2(o.out.z), y: r2(grid.y[cell]!), yaw: r2(o.yaw + Math.PI), seats: [r3(seat)], goods: GOODS[stallN % GOODS.length] }, { owner: pl.owner, seatLink: pl.owner < 0 })) stallN++
  }

  // tea tables: two benches along the long axis, two seats each, facing the table
  let teaN = 0
  for (const pl of placed.filter((p) => /^(cj_table_chair|cj_table01)$/.test(p.name))) {
    const sx = pl.max[0] - pl.min[0]
    const sz = pl.max[2] - pl.min[2]
    const mx = (pl.max[0] + pl.min[0]) / 2
    const mz = (pl.max[2] + pl.min[2]) / 2
    const longZ = sz >= sx
    const across = (longZ ? sx : sz) / 2 - 0.3
    const along = Math.min(0.7, (longZ ? sz : sx) / 2 - 0.5)
    const seats: TownSeat[] = []
    for (const side of [-1, 1]) {
      for (const k of [-1, 1]) {
        const lx = longZ ? mx + side * across : mx + k * along
        const lz = longZ ? mz + k * along : mz + side * across
        const w = world(pl, lx, lz)
        const yaw = longZ ? yawOf(pl, -side, 0) : yawOf(pl, 0, -side)
        const y = nav.g.heightAt(w.x, w.z, pl.y + 1) ?? pl.y
        seats.push({ x: w.x, z: w.z, y, yaw, pose: 'chair' })
      }
    }
    const front = grid.snap(pl.x, pl.z, 0.8, 5)
    if (!front) {
      miss('teaTable', 'no open ground within 5 m')
      continue
    }
    if (add({ id: `tea-${teaN}`, kind: 'teaTable', x: r2(front.x), z: r2(front.z), y: r2(front.y), yaw: 0, seats: seats.map(r3), sheltered: false })) teaN++
  }

  // the dressing's benches (TL-B): two seats on the bench, facing its more open side
  let dbN = 0
  for (const pl of placed.filter((p) => p.owner >= 0 && p.name === 'bench')) {
    const sides = [1, -1]
      .map((side) => ({ side, f: world(pl, 0, side * 2.2) }))
      .sort((a, b) => grid.clearAt(b.f.x, b.f.z) - grid.clearAt(a.f.x, a.f.z))
    const { side, f } = sides[0]!
    const k = grid.cell(f.x, f.z)
    if (k < 0 || grid.clear[k]! < 0.5) {
      miss('bench', 'no open ground in front of a dressing bench')
      continue
    }
    const yaw = yawOf(pl, 0, side)
    const seats: TownSeat[] = [-0.45, 0.45].map((lx) => {
      const w = world(pl, lx, 0)
      return { x: w.x, z: w.z, y: pl.y, yaw, pose: 'chair' }
    })
    if (add({ id: `bench-${dbN}`, kind: 'bench', x: r2(f.x), z: r2(f.z), y: r2(grid.y[k]!), yaw: r2(yaw), seats: seats.map(r3) }, { owner: pl.owner })) dbN++
  }

  // statue plinths (c_sta_01): one floor seat at the plinth's street side, facing out
  let benchN = 0
  for (const pl of placed.filter((p) => p.name === 'c_sta_01')) {
    const s = grid.snap(pl.x, pl.z, 0.6, 3)
    if (!s || taken(s.x, s.z, 2)) continue
    const yaw = Math.atan2(s.x - pl.x, s.z - pl.z)
    const seat: TownSeat = { x: pl.x + Math.sin(yaw) * Math.max(0.3, Math.hypot(s.x - pl.x, s.z - pl.z) - 0.4), z: pl.z + Math.cos(yaw) * Math.max(0.3, Math.hypot(s.x - pl.x, s.z - pl.z) - 0.4), y: s.y, yaw, pose: 'floor' }
    if (add({ id: `plinth-${benchN}`, kind: 'bench', x: r2(s.x), z: r2(s.z), y: r2(s.y), yaw: r2(yaw), seats: [r3(seat)] })) benchN++
  }

  // a ring of floor seats round a basin (the fountain rim, the pond edge): the first walkable cell outward
  const ringSeats = (c: { x: number; z: number; maxR: number }, n: number, facing: 'out' | 'in'): TownSeat[] => {
    const seats: TownSeat[] = []
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2
      for (let r = 2; r <= c.maxR; r += 0.25) {
        const x = c.x + Math.sin(a) * r
        const z = c.z + Math.cos(a) * r
        if (grid.clearAt(x, z) >= 0.6) {
          const yaw = facing === 'out' ? a : a + Math.PI
          // the seat's own ground (the cell's height is its centre's, up to 0.7 m away on a sloping bank)
          const cy = grid.y[grid.cell(x, z)]!
          const y = groundY(x, z, cy)
          seats.push({ x, z, y: Number.isFinite(y) ? y : cy, yaw, pose: facing === 'out' ? 'floor' : 'stand' })
          break
        }
      }
    }
    return seats
  }
  if (cfg.fountain) {
    const seats = ringSeats(cfg.fountain, 16, 'out').filter((s) => !nearNpc(s.x, s.z, 2.5))
    // one place per quarter of the rim (each with its seats; a place's seats stay within 8 m of it)
    for (let q = 0; q < 4; q++) {
      const mine = seats.filter((_, i) => Math.floor((i / 16) * 4) === q)
      if (!mine.length) continue
      const mx = mine.reduce((a, s) => a + s.x, 0) / mine.length
      const mz = mine.reduce((a, s) => a + s.z, 0) / mine.length
      const s = grid.snap(mx, mz, 0.8, 4)
      if (s) add({ id: `fountain-${q}`, kind: 'fountainRim', x: r2(s.x), z: r2(s.z), y: r2(s.y), yaw: 0, seats: mine.map(r3) })
    }
  }
  if (cfg.pond) {
    const seats = ringSeats(cfg.pond, 12, 'in')
    for (let q = 0; q < 3; q++) {
      const mine = seats.filter((_, i) => Math.floor((i / 12) * 3) === q)
      if (!mine.length) continue
      const mx = mine.reduce((a, s) => a + s.x, 0) / mine.length
      const mz = mine.reduce((a, s) => a + s.z, 0) / mine.length
      const s = grid.snap(mx, mz, 0.8, 5)
      if (s) add({ id: `pond-${q}`, kind: 'pondEdge', x: r2(s.x), z: r2(s.z), y: r2(s.y), yaw: 0, seats: mine.map(r3) })
    }
  }

  // the smith's anvil (the apprentice hammers 2.5–4 m from the smith) and the stable yard
  if (cfg.smith) {
    const s = grid.snap(cfg.smith.x, cfg.smith.z, 0.8, 6, (x, z) => Math.hypot(x - cfg.smith!.x, z - cfg.smith!.z) < 2.5)
    if (s) {
      const yaw = Math.atan2(cfg.smith.x - s.x, cfg.smith.z - s.z)
      add({ id: 'anvil', kind: 'smithAnvil', x: r2(s.x), z: r2(s.z), y: r2(s.y), yaw: r2(yaw), seats: [r3({ x: s.x, z: s.z, y: s.y, yaw, pose: 'stand' })] })
    }
  }
  if (cfg.stable) {
    const s = grid.snap(cfg.stable.x - 4, cfg.stable.z, 1.2, 8, (x, z) => nearNpc(x, z, 3))
    if (s) add({ id: 'stable', kind: 'stable', x: r2(s.x), z: r2(s.z), y: r2(s.y), yaw: 0 })
  }

  // chat rings in the open squares: 4 standing spots on a 0.9 m circle, facing the centre
  const open: number[] = []
  for (let k = 0; k < grid.clear.length; k++) if (grid.clear[k]! >= cfg.chat.clear) open.push(k)
  open.sort((a, b) => grid.clear[b]! - grid.clear[a]! || a - b)
  let chatN = 0
  // a ring stands beside the walkers' lines, never on one (its 0.9 m circle of talkers + a passer-by's shoulder)
  const byId = new Map(ctx.nodes.map((n) => [n.id, n]))
  const lines = (ctx.edges ?? []).map((e) => [byId.get(e.a), byId.get(e.b)] as const).filter((l): l is readonly [TownNode, TownNode] => !!l[0] && !!l[1])
  const onLine = (x: number, z: number) => lines.some(([a, b]) => segDist(x, z, a.x, a.z, b.x, b.z) < CHAT_LINE_CLEAR_M)
  const ring = (k: number, within: TownDistrict | null): boolean => {
    const x = grid.cx(k % grid.w)
    const z = grid.cz(Math.floor(k / grid.w))
    if (within && Math.hypot(x - within.x, z - within.z) > within.radius) return false
    if (onLine(x, z)) return false
    if (!inBox(x, z) || Math.hypot(x - cfg.spawn.x, z - cfg.spawn.z) < 12 || nearNpc(x, z, 5)) return false
    if (places.some((p) => p.kind === 'chatSpot' && Math.hypot(p.x - x, p.z - z) < cfg.chat.spacing) || taken(x, z, 5)) return false
    const a0 = ((k * 2654435761) % 360) * (Math.PI / 180)
    const seats: TownSeat[] = []
    for (let s = 0; s < 4; s++) {
      const a = a0 + (s / 4) * Math.PI * 2
      const sx = x + Math.sin(a) * 0.9
      const sz = z + Math.cos(a) * 0.9
      // each talker on its own ground; a ring straddling a step or a kerb is no place for a chat
      const sy = groundY(sx, sz, grid.y[k]!)
      if (!(Math.abs(sy - grid.y[k]!) <= CHAT_RING_DY_M)) return false
      seats.push({ x: sx, z: sz, y: sy, yaw: a + Math.PI, pose: 'stand' })
    }
    if (!add({ id: `chat-${chatN}`, kind: 'chatSpot', x: r2(x), z: r2(z), y: r2(grid.y[k]!), yaw: 0, seats: seats.map(r3) }, { seatLink: false })) return false
    chatN++
    return true
  }
  for (const [id, want] of Object.entries(cfg.chat.districts ?? {})) {
    const d = cfg.districts.find((q) => q.id === id)
    if (!d) continue
    let got = 0
    for (const k of open) {
      if (got >= want || chatN >= cfg.chat.count) break
      if (ring(k, d)) got++
    }
    if (got < want) report.push(`chat rings: ${got} of ${want} in ${id}`)
  }
  for (const k of open) {
    if (chatN >= cfg.chat.count) break
    ring(k, null)
  }
  for (const [k, n] of misses) report.push(`place skipped (${n}x): ${k}`)
  const count = (k: TownPlaceKind) => places.filter((p) => p.kind === k).length
  report.push(`places: ${places.length} (stalls ${count('stall')}, tea tables ${count('teaTable')}, benches ${count('bench')}, fountain ${count('fountainRim')}, pond ${count('pondEdge')}, chat rings ${count('chatSpot')}, posts ${count('guardPost')})`)
  return { places, report }
}

// ---- folk ----------------------------------------------------------------------------------------------------------

/** Snaps waypoints to nodes and joins them by graph paths into a closed loop of adjacent nodes. */
export function routeNodes(nodes: TownNode[], edges: TownEdge[], points: ReadonlyArray<[number, number]>): string[] | null {
  const idx = new Map(nodes.map((n, i) => [n.id, i]))
  const adj: number[][] = nodes.map(() => [])
  for (const e of edges) {
    const a = idx.get(e.a)!
    const b = idx.get(e.b)!
    adj[a]!.push(b)
    adj[b]!.push(a)
  }
  const nearest = (x: number, z: number) => {
    let best = 0
    let bd = Infinity
    nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.z - z)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    return best
  }
  const path = (a: number, b: number): number[] | null => {
    const dist = new Float64Array(nodes.length).fill(Infinity)
    const prev = new Int32Array(nodes.length).fill(-1)
    const done = new Uint8Array(nodes.length)
    dist[a] = 0
    for (;;) {
      let u = -1
      let du = Infinity
      for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i]! < du) {
        du = dist[i]!
        u = i
      }
      if (u < 0 || u === b) break
      done[u] = 1
      for (const v of adj[u]!) {
        const d = du + Math.hypot(nodes[u]!.x - nodes[v]!.x, nodes[u]!.z - nodes[v]!.z)
        if (d < dist[v]!) {
          dist[v] = d
          prev[v] = u
        }
      }
    }
    if (!Number.isFinite(dist[b]!)) return null
    const out: number[] = []
    for (let v = b; v !== -1; v = prev[v]!) out.push(v)
    return out.reverse()
  }
  const way = points.map(([x, z]) => nearest(x, z))
  const loop: number[] = []
  for (let i = 0; i < way.length; i++) {
    const p = path(way[i]!, way[(i + 1) % way.length]!)
    if (!p) return null
    loop.push(...p.slice(0, -1))
  }
  const out = loop.filter((v, i) => v !== loop[(i + 1) % loop.length] || loop.length === 1)
  return out.length >= 2 ? out.map((i) => nodes[i]!.id) : null
}

/** The authored defaults (kept from an existing file when present). */
export const JANGAN_SCHEDULE: TownSchedule = {
  bands: [
    { from: 5, to: 7, share: 0.25 },
    { from: 7, to: 18, share: 1 },
    { from: 18, to: 20, share: 0.6 },
    { from: 20, to: 23, share: 0.25 },
    { from: 23, to: 5, share: 0.08 },
  ],
  rainShelter: 0.25,
}

export const JANGAN_FOLK_SHARES = {
  population: 240,
  female: 0.45,
  roles: { walker: 40, chatter: 20, sitter: 15, vendor: 8, porter: 5, child: 4 },
}

export const JANGAN_LINES: TownLines = {
  calls: {
    fruit: ['Fresh peaches! Sweet as honey!', 'Pears from the river farms, crisp and cold!', 'Jujubes, dried jujubes, good for the blood!', 'Melons! Cut fresh, a copper a slice!', 'Persimmons, ripe today, gone tomorrow!', 'Apricots from the west road!', 'Plums, black and sweet! Come and taste!', 'Grapes from Dunhuang, carried by camel!'],
    silk: ['Silk from Dunhuang, finest weave!', 'Feel this, traveller: softer than a cloud!', 'Red silk for weddings, blue for scholars!', 'Bolts of silk, cut to your length!', 'Embroidered sashes, every one by hand!', 'Silk that crossed the desert twice!', 'A scarf for your sweetheart?', 'Brocade fit for the palace!'],
    buns: ['Hot buns, still steaming!', 'Meat buns! Pork and leek!', 'Sweet bean buns, two for a copper!', 'Dumplings, fresh from the pot!', 'Sesame cakes, warm and crisp!', 'Noodles! Pulled while you wait!', 'Buns for the road, traveller?', 'Steamed rolls, soft as a pillow!'],
    tea: ['Tea! Rest your feet, traveller.', 'Green tea from the southern hills!', 'Pu-erh, aged ten summers!', 'A cup of jasmine for the dust of the road!', 'Hot tea, cold days, good company!', 'Sit, sit, the kettle is singing!', 'Chrysanthemum tea, cools the blood!', 'Oolong, rolled by hand!'],
    iron: ['Good iron, fair price!', 'Knives that keep their edge!', 'Horseshoes, nails, hinges, all here!', 'Pots and pans, beaten not cast!', 'A blade for the bandit road?', 'Iron from the northern mines!', 'Sharpening, a copper a blade!', 'Hoes and sickles for the harvest!'],
    herbs: ['Herbs for every ailment!', 'Ginseng, real mountain ginseng!', 'Licorice root, sweet for the throat!', 'Wolfberries, for the eyes and the heart!', 'A salve for blisters, traveller?', 'Ginger for the cold, mint for the heat!', 'Dried mushrooms from the tiger slopes!', 'Remedies, tonics, poultices!'],
    pottery: ['Bowls and jars, fired this week!', 'Glazed cups, blue as the sky!', 'Water jars that never leak!', 'Teapots from the kilns of the east!', 'A vase for your table?', 'Pots, plates, pitchers, all sizes!', 'Celadon, the colour of jade!', 'Clay for the kitchen, glaze for the guest!'],
    spice: ['Pepper from the far south!', 'Cumin and anise, smell that!', 'Salt, white as snow!', 'Chili, red and fierce!', 'Cinnamon bark, sweet and warm!', 'Spices from beyond the desert!', 'Star anise, a pinch makes the pot!', 'Saffron, worth its weight in silver!'],
  },
  flavour: {
    walker: ['Fine day for it.', 'Mind the carts, friend.', 'The market is busy today.', 'Have you eaten yet?', 'Off to see my cousin by the east gate.', 'Jangan never sleeps, they say.'],
    chatter: ['And then he said the price had doubled!', 'My son joined the army last spring.', 'Did you hear the bell this morning?', 'The tea house has a new singer.', 'Rain by evening, mark my words.'],
    sitter: ['Ah, my old legs thank this bench.', 'Sit a while, the day is long.', 'I have watched this square for forty years.', 'The fountain sounds like home.'],
    porter: ['Make way! Heavy load!', 'One more trip and I can rest.', 'Careful, this crate is from Dunhuang.', 'The horse knows the way better than I do.'],
    child: ['Catch me if you can!', 'Are you a real hunter?', 'I saw a tiger once! A small one.', 'Mother says not to talk to strangers.'],
    guard: ['Move along, citizen.', 'All quiet on the avenue.', 'Keep your weapon sheathed inside the walls.', 'Report anything strange to the gate.'],
    vendor: ['Best prices in Jangan!', 'For you, a special price.', 'Come back tomorrow, more goods arrive.'],
    worker: ['Hot iron waits for no one.', 'Mind the sparks!', 'The master wants these done by dusk.'],
    lanternCarrier: ['Lights for the evening!', 'Dusk comes early today.', 'One lantern at a time.'],
    rider: ['Clear the road!', 'Message for the palace!'],
  },
  rumours: [
    { act: 1, text: 'They say the Seal is gone from the temple.' },
    { act: 1, text: 'Ghosts in the southern grass, my neighbour swears it.' },
    { act: 2, text: 'Lanterns drowned in the swamp, and still they glow.' },
    { act: 2, text: 'The old tombs are restless. Nobody goes near them now.' },
    { act: 3, text: 'Bandits on the road again. The silk carts go with guards.' },
    { act: 3, text: 'Tigers on the south slopes again, bold as you like.' },
    { act: 4, text: 'A woman rides a blue tiger in the hills, they say.' },
    { act: 4, text: 'The smith is casting a bell. A bell! For a tiger!' },
  ],
}

/** The whole town file from the graph and places, with the authored parts (kept from `prev` when it has them). */
export function assembleTownFile(cfg: TownGraphConfig, g: BuiltGraph, places: TownPlace[], prev: TownFile | null): { file: TownFile; report: string[] } {
  const report: string[] = []
  const fixed: TownFixedAgent[] = []
  for (const p of places) {
    if (p.kind === 'stall') fixed.push({ role: 'vendor', place: p.id, seat: 0 })
    if (p.kind === 'smithAnvil') fixed.push({ role: 'worker', place: p.id, seat: 0, hours: [6, 20], clip: 'HAMMER' })
  }
  // two elders at the west tea tables (the first seat of the first two tables)
  places.filter((p) => p.kind === 'teaTable').slice(0, 2).forEach((p) => fixed.push({ role: 'sitter', place: p.id, seat: 0 }))
  const routes: TownRoute[] = []
  for (const r of cfg.routes) {
    const nodes = routeNodes(g.nodes, g.edges, r.points)
    if (!nodes) {
      report.push(`route ${r.id}: its waypoints are not connected`)
      continue
    }
    routes.push({ id: r.id, role: r.role, nodes, count: r.count, ...(r.hours ? { hours: r.hours } : {}), ...(r.pairs ? { pairs: true } : {}) })
  }
  const file: TownFile = {
    schema: TOWN_FILE_SCHEMA,
    kind: 'town',
    world: cfg.world,
    town: cfg.town,
    seed: prev?.seed ?? cfg.seed,
    graph: { nodes: g.nodes, edges: g.edges },
    places,
    folk: {
      population: prev?.folk.population ?? JANGAN_FOLK_SHARES.population,
      female: prev?.folk.female ?? JANGAN_FOLK_SHARES.female,
      roles: prev?.folk.roles ?? JANGAN_FOLK_SHARES.roles,
      districts: cfg.districts,
      fixed,
      routes,
    },
    schedule: prev?.schedule ?? JANGAN_SCHEDULE,
    lines: prev?.lines ?? JANGAN_LINES,
    // wave 12 (WE-T): the editor's hand edits, kept like the other authored parts (buildTownFile applies them)
    ...(prev?.manual && !townManualEmpty(prev.manual) ? { manual: prev.manual } : {}),
  }
  report.push(`folk: ${fixed.length} fixed, ${routes.length} routes`)
  return { file, report }
}

/** Builds the whole town file from an export (the CLI's work; the tests call it on the real export). */
export function buildTownFile(worldDir: string, cfg: TownGraphConfig, prev: TownFile | null, dressing: TownDressingFile | null, npcs: Array<{ x: number; z: number }>): { file: TownFile; report: string[]; nav: TownNav; grid: TownGrid } {
  const { nav, manifest } = loadTownNav(worldDir, cfg)
  if (nav.home < 0) throw new Error('town-graph: the home point is not on the navmesh')
  const c = { ...cfg, npcs: [...cfg.npcs, ...npcs] }
  // TL-B's dressing: its props are keep-outs for the graph (TL-B's own check keeps 0.3 m between a prop and an edge)
  const rows = dressingRows(dressing, manifest)
  nav.obstacles = rows.map(rowObstacle)
  const grid = new TownGrid(nav, c.box)
  const g = buildNodesAndEdges(grid, nav)
  const ctx: PlaceContext = { grid, nav, nodes: [...g.nodes], extraNodes: [], extraEdges: [], edges: g.edges, cfg: c, manifest, dressing, rows }
  const { places, report: pr } = buildPlaces(ctx)
  g.nodes.push(...ctx.extraNodes)
  g.edges.push(...ctx.extraEdges)
  pr.push(`POI nodes: ${ctx.extraNodes.length} added with ${ctx.extraEdges.length} edges; dressing keep-outs: ${rows.length}`)
  pr.push(...splitSlopeEdges(nav, g))
  const { file, report: fr } = assembleTownFile(c, g, places, prev)
  // wave 12 (WE-T, WORLD_EDITOR §4.11): the editor's overlay on the regenerated graph, every edge it adds or moves
  // checked on this navmesh by the editor's own rule (an edge that fails stays in the overlay, unapplied)
  const mr = applyTownManual(file, file.manual, { check: (a, b) => checkTownEdge(nav, a, b) })
  return { file, report: [...g.report, ...pr, ...fr, ...mr], nav, grid }
}

/** The retail NPC positions of the export's npcs.json in the town's world. */
export function exportNpcs(outDir: string): Array<{ x: number; z: number }> {
  const f = join(outDir, 'data', 'npcs.json')
  if (!existsSync(f)) return []
  const j = JSON.parse(readFileSync(f, 'utf8')) as { entries?: Array<{ x?: number; z?: number }> } | Array<{ x?: number; z?: number }>
  const list = Array.isArray(j) ? j : (j.entries ?? [])
  return list.filter((e) => typeof e.x === 'number' && typeof e.z === 'number').map((e) => ({ x: e.x!, z: e.z! }))
}

/** The file as reviewable JSON: pretty, with one graph node, edge or seat per line (the content budget is 200 KB). */
export function townFileText(file: TownFile): string {
  const json = JSON.stringify(file, null, 1)
  // collapse objects that hold only scalars onto one line
  const flat = json.replace(/\{\n(\s*"[^"\n]+": (?:-?[\d.e+-]+|"[^"\n]*"|true|false),?\n)+\s*\}/g, (m) => m.replace(/\n\s*/g, ' ').replace('{ ', '{').replace(' }', '}'))
  return `${flat}\n`
}

// ---- CLI -----------------------------------------------------------------------------------------------------------

export async function townGraphCli(args: readonly string[], cfg: SroConfig): Promise<number> {
  if (args.includes('--help')) {
    console.log(TOWN_GRAPH_USAGE)
    return 0
  }
  const opt = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const world = opt('--world') ?? JANGAN_GRAPH.world
  const outRel = opt('--out') ?? 'content/town/jangan.json'
  const out = isAbsolute(outRel) ? outRel : resolve(REPO_ROOT, outRel)
  const worldDir = join(cfg.workDir, 'out', 'world', world)
  if (!existsSync(join(worldDir, 'manifest.json'))) {
    console.error(`town-graph: no export at ${worldDir} (run pnpm sro convert first)`)
    return 1
  }
  let prev: TownFile | null = null
  if (existsSync(out)) {
    const r = validateTownFile(JSON.parse(readFileSync(out, 'utf8')))
    if (r.ok && r.file.kind === 'town') prev = r.file
    else console.warn(`town-graph: ${outRel} is not a valid town file; its authored parts are not kept`)
  }
  const dressingPath = resolve(REPO_ROOT, 'content/town/jangan-dressing.json')
  let dressing: TownDressingFile | null = null
  if (existsSync(dressingPath)) {
    const r = validateTownFile(JSON.parse(readFileSync(dressingPath, 'utf8')))
    if (r.ok && r.file.kind === 'townDressing') dressing = r.file
  }
  const t0 = performance.now()
  const { file, report } = buildTownFile(worldDir, { ...JANGAN_GRAPH, world }, prev, dressing, exportNpcs(join(cfg.workDir, 'out')).filter((n) => n.x > -200 && n.x < 400 && n.z > -400 && n.z < 20))
  for (const line of report) console.log(`town-graph: ${line}`)
  const v = validateTownFile(file)
  if (!v.ok) {
    console.error(`town-graph: the built file does not validate: ${v.problems.slice(0, 5).join('; ')}`)
    return 1
  }
  const text = townFileText(file)
  console.log(`town-graph: ${(text.length / 1024).toFixed(0)} KB in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const debug = opt('--debug')
  if (debug) writeFileSync(debug, text)
  if (args.includes('--dry-run')) return 0
  writeFileSync(out, text)
  console.log(`town-graph: wrote ${outRel}`)
  return 0
}

/** Distance from (x, z) to the segment (ax, az)-(bx, bz) (m). */
function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz))
}
