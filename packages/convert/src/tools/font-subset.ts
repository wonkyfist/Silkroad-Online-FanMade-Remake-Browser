/**
 * TrueType subsetter (OpenType spec, 'glyf'-flavoured sfnt; no dependency). Writes a small Latin font from a
 * big CJK one, so Chrome's font sanitiser (OTS) accepts it: the client's basic.ttf / chat.ttf (TaeUtum /
 * SeUtum, 13,588 glyphs) are rejected as they are (docs/UI.md §2.6, §4.3).
 *
 *   pnpm tsx packages/convert/src/tools/font-subset.ts <in.ttf> <out.ttf> [family]
 *
 * What it writes:
 * - the glyphs of LATIN_CODE_POINTS that the source maps, plus `.notdef` (glyph 0) and every component of a
 *   composite glyph, renumbered (0 = .notdef, then by code point, then components);
 * - no hinting: `fpgm`, `prep` and `cvt ` are dropped and every glyph's instructions are removed
 *   (simple glyphs: instructionLength = 0; composites: WE_HAVE_INSTRUCTIONS cleared);
 * - tables `OS/2` (copied; char index and Unicode/code-page ranges set), `cmap` (format 4, (3,1) and (0,3)),
 *   `glyf` (glyphs trimmed to their parsed length, 4-byte aligned), `head` (long `loca`, bbox recomputed),
 *   `hhea` + `hmtx` (one long metric per glyph), `loca`, `maxp` (v1.0, hinting limits zeroed), `name`
 *   (fresh English records), `post` (format 3);
 * - a table directory with correct searchRange / entrySelector / rangeShift, table checksums and
 *   head.checkSumAdjustment.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** U+0020–007E, U+00A0–00FF and common typographic punctuation (docs/UI.md §4.3). */
export const LATIN_CODE_POINTS: readonly number[] = [
  ...range(0x20, 0x7e),
  ...range(0xa0, 0xff),
  0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac,
]

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i)
}

export interface TableRecord {
  offset: number
  length: number
  checksum: number
}

export interface SubsetOptions {
  /** Code points to keep (default LATIN_CODE_POINTS). Ones the source does not map are skipped. */
  codePoints?: readonly number[]
  /** Family name for the `name` table when the source has no English family name. */
  family?: string
  /** Code point → the code point whose glyph it borrows when the source lacks it (default DEFAULT_ALIASES). */
  aliases?: Readonly<Record<number, number>>
}

/** No-break space borrows the space glyph (the client's Korean fonts have U+0020 but not U+00A0). */
export const DEFAULT_ALIASES: Readonly<Record<number, number>> = { 0xa0: 0x20 }

export interface SubsetResult {
  bytes: Uint8Array
  /** Glyphs in the subset, `.notdef` included. */
  glyphs: number
  /** The code points the subset maps. */
  mapped: number[]
  /** Kept code points the source does not map. */
  missing: number[]
}

// ---------------------------------------------------------------- reading

export function readTables(font: Uint8Array): Record<string, TableRecord> {
  const dv = view(font)
  const n = dv.getUint16(4)
  const tables: Record<string, TableRecord> = {}
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16
    const tag = String.fromCharCode(font[o]!, font[o + 1]!, font[o + 2]!, font[o + 3]!)
    tables[tag] = { checksum: dv.getUint32(o + 4), offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) }
  }
  return tables
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength)
}

function table(font: Uint8Array, tables: Record<string, TableRecord>, tag: string): Uint8Array {
  const t = tables[tag]
  if (!t) throw new Error(`font: no '${tag}' table`)
  if (t.offset + t.length > font.length) throw new Error(`font: '${tag}' table out of range`)
  return font.subarray(t.offset, t.offset + t.length)
}

/** Code point → glyph id, from the best Unicode subtable: (3,10)/(0,4+) format 12, else (3,1)/(0,*) format 4. */
export function readCmap(cmap: Uint8Array): Map<number, number> {
  const dv = view(cmap)
  const n = dv.getUint16(2)
  let best: { rank: number; off: number } | null = null
  for (let i = 0; i < n; i++) {
    const r = 4 + i * 8
    const pid = dv.getUint16(r)
    const eid = dv.getUint16(r + 2)
    const off = dv.getUint32(r + 4)
    if (off + 2 > cmap.length) continue
    const fmt = dv.getUint16(off)
    const unicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10))
    if (!unicode || (fmt !== 4 && fmt !== 12)) continue
    const rank = (fmt === 12 ? 2 : 0) + (pid === 3 ? 1 : 0)
    if (!best || rank > best.rank) best = { rank, off }
  }
  const map = new Map<number, number>()
  if (!best) return map
  const o = best.off
  if (dv.getUint16(o) === 12) {
    const groups = dv.getUint32(o + 12)
    for (let g = 0; g < groups; g++) {
      const r = o + 16 + g * 12
      const start = dv.getUint32(r)
      const end = dv.getUint32(r + 4)
      const gid = dv.getUint32(r + 8)
      for (let c = start; c <= end && c <= 0x10ffff; c++) map.set(c, gid + c - start)
    }
    return map
  }
  const segX2 = dv.getUint16(o + 6)
  const ends = o + 14
  const starts = ends + segX2 + 2
  const deltas = starts + segX2
  const rangeOffs = deltas + segX2
  for (let s = 0; s < segX2 / 2; s++) {
    const end = dv.getUint16(ends + s * 2)
    const start = dv.getUint16(starts + s * 2)
    const delta = dv.getInt16(deltas + s * 2)
    const ro = dv.getUint16(rangeOffs + s * 2)
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let gid: number
      if (ro === 0) gid = (c + delta) & 0xffff
      else {
        const at = rangeOffs + s * 2 + ro + (c - start) * 2
        if (at + 2 > cmap.length) continue
        gid = dv.getUint16(at)
        if (gid !== 0) gid = (gid + delta) & 0xffff
      }
      if (gid !== 0) map.set(c, gid)
    }
  }
  return map
}

const ARG_1_AND_2_ARE_WORDS = 0x0001
const WE_HAVE_A_SCALE = 0x0008
const MORE_COMPONENTS = 0x0020
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040
const WE_HAVE_A_TWO_BY_TWO = 0x0080
const WE_HAVE_INSTRUCTIONS = 0x0100

/** Component glyph ids of a composite glyph (empty for a simple or empty glyph). */
export function glyphComponents(glyph: Uint8Array): number[] {
  if (glyph.length < 10) return []
  const dv = view(glyph)
  if (dv.getInt16(0) >= 0) return []
  const out: number[] = []
  let p = 10
  for (;;) {
    const flags = dv.getUint16(p)
    out.push(dv.getUint16(p + 2))
    p += 4 + componentTail(flags)
    if (!(flags & MORE_COMPONENTS)) return out
  }
}

function componentTail(flags: number): number {
  let n = flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2
  if (flags & WE_HAVE_A_SCALE) n += 2
  else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) n += 4
  else if (flags & WE_HAVE_A_TWO_BY_TWO) n += 8
  return n
}

/**
 * The glyph without instructions, trimmed to its parsed length, component ids mapped through `remap`.
 * An empty source glyph stays empty.
 */
export function stripGlyph(glyph: Uint8Array, remap: (gid: number) => number): Uint8Array {
  if (glyph.length === 0) return glyph
  const dv = view(glyph)
  const contours = dv.getInt16(0)
  if (contours >= 0) {
    const endPts = 10 + contours * 2
    const insLen = dv.getUint16(endPts)
    const flagsAt = endPts + 2 + insLen
    const points = contours ? dv.getUint16(endPts - 2) + 1 : 0
    let p = flagsAt
    let xBytes = 0
    let yBytes = 0
    for (let i = 0; i < points; ) {
      const f = glyph[p++]!
      let repeat = 1
      if (f & 0x08) repeat += glyph[p++]!
      const xs = f & 0x02 ? 1 : f & 0x10 ? 0 : 2
      const ys = f & 0x04 ? 1 : f & 0x20 ? 0 : 2
      xBytes += xs * repeat
      yBytes += ys * repeat
      i += repeat
    }
    const end = p + xBytes + yBytes
    if (end > glyph.length) throw new Error('font: glyph data runs past its loca length')
    const out = new Uint8Array(endPts + 2 + (end - flagsAt))
    out.set(glyph.subarray(0, endPts), 0)
    // instructionLength stays 0
    out.set(glyph.subarray(flagsAt, end), endPts + 2)
    return out
  }
  const parts: Uint8Array[] = [glyph.subarray(0, 10)]
  let p = 10
  for (;;) {
    const flags = dv.getUint16(p)
    const len = 4 + componentTail(flags)
    const c = new Uint8Array(glyph.subarray(p, p + len))
    const cv = view(c)
    cv.setUint16(0, flags & ~WE_HAVE_INSTRUCTIONS)
    cv.setUint16(2, remap(dv.getUint16(p + 2)))
    parts.push(c)
    p += len
    if (!(flags & MORE_COMPONENTS)) break
  }
  return concat(parts)
}

// ---------------------------------------------------------------- writing

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const pad4 = (n: number): number => (n + 3) & ~3

/** Sum of the table as big-endian uint32s, zero-padded to a multiple of 4. */
export function tableChecksum(bytes: Uint8Array): number {
  let sum = 0
  const n = bytes.length
  for (let i = 0; i < n; i += 4) {
    const v = ((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)
    sum = (sum + (v >>> 0)) >>> 0
  }
  return sum
}

/** The sfnt directory's binary-search fields for `n` tables. */
export function directorySearch(n: number): { searchRange: number; entrySelector: number; rangeShift: number } {
  let entrySelector = 0
  while (1 << (entrySelector + 1) <= n) entrySelector++
  const searchRange = (1 << entrySelector) * 16
  return { searchRange, entrySelector, rangeShift: n * 16 - searchRange }
}

/**
 * A TrueType font from its tables: tags sorted, tables 4-byte aligned, checksums, and
 * head.checkSumAdjustment when there is a `head`.
 */
export function writeSfnt(tables: Record<string, Uint8Array>): Uint8Array {
  const tags = Object.keys(tables).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const n = tags.length
  const head = tables.head ? new Uint8Array(tables.head) : null
  if (head) view(head).setUint32(8, 0)
  let offset = 12 + n * 16
  const records = tags.map(tag => {
    const data = tag === 'head' && head ? head : tables[tag]!
    const r = { tag, data, offset, checksum: tableChecksum(data) }
    offset += pad4(data.length)
    return r
  })
  const out = new Uint8Array(offset)
  const dv = view(out)
  const { searchRange, entrySelector, rangeShift } = directorySearch(n)
  dv.setUint32(0, 0x00010000)
  dv.setUint16(4, n)
  dv.setUint16(6, searchRange)
  dv.setUint16(8, entrySelector)
  dv.setUint16(10, rangeShift)
  records.forEach((r, i) => {
    const o = 12 + i * 16
    for (let k = 0; k < 4; k++) out[o + k] = r.tag.charCodeAt(k)
    dv.setUint32(o + 4, r.checksum)
    dv.setUint32(o + 8, r.offset)
    dv.setUint32(o + 12, r.data.length)
    out.set(r.data, r.offset)
  })
  const headRec = records.find(r => r.tag === 'head')
  if (headRec) dv.setUint32(headRec.offset + 8, (0xb1b0afba - tableChecksum(out)) >>> 0)
  return out
}

/** A format-4 subtable for `map` (code point ≤ 0xFFFF → glyph id), runs of consecutive codes and glyphs. */
export function buildCmap4(map: Map<number, number>): Uint8Array {
  const codes = [...map.keys()].filter(c => c < 0xffff).sort((a, b) => a - b)
  const segs: { start: number; end: number; delta: number }[] = []
  for (const c of codes) {
    const g = map.get(c)!
    const last = segs[segs.length - 1]
    if (last && c === last.end + 1 && ((g - c) & 0xffff) === last.delta) last.end = c
    else segs.push({ start: c, end: c, delta: (g - c) & 0xffff })
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 })
  const segCount = segs.length
  const len = 16 + segCount * 8
  const out = new Uint8Array(len)
  const dv = view(out)
  const s = directorySearch(segCount)
  dv.setUint16(0, 4)
  dv.setUint16(2, len)
  dv.setUint16(4, 0)
  dv.setUint16(6, segCount * 2)
  dv.setUint16(8, (s.searchRange / 16) * 2)
  dv.setUint16(10, s.entrySelector)
  dv.setUint16(12, segCount * 2 - (s.searchRange / 16) * 2)
  segs.forEach((g, i) => {
    dv.setUint16(14 + i * 2, g.end)
    dv.setUint16(16 + segCount * 2 + i * 2, g.start)
    dv.setUint16(16 + segCount * 4 + i * 2, g.delta)
    dv.setUint16(16 + segCount * 6 + i * 2, 0)
  })
  return out
}

/** A `cmap` table with one format-4 subtable, listed for (0,3) and (3,1). */
export function buildCmap(map: Map<number, number>): Uint8Array {
  const sub = buildCmap4(map)
  const out = new Uint8Array(4 + 2 * 8 + sub.length)
  const dv = view(out)
  dv.setUint16(2, 2)
  dv.setUint16(4, 0)
  dv.setUint16(6, 3)
  dv.setUint32(8, 20)
  dv.setUint16(12, 3)
  dv.setUint16(14, 1)
  dv.setUint32(16, 20)
  out.set(sub, 20)
  return out
}

/** A format-0 `name` table of (3,1,0x409) UTF-16BE records. */
export function buildName(records: Record<number, string>): Uint8Array {
  const ids = Object.keys(records).map(Number).sort((a, b) => a - b)
  const strings = ids.map(id => {
    const s = records[id]!
    const b = new Uint8Array(s.length * 2)
    for (let i = 0; i < s.length; i++) {
      b[i * 2] = s.charCodeAt(i) >> 8
      b[i * 2 + 1] = s.charCodeAt(i) & 0xff
    }
    return b
  })
  const storage = 6 + ids.length * 12
  const out = new Uint8Array(storage + strings.reduce((n, s) => n + s.length, 0))
  const dv = view(out)
  dv.setUint16(2, ids.length)
  dv.setUint16(4, storage)
  let off = 0
  ids.forEach((id, i) => {
    const r = 6 + i * 12
    dv.setUint16(r, 3)
    dv.setUint16(r + 2, 1)
    dv.setUint16(r + 4, 0x409)
    dv.setUint16(r + 6, id)
    dv.setUint16(r + 8, strings[i]!.length)
    dv.setUint16(r + 10, off)
    out.set(strings[i]!, storage + off)
    off += strings[i]!.length
  })
  return out
}

/** English (3,1,0x409) or Mac Roman (1,0,0) name records of `name`, by id. */
export function readNames(name: Uint8Array): Record<number, string> {
  const dv = view(name)
  const count = dv.getUint16(2)
  const storage = dv.getUint16(4)
  const out: Record<number, string> = {}
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12
    if (r + 12 > name.length) break
    const pid = dv.getUint16(r)
    const eid = dv.getUint16(r + 2)
    const lang = dv.getUint16(r + 4)
    const id = dv.getUint16(r + 6)
    const len = dv.getUint16(r + 8)
    const at = storage + dv.getUint16(r + 10)
    if (at + len > name.length) continue
    let s = ''
    if (pid === 3 && eid === 1 && lang === 0x409) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(at + k))
    else if (pid === 1 && eid === 0 && lang === 0 && out[id] === undefined) for (let k = 0; k < len; k++) s += String.fromCharCode(name[at + k]!)
    else continue
    if (/^[\x20-\x7e\xa0-\xff]+$/.test(s)) out[id] = s
  }
  return out
}

// ---------------------------------------------------------------- subsetting

export function subsetFont(src: Uint8Array, opts: SubsetOptions = {}): SubsetResult {
  const tables = readTables(src)
  const head = table(src, tables, 'head')
  const maxp = table(src, tables, 'maxp')
  const hhea = table(src, tables, 'hhea')
  const hmtx = table(src, tables, 'hmtx')
  const loca = table(src, tables, 'loca')
  const glyf = table(src, tables, 'glyf')
  const numGlyphs = view(maxp).getUint16(4)
  const longLoca = view(head).getInt16(50) === 1
  const glyphAt = (gid: number): Uint8Array => {
    if (gid >= numGlyphs) throw new Error(`font: glyph ${gid} out of range`)
    const lv = view(loca)
    const a = longLoca ? lv.getUint32(gid * 4) : lv.getUint16(gid * 2) * 2
    const b = longLoca ? lv.getUint32(gid * 4 + 4) : lv.getUint16(gid * 2 + 2) * 2
    if (b < a || b > glyf.length) throw new Error(`font: bad loca for glyph ${gid}`)
    return glyf.subarray(a, b)
  }

  const cmap = readCmap(table(src, tables, 'cmap'))
  const wanted = opts.codePoints ?? LATIN_CODE_POINTS
  const order: number[] = [0]
  const newId = new Map<number, number>([[0, 0]])
  const add = (gid: number): void => {
    if (newId.has(gid)) return
    newId.set(gid, order.length)
    order.push(gid)
  }
  const mapped: number[] = []
  const missing: number[] = []
  const aliases = opts.aliases ?? DEFAULT_ALIASES
  for (const c of [...new Set(wanted)].sort((a, b) => a - b)) {
    const alias = aliases[c]
    const gid = cmap.get(c) ?? (alias === undefined ? undefined : cmap.get(alias))
    if (gid === undefined || gid === 0 || gid >= numGlyphs) {
      missing.push(c)
      continue
    }
    add(gid)
    mapped.push(c)
  }
  for (let i = 0; i < order.length; i++) for (const comp of glyphComponents(glyphAt(order[i]!))) add(comp)

  // glyf + loca + metrics
  const hv = view(hhea)
  const numHMetrics = hv.getUint16(34)
  const mv = view(hmtx)
  const metric = (gid: number): [number, number] => {
    const i = Math.min(gid, numHMetrics - 1)
    const aw = mv.getUint16(i * 4)
    const lsb = gid < numHMetrics ? mv.getInt16(gid * 4 + 2) : mv.getInt16(numHMetrics * 4 + (gid - numHMetrics) * 2)
    return [aw, lsb]
  }
  const glyphs: Uint8Array[] = []
  const newLoca = new Uint8Array((order.length + 1) * 4)
  const lv = view(newLoca)
  const newHmtx = new Uint8Array(order.length * 4)
  const nv = view(newHmtx)
  let off = 0
  let xMin = 0x7fff, yMin = 0x7fff, xMax = -0x8000, yMax = -0x8000
  let maxPoints = 0, maxContours = 0, awMax = 0
  let minLsb = 0x7fff, minRsb = 0x7fff, maxExtent = -0x8000
  order.forEach((gid, i) => {
    const g = stripGlyph(glyphAt(gid), id => newId.get(id) ?? 0)
    const [aw, lsb] = metric(gid)
    nv.setUint16(i * 4, aw)
    nv.setInt16(i * 4 + 2, lsb)
    awMax = Math.max(awMax, aw)
    lv.setUint32(i * 4, off)
    if (g.length) {
      const gv = view(g)
      const contours = gv.getInt16(0)
      const [x0, y0, x1, y1] = [gv.getInt16(2), gv.getInt16(4), gv.getInt16(6), gv.getInt16(8)]
      xMin = Math.min(xMin, x0)
      yMin = Math.min(yMin, y0)
      xMax = Math.max(xMax, x1)
      yMax = Math.max(yMax, y1)
      minLsb = Math.min(minLsb, lsb)
      minRsb = Math.min(minRsb, aw - (lsb + x1 - x0))
      maxExtent = Math.max(maxExtent, lsb + x1 - x0)
      if (contours > 0) {
        maxContours = Math.max(maxContours, contours)
        maxPoints = Math.max(maxPoints, gv.getUint16(10 + (contours - 1) * 2) + 1)
      }
      const padded = new Uint8Array(pad4(g.length))
      padded.set(g)
      glyphs.push(padded)
      off += padded.length
    }
  })
  lv.setUint32(order.length * 4, off)
  if (xMin > xMax) xMin = yMin = xMax = yMax = minLsb = minRsb = maxExtent = 0

  const newHead = new Uint8Array(head.subarray(0, 54))
  const hdv = view(newHead)
  hdv.setInt16(36, xMin)
  hdv.setInt16(38, yMin)
  hdv.setInt16(40, xMax)
  hdv.setInt16(42, yMax)
  hdv.setInt16(50, 1)
  hdv.setInt16(52, 0)

  const newHhea = new Uint8Array(hhea.subarray(0, 36))
  const hh = view(newHhea)
  hh.setUint16(10, awMax)
  hh.setInt16(12, minLsb)
  hh.setInt16(14, minRsb)
  hh.setInt16(16, maxExtent)
  hh.setUint16(34, order.length)

  const newMaxp = new Uint8Array(32)
  newMaxp.set(maxp.subarray(0, Math.min(32, maxp.length)))
  const mp = view(newMaxp)
  mp.setUint32(0, 0x00010000)
  mp.setUint16(4, order.length)
  mp.setUint16(6, maxPoints)
  mp.setUint16(8, maxContours)
  const zones = mp.getUint16(14)
  mp.setUint16(14, zones === 1 || zones === 2 ? zones : 1)
  for (const o of [16, 18, 20, 22, 24, 26]) mp.setUint16(o, 0) // twilight, storage, fdefs, idefs, stack, instruction size

  const newCmap = new Map<number, number>()
  for (const c of mapped) newCmap.set(c, newId.get(cmap.get(c) ?? cmap.get(aliases[c]!)!)!)

  const tablesOut: Record<string, Uint8Array> = {
    cmap: buildCmap(newCmap),
    glyf: concat(glyphs),
    head: newHead,
    hhea: newHhea,
    hmtx: newHmtx,
    loca: newLoca,
    maxp: newMaxp,
    name: buildName(nameRecords(tables.name ? table(src, tables, 'name') : null, opts.family)),
    post: postFormat3(tables.post ? table(src, tables, 'post') : null),
  }
  if (tables['OS/2']) tablesOut['OS/2'] = os2(table(src, tables, 'OS/2'), mapped)
  return { bytes: writeSfnt(tablesOut), glyphs: order.length, mapped, missing }
}

function nameRecords(name: Uint8Array | null, family?: string): Record<number, string> {
  const src = name ? readNames(name) : {}
  const fam = src[1] ?? family ?? 'Subset'
  const sub = src[2] ?? 'Regular'
  const out: Record<number, string> = {
    1: fam,
    2: sub,
    3: `${fam} ${sub} Latin subset`,
    4: src[4] ?? `${fam} ${sub}`,
    5: src[5] ?? 'Version 1.0',
    6: (src[6] ?? `${fam}-${sub}`).replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, ''),
  }
  if (src[0]) out[0] = src[0]
  return out
}

function postFormat3(post: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(32)
  if (post) out.set(post.subarray(0, Math.min(32, post.length)))
  view(out).setUint32(0, 0x00030000)
  return out
}

function os2(src: Uint8Array, mapped: number[]): Uint8Array {
  const out = new Uint8Array(src)
  const dv = view(out)
  if (out.length >= 68 && mapped.length) {
    dv.setUint32(42, (1 << 0) | (1 << 1) | (1 << 31)) // Basic Latin, Latin-1 Supplement, General Punctuation
    dv.setUint32(46, mapped.includes(0x20ac) ? 1 << 1 : 0) // Currency Symbols (bit 33)
    dv.setUint32(50, 0)
    dv.setUint32(54, 0)
    dv.setUint16(64, Math.min(mapped[0]!, 0xffff))
    dv.setUint16(66, Math.min(mapped[mapped.length - 1]!, 0xffff))
  }
  if (out.length >= 86 && dv.getUint16(0) >= 1) {
    dv.setUint32(78, 1) // code page 1252 Latin 1
    dv.setUint32(82, 0)
  }
  return out
}

function main(): void {
  const [input, output, family] = process.argv.slice(2)
  if (!input || !output) {
    console.log('usage: pnpm tsx packages/convert/src/tools/font-subset.ts <in.ttf> <out.ttf> [family]')
    process.exit(1)
  }
  const r = subsetFont(readFileSync(input), { family })
  writeFileSync(output, r.bytes)
  console.log(`${output}: ${r.glyphs} glyphs, ${r.mapped.length} code points, ${r.bytes.length} bytes; missing ${r.missing.map(c => c.toString(16)).join(' ') || 'none'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
