import { describe, expect, it } from 'vitest'
import { bskMath, bskWorldTransforms, parseBsk, type BskTransform } from '../src/bsk.ts'

const { quatAngleBetween, quatMultiply, quatRotate, rigidApply, rigidCompose, rigidInverse, rigidToMat4 } = bskMath

interface BoneSpec {
  type?: number
  name: string
  parent: string
  toParent: BskTransform
  toOrigin?: BskTransform
  toLocal?: BskTransform
  children: string[]
}

const IDENTITY: BskTransform = { rotation: [0, 0, 0, 1], translation: [0, 0, 0] }
const S = Math.SQRT1_2

/** Little writer for synthetic skeletons. `legacy` writes the "BSK " header and a NUL after non-empty strings. */
interface BuildOptions {
  legacy?: boolean
  footer?: [number, number]
  trailing?: number[]
}

function buildBsk(bones: BoneSpec[], opts: BuildOptions = {}): Uint8Array {
  const out: number[] = []
  const u8 = (v: number) => out.push(v & 0xff)
  const u32 = (v: number) => {
    for (let i = 0; i < 4; i++) u8(v >>> (8 * i))
  }
  const f32 = (v: number) => {
    const b = new Uint8Array(new Float32Array([v]).buffer)
    out.push(...b)
  }
  const str = (s: string) => {
    const bytes = new TextEncoder().encode(s)
    u32(bytes.length)
    out.push(...bytes)
    if (opts.legacy && bytes.length > 0) u8(0)
  }
  const transform = (t: BskTransform) => {
    t.rotation.forEach(f32)
    t.translation.forEach(f32)
  }
  if (opts.legacy) {
    out.push(...new TextEncoder().encode('BSK '))
    u32(101)
  } else {
    out.push(...new TextEncoder().encode('JMXVBSK 0101'))
  }
  u32(bones.length)
  for (const b of bones) {
    u8(b.type ?? 0)
    str(b.name)
    str(b.parent)
    transform(b.toParent)
    transform(b.toOrigin ?? IDENTITY)
    transform(b.toLocal ?? IDENTITY)
    u32(b.children.length)
    b.children.forEach(str)
  }
  u32(opts.footer?.[0] ?? 0)
  u32(opts.footer?.[1] ?? 0)
  out.push(...(opts.trailing ?? []))
  return Uint8Array.from(out)
}

// Root rotated 90 degrees about +Y and lifted; child offset along its parent's +X and turned 90 degrees about +Z.
const rootT: BskTransform = { rotation: [0, S, 0, S], translation: [0, 10, 0] }
const childT: BskTransform = { rotation: [0, 0, S, S], translation: [2, 0, 0] }
const childWorld = rigidCompose(rootT, childT)
const threeBones: BoneSpec[] = [
  { name: 'Bip01', parent: '', toParent: rootT, toOrigin: rootT, toLocal: rigidInverse(rootT), children: ['Bip01 Spine'] },
  {
    name: 'Bip01 Spine',
    parent: 'Bip01',
    toParent: childT,
    toOrigin: childWorld,
    toLocal: rigidInverse(childWorld),
    children: ['Bip01 Head'],
  },
  {
    type: 1,
    name: 'Bip01 Head',
    parent: 'Bip01 Spine',
    toParent: { rotation: [0, 0, 0, 1], translation: [1, 0, 0] },
    children: [],
  },
]

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => {
  expect(a.length).toBe(b.length)
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)))
}

describe('parseBsk', () => {
  it('reads bones, names, links and all three transforms as stored', () => {
    const skel = parseBsk(buildBsk(threeBones, { footer: [0, 0] }))
    expect(skel.signature).toBe('JMXVBSK 0101')
    expect(skel.version).toBe(101)
    expect([skel.unknown0, skel.unknown1]).toEqual([0, 0])
    expect(skel.bones.map(b => b.name)).toEqual(['Bip01', 'Bip01 Spine', 'Bip01 Head'])
    expect(skel.bones.map(b => b.type)).toEqual([0, 0, 1])
    expect(skel.bones.map(b => b.parentName)).toEqual(['', 'Bip01', 'Bip01 Spine'])
    expect(skel.bones.map(b => b.parentIndex)).toEqual([-1, 0, 1])
    expect(skel.bones.map(b => b.childIndices)).toEqual([[1], [2], []])
    const spine = skel.bones[1]!
    close(spine.toParent.rotation, [0, 0, S, S])
    close(spine.toParent.translation, [2, 0, 0])
    close(spine.toOrigin.rotation, childWorld.rotation)
    close(spine.toLocal.translation, rigidInverse(childWorld).translation)
    // Values are the float32 file values, not re-normalized.
    expect(spine.toParent.rotation[2]).toBe(Math.fround(S))
  })

  it('keeps footer values and unresolvable names raw', () => {
    const skel = parseBsk(
      buildBsk([{ name: 'a', parent: 'missing', toParent: IDENTITY, children: ['nobody'] }], { footer: [7, 0xffffffff] }),
    )
    expect([skel.unknown0, skel.unknown1]).toEqual([7, 0xffffffff])
    expect(skel.bones[0]!.parentIndex).toBe(-1)
    expect(skel.bones[0]!.childIndices).toEqual([-1])
  })

  it('reads the legacy "BSK " header with NUL-terminated strings', () => {
    const skel = parseBsk(buildBsk(threeBones, { legacy: true }))
    expect(skel.signature).toBe('BSK ')
    expect(skel.version).toBe(101)
    expect(skel.bones.map(b => [b.name, b.parentName, b.childNames])).toEqual([
      ['Bip01', '', ['Bip01 Spine']],
      ['Bip01 Spine', 'Bip01', ['Bip01 Head']],
      ['Bip01 Head', 'Bip01 Spine', []],
    ])
  })

  it('decodes names as EUC-KR (CP949)', () => {
    const bytes = buildBsk([{ name: 'XX', parent: '', toParent: IDENTITY, children: [] }])
    bytes.set([0xb0, 0xa1], 12 + 4 + 1 + 4) // "가" in EUC-KR
    expect(parseBsk(bytes).bones[0]!.name).toBe('가')
  })

  it('counts the legacy NUL when checking a string against the end of the file', () => {
    const bytes = buildBsk([{ name: 'a', parent: '', toParent: IDENTITY, children: ['b'] }], { legacy: true })
    // Cut after the last child's "b", dropping its NUL and the footer.
    expect(() => parseBsk(bytes.subarray(0, bytes.length - 9))).toThrow(/bone 0 child 0 name length 1 overruns file/)
  })

  it('parses an empty skeleton', () => {
    expect(parseBsk(buildBsk([])).bones).toEqual([])
  })

  it('rejects malformed input with the file offset', () => {
    const good = buildBsk(threeBones)
    expect(() => parseBsk(new Uint8Array(0))).toThrow(/truncated header.*offset 0/)
    const badSig = good.slice()
    badSig[3] = 0x58
    expect(() => parseBsk(badSig)).toThrow(/bad signature.*offset 0/)
    const badVersion = good.slice()
    badVersion[11] = 0x32
    expect(() => parseBsk(badVersion)).toThrow(/unsupported version "JMXVBSK 0102"/)
    expect(() => parseBsk(good.subarray(0, good.length - 1))).toThrow(/truncated footer/)
    expect(() => parseBsk(good.subarray(0, 100))).toThrow(/BSK: .* at offset \d+/)
    expect(() => parseBsk(buildBsk(threeBones, { trailing: [1, 2] }))).toThrow(/2 unexpected trailing bytes at offset/)
    const hugeCount = good.slice()
    new DataView(hugeCount.buffer).setUint32(12, 0x10000000, true)
    expect(() => parseBsk(hugeCount)).toThrow(/bone count 268435456 does not fit in file at offset 16/)
    const hugeName = good.slice()
    new DataView(hugeName.buffer).setUint32(17, 0x7fffffff, true)
    expect(() => parseBsk(hugeName)).toThrow(/bone 0 name length 2147483647 overruns file at offset 17/)
    const legacy = buildBsk(threeBones, { legacy: true })
    legacy[8 + 4 + 1 + 4 + 5] = 0x41 // the NUL after "Bip01"
    expect(() => parseBsk(legacy)).toThrow(/bone 0 name missing NUL terminator/)
  })
})

describe('bskWorldTransforms', () => {
  it('composes toParent down the hierarchy (parent after local)', () => {
    const skel = parseBsk(buildBsk(threeBones))
    const world = bskWorldTransforms(skel)
    close(world[0]!.rotation, rootT.rotation)
    close(world[1]!.rotation, childWorld.rotation)
    close(world[1]!.translation, childWorld.translation)
    // Root +Y 90deg maps +X to -Z: the spine sits 2 units along -Z above the root.
    close(world[1]!.translation, [0, 10, -2])
    // The head is 1 unit along the spine's +X, which the two rotations carry to +Y.
    close(world[2]!.translation, [0, 11, -2])
    // World transforms are fresh objects.
    world[0]!.translation[0] = 99
    expect(skel.bones[0]!.toParent.translation[0]).toBe(0)
  })

  it('throws on a parent cycle', () => {
    const skel = parseBsk(
      buildBsk([
        { name: 'a', parent: 'b', toParent: IDENTITY, children: ['b'] },
        { name: 'b', parent: 'a', toParent: IDENTITY, children: ['a'] },
      ]),
    )
    expect(() => bskWorldTransforms(skel)).toThrow(/parent cycle/)
  })
})

describe('bskMath', () => {
  it('rotates with the Hamilton convention, x,y,z,w order', () => {
    close(quatRotate([0, 0, S, S], [1, 0, 0]), [0, 1, 0]) // +90 deg about Z: X -> Y
    close(quatRotate([0, S, 0, S], [1, 0, 0]), [0, 0, -1]) // +90 deg about Y: X -> -Z
    const a: [number, number, number, number] = [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)]
    const b: [number, number, number, number] = [0, S, 0, S]
    const v: [number, number, number] = [0.3, -2, 5]
    close(quatRotate(quatMultiply(a, b), v), quatRotate(a, quatRotate(b, v)))
  })

  it('inverts and composes rigid transforms', () => {
    const t: BskTransform = { rotation: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)], translation: [3, -4, 5] }
    const p: [number, number, number] = [1, 2, 3]
    close(rigidApply(rigidInverse(t), rigidApply(t, p)), p)
    close(rigidApply(rigidCompose(t, childT), p), rigidApply(t, rigidApply(childT, p)))
    expect(quatAngleBetween(rigidCompose(t, rigidInverse(t)).rotation, [0, 0, 0, 1])).toBeLessThan(1e-7)
  })

  it('measures small angles accurately and treats q and -q as equal', () => {
    const tiny = 1e-7
    expect(quatAngleBetween([0, 0, 0, 1], [0, 0, Math.sin(tiny / 2), Math.cos(tiny / 2)])).toBeCloseTo(tiny, 12)
    expect(quatAngleBetween([0, S, 0, S], [0, -S, 0, -S])).toBe(0)
  })

  it('builds column-major matrices that match rigidApply', () => {
    const t: BskTransform = { rotation: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)], translation: [3, -4, 5] }
    const m = rigidToMat4(t)
    const p: [number, number, number] = [1, 2, 3]
    const q = [0, 1, 2].map(r => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]!)
    close(q, rigidApply(t, p))
    expect([m[3], m[7], m[11], m[15]]).toEqual([0, 0, 0, 1])
  })
})
