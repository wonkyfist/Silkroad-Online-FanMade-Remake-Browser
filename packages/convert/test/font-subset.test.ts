/**
 * The Latin subsetter (packages/convert/src/tools/font-subset.ts, docs/UI.md §4.3, §8) on a tiny synthetic
 * TrueType font: a short `loca`, hinting tables, a glyph with instructions, a composite (é = e + acute) and a
 * Hangul glyph that must be dropped. Then, when present, on the client's basic.ttf (work/extracted) and on the
 * exported subset (work/out/fonts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import {
  buildCmap,
  buildName,
  directorySearch,
  LATIN_CODE_POINTS,
  readCmap,
  readTables,
  subsetFont,
  tableChecksum,
  writeSfnt,
} from '../src/tools/font-subset.ts'

// ---------------------------------------------------------------- a synthetic source font

const INSTRUCTIONS = [0xb0, 0x01, 0x2b] // PUSHB[0] 1, ... (any bytes: they must be dropped)

/** A one-contour glyph: a square of `size` with `instructions` (flags use short positive x/y). */
function simpleGlyph(size: number, instructions: number[] = []): Uint8Array {
  const pts: [number, number][] = [[0, 0], [size, 0], [size, size], [0, size]]
  const b: number[] = []
  const u16 = (v: number): void => void b.push((v >> 8) & 0xff, v & 0xff)
  u16(1)
  u16(0), u16(0), u16(size), u16(size)
  u16(pts.length - 1)
  u16(instructions.length)
  b.push(...instructions)
  // flags: on-curve (1) | x short (2) | y short (4); +0x10/+0x20 = positive delta
  let px = 0
  let py = 0
  const xs: number[] = []
  const ys: number[] = []
  const flags: number[] = []
  for (const [x, y] of pts) {
    const dx = x - px
    const dy = y - py
    let f = 1
    if (dx === 0) f |= 0x10
    else (f |= 0x02 | (dx > 0 ? 0x10 : 0)), xs.push(Math.abs(dx))
    if (dy === 0) f |= 0x20
    else (f |= 0x04 | (dy > 0 ? 0x20 : 0)), ys.push(Math.abs(dy))
    flags.push(f)
    px = x
    py = y
  }
  b.push(...flags, ...xs, ...ys)
  b.push(0, 0, 0) // loca padding the subsetter must trim
  return Uint8Array.from(b)
}

/** A composite of `components` (glyph ids), byte offsets, the last one with instructions. */
function compositeGlyph(components: number[]): Uint8Array {
  const b: number[] = []
  const u16 = (v: number): void => void b.push((v >> 8) & 0xff, v & 0xff)
  u16(0xffff) // numberOfContours -1
  u16(0), u16(0), u16(500), u16(700)
  components.forEach((gid, i) => {
    const last = i === components.length - 1
    u16(0x0002 | (last ? 0x0100 : 0x0020)) // ARGS_ARE_XY_VALUES, then WE_HAVE_INSTRUCTIONS or MORE_COMPONENTS
    u16(gid)
    b.push(0, i * 10) // byte args
  })
  u16(INSTRUCTIONS.length)
  b.push(...INSTRUCTIONS)
  return Uint8Array.from(b)
}

interface Synthetic {
  bytes: Uint8Array
  /** Source glyph id of each code point. */
  gid: Map<number, number>
}

function syntheticFont(): Synthetic {
  const glyphs: Uint8Array[] = [simpleGlyph(400)] // .notdef
  const gid = new Map<number, number>()
  for (let c = 0x41; c <= 0x7a; c++) {
    gid.set(c, glyphs.length)
    glyphs.push(simpleGlyph(100 + c, c === 0x41 ? INSTRUCTIONS : []))
  }
  gid.set(0x20, glyphs.length)
  glyphs.push(new Uint8Array(0)) // space: empty glyph
  const acute = glyphs.length
  glyphs.push(simpleGlyph(60))
  gid.set(0xac00, glyphs.length)
  glyphs.push(simpleGlyph(900, INSTRUCTIONS)) // 가: dropped
  gid.set(0xe9, glyphs.length)
  glyphs.push(compositeGlyph([gid.get(0x65)!, acute]))

  const n = glyphs.length
  // short loca: offsets / 2, so every glyph is padded to 2 bytes
  const padded = glyphs.map(g => (g.length % 2 ? Uint8Array.from([...g, 0]) : g))
  const glyf = new Uint8Array(padded.reduce((s, g) => s + g.length, 0))
  const loca = new Uint8Array((n + 1) * 2)
  let off = 0
  padded.forEach((g, i) => {
    new DataView(loca.buffer).setUint16(i * 2, off / 2)
    glyf.set(g, off)
    off += g.length
  })
  new DataView(loca.buffer).setUint16(n * 2, off / 2)

  const head = new Uint8Array(54)
  const hd = new DataView(head.buffer)
  hd.setUint32(0, 0x00010000)
  hd.setUint32(12, 0x5f0f3cf5)
  hd.setUint16(18, 1024)
  hd.setInt16(50, 0)
  const hhea = new Uint8Array(36)
  const hh = new DataView(hhea.buffer)
  hh.setUint32(0, 0x00010000)
  hh.setInt16(4, 900)
  hh.setInt16(6, -200)
  hh.setUint16(34, n - 1) // the last glyph takes the last advance
  const hmtx = new Uint8Array((n - 1) * 4 + 2)
  const hm = new DataView(hmtx.buffer)
  for (let i = 0; i < n - 1; i++) {
    hm.setUint16(i * 4, 500 + i)
    hm.setInt16(i * 4 + 2, 0)
  }
  hm.setInt16((n - 1) * 4, 7) // lsb of the last glyph
  const maxp = new Uint8Array(32)
  const mp = new DataView(maxp.buffer)
  mp.setUint32(0, 0x00010000)
  mp.setUint16(4, n)
  mp.setUint16(14, 2)
  mp.setUint16(20, 12) // maxFunctionDefs
  mp.setUint16(26, 300) // maxSizeOfInstructions
  const os2 = new Uint8Array(86)
  new DataView(os2.buffer).setUint16(0, 1)
  const post = new Uint8Array(32)
  new DataView(post.buffer).setUint32(0, 0x00020000)

  const bytes = writeSfnt({
    'OS/2': os2,
    cmap: buildCmap(gid),
    'cvt ': Uint8Array.from([0, 1, 0, 2]),
    fpgm: Uint8Array.from(INSTRUCTIONS),
    glyf,
    head,
    hhea,
    hmtx,
    loca,
    maxp,
    name: buildName({ 1: 'Synth', 2: 'Regular' }),
    post,
    prep: Uint8Array.from(INSTRUCTIONS),
  })
  return { bytes, gid }
}

// ---------------------------------------------------------------- checks shared by synthetic and real

function u16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!
}

function tableBytes(font: Uint8Array, tag: string): Uint8Array {
  const t = readTables(font)[tag]!
  return font.subarray(t.offset, t.offset + t.length)
}

function checkSfnt(font: Uint8Array): void {
  const n = u16(font, 4)
  const s = directorySearch(n)
  expect([u16(font, 6), u16(font, 8), u16(font, 10)]).toEqual([s.searchRange, s.entrySelector, s.rangeShift])
  const tables = readTables(font)
  const tags = Object.keys(tables)
  expect(tags).toEqual([...tags].sort())
  for (const [tag, t] of Object.entries(tables)) {
    expect(t.offset % 4, tag).toBe(0)
    const bytes = new Uint8Array(font.subarray(t.offset, t.offset + t.length))
    if (tag === 'head') new DataView(bytes.buffer).setUint32(8, 0)
    expect(t.checksum, `${tag} checksum`).toBe(tableChecksum(bytes))
  }
  expect(tableChecksum(font)).toBe(0xb1b0afba)
  for (const tag of ['fpgm', 'prep', 'cvt ']) expect(tables[tag], tag).toBeUndefined()

  const head = tableBytes(font, 'head')
  expect(u16(head, 50)).toBe(1) // long loca
  const numGlyphs = u16(tableBytes(font, 'maxp'), 4)
  expect(u16(tableBytes(font, 'hhea'), 34)).toBe(numGlyphs)
  expect(tableBytes(font, 'hmtx').length).toBe(numGlyphs * 4)
  const loca = tableBytes(font, 'loca')
  const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength)
  expect(loca.length).toBe((numGlyphs + 1) * 4)
  const glyf = tableBytes(font, 'glyf')
  let prev = 0
  for (let i = 0; i <= numGlyphs; i++) {
    const o = lv.getUint32(i * 4)
    expect(o).toBeGreaterThanOrEqual(prev)
    expect(o % 4).toBe(0)
    prev = o
  }
  expect(prev).toBe(glyf.length)
  // no glyph keeps instructions
  for (let i = 0; i < numGlyphs; i++) {
    const a = lv.getUint32(i * 4)
    if (lv.getUint32(i * 4 + 4) === a) continue
    const contours = (u16(glyf, a) << 16) >> 16
    if (contours >= 0) expect(u16(glyf, a + 10 + contours * 2), `glyph ${i} instructionLength`).toBe(0)
    else {
      let p = a + 10
      for (;;) {
        const flags = u16(glyf, p)
        expect(flags & 0x0100, `glyph ${i} WE_HAVE_INSTRUCTIONS`).toBe(0)
        p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0)
        if (!(flags & 0x20)) break
      }
    }
  }
  const post = tableBytes(font, 'post')
  expect(post.length).toBe(32)
  expect(u16(post, 0)).toBe(3)
}

describe('font-subset: synthetic font', () => {
  const src = syntheticFont()
  const r = subsetFont(src.bytes)
  const out = r.bytes

  it('writes a valid table directory, checksums, long loca and no hinting', () => {
    checkSfnt(out)
    expect(Object.keys(readTables(out))).toEqual(['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'])
    const maxp = tableBytes(out, 'maxp')
    expect(u16(maxp, 20)).toBe(0) // maxFunctionDefs
    expect(u16(maxp, 26)).toBe(0) // maxSizeOfInstructions
  })

  it('maps A..z, space, NBSP (as space) and é; drops Hangul', () => {
    const cmap = readCmap(tableBytes(out, 'cmap'))
    for (let c = 0x41; c <= 0x7a; c++) expect(cmap.get(c), String.fromCharCode(c)).toBeGreaterThan(0)
    expect(cmap.get(0xe9)).toBeGreaterThan(0)
    expect(cmap.get(0xa0)).toBe(cmap.get(0x20))
    expect(cmap.has(0xac00)).toBe(false)
    // .notdef + 58 letters + space + é + the acute component
    expect(r.glyphs).toBe(62)
    expect(u16(tableBytes(out, 'maxp'), 4)).toBe(62)
    expect(r.missing).toContain(0x7e)
    expect(r.mapped).toContain(0xe9)
  })

  it('keeps glyph outlines and metrics, drops instructions, remaps components', () => {
    const cmap = readCmap(tableBytes(out, 'cmap'))
    const loca = tableBytes(out, 'loca')
    const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength)
    const glyf = tableBytes(out, 'glyf')
    const glyph = (gid: number): Uint8Array => glyf.subarray(lv.getUint32(gid * 4), lv.getUint32(gid * 4 + 4))
    // 'A' had 3 instruction bytes: now the outline without them (plus zero padding to 4)
    const expected = simpleGlyph(100 + 0x41, [])
    const a = glyph(cmap.get(0x41)!)
    expect([...a.subarray(0, expected.length - 3)]).toEqual([...expected.subarray(0, expected.length - 3)])
    expect(a.length % 4).toBe(0)
    // é: components point at the new 'e' and the acute
    const e = glyph(cmap.get(0xe9)!)
    expect(u16(e, 0)).toBe(0xffff)
    expect(u16(e, 12)).toBe(cmap.get(0x65))
    const acute = u16(e, 12 + 6)
    expect(acute).toBeGreaterThan(0)
    expect(acute).toBeLessThan(r.glyphs)
    // space stays empty; advances follow the glyphs
    expect(glyph(cmap.get(0x20)!).length).toBe(0)
    const hmtx = tableBytes(out, 'hmtx')
    expect(u16(hmtx, cmap.get(0x41)! * 4)).toBe(500 + src.gid.get(0x41)!)
    expect(u16(hmtx, cmap.get(0xe9)! * 4)).toBe(500 + src.gid.get(0xe9)! - 1) // é is past numberOfHMetrics: it repeats the last advance
  })

  it('writes English name records and Latin OS/2 ranges', () => {
    const os2 = tableBytes(out, 'OS/2')
    expect(u16(os2, 64)).toBe(0x20)
    expect(u16(os2, 66)).toBe(0xe9)
    const name = tableBytes(out, 'name')
    expect(u16(name, 2)).toBeGreaterThanOrEqual(6)
    expect(u16(name, 6)).toBe(3) // platform 3
  })

  it('computes the directory search fields', () => {
    expect(directorySearch(10)).toEqual({ searchRange: 128, entrySelector: 3, rangeShift: 32 })
    expect(directorySearch(13)).toEqual({ searchRange: 128, entrySelector: 3, rangeShift: 80 })
    expect(directorySearch(16)).toEqual({ searchRange: 256, entrySelector: 4, rangeShift: 0 })
  })
})

const BASIC = join(REPO_ROOT, 'work', 'extracted', 'Media', 'fonts', '기본서체.ttf')
const OUT_BASIC = join(REPO_ROOT, 'work', 'out', 'fonts', 'basic.ttf')

describe.skipIf(!existsSync(BASIC))('font-subset: the client basic.ttf (work/extracted)', () => {
  it('subsets to a small, valid Latin font', () => {
    const src = readFileSync(BASIC)
    const srcCmap = readCmap(tableBytes(src, 'cmap'))
    const r = subsetFont(src, { family: 'TaeUtum' })
    checkSfnt(r.bytes)
    expect(r.glyphs).toBeLessThan(400)
    const cmap = readCmap(tableBytes(r.bytes, 'cmap'))
    // every kept code point the source maps is mapped; all of ASCII is
    for (const c of LATIN_CODE_POINTS) if (srcCmap.has(c)) expect(cmap.get(c), c.toString(16)).toBeGreaterThan(0)
    for (let c = 0x20; c <= 0x7e; c++) expect(cmap.has(c), c.toString(16)).toBe(true)
    expect(r.mapped.length + r.missing.length).toBe(LATIN_CODE_POINTS.length)
  })
})

describe.skipIf(!existsSync(OUT_BASIC))('font-subset: the exported work/out/fonts/basic.ttf', () => {
  it('is the subset, not the 13,588-glyph original', () => {
    const font = readFileSync(OUT_BASIC)
    checkSfnt(font)
    expect(u16(tableBytes(font, 'maxp'), 4)).toBeLessThan(400)
  })
})
