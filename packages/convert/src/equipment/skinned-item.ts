/**
 * Armour BSR -> glTF skinned to a character skeleton.
 *
 * Armour resources have no skeleton of their own: each BMS names Bip01 bones that belong to the wearer's
 * skeleton (europeman_skel.bsk / europewoman_skel.bsk). gltf/convert.ts writes such a resource as a static model,
 * so this module takes that document (materials, geometry and handedness exactly as convert.ts makes them) and
 * adds the wearer's skeleton: one joint node per BSK bone with the same names, order, rest pose and inverse binds
 * as the character glb, a Skin, JOINTS_0/WEIGHTS_0 from the BMS palettes, and the mesh nodes moved to the scene
 * root. At runtime the item binds to the character's joints by name (or shares its skeleton, the order being
 * identical) and plays every character clip.
 */
import type { Document, Node } from '@gltf-transform/core'
import { BMS_NO_BONE, parseBms, parseBsk, parseBsr, type BmsMesh, type BskSkeleton, type BskTransform } from '@sro/formats'
import { convertResource, type ReadFile, type Sidecar } from '../gltf/convert.ts'
import { mat4Multiply, rigidCompose, rigidInverse, rigidToMat4, toGltfTransform, type Quat, type Vec3 } from '../gltf/space.ts'

export interface SkinnedItemResult {
  document: Document
  sidecar: Sidecar
  joints: string[]
  /** Mesh node names (skinned, at the scene root). */
  meshes: string[]
  /** Bones the item's meshes name that the skeleton lacks (bound to the root; empty for every Chinese armour). */
  missingBones: string[]
}


/** Palette -> joint indices by name; the four heaviest influences, renormalised (as gltf/convert.ts does). */
export function skinAttributes(bms: BmsMesh, jointIndex: ReadonlyMap<string, number>, rootJoint: number,
  missing: Set<string>): { joints: Uint16Array; weights: Float32Array } {
  const palette = bms.boneNames.map(name => {
    const j = jointIndex.get(name)
    if (j === undefined) missing.add(name)
    return j ?? rootJoint
  })
  const n = bms.vertexCount
  const k = bms.influencesPerVertex
  const joints = new Uint16Array(n * 4)
  const weights = new Float32Array(n * 4)
  const acc = new Map<number, number>()
  for (let v = 0; v < n; v++) {
    acc.clear()
    for (let s = 0; s < k; s++) {
      const bone = bms.skinBones?.[v * k + s] ?? BMS_NO_BONE
      const w = (bms.skinWeights?.[v * k + s] ?? 0) / 65535
      if (bone === BMS_NO_BONE || !(w > 0) || bone >= palette.length) continue
      const j = palette[bone]!
      acc.set(j, (acc.get(j) ?? 0) + w)
    }
    let pairs = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4)
    let sum = pairs.reduce((t, p) => t + p[1], 0)
    if (!(sum > 0)) {
      pairs = [[palette[0] ?? rootJoint, 1]]
      sum = 1
    }
    for (let s = 0; s < 4; s++) {
      const p = pairs[s]
      joints[v * 4 + s] = p ? p[0] : 0
      weights[v * 4 + s] = p ? p[1] / sum : 0
    }
  }
  return { joints, weights }
}

/** Inverse bind matrices of a BSK in glTF space (column-major, 16 per joint), from the toParent chain. */
export function inverseBinds(bsk: BskSkeleton): { locals: BskTransform[]; ibm: Float32Array; maxIdentityError: number } {
  const locals = bsk.bones.map(b => toGltfTransform(b.toParent))
  const world: BskTransform[] = []
  const visit = (i: number): BskTransform => {
    if (world[i]) return world[i]!
    const p = bsk.bones[i]!.parentIndex
    world[i] = p >= 0 && p !== i ? rigidCompose(visit(p), locals[i]!) : locals[i]!
    return world[i]!
  }
  const ibm = new Float32Array(16 * bsk.bones.length)
  let maxIdentityError = 0
  bsk.bones.forEach((_, i) => {
    const w = visit(i)
    const inv = rigidToMat4(rigidInverse(w))
    ibm.set(inv, i * 16)
    const id = mat4Multiply(rigidToMat4(w), inv)
    for (let e = 0; e < 16; e++) maxIdentityError = Math.max(maxIdentityError, Math.abs(id[e]! - (e % 5 === 0 ? 1 : 0)))
  })
  return { locals, ibm, maxIdentityError }
}

export function convertSkinnedItem(itemBsr: string, skeletonBsk: string, read: ReadFile): SkinnedItemResult {
  const bsr = parseBsr(read(itemBsr))
  if (bsr.skeleton?.attachBone) throw new Error(`${itemBsr}: attaches to ${bsr.skeleton.attachBone}; use the rigid (socket) path`)
  const { document: doc, sidecar } = convertResource(itemBsr, { read })
  const bsk = parseBsk(read(skeletonBsk))
  const root = doc.getRoot()
  const scene = root.getDefaultScene()!
  const buffer = root.listBuffers()[0]!
  const accessor = (type: 'VEC4' | 'MAT4', array: Float32Array | Uint16Array) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer)

  const { locals, ibm, maxIdentityError } = inverseBinds(bsk)
  if (maxIdentityError > 1e-4) throw new Error(`${skeletonBsk}: bind check failed (${maxIdentityError})`)
  const jointNodes: Node[] = bsk.bones.map((bone, i) =>
    doc.createNode(bone.name).setRotation(locals[i]!.rotation as Quat).setTranslation(locals[i]!.translation as Vec3))
  const roots: Node[] = []
  bsk.bones.forEach((bone, i) => {
    if (bone.parentIndex >= 0 && bone.parentIndex !== i) jointNodes[bone.parentIndex]!.addChild(jointNodes[i]!)
    else roots.push(jointNodes[i]!)
  })
  if (roots.length !== 1) throw new Error(`${skeletonBsk}: expected one root bone, found ${roots.length}`)
  const skin = doc.createSkin(skeletonBsk.replace(/\\/g, '/').split('/').pop()!.replace(/\.bsk$/i, ''))
    .setSkeleton(roots[0]!).setInverseBindMatrices(accessor('MAT4', ibm))
  for (const j of jointNodes) skin.addJoint(j)
  scene.addChild(roots[0]!)

  const jointIndex = new Map(bsk.bones.map((b, i) => [b.name, i]))
  const rootJoint = Math.max(0, bsk.bones.findIndex(b => b.parentIndex < 0))
  const missing = new Set<string>()
  const staticRoot = scene.listChildren().find(n => n !== roots[0] && !n.getMesh())
  const meshes: string[] = []
  for (const entry of sidecar.meshes) {
    const node = root.listNodes().find(n => n.getName() === entry.name && n.getMesh())
    if (!node) throw new Error(`${itemBsr}: mesh node ${entry.name} not found`)
    const bms = parseBms(read(entry.bms))
    const prim = node.getMesh()!.listPrimitives()[0]!
    const count = prim.getAttribute('POSITION')!.getCount()
    if (count !== bms.vertexCount) throw new Error(`${entry.name}: ${count} glTF vertices vs ${bms.vertexCount} BMS vertices`)
    if (!bms.boneNames.length || !bms.skinBones) throw new Error(`${entry.name}: no skin data`)
    const attrs = skinAttributes(bms, jointIndex, rootJoint, missing)
    prim.setAttribute('JOINTS_0', accessor('VEC4', attrs.joints)).setAttribute('WEIGHTS_0', accessor('VEC4', attrs.weights))
    node.getParentNode()?.removeChild(node)
    node.setSkin(skin)
    scene.addChild(node)
    entry.skinned = true
    meshes.push(entry.name)
  }
  if (staticRoot && staticRoot.listChildren().length === 0) staticRoot.dispose()

  const joints = bsk.bones.map(b => b.name)
  sidecar.skeleton = { bsk: skeletonBsk, joints, bindCheck: { maxIdentityError, maxHierarchyError: 0, staleToLocal: [] } }
  sidecar.stats.joints = joints.length
  if (missing.size) sidecar.warnings.push(`bones not in ${skeletonBsk}, bound to the root: ${[...missing].join(', ')}`)
  return { document: doc, sidecar, joints, meshes, missingBones: [...missing] }
}
