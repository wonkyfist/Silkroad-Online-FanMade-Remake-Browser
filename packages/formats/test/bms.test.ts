import { describe, expect, it } from 'vitest'
import { BMS_NO_BONE, parseBms } from '../src/bms.ts'

/** Little-endian byte writer for synthetic files. */
class Writer {
  private buf = new Uint8Array(256)
  private view = new DataView(this.buf.buffer)
  length = 0

  private grow(n: number): number {
    const at = this.length
    if (at + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, at + n))
      next.set(this.buf)
      this.buf = next
      this.view = new DataView(next.buffer)
    }
    this.length += n
    return at
  }
  // grow() may replace this.view, so it must run before the view is read.
  u8(v: number): this {
    const at = this.grow(1)
    this.view.setUint8(at, v)
    return this
  }
  u16(v: number): this {
    const at = this.grow(2)
    this.view.setUint16(at, v, true)
    return this
  }
  u32(v: number): this {
    const at = this.grow(4)
    this.view.setUint32(at, v, true)
    return this
  }
  f32(...vs: number[]): this {
    for (const v of vs) {
      const at = this.grow(4)
      this.view.setFloat32(at, v, true)
    }
    return this
  }
  raw(bytes: ArrayLike<number>): this {
    const at = this.grow(bytes.length)
    this.buf.set(bytes, at)
    return this
  }
  str(s: string | Uint8Array): this {
    const bytes = typeof s === 'string' ? Uint8Array.from(s, c => c.charCodeAt(0)) : s
    return this.u32(bytes.length).raw(bytes)
  }
  patchU32(at: number, v: number): void {
    this.view.setUint32(at, v, true)
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length)
  }
}

interface Vertex {
  p: [number, number, number]
  n?: [number, number, number]
  uv?: [number, number]
  uv1?: [number, number]
  morph?: number[]
  unk?: [number, number, number]
}

interface NavSpec {
  vertices: Array<[number, number, number, number]>
  cells: Array<[number, number, number, number, number?]>
  outline: Array<[number, number, number, number, number, number?]>
  inline: Array<[number, number, number, number, number, number?]>
  events?: string[]
  grid: { origin: [number, number]; width: number; height: number; cells: number[][] }
}

interface Spec {
  version?: string
  vertexFlags?: number
  navFlags?: number
  name?: string | Uint8Array
  material?: string
  unknownUInt3?: number
  vertices: Vertex[]
  lightmap?: string
  extra?: number[][]
  bones?: string[]
  skin?: Array<Array<[number, number]>>
  faces: number[]
  cloth?: { vertices: Array<[number, number]>; edges: Array<[number, number, number]>; order: number[]; params?: number[] }
  bounds?: [number, number, number, number, number, number]
  portals?: Array<{ name: string; vertices: number[]; faces: number[] }>
  nav?: NavSpec
  /** Corrupt the file after writing: bytes inserted before a section. */
  padBefore?: 'skin' | 'bbox'
}

const OFFSETS = ['vertex', 'skin', 'face', 'clothVertex', 'clothEdge', 'bbox', 'occlusion', 'nav', 'skinnedNav', 'unknown9'] as const

function buildBms(spec: Spec): Uint8Array {
  const w = new Writer()
  w.raw(Uint8Array.from(`JMXVBMS ${spec.version ?? '0110'}`, c => c.charCodeAt(0)))
  const offsetAt = new Map(OFFSETS.map((k, i) => [k, 12 + i * 4]))
  for (let i = 0; i < 10; i++) w.u32(0)
  const vertexFlags = spec.vertexFlags ?? 0
  w.u32(0).u32(spec.navFlags ?? 0).u32(1).u32(vertexFlags).u32(0)
  w.str(spec.name ?? 'mesh').str(spec.material ?? 'mtrl').u32(spec.unknownUInt3 ?? 0)
  const mark = (k: (typeof OFFSETS)[number]) => w.patchU32(offsetAt.get(k)!, w.length)

  mark('vertex')
  w.u32(spec.vertices.length)
  for (const v of spec.vertices) {
    w.f32(...v.p).f32(...(v.n ?? [0, 1, 0])).f32(...(v.uv ?? [0, 0]))
    if (vertexFlags & 0x400) w.f32(...(v.uv1 ?? [0, 0]))
    if (vertexFlags & 0x800) w.raw(v.morph ?? new Array(36).fill(0))
    const [f, i0, i1] = v.unk ?? [0, 0xffffffff, 0]
    w.f32(f).u32(i0).u32(i1)
  }
  if (vertexFlags & 0x400) w.str(spec.lightmap ?? '')
  if (vertexFlags & 0x1000) {
    w.u32(spec.extra?.length ?? 0)
    for (const e of spec.extra ?? []) w.f32(...e)
  }

  if (spec.padBefore === 'skin') w.u8(0)
  mark('skin')
  w.u32(spec.bones?.length ?? 0)
  for (const b of spec.bones ?? []) w.str(b)
  for (const influences of spec.skin ?? []) for (const [bone, weight] of influences) w.u8(bone).u16(weight)

  mark('face')
  w.u32(spec.faces.length / 3)
  for (const i of spec.faces) w.u16(i)

  mark('clothVertex')
  w.u32(spec.cloth?.vertices.length ?? 0)
  for (const [d, pinned] of spec.cloth?.vertices ?? []) w.f32(d).u32(pinned)
  mark('clothEdge')
  w.u32(spec.cloth?.edges.length ?? 0)
  for (const [a, b, d] of spec.cloth?.edges ?? []) w.u32(a).u32(b).f32(d)
  for (const o of spec.cloth?.order ?? []) w.u32(o)
  if (spec.cloth?.params) {
    const p = spec.cloth.params
    w.u32(p[0]!).f32(...p.slice(1, 8)).u32(p[8]!)
  }

  if (spec.padBefore === 'bbox') w.u8(0)
  mark('bbox')
  w.f32(...(spec.bounds ?? [0, 0, 0, 0, 0, 0]))

  mark('occlusion')
  w.u32(spec.portals?.length ?? 0)
  for (const portal of spec.portals ?? []) {
    w.str(portal.name).u32(portal.vertices.length / 3).f32(...portal.vertices).u32(portal.faces.length / 3)
    for (const i of portal.faces) w.u16(i)
  }

  mark('unknown9')
  w.u32(0)

  const nav = spec.nav
  if (nav) {
    const navFlags = spec.navFlags ?? 0
    mark('nav')
    w.u32(nav.vertices.length)
    for (const [x, y, z, bisector] of nav.vertices) w.f32(x, y, z).u8(bisector)
    w.u32(nav.cells.length)
    for (const [a, b, c, flag, event] of nav.cells) {
      w.u16(a).u16(b).u16(c).u16(flag)
      if (navFlags & 2) w.u8(event ?? 0)
    }
    for (const edges of [nav.outline, nav.inline]) {
      w.u32(edges.length)
      for (const [sv, dv, sc, dc, flag, event] of edges) {
        w.u16(sv).u16(dv).u16(sc).u16(dc).u8(flag)
        if (navFlags & 1) w.u8(event ?? 0)
      }
    }
    if (navFlags & 4) {
      w.u32(nav.events?.length ?? 0)
      for (const e of nav.events ?? []) w.str(e)
    }
    w.f32(...nav.grid.origin).u32(nav.grid.width).u32(nav.grid.height).u32(nav.grid.cells.length)
    for (const cell of nav.grid.cells) {
      w.u32(cell.length)
      for (const o of cell) w.u16(o)
    }
  }
  return w.bytes()
}

const triangle: Vertex[] = [
  { p: [0, 0, 0], n: [0, 0, -1], uv: [0, 1], unk: [0, 0xffffffff, 0] },
  { p: [1, 0, 0], n: [0, 0, -1], uv: [1, 1], unk: [0.5, 7, 2] },
  { p: [0, 2, 0], n: [0, 0, -1], uv: [0, 0], unk: [0, 0xffffffff, 0] },
]

describe('parseBms', () => {
  it('parses a static 0110 mesh with raw file-space values', () => {
    const bytes = buildBms({ name: 'tri', material: 'body', unknownUInt3: 1, vertices: triangle, faces: [0, 1, 2], bounds: [0, 0, 0, 1, 2, 0] })
    const m = parseBms(bytes)
    expect(m.signature).toBe('JMXVBMS 0110')
    expect(m.version).toBe(110)
    expect(m.name).toBe('tri')
    expect(m.materialName).toBe('body')
    expect(m.vertexFlags).toBe(0)
    expect(m.vertexCount).toBe(3)
    expect([...m.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 2, 0])
    expect([...m.normals]).toEqual([0, 0, -1, 0, 0, -1, 0, 0, -1])
    expect([...m.uv0]).toEqual([0, 1, 1, 1, 0, 0])
    expect([...m.unknownVertexFloat]).toEqual([0, 0.5, 0])
    expect([...m.unknownVertexInt0]).toEqual([0xffffffff, 7, 0xffffffff])
    expect([...m.unknownVertexInt1]).toEqual([0, 2, 0])
    expect([...m.indices]).toEqual([0, 1, 2])
    expect(m.bounds).toEqual({ min: [0, 0, 0], max: [1, 2, 0] })
    expect(m.boneNames).toEqual([])
    expect(m.influencesPerVertex).toBe(0)
    expect(m.joints).toBeUndefined()
    expect(m.weights).toBeUndefined()
    expect(m.uv1).toBeUndefined()
    expect(m.cloth).toBeUndefined()
    expect(m.navMesh).toBeUndefined()
    expect(m.occlusionPortals).toEqual([])
    expect(m.header.unknownUInt3).toBe(1)
    expect(m.header.subPrimCount).toBe(1)
    // header: 12 + 60 + (4 + 3) + (4 + 4) + 4 = 91; vertices: 4 + 3 * 44
    expect(m.header.size).toBe(91)
    expect(m.header.vertexOffset).toBe(91)
    expect(m.header.skinOffset).toBe(91 + 4 + 3 * 44)
    expect(m.header.navMeshOffset).toBe(0)
  })

  it('decodes names as EUC-KR', () => {
    const name = Uint8Array.of(0xb3, 0xaa, 0xb9, 0xab) // 나무
    const m = parseBms(buildBms({ name, vertices: [], faces: [] }))
    expect(m.name).toBe('나무')
  })

  it('reads 0110 skinning as 2 x (u8 bone, u16 weight) with weight / 65535', () => {
    const m = parseBms(
      buildBms({
        vertices: triangle,
        faces: [0, 1, 2],
        bones: ['Bip01 Spine', 'Bip01 L UpperArm'],
        skin: [
          [[0, 0xffff], [BMS_NO_BONE, 0]],
          [[0, 0x7fd8], [1, 0x7fd8]],
          [[1, 0xcaa8], [0, 0x34e7]],
        ],
      }),
    )
    expect(m.boneNames).toEqual(['Bip01 Spine', 'Bip01 L UpperArm'])
    expect(m.influencesPerVertex).toBe(2)
    expect([...m.skinBones!]).toEqual([0, 0xff, 0, 1, 1, 0])
    expect([...m.skinWeights!]).toEqual([0xffff, 0, 0x7fd8, 0x7fd8, 0xcaa8, 0x34e7])
    expect([...m.joints!]).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0])
    const w = [...m.weights!]
    expect(w.slice(0, 4)).toEqual([1, 0, 0, 0])
    expect(w[4]).toBeCloseTo(0x7fd8 / 65535, 6)
    expect(w[5]).toBeCloseTo(0x7fd8 / 65535, 6)
    expect(w[8]! + w[9]!).toBeCloseTo((0xcaa8 + 0x34e7) / 65535, 6)
    expect(w[10]).toBe(0)
  })

  it('reads 0109 skinning as 4 influences per vertex', () => {
    const m = parseBms(
      buildBms({
        version: '0109',
        vertices: triangle.slice(0, 2),
        faces: [],
        bones: ['a', 'b', 'c'],
        skin: [
          [[2, 0xffff], [0xff, 0], [0xff, 0], [0xff, 0]],
          [[0, 0x8000], [1, 0x4000], [2, 0x3fff], [0xff, 0]],
        ],
      }),
    )
    expect(m.version).toBe(109)
    expect(m.influencesPerVertex).toBe(4)
    expect([...m.joints!]).toEqual([2, 0, 0, 0, 0, 1, 2, 0])
    expect(m.weights![0]).toBe(1)
    expect(m.weights![4]! + m.weights![5]! + m.weights![6]!).toBeCloseTo(1, 6)
  })

  it('treats a boneless 0109 skin section as a plain zero count', () => {
    const m = parseBms(buildBms({ version: '0109', vertices: triangle, faces: [0, 1, 2] }))
    expect(m.boneNames).toEqual([])
    expect(m.influencesPerVertex).toBe(0)
    expect(m.joints).toBeUndefined()
  })

  it('reads lightmap UVs, morph bytes and 0x1000 extra data', () => {
    const morph = Array.from({ length: 36 }, (_, i) => i)
    const vertices = triangle.map((v, i) => ({ ...v, uv1: [i / 4, 0.5] as [number, number], morph }))
    const m = parseBms(
      buildBms({
        vertexFlags: 0x400 | 0x800 | 0x1000,
        vertices,
        lightmap: 'prim\\lightmap\\a.ddj',
        extra: [[1, 2, 3, 4, 5, 6]],
        faces: [2, 1, 0],
      }),
    )
    expect(m.vertexFlags).toBe(0x1c00)
    expect([...m.uv1!]).toEqual([0, 0.5, 0.25, 0.5, 0.5, 0.5])
    expect(m.lightmapPath).toBe('prim\\lightmap\\a.ddj')
    expect(m.morph!.length).toBe(3 * 36)
    expect([...m.morph!.subarray(36, 72)]).toEqual(morph)
    expect([...m.extraVertexData!]).toEqual([1, 2, 3, 4, 5, 6])
    expect([...m.positions.subarray(3, 6)]).toEqual([1, 0, 0])
    expect([...m.unknownVertexInt1]).toEqual([0, 2, 0])
    expect([...m.indices]).toEqual([2, 1, 0])
  })

  it('reads cloth vertices, edges and parameters', () => {
    const m = parseBms(
      buildBms({
        vertices: triangle,
        faces: [0, 1, 2],
        cloth: {
          vertices: [[0, 1], [0.25, 0], [0.5, 0]],
          edges: [[0, 1, 1.5], [1, 2, 2.5]],
          order: [1, 0],
          params: [1, 0, 1.5, 2.5, 9.5, 3.25, 3.25, 0.75, 15],
        },
      }),
    )
    const c = m.cloth!
    expect([...c.vertexMaxDistance]).toEqual([0, 0.25, 0.5])
    expect([...c.vertexPinned]).toEqual([1, 0, 0])
    expect([...c.edges]).toEqual([0, 1, 1, 2])
    expect([...c.edgeMaxDistance]).toEqual([1.5, 2.5])
    expect([...c.edgeOrder]).toEqual([1, 0])
    expect(c.params).toEqual({
      deformationMode: 1,
      animationOffsetX: 0,
      animationOffsetZ: 1.5,
      animationOffsetY: 2.5,
      fallingSpeed: 9.5,
      unknownFloat6: 3.25,
      unknownFloat7: 3.25,
      elasticity: 0.75,
      movementFactor: 15,
    })
  })

  it('reads occlusion portals and the embedded navmesh', () => {
    const nav: NavSpec = {
      vertices: [[0, 0, 0, 1], [100, 0, 0, 2], [0, 0, 100, 0x80], [100, 0, 100, 3]],
      cells: [[0, 1, 2, 0, 0x41], [1, 3, 2, 0, 0]],
      outline: [[0, 1, 0, 0xffff, 3, 0], [1, 3, 1, 0xffff, 3, 0x81]],
      inline: [[1, 2, 0, 1, 4, 0]],
      events: ['gate_dungeon_out'],
      grid: { origin: [0, 0], width: 2, height: 1, cells: [[0], [0, 1]] },
    }
    const bytes = buildBms({
      navFlags: 7,
      vertices: triangle,
      faces: [0, 1, 2],
      portals: [{ name: 'gate_46', vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0], faces: [0, 1, 2] }],
      nav,
    })
    const m = parseBms(bytes)
    expect(m.header.navFlags).toBe(7)
    expect(m.occlusionPortals).toHaveLength(1)
    expect(m.occlusionPortals[0]!.name).toBe('gate_46')
    expect([...m.occlusionPortals[0]!.vertices]).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0])
    expect([...m.occlusionPortals[0]!.indices]).toEqual([0, 1, 2])
    const n = m.navMesh!
    expect(n.raw.byteOffset - bytes.byteOffset).toBe(m.header.navMeshOffset)
    expect(n.raw.byteLength).toBe(bytes.byteLength - m.header.navMeshOffset)
    expect([...n.vertices.subarray(3, 6)]).toEqual([100, 0, 0])
    expect([...n.vertexBisectors]).toEqual([1, 2, 0x80, 3])
    expect([...n.cells]).toEqual([0, 1, 2, 1, 3, 2])
    expect([...n.cellFlags]).toEqual([0, 0])
    expect([...n.cellEventZones!]).toEqual([0x41, 0])
    expect([...n.outlineEdges.vertices]).toEqual([0, 1, 1, 3])
    expect([...n.outlineEdges.cells]).toEqual([0, 0xffff, 1, 0xffff])
    expect([...n.outlineEdges.flags]).toEqual([3, 3])
    expect([...n.outlineEdges.eventZones!]).toEqual([0, 0x81])
    expect([...n.inlineEdges.cells]).toEqual([0, 1])
    expect(n.events).toEqual(['gate_dungeon_out'])
    expect(n.grid.origin).toEqual([0, 0])
    expect(n.grid.width).toBe(2)
    expect([...n.grid.cellStart]).toEqual([0, 1, 3])
    expect([...n.grid.cellOutlines]).toEqual([0, 0, 1])
  })

  it('omits the optional navmesh fields their flags do not enable', () => {
    const nav: NavSpec = {
      vertices: [[0, 0, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0]],
      cells: [[0, 1, 2, 0]],
      outline: [[0, 1, 0, 0xffff, 3]],
      inline: [],
      grid: { origin: [0, 0], width: 1, height: 1, cells: [[0]] },
    }
    const m = parseBms(buildBms({ navFlags: 8, vertices: triangle, faces: [0, 1, 2], nav }))
    expect(m.navMesh!.cellEventZones).toBeUndefined()
    expect(m.navMesh!.outlineEdges.eventZones).toBeUndefined()
    expect(m.navMesh!.events).toEqual([])
  })

  it('reads a skinned navmesh (three counted arrays) at its header offset', () => {
    const base = buildBms({ vertices: triangle, faces: [0, 1, 2] })
    const w = new Writer()
    w.raw(base)
    w.u32(1).f32(1.5, -2, 3).u32(2).raw([4, 5, 0xff, 0]).u32(1).u16(0).u16(1).u16(2)
    const bytes = w.bytes()
    new DataView(bytes.buffer).setUint32(12 + 8 * 4, base.length, true)
    const m = parseBms(bytes)
    const s = m.skinnedNavMesh!
    expect([...s.structure0]).toEqual([1.5, -2, 3])
    expect([...s.structure1]).toEqual([4, 5, 0xff, 0])
    expect([...s.structure2]).toEqual([0, 1, 2])
    expect(s.raw.byteLength).toBe(bytes.length - base.length)
  })

  describe('rejects malformed input with the file offset', () => {
    it('a non-zero unknown9 count (layout unknown) and a section offset past EOF', () => {
      const bytes = buildBms({ vertices: triangle, faces: [0, 1, 2] })
      const view = new DataView(bytes.buffer)
      const unknown9 = view.getUint32(12 + 9 * 4, true)
      view.setUint32(unknown9, 1, true)
      expect(() => parseBms(bytes)).toThrow(`unsupported unknown9 count 1 at offset ${unknown9}`)
      const past = buildBms({ vertices: triangle, faces: [0, 1, 2] })
      new DataView(past.buffer).setUint32(12 + 2 * 4, past.length + 1, true)
      expect(() => parseBms(past)).toThrow(/face offset past end of file/)
    })

    it('sections that overlap instead of tiling', () => {
      const bytes = buildBms({ vertices: triangle, faces: [0, 1, 2] })
      const view = new DataView(bytes.buffer)
      // Point the bounding box at the cloth edge section: both parse, but the layout no longer tiles.
      view.setUint32(12 + 5 * 4, view.getUint32(12 + 4 * 4, true), true)
      expect(() => parseBms(bytes)).toThrow(/does not follow/)
    })

    const good = () => buildBms({ vertices: triangle, faces: [0, 1, 2] })

    it('bad signature and unsupported versions', () => {
      const bytes = good()
      bytes[3] = 0x58
      expect(() => parseBms(bytes)).toThrow(/bad signature .* at offset 0/)
      expect(() => parseBms(buildBms({ version: '0111', vertices: [], faces: [] }))).toThrow(/unsupported version/)
    })

    it('truncation', () => {
      expect(() => parseBms(good().subarray(0, 40))).toThrow(/truncated header/)
      const bytes = good()
      expect(() => parseBms(bytes.subarray(0, bytes.length - 2))).toThrow(/at offset \d+/)
    })

    it('counts that overrun the file', () => {
      const bytes = good()
      const view = new DataView(bytes.buffer)
      view.setUint32(view.getUint32(12, true), 0x10000000, true)
      // header: 12 + 60 + (4 + 'mesh') + (4 + 'mtrl') + 4 = 92
      expect(() => parseBms(bytes)).toThrow(/vertex count 268435456 overruns file at offset 92/)
    })

    it('gaps between sections and trailing bytes', () => {
      expect(() => parseBms(buildBms({ vertices: triangle, faces: [0, 1, 2], padBefore: 'skin' }))).toThrow(/skin section does not follow vertex/)
      expect(() => parseBms(buildBms({ vertices: triangle, faces: [0, 1, 2], padBefore: 'bbox' }))).toThrow(/bounding box section does not follow cloth edge/)
      const bytes = good()
      const padded = new Uint8Array(bytes.length + 3)
      padded.set(bytes)
      expect(() => parseBms(padded)).toThrow(/3 unexpected bytes after unknown9/)
    })

    it('unknown vertex flags', () => {
      expect(() => parseBms(buildBms({ vertexFlags: 0x2000, vertices: [], faces: [] }))).toThrow(/unknown vertex flags 0x2000/)
    })
  })
})
