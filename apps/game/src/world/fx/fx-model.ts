/**
 * Skill objects that are models, not particle programs (docs/EFFECTS.md M2-M4): skilleffect rows whose object is a
 * `.bsr` (the nocked and flying arrows `cha_arrow_*.bsr`, the bandit archer's arrow, the White Hawk) play the glb the
 * effects export converted (fx index v2 `objectModel`). Containers load once per URL; each use instantiates its own
 * copy under a holder node posed every frame (position + a column-major rotation, like FxRootPose).
 */
import { AnimationGroup, LoadAssetContainerAsync, Matrix, Quaternion, TransformNode, Vector3, type AbstractMesh, type AssetContainer, type Scene, type Skeleton } from '@babylonjs/core'
import '@babylonjs/loaders/glTF/2.0/index.js'
import type { FxRootPose } from '@sro/fx'
import type { FxModelRef } from './types.ts'

export type FxModelLoader = (url: string, scene: Scene) => Promise<AssetContainer>

const defaultLoader: FxModelLoader = (url, scene) => LoadAssetContainerAsync(url, scene, { pluginExtension: '.glb' })

/** Imbued arrows (docs/EFFECTS.md M3 [likely]): the imbue's element picks the arrow model. */
export function arrowModel(base: FxModelRef | null | undefined, imbueGroup: string | null | undefined): FxModelRef | null {
  if (!base) return null
  const el = /_COLD_/.test(imbueGroup ?? '') ? 'cold' : /_FIRE_/.test(imbueGroup ?? '') ? 'fire' : /_LIGHTNING_/.test(imbueGroup ?? '') ? 'lighting' : null
  if (!el || !/cha_arrow_normal\.glb$/.test(base.glb)) return base
  return { glb: base.glb.replace(/cha_arrow_normal\.glb$/, `cha_arrow_${el}.glb`), sidecar: base.sidecar.replace(/cha_arrow_normal\.json$/, `cha_arrow_${el}.json`) }
}

/** The bow basic attack's arrow (no skilleffect row: a client rule, docs/EFFECTS.md §2.2). */
export const BASIC_ARROW: FxModelRef = { glb: '/out/item/china/weapon/cha_arrow_normal.glb', sidecar: '/out/item/china/weapon/cha_arrow_normal.json' }

/** Caches model containers per URL; `spawn` makes a posed copy (null until loaded: call `preload` first). */
export class FxModels {
  private readonly containers = new Map<string, AssetContainer | null>()
  private readonly loading = new Map<string, Promise<AssetContainer | null>>()
  private readonly failed = new Set<string>()
  private disposed = false

  constructor(private readonly scene: Scene, private readonly loader: FxModelLoader = defaultLoader) {}

  preload(url: string): Promise<AssetContainer | null> {
    let p = this.loading.get(url)
    if (!p) {
      p = this.loader(url, this.scene).then(
        c => {
          if (this.disposed) {
            c.dispose()
            return null
          }
          this.containers.set(url, c)
          return c
        },
        err => {
          if (!this.failed.has(url)) console.warn('[skills] effect model unavailable', url, err)
          this.failed.add(url)
          this.containers.set(url, null)
          return null
        },
      )
      this.loading.set(url, p)
    }
    return p
  }

  ready(url: string): boolean {
    return !!this.containers.get(url)
  }

  hasFailed(url: string): boolean {
    return this.failed.has(url)
  }

  /** A posed copy of `url` now, or null when it is not loaded (yet) or failed. */
  spawn(url: string, pose: () => FxRootPose, o: { clip?: string; scale?: number } = {}): FxModelInstance | null {
    const c = this.containers.get(url)
    if (!c || this.disposed) return null
    return new FxModelInstance(this.scene, c, pose, o)
  }

  dispose(): void {
    this.disposed = true
    for (const c of this.containers.values()) c?.dispose()
    this.containers.clear()
  }
}

const tmpM = new Matrix()
const tmpS = new Vector3()
const tmpP = new Vector3()

/** One model in the world, re-posed on every update; `stop` hides it (it is done at once). */
export class FxModelInstance {
  readonly holder: TransformNode
  private readonly nodes: TransformNode[]
  private readonly groups: AnimationGroup[]
  private readonly meshes: AbstractMesh[]
  private readonly skeletons: Skeleton[]
  private stopped = false
  private disposed = false

  constructor(scene: Scene, container: AssetContainer, private readonly pose: () => FxRootPose, o: { clip?: string; scale?: number }) {
    this.holder = new TransformNode('fx:model', scene)
    this.holder.rotationQuaternion = Quaternion.Identity()
    if (o.scale && o.scale !== 1) this.holder.scaling.setAll(o.scale)
    const inst = container.instantiateModelsToScene(n => `fx:${n}`, false, { doNotInstantiate: true })
    this.nodes = inst.rootNodes as TransformNode[]
    for (const n of this.nodes) n.parent = this.holder
    this.groups = inst.animationGroups
    this.skeletons = inst.skeletons
    this.meshes = this.holder.getChildMeshes(false)
    for (const m of this.meshes) {
      m.isPickable = false
      m.alwaysSelectAsActiveMesh = true
    }
    for (const g of this.groups) g.stop()
    const clip = o.clip ? this.groups.find(g => g.name === o.clip) ?? this.groups[0] : undefined
    clip?.start(true)
    this.place()
  }

  private place(): void {
    const p = this.pose()
    const r = p.rotation
    if (r) {
      Matrix.FromValuesToRef(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1, tmpM)
      tmpM.decompose(tmpS, this.holder.rotationQuaternion!, tmpP)
    }
    this.holder.position.set(p.position[0], p.position[1], p.position[2])
  }

  update(_dt: number): void {
    if (this.stopped || this.disposed) return
    this.place()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.holder.setEnabled(false)
  }

  get finished(): boolean {
    return this.stopped
  }

  get visible(): boolean {
    return !this.stopped && !this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const g of this.groups) g.dispose()
    for (const n of this.nodes) n.dispose(false, false)
    for (const k of this.skeletons) k.dispose()
    this.holder.dispose()
  }
}
