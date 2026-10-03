/**
 * The one place where Silkroad file space becomes glTF space (docs/CONVENTIONS.md, "Coordinate space & units").
 *
 * Silkroad (Direct3D) is left-handed, Y-up, and its models face -Z; glTF is right-handed, Y-up, and models face +Z.
 * The change of basis is the mirror M = diag(1, 1, -1) plus a uniform scale:
 *   position     (x, y, z)     -> s * (x, y, -z)
 *   direction    (x, y, z)     -> (x, y, -z)            (normals; unit length is kept)
 *   quaternion   (x, y, z, w)  -> (-x, -y, z, w)        (the rotation M R M; M is its own inverse)
 *   rigid T      (q, t)        -> (q', s * t')           (so convert(A * B) = convert(A) * convert(B))
 *   triangle     (a, b, c)     -> (a, c, b)             (det M = -1 turns front faces around)
 *   uv           unchanged     (Direct3D and glTF both put (0, 0) at the top-left texel)
 * Evidence for all of this is measured on the vSRO 1.188 bytes and recorded in docs/CONVENTIONS.md.
 */
import { bskMath, type BskTransform } from '@sro/formats'

export type Vec3 = [x: number, y: number, z: number]
export type Quat = [x: number, y: number, z: number, w: number]

/** One Silkroad unit is a decimetre: chinaman_adventurer stands 18.12 units tall = 1.81 m. */
export const UNIT_SCALE = 0.1

/** The raw index order has cross(b - a, c - a) along the stored vertex normal; the mirror reverses it. */
export const FLIP_WINDING = true

/** Change of basis as a column-major 4x4 (glTF layout), including the unit scale. */
export const BASIS_MATRIX: readonly number[] = [
  UNIT_SCALE, 0, 0, 0,
  0, UNIT_SCALE, 0, 0,
  0, 0, -UNIT_SCALE, 0,
  0, 0, 0, 1,
]

export function toGltfPosition(v: Readonly<Vec3>, scale = UNIT_SCALE): Vec3 {
  return [v[0] * scale, v[1] * scale, -v[2] * scale]
}

export function toGltfDirection(v: Readonly<Vec3>): Vec3 {
  return [v[0], v[1], -v[2]]
}

export function toGltfQuat(q: Readonly<Quat>): Quat {
  return [-q[0], -q[1], q[2], q[3]]
}

export function toGltfTransform(t: Readonly<BskTransform>, scale = UNIT_SCALE): BskTransform {
  return { rotation: toGltfQuat(t.rotation), translation: toGltfPosition(t.translation, scale) }
}

/** New array; 3 floats per element. */
export function toGltfPositions(src: ArrayLike<number>, scale = UNIT_SCALE): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i]! * scale
    out[i + 1] = src[i + 1]! * scale
    out[i + 2] = -src[i + 2]! * scale
  }
  return out
}

/** New array; 3 floats per element. */
export function toGltfDirections(src: ArrayLike<number>): Float32Array {
  return toGltfPositions(src, 1)
}

/** New array; 4 floats per element (x, y, z, w). */
export function toGltfQuats(src: ArrayLike<number>): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    out[i] = -src[i]!
    out[i + 1] = -src[i + 1]!
    out[i + 2] = src[i + 2]!
    out[i + 3] = src[i + 3]!
  }
  return out
}

/** New triangle list with the winding the mirror requires. */
export function toGltfIndices(src: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(src.length)
  for (let i = 0; i + 2 < src.length; i += 3) {
    out[i] = src[i]!
    out[i + 1] = FLIP_WINDING ? src[i + 2]! : src[i + 1]!
    out[i + 2] = FLIP_WINDING ? src[i + 1]! : src[i + 2]!
  }
  return out
}

/** Column-major 4x4 product a * b. */
export function mat4Multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!
      out[c * 4 + r] = s
    }
  }
  return out
}

/** Determinant of the upper-left 3x3 of a column-major 4x4. */
export function mat3Determinant(m: readonly number[]): number {
  return (
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!)
  )
}

/**
 * A file-space affine matrix (column-major, column vectors) re-expressed in glTF space: B * m * B^-1, B = BASIS_MATRIX.
 * For rigid transforms this equals rigidToMat4(toGltfTransform(t)).
 */
export function toGltfMatrix(m: readonly number[], scale = UNIT_SCALE): number[] {
  const b = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, -scale, 0, 0, 0, 0, 1]
  const bInv = [1 / scale, 0, 0, 0, 0, 1 / scale, 0, 0, 0, 0, -1 / scale, 0, 0, 0, 0, 1]
  return mat4Multiply(mat4Multiply(b, m), bInv)
}

export const { rigidCompose, rigidInverse, rigidToMat4, quatRotate, quatMultiply, quatNormalize } = bskMath
