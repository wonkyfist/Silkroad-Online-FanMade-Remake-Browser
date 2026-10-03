/**
 * TP-E encode, index and review (docs/WAVE_PLAN3.md §7.1 TP-E, docs/TEXPIPE.md §6.1–6.2, §7.4, §10 TP-E):
 * index validation; every file the index names exists; tier sizes (retail/1024/2048 ≤ master, maps at half size);
 * the nx/ny planes rebuild unit normals within 0.02; q90 planes stay under 2° mean error on the real test set,
 * excluding sources ≤ 64 px (skips without the TP-P masters). Plus the cache, the status modes, the index merge and
 * repair, the optional KTX2 output (skips without basisu) and the review page and its local server.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import {
  areaResize, cutoutMips, decodePlane, encodeSet, normalError, normalPlanes, normalsAt, normalsFromRgb, PLANE_WEBP, readMasterInfo,
  rebuildNormals, renormalize, tier2xEdge, tierPlan, TINY_SOURCE, webp, type EncodeEntry, type EncodeOptions,
} from '../src/encode.ts'
import { keyPath, validatePbrIndex, type PbrSet, type TexpipeOverrides } from '../src/format.ts'
import { indexTotals, mergeIndex, missingFiles, readPbrIndex, remasterShadows, repairIndex, writePbrIndex } from '../src/index-writer.ts'
import { REPO_ROOT, TEST_SET, type InventoryEntry } from '../src/inventory.ts'
import { img, roll, type Img } from '../src/pbr/image.ts'
import { encodePng, readImage } from '../src/pbr/io.ts'
import { applyReviewEdit, buildReview, formatOverrides, serveReview } from '../src/review.ts'
import { coverage } from '../src/upscale/alpha.ts'

const tmp = mkdtempSync(join(tmpdir(), 'sro-tpe-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** Deterministic noise in 0..1. */
function noise(n: number, seed: number): Float32Array {
  let s = seed >>> 0
  return Float32Array.from({ length: n }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  })
}

/** Unit normals of a bumpy height field. */
function bumpyNormals(w: number, h: number, seed = 3): Img {
  const n = img(w, h, 3)
  const r = noise(w * h * 2, seed)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      // smooth bumps (slopes to ~70°), fine noise, and one steep ridge past the plane clamp (NORMAL_XY_MAX)
      const ridge = Math.abs(x - w / 2) < 2 ? 6 : 0
      const gx = 1.5 * Math.sin((x / w) * Math.PI * 6) + (r[p * 2]! - 0.5) * 0.5 + ridge
      const gy = 1.5 * Math.cos((y / h) * Math.PI * 4) + (r[p * 2 + 1]! - 0.5) * 0.5
      n.d[p * 3] = -gx
      n.d[p * 3 + 1] = -gy
      n.d[p * 3 + 2] = 1
    }
  }
  return renormalize(n)
}

// ---- tiers and resampling -----------------------------------------------------------------------------------------

describe('tiers', () => {
  it('retail size, 1024 and 2048, only those ≤ the master; maps at half the tier', () => {
    const t = tierPlan([512, 512], [2048, 2048])
    expect(t.map(p => p.name)).toEqual(['512', '1024', '2048'])
    expect(t.map(p => p.size)).toEqual([[512, 512], [1024, 1024], [2048, 2048]])
    expect(t.map(p => p.half)).toEqual([[256, 256], [512, 512], [1024, 1024]])
    expect(t.map(p => p.retail)).toEqual([true, false, false])
    // the '2x' tier (High's albedo): min(2 × retail, 1024); for a 512 source it is the 1024 tier
    expect(t.map(p => p.x2)).toEqual([false, true, false])
    // the 64-px roof: master 256×1024, no 2048 tier; the 2x tier is 128×512
    const roof = tierPlan([64, 256], [256, 1024])
    expect(roof.map(p => [p.name, p.size, p.x2])).toEqual([['256', [64, 256], false], ['512', [128, 512], true], ['1024', [256, 1024], false]])
    expect(roof[0]!.half).toEqual([32, 128])
    // a 1024 source: the retail tier is the 1024 tier
    expect(tierPlan([1024, 512], [2048, 1024]).map(p => [p.name, p.size, p.retail])).toEqual([['1024', [1024, 512], true], ['2048', [2048, 1024], false]])
    // a source above the cap has no retail tier (≤ master)
    expect(tierPlan([4096, 4096], [2048, 2048]).map(p => p.name)).toEqual(['1024', '2048'])
    // a master under 1024 ships at its own size too (else its upscale is never used)
    expect(tierPlan([128, 128], [512, 512]).map(p => p.name)).toEqual(['128', '256', '512'])
    expect(tierPlan([384, 192], [1536, 768]).map(p => p.name)).toEqual(['384', '768', '1024', '1536'])
    // the 2x tier never exceeds 1024 nor the master
    expect(tierPlan([1024, 512], [2048, 1024]).find(p => p.x2)!.name).toBe('1024')
    expect(tierPlan([16, 16], [24, 24]).find(p => p.x2)!.name).toBe('24')
    expect(tier2xEdge([256, 128], [1024, 512])).toBe(512)
    // 1×N never goes to 0
    expect(tierPlan([1, 256], [4, 1024])[0]!.half).toEqual([1, 128])
    // never above the master
    for (const t of tierPlan([300, 90], [1200, 360])) expect(Math.max(...t.size)).toBeLessThanOrEqual(1200)
  })

  it('area resize is the exact box mean, keeps the mean on any ratio, and keeps a tile tileable', () => {
    const a = img(8, 4, 1)
    a.d.set(noise(32, 9))
    const b = areaResize(a, 4, 2)
    expect(b.d[0]).toBeCloseTo((a.d[0]! + a.d[1]! + a.d[8]! + a.d[9]!) / 4, 6)
    const mean = (im: Img) => im.d.reduce((s, v) => s + v, 0) / im.d.length
    expect(mean(areaResize(a, 3, 3))).toBeCloseTo(mean(a), 5)
    // tileable: shift-then-resize equals resize-then-shift for a whole-number ratio
    const t = img(64, 32, 1)
    t.d.set(noise(64 * 32, 4))
    const r1 = areaResize(roll(t, 8, 4), 16, 8), r2 = roll(areaResize(t, 16, 8), 2, 1)
    for (let i = 0; i < r1.d.length; i++) expect(r1.d[i]).toBeCloseTo(r2.d[i]!, 6)
  })
})

// ---- normal planes ------------------------------------------------------------------------------------------------

describe('normal planes', () => {
  it('rebuild unit normals within 0.02 after q90 WebP, with < 2° mean error', async () => {
    const n = bumpyNormals(256, 256)
    const { nx, ny } = normalPlanes(n)
    // quantisation alone: z = sqrt(1 - x² - y²) of the bytes is unit length (x² + y² ≤ 1 after renormalising)
    const q = normalError(n, rebuildNormals(nx, ny, 256, 256))
    expect(q.maxLenErr).toBeLessThanOrEqual(0.02)
    expect(q.meanDeg).toBeLessThan(0.5)
    const [bx, by] = await Promise.all([webp({ w: 256, h: 256, c: 1, data: nx }, PLANE_WEBP), webp({ w: 256, h: 256, c: 1, data: ny }, PLANE_WEBP)])
    const [dx, dy] = await Promise.all([decodePlane(bx), decodePlane(by)])
    expect([dx.w, dx.h, dx.c]).toEqual([256, 256, 1])
    const e = normalError(n, rebuildNormals(dx.data, dy.data, 256, 256))
    expect(e.maxLenErr).toBeLessThanOrEqual(0.02)
    expect(e.meanDeg).toBeLessThan(2)
  })

  it('a downsampled normal map is renormalised (a box mean is shorter than 1)', () => {
    const n = normalsAt(bumpyNormals(64, 64), 16, 16)
    for (let p = 0; p < 16 * 16; p++) expect(Math.hypot(n.d[p * 3]!, n.d[p * 3 + 1]!, n.d[p * 3 + 2]!)).toBeCloseTo(1, 5)
  })
})

// ---- a synthetic set, end to end ------------------------------------------------------------------------------------

/** A fake TP-P master folder: RGBA cutout albedo (8-bit), normal and ORMH (16-bit), pbr.json. */
async function fakeMaster(texpipeDir: string, key: string, w: number, h: number, opts: { cutout?: boolean; metal?: boolean; hash?: string } = {}): Promise<void> {
  const dir = join(texpipeDir, 'master', keyPath(key))
  mkdirSync(dir, { recursive: true })
  const r = noise(w * h, 7)
  const alb = img(w, h, 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      alb.d[p * 4] = 0.3 + 0.4 * r[p]!
      alb.d[p * 4 + 1] = 0.5
      alb.d[p * 4 + 2] = 0.2 + 0.2 * Math.sin(x / 7)
      // a blobby leaf mask for the cutout
      alb.d[p * 4 + 3] = opts.cutout ? (Math.hypot(x / w - 0.5, (y / h - 0.5) * 1.3) < 0.25 + 0.12 * Math.sin(x / 5) * Math.cos(y / 4) ? 1 : 0) : 1
    }
  }
  writeFileSync(join(dir, 'albedo.png'), encodePng(alb, 8, opts.cutout ? [0, 1, 2, 3] : [0, 1, 2]))
  const n = bumpyNormals(w, h)
  const rgb = img(w, h, 3)
  for (let i = 0; i < n.d.length; i++) rgb.d[i] = n.d[i]! * 0.5 + 0.5
  writeFileSync(join(dir, 'normal.png'), encodePng(rgb, 16))
  const o = img(w, h, 4)
  for (let p = 0; p < w * h; p++) {
    o.d[p * 4] = 0.8 + 0.2 * r[p]!
    o.d[p * 4 + 1] = 0.6
    o.d[p * 4 + 2] = opts.metal && p % w < w / 2 ? 1 : 0
    o.d[p * 4 + 3] = r[(p * 7) % (w * h)]!
  }
  writeFileSync(join(dir, 'ormh.png'), encodePng(o, 16))
  writeFileSync(join(dir, 'lit.png'), encodePng(alb, 8, [0, 1, 2]))
  writeFileSync(join(dir, 'pbr.json'), JSON.stringify({ key, size: [w, h], hash: opts.hash ?? 'h1', delit: true, albedoOnly: false, tiny: false, profile: 'test', inputKind: 'test' }))
}

const leaf: EncodeEntry = { key: 'prim/mtrl/test/leaf.ddj', group: 'world', size: [256, 128], class: 'foliage', alpha: 'cutout', wrap: [false, false], hero: true }
const tile: EncodeEntry = { key: 'tile2d:c_test_01', group: 'tile', size: [128, 128], class: 'stone', alpha: 'none', wrap: [true, true], hero: false }

describe('encode a set', () => {
  const texpipeDir = join(tmp, 'texpipe')
  const pbrDir = join(tmp, 'out', 'pbr')
  const opts = (o: Partial<EncodeOptions> = {}): EncodeOptions => ({ texpipeDir, pbrDir, ...o })

  it('writes the tiers, sizes right, every file present, a valid index', async () => {
    await fakeMaster(texpipeDir, leaf.key, 1024, 512, { cutout: true, metal: true })
    await fakeMaster(texpipeDir, tile.key, 512, 512)
    const a = await encodeSet(leaf, opts())
    const b = await encodeSet(tile, opts())
    expect(a.error).toBeUndefined()
    expect(b.error).toBeUndefined()
    const s = a.set!
    expect(Object.keys(s.tiers).sort((x, y) => Number(x) - Number(y))).toEqual(['256', '512', '1024'])
    expect(s.tier2x).toBe('512')
    expect(s.size).toEqual([1024, 512])
    expect(s).toMatchObject({ status: 'auto', hero: true, class: 'foliage', alpha: 'cutout', delit: true, source: 'local' })
    expect(Object.keys(b.set!.tiers).sort((x, y) => Number(x) - Number(y))).toEqual(['128', '256', '512'])
    expect(b.set!.tier2x).toBe('256')
    expect(b.set!.detail).toBeUndefined()
    const index = mergeIndex(null, [s, b.set!], { rev: 'test', upscaler: 'lanczos3', createdAt: new Date(0).toISOString() })
    expect(validatePbrIndex(index)).toEqual([])
    expect(missingFiles(index, pbrDir)).toEqual([])
    writePbrIndex(pbrDir, index)
    expect(readPbrIndex(pbrDir)).toEqual(index)
    // tier sizes: albedo, nx, ny, height at the tier size; ao, rough, metal at half
    const masterAlpha = await sharp(readFileSync(join(texpipeDir, 'master', keyPath(leaf.key), 'albedo.png'))).extractChannel(3).raw().toBuffer()
    for (const [name, t] of Object.entries(s.tiers)) {
      const size = async (f: string) => {
        const m = await sharp(readFileSync(join(pbrDir, f))).metadata()
        return [m.width, m.height]
      }
      expect(Math.max(...t.size)).toBe(Number(name))
      for (const f of [t.albedo, t.nx!, t.ny!, t.height!]) expect(await size(f)).toEqual(t.size)
      for (const f of [t.ao!, t.rough!, t.metal!]) expect(await size(f)).toEqual([t.size[0] / 2, t.size[1] / 2])
      expect(t.bytes).toBe([t.albedo, t.nx, t.ny, t.ao, t.rough, t.metal, t.height].reduce((sum, f) => sum + readFileSync(join(pbrDir, f!)).byteLength, 0))
      // the cutout's alpha is lossless and keeps the master's coverage at the cutoff
      const al = await sharp(readFileSync(join(pbrDir, t.albedo))).ensureAlpha().extractChannel(3).raw().toBuffer()
      expect(Math.abs(coverage(new Uint8Array(al)) - coverage(new Uint8Array(masterAlpha)))).toBeLessThan(0.02)
    }
    // no metal anywhere → no metal plane; opaque → no alpha in the albedo
    const t512 = b.set!.tiers['512']!
    expect(t512.metal).toBeUndefined()
    expect((await sharp(readFileSync(join(pbrDir, t512.albedo))).metadata()).hasAlpha).toBe(false)
    expect(indexTotals(index).bytesByTier['1024']).toBe(s.tiers['1024']!.bytes)
  })

  it('reuses the cache; a new master hash re-encodes', async () => {
    const again = await encodeSet(leaf, opts())
    expect(again.skipped).toBe(true)
    expect(again.set!.tiers).toEqual((await encodeSet(leaf, opts())).set!.tiers)
    await fakeMaster(texpipeDir, leaf.key, 1024, 512, { cutout: true, metal: true, hash: 'h2' })
    expect((await encodeSet(leaf, opts())).skipped).toBe(false)
  })

  it('status albedo-only drops the planes; retail ships nothing and keeps a valid record', async () => {
    const o = (status: 'albedo-only' | 'retail' | 'ok'): TexpipeOverrides => ({ format: 'sro-texpipe-overrides', version: 1, sets: { [tile.key]: { status } } })
    const ao = await encodeSet(tile, opts({ overrides: o('albedo-only') }))
    expect(ao.report!.mode).toBe('albedo-only')
    for (const t of Object.values(ao.set!.tiers)) expect(Object.keys(t).sort()).toEqual(['albedo', 'bytes', 'size'])
    expect(existsSync(join(pbrDir, keyPath(tile.key), 'nx@512.webp'))).toBe(false)
    const rt = await encodeSet(tile, opts({ overrides: o('retail') }))
    expect(rt.set).toMatchObject({ status: 'retail', tiers: {}, size: [128, 128] })
    expect(existsSync(join(pbrDir, keyPath(tile.key), 'albedo@512.webp'))).toBe(false)
    const ok = await encodeSet(tile, opts({ overrides: o('ok') }))
    expect(ok.set!.status).toBe('ok')
    expect(ok.set!.tiers['512']!.nx).toBeDefined()
    const index = mergeIndex(null, [rt.set!, ok.set!].slice(1), { rev: 'r', upscaler: 'u', createdAt: 'now' })
    expect(validatePbrIndex(mergeIndex(index, [rt.set!], index.pipeline))).toEqual([])
  })

  it('a missing master is an error, not a set', async () => {
    const r = await encodeSet({ ...tile, key: 'tile2d:c_missing_01' }, opts())
    expect(r.set).toBeNull()
    expect(r.error).toMatch(/no TP-P master/)
  })
})

describe('index merge and repair', () => {
  const set = (key: string, extra: Partial<PbrSet> = {}): PbrSet => ({
    key, size: [4, 4], class: 'default', tiers: { 4: { size: [4, 4], albedo: `${keyPath(key)}/albedo@4.webp`, bytes: 1 } }, alpha: 'none', wrap: [false, false], status: 'auto', hero: false, ...extra,
  })
  const p = { rev: 'r', upscaler: 'u', createdAt: 'now' }

  it('keeps earlier sets, replaces same keys, sorts keys', () => {
    const a = mergeIndex(null, [set('prim/b.ddj'), set('prim/a.ddj')], p)
    expect(Object.keys(a.sets)).toEqual(['prim/a.ddj', 'prim/b.ddj'])
    const b = mergeIndex(a, [set('prim/b.ddj', { status: 'ok' }), set('tile2d:c')], p, ['prim/a.ddj'])
    expect(Object.keys(b.sets)).toEqual(['prim/b.ddj', 'tile2d:c'])
    expect(b.sets['prim/b.ddj']!.status).toBe('ok')
  })

  it('drops sets with missing files and turns an unbacked replaced into retail', () => {
    const dir = join(tmp, 'repair')
    mkdirSync(join(dir, 'prim/a'), { recursive: true })
    writeFileSync(join(dir, 'prim/a/albedo@4.webp'), 'x')
    const idx = mergeIndex(null, [set('prim/a.ddj', { status: 'replaced' }), set('prim/gone.ddj')], p)
    expect(validatePbrIndex(idx).length).toBeGreaterThan(0)
    const w = repairIndex(idx, dir)
    expect(w).toHaveLength(2)
    expect(Object.keys(idx.sets)).toEqual(['prim/a.ddj'])
    expect(idx.sets['prim/a.ddj']!.status).toBe('retail')
    expect(validatePbrIndex(idx)).toEqual([])
    expect(() => writePbrIndex(dir, { ...idx, version: 2 as 1 })).toThrow(/invalid/)
  })

  it('names the sets an sro-remaster entry hides at runtime (D35)', () => {
    const out = join(tmp, 'shadow')
    const idx = mergeIndex(null, [set('prim/mtrl/item/sword1_2_3.ddj'), set('prim/mtrl/char/woman/hair.ddj'), set('prim/mtrl/char/man/hair.ddj'), set('prim/mtrl/item/bow.ddj')], p)
    expect(remasterShadows(idx, out)).toEqual([])
    mkdirSync(join(out, 'remaster'), { recursive: true })
    mkdirSync(join(out, 'char'), { recursive: true })
    // The glb's sidecar says which retail path its image is: only the man's hair, not the woman's with the same stem.
    writeFileSync(join(out, 'char', 'man.json'), JSON.stringify({ materials: [{ texture: 'prim\\mtrl\\char\\man\\hair.ddj' }] }))
    writeFileSync(join(out, 'remaster', 'manifest.json'), JSON.stringify({
      format: 'sro-remaster', version: 1, textures: { 'char/man#hair': {}, 'equipment/sword_01#sword1_2_3': {}, 'nothing#else': {} },
    }))
    const w = remasterShadows(idx, out)
    expect(w).toHaveLength(2)
    expect(w[0]).toMatch(/^prim\/mtrl\/char\/man\/hair\.ddj: hidden at runtime by the sro-remaster entry char\/man#hair/)
    expect(w[1]).toMatch(/^prim\/mtrl\/item\/sword1_2_3\.ddj: .*equipment\/sword_01#sword1_2_3/)
  })
})

describe('cutout mips for KTX2', () => {
  it('halve to 1×1 and keep the level-0 coverage within 2% down to 8 px', () => {
    const w = 256, h = 128
    const data = new Uint8Array(w * h * 4)
    for (let p = 0; p < w * h; p++) {
      const x = p % w, y = Math.floor(p / w)
      data[p * 4] = 200
      // leaves: a blobby mask with thin fingers, which plain box mips thin out
      const r = Math.hypot(x / w - 0.5, (y / h - 0.5) * 0.6)
      data[p * 4 + 3] = r < 0.2 + 0.1 * Math.sin(x / 3) * Math.cos(y / 5) ? 255 : r < 0.21 ? 128 : 0
    }
    const mips = cutoutMips({ w, h, c: 4, data })
    expect(mips.map(m => m.w)).toEqual([256, 128, 64, 32, 16, 8, 4, 2, 1])
    expect(mips[mips.length - 1]!.h).toBe(1)
    const cov = (m: { data: Uint8Array; w: number; h: number }) => coverage(Uint8Array.from({ length: m.w * m.h }, (_, p) => m.data[p * 4 + 3]!))
    for (const m of mips.filter(m => m.w >= 8)) expect(Math.abs(cov(m) - cov(mips[0]!))).toBeLessThan(0.02 + 1 / (m.w * m.h))
    // colour of opaque texels is not darkened by the transparent matte (premultiplied filtering)
    expect(mips[2]!.data[(16 * 64 + 32) * 4]).toBeGreaterThan(190)
  })
})

describe('KTX2 output (skips without basisu)', async () => {
  const { hasBasisu, parseKtx2 } = await import('../src/ktx2.ts')
  it.skipIf(!hasBasisu())('writes albedo, normal and ORMH KTX2 at the set size; a cutout keeps its mip chain', async () => {
    const texpipeDir = join(tmp, 'k-texpipe'), pbrDir = join(tmp, 'k-out', 'pbr')
    const e = { ...leaf, size: [64, 32] as [number, number] }
    await fakeMaster(texpipeDir, e.key, 256, 128, { cutout: true })
    const r = await encodeSet(e, { texpipeDir, pbrDir, ktx2: true })
    expect(r.error).toBeUndefined()
    expect(r.set!.albedo).toBe(`${keyPath(e.key)}/albedo@256.ktx2`)
    for (const f of [r.set!.albedo!, r.set!.normal!, r.set!.ormh!]) {
      const k = parseKtx2(readFileSync(join(pbrDir, f)))
      expect([k.width, k.height, k.levels.length]).toEqual([256, 128, 9])
    }
    // a later run without --ktx2 keeps the KTX2 files while the master is unchanged
    const again = await encodeSet(e, { texpipeDir, pbrDir })
    expect(again.skipped).toBe(true)
    expect(again.set!.albedo).toBe(r.set!.albedo)
    expect(validatePbrIndex(mergeIndex(null, [again.set!], { rev: 'r', upscaler: 'u', createdAt: 'now' }))).toEqual([])
  })
})

// ---- review -------------------------------------------------------------------------------------------------------------

describe('review page', () => {
  it('status edits: auto removes the field, an empty entry disappears, bad statuses throw', () => {
    const a = applyReviewEdit(null, 'tile2d:c_x', { status: 'ok', note: ' good ' })
    expect(a.sets['tile2d:c_x']).toEqual({ status: 'ok', note: 'good' })
    const b = applyReviewEdit(a, 'tile2d:c_x', { status: 'auto' })
    expect(b.sets['tile2d:c_x']).toEqual({ note: 'good' })
    expect(applyReviewEdit(b, 'tile2d:c_x', { note: '' }).sets).toEqual({})
    expect(a.sets['tile2d:c_x']!.status).toBe('ok') // the input is not mutated
    expect(() => applyReviewEdit(null, 'tile2d:c_x', { status: 'replaced' })).toThrow()
    expect(() => applyReviewEdit(null, 'Bad Key', { status: 'ok' })).toThrow()
    expect(formatOverrides(a).endsWith('}\n')).toBe(true)
  })

  it('builds a card per texture with the images, a status marker and a safe data block', async () => {
    const outDir = join(tmp, 'rv-out'), texpipeDir = join(tmp, 'rv-texpipe'), pbrDir = join(outDir, 'pbr')
    const key = 'tile2d:c_review_01'
    mkdirSync(join(outDir, 'world'), { recursive: true })
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#556b2f' } }).png().toFile(join(outDir, 'world', 'c_review_01.png'))
    await fakeMaster(texpipeDir, key, 128, 128)
    const e = { ...tile, key, size: [32, 32] as [number, number] }
    const r = await encodeSet(e, { texpipeDir, pbrDir })
    const index = mergeIndex(null, [r.set!], { rev: 'r', upscaler: 'u', createdAt: 'now' })
    writePbrIndex(pbrDir, index)
    const overrides: TexpipeOverrides = { format: 'sro-texpipe-overrides', version: 1, sets: { [key]: { status: 'ok', note: '</script><b>x' } } }
    const entry = { ...e, source: { file: 'world/c_review_01.png' }, format: null, alphaModes: [], users: 1, importance: 1, group: 'tile' } as InventoryEntry
    const { file, cards } = await buildReview([entry], { outDir, texpipeDir, pbrDir, index, overrides, title: 'unit' })
    const html = readFileSync(file, 'utf8')
    expect(cards).toHaveLength(1)
    const c = cards[0]!
    expect(c.status).toBe('ok')
    expect(c.indexStatus).toBe('auto')
    expect(c.problems.join(' ')).toMatch(/run pnpm texpipe encode/)
    for (const p of ['retail', 'albedo', 'normal', 'orm', 'height', 'lit'] as const) {
      expect(c.images[p]).toBeDefined()
      expect(existsSync(join(texpipeDir, 'review', c.images[p]!))).toBe(true)
    }
    expect(html).toContain(`data-key="${key}"`)
    expect(html).toContain('data-set-status="albedo-only"')
    expect(html).not.toContain('</script><b>')
    // the embedded data parses back
    const data = JSON.parse(html.split('<script type="application/json" id="data">')[1]!.split('</script>')[0]!)
    expect(data.cards[0]).toMatchObject({ key, status: 'ok', indexStatus: 'auto' })
  })

  it('the local server saves same-origin status edits only, for the batch keys only', async () => {
    const texpipeDir = join(tmp, 'srv')
    mkdirSync(join(texpipeDir, 'review'), { recursive: true })
    writeFileSync(join(texpipeDir, 'review', 'index.html'), '<!doctype html><title>t</title>')
    const overridesFile = join(tmp, 'srv-overrides.json')
    const { server, url } = await serveReview({ texpipeDir, overridesFile, keys: ['tile2d:c_a'], port: 0 })
    try {
      const origin = new URL(url).origin
      const post = (body: unknown, from = origin) => fetch(`${origin}/api/status`, { method: 'POST', headers: { 'content-type': 'application/json', origin: from }, body: JSON.stringify(body) })
      expect((await fetch(url)).status).toBe(200)
      expect((await post({ key: 'tile2d:c_a', status: 'ok' }, 'http://evil.example')).status).toBe(403)
      expect((await post({ key: 'tile2d:c_b', status: 'ok' })).status).toBe(400)
      expect((await post({ key: 'tile2d:c_a', status: 'replaced' })).status).toBe(400)
      expect(existsSync(overridesFile)).toBe(false)
      const ok = await post({ key: 'tile2d:c_a', status: 'albedo-only' })
      expect(ok.status).toBe(200)
      expect(JSON.parse(readFileSync(overridesFile, 'utf8')).sets).toEqual({ 'tile2d:c_a': { status: 'albedo-only' } })
      expect((await (await fetch(`${origin}/api/overrides`)).json()).sets['tile2d:c_a'].status).toBe('albedo-only')
      expect((await fetch(`${origin}/review/..%2f..%2fsrv-overrides.json`)).status).toBe(404)
      expect((await fetch(`${origin}/review/missing.png`)).status).toBe(404)
    } finally {
      server.close()
    }
  })
})

// ---- real data (skips without the TP-P masters / the written index) --------------------------------------------------

const WORK = join(REPO_ROOT, 'work')
const MASTER = join(WORK, 'texpipe', 'master')
const PBR = join(WORK, 'out', 'pbr')

describe('real test set', () => {
  it.skipIf(!existsSync(MASTER))('q90 normal planes: < 2° mean error at the 1024 tier, sources ≤ 64 px excluded', async () => {
    // resolve each test key's master folder by its pbr.json key (TEST_SET holds suffixes)
    const found: Array<{ dir: string; key: string; size: [number, number] }> = []
    const walk = (d: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        if (ent.isDirectory() && ent.name !== '_sheets') walk(join(d, ent.name))
        else if (ent.name === 'pbr.json') {
          const info = readMasterInfo(d)
          if (info && TEST_SET.some(s => info.key.endsWith(s)) && existsSync(join(d, 'normal.png'))) found.push({ dir: d, key: info.key, size: info.size })
        }
      }
    }
    walk(MASTER)
    if (!found.length) return
    const rows: string[] = []
    for (const f of found) {
      const info = readMasterInfo(f.dir) as { scale?: number; size: [number, number] }
      const scale = info.scale ?? 4
      const source = [Math.round(f.size[0] / scale), Math.round(f.size[1] / scale)]
      if (Math.min(...source) <= TINY_SOURCE) continue
      const n = normalsFromRgb(await readImage(join(f.dir, 'normal.png')))
      const long = Math.max(n.w, n.h)
      const t = Math.min(1024, long)
      const w = Math.max(1, Math.round((n.w * t) / long)), h = Math.max(1, Math.round((n.h * t) / long))
      const ref = normalsAt(n, w, h)
      const { nx, ny } = normalPlanes(ref)
      const [bx, by] = await Promise.all([webp({ w, h, c: 1, data: nx }, PLANE_WEBP), webp({ w, h, c: 1, data: ny }, PLANE_WEBP)])
      const [dx, dy] = await Promise.all([decodePlane(bx), decodePlane(by)])
      const e = normalError(ref, rebuildNormals(dx.data, dy.data, w, h))
      rows.push(`${f.key} ${w}x${h}: ${e.meanDeg}° p99 ${e.p99Deg}° |n|-1 ≤ ${e.maxLenErr}`)
      expect(e.meanDeg, f.key).toBeLessThan(2)
      expect(e.maxLenErr, f.key).toBeLessThanOrEqual(0.02)
    }
    console.log(rows.join('\n'))
    expect(rows.length).toBeGreaterThan(0)
  })

  it.skipIf(!existsSync(join(PBR, 'index.json')))('the written index validates and every file it names exists', () => {
    const index = readPbrIndex(PBR)
    expect(index).not.toBeNull()
    expect(validatePbrIndex(index)).toEqual([])
    expect(missingFiles(index!, PBR)).toEqual([])
    for (const s of Object.values(index!.sets)) {
      for (const [name, t] of Object.entries(s.tiers)) expect(Math.max(...t.size)).toBe(Number(name))
    }
  })
})
