import {
  ArcRotateCamera,
  Color3,
  Color4,
  CreateLineSystem,
  DirectionalLight,
  HemisphericLight,
  LoadAssetContainerAsync,
  Quaternion,
  Scene,
  SkeletonViewer,
  TransformNode,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type AssetContainer,
  type Bone,
  type LinesMesh,
  type Skeleton,
} from '@babylonjs/core'
import { GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader.js'
import '@babylonjs/loaders/glTF/2.0/index.js'
import type { IndexEntry, Sidecar } from './types.ts'

export interface ModelStats {
  meshes: number
  vertices: number
  triangles: number
  skeletons: number
  bones: number
  materials: number
  textures: number
  animationGroups: number
  min: Vector3
  max: Vector3
  size: Vector3
  loadMs: number
}

export interface LoadedModel {
  entry: IndexEntry
  container: AssetContainer
  /** Top-level nodes of the imported hierarchy (the glTF loader's `__root__`). */
  roots: TransformNode[]
  sidecar?: Sidecar
  stats: ModelStats
}

/**
 * socket: SRO client rule for equipment, where the item sits on the bone with the bone's bind rotation cancelled.
 * bone: the item origin and axes are the bone's own. bind: cancels the full bind pose, for items authored in model space.
 */
export type AttachMode = 'socket' | 'bone' | 'bind'

export interface Attachment {
  model: LoadedModel
  boneName: string
  mode: AttachMode
}

export type ModelSource = string | File

const BACKGROUND = new Color4(0.24, 0.25, 0.27, 1)
const GRID_HALF_CELLS = 20
const NORMALS_VERTEX_BUDGET = 200_000

/** Lower "nice" step (1, 2 or 5 times a power of ten) at or below `x`. */
export function niceStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1
  const p = 10 ** Math.floor(Math.log10(x))
  const m = x / p
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p
}

function topLevelNodes(container: AssetContainer): TransformNode[] {
  const nodes: TransformNode[] = [...container.meshes, ...container.transformNodes]
  return nodes.filter(n => !n.parent)
}

function geometryMeshes(container: AssetContainer): AbstractMesh[] {
  return container.meshes.filter(m => m.getTotalVertices() > 0)
}

/** Scene, camera, lights, grid, and the currently loaded model plus an optional attachment. */
export class Viewer {
  readonly scene: Scene
  readonly camera: ArcRotateCamera
  readonly grid: LinesMesh
  gridStep = 1
  model: LoadedModel | null = null
  attachment: Attachment | null = null
  private skeletonViewers: SkeletonViewer[] = []
  private normalLines: LinesMesh[] = []
  private flags = { skeleton: false, wireframe: false, normals: false }
  private loadToken = 0
  private attachToken = 0

  constructor(readonly engine: AbstractEngine) {
    const scene = new Scene(engine)
    // glTF is right-handed; a right-handed scene keeps node transforms exactly as stored in the file,
    // so parenting one glb under another's joint needs no handedness fix-up.
    scene.useRightHandedSystem = true
    scene.clearColor = BACKGROUND
    scene.ambientColor = new Color3(0.2, 0.2, 0.2)
    this.scene = scene

    const camera = new ArcRotateCamera('camera', Math.PI / 2 - 0.5, 1.15, 5, Vector3.Zero(), scene)
    camera.wheelDeltaPercentage = 0.02
    camera.pinchDeltaPercentage = 0.002
    camera.minZ = 0.01
    camera.maxZ = 10_000
    const canvas = engine.getRenderingCanvas()
    if (canvas) camera.attachControl(canvas, true)
    this.camera = camera

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
    hemi.intensity = 0.75
    hemi.groundColor = new Color3(0.25, 0.25, 0.28)
    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.7).normalize(), scene)
    sun.intensity = 1.4

    this.grid = this.createGrid()
  }

  private createGrid(): LinesMesh {
    const n = GRID_HALF_CELLS
    const lines: Vector3[][] = []
    const colors: Color4[][] = []
    const minor = new Color4(0.42, 0.43, 0.46, 1)
    const major = new Color4(0.55, 0.56, 0.6, 1)
    for (let i = -n; i <= n; i++) {
      // X axis (red) and Z axis (blue) through the origin; every 10th line brighter.
      const zLine = i === 0 ? new Color4(0.25, 0.45, 0.95, 1) : i % 10 === 0 ? major : minor
      const xLine = i === 0 ? new Color4(0.9, 0.3, 0.3, 1) : i % 10 === 0 ? major : minor
      lines.push([new Vector3(i, 0, -n), new Vector3(i, 0, n)])
      colors.push([zLine, zLine])
      lines.push([new Vector3(-n, 0, i), new Vector3(n, 0, i)])
      colors.push([xLine, xLine])
    }
    const grid = CreateLineSystem('grid', { lines, colors }, this.scene)
    grid.isPickable = false
    grid.alwaysSelectAsActiveMesh = true
    return grid
  }

  setGridVisible(on: boolean): void {
    this.grid.setEnabled(on)
  }

  private async loadContainer(source: ModelSource): Promise<AssetContainer> {
    return LoadAssetContainerAsync(source, this.scene, {
      pluginOptions: { gltf: { animationStartMode: GLTFLoaderAnimationStartMode.NONE } },
    })
  }

  /** Loads a model and makes it the current one. Resolves null when a newer load superseded it. */
  async loadModel(entry: IndexEntry, source: ModelSource, sidecar?: Sidecar): Promise<LoadedModel | null> {
    const token = ++this.loadToken
    const t0 = performance.now()
    const container = await this.loadContainer(source)
    if (token !== this.loadToken) {
      container.dispose()
      return null
    }
    this.unloadModel()
    container.addAllToScene()
    const model: LoadedModel = { entry, container, roots: topLevelNodes(container), stats: this.computeStats(container), sidecar }
    model.stats.loadMs = performance.now() - t0
    this.model = model
    this.applyFlags()
    this.frame()
    return model
  }

  /** Called before the current model is disposed (the Equipment panel drops items bound to its skeleton). */
  onBeforeUnload: (() => void) | null = null

  unloadModel(): void {
    this.onBeforeUnload?.()
    this.detach()
    this.disposeSkeletonViewers()
    this.disposeNormals()
    if (this.model) {
      for (const g of this.model.container.animationGroups) g.stop(true)
      this.model.container.removeAllFromScene()
      this.model.container.dispose()
      this.model = null
    }
  }

  private computeStats(container: AssetContainer): ModelStats {
    const meshes = geometryMeshes(container)
    const { min, max } = this.computeBounds(container)
    return {
      meshes: meshes.length,
      vertices: meshes.reduce((n, m) => n + m.getTotalVertices(), 0),
      triangles: Math.round(meshes.reduce((n, m) => n + (m.getTotalIndices() || m.getTotalVertices()), 0) / 3),
      skeletons: container.skeletons.length,
      bones: container.skeletons.reduce((n, s) => n + s.bones.length, 0),
      materials: container.materials.length,
      textures: container.textures.length,
      animationGroups: container.animationGroups.length,
      min,
      max,
      size: max.subtract(min),
      loadMs: 0,
    }
  }

  /** World-space bounds of the current pose (skinning applied on the CPU). */
  computeBounds(container: AssetContainer): { min: Vector3; max: Vector3 } {
    for (const root of topLevelNodes(container)) {
      root.computeWorldMatrix(true)
      for (const n of root.getDescendants(false)) if (n instanceof TransformNode) n.computeWorldMatrix(true)
    }
    for (const s of container.skeletons) s.prepare(true)
    const min = new Vector3(Infinity, Infinity, Infinity)
    const max = new Vector3(-Infinity, -Infinity, -Infinity)
    for (const m of geometryMeshes(container)) {
      m.refreshBoundingInfo({ applySkeleton: true, applyMorph: true })
      const bb = m.getBoundingInfo().boundingBox
      min.minimizeInPlace(bb.minimumWorld)
      max.maximizeInPlace(bb.maximumWorld)
    }
    if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return { min: Vector3.Zero(), max: Vector3.Zero() }
    return { min, max }
  }

  /** Points the camera at the current model (or the origin) and rescales the grid to match. */
  frame(): void {
    const stats = this.model?.stats
    const min = stats?.min ?? new Vector3(-1, 0, -1)
    const max = stats?.max ?? new Vector3(1, 2, 1)
    const center = min.add(max).scale(0.5)
    const radius = Math.max(max.subtract(min).length() / 2, 1e-3)
    const cam = this.camera
    cam.setTarget(center)
    cam.alpha = Math.PI / 2 - 0.5
    cam.beta = 1.15
    cam.radius = (radius / Math.sin(cam.fov / 2)) * 1.05
    cam.lowerRadiusLimit = radius * 0.05
    cam.upperRadiusLimit = radius * 100
    cam.minZ = radius * 0.01
    cam.maxZ = radius * 1000
    cam.panningSensibility = 400 / radius
    this.gridStep = niceStep(radius / 4)
    this.grid.scaling.setAll(this.gridStep)
  }

  // ---- display toggles -------------------------------------------------------------------------

  setSkeletonVisible(on: boolean): void {
    this.flags.skeleton = on
    this.disposeSkeletonViewers()
    if (!on || !this.model) return
    const { container } = this.model
    for (const skeleton of container.skeletons) {
      const mesh = container.meshes.find(m => m.skeleton === skeleton) ?? null
      const viewer = new SkeletonViewer(skeleton, mesh, this.scene, false, 2, { displayMode: SkeletonViewer.DISPLAY_LINES })
      viewer.color = new Color3(1, 0.85, 0.2)
      this.skeletonViewers.push(viewer)
    }
  }

  setWireframe(on: boolean): void {
    this.flags.wireframe = on
    for (const c of [this.model?.container, this.attachment?.model.container]) {
      for (const mat of c?.materials ?? []) mat.wireframe = on
    }
  }

  /** Vertex normals as short lines. Drawn from the bind-pose vertex data, so they do not follow skinning. */
  setNormalsVisible(on: boolean): void {
    this.flags.normals = on
    this.disposeNormals()
    if (!on || !this.model) return
    const { size } = this.model.stats
    const len = Math.max(size.length() * 0.015, 1e-4)
    let budget = NORMALS_VERTEX_BUDGET
    for (const m of geometryMeshes(this.model.container)) {
      const p = m.getVerticesData('position')
      const n = m.getVerticesData('normal')
      if (!p || !n || budget <= 0) continue
      const count = Math.min(p.length / 3, n.length / 3, budget)
      budget -= count
      const lines: Vector3[][] = []
      for (let i = 0; i < count; i++) {
        const o = new Vector3(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!)
        lines.push([o, o.add(new Vector3(n[i * 3]!, n[i * 3 + 1]!, n[i * 3 + 2]!).scale(len))])
      }
      const ls = CreateLineSystem(`${m.name}.normals`, { lines }, this.scene)
      ls.color = new Color3(0.3, 0.85, 1)
      ls.isPickable = false
      ls.parent = m
      this.normalLines.push(ls)
    }
  }

  private applyFlags(): void {
    this.setSkeletonVisible(this.flags.skeleton)
    this.setWireframe(this.flags.wireframe)
    this.setNormalsVisible(this.flags.normals)
  }

  private disposeSkeletonViewers(): void {
    for (const v of this.skeletonViewers) v.dispose()
    this.skeletonViewers = []
  }

  private disposeNormals(): void {
    for (const l of this.normalLines) l.dispose()
    this.normalLines = []
  }

  /** Returns every skeleton to its rest pose (the node transforms stored in the file). */
  returnToRest(): void {
    for (const s of this.model?.container.skeletons ?? []) s.returnToRest()
  }

  // ---- attachments -----------------------------------------------------------------------------

  /** Names of nodes an attachment can be parented to: skeleton joints, or all transform nodes if there is no skin. */
  attachTargets(): string[] {
    const c = this.model?.container
    if (!c) return []
    const names = new Set<string>()
    for (const s of c.skeletons) for (const b of s.bones) names.add(b.getTransformNode()?.name ?? b.name)
    if (!names.size) for (const t of c.transformNodes) names.add(t.name)
    return [...names]
  }

  defaultAttachTarget(): string | undefined {
    const names = this.attachTargets()
    return names.find(n => /r hand/i.test(n)) ?? names.find(n => /hand/i.test(n)) ?? names[0]
  }

  private findTarget(name: string): { node: TransformNode; bone: Bone | null } | null {
    const c = this.model?.container
    if (!c) return null
    for (const s of c.skeletons as Skeleton[]) {
      for (const b of s.bones) {
        const node = b.getTransformNode()
        if (node && node.name === name) return { node, bone: b }
      }
    }
    const node = c.transformNodes.find(t => t.name === name) ?? c.meshes.find(m => m.name === name)
    return node ? { node, bone: null } : null
  }

  async attach(entry: IndexEntry, source: ModelSource, boneName: string, mode: AttachMode): Promise<Attachment | null> {
    const token = ++this.attachToken
    const t0 = performance.now()
    const container = await this.loadContainer(source)
    if (token !== this.attachToken || !this.model) {
      container.dispose()
      return null
    }
    const target = this.findTarget(boneName)
    if (!target) {
      container.dispose()
      throw new Error(`No bone or node named ${JSON.stringify(boneName)} in ${this.model.entry.id}`)
    }
    this.detach()
    container.addAllToScene()
    const roots = topLevelNodes(container)
    for (const root of roots) {
      root.parent = target.node
      root.position.setAll(0)
      root.scaling.setAll(1)
      root.rotationQuaternion = Quaternion.Identity()
      if (mode === 'bind' && target.bone) {
        target.bone.getAbsoluteInverseBindMatrix().decompose(root.scaling, root.rotationQuaternion, root.position)
      } else if (mode === 'socket' && target.bone) {
        // Native client (per OpenSRO's notes on ABC680/AB5870/AB68C0): the item root hangs under the
        // attach bone with only the bone's bind-pose world ROTATION cancelled; translation stays at the bone.
        target.bone.getAbsoluteInverseBindMatrix().decompose(undefined, root.rotationQuaternion, undefined)
      }
    }
    const stats = this.computeStats(container)
    stats.loadMs = performance.now() - t0
    this.attachment = { model: { entry, container, roots, stats }, boneName, mode }
    this.setWireframe(this.flags.wireframe)
    return this.attachment
  }

  detach(): void {
    this.attachToken++
    if (!this.attachment) return
    const { container } = this.attachment.model
    container.removeAllFromScene()
    container.dispose()
    this.attachment = null
  }

  dispose(): void {
    this.unloadModel()
    this.scene.dispose()
  }
}
