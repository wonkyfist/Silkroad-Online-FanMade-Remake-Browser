/**
 * The UI-kit parts of packages/convert/src/tools/export-ui.ts (docs/UI.md §5.4, §8): nine-slice composition
 * of synthetic 8-piece (and 6-piece) frames, the window_all atlas maths (resinfo UV -> px), the TGA decoder in
 * both row orders, and, when work/out/ui/index.json exists, the exported manifest (sheets, crops, digits,
 * cursor, englishText).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { decodeTga } from '../src/tga.ts'
import {
  ATLAS_CROPS,
  atlasRectsInResinfo,
  completePieces,
  composeNine,
  cropRaster,
  NINE_FRAMES,
  NINE_PIECES,
  tileSpan,
  transpose,
  uvToRect,
  type NinePiece,
  type Raster,
} from '../src/tools/export-ui.ts'

/** A w x h raster whose texel (x, y) is [id, x, y, 255]. */
function piece(id: number, w: number, h: number): Raster {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([id, x, y, 255], (y * w + x) * 4)
  return { width: w, height: h, rgba }
}

function px(r: Raster, x: number, y: number): number[] {
  const o = (y * r.width + x) * 4
  return [...r.rgba.subarray(o, o + 4)]
}

describe('nine-slice sheets', () => {
  it('composes mframe-like pieces: insets and sheet size', () => {
    const ids = Object.fromEntries(NINE_PIECES.map((k, i) => [k, i + 1])) as Record<NinePiece, number>
    const p: Record<NinePiece, Raster> = {
      left_up: piece(ids.left_up, 40, 68),
      mid_up: piece(ids.mid_up, 128, 68),
      right_up: piece(ids.right_up, 40, 68),
      left_side: piece(ids.left_side, 40, 128),
      right_side: piece(ids.right_side, 40, 128),
      left_down: piece(ids.left_down, 40, 48),
      mid_down: piece(ids.mid_down, 128, 48),
      right_down: piece(ids.right_down, 40, 48),
    }
    const { image, nine } = composeNine(p)
    expect(nine).toEqual({ top: 68, right: 40, bottom: 48, left: 40 })
    expect([image.width, image.height]).toEqual([208, 244])
    expect(px(image, 0, 0)).toEqual([ids.left_up, 0, 0, 255])
    expect(px(image, 207, 0)).toEqual([ids.right_up, 39, 0, 255])
    expect(px(image, 0, 243)).toEqual([ids.left_down, 0, 47, 255])
    expect(px(image, 207, 243)).toEqual([ids.right_down, 39, 47, 255])
    expect(px(image, 40, 5)).toEqual([ids.mid_up, 0, 5, 255])
    expect(px(image, 5, 68)).toEqual([ids.left_side, 5, 0, 255])
    expect(px(image, 170, 68 + 127)).toEqual([ids.right_side, 2, 127, 255])
    expect(px(image, 100, 100)).toEqual([0, 0, 0, 0]) // centre: transparent
  })

  it('tiles edges to the lcm of the two opposite pieces, phase fixed at the slice line', () => {
    // int_window_-like: all 16x16 but mid_down 24x16 -> M = 48; sides 16 and 12 high -> S = 48
    const p: Record<NinePiece, Raster> = {
      left_up: piece(1, 16, 16),
      mid_up: piece(2, 16, 16),
      right_up: piece(3, 16, 16),
      left_side: piece(4, 16, 16),
      right_side: piece(5, 16, 12),
      left_down: piece(6, 16, 16),
      mid_down: piece(7, 24, 16),
      right_down: piece(8, 16, 16),
    }
    const { image, nine } = composeNine(p)
    expect(nine).toEqual({ top: 16, right: 16, bottom: 16, left: 16 })
    expect([image.width, image.height]).toEqual([16 + 48 + 16, 16 + 48 + 16])
    for (let x = 16; x < 64; x++) {
      expect(px(image, x, 0)[1]).toBe((x - 16) % 16) // mid_up: 3 whole tiles
      expect(px(image, x, 79)[1]).toBe((x - 16) % 24) // mid_down: 2 whole tiles
    }
    for (let y = 16; y < 64; y++) {
      expect(px(image, 0, y)[2]).toBe((y - 16) % 16)
      expect(px(image, 79, y)[2]).toBe((y - 16) % 12) // right side: 4 whole tiles
    }
  })

  it('tileSpan caps a long lcm at the longer tile', () => {
    expect(tileSpan(128, 128)).toBe(128)
    expect(tileSpan(16, 24)).toBe(48)
    expect(tileSpan(96, 128)).toBe(128) // lcm 384 > 256
  })

  it('synthesizes the missing top/bottom edges of six-piece frames from the transposed sides', () => {
    const ls = piece(4, 4, 4)
    const rs = piece(5, 4, 4)
    const { pieces, synthesized } = completePieces({
      left_up: piece(1, 4, 4),
      right_up: piece(3, 4, 4),
      left_side: ls,
      right_side: rs,
      left_down: piece(6, 4, 4),
      right_down: piece(8, 4, 4),
    })
    expect(synthesized).toEqual(['mid_up', 'mid_down'])
    expect(px(pieces.mid_up, 2, 0)).toEqual(px(ls, 0, 2)) // the outer column of the left side is the top row
    expect(px(pieces.mid_down, 1, 3)).toEqual(px(rs, 3, 1))
    expect(() => completePieces({ left_up: piece(1, 4, 4) })).toThrow(/missing frame pieces/)
    const t = transpose(piece(9, 3, 2))
    expect([t.width, t.height]).toEqual([2, 3])
    expect(px(t, 1, 2)).toEqual([9, 2, 1, 255]) // = source texel (2, 1)
  })
})

describe('window_all atlas crops', () => {
  it('converts resinfo UVs to atlas pixels', () => {
    expect(uvToRect([0.72363, 0.8847], [0.9541, 0.955], 1024, 512)).toEqual([741, 453, 236, 36])
  })

  it('reads every window_all UV rect of a resinfo file, both #ifdef branches', () => {
    const text = [
      'GDR_TW_COMMONENEMY:CIFStatic',
      '{',
      '\tDDJ=STRING,"interface\\\\ifcommon\\\\window_all.ddj"',
      '#ifdef UI_UPDATE_2009_FIRST',
      '\tUV_LT=POINT,"0.72363,0.8847"',
      '\tUV_RB=POINT,"0.9541,0.955"',
      '#else',
      '\tUV_LT=POINT,"0.530273,0"',
      '\tUV_RB=POINT,"0.721680,0.099609"',
      '#endif',
      '}',
      'GDR_OTHER:CIFStatic',
      '{',
      '\tDDJ=STRING,"interface\\\\ifcommon\\\\com_button.ddj"',
      '\tUV_LT=POINT,"0,0"',
      '\tUV_RB=POINT,"1,1"',
      '}',
    ].join('\r\n')
    expect(atlasRectsInResinfo(text)).toEqual([
      [741, 453, 236, 36],
      [543, 0, 196, 51],
    ])
  })

  it('crops a region, transparent outside the source', () => {
    const src = piece(1, 8, 4)
    const c = cropRaster(src, [6, 2, 4, 3])
    expect([c.width, c.height]).toEqual([4, 3])
    expect(px(c, 0, 0)).toEqual([1, 6, 2, 255])
    expect(px(c, 3, 0)).toEqual([0, 0, 0, 0])
    expect(px(c, 0, 2)).toEqual([0, 0, 0, 0])
  })

  it('lists the docs/UI.md §2.7 export keys', () => {
    expect(ATLAS_CROPS.map(c => c.key)).toEqual(
      ['pmi', 'tw_enemy', 'tw_special', 'tw_player', 'tw_job', 'party_slot', 'pet', 'chat_input', 'sysmsg_filter', 'whisper_list', 'pmi_stats'].map(k => `ifcommon/wa_${k}`),
    )
    for (const c of ATLAS_CROPS) {
      expect(c.rect[0] + c.rect[2]).toBeLessThanOrEqual(1024)
      expect(c.rect[1] + c.rect[3]).toBeLessThanOrEqual(512)
    }
  })
})

/** A 2x2, 32-bit TGA: file-order pixels (BGRA) and the descriptor. */
function tga(desc: number, pixels: number[][], type = 2, bpp = 32): Uint8Array {
  const h = new Uint8Array(18)
  h[2] = type
  h[12] = 2
  h[14] = 2
  h[16] = bpp
  h[17] = desc
  return Uint8Array.from([...h, ...pixels.flat()])
}

describe('TGA decode', () => {
  // Visual image (top-down): red, green / blue, white-half-alpha.
  const RED = [0, 0, 255, 255]
  const GREEN = [0, 255, 0, 255]
  const BLUE = [255, 0, 0, 255]
  const WHITE = [255, 255, 255, 128]
  const expected = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]

  it('flips bottom-up rows (descriptor 0x08, the cursor)', () => {
    const img = decodeTga(tga(0x08, [BLUE, WHITE, RED, GREEN]))
    expect([img.width, img.height]).toEqual([2, 2])
    expect([...img.rgba]).toEqual(expected)
  })

  it('keeps top-down rows (descriptor 0x28)', () => {
    expect([...decodeTga(tga(0x28, [RED, GREEN, BLUE, WHITE])).rgba]).toEqual(expected)
  })

  it('decodes run-length data and 24-bit pixels', () => {
    const rle = Uint8Array.from([...tga(0x28, [], 10).subarray(0, 18), 0x81, ...RED, 0x01, ...BLUE, ...WHITE])
    expect([...decodeTga(rle).rgba]).toEqual([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128])
    const rgb = decodeTga(tga(0x20, [[0, 0, 255], [0, 255, 0], [255, 0, 0], [9, 9, 9]], 2, 24))
    expect([...rgb.rgba.subarray(0, 8)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255])
  })

  it('rejects colour-mapped and truncated files', () => {
    expect(() => decodeTga(tga(0x08, [], 1, 8))).toThrow(/unsupported/)
    expect(() => decodeTga(tga(0x08, [RED]))).toThrow(/truncated/)
  })
})

const INDEX = join(REPO_ROOT, 'work', 'out', 'ui', 'index.json')

describe.skipIf(!existsSync(INDEX))('work/out/ui/index.json (export-ui.ts output)', () => {
  const m = existsSync(INDEX)
    ? (JSON.parse(readFileSync(INDEX, 'utf8')) as {
        images: Record<string, { file: string; width: number; height: number; nine?: Record<string, number>; derived?: { from: string } }>
        englishText?: Record<string, string>
        bakedText?: Record<string, string>
      })
    : null!
  const file = (key: string): string => join(REPO_ROOT, 'work', 'out', m.images[key]!.file)

  it('has a nine-slice sheet per frame family, insets inside the sheet', () => {
    for (const prefix of NINE_FRAMES) {
      const e = m.images[`${prefix}9`]
      expect(e, prefix).toBeDefined()
      const n = e!.nine!
      expect(n.left + n.right).toBeLessThan(e!.width)
      expect(n.top + n.bottom).toBeLessThan(e!.height)
      expect(existsSync(file(`${prefix}9`))).toBe(true)
    }
    expect(m.images['frame/mframe_wnd_9']!.nine).toEqual({ top: 68, right: 40, bottom: 48, left: 40 })
  })

  it('has the atlas crops, the 52 hitcount images, the cursor and the social exchange art', () => {
    for (const c of ATLAS_CROPS) {
      const e = m.images[c.key]!
      expect([e.width, e.height], c.key).toEqual([c.rect[2], c.rect[3]])
      expect(e.derived?.from).toBe('ifcommon/window_all')
    }
    const hit = Object.keys(m.images).filter(k => k.startsWith('hitcount/'))
    expect(hit).toHaveLength(52)
    for (let d = 0; d <= 9; d++) for (const v of ['', '_enemy', '_player']) expect(m.images[`hitcount/hitcount${v}_${d}`]).toBeDefined()
    expect(m.images['cursor/normal']).toMatchObject({ file: 'ui/cursor/normal.png', width: 32, height: 32 })
    for (const k of ['exchange/ch_red', 'exchange/ch_line', 'exchange/exc_box']) expect(m.images[k], k).toBeDefined()
    expect(Object.keys(m.images).some(k => k.startsWith('effect/'))).toBe(false)
    expect(Object.keys(m.images).some(k => /\s|eu_|europe|islam/.test(k))).toBe(false)
  })

  it('lists English-text art in englishText, never in bakedText', () => {
    const en = m.englishText ?? {}
    for (const k of ['underbar/ub_new_mainbar2', 'underbar/ub_new_menu', 'skill/skl_button_add', 'hitcount/critical']) expect(en[k], k).toBeDefined()
    for (const k of Object.keys(en)) {
      expect(m.images[k], k).toBeDefined()
      expect(m.bakedText?.[k], k).toBeUndefined()
    }
  })
})
