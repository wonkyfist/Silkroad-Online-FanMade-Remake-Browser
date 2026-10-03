/**
 * Object index text files in Map.pk2 (JMXVOBJI1000): object.ifo, objectstring.ifo and objext.ifo.
 *
 * Specs: SilkroadDoc wiki JMXVOBJI; openroad docs/formats/obji-jmxvobji.md (read as documentation
 * only). Checked against the vSRO 1.188 files (packages/convert/test/objects.corpus.test.ts).
 *
 * All three are CP949 text, one record per line (LF; CRLF is accepted):
 *   line 1   "JMXVOBJI1000"
 *   line 2   record count (decimal)
 *   records  whitespace-separated columns; "quoted" columns may contain spaces (object.ifo has
 *            paths such as "chinasystem_boatman 2.bsr").
 *
 *   object.ifo        index (zero-padded decimal), flags (0x%08X), "path"
 *                     index is the ObjID stored in .o/.o2 placements; path is a .bsr or .cpd in
 *                     Data.pk2. flags is 0 or 1 (openroad: collision-related, not decoded).
 *   objectstring.ifo  uniqueId (0x%08X: region id << 16 | placement UID), flags (0x%08X),
 *                     region x, region z (decimal), x, y, z, yaw (0x%08X, the f32 bit patterns of a
 *                     region-local position and a yaw in radians, like a .o placement), "name"
 *                     e.g. POS_STRUCTURE_GOD_BIG_GATE_TOGUI_1: the named placements (IsStruct = 1).
 *                     In vSRO 1.188 (189 entries): 92 name a .o placement (85 at its exact position,
 *                     7 fortress gates exactly one region width off in x), 2 (region 236,124) name
 *                     none, and 95 have region id 0xFFFF and a dungeon region (z = 128).
 *   objext.ifo        uniqueId (0x%08X), "unknown", "value" (e.g. "" "passent01")
 */
import { eucKr } from './binary.ts'

export const OBJI_SIGNATURE = 'JMXVOBJI1000'

export interface ObjectIfoEntry {
  /** ObjID, as referenced by .o/.o2 placements. */
  index: number
  /** Raw flags column (0 or 1 in vSRO 1.188). */
  flags: number
  /** Resource path as stored (backslashes, relative to Data.pk2): .bsr or .cpd. */
  path: string
}

export interface ObjectIfo {
  signature: string
  entries: ObjectIfoEntry[]
  /** ObjID -> entry. */
  byIndex: Map<number, ObjectIfoEntry>
}

export interface ObjectStringEntry {
  /** Raw first column: regionId << 16 | uid. */
  uniqueId: number
  /** uniqueId >>> 16; 0xFFFF for entries inside dungeons, whose regionZ is then 128. */
  regionId: number
  /** uniqueId & 0xFFFF: the UID of the placement in the region's .o/.o2. */
  uid: number
  flags: number
  /** Region coordinates as stored (the XSec/YSec columns). */
  regionX: number
  regionZ: number
  /** Region-local position, raw file space (f32 decoded from the hex bit pattern). */
  position: [x: number, y: number, z: number]
  /** Radians, same convention as MapObjectPlacement.yaw. */
  yaw: number
  name: string
}

export interface ObjectStringIfo {
  signature: string
  entries: ObjectStringEntry[]
}

export interface ObjectExtEntry {
  uniqueId: number
  regionId: number
  uid: number
  /** The first quoted column ("" in every entry of vSRO 1.188). */
  unknown: string
  value: string
}

export interface ObjectExtIfo {
  signature: string
  entries: ObjectExtEntry[]
}

interface Line {
  number: number
  tokens: string[]
}

function fail(message: string, line: number): never {
  throw new Error(`OBJI: ${message} at line ${line}`)
}

/** Whitespace-separated tokens; a token starting with '"' runs to the next '"' (quotes dropped). */
function tokenize(text: string, number: number): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === ' ' || c === '\t') {
      i++
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1)
      if (end === -1) fail('unterminated quoted string', number)
      tokens.push(text.slice(i + 1, end))
      i = end + 1
    } else {
      let end = i
      while (end < text.length && text[end] !== ' ' && text[end] !== '\t' && text[end] !== '"') end++
      tokens.push(text.slice(i, end))
      i = end
    }
  }
  return tokens
}

/** Signature and count lines checked; returns exactly `count` non-empty record lines. */
function records(input: Uint8Array | string): { signature: string; lines: Line[] } {
  const text = typeof input === 'string' ? input : eucKr.decode(input)
  const raw = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const signature = raw[0]?.trim() ?? ''
  if (signature !== OBJI_SIGNATURE) fail(`bad signature ${JSON.stringify(signature)}`, 1)
  const countText = raw[1]?.trim() ?? ''
  if (!/^\d+$/.test(countText)) fail(`bad record count ${JSON.stringify(countText)}`, 2)
  const count = Number(countText)
  const lines: Line[] = []
  for (let i = 2; i < raw.length; i++) {
    const t = raw[i]!.trim()
    if (t === '') continue
    if (lines.length === count) fail(`more than the declared ${count} records`, i + 1)
    lines.push({ number: i + 1, tokens: tokenize(t, i + 1) })
  }
  if (lines.length !== count) fail(`${lines.length} records but the header declares ${count}`, raw.length)
  return { signature, lines }
}

function int(token: string | undefined, line: number, what: string): number {
  if (token === undefined) fail(`missing ${what}`, line)
  if (/^0x[0-9a-f]+$/i.test(token)) return Number.parseInt(token.slice(2), 16)
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10)
  return fail(`bad ${what} ${JSON.stringify(token)}`, line)
}

function f32bits(token: string | undefined, line: number, what: string): number {
  const bits = int(token, line, what)
  const view = new DataView(new ArrayBuffer(4))
  view.setUint32(0, bits >>> 0)
  return view.getFloat32(0)
}

function columns(line: Line, n: number): string[] {
  if (line.tokens.length !== n) fail(`expected ${n} columns, found ${line.tokens.length}`, line.number)
  return line.tokens
}

/** Parse Map/object.ifo (bytes are decoded as CP949). */
export function parseObjectIfo(input: Uint8Array | string): ObjectIfo {
  const { signature, lines } = records(input)
  const entries: ObjectIfoEntry[] = []
  const byIndex = new Map<number, ObjectIfoEntry>()
  for (const line of lines) {
    const [index, flags, path] = columns(line, 3)
    const entry = { index: int(index, line.number, 'index'), flags: int(flags, line.number, 'flags'), path: path! }
    if (byIndex.has(entry.index)) fail(`duplicate index ${entry.index}`, line.number)
    entries.push(entry)
    byIndex.set(entry.index, entry)
  }
  return { signature, entries, byIndex }
}

/** Parse Map/objectstring.ifo, the named placements. */
export function parseObjectStringIfo(input: Uint8Array | string): ObjectStringIfo {
  const { signature, lines } = records(input)
  const entries = lines.map((line): ObjectStringEntry => {
    const c = columns(line, 9)
    const n = line.number
    const uniqueId = int(c[0], n, 'unique id')
    return {
      uniqueId,
      regionId: uniqueId >>> 16,
      uid: uniqueId & 0xffff,
      flags: int(c[1], n, 'flags'),
      regionX: int(c[2], n, 'region x'),
      regionZ: int(c[3], n, 'region z'),
      position: [f32bits(c[4], n, 'x'), f32bits(c[5], n, 'y'), f32bits(c[6], n, 'z')],
      yaw: f32bits(c[7], n, 'yaw'),
      name: c[8]!,
    }
  })
  return { signature, entries }
}

/** Parse Map/objext.ifo. */
export function parseObjectExtIfo(input: Uint8Array | string): ObjectExtIfo {
  const { signature, lines } = records(input)
  const entries = lines.map((line): ObjectExtEntry => {
    const c = columns(line, 3)
    const uniqueId = int(c[0], line.number, 'unique id')
    return { uniqueId, regionId: uniqueId >>> 16, uid: uniqueId & 0xffff, unknown: c[1]!, value: c[2]! }
  })
  return { signature, entries }
}
