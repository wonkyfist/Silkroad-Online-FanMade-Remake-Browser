/**
 * Walkable-connectivity components of a NavWorld (docs/NAVIGATION.md §11 "Reachability").
 *
 * Places:
 * - every object navmesh cell (instance, cell);
 * - terrain faces: the open terrain tiles cut by the object outline edges the terrain walker tests (every outline
 *   edge without flag 16). Each open 20-unit tile crossed by such edges is split by their lines into convex pieces;
 *   pieces (and whole uncut tiles) joined through a boundary no edge covers form one face.
 *
 * Transitions: exactly the walker's (world.ts moveStraight / terrainLeg / objectLeg), and they are directed:
 * - terrain -> terrain: through any boundary no edge covers (both ways); across an edge crossed from its inside,
 *   one way only (terrainLeg skips edges the chord leaves: `ldx * onx + ldz * onz <= 0`);
 * - terrain -> object: an edge crossed from outside that lets the walker in (not flag & 1; flag & 8 only if linked;
 *   with a src cell) enters that edge's src cell; any other edge crossed from outside blocks;
 * - object -> object: an inline side that does not block leaving this cell (sideBlocked); a linked flag-8 outline
 *   side into the target edge's src cell;
 * - object -> terrain: a flag-0 outline side exits NAV_CONTACT_BACKOFF (0.2) outside the side, onto every terrain
 *   face that the offset side touches on open tiles.
 * Not transitions: settle()'s neighbour re-celling (only for points > 1e-3 outside their cell, which the walker never
 * produces), and the first-step escape out of a closed tile (closed tiles are not places).
 *
 * A component is a strongly connected component of that graph: two places are in one component iff the walker can
 * get from each to the other (possibly over several moves). One-way transitions are everywhere (terrain under an
 * object footprint can walk out, nobody walks in), so undirected components would be wrong: the terrain under the
 * Jangan plaza walks out into the town and into the fountain basin, which would merge the basin with the town.
 * reaches() answers the one-way question on the condensation.
 *
 * Tolerances are file units (1 = 1 dm), all far below anything a character can use: openings narrower than
 * CORNER_EPS / SIDE_EPS count as closed (float noise where two walls meet); otherwise, where the geometry is ambiguous
 * within a tolerance, the graph keeps the extra transition. Random walks check that every walk stays inside the
 * graph's reachability, and trace() lets a test check every terrain link against the walker.
 */
import { NVM_TILES, NVM_TILE_SIZE } from '@sro/formats'
import type { NavRegion } from './data.ts'

/** Offset of an exit's landing point outside the side (world.ts NAV_CONTACT_BACKOFF). */
const EXIT_OFFSET = 0.2
/** A vertex this close to a cutting line lies on it. */
const SPLIT_TOL = 1e-7
/**
 * Edges this close to one line inside a tile (both clipped ends) cut once, along the first of them. Kept tiny: a
 * merged line moves the cut, so two tiles would disagree about where a wall crosses their shared side.
 */
const DEDUPE_TOL = 1e-9
/**
 * An edge this close to a boundary stretch over their overlap covers it (coincident edges of two objects cover
 * together), and an edge this close to a tile side does not cut the tile (it covers the side). Float noise only:
 * nearly collinear walls a few micrometres apart are different lines with a real (hairline) face between them.
 */
const COVER_TOL = 1e-7
/** Boundary stretches shorter than this are ignored. */
const LEN_EPS = 1e-7
/**
 * A covering edge also covers this much past its ends: where two walls meet, the cut vertex (the intersection of two
 * lines) sits a hair off the mesh vertex the covering edge ends at, which would open a false gap at the corner.
 */
const CORNER_EPS = 1e-6
/** Tile-side overlaps shorter than this do not connect (two tiles place one cut a hair apart on their side). */
const SIDE_EPS = 1e-6
/** Exit landing segments are lengthened by this at both ends and touch pieces within it (float noise of the hit point). */
const TOUCH_EPS = 1e-6
const T = NVM_TILE_SIZE
const TPR = NVM_TILES * NVM_TILES
/** Tile sides as polygon edge tags: south z = 0, east x = T, north z = T, west x = 0. */
const S = -1, E = -2, N = -3, W = -4

/** What the builder reads from world.ts RtModel (structural). */
export interface ReachModel {
  readonly n: number
  readonly tri: Uint32Array
  readonly vx: Float64Array
  readonly vz: Float64Array
  readonly cx: Float64Array
  readonly cz: Float64Array
  readonly snx: Float64Array
  readonly snz: Float64Array
  readonly across: Int32Array
  readonly sideEdge: Int32Array
  readonly sideBlocked: Uint8Array
  readonly oax: Float64Array
  readonly oaz: Float64Array
  readonly obx: Float64Array
  readonly obz: Float64Array
  readonly onx: Float64Array
  readonly onz: Float64Array
  readonly ocell: Int32Array
  readonly oflag: Uint8Array
  heightIn(c: number, x: number, z: number): number
  /** Largest outside distance over the cell's sides (<= 0: inside). */
  outside(c: number, x: number, z: number): number
}

/** What the builder reads from world.ts RtInstance (structural). */
export interface ReachInstance {
  readonly index: number
  readonly src: { readonly x: number; readonly y: number; readonly z: number }
  readonly cos: number
  readonly sin: number
  readonly model: ReachModel
  readonly linkTarget: Int32Array
  readonly linkEdge: Int32Array
}

export interface ReachSource {
  readonly regions: ReadonlyMap<number, NavRegion>
  readonly instances: readonly ReachInstance[]
  /**
   * Siege (docs/SIEGE.md §4.1): false for an instance the world has switched off (a wall third that is down): its
   * outline stops covering the terrain and its cells join nothing. Absent: every instance is on.
   */
  instanceEnabled?(index: number): boolean
  /** 0 open, 1 closed, 2 not loaded; global 20-unit tile index (the world's tile overrides included). */
  tileState(tx: number, tz: number): number
  terrainHeight(x: number, z: number): number
  /**
   * Diagnostics: called for every terrain link the builder derives ('union': both ways through an uncovered stretch,
   * 'out': one way across edges crossed from their inside, 'enter': into object cell node b), with the stretch.
   */
  trace?(kind: 'union' | 'out' | 'enter', a: number, b: number, ax: number, az: number, bx: number, bz: number): void
}

/** One walkable component (world file space; areas in m²). */
export interface NavComponent {
  /** Component id: 0 is the largest by area. */
  id: number
  /** Walkable area in m², XZ projection (stacked storeys count once each). */
  areaM2: number
  terrainAreaM2: number
  objectAreaM2: number
  /** Object navmesh cells in the component. */
  objectCells: number
  /** Terrain faces (tile pieces joined through uncut boundaries) in the component. */
  terrainFaces: number
  /** Distinct object instances with cells in the component. */
  instances: number
  /** XZ bounds (world file space). */
  minX: number
  minZ: number
  maxX: number
  maxZ: number
  /**
   * A walkable point of the component: the centre of its largest place, with that place's surface (instance -1:
   * terrain).
   */
  sample: { x: number; y: number; z: number; instance: number; cell: number }
  /** Components the walker moves into directly from this one / that move into this one directly. */
  exits: number
  entries: number
}

export interface NavReachStats {
  buildMs: number
  /** Typed-array bytes kept for queries. */
  bytes: number
  objectCells: number
  /** Open terrain tiles. */
  terrainTiles: number
  /** Open tiles cut by object edges. */
  cutTiles: number
  terrainPieces: number
  terrainFaces: number
  /** Directed place-to-place transitions. */
  transitions: number
  components: number
  /** Neighbour lookups inside cut tiles that needed the point-location fallback (numerical corner cases). */
  probeFallbacks: number
}

interface Poly {
  xs: number[]
  zs: number[]
  /** Per edge k (vertex k -> k + 1): the cutting line index (>= 0) or the tile side (S, E, N, W). */
  tags: number[]
}

interface Line {
  nx: number
  nz: number
  d: number
}

interface CutTile {
  tx: number
  tz: number
  first: number
  polys: Poly[]
  lines: Line[]
  segs: number[]
}

class UnionFind {
  readonly p: Int32Array
  constructor(n: number) {
    this.p = new Int32Array(n)
    for (let i = 0; i < n; i++) this.p[i] = i
  }
  find(a: number): number {
    const p = this.p
    while (p[a] !== a) {
      p[a] = p[p[a]!]!
      a = p[a]!
    }
    return a
  }
  union(a: number, b: number): void {
    a = this.find(a)
    b = this.find(b)
    if (a < b) this.p[b] = a
    else if (b < a) this.p[a] = b
  }
}

/** Growable int pair list. */
class Pairs {
  a = new Int32Array(1024)
  b = new Int32Array(1024)
  n = 0
  push(x: number, y: number): void {
    if (this.n === this.a.length) {
      const a = new Int32Array(this.n * 2), b = new Int32Array(this.n * 2)
      a.set(this.a)
      b.set(this.b)
      this.a = a
      this.b = b
    }
    this.a[this.n] = x
    this.b[this.n++] = y
  }
}

/** Terrain pieces: per open tile a whole-tile piece, or the convex pieces of a cut tile (tile-local polygons). */
class PieceIndex {
  readonly regionSlot = new Map<number, number>()
  /** Per region slot * 9216 + local tile: first piece, -1 when closed. */
  readonly tileFirst: Int32Array
  readonly tileCount: Uint16Array
  /** Per piece: polygon start in `coords` (vertex index), -1 for a whole uncut tile. */
  polyStart = new Int32Array(0)
  polyLen = new Uint16Array(0)
  /** Tile-local (x, z) polygon vertices, counter-clockwise. */
  coords = new Float64Array(0)

  constructor(regionIds: readonly number[]) {
    regionIds.forEach((id, i) => this.regionSlot.set(id, i))
    this.tileFirst = new Int32Array(regionIds.length * TPR).fill(-1)
    this.tileCount = new Uint16Array(regionIds.length * TPR)
  }

  get bytes(): number {
    return this.tileFirst.byteLength + this.tileCount.byteLength + this.polyStart.byteLength + this.polyLen.byteLength +
      this.coords.byteLength
  }

  tileIndex(tx: number, tz: number): number {
    const rx = Math.floor(tx / NVM_TILES), rz = Math.floor(tz / NVM_TILES)
    if (rx < 0 || rz < 0 || rx > 255 || rz > 127) return -1
    const slot = this.regionSlot.get((rz << 8) | rx)
    if (slot === undefined) return -1
    return slot * TPR + (tz - rz * NVM_TILES) * NVM_TILES + (tx - rx * NVM_TILES)
  }

  /** The piece containing (x, z) (the best fit near boundaries), or -1 on a closed / unloaded tile. */
  pieceAt(x: number, z: number): number {
    const tx = Math.floor(x / T), tz = Math.floor(z / T)
    const ti = this.tileIndex(tx, tz)
    if (ti < 0) return -1
    const first = this.tileFirst[ti]!
    const n = this.tileCount[ti]!
    if (first < 0 || n === 1) return first
    const u = x - tx * T, v = z - tz * T
    let best = first, bestOut = Infinity
    for (let i = first; i < first + n; i++) {
      const o = outside(this.coords, this.polyStart[i]!, this.polyLen[i]!, u, v)
      if (o < bestOut) {
        bestOut = o
        best = i
        if (o <= 0) break
      }
    }
    return best
  }

  /** Appends every piece the segment touches (world file space; only the parts on open tiles) to `out`. */
  onSegment(ax: number, az: number, bx: number, bz: number, out: number[]): void {
    const tx0 = Math.floor((Math.min(ax, bx) - TOUCH_EPS) / T), tx1 = Math.floor((Math.max(ax, bx) + TOUCH_EPS) / T)
    const tz0 = Math.floor((Math.min(az, bz) - TOUCH_EPS) / T), tz1 = Math.floor((Math.max(az, bz) + TOUCH_EPS) / T)
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const ti = this.tileIndex(tx, tz)
        if (ti < 0 || this.tileFirst[ti]! < 0) continue
        const u0 = ax - tx * T, v0 = az - tz * T, u1 = bx - tx * T, v1 = bz - tz * T
        // The walker tests terrainOpen() at the landing point, so only the part on this tile counts.
        if (!clipSegment(u0, v0, u1, v1, 0, T)) continue
        const first = this.tileFirst[ti]!
        for (let i = first; i < first + this.tileCount[ti]!; i++) {
          if (this.polyStart[i]! < 0 || segmentTouches(this.coords, this.polyStart[i]!, this.polyLen[i]!, u0, v0, u1, v1)) out.push(i)
        }
      }
    }
  }
}

/** Builds the place graph and its components (NavReach's constructor). */
class ReachBuilder {
  readonly insts: readonly ReachInstance[]
  readonly cellBase: Int32Array
  readonly C: number
  // Edge segments the terrain walker tests (world space), their inward normal and what entering does.
  sAX = new Float64Array(0)
  sAZ = new Float64Array(0)
  sBX = new Float64Array(0)
  sBZ = new Float64Array(0)
  sNX = new Float64Array(0)
  sNZ = new Float64Array(0)
  /** Object cell node entered by crossing the segment from outside, -1 when it blocks. */
  sEnter = new Int32Array(0)
  readonly tileSegs = new Map<number, number[]>()
  readonly regionIds: number[]
  readonly pieces: PieceIndex
  /** Per tile (PieceIndex indexing): index into cuts, or -1. */
  readonly tileCut: Int32Array
  readonly cuts: CutTile[] = []
  pieceArea: number[] = []
  pieceTx: number[] = []
  pieceTz: number[] = []
  terrainTiles = 0
  uf!: UnionFind
  /** Directed piece -> piece (crossing edges from their inside) and piece -> object cell node (entering). */
  readonly pp = new Pairs()
  readonly pc = new Pairs()
  probes = 0
  pieceNode!: Int32Array
  faces = 0
  readonly edges = new Pairs()
  // Scratch for cross().
  private on = new Int32Array(64)
  private onLo = new Float64Array(64)
  private onHi = new Float64Array(64)
  private brk = new Float64Array(130)
  private readonly sideA: number[] = []
  private readonly sideB: number[] = []
  private readonly landing: number[] = []

  constructor(readonly src: ReachSource) {
    this.insts = src.instances
    this.cellBase = new Int32Array(this.insts.length + 1)
    for (let i = 0; i < this.insts.length; i++) this.cellBase[i + 1] = this.cellBase[i]! + this.insts[i]!.model.n
    this.C = this.cellBase[this.insts.length]!
    this.regionIds = [...src.regions.keys()].sort((a, b) => a - b)
    this.pieces = new PieceIndex(this.regionIds)
    this.tileCut = new Int32Array(this.regionIds.length * TPR).fill(-1)
    this.segments()
    this.tiles()
    this.uf = new UnionFind(this.pieceArea.length)
    this.insideTiles()
    this.betweenTiles()
    this.makeFaces()
    this.transitions()
  }

  private static key(tx: number, tz: number): number {
    return tx * 16384 + tz
  }

  private segments(): void {
    const ax: number[] = [], az: number[] = [], bx: number[] = [], bz: number[] = [], nx: number[] = [], nz: number[] = []
    const enter: number[] = []
    for (const inst of this.insts) {
      if (this.src.instanceEnabled && !this.src.instanceEnabled(inst.index)) continue
      const m = inst.model
      const { cos, sin } = inst
      const base = this.cellBase[inst.index]!
      for (let e = 0; e < m.oflag.length; e++) {
        const flag = m.oflag[e]!
        if (flag & 16) continue
        const x0 = inst.src.x + cos * m.oax[e]! - sin * m.oaz[e]!
        const z0 = inst.src.z + sin * m.oax[e]! + cos * m.oaz[e]!
        const x1 = inst.src.x + cos * m.obx[e]! - sin * m.obz[e]!
        const z1 = inst.src.z + sin * m.obx[e]! + cos * m.obz[e]!
        if (Math.hypot(x1 - x0, z1 - z0) < LEN_EPS) continue
        // As terrainLeg: flag & 1 blocks; flag & 8 enters only when linked; otherwise enter the src cell if any.
        const cell = m.ocell[e]!
        const enters = !(flag & 1) && cell >= 0 && (!(flag & 8) || inst.linkTarget[e]! >= 0)
        const to = enters ? base + cell : -1
        ax.push(x0); az.push(z0); bx.push(x1); bz.push(z1)
        nx.push(cos * m.onx[e]! - sin * m.onz[e]!)
        nz.push(sin * m.onx[e]! + cos * m.onz[e]!)
        enter.push(to)
      }
    }
    this.sAX = Float64Array.from(ax); this.sAZ = Float64Array.from(az)
    this.sBX = Float64Array.from(bx); this.sBZ = Float64Array.from(bz)
    this.sNX = Float64Array.from(nx); this.sNZ = Float64Array.from(nz)
    this.sEnter = Int32Array.from(enter)
    // Per open tile: the segments touching its square (boundary included).
    for (let s = 0; s < ax.length; s++) {
      const x0 = ax[s]!, z0 = az[s]!, x1 = bx[s]!, z1 = bz[s]!
      const tx0 = Math.floor((Math.min(x0, x1) - COVER_TOL) / T), tx1 = Math.floor((Math.max(x0, x1) + COVER_TOL) / T)
      const tz0 = Math.floor((Math.min(z0, z1) - COVER_TOL) / T), tz1 = Math.floor((Math.max(z0, z1) + COVER_TOL) / T)
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (this.src.tileState(tx, tz) !== 0) continue
          const c = clipSegment(x0 - tx * T, z0 - tz * T, x1 - tx * T, z1 - tz * T, -COVER_TOL, T + COVER_TOL)
          if (!c || c[1] <= c[0]) continue
          const k = ReachBuilder.key(tx, tz)
          const list = this.tileSegs.get(k)
          if (list) list.push(s)
          else this.tileSegs.set(k, [s])
        }
      }
    }
  }

  private tiles(): void {
    const { pieces } = this
    const polyStart: number[] = [], polyLen: number[] = [], coords: number[] = []
    for (const id of this.regionIds) {
      const r = this.src.regions.get(id)!
      const slot = pieces.regionSlot.get(id)!
      for (let lz = 0; lz < NVM_TILES; lz++) {
        for (let lx = 0; lx < NVM_TILES; lx++) {
          const tx = r.rx * NVM_TILES + lx, tz = r.rz * NVM_TILES + lz
          // the world's tile state (its tile overrides included), not the raw cell
          if (this.src.tileState(tx, tz) !== 0) continue
          this.terrainTiles++
          const ti = slot * TPR + lz * NVM_TILES + lx
          const first = polyStart.length
          pieces.tileFirst[ti] = first
          const segs = this.tileSegs.get(ReachBuilder.key(tx, tz))
          if (!segs) {
            polyStart.push(-1)
            polyLen.push(0)
            this.pieceArea.push(T * T)
            this.pieceTx.push(tx)
            this.pieceTz.push(tz)
            pieces.tileCount[ti] = 1
            continue
          }
          const { polys, lines } = arrange(segs, tx * T, tz * T, this.sAX, this.sAZ, this.sBX, this.sBZ)
          for (const p of polys) {
            polyStart.push(coords.length / 2)
            polyLen.push(p.xs.length)
            let a = 0
            for (let k = 0; k < p.xs.length; k++) {
              const k1 = k + 1 === p.xs.length ? 0 : k + 1
              coords.push(p.xs[k]!, p.zs[k]!)
              a += p.xs[k]! * p.zs[k1]! - p.xs[k1]! * p.zs[k]!
            }
            this.pieceArea.push(Math.abs(a) / 2)
            this.pieceTx.push(tx)
            this.pieceTz.push(tz)
          }
          pieces.tileCount[ti] = polys.length
          this.tileCut[ti] = this.cuts.length
          this.cuts.push({ tx, tz, first, polys, lines, segs })
        }
      }
    }
    pieces.polyStart = Int32Array.from(polyStart)
    pieces.polyLen = Uint16Array.from(polyLen)
    pieces.coords = Float64Array.from(coords)
  }

  /**
   * Crossing a boundary stretch (ax, az) -> (bx, bz) (world) from piece X into piece Y, (ox, oz) the unit normal
   * pointing into Y. `c1`, `c2`: the segments that may cover it. Uncovered parts join X and Y; covered parts are one
   * way when every covering edge is crossed from its inside, else they enter or block.
   */
  private cross(X: number, Y: number, ax: number, az: number, bx: number, bz: number, ox: number, oz: number,
    c1: readonly number[], c2: readonly number[] | undefined): void {
    const dx = bx - ax, dz = bz - az
    const len2 = dx * dx + dz * dz
    if (len2 < LEN_EPS * LEN_EPS) return
    const len = Math.sqrt(len2)
    const need = c1.length + (c2 ? c2.length : 0)
    if (need > this.on.length) {
      this.on = new Int32Array(need * 2)
      this.onLo = new Float64Array(need * 2)
      this.onHi = new Float64Array(need * 2)
      this.brk = new Float64Array(need * 4 + 2)
    }
    const { sAX, sAZ, sBX, sBZ, on, onLo, onHi, brk } = this
    let nOn = 0
    let nBrk = 0
    brk[nBrk++] = 0
    brk[nBrk++] = 1
    for (let pass = 0; pass < 2; pass++) {
      const cands = pass === 0 ? c1 : c2
      if (!cands) continue
      for (let ci = 0; ci < cands.length; ci++) {
        const s = cands[ci]!
        // Covering: overlapping the stretch, within COVER_TOL of its line over the overlap.
        const u0 = ((sAX[s]! - ax) * dx + (sAZ[s]! - az) * dz) / len2
        const u1 = ((sBX[s]! - ax) * dx + (sBZ[s]! - az) * dz) / len2
        if (Math.abs(u1 - u0) * len < LEN_EPS) continue
        const lo = Math.max(Math.min(u0, u1) - CORNER_EPS / len, 0), hi = Math.min(Math.max(u0, u1) + CORNER_EPS / len, 1)
        if ((hi - lo) * len < LEN_EPS) continue
        const d0 = ((sAX[s]! - ax) * dz - (sAZ[s]! - az) * dx) / len
        const d1 = ((sBX[s]! - ax) * dz - (sBZ[s]! - az) * dx) / len
        const dLo = d0 + ((d1 - d0) * (lo - u0)) / (u1 - u0)
        const dHi = d0 + ((d1 - d0) * (hi - u0)) / (u1 - u0)
        if (Math.abs(dLo) > COVER_TOL || Math.abs(dHi) > COVER_TOL) continue
        let dup = false
        for (let j = 0; j < nOn; j++) if (on[j] === s) dup = true
        if (dup) continue
        on[nOn] = s
        onLo[nOn] = lo
        onHi[nOn++] = hi
        if (lo > 0) brk[nBrk++] = lo
        if (hi < 1) brk[nBrk++] = hi
      }
    }
    if (nOn === 0) {
      this.src.trace?.('union', X, Y, ax, az, bx, bz)
      this.uf.union(X, Y)
      return
    }
    const cuts = brk.subarray(0, nBrk).sort()
    for (let i = 0; i + 1 < nBrk; i++) {
      const u0 = cuts[i]!, u1 = cuts[i + 1]!
      if ((u1 - u0) * len < LEN_EPS) continue
      const um = (u0 + u1) / 2
      let covered = false
      let entering = false
      for (let j = 0; j < nOn; j++) {
        if (um < onLo[j]! || um > onHi[j]!) continue
        const s = on[j]!
        covered = true
        if (this.sNX[s]! * ox + this.sNZ[s]! * oz > 0) {
          entering = true
          if (this.sEnter[s]! >= 0) {
            this.src.trace?.('enter', X, this.sEnter[s]!, ax + dx * u0, az + dz * u0, ax + dx * u1, az + dz * u1)
            this.pc.push(X, this.sEnter[s]!)
          }
        }
      }
      if (!covered) {
        this.src.trace?.('union', X, Y, ax + dx * u0, az + dz * u0, ax + dx * u1, az + dz * u1)
        this.uf.union(X, Y)
      } else if (!entering) {
        this.src.trace?.('out', X, Y, ax + dx * u0, az + dz * u0, ax + dx * u1, az + dz * u1)
        this.pp.push(X, Y)
      }
    }
  }

  /** Inside cut tiles: each piece against its neighbour across each cutting line (differing only in that line). */
  private insideTiles(): void {
    for (const t of this.cuts) {
      const X0 = t.tx * T, Z0 = t.tz * T
      const bySig = new Map<string, number>()
      const sigs: string[] = []
      for (let i = 0; i < t.polys.length; i++) {
        const sig = signature(t.polys[i]!, t.lines)
        sigs.push(sig)
        bySig.set(sig, i)
      }
      for (let i = 0; i < t.polys.length; i++) {
        const p = t.polys[i]!
        const n = p.xs.length
        for (let k = 0; k < n; k++) {
          const tag = p.tags[k]!
          if (tag < 0) continue
          const k1 = k + 1 === n ? 0 : k + 1
          const ax = p.xs[k]!, az = p.zs[k]!, bx = p.xs[k1]!, bz = p.zs[k1]!
          const l = Math.hypot(bx - ax, bz - az)
          if (l < LEN_EPS) continue
          const sig = sigs[i]!
          let j = bySig.get(sig.slice(0, tag) + (sig[tag] === '1' ? '0' : '1') + sig.slice(tag + 1))
          if (j === undefined) {
            // Numerical fallback: the piece just across the edge's midpoint.
            this.probes++
            const u = (ax + bx) / 2 + ((bz - az) / l) * 1e-5, v = (az + bz) / 2 - ((bx - ax) / l) * 1e-5
            const q = this.pieces.pieceAt(X0 + u, Z0 + v) - t.first
            if (q < 0 || q === i || q >= t.polys.length) continue
            j = q
          }
          // Counter-clockwise in (x, z): the outward normal is (dz, -dx) / l.
          this.cross(t.first + i, t.first + j, X0 + ax, Z0 + az, X0 + bx, Z0 + bz, (bz - az) / l, -(bx - ax) / l, t.segs, undefined)
        }
      }
    }
  }

  /** Appends (piece, lo, hi) per stretch of the tile's side `side` (along x for S/N, z for E/W; tile-local). */
  private sideStretches(ti: number, side: number, out: number[]): void {
    out.length = 0
    const c = this.tileCut[ti]!
    if (c < 0) {
      out.push(this.pieces.tileFirst[ti]!, 0, T)
      return
    }
    const t = this.cuts[c]!
    for (let i = 0; i < t.polys.length; i++) {
      const p = t.polys[i]!
      const n = p.xs.length
      for (let k = 0; k < n; k++) {
        if (p.tags[k] !== side) continue
        const k1 = k + 1 === n ? 0 : k + 1
        const a = side === S || side === N ? p.xs[k]! : p.zs[k]!
        const b = side === S || side === N ? p.xs[k1]! : p.zs[k1]!
        if (Math.abs(b - a) >= LEN_EPS) out.push(t.first + i, Math.min(a, b), Math.max(a, b))
      }
    }
  }

  /** Between 4-adjacent open tiles: the pieces along the shared side, both ways. */
  private betweenTiles(): void {
    const { pieces, sideA, sideB } = this
    for (const id of this.regionIds) {
      const r = this.src.regions.get(id)!
      for (let lz = 0; lz < NVM_TILES; lz++) {
        for (let lx = 0; lx < NVM_TILES; lx++) {
          const tx = r.rx * NVM_TILES + lx, tz = r.rz * NVM_TILES + lz
          const ti = pieces.tileIndex(tx, tz)
          if (pieces.tileFirst[ti]! < 0) continue
          for (let dir = 0; dir < 2; dir++) {
            const dx = dir === 0 ? 1 : 0, dz = 1 - dx
            const tj = pieces.tileIndex(tx + dx, tz + dz)
            if (tj < 0 || pieces.tileFirst[tj]! < 0) continue
            if (this.tileCut[ti]! < 0 && this.tileCut[tj]! < 0) {
              this.uf.union(pieces.tileFirst[ti]!, pieces.tileFirst[tj]!)
              continue
            }
            this.sideStretches(ti, dx ? E : N, sideA)
            this.sideStretches(tj, dx ? W : S, sideB)
            const c1 = this.tileSegs.get(ReachBuilder.key(tx, tz)) ?? [], c2 = this.tileSegs.get(ReachBuilder.key(tx + dx, tz + dz))
            const X0 = tx * T, Z0 = tz * T
            for (let a = 0; a < sideA.length; a += 3) {
              for (let b = 0; b < sideB.length; b += 3) {
                const lo = Math.max(sideA[a + 1]!, sideB[b + 1]!), hi = Math.min(sideA[a + 2]!, sideB[b + 2]!)
                if (hi - lo < SIDE_EPS) continue
                const pa = sideA[a]!, pb = sideB[b]!
                if (dx) {
                  this.cross(pa, pb, X0 + T, Z0 + lo, X0 + T, Z0 + hi, 1, 0, c1, c2)
                  this.cross(pb, pa, X0 + T, Z0 + lo, X0 + T, Z0 + hi, -1, 0, c1, c2)
                } else {
                  this.cross(pa, pb, X0 + lo, Z0 + T, X0 + hi, Z0 + T, 0, 1, c1, c2)
                  this.cross(pb, pa, X0 + lo, Z0 + T, X0 + hi, Z0 + T, 0, -1, c1, c2)
                }
              }
            }
          }
        }
      }
    }
  }

  /**
   * Whether a terrain piece lies inside one of the instance's cells, all of it (so every landing point on it is
   * refused). Pieces never straddle the instance's own non-16 outline edges, so testing its vertices suffices.
   */
  private pieceInside(inst: ReachInstance, piece: number): boolean {
    if (inst.model.oflag.some(f => (f & 16) !== 0)) return false // may straddle an edge the terrain ignores
    const P = this.pieces
    const st = P.polyStart[piece]!
    const X0 = this.pieceTx[piece]! * T, Z0 = this.pieceTz[piece]! * T
    const n = st < 0 ? 4 : P.polyLen[piece]!
    let cx = 0, cz = 0
    for (let v = 0; v <= n; v++) {
      // Every vertex, then the centroid: each must lie in some cell (not necessarily the same one).
      let x: number, z: number
      if (v < n) {
        x = X0 + (st < 0 ? (v === 1 || v === 2 ? T : 0) : P.coords[(st + v) * 2]!)
        z = Z0 + (st < 0 ? (v >= 2 ? T : 0) : P.coords[(st + v) * 2 + 1]!)
        cx += x / n
        cz += z / n
      } else {
        x = cx
        z = cz
      }
      if (!this.inCells(inst, x, z)) return false
    }
    return true
  }

  private inCells(inst: ReachInstance, x: number, z: number): boolean {
    const m = inst.model
    const lx = inst.cos * (x - inst.src.x) + inst.sin * (z - inst.src.z)
    const lz = -inst.sin * (x - inst.src.x) + inst.cos * (z - inst.src.z)
    for (let c = 0; c < m.n; c++) if (m.outside(c, lx, lz) <= 1e-7) return true
    return false
  }

  /** One node per union-find class of pieces (a terrain face), after the C object cell nodes. */
  private makeFaces(): void {
    const P = this.pieceArea.length
    this.pieceNode = new Int32Array(P)
    const rootNode = new Int32Array(P).fill(-1)
    for (let i = 0; i < P; i++) {
      const r = this.uf.find(i)
      if (rootNode[r] === -1) rootNode[r] = this.C + this.faces++
      this.pieceNode[i] = rootNode[r]!
    }
  }

  private transitions(): void {
    const { edges, pieceNode, landing } = this
    for (let i = 0; i < this.pp.n; i++) {
      const a = pieceNode[this.pp.a[i]!]!, b = pieceNode[this.pp.b[i]!]!
      if (a !== b) edges.push(a, b)
    }
    for (let i = 0; i < this.pc.n; i++) edges.push(pieceNode[this.pc.a[i]!]!, this.pc.b[i]!)
    for (const inst of this.insts) {
      if (this.src.instanceEnabled && !this.src.instanceEnabled(inst.index)) continue
      const m = inst.model
      const base = this.cellBase[inst.index]!
      for (let s = 0; s < m.n * 3; s++) {
        const c = (s - (s % 3)) / 3
        const across = m.across[s]!
        if (across >= 0) {
          if (!m.sideBlocked[s]) edges.push(base + c, base + across)
          continue
        }
        if (across !== -1) continue
        const e = m.sideEdge[s]!
        const flag = m.oflag[e]!
        if (flag === 0) {
          // Exit: lands EXIT_OFFSET outside the side, anywhere along it (lengthened a hair for float noise).
          const i0 = m.tri[s]!, i1 = m.tri[s % 3 === 2 ? s - 2 : s + 1]!
          const nx = inst.cos * m.snx[s]! - inst.sin * m.snz[s]!
          const nz = inst.sin * m.snx[s]! + inst.cos * m.snz[s]!
          let ax = inst.src.x + inst.cos * m.vx[i0]! - inst.sin * m.vz[i0]! + nx * EXIT_OFFSET
          let az = inst.src.z + inst.sin * m.vx[i0]! + inst.cos * m.vz[i0]! + nz * EXIT_OFFSET
          let bx = inst.src.x + inst.cos * m.vx[i1]! - inst.sin * m.vz[i1]! + nx * EXIT_OFFSET
          let bz = inst.src.z + inst.sin * m.vx[i1]! + inst.cos * m.vz[i1]! + nz * EXIT_OFFSET
          const l = Math.hypot(bx - ax, bz - az) || 1
          const ex = ((bx - ax) / l) * TOUCH_EPS, ez = ((bz - az) / l) * TOUCH_EPS
          ax -= ex; az -= ez; bx += ex; bz += ez
          landing.length = 0
          this.pieces.onSegment(ax, az, bx, bz, landing)
          let last = -1
          for (const piece of landing) {
            // The walker refuses an exit landing inside the exiting object's own footprint (world.ts insideFootprint).
            if (this.pieceInside(inst, piece)) continue
            const node = pieceNode[piece]!
            if (node !== last) edges.push(base + c, node)
            last = node
          }
        } else if (flag & 8 && inst.linkTarget[e]! >= 0) {
          const target = this.insts[inst.linkTarget[e]!]!
          const te = inst.linkEdge[e]!
          const tc = te < target.model.ocell.length ? target.model.ocell[te]! : -1
          if (tc >= 0) edges.push(base + c, this.cellBase[target.index]! + tc)
        }
      }
    }
  }
}

export class NavReach {
  readonly stats: NavReachStats
  /** Components, largest first (index = id). */
  readonly list: NavComponent[]
  /** Per instance: node id of its cell 0. Nodes: object cells first, then terrain faces. */
  private readonly cellBase: Int32Array
  private readonly pieces: PieceIndex
  /** Per piece: its face node. */
  private readonly pieceNode: Int32Array
  /** Per node: component id. */
  private readonly nodeComp: Int32Array
  /** The condensation (component -> components it moves into directly). */
  private readonly dagStart: Int32Array
  private readonly dagList: Int32Array
  /** The place graph (node -> nodes), kept for diagnostics. */
  private readonly graphStart: Int32Array
  private readonly graphList: Int32Array

  constructor(src: ReachSource) {
    const t0 = performance.now()
    const b = new ReachBuilder(src)
    const insts = src.instances
    const { C, pieceNode, pieceArea, pieceTx, pieceTz, pieces } = b
    this.cellBase = b.cellBase
    this.pieces = pieces
    this.pieceNode = pieceNode
    const nodes = C + b.faces
    const P = pieceArea.length

    const g = csr(nodes, b.edges)
    this.graphStart = g.start
    this.graphList = g.list
    const { comp: raw, count } = tarjan(nodes, g.start, g.list)

    // Areas, bounds, sizes, sample places.
    const area = new Float64Array(count), terrainArea = new Float64Array(count)
    const minX = new Float64Array(count).fill(Infinity), minZ = new Float64Array(count).fill(Infinity)
    const maxX = new Float64Array(count).fill(-Infinity), maxZ = new Float64Array(count).fill(-Infinity)
    const cells = new Int32Array(count), faces = new Int32Array(count), instCount = new Int32Array(count)
    const instStamp = new Int32Array(count).fill(-1)
    const bestCell = new Int32Array(count).fill(-1), bestCellArea = new Float64Array(count).fill(-1)
    const bestPiece = new Int32Array(count).fill(-1), bestPieceArea = new Float64Array(count).fill(-1)
    for (const inst of insts) {
      const m = inst.model
      const base = this.cellBase[inst.index]!
      for (let c = 0; c < m.n; c++) {
        const k = raw[base + c]!
        let a = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
        let px = 0, pz = 0, qx = 0, qz = 0
        for (let v = 0; v < 3; v++) {
          const vi = m.tri[c * 3 + v]!
          const wx = inst.src.x + inst.cos * m.vx[vi]! - inst.sin * m.vz[vi]!
          const wz = inst.src.z + inst.sin * m.vx[vi]! + inst.cos * m.vz[vi]!
          if (v === 0) { px = wx; pz = wz } else if (v === 1) { qx = wx; qz = wz } else a = Math.abs((qx - px) * (wz - pz) - (wx - px) * (qz - pz)) / 2
          if (wx < x0) x0 = wx
          if (wx > x1) x1 = wx
          if (wz < z0) z0 = wz
          if (wz > z1) z1 = wz
        }
        area[k]! += a
        if (x0 < minX[k]!) minX[k] = x0
        if (z0 < minZ[k]!) minZ[k] = z0
        if (x1 > maxX[k]!) maxX[k] = x1
        if (z1 > maxZ[k]!) maxZ[k] = z1
        cells[k]!++
        if (instStamp[k] !== inst.index) {
          instStamp[k] = inst.index
          instCount[k]!++
        }
        if (a > bestCellArea[k]!) {
          bestCellArea[k] = a
          bestCell[k] = base + c
        }
      }
    }
    for (let i = 0; i < P; i++) {
      const k = raw[pieceNode[i]!]!
      area[k]! += pieceArea[i]!
      terrainArea[k]! += pieceArea[i]!
      const X0 = pieceTx[i]! * T, Z0 = pieceTz[i]! * T
      const st = pieces.polyStart[i]!
      let x0 = X0, z0 = Z0, x1 = X0 + T, z1 = Z0 + T
      if (st >= 0) {
        x0 = z0 = Infinity
        x1 = z1 = -Infinity
        for (let v = 0; v < pieces.polyLen[i]!; v++) {
          const x = X0 + pieces.coords[(st + v) * 2]!, z = Z0 + pieces.coords[(st + v) * 2 + 1]!
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (z < z0) z0 = z
          if (z > z1) z1 = z
        }
      }
      if (x0 < minX[k]!) minX[k] = x0
      if (z0 < minZ[k]!) minZ[k] = z0
      if (x1 > maxX[k]!) maxX[k] = x1
      if (z1 > maxZ[k]!) maxZ[k] = z1
      if (pieceArea[i]! > bestPieceArea[k]!) {
        bestPieceArea[k] = pieceArea[i]!
        bestPiece[k] = i
      }
    }
    for (let v = C; v < nodes; v++) faces[raw[v]!]!++

    // Ids by area, largest first (ties: Tarjan order).
    const order = Array.from({ length: count }, (_, k) => k).sort((x, y) => area[y]! - area[x]! || x - y)
    const renum = new Int32Array(count)
    order.forEach((k, id) => (renum[k] = id))
    this.nodeComp = new Int32Array(nodes)
    for (let v = 0; v < nodes; v++) this.nodeComp[v] = renum[raw[v]!]!

    // Condensation, deduplicated.
    const dag = new Pairs()
    const seen = new Set<number>()
    for (let v = 0; v < nodes; v++) {
      const a = this.nodeComp[v]!
      for (let i = g.start[v]!; i < g.start[v + 1]!; i++) {
        const t = this.nodeComp[g.list[i]!]!
        if (t === a || seen.has(a * count + t)) continue
        seen.add(a * count + t)
        dag.push(a, t)
      }
    }
    const d = csr(count, dag)
    this.dagStart = d.start
    this.dagList = d.list
    const entries = new Int32Array(count)
    for (let i = 0; i < dag.n; i++) entries[dag.b[i]!]!++

    this.list = order.map((k, id): NavComponent => {
      let sample: NavComponent['sample']
      // The largest place: an object cell, or a terrain piece (whose centroid lies inside it).
      if (bestCell[k]! >= 0 && bestCellArea[k]! >= bestPieceArea[k]!) {
        const node = bestCell[k]!
        let ii = 0
        while (this.cellBase[ii + 1]! <= node) ii++
        const inst = insts[ii]!, m = inst.model, c = node - this.cellBase[ii]!
        const lx = m.cx[c]!, lz = m.cz[c]!
        sample = {
          x: inst.src.x + inst.cos * lx - inst.sin * lz,
          y: inst.src.y + m.heightIn(c, lx, lz),
          z: inst.src.z + inst.sin * lx + inst.cos * lz,
          instance: ii,
          cell: c,
        }
      } else {
        const i = bestPiece[k]!
        const st = pieces.polyStart[i]!
        const X0 = pieceTx[i]! * T, Z0 = pieceTz[i]! * T
        let [u, v] = st < 0 ? [T / 2, T / 2] : centroid(pieces.coords, st, pieces.polyLen[i]!)
        if (st >= 0 && pieces.pieceAt(X0 + u, Z0 + v) !== i) {
          // A hairline piece: its centroid may classify into a neighbour; try points between it and each vertex.
          const n = pieces.polyLen[i]!
          for (let t = 0; t < n * 4; t++) {
            const f = [0.5, 0.25, 0.75, 0.9][t % 4]!, vi = (st + Math.floor(t / 4)) * 2
            const pu = u + (pieces.coords[vi]! - u) * f, pv = v + (pieces.coords[vi + 1]! - v) * f
            if (pieces.pieceAt(X0 + pu, Z0 + pv) === i) {
              u = pu
              v = pv
              break
            }
          }
        }
        const x = X0 + u, z = Z0 + v
        sample = { x, y: src.terrainHeight(x, z), z, instance: -1, cell: -1 }
      }
      return {
        id,
        areaM2: area[k]! / 100,
        terrainAreaM2: terrainArea[k]! / 100,
        objectAreaM2: (area[k]! - terrainArea[k]!) / 100,
        objectCells: cells[k]!,
        terrainFaces: faces[k]!,
        instances: instCount[k]!,
        minX: minX[k]!,
        minZ: minZ[k]!,
        maxX: maxX[k]!,
        maxZ: maxZ[k]!,
        sample,
        exits: this.dagStart[id + 1]! - this.dagStart[id]!,
        entries: entries[id]!,
      }
    })

    this.stats = {
      buildMs: performance.now() - t0,
      bytes: this.cellBase.byteLength + pieces.bytes + this.pieceNode.byteLength + this.nodeComp.byteLength +
        this.dagStart.byteLength + this.dagList.byteLength + this.graphStart.byteLength + this.graphList.byteLength,
      objectCells: C,
      terrainTiles: b.terrainTiles,
      cutTiles: b.cuts.length,
      terrainPieces: P,
      terrainFaces: b.faces,
      transitions: b.edges.n,
      components: count,
      probeFallbacks: b.probes,
    }
  }

  /** Diagnostics: the terrain piece at (x, z) (the ids trace() reports), or -1. */
  pieceAt(x: number, z: number): number {
    return this.pieces.pieceAt(x, z)
  }

  /** Diagnostics: the graph node of an object cell (the ids trace() reports for 'enter'), or -1. */
  cellNode(instance: number, cell: number): number {
    if (!(instance >= 0 && instance + 1 < this.cellBase.length && cell >= 0)) return -1
    const node = this.cellBase[instance]! + cell
    return node < this.cellBase[instance + 1]! ? node : -1
  }

  /** Component of an object cell, or -1. */
  cellComponent(instance: number, cell: number): number {
    if (!(instance >= 0 && instance + 1 < this.cellBase.length && cell >= 0)) return -1
    const node = this.cellBase[instance]! + cell
    return node < this.cellBase[instance + 1]! ? this.nodeComp[node]! : -1
  }

  /** Component of the terrain at (x, z), or -1 on a closed / unloaded tile. */
  terrainComponent(x: number, z: number): number {
    const piece = this.pieces.pieceAt(x, z)
    return piece < 0 ? -1 : this.nodeComp[this.pieceNode[piece]!]!
  }

  /** Whether the walker can get from component `from` into component `to` (one or more moves). */
  reaches(from: number, to: number): boolean {
    const n = this.list.length
    if (!(from >= 0 && to >= 0 && from < n && to < n)) return false
    if (from === to) return true
    const seen = new Uint8Array(n)
    const stack = [from]
    seen[from] = 1
    while (stack.length) {
      const k = stack.pop()!
      for (let i = this.dagStart[k]!; i < this.dagStart[k + 1]!; i++) {
        const t = this.dagList[i]!
        if (t === to) return true
        if (!seen[t]) {
          seen[t] = 1
          stack.push(t)
        }
      }
    }
    return false
  }

  /** Components the walker moves into directly from `id`. */
  exitsOf(id: number): number[] {
    if (!(id >= 0 && id < this.list.length)) return []
    return Array.from(this.dagList.subarray(this.dagStart[id]!, this.dagStart[id + 1]!))
  }
}

/**
 * Splits the tile square [0, T]² (tile-local) by the lines of its segments. Segments on a tile side (within
 * COVER_TOL) do not cut; segments within DEDUPE_TOL of an earlier line inside the tile reuse it.
 */
function arrange(segs: readonly number[], X0: number, Z0: number, sAX: Float64Array, sAZ: Float64Array, sBX: Float64Array,
  sBZ: Float64Array): { polys: Poly[]; lines: Line[] } {
  let polys: Poly[] = [{ xs: [0, T, T, 0], zs: [0, 0, T, T], tags: [S, E, N, W] }]
  const lines: Line[] = []
  for (const s of segs) {
    const ax = sAX[s]! - X0, az = sAZ[s]! - Z0, dx = sBX[s]! - sAX[s]!, dz = sBZ[s]! - sAZ[s]!
    const c = clipSegment(ax, az, ax + dx, az + dz, -COVER_TOL, T + COVER_TOL)!
    const px = ax + dx * c[0], pz = az + dz * c[0], qx = ax + dx * c[1], qz = az + dz * c[1]
    if ((Math.abs(pz) <= COVER_TOL && Math.abs(qz) <= COVER_TOL) || (Math.abs(pz - T) <= COVER_TOL && Math.abs(qz - T) <= COVER_TOL) ||
      (Math.abs(px) <= COVER_TOL && Math.abs(qx) <= COVER_TOL) || (Math.abs(px - T) <= COVER_TOL && Math.abs(qx - T) <= COVER_TOL)) continue
    let same = false
    for (const l of lines) {
      if (Math.abs(l.nx * px + l.nz * pz - l.d) <= DEDUPE_TOL && Math.abs(l.nx * qx + l.nz * qz - l.d) <= DEDUPE_TOL) {
        same = true
        break
      }
    }
    if (same) continue
    const len = Math.hypot(dx, dz)
    const nx = -dz / len, nz = dx / len
    const d = nx * ax + nz * az
    const tag = lines.length
    lines.push({ nx, nz, d })
    const next: Poly[] = []
    for (const p of polys) {
      if (!splitPoly(p, nx, nz, d, tag, next)) next.push(p)
    }
    polys = next
  }
  return { polys, lines }
}

/** Splits convex p by the line (both parts appended to `out`); false when the line does not cross it. */
function splitPoly(p: Poly, nx: number, nz: number, d: number, tag: number, out: Poly[]): boolean {
  const n = p.xs.length
  const s: number[] = new Array(n)
  let hi = false, lo = false
  for (let k = 0; k < n; k++) {
    const v = nx * p.xs[k]! + nz * p.zs[k]! - d
    s[k] = v
    if (v > SPLIT_TOL) hi = true
    else if (v < -SPLIT_TOL) lo = true
  }
  if (!hi || !lo) return false
  out.push(clipSide(p, s, 1, tag), clipSide(p, s, -1, tag))
  return true
}

/** The part of convex p on side `sign` of a line (s: signed distance per vertex); the cut edge gets `tag`. */
function clipSide(p: Poly, s: number[], sign: number, tag: number): Poly {
  const out: Poly = { xs: [], zs: [], tags: [] }
  const n = p.xs.length
  for (let k = 0; k < n; k++) {
    const k1 = k + 1 === n ? 0 : k + 1
    const vp = s[k]! * sign, vq = s[k1]! * sign
    const cp = vp > SPLIT_TOL ? 1 : vp < -SPLIT_TOL ? -1 : 0
    const cq = vq > SPLIT_TOL ? 1 : vq < -SPLIT_TOL ? -1 : 0
    if (cp >= 0) {
      out.xs.push(p.xs[k]!)
      out.zs.push(p.zs[k]!)
      // An on-line vertex followed by the other side starts the cut edge.
      out.tags.push(cp === 0 && cq < 0 ? tag : p.tags[k]!)
    }
    if ((cp > 0 && cq < 0) || (cp < 0 && cq > 0)) {
      const f = s[k]! / (s[k]! - s[k1]!)
      out.xs.push(p.xs[k]! + (p.xs[k1]! - p.xs[k]!) * f)
      out.zs.push(p.zs[k]! + (p.zs[k1]! - p.zs[k]!) * f)
      // Leaving the side: the cut edge follows; entering it: the rest of the original edge.
      out.tags.push(cp > 0 ? tag : p.tags[k]!)
    }
  }
  return out
}

/** Side of each line of the tile ('1' positive) at the piece's vertex centroid. */
function signature(p: Poly, lines: readonly Line[]): string {
  let cx = 0, cz = 0
  for (let k = 0; k < p.xs.length; k++) {
    cx += p.xs[k]!
    cz += p.zs[k]!
  }
  cx /= p.xs.length
  cz /= p.xs.length
  let sig = ''
  for (const l of lines) sig += l.nx * cx + l.nz * cz - l.d > 0 ? '1' : '0'
  return sig
}

/** Liang-Barsky: the parameter range of segment a -> b inside [lo, hi]², or null. */
function clipSegment(ax: number, az: number, bx: number, bz: number, lo: number, hi: number): [number, number] | null {
  let t0 = 0, t1 = 1
  const dx = bx - ax, dz = bz - az
  for (let i = 0; i < 4; i++) {
    const p = i === 0 ? -dx : i === 1 ? dx : i === 2 ? -dz : dz
    const q = i === 0 ? ax - lo : i === 1 ? hi - ax : i === 2 ? az - lo : hi - az
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  return [t0, t1]
}

/** Largest outside distance of (u, v) over the edges of a counter-clockwise convex polygon (<= 0: inside). */
function outside(coords: Float64Array, start: number, n: number, u: number, v: number): number {
  let worst = -Infinity
  for (let k = 0; k < n; k++) {
    const k1 = k + 1 === n ? 0 : k + 1
    const ax = coords[(start + k) * 2]!, az = coords[(start + k) * 2 + 1]!
    const bx = coords[(start + k1) * 2]!, bz = coords[(start + k1) * 2 + 1]!
    const l = Math.hypot(bx - ax, bz - az)
    if (l < LEN_EPS) continue
    const o = ((u - ax) * (bz - az) - (v - az) * (bx - ax)) / l
    if (o > worst) worst = o
  }
  return worst
}

/** Whether segment (u0, v0) -> (u1, v1) comes within TOUCH_EPS of a counter-clockwise convex polygon. */
function segmentTouches(coords: Float64Array, start: number, n: number, u0: number, v0: number, u1: number, v1: number): boolean {
  let t0 = 0, t1 = 1
  const du = u1 - u0, dv = v1 - v0
  for (let k = 0; k < n; k++) {
    const k1 = k + 1 === n ? 0 : k + 1
    const ax = coords[(start + k) * 2]!, az = coords[(start + k) * 2 + 1]!
    const bx = coords[(start + k1) * 2]!, bz = coords[(start + k1) * 2 + 1]!
    const l = Math.hypot(bx - ax, bz - az)
    if (l < LEN_EPS) continue
    // Outside distance along the segment: o(t) = o0 + t od, kept <= 0 (TOUCH_EPS already subtracted).
    const o0 = ((u0 - ax) * (bz - az) - (v0 - az) * (bx - ax)) / l - TOUCH_EPS
    const od = (du * (bz - az) - dv * (bx - ax)) / l
    if (Math.abs(od) < 1e-15) {
      if (o0 > 0) return false
      continue
    }
    const t = -o0 / od
    if (od > 0) t1 = Math.min(t1, t)
    else t0 = Math.max(t0, t)
    if (t0 > t1) return false
  }
  return true
}

function centroid(coords: Float64Array, start: number, n: number): [number, number] {
  let a = 0, x = 0, z = 0
  for (let k = 0; k < n; k++) {
    const k1 = k + 1 === n ? 0 : k + 1
    const x0 = coords[(start + k) * 2]!, z0 = coords[(start + k) * 2 + 1]!
    const x1 = coords[(start + k1) * 2]!, z1 = coords[(start + k1) * 2 + 1]!
    const c = x0 * z1 - x1 * z0
    a += c
    x += (x0 + x1) * c
    z += (z0 + z1) * c
  }
  if (Math.abs(a) < 1e-12) return [coords[start * 2]!, coords[start * 2 + 1]!]
  return [x / (3 * a), z / (3 * a)]
}

function csr(n: number, e: Pairs): { start: Int32Array; list: Int32Array } {
  const start = new Int32Array(n + 1)
  for (let i = 0; i < e.n; i++) start[e.a[i]! + 1]!++
  for (let i = 0; i < n; i++) start[i + 1]! += start[i]!
  const fill = start.slice(0, n)
  const list = new Int32Array(e.n)
  for (let i = 0; i < e.n; i++) list[fill[e.a[i]!]!++] = e.b[i]!
  return { start, list }
}

/** Iterative Tarjan: strongly connected component per node. */
function tarjan(n: number, start: Int32Array, list: Int32Array): { comp: Int32Array; count: number } {
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const comp = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  const callNode = new Int32Array(n)
  const callEdge = new Int32Array(n)
  let sp = 0, next = 0, count = 0
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue
    let top = 0
    callNode[0] = root
    callEdge[0] = start[root]!
    index[root] = low[root] = next++
    stack[sp++] = root
    while (top >= 0) {
      const v = callNode[top]!
      if (callEdge[top]! < start[v + 1]!) {
        const w = list[callEdge[top]!++]!
        if (index[w] === -1) {
          index[w] = low[w] = next++
          stack[sp++] = w
          callNode[++top] = w
          callEdge[top] = start[w]!
        } else if (comp[w] === -1 && index[w]! < low[v]!) {
          low[v] = index[w]!
        }
      } else {
        if (low[v] === index[v]) {
          let w: number
          do {
            w = stack[--sp]!
            comp[w] = count
          } while (w !== v)
          count++
        }
        top--
        if (top >= 0) {
          const u = callNode[top]!
          if (low[v]! < low[u]!) low[u] = low[v]!
        }
      }
    }
  }
  return { comp, count }
}
