/** Minimal column-major 3x3 / vec3 helpers for the simulation (no engine dependency). */

export type V3 = [number, number, number]
export type M3 = [number, number, number, number, number, number, number, number, number]

export const identity3 = (): M3 => [1, 0, 0, 0, 1, 0, 0, 0, 1]

export function copy3(m: Readonly<M3>): M3 {
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]]
}

/** a * b (column-major, column vectors: apply b first). */
export function mul3(a: Readonly<M3>, b: Readonly<M3>, out: M3 = identity3()): M3 {
  const r0 = a[0] * b[0] + a[3] * b[1] + a[6] * b[2]
  const r1 = a[1] * b[0] + a[4] * b[1] + a[7] * b[2]
  const r2 = a[2] * b[0] + a[5] * b[1] + a[8] * b[2]
  const r3 = a[0] * b[3] + a[3] * b[4] + a[6] * b[5]
  const r4 = a[1] * b[3] + a[4] * b[4] + a[7] * b[5]
  const r5 = a[2] * b[3] + a[5] * b[4] + a[8] * b[5]
  const r6 = a[0] * b[6] + a[3] * b[7] + a[6] * b[8]
  const r7 = a[1] * b[6] + a[4] * b[7] + a[7] * b[8]
  const r8 = a[2] * b[6] + a[5] * b[7] + a[8] * b[8]
  out[0] = r0
  out[1] = r1
  out[2] = r2
  out[3] = r3
  out[4] = r4
  out[5] = r5
  out[6] = r6
  out[7] = r7
  out[8] = r8
  return out
}

/** a * transpose(b): the rotation taking frame b to frame a (for orthonormal b). */
export function mulTranspose3(a: Readonly<M3>, b: Readonly<M3>, out: M3 = identity3()): M3 {
  const t: M3 = [b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]]
  return mul3(a, t, out)
}

export function apply3(m: Readonly<M3>, v: Readonly<V3>): V3 {
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]]
}

export function isIdentity3(m: Readonly<M3>, eps = 1e-7): boolean {
  const i = identity3()
  for (let k = 0; k < 9; k++) if (Math.abs(m[k] - i[k]) > eps) return false
  return true
}

/** Deterministic PRNG (mulberry32) in [0, 1). */
export function random01(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
