/**
 * The town's navigation for the route graph (docs/TOWN_LIFE.md §2.4; docs/WORLD_EDITOR.md §4.11): the walkable home
 * component, the solid footprints, the dressing's keep-out circles and the segment check every graph edge passes.
 * Split out of ./build-graph.ts (which re-exports it) in wave 12 (lane WE-T) so the World Editor page runs the same
 * check on its own navmesh: no Node imports here.
 */
import { NavGltf, NavWorld, type NavData, type NavPosition } from '@sro/nav'
import type { TownDressingFile } from '../../../shared/src/town.ts'

/** Edge sampling step (m) and the clearance every sample keeps from nav edges (m): TOWN_LIFE §2.4. */
export const TOWN_EDGE_STEP_M = 0.5
export const TOWN_EDGE_CLEAR_M = 0.4
/** Largest height step between two samples (m): stairs pass, a wall top or a drop does not. */
export const TOWN_EDGE_DY_M = 0.6
/** The drawn height (linear between two nodes) keeps within this of the walkable surface (m): splitSlopeEdges. */
export const TOWN_EDGE_HEIGHT_TOL_M = 0.25
/** Solid footprints are checked this far below / above the surface (m), as the server's SolidIndex. */
const SOLID_BELOW_M = 3
const SOLID_ABOVE_M = 10

/** A keep-out circle (glTF m) round a dressing prop: its footprint's half diagonal + 0.4 m. */
export interface TownObstacle {
  x: number
  z: number
  r: number
}

/** A dressing row (TL-B's props and banners), with its model bounds. */
export interface DressingRow {
  name: string
  x: number
  z: number
  yaw: number
  min: [number, number, number]
  max: [number, number, number]
  /** Its height when the export places it (a re-convert ran with the dressing), else undefined. */
  y?: number
}

/** Bounds of models the export does not have yet (the dressing's stalls before the re-convert), else 1.2 m boxes. */
export const TOWN_DRESSING_FALLBACK: Record<string, { min: [number, number, number]; max: [number, number, number] }> = {
  w_etc02: { min: [-1.1, 0, -1.0], max: [1.1, 2.0, 1.0] },
  w_etc03: { min: [-1.1, 0, -1.0], max: [1.1, 2.0, 1.0] },
}

/** A model's bounds (glTF m). */
export interface TownBounds {
  min: [number, number, number]
  max: [number, number, number]
}

/**
 * The dressing's props and banners as rows, with bounds from `sidecar` (our props' JSON), the export's models, or a
 * fallback box; a placement of the same model within 0.5 m (the re-convert placed it) gives its height.
 */
export function dressingRowsWith(
  dressing: TownDressingFile | null,
  manifest: { models: ReadonlyArray<{ source: string; boundsMin: readonly number[]; boundsMax: readonly number[] }>; placements: ReadonlyArray<{ source: string; position: readonly number[] }> },
  sidecar: (name: string) => TownBounds | null = () => null,
): DressingRow[] {
  if (!dressing) return []
  const out: DressingRow[] = []
  const placedNear = (name: string, x: number, z: number) => manifest.placements.find((p) => Math.abs(p.position[0]! - x) < 0.5 && Math.abs(p.position[2]! - z) < 0.5 && townBaseName(p.source) === name)
  const rows: Array<{ model: string; x: number; z: number; yaw: number; scale?: number }> = [...dressing.props, ...dressing.banners]
  for (const r of rows) {
    const name = townBaseName(r.model)
    const at = placedNear(name, r.x, r.z)
    let b: TownBounds | null = r.model.startsWith('town/props/') ? sidecar(name) : null
    if (!b) {
      const m = manifest.models.find((mm) => townBaseName(mm.source) === name)
      if (m) b = { min: [m.boundsMin[0]!, m.boundsMin[1]!, m.boundsMin[2]!], max: [m.boundsMax[0]!, m.boundsMax[1]!, m.boundsMax[2]!] }
    }
    b ??= TOWN_DRESSING_FALLBACK[name] ?? { min: [-0.6, 0, -0.6], max: [0.6, 2, 0.6] }
    const sc = r.scale ?? 1
    out.push({ name, x: r.x, z: r.z, yaw: r.yaw, min: b.min.map((v) => v * sc) as [number, number, number], max: b.max.map((v) => v * sc) as [number, number, number], ...(at ? { y: at.position[1]! } : {}) })
  }
  return out
}

/** A source's base name, lower case, without a retail `.bsr` / `.cpd` extension (as the build script matches models). */
export function townBaseName(source: string): string {
  return source.split(/[\\/]/).pop()!.replace(/\.(bsr|cpd)$/i, '').toLowerCase()
}


/** The keep-out circle of a dressing row (its footprint's centre, half diagonal + 0.4 m). */
export function rowObstacle(r: DressingRow): TownObstacle {
  const ox = (r.min[0] + r.max[0]) / 2
  const oz = (r.min[2] + r.max[2]) / 2
  const c = Math.cos(r.yaw)
  const s = Math.sin(r.yaw)
  return { x: r.x + ox * c + oz * s, z: r.z - ox * s + oz * c, r: Math.hypot((r.max[0] - r.min[0]) / 2, (r.max[2] - r.min[2]) / 2) + 0.4 }
}

/** Solid object footprints (the server's rule: no link leads in, every outline edge blocks), in glTF metres. */
export class SolidFootprints {
  /** Per solid instance: 2D triangles (x, z) ×3 and heights y ×3. */
  readonly tris: Float64Array[] = []
  readonly key: string[] = []
  readonly inst: number[] = []
  private readonly buckets = new Map<number, number[]>()

  constructor(data: NavData, g: NavGltf) {
    data.instances.forEach((inst, i) => {
      const model = data.models[inst.model]!
      if (inst.links.length > 0 || model.outline.flags.some((f) => f === 0)) return
      const c = Math.cos(inst.yaw)
      const s = Math.sin(inst.yaw)
      const v = model.vertices
      const n = model.cells.length / 3
      const t = new Float64Array(n * 9)
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
      for (let k = 0; k < n; k++) {
        for (let j = 0; j < 3; j++) {
          const vi = model.cells[k * 3 + j]! * 3
          const lx = v[vi]!, ly = v[vi + 1]!, lz = v[vi + 2]!
          const x = g.gltfX(inst.x + c * lx - s * lz)
          const z = g.gltfZ(inst.z + s * lx + c * lz)
          t[k * 9 + j * 2] = x
          t[k * 9 + j * 2 + 1] = z
          t[k * 9 + 6 + j] = (inst.y + ly) / 10
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minZ = Math.min(minZ, z)
          maxZ = Math.max(maxZ, z)
        }
      }
      const idx = this.tris.length
      this.tris.push(t)
      this.key.push(model.key)
      this.inst.push(i)
      for (let bz = Math.floor(minZ / 16); bz <= Math.floor(maxZ / 16); bz++) {
        for (let bx = Math.floor(minX / 16); bx <= Math.floor(maxX / 16); bx++) {
          const key = bx * 65536 + bz
          const list = this.buckets.get(key)
          if (list) list.push(idx)
          else this.buckets.set(key, [idx])
        }
      }
    })
  }

  /** The solid footprint covering (x, z) near height y (index into `tris`), or -1. */
  at(x: number, z: number, y: number): number {
    const list = this.buckets.get(Math.floor(x / 16) * 65536 + Math.floor(z / 16))
    if (!list) return -1
    for (const i of list) {
      const t = this.tris[i]!
      for (let k = 0; k < t.length; k += 9) {
        const ax = t[k]!, az = t[k + 1]!, bx = t[k + 2]!, bz = t[k + 3]!, cx = t[k + 4]!, cz = t[k + 5]!
        const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
        if (Math.abs(det) < 1e-12) continue
        const u = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / det
        const w = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / det
        if (u < -1e-6 || w < -1e-6 || u + w > 1 + 1e-6) continue
        const h = t[k + 6]! + u * (t[k + 7]! - t[k + 6]!) + w * (t[k + 8]! - t[k + 6]!)
        if (h >= y - SOLID_BELOW_M && h <= y + SOLID_ABOVE_M) return i
      }
    }
    return -1
  }
}

/** The town's navigation in glTF metres: the home component, the solids, and the segment check. */
export class TownNav {
  readonly g: NavGltf
  readonly solids: SolidFootprints
  readonly home: number
  /**
   * The walkable surface a walker coming from height `prev` stands on at (x, z): the one nearest `prev`, or a floor up to
   * a step (TOWN_EDGE_DY_M) above it, which is the visible one (an object's floor laid over the terrain; locate alone
   * keeps following the hidden terrain under it). Null when the home component has no surface there.
   */
  surfaceAt(x: number, z: number, prev: number): NavPosition | null {
    const p = this.g.locateIn(x, z, prev, this.home)
    if (!p) return null
    const q = this.g.locateIn(x, z, p.y + TOWN_EDGE_DY_M, this.home)
    return q && q.y > p.y + 0.01 && q.y - p.y <= TOWN_EDGE_DY_M ? q : p
  }

  /** Water plane height (m) over (x, z), or -Infinity: nobody wades (a point more than 5 cm under it is out). */
  water: (x: number, z: number) => number = () => -Infinity
  /** The dressing's props (TL-B) as keep-out circles: graph edges and nodes stay out of them. */
  obstacles: TownObstacle[] = []

  /** `g`: an existing view of the same data (the editor's live navmesh); default: a new one. */
  constructor(readonly data: NavData, originRegion: { x: number; z: number }, home: { x: number; z: number }, g?: NavGltf) {
    this.g = g ?? new NavGltf(new NavWorld(data), originRegion)
    this.solids = new SolidFootprints(data, this.g)
    const p = this.g.locate(home.x, home.z, Infinity)
    this.home = p ? this.g.componentOf(p) : -1
  }

  /** The walkable surface at (x, z) nearest `yHint` (+Infinity: the highest) in the home component, off solids. */
  ground(x: number, z: number, yHint = Infinity): NavPosition | null {
    const p = this.g.locateIn(x, z, yHint, this.home)
    if (!p || this.solids.at(x, z, p.y) >= 0 || this.wet(x, z, p.y)) return null
    return p
  }

  /** The keep-out circle containing (x, z) (its index), or -1; `ignore` skips one (a place's own prop). */
  obstacleAt(x: number, z: number, ignore = -1): number {
    for (let i = 0; i < this.obstacles.length; i++) {
      const o = this.obstacles[i]!
      if (i !== ignore && (x - o.x) ** 2 + (z - o.z) ** 2 < o.r * o.r) return i
    }
    return -1
  }

  /** Under a water plane by more than 5 cm (the pond, the canal). */
  wet(x: number, z: number, y: number): boolean {
    return y < this.water(x, z) - 0.05
  }

  /**
   * A straight walk from p to (x, z) on the navmesh: the end position, or null when an edge blocks it. A walk that
   * stops unblocked at a surface change (terrain ↔ object, the 0.2-unit nudge) is continued from there.
   */
  walk(p: NavPosition, x: number, z: number): NavPosition | null {
    let cur = p
    for (let i = 0; i < 8; i++) {
      const m = this.g.moveStraight(cur, x, z)
      if (m.blocked) return null
      if (Math.hypot(m.end.x - x, m.end.z - z) <= 0.02) return m.end
      if (Math.hypot(m.end.x - cur.x, m.end.z - cur.z) < 1e-4) return null
      cur = m.end
    }
    return null
  }

  /** Every probe 0.4 m around p (8 directions) is walkable and reachable by a straight walk from p. */
  clear(p: NavPosition, r = TOWN_EDGE_CLEAR_M): boolean {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      const qx = p.x + Math.sin(a) * r
      const qz = p.z + Math.cos(a) * r
      const end = this.walk(p, qx, qz)
      if (!end || this.g.componentOf(end) !== this.home || this.solids.at(qx, qz, end.y) >= 0 || this.wet(qx, qz, end.y)) return false
    }
    return true
  }

  /**
   * TOWN_LIFE §2.4: null when the straight segment a → b lies on the walkable surface (a sample every 0.5 m located in
   * the home component, off solids, height steps ≤ 0.6 m, each keeping `clear` m from nav edges) and the navmesh walks
   * it unblocked from a to b; else the first problem.
   */
  checkSegment(ax: number, az: number, ay: number, bx: number, bz: number, by: number, clear = TOWN_EDGE_CLEAR_M, ignore = -1): string | null {
    const len = Math.hypot(bx - ax, bz - az)
    const steps = Math.max(1, Math.ceil(len / TOWN_EDGE_STEP_M))
    let prev: NavPosition | null = null
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      const x = ax + (bx - ax) * f
      const z = az + (bz - az) * f
      const yh = prev ? prev.y : Number.isFinite(ay) ? ay + (by - ay) * f : Infinity
      const p = this.g.locateIn(x, z, yh, this.home)
      if (!p) return `sample ${i}/${steps} (${x.toFixed(2)}, ${z.toFixed(2)}) is off the navmesh`
      if (this.solids.at(x, z, p.y) >= 0) return `sample ${i}/${steps} (${x.toFixed(2)}, ${z.toFixed(2)}) is under a solid object`
      if (this.wet(x, z, p.y)) return `sample ${i}/${steps} (${x.toFixed(2)}, ${z.toFixed(2)}) is under water`
      if (this.obstacleAt(x, z, ignore) >= 0) return `sample ${i}/${steps} (${x.toFixed(2)}, ${z.toFixed(2)}) is on a dressing prop`
      if (prev && Math.abs(p.y - prev.y) > TOWN_EDGE_DY_M) return `sample ${i}/${steps}: a ${Math.abs(p.y - prev.y).toFixed(2)} m step`
      if (clear > 0 && !this.clear(p, clear)) return `sample ${i}/${steps} (${x.toFixed(2)}, ${z.toFixed(2)}) is within ${clear} m of a nav edge`
      prev = p
    }
    const start = this.g.locateIn(ax, az, Number.isFinite(ay) ? ay : Infinity, this.home)
    if (!start) return 'the start is off the navmesh'
    const end = this.walk(start, bx, bz)
    if (!end) return 'the navmesh walk a -> b is blocked'
    if (prev && Math.abs(end.y - prev.y) > TOWN_EDGE_DY_M) return 'the walk ends on another surface'
    return null
  }
}

/**
 * How far the drawn height (linear from a to b, as the client walks a leg) leaves the walkable surface along a → b (m),
 * sampled every 0.25 m from a's height as splitSlopeEdges does. Above TOWN_EDGE_HEIGHT_TOL_M the edge needs a node on
 * the slope.
 */
export function townEdgeSlopeGap(nav: TownNav, a: { x: number; z: number; y?: number }, b: { x: number; z: number; y?: number }): number {
  if (a.y === undefined || b.y === undefined) return 0
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  const steps = Math.max(1, Math.ceil(len / 0.25))
  let prev = a.y
  let worst = 0
  for (let i = 1; i < steps; i++) {
    const f = i / steps
    const p = nav.surfaceAt(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f, prev)
    if (!p) continue
    prev = p.y
    worst = Math.max(worst, Math.abs(a.y + (b.y - a.y) * f - p.y))
  }
  return worst
}

/** The editor's edge rule: the build script's segment check, then feet on the ground (null: a good edge). */
export function checkTownEdge(nav: TownNav, a: { x: number; z: number; y?: number }, b: { x: number; z: number; y?: number }): string | null {
  const why = nav.checkSegment(a.x, a.z, a.y ?? Infinity, b.x, b.z, b.y ?? Infinity, TOWN_EDGE_CLEAR_M)
  if (why) return why
  const gap = townEdgeSlopeGap(nav, a, b)
  return gap > TOWN_EDGE_HEIGHT_TOL_M + 0.05 ? `the ground bends ${gap.toFixed(2)} m away from the straight line: add a node on the slope` : null
}

/**
 * The water plane height (m) over glTF (x, z) from a manifest's region blocks (a 32 m block of a region whose south-west
 * corner is at glTF (192 (rx - ox), -192 (rz - oz))), or -Infinity: TownNav.water, so nobody wades.
 */
export function townWater(manifest: {
  space: { originRegion: { x: number; z: number } }
  regions?: ReadonlyArray<{ x: number; z: number; blocks: ReadonlyArray<{ bx: number; bz: number; water: { kind: string; heightM: number } | null }> }>
}): (x: number, z: number) => number {
  const water = new Map<number, number>()
  for (const r of manifest.regions ?? []) {
    r.blocks.forEach((b) => {
      if (b.water && b.water.kind === 'water') water.set(((r.z * 8 + b.bz) << 16) | (r.x * 8 + b.bx), b.water.heightM)
    })
  }
  const o = manifest.space.originRegion
  return (x, z) => {
    const gx = Math.floor(x / 32) + o.x * 6
    const gz = Math.floor(-z / 32) + o.z * 6
    const rx = Math.floor(gx / 6)
    const rz = Math.floor(gz / 6)
    return water.get(((rz * 8 + (gz - rz * 6)) << 16) | (rx * 8 + (gx - rx * 6))) ?? -Infinity
  }
}
