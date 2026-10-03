/**
 * Effect mesh (BMS in Particles.pk2) -> a minimal static glb: POSITION, NORMAL, TEXCOORD_0 and indices of one
 * primitive, no material (the effect program names the texture and blend state). Geometry goes through
 * ../gltf/space.ts. Skin data, if any, is dropped: effects move whole meshes (SetBANPos/SetBANRot tables).
 * The @sro/fx runtime reads these with packages/fx/src/glb.ts.
 */
import { Document } from '@gltf-transform/core'
import type { BmsMesh } from '@sro/formats'
import { toGltfDirections, toGltfIndices, toGltfPositions } from '../gltf/space.ts'

export interface EffectMeshInfo {
  vertices: number
  triangles: number
  /** Triangles dropped for out-of-range indices. */
  dropped: number
}

export function effectMeshDocument(bms: BmsMesh, name: string): { document: Document; info: EffectMeshInfo } {
  const n = bms.vertexCount
  const positions = toGltfPositions(bms.positions)
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i]!)) positions[i] = 0
  const normals = toGltfDirections(bms.normals)
  for (let v = 0; v < n; v++) {
    const o = v * 3
    const len = Math.hypot(normals[o]!, normals[o + 1]!, normals[o + 2]!)
    if (len > 1e-6 && Number.isFinite(len)) {
      normals[o] = normals[o]! / len
      normals[o + 1] = normals[o + 1]! / len
      normals[o + 2] = normals[o + 2]! / len
    } else {
      normals[o] = 0
      normals[o + 1] = 1
      normals[o + 2] = 0
    }
  }
  const uvs = new Float32Array(bms.uv0)
  for (let i = 0; i < uvs.length; i++) if (!Number.isFinite(uvs[i]!)) uvs[i] = 0
  const all = toGltfIndices(bms.indices)
  const kept: number[] = []
  let dropped = 0
  for (let i = 0; i + 2 < all.length; i += 3) {
    if (all[i]! >= n || all[i + 1]! >= n || all[i + 2]! >= n) dropped++
    else kept.push(all[i]!, all[i + 1]!, all[i + 2]!)
  }
  const doc = new Document()
  const buffer = doc.createBuffer()
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(n > 65535 ? new Uint32Array(kept) : new Uint16Array(kept)).setBuffer(buffer))
  const mesh = doc.createMesh(name).addPrimitive(prim)
  const node = doc.createNode(name).setMesh(mesh)
  doc.createScene(name).addChild(node)
  doc.getRoot().getAsset().generator = '@sro/convert fx/mesh.ts'
  return { document: doc, info: { vertices: n, triangles: kept.length / 3, dropped } }
}
