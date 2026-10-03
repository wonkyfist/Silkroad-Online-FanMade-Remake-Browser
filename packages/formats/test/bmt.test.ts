import { describe, expect, it } from 'vitest'
import { BMT_FLAG, BMT_KNOWN_FLAGS, bmtFlagNames, parseBmt, resolveBmtTexturePath, type BmtColor4 } from '../src/bmt.ts'

class Writer {
  private readonly parts: number[] = []
  u8(v: number): this {
    this.parts.push(v & 0xff)
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
  raw(bytes: ArrayLike<number>): this {
    this.parts.push(...Array.from(bytes))
    return this
  }
  ascii(s: string): this {
    return this.raw(Array.from(s, c => c.charCodeAt(0)))
  }
  str(s: string | Uint8Array): this {
    const bytes = typeof s === 'string' ? Array.from(s, c => c.charCodeAt(0)) : s
    return this.u32(bytes.length).raw(bytes)
  }
  color(c: BmtColor4): this {
    for (const x of c) this.f32(x)
    return this
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

interface MatSpec {
  name?: string | Uint8Array
  flags: number
  path?: string | Uint8Array
  absolute?: number
  power?: number
  b0?: number
  b1?: number
  normal?: { path: string; unknown: number }
}

function material(w: Writer, m: MatSpec): Writer {
  w.str(m.name ?? 'mat')
    .color([0.5, 0.25, 0.125, 1])
    .color([0.1, 0.2, 0.3, 0.4])
    .color([0.9, 0.9, 0.9, 1])
    .color([0, 0, 0, 1])
    .f32(m.power ?? 0)
    .u32(m.flags)
    .str(m.path ?? '')
    .f32(1)
    .u8(m.b0 ?? 24)
    .u8(m.b1 ?? 0)
    .u8(m.absolute ?? 0)
  if (m.normal) w.str(m.normal.path).u32(m.normal.unknown)
  return w
}

function bmt(mats: MatSpec[], signature = 'JMXVBMT 0102'): Writer {
  const w = new Writer().ascii(signature).u32(mats.length)
  for (const m of mats) material(w, m)
  return w
}

describe('parseBmt', () => {
  it('reads materials, colours, flags and the diffuse-map block', () => {
    const file = parseBmt(
      bmt([
        { name: 'body', flags: 0x340, path: 'body.ddj', b0: 32, b1: 8 },
        { name: 'hair', flags: 0x145, power: 42, path: 'prim\\mtrl\\x\\hair.ddj', absolute: 1 },
        { name: 'none', flags: 0x40 },
      ]).bytes(),
    )
    expect(file.signature).toBe('JMXVBMT 0102')
    expect(file.version).toBe(102)
    expect(file.materials).toHaveLength(3)
    const [body, hair, none] = file.materials
    expect(body.name).toBe('body')
    expect(body.diffuse).toEqual([0.5, 0.25, 0.125, 1])
    expect(body.ambient.map(x => +x.toFixed(6))).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(body.specular.map(x => +x.toFixed(6))).toEqual([0.9, 0.9, 0.9, 1])
    expect(body.emissive).toEqual([0, 0, 0, 1])
    expect(body.flags).toBe(0x340)
    expect(body.flagNames).toEqual(['colorTint', 'diffuseMap', 'alpha'])
    expect(body.unknownFlags).toBe(0)
    expect(body.diffuseMap).toEqual({ path: 'body.ddj', isAbsolute: false, unknownFloat: 1, unknownByte0: 32, unknownByte1: 8 })
    expect(body.normalMap).toBeNull()

    expect(hair.power).toBe(42)
    expect(hair.flagNames).toEqual(['twoSided', 'specular', 'colorTint', 'diffuseMap'])
    expect(hair.diffuseMap.isAbsolute).toBe(true)
    expect(hair.diffuseMap.path).toBe('prim\\mtrl\\x\\hair.ddj')

    expect(none.flagNames).toEqual(['colorTint'])
    expect(none.diffuseMap.path).toBe('')
  })

  it('reads the normal-map block only when flag 0x2000 is set', () => {
    const file = parseBmt(
      bmt([
        { name: 'bump', flags: 0x2140, path: 'd.ddj', normal: { path: 'n.ddj', unknown: 7 } },
        { name: 'flat', flags: 0x140, path: 'd.ddj' },
      ]).bytes(),
    )
    expect(file.materials[0].flagNames).toContain('normalMap')
    expect(file.materials[0].normalMap).toEqual({ path: 'n.ddj', unknown: 7 })
    expect(file.materials[1].normalMap).toBeNull()
  })

  it('does not treat 0x4000 (Lafa2K\'s 1 << 14) as the normal-map gate', () => {
    const file = parseBmt(bmt([{ name: 'a', flags: 0x4140, path: 'd.ddj' }, { name: 'b', flags: 0x140 }]).bytes())
    expect(file.materials[0].normalMap).toBeNull()
    expect(file.materials[0].unknownFlags).toBe(0x4000)
    expect(file.materials[1].name).toBe('b')
  })

  it('keeps unknown flag bits', () => {
    const m = parseBmt(bmt([{ flags: 0x80000142 }]).bytes()).materials[0]
    expect(m.flags).toBe(0x80000142)
    expect(m.unknownFlags).toBe(0x80000002)
    expect(m.flagNames).toEqual(['colorTint', 'diffuseMap'])
  })

  it('decodes CP949 names and paths', () => {
    // "나무01.ddj" in CP949
    const path = Uint8Array.of(0xb3, 0xaa, 0xb9, 0xab, 0x30, 0x31, 0x2e, 0x64, 0x64, 0x6a)
    const m = parseBmt(bmt([{ name: 'W_CD_tree01', flags: 0x341, path }]).bytes()).materials[0]
    expect(m.diffuseMap.path).toBe('나무01.ddj')
  })

  it('accepts an empty material set', () => {
    expect(parseBmt(bmt([]).bytes()).materials).toEqual([])
  })

  it('rejects a bad signature or version', () => {
    expect(() => parseBmt(bmt([], 'JMXVBMS 0110').bytes())).toThrow(/signature/)
    expect(() => parseBmt(bmt([], 'JMXVBMT 0101').bytes())).toThrow(/unsupported version/)
    expect(() => parseBmt(new Uint8Array(5))).toThrow(/truncated header/)
  })

  it('rejects truncated, overrunning and trailing data with an offset', () => {
    const good = bmt([{ flags: 0x140, path: 'a.ddj' }]).bytes()
    expect(() => parseBmt(good.subarray(0, good.length - 1))).toThrow(/BMT: .* at offset \d+/)
    expect(() => parseBmt(Uint8Array.from([...good, 0]))).toThrow(/1 unexpected trailing bytes at offset/)
    const overrun = new Writer().ascii('JMXVBMT 0102').u32(1).u32(1000).raw(new Uint8Array(100)).bytes()
    expect(() => parseBmt(overrun)).toThrow(/name length 1000 overruns file at offset 16/)
    const tooMany = new Writer().ascii('JMXVBMT 0102').u32(1000).bytes()
    expect(() => parseBmt(tooMany)).toThrow(/material count 1000 does not fit/)
    // flag says a normal map follows but the file ends
    expect(() => parseBmt(bmt([{ flags: 0x2140, path: 'a.ddj' }]).bytes())).toThrow(/normal map path length/)
  })

  it('rejects a non-bool isAbsolute byte', () => {
    expect(() => parseBmt(bmt([{ flags: 0x140, path: 'a.ddj', absolute: 2 }]).bytes())).toThrow(/isAbsolute byte 2 is not a bool at offset/)
  })
})

describe('flags', () => {
  it('names known bits in bit order', () => {
    expect(bmtFlagNames(0x234f)).toEqual(['twoSided', 'specular', 'selfIlluminated', 'colorTint', 'diffuseMap', 'alpha', 'normalMap'])
    expect(BMT_KNOWN_FLAGS).toBe(0x234d)
    expect(BMT_FLAG.normalMap).toBe(1 << 13)
  })
})

describe('resolveBmtTexturePath', () => {
  const bmtPath = 'prim\\mtrl\\char\\china\\man\\chinaman_adventurer.bmt'
  it('joins relative paths to the BMT folder', () => {
    expect(resolveBmtTexturePath(bmtPath, { path: 'chinaman_adventurer_body.ddj', isAbsolute: false })).toBe(
      'prim\\mtrl\\char\\china\\man\\chinaman_adventurer_body.ddj',
    )
    expect(resolveBmtTexturePath('prim/mtrl/a.bmt', { path: 'x.ddj', isAbsolute: false })).toBe('prim\\mtrl\\x.ddj')
    expect(resolveBmtTexturePath('a.bmt', { path: 'x.ddj', isAbsolute: false })).toBe('x.ddj')
  })
  it('uses absolute paths as stored', () => {
    expect(resolveBmtTexturePath(bmtPath, { path: 'prim\\mtrl\\bldg\\naru_obj.ddj', isAbsolute: true })).toBe('prim\\mtrl\\bldg\\naru_obj.ddj')
    expect(resolveBmtTexturePath(bmtPath, { path: '\\prim/mtrl/a.ddj', isAbsolute: true })).toBe('prim\\mtrl\\a.ddj')
  })
  it('returns an empty string for no texture', () => {
    expect(resolveBmtTexturePath(bmtPath, { path: '', isAbsolute: false })).toBe('')
  })
})
