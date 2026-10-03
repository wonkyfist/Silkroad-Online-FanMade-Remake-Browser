import { describe, expect, it } from 'vitest'
import { efpObjects, efpResources, efpVersion, parseEfp } from '../src/index.ts'

/** Tiny little-endian writer for synthetic JMXVEFF files. */
class W {
  bytes: number[] = []
  u8(v: number) {
    this.bytes.push(v & 0xff)
    return this
  }
  u32(v: number) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v >>> 0, true)
    this.bytes.push(...b)
    return this
  }
  i32(v: number) {
    return this.u32(v | 0)
  }
  f32(v: number) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    this.bytes.push(...b)
    return this
  }
  str(s: string | number[]) {
    // Arrays are raw (CP949) bytes.
    const b = typeof s === 'string' ? new TextEncoder().encode(s) : s
    this.u32(b.length)
    this.bytes.push(...b)
    return this
  }
  ascii(s: string) {
    for (const c of s) this.bytes.push(c.charCodeAt(0))
    return this
  }
  floats(...v: number[]) {
    for (const x of v) this.f32(x)
    return this
  }
  cmd(name: string, mode: number, start: number, period: number, end: number, param?: (w: W) => void, flags = 0) {
    this.u8(1).str(name).u8(flags).u8(mode).floats(start, period, end)
    param?.(this)
    return this
  }
  none() {
    return this.u8(0)
  }
  resource(meshes: Array<[string, string[]]>) {
    this.u32(3).i32(5).i32(2).i32(2).i32(0).i32(4).i32(2).i32(0).i32(4).u32(meshes.length)
    for (const [m, ts] of meshes) {
      this.str(m).u32(ts.length)
      for (const t of ts) this.str(t)
    }
    return this
  }
  get out() {
    return new Uint8Array(this.bytes)
  }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function object(w: W, name: string | number[], children: Array<string | number[]>) {
  w.u32(0x1234).str(name)
  // Controllers: StaticEmit, LinkMode, DiffuseGraph, ScaleGraph, Shape.
  w.u32(5)
  w.str('StaticEmit').u32(0).u32(10).u32(2).u32(5).f32(1.5)
  w.str('LinkMode').i32(1).i32(1).i32(-1).i32(0)
  w.str('DiffuseGraph').floats(0, 1).u32(1).f32(0).u8(200).floats(0, 1).u32(1).f32(0).u8(10).u8(20).u8(30).u8(40)
  w.str('ScaleGraph')
  for (let i = 0; i < 3; i++) w.floats(0, 1).u32(1).floats(0, 2)
  w.floats(7, 8)
  w.str('Shape').str('RenderPlate').resource([['', ['textures\\a.ddj']]])
  // Globals: totalFrames, BlendScaleGraph.
  w.i32(20).u32(1).str('BlendScaleGraph').floats(0, 1).u32(2).floats(0, 1, 1, 1).floats(1, 3, 3, 3)
  w.u32(0) // preProgram
  w.u32(1).cmd('StaticEmit', 0, 0, 1, 0, x => x.u32(0).u32(10).u32(2).u32(5).f32(1.5))
  w.u32(0) // postEmitters
  w.cmd('NormalTimeExtinct', 0, 0, 0, 0)
  w.u32(1).cmd('ProgramUpdate', 0, 0, 1, 0)
  w.u8(1).u8(0).i32(1).i32(-1).i32(0).u8(0).i32(1).u8(1)
  w.cmd('ViewBillboard', 0, 0, 0, 0)
  w.resource([['', ['textures\\a.ddj']]])
  w.cmd('RenderPlate', 0, 0, 0, 0)
  w.u32(0) // trailing
  w.u32(7)
  w.cmd('SetGraphDiffuse', 5, 0, 1, 100, x => x.u32(2).u8(1).u8(2).u8(3).u8(4).u8(5).u8(6).u8(7).u8(8))
  w.cmd('SetShapeRotVel', 8, 0, 1, 1, x => x.floats(0, 0, 1, 3).floats(...IDENTITY))
  w.cmd('SetConeVel', 0, 0, 1, 0, x => x.floats(0.1, 0.2, 45).floats(0.1, 0.2, Math.PI / 4), 2)
  w.cmd('SetBANPos', 5, 0, 1, 100, x => x.f32(0).u32(1).floats(1, 2, 3), 7)
  w.cmd('TextureSlide', 8, 0, 1, 5, x => x.floats(3, 3, 0.125).u32(1).floats(0, 0, 1 / 3, 1 / 3))
  w.cmd('SetRotation', 0, 0, 1, 0, x => x.floats(0, 90, 0).floats(...IDENTITY), 2)
  w.cmd('SetGraphRandomScale', 9, 0, 1, 1, x => x.u32(0xdeadbeef))
  w.u32(children.length)
  for (const c of children) object(w, c, [])
}

function file(version: string, withChild = true) {
  const w = new W().ascii('JMXVEFF ').ascii(version)
  if (version >= '0012') w.f32(1.5)
  if (version === '0013') w.i32(1).i32(0).i32(0)
  object(w, 'root', withChild ? [[0xc0, 0xda, 0xbd, 0xc4]] : [])
  return w.out
}

describe('parseEfp', () => {
  it('parses every section of a synthetic v13 file byte-exactly', () => {
    const bytes = file('0013')
    expect(efpVersion(bytes)).toBe('0013')
    const f = parseEfp(bytes)
    expect(f.version).toBe(13)
    expect(f.scale).toBeCloseTo(1.5)
    expect(f.v13).toEqual([1, 0, 0])
    const r = f.root
    expect(r.name).toBe('root')
    expect(r.dataOffset).toBe(0x1234)
    expect(r.totalFrames).toBe(20)
    expect(r.controllers.map(c => c.name)).toEqual(['StaticEmit', 'LinkMode', 'DiffuseGraph', 'ScaleGraph', 'Shape'])
    const link = r.controllers[1]!
    expect(link.name === 'LinkMode' && link.value).toEqual([1, 1, -1, 0])
    const diff = r.controllers[2]!
    expect(diff.name === 'DiffuseGraph' && diff.color.points[0]!.value).toEqual([30, 20, 10, 40])
    expect(r.globals[0]!.param).toMatchObject({ kind: 'BlendScaleGraph' })
    expect(r.emitters[0]!.param).toEqual({ kind: 'EFStaticEmit', value: { min: 0, max: 10, burstRate: 2, minParticles: 5, spawnRate: 1.5 } })
    expect(r.life?.name).toBe('NormalTimeExtinct')
    expect(r.link).toEqual({ keepMatrix: 1, keepOrigin: 0, positionDepth: 1, matrixDepth: -1, velocityDepth: 0, localMotion: 0, followDepth: 1, shapeMotion: 1 })
    expect(r.view?.name).toBe('ViewBillboard')
    expect(r.render?.name).toBe('RenderPlate')
    expect(r.resource).toMatchObject({ cull: 3, srcBlend: 5, dstBlend: 2, colorOp: 4, meshes: [{ path: '', textures: ['textures\\a.ddj'] }] })
    const prog = r.program.map(c => c!.name)
    expect(prog).toEqual(['SetGraphDiffuse', 'SetShapeRotVel', 'SetConeVel', 'SetBANPos', 'TextureSlide', 'SetRotation', 'SetGraphRandomScale'])
    const d = r.program[0]!
    expect(d.mode).toBe(5)
    expect(d.end).toBe(100)
    expect(d.param).toEqual({ kind: 'FrameDiffuse', value: [[3, 2, 1, 4], [7, 6, 5, 8]] })
    expect(r.program[2]!.flags).toBe(2)
    expect(r.program[3]!.param).toEqual({ kind: 'FrameBANPosition', lead: 0, value: [[1, 2, 3]] })
    expect(r.program[4]!.param).toMatchObject({ kind: 'FrameTextureSlide', lead: [3, 3, 0.125] })
    expect(r.children).toHaveLength(1)
    expect(r.children[0]!.name).toBe('자식')
    expect([...efpObjects(r)].map(o => o.depth)).toEqual([0, 1])
    expect(efpResources(r)).toHaveLength(2)
  })

  it('reads 0010/0011 without scale and 0012 with it', () => {
    expect(parseEfp(file('0010', false)).scale).toBe(1)
    expect(parseEfp(file('0011', false)).v13).toBeNull()
    expect(parseEfp(file('0012', false)).scale).toBeCloseTo(1.5)
  })

  it('rejects trailing bytes, truncation, unknown names and other versions with an offset', () => {
    const good = file('0011')
    expect(() => parseEfp(new Uint8Array([...good, 0]))).toThrow(/1 trailing bytes at offset/)
    expect(() => parseEfp(good.subarray(0, good.length - 3))).toThrow(/at offset \d+/)
    const legacy = new W().ascii('JMXVEFF 0000').u8(2).u8(1).u8(1).out
    expect(() => parseEfp(legacy)).toThrow(/unsupported version "0000" at offset 8/)
    expect(() => parseEfp(new W().ascii('JMXVBMS 0110').out)).toThrow(/bad signature/)
    const bad = new W().ascii('JMXVEFF 0011').u32(0).str('x').u32(1).str('Sparkle').out
    expect(() => parseEfp(bad)).toThrow(/unknown controller "Sparkle" at offset 25/)
  })
})
