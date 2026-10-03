/**
 * A model's shadow-casting geometry from its .glb (WE-D's lightmap bake, ./shadows.ts; docs/WORLD_EDITOR.md §6.2 step 2,
 * D51; docs/WAVE_PLAN8.md D18). Node-free: the converter passes the file's bytes and a PNG decoder, the editor's worker
 * its own.
 *
 * Reads the default scene's node tree (matrix or TRS, composed), every triangle primitive's POSITION (float32) and
 * indices; for an alpha-tested (MASK) or blended material also TEXCOORD_0 and the base colour texture's alpha, so the
 * bake can cut leaf cards at 0.5. `tier`: when some node carries `extras.sroTier` (the tree tool's species glbs:
 * lod1, lod2), only the nodes of that tier (and their children) are read; a glb without tiers is read whole. Anything
 * the reader does not know (quantized or sparse accessors, other primitive modes) is skipped and counted, never
 * guessed.
 */

/** One mesh part in model space (node transforms applied). */
export interface ShadowMesh {
  /** x, y, z per vertex. */
  positions: Float32Array
  /** 3 per triangle. */
  indices: Uint32Array
  /** u, v per vertex, with `alpha`: the part is cut where the texture's alpha is below `cutoff`. */
  uvs?: Float32Array
  alpha?: AlphaTexture
}

export interface AlphaTexture {
  width: number
  height: number
  /** One byte per texel (alpha), row 0 = the image's top (v = 0). */
  alpha: Uint8Array
  /** 0..1 (the bake uses 0.5 for leaf cards, docs/WORLD_EDITOR.md D51). */
  cutoff: number
}

export interface ShadowCaster {
  meshes: ShadowMesh[]
  /** Model-space bounds of the read geometry. */
  min: [number, number, number]
  max: [number, number, number]
  /** Primitives skipped (unsupported). */
  skipped: number
}

/** Decodes an embedded image to 8-bit RGBA (null: unsupported; the part then casts as opaque). */
export type ImageDecoder = (mime: string, bytes: Uint8Array) => { width: number; height: number; rgba: Uint8Array } | null

/** The leaf-card cut (docs/WORLD_EDITOR.md D51). */
export const LEAF_CUTOFF = 0.5

interface GltfJson {
  scene?: number
  scenes?: Array<{ nodes?: number[] }>
  nodes?: Array<{ children?: number[]; mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; extras?: { sroTier?: unknown } }>
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number; mode?: number }> }>
  materials?: Array<{ alphaMode?: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number; texCoord?: number } } }>
  textures?: Array<{ source?: number }>
  images?: Array<{ bufferView?: number; mimeType?: string; uri?: string }>
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; sparse?: unknown }>
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>
}

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const FLOAT = 5126

/** Parses a .glb's shadow geometry (see the header); throws on a file that is not a glb. */
export function readShadowCaster(bytes: Uint8Array, opts: { tier?: number; decodeImage?: ImageDecoder } = {}): ShadowCaster {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 20 || dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('glb: bad magic at offset 0')
  let json: GltfJson | null = null
  let bin: Uint8Array | null = null
  for (let o = 12; o + 8 <= bytes.byteLength;) {
    const len = dv.getUint32(o, true)
    const type = dv.getUint32(o + 4, true)
    const data = bytes.subarray(o + 8, o + 8 + len)
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data)) as GltfJson
    else if (type === CHUNK_BIN && !bin) bin = data
    o += 8 + len + ((4 - (len % 4)) % 4)
  }
  if (!json) throw new Error('glb: no JSON chunk')
  const g = json
  const out: ShadowCaster = { meshes: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], skipped: 0 }

  const viewBytes = (index: number): { bytes: Uint8Array; stride: number } | null => {
    const v = g.bufferViews?.[index]
    if (!v || v.buffer !== 0 || !bin) return null
    const start = v.byteOffset ?? 0
    if (start + v.byteLength > bin.byteLength) return null
    return { bytes: bin.subarray(start, start + v.byteLength), stride: v.byteStride ?? 0 }
  }
  /** A float accessor as a packed Float32Array (null: unsupported). */
  const floats = (index: number, comps: number): Float32Array | null => {
    const a = g.accessors?.[index]
    if (!a || a.sparse || a.componentType !== FLOAT || COMPONENTS[a.type] !== comps || a.bufferView === undefined) return null
    const v = viewBytes(a.bufferView)
    if (!v) return null
    const stride = v.stride || comps * 4
    const base = a.byteOffset ?? 0
    if (a.count && base + (a.count - 1) * stride + comps * 4 > v.bytes.byteLength) return null
    const src = new DataView(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength)
    const outA = new Float32Array(a.count * comps)
    for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) outA[i * comps + c] = src.getFloat32(base + i * stride + c * 4, true)
    return outA
  }
  const indexList = (index: number | undefined, count: number): Uint32Array | null => {
    if (index === undefined) return Uint32Array.from({ length: count }, (_, i) => i)
    const a = g.accessors?.[index]
    if (!a || a.sparse || a.type !== 'SCALAR' || a.bufferView === undefined) return null
    const v = viewBytes(a.bufferView)
    if (!v) return null
    const size = a.componentType === 5121 ? 1 : a.componentType === 5123 ? 2 : a.componentType === 5125 ? 4 : 0
    if (!size) return null
    const stride = v.stride || size
    const base = a.byteOffset ?? 0
    if (a.count && base + (a.count - 1) * stride + size > v.bytes.byteLength) return null
    const src = new DataView(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength)
    const outI = new Uint32Array(a.count)
    for (let i = 0; i < a.count; i++) {
      const o = base + i * stride
      outI[i] = size === 1 ? src.getUint8(o) : size === 2 ? src.getUint16(o, true) : src.getUint32(o, true)
    }
    return outI
  }
  const alphaCache = new Map<number, AlphaTexture | null>()
  const alphaOf = (textureIndex: number): AlphaTexture | null => {
    if (alphaCache.has(textureIndex)) return alphaCache.get(textureIndex)!
    let tex: AlphaTexture | null = null
    const img = g.images?.[g.textures?.[textureIndex]?.source ?? -1]
    if (img && img.bufferView !== undefined && opts.decodeImage) {
      const v = viewBytes(img.bufferView)
      const decoded = v ? safeDecode(opts.decodeImage, img.mimeType ?? 'image/png', v.bytes) : null
      if (decoded && decoded.rgba.length === decoded.width * decoded.height * 4) {
        const alpha = new Uint8Array(decoded.width * decoded.height)
        for (let i = 0; i < alpha.length; i++) alpha[i] = decoded.rgba[i * 4 + 3]!
        tex = { width: decoded.width, height: decoded.height, alpha, cutoff: LEAF_CUTOFF }
      }
    }
    alphaCache.set(textureIndex, tex)
    return tex
  }

  const tiered = (g.nodes ?? []).some(n => typeof n.extras?.sroTier === 'number')
  const visit = (ni: number, parent: Float64Array, inTier: boolean, depth: number) => {
    const n = g.nodes?.[ni]
    if (!n || depth > 64) return
    const m = mul(parent, nodeMatrix(n))
    const tierHere = typeof n.extras?.sroTier === 'number' ? n.extras.sroTier === (opts.tier ?? 1) : inTier
    if (n.mesh !== undefined && (!tiered || tierHere)) {
      for (const prim of g.meshes?.[n.mesh]?.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) {
          out.skipped++
          continue
        }
        const pos = floats(prim.attributes.POSITION, 3)
        const idx = pos ? indexList(prim.indices, pos.length / 3) : null
        if (!pos || !idx || idx.length % 3) {
          out.skipped++
          continue
        }
        const world = new Float32Array(pos.length)
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i]!
          const y = pos[i + 1]!
          const z = pos[i + 2]!
          for (let c = 0; c < 3; c++) {
            const w = m[c]! * x + m[4 + c]! * y + m[8 + c]! * z + m[12 + c]!
            world[i + c] = w
            if (w < out.min[c]!) out.min[c] = w
            if (w > out.max[c]!) out.max[c] = w
          }
        }
        const mesh: ShadowMesh = { positions: world, indices: idx }
        const mat = prim.material !== undefined ? g.materials?.[prim.material] : undefined
        const tex = mat?.pbrMetallicRoughness?.baseColorTexture
        if ((mat?.alphaMode === 'MASK' || mat?.alphaMode === 'BLEND') && tex && (tex.texCoord ?? 0) === 0 && prim.attributes.TEXCOORD_0 !== undefined) {
          const uvs = floats(prim.attributes.TEXCOORD_0, 2)
          const alpha = uvs && uvs.length / 2 === pos.length / 3 ? alphaOf(tex.index) : null
          if (uvs && alpha) {
            mesh.uvs = uvs
            mesh.alpha = alpha
          }
        }
        out.meshes.push(mesh)
      }
    }
    for (const c of n.children ?? []) visit(c, m, tierHere, depth + 1)
  }
  const scene = g.scenes?.[g.scene ?? 0]
  const roots = scene?.nodes ?? (g.nodes ?? []).map((_, i) => i)
  for (const r of roots) visit(r, IDENTITY, false, 0)
  return out
}

function safeDecode(decode: ImageDecoder, mime: string, bytes: Uint8Array) {
  try {
    return decode(mime, bytes)
  } catch {
    return null
  }
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/** Column-major 4 x 4 of a glTF node (matrix, else T x R x S). */
function nodeMatrix(n: { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }): Float64Array {
  if (n.matrix && n.matrix.length === 16) return Float64Array.from(n.matrix)
  const [tx, ty, tz] = n.translation ?? [0, 0, 0]
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = n.scale ?? [1, 1, 1]
  const xx = qx! * qx!, yy = qy! * qy!, zz = qz! * qz!
  const xy = qx! * qy!, xz = qx! * qz!, yz = qy! * qz!
  const wx = qw! * qx!, wy = qw! * qy!, wz = qw! * qz!
  return new Float64Array([
    (1 - 2 * (yy + zz)) * sx!, 2 * (xy + wz) * sx!, 2 * (xz - wy) * sx!, 0,
    2 * (xy - wz) * sy!, (1 - 2 * (xx + zz)) * sy!, 2 * (yz + wx) * sy!, 0,
    2 * (xz + wy) * sz!, 2 * (yz - wx) * sz!, (1 - 2 * (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ])
}

function mul(a: Float64Array, b: Float64Array): Float64Array {
  const o = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!
    }
  }
  return o
}
