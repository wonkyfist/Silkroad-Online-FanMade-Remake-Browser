import { describe, expect, it } from 'vitest'
import {
  buildStringMap,
  characterDataRow,
  characterStats,
  decodeCp949,
  decodeTextdata,
  fourCC,
  isPlayerCharacter,
  itemDataRow,
  itemStatColumns,
  levelDataRow,
  levelGoldRow,
  loadTextdataTable,
  npcPosRow,
  parseSkillParams,
  parseTextdata,
  skillDataRow,
  skillDetail,
  skillParamTag,
  textdataInt,
  textdataOptCell,
  textStringRow,
  type TextdataRow,
} from '../src/textdata.ts'

const utf16le = (s: string, bom = true): Uint8Array => {
  const out = new Uint8Array((bom ? 2 : 0) + s.length * 2)
  let o = 0
  if (bom) {
    out[o++] = 0xff
    out[o++] = 0xfe
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out[o++] = c & 0xff
    out[o++] = c >> 8
  }
  return out
}
const utf8 = (s: string, bom = false): Uint8Array => {
  const body = new TextEncoder().encode(s)
  return bom ? Uint8Array.of(0xef, 0xbb, 0xbf, ...body) : body
}
const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0))

/** "한글" in CP949 (KS X 1001), and three UHC-extension syllables that Node's own euc-kr decoder gets wrong. */
const HANGUL_CP949 = [0xc7, 0xd1, 0xb1, 0xdb]
const UHC_CP949 = [0x81, 0x41, 0x88, 0xdb, 0xc6, 0x52]

const row = (cells: string[], line = 1): TextdataRow => ({ file: 'test.txt', line, cells })

describe('decodeTextdata', () => {
  it('decodes UTF-16LE with a BOM and strips it', () => {
    const d = decodeTextdata(utf16le('1\tCHAR\t한글\r\n'))
    expect(d).toEqual({ encoding: 'utf-16le', bomLength: 2, text: '1\tCHAR\t한글\r\n' })
  })

  it('detects BOM-less UTF-16LE from the NUL pattern', () => {
    expect(decodeTextdata(utf16le('1\tabc\r\n', false))).toEqual({ encoding: 'utf-16le', bomLength: 0, text: '1\tabc\r\n' })
    // U+00FF is FF 00, not the FF FE BOM.
    expect(decodeTextdata(utf16le('ÿa\r\n', false))).toEqual({ encoding: 'utf-16le', bomLength: 0, text: 'ÿa\r\n' })
  })

  it('decodes UTF-8 with and without a BOM (plain ASCII counts as UTF-8)', () => {
    expect(decodeTextdata(utf8('a\t한\n', true))).toEqual({ encoding: 'utf-8', bomLength: 3, text: 'a\t한\n' })
    expect(decodeTextdata(utf8('a\t한\n'))).toEqual({ encoding: 'utf-8', bomLength: 0, text: 'a\t한\n' })
    expect(decodeTextdata(utf8('1\t2\r\n')).encoding).toBe('utf-8')
  })

  it('falls back to CP949 when the bytes are not UTF-8', () => {
    const bytes = Uint8Array.of(...ascii('// '), ...HANGUL_CP949, ...ascii('\r\n1\t'), ...UHC_CP949, 0x0d, 0x0a)
    expect(decodeTextdata(bytes)).toEqual({ encoding: 'cp949', bomLength: 0, text: '// 한글\r\n1\t갂댸힣\r\n' })
  })

  it('rejects bytes that are neither, with the offset', () => {
    // Shaped like the head of SkillData_5000ENC.txt: a NUL makes it binary.
    expect(() => decodeTextdata(Uint8Array.of(0xe2, 0xb0, 0x22, 0x30, 0x00, 0x30))).toThrow(/NUL byte at offset 4/)
    expect(() => decodeTextdata(Uint8Array.of(0x31, 0x09, 0xff, 0x41))).toThrow(/byte 0xff at offset 2/)
    expect(() => decodeTextdata(Uint8Array.of(0x31, 0x09, 0xc7))).toThrow(/offset 2/)
    expect(() => decodeTextdata(Uint8Array.of(0xfe, 0xff, 0x00, 0x31))).toThrow(/UTF-16BE/)
    expect(() => decodeTextdata(Uint8Array.of(0xff, 0xfe, 0x31))).toThrow(/odd byte count/)
    expect(() => decodeTextdata(Uint8Array.of(0xff, 0xfe, 0x00, 0xd8))).toThrow(/surrogate/)
  })
})

describe('decodeCp949', () => {
  it('decodes KS X 1001 and the UHC extension (iconv CP949 reference values)', () => {
    const r = decodeCp949(Uint8Array.of(...HANGUL_CP949, ...UHC_CP949, 0x8c, 0x63, 0xa0, 0xfe, 0xa1, 0x41, 0xa2, 0xe6))
    expect(r).toEqual({ ok: true, text: '한글갂댸힣똠좤좥€' })
  })

  it('rejects unassigned pairs, user-defined rows, lone leads and invalid trails', () => {
    expect(decodeCp949(Uint8Array.of(0x41, 0xc9, 0xa1))).toEqual({ ok: false, offset: 1 })
    expect(decodeCp949(Uint8Array.of(0xc6, 0x53))).toEqual({ ok: false, offset: 0 })
    expect(decodeCp949(Uint8Array.of(0x81, 0x30))).toEqual({ ok: false, offset: 0 })
    expect(decodeCp949(Uint8Array.of(0x41, 0x42, 0xb0))).toEqual({ ok: false, offset: 2 })
    expect(decodeCp949(Uint8Array.of(0x80))).toEqual({ ok: false, offset: 0 })
  })
})

describe('parseTextdata', () => {
  it('splits rows and cells, skips blank and comment lines, keeps cells verbatim', () => {
    const text = [
      '//Service\tCodeName128\tKorean',
      '1\tSN_A\t가 \t',
      '',
      '\t\t\t',
      '// a note',
      '\t// indented note',
      '0\tSN_B\txxx',
    ].join('\r\n') + '\r\n'
    const t = parseTextdata(utf16le(text), 'strings.txt')
    expect(t.encoding).toBe('utf-16le')
    expect(t.header).toEqual(['Service', 'CodeName128', 'Korean'])
    expect(t.rows).toEqual([
      { file: 'strings.txt', line: 2, cells: ['1', 'SN_A', '가 ', ''] },
      { file: 'strings.txt', line: 7, cells: ['0', 'SN_B', 'xxx'] },
    ])
    expect(t.comments.map(c => [c.line, c.text])).toEqual([
      [1, 'Service\tCodeName128\tKorean'],
      [5, ' a note'],
      [6, ' indented note'],
    ])
    expect(t.blankLines).toBe(2)
    expect(t.index).toBeUndefined()
  })

  it('accepts LF and CR line ends and a string with a BOM character', () => {
    const t = parseTextdata('﻿1\ta\n2\tb\r3\tc')
    expect(t.rows.map(r => [r.line, r.cells[1]])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ])
  })

  it('takes a header only from a tabbed comment before the first row', () => {
    expect(parseTextdata('// just words\n1\t2\n//A\tB\n').header).toBeUndefined()
  })

  it('handles empty files (BOM only, BOM + CRLF)', () => {
    for (const bytes of [Uint8Array.of(0xff, 0xfe), utf16le('\r\n'), new Uint8Array(0)]) {
      const t = parseTextdata(bytes)
      expect(t.rows).toEqual([])
      expect(t.index).toBeUndefined()
    }
  })

  it('recognizes index files', () => {
    const t = parseTextdata(utf16le('CharacterData_5000.txt\r\nCharacterData_10000.txt\r\n'))
    expect(t.index).toEqual(['CharacterData_5000.txt', 'CharacterData_10000.txt'])
    // Single numeric cells (maxtradescaledata.txt) or names with a tab are not an index.
    expect(parseTextdata('0\n510\n').index).toBeUndefined()
    expect(parseTextdata('a.txt\t1\n').index).toBeUndefined()
    expect(parseTextdata('TextData_Equip&Skill.txt\r\nTextData_Object.txt\r\n').index).toEqual(['TextData_Equip&Skill.txt', 'TextData_Object.txt'])
  })
})

describe('loadTextdataTable', () => {
  const files: Record<string, Uint8Array> = {
    'itemdata.txt': utf16le('ItemData_5000.txt\r\nItemData_10000.txt\r\n'),
    'itemdata_5000.txt': utf16le('//Service\tID\r\n1\t5\r\n'),
    'itemdata_10000.txt': utf16le('1\t10\r\n1\t11\r\n'),
    'loop.txt': utf16le('Loop.txt\r\n'),
    'broken.txt': utf16le('Missing_1.txt\r\n'),
  }
  const read = (name: string) => files[name.toLowerCase()]

  it('expands an index case-insensitively, in listed order', () => {
    const t = loadTextdataTable('ItemData.txt', read)
    expect(t.files.map(f => f.file)).toEqual(['ItemData.txt', 'ItemData_5000.txt', 'ItemData_10000.txt'])
    expect(t.rows.map(r => `${r.file}:${r.line}:${r.cells[1]}`)).toEqual(['ItemData_5000.txt:2:5', 'ItemData_10000.txt:1:10', 'ItemData_10000.txt:2:11'])
    expect(t.header).toEqual(['Service', 'ID'])
  })

  it('reads a plain file as a one-file table', () => {
    expect(loadTextdataTable('itemdata_10000.txt', read).rows).toHaveLength(2)
  })

  it('throws on missing files and index cycles', () => {
    expect(() => loadTextdataTable('nope.txt', read)).toThrow(/nope.txt not found/)
    expect(() => loadTextdataTable('broken.txt', read)).toThrow(/Missing_1.txt not found \(listed by broken.txt\)/)
    expect(() => loadTextdataTable('loop.txt', read)).toThrow(/cycle/)
  })
})

/** A characterdata row shaped like CHAR_CH_MAN_ADVENTURER (104 cells). */
function characterCells(): string[] {
  const c = Array.from({ length: 104 }, () => '0')
  Object.assign(c, { 0: '1', 1: '1907', 2: 'CHAR_CH_MAN_ADVENTURER', 3: 'xxx', 4: 'xxx', 5: 'xxx', 6: 'xxx', 8: '1', 9: '1', 10: '1' })
  for (let i = 32; i <= 40; i += 2) c[i] = '-1'
  Object.assign(c, { 13: '1000000000', 46: '16', 47: '50', 48: '100', 52: 'char\\china\\chinaman_adventurer.bsr', 53: 'xxx', 54: 'xxx', 55: 'xxx', 56: 'xxx', 57: '1', 58: '1' })
  return c
}

describe('typed rows', () => {
  it('reads characterdata rows', () => {
    const r = characterDataRow(row(characterCells()))
    expect(r).toMatchObject({
      service: true,
      id: 1907,
      codeName: 'CHAR_CH_MAN_ADVENTURER',
      typeId: [1, 1, 0, 0],
      country: 0,
      walkSpeed: 16,
      runSpeed: 50,
      scale: 100,
      assocFileObj: 'char\\china\\chinaman_adventurer.bsr',
      level: 1,
      gender: 1,
      maxHp: 0,
    })
    expect(r.nameStrId).toBeUndefined()
    expect(r.reqLevels[0]).toEqual({ type: -1, level: 0 })
    expect(isPlayerCharacter(r)).toBe(true)
  })

  it('reads itemdata rows and derives the degree', () => {
    const c = Array.from({ length: 160 }, () => '0')
    Object.assign(c, { 0: '1', 1: '3632', 2: 'ITEM_CH_SWORD_01_A_DEF', 5: 'SN_ITEM_CH_SWORD_01_A_DEF', 9: '3', 10: '1', 11: '6', 12: '2' })
    Object.assign(c, { 32: '1', 33: '1', 34: '-1', 36: '-1', 38: '-1', 52: 'item\\china\\weapon\\sword_01.bsr', 57: '1', 58: '2', 61: '5', 63: '62.0', 93: '0', 94: '6' })
    const r = itemDataRow(row(c))
    expect(r).toMatchObject({ codeName: 'ITEM_CH_SWORD_01_A_DEF', nameStrId: 'SN_ITEM_CH_SWORD_01_A_DEF', typeId: [3, 1, 6, 2], itemClass: 5, degree: 2, reqGender: 2, twoHanded: false, range: 6 })
    expect(r.reqLevels[0]).toEqual({ type: 1, level: 1 })
  })

  it('reads leveldata and skilldata rows', () => {
    expect(levelDataRow(row(['1', '118', '1', '0', '0', '24', '70875', '70875', '70875']))).toEqual({
      level: 1,
      exp: 118,
      masterySp: 1,
      unknown: [0, 0, 24],
      jobExp: [70875, 70875, 70875],
    })
    const s = Array.from({ length: 118 }, () => '0')
    Object.assign(s, { 0: '1', 1: '2', 2: '173', 3: 'SKILL_CH_SWORD_BASE_01', 4: '검', 5: 'SKILL_CH_SWORD_BASE', 7: '1' })
    expect(skillDataRow(row(s))).toMatchObject({ id: 2, groupId: 173, code: 'SKILL_CH_SWORD_BASE_01', group: 'SKILL_CH_SWORD_BASE', level: 1 })
  })

  it('reports the file, line and column of bad cells', () => {
    const c = characterCells()
    c[9] = 'x'
    expect(() => characterDataRow(row(c, 7))).toThrow('test.txt:7 column 9 (TypeID1): not an integer: "x"')
    expect(() => characterDataRow(row(c.slice(0, 60), 3))).toThrow('test.txt:3: characterdata row has 60 cells, expected at least 61')
    expect(() => textdataInt(row(['99999999999999999999']), 0, 'big')).toThrow(/out of range/)
    expect(textdataOptCell(row(['xxx', ' ', 'a']), 0)).toBeUndefined()
    expect(textdataOptCell(row(['xxx', ' ', 'a']), 1)).toBeUndefined()
    expect(() => textdataOptCell(row(['a']), 3, 'far')).toThrow('test.txt:1 column 3 (far): row has only 1 cells')
  })

  it('reads monster stat columns (MOB_CH_MANGNYANG values)', () => {
    const c = characterCells()
    Object.assign(c, { 2: 'MOB_CH_MANGNYANG', 40: '3', 49: '0', 50: '6', 71: '7', 72: '10', 73: '1', 74: '1', 75: '27', 76: '0', 77: '27', 78: '2', 79: '24' })
    Object.assign(c, { 80: '336860180', 81: '3', 82: '3000', 83: '160', 84: '161', 93: '0' })
    const s = characterStats(characterDataRow(row(c)))
    expect(s).toMatchObject({ bcRadius: 6, physDefence: 7, magDefence: 10, physAbsorb: 1, parryRate: 27, hitRate: 27, critRate: 2, exp: 24, koRecoverMs: 3000, cloneFlag: 0 })
    expect(s.defaultSkills).toEqual([160, 161])
    expect(() => characterStats(characterDataRow(row(c.slice(0, 80))))).toThrow(/expected at least 94/)
  })

  it('reads itemdata stat columns (ITEM_CH_SWORD_01_A / HP potion values)', () => {
    const c = Array.from({ length: 160 }, () => '0')
    Object.assign(c, { 0: '1', 1: '71', 2: 'ITEM_CH_SWORD_01_A', 9: '3', 10: '1', 11: '6', 12: '2', 32: '1', 33: '1', 34: '-1', 36: '-1', 38: '-1', 61: '1' })
    Object.assign(c, { 63: '62.0', 64: '76.0', 94: '6', 95: '15.0', 96: '16.0', 97: '16.0', 98: '18.0', 99: '2.4000001', 113: '24.0', 114: '30.0', 116: '3.0', 117: '15.0' })
    for (let i = 118; i < 158; i += 2) Object.assign(c, { [i]: '-1', [i + 1]: 'xxx' })
    const s = itemStatColumns(itemDataRow(row(c)))
    expect(s).toMatchObject({ durability: [62, 76], physAttackMin: [15, 16], physAttackMax: [16, 18], hitRate: [24, 30], critRate: [3, 15], range: 6 })
    expect(s.physAttackInc).toBeCloseTo(2.4, 5)
    expect(s.params[0]).toEqual({ value: -1 })
    Object.assign(c, { 118: '120', 119: 'HP', 120: '0', 121: 'HP%', 122: '0', 123: 'RESURRECT' })
    expect(itemStatColumns(itemDataRow(row(c))).params.slice(0, 3)).toEqual([{ value: 120, desc: 'HP' }, { value: 0, desc: 'HP%' }, { value: 0, desc: 'RESURRECT' }])
  })

  it('decodes skill parameter FourCCs without mistaking arguments for tags', () => {
    expect(fourCC(6386804)).toBe('att')
    expect(fourCC(28003)).toBe('mc')
    expect(fourCC(1685418593)).toBe('dura')
    expect(fourCC(1296122196)).toBeUndefined() // 'MAAT' (upper case): an argument
    expect(fourCC(100)).toBeUndefined() // one character
    expect(fourCC(30000)).toBe('u0')
    expect(skillParamTag(30000)).toBeUndefined() // 30000 ms is a value, not a tag
    expect(skillParamTag(28003)).toBe('mc')
    expect(parseSkillParams([1685418593, 30000, 6386804, 8, 100, 13, 19, 100, 26234, 30, 5, 1734702198, 1296122196, 0, 0])).toEqual([
      { tag: 'dura', args: [30000] },
      { tag: 'att', args: [8, 100, 13, 19, 100] },
      { tag: 'fz', args: [30, 5] },
      { tag: 'getv', args: [1296122196] },
    ])
    expect(parseSkillParams([5, 6386804, 1])).toEqual([{ tag: '', args: [5] }, { tag: 'att', args: [1] }])
    expect(parseSkillParams([0, 0])).toEqual([])
  })

  it('reads skilldata detail columns (SKILL_CH_SWORD_SMASH_A_01 values)', () => {
    const s = Array.from({ length: 118 }, () => '0')
    Object.assign(s, { 0: '1', 1: '3', 2: '174', 3: 'SKILL_CH_SWORD_SMASH_A_01', 5: 'SKILL_CH_SWORD_SMASH_A', 7: '1', 8: '2', 10: '99999999' })
    Object.assign(s, { 12: '411', 13: '1022', 14: '3000', 34: '257', 36: '5', 46: '2', 50: '2', 51: '3', 53: '19', 61: 'skill\\china\\sword_smash_a.ddj' })
    Object.assign(s, { 62: 'SN_SKILL_CH_SWORD_SMASH_A', 63: 'xxx', 64: 'SN_SKILL_CH_SWORD_SMASH_A_TT_DESC', 65: 'xxx', 69: '6386804', 70: '5', 71: '143', 72: '15', 73: '18', 74: '143' })
    const d = skillDetail(skillDataRow(row(s)))
    expect(d).toMatchObject({ activity: 2, chainId: 0, castingMs: 411, actionMs: 1022, reuseMs: 3000, masteries: [257, 0], masteryLevels: [5, 0], sp: 2, mpCost: 19, weapons: [2, 3], category: 0 })
    expect(d).toMatchObject({ icon: 'skill\\china\\sword_smash_a.ddj', nameStrId: 'SN_SKILL_CH_SWORD_SMASH_A' })
    expect(d.params).toEqual([{ tag: 'att', args: [5, 143, 15, 18, 143] }])
    s[50] = '255'
    s[51] = '255'
    expect(skillDetail(skillDataRow(row(s))).weapons).toEqual([])
  })

  it('reads npcpos and levelgold rows', () => {
    expect(npcPosRow(row(['2034', '25001', '1387.17', '-0.07', '1765.02']))).toEqual({ refId: 2034, region: 25001, x: 1387.17, y: -0.07, z: 1765.02 })
    expect(levelGoldRow(row(['1', '28', '59']))).toEqual({ level: 1, min: 28, max: 59 })
    expect(() => npcPosRow(row(['1', '2']))).toThrow(/npcpos row has 2 cells/)
  })

  it('builds string maps: Service 1 wins, then the first row', () => {
    const line = (service: string, key: string, en: string) => row([service, key, '한', '', 'zh-t', 'zh-s', 'de', 'ja', en, 'vi', 'pt', 'ru', 'tr', 'es', 'ar'])
    expect(textStringRow(line('1', 'SN_A', 'A')).text).toMatchObject({ korean: '한', english: 'A', arabic: 'ar' })
    const map = buildStringMap([line('0', 'SN_A', 'old'), line('1', 'SN_A', 'new'), line('1', 'SN_A', 'dup'), line('0', 'SN_B', 'b'), row(['1', 'SN_C', '씨'])])
    expect(Object.fromEntries(map)).toEqual({ SN_A: 'new', SN_B: 'b', SN_C: '' })
    expect(buildStringMap([row(['1', 'SN_C', '씨'])], 'korean').get('SN_C')).toBe('씨')
  })
})
