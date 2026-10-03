import { describe, expect, it } from 'vitest'
import { eucKr } from '../src/binary.ts'
import { parseObjectExtIfo, parseObjectIfo, parseObjectStringIfo } from '../src/obji.ts'

const bitsHex = (v: number) => {
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, v)
  return '0x' + view.getUint32(0).toString(16).padStart(8, '0')
}

describe('parseObjectIfo', () => {
  it('reads index, flags and quoted paths (with spaces)', () => {
    const text = [
      'JMXVOBJI1000',
      '3',
      '00000 0x00000001 "res\\bldg\\china\\cj_ferry\\cj_ferry_buil.bsr"',
      '00001 0x00000000 "res\\npc\\npc\\chinasystem_boatman 2.bsr"',
      '00002 0x00000000 "compound\\struct\\x.cpd"',
      '',
    ].join('\n')
    const ifo = parseObjectIfo(text)
    expect(ifo.signature).toBe('JMXVOBJI1000')
    expect(ifo.entries).toEqual([
      { index: 0, flags: 1, path: 'res\\bldg\\china\\cj_ferry\\cj_ferry_buil.bsr' },
      { index: 1, flags: 0, path: 'res\\npc\\npc\\chinasystem_boatman 2.bsr' },
      { index: 2, flags: 0, path: 'compound\\struct\\x.cpd' },
    ])
    expect(ifo.byIndex.get(1)?.path).toMatch(/boatman 2\.bsr$/)
  })

  it('decodes CP949 bytes and accepts CRLF', () => {
    const head = new TextEncoder().encode('JMXVOBJI1000\r\n1\r\n00090 0x00000000 "res\\interface\\')
    const korean = Uint8Array.of(0xb9, 0xda, 0xbd, 0xba)
    const tail = new TextEncoder().encode('.bsr"\r\n')
    const bytes = new Uint8Array([...head, ...korean, ...tail])
    const ifo = parseObjectIfo(bytes)
    expect(ifo.entries[0]!.path).toBe(`res\\interface\\${eucKr.decode(korean)}.bsr`)
    expect(ifo.entries[0]!.path).not.toContain('�')
  })

  it('throws with a line number on malformed input', () => {
    expect(() => parseObjectIfo('JMXVOBJI1001\n0\n')).toThrow(/signature.*line 1/)
    expect(() => parseObjectIfo('JMXVOBJI1000\nx\n')).toThrow(/count.*line 2/)
    expect(() => parseObjectIfo('JMXVOBJI1000\n2\n00000 0x0 "a.bsr"\n')).toThrow(/1 records but the header declares 2/)
    expect(() => parseObjectIfo('JMXVOBJI1000\n1\n00000 0x0 "a.bsr"\n00001 0x0 "b.bsr"\n')).toThrow(/more than.*line 4/)
    expect(() => parseObjectIfo('JMXVOBJI1000\n1\n00000 0x0 "a.bsr\n')).toThrow(/unterminated.*line 3/)
    expect(() => parseObjectIfo('JMXVOBJI1000\n1\n00000 0x0\n')).toThrow(/3 columns.*line 3/)
    expect(() => parseObjectIfo('JMXVOBJI1000\n2\n00000 0x0 "a"\n00000 0x0 "b"\n')).toThrow(/duplicate index 0 at line 4/)
    expect(() => parseObjectIfo('JMXVOBJI1000\n1\n0zz 0x0 "a"\n')).toThrow(/bad index/)
  })
})

describe('parseObjectStringIfo', () => {
  it('splits the unique id and decodes float bit patterns', () => {
    const text = [
      'JMXVOBJI1000',
      '2',
      `0x7de41001 0x00000000 228 125 ${bitsHex(1575.5)} ${bitsHex(788.75)} ${bitsHex(65.25)} ${bitsHex(1.5)} "POS_STRUCTURE_GOD_BIG_GATE_TOGUI_1"`,
      `0xffff0048 0x00000000 9 128 0x441af12d 0x3c8e2200 0xc2cbfd08 0xbfc90fdb "STRUCTURE_POS_EVENT_GATE_BLUE"`,
    ].join('\n')
    const { entries } = parseObjectStringIfo(text)
    expect(entries[0]).toEqual({
      uniqueId: 0x7de41001,
      regionId: 0x7de4,
      uid: 0x1001,
      flags: 0,
      regionX: 228,
      regionZ: 125,
      position: [1575.5, 788.75, 65.25],
      yaw: 1.5,
      name: 'POS_STRUCTURE_GOD_BIG_GATE_TOGUI_1',
    })
    expect(entries[1]!.regionId).toBe(0xffff)
    expect(entries[1]!.yaw).toBeCloseTo(-Math.PI / 2, 6)
    expect(entries[1]!.position[0]).toBeCloseTo(619.77, 2)
  })
})

describe('parseObjectExtIfo', () => {
  it('reads the unique id and two quoted strings', () => {
    const { entries } = parseObjectExtIfo('JMXVOBJI1000\n1\n0x19500009 "" "passent01"\n')
    expect(entries).toEqual([{ uniqueId: 0x19500009, regionId: 0x1950, uid: 9, unknown: '', value: 'passent01' }])
  })
})
