/**
 * Minimal rigid-transform math on raw file-space tuples (no handedness change).
 *
 * Quaternions are [x, y, z, w] (the order Joymax stores them and glTF uses), Hamilton product,
 * rotating a vector as q * v * conj(q). A rigid transform maps a point p to rotate(rotation, p) + translation.
 * `rigidCompose(a, b)` applies b first, then a: in column-vector matrices it is A * B,
 * in Direct3D row-vector matrices it is B * A.
 */

export type Vec3 = [x: number, y: number, z: number]
export type Quat = [x: number, y: number, z: number, w: number]

export interface RigidTransform {
  rotation: Quat
  translation: Vec3
}

export const QUAT_IDENTITY: Readonly<Quat> = [0, 0, 0, 1]

export function quatMultiply(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export function quatConjugate(q: Readonly<Quat>): Quat {
  return [-q[0], -q[1], -q[2], q[3]]
}

export function quatLength(q: Readonly<Quat>): number {
  return Math.hypot(q[0], q[1], q[2], q[3])
}

export function quatNormalize(q: Readonly<Quat>): Quat {
  const len = quatLength(q)
  if (len === 0) return [0, 0, 0, 1]
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len]
}

/** Angle in radians between the rotations two unit quaternions represent (q and -q are the same rotation). */
export function quatAngleBetween(a: Readonly<Quat>, b: Readonly<Quat>): number {
  // atan2 of the relative rotation stays accurate for tiny angles, where acos(dot) loses ~half the digits.
  const d = quatMultiply(quatConjugate(a), b)
  return 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3]))
}

export function quatRotate(q: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
  const [qx, qy, qz, qw] = q
  const [vx, vy, vz] = v
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)]
}

export function vec3Add(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function vec3Distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** a after b: p -> a(b(p)). */
export function rigidCompose(a: Readonly<RigidTransform>, b: Readonly<RigidTransform>): RigidTransform {
  return {
    rotation: quatMultiply(a.rotation, b.rotation),
    translation: vec3Add(a.translation, quatRotate(a.rotation, b.translation)),
  }
}

export function rigidInverse(t: Readonly<RigidTransform>): RigidTransform {
  const r = quatConjugate(t.rotation)
  const p = quatRotate(r, t.translation)
  return { rotation: r, translation: [-p[0], -p[1], -p[2]] }
}

export function rigidApply(t: Readonly<RigidTransform>, p: Readonly<Vec3>): Vec3 {
  return vec3Add(t.translation, quatRotate(t.rotation, p))
}

/**
 * 4x4 matrix of a rigid transform, column-major for column vectors (glTF / WebGL layout).
 * The same 16 numbers read row-major are the Direct3D row-vector matrix.
 */
export function rigidToMat4(t: Readonly<RigidTransform>): number[] {
  const [x, y, z, w] = t.rotation
  const [tx, ty, tz] = t.translation
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    tx, ty, tz, 1,
  ]
}
