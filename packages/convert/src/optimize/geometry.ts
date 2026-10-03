/**
 * Geometry pass (KHR_mesh_quantization + EXT_meshopt_compression) and its numeric check.
 *
 * Quantization keeps vertex order (no reorder), so the check compares every vertex with its original:
 * positions after skinning at the bind pose (and at sampled animation poses when given), normals by angle,
 * texture coordinates by absolute difference. Meshopt is used in its lossless "quantize" mode: it only
 * byte-codes what quantization produced, and animation keys are never altered.
 */
import { Accessor as AccessorClass } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { dedup, prune, quantize } from '@gltf-transform/functions'
import type { Accessor, Document, Mesh, Node } from '@gltf-transform/core'

export interface GeometryOptions {
  /** 14 bits over a 2 m character = 0.12 mm steps; 16 bits over a 100 m building = 1.5 mm steps. */
  positionBits: number
  normalBits: number
  texcoordBits: number
  weightBits: number
  /**
   * Upper bound for the position rounding error. A document whose largest mesh would exceed it at positionBits
   * (half-extent / (2^(bits-1) - 1) / 2 * sqrt(3)) keeps float positions: long town walls span ~500 m.
   */
  maxPositionErrorMm: number
}

export const CHARACTER_GEOMETRY: GeometryOptions = { positionBits: 14, normalBits: 10, texcoordBits: 14, weightBits: 16, maxPositionErrorMm: 0.5 }
export const WORLD_GEOMETRY: GeometryOptions = { positionBits: 16, normalBits: 10, texcoordBits: 14, weightBits: 16, maxPositionErrorMm: 1 }

/** Predicted worst-case rounding error (mm) of quantizing this mesh's positions to `bits` (quantizationVolume 'mesh'). */
export function predictedPositionErrorMm(mesh: Mesh, bits: number): number {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')
    if (!pos) continue
    const a = pos.getMin([])
    const b = pos.getMax([])
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, a[i]!)
      max[i] = Math.max(max[i]!, b[i]!)
    }
  }
  if (!Number.isFinite(min[0]!)) return 0
  const half = Math.max((max[0]! - min[0]!) / 2, (max[1]! - min[1]!) / 2, (max[2]! - min[2]!) / 2)
  return (half / (2 ** (bits - 1) - 1) / 2) * Math.sqrt(3) * 1000
}

/**
 * Position quantization needs a dequantization transform: on the mesh's node for static meshes, folded into the
 * inverse bind matrices (one cloned skin per mesh) for skinned ones. Both would change contracts the runtimes rely
 * on: equipment shares the character skeleton and its inverse binds (viewer dresser 'shared-skeleton'), clips and
 * sockets find nodes by name, and a mesh node with children or animation would get an unnamed child inserted.
 * So positions stay float32 whenever the document has a skin, or any mesh node has children or is animated;
 * normals, UVs, joints and weights are quantized regardless (they need no transform).
 */
export function positionQuantizationSafe(doc: Document, opts?: GeometryOptions): boolean {
  if (doc.getRoot().listSkins().length) return false
  if (opts && doc.getRoot().listMeshes().some(m => predictedPositionErrorMm(m, opts.positionBits) > opts.maxPositionErrorMm)) return false
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh()) continue
    if (node.listChildren().length) return false
    if (node.listParents().some(p => p.propertyType === 'AnimationChannel')) return false
  }
  return true
}

/** dedup + prune + quantize, then marks the document for lossless meshopt byte coding on write. */
export async function optimizeGeometry(doc: Document, opts: GeometryOptions): Promise<{ positionsQuantized: boolean }> {
  await doc.transform(
    dedup({ keepUniqueNames: true }),
    prune({ keepLeaves: true, keepAttributes: true, keepIndices: true, keepSolidTextures: true, keepExtras: true }),
  )
  const positionsQuantized = positionQuantizationSafe(doc, opts)
  if (doc.getRoot().listMeshes().length) {
    await doc.transform(quantize({
      pattern: positionsQuantized ? /.*/ : /^(?!POSITION$).*/,
      quantizationVolume: 'mesh',
      quantizePosition: opts.positionBits,
      quantizeNormal: opts.normalBits,
      quantizeTexcoord: opts.texcoordBits,
      quantizeWeight: opts.weightBits,
      quantizeColor: 8,
      quantizeGeneric: 16,
    }))
  }
  // quantize() only adds KHR_mesh_quantization when POSITION changed; quantized normals/UVs need it as well.
  if (needsMeshQuantization(doc)) doc.createExtension(KHRMeshQuantization).setRequired(true)
  if (doc.getRoot().listAccessors().length) {
    doc.createExtension(EXTMeshoptCompression).setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE })
  }
  return { positionsQuantized }
}

/** True when an attribute uses a format that core glTF 2.0 does not allow for its semantic. */
export function needsMeshQuantization(doc: Document): boolean {
  const { FLOAT, UNSIGNED_BYTE, UNSIGNED_SHORT } = AccessorClass.ComponentType
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const sem of prim.listSemantics()) {
        const a = prim.getAttribute(sem)!
        const ct = a.getComponentType()
        if (sem === 'POSITION' || sem === 'NORMAL' || sem === 'TANGENT') {
          if (ct !== FLOAT) return true
        } else if (sem.startsWith('TEXCOORD_')) {
          if (ct !== FLOAT && !((ct === UNSIGNED_BYTE || ct === UNSIGNED_SHORT) && a.getNormalized())) return true
        }
      }
    }
  }
  return false
}

// ---- small mat4 helpers (column-major, glTF convention) ----

type M4 = Float64Array

export function mul(a: ArrayLike<number>, b: ArrayLike<number>): M4 {
  const o = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!
      o[c * 4 + r] = s
    }
  }
  return o
}

export function composeTRS(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): M4 {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!]
  const o = new Float64Array(16)
  o[0] = (1 - 2 * (y * y + z * z)) * s[0]!
  o[1] = 2 * (x * y + z * w) * s[0]!
  o[2] = 2 * (x * z - y * w) * s[0]!
  o[4] = 2 * (x * y - z * w) * s[1]!
  o[5] = (1 - 2 * (x * x + z * z)) * s[1]!
  o[6] = 2 * (y * z + x * w) * s[1]!
  o[8] = 2 * (x * z + y * w) * s[2]!
  o[9] = 2 * (y * z - x * w) * s[2]!
  o[10] = (1 - 2 * (x * x + y * y)) * s[2]!
  o[12] = t[0]!
  o[13] = t[1]!
  o[14] = t[2]!
  o[15] = 1
  return o
}

function applyPoint(m: ArrayLike<number>, p: ArrayLike<number>, out: number[], k: number): void {
  out[0]! += k * (m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!)
  out[1]! += k * (m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!)
  out[2]! += k * (m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!)
}

/** Local TRS overrides by node name (a sampled animation pose); unnamed or unlisted nodes keep their rest TRS. */
export type Pose = Map<string, { t?: number[]; r?: number[]; s?: number[] }>

function worldMatrices(doc: Document, pose?: Pose): Map<Node, M4> {
  const out = new Map<Node, M4>()
  const visit = (n: Node, parent: M4 | null) => {
    const o = pose?.get(n.getName())
    const local = composeTRS(o?.t ?? n.getTranslation(), o?.r ?? n.getRotation(), o?.s ?? n.getScale())
    const world = parent ? mul(parent, local) : local
    out.set(n, world)
    for (const c of n.listChildren()) visit(c, world)
  }
  const roots = doc.getRoot().listNodes().filter(n => !n.getParentNode())
  for (const r of roots) visit(r, null)
  return out
}

/** Final (world-space, skinned when skinned) vertex positions of every primitive of every mesh instance. */
export function evaluatePositions(doc: Document, pose?: Pose): Map<string, Float64Array[]> {
  const worlds = worldMatrices(doc, pose)
  const result = new Map<string, Float64Array[]>()
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const skin = node.getSkin()
    let jointMats: M4[] | null = null
    if (skin) {
      const ibm = skin.getInverseBindMatrices()
      const e: number[] = []
      jointMats = skin.listJoints().map((j, i) => {
        if (ibm) ibm.getElement(i, e)
        return mul(worlds.get(j)!, ibm ? e : identity())
      })
    }
    const nodeWorld = worlds.get(node)!
    mesh.listPrimitives().forEach((prim, pi) => {
      const pos = prim.getAttribute('POSITION')
      if (!pos) return
      const joints = prim.getAttribute('JOINTS_0')
      const weights = prim.getAttribute('WEIGHTS_0')
      const joints1 = prim.getAttribute('JOINTS_1')
      const weights1 = prim.getAttribute('WEIGHTS_1')
      const n = pos.getCount()
      const out = new Float64Array(n * 3)
      const p: number[] = []
      const j: number[] = []
      const w: number[] = []
      for (let i = 0; i < n; i++) {
        pos.getElement(i, p)
        const acc = [0, 0, 0]
        if (jointMats && joints && weights) {
          const sets: [Accessor, Accessor][] = [[joints, weights]]
          if (joints1 && weights1) sets.push([joints1, weights1])
          for (const [ja, wa] of sets) {
            ja.getElement(i, j)
            wa.getElement(i, w)
            for (let k = 0; k < j.length; k++) if (w[k]) applyPoint(jointMats[j[k]!]!, p, acc, w[k]!)
          }
        } else {
          applyPoint(nodeWorld, p, acc, 1)
        }
        out[i * 3] = acc[0]!
        out[i * 3 + 1] = acc[1]!
        out[i * 3 + 2] = acc[2]!
      }
      const key = `${mesh.getName()}#${pi}`
      const list = result.get(key) ?? []
      list.push(out)
      result.set(key, list)
    })
  }
  return result
}

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** Largest distance from any point of `a` to its counterpart in `b` (same index when counts match, else nearest). */
export function maxPointError(a: Float64Array, b: Float64Array): number {
  let max = 0
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i += 3) {
      const d = Math.hypot(a[i]! - b[i]!, a[i + 1]! - b[i + 1]!, a[i + 2]! - b[i + 2]!)
      if (d > max) max = d
    }
    return max
  }
  return Math.max(directedHausdorff(a, b), directedHausdorff(b, a))
}

function directedHausdorff(a: Float64Array, b: Float64Array): number {
  let max = 0
  for (let i = 0; i < a.length; i += 3) {
    let best = Infinity
    for (let k = 0; k < b.length; k += 3) {
      const d = (a[i]! - b[k]!) ** 2 + (a[i + 1]! - b[k + 1]!) ** 2 + (a[i + 2]! - b[k + 2]!) ** 2
      if (d < best) best = d
    }
    max = Math.max(max, Math.sqrt(best))
  }
  return max
}

export interface GeometryError {
  /** Max vertex position error in millimetres (bind pose and every sampled pose). */
  maxPositionMm: number
  /** Max normal direction error in degrees. */
  maxNormalDeg: number
  /** Max absolute texture-coordinate error (all TEXCOORD_n). */
  maxTexcoord: number
  vertices: number
  unmatchedPrimitives: string[]
}

function primitiveAttrs(doc: Document): Map<string, Map<string, Accessor>> {
  const out = new Map<string, Map<string, Accessor>>()
  for (const mesh of doc.getRoot().listMeshes()) {
    mesh.listPrimitives().forEach((prim, pi) => {
      const m = new Map<string, Accessor>()
      for (const s of prim.listSemantics()) m.set(s, prim.getAttribute(s)!)
      out.set(`${mesh.getName()}#${pi}`, m)
    })
  }
  return out
}

/** Compares the geometry of an optimized document against its source. */
export function geometryError(before: Document, after: Document, poses: Pose[] = []): GeometryError {
  let maxPos = 0
  let vertices = 0
  const unmatched: string[] = []
  for (const pose of [undefined, ...poses]) {
    const a = evaluatePositions(before, pose)
    const b = evaluatePositions(after, pose)
    for (const [key, listA] of a) {
      const listB = b.get(key)
      if (!listB) {
        if (!unmatched.includes(key)) unmatched.push(key)
        continue
      }
      for (const pa of listA) {
        if (!pose) vertices += pa.length / 3
        let best = Infinity
        for (const pb of listB) best = Math.min(best, maxPointError(pa, pb))
        maxPos = Math.max(maxPos, best)
      }
    }
  }
  let maxNormal = 0
  let maxUv = 0
  const aa = primitiveAttrs(before)
  const bb = primitiveAttrs(after)
  for (const [key, attrsA] of aa) {
    const attrsB = bb.get(key)
    if (!attrsB) continue
    for (const [sem, accA] of attrsA) {
      const accB = attrsB.get(sem)
      if (!accB || accA.getCount() !== accB.getCount()) continue
      const x: number[] = []
      const y: number[] = []
      if (sem === 'NORMAL') {
        for (let i = 0; i < accA.getCount(); i++) {
          accA.getElement(i, x)
          accB.getElement(i, y)
          const la = Math.hypot(x[0]!, x[1]!, x[2]!)
          const lb = Math.hypot(y[0]!, y[1]!, y[2]!)
          if (!la || !lb) continue
          const c = Math.min(1, Math.max(-1, (x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!) / (la * lb)))
          maxNormal = Math.max(maxNormal, (Math.acos(c) * 180) / Math.PI)
        }
      } else if (sem.startsWith('TEXCOORD_')) {
        for (let i = 0; i < accA.getCount(); i++) {
          accA.getElement(i, x)
          accB.getElement(i, y)
          maxUv = Math.max(maxUv, Math.abs(x[0]! - y[0]!), Math.abs(x[1]! - y[1]!))
        }
      }
    }
  }
  return { maxPositionMm: maxPos * 1000, maxNormalDeg: maxNormal, maxTexcoord: maxUv, vertices, unmatchedPrimitives: unmatched }
}

export function meshNames(doc: Document): string[] {
  return doc.getRoot().listMeshes().map((m: Mesh) => m.getName())
}
