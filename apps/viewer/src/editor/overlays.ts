/**
 * The editor's drawn helpers (docs/WORLD_EDITOR.md §4.1, §4.2, §4.7, §5): the brush cursor (a ring draped on the
 * ground, the inner ring the hard core) and the walking overlay (2 m tiles: red where walking is closed; bright red
 * where an edit closed it, by the nav rule Publish uses: slope over 35 degrees on moved ground, or the Walkable brush's
 * force closed; green where the Walkable brush forced it open).
 */
import {
  Color3, Mesh, MeshBuilder, StandardMaterial, VertexData, Vector3,
  type LinesMesh, type Scene,
} from '@babylonjs/core'
import { NAV_TILE_ACTION, WE_WALK } from '../../../../packages/shared/src/world-edits/index.ts'
import { CELLS, GRID } from './lattice.ts'
import type { WorldLink } from './world-link.ts'

const RING_SEGMENTS = 64
const LIFT_M = 0.2

export class BrushRing {
  private ring: LinesMesh
  private readonly outer: Vector3[] = []
  private readonly inner: Vector3[] = []

  constructor(private readonly scene: Scene, private readonly ground: (x: number, z: number) => number | null) {
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      this.outer.push(new Vector3())
      this.inner.push(new Vector3())
    }
    this.ring = MeshBuilder.CreateLineSystem('editorBrush', { lines: [this.outer, this.inner], updatable: true }, scene) as LinesMesh
    this.ring.color = new Color3(1, 0.82, 0.35)
    this.ring.isPickable = false
    this.ring.renderingGroupId = 1
    this.ring.setEnabled(false)
  }

  /** Shows the ring at glTF (x, z) with `radiusM` and the hard core `1 - softness` of it; null hides it. */
  show(at: { x: number; z: number } | null, radiusM: number, softness: number, colour?: Color3): void {
    if (!at) {
      this.ring.setEnabled(false)
      return
    }
    const ri = radiusM * (1 - Math.max(0.05, Math.min(1, softness)))
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2
      const c = Math.cos(a), s = Math.sin(a)
      for (const [list, r] of [[this.outer, radiusM], [this.inner, ri]] as const) {
        const x = at.x + c * r, z = at.z + s * r
        list[i]!.set(x, (this.ground(x, z) ?? 0) + LIFT_M, z)
      }
    }
    this.ring = MeshBuilder.CreateLineSystem('editorBrush', { lines: [this.outer, this.inner], instance: this.ring }, this.scene) as LinesMesh
    if (colour) this.ring.color = colour
    this.ring.setEnabled(true)
  }

  dispose(): void {
    this.ring.dispose()
  }
}

/**
 * The walking overlay: per shown region up to three meshes (the export's closed tiles faint red, the edit's closures
 * bright red, the tiles the Walkable brush forced open green).
 */
export class WalkOverlay {
  private readonly meshes = new Map<number, Mesh[]>()
  private readonly matRetail: StandardMaterial
  private readonly matNew: StandardMaterial
  private readonly matOpen: StandardMaterial
  enabled = true

  constructor(private readonly scene: Scene, private readonly link: WorldLink) {
    const mat = (name: string, c: Color3, alpha: number) => {
      const m = new StandardMaterial(name, scene)
      m.disableLighting = true
      m.emissiveColor = c
      m.alpha = alpha
      m.backFaceCulling = false
      m.zOffset = -2
      m.fogEnabled = false
      return m
    }
    this.matRetail = mat('editorWalkRetail', new Color3(0.75, 0.15, 0.12), 0.25)
    this.matNew = mat('editorWalkNew', new Color3(1, 0.05, 0.05), 0.65)
    this.matOpen = mat('editorWalkOpen', new Color3(0.2, 0.95, 0.35), 0.4)
  }

  /** Rebuilds the overlay of each region; returns the tiles the edits close there (not counting the brush's own). */
  update(regions: Iterable<number>): { closedByEdit: number } {
    let closedByEdit = 0
    for (const id of regions) {
      for (const m of this.meshes.get(id) ?? []) m.dispose()
      this.meshes.delete(id)
      if (!this.enabled) continue
      const data = this.link.world.regions.get(id)
      const nav = this.link.navRegion(id)
      if (!data || !nav) continue
      const rule = this.link.navRule(id)
      const codes = this.link.walkCodes(id)
      const h = data.terrain.heights
      const o = data.region.origin
      const lists = [0, 1, 2].map(() => ({ pos: [] as number[], idx: [] as number[] }))
      for (let tz = 0; tz < CELLS; tz++) {
        for (let tx = 0; tx < CELLS; tx++) {
          const t = tz * CELLS + tx
          const c = nav.tileCells[t]!
          const action = rule?.actions[t] ?? NAV_TILE_ACTION.keep
          const openAfter = action === NAV_TILE_ACTION.open || (c >= 0 && c < nav.openCellCount && action !== NAV_TILE_ACTION.close)
          const forced = codes?.[t] ?? WE_WALK.auto
          let k: number
          if (openAfter) {
            if (forced !== WE_WALK.open) continue
            k = 2
          } else if (action === NAV_TILE_ACTION.close || forced === WE_WALK.closed) {
            if (forced !== WE_WALK.closed) closedByEdit++
            k = 1
          } else k = 0
          const L = lists[k]!
          const b = L.pos.length / 3
          for (const [i, j] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
            const gx = tx + i, gz = tz + j
            L.pos.push(o[0]! + 2 * gx, h[gz * GRID + gx]! + LIFT_M, o[2]! - 2 * gz)
          }
          L.idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
        }
      }
      const made: Mesh[] = []
      lists.forEach((L, k) => {
        if (!L.idx.length) return
        const m = new Mesh(`editorWalk:${id}:${k}`, this.scene)
        const vd = new VertexData()
        vd.positions = L.pos
        vd.indices = L.idx
        vd.applyToMesh(m)
        m.material = k === 2 ? this.matOpen : k ? this.matNew : this.matRetail
        m.isPickable = false
        m.renderingGroupId = 1
        made.push(m)
      })
      if (made.length) this.meshes.set(id, made)
    }
    return { closedByEdit }
  }

  /** Keeps only these regions' meshes. */
  keep(regions: ReadonlySet<number>): void {
    for (const [id, ms] of this.meshes) {
      if (regions.has(id)) continue
      for (const m of ms) m.dispose()
      this.meshes.delete(id)
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) this.keep(new Set())
  }

  get shown(): number[] {
    return [...this.meshes.keys()]
  }
}
