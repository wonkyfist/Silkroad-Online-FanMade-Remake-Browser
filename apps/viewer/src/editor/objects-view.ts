/**
 * Objects in the editor (docs/WORLD_EDITOR.md §4.5, §4.6, D12, D17, D27, D28; WAVE_PLAN8 D16, D17): pick by a ray
 * against each nearby placement's model bounds (nearest hit wins), multi-select (Shift adds, Ctrl removes, a dragged
 * rectangle selects many), Babylon's gizmo (W move, E turn about the vertical, R uniform scale; world axes), snap to
 * the ground keeping the exported clearance (G; a drag lands on the ground unless Ctrl is held), delete, copy / paste,
 * and placing a model from the library.
 *
 * A selected object leaves its region batch (S-OBJ: editor-owned) and is drawn as a clone of its converted model (the
 * prototype's proven fallback, §9.3 item 2); when the selection ends, its region re-batches with the edited list.
 * Rules: an object joined to its neighbours by nav links can't move (the palace bridge chain); a building (any other
 * model with a walking footprint) never scales; trees scale 0.85-1.15, other props 0.5-2; nothing leaves the export.
 */
import {
  Color3, GizmoManager, Matrix, MeshBuilder, Quaternion, StandardMaterial, TransformNode, Vector3,
  type AbstractMesh, type IPlaneRotationGizmo, type Camera, type LinesMesh, type Ray, type Scene,
} from '@babylonjs/core'
import { isFoliageModel, type World } from '@sro/world-render'
import type { WorldEditModelKind } from '../../../../packages/shared/src/world-edits/index.ts'
import type { WorldModel, WorldPlacement } from '../../../../packages/convert/src/world/manifest.ts'
import { displayName, objectLabel } from './history.ts'
import {
  clampScale, isAddRef, roundState, sameState, scaleRange,
  type ObjRef, type ObjState, type ObjectChangeItem, type Vec3,
} from './object-edits.ts'
import type { EditSession } from './session.ts'
import { EDITOR_OWNER, type WorldLink } from './world-link.ts'
import { TreeLook } from './library/tree-look.ts'

export type GizmoMode = 'move' | 'turn' | 'scale'

export interface ObjectsHost {
  readonly scene: Scene
  readonly world: World
  readonly session: EditSession
  readonly link: WorldLink
  /** The edited ground at glTF (x, z). */
  ground(x: number, z: number): number | null
  /** The export's ground at glTF (x, z). */
  baseGround(x: number, z: number): number | null
  /** Ctrl held (the drop keeps its height). */
  holdHeight(): boolean
  /** False in a read-only tab (another editor tab writes) or while the original map is on screen. */
  canEdit(): boolean
  /** Why not, in words (the read-only sentence when absent). */
  lockedReason?(): string | null
  invalidate(): void
  say(text: string, kind?: 'ok' | 'warn' | 'error'): void
  changed(): void
  /** WE-L (library/tree-look.ts): a swapped tree's stand-in is the species' LOD0 preview (T12-E), not a retail clone. */
  readonly trees?: TreeLook | null
}

interface Proxy {
  node: TransformNode
  models: number[]
  box: LinesMesh
}

interface ClipItem {
  source: string
  offset: Vec3
  yaw: number
  scale: number
}

interface Ghost {
  items: ClipItem[]
  node: TransformNode
  proxies: Proxy[]
  yaw: number
  verb: 'Placed' | 'Pasted'
  /** Place mode keeps placing copies with Shift. */
  source: string | null
}

export interface SelectedInfo {
  count: number
  name: string
  region: string
  position: Vec3
  facingDeg: number
  scale: number
  ground: 'on the ground' | 'floating' | 'sunk'
  blocksWalking: boolean
  kind: WorldEditModelKind
  edited: boolean
  isAdd: boolean
}

/** Search radius for picking (m around the camera's ground point). */
const PICK_RADIUS_M = 260
const GOLD = new Color3(1, 0.78, 0.3)

export class ObjectsView {
  selection: ObjRef[] = []
  mode: GizmoMode = 'move'
  dragging = false
  scatter = true
  private readonly proxies = new Map<ObjRef, Proxy>()
  private readonly pivot: TransformNode
  private gm: GizmoManager | null = null
  private ghost: Ghost | null = null
  /** The last ground point the cursor aimed a ghost at: a new ghost (Shift+click again, a library pick) starts there. */
  private aim: { x: number; z: number } | null = null
  private clipboard: ClipItem[] = []
  private readonly footprintIds = new Set<number>()
  private readonly footprintSources = new Set<string>()
  private readonly linkedIds = new Set<number>()
  private pivotStart = { position: Vector3.Zero(), yaw: 0, scale: 1 }

  constructor(private readonly host: ObjectsHost) {
    this.pivot = new TransformNode('editorPivot', host.scene)
    this.pivot.rotationQuaternion = Quaternion.Identity()
    // the walking footprints and the linked pieces (nav-objects: instance id regionId << 16 | uid)
    try {
      const data = host.world.navWorld.data
      data.instances.forEach((inst, i) => {
        this.footprintIds.add(inst.id >>> 0)
        if (inst.links.length) {
          this.linkedIds.add(inst.id >>> 0)
          for (const l of inst.links) {
            const t = data.instances[l.target]
            if (t) this.linkedIds.add(t.id >>> 0)
          }
        }
        void i
      })
      for (const p of host.world.manifest.placements) if (this.footprintIds.has(navId(p))) this.footprintSources.add(p.source.toLowerCase())
    } catch (err) {
      console.warn('[editor] no nav objects: every object counts as a prop', err)
    }
  }

  // ---- classification ---------------------------------------------------------------------------------------------

  /** Whether a ref's model blocks walking (its nav footprint). */
  blocksWalking(ref: ObjRef): boolean {
    const p = this.host.session.objects.placementOf(ref)
    if (p) return this.footprintIds.has(navId(p))
    const s = this.host.session.objects.current(ref)
    return !!s && this.footprintSources.has(s.source.toLowerCase())
  }

  kindOf(ref: ObjRef): WorldEditModelKind {
    const s = this.host.session.objects.current(ref) ?? this.host.session.objects.original(ref)
    if (!s) return 'prop'
    if (isFoliageModel(s.source) || /[\\/]tree\d*[\\/]/i.test(s.source)) return 'tree'
    return this.blocksWalking(ref) ? 'blocker' : 'prop'
  }

  private linked(ref: ObjRef): boolean {
    const p = this.host.session.objects.placementOf(ref)
    return !!p && this.linkedIds.has(navId(p))
  }

  /** The exported clearance of a ref (its origin above the export's ground; trunks often sit below it). */
  clearance(ref: ObjRef): number {
    const o = this.host.session.objects
    const p = o.placementOf(ref) ?? o.templateOf(o.current(ref)?.source ?? '')
    if (!p) return 0
    const g = this.host.baseGround(p.position[0], p.position[2])
    return g === null ? 0 : p.position[1] - g
  }

  // ---- models -----------------------------------------------------------------------------------------------------

  /** The models a placement draws with on the batch path: static, or a skinned model's static variant. */
  private drawModels(p: WorldPlacement | undefined): WorldModel[] {
    if (!p) return []
    const models = this.host.world.manifest.models
    const out: WorldModel[] = []
    for (const mi of p.models) {
      let m = models[mi]
      if (m && m.kind === 'skinned' && m.staticVariant !== undefined && m.staticVariant !== null) m = models[m.staticVariant]
      if (m && m.glb && m.kind !== 'failed') out.push(m)
    }
    return out
  }

  /** The union of a placement's model bounds (model space), or null. */
  private bounds(p: WorldPlacement | undefined): { min: Vector3; max: Vector3 } | null {
    const ms = this.drawModels(p)
    if (!ms.length) return null
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)
    for (const m of ms) {
      min.minimizeInPlaceFromFloats(m.boundsMin[0], m.boundsMin[1], m.boundsMin[2])
      max.maximizeInPlaceFromFloats(m.boundsMax[0], m.boundsMax[1], m.boundsMax[2])
    }
    return { min, max }
  }

  private templateFor(ref: ObjRef): WorldPlacement | undefined {
    const o = this.host.session.objects
    return o.placementOf(ref) ?? o.templateOf(o.current(ref)?.source ?? '')
  }

  // ---- picking ----------------------------------------------------------------------------------------------------

  /** The nearest object the ray hits (its model bounds), or null; with "Show deleted", deleted ones too. */
  pick(ray: Ray, near: { x: number; z: number }): ObjRef | null {
    let best: ObjRef | null = null
    let bestT = Infinity
    const inv = new Matrix()
    const o = new Vector3(), d = new Vector3()
    const objs = this.host.session.objects
    const cands = [...objs.near(near.x, near.z, PICK_RADIUS_M, true)]
    if (this.showDeleted) for (const g of objs.deleted()) cands.push({ ref: g.ref, state: g.state, placement: objs.placementOf(g.ref) })
    for (const { ref, state, placement } of cands) {
      const b = this.bounds(placement)
      if (!b) continue
      Matrix.ComposeToRef(new Vector3(state.scale, state.scale, state.scale), Quaternion.RotationYawPitchRoll(state.yaw, 0, 0), Vector3.FromArray(state.position), inv)
      inv.invert()
      Vector3.TransformCoordinatesToRef(ray.origin, inv, o)
      Vector3.TransformNormalToRef(ray.direction, inv, d)
      const t = rayBox(o, d, b.min, b.max)
      if (t !== null && t < bestT) {
        bestT = t
        best = ref
      }
    }
    return best
  }

  /** Every object whose origin projects inside the screen rectangle (canvas CSS pixels, as scene.pointerX / Y). */
  pickRect(x0: number, y0: number, x1: number, y1: number, camera: Camera, near: { x: number; z: number }): ObjRef[] {
    const scene = this.host.scene
    const canvas = scene.getEngine().getRenderingCanvas()
    const vp = camera.viewport.toGlobal(canvas?.clientWidth ?? 1, canvas?.clientHeight ?? 1)
    const tm = scene.getTransformMatrix()
    const out: ObjRef[] = []
    const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) }, hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) }
    for (const { ref, state } of this.host.session.objects.near(near.x, near.z, PICK_RADIUS_M)) {
      const p = Vector3.Project(Vector3.FromArray(state.position), Matrix.IdentityReadOnly, tm, vp)
      if (p.z < 0 || p.z > 1) continue
      if (p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y) out.push(ref)
    }
    return out
  }

  // ---- selection --------------------------------------------------------------------------------------------------

  async select(refs: readonly ObjRef[], how: 'set' | 'add' | 'remove' = 'set'): Promise<void> {
    let next: ObjRef[]
    if (how === 'set') next = [...refs]
    else if (how === 'add') next = [...new Set([...this.selection, ...refs])]
    else next = this.selection.filter(r => !refs.includes(r))
    next = next.filter(r => this.host.session.objects.current(r))
    const gone = this.selection.filter(r => !next.includes(r))
    this.selection = next
    this.attachGizmo()
    await Promise.all(next.filter(r => !this.proxies.has(r)).map(r => this.makeProxy(r)))
    for (const r of next) this.placeProxy(r)
    await this.updateOwnership()
    for (const r of gone) this.dropProxy(r)
    this.attachGizmo()
    this.host.changed()
    this.host.invalidate()
    if (next.length === 1) {
      const name = displayName(this.host.session.objects.current(next[0]!)!.source)
      this.host.say(this.linked(next[0]!)
        ? `${name} is joined to its neighbours (a bridge piece): it can't be moved on its own.`
        : `Picked up ${name}. Drag the arrows to move it (W), the ring to turn it (E), the box to resize it (R). G puts it on the ground.`)
    } else if (next.length > 1) this.host.say(`${next.length} objects selected. Drag to move them together; Del deletes them; Ctrl+C copies them.`)
  }

  deselect(): Promise<void> {
    return this.select([], 'set')
  }

  /** After undo / redo / revert: the proxies follow the state; a deleted object leaves the selection. */
  async refresh(): Promise<void> {
    const o = this.host.session.objects
    const keep = this.selection.filter(r => o.current(r))
    if (keep.length !== this.selection.length) await this.select(keep)
    else {
      for (const r of this.selection) this.placeProxy(r)
      this.attachGizmo()
      await this.updateOwnership()
    }
    this.host.changed()
  }

  /** The editor owns the selection: its regions re-batch without it (keys from the shared lowering). */
  private async updateOwnership(): Promise<void> {
    const { session, link } = this.host
    const low = link.lowered()
    const keys = new Set<string>()
    const regions = new Set<number>()
    for (const ref of this.selection) {
      const p = session.objects.placementOf(ref)
      const key = low.keyOf.get(ref) ?? (p ? `${p.region}:${p.uid}` : null)
      if (!key) continue
      keys.add(key)
      const owner = Number(key.split(':')[0])
      regions.add(p && key === `${p.region}:${p.uid}` ? link.homeOf(p) : owner)
    }
    await link.setOwned(keys, regions)
    await link.syncObjects()
  }

  info(): SelectedInfo | null {
    const sel = this.selection
    if (!sel.length) return null
    const o = this.host.session.objects
    const ref = sel[0]!
    const s = o.current(ref)!
    const g = this.host.ground(s.position[0], s.position[2])
    const clr = this.clearance(ref)
    const above = g === null ? clr : s.position[1] - g
    const ground = above > clr + 0.3 ? 'floating' : above < clr - 0.5 ? 'sunk' : 'on the ground'
    const region = this.host.session.regionAt(s.position[0], s.position[2])
    return {
      count: sel.length, name: sel.length === 1 ? displayName(s.source) : `${sel.length} objects`, region: `${region & 0xff},${region >> 8}`,
      position: s.position, facingDeg: ((((s.yaw * 180) / Math.PI) % 360) + 360) % 360, scale: s.scale, ground,
      blocksWalking: this.blocksWalking(ref), kind: this.kindOf(ref), edited: o.edited(ref), isAdd: isAddRef(ref),
    }
  }

  // ---- proxies ----------------------------------------------------------------------------------------------------

  private async makeProxy(ref: ObjRef): Promise<Proxy | null> {
    const p = this.templateFor(ref)
    const models = this.drawModels(p)
    const node = new TransformNode(`editorProxy:${ref}`, this.host.scene)
    node.rotationQuaternion = Quaternion.Identity()
    const proxy: Proxy = { node, models: [], box: this.makeBox(p, node) }
    this.proxies.set(ref, proxy)
    const tree = this.host.trees?.attach(node, TreeLook.keyOf(this.host.session.objects.placementOf(ref)), models) ?? false
    const stream = tree ? null : this.host.world.stream
    if (stream) {
      for (const m of models) {
        try {
          const cached = await stream.models.acquire(m.index, EDITOR_OWNER)
          proxy.models.push(m.index)
          if (this.proxies.get(ref) !== proxy) break
          const inst = cached.container.instantiateModelsToScene(n => `${n}#ed`, false, { doNotInstantiate: true })
          for (const r of inst.rootNodes) r.parent = node
          for (const mesh of node.getChildMeshes(false)) {
            mesh.setEnabled(true)
            mesh.isPickable = false
            mesh.receiveShadows = true
          }
        } catch (err) {
          console.warn('[editor] proxy model failed', m.source, err)
        }
      }
    }
    if (this.proxies.get(ref) !== proxy) {
      this.disposeProxy(proxy)
      return null
    }
    this.placeProxy(ref)
    return proxy
  }

  private makeBox(p: WorldPlacement | undefined, parent: TransformNode): LinesMesh {
    const b = this.bounds(p) ?? { min: new Vector3(-0.5, 0, -0.5), max: new Vector3(0.5, 1, 0.5) }
    const c = [
      [b.min.x, b.min.y, b.min.z], [b.max.x, b.min.y, b.min.z], [b.max.x, b.min.y, b.max.z], [b.min.x, b.min.y, b.max.z],
      [b.min.x, b.max.y, b.min.z], [b.max.x, b.max.y, b.min.z], [b.max.x, b.max.y, b.max.z], [b.min.x, b.max.y, b.max.z],
    ].map(a => Vector3.FromArray(a))
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] as const
    const box = MeshBuilder.CreateLineSystem('editorSelBox', { lines: E.map(([a, b2]) => [c[a]!, c[b2]!]) }, this.host.scene) as LinesMesh
    box.color = GOLD
    box.parent = parent
    box.isPickable = false
    box.renderingGroupId = 1
    return box
  }

  private placeProxy(ref: ObjRef): void {
    const pr = this.proxies.get(ref)
    const s = this.host.session.objects.current(ref)
    if (!pr || !s) return
    if (pr.node.parent) pr.node.setParent(null)
    pr.node.position.set(s.position[0], s.position[1], s.position[2])
    pr.node.rotationQuaternion = Quaternion.RotationYawPitchRoll(s.yaw, 0, 0)
    pr.node.scaling.setAll(s.scale)
  }

  private dropProxy(ref: ObjRef): void {
    const pr = this.proxies.get(ref)
    if (!pr) return
    this.proxies.delete(ref)
    this.disposeProxy(pr)
  }

  private disposeProxy(pr: Proxy): void {
    this.host.trees?.detach(pr.node)
    pr.node.dispose(false, false)
    for (const m of pr.models) this.host.world.stream?.models.release(m, EDITOR_OWNER)
  }

  // ---- deleted objects ----------------------------------------------------------------------------------------------

  /** "Show deleted" (§4.6): deleted objects drawn as red boxes; clicking one puts it back. */
  showDeleted = false
  private readonly deletedBoxes = new Map<ObjRef, TransformNode>()

  setShowDeleted(on: boolean): void {
    this.showDeleted = on
    this.refreshDeleted()
  }

  /** Re-draws the deleted objects' boxes (after any change). */
  refreshDeleted(): void {
    const want = this.showDeleted ? this.host.session.objects.deleted() : []
    const keep = new Set(want.map(w => w.ref))
    for (const [ref, n] of this.deletedBoxes) {
      if (keep.has(ref)) continue
      n.dispose(false, false)
      this.deletedBoxes.delete(ref)
    }
    for (const { ref, state } of want) {
      if (this.deletedBoxes.has(ref)) continue
      const n = new TransformNode(`editorDeleted:${ref}`, this.host.scene)
      n.position.set(state.position[0], state.position[1], state.position[2])
      n.rotationQuaternion = Quaternion.RotationYawPitchRoll(state.yaw, 0, 0)
      n.scaling.setAll(state.scale)
      const box = this.makeBox(this.host.session.objects.placementOf(ref), n)
      box.color = new Color3(1, 0.3, 0.25)
      this.deletedBoxes.set(ref, n)
    }
    this.host.invalidate()
  }

  /** A click on a deleted object's box: it comes back where the export has it (one change). */
  async restore(ref: ObjRef): Promise<boolean> {
    const o = this.host.session.objects
    if (o.current(ref) || isAddRef(ref)) return false
    const ok = await this.commitStates(new Map([[ref, o.original(ref)]]), 'Restored')
    this.refreshDeleted()
    return ok
  }

  isDeleted(ref: ObjRef): boolean {
    return !isAddRef(ref) && !this.host.session.objects.current(ref)
  }

  // ---- the gizmo --------------------------------------------------------------------------------------------------

  setMode(m: GizmoMode): void {
    this.mode = m
    this.attachGizmo()
  }

  private gizmos(): GizmoManager {
    if (this.gm) return this.gm
    const gm = new GizmoManager(this.host.scene)
    gm.usePointerToAttachGizmos = false
    gm.positionGizmoEnabled = true
    gm.rotationGizmoEnabled = true
    gm.scaleGizmoEnabled = true
    const pg = gm.gizmos.positionGizmo!
    const rg = gm.gizmos.rotationGizmo!
    const sg = gm.gizmos.scaleGizmo!
    rg.xGizmo.isEnabled = false
    rg.zGizmo.isEnabled = false
    sg.xGizmo.isEnabled = false
    sg.yGizmo.isEnabled = false
    sg.zGizmo.isEnabled = false
    pg.updateGizmoRotationToMatchAttachedMesh = false
    rg.updateGizmoRotationToMatchAttachedMesh = false
    for (const g of [pg, rg, sg]) {
      g.scaleRatio = 1.6
      g.onDragStartObservable.add(() => {
        this.dragging = true
      })
      g.onDragEndObservable.add(() => {
        this.dragging = false
        void this.commitGizmo()
      })
    }
    replaceRotationDiscs(gm, [rg.xGizmo, rg.yGizmo, rg.zGizmo])
    pg.onDragObservable.add(() => this.host.invalidate())
    rg.onDragObservable.add(() => this.host.invalidate())
    sg.onDragObservable.add(() => this.host.invalidate())
    this.gm = gm
    return gm
  }

  get gizmoHovered(): boolean {
    return !!this.gm?.isHovered
  }

  private attachGizmo(): void {
    const sel = this.selection.filter(r => this.proxies.has(r))
    if (!sel.length || sel.some(r => this.linked(r))) {
      this.gm?.attachToNode(null)
      return
    }
    const gm = this.gizmos()
    // the pivot: the selection's centre on the ground plane of its lowest origin, identity rotation and scale
    for (const r of sel) this.proxies.get(r)!.node.setParent(null)
    const c = new Vector3()
    let minY = Infinity
    for (const r of sel) {
      const n = this.proxies.get(r)!.node
      c.addInPlace(n.position)
      minY = Math.min(minY, n.position.y)
    }
    c.scaleInPlace(1 / sel.length)
    c.y = minY
    this.pivot.position.copyFrom(c)
    this.pivot.rotationQuaternion = Quaternion.Identity()
    this.pivot.scaling.setAll(1)
    this.pivot.computeWorldMatrix(true)
    for (const r of sel) this.proxies.get(r)!.node.setParent(this.pivot)
    this.pivotStart = { position: c.clone(), yaw: 0, scale: 1 }
    const scalable = sel.every(r => this.kindOf(r) !== 'blocker')
    gm.positionGizmoEnabled = this.mode === 'move'
    gm.rotationGizmoEnabled = this.mode === 'turn'
    gm.scaleGizmoEnabled = this.mode === 'scale' && scalable
    if (gm.gizmos.rotationGizmo) {
      gm.gizmos.rotationGizmo.xGizmo.isEnabled = false
      gm.gizmos.rotationGizmo.zGizmo.isEnabled = false
    }
    if (gm.gizmos.scaleGizmo) {
      gm.gizmos.scaleGizmo.xGizmo.isEnabled = false
      gm.gizmos.scaleGizmo.yGizmo.isEnabled = false
      gm.gizmos.scaleGizmo.zGizmo.isEnabled = false
    }
    gm.attachToNode(this.pivot)
    if (this.mode === 'scale' && !scalable) this.host.say('Buildings and other walk-blocking objects keep their size. Trees can be 85 to 115 %, other props 50 to 200 %.', 'warn')
  }

  /** A gizmo drag ended: the selection's new transforms become one change (landing on the ground unless Ctrl). */
  private async commitGizmo(): Promise<void> {
    const sel = this.selection.filter(r => this.proxies.has(r))
    if (!sel.length) return
    const yawDelta = this.pivot.rotationQuaternion ? this.pivot.rotationQuaternion.toEulerAngles().y : 0
    const scaleDelta = this.pivot.scaling.x
    const moved = !this.pivot.position.equalsWithEpsilon(this.pivotStart.position, 1e-4)
    const verb = Math.abs(scaleDelta - 1) > 1e-4 ? 'Resized' : Math.abs(yawDelta) > 1e-5 ? 'Turned' : 'Moved'
    const states = new Map<ObjRef, ObjState>()
    let clamped = false
    for (const r of sel) {
      const cur = this.host.session.objects.current(r)!
      const n = this.proxies.get(r)!.node
      n.computeWorldMatrix(true)
      const pos = n.getAbsolutePosition()
      const kind = this.kindOf(r)
      let scale = cur.scale
      let position: Vec3 = [pos.x, pos.y, pos.z]
      if (verb === 'Resized') {
        scale = clampScale(cur.scale * scaleDelta, kind)
        if (Math.abs(scale - cur.scale * scaleDelta) > 1e-6) clamped = true
        position = [...cur.position] as Vec3 // resize about each object's own origin
      }
      states.set(r, { source: cur.source, position, yaw: cur.yaw + yawDelta, scale })
    }
    if (clamped) {
      const [lo, hi] = scaleRange(this.kindOf(sel[0]!))
      this.host.say(`That size is out of range: this kind of object can be ${Math.round(lo * 100)} to ${Math.round(hi * 100)} % of its size.`, 'warn')
    }
    await this.commitStates(states, verb, { land: moved && !this.host.holdHeight() })
  }

  /** Commits new states for refs as one change (rounded; landed on the ground when asked; bounds checked). */
  async commitStates(states: ReadonlyMap<ObjRef, ObjState | null>, verb: string, opts: { land?: boolean } = {}): Promise<boolean> {
    const { session } = this.host
    if (!this.host.canEdit()) {
      this.host.say(this.host.lockedReason?.() ?? 'This tab is read-only: another World Editor tab is open.', 'warn')
      for (const r of this.selection) this.placeProxy(r)
      this.attachGizmo()
      return false
    }
    const items: ObjectChangeItem[] = []
    for (const [ref, st] of states) {
      let s = st
      if (s) {
        if (opts.land) {
          const g = this.host.ground(s.position[0], s.position[2])
          if (g !== null) s = { ...s, position: [s.position[0], g + this.clearance(ref), s.position[2]] }
        }
        const kind = this.kindOf(ref)
        const scale = clampScale(s.scale, kind)
        if (scale !== s.scale) {
          const [lo, hi] = scaleRange(kind)
          this.host.say(kind === 'blocker'
            ? `${displayName(s.source)} blocks walking: it keeps its size.`
            : `That size is out of range: this kind of object can be ${Math.round(lo * 100)} to ${Math.round(hi * 100)} % of its size.`, 'warn')
          s = { ...s, scale }
        }
        s = roundState(s)
        const problem = this.placeProblem(ref, s)
        if (problem) {
          this.host.say(problem, 'error')
          for (const r of this.selection) this.placeProxy(r)
          this.attachGizmo()
          return false
        }
      }
      const before = session.objects.current(ref)
      if (sameState(before, s)) continue
      items.push({ ref, before, after: s })
    }
    for (const r of this.selection) this.placeProxy(r)
    if (!items.length) {
      this.attachGizmo()
      return false
    }
    for (const it of items) session.objects.set(it.ref, it.after)
    const regions = new Set<number>()
    for (const it of items) for (const s of [it.before, it.after]) if (s) regions.add(session.regionAt(s.position[0], s.position[2]))
    const change = session.record({ objects: { items } }, objectLabel(verb, { items }), [...regions].sort((a, b) => a - b))
    for (const r of this.selection) this.placeProxy(r)
    this.attachGizmo()
    await this.updateOwnership()
    this.host.say(`${change.label}. Not saved yet.`)
    this.host.changed()
    return true
  }

  /** Why an object can't stand there (plain English), or null. */
  private placeProblem(ref: ObjRef, s: ObjState): string | null {
    const region = this.host.session.regionAt(s.position[0], s.position[2])
    if (!this.host.world.manifest.regions.some(r => r.id === region && !r.synthetic)) return `${displayName(s.source)} would leave the map here. Keep it inside the converted regions.`
    const cur = this.host.session.objects.current(ref)
    if (this.linked(ref) && cur && (cur.position[0] !== s.position[0] || cur.position[2] !== s.position[2] || cur.yaw !== s.yaw)) {
      return `${displayName(s.source)} is joined to its neighbours (a bridge piece): it can't be moved on its own.`
    }
    const pl = this.host.world.manifest.stream?.playable
    if (pl && this.kindOf(ref) === 'blocker') {
      const rx = region & 0xff, rz = region >> 8
      if (rx < pl.x0 || rx > pl.x1 || rz < pl.z0 || rz > pl.z1) return `${displayName(s.source)} blocks walking: it can't stand outside the playable area.`
    }
    return null
  }

  // ---- commands ---------------------------------------------------------------------------------------------------

  /** G: the selection on the ground, keeping each one's exported clearance. */
  async snapToGround(): Promise<void> {
    const states = new Map<ObjRef, ObjState>()
    for (const r of this.selection) {
      const s = this.host.session.objects.current(r)
      if (s) states.set(r, s)
    }
    if (!states.size) return this.host.say('Select something first (Move tool, V, then click it).')
    if (!(await this.commitStates(states, 'Snapped', { land: true }))) this.host.say('Already on the ground.')
  }

  /** "Put back": the selection where the export has it (adds stay where they are). */
  async putBack(): Promise<void> {
    const o = this.host.session.objects
    const states = new Map<ObjRef, ObjState | null>()
    for (const r of this.selection) if (!isAddRef(r)) states.set(r, o.original(r))
    if (states.size) await this.commitStates(states, 'Put back')
  }

  async deleteSelected(): Promise<void> {
    const sel = [...this.selection]
    if (!sel.length) return this.host.say('Select something first (Move tool, V, then click it).')
    if (!this.host.canEdit()) return this.host.say(this.host.lockedReason?.() ?? 'This tab is read-only: another World Editor tab is open.', 'warn')
    if (sel.some(r => this.linked(r))) return this.host.say('A bridge piece is joined to its neighbours: it can\'t be deleted on its own.', 'error')
    const { session } = this.host
    const items: ObjectChangeItem[] = sel.map(ref => ({ ref, before: session.objects.current(ref), after: null }))
    await this.select([])
    for (const it of items) session.objects.set(it.ref, null)
    const regions = [...new Set(items.map(it => session.regionAt(it.before!.position[0], it.before!.position[2])))].sort((a, b) => a - b)
    const change = session.record({ objects: { items } }, objectLabel('Deleted', { items }), regions)
    await this.host.link.syncObjects()
    this.host.say(`${change.label}. Undo (Ctrl+Z) or the Changes list brings it back.`)
    this.host.changed()
  }

  copy(): void {
    const o = this.host.session.objects
    const states = this.selection.map(r => o.current(r)).filter((s): s is ObjState => !!s)
    if (!states.length) return this.host.say('Select something to copy first.')
    const c = states.reduce((a, s) => [a[0] + s.position[0] / states.length, a[1], a[2] + s.position[2] / states.length] as Vec3, [0, 0, 0] as Vec3)
    this.clipboard = states.map(s => ({ source: s.source, offset: [s.position[0] - c[0], 0, s.position[2] - c[2]], yaw: s.yaw, scale: s.scale }))
    this.host.say(`Copied ${states.length === 1 ? displayName(states[0]!.source) : `${states.length} objects`}. Ctrl+V pastes at the cursor.`)
  }

  get placing(): boolean {
    return this.ghost !== null
  }

  async beginPaste(): Promise<void> {
    if (!this.clipboard.length) return this.host.say('Nothing copied yet: select objects and press Ctrl+C.')
    await this.beginGhost(this.clipboard, 'Pasted', null)
    this.host.say('Move the mouse to where they go and click to drop them. Esc cancels.')
  }

  /** Place mode: one model follows the cursor; a click lands it (Shift keeps placing). */
  async beginPlace(source: string): Promise<void> {
    if (!this.host.session.objects.templateOf(source)) return this.host.say(`${displayName(source)} can't be placed yet: it has no converted model.`, 'error')
    await this.select([])
    const veg = isFoliageModel(source)
    const scale = veg && this.scatter ? 0.9 + Math.random() * 0.2 : 1
    await this.beginGhost([{ source, offset: [0, 0, 0], yaw: veg && this.scatter ? Math.random() * Math.PI * 2 : 0, scale }], 'Placed', source)
    this.host.say(`Placing ${displayName(source)}: click the ground to put it there, the mouse wheel turns it, Shift+click keeps placing. Esc stops.`)
  }

  private async beginGhost(items: ClipItem[], verb: Ghost['verb'], source: string | null): Promise<void> {
    this.cancelGhost()
    const node = new TransformNode('editorGhost', this.host.scene)
    node.rotationQuaternion = Quaternion.Identity()
    const ghost: Ghost = { items, node, proxies: [], yaw: 0, verb, source }
    this.ghost = ghost
    // seeded at the last aimed point (never the world origin); proxies are seated below once they exist
    if (this.aim) node.position.set(this.aim.x, this.host.ground(this.aim.x, this.aim.z) ?? 0, this.aim.z)
    const stream = this.host.world.stream
    for (const it of items) {
      const t = this.host.session.objects.templateOf(it.source)
      const child = new TransformNode('editorGhostItem', this.host.scene)
      child.parent = node
      child.position.set(it.offset[0], 0, it.offset[2])
      child.rotationQuaternion = Quaternion.RotationYawPitchRoll(it.yaw, 0, 0)
      child.scaling.setAll(it.scale)
      const pr: Proxy = { node: child, models: [], box: this.makeBox(t, child) }
      ghost.proxies.push(pr)
      if (this.host.trees?.attach(child, null, this.drawModels(t))) continue
      for (const m of this.drawModels(t)) {
        if (!stream) break
        try {
          const cached = await stream.models.acquire(m.index, EDITOR_OWNER)
          pr.models.push(m.index)
          if (this.ghost !== ghost) break
          const inst = cached.container.instantiateModelsToScene(n => `${n}#ghost`, false, { doNotInstantiate: true })
          for (const r of inst.rootNodes) r.parent = child
          for (const mesh of child.getChildMeshes(false) as AbstractMesh[]) {
            mesh.setEnabled(true)
            mesh.isPickable = false
          }
        } catch (err) {
          console.warn('[editor] ghost model failed', m.source, err)
        }
      }
    }
    if (this.ghost !== ghost) for (const pr of ghost.proxies) this.disposeProxy(pr)
    else if (this.aim) this.moveGhost(this.aim.x, this.aim.z)
    this.host.invalidate()
  }

  /** The ghost follows the ground point under the cursor. */
  moveGhost(x: number, z: number): void {
    const g = this.ghost
    if (!g) return
    this.aim = { x, z }
    g.node.position.set(x, this.host.ground(x, z) ?? 0, z)
    for (let i = 0; i < g.items.length; i++) {
      const c = g.proxies[i]!.node
      c.computeWorldMatrix(true)
      const p = c.getAbsolutePosition()
      const gy = this.host.ground(p.x, p.z)
      if (gy !== null) c.position.y = gy - g.node.position.y
    }
    this.host.invalidate()
  }

  turnGhost(delta: number): void {
    const g = this.ghost
    if (!g) return
    g.yaw += delta
    g.node.rotationQuaternion = Quaternion.RotationYawPitchRoll(g.yaw, 0, 0)
    this.host.invalidate()
  }

  /**
   * A click: the ghost's objects become adds (one change), at `at`, the ground point under the click (the ghost is
   * moved there first, so a click without a mouse move lands where it was clicked, not where the ghost last was).
   * `again`: Shift keeps placing, the next ghost starting at the same point.
   */
  async landGhost(again: boolean, at: { x: number; z: number } | null): Promise<void> {
    const g = this.ghost
    if (!g) return
    // a click off the ground (the sky, past the map's edge) places nothing
    if (!at) return this.host.say('Click the ground to place it there.', 'warn')
    this.moveGhost(at.x, at.z)
    const { session } = this.host
    const states = new Map<ObjRef, ObjState>()
    const refs: ObjRef[] = []
    for (let i = 0; i < g.items.length; i++) {
      const it = g.items[i]!
      const c = g.proxies[i]!.node
      c.computeWorldMatrix(true)
      const p = c.getAbsolutePosition()
      const ref = session.objects.newAddRef()
      refs.push(ref)
      const gy = this.host.ground(p.x, p.z) ?? p.y
      const t = session.objects.templateOf(it.source)
      const tg = t ? this.host.baseGround(t.position[0], t.position[2]) : null
      const clearance = t && tg !== null ? t.position[1] - tg : 0
      states.set(ref, { source: it.source, position: [p.x, gy + clearance, p.z], yaw: it.yaw + g.yaw, scale: it.scale })
    }
    const source = g.source
    if (!again || !source) this.cancelGhost()
    const ok = await this.commitStates(states, g.verb)
    if (!ok) return
    if (again && source) {
      await this.beginPlace(source)
      return
    }
    await this.select(refs)
  }

  cancelGhost(): void {
    const g = this.ghost
    if (!g) return
    this.ghost = null
    for (const pr of g.proxies) this.disposeProxy(pr)
    g.node.dispose(false, false)
    this.host.invalidate()
  }

  /** The candidates for "keep objects on the ground" after a height stroke: vegetation and small props, never blockers. */
  followGround(box: { x0: number; z0: number; x1: number; z1: number }): ObjectChangeItem[] {
    const { session } = this.host
    const cx = (box.x0 + box.x1) / 2, cz = (box.z0 + box.z1) / 2
    const r = Math.hypot(box.x1 - box.x0, box.z1 - box.z0) / 2 + 2
    const items: ObjectChangeItem[] = []
    for (const { ref, state } of session.objects.near(cx, cz, r)) {
      const [x, , z] = state.position
      if (x < box.x0 - 2 || x > box.x1 + 2 || z < box.z0 - 2 || z > box.z1 + 2) continue
      const kind = this.kindOf(ref)
      if (kind === 'blocker') continue
      const g = this.host.ground(x, z)
      if (g === null) continue
      const y = Math.round((g + this.clearance(ref)) * 1e4) / 1e4
      if (Math.abs(y - state.position[1]) < 0.01) continue
      items.push({ ref, before: state, after: { ...state, position: [x, y, z] } })
    }
    return items
  }

  /** Blockers standing on ground a stroke changed (listed, never moved by themselves, §4.1). */
  blockersIn(box: { x0: number; z0: number; x1: number; z1: number }): number {
    const cx = (box.x0 + box.x1) / 2, cz = (box.z0 + box.z1) / 2
    const r = Math.hypot(box.x1 - box.x0, box.z1 - box.z0) / 2
    let n = 0
    for (const { ref, state } of this.host.session.objects.near(cx, cz, r)) {
      const [x, , z] = state.position
      if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) continue
      if (this.kindOf(ref) === 'blocker') n++
    }
    return n
  }
}

const navId = (p: { region: number; uid: number }) => (((p.region & 0xffff) << 16) | (p.uid & 0xffff)) >>> 0

/** Slab test: the entry distance along `d` (not normalised: world units) into the box, or null. */
function rayBox(o: Vector3, d: Vector3, min: Vector3, max: Vector3): number | null {
  let t0 = 0, t1 = Infinity
  for (const a of ['x', 'y', 'z'] as const) {
    const inv = 1 / d[a]
    let ta = (min[a] - o[a]) * inv, tb = (max[a] - o[a]) * inv
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
    if (t0 > t1) return null
  }
  return t0
}

/**
 * H12-BF-1: Babylon's PlaneRotationGizmo draws its swept-angle disc with a GLSL-only ShaderMaterial ('rotationGizmo',
 * no WGSL source), which must never reach the editor's WebGPU engine (guardGlsl blocks it; without the guard Babylon
 * would fetch glslang + twgsl from its CDN). The disc gets a plain unlit translucent material instead (the same on
 * WebGL and WebGPU: a full disc while turning, not the swept wedge); the GLSL material is disposed (it leaves the
 * utility scene), and the gizmo's own setVector3 / setColor3 calls on it stay harmless.
 */
function replaceRotationDiscs(gm: GizmoManager, rings: readonly IPlaneRotationGizmo[]): void {
  const scene = gm.utilityLayer.utilityLayerScene
  const disc = new StandardMaterial('editorTurnDisc', scene)
  disc.disableLighting = true
  disc.emissiveColor = new Color3(1, 0.85, 0.25)
  disc.diffuseColor = Color3.Black()
  disc.specularColor = Color3.Black()
  disc.alpha = 0.22
  disc.backFaceCulling = false
  for (const ring of rings) {
    const g = ring as unknown as { _rotationDisplayPlane?: AbstractMesh; _rotationShaderMaterial?: { dispose(): void } }
    if (!g._rotationDisplayPlane) continue
    g._rotationShaderMaterial?.dispose()
    g._rotationDisplayPlane.material = disc
  }
}
