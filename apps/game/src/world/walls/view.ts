/**
 * Siege of Jangan: the walls as the client draws them (docs/SIEGE.md §9.1, §9.2). Takes Jangan's four retail outer-wall
 * placements out of their regions (WorldObjects.addOwner, then the resident regions re-placed) and draws the converter's
 * Blender cut instead (`siege/models/cj_<side>_cut.glb`: one node per piece, a third `W3b` or a fixed piece `W-gate`),
 * with the world's own object materials and lightmaps, so the town looks as before while every third can be shown or
 * hidden. Layer 2's look over it (cracks, piles, the collapse, bits, dust, scaffolding) is dressing.ts, fed with the
 * side's own wall materials and a lightmap point of each.
 *
 * Without the cut glbs (or on a world loaded whole, not streamed) nothing is drawn here and the retail walls stay: the
 * nav still follows the stages (features/walls.ts).
 */
import { Quaternion, TransformNode, Vector3, VertexBuffer, type AbstractMesh, type AssetContainer, type Material, type Node, type Scene } from '@babylonjs/core'
import { WORLD_OBJECT_LAYER, loadGlb, type SidecarLite, type World } from '@sro/world-render'
import type { WallFxKind, WallsExport, WallsSideInfo } from '@sro/shared'
import { WallDressing, type WallSideSource } from './dressing.ts'
import type { WallLook, WallTier } from './look.ts'

interface SideView {
  info: WallsSideInfo
  container: AssetContainer
  converted: Awaited<ReturnType<World['materials']['convert']>>
  holder: TransformNode
  /** Piece id -> its node (the cut's empty) and meshes. */
  pieces: Map<string, { node: Node; meshes: AbstractMesh[] }>
}

export interface WallsViewOptions {
  tier(): WallTier
  onFall?(x: number, y: number, z: number, thirds: number): void
}

export class WallsView {
  private readonly sides = new Map<string, SideView>()
  private removeOwner: (() => void) | null = null
  private dressing: WallDressing | null = null
  private disposed = false
  /** Whether the cut is drawn (false: the retail walls stay). */
  active = false

  constructor(private readonly scene: Scene, private readonly world: World, private readonly walls: WallsExport, private readonly opts: WallsViewOptions) {}

  /** Loads the cut glbs and takes the retail walls over. Resolves false when there is nothing to draw. */
  async load(): Promise<boolean> {
    const stream = this.world.stream
    const sides = this.walls.sides.filter((s) => s.glb)
    if (!stream || sides.length === 0) return false
    for (const info of sides) {
      const container = await loadGlb(this.scene, this.world.assets, info.glb!)
      if (this.disposed) {
        container.dispose()
        return false
      }
      const sidecar = info.sidecar ? await this.world.assets.json<SidecarLite>(info.sidecar).catch(() => null) : null
      const converted = await this.world.materials.convert(container, sidecar, true, { model: info.glb!, source: info.placement.source, kind: 'static' })
      const entries = container.instantiateModelsToScene((n) => n, false, { doNotInstantiate: true })
      const holder = new TransformNode(`siege:${info.side}`, this.scene)
      holder.position = Vector3.FromArray(info.placement.position)
      holder.rotationQuaternion = Quaternion.Identity()
      for (const n of entries.rootNodes) n.parent = holder
      const pieces = new Map<string, { node: Node; meshes: AbstractMesh[] }>()
      for (const node of holder.getDescendants(false)) {
        if (!/^[NSWE](?:\d+[abc]|-\w+)$/.test(node.name)) continue
        pieces.set(node.name, { node, meshes: node.getChildMeshes(false) })
      }
      for (const m of holder.getChildMeshes(false)) {
        m.isPickable = false
        m.metadata = { sroWorld: 'object' }
        m.layerMask |= WORLD_OBJECT_LAYER
        m.receiveShadows = true
      }
      this.sides.set(info.side, { info, container, converted, holder, pieces })
    }
    if (this.disposed) return false
    // the retail placements leave their regions (the cut stands in for them from now on)
    const owned = new Set(sides.map((s) => `${s.placement.region}:${s.placement.uid}`))
    this.removeOwner = this.world.objects.addOwner((p) => owned.has(`${p.region}:${p.uid}`))
    await this.reloadRegions()
    if (this.disposed) return false
    this.dressing = new WallDressing(this.scene, this.walls, [...this.sides.values()].map((s) => this.source(s)), {
      tier: () => this.opts.tier(),
      ground: (x, z) => this.ground(x, z),
      onFall: (x, y, z, n) => this.opts.onFall?.(x, y, z, n),
      layerMask: WORLD_OBJECT_LAYER,
      path: () => this.world.materials.mode,
    })
    this.active = true
    return true
  }

  /** The dressing's view of a side: its wall materials, a lightmap point in each, the brick faces of a third. */
  private source(s: SideView): WallSideSource {
    const brick = this.wallMeshes(s, /wall01/i)
    const core = this.wallMeshes(s, /wall02/i)
    const lmOf = (meshes: AbstractMesh[]) => lightmapPoint(meshes, s.info) ?? ([0.5, 0.5] as [number, number])
    return {
      info: bodyFrame(s.info, brick),
      brick: brick[0]?.material ?? null,
      core: core[0]?.material ?? brick[0]?.material ?? null,
      lm: { brick: lmOf(brick), core: lmOf(core.length ? core : brick) },
      faces: (id) => (s.pieces.get(id)?.meshes ?? []).filter((m) => /wall01/i.test(m.material?.name ?? '')),
      meshes: (id) => s.pieces.get(id)?.meshes ?? [],
    }
  }

  /** The thirds' meshes of a side whose material matches (the cut's wall01 / wall02). */
  private wallMeshes(s: SideView, re: RegExp): AbstractMesh[] {
    const out: AbstractMesh[] = []
    for (const [id, p] of s.pieces) {
      if (!/\d[abc]$/.test(id)) continue
      for (const m of p.meshes) if (re.test(m.material?.name ?? '')) out.push(m)
    }
    return out
  }

  private ground(x: number, z: number): number {
    const nav = this.world.nav
    const h = nav.world.terrainHeight(nav.fileX(x), nav.fileZ(z)) * 0.1
    return Number.isFinite(h) ? h : NaN
  }

  private async reloadRegions(regions = new Set([...this.sides.values()].map((s) => s.info.placement.region))): Promise<void> {
    const stream = this.world.stream
    if (!stream) return
    await Promise.all([...regions].map((r) => stream.reloadObjects(r & 0xff, (r >> 8) & 0xff).catch(() => false)))
  }

  /** Shows the looks (thirds hidden when down; the dressing does the rest). `live`: a change happening now. */
  apply(looks: ReadonlyMap<string, WallLook>, live: boolean): void {
    if (!this.active) return
    for (const seg of this.walls.segments) {
      const side = this.sides.get(seg.side)
      if (!side) continue
      const look = looks.get(seg.id)
      seg.thirds.forEach((t, k) => side.pieces.get(t.id)?.node.setEnabled(!look?.down[k]))
    }
    this.dressing?.apply(looks, live)
  }

  /** A cosmetic moment (`wallFx`) at (x, y, z) of segment `id`. */
  fx(kind: WallFxKind, id: string, x: number, y: number, z: number): void {
    if (this.disposed || !this.active) return
    this.dressing?.moment(kind, id, x, y, z)
  }

  update(dt: number): void {
    this.dressing?.update(dt)
  }

  /** Visible pieces of a segment's thirds (tests, debug). */
  thirdsShown(id: string): boolean[] {
    const seg = this.walls.segments.find((s) => s.id === id)
    const side = seg && this.sides.get(seg.side)
    if (!seg || !side) return []
    return seg.thirds.map((t) => side.pieces.get(t.id)?.node.isEnabled(false) ?? false)
  }

  get stats(): { sides: number; pieces: number } & Partial<WallDressing['stats']> {
    let pieces = 0
    for (const s of this.sides.values()) pieces += s.pieces.size
    return { sides: this.sides.size, pieces, ...(this.dressing?.stats ?? {}) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dressing?.dispose()
    this.dressing = null
    const regions = new Set([...this.sides.values()].map((s) => s.info.placement.region))
    for (const s of this.sides.values()) {
      s.holder.dispose(false, false)
      this.world.materials.release(s.converted)
      s.container.dispose()
    }
    this.sides.clear()
    // the retail walls come back into their regions
    if (this.removeOwner) {
      this.removeOwner()
      this.removeOwner = null
      void this.reloadRegions(regions)
    }
  }
}

/**
 * The side's frame with `inner` / `outer` at the brick body's own faces, measured on the thirds' meshes (walls.json's
 * inner face takes in the stairs and ramps behind the S, W and E walls, up to 12 m inside the brick): piles, teeth,
 * decals and scaffolds stand against the stone itself.
 */
export function bodyFrame(info: WallsSideInfo, meshes: readonly AbstractMesh[]): WallsSideInfo {
  // the median third (a few beside the gatehouses take in steps behind the wall)
  const los: number[] = [], his: number[] = []
  for (const m of meshes) {
    m.computeWorldMatrix(true)
    const b = m.getBoundingInfo().boundingBox
    los.push(info.axis === 'x' ? b.minimumWorld.z : b.minimumWorld.x)
    his.push(info.axis === 'x' ? b.maximumWorld.z : b.maximumWorld.x)
  }
  if (!los.length) return info
  const median = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1]!
  const lo = median(los), hi = median(his)
  if (!(hi - lo > 2)) return info
  const [inner, outer] = info.out > 0 ? [lo, hi] : [hi, lo]
  return { ...info, inner, outer, line: (lo + hi) / 2 }
}

/**
 * A UV1 point inside a wall material's lightmap chart: the centroid of the largest triangle facing the field (the outer
 * face, the side players see from outside), so chunks drawn with that material sample a lit texel of the same wall.
 */
export function lightmapPoint(meshes: readonly AbstractMesh[], side: Pick<WallsSideInfo, 'axis' | 'out'>): [number, number] | null {
  let best = 0
  let out: [number, number] | null = null
  for (const m of meshes) {
    const pos = m.getVerticesData(VertexBuffer.PositionKind)
    const uv2 = m.getVerticesData(VertexBuffer.UV2Kind)
    const idx = m.getIndices()
    if (!pos || !uv2 || !idx) continue
    const w = m.computeWorldMatrix(true)
    const p = [Vector3.Zero(), Vector3.Zero(), Vector3.Zero()]
    for (let i = 0; i + 2 < idx.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        const v = idx[i + c]!
        Vector3.TransformCoordinatesFromFloatsToRef(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!, w, p[c]!)
      }
      const n = Vector3.Cross(p[1]!.subtract(p[0]!), p[2]!.subtract(p[0]!))
      const area = n.length() / 2
      if (area <= best) continue
      const across = side.axis === 'x' ? n.z : n.x
      if ((across * side.out) / (2 * area) < 0.7) continue
      best = area
      const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!
      out = [(uv2[a * 2]! + uv2[b * 2]! + uv2[c * 2]!) / 3, (uv2[a * 2 + 1]! + uv2[b * 2 + 1]! + uv2[c * 2 + 1]!) / 3]
    }
  }
  return out
}
