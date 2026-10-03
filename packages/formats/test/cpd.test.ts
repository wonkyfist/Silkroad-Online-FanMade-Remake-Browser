import { describe, expect, it } from 'vitest'
import { cpdReferencedPaths, parseCpd } from '../src/cpd.ts'

/** Little-endian builder for synthetic .cpd files; offsets are patched once the layout is known. */
class Writer {
  parts: number[] = []
  get offset(): number {
    return this.parts.length
  }
  u16(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff)
    return this
  }
  u32(v: number): this {
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (i * 8)) & 0xff)
    return this
  }
  patch32(at: number, v: number): this {
    for (let i = 0; i < 4; i++) this.parts[at + i] = (v >>> (i * 8)) & 0xff
    return this
  }
  raw(bytes: ArrayLike<number>): this {
    this.parts.push(...Array.from(bytes))
    return this
  }
  ascii(s: string): this {
    return this.raw(Array.from(s, c => c.charCodeAt(0)))
  }
  str(s: string | number[]): this {
    const bytes = typeof s === 'string' ? Array.from(s, c => c.charCodeAt(0)) : s
    return this.u32(bytes.length).raw(bytes)
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

interface Spec {
  type?: number
  name?: string
  collision?: string
  resources?: Array<string | number[]>
  gapAfterObjInfo?: number
  trailing?: number
}

function build(spec: Spec = {}): Uint8Array {
  const w = new Writer().ascii('JMXVCPD 0101').u32(0).u32(0)
  for (let i = 0; i < 5; i++) w.u32(0)
  w.u16(spec.type ?? 2).u16(3).str(spec.name ?? 'wreck_bship_in_01').u32(3).u32(2)
  for (let i = 0; i < (spec.gapAfterObjInfo ?? 0); i++) w.parts.push(0)
  w.patch32(12, w.offset)
  w.str(spec.collision ?? 'res\\dun\\wreck\\ship.bsr')
  w.patch32(16, w.offset)
  const resources = spec.resources ?? ['res\\dun\\wreck\\ship.bsr', 'res\\dun\\wreck\\web.bsr']
  w.u32(resources.length)
  for (const r of resources) w.str(r)
  for (let i = 0; i < (spec.trailing ?? 0); i++) w.parts.push(0)
  return w.bytes()
}

describe('parseCpd', () => {
  it('reads the header, objInfo, collision resource and child resources', () => {
    const cpd = parseCpd(build())
    expect(cpd).toMatchObject({
      signature: 'JMXVCPD 0101',
      headerUnknown: [0, 0, 0, 0, 0],
      type: 2,
      typeName: 'BUILDING',
      category: 3,
      categoryName: 'COMPOUND',
      name: 'wreck_bship_in_01',
      unknown5: 3,
      unknown6: 2,
      collisionPath: 'res\\dun\\wreck\\ship.bsr',
      resourcePaths: ['res\\dun\\wreck\\ship.bsr', 'res\\dun\\wreck\\web.bsr'],
    })
    expect(cpd.collisionOffset).toBe(12 + 8 + 20 + 4 + 4 + 17 + 8)
    expect(cpdReferencedPaths(cpd)).toEqual(['res\\dun\\wreck\\ship.bsr', 'res\\dun\\wreck\\ship.bsr', 'res\\dun\\wreck\\web.bsr'])
  })

  it('handles character compounds without collision and NUL-padded strings', () => {
    const padded = [...Array.from('res\\char\\a.bsr', c => c.charCodeAt(0)), 0, 0]
    const cpd = parseCpd(build({ type: 0, name: '1', collision: '', resources: [padded, 'res\\item\\b.bsr'] }))
    expect(cpd.typeName).toBe('CHARACTER')
    expect(cpd.collisionPath).toBe('')
    expect(cpd.resourcePaths).toEqual(['res\\char\\a.bsr', 'res\\item\\b.bsr'])
    expect(cpdReferencedPaths(cpd)).toEqual(cpd.resourcePaths)
  })

  it('throws with an offset on malformed input', () => {
    expect(() => parseCpd(new Uint8Array(8))).toThrow(/CPD: .* at offset 0/)
    const bad = build()
    bad[8] = 0x39
    expect(() => parseCpd(bad)).toThrow(/signature/)
    expect(() => parseCpd(build({ gapAfterObjInfo: 2 }))).toThrow(/objInfo ends at .* but the next section starts/)
    expect(() => parseCpd(build({ trailing: 3 }))).toThrow(/3 unexpected bytes/)
    const truncated = build().subarray(0, build().length - 4)
    expect(() => parseCpd(truncated)).toThrow(/CPD: /)
    const offsets = build()
    offsets[12] = 0xff
    offsets[13] = 0xff
    expect(() => parseCpd(offsets)).toThrow(/collision offset .* outside file/)
  })
})
