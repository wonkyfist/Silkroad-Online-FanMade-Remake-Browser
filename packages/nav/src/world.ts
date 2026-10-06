/**
 * NavWorld: ground height and straight-line movement over terrain + object navmeshes (docs/NAVIGATION.md §5, §6).
 *
 * All coordinates are world FILE space (data.ts): x east, z north, y up, 1 unit = 1 dm. Rules implemented:
 * - A position carries its surface (terrain, or one triangle cell of one object instance); its height is always
 *   read from that surface (§5.1). locate() (nearest height, terrain wins ties) is only for positions without one:
 *   spawn, teleport, corrections (§5.2).
 * - A move is one straight chord toward the destination that stops at the first blocking contact, with no slide
 *   and no path-finding (§6.1). Surfaces change only at edges: terrain -> object across an outline edge entered from
 *   outside whose flag lets you in; object -> terrain across an open (flag 0) outline edge; object -> object across
 *   a linked global edge. Each change starts a new leg toward the original destination, at most 6 legs; a leg that
 *   ends within 5 units of the destination ends the move (§6.1).
 * - Terrain walker (§6.2): stops before closed tiles (no corner squeezing) and at object outline edges crossed from
 *   outside with flag & 1 (or unlinked flag & 8); flag & 16 is passed underneath; no height test.
 * - Object walker (§6.3): walks triangle to triangle; inline edges block by their side bits, outline edges block
 *   unless flag == 0 (exit) or linked. Other objects and the terrain are not consulted while on an object.
 * - Contacts (§9.3): a stop backs off min(0.2, travelled) toward the current cell's centroid (terrain: along the
 *   chord; closed tiles: 0.01); an entry starts 0.2 into the entered cell; an exit starts 0.2 outside the edge.
 * - No step or slope limits (§5.4).
 * - Reachability (§11, reach.ts): walkable components over the same transitions, built on first use.
 *
 * Deterministic (float64, fixed iteration orders) and allocation-light: only the result objects are allocated.
 */
import { NVM_REGION_SIZE, NVM_TILES, NVM_TILE_SIZE, nvmHeightAt } from '@sro/formats'
import type { NavData, NavInstance, NavModel, NavRegion } from './data.ts'
import { editNavInstances, type NavInstanceEdits } from './instances.ts'
import { NavReach, type NavComponent, type NavReachStats } from './reach.ts'

export type { NavComponent, NavReachStats } from './reach.ts'

/** Stop back-off from a blocking object edge, and the entry/exit nudge (file units, §6.1). */
export const NAV_CONTACT_BACKOFF = 0.2
/** Back-off from a closed terrain tile (§6.1, OS). */
export const NAV_TILE_BACKOFF = 0.01
/** A leg ending closer than this to the destination ends the move (§6.1). */
export const NAV_ARRIVE_RADIUS = 5
/** Native leg limit per move (§6.1). */
export const NAV_MAX_LEGS = 6
/** Broad-phase bucket edge for object instances (file units). */
const BUCKET = 160
const BUCKET_STRIDE = 8192
/** Side test tolerance for point-in-cell (file units). */
const IN_CELL_EPS = 1e-3
/** Outline hit tolerance along an edge (fraction), so chords through a shared vertex hit one of the two edges. */
const EDGE_U_EPS = 1e-9

export type NavSurface =
  | { readonly kind: 'terrain' }
  | { readonly kind: 'object'; readonly instance: number; readonly cell: number }

export const TERRAIN_SURFACE: NavSurface = Object.freeze({ kind: 'terrain' })

export interface NavPosition {
  x: number
  y: number
  z: number
  surface: NavSurface
}

export interface NavHit {
  /** tile: closed terrain tile; world: no terrain loaded; edge: object edge; legs: leg limit; stuck: walk guard. */
  kind: 'tile' | 'world' | 'edge' | 'legs' | 'stuck'
  /** Contact point (world file space). */
  x: number
  z: number
  /** For 'edge': instance index, edge index (outline or inline list of the model) and its flag. */
  instance?: number
  edge?: number
  outline?: boolean
  flag?: number
}

/**
 * One straight piece of the walk on one surface: a terrain stretch or one object cell (so its plane gives the height
 * all along it). The 0.2-unit entry/exit nudges between surfaces are the only gaps between consecutive pieces.
 */
export interface NavLeg {
  x0: number
  z0: number
  x1: number
  z1: number
  surface: NavSurface
}

export interface NavMoveResult {
  end: NavPosition
  /** true when a blocker (or the leg limit) clipped the walk short of the destination. */
  blocked: boolean
  hit: NavHit | null
  /** Walked length in XZ (sum of the legs). */
  distance: number
  legs: NavLeg[]
}

export interface NavDebugEdge {
  ax: number; ay: number; az: number
  bx: number; by: number; bz: number
  flag: number
  outline: boolean
  instance: number
}

/** Object navmesh prepared for walking: planes, centroids, side normals and adjacency, point grid. */
class RtModel {
  readonly n: number
  readonly vx: Float64Array
  readonly vy: Float64Array
  readonly vz: Float64Array
  readonly tri: Uint32Array
  /** y = a x + b z + c per cell. */
  readonly plane: Float64Array
  readonly cx: Float64Array
  readonly cz: Float64Array
  /** Per side (3 per cell, side k = tri[k] -> tri[k + 1]): unit outward normal, and nd = n . A. */
  readonly snx: Float64Array
  readonly snz: Float64Array
  readonly snd: Float64Array
  /** >= 0 neighbour cell (inline edge), -1 outline edge, -2 no edge record (treated as a wall). */
  readonly across: Int32Array
  readonly sideEdge: Int32Array
  readonly sideFlag: Uint8Array
  /** Inline sides: blocked when leaving this cell through it. */
  readonly sideBlocked: Uint8Array
  /** Outline edges: endpoints, unit inward normal (towards the src cell), src cell, flag. */
  readonly oax: Float64Array
  readonly oaz: Float64Array
  readonly obx: Float64Array
  readonly obz: Float64Array
  readonly onx: Float64Array
  readonly onz: Float64Array
  readonly ocell: Int32Array
  readonly oflag: Uint8Array
  readonly oside: Int32Array
  minX = Infinity
  minZ = Infinity
  maxX = -Infinity
  maxZ = -Infinity
  minY = Infinity
  maxY = -Infinity
  readonly gx0: number
  readonly gz0: number
  readonly gs: number
  readonly gw: number
  readonly gh: number
  readonly gStart: Int32Array
  readonly gList: Int32Array

  constructor(readonly src: NavModel) {
    const nv = src.vertices.length / 3
    const n = (this.n = src.cells.length / 3)
    this.vx = new Float64Array(nv)
    this.vy = new Float64Array(nv)
    this.vz = new Float64Array(nv)
    for (let i = 0; i < nv; i++) {
      const x = (this.vx[i] = src.vertices[i * 3]!)
      const y = (this.vy[i] = src.vertices[i * 3 + 1]!)
      const z = (this.vz[i] = src.vertices[i * 3 + 2]!)
      if (x < this.minX) this.minX = x
      if (x > this.maxX) this.maxX = x
      if (z < this.minZ) this.minZ = z
      if (z > this.maxZ) this.maxZ = z
      if (y < this.minY) this.minY = y
      if (y > this.maxY) this.maxY = y
    }
    this.tri = Uint32Array.from(src.cells)
    for (let i = 0; i < this.tri.length; i++) {
      if (this.tri[i]! >= nv) throw new Error(`nav model ${src.key}: cell vertex out of range`)
    }
    this.plane = new Float64Array(n * 3)
    this.cx = new Float64Array(n)
    this.cz = new Float64Array(n)
    this.snx = new Float64Array(n * 3)
    this.snz = new Float64Array(n * 3)
    this.snd = new Float64Array(n * 3)
    this.across = new Int32Array(n * 3).fill(-2)
    this.sideEdge = new Int32Array(n * 3).fill(-1)
    this.sideFlag = new Uint8Array(n * 3).fill(3)
    this.sideBlocked = new Uint8Array(n * 3)
    const { vx, vy, vz, tri } = this
    for (let c = 0; c < n; c++) {
      const a = tri[c * 3]!, b = tri[c * 3 + 1]!, d = tri[c * 3 + 2]!
      this.cx[c] = (vx[a]! + vx[b]! + vx[d]!) / 3
      this.cz[c] = (vz[a]! + vz[b]! + vz[d]!) / 3
      // Plane through the three vertices, solved for y(x, z).
      const e1x = vx[b]! - vx[a]!, e1y = vy[b]! - vy[a]!, e1z = vz[b]! - vz[a]!
      const e2x = vx[d]! - vx[a]!, e2y = vy[d]! - vy[a]!, e2z = vz[d]! - vz[a]!
      const det = e1x * e2z - e2x * e1z
      if (Math.abs(det) > 1e-9) {
        const pa = (e1y * e2z - e2y * e1z) / det
        const pb = (e1x * e2y - e2x * e1y) / det
        this.plane[c * 3] = pa
        this.plane[c * 3 + 1] = pb
        this.plane[c * 3 + 2] = vy[a]! - pa * vx[a]! - pb * vz[a]!
      } else {
        this.plane[c * 3 + 2] = (vy[a]! + vy[b]! + vy[d]!) / 3
      }
      for (let k = 0; k < 3; k++) {
        const i = tri[c * 3 + k]!, j = tri[c * 3 + ((k + 1) % 3)]!, o = tri[c * 3 + ((k + 2) % 3)]!
        let nx = vz[j]! - vz[i]!
        let nz = -(vx[j]! - vx[i]!)
        const len = Math.hypot(nx, nz)
        if (len > 1e-12) {
          nx /= len
          nz /= len
          if (nx * (vx[o]! - vx[i]!) + nz * (vz[o]! - vz[i]!) > 0) {
            nx = -nx
            nz = -nz
          }
        } else {
          nx = nz = 0
        }
        this.snx[c * 3 + k] = nx
        this.snz[c * 3 + k] = nz
        this.snd[c * 3 + k] = nx * vx[i]! + nz * vz[i]!
      }
    }

    // Side -> edge record, by vertex pair.
    const sideOf = new Map<number, number>()
    for (let s = 0; s < n * 3; s++) {
      const i = tri[s]!, j = tri[s - (s % 3) + ((s % 3) + 1) % 3]!
      const key = i < j ? i * 65536 + j : j * 65536 + i
      const prev = sideOf.get(key)
      if (prev === undefined) sideOf.set(key, s)
      else if (prev >= 0) sideOf.set(key, -1 - prev - s * (n * 3)) // two sides share the pair (inline); decoded below
    }
    const sidesFor = (va: number, vb: number): number[] => {
      const key = va < vb ? va * 65536 + vb : vb * 65536 + va
      const v = sideOf.get(key)
      if (v === undefined) return []
      if (v >= 0) return [v]
      const packed = -1 - v
      const s2 = Math.floor(packed / (n * 3))
      return [packed - s2 * (n * 3), s2]
    }
    const oe = src.outline
    const no = oe.flags.length
    this.oax = new Float64Array(no)
    this.oaz = new Float64Array(no)
    this.obx = new Float64Array(no)
    this.obz = new Float64Array(no)
    this.onx = new Float64Array(no)
    this.onz = new Float64Array(no)
    this.ocell = new Int32Array(no)
    this.oflag = new Uint8Array(no)
    this.oside = new Int32Array(no).fill(-1)
    for (let e = 0; e < no; e++) {
      const a = oe.vertices[e * 2]!, b = oe.vertices[e * 2 + 1]!
      const cell = oe.cells[e * 2]!
      const flag = oe.flags[e]!
      this.oax[e] = vx[a] ?? 0
      this.oaz[e] = vz[a] ?? 0
      this.obx[e] = vx[b] ?? 0
      this.obz[e] = vz[b] ?? 0
      this.ocell[e] = cell < n ? cell : -1
      this.oflag[e] = flag
      let nx = this.obz[e]! - this.oaz[e]!
      let nz = -(this.obx[e]! - this.oax[e]!)
      const len = Math.hypot(nx, nz) || 1
      nx /= len
      nz /= len
      if (cell < n && nx * (this.cx[cell]! - this.oax[e]!) + nz * (this.cz[cell]! - this.oaz[e]!) < 0) {
        nx = -nx
        nz = -nz
      }
      this.onx[e] = nx
      this.onz[e] = nz
      if (a >= nv || b >= nv) continue
      for (const s of sidesFor(a, b)) {
        if (Math.floor(s / 3) !== cell) continue
        this.across[s] = -1
        this.sideEdge[s] = e
        this.sideFlag[s] = flag
        this.oside[e] = s
      }
    }
    const ie = src.inline
    for (let e = 0; e < ie.flags.length; e++) {
      const a = ie.vertices[e * 2]!, b = ie.vertices[e * 2 + 1]!
      const c0 = ie.cells[e * 2]!, c1 = ie.cells[e * 2 + 1]!
      const flag = ie.flags[e]!
      if (a >= nv || b >= nv) continue
      for (const s of sidesFor(a, b)) {
        const cell = Math.floor(s / 3)
        if (cell === c0 && c1 < n) {
          this.across[s] = c1
          this.sideBlocked[s] = flag & 2 ? 1 : 0
        } else if (cell === c1 && c0 < n) {
          this.across[s] = c0
          this.sideBlocked[s] = flag & 1 ? 1 : 0
        } else continue
        this.sideEdge[s] = e
        this.sideFlag[s] = flag
      }
    }

    // Point-location grid over the local XZ bounds.
    const w = Math.max(this.maxX - this.minX, 1)
    const h = Math.max(this.maxZ - this.minZ, 1)
    let gs = Math.max(10, Math.sqrt((w * h) / Math.max(n, 1)) * 2)
    while (w / gs > 128 || h / gs > 128) gs *= 1.5
    this.gs = gs
    this.gx0 = n ? this.minX : 0
    this.gz0 = n ? this.minZ : 0
    this.gw = Math.floor(w / gs) + 1
    this.gh = Math.floor(h / gs) + 1
    const counts = new Int32Array(this.gw * this.gh + 1)
    const range = (c: number, fn: (bucket: number) => void) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
      for (let k = 0; k < 3; k++) {
        const v = tri[c * 3 + k]!
        x0 = Math.min(x0, vx[v]!); x1 = Math.max(x1, vx[v]!)
        z0 = Math.min(z0, vz[v]!); z1 = Math.max(z1, vz[v]!)
      }
      const bx0 = this.gridX(x0 - IN_CELL_EPS), bx1 = this.gridX(x1 + IN_CELL_EPS)
      const bz0 = this.gridZ(z0 - IN_CELL_EPS), bz1 = this.gridZ(z1 + IN_CELL_EPS)
      for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) fn(bz * this.gw + bx)
    }
    for (let c = 0; c < n; c++) range(c, b => counts[b + 1]!++)
    for (let i = 1; i < counts.length; i++) counts[i]! += counts[i - 1]!
    this.gStart = Int32Array.from(counts)
    this.gList = new Int32Array(counts[counts.length - 1]!)
    const fill = Int32Array.from(counts)
    for (let c = 0; c < n; c++) range(c, b => { this.gList[fill[b]!++] = c })
  }

  gridX(x: number): number {
    const g = Math.floor((x - this.gx0) / this.gs)
    return g < 0 ? 0 : g >= this.gw ? this.gw - 1 : g
  }

  gridZ(z: number): number {
    const g = Math.floor((z - this.gz0) / this.gs)
    return g < 0 ? 0 : g >= this.gh ? this.gh - 1 : g
  }

  /** Largest outside distance of (x, z) over the cell's sides (<= 0: inside). */
  outside(c: number, x: number, z: number): number {
    const i = c * 3
    const s0 = this.snx[i]! * x + this.snz[i]! * z - this.snd[i]!
    const s1 = this.snx[i + 1]! * x + this.snz[i + 1]! * z - this.snd[i + 1]!
    const s2 = this.snx[i + 2]! * x + this.snz[i + 2]! * z - this.snd[i + 2]!
    return s0 > s1 ? (s0 > s2 ? s0 : s2) : s1 > s2 ? s1 : s2
  }

  degenerate(c: number): boolean {
    return this.snx[c * 3]! === 0 && this.snz[c * 3]! === 0
  }

  heightIn(c: number, x: number, z: number): number {
    return this.plane[c * 3]! * x + this.plane[c * 3 + 1]! * z + this.plane[c * 3 + 2]!
  }
}

class RtInstance {
  readonly cos: number
  readonly sin: number
  readonly minX: number
  readonly minZ: number
  readonly maxX: number
  readonly maxZ: number
  /** Per outline edge: linked instance (-1 none) and its outline edge. */
  readonly linkTarget: Int32Array
  readonly linkEdge: Int32Array

  constructor(readonly index: number, readonly src: NavInstance, readonly model: RtModel) {
    this.cos = Math.cos(src.yaw)
    this.sin = Math.sin(src.yaw)
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const [lx, lz] of [[model.minX, model.minZ], [model.maxX, model.minZ], [model.minX, model.maxZ], [model.maxX, model.maxZ]] as const) {
      const wx = src.x + this.cos * lx - this.sin * lz
      const wz = src.z + this.sin * lx + this.cos * lz
      x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); z0 = Math.min(z0, wz); z1 = Math.max(z1, wz)
    }
    this.minX = x0 - 1
    this.maxX = x1 + 1
    this.minZ = z0 - 1
    this.maxZ = z1 + 1
    const no = model.oflag.length
    this.linkTarget = new Int32Array(no).fill(-1)
    this.linkEdge = new Int32Array(no).fill(-1)
  }

  localX(x: number, z: number): number {
    return this.cos * (x - this.src.x) + this.sin * (z - this.src.z)
  }

  localZ(x: number, z: number): number {
    return -this.sin * (x - this.src.x) + this.cos * (z - this.src.z)
  }

  worldX(lx: number, lz: number): number {
    return this.src.x + this.cos * lx - this.sin * lz
  }

  worldZ(lx: number, lz: number): number {
    return this.src.z + this.sin * lx + this.cos * lz
  }
}

const Ev = { None: 0, Tile: 1, World: 2, Block: 3, Enter: 4, Exit: 5, Link: 6, Stuck: 7 } as const
type Ev = (typeof Ev)[keyof typeof Ev]

export class NavWorld {
  private readonly regions = new Map<number, NavRegion>()
  private models: RtModel[] = []
  private instances: RtInstance[] = []
  private readonly buckets = new Map<number, Int32Array>()
  private stamp = new Uint32Array(0)
  private stampId = 0
  private navData: NavData
  // Scratch event of the last leg.
  private evKind: Ev = Ev.None
  private evT = 0
  private evInst = -1
  private evEdge = -1
  private evCell = -1
  private evFlag = 0
  private evSide = -1
  private evInline = false
  // Cells crossed by the last object leg: trCell[i] from chord fraction trT[i] on.
  private trT: number[] = []
  private trCell: number[] = []
  private reachCache: NavReach | null = null
  /** Siege (docs/SIEGE.md §4.1): per instance index, 1 = switched off (skipped by every query). */
  private disabled = new Uint8Array(0)
  private disabledCount = 0
  /** Siege (§4.1): forced tile states by global tile key (tileKey), consulted before the region's cell map. */
  private readonly tileOverrides = new Map<number, 0 | 1>()

  constructor(data: NavData) {
    this.navData = data
    for (const r of data.regions) this.regions.set(r.id, r)
    this.buildObjects(data, [])
  }

  /** The data the world was built from; after editInstances, the edited data (`regions` as given at construction). */
  get data(): NavData {
    return this.navData
  }

  /** Object runtime (models, instances, links, broad-phase buckets); `reuse` holds already-built models by NavModel. */
  private buildObjects(data: NavData, reuse: readonly RtModel[]): void {
    const old = new Map<NavModel, RtModel>()
    for (const m of reuse) old.set(m.src, m)
    this.models = data.models.map(m => old.get(m) ?? new RtModel(m))
    this.instances = data.instances.map((inst, i) => new RtInstance(i, inst, this.models[inst.model]!))
    this.buckets.clear()
    for (const inst of this.instances) {
      for (const l of inst.src.links) {
        if (l.edge < inst.linkTarget.length && l.target < this.instances.length) {
          inst.linkTarget[l.edge] = l.target
          inst.linkEdge[l.edge] = l.targetEdge
        }
      }
    }
    this.stamp = new Uint32Array(this.instances.length)
    if (this.disabled.length !== this.instances.length) {
      const next = new Uint8Array(this.instances.length)
      next.set(this.disabled.subarray(0, Math.min(this.disabled.length, next.length)))
      this.disabled = next
    }
    this.disabledCount = this.disabled.reduce((n, v) => n + v, 0)
    const lists = new Map<number, number[]>()
    for (const inst of this.instances) {
      for (let bz = Math.floor(inst.minZ / BUCKET); bz <= Math.floor(inst.maxZ / BUCKET); bz++) {
        for (let bx = Math.floor(inst.minX / BUCKET); bx <= Math.floor(inst.maxX / BUCKET); bx++) {
          const key = bx * BUCKET_STRIDE + bz
          let list = lists.get(key)
          if (!list) lists.set(key, (list = []))
          list.push(inst.index)
        }
      }
    }
    for (const [k, v] of lists) this.buckets.set(k, Int32Array.from(v))
  }

  // --- object instance edits (S-NAV, docs/WORLD_EDITOR.md §F10; ./instances.ts) -------------------------------------

  /**
   * Edits object instances in place (the world editor's walk preview): removes, moves (same id: same index) and adds
   * instances by id regionId << 16 | uid, as editNavInstances does on the data; the result equals a world built from
   * the edited data, with the regions loaded now kept. Returns the old -> new instance index map (-1 removed):
   * positions held on an object surface must be re-mapped (or re-located) by the caller. Links are never edited
   * (throws, and the world is unchanged). The walkable components are rebuilt on their next use.
   */
  editInstances(edits: NavInstanceEdits): Int32Array {
    const result = editNavInstances(this.navData, edits)
    this.navData = result.data
    // switched-off instances stay off at their new index (a replaced slot keeps its state; appended ones start on)
    const disabled = new Uint8Array(result.data.instances.length)
    this.disabled.forEach((v, i) => {
      const j = result.remap[i]!
      if (v && j >= 0) disabled[j] = 1
    })
    this.disabled = disabled
    this.buildObjects(result.data, this.models)
    this.stampId = 0
    this.reachCache = null
    return result.remap
  }

  // --- region streaming (docs/FIELDS.md §3.8) ------------------------------------------------------------------------

  /**
   * Adds (or replaces) one region's terrain, e.g. a streamed `nav/<x>_<z>.bin` chunk. Object instances are not
   * affected (they are bucketed by position once). The walkable components are rebuilt on their next use.
   * `data.regions` is not updated.
   */
  addRegion(r: NavRegion): void {
    this.regions.set(r.id, r)
    this.reachCache = null
  }

  /**
   * Removes one region's terrain: points in it behave as unloaded terrain again (terrainOpen false, terrainHeight NaN).
   * Returns whether it was loaded. The walkable components are rebuilt on their next use.
   */
  removeRegion(id: number): boolean {
    if (!this.regions.delete(id)) return false
    this.reachCache = null
    return true
  }

  get instanceCount(): number {
    return this.instances.length
  }

  // --- runtime switches (docs/SIEGE.md §4.1: wall thirds that break) ------------------------------------------------

  /**
   * Switches an object instance off (or back on): a disabled instance is skipped by locate, the terrain walker's
   * edge tests, the walkable components and debugEdges, as if it were not there. O(1); the components are rebuilt on
   * their next use. Returns whether the state changed. Meant for solids nobody stands on (wall bodies): a position
   * held on a disabled instance's cell keeps walking on it.
   */
  setInstanceEnabled(index: number, on: boolean): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.instances.length) throw new Error(`nav: no instance ${index}`)
    const v = on ? 0 : 1
    if (this.disabled[index] === v) return false
    this.disabled[index] = v
    this.disabledCount += on ? -1 : 1
    this.reachCache = null
    return true
  }

  isInstanceEnabled(index: number): boolean {
    return this.disabled[index] !== 1
  }

  /**
   * Forces one terrain tile open or closed (null: back to the region's own cell). `tile` is the region-local index
   * tz * 96 + tx. An override is kept whether or not the region is loaded now (streaming), and applies only while it
   * is: an unloaded tile stays "no terrain". A forced-open tile walks like an open cell (heights come from the shared
   * height grid, so it needs no cell of its own: the converter's "takes an open neighbour's cell" has no other effect
   * at run time). Returns whether the state changed; the components are rebuilt on their next use.
   */
  setTileOverride(regionId: number, tile: number, mode: 'open' | 'closed' | null): boolean {
    if (!Number.isInteger(tile) || tile < 0 || tile >= NVM_TILES * NVM_TILES) throw new Error(`nav: bad tile ${tile}`)
    const rx = regionId & 0xff, rz = (regionId >> 8) & 0x7f
    const key = tileKey(rx * NVM_TILES + (tile % NVM_TILES), rz * NVM_TILES + Math.floor(tile / NVM_TILES))
    const before = this.tileOverrides.get(key)
    if (mode === null) {
      if (before === undefined) return false
      this.tileOverrides.delete(key)
    } else {
      const v = mode === 'open' ? 0 : 1
      if (before === v) return false
      this.tileOverrides.set(key, v)
    }
    this.reachCache = null
    return true
  }

  /** The override of a tile ('open' / 'closed'), or null. */
  tileOverride(regionId: number, tile: number): 'open' | 'closed' | null {
    const rx = regionId & 0xff, rz = (regionId >> 8) & 0x7f
    const v = this.tileOverrides.get(tileKey(rx * NVM_TILES + (tile % NVM_TILES), rz * NVM_TILES + Math.floor(tile / NVM_TILES)))
    return v === undefined ? null : v === 0 ? 'open' : 'closed'
  }

  /** How many tiles are overridden and instances switched off (diagnostics). */
  get runtimeSwitches(): { tiles: number; disabled: number } {
    return { tiles: this.tileOverrides.size, disabled: this.disabledCount }
  }

  instanceInfo(index: number): { id: number; objId: number; model: string; x: number; y: number; z: number; yaw: number; cells: number } {
    const inst = this.instances[index]!
    const { id, objId, x, y, z, yaw } = inst.src
    return { id, objId, model: inst.model.src.key, x, y, z, yaw, cells: inst.model.n }
  }

  // --- terrain -------------------------------------------------------------------------------------------------------

  private regionAt(x: number, z: number): NavRegion | undefined {
    const rx = Math.floor(x / NVM_REGION_SIZE)
    const rz = Math.floor(z / NVM_REGION_SIZE)
    if (rx < 0 || rz < 0 || rx > 255 || rz > 127) return undefined
    const r = this.regions.get((rz << 8) | rx)
    if (r) return r
    // A point exactly on a border belongs to the higher region; fall back to the lower one when that is missing.
    const lx = x === rx * NVM_REGION_SIZE && rx > 0 ? rx - 1 : rx
    const lz = z === rz * NVM_REGION_SIZE && rz > 0 ? rz - 1 : rz
    return lx !== rx || lz !== rz ? this.regions.get((lz << 8) | lx) : undefined
  }

  /** Terrain height (ice lift included) at a world point, or NaN outside the loaded regions. */
  terrainHeight(x: number, z: number): number {
    const r = this.regionAt(x, z)
    if (!r) return NaN
    return nvmHeightAt(r, x - r.rx * NVM_REGION_SIZE, z - r.rz * NVM_REGION_SIZE)
  }

  /** 0 open, 1 closed cell, 2 no terrain loaded; by global tile index (20-unit tiles). */
  private tileState(tx: number, tz: number): number {
    const rx = Math.floor(tx / NVM_TILES)
    const rz = Math.floor(tz / NVM_TILES)
    if (rx < 0 || rz < 0 || rx > 255 || rz > 127) return 2
    const r = this.regions.get((rz << 8) | rx)
    if (!r) return 2
    if (this.tileOverrides.size) {
      const o = this.tileOverrides.get(tileKey(tx, tz))
      if (o !== undefined) return o
    }
    const cell = r.tileCells[(tz - rz * NVM_TILES) * NVM_TILES + (tx - rx * NVM_TILES)]!
    return cell >= 0 && cell < r.openCellCount ? 0 : 1
  }

  /** Terrain at (x, z) is loaded and its cell is open. */
  terrainOpen(x: number, z: number): boolean {
    return this.tileState(Math.floor(x / NVM_TILE_SIZE), Math.floor(z / NVM_TILE_SIZE)) === 0
  }

  // --- surfaces ------------------------------------------------------------------------------------------------------

  /** Height of a surface at (x, z): the cell plane (extended beyond the triangle) or the terrain; NaN if unknown. */
  heightOn(surface: NavSurface, x: number, z: number): number {
    if (surface.kind === 'terrain') return this.terrainHeight(x, z)
    const inst = this.instances[surface.instance]
    if (!inst || surface.cell >= inst.model.n) return NaN
    return inst.src.y + inst.model.heightIn(surface.cell, inst.localX(x, z), inst.localZ(x, z))
  }

  /**
   * §5.2, for positions without a retained surface (spawn, teleport, server correction): every surface at (x, z)
   * (the terrain if its cell is open, every object cell containing the point) and the one nearest to yHint;
   * the terrain wins ties. yHint = +Infinity / -Infinity picks the highest / lowest surface. null when there is none.
   * The hint must be near the intended surface: from the terrain height under the Jangan plaza it picks the terrain.
   */
  locate(x: number, z: number, yHint: number): NavPosition | null {
    return this.pick(x, z, yHint, -1)
  }

  /** locate() restricted to the surfaces of one walkable component (see componentOf); null when none is at (x, z). */
  locateIn(x: number, z: number, yHint: number, component: number): NavPosition | null {
    return component < 0 ? null : this.pick(x, z, yHint, component)
  }

  private pick(x: number, z: number, yHint: number, component: number): NavPosition | null {
    const dist = yHint === Infinity ? (y: number) => -y : yHint === -Infinity ? (y: number) => y : (y: number) => Math.abs(y - yHint)
    const reach = component >= 0 ? this.reach : null
    let found = false
    let bestY = NaN
    let bestD = Infinity
    let bestInst = -1
    let bestCell = -1
    if (this.terrainOpen(x, z) && (!reach || reach.terrainComponent(x, z) === component)) {
      bestY = this.terrainHeight(x, z)
      bestD = dist(bestY)
      found = true
    }
    const list = this.buckets.get(Math.floor(x / BUCKET) * BUCKET_STRIDE + Math.floor(z / BUCKET))
    if (list) {
      for (let li = 0; li < list.length; li++) {
        const inst = this.instances[list[li]!]!
        if (x < inst.minX || x > inst.maxX || z < inst.minZ || z > inst.maxZ) continue
        if (this.disabled[inst.index] === 1) continue
        const m = inst.model
        const lx = inst.localX(x, z)
        const lz = inst.localZ(x, z)
        if (lx < m.minX - IN_CELL_EPS || lx > m.maxX + IN_CELL_EPS || lz < m.minZ - IN_CELL_EPS || lz > m.maxZ + IN_CELL_EPS) continue
        const b = m.gridZ(lz) * m.gw + m.gridX(lx)
        for (let gi = m.gStart[b]!; gi < m.gStart[b + 1]!; gi++) {
          const c = m.gList[gi]!
          if (m.degenerate(c) || m.outside(c, lx, lz) > IN_CELL_EPS) continue
          if (reach && reach.cellComponent(inst.index, c) !== component) continue
          const y = inst.src.y + m.heightIn(c, lx, lz)
          const d = dist(y)
          if (!found || d < bestD) {
            found = true
            bestD = d
            bestY = y
            bestInst = inst.index
            bestCell = c
          }
        }
      }
    }
    if (!found) return null
    return { x, y: bestY, z, surface: bestInst < 0 ? TERRAIN_SURFACE : { kind: 'object', instance: bestInst, cell: bestCell } }
  }

  // --- reachability (reach.ts, docs/NAVIGATION.md §11) -----------------------------------------------------------

  /** Walkable components, built on first use (about 0.1-0.2 s for the 9 Jangan regions). */
  private get reach(): NavReach {
    return (this.reachCache ??= new NavReach({
      regions: this.regions,
      instances: this.instances,
      tileState: (tx, tz) => this.tileState(tx, tz),
      terrainHeight: (x, z) => this.terrainHeight(x, z),
      ...(this.disabledCount ? { instanceEnabled: (i: number) => this.disabled[i] !== 1 } : {}),
    }))
  }

  /**
   * The walkable component of a located position (its retained surface; a terrain position by its point): places
   * the walker can get from each to the other. -1 on a closed or unloaded terrain tile, or an unknown surface.
   */
  componentOf(p: { x: number; z: number; surface: NavSurface }): number {
    if (p.surface.kind === 'terrain') return this.reach.terrainComponent(p.x, p.z)
    return this.reach.cellComponent(p.surface.instance, p.surface.cell)
  }

  /** Both positions lie in one component (so each can walk to the other); false if either has none. */
  sameComponent(a: { x: number; z: number; surface: NavSurface }, b: { x: number; z: number; surface: NavSurface }): boolean {
    const c = this.componentOf(a)
    return c >= 0 && c === this.componentOf(b)
  }

  /**
   * Whether the walker can get from component `from` into component `to` (possibly one way: terrain under an object
   * footprint walks out, nobody walks in). True for from === to (>= 0).
   */
  componentReaches(from: number, to: number): boolean {
    return this.reach.reaches(from, to)
  }

  /** A component's area, size, bounds and sample point (world file space); null for an unknown id. */
  componentInfo(id: number): NavComponent | null {
    return this.reach.list[id] ?? null
  }

  /** Every component, largest area first (the id is the index). */
  components(): readonly NavComponent[] {
    return this.reach.list
  }

  /** The sample point of a component as a position (its surface: terrain or the sample's object cell). */
  componentSample(id: number): NavPosition | null {
    const s = this.reach.list[id]?.sample
    if (!s) return null
    return { x: s.x, y: s.y, z: s.z, surface: s.instance < 0 ? TERRAIN_SURFACE : { kind: 'object', instance: s.instance, cell: s.cell } }
  }

  /** Build statistics of the components (builds them if needed). */
  reachStats(): NavReachStats {
    return this.reach.stats
  }

  /** locate(x, z, yHint)?.y, or null. */
  heightAt(x: number, z: number, yHint: number): number | null {
    return this.locate(x, z, yHint)?.y ?? null
  }

  /** A surface lies within `tolerance` of y at (x, z). */
  canStand(x: number, z: number, y: number, tolerance = 10): boolean {
    const p = this.locate(x, z, y)
    return p !== null && Math.abs(p.y - y) <= tolerance
  }

  /**
   * §5.1: keep a retained surface at a (slightly) moved point, e.g. after int16 quantization: the same cell if it
   * contains the point, else an inline neighbour that does, else the point clamped into the cell. Terrain positions
   * just take the terrain height. null when the surface is unknown or no terrain is loaded there.
   */
  settle(surface: NavSurface, x: number, z: number): NavPosition | null {
    if (surface.kind === 'terrain') {
      const y = this.terrainHeight(x, z)
      return Number.isNaN(y) ? null : { x, y, z, surface }
    }
    const inst = this.instances[surface.instance]
    if (!inst || surface.cell >= inst.model.n) return null
    const m = inst.model
    const lx = inst.localX(x, z)
    const lz = inst.localZ(x, z)
    const c = surface.cell
    if (m.outside(c, lx, lz) <= IN_CELL_EPS) return { x, y: inst.src.y + m.heightIn(c, lx, lz), z, surface }
    for (let k = 0; k < 3; k++) {
      const n = m.across[c * 3 + k]!
      if (n >= 0 && m.outside(n, lx, lz) <= IN_CELL_EPS) {
        return { x, y: inst.src.y + m.heightIn(n, lx, lz), z, surface: { kind: 'object', instance: inst.index, cell: n } }
      }
    }
    const [px, pz] = closestInTriangle(m, c, lx, lz)
    return { x: inst.worldX(px, pz), y: inst.src.y + m.heightIn(c, px, pz), z: inst.worldZ(px, pz), surface }
  }

  // --- movement ------------------------------------------------------------------------------------------------------

  /**
   * §6: walk the straight chord from `from` (with its retained surface) toward (toX, toZ); stops at the first
   * blocking contact. The end position carries the surface it reached.
   */
  moveStraight(from: NavPosition, toX: number, toZ: number): NavMoveResult {
    let surface = from.surface
    let x = from.x
    let z = from.z
    if (surface.kind === 'object') {
      const s = this.settle(surface, x, z)
      if (!s) {
        const p = this.locate(x, z, from.y)
        if (!p) return this.result(x, z, surface, [], true, { kind: 'world', x, z })
        surface = p.surface
      } else {
        surface = s.surface
        x = s.x
        z = s.z
      }
    }
    const legs: NavLeg[] = []
    for (let leg = 0; leg < NAV_MAX_LEGS; leg++) {
      const dx = toX - x
      const dz = toZ - z
      const len = Math.hypot(dx, dz)
      if (len === 0) return this.result(x, z, surface, legs, false, null)
      if (surface.kind === 'terrain') {
        this.terrainLeg(x, z, toX, toZ, leg === 0)
        const t = this.evT
        const hx = x + dx * t
        const hz = z + dz * t
        switch (this.evKind) {
          case Ev.None:
            legs.push({ x0: x, z0: z, x1: toX, z1: toZ, surface })
            return this.result(toX, toZ, surface, legs, false, null)
          case Ev.Tile:
          case Ev.World: {
            const tb = Math.max(0, t - NAV_TILE_BACKOFF / len)
            const ex = x + dx * tb
            const ez = z + dz * tb
            legs.push({ x0: x, z0: z, x1: ex, z1: ez, surface })
            return this.result(ex, ez, surface, legs, true, { kind: this.evKind === Ev.Tile ? 'tile' : 'world', x: hx, z: hz })
          }
          case Ev.Block: {
            const tb = Math.max(0, t - NAV_CONTACT_BACKOFF / len)
            const ex = x + dx * tb
            const ez = z + dz * tb
            legs.push({ x0: x, z0: z, x1: ex, z1: ez, surface })
            return this.result(ex, ez, surface, legs, true, this.edgeHit(hx, hz, true))
          }
          case Ev.Enter: {
            const inst = this.instances[this.evInst]!
            const cell = this.evCell
            legs.push({ x0: x, z0: z, x1: hx, z1: hz, surface })
            const [nx, nz] = this.towardCentroid(inst, cell, hx, hz, NAV_CONTACT_BACKOFF)
            x = nx
            z = nz
            surface = { kind: 'object', instance: inst.index, cell }
            break
          }
        }
      } else {
        const inst = this.instances[surface.instance]!
        this.objectLeg(inst, surface.cell, x, z, toX, toZ)
        const t = this.evT
        const hx = x + dx * t
        const hz = z + dz * t
        const cell = this.evCell
        const here: NavSurface = cell === surface.cell ? surface : { kind: 'object', instance: inst.index, cell }
        switch (this.evKind) {
          case Ev.None:
            this.pushTrace(legs, inst.index, x, z, dx, dz, toX, toZ)
            return this.result(toX, toZ, here, legs, false, null)
          case Ev.Block:
          case Ev.Stuck: {
            const back = Math.min(NAV_CONTACT_BACKOFF, len * t)
            const [ex, ez] = this.towardCentroid(inst, cell, hx, hz, back)
            this.pushTrace(legs, inst.index, x, z, dx, dz, ex, ez)
            const hit = this.evKind === Ev.Stuck ? { kind: 'stuck' as const, x: hx, z: hz } : this.edgeHit(hx, hz, !this.evInline)
            return this.result(ex, ez, here, legs, true, hit)
          }
          case Ev.Exit: {
            const m = inst.model
            const side = this.evSide
            const onx = m.snx[side]!, onz = m.snz[side]!
            const ox = hx + (inst.cos * onx - inst.sin * onz) * NAV_CONTACT_BACKOFF
            const oz = hz + (inst.sin * onx + inst.cos * onz) * NAV_CONTACT_BACKOFF
            if (!this.terrainOpen(ox, oz) || this.insideFootprint(inst, ox, oz)) {
              // Exit onto a closed (or unloaded) terrain cell, or a nudge that lands back inside this object's own
              // footprint (a sharp reflex corner: the terrain there lies under the object): stay on the object.
              const back = Math.min(NAV_CONTACT_BACKOFF, len * t)
              const [ex, ez] = this.towardCentroid(inst, cell, hx, hz, back)
              this.pushTrace(legs, inst.index, x, z, dx, dz, ex, ez)
              const kind = this.terrainOpenState(ox, oz) === 2 ? 'world' as const : 'tile' as const
              return this.result(ex, ez, here, legs, true, { kind, x: hx, z: hz })
            }
            this.pushTrace(legs, inst.index, x, z, dx, dz, hx, hz)
            x = ox
            z = oz
            surface = TERRAIN_SURFACE
            break
          }
          case Ev.Link: {
            const target = this.instances[inst.linkTarget[this.evEdge]!]!
            const tEdge = inst.linkEdge[this.evEdge]!
            const tCell = tEdge < target.model.ocell.length ? target.model.ocell[tEdge]! : -1
            if (tCell < 0) {
              const back = Math.min(NAV_CONTACT_BACKOFF, len * t)
              const [ex, ez] = this.towardCentroid(inst, cell, hx, hz, back)
              this.pushTrace(legs, inst.index, x, z, dx, dz, ex, ez)
              return this.result(ex, ez, here, legs, true, this.edgeHit(hx, hz, true))
            }
            this.pushTrace(legs, inst.index, x, z, dx, dz, hx, hz)
            const [nx, nz] = this.towardCentroid(target, tCell, hx, hz, NAV_CONTACT_BACKOFF)
            x = nx
            z = nz
            surface = { kind: 'object', instance: target.index, cell: tCell }
            break
          }
        }
      }
      const rx = toX - x
      const rz = toZ - z
      if (rx * rx + rz * rz < NAV_ARRIVE_RADIUS * NAV_ARRIVE_RADIUS) return this.result(x, z, surface, legs, false, null)
    }
    return this.result(x, z, surface, legs, true, { kind: 'legs', x, z })
  }

  /** Object leg pieces, one per cell crossed (trT/trCell), from (x, z) along (dx, dz), the last ending at (ex, ez). */
  private pushTrace(legs: NavLeg[], instance: number, x: number, z: number, dx: number, dz: number, ex: number, ez: number): void {
    const n = this.trT.length
    for (let i = 0; i < n; i++) {
      const t0 = this.trT[i]!
      const x0 = x + dx * t0
      const z0 = z + dz * t0
      const x1 = i + 1 < n ? x + dx * this.trT[i + 1]! : ex
      const z1 = i + 1 < n ? z + dz * this.trT[i + 1]! : ez
      if (n > 1 && x0 === x1 && z0 === z1) continue
      legs.push({ x0, z0, x1, z1, surface: { kind: 'object', instance, cell: this.trCell[i]! } })
    }
  }

  /** Whether a world point lies inside (or within IN_CELL_EPS of) one of the instance's cells, in XZ. */
  private insideFootprint(inst: RtInstance, x: number, z: number): boolean {
    const m = inst.model
    const lx = inst.localX(x, z), lz = inst.localZ(x, z)
    if (lx < m.minX || lx > m.maxX || lz < m.minZ || lz > m.maxZ) return false
    const b = m.gridZ(lz) * m.gw + m.gridX(lx)
    for (let gi = m.gStart[b]!; gi < m.gStart[b + 1]!; gi++) {
      const c = m.gList[gi]!
      if (!m.degenerate(c) && m.outside(c, lx, lz) <= IN_CELL_EPS) return true
    }
    return false
  }

  private terrainOpenState(x: number, z: number): number {
    return this.tileState(Math.floor(x / NVM_TILE_SIZE), Math.floor(z / NVM_TILE_SIZE))
  }

  private result(x: number, z: number, surface: NavSurface, legs: NavLeg[], blocked: boolean, hit: NavHit | null): NavMoveResult {
    let y = this.heightOn(surface, x, z)
    if (Number.isNaN(y)) y = 0
    let distance = 0
    for (const l of legs) distance += Math.hypot(l.x1 - l.x0, l.z1 - l.z0)
    return { end: { x, y, z, surface }, blocked, hit, distance, legs }
  }

  private edgeHit(x: number, z: number, outline: boolean): NavHit {
    return { kind: 'edge', x, z, instance: this.evInst, edge: this.evEdge, outline, flag: this.evFlag }
  }

  /** Moves a world point up to `dist` toward a cell's centroid (never past it). */
  private towardCentroid(inst: RtInstance, cell: number, x: number, z: number, dist: number): [number, number] {
    const cx = inst.worldX(inst.model.cx[cell]!, inst.model.cz[cell]!)
    const cz = inst.worldZ(inst.model.cx[cell]!, inst.model.cz[cell]!)
    const dx = cx - x
    const dz = cz - z
    const len = Math.hypot(dx, dz)
    if (len < 1e-12 || dist <= 0) return [x, z]
    const k = Math.min(dist, len * 0.5) / len
    return [x + dx * k, z + dz * k]
  }

  /**
   * Terrain walker leg (§6.2) from (x0, z0) to (x1, z1). Sets evKind/evT (fraction of the chord), and for object
   * edges evInst/evEdge/evFlag/evCell. `escape`: the start tile may be closed (a rescue: the first step out of a
   * closed area never blocks).
   */
  private terrainLeg(x0: number, z0: number, x1: number, z1: number, escape: boolean): void {
    const dx = x1 - x0
    const dz = z1 - z0
    // 1. First closed / unloaded tile along the chord (supercover DDA; exact corners test both side tiles).
    let tBlock = Infinity
    let blockKind: Ev = Ev.None
    let tx = Math.floor(x0 / NVM_TILE_SIZE)
    let tz = Math.floor(z0 / NVM_TILE_SIZE)
    let state = this.tileState(tx, tz)
    let escaping = escape && state !== 0
    if (state !== 0 && !escaping) {
      tBlock = 0
      blockKind = state === 2 ? Ev.World : Ev.Tile
    } else {
      const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0
      const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0
      const tdx = sx ? NVM_TILE_SIZE / Math.abs(dx) : Infinity
      const tdz = sz ? NVM_TILE_SIZE / Math.abs(dz) : Infinity
      let tmx = sx > 0 ? ((tx + 1) * NVM_TILE_SIZE - x0) / dx : sx < 0 ? (tx * NVM_TILE_SIZE - x0) / dx : Infinity
      let tmz = sz > 0 ? ((tz + 1) * NVM_TILE_SIZE - z0) / dz : sz < 0 ? (tz * NVM_TILE_SIZE - z0) / dz : Infinity
      for (;;) {
        let t: number
        if (tmx !== Infinity && tmz !== Infinity && Math.abs(tmx - tmz) <= 1e-12 * Math.max(1, tmx)) {
          t = tmx
          if (t > 1) break
          const a = this.tileState(tx + sx, tz)
          const b = this.tileState(tx, tz + sz)
          tx += sx
          tz += sz
          const c = this.tileState(tx, tz)
          state = a !== 0 ? a : b !== 0 ? b : c
          tmx += tdx
          tmz += tdz
        } else if (tmx < tmz) {
          t = tmx
          if (t > 1) break
          tx += sx
          tmx += tdx
          state = this.tileState(tx, tz)
        } else {
          t = tmz
          if (t > 1) break
          tz += sz
          tmz += tdz
          state = this.tileState(tx, tz)
        }
        if (state === 0) {
          escaping = false
        } else if (!escaping) {
          tBlock = t
          blockKind = state === 2 ? Ev.World : Ev.Tile
          break
        }
      }
    }

    // 2. Object outline edges crossed from outside, up to the tile block.
    const tLimit = Math.min(tBlock, 1)
    let bestT = Infinity
    let bestKind: Ev = Ev.None
    let bestInst = -1
    let bestEdge = -1
    let bestFlag = 0
    let bestCell = -1
    const ex = x0 + dx * tLimit
    const ez = z0 + dz * tLimit
    const minX = Math.min(x0, ex), maxX = Math.max(x0, ex), minZ = Math.min(z0, ez), maxZ = Math.max(z0, ez)
    const stampId = this.nextStamp()
    for (let bz = Math.floor(minZ / BUCKET); bz <= Math.floor(maxZ / BUCKET); bz++) {
      for (let bx = Math.floor(minX / BUCKET); bx <= Math.floor(maxX / BUCKET); bx++) {
        const list = this.buckets.get(bx * BUCKET_STRIDE + bz)
        if (!list) continue
        for (let li = 0; li < list.length; li++) {
          const ii = list[li]!
          if (this.stamp[ii] === stampId) continue
          this.stamp[ii] = stampId
          if (this.disabled[ii] === 1) continue
          const inst = this.instances[ii]!
          if (inst.maxX < minX || inst.minX > maxX || inst.maxZ < minZ || inst.minZ > maxZ) continue
          const m = inst.model
          const lx0 = inst.localX(x0, z0)
          const lz0 = inst.localZ(x0, z0)
          const ldx = inst.cos * dx + inst.sin * dz
          const ldz = -inst.sin * dx + inst.cos * dz
          for (let e = 0; e < m.oflag.length; e++) {
            // Entering from outside only: the chord runs toward the inside (the src cell's side).
            if (ldx * m.onx[e]! + ldz * m.onz[e]! <= 0) continue
            const flag = m.oflag[e]!
            if (flag & 16) continue
            const exl = m.obx[e]! - m.oax[e]!
            const ezl = m.obz[e]! - m.oaz[e]!
            const denom = ldx * ezl - ldz * exl
            if (Math.abs(denom) < 1e-12) continue
            const wx = m.oax[e]! - lx0
            const wz = m.oaz[e]! - lz0
            const t = (wx * ezl - wz * exl) / denom
            if (t < -1e-9 || t > tLimit || t > bestT) continue
            const u = (wx * ldz - wz * ldx) / denom
            if (u < -EDGE_U_EPS || u > 1 + EDGE_U_EPS) continue
            let kind: Ev
            if (flag & 1) kind = Ev.Block
            else if (flag & 8) kind = inst.linkTarget[e]! >= 0 && m.ocell[e]! >= 0 ? Ev.Enter : Ev.Block
            else kind = m.ocell[e]! >= 0 ? Ev.Enter : Ev.Block
            // Earliest wins; on an exact tie a block wins, then the lower instance/edge (deterministic).
            if (t === bestT && !(kind === Ev.Block && bestKind !== Ev.Block)) continue
            bestT = Math.max(0, t)
            bestKind = kind
            bestInst = ii
            bestEdge = e
            bestFlag = flag
            bestCell = m.ocell[e]!
          }
        }
      }
    }
    if (bestKind !== Ev.None && bestT <= tBlock) {
      this.evKind = bestKind
      this.evT = bestT
      this.evInst = bestInst
      this.evEdge = bestEdge
      this.evFlag = bestFlag
      this.evCell = bestCell
      this.evSide = -1
      this.evInline = false
      return
    }
    this.evKind = tBlock <= 1 ? blockKind : Ev.None
    this.evT = tBlock <= 1 ? tBlock : 1
    this.evInst = -1
    this.evEdge = -1
    this.evFlag = 0
    this.evCell = -1
    this.evSide = -1
  }

  /**
   * Object walker leg (§6.3) from cell `cell` of `inst`, chord (x0, z0) -> (x1, z1) in world space, walked in the
   * instance's local frame. Sets evKind/evT/evCell (the cell reached), evEdge/evFlag/evSide for edge events.
   */
  private objectLeg(inst: RtInstance, cell: number, x0: number, z0: number, x1: number, z1: number): void {
    const m = inst.model
    const px = inst.localX(x0, z0)
    const pz = inst.localZ(x0, z0)
    const dx = inst.localX(x1, z1) - px
    const dz = inst.localZ(x1, z1) - pz
    const dlen = Math.hypot(dx, dz) || 1
    let c = cell
    let tCur = 0
    const maxSteps = m.n * 3 + 16
    this.trT.length = 0
    this.trCell.length = 0
    this.trT.push(0)
    this.trCell.push(c)
    this.evInst = inst.index
    this.evFlag = 0
    this.evEdge = -1
    this.evSide = -1
    this.evInline = false
    for (let step = 0; step < maxSteps; step++) {
      let best = -1
      let bestT = Infinity
      let bestDn = 0
      for (let k = 0; k < 3; k++) {
        const s = c * 3 + k
        const dn = m.snx[s]! * dx + m.snz[s]! * dz
        if (dn <= 1e-12 * dlen) continue
        const t = (m.snd[s]! - m.snx[s]! * px - m.snz[s]! * pz) / dn
        // Nearest exit; at a vertex (equal t) the side the chord leaves most squarely through.
        if (t < bestT - 1e-12 || (t <= bestT + 1e-12 && dn > bestDn)) {
          best = s
          bestT = t
          bestDn = dn
        }
      }
      if (best < 0 || bestT >= 1) {
        if (best < 0 && m.degenerate(c)) break
        this.evKind = Ev.None
        this.evT = 1
        this.evCell = c
        return
      }
      const t = Math.max(bestT, tCur)
      const across = m.across[best]!
      this.evT = t
      this.evCell = c
      this.evEdge = m.sideEdge[best]!
      this.evFlag = m.sideFlag[best]!
      if (across >= 0) {
        if (m.sideBlocked[best]) {
          this.evKind = Ev.Block
          this.evSide = best
          this.evInline = true
          return
        }
        c = across
        tCur = t
        this.trT.push(t)
        this.trCell.push(c)
        continue
      }
      this.evInline = false
      this.evSide = best
      if (across === -1) {
        const e = m.sideEdge[best]!
        const flag = m.oflag[e]!
        if (flag === 0) {
          this.evKind = Ev.Exit
          return
        }
        if (flag & 8 && inst.linkTarget[e]! >= 0) {
          this.evKind = Ev.Link
          return
        }
      }
      this.evKind = Ev.Block
      return
    }
    this.evKind = Ev.Stuck
    this.evT = tCur
    this.evCell = c
  }

  private nextStamp(): number {
    this.stampId = (this.stampId + 1) >>> 0
    if (this.stampId === 0) {
      this.stamp.fill(0)
      this.stampId = 1
    }
    return this.stampId
  }

  // --- debug ---------------------------------------------------------------------------------------------------------

  /** Outline edges and blocking inline edges of the instances overlapping a world rectangle (world file space). */
  debugEdges(minX: number, minZ: number, maxX: number, maxZ: number): NavDebugEdge[] {
    const out: NavDebugEdge[] = []
    for (const inst of this.instances) {
      if (inst.maxX < minX || inst.minX > maxX || inst.maxZ < minZ || inst.minZ > maxZ) continue
      if (this.disabled[inst.index] === 1) continue
      const m = inst.model
      const push = (a: number, b: number, flag: number, outline: boolean) => out.push({
        ax: inst.worldX(m.vx[a]!, m.vz[a]!), ay: inst.src.y + m.vy[a]!, az: inst.worldZ(m.vx[a]!, m.vz[a]!),
        bx: inst.worldX(m.vx[b]!, m.vz[b]!), by: inst.src.y + m.vy[b]!, bz: inst.worldZ(m.vx[b]!, m.vz[b]!),
        flag, outline, instance: inst.index,
      })
      const oe = m.src.outline
      for (let e = 0; e < oe.flags.length; e++) push(oe.vertices[e * 2]!, oe.vertices[e * 2 + 1]!, oe.flags[e]!, true)
      const ie = m.src.inline
      for (let e = 0; e < ie.flags.length; e++) {
        if (ie.flags[e]! & 3) push(ie.vertices[e * 2]!, ie.vertices[e * 2 + 1]!, ie.flags[e]!, false)
      }
    }
    return out
  }
}

/** Global tile key (a tile x stays below 2^15 on the 256-region grid). */
function tileKey(tx: number, tz: number): number {
  return tz * 32768 + tx
}

/** Closest point of cell c (local XZ) to (x, z). */
function closestInTriangle(m: RtModel, c: number, x: number, z: number): [number, number] {
  if (m.outside(c, x, z) <= 0) return [x, z]
  let bx = x, bz = z, bd = Infinity
  for (let k = 0; k < 3; k++) {
    const a = m.tri[c * 3 + k]!, b = m.tri[c * 3 + ((k + 1) % 3)]!
    const ax = m.vx[a]!, az = m.vz[a]!
    const ex = m.vx[b]! - ax, ez = m.vz[b]! - az
    const l2 = ex * ex + ez * ez
    const u = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / l2)) : 0
    const qx = ax + ex * u, qz = az + ez * u
    const d = (qx - x) ** 2 + (qz - z) ** 2
    if (d < bd) {
      bd = d
      bx = qx
      bz = qz
    }
  }
  // Pull the clamped point a hair inside so the cell contains it.
  const k = 1e-6
  return [bx + (m.cx[c]! - bx) * k, bz + (m.cz[c]! - bz) * k]
}
