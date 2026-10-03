/**
 * Reads the geometry of the small static glbs the effect exporter writes (packages/convert/src/fx/mesh.ts): the
 * first primitive of the first mesh, POSITION / TEXCOORD_0 (float) and u16/u32 indices. Keeps @sro/fx free of the
 * glTF loader package; anything unexpected throws.
 */

export interface FxMeshData {
  /** glTF space, metres, 3 per vertex. */
  positions: Float32Array
  /** 2 per vertex (0, 0 = top-left texel). */
  uvs: Float32Array
  /** Counter-clockwise front faces (glTF). */
  indices: Uint32Array
}

interface GltfJson {
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; mode?: number }> }>
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>
}

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

export function readGlbMesh(bytes: Uint8Array): FxMeshData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error('glb: bad magic')
  let offset = 12
  let json: GltfJson | undefined
  let bin: Uint8Array | undefined
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body)) as GltfJson
    else if (type === CHUNK_BIN) bin = body
    offset += 8 + length
  }
  if (!json || !bin) throw new Error('glb: missing JSON or BIN chunk')
  const prim = json.meshes?.[0]?.primitives[0]
  if (!prim || (prim.mode ?? 4) !== 4) throw new Error('glb: no triangle primitive')
  const read = (index: number, want: 'VEC3' | 'VEC2' | 'SCALAR'): Float32Array | Uint32Array => {
    const acc = json!.accessors?.[index]
    if (!acc || acc.type !== want || acc.bufferView === undefined) throw new Error(`glb: accessor ${index}`)
    const bv = json!.bufferViews![acc.bufferView]!
    const width = want === 'VEC3' ? 3 : want === 'VEC2' ? 2 : 1
    const size = acc.componentType === 5126 || acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 0
    if (!size) throw new Error(`glb: component type ${acc.componentType}`)
    const stride = bv.byteStride ?? width * size
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    const dv = new DataView(bin!.buffer, bin!.byteOffset, bin!.byteLength)
    const out = acc.componentType === 5126 ? new Float32Array(acc.count * width) : new Uint32Array(acc.count * width)
    for (let i = 0; i < acc.count; i++) {
      for (let k = 0; k < width; k++) {
        const at = base + i * stride + k * size
        out[i * width + k] =
          acc.componentType === 5126 ? dv.getFloat32(at, true) : acc.componentType === 5125 ? dv.getUint32(at, true) : dv.getUint16(at, true)
      }
    }
    return out
  }
  const positions = read(prim.attributes.POSITION!, 'VEC3') as Float32Array
  const count = positions.length / 3
  const uvs = prim.attributes.TEXCOORD_0 !== undefined ? (read(prim.attributes.TEXCOORD_0, 'VEC2') as Float32Array) : new Float32Array(count * 2)
  let indices: Uint32Array
  if (prim.indices !== undefined) indices = Uint32Array.from(read(prim.indices, 'SCALAR'))
  else indices = Uint32Array.from({ length: count }, (_, i) => i)
  for (const i of indices) if (i >= count) throw new Error('glb: index out of range')
  return { positions, uvs, indices }
}
