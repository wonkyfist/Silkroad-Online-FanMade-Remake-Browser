import {
  Color3,
  Color4,
  CreateLineSystem,
  Material,
  Mesh,
  StandardMaterial,
  Vector3,
  VertexData,
  type LinesMesh,
  type Scene,
} from '@babylonjs/core'
import type { NavGltf } from '@sro/nav'
import { CELLS, GRID, terrainHeightAt } from '../../../../packages/convert/src/world/format.ts'
import type { RegionData, WorldRegions } from '@sro/world-render'

const LIFT = 0.12
/** NVM_EDGE_FLAG (packages/formats nvm.ts): blocked = 3, internal = 4, global = 8. */
const EDGE_BLOCKED = 3

function regionPoint(data: RegionData, lx: number, lz: number, lift: number): Vector3 {
  const o = data.region.origin
  const h = terrainHeightAt(data.navmesh?.heights ?? data.terrain.heights, lx, lz)
  return new Vector3(o[0] + lx * 0.1, h + lift, o[2] - lz * 0.1)
}

/** Polyline from (ax, az) to (bx, bz) in region-local file units, following the terrain every <= 20 units. */
function draped(data: RegionData, ax: number, az: number, bx: number, bz: number, lift: number): Vector3[] {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 20))
  const pts: Vector3[] = []
  for (let i = 0; i <= n; i++) pts.push(regionPoint(data, ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n, lift))
  return pts
}

/**
 * Debug overlays:
 *  - navmesh: blocked 20-unit tiles (tile flag bit 0) as translucent red quads on the terrain; cell edges from the
 *    .nvm (red = blocked flag, cyan = global, green = internal),
 *  - object navmeshes (@sro/nav): walkable triangles translucent green; outline and inline edges coloured by what
 *    they do to a walker (NAVIGATION.md §6.4): red blocks (flag & 1/2/unlinked 8 from outside, every non-open outline
 *    edge from inside), orange = flag 16 (walkers below pass under, a railing on top), yellow = linked to another
 *    object, pale green = open outline edge (flag 0, exit to terrain),
 *  - region borders: yellow lines draped along every region edge.
 */
export class Overlays {
  readonly navmesh: Mesh[] = []
  readonly borders: LinesMesh[] = []
  blockedTiles = 0
  objectTriangles = 0
  objectEdges = 0
  private navmeshVisible = false

  constructor(readonly scene: Scene, readonly world: WorldRegions) {}

  buildNavmesh(): void {
    const mat = new StandardMaterial('navBlocked', this.scene)
    mat.disableLighting = true
    mat.emissiveColor = new Color3(1, 0.1, 0.1)
    mat.alpha = 0.45
    mat.backFaceCulling = false
    mat.zOffset = -2
    mat.fogEnabled = false
    for (const data of this.world.regions) {
      const nv = data.navmesh
      if (!nv) continue
      const pos: number[] = []
      const idx: number[] = []
      const hs = nv.heights
      for (let tz = 0; tz < CELLS; tz++) {
        for (let tx = 0; tx < CELLS; tx++) {
          if (!(nv.tileFlags[tz * CELLS + tx]! & 1)) continue
          const base = pos.length / 3
          for (const [i, j] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
            const gx = tx + i
            const gz = tz + j
            pos.push(2 * gx, hs[gz * GRID + gx]! + LIFT, -2 * gz)
          }
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
          this.blockedTiles++
        }
      }
      const o = data.region.origin
      if (idx.length) {
        const vd = new VertexData()
        vd.positions = pos
        vd.indices = idx
        const mesh = new Mesh(`navBlocked_${data.region.x}_${data.region.z}`, this.scene)
        vd.applyToMesh(mesh, false)
        mesh.position.set(o[0], o[1], o[2])
        mesh.sideOrientation = Material.CounterClockWiseSideOrientation
        mesh.material = mat
        mesh.isPickable = false
        this.navmesh.push(mesh)
      }
      const lines: Vector3[][] = []
      const colors: Color4[][] = []
      const red = new Color4(1, 0.25, 0.2, 1)
      const cyan = new Color4(0.2, 0.9, 1, 1)
      const green = new Color4(0.35, 1, 0.45, 1)
      for (let e = 0; e < nv.edges.length / 4; e++) {
        const flag = nv.edgeFlags[e]!
        const c = flag & EDGE_BLOCKED ? red : e < nv.globalEdgeCount ? cyan : green
        const pts = draped(data, nv.edges[e * 4]!, nv.edges[e * 4 + 1]!, nv.edges[e * 4 + 2]!, nv.edges[e * 4 + 3]!, LIFT + 0.05)
        lines.push(pts)
        colors.push(pts.map(() => c))
      }
      if (lines.length) {
        const ls = CreateLineSystem(`navEdges_${data.region.x}_${data.region.z}`, { lines, colors }, this.scene)
        ls.isPickable = false
        this.navmesh.push(ls)
      }
    }
    this.setNavmeshVisible(false)
  }

  /** Object navmesh layer (part of the navmesh toggle). */
  buildObjectNav(nav: NavGltf): void {
    const data = nav.world.data
    if (!data.instances.length) return
    const lift = 0.04
    const pos: number[] = []
    const idx: number[] = []
    const lines: Vector3[][] = []
    const colors: Color4[][] = []
    const red = new Color4(1, 0.2, 0.15, 1)
    const orange = new Color4(1, 0.6, 0.1, 1)
    const yellow = new Color4(1, 0.95, 0.1, 1)
    const open = new Color4(0.6, 1, 0.6, 1)
    for (const inst of data.instances) {
      const m = data.models[inst.model]
      if (!m) continue
      const c = Math.cos(inst.yaw)
      const s = Math.sin(inst.yaw)
      const v = m.vertices
      const nv = v.length / 3
      const pt = (k: number, up: number): Vector3 => {
        const lx = v[k * 3]!, ly = v[k * 3 + 1]!, lz = v[k * 3 + 2]!
        return new Vector3(nav.gltfX(inst.x + c * lx - s * lz), (inst.y + ly) * 0.1 + up, nav.gltfZ(inst.z + s * lx + c * lz))
      }
      const base = pos.length / 3
      for (let k = 0; k < nv; k++) {
        const p = pt(k, lift)
        pos.push(p.x, p.y, p.z)
      }
      for (let t = 0; t < m.cells.length; t++) idx.push(base + m.cells[t]!)
      const linked = new Set(inst.links.map(l => l.edge))
      const oe = m.outline
      for (let e = 0; e < oe.flags.length; e++) {
        const f = oe.flags[e]!
        const col = linked.has(e) ? yellow : f === 0 ? open : f & 16 && !(f & 3) ? orange : red
        const pts = [pt(oe.vertices[e * 2]!, lift + 0.03), pt(oe.vertices[e * 2 + 1]!, lift + 0.03)]
        lines.push(pts)
        colors.push([col, col])
      }
      const ie = m.inline
      for (let e = 0; e < ie.flags.length; e++) {
        if (!(ie.flags[e]! & 3)) continue
        const pts = [pt(ie.vertices[e * 2]!, lift + 0.03), pt(ie.vertices[e * 2 + 1]!, lift + 0.03)]
        lines.push(pts)
        colors.push([red, red])
      }
    }
    const mat = new StandardMaterial('navObject', this.scene)
    mat.disableLighting = true
    mat.emissiveColor = new Color3(0.2, 1, 0.35)
    mat.alpha = 0.3
    mat.backFaceCulling = false
    mat.zOffset = -3
    mat.fogEnabled = false
    const vd = new VertexData()
    vd.positions = pos
    vd.indices = idx
    const mesh = new Mesh('navObjects', this.scene)
    vd.applyToMesh(mesh, false)
    mesh.material = mat
    mesh.isPickable = false
    this.navmesh.push(mesh)
    this.objectTriangles = idx.length / 3
    if (lines.length) {
      const ls = CreateLineSystem('navObjectEdges', { lines, colors }, this.scene)
      ls.isPickable = false
      this.navmesh.push(ls)
      this.objectEdges = lines.length
    }
    this.setNavmeshVisible(this.navmeshVisible)
  }

  buildBorders(): void {
    const yellow = new Color4(1, 0.9, 0.2, 1)
    for (const data of this.world.regions) {
      const lines = [
        draped(data, 0, 0, 1920, 0, 0.3),
        draped(data, 1920, 0, 1920, 1920, 0.3),
        draped(data, 1920, 1920, 0, 1920, 0.3),
        draped(data, 0, 1920, 0, 0, 0.3),
      ]
      const ls = CreateLineSystem(`border_${data.region.x}_${data.region.z}`, { lines, colors: lines.map(l => l.map(() => yellow)) }, this.scene)
      ls.isPickable = false
      this.borders.push(ls)
    }
    this.setBordersVisible(false)
  }

  setNavmeshVisible(on: boolean): void {
    this.navmeshVisible = on
    for (const m of this.navmesh) m.setEnabled(on)
  }

  setBordersVisible(on: boolean): void {
    for (const m of this.borders) m.setEnabled(on)
  }
}
