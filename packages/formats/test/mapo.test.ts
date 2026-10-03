import { describe, expect, it } from 'vitest'
import { bskMath } from '../src/bsk.ts'
import {
  MAPO_BLOCK_COUNT,
  MAPO_GROUP_LARGE,
  MAPO_GROUP_SMALL,
  mapoInstances,
  mapoLayouts,
  mapoPositionInRegion,
  mapoRegionCoords,
  mapoRegionId,
  mapoUidParts,
  mapoYawQuat,
  parseMapO,
  type MapObjectPlacement,
  type MapOKind,
} from '../src/mapo.ts'

/** Little-endian byte builder for synthetic .o/.o2 files. */
class Writer {
  private readonly parts: number[] = []
  private readonly view = new DataView(new ArrayBuffer(4))
  private push(n: number): this {
    for (let i = 0; i < n; i++) this.parts.push(this.view.getUint8(i))
    return this
  }
  u8(v: number): this {
    this.parts.push(v & 0xff)
    return this
  }
  u16(v: number): this {
    this.view.setUint16(0, v, true)
    return this.push(2)
  }
  u32(v: number): this {
    this.view.setUint32(0, v, true)
    return this.push(4)
  }
  f32(v: number): this {
    this.view.setFloat32(0, v, true)
    return this.push(4)
  }
  ascii(s: string): this {
    for (const c of s) this.parts.push(c.charCodeAt(0))
    return this
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

type Rec = Omit<MapObjectPlacement, 'regionId'> & { regionId?: number }

function rec(overrides: Partial<Rec> = {}): Rec {
  return {
    objId: 17,
    position: [805.5, -0.5, 293.25],
    staticFlag: 0xffff,
    yaw: Math.PI / 2,
    uid: 0x0802,
    unknown0: 0xcccc,
    isBig: 0,
    isStruct: 1,
    ...overrides,
  }
}

/** blocks[z * 6 + x][g] = records; unspecified blocks/groups are empty. */
function build(kind: MapOKind, content: Map<number, Rec[][]>, groups = 4, signature = 'JMXVMAPO1001'): Uint8Array {
  const w = new Writer().ascii(signature)
  for (let b = 0; b < MAPO_BLOCK_COUNT; b++) {
    const blockGroups = content.get(b) ?? []
    for (let g = 0; g < groups; g++) {
      const list = blockGroups[g] ?? []
      w.u16(list.length)
      for (const r of list) {
        w.u32(r.objId).f32(r.position[0]).f32(r.position[1]).f32(r.position[2])
        w.u16(r.staticFlag).f32(r.yaw).u16(r.uid).u16(r.unknown0).u8(r.isBig).u8(r.isStruct)
        if (kind === 'o2') w.u16(r.regionId ?? 0)
      }
    }
  }
  return w.bytes()
}

const f32 = (v: number) => Math.fround(v)

describe('parseMapO', () => {
  it('reads .o2 records field by field, 36 z-major blocks of 4 groups', () => {
    const a = rec({ regionId: 0x61a8 })
    const b = rec({ objId: 702, position: [860.625, -1.75, 1764.5], yaw: 0, uid: 0xa801, isBig: 1, isStruct: 0, regionId: 0x60a8, staticFlag: 0 })
    const bytes = build('o2', new Map([[2, [[], [], [a], [b, a]]], [35, [[], [], [b]]]]))
    const mo = parseMapO(bytes, 'o2')
    expect(mo.signature).toBe('JMXVMAPO1001')
    expect(mo.version).toBe(1001)
    expect(mo.kind).toBe('o2')
    expect(mo.groupsPerBlock).toBe(4)
    expect(mo.blocks).toHaveLength(36)
    expect(mo.blocks[2]).toMatchObject({ x: 2, z: 0 })
    expect(mo.blocks[35]).toMatchObject({ x: 5, z: 5 })
    expect(mo.blocks[7]).toMatchObject({ x: 1, z: 1 })
    expect(mo.blocks[2]!.groups[MAPO_GROUP_LARGE]).toEqual([{ ...a, yaw: f32(a.yaw) }])
    expect(mo.blocks[2]!.groups[MAPO_GROUP_SMALL]![0]).toEqual({ ...b, regionId: 0x60a8 })
    expect(mo.blocks[35]!.groups[MAPO_GROUP_LARGE]![0]!.uid).toBe(0xa801)
  })

  it('reads 28-byte .o records without a region id', () => {
    const a = rec()
    const mo = parseMapO(build('o', new Map([[6, [[], [], [a]]]])), 'o')
    const got = mo.blocks[6]!.groups[2]![0]!
    expect(got.regionId).toBeNull()
    expect(got).toEqual({ ...a, yaw: f32(a.yaw), regionId: null })
  })

  it('chooses the group count from the body length (empty 3-group placeholders)', () => {
    const empty3 = build('o', new Map(), 3, 'JMXVMAPO1000')
    expect(empty3.length).toBe(228)
    expect(mapoLayouts(empty3, 'o')).toEqual([3])
    const mo = parseMapO(empty3, 'o')
    expect(mo.version).toBe(1000)
    expect(mo.groupsPerBlock).toBe(3)
    expect(mo.blocks.every(b => b.groups.length === 3 && b.groups.every(g => g.length === 0))).toBe(true)
    // A 1-group reading (SilkroadDoc's .o layout) does not fit files with objects.
    const withObjects = build('o', new Map([[0, [[], [], [rec()]]]]))
    expect(mapoLayouts(withObjects, 'o')).toEqual([4])
  })

  it('throws with an offset on malformed input', () => {
    expect(() => parseMapO(new Uint8Array(4), 'o')).toThrow(/MAPO: .* at offset 0/)
    const bad = build('o', new Map())
    bad[3] = 0x41
    expect(() => parseMapO(bad, 'o')).toThrow(/signature/)
    const truncated = build('o2', new Map([[0, [[], [], [rec({ regionId: 1 })]]]])).subarray(0, 60)
    expect(() => parseMapO(truncated, 'o2')).toThrow(/fits no layout.* at offset 12/)
    // .o bytes read as .o2 (or vice versa) do not fit either.
    expect(() => parseMapO(build('o', new Map([[0, [[], [], [rec()]]]])), 'o2')).toThrow(/MAPO/)
    expect(() => parseMapO(build('o', new Map()), 'x' as MapOKind)).toThrow(/kind/)
  })
})

describe('mapo helpers', () => {
  it('deduplicates .o2 records on (regionId, uid) in first-appearance order', () => {
    const own = rec({ uid: 0x2001, regionId: 0x61a8 })
    const neighbour = rec({ uid: 0x2001, regionId: 0x61a7, objId: 5 })
    const later = rec({ uid: 0x2402, regionId: 0x61a8, objId: 9 })
    const mo = parseMapO(build('o2', new Map([[0, [[], [], [neighbour, own]]], [1, [[], [], [own], [later, neighbour]]]])), 'o2')
    const all = mapoInstances(mo)
    expect(all.map(p => [p.regionId, p.objId, p.block, p.group])).toEqual([
      [0x61a7, 5, 0, 2],
      [0x61a8, 17, 0, 2],
      [0x61a8, 9, 1, 3],
    ])
    expect(mapoInstances(mo, 0x61a8).map(p => p.objId)).toEqual([17, 9])
  })

  it('encodes region ids and re-expresses positions in a neighbouring region', () => {
    expect(mapoRegionId(168, 97)).toBe(0x61a8)
    expect(mapoRegionCoords(0x61a8)).toEqual({ x: 168, z: 97, dungeon: false })
    expect(mapoRegionCoords(0x8009)).toEqual({ x: 9, z: 0, dungeon: true })
    const p = rec({ position: [860, -1.5, 1764], regionId: 0x60a8 }) as MapObjectPlacement
    expect(mapoPositionInRegion(p, 0x61a8)).toEqual([860, -1.5, 1764 - 1920])
    expect(mapoPositionInRegion(p, 0x60a7)).toEqual([860 + 1920, -1.5, 1764])
    const o = { ...p, regionId: null }
    expect(() => mapoPositionInRegion(o, 0x61a8)).toThrow(/owner/)
    expect(mapoPositionInRegion(o, 0x61a8, 0x61a8)).toEqual(o.position)
  })

  it('turns +X toward +Z for a positive yaw', () => {
    const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 12))
    close(bskMath.quatRotate(mapoYawQuat(Math.PI / 2), [1, 0, 0]), [0, 0, 1])
    close(bskMath.quatRotate(mapoYawQuat(Math.PI / 2), [0, 0, 1]), [-1, 0, 0])
    close(bskMath.quatRotate(mapoYawQuat(0), [3, 4, 5]), [3, 4, 5])
    const yaw = 0.7
    close(bskMath.quatRotate(mapoYawQuat(yaw), [2, 1, -3]), [
      2 * Math.cos(yaw) + 3 * Math.sin(yaw),
      1,
      2 * Math.sin(yaw) - 3 * Math.cos(yaw),
    ])
    // Unnormalized angles are the same rotation.
    close(bskMath.quatRotate(mapoYawQuat(yaw - 4 * Math.PI), [1, 0, 0]), [Math.cos(yaw), 0, Math.sin(yaw)])
  })

  it('splits a uid into creation block and serial', () => {
    expect(mapoUidParts(0x0802)).toEqual({ blockX: 2, blockZ: 0, serial: 2 })
    expect(mapoUidParts(0x2001)).toEqual({ blockX: 0, blockZ: 1, serial: 1 })
    expect(mapoUidParts(0xa801)).toEqual({ blockX: 2, blockZ: 5, serial: 1 })
  })
})
