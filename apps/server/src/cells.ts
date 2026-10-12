import type { Vec3 } from '@sro/shared'
import { REGION_SIZE_M } from './content.ts'
import type { Player } from './world.ts'

/**
 * World cells (docs/SERVER_ARCHITECTURE.md §3.4): the uniform grid the server's spatial indexes use. A cell is one
 * navmesh region (REGION_SIZE_M = 192 m, laid out as content.ts regionAt: x / 192 and -z / 192), the unit a future zone
 * worker owns, so an index built on it today is the one a zone keeps.
 */
export const CELL_M = REGION_SIZE_M

/** Cell column/row of a point (regionAt's axes, without the export's origin offset). */
export function cellX(x: number, size = CELL_M): number {
  return Math.floor(x / size)
}
export function cellZ(z: number, size = CELL_M): number {
  // + 0: z = 0 is row 0, not -0
  return Math.floor(-z / size) + 0
}

/** One number per cell (cells within +-2^20 of the origin: +-200,000 km at 192 m). */
export function cellKey(cx: number, cz: number): number {
  return (cx + 0x100000) * 0x200000 + (cz + 0x100000)
}

/**
 * Monster scans (docs/SERVER_ARCHITECTURE.md F1, P0): candidates are taken from the cells within this much more than
 * the asked range (by the positions of the pass's start), then checked exactly on the live positions. It covers the
 * centimetres a move restarted mid-pass can differ by; teleports rebuild the grid (World.warp, add, remove).
 */
export const SCAN_MARGIN_M = 2

/**
 * The players of one monster pass, bucketed by cell with their positions at the pass's `now` (the wake check uses these
 * positions and the alive flags as they were at the start of the pass, like the old `active` list; the monster scans use
 * them only to pick candidates). Entries keep `world.players` order, so results come out in the order a full scan gave.
 */
export class PlayerGrid {
  readonly players: Player[] = []
  private readonly xs: Float64Array
  private readonly zs: Float64Array
  private readonly alive: Uint8Array
  /** Occupied cells: key -> the cell's column, row and entry indexes. */
  private readonly cells = new Map<number, { cx: number; cz: number; list: number[] }>()

  constructor(
    players: Iterable<Player>,
    count: number,
    positionAt: (p: Player) => Vec3,
    readonly now: number,
    readonly epoch: number,
    readonly size = CELL_M,
  ) {
    this.xs = new Float64Array(count)
    this.zs = new Float64Array(count)
    this.alive = new Uint8Array(count)
    let i = 0
    for (const p of players) {
      if (i >= count) break
      const q = positionAt(p)
      this.players.push(p)
      this.xs[i] = q[0]
      this.zs[i] = q[2]
      this.alive[i] = p.dead ? 0 : 1
      const cx = cellX(q[0], size)
      const cz = cellZ(q[2], size)
      const k = cellKey(cx, cz)
      const c = this.cells.get(k)
      if (c) c.list.push(i)
      else this.cells.set(k, { cx, cz, list: [i] })
      i++
    }
  }

  get count(): number {
    return this.players.length
  }

  /** Calls `fn` with each cell's entry list that may hold a point within `r` of x/z; stops when it returns true. */
  private eachCell(x: number, z: number, r: number, fn: (list: number[]) => boolean): void {
    const s = this.size
    const reach = Math.abs(r)
    const x0 = cellX(x - reach, s)
    const x1 = cellX(x + reach, s)
    const z0 = cellZ(z + reach, s)
    const z1 = cellZ(z - reach, s)
    const n = (x1 - x0 + 1) * (z1 - z0 + 1)
    // A huge radius (more cells in reach than are occupied, or a NaN): go through the occupied cells and keep those in reach.
    if (!(n <= this.cells.size)) {
      for (const c of this.cells.values()) {
        if ((c.cx >= x0 && c.cx <= x1 && c.cz >= z0 && c.cz <= z1) || Number.isNaN(n)) {
          if (fn(c.list)) return
        }
      }
      return
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const c = this.cells.get(cellKey(cx, cz))
        if (c && fn(c.list)) return
      }
    }
  }

  /**
   * The wake check: whether a player alive at the pass's start stood within sqrt(r2) of x/z then. Same arithmetic as the
   * full scan it replaces (`(q[0] - pos[0]) ** 2 + (q[2] - pos[2]) ** 2 <= r2`), so the answer is identical.
   */
  anyAliveWithin(x: number, z: number, r2: number): boolean {
    const { xs, zs, alive } = this
    let hit = false
    this.eachCell(x, z, Math.sqrt(r2) + 1, (list) => {
      for (const i of list) {
        if (alive[i] && (xs[i]! - x) ** 2 + (zs[i]! - z) ** 2 <= r2) return (hit = true)
      }
      return false
    })
    return hit
  }

  /**
   * Candidates for "players within `range` of x/z": every player that stood within range + SCAN_MARGIN_M at the pass's
   * start, in world.players order. The caller checks them exactly on their live positions.
   */
  candidates(x: number, z: number, range: number): Player[] {
    const { xs, zs } = this
    const reach = Math.abs(range) + SCAN_MARGIN_M
    const r2 = reach * reach
    const idx: number[] = []
    this.eachCell(x, z, reach, (list) => {
      for (const i of list) if ((xs[i]! - x) ** 2 + (zs[i]! - z) ** 2 <= r2) idx.push(i)
      return false
    })
    if (idx.length > 1) idx.sort((a, b) => a - b)
    return idx.map((i) => this.players[i]!)
  }
}
