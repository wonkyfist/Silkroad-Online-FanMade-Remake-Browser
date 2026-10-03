/**
 * The coast's minimap tiles and world map (docs/COAST.md §11, §12.3; WAVE_PLAN6 CST-M, converter part):
 * - a changed tile keeps its retail pixels outside the (dilated) change mask, bit for bit;
 * - an unchanged region keeps its retail tile; a synthetic tile of open sea is sea-coloured; tiles are north-up;
 * - the world map is the export grown to the coast domain x 64 px, filled with the sea colour;
 * - on the pass's own output (a small synthetic world): the class rules mirrored for the smooth edges agree with
 *   ./pass.ts, every emitted region gets a synthetic tile, and every tile with open sea and dry ground outside the
 *   frozen set draws sand between them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { emitCensus } from '../src/world/coast/census.ts'
import { parseCoastConfig, type CoastConfig } from '../src/world/coast/config.ts'
import { CELLS_PER_REGION, colX, latticeShape, rowZ, type LatticeShape } from '../src/world/coast/lattice.ts'
import {
  CHANGE_DILATE_PX, changedVertices, coastMapColours, coastMinimapOptions, coastMinimapTile, coastWorldMapFill, coastWorldMapRect,
  MINIMAP_SIZE, SEA_BELOW_M, seaColour, WET_BAND_M, type CoastMinimapField, type CoastMinimapOptions,
} from '../src/world/coast/minimap.ts'
import { COAST_CLASS, runCoastPass, type CoastPassInput, type CoastResult } from '../src/world/coast/pass.ts'
import { hexFill, stitchWorldMap, WORLD_MAP_FILL, WORLD_MAP_PX, type RgbaImage } from '../src/world/worldmap.ts'

const S = MINIMAP_SIZE
const coast = parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))
const opts: CoastMinimapOptions = coastMinimapOptions(coast)
const SL = coast.seaLevelM

/** A hand-made field over a 3 x 3 region domain (regions 10..12): every vertex land at 20 m unless `paint` says. */
function field(paint?: (x: number, z: number) => { h: number; cls: number } | null) {
  const shape: LatticeShape = latticeShape({ x: [10, 12], z: [10, 12] })
  const n = shape.rows * shape.cols
  const h = new Float64Array(n).fill(20)
  const cls = new Uint8Array(n)
  const retail = new Float64Array(n).fill(20)
  for (let r = 0; r < shape.rows; r++) {
    for (let c = 0; c < shape.cols; c++) {
      const p = paint?.(colX(shape, c), rowZ(shape, r))
      if (!p) continue
      h[r * shape.cols + c] = p.h
      cls[r * shape.cols + c] = p.cls
    }
  }
  const f: CoastMinimapField = { shape, h, cls, masks: { inPlay: new Uint8Array(n) } }
  return { f, retail }
}

/** A retail tile with a distinctive pattern (so a changed pixel cannot match by chance). */
function retailTile(): RgbaImage {
  const rgba = new Uint8Array(S * S * 4)
  for (let p = 0; p < S * S; p++) rgba.set([(p * 7) & 255, (p >> 8) & 255, 200 - ((p * 3) & 127), 255], p * 4)
  return { width: S, height: S, rgba }
}

const px = (img: RgbaImage, c: number, r: number) => [...img.rgba.subarray((r * S + c) * 4, (r * S + c) * 4 + 4)]

describe('coast minimap tiles (COAST §11)', () => {
  it('keeps an unchanged region as its retail tile', () => {
    const { f, retail } = field()
    const t = coastMinimapTile(f, retail, 11, 11, retailTile(), opts)!
    expect(t.kind).toBe('retail')
    expect(t.changedPx).toBe(0)
    expect(Buffer.from(t.rgba).equals(Buffer.from(retailTile().rgba))).toBe(true)
  })

  it('returns null outside the lattice domain', () => {
    const { f, retail } = field()
    expect(coastMinimapTile(f, retail, 13, 11, retailTile(), opts)).toBeNull()
    expect(changedVertices(f, retail, 11, 9)).toBeNull()
  })

  it('keeps the retail pixels outside the change mask of a changed tile, and redraws inside it', () => {
    // the north-east quarter of region (11, 11) is lowered to a sand beach and sea; the rest is untouched
    const { f, retail } = field((x, z) => (x >= 11.5 && x <= 12 && z >= 11.5 && z <= 12 ? (x > 11.8 ? { h: SL - 6, cls: COAST_CLASS.sea } : { h: SL + 1, cls: COAST_CLASS.sand }) : null))
    const base = retailTile()
    const t = coastMinimapTile(f, retail, 11, 11, base, opts)!
    expect(t.kind).toBe('composite')
    expect(t.changedPx).toBeGreaterThan(0.2 * S * S)
    expect(t.changedPx).toBeLessThan(0.3 * S * S)
    // the changed quarter starts at column 128 and ends at row 128 (north-up: row 0 is the north edge z = 12)
    const margin = CHANGE_DILATE_PX + 2
    let kept = 0
    for (let r = 0; r < S; r++) {
      for (let c = 0; c < S; c++) {
        const outside = c < 128 - margin || r > 128 + margin
        if (!outside) continue
        expect(px(t, c, r)).toEqual(px(base, c, r))
        kept++
      }
    }
    expect(kept).toBeGreaterThan(0.6 * S * S)
    // inside: the sand swatch near the quarter's west edge, the sea near its east edge (after the foam line)
    const col = coastMapColours(coast)
    const sand = px(t, 150, 60)
    for (let k = 0; k < 3; k++) expect(Math.abs(sand[k]! - col.sand[k]!)).toBeLessThan(0.2 * col.sand[k]! + 4)
    const sea = px(t, 250, 60)
    expect(sea[2]).toBeGreaterThan(sea[0]!)
    // the band across the dilation fades from our render to retail (neither is exact there)
    expect(px(t, 128 - 2, 60)).not.toEqual(px(base, 128 - 2, 60))
  })

  it('draws a synthetic region of open sea in the sea colour, darker with depth', () => {
    const { f, retail } = field(x => ({ h: x < 11.5 ? SL - 12 : SL - 40, cls: COAST_CLASS.sea }))
    retail.fill(NaN)
    const t = coastMinimapTile(f, retail, 11, 11, null, opts)!
    expect(t.kind).toBe('synthetic')
    expect(t.changedPx).toBe(S * S)
    const want = [0, 0, 0]
    seaColour(opts.colours, 12, want)
    const west = px(t, 20, 128)
    for (let k = 0; k < 3; k++) expect(Math.abs(west[k]! - want[k]!)).toBeLessThanOrEqual(2)
    const east = px(t, 240, 128)
    expect(east[2]).toBeLessThan(west[2]!)
    for (let p = 0; p < S * S; p++) {
      expect(t.rgba[p * 4 + 2]).toBeGreaterThan(t.rgba[p * 4]!)
      expect(t.rgba[p * 4 + 3]).toBe(255)
    }
    // mapColor itself at ~10 m
    seaColour(opts.colours, 10, want)
    expect(want.map(Math.round)).toEqual([...hexFill(coast.ocean.mapColor)])
  })

  it('is north-up: land in the north half, sea in the south half of a synthetic region', () => {
    const { f, retail } = field((_x, z) => (z >= 11.5 ? { h: SL + 2, cls: COAST_CLASS.sand } : { h: SL - 8, cls: COAST_CLASS.sea }))
    retail.fill(NaN)
    const t = coastMinimapTile(f, retail, 11, 11, null, opts)!
    const north = px(t, 128, 20)
    const south = px(t, 128, 236)
    expect(north[0]).toBeGreaterThan(north[2]!) // sand: warm
    expect(south[2]).toBeGreaterThan(south[0]!) // sea: blue
    // the foam line sits on the sea side of the shore
    const foam = px(t, 128, 129)
    expect(Math.min(...foam.slice(0, 3))).toBeGreaterThan(Math.max(...south.slice(0, 3)))
  })

  it('draws the footprints of added props', () => {
    const { f, retail } = field()
    const t = coastMinimapTile(f, retail, 11, 11, retailTile(), { ...opts, footprints: [{ x: 11.5, z: 11.5, radiusM: 6 }] })!
    expect(t.kind).toBe('composite')
    expect(px(t, 128, 128)).not.toEqual(px(retailTile(), 128, 128))
    expect(px(t, 20, 20)).toEqual(px(retailTile(), 20, 20))
  })

  it('is deterministic', () => {
    const { f, retail } = field((x, z) => (x + z > 23 ? { h: SL - 3, cls: COAST_CLASS.sea } : x + z > 22.8 ? { h: SL + 0.5, cls: COAST_CLASS.wetSand } : null))
    const a = coastMinimapTile(f, retail, 11, 11, retailTile(), opts)!
    const b = coastMinimapTile(f, retail, 11, 11, retailTile(), opts)!
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true)
  })
})

describe('the world map with a coast (COAST §11)', () => {
  it('is the export grown to the coast domain x 64 px, sea-filled where no region has a tile', () => {
    const exportRect = { x0: 155, x1: 175, z0: 89, z1: 103 }
    const domain = { x0: coast.domain.x[0], x1: coast.domain.x[1], z0: coast.domain.z[0], z1: coast.domain.z[1] }
    const rect = coastWorldMapRect(exportRect, domain)
    expect(rect).toEqual({ x0: 150, x1: 177, z0: 86, z1: 105 })
    const tile: RgbaImage = { width: S, height: S, rgba: new Uint8Array(S * S * 4).fill(255) }
    const fill = coastWorldMapFill({ mapColor: coast.ocean.mapColor })
    const img = stitchWorldMap(rect, (x, z) => (x === 168 && z === 97 ? tile : null), WORLD_MAP_PX, fill)
    expect(img).toMatchObject({ width: 28 * 64, height: 20 * 64, tiles: 1 })
    // The fill is the deep stop the tiles reach (mapColor x OPEN_SEA_TONE), so the tiles meet it without a step.
    const deep: number[] = []
    seaColour(coastMapColours(coast), 60, deep)
    expect([...img.rgba.subarray(0, 4)]).toEqual([...deep.map(Math.round), 255])
    const at = ((105 - 97) * 64 * img.width + (168 - 150) * 64) * 4
    expect([...img.rgba.subarray(at, at + 4)]).toEqual([255, 255, 255, 255])
  })

  it('keeps the retail fill without a coast', () => {
    expect(coastWorldMapFill(undefined)).toEqual(WORLD_MAP_FILL)
    const img = stitchWorldMap({ x0: 0, x1: 0, z0: 0, z1: 0 }, () => null, 2)
    expect([...img.rgba.subarray(0, 4)]).toEqual([...WORLD_MAP_FILL, 255])
  })
})

// --- on the pass's own output ---------------------------------------------------------------------------------------

const PLAY = { x0: 13, x1: 15, z0: 13, z1: 15 }
const EXPORT = { x0: 12, x1: 16, z0: 12, z1: 16 }

/** coast-pass.test.ts's synthetic world, simplified: a 10 m plateau over the export, sea on every side (phase 1). */
function synthConfig(): CoastConfig {
  return {
    ...coast,
    option: 'B',
    phase: 1,
    domain: { x: [10, 18], z: [10, 18] },
    emit: { x: [10, 18], z: [10, 18], depthM: 8 },
    corridor: null,
    cornerBelowZ: 12,
    sections: [
      { code: 'N', side: 'north', from: 13, to: 15, corners: [[16, 16]], kind: 'wide', c0: 150, amp: 30, phase: 1 },
      { code: 'E', side: 'east', from: 13, to: 15, corners: [[16, 13]], kind: 'bay', c0: 95, amp: 30, phase: 1 },
      { code: 'S', side: 'south', from: 13, to: 15, corners: [[13, 13]], kind: 'wide', c0: 120, amp: 30, phase: 1 },
      { code: 'W', side: 'west', from: 13, to: 15, corners: [[13, 16]], kind: 'strait', c0: 90, amp: 20, phase: 1 },
    ],
    tombKeep: { ...coast.tombKeep, x: [14, 15] },
    allowHeightPatches: [],
    places: [],
  }
}

function synthInput(cfg: CoastConfig): CoastPassInput {
  const l = latticeShape(cfg.domain)
  const n = l.rows * l.cols
  const heights = new Float64Array(n).fill(NaN)
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < l.cols; c++) {
      const x = colX(l, c)
      const z = rowZ(l, r)
      if (x >= EXPORT.x0 && x <= EXPORT.x1 + 1 && z >= EXPORT.z0 && z <= EXPORT.z1 + 1) {
        heights[r * l.cols + c] = 10 + 2 * Math.sin(x * 7.1) * Math.cos(z * 5.3)
      }
    }
  }
  return { heights, water: new Float64Array(n).fill(NaN), active: () => true, playable: PLAY, exportRect: EXPORT }
}

describe('coast minimap tiles of a coast pass result', () => {
  let cfg: CoastConfig
  let input: CoastPassInput
  let res: CoastResult
  let retail: Float64Array

  beforeAll(() => {
    cfg = synthConfig()
    input = synthInput(cfg)
    res = runCoastPass(input, cfg)
    retail = Float64Array.from(input.heights, v => (v < cfg.holeBelowM ? NaN : v))
  })

  it('mirrors the pass class rules the smooth edges follow (sea below SL - SEA_BELOW_M, wet sand within WET_BAND_M)', () => {
    let sea = 0
    let wet = 0
    let dry = 0
    for (let i = 0; i < res.h.length; i++) {
      const c = res.cls[i]!
      if (c === COAST_CLASS.sea && !res.masks.wetR[i]) {
        expect(res.h[i]).toBeLessThan(cfg.seaLevelM - SEA_BELOW_M)
        sea++
      } else if (c === COAST_CLASS.wetSand) {
        expect(res.u[i]).toBeGreaterThan(-WET_BAND_M)
        wet++
      } else if (c === COAST_CLASS.sand && !res.masks.patch[i]) {
        expect(res.u[i]).toBeLessThanOrEqual(-WET_BAND_M)
        dry++
      }
    }
    expect(sea).toBeGreaterThan(1000)
    expect(wet).toBeGreaterThan(1000)
    expect(dry).toBeGreaterThan(1000)
  })

  it('gives every emitted region a synthetic tile and draws sand between the sea and the land', () => {
    const o = coastMinimapOptions(cfg)
    const census = emitCensus(res, cfg, EXPORT, () => true)
    expect(census.emitted.length).toBeGreaterThan(8)
    const col = coastMapColours(cfg)
    const isSand = (p: number[]) => [col.sand, col.wetSand].some(s => [0, 1, 2].every(k => Math.abs(p[k]! - s[k]!) <= 0.25 * s[k]! + 6))
    const isSea = (p: number[]) => p[2]! > p[0]! + 20
    let shores = 0
    const regions = [
      ...census.emitted.map(e => ({ ...e, retail: false })),
      ...[12, 16].flatMap(x => [12, 13, 14, 15, 16].map(z => ({ x, z, retail: true }))),
    ]
    for (const { x, z, retail: hasRetail } of regions) {
      const base = hasRetail ? { width: S, height: S, rgba: new Uint8Array(S * S * 4).fill(90) } : null
      const t = coastMinimapTile(res, retail, x, z, base, o)!
      expect(t.kind).toBe(hasRetail ? 'composite' : 'synthetic')
      let sea = 0
      let sand = 0
      for (let p = 0; p < S * S; p++) {
        const v = [...t.rgba.subarray(p * 4, p * 4 + 3)]
        if (isSea(v)) sea++
        else if (isSand(v)) sand++
      }
      if (sea > 500 && sea < S * S - 500) {
        shores++
        expect(sand, `region ${x},${z}: ${sea} sea px`).toBeGreaterThan(300)
      }
    }
    expect(shores).toBeGreaterThan(6)
  })

  it('changes only ring and synthetic regions, never a frozen playable one', () => {
    for (let x = PLAY.x0 + 1; x < PLAY.x1; x++) {
      for (let z = PLAY.z0 + 1; z < PLAY.z1; z++) {
        const v = changedVertices(res, retail, x, z)!
        expect(v.every(b => b === 0)).toBe(true)
      }
    }
    const ring = changedVertices(res, retail, 12, 14)!
    expect(ring.some(b => b === 1)).toBe(true)
    expect(CELLS_PER_REGION + 1).toBe(Math.sqrt(ring.length))
  })
})
