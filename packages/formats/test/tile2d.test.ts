import { describe, expect, it } from 'vitest'
import { parseTile2d, resolveTile2d, TILE2D_TYPES } from '../src/tile2d.ts'

const SAMPLE = [
  'JMXV2DTI1001',
  '4',
  '00000 0x00000000 "CJfild" "c_dust_fld_01.ddj"',
  '00001 0x0000000a "HMfild" "c_grass_hmfld_01.ddj" {757,64}',
  '00002 0x00000000 "Rock Mt" "rok_grass_01.ddj" {1086,37} {1159,2}',
  '00003 0x0000000e "East Europe" "odd.ddj"',
  '',
].join('\n')

describe('parseTile2d', () => {
  it('parses records, quoted columns with spaces and grass pairs', () => {
    const t = parseTile2d(SAMPLE)
    expect(t.signature).toBe('JMXV2DTI1001')
    expect(t.declaredCount).toBe(4)
    expect(t.entries.length).toBe(4)
    expect(t.entries[1]).toEqual({
      id: 1,
      type: 10,
      typeName: 'Grass',
      category: 'HMfild',
      file: 'c_grass_hmfld_01.ddj',
      path: 'tile2d/c_grass_hmfld_01.ddj',
      grass: [{ objectId: 757, density: 64 }],
      row: 1,
    })
    expect(t.entries[2]!.category).toBe('Rock Mt')
    expect(t.entries[2]!.grass).toEqual([
      { objectId: 1086, density: 37 },
      { objectId: 1159, density: 2 },
    ])
    expect(t.entries[0]!.typeName).toBe('Dirt')
    expect(t.entries[3]!.type).toBe(14)
    expect(t.entries[3]!.typeName).toBeUndefined()
    expect(TILE2D_TYPES.length).toBe(14)
  })

  it('accepts bytes with CRLF line endings', () => {
    const t = parseTile2d(new TextEncoder().encode(SAMPLE.replace(/\n/g, '\r\n')))
    expect(t.entries.map(e => e.file)).toEqual(['c_dust_fld_01.ddj', 'c_grass_hmfld_01.ddj', 'rok_grass_01.ddj', 'odd.ddj'])
  })

  it('keys by the id column, not the line position', () => {
    const t = parseTile2d(['JMXV2DTI1001', '2', '00005 0x3 "a" "five.ddj"', '00002 0x3 "a" "two.ddj"'].join('\n'))
    expect(t.byId.get(5)!.row).toBe(0)
    expect(t.byId.get(2)!.file).toBe('two.ddj')
    expect(t.byId.get(0)).toBeUndefined()
  })

  it('resolves raw .m texture words by their low 10 bits', () => {
    const t = parseTile2d(SAMPLE)
    expect(resolveTile2d(t, 0x8002)!.file).toBe('rok_grass_01.ddj')
    expect(resolveTile2d(t, 0x4001)!.id).toBe(1)
    expect(resolveTile2d(t, 0x0404)).toBeUndefined() // id 4 is not listed; bit 10 is not part of the id
  })

  it('rejects malformed files', () => {
    expect(() => parseTile2d('JMXV2DTI1000\n0\n')).toThrow(/bad signature/)
    expect(() => parseTile2d('JMXV2DTI1001\nx\n')).toThrow(/bad record count/)
    expect(() => parseTile2d('JMXV2DTI1001\n2\n00000 0x0 "a" "b.ddj"\n')).toThrow(/declares 2 records, found 1/)
    expect(() => parseTile2d('JMXV2DTI1001\n1\n00000 0x0 "a"\n')).toThrow(/malformed record on line 3/)
    expect(() => parseTile2d('JMXV2DTI1001\n1\n00000 0x0 "a" "b.ddj" {1,x}\n')).toThrow(/malformed grass/)
    expect(() => parseTile2d('JMXV2DTI1001\n2\n00000 0x0 "a" "b.ddj"\n00000 0x0 "a" "c.ddj"\n')).toThrow(/duplicate id 0/)
  })
})
