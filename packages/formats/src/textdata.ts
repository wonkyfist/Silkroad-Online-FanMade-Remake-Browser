/**
 * Textdata tables: Media.pk2 server_dep/silkroad/textdata/*.txt, the client's copy of the server's Ref* tables
 * and its localized string tables.
 *
 * Layout (measured on vSRO 1.188, see packages/convert/test/textdata.corpus.test.ts):
 *   encoding  UTF-16LE with BOM (143 of 155 files); CP949 without BOM (dungeoninfo, effectenvsnd, effectsound,
 *             regioncode, regioninfo); UTF-8 (BOM, or valid UTF-8 without one) is accepted too.
 *             The seven SkillData_*ENC.txt files are Joymax-encrypted twins of SkillData_*.txt and do not decode.
 *   lines     CRLF (LF and CR tolerated). Whitespace-only lines are blank. A line whose first non-blank characters
 *             are '//' is a comment; the first tab-separated comment before any data row is the header
 *             (e.g. "//Service\tCodeName128\tKorean\t...").
 *   cells     tab-separated, kept verbatim (a few strings contain a vertical tab). 'xxx' is the null string.
 *   index     characterdata.txt, itemdata.txt, skilldata.txt, skilldataenc.txt, textdataname.txt, textquest.txt
 *             list other .txt files, one per line (e.g. CharacterData_5000.txt). The table is their rows in order.
 *             Listed names differ in case from the archive entries; PK2 lookups are case-insensitive.
 *
 * Column indices (0-based) follow the server tables' column order (_RefObjCommon, _RefObjChar, _RefObjItem,
 * _RefLevel, _RefSkill). Sources, read as documentation only (GPL): openroad docs/formats/
 * textdata-characterdata.md, textdata-itemdata.md, textdata-leveldata.md, textdata-skilldata.md; cross-checked
 * against known rows (CHAR_CH_MAN_ADVENTURER, ITEM_CH_SWORD_01_A_DEF, SKILL_PUNCH_01, level 1 = 118 exp).
 * Only columns the export uses or that were verified are named; every row keeps its raw `cells`.
 */

export type TextdataEncoding = 'utf-16le' | 'utf-8' | 'cp949'

export interface DecodedTextdata {
  encoding: TextdataEncoding
  /** Byte length of the BOM that was stripped (0, 2 or 3). */
  bomLength: number
  text: string
}

const utf16le = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true })
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const hex = (n: number) => '0x' + n.toString(16).padStart(2, '0')

function tryDecode(decoder: TextDecoder, bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

/** UTF-16LE without a BOM: ASCII-range text has a NUL in every odd byte and none in the even ones. */
function looksLikeUtf16le(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 64) & ~1
  if (n < 4) return false
  for (let i = 0; i < n; i += 2) if (bytes[i] === 0 || bytes[i + 1] !== 0) return false
  return true
}

// ---- CP949 ----------------------------------------------------------------------------------------
//
// Node's TextDecoder('euc-kr') is ICU's plain EUC-KR (KS X 1001 only): it turns the UHC-extension pairs of
// Windows code page 949 (lead 0x81-0xC6 with trail 0x41-0xA0) into C1 controls or U+FFFD, while browsers
// (WHATWG euc-kr = CP949) decode them. So CP949 is decoded here, identically in both environments:
//   - KS X 1001 (lead and trail 0xA1-0xFE): the platform decoder, which agrees everywhere for that range;
//   - UHC extension: the 8,822 Hangul syllables of U+AC00-U+D7A3 that are not among KS X 1001's 2,350, in code-point
//     order, at leads 0x81-0xA0 x 178 trails (0x41-0x5A, 0x61-0x7A, 0x81-0xFE), then leads 0xA1-0xC6 x 84 trails
//     (0x41-0x5A, 0x61-0x7A, 0x81-0xA0).
// Checked against iconv CP949 on every pair 0x81-0xFE x 0x41-0xFE: all 19,294 assigned pairs agree; the only
// difference is that the user-defined rows (leads 0xC9, 0xFE; Private Use in iconv) are rejected here.

const ksx1001 = new TextDecoder('euc-kr')
let ksTable: Uint16Array | undefined
let uhcTable: Uint16Array | undefined

/** KS X 1001 pair (lead, trail in 0xA1-0xFE) -> UTF-16 unit, 0 when unassigned. */
function ksTableGet(): Uint16Array {
  if (!ksTable) {
    ksTable = new Uint16Array(94 * 94)
    const pair = new Uint8Array(2)
    for (let l = 0; l < 94; l++) {
      for (let t = 0; t < 94; t++) {
        pair[0] = 0xa1 + l
        pair[1] = 0xa1 + t
        const s = ksx1001.decode(pair)
        if (s.length === 1 && s !== '�') ksTable[l * 94 + t] = s.charCodeAt(0)
      }
    }
    // KS X 1001:1998 additions that ICU's EUC-KR lacks (WHATWG and CP949 have them): A2E6 euro, A2E7 registered.
    ksTable[(0xa2 - 0xa1) * 94 + (0xe6 - 0xa1)] ||= 0x20ac
    ksTable[(0xa2 - 0xa1) * 94 + (0xe7 - 0xa1)] ||= 0xae
  }
  return ksTable
}

function uhcTableGet(): Uint16Array {
  if (!uhcTable) {
    const ks = ksTableGet()
    const inKs = new Set<number>()
    for (const c of ks) if (c >= 0xac00 && c <= 0xd7a3) inKs.add(c)
    if (inKs.size !== 2350) throw new Error(`CP949: platform euc-kr decoder yields ${inKs.size} KS X 1001 syllables, expected 2350`)
    uhcTable = new Uint16Array(11172 - 2350)
    let n = 0
    for (let c = 0xac00; c <= 0xd7a3; c++) if (!inKs.has(c)) uhcTable[n++] = c
  }
  return uhcTable
}

/** Index of a UHC trail byte among 0x41-0x5A, 0x61-0x7A, 0x81-0xFE; -1 if not a trail. */
function uhcTrailIndex(t: number): number {
  if (t >= 0x41 && t <= 0x5a) return t - 0x41
  if (t >= 0x61 && t <= 0x7a) return t - 0x61 + 26
  if (t >= 0x81 && t <= 0xfe) return t - 0x81 + 52
  return -1
}

/** One CP949 pair -> UTF-16 unit, or 0 if the pair is not assigned. */
function cp949Pair(lead: number, trail: number): number {
  // Leads 0xC9 and 0xFE are the user-defined rows (Private Use in Windows, unmapped in WHATWG).
  if (lead === 0xc9 || lead === 0xfe) return 0
  if (lead >= 0xa1 && lead <= 0xfe && trail >= 0xa1 && trail <= 0xfe) return ksTableGet()[(lead - 0xa1) * 94 + (trail - 0xa1)]!
  const t = uhcTrailIndex(trail)
  if (t < 0) return 0
  let index = -1
  if (lead >= 0x81 && lead <= 0xa0) index = (lead - 0x81) * 178 + t
  else if (lead >= 0xa1 && lead <= 0xc6 && t < 84) index = 32 * 178 + (lead - 0xa1) * 84 + t
  const table = uhcTableGet()
  return index >= 0 && index < table.length ? table[index]! : 0
}

/** Result of `decodeCp949`: the text, or the offset of the first byte that is not CP949. */
export type Cp949Result = { ok: true; text: string } | { ok: false; offset: number }

/** Strict Windows-949 decoder (ASCII + KS X 1001 + UHC extension). User-defined areas are rejected. */
export function decodeCp949(bytes: Uint8Array): Cp949Result {
  const units = new Uint16Array(bytes.length)
  let n = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    if (b < 0x80) {
      units[n++] = b
      continue
    }
    if (i + 1 >= bytes.length) return { ok: false, offset: i }
    const c = cp949Pair(b, bytes[i + 1]!)
    if (c === 0) return { ok: false, offset: i }
    units[n++] = c
    i++
  }
  let text = ''
  for (let i = 0; i < n; i += 8192) text += String.fromCharCode(...units.subarray(i, Math.min(n, i + 8192)))
  return { ok: true, text }
}

/**
 * Detects the encoding (BOM, then BOM-less UTF-16LE, then strict UTF-8, then strict CP949) and decodes.
 * Throws with the offending offset when the bytes are none of these (e.g. the encrypted SkillData_*ENC.txt).
 */
export function decodeTextdata(bytes: Uint8Array): DecodedTextdata {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    throw new Error('textdata: UTF-16BE (BOM FE FF at offset 0) is not supported')
  }
  const utf16Bom = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
  if (utf16Bom || looksLikeUtf16le(bytes)) {
    const bomLength = utf16Bom ? 2 : 0
    if ((bytes.length - bomLength) % 2 !== 0) {
      throw new Error(`textdata: UTF-16LE with an odd byte count (${bytes.length}); last byte at offset ${bytes.length - 1}`)
    }
    const text = tryDecode(utf16le, bytes.subarray(bomLength))
    if (text === undefined) throw new Error(`textdata: invalid UTF-16LE (unpaired surrogate) after offset ${bomLength}`)
    return { encoding: 'utf-16le', bomLength, text }
  }
  const bomLength = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const body = bytes.subarray(bomLength)
  const nul = body.indexOf(0)
  if (nul >= 0) throw new Error(`textdata: NUL byte at offset ${bomLength + nul}; not an 8-bit text table`)
  const asUtf8 = tryDecode(utf8, body)
  if (asUtf8 !== undefined) return { encoding: 'utf-8', bomLength, text: asUtf8 }
  if (bomLength) throw new Error('textdata: UTF-8 BOM but the body is not valid UTF-8')
  const asCp949 = decodeCp949(body)
  if (asCp949.ok) return { encoding: 'cp949', bomLength: 0, text: asCp949.text }
  const at = asCp949.offset
  throw new Error(`textdata: byte ${hex(body[at]!)} at offset ${at} is neither UTF-8 nor CP949 (encrypted or binary file?)`)
}

// ---- tables ---------------------------------------------------------------------------------------

export interface TextdataRow {
  /** File the row came from (as named by the caller or by the index file). */
  file: string
  /** 1-based line number in that file. */
  line: number
  cells: string[]
}

export interface TextdataComment {
  line: number
  /** The line without its leading blanks and '//'. */
  text: string
}

export interface TextdataFile {
  file: string
  encoding: TextdataEncoding
  rows: TextdataRow[]
  comments: TextdataComment[]
  /** Column names from the first tab-separated comment line that precedes every data row. */
  header?: string[]
  /** Set when every data row is a single `<name>.txt` cell: the files this index lists, in order. */
  index?: string[]
  /** Number of whitespace-only lines skipped. */
  blankLines: number
}

const INDEX_ENTRY = /^[^\t\\/:*?"<>|]+\.txt$/i

/** Parses one textdata file (bytes are decoded with `decodeTextdata`; a string is taken as already decoded). */
export function parseTextdata(input: Uint8Array | string, file = ''): TextdataFile {
  let encoding: TextdataEncoding = 'utf-8'
  let text: string
  if (typeof input === 'string') {
    text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  } else {
    const decoded = decodeTextdata(input)
    encoding = decoded.encoding
    text = decoded.text
  }
  const rows: TextdataRow[] = []
  const comments: TextdataComment[] = []
  let header: string[] | undefined
  let blankLines = 0
  const lines = text.split(/\r\n|\n|\r/)
  // A final newline leaves one empty string that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const start = raw.trimStart()
    // worldmap_localinfo.txt indents two of its comments with a tab.
    if (start.startsWith('//')) {
      const body = start.slice(2)
      comments.push({ line: i + 1, text: body })
      if (!header && rows.length === 0 && body.includes('\t')) header = body.split('\t')
      continue
    }
    if (raw.trim() === '') {
      blankLines++
      continue
    }
    rows.push({ file, line: i + 1, cells: raw.split('\t') })
  }
  const out: TextdataFile = { file, encoding, rows, comments, blankLines }
  if (header) out.header = header
  if (rows.length > 0 && rows.every(r => r.cells.length === 1 && INDEX_ENTRY.test(r.cells[0]!.trim()))) {
    out.index = rows.map(r => r.cells[0]!.trim())
  }
  return out
}

/** Reads one file by the name used in the textdata folder (case-insensitive); undefined when missing. */
export type TextdataReader = (name: string) => Uint8Array | undefined

export interface TextdataTable {
  name: string
  /** Every file read, the index (if any) first. */
  files: TextdataFile[]
  /** Data rows of the table: an index's listed files concatenated in order, or the file's own rows. */
  rows: TextdataRow[]
  header?: string[]
}

/** Loads a table by file name, expanding index files (nested indexes too; cycles throw). */
export function loadTextdataTable(name: string, read: TextdataReader): TextdataTable {
  const files: TextdataFile[] = []
  const rows: TextdataRow[] = []
  let header: string[] | undefined
  const visit = (fileName: string, stack: string[]) => {
    const key = fileName.toLowerCase()
    if (stack.includes(key)) throw new Error(`textdata: index cycle ${[...stack, key].join(' -> ')}`)
    const bytes = read(fileName)
    if (!bytes) {
      const via = stack.length ? ` (listed by ${stack[stack.length - 1]})` : ''
      throw new Error(`textdata: ${fileName} not found${via}`)
    }
    let parsed: TextdataFile
    try {
      parsed = parseTextdata(bytes, fileName)
    } catch (e) {
      throw new Error(`${fileName}: ${(e as Error).message}`)
    }
    files.push(parsed)
    if (parsed.index) {
      for (const child of parsed.index) visit(child, [...stack, key])
      return
    }
    header ??= parsed.header
    for (const row of parsed.rows) rows.push(row)
  }
  visit(name, [])
  const table: TextdataTable = { name, files, rows }
  if (header) table.header = header
  return table
}

// ---- cell access ----------------------------------------------------------------------------------

/** The null string of textdata tables. */
export const TEXTDATA_NULL = 'xxx'

function where(row: TextdataRow, col: number, label: string): string {
  return `${row.file || 'textdata'}:${row.line} column ${col} (${label})`
}

export function textdataCell(row: TextdataRow, col: number, label = '?'): string {
  const v = row.cells[col]
  if (v === undefined) throw new Error(`${where(row, col, label)}: row has only ${row.cells.length} cells`)
  return v
}

/** A string cell with 'xxx' (and empty) mapped to undefined. */
export function textdataOptCell(row: TextdataRow, col: number, label = '?'): string | undefined {
  const v = textdataCell(row, col, label).trim()
  return v === '' || v === TEXTDATA_NULL ? undefined : v
}

export function textdataInt(row: TextdataRow, col: number, label = '?'): number {
  const v = textdataCell(row, col, label).trim()
  if (!/^-?\d+$/.test(v)) throw new Error(`${where(row, col, label)}: not an integer: ${JSON.stringify(v)}`)
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error(`${where(row, col, label)}: integer out of range: ${v}`)
  return n
}

export function textdataNum(row: TextdataRow, col: number, label = '?'): number {
  const v = textdataCell(row, col, label).trim()
  const n = Number(v)
  if (v === '' || !Number.isFinite(n)) throw new Error(`${where(row, col, label)}: not a number: ${JSON.stringify(v)}`)
  return n
}

function expectCells(row: TextdataRow, min: number, table: string): void {
  if (row.cells.length < min) {
    throw new Error(`${row.file || table}:${row.line}: ${table} row has ${row.cells.length} cells, expected at least ${min}`)
  }
}

// ---- typed rows -----------------------------------------------------------------------------------

/** Country (_RefObjCommon.Country, col 14): 0 Chinese, 1 European (3 = neutral/other). */
export const COUNTRY_CHINA = 0
export const COUNTRY_EUROPE = 1

/** Columns 0-56, shared by characterdata and itemdata (_RefObjCommon column order). */
export interface RefObjCommon {
  service: boolean
  id: number
  /** CodeName128, the stable content id, e.g. CHAR_CH_MAN_ADVENTURER. */
  codeName: string
  /** ObjName128: designer name (Korean, often '?' after a lossy export). */
  objName?: string
  orgObjCodeName?: string
  /** NameStrID128: key into the text string tables (e.g. SN_ITEM_CH_SWORD_01_A). */
  nameStrId?: string
  descStrId?: string
  cashItem: number
  bionic: number
  /** TypeID1-4. Player characters are 1/1/0/0, monsters 1/2/1/x, NPCs 1/2/2/x, equipment 3/1/x/x. */
  typeId: [number, number, number, number]
  decayTime: number
  country: number
  rarity: number
  price: number
  sellPrice: number
  /** ReqLevelType1-4 / ReqLevel1-4 (cols 32-39); type -1 = unused. */
  reqLevels: Array<{ type: number; level: number }>
  /** Speed1/Speed2 (cols 46, 47): walk and run speed; 16/50 for player characters. */
  walkSpeed: number
  runSpeed: number
  /** Scale in percent (col 48). */
  scale: number
  /** AssocFileObj128 (col 52): model resource relative to Data.pk2 res/ (.bsr or .cpd), backslashes as stored. */
  assocFileObj?: string
  /** AssocFileDrop128 (col 53). */
  assocFileDrop?: string
  /** AssocFileIcon128 (col 54), relative to Media.pk2 icon/. */
  assocFileIcon?: string
  cells: string[]
}

function refObjCommon(row: TextdataRow, table: string, minCells: number): RefObjCommon {
  expectCells(row, minCells, table)
  const reqLevels: Array<{ type: number; level: number }> = []
  for (let i = 0; i < 4; i++) reqLevels.push({ type: textdataInt(row, 32 + 2 * i, 'ReqLevelType'), level: textdataInt(row, 33 + 2 * i, 'ReqLevel') })
  const out: RefObjCommon = {
    service: textdataInt(row, 0, 'Service') !== 0,
    id: textdataInt(row, 1, 'ID'),
    codeName: textdataCell(row, 2, 'CodeName128').trim(),
    cashItem: textdataInt(row, 7, 'CashItem'),
    bionic: textdataInt(row, 8, 'Bionic'),
    typeId: [textdataInt(row, 9, 'TypeID1'), textdataInt(row, 10, 'TypeID2'), textdataInt(row, 11, 'TypeID3'), textdataInt(row, 12, 'TypeID4')],
    decayTime: textdataInt(row, 13, 'DecayTime'),
    country: textdataInt(row, 14, 'Country'),
    rarity: textdataInt(row, 15, 'Rarity'),
    price: textdataInt(row, 26, 'Price'),
    sellPrice: textdataInt(row, 31, 'SellPrice'),
    reqLevels,
    walkSpeed: textdataNum(row, 46, 'Speed1'),
    runSpeed: textdataNum(row, 47, 'Speed2'),
    scale: textdataInt(row, 48, 'Scale'),
    cells: row.cells,
  }
  if (!out.codeName) throw new Error(`${where(row, 2, 'CodeName128')}: empty`)
  const opt = (col: number, label: string) => textdataOptCell(row, col, label)
  const set = <K extends keyof RefObjCommon>(key: K, v: RefObjCommon[K] | undefined) => {
    if (v !== undefined) out[key] = v
  }
  set('objName', opt(3, 'ObjName128'))
  set('orgObjCodeName', opt(4, 'OrgObjCodeName128'))
  set('nameStrId', opt(5, 'NameStrID128'))
  set('descStrId', opt(6, 'DescStrID128'))
  set('assocFileObj', opt(52, 'AssocFileObj128'))
  set('assocFileDrop', opt(53, 'AssocFileDrop128'))
  set('assocFileIcon', opt(54, 'AssocFileIcon128'))
  return out
}

/** CharGender (characterdata col 58). */
export const GENDER_FEMALE = 0
export const GENDER_MALE = 1
export const GENDER_NEUTRAL = 2

/** characterdata_*.txt: 104 columns in vSRO 1.188 (_RefObjCommon 0-56, then _RefObjChar). */
export interface CharacterDataRow extends RefObjCommon {
  /** Lvl (col 57): 1 for player characters, 0 for NPCs. */
  level: number
  /** CharGender (col 58): 0 female, 1 male, 2 neutral (monsters). */
  gender: number
  /** MaxHP (col 59); 0 for NPCs and player characters. */
  maxHp: number
  /** MaxMP (col 60). */
  maxMp: number
}

export const CHARACTERDATA_MIN_CELLS = 61

export function characterDataRow(row: TextdataRow): CharacterDataRow {
  const common = refObjCommon(row, 'characterdata', CHARACTERDATA_MIN_CELLS)
  return {
    ...common,
    level: textdataInt(row, 57, 'Lvl'),
    gender: textdataInt(row, 58, 'CharGender'),
    maxHp: textdataInt(row, 59, 'MaxHP'),
    maxMp: textdataInt(row, 60, 'MaxMP'),
  }
}

/** Player characters: TypeID 1/1/x/x (openroad textdata-characterdata). */
export function isPlayerCharacter(row: RefObjCommon): boolean {
  return row.typeId[0] === 1 && row.typeId[1] === 1
}

/** TypeID4 of Chinese weapons (TypeID 3/1/6/x; openroad textdata-itemdata, verified on ITEM_CH_*_01_A). */
export const CH_WEAPON_TID4 = { sword: 2, blade: 3, spear: 4, glaive: 5, bow: 6 } as const

/** itemdata_*.txt: 160 columns in vSRO 1.188 (_RefObjCommon 0-56, then _RefObjItem). */
export interface ItemDataRow extends RefObjCommon {
  /** MaxStack (col 57). */
  maxStack: number
  /** ReqGender (col 58): 0 female, 1 male, 2 either. */
  reqGender: number
  /** ItemClass (col 61): 1-3 = degree 1, 4-6 = degree 2, ... */
  itemClass: number
  /** ceil(ItemClass / 3); 0 when the item has no class. */
  degree: number
  /** TwoHanded (col 93), meaningful for weapons. */
  twoHanded: boolean
  /** Range (col 94): weapon reach in world units (dm) beyond the body radius; 6 sword, 18 spear, 180 bow. */
  range: number
}

export const ITEMDATA_MIN_CELLS = 95

export function itemDataRow(row: TextdataRow): ItemDataRow {
  const common = refObjCommon(row, 'itemdata', ITEMDATA_MIN_CELLS)
  const itemClass = textdataInt(row, 61, 'ItemClass')
  return {
    ...common,
    maxStack: textdataInt(row, 57, 'MaxStack'),
    reqGender: textdataInt(row, 58, 'ReqGender'),
    itemClass,
    degree: itemClass > 0 ? Math.ceil(itemClass / 3) : 0,
    twoHanded: textdataInt(row, 93, 'TwoHanded') !== 0,
    range: textdataInt(row, 94, 'Range'),
  }
}

/** leveldata.txt: 9 columns, one row per level (1-140). */
export interface LevelDataRow {
  level: number
  /** Col 1: character EXP needed to go from this level to the next (not cumulative). */
  exp: number
  /** Col 2: SP needed to raise a weapon mastery to this level (openroad textdata-leveldata). */
  masterySp: number
  /** Cols 3-5: unknown (3 and 4 are always 0; 5 grows by about 23.5 per level). */
  unknown: [number, number, number]
  /** Cols 6-8: job EXP thresholds (trader, thief, hunter); -1 or INT32_MAX past job level 7. */
  jobExp: [number, number, number]
}

export function levelDataRow(row: TextdataRow): LevelDataRow {
  expectCells(row, 9, 'leveldata')
  return {
    level: textdataInt(row, 0, 'Lvl'),
    exp: textdataInt(row, 1, 'Exp_C'),
    masterySp: textdataInt(row, 2, 'Exp_M'),
    unknown: [textdataInt(row, 3, 'unknown3'), textdataInt(row, 4, 'unknown4'), textdataInt(row, 5, 'unknown5')],
    jobExp: [textdataInt(row, 6, 'JobExp1'), textdataInt(row, 7, 'JobExp2'), textdataInt(row, 8, 'JobExp3')],
  }
}

/** skilldata_*.txt (plaintext ones): 118 columns in vSRO 1.188. Only the identity columns are typed. */
export interface SkillDataRow {
  service: boolean
  id: number
  groupId: number
  /** Basic_Code, e.g. SKILL_CH_SWORD_BASE_01. */
  code: string
  /** Basic_Name: designer name (Korean). */
  name: string
  /** Basic_Group, e.g. SKILL_CH_SWORD_BASE. */
  group: string
  original: number
  level: number
  cells: string[]
}

export const SKILLDATA_MIN_CELLS = 69

export function skillDataRow(row: TextdataRow): SkillDataRow {
  expectCells(row, SKILLDATA_MIN_CELLS, 'skilldata')
  return {
    service: textdataInt(row, 0, 'Service') !== 0,
    id: textdataInt(row, 1, 'ID'),
    groupId: textdataInt(row, 2, 'GroupID'),
    code: textdataCell(row, 3, 'Basic_Code').trim(),
    name: textdataCell(row, 4, 'Basic_Name'),
    group: textdataCell(row, 5, 'Basic_Group').trim(),
    original: textdataInt(row, 6, 'Basic_Original'),
    level: textdataInt(row, 7, 'Basic_Level'),
    cells: row.cells,
  }
}

// ---- extended columns (game data export) ----------------------------------------------------------
//
// Column meanings below were checked against known rows (vSRO 1.188) before use:
//   characterdata MOB_CH_MANGNYANG: 49 BCHeight 0, 50 BCRadius 6, 71 PD 7, 72 MD 10, 73 PAR 1, 74 MAR 1, 75 ER 27,
//     76 BR 0, 77 HR 27, 78 CHR 2, 79 ExpToGive 24, 83-84 DefaultSkill 160/161 (MSKILL_CH_MANGNYANG_ATTACK01/02);
//     *_CLON rows (e.g. MOB_CH_BIGEYEGHOST_CLON) have no AssocFileObj, OrgObjCodeName128 (col 4) = the base code
//     and col 93 = 1 (so col 93 is not an "aggressive" flag).
//   itemdata ITEM_CH_SWORD_01_A: 63/64 durability 62-76, 95-98 phys attack min 15-16 / max 16-18, 99 +2.4 per plus,
//     100-104 mag attack, 105-112 attack reinforce (x0.1 %), 113/114 HR 24-30, 116/117 critical 3-15;
//     ITEM_CH_M_HEAVY_01_BA_A: 65-67 PD 2.5-3.0 +0.4, 68/69 parry 5-7, 76-78 MD 3.2-3.9 +0.5, 82-85 reinforce;
//     ITEM_CH_SHIELD_01_A: 74/75 block 10-20; ITEM_CH_RING_01_A: 71-73 / 79-81 absorption 0.2-0.3 +0.23;
//     ITEM_ETC_HP_POTION_01: Param1 (118) = 120 HP, Param2 (120) HP %, Param3 (122) MP, Param4 (124) MP %.
//   skilldata SKILL_CH_SWORD_SMASH_A_01: 9 chain -> next skill ID, 12 casting 411, 13 action 1022, 14 reuse 3000,
//     34 mastery 257, 36 mastery level 5, 46 SP 2, 53 MP 19, 50/51 weapons 2/3, 61 icon, 62 name, 68 category,
//     69.. FourCC params ('att' 5 143 15 18 143).

/** characterdata columns 49-50 and 61-93 (_RefObjCommon BC* and _RefObjChar after MaxMP). */
export interface CharacterStats {
  /** BCHeight / BCRadius (cols 49, 50): collision cylinder, units (dm). */
  bcHeight: number
  bcRadius: number
  /** Col 40 (unnamed; tracks the level on monster rows). Kept for audit. */
  col40: number
  /** PD, MD (cols 71, 72). */
  physDefence: number
  magDefence: number
  /** PAR, MAR (cols 73, 74): absorption. */
  physAbsorb: number
  magAbsorb: number
  /** ER (col 75): parry rate; BR (76) block; HR (77) hit rate; CHR (78) critical. */
  parryRate: number
  blockRate: number
  hitRate: number
  critRate: number
  /** ExpToGive (col 79). */
  exp: number
  /** Col 80: packed resist bytes (e.g. 0x14141414), raw. */
  resistRaw: number
  /** Cols 81, 82: knockdown class and recovery ms (3 / 3000 on field monsters), raw. */
  koClass: number
  koRecoverMs: number
  /** DefaultSkill_1-10 (cols 83-92), skilldata IDs; zeros dropped. */
  defaultSkills: number[]
  /** Col 93: 1 on *_CLON rows (model borrowed from the base code in OrgObjCodeName128). */
  cloneFlag: number
}

export const CHARACTER_STATS_MIN_CELLS = 94

export function characterStats(row: CharacterDataRow): CharacterStats {
  const r: TextdataRow = { file: '', line: 0, cells: row.cells }
  if (row.cells.length < CHARACTER_STATS_MIN_CELLS) {
    throw new Error(`characterdata ${row.codeName}: ${row.cells.length} cells, expected at least ${CHARACTER_STATS_MIN_CELLS}`)
  }
  const n = (col: number, label: string) => textdataNum(r, col, `${row.codeName} ${label}`)
  const defaultSkills: number[] = []
  for (let c = 83; c <= 92; c++) {
    const id = textdataInt(r, c, `${row.codeName} DefaultSkill_${c - 82}`)
    if (id !== 0) defaultSkills.push(id)
  }
  return {
    bcHeight: n(49, 'BCHeight'),
    bcRadius: n(50, 'BCRadius'),
    col40: n(40, 'col40'),
    physDefence: n(71, 'PD'),
    magDefence: n(72, 'MD'),
    physAbsorb: n(73, 'PAR'),
    magAbsorb: n(74, 'MAR'),
    parryRate: n(75, 'ER'),
    blockRate: n(76, 'BR'),
    hitRate: n(77, 'HR'),
    critRate: n(78, 'CHR'),
    exp: n(79, 'ExpToGive'),
    resistRaw: n(80, 'Resist'),
    koClass: n(81, 'KO class'),
    koRecoverMs: n(82, 'KO recover'),
    defaultSkills,
    cloneFlag: n(93, 'col93'),
  }
}

/** [lower, upper] of a rolled stat. */
export type StatRange = [number, number]

/** itemdata columns 59-125 (_RefObjItem after ItemClass), as stored. */
export interface ItemStatColumns {
  reqStr: number
  reqInt: number
  setId: number
  durability: StatRange
  physDefence: StatRange
  physDefenceInc: number
  parryRate: StatRange
  parryRateInc: number
  physAbsorb: StatRange
  physAbsorbInc: number
  blockRate: StatRange
  magDefence: StatRange
  magDefenceInc: number
  magAbsorb: StatRange
  magAbsorbInc: number
  /** Cols 82-85: defence reinforcement by STR / INT, in 0.1 % (51 = 5.1 %). */
  physDefenceReinforce: StatRange
  magDefenceReinforce: StatRange
  quivered: number
  ammoTid4: number[]
  speedClass: number
  twoHanded: number
  range: number
  /** Cols 95-98: the rolled minimum and maximum of the physical attack. */
  physAttackMin: StatRange
  physAttackMax: StatRange
  physAttackInc: number
  magAttackMin: StatRange
  magAttackMax: StatRange
  magAttackInc: number
  /** Cols 105-112: attack reinforcement in 0.1 % (306 = 30.6 %). */
  physAttackReinforceMin: StatRange
  physAttackReinforceMax: StatRange
  magAttackReinforceMin: StatRange
  magAttackReinforceMax: StatRange
  hitRate: StatRange
  hitRateInc: number
  critRate: StatRange
  /** Param1-N (cols 118, 120, ...) with their Desc string (119, 121, ...); -1/'xxx' pairs kept as stored. */
  params: Array<{ value: number; desc?: string }>
}

export const ITEM_STATS_MIN_CELLS = 126

export function itemStatColumns(row: ItemDataRow): ItemStatColumns {
  if (row.cells.length < ITEM_STATS_MIN_CELLS) {
    throw new Error(`itemdata ${row.codeName}: ${row.cells.length} cells, expected at least ${ITEM_STATS_MIN_CELLS}`)
  }
  const r: TextdataRow = { file: '', line: 0, cells: row.cells }
  const n = (col: number) => textdataNum(r, col, `${row.codeName} col ${col}`)
  const range = (lo: number): StatRange => [n(lo), n(lo + 1)]
  const params: Array<{ value: number; desc?: string }> = []
  for (let c = 118; c + 1 < row.cells.length && c <= 156; c += 2) {
    const v = row.cells[c]!.trim()
    if (!/^-?\d+$/.test(v)) break
    const desc = textdataOptCell(r, c + 1)
    params.push(desc === undefined ? { value: Number(v) } : { value: Number(v), desc })
  }
  return {
    reqStr: n(59),
    reqInt: n(60),
    setId: n(62),
    durability: range(63),
    physDefence: range(65),
    physDefenceInc: n(67),
    parryRate: range(68),
    parryRateInc: n(70),
    physAbsorb: range(71),
    physAbsorbInc: n(73),
    blockRate: range(74),
    magDefence: range(76),
    magDefenceInc: n(78),
    magAbsorb: range(79),
    magAbsorbInc: n(81),
    physDefenceReinforce: range(82),
    magDefenceReinforce: range(84),
    quivered: n(86),
    ammoTid4: [n(87), n(88), n(89), n(90), n(91)],
    speedClass: n(92),
    twoHanded: n(93),
    range: n(94),
    physAttackMin: range(95),
    physAttackMax: range(97),
    physAttackInc: n(99),
    magAttackMin: range(100),
    magAttackMax: range(102),
    magAttackInc: n(104),
    physAttackReinforceMin: range(105),
    physAttackReinforceMax: range(107),
    magAttackReinforceMin: range(109),
    magAttackReinforceMax: range(111),
    hitRate: range(113),
    hitRateInc: n(115),
    critRate: range(116),
    params,
  }
}

/** One FourCC-tagged record of skilldata's parameter block (col 69 on). */
export interface SkillParam {
  /**
   * Tag text, e.g. 'att', 'mc', 'dura' (packed big-endian ASCII in the cell: 'att' = 0x617474 = 6386804);
   * '' for values that precede the first tag.
   */
  tag: string
  args: number[]
}

/** Decodes a cell value as lower-case FourCC text ('att', 'mc', 'dura'); undefined if it is not 2-4 such chars. */
export function fourCC(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 0x6161 || value > 0x7a7a7a7a) return undefined
  let s = ''
  for (let shift = 24; shift >= 0; shift -= 8) {
    const c = (value >>> shift) & 0xff
    if (c === 0) {
      if (s.length) return undefined
      continue
    }
    s += String.fromCharCode(c)
  }
  return /^[a-z][a-z0-9]{1,3}$/.test(s) ? s : undefined
}

/**
 * Two-letter tags. Two-character FourCCs collide with ordinary argument values (30000 ms spells 'u0', 24886 'a6'),
 * so only these, seen at the first parameter position or as known effects in the corpus, count as tags.
 */
export const SKILL_SHORT_TAGS: ReadonlySet<string> = new Set([
  'mc', 'kb', 'ko', 'st', 'da', 'dn', 'es', 'fb', 'fz', 'bu', 'bl', 'sl', 'ps', 'ds', 'cr', 'hr', 'er', 'br', 'rt',
  'fe', 'my', 'ru', 'pw', 'zb', 'se', 'tb', 'ca', 'ck',
])

/** A decoded FourCC that starts a parameter record: 3-4 characters, or a known two-letter tag. */
export function skillParamTag(value: number): string | undefined {
  const s = fourCC(value)
  return s !== undefined && (s.length >= 3 || SKILL_SHORT_TAGS.has(s)) ? s : undefined
}

/**
 * Splits the parameter block into records. Tags are lower-case FourCCs (skillParamTag); every following value up to
 * the next tag is an argument (upper-case FourCC arguments such as getv's 'MAAT' stay arguments). Trailing zeros
 * end the block. No per-tag arity table is needed; the corpus test checks the records of the exported skills.
 */
export function parseSkillParams(values: readonly number[]): SkillParam[] {
  let end = values.length
  while (end > 0 && values[end - 1] === 0) end--
  const out: SkillParam[] = []
  for (let i = 0; i < end; i++) {
    const v = values[i]!
    const tag = skillParamTag(v)
    if (tag !== undefined) out.push({ tag, args: [] })
    else if (out.length) out[out.length - 1]!.args.push(v)
    else out.push({ tag: '', args: [v] }) // values before any tag: kept under the empty tag
  }
  return out
}

/** skilldata columns 8-68 plus the parameter block (plaintext skilldata_*.txt, 118 columns). */
export interface SkillDetail {
  /** Basic_Activity (col 8): 0 passive, 1 imbue, 2 action. */
  activity: number
  /** Basic_ChainCode (col 9): skilldata ID of the next chain segment; 0 = none. */
  chainId: number
  /** Cols 11-15 (ms): PreparingTime, CastingTime, ActionDuration, ReuseDelay, CoolTime (monster rows). */
  preparingMs: number
  castingMs: number
  actionMs: number
  reuseMs: number
  coolMs: number
  /** Col 16: 0 or 400; a has-projectile flag in practice. */
  flyingSpeed: number
  /** Col 21: reach in units (dm) beyond both body radii; 0 = the weapon's reach. */
  range: number
  /** ReqCommon_Mastery1/2 (cols 34, 35) and their levels (36, 37). */
  masteries: [number, number]
  masteryLevels: [number, number]
  /** ReqLearn_Skill1-3 (cols 40-42, skill group IDs) and levels (43-45). */
  reqSkills: Array<{ group: number; level: number }>
  /** ReqLearn_SP (col 46). */
  sp: number
  /** Col 47 (3 on shared basic attacks, 0 on race skills), raw. */
  race: number
  /** Required weapon TypeID4s (cols 50, 51); 255 = none. */
  weapons: number[]
  hpCost: number
  mpCost: number
  /** UI_IconFile (col 61), relative to Media icon/. */
  icon?: string
  /** UI_SkillName (col 62) and UI_SkillToolTip_Desc (col 64) string keys. */
  nameStrId?: string
  descStrId?: string
  /** Param1 (col 68): 0 melee, 1 ranged/projectile, 3 buff, 4 passive. */
  category: number
  params: SkillParam[]
}

export const SKILL_DETAIL_MIN_CELLS = 118

export function skillDetail(row: SkillDataRow): SkillDetail {
  if (row.cells.length < SKILL_DETAIL_MIN_CELLS) {
    throw new Error(`skilldata ${row.code}: ${row.cells.length} cells, expected at least ${SKILL_DETAIL_MIN_CELLS}`)
  }
  const r: TextdataRow = { file: '', line: 0, cells: row.cells }
  const n = (col: number, label: string) => textdataInt(r, col, `${row.code} ${label}`)
  const values: number[] = []
  for (let c = 69; c < SKILL_DETAIL_MIN_CELLS; c++) values.push(n(c, `Param${c - 67}`))
  const reqSkills: Array<{ group: number; level: number }> = []
  for (let i = 0; i < 3; i++) {
    const group = n(40 + i, `ReqLearn_Skill${i + 1}`)
    if (group !== 0) reqSkills.push({ group, level: n(43 + i, `ReqLearn_SkillLevel${i + 1}`) })
  }
  const out: SkillDetail = {
    activity: n(8, 'Basic_Activity'),
    chainId: n(9, 'Basic_ChainCode'),
    preparingMs: n(11, 'PreparingTime'),
    castingMs: n(12, 'CastingTime'),
    actionMs: n(13, 'ActionDuration'),
    reuseMs: n(14, 'ReuseDelay'),
    coolMs: n(15, 'CoolTime'),
    flyingSpeed: n(16, 'FlyingSpeed'),
    range: n(21, 'Range'),
    masteries: [n(34, 'ReqCommon_Mastery1'), n(35, 'ReqCommon_Mastery2')],
    masteryLevels: [n(36, 'ReqCommon_MasteryLevel1'), n(37, 'ReqCommon_MasteryLevel2')],
    reqSkills,
    sp: n(46, 'ReqLearn_SP'),
    race: n(47, 'ReqLearn_Race'),
    weapons: [n(50, 'ReqCast_Weapon1'), n(51, 'ReqCast_Weapon2')].filter(w => w !== 255 && w !== 0),
    hpCost: n(52, 'Consume_HP'),
    mpCost: n(53, 'Consume_MP'),
    category: n(68, 'Param1'),
    params: parseSkillParams(values),
  }
  const icon = textdataOptCell(r, 61, 'UI_IconFile')
  const nameStrId = textdataOptCell(r, 62, 'UI_SkillName')
  const descStrId = textdataOptCell(r, 64, 'UI_SkillToolTip_Desc')
  if (icon) out.icon = icon
  if (nameStrId) out.nameStrId = nameStrId
  if (descStrId) out.descStrId = descStrId
  return out
}

/** npcpos.txt: static NPC placements (the client's copy for the minimap). 5 columns, no header. */
export interface NpcPosRow {
  /** characterdata ID of the NPC. */
  refId: number
  /** Region id (z << 8 | x); negative ids are dungeons. */
  region: number
  /** Region-local position, units (dm), file space (x east, y up, z north). */
  x: number
  y: number
  z: number
}

export function npcPosRow(row: TextdataRow): NpcPosRow {
  expectCells(row, 5, 'npcpos')
  return {
    refId: textdataInt(row, 0, 'RefObjID'),
    region: textdataInt(row, 1, 'Region'),
    x: textdataNum(row, 2, 'X'),
    y: textdataNum(row, 3, 'Y'),
    z: textdataNum(row, 4, 'Z'),
  }
}

/** levelgold.txt: gold dropped by a monster of a level (the client copy of _RefDropGold). */
export interface LevelGoldRow {
  level: number
  min: number
  max: number
}

export function levelGoldRow(row: TextdataRow): LevelGoldRow {
  expectCells(row, 3, 'levelgold')
  return { level: textdataInt(row, 0, 'MonLevel'), min: textdataInt(row, 1, 'GoldMin'), max: textdataInt(row, 2, 'GoldMax') }
}

// ---- string tables --------------------------------------------------------------------------------

/**
 * Language columns of the string tables (textdata_object, textdata_equip&skill, textuisystem, textzonename, ...),
 * from their header "//Service CodeName128 Korean ? Chinese Traditional [?] Chinese Simplified Deutch [Taiwan]
 * Japan English Vietnam Portuguese [Thailand] Russia Turkey Spain Arabic". Column 3 is unnamed and empty.
 */
export const TEXT_LANGUAGE_COLUMNS = {
  korean: 2,
  chineseTraditional: 4,
  chineseSimplified: 5,
  german: 6,
  japanese: 7,
  english: 8,
  vietnamese: 9,
  portuguese: 10,
  russian: 11,
  turkish: 12,
  spanish: 13,
  arabic: 14,
} as const

export type TextLanguage = keyof typeof TEXT_LANGUAGE_COLUMNS

export interface TextStringRow {
  service: boolean
  key: string
  /** One entry per language column; '' when the row is shorter. */
  text: Record<TextLanguage, string>
}

export function textStringRow(row: TextdataRow): TextStringRow {
  expectCells(row, 3, 'text string')
  const text = {} as Record<TextLanguage, string>
  for (const [lang, col] of Object.entries(TEXT_LANGUAGE_COLUMNS) as Array<[TextLanguage, number]>) {
    text[lang] = row.cells[col] ?? ''
  }
  return { service: textdataInt(row, 0, 'Service') !== 0, key: textdataCell(row, 1, 'CodeName128').trim(), text }
}

/**
 * key -> text for one language. Rows with Service 1 win over Service 0; among equals the first row wins.
 * Joymax writes a line break inside a string as the two characters '\n'; they are kept as stored.
 */
export function buildStringMap(rows: Iterable<TextdataRow>, lang: TextLanguage = 'english'): Map<string, string> {
  const out = new Map<string, string>()
  const live = new Set<string>()
  for (const row of rows) {
    const s = textStringRow(row)
    if (live.has(s.key)) continue
    if (s.service) live.add(s.key)
    else if (out.has(s.key)) continue
    out.set(s.key, s.text[lang])
  }
  return out
}
