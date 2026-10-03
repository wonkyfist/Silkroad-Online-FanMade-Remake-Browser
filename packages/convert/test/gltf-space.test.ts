import { describe, expect, it } from 'vitest'
import { bskMath, type BskTransform } from '@sro/formats'
import {
  BASIS_MATRIX,
  FLIP_WINDING,
  mat3Determinant,
  mat4Multiply,
  toGltfDirection,
  toGltfIndices,
  toGltfMatrix,
  toGltfPosition,
  toGltfPositions,
  toGltfQuat,
  toGltfQuats,
  toGltfTransform,
  UNIT_SCALE,
  type Quat,
  type Vec3,
} from '../src/gltf/space.ts'

const { quatNormalize, quatRotate, rigidCompose, rigidInverse, rigidToMat4 } = bskMath

/** Deterministic xorshift so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) / 0xffffffff) * 2 - 1
  }
}
const rand = rng(0x5eed)
const randVec = (k = 10): Vec3 => [rand() * k, rand() * k, rand() * k]
const randQuat = (): Quat => quatNormalize([rand(), rand(), rand(), rand()])
const randRigid = (): BskTransform => ({ rotation: randQuat(), translation: randVec() })

function expectClose(a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-9): void {
  expect(a.length).toBe(b.length)
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(tol)
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

describe('Silkroad -> glTF space', () => {
  it('rotate-then-convert equals convert-then-rotate', () => {
    for (let i = 0; i < 200; i++) {
      const q = randQuat()
      const v = randVec()
      expectClose(toGltfPosition(quatRotate(q, v)), quatRotate(toGltfQuat(q), toGltfPosition(v)))
      expectClose(toGltfDirection(quatRotate(q, v)), quatRotate(toGltfQuat(q), toGltfDirection(v)))
    }
  })

  it('conversion commutes with rigid composition and inversion (bone hierarchies convert per bone)', () => {
    for (let i = 0; i < 200; i++) {
      const a = randRigid()
      const b = randRigid()
      const lhs = toGltfTransform(rigidCompose(a, b))
      const rhs = rigidCompose(toGltfTransform(a), toGltfTransform(b))
      expectClose(rigidToMat4(lhs), rigidToMat4(rhs))
      expectClose(rigidToMat4(toGltfTransform(rigidInverse(a))), rigidToMat4(rigidInverse(toGltfTransform(a))))
    }
  })

  it('matrix conversion B * M * B^-1 agrees with the TRS conversion', () => {
    for (let i = 0; i < 50; i++) {
      const t = randRigid()
      expectClose(toGltfMatrix(rigidToMat4(t)), rigidToMat4(toGltfTransform(t)), 1e-9)
    }
  })

  it('determinants: the basis change is a mirror, converted rotations stay proper', () => {
    expect(mat3Determinant(BASIS_MATRIX)).toBeCloseTo(-(UNIT_SCALE ** 3), 12)
    for (let i = 0; i < 50; i++) {
      const m = rigidToMat4(toGltfTransform(randRigid()))
      expect(mat3Determinant(m)).toBeCloseTo(1, 9)
    }
    // Quaternion mapping is M R M with M = diag(1, 1, -1).
    const M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]
    for (let i = 0; i < 50; i++) {
      const q = randQuat()
      const expected = mat4Multiply(mat4Multiply(M, rigidToMat4({ rotation: q, translation: [0, 0, 0] })), M)
      expectClose(rigidToMat4({ rotation: toGltfQuat(q), translation: [0, 0, 0] }), expected, 1e-12)
    }
  })

  it('winding: a file-space front face (cross along the stored normal) stays a glTF front face', () => {
    expect(FLIP_WINDING).toBe(true)
    for (let i = 0; i < 100; i++) {
      const p: Vec3[] = [randVec(), randVec(), randVec()]
      let n = cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!))
      // The vSRO 1.188 meshes store faces with cross(b - a, c - a) . normal > 0 (measured on the test assets).
      const idx = [0, 1, 2]
      const conv = toGltfPositions(p.flat())
      const q = [0, 1, 2].map(k => [conv[k * 3]!, conv[k * 3 + 1]!, conv[k * 3 + 2]!] as Vec3)
      const [a, b, c] = toGltfIndices(idx)
      n = toGltfDirection(n)
      expect(dot(cross(sub(q[b!]!, q[a!]!), sub(q[c!]!, q[a!]!)), n)).toBeGreaterThan(0)
    }
  })

  it('handedness: a Silkroad model (faces -Z, left side at +X) faces glTF +Z with its left side still at +X', () => {
    const forward = toGltfDirection([0, 0, -1])
    const up = toGltfDirection([0, 1, 0])
    const left = toGltfDirection([1, 0, 0])
    expect(forward).toEqual([0, 0, 1])
    // Right-handed: right = forward x up, so left = up x forward.
    expectClose(cross(up, forward), left)
  })

  it('bulk converters match the scalar ones', () => {
    const pos = new Float32Array([1, 2, 3, -4, 5, -6])
    expectClose(toGltfPositions(pos), [...toGltfPosition([1, 2, 3]), ...toGltfPosition([-4, 5, -6])], 1e-6)
    const q = new Float32Array([0.1, 0.2, 0.3, 0.9, -0.5, 0.5, -0.5, 0.5])
    expectClose(toGltfQuats(q), [...toGltfQuat([0.1, 0.2, 0.3, 0.9]), ...toGltfQuat([-0.5, 0.5, -0.5, 0.5])], 1e-7)
    expect([...toGltfIndices([0, 1, 2, 3, 4, 5])]).toEqual([0, 2, 1, 3, 5, 4])
  })

  it('unit scale: 18.12 file units (chinaman_adventurer) is 1.81 m', () => {
    expect(toGltfPosition([0, 18.12, 0])[1]).toBeCloseTo(1.812, 6)
  })
})
