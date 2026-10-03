import { describe, expect, it } from 'vitest'
import { ENV_GRAPHS, listEnvLeaves, parseEnvironment, sampleEnvColor, sampleEnvFloat } from '../src/envi.ts'

class Writer {
  private readonly parts: number[] = []
  u16(v: number): this {
    this.parts.push(v & 0xff, (v >> 8) & 0xff)
    return this
  }
  u32(v: number): this {
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (i * 8)) & 0xff)
    return this
  }
  f32(v: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    this.parts.push(...b)
    return this
  }
  ascii(s: string): this {
    for (const c of s) this.parts.push(c.charCodeAt(0))
    return this
  }
  str(s: string | number[]): this {
    const bytes = typeof s === 'string' ? Array.from(s, c => c.charCodeAt(0)) : s
    this.u32(bytes.length)
    this.parts.push(...bytes)
    return this
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

function profile(w: Writer, id: number, name: string | number[]): void {
  w.u16(id).str(name).str('').str('')
  ENV_GRAPHS.forEach(([, kind], g) => {
    if (kind === 'color') {
      w.u32(2).f32(g / 16).f32(0.5).f32(1).f32(0).f32(1).f32(0.5).f32(g / 16).f32(1)
    } else {
      w.u32(3).f32(-1).f32(0).f32(g / 16).f32(0.5).f32(-1).f32(1)
    }
  })
}

function node(w: Writer, name: string, profileId: number, depth: number, children: (w: Writer) => void, count: number): void {
  w.u32(count).str(name).u16(profileId).u16(depth).u32(depth).u32(depth)
  children(w)
}

// "장안" in EUC-KR
const JANGAN = [0xc0, 0xe5, 0xbe, 0xc8]

function makeEnv(opts: { trailing?: boolean; truncate?: number } = {}): Uint8Array {
  const w = new Writer().ascii('JMXVENVI1003').u16(2).str('')
  profile(w, 15, JANGAN)
  profile(w, 3, 'Env3')
  node(
    w,
    'Root(Environment)',
    0,
    0,
    w => {
      node(w, 'group', 0, 1, w => {
        node(w, 'town', 15, 2, () => {}, 0)
        node(w, 'field', 3, 2, () => {}, 0)
      }, 2)
    },
    1,
  )
  if (opts.trailing) w.u16(0)
  const bytes = w.bytes()
  return opts.truncate ? bytes.subarray(0, bytes.length - opts.truncate) : bytes
}

describe('parseEnvironment', () => {
  it('reads profiles with 16 graphs and the node tree to EOF', () => {
    const env = parseEnvironment(makeEnv())
    expect(env.signature).toBe('JMXVENVI1003')
    expect(env.setName).toBe('')
    expect(env.profiles.map(p => [p.id, p.name])).toEqual([
      [15, '장안'],
      [3, 'Env3'],
    ])
    const p = env.byId.get(3)!
    expect(p.dayBgm).toBe('')
    expect(p.sunColor).toEqual([
      { r: 0, g: 0.5, b: 1, time: 0 },
      { r: 1, g: 0.5, b: 0, time: 1 },
    ])
    expect(p.terrainShadowColor[0]!.r).toBe(6 / 16)
    expect(p.fogNearPlane).toEqual([
      { value: -1, time: 0 },
      { value: 7 / 16, time: 0.5 },
      { value: -1, time: 1 },
    ])
    expect(p.graph15[1]!.value).toBe(15 / 16)
    expect(env.root.name).toBe('Root(Environment)')
    expect(env.root.children[0]!.children.map(c => [c.name, c.profileId, c.short0, c.int0, c.int1])).toEqual([
      ['town', 15, 2, 2, 2],
      ['field', 3, 2, 2, 2],
    ])
    expect(listEnvLeaves(env).map(l => [l.path.join('/'), l.profileId])).toEqual([
      ['group/town', 15],
      ['group/field', 3],
    ])
  })

  it('rejects malformed files with offsets', () => {
    const bad = makeEnv()
    bad[11] = 0x32
    expect(() => parseEnvironment(bad)).toThrow(/bad signature/)
    expect(() => parseEnvironment(makeEnv({ trailing: true }))).toThrow(/2 trailing bytes/)
    expect(() => parseEnvironment(makeEnv({ truncate: 3 }))).toThrow(/node tree at offset \d+/)
    expect(() => parseEnvironment(makeEnv().subarray(0, 200))).toThrow(/profile 0 at offset 18/)
  })
})

describe('graph sampling', () => {
  const keys = [
    { r: 0, g: 0, b: 0, time: 0.25 },
    { r: 1, g: 0.5, b: 0, time: 0.75 },
  ]
  it('interpolates between keys and wraps around midnight', () => {
    expect(sampleEnvColor(keys, 0.5)).toEqual([0.5, 0.25, 0])
    expect(sampleEnvColor(keys, 0.25)).toEqual([0, 0, 0])
    // 0.75 -> 1.25 wraps: t = 1.0 is halfway
    expect(sampleEnvColor(keys, 1)).toEqual([0.5, 0.25, 0])
    expect(sampleEnvColor(keys, 0)).toEqual([0.5, 0.25, 0])
    expect(sampleEnvColor(keys, 0.125)[0]).toBeCloseTo(0.25)
    expect(sampleEnvColor(keys, 0.875)[0]).toBeCloseTo(0.75)
  })

  it('samples float graphs and single keys', () => {
    const f = [
      { value: -1, time: 0 },
      { value: 1, time: 0.5 },
      { value: -1, time: 1 },
    ]
    expect(sampleEnvFloat(f, 0.25)).toBe(0)
    expect(sampleEnvFloat(f, 0.75)).toBe(0)
    expect(sampleEnvFloat(f, 0.5)).toBe(1)
    expect(sampleEnvFloat([{ value: 3, time: 0.4 }], 0.9)).toBe(3)
    expect(() => sampleEnvFloat([], 0)).toThrow(/empty/)
  })
})
