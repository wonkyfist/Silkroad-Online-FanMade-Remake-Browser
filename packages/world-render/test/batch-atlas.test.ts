/**
 * BT-A, the batch atlases (docs/BATCHING.md §3.2, §3.3, §3.13, §6.2 BT-A, F6, F7, F15, Q5; docs/WAVE_PLAN6.md §6.1):
 * - the buddy allocator: allocation and free, no overlap, 1:2 and 1:4 rectangles pack without waste, freed buddies
 *   merge back to a whole page, no page past the limit;
 * - the cell shapes: pow2 rectangles, ≤ 64 texels kept at 2×, pages never exceeded (1024 × 2048 → 512 × 1024), the
 *   gutter max(2, side / 64), the NRAO cell keeping the albedo's inner ratio exactly;
 * - the cell job: the gutter holds the wrapped source, opaque cells are opaque, cutouts keep their coverage, TX-R's
 *   mask goes into the alpha (the prototype's solid leaf cards), the NRAO packing, the lightmap quadrants and layers,
 *   a failed source falls back instead of failing;
 * - the table's half floats: every 1/1024 offset and every cell scale exact, rows round-trip;
 * - the arrays: one cell for two glbs' identical texture, reference counts and the grace time, eviction before a
 *   growth, no array above 256 layers (a spill opens the next one, or the cell is refused);
 * - the lightmap array: 184 layers for jangan-fields, the white quadrant at layer 0, bilinear taps at UV 0.03 / 0.97
 *   stay inside their quadrant at both levels.
 */
import { NullEngine, Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ATLAS_LEVELS,
  ATLAS_PAGE,
  ArrayTexture,
  AtlasArrays,
  CELL_MIN,
  CellAllocator,
  CellWorkers,
  cellWorkerCount,
  MAX_ARRAY_LAYERS,
  cellShape,
  cellTexel,
  encodedSize,
  gutterOf,
  hashBytes,
  inlineCellDecoder,
  nraoShape,
  parseMapKey,
  sniffMime,
  type CellBlock,
  type CellJob,
} from '../src/batch/atlas.ts'
import {
  LIGHTMAP_LEVELS,
  LIGHTMAP_PAGE,
  LightmapArray,
  WHITE_LIGHTMAP,
  bilinearTaps,
  lightmapLayers,
  placementOf,
  remapUv2,
} from '../src/batch/lightmaps.ts'
import { TABLE_TEXELS, decodeRow, encodeRow, fromHalf, toHalf, type SlotRow } from '../src/batch/table.ts'
import { coverage, runCellJob, type CellDecoders, type Level } from '../src/pbr/decode-core.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function nullScene(): Scene {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

/** Deterministic pseudo-random bytes. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function image(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): Level {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4)
  return { width: w, height: h, data }
}

const px = (l: Level, x: number, y: number) => Array.from(l.data.subarray((y * l.width + x) * 4, (y * l.width + x) * 4 + 4))

/** Decoders over an in-memory table of images ('fail' URLs throw). */
function decoders(images: Record<string, Level> = {}): CellDecoders {
  return {
    url: async url => {
      const img = images[url]
      if (!img) throw new Error(`404 ${url}`)
      return img
    },
    bytes: async bytes => {
      const img = images[`bytes:${bytes[0]}`]
      if (!img) throw new Error('undecodable bytes')
      return img
    },
  }
}

function overlaps(a: CellBlock, b: CellBlock): boolean {
  return a.page === b.page && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

// ---- the allocator ------------------------------------------------------------------------------------------------

describe('the cell allocator (rectangular pow2 buddies)', () => {
  it('allocates and frees without overlap, inside the page, under random churn', () => {
    const alloc = new CellAllocator(256, 64)
    const r = rng(7)
    const live: CellBlock[] = []
    const sides = [32, 64, 128, 256]
    for (let i = 0; i < 3000; i++) {
      if (live.length && r() < 0.45) {
        const k = Math.floor(r() * live.length)
        alloc.release(live[k]!)
        live.splice(k, 1)
        continue
      }
      const w = sides[Math.floor(r() * 3)]!
      const h = sides[Math.floor(r() * 3)]!
      const b = alloc.alloc(w, h)
      expect(b).not.toBeNull()
      expect([b!.w, b!.h]).toEqual([w, h])
      expect(b!.x % w).toBe(0)
      expect(b!.y % h).toBe(0)
      expect(b!.x + w).toBeLessThanOrEqual(256)
      expect(b!.y + h).toBeLessThanOrEqual(256)
      live.push(b!)
    }
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) expect(overlaps(live[i]!, live[j]!)).toBe(false)
    expect(alloc.usedTexels).toBe(live.reduce((n, b) => n + b.w * b.h, 0))
    expect(alloc.blocks).toBe(live.length)
  })

  it('packs 1:2 and 1:4 rectangles without waste: one shape fills whole pages, a random mix wastes less than a page', () => {
    for (const [w, h] of [[128, 256], [64, 256], [256, 1024], [512, 128]] as const) {
      const alloc = new CellAllocator(1024, 64)
      const n = (3 * 1024 * 1024) / (w * h)
      for (let i = 0; i < n; i++) expect(alloc.alloc(w, h)).not.toBeNull()
      expect([alloc.pages, alloc.fill]).toEqual([3, 1])
    }
    const mixes = [[[128, 256], [64, 512], [256, 128]], [[32, 128], [64, 128], [128, 32], [256, 64]], [[128, 256], [128, 512], [256, 512], [64, 256], [128, 128]]]
    for (const shapes of mixes) {
      const alloc = new CellAllocator(1024, 256)
      const r = rng(shapes.length * 13)
      let used = 0
      for (let i = 0; i < 1500; i++) {
        const [w, h] = shapes[Math.floor(r() * shapes.length)]!
        expect(alloc.alloc(w!, h!)).not.toBeNull()
        used += w! * h!
      }
      // Square cells would take ~2× these texels (F6); the buddies leave at most the last page partly empty.
      expect(alloc.pages).toBe(Math.ceil(used / (1024 * 1024)))
      expect(alloc.usedTexels).toBe(used)
    }
  })

  it('freed buddies merge back into the whole page, which the next large request reuses', () => {
    const alloc = new CellAllocator(512, 4)
    const blocks = Array.from({ length: 16 }, (_, i) => alloc.alloc(i % 2 ? 64 : 128, i % 2 ? 128 : 64)!)
    expect(alloc.pages).toBe(1)
    for (const b of blocks) alloc.release(b)
    expect(alloc.usedTexels).toBe(0)
    const whole = alloc.alloc(512, 512)!
    expect([whole.page, whole.x, whole.y]).toEqual([0, 0, 0])
    expect(alloc.pages).toBe(1)
    alloc.release(whole)
    alloc.release(whole) // twice: ignored
    expect(alloc.blocks).toBe(0)
  })

  it('adds a page only when nothing fits, never past maxPages, and prefers the lowest page', () => {
    const alloc = new CellAllocator(128, 3)
    const a = [alloc.alloc(128, 128), alloc.alloc(128, 128), alloc.alloc(128, 128)]
    expect(a.map(b => b!.page)).toEqual([0, 1, 2])
    expect(alloc.alloc(32, 32)).toBeNull()
    expect(alloc.alloc(32, 32, false)).toBeNull()
    alloc.release(a[1]!)
    alloc.release(a[2]!)
    expect(alloc.alloc(64, 32)!.page).toBe(1)
    expect(() => alloc.alloc(48, 32)).toThrow(/power of two/)
  })
})

// ---- the shapes ---------------------------------------------------------------------------------------------------

describe('cell shapes (F6, F15, Q5)', () => {
  it('rounds each side up to a power of two, keeps ≤ 64-texel sides at 2×, never below 32, halves what the page cannot hold', () => {
    const s = (w: number, h: number) => {
      const c = cellShape(w, h, ATLAS_PAGE, ATLAS_LEVELS)
      return [c.width, c.height, c.gutterX, c.gutterY]
    }
    expect(s(128, 512)).toEqual([128, 512, 2, 8])
    expect(s(256, 256)).toEqual([256, 256, 4, 4])
    expect(s(200, 100)).toEqual([256, 128, 4, 2])
    expect(s(64, 256)).toEqual([128, 256, 2, 4])
    expect(s(32, 32)).toEqual([64, 64, 2, 2])
    expect(s(4, 4)).toEqual([CELL_MIN, CELL_MIN, 2, 2])
    expect(s(1024, 2048)).toEqual([512, 1024, 8, 16])
    expect(s(2048, 2048)).toEqual([1024, 1024, 16, 16])
    // No small texture loses resolution to its gutter; a large one loses 3.1 % per side.
    for (const side of [1, 2, 8, 16, 32, 48, 64]) {
      const c = cellShape(side, side, ATLAS_PAGE, ATLAS_LEVELS)
      expect(c.width - 2 * c.gutterX).toBeGreaterThanOrEqual(side)
    }
    for (const side of [128, 256, 512, 1024]) {
      const c = cellShape(side, side, ATLAS_PAGE, ATLAS_LEVELS)
      expect(1 - (c.width - 2 * c.gutterX) / side).toBeCloseTo(1 / 32, 6)
    }
    expect(gutterOf(32)).toBe(2)
    expect(gutterOf(1024)).toBe(16)
  })

  it('an atlas page keeps 6 levels: the smallest cell is one texel at the last', () => {
    expect(ATLAS_PAGE).toBe(1024)
    expect(ATLAS_LEVELS).toBe(6)
    expect(CELL_MIN >> (ATLAS_LEVELS - 1)).toBe(1)
  })

  it("the NRAO cell keeps its albedo cell's inner ratio exactly (the shader derives its v scale from it)", () => {
    const sizes = [16, 32, 64, 100, 128, 256, 512, 1024, 2048]
    for (const aw of sizes) {
      for (const ah of sizes) {
        const a = cellShape(aw, ah, ATLAS_PAGE, ATLAS_LEVELS)
        const at = cellTexel({ layer: 0, x: 0, y: 0, shape: a }, ATLAS_PAGE)
        for (const nw of [64, 256, 1024, 4096]) {
          const n = nraoShape(a, nw, nw, ATLAS_PAGE)
          const nt = cellTexel({ layer: 0, x: 0, y: 0, shape: n }, ATLAS_PAGE)
          expect(n.width).toBeLessThanOrEqual(ATLAS_PAGE)
          expect(n.height).toBeLessThanOrEqual(ATLAS_PAGE)
          expect(nt.uScale * (at.vScale / at.uScale)).toBeCloseTo(nt.vScale, 12)
          // Its half-float texels hold that ratio exactly too.
          expect(fromHalf(toHalf(nt.uScale)) * fromHalf(toHalf(at.vScale)) / fromHalf(toHalf(at.uScale))).toBeCloseTo(nt.vScale, 9)
        }
      }
    }
    // Scaled towards the maps' resolution when the albedo cell is large enough.
    expect(nraoShape(cellShape(128, 256, 1024, 6), 1024, 1024, 1024)).toMatchObject({ width: 512, height: 1024 })
    expect(nraoShape(cellShape(512, 512, 1024, 6), 128, 128, 1024)).toMatchObject({ width: 128, height: 128 })
  })
})

// ---- the cell job -------------------------------------------------------------------------------------------------

describe('the cell job (decode-core.ts runCellJob)', () => {
  it('the gutter holds the texture wrapped: with the inner area at the source size every texel is the source at (x − g) mod w', async () => {
    const r = rng(3)
    const src = image(124, 60, () => [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256), 255])
    const shape = { width: 128, height: 64, gutterX: 2, gutterY: 2, levels: 3 }
    const res = await runCellJob({ kind: 'cell-albedo', shape, page: 1024, levels: 3, image: { kind: 'pixels', level: src }, alpha: 'none' }, decoders())
    const cell = res.levels[0]!
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 128; x++) {
        const sx = (((x - 2) % 124) + 124) % 124
        const sy = (((y - 2) % 60) + 60) % 60
        expect(px(cell, x, y)).toEqual(px(src, sx, sy))
      }
    }
    expect(res.levels.map(l => [l.width, l.height])).toEqual([[128, 64], [64, 32], [32, 16]])
    expect(res.source).toEqual({ width: 124, height: 60 })
  })

  it('picks its shape from the decoded size when none is given; opaque cells are opaque', async () => {
    const src = image(128, 512, () => [10, 20, 30, 7])
    const res = await runCellJob({ kind: 'cell-albedo', shape: null, page: ATLAS_PAGE, levels: ATLAS_LEVELS, image: { kind: 'bytes', bytes: new Uint8Array([9]) }, alpha: 'none' }, decoders({ 'bytes:9': src }))
    expect(res.shape).toEqual(cellShape(128, 512, ATLAS_PAGE, ATLAS_LEVELS))
    expect(res.levels.length).toBe(ATLAS_LEVELS)
    expect(res.levels[ATLAS_LEVELS - 1]!.width).toBe(128 >> (ATLAS_LEVELS - 1))
    for (const l of res.levels) for (let i = 3; i < l.data.length; i += 4) expect(l.data[i]).toBe(255)
    expect(src.data[3]).toBe(7) // the source is not modified
  })

  it('cutouts keep the level-0 coverage down the cell chain, with no black under transparent texels', async () => {
    const src = image(64, 64, (x, y) => ((x * 7 + y * 3) % 5 === 0 ? [40, 160, 40, 255] : [0, 0, 0, 0]))
    const res = await runCellJob({ kind: 'cell-albedo', shape: null, page: ATLAS_PAGE, levels: ATLAS_LEVELS, image: { kind: 'pixels', level: src }, alpha: 'cutout', cutoff: 0.5 }, decoders())
    const c0 = coverage(res.levels[0]!, 0.5)
    expect(c0).toBeGreaterThan(0.1)
    for (const l of res.levels.slice(1, 4)) expect(Math.abs(coverage(l, 0.5) - c0)).toBeLessThan(0.08)
    const l0 = res.levels[0]!
    let dark = 0
    for (let i = 0; i < l0.data.length; i += 4) if (l0.data[i + 1]! < 60) dark++
    expect(dark).toBe(0)
  })

  it("TX-R's retail mask becomes the cell's alpha (an opaque set albedo on a cut-out: BATCHING §4.5 finding 4)", async () => {
    const albedo = image(32, 32, () => [200, 100, 50, 255])
    const mask = image(16, 16, x => (x < 8 ? [0, 0, 0, 255] : [0, 0, 0, 0]))
    const lumMask = image(16, 16, x => (x < 8 ? [255, 255, 255, 0] : [0, 0, 0, 0]))
    const job = (m: Level, fromRgb: boolean): CellJob => ({
      kind: 'cell-albedo', shape: { width: 32, height: 32, gutterX: 0, gutterY: 0, levels: 1 }, page: 1024, levels: 1,
      image: { kind: 'pixels', level: albedo }, mask: { kind: 'pixels', level: m }, maskFromRgb: fromRgb, alpha: 'cutout', cutoff: 0.5,
    })
    for (const [m, rgb] of [[mask, false], [lumMask, true]] as const) {
      const cell = (await runCellJob(job(m, rgb), decoders())).levels[0]!
      expect(px(cell, 4, 10)[3]).toBe(255)
      expect(px(cell, 28, 10)[3]).toBe(0)
      expect(px(cell, 4, 10).slice(0, 3)).toEqual([200, 100, 50])
    }
  })

  it('NRAO: normal xy with the inversion baked, roughness from ORM G, AO from R only when asked, the mean metal', async () => {
    const normal = image(8, 8, () => [100, 200, 255, 255])
    const orm = image(8, 8, () => [50, 180, 64, 128])
    const shape = { width: 8, height: 8, gutterX: 0, gutterY: 0, levels: 2 }
    const d = decoders({ n: normal, o: orm })
    const a = await runCellJob({ kind: 'cell-nrao', shape, normal: { kind: 'url', url: 'n' }, orm: { kind: 'url', url: 'o' }, invertX: true, aoFromRed: true, roughness: 0.3 }, d)
    expect(px(a.levels[0]!, 3, 3)).toEqual([155, 200, 180, 50])
    expect(a.mean).toEqual([50, 180, 64, 128])
    const b = await runCellJob({ kind: 'cell-nrao', shape, normal: { kind: 'url', url: 'n' }, invertY: true, roughness: 0.3 }, d)
    expect(px(b.levels[0]!, 3, 3)).toEqual([100, 55, 77, 255])
    const c = await runCellJob({ kind: 'cell-nrao', shape, orm: { kind: 'url', url: 'o' }, aoFromRed: false, roughness: 0.3 }, d)
    expect(px(c.levels[0]!, 3, 3)).toEqual([128, 128, 180, 255])
    expect(a.levels[1]!.width).toBe(4)
    // A broken map counts as absent when the job is tolerant, and fails the cell otherwise.
    const t = await runCellJob({ kind: 'cell-nrao', shape, normal: { kind: 'url', url: 'fail' }, orm: { kind: 'url', url: 'o' }, roughness: 0.3, tolerant: true }, d)
    expect(t.fallback).toBe(true)
    expect(px(t.levels[0]!, 0, 0).slice(0, 3)).toEqual([128, 128, 180])
    await expect(runCellJob({ kind: 'cell-nrao', shape, normal: { kind: 'url', url: 'fail' }, roughness: 0.3 }, d)).rejects.toThrow(/404/)
  })

  it('lightmaps: ≤ 128 into a quadrant (64² upsampled), 256² a layer, 512² box-reduced to a layer; 2 levels, clamped', async () => {
    const lm = (s: number) => image(s, s, (x, y) => [x % 256, y % 256, 90, 255])
    const run = (s: number) => runCellJob({ kind: 'cell-lightmap', shape: null, page: LIGHTMAP_PAGE, levels: LIGHTMAP_LEVELS, image: { kind: 'pixels', level: lm(s) } }, decoders())
    for (const [s, cell] of [[64, 128], [128, 128], [256, 256], [512, 256]] as const) {
      const r = await run(s)
      expect([r.shape.width, r.shape.gutterX, r.levels.length]).toEqual([cell, 0, 2])
      expect(r.levels[1]!.width).toBe(cell / 2)
    }
    const same = await run(128)
    expect(px(same.levels[0]!, 17, 40)).toEqual([17, 40, 90, 255])
  })

  it('a source that fails to decode falls back to the colour the job gives (albedo, lightmap)', async () => {
    const a = await runCellJob({ kind: 'cell-albedo', shape: null, page: 1024, levels: 6, image: { kind: 'url', url: 'fail' }, alpha: 'none', fallback: [150, 150, 150, 255] }, decoders())
    expect(a.fallback).toBe(true)
    expect(a.shape.width).toBe(CELL_MIN)
    expect(px(a.levels[0]!, 5, 5)).toEqual([150, 150, 150, 255])
    const l = await runCellJob({ kind: 'cell-lightmap', shape: null, page: 256, levels: 2, image: { kind: 'url', url: 'fail' }, fallback: [255, 255, 255, 255] }, decoders())
    expect(px(l.levels[0]!, 0, 0)).toEqual([255, 255, 255, 255])
    await expect(runCellJob({ kind: 'cell-albedo', shape: null, page: 1024, levels: 6, image: { kind: 'url', url: 'fail' }, alpha: 'none' }, decoders())).rejects.toThrow()
  })

  it('a large source is box-reduced before the bilinear (a 1-texel checker averages to grey, it does not alias)', async () => {
    const src = image(1024, 256, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    const shape = { width: 128, height: 64, gutterX: 2, gutterY: 2, levels: 1 }
    const cell = (await runCellJob({ kind: 'cell-albedo', shape, page: 1024, levels: 1, image: { kind: 'pixels', level: src }, alpha: 'none' }, decoders())).levels[0]!
    for (let i = 0; i < cell.data.length; i += 4) expect(Math.abs(cell.data[i]! - 128)).toBeLessThanOrEqual(2)
  })
})

// ---- the table's numbers ------------------------------------------------------------------------------------------

describe('the material table encoding (RGBA16F, 6 texels)', () => {
  it('holds every 1/1024 offset, every pow2 scale and every gutter-shrunk cell scale exactly', () => {
    for (let k = 0; k < 1024; k++) expect(fromHalf(toHalf(k / 1024))).toBe(k / 1024)
    for (let n = 0; n <= 10; n++) expect(fromHalf(toHalf(2 ** -n))).toBe(2 ** -n)
    for (const side of [32, 64, 128, 256, 512, 1024]) {
      const inner = (side - 2 * gutterOf(side)) / 1024
      expect(fromHalf(toHalf(inner))).toBe(inner)
    }
    for (let layer = 0; layer <= 256; layer++) expect(fromHalf(toHalf(layer))).toBe(layer)
    expect(fromHalf(toHalf(-1))).toBe(-1)
    expect(fromHalf(toHalf(0.8))).toBeCloseTo(0.8, 3)
    expect(fromHalf(toHalf(1e6))).toBe(Infinity)
    expect(Number.isNaN(fromHalf(toHalf(NaN)))).toBe(true)
  })

  it('a row round-trips (the values the shader reads)', () => {
    const row: SlotRow = {
      albedo: [3, 0.25, 0.126953125, 0.12109375],
      nrao: [-1, 0, 0, 0],
      surf: [0.1, 0.5, 0.25, 1],
      params: [0.25, 0.75, 1.5, 7],
      misc: [0.8, 1, 0.5, 0.2421875],
      emissive: [1.5, 0.75, 0.25, 1],
    }
    const data = new Uint16Array(3 * TABLE_TEXELS * 4)
    encodeRow(row, data, 2)
    const back = decodeRow(data, 2)
    for (const k of Object.keys(row) as Array<keyof SlotRow>) for (let c = 0; c < 4; c++) expect(back[k][c]).toBeCloseTo(row[k][c]!, 3)
    expect(back.albedo).toEqual(row.albedo)
    expect(Array.from(data.subarray(0, 2 * TABLE_TEXELS * 4)).every(v => v === 0)).toBe(true)
  })
})

// ---- the arrays -----------------------------------------------------------------------------------------------------

describe('atlas arrays (dedupe, references, spill, ≤ 256 layers)', () => {
  const solid = (key: string, w = 64, h = 64, page = 256) => ({
    key,
    shape: cellShape(w, h, page, 1),
    job: (shape: ReturnType<typeof cellShape> | null): CellJob => ({ kind: 'cell-albedo', shape, page, levels: 1, image: { kind: 'solid', rgba: [1, 2, 3, 255] }, alpha: 'none' }),
  })

  it("one cell for two glbs' identical texture; references count; unused cells wait out the grace time", async () => {
    let now = 0
    const decoded: string[] = []
    const dec = inlineCellDecoder(decoders())
    const atlas = new AtlasArrays(nullScene(), {
      name: 't', page: 256, levels: 3, graceS: 10, now: () => now,
      decoder: { run: job => (decoded.push(job.kind), dec.run(job)) },
    })
    const a = atlas.acquire(solid('tex|prim/mtrl/wall.ddj'))
    const b = atlas.acquire(solid('tex|prim/mtrl/wall.ddj'))
    expect(a.cell).toBe(b.cell)
    expect(atlas.cells).toBe(1)
    expect(atlas.refs('tex|prim/mtrl/wall.ddj')).toBe(2)
    await Promise.all([a.ready, b.ready])
    expect(decoded).toEqual(['cell-albedo'])
    a.release()
    a.release()
    expect(atlas.unusedCells).toBe(0)
    b.release()
    expect(atlas.unusedCells).toBe(1)
    now = 5000
    expect(atlas.update()).toBe(0)
    const c = atlas.acquire(solid('tex|prim/mtrl/wall.ddj'))
    await c.ready
    expect(decoded.length).toBe(1) // back within the grace time: nothing decoded again
    c.release()
    now = 20000
    expect(atlas.update()).toBe(1)
    expect(atlas.cells).toBe(0)
  })

  it('evicts unused cells before adding a page', async () => {
    const atlas = new AtlasArrays(nullScene(), { name: 't', page: 256, levels: 3, decoder: inlineCellDecoder(decoders()), graceS: 1e6 })
    const first = Array.from({ length: 4 }, (_, i) => atlas.acquire(solid(`k${i}`, 128, 128)))
    await Promise.all(first.map(c => c.ready))
    expect(atlas.pages).toBe(1)
    for (const c of first) c.release()
    const next = atlas.acquire(solid('other', 128, 128))
    await next.ready
    expect(atlas.pages).toBe(1)
    expect(atlas.stats.evicted).toBe(1)
  })

  it('never holds more than maxLayers layers in an array: the next page spills into a new array, or fails with maxArrays 1', async () => {
    expect(MAX_ARRAY_LAYERS).toBe(256)
    const scene = nullScene()
    const spill = new AtlasArrays(scene, { name: 's', page: 64, levels: 1, maxLayers: 4, decoder: inlineCellDecoder(decoders()) })
    const claims = Array.from({ length: 9 }, (_, i) => spill.acquire(solid(`s${i}`, 64, 64, 64)))
    await Promise.all(claims.map(c => c.ready))
    expect(spill.layersPerArray).toEqual([4, 4, 1])
    expect(claims.map(c => c.cell!.array)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2])
    const capped = new AtlasArrays(scene, { name: 'c', page: 64, levels: 1, maxLayers: 2, maxArrays: 1, decoder: inlineCellDecoder(decoders()) })
    const ok = [capped.acquire(solid('a', 64, 64, 64)), capped.acquire(solid('b', 64, 64, 64))]
    const refused = capped.acquire(solid('c', 64, 64, 64))
    expect(ok.every(c => !c.failed)).toBe(true)
    expect(refused.failed).toBe(true)
    await expect(refused.placed).rejects.toThrow(/no room/)
    expect(capped.layersPerArray).toEqual([2])
    // A shape the page cannot hold fails its claim (it never throws out of acquire).
    const odd = capped.acquire({ key: 'odd', shape: { width: 128, height: 128, gutterX: 2, gutterY: 2, levels: 1 }, job: () => { throw new Error('never') } })
    expect(odd.failed).toBe(true)
    // The default: 256 layers of 1024² pages per array.
    const def = new AtlasArrays(scene, { name: 'd', page: ATLAS_PAGE, levels: ATLAS_LEVELS, decoder: inlineCellDecoder(decoders()) })
    expect(def.maxLayers).toBe(256)
  })

  it('a cell whose size is unknown is placed after its decode; the texel is its inner area', async () => {
    const atlas = new AtlasArrays(nullScene(), { name: 't', page: 1024, levels: 6, decoder: inlineCellDecoder(decoders({ 'bytes:1': image(128, 512, () => [9, 9, 9, 255]) })) })
    const c = atlas.acquire({ key: 'x', shape: null, job: shape => ({ kind: 'cell-albedo', shape, page: 1024, levels: 6, image: { kind: 'bytes', bytes: new Uint8Array([1]) }, alpha: 'none' }) })
    expect(c.cell).toBeNull()
    const cell = await c.placed
    expect([cell.shape.width, cell.shape.height]).toEqual([128, 512])
    const t = cellTexel(cell, 1024)
    expect(t).toEqual({ layer: 0, u0: (cell.x + 2) / 1024, v0: (cell.y + 8) / 1024, uScale: 124 / 1024, vScale: 496 / 1024 })
    await c.ready
  })

  it('the upload is split into jobs of at most jobBytes, run through the caller queue; the cell is ready after the last', async () => {
    const jobs: Array<() => void> = []
    const atlas = new AtlasArrays(nullScene(), {
      name: 't', page: 1024, levels: 6, jobBytes: 64 * 1024, job: run => jobs.push(run),
      decoder: inlineCellDecoder(decoders({ 'bytes:2': image(512, 512, () => [1, 1, 1, 255]) })),
    })
    const c = atlas.acquire({ key: 'big', shape: cellShape(512, 512, 1024, 6), job: shape => ({ kind: 'cell-albedo', shape, page: 1024, levels: 6, image: { kind: 'bytes', bytes: new Uint8Array([2]) }, alpha: 'none' }) })
    let ready = false
    void c.ready.then(() => (ready = true))
    await c.placed
    await new Promise(r => setTimeout(r, 0))
    let n = 0
    while (jobs.length) {
      jobs.shift()!()
      n++
      await Promise.resolve()
    }
    await new Promise(r => setTimeout(r, 0))
    expect(ready).toBe(true)
    // 512² level 0 = 1 MiB → 16 jobs of 64 KiB; the other levels (≈ 340 KiB) a few more.
    expect(n).toBeGreaterThanOrEqual(20)
    expect(atlas.stats.uploads).toBe(n)
  })

  it('an array grows with 25 % headroom (whole 4-layer steps), never past maxLayers, and tells its binders', () => {
    const scene = nullScene()
    const arr = new ArrayTexture(scene, 64, 1, 'g', 4, 256)
    const seen: number[] = []
    arr.onChanged.add(() => seen.push(arr.capacity))
    expect(arr.ensure(3)).toBe(true)
    expect(arr.capacity).toBe(4)
    const first = arr.texture
    for (const [need, cap] of [[5, 8], [8, 8], [9, 12], [21, 28], [180, 228], [240, 256], [256, 256]] as const) {
      arr.ensure(need)
      expect(arr.capacity).toBe(cap)
    }
    expect(seen).toEqual([8, 12, 28, 228, 256])
    expect(arr.texture).not.toBe(first)
    expect(first.getInternalTexture()).toBeNull()
    expect(() => arr.ensure(257)).toThrow(/257 layers/)
    expect(arr.bytes).toBe(256 * 64 * 64 * 4)
    arr.dispose()
  })

  it('uses 2 cell workers, up to 4 where the cores are (the map decoder and the merge worker run too)', () => {
    expect([2, 4, 8, 12, 16, 32].map(c => cellWorkerCount(c))).toEqual([2, 2, 2, 4, 4, 4])
  })

  it('the pool decodes on the main thread where no Worker exists (Node, headless)', async () => {
    const pool = new CellWorkers(2, decoders())
    const r = await pool.run({ kind: 'cell-albedo', shape: null, page: 1024, levels: 6, image: { kind: 'solid', rgba: [1, 2, 3, 4] }, alpha: 'none' })
    expect(r.shape.width).toBe(CELL_MIN)
    expect(pool.counts).toEqual({ worker: 0, main: 1 })
  })
})

// ---- the lightmap array ---------------------------------------------------------------------------------------------

describe('the lightmap array (one 256²-layer array, quadrants, F7)', () => {
  it('jangan-fields needs 184 layers (490 × 128², 51 × 256², 35 × 64², 1 × 512² and the white quadrant)', () => {
    const sizes = [...Array(490).fill(128), ...Array(51).fill(256), ...Array(35).fill(64), 512]
    expect(lightmapLayers(sizes)).toBe(184)
    expect(lightmapLayers(sizes)).toBeLessThanOrEqual(MAX_ARRAY_LAYERS)
    expect(lightmapLayers([])).toBe(1)
  })

  it('the white quadrant is layer 0 at (0, 0); quadrants and layers are placed as their size says', async () => {
    const lm = new LightmapArray(nullScene(), { decoder: inlineCellDecoder(decoders({ a: image(128, 128, () => [1, 1, 1, 255]), b: image(256, 256, () => [2, 2, 2, 255]) })) })
    lm.textureOf(0)
    const a = lm.acquire('lightmaps/a.webp', 128, () => ({ kind: 'url', url: 'a' }))
    const b = lm.acquire('lightmaps/b.webp', 256, () => ({ kind: 'url', url: 'b' }))
    const [pa, pb] = await Promise.all([a.ready, b.ready])
    expect(pa.scale).toBe(0.5)
    expect(pa.layer).toBe(0)
    expect([pa.u0, pa.v0]).not.toEqual([WHITE_LIGHTMAP.u0, WHITE_LIGHTMAP.v0])
    expect(pb).toMatchObject({ layer: 1, u0: 0, v0: 0, scale: 1 })
    expect(a.placement).toEqual(pa)
    expect(lm.atlas.pages).toBe(2)
    const white = lm.atlas.acquire({ key: 'lm|white', shape: null, job: () => { throw new Error('resident') } })
    const cell = await white.placed
    expect(placementOf(cell)).toEqual(WHITE_LIGHTMAP)
    const uv = remapUv2([0.03, 0.97, 0.5, 0.5], pa)
    expect(uv[0]).toBeCloseTo(pa.u0 + 0.015, 9)
    expect(uv[3]).toBeCloseTo(pa.v0 + 0.25, 9)
  })

  it('a bilinear tap at UV 0.03 or 0.97 stays inside its quadrant at level 0 and level 1', () => {
    for (const q of [0, 1, 2, 3]) {
      const origin = [(q & 1) * 0.5, (q >> 1) * 0.5]
      for (let level = 0; level < LIGHTMAP_LEVELS; level++) {
        const size = LIGHTMAP_PAGE >> level
        for (const axis of [0, 1]) {
          const lo = origin[axis]! * size
          const hi = lo + size / 2 - 1
          for (const u of [0.03, 0.97]) {
            const [t0, t1] = bilinearTaps(u, origin[axis]!, 0.5, level)
            expect(t0).toBeGreaterThanOrEqual(lo)
            expect(t1).toBeLessThanOrEqual(hi)
          }
        }
      }
    }
  })
})

// ---- sources ----------------------------------------------------------------------------------------------------------

describe('sources', () => {
  it("rebuilds TX-R's map jobs from its cache keys (KTX2 URL textures have none)", () => {
    expect(parseMapKey('m|s|i|http://x/pbr/a/albedo@512.webp|cutout|0.4')).toEqual({ kind: 'image', url: 'http://x/pbr/a/albedo@512.webp', alpha: 'cutout', cutoff: 0.4 })
    expect(parseMapKey('m|s|i|http://x/a.webp|none|')).toEqual({ kind: 'image', url: 'http://x/a.webp', alpha: 'none' })
    expect(parseMapKey('m|l|i|http://x/n.webp')).toEqual({ kind: 'image', url: 'http://x/n.webp' })
    expect(parseMapKey('m|l|n|u/nx.webp|u/ny.webp')).toEqual({ kind: 'normal', nx: 'u/nx.webp', ny: 'u/ny.webp' })
    expect(parseMapKey('m|l|o|u/ao.webp|u/r.webp||u/h.webp|0.7|0')).toEqual({ kind: 'ormh', ao: 'u/ao.webp', rough: 'u/r.webp', height: 'u/h.webp', defaults: { roughness: 0.7, metallic: 0 } })
    expect(parseMapKey('s|http://x/a.ktx2')).toBeNull()
    expect(parseMapKey('m|s|i|http://x/a.ktx2|none|')).toBeNull()
    expect(parseMapKey('p|packed')).toBeNull()
  })

  it('reads the pixel size an encoded image declares (WebP VP8 / VP8L / VP8X, PNG, JPEG) and sniffs its type', () => {
    const riff = (fourcc: string, body: number[]) => {
      const b = new Uint8Array(40)
      b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0)
      b.set([...fourcc].map(c => c.charCodeAt(0)), 12)
      b.set(body, 16)
      return b
    }
    // VP8: width/height at 26/28 (14 bits).
    const vp8 = riff('VP8 ', [])
    vp8.set([0x80, 0x00, 0x00, 0x02], 26)
    expect(encodedSize(vp8)).toEqual({ width: 128, height: 512 })
    // VP8L: 14-bit (w − 1), (h − 1) packed after the signature byte at 20.
    const vp8l = riff('VP8L', [])
    const x = (256 - 1) | ((64 - 1) << 14)
    vp8l.set([x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff], 21)
    expect(encodedSize(vp8l)).toEqual({ width: 256, height: 64 })
    const vp8x = riff('VP8X', [])
    vp8x.set([0xff, 0x03, 0x00, 0x7f, 0x00, 0x00], 24)
    expect(encodedSize(vp8x)).toEqual({ width: 1024, height: 128 })
    expect(sniffMime(vp8x)).toBe('image/webp')
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 64])
    expect(encodedSize(png)).toEqual({ width: 256, height: 64 })
    expect(sniffMime(png)).toBe('image/png')
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 32, 0, 128, 3, 0, 0, 0])
    expect(encodedSize(jpg)).toEqual({ width: 128, height: 32 })
    expect(sniffMime(jpg)).toBe('image/jpeg')
    expect(encodedSize(new Uint8Array(40))).toBeNull()
    expect(hashBytes(png)).toBe(hashBytes(png.slice()))
    expect(hashBytes(png)).not.toBe(hashBytes(jpg))
  })
})
