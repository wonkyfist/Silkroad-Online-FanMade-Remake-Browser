// Draws a Composition (@sro/appearance composeEquipment) on the loaded character: hides the replaced
// base meshes, binds skinned items to the character skeleton, and hangs socket items on their attach bone.
import {
  LoadAssetContainerAsync,
  Quaternion,
  type AbstractMesh,
  type AssetContainer,
  type Bone,
  type Scene,
  type Skeleton,
  type TransformNode,
} from '@babylonjs/core'
import { GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader.js'
import type { BoundItem, Composition } from '@sro/appearance'
import type { LoadedModel } from '../viewer.ts'

export interface DressedItem {
  item: BoundItem
  container: AssetContainer
  /** How a skinned item was bound: sharing the character skeleton (same joint order) or bones linked by name. */
  binding: 'shared-skeleton' | 'linked-by-name' | 'socket'
}

const OUT_BASE = new URL('out/', document.baseURI)

/** '/out/equipment/x.glb' -> absolute URL under the viewer's /out/. */
export function outUrlOf(glb: string): string {
  return new URL(glb.replace(/^\/?out\//, '').split('/').map(encodeURIComponent).join('/'), OUT_BASE).href
}

function jointNodes(skeleton: Skeleton): Map<string, { node: TransformNode; bone: Bone }> {
  const map = new Map<string, { node: TransformNode; bone: Bone }>()
  for (const bone of skeleton.bones) {
    const node = bone.getTransformNode()
    if (node) map.set(node.name, { node, bone })
  }
  return map
}

export class Dresser {
  private items: DressedItem[] = []
  private hidden: AbstractMesh[] = []
  private token = 0

  constructor(private readonly scene: Scene) {}

  get dressed(): readonly DressedItem[] {
    return this.items
  }

  /** Removes every item and shows the base meshes again. */
  clear(): void {
    this.token++
    for (const d of this.items) {
      d.container.removeAllFromScene()
      d.container.dispose()
    }
    this.items = []
    for (const m of this.hidden) if (!m.isDisposed()) m.setEnabled(true)
    this.hidden = []
  }

  /** Dresses `model` (the character the composition was made for). Resolves false if superseded. */
  async apply(model: LoadedModel, comp: Composition, wireframe = false): Promise<boolean> {
    this.clear()
    const token = this.token
    const skeleton = model.container.skeletons[0]
    if (!skeleton) throw new Error(`${model.entry.id} has no skeleton`)
    const joints = jointNodes(skeleton)
    const loaded = await Promise.all(comp.bind.map(item => LoadAssetContainerAsync(outUrlOf(item.glb), this.scene, {
      pluginOptions: { gltf: { animationStartMode: GLTFLoaderAnimationStartMode.NONE } },
    })))
    if (token !== this.token) {
      for (const c of loaded) c.dispose()
      return false
    }
    const byName = new Map(model.container.meshes.map(m => [m.name, m]))
    for (const name of comp.hide) {
      const mesh = byName.get(name)
      if (!mesh) throw new Error(`${model.entry.id}: no mesh ${JSON.stringify(name)} to hide`)
      mesh.setEnabled(false)
      this.hidden.push(mesh)
    }
    const root = model.roots[0] ?? null
    comp.bind.forEach((item, i) => {
      const container = loaded[i]!
      container.addAllToScene()
      if (wireframe) for (const mat of container.materials) mat.wireframe = true
      const tops = [...container.meshes, ...container.transformNodes].filter(n => !n.parent)
      let binding: DressedItem['binding']
      if (item.kind === 'skinned') {
        binding = this.bindSkinned(container, skeleton, joints, item)
        for (const t of tops) t.parent = root
      } else {
        binding = 'socket'
        const target = item.attachBone ? joints.get(item.attachBone) : undefined
        if (!target) throw new Error(`${item.code}: no bone ${JSON.stringify(item.attachBone)} on ${model.entry.id}`)
        for (const t of tops) {
          t.parent = target.node
          t.position.setAll(0)
          t.scaling.setAll(1)
          t.rotationQuaternion = Quaternion.Identity()
          // SRO socket rule (docs/CONVENTIONS.md): cancel only the bone's bind-pose world rotation.
          target.bone.getAbsoluteInverseBindMatrix().decompose(undefined, t.rotationQuaternion, undefined)
        }
      }
      this.items.push({ item, container, binding })
    })
    return true
  }

  private bindSkinned(container: AssetContainer, skeleton: Skeleton, joints: Map<string, { node: TransformNode; bone: Bone }>,
    item: BoundItem): DressedItem['binding'] {
    const own = container.skeletons[0]
    if (!own) throw new Error(`${item.code}: skinned item without a skin`)
    const missing = own.bones.map(b => b.getTransformNode()?.name ?? b.name).filter(n => !joints.has(n))
    if (missing.length) throw new Error(`${item.code}: joints not on the character: ${missing.join(', ')}`)
    const same = own.bones.length === skeleton.bones.length &&
      own.bones.every((b, i) => (b.getTransformNode()?.name ?? b.name) === (skeleton.bones[i]!.getTransformNode()?.name ?? skeleton.bones[i]!.name))
    if (same) {
      // Same joints in the same order with the same inverse binds (checked by the converter tests): share it.
      for (const mesh of container.meshes) if (mesh.skeleton === own) mesh.skeleton = skeleton
      return 'shared-skeleton'
    }
    for (const bone of own.bones) bone.linkTransformNode(joints.get(bone.getTransformNode()?.name ?? bone.name)!.node)
    return 'linked-by-name'
  }
}
